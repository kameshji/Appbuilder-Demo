/**
 * Auth (docs/internal/specs/SPEC3.md section 4): sessions, login throttle, setup flow, status endpoint.
 *   GET  /status            POST /setup/database      POST /setup/admin
 *   POST /auth/login        POST /auth/logout         GET  /auth/session      POST /auth/password
 */
import { createHash, randomBytes } from 'node:crypto'
import { HttpError } from './contracts.ts'
import type { Ctx, UserContext, UserRecord } from './contracts.ts'
import type { RoleDef, Session, TablePrivilege, UserDef } from '../../src/platform/contracts.ts'
import type {
  ChangePasswordRequest, LoginRequest, SetupAdminRequest, SetupDatabaseRequest, StatusResponse,
} from '../../src/platform/http.ts'
import { SESSION_COOKIE } from '../../src/platform/http.ts'
import { migrateLegacyWorkspace, seedSample } from '../routes/meta/index.ts'
import type { ApiRouter } from './router.ts'
import { cookieValue } from './router.ts'
import type { CoreServices } from './services.ts'
import { SESSION_LIFETIME_MS } from './security.ts'
import { checkPasswordPolicy, hashPassword, verifyDummy, verifyPassword } from './password.ts'
import { errText, log } from './util.ts'

const TOUCH_INTERVAL_MS = 10 * 60 * 1000
const THROTTLE_LIMIT = 8
const THROTTLE_WINDOW_MS = 15 * 60 * 1000
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const ROLE_ADMIN = 'role_admin'
export const ROLE_MAKER = 'role_maker'
export const ROLE_VIEWER = 'role_viewer'

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

/** UserRecord -> what may leave the server (no password hash) */
export function toUserDef(u: UserRecord): UserDef {
  const { passwordHash, ...rest } = u
  return { ...rest, hasPassword: !!passwordHash }
}

/* ------------------------------------------------------------------ throttle (in memory) */

export class LoginThrottle {
  private failures = new Map<string, number[]>()
  private limit: number
  private windowMs: number
  constructor(limit = THROTTLE_LIMIT, windowMs = THROTTLE_WINDOW_MS) {
    this.limit = limit
    this.windowMs = windowMs
  }
  private recent(key: string, now: number): number[] {
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs)
    if (list.length) this.failures.set(key, list)
    else this.failures.delete(key)
    return list
  }
  blocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.limit
  }
  fail(key: string, now = Date.now()): void {
    const list = this.recent(key, now)
    list.push(now)
    this.failures.set(key, list)
    if (this.failures.size > 10000) for (const k of [...this.failures.keys()].slice(0, 5000)) this.failures.delete(k)
  }
  reset(key: string): void {
    this.failures.delete(key)
  }
}

/* ------------------------------------------------------------------ sessions */

export async function createSession(services: CoreServices, ctx: Ctx, userId: string): Promise<Date> {
  const token = randomBytes(32).toString('base64url')
  const expiresOn = new Date(Date.now() + SESSION_LIFETIME_MS)
  await services.meta.sessions.insert({ idHash: hashToken(token), userId, expiresOn, userAgent: String(ctx.req.headers['user-agent'] ?? '').slice(0, 255) })
  ctx.setSessionCookie(token, expiresOn)
  return expiresOn
}

/** cookie -> UserContext (sliding expiry, touched at most every 10 minutes) */
export function sessionResolver(services: CoreServices) {
  return async (ctx: Ctx): Promise<UserContext | null> => {
    const token = cookieValue(ctx.req, SESSION_COOKIE)
    if (!token || token.length > 200) return null
    const meta = services.meta
    const idHash = hashToken(token)
    const s = await meta.sessions.get(idHash)
    if (!s) return null
    const now = Date.now()
    if (s.expiresOn.getTime() <= now) {
      await meta.sessions.remove(idHash).catch(() => {})
      return null
    }
    const user = await meta.users.get(s.userId)
    if (!user || user.status === 'disabled') return null
    let expires = s.expiresOn
    const next = new Date(now + SESSION_LIFETIME_MS)
    if (next.getTime() - s.expiresOn.getTime() > TOUCH_INTERVAL_MS) {
      await meta.sessions.touch(idHash, next)
      ctx.setSessionCookie(token, next)
      expires = next
    }
    return services.security.forUser(toUserDef(user), expires)
  }
}

/* ------------------------------------------------------------------ helpers */

