import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { createPlatform } from './core'
import { MemoryStorage } from './storage'
import { PlatformError } from './contracts'
import type { ColumnDef, PlatformApi } from './contracts'
import { parseCsvText, rowsToCsv } from './csv'
import { coerceValue, inferType, toIdentifier, uniqueIdentifier, uniqueLabel } from './values'

const FIXED = new Date('2026-03-15T10:30:00.000Z')

async function boot(storage = new MemoryStorage('local-folder', '/tmp/ws'), opts: Parameters<typeof createPlatform>[1] = {}) {
  const p = createPlatform(storage, { now: () => new Date(FIXED), ...opts })
  await p.init()
  return { p, storage }
}

/** a workspace that does not trigger seeding */
async function bootEmpty() {
  const storage = new MemoryStorage('local-folder', '/tmp/empty')
  storage.files.set('workspace.yaml', 'formatVersion: 1\n')
  return boot(storage)
}

function code(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (e) {
    return e instanceof PlatformError ? e.code : `other:${String(e)}`
  }
  return undefined
}
async function acode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn()
  } catch (e) {
    return e instanceof PlatformError ? e.code : `other:${String(e)}`
  }
  return undefined
}

const asUser = (p: PlatformApi, name: string) => {
  const u = p.getState().users.find((x) => x.name === name)!
  p.security.setCurrentUser(u.id)
  return u
}

describe('init and seed', () => {
  it('seeds a sample workspace on first run', async () => {
    const { p, storage } = await boot()
    const s = p.getState()
    expect(s.ready).toBe(true)
    expect(s.storage).toEqual({ kind: 'local-folder', location: '/tmp/ws' })
    expect(s.users.map((u) => u.name)).toEqual(['Admin', 'Sam Maker', 'Vera Viewer'])
    expect(s.roles.map((r) => r.name)).toEqual(['Administrator', 'Maker', 'Viewer'])
    expect(s.roles[0].isAdmin).toBe(true)
    expect(s.tables.map((t) => t.name).sort()).toEqual(['Contacts', 'Orders'])
    expect(p.tables.rows('Contacts')).toHaveLength(8)
    expect(p.tables.rows('Orders')).toHaveLength(12)
    expect(s.connections).toHaveLength(1)
    expect(s.connections[0]).toMatchObject({ name: 'Local CSV', connector: 'local-csv', status: 'connected' })
    expect(s.solutions).toHaveLength(1)
    expect(s.solutions[0].name).toBe('Default')
    expect(s.solutions[0].components.filter((c) => c.kind === 'table')).toHaveLength(2)
    expect(s.solutions[0].components.filter((c) => c.kind === 'app')).toHaveLength(1)
    expect(s.apps).toHaveLength(1)
    expect(s.apps[0]).toMatchObject({ name: 'Contacts app', width: 1920, height: 1080 })
    expect(s.currentUserId).toBe(s.users[0].id)
    expect(storage.files.has('workspace.yaml')).toBe(true)
    expect(storage.files.has('tables/Contacts.csv')).toBe(true)
    expect(storage.files.has('tables/Orders.schema.yaml')).toBe(true)
    expect([...storage.files.keys()].some((k) => k.startsWith('apps/') && k.endsWith('.app.yaml'))).toBe(true)
  })

  it('seeded orders use an autonumber and valid lookups', async () => {
    const { p } = await boot()
    const orders = p.tables.rows('Orders')
    expect(orders[0].OrderNo).toBe('ORD-0001')
    expect(orders[11].OrderNo).toBe('ORD-0012')
    const ids = new Set(p.tables.rows('Contacts').map((r) => r.id))
    expect(orders.every((o) => ids.has(o.Customer as string))).toBe(true)
    expect(orders[0].OrderDate).toBeInstanceOf(Date)
    expect(typeof orders[0].Amount).toBe('number')
  })

  it('is idempotent and a second boot loads instead of seeding', async () => {
    const { p, storage } = await boot()
    const again = p.init()
    expect(await again).toBeUndefined()
    const firstIds = p.tables.rows('Contacts').map((r) => r.id)
    await p.tables.flush()
    const { p: p2 } = await boot(storage)
    expect(p2.tables.rows('Contacts').map((r) => r.id)).toEqual(firstIds)
    expect(p2.getState().apps).toHaveLength(1)
    expect(p2.getState().users).toHaveLength(3)
    expect(p2.getState().solutions).toHaveLength(1)
  })

  it('does not seed when a workspace already has tables, and repairs missing admin', async () => {
    const { p } = await bootEmpty()
    expect(p.getState().tables).toHaveLength(0)
    expect(p.getState().users).toHaveLength(1)
    expect(p.getState().roles[0].isAdmin).toBe(true)
  })

  it('falls back to temporary memory storage instead of throwing when storage fails', async () => {
    const broken = new MemoryStorage()
    broken.readText = async () => {
      throw new Error('disk on fire')
    }
    const p = createPlatform(broken, { now: () => new Date(FIXED) })
    await p.init()
    expect(p.getState().ready).toBe(true)
    expect(p.getState().storage.location).toMatch(/temporary/)
  })

  it('a storage factory that rejects still yields a working workspace', async () => {
    const p = createPlatform(async () => {
      throw new Error('no storage')
    })
    await p.init()
    expect(p.getState().ready).toBe(true)
    expect(p.tables.rows('Contacts')).toHaveLength(8)
  })

  it('backs up and survives a corrupt workspace.yaml', async () => {
    const storage = new MemoryStorage()
    storage.files.set('workspace.yaml', 'a: [unclosed')
    const { p } = await boot(storage)
    expect(p.getState().ready).toBe(true)
    expect([...storage.files.keys()].some((k) => k.startsWith('workspace.yaml.corrupt-'))).toBe(true)
  })
})

describe('state and subscriptions', () => {
  it('produces a new state object and bumps dataVersion on every row change', async () => {
    const { p } = await boot()
    const s0 = p.getState()
    let calls = 0
    const off = p.subscribe(() => calls++)
    const row = p.tables.insert('Contacts', { Name: 'Zed' })
    const s1 = p.getState()
    expect(s1).not.toBe(s0)
    expect(s1.dataVersion).toBe(s0.dataVersion + 1)
    p.tables.update('Contacts', row.id as string, { City: 'Pune' })
    expect(p.getState().dataVersion).toBe(s0.dataVersion + 2)
    p.tables.delete('Contacts', [row.id as string])
    expect(p.getState().dataVersion).toBe(s0.dataVersion + 3)
    expect(calls).toBe(3)
    off()
    p.tables.insert('Contacts', { Name: 'Quiet' })
    expect(calls).toBe(3)
    expect(p.getState()).toBe(p.getState()) // stable between changes
  })

  it('bumps dataVersion when the current user changes (row visibility depends on it)', async () => {
    const { p } = await boot()
    const v = p.getState().dataVersion
    asUser(p, 'Vera Viewer')
    expect(p.getState().dataVersion).toBe(v + 1)
    expect(p.getState().currentUserId).toBe(p.security.currentUser().id)
  })
})

