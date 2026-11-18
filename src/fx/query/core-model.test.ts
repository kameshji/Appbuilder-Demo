/**
 * Core data model in formulas (P0 package N): lookup paths (createdBy.FullName) through the translator, the reference
 * executor and the engine agree (parity); the system macros (Comments, Activities, MyTasks, Mentions, Setting, Convert)
 * expand to plans and evaluate the same without delegation.
 */
import { describe, expect, it } from 'vitest'
import type { FxRecord, FxScope } from '../../contracts.ts'
import type { SchemaInfo } from '../../platform/query.ts'
import { createEngine } from '../engine.ts'
import { analyze } from './translate.ts'
import { bindResult, residualScope } from './explain.ts'
import { executePlan } from './reference.ts'
import { checkPlan } from './validate.ts'

const users: FxRecord[] = [
  { id: 'user_ada', __id: 'user_ada', FullName: 'Ada Lovelace', Email: 'ada@x', createdOn: new Date(2026, 0, 1) },
  { id: 'user_bo', __id: 'user_bo', FullName: 'Bo Brown', Email: 'bo@x', createdOn: new Date(2026, 0, 2) },
]
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`
const orders: FxRecord[] = Array.from({ length: 8 }, (_, i) => ({
  id: id(i + 1), __id: id(i + 1), Title: `Order ${i + 1}`, Amount: (i + 1) * 10,
  createdBy: i % 3 === 0 ? 'user_ada' : i % 3 === 1 ? 'user_bo' : null,
  owner: i === 7 ? 'user_gone' : 'user_ada', createdOn: new Date(2026, 1, i + 1),
}))
const comments: FxRecord[] = [
  { id: id(101), __id: id(101), Body: 'first', regardingId: id(1), createdOn: new Date(2026, 2, 1) },
  { id: id(102), __id: id(102), Body: 'second', regardingId: id(1), createdOn: new Date(2026, 2, 2) },
  { id: id(103), __id: id(103), Body: 'other', regardingId: id(2), createdOn: new Date(2026, 2, 3) },
]
const activities: FxRecord[] = [
  { id: id(201), __id: id(201), Type: 'Task', Subject: 'Call', Status: 'Open', AssignedTo: 'user_ada', DueOn: new Date(2026, 3, 2), regardingId: id(1), createdOn: new Date(2026, 3, 1) },
  { id: id(202), __id: id(202), Type: 'Task', Subject: 'Done one', Status: 'Done', AssignedTo: 'user_ada', DueOn: new Date(2026, 3, 1), regardingId: null, createdOn: new Date(2026, 3, 1) },
  { id: id(203), __id: id(203), Type: 'Task', Subject: 'Early', Status: 'Open', AssignedTo: 'user_ada', DueOn: new Date(2026, 3, 1), regardingId: null, createdOn: new Date(2026, 3, 2) },
  { id: id(204), __id: id(204), Type: 'Task', Subject: 'Not mine', Status: 'Open', AssignedTo: 'user_bo', DueOn: null, regardingId: null, createdOn: new Date(2026, 3, 3) },
]
const settings: FxRecord[] = [{ id: id(301), __id: id(301), Key: 'FinancialYearStartMonth', Value: '4', createdOn: new Date(2026, 0, 1) }]
const units: FxRecord[] = [
  { id: id(401), __id: id(401), Code: 'KG', Dimension: 'mass', Factor: 1, createdOn: new Date(2026, 0, 1) },
  { id: id(402), __id: id(402), Code: 'G', Dimension: 'mass', Factor: 0.001, createdOn: new Date(2026, 0, 2) },
  { id: id(403), __id: id(403), Code: 'M', Dimension: 'length', Factor: 1, createdOn: new Date(2026, 0, 3) },
]
const sys = { id: 'text', createdOn: 'datetime', modifiedOn: 'datetime', createdBy: 'text', owner: 'text' } as const
const schema: SchemaInfo = {
  tables: {
    Users: { columns: { ...sys, FullName: 'text', Email: 'text' } },
    Orders: { columns: { ...sys, Title: 'text', Amount: 'number' }, lookups: { createdBy: 'Users', owner: 'Users' } },
    Comments: { columns: { ...sys, Body: 'text', regardingId: 'text' } },
    Activities: { columns: { ...sys, Type: 'text', Subject: 'text', Status: 'text', AssignedTo: 'text', DueOn: 'datetime', regardingId: 'text' }, lookups: { AssignedTo: 'Users' } },
    Settings: { columns: { ...sys, Key: 'text', Value: 'text' } },
    UnitsOfMeasure: { columns: { ...sys, Code: 'text', Dimension: 'text', Factor: 'number' } },
  },
}
const data: Record<string, FxRecord[]> = { Users: users, Orders: orders, Comments: comments, Activities: activities, Settings: settings, UnitsOfMeasure: units }
const all = [...users, ...orders, ...comments, ...activities]
const scope: FxScope = {
  resolve: (n) => (n in data ? data[n] : n === 'User()' ? { FullName: 'Ada Lovelace', Email: 'ada@x', Id: 'user_ada' } : n === 'TheOrder' ? orders[0] : undefined),
  recordById: (x) => all.find((r) => r.__id === x) ?? (/^user_/.test(x) ? null : undefined),
}
const engine = createEngine()
const related = { rows: (t: string) => data[t], schema: (t: string) => schema.tables[t] }

/** run the plans of a formula with the reference executor, then the residual: the delegated answer */
function delegated(formula: string): unknown {
  const a = analyze(formula, schema, { scope, engine })
  expect(a.diagnostics.filter((d) => d.severity === 'error'), formula).toEqual([])
  const bindings: Record<string, unknown> = {}
  for (const q of a.plans) {
    const checked = checkPlan(q.plan, schema.tables[q.plan.table]!, q.plan.table, { related: (t, col) => (schema.tables[q.plan.table]!.lookups?.[col] === t ? schema.tables[t] : undefined) })
    const res = executePlan(checked.plan, data[q.plan.table]!, schema.tables[q.plan.table]!, { related })
    bindings[q.id] = bindResult(q, res as never)
  }
  if (!a.residual) return bindings[a.plans[0]!.id]
  const r = engine.evaluate(a.residual.formula, residualScope(bindings as never, scope))
  if (!r.ok) throw new Error(r.error.message)
  return r.value
}
function local(formula: string): unknown {
  const r = engine.evaluate(formula, scope)
  if (!r.ok) throw new Error(r.error.message)
  return r.value
}
const titles = (v: unknown) => (v as FxRecord[]).map((r) => r.Title ?? r.Body ?? r.Subject)

describe('lookup paths (createdBy.FullName)', () => {
  it('translate to a via condition and match the engine (parity)', () => {
    const cases = [
      '=Filter(Orders, createdBy.FullName = "Ada Lovelace")',
      '=Filter(Orders, createdBy.FullName <> "Ada Lovelace")',
      '=Filter(Orders, ThisRecord.createdBy.FullName = "bo brown")',
      '=Filter(Orders, owner.FullName = "Ada Lovelace" && Amount > 20)',
      '=Filter(Orders, "Bo Brown" = createdBy.FullName || Amount = 80)',
      '=CountRows(Filter(Orders, createdBy.Email = ""))',
      '=Filter(Orders, owner.FullName < "B")',
    ]
    for (const f of cases) {
      const a = analyze(f, schema, { scope, engine })
      expect(JSON.stringify(a.plans[0]?.plan.filter), f).toContain('"via"')
      const want = local(f)
      const got = delegated(f)
      expect(Array.isArray(want) ? titles(got) : got, f).toEqual(Array.isArray(want) ? titles(want) : want)
    }
  })
  it('the engine reads fields of the row a lookup id points at; a missing row reads blank', () => {
    expect(local('=First(Orders).createdBy.FullName')).toBe('Ada Lovelace')
    expect(local('=Last(Orders).owner.FullName')).toBeNull()
    expect(local('=LookUp(Orders, Amount = 20).createdBy.Email')).toBe('bo@x')
  })
  it('the validator refuses a path through a column that is not a lookup to that table', () => {
    expect(() => checkPlan({ version: 2, table: 'Orders', filter: { via: { col: 'Title', table: 'Users', where: { const: true } } } }, schema.tables.Orders!, 'Orders', { related: (t, col) => (schema.tables.Orders!.lookups?.[col] === t ? schema.tables[t] : undefined) })).toThrow(/does not point/)
  })
})

describe('core data model macros', () => {
  it('Comments / Activities of a record delegate as Filter by regardingId, newest first', () => {
    const a = analyze('=Comments(TheOrder)', schema, { scope, engine })
    expect(a.plans[0]?.plan).toMatchObject({ table: 'Comments', filter: { col: 'regardingId', op: 'eq', value: id(1) }, sort: [{ col: 'createdOn', dir: 'desc' }] })
    expect(titles(delegated('=Comments(TheOrder)'))).toEqual(['second', 'first'])
    expect(titles(local('=Comments(TheOrder)'))).toEqual(['second', 'first'])
    expect(delegated('=CountRows(Comments(TheOrder))')).toBe(2)
    expect(titles(local('=Activities(TheOrder)'))).toEqual(['Call'])
  })
  it('MyTasks: open tasks assigned to me by due date; Mentions; Setting; Convert', () => {
    expect(titles(delegated('=MyTasks()'))).toEqual(['Early', 'Call'])
    expect(titles(local('=MyTasks()'))).toEqual(['Early', 'Call'])
    expect(delegated('=Setting("FinancialYearStartMonth")')).toBe('4')
    expect(local('=Setting("Missing")')).toBeNull()
    expect(local('=Convert(2.5, "KG", "G")')).toBeCloseTo(2500)
    expect(delegated('=Convert(2500, "G", "KG")')).toBeCloseTo(2.5)
    expect(local('=Convert(1, "KG", "M")')).toBeNull()
  })
  it('RecordId and the write functions need a host', () => {
    expect(local('=RecordId(TheOrder)')).toBe(id(1))
    const r = engine.evaluate('=AddComment(TheOrder, "hi")', scope)
    expect(r.ok).toBe(false)
    const calls: unknown[] = []
    const host = { collab: (action: string, args: unknown) => { calls.push([action, args]); return action === 'nextNumber' ? 'INV-0001' : true } } as never
    expect(engine.evaluate('=AddComment(TheOrder, "hi"); Follow(TheOrder); Tag(TheOrder, "vip"); NextNumber("Invoices")', scope, host)).toEqual({ ok: true, value: 'INV-0001' })
    expect(calls).toEqual([
      ['addComment', { record: id(1), text: 'hi' }], ['follow', { record: id(1) }], ['tag', { record: id(1), tag: 'vip' }], ['nextNumber', { name: 'Invoices' }],
    ])
  })
})
