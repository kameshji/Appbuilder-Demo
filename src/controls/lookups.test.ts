/** Lookup picker plans, label batching, cell states, sort rules and the server search by label (src/controls/lookups.ts) */
import { describe, expect, it } from 'vitest'
import type { ColumnDef, TableDef } from '@/platform/contracts'
import { checkPlan } from '@/fx/query/validate'
import { executePlan } from '@/fx/query/reference'
import { schemaInfoOf } from '@/platform/query-local'
import {
  LABEL_BATCH, LABEL_SORT_LIMIT, LOADING_MARK, NOT_AVAILABLE, answerMaySet, batches, isNoConnection, labelPlans, labelStoreKey, labelText, lookupCell,
  lookupSearchCondition, lookupSort, lookupSortKey, lookupSortSupport, lookupSortText, mergeLabels, missingIds, pickerMessage, pickerNote, pickerPlan, type LabelEntry,
} from './lookups'

const sys: ColumnDef[] = [
  { name: 'id', displayName: 'Id', type: 'text', system: true },
  { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true },
]
const def = (name: string, primaryColumn: string, cols: Partial<ColumnDef>[]): TableDef => ({
  id: `t_${name}`, name, displayName: name, primaryColumn, createdOn: '', modifiedOn: '',
  columns: [...sys, ...cols.map((c) => ({ displayName: c.name!, type: 'text', ...c }) as ColumnDef)],
})
const products = def('Products', 'Name', [{ name: 'Name' }, { name: 'Price', type: 'currency' }])
const numbered = def('Tickets', 'No', [{ name: 'No', type: 'number' }])
const orders = def('Orders', 'OrderNo', [{ name: 'OrderNo' }, { name: 'Product', type: 'lookup', lookupTable: 'Products' }])

// 2,500 products: more than the browser holds for a table in server mode
const productRows = Array.from({ length: 2500 }, (_, i) => ({ __id: `p${String(i + 1).padStart(4, '0')}`, id: `p${String(i + 1).padStart(4, '0')}`, Name: `Product ${i + 1}`, Price: i, createdOn: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) }))

describe('picker plan (type-ahead on the primary column)', () => {
  it('is a delegable plan: contains on the primary column, sorted, only that column; no page (the cache pages it)', () => {
    expect(pickerPlan(products, '  prod 24 ')).toEqual({ version: 2, table: 'Products', select: ['Name'], sort: [{ col: 'Name', dir: 'asc' }], filter: { col: 'Name', op: 'contains', value: 'prod 24' } })
    expect(pickerPlan(products, '')).toEqual({ version: 2, table: 'Products', select: ['Name'], sort: [{ col: 'Name', dir: 'asc' }] })
    expect(() => checkPlan(pickerPlan(products, 'x'), schemaInfoOf(products), 'Products')).not.toThrow()
  })
  it('a number primary column matches a typed number exactly, other text matches nothing extra (first rows)', () => {
    expect(pickerPlan(numbered, '42').filter).toEqual({ col: 'No', op: 'eq', value: 42 })
    expect(pickerPlan(numbered, 'abc').filter).toBeUndefined()
    expect(() => checkPlan(pickerPlan(numbered, '42'), schemaInfoOf(numbered), 'Tickets')).not.toThrow()
  })
  it('finds a row far past the first page of a 2,500-row table (the reference executor, as demo mode and offline run it)', () => {
    const res = executePlan({ ...pickerPlan(products, 'product 2345'), page: { size: 25 } }, productRows, schemaInfoOf(products))
    expect(res.rows.map((r) => r.Name)).toEqual(['Product 2345'])
    const first = executePlan({ ...pickerPlan(products, ''), count: true, page: { size: 25 } }, productRows, schemaInfoOf(products))
    expect(first.rows).toHaveLength(25)
    expect(first.count).toBe(2500)
    expect(first.nextCursor).toBeTruthy()
  })
})

