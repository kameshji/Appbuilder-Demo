/**
 * Units of work on PostgreSQL (transactional DDL), over HTTP against the sandbox server:
 *   APPBUILDER_TEST_DB=postgres://abdev:abdev-sandbox-only@127.0.0.1:5433/appbuilder_test npx vitest run server/core/transactions
 * A solution import, an app import, a table create and a column change that fail at the very end leave nothing behind,
 * even when the compensating undo of the routes is disabled (the physical tables, columns, rows and metadata go with the
 * ROLLBACK); while a unit of work runs, its DDL is invisible to other connections. Also: the environment layout of
 * created tables. Creates and drops its own database.
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
import type { Connector } from './contracts.ts'
import { setQuiet } from './util.ts'

setQuiet(true)

const conn = pgServer
const dbName = testDatabaseName('tx')
if (!PG_URL) process.stderr.write(`[server/core transactions integration] ${SKIP_PG}\n`)

class Client {
  cookie = ''
  base: string
  constructor(base: string) {
    this.base = base
  }
  async req(method: string, p: string, body?: unknown) {
    const headers: Record<string, string> = { 'X-Appbuilder': '1' }
    if (this.cookie) headers.Cookie = this.cookie
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(this.base + '/api/v1' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const [name, value] = pair.split('=')
      if (name === 'ab_session') this.cookie = value ? `ab_session=${value}` : ''
    }
    const type = res.headers.get('content-type') ?? ''
    return { status: res.status, data: (type.includes('json') ? await res.json() : await res.text()) as any }
  }
  get = (p: string) => this.req('GET', p)
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {})
  patch = (p: string, b: unknown) => this.req('PATCH', p, b)
}

describe.skipIf(!PG_URL)('units of work (PostgreSQL)', () => {
  let app: AppServer
  let server: http.Server
  let tmp = ''
  let A: Client
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => pgQuery<T>(dbName, sql, params)
  /** what is in the environment: metadata rows and physical tables */
  const snapshot = async () => ({
    tables: (await q<{ name: string }>('SELECT name FROM env_default.ab_tables ORDER BY name')).map((r) => r.name),
    physical: (await q<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'env_default' AND table_name NOT LIKE 'ab\\_%' ORDER BY 1")).map((r) => r.t),
    apps: (await q<{ name: string }>('SELECT name FROM env_default.ab_apps ORDER BY name')).map((r) => r.name),
    roles: (await q<{ name: string }>('SELECT name FROM env_default.ab_roles ORDER BY name')).map((r) => r.name),
    privileges: Number((await q<{ n: number }>('SELECT count(*)::int AS n FROM env_default.ab_role_tables'))[0].n),
    solutions: (await q<{ name: string }>('SELECT name FROM env_default.ab_solutions ORDER BY name')).map((r) => r.name),
    counters: Number((await q<{ n: number }>('SELECT count(*)::int AS n FROM env_default.ab_counters'))[0].n),
  })
  let connector: Connector
  let realDrop: Connector['dropTable']
  let realDropColumn: Connector['dropColumn']
  /** the routes' compensating undo drops what they created: switch it off to prove the ROLLBACK does the work */
  const noUndo = () => { connector.dropTable = async () => {}; connector.dropColumn = async () => {} }
  const restore = () => { connector.dropTable = realDrop; connector.dropColumn = realDropColumn }

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-tx-'))
    app = await createApp({ env: {}, config: { workspaceDir: tmp }, printSetupCode: false })
    server = http.createServer((req, res) => { app.handle(req, res).then((h) => { if (!h) res.writeHead(404).end() }) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    A = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    expect((await A.post('/setup/database', { setupCode: app.services.setupCode.current() ?? '', host: conn!.host, port: conn!.port, database: dbName, user: conn!.user, password: conn!.password, createDatabase: true })).status).toBe(200)
    expect((await A.post('/setup/admin', { setupCode: app.services.setupCode.current() ?? '', name: 'Ada', email: 'ada@example.com', password: 'admin-password-1' })).status).toBe(200)
    connector = await app.services.connections.get('conn_default')
    realDrop = connector.dropTable.bind(connector)
    realDropColumn = connector.dropColumn.bind(connector)
  }, 60000)

  afterAll(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    await app?.close()
    if (conn) await dropDatabase(dbName)
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }, 60000)

  it('tables of the default connection live in the environment schema; metadata in env_default, users in ab', async () => {
    const t = await A.post('/tables', { displayName: 'Projects', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Budget', type: 'currency' }, { displayName: 'Code', type: 'autonumber', prefix: 'P-' }] })
    expect(t.status, JSON.stringify(t.data)).toBe(200)
    expect(t.data).toMatchObject({ source: 't_projects', connectionId: 'conn_default', managed: true })
    expect((await q("SELECT to_regclass('env_default.t_projects')::text AS t"))[0]).toEqual({ t: 'env_default.t_projects' })
    expect((await q("SELECT to_regclass('public.t_projects') AS t"))[0]).toEqual({ t: null })
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM ab.users'))[0].n).toBe(1)
    for (const title of ['One', 'Two']) expect((await A.post('/data/Projects/rows', { values: { Title: title, Budget: 12.5 } })).status).toBe(200)
    const rows = (await A.post('/data/Projects/query', { orderBy: [{ col: 'Code', dir: 'asc' }] })).data.rows
    expect(rows.map((r: any) => [r.Title, r.Budget, r.Code])).toEqual([['One', 12.5, 'P-0001'], ['Two', 12.5, 'P-0002']])
    // the sample app and its tables were seeded by the setup into the same schema
    expect((await snapshot()).physical).toEqual(expect.arrayContaining(['t_projects']))
  }, 60000)

  it('solution import is all or nothing: a failure at the very end leaves no table, row, app, role or solution', async () => {
    const kit = await A.post('/tables', { displayName: 'Kit items', columns: [{ displayName: 'Label', type: 'text', unique: true }, { displayName: 'Qty', type: 'number' }] })
    expect(kit.status, JSON.stringify(kit.data)).toBe(200)
    for (const [Label, Qty] of [['a', 1], ['b', 2]]) expect((await A.post('/data/KitItems/rows', { values: { Label, Qty } })).status).toBe(200)
    const sol = (await A.post('/solutions', { displayName: 'Kit' })).data
    const role = (await A.post('/roles', { name: 'Kit role', apps: 'all', privileges: [{ table: kit.data.id, create: true, read: 'all', update: 'own', delete: 'none' }] })).data
    const appMeta = (await A.post('/apps', { name: 'Kit app', width: 1920, height: 1080 })).data
    for (const [kind, id] of [['table', kit.data.id], ['app', appMeta.id], ['role', role.id]]) expect((await A.post(`/solutions/${sol.id}/components`, { kind, id })).status).toBe(200)
    const { yaml } = (await A.get(`/solutions/${sol.id}/package?data=1`)).data
    expect(yaml).toContain('appbuilder/solution')
    // the target installation does not have the table: the import must create it (and its rows)
    expect((await A.req('DELETE', `/tables/${kit.data.id}?dropSource=1`)).status).toBe(200)
    expect((await q("SELECT to_regclass('env_default.t_kititems') AS t"))[0]).toEqual({ t: null })

    const before = await snapshot()
    const meta = app.services.meta
    const upsert = meta.solutions.upsert
    let seenInside: { t: string; n: number }[] = []
    let seenOutside: unknown[] = ['not checked']
    noUndo()
    meta.solutions.upsert = async () => {
      // the import is done except for this last write: inside the unit of work the new table and its rows exist ...
      seenInside = await meta.db.query<{ t: string; n: number }>("SELECT 't_kititems' AS t, count(*)::int AS n FROM env_default.t_kititems")
      // ... and no other connection can see the table (DDL is part of the transaction)
      seenOutside = await q("SELECT table_name FROM information_schema.tables WHERE table_schema = 'env_default' AND table_name = 't_kititems'")
      throw new Error('simulated failure at the end of the import')
    }
    try {
      const r = await A.post('/solutions/import', { yaml })
      expect(r.status).toBe(500)
    } finally {
      meta.solutions.upsert = upsert
      restore()
    }
    expect(seenInside).toEqual([{ t: 't_kititems', n: 2 }])
    expect(seenOutside).toEqual([])
    expect(await snapshot()).toEqual(before)
    expect((await q("SELECT count(*)::int AS n FROM env_default.ab_audit WHERE action = 'solution.import'"))[0]).toEqual({ n: 0 })

    // the same package imports cleanly afterwards: the table (with its rows), app, role and solution
    const ok = await A.post('/solutions/import', { yaml })
    expect(ok.status, JSON.stringify(ok.data)).toBe(200)
    const after = await snapshot()
    expect(after.physical).toEqual([...before.physical, 't_kititems'].sort())
    expect(after.tables).toEqual([...before.tables, 'KitItems'].sort())
    expect(after.apps.length).toBe(before.apps.length + 1)
    expect(after.roles.length).toBe(before.roles.length + 1)
    expect(after.solutions.length).toBe(before.solutions.length + 1)
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM env_default.t_kititems'))[0].n).toBe(2)
  }, 60000)

  it('app import with tables is all or nothing', async () => {
    const tbl = (await app.services.meta.tables.get('Projects'))!
    const appMeta = (await A.post('/apps', { name: 'Pkg app', width: 1920, height: 1080 })).data
    const def = (await A.get(`/apps/${appMeta.id}`)).data.definition
    expect((await A.req('PUT', `/apps/${appMeta.id}`, { definition: { ...def, dataSources: [tbl.name] } })).status).toBe(200)
    const { yaml } = (await A.get(`/apps/${appMeta.id}/package?data=1`)).data
    const before = await snapshot()
    const meta = app.services.meta
    const upsert = meta.apps.upsert
    noUndo()
    meta.apps.upsert = async () => { throw new Error('simulated failure') }
    try {
      expect((await A.post('/apps/import', { yaml })).status).toBe(500)
    } finally {
      meta.apps.upsert = upsert
      restore()
    }
    expect(await snapshot()).toEqual(before)
  }, 60000)

  it('table create and column add are all or nothing (no physical table or column is left behind)', async () => {
    const meta = app.services.meta
    const before = await snapshot()
    const grant = meta.roles.upsert
    noUndo()
    // creating a table writes the table definition, the physical table and default privileges: fail the last step
    meta.roles.upsert = async () => { throw new Error('simulated failure') }
    try {
      const r = await A.post('/tables', { displayName: 'Ghost', columns: [{ displayName: 'Name', type: 'text', unique: true }] })
      expect(r.status, JSON.stringify(r.data)).toBe(500)
    } finally {
      meta.roles.upsert = grant
      restore()
    }
    expect(await snapshot()).toEqual(before)
    expect((await q("SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'env_default' AND tablename = 't_ghost'"))[0]).toEqual({ n: 0 })

    // add column: the ALTER TABLE goes with the failed metadata write
    const tables = meta.tables.upsert
    meta.tables.upsert = async () => { throw new Error('simulated failure') }
    noUndo()
    try {
      expect((await A.post('/tables/Projects/columns', { displayName: 'Phase', type: 'choice', choices: ['a', 'b'] })).status).toBeGreaterThanOrEqual(400)
    } finally {
      meta.tables.upsert = tables
      restore()
    }
    const cols = (await q<{ c: string }>("SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'env_default' AND table_name = 't_projects'")).map((r) => r.c)
    expect(cols).not.toContain('Phase')
    expect((await A.post('/tables/Projects/columns', { displayName: 'Phase', type: 'choice', choices: ['a', 'b'] })).status).toBe(200)
  }, 60000)

  it('a failed type change keeps the column and its values', async () => {
    expect((await A.post('/data/Projects/rows', { values: { Title: 'not a number' } })).status).toBe(200)
    const r = await A.patch('/tables/Projects/columns/Title', { type: 'number' })
    expect(r.status).toBe(422)
    const info = await q<{ t: string }>("SELECT data_type AS t FROM information_schema.columns WHERE table_schema = 'env_default' AND table_name = 't_projects' AND column_name = 'Title'")
    expect(info[0].t).toBe('character varying')
    expect((await A.post('/data/Projects/query', { where: { col: 'Title', op: 'eq', value: 'NOT A NUMBER' } })).data.rows.length).toBe(1)
  }, 60000)
})
