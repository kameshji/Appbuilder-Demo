/**
 * Recycle bin for deleted rows (docs/dev/recycle-bin.md), the browser side: shapes of the server API, the remote
 * implementation, and the batch logic demo mode uses in memory (one delete operation = one batch: the rows it deleted,
 * cascaded rows, the lookup values set blank; undo = the batch in reverse).
 */
import type { TableDef } from './contracts.ts'

export type DeleteSource = 'user' | 'flow' | 'event' | 'import' | 'api' | 'system'

export interface RecycleBatch {
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
  state: 'deleted' | 'partial' | 'restored' | 'purged'
  /** rows of tables without a recycle bin that the delete removed for good */
  finalRows: number
}

/** what the Deleted view shows about a row (the row's own columns come as in any query) */
export interface DeletedInfo {
  on: string
  by: string | null
  byName: string | null
  batch: string
  expiresOn: string | null
  daysLeft: number
  rootTable: string
  rootTableName: string
  /** deleted because a row of another table was deleted (cascade) */
  cascaded: boolean
  batchRows: number
  source: DeleteSource
}

export type DeletedRow = Record<string, unknown> & { id: string; __deleted: DeletedInfo }

export interface RestoreResult {
  restored: number
  batch: string
  tables: { tableId: string; rows: number }[]
  warnings: string[]
}

export interface RecycleStats { enabled: boolean; keepDays: number; deletedRows?: number; bytes?: number; batches?: number }

/** a delete that kept its rows: what an "Undo" needs */
export interface DeletedEvent { table: string; tableId: string; batch: RecycleBatch; keepDays: number }

export interface RecycleApi {
  /** a delete in this session kept its rows (the app's Undo toast listens). Returns unsubscribe. */
  onDeleted(listener: (e: DeletedEvent) => void): () => void
  /** the recycle bins of these tables changed in this session (delete, restore, purge): ids or names. Returns unsubscribe. */
  onChange(listener: (tables: string[]) => void): () => void
  /** the Deleted view of a table: rows the signed-in user could delete and can see (administrators: all), newest first */
  list(table: string, opts?: { limit?: number; skip?: number; batch?: string }): Promise<{ rows: DeletedRow[]; total: number; batches: RecycleBatch[] }>
  /** undo a batch (the whole delete operation), or one row of it; table null: the batch's own table */
  restore(table: string | null, what: { batch?: string; rowId?: string }): Promise<RestoreResult>
  /** administrators: delete for good now (one batch, or the whole bin of the table with the table name typed) */
  purge(table: string, what: { batch: string } | { all: true; confirm: string }): Promise<{ rows: number; batches?: number }>
  /** the table's setting and, for makers and administrators, how many deleted rows it holds and their size */
  stats(table: string): Promise<RecycleStats>
}

/** can this table keep deleted rows at all (what the table designer offers)? null: yes; else the reason it cannot */
export function recycleUnavailable(def: TableDef): string | null {
  if ((def.connectionId ?? 'conn_default') !== 'conn_default') return 'Tables in other connections (MySQL, your own PostgreSQL databases, data files, Google Sheets) delete rows for good.'
  if (def.reporting) return 'Reporting views, summary tables and date dimensions have no recycle bin.'
  if (def.readOnly) return 'A read-only table has no recycle bin.'
  if (def.system && !['sys_activities', 'sys_comments', 'sys_documents'].includes(def.id)) return 'This system table has no recycle bin.'
  return null
}

/** "in 3 days", "today" */
export function daysLeftText(n: number): string {
  if (n <= 0) return 'today'
  return n === 1 ? '1 day' : `${n} days`
}

/** how long an app's Undo toast stays (seconds) */
export const UNDO_SECONDS = 10

/* ------------------------------------------------------------------ remote */

type Call = <T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, opts?: { json?: unknown; query?: Record<string, string | undefined> }) => Promise<T>

export function remoteRecycle(call: Call, hooks: { invalidate(tableIds: string[]): void }) {
  const listeners = new Set<(e: DeletedEvent) => void>()
  const changeListeners = new Set<(tables: string[]) => void>()
  const changed = (tables: string[]) => { for (const l of changeListeners) l(tables) }
  const enc = encodeURIComponent
  const api: RecycleApi = {
    onDeleted(l) {
      listeners.add(l)
      return () => { listeners.delete(l) }
    },
    onChange(l) {
      changeListeners.add(l)
      return () => { changeListeners.delete(l) }
    },
    list: (table, o = {}) => {
      const q: Record<string, string> = {}
      if (o.limit !== undefined) q.limit = String(o.limit)
      if (o.skip !== undefined) q.skip = String(o.skip)
      if (o.batch) q.batch = o.batch
      return call('GET', `/data/${enc(table)}/deleted`, { query: q })
    },
    async restore(table, what) {
      const r = await call<RestoreResult>('POST', table ? `/data/${enc(table)}/restore` : '/recycle/restore', { json: what })
      hooks.invalidate(r.tables.map((t) => t.tableId))
      changed([...r.tables.map((t) => t.tableId), ...(table ? [table] : [])])
      return r
    },
    async purge(table, what) {
      const r = await call<{ rows: number; batches?: number }>('POST', `/data/${enc(table)}/purge`, { json: what })
      changed([table])
      return r
    },
    stats: (table) => call('GET', `/data/${enc(table)}/recycle`),
  }
  return { api, emit: (e: DeletedEvent) => { for (const l of listeners) l(e); changed([e.table, e.tableId]) } }
}

/* ------------------------------------------------------------------ demo mode: the same batches in memory */

export interface DemoEffect { kind: 'row' | 'setBlank'; table: string; id: string; column?: string; old?: unknown; row?: Record<string, unknown> }
export interface DemoBatch { info: RecycleBatch; effects: DemoEffect[] }

/**
 * Demo mode keeps deleted rows of tables with recycleDays in memory (not in the CSV files: a reload empties the bin),
 * recording one batch per delete like the server. Restore = the batch's effects in reverse: rows back (refused when
 * their unique values are used again), set-blank values back where still blank.
 */
export function createDemoRecycleLog(now: () => Date) {
  const batches = new Map<string, DemoBatch>()
  let seq = 0
  return {
    begin(table: TableDef, by: { id: string; name: string } | null): DemoBatch {
      const at = now()
      const days = Math.max(1, table.recycleDays ?? 30)
      const b: DemoBatch = {
        info: {
          id: `del_demo_${at.getTime().toString(36)}_${++seq}`, tableId: table.id, tableName: table.displayName || table.name, rows: 0, rootIds: [], deletedBy: by?.id ?? null, deletedByName: by?.name ?? null,
          deletedOn: at.toISOString(), expiresOn: new Date(at.getTime() + days * 86_400_000).toISOString(), daysLeft: days, source: 'user', state: 'deleted', finalRows: 0,
        },
        effects: [],
      }
      return b
    },
    commit(b: DemoBatch): void {
      b.info.rows = b.effects.filter((e) => e.kind === 'row').length
      if (b.info.rows) batches.set(b.info.id, b)
    },
    get: (id: string) => batches.get(id) ?? null,
    /** open batches holding rows of a table */
    forTable: (tableId: string) => [...batches.values()].filter((b) => b.info.state === 'deleted' && b.effects.some((e) => e.kind === 'row' && e.table === tableId)),
    drop: (id: string) => batches.delete(id),
    all: () => [...batches.values()],
  }
}
export type DemoRecycleLog = ReturnType<typeof createDemoRecycleLog>
