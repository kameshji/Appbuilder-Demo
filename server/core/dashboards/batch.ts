/**
 * The dashboard batch runner (P2-C, docs/dev/dashboards.md "Storage and API"): every plan through the DataService's
 * queryV2 AS THE GIVEN IDENTITY (row scope, row rules, shares and column security in the statement), at most
 * QUERY_CONCURRENCY at a time, each with its own statement timeout; one tile's failure (403 hidden column, 422, 503
 * timeout) is that tile's result, not the batch's. Results are cached for CACHE_TTL_MS per environment + user + the
 * identity's row predicate and visible columns on the table + plan, and dropped when the table changes (the live change
 * feed). Used by POST /dashboards/query (the caller), the view-token endpoint (the token's "view as" identity) and
 * scheduled snapshots (each recipient).
 */
import { createHash } from 'node:crypto'
import type { CoreServices } from '../services.ts'
import type { UserContext } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import type { TableDef } from '../../../src/platform/contracts.ts'
import type { ConditionV2, QueryV2Response } from '../../../src/platform/query.ts'
import { currentEnvironment } from '../env-context.ts'
import { hasAnyTableAccess } from '../security.ts'
import { onTableChange } from '../live/changes.ts'
import { errText, log } from '../util.ts'

export const QUERY_CONCURRENCY = 4
export const MAX_BATCH = 40
export const CACHE_TTL_MS = 20_000
const CACHE_MAX = 2000
/** default statement timeout of a tile (ms); the server's own limit (15 s) still caps it */
export const TILE_TIMEOUT_MS = 10_000

export interface BatchResult {
  id: string
  ok: boolean
  rows?: QueryV2Response['rows']
  count?: number
  truncated?: boolean
  /** the caller's row rules restrict this table: "based on the rows you can see" */
  filtered?: boolean
  cached?: boolean
  ms: number
  error?: { status: number; code: string; message: string }
}

interface Entry { at: number; env: string; tables: string[]; value: BatchResult }
const cache = new Map<string, Entry>()
let cacheHits = 0
let cacheMisses = 0
let listening = false

function listen(): void {
  if (listening) return
  listening = true
  onTableChange((env, tableId) => {
    for (const [k, e] of cache) if (e.env === env && e.tables.includes(tableId)) cache.delete(k)
  })
}

export function cacheStats(): { size: number; hits: number; misses: number } { return { size: cache.size, hits: cacheHits, misses: cacheMisses } }
export function clearDashboardCache(): void { cache.clear() }

function viaTables(c: ConditionV2 | undefined, out: Set<string>): void {
  if (!c) return
  if ('and' in c) c.and.forEach((x) => viaTables(x, out))
  else if ('or' in c) c.or.forEach((x) => viaTables(x, out))
  else if ('not' in c) viaTables(c.not, out)
  else if ('via' in c) { out.add(c.via.table.toLowerCase()); viaTables(c.via.where, out) }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** runs a batch of plans as `who` (shared by the route, the view-token endpoint, snapshots and the exit check) */
export async function runBatch(services: CoreServices, who: UserContext, queries: { id: string; plan: unknown }[], o: { timeoutMs?: number; noCache?: boolean } = {}): Promise<BatchResult[]> {
  listen()
  const env = currentEnvironment().id
  const all = await services.meta.tables.list()
  const find = (name: string) => all.find((t) => t.id === name) ?? all.find((t) => t.name.toLowerCase() === name.toLowerCase())
  return pool(queries, QUERY_CONCURRENCY, async (q): Promise<BatchResult> => {
    const t0 = Date.now()
    try {
      if (!isObj(q.plan)) throw new HttpError(422, 'invalid', 'Each query needs a plan.')
      const name = q.plan.table
      const t: TableDef | undefined = typeof name === 'string' ? find(name) : undefined
      if (!t || (!who.privileges.isMaker && !hasAnyTableAccess(who, t))) throw new HttpError(404, 'not-found', `Table "${String(name).slice(0, 64)}" does not exist.`)
      const pred = who.rowPredicate(t, 'read')
      const filtered = !('const' in pred && pred.const === true)
      const tables = new Set<string>([t.id])
      const via = new Set<string>()
      viaTables(q.plan.filter as ConditionV2 | undefined, via)
      for (const v of via) { const vt = find(v); if (vt) tables.add(vt.id) }
      const key = createHash('sha256').update(JSON.stringify([env, who.user.id, t.id, pred, who.visibleDef(t).columns.map((c) => c.name), q.plan])).digest('base64url')
      const hit = !o.noCache ? cache.get(key) : undefined
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        cacheHits++
        return { ...hit.value, id: q.id, cached: true, ms: Date.now() - t0 }
      }
      cacheMisses++
      const res = await services.data.queryV2(who, t, q.plan, { timeoutMs: o.timeoutMs ?? TILE_TIMEOUT_MS })
      const value: BatchResult = { id: q.id, ok: true, rows: res.rows, ...(res.count !== undefined ? { count: res.count } : {}), ...(res.truncated ? { truncated: true } : {}), ...(filtered ? { filtered: true } : {}), ms: Date.now() - t0 }
      if (!o.noCache) {
        cache.set(key, { at: Date.now(), env, tables: [...tables], value })
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
      }
      return value
    } catch (e) {
      const he = e instanceof HttpError ? e : null
      if (!he) log('warn', `dashboard query ${q.id} failed: ${errText(e)}`)
      return { id: q.id, ok: false, ms: Date.now() - t0, error: he ? { status: he.status, code: he.code, message: he.message } : { status: 500, code: 'storage', message: 'The query failed on the server.' } }
    }
  })
}
