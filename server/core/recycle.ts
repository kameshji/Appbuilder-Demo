/**
 * Recycle bin for deleted rows (docs/dev/recycle-bin.md): deletion batches, restore, purge, the Deleted view.
 *
 * A table of the default database with `recycleBin` (columns) and `recycleDays > 0` (setting) keeps its deleted rows:
 * the DataService's delete (data.ts del) soft-deletes them (UPDATE "deletedOn", "deletedBy", "deleteBatch") inside its
 * unit of work and records every side effect of that one delete operation as a BATCH (ab_delete_batches) with EFFECTS
 * (ab_delete_effects): rows soft-deleted by the cascade, the previous lookup values of rows set blank, collaboration rows
 * removed with their record (full row), regarding links detached, shares, and rows of tables without a recycle bin
 * that the cascade deleted for good ('final'). Restore undoes exactly one batch (or one row of it) in one transaction;
 * the purge job deletes batches past their expiry for good (then the attachment files go).
 *
 * Reads never see deleted rows: the live-row predicate is ANDed by the PostgreSQL connector's buildWhere (sql.ts
 * liveRowsSql), the one place every statement passes through.
 */
import { HttpError } from './contracts.ts'
import type { Connector, MetaStore, RawRow, SqlDb, UserContext, AttachmentRecord } from './contracts.ts'
import type { ColumnDef, TableDef } from '../../src/platform/contracts.ts'
import type { Condition, QueryValue } from '../../src/platform/http.ts'
import { and } from './condition.ts'
import { currentEnvironment } from './env-context.ts'
import { currentWork } from './work-context.ts'
import { rowUid } from './util.ts'
import { DEFAULT_CONNECTION_ID } from './connections.ts'
import { physicalName, quoteId } from '../connectors/postgres/sql.ts'
import { childRelationships } from './model/delete-rules.ts'
import { SYSTEM_COLUMN_NAMES } from './security.ts'

export const RECYCLE_PURGE_JOB = 'data.recycle-purge'
export const MAX_RECYCLE_DAYS = 3650
/** what a new table of the default database starts with */
export const DEFAULT_RECYCLE_DAYS = 30
/** rows purged per statement (each statement in the batch's own transaction) */
const PURGE_CHUNK = 5000
const ID_CHUNK = 500
/** root ids kept on the batch row for display (the effects hold them all) */
const ROOT_ID_CAP = 1000

export type DeleteSource = 'user' | 'flow' | 'event' | 'import' | 'api' | 'system'
export type BatchState = 'deleted' | 'partial' | 'restored' | 'purged'
export type EffectKind = 'row' | 'setBlank' | 'collab' | 'detach' | 'share' | 'final'

export interface Effect {
  kind: EffectKind
  tableId: string
  rowId?: string | null
  column?: string | null
  old?: unknown
}

/** a delete operation in progress (data.ts del carries it down the cascade) */
export interface BatchCtx {
  id: string
  tableId: string
  at: Date
  by: string | null
  expiresOn: Date
  keepDays: number
  source: DeleteSource
  rootIds: string[]
  effects: Effect[]
}

/** a batch as the API shows it */
export interface BatchInfo {
  id: string
  tableId: string
  tableName: string
  rows: number
  rootIds: string[]
  deletedBy: string | null
  deletedByName: string | null
  deletedOn: string
  expiresOn: string
  daysLeft: number
  source: DeleteSource
  state: BatchState
  /** rows of tables without a recycle bin that this delete removed for good */
  finalRows: number
}

export interface RestoreResult {
  restored: number
  batch: string
  tables: { tableId: string; rows: number }[]
  /** what was restored differently from the delete: a value set since was kept, a link to a parent that is gone was cleared, ... */
  warnings: string[]
}

const q = (id: string): string => `"${id.replace(/"/g, '""')}"`
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString())
const DAY = 86_400_000

/** the recycle-bin setting of a table, validated (0 = off) */
export function recycleDaysOf(v: unknown): number {
  if (v === undefined || v === null || v === '' || v === false) return 0
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > MAX_RECYCLE_DAYS) throw new HttpError(422, 'invalid', `Keep deleted rows for: a whole number of days between 0 (off) and ${MAX_RECYCLE_DAYS}.`, 'recycleDays')
  return n
}

/** may this table have a recycle bin at all (default database, a real table Appbuilder manages, not reference data)? */
export function recycleAllowed(def: TableDef, recyclableSystem: string[]): { ok: true } | { ok: false; why: string } {
  if ((def.connectionId ?? DEFAULT_CONNECTION_ID) !== DEFAULT_CONNECTION_ID) return { ok: false, why: 'Tables in other connections (MySQL, PostgreSQL databases of your own, data files, Google Sheets) delete rows for good.' }
  if (def.reporting) return { ok: false, why: 'Reporting views, summary tables and date dimensions have no recycle bin.' }
  if (def.readOnly) return { ok: false, why: 'A read-only table has no recycle bin.' }
  if (def.system && !recyclableSystem.includes(def.id)) return { ok: false, why: 'This system table has no recycle bin (its rows go and come back with the record they are about, or are reference data).' }
  if (!def.system && def.managed !== true) return { ok: false, why: 'A linked table (it existed before Appbuilder) deletes rows for good.' }
  return { ok: true }
}

/** the source of a delete from where it runs: a flow step, a table event or job, a person */
export function deleteSourceOf(ctx: UserContext | null): DeleteSource {
  const w = currentWork()
  const last = w.chain[w.chain.length - 1] ?? ''
  if (last.startsWith('flow:')) return 'flow'
  if (w.depth > 0 || w.jobId) return ctx ? 'event' : 'system'
  return ctx ? 'user' : 'system'
}

export function newBatch(def: TableDef, ctx: UserContext | null, source: DeleteSource): BatchCtx {
  const at = new Date()
  const keepDays = Math.max(1, def.recycleDays ?? 0)
  return { id: `del_${rowUid(at.getTime())}`, tableId: def.id, at, by: ctx?.user.id ?? null, expiresOn: new Date(at.getTime() + keepDays * DAY), keepDays, source, rootIds: [], effects: [] }
}

