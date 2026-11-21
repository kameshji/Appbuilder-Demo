import { describe, expect, it } from 'vitest'
import type { ColumnDef, TableDef } from '@/platform/contracts'
import { startingExtras, visibleColumns } from './formSchema'

const col = (name: string, type: ColumnDef['type'], more: Partial<ColumnDef> = {}): ColumnDef => ({ name, displayName: name, type, ...more })
const table: TableDef = {
  id: 't1', name: 'Lines', displayName: 'Lines', primaryColumn: 'Item',
  columns: [
    col('id', 'text', { system: true }), col('Item', 'text'), col('Qty', 'number'), col('Order', 'lookup', { lookupTable: 'Orders' }),
    col('Note', 'text'), col('Done', 'boolean'), col('Amount', 'decimal', { computed: { kind: 'formula', formula: 'Qty * 2' } }),
    col('No', 'autonumber'), col('Photo', 'image'), col('Secret', 'text'),
  ],
} as unknown as TableDef
const access = (c: ColumnDef) => (c.name === 'Secret' ? 'read' : 'update')

describe('a New form with a starting Item saves the Item values of columns not in Fields', () => {
  const shown = visibleColumns(table, 'Item, Qty', 'New')

  it('includes writable columns that are not shown, typed, and never the shown ones', () => {
    const out = startingExtras(table, shown, 'New', { Order: 'o-1', Note: 'from the gallery', Done: true, Qty: 9, Item: 'x' }, access)
    expect(out).toEqual({ Order: 'o-1', Note: 'from the gallery', Done: true })
  })

  it('takes the id of a lookup given as a record; matches names case-insensitively', () => {
    expect(startingExtras(table, shown, 'New', { order: { __id: 'o-2', Name: 'SO-2' } }, access)).toEqual({ Order: 'o-2' })
  })

  it('leaves out system, calculated, auto-number, file and read-only columns and blank values', () => {
    const out = startingExtras(table, shown, 'New', { id: undefined, Amount: 5, No: 3, Photo: 'att', Secret: 's', Note: '' } as never, access)
    expect(out).toEqual({})
  })

  it('does nothing in Edit mode or when the Item is a row (it has an id)', () => {
    expect(startingExtras(table, shown, 'Edit', { Note: 'n' }, access)).toEqual({})
    expect(startingExtras(table, shown, 'New', { __id: 'r1', Note: 'n' }, access)).toEqual({})
    expect(startingExtras(table, shown, 'New', null, access)).toEqual({})
  })
})
