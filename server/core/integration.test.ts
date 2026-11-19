/**
 * End-to-end over HTTP against the sandbox PostgreSQL:
 *   APPBUILDER_TEST_DB=postgres://abdev:abdev-sandbox-only@127.0.0.1:5433/appbuilder_test npx vitest run server/core
 * Creates a fresh database `appbuilder_test_s1_<random>` through the setup endpoint (the role needs CREATEDB) and drops
 * it after.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from './app.ts'
import type { AppServer } from './app.ts'
import { hashPassword } from './password.ts'
import { setQuiet } from './util.ts'
import { PG_URL, SKIP_PG, dropDatabase, pgServer, testDatabaseName } from './testdb.ts'
import type { RoleDef, TableDef } from '../../src/platform/contracts.ts'

setQuiet(true)

const URL_ENV = PG_URL
const conn = pgServer
const dbName = testDatabaseName('s1')

const SKIP_MESSAGE = SKIP_PG
if (!URL_ENV) process.stderr.write(`[server/core integration] ${SKIP_MESSAGE}\n`)

/** tiny client with a cookie jar per user */
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
    const res = await fetch(this.base + p, { method, headers, body: payload })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const [name, value] = pair.split('=')
      if (name === 'ab_session') this.cookie = value ? `ab_session=${value}` : ''
    }
    const type = res.headers.get('content-type') ?? ''
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer())
    return { status: res.status, data: data as any, headers: res.headers }
  }
  get = (p: string) => this.req('GET', p)
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {})
  patch = (p: string, b: unknown) => this.req('PATCH', p, b)
  del = (p: string) => this.req('DELETE', p)
}

