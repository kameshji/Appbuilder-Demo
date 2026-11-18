/**
 * Server-mode delegation in the evaluator (P0 package D), against a fake platform: table formulas become queries,
 * results arrive asynchronously (loading keeps the previous value), a formula the server can't run over a large table
 * is an error, small tables are evaluated in the browser with a warning, and DataTable sort / search re-plan the query.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDef, FxRecord } from '@/contracts'
import type { QueryPlan } from '@/platform/query'
import type { QueryState } from '@/platform/query-cache'
import { cacheKey } from '@/platform/query-cache'
import { executePlan } from '@/fx/query/reference'

const TABLE = {
  id: 'tbl_o', name: 'Orders', displayName: 'Orders', primaryColumn: 'Title', createdOn: '', modifiedOn: '',
  columns: [
    { name: 'id', displayName: 'id', type: 'text', system: true },
    { name: 'createdOn', displayName: 'c', type: 'datetime', system: true },
    { name: 'Title', displayName: 'Title', type: 'text' },
    { name: 'Qty', displayName: 'Qty', type: 'number' },
    { name: 'Price', displayName: 'Price', type: 'decimal' },
  ],
}
const rows: FxRecord[] = Array.from({ length: 30 }, (_, i) => ({
  __id: `r${String(i).padStart(2, '0')}`, id: `r${String(i).padStart(2, '0')}`, createdOn: new Date(Date.UTC(2026, 0, 1, 0, i)), Title: `Order ${i}`, Qty: i % 5, Price: i * 10,
}))
const SCHEMA = { columns: { id: 'text' as const, createdOn: 'datetime' as const, Title: 'text' as const, Qty: 'number' as const, Price: 'number' as const } }

/** the fake cache: answers on demand (`resolve()`), notifying changed keys */
const fake = vi.hoisted(() => ({
  size: { rowCount: 1_000_000 as number | undefined, fullyLoaded: false },
  states: new Map<string, unknown>(),
  pending: [] as { key: string; plan: unknown; pageSize?: number }[],
  owners: new Map<string, string>(),
  listeners: new Set<(keys: string[]) => void>(),
}))

vi.mock('@/platform', () => ({
  platform: {
    getState: () => ({ ready: true, mode: 'server', tables: [TABLE], roles: [], dataVersion: 0, loading: [] }),
    subscribe: () => () => {},
    tables: {
      get: (n: string) => (n === 'Orders' ? TABLE : undefined),
      rows: () => [],
      sizeInfo: () => fake.size,
      queryState(plan: QueryPlan, opts: { pageSize?: number; owner?: string } = {}) {
        const key = cacheKey(plan, opts)
        if (opts.owner) fake.owners.set(opts.owner, key)
        const st = fake.states.get(key) as QueryState | undefined
        if (st) return st
        if (!fake.pending.some((p) => p.key === key)) fake.pending.push({ key, plan, pageSize: opts.pageSize })
        return { key, plan, status: 'loading', rows: [], hasMore: false, refreshing: false, loadingMore: false, version: 0 }
      },
      onQueryChange(l: (keys: string[]) => void) { fake.listeners.add(l); return () => fake.listeners.delete(l) },
      async query(plan: QueryPlan) {
        const res = executePlan({ ...plan, page: undefined }, rows, SCHEMA)
        return { key: cacheKey(plan), plan, status: 'ready', rows: res.rows, count: res.count, hasMore: false, refreshing: false, loadingMore: false, version: 1 }
      },
      flush: async () => {},
      loadMore: async () => {},
      releaseQuery: () => {},
      ensureLoaded: async () => {},
    },
    security: { currentUser: () => ({ id: 'u', name: 'U', email: 'u@x', roleIds: [] }) },
  },
  PlatformError: class extends Error {},
  userRecord: () => ({}),
}))

const { Evaluator, ROOT_CTX } = await import('./evaluator')
const { blankApp } = await import('./sample')
const { tableReads, chainItems, needsServer } = await import('./delegation')
const data = await import('./data')
const { runFormulaAsync } = await import('./host')

