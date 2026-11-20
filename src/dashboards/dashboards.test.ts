/**
 * Dashboard core (P2-C): date presets and comparison periods (fiscal year, weeks, shifts past midnight, time zones),
 * the measure builder end to end through the reference executor (computed measures, period comparison, running totals,
 * targets, top N + others, gap filling), the manufacturing presets against hand-computed OEE, and the template.
 */
import { describe, expect, it } from 'vitest'
import type { FxRecord } from '../contracts.ts'
import type { QueryPlan, TableSchemaInfo } from '../platform/query.ts'
import { executePlan } from '../fx/query/reference.ts'
import { checkPlan } from '../fx/query/validate.ts'
import { DEFAULT_CALENDAR, comparisonRange, currentShift, localNow, rangeCondition, resolvePreset, zonedInstant } from './dates.ts'
import { compileQuery, evalCalc, finishQuery } from './measures.ts'
import type { QuerySpec } from './measures.ts'
import { DOWNTIME, PRESETS, PRODUCTION_LOG, productionOverview, sampleProduction } from './manufacturing.ts'
import { checkDashboardDef } from './types.ts'
import { tileChartSpec } from './tile.ts'
import { assemble, buildBatch } from './viewer.ts'
import { chartScene } from '../charts/geometry.ts'

const now = new Date('2026-11-19T10:30:00Z') // 16:00 in India (shift B)

describe('date ranges', () => {
  it('presets in the dashboard time zone, Indian fiscal year', () => {
    expect(resolvePreset('today', now)).toEqual({ from: '2026-11-19T00:00', to: '2026-11-20T00:00' })
    expect(resolvePreset('thisWeek', now)).toEqual({ from: '2026-11-16T00:00', to: '2026-11-23T00:00' })
    expect(resolvePreset('thisWeek', now, { ...DEFAULT_CALENDAR, weekStart: 7 })).toEqual({ from: '2026-11-15T00:00', to: '2026-11-22T00:00' })
    expect(resolvePreset('thisMonth', now)).toEqual({ from: '2026-11-01T00:00', to: '2026-12-01T00:00' })
    expect(resolvePreset('thisFiscalYear', now)).toEqual({ from: '2026-04-01T00:00', to: '2027-04-01T00:00' })
    expect(resolvePreset('fiscalYearToDate', now)).toEqual({ from: '2026-04-01T00:00', to: '2026-11-20T00:00' })
    expect(resolvePreset('thisShift', now)).toEqual({ from: '2026-11-19T14:00', to: '2026-11-19T22:00' })
    expect(resolvePreset('all', now)).toBe(null)
    // 23:30 UTC is 05:00 next day in India: the night shift that started the day before
    expect(resolvePreset('thisShift', new Date('2026-11-18T23:30:00Z'))).toEqual({ from: '2026-11-18T22:00', to: '2026-11-19T06:00' })
    expect(currentShift({ ymd: [2026, 11, 19], minutes: 23 * 60 }, DEFAULT_CALENDAR.shifts)?.shift.name).toBe('C')
  })
  it('comparison periods', () => {
    expect(comparisonRange({ from: '2026-11-01T00:00', to: '2026-12-01T00:00' }, 'previousPeriod')).toEqual({ from: '2026-10-01T00:00', to: '2026-11-01T00:00' })
    expect(comparisonRange({ from: '2026-11-16T00:00', to: '2026-11-23T00:00' }, 'previousPeriod')).toEqual({ from: '2026-11-09T00:00', to: '2026-11-16T00:00' })
    expect(comparisonRange({ from: '2026-11-19T14:00', to: '2026-11-19T22:00' }, 'previousPeriod')).toEqual({ from: '2026-11-19T06:00', to: '2026-11-19T14:00' })
    expect(comparisonRange({ from: '2026-04-01T00:00', to: '2026-11-20T00:00' }, 'samePeriodLastYear')).toEqual({ from: '2025-04-01T00:00', to: '2025-11-20T00:00' })
  })
  it('range conditions: calendar days for dates, instants in the zone for datetimes', () => {
    expect(rangeCondition('Due', 'date', { from: '2026-11-01T00:00', to: '2026-12-01T00:00' }, 'Asia/Kolkata')).toEqual({ and: [{ col: 'Due', op: 'ge', value: { $date: '2026-11-01' } }, { col: 'Due', op: 'lt', value: { $date: '2026-12-01' } }] })
    expect(zonedInstant('2026-11-19T14:00', 'Asia/Kolkata').toISOString()).toBe('2026-11-19T08:30:00.000Z')
    expect(zonedInstant('2026-03-08T03:00', 'America/Los_Angeles').toISOString()).toBe('2026-03-08T10:00:00.000Z')
    expect(zonedInstant('2026-07-01T00:00', 'Europe/Berlin').toISOString()).toBe('2026-06-30T22:00:00.000Z')
  })
})