function obj(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(422, 'invalid', 'Request body must be a JSON object.')
  return body as Record<string, unknown>
}
function text(o: Record<string, unknown>, key: string, max: number, required = true): string {
  const v = o[key]
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(422, 'invalid', `${key} is required.`, key)
    return ''
  }
  if (typeof v !== 'string') throw new HttpError(422, 'invalid', `${key} must be text.`, key)
  if (v.length > max) throw new HttpError(422, 'invalid', `${key} is too long.`, key)
  return v
}
export function checkEmail(v: string, field = 'email'): string {
  const e = v.trim().toLowerCase()
  if (!EMAIL_RE.test(e) || e.length > 191) throw new HttpError(422, 'invalid', 'Enter a valid email address.', field)
  return e
}

async function audit(services: CoreServices, userId: string | null, action: string, details?: unknown) {
  try {
    await services.meta.audit({ userId, action, details })
  } catch (e) {
    log('warn', `audit failed: ${errText(e)}`)
  }
}

let setupLock: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = setupLock.then(fn, fn)
  setupLock = run.catch(() => {})
  return run
}

/** built-in roles (idempotent): Administrator, Maker (full on every table), Viewer (read every table) */
export async function ensureBuiltinRoles(services: CoreServices): Promise<void> {
  const meta = services.meta
  const tables = await meta.tables.list()
  const full = (t: string): TablePrivilege => ({ table: t, create: true, read: 'all', update: 'all', delete: 'all' })
  const read = (t: string): TablePrivilege => ({ table: t, create: false, read: 'all', update: 'none', delete: 'none' })
  const wanted: (RoleDef & { isMaker?: boolean })[] = [
    { id: ROLE_ADMIN, name: 'Administrator', description: 'Full access to everything.', isAdmin: true, privileges: [], apps: 'all' },
    { id: ROLE_MAKER, name: 'Maker', description: 'Builds apps and edits all data.', isMaker: true, privileges: tables.map((t) => full(t.id)), apps: 'all' },
    { id: ROLE_VIEWER, name: 'Viewer', description: 'Can run apps and read all data.', privileges: tables.map((t) => read(t.id)), apps: 'all' },
  ]
  const existing = await meta.roles.list()
  for (const r of wanted) {
    if (existing.some((x) => x.id === r.id)) continue
    if (existing.some((x) => x.name.toLowerCase() === r.name.toLowerCase())) r.name = `${r.name} (built-in)`
    await meta.roles.upsert(r)
  }
  services.security.invalidate()
}

/* ------------------------------------------------------------------ routes */