describe('typed CSV round trip', () => {
  const columns: Partial<ColumnDef>[] = [
    { displayName: 'Title', type: 'text' },
    { displayName: 'Notes', type: 'multiline' },
    { displayName: 'Qty', type: 'number' },
    { displayName: 'Price', type: 'currency' },
    { displayName: 'Ratio', type: 'decimal' },
    { displayName: 'Done', type: 'boolean' },
    { displayName: 'Due', type: 'date' },
    { displayName: 'Seen', type: 'datetime' },
    { displayName: 'Kind', type: 'choice', choices: ['A', 'B'] },
  ]

  it('keeps quotes, commas, newlines, unicode, dates and booleans', async () => {
    const { p } = await bootEmpty()
    const t = await p.tables.create({ displayName: 'Stuff', columns })
    const tricky = 'He said "hi", then\nleft ✓ café'
    const r = p.tables.insert('Stuff', {
      Title: tricky, Notes: 'line1\r\nline2,with comma', Qty: 7, Price: '12.5', Ratio: 0.125, Done: 'yes',
      Due: '2026-02-28', Seen: '2026-03-01T08:15:30.000Z', Kind: 'b',
    })
    expect(r.Kind).toBe('B')
    expect(r.Done).toBe(true)
    expect(r.Price).toBe(12.5)
    const text = p.tables.exportCsv('Stuff')
    const [header] = text.split('\r\n')
    expect(header).toBe('id,createdOn,modifiedOn,createdBy,owner,Title,Notes,Qty,Price,Ratio,Done,Due,Seen,Kind')
    expect(text).toContain('"He said ""hi"", then\nleft ✓ café"')
    expect(text).toContain(',true,2026-02-28,2026-03-01T08:15:30.000Z,B')
    // blank cell for a blank value
    p.tables.insert('Stuff', { Title: 'blank' })
    expect(p.tables.exportCsv('Stuff').split('\r\n').at(-1)).toMatch(/,blank,,,,,,,,$/)
    // replace-import the export: every typed value survives
    const before = p.tables.rows('Stuff')
    await p.tables.importCsv('Stuff', p.tables.exportCsv('Stuff'), 'replace')
    const after = p.tables.rows('Stuff')
    expect(after).toHaveLength(2)
    expect(after[0].Title).toBe(tricky)
    expect(after[0].Notes).toBe('line1\r\nline2,with comma')
    expect(after[0].id).toBe(before[0].id)
    expect(after[0].Due).toEqual(new Date(2026, 1, 28))
    expect(after[0].Seen).toEqual(new Date('2026-03-01T08:15:30.000Z'))
    expect(after[0].Done).toBe(true)
    expect(after[0].Qty).toBe(7)
    expect(after[1].Qty).toBeNull()
    expect(t.columns.filter((c) => c.system)).toHaveLength(5)
  })

  it('survives a save and a reload from storage', async () => {
    const { p, storage } = await bootEmpty()
    await p.tables.create({ displayName: 'Stuff', columns })
    const row = p.tables.insert('Stuff', { Title: 'a,b', Due: '2026-01-31', Seen: '2026-01-31T23:59:59.000Z', Done: false })
    await p.tables.flush()
    const { p: p2 } = await boot(storage)
    const again = p2.tables.rows('Stuff')[0]
    expect(again.id).toBe(row.id)
    expect(again.__id).toBe(row.id)
    expect(again.Title).toBe('a,b')
    expect(again.Due).toEqual(new Date(2026, 0, 31))
    expect(again.Seen).toEqual(new Date('2026-01-31T23:59:59.000Z'))
    expect(again.Done).toBe(false)
    expect(again.createdOn).toEqual(FIXED)
  })

  it('parses hand-edited CSV (BOM, LF, blank lines) leniently', async () => {
    const storage = new MemoryStorage()
    storage.files.set('workspace.yaml', 'formatVersion: 1\n')
    storage.files.set('tables/T.schema.yaml', yaml.dump({ name: 'T', displayName: 'T', columns: [{ name: 'N', displayName: 'N', type: 'number' }] }))
    storage.files.set('tables/T.csv', '﻿N\n5\n\nnot-a-number\n')
    const { p } = await boot(storage)
    const rows = p.tables.rows('T')
    expect(rows).toHaveLength(2)
    expect(rows[0].N).toBe(5)
    expect(rows[1].N).toBeNull()
    expect(typeof rows[0].id).toBe('string') // ids are created for rows without one
  })

  it('csv helpers: parse and unparse agree', () => {
    const cols: ColumnDef[] = [{ name: 'a', displayName: 'a', type: 'text' }, { name: 'b', displayName: 'b', type: 'text' }]
    const csv = rowsToCsv(cols, [{ a: 'x,y', b: 'q"r' }, { a: null, b: 'z' }])
    expect(csv).toBe('a,b\r\n"x,y","q""r"\r\n,z')
    expect(parseCsvText(csv).records).toEqual([{ a: 'x,y', b: 'q"r' }, { a: '', b: 'z' }])
    expect(parseCsvText('').headers).toEqual([])
  })
})

