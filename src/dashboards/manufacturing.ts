/**
 * Manufacturing helpers (P2-C): measure presets for OEE and its factors, scrap rate, first-pass yield, downtime Pareto,
 * MTTR and schedule adherence over a documented minimal table shape, the "Production overview" dashboard template and
 * a deterministic SAMPLE data generator for demos. Definitions (docs/guide/maker/dashboards.md cites the sources):
 *
 *   Availability = run time / planned production time                         (OEE.com, "Calculating OEE")
 *   Performance  = (ideal cycle time x total count) / run time                (OEE.com)
 *   Quality      = good count / total count                                   (OEE.com)
 *   OEE          = Availability x Performance x Quality
 *                = (good count x ideal cycle time) / planned production time  (OEE.com)
 *   Scrap rate   = scrap count / total count
 *   First-pass yield = units good first time / units started (good quantity here excludes reworked units)
 *   MTTR         = total repair (breakdown) minutes / number of breakdowns   (UpKeep)
 *   MTBF         = operating time / number of failures                       (UpKeep, "MTBF"; IEC 60050-192 "mean operating time between failures")
 *                  operating time = sum of ProductionLog.RunMin (minutes the machine actually ran, LoggedOn in the range);
 *                  failures = Downtime rows with Reason "Breakdown" (StartedOn in the range); planned stops, changeovers
 *                  and waiting are not failures. Two tables: see mtbfQueries / mtbfRows (not a template tile).
 *   Schedule adherence = work orders done by their due date / work orders due (common definition)
 *
 * Ratios are computed from SUMS over the selected rows (never averages of per-row ratios). Ideal cycle time varies by
 * item, so "ideal minutes" is summed per row: IdealCycleSec x (Good + Scrap) / 60.
 */
import type { ColumnDef } from '../platform/contracts.ts'
import type { ComputedSpec, MeasureSpec, QuerySpec } from './measures.ts'
import type { DashboardDef } from './types.ts'
import { rng } from '../fx/query/testdata.ts'

/** the minimal tables (column names are the formula names) */
export const PRODUCTION_LOG = 'ProductionLog'
export const DOWNTIME = 'Downtime'
export const WORK_ORDERS = 'WorkOrders'

export const SHAPE: Record<string, Partial<ColumnDef>[]> = {
  [PRODUCTION_LOG]: [
    { name: 'LoggedOn', displayName: 'Logged on', type: 'datetime', required: true, indexed: true },
    { name: 'Shift', displayName: 'Shift', type: 'choice', choices: ['A', 'B', 'C'], indexed: true },
    { name: 'Machine', displayName: 'Machine', type: 'text', indexed: true },
    { name: 'Good', displayName: 'Good quantity', type: 'number' },
    { name: 'Scrap', displayName: 'Scrap quantity', type: 'number' },
    { name: 'PlannedMin', displayName: 'Planned minutes', type: 'number' },
    { name: 'RunMin', displayName: 'Run minutes', type: 'number' },
    { name: 'IdealCycleSec', displayName: 'Ideal cycle (s)', type: 'decimal' },
  ],
  [DOWNTIME]: [
    { name: 'StartedOn', displayName: 'Started on', type: 'datetime', required: true, indexed: true },
    { name: 'Machine', displayName: 'Machine', type: 'text', indexed: true },
    { name: 'Reason', displayName: 'Reason', type: 'choice', choices: ['Breakdown', 'Changeover', 'No material', 'No operator', 'Planned maintenance', 'Other'], indexed: true },
    { name: 'Minutes', displayName: 'Minutes', type: 'number' },
  ],
  [WORK_ORDERS]: [
    { name: 'Number', displayName: 'Number', type: 'text' },
    { name: 'DueDate', displayName: 'Due date', type: 'date', indexed: true },
    { name: 'CompletedOn', displayName: 'Completed on', type: 'date' },
    { name: 'Status', displayName: 'Status', type: 'choice', choices: ['Planned', 'Released', 'Running', 'Done', 'Cancelled'] },
  ],
}

const idealMin = { fn: 'div' as const, args: [{ fn: 'mul' as const, args: [{ col: 'IdealCycleSec' }, { fn: 'add' as const, args: [{ col: 'Good' }, { col: 'Scrap' }] }] }, 60] } as const

