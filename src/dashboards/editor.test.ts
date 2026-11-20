/**
 * The tile query editor's logic (src/dashboards/editor.ts): round trips (template tiles and unknown fields survive),
 * the simple condition and calculation builders (exact or left alone), every operation, defaults per column type,
 * validation messages, summaries, the upsert into the definition, and a preview through the viewer's own path.
 */
import { describe, expect, it } from 'vitest'
import type { FxRecord } from '../contracts.ts'
import type { ConditionV2, QueryPlan, TableSchemaInfo } from '../platform/query.ts'
import { executePlan } from '../fx/query/reference.ts'
import { checkPlan } from '../fx/query/validate.ts'
import { DEFAULT_CALENDAR } from './dates.ts'
import type { QuerySpec } from './measures.ts'
import { DOWNTIME, PRESETS, PRODUCTION_LOG, SHAPE, WORK_ORDERS, productionOverview } from './manufacturing.ts'
import type { DashboardDef, TileDef } from './types.ts'
import { MAX_TILES } from './types.ts'
import { assemble, buildBatch } from './viewer.ts'
import type { EditorColumn, FilterRow } from './editor.ts'
import {
  addComputed, addMeasure, applyTile, availableSeries, blocking, bucketUnitsFor, calcOfSimple, conditionOfSimple, defaultMeasure, describeCalc,
  describeCondition, describeMeasure, describeTile, editorColumns, effectiveSeries, formatChoiceOf, formatOfChoice, literalOf, measureFnsFor,
  newFilterRow, newTile, newTileId, nextLayout, previewDef, removeValue, renameValue, resetSeries, setBucket, setCompare, setComputedExpr, setDateColumn,
  setFilter, setGroupBy, setKind, setMeasureColumn, setMeasureFilter, setMeasureFn, setSeriesFormat, setSort, setTable, setTarget, setTop, setValueLabel,
  setVisual, simpleCalcOf, simpleFilterOf, toggleRunning, toggleSeries, uniqueId, usersOf, validateTile,
} from './editor.ts'

const TZ = 'Asia/Kolkata'
const sys = [{ name: 'id', displayName: 'Id', type: 'text' as const }, { name: 'createdOn', displayName: 'Created on', type: 'datetime' as const }]
const colsOf = (name: string): EditorColumn[] => editorColumns([...sys, ...(SHAPE[name] ?? []).map((c) => ({ name: c.name!, displayName: c.displayName, type: c.type!, choices: c.choices }))])
const ORDERS = editorColumns([
  ...sys,
  { name: 'Region', displayName: 'Region', type: 'choice', choices: ['North', 'South'] },
  { name: 'Amount', displayName: 'Amount', type: 'currency' },
  { name: 'Qty', displayName: 'Quantity', type: 'number' },
  { name: 'Paid', displayName: 'Paid', type: 'boolean' },
  { name: 'OrderDate', displayName: 'Order date', type: 'date' },
  { name: 'Photo', displayName: 'Photo', type: 'image' },
])
const GOALS = editorColumns([...sys, { name: 'Region', type: 'text' }, { name: 'Goal', type: 'number' }, { name: 'Month', type: 'date' }])
const tables: Record<string, EditorColumn[]> = { Orders: ORDERS, Goals: GOALS, [PRODUCTION_LOG]: colsOf(PRODUCTION_LOG), [DOWNTIME]: colsOf(DOWNTIME), [WORK_ORDERS]: colsOf(WORK_ORDERS) }
const columnsOf = (t: string) => tables[t] ?? null
const col = (name: string) => ORDERS.find((c) => c.name === name)!
const empty: DashboardDef = { version: 1, title: 'D', range: 'thisMonth', tiles: [] }
const base = (): TileDef => setTable(newTile(empty), 'Orders', ORDERS)

describe('columns and defaults', () => {
  it('column kinds from column types', () => {
    expect(Object.fromEntries(ORDERS.map((c) => [c.name, c.kind]))).toEqual({ id: 'text', createdOn: 'datetime', Region: 'text', Amount: 'number', Qty: 'number', Paid: 'boolean', OrderDate: 'date', Photo: 'other' })
    expect(col('Region').choices).toEqual(['North', 'South'])
    expect(col('Region').label).toBe('Region')
  })
  it('functions per column kind, bucket units per date kind', () => {
    expect(measureFnsFor('number')).toEqual(['sum', 'avg', 'min', 'max', 'count', 'countDistinct'])
    expect(measureFnsFor('text')).toEqual(['count', 'countDistinct'])
    expect(measureFnsFor('other')).toEqual(['count'])
    expect(measureFnsFor(undefined)).toEqual(['count'])
    expect(bucketUnitsFor('datetime')).toContain('hour')
    expect(bucketUnitsFor('date')).not.toContain('hour')
  })
  it('default measure per column type', () => {
    expect(defaultMeasure(col('Amount'), [])).toEqual({ id: 'Amount', label: 'Amount', fn: 'sum', col: 'Amount' })
    expect(defaultMeasure(col('Region'), [])).toEqual({ id: 'RegionCount', label: 'Different Region', fn: 'countDistinct', col: 'Region' })
    expect(defaultMeasure(undefined, ['Rows'])).toEqual({ id: 'Rows2', label: 'Rows', fn: 'count' })
  })
  it('unique, valid measure names', () => {
    expect(uniqueId('Good qty!', [])).toBe('Goodqty')
    expect(uniqueId('9lives', [])).toBe('M9lives')
    expect(uniqueId('', [])).toBe('M')
    expect(uniqueId('Good', ['good', 'Good2'])).toBe('Good3')
    expect(uniqueId('x'.repeat(60), []).length).toBeLessThanOrEqual(41)
  })
  it('a new tile: count of rows, the first date column, placed below the others', () => {
    const def: DashboardDef = { ...empty, tiles: [{ id: 't1', title: 'A', kind: 'text', layout: { x: 0, y: 0, w: 6, h: 2 } }, { id: 't3', title: 'B', kind: 'text', layout: { x: 6, y: 1, w: 6, h: 4 } }] }
    expect(newTileId(def)).toBe('t4')
    expect(nextLayout(def)).toEqual({ x: 0, y: 5, w: 4, h: 3 })
    const t = newTile(def, 'Orders', ORDERS)
    expect(t).toMatchObject({ id: 't4', kind: 'bar', layout: { x: 0, y: 5, w: 4, h: 3 } })
    expect(t.query).toEqual({ table: 'Orders', measures: [{ id: 'Rows', label: 'Rows', fn: 'count' }], dateColumn: { col: 'createdOn', kind: 'datetime' } })
  })
  it('changing the table resets what needed the old columns and keeps plain counts', () => {
    let t = addMeasure(base(), col('Amount'))
    t = setGroupBy(t, ['Region'])
    t = setVisual(t, { category: 'Region', format: { style: 'currency' } })
    const u = setTable(t, 'Goals', GOALS)
    expect(u.query).toEqual({ table: 'Goals', measures: [{ id: 'Rows', label: 'Rows', fn: 'count' }], dateColumn: { col: 'createdOn', kind: 'datetime' } })
    expect(u.visual).toEqual({ format: { style: 'currency' } })
    expect(setTable(t, 'orders', ORDERS)).toBe(t)
  })
})