describe('validation', () => {
  it('enforces required, unique and types on insert', async () => {
    const { p } = await boot()
    expect(code(() => p.tables.insert('Contacts', { Company: 'No name' }))).toBe('invalid')
    expect(code(() => p.tables.insert('Contacts', { Name: '   ' }))).toBe('invalid')
    expect(code(() => p.tables.insert('Contacts', { Name: 'X', Email: 'nope' }))).toBe('invalid')
    expect(code(() => p.tables.insert('Contacts', { Name: 'X', Active: 'maybe' }))).toBe('invalid')
    expect(code(() => p.tables.insert('Contacts', { Name: 'X', Status: 'Imaginary' }))).toBe('invalid')
    expect(code(() => p.tables.insert('Contacts', { Name: 'X', Nonexistent: 1 }))).toBe('invalid')
    expect(code(() => p.tables.insert('Orders', { Customer: 'x', Amount: 'abc' }))).toBe('invalid')
    expect(code(() => p.tables.insert('Orders', { Customer: p.tables.rows('Contacts')[0].id, OrderDate: '2026-02-31' }))).toBe('invalid')
    expect(p.tables.rows('Contacts')).toHaveLength(8) // nothing was stored
  })

  it('applies defaults and coerces values', async () => {
    const { p } = await boot()
    const r = p.tables.insert('Contacts', { Name: 'Defaults' })
    expect(r.Active).toBe(true)
    expect(r.Status).toBe('Lead')
    expect(r.createdBy).toBe(p.security.currentUser().id)
    expect(r.owner).toBe(r.createdBy)
    expect(r.createdOn).toEqual(FIXED)
    expect(r.__id).toBe(r.id)
    const o = p.tables.insert('Orders', { Customer: p.tables.rows('Contacts')[0].id, Amount: '1,234.567' })
    expect(o.Amount).toBe(1234.567)
    expect(o.OrderDate).toEqual(new Date(2026, 2, 15)) // default "today"
    expect(o.Status).toBe('New')
  })

  it('enforces unique case-insensitively, also on update', async () => {
    const { p } = await bootEmpty()
    const t = await p.tables.create({ displayName: 'Codes', columns: [{ displayName: 'Code', unique: true, required: true }] })
    const a = p.tables.insert('Codes', { Code: 'abc' })
    expect(code(() => p.tables.insert('Codes', { Code: 'ABC' }))).toBe('invalid')
    const b = p.tables.insert('Codes', { Code: 'def' })
    expect(code(() => p.tables.update('Codes', b.id as string, { Code: 'Abc' }))).toBe('invalid')
    expect(p.tables.update('Codes', a.id as string, { Code: 'abc' }).Code).toBe('abc') // own value is fine
    expect(code(() => p.tables.update('Codes', a.id as string, { Code: '' }))).toBe('invalid') // required
    expect(t.name).toBe('Codes')
  })

  it('validates lookups against the target table, accepts records, and unknown rows are not-found', async () => {
    const { p } = await boot()
    const c = p.tables.rows('Contacts')[2]
    expect(code(() => p.tables.insert('Orders', { Customer: 'no-such-id' }))).toBe('invalid')
    expect(p.tables.insert('Orders', { Customer: c.id }).Customer).toBe(c.id)
    expect(p.tables.insert('Orders', { Customer: c }).Customer).toBe(c.id) // a whole record works too
    expect(code(() => p.tables.update('Orders', 'missing', { Amount: 1 }))).toBe('not-found')
    expect(code(() => p.tables.rows('Nope'))).toBe('not-found')
  })

  it('ignores system columns and autonumbers in updates; update without change keeps modifiedOn', async () => {
    const { p } = await boot()
    const r = p.tables.rows('Orders')[0]
    const u = p.tables.update('Orders', r.id as string, { id: 'hacked', OrderNo: 'ORD-9999', owner: 'someone', createdOn: new Date(0), Amount: 10 })
    expect(u.id).toBe(r.id)
    expect(u.OrderNo).toBe('ORD-0001')
    expect(u.owner).toBe(r.owner)
    expect(u.createdOn).toEqual(r.createdOn)
    expect(u.Amount).toBe(10)
    const same = p.tables.update('Orders', r.id as string, { Amount: 10 })
    expect(same).toBe(u)
  })

  it('coerceValue handles every type directly', () => {
    const col = (type: ColumnDef['type'], extra: Partial<ColumnDef> = {}): ColumnDef => ({ name: 'c', displayName: 'C', type, ...extra })
    expect(coerceValue(col('number'), '42')).toBe(42)
    expect(() => coerceValue(col('number'), 4.5)).toThrow(PlatformError)
    expect(coerceValue(col('decimal'), '4.5')).toBe(4.5)
    expect(coerceValue(col('boolean'), 'No')).toBe(false)
    expect(coerceValue(col('url'), 'https://example.com/x')).toBe('https://example.com/x')
    expect(() => coerceValue(col('url'), 'not a url')).toThrow(PlatformError)
    expect(() => coerceValue(col('url'), 'data:text/html;base64,PGI+')).toThrow(PlatformError)
    expect(coerceValue(col('currency'), '1.23456')).toBe(1.2346)
    expect(coerceValue(col('phone'), '+91 98765-43210')).toBe('+91 98765-43210')
    expect(() => coerceValue(col('phone'), 'call me')).toThrow(PlatformError)
    expect(coerceValue(col('date'), new Date(2026, 4, 17, 13, 45))).toEqual(new Date(2026, 4, 17))
    expect(coerceValue(col('text'), '')).toBeNull()
    expect(coerceValue(col('number'), null)).toBeNull()
  })

  it('inferType, identifier and label helpers', () => {
    expect(inferType(['1', '2', ''])).toBe('number')
    expect(inferType(['1.5', '2'])).toBe('decimal')
    expect(inferType(['true', 'FALSE'])).toBe('boolean')
    expect(inferType(['2026-01-02', '2026-12-31'])).toBe('date')
    expect(inferType(['a@b.co', 'c@d.io'])).toBe('email')
    expect(inferType(['hello', '1'])).toBe('text')
    expect(toIdentifier('Sales orders (2024)')).toBe('SalesOrders2024')
    expect(toIdentifier('9 lives')).toBe('_9Lives')
    expect(toIdentifier('???', 'Table')).toBe('Table')
    expect(uniqueIdentifier('Orders', ['orders', 'Orders_2'])).toBe('Orders_3')
    expect(uniqueLabel('App', ['App', 'App (2)'])).toBe('App (3)')
  })
})

describe('autonumber', () => {
  it('increments, never reuses a deleted number in a session, and recovers from the file', async () => {
    const { p, storage } = await boot()
    const a = p.tables.insert('Orders', { Customer: p.tables.rows('Contacts')[0].id })
    expect(a.OrderNo).toBe('ORD-0013')
    p.tables.delete('Orders', [a.id as string])
    const b = p.tables.insert('Orders', { Customer: p.tables.rows('Contacts')[0].id })
    expect(b.OrderNo).toBe('ORD-0014')
    await p.tables.flush()
    const { p: p2 } = await boot(storage)
    const c = p2.tables.insert('Orders', { Customer: p2.tables.rows('Contacts')[0].id })
    expect(c.OrderNo).toBe('ORD-0015')
  })

  it('adding an autonumber column numbers the existing rows', async () => {
    const { p } = await bootEmpty()
    await p.tables.create({ displayName: 'Things' })
    p.tables.insert('Things', { Name: 'a' })
    p.tables.insert('Things', { Name: 'b' })
    const col = await p.tables.addColumn(p.tables.get('Things')!.id, { displayName: 'Ticket', type: 'autonumber', prefix: 'T-' })
    expect(col.name).toBe('Ticket')
    expect(p.tables.rows('Things').map((r) => r.Ticket)).toEqual(['T-0001', 'T-0002'])
    expect(p.tables.insert('Things', { Name: 'c' }).Ticket).toBe('T-0003')
  })
})

