import { describe, expect, it } from 'vitest'
import { createPlatform } from './core'
import { MemoryStorage } from './storage'
import { PlatformError } from './contracts'
import type { PlatformApi, TablePrivilege } from './contracts'

async function boot() {
  const p = createPlatform(new MemoryStorage('browser', 'test'), { now: () => new Date('2026-03-15T10:30:00.000Z') })
  await p.init()
  return p
}
const err = (fn: () => unknown): PlatformError | undefined => {
  try {
    fn()
  } catch (e) {
    return e as PlatformError
  }
  return undefined
}
const rerr = async (fn: () => Promise<unknown>): Promise<PlatformError | undefined> => {
  try {
    await fn()
  } catch (e) {
    return e as PlatformError
  }
  return undefined
}

/** a role + user with the given Contacts privilege; the platform is switched to that user */
async function runAs(p: PlatformApi, priv: Partial<TablePrivilege>, email = 'rep@example.com') {
  const contacts = p.tables.get('Contacts')!
  const role = await p.security.createRole({ name: `R${Math.random().toString(36).slice(2, 6)}` })
  await p.security.updateRole(role.id, {
    apps: 'all',
    privileges: [{ table: contacts.id, create: false, read: 'all', update: 'all', delete: 'all', ...priv }],
  })
  const user = await p.security.createUser({ name: 'Rep', email: `${Math.random().toString(36).slice(2, 6)}${email}`, roleIds: [role.id] })
  p.security.setCurrentUser(user.id)
  return user
}

