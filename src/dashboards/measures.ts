/**
 * The dashboard measure builder (P2-C): a tile's query spec -> Query v2 aggregate plans, and their results -> the rows a
 * visual draws. Pure (browser and server). Everything that needs rows runs in the database as aggregate plans under the
 * viewer's rights; only arithmetic over the aggregated rows happens here:
 *
 *  - computed measures: an expression over measure values (ratio of sums, OEE = A x P x Q), evaluated per output row
 *    after aggregation, never by averaging ratios; division by zero gives blank;
 *  - running totals: cumulative sums down the ordered rows;
 *  - period comparison: a second plan over the comparison range (previous period or same period last year), aligned
 *    to the main rows by group key, or by bucket position for date buckets (as `<measure>__cmp`);
 *  - targets: a third plan over a targets table, summed per group key (as `__target`);
 *  - date buckets are gap-filled over the range (missing periods are blank, so lines break and bars are absent).
 * docs/dev/dashboards.md documents each step; docs/dev/query-v2.md the plan features used.
 */
import type { BucketV2, ConditionV2, DateBucketUnit, MeasureFn, NumExprV2, QueryPlan } from '../platform/query.ts'
import type { Ymd } from '../fx/query/buckets.ts'
import { bucketOfDate, dayNumber, nextBucket, parseYmd, ymdText } from '../fx/query/buckets.ts'
import type { CalendarSettings, DateRange } from './dates.ts'
import { DEFAULT_CALENDAR, comparisonRange, rangeCondition } from './dates.ts'

export interface MeasureSpec {
  id: string
  label?: string
  fn: MeasureFn
  col?: string
  /** sum / avg / min / max of a calculation over the row instead of a column (Query v2 NumExprV2) */
  expr?: NumExprV2
  /** count only: rows where this holds */
  filter?: ConditionV2
}

/** expression over measure values of the same output row */
export type CalcExpr = number | { m: string } | { fn: 'add' | 'sub' | 'mul' | 'div'; args: [CalcExpr, CalcExpr] }

export interface ComputedSpec { id: string; label?: string; expr: CalcExpr }

export interface QuerySpec {
  /** table name or id */
  table: string
  /** group columns */
  groupBy?: string[]
  /** a date bucket (after the group columns) */
  bucket?: { col: string; unit: DateBucketUnit }
  measures: MeasureSpec[]
  computed?: ComputedSpec[]
  /** fixed filters of the tile */
  filter?: ConditionV2
  /** the dashboard's date range applies to this column */
  dateColumn?: { col: string; kind: 'date' | 'datetime' }
  sort?: { by: string; dir: 'asc' | 'desc' }
  top?: { n: number; others?: string }
  compare?: 'previousPeriod' | 'samePeriodLastYear'
  running?: string[]
  /** targets: sum of `valueCol` of `table` per group key (`keyCol` matches the first group column) under the same date range on `dateCol` */
  target?: { table: string; valueCol: string; keyCol?: string; dateCol?: { col: string; kind: 'date' | 'datetime' } }
}

export interface QueryContext {
  range: DateRange | null
  /** the viewer's local date-time: a comparison covers only the elapsed part of a range that is still running */
  now?: string
  /** dashboard filters for this table (dropdowns, cross-filter), already as conditions */
  filters?: ConditionV2[]
  calendar?: CalendarSettings
}

export interface CompiledQuery {
  main: QueryPlan
  compare?: QueryPlan
  target?: QueryPlan
}

export const isCountLike = (fn: MeasureFn) => fn === 'count' || fn === 'countDistinct'

/** the measure ids an expression reads */
export function calcRefs(e: CalcExpr, out: Set<string> = new Set()): Set<string> {
  if (typeof e === 'number') return out
  if ('m' in e) out.add(e.m)
  else for (const a of e.args) calcRefs(a, out)
  return out
}

export function evalCalc(e: CalcExpr, row: Record<string, unknown>): number | null {
  if (typeof e === 'number') return Number.isFinite(e) ? e : null
  if ('m' in e) {
    const v = row[e.m]
    return typeof v === 'number' && Number.isFinite(v) ? v : v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null
  }
  const a = evalCalc(e.args[0], row)
  const b = evalCalc(e.args[1], row)
  if (a === null || b === null) return null
  switch (e.fn) {
    case 'add': return a + b
    case 'sub': return a - b
    case 'mul': return a * b
    case 'div': return b === 0 ? null : a / b
  }
}

const and = (xs: (ConditionV2 | undefined)[]): ConditionV2 | undefined => {
  const list = xs.filter((x): x is ConditionV2 => !!x)
  return list.length === 0 ? undefined : list.length === 1 ? list[0] : { and: list }
}

