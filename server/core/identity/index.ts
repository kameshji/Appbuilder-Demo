/**
 * Identity basics (P0 package I): the shared state and operations behind sign-in, two-step verification, sessions,
 * one-time tokens, remembered devices, the sign-in log and outbound email. One instance per Services (identity(services)).
 * HTTP routes: routes.ts; API keys: api-keys.ts; design: docs/dev/auth.md.
 */
import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Ctx, SessionRecord, UserRecord } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import type { CoreServices } from '../services.ts'
import { errText, log, uid } from '../util.ts'
import { createMailService, type MailService } from './mail.ts'
import { createPolicyStore, type MfaMode, type PolicyStore } from './policy.ts'
import { base32Decode, verifyTotp } from './totp.ts'
import { clientIp, deviceName, normaliseCode, randomCode, randomToken, sameHash, setCookie, sha256 } from './util.ts'

export const MFA_COOKIE = 'ab_mfa'
export const DEVICE_COOKIE = 'ab_td'
export const KNOWN_COOKIE = 'ab_dev'
/** a pending second step lasts this long after the password was accepted */
export const MFA_PENDING_MS = 5 * 60 * 1000
/** wrong codes per pending second step before the password must be entered again */
export const MFA_PENDING_ATTEMPTS = 5
export const RESET_TTL_MS = 15 * 60 * 1000
export const ADMIN_RESET_TTL_MS = 24 * 60 * 60 * 1000
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000
export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000
export const RECOVERY_CODE_COUNT = 10
/** characters per recovery code (unambiguous alphabet of 31: about 79 bits) */
export const RECOVERY_CODE_LENGTH = 16
/** a sensitive action needs a sign-in or re-authentication this recent (APPBUILDER_REAUTH_SECONDS) */
export const reauthWindowMs = (): number => (Number(process.env.APPBUILDER_REAUTH_SECONDS) || 600) * 1000

export type TokenKind = 'reset' | 'invite' | 'email_change' | 'mfa_pending' | 'email_code' | 'email_setup'

export interface TokenRow {
  id: string
  kind: TokenKind
  userId: string
  createdOn: Date
  expiresOn: Date
  usedOn: Date | null
  createdBy: string | null
  attempts: number
  data: Record<string, unknown> | null
}

export type SignInOutcome = 'success' | 'failure'
export interface SignInEntry {
  userId?: string | null
  email?: string | null
  outcome: SignInOutcome
  /** success: ok; failure: bad_password, unknown_user, disabled, throttled, locked, bad_code, expired, replay, ip_denied, ... */
  reason: string
  /** password, totp, recovery_code, email_code, remembered_device, invitation, api_key */
  method: string
  sessionId?: string | null
  deviceHash?: string | null
  newDevice?: boolean
}

/** the session behind a request (cookie sessions only) */
export interface RequestSession { idHash: string; rec: SessionRecord }
const requestSessions = new WeakMap<IncomingMessage, RequestSession>()
export const noteRequestSession = (req: IncomingMessage, s: RequestSession): void => {
  requestSessions.set(req, s)
}
export const requestSession = (req: IncomingMessage): RequestSession | undefined => requestSessions.get(req)

/** simple sliding-window counters in memory (per process) */
export class Counter {
  private hits = new Map<string, number[]>()
  count(key: string, windowMs: number, now = Date.now()): number {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs)
    if (list.length) this.hits.set(key, list)
    else this.hits.delete(key)
    return list.length
  }
  add(key: string, now = Date.now()): void {
    const list = this.hits.get(key) ?? []
    list.push(now)
    this.hits.set(key, list)
    if (this.hits.size > 20000) for (const k of [...this.hits.keys()].slice(0, 10000)) this.hits.delete(k)
  }
  reset(key: string): void {
    this.hits.delete(key)
  }
}

export interface MfaRow {
  totpSecretSealed: string | null
  totpEnabledOn: Date | null
  totpLastStep: number | null
  totpPendingSealed: string | null
  totpPendingOn: Date | null
  emailEnabled: boolean
  recovery: { h: string; used: string | null }[]
  recoveryCreatedOn: Date | null
}

