/**
 * Security re-check of Phase 3 and the hosting phase over HTTP and WebSocket on PostgreSQL: a refused stock movement
 * does not state quantities or names the writer may not read (P3-1); the seat pass on the live socket, in the sign-in
 * answer and on live sessions when it changes (P3-2); EVERY maker and design route refused to an administrator holding
 * an Operator pass, flow webhooks and connection custom actions included (P3-3); guards: the removed Query v1 route.
 * Findings and residual risks: docs/internal/security-review-p3.md.
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/security-p3.integration
 */
import dns from 'node:dns'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { PG_URL, SKIP_PG } from './testdb.ts'
import { setQuiet } from './util.ts'
import { Client, startHarness, type KernelHarness } from './kernel-testkit.ts'
import { ROLE_ADMIN, ROLE_MAKER } from './auth.ts'
import { PASS_REQUIRED_MESSAGE } from './licence/seats.ts'
import { runInEnvironment } from './env-context.ts'
import { REGARDING } from '../../src/platform/system-tables.ts'
import { CHAT_EMOJI } from '../../src/platform/chat-protocol.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[security-p3 integration] ${SKIP_PG}\n`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const PW = 'some-password-1'

/** a test WebSocket that keeps every message */
class Sock {
  ws: WebSocket
  msgs: any[] = []
  constructor(url: string, headers: Record<string, string>) {
    this.ws = new WebSocket(url, { headers })
    this.ws.on('message', (d) => this.msgs.push(JSON.parse(d.toString())))
    this.ws.on('error', () => {})
  }
  async waitMsg(pred: (m: any) => boolean, ms = 5000): Promise<any> {
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
describe.skipIf(!PG_URL)('security re-check of Phase 3 and hosting (PostgreSQL)', { timeout: 180_000 }, () => {
  let h: KernelHarness
  let live: http.Server
  let liveBase = ''
  const ids: Record<string, string> = {}
  const T: Record<string, string> = {}
  const socks: Sock[] = []

  const ok = <D>(r: { status: number; data: D }, status = 200): D => {
    expect(r.status, JSON.stringify(r.data).slice(0, 1500)).toBe(status)
    return r.data
  }
  const person = async (name: string, email: string, roleIds: string[]): Promise<string> => {
    const u = ok(await h.admin.post('/users', { name, email, roleIds, password: PW })) as { id: string }
    await h.q(`UPDATE ab.users SET must_change_password = false WHERE id = $1`, [u.id])
    ids[email] = u.id
    return u.id
  }
  const login = async (email: string) => {
    const c = new Client(h.base)
    const r = await c.post('/auth/login', { email, password: PW })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return { c, session: r.data as any }
  }
  const setPass = async (userId: string, pass: 'full' | 'operator') => ok(await h.admin.req('PUT', '/install/licence/passes', { userIds: [userId], pass }))
  const socket = (c: Client) => {
    const s = new Sock(liveBase.replace('http', 'ws') + '/api/v1/live', { Origin: liveBase, Cookie: c.cookie })
    socks.push(s)
    return s
  }

  beforeAll(async () => {
    h = await startHarness('secp3', { env: { APPBUILDER_MIGRATION_BACKUP: 'skip' } })
    live = http.createServer((req, res) => { void h.app.handle(req, res).then((x) => { if (!x) res.writeHead(404).end() }) })
    live.on('upgrade', (req, socket, head) => { if (!h.app.handleUpgrade(req, socket, head)) socket.destroy() })
    await new Promise<void>((r) => live.listen(0, '127.0.0.1', r))
    liveBase = `http://127.0.0.1:${(live.address() as AddressInfo).port}`
    const table = async (displayName: string, columns: unknown[]) => (ok(await h.admin.post('/tables', { displayName, columns })) as { id: string }).id
    T.item = await table('P3Items', [{ displayName: 'Name', type: 'text', required: true }])
    T.loc = await table('P3Locations', [{ displayName: 'Name', type: 'text', required: true }])
    T.mv = await table('P3Moves', [
      { displayName: 'Item', type: 'lookup', lookupTable: 'P3Items', required: true },
      { displayName: 'Location', type: 'lookup', lookupTable: 'P3Locations', required: true },
      { displayName: 'Quantity', type: 'decimal', required: true },
    ])
    T.bal = await table('P3Stock', [
      { displayName: 'Item', type: 'lookup', lookupTable: 'P3Items' },
      { displayName: 'Location', type: 'lookup', lookupTable: 'P3Locations' },
      { displayName: 'OnHand', type: 'decimal' },
    ])
    // balances are declared by packs; here straight into the table definition (as balances.integration.test.ts does)
    await h.q(`UPDATE env_default.ab_tables SET def = jsonb_set(def, '{balance}', $2::jsonb) WHERE id = $1`, [T.bal, JSON.stringify({ movements: 'P3Moves', quantity: 'Quantity', column: 'OnHand', keys: [{ column: 'Item', from: 'Item' }, { column: 'Location', from: 'Location' }], label: 'Stock' })])
    h.app.services.security.invalidate('all')
    const row = async (t: string, values: Record<string, unknown>) => (ok(await h.admin.post(`/data/${t}/rows`, { values })) as { row: { id: string } }).row.id
    ids.bolt = await row(T.item, { Name: 'Hex bolt' })
    ids.falcon = await row(T.item, { Name: 'Project Falcon prototype' })
    ids.main = await row(T.loc, { Name: 'Main store' })
    ok(await h.admin.post(`/data/${T.mv}/rows`, { values: { Item: ids.bolt, Location: ids.main, Quantity: 37 } }))
    ok(await h.admin.post(`/data/${T.mv}/rows`, { values: { Item: ids.falcon, Location: ids.main, Quantity: 4 } }))
    // a clerk records movements and reads items and locations, but not the stock table
    const clerk = ok(await h.admin.post('/roles', { name: 'P3 clerks', apps: 'all', privileges: [
      { table: T.mv, create: true, read: 'own', update: 'own', delete: 'none' },
      { table: T.item, create: false, read: 'all', update: 'none', delete: 'none' },
      { table: T.loc, create: false, read: 'all', update: 'none', delete: 'none' },
    ] })) as { id: string }
    // a picker records movements without reading the items (they scan a code)
    const picker = ok(await h.admin.post('/roles', { name: 'P3 pickers', apps: 'all', privileges: [
      { table: T.mv, create: true, read: 'own', update: 'none', delete: 'none' },
      { table: T.loc, create: false, read: 'all', update: 'none', delete: 'none' },
    ] })) as { id: string }
    // a storekeeper reads the stock table
    const keeper = ok(await h.admin.post('/roles', { name: 'P3 keepers', apps: 'all', privileges: [
      { table: T.mv, create: true, read: 'all', update: 'none', delete: 'none' },
      { table: T.item, create: false, read: 'all', update: 'none', delete: 'none' },
      { table: T.loc, create: false, read: 'all', update: 'none', delete: 'none' },
      { table: T.bal, create: false, read: 'all', update: 'none', delete: 'none' },
    ] })) as { id: string }
    await person('Cleo Clerk', 'cleo@example.com', [clerk.id])
    await person('Pip Picker', 'pip@example.com', [picker.id])
    await person('Kit Keeper', 'kit@example.com', [keeper.id])
    await person('Mo Maker', 'mo@example.com', [ROLE_MAKER])
    await person('Max Maker', 'max@example.com', [ROLE_MAKER])
    await person('Ola Admin', 'ola@example.com', [ROLE_ADMIN])
  }, 240_000)

  afterAll(async () => {
    for (const s of socks) s.close()
    await new Promise<void>((r) => (live ? live.close(() => r()) : r()))
    await h?.close()
  }, 60_000)

  it('FINDING P3-1: a refused movement does not state the quantity, nor a key name, the writer may not read', async () => {
    // the storekeeper may read the stock: the full message, as before
    const { c: kit } = await login('kit@example.com')
    const k = ok(await kit.post(`/data/${T.mv}/rows`, { values: { Item: ids.bolt, Location: ids.main, Quantity: -100 } }), 422) as any
    expect(k.error.message).toBe('Stock of Hex bolt at Main store would go below zero: available 37, requested 100.')
    expect(k.balance).toMatchObject({ available: 37, requested: 100 })
    // the clerk may not read the stock table: no quantity in the words nor in the body
    const { c: cleo } = await login('cleo@example.com')
    const r = await cleo.post(`/data/${T.mv}/rows`, { values: { Item: ids.bolt, Location: ids.main, Quantity: -100 } })
    expect(r.status, JSON.stringify(r.data)).toBe(422)
    // (ids are random and may contain the digits: look at the words and at the balance member's keys)
    expect((r.data as any).error.message).not.toContain('37')
    expect(Object.keys((r.data as any).balance ?? {}).sort()).toEqual(['key', 'requested', 'table'])
    expect((r.data as any).error.message).toMatch(/^Stock of Hex bolt at Main store would go below its minimum: there is not enough/)
    // the picker reads neither the stock nor the items: the item's name is not shown either
    const { c: pip } = await login('pip@example.com')
    const p = await pip.post(`/data/${T.mv}/rows`, { values: { Item: ids.falcon, Location: ids.main, Quantity: -10 } })
    expect(p.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(p.data)).not.toContain('Falcon')
    expect(JSON.stringify(p.data)).not.toMatch(/available 4\b/)
    // the balance did not move
    const bal = await h.q<{ q: string }>(`SELECT "OnHand"::text AS q FROM env_default.t_p3stock WHERE "Item" = $1`, [ids.bolt])
    expect(Number(bal[0].q)).toBe(37)
  })

  it('FINDING P3-2: an Operator pass applies on the live socket and in the sign-in answer, and a pass change ends Studio presence at once', async () => {
    // Max (Full user pass) is in the Studio of an app; Mo holds an Operator pass
    const { c: max } = await login('max@example.com')
    const ms = socket(max)
    await ms.waitMsg((m) => m.t === 'hello')
    expect((await ms.sub('presence:studio:p3app', 'default')).t).toBe('subscribed')
    await setPass(ids['mo@example.com'], 'operator')
    const { c: mo, session } = await login('mo@example.com')
    // the sign-in answer already says "no Dev mode" (it used to say isMaker: true until the next GET /auth/session)
    expect(session.privileges.isMaker).toBe(false)
    expect((await mo.get('/auth/session')).data.privileges.isMaker).toBe(false)
    // the socket: no Studio presence for an Operator (it used to be allowed: the socket built its context without the pass)
    const s = socket(mo)
    await s.waitMsg((m) => m.t === 'hello')
    const sub = await s.sub('presence:studio:p3app', 'default')
    expect(sub.t).toBe('error')
    // Max is given an Operator pass while in the Studio: the subscription ends within seconds
    await setPass(ids['max@example.com'], 'operator')
    const gone = await ms.waitMsg((m) => m.t === 'unsubscribed' && m.topic === 'presence:studio:p3app', 10_000)
    expect(gone.env).toBe('default')
    await setPass(ids['max@example.com'], 'full')
    await setPass(ids['mo@example.com'], 'full')
  }, 60_000)

  it('FINDING P3-3: EVERY maker, design and Full-pass route is refused to an administrator holding an Operator pass (flow webhooks and custom actions included)', async () => {
    const routes = h.app.router.routes() as { method: string; key: string; pattern: string; opts: { auth: string; design?: boolean; pass?: string } }[]
    // the routes this review flagged (they checked "administrator or flow owner" / "manage" in the handler only)
    const full = routes.filter((r) => r.opts.pass === 'full').map((r) => r.key)
    for (const k of ['POST /flows/:flowId/webhooks', 'PATCH /webhooks/:id', 'POST /webhooks/:id/rotate', 'DELETE /webhooks/:id', 'GET /flows/:flowId/webhooks',
      'PUT /connections/:id/custom-actions/:action', 'DELETE /connections/:id/custom-actions/:action', 'POST /connections/:id/custom-actions/openapi']) expect(full, k).toContain(k)
    await setPass(ids['ola@example.com'], 'operator')
    const { c: ola, session } = await login('ola@example.com')
    expect(session.privileges.isAdmin).toBe(true)
    expect(session.privileges.isMaker).toBe(false)
    const wrong: string[] = []
    let checked = 0
    for (const r of routes) {
      const makerWork = r.opts.auth === 'maker' || r.opts.pass === 'full' || (r.opts.design && r.method !== 'GET')
      if (!makerWork || r.opts.auth === 'none') continue
      const path = r.pattern.split('/').map((s) => (s.startsWith(':') ? 'x' : s)).join('/')
      const res = await ola.req(r.method, path, r.method === 'GET' ? undefined : {})
      checked++
      if (res.status !== 403) wrong.push(`${r.key}: ${res.status} ${JSON.stringify(res.data?.error ?? '').slice(0, 120)}`)
    }
    expect(wrong).toEqual([])
    expect(checked).toBeGreaterThan(100)
    // the flagged ones answer with the pass message (before: 404 "There is no flow ..." / "not found", i.e. reachable)
    const w = await ola.post('/flows/flow_none/webhooks', {})
    expect(w.status).toBe(403)
    expect(w.data.error.message).toBe(PASS_REQUIRED_MESSAGE)
    const ca = await ola.req('PUT', '/connections/conn_none/custom-actions/a1', {})
    expect(ca.status).toBe(403)
    expect(ca.data.error.message).toBe(PASS_REQUIRED_MESSAGE)
    // she is still an administrator (administration is not maker work)
    expect((await ola.get('/auth/session')).data.privileges.isAdmin).toBe(true)
    await setPass(ids['ola@example.com'], 'full')
    // with a Full user pass again she reaches the handler (which looks for the flow)
    const back = await ola.post('/flows/flow_none/webhooks', {})
    expect(back.data?.error?.message).not.toBe(PASS_REQUIRED_MESSAGE)
  }, 120_000)

  it('FINDING P3-6: DNS rebinding of an external database host never reaches 127.0.0.1 (postgres and mysql connections, "test" and the pool)', async () => {
    // a rebinding DNS server: the policy's lookups (dns.promises.lookup) get a public address, the driver's own lookup
    // (dns.lookup inside net.connect) gets 127.0.0.1, where a canary listener counts connections
    const HOST = 'db.rebind.test'
    let hits = 0
    const canary = net.createServer((sock) => { hits++; sock.destroy() })
    await new Promise<void>((r) => canary.listen(0, '127.0.0.1', r))
    const port = (canary.address() as AddressInfo).port
    const realLookup = dns.lookup
    const realPromise = dns.promises.lookup
    const prevPrivate = process.env.APPBUILDER_OUTBOUND_PRIVATE
    ;(dns as any).lookup = (hn: string, o: any, cb?: any) => {
      if (String(hn).toLowerCase() !== HOST) return (realLookup as any)(hn, o, cb)
      const done = typeof o === 'function' ? o : cb
      if (o && typeof o === 'object' && o.all) done(null, [{ address: '127.0.0.1', family: 4 }])
      else done(null, '127.0.0.1', 4)
    }
    ;(dns.promises as any).lookup = async (hn: string, o?: any) => (String(hn).toLowerCase() === HOST ? [{ address: '192.0.2.10', family: 4 }] : realPromise(hn, o))
    process.env.APPBUILDER_OUTBOUND_PRIVATE = 'deny'
    try {
      for (const connector of ['postgres', 'mysql'] as const) {
        const made = ok(await h.admin.post('/connections', { name: `P3-6 ${connector}`, connector, settings: { host: HOST, port, database: 'appdb', user: 'app' }, secret: 'pw-123' })) as any
        // "test" (one short-lived client) and source tables (the pool) were attempted, against the checked address only
        expect(made.status).toBe('error')
        const tables = await h.admin.get(`/connections/${made.id}/source-tables`)
        expect(tables.status).toBeGreaterThanOrEqual(400)
        expect(hits, connector).toBe(0)
        // the name later resolves to loopback for the policy too: refused at the next use, before any driver runs
        ;(dns.promises as any).lookup = async (hn: string, o?: any) => (String(hn).toLowerCase() === HOST ? [{ address: '127.0.0.1', family: 4 }] : realPromise(hn, o))
        const again = await h.admin.post(`/connections/${made.id}/test`, {})
        expect(again.data.ok).toBe(false)
        expect(again.data.message).toMatch(/loopback/)
        expect(hits, connector).toBe(0)
        ;(dns.promises as any).lookup = async (hn: string, o?: any) => (String(hn).toLowerCase() === HOST ? [{ address: '192.0.2.10', family: 4 }] : realPromise(hn, o))
        ok(await h.admin.req('DELETE', `/connections/${made.id}`))
      }
    } finally {
      ;(dns as any).lookup = realLookup
      ;(dns.promises as any).lookup = realPromise
      if (prevPrivate === undefined) delete process.env.APPBUILDER_OUTBOUND_PRIVATE
      else process.env.APPBUILDER_OUTBOUND_PRIVATE = prevPrivate
      await new Promise<void>((r) => canary.close(() => r()))
    }
  }, 120_000)

  /* ================================================================ second pass (Part B) */

  /** a raw upload (chat files): the body is the file */
  const upload = async (c: Client, path: string, text: string) => {
    const res = await fetch(`${h.base}/api/v1${path}`, { method: 'POST', headers: { 'X-Appbuilder': '1', Cookie: c.cookie, 'Content-Type': 'text/plain' }, body: text })
    return { status: res.status, data: (await res.json().catch(() => ({}))) as any }
  }

  it('chat: others\' messages, administrator routes, files and reactions across conversations', async () => {
    const { c: max } = await login('max@example.com')
    const { c: cleo } = await login('cleo@example.com')
    const { c: kit } = await login('kit@example.com')
    const { c: pip } = await login('pip@example.com')
    const ch = ok(await max.post('/chat/conversations', { kind: 'channel', name: 'P3 private', isPrivate: true, members: [ids['cleo@example.com'], ids['kit@example.com']] })) as any
    ids.chPrivate = ch.id
    const m1 = (ok(await cleo.post(`/chat/conversations/${ch.id}/messages`, { body: '<p>zulu quartz plan</p>' })) as any).message
    ids.m1 = m1.id
    // a member cannot change or delete someone else's message
    expect((await kit.patch(`/chat/messages/${m1.id}`, { body: 'changed' })).status).toBe(403)
    expect((await kit.del(`/chat/messages/${m1.id}`)).status).toBe(403)
    // a non-member: the message does not exist for them on any route
    for (const r of [
      await pip.patch(`/chat/messages/${m1.id}`, { body: 'x' }), await pip.del(`/chat/messages/${m1.id}`),
      await pip.post(`/chat/messages/${m1.id}/reactions`, { emoji: CHAT_EMOJI[0] }), await pip.post(`/chat/messages/${m1.id}/report`, { reason: 'spam spam' }),
      await pip.get(`/chat/messages/${m1.id}/replies`), await pip.post('/chat/cards/resolve', { messageId: m1.id, index: 0 }),
    ]) expect(r.status, JSON.stringify(r.data)).toBe(404)
    // every administrator route refuses a member and a non-member (routes added later are covered too)
    const adminRoutes = (h.app.router.routes() as { method: string; pattern: string }[]).filter((r) => r.pattern.includes('/chat/admin/'))
    expect(adminRoutes.length).toBeGreaterThan(10)
    for (const who of [kit, pip]) {
      for (const r of adminRoutes) {
        const path = r.pattern.replace(/:id\b/, ch.id).replace(/:userId\b/, ids['cleo@example.com']).replace(/:[A-Za-z]+/g, 'x')
        const res = await who.req(r.method, path, r.method === 'GET' ? undefined : { reason: 'a long enough reason', confirm: 'P3 private', action: 'delete', archived: true })
        expect(res.status, `${r.method} ${r.pattern}`).toBe(403)
      }
    }
    // files: claimed only by the uploader, in the conversation they were uploaded to
    const dm = ok(await kit.post('/chat/conversations', { kind: 'direct', members: [ids['cleo@example.com']] })) as any
    ids.dm = dm.id
    const f = await upload(kit, `/chat/conversations/${ch.id}/files?name=plan.txt`, 'the plan')
    expect(f.status, JSON.stringify(f.data)).toBe(200)
    expect((await kit.post(`/chat/conversations/${dm.id}/messages`, { body: 'see file', files: [f.data.id] })).status).toBe(422)
    expect((await cleo.post(`/chat/conversations/${ch.id}/messages`, { body: 'see file', files: [f.data.id] })).status).toBe(422)
    expect((await upload(pip, `/chat/conversations/${ch.id}/files?name=x.txt`, 'x')).status).toBe(404)
    expect((await pip.del(`/chat/files/${f.data.id}`)).status).toBe(404)
    // the draft is still the uploader's: sent where it was uploaded, it works once
    expect((await kit.post(`/chat/conversations/${ch.id}/messages`, { body: 'see file', files: [f.data.id] })).status).toBe(200)
    expect((await kit.post(`/chat/conversations/${ch.id}/messages`, { body: 'again', files: [f.data.id] })).status).toBe(422)
    // search and the mention picker: a private conversation answers like one that does not exist
    const nobody = '00000000-0000-4000-8000-000000000000'
    const s1 = await pip.get(`/chat/search?q=zulu&channel=${ch.id}`)
    const s2 = await pip.get(`/chat/search?q=zulu&channel=${nobody}`)
    expect(s1.data).toEqual(s2.data)
    expect(s1.data.items).toEqual([])
    const mn1 = await pip.get(`/chat/conversations/${ch.id}/mentionable?q=`)
    const mn2 = await pip.get(`/chat/conversations/${nobody}/mentionable?q=`)
    expect([mn1.status, mn1.data.error?.code, mn1.data.error?.message]).toEqual([mn2.status, mn2.data.error?.code, mn2.data.error?.message])
    expect((await pip.post(`/chat/conversations/${ch.id}/typing`, {})).status).toBe(404)
  }, 90_000)

  it('chat: a removed member gets nothing more (socket, history, around, changes, typing, notifications)', async () => {
    const { c: max } = await login('max@example.com')
    const { c: cleo } = await login('cleo@example.com')
    const { c: kit } = await login('kit@example.com')
    const { c: pip } = await login('pip@example.com')
    // a group conversation notifies every member by default
    const g = ok(await max.post('/chat/conversations', { kind: 'group', name: 'P3 group', members: [ids['cleo@example.com'], ids['kit@example.com']] })) as any
    const ks = socket(kit)
    await ks.waitMsg((m) => m.t === 'hello')
    expect((await ks.sub(`chat:${g.id}`, undefined as unknown as string)).t).toBe('subscribed')
    expect((await ks.sub(`chat:typing:${g.id}`, undefined as unknown as string)).t).toBe('subscribed')
    // a non-member cannot listen to the conversation or to its typing
    const ps = socket(pip)
    await ps.waitMsg((m) => m.t === 'hello')
    expect((await ps.sub(`chat:${g.id}`, undefined as unknown as string)).t).toBe('error')
    expect((await ps.sub(`chat:typing:${g.id}`, undefined as unknown as string)).t).toBe('error')
    const before = (ok(await cleo.post(`/chat/conversations/${g.id}/messages`, { body: 'before the removal' })) as any).message
    await ks.waitMsg((m) => m.t === 'chat' && m.seq === before.seq)
    // reads in flight while the removal happens: each answer is either the full page (before) or a 404 (after)
    const racing = Array.from({ length: 6 }, (_, i) => (i % 2 ? kit.get(`/chat/conversations/${g.id}/changes?after=0`) : kit.get(`/chat/conversations/${g.id}/messages?around=${before.seq}`)))
    ok(await max.req('DELETE', `/chat/conversations/${g.id}/members/${ids['kit@example.com']}`))
    for (const r of await Promise.all(racing)) expect([200, 404]).toContain(r.status)
    await ks.waitMsg((m) => m.t === 'unsubscribed' && m.topic === `chat:${g.id}`, 10_000)
    const t0 = new Date()
    const after = (ok(await cleo.post(`/chat/conversations/${g.id}/messages`, { body: 'after the removal: secret' })) as any).message
    ok(await cleo.post(`/chat/conversations/${g.id}/typing`, {}))
    await sleep(800)
    expect(ks.msgs.some((m) => (m.t === 'chat' && m.seq >= after.seq) || (m.t === 'typing' && m.channelId === g.id && m.at >= t0.toISOString()))).toBe(false)
    for (const p of [`/chat/conversations/${g.id}/messages`, `/chat/conversations/${g.id}/messages?around=${before.seq}`, `/chat/conversations/${g.id}/changes?after=0`, `/chat/conversations/${g.id}/members`, `/chat/messages/${after.id}/replies`]) {
      expect((await kit.get(p)).status, p).toBe(404)
    }
    expect((await kit.get('/chat/search?q=secret')).data.items).toEqual([])
    const notes = await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM ab.notifications WHERE user_id = $1 AND link LIKE $2 AND created_on >= $3`, [ids['kit@example.com'], `#chat?c=${g.id}%`, t0])
    expect(notes[0].n).toBe(0)
  }, 90_000)

  it('chat: the administrator export (token, owner, expiry, a direct conversation) and its announcement cannot be moderated away (FINDING P3-11)', async () => {
    const { c: kit } = await login('kit@example.com')
    const { c: ola } = await login('ola@example.com')
    const ex = ok(await h.admin.post(`/chat/admin/channels/${ids.dm}/export`, { reason: 'Legal hold request number 42' })) as any
    const token = new URL(ex.url, 'http://x').searchParams.get('token')!
    expect(token.length).toBeGreaterThanOrEqual(32)
    expect((await h.admin.get(`/chat/admin/exports/${ex.id}/download?token=${'A'.repeat(token.length)}`)).status).toBe(404)
    expect((await h.admin.get(`/chat/admin/exports/${ex.id}/download`)).status).toBe(404)
    // another administrator with the right token: as if it did not exist
    expect((await ola.get(`/chat/admin/exports/${ex.id}/download?token=${token}`)).status).toBe(404)
    expect((await h.admin.get(`/chat/admin/exports/${ex.id}/download?token=${token}`)).status).toBe(200)
    // within the hour the exporting administrator may download again (each download audited): by design
    expect((await h.admin.get(`/chat/admin/exports/${ex.id}/download?token=${token}`)).status).toBe(200)
    const audits = await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.ab_audit WHERE action = 'chat.export.download' AND details->>'export' = $1`, [ex.id])
    expect(audits[0].n).toBe(2)
    await h.q(`UPDATE env_default.ab_chat_exports SET expires_on = now() - interval '1 minute' WHERE id = $1`, [ex.id])
    expect((await h.admin.get(`/chat/admin/exports/${ex.id}/download?token=${token}`)).status).toBe(410)
    // the members see the announcement; an administrator cannot remove it (it could be "moderated" away before)
    const hist = (await kit.get(`/chat/conversations/${ids.dm}/messages`)).data
    const line = hist.messages.find((m: any) => m.kind === 'system' && /exported this conversation/.test(m.text ?? m.body ?? ''))
    expect(line, JSON.stringify(hist.messages.slice(-3))).toBeTruthy()
    const mod = await h.admin.post(`/chat/admin/messages/${line.id}/moderate`, {})
    expect(mod.status, JSON.stringify(mod.data)).toBe(422)
    const again = (await kit.get(`/chat/conversations/${ids.dm}/messages`)).data
    expect(again.messages.find((m: any) => m.id === line.id && !m.deleted && /exported/.test(m.text ?? m.body ?? ''))).toBeTruthy()
    // people's messages can still be moderated
    expect((await h.admin.post(`/chat/admin/messages/${ids.m1}/moderate`, {})).status).toBe(200)
  }, 60_000)

  it('chat: retention removes old messages of the chosen kind only (not channels, not other collaboration rows)', async () => {
    const otherMentions = async () => (await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.sys_mentions WHERE "regardingTable" <> 'sys_messages'`))[0].n
    const count = async (ch: string) => (await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.sys_messages WHERE "Channel" = $1`, [ch]))[0].n
    const keepOther = await otherMentions()
    const chBefore = await count(ids.chPrivate)
    expect(chBefore).toBeGreaterThan(0)
    expect(await count(ids.dm)).toBeGreaterThan(0)
    ok(await h.admin.req('PUT', '/chat/admin/settings', { retention: { direct: 30 } }))
    await h.q(`UPDATE env_default.sys_messages SET "createdOn" = now() - interval '60 days' WHERE "Channel" = ANY($1::text[])`, [[ids.chPrivate, ids.dm]])
    ok(await h.admin.post('/chat/admin/retention/run', {}))
    expect(await count(ids.dm)).toBe(0)
    expect(await count(ids.chPrivate)).toBe(chBefore)
    expect(await otherMentions()).toBe(keepOther)
    ok(await h.admin.req('PUT', '/chat/admin/settings', { retention: { direct: null } }))
  }, 60_000)

  it('tasks and notes: a read share cannot edit; an edit share cannot re-share, delete, take over or assign it on (FINDING P3-12)', async () => {
    const { c: cleo } = await login('cleo@example.com')
    const { c: kit } = await login('kit@example.com')
    const { c: pip } = await login('pip@example.com')
    const note = (ok(await cleo.post('/data/sys_activities/rows', { values: { Type: 'Note', Subject: 'P3 secret plan', Body: '<p>the plan</p>' } })) as any).row
    const share = (ok(await cleo.post('/data/sys_activity_shares/rows', { values: { Activity: note.id, PrincipalType: 'user', Principal: ids['kit@example.com'], Access: 'read' } })) as any).row
    expect((await kit.get(`/notes/${note.id}`)).status).toBe(200)
    expect((await pip.get(`/notes/${note.id}`)).status).toBe(404)
    // read share: no edit, no re-share, no delete
    expect((await kit.patch(`/data/sys_activities/rows/${note.id}`, { changes: { Body: '<p>mine now</p>' } })).status).toBe(403)
    expect((await kit.post('/data/sys_activity_shares/rows', { values: { Activity: note.id, PrincipalType: 'user', Principal: ids['pip@example.com'], Access: 'read' } })).status).toBeGreaterThanOrEqual(403)
    expect((await kit.patch(`/data/sys_activity_shares/rows/${share.id}`, { changes: { Access: 'edit' } })).status).toBeGreaterThanOrEqual(403)
    // someone with no access creates a share for themself on it: refused
    expect((await pip.post('/data/sys_activity_shares/rows', { values: { Activity: note.id, PrincipalType: 'user', Principal: ids['pip@example.com'], Access: 'edit' } })).status).toBeGreaterThanOrEqual(403)
    // edit share: content yes; re-share, delete, owner and assignment no
    ok(await cleo.patch(`/data/sys_activity_shares/rows/${share.id}`, { changes: { Access: 'edit' } }))
    ok(await kit.patch(`/data/sys_activities/rows/${note.id}`, { changes: { Body: '<p>edited by Kit</p>' } }))
    expect((await kit.post('/data/sys_activity_shares/rows', { values: { Activity: note.id, PrincipalType: 'user', Principal: ids['pip@example.com'], Access: 'read' } })).status).toBeGreaterThanOrEqual(403)
    await kit.patch(`/data/sys_activities/rows/${note.id}`, { changes: { owner: ids['kit@example.com'] } })
    const assign = await kit.patch(`/data/sys_activities/rows/${note.id}`, { changes: { AssignedTo: ids['pip@example.com'] } })
    expect(assign.status, JSON.stringify(assign.data)).toBe(403)
    const del = await kit.post('/data/sys_activities/delete', { ids: [note.id] })
    expect(del.status === 403 || del.data?.deleted === 0, JSON.stringify(del.data)).toBe(true)
    const row = (await h.q<any>(`SELECT owner, "AssignedTo", "Body" FROM env_default.sys_activities WHERE id = $1`, [note.id]))[0]
    expect(row.owner).toBe(ids['cleo@example.com'])
    expect(row.AssignedTo).toBeNull()
    expect((await pip.get(`/notes/${note.id}`)).status).toBe(404)
    // the owner may still assign it (an ordinary task hand-over)
    ok(await cleo.patch(`/data/sys_activities/rows/${note.id}`, { changes: { AssignedTo: ids['pip@example.com'] } }))
    expect((await pip.get(`/notes/${note.id}`)).status).toBe(200)
  }, 60_000)

  it('tasks and notes: a team share ends when the person leaves the team; a note about an unreadable record cannot be made', async () => {
    const { c: cleo } = await login('cleo@example.com')
    const { c: kit } = await login('kit@example.com')
    const { c: pip } = await login('pip@example.com')
    const team = ok(await h.admin.post('/teams', { name: 'P3 team', code: 'P3TEAM', memberIds: [ids['kit@example.com']] })) as any
    const note = (ok(await cleo.post('/data/sys_activities/rows', { values: { Type: 'Note', Subject: 'P3 team note', Body: '<p>for the team</p>' } })) as any).row
    ok(await cleo.post('/data/sys_activity_shares/rows', { values: { Activity: note.id, PrincipalType: 'team', Principal: team.id, Access: 'read' } }))
    expect((await kit.get(`/notes/${note.id}`)).status).toBe(200)
    ok(await h.admin.patch(`/teams/${team.id}`, { memberIds: [] }))
    expect((await kit.get(`/notes/${note.id}`)).status).toBe(404)
    expect((await kit.get('/notes?view=shared')).data.items.some((n: any) => n.id === note.id)).toBe(false)
    // a note about a record the writer cannot read (the deep link #u-notes?new=1&table=&row= only asks this route)
    const r = await pip.post('/data/sys_activities/rows', { values: { Type: 'Note', Subject: 'x', regardingTable: T.item, regardingId: ids.falcon } })
    expect(r.status, JSON.stringify(r.data)).toBeGreaterThanOrEqual(403)
    expect(JSON.stringify(r.data)).not.toContain('Falcon')
  }, 60_000)

  it('tasks: reminders and the overdue digest do not name a task the owner can no longer read (FINDING P3-13)', async () => {
    const projects = (ok(await h.admin.post('/tables', { displayName: 'P3Projects', columns: [{ displayName: 'Name', type: 'text', required: true }] })) as any).id
    const proj = (ok(await h.admin.post(`/data/${projects}/rows`, { values: { Name: 'Falcon' } })) as any).row.id
    const role = ok(await h.admin.post('/roles', { name: 'P3 project readers', apps: 'all', privileges: [{ table: projects, create: false, read: 'all', update: 'none', delete: 'none' }] })) as any
    const tia = await person('Tia Task', 'tia@example.com', [role.id])
    const { c } = await login('tia@example.com')
    // today 06:00 UTC = 11:30 in the default zone (Asia/Kolkata): inside the digest's hours
    const d = new Date()
    const at = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 6, 0, 0))
    const due = new Date(at.getTime() - 2 * 86_400_000).toISOString()
    const remind = new Date(at.getTime() - 3600_000).toISOString()
    ok(await c.post('/data/sys_activities/rows', { values: { Type: 'Task', Subject: 'P3 Falcon launch checklist', DueOn: due, ReminderOn: remind, [REGARDING.table]: projects, [REGARDING.id]: proj } }))
    ok(await c.post('/data/sys_activities/rows', { values: { Type: 'Task', Subject: 'P3 own errand', DueOn: due, ReminderOn: remind } }))
    // Tia loses the role that let her read the project (and so the task about it)
    ok(await h.admin.patch(`/users/${tia}`, { roleIds: [] }))
    h.app.services.security.invalidate('all')
    await runInEnvironment('default', async () => {
      await h.app.services.tasks.runReminders({ now: at })
      await h.app.services.tasks.runDigest({ now: at })
    })
    const mine = await h.q<{ title: string; body: string | null }>(`SELECT title, body FROM ab.notifications WHERE user_id = $1`, [tia])
    const text = mine.map((n) => `${n.title}\n${n.body ?? ''}`).join('\n')
    // the positive control: her own task is reminded and listed
    expect(text).toContain('P3 own errand')
    expect(text).not.toContain('Falcon')
  }, 60_000)

  it('balances: the balance always equals the sum of live movements, whatever the write path', async () => {
    T.bmv = (ok(await h.admin.post('/tables', { displayName: 'P3BMoves', columns: [
      { displayName: 'Item', type: 'lookup', lookupTable: 'P3Items' }, { displayName: 'Location', type: 'lookup', lookupTable: 'P3Locations' }, { displayName: 'Quantity', type: 'decimal' },
    ] })) as any).id
    T.bbal = (ok(await h.admin.post('/tables', { displayName: 'P3BStock', columns: [
      { displayName: 'Item', type: 'lookup', lookupTable: 'P3Items' }, { displayName: 'Location', type: 'lookup', lookupTable: 'P3Locations' }, { displayName: 'OnHand', type: 'decimal' },
    ] })) as any).id
    await h.q(`UPDATE env_default.ab_tables SET def = jsonb_set(def, '{balance}', $2::jsonb) WHERE id = $1`, [T.bbal, JSON.stringify({ movements: 'P3BMoves', quantity: 'Quantity', column: 'OnHand', keys: [{ column: 'Item', from: 'Item' }, { column: 'Location', from: 'Location' }], label: 'Stock' })])
    h.app.services.security.invalidate('all')
    const soft = (await h.q(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'env_default' AND table_name = 't_p3bmoves' AND column_name = 'deletedOn'`)).length > 0
    const invariant = async (step: string) => {
      const bal = await h.q<{ k: string; q: string | null }>(`SELECT "Item" || ':' || "Location" AS k, "OnHand"::text AS q FROM env_default.t_p3bstock`)
      const sums = await h.q<{ k: string; s: string | null }>(`SELECT "Item" || ':' || "Location" AS k, sum("Quantity")::text AS s FROM env_default.t_p3bmoves WHERE "Item" IS NOT NULL AND "Location" IS NOT NULL${soft ? ' AND "deletedOn" IS NULL' : ''} GROUP BY 1`)
      const want = new Map(sums.map((r) => [r.k, Number(r.s ?? 0)]))
      const have = new Map(bal.map((r) => [r.k, Number(r.q ?? 0)]))
      for (const k of new Set([...want.keys(), ...have.keys()])) expect(have.get(k) ?? 0, `${step}: ${k}`).toBeCloseTo(want.get(k) ?? 0, 4)
      for (const v of have.values()) expect(v, `${step}: below the floor`).toBeGreaterThanOrEqual(-1e-9)
    }
    const mv = async (values: Record<string, unknown>) => h.admin.post(`/data/${T.bmv}/rows`, { values: { Item: ids.bolt, Location: ids.main, ...values } })
    const rows = async () => (await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.t_p3bmoves`))[0].n
    const r1 = (ok(await mv({ Quantity: 10 })) as any).row.id
    ok(await mv({ Item: ids.falcon, Quantity: 5 }))
    await invariant('receipts')
    // refused issue: neither the movement nor the balance stays
    const n0 = await rows()
    expect((await mv({ Quantity: -12 })).status).toBe(422)
    expect(await rows()).toBe(n0)
    await invariant('refused issue')
    // values that are not quantities
    for (const q of ['abc', 'NaN', '1e400', 'Infinity', { x: 1 }, [1]]) expect((await mv({ Quantity: q })).status, JSON.stringify(q)).toBe(422)
    await invariant('non-numeric')
    // CSV append: one bad line refuses the whole file
    const csv = (lines: string[]) => ['Item,Location,Quantity', ...lines].join('\n')
    const bad = await h.admin.post(`/data/${T.bmv}/import`, { mode: 'append', csv: csv([`${ids.bolt},${ids.main},3`, `${ids.bolt},${ids.main},-100`]) })
    expect(bad.status).toBeGreaterThanOrEqual(400)
    expect(await rows()).toBe(n0)
    await invariant('csv append refused')
    const good = await h.admin.post(`/data/${T.bmv}/import`, { mode: 'append', csv: csv([`${ids.bolt},${ids.main},3`]) })
    expect(good.status, JSON.stringify(good.data)).toBe(200)
    await invariant('csv append')
    // a key change and a move between keys in one update
    ok(await h.admin.patch(`/data/${T.bmv}/rows/${r1}`, { changes: { Item: ids.falcon } }))
    await invariant('key change')
    expect((await h.admin.patch(`/data/${T.bmv}/rows/${r1}`, { changes: { Item: ids.bolt, Quantity: -50 } })).status).toBe(422)
    await invariant('refused move')
    ok(await h.admin.patch(`/data/${T.bmv}/rows/${r1}`, { changes: { Item: ids.bolt, Quantity: 123456789.123457 } }))
    await invariant('large decimal')
    ok(await h.admin.patch(`/data/${T.bmv}/rows/${r1}`, { changes: { Quantity: 0.000001 } }))
    await invariant('tiny decimal')
    ok(await h.admin.patch(`/data/${T.bmv}/rows/${r1}`, { changes: { Quantity: 10 } }))
    // delete the receipt others depend on: refused; delete an issue, then restore it after the stock went
    const issue = (ok(await mv({ Quantity: -12 })) as any).row.id
    await invariant('issue')
    expect((await h.admin.post(`/data/${T.bmv}/delete`, { ids: [r1] })).status).toBe(422)
    await invariant('refused delete')
    const delIssue = ok(await h.admin.post(`/data/${T.bmv}/delete`, { ids: [issue] })) as any
    await invariant('issue deleted')
    ok(await h.admin.post(`/data/${T.bmv}/delete`, { ids: [r1] }))
    await invariant('receipt deleted')
    if (delIssue.batch) {
      const rs = await h.admin.post(`/data/${T.bmv}/restore`, { batch: delIssue.batch })
      expect(rs.status, JSON.stringify(rs.data)).toBe(422)
      await invariant('refused restore')
    }
    // the offline outbox: the same Idempotency-Key twice is one movement
    const send = () => fetch(`${h.base}/api/v1/data/${T.bmv}/rows`, { method: 'POST', headers: { 'X-Appbuilder': '1', Cookie: h.admin.cookie, 'Content-Type': 'application/json', 'Idempotency-Key': 'p3-balance-key-0001' }, body: JSON.stringify({ values: { Item: ids.bolt, Location: ids.main, Quantity: 7 } }) })
    const n1 = await rows()
    expect((await send()).status).toBe(200)
    expect((await send()).status).toBe(200)
    expect(await rows()).toBe(n1 + 1)
    await invariant('idempotent retry')
    // concurrent inserts and deletes
    const ins = Array.from({ length: 8 }, (_, i) => mv({ Quantity: i % 2 ? -1 : 2 }))
    const some = (await h.q<{ id: string }>(`SELECT id FROM env_default.t_p3bmoves WHERE "Quantity" > 0${soft ? ' AND "deletedOn" IS NULL' : ''} LIMIT 3`)).map((r) => r.id)
    const dels = some.map((id) => h.admin.post(`/data/${T.bmv}/delete`, { ids: [id] }))
    await Promise.all([...ins, ...dels])
    await invariant('concurrent')
    // CSV replace: every old movement leaves the balance
    ok(await h.admin.post(`/data/${T.bmv}/import`, { mode: 'replace', csv: csv([`${ids.bolt},${ids.main},1`]) }))
    await invariant('csv replace')
  }, 120_000)

  it('lookup sort: a row whose target is hidden sorts exactly like a blank lookup (both directions, pages, renames, counts); via names are not SQL', async () => {
    const targets = (ok(await h.admin.post('/tables', { displayName: 'P3LTargets', columns: [{ displayName: 'Name', type: 'text' }] })) as any).id
    const list = (ok(await h.admin.post('/tables', { displayName: 'P3LList', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Target', type: 'lookup', lookupTable: 'P3LTargets' }] })) as any).id
    const role = ok(await h.admin.post('/roles', { name: 'P3 sorters', apps: 'all', privileges: [
      { table: list, create: false, read: 'all', update: 'none', delete: 'none' }, { table: targets, create: true, read: 'own', update: 'own', delete: 'none' },
    ] })) as any
    await person('Sam Sorter', 'sam@example.com', [role.id])
    const { c: sam } = await login('sam@example.com')
    const tgt = async (c: Client, Name: string) => (ok(await c.post(`/data/${targets}/rows`, { values: { Name } })) as any).row.id
    const visible = await tgt(sam, 'Middle')
    const hiddenA = await tgt(h.admin, 'Aaa hidden')
    const hiddenZ = await tgt(h.admin, 'Zzz hidden')
    const order: string[] = []
    for (const [title, target] of [['r1', hiddenA], ['r2', null], ['r3', visible], ['r4', hiddenZ], ['r5', null], ['r6', visible], ['r7', hiddenA]] as const) {
      order.push((ok(await h.admin.post(`/data/${list}/rows`, { values: { Title: title, Target: target } })) as any).row.id)
    }
    const titles = new Map<string, string>()
    for (const [i, id] of order.entries()) titles.set(id, `r${i + 1}`)
    const sortKey = (dir: 'asc' | 'desc') => [{ col: 'Target', dir, via: { table: 'P3LTargets', col: 'Name' } }]
    const q = async (plan: Record<string, unknown>) => {
      const r = await sam.post('/query', { plan: { version: 2, table: list, ...plan } })
      expect(r.status, JSON.stringify(r.data)).toBe(200)
      return r.data
    }
    const all = async (dir: 'asc' | 'desc', size?: number) => {
      if (!size) return ((await q({ sort: sortKey(dir) })).rows as any[]).map((r) => titles.get(String(r.id)))
      const out: string[] = []
      let cursor: string | undefined
      for (let i = 0; i < 10; i++) {
        const a = await q({ sort: sortKey(dir), page: { size, ...(cursor ? { cursor } : {}) } })
        out.push(...(a.rows as any[]).map((r) => titles.get(String(r.id))!))
        if (!a.nextCursor) break
        cursor = a.nextCursor
      }
      return out
    }
    // hidden targets and blanks tie (natural order), the readable target sorts by its name
    expect(await all('asc')).toEqual(['r1', 'r2', 'r4', 'r5', 'r7', 'r3', 'r6'])
    expect(await all('desc')).toEqual(['r3', 'r6', 'r1', 'r2', 'r4', 'r5', 'r7'])
    expect(await all('asc', 2)).toEqual(await all('asc'))
    // renaming hidden targets moves nothing, also between pages
    const first = await q({ sort: sortKey('asc'), page: { size: 3 } })
    ok(await h.admin.patch(`/data/${targets}/rows/${hiddenA}`, { changes: { Name: 'Zzzz renamed' } }))
    ok(await h.admin.patch(`/data/${targets}/rows/${hiddenZ}`, { changes: { Name: 'Aaaa renamed' } }))
    const rest = await q({ sort: sortKey('asc'), page: { size: 10, cursor: first.nextCursor } })
    expect([...first.rows, ...rest.rows].map((r: any) => titles.get(String(r.id)))).toEqual(['r1', 'r2', 'r4', 'r5', 'r7', 'r3', 'r6'])
    expect(await all('desc', 3)).toEqual(['r3', 'r6', 'r1', 'r2', 'r4', 'r5', 'r7'])
    // a filter the viewer may use, with a count
    const blanks = await q({ filter: { col: 'Target', op: 'isNull' }, count: true })
    expect(blanks.count).toBe(2)
    const viaFilter = await q({ filter: { via: { col: 'Target', table: 'P3LTargets', where: { col: 'Name', op: 'eq', value: 'Aaaa renamed' } } }, count: true })
    expect(viaFilter.count).toBe(0)
    // via names are identifiers checked against the schema, never SQL
    for (const via of [{ table: 'P3LTargets"; DROP TABLE env_default.t_p3llist; --', col: 'Name' }, { table: 'P3LTargets', col: 'Name" DESC, (SELECT 1) --' }, { table: 'sys_users', col: 'Email' }, { table: targets, col: 'Name' }]) {
      const r = await sam.post('/query', { plan: { version: 2, table: list, sort: [{ col: 'Target', dir: 'asc', via }] } })
      expect(r.status, JSON.stringify(via)).toBeGreaterThanOrEqual(400)
      expect(r.status).toBeLessThan(500)
    }
    expect((await h.q(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'env_default' AND table_name = 't_p3llist'`)).length).toBe(1)
    // the cost limit: at most 3 lookup sort keys
    const four = await sam.post('/query', { plan: { version: 2, table: list, sort: [...sortKey('asc'), ...sortKey('desc'), ...sortKey('asc'), ...sortKey('desc')] } })
    expect(four.status).toBe(422)
  }, 90_000)

  it('guard: the removed Query v1 route answers nothing for anyone; Query v2 is the only query route', async () => {
    const routes = (h.app.router.routes() as { key: string }[]).map((r) => r.key)
    expect(routes.filter((k) => /\/data\/:[a-z]+\/query$/.test(k))).toEqual([])
    const v1 = await h.admin.post(`/data/${T.item}/query`, { where: null })
    expect(v1.status).toBe(404)
  })
})
