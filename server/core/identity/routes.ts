/**
 * HTTP routes of identity basics (P0 package I). Reference with examples: docs/dev/auth.md; admin guide:
 * docs/admin/sign-in-and-identity.md.
 *
 * Anonymous:  GET  /auth/identity-info               POST /auth/login/verify        POST /auth/login/email-code
 *             POST /auth/password/forgot              POST /auth/password/reset/check POST /auth/password/reset
 *             POST /auth/invitation/check             POST /auth/invitation/accept   POST /auth/email/confirm
 * Signed in:  GET  /auth/security    POST /auth/reauth   POST /auth/email/change
 *             POST /auth/mfa/totp/start|confirm   DELETE /auth/mfa/totp   POST /auth/mfa/email/start|confirm
 *             DELETE /auth/mfa/email   POST /auth/mfa/recovery-codes
 *             GET  /auth/sessions   DELETE /auth/sessions/:id   POST /auth/sessions/revoke-others
 *             DELETE /auth/devices/:id   DELETE /auth/devices   GET /auth/signins
 * Admins:     GET /identity/users   GET /identity/signins   GET|PUT /identity/policy   GET|PUT|DELETE /identity/email
 *             POST /identity/email/test   GET /identity/email/log
 *             GET|DELETE /users/:id/sessions   DELETE /users/:id/sessions/:sid   POST /users/:id/mfa/reset
 *             POST /users/:id/reset-code   POST|DELETE /users/:id/invite
 *             GET|POST /identity/service-accounts   PATCH|DELETE /identity/service-accounts/:id
 *             POST /identity/service-accounts/:id/keys   DELETE /identity/service-accounts/:id/keys/:kid
 */
import type { Ctx, UserRecord } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import type { ApiRouter } from '../router.ts'
import type { CoreServices } from '../services.ts'
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../password.ts'
import { randomBytes } from 'node:crypto'
import { checkEmail, finishSignIn, hashToken } from '../auth.ts'
import { emitSessionEvent } from '../live/session-events.ts'
import { DEFAULT_ENVIRONMENT_ID, runInEnvironment } from '../env-context.ts'
import { errText, log, uid } from '../util.ts'
import {
  ADMIN_RESET_TTL_MS, EMAIL_CHANGE_TTL_MS, EMAIL_CODE_TTL_MS, INVITE_TTL_MS, MFA_COOKIE, MFA_PENDING_ATTEMPTS, RESET_TTL_MS,
  cookieOf, deviceName, identity, reauthWindowMs, requestSession, requireRecentAuth, type Identity,
} from './index.ts'
import { checkPasswordHistory, recordPassword } from './passwords.ts'
import { mergePolicy, tightened } from './policy.ts'
import { base32Decode, base32Encode, groupKey, newTotpSecret, otpauthUri, verifyTotp } from './totp.ts'
import { qrSvg } from './qr.ts'
import { normaliseCode, numericCode, randomCode, setCookie } from './util.ts'
import { DEFAULT_RATE_PER_MINUTE, checkIpAllow, newApiKey, toKey } from './api-keys.ts'

const obj = (body: unknown): Record<string, unknown> => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(422, 'invalid', 'Request body must be a JSON object.')
  return body as Record<string, unknown>
}
const strOf = (v: unknown, max = 1024): string => (typeof v === 'string' ? v.slice(0, max) : '')
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null)
const intParam = (v: string | null, def: number, min: number, max: number): number => {
  const n = v === null || v === '' ? def : Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(422, 'invalid', `A number from ${min} to ${max} is expected.`)
  return n
}
const maskEmail = (e: string): string => e.replace(/^(.)(.*)(@.*)$/, (_, a: string, b: string, c: string) => `${a}${'*'.repeat(Math.min(6, Math.max(1, b.length)))}${c}`)

/** a sliding-window limit: throws 429 when reached (does not count this attempt) */
function limit(idn: Identity, key: string, max: number, windowMs: number, message = 'Too many attempts. Try again in a few minutes.'): void {
  if (idn.counters.count(key, windowMs) >= max) throw new HttpError(429, 'rate_limited', message)
}