export interface Identity {
  services: CoreServices
  policy: PolicyStore
  mail: MailService
  counters: Counter
  ip(req: IncomingMessage): string
  /* sign-in log */
  logSignIn(ctx: Ctx, e: SignInEntry): Promise<void>
  /* tokens */
  createToken(kind: TokenKind, userId: string, o: { ttlMs: number; createdBy?: string | null; data?: Record<string, unknown>; raw?: string }): Promise<{ raw: string; id: string; expiresOn: Date }>
  findToken(kind: TokenKind, raw: string): Promise<TokenRow | null>
  /** marks the token used; false when someone else used it first (single use, atomic) */
  consumeToken(id: string): Promise<boolean>
  bumpTokenAttempts(id: string): Promise<number>
  revokeTokens(userId: string, kinds: TokenKind[]): Promise<number>
  pendingTokens(kind: TokenKind): Promise<TokenRow[]>
  /* two-step verification */
  mfaRow(userId: string): Promise<MfaRow | null>
  mfaMethods(userId: string): Promise<{ totp: boolean; email: boolean }>
  /** checks a TOTP code (replay-safe: the step is stored atomically); 'replay' when the code's step was used already */
  checkTotp(userId: string, code: string): Promise<'ok' | 'bad' | 'replay'>
  /** uses one recovery code (single use, atomic) */
  useRecoveryCode(userId: string, code: string): Promise<boolean>
  newRecoveryCodes(userId: string): Promise<string[]>
  /** who must use two-step verification under the policy; enrolBy: end of the grace period */
  mfaRequirement(user: UserRecord): Promise<{ required: boolean; enrolBy: Date | null }>
  /* remembered devices */
  rememberDevice(ctx: Ctx, userId: string): Promise<void>
  rememberedDevice(ctx: Ctx, userId: string): Promise<boolean>
  revokeDevices(userId: string, id?: string): Promise<number>
  /* known devices (new-device emails) */
  knownDevice(ctx: Ctx): string
  /** sessions and devices of a user end; tokens of the given kinds are revoked */
  signOutEverywhere(userId: string, o?: { devices?: boolean }): Promise<void>
}

const instances = new WeakMap<CoreServices, Identity>()

const toDate = (v: unknown): Date | null => (v === null || v === undefined ? null : new Date(v as string))
function toToken(r: Record<string, unknown>): TokenRow {
  return {
    id: String(r.id), kind: String(r.kind) as TokenKind, userId: String(r.user_id), createdOn: toDate(r.created_on)!, expiresOn: toDate(r.expires_on)!,
    usedOn: toDate(r.used_on), createdBy: r.created_by ? String(r.created_by) : null, attempts: Number(r.attempts) || 0,
    data: r.data && typeof r.data === 'object' ? (r.data as Record<string, unknown>) : null,
  }
}

