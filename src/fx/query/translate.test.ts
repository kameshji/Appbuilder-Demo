import { describe, expect, it } from 'vitest'
import type { FxRecord } from '../../contracts.ts'
import type { QueryPlan, SchemaInfo } from '../../platform/query.ts'
import { createEngine } from '../engine.ts'
import { analyze, bindResult, decodeCursor, encodeCursor, executePlan, explain, residualScope, CursorError } from './index.ts'
import { customerRows, sampleScope, SCHEMA, ticketRows } from './testdata.ts'

const tables: Record<string, FxRecord[]> = { Tickets: ticketRows(), Customers: customerRows() }
const scope = sampleScope(tables)
const plan = (f: string, schema: SchemaInfo = SCHEMA) => {
  const r = analyze(f, schema, { scope })
  expect(r.diagnostics, f).toEqual([])
  return r
}

describe('analyze: plans', () => {
  it('a plain table is a rows plan with no residual', () => {
    const r = plan('=Tickets')
    expect(r.plan).toEqual({ version: 2, table: 'Tickets' })
    expect(r.residual).toBeNull()
    expect(r.fullyDelegated).toBe(true)
    expect(r.plans[0]!.shape).toBe('rows')
  })

  it('text equality ignores case; outside values are embedded', () => {
    expect(plan('=Filter(Tickets, Status = "open")').plan!.filter).toEqual({ col: 'Status', op: 'eq', value: 'open' })
    expect(plan('=Filter(Tickets, Status = Dropdown1.Selected.Value)').plan!.filter).toEqual({ col: 'Status', op: 'eq', value: 'Closed' })
    expect(plan('=Filter(Tickets, Owner = User().Email)').plan!.filter).toEqual({ col: 'Owner', op: 'eq', value: 'asha@example.com' })
  })

  it('encodes the engine blank rules with explicit isNull branches', () => {
    // Blank() < 3 is true (blank counts as 0) and Blank() = 0 is true
    expect(plan('=Filter(Tickets, Priority < 3)').plan!.filter).toEqual({ or: [{ col: 'Priority', op: 'lt', value: 3 }, { col: 'Priority', op: 'isNull' }] })
    expect(plan('=Filter(Tickets, Priority = 0)').plan!.filter).toEqual({ or: [{ col: 'Priority', op: 'eq', value: 0 }, { col: 'Priority', op: 'isNull' }] })
    expect(plan('=Filter(Tickets, Priority > 3)').plan!.filter).toEqual({ col: 'Priority', op: 'gt', value: 3 })
    // Status = Blank() matches '' and NULL; Status <> "x" also keeps NULL
    expect(plan('=Filter(Tickets, Status = Blank())').plan!.filter).toEqual({ or: [{ col: 'Status', op: 'eq', value: '' }, { col: 'Status', op: 'isNull' }] })
    expect(plan('=Filter(Tickets, Status <> "x")').plan!.filter).toEqual({ or: [{ col: 'Status', op: 'ne', value: 'x' }, { col: 'Status', op: 'isNull' }] })
    expect(plan('=Filter(Tickets, IsBlank(Title))').plan!.filter).toEqual({ or: [{ col: 'Title', op: 'isNull' }, { col: 'Title', op: 'eq', value: '' }] })
    expect(plan('=Filter(Tickets, IsBlank(Due))').plan!.filter).toEqual({ col: 'Due', op: 'isNull' })
    // a blank date is before every date
    expect(plan('=Filter(Tickets, Due < Date(2026, 3, 1))').plan!.filter).toEqual({ or: [{ col: 'Due', op: 'lt', value: { $date: '2026-03-01' } }, { col: 'Due', op: 'isNull' }] })
  })

  it('dates: calendar columns get $date (rounded the engine way), instants get $datetime', () => {
    const noon = new Date(2026, 2, 1, 12)
    const s = { resolve: (n: string) => (n === 'Noon' ? noon : scope.resolve(n)) }
    const f = (src: string) => analyze(src, SCHEMA, { scope: s }).plan!.filter
    expect(f('=Filter(Tickets, Due < Noon)')).toEqual({ or: [{ col: 'Due', op: 'lt', value: { $date: '2026-03-02' } }, { col: 'Due', op: 'isNull' }] })
    expect(f('=Filter(Tickets, Due >= Noon)')).toEqual({ col: 'Due', op: 'ge', value: { $date: '2026-03-02' } })
    expect(f('=Filter(Tickets, Due <= Noon)')).toEqual({ or: [{ col: 'Due', op: 'le', value: { $date: '2026-03-01' } }, { col: 'Due', op: 'isNull' }] })
    expect(f('=Filter(Tickets, Due = Noon)')).toEqual({ const: false })
    expect(f('=Filter(Tickets, Updated > Noon)')).toEqual({ col: 'Updated', op: 'gt', value: { $datetime: noon.toISOString() } })
    // DateAdd / Today() are evaluated in the browser and embedded
    const today = new Date()
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7)
    expect(f('=Filter(Tickets, Due > DateAdd(Today(), -7, "Days"))')).toEqual({ col: 'Due', op: 'gt', value: { $date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` } })
  })

  it('in-lists, substring tests and column-to-column comparisons', () => {
    expect(plan('=Filter(Tickets, Status in ["Open", "closed"])').plan!.filter).toEqual({ col: 'Status', op: 'in', value: ['Open', 'closed'] })
    expect(plan('=Filter(Tickets, Status exactin ["Open"])').plan!.filter).toEqual({ col: 'Status', op: 'eq', value: 'Open', exact: true })
    expect(plan('=Filter(Tickets, "jam" in Title)').plan!.filter).toEqual({ col: 'Title', op: 'contains', value: 'jam' })
    expect(plan('=Filter(Tickets, StartsWith(Owner, "A"))').plan!.filter).toEqual({ col: 'Owner', op: 'startsWith', value: 'a' })
    expect(plan('=Filter(Tickets, Priority > Score)').plan!.filter).toEqual({
      or: [
        { col: 'Priority', op: 'cmpCol', cmp: 'gt', other: 'Score' },
        { and: [{ col: 'Priority', op: 'isNull' }, { col: 'Score', op: 'lt', value: 0 }] },
        { and: [{ col: 'Score', op: 'isNull' }, { col: 'Priority', op: 'gt', value: 0 }] },
      ],
    })
  })

  it('pipelines: sort, take, single, count, aggregates, select', () => {
    expect(plan('=FirstN(Sort(Filter(Tickets, Active), Priority, SortOrder.Descending), 5)').plan).toEqual({
      version: 2, table: 'Tickets', filter: { col: 'Active', op: 'eq', value: true }, sort: [{ col: 'Priority', dir: 'desc' }], take: { n: 5, from: 'start' },
    })
    expect(plan('=Sort(Sort(Tickets, Title), Priority)').plan!.sort).toEqual([{ col: 'Priority', dir: 'asc' }, { col: 'Title', dir: 'asc' }])
    expect(plan('=Last(Tickets)').plan).toEqual({ version: 2, table: 'Tickets', take: { n: 1, from: 'end' }, single: true })
    expect(plan('=CountRows(Filter(Tickets, Active))').plans[0]!.shape).toBe('count')
    const s = plan('=Sum(Filter(Tickets, Active), Priority)')
    expect(s.plan!.aggregate).toEqual({ groupBy: [], measures: [{ name: 'Value', fn: 'sum', col: 'Priority' }] })
    expect(s.plans[0]!.shape).toBe('scalar')
    expect(plan('=Distinct(Tickets, Status)').plan!.aggregate).toEqual({ groupBy: ['Status'], measures: [], as: { Status: 'Value' } })
    const g = plan('=DropColumns(AddColumns(GroupBy(Tickets, "Status", "G"), "N", CountRows(G), "Hi", CountIf(G, Priority > 2)), "G")')
    expect(g.plan!.aggregate!.measures).toEqual([{ name: 'N', fn: 'count' }, { name: 'Hi', fn: 'count', filter: { col: 'Priority', op: 'gt', value: 2 } }])
    expect(plan('=ShowColumns(Tickets, "Title", "Nope")').plan!.select).toEqual(['Title'])
  })

  it('residual formulas finish bounded results in the browser', () => {
    const r = plan('="Open: " & CountRows(Filter(Tickets, Status = "open")) & " of " & CountRows(Tickets)')
    expect(r.plans.map((q) => q.id)).toEqual(['__q0', '__q1'])
    expect(r.residual!.formula).toBe('=((("Open: " & __q0) & " of ") & __q1)')
    expect(plan('=LookUp(Tickets As t, t.Priority > 1, t.Title & "!")').residual!.formula).toBe('=LookUp(__q0 As t, true, (t.Title & "!"))')
    expect(plan('=Concat(FirstN(Tickets, 3), Title)').residual!.formula).toBe('=Concat(__q0, Title)')
  })

  it('every plan is plain JSON', () => {
    const r = plan('=FirstN(SortByColumns(Filter(Tickets, Due > Today() || IsBlank(Owner)), "Due", SortOrder.Descending), 3)')
    expect(JSON.parse(JSON.stringify(r.plans))).toEqual(r.plans)
  })

  it('uses the engine passed in (user-defined functions, named formulas) for outside values', () => {
    const engine = createEngine({ formulas: 'Twice(x: Number): Number = x * 2; Limit = 3;' })
    const r = analyze('=Filter(Tickets, Priority > Twice(Limit))', SCHEMA, { scope, engine })
    expect(r.plan!.filter).toEqual({ col: 'Priority', op: 'gt', value: 6 })
  })

  it('behaviour formulas: write targets are left alone, reads are planned', () => {
    const r = plan('=Patch(Tickets, LookUp(Tickets, id = "t01"), {Title: "x"}); Notify("saved")')
    expect(r.plan).toEqual({ version: 2, table: 'Tickets', filter: { col: 'id', op: 'eq', value: 't01' }, take: { n: 1, from: 'start' }, single: true })
    expect(r.residual!.formula).toBe('=Patch(Tickets, __q0, {Title: "x"}); Notify("saved")')
  })

  it('formulas without data-source tables need no plan', () => {
    const r = analyze('=Filter(varList, Value = "Open")', SCHEMA, { scope })
    expect(r).toMatchObject({ plan: null, plans: [], residual: null, diagnostics: [], fullyDelegated: true })
  })
})

describe('analyze: diagnostics', () => {
  const diag = (f: string, schema: SchemaInfo = SCHEMA) => analyze(f, schema, { scope })

  it('points at the sub-expression with a reason and a suggestion', () => {
    const r = diag('=Filter(Tickets, Len(Title) > 3)')
    expect(r.plan).toBeNull()
    expect(r.fullyDelegated).toBe(false)
    expect(r.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'not-delegable-expression', text: 'Len(Title)', table: 'Tickets' })])
    expect(r.diagnostics[0]!.suggestion).toBeTruthy()
    expect(diag('=Filter(Tickets, Code < "5")').diagnostics[0]!.code).toBe('numeric-text')
    expect(diag('=Filter(Tickets, Code = 10)').diagnostics[0]!.code).toBe('type-mismatch')
    expect(diag('=Concat(Filter(Tickets, Active), Title)').diagnostics[0]).toMatchObject({ code: 'unbounded-consumer', text: 'Filter(Tickets, Active)' })
    expect(diag('=Sum(Tickets, Priority * 2)').diagnostics[0]!.code).toBe('not-delegable-expression')
    expect(diag('=RemoveIf(Tickets, Active)').diagnostics[0]!.code).toBe('not-delegable-function')
    expect(diag('=Filter(Tickets, Owner = LookUp(Customers, Name = "Asha", Email))').diagnostics[0]!.code).toBe('nested-table')
    expect(diag('=Filter(Tickets, ').diagnostics[0]!.code).toBe('parse-error')
  })

  it('a small, fully loaded table is evaluated in the browser with a warning', () => {
    const small: SchemaInfo = { tables: { ...SCHEMA.tables, Tickets: { ...SCHEMA.tables.Tickets!, fullyLoaded: true, rowCount: 40 } } }
    const r = analyze('=Filter(Tickets, Len(Title) > 3)', small, { scope })
    expect(r.diagnostics).toEqual([expect.objectContaining({ severity: 'warning', code: 'client-evaluated' })])
    expect(r.fullyDelegated).toBe(false)
    expect(r.clientEvaluated).toBe(true)
    // over the threshold it is an error again
    expect(analyze('=Filter(Tickets, Len(Title) > 3)', small, { scope, clientRowLimit: 10 }).diagnostics[0]!.severity).toBe('error')
  })

  it('explain() describes server and browser parts', () => {
    const text = explain(analyze('="n=" & CountRows(Filter(Tickets, Status = "open" && !IsBlank(Due)))', SCHEMA, { scope }))
    expect(text).toContain('read Tickets')
    expect(text).toContain('where Status = "open" and not (Due is blank)')
    expect(text).toContain('count the rows')
    expect(text).toContain('Browser: =("n=" & __q0)')
    expect(explain(analyze('=Filter(Tickets, Len(Title) > 3)', SCHEMA, { scope }))).toContain('Error:')
  })
})

describe('known deviation: number-like text in a text sort', () => {
  it('the engine sorts two number-like texts as numbers; the plan sorts all text as text', () => {
    // documented in docs/dev/query-v2.md (Sorting): text columns holding numbers should be number columns
    const schema: SchemaInfo = { tables: { T: { columns: { id: 'text', createdOn: 'datetime', Code: 'text' } } } }
    const rows: FxRecord[] = ['9', '10'].map((c, i) => ({ __id: 'r' + i, id: 'r' + i, createdOn: new Date(i), Code: c }))
    const s = { resolve: (n: string) => (n === 'T' ? rows : undefined) }
    const engine = createEngine()
    const want = engine.evaluate('=Concat(Sort(T, Code), Code, ",")', s)
    const r = analyze('=Sort(T, Code)', schema, { scope: s })
    const got = executePlan(r.plan!, rows, schema.tables.T!).rows.map((x) => x.Code).join(',')
    expect(want).toEqual({ ok: true, value: '9,10' })
    expect(got).toBe('10,9')
  })
})

describe('keyset cursors', () => {
  const t = SCHEMA.tables.Tickets!
  const p: QueryPlan = { version: 2, table: 'Tickets', sort: [{ col: 'Status', dir: 'asc' }, { col: 'Due', dir: 'desc' }] }

  it('round-trips and is tied to the sort', () => {
    const row = tables.Tickets![5]!
    const c = encodeCursor(p, row, t)
    expect(c.startsWith('c2.')).toBe(true)
    const d = decodeCursor(p, c)
    expect(d.id).toBe(row.id)
    expect(d.createdOn).toBe((row.createdOn as Date).toISOString())
    expect(() => decodeCursor({ ...p, sort: [{ col: 'Status', dir: 'desc' }] }, c)).toThrow(CursorError)
    expect(() => decodeCursor(p, 'c2.bm90LWpzb24')).toThrow(CursorError)
    expect(() => decodeCursor(p, 'x')).toThrow(CursorError)
  })

  it('handles unicode text keys', () => {
    const row: FxRecord = { id: 'u', createdOn: new Date(0), Status: 'Ünïcode ✓', Due: null }
    expect(decodeCursor(p, encodeCursor(p, row, t)).keys).toEqual(['ünïcode ✓', null])
  })

  it('pages stay stable when rows are inserted before the cursor', () => {
    const rows = [...tables.Tickets!]
    const page1 = executePlan({ ...p, page: { size: 10 } }, rows, t)
    expect(page1.rows).toHaveLength(10)
    // a new row that sorts first must not shift the second page
    const inserted = [{ ...rows[0]!, __id: 'new', id: 'new', Status: '', Due: null, createdOn: new Date(0) }, ...rows]
    const page2 = executePlan({ ...p, page: { size: 10, cursor: page1.nextCursor! } }, inserted, t)
    const all = executePlan(p, rows, t).rows
    expect(page2.rows.map((r) => r.id)).toEqual(all.slice(10, 20).map((r) => r.id))
  })

  it('the last page has no next cursor; size 0 is count only', () => {
    const all = executePlan({ ...p, count: true }, tables.Tickets!, t)
    const last = executePlan({ ...p, count: true, page: { size: 100 } }, tables.Tickets!, t)
    expect(last.nextCursor).toBeNull()
    expect(last.count).toBe(all.rows.length)
    const none = executePlan({ ...p, count: true, page: { size: 0 } }, tables.Tickets!, t)
    expect(none.rows).toEqual([])
    expect(none.count).toBe(all.rows.length)
  })

  it('binding helpers turn results into formula values', () => {
    const r = plan('=First(Sort(Tickets, Priority)).Title')
    const q = r.plans[0]!
    const v = bindResult(q, executePlan(q.plan, tables.Tickets!, t))
    const engine = createEngine()
    expect(engine.evaluate(r.residual!.formula, residualScope({ [q.id]: v }, scope))).toEqual(engine.evaluate('=First(Sort(Tickets, Priority)).Title', scope))
  })
})