describe('label batches', () => {
  it('asks only for ids not known yet, once each, sorted (same ids, same plan key)', () => {
    const known = new Set(['b'])
    expect(missingIds(['c', 'a', 'b', '', null, 3, 'a', ' c '], (id) => known.has(id))).toEqual(['a', 'c'])
  })
  it('one plan per 200 ids: a screen of rows is one request per target table, never one per row', () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id${String(i).padStart(3, '0')}`)
    const plans = labelPlans(products, ids)
    expect(plans).toHaveLength(3)
    expect(batches(ids).map((b) => b.length)).toEqual([LABEL_BATCH, LABEL_BATCH, 50])
    expect(plans[0]).toEqual({ version: 2, table: 'Products', filter: { col: 'id', op: 'in', value: ids.slice(0, 200) }, select: ['Name'] })
    for (const p of plans) expect(() => checkPlan(p, schemaInfoOf(products), 'Products')).not.toThrow()
    // a Gallery asks for whole rows (ThisItem.Product.Price)
    expect(labelPlans(products, ['a'], { full: true })[0]!.select).toBeUndefined()
  })
  it('the answer fills the labels; asked ids that did not come back are "not available"', () => {
    const m = new Map<string, LabelEntry>()
    const res = executePlan(labelPlans(products, ['p0001', 'p2345', 'gone'])[0]!, productRows, schemaInfoOf(products))
    expect(mergeLabels(m, ['gone', 'p0001', 'p2345'], res.rows, 'Name')).toBe(true)
    expect([...m.entries()].sort()).toEqual([['gone', null], ['p0001', 'Product 1'], ['p2345', 'Product 2345']])
    expect(mergeLabels(m, ['gone', 'p0001', 'p2345'], res.rows, 'Name')).toBe(false)
    // a rename (live refresh) changes the label
    expect(mergeLabels(m, ['p0001'], [{ __id: 'p0001', Name: 'Renamed' }], 'Name')).toBe(true)
    expect(m.get('p0001')).toBe('Renamed')
  })
  it('a shared store settles when two answers disagree (one refetched after a delete, one still showing its previous rows)', () => {
    // the render loop of the Manufacturing exit check: two lists fold their own answers into one store on every render;
    // each fold that changes something notifies every list, which folds again
    const m = new Map<string, LabelEntry>()
    const order = new Map<string, number>()
    const before = [{ __id: 's1', Name: 'SAMPLE press 1' }]
    // the first answer of both plans: the label
    expect(mergeLabels(m, ['s1'], before, 'Name', { order, at: 1 })).toBe(true)
    expect(mergeLabels(m, ['s1', 's2'], before, 'Name', { order, at: 2 })).toBe(true) // s2: not available
    // the SAMPLE rows are removed: plan A has refetched (s1 is gone), plan B still refetches (its previous rows, provisional)
    const fresh = { order, at: 3 }
    const stale = { order, at: null }
    let flips = 0
    for (let render = 0; render < 60; render++) {
      if (mergeLabels(m, ['s1'], [], 'Name', fresh)) flips++
      if (mergeLabels(m, ['s1', 's2'], before, 'Name', stale)) flips++
    }
    expect(flips).toBe(1) // once (label -> not available), never back and forth
    expect(m.get('s1')).toBeNull()
    // an answer seen before another never overrides it, even when both are complete answers
    const older = { order, at: 2 }
    expect(mergeLabels(m, ['s1'], before, 'Name', older)).toBe(false)
    expect(m.get('s1')).toBeNull()
    // plan B's refetch arrives (a newer answer): it agrees, nothing changes
    expect(mergeLabels(m, ['s1', 's2'], [], 'Name', { order, at: 4 })).toBe(false)
    // a provisional answer (an error, a failed refresh) only fills what is not known yet
    expect(mergeLabels(m, ['s1', 'new'], [{ __id: 's1', Name: 'x' }], 'Name', { order, at: null })).toBe(true)
    expect(m.get('s1')).toBeNull()
    expect(m.get('new')).toBeNull()
    // a later complete answer still wins (a rename after the delete was undone, say)
    expect(mergeLabels(m, ['s1'], [{ __id: 's1', Name: 'Back' }], 'Name', { order, at: 5 })).toBe(true)
    expect(m.get('s1')).toBe('Back')
  })
  it('answerMaySet: a provisional answer fills only unknown entries; a complete one never overrides a newer one', () => {
    const order = new Map([['a', 5]])
    expect(answerMaySet({ order, at: null }, 'a', true)).toBe(false)
    expect(answerMaySet({ order, at: null }, 'b', false)).toBe(true)
    expect(answerMaySet({ order, at: 4 }, 'a', true)).toBe(false)
    expect(answerMaySet({ order, at: 5 }, 'a', true)).toBe(true)
    expect(answerMaySet({ order, at: 6 }, 'a', true)).toBe(true)
    expect(answerMaySet({ order, at: 1 }, 'b', true)).toBe(true)
  })
  it('labels per user and table (another user sees other rows)', () => {
    expect(labelStoreKey('u1', 'Products')).toBe(labelStoreKey('u1', 'products'))
    expect(labelStoreKey('u1', 'Products')).not.toBe(labelStoreKey('u2', 'Products'))
  })
  it('label text: blanks and dates', () => {
    expect(labelText(null)).toBe('(blank)')
    expect(labelText('')).toBe('(blank)')
    expect(labelText(12)).toBe('12')
    expect(labelText(new Date(2026, 10, 20))).toBe('2026-11-20')
  })
})

describe('lookup cells', () => {
  it('label, loading, a neutral placeholder for rows the viewer cannot read; never the id', () => {
    expect(lookupCell('p1', 'Product 1')).toEqual({ state: 'label', text: 'Product 1' })
    expect(lookupCell('p1', undefined)).toEqual({ state: 'loading', text: LOADING_MARK })
    expect(lookupCell('p1', null)).toEqual({ state: 'missing', text: NOT_AVAILABLE })
    expect(lookupCell('', 'x')).toEqual({ state: 'blank', text: '' })
    expect(lookupCell(null, undefined).state).toBe('blank')
    for (const e of [undefined, null, 'Product 1'] as const) expect(lookupCell('019a-secret-id', e).text).not.toContain('019a')
  })
  it('searches and sorts held in the browser read labels; placeholders count as blank', () => {
    expect(lookupSortText('p1', 'Product 1')).toBe('Product 1')
    expect(lookupSortText('p1', null)).toBe('')
    expect(lookupSortText('p1', undefined)).toBe('')
  })
  it('sorting: on the server by label where supported (never by id), with a plain reason otherwise; in the browser by label up to a limit', () => {
    expect(lookupSort({ ok: true }, 'Product', 0).sortable).toBe(true)
    const hidden = lookupSort({ ok: false, why: 'hidden' }, 'Product', 0, 'Products')
    expect(hidden).toEqual({ sortable: false, reason: 'Sorting by Product is not available: you cannot see the names in Products it would be sorted by.' })
    expect(lookupSort({ ok: false, why: 'store' }, 'Product', 0, 'Products').reason).toMatch(/stored where the server cannot sort/)
    expect(lookupSort({ ok: false, why: 'kind' }, 'Product', 0, 'Products').reason).toMatch(/no name column/)
    expect(lookupSort(false, 'Product', 10).sortable).toBe(true)
    expect(lookupSort(false, 'Product', LABEL_SORT_LIMIT + 1).sortable).toBe(false)
  })
  it('server support: same PostgreSQL store, a sortable primary column the viewer may read', () => {
    expect(lookupSortSupport({ table: orders, target: products, hidden: false })).toEqual({ ok: true })
    expect(lookupSortSupport({ table: orders, target: products, hidden: true })).toEqual({ ok: false, why: 'hidden' })
    expect(lookupSortSupport({ table: orders, target: undefined, hidden: false })).toEqual({ ok: false, why: 'kind' })
    expect(lookupSortSupport({ table: orders, target: def('Pics', 'Photo', [{ name: 'Photo', type: 'image' }]), hidden: false })).toEqual({ ok: false, why: 'kind' })
    expect(lookupSortSupport({ table: orders, target: def('Refs', 'Other', [{ name: 'Other', type: 'lookup', lookupTable: 'Products' }]), hidden: false }).ok).toBe(false)
    // another store: refused unless both are in the same connection and it is known to be PostgreSQL
    const ext = { ...products, connectionId: 'conn_my' }
    expect(lookupSortSupport({ table: orders, target: ext, hidden: false })).toEqual({ ok: false, why: 'store' })
    expect(lookupSortSupport({ table: { connectionId: 'conn_my' }, target: ext, hidden: false })).toEqual({ ok: false, why: 'store' })
    expect(lookupSortSupport({ table: { connectionId: 'conn_my' }, target: ext, hidden: false, connectorOf: () => 'mysql' })).toEqual({ ok: false, why: 'store' })
    expect(lookupSortSupport({ table: { connectionId: 'conn_my' }, target: ext, hidden: false, connectorOf: () => 'postgres' })).toEqual({ ok: true })
  })
  it('the server sort key reads the primary column through the lookup', () => {
    expect(lookupSortKey('Product', products, 'desc')).toEqual({ col: 'Product', dir: 'desc', via: { table: 'Products', col: 'Name' } })
    expect(lookupSortKey('Product', numbered, 'asc')).toEqual({ col: 'Product', dir: 'asc', via: { table: 'Tickets', col: 'No' } })
    const plan = { version: 2 as const, table: 'Orders', sort: [lookupSortKey('Product', products, 'asc')!], page: { size: 2 } }
    const related = (t: string) => (t === 'Products' ? schemaInfoOf(products) : undefined)
    expect(() => checkPlan(plan, schemaInfoOf(orders), 'Orders', { related })).not.toThrow()
  })
})

describe('server search by label (lookup path)', () => {
  it('a lookup column is searched through its target primary column, not by id', () => {
    const c = lookupSearchCondition('Product', products, 'product 23')
    expect(c).toEqual({ via: { col: 'Product', table: 'Products', where: { col: 'Name', op: 'contains', value: 'product 23' } } })
    const plan = { version: 2 as const, table: 'Orders', filter: { or: [{ col: 'OrderNo', op: 'contains' as const, value: 'product 23' }, c!] } }
    const related = (t: string) => (t === 'Products' ? schemaInfoOf(products) : undefined)
    expect(() => checkPlan(plan, schemaInfoOf(orders), 'Orders', { related })).not.toThrow()
    const orderRows = [
      { __id: 'o1', id: 'o1', OrderNo: 'A-1', Product: 'p0023', createdOn: new Date(1) },
      { __id: 'o2', id: 'o2', OrderNo: 'A-2', Product: 'p0001', createdOn: new Date(2) },
      { __id: 'o3', id: 'o3', OrderNo: 'A-3', Product: 'p0230', createdOn: new Date(3) },
    ]
    const res = executePlan(plan, orderRows, schemaInfoOf(orders), { related: { rows: (t) => (t === 'Products' ? productRows : undefined), schema: (t) => (t === 'Products' ? schemaInfoOf(products) : undefined) } })
    expect(res.rows.map((r) => r.OrderNo)).toEqual(['A-1', 'A-3'])
  })
  it('a target whose primary column is not text is left out (no search by id)', () => {
    expect(lookupSearchCondition('Ticket', numbered, '4')).toBeNull()
  })
})

describe('picker messages', () => {
  it('plain-English empty, error and offline states', () => {
    expect(pickerMessage({ status: 'ready', rows: 0, search: 'zz', table: 'Products' })).toBe('No Products match "zz".')
    expect(pickerMessage({ status: 'ready', rows: 0, search: '', table: 'Products' })).toBe('Products has no records you can pick yet.')
    expect(pickerMessage({ status: 'ready', rows: 3, search: '', table: 'Products' })).toBeNull()
    expect(pickerMessage({ status: 'loading', rows: 0, search: 'a', table: 'Products' })).toBe('Searching…')
    expect(pickerMessage({ status: 'error', rows: 0, search: '', table: 'Products', errorMessage: 'You do not have access' })).toBe('Could not load Products: You do not have access.')
    expect(pickerMessage({ status: 'error', rows: 0, search: '', table: 'Products', offline: true })).toBe('Products is not available offline. Connect to pick a record.')
  })
  it('the count line while more rows exist', () => {
    expect(pickerNote(25, 2500, true)).toBe('25 of 2,500: scroll or type to narrow')
    expect(pickerNote(25, 25, false)).toBeNull()
  })
  it('recognises a missing connection', () => {
    expect(isNoConnection(Object.assign(new Error('Could not reach the server.'), { network: true }))).toBe(true)
    expect(isNoConnection({ code: 'unavailable', message: 'Could not reach the server.' })).toBe(true)
    expect(isNoConnection({ code: 'forbidden', message: 'no' })).toBe(false)
  })
})