describe('demo mode: extended contract', () => {
  it('reports mode demo, no setup, a session for the run-as user', async () => {
    const p = await boot()
    const s = p.getState()
    expect(s.mode).toBe('demo')
    expect(s.setup).toEqual({ needsDatabase: false, needsAdmin: false })
    expect(s.dataFiles).toEqual([])
    expect(s.loading).toEqual([])
    expect(s.truncated).toEqual([])
    expect(s.session?.user.name).toBe('Admin')
    expect(s.session?.privileges.isAdmin).toBe(true)
    expect(s.session?.privileges.isMaker).toBe(true)
    expect(s.session?.privileges.apps).toBe('all')
    const sam = s.users.find((u) => u.name === 'Sam Maker')!
    p.security.setCurrentUser(sam.id)
    expect(p.getState().session?.user.id).toBe(sam.id)
    expect(p.getState().session?.privileges.isAdmin).toBe(false)
    expect(p.getState().session?.privileges.isMaker).toBe(true)
    const vera = s.users.find((u) => u.name === 'Vera Viewer')!
    p.security.setCurrentUser(vera.id)
    const priv = p.getState().session!.privileges
    expect(priv.isMaker).toBe(false)
    const cid = p.tables.get('Contacts')!.id
    expect(priv.tables[cid]).toMatchObject({ create: false, read: 'all', update: 'none', delete: 'none', filtered: false })
  })

  it('auth, onDataError, connections and tables extras behave as documented', async () => {
    const p = await boot()
    await expect(p.auth.login('a@b.c', 'x')).resolves.toMatchObject({ user: { name: 'Admin' } })
    await expect(p.auth.logout()).resolves.toBeUndefined()
    await expect(p.auth.changePassword('a', 'b')).resolves.toBeUndefined()
    expect((await rerr(() => p.auth.setupDatabase({ host: 'h', port: 1, database: 'd', user: 'u', password: 'p' })))?.code).toBe('unavailable')
    expect((await rerr(() => p.auth.setupAdmin({ name: 'n', email: 'e@e.e', password: 'p' })))?.code).toBe('unavailable')
    const off = p.onDataError(() => {})
    expect(typeof off).toBe('function')
    await expect(p.tables.ensureLoaded(['Contacts'])).resolves.toBeUndefined()
    await expect(p.tables.listSourceTables('conn_local_csv')).resolves.toEqual([])
    expect((await rerr(() => p.tables.linkSourceTable('c', 's')))?.code).toBe('unavailable')
    expect((await rerr(() => p.tables.moveToConnection('t', 'c')))?.code).toBe('unavailable')
    const conn = p.getState().connections[0]
    await expect(p.connections.test(conn.id)).resolves.toEqual({ ok: false, message: 'Available with the local server' })
    expect((await rerr(() => p.connections.setDefault(conn.id)))?.code).toBe('unavailable')
    expect((await rerr(() => p.security.setPassword('u', 'pw')))?.code).toBe('unavailable')
  })

  it('stores attachments as data URLs and survives a reload', async () => {
    const storage = new MemoryStorage('browser', 't')
    const p = createPlatform(storage)
    await p.init()
    const cols = await p.tables.create({ displayName: 'Docs', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'File', type: 'file', accept: ['image/*'], maxSizeMB: 1 }] })
    const row = p.tables.insert('Docs', { Title: 'a' })
    const file = new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' })
    const ref = await p.attachments.upload('Docs', 'File', row.id as string, file)
    expect(ref.id).toMatch(/^att_/)
    expect(ref.url.startsWith('data:image/png;base64,')).toBe(true)
    expect(p.attachments.url(ref.id)).toBe(ref.url)
    expect(ref.sizeBytes).toBe(3)
    expect(p.tables.rows('Docs')[0].File).toBe(ref.id) // upload links the cell
    expect(cols.columns.find((c) => c.name === 'File')).toMatchObject({ type: 'file', accept: ['image/*'], maxSizeMB: 1 })
    expect(await p.attachments.resolve([ref.id, 'att_missing'])).toHaveLength(1)
    // wrong type and unknown column
    const bad = new File(['x'], 'a.pdf', { type: 'application/pdf' })
    expect((await rerr(() => p.attachments.upload('Docs', 'File', row.id as string, bad)))?.code).toBe('invalid')
    expect((await rerr(() => p.attachments.upload('Docs', 'Title', row.id as string, file)))?.code).toBe('invalid')
    await p.tables.flush()
    // reload from the same storage
    const p2 = createPlatform(storage)
    await p2.init()
    expect(p2.attachments.url(ref.id)).toBe(ref.url)
    await p2.attachments.remove(ref.id)
    expect(p2.attachments.url(ref.id)).toBe('')
  })

  it('parses csv and json data files into tables, refuses xlsx', async () => {
    const p = await boot()
    const csv = new File(['Name,Qty\nBolt,5\nNut,7\n'], 'parts.csv', { type: 'text/csv' })
    const f = await p.files.add(csv)
    expect(f).toMatchObject({ kind: 'csv', fileName: 'parts.csv', modifiedSinceImport: false })
    expect(f.tableIds).toHaveLength(1)
    const t = p.getState().tables.find((x) => x.id === f.tableIds[0])!
    expect(t.origin).toMatchObject({ kind: 'file', fileId: f.id })
    expect(p.tables.rows(t.name)).toHaveLength(2)
    expect(t.columns.find((c) => c.name === 'Qty')?.type).toBe('number')
    expect(p.getState().dataFiles).toHaveLength(1)
    expect(p.getState().connections.some((c) => c.id === 'conn_files' && c.scope === 'device')).toBe(true)
    p.tables.insert(t.name, { Name: 'Washer', Qty: 1 })
    expect(p.getState().dataFiles[0].modifiedSinceImport).toBe(true)
    const blob = await p.files.download(f.id)
    expect(await blob.text()).toContain('Washer')
    const replaced = await p.files.replace(f.id, new File(['Name,Qty\nOnly,1\n'], 'parts.csv', { type: 'text/csv' }))
    expect(replaced.modifiedSinceImport).toBe(false)
    expect(p.tables.rows(t.name)).toHaveLength(1)

    const json = new File([JSON.stringify({ people: [{ n: 'a', v: 1 }], pets: [{ n: 'b', tags: ['x'] }] })], 'multi.json')
    const jf = await p.files.add(json)
    expect(jf.tableIds).toHaveLength(2)
    const xlsx = new File(['x'], 'book.xlsx')
    const e = await rerr(() => p.files.add(xlsx))
    expect(e).toMatchObject({ code: 'unavailable', message: 'Excel files need the local server' })

    await p.files.remove(f.id, { dropTables: true })
    expect(p.tables.get(t.id)).toBeUndefined()
    expect(p.getState().dataFiles).toHaveLength(1)
  })
})