describe('role security (single-machine simulation)', () => {
  it('viewer reads but cannot write; maker and admin can', async () => {
    const { p } = await boot()
    const id = p.tables.rows('Contacts')[0].id as string
    asUser(p, 'Vera Viewer')
    expect(p.tables.rows('Contacts')).toHaveLength(8)
    expect(p.security.can('Contacts', 'read')).toBe(true)
    expect(p.security.can('Contacts', 'create')).toBe(false)
    expect(code(() => p.tables.insert('Contacts', { Name: 'Nope' }))).toBe('denied')
    expect(code(() => p.tables.update('Contacts', id, { City: 'X' }))).toBe('denied')
    expect(code(() => p.tables.delete('Contacts', [id]))).toBe('denied')
    expect(p.tables.insert('Contacts', { Name: 'Raw' }, { secure: false }).Name).toBe('Raw') // portal admin grid
    expect(p.tables.rows('Contacts')).toHaveLength(9)
    asUser(p, 'Sam Maker')
    expect(p.tables.insert('Contacts', { Name: 'By Sam' }).owner).toBe(p.security.currentUser().id)
    asUser(p, 'Admin')
    expect(p.security.can('Orders', 'delete')).toBe(true)
  })

  it('"own" scope filters rows and per-row writes by owner', async () => {
    const { p } = await boot()
    const contacts = p.tables.get('Contacts')!
    const role = await p.security.createRole({ name: 'Rep' })
    await p.security.updateRole(role.id, { privileges: [{ table: contacts.id, create: true, read: 'own', update: 'own', delete: 'own' }] })
    const olga = await p.security.createUser({ name: 'Olga', email: 'olga@x.test', roleIds: [role.id] })
    const adminRow = p.tables.rows('Contacts')[0]
    p.security.setCurrentUser(olga.id)
    expect(p.tables.rows('Contacts')).toHaveLength(0)
    expect(p.tables.rows('Contacts', { secure: false })).toHaveLength(8)
    const mine = p.tables.insert('Contacts', { Name: 'Mine' })
    expect(p.tables.rows('Contacts').map((r) => r.id)).toEqual([mine.id])
    expect(p.security.can('Contacts', 'update', mine)).toBe(true)
    expect(p.security.can('Contacts', 'update', adminRow)).toBe(false)
    expect(code(() => p.tables.update('Contacts', adminRow.id as string, { City: 'Z' }))).toBe('denied')
    expect(code(() => p.tables.delete('Contacts', [adminRow.id as string]))).toBe('denied')
    expect(p.tables.update('Contacts', mine.id as string, { City: 'Home' }).City).toBe('Home')
    p.tables.delete('Contacts', [mine.id as string])
    expect(p.tables.rows('Contacts', { secure: false })).toHaveLength(8)
    expect(p.tables.rows('Orders')).toHaveLength(0) // no privilege entry = none
    expect(code(() => p.tables.insert('Orders', { Customer: adminRow.id }))).toBe('denied')
  })

  it('unions roles and the broadest scope wins; admin bypasses', async () => {
    const { p } = await boot()
    const contacts = p.tables.get('Contacts')!
    const own = await p.security.createRole({ name: 'OwnOnly' })
    await p.security.updateRole(own.id, { privileges: [{ table: contacts.id, create: false, read: 'own', update: 'none', delete: 'none' }] })
    const all = await p.security.createRole({ name: 'ReadAll' })
    await p.security.updateRole(all.id, { privileges: [{ table: contacts.id, create: false, read: 'all', update: 'none', delete: 'none' }] })
    const u = await p.security.createUser({ name: 'Both', email: 'both@x.test', roleIds: [own.id, all.id] })
    p.security.setCurrentUser(u.id)
    expect(p.tables.rows('Contacts')).toHaveLength(8)
    await p.security.updateUser(u.id, { roleIds: [own.id] })
    expect(p.tables.rows('Contacts')).toHaveLength(0)
    asUser(p, 'Admin')
    expect(p.tables.rows('Contacts')).toHaveLength(8)
  })

  it('new tables inherit sensible privileges for existing roles', async () => {
    const { p } = await boot()
    await p.tables.create({ displayName: 'Tasks' })
    asUser(p, 'Sam Maker')
    expect(p.tables.insert('Tasks', { Name: 'ship it' }).Name).toBe('ship it')
    asUser(p, 'Vera Viewer')
    expect(p.tables.rows('Tasks')).toHaveLength(1)
    expect(code(() => p.tables.insert('Tasks', { Name: 'x' }))).toBe('denied')
  })

  it('canRunApp follows role app lists', async () => {
    const { p } = await boot()
    const appId = p.getState().apps[0].id
    asUser(p, 'Vera Viewer')
    expect(p.security.canRunApp(appId)).toBe(true) // viewer role: all apps
    const role = await p.security.createRole({ name: 'NoApps' })
    const u = await p.security.createUser({ name: 'Nia', email: 'nia@x.test', roleIds: [role.id] })
    p.security.setCurrentUser(u.id)
    expect(p.security.canRunApp(appId)).toBe(false)
    await p.security.updateRole(role.id, { apps: [appId] })
    expect(p.security.canRunApp(appId)).toBe(true)
  })

  it('protects the last administrator and validates users and roles', async () => {
    const { p } = await boot()
    const admin = p.getState().users[0]
    const adminRole = p.getState().roles[0]
    expect(await acode(() => p.security.removeUser(admin.id))).toBe('conflict')
    expect(await acode(() => p.security.removeRole(adminRole.id))).toBe('conflict')
    expect(await acode(() => p.security.updateRole(adminRole.id, { isAdmin: false }))).toBe('conflict')
    expect(await acode(() => p.security.updateUser(admin.id, { roleIds: [] }))).toBe('conflict')
    expect(await acode(() => p.security.createRole({ name: 'maker' }))).toBe('conflict') // case-insensitive duplicate
    expect(await acode(() => p.security.createUser({ name: 'Dup', email: 'ADMIN@appbuilder.local' }))).toBe('conflict')
    expect(await acode(() => p.security.createUser({ name: '', email: 'x@y.z' }))).toBe('invalid')
    expect(() => p.security.setCurrentUser('ghost')).toThrow(PlatformError)
    expect(await acode(() => p.security.removeRole('ghost'))).toBe('not-found')
    // removing a role detaches it from its users
    const maker = p.getState().roles.find((r) => r.name === 'Maker')!
    await p.security.removeRole(maker.id)
    expect(p.getState().users.find((u) => u.name === 'Sam Maker')!.roleIds).toEqual([])
    // removing the current user moves the session to an admin
    const sam = await p.security.createUser({ name: 'Temp', email: 't@x.test', roleIds: [] })
    p.security.setCurrentUser(sam.id)
    await p.security.removeUser(sam.id)
    expect(p.security.currentUser().name).toBe('Admin')
  })

  it('persists the current user and roles', async () => {
    const { p, storage } = await boot()
    asUser(p, 'Sam Maker')
    await p.tables.flush()
    const { p: p2 } = await boot(storage)
    expect(p2.security.currentUser().name).toBe('Sam Maker')
    expect(p2.getState().roles).toHaveLength(3)
  })
})

describe('persistence', () => {
  it('debounces CSV writes, serialises them and flush() resolves when written', async () => {
    const { p, storage } = await boot(undefined, { debounceMs: 60_000, maxWaitMs: 120_000 })
    const before = storage.files.get('tables/Contacts.csv')!
    p.tables.insert('Contacts', { Name: 'Late Writer' })
    p.tables.insert('Contacts', { Name: 'Another' })
    expect(storage.files.get('tables/Contacts.csv')).toBe(before)
    await p.tables.flush()
    const after = storage.files.get('tables/Contacts.csv')!
    expect(after).toContain('Late Writer')
    expect(after).toContain('Another')
    expect(after.split('\r\n')).toHaveLength(11) // header + 10 rows
  })

  it('timer based writes land without flush', async () => {
    const { p, storage } = await boot(undefined, { debounceMs: 10, maxWaitMs: 50 })
    p.tables.insert('Contacts', { Name: 'Timer Row' })
    await new Promise((r) => setTimeout(r, 120))
    expect(storage.files.get('tables/Contacts.csv')).toContain('Timer Row')
  })

  it('reload() re-reads the CSV from storage (and keeps pending edits)', async () => {
    const { p, storage } = await boot()
    p.tables.insert('Contacts', { Name: 'Pending' })
    await p.tables.reload('Contacts')
    expect(p.tables.rows('Contacts').some((r) => r.Name === 'Pending')).toBe(true)
    const csv = storage.files.get('tables/Contacts.csv')!
    storage.files.set('tables/Contacts.csv', csv.split('\r\n').slice(0, 3).join('\r\n'))
    await p.tables.reload('Contacts')
    expect(p.tables.rows('Contacts')).toHaveLength(2)
  })

  it('reports background write failures through onStorageError instead of throwing', async () => {
    const errors: unknown[] = []
    const storage = new MemoryStorage()
    const { p } = await boot(storage, { onStorageError: (e) => errors.push(e) })
    storage.writeText = async () => {
      throw new Error('disk full')
    }
    p.tables.insert('Contacts', { Name: 'Doomed' })
    await p.tables.flush()
    expect(errors).toHaveLength(1)
    expect(p.tables.rows('Contacts').some((r) => r.Name === 'Doomed')).toBe(true)
  })
})

