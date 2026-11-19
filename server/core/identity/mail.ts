/**
 * Outbound email through the install's SMTP relay (Admin console > Email).
 *
 *   mail.send({ to, subject, text, html, template, userId })  -> queued; a `mail.send` job (Default environment's job
 *                                                                 queue) delivers it with retries
 *   mail.sendTemplate(kind, to, vars, userId)                  -> the same with a system template (templates.ts)
 *   mail.sendTest(to)                                          -> sends at once (Admin console "Send test email")
 *
 * The relay settings live in ab.settings `identity.smtp` (JSON; the password sealed with the secret box). The job payload
 * is sealed too (it may hold a reset link or a sign-in code), and the delivery log ab.mail_log keeps only the recipient,
 * subject, template, status, attempts and the last error: never the message body.
 */
import type { CoreServices } from '../services.ts'
import { HttpError } from '../contracts.ts'
import { DEFAULT_ENVIRONMENT_ID, runInEnvironment } from '../env-context.ts'
import { JobError } from '../jobs.ts'
import { errText, log, uid } from '../util.ts'
import { recipientsOf, sendSmtp, SmtpError, validAddress, type SmtpSecurity, type SmtpSettings } from './smtp.ts'
import { renderTemplate, type MailTemplate, type TemplateVars } from './templates.ts'
import { hostProblem } from '../net-policy.ts'
import { checkTokenUrl, getAccessToken, oauthDefaults, OAuthTokenError, type OAuthGrant, type OAuthProvider } from './oauth-token.ts'

export const MAIL_JOB = 'mail.send'
const KEY = 'identity.smtp'

export interface StoredSmtp {
  host: string
  port: number
  security: SmtpSecurity
  username: string
  passwordSealed: string | null
  verifyCertificate: boolean
  fromAddress: string
  fromName: string
  replyTo: string
  /** shown in every system email (header and subject prefix) */
  installName: string
  /** the address people open Appbuilder at, for links in emails, e.g. https://apps.example.com */
  publicUrl: string
  /** P1-E: how the relay is signed in to: a password (default) or OAuth 2.0 (AUTH XOAUTH2, the user name is the mailbox) */
  auth?: 'password' | 'oauth2'
  oauth2?: StoredOAuth
}

export interface StoredOAuth {
  provider: OAuthProvider
  grant: OAuthGrant
  tenant: string
  tokenUrl: string
  clientId: string
  scope: string
  clientSecretSealed: string | null
  refreshTokenSealed: string | null
}

/** what the Admin console sees (never the password, client secret or refresh token) */
export type PublicSmtp = Omit<StoredSmtp, 'passwordSealed' | 'oauth2'> & {
  hasPassword: boolean
  oauth2?: Omit<StoredOAuth, 'clientSecretSealed' | 'refreshTokenSealed'> & { hasClientSecret: boolean; hasRefreshToken: boolean }
}

export interface MailLogEntry {
  id: string
  createdOn: string
  sentOn: string | null
  status: 'queued' | 'sent' | 'retrying' | 'failed'
  attempts: number
  to: string
  subject: string
  template: string
  userId: string | null
  jobId: string | null
  lastError: string | null
}

export interface MailService {
  /** the relay is set up (host and sender) */
  configured(): Promise<boolean>
  settings(): Promise<PublicSmtp | null>
  /** validates and stores; password: undefined keeps it, '' clears it */
  saveSettings(input: Record<string, unknown>): Promise<PublicSmtp>
  clearSettings(): Promise<void>
  send(m: OutgoingMail): Promise<{ id: string }>
  sendTemplate(kind: MailTemplate, to: string, vars: TemplateVars, userId?: string | null): Promise<{ id: string }>
  /** synchronous delivery for the test button; throws HttpError 422 with the relay's answer */
  sendTest(to: string): Promise<{ response: string }>
  logPage(o: { offset: number; limit: number; status?: string }): Promise<{ items: MailLogEntry[]; total: number }>
  brand(): Promise<{ installName: string; publicUrl: string }>
}