export function identity(services: CoreServices): Identity {
  const existing = instances.get(services)
  if (existing) return existing
  const db = () => {
    const d = services.state.db
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }
  const policy = createPolicyStore(() => services.state.db)
  const mail = createMailService(services)
  const counters = new Counter()
  const trustProxy = !!services.config?.trustProxy
  const cookieOpts = { secureCookie: services.config?.secureCookie, trustProxy: services.config?.trustProxy }
  const ip = (req: IncomingMessage) => clientIp(req, trustProxy)

  const id: Identity = {
    services,
    policy,
    mail,
    counters,
    ip,

    async logSignIn(ctx, e) {
      try {
        await db().exec(
          `INSERT INTO "ab"."signin_log" (at, user_id, email, outcome, reason, method, ip, user_agent, session_id, device_hash, new_device) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [new Date(), e.userId ?? null, e.email ? e.email.slice(0, 191) : null, e.outcome, e.reason, e.method, ip(ctx.req), String(ctx.req.headers['user-agent'] ?? '').slice(0, 255) || null, e.sessionId ?? null, e.deviceHash ?? null, !!e.newDevice],
        )
      } catch (err) {
        log('error', `sign-in log write failed: ${errText(err)}`)
      }
    },

    async createToken(kind, userId, o) {
      const raw = o.raw ?? randomToken(32)
      const tid = uid('tok')
      const expiresOn = new Date(Date.now() + o.ttlMs)
      await db().exec(
        `INSERT INTO "ab"."auth_tokens" (id, kind, user_id, token_hash, created_on, expires_on, created_by, data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [tid, kind, userId, sha256(`${kind}:${normaliseToken(kind, raw)}`), new Date(), expiresOn, o.createdBy ?? null, o.data ? JSON.stringify(o.data) : null],
      )
      return { raw, id: tid, expiresOn }
    },
    async findToken(kind, raw) {
      if (typeof raw !== 'string' || !raw || raw.length > 200) return null
      const rows = await db().query<Record<string, unknown>>(
        `SELECT * FROM "ab"."auth_tokens" WHERE token_hash = $1 AND kind = $2 AND used_on IS NULL AND expires_on > now()`,
        [sha256(`${kind}:${normaliseToken(kind, raw)}`), kind],
      )
      return rows.length ? toToken(rows[0]) : null
    },
    async consumeToken(tid) {
      const rows = await db().query(`UPDATE "ab"."auth_tokens" SET used_on = now() WHERE id = $1 AND used_on IS NULL AND expires_on > now() RETURNING id`, [tid])
      return rows.length === 1
    },
    async bumpTokenAttempts(tid) {
      const rows = await db().query<{ attempts: number }>(`UPDATE "ab"."auth_tokens" SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`, [tid])
      return Number(rows[0]?.attempts) || 0
    },
    async revokeTokens(userId, kinds) {
      const r = await db().exec(`UPDATE "ab"."auth_tokens" SET used_on = now() WHERE user_id = $1 AND kind = ANY($2::text[]) AND used_on IS NULL`, [userId, kinds])
      return r.affectedRows
    },
    async pendingTokens(kind) {
      const rows = await db().query<Record<string, unknown>>(`SELECT * FROM "ab"."auth_tokens" WHERE kind = $1 AND used_on IS NULL AND expires_on > now() ORDER BY created_on DESC`, [kind])
      return rows.map(toToken)
    },

    async mfaRow(userId) {
      const rows = await db().query<Record<string, unknown>>(`SELECT * FROM "ab"."user_mfa" WHERE user_id = $1`, [userId])
      if (!rows.length) return null
      const r = rows[0]
      return {
        totpSecretSealed: r.totp_secret_sealed ? String(r.totp_secret_sealed) : null,
        totpEnabledOn: toDate(r.totp_enabled_on),
        totpLastStep: r.totp_last_step === null || r.totp_last_step === undefined ? null : Number(r.totp_last_step),
        totpPendingSealed: r.totp_pending_sealed ? String(r.totp_pending_sealed) : null,
        totpPendingOn: toDate(r.totp_pending_on),
        emailEnabled: r.email_enabled === true,
        recovery: Array.isArray(r.recovery) ? (r.recovery as MfaRow['recovery']) : [],
        recoveryCreatedOn: toDate(r.recovery_created_on),
      }
    },
    async mfaMethods(userId) {
      const r = await id.mfaRow(userId)
      const emailOk = !!r?.emailEnabled && (await policy.get()).mfa.emailCodes && (await mail.configured())
      return { totp: !!r?.totpEnabledOn && !!r.totpSecretSealed, email: emailOk }
    },
    async checkTotp(userId, code) {
      const r = await id.mfaRow(userId)
      if (!r?.totpEnabledOn || !r.totpSecretSealed) return 'bad'
      let secret: Buffer
      try {
        secret = base32Decode(services.secrets.decrypt(r.totpSecretSealed))
      } catch {
        log('error', `two-step secret of user ${userId} cannot be decrypted (secret key replaced?)`)
        return 'bad'
      }
      const step = verifyTotp(secret, code)
      if (step === null) return 'bad'
      // replay protection: the step must be newer than the last one accepted, stored atomically
      const ok = await db().query(
        `UPDATE "ab"."user_mfa" SET totp_last_step = $2, modified_on = now() WHERE user_id = $1 AND totp_enabled_on IS NOT NULL AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING user_id`,
        [userId, step],
      )
      return ok.length ? 'ok' : 'replay'
    },
    async useRecoveryCode(userId, code) {
      const given = sha256(normaliseCode(code))
      return db().tx(async (tx) => {
        const rows = await tx.query<{ recovery: MfaRow['recovery'] | null }>(`SELECT recovery FROM "ab"."user_mfa" WHERE user_id = $1 FOR UPDATE`, [userId])
        const list = Array.isArray(rows[0]?.recovery) ? rows[0].recovery! : []
        let hit = -1
        list.forEach((c, i) => {
          if (sameHash(c.h, given) && !c.used && hit < 0) hit = i
        })
        if (hit < 0) return false
        list[hit] = { ...list[hit], used: new Date().toISOString() }
        await tx.exec(`UPDATE "ab"."user_mfa" SET recovery = $2::jsonb, modified_on = now() WHERE user_id = $1`, [userId, JSON.stringify(list)])
        return true
      })
    },
    async newRecoveryCodes(userId) {
      const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomCode(RECOVERY_CODE_LENGTH))
      const stored = codes.map((c) => ({ h: sha256(normaliseCode(c)), used: null }))
      await db().exec(
        `INSERT INTO "ab"."user_mfa" (user_id, recovery, recovery_created_on, modified_on) VALUES ($1, $2::jsonb, now(), now())
         ON CONFLICT (user_id) DO UPDATE SET recovery = EXCLUDED.recovery, recovery_created_on = now(), modified_on = now()`,
        [userId, JSON.stringify(stored)],
      )
      return codes
    },
    async mfaRequirement(user) {
      if (user.kind === 'service') return { required: false, enrolBy: null }
      const p = await policy.get()
      const envModes = Object.entries(p.mfa.environments).filter(([, m]) => m !== 'off')
      if (p.mfa.mode === 'off' && !envModes.length) return { required: false, enrolBy: null }
      const rows = await db().query<{ created_on: string; access: { env: string; admin: boolean }[] }>(
        `SELECT u.created_on, COALESCE(json_agg(json_build_object('env', a.environment_id, 'admin', a.is_env_admin)) FILTER (WHERE a.environment_id IS NOT NULL), '[]') AS access
           FROM "ab"."users" u LEFT JOIN "ab"."environment_access" a ON a.user_id = u.id WHERE u.id = $1 GROUP BY u.id`,
        [user.id],
      )
      if (!rows.length) return { required: false, enrolBy: null }
      const access = rows[0].access ?? []
      const anyAdmin = !!user.isInstallAdmin || access.some((a) => a.admin)
      const applies = (mode: MfaMode, admin: boolean) => mode === 'all' || (mode === 'admins' && admin)
      let required = applies(p.mfa.mode, anyAdmin)
      for (const [env, mode] of envModes) {
        if (required) break
        const a = access.find((x) => x.env === env)
        if (user.isInstallAdmin) required = applies(mode, true)
        else if (a) required = applies(mode, a.admin)
      }
      if (!required) return { required: false, enrolBy: null }
      const created = new Date(rows[0].created_on).getTime()
      const since = p.mfa.since ? new Date(p.mfa.since).getTime() : created
      const start = Math.max(created, since)
      return { required: true, enrolBy: new Date(start + p.mfa.graceDays * 24 * 60 * 60 * 1000) }
    },

    async rememberDevice(ctx, userId) {
      const p = await policy.get()
      if (!p.mfa.rememberDays) return
      const did = uid('dev')
      const expiresOn = new Date(Date.now() + p.mfa.rememberDays * 24 * 60 * 60 * 1000)
      await db().exec(
        `INSERT INTO "ab"."trusted_devices" (id, user_id, created_on, expires_on, user_agent, ip) VALUES ($1, $2, now(), $3, $4, $5)`,
        [did, userId, expiresOn, String(ctx.req.headers['user-agent'] ?? '').slice(0, 255) || null, ip(ctx.req)],
      )
      // AES-256-GCM (the secret box): the cookie cannot be read or changed without the install's secret key
      const sealed = services.secrets.encrypt(JSON.stringify({ u: userId, d: did, x: expiresOn.getTime() }))
      setCookie(ctx.req, ctx.res, DEVICE_COOKIE, sealed, (expiresOn.getTime() - Date.now()) / 1000, cookieOpts)
    },
    async rememberedDevice(ctx, userId) {
      const raw = cookieOf(ctx.req, DEVICE_COOKIE)
      if (!raw || raw.length > 600) return false
      let v: { u?: unknown; d?: unknown; x?: unknown }
      try {
        v = JSON.parse(services.secrets.decrypt(raw)) as typeof v
      } catch {
        return false // tampered with, or sealed with another key
      }
      if (v.u !== userId || typeof v.d !== 'string' || typeof v.x !== 'number' || v.x <= Date.now()) return false
      const rows = await db().query(`UPDATE "ab"."trusted_devices" SET last_used_on = now() WHERE id = $1 AND user_id = $2 AND expires_on > now() RETURNING id`, [v.d, userId])
      return rows.length === 1
    },
    async revokeDevices(userId, did) {
      const r = did
        ? await db().exec(`DELETE FROM "ab"."trusted_devices" WHERE user_id = $1 AND id = $2`, [userId, did])
        : await db().exec(`DELETE FROM "ab"."trusted_devices" WHERE user_id = $1`, [userId])
      return r.affectedRows
    },

    knownDevice(ctx) {
      let v = cookieOf(ctx.req, KNOWN_COOKIE)
      if (!v || !/^[A-Za-z0-9_-]{16,64}$/.test(v)) {
        v = randomBytes(18).toString('base64url')
        setCookie(ctx.req, ctx.res, KNOWN_COOKIE, v, 400 * 24 * 60 * 60, cookieOpts)
      }
      return sha256(`device:${v}`)
    },

    async signOutEverywhere(userId, o = {}) {
      await services.meta.sessions.removeForUser(userId)
      if (o.devices !== false) await id.revokeDevices(userId)
      await db().exec(`UPDATE "ab"."auth_tokens" SET used_on = now() WHERE user_id = $1 AND kind IN ('mfa_pending', 'email_code') AND used_on IS NULL`, [userId])
    },
  }
  instances.set(services, id)
  // read the stored policy once (password rules follow it); a database that is not ready yet is read later
  void policy.get().catch(() => {})
  return id
}

/** codes typed by people are compared without case, spaces or dashes; long random tokens exactly */
function normaliseToken(kind: TokenKind, raw: string): string {
  return kind === 'email_code' || kind === 'email_setup' || raw.length <= 24 ? normaliseCode(raw) : raw
}

export function cookieOf(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim())
      } catch {
        return null
      }
    }
  }
  return null
}

/** the public id of a session as shown in lists (a fresh random id at sign-in) */
export const newSessionPublicId = (): string => randomBytes(12).toString('base64url')

export { deviceName }

/**
 * Sensitive actions (changing the sign-in email, turning two-step verification off, creating API keys, deleting an
 * environment, exporting all data) call this: the session must have proven the password or a code within
 * reauthWindowMs (sign-in or POST /auth/reauth). API keys never qualify. Throws 403 reauth_required.
 */
export function requireRecentAuth(ctx: Ctx): void {
  const s = requestSession(ctx.req)
  if (!s) throw new HttpError(403, 'reauth_required', 'Confirm it is you: enter your password (or a code from your authenticator app) first.')
  const at = s.rec.authOn?.getTime() ?? 0
  if (Date.now() - at > reauthWindowMs()) {
    throw new HttpError(403, 'reauth_required', 'Confirm it is you: enter your password (or a code from your authenticator app) first.')
  }
}