describe('round trips', () => {
  const def = productionOverview()
  it('every template tile goes through applyTile unchanged', () => {
    let d = def
    for (const t of def.tiles) d = applyTile(d, JSON.parse(JSON.stringify(t)), t)
    expect(d.tiles).toEqual(def.tiles)
  })
  it('no-op edits keep every field of every template tile', () => {
    for (const t of def.tiles) {
      if (!t.query) continue
      let u = setTable(t, t.query.table, colsOf(t.query.table === PRODUCTION_LOG ? PRODUCTION_LOG : DOWNTIME))
      u = setGroupBy(u, t.query.groupBy ?? [])
      if (t.query.groupBy === undefined) expect(u.query!.groupBy).toBeUndefined()
      u = setFilter(u, t.query.filter)
      u = setSort(u, t.query.sort)
      u = setCompare(u, t.query.compare)
      for (const m of t.query.measures) u = setValueLabel(renameValue(u, m.id, m.id), m.id, m.label ?? '')
      expect(u, t.id).toEqual(t)
    }
  })
  it('fields the editor does not know survive every operation', () => {
    const t = {
      id: 'x', title: 'X', kind: 'bar', layout: { x: 0, y: 0, w: 4, h: 3 }, futureTile: 1,
      query: {
        table: 'Orders', futureQuery: { a: 1 }, groupBy: ['Region'],
        measures: [{ id: 'Amt', fn: 'sum', col: 'Amount', futureMeasure: true }, { id: 'Calc', fn: 'sum', expr: { fn: 'mul', args: [{ col: 'Qty' }, 2] } }],
        computed: [{ id: 'Deep', expr: { fn: 'mul', args: [{ fn: 'div', args: [{ m: 'Amt' }, { m: 'Calc' }] }, 100] }, futureComputed: 'y' }],
        filter: { or: [{ col: 'Region', op: 'in', value: ['North', 'South'] }, { not: { col: 'Paid', op: 'eq', value: true } }] },
      },
      visual: { series: [{ key: 'Amt', color: '#ff0000', axis: 'right' }], futureVisual: [1, 2] },
    } as unknown as TileDef
    let u = addMeasure(t, col('Qty'))
    u = addComputed(u)
    u = setBucket(u, { col: 'OrderDate', unit: 'month' })
    u = setSort(u, { by: 'Amt', dir: 'desc' })
    u = setTop(u, { n: 5 })
    u = setCompare(u, 'previousPeriod')
    u = toggleRunning(u, 'Amt', true)
    u = setDateColumn(u, col('OrderDate'))
    u = setSeriesFormat(u, 'Amt', { style: 'currency' })
    u = setKind(u, 'line')
    u = renameValue(u, 'Qty', 'Units')
    u = removeValue(u, 'Units')
    u = applyTile({ ...empty, tiles: [t] }, u, t).tiles[0]!
    const a = u as unknown as Record<string, any>
    expect(a.futureTile).toBe(1)
    expect(a.query.futureQuery).toEqual({ a: 1 })
    expect(a.query.measures[0]).toEqual({ id: 'Amt', fn: 'sum', col: 'Amount', futureMeasure: true })
    expect(a.query.measures[1]).toEqual({ id: 'Calc', fn: 'sum', expr: { fn: 'mul', args: [{ col: 'Qty' }, 2] } })
    expect(a.query.computed[0]).toEqual(t.query!.computed![0])
    expect(a.query.filter).toEqual(t.query!.filter)
    expect(a.visual.futureVisual).toEqual([1, 2])
    expect(a.visual.series[0]).toEqual({ key: 'Amt', color: '#ff0000', axis: 'right', format: { style: 'currency' } })
  })
})

