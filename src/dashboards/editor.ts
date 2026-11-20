/**
 * The visual tile query editor's logic (P2-C, Phase 2 wave 1), pure: no React, DOM or packages; shared-code rules.
 * The React screen is src/portal/dashboards/TileEditor.tsx; docs/dev/dashboards.md ("Tile editor") documents it.
 *
 * Design: the editor's state IS the draft TileDef. Every operation here takes a tile and returns a new tile, copying the
 * objects it does not change and spreading the ones it does, so fields the editor has no screen for (a measure's row
 * calculation, nested conditions, series colours, fields added by later versions) survive editing untouched. Only two
 * parts have a separate form model, and both round-trip exactly or are left alone:
 *  - conditions (the tile filter, a count's condition): `simpleFilterOf` returns rows of "column, operator, value"
 *    joined by all / any ONLY when re-encoding them gives back the identical condition; otherwise the UI shows the
 *    condition in words and keeps it as it is;
 *  - computed measures: `simpleCalcOf` returns "operand, operator, operand" under the same rule.
 * Plus: defaults per column type, validation in plain English, human-readable summaries, and the upsert into the
 * dashboard definition through checkDashboardDef.
 */
import type { ColumnType } from '../platform/contracts.ts'
import type { CompareOpV2, ConditionV2, DateBucketUnit, MeasureFn, NumExprV2, QueryLiteral } from '../platform/query.ts'
import { columnKind } from '../platform/query.ts'
import type { NumberFormat } from '../charts/format.ts'
import type { SeriesSpec } from '../charts/geometry.ts'
import type { CalcExpr, ComputedSpec, MeasureSpec, QuerySpec } from './measures.ts'
import { calcRefs, compileQuery } from './measures.ts'
import type { DashboardDef, TileDef, TileKind, TileVisual } from './types.ts'
import { MAX_TILES, TILE_KINDS, checkDashboardDef } from './types.ts'
import { localNow, zonedInstant } from './dates.ts'

/* ------------------------------------------------------------------ columns */

export type ValueKind = 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'other'

/** a table column as the editor sees it */
export interface EditorColumn { name: string; label: string; type: ColumnType; kind: ValueKind; choices?: string[] }

export function editorColumns(cols: { name: string; displayName?: string; type: ColumnType; choices?: string[] }[]): EditorColumn[] {
  return cols.map((c) => ({ name: c.name, label: c.displayName || c.name, type: c.type, kind: columnKind(c.type), ...(c.choices?.length ? { choices: c.choices } : {}) }))
}

const findCol = (cols: EditorColumn[] | null | undefined, name: string | undefined): EditorColumn | undefined =>
  name === undefined || !cols ? undefined : cols.find((c) => c.name.toLowerCase() === name.toLowerCase())

export const numericColumns = (cols: EditorColumn[]) => cols.filter((c) => c.kind === 'number')
export const dateColumns = (cols: EditorColumn[]) => cols.filter((c) => c.kind === 'date' || c.kind === 'datetime')
/** columns a tile can group by: anything with comparable values */
export const groupableColumns = (cols: EditorColumn[]) => cols.filter((c) => c.kind !== 'other')

/** the aggregate functions offered for a column kind (count needs no column) */
export function measureFnsFor(kind: ValueKind | undefined): MeasureFn[] {
  if (kind === 'number') return ['sum', 'avg', 'min', 'max', 'count', 'countDistinct']
  if (kind === undefined) return ['count']
  if (kind === 'other') return ['count']
  return ['count', 'countDistinct']
}

/* ------------------------------------------------------------------ labels */

export const TILE_KIND_LABELS: Record<TileKind, string> = {
  bar: 'Bar chart', line: 'Line chart', area: 'Area chart', combo: 'Combination chart', pie: 'Pie chart', donut: 'Donut chart', scatter: 'Scatter chart',
  heatmap: 'Heat map', gauge: 'Gauge', bullet: 'Bullet chart', kpi: 'KPI (one number)', funnel: 'Funnel', pareto: 'Pareto chart', histogram: 'Histogram',
  timeline: 'Timeline', table: 'Table', text: 'Text',
}
export const TILE_KIND_OPTIONS: TileKind[] = [...TILE_KINDS]

export const MEASURE_FN_LABELS: Record<MeasureFn, string> = { sum: 'Sum', avg: 'Average', min: 'Minimum', max: 'Maximum', count: 'Count of rows', countDistinct: 'Count of different values' }

export const BUCKET_UNIT_LABELS: Record<DateBucketUnit, string> = {
  day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year', fiscalQuarter: 'Fiscal quarter', fiscalYear: 'Fiscal year', weekday: 'Day of the week', hour: 'Hour of the day',
}
/** bucket units offered for a column kind (hour only for date-and-time columns) */
export function bucketUnitsFor(kind: ValueKind | undefined): DateBucketUnit[] {
  const all: DateBucketUnit[] = ['day', 'week', 'month', 'quarter', 'year', 'fiscalQuarter', 'fiscalYear', 'weekday', 'hour']
  return kind === 'datetime' ? all : all.filter((u) => u !== 'hour')
}

export const COMPARE_LABELS = { previousPeriod: 'Previous period', samePeriodLastYear: 'Same period last year' } as const

/* ------------------------------------------------------------------ ids */

const ID_RE = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/
export const isValidId = (s: string) => ID_RE.test(s)

/** a measure name (letters, digits, _; at most 41 characters) from a hint, not in `taken` (case-insensitive) */
export function uniqueId(hint: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((t) => t.toLowerCase()))
  let base = hint.replace(/[^A-Za-z0-9_]+/g, '').slice(0, 36)
  if (!base || !/^[A-Za-z_]/.test(base)) base = `M${base}`.slice(0, 36)
  if (!used.has(base.toLowerCase())) return base
  for (let i = 2; ; i++) if (!used.has(`${base}${i}`.toLowerCase())) return `${base}${i}`
}

/** every name used inside a query: measures, computed measures, group columns, "__bucket" */
export function valueIds(q: QuerySpec | undefined): string[] {
  return q ? [...q.measures.map((m) => m.id), ...(q.computed ?? []).map((c) => c.id)] : []
}

/* ------------------------------------------------------------------ tiles */

const clone = <T>(x: T): T => (x === undefined ? x : JSON.parse(JSON.stringify(x)) as T)

