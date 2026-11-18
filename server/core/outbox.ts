/**
 * The outbox (docs/dev/events-and-jobs.md): one row per data change in the environment's ab_outbox, written by the
 * DataService in the SAME transaction as the change (tables on the default database), so a committed change always
 * has its row and a rolled-back one never does.
 *
 * Ordering: a row takes a per-table transaction-scoped advisory lock just before it is inserted, so ids of one table
 * are allocated in commit order (a later id of a table never commits before an earlier one). The lock is held from the
 * outbox insert (the last statement of a write) to the commit.
 *
 * Consumers:
 *  - the dispatcher (dispatch(), driven by the job worker and NOTIFY ab_outbox) claims undispatched rows with
 *    FOR UPDATE SKIP LOCKED, lets the table events turn them into jobs in the same transaction, marks them dispatched,
 *    commits, and then hands them to subscribers (subscribe(): the realtime hub pushes table-changed messages);
 *  - read(afterId) for catch-up (a subscriber that was away).
 *
 * Snapshots: before/after hold the changed columns plus the keys (id and lookup columns; every column for a delete),
 * text longer than 1,000 characters is cut, a snapshot above 16 KB is dropped (truncated = true), attachment cells are
 * attachment ids (references, never file contents). Bulk deletes and imports list at most 1,000 row ids (row_count is
 * exact).
 */
import type { ColumnDef, TableDef } from '../../src/platform/contracts.ts'
import type { RawRow, SqlDb } from './contracts.ts'
import { currentEnvironment } from './env-context.ts'
import { currentWork } from './work-context.ts'
import { OUTBOX_CHANNEL } from './jobs.ts'
import { errText } from './util.ts'

export type OutboxOp = 'insert' | 'update' | 'delete' | 'import' | 'bulk'

export interface OutboxEntry {
  tableId: string
  op: OutboxOp
  rowId?: string | null
  rowIds?: string[]
  rowCount?: number
  changed?: string[] | null
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  actorId?: string | null
  details?: unknown
}

/** a committed outbox row, as consumers see it */
export interface OutboxEvent {
  id: number
  environmentId: string
  tableId: string
  op: OutboxOp
  rowId: string | null
  /** bulk / import: the row ids (at most 1,000; rowCount is exact) */
  rowIds: string[] | null
  rowCount: number
  changed: string[] | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  actorId: string | null
  correlationId: string | null
  requestId: string | null
  /** table-event depth of the work that made the change (0 = a person's request) */
  depth: number
  chain: string[]
  truncated: boolean
  details: unknown
  createdOn: string
}

export type OutboxListener = (e: OutboxEvent) => void

export const ROW_ID_CAP = 1000
const TEXT_CAP = 1000
const SNAPSHOT_CAP = 16 * 1024

type Row = Record<string, unknown>
const q = (id: string): string => `"${id}"`
const T = (t: string): string => `${q(currentEnvironment().schema)}.${q(t)}`

/** JSON-safe value of a cell for a snapshot */
function snapValue(v: RawRow[string] | undefined): { v: unknown; cut: boolean } {
  if (v === undefined || v === null) return { v: null, cut: false }
  if (v instanceof Date) return { v: Number.isNaN(v.getTime()) ? null : v.toISOString(), cut: false }
  if (typeof v === 'string' && v.length > TEXT_CAP) return { v: v.slice(0, TEXT_CAP), cut: true }
  return { v, cut: false }
}

/** keys of a table for snapshots: id and every lookup column */
export function keyColumns(def: TableDef): string[] {
  return ['id', ...def.columns.filter((c: ColumnDef) => c.type === 'lookup').map((c) => c.name)]
}

/** a capped snapshot of `columns` (plus the keys) of a row; null when it would be larger than 16 KB */
export function snapshot(def: TableDef, raw: RawRow, columns: Iterable<string> | 'all'): { value: Record<string, unknown> | null; truncated: boolean } {
  const names = columns === 'all' ? Object.keys(raw) : [...new Set([...keyColumns(def), ...columns])]
  const out: Record<string, unknown> = {}
  let truncated = false
  for (const n of names) {
    if (!(n in raw)) continue
    const s = snapValue(raw[n])
    out[n] = s.v
    if (s.cut) truncated = true
  }
  const size = JSON.stringify(out).length
  if (size > SNAPSHOT_CAP) return { value: null, truncated: true }
  return { value: out, truncated }
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString())

export function toOutboxEvent(r: Row, environmentId: string): OutboxEvent {
  return {
    id: Number(r.id), environmentId, tableId: String(r.table_id), op: String(r.op) as OutboxOp,
    rowId: r.row_id === null || r.row_id === undefined ? null : String(r.row_id),
    rowIds: Array.isArray(r.row_ids) ? (r.row_ids as unknown[]).map(String) : null,
    rowCount: Number(r.row_count) || 0,
    changed: Array.isArray(r.changed) ? (r.changed as unknown[]).map(String) : null,
    before: (r.before as Record<string, unknown> | null) ?? null,
    after: (r.after as Record<string, unknown> | null) ?? null,
    actorId: r.actor_id ? String(r.actor_id) : null,
    correlationId: r.correlation_id ? String(r.correlation_id) : null,
    requestId: r.request_id ? String(r.request_id) : null,
    depth: Number(r.depth) || 0,
    chain: Array.isArray(r.chain) ? (r.chain as unknown[]).map(String) : [],
    truncated: r.truncated === true,
    details: r.details ?? null,
    createdOn: iso(r.created_on),
  }
}

