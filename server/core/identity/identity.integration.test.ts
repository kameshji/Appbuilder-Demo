/**
 * Identity basics (P0 package I) over HTTP against the sandbox PostgreSQL and a fake SMTP server:
 *   APPBUILDER_TEST_DB=postgres://abdev:abdev-sandbox-only@127.0.0.1:5433/appbuilder_test npx vitest run server/core/identity
 * Email relay and delivery log, password reset (link and admin code), invitations, email change, TOTP enrolment and the
 * second sign-in step, recovery codes, remembered devices, MFA policy and forced enrolment, sessions (list, revoke, idle and
 * absolute ends, live sockets), the sign-in log, password policy, re-authentication, service accounts and API keys.
 * Abuse cases: token reuse, expiry, wrong user, enumeration (uniform answers and timing), brute force, recovery code reuse,
 * TOTP replay, device cookie tampering, bearer + cookie confusion. Creates and drops its own database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { PG_URL, SKIP_PG, dropDatabase, pgQuery, pgServer, testDatabaseName } from '../testdb.ts'
import { createApp, type AppServer } from '../app.ts'
import { setQuiet } from '../util.ts'
import { startFakeSmtp, type FakeSmtp } from './fake-smtp.ts'
import { base32Decode, totp } from './totp.ts'

setQuiet(true)
const conn = pgServer
const dbName = testDatabaseName('id')
if (!PG_URL) process.stderr.write(`[identity integration] ${SKIP_PG}\n`)

class Client {
  cookies = new Map<string, string>()
  base: string
  ua: string
  constructor(base: string, ua = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0 Safari/537.36') {
    this.base = base
    this.ua = ua
  }
  get cookie() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }
  async req(method: string, p: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { 'X-Appbuilder': '1', 'User-Agent': this.ua, ...extra }
    if (this.cookies.size) headers.Cookie = this.cookie
    let payload: string | undefined
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    const t0 = performance.now()
    const res = await fetch(this.base + '/api/v1' + p, { method, headers, body: payload })
    const ms = performance.now() - t0
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const i = pair.indexOf('=')
      const name = pair.slice(0, i)
      const value = pair.slice(i + 1)
      if (value && !/Max-Age=0/.test(c)) this.cookies.set(name, value)
      else this.cookies.delete(name)
    }
    const type = res.headers.get('content-type') ?? ''
    const data = type.includes('json') ? await res.json() : await res.text()
    return { status: res.status, data: data as any, headers: res.headers, ms }
  }
  get = (p: string) => this.req('GET', p)
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {})
  put = (p: string, b: unknown) => this.req('PUT', p, b)
  patch = (p: string, b: unknown) => this.req('PATCH', p, b)
  del = (p: string) => this.req('DELETE', p)
}

async function serve(app: AppServer) {
  const server = http.createServer((req, res) => {
    app.handle(req, res).then((h) => {
      if (!h) res.writeHead(404).end()
    })
  })
  server.on('upgrade', (req, socket, head) => {
    if (!app.handleUpgrade(req, socket, head)) socket.destroy()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const linkToken = (text: string, kind: string) => new RegExp(`#${kind}=([A-Za-z0-9_-]+)`).exec(text)?.[1] ?? ''

describe.skipIf(!PG_URL)('identity basics (PostgreSQL)', () => {
  let app: AppServer
  let server: http.Server
  let smtp: FakeSmtp
  let tmp = ''
  let base = ''
  let A: Client
  const raw = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => pgQuery<T>(dbName, sql, params)
  /** mails to an address (optionally only those whose subject matches) */
  const mailsTo = (to: string, subject?: RegExp) => smtp.inbox.filter((m) => m.to.includes(to) && (!subject || subject.test(m.subject)))
  async function nextMail(to: string, n: number, subject?: RegExp) {
    const end = Date.now() + 15000
    while (mailsTo(to, subject).length < n) {
      if (Date.now() > end) throw new Error(`no mail #${n} to ${to}; inbox: ${smtp.inbox.map((m) => `${m.to}:${m.subject}`).join(', ')}`)
      await sleep(50)
    }
    return mailsTo(to, subject)[n - 1]
  }
  const RESET = /reset your password/
  const CODE = /sign-in code/
  async function newUser(name: string, email: string, password = 'temporary-pass-1', roleIds = ['role_viewer']) {
    const u = await A.post('/users', { name, email, roleIds, password })
    expect(u.status, JSON.stringify(u.data)).toBe(200)
    const c = new Client(base)
    expect((await c.post('/auth/login', { email, password })).status).toBe(200)
    const own = `${name}-own-pass-word-7`
    expect((await c.post('/auth/password', { current: password, next: own })).status).toBe(200)
    return { id: u.data.id as string, c, password: own }
  }
  /** enrols TOTP for a signed-in client; returns the secret */
  async function enrol(c: Client): Promise<{ secret: Buffer; recovery: string[] }> {
    const st = await c.post('/auth/mfa/totp/start')
    expect(st.status, JSON.stringify(st.data)).toBe(200)
    const secret = base32Decode(st.data.secret)
    const ok = await c.post('/auth/mfa/totp/confirm', { code: totp(secret) })
    expect(ok.status, JSON.stringify(ok.data)).toBe(200)
    return { secret, recovery: ok.data.recoveryCodes }
  }
  const clearStep = (userId: string) => raw(`UPDATE ab.user_mfa SET totp_last_step = NULL WHERE user_id = $1`, [userId])

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-id-'))
    smtp = await startFakeSmtp({ user: 'relay', password: 'relay-secret' })
    app = await createApp({ env: { APPBUILDER_JOBS_POLL_MS: '100' }, config: { workspaceDir: tmp }, printSetupCode: false })
    ;({ server, base } = await serve(app))
    A = new Client(base)
    const code = app.services.setupCode.current()
    expect((await A.post('/setup/database', { host: conn!.host, port: conn!.port, database: dbName, user: conn!.user, password: conn!.password, createDatabase: true, setupCode: code })).status).toBe(200)
    expect((await A.post('/setup/admin', { name: 'Ada Admin', email: 'ada@example.com', password: 'admin-password-1', setupCode: code })).status).toBe(200)
  }, 90000)

  afterAll(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    await app?.close()
    await smtp?.close()
    if (conn) await dropDatabase(dbName)
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }, 60000)

  /* ------------------------------------------------------------------ without email */

  it('without SMTP every email feature degrades explicitly', async () => {
    const info = await new Client(base).get('/auth/identity-info')
    expect(info.data).toMatchObject({ email: false, emailCodes: false, passwordMinLength: 10 })
    const f = await new Client(base).post('/auth/password/forgot', { email: 'ada@example.com' })
    expect(f.status).toBe(200)
    expect(f.data).toMatchObject({ ok: true, email: false })
    expect(f.data.message).toMatch(/reset code/)
    const u = await A.post('/users', { name: 'Ina', email: 'ina@example.com', roleIds: ['role_viewer'] })
    const inv = await A.post(`/users/${u.data.id}/invite`)
    expect(inv.status).toBe(409)
    expect(inv.data.error.message).toMatch(/temporary password/)
    // the admin path: a one-time reset code, shown once
    const rc = await A.post(`/users/${u.data.id}/reset-code`)
    expect(rc.status).toBe(200)
    expect(rc.data.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    const stored = await raw<{ token_hash: string }>(`SELECT token_hash FROM ab.auth_tokens WHERE user_id = $1`, [u.data.id])
    expect(JSON.stringify(stored)).not.toContain(rc.data.code.replace(/-/g, ''))
    const anon = new Client(base)
    // wrong email for the code: refused
    expect((await anon.post('/auth/password/reset', { email: 'ada@example.com', code: rc.data.code, password: 'brand-new-pass-1' })).status).toBe(422)
    const ok = await anon.post('/auth/password/reset', { email: 'ina@example.com', code: rc.data.code.toLowerCase().replace(/-/g, ' '), password: 'Ina-chosen-pass-1' })
    expect(ok.status, JSON.stringify(ok.data)).toBe(200)
    // single use
    expect((await anon.post('/auth/password/reset', { email: 'ina@example.com', code: rc.data.code, password: 'Ina-chosen-pass-2' })).status).toBe(422)
    expect((await anon.post('/auth/login', { email: 'ina@example.com', password: 'Ina-chosen-pass-1' })).status).toBe(200)
    const ec = await anon.post('/auth/email/change', { email: 'ina2@example.com' })
    expect(ec.status).toBe(409)
  }, 30000)

  /* ------------------------------------------------------------------ email relay */

  it('SMTP settings: validated, password sealed and never returned; test email; delivery log without bodies', async () => {
    expect((await A.put('/identity/email', { host: 'smtp example', fromAddress: 'x@example.com' })).status).toBe(422)
    expect((await A.put('/identity/email', { host: 'mail.example.com', port: 25, security: 'none', username: 'u', password: 'p', fromAddress: 'x@example.com' })).status).toBe(422)
    const put = await A.put('/identity/email', {
      host: '127.0.0.1', port: smtp.port, security: 'none', username: 'relay', password: 'relay-secret', fromAddress: 'appbuilder@example.com',
      fromName: 'Acme Apps', replyTo: 'help@example.com', installName: 'Acme Apps', publicUrl: 'http://apps.example.com/',
    })
    expect(put.status, JSON.stringify(put.data)).toBe(200)
    expect(put.data.settings).toMatchObject({ host: '127.0.0.1', hasPassword: true, publicUrl: 'http://apps.example.com', installName: 'Acme Apps' })
    expect(JSON.stringify(put.data)).not.toContain('relay-secret')
    const stored = await raw<{ v: string }>(`SELECT v FROM ab.settings WHERE k = 'identity.smtp'`)
    expect(stored[0].v).not.toContain('relay-secret')
    expect(stored[0].v).toContain('"passwordSealed":"v1:')
    const t = await A.post('/identity/email/test', { to: 'ada@example.com' })
    expect(t.status, JSON.stringify(t.data)).toBe(200)
    const m = await nextMail('ada@example.com', 1)
    expect(m.subject).toBe('Acme Apps: test email')
    expect(m.authUser).toBe('relay')
    expect(m.html).toContain('Acme Apps')
    expect(m.headers['reply-to']).toBe('<help@example.com>')
    // a non-admin cannot read or change it
    const v = await newUser('Vic', 'vic@example.com')
    expect((await v.c.get('/identity/email')).status).toBe(403)
    expect((await v.c.put('/identity/email', { host: 'evil' })).status).toBe(403)
    const info = await new Client(base).get('/auth/identity-info')
    expect(info.data.email).toBe(true)
  }, 30000)

  it('mail jobs retry temporary failures, stop on permanent ones, and seal the message in the job payload', async () => {
    smtp.failNext(1, 451, 'retry@example.com')
    const svc = (await import('./index.ts')).identity(app.services)
    const r = await svc.mail.send({ to: 'retry@example.com', subject: 'Retry me', text: 'secret-code-777', template: 'test' })
    const m = await nextMail('retry@example.com', 1)
    expect(m.text).toContain('secret-code-777')
    let log: Record<string, unknown>[] = []
    for (let i = 0; i < 50; i++) {
      log = await raw<Record<string, unknown>>(`SELECT * FROM ab.mail_log WHERE id = $1`, [r.id])
      if (log[0]?.status === 'sent') break
      await sleep(100)
    }
    expect(log[0]).toMatchObject({ status: 'sent', attempts: 2 })
    expect(JSON.stringify(log)).not.toContain('secret-code-777')
    const jobs = await raw<{ payload: unknown }>(`SELECT payload FROM env_default.ab_jobs WHERE type = 'mail.send'`)
    expect(JSON.stringify(jobs)).not.toContain('secret-code-777')
    smtp.failNext(1, 550, 'perm@example.com')
    const p = await svc.mail.send({ to: 'perm@example.com', subject: 'Nope', text: 'x', template: 'test' })
    const end = Date.now() + 10000
    let st = ''
    while (Date.now() < end && st !== 'failed') {
      st = String((await raw<{ status: string }>(`SELECT status FROM ab.mail_log WHERE id = $1`, [p.id]))[0].status)
      await sleep(100)
    }
    expect(st).toBe('failed')
    const page = await A.get('/identity/email/log?status=failed')
    expect(page.data.items.some((x: any) => x.id === p.id && /550/.test(x.lastError))).toBe(true)
  }, 30000)

  /* ------------------------------------------------------------------ forgot / reset */

  it('forgot password: uniform answers and timing for known and unknown accounts; link works once, for one account, signs out', async () => {
    const pat = await newUser('Pat', 'pat@example.com')
    const other = new Client(base)
    expect((await other.post('/auth/login', { email: 'pat@example.com', password: pat.password })).status).toBe(200)
    const anon = new Client(base)
    const known: number[] = []
    const unknown: number[] = []
    for (let i = 0; i < 3; i++) {
      const a = await anon.post('/auth/password/forgot', { email: 'pat@example.com' })
      const b = await anon.post('/auth/password/forgot', { email: `nobody${i}@example.com` })
      expect(a.status).toBe(200)
      expect(b.data).toEqual(a.data)
      known.push(a.ms)
      unknown.push(b.ms)
    }
    // fastest of the samples: a mean of three is dominated by scheduling noise when the whole suite runs in parallel
    const best = (x: number[]) => Math.min(...x)
    expect(Math.abs(best(known) - best(unknown))).toBeLessThan(60)
    // per email: silently at most 3 an hour (a 4th answers the same and sends nothing)
    expect((await anon.post('/auth/password/forgot', { email: 'pat@example.com' })).data).toMatchObject({ ok: true })
    await nextMail('pat@example.com', 3, RESET)
    await sleep(800)
    expect(mailsTo('pat@example.com', RESET).length).toBe(3)
    expect(mailsTo('nobody0@example.com').length).toBe(0)
    // only the newest link works (asking again revokes the earlier ones). The mail jobs run two at a time, so the relay
    // may receive the three messages in any order: exactly one of the three links works
    const links = mailsTo('pat@example.com', RESET).map((m) => ({ m, t: linkToken(m.text, 'reset') }))
    const checks = await Promise.all(links.map((l) => anon.post('/auth/password/reset/check', { token: l.t })))
    expect(checks.map((c) => c.status).sort()).toEqual([200, 422, 422])
    const newest = links[checks.findIndex((c) => c.status === 200)]!
    const mail = newest.m
    expect(mail.subject).not.toMatch(/http|#reset/)
    const token = newest.t
    expect(mail.text).toContain(`http://apps.example.com/#reset=${token}`)
    expect((await anon.post('/auth/password/reset/check', { token })).data).toMatchObject({ ok: true, email: 'pat@example.com' })
    // policy applies: a common password is refused
    const weak = await anon.post('/auth/password/reset', { token, password: 'password1234' })
    expect(weak.status).toBe(422)
    expect(weak.data.error.message).toMatch(/commonly used/)
    const done = await anon.post('/auth/password/reset', { token, password: 'Pat-reset-pass-9' })
    expect(done.status, JSON.stringify(done.data)).toBe(200)
    // reuse refused; every earlier session ended
    expect((await anon.post('/auth/password/reset', { token, password: 'Pat-reset-pass-8' })).status).toBe(422)
    expect((await other.get('/auth/session')).status).toBe(401)
    expect((await pat.c.get('/auth/session')).status).toBe(401)
    expect((await anon.post('/auth/login', { email: 'pat@example.com', password: 'Pat-reset-pass-9' })).status).toBe(200)
    const changed = await nextMail('pat@example.com', 2, /password was changed/)
    expect(changed.text).toContain('pat@example.com')
    // expired links do not work
    await anon.post('/auth/password/forgot', { email: 'vic@example.com' })
    const vm = await nextMail('vic@example.com', 1, RESET)
    await raw(`UPDATE ab.auth_tokens SET expires_on = now() - interval '1 minute' WHERE kind = 'reset' AND used_on IS NULL`)
    expect((await anon.post('/auth/password/reset', { token: linkToken(vm.text, 'reset'), password: 'Vic-reset-pass-1' })).status).toBe(422)
    const audit = await raw<{ action: string }>(`SELECT action FROM ab.audit WHERE action = 'auth.password_reset'`)
    expect(audit.length).toBeGreaterThan(0)
  }, 60000)

  it('reset attempts are rate limited per address', async () => {
    const x = new Client(base)
    let last = 0
    for (let i = 0; i < 12; i++) last = (await x.post('/auth/password/reset', { token: `bogus-token-${i}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx`, password: 'whatever-pass-1' })).status
    expect(last).toBe(429)
  })

  /* ------------------------------------------------------------------ invitations */

  it('invitation: email with a 7-day link; resend replaces it; accept signs in; reuse and revoke', async () => {
    const u = await A.post('/users', { name: 'Ivy', email: 'ivy@example.com', roleIds: ['role_viewer'] })
    const inv = await A.post(`/users/${u.data.id}/invite`)
    expect(inv.status, JSON.stringify(inv.data)).toBe(200)
    const first = await nextMail('ivy@example.com', 1)
    expect(first.subject).toBe('You are invited to Acme Apps')
    const again = await A.post(`/users/${u.data.id}/invite`)
    expect(again.status).toBe(200)
    const second = await nextMail('ivy@example.com', 2)
    const anon = new Client(base)
    expect((await anon.post('/auth/invitation/check', { token: linkToken(first.text, 'invite') })).status).toBe(422)
    const tok = linkToken(second.text, 'invite')
    const state = await A.get('/identity/users')
    expect(state.data.users[u.data.id].invitation.expiresOn).toBeTruthy()
    expect(new Date(state.data.users[u.data.id].invitation.expiresOn).getTime() - Date.now()).toBeGreaterThan(6.9 * 86400000)
    expect((await anon.post('/auth/invitation/check', { token: tok })).data).toMatchObject({ email: 'ivy@example.com', name: 'Ivy' })
    const acc = await anon.post('/auth/invitation/accept', { token: tok, password: 'Ivy-chosen-pass-1' })
    expect(acc.status, JSON.stringify(acc.data)).toBe(200)
    expect(acc.data.user.email).toBe('ivy@example.com')
    expect((await anon.get('/auth/session')).status).toBe(200)
    expect((await new Client(base).post('/auth/invitation/accept', { token: tok, password: 'Ivy-other-pass-1' })).status).toBe(422)
    // has a password now: no more invitations
    expect((await A.post(`/users/${u.data.id}/invite`)).status).toBe(409)
    // revoke
    const w = await A.post('/users', { name: 'Wes', email: 'wes@example.com', roleIds: [] })
    await A.post(`/users/${w.data.id}/invite`)
    const wm = await nextMail('wes@example.com', 1)
    expect((await A.del(`/users/${w.data.id}/invite`)).data.revoked).toBe(1)
    expect((await new Client(base).post('/auth/invitation/accept', { token: linkToken(wm.text, 'invite'), password: 'Wes-chosen-pass-1' })).status).toBe(422)
  }, 30000)

  /* ------------------------------------------------------------------ email change, re-authentication */

  it('email change needs re-authentication and confirmation by the new address', async () => {
    const e = await newUser('Eli', 'eli@example.com')
    // an old proof of identity: refused with reauth_required
    await raw(`UPDATE ab.sessions SET auth_on = now() - interval '1 hour' WHERE user_id = $1`, [e.id])
    const r = await e.c.post('/auth/email/change', { email: 'eli.new@example.com' })
    expect(r.status).toBe(403)
    expect(r.data.error.code).toBe('reauth_required')
    expect((await e.c.post('/auth/reauth', { password: 'wrong-password-1' })).status).toBe(422)
    expect((await e.c.post('/auth/reauth', { password: e.password })).status).toBe(200)
    expect((await e.c.post('/auth/email/change', { email: 'ada@example.com' })).status).toBe(409)
    const ok = await e.c.post('/auth/email/change', { email: 'eli.new@example.com' })
    expect(ok.status, JSON.stringify(ok.data)).toBe(200)
    const confirm = await nextMail('eli.new@example.com', 1)
    const notice = await nextMail('eli@example.com', 1, /changing/)
    expect(notice.text).toContain('eli.new@example.com')
    expect((await e.c.get('/auth/security')).data.pendingEmail).toBe('eli.new@example.com')
    const tok = linkToken(confirm.text, 'confirm-email')
    expect((await new Client(base).post('/auth/email/confirm', { token: tok })).data).toMatchObject({ ok: true, email: 'eli.new@example.com' })
    expect((await new Client(base).post('/auth/email/confirm', { token: tok })).status).toBe(422)
    expect((await new Client(base).post('/auth/login', { email: 'eli.new@example.com', password: e.password })).status).toBe(200)
  }, 30000)

  /* ------------------------------------------------------------------ two-step verification */

  it('TOTP: enrol with a confirmed code, sign in with the second step, replay refused, recovery codes single use', async () => {
    const t = await newUser('Tia', 'tia@example.com')
    const st = await t.c.post('/auth/mfa/totp/start')
    expect(st.data.uri).toMatch(/^otpauth:\/\/totp\/Acme%20Apps%3Atia%40example\.com\?secret=/)
    expect(st.data.qrSvg).toMatch(/^<svg [^>]*viewBox/)
    expect(st.data.qrSvg).not.toMatch(/<script|style=/)
    const secret = base32Decode(st.data.secret)
    expect((await t.c.post('/auth/mfa/totp/confirm', { code: '000000' })).status).toBe(422)
    const sealed = await raw<{ totp_pending_sealed: string }>(`SELECT totp_pending_sealed FROM ab.user_mfa WHERE user_id = $1`, [t.id])
    expect(sealed[0].totp_pending_sealed).toMatch(/^v1:/)
    const before = t.c.cookies.get('ab_session')
    const conf = await t.c.post('/auth/mfa/totp/confirm', { code: totp(secret) })
    expect(conf.status, JSON.stringify(conf.data)).toBe(200)
    expect(conf.data.recoveryCodes).toHaveLength(10)
    expect(conf.data.recoveryCodes[0]).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/)
    // session rotation on enrolment: a new token; the old one no longer works
    expect(t.c.cookies.get('ab_session')).not.toBe(before)
    const stale = new Client(base)
    stale.cookies.set('ab_session', before!)
    expect((await stale.get('/auth/session')).status).toBe(401)
    expect((await t.c.get('/auth/session')).data.user.mfaEnabled).toBe(true)
    const stored = await raw<{ recovery: unknown }>(`SELECT recovery FROM ab.user_mfa WHERE user_id = $1`, [t.id])
    expect(JSON.stringify(stored)).not.toContain(conf.data.recoveryCodes[0].replace(/-/g, ''))

    // sign-in: the password alone is not enough
    const c = new Client(base)
    const one = await c.post('/auth/login', { email: 'tia@example.com', password: t.password })
    expect(one.status).toBe(401)
    expect(one.data.error.code).toBe('mfa_required')
    expect(one.data.mfa.methods).toEqual(['totp', 'recovery_code'])
    expect(c.cookies.get('ab_session')).toBeUndefined()
    expect((await c.get('/auth/session')).status).toBe(401)
    // the code used at enrolment (same step) is a replay
    const replay = await c.post('/auth/login/verify', { code: totp(secret) })
    expect(replay.status).toBe(422)
    expect(replay.data.error.message).toMatch(/already used/)
    const ok = await c.post('/auth/login/verify', { code: totp(secret, Date.now() + 30000) })
    expect(ok.status, JSON.stringify(ok.data)).toBe(200)
    expect((await c.get('/auth/session')).status).toBe(200)
    // the same code again, in a new sign-in: replay
    const c2 = new Client(base)
    await c2.post('/auth/login', { email: 'tia@example.com', password: t.password })
    expect((await c2.post('/auth/login/verify', { code: totp(secret, Date.now() + 30000) })).status).toBe(422)
    // recovery code: once
    const rc = conf.data.recoveryCodes[3]
    expect((await c2.post('/auth/login/verify', { method: 'recovery_code', code: rc.toLowerCase() })).status).toBe(200)
    const c3 = new Client(base)
    await c3.post('/auth/login', { email: 'tia@example.com', password: t.password })
    expect((await c3.post('/auth/login/verify', { method: 'recovery_code', code: rc })).status).toBe(422)
    expect((await c.get('/auth/security')).data.mfa.recovery).toMatchObject({ total: 10, remaining: 9 })
    // the verify endpoint without a pending sign-in: 401
    expect((await new Client(base).post('/auth/login/verify', { code: '123456' })).status).toBe(401)
    const log = await raw<{ outcome: string; method: string; reason: string }>(`SELECT outcome, method, reason FROM ab.signin_log WHERE user_id = $1 ORDER BY id`, [t.id])
    expect(log.some((l) => l.outcome === 'failure' && l.reason === 'replay')).toBe(true)
    expect(log.some((l) => l.outcome === 'success' && l.method === 'recovery_code')).toBe(true)
  }, 30000)

  it('second-step brute force: 5 wrong codes end the pending sign-in; the account locks after the policy limit', async () => {
    const b = await newUser('Bob', 'bob@example.com')
    const { secret } = await enrol(b.c)
    const c = new Client(base)
    await c.post('/auth/login', { email: 'bob@example.com', password: b.password })
    for (let i = 0; i < 4; i++) expect((await c.post('/auth/login/verify', { code: '000001' })).status).toBe(422)
    const fifth = await c.post('/auth/login/verify', { code: '000001' })
    expect(fifth.status).toBe(401)
    expect(fifth.data.error.message).toMatch(/password again/)
    await clearStep(b.id)
    expect((await c.post('/auth/login/verify', { code: totp(secret, Date.now() + 30000) })).status).toBe(401)
    // 10 failures within the lock window: locked even with the right code
    await c.post('/auth/login', { email: 'bob@example.com', password: b.password })
    for (let i = 0; i < 4; i++) await c.post('/auth/login/verify', { code: '000002' })
    await c.post('/auth/login', { email: 'bob@example.com', password: b.password })
    for (let i = 0; i < 2; i++) await c.post('/auth/login/verify', { code: '000003' })
    const locked = await c.post('/auth/login/verify', { code: totp(secret, Date.now() + 30000) })
    expect(locked.status).toBe(429)
    expect(locked.data.error.message).toMatch(/locked/)
    // an administrator resets the user's two-step verification (audited): password only again, sessions ended
    expect((await A.post(`/users/${b.id}/mfa/reset`)).status).toBe(200)
    expect((await b.c.get('/auth/session')).status).toBe(401)
    expect((await new Client(base).post('/auth/login', { email: 'bob@example.com', password: b.password })).status).toBe(200)
    expect((await raw(`SELECT 1 FROM ab.audit WHERE action = 'user.mfa_reset'`)).length).toBe(1)
  }, 30000)

  it('remember this device: skips the second step for 30 days; tampered or foreign cookies do not; revocable', async () => {
    const r = await newUser('Rae', 'rae@example.com')
    const { secret } = await enrol(r.c)
    const c = new Client(base)
    await c.post('/auth/login', { email: 'rae@example.com', password: r.password })
    expect((await c.post('/auth/login/verify', { code: totp(secret, Date.now() + 30000), remember: true })).status).toBe(200)
    const td = c.cookies.get('ab_td')!
    expect(td).toBeTruthy()
    await c.post('/auth/logout')
    expect((await c.post('/auth/login', { email: 'rae@example.com', password: r.password })).status).toBe(200)
    const dev = (await c.get('/auth/security')).data.devices
    expect(dev).toHaveLength(1)
    // tampered cookie: back to the second step
    const t = new Client(base)
    t.cookies.set('ab_td', td.slice(0, -6) + (td.endsWith('A') ? 'B' : 'A') + td.slice(-5))
    expect((await t.post('/auth/login', { email: 'rae@example.com', password: r.password })).data.error.code).toBe('mfa_required')
    // Rae's cookie does not help another account
    const tia = new Client(base)
    tia.cookies.set('ab_td', td)
    expect((await tia.post('/auth/login', { email: 'tia@example.com', password: 'Tia-own-pass-word-7' })).data.error.code).toBe('mfa_required')
    // forgetting the device
    expect((await c.del(`/auth/devices/${dev[0].id}`)).status).toBe(200)
    const again = new Client(base)
    again.cookies.set('ab_td', td)
    expect((await again.post('/auth/login', { email: 'rae@example.com', password: r.password })).data.error.code).toBe('mfa_required')
  }, 30000)

  it('turning TOTP off needs re-authentication (password or authenticator code)', async () => {
    const d = await newUser('Dan', 'dan@example.com')
    const { secret } = await enrol(d.c)
    await raw(`UPDATE ab.sessions SET auth_on = now() - interval '1 hour' WHERE user_id = $1`, [d.id])
    expect((await d.c.del('/auth/mfa/totp')).data.error.code).toBe('reauth_required')
    expect((await d.c.post('/auth/mfa/recovery-codes')).data.error.code).toBe('reauth_required')
    expect((await d.c.post('/auth/reauth', { code: totp(secret, Date.now() + 30000) })).status).toBe(200)
    const codes = await d.c.post('/auth/mfa/recovery-codes')
    expect(codes.data.recoveryCodes).toHaveLength(10)
    expect((await d.c.del('/auth/mfa/totp')).status).toBe(200)
    expect((await new Client(base).post('/auth/login', { email: 'dan@example.com', password: d.password })).status).toBe(200)
  }, 30000)

  it('email codes as the second step (SMTP set up)', async () => {
    const m = await newUser('Mia', 'mia@example.com')
    const s1 = await m.c.post('/auth/mfa/email/start')
    expect(s1.status, JSON.stringify(s1.data)).toBe(200)
    const setup = await nextMail('mia@example.com', 1, CODE)
    const code = /\b(\d{6})\b/.exec(setup.text)![1]
    expect(setup.subject).not.toContain(code)
    const conf = await m.c.post('/auth/mfa/email/confirm', { code })
    expect(conf.status, JSON.stringify(conf.data)).toBe(200)
    expect(conf.data.recoveryCodes).toHaveLength(10)
    const c = new Client(base)
    const l = await c.post('/auth/login', { email: 'mia@example.com', password: m.password })
    expect(l.data.mfa.methods).toEqual(['email_code'])
    expect((await c.post('/auth/login/email-code')).status).toBe(200)
    expect((await c.post('/auth/login/email-code')).status).toBe(429)
    const mail = await nextMail('mia@example.com', 2, CODE)
    const c2 = /\b(\d{6})\b/.exec(mail.text)![1]
    expect((await c.post('/auth/login/verify', { method: 'email_code', code: c2 })).status).toBe(200)
    // single use
    const again = new Client(base)
    await again.post('/auth/login', { email: 'mia@example.com', password: m.password })
    expect((await again.post('/auth/login/verify', { method: 'email_code', code: c2 })).status).toBe(422)
  }, 30000)

  /* ------------------------------------------------------------------ policy */

  it('MFA policy: grace period, then a restricted session that may only enrol', async () => {
    const g = await newUser('Gus', 'gus@example.com', 'temporary-pass-1', ['role_maker'])
    expect((await A.put('/identity/policy', { mfa: { mode: 'all', graceDays: 3 } })).status).toBe(200)
    const s1 = await g.c.get('/auth/session')
    expect(s1.data.user.mfaRequired.enrolBy).toBeTruthy()
    expect((await g.c.get('/workspace')).status).toBe(200)
    // no grace period left: the next sign-in may only enrol
    expect((await A.put('/identity/policy', { mfa: { mode: 'all', graceDays: 0 } })).status).toBe(200)
    const c = new Client(base)
    const l = await c.post('/auth/login', { email: 'gus@example.com', password: g.password })
    expect(l.status).toBe(200)
    expect(l.data.user.mfaEnrolmentRequired).toBe(true)
    const blocked = await c.get('/workspace')
    expect(blocked.status).toBe(403)
    expect(blocked.data.error.code).toBe('mfa_enrolment_required')
    const { secret } = await enrol(c)
    expect((await c.get('/workspace')).status).toBe(200)
    expect((await c.get('/auth/session')).data.user.mfaEnrolmentRequired).toBeUndefined()
    // turning off the only method is refused while the policy requires it
    await raw(`UPDATE ab.sessions SET auth_on = now() WHERE user_id = $1`, [g.id])
    const off = await c.del('/auth/mfa/totp')
    expect(off.status).toBe(409)
    void secret
    expect((await A.put('/identity/policy', { mfa: { mode: 'off' } })).status).toBe(200)
    expect((await A.put('/identity/policy', { mfa: { mode: 'sometimes' } })).status).toBe(422)
    expect((await A.put('/identity/policy', { mfa: { environments: { nope: 'all' } } })).status).toBe(422)
    expect((await g.c.put('/identity/policy', { mfa: { mode: 'off' } })).status).toBe(403)
  }, 30000)

  it('password policy: minimum length, common passwords, history', async () => {
    expect((await A.put('/identity/policy', { password: { minLength: 14, historyCount: 2 } })).status).toBe(200)
    const h = await newUser('Hal', 'hal@example.com', 'temporary-pass-1-long')
    expect((await h.c.post('/auth/password', { current: h.password, next: 'short-pass-12' })).data.error.message).toMatch(/14 characters/)
    expect((await h.c.post('/auth/password', { current: h.password, next: 'Hal-second-password-1' })).status).toBe(200)
    // the previous one cannot come back
    const back = await h.c.post('/auth/password', { current: 'Hal-second-password-1', next: h.password })
    expect(back.status).toBe(422)
    expect(back.data.error.message).toMatch(/not used recently/)
    expect((await new Client(base).get('/auth/identity-info')).data.passwordMinLength).toBe(14)
    expect((await A.put('/identity/policy', { password: { minLength: 10, historyCount: 0 } })).status).toBe(200)
  }, 30000)

  /* ------------------------------------------------------------------ sessions */

  it('sessions: own list with the current marker, revoke one, sign out everywhere else; admin list and revoke; live sockets close', async () => {
    const k = await newUser('Kim', 'kim@example.com')
    const phone = new Client(base, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1')
    const laptop = new Client(base, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/133.0')
    await phone.post('/auth/login', { email: 'kim@example.com', password: k.password })
    await laptop.post('/auth/login', { email: 'kim@example.com', password: k.password })
    const list = await k.c.get('/auth/sessions')
    expect(list.data.items).toHaveLength(3)
    expect(list.data.items.filter((x: any) => x.current)).toHaveLength(1)
    expect(list.data.items.map((x: any) => x.device).sort()).toEqual(['Chrome 131 on Linux', 'Firefox 133 on Windows', 'Safari 17 on iOS'])
    expect(list.data.items[0].ip).toBe('127.0.0.1')
    expect(JSON.stringify(list.data)).not.toMatch(/[0-9a-f]{64}/)
    // the phone's socket closes when its session is revoked from the laptop
    const ws = new WebSocket(base.replace('http', 'ws') + '/api/v1/live', { headers: { Origin: base, Cookie: phone.cookie } })
    const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)))
    await new Promise<void>((r) => ws.on('message', () => r()))
    const phoneId = list.data.items.find((x: any) => x.device.includes('iOS')).id
    expect((await laptop.del(`/auth/sessions/${phoneId}`)).status).toBe(200)
    expect(await closed).toBe(4401)
    expect((await phone.get('/auth/session')).status).toBe(401)
    // someone else's session id: not found
    expect((await A.del(`/auth/sessions/${list.data.items[0].id}`)).status).toBe(404)
    // sign out everywhere else: the laptop stays, the first browser goes
    const out = await laptop.post('/auth/sessions/revoke-others')
    expect(out.data.ended).toBe(1)
    expect((await k.c.get('/auth/session')).status).toBe(401)
    expect((await laptop.get('/auth/session')).status).toBe(200)
    // administrator: sees and ends them; a WebSocket of that session closes too
    const ws2 = new WebSocket(base.replace('http', 'ws') + '/api/v1/live', { headers: { Origin: base, Cookie: laptop.cookie } })
    const closed2 = new Promise<number>((r) => ws2.on('close', (c) => r(c)))
    await new Promise<void>((r) => ws2.on('message', () => r()))
    const adm = await A.get(`/users/${k.id}/sessions`)
    expect(adm.data.items).toHaveLength(1)
    expect((await A.del(`/users/${k.id}/sessions/${adm.data.items[0].id}`)).status).toBe(200)
    expect(await closed2).toBe(4401)
    expect((await laptop.get('/auth/session')).status).toBe(401)
    await laptop.post('/auth/login', { email: 'kim@example.com', password: k.password })
    expect((await A.del(`/users/${k.id}/sessions`)).status).toBe(200)
    expect((await laptop.get('/auth/session')).status).toBe(401)
    // non-admins cannot see others' sessions
    const v = new Client(base)
    await v.post('/auth/login', { email: 'kim@example.com', password: k.password })
    expect((await v.get(`/users/${(await A.get('/auth/session')).data.user.id}/sessions`)).status).toBe(403)
  }, 30000)

  it('idle timeout and absolute lifetime end sessions', async () => {
    const c = new Client(base)
    await c.post('/auth/login', { email: 'ivy@example.com', password: 'Ivy-chosen-pass-1' })
    const uid = (await c.get('/auth/session')).data.user.id
    await raw(`UPDATE ab.sessions SET last_seen = now() - interval '8 days' WHERE user_id = $1`, [uid])
    expect((await c.get('/auth/session')).status).toBe(401)
    await c.post('/auth/login', { email: 'ivy@example.com', password: 'Ivy-chosen-pass-1' })
    await raw(`UPDATE ab.sessions SET absolute_expires_on = now() - interval '1 minute' WHERE user_id = $1`, [uid])
    expect((await c.get('/auth/session')).status).toBe(401)
    expect((await A.put('/identity/policy', { sessions: { idleMinutes: 30, absoluteHours: 12 } })).status).toBe(200)
    await c.post('/auth/login', { email: 'ivy@example.com', password: 'Ivy-chosen-pass-1' })
    const row = await raw<{ expires_on: string; absolute_expires_on: string }>(`SELECT expires_on, absolute_expires_on FROM ab.sessions WHERE user_id = $1 ORDER BY created_on DESC LIMIT 1`, [uid])
    expect(new Date(row[0].expires_on).getTime() - Date.now()).toBeLessThan(31 * 60000)
    expect(new Date(row[0].absolute_expires_on).getTime() - Date.now()).toBeLessThan(12.1 * 3600000)
    await raw(`UPDATE ab.sessions SET last_seen = now() - interval '31 minutes' WHERE user_id = $1`, [uid])
    expect((await c.get('/auth/session')).status).toBe(401)
    expect((await A.put('/identity/policy', { sessions: { idleMinutes: 10080, absoluteHours: 720 } })).status).toBe(200)
  })

  it('sign-in log: own entries for the user, all for install administrators', async () => {
    const own = await A.get('/auth/signins')
    expect(own.data.items.every((e: any) => e.userId === own.data.items[0].userId)).toBe(true)
    const all = await A.get('/identity/signins?outcome=failure&pageSize=200')
    expect(all.data.items.length).toBeGreaterThan(3)
    expect(all.data.items[0]).toEqual(expect.objectContaining({ outcome: 'failure', reason: expect.any(String), method: expect.any(String), ip: '127.0.0.1' }))
    const kimFails = await new Client(base).post('/auth/login', { email: 'kim@example.com', password: 'nope-nope-nope' })
    expect(kimFails.status).toBe(401)
    const k = await A.get('/identity/signins?outcome=failure&pageSize=1')
    expect(k.data.items[0]).toMatchObject({ email: 'kim@example.com', reason: 'bad_password', method: 'password' })
    const nobody = await new Client(base).post('/auth/login', { email: 'ghost@example.com', password: 'nope-nope-nope' })
    expect(nobody.data).toEqual(kimFails.data)
  })

  it('environment deletion needs re-authentication', async () => {
    const env = await A.post('/environments', { name: 'Scratch', type: 'sandbox' })
    expect(env.status, JSON.stringify(env.data)).toBe(200)
    const me = (await A.get('/auth/session')).data.user.id
    await raw(`UPDATE ab.sessions SET auth_on = now() - interval '1 hour' WHERE user_id = $1`, [me])
    const del = await A.req('DELETE', `/environments/${env.data.id}`, { confirmName: 'Scratch' })
    expect(del.data.error?.code).toBe('reauth_required')
    expect((await A.post('/auth/reauth', { password: 'admin-password-1' })).status).toBe(200)
    expect((await A.req('DELETE', `/environments/${env.data.id}`, { confirmName: 'Scratch', proceedWithoutBackup: true })).status).toBe(200)
  }, 60000)

  /* ------------------------------------------------------------------ service accounts and API keys */

  it('service accounts and API keys: bearer on the Data API only, cookies ignored, revocation, expiry, IP allow-list, rate limit', async () => {
    const t = await A.post('/tables', { displayName: 'Readings', columns: [{ displayName: 'Value', type: 'number' }] })
    expect(t.status).toBe(200)
    const role = await A.post('/roles', { name: 'Agent', apps: [], privileges: [{ table: t.data.id, create: true, read: 'all', update: 'none', delete: 'none' }] })
    const sa = await A.post('/identity/service-accounts', { name: 'LAN agent', environmentId: 'default', roleIds: [role.data.id] })
    expect(sa.status, JSON.stringify(sa.data)).toBe(200)
    expect(sa.data).toMatchObject({ name: 'LAN agent', environmentId: 'default', roleIds: [role.data.id], keys: [] })
    // creating a key needs a recent proof of identity
    const me = (await A.get('/auth/session')).data.user.id
    await raw(`UPDATE ab.sessions SET auth_on = now() - interval '1 hour' WHERE user_id = $1`, [me])
    expect((await A.post(`/identity/service-accounts/${sa.data.id}/keys`, { name: 'k1' })).data.error.code).toBe('reauth_required')
    await A.post('/auth/reauth', { password: 'admin-password-1' })
    const k = await A.post(`/identity/service-accounts/${sa.data.id}/keys`, { name: 'k1', ratePerMinute: 8 })
    expect(k.status, JSON.stringify(k.data)).toBe(200)
    expect(k.data.key).toMatch(/^abk_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/)
    expect(k.data.apiKey.prefix).toBe(k.data.key.slice(4, 12))
    const stored = await raw<Record<string, unknown>>(`SELECT * FROM ab.api_keys`)
    expect(JSON.stringify(stored)).not.toContain(k.data.key.slice(13))
    const bearer = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${k.data.key}`, ...extra })
    const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(base + '/api/v1' + p, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
      return { status: res.status, data: await res.json().catch(() => null) as any }
    }
    // POST without the CSRF header works with a bearer key
    const ins = await call('POST', `/data/${t.data.name}/rows`, { values: { Value: 42 } }, bearer())
    expect(ins.status, JSON.stringify(ins.data)).toBe(200)
    const q = await call('POST', '/query', { plan: { version: 2, table: t.data.name } }, bearer())
    expect(q.status, JSON.stringify(q.data)).toBe(200)
    expect(q.data.rows.map((r: any) => r.Value)).toEqual([42])
    // whoami
    const who = await call('GET', '/auth/session', undefined, bearer())
    expect(who.data.user).toMatchObject({ name: 'LAN agent', kind: 'service' })
    // bearer + an administrator's cookie: the cookie is ignored (acts as the service account, not the admin)
    const mixed = await call('GET', '/auth/session', undefined, bearer({ Cookie: A.cookie }))
    expect(mixed.data.user.kind).toBe('service')
    // the role decides: no update privilege
    expect((await call('PATCH', `/data/${t.data.name}/rows/${ins.data.row?.id ?? ins.data.id}`, { values: { Value: 1 } }, bearer())).status).toBeGreaterThanOrEqual(403)
    // outside the Data API: refused
    expect((await call('GET', '/workspace', undefined, bearer())).status).toBe(403)
    expect((await call('GET', '/audit', undefined, bearer())).status).toBe(403)
    // another environment in the header: refused
    expect((await call('POST', '/query', { plan: { version: 2, table: t.data.name } }, bearer({ 'X-Appbuilder-Environment': 'other' }))).status).toBe(403)
    // a cookie request without the CSRF header is still refused
    expect((await call('POST', '/query', { plan: { version: 2, table: t.data.name } }, { Cookie: A.cookie })).status).toBe(403)
    // rate limit (8 per minute; 6 were used: two more pass, the third is refused with Retry-After)
    const statuses: number[] = []
    for (let i = 0; i < 3; i++) statuses.push((await call('POST', '/query', { plan: { version: 2, table: t.data.name } }, bearer())).status)
    expect(statuses).toEqual([200, 200, 429])
    // invalid, revoked, expired keys
    expect((await call('POST', '/query', { plan: { version: 2, table: t.data.name } }, { Authorization: 'Bearer abk_AAAAAAAA_' + 'x'.repeat(43) })).status).toBe(401)
    expect((await call('POST', '/query', { plan: { version: 2 } }, { Authorization: `Bearer ${k.data.key.slice(0, -1)}Z` })).status).toBe(401)
    const k2 = await A.post(`/identity/service-accounts/${sa.data.id}/keys`, { name: 'k2', ipAllow: ['10.0.0.0/8'] })
    expect((await call('POST', '/query', { plan: { version: 2, table: t.data.name } }, { Authorization: `Bearer ${k2.data.key}` })).status).toBe(403)
    expect((await A.post(`/identity/service-accounts/${sa.data.id}/keys`, { name: 'bad', ipAllow: ['999.1.1.1'] })).status).toBe(422)
    const k3 = await A.post(`/identity/service-accounts/${sa.data.id}/keys`, { name: 'k3', ipAllow: '127.0.0.1, ::1' })
    expect((await call('POST', '/query', { plan: { version: 2, table: t.data.name } }, { Authorization: `Bearer ${k3.data.key}` })).status).toBe(200)
    await raw(`UPDATE ab.api_keys SET expires_on = now() - interval '1 second' WHERE id = $1`, [k3.data.apiKey.id])
    expect((await call('POST', '/query', { plan: { version: 2, table: t.data.name } }, { Authorization: `Bearer ${k3.data.key}` })).status).toBe(401)
    expect((await A.del(`/identity/service-accounts/${sa.data.id}/keys/${k.data.apiKey.id}`)).status).toBe(200)
    expect((await call('POST', '/query', { plan: { version: 2, table: t.data.name } }, bearer())).status).toBe(401)
    // last used tracking, audit
    const list = await A.get('/identity/service-accounts')
    const keyRow = list.data.items[0].keys.find((x: any) => x.id === k.data.apiKey.id)
    expect(keyRow.lastUsedOn).toBeTruthy()
    expect(keyRow.revokedOn).toBeTruthy()
    expect((await raw(`SELECT 1 FROM ab.audit WHERE action IN ('install.api_key_create', 'install.api_key_revoke')`)).length).toBe(4)
    // a service account never signs in with a password, even when an administrator sets one
    const svcUser = await raw<{ email: string }>(`SELECT email FROM ab.users WHERE id = $1`, [sa.data.id])
    await A.post(`/users/${sa.data.id}/password`, { password: 'service-pass-12' })
    expect((await new Client(base).post('/auth/login', { email: svcUser[0].email, password: 'service-pass-12' })).status).toBe(401)
    // deleting the account removes its keys
    expect((await A.del(`/identity/service-accounts/${sa.data.id}`)).status).toBe(200)
    expect((await raw(`SELECT 1 FROM ab.api_keys`)).length).toBe(0)
  }, 60000)
})