describe('tables: schema operations', () => {
  it('creates tables with unique identifier names and system columns', async () => {
    const { p } = await bootEmpty()
    const a = await p.tables.create({ displayName: 'Sales orders' })
    const b = await p.tables.create({ displayName: 'Sales Orders' })
    expect(a.name).toBe('SalesOrders')
    expect(b.name).toBe('SalesOrders_2')
    expect(a.columns.slice(0, 5).map((c) => c.name)).toEqual(['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner'])
    expect(a.columns.slice(0, 5).every((c) => c.system)).toBe(true)
    expect(a.primaryColumn).toBe('Name')
    expect(await acode(() => p.tables.create({ displayName: 'X', name: 'SalesOrders' }))).toBe('conflict')
    expect(await acode(() => p.tables.create({ displayName: 'X', name: '1bad' }))).toBe('invalid')
    expect(await acode(() => p.tables.create({ displayName: '  ' }))).toBe('invalid')
    expect(p.tables.get('salesorders')?.id).toBe(a.id) // lookup by name ignoring case, or by id
    expect(p.tables.get(b.id)?.name).toBe('SalesOrders_2')
    expect(p.tables.get('nothing')).toBeUndefined()
  })

  it('both overloads of tables.update work: definition patch and row update', async () => {
    const { p } = await bootEmpty()
    const t = await p.tables.create({ displayName: 'Things', columns: [{ displayName: 'Label' }, { displayName: 'Size', type: 'number' }] })
    await p.tables.update(t.id, { displayName: 'All things', description: 'stuff', primaryColumn: 'Size' })
    const def = p.tables.get(t.id)!
    expect(def.displayName).toBe('All things')
    expect(def.description).toBe('stuff')
    expect(def.primaryColumn).toBe('Size')
    expect(await acode(() => p.tables.update(t.id, { primaryColumn: 'Missing' }) as Promise<void>)).toBe('invalid')
    const row = p.tables.insert('Things', { Label: 'x', Size: 1 })
    expect(p.tables.update('Things', row.id as string, { Size: 2 }).Size).toBe(2)
  })

  it('adds, edits and removes columns', async () => {
    const { p } = await boot()
    const contacts = p.tables.get('Contacts')!
    const col = await p.tables.addColumn(contacts.id, { displayName: 'Score', type: 'number', default: '5' })
    expect(col.name).toBe('Score')
    expect(p.tables.rows('Contacts').every((r) => r.Score === 5)).toBe(true)
    expect(await acode(() => p.tables.addColumn(contacts.id, { displayName: 'x', name: 'score', type: 'text' }))).toBe('conflict')
    expect(await acode(() => p.tables.addColumn(contacts.id, { displayName: 'L', type: 'lookup' }))).toBe('invalid')
    expect(await acode(() => p.tables.addColumn(contacts.id, { displayName: 'Bad', type: 'number', default: 'abc' }))).toBe('invalid')
    await p.tables.updateColumn(contacts.id, 'Score', { displayName: 'Rating', required: true })
    expect(p.tables.get('Contacts')!.columns.find((c) => c.name === 'Score')).toMatchObject({ displayName: 'Rating', required: true })
    expect(await acode(() => p.tables.updateColumn(contacts.id, 'Score', { name: 'Other' }))).toBe('invalid') // rename = displayName only
    expect(await acode(() => p.tables.updateColumn(contacts.id, 'id', { displayName: 'ID' }))).toBe('invalid') // system
    expect(await acode(() => p.tables.removeColumn(contacts.id, 'owner'))).toBe('invalid')
    expect(await acode(() => p.tables.removeColumn(contacts.id, 'Ghost'))).toBe('not-found')
    // change a type: values convert, impossible conversions are refused and nothing changes
    await p.tables.updateColumn(contacts.id, 'Score', { type: 'text' })
    expect(p.tables.rows('Contacts')[0].Score).toBe('5')
    expect(await acode(() => p.tables.updateColumn(contacts.id, 'City', { type: 'number' }))).toBe('invalid')
    expect(p.tables.get('Contacts')!.columns.find((c) => c.name === 'City')!.type).toBe('text')
    // remove the primary column: primary falls back to the next user column
    await p.tables.removeColumn(contacts.id, 'Name')
    expect(p.tables.get('Contacts')!.primaryColumn).toBe('Company')
    expect('Name' in p.tables.rows('Contacts')[0]).toBe(false)
    expect(p.tables.exportCsv('Contacts').split('\r\n')[0]).not.toContain('Name')
  })

  it('choice columns keep their choices and lookups need a target', async () => {
    const { p } = await bootEmpty()
    const t = await p.tables.create({ displayName: 'Bugs', columns: [{ displayName: 'Title' }, { displayName: 'Severity', type: 'choice', choices: [' Low ', 'High', 'High', ''] }] })
    expect(t.columns.find((c) => c.name === 'Severity')!.choices).toEqual(['Low', 'High'])
    expect(code(() => p.tables.insert('Bugs', { Title: 'a', Severity: 'Medium' }))).toBe('invalid')
    expect(await acode(() => p.tables.create({ displayName: 'Bad', columns: [{ displayName: 'Ref', type: 'lookup', lookupTable: 'Missing' }] }))).toBe('invalid')
  })

  it('removing a table cleans files, role privileges and solution membership', async () => {
    const { p, storage } = await boot()
    const orders = p.tables.get('Orders')!
    await p.tables.remove(orders.id)
    await p.tables.flush()
    expect(p.tables.get('Orders')).toBeUndefined()
    expect(code(() => p.tables.rows('Orders'))).toBe('not-found')
    expect(storage.files.has('tables/Orders.csv')).toBe(false)
    expect(storage.files.has('tables/Orders.schema.yaml')).toBe(false)
    expect(p.getState().roles.every((r) => r.privileges.every((x) => x.table !== orders.id))).toBe(true)
    expect(p.getState().solutions[0].components.some((c) => c.id === orders.id)).toBe(false)
    expect(p.getState().tables).toHaveLength(1)
  })
})

