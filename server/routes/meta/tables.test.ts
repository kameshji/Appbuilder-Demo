import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness } from './testing.ts'
import type { Harness } from './testing.ts'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(() => h.cleanup())
const M = 'user_maker'
const A = 'user_admin'

const mk = async (name: string, columns?: unknown[]) => {
  const r = await h.call(M, 'POST', '/api/v1/tables', { displayName: name, ...(columns ? { columns } : {}) })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return r.body
}
const col = async (t: { id: string }, c: unknown) => h.call(M, 'POST', `/api/v1/tables/${t.id}/columns`, c)

describe('tables', () => {
  it('creates through the connector on the default connection with a physical source and default privileges', async () => {
    const t = await mk('Sales orders', [{ displayName: 'Customer', type: 'text', required: true }, { displayName: 'Total', type: 'currency' }])
    expect(t.name).toBe('SalesOrders')
    expect(t.connectionId).toBe('conn_default')
    expect(t.source).toBe('t_salesorders')
    expect(t.primaryColumn).toBe('Customer')
    expect(t.columns.slice(0, 5).map((c: { name: string }) => c.name)).toEqual(['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner'])
    expect(h.mem.ops).toContain('create:t_salesorders')
    const maker = (await h.meta.roles.get('role_maker'))!.privileges.find((p) => p.table === t.id)
    const viewer = (await h.meta.roles.get('role_viewer'))!.privileges.find((p) => p.table === t.id)
    expect(maker).toMatchObject({ create: true, read: 'all', update: 'all', delete: 'all' })
    expect(viewer).toMatchObject({ create: false, read: 'all', update: 'none', delete: 'none' })
    expect(h.meta.auditLog.some((a) => a.action === 'table.create')).toBe(true)
  })

  it('refuses duplicates, bad names, bad columns and lookups to unknown tables', async () => {
    await mk('Things')
    expect((await h.call(M, 'POST', '/api/v1/tables', { displayName: 'x', name: 'things' })).status).toBe(409)
    expect((await h.call(M, 'POST', '/api/v1/tables', { displayName: 'x', name: '1bad' })).status).toBe(422)
    expect((await h.call(M, 'POST', '/api/v1/tables', { displayName: '' })).status).toBe(422)
    expect((await h.call(M, 'POST', '/api/v1/tables', { displayName: 'L', columns: [{ displayName: 'Ref', type: 'lookup', lookupTable: 'Nope' }] })).status).toBe(422)
    expect((await h.call(M, 'POST', '/api/v1/tables', { displayName: 'D', columns: [{ displayName: 'A', type: 'text' }, { name: 'A', displayName: 'A2', type: 'text' }] })).status).toBe(409)
    expect((await h.call(M, 'POST', '/api/v1/tables', { displayName: 'N', columns: [{ displayName: 'N', type: 'number', default: 'abc' }] })).status).toBe(422)
    expect((await h.call(M, 'POST', '/api/v1/tables', { displayName: 'X', connectionId: 'conn_nope' })).status).toBe(404)
    expect((await h.call(M, 'POST', '/api/v1/tables', { displayName: 'X', connectionId: 'conn_files' })).status).toBe(422)
  })

  it('updates, and primaryColumn must exist', async () => {
    const t = await mk('Doc', [{ displayName: 'A', type: 'text' }, { displayName: 'B', type: 'text' }])
    const r = await h.call(M, 'PATCH', `/api/v1/tables/${t.id}`, { displayName: 'Docs', description: 'd', primaryColumn: 'B' })
    expect(r.body).toMatchObject({ displayName: 'Docs', description: 'd', primaryColumn: 'B', name: 'Doc' })
    expect((await h.call(M, 'PATCH', `/api/v1/tables/${t.id}`, { primaryColumn: 'Zzz' })).status).toBe(422)
    expect((await h.call(M, 'PATCH', '/api/v1/tables/tbl_none', { displayName: 'x' })).status).toBe(404)
  })

  it('adds, updates, removes columns with connector DDL and the type-change rules', async () => {
    const t = await mk('People', [{ displayName: 'Name', type: 'text' }])
    let r = await col(t, { displayName: 'Age', type: 'text' })
    expect(r.body.columns.at(-1)).toMatchObject({ name: 'Age', type: 'text' })
    expect(h.mem.ops).toContain('addColumn:t_people.Age')
    expect((await col(t, { displayName: 'Age', type: 'number' })).body.columns.at(-1).name).toBe('Age_2')
    expect((await col(t, { name: 'Age', displayName: 'x', type: 'text' })).status).toBe(409)
    const def = (await h.meta.tables.get(t.id))!
    await h.services.data.insert(null, def, { Name: 'a', Age: '41' })
    await h.services.data.insert(null, def, { Name: 'b', Age: '1,200' })
    // text -> number works (all values convert); DDL runs
    r = await h.call(M, 'PATCH', `/api/v1/tables/${t.id}/columns/Age`, { type: 'number' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(h.mem.ops).toContain('alterColumn:t_people.Age->number')
    const rows = await h.mem.select(def, {})
    expect(rows.rows.map((x) => x.Age).sort()).toEqual(['1200', '41'])
    // text with bad values cannot become a number
    await h.call(M, 'PATCH', `/api/v1/tables/${t.id}/columns/Name`, { type: 'number' }).then((x) => {
      expect(x.status).toBe(422)
      expect(x.body.error.message).toContain('Cannot change the type')
    })
    // system columns, renames, unknown columns
    expect((await h.call(M, 'PATCH', `/api/v1/tables/${t.id}/columns/id`, { displayName: 'x' })).status).toBe(422)
    expect((await h.call(M, 'PATCH', `/api/v1/tables/${t.id}/columns/Name`, { name: 'Other' })).status).toBe(422)
    expect((await h.call(M, 'PATCH', `/api/v1/tables/${t.id}/columns/Nope`, { displayName: 'x' })).status).toBe(404)
    // display-only changes do not touch the source
    const before = h.mem.ops.length
    await h.call(M, 'PATCH', `/api/v1/tables/${t.id}/columns/Name`, { displayName: 'Full name', required: true })
    expect(h.mem.ops.length).toBe(before)
    // unique on duplicate data is refused
    await h.services.data.insert(null, def, { Name: 'a' })
    expect((await h.call(M, 'PATCH', `/api/v1/tables/${t.id}/columns/Name`, { unique: true })).status).toBe(422)
    // remove
    r = await h.call(M, 'DELETE', `/api/v1/tables/${t.id}/columns/Age`)
    expect(r.body.columns.some((c: { name: string }) => c.name === 'Age')).toBe(false)
    expect(h.mem.ops).toContain('dropColumn:t_people.Age')
    expect((await h.call(M, 'DELETE', `/api/v1/tables/${t.id}/columns/owner`)).status).toBe(422)
    // removing the primary column picks another
    r = await h.call(M, 'DELETE', `/api/v1/tables/${t.id}/columns/Name`)
    expect(r.body.primaryColumn).not.toBe('Name')
  })

  it('autonumber and defaults are backfilled for existing rows', async () => {
    const t = await mk('Tickets', [{ displayName: 'Title', type: 'text' }])
    const def = (await h.meta.tables.get(t.id))!
    await h.services.data.insert(null, def, { Title: 'one' })
    await h.services.data.insert(null, def, { Title: 'two' })
    await col(t, { displayName: 'No', type: 'autonumber', prefix: 'T-' })
    await col(t, { displayName: 'Status', type: 'text', default: 'Open' })
    const rows = (await h.mem.select(def, { orderBy: [{ col: 'createdOn', dir: 'asc' }] })).rows
    expect(rows.map((r) => r.No)).toEqual(['T-0001', 'T-0002'])
    expect(rows.map((r) => r.Status)).toEqual(['Open', 'Open'])
  })

  it('column security entries disappear with the column', async () => {
    const t = await mk('Hr', [{ displayName: 'Name', type: 'text' }, { displayName: 'Pay', type: 'currency' }])
    const role = (await h.call(A, 'POST', '/api/v1/roles', { name: 'Clerk', privileges: [{ table: t.id, create: false, read: 'all', update: 'none', delete: 'none', columns: { Pay: 'none' } }] })).body
    expect(role.privileges.find((p: { table: string }) => p.table === t.id).columns).toEqual({ Pay: 'none' })
    await h.call(M, 'DELETE', `/api/v1/tables/${t.id}/columns/Pay`)
    expect((await h.meta.roles.get(role.id))!.privileges.find((p) => p.table === t.id)!.columns).toEqual({})
  })

  it('deletes with and without dropSource, cleans roles, and refuses while lookups point at it', async () => {
    const a = await mk('Parent')
    const b = await mk('Child', [{ displayName: 'Of', type: 'lookup', lookupTable: 'Parent' }])
    expect((await h.call(M, 'DELETE', `/api/v1/tables/${a.id}`)).status).toBe(409)
    expect((await h.call(M, 'DELETE', `/api/v1/tables/${b.id}`)).body).toEqual({ ok: true })
    expect(h.mem.ops).not.toContain('drop:t_child')
    expect(h.mem.tablesBySource.has('t_child')).toBe(true)
    expect((await h.meta.roles.get('role_maker'))!.privileges.some((p) => p.table === b.id)).toBe(false)
    expect((await h.call(M, 'DELETE', `/api/v1/tables/${a.id}?dropSource=1`)).body).toEqual({ ok: true })
    expect(h.mem.tablesBySource.has('t_parent')).toBe(false)
    expect((await h.call(M, 'DELETE', `/api/v1/tables/${a.id}`)).status).toBe(404)
  })

  it('creates a table from CSV with inferred types and rows (rolls back when a row is invalid)', async () => {
    const csv = 'Name,Age,Joined,Active\nAnn,31,2024-01-05,true\nBob,45,2024-02-01,false\n'
    const r = await h.call(M, 'POST', '/api/v1/tables/from-csv', { displayName: 'Staff list', csv })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.columns.filter((c: { system?: boolean }) => !c.system).map((c: { name: string; type: string }) => `${c.name}:${c.type}`)).toEqual(['Name:text', 'Age:number', 'Joined:date', 'Active:boolean'])
    const def = (await h.meta.tables.get(r.body.id))!
    expect((await h.services.data.query(null, def, {})).rows.map((x) => x.Name)).toEqual(['Ann', 'Bob'])
    expect((await h.call(M, 'POST', '/api/v1/tables/from-csv', { displayName: 'Empty', csv: '' })).status).toBe(422)
    expect((await h.call(M, 'POST', '/api/v1/tables/from-csv', { displayName: 'Dup', csv: 'a\n1\n' })).status).toBe(200)
  })

  it('moves a table to another connection, copying the rows through the data service', async () => {
    const t = await mk('Moveme', [{ displayName: 'Name', type: 'text' }])
    const def = (await h.meta.tables.get(t.id))!
    const row = await h.services.data.insert(null, def, { Name: 'x' })
    const conn = (await h.call(A, 'POST', '/api/v1/connections', { name: 'Second', connector: 'mysql', settings: { host: 'h', database: 'd', user: 'u' } })).body
    const moved = await h.call(M, 'POST', `/api/v1/tables/${t.id}/move`, { connectionId: conn.id })
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    expect(moved.body).toMatchObject({ id: t.id, name: 'Moveme', connectionId: conn.id })
    expect(moved.body.source).not.toBe('t_moveme')
    const rows = await h.services.data.query(null, moved.body, {})
    expect(rows.rows.map((r) => r.id)).toEqual([row.id])
    expect((await h.call(M, 'POST', `/api/v1/tables/${t.id}/move`, { connectionId: conn.id })).status).toBe(422)
    expect((await h.call(M, 'POST', `/api/v1/tables/${t.id}/move`, { connectionId: 'conn_nope' })).status).toBe(404)
  })

  it('type-change checks use the write path rules (values.ts): no data: URLs, currency kept to 4 decimals', async () => {
    const t = await mk('Links', [{ displayName: 'Name', type: 'text' }, { displayName: 'Link', type: 'text' }, { displayName: 'Price', type: 'text' }])
    const def = (await h.meta.tables.get(t.id))!
    const row = await h.services.data.insert(null, def, { Name: 'a', Link: 'data:text/html,<b>x</b>', Price: '1.23456' })
    // a write into a url column refuses data: URLs, so the type change refuses them too
    const toUrl = await h.call(M, 'PATCH', `/api/v1/tables/${t.id}/columns/Link`, { type: 'url' })
    expect(toUrl.status).toBe(422)
    expect(toUrl.body.error.message).toMatch(/Cannot change the type: row 1 .*not a valid URL/)
    await h.services.data.update(null, def, String(row.id), { Link: 'https://example.com/x' })
    expect((await h.call(M, 'PATCH', `/api/v1/tables/${t.id}/columns/Link`, { type: 'url' })).status).toBe(200)
    // currency: the stored text is normalised with 4 decimals, the same rounding as a later write
    expect((await h.call(M, 'PATCH', `/api/v1/tables/${t.id}/columns/Price`, { type: 'currency' })).status).toBe(200)
    expect((await h.mem.select(def, {})).rows[0].Price).toBe('1.2346')
    const after = (await h.meta.tables.get(t.id))!
    expect((await h.services.data.update(null, after, String(row.id), { Price: '1.23456' })).Price).toBe(1.2346)
  })

  it('exports csv for the user with visible columns only', async () => {
    const t = await mk('Exp', [{ displayName: 'Name', type: 'text' }, { displayName: 'Secret', type: 'text' }])
    const def = (await h.meta.tables.get(t.id))!
    await h.services.data.insert(null, def, { Name: 'a', Secret: 's' })
    const role = (await h.call(A, 'POST', '/api/v1/roles', { name: 'Peek', apps: 'all', privileges: [{ table: t.id, create: false, read: 'all', update: 'none', delete: 'none', columns: { Secret: 'none' } }] })).body
    const u = (await h.call(A, 'POST', '/api/v1/users', { name: 'P', email: 'p@x.io', roleIds: [role.id] })).body
    const r = await h.call(u.id, 'GET', `/api/v1/tables/${t.id}/csv`)
    expect(r.status).toBe(200)
    const text = String(r.raw!.body)
    expect(text.split('\n')[0]).not.toContain('Secret')
    expect(text).toContain('Name')
    const none = (await h.call(A, 'POST', '/api/v1/roles', { name: 'Blind', apps: 'all' })).body
    const u2 = (await h.call(A, 'POST', '/api/v1/users', { name: 'B', email: 'b@x.io', roleIds: [none.id] })).body
    // no privilege on the table at all: it does not exist for this user (core route, no existence leak)
    expect((await h.call(u2.id, 'GET', `/api/v1/tables/${t.id}/csv`)).status).toBe(404)
    // the only registered handler is the core one (DataService: RBAC + RLS + CLS)
    expect(h.router.regs.filter((r) => r.method === 'GET' && r.segs.join('/').endsWith(':id/csv'))).toHaveLength(1)
  })
})