describe('the simple condition builder', () => {
  const round = (c: ConditionV2) => { const s = simpleFilterOf(c, ORDERS, TZ); expect(s, JSON.stringify(c)).not.toBeNull(); expect(conditionOfSimple(s!, TZ)).toEqual(c); return s! }
  it('round-trips every kind of row', () => {
    expect(round({ col: 'Region', op: 'eq', value: 'North' }).rows).toEqual([{ col: 'Region', kind: 'text', op: 'eq', value: 'North' }])
    round({ col: 'Region', op: 'contains', value: 'or', exact: true })
    round({ col: 'Amount', op: 'ge', value: 100 })
    round({ col: 'Paid', op: 'eq', value: false })
    round({ col: 'OrderDate', op: 'lt', value: { $date: '2026-11-01' } })
    const s = round({ col: 'createdOn', op: 'gt', value: { $datetime: '2026-11-18T04:00:00.000Z' } })
    expect(s.rows[0]!.value).toBe('2026-11-18T09:30')
    round({ col: 'Region', op: 'isNull' })
    expect(round({ not: { col: 'Region', op: 'isNull' } }).rows[0]!.op).toBe('notNull')
    expect(round({ and: [{ col: 'Region', op: 'eq', value: 'North' }, { col: 'Amount', op: 'gt', value: 5 }] }).join).toBe('and')
    expect(round({ or: [{ col: 'Region', op: 'eq', value: 'North' }, { col: 'Region', op: 'eq', value: 'South' }] }).join).toBe('or')
    expect(simpleFilterOf(undefined, ORDERS, TZ)).toEqual({ join: 'and', rows: [] })
    expect(conditionOfSimple({ join: 'and', rows: [] }, TZ)).toBeUndefined()
  })
  it('leaves alone what it cannot edit exactly', () => {
    const advanced: ConditionV2[] = [
      { col: 'Region', op: 'in', value: ['North'] },
      { col: 'OrderDate', op: 'cmpCol', cmp: 'le', other: 'createdOn' },
      { not: { col: 'Region', op: 'eq', value: 'x' } },
      { and: [{ col: 'Region', op: 'eq', value: 'x' }] },
      { and: [{ col: 'Region', op: 'eq', value: 'x' }, { or: [{ col: 'Qty', op: 'gt', value: 1 }, { col: 'Qty', op: 'lt', value: 0 }] }] },
      { col: 'createdOn', op: 'gt', value: { $datetime: '2026-11-18T04:00:30.000Z' } },
      { op: 'cmpExpr', cmp: 'gt', left: { col: 'Qty' }, right: 3 },
      { const: true },
      { via: { col: 'owner', table: 'Users', where: { col: 'FullName', op: 'eq', value: 'Asha' } } },
    ]
    for (const c of advanced) expect(simpleFilterOf(c, ORDERS, TZ), JSON.stringify(c)).toBeNull()
    // the template's own filters: MTTR's is simple, schedule adherence's is not
    expect(simpleFilterOf(PRESETS[4]!.query.filter, colsOf(DOWNTIME), TZ)!.rows).toEqual([{ col: 'Reason', kind: 'text', op: 'eq', value: 'breakdown' }])
    expect(simpleFilterOf(PRESETS[5]!.query.filter, colsOf(WORK_ORDERS), TZ)).toBeNull()
  })
  it('values that do not fit the column are refused in words', () => {
    const r = (kind: FilterRow['kind'], value: string): FilterRow => ({ col: 'C', kind, op: 'eq', value })
    expect(() => literalOf(r('number', 'abc'), TZ)).toThrow(/not a number/)
    expect(() => literalOf(r('number', ''), TZ)).toThrow(/not a number/)
    expect(() => literalOf(r('boolean', 'maybe'), TZ)).toThrow(/yes or no/)
    expect(() => literalOf(r('date', '1/2/2026'), TZ)).toThrow(/date/)
    expect(() => literalOf(r('datetime', '2026-01-02'), TZ)).toThrow(/date and time/)
    expect(literalOf(r('boolean', 'Yes'), TZ)).toBe(true)
    expect(literalOf(r('number', ' 12.5 '), TZ)).toBe(12.5)
    expect(literalOf(r('text', ' a '), TZ)).toBe(' a ')
  })
  it('a fresh row fits its column', () => {
    expect(newFilterRow(col('Region'))).toEqual({ col: 'Region', kind: 'text', op: 'eq', value: 'North' })
    expect(newFilterRow(col('Paid'))).toMatchObject({ op: 'eq', value: 'true' })
    expect(newFilterRow(col('Photo'))).toMatchObject({ op: 'notNull' })
  })
  it('conditions in words', () => {
    const label = (c: string) => ORDERS.find((x) => x.name === c)?.label ?? c
    expect(describeCondition({ and: [{ col: 'Qty', op: 'gt', value: 3 }, { or: [{ col: 'Region', op: 'eq', value: 'North' }, { col: 'Region', op: 'isNull' }] }] }, label)).toBe('Quantity is more than 3 and (Region is "North" or Region is blank)')
    expect(describeCondition({ col: 'OrderDate', op: 'lt', value: { $date: '2026-11-01' } }, label)).toBe('Order date is before 2026-11-01')
    expect(describeCondition({ col: 'createdOn', op: 'ge', value: { $datetime: '2026-11-18T04:00:00.000Z' } }, label)).toBe('Created on is on or after 2026-11-18 04:00 UTC')
    expect(describeCondition(PRESETS[5]!.query.measures[1]!.filter)).toBe('Status is "done" and CompletedOn is at most DueDate')
    expect(describeCondition({ not: { col: 'Status', op: 'eq', value: 'cancelled' } })).toBe('not Status is "cancelled"')
    expect(describeCondition({ col: 'Region', op: 'in', value: ['North', 'South'] })).toBe('Region is one of "North", "South"')
    expect(describeCondition({ op: 'cmpExpr', cmp: 'gt', left: { fn: 'mul', args: [{ col: 'Qty' }, 2] }, right: 10 })).toBe('Qty × 2 is more than 10')
    expect(describeCondition(undefined)).toBe('every row')
  })
})