/** OEE base measures over ProductionLog */
export const OEE_MEASURES: MeasureSpec[] = [
  { id: 'Planned', label: 'Planned minutes', fn: 'sum', col: 'PlannedMin' },
  { id: 'Run', label: 'Run minutes', fn: 'sum', col: 'RunMin' },
  { id: 'IdealMin', label: 'Ideal minutes', fn: 'sum', expr: JSON.parse(JSON.stringify(idealMin)) },
  { id: 'Good', label: 'Good', fn: 'sum', col: 'Good' },
  { id: 'Total', label: 'Total count', fn: 'sum', expr: { fn: 'add', args: [{ col: 'Good' }, { col: 'Scrap' }] } },
]
export const OEE_COMPUTED: ComputedSpec[] = [
  { id: 'Availability', label: 'Availability', expr: { fn: 'div', args: [{ m: 'Run' }, { m: 'Planned' }] } },
  { id: 'Performance', label: 'Performance', expr: { fn: 'div', args: [{ m: 'IdealMin' }, { m: 'Run' }] } },
  { id: 'Quality', label: 'Quality', expr: { fn: 'div', args: [{ m: 'Good' }, { m: 'Total' }] } },
  { id: 'OEE', label: 'OEE', expr: { fn: 'mul', args: [{ fn: 'mul', args: [{ fn: 'div', args: [{ m: 'Run' }, { m: 'Planned' }] }, { fn: 'div', args: [{ m: 'IdealMin' }, { m: 'Run' }] }] }, { fn: 'div', args: [{ m: 'Good' }, { m: 'Total' }] }] } },
]

export interface Preset { key: string; label: string; description: string; query: Omit<QuerySpec, 'table'> & { table: string } }

const logDate = { col: 'LoggedOn', kind: 'datetime' as const }
export const PRESETS: Preset[] = [
  { key: 'oee', label: 'OEE', description: 'Availability x Performance x Quality over the selected rows.', query: { table: PRODUCTION_LOG, measures: OEE_MEASURES, computed: OEE_COMPUTED, dateColumn: logDate } },
  { key: 'scrapRate', label: 'Scrap rate', description: 'Scrap quantity / (good + scrap).', query: { table: PRODUCTION_LOG, measures: [{ id: 'Scrap', fn: 'sum', col: 'Scrap' }, { id: 'Total', fn: 'sum', expr: { fn: 'add', args: [{ col: 'Good' }, { col: 'Scrap' }] } }], computed: [{ id: 'ScrapRate', label: 'Scrap rate', expr: { fn: 'div', args: [{ m: 'Scrap' }, { m: 'Total' }] } }], dateColumn: logDate } },
  { key: 'fpy', label: 'First-pass yield', description: 'Good first time / units started (Good excludes reworked units).', query: { table: PRODUCTION_LOG, measures: [{ id: 'Good', fn: 'sum', col: 'Good' }, { id: 'Total', fn: 'sum', expr: { fn: 'add', args: [{ col: 'Good' }, { col: 'Scrap' }] } }], computed: [{ id: 'FPY', label: 'First-pass yield', expr: { fn: 'div', args: [{ m: 'Good' }, { m: 'Total' }] } }], dateColumn: logDate } },
  { key: 'downtimePareto', label: 'Downtime Pareto', description: 'Downtime minutes by reason, largest first.', query: { table: DOWNTIME, groupBy: ['Reason'], measures: [{ id: 'Minutes', label: 'Downtime minutes', fn: 'sum', col: 'Minutes' }], sort: { by: 'Minutes', dir: 'desc' }, dateColumn: { col: 'StartedOn', kind: 'datetime' } } },
  { key: 'mttr', label: 'MTTR', description: 'Breakdown minutes / number of breakdowns.', query: { table: DOWNTIME, measures: [{ id: 'Breakdowns', fn: 'count', filter: { col: 'Reason', op: 'eq', value: 'breakdown' } }, { id: 'BreakdownMin', fn: 'sum', col: 'Minutes' }], filter: { col: 'Reason', op: 'eq', value: 'breakdown' }, computed: [{ id: 'MTTR', label: 'MTTR (minutes)', expr: { fn: 'div', args: [{ m: 'BreakdownMin' }, { m: 'Breakdowns' }] } }], dateColumn: { col: 'StartedOn', kind: 'datetime' } } },
  { key: 'scheduleAdherence', label: 'Schedule adherence', description: 'Work orders done by their due date / work orders due.', query: { table: WORK_ORDERS, measures: [{ id: 'Due', fn: 'count' }, { id: 'OnTime', fn: 'count', filter: { and: [{ col: 'Status', op: 'eq', value: 'done' }, { col: 'CompletedOn', op: 'cmpCol', cmp: 'le', other: 'DueDate' }] } }], computed: [{ id: 'Adherence', label: 'Schedule adherence', expr: { fn: 'div', args: [{ m: 'OnTime' }, { m: 'Due' }] } }], filter: { not: { col: 'Status', op: 'eq', value: 'cancelled' } }, dateColumn: { col: 'DueDate', kind: 'date' } } },
]

