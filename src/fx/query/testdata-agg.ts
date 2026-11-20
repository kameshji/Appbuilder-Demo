/**
 * Deterministic corpus of aggregate plans for the P2-C plan extensions (count distinct, date buckets, groupOrder "key",
 * top N with others): run by the reference executor in aggregates.test.ts and, against real PostgreSQL, by
 * server/connectors/postgres/query-v2-aggregates.integration.test.ts (every plan must give the same rows in the same
 * order). Test helper only.
 */
import type { AggregateV2, BucketV2, DateBucketUnit, MeasureV2, QueryPlan } from '../../platform/query.ts'
import { rng } from './testdata.ts'

const UNITS: DateBucketUnit[] = ['day', 'week', 'month', 'quarter', 'year', 'fiscalQuarter', 'fiscalYear', 'weekday']
const ZONES = ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Chatham']

const MEASURE_SETS: MeasureV2[][] = [
  [{ name: 'N', fn: 'count' }],
  [{ name: 'N', fn: 'count' }, { name: 'S', fn: 'sum', col: 'Priority' }],
  [{ name: 'A', fn: 'avg', col: 'Score' }, { name: 'Lo', fn: 'min', col: 'Priority' }, { name: 'Hi', fn: 'max', col: 'Priority' }],
  [{ name: 'DS', fn: 'countDistinct', col: 'Status' }, { name: 'DO', fn: 'countDistinct', col: 'Owner' }],
  [{ name: 'DD', fn: 'countDistinct', col: 'Due' }, { name: 'DA', fn: 'countDistinct', col: 'Active' }, { name: 'DP', fn: 'countDistinct', col: 'Priority' }],
  [{ name: 'X', fn: 'sum', expr: { fn: 'mul', args: [{ col: 'Priority' }, 2] } }, { name: 'Open', fn: 'count', filter: { col: 'Status', op: 'eq', value: 'open' } }],
]

export function aggregateCorpus(): QueryPlan[] {
  const out: QueryPlan[] = []
  const r = rng(20261119)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const base = (aggregate: AggregateV2, extra: Partial<QueryPlan> = {}): QueryPlan => ({ version: 2, table: 'Tickets', aggregate, ...extra })
  // count distinct in both group orders, with and without groups
  for (const ms of MEASURE_SETS) {
    out.push(base({ groupBy: [], measures: ms }))
    out.push(base({ groupBy: [], measures: ms, groupOrder: 'key' }))
    for (const g of ['Status', 'Title', 'Active', 'Priority', 'Due', 'Owner']) {
      out.push(base({ groupBy: [g], measures: ms }))
      out.push(base({ groupBy: [g], measures: ms, groupOrder: 'key' }))
      out.push(base({ groupBy: [g], measures: ms, groupOrder: 'key', sort: [{ col: ms[0]!.name, dir: 'desc' }] }))
    }
  }
  // buckets over date and datetime columns, every unit, fiscal years and weeks, time zones
  for (const unit of UNITS) {
    for (const col of ['Due', 'Start', 'Updated']) {
      const b: BucketV2 = { name: 'Period', col, unit }
      if (unit === 'week') b.weekStart = pick([1, 7] as const)
      if (unit === 'fiscalYear' || unit === 'fiscalQuarter') b.fiscalYearStart = pick([1, 4, 7, 10])
      if (col === 'Updated') b.timeZone = pick(ZONES)
      const ms = pick(MEASURE_SETS)
      out.push(base({ groupBy: [], buckets: [b], measures: ms, groupOrder: 'key' }))
      out.push(base({ groupBy: [], buckets: [b], measures: ms }))
      out.push(base({ groupBy: ['Status'], buckets: [b], measures: ms, groupOrder: 'key' }))
      out.push(base({ groupBy: [], buckets: [b], measures: ms, groupOrder: 'key', sort: [{ col: 'Period', dir: 'desc' }] }))
    }
  }
  for (const tz of ZONES) out.push(base({ groupBy: [], buckets: [{ name: 'H', col: 'Updated', unit: 'hour', timeZone: tz }], measures: [{ name: 'N', fn: 'count' }], groupOrder: 'key' }))
  // two buckets (heatmap shape: weekday x hour)
  out.push(base({ groupBy: [], buckets: [{ name: 'D', col: 'Updated', unit: 'weekday', timeZone: 'Asia/Kolkata' }, { name: 'H', col: 'Updated', unit: 'hour', timeZone: 'Asia/Kolkata' }], measures: [{ name: 'N', fn: 'count' }], groupOrder: 'key' }))
  // top N, with and without others; filters and take before the aggregate
  for (const n of [0, 1, 2, 3, 5, 50]) {
    for (const g of ['Status', 'Title', 'Owner']) {
      const ms = pick(MEASURE_SETS)
      out.push(base({ groupBy: [g], measures: ms, groupOrder: 'key', sort: [{ col: ms[0]!.name, dir: 'desc' }], top: { n } }))
      out.push(base({ groupBy: [g], measures: ms, groupOrder: 'key', sort: [{ col: ms[0]!.name, dir: 'desc' }], top: { n, others: 'Others' } }))
      out.push(base({ groupBy: [g], measures: ms, groupOrder: 'key', top: { n, others: 'Rest' } }, { filter: { col: 'Active', op: 'eq', value: true } }))
    }
    out.push(base({ groupBy: ['Priority'], measures: [{ name: 'N', fn: 'count' }], groupOrder: 'key', sort: [{ col: 'N', dir: 'desc' }], top: { n } }))
  }
  out.push(base({ groupBy: ['Status'], measures: [{ name: 'N', fn: 'count' }, { name: 'DT', fn: 'countDistinct', col: 'Title' }], groupOrder: 'key', top: { n: 2, others: 'Others' } }, { sort: [{ col: 'Priority', dir: 'desc' }], take: { n: 15, from: 'start' } }))
  out.push(base({ groupBy: ['Status'], buckets: [{ name: 'M', col: 'Due', unit: 'month' }], measures: [{ name: 'N', fn: 'count' }], groupOrder: 'key' }, { take: { n: 20, from: 'end' }, sort: [{ col: 'Due', dir: 'asc' }] }))
  out.push(base({ groupBy: ['Status'], measures: [{ name: 'N', fn: 'count' }], groupOrder: 'key', top: { n: 2, others: 'Others' } }, { filter: { const: false } }))
  out.push(base({ groupBy: [], buckets: [{ name: 'M', col: 'Due', unit: 'month' }], measures: [{ name: 'S', fn: 'sum', col: 'Priority' }], groupOrder: 'key' }, { filter: { col: 'Due', op: 'ge', value: { $date: '2026-04-01' } }, count: true }))
  return out
}
