import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { makeHarness } from './testing.ts'
import type { Harness } from './testing.ts'
import { migrateLegacyWorkspace, seedSample } from './index.ts'
import { sampleAppDef } from './seed.ts'
import { C1, C2, O1, legacy } from './fixtures.ts'

let h: Harness
afterEach(() => h?.cleanup())

describe('legacy migration', () => {
  it('imports apps, tables (as data files, ids kept), roles, users without passwords, solutions; moves legacy files', async () => {
    h = await makeHarness({ workspace: legacy })
    const res = await migrateLegacyWorkspace(h.services, h.ids.admin)
    expect(res.migrated).toBe(true)
    expect(res.summary).toContain('1 app(s)')
    expect(res.summary).toContain('2 table(s)')
    expect(res.summary).toContain('no password')
    expect(res.summary).toContain('broken.app.yaml')
    // apps keep their ids
    expect((await h.meta.apps.get('app_contacts'))!.meta).toMatchObject({ name: 'Contacts app', modifiedBy: 'Sam Maker' })
    // tables: files connector, same ids, rows and ids kept, owners remapped
    const contacts = (await h.meta.tables.get('tbl_contacts'))!
    expect(contacts).toMatchObject({ name: 'Contacts', connectionId: 'conn_files', origin: { kind: 'file', fileName: 'Contacts.csv' } })
    const rows = (await h.services.data.query(null, contacts, { orderBy: [{ col: 'Name', dir: 'asc' }] })).rows
    expect(rows.map((r) => [r.id, r.Name, r.Active, r.owner])).toEqual([[C1, 'Asha', true, 'user_sam'], [C2, 'Ben', false, 'user_vera']])
    expect(rows[1].createdBy).toBe(h.ids.admin) // user without email -> the new administrator
    const orders = (await h.meta.tables.get('tbl_orders'))!
    const o = (await h.services.data.query(null, orders, {})).rows[0]
    expect(o).toMatchObject({ id: O1, OrderNo: 'ORD-0007', Customer: C1, Amount: 12.5 })
    expect(h.meta.counters.get('tbl_orders:OrderNo')).toBe(7)
    expect((await h.meta.files.list()).map((f) => f.fileName).sort()).toEqual(['Contacts.csv', 'Orders.csv'])
    // the next autonumber continues
    const created = await h.services.data.insert(null, orders, { Customer: C2, Amount: 1 })
    expect(created.OrderNo).toBe('ORD-0008')
    // roles: built-in names merge, custom role added; unknown tables dropped
    const roles = await h.meta.roles.list()
    expect(roles.map((r) => r.name).sort()).toEqual(['Administrator', 'Maker', 'Own rows', 'Viewer'])
    const maker = roles.find((r) => r.id === 'role_maker')!
    expect(maker.privileges.find((p) => p.table === 'tbl_orders')).toMatchObject({ create: true, update: 'all' })
    const custom = roles.find((r) => r.name === 'Own rows')!
    expect(custom.privileges).toEqual([{ table: 'tbl_orders', create: true, read: 'own', update: 'own', delete: 'none' }])
    expect(custom.apps).toEqual(['app_contacts'])
    // viewer default privilege for the table the legacy viewer did not know
    expect(roles.find((r) => r.id === 'role_viewer')!.privileges.find((p) => p.table === 'tbl_orders')).toMatchObject({ read: 'all', update: 'none' })
    // users: no passwords, active; blank email skipped; the harness admin keeps its id
    const users = await h.meta.users.list()
    const sam = users.find((u) => u.id === 'user_sam')!
    expect(sam).toMatchObject({ email: 'sam@appbuilder.local', status: 'active', passwordHash: null, roleIds: ['role_maker'] })
    expect(users.find((u) => u.id === 'user_vera')!.roleIds.sort()).toEqual(['role_custom', 'role_viewer'])
    expect(users.some((u) => u.name === 'No Email')).toBe(false)
    expect(users.filter((u) => u.email === 'admin@appbuilder.local')).toHaveLength(1)
    // solutions
    const sols = await h.meta.solutions.list()
    expect(sols).toHaveLength(1)
    expect(sols[0].components.map((c) => c.kind).sort()).toEqual(['app', 'role', 'table'])
    // legacy files moved, never deleted
    expect(fs.existsSync(path.join(h.dir, 'workspace.yaml'))).toBe(false)
    expect(fs.existsSync(path.join(h.dir, 'legacy-phase2', 'workspace.yaml'))).toBe(true)
    expect(fs.existsSync(path.join(h.dir, 'legacy-phase2', 'tables', 'Contacts.csv'))).toBe(true)
    expect(fs.existsSync(path.join(h.dir, 'legacy-phase2', 'apps', 'app_contacts.app.yaml'))).toBe(true)
    // a second run finds nothing
    expect((await migrateLegacyWorkspace(h.services, h.ids.admin)).migrated).toBe(false)
  })

  it('reports nothing to migrate for an empty workspace', async () => {
    h = await makeHarness()
    expect(await migrateLegacyWorkspace(h.services, h.ids.admin)).toMatchObject({ migrated: false })
  })
})

describe('sample seed', () => {
  it('seeds Contacts, Orders and the Contacts app into the default connection', async () => {
    h = await makeHarness()
    await seedSample(h.services, h.ids.admin)
    const tables = await h.meta.tables.list()
    expect(tables.map((t) => t.name).sort()).toEqual(['Contacts', 'Orders'])
    expect(tables.every((t) => t.connectionId === 'conn_default')).toBe(true)
    const orders = tables.find((t) => t.name === 'Orders')!
    const rows = (await h.services.data.query(null, orders, { orderBy: [{ col: 'OrderNo', dir: 'asc' }] })).rows
    expect(rows).toHaveLength(12)
    expect(rows[0].OrderNo).toBe('ORD-0001')
    const apps = await h.meta.apps.list()
    expect(apps.map((a) => a.name)).toEqual(['Contacts app'])
    expect((await h.meta.roles.get('role_maker'))!.privileges).toHaveLength(2)
    // idempotent for tables
    await seedSample(h.services, h.ids.admin)
    expect((await h.meta.tables.list())).toHaveLength(2)
    expect((await h.meta.apps.list()).map((a) => a.name)).toEqual(['Contacts app', 'Contacts app (2)'])
  })

  it('the JSON snapshot of the sample app matches src/runtime/sample.ts (ignoring node ids)', async () => {
    const samplePath = '../../../src/runtime/sample.ts'
    const { sampleApp } = (await import(/* @vite-ignore */ samplePath)) as { sampleApp: () => unknown }
    const strip = (v: unknown): unknown => Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'id').map(([k, x]) => [k, strip(x)])) : v
    expect(strip(sampleAppDef())).toEqual(strip(JSON.parse(JSON.stringify(sampleApp()))))
  })
})
