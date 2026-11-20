/**
 * Notes at run time (P3 package N, docs/dev/notes.md, spec 5.10). A note is an Activity of Type `Note`; who may read or
 * change it is the Activities rule of the security engine (owner, readers of the record it is about, people and teams it
 * is shared with through ActivityShares; edit shares may change it). This service adds, never replacing that rule:
 *
 *  - the NOTE_TAGS sanitiser of every Body (src/notes/sanitize.ts, installed through tasks.setNoteSanitizer);
 *  - mentions: after a note is written (inside the same unit of work) the people newly mentioned in its Body must be able
 *    to read it, else the write is refused (422, as for comments and chat); each gets a Mentions row about the note and,
 *    after commit, a notification (job `notes.notify`, which checks access again when it runs);
 *  - the routes of the Notes page (routes.ts): the list (summaries only, never bodies), one note with what the reader may
 *    do, record cards resolved per reader, pins, and "who of these can read it" for the share offer of a mention.
 */
import { HttpError } from '../contracts.ts'
import type { RawRow, UserContext } from '../contracts.ts'
import type { TableDef } from '../../../src/platform/contracts.ts'
import type { CoreServices } from '../services.ts'
import { currentEnvironment } from '../env-context.ts'
import { lastWriterOf } from '../live/changes.ts'
import { errText, log } from '../util.ts'
import { REGARDING, SYS } from '../../../src/platform/system-tables.ts'
import { noteToPlain, sanitizeNoteHtml } from '../../../src/notes/sanitize.ts'
import { addedMentions, snippet } from '../../../src/notes/logic.ts'

export const NOTES_NOTIFY_JOB = 'notes.notify'
/** how many people one save may newly mention */
export const MAX_NEW_MENTIONS = 50

const q = (id: string): string => `"${id.replace(/"/g, '""')}"`
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

export type Notes = ReturnType<typeof createNotes>