describe('measures', () => {
  it('add, change function and column, condition, label', () => {
    let t = addMeasure(base(), col('Amount'))
    expect(t.query!.measures.map((m) => m.id)).toEqual(['Rows', 'Amount'])
    t = setMeasureFn(t, 'Amount', 'avg', ORDERS)
    expect(t.query!.measures[1]).toEqual({ id: 'Amount', label: 'Amount', fn: 'avg', col: 'Amount' })
    t = setMeasureFn(t, 'Amount', 'count', ORDERS)
    expect(t.query!.measures[1]).toEqual({ id: 'Amount', label: 'Amount', fn: 'count' })
    t = setMeasureFilter(t, 'Amount', { col: 'Paid', op: 'eq', value: true })
    t = setMeasureFn(t, 'Amount', 'sum', ORDERS)
    expect(t.query!.measures[1]).toEqual({ id: 'Amount', label: 'Amount', fn: 'sum', col: 'Amount' }) // first number column, condition dropped
    t = setMeasureColumn(t, 'Amount', 'Qty')
    t = setMeasureFn(t, 'Amount', 'countDistinct', ORDERS)
    expect(t.query!.measures[1]!.col).toBe('Qty')
    t = setMeasureColumn(t, 'Amount', 'Region')
    t = setMeasureFn(t, 'Amount', 'max', ORDERS)
    expect(t.query!.measures[1]!.col).toBe('Amount') // a text column cannot be maximised: first number column
    t = setValueLabel(t, 'Amount', 'Biggest')
    expect(t.query!.measures[1]!.label).toBe('Biggest')
    t = setValueLabel(t, 'Amount', '  ')
    expect(t.query!.measures[1]).not.toHaveProperty('label')
  })
  it('choosing a column replaces a row calculation', () => {
    const t = { ...base(), query: { table: 'Orders', measures: [{ id: 'X', fn: 'sum' as const, expr: { col: 'Qty' } }] } }
    expect(setMeasureColumn(t, 'X', 'Amount').query!.measures[0]).toEqual({ id: 'X', fn: 'sum', col: 'Amount' })
    expect(setMeasureFn(t, 'X', 'countDistinct', ORDERS).query!.measures[0]).toEqual({ id: 'X', fn: 'countDistinct', col: 'id' })
  })
  it('a new measure joins a stored series list; a label change follows into its series', () => {
    let t = setVisual(base(), { series: [{ key: 'Rows', label: 'Rows', color: 2 }] })
    t = addMeasure(t, col('Qty'))
    expect(t.visual!.series).toEqual([{ key: 'Rows', label: 'Rows', color: 2 }, { key: 'Qty', label: 'Quantity' }])
    t = setValueLabel(t, 'Rows', 'Orders')
    expect(t.visual!.series![0]).toEqual({ key: 'Rows', label: 'Orders', color: 2 })
  })
  it('rename follows every reference; bad or taken names are refused', () => {
    let t = addMeasure(base(), col('Amount'))
    t = addComputed(t)
    expect(t.query!.computed![0]).toEqual({ id: 'RowsPerAmount', label: 'Rows / Amount', expr: { fn: 'div', args: [{ m: 'Rows' }, { m: 'Amount' }] } })
    t = setCompare(setDateColumn(t, col('OrderDate')), 'previousPeriod')
    t = setSort(toggleRunning(t, 'Amount', true), { by: 'Amount', dir: 'desc' })
    t = setVisual(setKind(t, 'table'), { series: [{ key: 'Amount' }, { key: 'Amount__cmp' }, { key: 'Amount__run' }], rules: [{ measure: 'Amount', op: 'lt', value: 1, status: 'bad' }], kpi: { measure: 'Amount', spark: 'Amount' } })
    t = renameValue(t, 'Amount', 'Sales')
    expect(JSON.stringify(t)).not.toContain('"Amount__')
    expect(t.query!.measures[1]).toMatchObject({ id: 'Sales', col: 'Amount' })
    expect(t.query!.computed![0]!.expr).toEqual({ fn: 'div', args: [{ m: 'Rows' }, { m: 'Sales' }] })
    expect(t.query!.sort).toEqual({ by: 'Sales', dir: 'desc' })
    expect(t.query!.running).toEqual(['Sales'])
    expect(t.visual!.series!.map((s) => s.key)).toEqual(['Sales', 'Sales__cmp', 'Sales__run'])
    expect(t.visual!.rules![0]!.measure).toBe('Sales')
    expect(t.visual!.kpi).toEqual({ measure: 'Sales', spark: 'Sales' })
    expect(() => renameValue(t, 'Sales', '1x')).toThrow(/cannot be used/)
    expect(() => renameValue(t, 'Sales', 'rows')).toThrow(/already/)
    expect(renameValue(t, 'Sales', 'Sales')).toBe(t)
  })
  it('remove takes its series, sort, running total, KPI and rules with it', () => {
    let t = addMeasure(base(), col('Amount'))
    t = setCompare(setDateColumn(t, col('OrderDate')), 'previousPeriod')
    t = setSort(toggleRunning(t, 'Amount', true), { by: 'Amount', dir: 'desc' })
    t = setVisual(t, { series: [{ key: 'Rows' }, { key: 'Amount' }, { key: 'Amount__cmp' }], rules: [{ measure: 'Amount', op: 'lt', value: 1, status: 'bad' }], kpi: { measure: 'Amount' } })
    t = removeValue(t, 'Amount')
    expect(t.query).toEqual({ table: 'Orders', measures: [{ id: 'Rows', label: 'Rows', fn: 'count' }], dateColumn: { col: 'OrderDate', kind: 'date' }, compare: 'previousPeriod' })
    expect(t.visual).toEqual({ series: [{ key: 'Rows' }] })
  })
  it('which computed measures read a measure', () => {
    expect(usersOf(PRESETS[0]!.query as QuerySpec, 'Run')).toEqual(['Availability', 'Performance', 'OEE'])
    expect(usersOf(PRESETS[0]!.query as QuerySpec, 'Nothing')).toEqual([])
  })
  it('measures in words', () => {
    expect(describeMeasure({ id: 'a', fn: 'sum', col: 'Amount' })).toBe('Sum of Amount')
    expect(describeMeasure({ id: 'a', fn: 'avg', expr: { fn: 'div', args: [{ fn: 'mul', args: [{ col: 'IdealCycleSec' }, { fn: 'add', args: [{ col: 'Good' }, { col: 'Scrap' }] }] }, 60] } })).toBe('Average of the calculation (IdealCycleSec × (Good + Scrap)) ÷ 60')
    expect(describeMeasure({ id: 'a', fn: 'count' })).toBe('Count of rows')
    expect(describeMeasure({ id: 'a', fn: 'count', filter: { col: 'Reason', op: 'eq', value: 'breakdown' } })).toBe('Count of rows where Reason is "breakdown"')
    expect(describeMeasure({ id: 'a', fn: 'countDistinct', col: 'Machine' }, (c) => c.toUpperCase())).toBe('Count of different MACHINE')
  })
})