function withQuery(tile: TileDef, f: (q: QuerySpec) => QuerySpec): TileDef {
  return { ...tile, query: f(tile.query ?? { table: '', measures: [] }) }
}
function withVisual(tile: TileDef, f: (v: TileVisual) => TileVisual): TileDef {
  const v = f({ ...(tile.visual ?? {}) })
  const out: TileDef = { ...tile, visual: v }
  if (!Object.keys(v).length) delete out.visual
  return out
}
/** drops keys whose value is undefined (so a spread with "unset" fields does not leave `key: undefined` behind) */
function tidy<T extends object>(o: T): T {
  const out = { ...o } as Record<string, unknown>
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out as T
}

/** the next free place on the grid: below every tile */
export function nextLayout(def: DashboardDef, w = 4, h = 3): TileDef['layout'] {
  const y = def.tiles.reduce((m, t) => Math.max(m, t.layout.y + t.layout.h), 0)
  return { x: 0, y, w, h }
}

export function newTileId(def: DashboardDef): string {
  const ids = new Set(def.tiles.map((t) => t.id))
  for (let i = def.tiles.length + 1; ; i++) if (!ids.has(`t${i}`)) return `t${i}`
}

/** a new tile on a table: count of rows, a bar chart, the first date column as the dashboard range's column */
export function newTile(def: DashboardDef, table?: string, cols?: EditorColumn[]): TileDef {
  const t: TileDef = { id: newTileId(def), title: 'New tile', kind: 'bar', layout: nextLayout(def), query: { table: '', measures: [{ id: 'Rows', label: 'Rows', fn: 'count' }] } }
  return table && cols ? setTable(t, table, cols) : t
}

/**
 * choose the table. A different table resets what depended on the old one's columns (group columns, bucket, date
 * column, filter, column measures); measures that need no column (count without condition) stay.
 */
export function setTable(tile: TileDef, table: string, cols: EditorColumn[]): TileDef {
  const q = tile.query
  if (q && q.table.toLowerCase() === table.toLowerCase()) return tile
  const d = dateColumns(cols)[0]
  const measures = (q?.measures ?? []).filter((m) => m.fn === 'count' && !m.filter && m.expr === undefined)
  const keep: QuerySpec = { table, measures: measures.length ? measures : [{ id: 'Rows', label: 'Rows', fn: 'count' }] }
  if (d) keep.dateColumn = { col: d.name, kind: d.kind as 'date' | 'datetime' }
  const out: TileDef = { ...tile, query: keep }
  if (out.visual) {
    const v = { ...out.visual }
    delete v.category; delete v.series; delete v.row; delete v.kpi; delete v.rules
    out.visual = v
    if (!Object.keys(v).length) delete out.visual
  }
  return out
}

/** change the kind; a KPI gets a measure to show (and the comparison or target as its base when the query has one) */
export function setKind(tile: TileDef, kind: TileKind): TileDef {
  let t: TileDef = { ...tile, kind }
  if (kind === 'kpi' && !t.visual?.kpi) {
    const ids = valueIds(t.query)
    if (ids.length) t = withVisual(t, (v) => ({ ...v, kpi: tidy({ measure: ids[ids.length - 1]!, base: t.query?.compare ? 'compare' as const : t.query?.target ? 'target' as const : undefined, higherIsBetter: true }) }))
  }
  if (kind === 'text' && t.text === undefined) t.text = ''
  return t
}

/* ------------------------------------------------------------------ measures */

/** a measure with sensible defaults for a column: sum of numbers, count of different values otherwise, count of rows without a column */
export function defaultMeasure(col: EditorColumn | undefined, taken: Iterable<string>): MeasureSpec {
  if (!col) return { id: uniqueId('Rows', taken), label: 'Rows', fn: 'count' }
  if (col.kind === 'number') return { id: uniqueId(col.name, taken), label: col.label, fn: 'sum', col: col.name }
  return { id: uniqueId(`${col.name}Count`, taken), label: `Different ${col.label}`, fn: 'countDistinct', col: col.name }
}

export function addMeasure(tile: TileDef, col: EditorColumn | undefined): TileDef {
  const m = defaultMeasure(col, valueIds(tile.query))
  let t = withQuery(tile, (q) => ({ ...q, measures: [...q.measures, m] }))
  if (t.visual?.series) t = withVisual(t, (v) => ({ ...v, series: [...(v.series ?? []), { key: m.id, label: m.label ?? m.id }] }))
  return t
}

/** change a measure's function; switching keeps the column where it still makes sense and drops what no longer applies */
export function setMeasureFn(tile: TileDef, id: string, fn: MeasureFn, cols: EditorColumn[]): TileDef {
  return withQuery(tile, (q) => ({
    ...q,
    measures: q.measures.map((m) => {
      if (m.id !== id || m.fn === fn) return m
      const n: MeasureSpec = { ...m, fn }
      if (fn === 'count') { delete n.col; delete n.expr }
      else delete n.filter
      if (fn === 'countDistinct') delete n.expr
      if (fn !== 'count' && n.col === undefined && n.expr === undefined) {
        const pick = fn === 'countDistinct' ? groupableColumns(cols)[0] : numericColumns(cols)[0]
        if (pick) n.col = pick.name
      }
      if ((fn === 'sum' || fn === 'avg' || fn === 'min' || fn === 'max') && n.col !== undefined && findCol(cols, n.col) && findCol(cols, n.col)!.kind !== 'number') {
        const pick = numericColumns(cols)[0]
        if (pick) n.col = pick.name; else delete n.col
      }
      return n
    }),
  }))
}

/** measure a column (replaces a row calculation) */
export function setMeasureColumn(tile: TileDef, id: string, col: string): TileDef {
  return withQuery(tile, (q) => ({ ...q, measures: q.measures.map((m) => { if (m.id !== id) return m; const n = { ...m, col }; delete n.expr; return n }) }))
}

export function setMeasureFilter(tile: TileDef, id: string, filter: ConditionV2 | undefined): TileDef {
  return withQuery(tile, (q) => ({ ...q, measures: q.measures.map((m) => (m.id !== id ? m : tidy({ ...m, filter }))) }))
}

