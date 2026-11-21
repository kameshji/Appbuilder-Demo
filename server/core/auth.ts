/**
 * Auth (docs/internal/specs/SPEC3.md section 4): sessions, login throttle, setup flow, status endpoint.
 *   GET  /status            POST /setup/database      POST /setup/admin
 *   POST /auth/login        POST /auth/logout         GET  /auth/session      POST /auth/password
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { HttpError } from './contracts.ts'
import type { Ctx, UserContext, UserRecord } from './contracts.ts'
import type { RoleDef, Session, TablePrivilege, UserDef } from '../../src/platform/contracts.ts'
import type {
  ChangePasswordRequest, LoginRequest, SetupAdminRequest, SetupDatabaseRequest, StatusResponse,
} from '../../src/platform/http.ts'
import { SESSION_COOKIE, SETUP_CODE_HEADER } from '../../src/platform/http.ts'
import { migrateLegacyWorkspace, seedSample } from '../routes/meta/index.ts'
import type { ApiRouter } from './router.ts'
import { cookieValue } from './router.ts'
import type { CoreServices } from './services.ts'
import { checkPasswordPolicy, hashPassword, verifyDummy, verifyPassword } from './password.ts'
import { errText, log } from './util.ts'
import { SCHEMA_VERSION } from './meta-store.ts'
import {
  MFA_COOKIE, MFA_PENDING_MS, cookieOf, deviceName, identity, newSessionPublicId, noteRequestSession, requestSession,
} from './identity/index.ts'
import { checkPasswordHistory, passwordExpired, recordPassword } from './identity/passwords.ts'
import { resolveApiKey } from './identity/api-keys.ts'
import { setCookie } from './identity/util.ts'
import { DEFAULT_ENVIRONMENT_ID, runInEnvironment } from './env-context.ts'
import { NoEnvironmentError } from './environments.ts'
import { applyPass } from './licence/seats.ts'

/** version of the running server (package.json next to server/); read once */
let appVersion: string | null = null
export function serverVersion(): string {
  if (appVersion === null) {
    try {
      const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown }
      appVersion = typeof pkg.version === 'string' ? pkg.version : 'unknown'
    } catch {
      appVersion = 'unknown'
    }
  }
  return appVersion
}

const TOUCH_INTERVAL_MS = 10 * 60 * 1000
const THROTTLE_LIMIT = 8
const THROTTLE_WINDOW_MS = 15 * 60 * 1000
/** per email, from any address: failures counted over an hour */
export const EMAIL_WINDOW_MS = 60 * 60 * 1000
/** from this many failures (per email, any address) every further attempt waits 2^(n - start) seconds after the last failure */
export const EMAIL_DELAY_FROM = 10
/** the longest such delay */
export const EMAIL_MAX_DELAY_MS = 5 * 60 * 1000
/** this many failures within the hour block the email completely until the oldest ages out */
export const EMAIL_LIMIT = 50
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const ROLE_ADMIN = 'role_admin'
export const ROLE_MAKER = 'role_maker'
export const ROLE_VIEWER = 'role_viewer'

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

/** UserRecord -> what may leave the server (no password hash) */
/**
 * Where the setup screen tells the person to read the setup code. A setup-code file without a console is a server
 * installed as a service (its output goes to a log); with a console (started by hand) the code is printed in that window
 * and also written to the file.
 */
export function setupCodeWhere(inFile: boolean, consoleIsTty: boolean): 'console' | 'file' | 'both' {
  if (!inFile) return 'console'
  return consoleIsTty ? 'both' : 'file'
}

export function toUserDef(u: UserRecord): UserDef {
  const { passwordHash, ...rest } = u
  return { ...rest, hasPassword: !!passwordHash }
}

/* ------------------------------------------------------------------ throttle (in memory) */

