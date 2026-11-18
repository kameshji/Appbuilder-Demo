/**
 * Environments end to end over HTTP against the sandbox PostgreSQL (P0 package E):
 *   APPBUILDER_TEST_DB=postgres://abdev:abdev-sandbox-only@127.0.0.1:5433/appbuilder_test npx vitest run server/core/environments
 * Install admin vs environment roles, create / copy (schema, data) / rename / lock / delete, access control by header,
 * isolation of same-named tables, roles, apps, attachments and audit between environments, locked production, the
 * in-place solution upgrade (plan, confirm, destructive changes, rollback on failure) and deploy between environments,
 * the per-environment boot migration (one failing environment does not block the others). Creates and drops its database.
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
import { hashPassword } from './password.ts'
import { setQuiet } from './util.ts'
import { runInEnvironment } from './env-context.ts'
import { SCHEMA_VERSION } from './meta-store.ts'

setQuiet(true)

const conn = pgServer
const dbName = testDatabaseName('env')
if (!PG_URL) process.stderr.write(`[server/core environments integration] ${SKIP_PG}\n`)

class Client {
  cookie = ''
  env = ''
  base: string
  constructor(base: string) {
    this.base = base
  }
  async req(method: string, p: string, body?: unknown, o: { env?: string | null; raw?: { data: Buffer; type: string } } = {}) {
    const headers: Record<string, string> = { 'X-Appbuilder': '1' }
    if (this.cookie) headers.Cookie = this.cookie
    const env = o.env === undefined ? this.env : o.env
    if (env) headers['X-Appbuilder-Environment'] = env
    let payload: string | Uint8Array<ArrayBuffer> | undefined
    if (o.raw) {
      headers['Content-Type'] = o.raw.type
      payload = new Uint8Array(o.raw.data)
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
    return { status: res.status, data: (type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer())) as any }
  }
  get = (p: string, env?: string | null) => this.req('GET', p, undefined, { env })
  post = (p: string, b?: unknown, env?: string | null) => this.req('POST', p, b ?? {}, { env })
  patch = (p: string, b: unknown, env?: string | null) => this.req('PATCH', p, b, { env })
  put = (p: string, b: unknown, env?: string | null) => this.req('PUT', p, b, { env })
  del = (p: string, b?: unknown, env?: string | null) => this.req('DELETE', p, b, { env })
}

describe.skipIf(!PG_URL)('environments (PostgreSQL)', () => {
  let app: AppServer
  let server: http.Server
  let tmp = ''
  let base = ''
  let A: Client
  let maker: Client
  let outsider: Client
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => pgQuery<T>(dbName, sql, params)

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-env-'))
    app = await createApp({ env: { APPBUILDER_MAX_ENVIRONMENTS: '4' }, config: { workspaceDir: tmp }, printSetupCode: false })
    server = http.createServer((req, res) => { app.handle(req, res).then((h) => { if (!h) res.writeHead(404).end() }) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    A = new Client(base)
    maker = new Client(base)
    outsider = new Client(base)
    expect((await A.post('/setup/database', { setupCode: app.services.setupCode.current() ?? '', host: conn!.host, port: conn!.port, database: dbName, user: conn!.user, password: conn!.password, createDatabase: true })).status).toBe(200)
    expect((await A.post('/setup/admin', { setupCode: app.services.setupCode.current() ?? '', name: 'Ada', email: 'ada@example.com', password: 'admin-password-1' })).status).toBe(200)
    // a maker in Default, and someone with an account but no environment
    const mk = await A.post('/users', { name: 'Mo Maker', email: 'mo@example.com', roleIds: ['role_maker'], password: 'maker-password-1' })
    expect(mk.status).toBe(200)
    await app.services.meta.users.update(mk.data.id, { mustChangePassword: false })
    const out = await A.post('/users', { name: 'Olga Out', email: 'olga@example.com', roleIds: [], password: 'outsider-pass-1' })
    await app.services.meta.users.update(out.data.id, { mustChangePassword: false })
    expect((await maker.post('/auth/login', { email: 'mo@example.com', password: 'maker-password-1' })).status).toBe(200)
    expect((await outsider.post('/auth/login', { email: 'olga@example.com', password: 'outsider-pass-1' })).status).toBe(200)
  }, 60000)

  afterAll(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    await app?.close()
    if (conn) await dropDatabase(dbName)
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }, 60000)

  it('the first administrator is install administrator; everybody else needs access', async () => {
    const s = await A.get('/auth/session')
    expect(s.data).toMatchObject({ environmentId: 'default', privileges: { isAdmin: true, isInstallAdmin: true } })
    const envs = await A.get('/environments')
    expect(envs.data).toMatchObject({ max: 4, canCreate: true })
    expect(envs.data.items).toEqual([expect.objectContaining({ id: 'default', name: 'Default', type: 'production', builtIn: true, canManage: true })])
    expect((await maker.get('/environments')).data).toMatchObject({ canCreate: false, items: [expect.objectContaining({ id: 'default' })] })
    expect((await maker.get('/environments')).data.items[0].details).toBeUndefined()
    // no environment at all: the session works, the list is empty, environment routes are refused
    expect((await outsider.get('/auth/session')).status).toBe(200)
    expect((await outsider.get('/environments')).data.items).toEqual([])
    const w = await outsider.get('/workspace')
    expect(w.status).toBe(200)
    expect(w.data).toMatchObject({ apps: [], tables: [], environments: [] })
    expect((await outsider.post('/data/Contacts/query', {})).status).toBe(403)
    expect((await outsider.post('/data/Contacts/query', {}, 'default')).status).toBe(403)
    // environment routes are install-admin only
    expect((await maker.post('/environments', { name: 'Mine', type: 'developer' })).status).toBe(403)
    expect((await maker.get('/install/audit')).status).toBe(403)
    // malformed and unknown headers
    expect((await A.get('/workspace', 'Bad Id')).status).toBe(400)
    expect((await A.get('/workspace', 'nope')).status).toBe(404)
  })

  it('creates a sandbox copied from Default (schema + data), inside the database', async () => {
    // an attachment in Default first (it must be copied with the data)
    const contacts = (await A.get('/workspace')).data.tables.find((t: { name: string }) => t.name === 'Contacts')
    const addPhoto = await A.post(`/tables/${contacts.id}/columns`, { displayName: 'Photo', type: 'file' })
    expect(addPhoto.status).toBe(200)
    const rows = (await A.post('/data/Contacts/query', { orderBy: [{ col: 'Name', dir: 'asc' }] })).data.rows
    const up = await A.req('POST', `/attachments?table=Contacts&column=Photo&rowId=${rows[0].id}&name=a.txt`, undefined, { raw: { data: Buffer.from('in default'), type: 'text/plain' } })
    expect(up.status).toBe(200)
    expect(up.data.url).toBe(`/api/v1/attachments/${up.data.id}?env=default`)

    const r = await A.post('/environments', { name: 'Sales test', type: 'sandbox', description: 'Try changes here', copyFrom: 'default', copy: 'data' })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    expect(r.data).toMatchObject({ id: 'sales_test', name: 'Sales test', type: 'sandbox', builtIn: false, description: 'Try changes here', canManage: true })
    expect(r.data.state).toBeUndefined()
    const reg = await q('SELECT id, schema_name, state, schema_version, created_by FROM ab.environments WHERE id = $1', ['sales_test'])
    expect(reg).toEqual([{ id: 'sales_test', schema_name: 'env_sales_test', state: 'ready', schema_version: SCHEMA_VERSION, created_by: expect.stringMatching(/^user_/) }])
    // same tables (ids too), same rows, apps, roles; attachments copied on disk and in the table
    const d = (await A.get('/workspace', 'default')).data
    const s = (await A.get('/workspace', 'sales_test')).data
    expect(s.tables.map((t: { id: string }) => t.id).sort()).toEqual(d.tables.map((t: { id: string }) => t.id).sort())
    expect(s.apps.map((a: { id: string }) => a.id)).toEqual(d.apps.map((a: { id: string }) => a.id))
    expect(s.roles.map((x: { id: string }) => x.id).sort()).toEqual(d.roles.map((x: { id: string }) => x.id).sort())
    const sRows = (await A.post('/data/Contacts/query', { orderBy: [{ col: 'Name', dir: 'asc' }] }, 'sales_test')).data.rows
    expect(sRows.map((x: { Name: string }) => x.Name)).toEqual(rows.map((x: { Name: string }) => x.Name))
    expect(await q("SELECT count(*)::int AS n FROM env_sales_test.t_orders")).toEqual([{ n: 12 }])
    const got = await A.get(`/attachments/${up.data.id}?env=sales_test`, null)
    expect(got.status).toBe(200)
    expect(Buffer.from(got.data).toString()).toBe('in default')
    expect(fs.existsSync(path.join(tmp, 'env', 'sales_test', 'attachments'))).toBe(true)
    // users' roles are not copied: the creator administers it, others need access
    expect((await maker.get('/workspace', 'sales_test')).status).toBe(403)
    expect(await q('SELECT user_id, is_env_admin FROM ab.environment_access WHERE environment_id = $1', ['sales_test'])).toEqual([{ user_id: expect.any(String), is_env_admin: true }])
    // the audit log is not copied
    expect((await q("SELECT count(*)::int AS n FROM env_sales_test.ab_audit WHERE action = 'setup.admin'"))[0]).toEqual({ n: 0 })
    expect((await q("SELECT action, environment_id FROM ab.audit WHERE action = 'environment.create'"))).toEqual([{ action: 'environment.create', environment_id: 'sales_test' }])
  }, 60000)

  it('isolation: same-named tables, rows, roles, apps, attachments and audit never cross environments', async () => {
    // same table name, same id, different rows
    expect((await A.post('/data/Contacts/rows', { values: { Name: 'Only in sales' } }, 'sales_test')).status).toBe(200)
    expect((await A.post('/data/Contacts/query', { where: { col: 'Name', op: 'eq', value: 'Only in sales' } }, 'default')).data.rows).toEqual([])
    expect((await A.post('/data/Contacts/query', { where: { col: 'Name', op: 'eq', value: 'Only in sales' } }, 'sales_test')).data.rows).toHaveLength(1)
    // a table created in one only
    const t = await A.post('/tables', { displayName: 'Leads', columns: [{ displayName: 'Title', type: 'text' }] }, 'sales_test')
    expect(t.status).toBe(200)
    expect((await A.get('/workspace', 'default')).data.tables.some((x: { name: string }) => x.name === 'Leads')).toBe(false)
    expect((await A.post('/data/Leads/query', {}, 'default')).status).toBe(404)
    // the same name in both, created separately: two different tables
    const t2 = await A.post('/tables', { displayName: 'Leads', columns: [{ displayName: 'Title', type: 'text' }] }, 'default')
    expect(t2.status).toBe(200)
    expect(t2.data.id).not.toBe(t.data.id)
    await A.post('/data/Leads/rows', { values: { Title: 'default lead' } }, 'default')
    expect((await A.post('/data/Leads/query', {}, 'sales_test')).data.rows).toEqual([])
    // roles: same name in both, different privileges
    const rs = await A.post('/roles', { name: 'Clerks', privileges: [] }, 'sales_test')
    const rd = await A.post('/roles', { name: 'Clerks', privileges: [] }, 'default')
    expect(rs.status).toBe(200)
    expect(rd.status).toBe(200)
    expect((await A.get('/workspace', 'default')).data.roles.filter((r: { name: string }) => r.name === 'Clerks').map((r: { id: string }) => r.id)).toEqual([rd.data.id])
    // apps
    const app1 = await A.post('/apps', { name: 'Sales only', width: 1920, height: 1080 }, 'sales_test')
    expect(app1.status).toBe(200)
    expect((await A.get(`/apps/${app1.data.id}`, 'default')).status).toBe(404)
    // attachments: an id from one environment does not resolve in the other
    const row = (await A.post('/data/Contacts/query', { where: { col: 'Name', op: 'eq', value: 'Only in sales' } }, 'sales_test')).data.rows[0]
    const up = await A.req('POST', `/attachments?table=Contacts&column=Photo&rowId=${row.id}&name=s.txt`, undefined, { env: 'sales_test', raw: { data: Buffer.from('in sales'), type: 'text/plain' } })
    expect(up.status).toBe(200)
    expect(up.data.url).toContain('?env=sales_test')
    expect((await A.get(`/attachments/${up.data.id}`, 'default')).status).toBe(404)
    expect((await A.get(`/attachments/${up.data.id}`, 'sales_test')).status).toBe(200)
    expect((await A.post('/attachments/resolve', { ids: [up.data.id] }, 'default')).data.items).toEqual([])
    // the security cache: a role change in one environment is not seen in the other
    const viewerS = (await A.get('/workspace', 'sales_test')).data.roles.find((r: { id: string }) => r.id === 'role_viewer')
    expect(viewerS).toBeTruthy()
    // audit logs are per environment
    const auditS = await A.get('/audit?action=role.create', 'sales_test')
    const auditD = await A.get('/audit?action=role.create', 'default')
    expect(auditS.data.items.map((e: { details: { id: string } }) => e.details.id)).toEqual([rs.data.id])
    expect(auditD.data.items.map((e: { details: { id: string } }) => e.details.id)).toEqual([rd.data.id])
    // caches: connector instances per environment and connection
    const c1 = await runInEnvironment('default', () => app.services.connections.get('conn_default'))
    const c2 = await runInEnvironment('sales_test', () => app.services.connections.get('conn_default'))
    expect(c1).not.toBe(c2)
    // physical tables: each in its own schema
    expect(await q("SELECT table_schema AS s FROM information_schema.tables WHERE table_name = 't_leads' ORDER BY 1")).toEqual([{ s: 'env_default' }, { s: 'env_sales_test' }])
  }, 60000)

  it('access: grant, environment admin, revoke; the last environment is remembered on the user', async () => {
    const users = (await A.get('/workspace')).data.users
    const mo = users.find((u: { email: string }) => u.email === 'mo@example.com')
    expect((await maker.get('/workspace', 'sales_test')).status).toBe(403)
    expect((await A.put(`/environments/sales_test/access/${mo.id}`, {})).status).toBe(200)
    // access without roles: can enter, sees nothing
    const w = await maker.get('/workspace', 'sales_test')
    expect(w.status).toBe(200)
    expect(w.data.session.privileges.isMaker).toBe(false)
    // environment admin there (not install admin): manages its access, not the install
    expect((await A.put(`/environments/sales_test/access/${mo.id}`, { isEnvAdmin: true })).status).toBe(200)
    const w2 = await maker.get('/workspace', 'sales_test')
    expect(w2.data.session.privileges).toMatchObject({ isAdmin: true })
    expect(w2.data.session.privileges.isInstallAdmin).toBeUndefined()
    expect((await maker.get('/environments/sales_test/access')).status).toBe(200)
    expect((await maker.get('/environments/default/access')).status).toBe(403)
    expect((await maker.patch('/environments/sales_test', { name: 'X' })).status).toBe(403)
    expect((await maker.post('/users', { name: 'Z', email: 'z@example.com' }, 'sales_test')).status).toBe(403)
    // in Default the maker is still a maker only
    expect((await maker.get('/workspace', 'default')).data.session.privileges.isAdmin).toBe(false)
    // switching remembers the environment on the user record; a request without the header goes there
    expect((await maker.post('/environments/sales_test/select', {}, null)).status).toBe(200)
    expect((await maker.get('/auth/session', null)).data.environmentId).toBe('sales_test')
    expect((await maker.post('/environments/default/select', {}, null)).status).toBe(200)
    expect((await maker.get('/auth/session', null)).data.environmentId).toBe('default')
    // revoke: roles there go too
    expect((await A.del(`/environments/sales_test/access/${mo.id}`)).status).toBe(200)
    expect((await maker.get('/workspace', 'sales_test')).status).toBe(403)
    expect(await q('SELECT count(*)::int AS n FROM env_sales_test.ab_user_roles WHERE user_id = $1', [mo.id])).toEqual([{ n: 0 }])
    const actions = (await A.get('/install/audit')).data.items.map((e: { action: string }) => e.action)
    expect(actions).toEqual(expect.arrayContaining(['environment.create', 'environment.access_grant', 'environment.access_revoke']))
  }, 60000)

  it('limits, names and the type rules', async () => {
    expect((await A.post('/environments', { name: 'sales TEST', type: 'sandbox' })).status).toBe(409)
    expect((await A.post('/environments', { name: '', type: 'sandbox' })).status).toBe(422)
    expect((await A.post('/environments', { name: 'Bad', type: 'staging' })).status).toBe(422)
    expect((await A.post('/environments', { name: 'Bad', type: 'sandbox', copyFrom: 'nope' })).status).toBe(404)
    // Default cannot stop being production while it is the only one
    expect((await A.patch('/environments/default', { type: 'sandbox' })).status).toBe(409)
    expect((await A.patch('/environments/sales_test', { locked: true })).status).toBe(422) // sandbox
    const dev = await A.post('/environments', { name: 'Dev one', type: 'developer', sampleData: true })
    expect(dev.status, JSON.stringify(dev.data)).toBe(200)
    expect((await A.get('/workspace', 'dev_one')).data.tables.map((t: { name: string }) => t.name).sort()).toEqual(['Contacts', 'Orders'])
    const empty = await A.post('/environments', { name: 'Empty', type: 'sandbox' })
    expect(empty.status).toBe(200)
    expect((await A.get('/workspace', 'empty')).data.tables).toEqual([])
    // the limit is 4 here (APPBUILDER_MAX_ENVIRONMENTS)
    const over = await A.post('/environments', { name: 'Fifth', type: 'sandbox' })
    expect(over.status).toBe(409)
    expect(over.data.error.message).toMatch(/most it allows \(4\)/)
    expect((await A.get('/environments')).data).toMatchObject({ canCreate: false, createBlocked: expect.stringMatching(/APPBUILDER_MAX_ENVIRONMENTS/) })
    // details with sizes
    const det = await A.get('/environments/sales_test')
    expect(det.data).toMatchObject({ id: 'sales_test', accessCount: 1, sizes: { tables: expect.any(Number), databaseBytes: expect.any(Number), attachmentBytes: expect.any(Number) } })
    expect(det.data.sizes.tables).toBeGreaterThanOrEqual(3)
    expect(det.data.sizes.attachments).toBeGreaterThanOrEqual(2)
    // delete: typed name, not Default
    expect((await A.del('/environments/empty', { confirmName: 'empty' })).status).toBe(422)
    expect((await A.del('/environments/default', { confirmName: 'Default' })).status).toBe(409)
    expect((await A.del('/environments/empty', { confirmName: 'Empty' })).status).toBe(200)
    expect((await A.del('/environments/dev_one', { confirmName: 'Dev one' })).status).toBe(200)
    expect(await q("SELECT nspname FROM pg_namespace WHERE nspname IN ('env_empty', 'env_dev_one')")).toEqual([])
    expect(fs.existsSync(path.join(tmp, 'env', 'dev_one'))).toBe(false)
    expect((await A.get('/workspace', 'dev_one')).status).toBe(404)
  }, 60000)

  it('locked production refuses design changes but keeps data, users and solution import working', async () => {
    expect((await A.patch('/environments/default', { locked: true })).status).toBe(200)
    expect((await A.get('/environments')).data.items.find((e: { id: string }) => e.id === 'default')).toMatchObject({ locked: true })
    const contacts = (await A.get('/workspace', 'default')).data.tables.find((t: { name: string }) => t.name === 'Contacts')
    const appId = (await A.get('/workspace', 'default')).data.apps[0].id
    for (const [m, p, b] of [
      ['POST', '/tables', { displayName: 'Nope' }],
      ['POST', `/tables/${contacts.id}/columns`, { displayName: 'Nope', type: 'text' }],
      ['PATCH', `/tables/${contacts.id}`, { displayName: 'Renamed' }],
      ['POST', '/apps', { name: 'Nope', width: 1920, height: 1080 }],
      ['PUT', `/apps/${appId}`, { definition: (await A.get(`/apps/${appId}`, 'default')).data.definition }],
      ['POST', '/roles', { name: 'Nope' }],
      ['POST', '/solutions', { displayName: 'Nope' }],
    ] as const) {
      const r = await A.req(m, p, b, { env: 'default' })
      expect(r.status, `${m} ${p}`).toBe(403)
      expect(r.data.error.message).toMatch(/locked/)
    }
    // data still changes; the sandbox is not locked
    expect((await A.post('/data/Contacts/rows', { values: { Name: 'Locked but alive' } }, 'default')).status).toBe(200)
    expect((await A.post('/tables', { displayName: 'Allowed' }, 'sales_test')).status).toBe(200)
    expect((await q("SELECT action FROM ab.audit WHERE action = 'environment.lock'"))).toHaveLength(1)
  }, 60000)

  let solId = ''
  it('deploy from the sandbox to Default: plan, destructive changes highlighted, confirm, data kept', async () => {
    // a solution in the sandbox with the (shared) Contacts table and app; then changes there
    const ws = (await A.get('/workspace', 'sales_test')).data
    const contacts = ws.tables.find((t: { name: string }) => t.name === 'Contacts')
    const appId = ws.apps.find((a: { name: string }) => a.name === 'Contacts app').id
    const sol = await A.post('/solutions', { displayName: 'CRM', version: '1.0.0' }, 'sales_test')
    solId = sol.data.id
    for (const [kind, id] of [['table', contacts.id], ['app', appId], ['role', 'role_viewer']]) {
      expect((await A.post(`/solutions/${solId}/components`, { kind, id }, 'sales_test')).status).toBe(200)
    }
    expect((await A.post(`/tables/${contacts.id}/columns`, { displayName: 'Score', type: 'number' }, 'sales_test')).status).toBe(200)
    expect((await A.req('DELETE', `/tables/${contacts.id}/columns/City`, undefined, { env: 'sales_test' })).status).toBe(200)
    const def = (await A.get(`/apps/${appId}`, 'sales_test')).data.definition
    def.screens[0].props.Fill = '=Color.LightBlue'
    expect((await A.req('PUT', `/apps/${appId}`, { definition: def }, { env: 'sales_test' })).status).toBe(200)
    await A.patch(`/solutions/${solId}`, { version: '1.1.0' }, 'sales_test')
    const before = (await A.post('/data/Contacts/query', { count: true }, 'default')).data.total

    const plan = await A.post(`/solutions/${solId}/deploy`, { target: 'default', plan: true }, 'sales_test')
    expect(plan.status, JSON.stringify(plan.data)).toBe(200)
    expect(plan.data).toMatchObject({ mode: 'upgrade', target: { id: 'default', locked: true }, destructive: true, problems: [], backup: { available: false } })
    const t = plan.data.items.find((i: { kind: string; id: string }) => i.kind === 'table' && i.id === contacts.id)
    expect(t).toMatchObject({ change: 'changed', destructive: true })
    expect(t.columns).toEqual(expect.arrayContaining([{ name: 'City', change: 'removed', from: 'text', destructive: true }, { name: 'Score', change: 'added', to: 'number' }]))
    expect(plan.data.items.find((i: { kind: string }) => i.kind === 'app')).toMatchObject({ id: appId, change: 'changed' })
    // without the token: refused; with a stale token: refused
    expect((await A.post(`/solutions/${solId}/deploy`, { target: 'default' }, 'sales_test')).status).toBe(409)
    expect((await A.post(`/solutions/${solId}/deploy`, { target: 'default', confirm: 'stale' }, 'sales_test')).status).toBe(409)
    // a maker without access to the target cannot deploy there
    expect((await maker.post(`/solutions/${solId}/deploy`, { target: 'default', plan: true }, 'sales_test')).status).toBe(403)
    const done = await A.post(`/solutions/${solId}/deploy`, { target: 'default', confirm: plan.data.token }, 'sales_test')
    expect(done.status, JSON.stringify(done.data)).toBe(200)
    expect(done.data).toMatchObject({ id: solId, version: '1.1.0', backup: { taken: false } })
    expect(done.data.warnings.join(' ')).toMatch(/No backup was taken/)
    // Default now has the column changes and the app change; rows are all still there (Score empty, City gone)
    const dws = (await A.get('/workspace', 'default')).data
    const dc = dws.tables.find((x: { id: string }) => x.id === contacts.id)
    expect(dc.columns.map((c: { name: string }) => c.name)).toContain('Score')
    expect(dc.columns.map((c: { name: string }) => c.name)).not.toContain('City')
    expect((await A.post('/data/Contacts/query', { count: true }, 'default')).data.total).toBe(before)
    expect((await A.get(`/apps/${appId}`, 'default')).data.definition.screens[0].props.Fill).toBe('=Color.LightBlue')
    expect(dws.solutions.find((x: { id: string }) => x.id === solId)).toMatchObject({ version: '1.1.0' })
    expect((await q("SELECT action FROM env_default.ab_audit WHERE action = 'solution.upgrade'"))).toHaveLength(1)
    expect((await q("SELECT environment_id FROM ab.audit WHERE action = 'solution.deploy'"))).toEqual([{ environment_id: 'default' }])
    // the same deploy again: nothing to change
    const again = await A.post(`/solutions/${solId}/deploy`, { target: 'default', plan: true }, 'sales_test')
    expect(again.data.items.every((i: { change: string }) => i.change === 'unchanged')).toBe(true)
  }, 60000)

  it('a failing upgrade changes nothing (one transaction, DDL included)', async () => {
    const ws = (await A.get('/workspace', 'sales_test')).data
    const contacts = ws.tables.find((t: { name: string }) => t.name === 'Contacts')
    // in Default a value that cannot become a number; in the sandbox the column becomes a number, plus a new table
    expect((await A.patch('/environments/default', { locked: false })).status).toBe(200)
    expect((await A.post(`/tables/${contacts.id}/columns`, { displayName: 'Ext', type: 'text' }, 'default')).status).toBe(200)
    await A.post('/data/Contacts/rows', { values: { Name: 'Bad ext', Ext: 'not a number' } }, 'default')
    expect((await A.post(`/tables/${contacts.id}/columns`, { displayName: 'Ext', type: 'number' }, 'sales_test')).status).toBe(200)
    const nt = await A.post('/tables', { displayName: 'Visits', columns: [{ displayName: 'When', type: 'date' }] }, 'sales_test')
    await A.post(`/solutions/${solId}/components`, { kind: 'table', id: nt.data.id }, 'sales_test')
    // the plan shows a type change (Default has Ext as text; the package as number)
    const plan = await A.post(`/solutions/${solId}/deploy`, { target: 'default', plan: true }, 'sales_test')
    const t = plan.data.items.find((i: { id: string }) => i.id === contacts.id)
    expect(t.columns).toEqual(expect.arrayContaining([{ name: 'Ext', change: 'type', from: 'text', to: 'number' }]))
    expect(plan.data.items.find((i: { id: string }) => i.id === nt.data.id)).toMatchObject({ change: 'new' })
    const r = await A.post(`/solutions/${solId}/deploy`, { target: 'default', confirm: plan.data.token }, 'sales_test')
    expect(r.status).toBe(422)
    expect(r.data.error.message).toMatch(/Ext/)
    // nothing happened in Default: no Visits table (metadata or physical), Ext still text, the solution still 1.1.0
    expect(await q("SELECT count(*)::int AS n FROM env_default.ab_tables WHERE name = 'Visits'")).toEqual([{ n: 0 }])
    expect(await q("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'env_default' AND table_name = 't_visits'")).toEqual([{ n: 0 }])
    expect(await q("SELECT data_type FROM information_schema.columns WHERE table_schema = 'env_default' AND table_name = 't_contacts' AND column_name = 'Ext'")).toEqual([{ data_type: 'character varying' }])
    expect((await A.get('/workspace', 'default')).data.solutions.find((x: { id: string }) => x.id === solId).version).toBe('1.1.0')
    expect((await q("SELECT count(*)::int AS n FROM env_default.ab_audit WHERE action = 'solution.upgrade'"))).toEqual([{ n: 1 }])
  }, 60000)

  it('an import into an empty environment installs with the package ids (a later import upgrades)', async () => {
    const yaml = (await A.get(`/solutions/${solId}/package`, 'sales_test')).data.yaml
    const e = await A.post('/environments', { name: 'Fresh', type: 'sandbox' })
    expect(e.status).toBe(200)
    const plan = await A.post('/solutions/import/plan', { yaml }, 'fresh')
    expect(plan.data.mode).toBe('install')
    const imp = await A.post('/solutions/import', { yaml }, 'fresh')
    expect(imp.status, JSON.stringify(imp.data)).toBe(200)
    expect(imp.data.id).toBe(solId)
    const fw = (await A.get('/workspace', 'fresh')).data
    const sw = (await A.get('/workspace', 'sales_test')).data
    const ids = (w: { solutions: { id: string; components: { kind: string; id: string }[] }[] }) => w.solutions.find((x) => x.id === solId)!.components.map((c) => `${c.kind}:${c.id}`).sort()
    expect(ids(fw)).toEqual(ids(sw))
    expect((await A.post('/solutions/import/plan', { yaml }, 'fresh')).data.mode).toBe('upgrade')
    expect((await A.del('/environments/fresh', { confirmName: 'Fresh' })).status).toBe(200)
  }, 60000)

  it('boot migration: one failing environment is marked failed and does not block the others', async () => {
    // pretend a newer server migrated the sandbox: this server must not touch it (downgrade guard per environment)
    await q('UPDATE ab.environments SET schema_version = $1 WHERE id = $2', [SCHEMA_VERSION + 1, 'sales_test'])
    const summary = await app.services.meta.migrate()
    expect(summary).toMatchObject({ from: SCHEMA_VERSION, to: SCHEMA_VERSION })
    expect((summary as { environments: { id: string; ok: boolean }[] }).environments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'default', ok: true }), expect.objectContaining({ id: 'sales_test', ok: false }),
    ]))
    app.services.environments.invalidate()
    expect((await q('SELECT state FROM ab.environments WHERE id = $1', ['sales_test']))[0]).toEqual({ state: 'failed' })
    const r = await A.get('/workspace', 'sales_test')
    expect(r.status).toBe(503)
    expect(r.data.error.message).toMatch(/newer Appbuilder/)
    expect((await A.get('/workspace', 'default')).status).toBe(200)
    // back to the right version: the next migration clears the failure
    await q('UPDATE ab.environments SET schema_version = $1 WHERE id = $2', [SCHEMA_VERSION, 'sales_test'])
    await app.services.meta.migrate()
    app.services.environments.invalidate()
    expect((await A.get('/workspace', 'sales_test')).status).toBe(200)
  }, 60000)

  it('install administrators: the flag is install-level, audited, and the last one is kept', async () => {
    const me = (await A.get('/auth/session')).data.user
    expect((await A.patch(`/users/${me.id}`, { isInstallAdmin: false })).status).toBe(409)
    const users = (await A.get('/workspace')).data.users
    const mo = users.find((u: { email: string }) => u.email === 'mo@example.com')
    expect((await maker.patch(`/users/${mo.id}`, { isInstallAdmin: true })).status).toBe(403)
    expect((await A.patch(`/users/${mo.id}`, { isInstallAdmin: true })).status).toBe(200)
    // an install admin enters every environment without an access row
    expect((await maker.get('/workspace', 'sales_test')).status).toBe(200)
    expect((await maker.get('/environments')).data.items.map((e: { id: string }) => e.id).sort()).toEqual(['default', 'sales_test'])
    expect((await A.patch(`/users/${mo.id}`, { isInstallAdmin: false })).status).toBe(200)
    expect((await maker.get('/workspace', 'sales_test')).status).toBe(403)
    expect((await q("SELECT action FROM ab.audit WHERE action LIKE 'install.admin_%' ORDER BY id"))).toEqual([{ action: 'install.admin_grant' }, { action: 'install.admin_grant' }, { action: 'install.admin_revoke' }])
  }, 60000)

  it('deleting the sandbox: switch away first; schema, folder and access go; the deletion is audited', async () => {
    // a request that works in the environment cannot delete it
    expect((await A.del('/environments/sales_test', { confirmName: 'Sales test' }, 'sales_test')).status).toBe(409)
    expect((await A.del('/environments/sales_test', { confirmName: 'Sales test' }, 'default')).status).toBe(200)
    expect(await q("SELECT nspname FROM pg_namespace WHERE nspname = 'env_sales_test'")).toEqual([])
    expect(await q("SELECT count(*)::int AS n FROM ab.environment_access WHERE environment_id = 'sales_test'")).toEqual([{ n: 0 }])
    expect(fs.existsSync(path.join(tmp, 'env', 'sales_test'))).toBe(false)
    expect((await q("SELECT details->>'name' AS name FROM ab.audit WHERE action = 'environment.delete' AND environment_id = 'sales_test'"))).toEqual([{ name: 'Sales test' }])
    // the last production environment cannot be deleted (Default is also built-in)
    expect((await A.del('/environments/default', { confirmName: 'Default' })).status).toBe(409)
  }, 60000)
})

/**
 * Upgrade from the single-environment layout (schema version 4, P0 package A): a database as that version left it, with
 * an administrator, a maker, a table with rows, an app, an attachment in workspace/attachments and a data file in
 * workspace/files. Opening it migrates it to version 5 without losing anything.
 */
