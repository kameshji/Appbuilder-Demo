/**
 * P3-C: sorting by a lookup column's label (a sort key with `via`, docs/dev/query-v2.md 5b), engine vs plan parity and
 * the rule for rows whose target the viewer cannot read: they sort exactly like a blank label, so their position says
 * nothing about the hidden row (changing, removing or renaming hidden targets never changes the order).
 */
import { describe, expect, it } from 'vitest'
import type { FxRecord, FxResult, FxValue } from '../../contracts.ts'
import type { QueryPlan } from '../../platform/query.ts'
import { createEngine } from '../engine.ts'
import { analyze, bindResult, executePlan, residualScope, type AnalyzeResult } from './index.ts'
import { checkPlan } from './validate.ts'
import { compareKeys, decodeCursor, sortKeyValue } from './cursor.ts'
import { PlanError } from './reference.ts'
import { LOOKUP_SCHEMA, clientRows, lookupCorpus, lookupScope, orderRows, readableClients } from './testdata-lookup.ts'

function canon(v: FxValue): unknown {
  if (v instanceof Date) return { $t: v.getTime() }
  if (Array.isArray(v)) return v.map(canon)
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) o[k] = canon((v as FxRecord)[k]!)
    return o
  }
  return v
}

const engine = createEngine()
const clients = clientRows()
const orders = orderRows(clients)
const tables = { Orders: orders, Clients: clients }
const scope = lookupScope(tables)
const ORDERS = LOOKUP_SCHEMA.tables.Orders!
const relSchema = (t: string, col: string) => (ORDERS.lookups?.[col] === t ? LOOKUP_SCHEMA.tables[t] : undefined)
/** the viewer reads only the clients that are not hidden */
const relatedOf = (cl: FxRecord[]) => ({ rows: (t: string) => (t === 'Clients' ? readableClients(cl) : undefined), schema: (t: string) => LOOKUP_SCHEMA.tables[t] })

function run(plan: QueryPlan, ords = orders, cl = clients) {
  const checked = checkPlan(JSON.parse(JSON.stringify(plan)), ORDERS, 'Orders', { related: relSchema }).plan
  // the rows in reverse: the executor applies the natural order itself
  return executePlan(checked, [...ords].reverse(), ORDERS, { related: relatedOf(cl) })
}

function runPlans(r: AnalyzeResult): FxResult {
  const values: Record<string, FxValue> = {}
  for (const q of r.plans) values[q.id] = bindResult(q, run(q.plan))
  if (!r.residual) return { ok: true, value: values[r.plans[0]!.id]! }
  return engine.evaluate(r.residual.formula, residualScope(values, scope))
}

describe('sort by a lookup column: parity with the engine', () => {
  const formulas = lookupCorpus()
  const results = formulas.map((f) => ({ f, want: engine.evaluate(f, scope), r: analyze(f, LOOKUP_SCHEMA, { scope, engine }) }))

  it('every delegated formula gives exactly the engine result; sorts through a lookup become `via` keys', () => {
    const mismatches: string[] = []
    let delegated = 0
    let viaPlans = 0
    for (const { f, want, r } of results) {
      if (!r.fullyDelegated) continue
      delegated++
      if (r.plans.some((q) => q.plan.sort?.some((k) => k.via))) viaPlans++
      const got = runPlans(r)
      const a = want.ok ? canon(want.value) : 'error'
      const b = got.ok ? canon(got.value) : 'error'
      if (JSON.stringify(a) !== JSON.stringify(b)) mismatches.push(`${f}\n  engine: ${JSON.stringify(a).slice(0, 300)}\n  plan:   ${JSON.stringify(b).slice(0, 300)}\n  plans: ${JSON.stringify(r.plans.map((q) => q.plan))}`)
    }
    console.log(`lookup-sort corpus: ${formulas.length} formulas, ${delegated} delegated (${viaPlans} with a sort through a lookup), ${mismatches.length} mismatches`)
    expect(mismatches.slice(0, 5).join('\n\n')).toBe('')
    expect(delegated).toBeGreaterThanOrEqual(100)
    expect(viaPlans).toBeGreaterThanOrEqual(80)
  })

  it('a sort through a lookup before grouping or totals of part of the rows is refused, never computed partly', () => {
    const refused = results.filter((x) => !x.r.fullyDelegated)
    expect(refused.length).toBeGreaterThan(5)
    for (const { f, r } of refused) {
      expect(r.plan, f).toBeNull()
      expect(r.diagnostics.some((d) => d.severity === 'error' && /lookup/.test(d.message)), f).toBe(true)
    }
    // Sum over the whole table: the order changes nothing, so the sort is dropped and it delegates
    const s = analyze('=Sum(Sort(Orders, Client.Name), Amount)', LOOKUP_SCHEMA, { scope, engine })
    expect(s.fullyDelegated).toBe(true)
    expect(s.plans[0]!.plan.sort).toBeUndefined()
  })

  it('pages of 7 (ties, blanks, hidden and missing targets) concatenate to the full result', () => {
    let checked = 0
    for (const { r } of results) {
      if (!r.fullyDelegated) continue
      for (const q of r.plans) {
        if (q.shape !== 'rows' || q.plan.aggregate || !q.plan.sort?.some((k) => k.via)) continue
        const all = run(q.plan).rows
        const got: FxRecord[] = []
        let cursor: string | undefined
        for (let i = 0; i < 60; i++) {
          const page = run({ ...q.plan, page: { size: 7, cursor } })
          got.push(...page.rows)
          if (!page.nextCursor) break
          cursor = page.nextCursor
        }
        expect(canon(got)).toEqual(canon(all))
        checked++
      }
    }
    expect(checked).toBeGreaterThan(40)
  })
})

