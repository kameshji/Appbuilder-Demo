/**
 * Security re-check of Phase 2 over HTTP and WebSocket on PostgreSQL: the live hub tries a failed subscription re-check
 * again (P2-3), generated-file tokens (P2-6: no 90-second hold for a made-up token, someone else's token at once), app
 * manifests as an existence oracle (P2-7), snapshot schedules and "run now" (P2-8), the WhatsApp opt-in source a flow may
 * claim (P2-10), view tokens as a general API, idempotency keys across people, the offline key and wipe routes.
 * Findings and residual risks: docs/internal/security-review-p2.md.
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/security-p2.integration
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { PG_URL, SKIP_PG } from './testdb.ts'
import { setQuiet } from './util.ts'
import { Client, startHarness, type KernelHarness } from './kernel-testkit.ts'
import { setGraphBaseForTests } from './whatsapp/graph.ts'
import { MOCK_APP_SECRET, MOCK_PHONE_NUMBER_ID, MOCK_TOKEN, MOCK_VERIFY_TOKEN, MOCK_WABA_ID, startMockGraph, type MockGraph } from './whatsapp/mock-graph.ts'
import { ROLE_MAKER } from './auth.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[security-p2 integration] ${SKIP_PG}\n`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** a test WebSocket that keeps every message */
class Sock {
  ws: WebSocket
  msgs: any[] = []
  constructor(url: string, headers: Record<string, string>) {
    this.ws = new WebSocket(url, { headers })
    this.ws.on('message', (d) => this.msgs.push(JSON.parse(d.toString())))
    this.ws.on('error', () => {})
  }
  async waitMsg(pred: (m: any) => boolean, ms = 4000): Promise<any> {
    const end = Date.now() + ms
    for (;;) {
      const m = this.msgs.find(pred)
      if (m) return m
      if (Date.now() > end) throw new Error(`timed out; last messages ${JSON.stringify(this.msgs.slice(-4))}`)
      await sleep(50)
    }
  }
  async sub(topic: string, env: string) {
    const id = Math.random().toString(36).slice(2)
    this.ws.send(JSON.stringify({ t: 'sub', id, topic, env }))
    return this.waitMsg((m) => m.id === id)
  }
  close() { this.ws.terminate() }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
describe.skipIf(!PG_URL)('security re-check of Phase 2 (PostgreSQL)', { timeout: 120_000 }, () => {
  let h: KernelHarness
  let mock: MockGraph
  let live: http.Server
  let liveBase = ''
  const C: Record<string, Client> = {}
  const ids: Record<string, string> = {}
  let tableId = ''
  let readers = ''
  let nothing = ''
  let dashId = ''
  const socks: Sock[] = []

  const login = async (email: string) => {
    const c = new Client(h.base)
    const r = await c.post('/auth/login', { email, password: 'some-password-1' })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return c
  }

  beforeAll(async () => {
    mock = await startMockGraph()
    setGraphBaseForTests(mock.url)
    h = await startHarness('secp2', { env: { APPBUILDER_MIGRATION_BACKUP: 'skip' } })
    // the harness serves HTTP only: a second server on the same app also takes the live hub's upgrades
    live = http.createServer((req, res) => { void h.app.handle(req, res).then((x) => { if (!x) res.writeHead(404).end() }) })
    live.on('upgrade', (req, socket, head) => { if (!h.app.handleUpgrade(req, socket, head)) socket.destroy() })
    await new Promise<void>((r) => live.listen(0, '127.0.0.1', r))
    liveBase = `http://127.0.0.1:${(live.address() as AddressInfo).port}`
    const t = await h.admin.post('/tables', { displayName: 'SecNotes', name: 'SecNotes', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Region', type: 'text' }] })
    expect(t.status, JSON.stringify(t.data)).toBe(200)
    tableId = t.data.id
    const r1 = await h.admin.post('/roles', { name: 'P2 readers', apps: 'all', privileges: [{ table: tableId, create: true, read: 'all', update: 'all', delete: 'none' }] })
    const r2 = await h.admin.post('/roles', { name: 'P2 nothing', apps: [], privileges: [] })
    expect([r1.status, r2.status]).toEqual([200, 200])
    readers = r1.data.id
    nothing = r2.data.id
    for (const [name, email, roles] of [['Rae Reader', 'rae@example.com', [readers]], ['Zed Nobody', 'zed@example.com', [nothing]], ['Mia Maker', 'mia@example.com', [ROLE_MAKER]]] as [string, string, string[]][]) {
      const u = await h.admin.post('/users', { name, email, roleIds: roles, password: 'some-password-1' })
      expect(u.status, JSON.stringify(u.data)).toBe(200)
      ids[email] = u.data.id
    }
    await h.q(`UPDATE ab.users SET must_change_password = false`)
    for (const e of ['rae@example.com', 'zed@example.com', 'mia@example.com']) C[e] = await login(e)
    ids.ada = (await h.admin.get('/auth/session')).data.user.id
    const d = await h.admin.post('/dashboards', {
      def: { version: 1, title: 'P2 board', range: 'all', tiles: [{ id: 'n', title: 'Notes', kind: 'kpi', layout: { x: 0, y: 0, w: 3, h: 3 }, query: { table: 'SecNotes', measures: [{ id: 'N', fn: 'count' }] } }] },
      roles: [readers],
    })
    expect(d.status, JSON.stringify(d.data)).toBe(200)
    dashId = d.data.id
  }, 240_000)

  afterAll(async () => {
    for (const s of socks) s.close()
    setGraphBaseForTests(null)
    await new Promise<void>((r) => (live ? live.close(() => r()) : r()))
    await h?.close()
    await mock?.close()
  }, 60_000)

  it('FINDING P2-3: a subscription whose re-check failed (not a refusal) is checked again and ends once access is gone', async () => {
    const s = new Sock(liveBase.replace('http', 'ws') + '/api/v1/live', { Origin: liveBase, Cookie: C['rae@example.com'].cookie })
    socks.push(s)
    await s.waitMsg((m) => m.t === 'hello')
    const topic = `presence:record:${tableId}:r1`
    expect((await s.sub(topic, 'default')).t).toBe('subscribed')
    // the environment registry fails for Rae while her access is removed (a database hiccup, an environment being restored)
    const envs = h.app.services.environments as any
    const orig = envs.resolveFor
    let armed = true
    envs.resolveFor = (u: { id: string }, req: string | null) => (armed && u.id === ids['rae@example.com'] ? Promise.reject(new Error('database unreachable (test)')) : orig.call(envs, u, req))
    try {
      expect((await h.admin.patch(`/users/${ids['rae@example.com']}`, { roleIds: [nothing] })).status).toBe(200)
      await sleep(1200)
      // the failed check keeps the subscription (a failure is not a refusal) ...
      expect(s.msgs.some((m) => m.t === 'unsubscribed' && m.topic === topic)).toBe(false)
      armed = false
      // ... and it is tried again without waiting for another role change: the subscription ends
      const gone = await s.waitMsg((m) => m.t === 'unsubscribed' && m.topic === topic, 10_000)
      expect(gone.env).toBe('default')
    } finally {
      envs.resolveFor = orig
      await h.admin.patch(`/users/${ids['rae@example.com']}`, { roleIds: [readers] })
    }
  }, 60_000)

  it('FINDING P2-6: a made-up file token answers within seconds (not after 90 s of polling); someone else\'s token at once', async () => {
    const tpl = await h.admin.post('/print/builtins', { key: 'table-list', table: 'SecNotes' })
    expect(tpl.status, JSON.stringify(tpl.data)).toBe(200)
    const t0 = Date.now()
    const none = await C['mia@example.com'].get(`/print/files/gen_${'Q'.repeat(24)}`)
    expect(none.status).toBe(422)
    expect(Date.now() - t0).toBeLessThan(20_000)
    const malformed = await C['mia@example.com'].get('/print/files/not-a-token')
    expect(malformed.status).toBe(422)
    const token = `gen_P2sec${'x'.repeat(19)}`
    const g = await h.admin.post('/print/generate', { template: tpl.data.template.id, token })
    expect(g.status, JSON.stringify(g.data)).toBe(200)
    const t1 = Date.now()
    expect((await C['mia@example.com'].get(`/print/files/${token}`)).status).toBe(404)
    expect(Date.now() - t1).toBeLessThan(5_000)
    expect((await h.admin.get(`/print/files/${token}`)).status).toBe(200)
  }, 60_000)

  it('FINDING P2-7: an app\'s install manifest answers 404 to people who may not run it, the same as for an app that does not exist', async () => {
    const app = await h.admin.post('/apps', { name: 'Payroll secrets', width: 360, height: 800 })
    expect(app.status, JSON.stringify(app.data)).toBe(200)
    const appId = app.data.id ?? app.data.meta?.id
    const zed = await C['zed@example.com'].get(`/pwa/apps/${appId}/manifest.webmanifest`)
    const unknown = await C['zed@example.com'].get('/pwa/apps/app_does_not_exist/manifest.webmanifest')
    expect([zed.status, unknown.status]).toEqual([404, 404])
    expect(JSON.stringify(zed.data)).not.toContain('Payroll')
    expect(zed.data.error.message).toBe(unknown.data.error.message)
    const rae = await C['rae@example.com'].get(`/pwa/apps/${appId}/manifest.webmanifest`)
    expect(rae.status).toBe(200)
    expect(JSON.stringify(rae.data)).toContain('Payroll secrets')
    // no session: no manifest
    expect((await new Client(h.base).get(`/pwa/apps/${appId}/manifest.webmanifest`)).status).toBe(401)
  })

  it('FINDING P2-8: snapshots run at most hourly; a recipient\'s "run now" at most once a minute', async () => {
    const rae = C['rae@example.com']
    for (const cron of ['* * * * *', '*/5 * * * *', '0,30 * * * *']) {
      const r = await rae.post(`/dashboards/${dashId}/snapshots`, { schedule: { frequency: 'cron', cron, timeZone: 'UTC' } })
      expect(r.status, cron).toBe(422)
      expect(r.data.error.message).toMatch(/at most once an hour/)
    }
    const ok = await rae.post(`/dashboards/${dashId}/snapshots`, { schedule: { frequency: 'hourly', minute: 7, timeZone: 'UTC' } })
    expect(ok.status, JSON.stringify(ok.data)).toBe(200)
    // someone else's snapshot she receives: her own copy, once a minute
    const theirs = await h.admin.post(`/dashboards/${dashId}/snapshots`, { schedule: { frequency: 'manual' }, recipients: { userIds: [ids['rae@example.com']], teamIds: [] } })
    expect(theirs.status, JSON.stringify(theirs.data)).toBe(200)
    expect((await rae.post(`/dashboards/snapshots/${theirs.data.id}/run`)).status).toBe(200)
    expect((await rae.post(`/dashboards/snapshots/${theirs.data.id}/run`)).status).toBe(429)
    // the owner (here an administrator) is not limited
    expect((await h.admin.post(`/dashboards/snapshots/${theirs.data.id}/run`)).status).toBe(200)
    expect((await h.admin.post(`/dashboards/snapshots/${theirs.data.id}/run`)).status).toBe(200)
  })

  it('a dashboard view token is not an API key and runs only its own dashboard\'s tiles', async () => {
    const t = await h.admin.post(`/dashboards/${dashId}/tokens`, { label: 'Hall TV' })
    expect(t.status, JSON.stringify(t.data)).toBe(200)
    const bearer = { Authorization: `Bearer ${t.data.token}` }
    for (const p of ['/workspace', '/auth/session', '/dashboards', `/dashboards/${dashId}`]) expect((await fetch(`${h.base}/api/v1${p}`, { headers: bearer })).status, p).toBe(401)
    const q = (body: unknown, extra: Record<string, string> = {}) => fetch(`${h.base}/api/v1/dashboards/kiosk/query`, { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) })
    expect((await q({})).status).toBe(200)
    expect((await q({ queries: [{ id: 'x', plan: { version: 2, table: 'SecNotes' } }] })).status).toBe(422)
    expect((await q({ plan: { version: 2, table: 'SecNotes' } })).status).toBe(422)
    expect((await q({ dashboardId: 'dsh_other' })).status).toBe(404)
    expect((await q({}, { 'X-Appbuilder-Environment': 'sales' })).status).toBe(403)
    // a cookie next to the token adds nothing (the token's account is used, the cookie is ignored)
    expect((await q({}, { Cookie: C['zed@example.com'].cookie })).status).toBe(200)
  })

  it('FINDING P2-10: a flow cannot record a WhatsApp opt-in as if the person had written START ("inbound keyword")', async () => {
    const secret = JSON.stringify({ accessToken: MOCK_TOKEN, appSecret: MOCK_APP_SECRET, verifyToken: MOCK_VERIFY_TOKEN })
    const c = await h.admin.post('/connections', { name: 'WhatsApp', connector: 'whatsapp', settings: { phoneNumberId: MOCK_PHONE_NUMBER_ID, businessAccountId: MOCK_WABA_ID, defaultCountryCode: '91' }, secret })
    expect(c.status, JSON.stringify(c.data)).toBe(200)
    const forged = await h.admin.post(`/connections/${c.data.id}/actions/recordOptIn/test`, { inputs: { to: '+910000000077', status: 'opted_in', source: 'inbound keyword', evidence: 'Wrote START (made up by a flow)' } })
    expect(forged.data.ok, JSON.stringify(forged.data)).toBe(false)
    expect((await h.admin.get(`/whatsapp/optins/${encodeURIComponent('+910000000077')}/history`)).data.items).toEqual([])
    const real = await h.admin.post(`/connections/${c.data.id}/actions/recordOptIn/test`, { inputs: { to: '+91 (0) 00000 00077', status: 'opted_in', source: 'form', evidence: 'Order form, WhatsApp box ticked' } })
    expect(real.data.ok, JSON.stringify(real.data)).toBe(true)
    // the "(0)" form is the same number (FINDING P2-9)
    expect((await h.admin.get(`/whatsapp/optins/${encodeURIComponent('+910000000077')}/history`)).data.items).toHaveLength(1)
  })

  it('idempotency keys are per person: the same key from two people writes two rows; a retry replays only the sender\'s own answer', async () => {
    const send = (c: Client, title: string) => fetch(`${h.base}/api/v1/data/SecNotes/rows`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Appbuilder': '1', Cookie: c.cookie, 'Idempotency-Key': 'p2-same-key-0001' }, body: JSON.stringify({ values: { Title: title } }) }).then(async (r) => ({ status: r.status, data: await r.json() as any }))
    const a = await send(h.admin, 'Ada note')
    const r = await send(C['rae@example.com'], 'Rae note')
    expect([a.status, r.status]).toEqual([200, 200])
    expect(r.data.replayed).toBeFalsy()
    expect(JSON.stringify(r.data)).not.toContain('Ada note')
    const again = await send(C['rae@example.com'], 'Rae note (retry)')
    expect(again.data.replayed).toBe(true)
    expect(JSON.stringify(again.data)).toContain('Rae note')
    expect(JSON.stringify(again.data)).not.toContain('Ada note')
    const rows = await h.q<{ Title: string }>(`SELECT "Title" FROM env_default.t_secnotes WHERE "Title" LIKE '% note%' ORDER BY "Title"`)
    expect(rows.map((x) => x.Title)).toEqual(['Ada note', 'Rae note'])
  })

  it('offline keys: only for oneself, per device, changed by a wipe; only administrators wipe someone else', async () => {
    const rae = C['rae@example.com']
    const k1 = (await rae.post('/offline/key', { deviceId: 'device-one-1' })).data
    const k2 = (await rae.post('/offline/key', { deviceId: 'device-two-2' })).data
    expect(k1.key).not.toBe(k2.key)
    expect((await rae.post('/offline/key', { deviceId: '../../etc' })).status).toBe(422)
    expect((await rae.post('/offline/key', { deviceId: 'device-one-1', userId: ids.ada })).data.key).toBe(k1.key)
    expect((await rae.post('/offline/wipe', { userId: ids.ada })).status).toBe(403)
    expect((await rae.post('/offline/wipe', {})).status).toBe(200)
    const k3 = (await rae.post('/offline/key', { deviceId: 'device-one-1' })).data
    expect(k3.epoch).toBe(k1.epoch + 1)
    expect(k3.key).not.toBe(k1.key)
    expect((await h.admin.post('/offline/wipe', { userId: ids['rae@example.com'] })).status).toBe(200)
    expect((await new Client(h.base).post('/offline/key', { deviceId: 'device-one-1' })).status).toBe(401)
  })
})
