/**
 * Core data model at run time (P0 package N, docs/dev/core-data-model.md): what the platform does around the system
 * tables, beyond the generic DataService.
 *
 *  - Write hooks (data.ts calls them inside the write's unit of work): the polymorphic regarding link is normalised and
 *    validated (the record must exist and be readable by the writer: an unreadable record answers like a missing one),
 *    rich text is sanitised, @mentions are extracted (only users who can read the record may be mentioned), task
 *    completion is stamped, a mention may only be marked read by its user; after the write, Mention rows are created
 *    and notification jobs queued (they run after commit and check access again when they send).
 *  - Polymorphic integrity: deleting rows (or a table) removes the collaboration rows about them in the same unit of
 *    work; documents, channels and messages about them are detached instead. A daily job sweeps orphans left by
 *    changes outside the API (a linked table's rows deleted in its own database).
 *  - Number sequences: NextNumber(name) inside the caller's transaction (gap-free: a rolled-back write gives its number
 *    back; concurrent writers queue on the sequence row).
 *  - Read APIs for the timeline component, "My tasks", mention candidates, follow and tags (collab routes).
 */
import { HttpError } from './contracts.ts'
import type { DataService, MetaStore, NotificationService, RawRow, SqlDb, UserContext } from './contracts.ts'
import type { TableDef, UserDef } from '../../src/platform/contracts.ts'
import type { Condition } from '../../src/platform/http.ts'
import {
  REGARDING, SYS, fyStartMonth, formatSequenceNumber, isSystemTableId, mentionedUserIds, richTextToPlain, sanitizeRichText, sequencePeriod,
} from '../../src/platform/system-tables.ts'
import { currentEnvironment } from './env-context.ts'
import { errText } from './util.ts'

const q = (id: string): string => `"${id.replace(/"/g, '""')}"`
const invalid = (m: string, field?: string) => new HttpError(422, 'invalid', m, field)

export const COLLAB_NOTIFY_JOB = 'collab.notify'
export const COLLAB_SWEEP_JOB = 'collab.orphan-sweep'

/** the regarding tables whose rows go with the record they are about */
const CASCADE = [SYS.activities, SYS.comments, SYS.mentions, SYS.follows, SYS.tagLinks, SYS.attachmentLinks]
/** the regarding tables whose rows stay (they lose the link) */
const DETACH = [SYS.documents, SYS.channels, SYS.messages, SYS.flowRuns]

export interface CollabDeps {
  db(): SqlDb | null
  meta(): MetaStore
  data(): DataService & { internals: { findRow(t: TableDef, id: string, guard?: Condition): Promise<RawRow | null>; physical(t: TableDef): TableDef } }
  forUser(user: UserDef): Promise<UserContext>
  notifications(): NotificationService | undefined
  enqueue(type: string, payload: unknown, opts?: { delayMs?: number }): Promise<void>
  log(level: 'info' | 'warn' | 'error', msg: string): void
}

/** write-path hooks the DataService calls (data.ts) */
export interface SystemDataHooks {
  /** system tables: normalise and validate a row before the permission check; returns the columns to set */
  beforeWrite(ctx: UserContext | null, def: TableDef, op: 'create' | 'update', next: RawRow, old: RawRow | null, changed: Set<string> | null): Promise<RawRow>
  afterWrite(ctx: UserContext | null, def: TableDef, op: 'create' | 'update', row: RawRow, old: RawRow | null): Promise<void>
  /** rows of any table were deleted: their collaboration rows go too */
  afterDelete(def: TableDef, ids: string[]): Promise<void>
  /** a column default `=NextNumber("name")` */
  nextNumber(name: string): Promise<string>
}

export type Collab = ReturnType<typeof createCollab>

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const blank = (v: unknown) => v === null || v === undefined || v === ''