/* a tiny in-memory "server": runs compiled plans with the reference executor, as demo mode does */
const S: TableSchemaInfo = { columns: { id: 'text', createdOn: 'datetime', Day: 'date', Line: 'text', Qty: 'number', Bad: 'number' } }
const T: TableSchemaInfo = { columns: { id: 'text', createdOn: 'datetime', Line: 'text', Goal: 'number' } }
const d = (s: string) => { const [y, m, dd] = s.split('-').map(Number); return new Date(y!, m! - 1, dd!) }
const facts: FxRecord[] = [
  ['2026-10-03', 'A', 10, 1], ['2026-10-20', 'B', 30, 3], ['2026-11-02', 'A', 20, 2], ['2026-11-02', 'B', 40, 0], ['2026-11-05', 'A', 5, 5], ['2026-11-30', 'C', 1, 0],
].map(([day, line, q, b], i) => ({ id: `r${i}`, createdOn: new Date(Date.UTC(2026, 0, 1, 0, i)), Day: d(day as string), Line: line, Qty: q, Bad: b }))
const goals: FxRecord[] = [{ id: 'g1', createdOn: new Date(0), Line: 'A', Goal: 30 }, { id: 'g2', createdOn: new Date(0), Line: 'b', Goal: 50 }]
const exec = (p: QueryPlan) => executePlan(checkPlan(JSON.parse(JSON.stringify(p)), p.table === 'Goals' ? T : S, p.table).plan, p.table === 'Goals' ? goals : facts, p.table === 'Goals' ? T : S).rows
function runSpec(spec: QuerySpec, range = { from: '2026-11-01T00:00', to: '2026-12-01T00:00' }) {
  const ctx = { range }
  const c = compileQuery(spec, ctx)
  return finishQuery(spec, ctx, exec(c.main), c.compare && exec(c.compare), c.target && exec(c.target)).rows
}

describe('measure builder', () => {
  it('ratio of sums, not average of ratios; division by zero is blank', () => {
    const rows = runSpec({ table: 'F', dateColumn: { col: 'Day', kind: 'date' }, measures: [{ id: 'Q', fn: 'sum', col: 'Qty' }, { id: 'B', fn: 'sum', col: 'Bad' }], computed: [{ id: 'Rate', expr: { fn: 'div', args: [{ m: 'B' }, { m: 'Q' }] } }] })
    expect(rows).toEqual([{ Q: 66, B: 7, Rate: 7 / 66 }])
    expect(evalCalc({ fn: 'div', args: [1, { m: 'x' }] }, { x: 0 })).toBe(null)
  })
  it('previous period by group key; running totals; targets per group', () => {
    const rows = runSpec({ table: 'F', groupBy: ['Line'], dateColumn: { col: 'Day', kind: 'date' }, measures: [{ id: 'Q', fn: 'sum', col: 'Qty' }], compare: 'previousPeriod', running: ['Q'], target: { table: 'Goals', valueCol: 'Goal', keyCol: 'Line' } })
    expect(rows).toEqual([
      { Line: 'A', Q: 25, Q__cmp: 10, Q__run: 25, __target: 30 },
      { Line: 'B', Q: 40, Q__cmp: 30, Q__run: 65, __target: 50 },
      { Line: 'C', Q: 1, Q__cmp: null, Q__run: 66, __target: null },
    ])
  })
  it('date buckets are gap-filled and compared by position', () => {
    const rows = runSpec({ table: 'F', bucket: { col: 'Day', unit: 'week' }, dateColumn: { col: 'Day', kind: 'date' }, measures: [{ id: 'Q', fn: 'sum', col: 'Qty' }], compare: 'previousPeriod' })
    expect(rows.map((r) => [(r.__bucket as Date).getDate(), r.Q])).toEqual([[26, null], [2, 65], [9, null], [16, null], [23, null], [30, 1]])
    // November's n-th week compares with October's n-th week (Sep 29: Oct 3 = 10; Oct 20: 30)
    expect(rows.map((r) => r.Q__cmp)).toEqual([10, null, null, 30, null, null])
  })
  it('top N with others, and sort by a computed measure', () => {
    const top = runSpec({ table: 'F', groupBy: ['Line'], measures: [{ id: 'Q', fn: 'sum', col: 'Qty' }], sort: { by: 'Q', dir: 'desc' }, top: { n: 1, others: 'Others' } }, null as never)
    expect(top).toEqual([{ Line: 'B', Q: 70 }, { Line: 'Others', Q: 36 }])
    const byRate = runSpec({ table: 'F', groupBy: ['Line'], measures: [{ id: 'Q', fn: 'sum', col: 'Qty' }, { id: 'B', fn: 'sum', col: 'Bad' }], computed: [{ id: 'R', expr: { fn: 'div', args: [{ m: 'B' }, { m: 'Q' }] } }], sort: { by: 'R', dir: 'desc' }, top: { n: 2 } }, null as never)
    expect(byRate.map((r) => r.Line)).toEqual(['A', 'B'])
  })
  it('refuses broken specs with readable messages', () => {
    expect(() => compileQuery({ table: 'F', measures: [] }, { range: null })).toThrow(/at least one measure/)
    expect(() => compileQuery({ table: 'F', measures: [{ id: 'Q', fn: 'count' }], computed: [{ id: 'X', expr: { m: 'Nope' } }] }, { range: null })).toThrow(/Nope/)
    expect(() => compileQuery({ table: 'F', measures: [{ id: 'bad id', fn: 'count' }] }, { range: null })).toThrow(/valid measure name/)
    expect(() => compileQuery({ table: 'F', groupBy: ['Line', 'Day'], measures: [{ id: 'Q', fn: 'count' }], top: { n: 1, others: 'O' } }, { range: null })).toThrow(/Others/)
  })
})