/** the label of a measure or computed measure; a series showing it follows unless the series has a label of its own */
export function setValueLabel(tile: TileDef, id: string, label: string): TileDef {
  const l = label.trim() ? label : undefined
  const q0 = tile.query
  const old = q0?.measures.find((m) => m.id === id)?.label ?? q0?.computed?.find((c) => c.id === id)?.label ?? id
  let t = withQuery(tile, (q) => ({
    ...q,
    measures: q.measures.map((m) => (m.id === id ? tidy({ ...m, label: l }) : m)),
    ...(q.computed ? { computed: q.computed.map((c) => (c.id === id ? tidy({ ...c, label: l }) : c)) } : {}),
  }))
  const follows = (s: SeriesSpec) => s.key === id && (s.label === undefined || s.label === old)
  if (t.visual?.series?.some(follows)) t = withVisual(t, (v) => ({ ...v, series: v.series!.map((s) => (follows(s) && s.label !== undefined ? tidy({ ...s, label: l }) : s)) }))
  return t
}

const renameKey = (k: string, from: string, to: string) => (k === from ? to : k.startsWith(`${from}__`) ? `${to}${k.slice(from.length)}` : k)

function renameCalc(e: CalcExpr, from: string, to: string): CalcExpr {
  if (typeof e === 'number') return e
  if ('m' in e) return e.m === from ? { ...e, m: to } : e
  return { ...e, args: [renameCalc(e.args[0], from, to), renameCalc(e.args[1], from, to)] }
}

/**
 * rename a measure or computed measure and every reference to it: computed expressions, sort, running totals, the
 * chart's series and category, the KPI, the table's colour rules. Throws when the name is invalid or taken.
 */
export function renameValue(tile: TileDef, from: string, to: string): TileDef {
  if (from === to) return tile
  if (!isValidId(to)) throw new Error(`"${to}" cannot be used as a name: start with a letter, then letters, digits or _ (at most 41).`)
  if (valueIds(tile.query).some((x) => x.toLowerCase() === to.toLowerCase() && x !== from)) throw new Error(`There is already a measure called ${to}.`)
  let t = withQuery(tile, (q) => tidy({
    ...q,
    measures: q.measures.map((m) => (m.id === from ? { ...m, id: to } : m)),
    computed: q.computed?.map((c) => ({ ...(c.id === from ? { ...c, id: to } : c), expr: renameCalc(c.expr, from, to) })),
    sort: q.sort ? { ...q.sort, by: renameKey(q.sort.by, from, to) } : undefined,
    running: q.running?.map((r) => renameKey(r, from, to)),
  }))
  if (t.visual) {
    t = withVisual(t, (v) => tidy({
      ...v,
      series: v.series?.map((s) => ({ ...s, key: renameKey(s.key, from, to) })),
      category: v.category !== undefined ? renameKey(v.category, from, to) : undefined,
      kpi: v.kpi ? tidy({ ...v.kpi, measure: renameKey(v.kpi.measure, from, to), spark: v.kpi.spark !== undefined ? renameKey(v.kpi.spark, from, to) : undefined }) : undefined,
      rules: v.rules?.map((r) => ({ ...r, measure: renameKey(r.measure, from, to) })),
    }))
  }
  return t
}

/** remove a measure or computed measure, and the series, sort, running total, KPI and rules that showed it */
export function removeValue(tile: TileDef, id: string): TileDef {
  const gone = (k: string) => k === id || k.startsWith(`${id}__`)
  let t = withQuery(tile, (q) => {
    const n: QuerySpec = { ...q, measures: q.measures.filter((m) => m.id !== id) }
    if (q.computed) { n.computed = q.computed.filter((c) => c.id !== id); if (!n.computed.length) delete n.computed }
    if (q.sort && gone(q.sort.by)) delete n.sort
    if (q.running) { n.running = q.running.filter((r) => !gone(r)); if (!n.running.length) delete n.running }
    return n
  })
  if (t.visual) {
    t = withVisual(t, (v) => {
      const n = { ...v }
      if (v.series) n.series = v.series.filter((s) => !gone(s.key))
      if (v.kpi && gone(v.kpi.measure)) delete n.kpi
      else if (v.kpi?.spark !== undefined && gone(v.kpi.spark)) { n.kpi = { ...v.kpi }; delete n.kpi.spark }
      if (v.rules) { n.rules = v.rules.filter((r) => !gone(r.measure)); if (!n.rules.length) delete n.rules }
      return n
    })
  }
  return t
}

/** which measures a removal would break: computed measures that read it */
export function usersOf(q: QuerySpec, id: string): string[] {
  return (q.computed ?? []).filter((c) => calcRefs(c.expr).has(id)).map((c) => c.id)
}

/* ------------------------------------------------------------------ computed measures */

export type CalcOp = 'add' | 'sub' | 'mul' | 'div'
export const CALC_OP_LABELS: Record<CalcOp, string> = { add: '+', sub: '−', mul: '×', div: '÷' }
export type CalcOperand = { m: string } | number
/** the simple form: one operand, or two operands and an operator */
export interface SimpleCalc { a: CalcOperand; op?: CalcOp; b?: CalcOperand }

const isOperand = (e: CalcExpr): e is CalcOperand => typeof e === 'number' || 'm' in e

export function calcOfSimple(s: SimpleCalc): CalcExpr {
  return s.op && s.b !== undefined ? { fn: s.op, args: [s.a, s.b] } : s.a
}

/** the simple form of an expression, or null when it is nested (the UI then shows it in words and keeps it) */
export function simpleCalcOf(e: CalcExpr): SimpleCalc | null {
  if (isOperand(e)) return { a: e }
  if (!('fn' in e) || !Array.isArray(e.args) || e.args.length !== 2) return null
  const [a, b] = e.args
  if (!isOperand(a) || !isOperand(b)) return null
  const s: SimpleCalc = { a, op: e.fn, b }
  return JSON.stringify(calcOfSimple(s)) === JSON.stringify(e) ? s : null
}

export function addComputed(tile: TileDef): TileDef {
  const ms = tile.query?.measures ?? []
  const a = ms[0], b = ms[1]
  const expr: CalcExpr = a && b ? { fn: 'div', args: [{ m: a.id }, { m: b.id }] } : a ? { m: a.id } : 0
  const c: ComputedSpec = { id: uniqueId(a && b ? `${a.id}Per${b.id}` : 'Calc', valueIds(tile.query)), label: a && b ? `${a.label ?? a.id} / ${b.label ?? b.id}` : 'Calculation', expr }
  let t = withQuery(tile, (q) => ({ ...q, computed: [...(q.computed ?? []), c] }))
  if (t.visual?.series) t = withVisual(t, (v) => ({ ...v, series: [...(v.series ?? []), { key: c.id, label: c.label ?? c.id }] }))
  return t
}

