/**
 * Metadata API end to end over HTTP against the sandbox PostgreSQL:
 *   APPBUILDER_TEST_DB=postgres://abdev:abdev-sandbox-only@127.0.0.1:5433/appbuilder_test npx vitest run server/routes/meta
 * Skipped when APPBUILDER_TEST_DB is unset. Creates a fresh database and drops it afterwards.
 */
import { planBody } from '../../core/testquery.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { PG_URL, SKIP_PG, dropDatabase, pgServer, testDatabaseName } from '../../core/testdb.ts'
import { createApp } from '../../core/app.ts'
import type { AppServer } from '../../core/app.ts'
import { setQuiet } from '../../core/util.ts'

setQuiet(true)

const URL_ENV = PG_URL
const conn = pgServer
const dbName = testDatabaseName('s2')
if (!URL_ENV) process.stderr.write(`[server/routes/meta integration] ${SKIP_PG}\n`)

class Client {
  cookie = ''
  base: string
  constructor(base: string) {
    this.base = base
  }
  async req(method: string, p: string, body?: unknown) {
    const headers: Record<string, string> = { 'X-Appbuilder': '1' }
    if (this.cookie) headers.Cookie = this.cookie
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

describe.skipIf(!URL_ENV)('metadata API integration (PostgreSQL)', () => {
  let app: AppServer
  let server: http.Server
  let tmp = ''
  let A: Client
  let base = ''

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-s2-'))
    app = await createApp({ env: {}, config: { workspaceDir: tmp }, printSetupCode: false })
    server = http.createServer((req, res) => {
      app.handle(req, res).then((h) => {
        if (!h) res.writeHead(404).end()
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    A = new Client(base)
    const db = await A.post('/setup/database', { setupCode: app.services.setupCode.current() ?? '', host: conn!.host, port: conn!.port, database: dbName, user: conn!.user, password: conn!.password, createDatabase: true })
    expect(db.status).toBe(200)
    const ad = await A.post('/setup/admin', { setupCode: app.services.setupCode.current() ?? '', name: 'Ada', email: 'ada@example.com', password: 'admin-password-1' })
    expect(ad.status).toBe(200)
  }, 60000)

  afterAll(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    await app?.close()
    if (conn) await dropDatabase(dbName)
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }, 60000)

  it('seeds the sample tables, rows (owned by the admin) and the Contacts app', async () => {
    const boot = await A.get('/workspace')
    expect(boot.status).toBe(200)
    const tables = (boot.data.tables as { id: string; name: string; system?: boolean }[]).filter((t) => !t.system)
    expect(tables.map((t) => t.name).sort()).toEqual(['Contacts', 'Orders'])
    const contacts = tables.find((t) => t.name === 'Contacts')!
    const rows = await A.post('/query', planBody(contacts.id))
    expect(rows.status).toBe(200)
    expect(rows.data.rows.length).toBeGreaterThan(3)
    expect(rows.data.rows[0].owner).toBeTruthy()
    expect((boot.data.apps as { name: string }[]).map((a) => a.name)).toContain('Contacts app')
  })

  it('creates a table (real DDL), adds a column, changes its type and drops it', async () => {
    const c = await A.post('/tables', { name: 'Deals', displayName: 'Deals', columns: [{ name: 'Title', displayName: 'Title', type: 'text', required: true }, { name: 'Value', displayName: 'Value', type: 'number' }] })
    expect(c.status).toBe(200)
    const id = c.data.id as string
    const add = await A.post(`/tables/${id}/columns`, { name: 'Stage', displayName: 'Stage', type: 'choice', choices: ['Open', 'Won'], default: 'Open' })
    expect(add.status).toBe(200)
    const ins = await A.post(`/data/${id}/rows`, { values: { Title: 'Big deal', Value: 12 } })
    expect(ins.status).toBe(200)
    const bad = await A.patch(`/tables/${id}/columns/Title`, { type: 'number' })
    expect(bad.status).toBe(422)
    const ok = await A.patch(`/tables/${id}/columns/Value`, { type: 'text' })
    expect(ok.status).toBe(200)
    const csv = await A.get(`/tables/${id}/csv`)
    expect(csv.status).toBe(200)
    expect(String(csv.data)).toContain('Big deal')
    const del = await A.del(`/tables/${id}?dropSource=1`)
    expect(del.status).toBe(200)
  })

  it('roles with CLS and row filters, a user with a password, and the security preview', async () => {
    const t = await A.post('/tables', { name: 'Notes', displayName: 'Notes', columns: [{ name: 'Title', displayName: 'Title', type: 'text' }, { name: 'Secret', displayName: 'Secret', type: 'text' }] })
    expect(t.status).toBe(200)
    const tid = t.data.id as string
    const bad = await A.post('/roles', { name: 'Bad', privileges: [{ table: 'nope', create: false, read: 'all', update: 'none', delete: 'none' }] })
    expect(bad.status).toBe(404)
    const r = await A.post('/roles', { name: 'Reader', privileges: [{ table: tid, create: false, read: 'all', update: 'none', delete: 'none', columns: { Title: 'update', Secret: 'read' }, rowFilter: [{ column: 'owner', op: 'eq', value: '@me' }] }] })
    expect(r.status).toBe(200)
    const u = await A.post('/users', { name: 'Rita', email: 'rita@example.com', roleIds: [r.data.id], password: 'rita-password-12' })
    expect(u.status).toBe(200)
    const pw = await A.post(`/users/${u.data.id}/password`, { password: 'another-pass-123' })
    expect(pw.status).toBe(200)
    const pv = await A.get(`/security/preview?user=${u.data.id}`)
    expect(pv.status).toBe(200)
    expect(pv.data.isAdmin).toBe(false)
    const L = new Client(base)
    const login = await L.post('/auth/login', { email: 'rita@example.com', password: 'another-pass-123' })
    expect(login.status).toBe(200)
    const denied = await L.post('/tables', { name: 'X', displayName: 'X' })
    expect(denied.status).toBe(403)
    const guard = await A.del(`/users/${(await A.get('/workspace')).data.users.find((x: any) => x.email === 'ada@example.com').id}`)
    expect(guard.status).toBe(409)
  })

  it('connection test, app package export and import', async () => {
    const wk = await A.get('/workspace')
    const def = (wk.data.connections as { id: string; isDefault?: boolean }[]).find((c) => c.id === 'conn_default')!
    const t = await A.post(`/connections/${def.id}/test`)
    expect(t.status).toBe(200)
    const app = (wk.data.apps as { id: string; name: string }[]).find((a) => a.name === 'Contacts app')!
    const pkg = await A.get(`/apps/${app.id}/package?data=1`)
    expect(pkg.status).toBe(200)
    const imp = await A.post('/apps/import', { yaml: pkg.data.yaml })
    expect(imp.status).toBe(200)
  })
})