function check(spec: QuerySpec): void {
  if (!spec.table) throw new Error('Choose a table.')
  if (!spec.measures.length) throw new Error('Add at least one measure.')
  const ids = new Set<string>()
  for (const m of [...spec.measures, ...(spec.computed ?? [])]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(m.id)) throw new Error(`"${m.id}" is not a valid measure name (letters, digits, _).`)
    if (ids.has(m.id)) throw new Error(`Two measures are called ${m.id}.`)
    ids.add(m.id)
  }
  for (const c of spec.computed ?? []) for (const r of calcRefs(c.expr)) if (!spec.measures.some((m) => m.id === r)) throw new Error(`${c.id} uses ${r}, which is not a measure of this tile.`)
  if (spec.sort && !ids.has(spec.sort.by) && !(spec.groupBy ?? []).includes(spec.sort.by) && spec.sort.by !== '__bucket') throw new Error(`Sort by ${spec.sort.by}: no such measure or group.`)
  if (spec.top?.others !== undefined && ((spec.groupBy ?? []).length !== 1 || spec.bucket)) throw new Error('"Others" needs exactly one group column and no date bucket.')
  if (spec.top?.others !== undefined && spec.sort && (spec.computed ?? []).some((c) => c.id === spec.sort!.by)) throw new Error('"Others" cannot be combined with sorting by a calculated measure.')
}

/** spec -> the aggregate plans (main; comparison and targets when asked) */
export function compileQuery(spec: QuerySpec, ctx: QueryContext): CompiledQuery {
  check(spec)
  const cal = ctx.calendar ?? DEFAULT_CALENDAR
  const groupBy = [...(spec.groupBy ?? [])]
  const buckets: BucketV2[] = spec.bucket ? [{ name: '__bucket', col: spec.bucket.col, unit: spec.bucket.unit, fiscalYearStart: cal.fiscalYearStart, weekStart: cal.weekStart, timeZone: cal.timeZone }] : []
  const measures = spec.measures.map((m) => ({ name: m.id, fn: m.fn, ...(m.fn === 'count' ? {} : m.expr !== undefined && m.fn !== 'countDistinct' ? { expr: m.expr } : { col: m.col }), ...(m.fn === 'count' && m.filter ? { filter: m.filter } : {}) }))
  // computed-measure sort keys are not plan columns: sort those after aggregation
  const planSortable = !spec.sort || spec.measures.some((m) => m.id === spec.sort!.by) || groupBy.includes(spec.sort.by) || spec.sort.by === '__bucket'
  const sort = spec.sort && planSortable ? [{ col: spec.sort.by, dir: spec.sort.dir }] : spec.bucket ? [{ col: '__bucket', dir: 'asc' as const }] : undefined
  const make = (range: DateRange | null): QueryPlan => ({
    version: 2,
    table: spec.table,
    ...(and([spec.filter, ...(ctx.filters ?? []), range && spec.dateColumn ? rangeCondition(spec.dateColumn.col, spec.dateColumn.kind, range, cal.timeZone) : undefined]) ? { filter: and([spec.filter, ...(ctx.filters ?? []), range && spec.dateColumn ? rangeCondition(spec.dateColumn.col, spec.dateColumn.kind, range, cal.timeZone) : undefined]) } : {}),
    aggregate: {
      groupBy, measures,
      ...(buckets.length ? { buckets } : {}),
      groupOrder: 'key',
      ...(sort ? { sort } : {}),
      ...(spec.top && planSortable ? { top: { n: spec.top.n, ...(spec.top.others !== undefined ? { others: spec.top.others } : {}) } } : {}),
    },
  })
  const out: CompiledQuery = { main: make(ctx.range) }
  if (spec.compare && ctx.range && spec.dateColumn) out.compare = make(comparisonRange(ctx.range, spec.compare, ctx.now))
  if (spec.target) {
    const t = spec.target
    const keyed = t.keyCol && groupBy.length ? [t.keyCol] : []
    out.target = {
      version: 2, table: t.table,
      ...(ctx.range && t.dateCol ? { filter: rangeCondition(t.dateCol.col, t.dateCol.kind, ctx.range, cal.timeZone) } : {}),
      aggregate: { groupBy: keyed, measures: [{ name: '__target', fn: 'sum', col: t.valueCol }], groupOrder: 'key' },
    }
  }
  return out
}

const keyText = (v: unknown): string => (v === null || v === undefined ? '\u0000' : v instanceof Date ? `d${v.getFullYear()}-${v.getMonth()}-${v.getDate()}` : String(v).toLowerCase())

function ymdOf(v: unknown): Ymd | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return [v.getFullYear(), v.getMonth() + 1, v.getDate()]
  return typeof v === 'string' ? parseYmd(v) : null
}

/** every bucket start of a range (at most 400; null when the unit is not a calendar unit or the range is open) */
export function bucketsOfRange(unit: DateBucketUnit, range: DateRange | null, cal: CalendarSettings): Ymd[] | null {
  if (!range || unit === 'weekday' || unit === 'hour') return null
  const a = parseYmd(range.from), b0 = parseYmd(range.to)
  if (!a || !b0) return null
  const endExclusive = range.to.slice(11, 16) && range.to.slice(11, 16) !== '00:00' ? [b0[0], b0[1], b0[2] + 1] as Ymd : b0
  const out: Ymd[] = []
  let cur = bucketOfDate(a, unit, cal) as Ymd
  while (dayNumber(cur) < dayNumber(endExclusive) && out.length < 400) {
    out.push(cur)
    cur = nextBucket(cur, unit)
  }
  return out
}