export function setComputedExpr(tile: TileDef, id: string, expr: CalcExpr): TileDef {
  return withQuery(tile, (q) => ({ ...q, computed: (q.computed ?? []).map((c) => (c.id === id ? { ...c, expr } : c)) }))
}

/** a computed measure in words: "Good ÷ Total", "(Run ÷ Planned) × (IdealMin ÷ Run)" */
export function describeCalc(e: CalcExpr, labelOf: (id: string) => string = (x) => x): string {
  const go = (x: CalcExpr, top: boolean): string => {
    if (typeof x === 'number') return String(x)
    if ('m' in x) return labelOf(x.m)
    const s = `${go(x.args[0], false)} ${CALC_OP_LABELS[x.fn]} ${go(x.args[1], false)}`
    return top ? s : `(${s})`
  }
  return go(e, true)
}

/* ------------------------------------------------------------------ conditions */

export type FilterOp = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'contains' | 'startsWith' | 'endsWith' | 'isNull' | 'notNull'
export const FILTER_OP_LABELS: Record<FilterOp, string> = {
  eq: 'is', ne: 'is not', lt: 'is less than', le: 'is at most', gt: 'is more than', ge: 'is at least',
  contains: 'contains', startsWith: 'starts with', endsWith: 'ends with', isNull: 'is blank', notNull: 'is not blank',
}
const DATE_OP_LABELS: Partial<Record<FilterOp, string>> = { lt: 'is before', le: 'is on or before', gt: 'is after', ge: 'is on or after' }
export const filterOpLabel = (op: FilterOp, kind: ValueKind) => ((kind === 'date' || kind === 'datetime') && DATE_OP_LABELS[op]) || FILTER_OP_LABELS[op]

export function filterOpsFor(kind: ValueKind): FilterOp[] {
  switch (kind) {
    case 'text': return ['eq', 'ne', 'contains', 'startsWith', 'endsWith', 'isNull', 'notNull']
    case 'boolean': return ['eq', 'ne', 'isNull', 'notNull']
    case 'number': case 'date': case 'datetime': return ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'isNull', 'notNull']
    default: return ['isNull', 'notNull']
  }
}
export const opNeedsValue = (op: FilterOp) => op !== 'isNull' && op !== 'notNull'

/** one row of the simple condition builder. `value` is what the maker typed (dates YYYY-MM-DD, date-times YYYY-MM-DDTHH:MM in the dashboard time zone) */
export interface FilterRow { col: string; kind: ValueKind; op: FilterOp; value: string; exact?: true }
export interface SimpleFilter { join: 'and' | 'or'; rows: FilterRow[] }

/** the value typed for a row -> the literal of its column kind; throws with a plain message when it does not fit */
export function literalOf(row: FilterRow, timeZone: string): QueryLiteral {
  const v = row.value.trim()
  switch (row.kind) {
    case 'number': {
      if (v === '' || !Number.isFinite(Number(v))) throw new Error(`"${row.value}" is not a number (${row.col}).`)
      return Number(v)
    }
    case 'boolean':
      if (/^(true|yes)$/i.test(v)) return true
      if (/^(false|no)$/i.test(v)) return false
      throw new Error(`Choose yes or no (${row.col}).`)
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`Enter a date for ${row.col}.`)
      return { $date: v }
    case 'datetime':
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) throw new Error(`Enter a date and time for ${row.col}.`)
      return { $datetime: zonedInstant(v, timeZone).toISOString() }
    default:
      return row.value
  }
}

function rowCondition(r: FilterRow, timeZone: string): ConditionV2 {
  if (r.op === 'isNull') return { col: r.col, op: 'isNull' }
  if (r.op === 'notNull') return { not: { col: r.col, op: 'isNull' } }
  const value = literalOf(r, timeZone)
  if (r.op === 'contains' || r.op === 'startsWith' || r.op === 'endsWith') return { col: r.col, op: r.op, value: String(value), ...(r.exact ? { exact: true as const } : {}) }
  return { col: r.col, op: r.op as CompareOpV2, value, ...(r.exact ? { exact: true as const } : {}) }
}

/** the simple builder's rows -> a condition (undefined when there are none); throws when a value does not fit its column */
export function conditionOfSimple(s: SimpleFilter, timeZone: string): ConditionV2 | undefined {
  const list = s.rows.map((r) => rowCondition(r, timeZone))
  return list.length === 0 ? undefined : list.length === 1 ? list[0] : s.join === 'or' ? { or: list } : { and: list }
}

function rowOf(c: ConditionV2, cols: EditorColumn[] | null, timeZone: string): FilterRow | null {
  if ('not' in c) {
    const n = c.not
    return 'col' in n && n.op === 'isNull' ? { col: n.col, kind: findCol(cols, n.col)?.kind ?? 'text', op: 'notNull', value: '' } : null
  }
  if (!('col' in c) || !('op' in c)) return null
  const kindFromCol = findCol(cols, c.col)?.kind
  if (c.op === 'isNull') return { col: c.col, kind: kindFromCol ?? 'text', op: 'isNull', value: '' }
  if (c.op === 'in' || c.op === 'cmpCol') return null
  const v = (c as { value: QueryLiteral }).value
  const exact = (c as { exact?: true }).exact ? { exact: true as const } : {}
  if (typeof v === 'string') return { col: c.col, kind: 'text', op: c.op as FilterOp, value: v, ...exact }
  if (typeof v === 'number') return { col: c.col, kind: 'number', op: c.op as FilterOp, value: String(v), ...exact }
  if (typeof v === 'boolean') return { col: c.col, kind: 'boolean', op: c.op as FilterOp, value: v ? 'true' : 'false', ...exact }
  if (v && typeof v === 'object' && '$date' in v) return { col: c.col, kind: 'date', op: c.op as FilterOp, value: v.$date, ...exact }
  if (v && typeof v === 'object' && '$datetime' in v) {
    const d = new Date(v.$datetime)
    return Number.isNaN(d.getTime()) ? null : { col: c.col, kind: 'datetime', op: c.op as FilterOp, value: localNow(d, timeZone), ...exact }
  }
  return null
}

