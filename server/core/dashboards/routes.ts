/**
 * Dashboards (P2-C, docs/dev/dashboards.md): stored definitions and the per-dashboard batch query endpoint.
 *
 *   GET    /dashboards                 the dashboards I may view (owner, a viewer role, makers and administrators)
 *   GET    /dashboards/:id
 *   POST   /dashboards                 makers: { name?, def, roles? }               (design route: locked production refuses)
 *   PATCH  /dashboards/:id             owner or administrator
 *   DELETE /dashboards/:id             owner or administrator (its view tokens and snapshots go with it)
 *   GET    /dashboards/settings        environment defaults (locale, currency, time zone, fiscal year, week, shifts)
 *   PUT    /dashboards/settings        administrators
 *   POST   /dashboards/query           { queries: [{ id, plan }], timeoutMs? } -> { results: [...] }
 *
 * Second wave: view tokens (tokens.ts: management and the two token-only routes /dashboards/kiosk...) and scheduled
 * snapshots (snapshots.ts); personal pinned tiles, GET / PUT /dashboards/pins (pins.ts). The batch runner and its cache are in batch.ts, who may view / edit and the server-side
 * compute of a stored definition in compute.ts.
 */
import type { ApiRouter } from '../router.ts'
import type { CoreServices } from '../services.ts'
import type { Ctx, UserContext } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import { checkDashboardDef } from '../../../src/dashboards/types.ts'
import type { DashboardDef, DashboardInfo } from '../../../src/dashboards/types.ts'
import { currentEnvironment } from '../env-context.ts'
import { errText, log, rowUid } from '../util.ts'
import { MAX_BATCH, TILE_TIMEOUT_MS, runBatch } from './batch.ts'
import { canEdit, canView, parseSettings } from './compute.ts'
import { removeDashboardTokens, tokenRoutes } from './tokens.ts'
import { createSnapshots, removeDashboardSnapshots, snapshotRoutes } from './snapshots.ts'
import { pinRoutes } from './pins.ts'

export { CACHE_TTL_MS, MAX_BATCH, QUERY_CONCURRENCY, TILE_TIMEOUT_MS, cacheStats, clearDashboardCache, runBatch } from './batch.ts'
export type { BatchResult } from './batch.ts'
export { DEFAULT_SETTINGS } from './compute.ts'
export type { DashboardSettings } from './compute.ts'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/* ------------------------------------------------------------------ storage */

const T = (t: string) => `"${currentEnvironment().schema}"."${t}"`

function toInfo(r: Record<string, unknown>, who: UserContext): DashboardInfo {
  return {
    id: String(r.id), name: String(r.name), def: r.def as DashboardDef, ownerId: String(r.owner_id), roles: (r.roles as string[]) ?? [],
    modifiedOn: new Date(r.modified_on as string).toISOString(), canEdit: canEdit(who, r as { owner_id: string }),
  }
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
    const id = String(r.id)
    const out = await services.transaction(async () => {
      const tokens = await removeDashboardTokens(db(), id)
      const snapshots = await removeDashboardSnapshots(services, db(), id)
      await db().exec(`DELETE FROM ${T('ab_dashboards')} WHERE id = $1`, [id])
      return { tokens, snapshots }
    })
    await audit(ctx, 'dashboard.delete', { id, name: r.name, ...out })
    return { ok: true }
  }, { auth: 'user', design: true })

  // second wave: view tokens (management and the two token-only routes) and scheduled snapshots
  tokenRoutes(router, services)
  snapshotRoutes(router, services, createSnapshots(services))
  // personal pinned tiles (the caller's own list in ab.user_settings)
  pinRoutes(router, services)
}