describe('demo mode: CLS and RLS simulation', () => {
  it('hides none columns from rows and table definitions for non-admins, not for admins', async () => {
    const p = await boot()
    expect(p.tables.get('Contacts')!.columns.some((c) => c.name === 'Email')).toBe(true)
    await runAs(p, { columns: { Email: 'none', City: 'read' } })
    const def = p.tables.get('Contacts')!
    expect(def.columns.some((c) => c.name === 'Email')).toBe(false)
    expect(def.columns.some((c) => c.name === 'City')).toBe(true)
    expect(p.getState().tables.find((t) => t.name === 'Contacts')!.columns.some((c) => c.name === 'Email')).toBe(false)
    const rows = p.tables.rows('Contacts')
    expect(rows).toHaveLength(8)
    expect('Email' in rows[0]).toBe(false)
    expect(rows[0].City).toBeTruthy()
    const priv = p.getState().session!.privileges.tables[def.id]
    expect(priv.columns).toEqual({ Email: 'none', City: 'read' })
    // raw (secure:false) is untouched, and admin sees everything again
    expect('Email' in p.tables.rows('Contacts', { secure: false })[0]).toBe(true)
    p.security.setCurrentUser(p.getState().users.find((u) => u.name === 'Admin')!.id)
    expect('Email' in p.tables.rows('Contacts')[0]).toBe(true)
    expect(p.tables.get('Contacts')!.columns.some((c) => c.name === 'Email')).toBe(true)
  })

  it('enforces read-only and hidden columns on writes', async () => {
    const p = await boot()
    await runAs(p, { create: true, columns: { City: 'read', Email: 'none' } })
    const id = p.tables.rows('Contacts')[0].id as string
    expect(err(() => p.tables.update('Contacts', id, { City: 'Paris' }))?.code).toBe('denied')
    expect(err(() => p.tables.update('Contacts', id, { Email: 'x@y.zz' }))?.code).toBe('denied')
    expect(err(() => p.tables.insert('Contacts', { Name: 'N', City: 'Paris' }))?.code).toBe('denied')
    const ok = p.tables.update('Contacts', id, { Company: 'ACME' })
    expect(ok.Company).toBe('ACME')
    expect('Email' in ok).toBe(false)
    const created = p.tables.insert('Contacts', { Name: 'New one' })
    expect(created.Name).toBe('New one')
    // raw access still works for the portal admin grid
    expect(p.tables.update('Contacts', id, { City: 'Paris' }, { secure: false }).City).toBe('Paris')
  })

  it('unions column access over roles (the more permissive role wins)', async () => {
    const p = await boot()
    const contacts = p.tables.get('Contacts')!
    const r1 = await p.security.createRole({ name: 'Narrow' })
    const r2 = await p.security.createRole({ name: 'Wide' })
    const base = { table: contacts.id, create: false, read: 'all' as const, update: 'all' as const, delete: 'none' as const }
    await p.security.updateRole(r1.id, { privileges: [{ ...base, columns: { Email: 'none', City: 'none' } }], apps: [] })
    await p.security.updateRole(r2.id, { privileges: [{ ...base, columns: { City: 'read' } }], apps: [] })
    const u = await p.security.createUser({ name: 'Both', email: 'both@example.com', roleIds: [r1.id, r2.id] })
    p.security.setCurrentUser(u.id)
    // Email: none in Narrow, missing (= update) in Wide -> update wins, so it is not listed. City: none vs read -> read.
    expect(p.getState().session!.privileges.tables[contacts.id].columns).toEqual({ City: 'read' })
    expect('Email' in p.tables.rows('Contacts')[0]).toBe(true)
  })

  it('applies row filters with @me and @myEmail (OR across roles, AND inside one)', async () => {
    const p = await boot()
    const contacts = p.tables.get('Contacts')!
    // asha's email matches a seed contact
    const role = await p.security.createRole({ name: 'EmailMatch' })
    await p.security.updateRole(role.id, {
      apps: 'all',
      privileges: [{ table: contacts.id, create: false, read: 'all', update: 'all', delete: 'none', rowFilter: [{ column: 'Email', op: 'eq', value: '@myEmail' }] }],
    })
    const u = await p.security.createUser({ name: 'Asha', email: 'ASHA.RAO@northwind.example', roleIds: [role.id] })
    p.security.setCurrentUser(u.id)
    const rows = p.tables.rows('Contacts')
    expect(rows).toHaveLength(1)
    expect(rows[0].Name).toBe('Asha Rao')
    expect(p.getState().session!.privileges.tables[contacts.id].filtered).toBe(true)
    expect(p.security.can('Contacts', 'update', rows[0])).toBe(true)
    const other = p.tables.rows('Contacts', { secure: false }).find((r) => r.Name === 'Ben Carter')!
    expect(p.security.can('Contacts', 'update', other)).toBe(false)
    expect(err(() => p.tables.update('Contacts', other.id as string, { City: 'X' }))?.code).toBe('denied')
    expect(p.tables.update('Contacts', rows[0].id as string, { City: 'Goa' }).City).toBe('Goa')

    // a second role granting read on own rows widens the union
    const r2 = await p.security.createRole({ name: 'Own' })
    await p.security.updateRole(r2.id, { privileges: [{ table: contacts.id, create: false, read: 'own', update: 'none', delete: 'none' }], apps: [] })
    await p.security.updateUser(u.id, { roleIds: [role.id, r2.id] })
    p.tables.update('Contacts', rows[0].id as string, { Company: 'Z' }) // still allowed through the first role
    expect(p.tables.rows('Contacts').map((r) => r.Name)).toEqual(['Asha Rao']) // nothing is owned by this user
  })

  it('AND of owner and filter for own scope; @me resolves to the user id', async () => {
    const p = await boot()
    const contacts = p.tables.get('Contacts')!
    const role = await p.security.createRole({ name: 'OwnFiltered' })
    await p.security.updateRole(role.id, {
      apps: 'all',
      privileges: [{ table: contacts.id, create: true, read: 'own', update: 'own', delete: 'own', rowFilter: [{ column: 'Status', op: 'eq', value: 'Lead' }] }],
    })
    const u = await p.security.createUser({ name: 'Rep2', email: 'rep2@example.com', roleIds: [role.id] })
    p.security.setCurrentUser(u.id)
    const mine = p.tables.insert('Contacts', { Name: 'Mine', Status: 'Lead' })
    // a user cannot create a row their filter hides (WITH CHECK); seed it raw instead
    expect(() => p.tables.insert('Contacts', { Name: 'Mine too', Status: 'Customer' })).toThrow(/not allowed/)
    p.tables.insert('Contacts', { Name: 'Mine too', Status: 'Customer' }, { secure: false })
    expect(p.tables.rows('Contacts').map((r) => r.Name)).toEqual(['Mine'])
    expect(p.tables.rows('Contacts')[0].owner).toBe(u.id)
    p.tables.delete('Contacts', [mine.id as string])
    expect(p.tables.rows('Contacts')).toHaveLength(0)

    const r2 = await p.security.createRole({ name: 'ByUserId' })
    await p.security.updateRole(r2.id, { privileges: [{ table: contacts.id, create: false, read: 'all', update: 'none', delete: 'none', rowFilter: [{ column: 'owner', op: 'eq', value: '@me' }] }], apps: [] })
    await p.security.updateUser(u.id, { roleIds: [r2.id] })
    expect(p.tables.rows('Contacts').map((r) => r.Name)).toEqual(['Mine too'])
  })

  it('create is checked against the row filter of a role granting create; admins bypass', async () => {
    const p = await boot()
    const contacts = p.tables.get('Contacts')!
    const adminId = p.security.currentUser().id
    const role = await p.security.createRole({ name: 'LeadCreator' })
    await p.security.updateRole(role.id, {
      apps: 'all',
      privileges: [{ table: contacts.id, create: true, read: 'all', update: 'all', delete: 'none', rowFilter: [{ column: 'Status', op: 'eq', value: 'Lead' }] }],
    })
    const u = await p.security.createUser({ name: 'Lc', email: 'lc@example.com', roleIds: [role.id] })
    p.security.setCurrentUser(u.id)
    const before = p.tables.rows('Contacts').length
    expect(() => p.tables.insert('Contacts', { Name: 'Nope', Status: 'Customer' })).toThrow(expect.objectContaining({ code: 'denied' }))
    expect(p.tables.rows('Contacts')).toHaveLength(before)
    expect(p.tables.insert('Contacts', { Name: 'Ok', Status: 'Lead' }).Name).toBe('Ok')
    // admin bypasses the same check
    p.security.setCurrentUser(adminId)
    expect(p.tables.insert('Contacts', { Name: 'Admin made', Status: 'Customer' }).Status).toBe('Customer')
  })

  it('update must satisfy the update predicate after the change; leaving read visibility is allowed', async () => {
    const p = await boot()
    const contacts = p.tables.get('Contacts')!
    const adminId = p.security.currentUser().id
    const seeded = p.tables.insert('Contacts', { Name: 'Seed', Status: 'Lead' })
    const role = await p.security.createRole({ name: 'LeadEditor' })
    await p.security.updateRole(role.id, {
      apps: 'all',
      privileges: [
        { table: contacts.id, create: false, read: 'all', update: 'all', delete: 'none', rowFilter: [{ column: 'Status', op: 'eq', value: 'Lead' }] },
      ],
    })
    const u = await p.security.createUser({ name: 'Le', email: 'le@example.com', roleIds: [role.id] })
    p.security.setCurrentUser(u.id)
    // moving the row out of the filter is denied (read and update share the filter here), row unchanged
    expect(() => p.tables.update('Contacts', seeded.id as string, { Status: 'Customer' })) .toThrow(expect.objectContaining({ code: 'denied' }))
    p.security.setCurrentUser(adminId)
    expect(p.tables.rows('Contacts').find((r) => r.id === seeded.id)!.Status).toBe('Lead')
    // admin may move it anywhere
    expect(p.tables.update('Contacts', seeded.id as string, { Status: 'Customer' }).Status).toBe('Customer')

    // update allowed for any row, read limited to Leads: the row may leave read visibility
    const r2 = await p.security.createRole({ name: 'ReadLeadsEditAll' })
    await p.security.updateRole(r2.id, {
      apps: 'all',
      privileges: [{ table: contacts.id, create: false, read: 'all', update: 'all', delete: 'none', rowFilter: undefined }],
    })
    const r3 = await p.security.createRole({ name: 'ReadLeadsOnly' })
    await p.security.updateRole(r3.id, {
      apps: 'all',
      privileges: [{ table: contacts.id, create: false, read: 'all', update: 'none', delete: 'none', rowFilter: [{ column: 'Status', op: 'eq', value: 'Lead' }] }],
    })
    await p.security.updateUser(u.id, { roleIds: [r2.id, r3.id] })
    p.security.setCurrentUser(u.id)
    const lead = p.tables.insert('Contacts', { Name: 'L', Status: 'Lead' }, { secure: false })
    // update predicate (all rows) holds after the change although the row leaves the read filter of r3 (r2 still reads it)
    expect(() => p.tables.update('Contacts', lead.id as string, { Status: 'Customer' })).not.toThrow()
  })

  it('a rowFilter on a missing column grants nothing', async () => {
    const p = await boot()
    await runAs(p, { rowFilter: [{ column: 'Nope', op: 'eq', value: 'x' }] })
    expect(p.tables.rows('Contacts')).toHaveLength(0)
  })
})
