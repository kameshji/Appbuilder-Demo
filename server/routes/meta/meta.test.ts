import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness } from './testing.ts'
import type { Harness } from './testing.ts'
import { SEED_CONTACTS } from './seed.ts'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(() => h.cleanup())

const A = 'user_admin'
const M = 'user_maker'
const V = 'user_viewer'

const mkTable = async (name: string, columns?: unknown[], as = M) => {
  const r = await h.call(as, 'POST', '/api/v1/tables', { displayName: name, ...(columns ? { columns } : {}) })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return r.body
}

describe('auth levels', () => {
  it('rejects anonymous, viewer and maker where a higher level is needed', async () => {
    expect((await h.call(null, 'POST', '/api/v1/apps', { name: 'X', width: 1920, height: 1080 })).status).toBe(401)
    expect((await h.call(V, 'POST', '/api/v1/apps', { name: 'X', width: 1920, height: 1080 })).status).toBe(403)
    expect((await h.call(V, 'POST', '/api/v1/tables', { displayName: 'T' })).status).toBe(403)
    expect((await h.call(M, 'POST', '/api/v1/roles', { name: 'R' })).status).toBe(403)
    expect((await h.call(M, 'POST', '/api/v1/users', { name: 'U', email: 'u@x.io' })).status).toBe(403)
    expect((await h.call(M, 'POST', '/api/v1/connections', { name: 'C', connector: 'mysql' })).status).toBe(403)
    expect((await h.call(M, 'GET', '/api/v1/security/preview?user=user_viewer')).status).toBe(403)
    expect((await h.call(V, 'POST', '/api/v1/solutions', { displayName: 'S' })).status).toBe(403)
  })
})

describe('apps', () => {
  it('creates, reads, renames, duplicates, saves, deletes', async () => {
    const created = await h.call(M, 'POST', '/api/v1/apps', { name: 'Sales', width: 1920, height: 1080 })
    expect(created.status).toBe(200)
    const id = created.body.id
    expect(created.body.modifiedBy).toBe('Mia Maker')
    const again = await h.call(M, 'POST', '/api/v1/apps', { name: 'sales', width: 1920, height: 1080 })
    expect(again.body.name).toBe('sales (2)')
    const got = await h.call(V, 'GET', `/api/v1/apps/${id}`)
    expect(got.body.definition.screens).toHaveLength(1)
    expect((await h.call(M, 'PATCH', `/api/v1/apps/${id}`, { name: 'sales (2)' })).status).toBe(409)
    expect((await h.call(M, 'PATCH', `/api/v1/apps/${id}`, { name: 'Sales 2' })).body.name).toBe('Sales 2')
    const dup = await h.call(M, 'POST', `/api/v1/apps/${id}/duplicate`)
    expect(dup.body.name).toBe('Sales 2 (copy)')
    const def = { ...got.body.definition, name: 'Renamed', width: 2560, height: 1440 }
    const saved = await h.call(M, 'PUT', `/api/v1/apps/${id}`, { definition: def })
    expect(saved.body).toMatchObject({ name: 'Renamed', width: 2560 })
    // PUT with a name another app already has: 409 like PATCH (the name is not silently kept)
    const clash = await h.call(M, 'PUT', `/api/v1/apps/${id}`, { definition: { ...def, name: 'SALES (2)' } })
    expect(clash.status).toBe(409)
    expect(clash.code).toBe('conflict')
    expect((await h.call(M, 'GET', `/api/v1/apps/${id}`)).body.meta.name).toBe('Renamed')
    expect((await h.call(M, 'PUT', `/api/v1/apps/${id}`, { definition: { nope: 1 } })).status).toBe(422)
    expect((await h.call(M, 'POST', '/api/v1/apps', { name: 'Tall', width: 500, height: 900 })).status).toBe(422)
    expect((await h.call(M, 'DELETE', `/api/v1/apps/${id}`)).body).toEqual({ ok: true })
    expect((await h.call(M, 'GET', `/api/v1/apps/${id}`)).status).toBe(404)
  })

  it('a role without app access cannot read the app definition', async () => {
    const app = (await h.call(M, 'POST', '/api/v1/apps', { name: 'Secret', width: 1920, height: 1080 })).body
    const role = (await h.call(A, 'POST', '/api/v1/roles', { name: 'Nobody', apps: [] })).body
    const u = (await h.call(A, 'POST', '/api/v1/users', { name: 'N', email: 'n@x.io', roleIds: [role.id] })).body
    expect((await h.call(u.id, 'GET', `/api/v1/apps/${app.id}`)).status).toBe(403)
    expect((await h.call(A, 'PATCH', `/api/v1/roles/${role.id}`, { apps: [app.id] })).status).toBe(200)
    expect((await h.call(u.id, 'GET', `/api/v1/apps/${app.id}`)).status).toBe(200)
    await h.call(M, 'DELETE', `/api/v1/apps/${app.id}`)
    expect((await h.meta.roles.get(role.id))!.apps).toEqual([])
  })

  it('sample template creates Contacts and Orders with data', async () => {
    const r = await h.call(M, 'POST', '/api/v1/apps', { name: 'Demo', width: 1920, height: 1080, template: 'sample' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const contacts = (await h.meta.tables.get('Contacts'))!
    const rows = await h.services.data.query(null, contacts, {})
    expect(rows.rows).toHaveLength(SEED_CONTACTS.length)
    const orders = (await h.meta.tables.get('Orders'))!
    expect((await h.services.data.query(null, orders, {})).rows).toHaveLength(12)
  })

  it('app package export -> import creates new instances and reuses existing tables', async () => {
    const t = await mkTable('Items', [{ displayName: 'Title', type: 'text' }, { displayName: 'Qty', type: 'number' }])
    const def = (await h.call(M, 'GET', '/api/v1/apps/' + (await h.call(M, 'POST', '/api/v1/apps', { name: 'P', width: 1920, height: 1080 })).body.id)).body
    def.definition.dataSources = ['Items']
    await h.call(M, 'PUT', `/api/v1/apps/${def.meta.id}`, { definition: def.definition })
    await h.services.data.insert(null, t, { Title: 'a', Qty: 2 })
    const { yaml } = (await h.call(M, 'GET', `/api/v1/apps/${def.meta.id}/package?data=1`)).body
    expect(yaml).toContain('appbuilder/app')
    const imp = await h.call(M, 'POST', '/api/v1/apps/import', { yaml })
    expect(imp.status, JSON.stringify(imp.body)).toBe(200)
    expect(imp.body.id).not.toBe(def.meta.id)
    expect(imp.body.name).toBe('P (2)')
    expect((await h.meta.tables.list()).filter((x) => x.name === 'Items')).toHaveLength(1)
    // a fresh workspace: tables are created with rows
    await h.call(M, 'DELETE', `/api/v1/tables/${t.id}?dropSource=1`)
    const imp2 = await h.call(M, 'POST', '/api/v1/apps/import', { yaml })
    expect(imp2.status, JSON.stringify(imp2.body)).toBe(200)
    const items = (await h.meta.tables.get('Items'))!
    expect(items.id).not.toBe(t.id)
    expect((await h.services.data.query(null, items, {})).rows.map((r) => r.Title)).toEqual(['a'])
    expect((await h.call(M, 'POST', '/api/v1/apps/import', { yaml: 'kind: appbuilder/solution\npackageVersion: 1' })).status).toBe(422)
    expect((await h.call(M, 'POST', '/api/v1/apps/import', { yaml: '' })).status).toBe(422)
  })
})