describe('computed measures', () => {
  it('the simple form round-trips; nested expressions are left alone', () => {
    for (const e of [{ m: 'A' }, 3, { fn: 'div' as const, args: [{ m: 'A' }, { m: 'B' }] as [{ m: string }, { m: string }] }, { fn: 'mul' as const, args: [{ m: 'A' }, 100] as [{ m: string }, number] }]) {
      const s = simpleCalcOf(e)
      expect(s).not.toBeNull()
      expect(calcOfSimple(s!)).toEqual(e)
    }
    expect(simpleCalcOf(PRESETS[0]!.query.computed![3]!.expr)).toBeNull()
    expect(calcOfSimple({ a: { m: 'A' }, op: 'add' })).toEqual({ m: 'A' })
  })
  it('set an expression; describe it', () => {
    let t = addComputed(base())
    expect(t.query!.computed![0]).toEqual({ id: 'Calc', label: 'Calculation', expr: { m: 'Rows' } })
    t = setComputedExpr(t, 'Calc', { fn: 'mul', args: [{ m: 'Rows' }, 2] })
    expect(t.query!.computed![0]!.expr).toEqual({ fn: 'mul', args: [{ m: 'Rows' }, 2] })
    expect(describeCalc(PRESETS[0]!.query.computed![3]!.expr)).toBe('((Run ÷ Planned) × (IdealMin ÷ Run)) × (Good ÷ Total)')
    expect(describeCalc({ fn: 'sub', args: [{ m: 'a' }, 1] }, (x) => x.toUpperCase())).toBe('A − 1')
  })
})

describe('grouping, dates, sort, top, comparison, running totals, target', () => {
  it('removing a group column resets a category and a sort that used it', () => {
    let t = setGroupBy(base(), ['Region', 'Paid'])
    t = setSort(setVisual(t, { category: 'Paid', row: 'Region' }), { by: 'Paid', dir: 'asc' })
    t = setGroupBy(t, ['Region'])
    expect(t.visual).toEqual({ row: 'Region' })
    expect(t.query!.sort).toBeUndefined()
    t = setGroupBy(t, [])
    expect(t.query!.groupBy).toBeUndefined()
    expect(t.visual).toBeUndefined()
  })
  it('removing the date grouping resets what pointed at it', () => {
    let t = setBucket(base(), { col: 'OrderDate', unit: 'week' })
    t = setSort(setVisual(t, { category: '__bucket' }), { by: '__bucket', dir: 'desc' })
    expect(t.query!.bucket).toEqual({ col: 'OrderDate', unit: 'week' })
    t = setBucket(t, undefined)
    expect(t.query).not.toHaveProperty('bucket')
    expect(t.query).not.toHaveProperty('sort')
    expect(t.visual).toBeUndefined()
  })
  it('date column, top, running, target set and clear', () => {
    let t = setDateColumn(base(), col('OrderDate'))
    expect(t.query!.dateColumn).toEqual({ col: 'OrderDate', kind: 'date' })
    t = setDateColumn(t, col('Region'))
    expect(t.query).not.toHaveProperty('dateColumn')
    t = setTop(t, { n: 3, others: 'Others' })
    expect(t.query!.top).toEqual({ n: 3, others: 'Others' })
    t = setTop(t, undefined)
    expect(t.query).not.toHaveProperty('top')
    t = toggleRunning(toggleRunning(t, 'Rows', true), 'Rows', true)
    expect(t.query!.running).toEqual(['Rows'])
    t = toggleRunning(t, 'Rows', false)
    expect(t.query).not.toHaveProperty('running')
    t = setTarget(t, { table: 'Goals', valueCol: 'Goal', keyCol: 'Region' })
    expect(t.query!.target).toEqual({ table: 'Goals', valueCol: 'Goal', keyCol: 'Region' })
    expect(setTarget(t, undefined).query).not.toHaveProperty('target')
  })
  it('turning the comparison off removes its series and the KPI base', () => {
    let t = setCompare(setDateColumn(base(), col('OrderDate')), 'samePeriodLastYear')
    t = setKind(t, 'kpi')
    expect(t.visual!.kpi).toEqual({ measure: 'Rows', base: 'compare', higherIsBetter: true })
    t = toggleSeries(t, 'Rows__cmp', true, 'Last year')
    expect(t.visual!.series).toEqual([{ key: 'Rows', label: 'Rows' }, { key: 'Rows__cmp', label: 'Last year', dashed: true }])
    t = setCompare(t, undefined)
    expect(t.visual).toEqual({ kpi: { measure: 'Rows', higherIsBetter: true }, series: [{ key: 'Rows', label: 'Rows' }] })
  })
})

