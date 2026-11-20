/**
 * Query v2 on connectors without SQL pushdown of plans (data files here; MySQL and Google Sheets take the same path):
 * the DataService reads at most QUERY_FALLBACK_ROW_CAP rows the caller may see, runs the reference executor and flags
 * `truncated` when the read was capped. Security (row filters, hidden columns) applies as on PostgreSQL.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness } from './testing.ts'
import type { Harness } from './testing.ts'
import { QUERY_FALLBACK_ROW_CAP } from '../../../src/platform/query.ts'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(() => h.cleanup())
const A = 'user_admin'
const M = 'user_maker'

async function fileTable(csvText: string, name = 'people.csv') {
  const r = await h.call(M, 'POST', `/api/v1/files?name=${name}&displayName=People`, undefined, { raw: Buffer.from(csvText) })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return (await h.meta.tables.get(r.body.tableIds[0]))!
}
const query = (as: string, plan: Record<string, unknown>) => h.call(as, 'POST', '/api/v1/query', { plan: { version: 2, table: 'People', ...plan } })

describe('Query v2 fallback (reference executor)', () => {
  it('filters, sorts, pages with a cursor, counts and aggregates over a data file', async () => {
    await fileTable('Name,City,Age\nAnn,Pune,31\nbob,pune,45\nCyd,Delhi,22\nDee,,60\n')
    const r = await query(M, { filter: { col: 'Age', op: 'gt', value: 25 }, sort: [{ col: 'Name', dir: 'desc' }], count: true, page: { size: 2 } })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.rows.map((x: any) => x.Name)).toEqual(['Dee', 'bob'])
    expect(r.body.count).toBe(3)
    expect(r.body.truncated).toBeUndefined()
    const next = await query(M, { filter: { col: 'Age', op: 'gt', value: 25 }, sort: [{ col: 'Name', dir: 'desc' }], count: true, page: { size: 2, cursor: r.body.nextCursor } })
    expect(next.body.rows.map((x: any) => x.Name)).toEqual(['Ann'])
    expect(next.body.nextCursor).toBeNull()
    const g = await query(M, { aggregate: { groupBy: ['City'], measures: [{ name: 'N', fn: 'count' }, { name: 'Total', fn: 'sum', col: 'Age' }] } })
    expect(g.body.rows).toEqual([{ City: 'Pune', N: 2, Total: 76 }, { City: 'Delhi', N: 1, Total: 22 }, { City: null, N: 1, Total: 60 }])
    expect((await query(M, { filter: { col: 'Nope', op: 'eq', value: 1 } })).status).toBe(422)
  })

  it('flags truncated when the table has more rows than the fallback reads', async () => {
    const lines = ['Name,N']
    for (let i = 0; i < QUERY_FALLBACK_ROW_CAP + 10; i++) lines.push(`r${i},${i}`)
    await fileTable(lines.join('\n') + '\n')
    const r = await query(M, { count: true, page: { size: 0 } })
    expect(r.status).toBe(200)
    expect(r.body.count).toBe(QUERY_FALLBACK_ROW_CAP)
    expect(r.body.truncated).toBe(true)
  })

  it('P3-C: a sort by a lookup column is refused in plain words (never computed over part of the rows or targets)', async () => {
    const t = await fileTable('Name,Boss\nAnn,\nBob,\n')
    // a lookup of the file table to itself (same store): the store still can't run the sort as one query
    await h.meta.tables.upsert({ ...t, columns: t.columns.map((c) => (c.name === 'Boss' ? { ...c, type: 'lookup' as const, lookupTable: 'People' } : c)) })
    const r = await query(M, { sort: [{ col: 'Boss', dir: 'asc', via: { table: 'People', col: 'Name' } }] })
    expect(r.status, JSON.stringify(r.body)).toBe(422)
    expect(r.body.error.message).toBe("This list can't be sorted by Boss: sorting by a lookup's names needs a table in a PostgreSQL database, and People is stored in a connection that can't run that query.")
    // a plain sort of the same column still works (by the stored value)
    expect((await query(M, { sort: [{ col: 'Name', dir: 'asc' }] })).status).toBe(200)
  })

  it('row filters and hidden columns apply to the fallback too', async () => {
    const t = await fileTable('Name,City,Salary\nAnn,Pune,10\nBob,Delhi,20\nCyd,Pune,30\n')
    const role = (await h.call(A, 'POST', '/api/v1/roles', { name: 'PuneOnly', privileges: [{ table: t.id, create: false, read: 'all', update: 'none', delete: 'none', columns: { Salary: 'none' }, rowFilter: [{ column: 'City', op: 'eq', value: 'pune' }] }] })).body
    const u = (await h.call(A, 'POST', '/api/v1/users', { name: 'P', email: 'p@x.io', roleIds: [role.id] })).body
    const r = await query(u.id, { count: true, page: { size: 10 } })
    expect(r.body.rows.map((x: any) => x.Name)).toEqual(['Ann', 'Cyd'])
    expect(Object.keys(r.body.rows[0])).not.toContain('Salary')
    expect(r.body.count).toBe(2)
    const s = await query(u.id, { aggregate: { groupBy: [], measures: [{ name: 'S', fn: 'sum', col: 'Salary' }] } })
    expect(s.status).toBe(403)
    expect(s.body.error.field).toBe('Salary')
  })
})