/** a message to queue (P1 adds several recipients, copies, attachments, reply-to and list headers) */
export interface OutgoingMail {
  to: string | string[]
  cc?: string[]
  bcc?: string[]
  replyTo?: string
  /** shown as the sender's name (the address stays the relay's sender address) */
  fromName?: string
  subject: string
  text: string
  html?: string
  attachments?: { fileName: string; contentType: string; content: Buffer }[]
  headers?: Record<string, string>
  template: string
  userId?: string | null
}

/** messages above this size (sealed) are kept in ab.mail_log.sealed_message instead of the job payload (256 KB cap) */
const INLINE_SEALED_MAX = 150 * 1024

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

export function createMailService(services: CoreServices): MailService {
  const db = () => {
    const d = services.state.db
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }

  async function stored(): Promise<StoredSmtp | null> {
    const rows = await db().query<{ v: string | null }>(`SELECT v FROM "ab"."settings" WHERE k = $1`, [KEY])
    if (!rows[0]?.v) return null
    try {
      const v = JSON.parse(rows[0].v) as StoredSmtp
      return v && v.host && v.fromAddress ? v : null
    } catch {
      return null
    }
  }
  const toPublic = (s: StoredSmtp): PublicSmtp => {
    const { passwordSealed, oauth2, ...rest } = s
    const out: PublicSmtp = { ...rest, auth: s.auth ?? 'password', hasPassword: !!passwordSealed }
    if (oauth2) {
      const { clientSecretSealed, refreshTokenSealed, ...o } = oauth2
      out.oauth2 = { ...o, hasClientSecret: !!clientSecretSealed, hasRefreshToken: !!refreshTokenSealed }
    }
    return out
  }
  const unseal = (v: string | null, what: string): string => {
    if (!v) return ''
    try {
      return services.secrets.decrypt(v)
    } catch {
      throw new SmtpError(`The saved ${what} cannot be decrypted (was the secret key replaced?). Enter it again in Admin console > Email.`, 535)
    }
  }
  async function smtpOf(s: StoredSmtp): Promise<SmtpSettings> {
    const base = { host: s.host, port: s.port, security: s.security, username: s.username || undefined, verifyCertificate: s.verifyCertificate }
    if (s.auth === 'oauth2' && s.oauth2) {
      const o = s.oauth2
      try {
        const accessToken = await getAccessToken({
          provider: o.provider, grant: o.grant, tokenUrl: o.tokenUrl, clientId: o.clientId, scope: o.scope,
          clientSecret: unseal(o.clientSecretSealed, 'OAuth client secret'), refreshToken: unseal(o.refreshTokenSealed, 'OAuth refresh token') || undefined,
        }, {
          // providers that rotate refresh tokens: keep the newest one
          onRefreshToken: async (t) => {
            const cur = await stored()
            if (cur?.oauth2) {
              cur.oauth2.refreshTokenSealed = services.secrets.encrypt(t)
              await db().exec(`UPDATE "ab"."settings" SET v = $2 WHERE k = $1`, [KEY, JSON.stringify(cur)])
            }
          },
        })
        return { ...base, accessToken }
      } catch (e) {
        if (e instanceof OAuthTokenError) throw new SmtpError(`OAuth 2.0: ${e.message}`, e.permanent ? 535 : 0)
        throw e
      }
    }
    return { ...base, password: unseal(s.passwordSealed, 'SMTP password') || undefined }
  }

  async function logUpdate(id: string, patch: { status: MailLogEntry['status']; attempts?: number; sentOn?: Date; lastError?: string | null; messageId?: string }) {
    await db().exec(
      `UPDATE "ab"."mail_log" SET status = $2, attempts = COALESCE($3, attempts), sent_on = COALESCE($4, sent_on), last_error = $5, message_id = COALESCE($6, message_id) WHERE id = $1`,
      [id, patch.status, patch.attempts ?? null, patch.sentOn ?? null, patch.lastError === undefined ? null : patch.lastError, patch.messageId ?? null],
    ).catch((e) => log('warn', `mail log update failed: ${errText(e)}`))
  }

  // the delivery job (registered once, on the kernel shared by every environment; it is enqueued in Default)
  services.kernel.jobs.register<{ logId: string; sealed: string; stored?: boolean }>({
    type: MAIL_JOB,
    schedule: 'install',
    description: 'Sends one email through the SMTP relay (Admin console > Email). The message is sealed in the payload.',
    parse(raw) {
      if (!isObj(raw) || typeof raw.logId !== 'string' || typeof raw.sealed !== 'string') throw new JobError('malformed mail job', { retry: false })
      return { logId: raw.logId, sealed: raw.sealed, stored: raw.stored === true }
    },
    maxAttempts: 6,
    concurrency: 2,
    timeoutMs: 60_000,
    async handler(p, ctx) {
      const s = await stored()
      const attempt = ctx.job.attempts
      if (!s) {
        await logUpdate(p.logId, { status: 'failed', attempts: attempt, lastError: 'Email is not set up any more.' })
        throw new JobError('Email is not set up.', { retry: false })
      }
      let m: { to: string | string[]; cc?: string[]; bcc?: string[]; replyTo?: string; fromName?: string; subject: string; text: string; html?: string; attachments?: { fileName: string; contentType: string; base64: string }[]; headers?: Record<string, string> }
      try {
        let sealed = p.sealed
        if (p.stored) {
          const r = await db().query<{ sealed_message: string | null }>(`SELECT sealed_message FROM "ab"."mail_log" WHERE id = $1`, [p.logId])
          sealed = r[0]?.sealed_message ?? ''
        }
        m = JSON.parse(services.secrets.decrypt(sealed)) as typeof m
      } catch {
        await logUpdate(p.logId, { status: 'failed', attempts: attempt, lastError: 'The queued message cannot be decrypted.' })
        throw new JobError('The queued message cannot be decrypted.', { retry: false })
      }
      try {
        const r = await sendSmtp(await smtpOf(s), {
          from: { address: s.fromAddress, name: m.fromName || s.fromName || s.installName }, to: m.to, cc: m.cc, bcc: m.bcc, replyTo: m.replyTo || s.replyTo || undefined,
          subject: m.subject, text: m.text, html: m.html, headers: m.headers,
          attachments: (m.attachments ?? []).map((a) => ({ fileName: a.fileName, contentType: a.contentType, content: Buffer.from(a.base64, 'base64') })),
        })
        await logUpdate(p.logId, { status: 'sent', attempts: attempt, sentOn: new Date(), lastError: null, messageId: r.messageId })
        if (p.stored) await db().exec(`UPDATE "ab"."mail_log" SET sealed_message = NULL WHERE id = $1`, [p.logId]).catch(() => {})
        return { sent: true }
      } catch (e) {
        const permanent = e instanceof SmtpError && e.permanent
        const last = permanent || attempt >= ctx.job.maxAttempts
        await logUpdate(p.logId, { status: last ? 'failed' : 'retrying', attempts: attempt, lastError: errText(e).slice(0, 500) })
        if (last && p.stored) await db().exec(`UPDATE "ab"."mail_log" SET sealed_message = NULL WHERE id = $1`, [p.logId]).catch(() => {})
        throw new JobError(errText(e).slice(0, 500), { retry: !permanent })
      }
    },
  })

  const service: MailService = {
    async configured() {
      if (!services.state.db) return false
      return !!(await stored())
    },
    async settings() {
      const s = await stored()
      return s ? toPublic(s) : null
    },
    async saveSettings(b) {
      const cur = await stored()
      const host = str(b.host)
      if (!host || host.length > 255 || /[\s/]/.test(host)) throw new HttpError(422, 'invalid', 'Enter the host name of the SMTP relay, for example smtp.example.com.', 'host')
      const blocked = hostProblem(host)
      if (blocked) throw new HttpError(422, 'invalid', blocked, 'host')
      const port = Number(b.port ?? 587)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(422, 'invalid', 'Port must be between 1 and 65535.', 'port')
      const security = (b.security ?? 'starttls') as SmtpSecurity
      if (!['starttls', 'tls', 'none'].includes(security)) throw new HttpError(422, 'invalid', 'Security must be starttls, tls or none.', 'security')
      const username = str(b.username).slice(0, 255)
      const fromAddress = str(b.fromAddress).toLowerCase()
      if (!validAddress(fromAddress)) throw new HttpError(422, 'invalid', 'Enter the sender address, for example appbuilder@example.com.', 'fromAddress')
      const replyTo = str(b.replyTo).toLowerCase()
      if (replyTo && !validAddress(replyTo)) throw new HttpError(422, 'invalid', 'The reply-to address is not valid.', 'replyTo')
      const fromName = str(b.fromName).slice(0, 100)
      const installName = str(b.installName).slice(0, 100) || 'Appbuilder'
      if (/[\r\n]/.test(fromName + installName)) throw new HttpError(422, 'invalid', 'Names must be one line.', 'fromName')
      let publicUrl = str(b.publicUrl).replace(/\/+$/, '')
      if (publicUrl) {
        try {
          const u = new URL(publicUrl)
          if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol')
          publicUrl = u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''))
        } catch {
          throw new HttpError(422, 'invalid', 'The public address must be a web address such as https://apps.example.com.', 'publicUrl')
        }
      }
      let passwordSealed = cur?.passwordSealed ?? null
      if (b.password !== undefined && b.password !== null) {
        if (typeof b.password !== 'string' || b.password.length > 1024) throw new HttpError(422, 'invalid', 'The password must be text.', 'password')
        passwordSealed = b.password ? services.secrets.encrypt(b.password) : null
      }
      // P1-E: OAuth 2.0 (XOAUTH2) instead of a password
      const auth: 'password' | 'oauth2' = b.auth === 'oauth2' ? 'oauth2' : 'password'
      let oauth2: StoredOAuth | undefined = cur?.oauth2
      if (auth === 'oauth2') {
        const o = (b.oauth2 && typeof b.oauth2 === 'object' ? b.oauth2 : {}) as Record<string, unknown>
        const provider = (['microsoft', 'google', 'custom'].includes(String(o.provider)) ? o.provider : 'microsoft') as OAuthProvider
        const grant = (o.grant === 'client_credentials' ? 'client_credentials' : 'refresh_token') as OAuthGrant
        if (provider === 'google' && grant === 'client_credentials') throw new HttpError(422, 'invalid', 'Google Workspace needs a refresh token (client credentials are a Microsoft 365 option).', 'oauth2.grant')
        const tenant = str(o.tenant).slice(0, 100)
        if (tenant && !/^[A-Za-z0-9.-]+$/.test(tenant)) throw new HttpError(422, 'invalid', 'The tenant is a domain such as contoso.onmicrosoft.com or a directory id.', 'oauth2.tenant')
        const d = oauthDefaults(provider, grant, tenant)
        const tokenUrl = str(o.tokenUrl) || d.tokenUrl
        try {
          const u = checkTokenUrl(tokenUrl)
          const blockedToken = hostProblem(u.hostname.replace(/^\[|\]$/g, ''))
          if (blockedToken) throw new OAuthTokenError(blockedToken, true)
        } catch (e) {
          throw new HttpError(422, 'invalid', (e as Error).message, 'oauth2.tokenUrl')
        }
        const scope = (str(o.scope) || d.scope).slice(0, 500)
        if (!scope) throw new HttpError(422, 'invalid', 'Enter the scope the token endpoint expects.', 'oauth2.scope')
        const clientId = str(o.clientId).slice(0, 200)
        if (!clientId) throw new HttpError(422, 'invalid', 'Enter the OAuth client (application) id.', 'oauth2.clientId')
        const sealOr = (v: unknown, keep: string | null, what: string): string | null => {
          if (v === undefined || v === null) return keep
          if (typeof v !== 'string' || v.length > 4096) throw new HttpError(422, 'invalid', `The ${what} must be text.`, 'oauth2')
          return v ? services.secrets.encrypt(v) : null
        }
        const same = cur?.oauth2 && cur.oauth2.clientId === clientId && cur.oauth2.tokenUrl === tokenUrl
        const clientSecretSealed = sealOr(o.clientSecret, same ? cur!.oauth2!.clientSecretSealed : null, 'client secret')
        const refreshTokenSealed = sealOr(o.refreshToken, same ? cur!.oauth2!.refreshTokenSealed : null, 'refresh token')
        if (grant === 'client_credentials' && !clientSecretSealed) throw new HttpError(422, 'invalid', 'Client credentials need the client secret.', 'oauth2.clientSecret')
        if (grant === 'refresh_token' && !refreshTokenSealed) throw new HttpError(422, 'invalid', 'Enter the refresh token.', 'oauth2.refreshToken')
        if (!username || !validAddress(username)) throw new HttpError(422, 'invalid', 'With OAuth 2.0 the user name is the mailbox the mail is sent from, for example appbuilder@example.com.', 'username')
        if (security === 'none' && !/^(localhost|127\.|::1$)/.test(host)) throw new HttpError(422, 'invalid', 'OAuth 2.0 tokens are only sent over STARTTLS or TLS. Choose STARTTLS or TLS.', 'security')
        oauth2 = { provider, grant, tenant, tokenUrl, clientId, scope, clientSecretSealed, refreshTokenSealed }
      }
      if (security === 'none' && username && !/^(localhost|127\.|::1$)/.test(host)) {
        throw new HttpError(422, 'invalid', 'A user name and password are only sent over STARTTLS or TLS (or to a relay on this computer). Choose STARTTLS or TLS.', 'security')
      }
      const next: StoredSmtp = {
        host, port, security, username, passwordSealed, verifyCertificate: b.verifyCertificate !== false,
        fromAddress, fromName, replyTo, installName, publicUrl, auth, ...(oauth2 ? { oauth2 } : {}),
      }
      await db().exec(`INSERT INTO "ab"."settings" (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [KEY, JSON.stringify(next)])
      return toPublic(next)
    },
    async clearSettings() {
      await db().exec(`DELETE FROM "ab"."settings" WHERE k = $1`, [KEY])
    },
    async send(m) {
      const s = await stored()
      if (!s) throw new HttpError(409, 'conflict', 'Email is not set up. An install administrator sets up the SMTP relay in Admin console > Email.')
      const all = recipientsOf(m)
      if (!all.length) throw new HttpError(422, 'invalid', 'A message needs at least one recipient.', 'to')
      for (const a of all) if (!validAddress(a)) throw new HttpError(422, 'invalid', `"${a}" is not a valid email address.`, 'to')
      if (m.replyTo && !validAddress(m.replyTo)) throw new HttpError(422, 'invalid', `"${m.replyTo}" is not a valid reply-to address.`, 'replyTo')
      const id = uid('mail')
      const subject = m.subject.replace(/[\r\n]+/g, ' ').slice(0, 300)
      const shown = all.length > 1 ? `${all[0]} (+${all.length - 1})` : all[0]
      const msg = {
        to: m.to, ...(m.cc?.length ? { cc: m.cc } : {}), ...(m.bcc?.length ? { bcc: m.bcc } : {}), ...(m.replyTo ? { replyTo: m.replyTo } : {}), ...(m.fromName ? { fromName: m.fromName.replace(/[\r\n]/g, ' ').slice(0, 100) } : {}),
        subject, text: m.text, html: m.html, ...(m.headers ? { headers: m.headers } : {}),
        ...(m.attachments?.length ? { attachments: m.attachments.map((a) => ({ fileName: a.fileName, contentType: a.contentType, base64: a.content.toString('base64') })) } : {}),
      }
      const sealed = services.secrets.encrypt(JSON.stringify(msg))
      const bigMessage = sealed.length > INLINE_SEALED_MAX
      await db().exec(
        `INSERT INTO "ab"."mail_log" (id, created_on, status, attempts, to_address, subject, template, user_id, sealed_message) VALUES ($1, $2, 'queued', 0, $3, $4, $5, $6, $7)`,
        [id, new Date(), shown, subject, m.template, m.userId ?? null, bigMessage ? sealed : null],
      )
      const job = await runInEnvironment(DEFAULT_ENVIRONMENT_ID, () => services.kernel.jobs.enqueue(MAIL_JOB, bigMessage ? { logId: id, sealed: '', stored: true } : { logId: id, sealed }, { correlationId: `mail:${id}`, priority: 5 }))
      await db().exec(`UPDATE "ab"."mail_log" SET job_id = $2 WHERE id = $1`, [id, job.id])
      return { id }
    },
    async sendTemplate(kind, to, vars, userId) {
      const b = await service.brand()
      const r = renderTemplate(kind, vars, { installName: b.installName })
      return service.send({ to, subject: r.subject, text: r.text, html: r.html, template: kind, userId })
    },
    async sendTest(to) {
      const s = await stored()
      if (!s) throw new HttpError(409, 'conflict', 'Save the SMTP settings first.')
      if (!validAddress(to)) throw new HttpError(422, 'invalid', `"${to}" is not a valid email address.`, 'to')
      const r = renderTemplate('test', {}, { installName: s.installName })
      const id = uid('mail')
      await db().exec(`INSERT INTO "ab"."mail_log" (id, created_on, status, attempts, to_address, subject, template) VALUES ($1, $2, 'queued', 1, $3, $4, 'test')`, [id, new Date(), to, r.subject])
      try {
        const res = await sendSmtp({ ...(await smtpOf(s)), timeoutMs: 15_000 }, { from: { address: s.fromAddress, name: s.fromName || s.installName }, to, replyTo: s.replyTo || undefined, subject: r.subject, text: r.text, html: r.html })
        await logUpdate(id, { status: 'sent', attempts: 1, sentOn: new Date(), lastError: null, messageId: res.messageId })
        return { response: res.response }
      } catch (e) {
        await logUpdate(id, { status: 'failed', attempts: 1, lastError: errText(e).slice(0, 500) })
        throw new HttpError(422, 'invalid', `The test email was not sent: ${errText(e).slice(0, 400)}`)
      }
    },
    async logPage(o) {
      const where = o.status ? 'WHERE status = $3' : ''
      const params: unknown[] = [o.limit, o.offset, ...(o.status ? [o.status] : [])]
      const rows = await db().query<Record<string, unknown>>(`SELECT * FROM "ab"."mail_log" ${where} ORDER BY created_on DESC, id DESC LIMIT $1 OFFSET $2`, params)
      const total = await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM "ab"."mail_log" ${o.status ? 'WHERE status = $1' : ''}`, o.status ? [o.status] : [])
      const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null)
      return {
        total: Number(total[0]?.n) || 0,
        items: rows.map((r) => ({
          id: String(r.id), createdOn: iso(r.created_on)!, sentOn: iso(r.sent_on), status: String(r.status) as MailLogEntry['status'], attempts: Number(r.attempts) || 0,
          to: String(r.to_address), subject: String(r.subject), template: String(r.template), userId: r.user_id ? String(r.user_id) : null, jobId: r.job_id ? String(r.job_id) : null, lastError: r.last_error ? String(r.last_error) : null,
        })),
      }
    },
    async brand() {
      const s = services.state.db ? await stored() : null
      return { installName: s?.installName || 'Appbuilder', publicUrl: s?.publicUrl || '' }
    },
  }
  return service
}