describe('rows whose target the viewer cannot read', () => {
  const plans: QueryPlan[] = [
    { version: 2, table: 'Orders', sort: [{ col: 'Client', dir: 'asc', via: { table: 'Clients', col: 'Name' } }] },
    { version: 2, table: 'Orders', sort: [{ col: 'Client', dir: 'desc', via: { table: 'Clients', col: 'Name' } }] },
    { version: 2, table: 'Orders', sort: [{ col: 'Agent', dir: 'desc', via: { table: 'Clients', col: 'Tier' } }, { col: 'Client', dir: 'asc', via: { table: 'Clients', col: 'Since' } }] },
    { version: 2, table: 'Orders', sort: [{ col: 'Client', dir: 'asc', via: { table: 'Clients', col: 'Seen' } }], take: { n: 20, from: 'end' } },
  ]
  const ids = (rows: FxRecord[]) => rows.map((r) => r.id)

  it('sort exactly like a blank label: tied with blank lookups, missing rows and blank names, by the order row itself', () => {
    const p = plans[0]!
    const got = run(p).rows
    const readable = new Map(readableClients(clients).map((c) => [c.id, c]))
    const blank = (o: FxRecord) => { const c = readable.get(o.Client as string); return c === undefined || c.Name === null || c.Name === '' }
    const leading = got.slice(0, got.filter(blank).length)
    expect(leading.every(blank)).toBe(true)
    // the blank group keeps the natural order of the orders (createdOn, id): nothing about the target
    expect(ids(leading)).toEqual(ids([...orders].filter(blank)))
  })

  it('changing, renaming or removing hidden targets never moves a row (no information through position)', () => {
    const variants: FxRecord[][] = [
      clients.map((c) => (c.Hidden ? { ...c, Name: 'AAAA first', Tier: 1e9, Since: new Date(1990, 0, 1), Seen: new Date(0) } : c)),
      clients.map((c) => (c.Hidden ? { ...c, Name: 'zzzz last', Tier: -1e9, Since: null, Seen: null } : c)),
      clients.filter((c) => !c.Hidden), // hidden rows gone altogether: the same as missing
    ]
    for (const p of plans) {
      const base = ids(run(p).rows)
      for (const v of variants) expect(ids(run(p, orders, v).rows), JSON.stringify(p.sort)).toEqual(base)
      // and every page boundary (cursor) is the same: cursors carry only what the viewer may read
      const c1 = run({ ...p, page: { size: 9 } }).nextCursor
      for (const v of variants) expect(run({ ...p, page: { size: 9 } }, orders, v).nextCursor).toBe(c1)
    }
  })

  it('a cursor never carries a hidden name', () => {
    const p: QueryPlan = { ...plans[0]!, page: { size: 1 } }
    let cursor: string | undefined
    const hiddenNames = new Set(clients.filter((c) => c.Hidden && typeof c.Name === 'string' && c.Name).map((c) => String(c.Name).toLowerCase()))
    const readableNames = new Set(readableClients(clients).map((c) => String(c.Name ?? '').toLowerCase()))
    for (let i = 0; i < orders.length; i++) {
      const page = run({ ...p, page: { size: 1, cursor } })
      if (!page.nextCursor) break
      const k = decodeCursor(p, page.nextCursor).keys[0]
      expect(typeof k).toBe('string')
      if (k !== '') expect(readableNames.has(k as string) || !hiddenNames.has(k as string)).toBe(true)
      cursor = page.nextCursor
    }
  })
})

