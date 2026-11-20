/**
 * Realtime hub, notifications and optimistic concurrency over HTTP + WebSocket against the sandbox PostgreSQL:
 *   APPBUILDER_TEST_DB=postgres://abdev:abdev-sandbox-only@127.0.0.1:5433/appbuilder_test npx vitest run server/core/live
 * Upgrade guards (Origin, Host, cookie, forced password change), limits, the leak rule (a restricted user's socket never
 * receives a hidden column name or a foreign row id), gap detection, session revocation, presence privacy, Studio locks,
 * app / env messages, the notification API and the 409 on a stale save. Table pushes come from package G's outbox (the
 * job worker of createApp dispatches it), so the seq of a table message is its outbox id. Creates and drops its own database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { PG_URL, SKIP_PG, dropDatabase, pgQuery, pgServer, testDatabaseName } from './testdb.ts'
import { createApp } from './app.ts'
import type { AppServer } from './app.ts'
import { createLiveHub } from './live/hub.ts'
import { emitTableChange } from './live/changes.ts'
import { setQuiet } from './util.ts'

setQuiet(true)

const conn = pgServer
const dbName = testDatabaseName('lv')
if (!PG_URL) process.stderr.write(`[server/core live integration] ${SKIP_PG}\n`)

class Client {
  cookie = ''
  base: string
  live = ''
  constructor(base: string) {
    this.base = base
  }
  async req(method: string, p: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { 'X-Appbuilder': '1', ...extra }
    if (this.cookie) headers.Cookie = this.cookie
    if (this.live) headers['X-Appbuilder-Live'] = this.live
    let payload: string | undefined
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    const res = await fetch(this.base + '/api/v1' + p, { method, headers, body: payload })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const [name, value] = pair.split('=')
      if (name === 'ab_session') this.cookie = value ? `ab_session=${value}` : ''
    }
    const type = res.headers.get('content-type') ?? ''
    const data = type.includes('json') ? await res.json() : await res.text()
    return { status: res.status, data: data as any }
  }
  get = (p: string) => this.req('GET', p)
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {})
  patch = (p: string, b: unknown) => this.req('PATCH', p, b)
  put = (p: string, b: unknown) => this.req('PUT', p, b)
  del = (p: string) => this.req('DELETE', p)
}

/** a test WebSocket: collects every message (parsed and raw), waits for conditions */
class Sock {
  ws: WebSocket
  msgs: any[] = []
  raw: string[] = []
  closed: { code: number; reason: string } | null = null
  status: number | null = null
  private waiters: (() => void)[] = []
  constructor(url: string, headers: Record<string, string>) {
    this.ws = new WebSocket(url, { headers })
    this.ws.on('message', (d) => {
      const t = d.toString()
      this.raw.push(t)
      this.msgs.push(JSON.parse(t))
      this.tick()
    })
    this.ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() }
      this.tick()
    })
    this.ws.on('unexpected-response', (_req, res) => {
      this.status = res.statusCode ?? 0
      this.closed = { code: -1, reason: String(res.statusCode) }
      this.tick()
    })
    this.ws.on('error', () => this.tick())
  }
  private tick() {
    for (const w of this.waiters.splice(0)) w()
  }
  async until<T>(fn: () => T | undefined | null | false, ms = 4000): Promise<T> {
    const end = Date.now() + ms
    for (;;) {
      const v = fn()
      if (v) return v
      if (Date.now() > end) throw new Error(`timed out; got ${JSON.stringify(this.msgs.slice(-5))} closed=${JSON.stringify(this.closed)}`)
      await new Promise<void>((r) => {
        this.waiters.push(r)
        setTimeout(r, 50)
      })
    }
  }
  find(pred: (m: any) => boolean) {
    return this.msgs.find(pred)
  }
  waitMsg(pred: (m: any) => boolean, ms?: number) {
    return this.until(() => this.find(pred), ms)
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m))
  }
  async sub(topic: string, env?: string) {
    const id = Math.random().toString(36).slice(2)
    this.send({ t: 'sub', id, topic, env })
    return this.waitMsg((m) => m.id === id)
  }
  close() {
    this.ws.terminate()
  }
}