describe('CSV import and create from CSV', () => {
  it('creates a typed table from a CSV file', async () => {
    const { p } = await bootEmpty()
    const csv = 'Full Name,Age,Score,Joined,Active,Contact,Notes,id\r\nAda,36,9.5,2020-01-02,true,ada@x.org,"line1\nline2",1\r\nBob,41,7,2019-12-31,false,bob@x.org,,2\r\n'
    const t = await p.tables.createFromCsv('People list', csv)
    expect(t.name).toBe('PeopleList')
    const types = Object.fromEntries(t.columns.filter((c) => !c.system).map((c) => [c.displayName, c.type]))
    expect(types).toEqual({ 'Full Name': 'text', Age: 'number', Score: 'decimal', Joined: 'date', Active: 'boolean', Contact: 'email', Notes: 'multiline', id: 'number' })
    expect(t.primaryColumn).toBe('FullName')
    const rows = p.tables.rows('PeopleList')
    expect(rows).toHaveLength(2)
    expect(rows[0].FullName).toBe('Ada')
    expect(rows[0].Age).toBe(36)
    expect(rows[0].Notes).toBe('line1\nline2')
    expect(rows[1].Active).toBe(false)
    expect(rows[0].id).not.toBe('1') // a CSV column called id does not clash with the system id
    expect(await acode(() => p.tables.createFromCsv('Empty', ''))).toBe('invalid')
  })

  it('appends or replaces, ignores unknown columns, matches display names, and is atomic', async () => {
    const { p } = await boot()
    const n = await p.tables.importCsv('Contacts', 'Name,Company,Mystery\r\nZoe,Initech,ignored\r\nYan,Hooli,ignored', 'append')
    expect(n).toBe(2)
    expect(p.tables.rows('Contacts')).toHaveLength(10)
    expect(p.tables.rows('Contacts').at(-1)!.Active).toBe(true) // defaults apply
    const bad = 'Name,Email\r\nGood,good@x.org\r\nBad,not-an-email'
    await expect(p.tables.importCsv('Contacts', bad, 'append')).rejects.toThrow(/Row 3/)
    expect(p.tables.rows('Contacts')).toHaveLength(10) // atomic: the good row was not kept either
    expect(await p.tables.importCsv('Contacts', 'Name\r\nOnly', 'replace')).toBe(1)
    expect(p.tables.rows('Contacts')).toHaveLength(1)
    expect(await p.tables.importCsv('Orders', 'Order no,Customer\r\nORD-0100,' + 'x', 'append').catch((e: PlatformError) => e.code)).toBe('invalid') // lookup must exist
    expect(await p.tables.importCsv('Contacts', '', 'append')).toBe(0)
  })

  it('keeps ids and autonumbers when re-importing an export (lookups stay valid)', async () => {
    const { p } = await boot()
    const ids = p.tables.rows('Orders').map((r) => r.id)
    const csv = p.tables.exportCsv('Orders')
    await p.tables.importCsv('Orders', csv, 'replace')
    expect(p.tables.rows('Orders').map((r) => r.id)).toEqual(ids)
    expect(p.tables.rows('Orders')[3].OrderNo).toBe('ORD-0004')
    expect(p.tables.insert('Orders', { Customer: p.tables.rows('Contacts')[0].id }).OrderNo).toBe('ORD-0013')
    // appending an export again keeps rows distinct (ids that already exist get fresh ones)
    await p.tables.importCsv('Contacts', p.tables.exportCsv('Contacts'), 'append')
    expect(new Set(p.tables.rows('Contacts').map((r) => r.id)).size).toBe(16)
  })
})

describe('apps', () => {
  it('creates blank and sample apps, validates size and keeps names unique', async () => {
    const { p } = await boot()
    const a = await p.apps.create({ name: 'Blank', width: 1920, height: 1080 })
    const def = (await p.apps.load(a.id))!
    expect(def.formatVersion).toBe(2)
    expect(def.name).toBe('Blank')
    expect(def.screens).toHaveLength(1)
    expect(def.screens[0].type).toBe('Screen')
    expect(def.scaleMode).toBe('responsive')
    expect((await p.apps.create({ name: 'Portrait', width: 1080, height: 1920 })).height).toBe(1920) // portrait is allowed
    expect(await acode(() => p.apps.create({ name: 'Huge', width: 20000, height: 1920 }))).toBe('invalid')
    expect(await acode(() => p.apps.create({ name: '', width: 1920, height: 1080 }))).toBe('invalid')
    const dup = await p.apps.create({ name: 'Blank', width: 2560, height: 1440 })
    expect(dup.name).toBe('Blank (2)')
    const sample = await p.apps.create({ name: 'Sample', width: 1920, height: 1080, template: 'sample' })
    const sdef = (await p.apps.load(sample.id))!
    expect(sdef.screens.map((s) => s.name)).toEqual(['Home'])
    expect(sdef.dataSources).toEqual(['Contacts', 'Orders'])
    expect(sdef.width).toBe(1920)
    expect(p.getState().apps).toHaveLength(5)
  })

  it('the sample template recreates the Contacts table when it is gone', async () => {
    const { p } = await boot()
    await p.tables.remove(p.tables.get('Contacts')!.id)
    await p.apps.create({ name: 'Again', width: 1920, height: 1080, template: 'sample' })
    expect(p.tables.get('Contacts')).toBeDefined()
    expect(p.tables.rows('Contacts')).toHaveLength(8)
  })

  it('load returns a copy; save persists and updates metadata; unknown ids fail cleanly', async () => {
    const { p, storage } = await boot()
    const meta = p.getState().apps[0]
    const def = (await p.apps.load(meta.id))!
    def.screens[0].name = 'Mutated'
    expect((await p.apps.load(meta.id))!.screens[0].name).toBe('Home') // callers cannot corrupt the cache
    expect(await p.apps.load('nope')).toBeNull()
    const later = new Date('2026-04-01T00:00:00Z')
    const p2 = createPlatform(storage, { now: () => later })
    await p2.init()
    const d2 = (await p2.apps.load(meta.id))!
    d2.width = 2560
    d2.height = 1440
    await p2.apps.save(meta.id, d2)
    const m2 = p2.getState().apps[0]
    expect(m2.modifiedOn).toBe(later.toISOString())
    expect(m2.width).toBe(2560)
    expect(storage.files.get(`apps/${meta.id}.app.yaml`)).toContain('width: 2560')
    expect(await acode(() => p2.apps.save('nope', d2))).toBe('not-found')
    expect(await acode(() => p2.apps.save(meta.id, { screens: 'x' } as never))).toBe('invalid')
  })

  it('renames, duplicates and removes apps (and detaches them from roles and solutions)', async () => {
    const { p, storage } = await boot()
    const meta = p.getState().apps[0]
    await p.apps.rename(meta.id, 'Renamed')
    expect(p.getState().apps[0].name).toBe('Renamed')
    expect((await p.apps.load(meta.id))!.name).toBe('Renamed')
    const copy = await p.apps.duplicate(meta.id)
    expect(copy.name).toBe('Renamed (copy)')
    expect(copy.id).not.toBe(meta.id)
    const copy2 = await p.apps.duplicate(meta.id)
    expect(copy2.name).toBe('Renamed (copy) (2)')
    expect(await acode(() => p.apps.rename(copy.id, 'renamed'))).toBe('conflict')
    expect(await acode(() => p.apps.rename(copy.id, ' '))).toBe('invalid')
    const role = await p.security.createRole({ name: 'Scoped' })
    await p.security.updateRole(role.id, { apps: [copy.id] })
    await p.solutions.addComponent(p.getState().solutions[0].id, 'app', copy.id)
    await p.apps.remove(copy.id)
    expect(p.getState().apps.some((a) => a.id === copy.id)).toBe(false)
    expect(storage.files.has(`apps/${copy.id}.app.yaml`)).toBe(false)
    expect(p.getState().roles.find((r) => r.id === role.id)!.apps).toEqual([])
    expect(p.getState().solutions[0].components.some((c) => c.id === copy.id)).toBe(false)
    expect(await acode(() => p.apps.remove(copy.id))).toBe('not-found')
  })
})

