/**
 * TV / kiosk view tokens of a dashboard (P2-C second wave; docs/dev/dashboards.md "View tokens", docs/admin/dashboards.md).
 *
 * A token is `abv.<environment>.<8-character prefix>.<43-character secret>` (256 random bits). It is shown once; the server
 * keeps SHA-256 of the whole text (the prefix identifies the row). Each token is bound at creation to ONE dashboard and to
 * a "view as" identity chosen explicitly: the person who creates it (default), or a service account picked by an
 * administrator (audited as dashboard.token.run_as_service). A request with `Authorization: Bearer <token>` may do two
 * things only:
 *
 *   GET  /dashboards/kiosk          the dashboard's definition, the environment's dashboard settings
 *   POST /dashboards/kiosk/query    { dashboardId?, range?, filters?, cross? } -> the batch answers of THAT dashboard
 *
 * The server compiles the plans itself from the stored definition (compute.ts); a request that brings plans is refused.
 * Every plan runs through the same row and column security as the "view as" identity, checked again on every request:
 * revoked, expired, a disabled or removed identity, an identity without access to the environment or that can no longer
 * open the dashboard all stop the token. Cookies are ignored (no CSRF header needed: a browser never sends a bearer token
 * on its own). Per token at most RATE_PER_MINUTE requests; per address at most FAIL_LIMIT invalid tokens in 5 minutes.
 *
 * Management (owner of the dashboard while a maker, or an administrator; audited):
 *   GET    /dashboards/:id/tokens              the tokens (never the secret)
 *   POST   /dashboards/:id/tokens              { label, expiresOn?, viewAs? }  -> the token once
 *   DELETE /dashboards/:id/tokens/:tokenId     revoke (at once)
 */
import { randomBytes } from 'node:crypto'
import type { ApiRouter } from '../router.ts'
import type { CoreServices } from '../services.ts'
import type { Ctx, SqlDb, UserContext } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import { currentEnvironment, runInEnvironment } from '../env-context.ts'
import { toUserDef } from '../auth.ts'
import { identity } from '../identity/index.ts'
import { sameHash, sha256 } from '../identity/util.ts'
import { errText, log, rowUid } from '../util.ts'
import { canEdit, canView, checkChoices, computeDashboard, dashboardRow, loadSettings, type DashboardRow } from './compute.ts'

export const VIEW_TOKEN_PREFIX = 'abv'
export const RATE_PER_MINUTE = 120
export const MAX_TOKENS_PER_DASHBOARD = 20
const FAIL_LIMIT = 30
const FAIL_WINDOW_MS = 5 * 60_000
const TOKEN_RE = /^abv\.([a-z][a-z0-9_]{0,39})\.([A-Za-z0-9]{8})\.([A-Za-z0-9_-]{43})$/
const INVALID = 'The view token is not valid (unknown, revoked or expired).'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const T = (t: string) => `"${currentEnvironment().schema}"."${t}"`
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null)

export interface ViewTokenInfo {
  id: string
  dashboardId: string
  label: string
  /** the public part (shown in lists to tell tokens apart) */
  prefix: string
  viewAs: { kind: 'creator' | 'service'; userId: string; name: string | null }
  createdBy: string
  createdOn: string
  expiresOn: string | null
  lastUsedOn: string | null
  revokedOn: string | null
  status: 'active' | 'revoked' | 'expired'
}

export function newViewToken(environmentId: string): { token: string; prefix: string; hash: string } {
  const alnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let prefix = ''
  for (const b of randomBytes(8)) prefix += alnum[b % alnum.length]
  const token = `${VIEW_TOKEN_PREFIX}.${environmentId}.${prefix}.${randomBytes(32).toString('base64url')}`
  return { token, prefix, hash: sha256(token) }
}

export function parseViewToken(raw: string): { environmentId: string; prefix: string } | null {
  const m = TOKEN_RE.exec(raw)
  return m ? { environmentId: m[1]!, prefix: m[2]! } : null
}

/* per token bucket and last-used touch (per process) */
const buckets = new Map<string, { tokens: number; at: number }>()
const lastTouch = new Map<string, number>()
function admit(id: string, perMinute: number): number {
  const now = Date.now()
  const b = buckets.get(id) ?? { tokens: perMinute, at: now }
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute)
  b.at = now
  buckets.set(id, b)
  if (b.tokens >= 1) { b.tokens -= 1; return 0 }
  return Math.ceil(((1 - b.tokens) / perMinute) * 60)
}