/**
 * a condition -> the simple builder's rows, or null when it does not fit the builder exactly (nested groups, "one of",
 * column-to-column comparisons, calculations, lookups, seconds in a date-time...). Guarantee: when the result is not
 * null, conditionOfSimple(result) is the identical condition.
 */
export function simpleFilterOf(c: ConditionV2 | undefined, cols: EditorColumn[] | null, timeZone: string): SimpleFilter | null {
  if (c === undefined) return { join: 'and', rows: [] }
  let s: SimpleFilter | null = null
  const list = 'and' in c ? c.and : 'or' in c ? c.or : null
  if (list) {
    const rows = list.map((x) => rowOf(x, cols, timeZone))
    if (rows.every((r): r is FilterRow => !!r) && rows.length > 1) s = { join: 'and' in c ? 'and' : 'or', rows }
  } else {
    const r = rowOf(c, cols, timeZone)
    if (r) s = { join: 'and', rows: [r] }
  }
  if (!s) return null
  try {
    return JSON.stringify(conditionOfSimple(s, timeZone)) === JSON.stringify(c) ? s : null
  } catch {
    return null
  }
}

/** a fresh builder row for a column, with an operator and value that fit its kind */
export function newFilterRow(col: EditorColumn): FilterRow {
  const op: FilterOp = col.kind === 'other' ? 'notNull' : 'eq'
  const value = col.kind === 'boolean' ? 'true' : col.choices?.[0] ?? ''
  return { col: col.name, kind: col.kind, op, value }
}

const litText = (v: unknown): string => {
  if (typeof v === 'string') return `"${v}"`
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (v && typeof v === 'object' && '$date' in v) return String((v as { $date: string }).$date)
  if (v && typeof v === 'object' && '$datetime' in v) return String((v as { $datetime: string }).$datetime).replace(/:\d{2}(\.\d+)?Z$/, ' UTC').replace('T', ' ')
  if (Array.isArray(v)) return v.map(litText).join(', ')
  return String(v)
}

/** any condition in words (the simple ones and the ones the builder cannot edit) */
export function describeCondition(c: ConditionV2 | undefined, labelOf: (col: string) => string = (x) => x): string {
  if (c === undefined) return 'every row'
  const go = (x: ConditionV2, top: boolean): string => {
    if ('and' in x) { const s = x.and.map((y) => go(y, false)).join(' and '); return top || x.and.length < 2 ? s : `(${s})` }
    if ('or' in x) { const s = x.or.map((y) => go(y, false)).join(' or '); return top || x.or.length < 2 ? s : `(${s})` }
    if ('not' in x) {
      const n = x.not
      if ('col' in n && n.op === 'isNull') return `${labelOf(n.col)} is not blank`
      return `not ${go(n, false)}`
    }
    if ('const' in x) return x.const ? 'every row' : 'no row'
    if ('via' in x) return `${labelOf(x.via.col)} points to a ${x.via.table} row where ${go(x.via.where, true)}${x.via.orMissing ? ' (or is blank)' : ''}`
    if (x.op === 'cmpExpr') return `${describeNumExpr(x.left, labelOf)} ${FILTER_OP_LABELS[x.cmp as FilterOp]} ${describeNumExpr(x.right, labelOf)}`
    if (x.op === 'isNull') return `${labelOf(x.col)} is blank`
    if (x.op === 'cmpCol') return `${labelOf(x.col)} ${FILTER_OP_LABELS[x.cmp as FilterOp]} ${labelOf(x.other)}`
    if (x.op === 'in') return `${labelOf(x.col)} is one of ${litText(x.value)}`
    const dateish = typeof x.value === 'object' && x.value !== null
    return `${labelOf(x.col)} ${dateish ? filterOpLabel(x.op as FilterOp, 'date') : FILTER_OP_LABELS[x.op as FilterOp]} ${litText(x.value)}`
  }
  return go(c, true)
}

/** a row calculation (NumExprV2) in words */
export function describeNumExpr(e: NumExprV2, labelOf: (col: string) => string = (x) => x): string {
  const go = (x: NumExprV2, top: boolean): string => {
    if (typeof x === 'number') return String(x)
    if ('col' in x) return labelOf(x.col)
    if (x.fn === 'neg') return `−${go(x.args[0], false)}`
    if (x.fn === 'abs') return `abs(${go(x.args[0], true)})`
    if (x.fn === 'round' || x.fn === 'roundUp' || x.fn === 'roundDown') return `${x.fn === 'round' ? 'round' : x.fn === 'roundUp' ? 'round up' : 'round down'}(${go(x.args[0], true)}, ${x.digits})`
    const bin = x as { fn: CalcOp; args: [NumExprV2, NumExprV2] }
    const s = `${go(bin.args[0], false)} ${CALC_OP_LABELS[bin.fn]} ${go(bin.args[1], false)}`
    return top ? s : `(${s})`
  }
  return go(e, true)
}

export function describeMeasure(m: MeasureSpec, labelOf: (col: string) => string = (x) => x): string {
  if (m.fn === 'count') return m.filter ? `Count of rows where ${describeCondition(m.filter, labelOf)}` : 'Count of rows'
  if (m.fn === 'countDistinct') return `Count of different ${m.col !== undefined ? labelOf(m.col) : '?'}`
  const what = m.expr !== undefined ? `the calculation ${describeNumExpr(m.expr, labelOf)}` : m.col !== undefined ? labelOf(m.col) : '?'
  return `${MEASURE_FN_LABELS[m.fn]} of ${what}`
}

/* ------------------------------------------------------------------ grouping, dates, sort, top, comparison, running, target */

/** set the group columns; a chart category or heat-map row that pointed at a removed column goes back to the default */
export function setGroupBy(tile: TileDef, groupBy: string[]): TileDef {
  let t = withQuery(tile, (q) => { const n: QuerySpec = { ...q, groupBy }; if (!groupBy.length) delete n.groupBy; return fixSortAndTop(n) })
  const ok = (k: string | undefined) => k === undefined || k === '__bucket' || groupBy.includes(k)
  if (t.visual && (!ok(t.visual.category) || !ok(t.visual.row))) t = withVisual(t, (v) => { const n = { ...v }; if (!ok(n.category)) delete n.category; if (!ok(n.row)) delete n.row; return n })
  return t
}