describe('app packages', () => {
  it('exports a YAML package with the app and the tables it uses', async () => {
    const { p } = await boot()
    const id = p.getState().apps[0].id
    const doc = yaml.load(await p.apps.exportPackage(id)) as Record<string, unknown>
    expect(Object.keys(doc)).toEqual(['kind', 'packageVersion', 'exportedOn', 'app', 'tables'])
    expect(doc.kind).toBe('appbuilder/app')
    expect(doc.packageVersion).toBe(1)
    const app = doc.app as Record<string, unknown>
    expect(Object.keys(app)).toEqual(['id', 'name', 'description', 'definition'])
    const tables = doc.tables as { schema: { name: string }; csv?: string }[]
    expect(tables.map((t) => t.schema.name)).toEqual(['Contacts', 'Orders'])
    expect(tables[0].csv).toBeUndefined()
    const withData = yaml.load(await p.apps.exportPackage(id, { includeData: true })) as { tables: { csv: string }[] }
    expect(withData.tables[0].csv.split('\n')[0]).toContain('Name')
    expect(withData.tables[0].csv.split('\n')).toHaveLength(9)
  })

  it('finds tables referenced only inside formulas, plus their lookup targets', async () => {
    const { p } = await boot()
    const a = await p.apps.create({ name: 'Uses orders', width: 1920, height: 1080 })
    const def = (await p.apps.load(a.id))!
    def.screens[0].props.OnVisible = '=ClearCollect(Mine, Filter(Orders, Status = "New")) & "Contacts is in a string"'
    await p.apps.save(a.id, def)
    const doc = yaml.load(await p.apps.exportPackage(a.id)) as { tables: { schema: { name: string } }[] }
    expect(doc.tables.map((t) => t.schema.name).sort()).toEqual(['Contacts', 'Orders']) // Contacts via the Customer lookup
  })

  it('import creates a NEW app instance with a unique name and reuses existing tables', async () => {
    const { p } = await boot()
    const orig = p.getState().apps[0]
    const text = await p.apps.exportPackage(orig.id)
    const imp = await p.apps.importPackage(text)
    expect(imp.id).not.toBe(orig.id)
    expect(imp.name).toBe('Contacts app (2)')
    const imp2 = await p.apps.importPackage(text)
    expect(imp2.name).toBe('Contacts app (3)')
    expect(p.getState().apps).toHaveLength(3)
    expect(p.getState().tables).toHaveLength(2) // Contacts was reused, not duplicated
    expect(p.tables.rows('Contacts')).toHaveLength(8)
    const def = (await p.apps.load(imp.id))!
    expect(def.name).toBe('Contacts app (2)')
    expect(def.screens.map((s) => s.name)).toEqual(['Home'])
    expect((await p.apps.load(orig.id))!.name).toBe('Contacts app') // the original is untouched
  })

  it('import recreates missing tables and brings data when it was exported', async () => {
    const { p } = await boot()
    const text = await p.apps.exportPackage(p.getState().apps[0].id, { includeData: true })
    const ids = p.tables.rows('Contacts').map((r) => r.id)
    await p.tables.remove(p.tables.get('Contacts')!.id)
    await p.apps.importPackage(text)
    expect(p.tables.get('Contacts')).toBeDefined()
    expect(p.tables.rows('Contacts')).toHaveLength(8)
    expect(p.tables.rows('Contacts').map((r) => r.id)).toEqual(ids)
    expect(p.getState().roles.find((r) => r.name === 'Maker')!.privileges.some((x) => x.table === p.tables.get('Contacts')!.id)).toBe(true)
  })

  it('phone and tablet (portrait) sizes are accepted and round-trip through the YAML package', async () => {
    const { p } = await boot()
    for (const [w, h] of [[360, 800], [390, 844], [412, 915], [800, 1280], [1280, 800]]) {
      const a = await p.apps.create({ name: `Size ${w}`, width: w, height: h })
      expect(a).toMatchObject({ width: w, height: h })
      const text = await p.apps.exportPackage(a.id)
      expect((yaml.load(text) as { app: { definition: { width: number; height: number } } }).app.definition).toMatchObject({ width: w, height: h })
      const imp = await p.apps.importPackage(text)
      expect(imp).toMatchObject({ width: w, height: h })
      expect(await p.apps.load(imp.id)).toMatchObject({ width: w, height: h })
    }
    expect(await acode(() => p.apps.create({ name: 'Too small', width: 100, height: 800 }))).toBe('invalid')
  })

  it('rejects bad packages with PlatformError invalid', async () => {
    const { p } = await boot()
    expect(await acode(() => p.apps.importPackage(''))).toBe('invalid')
    expect(await acode(() => p.apps.importPackage('{{{'))).toBe('invalid')
    expect(await acode(() => p.apps.importPackage('hello: world'))).toBe('invalid')
    expect(await acode(() => p.apps.importPackage('kind: appbuilder/solution\npackageVersion: 1'))).toBe('invalid')
    expect(await acode(() => p.apps.importPackage('kind: appbuilder/app\npackageVersion: 99\napp: {}'))).toBe('invalid')
    expect(await acode(() => p.apps.importPackage('kind: appbuilder/app\npackageVersion: 1\napp: { name: x, definition: { screens: 5 } }'))).toBe('invalid')
    expect(p.getState().apps).toHaveLength(1)
  })
})

describe('connections', () => {
  it('only local-csv is functional; others are saved as not-configured', async () => {
    const { p } = await boot()
    const local = await p.connections.create({ name: 'Second CSV', connector: 'local-csv', settings: { folder: 'x' } })
    expect(local.status).toBe('connected')
    const pg = await p.connections.create({ name: 'Warehouse', connector: 'postgres' })
    expect(pg.status).toBe('not-configured')
    await p.connections.update(pg.id, { status: 'connected', settings: { host: 'h' } })
    const now = p.getState().connections.find((c) => c.id === pg.id)!
    expect(now.status).toBe('not-configured')
    expect(now.settings).toEqual({ host: 'h' })
    expect(await acode(() => p.connections.create({ name: 'warehouse', connector: 'rest' }))).toBe('conflict')
    expect(await acode(() => p.connections.create({ name: 'Bad', connector: 'carrier-pigeon' as never }))).toBe('invalid')
    await p.connections.remove(pg.id)
    expect(p.getState().connections.some((c) => c.id === pg.id)).toBe(false)
    expect(await acode(() => p.connections.remove('ghost'))).toBe('not-found')
  })
})