describe('series and formats', () => {
  it('available fields follow the query', () => {
    let t = setCompare(setDateColumn(addMeasure(base(), col('Qty')), col('OrderDate')), 'previousPeriod')
    t = setTarget(toggleRunning(t, 'Qty', true), { table: 'Goals', valueCol: 'Goal' })
    expect(availableSeries(t.query).map((s) => s.key)).toEqual(['Rows', 'Rows__cmp', 'Qty', 'Qty__cmp', 'Qty__run', '__target'])
    expect(availableSeries(t.query)[3]!.label).toBe('Quantity (previous period)')
  })
  it('toggling writes the default list first; reset removes it; formats live on the series', () => {
    let t = addMeasure(base(), col('Amount'))
    expect(effectiveSeries(t)).toEqual([{ key: 'Rows', label: 'Rows' }, { key: 'Amount', label: 'Amount' }])
    t = toggleSeries(t, 'Rows', false)
    expect(t.visual!.series).toEqual([{ key: 'Amount', label: 'Amount' }])
    expect(toggleSeries(t, 'Amount', true)).toBe(t)
    t = setSeriesFormat(t, 'Amount', { style: 'currency' })
    expect(t.visual!.series).toEqual([{ key: 'Amount', label: 'Amount', format: { style: 'currency' } }])
    t = setSeriesFormat(t, 'Amount', undefined)
    expect(t.visual!.series).toEqual([{ key: 'Amount', label: 'Amount' }])
    expect(resetSeries(t).visual).toBeUndefined()
  })
  it('format choices', () => {
    expect(formatChoiceOf(undefined)).toBe('auto')
    expect(formatChoiceOf({ style: 'percent', decimals: 1 })).toBe('percent')
    expect(formatChoiceOf({ style: 'number', compact: true })).toBe('compact')
    expect(formatChoiceOf({ decimals: 2 })).toBe('decimal')
    expect(formatOfChoice('percent')).toEqual({ style: 'percent', decimals: 1 })
    expect(formatOfChoice('auto')).toBeUndefined()
    const custom = { style: 'currency' as const, currency: 'USD', prefix: '~' }
    expect(formatOfChoice('currency', custom)).toBe(custom)
    expect(formatOfChoice('number', custom)).toEqual({ prefix: '~', style: 'number', decimals: 0 })
    expect(formatOfChoice('auto', custom)).toEqual({ prefix: '~' })
  })
  it('a KPI picks the last value and the comparison or target as its base', () => {
    const t = setKind(setTarget(addComputed(addMeasure(base(), col('Qty'))), { table: 'Goals', valueCol: 'Goal' }), 'kpi')
    expect(t.visual!.kpi).toEqual({ measure: 'RowsPerQty', base: 'target', higherIsBetter: true })
    const kept = setKind(setVisual(base(), { kpi: { measure: 'Rows', higherIsBetter: false } }), 'kpi')
    expect(kept.visual!.kpi).toEqual({ measure: 'Rows', higherIsBetter: false })
    expect(setKind(base(), 'text').text).toBe('')
  })
})