export function setBucket(tile: TileDef, bucket: QuerySpec['bucket'] | undefined): TileDef {
  let t = withQuery(tile, (q) => fixSortAndTop(tidy({ ...q, bucket })))
  if (!bucket && t.visual && (t.visual.category === '__bucket' || t.visual.row === '__bucket')) t = withVisual(t, (v) => { const n = { ...v }; if (n.category === '__bucket') delete n.category; if (n.row === '__bucket') delete n.row; return n })
  return t
}

/** a sort on a group or bucket that is gone is removed */
function fixSortAndTop(q: QuerySpec): QuerySpec {
  if (!q.sort) return q
  const by = q.sort.by
  const fine = valueIds(q).includes(by) || (q.groupBy ?? []).includes(by) || (by === '__bucket' && !!q.bucket)
  if (fine) return q
  const n = { ...q }
  delete n.sort
  return n
}

export function setDateColumn(tile: TileDef, col: EditorColumn | undefined): TileDef {
  return withQuery(tile, (q) => tidy({ ...q, dateColumn: col && (col.kind === 'date' || col.kind === 'datetime') ? { col: col.name, kind: col.kind } : undefined }))
}

export function setFilter(tile: TileDef, filter: ConditionV2 | undefined): TileDef {
  return withQuery(tile, (q) => tidy({ ...q, filter }))
}

export function setSort(tile: TileDef, sort: QuerySpec['sort'] | undefined): TileDef {
  return withQuery(tile, (q) => tidy({ ...q, sort }))
}

export function setTop(tile: TileDef, top: QuerySpec['top'] | undefined): TileDef {
  return withQuery(tile, (q) => tidy({ ...q, top }))
}

export function setCompare(tile: TileDef, compare: QuerySpec['compare'] | undefined): TileDef {
  let t = withQuery(tile, (q) => tidy({ ...q, compare }))
  if (!compare && t.visual) {
    // the comparison's series and a KPI based on it have nothing to show any more
    t = withVisual(t, (v) => {
      const n = { ...v }
      if (v.series) n.series = v.series.filter((s) => !s.key.endsWith('__cmp'))
      if (v.kpi?.base === 'compare') { n.kpi = { ...v.kpi }; delete n.kpi.base }
      return n
    })
  }
  return t
}

export function toggleRunning(tile: TileDef, id: string, on: boolean): TileDef {
  return withQuery(tile, (q) => {
    const list = (q.running ?? []).filter((r) => r !== id)
    if (on) list.push(id)
    const n: QuerySpec = { ...q, running: list }
    if (!list.length) delete n.running
    return n
  })
}

export function setTarget(tile: TileDef, target: QuerySpec['target'] | undefined): TileDef {
  return withQuery(tile, (q) => tidy({ ...q, target }))
}

/* ------------------------------------------------------------------ series and formats */

/** what the chart draws when the tile names no series: every measure, then every computed measure (same as tile.ts) */
export function defaultSeries(q: QuerySpec | undefined): SeriesSpec[] {
  return q ? [...q.measures.map((m) => ({ key: m.id, label: m.label ?? m.id })), ...(q.computed ?? []).map((c) => ({ key: c.id, label: c.label ?? c.id }))] : []
}

export const effectiveSeries = (tile: TileDef): SeriesSpec[] => tile.visual?.series ?? defaultSeries(tile.query)

/** every field a series can show: measures, computed measures, their comparison and running totals, the target */
export function availableSeries(q: QuerySpec | undefined): { key: string; label: string }[] {
  if (!q) return []
  const label = (id: string) => q.measures.find((m) => m.id === id)?.label ?? q.computed?.find((c) => c.id === id)?.label ?? id
  const out: { key: string; label: string }[] = []
  for (const id of valueIds(q)) {
    out.push({ key: id, label: label(id) })
    if (q.compare) out.push({ key: `${id}__cmp`, label: `${label(id)} (${COMPARE_LABELS[q.compare].toLowerCase()})` })
  }
  for (const id of q.running ?? []) out.push({ key: `${id}__run`, label: `${label(id)} (running total)` })
  if (q.target) out.push({ key: '__target', label: 'Target' })
  return out
}

/** show or hide one field; the first change writes the default list into the tile so later changes have something to edit */
export function toggleSeries(tile: TileDef, key: string, on: boolean, label?: string): TileDef {
  const cur = effectiveSeries(tile)
  const has = cur.some((s) => s.key === key)
  if (on === has) return tile
  const next = on ? [...cur, tidy({ key, label, ...(key.endsWith('__cmp') || key === '__target' ? { dashed: true } : {}) })] : cur.filter((s) => s.key !== key)
  return withVisual(tile, (v) => ({ ...v, series: next }))
}

/** back to "every measure" (removes the stored series list) */
export function resetSeries(tile: TileDef): TileDef {
  return withVisual(tile, (v) => { const n = { ...v }; delete n.series; return n })
}

/** the number format of one value field (kept on its series; writes the series list when needed) */
export function setSeriesFormat(tile: TileDef, key: string, format: NumberFormat | undefined): TileDef {
  let cur = effectiveSeries(tile)
  if (!cur.some((s) => s.key === key)) cur = [...cur, { key }]
  return withVisual(tile, (v) => ({ ...v, series: cur.map((s) => (s.key === key ? tidy({ ...s, format }) : s)) }))
}

export const seriesFormat = (tile: TileDef, key: string): NumberFormat | undefined => tile.visual?.series?.find((s) => s.key === key)?.format

export function setVisual(tile: TileDef, patch: Partial<TileVisual>): TileDef {
  return withVisual(tile, (v) => tidy({ ...v, ...patch }))
}

export type FormatChoice = 'auto' | 'number' | 'decimal' | 'currency' | 'percent' | 'compact'
export const FORMAT_LABELS: Record<FormatChoice, string> = { auto: 'Automatic', number: 'Whole number', decimal: 'Number with 2 decimals', currency: 'Currency', percent: 'Percent (0.85 = 85%)', compact: 'Compact (12.3L)' }