describe('manufacturing presets and template', () => {
  const sample = sampleProduction(new Date('2026-11-19T10:30:00Z'), 30)
  const logInfo: TableSchemaInfo = { columns: { id: 'text', createdOn: 'datetime', LoggedOn: 'datetime', Shift: 'text', Machine: 'text', Good: 'number', Scrap: 'number', PlannedMin: 'number', RunMin: 'number', IdealCycleSec: 'number' } }
  const logRows: FxRecord[] = sample.log.map((r, i) => ({ id: `l${i}`, createdOn: new Date(i), ...r, LoggedOn: new Date(String(r.LoggedOn)) } as FxRecord))
  it('OEE = A x P x Q from sums equals the hand computation', () => {
    const spec = PRESETS[0]!.query
    const ctx = { range: { from: '2026-11-01T00:00', to: '2026-12-01T00:00' } }
    const c = compileQuery(spec, ctx)
    const main = executePlan(checkPlan(JSON.parse(JSON.stringify(c.main)), logInfo, 'L').plan, logRows, logInfo).rows
    const [row] = finishQuery(spec, ctx, main).rows
    const from = Date.parse('2026-10-31T18:30:00Z'), to = Date.parse('2026-11-30T18:30:00Z')
    const sel = sample.log.filter((r) => { const t = Date.parse(String(r.LoggedOn)); return t >= from && t < to })
    const sum = (f: (r: Record<string, unknown>) => number) => sel.reduce((a, r) => a + f(r), 0)
    const planned = sum((r) => r.PlannedMin as number), run = sum((r) => r.RunMin as number), good = sum((r) => r.Good as number), total = sum((r) => (r.Good as number) + (r.Scrap as number))
    const ideal = sum((r) => ((r.IdealCycleSec as number) * ((r.Good as number) + (r.Scrap as number))) / 60)
    expect(row!.Availability).toBeCloseTo(run / planned, 12)
    expect(row!.Performance).toBeCloseTo(ideal / run, 12)
    expect(row!.Quality).toBeCloseTo(good / total, 12)
    expect(row!.OEE).toBeCloseTo((good * ((ideal / total) * 60) / 60) / planned, 12)
    expect(row!.OEE as number).toBeGreaterThan(0.4)
    expect(row!.OEE as number).toBeLessThan(1)
  })
  it('every preset compiles to valid plans; the template is a valid seven-tile dashboard', () => {
    for (const p of PRESETS) expect(() => compileQuery(p.query, { range: resolvePreset('thisMonth', now) })).not.toThrow()
    const def = checkDashboardDef(productionOverview())
    expect(def.tiles.length).toBe(7)
    expect(new Set(def.tiles.map((t) => t.query?.table))).toEqual(new Set([PRODUCTION_LOG, DOWNTIME]))
    for (const t of def.tiles) {
      const c = compileQuery(t.query!, { range: resolvePreset(def.range, now) })
      const info = t.query!.table === PRODUCTION_LOG ? logInfo : { columns: { id: 'text', createdOn: 'datetime', StartedOn: 'datetime', Machine: 'text', Reason: 'text', Minutes: 'number' } } as TableSchemaInfo
      const rows = t.query!.table === PRODUCTION_LOG ? logRows : sample.downtime.map((r, i) => ({ id: `d${i}`, createdOn: new Date(i), ...r, StartedOn: new Date(String(r.StartedOn)) } as FxRecord))
      const run = (p: QueryPlan) => executePlan(checkPlan(JSON.parse(JSON.stringify(p)), info, 'X').plan, rows, info).rows
      const fin = finishQuery(t.query!, { range: resolvePreset(def.range, now) }, run(c.main), c.compare && run(c.compare))
      if (t.kind === 'table') continue
      const sc = chartScene(tileChartSpec(t, fin.rows, { width: 300, height: 200 }), fin.rows)
      expect(sc.empty, t.id).toBeUndefined()
      expect(sc.marks.length, t.id).toBeGreaterThan(0)
    }
  })
  it('sample data is deterministic and labelled as sample', () => {
    const a = sampleProduction(new Date('2026-11-19T00:00:00Z'), 5)
    expect(a).toEqual(sampleProduction(new Date('2026-11-19T00:00:00Z'), 5))
    expect(a.log.every((r) => String(r.Machine).startsWith('Sample '))).toBe(true)
    expect(() => checkDashboardDef({ title: '', tiles: [] })).toThrow(/title/)
    expect(() => checkDashboardDef({ title: 'x', tiles: [{ id: 'a', kind: 'nope' }] })).toThrow(/unknown kind/)
  })
})