async function serve(app: AppServer): Promise<{ server: http.Server; base: string }> {
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

describe.skipIf(!PG_URL)('realtime hub (PostgreSQL)', () => {
  let app: AppServer
  let server: http.Server
  let tmp = ''
  let base = ''
  let wsUrl = ''
  let A: Client
  let B: Client
  let R: Client
  let Z: Client
  let table: any
  const ids: Record<string, string> = {}
  const sockets: Sock[] = []
  const open = (c: Client | null, headers: Record<string, string> = {}) => {
    const s = new Sock(wsUrl, { Origin: base, ...(c?.cookie ? { Cookie: c.cookie } : {}), ...headers })
    sockets.push(s)
    return s
  }
  const ready = async (c: Client) => {
    const s = open(c)
    const hello = await s.waitMsg((m) => m.t === 'hello')
    return { s, hello }
  }

  async function user(name: string, email: string, roleIds: string[]): Promise<Client> {
    const u = await A.post('/users', { name, email, roleIds, password: 'temporary-pass-1' })
    expect(u.status, JSON.stringify(u.data)).toBe(200)
    ids[name] = u.data.id
    const c = new Client(base)
    expect((await c.post('/auth/login', { email, password: 'temporary-pass-1' })).status).toBe(200)
    expect((await c.post('/auth/password', { current: 'temporary-pass-1', next: `${name}-own-password-1` })).status).toBe(200)
    return c
  }

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-lv-'))
    app = await createApp({ env: { APPBUILDER_LIVE_MAX_PER_USER: '6' }, config: { workspaceDir: tmp }, printSetupCode: false })
    ;({ server, base } = await serve(app))
    wsUrl = base.replace('http', 'ws') + '/api/v1/live'
    A = new Client(base)
    const code = app.services.setupCode.current()
    expect((await A.post('/setup/database', { host: conn!.host, port: conn!.port, database: dbName, user: conn!.user, password: conn!.password, createDatabase: true, setupCode: code })).status).toBe(200)
    expect((await A.post('/setup/admin', { name: 'Ada Admin', email: 'ada@example.com', password: 'admin-password-1', setupCode: code })).status).toBe(200)
    const t = await A.post('/tables', { displayName: 'Tickets', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Secret', type: 'text' }] })
    expect(t.status, JSON.stringify(t.data)).toBe(200)
    table = t.data
    const all = await A.post('/roles', { name: 'Readers', apps: 'all', privileges: [{ table: table.id, create: true, read: 'all', update: 'all', delete: 'all' }] })
    const restricted = await A.post('/roles', { name: 'Restricted', apps: 'all', privileges: [{ table: table.id, create: true, read: 'own', update: 'own', delete: 'own', columns: { Secret: 'none' } }] })
    const none = await A.post('/roles', { name: 'Nothing', apps: [], privileges: [] })
    expect([all.status, restricted.status, none.status]).toEqual([200, 200, 200])
    B = await user('Bea', 'bea@example.com', [all.data.id])
    R = await user('Raj', 'raj@example.com', [restricted.data.id])
    Z = await user('Zed', 'zed@example.com', [none.data.id])
    ids.Ada = (await A.get('/auth/session')).data.user.id
  }, 90000)

  afterAll(async () => {
    for (const s of sockets) s.close()
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    await app?.close()
    if (conn) await dropDatabase(dbName)
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }, 60000)

  /* ------------------------------------------------------------------ upgrade guards */

  it('upgrade: Origin is required and must be this origin; Host must be allowed; no cookie -> 4401', async () => {
    const noOrigin = new Sock(wsUrl, { Cookie: A.cookie })
    sockets.push(noOrigin)
    await noOrigin.until(() => noOrigin.closed)
    expect(noOrigin.status).toBe(403)
    const foreign = open(A, { Origin: 'http://evil.example' })
    await foreign.until(() => foreign.closed)
    expect(foreign.status).toBe(403)
    const otherPort = open(A, { Origin: 'http://127.0.0.1:1' })
    await otherPort.until(() => otherPort.closed)
    expect(otherPort.status).toBe(403)
    const badHost = open(A, { Host: 'attacker.example' , Origin: 'http://attacker.example' })
    await badHost.until(() => badHost.closed)
    expect(badHost.status).toBe(403)
    const anon = open(null)
    await anon.until(() => anon.closed)
    expect(anon.closed!.code).toBe(4401)
    const forged = open(null, { Cookie: 'ab_session=not-a-real-token' })
    await forged.until(() => forged.closed)
    expect(forged.closed!.code).toBe(4401)
  })

  it('hello, then subscriptions are checked per environment and topic', async () => {
    const { s, hello } = await ready(B)
    expect(hello).toMatchObject({ t: 'hello', v: 1, user: { id: ids.Bea, name: 'Bea' } })
    expect(hello.connection).toMatch(/^[A-Za-z0-9_-]{8,}$/)
    expect((await s.sub(`table:${table.id}`, 'default')).t).toBe('subscribed')
    // environment required, unknown environment, someone else's user topic, unknown topic
    expect((await s.sub(`table:${table.id}`)).code).toBe('invalid')
    expect((await s.sub(`table:${table.id}`, 'nowhere')).code).toBe('not-found')
    expect((await s.sub(`user:${ids.Ada}`)).code).toBe('denied')
    expect((await s.sub('weird:thing', 'default')).code).toBe('invalid')
    expect((await s.sub(`user:${ids.Bea}`)).t).toBe('subscribed')
    // a table Zed may not read: not found (no existence leak); presence:online only for admins
    const z = (await ready(Z)).s
    expect((await z.sub(`table:${table.id}`, 'default')).code).toBe('not-found')
    expect((await z.sub('presence:online', 'default')).code).toBe('denied')
    expect((await z.sub('presence:studio:app_x', 'default')).code).toBe('denied')
    expect((await z.sub('env', 'default')).t).toBe('subscribed')
  })

  /* ------------------------------------------------------------------ leak rule */

  it('LEAK: a restricted user receives ticks without foreign row ids or hidden column names; Zed receives nothing', async () => {
    const a = (await ready(A)).s
    const b = (await ready(B)).s
    const r = (await ready(R)).s
    const z = (await ready(Z)).s
    for (const s of [a, b, r]) expect((await s.sub(`table:${table.id}`, 'default')).t).toBe('subscribed')
    await z.sub(`table:${table.id}`, 'default')
    // Ada writes a row (foreign to Raj) with a secret
    const ins = await A.post(`/data/${table.id}/rows`, { values: { Title: 'Ada row', Secret: 'TOPSECRET' } })
    expect(ins.status).toBe(200)
    const foreignId = ins.data.row.id
    const mb = await b.waitMsg((m) => m.t === 'table' && m.op === 'insert')
    expect(mb.rows).toEqual([foreignId])
    expect(mb.columns).toEqual(expect.arrayContaining(['Title', 'Secret']))
    expect(mb.by).toEqual({ id: ids.Ada, name: 'Ada Admin' })
    const mr = await r.waitMsg((m) => m.t === 'table' && m.op === 'insert')
    expect(mr.rows).toBeNull()
    expect(mr.by).toBeUndefined()
    expect(mr.columns).toContain('Title')
    expect(mr.columns).not.toContain('Secret')
    // an update of the hidden column only: Raj gets a tick without any column name
    expect((await A.patch(`/data/${table.id}/rows/${foreignId}`, { changes: { Secret: 'NEWSECRET' } })).status).toBe(200)
    const ur = await r.waitMsg((m) => m.t === 'table' && m.op === 'update')
    expect(ur.columns).toEqual([])
    const ub = await b.waitMsg((m) => m.t === 'table' && m.op === 'update')
    expect(ub.columns).toEqual(['Secret'])
    // Raj's own write: still a tick for Raj (his read scope is "own"); Bea sees the id
    const own = await R.post(`/data/${table.id}/rows`, { values: { Title: 'Raj row' } })
    expect(own.status).toBe(200)
    await b.waitMsg((m) => m.t === 'table' && m.rows?.includes(own.data.row.id))
    await r.until(() => r.msgs.filter((m) => m.t === 'table').length >= 3)
    // delete
    expect((await A.post(`/data/${table.id}/delete`, { ids: [foreignId] })).status).toBe(200)
    await r.waitMsg((m) => m.t === 'table' && m.op === 'delete')
    const da = await b.waitMsg((m) => m.t === 'table' && m.op === 'delete')
    expect(da.rows).toEqual([foreignId])
    await sleep(200)
    for (const t of r.raw) {
      expect(t).not.toContain(foreignId)
      expect(t).not.toContain('Secret')
      expect(t).not.toContain('TOPSECRET')
      expect(t).not.toContain('Ada Admin')
    }
    expect(z.msgs.filter((m) => m.t === 'table')).toEqual([])
  })

  it('a write carrying X-Appbuilder-Live comes back to its own socket marked self', async () => {
    const { s, hello } = await ready(B)
    await s.sub(`table:${table.id}`, 'default')
    const other = (await ready(B)).s
    await other.sub(`table:${table.id}`, 'default')
    B.live = hello.connection
    try {
      expect((await B.post(`/data/${table.id}/rows`, { values: { Title: 'mine' } })).status).toBe(200)
    } finally {
      B.live = ''
    }
    expect((await s.waitMsg((m) => m.t === 'table' && m.op === 'insert')).self).toBe(true)
    expect((await other.waitMsg((m) => m.t === 'table' && m.op === 'insert')).self).toBeUndefined()
  })

  it('a schema change (a unit of work that invalidates security) does not drop the subscriptions of people who keep their access', async () => {
    const s = (await ready(B)).s
    await s.sub(`table:${table.id}`, 'default')
    // creating a table invalidates the security caches inside its transaction; the hub re-checks 250 ms later
    const made = await A.post('/tables', { displayName: `Recheck ${Date.now()}`, columns: [{ displayName: 'Name', type: 'text' }] })
    expect(made.status, JSON.stringify(made.data)).toBe(200)
    await new Promise((r) => setTimeout(r, 900))
    expect(s.msgs.filter((m) => m.t === 'unsubscribed' || m.t === 'error')).toEqual([])
    // and the subscription still delivers
    expect((await B.post(`/data/${table.id}/rows`, { values: { Title: 'still here' } })).status).toBe(200)
    await s.waitMsg((m) => m.t === 'table' && m.op === 'insert')
    s.close()
  })

  it('gap detection: prev chains per table; a resubscribe acknowledges the latest seq', async () => {
    const s = (await ready(B)).s
    const ack = await s.sub(`table:${table.id}`, 'default')
    const before = ack.seq
    expect(typeof before).toBe('number')
    await B.post(`/data/${table.id}/rows`, { values: { Title: 'g1' } })
    await B.post(`/data/${table.id}/rows`, { values: { Title: 'g2' } })
    await s.until(() => s.msgs.filter((m) => m.t === 'table').length >= 2)
    const [m1, m2] = s.msgs.filter((m) => m.t === 'table')
    expect(m1.prev).toBe(before)
    expect(m2.prev).toBe(m1.seq)
    expect(m2.seq).toBeGreaterThan(m1.seq)
    // the sequence is the outbox id (package G)
    const ob = await pgQuery<{ id: string }>(dbName, `SELECT max(id)::text AS id FROM env_default.ab_outbox WHERE table_id = $1`, [table.id])
    expect(m2.seq).toBe(Number(ob[0].id))
    // while disconnected a change happens; the new subscription's ack is ahead of what the client saw: resync
    s.close()
    await B.post(`/data/${table.id}/rows`, { values: { Title: 'missed' } })
    const s2 = (await ready(B)).s
    const ack2 = await s2.sub(`table:${table.id}`, 'default')
    // The hub learns of the missed change from the outbox a moment after the commit. Either the ack is already ahead
    // (resync), or the change arrives as a message chained to what the client saw: never neither.
    if (ack2.seq === m2.seq) {
      const late = await s2.waitMsg((m) => m.t === 'table')
      expect(late.prev).toBe(m2.seq)
      expect(late.seq).toBeGreaterThan(m2.seq)
    } else {
      expect(ack2.seq).toBeGreaterThan(m2.seq)
    }
    expect(ack2.epoch).toBe(ack.epoch)
  })

  /* ------------------------------------------------------------------ limits */

  it('limits: binary frames, oversized messages, too many subscriptions, too many sockets per user', { timeout: 40000 }, async () => {
    const big = (await ready(B)).s
    big.send({ t: 'sub', topic: 'env', env: 'default', pad: 'x'.repeat(20_000) })
    await big.until(() => big.closed)
    expect(big.closed!.code).toBe(1009)
    const bin = (await ready(B)).s
    bin.ws.send(Buffer.from([1, 2, 3]))
    await bin.until(() => bin.closed)
    expect(bin.closed!.code).toBe(4400)
    const junk = (await ready(B)).s
    junk.ws.send('not json')
    await junk.until(() => junk.closed)
    expect(junk.closed!.code).toBe(4400)
    // per-user limit (6 in this suite): close the earlier ones first, then open 7
    for (const s of sockets) if (!s.closed) s.close()
    await sleep(200)
    const mine: Sock[] = []
    for (let i = 0; i < 6; i++) mine.push((await ready(R)).s)
    const extra = open(R)
    await extra.until(() => extra.closed)
    expect(extra.closed!.code).toBe(4429)
    // subscriptions per connection: 200 accepted, the 201st refused (sent slowly enough for the inbound rate limit)
    const s = mine[0]
    for (let i = 0; i < 201; i++) {
      s.send({ t: 'sub', id: `n${i}`, topic: `presence:record:${table.id}:r${i}`, env: 'default' })
      if (i % 15 === 14) await sleep(800)
    }
    await s.until(() => s.msgs.filter((m) => m.id?.startsWith('n')).length >= 201, 30000)
    expect(s.msgs.filter((m) => m.t === 'subscribed').length).toBe(200)
    expect(s.find((m) => m.id === 'n200')).toMatchObject({ t: 'error', code: 'limit' })
    for (const m of mine) m.close()
  })

  it('inbound rate limit: a flood gets errors, then the socket is closed', async () => {
    const s = (await ready(B)).s
    for (let i = 0; i < 300; i++) s.send({ t: 'ping', id: String(i) })
    await s.until(() => s.closed, 6000)
    expect(s.closed!.code).toBe(4429)
    expect(s.msgs.some((m) => m.t === 'error' && m.code === 'limit')).toBe(true)
  })

  it('slow consumer: a socket that stops reading is dropped with resync, never buffered without bound', async () => {
    // a second hub with a tiny buffer limit on its own server
    const hub = createLiveHub(app.services as never, { limits: { maxBufferedBytes: 64 * 1024, heartbeatMs: 60_000 } })
    const srv = http.createServer((_q, res) => res.end())
    srv.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head))
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as AddressInfo).port
    try {
      const s = new Sock(`ws://127.0.0.1:${port}/api/v1/live`, { Origin: `http://127.0.0.1:${port}`, Cookie: B.cookie })
      sockets.push(s)
      await s.waitMsg((m) => m.t === 'hello')
      await s.sub(`table:${table.id}`, 'default')
      ;(s.ws as unknown as { _socket: { pause(): void } })._socket.pause()
      const rowIds = Array.from({ length: 50 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
      for (let i = 0; i < 40000; i++) emitTableChange('default', table.id, { op: 'update', rowIds, changedColumns: ['Title'], actor: { id: ids.Ada, name: 'Ada Admin' } })
      const st = await (async () => {
        for (let i = 0; i < 100; i++) {
          if (hub.stats().slowClosed > 0) return hub.stats()
          await sleep(100)
        }
        return hub.stats()
      })()
      expect(st.slowClosed).toBe(1)
      expect(st.connections).toBe(0)
    } finally {
      await hub.close()
      await new Promise<void>((r) => srv.close(() => r()))
    }
  }, 30000)

  /* ------------------------------------------------------------------ sessions */

  it('logout, password change and disabling close the sockets at once (4401) with a session event', async () => {
    const c = new Client(base)
    await c.post('/auth/login', { email: 'bea@example.com', password: 'Bea-own-password-1' })
    const s = (await ready(c)).s
    await s.sub(`user:${ids.Bea}`)
    const other = (await ready(B)).s
    await c.post('/auth/logout')
    await s.until(() => s.closed)
    expect(s.closed!.code).toBe(4401)
    expect(s.find((m) => m.t === 'user' && m.event === 'session')?.reason).toBe('signed_out')
    // another session of the same user is not affected by that logout
    await sleep(100)
    expect(other.closed).toBeNull()
    // an administrator disables the account: every socket closes
    expect((await A.patch(`/users/${ids.Bea}`, { status: 'disabled' })).status).toBe(200)
    await other.until(() => other.closed)
    expect(other.closed!.code).toBe(4401)
    expect((await A.patch(`/users/${ids.Bea}`, { status: 'active' })).status).toBe(200)
    expect((await B.post('/auth/login', { email: 'bea@example.com', password: 'Bea-own-password-1' })).status).toBe(200)
    // an admin password reset forces a change: the socket closes; a new one is refused with 4403
    const r2 = new Client(base)
    await r2.post('/auth/login', { email: 'raj@example.com', password: 'Raj-own-password-1' })
    const rs = (await ready(r2)).s
    expect((await A.post(`/users/${ids.Raj}/password`, { password: 'temporary-pass-9' })).status).toBe(200)
    await rs.until(() => rs.closed)
    expect(rs.closed!.code).toBe(4401)
    const r3 = new Client(base)
    await r3.post('/auth/login', { email: 'raj@example.com', password: 'temporary-pass-9' })
    const forced = open(r3)
    await forced.until(() => forced.closed)
    expect(forced.closed!.code).toBe(4403)
    expect((await r3.post('/auth/password', { current: 'temporary-pass-9', next: 'Raj-own-password-1' })).status).toBe(200)
    R = r3
  })

  /* ------------------------------------------------------------------ presence and locks */

  it('presence: members of an app scope; hidden users are left out; online list for admins only', async () => {
    const app1 = await A.post('/apps', { name: 'Live app', width: 1280, height: 800 })
    expect(app1.status).toBe(200)
    ids.app = app1.data.id
    const a = (await ready(A)).s
    const b = (await ready(B)).s
    await a.sub(`presence:app:${ids.app}`, 'default')
    await b.sub(`presence:app:${ids.app}`, 'default')
    a.send({ t: 'presence', scope: `app:${ids.app}`, env: 'default', state: 'viewing' })
    b.send({ t: 'presence', scope: `app:${ids.app}`, env: 'default', state: 'viewing' })
    const both = await a.waitMsg((m) => m.t === 'presence' && m.members.length === 2)
    expect(both.members.map((x: any) => x.name).sort()).toEqual(['Ada Admin', 'Bea'])
    // Zed may not run the app (role "Nothing" has no apps): no subscription, no publishing
    const z = (await ready(Z)).s
    expect((await z.sub(`presence:app:${ids.app}`, 'default')).code).toBe('not-found')
    // Bea hides her presence: Ada's list drops her; Bea still sees herself
    expect((await B.put('/notifications/settings', { hidePresence: true })).status).toBe(200)
    await a.waitMsg((m) => m.t === 'presence' && m.members.length === 1 && m.members[0].name === 'Ada Admin')
    const online = await a.sub('presence:online', 'default')
    expect(online.t).toBe('subscribed')
    const list = await a.waitMsg((m) => m.t === 'presence' && m.scope === 'online')
    expect(list.members.map((x: any) => x.id)).not.toContain(ids.Bea)
    expect(list.members.map((x: any) => x.id)).toContain(ids.Ada)
    expect((await B.put('/notifications/settings', { hidePresence: false })).status).toBe(200)
    await a.waitMsg((m) => m.t === 'presence' && m.scope === `app:${ids.app}` && m.members.length === 2)
  })

  it('Studio soft lock: the first editor holds it, others are refused, a maker may take over', async () => {
    const scope = `studio:${ids.app}`
    const a1 = (await ready(A)).s
    const a2 = (await ready(A)).s
    await a1.sub(`presence:${scope}`, 'default')
    await a2.sub(`presence:${scope}`, 'default')
    a1.send({ t: 'lock', id: 'l1', scope, env: 'default', action: 'acquire' })
    expect(await a1.waitMsg((m) => m.id === 'l1')).toMatchObject({ ok: true, mine: true })
    a2.send({ t: 'lock', id: 'l2', scope, env: 'default', action: 'acquire' })
    expect(await a2.waitMsg((m) => m.id === 'l2')).toMatchObject({ ok: false, mine: false, holder: { name: 'Ada Admin' } })
    a2.send({ t: 'lock', id: 'l3', scope, env: 'default', action: 'takeover' })
    expect(await a2.waitMsg((m) => m.id === 'l3')).toMatchObject({ ok: true, mine: true })
    expect(await a1.waitMsg((m) => m.t === 'lock' && m.message?.includes('took over'))).toMatchObject({ mine: false })
    // a viewer (no maker) may not even look at the Studio scope
    const b = (await ready(B)).s
    b.send({ t: 'lock', id: 'l4', scope, env: 'default', action: 'acquire' })
    expect((await b.waitMsg((m) => m.id === 'l4')).code).toBe('denied')
  })

  /* ------------------------------------------------------------------ app and env messages */

  it('app saved -> app message (self on the saving socket); environment lock -> env state message', async () => {
    const def = (await A.get(`/apps/${ids.app}`)).data.definition
    const { s, hello } = await ready(A)
    const b = (await ready(B)).s
    await s.sub(`app:${ids.app}`, 'default')
    await b.sub(`app:${ids.app}`, 'default')
    await b.sub('env', 'default')
    A.live = hello.connection
    try {
      expect((await A.put(`/apps/${ids.app}`, { definition: def })).status).toBe(200)
    } finally {
      A.live = ''
    }
    const mb = await b.waitMsg((m) => m.t === 'app')
    expect(mb).toMatchObject({ kind: 'saved', app: ids.app, by: { name: 'Ada Admin' } })
    expect(typeof mb.modifiedOn).toBe('string')
    expect((await s.waitMsg((m) => m.t === 'app')).self).toBe(true)
    // a table schema change is metadata
    expect((await A.post(`/tables/${table.id}/columns`, { displayName: 'Extra', type: 'text' })).status).toBe(200)
    await b.waitMsg((m) => m.t === 'env' && m.kind === 'metadata')
    expect((await A.patch('/environments/default', { locked: true })).status).toBe(200)
    expect(await b.waitMsg((m) => m.t === 'env' && m.kind === 'state')).toMatchObject({ locked: true })
    expect((await A.patch('/environments/default', { locked: false })).status).toBe(200)
  })

  /* ------------------------------------------------------------------ optimistic concurrency */

  it('a stale save answers 409 with the current row and who changed it; a fresh one succeeds', async () => {
    const ins = await B.post(`/data/${table.id}/rows`, { values: { Title: 'v1' } })
    const row = ins.data.row
    // Ada changes it
    expect((await A.patch(`/data/${table.id}/rows/${row.id}`, { changes: { Title: 'by Ada' } })).status).toBe(200)
    // Bea saves with the version she opened
    const stale = await B.patch(`/data/${table.id}/rows/${row.id}`, { changes: { Title: 'by Bea' }, ifModifiedOn: row.modifiedOn })
    expect(stale.status).toBe(409)
    expect(stale.data.error).toMatchObject({ code: 'conflict', field: 'modifiedOn' })
    expect(stale.data.error.message).toContain('Ada Admin')
    expect(stale.data.current.Title).toBe('by Ada')
    expect(stale.data.changedBy).toEqual({ id: ids.Ada, name: 'Ada Admin' })
    // keep mine: save again with the current version
    const ok = await B.patch(`/data/${table.id}/rows/${row.id}`, { changes: { Title: 'by Bea' }, ifModifiedOn: stale.data.current.modifiedOn })
    expect(ok.status, JSON.stringify(ok.data)).toBe(200)
    expect(ok.data.row.Title).toBe('by Bea')
    // malformed version
    expect((await B.patch(`/data/${table.id}/rows/${row.id}`, { changes: { Title: 'x' }, ifModifiedOn: 'yesterday' })).status).toBe(422)
    // the restricted user: a row he may not change answers 404/403 first (the 409 never reveals it)
    const r = await R.patch(`/data/${table.id}/rows/${row.id}`, { changes: { Title: 'x' }, ifModifiedOn: '2000-01-01T00:00:00.000Z' })
    expect([403, 404]).toContain(r.status)
    expect(JSON.stringify(r.data)).not.toContain('current')
    // the 409 body never carries a hidden column
    const rown = await R.post(`/data/${table.id}/rows`, { values: { Title: 'raj v1' } })
    expect((await A.patch(`/data/${table.id}/rows/${rown.data.row.id}`, { changes: { Secret: 'S2' } })).status).toBe(200)
    const st = await R.patch(`/data/${table.id}/rows/${rown.data.row.id}`, { changes: { Title: 'raj v2' }, ifModifiedOn: rown.data.row.modifiedOn })
    expect(st.status).toBe(409)
    expect(st.data.current).not.toHaveProperty('Secret')
  })

  /* ------------------------------------------------------------------ notifications */

  it('notifications: send (any user in the environment), push to the bell, list, read, delete, settings', async () => {
    const b = (await ready(B)).s
    await b.sub(`user:${ids.Bea}`)
    const sent = await A.post('/notifications/send', { to: 'bea@example.com', title: 'Hello Bea', body: 'Please check', link: '#u' })
    expect(sent.status, JSON.stringify(sent.data)).toBe(200)
    const push = await b.waitMsg((m) => m.t === 'user' && m.event === 'notification')
    expect(push.notification).toMatchObject({ title: 'Hello Bea', body: 'Please check', link: '#u', kind: 'app', from: 'Ada Admin', environmentId: 'default' })
    expect(push.unread).toBe(1)
    // by id, from a non-admin user
    expect((await R.post('/notifications/send', { to: ids.Bea, title: 'From Raj' })).status).toBe(200)
    const list = await B.get('/notifications?limit=1')
    expect(list.data.items).toHaveLength(1)
    expect(list.data.items[0].title).toBe('From Raj')
    expect(list.data.unread).toBe(2)
    const page2 = await B.get(`/notifications?limit=1&cursor=${encodeURIComponent(list.data.nextCursor)}`)
    expect(page2.data.items[0].title).toBe('Hello Bea')
    expect((await B.get('/notifications/unread-count')).data.unread).toBe(2)
    expect((await B.post(`/notifications/${list.data.items[0].id}/read`)).data.unread).toBe(1)
    await b.waitMsg((m) => m.t === 'user' && m.event === 'unread' && m.unread === 1)
    expect((await B.post('/notifications/read-all')).data.unread).toBe(0)
    expect((await B.get('/notifications?unread=1')).data.items).toEqual([])
    expect((await B.del(`/notifications/${list.data.items[0].id}`)).status).toBe(200)
    // someone else's notification: not found
    expect((await A.del(`/notifications/${page2.data.items[0].id}`)).status).toBe(404)
    // validation: external links, unknown users, users outside the environment
    expect((await A.post('/notifications/send', { to: ids.Bea, title: 'x', link: 'https://evil.example' })).status).toBe(422)
    expect((await A.post('/notifications/send', { to: ids.Bea, title: 'x', link: 'javascript:alert(1)' })).status).toBe(422)
    expect((await A.post('/notifications/send', { to: 'nobody@example.com', title: 'x' })).status).toBe(404)
    expect((await A.post('/notifications/send', { to: ids.Bea, title: '' })).status).toBe(422)
    // settings: switching "app" off means nothing is stored for Bea
    expect((await B.put('/notifications/settings', { kinds: { app: false }, desktop: true, dnd: { start: '22:00', end: '07:00' } })).data).toMatchObject({ kinds: { app: false }, desktop: true, dnd: { start: '22:00', end: '07:00' } })
    expect((await A.post('/notifications/send', { to: ids.Bea, title: 'muted' })).status).toBe(200)
    expect((await B.get('/notifications')).data.items.some((n: any) => n.title === 'muted')).toBe(false)
    expect((await B.put('/notifications/settings', { kinds: {} })).status).toBe(200)
    // the service other packages call
    const r = await app.services.notifications!.notify({ userIds: [ids.Bea, 'user_missing'] }, { kind: 'system', title: 'From the system', source: 'system' })
    expect(r).toEqual({ delivered: [ids.Bea], skipped: ['user_missing'] })
    // teams need the environment they belong to; an unknown team reaches nobody
    await expect(app.services.notifications!.notify({ teamIds: ['team_x'] }, { kind: 'system', title: 'x', source: 'system' })).rejects.toThrow()
    expect(await app.services.notifications!.notify({ teamIds: ['team_x'] }, { kind: 'system', title: 'x', source: 'system', environmentId: 'default' })).toEqual({ delivered: [], skipped: [] })
    // a team of this environment: its members
    const team = await A.post('/teams', { code: 'OPS', name: 'Operations', memberIds: [ids.Bea, ids.Raj] })
    if (team.status === 200) {
      const tr = await app.services.notifications!.notify({ teamIds: ['ops'] }, { kind: 'system', title: 'Team note', source: 'system', environmentId: 'default' })
      expect(tr.delivered.sort()).toEqual([ids.Bea, ids.Raj].sort())
    }
  })

  it('SendNotification is rate-limited per sender', async () => {
    let last = 0
    for (let i = 0; i < 35; i++) {
      last = (await Z.post('/notifications/send', { to: ids.Ada, title: `n${i}` })).status
      if (last === 429) break
    }
    expect(last).toBe(429)
  })
})
