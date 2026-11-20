import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { createSecretBox, loadSecretKey } from './secrets.ts'
import { checkPasswordPolicy, hashPassword, verifyPassword } from './password.ts'
import { buildUserContext, rowFilterCondition } from './security.ts'
import { createRouter, lingerClose, originProblem } from './router.ts'
import { HttpError } from './contracts.ts'
import type { Services } from './contracts.ts'
import type { RoleDef, TableDef, UserDef } from '../../src/platform/contracts.ts'
import { LoginThrottle } from './auth.ts'
import { coerceIn, cellOut } from './values.ts'
import { safeStaticPath } from './static.ts'
import { rowUid, setQuiet } from './util.ts'
import { evaluateCondition } from './condition.ts'

setQuiet(true)

/* ------------------------------------------------------------------ SecretBox */

describe('SecretBox', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-secret-'))
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('round-trips, uses a fresh IV each time, rejects tampering and wrong keys', () => {
    const box = createSecretBox(Buffer.alloc(32, 7))
    const a = box.encrypt('s3cret pass')
    const b = box.encrypt('s3cret pass')
    expect(a).not.toBe(b)
    expect(a.startsWith('v1:')).toBe(true)
    expect(a).not.toContain('s3cret')
    expect(box.decrypt(a)).toBe('s3cret pass')
    expect(box.decrypt(box.encrypt(''))).toBe('')
    const parts = a.split(':')
    const ct = Buffer.from(parts[3], 'base64')
    ct[0] ^= 1
    expect(() => box.decrypt([parts[0], parts[1], parts[2], ct.toString('base64')].join(':'))).toThrow()
    expect(() => createSecretBox(Buffer.alloc(32, 8)).decrypt(a)).toThrow(/cannot be decrypted/)
    expect(() => box.decrypt('garbage')).toThrow()
  })

  it('creates the key file once with mode 0600 and honours APPBUILDER_SECRET_KEY', () => {
    const k1 = loadSecretKey(tmp, {})
    const k2 = loadSecretKey(tmp, {})
    expect(k1.equals(k2)).toBe(true)
    const file = path.join(tmp, '.secret-key')
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    const hex = 'ab'.repeat(32)
    expect(loadSecretKey(tmp, { APPBUILDER_SECRET_KEY: hex }).toString('hex')).toBe(hex)
    expect(() => loadSecretKey(tmp, { APPBUILDER_SECRET_KEY: 'short' })).toThrow()
  })
})

/* ------------------------------------------------------------------ passwords */

describe('password hashing', () => {
  it('hashes with scrypt and verifies in constant time', async () => {
    const h = await hashPassword('correct horse battery')
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/)
    expect(await verifyPassword('correct horse battery', h)).toBe(true)
    expect(await verifyPassword('correct horse batterz', h)).toBe(false)
    expect(await verifyPassword('x', null)).toBe(false)
    expect(await verifyPassword('x', 'md5$abc')).toBe(false)
    expect(h).not.toBe(await hashPassword('correct horse battery'))
  })

  it('enforces the policy', () => {
    expect(() => checkPasswordPolicy('short', 'a@b.c')).toThrow(HttpError)
    expect(() => checkPasswordPolicy('me@example.com', 'ME@example.com')).toThrow(/same as the email/)
    expect(checkPasswordPolicy('long enough!', 'a@b.c')).toBe('long enough!')
    expect(() => checkPasswordPolicy(undefined)).toThrow(HttpError)
  })

  it('throttles after 8 failures in the window', () => {
    const t = new LoginThrottle()
    for (let i = 0; i < 7; i++) t.fail('k', 1000)
    expect(t.blocked('k', 1000)).toBe(false)
    t.fail('k', 1000)
    expect(t.blocked('k', 1000)).toBe(true)
    expect(t.blocked('k', 1000 + 15 * 60 * 1000 + 1)).toBe(false)
    t.fail('j', 0)
    t.reset('j')
    expect(t.blocked('j', 0)).toBe(false)
  })
})

/* ------------------------------------------------------------------ security engine */