describe('keyset cursors through a lookup stay correct when a target changes between pages', () => {
  it('the next page is exactly the rows after the cursor position in the order as it is now', () => {
    const sort: QueryPlan['sort'] = [{ col: 'Client', dir: 'asc', via: { table: 'Clients', col: 'Name' } }]
    // the first page ends 8 rows into the named clients (the blank group comes first)
    const named = (id: unknown) => readableClients(clients).some((c) => c.id === id && c.Name)
    const size = run({ version: 2, table: 'Orders', sort }).rows.findIndex((r) => named(r.Client)) + 8
    const plan: QueryPlan = { version: 2, table: 'Orders', sort, page: { size } }
    const p1 = run(plan)
    expect(p1.nextCursor).toBeTruthy()
    // a readable client of the first page is renamed to sort last, another one to sort first
    const first = p1.rows.map((r) => r.Client).find(named)
    expect(first).toBeTruthy()
    const changed = clients.map((c) => (c.id === first ? { ...c, Name: 'zzzz renamed' } : c.id === 'cl20' ? { ...c, Name: '   first' } : c))
    const p2 = run({ ...plan, page: { size, cursor: p1.nextCursor! } }, orders, changed)
    // expected, independently: the full new order, keep the rows strictly after the cursor's (key, createdOn, id)
    const cur = decodeCursor(plan, p1.nextCursor!)
    const readable = new Map(readableClients(changed).map((c) => [c.id, c]))
    const key = (o: FxRecord) => sortKeyValue('text', readable.get(o.Client as string)?.Name ?? null)
    const after = (o: FxRecord) => {
      const d = compareKeys([key(o)], cur.keys, ['asc'])
      if (d !== 0) return d > 0
      const t = (o.createdOn as Date).toISOString()
      return t > (cur.createdOn ?? '') || (t === cur.createdOn && String(o.id) > cur.id)
    }
    const fullNew = run({ version: 2, table: 'Orders', sort }, orders, changed).rows
    expect(p2.rows.length).toBeGreaterThan(0)
    expect(p2.rows.map((r) => r.id)).toEqual(fullNew.filter(after).slice(0, size).map((r) => r.id))
  })
})

describe('validation', () => {
  const check = (plan: unknown) => checkPlan(plan, ORDERS, 'Orders', { related: relSchema })
  it('needs a lookup to that table, a sortable target column, at most 3 such keys, and rows (not groups)', () => {
    expect(() => check({ version: 2, table: 'Orders', sort: [{ col: 'Title', dir: 'asc', via: { table: 'Clients', col: 'Name' } }] })).toThrow(/does not point/)
    expect(() => check({ version: 2, table: 'Orders', sort: [{ col: 'Client', dir: 'asc', via: { table: 'Clients', col: 'Nope' } }] })).toThrow(/does not exist in "Clients"/)
    expect(() => check({ version: 2, table: 'Orders', sort: [{ col: 'Client', dir: 'asc', via: { table: 'Clients' } }] })).toThrow(/via is/)
    const k = { col: 'Client', dir: 'asc', via: { table: 'Clients', col: 'Name' } }
    expect(() => check({ version: 2, table: 'Orders', sort: [k, k, k, k] })).toThrow(/at most 3/)
    expect(() => check({ version: 2, table: 'Orders', sort: [k], aggregate: { groupBy: ['Title'], measures: [] } })).toThrow(/not before grouping/)
    expect(() => check({ version: 2, table: 'Orders', aggregate: { groupBy: ['Client'], measures: [], sort: [k] } })).toThrow(/only possible for lists of rows/)
    // the columns it reads: the lookup column of Orders, the target's column of Clients (column-level security)
    const c = check({ version: 2, table: 'Orders', sort: [k] })
    expect([...c.columns]).toContain('Client')
    expect([...(c.via.get('Clients') ?? [])]).toEqual(['Name'])
  })
  it('the executor refuses without the target rows (never sorts by id)', () => {
    expect(() => executePlan({ version: 2, table: 'Orders', sort: [{ col: 'Client', dir: 'asc', via: { table: 'Clients', col: 'Name' } }] }, orders, ORDERS)).toThrow(PlanError)
  })
  it('the cursor spec names the path, so a cursor of a plain sort is refused', () => {
    const plain = run({ version: 2, table: 'Orders', sort: [{ col: 'Client', dir: 'asc' }], page: { size: 5 } }).nextCursor!
    expect(() => run({ version: 2, table: 'Orders', sort: [{ col: 'Client', dir: 'asc', via: { table: 'Clients', col: 'Name' } }], page: { size: 5, cursor: plain } })).toThrow(/different sort/)
  })
})
