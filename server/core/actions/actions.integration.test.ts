/**
 * P1 package D end to end against the sandbox PostgreSQL (APPBUILDER_TEST_DB), a fake HTTP API and a fake SMTP server:
 * connections and actions over HTTP (use vs manage, end users, secrets never in API answers, activity, audit, job
 * payloads or outputs), custom actions and OpenAPI import, circuit breaker, rate limit, idempotency, DNS rebinding with
 * the lookup hook, the Email connector (suppression, limits, attachments by id and generated), RunConnector from table
 * after-events (attachment needs "use"), inbound webhooks (verification matrix), notification delivery (immediate,
 * locks, quiet hours, digests, unsubscribe without sign-in, delivery log) and scheduled reports (per-recipient security,
 * service identity only for administrators, unsubscribe).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { Client, startHarness, type KernelHarness } from '../kernel-testkit.ts'
import { setQuiet } from '../util.ts'
import { runInEnvironment } from '../env-context.ts'
import { hashPassword } from '../password.ts'
import type { UserRecord } from '../contracts.ts'
import { ROLE_ADMIN, ROLE_MAKER } from '../auth.ts'
import { startFakeSmtp, type FakeSmtp } from '../identity/fake-smtp.ts'
import { setLookupForTests } from './outbound.ts'
import { signPayload } from './webhooks.ts'
import type { VerifiedWebhookPayload } from './contracts.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[actions integration] ${SKIP_PG}\n`)

const PW = 'member-password-1'
const API_KEY = 'sk_live_SECRET_9f8e7d6c'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!PG_URL)(PG_URL ? 'connector actions, webhooks, notifications, reports (PostgreSQL)' : `connector actions ${SKIP_PG}`, { timeout: 180_000 }, () => {
  let h: KernelHarness
  let smtp: FakeSmtp
  let api: http.Server
  let apiBase = ''
  const hits: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = []
  let failMode = false
  let maker: Client
  let viewer: Client
  let ann: Client
  let connId = ''
  const drain = () => h.app.services.kernel.drain({ timeoutMs: 60_000 })
  const mailsTo = (to: string, subject?: RegExp) => smtp.inbox.filter((m) => m.to.includes(to) && (!subject || subject.test(m.subject)))
  async function waitMail(to: string, n: number, subject?: RegExp) {
    const end = Date.now() + 20_000
    while (mailsTo(to, subject).length < n) {
      if (Date.now() > end) throw new Error(`no mail #${n} to ${to}; inbox: ${smtp.inbox.map((m) => `${m.to}:${m.subject}`).join(', ')}`)
      await drain()
      await sleep(50)
    }
    return mailsTo(to, subject)[n - 1]
  }

  const addUser = async (id: string, email: string, roleIds: string[]): Promise<Client> => {
    await runInEnvironment('default', () => h.app.services.meta.users.insert({ id, name: id.replace('user_', '').replace(/^./, (c) => c.toUpperCase()), email, roleIds, status: 'active', passwordHash: '' } as UserRecord))
    await h.q('UPDATE ab.users SET password_hash = $1 WHERE id = $2', [await hashPassword(PW), id])
    await h.q('INSERT INTO ab.environment_access (environment_id, user_id, is_env_admin, granted_on) VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING', ['default', id, roleIds.includes(ROLE_ADMIN)]).catch(() => undefined)
    h.app.services.security.invalidate('all')
    const c = new Client(h.base)
    const r = await c.post('/auth/login', { email, password: PW })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return c
  }

  beforeAll(async () => {
    smtp = await startFakeSmtp()
    api = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        hits.push({ method: req.method!, url: req.url!, headers: req.headers, body })
        const u = new URL(req.url!, 'http://x')
        const json = (s: number, v: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)) }
        if (u.pathname === '/') return json(200, { service: 'fake' })
        if (u.pathname === '/echo') return json(200, { headers: req.headers, query: Object.fromEntries(u.searchParams), body })
        if (u.pathname === '/flaky') return failMode ? json(503, { error: 'down' }) : json(200, { ok: true })
        if (u.pathname.startsWith('/customers/')) return json(200, { data: { id: u.pathname.split('/')[2], name: 'Acme' } })
        if (u.pathname === '/orders' && req.method === 'POST') return json(201, { id: `o${hits.length}`, received: JSON.parse(body || '{}') })
        if (u.pathname === '/hook') return json(200, { got: JSON.parse(body || '{}') })
        json(404, { error: 'not found' })
      })
    })
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r))
    apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
    h = await startHarness('actions', { env: { APPBUILDER_MIGRATION_BACKUP: 'skip' } })
    // email relay with a public address (links in emails)
    const mail = await h.admin.req('PUT', '/identity/email', { host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'apps@example.com', installName: 'Acme Apps', publicUrl: 'https://apps.example.com' })
    expect(mail.status, JSON.stringify(mail.data)).toBe(200)
    maker = await addUser('user_mia', 'mia@example.com', [ROLE_MAKER])
    viewer = await addUser('user_vic', 'vic@example.com', ['role_viewer'])
  }, 180_000)

  afterAll(async () => {
    setLookupForTests(null)
    await h?.close()
    await smtp?.close()
    await new Promise<void>((r) => (api ? api.close(() => r()) : r()))
  }, 60_000)

  /* ---------------------------------------------------------------- connections, permissions, secrets */

  it('creates an HTTP connection (admins only), tests it, and never returns or logs its secret', async () => {
    expect((await maker.post('/connections', { name: 'X', connector: 'http', settings: { baseUrl: apiBase } })).status).toBe(403)
    // no allow-list entry for a private address without the opt-in: the test fails, the connection is stored
    const bad = await h.admin.post('/connections', { name: 'Fake API', connector: 'http', settings: { baseUrl: apiBase, authMode: 'apiKey', apiKeyName: 'X-Api-Key' }, secret: JSON.stringify({ apiKey: API_KEY }) })
    expect(bad.status, JSON.stringify(bad.data)).toBe(200)
    expect(bad.data.status).toBe('error')
    expect(bad.data.lastError).toMatch(/private networks/)
    connId = bad.data.id
    const ok = await h.admin.patch(`/connections/${connId}`, { settings: { baseUrl: apiBase, authMode: 'apiKey', apiKeyName: 'X-Api-Key', allowPrivateNetwork: 'true', perMinute: '1000' } })
    expect(ok.data.status, JSON.stringify(ok.data)).toBe('connected')
    expect(JSON.stringify(ok.data)).not.toContain(API_KEY)
    expect(ok.data.settings.allowedHosts).toBe('127.0.0.1')
    expect(ok.data.hasSecret).toBe(true)
    const ws = await viewer.get('/workspace')
    expect(ws.status).toBe(200)
    expect(JSON.stringify(ws.data)).not.toContain(API_KEY)
    const aws = JSON.stringify((await h.admin.get('/workspace')).data)
    expect(aws).toContain(connId)
    expect(aws).not.toContain(API_KEY)
    // open proxy refused: '*' as allow-list
    expect((await h.admin.post('/connections', { name: 'Open', connector: 'http', settings: { baseUrl: 'https://a.example.com', allowedHosts: '*' } })).status).toBe(422)
  })

  it('use vs manage: only administrators and granted people list, test and change actions', async () => {
    expect((await maker.get(`/connections/${connId}/actions`)).status).toBe(403)
    expect((await viewer.get(`/connections/${connId}/actions`)).status).toBe(403)
    expect((await maker.post(`/connections/${connId}/actions/request/test`, { inputs: { path: '/echo' } })).status).toBe(403)
    expect((await maker.req('PUT', `/connections/${connId}/access`, { grants: [{ principalKind: 'user', principalId: 'user_mia', level: 'manage' }] })).status).toBe(403)
    expect((await h.admin.req('PUT', `/connections/${connId}/access`, { grants: [{ principalKind: 'user', principalId: 'user_mia', level: 'use' }] })).status).toBe(200)
    const acts = await maker.get(`/connections/${connId}/actions`)
    expect(acts.data.items.map((a: { id: string }) => a.id)).toEqual(['request'])
    const avail = await maker.get('/actions/connections')
    expect(avail.data.items.map((c: { id: string }) => c.id)).toEqual([connId])
    expect((await viewer.get('/actions/connections')).data.items).toEqual([])
    // "use" may test but not change custom actions
    const t = await maker.post(`/connections/${connId}/actions/request/test`, { inputs: { path: '/echo', query: { q: 1 } } })
    expect(t.status).toBe(200)
    expect(t.data.ok, JSON.stringify(t.data)).toBe(true)
    // the echo answer contains the API key header: it comes back hidden
    expect(JSON.stringify(t.data)).not.toContain(API_KEY)
    expect(t.data.output.body.headers['x-api-key']).toBe('[hidden]')
    expect(hits.at(-1)!.headers['x-api-key']).toBe(API_KEY)
    expect((await maker.req('PUT', `/connections/${connId}/custom-actions/getCustomer`, { http: { method: 'GET', path: '/x' } })).status).toBe(403)
    // invalid inputs never reach the API
    const n = hits.length
    const bad = await maker.post(`/connections/${connId}/actions/request/test`, { inputs: { method: 'BREW', path: '/echo' } })
    expect(bad.data).toMatchObject({ ok: false, error: { code: 'invalid_input', retryable: false } })
    expect(hits.length).toBe(n)
    // activity: the maker sees their own calls, the state shows which secret parts are set (never values)
    const act = await maker.get(`/connections/${connId}/activity`)
    expect(act.data.all).toBe(false)
    expect(act.data.items[0]).toMatchObject({ actionId: 'request', userId: 'user_mia', status: 'failed', errorCode: 'invalid_input' })
    const st = await maker.get(`/connections/${connId}/state`)
    expect(st.data).toMatchObject({ circuit: 'closed', secretParts: ['apiKey'] })
    expect((await h.admin.req('PUT', `/connections/${connId}/access`, { grants: [{ principalKind: 'user', principalId: 'user_mia', level: 'manage' }] })).status).toBe(200)
  })

  it('custom actions by form, OpenAPI import (preview, apply), and their runs', async () => {
    const put = await maker.req('PUT', `/connections/${connId}/custom-actions/getCustomer`, {
      title: 'Get customer', inputs: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      http: { method: 'GET', path: '/customers/{{id}}', outputPath: 'data', sample: { data: { id: 'c1', name: 'Acme' } } },
    })
    expect(put.status, JSON.stringify(put.data)).toBe(200)
    expect(put.data.outputs).toEqual({ type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } })
    const r = await maker.post(`/connections/${connId}/actions/getCustomer/test`, { inputs: { id: 'c 9' } })
    expect(r.data).toMatchObject({ ok: true, output: { id: 'c%209', name: 'Acme' } })
    expect(hits.at(-1)!.url).toBe('/customers/c%209')
    const spec = JSON.stringify({ openapi: '3.0.3', info: { title: 'Orders', version: '1' }, servers: [{ url: apiBase }], paths: { '/orders': { post: { operationId: 'createOrder', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['sku'], properties: { sku: { type: 'string' }, qty: { type: 'integer' } } } } } }, responses: { 201: { content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } } } } } })
    const pre = await maker.post(`/connections/${connId}/custom-actions/openapi`, { text: spec })
    expect(pre.data).toMatchObject({ applied: false, title: 'Orders', actions: [{ id: 'createOrder', method: 'POST', path: '/orders', sideEffect: 'external', exists: false }] })
    const ap = await maker.post(`/connections/${connId}/custom-actions/openapi`, { text: spec, apply: true })
    expect(ap.data).toMatchObject({ applied: true, imported: 1 })
    const names = (await maker.get(`/connections/${connId}/actions`)).data.items.map((a: { id: string }) => a.id)
    expect(names).toEqual(['request', 'createOrder', 'getCustomer'])
    expect((await maker.post(`/connections/${connId}/actions/createOrder/test`, { inputs: { body: { qty: 1 } } })).data.error.code).toBe('invalid_input')
    const ok = await maker.post(`/connections/${connId}/actions/createOrder/test`, { inputs: { body: { sku: 'A1', qty: 2 } } })
    expect(ok.data).toMatchObject({ ok: true, output: { received: { sku: 'A1', qty: 2 } } })
  })

  it('custom actions travel in solutions (without the secret)', async () => {
    const sol = await h.admin.post('/solutions', { displayName: 'Partner API' })
    expect((await h.admin.post(`/solutions/${sol.data.id}/components`, { kind: 'connection', id: connId })).status).toBe(200)
    const pkg = await h.admin.get(`/solutions/${sol.data.id}/package`)
    expect(pkg.data.yaml).toContain('getCustomer')
    expect(pkg.data.yaml).toContain('createOrder')
    expect(pkg.data.yaml).not.toContain(API_KEY)
    const imp = await h.admin.post('/solutions/import', { yaml: pkg.data.yaml, asCopy: true })
    expect(imp.status, JSON.stringify(imp.data)).toBe(200)
    const copy = (await h.q<{ id: string; secret_sealed: string | null }>(`SELECT id, secret_sealed FROM env_default.ab_connections WHERE id <> $1 AND name LIKE 'Fake API%'`, [connId]))[0]
    expect(copy).toBeTruthy()
    expect(copy.secret_sealed).toBeNull()
    const acts = (await h.admin.get(`/connections/${copy.id}/actions`)).data.items.map((a: { id: string }) => a.id)
    expect(acts).toEqual(['request', 'createOrder', 'getCustomer'])
  })

  it('idempotency: a non-idempotent external action with the same key runs once; the stored result is replayed', async () => {
    const svc = h.app.services.actions!
    const me = await runInEnvironment('default', async () => h.app.services.security.forUser((await h.app.services.meta.users.get('user_mia'))! as never))
    const before = hits.filter((x) => x.url === '/orders').length
    const a = await svc.run('default', connId, 'createOrder', { body: { sku: 'K' } }, me, { idempotencyKey: 'flow:1:step:7' })
    const b = await svc.run('default', connId, 'createOrder', { body: { sku: 'K' } }, me, { idempotencyKey: 'flow:1:step:7' })
    expect(a.ok && b.ok, JSON.stringify([a, b])).toBe(true)
    expect(b.ok && b.replayed).toBe(true)
    expect(b.ok && a.ok && b.output).toEqual(a.ok && a.output)
    expect(hits.filter((x) => x.url === '/orders').length).toBe(before + 1)
    // idempotent actions are not stored (a GET runs each time)
    const g1 = await svc.run('default', connId, 'getCustomer', { id: 'z' }, me, { idempotencyKey: 'k2' })
    const g2 = await svc.run('default', connId, 'getCustomer', { id: 'z' }, me, { idempotencyKey: 'k2' })
    expect(g1.ok && g2.ok && !g2.replayed).toBe(true)
  })

  it('circuit breaker opens after repeated failures, shows on the state, and closes on reset; rate limit', async () => {
    const svc = h.app.services.actions!
    failMode = true
    for (let i = 0; i < 5; i++) {
      const r = await svc.run('default', connId, 'request', { path: '/flaky' }, null)
      expect(r.ok === false && r.error.code).toBe('upstream')
    }
    const n = hits.length
    const open = await svc.run('default', connId, 'request', { path: '/flaky' }, null)
    expect(open.ok === false && open.error).toMatchObject({ code: 'circuit_open', retryable: true })
    expect(hits.length).toBe(n)
    const st = await maker.get(`/connections/${connId}/state`)
    expect(st.data).toMatchObject({ circuit: 'open', failures: 5 })
    failMode = false
    expect((await viewer.post(`/connections/${connId}/state/reset`)).status).toBe(403)
    expect((await maker.post(`/connections/${connId}/state/reset`)).data.circuit).toBe('closed')
    expect((await svc.run('default', connId, 'request', { path: '/flaky' }, null)).ok).toBe(true)
    // rate limit per connection
    const slow = await h.admin.post('/connections', { name: 'Slow API', connector: 'http', settings: { baseUrl: apiBase, allowPrivateNetwork: 'true', perMinute: '2' } })
    const results = []
    for (let i = 0; i < 3; i++) results.push(await svc.run('default', slow.data.id, 'request', { path: '/' }, null))
    expect(results.map((r) => (r.ok ? 'ok' : r.error.code))).toEqual(['ok', 'ok', 'rate_limited'])
  })

  it('DNS rebinding: an allowed name that starts resolving to a private address is refused', async () => {
    const port = new URL(apiBase).port
    const c = await h.admin.post('/connections', { name: 'Partner', connector: 'http', settings: { baseUrl: `http://partner.example.test:${port}` } })
    expect(c.status).toBe(200)
    setLookupForTests(async () => [{ address: '127.0.0.1', family: 4 }])
    try {
      const r = await h.app.services.actions!.run('default', c.data.id, 'request', { path: '/' }, null)
      expect(r.ok === false && r.error).toMatchObject({ code: 'blocked' })
      expect(r.ok === false && r.error.message).toMatch(/private networks/)
    } finally {
      setLookupForTests(null)
    }
  })

  it('secrets never appear in the activity log, the audit log, job payloads or the connection list', async () => {
    const rows = await h.q<{ t: string }>(`SELECT (SELECT coalesce(string_agg(r::text, ' '), '') FROM env_default.ab_action_runs r) || (SELECT coalesce(string_agg(a::text, ' '), '') FROM env_default.ab_audit a) || (SELECT coalesce(string_agg(j::text, ' '), '') FROM env_default.ab_jobs j) || (SELECT coalesce(string_agg(i::text, ' '), '') FROM env_default.ab_action_idempotency i) AS t`)
    expect(rows[0].t.length).toBeGreaterThan(100)
    expect(rows[0].t).not.toContain(API_KEY)
    const sealed = await h.q<{ secret_sealed: string }>(`SELECT secret_sealed FROM env_default.ab_connections WHERE id = $1`, [connId])
    expect(sealed[0].secret_sealed).toMatch(/^v1:/)
    const admAct = await h.admin.get(`/connections/${connId}/activity?limit=200`)
    expect(admAct.data.all).toBe(true)
    expect(JSON.stringify(admAct.data)).not.toContain(API_KEY)
  })

  /* ---------------------------------------------------------------- email connector */

  it('Email connector: send with copies and attachments; suppression list; environment limits', async () => {
    const t = await h.admin.post('/tables', { displayName: 'Doc', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'File', type: 'file' }] })
    expect(t.status, JSON.stringify(t.data)).toBe(200)
    const row = await h.admin.post('/data/Doc/rows', { values: { Title: 'Spec' } })
    const up = await fetch(`${h.base}/api/v1/attachments?table=${t.data.id}&column=File&rowId=${row.data.row.id}&name=spec.txt`, { method: 'POST', headers: { 'X-Appbuilder': '1', Cookie: h.admin.cookie, 'Content-Type': 'text/plain' }, body: 'the spec' })
    const att = (await up.json()) as { id: string }
    expect(up.status, JSON.stringify(att)).toBe(200)
    const e = await h.admin.post('/connections', { name: 'Mail', connector: 'email', settings: { fromName: 'Orders bot' } })
    expect(e.data.status, JSON.stringify(e.data)).toBe('connected')
    const svc = h.app.services.actions!
    const ada = await runInEnvironment('default', async () => h.app.services.security.forUser((await h.app.services.meta.users.get((await h.q<{ id: string }>(`SELECT id FROM ab.users WHERE email = 'ada@example.com'`))[0].id))! as never))
    const r = await svc.run('default', e.data.id, 'send', { to: ['buyer@example.com'], cc: ['boss@example.com'], subject: 'Your order', html: '<p>Hello <b>buyer</b><script>alert(1)</script></p>', attachments: [{ attachmentId: att.id }, { fileName: 'lines.csv', text: 'sku,qty\nA,1\n', contentType: 'text/csv' }] }, ada, { idempotencyKey: 'mail-1' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const m = await waitMail('buyer@example.com', 1, /Your order/)
    expect(m.to.sort()).toEqual(['boss@example.com', 'buyer@example.com'])
    expect(m.headers.from).toContain('Orders bot')
    expect(m.html).toContain('<b>buyer</b>')
    expect(m.html).not.toContain('<script')
    expect(m.attachments.map((a) => [a.fileName, a.content.toString()])).toEqual([['spec.txt', 'the spec'], ['lines.csv', 'sku,qty\nA,1\n']])
    // an attachment the identity may not open is refused (Vic cannot read Doc rows? viewers read all: use a made-up id)
    const no = await svc.run('default', e.data.id, 'send', { to: 'x@example.com', subject: 's', text: 't', attachments: [{ attachmentId: 'att_nope' }] }, ada)
    expect(no.ok === false && no.error.code).toBe('denied')
    // suppression list (install administrators)
    expect((await maker.post('/admin/mail-suppressions', { address: 'gone@example.com' })).status).toBe(403)
    expect((await h.admin.post('/admin/mail-suppressions', { address: 'Gone@Example.com', note: 'bounced' })).status).toBe(200)
    const sup = await svc.run('default', e.data.id, 'send', { to: 'gone@example.com', subject: 's', text: 't' }, ada)
    expect(sup.ok === false && sup.error).toMatchObject({ code: 'denied', retryable: false })
    const part = await svc.run('default', e.data.id, 'send', { to: ['gone@example.com', 'kept@example.com'], subject: 'Partly', text: 't' }, ada)
    expect(part.ok && part.output).toMatchObject({ recipients: 1, suppressed: 1 })
    // environment limit (recipients per hour)
    process.env.APPBUILDER_EMAIL_PER_HOUR = '4'
    try {
      const lim = await svc.run('default', e.data.id, 'send', { to: ['a1@example.com', 'a2@example.com'], subject: 'Too many', text: 't' }, ada)
      expect(lim.ok === false && lim.error).toMatchObject({ code: 'limit', retryable: true })
    } finally {
      delete process.env.APPBUILDER_EMAIL_PER_HOUR
    }
  })

  /* ---------------------------------------------------------------- RunConnector from table events */

  it('RunConnector in an after-event: attaching needs "use"; the call runs as the event identity; before-events cannot attach', async () => {
    const t = await h.admin.post('/tables', { displayName: 'Lead', columns: [{ displayName: 'Name', type: 'text' }] })
    const ev = { name: 'Tell partner', kind: 'event', timing: 'after', operations: ['create'], actions: `RunConnector("Fake API", "request", {method: "POST", path: "/hook", body: {name: New.Name}})`, connections: [connId] }
    const vicAsMaker = await addUser('user_max', 'max@example.com', [ROLE_MAKER])
    expect((await vicAsMaker.post(`/tables/${t.data.id}/events`, ev)).status).toBe(403)
    expect((await maker.post(`/tables/${t.data.id}/events`, { ...ev, timing: 'before', actions: 'SetField("Name", New.Name)' })).status).toBe(422)
    const saved = await maker.post(`/tables/${t.data.id}/events`, ev)
    expect(saved.status, JSON.stringify(saved.data)).toBe(200)
    expect(saved.data.event.connections).toEqual([connId])
    // an event without the attachment fails in the run log (not retried)
    const unattached = await h.admin.post(`/tables/${t.data.id}/events`, { ...ev, name: 'Not attached', connections: [] })
    expect(unattached.status).toBe(200)
    const before = hits.filter((x) => x.url === '/hook').length
    expect((await maker.post('/data/Lead/rows', { values: { Name: 'Zed' } })).status).toBe(200)
    await drain()
    const hookHits = hits.filter((x) => x.url === '/hook')
    expect(hookHits.length).toBe(before + 1)
    expect(JSON.parse(hookHits.at(-1)!.body)).toEqual({ name: 'Zed' })
    const runs = await h.admin.get(`/tables/${t.data.id}/event-runs`)
    const byName = (n: string) => runs.data.items.find((x: { eventName: string }) => x.eventName === n)
    expect(byName('Tell partner').status).toBe('ok')
    expect(byName('Not attached')).toMatchObject({ status: 'failed' })
    expect(byName('Not attached').message).toMatch(/not attached/)
    const act = await h.admin.get(`/connections/${connId}/activity`)
    expect(act.data.items[0]).toMatchObject({ userId: 'user_mia', source: `event:${saved.data.event.id}`, status: 'ok' })
  })

  /* ---------------------------------------------------------------- inbound webhooks */

  it('webhooks in: verification matrix (token, signature, replay, size, type, rate), rotate and revoke', async () => {
    const flows = h.app.services.flows as unknown as Record<string, unknown>
    const received: VerifiedWebhookPayload[] = []
    flows.triggerWebhook = async (_env: string, _flow: string, p: VerifiedWebhookPayload) => { received.push(p); return { runId: `run_${received.length}` } }
    flows.webhookFlow = async (_env: string, id: string) => (id === 'flow_orders' ? { id, name: 'Orders in', enabled: true } : null)
    flows.canManage = async (u: { user: { id: string } }) => u.user.id === 'user_mia' || u.user.id.startsWith('user_') === false
    expect((await viewer.post('/flows/flow_orders/webhooks', {})).status).toBe(403)
    expect((await maker.post('/flows/flow_nope/webhooks', {})).status).toBe(404)
    const c = await maker.post('/flows/flow_orders/webhooks', { perMinute: 9, maxBodyKB: 1 })
    expect(c.status, JSON.stringify(c.data)).toBe(200)
    const { token, secret, url } = c.data as { token: string; secret: string; url: string }
    expect(url).toBe(`https://apps.example.com/api/v1/hooks/default/flow_orders/${token}`)
    expect((await maker.get('/flows/flow_orders/webhooks')).data.items[0]).not.toHaveProperty('token')
    const path = `/api/v1/hooks/default/flow_orders/${token}`
    const send = async (body: string, o: { type?: string; sig?: string; path?: string } = {}) => {
      const headers: Record<string, string> = { 'Content-Type': o.type ?? 'application/json' }
      if (o.sig) headers['X-Appbuilder-Signature'] = o.sig
      const r = await fetch(h.base + (o.path ?? path), { method: 'POST', headers, body })
      return { status: r.status, data: await r.json().catch(() => null) as Record<string, unknown> | null }
    }
    const sign = (body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${signPayload(secret, t, body)}`
    // no CSRF header needed, but everything else is checked
    expect((await send('{"a":1}', { path: `/api/v1/hooks/default/flow_orders/${'x'.repeat(43)}` })).status).toBe(404)
    expect((await send('{"a":1}', { path: `/api/v1/hooks/nope/flow_orders/${token}` })).status).toBe(404)
    expect((await send('{"a":1}')).status).toBe(401) // signature required by default
    expect((await send('{"a":1}', { sig: `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` })).status).toBe(401)
    expect((await send('{"a":1}', { sig: sign('{"a":1}', Math.floor(Date.now() / 1000) - 600) })).status).toBe(401)
    const body = '{"order":"A-1","total":12.5}'
    const sig = sign(body)
    const ok = await send(body, { sig })
    expect(ok.status).toBe(202)
    expect(ok.data).toEqual({ accepted: true, id: 'run_1' })
    expect(received[0]).toMatchObject({ flowId: 'flow_orders', verifiedBy: 'hmac-sha256', contentType: 'application/json', body: { order: 'A-1', total: 12.5 } })
    expect(received[0].headers).not.toHaveProperty('x-appbuilder-signature')
    expect((await send(body, { sig })).status).toBe(409) // replay
    expect((await send('x'.repeat(2048), { sig: sign('x'.repeat(2048)), type: 'text/plain' })).status).toBe(413)
    const form = 'a=1&b=2&b=3'
    expect((await send(form, { sig: sign(form), type: 'application/x-www-form-urlencoded' })).status).toBe(202)
    expect(received.at(-1)!.body).toEqual({ a: '1', b: ['2', '3'] })
    expect((await send('<x/>', { sig: sign('<x/>'), type: 'application/xml' })).status).toBe(415)
    // rate limit: 6 a minute
    let limited = 0
    for (let i = 0; i < 6; i++) if ((await send(`{"i":${i}}`, { sig: sign(`{"i":${i}}`) })).status === 429) limited++
    expect(limited).toBeGreaterThan(0)
    const id = c.data.hook.id as string
    // token only (no signature) when the maker allows it
    await maker.patch(`/webhooks/${id}`, { requireSignature: false, perMinute: 100 })
    expect((await send('{"plain":true}')).status).toBe(202)
    expect(received.at(-1)!.verifiedBy).toBe('token')
    // rotate the token: the old address stops working
    const rot = await maker.post(`/webhooks/${id}/rotate`, { token: true })
    expect(rot.data.token).toBeTruthy()
    expect((await send('{"x":1}')).status).toBe(404)
    expect((await send('{"x":1}', { path: `/api/v1/hooks/default/flow_orders/${rot.data.token}` })).status).toBe(202)
    expect((await maker.del(`/webhooks/${id}`)).status).toBe(200)
    expect((await send('{"x":1}', { path: `/api/v1/hooks/default/flow_orders/${rot.data.token}` })).status).toBe(404)
    const aud = await h.q<{ action: string }>(`SELECT action FROM env_default.ab_audit WHERE action LIKE 'webhook.%' ORDER BY id`)
    expect(aud.map((a) => a.action)).toEqual(['webhook.create', 'webhook.update', 'webhook.rotate', 'webhook.revoke'])
    const tokHash = await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.ab_audit WHERE details::text LIKE $1`, [`%${token}%`])
    expect(tokHash[0].n).toBe(0)
  })

  /* ---------------------------------------------------------------- notification delivery */

  it('notifications by email: immediate with deep link, delivery log, unsubscribe without signing in, locks', async () => {
    ann = await addUser('user_ann', 'ann@example.com', ['role_viewer'])
    expect((await ann.req('PUT', '/notifications/settings', { kinds: {}, desktop: false, dnd: null, hidePresence: false, email: { app: 'immediate' }, timeZone: 'UTC' })).status).toBe(200)
    const ch = await ann.get('/notifications/channels')
    expect(ch.data.kinds.find((k: { kind: string }) => k.kind === 'app')).toMatchObject({ email: 'immediate', locked: false })
    expect(ch.data.kinds.find((k: { kind: string }) => k.kind === 'approval')).toMatchObject({ email: 'immediate' })
    expect((await maker.post('/notifications/send', { to: 'ann@example.com', title: 'Order 42 shipped', body: 'Track it', link: '#u-tasks' })).status).toBe(200)
    await drain()
    const m = await waitMail('ann@example.com', 1, /Order 42 shipped/)
    expect(m.html).toContain('https://apps.example.com/#u-tasks')
    expect(m.headers['list-unsubscribe-post']).toBe('List-Unsubscribe=One-Click')
    const log = await ann.get('/notifications/deliveries')
    expect(log.data.items.map((x: { channel: string; status: string }) => `${x.channel}:${x.status}`).sort()).toEqual(['email:queued', 'in_app:delivered'])
    expect(log.data.items.find((x: { channel: string }) => x.channel === 'email').reason).toMatch(/You chose an email right away/)
    // unsubscribe from the link, without a session
    const unsub = /<(https:\/\/apps\.example\.com[^>]+)>/.exec(m.headers['list-unsubscribe'])![1].replace('https://apps.example.com', h.base)
    const page = await fetch(unsub)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Stop emails about')
    expect((await fetch(unsub.replace(/t=[^&]+/, 't=forged.token'), { method: 'POST' })).status).toBe(400)
    const one = await fetch(unsub, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })
    expect(one.status).toBe(200)
    expect((await ann.get('/notifications/settings')).data.email.app).toBe('off')
    // administrator lock: approvals always by email, even when the user switched it off
    expect((await maker.req('PUT', '/admin/notifications/policy', { kinds: { approval: { email: 'immediate', lock: true } } })).status).toBe(403)
    expect((await h.admin.req('PUT', '/admin/notifications/policy', { kinds: { approval: { email: 'immediate', lock: true } }, logoUrl: 'https://apps.example.com/logo.png' })).status).toBe(200)
    await ann.req('PUT', '/notifications/settings', { kinds: {}, email: { approval: 'off', app: 'off' } })
    await h.app.services.notifications!.notify({ userIds: ['user_ann'] }, { kind: 'approval', title: 'Approve PO-7', source: 'system', environmentId: 'default' })
    const ap = await waitMail('ann@example.com', 1, /Approve PO-7/)
    expect(ap.html).toContain('logo.png')
    const lastLog = (await ann.get('/notifications/deliveries')).data.items[0]
    expect(lastLog.reason).toMatch(/administrator set "Approvals"/)
    // the locked kind cannot be muted by the link
    const lockUrl = /<(https:\/\/apps\.example\.com[^>]+)>/.exec(ap.headers['list-unsubscribe'])![1].replace('https://apps.example.com', h.base)
    expect(await (await fetch(lockUrl)).text()).toContain('required')
  })

  it('quiet hours hold emails; digests collect them; admins read every delivery log', async () => {
    // quiet hours all day long: an immediate email waits
    await ann.req('PUT', '/notifications/settings', { kinds: {}, email: { app: 'immediate', flow: 'digest' }, dnd: { start: '00:00', end: '23:59' }, timeZone: 'UTC', digest: { frequency: 'hourly', time: '08:00' } })
    const n0 = mailsTo('ann@example.com').length
    await h.app.services.notifications!.notify({ userIds: ['user_ann'] }, { kind: 'app', title: 'Quiet one', source: 'system' })
    await h.app.services.notifications!.notify({ userIds: ['user_ann'] }, { kind: 'flow', title: 'Flow says hi', source: 'flow:f1' })
    await drain()
    expect(mailsTo('ann@example.com').length).toBe(n0)
    const held = await h.q<{ title: string; hold_until: Date | null }>(`SELECT title, hold_until FROM ab.notification_digest WHERE user_id = 'user_ann' ORDER BY title`)
    expect(held.map((x) => [x.title, x.hold_until !== null])).toEqual([['Flow says hi', false], ['Quiet one', true]])
    // the digest job does nothing inside quiet hours; after them (no quiet hours) it sends one email with both
    const runDigests = async (at: Date) => {
      const { createDelivery } = await import('../notifications-delivery.ts')
      return runInEnvironment('default', () => createDelivery(h.app.services).runDigests(at))
    }
    expect((await runDigests(new Date())).emails).toBe(0)
    await ann.req('PUT', '/notifications/settings', { kinds: {}, email: { app: 'immediate', flow: 'digest' }, dnd: null, timeZone: 'UTC', digest: { frequency: 'hourly', time: '08:00' } })
    const later = new Date(Date.now() + 2 * 3600_000)
    expect((await runDigests(later)).emails).toBe(1)
    const d = await waitMail('ann@example.com', n0 + 1)
    expect(d.subject).toMatch(/2 notifications/)
    expect(d.text).toContain('Quiet one')
    expect(d.text).toContain('Flow says hi')
    expect((await h.q(`SELECT 1 FROM ab.notification_digest WHERE user_id = 'user_ann'`)).length).toBe(0)
    expect((await runDigests(new Date(later.getTime() + 60_000))).emails).toBe(0)
    const sent = (await ann.get('/notifications/deliveries')).data.items.filter((x: { status: string }) => x.status === 'sent')
    expect(sent.length).toBe(2)
    expect((await ann.get('/admin/notifications/deliveries')).status).toBe(403)
    expect((await h.admin.get('/admin/notifications/deliveries?userId=user_ann')).data.items.length).toBeGreaterThan(3)
  })

  /* ---------------------------------------------------------------- scheduled reports */

  it('scheduled reports: each recipient gets their own rows; service identity only for administrators; unsubscribe', async () => {
    const t = await h.admin.post('/tables', { displayName: 'Deal', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Amount', type: 'number' }] })
    expect(t.status).toBe(200)
    const own = await h.admin.post('/roles', { name: 'Own deals', apps: 'all', privileges: [{ table: t.data.id, create: true, read: 'own', update: 'own', delete: 'own' }] })
    const rita = await addUser('user_rita', 'rita@example.com', [own.data.id])
    for (const [c, title, amount] of [[rita, 'Rita deal', 100], [h.admin, 'Big deal', 9000], [h.admin, '=cmd|calc', 5]] as const) {
      expect((await c.post('/data/Deal/rows', { values: { Title: title, Amount: amount } })).status).toBe(200)
    }
    // a user subscribes only themselves; others need maker rights
    expect((await rita.post('/reports', { name: 'Mine', source: { kind: 'table', tableId: t.data.id, plan: { version: 2, table: 'Deal' } }, recipients: { userIds: ['user_rita', 'user_mia'], teamIds: [] } })).status).toBe(403)
    // service identity: administrators only
    expect((await maker.post('/reports', { name: 'Svc', source: { kind: 'table', tableId: t.data.id, plan: { version: 2, table: 'Deal' } }, runAs: { serviceAccount: 'user_x' }, recipients: { userIds: ['user_mia'], teamIds: [] } })).status).toBe(403)
    const preview = await h.admin.post('/reports/preview', { def: { source: { kind: 'table', tableId: t.data.id, plan: { version: 2, table: 'Deal', sort: [{ col: 'Amount', dir: 'desc' }], select: ['Title', 'Amount'] } } } })
    expect(preview.data.rows.map((r: { Title: string }) => r.Title)).toEqual(['Big deal', 'Rita deal', '=cmd|calc'])
    const rep = await h.admin.post('/reports', {
      name: 'Morning deals', source: { kind: 'table', tableId: t.data.id, plan: { version: 2, table: 'Deal', sort: [{ col: 'Amount', dir: 'desc' }], select: ['Title', 'Amount'] } },
      schedule: { frequency: 'daily', time: '07:00', timeZone: 'Asia/Kolkata' }, recipients: { userIds: ['user_rita', 'user_ann', (await h.q<{ id: string }>(`SELECT id FROM ab.users WHERE email = 'ada@example.com'`))[0].id], teamIds: [] }, inlineRows: 2, onEmpty: 'skip',
    })
    expect(rep.status, JSON.stringify(rep.data)).toBe(200)
    expect(rep.data.scheduleText).toMatch(/Asia\/Kolkata/)
    const sched = await h.q<{ cron: string; time_zone: string; job_type: string }>(`SELECT cron, time_zone, job_type FROM env_default.ab_schedules WHERE id = (SELECT schedule_id FROM env_default.ab_report_subscriptions WHERE id = $1)`, [rep.data.id])
    expect(sched[0]).toEqual({ cron: '0 7 * * *', time_zone: 'Asia/Kolkata', job_type: 'report.run' })
    expect((await h.admin.post(`/reports/${rep.data.id}/run`)).status).toBe(200)
    await drain()
    const toRita = await waitMail('rita@example.com', 1, /Morning deals/)
    const toAda = await waitMail('ada@example.com', 1, /Morning deals/)
    const csv = (m: typeof toRita) => m.attachments.find((a) => a.fileName.endsWith('.csv'))!.content.toString('utf8')
    expect(csv(toRita)).toContain('Rita deal')
    expect(csv(toRita)).not.toContain('Big deal')
    expect(toRita.html).not.toContain('Big deal')
    expect(csv(toAda)).toContain('Big deal')
    expect(csv(toAda)).toContain(`'=cmd|calc`)
    expect(toAda.html).toContain('the first 2 are shown')
    // Ann (a viewer reads every row) also gets it; history lists every recipient
    await waitMail('ann@example.com', 1, /Morning deals/)
    const runs = await h.admin.get(`/reports/${rep.data.id}/runs`)
    expect(runs.data.items[0]).toMatchObject({ status: 'succeeded', trigger: 'manual' })
    expect(runs.data.items[0].recipients.map((x: { status: string }) => x.status)).toEqual(['sent', 'sent', 'sent'])
    // a recipient sees the report and only their own history line
    const rl = await rita.get(`/reports/${rep.data.id}/runs`)
    expect(rl.data.items[0].recipients).toEqual([expect.objectContaining({ userId: 'user_rita' })])
    // unsubscribe from the report email (no session)
    const link = /<(https:\/\/apps\.example\.com[^>]+)>/.exec(toRita.headers['list-unsubscribe'])![1].replace('https://apps.example.com', h.base)
    expect((await fetch(link, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })).status).toBe(200)
    const n = mailsTo('rita@example.com').length
    await h.admin.post(`/reports/${rep.data.id}/run`)
    await drain()
    await waitMail('ada@example.com', 2, /Morning deals/)
    expect(mailsTo('rita@example.com').length).toBe(n)
    // an empty result is skipped (the filter matches nothing for this report)
    const empty = await h.admin.post('/reports', { name: 'Nothing', source: { kind: 'table', tableId: t.data.id, plan: { version: 2, table: 'Deal', filter: { col: 'Amount', op: 'gt', value: 1e9 } } }, schedule: { frequency: 'manual' }, recipients: { userIds: ['user_mia'], teamIds: [] } })
    expect(empty.status, JSON.stringify(empty.data)).toBe(200)
    await h.admin.post(`/reports/${empty.data.id}/run`)
    await drain()
    const er = await h.admin.get(`/reports/${empty.data.id}/runs`)
    expect(er.data.items[0].recipients[0]).toMatchObject({ status: 'skipped', rows: 0 })
    // a grouped aggregate (totals)
    const agg = await h.admin.post('/reports/preview', { def: { source: { kind: 'table', tableId: t.data.id, plan: { version: 2, table: 'Deal', aggregate: { groupBy: [], measures: [{ name: 'Total', fn: 'sum', col: 'Amount' }, { name: 'Deals', fn: 'count' }] } } } } })
    expect(agg.data.rows).toEqual([{ Total: 9105, Deals: 3 }])
    // a formula source as the recipient
    const f = await rita.post('/reports/preview', { def: { source: { kind: 'formula', formula: 'Filter(Deal, Amount > 1)' } } })
    expect(f.status, JSON.stringify(f.data)).toBe(200)
    expect(f.data.rows.map((r: { Title: string }) => r.Title)).toEqual(['Rita deal'])
  })
})