const table: TableDef = {
  id: 'tbl_orders', name: 'Orders', displayName: 'Orders', primaryColumn: 'Title', createdOn: '', modifiedOn: '',
  columns: [
    { name: 'id', displayName: 'Id', type: 'text', system: true },
    { name: 'owner', displayName: 'Owner', type: 'text', system: true },
    { name: 'Title', displayName: 'Title', type: 'text' },
    { name: 'Region', displayName: 'Region', type: 'text' },
    { name: 'Salary', displayName: 'Salary', type: 'currency' },
    { name: 'Notes', displayName: 'Notes', type: 'multiline' },
    { name: 'Email', displayName: 'Email', type: 'email' },
  ],
}
const other: TableDef = { ...table, id: 'tbl_other', name: 'Other', columns: table.columns.slice(0, 3) }
const user: UserDef = { id: 'user_1', name: 'U', email: 'u@x.io', roleIds: [] }
const role = (id: string, p: Partial<RoleDef['privileges'][number]> | null, extra: Partial<RoleDef> = {}): RoleDef => ({
  id, name: id, apps: [], privileges: p ? [{ table: table.id, create: false, read: 'none', update: 'none', delete: 'none', ...p }] : [], ...extra,
})
const ctxFor = (roles: RoleDef[]) => buildUserContext({ ...user, roleIds: roles.map((r) => r.id) }, roles, [table, other])