/** a format -> the editor's choice (custom combinations read as the closest choice; `formatOfChoice` keeps their other fields) */
export function formatChoiceOf(f: NumberFormat | undefined): FormatChoice {
  if (!f || !Object.keys(f).length) return 'auto'
  if (f.style === 'percent') return 'percent'
  if (f.style === 'currency') return 'currency'
  if (f.compact) return 'compact'
  if (f.decimals !== undefined && f.decimals > 0) return 'decimal'
  return 'number'
}
export function formatOfChoice(c: FormatChoice, old?: NumberFormat): NumberFormat | undefined {
  if (formatChoiceOf(old) === c) return old
  const keep: NumberFormat = {}
  if (old?.prefix !== undefined) keep.prefix = old.prefix
  if (old?.suffix !== undefined) keep.suffix = old.suffix
  if (old?.locale !== undefined) keep.locale = old.locale
  switch (c) {
    case 'auto': return Object.keys(keep).length ? keep : undefined
    case 'number': return { ...keep, style: 'number', decimals: 0 }
    case 'decimal': return { ...keep, style: 'number', decimals: 2 }
    case 'currency': return { ...keep, style: 'currency', ...(old?.currency ? { currency: old.currency } : {}) }
    case 'percent': return { ...keep, style: 'percent', decimals: 1 }
    case 'compact': return { ...keep, style: 'number', compact: true }
  }
}

/* ------------------------------------------------------------------ validation */

export interface Issue { level: 'error' | 'warning'; message: string }

/**
 * problems of a tile in plain English. Errors block saving; warnings do not (the tile still works, perhaps not as
 * meant). `columnsOf` gives the columns of a table, or null when it does not exist or the maker cannot see it.
 */
export function validateTile(tile: TileDef, columnsOf: (table: string) => EditorColumn[] | null): Issue[] {
  const out: Issue[] = []
  const err = (message: string) => out.push({ level: 'error', message })
  const warn = (message: string) => out.push({ level: 'warning', message })
  if (!TILE_KINDS.includes(tile.kind)) err(`"${String(tile.kind)}" is not a kind of tile.`)
  if (!tile.title.trim()) warn('The tile has no title.')
  if (tile.kind === 'text') return out
  const q = tile.query
  if (!q || !q.table) { err('Choose a table.'); return out }
  const cols = columnsOf(q.table)
  if (!cols) err(`The table ${q.table} does not exist or you cannot see it.`)
  const col = (name: string | undefined, what: string): EditorColumn | undefined => {
    if (name === undefined || !cols) return undefined
    const c = findCol(cols, name)
    if (!c) err(`${what}: the column ${name} is not in ${q.table}.`)
    return c
  }
  if (!q.measures.length) err('Add at least one measure.')
  for (const m of q.measures) {
    const name = m.label || m.id
    if (m.fn === 'count') { if (m.filter) checkCondition(m.filter, cols, `${name}'s condition`, err); continue }
    if (m.expr !== undefined) { if (m.fn === 'countDistinct') err(`${name}: count of different values needs a column, not a calculation.`); continue }
    if (m.col === undefined) { err(`${name}: choose the column to ${MEASURE_FN_LABELS[m.fn].toLowerCase()}.`); continue }
    const c = col(m.col, name)
    if (c && m.fn !== 'countDistinct' && c.kind !== 'number') err(`${name}: ${MEASURE_FN_LABELS[m.fn].toLowerCase()} needs a number column; ${c.label} is not one.`)
    if (c && m.fn === 'countDistinct' && c.kind === 'other') err(`${name}: ${c.label} cannot be counted.`)
  }
  for (const g of q.groupBy ?? []) { const c = col(g, 'Group by'); if (c && c.kind === 'other') err(`Group by: ${c.label} cannot be grouped.`) }
  if (new Set((q.groupBy ?? []).map((g) => g.toLowerCase())).size !== (q.groupBy ?? []).length) err('Group by: a column is listed twice.')
  if (q.bucket) {
    const c = col(q.bucket.col, 'Date grouping')
    if (c && c.kind !== 'date' && c.kind !== 'datetime') err(`Date grouping: ${c.label} is not a date column.`)
    if (c && q.bucket.unit === 'hour' && c.kind !== 'datetime') err(`Date grouping by hour needs a date-and-time column; ${c.label} has dates only.`)
  }
  if (q.dateColumn) {
    const c = col(q.dateColumn.col, 'Date range column')
    if (c && c.kind !== q.dateColumn.kind) err(`Date range column: ${c.label} is ${c.kind === 'date' ? 'a date' : c.kind === 'datetime' ? 'a date and time' : 'not a date'} column.`)
  }
  if (q.filter) checkCondition(q.filter, cols, 'Filter', err)
  if (q.top && (!Number.isInteger(q.top.n) || q.top.n < 1 || q.top.n > 10000)) err('Top: enter a whole number from 1 to 10000.')
  if (q.compare && !q.dateColumn) err('A comparison needs the column the dashboard date range applies to.')
  for (const r of q.running ?? []) if (!valueIds(q).includes(r)) err(`Running total: ${r} is not a measure of this tile.`)
  if (q.target) {
    const tc = columnsOf(q.target.table)
    if (!q.target.table) err('Target: choose the table of targets.')
    else if (!tc) err(`Target: the table ${q.target.table} does not exist or you cannot see it.`)
    else {
      const v = findCol(tc, q.target.valueCol)
      if (!v) err('Target: choose the column holding the target values.')
      else if (v.kind !== 'number') err(`Target: ${v.label} is not a number column.`)
      if (q.target.keyCol !== undefined && !findCol(tc, q.target.keyCol)) err(`Target: the column ${q.target.keyCol} is not in ${q.target.table}.`)
      if (q.target.keyCol !== undefined && !(q.groupBy ?? []).length) warn('Target: the key column is used only when the tile has a group column.')
      if (q.target.dateCol && !findCol(tc, q.target.dateCol.col)) err(`Target: the column ${q.target.dateCol.col} is not in ${q.target.table}.`)
    }
  }
  // the measure builder's own rules (names, references, sort, "Others")
  try { compileQuery(q, { range: null }) } catch (e) { const m = e instanceof Error ? e.message : String(e); if (!out.some((x) => x.message === m)) err(m) }
  // visual references
  const v = tile.visual
  const fields = new Set([...valueIds(q), ...availableSeries(q).map((s) => s.key)])
  for (const s of v?.series ?? []) if (!fields.has(s.key)) warn(`The chart shows ${s.key}, which this query does not produce.`)
  if (v?.category !== undefined && v.category !== '__bucket' && !(q.groupBy ?? []).includes(v.category)) warn(`The chart's category ${v.category} is not a group column.`)
  if (tile.kind === 'kpi') {
    const k = v?.kpi
    if (k && !fields.has(k.measure)) err(`KPI: ${k.measure} is not a measure of this tile.`)
    if (k?.base === 'compare' && !q.compare) warn('KPI: it is compared with the previous period, but the query has no comparison.')
    if (k?.base === 'target' && !q.target) warn('KPI: it is compared with a target, but the query has no target.')
    if (((q.groupBy ?? []).length || q.bucket) && k?.base) warn('KPI: grouped rows are added up into one number; the comparison or target is shown only when the tile is not grouped.')
  }
  if ((tile.kind === 'pie' || tile.kind === 'donut' || tile.kind === 'funnel' || tile.kind === 'pareto' || tile.kind === 'bar' || tile.kind === 'line' || tile.kind === 'area' || tile.kind === 'combo') && !(q.groupBy ?? []).length && !q.bucket)
    warn('Choose a group column or a date grouping: without one the chart has a single point.')
  if (tile.kind === 'heatmap' && ((q.groupBy ?? []).length + (q.bucket ? 1 : 0)) < 2) warn('A heat map needs two groupings (a group column and a date grouping, or two group columns).')
  return out
}