export class LoginThrottle {
  private failures = new Map<string, number[]>()
  private limitOf: () => number
  private windowOf: () => number
  /** limit and window may be getters (package I: the lockout policy of Admin console > Sign-in and security) */
  constructor(limit: number | (() => number) = THROTTLE_LIMIT, windowMs: number | (() => number) = THROTTLE_WINDOW_MS) {
    this.limitOf = typeof limit === 'function' ? limit : () => limit
    this.windowOf = typeof windowMs === 'function' ? windowMs : () => windowMs
  }
  private get limit(): number {
    return this.limitOf()
  }
  private get windowMs(): number {
    return this.windowOf()
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

/**
 * Second sign-in brake, per email from every address together (the per email+address throttle cannot see guesses spread
 * over many addresses, or a local program that rotates emails). Up to EMAIL_DELAY_FROM failures in an hour cost nothing;
 * after that each attempt must wait 1 s, 2 s, 4 s ... (at most 5 minutes) after the previous failure; EMAIL_LIMIT failures
 * in an hour block the email. Attempts during a wait are refused without checking the password (so a correct password
 * is refused too: anyone can slow down a known account's sign-in, which is the price of the brake). In memory.
 */
export class EmailBackoff {
  private failures = new Map<string, number[]>()
  private delayFrom: () => number
  private limit: () => number
  constructor(o: { delayFrom?: () => number; limit?: () => number } = {}) {
    this.delayFrom = o.delayFrom ?? (() => EMAIL_DELAY_FROM)
    this.limit = o.limit ?? (() => EMAIL_LIMIT)
  }
  private recent(key: string, now: number): number[] {
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < EMAIL_WINDOW_MS)
    if (list.length) this.failures.set(key, list)
    else this.failures.delete(key)
    return list
  }
  /** milliseconds until the next attempt is allowed (0 = now) */
  waitMs(key: string, now = Date.now()): number {
    const list = this.recent(key, now)
    const limit = this.limit()
    const from = this.delayFrom()
    if (list.length >= limit) return Math.max(1, list[list.length - limit] + EMAIL_WINDOW_MS - now)
    if (list.length < from) return 0
    const delay = Math.min(EMAIL_MAX_DELAY_MS, 1000 * 2 ** (list.length - from))
    return Math.max(0, list[list.length - 1] + delay - now)
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

/**
 * A new session: random 256-bit token in the HttpOnly cookie, its SHA-256 in ab.sessions. Lifetime from the policy
 * (idle timeout, absolute end). mfa: a second factor (or a remembered device) was used; restricted 'mfa_enrol': the
 * session may only set up two-step verification.
 */
export async function createSession(services: CoreServices, ctx: Ctx, userId: string, o: { mfa?: boolean; restricted?: string | null } = {}): Promise<Date> {
  const idn = identity(services)
  const p = await idn.policy.get()
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  const absoluteExpiresOn = p.sessions.absoluteHours ? new Date(now + p.sessions.absoluteHours * 3_600_000) : null
  const idle = new Date(now + p.sessions.idleMinutes * 60_000)
  const expiresOn = absoluteExpiresOn && absoluteExpiresOn < idle ? absoluteExpiresOn : idle
  const publicId = newSessionPublicId()
  const userAgent = String(ctx.req.headers['user-agent'] ?? '').slice(0, 255)
  const idHash = hashToken(token)
  const ip = idn.ip(ctx.req)
  await services.meta.sessions.insert({ idHash, userId, expiresOn, userAgent, ip, publicId, absoluteExpiresOn, mfa: !!o.mfa, restricted: o.restricted ?? null })
  ctx.setSessionCookie(token, expiresOn)
  const at = new Date(now)
  noteRequestSession(ctx.req, { idHash, rec: { userId, expiresOn, createdOn: at, lastSeen: at, absoluteExpiresOn, authOn: at, publicId, restricted: o.restricted ?? null, mfa: !!o.mfa, ip, userAgent } })
  return expiresOn
}

/** the session payload with the identity facts the browser needs (two-step verification state and requirement) */
export async function sessionPayload(services: CoreServices, uc: UserContext): Promise<Session> {
  const s = uc.session()
  if (uc.user.kind === 'service') return s
  try {
    const idn = identity(services)
    const methods = await idn.mfaMethods(uc.user.id)
    const rec = await services.meta.users.get(uc.user.id)
    const req = rec ? await idn.mfaRequirement(rec) : { required: false, enrolBy: null }
    return { ...s, user: { ...s.user, mfaEnabled: methods.totp || methods.email, ...(req.required ? { mfaRequired: { enrolBy: req.enrolBy ? req.enrolBy.toISOString() : null } } : {}) } }
  } catch (e) {
    log('warn', `session details: ${errText(e)}`)
    return s
  }
}

/**
 * The security context of a user in the environment a request works in: `requested` (checked against the user's
 * access: 404 unknown, 403 not granted, 503 not ready) or, when none is named, the user's last environment, else
 * Default, else the first they may enter. allowNoEnvironment: a user with no environment at all gets a context in
 * Default without any role (they can see their session, change their password, read the empty environment list).
 */
export async function userContextFor(
  services: CoreServices, rec: UserRecord, requested: string | null, expires?: Date, o: { allowNoEnvironment?: boolean } = {},
): Promise<UserContext> {
  let envId: string
  let none = false
  try {
    envId = (await services.environments.resolveFor(toUserDef(rec), requested)).id
  } catch (e) {
    if (!(e instanceof NoEnvironmentError) || !o.allowNoEnvironment) throw e
    envId = DEFAULT_ENVIRONMENT_ID
    none = true
  }
  return runInEnvironment(envId, async () => {
    // roles are per environment: read them in the environment itself
    const inEnv = none ? { ...rec, roleIds: [] } : envId === DEFAULT_ENVIRONMENT_ID ? rec : ((await services.meta.users.get(rec.id)) ?? rec)
    return services.security.forUser(toUserDef(inEnv), expires)
  })
}

/**
 * cookie -> UserContext in the request's environment. The session ends after the idle timeout (last_seen is touched at
 * most every 10 minutes, or every quarter of the idle timeout) or at its absolute end. A request with
 * Authorization: Bearer is an API key request (api-keys.ts): cookies are ignored then.
 */
export function sessionResolver(services: CoreServices) {
  return async (ctx: Ctx, o: { allowNoEnvironment?: boolean } = {}): Promise<UserContext | null> => {
    if (/^Bearer\s/i.test(String(ctx.req.headers.authorization ?? ''))) return resolveApiKey(services, ctx)
    const token = cookieValue(ctx.req, SESSION_COOKIE)
    if (!token || token.length > 200) return null
    const meta = services.meta
    const idHash = hashToken(token)
    const s = await meta.sessions.get(idHash)
    if (!s) return null
    const now = Date.now()
    const p = await identity(services).policy.get()
    const idleMs = p.sessions.idleMinutes * 60_000
    const idleOver = !!s.lastSeen && now - s.lastSeen.getTime() > idleMs
    if (s.expiresOn.getTime() <= now || (s.absoluteExpiresOn && s.absoluteExpiresOn.getTime() <= now) || idleOver) {
      await meta.sessions.remove(idHash).catch(() => {})
      return null
    }
    const user = await meta.users.get(s.userId)
    if (!user || user.status === 'disabled' || user.kind === 'service') return null
    noteRequestSession(ctx.req, { idHash, rec: s })
    let expires = s.expiresOn
    const idleEnd = now + idleMs
    const next = new Date(s.absoluteExpiresOn ? Math.min(idleEnd, s.absoluteExpiresOn.getTime()) : idleEnd)
    const touchEvery = Math.min(TOUCH_INTERVAL_MS, idleMs / 4)
    if (now - (s.lastSeen?.getTime() ?? 0) > touchEvery || next.getTime() - s.expiresOn.getTime() > TOUCH_INTERVAL_MS) {
      await meta.sessions.touch(idHash, next)
      ctx.setSessionCookie(token, next)
      expires = next
    }
    const rec: UserRecord = s.restricted === 'mfa_enrol' ? { ...user, mfaEnrolmentRequired: true } : user
    return userContextFor(services, rec, ctx.requestedEnvironment ?? null, expires, o)
  }
}

/**
 * The end of every successful sign-in (password, second step, invitation): the old cookie session goes, a new session,
 * audit, the sign-in log, and (when email is set up) a "new sign-in" email for a device this account was not used on.
 */
export async function finishSignIn(
  services: CoreServices, ctx: Ctx, user: UserRecord, o: { method: string; mfa?: boolean; restricted?: string | null },
): Promise<Session> {
  const idn = identity(services)
  const old = cookieValue(ctx.req, SESSION_COOKIE)
  if (old && old.length <= 200) await services.meta.sessions.remove(hashToken(old)).catch(() => {})
  setCookie(ctx.req, ctx.res, MFA_COOKIE, null, 0, { secureCookie: services.config?.secureCookie, trustProxy: services.config?.trustProxy })
  await services.meta.users.update(user.id, { lastLogin: new Date().toISOString() })
  const expires = await createSession(services, ctx, user.id, { mfa: o.mfa, restricted: o.restricted })
  const sessionId = requestSession(ctx.req)?.rec.publicId ?? null
  await audit(services, user.id, 'auth.login', { method: o.method, ...(user.mustChangePassword ? { mustChangePassword: true } : {}), ...(o.restricted ? { restricted: o.restricted } : {}) })
  // a device this account has not signed in on before (a long-lived random cookie, compared by hash)
  const deviceHash = idn.knownDevice(ctx)
  let newDevice = false
  try {
    const db = services.state.db!
    const seen = await db.query<{ known: boolean; any: boolean }>(
      `SELECT bool_or(device_hash = $2) AS known, count(*) > 0 AS any FROM "ab"."signin_log" WHERE user_id = $1 AND outcome = 'success'`,
      [user.id, deviceHash],
    )
    newDevice = !!seen[0]?.any && !seen[0]?.known
  } catch { /* not important */ }
  await idn.logSignIn(ctx, { userId: user.id, email: user.email, outcome: 'success', reason: 'ok', method: o.method, sessionId, deviceHash, newDevice })
  if (newDevice) {
    void (async () => {
      const p = await idn.policy.get()
      if (!p.notifyNewDevice || !(await idn.mail.configured())) return
      await idn.mail.sendTemplate('new_device', user.email, {
        name: user.name, email: user.email, when: new Date().toUTCString(), device: deviceName(ctx.req.headers['user-agent']), ip: idn.ip(ctx.req),
      }, user.id)
    })().catch((e) => log('warn', `new-device email not queued: ${errText(e)}`))
  }
  const fresh = (await services.meta.users.get(user.id)) ?? user
  // the session's privileges in the environment the client asked for (or the user's last one)
  let requested = ctx.requestedEnvironment ?? null
  if (requested && !(await services.environments.accessible(toUserDef(fresh))).some((e) => e.id === requested && e.state === 'ready')) requested = null
  const rec: UserRecord = o.restricted === 'mfa_enrol' ? { ...fresh, mfaEnrolmentRequired: true } : fresh
  // P3-2: the sign-in answer shows the seat pass as GET /auth/session does (an Operator sees no Dev mode from the start)
  return sessionPayload(services, await applyPass(services, await userContextFor(services, rec, requested, expires, { allowNoEnvironment: true })))
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
    // never fails the request, but always visible on the console
    log('error', `audit write failed (${action}): ${errText(e)}`)
  }
}

/** the setup code from the body (setupCode) or the X-Appbuilder-Setup-Code header */
function givenSetupCode(ctx: Ctx, b: Record<string, unknown>): unknown {
  if (typeof b.setupCode === 'string') return b.setupCode
  const h = ctx.req.headers[SETUP_CODE_HEADER.toLowerCase()]
  return Array.isArray(h) ? h[0] : h
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
  const idn = identity(services)
  const pol = () => idn.policy.cached().lockout
  const throttle = new LoginThrottle(() => pol().attempts, () => pol().windowMinutes * 60_000)
  const emailBackoff = new EmailBackoff({ delayFrom: () => pol().slowDownFrom, limit: () => pol().blockAt })
  /** separate map: login spraying can neither evict nor fill the password-change throttle (and vice versa) */
  const passwordThrottle = new LoginThrottle()

  router.add('GET', '/status', async (ctx): Promise<StatusResponse> => {
    let needsAdmin = !services.setupComplete()
    let databaseError = services.state.databaseError
    let reachable = services.ready()
    if (services.ready()) {
      try {
        needsAdmin = (await services.meta.users.count()) === 0
      } catch (e) {
        databaseError = 'The database is not reachable.'
        reachable = false
        log('warn', `status: ${errText(e)}`)
      }
    }
    const incompatible = !!services.state.incompatible
    // first run only: once an administrator exists the database is never re-pointed from the (anonymous) setup screen
    const needsDatabase = !services.ready() && !incompatible && !services.setupComplete()
    const unavailable = !reachable && !incompatible && services.databaseConfigured()
    const setup: StatusResponse['setup'] = { needsDatabase, needsAdmin: needsAdmin && !incompatible && (services.ready() || !services.setupComplete()) }
    if (unavailable) setup.unavailable = true
    if (incompatible) setup.incompatible = true
    // while setup is needed: where to read the setup code (only the fact that a code file is used, never its path). The
    // file alone means a service: no console shows the printed code. Started by hand in a console with the variable set,
    // the code is in the window AND in the file.
    if (setup.needsDatabase || setup.needsAdmin) {
      setup.codeIn = setupCodeWhere(services.setupCodeInFile, process.stdout.isTTY === true)
      setup.platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
    }
    const out: StatusResponse = {
      app: 'appbuilder',
      apiVersion: 1,
      backend: 'node',
      setup,
      ok: reachable && !needsAdmin && !incompatible,
      session: ctx.user ? ctx.user.session() : null,
    }
    // details (host, port, database name, server version, error text naming them) for administrators only
    if (ctx.user?.privileges.isAdmin && !ctx.user.user.mustChangePassword) {
      out.storage = services.state.location ? { kind: 'postgres', location: services.state.location } : null
      if (databaseError) out.databaseError = databaseError
      let database: string | undefined
      if (reachable && services.state.db) {
        try {
          database = await services.state.db.serverVersion()
        } catch {
          database = undefined
        }
      }
      out.server = { version: serverVersion(), node: process.version, schemaVersion: SCHEMA_VERSION, ...(database ? { database } : {}) }
    }
    return out
  }, { auth: 'none' })

  /** 20 wrong setup codes in 15 minutes: refuse for a while (the code is long; this only stops brute force) */
  const setupThrottle = new LoginThrottle(20, THROTTLE_WINDOW_MS)
  const checkSetupCode = async (ctx: Ctx, b: Record<string, unknown>) => {
    if (setupThrottle.blocked('setup')) throw new HttpError(429, 'rate_limited', 'Too many wrong setup codes. Try again in a few minutes.')
    if (!services.setupCode.current()) services.setupCode.issue()
    if (!services.setupCode.matches(givenSetupCode(ctx, b))) {
      setupThrottle.fail('setup')
      await audit(services, null, 'setup.code_rejected', { path: ctx.path })
      throw new HttpError(403, 'denied', 'The setup code is missing or wrong. It is shown in the window where the Appbuilder server runs.', 'setupCode')
    }
  }

  router.add('POST', '/setup/database', async (ctx) => {
    const b = obj(ctx.body) as Partial<SetupDatabaseRequest> & Record<string, unknown>
    const admin = !!ctx.user?.privileges.isAdmin && !ctx.user.user.mustChangePassword
    if (!admin) {
      if (services.state.incompatible) throw new HttpError(409, 'conflict', 'The database was upgraded by a newer Appbuilder. Run that version; the database cannot be changed from here.')
      if (services.setupComplete()) {
        throw new HttpError(services.ready() ? 403 : 409, services.ready() ? 'denied' : 'conflict', services.ready()
          ? 'Only an administrator can change the database.'
          : 'Setup is complete, but the database is not reachable right now. Start the database (Appbuilder reconnects by itself), or change workspace/server.json or APPBUILDER_DB_* and restart.')
      }
      if (services.ready()) {
        let users: number
        try {
          users = await services.meta.users.count()
        } catch {
          // the current database is unreachable: we cannot tell whether an administrator exists, so refuse
          throw new HttpError(503, 'unavailable', 'The database is not reachable right now; try again when it is back.')
        }
        if (users > 0) throw new HttpError(403, 'denied', 'Only an administrator can change the database.')
      }
      await checkSetupCode(ctx, b)
    }
    const host = text(b, 'host', 255).trim()
    const port = Number(b.port ?? 5432)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(422, 'invalid', 'Port must be between 1 and 65535.', 'port')
    const database = text(b, 'database', 64).trim()
    const user = text(b, 'user', 80).trim()
    const password = b.password === undefined || b.password === null ? '' : text(b, 'password', 1024, false)
    const ssl = b.ssl === true || b.ssl === 'true'
    await serialized(() => services.configureDatabase({ host, port, database, user, ssl }, password, { createDatabase: b.createDatabase === true, persist: true }))
    await audit(services, ctx.user?.user.id ?? null, 'setup.database', { host, port, database, user })
    // an administrator pointed Appbuilder at an empty database: it needs a first administrator again
    if ((await services.meta.users.count().catch(() => 1)) === 0) {
      services.markSetupComplete(false)
      if (admin) services.setupCode.issue()
    }
    return { ok: true }
  }, { auth: 'none', loopbackOnly: true })

  router.add('POST', '/setup/admin', async (ctx): Promise<Session> => {
    if (!services.ready()) throw new HttpError(503, 'unavailable', 'Configure the database first.')
    const b = obj(ctx.body) as Partial<SetupAdminRequest> & Record<string, unknown>
    if ((await services.meta.users.count()) > 0) throw new HttpError(409, 'conflict', 'Setup is already complete. Please sign in.')
    await checkSetupCode(ctx, b)
    const name = text(b, 'name', 255).trim()
    if (!name) throw new HttpError(422, 'invalid', 'name is required.', 'name')
    const email = checkEmail(text(b, 'email', 191))
    const password = checkPasswordPolicy(b.password, email)
    const hash = await hashPassword(password)
    const userId = await serialized(async () => {
      if ((await services.meta.users.count()) > 0) throw new HttpError(409, 'conflict', 'Setup is already complete. Please sign in.')
      await ensureBuiltinRoles(services)
      const id = services.uid('user')
      // the first administrator administers the install (environments, accounts) and holds the Administrator role in
      // Default, which also gives them access to it (MetaStore: a role in an environment grants access)
      await services.meta.users.insert({ id, name, email, roleIds: [ROLE_ADMIN], status: 'active', passwordHash: hash, lastLogin: new Date().toISOString(), isInstallAdmin: true, lastEnvironmentId: DEFAULT_ENVIRONMENT_ID }) // setup signs the administrator in
      services.security.invalidate()
      services.environments.invalidate()
      return id
    })
    services.markSetupComplete()
    services.setupCode.issue({ print: false }) // rotate: the printed code is useless from now on
    await audit(services, userId, 'setup.admin', { email })
    await audit(services, userId, 'user.create', { id: userId, email, roleIds: [ROLE_ADMIN], status: 'active', via: 'setup' })
    await services.install.audit({ userId, action: 'install.admin_grant', environmentId: null, details: { id: userId, email, via: 'setup' } }).catch((e) => log('error', `audit write failed (install.admin_grant): ${errText(e)}`))
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
    return (await userContextFor(services, rec, DEFAULT_ENVIRONMENT_ID, expires)).session()
  }, { auth: 'none', loopbackOnly: true })

  router.add('POST', '/auth/login', async (ctx): Promise<Session> => {
    if (!services.ready()) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    await idn.policy.get()
    const b = obj(ctx.body) as Partial<LoginRequest> & Record<string, unknown>
    const email = (typeof b.email === 'string' ? b.email : '').trim().toLowerCase().slice(0, 191)
    const password = typeof b.password === 'string' ? b.password.slice(0, 1024) : ''
    // H-B: the client's address as the rest of the server derives it (identity/util.ts clientIp): behind the one trusted
    // proxy (APPBUILDER_TRUST_PROXY=1, the hosted default) the X-Forwarded-For entry, else the TCP peer. Keyed on the peer
    // alone, every client behind the proxy or a Unix socket shared one key, so anyone could lock a known account out.
    // Without a trusted proxy the header is ignored: a client cannot choose its own key. The per-email backoff stays.
    const key = `${email}|${idn.ip(ctx.req)}`
    if (throttle.blocked(key)) {
      await audit(services, null, 'auth.login_throttled', { email })
      await idn.logSignIn(ctx, { email, outcome: 'failure', reason: 'throttled', method: 'password' })
      throw new HttpError(429, 'rate_limited', 'Too many attempts. Try again in a few minutes.')
    }
    const wait = emailBackoff.waitMs(email)
    if (wait > 0) {
      await audit(services, null, 'auth.login_throttled', { email, perEmail: true, waitSeconds: Math.ceil(wait / 1000) })
      await idn.logSignIn(ctx, { email, outcome: 'failure', reason: 'throttled', method: 'password' })
      throw new HttpError(429, 'rate_limited', `Too many attempts for this account. Try again in ${wait >= 60000 ? `${Math.ceil(wait / 60000)} minute(s)` : `${Math.ceil(wait / 1000)} second(s)`}.`)
    }
    const found = email ? await services.meta.users.byEmail(email) : null
    // service accounts never sign in with a password (API keys only)
    const user = found && found.kind !== 'service' ? found : null
    const ok = user && user.passwordHash && user.status !== 'disabled' ? await verifyPassword(password, user.passwordHash) : await verifyDummy(password)
    if (!ok || !user) {
      throttle.fail(key)
      if (email) emailBackoff.fail(email)
      await audit(services, user?.id ?? null, 'auth.login_failed', { email })
      await idn.logSignIn(ctx, { userId: found?.id ?? null, email, outcome: 'failure', reason: !found ? 'unknown_user' : found.status === 'disabled' ? 'disabled' : found.kind === 'service' ? 'service_account' : !found.passwordHash ? 'no_password' : 'bad_password', method: 'password' })
      throw new HttpError(401, 'unauthenticated', 'Invalid email or password.')
    }
    throttle.reset(key)
    emailBackoff.reset(email)
    // the password is older than the policy allows: it must be changed right after signing in
    if (!user.mustChangePassword && (await passwordExpired(services, user))) {
      await services.meta.users.update(user.id, { mustChangePassword: true })
      user.mustChangePassword = true
      await audit(services, user.id, 'auth.password_expired')
    }
    // second step: an authenticator code, a recovery code or an email code (unless this device is remembered)
    const methods = await idn.mfaMethods(user.id)
    if (methods.totp || methods.email) {
      if (await idn.rememberedDevice(ctx, user.id)) return finishSignIn(services, ctx, user, { method: 'remembered_device', mfa: true })
      await idn.revokeTokens(user.id, ['mfa_pending'])
      const pending = await idn.createToken('mfa_pending', user.id, { ttlMs: MFA_PENDING_MS })
      setCookie(ctx.req, ctx.res, MFA_COOKIE, pending.raw, MFA_PENDING_MS / 1000, { secureCookie: services.config?.secureCookie, trustProxy: services.config?.trustProxy })
      const available = [...(methods.totp ? ['totp', 'recovery_code'] : []), ...(methods.email ? ['email_code'] : [])]
      const rememberDays = idn.policy.cached().mfa.rememberDays
      throw new HttpError(401, 'mfa_required', 'Enter the code from your authenticator app to finish signing in.', undefined, { mfa: { methods: available, rememberDays } })
    }
    // two-step verification required by policy but not set up: after the grace period the session may only set it up
    const req = await idn.mfaRequirement(user)
    const restricted = req.required && req.enrolBy && req.enrolBy.getTime() <= Date.now() ? 'mfa_enrol' : null
    return finishSignIn(services, ctx, user, { method: 'password', restricted })
  }, { auth: 'none' })

  router.add('POST', '/auth/logout', async (ctx) => {
    const token = cookieValue(ctx.req, SESSION_COOKIE)
    if (token && token.length <= 200 && services.ready()) await services.meta.sessions.remove(hashToken(token))
    ctx.setSessionCookie(null)
    if (cookieOf(ctx.req, MFA_COOKIE)) setCookie(ctx.req, ctx.res, MFA_COOKIE, null, 0, { secureCookie: services.config?.secureCookie, trustProxy: services.config?.trustProxy })
    if (ctx.user) await audit(services, ctx.user.user.id, 'auth.logout')
    return { ok: true }
  }, { auth: 'none' })

  router.add('GET', '/auth/session', (ctx) => sessionPayload(services, ctx.user!), { auth: 'user', allowPendingPasswordChange: true, noEnvironment: true, allowPendingMfaEnrolment: true })

  router.add('POST', '/auth/password', async (ctx) => {
    const b = obj(ctx.body) as Partial<ChangePasswordRequest> & Record<string, unknown>
    const me = ctx.user!.user
    const key = me.id
    if (passwordThrottle.blocked(key)) throw new HttpError(429, 'rate_limited', 'Too many attempts. Try again in a few minutes.')
    const rec = await services.meta.users.get(me.id)
    if (!rec) throw new HttpError(401, 'unauthenticated', 'Please sign in.')
    const current = typeof b.current === 'string' ? b.current.slice(0, 1024) : ''
    if (!(await verifyPassword(current, rec.passwordHash))) {
      passwordThrottle.fail(key)
      await audit(services, me.id, 'auth.password_failed')
      throw new HttpError(422, 'invalid', 'The current password is not correct.', 'current')
    }
    const next = checkPasswordPolicy(b.next, rec.email, 'next')
    if (next === current) throw new HttpError(422, 'invalid', 'The new password must be different.', 'next')
    await checkPasswordHistory(services, rec, next, 'next')
    passwordThrottle.reset(key)
    const hash = await hashPassword(next)
    const mfa = !!requestSession(ctx.req)?.rec.mfa
    await services.meta.users.update(me.id, { passwordHash: hash, mustChangePassword: false })
    await recordPassword(services, me.id, hash)
    // signs out every other device and forgets remembered devices; this one stays signed in with a fresh token (rotation)
    await idn.signOutEverywhere(me.id)
    await createSession(services, ctx, me.id, { mfa })
    await audit(services, me.id, 'auth.password_changed', rec.mustChangePassword ? { forced: true } : undefined)
    if (await idn.mail.configured().catch(() => false)) {
      await idn.mail.sendTemplate('password_changed', rec.email, { name: rec.name, email: rec.email, when: new Date().toUTCString() }, rec.id).catch((e) => log('warn', `password-changed email not queued: ${errText(e)}`))
    }
    return { ok: true }
  }, { auth: 'user', allowPendingPasswordChange: true, noEnvironment: true, allowPendingMfaEnrolment: true })
}
