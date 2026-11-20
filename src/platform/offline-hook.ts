/**
 * The seam between the server-mode platform (remote.ts) and the offline entry outbox of the phone experience
 * (P2-A, src/phone/offline, docs/dev/phone.md). remote.ts only calls these functions; with no hook registered (demo
 * mode, tests, an install that never opens an offline app) everything behaves exactly as before.
 *
 *  - Writes: before sending a create / update / attachment upload, remote.ts asks `divert(table, rowId)` (we are offline,
 *    or an earlier write of the same row still waits in the outbox: keep the order); after a network failure it asks
 *    `accepts(table)`. A queued write keeps its optimistic row in the cache; `done` / `fail` settle it when the outbox
 *    sends it in this session (after a restart the outbox sends it and the cache refetches).
 *  - Reads: answers of queries and whole-table loads over tables of offline apps are given to `storeAnswer`; when the
 *    server cannot be reached, `cachedAnswer` may answer instead (the last answer this device stored).
 *  - `noteNetwork(ok)`: every request tells whether the server answered (the connectivity banner, the outbox replay).
 */
import type { QueryValue } from './http'
import type { ColumnType, TableDef } from './contracts'
import type { QueryPlan, QueryV2Response } from './query'
import { resultTypes, rowsFromWire } from './query-wire'
import { schemaInfoOf } from './query-local'
import { executePlan } from '../fx/query/reference.ts'

export interface QueuedWrite {
  kind: 'create' | 'update' | 'upload'
  table: string
  rowId: string
  /** create: the column values sent (JSON-safe wire values); update: the changes */
  values?: Record<string, QueryValue>
  /** update: the version the change was made from (409 when the row changed on the server since) */
  ifModifiedOn?: string
  /** upload: the column and the file */
  column?: string
  file?: Blob
  fileName?: string
}

export interface QueueCallbacks {
  /** sent: the server's answer (RowResponse for rows, AttachmentRef for uploads) */
  done(result: unknown): void
  /** refused by the server (validation, permission, conflict): the outbox keeps the item for "fix and resend" */
  fail(error: unknown): void
}

export interface OfflineHook {
  divert(table: string, rowId: string): boolean
  accepts(table: string): boolean
  queue(write: QueuedWrite, callbacks: QueueCallbacks): void
  storeAnswer(key: string, table: string, answer: unknown): void
  cachedAnswer(key: string, table: string): Promise<unknown | undefined>
  /**
   * The rows of a table kept on the device for offline use ("available offline", wire format, downloaded as the
   * signed-in user), or undefined. `partial`: the row cap or the offline filter left rows out.
   */
  snapshot?(table: string): Promise<Snapshot | undefined>
  noteNetwork(ok: boolean): void
}

export interface Snapshot {
  rows: Record<string, QueryValue>[]
  partial: boolean
}

let hook: OfflineHook | null = null

export function setOfflineHook(h: OfflineHook | null): void {
  hook = h
}
export const offlineHook = (): OfflineHook | null => hook

/** a PlatformError raised because no answer came back at all (no network, server down, DNS, TLS) */
export function isNetworkError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { network?: unknown }).network === true
}

/** cache key of a read: the method, path and body (plans serialise deterministically: they are built in one order) */
export function readKey(path: string, body: unknown): string {
  return `${path} ${JSON.stringify(body ?? null)}`
}

/** reads that change nothing on the server and may be retried after a network failure */
export function isIdempotentRead(method: string, path: string): boolean {
  if (method === 'GET') return true
  return method === 'POST' && (path === '/query' || /^\/data\/[^/]+\/query$/.test(path) || path === '/attachments/resolve')
}

/* ------------------------------------------------------------------ answers from the rows kept on the device */

const pad2 = (n: number) => String(n).padStart(2, '0')
function toWire(v: unknown, type: ColumnType | undefined): QueryValue {
  if (v instanceof Date) return type === 'date' ? `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}` : v.toISOString()
  if (v === undefined) return null
  return v as QueryValue
}

/**
 * Answer a Query v2 plan from the rows kept on the device (offline, "available offline" tables): the reference
 * executor (src/fx/query/reference.ts, the same one demo mode uses) over the kept rows, converted back to the wire
 * format the server sends, so the query cache treats it like a server answer. `partial` marks the answer `truncated`
 * (the row cap or the offline filter left rows out: counts and searches cover only the kept rows). Returns undefined
 * when the plan cannot run here (the caller then fails as before: "Could not reach the server").
 */
export function answerFromSnapshot(plan: QueryPlan, snap: Snapshot, def: TableDef): QueryV2Response | undefined {
  try {
    const types: Record<string, ColumnType> = { id: 'text' }
    for (const c of def.columns) types[c.name] = c.type
    const fx = rowsFromWire({ version: 2, table: plan.table }, snap.rows, types)
    const res = executePlan(plan, fx, schemaInfoOf(def))
    const outTypes = resultTypes(plan, types)
    const rows = res.rows.map((r) => {
      const o: Record<string, QueryValue> = {}
      for (const [k, v] of Object.entries(r)) {
        if (k === '__id') {
          o.id = v as QueryValue
          continue
        }
        o[k] = toWire(v, outTypes[k])
      }
      return o
    })
    return { rows, ...(res.count !== undefined ? { count: res.count } : {}), ...(plan.page ? { nextCursor: res.nextCursor ?? null } : {}), ...(snap.partial ? { truncated: true } : {}) }
  } catch {
    return undefined
  }
}

/** delay before retry n (1, 2, ...) of an idempotent read: 400 ms, 1.2 s, 3.6 s with up to 25 % jitter */
export function backoffMs(n: number, random: () => number = Math.random): number {
  const base = 400 * 3 ** (n - 1)
  return Math.round(base * (1 + 0.25 * random()))
}