export interface FinishedRows { rows: Record<string, unknown>[]; measures: string[] }

/**
 * results -> the visual's rows: gap-filled buckets, computed measures, the comparison (`<id>__cmp`), running totals,
 * targets (`__target`), computed-measure sort and top. Every row keeps the group columns and `__bucket`.
 */
export function finishQuery(spec: QuerySpec, ctx: QueryContext, main: Record<string, unknown>[], compare?: Record<string, unknown>[], target?: Record<string, unknown>[]): FinishedRows {
  const cal = ctx.calendar ?? DEFAULT_CALENDAR
  const groupBy = spec.groupBy ?? []
  let rows = main.map((r) => ({ ...r }))
  const ids = spec.measures.map((m) => m.id)
  // gap filling (only with a bucket and no other group column)
  if (spec.bucket && !groupBy.length) {
    const all = bucketsOfRange(spec.bucket.unit, ctx.range, cal)
    if (all) {
      const have = new Map(rows.map((r) => [ymdOf(r.__bucket) ? ymdText(ymdOf(r.__bucket)!) : '', r]))
      const filled = all.map((b) => have.get(ymdText(b)) ?? { __bucket: new Date(b[0], b[1] - 1, b[2]), ...Object.fromEntries(ids.map((id) => [id, null])) })
      // rows outside the range (open ranges, NULL bucket) are kept at the end
      for (const r of rows) if (!all.some((b) => ymdOf(r.__bucket) && ymdText(b) === ymdText(ymdOf(r.__bucket)!))) filled.push(r)
      rows = filled
    }
  }
  for (const c of spec.computed ?? []) for (const r of rows) r[c.id] = evalCalc(c.expr, r)
  const valueIds = [...ids, ...(spec.computed ?? []).map((c) => c.id)]
  if (compare) {
    const cmp = compare.map((r) => ({ ...r }))
    for (const c of spec.computed ?? []) for (const r of cmp) r[c.id] = evalCalc(c.expr, r)
    if (spec.bucket && !groupBy.length && ctx.range && spec.compare) {
      // align by bucket position: the n-th period of the range with the n-th period of the comparison range
      const mine = bucketsOfRange(spec.bucket.unit, ctx.range, cal) ?? []
      const theirs = bucketsOfRange(spec.bucket.unit, comparisonRange(ctx.range, spec.compare), cal) ?? []  // whole range: positions align with the main buckets
      const byKey = new Map(cmp.map((r) => [ymdOf(r.__bucket) ? ymdText(ymdOf(r.__bucket)!) : '', r]))
      for (const r of rows) {
        const b = ymdOf(r.__bucket)
        const i = b ? mine.findIndex((x) => ymdText(x) === ymdText(b)) : -1
        const other = i >= 0 && theirs[i] ? byKey.get(ymdText(theirs[i]!)) : undefined
        for (const id of valueIds) r[`${id}__cmp`] = (other?.[id] as number | null | undefined) ?? null
      }
    } else {
      const key = (r: Record<string, unknown>) => groupBy.map((g) => keyText(r[g])).join('\u0001')
      const byKey = new Map(cmp.map((r) => [key(r), r]))
      for (const r of rows) {
        const other = byKey.get(key(r))
        for (const id of valueIds) r[`${id}__cmp`] = (other?.[id] as number | null | undefined) ?? null
      }
    }
  }
  if (target) {
    if (spec.target?.keyCol && groupBy.length) {
      const byKey = new Map(target.map((t) => [keyText(t[spec.target!.keyCol!]), t.__target]))
      for (const r of rows) r.__target = (byKey.get(keyText(r[groupBy[0]!])) as number | undefined) ?? null
    } else for (const r of rows) r.__target = (target[0]?.__target as number | undefined) ?? null
  }
  // computed-measure sort and top (plan sorting could not see them)
  if (spec.sort && !spec.measures.some((m) => m.id === spec.sort!.by) && !groupBy.includes(spec.sort.by) && spec.sort.by !== '__bucket') {
    const by = spec.sort.by
    const dir = spec.sort.dir === 'desc' ? -1 : 1
    rows = rows.map((r, i) => ({ r, i })).sort((a, b) => {
      const x = a.r[by] as number | null, y = b.r[by] as number | null
      if (x === y) return a.i - b.i
      if (x === null) return 1
      if (y === null) return -1
      return (x - y) * dir || a.i - b.i
    }).map((x) => x.r)
    if (spec.top) rows = rows.slice(0, spec.top.n)
  }
  for (const id of spec.running ?? []) {
    let acc = 0
    for (const r of rows) {
      const v = r[id]
      if (typeof v === 'number') acc += v
      r[`${id}__run`] = typeof v === 'number' ? acc : null
    }
  }
  return { rows, measures: valueIds }
}