describe('viewer batch', () => {
  const def = checkDashboardDef(productionOverview())
  const cols: Record<string, string[]> = { ProductionLog: ['LoggedOn', 'Shift', 'Machine', 'Good', 'Scrap', 'PlannedMin', 'RunMin', 'IdealCycleSec'], Downtime: ['StartedOn', 'Machine', 'Reason', 'Minutes'] }
  const base = { range: resolvePreset('thisMonth', now), filters: {}, calendar: DEFAULT_CALENDAR, columns: (t: string) => cols[t] ?? null }
  it('one batch for all tiles: main plans plus comparisons', () => {
    const b = buildBatch(def, base)
    expect(b.queries.filter((q) => q.id.endsWith(':main'))).toHaveLength(7)
    expect(b.queries.filter((q) => q.id.endsWith(':compare')).map((q) => q.id.split(':')[0])).toEqual(['good', 'scrap', 'trend'])
  })
  it('a dashboard filter applies to tiles whose table has the column; a cross-filter to the other tiles on the same table', () => {
    const b = buildBatch(def, { ...base, filters: { shift: 'B' }, cross: { tileId: 'machines', table: 'ProductionLog', column: 'Machine', value: 'Sample press 2' } })
    const plan = (id: string) => JSON.stringify(b.queries.find((q) => q.id === id)!.plan)
    expect(plan('oee:main')).toContain('"Shift"')
    expect(plan('oee:main')).toContain('Sample press 2')
    expect(plan('pareto:main')).not.toContain('"Shift"')
    expect(plan('pareto:main')).not.toContain('Sample press 2')
    expect(plan('machines:main')).not.toContain('Sample press 2')
  })
  it('a failing query fails only its tile; a broken spec reports its message', () => {
    const broken = { ...def, tiles: [...def.tiles, { id: 'bad', title: 'Bad', kind: 'bar' as const, layout: { x: 0, y: 20, w: 4, h: 3 }, query: { table: 'ProductionLog', measures: [] } }] }
    const b = buildBatch(broken, base)
    expect(b.errors.bad).toMatch(/measure/)
    const answers = b.queries.map((q) => ({ id: q.id, ok: !q.id.startsWith('pareto'), rows: q.id.startsWith('pareto') ? [] : [{ Good: 5, Planned: 10, Run: 8, IdealMin: 6, Total: 6, Scrap: 1, Good__cmp: 4 }], ms: 3, ...(q.id.startsWith('pareto') ? { error: 'You do not have access to the column "Minutes".', status: 403 } : {}) }))
    const data = assemble(broken, base, answers, b.errors)
    expect(data.pareto).toMatchObject({ error: expect.stringContaining('Minutes'), status: 403 })
    expect(data.bad!.error).toMatch(/measure/)
    expect(data.oee!.rows[0]!.OEE).toBeCloseTo((8 / 10) * (6 / 8) * (5 / 6), 12)
    expect(data.good!.rows[0]).toMatchObject({ Good: 5, Good__cmp: 5 })
  })
})

describe('comparison of a running period', () => {
  it('compares only the elapsed part ("to date")', () => {
    expect(comparisonRange({ from: '2026-11-01T00:00', to: '2026-12-01T00:00' }, 'previousPeriod', '2026-11-19T16:00')).toEqual({ from: '2026-10-01T00:00', to: '2026-10-19T16:00' })
    expect(comparisonRange({ from: '2026-04-01T00:00', to: '2027-04-01T00:00' }, 'samePeriodLastYear', '2026-11-19T16:00')).toEqual({ from: '2025-04-01T00:00', to: '2025-11-19T16:00' })
    // now outside the range: the whole period
    expect(comparisonRange({ from: '2026-10-01T00:00', to: '2026-11-01T00:00' }, 'previousPeriod', '2026-11-19T16:00')).toEqual({ from: '2026-09-01T00:00', to: '2026-10-01T00:00' })
    expect(localNow(new Date('2026-11-19T10:30:00Z'), 'Asia/Kolkata')).toBe('2026-11-19T16:00')
  })
})