describe.skipIf(!PG_URL)('migration from the version 4 layout (PostgreSQL)', () => {
  const db4 = testDatabaseName('v4')
  let tmp = ''
  let app: AppServer | null = null
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => pgQuery<T>(db4, sql, params)

  afterAll(async () => {
    await app?.close()
    if (conn) await dropDatabase(db4)
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }, 60000)

  it('keeps users, roles, tables, rows, apps, attachments and files; admins become install admins', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-v4-'))
    await pgQuery(conn!.database, `CREATE DATABASE "${db4}" ENCODING 'UTF8' TEMPLATE template0`)
    const { environmentDdl } = await import('./meta-store.ts')
    // schema ab exactly as version 4 created it
    const v4: string[] = [
      'CREATE SCHEMA ab',
      'CREATE TABLE ab.settings (k text PRIMARY KEY, v text NULL)',
      "CREATE TABLE ab.users (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL, password_hash text NULL, status text NOT NULL DEFAULT 'active', must_change_password boolean NOT NULL DEFAULT false, created_on timestamptz NOT NULL, last_login timestamptz NULL)",
      'CREATE UNIQUE INDEX ab_ux_users_email ON ab.users (email)',
      'CREATE TABLE ab.sessions (id_hash text PRIMARY KEY, user_id text NOT NULL, created_on timestamptz NOT NULL, expires_on timestamptz NOT NULL, last_seen timestamptz NOT NULL, user_agent text NULL)',
      "CREATE TABLE ab.environments (id text PRIMARY KEY, name text NOT NULL, schema_name text NOT NULL UNIQUE, type text NOT NULL DEFAULT 'production', built_in boolean NOT NULL DEFAULT false, created_on timestamptz NOT NULL)",
      'CREATE TABLE ab.licence (id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1), document jsonb NULL, installed_on timestamptz NULL)',
      ...environmentDdl('env_default'),
      "INSERT INTO ab.environments VALUES ('default', 'Default', 'env_default', 'production', true, now())",
      "INSERT INTO ab.settings VALUES ('schemaVersion', '4')",
    ]
    const hash = await hashPassword('old-admin-pass-1')
    const hash2 = await hashPassword('old-maker-pass-1')
    v4.push(
      `INSERT INTO ab.users VALUES ('user_old', 'Old Admin', 'old@example.com', '${hash}', 'active', false, now(), NULL)`,
      `INSERT INTO ab.users VALUES ('user_mk', 'Old Maker', 'mk@example.com', '${hash2}', 'active', false, now(), NULL)`,
      `INSERT INTO env_default.ab_roles VALUES ('role_admin', 'Administrator', NULL, true, false, '"all"'), ('role_maker', 'Maker', NULL, false, true, '"all"')`,
      "INSERT INTO env_default.ab_user_roles VALUES ('user_old', 'role_admin'), ('user_mk', 'role_maker')",
      `INSERT INTO env_default.ab_connections (id, name, connector, settings, status, is_default, scope, created_on, modified_on) VALUES ('conn_default', 'Default database', 'postgres', '{}', 'connected', true, 'server', now(), now())`,
      `INSERT INTO env_default.ab_tables VALUES ('tbl_n', 'Notes', 'conn_default', 't_notes', '{"id":"tbl_n","name":"Notes","displayName":"Notes","primaryColumn":"Title","managed":true,"connectionId":"conn_default","source":"t_notes","createdOn":"2026-01-01T00:00:00.000Z","modifiedOn":"2026-01-01T00:00:00.000Z","columns":[{"name":"id","displayName":"Id","type":"text","system":true},{"name":"createdOn","displayName":"Created on","type":"datetime","system":true},{"name":"modifiedOn","displayName":"Modified on","type":"datetime","system":true},{"name":"createdBy","displayName":"Created by","type":"text","system":true},{"name":"owner","displayName":"Owner","type":"text","system":true},{"name":"Title","displayName":"Title","type":"text"},{"name":"Doc","displayName":"Doc","type":"file"}]}', now(), now())`,
      `INSERT INTO env_default.ab_role_tables VALUES ('role_maker', 'tbl_n', true, 'all', 'all', 'all', NULL, NULL)`,
      'CREATE TABLE env_default.t_notes (id text PRIMARY KEY, "createdOn" timestamptz(3), "modifiedOn" timestamptz(3), "createdBy" text, owner text, "Title" varchar(255), "Doc" text)',
      `INSERT INTO env_default.t_notes VALUES ('0190a0a0-0000-7000-8000-000000000001', now(), now(), 'user_old', 'user_old', 'First note', '["att_old"]')`,
      `INSERT INTO env_default.ab_attachments VALUES ('att_old', 'tbl_n', 'Doc', '0190a0a0-0000-7000-8000-000000000001', 'old.txt', 'text/plain', 3, 'x', '${'ab'.repeat(16)}', 'user_old', now())`,
      `INSERT INTO env_default.ab_apps VALUES ('app_old', 'Old app', NULL, 1920, 1080, '{"formatVersion":2,"name":"Old app","width":1920,"height":1080,"screens":[{"id":"s1","name":"Screen1","type":"Screen","props":{},"children":[]}]}', now(), now(), 'Old Admin')`,
    )
    for (const stmt of v4) await q(stmt)
    // the version 4 workspace: attachments/ and files/ directly in the workspace
    fs.mkdirSync(path.join(tmp, 'attachments', 'ab'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'attachments', 'ab', 'ab'.repeat(16)), 'old')
    fs.mkdirSync(path.join(tmp, 'files', 'file_x'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'files', 'file_x', 'data.csv'), 'a\n1\n')

    app = await createApp({
      env: { APPBUILDER_DB_HOST: conn!.host, APPBUILDER_DB_PORT: String(conn!.port), APPBUILDER_DB_NAME: db4, APPBUILDER_DB_USER: conn!.user, APPBUILDER_DB_PASSWORD: conn!.password },
      config: { workspaceDir: tmp }, printSetupCode: false,
    })
    expect(app.services.ready()).toBe(true)
    expect(app.services.state.migration).toMatchObject({ from: 4, to: SCHEMA_VERSION })
    expect(await q("SELECT v FROM ab.settings WHERE k = 'schemaVersion'")).toEqual([{ v: String(SCHEMA_VERSION) }])
    expect(await q('SELECT id, is_install_admin FROM ab.users ORDER BY id')).toEqual([{ id: 'user_mk', is_install_admin: false }, { id: 'user_old', is_install_admin: true }])
    expect(await q('SELECT user_id, is_env_admin FROM ab.environment_access ORDER BY user_id')).toEqual([{ user_id: 'user_mk', is_env_admin: false }, { user_id: 'user_old', is_env_admin: true }])
    expect(await q("SELECT state, schema_version FROM ab.environments WHERE id = 'default'")).toEqual([{ state: 'ready', schema_version: SCHEMA_VERSION }])
    // files moved into the Default environment folder
    expect(fs.existsSync(path.join(tmp, 'env', 'default', 'attachments', 'ab', 'ab'.repeat(16)))).toBe(true)
    expect(fs.existsSync(path.join(tmp, 'env', 'default', 'files', 'file_x', 'data.csv'))).toBe(true)
    expect(fs.existsSync(path.join(tmp, 'attachments'))).toBe(false)
    // and everything works as before
    server = http.createServer((req, res) => { app!.handle(req, res).then((h) => { if (!h) res.writeHead(404).end() }) })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const c = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    const login = await c.post('/auth/login', { email: 'old@example.com', password: 'old-admin-pass-1' })
    expect(login.status).toBe(200)
    expect(login.data).toMatchObject({ environmentId: 'default', privileges: { isAdmin: true, isInstallAdmin: true } })
    expect((await c.post('/data/Notes/query', {})).data.rows.map((r: { Title: string }) => r.Title)).toEqual(['First note'])
    const att = await c.get('/attachments/att_old')
    expect(att.status).toBe(200)
    expect(Buffer.from(att.data).toString()).toBe('old')
    expect((await c.get('/apps/app_old')).status).toBe(200)
    const mk = new Client(c.base)
    expect((await mk.post('/auth/login', { email: 'mk@example.com', password: 'old-maker-pass-1' })).data.privileges).toMatchObject({ isMaker: true, isAdmin: false })
    expect(await q("SELECT action FROM ab.audit WHERE action = 'schema.migrate'")).toHaveLength(1)
    await new Promise<void>((r) => server!.close(() => r()))
    server = null
  }, 60000)
  let server: http.Server | null = null
})
