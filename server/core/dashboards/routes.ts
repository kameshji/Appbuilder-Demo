/**
 * Dashboards (P2-C, docs/dev/dashboards.md): stored definitions and the per-dashboard batch query endpoint.
 *
 *   GET    /dashboards                 the dashboards I may view (owner, a viewer role, makers and administrators)
 *   GET    /dashboards/:id
 *   POST   /dashboards                 makers: { name?, def, roles? }               (design route: locked production refuses)
 *   PATCH  /dashboards/:id             owner or administrator
 *   DELETE /dashboards/:id             owner or administrator
 *   GET    /dashboards/settings        environment defaults (locale, currency, time zone, fiscal year, week, shifts)
 *   PUT    /dashboards/settings        administrators
 *   POST   /dashboards/query           { queries: [{ id, plan }], timeoutMs? } -> { results: [...] }
 *
 * The batch runs every plan through the DataService's queryV2 AS THE CALLER (row scope, row rules, shares and column
 * security in the statement), at most QUERY_CONCURRENCY at a time, each with its own statement timeout; one tile's
 * failure (403 hidden column, 422, 503 timeout) is that tile's result, not the batch's. Results are cached for
 * CACHE_TTL_MS per environment + user + the caller's row predicate and visible columns on the table + plan, and dropped
 * when the table changes (the live change feed); the answer says which results came from the cache.
 */
import { createHash } from 'node:crypto'
import type { ApiRouter } from '../router.ts'
import type { CoreServices } from '../services.ts'
import type { Ctx, UserContext } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import type { TableDef } from '../../../src/platform/contracts.ts'
import type { ConditionV2, QueryV2Response } from '../../../src/platform/query.ts'
import { checkDashboardDef } from '../../../src/dashboards/types.ts'
import type { DashboardDef, DashboardInfo } from '../../../src/dashboards/types.ts'
import { DEFAULT_CALENDAR } from '../../../src/dashboards/dates.ts'
import type { CalendarSettings } from '../../../src/dashboards/dates.ts'
import { DEFAULT_FORMAT } from '../../../src/charts/format.ts'
import { isTimeZone } from '../../../src/fx/query/buckets.ts'
import { currentEnvironment } from '../env-context.ts'
import { hasAnyTableAccess } from '../security.ts'
import { onTableChange } from '../live/changes.ts'
import { errText, log, rowUid } from '../util.ts'

export const QUERY_CONCURRENCY = 4
export const MAX_BATCH = 40
export const CACHE_TTL_MS = 20_000
const CACHE_MAX = 2000
/** default statement timeout of a tile (ms); the server's own limit (15 s) still caps it */
export const TILE_TIMEOUT_MS = 10_000

export interface DashboardSettings extends CalendarSettings { locale: string; currency: string }
export const DEFAULT_SETTINGS: DashboardSettings = { ...DEFAULT_CALENDAR, locale: DEFAULT_FORMAT.locale, currency: DEFAULT_FORMAT.currency }

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

/* ------------------------------------------------------------------ cache */

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

/** runs a batch of plans as `who` (shared by the route and the exit check) */
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

/* ------------------------------------------------------------------ storage */

const T = (t: string) => `"${currentEnvironment().schema}"."${t}"`

function canView(who: UserContext, r: { owner_id: string; roles: string[] }): boolean {
  return who.privileges.isAdmin || who.privileges.isMaker || r.owner_id === who.user.id || r.roles.some((id) => who.roles.some((x) => x.id === id))
}
const canEdit = (who: UserContext, r: { owner_id: string }) => who.privileges.isAdmin || (who.privileges.isMaker && r.owner_id === who.user.id)

function toInfo(r: Record<string, unknown>, who: UserContext): DashboardInfo {
  return {
    id: String(r.id), name: String(r.name), def: r.def as DashboardDef, ownerId: String(r.owner_id), roles: (r.roles as string[]) ?? [],
    modifiedOn: new Date(r.modified_on as string).toISOString(), canEdit: canEdit(who, r as { owner_id: string }),
  }
}