/** answer every pending query with the reference executor */
function resolveAll(): string[] {
  const keys: string[] = []
  for (const p of fake.pending.splice(0)) {
    const plan = p.plan as QueryPlan
    const res = executePlan({ ...plan, page: undefined, ...(p.pageSize ? { count: true } : {}) }, rows, SCHEMA)
    const page = p.pageSize ? res.rows.slice(0, p.pageSize) : res.rows
    fake.states.set(p.key, { key: p.key, plan, status: 'ready', rows: page, count: res.count, hasMore: !!p.pageSize && res.rows.length > p.pageSize, refreshing: false, loadingMore: false, version: 1 } satisfies QueryState)
    keys.push(p.key)
  }
  for (const l of fake.listeners) l(keys)
  return keys
}

const rt = (over: Record<string, unknown> = {}) => ({
  vars: {}, context: {}, collections: {}, outputs: {}, resetKeys: {}, focusKeys: {}, formModes: {}, dataKey: '0', userId: '', queryVersion: data.queryVersion(), ...over,
})

function app(props: Record<string, string>, type = 'Label'): AppDef {
  const a = blankApp('T', 1920, 1080)
  a.screens[0]!.children = [{ id: 'c1', name: 'C1', type, props, children: [] }]
  return a
}

beforeEach(() => {
  fake.states.clear()
  fake.pending.length = 0
  fake.size = { rowCount: 1_000_000, fullyLoaded: false }
  data.ensureQueryFeed()
})

describe('table reads', () => {
  it('finds the tables a formula reads; write targets are not reads', () => {
    expect(tableReads('=Filter(Orders, Qty > 1)')).toEqual(['Orders'])
    expect(tableReads('=Patch(Orders, Defaults(Orders), {Title: "n" & CountRows(Orders)})')).toEqual(['Orders'])
    expect(tableReads('=Patch(Orders, ThisItem, {Title: "x"})')).toEqual([])
    expect(tableReads('=Filter(Orders, Qty > 1)', { Orders: [] })).toEqual([]) // a collection of that name shadows it
    expect(chainItems('=Set(a, 1); Navigate(S2)')).toEqual(['=Set(a, 1)', '=Navigate(S2)'])
    expect(needsServer('=CountRows(Orders)')).toBe(true)
    fake.size = { rowCount: 30, fullyLoaded: true }
    expect(needsServer('=CountRows(Orders)')).toBe(false)
  })
})

