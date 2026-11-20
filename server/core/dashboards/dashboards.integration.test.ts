/**
 * Dashboards over HTTP against the sandbox PostgreSQL (P2-C): stored definitions with viewer roles, the batch query
 * endpoint under the viewer's rights for every new plan feature (count distinct, date buckets, groupOrder "key", top N
 * with others), hidden columns failing only their own tile, the cache (hit, per user, dropped on a table change), and
 * the environment settings. Creates a fresh database (APPBUILDER_TEST_DB, see testdb.ts) and drops it after.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from '../app.ts'
import type { AppServer } from '../app.ts'
import { hashPassword } from '../password.ts'
import { setQuiet } from '../util.ts'
import { PG_URL, SKIP_PG, dropDatabase, pgServer, testDatabaseName } from '../testdb.ts'
import type { RoleDef, TableDef } from '../../../src/platform/contracts.ts'
import type { QueryPlan } from '../../../src/platform/query.ts'
import { productionOverview } from '../../../src/dashboards/manufacturing.ts'

setQuiet(true)
const dbName = testDatabaseName('dsh')

class Client {
  cookie = ''
  base: string
  constructor(base: string) { this.base = base }
  async req(method: string, p: string, body?: unknown) {
    const h: Record<string, string> = { 'X-Appbuilder': '1' }
    if (this.cookie) h.Cookie = this.cookie
    if (body !== undefined) h['Content-Type'] = 'application/json'
    const res = await fetch(this.base + '/api/v1' + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const [name, value] = pair!.split('=')
      if (name === 'ab_session') this.cookie = value ? `ab_session=${value}` : ''
    }
    return { status: res.status, data: (await res.json()) as any }
  }
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {})
  batch = (queries: { id: string; plan: Partial<QueryPlan> }[]) => this.post('/dashboards/query', { queries: queries.map((q) => ({ id: q.id, plan: { version: 2, table: 'DshOrders', ...q.plan } })) })
}

const sys = [
  { name: 'id', displayName: 'Id', type: 'text', system: true },
  { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true },
  { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime', system: true },
  { name: 'createdBy', displayName: 'Created by', type: 'text', system: true },
  { name: 'owner', displayName: 'Owner', type: 'text', system: true },
] as const

describe.skipIf(!PG_URL)(PG_URL ? 'dashboards (PostgreSQL)' : `dashboards (PostgreSQL) ${SKIP_PG}`, () => {
  let app: AppServer
  let server: http.Server
  let tmp = ''
  let A: Client, rep: Client, west: Client, nobody: Client
  const orders: TableDef = {
    id: 'tbl_orders_dsh', name: 'DshOrders', displayName: 'Dsh orders', primaryColumn: 'Title', createdOn: new Date().toISOString(), modifiedOn: new Date().toISOString(),
    connectionId: 'conn_default', source: 't_orders_dsh', managed: true,
    columns: [...sys.map((c) => ({ ...c })), { name: 'Title', displayName: 'Title', type: 'text', required: true }, { name: 'Region', displayName: 'Region', type: 'text', indexed: true },
      { name: 'Amount', displayName: 'Amount', type: 'currency' }, { name: 'Placed', displayName: 'Placed', type: 'date' }, { name: 'At', displayName: 'At', type: 'datetime' },
      { name: 'Secret', displayName: 'Secret', type: 'text' }],
  }
  // what each user owns / may see, to compare with the server's answers
  const made: { by: 'A' | 'rep'; Region: string; Amount: number; Placed: string; Secret?: string }[] = []

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-dsh-'))
    app = await createApp({ env: {}, config: { workspaceDir: tmp }, printSetupCode: false })
    server = http.createServer((req, res) => { app.handle(req, res).then((h) => { if (!h) res.writeHead(404).end() }) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    A = new Client(base); rep = new Client(base); west = new Client(base); nobody = new Client(base)
    const code = () => app.services.setupCode.current() ?? ''
    expect((await A.req('POST', '/setup/database', { setupCode: code(), host: pgServer!.host, port: pgServer!.port, database: dbName, user: pgServer!.user, password: pgServer!.password, createDatabase: true })).status).toBe(200)
    expect((await A.req('POST', '/setup/admin', { setupCode: code(), name: 'Ada', email: 'ada@example.com', password: 'admin-password-1' })).status).toBe(200)
    const meta = app.services.meta
    await meta.tables.upsert(orders)
    await (await app.services.connections.get('conn_default')).createTable(orders)
    const repRole: RoleDef = { id: 'role_rep_dsh', name: 'Rep', apps: 'all', privileges: [{ table: orders.id, create: true, read: 'own', update: 'own', delete: 'own', columns: { Secret: 'none' } }] }
    const westRole: RoleDef = { id: 'role_west_dsh', name: 'West', apps: [], privileges: [{ table: orders.id, create: false, read: 'all', update: 'none', delete: 'none', rowFilter: [{ column: 'Region', op: 'eq', value: 'West' }] }] }
    await meta.roles.upsert(repRole)
    await meta.roles.upsert(westRole)
    await meta.roles.upsert({ id: 'role_other_dsh', name: 'Other', apps: [], privileges: [] })
    await meta.users.insert({ id: 'user_rep_dsh', name: 'Rita', email: 'rita@example.com', roleIds: [repRole.id], status: 'active', passwordHash: await hashPassword('rita-password-1') })
    await meta.users.insert({ id: 'user_west_dsh', name: 'Walt', email: 'walt@example.com', roleIds: [westRole.id], status: 'active', passwordHash: await hashPassword('walt-password-1') })
    await meta.users.insert({ id: 'user_none_dsh', name: 'Nora', email: 'nora@example.com', roleIds: ['role_other_dsh'], status: 'active', passwordHash: await hashPassword('nora-password-1') })
    app.services.security.invalidate()
    for (const [c, e, p] of [[rep, 'rita@example.com', 'rita-password-1'], [west, 'walt@example.com', 'walt-password-1'], [nobody, 'nora@example.com', 'nora-password-1']] as const) {
      expect((await c.post('/auth/login', { email: e, password: p })).status).toBe(200)
    }
    const regions = ['West', 'East', 'west', 'North', '']
    for (let i = 0; i < 30; i++) {
      const by = i % 3 === 0 ? 'rep' : 'A'
      const v = { Title: `Order ${i}`, Region: regions[i % 5]!, Amount: 100 + i * 10, Placed: `2026-${String(1 + (i % 12)).padStart(2, '0')}-1${i % 9}`, At: new Date(Date.UTC(2026, i % 12, 10, (i * 5) % 24)).toISOString(), ...(by === 'A' ? { Secret: `s${i % 4}` } : {}) }
      const r = await (by === 'rep' ? rep : A).post('/data/DshOrders/rows', { values: v })
      expect(r.status, JSON.stringify(r.data)).toBe(200)
      made.push({ by, ...v })
    }
  }, 90_000)

  afterAll(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    await app?.close()
    await dropDatabase(dbName)
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }, 60_000)

  const regionKey = (r: string) => r.toLowerCase()

  it('every new plan feature runs under the viewer\'s rights (own rows, row rules, no access)', async () => {
    const plans: { id: string; plan: Partial<QueryPlan> }[] = [
      { id: 'distinct', plan: { aggregate: { groupBy: [], measures: [{ name: 'N', fn: 'count' }, { name: 'R', fn: 'countDistinct', col: 'Region' }, { name: 'S', fn: 'sum', col: 'Amount' }] } } },
      { id: 'month', plan: { aggregate: { groupBy: [], buckets: [{ name: 'M', col: 'Placed', unit: 'fiscalQuarter', fiscalYearStart: 4 }], measures: [{ name: 'N', fn: 'count' }], groupOrder: 'key' } } },
      { id: 'hour', plan: { aggregate: { groupBy: [], buckets: [{ name: 'H', col: 'At', unit: 'hour', timeZone: 'Asia/Kolkata' }], measures: [{ name: 'N', fn: 'count' }], groupOrder: 'key' } } },
      { id: 'top', plan: { aggregate: { groupBy: ['Region'], measures: [{ name: 'S', fn: 'sum', col: 'Amount' }], groupOrder: 'key', sort: [{ col: 'S', dir: 'desc' }], top: { n: 1, others: 'Others' } } } },
    ]
    const expectFor = (rows: typeof made) => {
      const sum = rows.reduce((a, r) => a + r.Amount, 0)
      // the Data API stores '' as blank (NULL), which count distinct does not count
      const regions = new Set(rows.filter((r) => r.Region !== '').map((r) => regionKey(r.Region)))
      const groups = new Map<string, number>()
      for (const r of rows) groups.set(regionKey(r.Region), (groups.get(regionKey(r.Region)) ?? 0) + r.Amount)
      const top = [...groups.entries()].sort((a, b) => b[1] - a[1])[0]!
      return { N: rows.length, R: regions.size, S: sum, top: top[1], others: sum - top[1] }
    }
    for (const [who, mine] of [[A, made], [rep, made.filter((r) => r.by === 'rep')], [west, made.filter((r) => r.Region.toLowerCase() === 'west')]] as const) {
      const res = await who.batch(plans)
      expect(res.status, JSON.stringify(res.data)).toBe(200)
      const by = Object.fromEntries(res.data.results.map((x: any) => [x.id, x]))
      for (const x of res.data.results) expect(x.ok, JSON.stringify(x)).toBe(true)
      const want = expectFor(mine)
      expect(by.distinct.rows[0]).toEqual({ N: want.N, R: want.R, S: want.S })
      expect(by.month.rows.reduce((a: number, r: any) => a + r.N, 0)).toBe(want.N)
      expect(by.hour.rows.reduce((a: number, r: any) => a + r.N, 0)).toBe(want.N)
      expect(by.top.rows[0].S).toBe(want.top)
      if (want.others) expect(by.top.rows[1]).toEqual({ Region: 'Others', S: want.others })
      else expect(by.top.rows).toHaveLength(1)
      expect(by.distinct.filtered === true).toBe(who !== A)
    }
    // no access: every tile answers 404 (no existence leak), the batch itself succeeds
    const none = await nobody.batch(plans)
    expect(none.status).toBe(200)
    expect(none.data.results.every((x: any) => !x.ok && x.error.status === 404)).toBe(true)
  })

  it('a hidden column fails only its own tile (count distinct, bucket and group of it are refused)', async () => {
    const res = await rep.batch([
      { id: 'ok', plan: { aggregate: { groupBy: [], measures: [{ name: 'N', fn: 'count' }] } } },
      { id: 'cd', plan: { aggregate: { groupBy: [], measures: [{ name: 'D', fn: 'countDistinct', col: 'Secret' }] } } },
      { id: 'grp', plan: { aggregate: { groupBy: ['Secret'], measures: [{ name: 'N', fn: 'count' }], groupOrder: 'key', top: { n: 1, others: 'Others' } } } },
    ])
    const by = Object.fromEntries(res.data.results.map((x: any) => [x.id, x]))
    expect(by.ok.ok).toBe(true)
    expect(by.cd).toMatchObject({ ok: false, error: { status: 403 } })
    expect(by.grp).toMatchObject({ ok: false, error: { status: 403 } })
    // the administrator sees it
    const adm = await A.batch([{ id: 'cd', plan: { aggregate: { groupBy: [], measures: [{ name: 'D', fn: 'countDistinct', col: 'Secret' }] } } }])
    expect(adm.data.results[0]).toMatchObject({ ok: true, rows: [{ D: 4 }] })
  })

  it('caches per user and drops the cache when the table changes', async () => {
    const plan = { aggregate: { groupBy: [], measures: [{ name: 'N', fn: 'count' as const }] } }
    const first = await rep.batch([{ id: 'n', plan }])
    const second = await rep.batch([{ id: 'n', plan }])
    expect(second.data.results[0].cached).toBe(true)
    expect(second.data.results[0].rows).toEqual(first.data.results[0].rows)
    // another user's identical plan is not served from Rita's entry
    const other = await west.batch([{ id: 'n', plan }])
    expect(other.data.results[0].cached).toBeFalsy()
    expect(other.data.results[0].rows[0].N).not.toBe(first.data.results[0].rows[0].N)
    // a new row: the change feed drops the entry (outbox dispatch is asynchronous: wait for it)
    expect((await rep.post('/data/DshOrders/rows', { values: { Title: 'Late order', Region: 'East', Amount: 5, Placed: '2026-11-19' } })).status).toBe(200)
    let after: any = null
    for (let i = 0; i < 50; i++) {
      after = (await rep.batch([{ id: 'n', plan }])).data.results[0]
      if (!after.cached) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(after.cached).toBeFalsy()
    expect(after.rows[0].N).toBe(first.data.results[0].rows[0].N + 1)
  })

  it('stores dashboards with viewer roles; only makers create, only owners and administrators change', async () => {
    const def = productionOverview({ log: 'DshOrders', downtime: 'DshOrders' })
    expect((await rep.post('/dashboards', { def })).status).toBe(403)
    const c = await A.post('/dashboards', { def, roles: ['role_rep_dsh'] })
    expect(c.status, JSON.stringify(c.data)).toBe(200)
    expect(c.data.def.tiles).toHaveLength(7)
    const priv = await A.post('/dashboards', { def: { ...def, title: 'Private' } })
    expect((await rep.req('GET', '/dashboards')).data.items.map((x: any) => x.name)).toEqual(['Production overview'])
    expect((await west.req('GET', `/dashboards/${priv.data.id}`)).status).toBe(404)
    expect((await rep.req('PATCH', `/dashboards/${c.data.id}`, { name: 'Mine now' })).status).toBe(403)
    expect((await A.req('PATCH', `/dashboards/${c.data.id}`, { name: 'Plant', roles: ['role_rep_dsh', 'role_west_dsh'] })).data.name).toBe('Plant')
    expect((await west.req('GET', '/dashboards')).data.items.map((x: any) => x.name)).toEqual(['Plant'])
    expect((await A.post('/dashboards', { def: { title: 'Bad', tiles: [{ id: 'x', kind: 'nope' }] } })).status).toBe(422)
    expect((await A.post('/dashboards', { def, roles: ['no_such_role'] })).status).toBe(422)
    expect((await rep.req('DELETE', `/dashboards/${c.data.id}`)).status).toBe(403)
    expect((await A.req('DELETE', `/dashboards/${priv.data.id}`)).status).toBe(200)
  })

  it('settings: defaults for everyone, changed by administrators only', async () => {
    expect((await rep.req('GET', '/dashboards/settings')).data.settings).toMatchObject({ locale: 'en-IN', currency: 'INR', timeZone: 'Asia/Kolkata', fiscalYearStart: 4 })
    expect((await rep.req('PUT', '/dashboards/settings', { settings: { fiscalYearStart: 1 } })).status).toBe(403)
    const put = await A.req('PUT', '/dashboards/settings', { settings: { fiscalYearStart: 1, timeZone: 'Mars/Base', currency: 'usd' } })
    expect(put.data.settings).toMatchObject({ fiscalYearStart: 1, timeZone: 'Asia/Kolkata', currency: 'USD' })
  })

  it('a locked production environment refuses dashboard changes but still answers queries', async () => {
    const d = await A.post('/dashboards', { def: productionOverview({ log: 'DshOrders', downtime: 'DshOrders' }) })
    expect((await A.req('PATCH', '/environments/default', { locked: true })).status).toBe(200)
    try {
      expect((await A.req('PATCH', `/dashboards/${d.data.id}`, { name: 'x' })).status).toBe(403)
      expect((await A.post('/dashboards', { def: productionOverview() })).status).toBe(403)
      expect((await A.req('DELETE', `/dashboards/${d.data.id}`)).status).toBe(403)
      expect((await rep.batch([{ id: 'n', plan: { aggregate: { groupBy: [], measures: [{ name: 'N', fn: 'count' }] } } }])).data.results[0].ok).toBe(true)
    } finally {
      expect((await A.req('PATCH', '/environments/default', { locked: false })).status).toBe(200)
    }
    expect((await A.req('DELETE', `/dashboards/${d.data.id}`)).status).toBe(200)
  })

  it('refuses malformed batches', async () => {
    expect((await A.post('/dashboards/query', { queries: [] })).status).toBe(422)
    expect((await A.post('/dashboards/query', { queries: Array.from({ length: 41 }, (_, i) => ({ id: `q${i}`, plan: {} })) })).status).toBe(422)
    const r = await A.post('/dashboards/query', { queries: [{ id: 'a', plan: { version: 2, table: 'DshOrders', aggregate: { groupBy: [], measures: [], top: { n: 1 } } } }] })
    expect(r.data.results[0]).toMatchObject({ ok: false, error: { status: 422 } })
  })
})
