import { describe, expect, it } from 'vitest'
import { resolveColumns } from './data'
import type { TableDef } from '@/platform/contracts'

const table = {
  id: 't', name: 'T', displayName: 'T', primaryColumn: 'Name', createdOn: '', modifiedOn: '',
  columns: [
    { name: 'id', displayName: 'Id', type: 'text', system: true },
    { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true },
    { name: 'Name', displayName: 'Name', type: 'text' },
  ],
} as unknown as TableDef
const items = [{ id: 'a', createdOn: '2026-01-01T00:00:00Z', Name: 'x' }]

describe('DataTable column resolution', () => {
  it('empty Columns shows only non-system columns of a platform table', () => {
    expect(resolveColumns(items, '', table).map((c) => c.field)).toEqual(['Name'])
  })
  it('an explicit Columns list may still name system columns', () => {
    expect(resolveColumns(items, 'createdOn', table).map((c) => c.field)).toEqual(['createdOn'])
  })
  it('items that are not a platform table are unchanged', () => {
    expect(resolveColumns([{ a: 1, b: 2 }], '').map((c) => c.field)).toEqual(['a', 'b'])
  })
})