export type Outbox = ReturnType<typeof createOutbox>

export function createOutbox(deps: { db(): SqlDb | null; log(level: 'info' | 'warn' | 'error', msg: string): void }) {
  const listeners = new Set<OutboxListener>()
  const dispatching = new Map<string, Promise<number>>()

  const db = (): SqlDb => {
    const d = deps.db()
    if (!d) throw new Error('The database is not configured yet.')
    return d
  }

  /**
   * Writes one outbox row in the current environment, joining the caller's transaction. One statement: the per-table
   * advisory lock, the insert and the NOTIFY (delivered at commit).
   */
  async function write(e: OutboxEntry, truncated = false): Promise<number> {
    const env = currentEnvironment()
    const w = currentWork()
    const ids = e.rowIds ? e.rowIds.slice(0, ROW_ID_CAP) : null
    const rows = await db().query<Row>(
      `WITH l AS (SELECT pg_advisory_xact_lock(hashtext($1)) AS ok),
       ins AS (
         INSERT INTO ${T('ab_outbox')} (table_id, op, row_id, row_ids, row_count, changed, before, after, actor_id, correlation_id, request_id, depth, chain, truncated, details, created_on)
         SELECT $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14::jsonb, $15, $16::jsonb, clock_timestamp() FROM l
         RETURNING id)
       SELECT id, pg_notify($17, $18) AS n FROM ins`,
      [
        `ab.outbox:${env.schema}:${e.tableId}`, e.tableId, e.op, e.rowId ?? null, ids ? JSON.stringify(ids) : null,
        e.rowCount ?? (e.rowIds ? e.rowIds.length : 1), e.changed ? JSON.stringify(e.changed) : null,
        e.before ? JSON.stringify(e.before) : null, e.after ? JSON.stringify(e.after) : null, e.actorId ?? null,
        w.correlationId ?? null, w.requestId ?? null, Math.min(32767, w.depth), w.chain.length ? JSON.stringify(w.chain.slice(-32)) : null,
        truncated || (!!e.rowIds && e.rowIds.length > ROW_ID_CAP), e.details === undefined ? null : JSON.stringify(e.details),
        OUTBOX_CHANNEL, env.id,
      ],
    )
    return Number(rows[0]?.id ?? 0)
  }

  /**
   * Dispatches the pending rows of the current environment: `handle` runs inside the claiming transaction (it enqueues
   * jobs, which then exist exactly when the rows are marked dispatched); subscribers get the rows after the commit.
   * One dispatcher at a time per environment in this process; other processes skip the locked rows.
   */
  async function dispatch(handle: (events: OutboxEvent[]) => Promise<void>, limit = 500): Promise<number> {
    const envId = currentEnvironment().id
    const busy = dispatching.get(envId)
    if (busy) return busy
    const p = (async () => {
      let total = 0
      for (let round = 0; round < 20; round++) {
        let batch: OutboxEvent[] = []
        await db().tx(async (t) => {
          const rows = await t.query<Row>(`SELECT * FROM ${T('ab_outbox')} WHERE dispatched_on IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])
          if (!rows.length) return
          batch = rows.map((r) => toOutboxEvent(r, envId))
          await handle(batch)
          await t.exec(`UPDATE ${T('ab_outbox')} SET dispatched_on = now() WHERE id = ANY($1::bigint[])`, [batch.map((b) => b.id)])
        })
        if (!batch.length) break
        total += batch.length
        for (const ev of batch) {
          for (const fn of listeners) {
            try {
              fn(ev)
            } catch (e) {
              deps.log('warn', `outbox subscriber failed: ${errText(e)}`)
            }
          }
        }
        if (batch.length < limit) break
      }
      return total
    })().finally(() => dispatching.delete(envId))
    dispatching.set(envId, p)
    return p
  }

  /** committed rows of the current environment after `afterId` (catch-up), oldest first */
  async function read(afterId: number, limit = 500, tableId?: string): Promise<OutboxEvent[]> {
    const envId = currentEnvironment().id
    const n = Math.max(1, Math.min(5000, Math.trunc(limit)))
    const rows = tableId
      ? await db().query<Row>(`SELECT * FROM ${T('ab_outbox')} WHERE id > $1 AND table_id = $2 AND dispatched_on IS NOT NULL ORDER BY id LIMIT ${n}`, [afterId, tableId])
      : await db().query<Row>(`SELECT * FROM ${T('ab_outbox')} WHERE id > $1 AND dispatched_on IS NOT NULL ORDER BY id LIMIT ${n}`, [afterId])
    return rows.map((r) => toOutboxEvent(r, envId))
  }

  /** dispatched rows older than `days` */
  async function purge(days: number): Promise<number> {
    return (await db().exec(`DELETE FROM ${T('ab_outbox')} WHERE dispatched_on IS NOT NULL AND created_on < now() - make_interval(days => $1)`, [Math.max(1, Math.trunc(days))])).affectedRows
  }

  return {
    write,
    dispatch,
    read,
    purge,
    /**
     * Committed, dispatched data changes of every environment, in id order per environment (so in commit order per
     * table). Called synchronously after the dispatching transaction commits; keep the listener fast (queue work).
     * Returns the unsubscribe function.
     */
    subscribe(fn: OutboxListener): () => void {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
}