/* ------------------------------------------------------------------ MTBF */

/** MTBF in minutes: operating minutes / failures; blank when either is blank or there was no failure (as MTTR: x / 0 is blank) */
export function mtbf(operatingMinutes: number | null | undefined, failures: number | null | undefined): number | null {
  if (typeof operatingMinutes !== 'number' || typeof failures !== 'number' || !Number.isFinite(operatingMinutes) || !Number.isFinite(failures) || failures <= 0) return null
  return operatingMinutes / failures
}

/**
 * The two queries of MTBF (a tile reads one table, MTBF needs two): operating minutes from the production log and the
 * number of breakdowns from the downtime log, over the same date range; per machine when `byMachine`.
 */
export function mtbfQueries(names: { log: string; downtime: string } = { log: PRODUCTION_LOG, downtime: DOWNTIME }, o: { byMachine?: boolean } = {}): { operating: QuerySpec; failures: QuerySpec } {
  const groupBy = o.byMachine ? ['Machine'] : undefined
  return {
    operating: { table: names.log, ...(groupBy ? { groupBy } : {}), measures: [{ id: 'OperatingMin', label: 'Operating minutes', fn: 'sum', col: 'RunMin' }], dateColumn: logDate },
    failures: { table: names.downtime, ...(groupBy ? { groupBy } : {}), measures: [{ id: 'Failures', label: 'Breakdowns', fn: 'count' }], filter: { col: 'Reason', op: 'eq', value: 'breakdown' }, dateColumn: { col: 'StartedOn', kind: 'datetime' } },
  }
}

export interface MtbfRow { Machine?: unknown; OperatingMin: number | null; Failures: number; MTBF: number | null }

/**
 * Combines the finished rows of mtbfQueries: one row (no key) or one per machine (key 'Machine', matched case-insensitively
 * as the database groups text). A machine that ran without a breakdown has MTBF blank (no failure to measure between);
 * one with breakdowns but no logged run time has operating minutes blank.
 */
export function mtbfRows(operating: Record<string, unknown>[], failures: Record<string, unknown>[], key?: 'Machine'): MtbfRow[] {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
  if (!key) {
    const op = num(operating[0]?.OperatingMin)
    const f = num(failures[0]?.Failures) ?? 0
    return [{ OperatingMin: op, Failures: f, MTBF: mtbf(op, f) }]
  }
  const norm = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : JSON.stringify(v ?? null))
  const out = new Map<string, MtbfRow>()
  for (const r of operating) out.set(norm(r[key]), { Machine: r[key], OperatingMin: num(r.OperatingMin), Failures: 0, MTBF: null })
  for (const r of failures) {
    const k = norm(r[key])
    const cur = out.get(k) ?? { Machine: r[key], OperatingMin: null, Failures: 0, MTBF: null }
    cur.Failures += num(r.Failures) ?? 0
    out.set(k, cur)
  }
  return [...out.values()].map((r) => ({ ...r, MTBF: mtbf(r.OperatingMin, r.Failures) }))
}

const pct = { style: 'percent' as const, decimals: 1 }
const OEE_BANDS = [{ from: 0, to: 0.6, status: 'bad' as const }, { from: 0.6, to: 0.85, status: 'warn' as const }, { from: 0.85, to: 1, status: 'good' as const }]