export function identityRoutes(router: ApiRouter, services: CoreServices): void {
  const idn = identity(services)
  const s = services
  const db = () => {
    const d = s.state.db
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }
  const cookieOpts = { secureCookie: s.config?.secureCookie, trustProxy: s.config?.trustProxy }
  const me = (ctx: Ctx) => ctx.user!.user
  const installAdmin = (ctx: Ctx, what: string) => {
    if (!ctx.user?.privileges.isInstallAdmin) throw new HttpError(403, 'denied', `Only install administrators can ${what}.`)
  }
  async function audit(_ctx: Ctx | null, userId: string | null, action: string, details?: unknown, install = false) {
    try {
      await s.meta.audit({ userId, action, details })
      if (install) await s.install.audit({ userId, action, environmentId: null, details })
    } catch (e) {
      log('error', `audit write failed (${action}): ${errText(e)}`)
    }
  }
  /** links in emails: the configured public address, else this request's own origin (its Host passed the allow-list) */
  async function baseUrl(ctx: Ctx): Promise<string> {
    const b = await idn.mail.brand()
    if (b.publicUrl) return b.publicUrl
    const secure = (ctx.req.socket as { encrypted?: boolean }).encrypted || s.config?.secureCookie || (s.config?.trustProxy && String(ctx.req.headers['x-forwarded-proto'] ?? '').startsWith('https'))
    return `${secure ? 'https' : 'http'}://${String(ctx.req.headers.host ?? 'localhost')}`
  }
  const userOrThrow = async (id: string) => {
    const u = await s.meta.users.get(id)
    if (!u) throw new HttpError(404, 'not-found', 'User not found.')
    return u
  }
  const person = (u: UserRecord) => {
    if (u.kind === 'service') throw new HttpError(409, 'conflict', 'This is a service account: it signs in with API keys only.')
  }

  /* ================================================================ anonymous */

  router.add('GET', '/auth/identity-info', async () => {
    if (!s.ready()) return { email: false, emailCodes: false, passwordMinLength: 10, rememberDays: 0 }
    const p = await idn.policy.get()
    const email = await idn.mail.configured().catch(() => false)
    return { email, emailCodes: email && p.mfa.emailCodes, passwordMinLength: p.password.minLength, rememberDays: p.mfa.rememberDays }
  }, { auth: 'none' })

  /* ---------------------------------------------------------------- second step */

  async function pending(ctx: Ctx) {
    const raw = cookieOf(ctx.req, MFA_COOKIE)
    const t = raw ? await idn.findToken('mfa_pending', raw) : null
    if (!t) throw new HttpError(401, 'unauthenticated', 'Your sign-in has expired. Enter your email and password again.')
    const user = await s.meta.users.get(t.userId)
    if (!user || user.status === 'disabled') throw new HttpError(401, 'unauthenticated', 'Your sign-in has expired. Enter your email and password again.')
    return { t, user }
  }

  router.add('POST', '/auth/login/verify', async (ctx) => {
    const b = obj(ctx.body)
    const { t, user } = await pending(ctx)
    const p = await idn.policy.get()
    const lockKey = `mfa-fail:${user.id}`
    const lockMs = p.lockout.mfaLockMinutes * 60_000
    if (idn.counters.count(lockKey, lockMs) >= p.lockout.mfaAttempts) {
      await idn.logSignIn(ctx, { userId: user.id, email: user.email, outcome: 'failure', reason: 'locked', method: 'second_step' })
      throw new HttpError(429, 'rate_limited', `Too many wrong codes. The second step of this account is locked for ${p.lockout.mfaLockMinutes} minutes.`)
    }
    const method = b.method === 'recovery_code' || b.method === 'email_code' ? b.method : 'totp'
    const code = strOf(b.code, 64)
    let ok = false
    let reason = 'bad_code'
    if (method === 'totp') {
      const r = await idn.checkTotp(user.id, code)
      ok = r === 'ok'
      if (r === 'replay') reason = 'replay'
    } else if (method === 'recovery_code') {
      ok = await idn.useRecoveryCode(user.id, code)
    } else {
      const et = await idn.findToken('email_code', `${user.id}.${normaliseCode(code)}`)
      ok = !!et && et.userId === user.id && (await idn.consumeToken(et.id))
    }
    if (!ok) {
      idn.counters.add(lockKey)
      const attempts = await idn.bumpTokenAttempts(t.id)
      await idn.logSignIn(ctx, { userId: user.id, email: user.email, outcome: 'failure', reason, method })
      await audit(ctx, user.id, 'auth.mfa_failed', { method, reason })
      if (attempts >= MFA_PENDING_ATTEMPTS) {
        await idn.consumeToken(t.id)
        setCookie(ctx.req, ctx.res, MFA_COOKIE, null, 0, cookieOpts)
        throw new HttpError(401, 'unauthenticated', 'Too many wrong codes. Enter your email and password again.')
      }
      throw new HttpError(422, 'invalid', reason === 'replay' ? 'That code was already used. Wait for the next code in your app.' : 'That code is not correct.', 'code')
    }
    if (!(await idn.consumeToken(t.id))) throw new HttpError(401, 'unauthenticated', 'Your sign-in has expired. Enter your email and password again.')
    idn.counters.reset(lockKey)
    if (method === 'recovery_code') await audit(ctx, user.id, 'auth.recovery_code_used')
    if (b.remember === true) await idn.rememberDevice(ctx, user.id)
    return finishSignIn(s, ctx, user, { method, mfa: true })
  }, { auth: 'none' })

  router.add('POST', '/auth/login/email-code', async (ctx) => {
    const { t, user } = await pending(ctx)
    const methods = await idn.mfaMethods(user.id)
    if (!methods.email) throw new HttpError(409, 'conflict', 'Email codes are not available for this account.')
    limit(idn, `email-code:${t.id}`, 3, MFA_PENDING_ATTEMPTS * 60_000, 'Codes were sent several times. Use the last one, or enter your password again.')
    if (idn.counters.count(`email-code-last:${t.id}`, 30_000) > 0) throw new HttpError(429, 'rate_limited', 'A code was just sent. Wait half a minute before asking again.')
    idn.counters.add(`email-code:${t.id}`)
    idn.counters.add(`email-code-last:${t.id}`)
    await idn.revokeTokens(user.id, ['email_code'])
    const code = numericCode(6)
    await idn.createToken('email_code', user.id, { ttlMs: EMAIL_CODE_TTL_MS, raw: `${user.id}.${code}` })
    await idn.mail.sendTemplate('signin_code', user.email, { name: user.name, code, minutes: EMAIL_CODE_TTL_MS / 60_000 }, user.id)
    return { ok: true, sentTo: maskEmail(user.email) }
  }, { auth: 'none' })

  /* ---------------------------------------------------------------- forgot / reset password */

  router.add('POST', '/auth/password/forgot', async (ctx) => {
    const b = obj(ctx.body)
    const email = strOf(b.email, 191).trim().toLowerCase()
    const ip = idn.ip(ctx.req)
    // per address: refuse floods; per email: silently stop after 3 an hour (nobody can mail-bomb an inbox through us)
    limit(idn, `forgot-ip:${ip}`, 20, 15 * 60_000)
    idn.counters.add(`forgot-ip:${ip}`)
    const emailConfigured = await idn.mail.configured().catch(() => false)
    const perEmail = `forgot-email:${email}`
    const allowed = !!email && idn.counters.count(perEmail, 60 * 60_000) < 3
    if (allowed) idn.counters.add(perEmail)
    // the answer is the same whether or not the account exists, and is sent before any per-account work starts
    // (the lookup, the token and the email run after the response has gone out), so timing tells nothing either
    if (allowed && emailConfigured) {
      const origin = await baseUrl(ctx)
      ctx.res.once('finish', () => {
        void (async () => {
          const user = await s.meta.users.byEmail(email)
          if (!user || user.status === 'disabled' || user.kind === 'service') {
            await audit(null, null, 'auth.reset_requested', { email, sent: false })
            return
          }
          await idn.revokeTokens(user.id, ['reset'])
          const t = await idn.createToken('reset', user.id, { ttlMs: RESET_TTL_MS })
          await idn.mail.sendTemplate('password_reset', user.email, { name: user.name, email: user.email, link: `${origin}/#reset=${t.raw}`, minutes: RESET_TTL_MS / 60_000 }, user.id)
          await audit(null, user.id, 'auth.reset_requested', { email, sent: true })
        })().catch((e) => log('warn', `password reset email: ${errText(e)}`))
      })
    }
    return {
      ok: true,
      email: emailConfigured,
      message: emailConfigured
        ? 'If an account uses this address, an email with a link to choose a new password is on its way. The link works for 15 minutes.'
        : 'Email is not set up on this server. Ask an administrator for a one-time reset code, then choose "I have a reset code".',
    }
  }, { auth: 'none' })

  /** a reset link token, or an email plus an administrator's one-time code */
  async function resetToken(b: Record<string, unknown>, ctx: Ctx) {
    const ip = idn.ip(ctx.req)
    limit(idn, `reset-fail:${ip}`, 10, 15 * 60_000)
    const token = strOf(b.token, 200)
    const email = strOf(b.email, 191).trim().toLowerCase()
    const code = strOf(b.code, 64)
    if (email) limit(idn, `reset-fail-email:${email}`, 10, 60 * 60_000)
    const t = token ? await idn.findToken('reset', token) : code ? await idn.findToken('reset', code) : null
    const user = t ? await s.meta.users.get(t.userId) : null
    const fine = !!t && !!user && user.status !== 'disabled' && (!!token || user.email === email)
    if (!fine) {
      idn.counters.add(`reset-fail:${ip}`)
      if (email) idn.counters.add(`reset-fail-email:${email}`)
      await idn.logSignIn(ctx, { userId: null, email: email || null, outcome: 'failure', reason: 'bad_reset_token', method: token ? 'reset_link' : 'reset_code' })
      throw new HttpError(422, 'invalid', token ? 'This reset link is not valid any more (it works once, for 15 minutes). Ask for a new one.' : 'The email and code do not match a valid reset code.', token ? 'token' : 'code')
    }
    return { t: t!, user: user! }
  }

  router.add('POST', '/auth/password/reset/check', async (ctx) => {
    const { user, t } = await resetToken(obj(ctx.body), ctx)
    return { ok: true, email: user.email, expiresOn: t.expiresOn.toISOString() }
  }, { auth: 'none' })

  router.add('POST', '/auth/password/reset', async (ctx) => {
    const b = obj(ctx.body)
    const { user, t } = await resetToken(b, ctx)
    const password = checkPasswordPolicy(b.password, user.email)
    await checkPasswordHistory(s, user, password)
    if (!(await idn.consumeToken(t.id))) throw new HttpError(422, 'invalid', 'This reset code was used already.', 'token')
    const hash = await hashPassword(password)
    await s.meta.users.update(user.id, { passwordHash: hash, mustChangePassword: false })
    await recordPassword(s, user.id, hash)
    await idn.revokeTokens(user.id, ['reset'])
    // every session ends and remembered devices are forgotten; two-step verification still applies at the next sign-in
    await idn.signOutEverywhere(user.id)
    await audit(ctx, user.id, 'auth.password_reset', { via: b.token ? 'email_link' : 'admin_code' }, true)
    if (await idn.mail.configured().catch(() => false)) {
      await idn.mail.sendTemplate('password_changed', user.email, { name: user.name, email: user.email, when: new Date().toUTCString() }, user.id).catch(() => {})
    }
    return { ok: true }
  }, { auth: 'none' })

  /* ---------------------------------------------------------------- invitations */

  async function inviteToken(b: Record<string, unknown>, ctx: Ctx) {
    const ip = idn.ip(ctx.req)
    limit(idn, `invite-fail:${ip}`, 10, 15 * 60_000)
    const t = await idn.findToken('invite', strOf(b.token, 200))
    const user = t ? await s.meta.users.get(t.userId) : null
    if (!t || !user || user.status === 'disabled' || user.kind === 'service') {
      idn.counters.add(`invite-fail:${ip}`)
      throw new HttpError(422, 'invalid', 'This invitation is not valid any more (it was used, revoked or has expired). Ask your administrator to send a new one.', 'token')
    }
    return { t, user }
  }
  router.add('POST', '/auth/invitation/check', async (ctx) => {
    const { t, user } = await inviteToken(obj(ctx.body), ctx)
    return { ok: true, email: user.email, name: user.name, expiresOn: t.expiresOn.toISOString() }
  }, { auth: 'none' })

  router.add('POST', '/auth/invitation/accept', async (ctx) => {
    const b = obj(ctx.body)
    const { t, user } = await inviteToken(b, ctx)
    const password = checkPasswordPolicy(b.password, user.email)
    if (!(await idn.consumeToken(t.id))) throw new HttpError(422, 'invalid', 'This invitation was used already.', 'token')
    const hash = await hashPassword(password)
    await s.meta.users.update(user.id, { passwordHash: hash, mustChangePassword: false })
    await recordPassword(s, user.id, hash)
    await idn.revokeTokens(user.id, ['invite'])
    await audit(ctx, user.id, 'user.invitation_accepted', { id: user.id, email: user.email }, true)
    const fresh = (await s.meta.users.get(user.id)) ?? user
    const req = await idn.mfaRequirement(fresh)
    return finishSignIn(s, ctx, fresh, { method: 'invitation', restricted: req.required && req.enrolBy && req.enrolBy.getTime() <= Date.now() ? 'mfa_enrol' : null })
  }, { auth: 'none' })

  /* ---------------------------------------------------------------- email change */

  router.add('POST', '/auth/email/change', async (ctx) => {
    requireRecentAuth(ctx)
    const u = await userOrThrow(me(ctx).id)
    const email = checkEmail(strOf(obj(ctx.body).email, 191))
    if (email === u.email) throw new HttpError(422, 'invalid', 'That is already your email address.', 'email')
    if (!(await idn.mail.configured())) throw new HttpError(409, 'conflict', 'Email is not set up on this server, so a new address cannot be confirmed. Ask an install administrator to change it in Admin console > Users.')
    if (await s.meta.users.byEmail(email)) throw new HttpError(409, 'conflict', 'Another account uses this email address.', 'email')
    limit(idn, `email-change:${u.id}`, 5, 60 * 60_000)
    idn.counters.add(`email-change:${u.id}`)
    await idn.revokeTokens(u.id, ['email_change'])
    const t = await idn.createToken('email_change', u.id, { ttlMs: EMAIL_CHANGE_TTL_MS, data: { email } })
    const origin = await baseUrl(ctx)
    await idn.mail.sendTemplate('email_change', email, { name: u.name, newEmail: email, link: `${origin}/#confirm-email=${t.raw}` }, u.id)
    await idn.mail.sendTemplate('email_changed', u.email, { name: u.name, newEmail: email, when: new Date().toUTCString() }, u.id)
    await audit(ctx, u.id, 'user.email_change_requested', { id: u.id, email: u.email, newEmail: email })
    return { ok: true, sentTo: email }
  }, { auth: 'user', noEnvironment: true })

  router.add('POST', '/auth/email/confirm', async (ctx) => {
    const ip = idn.ip(ctx.req)
    limit(idn, `email-confirm-fail:${ip}`, 10, 15 * 60_000)
    const t = await idn.findToken('email_change', strOf(obj(ctx.body).token, 200))
    const user = t ? await s.meta.users.get(t.userId) : null
    const email = typeof t?.data?.email === 'string' ? t.data.email : ''
    if (!t || !user || !email) {
      idn.counters.add(`email-confirm-fail:${ip}`)
      throw new HttpError(422, 'invalid', 'This confirmation link is not valid any more (it works once, for 24 hours).', 'token')
    }
    const other = await s.meta.users.byEmail(email)
    if (other && other.id !== user.id) throw new HttpError(409, 'conflict', 'Another account uses this email address now.')
    if (!(await idn.consumeToken(t.id))) throw new HttpError(422, 'invalid', 'This confirmation link was used already.', 'token')
    await s.meta.users.update(user.id, { email })
    await idn.revokeTokens(user.id, ['reset', 'email_change'])
    s.security.invalidate('all')
    await audit(ctx, user.id, 'user.email_changed', { id: user.id, before: user.email, after: email }, true)
    return { ok: true, email }
  }, { auth: 'none' })

  /* ================================================================ signed in: own security */

  router.add('GET', '/auth/security', async (ctx) => {
    const u = await userOrThrow(me(ctx).id)
    const row = await idn.mfaRow(u.id)
    const p = await idn.policy.get()
    const emailConfigured = await idn.mail.configured().catch(() => false)
    const req = await idn.mfaRequirement(u)
    const devices = await db().query<Record<string, unknown>>(`SELECT * FROM "ab"."trusted_devices" WHERE user_id = $1 AND expires_on > now() ORDER BY created_on DESC`, [u.id])
    const pendingEmail = await db().query<{ data: { email?: string } }>(`SELECT data FROM "ab"."auth_tokens" WHERE user_id = $1 AND kind = 'email_change' AND used_on IS NULL AND expires_on > now() ORDER BY created_on DESC LIMIT 1`, [u.id])
    const rs = requestSession(ctx.req)
    const authOn = rs?.rec.authOn?.getTime() ?? 0
    return {
      mfa: {
        totp: row?.totpEnabledOn && row.totpSecretSealed ? { enabledOn: row.totpEnabledOn.toISOString() } : null,
        email: !!row?.emailEnabled,
        recovery: row?.recovery.length ? { total: row.recovery.length, remaining: row.recovery.filter((c) => !c.used).length, createdOn: iso(row.recoveryCreatedOn) } : null,
      },
      required: req.required ? { enrolBy: req.enrolBy?.toISOString() ?? null } : null,
      emailConfigured,
      emailCodesAvailable: emailConfigured && p.mfa.emailCodes,
      rememberDays: p.mfa.rememberDays,
      devices: devices.map((d) => ({ id: String(d.id), device: deviceName(d.user_agent as string), ip: d.ip ? String(d.ip) : null, createdOn: iso(d.created_on), lastUsedOn: iso(d.last_used_on), expiresOn: iso(d.expires_on) })),
      pendingEmail: pendingEmail[0]?.data?.email ?? null,
      passwordChangedOn: u.passwordChangedOn ?? null,
      reauthUntil: authOn ? new Date(authOn + reauthWindowMs()).toISOString() : null,
    }
  }, { auth: 'user', noEnvironment: true, allowPendingMfaEnrolment: true })

  router.add('POST', '/auth/reauth', async (ctx) => {
    const b = obj(ctx.body)
    const u = await userOrThrow(me(ctx).id)
    const rs = requestSession(ctx.req)
    if (!rs) throw new HttpError(403, 'denied', 'API keys cannot re-authenticate.')
    const key = `reauth-fail:${u.id}`
    limit(idn, key, 5, 15 * 60_000)
    let ok = false
    let method = 'password'
    if (typeof b.password === 'string' && b.password) ok = await verifyPassword(b.password.slice(0, 1024), u.passwordHash)
    else if (typeof b.code === 'string' && b.code) {
      method = 'totp'
      ok = (await idn.checkTotp(u.id, b.code)) === 'ok'
    }
    if (!ok) {
      idn.counters.add(key)
      await audit(ctx, u.id, 'auth.reauth_failed', { method })
      throw new HttpError(422, 'invalid', method === 'password' ? 'The password is not correct.' : 'That code is not correct.', method === 'password' ? 'password' : 'code')
    }
    idn.counters.reset(key)
    await db().exec(`UPDATE "ab"."sessions" SET auth_on = now() WHERE id_hash = $1`, [rs.idHash])
    rs.rec.authOn = new Date()
    return { ok: true, until: new Date(Date.now() + reauthWindowMs()).toISOString() }
  }, { auth: 'user', noEnvironment: true, allowPendingMfaEnrolment: true })

  /**
   * after a change of privilege (two-step verification on or off): this session gets a new token in place (the old
   * cookie stops working at once); its live sockets follow the new id instead of being closed
   */
  async function rotate(ctx: Ctx, mfa: boolean) {
    const rs = requestSession(ctx.req)
    if (!rs) return
    const token = randomBytes(32).toString('base64url')
    const idHash = hashToken(token)
    const r = await db().exec(`UPDATE "ab"."sessions" SET id_hash = $2, mfa = $3, restricted = NULL, auth_on = now() WHERE id_hash = $1`, [rs.idHash, idHash, mfa])
    if (!r.affectedRows) return
    ctx.setSessionCookie(token, rs.rec.expiresOn)
    emitSessionEvent({ kind: 'rotated', from: rs.idHash, to: idHash })
    rs.idHash = idHash
    rs.rec = { ...rs.rec, mfa, restricted: null, authOn: new Date() }
  }

  /* ---------------------------------------------------------------- authenticator app (TOTP) */

  router.add('POST', '/auth/mfa/totp/start', async (ctx) => {
    const u = await userOrThrow(me(ctx).id)
    person(u)
    const row = await idn.mfaRow(u.id)
    if (row?.totpEnabledOn) requireRecentAuth(ctx) // replacing an existing authenticator
    const secret = base32Encode(newTotpSecret())
    await db().exec(
      `INSERT INTO "ab"."user_mfa" (user_id, totp_pending_sealed, totp_pending_on, modified_on) VALUES ($1, $2, now(), now())
       ON CONFLICT (user_id) DO UPDATE SET totp_pending_sealed = EXCLUDED.totp_pending_sealed, totp_pending_on = now(), modified_on = now()`,
      [u.id, s.secrets.encrypt(secret)],
    )
    const { installName } = await idn.mail.brand()
    const uri = otpauthUri(secret, u.email, installName)
    return { secret: groupKey(secret), uri, qrSvg: qrSvg(uri, { label: 'QR code for your authenticator app' }), issuer: installName, account: u.email }
  }, { auth: 'user', noEnvironment: true, allowPendingMfaEnrolment: true })

  router.add('POST', '/auth/mfa/totp/confirm', async (ctx) => {
    const u = await userOrThrow(me(ctx).id)
    person(u)
    const key = `mfa-setup-fail:${u.id}`
    limit(idn, key, 10, 15 * 60_000)
    const row = await idn.mfaRow(u.id)
    if (!row?.totpPendingSealed || !row.totpPendingOn || Date.now() - row.totpPendingOn.getTime() > 15 * 60_000) {
      throw new HttpError(409, 'conflict', 'Start again: the setup has expired (15 minutes).')
    }
    const secret = s.secrets.decrypt(row.totpPendingSealed)
    const step = verifyTotp(base32Decode(secret), strOf(obj(ctx.body).code, 16))
    if (step === null) {
      idn.counters.add(key)
      throw new HttpError(422, 'invalid', 'That code is not correct. Check the time on your phone, then type the current code.', 'code')
    }
    await db().exec(
      `UPDATE "ab"."user_mfa" SET totp_secret_sealed = totp_pending_sealed, totp_enabled_on = now(), totp_last_step = $2, totp_pending_sealed = NULL, totp_pending_on = NULL, modified_on = now() WHERE user_id = $1`,
      [u.id, step],
    )
    const unused = (row.recovery ?? []).filter((c) => !c.used).length
    const recoveryCodes = unused ? null : await idn.newRecoveryCodes(u.id)
    await rotate(ctx, true)
    await audit(ctx, u.id, 'auth.mfa_enabled', { method: 'totp', replaced: !!row.totpEnabledOn })
    return { ok: true, recoveryCodes }
  }, { auth: 'user', noEnvironment: true, allowPendingMfaEnrolment: true })

  /** turning a method off: refused when the policy requires two-step verification and no other method remains */
  async function assertMayRemove(u: UserRecord, remaining: boolean) {
    if (remaining) return
    const req = await idn.mfaRequirement(u)
    if (req.required) throw new HttpError(409, 'conflict', 'Your administrator requires two-step verification, so it cannot be turned off. Set up another method first.')
  }

  router.add('DELETE', '/auth/mfa/totp', async (ctx) => {
    requireRecentAuth(ctx)
    const u = await userOrThrow(me(ctx).id)
    const row = await idn.mfaRow(u.id)
    if (!row?.totpEnabledOn) return { ok: true }
    const emailLeft = (await idn.mfaMethods(u.id)).email
    await assertMayRemove(u, emailLeft)
    await db().exec(
      `UPDATE "ab"."user_mfa" SET totp_secret_sealed = NULL, totp_enabled_on = NULL, totp_last_step = NULL, ${emailLeft ? '' : 'recovery = NULL, recovery_created_on = NULL,'} modified_on = now() WHERE user_id = $1`,
      [u.id],
    )
    await idn.revokeDevices(u.id)
    await rotate(ctx, emailLeft)
    await audit(ctx, u.id, 'auth.mfa_disabled', { method: 'totp' })
    return { ok: true }
  }, { auth: 'user', noEnvironment: true })

  /* ---------------------------------------------------------------- email codes */

  router.add('POST', '/auth/mfa/email/start', async (ctx) => {
    const u = await userOrThrow(me(ctx).id)
    person(u)
    const p = await idn.policy.get()
    if (!p.mfa.emailCodes || !(await idn.mail.configured())) throw new HttpError(409, 'conflict', 'Email codes are not available on this server (email is not set up, or the administrator turned them off).')
    limit(idn, `email-setup:${u.id}`, 5, 60 * 60_000)
    idn.counters.add(`email-setup:${u.id}`)
    await idn.revokeTokens(u.id, ['email_setup'])
    const code = numericCode(6)
    await idn.createToken('email_setup', u.id, { ttlMs: EMAIL_CODE_TTL_MS, raw: `${u.id}.${code}` })
    await idn.mail.sendTemplate('signin_code', u.email, { name: u.name, code, minutes: EMAIL_CODE_TTL_MS / 60_000 }, u.id)
    return { ok: true, sentTo: maskEmail(u.email) }
  }, { auth: 'user', noEnvironment: true, allowPendingMfaEnrolment: true })

  router.add('POST', '/auth/mfa/email/confirm', async (ctx) => {
    const u = await userOrThrow(me(ctx).id)
    const key = `mfa-setup-fail:${u.id}`
    limit(idn, key, 10, 15 * 60_000)
    const t = await idn.findToken('email_setup', `${u.id}.${normaliseCode(strOf(obj(ctx.body).code, 16))}`)
    if (!t || t.userId !== u.id || !(await idn.consumeToken(t.id))) {
      idn.counters.add(key)
      throw new HttpError(422, 'invalid', 'That code is not correct or has expired.', 'code')
    }
    await db().exec(
      `INSERT INTO "ab"."user_mfa" (user_id, email_enabled, modified_on) VALUES ($1, true, now()) ON CONFLICT (user_id) DO UPDATE SET email_enabled = true, modified_on = now()`,
      [u.id],
    )
    const row = await idn.mfaRow(u.id)
    const recoveryCodes = row?.recovery.some((c) => !c.used) ? null : await idn.newRecoveryCodes(u.id)
    await rotate(ctx, true)
    await audit(ctx, u.id, 'auth.mfa_enabled', { method: 'email_code' })
    return { ok: true, recoveryCodes }
  }, { auth: 'user', noEnvironment: true, allowPendingMfaEnrolment: true })

  router.add('DELETE', '/auth/mfa/email', async (ctx) => {
    requireRecentAuth(ctx)
    const u = await userOrThrow(me(ctx).id)
    const row = await idn.mfaRow(u.id)
    if (!row?.emailEnabled) return { ok: true }
    const totpLeft = !!row.totpEnabledOn
    await assertMayRemove(u, totpLeft)
    await db().exec(`UPDATE "ab"."user_mfa" SET email_enabled = false, ${totpLeft ? '' : 'recovery = NULL, recovery_created_on = NULL,'} modified_on = now() WHERE user_id = $1`, [u.id])
    if (!totpLeft) await idn.revokeDevices(u.id)
    await rotate(ctx, totpLeft)
    await audit(ctx, u.id, 'auth.mfa_disabled', { method: 'email_code' })
    return { ok: true }
  }, { auth: 'user', noEnvironment: true })

  router.add('POST', '/auth/mfa/recovery-codes', async (ctx) => {
    requireRecentAuth(ctx)
    const u = await userOrThrow(me(ctx).id)
    const m = await idn.mfaMethods(u.id)
    const row = await idn.mfaRow(u.id)
    if (!m.totp && !row?.emailEnabled) throw new HttpError(409, 'conflict', 'Set up two-step verification first.')
    const recoveryCodes = await idn.newRecoveryCodes(u.id)
    await audit(ctx, u.id, 'auth.recovery_codes_regenerated')
    return { ok: true, recoveryCodes }
  }, { auth: 'user', noEnvironment: true })

  /* ---------------------------------------------------------------- sessions and devices */

  const PUBLIC_ID = `COALESCE(public_id, 'h' || left(md5(id_hash), 16))`
  async function sessionsOf(userId: string, currentHash?: string) {
    const rows = await db().query<Record<string, unknown>>(
      `SELECT ${PUBLIC_ID} AS pid, id_hash, created_on, last_seen, expires_on, absolute_expires_on, user_agent, ip, mfa FROM "ab"."sessions"
        WHERE user_id = $1 AND expires_on > now() ORDER BY last_seen DESC`,
      [userId],
    )
    return rows.map((r) => ({
      id: String(r.pid), device: deviceName(r.user_agent as string), userAgent: r.user_agent ? String(r.user_agent) : null, ip: r.ip ? String(r.ip) : null,
      createdOn: iso(r.created_on), lastSeen: iso(r.last_seen), expiresOn: iso(r.expires_on), mfa: r.mfa === true, current: !!currentHash && r.id_hash === currentHash,
    }))
  }
  async function endSession(userId: string, pid: string): Promise<boolean> {
    const rows = await db().query<{ id_hash: string }>(`SELECT id_hash FROM "ab"."sessions" WHERE user_id = $1 AND ${PUBLIC_ID} = $2`, [userId, pid])
    // through the MetaStore: the realtime hub closes that session's sockets at once
    for (const r of rows) await s.meta.sessions.remove(r.id_hash)
    return rows.length > 0
  }

  router.add('GET', '/auth/sessions', async (ctx) => ({ items: await sessionsOf(me(ctx).id, requestSession(ctx.req)?.idHash) }), { auth: 'user', noEnvironment: true })

  router.add('DELETE', '/auth/sessions/:id', async (ctx) => {
    const ok = await endSession(me(ctx).id, ctx.params.id)
    if (!ok) throw new HttpError(404, 'not-found', 'That session has ended already.')
    if (requestSession(ctx.req)?.rec.publicId === ctx.params.id) ctx.setSessionCookie(null)
    await audit(ctx, me(ctx).id, 'auth.session_revoked', { session: ctx.params.id })
    return { ok: true }
  }, { auth: 'user', noEnvironment: true })

  router.add('POST', '/auth/sessions/revoke-others', async (ctx) => {
    const cur = requestSession(ctx.req)?.idHash
    const rows = await db().query<{ id_hash: string }>(`SELECT id_hash FROM "ab"."sessions" WHERE user_id = $1 AND id_hash <> $2`, [me(ctx).id, cur ?? ''])
    for (const r of rows) await s.meta.sessions.remove(r.id_hash)
    await audit(ctx, me(ctx).id, 'auth.sessions_revoked', { count: rows.length, keptCurrent: true })
    return { ok: true, ended: rows.length }
  }, { auth: 'user', noEnvironment: true })

  router.add('DELETE', '/auth/devices/:id', async (ctx) => {
    const n = await idn.revokeDevices(me(ctx).id, ctx.params.id)
    if (!n) throw new HttpError(404, 'not-found', 'That device is not remembered.')
    await audit(ctx, me(ctx).id, 'auth.device_forgotten', { device: ctx.params.id })
    return { ok: true }
  }, { auth: 'user', noEnvironment: true })

  router.add('DELETE', '/auth/devices', async (ctx) => {
    const n = await idn.revokeDevices(me(ctx).id)
    await audit(ctx, me(ctx).id, 'auth.device_forgotten', { all: true, count: n })
    return { ok: true, forgotten: n }
  }, { auth: 'user', noEnvironment: true })

  /* ---------------------------------------------------------------- sign-in log */

  const signinRow = (r: Record<string, unknown>) => ({
    id: Number(r.id), at: iso(r.at), userId: r.user_id ? String(r.user_id) : null, email: r.email ? String(r.email) : null, outcome: String(r.outcome),
    reason: String(r.reason), method: String(r.method), ip: r.ip ? String(r.ip) : null, device: deviceName(r.user_agent as string), userAgent: r.user_agent ? String(r.user_agent) : null,
    sessionId: r.session_id ? String(r.session_id) : null, newDevice: r.new_device === true,
  })

  router.add('GET', '/auth/signins', async (ctx) => {
    const rows = await db().query<Record<string, unknown>>(`SELECT * FROM "ab"."signin_log" WHERE user_id = $1 ORDER BY at DESC, id DESC LIMIT 50`, [me(ctx).id])
    return { items: rows.map(signinRow) }
  }, { auth: 'user', noEnvironment: true })

  router.add('GET', '/identity/signins', async (ctx) => {
    installAdmin(ctx, 'read the sign-in log of everyone')
    const q = ctx.query
    const page = intParam(q.get('page'), 1, 1, 100000)
    const pageSize = intParam(q.get('pageSize'), 50, 1, 200)
    const where: string[] = []
    const params: unknown[] = []
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)) }
    if (q.get('user')) add('user_id = ?', q.get('user'))
    if (q.get('outcome') === 'success' || q.get('outcome') === 'failure') add('outcome = ?', q.get('outcome'))
    if (q.get('method')) add('method = ?', q.get('method'))
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const rows = await db().query<Record<string, unknown>>(`SELECT * FROM "ab"."signin_log" ${w} ORDER BY at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, pageSize, (page - 1) * pageSize])
    const total = await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM "ab"."signin_log" ${w}`, params)
    return { items: rows.map(signinRow), total: Number(total[0]?.n) || 0, page, pageSize }
  }, { auth: 'admin', noEnvironment: true })

  /* ================================================================ administrators */

  router.add('GET', '/identity/users', async () => {
    const mfa = await db().query<{ user_id: string; totp: boolean; email: boolean }>(`SELECT user_id, totp_enabled_on IS NOT NULL AS totp, email_enabled AS email FROM "ab"."user_mfa"`)
    const inv = await db().query<{ user_id: string; created_on: string; expires_on: string }>(`SELECT user_id, created_on, expires_on FROM "ab"."auth_tokens" WHERE kind = 'invite' AND used_on IS NULL AND expires_on > now()`)
    const expiredInv = await db().query<{ user_id: string; expires_on: string }>(`SELECT DISTINCT ON (user_id) user_id, expires_on FROM "ab"."auth_tokens" WHERE kind = 'invite' AND used_on IS NULL AND expires_on <= now() ORDER BY user_id, expires_on DESC`)
    const sess = await db().query<{ user_id: string; n: number }>(`SELECT user_id, count(*)::int AS n FROM "ab"."sessions" WHERE expires_on > now() GROUP BY user_id`)
    const out: Record<string, { mfa: boolean; mfaMethods: string[]; invitation: { createdOn: string; expiresOn: string } | null; invitationExpired: boolean; sessions: number }> = {}
    const get = (id: string) => (out[id] ??= { mfa: false, mfaMethods: [], invitation: null, invitationExpired: false, sessions: 0 })
    for (const r of mfa) {
      const m = [...(r.totp ? ['totp'] : []), ...(r.email ? ['email_code'] : [])]
      if (m.length) Object.assign(get(r.user_id), { mfa: true, mfaMethods: m })
    }
    for (const r of inv) get(r.user_id).invitation = { createdOn: iso(r.created_on)!, expiresOn: iso(r.expires_on)! }
    for (const r of expiredInv) if (!get(r.user_id).invitation) get(r.user_id).invitationExpired = true
    for (const r of sess) get(r.user_id).sessions = Number(r.n)
    return { users: out, emailConfigured: await idn.mail.configured().catch(() => false) }
  }, { auth: 'admin', noEnvironment: true })

  router.add('GET', '/users/:id/sessions', async (ctx) => {
    installAdmin(ctx, "see other people's sessions")
    const u = await userOrThrow(ctx.params.id)
    return { items: await sessionsOf(u.id, requestSession(ctx.req)?.idHash) }
  }, { auth: 'admin' })

  router.add('DELETE', '/users/:id/sessions/:sid', async (ctx) => {
    installAdmin(ctx, "end other people's sessions")
    const u = await userOrThrow(ctx.params.id)
    if (!(await endSession(u.id, ctx.params.sid))) throw new HttpError(404, 'not-found', 'That session has ended already.')
    await audit(ctx, me(ctx).id, 'user.session_revoked', { id: u.id, email: u.email, session: ctx.params.sid }, true)
    return { ok: true }
  }, { auth: 'admin' })

  router.add('DELETE', '/users/:id/sessions', async (ctx) => {
    installAdmin(ctx, "end other people's sessions")
    const u = await userOrThrow(ctx.params.id)
    if (u.id === me(ctx).id) throw new HttpError(409, 'conflict', 'Use "Sign out everywhere else" in Settings > Profile for your own sessions.')
    await s.meta.sessions.removeForUser(u.id)
    await audit(ctx, me(ctx).id, 'user.sessions_revoked', { id: u.id, email: u.email }, true)
    return { ok: true }
  }, { auth: 'admin' })

  router.add('POST', '/users/:id/mfa/reset', async (ctx) => {
    installAdmin(ctx, "reset other people's two-step verification")
    const u = await userOrThrow(ctx.params.id)
    if (u.id === me(ctx).id) throw new HttpError(409, 'conflict', 'Manage your own two-step verification in Settings > Profile.')
    await db().exec(`DELETE FROM "ab"."user_mfa" WHERE user_id = $1`, [u.id])
    await idn.signOutEverywhere(u.id)
    await audit(ctx, me(ctx).id, 'user.mfa_reset', { id: u.id, email: u.email }, true)
    return { ok: true }
  }, { auth: 'admin' })

  router.add('POST', '/users/:id/reset-code', async (ctx) => {
    installAdmin(ctx, 'create reset codes')
    const u = await userOrThrow(ctx.params.id)
    person(u)
    if (u.id === me(ctx).id) throw new HttpError(409, 'conflict', 'Change your own password in Settings > Profile.')
    await idn.revokeTokens(u.id, ['reset'])
    const code = randomCode(12)
    const t = await idn.createToken('reset', u.id, { ttlMs: ADMIN_RESET_TTL_MS, createdBy: me(ctx).id, raw: code })
    await audit(ctx, me(ctx).id, 'user.reset_code_created', { id: u.id, email: u.email, expiresOn: t.expiresOn.toISOString() }, true)
    return { code, expiresOn: t.expiresOn.toISOString(), email: u.email }
  }, { auth: 'admin' })

  router.add('POST', '/users/:id/invite', async (ctx) => {
    installAdmin(ctx, 'invite people')
    const u = await userOrThrow(ctx.params.id)
    person(u)
    if (u.status === 'disabled') throw new HttpError(409, 'conflict', 'Enable the account before inviting.')
    if (u.passwordHash) throw new HttpError(409, 'conflict', `${u.name} already has a password. Use "Create reset code" (or "Forgot password" on the sign-in screen) instead.`)
    if (!(await idn.mail.configured())) throw new HttpError(409, 'conflict', 'Email is not set up, so invitations cannot be sent. Set a temporary password instead, or set up email in Admin console > Email.')
    await idn.revokeTokens(u.id, ['invite'])
    const t = await idn.createToken('invite', u.id, { ttlMs: INVITE_TTL_MS, createdBy: me(ctx).id })
    const origin = await baseUrl(ctx)
    await idn.mail.sendTemplate('invitation', u.email, { name: u.name, email: u.email, link: `${origin}/#invite=${t.raw}`, days: INVITE_TTL_MS / 86_400_000, invitedBy: me(ctx).name }, u.id)
    await audit(ctx, me(ctx).id, 'user.invited', { id: u.id, email: u.email, expiresOn: t.expiresOn.toISOString() }, true)
    return { ok: true, expiresOn: t.expiresOn.toISOString() }
  }, { auth: 'admin' })

  router.add('DELETE', '/users/:id/invite', async (ctx) => {
    installAdmin(ctx, 'revoke invitations')
    const u = await userOrThrow(ctx.params.id)
    const n = await idn.revokeTokens(u.id, ['invite'])
    await audit(ctx, me(ctx).id, 'user.invitation_revoked', { id: u.id, email: u.email, count: n }, true)
    return { ok: true, revoked: n }
  }, { auth: 'admin' })

  /* ---------------------------------------------------------------- policy */

  router.add('GET', '/identity/policy', async () => ({ policy: await idn.policy.get() }), { auth: 'admin', noEnvironment: true })

  router.add('PUT', '/identity/policy', async (ctx) => {
    installAdmin(ctx, 'change the sign-in and security policy')
    const cur = await idn.policy.get()
    const next = mergePolicy(cur, obj(ctx.body).policy ?? ctx.body)
    for (const env of Object.keys(next.mfa.environments)) if (!(await s.environments.get(env))) throw new HttpError(422, 'invalid', `There is no environment "${env}".`, 'mfa.environments')
    if (tightened(cur, next)) next.mfa.since = new Date().toISOString()
    await idn.policy.save(next)
    await audit(ctx, me(ctx).id, 'install.security_policy', { before: cur, after: next }, true)
    return { policy: next }
  }, { auth: 'admin', noEnvironment: true })

  /* ---------------------------------------------------------------- email (SMTP relay) */

  router.add('GET', '/identity/email', async (ctx) => {
    installAdmin(ctx, 'see the email settings')
    return { settings: await idn.mail.settings() }
  }, { auth: 'admin', noEnvironment: true })

  router.add('PUT', '/identity/email', async (ctx) => {
    installAdmin(ctx, 'change the email settings')
    const b = obj(ctx.body)
    const saved = await idn.mail.saveSettings(b)
    const { password, ...shown } = b
    await audit(ctx, me(ctx).id, 'install.email_settings', { ...shown, passwordChanged: password !== undefined }, true)
    return { settings: saved }
  }, { auth: 'admin', noEnvironment: true })

  router.add('DELETE', '/identity/email', async (ctx) => {
    installAdmin(ctx, 'change the email settings')
    await idn.mail.clearSettings()
    await audit(ctx, me(ctx).id, 'install.email_settings_removed', {}, true)
    return { ok: true }
  }, { auth: 'admin', noEnvironment: true })

  router.add('POST', '/identity/email/test', async (ctx) => {
    installAdmin(ctx, 'send test emails')
    limit(idn, `email-test:${me(ctx).id}`, 10, 10 * 60_000)
    idn.counters.add(`email-test:${me(ctx).id}`)
    const to = strOf(obj(ctx.body).to, 191).trim() || me(ctx).email
    const r = await idn.mail.sendTest(to)
    await audit(ctx, me(ctx).id, 'install.email_test', { to }, true)
    return { ok: true, to, response: r.response }
  }, { auth: 'admin', noEnvironment: true })

  router.add('GET', '/identity/email/log', async (ctx) => {
    installAdmin(ctx, 'read the email delivery log')
    const page = intParam(ctx.query.get('page'), 1, 1, 100000)
    const pageSize = intParam(ctx.query.get('pageSize'), 50, 1, 200)
    const status = ctx.query.get('status') ?? ''
    if (status && !['queued', 'sent', 'retrying', 'failed'].includes(status)) throw new HttpError(422, 'invalid', 'status must be queued, sent, retrying or failed.', 'status')
    const r = await idn.mail.logPage({ offset: (page - 1) * pageSize, limit: pageSize, status: status || undefined })
    return { ...r, page, pageSize }
  }, { auth: 'admin', noEnvironment: true })

  /* ---------------------------------------------------------------- service accounts and API keys */

  async function serviceAccount(id: string) {
    const u = await userOrThrow(id)
    if (u.kind !== 'service') throw new HttpError(404, 'not-found', 'Service account not found.')
    const env = await db().query<{ environment_id: string }>(`SELECT environment_id FROM "ab"."environment_access" WHERE user_id = $1 ORDER BY granted_on LIMIT 1`, [u.id])
    return { u, environmentId: env[0]?.environment_id ?? DEFAULT_ENVIRONMENT_ID }
  }
  async function describe(u: UserRecord, environmentId: string) {
    const inEnv = (await s.environments.get(environmentId)) ? await runInEnvironment(environmentId, () => s.meta.users.get(u.id)).catch(() => null) : null
    const keys = await db().query<Record<string, unknown>>(`SELECT * FROM "ab"."api_keys" WHERE user_id = $1 ORDER BY created_on DESC`, [u.id])
    return { id: u.id, name: u.name, status: u.status ?? 'active', environmentId, roleIds: inEnv?.roleIds ?? [], keys: keys.map(toKey) }
  }
  async function rolesIn(environmentId: string, raw: unknown): Promise<string[]> {
    if (raw === undefined) return []
    if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) throw new HttpError(422, 'invalid', 'roleIds must be a list of role ids.', 'roleIds')
    const known = new Set((await runInEnvironment(environmentId, () => s.meta.roles.list())).map((r) => r.id))
    for (const r of raw as string[]) if (!known.has(r)) throw new HttpError(404, 'not-found', `Role "${r}" was not found in that environment.`)
    return [...new Set(raw as string[])]
  }

  router.add('GET', '/identity/service-accounts', async (ctx) => {
    installAdmin(ctx, 'manage service accounts')
    const out = []
    for (const u of (await s.meta.users.list()).filter((x) => x.kind === 'service')) {
      const { environmentId } = await serviceAccount(u.id)
      out.push(await describe(u, environmentId))
    }
    return { items: out }
  }, { auth: 'admin', noEnvironment: true })

  router.add('POST', '/identity/service-accounts', async (ctx) => {
    installAdmin(ctx, 'create service accounts')
    const b = obj(ctx.body)
    const name = strOf(b.name, 100).trim()
    if (!name) throw new HttpError(422, 'invalid', 'A service account needs a name.', 'name')
    const environmentId = strOf(b.environmentId, 40) || DEFAULT_ENVIRONMENT_ID
    const env = await s.environments.get(environmentId)
    if (!env || env.state !== 'ready') throw new HttpError(404, 'not-found', `There is no usable environment "${environmentId}".`)
    const roleIds = await rolesIn(environmentId, b.roleIds)
    const id = uid('user')
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'service'
    const email = `${slug}.${id.slice(-8).toLowerCase()}@service.invalid`
    await runInEnvironment(environmentId, async () => {
      await s.meta.users.insert({ id, name, email, roleIds, status: 'active', passwordHash: null, kind: 'service' })
      await db().exec(`INSERT INTO "ab"."environment_access" (environment_id, user_id, is_env_admin, granted_on, granted_by) VALUES ($1, $2, false, now(), $3) ON CONFLICT DO NOTHING`, [environmentId, id, me(ctx).id])
    })
    s.security.invalidate('all')
    s.environments.invalidate()
    await audit(ctx, me(ctx).id, 'install.service_account_create', { id, name, environmentId, roleIds }, true)
    return describe((await s.meta.users.get(id))!, environmentId)
  }, { auth: 'admin', noEnvironment: true })

  router.add('PATCH', '/identity/service-accounts/:id', async (ctx) => {
    installAdmin(ctx, 'change service accounts')
    const { u, environmentId } = await serviceAccount(ctx.params.id)
    const b = obj(ctx.body)
    const patch: Partial<UserRecord> = {}
    if (b.name !== undefined) {
      const name = strOf(b.name, 100).trim()
      if (!name) throw new HttpError(422, 'invalid', 'A service account needs a name.', 'name')
      patch.name = name
    }
    if (b.status !== undefined) {
      if (b.status !== 'active' && b.status !== 'disabled') throw new HttpError(422, 'invalid', 'Status must be active or disabled.', 'status')
      patch.status = b.status
    }
    if (b.roleIds !== undefined) patch.roleIds = await rolesIn(environmentId, b.roleIds)
    await runInEnvironment(environmentId, () => s.meta.users.update(u.id, patch))
    s.security.invalidate('all')
    s.environments.invalidate()
    await audit(ctx, me(ctx).id, 'install.service_account_update', { id: u.id, ...patch }, true)
    return describe((await s.meta.users.get(u.id))!, environmentId)
  }, { auth: 'admin', noEnvironment: true })

  router.add('DELETE', '/identity/service-accounts/:id', async (ctx) => {
    installAdmin(ctx, 'delete service accounts')
    const { u } = await serviceAccount(ctx.params.id)
    await s.meta.users.remove(u.id)
    s.security.invalidate('all')
    s.environments.invalidate()
    await audit(ctx, me(ctx).id, 'install.service_account_delete', { id: u.id, name: u.name }, true)
    return { ok: true }
  }, { auth: 'admin', noEnvironment: true })

  router.add('POST', '/identity/service-accounts/:id/keys', async (ctx) => {
    installAdmin(ctx, 'create API keys')
    requireRecentAuth(ctx)
    const { u, environmentId } = await serviceAccount(ctx.params.id)
    const b = obj(ctx.body)
    const name = strOf(b.name, 100).trim() || 'API key'
    let expiresOn: Date | null = null
    if (b.expiresInDays !== undefined && b.expiresInDays !== null && b.expiresInDays !== '') {
      const d = Number(b.expiresInDays)
      if (!Number.isInteger(d) || d < 1 || d > 3650) throw new HttpError(422, 'invalid', 'expiresInDays must be a whole number from 1 to 3650.', 'expiresInDays')
      expiresOn = new Date(Date.now() + d * 86_400_000)
    }
    const ipAllow = checkIpAllow(b.ipAllow)
    let rate: number | null = null
    if (b.ratePerMinute !== undefined && b.ratePerMinute !== null && b.ratePerMinute !== '') {
      rate = Number(b.ratePerMinute)
      if (!Number.isInteger(rate) || rate < 1 || rate > 100_000) throw new HttpError(422, 'invalid', 'ratePerMinute must be a whole number from 1 to 100000.', 'ratePerMinute')
    }
    const k = newApiKey()
    const kid = uid('key')
    await db().exec(
      `INSERT INTO "ab"."api_keys" (id, user_id, environment_id, name, prefix, secret_hash, created_on, created_by, expires_on, ip_allow, rate_per_minute) VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9::jsonb, $10)`,
      [kid, u.id, environmentId, name, k.prefix, k.hash, me(ctx).id, expiresOn, JSON.stringify(ipAllow), rate],
    )
    await audit(ctx, me(ctx).id, 'install.api_key_create', { id: kid, serviceAccount: u.id, name, prefix: k.prefix, expiresOn: expiresOn?.toISOString() ?? null, ipAllow, ratePerMinute: rate }, true)
    const row = await db().query<Record<string, unknown>>(`SELECT * FROM "ab"."api_keys" WHERE id = $1`, [kid])
    return { key: k.key, apiKey: toKey(row[0]), defaultRatePerMinute: DEFAULT_RATE_PER_MINUTE }
  }, { auth: 'admin', noEnvironment: true })

  router.add('DELETE', '/identity/service-accounts/:id/keys/:kid', async (ctx) => {
    installAdmin(ctx, 'revoke API keys')
    const { u } = await serviceAccount(ctx.params.id)
    const r = await db().exec(`UPDATE "ab"."api_keys" SET revoked_on = now(), revoked_by = $3 WHERE id = $1 AND user_id = $2 AND revoked_on IS NULL`, [ctx.params.kid, u.id, me(ctx).id])
    if (!r.affectedRows) throw new HttpError(404, 'not-found', 'That key does not exist or was revoked already.')
    await audit(ctx, me(ctx).id, 'install.api_key_revoke', { id: ctx.params.kid, serviceAccount: u.id }, true)
    return { ok: true }
  }, { auth: 'admin', noEnvironment: true })

}
