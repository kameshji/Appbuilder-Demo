/** Table shapes for the auto app tests (every column type, relationships, awkward names). Test data only. */
import type { ColumnDef, TableDef } from '../platform/contracts.ts'

const SYSTEM: ColumnDef[] = [
  { name: 'id', displayName: 'Id', type: 'text', system: true },
  { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true },
  { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime', system: true },
  { name: 'createdBy', displayName: 'Created by', type: 'lookup', lookupTable: 'Users', system: true },
  { name: 'owner', displayName: 'Owner', type: 'lookup', lookupTable: 'Users', system: true },
]

export function table(name: string, columns: Partial<ColumnDef>[], extra: Partial<TableDef> = {}): TableDef {
  const cols = columns.map((c) => ({ displayName: c.name!, type: 'text', ...c }) as ColumnDef)
  return {
    id: `t_${name}`,
    name,
    displayName: extra.displayName ?? name.replace(/([a-z])([A-Z])/g, '$1 $2'),
    primaryColumn: extra.primaryColumn ?? cols[0]?.name ?? 'id',
    columns: [...SYSTEM, ...cols],
    createdOn: '2026-11-20T00:00:00.000Z',
    modifiedOn: '2026-11-20T00:00:00.000Z',
    ...extra,
  }
}

export const users = table('Users', [{ name: 'FullName', type: 'text' }, { name: 'Email', type: 'email' }], { system: true, systemKind: 'projection', readOnly: true })

/** every column type */
export const customers = table('Customers', [
  { name: 'Name', type: 'text', required: true },
  { name: 'Code', type: 'autonumber', prefix: 'C-' },
  { name: 'Email', type: 'email' },
  { name: 'Phone', type: 'phone' },
  { name: 'Website', type: 'url' },
  { name: 'Notes', type: 'multiline' },
  { name: 'Employees', type: 'number' },
  { name: 'Rating', type: 'decimal' },
  { name: 'Credit', type: 'currency', required: true },
  { name: 'Active', type: 'boolean' },
  { name: 'Since', type: 'date' },
  { name: 'LastVisit', displayName: 'Last visit', type: 'datetime' },
  { name: 'Tier', type: 'choice', choices: ['Gold', 'Silver'] },
  { name: 'Logo', type: 'image' },
  { name: 'Contract', type: 'file' },
  { name: 'AccountManager', displayName: 'Account manager', type: 'lookup', lookupTable: 'Users' },
  { name: 'Score', type: 'number', computed: { kind: 'formula', formula: 'Employees * 2' } as never },
], { recycleDays: 30 })

export const orders = table('Orders', [
  { name: 'OrderNo', displayName: 'Order no', type: 'text', required: true },
  { name: 'Customer', type: 'lookup', lookupTable: 'Customers', required: true },
  { name: 'BillTo', displayName: 'Bill to', type: 'lookup', lookupTable: 'Customers' },
  { name: 'Status', type: 'choice', choices: ['Open', 'Done'] },
  { name: 'Amount', type: 'currency' },
  { name: 'Due', type: 'date' },
])

/** a lookup to itself */
export const staff = table('Staff', [
  { name: 'Name', type: 'text', required: true },
  { name: 'Manager', type: 'lookup', lookupTable: 'Staff' },
])

/** no text column */
export const readings = table('Readings', [
  { name: 'Value', type: 'decimal', required: true },
  { name: 'TakenOn', displayName: 'Taken on', type: 'datetime' },
  { name: 'Ok', type: 'boolean' },
], { primaryColumn: 'Value' })

/** names that need quoting in formulas, and a table named like a keyword */
export const quoted = table('In', [
  { name: 'And', displayName: 'And, or: "quotes"', type: 'text' },
  { name: 'true', displayName: 'True', type: 'boolean' },
  { name: 'Not', type: 'number' },
  { name: 'As', type: 'lookup', lookupTable: 'In' },
  { name: 'Parent', type: 'text' },
  { name: 'Self', type: 'choice', choices: ['a'] },
])

/** long names */
export const longName = table('AVeryLongTableNameThatGoesOnAndOnForeverAndEverMoreStill', [
  { name: 'ThisIsAnExtremelyLongColumnNameThatShouldStillWorkInFormulas', displayName: 'A very long column display name that keeps going and going', type: 'text' },
  { name: 'Parent', type: 'lookup', lookupTable: 'Customers' },
], { displayName: 'A very long table display name that goes on and on forever and ever more still' })

/** 60 columns, all kinds */
export const wide60 = table('Wide', Array.from({ length: 60 }, (_, i) => {
  const kinds = ['text', 'number', 'date', 'boolean', 'choice', 'email', 'currency', 'multiline', 'datetime', 'decimal'] as const
  const type = kinds[i % kinds.length]
  return { name: `C${i + 1}`, displayName: `Column ${i + 1}`, type, required: i % 7 === 0, ...(type === 'choice' ? { choices: ['x', 'y'] } : {}) }
}))

/** a built-in enum name: cannot be used by formulas */
export const colorTable = table('Color', [{ name: 'Name', type: 'text' }])

export const all: TableDef[] = [users, customers, orders, staff, readings, quoted, longName, wide60, colorTable]
