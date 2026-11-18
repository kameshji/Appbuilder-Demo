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
    // asCopy: new instances (the solution itself exists here, so a plain import would be an in-place upgrade)
    const imp = await h.call(A, 'POST', '/api/v1/solutions/import', { yaml, filesAs: 'file', asCopy: true })
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
    const imp = await h.call(A, 'POST', '/api/v1/solutions/import', { yaml, filesAs: 'database', asCopy: true })
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
    const again = await h.call(A, 'POST', '/api/v1/solutions/import', { yaml, asCopy: true })
    expect(again.body.components.some((c: { kind: string }) => c.kind === 'file')).toBe(false)
    expect((await h.call(A, 'POST', '/api/v1/solutions/import', { yaml, filesAs: 'both' })).status).toBe(422)
  })

  it('makers cannot import roles or connections (skipped with a warning); invalid packages create nothing', async () => {
    const x = await build()
    const { yaml } = (await h.call(M, 'GET', `/api/v1/solutions/${x.sol.id}/package`)).body
    const roleCount = (await h.meta.roles.list()).length
    const connCount = (await h.meta.connections.list()).length
    const imp = await h.call(M, 'POST', '/api/v1/solutions/import', { yaml, filesAs: 'file', asCopy: true })
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
    const imp = await h.call(A, 'POST', '/api/v1/solutions/import', { yaml, asCopy: true })
    const r = (await h.meta.roles.get(imp.body.components[0].id))!
    expect(r.isAdmin).toBeUndefined()
    expect(imp.body.warnings.join(' ')).toContain('administrator flag')
  })

  it('stable ids: a re-import is an in-place upgrade with a plan; destructive changes are flagged; confirm by token', async () => {
    const sol = (await h.call(M, 'POST', '/api/v1/solutions', { displayName: 'Up', version: '1.0.0' })).body
    const tbl = (await h.call(M, 'POST', '/api/v1/tables', { displayName: 'Items', columns: [{ displayName: 'Label', type: 'text' }] })).body
    const app = (await h.call(M, 'POST', '/api/v1/apps', { name: 'Items app', width: 1920, height: 1080 })).body
    for (const [kind, id] of [['table', tbl.id], ['app', app.id]]) await h.call(M, 'POST', `/api/v1/solutions/${sol.id}/components`, { kind, id })
    const { yaml } = (await h.call(M, 'GET', `/api/v1/solutions/${sol.id}/package`)).body
    expect(yaml).toContain(`id: ${sol.id}`)
    // nothing changed since the export: an upgrade with nothing to do
    let plan = (await h.call(A, 'POST', '/api/v1/solutions/import/plan', { yaml })).body
    expect(plan).toMatchObject({ mode: 'upgrade', destructive: false, problems: [], backup: { available: false, message: expect.stringMatching(/No backup/) } })
    expect(plan.items.map((i: { kind: string; change: string }) => `${i.kind}:${i.change}`).sort()).toEqual(['app:unchanged', 'table:unchanged'])
    // here a column was added after the export: importing the older package drops it (data loss, flagged)
    await h.call(M, 'POST', `/api/v1/tables/${tbl.id}/columns`, { displayName: 'Extra', type: 'text' })
    await h.call(M, 'PATCH', `/api/v1/apps/${app.id}`, { name: 'Renamed here' })
    plan = (await h.call(A, 'POST', '/api/v1/solutions/import/plan', { yaml })).body
    const t = plan.items.find((i: { kind: string }) => i.kind === 'table')
    expect(t).toMatchObject({ change: 'changed', destructive: true, columns: [{ name: 'Extra', change: 'removed', destructive: true }] })
    expect(plan.items.find((i: { kind: string }) => i.kind === 'app')).toMatchObject({ change: 'changed', note: 'renamed from "Renamed here"' })
    expect(plan.destructive).toBe(true)
    // makers may plan; only administrators upgrade in place
    const mplan = (await h.call(M, 'POST', '/api/v1/solutions/import/plan', { yaml })).body
    expect(mplan.problems.join(' ')).toMatch(/only administrators/)
    expect((await h.call(M, 'POST', '/api/v1/solutions/import', { yaml, confirm: mplan.token })).status).toBe(422)
    // no token, a wrong token: refused, nothing changed
    expect((await h.call(A, 'POST', '/api/v1/solutions/import', { yaml })).status).toBe(409)
    expect((await h.call(A, 'POST', '/api/v1/solutions/import', { yaml, confirm: 'x' })).status).toBe(409)
    expect((await h.meta.tables.get(tbl.id))!.columns.some((c) => c.name === 'Extra')).toBe(true)
    const done = await h.call(A, 'POST', '/api/v1/solutions/import', { yaml, confirm: plan.token })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body).toMatchObject({ id: sol.id, version: '1.0.0', backup: { taken: false } })
    expect((await h.meta.tables.get(tbl.id))!.columns.some((c) => c.name === 'Extra')).toBe(false)
    expect((await h.meta.apps.get(app.id))!.meta.name).toBe('Items app')
    expect(h.meta.auditLog.some((e) => e.action === 'solution.upgrade')).toBe(true)
    // the same solution under another id in the package: never matched (new instances, as an install)
    const other = yaml.replace(`id: ${sol.id}`, 'id: sol_other').replace(new RegExp(tbl.id, 'g'), 'tbl_other').replace(new RegExp(app.id, 'g'), 'app_other')
    const p2 = (await h.call(A, 'POST', '/api/v1/solutions/import/plan', { yaml: other })).body
    expect(p2.mode).toBe('install')
    // a table with the same name and another identity is used as it is
    expect(p2.items.find((i: { kind: string }) => i.kind === 'table')).toMatchObject({ change: 'unchanged', id: tbl.id })
  })
})
