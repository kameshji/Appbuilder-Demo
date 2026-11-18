/**
 * Regression tests (docs review fixes) over HTTP against the sandbox MariaDB/MySQL:
 *   APPBUILDER_TEST_DB=mysql://abdev:abdev-sandbox-only@127.0.0.1:3306/appbuilder_test npx vitest run server/core
 * body limits per route, RLS WITH CHECK on create/update, all-or-nothing deletes and imports, attachment size limits,
 * insertion order of reads, distinct throttle codes, lowercase emails (migration v2). Creates and drops its own database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import mysql from 'mysql2/promise'
import { createApp } from './app.ts'
import type { AppServer } from './app.ts'
import { hashPassword } from './password.ts'
import { setQuiet } from './util.ts'
import { DDL, normaliseUserEmails } from './meta-store.ts'
import type { RoleDef, TableDef } from '../../src/platform/contracts.ts'

setQuiet(true)

const URL_ENV = process.env.APPBUILDER_TEST_DB
const parsed = URL_ENV ? new URL(URL_ENV) : null
const conn = parsed
  ? { host: parsed.hostname, port: Number(parsed.port) || 3306, user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) }
  : null
const dbName = `appbuilder_test_fx_${randomBytes(4).toString('hex')}`
if (!URL_ENV) process.stderr.write('[server/core fixes integration] skipped: set APPBUILDER_TEST_DB to run\n')

class Client {
  cookie = ''
  base: string
  constructor(base: string) {
    this.base = base
  }
  async req(method: string, p: string, body?: unknown, raw?: { data: Buffer; type: string }) {
    const headers: Record<string, string> = { 'X-Appbuilder': '1' }
    if (this.cookie) headers.Cookie = this.cookie
    let payload: string | Uint8Array<ArrayBuffer> | undefined
    if (raw) {
      headers['Content-Type'] = raw.type
      payload = new Uint8Array(raw.data)
    } else if (body !== undefined) {
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
}

const sys = [
  { name: 'id', displayName: 'Id', type: 'text', system: true },
  { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true },
  { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime', system: true },
  { name: 'createdBy', displayName: 'Created by', type: 'text', system: true },
  { name: 'owner', displayName: 'Owner', type: 'text', system: true },
] as TableDef['columns']

describe.skipIf(!URL_ENV)('docs review fixes (MariaDB/MySQL)', () => {
  let app: AppServer
  let server: http.Server
  let tmp = ''
  let base = ''
  let A: Client
  const login = async (email: string, password: string) => {
    const c = new Client(base)
    const r = await c.post('/auth/login', { email, password })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return c
  }
  const newTable = async (name: string, columns: TableDef['columns']): Promise<TableDef> => {
    const def: TableDef = {
      id: `tbl_${name.toLowerCase()}`, name, displayName: name, primaryColumn: columns[0].name, connectionId: 'conn_default', source: `t_fx_${name.toLowerCase()}`,
      createdOn: new Date().toISOString(), modifiedOn: new Date().toISOString(), columns: [...sys, ...columns],
    }
    await app.services.meta.tables.upsert(def)
    await (await app.services.connections.get('conn_default')).createTable(def)
    app.services.security.invalidate()
    return def
  }
  const addUser = async (id: string, roles: RoleDef[]) => {
    for (const r of roles) await app.services.meta.roles.upsert(r)
    await app.services.meta.users.insert({ id, name: id, email: `${id}@example.com`, roleIds: roles.map((r) => r.id), status: 'active', passwordHash: await hashPassword(`${id}-password-1`) })
    app.services.security.invalidate()
    return login(`${id}@example.com`, `${id}-password-1`)
  }
  const count = async (def: TableDef) => (await app.services.data.query(null, def, { count: true, top: 0 })).total

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-fx-'))
    app = await createApp({ env: {}, config: { workspaceDir: tmp }, printSetupCode: false })
    server = http.createServer((req, res) => {
      app.handle(req, res).then((h) => {
        if (!h) res.writeHead(404).end()
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    A = new Client(base)
    expect((await A.post('/setup/database', { setupCode: app.services.setupCode.current() ?? '', host: conn!.host, port: conn!.port, database: dbName, user: conn!.user, password: conn!.password, createDatabase: true })).status).toBe(200)
    expect((await A.post('/setup/admin', { setupCode: app.services.setupCode.current() ?? '', name: 'Ada', email: 'ada@example.com', password: 'admin-password-1' })).status).toBe(200)
  }, 60000)

  afterAll(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    await app?.close()
    if (conn) {
      const c = await mysql.createConnection(conn)
      await c.query(`DROP DATABASE IF EXISTS \`${dbName}\``)
      await c.end()
    }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }, 60000)

  it('JSON routes honour their maxBodyMB (apps/import, tables/from-csv, solutions/import are not capped at 2 MB)', async () => {
    const pad = 'x'.repeat(3 * 1024 * 1024)
    const app1 = await A.post('/apps/import', { yaml: `# ${pad}\nkind: nope\n` })
    expect(app1.status).not.toBe(413)
    expect(app1.status).toBe(422)
    const sol = await A.post('/solutions/import', { yaml: `# ${pad}\nkind: nope\n` })
    expect(sol.status).not.toBe(413)
    const rows = Array.from({ length: 60000 }, (_, i) => `Row ${String(i).padStart(6, '0')},${'y'.repeat(40)}`)
    const csv = `Name,Pad\n${rows.join('\n')}`
    expect(csv.length).toBeGreaterThan(2 * 1024 * 1024)
    const t = await A.post('/tables/from-csv', { displayName: 'Big csv', csv })
    expect(t.status, JSON.stringify(t.data).slice(0, 300)).toBe(200)
    // rows read back without a sort come in CSV (insertion) order
    const q = await A.post(`/data/${t.data.id}/query`, { top: 5, skip: 59995 })
    expect(q.data.rows.map((r: any) => r.Name)).toEqual(['Row 059995', 'Row 059996', 'Row 059997', 'Row 059998', 'Row 059999'])
    const first = await A.post(`/data/${t.data.id}/query`, { top: 3 })
    expect(first.data.rows.map((r: any) => r.Name)).toEqual(['Row 000000', 'Row 000001', 'Row 000002'])
    expect((await A.post('/tables/from-csv', { displayName: 'Too big', csv: 'a\n' + 'z'.repeat(26 * 1024 * 1024) })).status).toBe(413)
  }, 120000)

  it('reads without a sort return insertion order after from-csv and CSV import; explicit sorts still win', async () => {
    const names = ['Zulu', 'Alpha', 'Mike', 'Bravo', 'Yankee', 'Charlie', 'Xray', 'Delta']
    const t = await A.post('/tables/from-csv', { displayName: 'Order check', csv: `Name,N\n${names.map((n, i) => `${n},${i}`).join('\n')}` })
    expect(t.status).toBe(200)
    const all = await A.post(`/data/${t.data.id}/query`, {})
    expect(all.data.rows.map((r: any) => r.Name)).toEqual(names)
    const more = ['Echo', 'Whiskey', 'Foxtrot']
    expect((await A.post(`/data/${t.data.id}/import`, { csv: `Name,N\n${more.map((n, i) => `${n},${10 + i}`).join('\n')}`, mode: 'append' })).data.imported).toBe(3)
    const after = await A.post(`/data/${t.data.id}/query`, {})
    expect(after.data.rows.map((r: any) => r.Name)).toEqual([...names, ...more])
    const sorted = await A.post(`/data/${t.data.id}/query`, { orderBy: [{ col: 'Name', dir: 'asc' }] })
    expect(sorted.data.rows.map((r: any) => r.Name)).toEqual([...names, ...more].sort())
    const csv = await A.get(`/tables/${t.data.id}/csv`)
    expect(String(csv.data).split('\r\n').slice(1, 4).map((l) => l.split(',').at(-2))).toEqual(['Zulu', 'Alpha', 'Mike'])
  }, 60000)

  it('RLS WITH CHECK: Sales (rowFilter Status = Customer) can only create and keep Customer rows', async () => {
    const def = await newTable('Leads', [
      { name: 'Name', displayName: 'Name', type: 'text' },
      { name: 'Status', displayName: 'Status', type: 'choice', choices: ['Lead', 'Customer'] },
      { name: 'RepEmail', displayName: 'Rep email', type: 'email' },
    ])
    const sales = await addUser('sales1', [{
      id: 'role_sales', name: 'Sales', apps: 'all',
      privileges: [{ table: def.id, create: true, read: 'all', update: 'all', delete: 'none', rowFilter: [{ column: 'Status', op: 'eq', value: 'Customer' }] }],
    }])
    const lead = await A.post('/data/Leads/rows', { values: { Name: 'Admin lead', Status: 'Lead' } }) // admins bypass
    expect(lead.status).toBe(200)
    const ok = await sales.post('/data/Leads/rows', { values: { Name: 'Acme', Status: 'Customer' } })
    expect(ok.status, JSON.stringify(ok.data)).toBe(200)
    const no = await sales.post('/data/Leads/rows', { values: { Name: 'Sneaky', Status: 'Lead' } })
    expect(no.status).toBe(403)
    expect(no.data.error.code).toBe('denied')
    expect((await sales.post('/data/Leads/rows', { values: { Name: 'Blank' } })).status).toBe(403)
    expect((await sales.post('/data/Leads/query', {})).data.rows.map((r: any) => r.Name)).toEqual(['Acme'])
    // update: allowed while the row keeps matching, refused (and not written) when it would leave the filter
    expect((await sales.patch(`/data/Leads/rows/${ok.data.row.id}`, { changes: { Name: 'Acme Ltd' } })).status).toBe(200)
    const out = await sales.patch(`/data/Leads/rows/${ok.data.row.id}`, { changes: { Status: 'Lead' } })
    expect(out.status).toBe(403)
    expect((await app.services.data.query(null, def, { where: { col: 'id', op: 'eq', value: ok.data.row.id } })).rows[0]).toMatchObject({ Name: 'Acme Ltd', Status: 'Customer' })
    expect((await sales.patch(`/data/Leads/rows/${lead.data.row.id}`, { changes: { Status: 'Customer' } })).status).toBe(404) // not visible
    // CSV import goes through the same check (and imports nothing when one row fails)
    const imp = await sales.post('/data/Leads/import', { csv: 'Name,Status\nGood,Customer\nBad,Lead', mode: 'append' })
    expect(imp.status).toBe(403)
    expect(imp.data.error.message).toMatch(/^Row 2:/)
    expect(await count(def)).toBe(2)

    // @myEmail in a create filter; a separate update grant lets a row leave the read filter (it then disappears)
    const rep = await addUser('rep1', [
      { id: 'role_rep_read', name: 'Rep read', apps: 'all', privileges: [{ table: def.id, create: true, read: 'all', update: 'none', delete: 'none', rowFilter: [{ column: 'RepEmail', op: 'eq', value: '@myEmail' }] }] },
      { id: 'role_rep_upd', name: 'Rep update', apps: 'all', privileges: [{ table: def.id, create: false, read: 'none', update: 'all', delete: 'none' }] },
    ])
    expect((await rep.post('/data/Leads/rows', { values: { Name: 'Other rep', RepEmail: 'someone@example.com' } })).status).toBe(403)
    const mine = await rep.post('/data/Leads/rows', { values: { Name: 'Mine', RepEmail: 'REP1@example.com' } })
    expect(mine.status).toBe(200)
    const moved = await rep.patch(`/data/Leads/rows/${mine.data.row.id}`, { changes: { RepEmail: 'someone@example.com' } })
    expect(moved.status, JSON.stringify(moved.data)).toBe(200)
    expect((await rep.post('/data/Leads/query', {})).data.rows).toEqual([])
  }, 60000)

  it('multi-row delete is all or nothing: a denied row in a later chunk deletes nothing', async () => {
    const def = await newTable('Bulk', [{ name: 'Name', displayName: 'Name', type: 'text' }])
    const user = await addUser('bulk1', [{ id: 'role_bulk', name: 'Bulk', apps: 'all', privileges: [{ table: def.id, create: true, read: 'all', update: 'own', delete: 'own' }] }])
    const ids: string[] = []
    for (let i = 0; i < 520; i++) ids.push(String((await app.services.data.insert(null, def, { Name: `r${i}`, owner: 'bulk1', createdBy: 'bulk1' })).id))
    const foreign = String((await app.services.data.insert(null, def, { Name: 'admin row', owner: 'someone_else' })).id)
    const r = await user.post('/data/Bulk/delete', { ids: [...ids, foreign] })
    expect(r.status).toBe(403)
    expect(r.data.error.message).toContain('nothing was deleted')
    expect(await count(def)).toBe(521)
    const ok = await user.post('/data/Bulk/delete', { ids })
    expect(ok.data).toEqual({ deleted: 520 })
    expect(await count(def)).toBe(1)
  }, 120000)

  it('replace import runs delete + inserts in one transaction; a refused row changes nothing', async () => {
    const def = await newTable('Repl', [{ name: 'Code', displayName: 'Code', type: 'text', unique: true }, { name: 'Qty', displayName: 'Qty', type: 'number' }])
    expect((await A.post('/data/Repl/import', { csv: 'Code,Qty\nA,1\nB,2\nC,3', mode: 'append' })).data.imported).toBe(3)
    // the replacement may reuse codes of the rows it replaces
    expect((await A.post('/data/Repl/import', { csv: 'Code,Qty\nC,30\nA,10', mode: 'replace' })).data.imported).toBe(2)
    expect((await A.post('/data/Repl/query', {})).data.rows.map((r: any) => [r.Code, r.Qty])).toEqual([['C', 30], ['A', 10]])
    // duplicate inside the batch, bad value: refused before anything is deleted
    const dup = await A.post('/data/Repl/import', { csv: 'Code,Qty\nX,1\nx,2', mode: 'replace' })
    expect(dup.status).toBe(409)
    expect(dup.data.error.message).toMatch(/^Row 2:.*nothing was imported/)
    expect((await A.post('/data/Repl/import', { csv: 'Code,Qty\nY,1\nZ,abc', mode: 'replace' })).status).toBe(422)
    expect((await A.post('/data/Repl/query', {})).data.rows.map((r: any) => r.Code)).toEqual(['C', 'A'])
    // a failure inside the write rolls the delete back (connector transaction)
    const connector = await app.services.connections.get('conn_default')
    expect(connector.capabilities.transactions).toBe(true)
    await expect(connector.transaction!(async (tx) => {
      await tx.delete(def, (await tx.select(def, { select: ['id'] })).rows.map((r) => String(r.id)))
      expect((await tx.select(def, {})).rows).toEqual([])
      await tx.insert(def, [{ id: '00000000-0000-7000-8000-000000000001', Code: 'NEW' }, { id: '00000000-0000-7000-8000-000000000002', Code: 'NEW' }])
    })).rejects.toMatchObject({ status: 409 })
    expect((await A.post('/data/Repl/query', {})).data.rows.map((r: any) => r.Code)).toEqual(['C', 'A'])
  }, 60000)

  it('attachments: column maxSizeMB is enforced from Content-Length and while streaming; route cap is 25 MB', async () => {
    const def = await newTable('Docs', [
      { name: 'Name', displayName: 'Name', type: 'text' },
      { name: 'Small', displayName: 'Small', type: 'file', maxSizeMB: 1 },
      { name: 'Any', displayName: 'Any', type: 'file' },
    ])
    const row = await A.post('/data/Docs/rows', { values: { Name: 'r' } })
    const q = (c: string) => `/api/v1/attachments?table=Docs&column=${c}&rowId=${row.data.row.id}&name=f.bin`
    const ok = await A.req('POST', q('Small').slice('/api/v1'.length), undefined, { data: Buffer.alloc(512 * 1024, 1), type: 'application/octet-stream' })
    expect(ok.status).toBe(200)
    const send = (p: string, opts: { declared?: number; stream?: number }) => new Promise<{ status: number; body: any; sent: number }>((resolve, reject) => {
      const u = new URL(base + p)
      const headers: Record<string, string> = { 'X-Appbuilder': '1', Cookie: A.cookie, 'Content-Type': 'application/octet-stream' }
      if (opts.declared !== undefined) headers['Content-Length'] = String(opts.declared)
      let sent = 0
      let done = false
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers }, (res) => {
        done = true
        const at = sent
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text), sent: at }))
      })
      // the server answers 413 and closes; a client still writing may see the reset before the response
      req.on('error', (e: NodeJS.ErrnoException) => (done ? undefined : (e.code === 'ECONNRESET' || e.code === 'EPIPE') && opts.stream ? resolve({ status: 413, body: null, sent }) : reject(e)))
      if (opts.declared !== undefined) {
        req.flushHeaders()
        return
      }
      const chunk = Buffer.alloc(64 * 1024, 2)
      const pump = () => {
        if (done) return
        if (sent >= (opts.stream ?? 0)) return void req.end()
        sent += chunk.length
        req.write(chunk, () => setTimeout(pump, 1))
      }
      pump()
    })
    const declared = await send(q('Small'), { declared: 2 * 1024 * 1024 })
    expect(declared.status).toBe(413)
    expect(declared.body.error).toMatchObject({ code: 'invalid', field: 'Small', message: 'The file is larger than 1 MB.' })
    expect(declared.sent).toBe(0)
    const streamed = await send(q('Small'), { stream: 30 * 1024 * 1024 })
    expect(streamed.status).toBe(413)
    expect(streamed.sent).toBeLessThan(30 * 1024 * 1024)
    expect((await send(q('Any'), { declared: 26 * 1024 * 1024 })).status).toBe(413)
    const files = await app.services.meta.attachments.forRows(def.id, [row.data.row.id])
    expect(files).toHaveLength(1) // only the accepted upload
  }, 120000)

  it('PUT /apps/:id answers 409 on a name collision (like PATCH)', async () => {
    const a = await A.post('/apps', { name: 'First', width: 1920, height: 1080 })
    const b = await A.post('/apps', { name: 'Second', width: 1920, height: 1080 })
    const got = await A.get(`/apps/${b.data.id}`)
    const r = await A.put(`/apps/${b.data.id}`, { definition: { ...got.data.definition, name: 'first' } })
    expect(r.status).toBe(409)
    expect(r.data.error.code).toBe('conflict')
    expect((await A.get(`/apps/${b.data.id}`)).data.meta.name).toBe('Second')
    expect(a.status).toBe(200)
  }, 60000)

  it('throttles answer 429 rate_limited; the password-change throttle is separate from the login throttle', async () => {
    const u = await addUser('thr1', [])
    for (let i = 0; i < 8; i++) expect((await u.post('/auth/password', { current: 'wrong-wrong', next: 'thr1-password-2' })).status).toBe(422)
    const blocked = await u.post('/auth/password', { current: 'thr1-password-1', next: 'thr1-password-2' })
    expect(blocked.status).toBe(429)
    expect(blocked.data.error.code).toBe('rate_limited')
    expect((await new Client(base).post('/auth/login', { email: 'thr1@example.com', password: 'thr1-password-1' })).status).toBe(200)
    const c = new Client(base)
    for (let i = 0; i < 8; i++) await c.post('/auth/login', { email: 'nobody-fx@example.com', password: 'nope-nope-nope' })
    const t = await c.post('/auth/login', { email: 'nobody-fx@example.com', password: 'nope-nope-nope' })
    expect(t.status).toBe(429)
    expect(t.data.error.code).toBe('rate_limited')
  }, 60000)

  it('migration v2 lowercases stored emails; the write path keeps them lowercase', async () => {
    const db = app.services.meta.db
    await db.exec("INSERT INTO ab_users (id, name, email, status, created_on) VALUES ('user_mixed', 'Mixed', ' Mixed.Case@Example.COM ', 'active', NOW(3))")
    await db.exec("UPDATE ab_meta SET v = '1' WHERE k = 'schemaVersion'")
    await app.services.meta.migrate()
    expect((await db.query<{ email: string }>("SELECT email FROM ab_users WHERE id = 'user_mixed'"))[0].email).toBe('mixed.case@example.com')
    expect((await db.query<{ v: string }>("SELECT v FROM ab_meta WHERE k = 'schemaVersion'"))[0].v).toBe('3')
    expect((await app.services.meta.users.byEmail('MIXED.case@example.com'))?.id).toBe('user_mixed')
    await app.services.meta.users.update('user_mixed', { email: 'New.Address@Example.com' })
    expect((await app.services.meta.users.get('user_mixed'))?.email).toBe('new.address@example.com')
    expect(await normaliseUserEmails(db)).toEqual({ changed: 0, skipped: [] })
    expect(DDL.some((d) => d.includes('ux_ab_users_email'))).toBe(true)
  }, 60000)
})