describe('security engine', () => {
  it('no role -> const false, no create, all columns hidden except id', () => {
    const c = ctxFor([])
    expect(c.rowPredicate(table, 'read')).toEqual({ const: false })
    expect(c.rowPredicate(table, 'update')).toEqual({ const: false })
    expect(c.canCreate(table)).toBe(false)
    expect(c.columnAccess(table, 'Title')).toBe('none')
    expect(c.columnAccess(table, 'id')).toBe('read')
    expect(c.visibleDef(table).columns.map((x) => x.name)).toEqual(['id'])
    expect(c.privileges.isAdmin).toBe(false)
    expect(c.privileges.isMaker).toBe(false)
  })

  it('admin bypass: everything, all columns update (system read)', () => {
    const c = ctxFor([role('r_admin', null, { isAdmin: true })])
    expect(c.rowPredicate(table, 'delete')).toEqual({ const: true })
    expect(c.canCreate(table)).toBe(true)
    expect(c.columnAccess(table, 'Salary')).toBe('update')
    expect(c.columnAccess(table, 'owner')).toBe('read')
    expect(c.visibleDef(table)).toBe(table)
    expect(c.privileges).toMatchObject({ isAdmin: true, isMaker: true, apps: 'all' })
    expect(c.canRunApp('anything')).toBe(true)
  })

  it('own scope and union of roles (max scope, OR of predicates)', () => {
    const own = role('r_own', { read: 'own', update: 'own', create: true })
    const c = ctxFor([own])
    expect(c.rowPredicate(table, 'read')).toEqual({ col: 'owner', op: 'eq', value: 'user_1' })
    expect(c.rowPredicate(table, 'delete')).toEqual({ const: false })
    expect(c.canCreate(table)).toBe(true)
    const all = role('r_all', { read: 'all' })
    const both = ctxFor([own, all])
    expect(both.rowPredicate(table, 'read')).toEqual({ const: true })
    expect(both.rowPredicate(table, 'update')).toEqual({ col: 'owner', op: 'eq', value: 'user_1' })
    expect(both.privileges.tables[table.id]).toMatchObject({ read: 'all', update: 'own', delete: 'none', create: true })
  })

  it('rowFilter with @me / @myEmail tokens, ANDed, ORed across roles', () => {
    const west = role('r_west', { read: 'all', rowFilter: [{ column: 'Region', op: 'eq', value: 'West' }, { column: 'Email', op: 'eq', value: '@myEmail' }] })
    const mine = role('r_mine', { read: 'own', rowFilter: [{ column: 'owner', op: 'eq', value: '@me' }] })
    const c = ctxFor([west, mine])
    expect(c.rowPredicate(table, 'read')).toEqual({
      or: [
        { and: [{ col: 'Region', op: 'eq', value: 'West' }, { col: 'Email', op: 'eq', value: 'u@x.io' }] },
        { and: [{ col: 'owner', op: 'eq', value: 'user_1' }, { col: 'owner', op: 'eq', value: 'user_1' }] },
      ],
    })
    expect(c.privileges.tables[table.id].filtered).toBe(true)
    expect(rowFilterCondition([{ column: 'Region', op: 'in', value: ['@me', 'East'] }], table, user)).toEqual({ col: 'Region', op: 'in', value: ['user_1', 'East'] })
  })

  it("create predicate (WITH CHECK): OR over roles granting create of their rowFilter, tokens resolved, no owner term", () => {
    const sales = role('r_sales', { create: true, read: 'all', rowFilter: [{ column: 'Region', op: 'eq', value: 'West' }] })
    const mine = role('r_mine', { create: true, read: 'own', rowFilter: [{ column: 'Email', op: 'eq', value: '@myEmail' }] })
    const reader = role('r_read', { create: false, read: 'all' })
    expect(ctxFor([reader]).rowPredicate(table, 'create')).toEqual({ const: false })
    expect(ctxFor([sales]).rowPredicate(table, 'create')).toEqual({ col: 'Region', op: 'eq', value: 'West' })
    const both = ctxFor([sales, mine, reader]).rowPredicate(table, 'create')
    expect(both).toEqual({ or: [{ col: 'Region', op: 'eq', value: 'West' }, { col: 'Email', op: 'eq', value: 'u@x.io' }] })
    expect(evaluateCondition(both, { id: 'x', Region: 'west', Email: null })).toBe(true)
    expect(evaluateCondition(both, { id: 'x', Region: 'East', Email: 'U@x.io' })).toBe(true)
    expect(evaluateCondition(both, { id: 'x', Region: 'East', Email: 'other@x.io' })).toBe(false)
    expect(ctxFor([role('r_plain', { create: true, read: 'own' })]).rowPredicate(table, 'create')).toEqual({ const: true })
    expect(ctxFor([role('r_admin', null, { isAdmin: true })]).rowPredicate(table, 'create')).toEqual({ const: true })
  })

  it('row ids are time-ordered UUIDv7, monotonic within one millisecond', () => {
    const ids = Array.from({ length: 5000 }, () => rowUid(1_700_000_000_000))
    expect(ids.every((x) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x))).toBe(true)
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
    expect(rowUid(1_700_000_000_000 - 5) > ids[ids.length - 1]).toBe(true) // a clock step back never goes backwards
  })

  it('a rowFilter on a missing column makes that role grant nothing', () => {
    const broken = role('r_broken', { read: 'all', rowFilter: [{ column: 'Gone', op: 'eq', value: 1 }] })
    expect(ctxFor([broken]).rowPredicate(table, 'read')).toEqual({ const: false })
    const ok = role('r_ok', { read: 'own' })
    expect(ctxFor([broken, ok]).rowPredicate(table, 'read')).toEqual({ col: 'owner', op: 'eq', value: 'user_1' })
  })

  it('CLS none/read/update: max over granting roles, missing = update, system never writable', () => {
    const a = role('r_a', { read: 'all', update: 'all', columns: { Salary: 'none', Notes: 'read' } })
    const c = ctxFor([a])
    expect(c.columnAccess(table, 'Salary')).toBe('none')
    expect(c.columnAccess(table, 'Notes')).toBe('read')
    expect(c.columnAccess(table, 'Title')).toBe('update')
    expect(c.columnAccess(table, 'owner')).toBe('read')
    expect(c.visibleDef(table).columns.map((x) => x.name)).not.toContain('Salary')
    expect(c.privileges.tables[table.id].columns).toEqual({ id: 'read', owner: 'read', Salary: 'none', Notes: 'read' })
    // a second role granting read with Salary readable widens it
    const b = role('r_b', { read: 'own', columns: { Salary: 'read', Notes: 'none' } })
    const cb = ctxFor([a, b])
    expect(cb.columnAccess(table, 'Salary')).toBe('read')
    expect(cb.columnAccess(table, 'Notes')).toBe('read')
    // roles without read do not contribute to CLS when another role grants read
    const noRead = role('r_c', { create: true, columns: {} })
    expect(ctxFor([a, noRead]).columnAccess(table, 'Salary')).toBe('none')
    // hidden primary column -> visibleDef picks another
    const hideTitle = role('r_d', { read: 'all', columns: { Title: 'none' } })
    expect(ctxFor([hideTitle]).visibleDef(table).primaryColumn).toBe('Region')
  })

  it('maker flag and app access union', () => {
    const r1 = role('r1', null, { isMaker: true, apps: ['app_a'] } as Partial<RoleDef>)
    const r2 = role('r2', null, { apps: ['app_b'] })
    const c = ctxFor([r1, r2])
    expect(c.privileges.isMaker).toBe(true)
    expect(c.privileges.isAdmin).toBe(false)
    expect(c.canRunApp('app_a')).toBe(true)
    expect(c.canRunApp('app_b')).toBe(true)
    expect(c.canRunApp('app_c')).toBe(false)
    expect(c.session().user.id).toBe('user_1')
  })
})