export function authRoutes(router: ApiRouter, services: CoreServices): void {
  const throttle = new LoginThrottle()

  router.add('GET', '/status', async (ctx): Promise<StatusResponse> => {
    let needsAdmin = true
    let databaseError = services.state.databaseError
    if (services.ready()) {
      try {
        needsAdmin = (await services.meta.users.count()) === 0
      } catch (e) {
        databaseError = 'The database is not reachable.'
        log('warn', `status: ${errText(e)}`)
      }
    }
    const out: StatusResponse = {
      app: 'appbuilder',
      apiVersion: 1,
      backend: 'node',
      setup: { needsDatabase: !services.ready(), needsAdmin },
      storage: services.state.location ? { kind: 'mysql', location: services.state.location } : null,
      session: ctx.user ? ctx.user.session() : null,
    }
    if (databaseError) out.databaseError = databaseError
    return out
  }, { auth: 'none' })

  router.add('POST', '/setup/database', async (ctx) => {
    if (services.ready()) {
      let users = 0
      try {
        users = await services.meta.users.count()
      } catch {
        users = 0 // current database unreachable: allow re-configuration
      }
      if (users > 0 && !ctx.user?.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only an administrator can change the database.')
    }
    const b = obj(ctx.body) as Partial<SetupDatabaseRequest> & Record<string, unknown>
    const host = text(b, 'host', 255).trim()
    const port = Number(b.port ?? 3306)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(422, 'invalid', 'Port must be between 1 and 65535.', 'port')
    const database = text(b, 'database', 64).trim()
    const user = text(b, 'user', 80).trim()
    const password = b.password === undefined || b.password === null ? '' : text(b, 'password', 1024, false)
    const ssl = b.ssl === true || b.ssl === 'true'
    await serialized(() => services.configureDatabase({ host, port, database, user, ssl }, password, { createDatabase: b.createDatabase === true, persist: true }))
    await audit(services, ctx.user?.user.id ?? null, 'setup.database', { host, port, database, user })
    return { ok: true }
  }, { auth: 'none' })

  router.add('POST', '/setup/admin', async (ctx): Promise<Session> => {
    if (!services.ready()) throw new HttpError(503, 'unavailable', 'Configure the database first.')
    const b = obj(ctx.body) as Partial<SetupAdminRequest> & Record<string, unknown>
    const name = text(b, 'name', 255).trim()
    if (!name) throw new HttpError(422, 'invalid', 'name is required.', 'name')
    const email = checkEmail(text(b, 'email', 191))
    const password = checkPasswordPolicy(b.password, email)
    const hash = await hashPassword(password)
    const userId = await serialized(async () => {
      if ((await services.meta.users.count()) > 0) throw new HttpError(409, 'conflict', 'Setup is already complete. Please sign in.')
      await ensureBuiltinRoles(services)
      const id = services.uid('user')
      await services.meta.users.insert({ id, name, email, roleIds: [ROLE_ADMIN], status: 'active', passwordHash: hash })
      services.security.invalidate()
      return id
    })
    await audit(services, userId, 'setup.admin', { email })
    try {
      const r = await migrateLegacyWorkspace(services, userId)
      if (r.migrated) log('info', `legacy workspace migrated: ${r.summary}`)
      else await seedSample(services, userId)
    } catch (e) {
      log('error', `legacy migration / sample seeding failed: ${errText(e)}`)
    }
    services.security.invalidate()
    const expires = await createSession(services, ctx, userId)
    const rec = await services.meta.users.get(userId)
    if (!rec) throw new HttpError(500, 'storage', 'The administrator could not be created.')
    return (await services.security.forUser(toUserDef(rec), expires)).session()
  }, { auth: 'none' })

  router.add('POST', '/auth/login', async (ctx): Promise<Session> => {
    if (!services.ready()) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    const b = obj(ctx.body) as Partial<LoginRequest> & Record<string, unknown>
    const email = (typeof b.email === 'string' ? b.email : '').trim().toLowerCase().slice(0, 191)
    const password = typeof b.password === 'string' ? b.password.slice(0, 1024) : ''
    const key = `${email}|${ctx.req.socket.remoteAddress ?? ''}`
    if (throttle.blocked(key)) {
      await audit(services, null, 'auth.login_throttled', { email })
      throw new HttpError(429, 'denied', 'Too many attempts. Try again in a few minutes.')
    }
    const user = email ? await services.meta.users.byEmail(email) : null
    const ok = user && user.passwordHash && user.status !== 'disabled' ? await verifyPassword(password, user.passwordHash) : await verifyDummy(password)
    if (!ok || !user) {
      throttle.fail(key)
      await audit(services, user?.id ?? null, 'auth.login_failed', { email })
      throw new HttpError(401, 'unauthenticated', 'Invalid email or password.')
    }
    throttle.reset(key)
    const old = cookieValue(ctx.req, SESSION_COOKIE)
    if (old && old.length <= 200) await services.meta.sessions.remove(hashToken(old)).catch(() => {})
    await services.meta.users.update(user.id, { lastLogin: new Date().toISOString() })
    const expires = await createSession(services, ctx, user.id)
    await audit(services, user.id, 'auth.login')
    const fresh = (await services.meta.users.get(user.id)) ?? user
    return (await services.security.forUser(toUserDef(fresh), expires)).session()
  }, { auth: 'none' })

  router.add('POST', '/auth/logout', async (ctx) => {
    const token = cookieValue(ctx.req, SESSION_COOKIE)
    if (token && token.length <= 200 && services.ready()) await services.meta.sessions.remove(hashToken(token))
    ctx.setSessionCookie(null)
    if (ctx.user) await audit(services, ctx.user.user.id, 'auth.logout')
    return { ok: true }
  }, { auth: 'none' })

  router.add('GET', '/auth/session', (ctx) => ctx.user!.session(), { auth: 'user' })

  router.add('POST', '/auth/password', async (ctx) => {
    const b = obj(ctx.body) as Partial<ChangePasswordRequest> & Record<string, unknown>
    const me = ctx.user!.user
    const key = `password|${me.id}`
    if (throttle.blocked(key)) throw new HttpError(429, 'denied', 'Too many attempts. Try again in a few minutes.')
    const rec = await services.meta.users.get(me.id)
    if (!rec) throw new HttpError(401, 'unauthenticated', 'Please sign in.')
    const current = typeof b.current === 'string' ? b.current.slice(0, 1024) : ''
    if (!(await verifyPassword(current, rec.passwordHash))) {
      throttle.fail(key)
      await audit(services, me.id, 'auth.password_failed')
      throw new HttpError(422, 'invalid', 'The current password is not correct.', 'current')
    }
    const next = checkPasswordPolicy(b.next, rec.email, 'next')
    if (next === current) throw new HttpError(422, 'invalid', 'The new password must be different.', 'next')
    throttle.reset(key)
    await services.meta.users.update(me.id, { passwordHash: await hashPassword(next) })
    await services.meta.sessions.removeForUser(me.id) // signs out every other device
    await createSession(services, ctx, me.id) // and keeps this one signed in with a fresh token
    await audit(services, me.id, 'auth.password_changed')
    return { ok: true }
  }, { auth: 'user' })
}
