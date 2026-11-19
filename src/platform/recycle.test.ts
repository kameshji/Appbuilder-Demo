/**
 * Demo mode recycle bin (docs/dev/recycle-bin.md): the browser store keeps deleted rows of tables with recycleDays in
 * memory as one batch per delete (cascade and set blank included), lists them, restores a batch or one row (with the rows
 * its delete took along), refuses a restore whose unique value is used again, and purges for administrators.
 */
import { describe, expect, it } from 'vitest'
import { createPlatform } from './core'
import { MemoryStorage } from './storage'
import type { DeletedEvent } from './recycle-api'
import type { RelationshipRecord } from './delete-rules'

async function boot() {
  let rels: RelationshipRecord[] = []
  const p = createPlatform(new MemoryStorage('browser', 'test'), { now: () => new Date('2026-03-15T10:30:00.000Z'), relationships: () => rels })
  await p.init()
  const cust = await p.tables.create({ displayName: 'Customer', columns: [{ displayName: 'Name', type: 'text' }, { displayName: 'Code', type: 'text', unique: true }] })
  const order = await p.tables.create({ displayName: 'Order', columns: [{ displayName: 'Ref', type: 'text' }, { displayName: 'Customer', type: 'lookup', lookupTable: 'Customer', required: true }] })
  const note = await p.tables.create({ displayName: 'Note', columns: [{ displayName: 'Text', type: 'text' }, { displayName: 'Customer', type: 'lookup', lookupTable: 'Customer' }] })
  rels = [{ id: 'r1', fromTable: order.id, fromColumn: 'Customer', toTable: cust.id, onDelete: 'cascade' } as RelationshipRecord]
  const c = p.tables.insert('Customer', { Name: 'Acme', Code: 'A1' })
  const o1 = p.tables.insert('Order', { Ref: 'O-1', Customer: c.id })
  const o2 = p.tables.insert('Order', { Ref: 'O-2', Customer: c.id })
  const n = p.tables.insert('Note', { Text: 'call', Customer: c.id })
  return { p, cust, order, note, c, o1, o2, n }
}

describe('demo mode: recycle bin', () => {
  it('new tables keep deleted rows for 30 days; a delete is one batch with the cascade and the set-blank value; Undo restores it', async () => {
    const { p, cust, c, n } = await boot()
    expect(cust.recycleDays).toBe(30)
    const events: DeletedEvent[] = []
    p.recycle!.onDeleted((e) => events.push(e))
    p.tables.delete('Customer', [String(c.id)])
    expect(p.tables.rows('Customer')).toHaveLength(0)
    expect(p.tables.rows('Order')).toHaveLength(0)
    expect(p.tables.rows('Note')[0]!.Customer ?? null).toBeNull()
    expect(events).toHaveLength(1)
    expect(events[0]!.batch).toMatchObject({ rows: 3, rootIds: [String(c.id)], daysLeft: 30 })
    const list = await p.recycle!.list('Order')
    expect(list.rows.map((r) => r.__deleted.cascaded)).toEqual([true, true])
    const r = await p.recycle!.restore('Customer', { batch: events[0]!.batch.id })
    expect(r).toMatchObject({ restored: 3, warnings: [] })
    expect(p.tables.rows('Order')).toHaveLength(2)
    expect(p.tables.rows('Note').find((x) => x.id === n.id)!.Customer).toBe(c.id)
    expect((await p.recycle!.list('Customer')).rows).toHaveLength(0)
  })

  it('one row back brings what its delete took along; a unique value used again blocks the restore', async () => {
    const { p, c } = await boot()
    const c2 = p.tables.insert('Customer', { Name: 'Beta', Code: 'B1' })
    p.tables.insert('Order', { Ref: 'O-3', Customer: c2.id })
    let batch = ''
    p.recycle!.onDeleted((e) => { batch = e.batch.id })
    p.tables.delete('Customer', [String(c.id), String(c2.id)])
    expect(p.tables.rows('Order')).toHaveLength(0)
    const one = await p.recycle!.restore('Customer', { rowId: String(c2.id) })
    expect(one.restored).toBe(2)
    expect(p.tables.rows('Order').map((o) => o.Ref)).toEqual(['O-3'])
    // an order alone cannot come back while its customer waits in the batch
    const o1 = (await p.recycle!.list('Order')).rows[0]!
    await expect(p.recycle!.restore('Order', { rowId: o1.id })).rejects.toThrow(/Restore the whole batch/)
    p.tables.insert('Customer', { Name: 'Again', Code: 'a1' })
    await expect(p.recycle!.restore('Customer', { batch })).rejects.toThrow(/Code "A1" is used by "Again"/)
  })

  it('setting off: deletes are final; administrators purge; the setting is validated', async () => {
    const { p, cust, c } = await boot()
    await p.tables.update(cust.id, { recycleDays: 0 })
    p.tables.delete('Customer', [String(c.id)])
    expect((await p.recycle!.list('Customer')).rows).toHaveLength(0)
    await expect(p.tables.update(cust.id, { recycleDays: 99999 })).rejects.toThrow(/between 0 \(off\) and 3650/)
    await p.tables.update(cust.id, { recycleDays: 7 })
    const x = p.tables.insert('Customer', { Name: 'X', Code: 'X1' })
    p.tables.delete('Customer', [String(x.id)])
    expect((await p.recycle!.stats('Customer'))).toMatchObject({ enabled: true, keepDays: 7, deletedRows: 1 })
    await expect(p.recycle!.purge('Customer', { all: true, confirm: 'nope' })).rejects.toThrow(/Type the table name/)
    expect(await p.recycle!.purge('Customer', { all: true, confirm: 'Customer' })).toEqual({ rows: 1, batches: 1 })
    expect((await p.recycle!.stats('Customer')).deletedRows).toBe(0)
  })
})