describe('evaluator: delegated formulas (server mode)', () => {
  it('a count and a sum over a calculation run on the server; loading keeps the previous value', () => {
    const a = app({ Text: '="Open: " & CountRows(Filter(Orders, Qty * Price > 100)) & " / " & Sum(Orders, Qty * Price)' })
    const ev = new Evaluator(a, rt(), { w: 1920, h: 1080 })
    const node = ev.byId.get('c1')!.node
    const first = ev.evalProp(node, 'Text', ROOT_CTX)
    expect(first.loading).toBe(true)
    expect(first.delegation?.where).toBe('server')
    expect(fake.pending.map((p) => (p.plan as QueryPlan).aggregate ? 'sum' : 'count').sort()).toEqual(['count', 'sum'])
    resolveAll()
    ev.update(rt(), { w: 1920, h: 1080 })
    const v = ev.evalProp(node, 'Text', ROOT_CTX)
    const want = rows.filter((r) => (r.Qty as number) * (r.Price as number) > 100).length
    const sum = rows.reduce((s, r) => s + (r.Qty as number) * (r.Price as number), 0)
    expect(v.value).toBe(`Open: ${want} / ${sum}`)
    expect(v.loading).toBeUndefined()
  })

  it('a formula the server cannot run over a large table is an error with the reason and the span', () => {
    const f = '=CountRows(Filter(Orders, Len(Title) > 7))'
    const ev = new Evaluator(app({ Text: f }), rt(), { w: 1920, h: 1080 })
    const pe = ev.evalProp(ev.byId.get('c1')!.node, 'Text', ROOT_CTX)
    expect(pe.error).toMatch(/^Can't run on the server: .*Len\(Title\).*1,000,000 rows/)
    expect(f.slice(pe.diag!.start, pe.diag!.end)).toBe('Len(Title)')
    expect(pe.delegation?.where).toBe('error')
    expect(fake.pending).toEqual([]) // nothing was fetched, nothing was computed from part of the rows
  })

  it('a small table that is fully loaded evaluates such a formula in the browser, with a warning', () => {
    fake.size = { rowCount: 30, fullyLoaded: true }
    const ev = new Evaluator(app({ Text: '=CountRows(Filter(Orders, Len(Title) > 7))' }), rt(), { w: 1920, h: 1080 })
    const pe = ev.evalProp(ev.byId.get('c1')!.node, 'Text', ROOT_CTX)
    expect(pe.error).toBeUndefined()
    expect(pe.warning).toMatch(/^Runs in the browser/)
  })

  it('a list is paged and carries its query; a DataTable header sort and search re-plan it on the server', () => {
    const a = app({ Items: '=Filter(Orders, Qty >= 1)' }, 'DataTable')
    const ev = new Evaluator(a, rt(), { w: 1920, h: 1080 })
    const node = ev.byId.get('c1')!.node
    expect(ev.evalProp(node, 'Items', ROOT_CTX).loading).toBe(true)
    expect(fake.pending[0]!.pageSize).toBe(100)
    resolveAll()
    ev.update(rt(), { w: 1920, h: 1080 })
    const items = ev.evalProp(node, 'Items', ROOT_CTX).value as FxRecord[] & { __query?: { count: number; hasMore: boolean } }
    expect(items.length).toBe(24)
    expect(items.__query).toMatchObject({ count: 24, hasMore: false })
    // header sort (outputs of the DataTable) -> a new plan with the sort first; the old rows stay while it loads
    const sorted = rt({ outputs: { c1: { SortColumn: 'Price', SortOrder: 'Descending', SearchText: 'order 2' } } })
    ev.update(sorted, { w: 1920, h: 1080 })
    const waiting = ev.evalProp(node, 'Items', ROOT_CTX)
    expect(waiting.loading).toBe(true)
    expect(waiting.value).toBe(items)
    const plan = fake.pending[0]!.plan as QueryPlan
    expect(plan.sort).toEqual([{ col: 'Price', dir: 'desc' }])
    expect(plan.filter).toEqual({ and: [{ col: 'Qty', op: 'ge', value: 1 }, { or: [{ col: 'Title', op: 'contains', value: 'order 2' }] }] })
    resolveAll()
    ev.update({ ...sorted, queryVersion: data.queryVersion() }, { w: 1920, h: 1080 })
    const after = ev.evalProp(node, 'Items', ROOT_CTX).value as FxRecord[]
    expect(after.map((r) => r.Title)).toEqual(['Order 29', 'Order 28', 'Order 27', 'Order 26', 'Order 24', 'Order 23', 'Order 22', 'Order 21', 'Order 2'])
  })
})

describe('actions that read large tables (server mode)', () => {
  it('each step reads the server first, then runs with the results; variables of earlier steps are seen', async () => {
    const a = app({ Text: '=""' })
    const res = await runFormulaAsync({
      app: a, rt: { ...rt(), navStack: ['s1'] } as never, env: { w: 1920, h: 1080 }, node: null, ctx: ROOT_CTX, label: 'OnSelect',
      formula: '=Set(minQty, 3); Set(n, CountRows(Filter(Orders, Qty >= minQty))); Set(top, First(Sort(Orders, Price, SortOrder.Descending)).Title)',
    })
    expect(res.failed).toBeNull()
    expect(res.vars.n).toBe(rows.filter((r) => (r.Qty as number) >= 3).length)
    expect(res.vars.top).toBe('Order 29')
  })
  it('a read the server cannot run fails the action with the reason (nothing runs on part of the rows)', async () => {
    const res = await runFormulaAsync({
      app: app({}), rt: { ...rt(), navStack: ['s1'] } as never, env: { w: 1920, h: 1080 }, node: null, ctx: ROOT_CTX, label: 'OnSelect',
      formula: '=Set(n, CountRows(Filter(Orders, Len(Title) > 3)))',
    })
    expect(res.failed).toMatch(/Can't run on the server/)
    expect(res.vars.n).toBeUndefined()
  })
})
