/**
 * POST /api/v1/query over HTTP against the sandbox PostgreSQL (P0 package D): plans in, rows / count / cursor /
 * aggregates out; RBAC, row scope, row filters and column-level security applied inside the statement. Creates a fresh
 * database through the setup endpoints (APPBUILDER_TEST_DB, see testdb.ts) and drops it after.
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
import type { QueryPlan } from '../../src/platform/query.ts'

setQuiet(true)
const dbName = testDatabaseName('q2')
if (!PG_URL) process.stderr.write(`[query v2 endpoint] ${SKIP_PG}\n`)

class Client {
  cookie = ''
  base: string
  constructor(base: string) { this.base = base }
  async req(method: string, p: string, body?: unknown, headers: Record<string, string> = { 'X-Appbuilder': '1' }) {
    const h: Record<string, string> = { ...headers }
    if (this.cookie) h.Cookie = this.cookie
    if (body !== undefined) h['Content-Type'] = 'application/json'
    const res = await fetch(this.base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const [name, value] = pair.split('=')
      if (name === 'ab_session') this.cookie = value ? `ab_session=${value}` : ''
    }
    return { status: res.status, data: (await res.json()) as any }
  }
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {})
  query = (plan: Partial<QueryPlan>) => this.req('POST', '/api/v1/query', { plan: { version: 2, table: 'Deals', ...plan } })
}

const sys = [
  { name: 'id', displayName: 'Id', type: 'text', system: true },
  { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true },
  { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime', system: true },
  { name: 'createdBy', displayName: 'Created by', type: 'text', system: true },
  { name: 'owner', displayName: 'Owner', type: 'text', system: true },
] as const

describe.skipIf(!PG_URL)(PG_URL ? 'POST /api/v1/query (PostgreSQL)' : `POST /api/v1/query (PostgreSQL) ${SKIP_PG}`, () => {
  let app: AppServer
  let server: http.Server
  let base = ''
  let tmp = ''
  let A: Client, rep: Client, west: Client, nobody: Client
  const deals: TableDef = {
    id: 'tbl_deals_q2', name: 'Deals', displayName: 'Deals', primaryColumn: 'Title', createdOn: new Date().toISOString(), modifiedOn: new Date().toISOString(),
    connectionId: 'conn_default', source: 't_deals_q2', managed: true,
    columns: [...sys.map((c) => ({ ...c })), { name: 'Title', displayName: 'Title', type: 'text', required: true }, { name: 'Region', displayName: 'Region', type: 'text', indexed: true },
      { name: 'Amount', displayName: 'Amount', type: 'currency' }, { name: 'Qty', displayName: 'Qty', type: 'number' }, { name: 'Closed', displayName: 'Closed', type: 'date' },
      { name: 'Secret', displayName: 'Secret', type: 'text' }],
  }

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-q2-'))
    app = await createApp({ env: {}, config: { workspaceDir: tmp }, printSetupCode: false })
    server = http.createServer((req, res) => { app.handle(req, res).then((h) => { if (!h) res.writeHead(404).end() }) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    A = new Client(base); rep = new Client(base); west = new Client(base); nobody = new Client(base)
    const code = () => app.services.setupCode.current() ?? ''
    expect((await A.post('/api/v1/setup/database', { setupCode: code(), host: pgServer!.host, port: pgServer!.port, database: dbName, user: pgServer!.user, password: pgServer!.password, createDatabase: true })).status).toBe(200)
    expect((await A.post('/api/v1/setup/admin', { setupCode: code(), name: 'Ada', email: 'ada@example.com', password: 'admin-password-1' })).status).toBe(200)
    const meta = app.services.meta
    await meta.tables.upsert(deals)
    await (await app.services.connections.get('conn_default')).createTable(deals)
    const repRole: RoleDef = { id: 'role_rep_q2', name: 'Rep', apps: 'all', privileges: [{ table: deals.id, create: true, read: 'own', update: 'own', delete: 'own', columns: { Secret: 'none' } }] }
    const westRole: RoleDef = { id: 'role_west_q2', name: 'West', apps: [], privileges: [{ table: deals.id, create: false, read: 'all', update: 'none', delete: 'none', columns: { Secret: 'none' }, rowFilter: [{ column: 'Region', op: 'eq', value: 'West' }] }] }
    await meta.roles.upsert(repRole)
    await meta.roles.upsert(westRole)
    await meta.roles.upsert({ id: 'role_other_q2', name: 'Other', apps: [], privileges: [] })
    await meta.users.insert({ id: 'user_rep_q2', name: 'Rita', email: 'rita@example.com', roleIds: [repRole.id], status: 'active', passwordHash: await hashPassword('rita-password-1') })
    await meta.users.insert({ id: 'user_west_q2', name: 'Walt', email: 'walt@example.com', roleIds: [westRole.id], status: 'active', passwordHash: await hashPassword('walt-password-1') })
    await meta.users.insert({ id: 'user_none_q2', name: 'Nora', email: 'nora@example.com', roleIds: ['role_other_q2'], status: 'active', passwordHash: await hashPassword('nora-password-1') })
    app.services.security.invalidate()
    expect((await rep.post('/api/v1/auth/login', { email: 'rita@example.com', password: 'rita-password-1' })).status).toBe(200)
    expect((await west.post('/api/v1/auth/login', { email: 'walt@example.com', password: 'walt-password-1' })).status).toBe(200)
    expect((await nobody.post('/api/v1/auth/login', { email: 'nora@example.com', password: 'nora-password-1' })).status).toBe(200)
    const regions = ['West', 'East', 'west', 'North']
    for (let i = 0; i < 24; i++) {
      const c = i % 3 === 0 ? rep : A
      const r = await c.post('/api/v1/data/Deals/rows', { values: { Title: `Deal ${String(i).padStart(2, '0')}`, Region: regions[i % 4], Amount: 100 + i * 10, Qty: i % 5, Closed: `2026-0${1 + (i % 9)}-15`, ...(c === A ? { Secret: `s${i}` } : {}) } })
      expect(r.status, JSON.stringify(r.data)).toBe(200)
    }
  }, 60000)

  afterAll(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    await app?.close()
    await dropDatabase(dbName)
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }, 60000)

  it('pages with an exact count and a keyset cursor', async () => {
    const all: string[] = []
    let cursor: string | undefined
    let count = -1
    for (let i = 0; i < 10; i++) {
      const r = await A.query({ sort: [{ col: 'Amount', dir: 'desc' }], count: true, page: { size: 10, cursor } })
      expect(r.status, JSON.stringify(r.data)).toBe(200)
      count = r.data.count
      all.push(...r.data.rows.map((x: any) => x.Title))
      if (!r.data.nextCursor) break
      cursor = r.data.nextCursor
    }
    expect(count).toBe(24)
    expect(all).toEqual(Array.from({ length: 24 }, (_, i) => `Deal ${String(23 - i).padStart(2, '0')}`))
    expect((await A.query({ page: { size: 3 } })).data.rows[0]).toMatchObject({ Title: 'Deal 00', Secret: null, Closed: '2026-01-15', Amount: 100 })
  })

  it('aggregates with groups and measures over computed numbers', async () => {
    const r = await A.query({ aggregate: { groupBy: ['Region'], measures: [{ name: 'N', fn: 'count' }, { name: 'Rev', fn: 'sum', expr: { fn: 'mul', args: [{ col: 'Amount' }, { col: 'Qty' }] } }] } })
    expect(r.status).toBe(200)
    // 'West' and 'west' are one group, named after its first row
    expect(r.data.rows.map((x: any) => [x.Region, x.N])).toEqual([['West', 12], ['East', 6], ['North', 6]])
  })

  it('restricted users: only rows they may read, in rows, counts and aggregates', async () => {
    const own = await rep.query({ count: true, page: { size: 50 } })
    expect(own.data.count).toBe(8)
    expect(own.data.rows.every((x: any) => x.owner === 'user_rep_q2')).toBe(true)
    expect(Object.keys(own.data.rows[0])).not.toContain('Secret')
    const sum = await rep.query({ aggregate: { groupBy: [], measures: [{ name: 'S', fn: 'sum', col: 'Amount' }] } })
    expect(sum.data.rows[0].S).toBe([0, 3, 6, 9, 12, 15, 18, 21].reduce((a, i) => a + 100 + i * 10, 0))
    const w = await west.query({ count: true, page: { size: 0 } })
    expect(w.data.count).toBe(12) // the role filter Region = "West" keeps v1 semantics (case-insensitive: 'west' too)
    const groups = await west.query({ aggregate: { groupBy: ['Region'], measures: [{ name: 'N', fn: 'count' }] } })
    expect(groups.data.rows).toEqual([{ Region: 'West', N: 12 }])
  })

  it('a hidden column cannot be selected, filtered, sorted, searched, grouped or aggregated (403 naming it)', async () => {
    const cases: Partial<QueryPlan>[] = [
      { select: ['Title', 'Secret'] },
      { filter: { col: 'Secret', op: 'eq', value: 's3' } },
      { filter: { not: { col: 'Secret', op: 'isNull' } } },
      { sort: [{ col: 'Secret', dir: 'asc' }] },
      { search: { text: 's1', columns: ['Title', 'Secret'] } },
      { aggregate: { groupBy: ['Secret'], measures: [] } },
      { aggregate: { groupBy: [], measures: [{ name: 'N', fn: 'count', filter: { col: 'Secret', op: 'eq', value: 'x' } }] } },
    ]
    for (const p of cases) {
      const r = await rep.query(p)
      expect(r.status, JSON.stringify(p)).toBe(403)
      expect(r.data.error).toMatchObject({ code: 'denied', field: 'Secret' })
      expect(r.data.error.message).toContain('Secret')
    }
  })

  it('a user without access to the table gets 404; malformed plans get 422', async () => {
    const none = await nobody.query({})
    expect(none.status, JSON.stringify(none.data)).toBe(404)
    expect((await A.query({ filter: { col: 'Nope', op: 'eq', value: 1 } })).status).toBe(422)
    expect((await A.query({ filter: { col: 'Amount', op: 'eq', value: 'ten' } })).status).toBe(422)
    expect((await A.query({ page: { size: 501 } })).data.error.message).toMatch(/at most 500/)
    expect((await A.query({ filter: { col: 'Title', op: 'like' as never, value: 'x' } })).status).toBe(422)
    expect((await A.req('POST', '/api/v1/query', { plan: 'nope' })).status).toBe(422)
    expect((await A.req('POST', '/api/v1/query', { plan: { version: 2, table: 'Missing' } })).status).toBe(404)
    // a POST without the CSRF header is refused
    expect((await A.req('POST', '/api/v1/query', { plan: { version: 2, table: 'Deals' } }, {})).status).toBe(403)
  })
})