/* ------------------------------------------------------------------ values */

describe('value coercion', () => {
  const col = (type: TableDef['columns'][number]['type'], extra = {}) => ({ name: 'c', displayName: 'C', type, ...extra })
  it('coerces JSON in and formats out', () => {
    expect(coerceIn(col('number'), '42')).toBe(42)
    expect(() => coerceIn(col('number'), '4.2')).toThrow(HttpError)
    expect(coerceIn(col('boolean'), 'yes')).toBe(true)
    expect(coerceIn(col('text'), '   ')).toBe(null)
    const d = coerceIn(col('date'), '2024-02-29') as Date
    expect(d.toISOString()).toBe('2024-02-29T00:00:00.000Z')
    expect(() => coerceIn(col('date'), '2023-02-29')).toThrow()
    expect(cellOut(col('date'), d)).toBe('2024-02-29')
    expect(cellOut(col('datetime'), new Date('2024-01-02T03:04:05.006Z'))).toBe('2024-01-02T03:04:05.006Z')
    expect(cellOut(col('boolean'), 1)).toBe(true)
    expect(cellOut(col('currency'), '12.3400')).toBe(12.34)
    expect(() => coerceIn(col('choice', { choices: ['A', 'B'] }), 'c')).toThrow(/not one of/)
    expect(coerceIn(col('choice', { choices: ['A', 'B'] }), 'b')).toBe('B')
    expect(coerceIn(col('file', { multiple: true }), '["att_1","att_2"]')).toBe('["att_1","att_2"]')
    expect(() => coerceIn(col('file'), '["att_1","att_2"]')).toThrow(/single/)
  })
  it('static path guard', () => {
    expect(safeStaticPath('assets/app.js')).toBe(true)
    expect(safeStaticPath('../etc/passwd')).toBe(false)
    expect(safeStaticPath('a/.env')).toBe(false)
    expect(safeStaticPath('a\\b')).toBe(false)
  })
})

/* ------------------------------------------------------------------ router guards */