/* ------------------------------------------------------------------ store (ab_delete_batches, ab_delete_effects) */

export function createRecycleStore(getDb: () => SqlDb | null) {
  const db = (): SqlDb => {
    const d = getDb()
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }
  const E = (t: string): string => `${q(currentEnvironment().schema)}.${q(t)}`

  async function save(b: BatchCtx): Promise<void> {
    const rows = b.effects.filter((e) => e.kind === 'row').length
    await db().exec(
      `INSERT INTO ${E('ab_delete_batches')} (id, table_id, root_ids, row_count, deleted_by, deleted_on, expires_on, source, state, details)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, 'deleted', $9::jsonb)`,
      [b.id, b.tableId, JSON.stringify(b.rootIds.slice(0, ROOT_ID_CAP)), rows, b.by, b.at, b.expiresOn, b.source, JSON.stringify({ keepDays: b.keepDays, final: b.effects.filter((e) => e.kind === 'final').length, rootCount: b.rootIds.length })],
    )
    await addEffects(b.id, b.effects, 0)
  }

  async function addEffects(batchId: string, effects: Effect[], from: number): Promise<void> {
    const per = 1000
    for (let i = 0; i < effects.length; i += per) {
      const chunk = effects.slice(i, i + per)
      const params: unknown[] = []
      const tuples = chunk.map((e, j) => {
        params.push(batchId, from + i + j + 1, e.kind, e.tableId, e.rowId ?? null, e.column ?? null, e.old === undefined ? null : JSON.stringify(e.old))
        const o = params.length - 7
        return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}::jsonb)`
      })
      await db().exec(`INSERT INTO ${E('ab_delete_effects')} (batch_id, seq, kind, table_id, row_id, column_name, old_value) VALUES ${tuples.join(', ')}`, params)
    }
  }

  type BatchRow = Record<string, unknown>
  const toInfo = (r: BatchRow, names: { table: (id: string) => string; user: (id: string | null) => string | null }): BatchInfo => {
    const det = (r.details ?? {}) as { final?: number }
    const expires = new Date(iso(r.expires_on))
    return {
      id: String(r.id), tableId: String(r.table_id), tableName: names.table(String(r.table_id)), rows: Number(r.row_count) || 0,
      rootIds: (Array.isArray(r.root_ids) ? r.root_ids : []) as string[], deletedBy: (r.deleted_by as string) ?? null, deletedByName: names.user((r.deleted_by as string) ?? null),
      deletedOn: iso(r.deleted_on), expiresOn: expires.toISOString(), daysLeft: Math.max(0, Math.ceil((expires.getTime() - Date.now()) / DAY)),
      source: String(r.source) as DeleteSource, state: String(r.state) as BatchState, finalRows: Number(det.final) || 0,
    }
  }

  return {
    save,
    addEffects,
    toInfo,
    async get(id: string, lock = false): Promise<BatchRow | null> {
      return (await db().query<BatchRow>(`SELECT * FROM ${E('ab_delete_batches')} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]))[0] ?? null
    },
    async many(ids: string[]): Promise<BatchRow[]> {
      if (!ids.length) return []
      return db().query<BatchRow>(`SELECT * FROM ${E('ab_delete_batches')} WHERE id = ANY($1::text[])`, [ids])
    },
    async effects(batchId: string): Promise<(Effect & { seq: number })[]> {
      const rows = await db().query<Record<string, unknown>>(`SELECT seq, kind, table_id, row_id, column_name, old_value FROM ${E('ab_delete_effects')} WHERE batch_id = $1 ORDER BY seq`, [batchId])
      return rows.map((r) => ({ seq: Number(r.seq), kind: String(r.kind) as EffectKind, tableId: String(r.table_id), rowId: (r.row_id as string) ?? null, column: (r.column_name as string) ?? null, old: r.old_value ?? undefined }))
    },
    async dropEffects(batchId: string, seqs?: number[]): Promise<void> {
      if (seqs) {
        if (seqs.length) await db().exec(`DELETE FROM ${E('ab_delete_effects')} WHERE batch_id = $1 AND seq = ANY($2::int[])`, [batchId, seqs])
        return
      }
      await db().exec(`DELETE FROM ${E('ab_delete_effects')} WHERE batch_id = $1`, [batchId])
    },
    async setState(id: string, state: BatchState, by: string | null, rows?: number): Promise<void> {
      const col = state === 'purged' ? 'purged_on' : 'restored_on'
      await db().exec(
        `UPDATE ${E('ab_delete_batches')} SET state = $2, ${col} = now()${state === 'restored' || state === 'partial' ? ', restored_by = $3' : ''}${rows !== undefined ? `, row_count = ${Math.max(0, Math.trunc(rows))}` : ''} WHERE id = $1`,
        state === 'restored' || state === 'partial' ? [id, state, by] : [id, state],
      )
    },
    /** open batches past their expiry, oldest first */
    async expired(limit: number): Promise<string[]> {
      return (await db().query<{ id: string }>(`SELECT id FROM ${E('ab_delete_batches')} WHERE state IN ('deleted', 'partial') AND expires_on <= now() ORDER BY expires_on LIMIT ${Math.max(1, Math.trunc(limit))}`)).map((r) => r.id)
    },
    /** open batches holding deleted rows of a table (as root or by cascade) */
    async touching(tableId: string): Promise<string[]> {
      return (await db().query<{ id: string }>(
        `SELECT DISTINCT b.id FROM ${E('ab_delete_batches')} b JOIN ${E('ab_delete_effects')} e ON e.batch_id = b.id AND e.kind = 'row' AND e.table_id = $1 WHERE b.state IN ('deleted', 'partial')`, [tableId])).map((r) => r.id)
    },
    async openCount(tableId: string): Promise<number> {
      return Number((await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${E('ab_delete_batches')} WHERE table_id = $1 AND state IN ('deleted', 'partial')`, [tableId]))[0]?.n ?? 0)
    },
    /** the batch a deleted row belongs to (its own column says it; also for rows of a table whose bin was turned off since) */
    async rowBatch(tableId: string, rowId: string): Promise<string | null> {
      const r = await db().query<{ id: string }>(
        `SELECT e.batch_id AS id FROM ${E('ab_delete_effects')} e JOIN ${E('ab_delete_batches')} b ON b.id = e.batch_id AND b.state IN ('deleted', 'partial') WHERE e.kind = 'row' AND e.table_id = $1 AND e.row_id = $2 LIMIT 1`, [tableId, rowId])
      return r[0]?.id ?? null
    },
    /** shares of rows that are being soft-deleted: removed, returned as full rows (restored with the batch) */
    async takeShares(tableId: string, rowIds: string[]): Promise<{ rowId: string; row: unknown }[]> {
      const out: { rowId: string; row: unknown }[] = []
      for (let i = 0; i < rowIds.length; i += ID_CHUNK) {
        const r = await db().query<{ row_id: string; j: unknown }>(`DELETE FROM ${E('ab_shares')} AS s WHERE s.table_id = $1 AND s.row_id = ANY($2::text[]) RETURNING s.row_id, to_jsonb(s.*) AS j`, [tableId, rowIds.slice(i, i + ID_CHUNK)])
        for (const x of r) out.push({ rowId: String(x.row_id), row: x.j })
      }
      return out
    },
    /** put full rows back (shares, collaboration rows); a row whose key is taken since stays out (counted) */
    async putRows(table: string, rows: unknown[]): Promise<number> {
      let n = 0
      for (const row of rows) {
        n += (await db().exec(`INSERT INTO ${E(table)} SELECT * FROM jsonb_populate_record(NULL::${E(table)}, $1::jsonb) ON CONFLICT DO NOTHING`, [JSON.stringify(row)])).affectedRows
      }
      return n
    },
    /** detached regarding links (documents, channels, messages) back, where they are still blank */
    async relink(table: string, rowId: string, link: { table: string; id: string }): Promise<number> {
      return (await db().exec(`UPDATE ${E(table)} SET "regardingTable" = $2, "regardingId" = $3 WHERE "id" = $1 AND "regardingId" IS NULL`, [rowId, link.table, link.id])).affectedRows
    },
    /**
     * deleted rows whose batch is not open any more (a table restored from a backup brings rows of batches this
     * environment no longer has): past the table's retention they go too, in chunks
     */
    async purgeOrphans(def: TableDef, keepDays: number, limit: number): Promise<string[]> {
      const t = `${q(currentEnvironment().schema)}.${quoteId(physicalName(def))}`
      return (await db().query<{ id: string }>(
        `DELETE FROM ${t} WHERE "id" IN (SELECT x."id" FROM ${t} x WHERE x."deletedOn" IS NOT NULL AND x."deletedOn" < now() - make_interval(days => $1)
           AND NOT EXISTS (SELECT 1 FROM ${E('ab_delete_batches')} b WHERE b.id = x."deleteBatch" AND b.state IN ('deleted', 'partial')) LIMIT ${Math.max(1, Math.trunc(limit))}) RETURNING "id"`,
        [Math.max(1, keepDays)])).map((r) => String(r.id))
    },
    async list(tableId: string | null, o: { states?: BatchState[]; limit?: number } = {}): Promise<BatchRow[]> {
      const states = o.states ?? ['deleted', 'partial']
      return db().query<BatchRow>(
        `SELECT * FROM ${E('ab_delete_batches')} WHERE state = ANY($1::text[])${tableId ? ' AND table_id = $2' : ''} ORDER BY deleted_on DESC LIMIT ${Math.max(1, Math.min(500, o.limit ?? 100))}`,
        tableId ? [states, tableId] : [states],
      )
    },
  }
}
export type RecycleStore = ReturnType<typeof createRecycleStore>

/* ------------------------------------------------------------------ restore, purge, the Deleted view */

/** what recycle needs from the DataService (data.ts passes its internals) */
export interface RecycleHost {
  meta(): MetaStore
  store: RecycleStore
  physical(t: TableDef): TableDef
  connectorFor(t: TableDef): Promise<Connector>
  unit<T>(t: TableDef, fn: () => Promise<T>): Promise<T>
  rowOut(ctx: UserContext | null, t: TableDef, raw: RawRow): Record<string, QueryValue>
  /** a system update with events and outbox (set-blank values back, links to parents that are gone cleared) */
  updateAsSystem(t: TableDef, id: string, changes: Record<string, QueryValue>): Promise<void>
  audit(ctx: UserContext | null, action: string, t: TableDef, rowId?: string, details?: unknown): Promise<void>
  outbox(ctx: UserContext | null, t: TableDef, e: { op: 'bulk'; rowIds: string[]; rowCount: number; details: unknown }): Promise<void>
  changed(ctx: UserContext | null, t: TableDef, rowIds: string[]): void
  removeAttachments(records: AttachmentRecord[]): Promise<void>
  log(level: 'info' | 'warn' | 'error', msg: string): void
}

const isConstFalse = (c: Condition | undefined): boolean => !!c && 'const' in c && !c.const
const isConstTrue = (c: Condition | undefined): boolean => !c || ('const' in c && c.const === true)
const label = (t: TableDef) => t.displayName || t.name

export function createRecycle(h: RecycleHost) {
  const tables = () => h.meta().tables.list()

  async function deletedIds(conn: Connector, def: TableDef, ids: string[], where: Condition | undefined, scope: 'deleted' | 'live' = 'deleted'): Promise<string[]> {
    if (isConstFalse(where)) return []
    const out: string[] = []
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const inIds: Condition = { col: 'id', op: 'in', value: ids.slice(i, i + ID_CHUNK) }
      const r = await conn.select(def, { where: isConstTrue(where) ? inIds : and(inIds, where), select: ['id'] }, { rows: scope })
      for (const x of r.rows) out.push(String(x.id))
    }
    return out
  }

  /** the rows a caller may restore or list from the bin: rows they could delete AND can see (administrators: all) */
  function binPredicate(ctx: UserContext | null, def: TableDef): Condition | undefined {
    if (!ctx || ctx.privileges.isAdmin) return undefined
    const del = ctx.rowPredicate(def, 'delete')
    const read = ctx.rowPredicate(def, 'read')
    if (isConstFalse(del) || isConstFalse(read)) return { const: false }
    return and(isConstTrue(del) ? undefined : del, isConstTrue(read) ? undefined : read)
  }

  function canUseBin(ctx: UserContext | null, def: TableDef): boolean {
    if (!ctx || ctx.privileges.isAdmin) return true
    return !isConstFalse(binPredicate(ctx, def))
  }

  async function nameMaps(batchRows: Record<string, unknown>[]) {
    const all = await tables()
    const users = new Map<string, string | null>()
    for (const id of new Set(batchRows.map((r) => r.deleted_by as string | null).filter((x): x is string => !!x))) {
      const u = await h.meta().users.get(id).catch(() => null)
      users.set(id, u?.name ?? null)
    }
    return { table: (id: string) => label(all.find((t) => t.id === id) ?? ({ name: id, displayName: id } as TableDef)), user: (id: string | null) => (id ? users.get(id) ?? null : null) }
  }

  /* ---------------------------------------------------------------- the Deleted view */

  async function listDeleted(ctx: UserContext | null, table: TableDef, o: { limit?: number; skip?: number; batch?: string } = {}) {
    const def = h.physical(table)
    if (def.recycleBin !== true) return { rows: [], total: 0, batches: [] as BatchInfo[] }
    const pred = binPredicate(ctx, def)
    if (isConstFalse(pred)) return { rows: [], total: 0, batches: [] as BatchInfo[] }
    const conn = await h.connectorFor(def)
    const limit = Math.max(1, Math.min(500, Math.trunc(Number(o.limit ?? 100)) || 100))
    const skip = Math.max(0, Math.trunc(Number(o.skip ?? 0)) || 0)
    const where = and(pred, o.batch ? { col: 'deleteBatch', op: 'eq', value: o.batch } : undefined)
    const res = await conn.select(def, { where: isConstTrue(where) ? undefined : where, orderBy: [{ col: 'deletedOn', dir: 'desc' }, { col: 'id', dir: 'asc' }], top: limit, skip, count: true }, { rows: 'deleted' })
    const batchIds = [...new Set(res.rows.map((r) => String(r.deleteBatch ?? '')).filter(Boolean))]
    const batchRows = await h.store.many(batchIds)
    const names = await nameMaps(batchRows)
    const infos = new Map(batchRows.map((b) => [String(b.id), h.store.toInfo(b, names)]))
    const rows = res.rows.map((r) => {
      const b = infos.get(String(r.deleteBatch ?? ''))
      return {
        ...h.rowOut(ctx, def, r),
        __deleted: {
          on: r.deletedOn instanceof Date ? r.deletedOn.toISOString() : String(r.deletedOn ?? ''),
          by: (r.deletedBy as string) ?? null, byName: b?.deletedByName ?? null,
          batch: String(r.deleteBatch ?? ''), expiresOn: b?.expiresOn ?? null, daysLeft: b?.daysLeft ?? 0,
          rootTable: b?.tableId ?? def.id, rootTableName: b?.tableName ?? label(def), cascaded: !!b && b.tableId !== def.id,
          batchRows: b?.rows ?? 1, source: b?.source ?? 'user',
        },
      }
    })
    return { rows, total: res.total ?? rows.length, batches: [...infos.values()] }
  }

  /* ---------------------------------------------------------------- restore */

  /** relationship behaviour of a lookup column of `child` (as data.ts applies it on delete) */
  async function parentRules(child: TableDef): Promise<Map<string, 'restrict' | 'cascade' | 'setBlank'>> {
    const out = new Map<string, 'restrict' | 'cascade' | 'setBlank'>()
    const store = h.meta().relationships
    for (const col of child.columns) {
      if (col.type !== 'lookup' || !col.lookupTable || col.system || SYSTEM_COLUMN_NAMES.has(col.name)) continue
      const target = (await tables()).find((t) => t.name.toLowerCase() === col.lookupTable!.toLowerCase() || t.id === col.lookupTable)
      if (!target) continue
      const rels = await childRelationships(target, tables, store ? (id) => store.toTable(id) : null)
      const r = rels.find((x) => x.child.id === child.id && x.column.name === col.name)
      out.set(col.name, r?.onDelete ?? (col.required ? 'restrict' : 'setBlank'))
    }
    return out
  }

  /** "Code \"A-1\" is used again by Contoso (row 01h...)" for the rows about to come back; null when free */
  async function uniqueConflict(def: TableDef, conn: Connector, rows: RawRow[]): Promise<string | null> {
    const singles = def.columns.filter((c) => c.unique && !c.system && c.type !== 'multiline' && c.type !== 'image' && c.type !== 'file')
    const pairs = (def.uniqueTogether ?? []).filter((s) => s.length > 1)
    if (!singles.length && !pairs.length) return null
    const describe = (hit: RawRow) => {
      const title = hit[def.primaryColumn]
      return `${title !== null && title !== undefined && title !== '' ? `"${String(title).slice(0, 60)}"` : 'another row'} (id ${String(hit.id)})`
    }
    const valueOf = (v: RawRow[string]): QueryValue => (v instanceof Date ? v.toISOString() : (v as QueryValue))
    for (const col of singles) {
      const values = rows.map((r) => r[col.name]).filter((v) => v !== null && v !== undefined && v !== '')
      for (let i = 0; i < values.length; i += ID_CHUNK) {
        const chunk = values.slice(i, i + ID_CHUNK).map(valueOf)
        const hit = (await conn.select(def, { where: { col: col.name, op: 'in', value: chunk }, select: ['id', col.name, def.primaryColumn], top: 1 })).rows[0]
        if (hit) return `${col.displayName || col.name} "${String(valueOf(hit[col.name] ?? null)).slice(0, 60)}" is used by ${describe(hit)} now. Change or delete that row first, then restore again.`
      }
    }
    for (const set of pairs) {
      for (const r of rows.slice(0, 2000)) {
        if (set.some((c) => r[c] === null || r[c] === undefined || r[c] === '')) continue
        const where = and(...set.map((c): Condition => ({ col: c, op: 'eq', value: valueOf(r[c] ?? null) })))
        const hit = (await conn.select(def, { where, select: ['id', def.primaryColumn], top: 1 })).rows[0]
        if (hit) return `The combination of ${set.map((c) => def.columns.find((x) => x.name === c)?.displayName ?? c).join(' and ')} is used by ${describe(hit)} now. Change or delete that row first, then restore again.`
      }
    }
    return null
  }

  /**
   * Undo one batch (default) or one row of it, in one transaction. Re-validated: permissions (the restorer must be able
   * to delete and see every row that comes back; administrators always), unique values (the live rows must not use them
   * since), parents (a required, restrict or cascade lookup must point at a live row or a row of this same batch; an
   * optional set-blank lookup to a parent that is gone is cleared). Current validation rules and before-events are NOT
   * run (the rows come back as they were).
   */
  async function restore(ctx: UserContext | null, table: TableDef, input: { batch?: string; rowId?: string }): Promise<RestoreResult> {
    const root = h.physical(table)
    return h.unit(root, async () => {
      let batchId = input.batch
      if (!batchId && input.rowId) batchId = (await h.store.rowBatch(root.id, input.rowId)) ?? undefined
      if (!batchId) throw new HttpError(404, 'not-found', 'There is no deleted row or batch to restore here.')
      const b = await h.store.get(batchId, true)
      if (!b) throw new HttpError(404, 'not-found', 'This deletion batch does not exist.')
      const state = String(b.state) as BatchState
      if (state === 'restored') throw new HttpError(409, 'conflict', 'These rows have already been restored.')
      if (state === 'purged') throw new HttpError(409, 'conflict', 'These rows were deleted for good (their time in the recycle bin ran out, or an administrator emptied it).')
      const effects = await h.store.effects(batchId)
      const all = await tables()
      const byId = new Map(all.map((t) => [t.id, h.physical(t)]))
      const isAdmin = !ctx || ctx.privileges.isAdmin
      const warnings: string[] = []
      const rowEffects = effects.filter((e) => e.kind === 'row')
      let only: { tableId: string; rowId: string } | null = null
      if (input.rowId) {
        const e = rowEffects.find((x) => x.rowId === input.rowId && x.tableId === root.id)
        if (!e) throw new HttpError(404, 'not-found', 'This row is not in the recycle bin.')
        only = { tableId: root.id, rowId: input.rowId }
      }
      // the rows that come back, by table. One row: that row and the rows its delete took along (rows of the batch
      // whose lookups point at it, transitively); its parents must be live (checked below)
      const want = new Map<string, string[]>()
      if (only) {
        const chosen = new Set([`${only.tableId}:${only.rowId}`])
        const byTable = new Map<string, string[]>()
        for (const e of rowEffects) byTable.set(e.tableId, [...(byTable.get(e.tableId) ?? []), String(e.rowId)])
        const loaded = new Map<string, RawRow[]>()
        for (const [tid, ids] of byTable) {
          const def = byId.get(tid)
          if (!def || tid === only.tableId && ids.length === 1) continue
          const conn = await h.connectorFor(def)
          const got: RawRow[] = []
          for (let i = 0; i < ids.length; i += ID_CHUNK) got.push(...(await conn.select(def, { where: { col: 'id', op: 'in', value: ids.slice(i, i + ID_CHUNK) } }, { rows: 'deleted' })).rows)
          loaded.set(tid, got)
        }
        for (let grew = true; grew;) {
          grew = false
          for (const [tid, rows] of loaded) {
            const def = byId.get(tid)!
            const links = def.columns.filter((c) => c.type === 'lookup' && !c.system && c.lookupTable)
            for (const r of rows) {
              const key = `${tid}:${String(r.id)}`
              if (chosen.has(key)) continue
              const hit = links.some((c) => {
                const target = all.find((t) => t.name.toLowerCase() === c.lookupTable!.toLowerCase() || t.id === c.lookupTable)
                return target && typeof r[c.name] === 'string' && chosen.has(`${target.id}:${String(r[c.name])}`)
              })
              if (hit) { chosen.add(key); grew = true }
            }
          }
        }
        for (const e of rowEffects) if (chosen.has(`${e.tableId}:${e.rowId}`)) want.set(e.tableId, [...(want.get(e.tableId) ?? []), String(e.rowId)])
      } else {
        for (const e of rowEffects) want.set(e.tableId, [...(want.get(e.tableId) ?? []), String(e.rowId)])
      }
      // tables dropped since: their rows cannot come back
      for (const tid of [...want.keys()]) {
        if (!byId.has(tid)) {
          if (!isAdmin) throw new HttpError(409, 'conflict', `Some of these rows were in a table that has been deleted since. An administrator can restore the rest.`)
          warnings.push(`${want.get(tid)!.length} row(s) of a table that was deleted since could not be restored.`)
          want.delete(tid)
        }
      }
      // permission: the restorer must be able to see and delete every row coming back (checked on the deleted rows now,
      // and again on the restored rows before commit, when relationship rules can see their restored parents)
      const rootDef = byId.get(String(b.table_id)) ?? root
      for (const [tid, ids] of want) {
        const def = byId.get(tid)!
        const conn = await h.connectorFor(def)
        const present = await deletedIds(conn, def, ids, undefined)
        if (present.length !== ids.length) want.set(tid, present)
        // the rows a person deleted (the batch's own table; for one row, that row's table): the cascade followed them
        if (isAdmin || (tid !== rootDef.id && !(only && tid === only.tableId))) continue
        const mine = await deletedIds(conn, def, present, binPredicate(ctx, def))
        if (mine.length !== present.length) {
          if (!mine.length) throw new HttpError(404, 'not-found', 'There is no deleted row or batch to restore here.')
          throw new HttpError(403, 'denied', `You can restore only rows you are allowed to delete and see; ${present.length - mine.length} of these rows are not. Ask an administrator.`)
        }
      }
      const finals = effects.filter((e) => e.kind === 'final')
      if (finals.length && !only) {
        const what = [...new Set(finals.map((f) => label(byId.get(f.tableId) ?? ({ name: f.tableId } as TableDef))))].join(', ')
        if (!isAdmin) throw new HttpError(409, 'conflict', `This delete also removed ${finals.length} row(s) in ${what} for good (that table keeps no deleted rows). An administrator can restore the rest.`)
        warnings.push(`${finals.length} row(s) in ${what} were deleted for good and do not come back.`)
      }
      // read the rows coming back (all columns), then: unique values, parents
      const restoring = new Set<string>()
      for (const [tid, ids] of want) for (const id of ids) restoring.add(`${tid}:${id}`)
      const rowsOf = new Map<string, RawRow[]>()
      for (const [tid, ids] of want) {
        const def = byId.get(tid)!
        const conn = await h.connectorFor(def)
        const got: RawRow[] = []
        for (let i = 0; i < ids.length; i += ID_CHUNK) got.push(...(await conn.select(def, { where: { col: 'id', op: 'in', value: ids.slice(i, i + ID_CHUNK) } }, { rows: 'deleted' })).rows)
        rowsOf.set(tid, got)
        const clash = await uniqueConflict(def, conn, got)
        if (clash) throw new HttpError(409, 'conflict', `Can't restore: ${clash}`, undefined, { conflict: 'unique' })
      }
      const clear: { def: TableDef; id: string; col: ColumnDef }[] = []
      for (const [tid, rows] of rowsOf) {
        const def = byId.get(tid)!
        const rules = await parentRules(def)
        for (const col of def.columns) {
          const rule = rules.get(col.name)
          if (!rule) continue
          const target = all.find((t) => t.name.toLowerCase() === col.lookupTable!.toLowerCase() || t.id === col.lookupTable)
          if (!target) continue
          const tdef = byId.get(target.id)!
          const tconn = await h.connectorFor(tdef)
          const values = [...new Set(rows.map((r) => r[col.name]).filter((v): v is string => typeof v === 'string' && v !== '').filter((v) => !restoring.has(`${tdef.id}:${v}`)))]
          if (!values.length) continue
          const live = new Set(await deletedIds(tconn, tdef, values, undefined, 'live'))
          const missing = values.filter((v) => !live.has(v))
          if (!missing.length) continue
          if (rule === 'setBlank' && !col.required) {
            for (const r of rows) if (missing.includes(String(r[col.name]))) clear.push({ def, id: String(r.id), col })
            warnings.push(`${col.displayName || col.name}: ${missing.length} link(s) to rows of ${label(tdef)} that are gone were cleared.`)
            continue
          }
          // a parent deleted in another batch: name it
          const other = tdef.recycleBin ? await h.store.rowBatch(tdef.id, missing[0]) : null
          if (other && other !== batchId) {
            const ob = await h.store.get(other)
            throw new HttpError(409, 'conflict', `Can't restore yet: ${col.displayName || col.name} points at a row of ${label(tdef)} that is in the recycle bin too (deleted ${ob ? new Date(iso(ob.deleted_on)).toLocaleString('en-GB', { timeZone: 'UTC' }) + ' UTC' : 'earlier'}). Restore that first.`, col.name, { needs: { batch: other, table: tdef.id, row: missing[0] } })
          }
          if (other === batchId) throw new HttpError(409, 'conflict', `Can't restore this row on its own: ${col.displayName || col.name} points at a row of ${label(tdef)} deleted together with it. Restore the whole batch.`, col.name, { needs: { batch: batchId, table: tdef.id, row: missing[0] } })
          throw new HttpError(409, 'conflict', `Can't restore: ${col.displayName || col.name} points at a row of ${label(tdef)} that was deleted for good.`, col.name)
        }
      }
      // the undo, newest effect first: rows back, links cleared where their parent is gone, set-blank values back where
      // still blank, collaboration rows, links and shares back
      const result: RestoreResult = { restored: 0, batch: batchId, tables: [], warnings }
      const touched = new Map<string, string[]>()
      for (const [tid, ids] of want) {
        if (!ids.length) continue
        const def = byId.get(tid)!
        const conn = await h.connectorFor(def)
        const back: string[] = []
        for (let i = 0; i < ids.length; i += PURGE_CHUNK) back.push(...(await conn.recycle!.restore(def, batchId, ids.slice(i, i + PURGE_CHUNK))))
        touched.set(tid, back)
        result.restored += back.length
        result.tables.push({ tableId: tid, rows: back.length })
      }
      for (const c of clear) await h.updateAsSystem(c.def, c.id, { [c.col.name]: null })
      const done: number[] = []
      const restoredIds = new Set([...touched.entries()].flatMap(([t, ids]) => ids.map((id) => `${t}:${id}`)))
      const backIds = new Set([...touched.values()].flat())
      for (const e of [...effects].reverse()) {
        if (e.kind === 'row') {
          if (restoredIds.has(`${e.tableId}:${e.rowId}`)) done.push(e.seq)
          continue
        }
        if (e.kind === 'final') {
          if (!only) done.push(e.seq)
          continue
        }
        // single-row restore: only what belonged to that row
        const about = e.kind === 'setBlank' ? String(e.old ?? '') : e.kind === 'share' ? String(e.rowId ?? '') : e.kind === 'detach' ? String((e.old as { id?: string } | null)?.id ?? '') : String(((e.old ?? {}) as Record<string, unknown>).regardingId ?? e.column ?? '')
        if (only && !backIds.has(about)) continue
        const def = byId.get(e.tableId)
        if (e.kind === 'setBlank') {
          if (!def || !e.rowId || !e.column) { done.push(e.seq); continue }
          const conn = await h.connectorFor(def)
          const now = (await conn.select(def, { where: { col: 'id', op: 'eq', value: e.rowId }, select: ['id', e.column], top: 1 })).rows[0]
          if (!now) warnings.push(`${label(def)}: a row that pointed here is gone; its link was not restored.`)
          else if (now[e.column] !== null && now[e.column] !== undefined && now[e.column] !== '') warnings.push(`${label(def)}: a row that pointed here has another ${def.columns.find((c) => c.name === e.column)?.displayName ?? e.column} since; that value was kept.`)
          else await h.updateAsSystem(def, e.rowId, { [e.column]: String(e.old) })
        } else if (e.kind === 'collab') {
          const src = def?.source ?? byId.get(e.tableId)?.source
          if (src && e.old) {
            const n = await h.store.putRows(src, [e.old])
            if (!n) warnings.push(`${label(def!)}: an item about this record could not be put back (its id is in use).`)
          }
        } else if (e.kind === 'detach') {
          const link = e.old as { table: string; id: string } | null
          if (def?.source && e.rowId && link?.id) await h.store.relink(def.source, e.rowId, link)
        } else if (e.kind === 'share') {
          if (e.old) await h.store.putRows('ab_shares', [e.old])
        }
        done.push(e.seq)
      }
      // permission again on the restored rows (live now: relationship rules see their restored parents)
      if (!isAdmin) {
        for (const [tid, ids] of touched) {
          if (!ids.length || (tid !== rootDef.id && !(only && tid === only.tableId))) continue
          const def = byId.get(tid)!
          const ok = await deletedIds(await h.connectorFor(def), def, ids, binPredicate(ctx, def), 'live')
          if (ok.length !== ids.length) throw new HttpError(403, 'denied', `You can restore only rows you are allowed to delete and see; ${ids.length - ok.length} of these rows are not. Ask an administrator.`)
        }
      }
      const left = rowEffects.length - done.filter((s) => rowEffects.some((e) => e.seq === s)).length
      await h.store.dropEffects(batchId, done)
      await h.store.setState(batchId, left > 0 ? 'partial' : 'restored', ctx?.user.id ?? null, left)
      for (const [tid, ids] of touched) {
        if (!ids.length) continue
        const def = byId.get(tid)!
        await h.audit(ctx, 'row.restore', def, ids.length === 1 ? ids[0] : undefined, { batch: batchId, count: ids.length, ids: ids.slice(0, 1000), ...(only ? { single: true } : {}) })
        h.changed(ctx, def, ids)
        await h.outbox(ctx, def, { op: 'bulk', rowIds: ids, rowCount: ids.length, details: { action: 'restore', batch: batchId } })
      }
      return result
    })
  }

  /* ---------------------------------------------------------------- purge */

  /**
   * Deletes the rows of one batch for good (in chunks), then their attachment records (files after commit), and drops
   * the batch's undo log. Collaboration rows and shares went at delete time. `ctx` null: the purge job.
   */
  async function purgeBatch(ctx: UserContext | null, batchId: string, why: 'expired' | 'admin' | 'empty'): Promise<number> {
    const b = await h.store.get(batchId)
    if (!b || !['deleted', 'partial'].includes(String(b.state))) return 0
    const all = await tables()
    const byId = new Map(all.map((t) => [t.id, h.physical(t)]))
    const rootDef = byId.get(String(b.table_id)) ?? ({ id: String(b.table_id), name: String(b.table_id), displayName: String(b.table_id), columns: [], primaryColumn: 'id', createdOn: '', modifiedOn: '' } as TableDef)
    return h.unit(rootDef, async () => {
      const locked = await h.store.get(batchId, true)
      if (!locked || !['deleted', 'partial'].includes(String(locked.state))) return 0
      const effects = await h.store.effects(batchId)
      let n = 0
      for (const tid of new Set(effects.filter((e) => e.kind === 'row').map((e) => e.tableId))) {
        const def = byId.get(tid)
        if (!def?.recycleBin) continue // the table was deleted: its rows went with it
        const conn = await h.connectorFor(def)
        if (!conn.recycle) continue
        for (;;) {
          const ids = await conn.recycle.purge(def, batchId, PURGE_CHUNK)
          if (!ids.length) break
          n += ids.length
          await h.removeAttachments(await h.meta().attachments.forRows(def.id, ids))
        }
      }
      await h.store.dropEffects(batchId)
      await h.store.setState(batchId, 'purged', ctx?.user.id ?? null)
      await h.audit(ctx, 'row.purge', rootDef, undefined, { batch: batchId, rows: n, reason: why })
      return n
    })
  }

  /** administrators: empty the recycle bin of one table now (every open batch with rows in it), typed confirmation */
  async function emptyTable(ctx: UserContext, table: TableDef, confirm: unknown): Promise<{ batches: number; rows: number }> {
    if (!ctx.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only administrators can empty the recycle bin.')
    const def = h.physical(table)
    if (typeof confirm !== 'string' || confirm.trim().toLowerCase() !== def.name.toLowerCase()) {
      throw new HttpError(422, 'invalid', `Type the table name (${def.name}) to confirm. Every deleted row of this table is deleted for good.`, 'confirm')
    }
    const ids = await h.store.touching(def.id)
    let rows = 0
    for (const id of ids) rows += await purgeBatch(ctx, id, 'empty')
    await h.audit(ctx, 'table.recycle.empty', def, undefined, { batches: ids.length, rows })
    return { batches: ids.length, rows }
  }

  async function purgeOne(ctx: UserContext, table: TableDef, batchId: string): Promise<{ rows: number }> {
    if (!ctx.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only administrators can delete rows for good from the recycle bin.')
    const ids = await h.store.touching(h.physical(table).id)
    if (!ids.includes(batchId)) throw new HttpError(404, 'not-found', 'This deletion batch is not in the recycle bin of this table.')
    return { rows: await purgeBatch(ctx, batchId, 'admin') }
  }

  /** the purge job: expired batches, each in its own transaction */
  async function purgeExpired(limit = 50): Promise<{ batches: number; rows: number }> {
    let batches = 0
    let rows = 0
    for (const id of await h.store.expired(limit)) {
      try {
        rows += await purgeBatch(null, id, 'expired')
        batches++
      } catch (e) {
        h.log('warn', `recycle bin: purging batch ${id} failed: ${(e as Error).message}`)
      }
    }
    // rows of batches this environment no longer has (a table restored from a backup), past the table's retention
    for (const t of await tables()) {
      const def = h.physical(t)
      if (!def.recycleBin) continue
      try {
        const n = await h.unit(def, async () => {
          const gone = await h.store.purgeOrphans(def, def.recycleDays || 30, PURGE_CHUNK)
          if (gone.length) await h.removeAttachments(await h.meta().attachments.forRows(def.id, gone))
          return gone.length
        })
        rows += n
      } catch (e) {
        h.log('warn', `recycle bin: purging rows of ${def.name} without a batch failed: ${(e as Error).message}`)
      }
    }
    return { batches, rows }
  }

  async function stats(table: TableDef): Promise<{ enabled: boolean; keepDays: number; deletedRows: number; bytes: number; batches: number }> {
    const def = h.physical(table)
    const keepDays = def.recycleDays ?? 0
    if (!def.recycleBin) return { enabled: false, keepDays, deletedRows: 0, bytes: 0, batches: 0 }
    const conn = await h.connectorFor(def)
    const s = conn.recycle ? await conn.recycle.stats(def) : { rows: 0, bytes: 0 }
    return { enabled: keepDays > 0, keepDays, deletedRows: s.rows, bytes: s.bytes, batches: await h.store.openCount(def.id) }
  }

  async function batchInfo(ctx: UserContext | null, table: TableDef, batchId: string): Promise<BatchInfo> {
    const def = h.physical(table)
    if (!canUseBin(ctx, def)) throw new HttpError(404, 'not-found', 'This deletion batch does not exist.')
    const b = await h.store.get(batchId)
    if (!b) throw new HttpError(404, 'not-found', 'This deletion batch does not exist.')
    const info = h.store.toInfo(b, await nameMaps([b]))
    // P1-E security: a batch is described only to someone who sees at least one of its rows in this table (as the
    // Deleted view decides); its row ids are trimmed to those (administrators: everything)
    if (ctx && !ctx.privileges.isAdmin) {
      const seen = await listDeleted(ctx, table, { batch: batchId, limit: 500 })
      if (!seen.rows.length) throw new HttpError(404, 'not-found', 'This deletion batch does not exist.')
      const visible = new Set(seen.rows.map((r) => String((r as { id?: unknown }).id ?? '')))
      info.rootIds = info.rootIds.filter((id) => visible.has(id))
    }
    return info
  }

  /** the root table of a batch (null when there is no such batch) */
  async function batchTable(batchId: string): Promise<string | null> {
    const b = await h.store.get(batchId)
    return b ? String(b.table_id) : null
  }

  return { listDeleted, restore, purgeBatch, purgeOne, emptyTable, purgeExpired, stats, batchInfo, canUseBin, batchTable }
}
export type Recycle = ReturnType<typeof createRecycle>

/** physical table name for messages and SQL (re-exported for tests) */
export const recycleSource = (def: TableDef): string => quoteId(physicalName(def))

/* ------------------------------------------------------------------ the table setting */

/**
 * Sets "Keep deleted rows for N days" of a table (inside the caller's transaction). Turning it on for the first time adds
 * the columns and rebuilds the live-row partial indexes (connector.recycle.enable), and reporting views over the table
 * are created again so they leave deleted rows out. Turning it off (0) makes future deletes final; rows already in the
 * bin stay until their batch expires (the columns and the predicate stay). Refused for tables that cannot have a bin.
 */
export async function setRecycleDays(s: Pick<import('./contracts.ts').Services, 'meta' | 'connections'>, table: TableDef, value: unknown, recyclableSystem: string[]): Promise<TableDef> {
  const days = recycleDaysOf(value)
  const next: TableDef = JSON.parse(JSON.stringify(table)) as TableDef
  if (days === (table.recycleDays ?? 0)) return table
  if (days > 0) {
    const ok = recycleAllowed(table, recyclableSystem)
    if (!ok.ok) throw new HttpError(422, 'invalid', ok.why, 'recycleDays')
    const conn = await s.connections.get(table.connectionId || DEFAULT_CONNECTION_ID)
    if (!conn.capabilities.recycle || !conn.recycle) throw new HttpError(422, 'invalid', 'This table is not stored in the default database, so deletes are final.', 'recycleDays')
    if (!table.recycleBin) {
      next.recycleBin = true
      await conn.recycle.enable(next)
      // reporting views over it: created again with the live-row filter
      for (const v of await s.meta.tables.list()) {
        if (v.reporting?.kind !== 'view' || v.reporting.base !== table.id) continue
        const view: TableDef = { ...v, reporting: { ...v.reporting, baseRecycle: true } }
        await conn.dropTable(view)
        await conn.createTable(view)
        await s.meta.tables.upsert(view)
      }
    }
    next.recycleDays = days
  } else delete next.recycleDays
  next.modifiedOn = new Date().toISOString()
  await s.meta.tables.upsert(next)
  return next
}

/** the purge job (scheduled hourly by kernel.ts BUILTIN_SCHEDULES 'sched_recycle_purge') */
export function registerRecycleJobs(kernel: { jobs: { register<P>(def: import('./jobs.ts').JobTypeDef<P>): void } }, recycle: () => Recycle): void {
  kernel.jobs.register<{ batches: number }>({
    type: RECYCLE_PURGE_JOB,
    schedule: 'custom',
    description: 'Deletes for good the rows whose time in a table\'s recycle bin has run out (then their attachment files).',
    concurrency: 1,
    timeoutMs: 60 * 60_000,
    parse: (raw) => {
      const n = Number((raw as { batches?: unknown } | null)?.batches ?? 50)
      return { batches: Number.isInteger(n) && n > 0 && n <= 10_000 ? n : 50 }
    },
    handler: (p) => recycle().purgeExpired(p.batches),
  })
}
