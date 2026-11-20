/**
 * Personal pinned tiles over HTTP against the sandbox PostgreSQL (APPBUILDER_TEST_DB): GET / PUT /dashboards/pins act on
 * the caller only (stored in ab.user_settings, no table of their own), new pins must name a tile of a dashboard the caller
 * can open, a pin to a dashboard the caller can no longer open says "not available" and nothing else, validation (ids
 * only, at most 24), and pins of gone tiles / dashboards can still be reordered and removed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { Client, startHarness, type KernelHarness } from '../kernel-testkit.ts'
import { setQuiet } from '../util.ts'
import { runInEnvironment } from '../env-context.ts'
import { hashPassword } from '../password.ts'
import type { UserRecord } from '../contracts.ts'
import type { RoleDef, TableDef } from '../../../src/platform/contracts.ts'
import { MAX_PINS, checkPins } from './pins.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[dashboard pins integration] ${SKIP_PG}\n`)

const PW = 'member-password-1'
const sys = [
  { name: 'id', displayName: 'Id', type: 'text', system: true },
  { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true },
  { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime', system: true },
  { name: 'createdBy', displayName: 'Created by', type: 'text', system: true },
  { name: 'owner', displayName: 'Owner', type: 'text', system: true },
] as const

const def = (title: string) => ({
  version: 1, title, range: 'all',
  tiles: [
    { id: 'n', title: 'Orders', kind: 'kpi', layout: { x: 0, y: 0, w: 3, h: 3 }, query: { table: 'PinOrders', measures: [{ id: 'N', fn: 'count' }] } },
    { id: 'by', title: 'By region', kind: 'bar', layout: { x: 3, y: 0, w: 9, h: 3 }, query: { table: 'PinOrders', groupBy: ['Region'], measures: [{ id: 'N', fn: 'count' }] } },
  ],
})

describe('checkPins (pure)', () => {
  it('keeps ids only, drops duplicates, refuses malformed ids and more than the maximum', () => {
    expect(checkPins({ items: [{ dashboardId: 'dsh_1', tileId: 'a', extra: 'x' }, { dashboardId: 'dsh_1', tileId: 'a' }] })).toEqual([{ dashboardId: 'dsh_1', tileId: 'a' }])
    expect(() => checkPins({ items: [{ dashboardId: 'dsh 1', tileId: 'a' }] })).toThrow(/ids of letters/)
    expect(() => checkPins({ items: [{ dashboardId: 'dsh_1' }] })).toThrow(/ids of letters/)
    expect(() => checkPins({})).toThrow(/items is a list/)
    expect(() => checkPins({ items: Array.from({ length: MAX_PINS + 1 }, (_, i) => ({ dashboardId: 'd', tileId: `t${i}` })) })).toThrow(/at most 24/)
    expect(checkPins({ items: Array.from({ length: MAX_PINS }, (_, i) => ({ dashboardId: 'd', tileId: `t${i}` })) })).toHaveLength(MAX_PINS)
  })
})

describe.skipIf(!PG_URL)(PG_URL ? 'dashboard pins (PostgreSQL)' : `dashboard pins ${SKIP_PG}`, { timeout: 180_000 }, () => {
  let h: KernelHarness
  let vera: Client, otto: Client
  let dashId = ''
  let privateId = ''
  const addUser = async (id: string, email: string, roleIds: string[]): Promise<Client> => {
    await runInEnvironment('default', () => h.app.services.meta.users.insert({ id, name: id, email, roleIds, status: 'active', passwordHash: '' } as UserRecord))
    await h.q('UPDATE ab.users SET password_hash = $1 WHERE id = $2', [await hashPassword(PW), id])
    await h.q('INSERT INTO ab.environment_access (environment_id, user_id, is_env_admin, granted_on) VALUES ($1, $2, false, now()) ON CONFLICT DO NOTHING', ['default', id]).catch(() => undefined)
    h.app.services.security.invalidate('all')
    const c = new Client(h.base)
    const r = await c.post('/auth/login', { email, password: PW })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return c
  }
  const put = (c: Client, items: unknown) => c.req('PUT', '/dashboards/pins', { items })

  beforeAll(async () => {
    h = await startHarness('dshpin', { env: { APPBUILDER_MIGRATION_BACKUP: 'skip' } })
    const orders = {
      id: 'tbl_pin_orders', name: 'PinOrders', displayName: 'Pin orders', primaryColumn: 'Title', createdOn: new Date().toISOString(), modifiedOn: new Date().toISOString(),
      connectionId: 'conn_default', source: 't_pin_orders', managed: true,
      columns: [...sys.map((c) => ({ ...c })), { name: 'Title', displayName: 'Title', type: 'text' }, { name: 'Region', displayName: 'Region', type: 'text' }],
    } as TableDef
    await runInEnvironment('default', async () => {
      await h.app.services.meta.tables.upsert(orders)
      await (await h.app.services.connections.get('conn_default')).createTable(orders)
      const roles: RoleDef[] = [
        { id: 'role_view_pin', name: 'Viewers', apps: 'all', privileges: [{ table: orders.id, create: false, read: 'all', update: 'none', delete: 'none' }] },
        { id: 'role_none_pin', name: 'Others', apps: [], privileges: [] },
      ]
      for (const r of roles) await h.app.services.meta.roles.upsert(r)
    })
    vera = await addUser('user_vera_pin', 'vera@example.com', ['role_view_pin'])
    otto = await addUser('user_otto_pin', 'otto@example.com', ['role_none_pin'])
    const d = await h.admin.post('/dashboards', { def: def('Shared board'), roles: ['role_view_pin'] })
    expect(d.status, JSON.stringify(d.data)).toBe(200)
    dashId = d.data.id
    const p = await h.admin.post('/dashboards', { def: def('Private board') })
    privateId = p.data.id
  }, 180_000)

  afterAll(async () => { await h?.close() }, 60_000)

  it('a viewer pins tiles of a dashboard they can open; the list keeps its order and is stored in ab.user_settings', async () => {
    expect((await vera.get('/dashboards/pins')).data).toEqual({ items: [], max: MAX_PINS })
    const r = await put(vera, [{ dashboardId: dashId, tileId: 'by' }, { dashboardId: dashId, tileId: 'n' }])
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    expect(r.data.items.map((x: { tileId: string; available: boolean }) => `${x.tileId}:${x.available}`)).toEqual(['by:true', 'n:true'])
    expect(r.data.items[0]).toMatchObject({ dashboardName: 'Shared board', range: 'all', tile: { id: 'by', kind: 'bar' } })
    const g = await vera.get('/dashboards/pins')
    expect(g.data.items.map((x: { tileId: string }) => x.tileId)).toEqual(['by', 'n'])
    const rows = await h.q<{ key: string; value: unknown }>('SELECT key, value FROM ab.user_settings WHERE user_id = $1 AND key LIKE $2', ['user_vera_pin', 'dashboard-pins:%'])
    expect(rows).toEqual([{ key: 'dashboard-pins:default', value: { items: [{ dashboardId: dashId, tileId: 'by' }, { dashboardId: dashId, tileId: 'n' }] } }])
    // reorder
    const re = await put(vera, [{ dashboardId: dashId, tileId: 'n' }, { dashboardId: dashId, tileId: 'by' }])
    expect(re.data.items.map((x: { tileId: string }) => x.tileId)).toEqual(['n', 'by'])
  })

  it('another user\'s pins are never returned or changed', async () => {
    const o = await otto.get('/dashboards/pins')
    expect(o.status).toBe(200)
    expect(o.data.items).toEqual([])
    // the routes take no user id: a body naming another user is just a malformed / ignored field
    const w = await otto.req('PUT', '/dashboards/pins', { userId: 'user_vera_pin', items: [] })
    expect(w.status).toBe(200)
    expect((await vera.get('/dashboards/pins')).data.items.map((x: { tileId: string }) => x.tileId)).toEqual(['n', 'by'])
    const admin = await h.admin.get('/dashboards/pins')
    expect(admin.data.items).toEqual([])
    const rows = await h.q<{ user_id: string }>('SELECT user_id FROM ab.user_settings WHERE key LIKE $1 ORDER BY user_id', ['dashboard-pins:%'])
    expect(rows.map((r) => r.user_id)).toEqual(['user_otto_pin', 'user_vera_pin'])
  })

  it('a new pin to a dashboard I cannot open is 404 (the same answer as a missing one) and nothing is stored', async () => {
    const a = await put(otto, [{ dashboardId: dashId, tileId: 'n' }])
    const b = await put(otto, [{ dashboardId: 'dsh_doesnotexist', tileId: 'n' }])
    const c = await put(vera, [{ dashboardId: privateId, tileId: 'n' }])
    const d = await put(vera, [{ dashboardId: dashId, tileId: 'nosuchtile' }])
    for (const r of [a, b, c, d]) {
      expect(r.status).toBe(404)
      expect(r.data.error.message).toBe('Tile not found.')
    }
    expect((await otto.get('/dashboards/pins')).data.items).toEqual([])
    expect((await vera.get('/dashboards/pins')).data.items).toHaveLength(2)
  })

  it('validation: ids only, at most 24', async () => {
    expect((await put(vera, [{ dashboardId: '../x', tileId: 'n' }])).status).toBe(422)
    expect((await put(vera, 'nope')).status).toBe(422)
    expect((await put(vera, Array.from({ length: 25 }, (_, i) => ({ dashboardId: dashId, tileId: `t${i}` })))).status).toBe(422)
  })

  it('a pin to a dashboard I can no longer open returns nothing about it; it can still be reordered and removed', async () => {
    // the viewer role is removed from the dashboard
    expect((await h.admin.patch(`/dashboards/${dashId}`, { roles: [] })).status).toBe(200)
    const g = await vera.get('/dashboards/pins')
    expect(g.data.items).toEqual([{ dashboardId: dashId, tileId: 'n', available: false }, { dashboardId: dashId, tileId: 'by', available: false }])
    expect(JSON.stringify(g.data)).not.toMatch(/Shared board|PinOrders|Orders|By region/)
    // keeping them (reorder) is allowed; removing one too
    const k = await put(vera, [{ dashboardId: dashId, tileId: 'by' }, { dashboardId: dashId, tileId: 'n' }])
    expect(k.status).toBe(200)
    const rm = await put(vera, [{ dashboardId: dashId, tileId: 'n' }])
    expect(rm.data.items).toEqual([{ dashboardId: dashId, tileId: 'n', available: false }])
    // but a pin removed while unavailable cannot come back
    expect((await put(vera, [{ dashboardId: dashId, tileId: 'n' }, { dashboardId: dashId, tileId: 'by' }])).status).toBe(404)
    // access back: the pin is available again
    await h.admin.patch(`/dashboards/${dashId}`, { roles: ['role_view_pin'] })
    expect((await vera.get('/dashboards/pins')).data.items[0]).toMatchObject({ tileId: 'n', available: true, dashboardName: 'Shared board' })
  })

  it('a deleted tile or dashboard makes the pin "not available"', async () => {
    const d = await h.admin.get(`/dashboards/${dashId}`)
    await h.admin.patch(`/dashboards/${dashId}`, { def: { ...d.data.def, tiles: d.data.def.tiles.filter((t: { id: string }) => t.id !== 'n') } })
    expect((await vera.get('/dashboards/pins')).data.items).toEqual([{ dashboardId: dashId, tileId: 'n', available: false }])
    await put(vera, [{ dashboardId: dashId, tileId: 'n' }, { dashboardId: dashId, tileId: 'by' }]).then((r) => expect(r.status).toBe(200))
    expect((await h.admin.del(`/dashboards/${dashId}`)).status).toBe(200)
    expect((await vera.get('/dashboards/pins')).data.items.every((x: { available: boolean }) => !x.available)).toBe(true)
    expect((await put(vera, [])).data.items).toEqual([])
  })

  it('pins are personal settings, not design changes: a locked environment still accepts them', async () => {
    const p = await h.admin.post('/dashboards', { def: def('Locked board') })
    expect((await h.admin.req('PATCH', '/environments/default', { locked: true })).status).toBe(200)
    try {
      const r = await h.admin.req('PUT', '/dashboards/pins', { items: [{ dashboardId: p.data.id, tileId: 'n' }] })
      expect(r.status, JSON.stringify(r.data)).toBe(200)
      // while dashboard design changes are refused
      expect((await h.admin.patch(`/dashboards/${p.data.id}`, { name: 'x' })).status).toBe(403)
    } finally {
      await h.admin.req('PATCH', '/environments/default', { locked: false })
    }
  })
})