describe('router guards', () => {
  let server: http.Server
  let base = ''
  const fake = { ready: () => false } as unknown as Services

  beforeAll(async () => {
    const router = createRouter(fake)
    router.add('GET', '/ping', () => ({ pong: true }), { auth: 'none' })
    router.add('POST', '/echo', (ctx) => ({ got: ctx.body }), { auth: 'none' })
    router.add('POST', '/upload', (ctx) => ({ size: ctx.rawBody?.length }), { auth: 'none', raw: true, maxBodyMB: 1 })
    router.add('GET', '/api/v1/items/:id', (ctx) => ({ id: ctx.params.id, kind: 'param' }), { auth: 'none' })
    router.add('GET', '/items/special', () => ({ kind: 'literal' }), { auth: 'none' })
    router.add('GET', '/private', () => ({ secret: 1 }), { auth: 'user' })
    router.add('POST', '/bigjson', (ctx) => ({ len: String((ctx.body as { s: string }).s).length }), { auth: 'none', maxBodyMB: 5 })
    router.add('POST', '/stream', async (ctx) => ({ size: (await ctx.readBody!(1024 * 1024)).length }), { auth: 'none', raw: true, streamBody: true, maxBodyMB: 4 })
    router.add('POST', '/stream-deny', () => {
      throw new HttpError(403, 'denied', 'No.')
    }, { auth: 'none', raw: true, streamBody: true, maxBodyMB: 4 })
    router.add('GET', '/boom', () => {
      throw new Error('select * from secret_table where password = hunter2')
    }, { auth: 'none' })
    router.add('GET', '/teapot', () => {
      throw new HttpError(409, 'conflict', 'Already there', 'name')
    }, { auth: 'none' })
    server = http.createServer((req, res) => {
      router.handle(req, res).then((handled) => {
        if (!handled) res.writeHead(418).end()
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  const post = (p: string, body: string | Buffer, headers: Record<string, string> = {}) =>
    fetch(base + p, { method: 'POST', body: typeof body === 'string' ? body : new Uint8Array(body), headers: { 'Content-Type': 'application/json', ...headers } })

  it('serves JSON with security headers', async () => {
    const r = await fetch(base + '/api/v1/ping')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ pong: true })
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('referrer-policy')).toBe('same-origin')
    expect(r.headers.get('cache-control')).toBe('no-store')
  })

  it('requires the CSRF header on non-GET', async () => {
    const r = await post('/api/v1/echo', '{"a":1}')
    expect(r.status).toBe(403)
    expect((await r.json()).error.code).toBe('denied')
    const ok = await post('/api/v1/echo', '{"a":1}', { 'X-Appbuilder': '1' })
    expect(await ok.json()).toEqual({ got: { a: 1 } })
  })

  it('rejects foreign Host and cross-origin Origin', async () => {
    const status = await new Promise<number>((resolve) => {
      http.get(`${base}/api/v1/ping`, { headers: { Host: 'evil.example.com' } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
    })
    expect(status).toBe(403)
    expect((await fetch(base + '/api/v1/ping', { headers: { Origin: 'https://evil.example.com' } })).status).toBe(403)
    expect((await post('/api/v1/echo', '{}', { 'X-Appbuilder': '1', Origin: 'http://localhost:9999' })).status).toBe(403)
    expect((await post('/api/v1/echo', '{}', { 'X-Appbuilder': '1', Origin: base })).status).toBe(200)
    expect((await fetch(base + '/api/v1/ping', { headers: { Origin: 'null' } })).status).toBe(403)
    const req = { headers: { host: 'localhost:5174', origin: 'http://localhost:5174' } } as unknown as http.IncomingMessage
    expect(originProblem(req)).toBeNull()
  })

  it('enforces the JSON and raw body limits and JSON validity', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 10, 32)
    expect((await post('/api/v1/echo', big, { 'X-Appbuilder': '1' })).status).toBe(413)
    expect((await post('/api/v1/echo', '{nope', { 'X-Appbuilder': '1' })).status).toBe(422)
    expect((await post('/api/v1/echo', 'a=1', { 'X-Appbuilder': '1', 'Content-Type': 'text/plain' })).status).toBe(415)
    const raw = await post('/api/v1/upload', Buffer.alloc(1000, 1), { 'X-Appbuilder': '1', 'Content-Type': 'application/octet-stream' })
    expect(await raw.json()).toEqual({ size: 1000 })
    expect((await post('/api/v1/upload', Buffer.alloc(1024 * 1024 + 1, 1), { 'X-Appbuilder': '1', 'Content-Type': 'application/octet-stream' })).status).toBe(413)
  })

  it('honours a route maxBodyMB for JSON bodies (not just the 2 MB default)', async () => {
    const s = 'x'.repeat(3 * 1024 * 1024)
    const r = await post('/api/v1/bigjson', JSON.stringify({ s }), { 'X-Appbuilder': '1' })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ len: s.length })
    const over = await post('/api/v1/bigjson', JSON.stringify({ s: 'x'.repeat(5 * 1024 * 1024) }), { 'X-Appbuilder': '1' })
    expect(over.status).toBe(413)
    expect((await post('/api/v1/echo', JSON.stringify({ s }), { 'X-Appbuilder': '1' })).status).toBe(413) // default stays 2 MB
  })

  /** raw http request that keeps sending until the response arrives; resolves with status and bytes sent by then */
  function streamUpload(p: string, total: number, headers: Record<string, string> = {}): Promise<{ status: number; body: string; sentBeforeResponse: number }> {
    return new Promise((resolve, reject) => {
      const u = new URL(base + p)
      let sent = 0
      let done = false
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'X-Appbuilder': '1', 'Content-Type': 'application/octet-stream', ...headers } }, (res) => {
        done = true
        const at = sent
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, sentBeforeResponse: at }))
        res.on('error', reject)
      })
      req.on('error', (e) => (done ? undefined : reject(e)))
      const chunk = Buffer.alloc(64 * 1024, 1)
      const pump = () => {
        if (done || sent >= total) {
          if (!done) req.end()
          return
        }
        sent += chunk.length
        req.write(chunk, () => setTimeout(pump, 2))
      }
      if (headers['Content-Length'] === undefined) pump()
      else req.flushHeaders()
    })
  }

  it('streamBody routes: refuse a declared Content-Length over the limit, cut a chunked body off at the limit', async () => {
    const small = await post('/api/v1/stream', Buffer.alloc(1000, 1), { 'X-Appbuilder': '1', 'Content-Type': 'application/octet-stream' })
    expect(await small.json()).toEqual({ size: 1000 })
    // declared too large: answered before any byte of the body is sent
    const declared = await streamUpload('/api/v1/stream', 0, { 'Content-Length': String(2 * 1024 * 1024) })
    expect(declared.status).toBe(413)
    expect(JSON.parse(declared.body).error.code).toBe('invalid')
    // chunked 8 MB upload against a 1 MB handler limit: 413 arrives while the client is still sending
    const chunked = await streamUpload('/api/v1/stream', 8 * 1024 * 1024)
    expect(chunked.status).toBe(413)
    expect(chunked.sentBeforeResponse).toBeLessThan(8 * 1024 * 1024)
    // a handler that refuses before reading: answered without draining the upload
    const denied = await streamUpload('/api/v1/stream-deny', 8 * 1024 * 1024)
    expect(denied.status).toBe(403)
    expect(denied.sentBeforeResponse).toBeLessThan(8 * 1024 * 1024)
  })

  it('lingerClose: the answer arrives while the client keeps sending; the socket is dropped at the byte cap or the time cap', async () => {
    const srv = http.createServer((req, res) => {
      const big = req.url === '/bytes'
      lingerClose(req, res, big ? { ms: 30_000, bytes: 256 * 1024 } : { ms: 300, bytes: 1 << 30 })
      res.writeHead(413, { 'Content-Type': 'text/plain', 'Content-Length': '3' }).end('big')
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as AddressInfo).port
    /** sends the head of a chunked POST, then (keepSending) 64 KB chunks until the server closes the socket */
    const run = (p: string, keepSending: boolean) => new Promise<{ answer: string; sent: number; ms: number }>((resolve) => {
      const started = Date.now()
      const s = net.connect(port, '127.0.0.1')
      let answer = ''
      let sent = 0
      let open = true
      const chunk = Buffer.concat([Buffer.from('10000\r\n'), Buffer.alloc(0x10000, 1), Buffer.from('\r\n')])
      const pump = () => {
        if (!open) return
        sent += 0x10000
        s.write(chunk, () => setTimeout(pump, 1))
      }
      s.on('connect', () => {
        s.write(`POST ${p} HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n`)
        if (keepSending) pump()
      })
      s.on('data', (c) => (answer += c))
      s.on('error', () => {})
      s.on('close', () => {
        open = false
        resolve({ answer, sent, ms: Date.now() - started })
      })
    })
    try {
      const bytes = await run('/bytes', true)
      expect(bytes.answer).toMatch(/^HTTP\/1\.1 413 /)
      expect(bytes.answer.endsWith('big')).toBe(true)
      expect(bytes.sent).toBeGreaterThanOrEqual(256 * 1024)
      expect(bytes.sent).toBeLessThan(8 * 1024 * 1024) // far below what 30 s of sending would be
      expect(bytes.ms).toBeLessThan(10_000)
      const idle = await run('/time', false)
      expect(idle.answer.endsWith('big')).toBe(true)
      expect(idle.ms).toBeGreaterThanOrEqual(250)
      expect(idle.ms).toBeLessThan(5000)
    } finally {
      srv.closeAllConnections()
      await new Promise<void>((r) => srv.close(() => r()))
    }
  })

  it('matches params, prefers literals, answers 404/405, 503 for auth routes without a database', async () => {
    expect(await (await fetch(base + '/api/v1/items/abc%20d')).json()).toEqual({ id: 'abc d', kind: 'param' })
    expect(await (await fetch(base + '/api/v1/items/special')).json()).toEqual({ kind: 'literal' })
    expect((await fetch(base + '/api/v1/nope')).status).toBe(404)
    expect((await fetch(base + '/api/fs/health')).status).toBe(404)
    const m = await fetch(base + '/api/v1/ping', { method: 'DELETE', headers: { 'X-Appbuilder': '1' } })
    expect(m.status).toBe(405)
    expect((await m.json()).error.code).toBe('method_not_allowed')
    expect((await fetch(base + '/api/v1/private')).status).toBe(503)
    expect((await fetch(base + '/index.html')).status).toBe(418) // not an API path: left to the caller
  })

  it('maps errors without leaking internals', async () => {
    const r = await fetch(base + '/api/v1/boom')
    expect(r.status).toBe(500)
    const text = await r.text()
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('select')
    expect(JSON.parse(text)).toEqual({ error: { code: 'storage', message: 'Internal server error.', requestId: expect.any(String) } })
    const t = await fetch(base + '/api/v1/teapot')
    expect(t.status).toBe(409)
    expect(await t.json()).toEqual({ error: { code: 'conflict', message: 'Already there', field: 'name', requestId: expect.any(String) } })
  })
})