describe('validation', () => {
  const msgs = (t: TileDef) => validateTile(t, columnsOf).map((i) => `${i.level}: ${i.message}`)
  it('the template tiles have no errors', () => {
    for (const t of productionOverview().tiles) expect(blocking(validateTile(t, columnsOf)), t.id).toEqual([])
    for (const p of PRESETS) expect(blocking(validateTile({ id: 'p', title: p.label, kind: 'kpi', layout: { x: 0, y: 0, w: 3, h: 3 }, query: p.query as QuerySpec }, columnsOf)), p.key).toEqual([])
  })
  it('problems in plain English', () => {
    expect(msgs({ ...base(), query: { table: '', measures: [] } })).toContain('error: Choose a table.')
    expect(msgs({ ...base(), query: { table: 'Nope', measures: [{ id: 'a', fn: 'count' }] } })).toContain('error: The table Nope does not exist or you cannot see it.')
    const q = (patch: Partial<QuerySpec>): TileDef => ({ ...base(), kind: 'table', query: { table: 'Orders', measures: [{ id: 'Rows', fn: 'count' }], ...patch } })
    expect(msgs(q({ measures: [] }))).toContain('error: Add at least one measure.')
    expect(msgs(q({ measures: [{ id: 'S', label: 'Sales', fn: 'sum', col: 'Region' }] }))).toContain('error: Sales: sum needs a number column; Region is not one.')
    expect(msgs(q({ measures: [{ id: 'S', fn: 'sum' }] }))).toContain('error: S: choose the column to sum.')
    expect(msgs(q({ measures: [{ id: 'S', fn: 'sum', col: 'Gone' }] }))).toContain('error: S: the column Gone is not in Orders.')
    expect(msgs(q({ measures: [{ id: 'S', fn: 'countDistinct', col: 'Photo' }] }))).toContain('error: S: Photo cannot be counted.')
    expect(msgs(q({ measures: [{ id: 'S', fn: 'count' }, { id: 's', fn: 'count' }] })).some((m) => /Two measures|called/.test(m))).toBe(false) // case differs: allowed by the builder
    expect(msgs(q({ measures: [{ id: 'S', fn: 'count' }, { id: 'S', fn: 'count' }] }))).toContain('error: Two measures are called S.')
    expect(msgs(q({ groupBy: ['Photo'] }))).toContain('error: Group by: Photo cannot be grouped.')
    expect(msgs(q({ groupBy: ['Region', 'region'] }))).toContain('error: Group by: a column is listed twice.')
    expect(msgs(q({ bucket: { col: 'Region', unit: 'month' } }))).toContain('error: Date grouping: Region is not a date column.')
    expect(msgs(q({ bucket: { col: 'OrderDate', unit: 'hour' } }))).toContain('error: Date grouping by hour needs a date-and-time column; Order date has dates only.')
    expect(msgs(q({ dateColumn: { col: 'OrderDate', kind: 'datetime' } }))).toContain('error: Date range column: Order date is a date column.')
    expect(msgs(q({ compare: 'previousPeriod' }))).toContain('error: A comparison needs the column the dashboard date range applies to.')
    expect(msgs(q({ top: { n: 0 } }))).toContain('error: Top: enter a whole number from 1 to 10000.')
    expect(msgs(q({ top: { n: 3, others: 'Rest' } }))).toContain('error: "Others" needs exactly one group column and no date bucket.')
    expect(msgs(q({ sort: { by: 'Nope', dir: 'asc' } }))).toContain('error: Sort by Nope: no such measure or group.')
    expect(msgs(q({ filter: { col: 'Gone', op: 'isNull' } }))).toContain('error: Filter: the column Gone is not in this table.')
    expect(msgs(q({ measures: [{ id: 'B', fn: 'count', filter: { col: 'Gone', op: 'isNull' } }] }))).toContain("error: B's condition: the column Gone is not in this table.")
    expect(msgs(q({ computed: [{ id: 'C', expr: { m: 'Nope' } }] }))).toContain('error: C uses Nope, which is not a measure of this tile.')
    expect(msgs(q({ target: { table: 'Goals', valueCol: 'Region' } }))).toContain('error: Target: Region is not a number column.')
    expect(msgs(q({ target: { table: 'Nope', valueCol: 'Goal' } }))).toContain('error: Target: the table Nope does not exist or you cannot see it.')
    expect(msgs(q({ target: { table: 'Goals', valueCol: 'Goal', keyCol: 'Region' } }))).toContain('warning: Target: the key column is used only when the tile has a group column.')
  })
  it('visual warnings', () => {
    const t = setVisual(setKind(base(), 'bar'), { series: [{ key: 'Gone' }], category: 'Region' })
    expect(msgs(t)).toEqual(expect.arrayContaining([
      'warning: The chart shows Gone, which this query does not produce.',
      "warning: The chart's category Region is not a group column.",
      'warning: Choose a group column or a date grouping: without one the chart has a single point.',
    ]))
    expect(msgs(setVisual(setKind(base(), 'kpi'), { kpi: { measure: 'Gone' } }))).toContain('error: KPI: Gone is not a measure of this tile.')
    expect(msgs(setVisual(setKind(base(), 'kpi'), { kpi: { measure: 'Rows', base: 'compare' } }))).toContain('warning: KPI: it is compared with the previous period, but the query has no comparison.')
    expect(msgs({ ...base(), title: ' ', kind: 'text' })).toEqual(['warning: The tile has no title.'])
    expect(msgs(setKind(setGroupBy(base(), ['Region']), 'heatmap'))).toContain('warning: A heat map needs two groupings (a group column and a date grouping, or two group columns).')
  })
})

describe('summary', () => {
  it('a template tile in words', () => {
    const t = productionOverview().tiles.find((x) => x.id === 'pareto')!
    expect(describeTile(t, columnsOf)).toEqual([
      'Pareto chart over Downtime.',
      'Downtime minutes: Sum of Minutes.',
      'By Reason.',
      "The dashboard's date range applies to Started on.",
      'Sorted by Downtime minutes, largest first.',
    ])
    const trend = productionOverview().tiles.find((x) => x.id === 'trend')!
    expect(describeTile(trend, columnsOf)).toContain('By day of Logged on.')
    expect(describeTile(trend, columnsOf)).toContain('Compared with the previous period.')
    const oee = productionOverview().tiles[0]!
    expect(describeTile(oee, columnsOf)).toContain('OEE = ((Run minutes ÷ Planned minutes) × (Ideal minutes ÷ Run minutes)) × (Good ÷ Total count) (per row of the result).')
    expect(describeTile(oee, columnsOf)).toContain('One total, not grouped.')
    expect(describeTile({ ...base(), kind: 'text' })).toEqual(['A text tile.'])
    let x = setTop(setSort(setGroupBy(base(), ['Region']), { by: 'Rows', dir: 'asc' }), { n: 5, others: 'Other' })
    x = setTarget(toggleRunning(setFilter(x, { col: 'Paid', op: 'eq', value: true }), 'Rows', true), { table: 'Goals', valueCol: 'Goal', keyCol: 'Region' })
    expect(describeTile(x, columnsOf).slice(1)).toEqual([
      'Rows: Count of rows.', 'By Region.', "The dashboard's date range applies to Created on.", 'Only rows where Paid is yes.',
      'Sorted by Rows, smallest first.', 'Top 5, the rest as "Other".', 'Running total of Rows.', 'Target: sum of Goal in Goals per Region.',
    ])
  })
})