describe.skipIf(!URL_ENV)(URL_ENV ? 'server core integration (PostgreSQL)' : `server core integration (PostgreSQL) ${SKIP_MESSAGE}`, () => {
  let app: AppServer
  let server: http.Server
  let base = ''
  let tmp = ''
  const admin = () => new Client(base)
  let A: Client, rep: Client, viewer: Client

  const deals: TableDef = {
    id: 'tbl_deals_s1', name: 'Deals', displayName: 'Deals', primaryColumn: 'Title', createdOn: new Date().toISOString(), modifiedOn: new Date().toISOString(),
    connectionId: 'conn_default', source: 't_deals_s1',
    columns: [
      { name: 'id', displayName: 'Id', type: 'text', system: true },
      { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true },
      { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime', system: true },
      { name: 'createdBy', displayName: 'Created by', type: 'text', system: true },
      { name: 'owner', displayName: 'Owner', type: 'text', system: true },
      { name: 'Title', displayName: 'Title', type: 'text', required: true },
      { name: 'Region', displayName: 'Region', type: 'text' },
      { name: 'Amount', displayName: 'Amount', type: 'currency' },
      { name: 'Closed', displayName: 'Closed', type: 'date' },
      { name: 'Secret', displayName: 'Secret', type: 'text' },
      { name: 'Status', displayName: 'Status', type: 'choice', choices: ['Open', 'Won', 'Lost'], default: 'Open' },
      { name: 'Code', displayName: 'Code', type: 'autonumber', prefix: 'D-' },
      { name: 'Ref', displayName: 'Ref', type: 'text', unique: true },
      { name: 'Docs', displayName: 'Docs', type: 'file', multiple: true },
      { name: 'Photo', displayName: 'Photo', type: 'image' },
    ],
  }

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-s1-'))
    app = await createApp({ env: {}, config: { workspaceDir: tmp }, printSetupCode: false })
    server = http.createServer((req, res) => {
      app.handle(req, res).then((h) => {
        if (!h) res.writeHead(404).end()
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    A = admin()
    rep = new Client(base)
    viewer = new Client(base)
  }, 60000)

  afterAll(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    await app?.close()
    if (conn) await dropDatabase(dbName)
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }, 60000)

  it('status before setup', async () => {
    const r = await A.get('/api/v1/status')
    expect(r.status).toBe(200)
    expect(r.data).toMatchObject({ app: 'appbuilder', apiVersion: 1, backend: 'node', setup: { needsDatabase: true, needsAdmin: true }, session: null })
    expect((await A.get('/api/v1/workspace')).status).toBe(503)
  })

  it('setup database: wrong password is reported without the password; then succeeds and seals it', async () => {
    const bad = await A.post('/api/v1/setup/database', { setupCode: app.services.setupCode.current() ?? '', host: conn!.host, port: conn!.port, database: dbName, user: conn!.user, password: 'wrong-pass-xyz', createDatabase: true })
    expect(bad.status).toBe(422)
    expect(JSON.stringify(bad.data)).not.toContain('wrong-pass-xyz')
    const ok = await A.post('/api/v1/setup/database', { setupCode: app.services.setupCode.current() ?? '', host: conn!.host, port: conn!.port, database: dbName, user: conn!.user, password: conn!.password, createDatabase: true })
    expect(ok.status).toBe(200)
    const sj = fs.readFileSync(path.join(tmp, 'server.json'), 'utf8')
    expect(sj).not.toContain(conn!.password)
    expect(JSON.parse(sj).defaultConnection).toMatchObject({ database: dbName, user: conn!.user })
    const st = await A.get('/api/v1/status')
    expect(st.data.setup).toEqual({ needsDatabase: false, needsAdmin: true, codeIn: 'console', platform: expect.any(String) })
    // anonymous status: state flags only, never the database host / port / name
    expect(st.data.ok).toBe(false)
    expect(st.data.storage).toBeUndefined()
    expect(JSON.stringify(st.data)).not.toContain(dbName)
    // migrate() is idempotent
    await app.services.meta.migrate()
    await app.services.meta.migrate()
    const conns = await app.services.meta.connections.list()
    expect(conns.find((c) => c.id === 'conn_default')).toMatchObject({ connector: 'postgres', isDefault: true, hasSecret: true })
    expect(conns.find((c) => c.id === 'conn_files')).toMatchObject({ connector: 'files', scope: 'device' })
  }, 60000)

  it('setup admin creates the first administrator and signs in; only once', async () => {
    const weak = await A.post('/api/v1/setup/admin', { setupCode: app.services.setupCode.current() ?? '', name: 'Ada', email: 'ada@example.com', password: 'short' })
    expect(weak.status).toBe(422)
    const r = await A.post('/api/v1/setup/admin', { setupCode: app.services.setupCode.current() ?? '', name: 'Ada', email: 'Ada@Example.com', password: 'admin-password-1' })
    expect(r.status).toBe(200)
    expect(r.data.user).toMatchObject({ name: 'Ada', email: 'ada@example.com', roleIds: ['role_admin'], hasPassword: true })
    expect(r.data.user.passwordHash).toBeUndefined()
    expect(r.data.privileges).toMatchObject({ isAdmin: true, isMaker: true })
    expect(A.cookie).toMatch(/^ab_session=/)
    const again = await new Client(base).post('/api/v1/setup/admin', { setupCode: app.services.setupCode.current() ?? '', name: 'Eve', email: 'eve@example.com', password: 'another-password' })
    expect(again.status).toBe(409)
    // a non-admin cannot re-point the database now
    const re = await new Client(base).post('/api/v1/setup/database', { setupCode: app.services.setupCode.current() ?? '', host: conn!.host, port: conn!.port, database: dbName, user: conn!.user, password: 'x' })
    expect(re.status).toBe(403)
    const roles = await app.services.meta.roles.list()
    expect(roles.map((x) => x.id).sort()).toEqual(expect.arrayContaining(['role_admin', 'role_maker', 'role_viewer']))
    expect(roles.find((x) => x.id === 'role_maker')).toMatchObject({ isMaker: true })
    expect((await A.get('/api/v1/auth/session')).data.user.email).toBe('ada@example.com')
    const st = await A.get('/api/v1/status')
    expect(st.data.session.user.email).toBe('ada@example.com')
    expect(st.data.setup).toEqual({ needsDatabase: false, needsAdmin: false })
    // an administrator's status carries the details
    expect(st.data.storage.location).toContain(dbName)
    expect((await new Client(base).get('/api/v1/status')).data.storage).toBeUndefined()
  }, 60000)

  it('login errors are uniform; disabled users cannot sign in', async () => {
    const c = new Client(base)
    const a = await c.post('/api/v1/auth/login', { email: 'ada@example.com', password: 'nope-nope-nope' })
    const b = await c.post('/api/v1/auth/login', { email: 'nobody@example.com', password: 'nope-nope-nope' })
    expect(a.status).toBe(401)
    expect(b.status).toBe(401)
    expect(a.data.error.message).toBe(b.data.error.message)
    expect(c.cookie).toBe('')
  }, 60000)

  it('create table + users + roles (MetaStore + connector)', async () => {
    const meta = app.services.meta
    await meta.tables.upsert(deals)
    const connector = await app.services.connections.get('conn_default')
    await connector.createTable(deals)
    const repRole: RoleDef = {
      id: 'role_rep', name: 'Sales rep', apps: 'all',
      privileges: [{ table: deals.id, create: true, read: 'own', update: 'own', delete: 'own', columns: { Secret: 'none', Status: 'read' } }],
    }
    const westRole: RoleDef = {
      id: 'role_west', name: 'West viewer', apps: [],
      privileges: [{ table: deals.id, create: false, read: 'all', update: 'none', delete: 'none', columns: { Secret: 'none' }, rowFilter: [{ column: 'Region', op: 'eq', value: 'West' }] }],
    }
    await meta.roles.upsert(repRole)
    await meta.roles.upsert(westRole)
    expect((await meta.roles.get('role_west'))?.privileges[0].rowFilter).toEqual([{ column: 'Region', op: 'eq', value: 'West' }])
    await meta.users.insert({ id: 'user_rep', name: 'Rita Rep', email: 'rita@example.com', roleIds: ['role_rep'], status: 'active', passwordHash: await hashPassword('rita-password-1') })
    await meta.users.insert({ id: 'user_west', name: 'Walt West', email: 'walt@example.com', roleIds: ['role_west'], status: 'active', passwordHash: await hashPassword('walt-password-1') })
    await meta.users.insert({ id: 'user_off', name: 'Off', email: 'off@example.com', roleIds: ['role_rep'], status: 'disabled', passwordHash: await hashPassword('off-password-1') })
    app.services.security.invalidate()
    expect((await rep.post('/api/v1/auth/login', { email: 'rita@example.com', password: 'rita-password-1' })).status).toBe(200)
    expect((await viewer.post('/api/v1/auth/login', { email: 'WALT@example.com', password: 'walt-password-1' })).status).toBe(200)
    expect((await new Client(base).post('/api/v1/auth/login', { email: 'off@example.com', password: 'off-password-1' })).status).toBe(401)
  }, 60000)

  let rowA = '', rowB = '', rowC = ''

  it('admin inserts, validates, autonumbers and sees everything', async () => {
    const a = await A.post('/api/v1/data/Deals/rows', { values: { Title: 'Alpha', Region: 'West', Amount: '1,250.50', Closed: '2024-03-05', Secret: 'top', Ref: 'R1' } })
    expect(a.status).toBe(200)
    expect(a.data.row).toMatchObject({ Title: 'Alpha', Region: 'West', Amount: 1250.5, Closed: '2024-03-05', Secret: 'top', Status: 'Open', Code: 'D-0001', owner: expect.stringMatching(/^user_/) })
    rowA = a.data.row.id
    const b = await A.post('/api/v1/data/Deals/rows', { values: { Title: 'Bravo', Region: 'East', Secret: 'hidden' } })
    rowB = b.data.row.id
    expect(b.data.row.Code).toBe('D-0002')
    expect((await A.post('/api/v1/data/Deals/rows', { values: { Region: 'West' } })).status).toBe(422) // Title required
    const dup = await A.post('/api/v1/data/Deals/rows', { values: { Title: 'Dup', Ref: 'r1' } })
    expect(dup.status).toBe(409)
    expect(dup.data.error.field).toBe('Ref')
    expect((await A.post('/api/v1/data/Deals/rows', { values: { Title: 'X', Status: 'Maybe' } })).status).toBe(422)
    expect((await A.post('/api/v1/data/Deals/rows', { values: { Title: 'X', Nope: 1 } })).status).toBe(422)
    expect((await A.post('/api/v1/data/Deals/rows', { values: { Title: 'X', Docs: '["att_fake"]' } })).status).toBe(422)
    const q = await A.post('/api/v1/data/Deals/query', { orderBy: [{ col: 'Code', dir: 'asc' }], count: true })
    expect(q.data.rows.map((r: any) => r.Title)).toEqual(['Alpha', 'Bravo'])
    expect(q.data.total).toBe(2)
    expect(q.data.truncated).toBe(false)
    expect(q.data.rows[0].Secret).toBe('top')
  }, 60000)

  it('restricted user: RLS own rows only and CLS hidden / read-only columns', async () => {
    const c = await rep.post('/api/v1/data/Deals/rows', { values: { Title: 'Charlie', Region: 'West', id: '0b5b9d3e-6f1a-4c55-9d7e-1f2a3b4c5d6e' } })
    expect(c.status).toBe(200)
    rowC = c.data.row.id
    expect(rowC).toBe('0b5b9d3e-6f1a-4c55-9d7e-1f2a3b4c5d6e')
    expect(c.data.row.owner).toBe('user_rep')
    expect('Secret' in c.data.row).toBe(false)
    const q = await rep.post('/api/v1/data/Deals/query', {})
    expect(q.data.rows.map((r: any) => r.Title)).toEqual(['Charlie'])
    expect(Object.keys(q.data.rows[0])).not.toContain('Secret')
    // hidden column refused in where / orderBy / select / writes
    expect((await rep.post('/api/v1/data/Deals/query', { where: { col: 'Secret', op: 'eq', value: 'top' } })).status).toBe(403)
    expect((await rep.post('/api/v1/data/Deals/query', { orderBy: [{ col: 'Secret', dir: 'asc' }] })).status).toBe(403)
    expect((await rep.post('/api/v1/data/Deals/query', { select: ['Secret'] })).status).toBe(403)
    const w = await rep.post('/api/v1/data/Deals/rows', { values: { Title: 'Sneaky', Secret: 'x' } })
    expect(w.status).toBe(403)
    expect(w.data.error.field).toBe('Secret')
    // read-only column refused on write
    const ro = await rep.patch(`/api/v1/data/Deals/rows/${rowC}`, { changes: { Status: 'Won' } })
    expect(ro.status).toBe(403)
    expect(ro.data.error.field).toBe('Status')
    // own row update ok; another user's row looks missing
    const up = await rep.patch(`/api/v1/data/Deals/rows/${rowC}`, { changes: { Title: 'Charlie 2', owner: 'user_west', createdBy: 'x' } })
    expect(up.status).toBe(200)
    expect(up.data.row).toMatchObject({ Title: 'Charlie 2', owner: 'user_rep' })
    expect((await rep.patch(`/api/v1/data/Deals/rows/${rowA}`, { changes: { Title: 'Hacked' } })).status).toBe(404)
    expect((await rep.post('/api/v1/data/Deals/delete', { ids: [rowA] })).status).toBe(404)
    // csv export: own rows, visible columns
    const csv = await rep.get('/api/v1/tables/Deals/csv')
    const text = (csv.data as Buffer).toString('utf8')
    expect(text).toContain('Charlie 2')
    expect(text).not.toContain('Alpha')
    expect(text).not.toContain('Secret')
    // workspace: Secret not in the TableDef, only own user
    const ws = await rep.get('/api/v1/workspace')
    expect(ws.status).toBe(200)
    const def = ws.data.tables.find((t: TableDef) => t.name === 'Deals')
    expect(def.columns.map((x: { name: string }) => x.name)).not.toContain('Secret')
    expect(ws.data.users.map((u: { id: string }) => u.id)).toEqual(['user_rep'])
    expect(ws.data.connections).toEqual([])
    expect(ws.data.session.privileges.tables[deals.id]).toMatchObject({ read: 'own', create: true, columns: { Secret: 'none', Status: 'read' } })
  }, 60000)

  it('rowFilter user: sees West rows only, cannot write', async () => {
    const q = await viewer.post('/api/v1/data/Deals/query', { orderBy: [{ col: 'Title', dir: 'asc' }] })
    expect(q.status).toBe(200)
    expect(q.data.rows.map((r: any) => r.Title)).toEqual(['Alpha', 'Charlie 2'])
    expect('Secret' in q.data.rows[0]).toBe(false)
    expect((await viewer.post('/api/v1/data/Deals/rows', { values: { Title: 'No' } })).status).toBe(403)
    expect((await viewer.patch(`/api/v1/data/Deals/rows/${rowA}`, { changes: { Title: 'No' } })).status).toBe(403)
    expect((await viewer.patch(`/api/v1/data/Deals/rows/${rowB}`, { changes: { Title: 'No' } })).status).toBe(404)
    expect((await viewer.post('/api/v1/data/Deals/delete', { ids: [rowA] })).status).toBe(403)
    const ws = await viewer.get('/api/v1/workspace')
    expect(ws.data.apps).toEqual([]) // role grants no apps
  }, 60000)

  let attC = '', attB = ''

  it('attachments: upload updates the cell, download checks permissions, resolve filters', async () => {
    const bytes = Buffer.from('%PDF-1.4 hello attachment')
    const up = await rep.req('POST', `/api/v1/attachments?table=Deals&column=Docs&rowId=${rowC}&name=${encodeURIComponent('../quote é.pdf')}`, undefined, { data: bytes, type: 'application/pdf' })
    expect(up.status).toBe(200)
    expect(up.data).toMatchObject({ fileName: 'quote é.pdf', mime: 'application/pdf', sizeBytes: bytes.length })
    attC = up.data.id
    expect(attC).toMatch(/^att_/)
    // the link names its environment (an <img src> cannot send the environment header)
    expect(up.data.url).toBe(`/api/v1/attachments/${attC}?env=default`)
    const up2 = await rep.req('POST', `/api/v1/attachments?table=Deals&column=Docs&rowId=${rowC}&name=b.txt`, undefined, { data: Buffer.from('second'), type: 'text/plain' })
    expect(up2.status).toBe(200)
    const row = await rep.post('/api/v1/data/Deals/query', { where: { col: 'id', op: 'eq', value: rowC } })
    expect(JSON.parse(row.data.rows[0].Docs)).toEqual([attC, up2.data.id])
    // image column: single, replaced; wrong MIME refused
    expect((await rep.req('POST', `/api/v1/attachments?table=Deals&column=Photo&rowId=${rowC}&name=x.pdf`, undefined, { data: bytes, type: 'application/pdf' })).status).toBe(422)
    const p1 = await rep.req('POST', `/api/v1/attachments?table=Deals&column=Photo&rowId=${rowC}&name=a.png`, undefined, { data: Buffer.from('png1'), type: 'image/png' })
    const p2 = await rep.req('POST', `/api/v1/attachments?table=Deals&column=Photo&rowId=${rowC}&name=b.png`, undefined, { data: Buffer.from('png2'), type: 'image/png' })
    expect((await rep.post('/api/v1/data/Deals/query', { where: { col: 'id', op: 'eq', value: rowC } })).data.rows[0].Photo).toBe(p2.data.id)
    expect(await app.services.meta.attachments.get(p1.data.id)).toBeNull() // replaced one is gone
    // download
    const dl = await rep.get(attachmentPath(attC))
    expect(dl.status).toBe(200)
    expect((dl.data as Buffer).equals(bytes)).toBe(true)
    expect(dl.headers.get('content-type')).toBe('application/pdf')
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff')
    expect(dl.headers.get('content-security-policy')).toContain('sandbox')
    expect(dl.headers.get('content-disposition')).toMatch(/^inline;/)
    // West viewer can read row C (West) and the Docs column
    expect((await viewer.get(attachmentPath(attC))).status).toBe(200)
    // admin attaches to row B (East): rep and viewer cannot see it
    const b = await A.req('POST', `/api/v1/attachments?table=Deals&column=Docs&rowId=${rowB}&name=b.pdf`, undefined, { data: bytes, type: 'application/pdf' })
    attB = b.data.id
    expect((await rep.get(attachmentPath(attB))).status).toBe(404)
    expect((await viewer.get(attachmentPath(attB))).status).toBe(404)
    expect((await new Client(base).get(attachmentPath(attB))).status).toBe(401)
    // upload to a row the user may not change
    expect((await rep.req('POST', `/api/v1/attachments?table=Deals&column=Docs&rowId=${rowA}&name=x`, undefined, { data: bytes, type: 'application/pdf' })).status).toBe(404)
    expect((await viewer.req('POST', `/api/v1/attachments?table=Deals&column=Docs&rowId=${rowA}&name=x`, undefined, { data: bytes, type: 'application/pdf' })).status).toBe(403)
    // resolve filters forbidden / unknown ids
    const res = await rep.post('/api/v1/attachments/resolve', { ids: [attC, attB, 'att_unknown'] })
    expect(res.data.items.map((x: { id: string }) => x.id)).toEqual([attC])
    // cell values must reference real attachments of that row/column
    expect((await rep.patch(`/api/v1/data/Deals/rows/${rowC}`, { changes: { Docs: JSON.stringify([attC, attB]) } })).status).toBe(422)
  }, 60000)

  it('attachment delete and orphan cleanup on row delete', async () => {
    expect((await viewer.del(attachmentPath(attC))).status).toBe(403)
    const d = await rep.del(attachmentPath(attC))
    expect(d.status).toBe(200)
    expect(await app.services.meta.attachments.get(attC)).toBeNull()
    const row = await rep.post('/api/v1/data/Deals/query', { where: { col: 'id', op: 'eq', value: rowC } })
    expect(JSON.parse(row.data.rows[0].Docs)).toHaveLength(1)
    // update removing an id deletes that attachment
    const keep = JSON.parse(row.data.rows[0].Docs)[0]
    expect((await rep.patch(`/api/v1/data/Deals/rows/${rowC}`, { changes: { Docs: null } })).status).toBe(200)
    expect(await app.services.meta.attachments.get(keep)).toBeNull()
    // deleting the row removes its remaining attachments (Photo)
    const rec = (await app.services.meta.attachments.forRows(deals.id, [rowC]))
    expect(rec.length).toBe(1)
    // workspace/env/<environment>/attachments
    const storage = path.join(tmp, 'env', 'default', 'attachments', rec[0].storageKey.slice(0, 2), rec[0].storageKey)
    expect(fs.existsSync(storage)).toBe(true)
    expect((await rep.post('/api/v1/data/Deals/delete', { ids: [rowC] })).data).toEqual({ deleted: 1 })
    expect(await app.services.meta.attachments.forRows(deals.id, [rowC])).toEqual([])
    // the file goes once the delete has committed (a job; docs/dev/events-and-jobs.md)
    await app.services.kernel.drain()
    expect(fs.existsSync(storage)).toBe(false)
  }, 60000)

  it('import csv (append) through the service rules, audit trail written', async () => {
    const csv = 'Title,Region,Secret,Status,Amount\nDelta,West,ignored,Won,10\nEcho,East,,,'
    const r = await rep.post('/api/v1/data/Deals/import', { csv, mode: 'append' })
    expect(r.status).toBe(200)
    expect(r.data.imported).toBe(2)
    const q = await A.post('/api/v1/data/Deals/query', { where: { col: 'Title', op: 'in', value: ['Delta', 'Echo'] }, orderBy: [{ col: 'Title', dir: 'asc' }] })
    expect(q.data.rows.map((x: any) => [x.Title, x.owner, x.Secret, x.Status])).toEqual([['Delta', 'user_rep', null, 'Open'], ['Echo', 'user_rep', null, 'Open']])
    const bad = await rep.post('/api/v1/data/Deals/import', { csv: 'Title,Amount\nOk,1\nBad,abc', mode: 'append' })
    expect(bad.status).toBe(422)
    expect(bad.data.error.message).toMatch(/^Row 2:/)
    const audit = await app.services.meta.db.query<{ action: string; details: unknown }>(`SELECT action, details FROM ${app.services.meta.tableName('ab_audit')} ORDER BY id`)
    const actions = audit.map((a) => a.action)
    expect(actions).toEqual(expect.arrayContaining(['setup.admin', 'auth.login', 'auth.login_failed', 'row.insert', 'row.update', 'row.delete', 'table.import', 'attachment.upload']))
    expect(JSON.stringify(audit)).not.toMatch(/password-1|admin-password|rita-password/)
  }, 60000)

  it('password change rotates sessions; logout ends the session', async () => {
    const other = new Client(base)
    expect((await other.post('/api/v1/auth/login', { email: 'rita@example.com', password: 'rita-password-1' })).status).toBe(200)
    expect((await rep.post('/api/v1/auth/password', { current: 'wrong-password', next: 'rita-password-2' })).status).toBe(422)
    expect((await rep.post('/api/v1/auth/password', { current: 'rita-password-1', next: 'rita@example.com' })).status).toBe(422)
    expect((await rep.post('/api/v1/auth/password', { current: 'rita-password-1', next: 'rita-password-2' })).status).toBe(200)
    expect((await rep.get('/api/v1/auth/session')).status).toBe(200) // this device keeps working
    expect((await other.get('/api/v1/auth/session')).status).toBe(401) // other devices are signed out
    expect((await other.post('/api/v1/auth/login', { email: 'rita@example.com', password: 'rita-password-2' })).status).toBe(200)
    const out = await rep.post('/api/v1/auth/logout')
    expect(out.status).toBe(200)
    expect(rep.cookie).toBe('')
    expect((await rep.get('/api/v1/auth/session')).status).toBe(401)
    expect((await rep.post('/api/v1/data/Deals/query', {})).status).toBe(401)
  }, 60000)

  it('restart: bootstraps from server.json', async () => {
    const app2 = await createApp({ env: {}, config: { workspaceDir: tmp }, printSetupCode: false })
    try {
      expect(app2.services.ready()).toBe(true)
      const users = await app2.services.meta.users.count()
      expect(users).toBeGreaterThanOrEqual(3)
    } finally {
      await app2.close()
    }
  }, 60000)
})

function attachmentPath(id: string): string {
  return `/api/v1/attachments/${encodeURIComponent(id)}`
}