export function createNotes(s: CoreServices) {
  const S = (t: string): string => `${q(currentEnvironment().schema)}.${q(t)}`
  const db = () => {
    const d = s.state.db
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }
  const table = async (id: string): Promise<TableDef> => {
    const t = await s.meta.tables.get(id)
    if (!t) throw new HttpError(404, 'not-found', 'Notes are not available in this environment.')
    return t
  }

  /* ---------------------------------------------------------------- write hook (inside the write's unit of work) */

  async function afterWrite(op: 'create' | 'update', row: RawRow, old: RawRow | null): Promise<void> {
    const added = addedMentions(op === 'update' ? str(old?.Body) : '', str(row.Body)).slice(0, MAX_NEW_MENTIONS + 1)
    if (!added.length) return
    if (added.length > MAX_NEW_MENTIONS) throw new HttpError(422, 'invalid', `At most ${MAX_NEW_MENTIONS} people can be mentioned at once.`, 'Body')
    const acts = await table(SYS.activities)
    const id = str(row.id)
    // the row as written is visible here (the check joins the write's transaction)
    const { ok, refused } = await s.collab.readersOf(acts, id, added)
    if (refused.length) {
      const names = refused.map((u) => u.name).join(', ')
      throw new HttpError(422, 'invalid', `${names} cannot open this note, so they cannot be mentioned. Share the note with them first.`, 'Body')
    }
    const mentions = (await s.meta.tables.list()).find((t) => t.id === SYS.mentions)
    if (mentions) {
      for (const u of ok) {
        await s.data.insert(null, mentions, {
          MentionedUser: u.id, [REGARDING.table]: SYS.activities, [REGARDING.id]: id, IsRead: false, createdBy: str(row.createdBy) || null, owner: u.id,
        })
      }
    }
    if (ok.length) await s.kernel.jobs.enqueue(NOTES_NOTIFY_JOB, { id, userIds: ok.map((u) => u.id) }, { priority: 1 })
  }

  /** after commit: tell the people mentioned (access checked again: a share removed meanwhile means no notification) */
  async function notify(p: { id: string; userIds: string[] }): Promise<{ sent: number }> {
    const svc = s.notifications
    if (!svc) return { sent: 0 }
    const acts = await table(SYS.activities)
    const row = await s.data.internals.findRow(acts, p.id)
    if (!row || str(row.Type) !== 'Note') return { sent: 0 }
    const { ok } = await s.collab.readersOf(acts, p.id, p.userIds)
    const by = lastWriterOf(currentEnvironment().id, SYS.activities, p.id) ?? (str(row.createdBy) ? { id: str(row.createdBy), name: (await s.meta.users.get(str(row.createdBy)))?.name ?? 'Someone' } : null)
    const title = str(row.Subject) || 'Untitled note'
    const text = snippet(noteToPlain(str(row.Body)), '', 140)
    const version = row.modifiedOn instanceof Date ? row.modifiedOn.toISOString() : str(row.modifiedOn)
    let sent = 0
    for (const u of ok) {
      if (by && u.id === by.id) continue
      await svc.notify({ userIds: [u.id] }, {
        kind: 'mention', title: `${by?.name ?? 'Someone'} mentioned you in the note "${title.slice(0, 120)}"`.slice(0, 200), body: text,
        link: `#u-notes?n=${encodeURIComponent(p.id)}`, environmentId: currentEnvironment().id, source: by ? `user:${by.id}` : 'system',
        ...(by ? { from: { id: by.id, name: by.name } } : {}), idempotencyKey: `note-mention:${p.id}:${u.id}:${version}`,
      })
      sent++
    }
    return { sent }
  }

  /* ---------------------------------------------------------------- reading */

  /** the note as this reader may see it, or null (a note they may not read answers like a missing one) */
  async function readNote(user: UserContext, id: string): Promise<Record<string, unknown> | null> {
    if (!id || id.length > 64) return null
    const acts = await table(SYS.activities)
    const res = await s.data.query(user, acts, { where: { and: [{ col: 'id', op: 'eq', value: id }, { col: 'Type', op: 'eq', value: 'Note' }] }, top: 1 })
    return (res.rows[0] as Record<string, unknown> | undefined) ?? null
  }

  async function canUpdate(user: UserContext, id: string): Promise<boolean> {
    const acts = s.data.internals.physical(await table(SYS.activities))
    const pred = user.rowPredicate(acts, 'update')
    if ('const' in pred) return pred.const && !!(await s.data.internals.findRow(acts, id))
    return !!(await s.data.internals.findRow(acts, id, pred))
  }

  /* ---------------------------------------------------------------- pins (per person and environment) */

  const pinKey = (userId: string, noteId: string) => `notes.pin:${userId}:${noteId}`
  async function pins(userId: string): Promise<Set<string>> {
    const prefix = `notes.pin:${userId}:`
    const rows = await db().query<{ k: string }>(`SELECT k FROM ${S('ab_counters')} WHERE left(k, $2) = $1 LIMIT 1000`, [prefix, prefix.length])
    return new Set(rows.map((r) => r.k.slice(prefix.length)))
  }
  async function setPin(userId: string, noteId: string, on: boolean): Promise<void> {
    if (on) await db().exec(`INSERT INTO ${S('ab_counters')} (k, v) VALUES ($1, 1) ON CONFLICT (k) DO NOTHING`, [pinKey(userId, noteId)])
    else await db().exec(`DELETE FROM ${S('ab_counters')} WHERE k = $1`, [pinKey(userId, noteId)])
  }

  /* ---------------------------------------------------------------- registration */

  function register(): void {
    s.tasks.setNoteSanitizer(sanitizeNoteHtml)
    s.tasks.setNoteHooks({ afterWrite })
    s.kernel.jobs.register<{ id: string; userIds: string[] }>({
      type: NOTES_NOTIFY_JOB,
      description: 'Tells the people mentioned in a note (after checking they may still read it).',
      concurrency: 2, maxAttempts: 5,
      parse: (raw) => {
        const o = (raw ?? {}) as Record<string, unknown>
        if (typeof o.id !== 'string' || !Array.isArray(o.userIds)) throw new Error('id and userIds are needed')
        return { id: o.id, userIds: o.userIds.map(String).slice(0, MAX_NEW_MENTIONS) }
      },
      handler: (p) => notify(p).catch((e) => {
        log('warn', `note mention notification ${p.id}: ${errText(e)}`)
        throw e
      }),
    })
  }

  return { afterWrite, notify, readNote, canUpdate, pins, setPin, register, table }
}