export function createCollab(deps: CollabDeps) {
  const db = (): SqlDb => {
    const d = deps.db()
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }
  const S = (t: string): string => `${q(currentEnvironment().schema)}.${q(t)}`
  const tables = () => deps.meta().tables.list()

  /* ---------------------------------------------------------------- regarding */

  /** the table a regarding link names (id or name); system collaboration tables only as activities and documents */
  async function regardingTableOf(nameOrId: string): Promise<TableDef> {
    const all = await tables()
    const t = all.find((x) => x.id === nameOrId) ?? all.find((x) => x.name.toLowerCase() === nameOrId.toLowerCase())
    if (!t) throw invalid(`There is no table "${nameOrId.slice(0, 64)}".`, REGARDING.table)
    if (t.system && t.id !== SYS.activities && t.id !== SYS.documents) throw invalid(`Rows of "${t.displayName}" cannot have comments, activities or files.`, REGARDING.table)
    return t
  }

  /**
   * Finds the table of a row id among the default database's tables (row ids are UUIDs, unique across tables): one
   * statement with a primary-key probe per table. Linked tables of other connections must name their table.
   */
  async function findTableOfRow(id: string): Promise<TableDef | null> {
    const candidates = (await tables()).filter((t) => (t.connectionId ?? 'conn_default') === 'conn_default' && t.source && !(t.missingSystem ?? []).includes('id')
      && (!t.system || t.id === SYS.activities || t.id === SYS.documents) && t.systemKind !== 'projection')
    if (!candidates.length) return null
    const parts = candidates.map((t, i) => `(SELECT ${i}::int AS i FROM ${S(t.source!)} WHERE "id"::text = $1 LIMIT 1)`)
    for (let i = 0; i < parts.length; i += 200) {
      const r = await db().query<{ i: number }>(parts.slice(i, i + 200).join(' UNION ALL ') + ' LIMIT 1', [id])
      if (r.length) return candidates[Number(r[0].i)] ?? null
    }
    return null
  }

  /** the regarding record must exist and be readable by the writer (an unreadable one answers like a missing one) */
  async function checkRegarding(ctx: UserContext | null, next: RawRow, required: boolean): Promise<RawRow> {
    const out: RawRow = {}
    const rawId = str(next[REGARDING.id]).trim()
    const rawTable = str(next[REGARDING.table]).trim()
    if (!rawId) {
      if (required) throw invalid('Say which record this is about (regardingId).', REGARDING.id)
      out[REGARDING.table] = null
      out[REGARDING.id] = null
      return out
    }
    const id = rawId.length === 36 ? rawId.toLowerCase() : rawId
    let target = rawTable ? await regardingTableOf(rawTable) : await findTableOfRow(id)
    const missing = () => invalid(`There is no record with the id "${id.slice(0, 64)}" that you can see.`, REGARDING.id)
    if (!target) throw missing()
    target = deps.data().internals.physical(target)
    const guard = ctx ? ctx.rowPredicate(target, 'read') : undefined
    if (guard && 'const' in guard && !guard.const) throw missing()
    if (!(await deps.data().internals.findRow(target, id, guard && !('const' in guard) ? guard : undefined))) throw missing()
    out[REGARDING.table] = target.id
    out[REGARDING.id] = id
    return out
  }

  /** users (of `ids`) who can read a record: their own security context decides */
  async function readersOf(table: TableDef, rowId: string, ids: string[]): Promise<{ ok: UserDef[]; refused: UserDef[] }> {
    const ok: UserDef[] = []
    const refused: UserDef[] = []
    const t = deps.data().internals.physical(table)
    for (const id of [...new Set(ids)].slice(0, 200)) {
      const u = await deps.meta().users.get(id)
      if (!u || u.status === 'disabled') continue
      let can = false
      try {
        const ctx = await deps.forUser(u)
        const pred = ctx.rowPredicate(t, 'read')
        can = !('const' in pred && !pred.const) && !!(await deps.data().internals.findRow(t, rowId, 'const' in pred ? undefined : pred))
      } catch {
        can = false // no access to this environment
      }
      ;(can ? ok : refused).push(u)
    }
    return { ok, refused }
  }

  /* ---------------------------------------------------------------- write hooks */

  const hooks: SystemDataHooks = {
    async beforeWrite(ctx, def, op, next, old, changed) {
      if (!def.system) return {}
      const set: RawRow = {}
      const me = ctx?.user.id ?? null
      const has = (c: string) => op === 'create' || !!changed?.has(c)
      if (def.regarding) {
        if (op === 'create') Object.assign(set, await checkRegarding(ctx, next, def.id !== SYS.activities && def.id !== SYS.documents && def.id !== SYS.channels && def.id !== SYS.messages && def.id !== SYS.flowRuns))
        else if (ctx && (changed?.has(REGARDING.id) || changed?.has(REGARDING.table))) {
          const same = str(next[REGARDING.id]).toLowerCase() === str(old?.[REGARDING.id]).toLowerCase() && str(next[REGARDING.table]) === str(old?.[REGARDING.table])
          if (!same) throw invalid('The record a row is about cannot be changed; add a new one instead.', REGARDING.id)
        }
      }
      switch (def.id) {
        case SYS.comments: {
          if (op === 'update' && ctx && !ctx.privileges.isAdmin && str(old?.createdBy) !== me) throw new HttpError(403, 'denied', 'Only the author can change a comment.')
          if (has('Body')) {
            const body = sanitizeRichText(str(next.Body))
            if (!richTextToPlain(body).trim() && !/data-mention=/.test(body)) throw invalid('A comment cannot be empty.', 'Body')
            set.Body = body
            const regTable = str(set[REGARDING.table] ?? next[REGARDING.table])
            const regId = str(set[REGARDING.id] ?? next[REGARDING.id])
            const ids = mentionedUserIds(body)
            if (ids.length && regTable && regId) {
              const t = await regardingTableOf(regTable)
              const { refused } = await readersOf(t, regId, ids)
              if (refused.length) throw invalid(`${refused.map((u) => u.name).join(', ')} cannot see this record, so ${refused.length === 1 ? 'they' : 'they'} cannot be mentioned here.`, 'Body')
            }
            set.MentionIds = ids.length ? JSON.stringify(ids) : null
            if (op === 'update') set.EditedOn = new Date()
          }
          break
        }
        case SYS.activities: {
          if (has('Description') && !blank(next.Description)) set.Description = sanitizeRichText(str(next.Description))
          if (op === 'create' && blank(next.Type)) set.Type = 'Task'
          if (op === 'create' && blank(next.Status)) set.Status = 'Open'
          if (has('Status')) {
            const done = str(next.Status) === 'Done'
            const wasDone = str(old?.Status) === 'Done'
            if (done && !wasDone) {
              set.CompletedOn = new Date()
              set.CompletedBy = me
            } else if (!done && wasDone) {
              set.CompletedOn = null
              set.CompletedBy = null
            }
          }
          break
        }
        case SYS.mentions: {
          if (op === 'update' && ctx) {
            const other = [...(changed ?? [])].filter((c) => c !== 'IsRead' && c !== 'ReadOn' && c !== 'modifiedOn')
            if (other.length) throw new HttpError(403, 'denied', 'Only "Read" can be changed on a mention.')
          }
          if (has('IsRead')) set.ReadOn = next.IsRead === true ? new Date() : null
          break
        }
        case SYS.tags:
          if (has('Name')) set.Name = str(next.Name).trim().slice(0, 100)
          break
        case SYS.documents:
          if (has('FolderPath')) set.FolderPath = normaliseFolder(str(next.FolderPath))
          break
        case SYS.sequences:
          if (has('Name')) set.Name = str(next.Name).trim()
          break
      }
      return set
    },

    async afterWrite(ctx, def, op, row, old) {
      if (!def.system) return
      if (def.id === SYS.comments) {
        const now = mentionList(row.MentionIds)
        const before = op === 'update' ? new Set(mentionList(old?.MentionIds)) : new Set<string>()
        const added = now.filter((u) => !before.has(u))
        const mentions = (await tables()).find((t) => t.id === SYS.mentions)
        if (mentions) {
          for (const userId of added) {
            await deps.data().insert(null, mentions, {
              MentionedUser: userId, Comment: String(row.id), [REGARDING.table]: str(row[REGARDING.table]), [REGARDING.id]: str(row[REGARDING.id]),
              IsRead: false, createdBy: String(row.createdBy ?? ctx?.user.id ?? ''), owner: userId,
            })
          }
        }
        if (added.length) await deps.enqueue(COLLAB_NOTIFY_JOB, { kind: 'mention', id: String(row.id), userIds: added })
        if (op === 'create') await deps.enqueue(COLLAB_NOTIFY_JOB, { kind: 'comment', id: String(row.id), exclude: [...added, str(row.createdBy)] })
      }
      if (def.id === SYS.activities) {
        const to = str(row.AssignedTo)
        if (to && to !== str(old?.AssignedTo) && to !== ctx?.user.id) await deps.enqueue(COLLAB_NOTIFY_JOB, { kind: 'assigned', id: String(row.id), userIds: [to] })
      }
    },

    async afterDelete(def, ids) {
      if (!ids.length || !deps.db()) return
      await cascade(def.id, ids)
    },

    nextNumber: (name) => nextNumber(name),
  }

  function mentionList(v: unknown): string[] {
    if (blank(v)) return []
    try {
      const a = JSON.parse(String(v))
      return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }

  /** collaboration rows about deleted rows (and, one level deeper, about the activities removed with them) */
  async function cascade(tableId: string | null, ids: string[] | null, depth = 0): Promise<number> {
    const all = await tables()
    const present = new Set(all.map((t) => t.id))
    let n = 0
    const lower = ids?.map((x) => (x.length === 36 ? x.toLowerCase() : x)) ?? null
    const where = (alias = '') => `${alias}${q(REGARDING.table)} = $1${lower ? ` AND ${alias}${q(REGARDING.id)} = ANY($2::text[])` : ''}`
    const params = lower ? [tableId, lower] : [tableId]
    // deleted comments take their mentions with them
    if (tableId === SYS.comments && lower && present.has(SYS.mentions)) n += (await db().exec(`DELETE FROM ${S(SYS.mentions)} WHERE "Comment" = ANY($1::text[])`, [lower])).affectedRows
    const removedActivities: string[] = []
    for (const t of CASCADE) {
      if (!present.has(t)) continue
      if (t === SYS.activities) {
        const r = await db().query<{ id: string }>(`DELETE FROM ${S(t)} WHERE ${where()} RETURNING "id"`, params)
        removedActivities.push(...r.map((x) => x.id))
        n += r.length
      } else n += (await db().exec(`DELETE FROM ${S(t)} WHERE ${where()}`, params)).affectedRows
    }
    for (const t of DETACH) {
      if (!present.has(t)) continue
      n += (await db().exec(`UPDATE ${S(t)} SET ${q(REGARDING.table)} = NULL, ${q(REGARDING.id)} = NULL WHERE ${where()}`, params)).affectedRows
    }
    if (removedActivities.length && depth < 1) n += await cascade(SYS.activities, removedActivities, depth + 1)
    return n
  }

  /** a table was deleted: every collaboration row about it */
  async function tableRemoved(tableId: string): Promise<number> {
    if (!deps.db()) return 0
    return cascade(tableId, null)
  }

  /** rows about records that no longer exist (deleted outside the API) or about tables that are gone */
  async function sweepOrphans(): Promise<{ removed: number }> {
    const all = await tables()
    const byId = new Map(all.map((t) => [t.id, t]))
    let removed = 0
    for (const t of [...CASCADE, ...DETACH]) {
      if (!byId.has(t)) continue
      const kinds = await db().query<{ t: string }>(`SELECT DISTINCT ${q(REGARDING.table)} AS t FROM ${S(t)} WHERE ${q(REGARDING.table)} IS NOT NULL`)
      for (const { t: tid } of kinds) {
        const target = byId.get(tid)
        const detach = DETACH.includes(t as typeof DETACH[number])
        const act = (cond: string) => (detach
          ? `UPDATE ${S(t)} SET ${q(REGARDING.table)} = NULL, ${q(REGARDING.id)} = NULL WHERE ${q(REGARDING.table)} = $1 AND ${cond}`
          : `DELETE FROM ${S(t)} WHERE ${q(REGARDING.table)} = $1 AND ${cond}`)
        if (!target) {
          removed += (await db().exec(act('TRUE'), [tid])).affectedRows
          continue
        }
        if ((target.connectionId ?? 'conn_default') !== 'conn_default' || !target.source || target.systemKind === 'projection') continue
        removed += (await db().exec(act(`NOT EXISTS (SELECT 1 FROM ${S(target.source)} r WHERE r."id" = ${S(t)}.${q(REGARDING.id)})`), [tid])).affectedRows
      }
    }
    if (byId.has(SYS.attachmentLinks)) {
      removed += (await db().exec(`DELETE FROM ${S(SYS.attachmentLinks)} l WHERE NOT EXISTS (SELECT 1 FROM ${S('ab_attachments')} a WHERE a.id = l."Attachment")`)).affectedRows
    }
    if (byId.has(SYS.mentions) && byId.has(SYS.comments)) {
      removed += (await db().exec(`DELETE FROM ${S(SYS.mentions)} m WHERE m."Comment" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${S(SYS.comments)} c WHERE c."id" = m."Comment")`)).affectedRows
    }
    return { removed }
  }

  /* ---------------------------------------------------------------- attachment links */

  /** keeps Attachment links in step with the attachment store (attachments.ts calls these) */
  async function attachmentAdded(a: { id: string; tableId: string; column: string; rowId: string; fileName: string; mime: string; sizeBytes: number; sha256?: string; createdBy?: string | null }): Promise<void> {
    if (!deps.db() || isSystemTableId(a.tableId) && a.tableId !== SYS.activities && a.tableId !== SYS.documents) return
    const all = await tables()
    if (a.tableId === SYS.documents && a.column === 'File' && all.some((t) => t.id === SYS.documentVersions)) {
      // a document's file: a new version row, and the library entry shows the current one
      const v = await db().query<{ n: number }>(`SELECT COALESCE(max("VersionNumber"), 0)::int + 1 AS n FROM ${S(SYS.documentVersions)} WHERE "Document" = $1`, [a.rowId])
      const n = Number(v[0]?.n ?? 1)
      const verId = await db().query<{ id: string }>(
        `INSERT INTO ${S(SYS.documentVersions)} ("id", "createdOn", "modifiedOn", "createdBy", "owner", "Document", "VersionNumber", "Attachment", "FileName", "Mime", "SizeBytes", "Sha256")
         VALUES (gen_random_uuid()::text, now(), now(), $1, $1, $2, $3, $4, $5, $6, $7, $8) RETURNING "id"`,
        [a.createdBy ?? null, a.rowId, n, a.id, a.fileName.slice(0, 255), a.mime.slice(0, 255), a.sizeBytes, a.sha256 ?? null],
      )
      await db().exec(`UPDATE ${S(SYS.documents)} SET "CurrentVersion" = $1, "VersionNumber" = $2, "SizeBytes" = $3, "DocType" = $4, "modifiedOn" = now() WHERE "id" = $5`,
        [verId[0]?.id ?? null, n, a.sizeBytes, a.mime.slice(0, 255), a.rowId])
    }
    if (!all.some((t) => t.id === SYS.attachmentLinks)) return
    await db().exec(
      `INSERT INTO ${S(SYS.attachmentLinks)} ("id", "createdOn", "modifiedOn", "createdBy", "owner", "Attachment", "ColumnName", "FileName", "Mime", "SizeBytes", "regardingTable", "regardingId")
       VALUES (gen_random_uuid()::text, now(), now(), $1, $1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
      [a.createdBy ?? null, a.id, a.column, a.fileName.slice(0, 255), a.mime.slice(0, 255), a.sizeBytes, a.tableId, a.rowId.length === 36 ? a.rowId.toLowerCase() : a.rowId],
    )
  }
  async function attachmentsRemoved(ids: string[]): Promise<void> {
    if (!deps.db() || !ids.length || !(await tables()).some((t) => t.id === SYS.attachmentLinks)) return
    await db().exec(`DELETE FROM ${S(SYS.attachmentLinks)} WHERE "Attachment" = ANY($1::text[])`, [ids])
  }

  /* ---------------------------------------------------------------- number sequences */

  /** local calendar date in the environment's time zone (Settings.TimeZone, default Asia/Kolkata) */
  function zonedNow(tz: string): Date {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date())
      const g = (t: string) => Number(parts.find((p) => p.type === t)?.value)
      return new Date(g('year'), g('month') - 1, g('day'))
    } catch {
      return new Date()
    }
  }

  async function settingValue(key: string): Promise<string | null> {
    if (!(await tables()).some((t) => t.id === SYS.settings)) return null
    const r = await db().query<{ v: string | null }>(`SELECT "Value" AS v FROM ${S(SYS.settings)} WHERE lower("Key") = lower($1) LIMIT 1`, [key])
    return r[0]?.v ?? null
  }

  /**
   * The next number of a sequence, inside the caller's transaction: the sequence row is locked (FOR UPDATE) until the
   * write commits, so concurrent writers queue and a rolled-back write gives its number back (no gaps, no duplicates).
   */
  async function nextNumber(name: string): Promise<string> {
    const n = String(name ?? '').trim()
    if (!n) throw invalid('NextNumber needs the name of a number sequence.')
    if (!(await tables()).some((t) => t.id === SYS.sequences)) throw invalid('Number sequences are not available in this environment.')
    const run = async (d: SqlDb) => {
      const rows = await d.query<Record<string, unknown>>(`SELECT "id", "Prefix", "Suffix", "Padding", "NextValue", "ResetRule", "CurrentPeriod" FROM ${S(SYS.sequences)} WHERE lower("Name") = lower($1) ORDER BY "createdOn", "id" LIMIT 1 FOR UPDATE`, [n])
      if (!rows.length) throw invalid(`There is no number sequence "${n.slice(0, 80)}". Add it in Number sequences.`)
      const r = rows[0]
      const fy = fyStartMonth(await settingValue('FinancialYearStartMonth'))
      const now = zonedNow((await settingValue('TimeZone')) || 'Asia/Kolkata')
      const rule = str(r.ResetRule) || 'never'
      const period = sequencePeriod(rule, now, fy)
      const current = Math.max(1, Math.trunc(Number(r.NextValue ?? 1)) || 1)
      const value = rule !== 'never' && str(r.CurrentPeriod) !== period ? 1 : current
      await d.exec(`UPDATE ${S(SYS.sequences)} SET "NextValue" = $1, "CurrentPeriod" = $2, "modifiedOn" = now() WHERE "id" = $3`, [value + 1, period || null, r.id])
      return formatSequenceNumber({ Prefix: str(r.Prefix), Suffix: str(r.Suffix), Padding: r.Padding === null ? 4 : Number(r.Padding) }, value, now, fy)
    }
    // joins the ambient transaction (unit of work) when there is one; otherwise its own
    return db().tx((d) => run(d))
  }

  /* ---------------------------------------------------------------- notifications (job) */

  async function notify(p: { kind: string; id: string; userIds?: string[]; exclude?: string[] }): Promise<{ sent: number; skipped: number }> {
    const svc = deps.notifications()
    if (!svc) return { sent: 0, skipped: 0 }
    const all = await tables()
    const isComment = p.kind === 'mention' || p.kind === 'comment'
    const src = all.find((t) => t.id === (isComment ? SYS.comments : SYS.activities))
    if (!src) return { sent: 0, skipped: 0 }
    const row = await deps.data().internals.findRow(src, p.id)
    if (!row) return { sent: 0, skipped: 0 }
    const author = str(row.createdBy)
    const authorUser = author ? await deps.meta().users.get(author) : null
    let recipients = p.userIds ?? []
    const regTable = str(row[REGARDING.table])
    const regId = str(row[REGARDING.id])
    const target = regTable ? all.find((t) => t.id === regTable) : undefined
    if (p.kind === 'comment') {
      // followers of the record (not the author, not those already notified as mentioned)
      if (!regId || !all.some((t) => t.id === SYS.follows)) return { sent: 0, skipped: 0 }
      const f = await db().query<{ o: string }>(`SELECT DISTINCT "owner" AS o FROM ${S(SYS.follows)} WHERE "regardingId" = $1 AND "owner" IS NOT NULL`, [regId])
      const skip = new Set(p.exclude ?? [])
      recipients = f.map((x) => x.o).filter((u) => !skip.has(u))
    }
    if (!recipients.length) return { sent: 0, skipped: 0 }
    // access is checked again now: someone who lost access to the record in the meantime gets nothing (not even the title)
    const { ok, refused } = target && regId ? await readersOf(target, regId, recipients) : { ok: await usersOf(recipients), refused: [] }
    const label = target && regId ? await recordLabel(target, regId) : ''
    const where = target ? `${target.displayName}${label ? ` "${label}"` : ''}` : ''
    const text = richTextToPlain(str(isComment ? row.Body : row.Subject))
    const link = linkOf(str(row.Link))
    let sent = 0
    for (const u of ok) {
      if (u.id === author && p.kind !== 'assigned') continue
      const who = authorUser?.name ?? 'Someone'
      const title = p.kind === 'mention' ? `${who} mentioned you${where ? ` on ${where}` : ''}`
        : p.kind === 'comment' ? `${who} commented on ${where || 'a record you follow'}`
          : `${who} assigned you a task: ${text.slice(0, 120)}`
      await svc.notify({ userIds: [u.id] }, {
        kind: p.kind === 'assigned' ? 'task' : 'mention', title: title.slice(0, 200), body: isComment ? text.slice(0, 500) : undefined,
        link: link ?? (p.kind === 'assigned' ? '#u-tasks' : '#u-mentions'), environmentId: currentEnvironment().id,
        source: author ? `user:${author}` : 'system', ...(authorUser ? { from: { id: authorUser.id, name: authorUser.name } } : {}),
      })
      sent++
    }
    return { sent, skipped: refused.length }
  }

  async function usersOf(ids: string[]): Promise<UserDef[]> {
    const out: UserDef[] = []
    for (const id of ids) {
      const u = await deps.meta().users.get(id)
      if (u && u.status !== 'disabled') out.push(u)
    }
    return out
  }

  /** an in-app link from a comment's Link column, or null */
  function linkOf(v: string): string | null {
    return /^#[A-Za-z0-9/_\-.~?=&%:+,]{1,500}$/.test(v) ? v : null
  }

  /** the display text of a record (its primary column), read as the system */
  async function recordLabel(t: TableDef, id: string): Promise<string> {
    try {
      const r = await deps.data().internals.findRow(t, id)
      const v = r ? r[t.primaryColumn] : null
      return v === null || v === undefined ? '' : String(v).slice(0, 80)
    } catch {
      return ''
    }
  }

  /** display text of regarding records the user can read (others stay blank: their existence is not revealed) */
  async function regardingLabels(ctx: UserContext, pairs: { table: string; id: string }[]): Promise<Map<string, { table: string; tableName: string; label: string }>> {
    const out = new Map<string, { table: string; tableName: string; label: string }>()
    const all = await tables()
    const byTable = new Map<string, Set<string>>()
    for (const p of pairs) if (p.table && p.id) (byTable.get(p.table) ?? byTable.set(p.table, new Set()).get(p.table)!).add(p.id)
    for (const [tid, ids] of byTable) {
      const t = all.find((x) => x.id === tid)
      if (!t) continue
      const pred = ctx.rowPredicate(t, 'read')
      if ('const' in pred && !pred.const) continue
      const col = ctx.columnAccess(t, t.primaryColumn) === 'none' ? 'id' : t.primaryColumn
      const res = await deps.data().query(ctx, t, { where: { col: 'id', op: 'in', value: [...ids].slice(0, 500) }, select: [col], top: 500 })
      for (const r of res.rows) out.set(`${tid}:${String(r.id)}`, { table: t.id, tableName: t.displayName, label: String(r[col] ?? r.id ?? '') })
    }
    return out
  }

  /* ---------------------------------------------------------------- read APIs */

  /**
   * The timeline of one record: activities, comments, files and the record's own changes (from the audit log) in one
   * feed, newest first, paged by (time, id). The caller must be able to read the record (else 404, like a missing one);
   * then every collaboration row about it is visible to them by the regarding rule, so the rows are read directly by
   * the timeline index. Audit details are reduced to the column names the caller may see.
   */
  async function timeline(ctx: UserContext, tableRef: string, rowIdIn: string, o: { cursor?: string | null; limit?: number } = {}) {
    const rowId = rowIdIn.length === 36 ? rowIdIn.toLowerCase() : rowIdIn
    const all = await tables()
    const table = all.find((t) => t.id === tableRef) ?? all.find((t) => t.name.toLowerCase() === tableRef.toLowerCase())
    const notFound = () => new HttpError(404, 'not-found', 'Record not found.')
    if (!table) throw notFound()
    const t = deps.data().internals.physical(table)
    const pred = ctx.rowPredicate(t, 'read')
    if ('const' in pred && !pred.const) throw notFound()
    const rec = await deps.data().internals.findRow(t, rowId, 'const' in pred ? undefined : pred)
    if (!rec) throw notFound()
    const limit = Math.max(1, Math.min(100, Math.trunc(Number(o.limit ?? 30)) || 30))
    let before: { at: string; id: string } | null = null
    if (o.cursor) {
      try {
        const c = JSON.parse(Buffer.from(o.cursor, 'base64url').toString('utf8')) as { at: string; id: string }
        if (typeof c.at === 'string' && typeof c.id === 'string') before = c
      } catch {
        throw invalid('The cursor is not valid.')
      }
    }
    const has = (id: string) => all.some((x) => x.id === id)
    const seek = before ? ` AND ("createdOn", "id") < ($2::timestamptz, $3::text)` : ''
    const params: unknown[] = before ? [rowId, before.at, before.id] : [rowId]
    type Item = { kind: 'comment' | 'activity' | 'file' | 'event'; id: string; at: string; by: string | null; data: Record<string, unknown> }
    const items: Item[] = []
    const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString())
    const take = `ORDER BY "createdOn" DESC, "id" DESC LIMIT ${limit + 1}`
    if (has(SYS.comments)) {
      for (const r of await db().query<Record<string, unknown>>(`SELECT * FROM ${S(SYS.comments)} WHERE "regardingId" = $1${seek} ${take}`, params)) {
        items.push({ kind: 'comment', id: String(r.id), at: iso(r.createdOn), by: (r.createdBy as string) ?? null, data: { Body: r.Body, ParentComment: r.ParentComment, EditedOn: r.EditedOn ? iso(r.EditedOn) : null, MentionIds: mentionList(r.MentionIds), canEdit: r.createdBy === ctx.user.id || ctx.privileges.isAdmin } })
      }
    }
    if (has(SYS.activities)) {
      for (const r of await db().query<Record<string, unknown>>(`SELECT * FROM ${S(SYS.activities)} WHERE "regardingId" = $1${seek} ${take}`, params)) {
        items.push({ kind: 'activity', id: String(r.id), at: iso(r.createdOn), by: (r.createdBy as string) ?? null, data: {
          Type: r.Type, Subject: r.Subject, Status: r.Status, Priority: r.Priority, DueOn: r.DueOn ? iso(r.DueOn) : null, AssignedTo: r.AssignedTo, AssignedTeam: r.AssignedTeam,
          CompletedOn: r.CompletedOn ? iso(r.CompletedOn) : null, Description: r.Description,
        } })
      }
    }
    if (has(SYS.attachmentLinks)) {
      for (const r of await db().query<Record<string, unknown>>(`SELECT * FROM ${S(SYS.attachmentLinks)} WHERE "regardingId" = $1${seek} ${take}`, params)) {
        if (ctx.columnAccess(t, String(r.ColumnName)) === 'none') continue
        items.push({ kind: 'file', id: String(r.id), at: iso(r.createdOn), by: (r.createdBy as string) ?? null, data: { Attachment: r.Attachment, FileName: r.FileName, Mime: r.Mime, SizeBytes: Number(r.SizeBytes ?? 0), ColumnName: r.ColumnName } })
      }
    }
    if (has(SYS.documents)) {
      for (const r of await db().query<Record<string, unknown>>(`SELECT * FROM ${S(SYS.documents)} WHERE "regardingId" = $1${seek} ${take}`, params)) {
        items.push({ kind: 'file', id: String(r.id), at: iso(r.createdOn), by: (r.createdBy as string) ?? null, data: { Document: r.id, Attachment: r.File, FileName: r.Name, Mime: r.DocType, SizeBytes: Number(r.SizeBytes ?? 0), Version: r.VersionNumber, FolderPath: r.FolderPath } })
      }
    }
    // the record's own history: created (from the row), changed (audit entries; visible column names only)
    const auditSeek = before ? ` AND (at, id::text) < ($4::timestamptz, $5::text)` : ''
    const auditParams: unknown[] = before ? [t.id, rowId, limit + 1, before.at, before.id] : [t.id, rowId, limit + 1]
    for (const r of await db().query<Record<string, unknown>>(
      `SELECT id::text AS id, at, user_id, action, details FROM ${S('ab_audit')} WHERE table_id = $1 AND row_id = $2 AND action IN ('row.insert', 'row.update')${auditSeek} ORDER BY at DESC, id DESC LIMIT $3`, auditParams)) {
      const det = (r.details ?? {}) as { columns?: string[] }
      const cols = (det.columns ?? []).filter((c) => ctx.columnAccess(t, c) !== 'none')
      if (r.action === 'row.update' && !cols.length) continue
      items.push({ kind: 'event', id: `a${String(r.id)}`, at: iso(r.at), by: (r.user_id as string) ?? null, data: { action: r.action === 'row.insert' ? 'created' : 'changed', columns: cols.map((c) => t.columns.find((x) => x.name === c)?.displayName ?? c) } })
    }
    items.sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1))
    const page = items.slice(0, limit)
    const more = items.length > limit
    const last = page[page.length - 1]
    // who: names of the people involved (the directory rule lets every user see names)
    const people = new Map<string, string>()
    for (const id of new Set(page.flatMap((i) => [i.by, i.data.AssignedTo as string | null].filter((x): x is string => !!x)))) {
      const u = await deps.meta().users.get(id)
      if (u) people.set(id, u.name)
    }
    const follows = has(SYS.follows) ? await db().query<{ n: number; mine: boolean }>(`SELECT count(*)::int AS n, bool_or("owner" = $2) AS mine FROM ${S(SYS.follows)} WHERE "regardingId" = $1`, [rowId, ctx.user.id]) : []
    const tags = has(SYS.tagLinks) && has(SYS.tags)
      ? await db().query<{ id: string; name: string; color: string | null }>(`SELECT t."id" AS id, t."Name" AS name, t."Color" AS color FROM ${S(SYS.tagLinks)} l JOIN ${S(SYS.tags)} t ON t."id" = l."Tag" WHERE l."regardingId" = $1 ORDER BY lower(t."Name")`, [rowId])
      : []
    return {
      table: t.id, row: rowId, title: String(rec[t.primaryColumn] ?? ''),
      items: page.map((i) => ({ ...i, byName: i.by ? people.get(i.by) ?? null : null, ...(i.kind === 'activity' && i.data.AssignedTo ? { assignedName: people.get(String(i.data.AssignedTo)) ?? null } : {}) })),
      nextCursor: more && last ? Buffer.from(JSON.stringify({ at: last.at, id: last.id.startsWith('a') ? last.id.slice(1) : last.id })).toString('base64url') : null,
      following: !!follows[0]?.mine, followers: Number(follows[0]?.n ?? 0),
      tags,
      canComment: ctx.canCreate(all.find((x) => x.id === SYS.comments) ?? t),
    }
  }

  /** users who may be @mentioned on a record: active, in this environment, and able to read it */
  async function mentionable(ctx: UserContext, tableRef: string, rowId: string, text: string): Promise<{ id: string; name: string; email: string }[]> {
    const all = await tables()
    const table = all.find((t) => t.id === tableRef) ?? all.find((t) => t.name.toLowerCase() === tableRef.toLowerCase())
    if (!table) throw new HttpError(404, 'not-found', 'Record not found.')
    const t = deps.data().internals.physical(table)
    const pred = ctx.rowPredicate(t, 'read')
    if (('const' in pred && !pred.const) || !(await deps.data().internals.findRow(t, rowId, 'const' in pred ? undefined : pred))) throw new HttpError(404, 'not-found', 'Record not found.')
    const users = all.find((x) => x.id === SYS.users)
    if (!users) return []
    const needle = text.trim().toLowerCase()
    const where: Condition = needle ? { or: [{ col: 'FullName', op: 'contains', value: needle }, { col: 'Email', op: 'startsWith', value: needle }] } : { const: true }
    const res = await deps.data().query(ctx, users, { where, top: 40, orderBy: [{ col: 'FullName', dir: 'asc' }], select: ['FullName', 'Email'] })
    const ids = res.rows.map((r) => String(r.id))
    const { ok } = await readersOf(t, rowId, ids)
    const okIds = new Set(ok.map((u) => u.id))
    return res.rows.filter((r) => okIds.has(String(r.id))).slice(0, 20).map((r) => ({ id: String(r.id), name: String(r.FullName ?? ''), email: String(r.Email ?? '') }))
  }

  return {
    hooks, nextNumber, timeline, mentionable, regardingLabels, tableRemoved, sweepOrphans, notify, cascade, attachmentAdded, attachmentsRemoved,
    checkRegarding, findTableOfRow, readersOf, settingValue,
    log: (m: string, e: unknown) => deps.log('warn', `${m}: ${errText(e)}`),
  }
}

function normaliseFolder(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').map((x) => x.trim()).filter((x) => x && x !== '.' && x !== '..')
  return '/' + parts.join('/')
}

/** the collaboration job types: notifications after commit, the daily orphan sweep */
export function registerCollabJobs(kernel: { jobs: { register<P>(def: import('./jobs.ts').JobTypeDef<P>): void } }, collab: Collab): void {
  kernel.jobs.register<{ kind: string; id: string; userIds?: string[]; exclude?: string[] }>({
    type: COLLAB_NOTIFY_JOB,
    description: 'Sends the notifications of a comment, a mention or a task assignment (after checking the recipients may read the record).',
    concurrency: 2,
    maxAttempts: 5,
    parse: (raw) => {
      const o = (raw ?? {}) as Record<string, unknown>
      if (typeof o.kind !== 'string' || typeof o.id !== 'string') throw new Error('kind and id are needed')
      return { kind: o.kind, id: o.id, userIds: Array.isArray(o.userIds) ? o.userIds.map(String) : undefined, exclude: Array.isArray(o.exclude) ? o.exclude.map(String) : undefined }
    },
    handler: (p) => collab.notify(p),
  })
  kernel.jobs.register<Record<string, never>>({
    type: COLLAB_SWEEP_JOB,
    description: 'Removes comments, activities, tags and other collaboration rows about records that no longer exist.',
    concurrency: 1,
    timeoutMs: 60 * 60_000,
    parse: () => ({}),
    handler: () => collab.sweepOrphans(),
  })
}
