/**
 * Charts of the print engine (docs/dev/pdf.md "Charts"): a chart block -> the dashboards' ChartSpec and rows. The
 * drawing is package C's renderChartSvg (src/charts/svg.ts, the same geometry as the dashboard tiles); svgops.ts turns its
 * SVG into the layout engine's vector operations with the bundled fonts. There is no chart renderer of our own.
 *
 * The stored block (src/platform/print.ts, kind 'chart') keeps its shape: `chartType`, `rows` (a formula returning the
 * rows), `label` (a formula over ThisItem), `values` (name, formula, colour), `min`, `max`, `bands` (fractions of the
 * range), `unit`, `title`, `height`. How the values are read per kind:
 *
 * | kinds | label | values |
 * | --- | --- | --- |
 * | bar, line, area, combo, pareto, histogram | category | one series each (combo: optional `kind` per value, default bar then line) |
 * | pie, donut, funnel | category (slice, stage) | the first value |
 * | scatter | colour group (optional) | x, y, size (optional) |
 * | heatmap | row | column (text), value |
 * | timeline | lane | start, end (blank: the generation time), status (text, optional) |
 * | gauge, bullet, kpi (no rows) | - | the value, then an optional target (gauge, bullet) or comparison base (kpi) |
 *
 * Optional block fields the engine also reads when present (the template model does not declare them yet):
 * `stack`, `orientation`, `dataLabels`, `legend`, `decimals`, `higherIsBetter`, and `kind` / `axis` / `dashed` per value.
 */
import type { ChartKind, ChartSpec, SeriesSpec, Status } from '../../../src/charts/geometry.ts'
import { CHART_KINDS } from '../../../src/charts/geometry.ts'
import type { FormatDefaults, NumberFormat } from '../../../src/charts/format.ts'

/** a chart ready for layout: the spec without its size (the layout gives the box) and its rows */
export interface PrintChart {
  spec: Omit<ChartSpec, 'width' | 'height'>
  rows: Record<string, unknown>[]
}

export interface ChartValueDef { name: string; value: string; color?: string; kind?: 'bar' | 'line' | 'area'; axis?: 'left' | 'right'; dashed?: boolean }

/** the stored chart block as the engine reads it */
export interface ChartBlockInput {
  chartType: string
  values: ChartValueDef[]
  min?: number
  max?: number
  bands?: number[]
  unit?: string
  stack?: 'none' | 'stacked' | 'percent'
  orientation?: 'vertical' | 'horizontal'
  dataLabels?: boolean
  legend?: boolean
  decimals?: number
  higherIsBetter?: boolean
}

/** kinds read from a single set of values (no rows formula) */
export const SINGLE_VALUE_KINDS: ChartKind[] = ['gauge', 'bullet', 'kpi']
/** row limits: charts of categories stay readable; point and period charts take more */
export const CHART_ROW_LIMIT = (k: ChartKind): number => (k === 'scatter' || k === 'heatmap' || k === 'timeline' ? 1000 : 200)

export function chartKind(t: unknown): ChartKind {
  return (CHART_KINDS as string[]).includes(String(t)) ? (t as ChartKind) : 'bar'
}

export interface ChartInputs {
  title?: string
  /** per row: the label's text and the values' raw results (rows kinds) */
  rows: { label: string; values: unknown[] }[]
  /** the values' raw results (gauge, bullet, kpi) */
  single: unknown[]
  /** a value as text (records, dates: the binder's display text) */
  asText: (v: unknown) => string
  /** the generation time (open timeline periods end here, so output is deterministic) */
  now: Date
  grouping: 'indian' | 'international'
  currency: string
  timeZone: string
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, '').trim())
    return v.trim() && Number.isFinite(n) ? n : null
  }
  return null
}

function toInstant(v: unknown): Date | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v)
    return Number.isFinite(t) ? new Date(t) : null
  }
  return null
}

/** legacy gauge bands (fractions of the range, e.g. [0.6, 0.85]) -> bad / warn / good bands of values */
export function statusBands(fractions: number[] | undefined, min: number, max: number): ChartSpec['bands'] {
  const cuts = (fractions?.length ? fractions : [0.6, 0.85]).map((f) => Math.max(0, Math.min(1, Number(f)))).filter((f) => Number.isFinite(f)).sort((a, b) => a - b)
  const statuses: Status[] = ['bad', 'warn', 'good']
  const out: NonNullable<ChartSpec['bands']> = []
  let prev = 0
  ;[...cuts, 1].forEach((f, i) => {
    if (f > prev) out.push({ from: min + (max - min) * prev, to: min + (max - min) * f, status: statuses[Math.min(i, statuses.length - 1)] })
    prev = f
  })
  return out
}