function checkCondition(c: ConditionV2, cols: EditorColumn[] | null, what: string, err: (m: string) => void): void {
  const walk = (x: ConditionV2) => {
    if ('and' in x) { x.and.forEach(walk); return }
    if ('or' in x) { x.or.forEach(walk); return }
    if ('not' in x) { walk(x.not); return }
    if ('const' in x || 'via' in x) return
    if (x.op === 'cmpExpr') return
    if (cols && !findCol(cols, x.col)) err(`${what}: the column ${x.col} is not in this table.`)
    if (x.op === 'cmpCol' && cols && !findCol(cols, x.other)) err(`${what}: the column ${x.other} is not in this table.`)
  }
  walk(c)
}

export const blocking = (issues: Issue[]) => issues.filter((i) => i.level === 'error')

/* ------------------------------------------------------------------ summary */

/** the tile in a few lines of plain English */
export function describeTile(tile: TileDef, columnsOf: (table: string) => EditorColumn[] | null = () => null): string[] {
  if (tile.kind === 'text') return ['A text tile.']
  const q = tile.query
  if (!q || !q.table) return ['No table chosen yet.']
  const cols = columnsOf(q.table)
  const labelOf = (c: string) => findCol(cols, c)?.label ?? c
  const valLabel = (id: string) => q.measures.find((m) => m.id === id)?.label ?? q.computed?.find((c) => c.id === id)?.label ?? id
  const lines: string[] = [`${TILE_KIND_LABELS[tile.kind] ?? tile.kind} over ${q.table}.`]
  for (const m of q.measures) lines.push(`${m.label ?? m.id}: ${describeMeasure(m, labelOf)}.`)
  for (const c of q.computed ?? []) lines.push(`${c.label ?? c.id} = ${describeCalc(c.expr, valLabel)} (per row of the result).`)
  const by = [...(q.groupBy ?? []).map(labelOf), ...(q.bucket ? [`${BUCKET_UNIT_LABELS[q.bucket.unit].toLowerCase()} of ${labelOf(q.bucket.col)}`] : [])]
  lines.push(by.length ? `By ${by.join(', then ')}.` : 'One total, not grouped.')
  lines.push(q.dateColumn ? `The dashboard's date range applies to ${labelOf(q.dateColumn.col)}.` : "The dashboard's date range does not apply (no date column).")
  if (q.filter) lines.push(`Only rows where ${describeCondition(q.filter, labelOf)}.`)
  if (q.sort) lines.push(`Sorted by ${q.sort.by === '__bucket' ? 'date' : valueIds(q).includes(q.sort.by) ? valLabel(q.sort.by) : labelOf(q.sort.by)}, ${q.sort.dir === 'desc' ? 'largest first' : 'smallest first'}.`)
  if (q.top) lines.push(`Top ${q.top.n}${q.top.others !== undefined ? `, the rest as "${q.top.others}"` : ''}.`)
  if (q.compare) lines.push(`Compared with the ${COMPARE_LABELS[q.compare].toLowerCase()}.`)
  if (q.running?.length) lines.push(`Running total of ${q.running.map(valLabel).join(', ')}.`)
  if (q.target) lines.push(`Target: sum of ${q.target.valueCol} in ${q.target.table}${q.target.keyCol ? ` per ${q.target.keyCol}` : ''}.`)
  return lines
}

/* ------------------------------------------------------------------ into the definition */

/**
 * put the edited tile into the definition (replacing the tile with its id, or appending) and check the result with
 * checkDashboardDef. A tile switched to "text" from another kind loses its query (a text tile has none); a text tile
 * that already carried one keeps it. Throws with checkDashboardDef's message.
 */
export function applyTile(def: DashboardDef, tile: TileDef, original?: TileDef): DashboardDef {
  let t = tile
  if (t.kind === 'text' && original?.kind !== 'text' && t.query) { t = { ...t }; delete t.query }
  const i = def.tiles.findIndex((x) => x.id === (original?.id ?? t.id))
  if (i < 0 && def.tiles.length >= MAX_TILES) throw new Error(`A dashboard has at most ${MAX_TILES} tiles.`)
  const tiles = i < 0 ? [...def.tiles, t] : def.tiles.map((x, j) => (j === i ? t : x))
  const checked = checkDashboardDef({ ...def, tiles })
  // checkDashboardDef rebuilds each tile from its known fields; keep the editor's object (and any field it carries)
  return { ...def, tiles: tiles.map((x, j) => ({ ...x, layout: checked.tiles[j]!.layout })) }
}

/** a one-tile definition for the live preview: the dashboard's filters stay, so buildBatch treats the tile as the viewer does */
export function previewDef(def: DashboardDef, tile: TileDef): DashboardDef {
  return { ...def, tiles: [clone(tile)] }
}