function parseSettings(raw: unknown): DashboardSettings {
  const o = isObj(raw) ? raw : {}
  const s: DashboardSettings = { ...DEFAULT_SETTINGS }
  if (typeof o.locale === 'string' && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(o.locale)) s.locale = o.locale
  if (typeof o.currency === 'string' && /^[A-Za-z]{3}$/.test(o.currency)) s.currency = o.currency.toUpperCase()
  if (isTimeZone(o.timeZone)) s.timeZone = o.timeZone
  if (Number.isInteger(o.fiscalYearStart) && (o.fiscalYearStart as number) >= 1 && (o.fiscalYearStart as number) <= 12) s.fiscalYearStart = o.fiscalYearStart as number
  if (o.weekStart === 1 || o.weekStart === 7) s.weekStart = o.weekStart
  if (Array.isArray(o.shifts)) {
    const hm = /^([01]\d|2[0-3]):[0-5]\d$/
    s.shifts = o.shifts.filter(isObj).slice(0, 6).map((x) => ({ name: String(x.name ?? '').slice(0, 20), start: String(x.start ?? ''), end: String(x.end ?? '') })).filter((x) => x.name && hm.test(x.start) && hm.test(x.end))
  }
  return s
}

export function dashboardRoutes(router: ApiRouter, services: CoreServices): void {
  const db = () => {
    const d = services.state.db
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }
  const audit = async (ctx: Ctx, action: string, details: unknown) => {
    try { await services.meta.audit({ userId: ctx.user?.user.id ?? null, action, details }) } catch (e) { log('error', `audit write failed (${action}): ${errText(e)}`) }
  }
  const row = async (id: string) => (await db().query<Record<string, unknown>>(`SELECT * FROM ${T('ab_dashboards')} WHERE id = $1`, [id]))[0] ?? null
  const roleList = async (raw: unknown): Promise<string[]> => {
    if (raw === undefined) return []
    if (!Array.isArray(raw)) throw new HttpError(422, 'invalid', 'roles is a list of role ids.', 'roles')
    const known = new Set((await services.meta.roles.list()).map((r) => r.id))
    const ids = [...new Set(raw.map(String))].slice(0, 100)
    for (const id of ids) if (!known.has(id)) throw new HttpError(422, 'invalid', `There is no role "${id.slice(0, 64)}".`, 'roles')
    return ids
  }
  const defOf = (raw: unknown): DashboardDef => {
    try { return checkDashboardDef(raw) } catch (e) { throw new HttpError(422, 'invalid', (e as Error).message, 'def') }
  }

  router.add('GET', '/dashboards', async (ctx) => {
    const rows = await db().query<Record<string, unknown>>(`SELECT * FROM ${T('ab_dashboards')} ORDER BY lower(name), id`)
    return { items: rows.filter((r) => canView(ctx.user!, r as never)).map((r) => toInfo(r, ctx.user!)) }
  }, { auth: 'user' })

  router.add('GET', '/dashboards/settings', async () => {
    const rows = await db().query<{ v: unknown }>(`SELECT v FROM ${T('ab_dashboard_settings')} WHERE k = 'defaults'`)
    return { settings: parseSettings(rows[0]?.v) }
  }, { auth: 'user' })

  router.add('PUT', '/dashboards/settings', async (ctx) => {
    if (!ctx.user!.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only administrators can change the dashboard settings.')
    const s = parseSettings(isObj(ctx.body) ? ctx.body.settings ?? ctx.body : {})
    await db().exec(`INSERT INTO ${T('ab_dashboard_settings')} (k, v) VALUES ('defaults', $1::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [JSON.stringify(s)])
    await audit(ctx, 'dashboard.settings', s)
    return { settings: s }
  }, { auth: 'user', design: true })

  router.add('POST', '/dashboards/query', async (ctx) => {
    const b = isObj(ctx.body) ? ctx.body : {}
    if (!Array.isArray(b.queries) || !b.queries.length || b.queries.length > MAX_BATCH) throw new HttpError(422, 'invalid', `queries is a list of 1 to ${MAX_BATCH} { id, plan }.`, 'queries')
    const queries = (b.queries as unknown[]).map((q, i) => {
      const o = isObj(q) ? q : {}
      return { id: typeof o.id === 'string' && o.id.length <= 80 ? o.id : `q${i}`, plan: o.plan }
    })
    const timeoutMs = typeof b.timeoutMs === 'number' && b.timeoutMs >= 500 ? Math.min(b.timeoutMs, TILE_TIMEOUT_MS) : undefined
    const t0 = Date.now()
    const results = await runBatch(services, ctx.user!, queries, { timeoutMs })
    return { results, ms: Date.now() - t0 }
  }, { auth: 'user' })

  router.add('GET', '/dashboards/:id', async (ctx) => {
    const r = await row(ctx.params.id)
    if (!r || !canView(ctx.user!, r as never)) throw new HttpError(404, 'not-found', 'Dashboard not found.')
    return toInfo(r, ctx.user!)
  }, { auth: 'user' })

  router.add('POST', '/dashboards', async (ctx) => {
    const who = ctx.user!
    if (!who.privileges.isMaker && !who.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only makers and administrators can create dashboards.')
    const b = isObj(ctx.body) ? ctx.body : {}
    const def = defOf(b.def)
    const roles = await roleList(b.roles)
    const id = `dsh_${rowUid().replace(/-/g, '').slice(-16)}`
    const name = String(b.name ?? def.title).trim().slice(0, 200) || def.title
    await db().exec(`INSERT INTO ${T('ab_dashboards')} (id, name, owner_id, roles, def, created_on, modified_on) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, now(), now())`, [id, name, who.user.id, JSON.stringify(roles), JSON.stringify(def)])
    await audit(ctx, 'dashboard.create', { id, name, roles })
    return toInfo((await row(id))!, who)
  }, { auth: 'user', design: true })

  router.add('PATCH', '/dashboards/:id', async (ctx) => {
    const who = ctx.user!
    const r = await row(ctx.params.id)
    if (!r || !canView(who, r as never)) throw new HttpError(404, 'not-found', 'Dashboard not found.')
    if (!canEdit(who, r as never)) throw new HttpError(403, 'denied', 'Only the owner and administrators can change this dashboard.')
    const b = isObj(ctx.body) ? ctx.body : {}
    const def = b.def !== undefined ? defOf(b.def) : (r.def as DashboardDef)
    const roles = b.roles !== undefined ? await roleList(b.roles) : (r.roles as string[])
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 200) : String(r.name)
    await db().exec(`UPDATE ${T('ab_dashboards')} SET name = $2, def = $3::jsonb, roles = $4::jsonb, modified_on = now() WHERE id = $1`, [r.id, name, JSON.stringify(def), JSON.stringify(roles)])
    await audit(ctx, 'dashboard.update', { id: r.id, name, roles })
    return toInfo((await row(String(r.id)))!, who)
  }, { auth: 'user', design: true })

  router.add('DELETE', '/dashboards/:id', async (ctx) => {
    const who = ctx.user!
    const r = await row(ctx.params.id)
    if (!r || !canView(who, r as never)) throw new HttpError(404, 'not-found', 'Dashboard not found.')
    if (!canEdit(who, r as never)) throw new HttpError(403, 'denied', 'Only the owner and administrators can delete this dashboard.')
    await db().exec(`DELETE FROM ${T('ab_dashboards')} WHERE id = $1`, [r.id])
    await audit(ctx, 'dashboard.delete', { id: r.id, name: r.name })
    return { ok: true }
  }, { auth: 'user', design: true })
}
