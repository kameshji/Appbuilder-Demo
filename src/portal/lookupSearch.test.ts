/** the portal grid's lookup type-ahead (server mode, P0 package M): one delegable Query v2 plan per keystroke batch */
import { describe, expect, it } from 'vitest'
import { lookupSearchPlan } from './cells'
import { checkPlan } from '@/fx/query/validate'

const customers = { name: 'Customers', primaryColumn: 'Name', columns: [{ name: 'id', displayName: 'Id', type: 'text' as const }, { name: 'Name', displayName: 'Name', type: 'text' as const }] }

describe('lookup type-ahead plan', () => {
  it('searches the display column on the server, 20 at a time, sorted', () => {
    expect(lookupSearchPlan(customers, '  acme ')).toEqual({
      version: 2, table: 'Customers', select: ['Name'], page: { size: 20 }, sort: [{ col: 'Name', dir: 'asc' }], filter: { col: 'Name', op: 'contains', value: 'acme' },
    })
    expect(lookupSearchPlan(customers, '').filter).toBeUndefined()
    // the server's plan checker accepts it as it is (a delegable plan: filter, sort, page)
    expect(() => checkPlan(lookupSearchPlan(customers, 'x'), { columns: { id: 'text', Name: 'text' } }, 'Customers')).not.toThrow()
  })
  it('a number display column: no text filter (the first 20 rows)', () => {
    const t = { ...customers, primaryColumn: 'No', columns: [...customers.columns, { name: 'No', displayName: 'No', type: 'number' as const }] }
    expect(lookupSearchPlan(t, '12')).toEqual({ version: 2, table: 'Customers', select: ['No'], page: { size: 20 } })
  })
})