/** a stored chart block and its evaluated values -> the dashboards' ChartSpec and rows */
export function chartFromBlock(b: ChartBlockInput, inp: ChartInputs): PrintChart {
  const kind = chartKind(b.chartType)
  const defaults: FormatDefaults = { locale: inp.grouping === 'international' ? 'en-US' : 'en-IN', currency: inp.currency || 'INR', timeZone: inp.timeZone || 'Asia/Kolkata' }
  const format: NumberFormat = { ...(b.unit ? { suffix: b.unit } : {}), ...(typeof b.decimals === 'number' ? { decimals: b.decimals } : {}) }
  const values = Array.isArray(b.values) ? b.values : []
  const color = (v: ChartValueDef | undefined) => (v?.color && HEX.test(v.color) ? { color: v.color } : {})
  const spec: PrintChart['spec'] = {
    kind,
    ...(inp.title ? { title: inp.title } : {}),
    format,
    defaults,
    ...(b.legend === false ? { legend: false } : {}),
    ...(b.dataLabels ? { dataLabels: true } : {}),
    ...(typeof b.min === 'number' ? { min: b.min } : {}),
    ...(typeof b.max === 'number' ? { max: b.max } : {}),
    emptyText: 'No data',
  }
  const rows: Record<string, unknown>[] = []
  if (SINGLE_VALUE_KINDS.includes(kind)) {
    // the value as the old print charts showed it: rounded to one decimal (unless decimals is set; axis ticks unaffected)
    const r1 = (x: number | null) => (x === null || typeof b.decimals === 'number' ? x : Math.round(x * 10) / 10)
    const v = r1(toNumber(inp.single[0]))
    const second = inp.single.length > 1 ? r1(toNumber(inp.single[1])) : null
    spec.series = [{ key: 'v', label: values[0]?.name || 'Value', ...color(values[0]) }]
    rows.push({ v })
    if (kind === 'kpi') {
      spec.kpi = { value: v, label: values[0]?.name || inp.title || 'Value', ...(values.length > 1 ? { base: second, baseLabel: values[1]?.name ? `vs ${values[1].name}` : undefined } : {}), ...(typeof b.higherIsBetter === 'boolean' ? { higherIsBetter: b.higherIsBetter } : {}), showLabel: true }
    } else {
      const min = typeof b.min === 'number' ? b.min : 0
      const max = typeof b.max === 'number' ? b.max : 100
      Object.assign(spec, { min, max, bands: statusBands(b.bands, min, max), ...(second !== null ? { target: second } : {}) })
    }
    return { spec, rows }
  }
  const limit = CHART_ROW_LIMIT(kind)
  const src = inp.rows.slice(0, limit)
  const hasLabel = src.some((r) => r.label !== '')
  if (kind === 'scatter') {
    spec.series = values.slice(0, 2).map((v, i) => ({ key: `s${i}`, label: v.name || `Value ${i + 1}` }))
    Object.assign(spec, { x: 's0', y: 's1', ...(values.length > 2 ? { size: 's2' } : {}), ...(hasLabel ? { colorBy: 'c' } : {}) })
    for (const r of src) rows.push({ c: r.label, s0: toNumber(r.values[0]), s1: toNumber(r.values[1]), ...(values.length > 2 ? { s2: toNumber(r.values[2]) } : {}) })
    return { spec, rows }
  }
  if (kind === 'heatmap') {
    Object.assign(spec, { row: 'c', column: 'k', series: [{ key: 'v', label: values[1]?.name || 'Value' }] })
    for (const r of src) rows.push({ c: r.label, k: inp.asText(r.values[0]), v: toNumber(r.values[1]) })
    return { spec, rows }
  }
  if (kind === 'timeline') {
    Object.assign(spec, { lane: 'c', start: 's0', end: 's1', ...(values.length > 2 ? { status: 's2' } : {}) })
    delete spec.min
    delete spec.max
    for (const r of src) {
      const a = toInstant(r.values[0])
      if (!a) continue
      rows.push({ c: r.label, s0: a, s1: toInstant(r.values[1]) ?? (inp.now.getTime() >= a.getTime() ? inp.now : a), ...(values.length > 2 ? { s2: inp.asText(r.values[2]) } : {}) })
    }
    return { spec, rows }
  }
  // categories: bar, line, area, combo, pareto, histogram, pie, donut, funnel
  const one = kind === 'pie' || kind === 'donut' || kind === 'funnel' || kind === 'pareto'
  const defs = one ? values.slice(0, 1) : values
  spec.category = 'c'
  spec.categoryType = 'text'
  spec.series = defs.map((v, i): SeriesSpec => ({
    key: `s${i}`, label: v.name || `Series ${i + 1}`, ...color(v),
    ...(kind === 'combo' ? { kind: v.kind ?? (i === 0 ? 'bar' : 'line') } : {}),
    ...(v.axis === 'right' ? { axis: 'right' } : {}),
    ...(v.dashed ? { dashed: true } : {}),
  }))
  if (b.stack && b.stack !== 'none' && (kind === 'bar' || kind === 'area')) spec.stack = b.stack
  if (b.orientation === 'horizontal' && (kind === 'bar' || kind === 'histogram')) spec.orientation = 'horizontal'
  for (const r of src) {
    const row: Record<string, unknown> = { c: r.label }
    defs.forEach((_, i) => { row[`s${i}`] = toNumber(r.values[i]) })
    rows.push(row)
  }
  return { spec, rows }
}