/** the identity a token or a snapshot runs as, in the current environment: null when disabled, gone or without access */
export async function identityIn(services: CoreServices, userId: string): Promise<UserContext | null> {
  const u = await services.meta.users.get(userId)
  if (!u || u.status === 'disabled') return null
  const env = currentEnvironment().id
  if (!(await services.environments.accessible(toUserDef(u))).some((e) => e.id === env && e.state === 'ready')) return null
  return services.security.forUser(toUserDef(u))
}

function toInfo(r: Record<string, unknown>, names: Map<string, string>): ViewTokenInfo {
  const expires = iso(r.expires_on)
  const revoked = iso(r.revoked_on)
  return {
    id: String(r.id), dashboardId: String(r.dashboard_id), label: String(r.label), prefix: String(r.prefix),
    viewAs: { kind: r.view_as_kind === 'service' ? 'service' : 'creator', userId: String(r.view_as), name: names.get(String(r.view_as)) ?? null },
    createdBy: String(r.created_by), createdOn: iso(r.created_on)!, expiresOn: expires, lastUsedOn: iso(r.last_used_on), revokedOn: revoked,
    status: revoked ? 'revoked' : expires && new Date(expires).getTime() <= Date.now() ? 'expired' : 'active',
  }
}

/** a dashboard's tokens and snapshots go with it (dashboard delete, solution removal) */
export async function removeDashboardTokens(db: SqlDb, dashboardId: string): Promise<number> {
  return (await db.exec(`DELETE FROM ${T('ab_dashboard_tokens')} WHERE dashboard_id = $1`, [dashboardId])).affectedRows
}

