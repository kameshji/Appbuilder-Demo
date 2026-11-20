/**
 * MTBF (mean time between failures, manufacturing.ts): operating minutes (sum of ProductionLog.RunMin) / breakdowns
 * (Downtime rows with Reason "Breakdown"), against hand computation, through the measure builder and the reference
 * executor (the same plans the server runs), in total and per machine.
 */
import { describe, expect, it } from 'vitest'
import type { FxRecord } from '../contracts.ts'
import type { QueryPlan, TableSchemaInfo } from '../platform/query.ts'
import { executePlan } from '../fx/query/reference.ts'
import { checkPlan } from '../fx/query/validate.ts'
import { compileQuery, finishQuery } from './measures.ts'
import type { QuerySpec } from './measures.ts'
import { mtbf, mtbfQueries, mtbfRows, productionOverview } from './manufacturing.ts'
import { checkDashboardDef } from './types.ts'

const LOG: TableSchemaInfo = { columns: { id: 'text', createdOn: 'datetime', LoggedOn: 'datetime', Machine: 'text', RunMin: 'number', PlannedMin: 'number' } }
const DOWN: TableSchemaInfo = { columns: { id: 'text', createdOn: 'datetime', StartedOn: 'datetime', Machine: 'text', Reason: 'text', Minutes: 'number' } }
const at = (s: string) => new Date(s)
const log: FxRecord[] = [
  // November (India time): press 1 runs 400 + 430, press 2 runs 450 + 300
  { LoggedOn: at('2026-11-02T08:00:00Z'), Machine: 'Press 1', RunMin: 400, PlannedMin: 450 },
  { LoggedOn: at('2026-11-03T08:00:00Z'), Machine: 'Press 1', RunMin: 430, PlannedMin: 450 },
  { LoggedOn: at('2026-11-02T08:00:00Z'), Machine: 'Press 2', RunMin: 450, PlannedMin: 450 },
  { LoggedOn: at('2026-11-04T08:00:00Z'), Machine: 'press 2', RunMin: 300, PlannedMin: 450 },
  // October: outside the range
  { LoggedOn: at('2026-10-30T08:00:00Z'), Machine: 'Press 1', RunMin: 999, PlannedMin: 999 },
].map((r, i) => ({ id: `l${i}`, createdOn: new Date(Date.UTC(2026, 0, 1, 0, i)), ...r }))
const down: FxRecord[] = [
  { StartedOn: at('2026-11-02T10:00:00Z'), Machine: 'Press 1', Reason: 'Breakdown', Minutes: 50 },
  { StartedOn: at('2026-11-03T10:00:00Z'), Machine: 'Press 1', Reason: 'breakdown', Minutes: 20 },
  { StartedOn: at('2026-11-02T11:00:00Z'), Machine: 'Press 1', Reason: 'Changeover', Minutes: 30 },
  { StartedOn: at('2026-11-04T10:00:00Z'), Machine: 'Press 2', Reason: 'Planned maintenance', Minutes: 60 },
  { StartedOn: at('2026-10-31T10:00:00Z'), Machine: 'Press 2', Reason: 'Breakdown', Minutes: 15 },
].map((r, i) => ({ id: `d${i}`, createdOn: new Date(Date.UTC(2026, 0, 1, 0, i)), ...r }))

const exec = (p: QueryPlan) => {
  const info = p.table === 'ProductionLog' ? LOG : DOWN
  return executePlan(checkPlan(JSON.parse(JSON.stringify(p)), info, p.table).plan, p.table === 'ProductionLog' ? log : down, info).rows
}
const range = { from: '2026-11-01T00:00', to: '2026-12-01T00:00' }
function run(spec: QuerySpec) {
  const ctx = { range, calendar: undefined }
  const c = compileQuery(spec, ctx)
  return finishQuery(spec, ctx, exec(c.main)).rows
}

describe('MTBF', () => {
  it('is operating time / failures; blank without failures or without operating time', () => {
    expect(mtbf(1580, 2)).toBe(790)
    expect(mtbf(600, 0)).toBe(null)
    expect(mtbf(null, 3)).toBe(null)
    expect(mtbf(Number.NaN, 3)).toBe(null)
  })

  it('in total: (400 + 430 + 450 + 300) run minutes / 2 breakdowns in November = 790 minutes', () => {
    const q = mtbfQueries()
    const rows = mtbfRows(run(q.operating), run(q.failures))
    // hand computation: 1580 minutes; breakdowns: press 1 twice (Breakdown, breakdown); the changeover, the planned
    // maintenance and October's breakdown do not count
    expect(rows).toEqual([{ OperatingMin: 1580, Failures: 2, MTBF: 790 }])
  })

  it('per machine: press 1 830 / 2 = 415; press 2 ran 750 minutes without a breakdown (blank)', () => {
    const q = mtbfQueries(undefined, { byMachine: true })
    const rows = mtbfRows(run(q.operating), run(q.failures), 'Machine')
    const by = Object.fromEntries(rows.map((r) => [String(r.Machine).toLowerCase(), r]))
    expect(by['press 1']).toMatchObject({ OperatingMin: 830, Failures: 2, MTBF: 415 })
    expect(by['press 2']).toMatchObject({ OperatingMin: 750, Failures: 0, MTBF: null })
    expect(rows).toHaveLength(2)
  })

  it('a machine with breakdowns but no logged run time has operating minutes blank and MTBF blank', () => {
    expect(mtbfRows([], [{ Machine: 'Press 9', Failures: 3 }], 'Machine')).toEqual([{ Machine: 'Press 9', OperatingMin: null, Failures: 3, MTBF: null }])
  })

  it('uses the given table names; the template is unchanged (MTBF needs two tables, a tile reads one)', () => {
    const q = mtbfQueries({ log: 'PlantLog', downtime: 'Stops' })
    expect([q.operating.table, q.failures.table]).toEqual(['PlantLog', 'Stops'])
    const t = checkDashboardDef(productionOverview())
    expect(t.tiles.map((x) => x.id)).toEqual(['oee', 'good', 'scrap', 'avail', 'trend', 'pareto', 'machines'])
  })
})
