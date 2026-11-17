import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness } from './testing.ts'
import type { Harness } from './testing.ts'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(() => h.cleanup())
const A = 'user_admin'
const M = 'user_maker'

describe('solutions', () => {
  it('CRUD and components', async () => {
    const s = await h.call(M, 'POST', '/api/v1/solutions', { displayName: 'CRM kit', version: '1.2.0', description: 'd' })
    expect(s.status, JSON.stringify(s.body)).toBe(200)
    expect(s.body).toMatchObject({ name: 'CRMKit', displayName: 'CRM kit', version: '1.2.0', publisher: 'Mia Maker', components: [] })
    expect((await h.call(M, 'POST', '/api/v1/solutions', { displayName: 'CRM kit' })).body.name).toBe('CRMKit_2')
    expect((await h.call(M, 'POST', '/api/v1/solutions', { displayName: 'x', version: 'v 1' })).status).toBe(422)
    const app = (await h.call(M, 'POST', '/api/v1/apps', { name: 'A', width: 1920, height: 1080 })).body
    const tbl = (await h.call(M, 'POST', '/api/v1/tables', { displayName: 'T' })).body
    let r = await h.call(M, 'POST', `/api/v1/solutions/${s.body.id}/components`, { kind: 'app', id: app.id })
    expect(r.body.components).toEqual([{ kind: 'app', id: app.id }])
    await h.call(M, 'POST', `/api/v1/solutions/${s.body.id}/components`, { kind: 'table', id: tbl.id })
    r = await h.call(M, 'POST', `/api/v1/solutions/${s.body.id}/components`, { kind: 'table', id: tbl.id })
    expect(r.body.components).toHaveLength(2)
    expect((await h.call(M, 'POST', `/api/v1/solutions/${s.body.id}/components`, { kind: 'table', id: 'tbl_none' })).status).toBe(404)
    expect((await h.call(M, 'POST', `/api/v1/solutions/${s.body.id}/components`, { kind: 'widget', id: 'x' })).status).toBe(422)
    const p = await h.call(M, 'PATCH', `/api/v1/solutions/${s.body.id}`, { displayName: 'CRM 2', name: 'Crm2', version: '2.0.0' })
    expect(p.body).toMatchObject({ displayName: 'CRM 2', name: 'Crm2', version: '2.0.0' })
    expect((await h.call(M, 'PATCH', `/api/v1/solutions/${s.body.id}`, { name: 'CRMKit_2' })).status).toBe(409)
    r = await h.call(M, 'DELETE', `/api/v1/solutions/${s.body.id}/components/app/${app.id}`)
    expect(r.body.components).toEqual([{ kind: 'table', id: tbl.id }])
    // deleting a component's target removes it from solutions
    await h.call(M, 'DELETE', `/api/v1/tables/${tbl.id}`)
    expect((await h.meta.solutions.list()).find((x) => x.id === s.body.id)!.components).toEqual([])
    expect((await h.call(M, 'DELETE', `/api/v1/solutions/${s.body.id}`)).body).toEqual({ ok: true })
    expect((await h.call(M, 'PATCH', `/api/v1/solutions/${s.body.id}`, { displayName: 'x' })).status).toBe(404)
  })

  async function build() {
    const sol = (await h.call(M, 'POST', '/api/v1/solutions', { displayName: 'Kit' })).body
    const add = (kind: string, id: string) => h.call(M, 'POST', `/api/v1/solutions/${sol.id}/components`, { kind, id })
    const tbl = (await h.call(M, 'POST', '/api/v1/tables', { displayName: 'Clients', columns: [{ displayName: 'Name', type: 'text' }] })).body
    const tdef = (await h.meta.tables.get(tbl.id))!
    const row = await h.services.data.insert(null, tdef, { Name: 'Acme' })
    const child = (await h.call(M, 'POST', '/api/v1/tables', { displayName: 'Notes', columns: [{ displayName: 'Client', type: 'lookup', lookupTable: 'Clients' }, { displayName: 'Text', type: 'text' }] })).body
    await h.services.data.insert(null, (await h.meta.tables.get(child.id))!, { Client: row.id, Text: 'hello' })
    const app = (await h.call(M, 'POST', '/api/v1/apps', { name: 'Kit app', width: 1920, height: 1080 })).body
    const file = (await h.call(M, 'POST', '/api/v1/files?name=rates.csv', undefined, { raw: Buffer.from('Code,Rate\nA,1.5\nB,2\n') })).body
    const ftable = (await h.meta.tables.get(file.tableIds[0]))!
    const role = (await h.call(A, 'POST', '/api/v1/roles', {
      name: 'Kit role', apps: [app.id],
      privileges: [{ table: tbl.id, create: true, read: 'all', update: 'own', delete: 'none', columns: { Name: 'read' }, rowFilter: [{ column: 'owner', op: 'eq', value: '@me' }] }, { table: ftable.id, create: false, read: 'all', update: 'none', delete: 'none' }],
    })).body
    const conn = (await h.call(A, 'POST', '/api/v1/connections', { name: 'Ext', connector: 'mysql', settings: { host: 'h', database: 'd', user: 'u' }, secret: 'topsecret' })).body
    for (const [k, i] of [['table', tbl.id], ['table', child.id], ['app', app.id], ['file', file.id], ['role', role.id], ['connection', conn.id]]) await add(k, i)
    return { sol, tbl, child, app, file, ftable, role, conn }
  }

  it('exports a package (file embedded as base64, no secrets) and imports new instances; file kept as file', async () => {
    const x = await build()
    const { yaml } = (await h.call(M, 'GET', `/api/v1/solutions/${x.sol.id}/package?data=1`)).body
    expect(yaml).toContain('appbuilder/solution')
    expect(yaml).toContain(Buffer.from('Code,Rate').toString('base64').slice(0, 8))
    expect(yaml).not.toContain('topsecret')
    const imp = await h.call(A, 'POST', '/api/v1/solutions/import', { yaml, filesAs: 'file' })
    expect(imp.status, JSON.stringify(imp.body)).toBe(200)
    expect(imp.body.displayName).toBe('Kit (2)')
    const kinds = imp.body.components.map((c: { kind: string }) => c.kind).sort()
    expect(kinds).toEqual(['app', 'connection', 'file', 'role', 'table', 'table'])
    // new instances
    const tables = await h.meta.tables.list()
    expect(tables.filter((t) => t.name.startsWith('Clients'))).toHaveLength(1) // reused by name
    const newFile = imp.body.components.find((c: { kind: string }) => c.kind === 'file')
    expect(newFile.id).not.toBe(x.file.id)
    const ft = tables.filter((t) => t.origin?.fileId === newFile.id)
    expect(ft).toHaveLength(1)
    expect(ft[0].name).not.toBe(x.ftable.name)
    expect(ft[0].connectionId).toBe('conn_files')
    expect((await h.services.data.query(null, ft[0], {})).rows.map((r) => r.Code)).toEqual(['A', 'B'])
    const newRole = (await h.meta.roles.get(imp.body.components.find((c: { kind: string }) => c.kind === 'role').id))!
    expect(newRole.name).toBe('Kit role (2)')
    expect(newRole.privileges.filter((p) => p.read !== 'none').map((p) => p.table).sort()).toEqual([x.tbl.id, ft[0].id].sort())
    expect(newRole.privileges.find((p) => p.table === x.tbl.id)).toMatchObject({ columns: { Name: 'read' }, rowFilter: [{ column: 'owner', op: 'eq', value: '@me' }] })
    const newApp = imp.body.components.find((c: { kind: string }) => c.kind === 'app')
    expect(newApp.id).not.toBe(x.app.id)
    expect(newRole.apps).toEqual([newApp.id])
    const newConn = await h.meta.connections.get(imp.body.components.find((c: { kind: string }) => c.kind === 'connection').id)
    expect(newConn).toMatchObject({ name: 'Ext (2)', status: 'not-configured' })
    expect(newConn!.secret).toBeUndefined()
    expect(imp.body.warnings.join(' ')).toContain('secrets')
  })

  it('imports a file component as database tables (rows materialised into the default connection)', async () => {
    const x = await build()
    const { yaml } = (await h.call(M, 'GET', `/api/v1/solutions/${x.sol.id}/package`)).body
    await h.call(M, 'DELETE', `/api/v1/files/${x.file.id}?dropTables=1`)
    await h.call(M, 'DELETE', `/api/v1/tables/${x.child.id}?dropSource=1`)
    await h.call(M, 'DELETE', `/api/v1/tables/${x.tbl.id}?dropSource=1`)
    const imp = await h.call(A, 'POST', '/api/v1/solutions/import', { yaml, filesAs: 'database' })
    expect(imp.status, JSON.stringify(imp.body)).toBe(200)
    expect(imp.body.components.some((c: { kind: string }) => c.kind === 'file')).toBe(false)
    expect(await h.meta.files.list()).toHaveLength(0)
    const rates = (await h.meta.tables.list()).find((t) => t.name === 'Rates' || t.displayName === 'rates' || t.name.toLowerCase().startsWith('rates'))!
    expect(rates).toMatchObject({ connectionId: 'conn_default' })
    expect(rates.origin).toBeUndefined()
    expect((await h.services.data.query(null, rates, {})).rows.map((r) => r.Code)).toEqual(['A', 'B'])
    // tables without data in the package arrive empty (data=1 was not requested)
    const clients = (await h.meta.tables.get('Clients'))!
    expect((await h.services.data.query(null, clients, {})).rows).toEqual([])
    // default is database
    const again = await h.call(A, 'POST', '/api/v1/solutions/import', { yaml })
    expect(again.body.components.some((c: { kind: string }) => c.kind === 'file')).toBe(false)
    expect((await h.call(A, 'POST', '/api/v1/solutions/import', { yaml, filesAs: 'both' })).status).toBe(422)
  })

  it('makers cannot import roles or connections (skipped with a warning); invalid packages create nothing', async () => {
    const x = await build()
    const { yaml } = (await h.call(M, 'GET', `/api/v1/solutions/${x.sol.id}/package`)).body
    const roleCount = (await h.meta.roles.list()).length
    const connCount = (await h.meta.connections.list()).length
    const imp = await h.call(M, 'POST', '/api/v1/solutions/import', { yaml, filesAs: 'file' })
    expect(imp.status, JSON.stringify(imp.body)).toBe(200)
    expect((await h.meta.roles.list()).length).toBe(roleCount)
    expect((await h.meta.connections.list()).length).toBe(connCount)
    expect(imp.body.warnings).toHaveLength(2)
    const before = (await h.meta.apps.list()).length
    expect((await h.call(M, 'POST', '/api/v1/solutions/import', { yaml: 'kind: appbuilder/app\npackageVersion: 1' })).status).toBe(422)
    expect((await h.call(M, 'POST', '/api/v1/solutions/import', { yaml: 'kind: appbuilder/solution\npackageVersion: 1\nsolution: {displayName: X}\napps: oops' })).status).toBe(422)
    expect((await h.meta.apps.list()).length).toBe(before)
  })

  it('a solution package never imports an administrator flag', async () => {
    const adminRole = (await h.call(A, 'POST', '/api/v1/roles', { name: 'Boss', isAdmin: true })).body
    const sol = (await h.call(M, 'POST', '/api/v1/solutions', { displayName: 'Boss kit' })).body
    await h.call(M, 'POST', `/api/v1/solutions/${sol.id}/components`, { kind: 'role', id: adminRole.id })
    const { yaml } = (await h.call(M, 'GET', `/api/v1/solutions/${sol.id}/package`)).body
    const imp = await h.call(A, 'POST', '/api/v1/solutions/import', { yaml })
    const r = (await h.meta.roles.get(imp.body.components[0].id))!
    expect(r.isAdmin).toBeUndefined()
    expect(imp.body.warnings.join(' ')).toContain('administrator flag')
  })
})
