/**
 * Regression tests for the hardening fixes over HTTP against the sandbox PostgreSQL:
 *   APPBUILDER_TEST_DB=postgres://abdev:abdev-sandbox-only@127.0.0.1:5433/appbuilder_test npx vitest run server/core/hardening
 * setup code and setup lock, anonymous /status, forced password change, linking existing tables of the default database
 * with and without consent, assign owner, boot retry, downgrade guard, the first migration's audit entry. Creates and drops
 * its own database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { PG_URL, SKIP_PG, dropDatabase, pgQuery, pgServer, testDatabaseName } from './testdb.ts'
import { createApp } from './app.ts'
import type { AppServer } from './app.ts'
import { createPgDb } from '../connectors/postgres/db.ts'
import type { DatabaseSettings, SqlDb } from './contracts.ts'
import { INSTALL_TABLES, SCHEMA_VERSION } from './meta-store.ts'
import { setQuiet } from './util.ts'

setQuiet(true)

const URL_ENV = PG_URL
const conn = pgServer
const dbName = testDatabaseName('hd')
if (!URL_ENV) process.stderr.write(`[server/core hardening integration] ${SKIP_PG}\n`)

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
    return { status: res.status, data: data as any, headers: res.headers }
  }
  get = (p: string) => this.req('GET', p)
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {})
  patch = (p: string, b: unknown) => this.req('PATCH', p, b)
}

async function serve(app: AppServer): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer((req, res) => {
    app.handle(req, res).then((h) => {
      if (!h) res.writeHead(404).end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

describe.skipIf(!URL_ENV)('hardening (PostgreSQL)', () => {
  let app: AppServer
  let server: http.Server
  let tmp = ''
  let base = ''
  let A: Client
  /** direct SQL on the test database (bypassing Appbuilder) */
  const raw = { query: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => pgQuery<T>(dbName, sql, params) }
  const dbSettings = () => ({ host: conn!.host, port: conn!.port, database: dbName, user: conn!.user, password: conn!.password, createDatabase: true })

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-hd-'))
    app = await createApp({ env: {}, config: { workspaceDir: tmp }, printSetupCode: false })
    ;({ server, base } = await serve(app))
    A = new Client(base)
  }, 60000)

  afterAll(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    await app?.close()
    if (conn) await dropDatabase(dbName)
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }, 60000)

  it('first-run setup needs the one-time setup code; anonymous status carries flags only', async () => {
    const code = app.services.setupCode.current()
    expect(code).toMatch(/^[A-Z2-9]{8}$/)
    const st = await A.get('/status')
    expect(st.data.setup).toEqual({ needsDatabase: true, needsAdmin: true })
    expect(st.data.ok).toBe(false)
    expect(st.data.storage).toBeUndefined()
    // no code / wrong code: refused before anything is tried
    const none = await A.post('/setup/database', dbSettings())
    expect(none.status).toBe(403)
    expect(none.data.error.field).toBe('setupCode')
    expect((await A.post('/setup/database', { ...dbSettings(), setupCode: 'AAAAAAAA' })).status).toBe(403)
    expect(fs.existsSync(path.join(tmp, 'server.json'))).toBe(false)
    // header form, with a dash and lowercase: accepted
    const okRes = await fetch(base + '/api/v1/setup/database', {
      method: 'POST',
      headers: { 'X-Appbuilder': '1', 'Content-Type': 'application/json', 'X-Appbuilder-Setup-Code': `${code!.slice(0, 4)}-${code!.slice(4)}`.toLowerCase() },
      body: JSON.stringify(dbSettings()),
    })
    expect(okRes.status, await okRes.clone().text()).toBe(200)
    // the admin step needs it too
    expect((await A.post('/setup/admin', { name: 'Ada', email: 'ada@example.com', password: 'admin-password-1' })).status).toBe(403)
    const adm = await A.post('/setup/admin', { name: 'Ada', email: 'ada@example.com', password: 'admin-password-1', setupCode: code })
    expect(adm.status, JSON.stringify(adm.data)).toBe(200)
    // rotated: the printed code is useless now, and the setup is locked
    expect(app.services.setupCode.current()).not.toBe(code)
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'server.json'), 'utf8')).setupComplete).toBe(true)
    expect((await new Client(base).post('/setup/database', { ...dbSettings(), setupCode: code })).status).toBe(403)
    const anon = await new Client(base).get('/status')
    expect(anon.data).toMatchObject({ ok: true, setup: { needsDatabase: false, needsAdmin: false } })
    expect(JSON.stringify(anon.data)).not.toContain(dbName)
    expect((await A.get('/status')).data.storage.location).toContain(dbName)
  }, 60000)

  it('the first migration is printed and written to the audit log', async () => {
    const list = await raw.query<{ details: unknown }>("SELECT details FROM env_default.ab_audit WHERE action = 'schema.migrate'")
    expect(list.length).toBe(1)
    expect(list[0].details).toMatchObject({ from: 0, to: SCHEMA_VERSION })
  })

  it('an admin-set password must be changed first; everything else answers password_change_required', async () => {
    const u = await A.post('/users', { name: 'Tom', email: 'tom@example.com', roleIds: ['role_viewer'], password: 'temporary-pass-1' })
    expect(u.status).toBe(200)
    const T = new Client(base)
    const login = await T.post('/auth/login', { email: 'tom@example.com', password: 'temporary-pass-1' })
    expect(login.status).toBe(200)
    expect(login.data.user.mustChangePassword).toBe(true)
    const ws = await T.get('/workspace')
    expect(ws.status).toBe(403)
    expect(ws.data.error.code).toBe('password_change_required')
    expect((await T.get('/auth/session')).status).toBe(200)
    expect((await T.get('/status')).data.session.user.mustChangePassword).toBe(true)
    expect((await T.post('/auth/password', { current: 'temporary-pass-1', next: 'my-own-password-1' })).status).toBe(200)
    expect((await T.get('/workspace')).status).toBe(200)
    // the next admin reset forces it again
    expect((await A.post(`/users/${u.data.id}/password`, { password: 'temporary-pass-2' })).status).toBe(200)
    const T2 = new Client(base)
    expect((await T2.post('/auth/login', { email: 'tom@example.com', password: 'temporary-pass-2' })).data.user.mustChangePassword).toBe(true)
    expect((await T2.get('/workspace')).data.error.code).toBe('password_change_required')
  }, 60000)

  it('link from the default database: without consent a table lacking system columns is read-only and its queries work', async () => {
    await raw.query('CREATE TABLE env_default.half_sys (id text NOT NULL PRIMARY KEY, name varchar(50) NULL)')
    await raw.query("INSERT INTO env_default.half_sys VALUES ('11111111-1111-4111-8111-111111111111', 'x')")
    const l = await A.post('/connections/conn_default/link', { source: 'half_sys', displayName: 'Half' })
    expect(l.status, JSON.stringify(l.data)).toBe(200)
    expect(l.data).toMatchObject({ readOnly: true, missingSystem: ['createdOn', 'modifiedOn', 'createdBy', 'owner'] })
    const q = await A.post(`/data/${l.data.id}/query`, { count: true })
    expect(q.status, JSON.stringify(q.data)).toBe(200)
    expect(q.data.rows).toEqual([{ id: '11111111-1111-4111-8111-111111111111', name: 'x' }])
    expect((await A.post(`/data/${l.data.id}/query`, { top: 1, skip: 0 })).status).toBe(200)
    expect((await A.get(`/tables/${l.data.id}/csv`)).status).toBe(200)
    // the same physical table cannot be linked twice
    const again = await A.post('/connections/conn_default/link', { source: 'half_sys' })
    expect(again.status).toBe(409)
    expect(again.data.error.message).toContain('"Half"')
    // deleting it never drops the customer's table
    expect((await A.req('DELETE', `/tables/${l.data.id}?dropSource=1`)).status).toBe(422)
    expect((await A.req('DELETE', `/tables/${l.data.id}`)).status).toBe(200)
    const left = await raw.query<{ t: string | null }>("SELECT to_regclass('env_default.half_sys')::text AS t")
    expect(left[0].t).toBe('env_default.half_sys')
  }, 60000)

  it('link with consent: missing system columns are added, id backfilled with UUIDv7, the table is writable', async () => {
    await raw.query('CREATE TABLE env_default.crm_clients (client_no integer NOT NULL PRIMARY KEY, name varchar(50) NULL)')
    await raw.query("INSERT INTO env_default.crm_clients VALUES (1, 'Alpha'), (2, 'Beta'), (3, 'Gamma')")
    const l = await A.post('/connections/conn_default/link', { source: 'crm_clients', displayName: 'Clients', ensureIdColumn: true })
    expect(l.status, JSON.stringify(l.data)).toBe(200)
    expect(l.data.readOnly).toBeUndefined()
    expect(l.data.missingSystem).toBeUndefined()
    const cols = await raw.query<{ c: string; n: string }>("SELECT column_name AS c, is_nullable AS n FROM information_schema.columns WHERE table_schema = 'env_default' AND table_name = 'crm_clients' ORDER BY ordinal_position")
    const byName = new Map(cols.map((r) => [r.c, r.n]))
    for (const c of ['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner']) expect(byName.has(c), c).toBe(true)
    expect(byName.get('id')).toBe('NO')
    const list = await raw.query<{ id: string; createdOn: Date | null }>('SELECT id, "createdOn" FROM env_default.crm_clients ORDER BY client_no')
    expect(new Set(list.map((r) => r.id)).size).toBe(3)
    // filled in physical row order: UUIDv7 values increase with it
    expect([...list.map((r) => r.id)].sort()).toEqual(list.map((r) => r.id))
    for (const r of list) {
      expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(r.createdOn).not.toBeNull()
    }
    const ins = await A.post(`/data/${l.data.id}/rows`, { values: { client_no: 4, name: 'Delta' } })
    expect(ins.status, JSON.stringify(ins.data)).toBe(200)
    const q = await A.post(`/data/${l.data.id}/query`, { orderBy: [{ col: 'client_no', dir: 'asc' }] })
    expect(q.data.rows.map((r: any) => r.name)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])
    expect(q.data.rows.map((r: any) => r.owner)).toEqual([null, null, null, expect.stringMatching(/^user_/)])
    // the pre-existing rows have no owner: the admin action fixes that
    const as = await A.post(`/tables/${l.data.id}/assign-owner`, {})
    expect(as.data).toEqual({ updated: 3 })
    const q2 = await A.post(`/data/${l.data.id}/query`, {})
    expect(q2.data.rows.every((r: any) => typeof r.owner === 'string' && r.owner)).toBe(true)
    // removing a column of the linked table only unmaps it
    expect((await A.req('DELETE', `/tables/${l.data.id}/columns/name`)).status).toBe(200)
    const after = await raw.query<{ n: number }>("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'env_default' AND table_name = 'crm_clients' AND column_name = 'name'")
    expect(after[0].n).toBe(1)
  }, 60000)

  it('migrate() is idempotent and leaves the layout: schema ab plus env_default', async () => {
    expect(await app.services.meta.migrate()).toMatchObject({ from: SCHEMA_VERSION, to: SCHEMA_VERSION, steps: [] })
    const schemas = (await raw.query<{ s: string }>("SELECT nspname AS s FROM pg_namespace WHERE nspname IN ('ab', 'env_default', 'public') ORDER BY 1")).map((r) => r.s)
    expect(schemas).toEqual(['ab', 'env_default', 'public'])
    const inAb = (await raw.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'ab' ORDER BY 1")).map((r) => r.t)
    expect(inAb).toEqual([...INSTALL_TABLES].sort())
    expect(await raw.query("SELECT id, schema_name, built_in FROM ab.environments")).toEqual([{ id: 'default', schema_name: 'env_default', built_in: true }])
    // nothing in public
    expect((await raw.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).length).toBe(0)
  }, 60000)

  /** a copy of the workspace (server.json, .secret-key) for a second server instance */
  const copyWorkspace = (patch?: (sj: any) => void): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-hd2-'))
    for (const f of ['server.json', '.secret-key']) fs.copyFileSync(path.join(tmp, f), path.join(dir, f))
    if (patch) {
      const sj = JSON.parse(fs.readFileSync(path.join(dir, 'server.json'), 'utf8'))
      patch(sj)
      fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify(sj))
    }
    return dir
  }

  it('setup complete + database unreachable: /setup/database stays closed, status says unavailable', async () => {
    const dir = copyWorkspace((sj) => { sj.defaultConnection.port = 1 })
    const app2 = await createApp({ env: {}, config: { workspaceDir: dir }, printSetupCode: false })
    const s2 = await serve(app2)
    try {
      expect(app2.services.ready()).toBe(false)
      const c = new Client(s2.base)
      const st = await c.get('/status')
      expect(st.data.setup).toEqual({ needsDatabase: false, needsAdmin: false, unavailable: true })
      expect(st.data.ok).toBe(false)
      expect(st.data.databaseError).toBeUndefined()
      // not even with a setup code (none is issued once setup is complete)
      expect(app2.services.setupCode.current()).toBeNull()
      const r = await c.post('/setup/database', { ...dbSettings(), setupCode: 'ABCDEFGH' })
      expect(r.status).toBe(409)
      expect(r.data.error.message).toMatch(/Setup is complete/)
      expect((await c.post('/auth/login', { email: 'ada@example.com', password: 'admin-password-1' })).status).toBe(503)
    } finally {
      await new Promise<void>((r) => s2.server.close(() => r()))
      await app2.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60000)

  it('boot retry: a database that is down at start is picked up in the background, no restart', async () => {
    const dir = copyWorkspace()
    let attempts = 0
    const factory = (settings: DatabaseSettings, password: string): SqlDb => {
      attempts++
      if (attempts === 1) {
        const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
        return { dialect: 'postgres', query: async () => { throw err }, exec: async () => { throw err }, tx: async () => { throw err }, serverVersion: async () => '', close: async () => {} }
      }
      return createPgDb(settings, password)
    }
    const app2 = await createApp({ env: {}, config: { workspaceDir: dir }, sqlDbFactory: factory, printSetupCode: false })
    try {
      expect(app2.services.ready()).toBe(false)
      expect(app2.services.state.unavailable).toBe(true)
      const pending = app2.services.retrying()
      expect(pending).not.toBeNull()
      await pending
      expect(app2.services.ready()).toBe(true)
      expect(app2.services.state.unavailable).toBeUndefined()
      expect(attempts).toBe(2)
    } finally {
      await app2.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60000)

  it('downgrade guard: a database with a newer schema is not used at all', async () => {
    await raw.query("UPDATE ab.settings SET v = '99' WHERE k = 'schemaVersion'")
    const dir = copyWorkspace()
    const app2 = await createApp({ env: {}, config: { workspaceDir: dir }, printSetupCode: false })
    const s2 = await serve(app2)
    try {
      expect(app2.services.ready()).toBe(false)
      expect(app2.services.state.incompatible).toEqual({ database: 99, server: SCHEMA_VERSION })
      expect(app2.services.retrying()).toBeNull() // no point in retrying
      const c = new Client(s2.base)
      const st = await c.get('/status')
      expect(st.data.setup).toMatchObject({ incompatible: true, needsDatabase: false })
      expect(st.data.ok).toBe(false)
      expect((await c.post('/data/x/query', {})).status).toBe(503)
      expect((await c.post('/setup/database', { ...dbSettings(), setupCode: 'ABCDEFGH' })).status).toBe(409)
      // nothing was written to the newer database
      const v = await raw.query<{ v: string }>("SELECT v FROM ab.settings WHERE k = 'schemaVersion'")
      expect(v[0].v).toBe('99')
    } finally {
      await new Promise<void>((r) => s2.server.close(() => r()))
      await app2.close()
      fs.rmSync(dir, { recursive: true, force: true })
      await raw.query("UPDATE ab.settings SET v = $1 WHERE k = 'schemaVersion'", [String(SCHEMA_VERSION)])
    }
  }, 60000)

  it('Secure cookie: APPBUILDER_SECURE_COOKIE=1 and a trusted proxy reporting https', async () => {
    const dir = copyWorkspace()
    const app2 = await createApp({ env: { APPBUILDER_TRUST_PROXY: '1' }, config: { workspaceDir: dir }, printSetupCode: false })
    const s2 = await serve(app2)
    const app3 = await createApp({ env: { APPBUILDER_SECURE_COOKIE: '1' }, config: { workspaceDir: dir }, printSetupCode: false })
    const s3 = await serve(app3)
    try {
      const login = (b: string, extra: Record<string, string> = {}) => fetch(b + '/api/v1/auth/login', {
        method: 'POST', headers: { 'X-Appbuilder': '1', 'Content-Type': 'application/json', ...extra },
        body: JSON.stringify({ email: 'ada@example.com', password: 'admin-password-1' }),
      })
      expect((await login(s2.base, { 'X-Forwarded-Proto': 'https' })).headers.get('set-cookie')).toMatch(/; Secure/)
      expect((await login(s2.base)).headers.get('set-cookie')).not.toMatch(/Secure/)
      expect((await login(s3.base)).headers.get('set-cookie')).toMatch(/; Secure/)
      expect((await login(base)).headers.get('set-cookie')).not.toMatch(/Secure/)
    } finally {
      for (const s of [s2, s3]) await new Promise<void>((r) => s.server.close(() => r()))
      await app2.close()
      await app3.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60000)
})