describe('into the definition', () => {
  it('replaces by id or appends; checkDashboardDef refusals surface; the layout is clamped', () => {
    const def = productionOverview()
    const t = { ...def.tiles[1]!, title: 'Output' }
    const d1 = applyTile(def, t, def.tiles[1])
    expect(d1.tiles).toHaveLength(7)
    expect(d1.tiles[1]!.title).toBe('Output')
    const n = newTile(def, 'Orders', ORDERS)
    const d2 = applyTile(def, { ...n, layout: { x: 10, y: 11, w: 4, h: 3 } })
    expect(d2.tiles).toHaveLength(8)
    expect(d2.tiles[7]!.layout).toEqual({ x: 8, y: 11, w: 4, h: 3 })
    expect(() => applyTile(def, { ...n, kind: 'sparkle' as never })).toThrow(/unknown kind/)
    expect(() => applyTile(def, { ...n, query: undefined })).toThrow(/needs a query/)
    const full: DashboardDef = { ...empty, tiles: Array.from({ length: MAX_TILES }, (_, i) => ({ id: `t${i}`, title: '', kind: 'text' as const, layout: { x: 0, y: i, w: 1, h: 1 } })) }
    expect(() => applyTile(full, newTile(full))).toThrow(/at most 40/)
  })
  it('a tile switched to text loses its query; a text tile that had one keeps it', () => {
    const def = productionOverview()
    const d = applyTile(def, setKind(def.tiles[1]!, 'text'), def.tiles[1])
    expect(d.tiles[1]).not.toHaveProperty('query')
    const odd: TileDef = { id: 'odd', title: 'T', kind: 'text', text: 'hi', layout: { x: 0, y: 20, w: 4, h: 2 }, query: { table: 'Orders', measures: [{ id: 'a', fn: 'count' }] } }
    expect(applyTile({ ...def, tiles: [...def.tiles, odd] }, { ...odd, title: 'U' }, odd).tiles[7]!.query).toEqual(odd.query)
  })
})

describe('preview through the viewer path', () => {
  const S: TableSchemaInfo = { columns: { id: 'text', createdOn: 'datetime', Region: 'text', Amount: 'number', Qty: 'number', Paid: 'boolean', OrderDate: 'date', Photo: 'other' } }
  const day = (s: string) => { const [y, m, dd] = s.split('-').map(Number); return new Date(y!, m! - 1, dd!) }
  const rows: FxRecord[] = [['2026-11-02', 'North', 100, true], ['2026-11-03', 'South', 50, false], ['2026-11-20', 'North', 25, true], ['2026-10-10', 'North', 999, true]]
    .map(([d, r, a, p], i) => ({ id: `o${i}`, createdOn: new Date(Date.UTC(2026, 0, 1, 0, i)), OrderDate: day(d as string), Region: r, Amount: a, Qty: 1, Paid: p, Photo: null } as FxRecord))
  it('a tile built only with editor operations runs through buildBatch / assemble like the viewer', () => {
    let t = newTile(empty, 'Orders', ORDERS)
    t = setDateColumn(t, col('OrderDate'))
    t = addMeasure(t, col('Amount'))
    t = setMeasureFilter(t, 'Rows', conditionOfSimple({ join: 'and', rows: [{ col: 'Paid', kind: 'boolean', op: 'eq', value: 'yes' }] }, TZ))
    t = setComputedExpr(addComputed(t), 'RowsPerAmount', calcOfSimple({ a: { m: 'Amount' }, op: 'div', b: { m: 'Rows' } }))
    t = setSort(setGroupBy(t, ['Region']), { by: 'Amount', dir: 'desc' })
    expect(blocking(validateTile(t, columnsOf))).toEqual([])
    const def = previewDef({ ...empty, filters: [{ id: 'r', label: 'Region', column: 'Region', options: ['North'] }] }, t)
    const choices = { range: { from: '2026-11-01T00:00', to: '2026-12-01T00:00' }, filters: {}, calendar: DEFAULT_CALENDAR, columns: (n: string) => (n === 'Orders' ? Object.keys(S.columns) : null) }
    const b = buildBatch(def, choices)
    expect(b.errors).toEqual({})
    const answers = b.queries.map((q) => ({ id: q.id, ok: true, rows: executePlan(checkPlan(JSON.parse(JSON.stringify(q.plan)) as QueryPlan, S, 'Orders').plan, rows, S).rows, ms: 1 }))
    const data = assemble(def, choices, answers, b.errors)[t.id]!
    expect(data.error).toBeUndefined()
    expect(data.rows.map((r) => [r.Region, r.Rows, r.Amount, r.RowsPerAmount])).toEqual([['North', 2, 125, 62.5], ['South', 0, 50, null]])
  })
  it('a compile error shows as that tile\'s message, in words', () => {
    const t = { ...newTile(empty, 'Orders', ORDERS), query: { table: 'Orders', measures: [] } }
    const b = buildBatch(previewDef(empty, t), { range: null, filters: {}, calendar: DEFAULT_CALENDAR, columns: () => ['id'] })
    expect(b.errors[t.id]).toBe('Add at least one measure.')
  })
})