/** the built-in "Production overview" dashboard (seven tiles) over the minimal tables, with table names as given */
export function productionOverview(names: { log: string; downtime: string } = { log: PRODUCTION_LOG, downtime: DOWNTIME }): DashboardDef {
  const oee = PRESETS[0]!.query
  return {
    version: 1, title: 'Production overview', description: 'OEE, output, scrap and downtime. Built-in template over the minimal production tables.', range: 'thisMonth', refreshSeconds: 60,
    filters: [{ id: 'shift', label: 'Shift', column: 'Shift', options: ['A', 'B', 'C'] }],
    tiles: [
      { id: 'oee', title: 'OEE', kind: 'gauge', layout: { x: 0, y: 0, w: 3, h: 3 }, query: { ...oee, table: names.log }, visual: { series: [{ key: 'OEE', label: 'OEE', format: pct }], format: pct, bands: OEE_BANDS, min: 0, max: 1, target: 0.85 } },
      { id: 'good', title: 'Good quantity', kind: 'kpi', layout: { x: 3, y: 0, w: 3, h: 3 }, query: { table: names.log, measures: [{ id: 'Good', label: 'Good quantity', fn: 'sum', col: 'Good' }], dateColumn: logDate, compare: 'previousPeriod' }, visual: { kpi: { measure: 'Good', base: 'compare', higherIsBetter: true } } },
      { id: 'scrap', title: 'Scrap rate', kind: 'kpi', layout: { x: 6, y: 0, w: 3, h: 3 }, query: { ...PRESETS[1]!.query, table: names.log, compare: 'previousPeriod' }, visual: { format: pct, kpi: { measure: 'ScrapRate', base: 'compare', higherIsBetter: false, rules: [{ op: 'gt', value: 0.05, status: 'bad' }] } } },
      { id: 'avail', title: 'Availability, performance, quality', kind: 'bar', layout: { x: 9, y: 0, w: 3, h: 3 }, query: { ...oee, table: names.log, groupBy: ['Shift'] }, visual: { category: 'Shift', series: [{ key: 'Availability', format: pct }, { key: 'Performance', format: pct }, { key: 'Quality', format: pct }], format: pct } },
      { id: 'trend', title: 'Good quantity by day', kind: 'line', layout: { x: 0, y: 3, w: 8, h: 4 }, query: { table: names.log, bucket: { col: 'LoggedOn', unit: 'day' }, measures: [{ id: 'Good', label: 'Good quantity', fn: 'sum', col: 'Good' }], dateColumn: logDate, compare: 'previousPeriod' }, visual: { category: '__bucket', series: [{ key: 'Good', label: 'This period' }, { key: 'Good__cmp', label: 'Previous period', dashed: true }] } },
      { id: 'pareto', title: 'Downtime by reason', kind: 'pareto', crossFilter: false, layout: { x: 8, y: 3, w: 4, h: 4 }, query: { ...PRESETS[3]!.query, table: names.downtime }, visual: { category: 'Reason', series: [{ key: 'Minutes', label: 'Downtime minutes' }] } },
      { id: 'machines', title: 'Output by machine', kind: 'table', crossFilter: true, layout: { x: 0, y: 7, w: 12, h: 4 }, query: { ...oee, table: names.log, groupBy: ['Machine'], sort: { by: 'Good', dir: 'desc' } }, visual: { series: [{ key: 'Good', label: 'Good' }, { key: 'Total', label: 'Total' }, { key: 'Availability', label: 'Availability', format: pct }, { key: 'Performance', label: 'Performance', format: pct }, { key: 'Quality', label: 'Quality', format: pct }, { key: 'OEE', label: 'OEE', format: pct }], rules: [{ measure: 'OEE', op: 'lt', value: 0.6, status: 'bad' }, { measure: 'OEE', op: 'ge', value: 0.85, status: 'good' }] } },
    ],
  }
}

export interface SampleRows { log: Record<string, unknown>[]; downtime: Record<string, unknown>[] }

/**
 * SAMPLE data (clearly sample: machines "Sample press 1".."6"): `days` days of three shifts per machine ending at `end`,
 * deterministic for a seed. Row values are what the Data API takes (ISO instants).
 */
export function sampleProduction(end: Date, days = 60, seed = 42, machines = 6): SampleRows {
  const r = rng(seed)
  const log: Record<string, unknown>[] = []
  const downtime: Record<string, unknown>[] = []
  const reasons = ['Breakdown', 'Changeover', 'No material', 'No operator', 'Planned maintenance', 'Other']
  const weights = [0.32, 0.26, 0.16, 0.1, 0.1, 0.06]
  const pick = () => { let x = r(); for (let i = 0; i < reasons.length; i++) { x -= weights[i]!; if (x <= 0) return reasons[i]! } return 'Other' }
  const dayStart = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()) - days * 86_400_000
  for (let d = 0; d < days; d++) {
    for (let s = 0; s < 3; s++) {
      const shiftStart = dayStart + d * 86_400_000 + (0.5 + s * 8) * 3_600_000 // 06:00 / 14:00 / 22:00 India time
      if (shiftStart > end.getTime()) continue
      for (let m = 1; m <= machines; m++) {
        const planned = 450
        const down = Math.round(r() < 0.35 ? 10 + r() * 80 : r() * 15)
        const run = planned - down
        const ideal = 20 + m * 4
        const total = Math.floor((run * 60 / ideal) * (0.72 + r() * 0.25))
        const scrap = Math.floor(total * (0.005 + r() * (m === 4 ? 0.09 : 0.04)))
        log.push({ LoggedOn: new Date(shiftStart + 7.5 * 3_600_000).toISOString(), Shift: ['A', 'B', 'C'][s], Machine: `Sample press ${m}`, Good: total - scrap, Scrap: scrap, PlannedMin: planned, RunMin: run, IdealCycleSec: ideal })
        if (down >= 5) downtime.push({ StartedOn: new Date(shiftStart + r() * 6 * 3_600_000).toISOString(), Machine: `Sample press ${m}`, Reason: pick(), Minutes: down })
      }
    }
  }
  return { log, downtime }
}
