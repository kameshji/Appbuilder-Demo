/**
 * Demo mode: relationship delete behaviours in the browser store (P0 package M) — restrict, cascade, set blank, the
 * defaults of lookups without a record, all-or-nothing refusals and cascades that need delete permission.
 */
import { describe, expect, it } from 'vitest'
import { createPlatform } from './core'
import { MemoryStorage } from './storage'
import type { PlatformError } from './contracts'
import type { RelationshipRecord } from './delete-rules'

async function boot(records: () => RelationshipRecord[]) {
  const p = createPlatform(new MemoryStorage('browser', 'test'), { now: () => new Date('2026-03-15T10:30:00.000Z'), relationships: () => records() })
  await p.init()
  const customer = await p.tables.create({ displayName: 'Customer', columns: [{ displayName: 'Name', type: 'text' }] })
  const order = await p.tables.create({ displayName: 'Order', columns: [{ displayName: 'Ref', type: 'text' }, { displayName: 'Customer', type: 'lookup', lookupTable: 'Customer' }] })
  const line = await p.tables.create({ displayName: 'Line', columns: [{ displayName: 'Item', type: 'text' }, { displayName: 'Order', type: 'lookup', lookupTable: 'Order', required: true }] })
  const c = p.tables.insert('Customer', { Name: 'Acme' })
  const o = p.tables.insert('Order', { Ref: 'O-1', Customer: c.id })
  const l = p.tables.insert('Line', { Item: 'bolt', Order: o.id })
  return { p, customer, order, line, c, o, l }
}
const err = (fn: () => unknown): PlatformError | undefined => {
  try { fn() } catch (e) { return e as PlatformError }
  return undefined
}

describe('demo mode: relationship delete behaviours', () => {
  it('defaults: a required lookup restricts, an optional one is set blank', async () => {
    const { p, c, o } = await boot(() => [])
    // Line.Order is required: deleting the order is refused, nothing changes
    const e = err(() => p.tables.delete('Order', [String(o.id)]))
    expect(e?.code).toBe('conflict')
    expect(e?.message).toMatch(/1 row in "Line" still refers to it/)
    expect(p.tables.rows('Order').length).toBe(1)
    // Order.Customer is optional: deleting the customer clears the lookup
    p.tables.delete('Customer', [String(c.id)])
    expect(p.tables.rows('Customer').length).toBe(0)
    expect(p.tables.rows('Order')[0]!.Customer ?? null).toBeNull()
  })

  it('cascade: the lines go with their order; restrict on the customer refuses the whole delete', async () => {
    let recs: RelationshipRecord[] = []
    const { p, customer, order, line, c, o } = await boot(() => recs)
    recs = [
      { fromTable: line.id, fromColumn: 'Order', toTable: order.id, onDelete: 'cascade' },
      { fromTable: order.id, fromColumn: 'Customer', toTable: customer.id, onDelete: 'restrict' },
    ]
    expect(err(() => p.tables.delete('Customer', [String(c.id)]))?.code).toBe('conflict')
    expect(p.tables.rows('Line').length).toBe(1)
    p.tables.delete('Order', [String(o.id)])
    expect(p.tables.rows('Order').length).toBe(0)
    expect(p.tables.rows('Line').length).toBe(0)
    p.tables.delete('Customer', [String(c.id)])
    expect(p.tables.rows('Customer').length).toBe(0)
  })

  it('a cascade the user may not complete deletes nothing', async () => {
    let recs: RelationshipRecord[] = []
    const { p, order, line, o } = await boot(() => recs)
    recs = [{ fromTable: line.id, fromColumn: 'Order', toTable: order.id, onDelete: 'cascade' }]
    const role = await p.security.createRole({ name: 'Orders only' })
    await p.security.updateRole(role.id, { apps: 'all', privileges: [
      { table: order.id, create: true, read: 'all', update: 'all', delete: 'all' },
      { table: line.id, create: true, read: 'all', update: 'all', delete: 'none' },
    ] })
    const user = await p.security.createUser({ name: 'Olly', email: 'olly@example.com', roleIds: [role.id] })
    p.security.setCurrentUser(user.id)
    const e = err(() => p.tables.delete('Order', [String(o.id)]))
    expect(e?.code).toBe('denied')
    expect(e?.message).toMatch(/Nothing was deleted/)
    expect(p.tables.rows('Order', { secure: false }).length).toBe(1)
    expect(p.tables.rows('Line', { secure: false }).length).toBe(1)
  })
})