/** Authorization: Bearer <view token> -> the token row, its dashboard and the "view as" context (throws 401/403/404/429) */
async function resolveViewToken(services: CoreServices, ctx: Ctx): Promise<{ envId: string; row: Record<string, unknown>; who: UserContext; dash: DashboardRow }> {
  const idn = identity(services)
  const ip = idn.ip(ctx.req)
  const failKey = `dashtoken-fail:${ip}`
  if (idn.counters.count(failKey, FAIL_WINDOW_MS) >= FAIL_LIMIT) throw new HttpError(429, 'rate_limited', 'Too many invalid view tokens from this address. Try again in a few minutes.')
  const fail = (): never => {
    idn.counters.add(failKey)
    throw new HttpError(401, 'unauthenticated', INVALID)
  }
  const raw = String(ctx.req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
  const p = parseViewToken(raw)
  if (!p) return fail()
  const db = services.state.db
  if (!db || !services.ready()) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
  if (ctx.requestedEnvironment && ctx.requestedEnvironment !== p.environmentId) throw new HttpError(403, 'denied', 'This view token belongs to another environment.')
  const env = await services.environments.get(p.environmentId)
  if (!env || env.state !== 'ready') return fail()
  return runInEnvironment(env.id, async () => {
    const row = (await db.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_dashboard_tokens')} WHERE prefix = $1`, [p.prefix]))[0]
    if (!row || !sameHash(String(row.secret_hash), sha256(raw))) return fail()
    if (row.revoked_on) return fail()
    if (row.expires_on && new Date(row.expires_on as string).getTime() <= Date.now()) return fail()
    const wait = admit(String(row.id), RATE_PER_MINUTE)
    if (wait > 0) {
      ctx.res.setHeader('Retry-After', String(wait))
      throw new HttpError(429, 'rate_limited', `Rate limit of this view token reached. Try again in ${wait} second(s).`)
    }
    const u = await services.meta.users.get(String(row.view_as))
    if (!u || (row.view_as_kind === 'service' && toUserDef(u).kind !== 'service')) return fail()
    const who = await identityIn(services, u.id)
    if (!who) throw new HttpError(401, 'unauthenticated', 'The account this view token shows the dashboard as is disabled or has no access to this environment.')
    const dash = await dashboardRow(db, String(row.dashboard_id))
    if (!dash) throw new HttpError(404, 'not-found', 'Dashboard not found.')
    if (!canView(who, dash)) throw new HttpError(403, 'denied', 'The account this view token shows the dashboard as can no longer open it.')
    const now = Date.now()
    if (now - (lastTouch.get(String(row.id)) ?? 0) > 60_000) {
      lastTouch.set(String(row.id), now)
      await db.exec(`UPDATE ${T('ab_dashboard_tokens')} SET last_used_on = now() WHERE id = $1`, [row.id]).catch(() => {})
    }
    return { envId: env.id, row, who, dash }
  })
}

export function tokenRoutes(router: ApiRouter, services: CoreServices): void {
  const db = () => {
    const d = services.state.db
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }
  const audit = async (ctx: Ctx, action: string, details: unknown) => {
    try { await services.meta.audit({ userId: ctx.user?.user.id ?? null, action, details }) } catch (e) { log('error', `audit write failed (${action}): ${errText(e)}`) }
  }
  const editable = async (ctx: Ctx): Promise<DashboardRow> => {
    const d = await dashboardRow(db(), ctx.params.id)
    if (!d || !canView(ctx.user!, d)) throw new HttpError(404, 'not-found', 'Dashboard not found.')
    if (!canEdit(ctx.user!, d)) throw new HttpError(403, 'denied', 'Only the owner and administrators can manage view tokens of this dashboard.')
    return d
  }
  const names = async (rows: Record<string, unknown>[]) => {
    const m = new Map<string, string>()
    for (const id of new Set(rows.map((r) => String(r.view_as)))) { const u = await services.meta.users.get(id); if (u) m.set(id, u.name) }
    return m
  }

  router.add('GET', '/dashboards/:id/tokens', async (ctx) => {
    const d = await editable(ctx)
    const rows = await db().query<Record<string, unknown>>(`SELECT * FROM ${T('ab_dashboard_tokens')} WHERE dashboard_id = $1 ORDER BY created_on DESC, id`, [d.id])
    const n = await names(rows)
    return { items: rows.map((r) => toInfo(r, n)) }
  }, { auth: 'user' })

  router.add('POST', '/dashboards/:id/tokens', async (ctx) => {
    const d = await editable(ctx)
    const me = ctx.user!
    const b = isObj(ctx.body) ? ctx.body : {}
    const label = typeof b.label === 'string' ? b.label.trim().slice(0, 100) : ''
    if (!label) throw new HttpError(422, 'invalid', 'Give the token a label (where the screen is, for example).', 'label')
    let expiresOn: Date | null = null
    if (b.expiresOn !== undefined && b.expiresOn !== null && b.expiresOn !== '') {
      const t = typeof b.expiresOn === 'string' ? Date.parse(b.expiresOn) : NaN
      if (!Number.isFinite(t) || t <= Date.now() || t > Date.now() + 5 * 366 * 86_400_000) throw new HttpError(422, 'invalid', 'The expiry is a date and time in the future (at most five years ahead).', 'expiresOn')
      expiresOn = new Date(t)
    }
    let viewAs = me.user.id
    let kind: 'creator' | 'service' = 'creator'
    if (b.viewAs !== undefined && b.viewAs !== null && b.viewAs !== 'creator') {
      const sa = isObj(b.viewAs) && typeof b.viewAs.serviceAccount === 'string' ? b.viewAs.serviceAccount : null
      if (!sa) throw new HttpError(422, 'invalid', 'viewAs is "creator" or { serviceAccount: <id> }.', 'viewAs')
      if (!me.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only administrators can let a view token show the dashboard as a service account.')
      const u = await services.meta.users.get(sa)
      if (!u || toUserDef(u).kind !== 'service' || u.status === 'disabled') throw new HttpError(422, 'invalid', 'Choose an active service account.', 'viewAs')
      const who = await identityIn(services, u.id)
      if (!who) throw new HttpError(422, 'invalid', 'This service account has no access to this environment.', 'viewAs')
      if (!canView(who, d)) throw new HttpError(422, 'invalid', 'This service account cannot open the dashboard: add one of its roles to the dashboard\'s viewer roles first.', 'viewAs')
      viewAs = u.id
      kind = 'service'
    }
    const active = await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${T('ab_dashboard_tokens')} WHERE dashboard_id = $1 AND revoked_on IS NULL AND (expires_on IS NULL OR expires_on > now())`, [d.id])
    if ((active[0]?.n ?? 0) >= MAX_TOKENS_PER_DASHBOARD) throw new HttpError(422, 'invalid', `A dashboard has at most ${MAX_TOKENS_PER_DASHBOARD} active view tokens; revoke one first.`)
    const t = newViewToken(currentEnvironment().id)
    const id = `dvt_${rowUid().replace(/-/g, '').slice(-16)}`
    await db().exec(
      `INSERT INTO ${T('ab_dashboard_tokens')} (id, dashboard_id, label, prefix, secret_hash, view_as, view_as_kind, created_by, created_on, expires_on) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)`,
      [id, d.id, label, t.prefix, t.hash, viewAs, kind, me.user.id, expiresOn],
    )
    await audit(ctx, 'dashboard.token.create', { id, dashboard: d.id, label, prefix: t.prefix, viewAs: { kind, userId: viewAs }, expiresOn: expiresOn?.toISOString() ?? null })
    if (kind === 'service') await audit(ctx, 'dashboard.token.run_as_service', { id, dashboard: d.id, serviceAccount: viewAs })
    const row = (await db().query<Record<string, unknown>>(`SELECT * FROM ${T('ab_dashboard_tokens')} WHERE id = $1`, [id]))[0]!
    const warnings: string[] = []
    if (kind === 'creator' && me.privileges.isAdmin) warnings.push('This token shows the dashboard as you see it, and as an administrator you see every row. For a screen in a shared place, an administrator can choose a service account with narrower roles instead.')
    if (!expiresOn) warnings.push('This token does not expire: revoke it when the screen is no longer used.')
    return { ...toInfo(row, await names([row])), token: t.token, warnings }
  }, { auth: 'user' })

  router.add('DELETE', '/dashboards/:id/tokens/:tokenId', async (ctx) => {
    const d = await editable(ctx)
    const n = (await db().exec(`UPDATE ${T('ab_dashboard_tokens')} SET revoked_on = now(), revoked_by = $3 WHERE id = $1 AND dashboard_id = $2 AND revoked_on IS NULL`, [ctx.params.tokenId, d.id, ctx.user!.user.id])).affectedRows
    const exists = (await db().query(`SELECT 1 FROM ${T('ab_dashboard_tokens')} WHERE id = $1 AND dashboard_id = $2`, [ctx.params.tokenId, d.id])).length > 0
    if (!exists) throw new HttpError(404, 'not-found', 'View token not found.')
    if (n) await audit(ctx, 'dashboard.token.revoke', { id: ctx.params.tokenId, dashboard: d.id })
    return { ok: true }
  }, { auth: 'user' })

  /* ---------------------------------------------------------------- the two things a token may do */

  router.add('GET', '/dashboards/kiosk', async (ctx) => {
    const { envId, row, dash } = await resolveViewToken(services, ctx)
    return runInEnvironment(envId, async () => ({
      dashboard: { id: dash.id, name: dash.name, def: dash.def, modifiedOn: new Date(dash.modified_on as string).toISOString() },
      settings: await loadSettings(db()),
      token: { id: String(row.id), label: String(row.label), expiresOn: iso(row.expires_on), viewAs: row.view_as_kind === 'service' ? 'service' : 'creator' },
      environmentId: envId,
    }))
  }, { auth: 'none' })

  router.add('POST', '/dashboards/kiosk/query', async (ctx) => {
    const { envId, who, dash } = await resolveViewToken(services, ctx)
    const b = isObj(ctx.body) ? ctx.body : {}
    // a view token is not a query API: the server compiles the dashboard's own tiles
    if (b.queries !== undefined || b.plan !== undefined || b.plans !== undefined) throw new HttpError(422, 'invalid', 'A view token runs only the dashboard\'s own tiles; send the range, filters and cross-filter, not plans.', 'queries')
    if (b.dashboardId !== undefined && b.dashboardId !== dash.id) throw new HttpError(404, 'not-found', 'Dashboard not found.')
    return runInEnvironment(envId, async () => {
      const t0 = Date.now()
      const settings = await loadSettings(db())
      const choices = checkChoices(dash.def, b, settings)
      const out = await computeDashboard(services, who, dash.def, choices, settings)
      return { dashboardId: dash.id, results: out.results, errors: out.errors, range: out.range, now: out.now, ms: Date.now() - t0 }
    })
  }, { auth: 'none' })
}