describe('solutions', () => {
  it('creates, edits and manages components', async () => {
    const { p } = await boot()
    const s = await p.solutions.create({ displayName: 'CRM kit', description: 'd' })
    expect(s).toMatchObject({ name: 'CRMKit', publisher: 'Admin', version: '1.0.0', components: [] })
    const s2 = await p.solutions.create({ displayName: 'CRM kit' })
    expect(s2.name).toBe('CRMKit_2')
    await p.solutions.update(s.id, { displayName: 'CRM Kit v2', version: '2.0.0', publisher: 'Me' })
    expect(p.getState().solutions.find((x) => x.id === s.id)).toMatchObject({ displayName: 'CRM Kit v2', version: '2.0.0', publisher: 'Me' })
    expect(await acode(() => p.solutions.update(s2.id, { name: 'CRMKit' }))).toBe('conflict')
    const tableId = p.tables.get('Contacts')!.id
    await p.solutions.addComponent(s.id, 'table', tableId)
    await p.solutions.addComponent(s.id, 'table', tableId) // idempotent
    expect(p.getState().solutions.find((x) => x.id === s.id)!.components).toEqual([{ kind: 'table', id: tableId }])
    expect(await acode(() => p.solutions.addComponent(s.id, 'app', 'ghost'))).toBe('not-found')
    await p.solutions.removeComponent(s.id, 'table', tableId)
    expect(p.getState().solutions.find((x) => x.id === s.id)!.components).toEqual([])
    await p.solutions.remove(s2.id)
    expect(p.getState().solutions).toHaveLength(2)
    expect(await acode(() => p.solutions.remove(s2.id))).toBe('not-found')
  })

  it('exports every component and the YAML shape is as documented', async () => {
    const { p } = await boot()
    const sol = p.getState().solutions[0]
    const doc = yaml.load(await p.solutions.exportPackage(sol.id, { includeData: true })) as Record<string, unknown>
    expect(Object.keys(doc)).toEqual(['kind', 'packageVersion', 'exportedOn', 'solution', 'apps', 'tables', 'roles', 'connections'])
    expect(doc.kind).toBe('appbuilder/solution')
    expect(Object.keys(doc.solution as object)).toEqual(['name', 'displayName', 'publisher', 'version', 'description'])
    expect((doc.apps as unknown[]).length).toBe(1)
    expect((doc.tables as unknown[]).length).toBe(2)
    expect((doc.roles as unknown[]).length).toBe(3)
    expect((doc.connections as unknown[]).length).toBe(1)
    expect((doc.tables as { csv: string }[]).every((t) => typeof t.csv === 'string')).toBe(true)
  })

  it('import creates new instances of apps, roles and connections and a new solution', async () => {
    const { p } = await boot()
    const sol = p.getState().solutions[0]
    const text = await p.solutions.exportPackage(sol.id)
    const imp = await p.solutions.importPackage(text)
    expect(imp.id).not.toBe(sol.id)
    expect(imp.name).toBe('Default_2')
    expect(imp.displayName).toBe('Default (2)')
    const s = p.getState()
    expect(s.solutions).toHaveLength(2)
    expect(s.apps).toHaveLength(2)
    expect(s.apps.map((a) => a.name).sort()).toEqual(['Contacts app', 'Contacts app (2)'])
    expect(s.roles.map((r) => r.name).sort()).toEqual(['Administrator', 'Administrator (2)', 'Maker', 'Maker (2)', 'Viewer', 'Viewer (2)'])
    expect(s.connections.map((c) => c.name).sort()).toEqual(['Local CSV', 'Local CSV (2)'])
    expect(s.tables).toHaveLength(2) // reused by name
    const kinds = (k: string) => imp.components.filter((c) => c.kind === k).map((c) => c.id)
    expect(kinds('app')).toHaveLength(1)
    expect(kinds('app')[0]).not.toBe(s.apps.find((a) => a.name === 'Contacts app')!.id)
    expect(kinds('role')).toHaveLength(3)
    expect(kinds('table').sort()).toEqual(s.tables.map((t) => t.id).sort())
    // imported roles point at the (reused) tables and keep working
    const maker2 = s.roles.find((r) => r.name === 'Maker (2)')!
    expect(maker2.privileges.map((x) => x.table).sort()).toEqual(s.tables.map((t) => t.id).sort())
    expect(s.roles.find((r) => r.name === 'Administrator (2)')!.isAdmin).toBe(true)
    // original is untouched
    expect(s.solutions[0].components).toEqual(sol.components)
  })

  it('moves a whole solution with data into an empty workspace', async () => {
    const { p } = await boot()
    const text = await p.solutions.exportPackage(p.getState().solutions[0].id, { includeData: true })
    const { p: q } = await bootEmpty()
    const imp = await q.solutions.importPackage(text)
    const qs = q.getState()
    expect(qs.tables.map((t) => t.name).sort()).toEqual(['Contacts', 'Orders'])
    expect(q.tables.rows('Contacts')).toHaveLength(8)
    expect(q.tables.rows('Orders')).toHaveLength(12)
    const ids = new Set(q.tables.rows('Contacts').map((r) => r.id))
    expect(q.tables.rows('Orders').every((o) => ids.has(o.Customer as string))).toBe(true)
    expect(q.tables.rows('Orders')[0].OrderNo).toBe('ORD-0001')
    expect(q.tables.insert('Orders', { Customer: [...ids][0] }).OrderNo).toBe('ORD-0013')
    expect(imp.components).toHaveLength(1 + 2 + 3 + 1)
    expect(qs.apps).toHaveLength(1)
    expect((await q.apps.load(qs.apps[0].id))!.dataSources).toEqual(['Contacts', 'Orders'])
  })

  it('rejects malformed solution packages before changing anything', async () => {
    const { p } = await boot()
    expect(await acode(() => p.solutions.importPackage('kind: appbuilder/app\npackageVersion: 1'))).toBe('invalid')
    expect(await acode(() => p.solutions.importPackage('kind: appbuilder/solution\npackageVersion: 1'))).toBe('invalid')
    const bad = 'kind: appbuilder/solution\npackageVersion: 1\nsolution: { displayName: X }\napps: [ { name: A, definition: { screens: 1 } } ]'
    expect(await acode(() => p.solutions.importPackage(bad))).toBe('invalid')
    expect(p.getState().solutions).toHaveLength(1)
    expect(p.getState().apps).toHaveLength(1)
  })

  it('removing roles, connections and tables detaches them from solutions', async () => {
    const { p } = await boot()
    const sol = p.getState().solutions[0]
    const viewer = p.getState().roles.find((r) => r.name === 'Viewer')!
    await p.security.removeRole(viewer.id)
    await p.connections.remove(p.getState().connections[0].id)
    const now = p.getState().solutions[0]
    expect(now.components).toHaveLength(sol.components.length - 2)
    expect(now.components.some((c) => c.id === viewer.id)).toBe(false)
  })
})
