import { describe, expect, it } from 'vitest'
import type { TableDef } from '@/platform/contracts'
import { buildPlan } from './Reports'
import { formToInputs } from './ConnectionActions'

const t = { id: 't1', name: 'Orders', displayName: 'Orders', primaryColumn: 'Customer', createdOn: '', modifiedOn: '', columns: [
  { name: 'Customer', displayName: 'Customer', type: 'text' }, { name: 'Amount', displayName: 'Amount', type: 'number' },
  { name: 'Due', displayName: 'Due', type: 'date' }, { name: 'Paid', displayName: 'Paid', type: 'boolean' },
] } as TableDef

describe('report builder -> Query v2 plan', () => {
  it('rows: typed filters, sort, columns', () => {
    expect(buildPlan(t, { columns: ['Customer', 'Amount'], filters: [{ col: 'Amount', op: 'gt', value: '100' }, { col: 'Due', op: 'lt', value: '2026-12-01' }, { col: 'Paid', op: 'eq', value: 'false' }, { col: 'Customer', op: 'isNull', value: '' }], sort: { col: 'Amount', dir: 'desc' }, groupBy: '', measures: [] })).toEqual({
      version: 2, table: 'Orders', select: ['Customer', 'Amount'], sort: [{ col: 'Amount', dir: 'desc' }],
      filter: { and: [{ col: 'Amount', op: 'gt', value: 100 }, { col: 'Due', op: 'lt', value: { $date: '2026-12-01' } }, { col: 'Paid', op: 'eq', value: false }, { col: 'Customer', op: 'isNull' }] },
    })
  })
  it('group and totals', () => {
    expect(buildPlan(t, { columns: [], filters: [], sort: null, groupBy: 'Customer', measures: [{ fn: 'sum', col: 'Amount' }, { fn: 'count', col: '' }] })).toEqual({
      version: 2, table: 'Orders', aggregate: { groupBy: ['Customer'], measures: [{ name: 'Sum Amount', fn: 'sum', col: 'Amount' }, { name: 'Count', fn: 'count' }] },
    })
  })
})

describe('Test action form -> inputs', () => {
  const schema = { type: 'object', properties: { n: { type: 'integer' }, ok: { type: 'boolean' }, s: { type: 'string' }, o: { type: 'object' }, to: { anyOf: [{ type: 'string' }, { type: 'array' }] } } }
  it('types values and skips blanks', () => {
    expect(formToInputs(schema, { n: '3', ok: 'true', s: 'x', o: '{"a":1}', to: 'a@b.c' })).toEqual({ inputs: { n: 3, ok: true, s: 'x', o: { a: 1 }, to: 'a@b.c' } })
    expect(formToInputs(schema, { n: '', to: '["a@b.c"]' }).inputs).toEqual({ to: ['a@b.c'] })
    expect(formToInputs(schema, { n: 'x' }).error).toMatch(/number/)
    expect(formToInputs(schema, { o: '{bad' }).error).toMatch(/JSON/)
  })
})
