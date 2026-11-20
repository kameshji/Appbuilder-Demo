/**
 * Chart geometry (P2-C): a chart spec and its rows -> a Scene of primitive marks (rect, path, circle, line, text) with
 * colour tokens, plus the accessible data table and a one-line summary. Pure: no React, no DOM, no packages, so the
 * same code draws the interactive UI components (src/controls/display/viz.tsx renders the marks as React SVG) and the
 * static SVG for PDFs and email snapshots (svg.ts renderChartSvg, used on the server). Screen and paper therefore match.
 */
import type { DateGrain, FormatDefaults, NumberFormat } from './format.ts'
import { DEFAULT_FORMAT, WEEKDAY_NAMES, formatDate, formatNumber, formatTick } from './format.ts'
import type { Paint } from './palette.ts'
import { seriesPaint } from './palette.ts'
import { band, fitText, linear, textWidth } from './scales.ts'
import type { LinearScale } from './scales.ts'

export type ChartKind =
  | 'bar' | 'line' | 'area' | 'combo' | 'pie' | 'donut' | 'scatter' | 'heatmap' | 'gauge' | 'bullet' | 'kpi'
  | 'funnel' | 'pareto' | 'histogram' | 'timeline'
export const CHART_KINDS: ChartKind[] = ['bar', 'line', 'area', 'combo', 'pie', 'donut', 'scatter', 'heatmap', 'gauge', 'bullet', 'kpi', 'funnel', 'pareto', 'histogram', 'timeline']

export type Status = 'good' | 'warn' | 'bad'

export interface SeriesSpec {
  /** field of the rows */
  key: string
  label?: string
  /** combo charts: how this series is drawn */
  kind?: 'bar' | 'line' | 'area'
  axis?: 'left' | 'right'
  /** palette index or a #hex colour */
  color?: number | string
  format?: NumberFormat
  /** dashed line (comparison series: previous period, target) */
  dashed?: boolean
}

export interface StatusRule {
  /** compare the value (default) or the delta (fraction for percent deltas) */
  of?: 'value' | 'delta'
  op: 'lt' | 'le' | 'gt' | 'ge'
  value: number
  status: Status
}

export interface KpiSpec {
  label?: string
  value: number | null
  /** comparison base: the previous period's value or a target */
  base?: number | null
  baseLabel?: string
  deltaStyle?: 'percent' | 'absolute'
  higherIsBetter?: boolean
  rules?: StatusRule[]
  /** sparkline values (oldest first) */
  spark?: (number | null)[]
  /** draw the label inside the tile (default true; a dashboard tile already shows it as its title) */
  showLabel?: boolean
}

export interface ChartSpec {
  kind: ChartKind
  width: number
  height: number
  title?: string
  /** category field (x of bar / line / area / combo / pareto / funnel / pie labels / histogram) */
  category?: string
  categoryType?: 'text' | 'date' | 'number' | 'weekday'
  /** labels of date categories (bucket grain) */
  categoryGrain?: DateGrain
  series?: SeriesSpec[]
  orientation?: 'vertical' | 'horizontal'
  stack?: 'none' | 'stacked' | 'percent'
  curve?: 'linear' | 'step'
  missing?: 'gap' | 'zero' | 'connect'
  format?: NumberFormat
  rightFormat?: NumberFormat
  defaults?: FormatDefaults
  fiscalYearStart?: number
  legend?: boolean
  grid?: boolean
  dataLabels?: boolean
  /** series keys switched off in the legend */
  hidden?: string[]
  /** gauge / bullet scale; axis overrides elsewhere */
  min?: number
  max?: number
  bands?: { from: number; to: number; status?: Status; color?: string; label?: string }[]
  target?: number | null
  referenceLines?: { value: number; label?: string; axis?: 'left' | 'right' }[]
  /** scatter */
  x?: string
  y?: string
  size?: string
  colorBy?: string
  /** heatmap: row and column fields, value = series[0] */
  row?: string
  column?: string
  rowType?: 'text' | 'date' | 'number' | 'weekday'
  rowGrain?: DateGrain
  /** kpi */
  kpi?: KpiSpec
  /** timeline: lane field, start / end fields (instants), status field and its colours */
  lane?: string
  start?: string
  end?: string
  status?: string
  statusColors?: Record<string, Paint>
  /** cross-filter highlight: the selected category (others are dimmed) */
  selected?: string | null
  emptyText?: string
}

export interface Datum {
  index: number
  series?: string
  /** category / label text */
  label: string
  value?: number | null
  /** tooltip text */
  text: string
  /** the source row (OnSelect, cross-filter) */
  row?: Record<string, unknown>
}

export type Mark =
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill: Paint; rx?: number; opacity?: number; stroke?: Paint; datum?: Datum }
  | { t: 'path'; d: string; stroke?: Paint; fill?: Paint; width?: number; dash?: string; opacity?: number; datum?: Datum; cap?: 'round' | 'butt' }
  | { t: 'circle'; cx: number; cy: number; r: number; fill: Paint; stroke?: Paint; width?: number; opacity?: number; datum?: Datum }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: Paint; width?: number; dash?: string; opacity?: number }
  | { t: 'text'; x: number; y: number; text: string; size: number; fill: Paint; anchor?: 'start' | 'middle' | 'end'; weight?: number; baseline?: 'auto' | 'middle' | 'hanging'; rotate?: number }

export interface LegendItem { key: string; label: string; color: Paint; hidden: boolean; dashed?: boolean }

export interface Scene {
  width: number
  height: number
  marks: Mark[]
  legend: LegendItem[]
  /** accessible alternative: the data as a table */
  table: { columns: string[]; rows: string[][] }
  /** one-line description (aria-label) */
  summary: string
  /** shown instead of marks */
  empty?: string
  /** interactive points in order (keyboard navigation) */
  points: Datum[]
}

type Row = Record<string, unknown>

const FONT = 11
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : Number(v)
  return Number.isFinite(n) ? n : null
}
const r2 = (v: number) => Math.round(v * 100) / 100

export function categoryText(v: unknown, type: ChartSpec['categoryType'], grain: DateGrain | undefined, spec: Pick<ChartSpec, 'defaults' | 'fiscalYearStart'>): string {
  if (v === null || v === undefined || v === '') return '(blank)'
  if (type === 'weekday') return WEEKDAY_NAMES[(Number(v) - 1 + 7) % 7] ?? String(v)
  if (type === 'date' || v instanceof Date) return formatDate(v, grain ?? 'day', { fiscalYearStart: spec.fiscalYearStart }, spec.defaults ?? DEFAULT_FORMAT)
  if (typeof v === 'number') return formatNumber(v, {}, spec.defaults ?? DEFAULT_FORMAT)
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    return String(o.Name ?? o.Title ?? o.Value ?? JSON.stringify(v))
  }
  return String(v)
}

function seriesColor(s: SeriesSpec, i: number): Paint {
  if (typeof s.color === 'string' && s.color) return s.color
  return seriesPaint(typeof s.color === 'number' ? s.color : i)
}

function fmt(spec: ChartSpec, v: number | null | undefined, f?: NumberFormat): string {
  if (v === null || v === undefined) return '(blank)'
  return formatNumber(v, f ?? spec.format ?? {}, spec.defaults ?? DEFAULT_FORMAT)
}

function emptyScene(spec: ChartSpec, text: string): Scene {
  return { width: spec.width, height: spec.height, marks: [], legend: [], table: { columns: [], rows: [] }, summary: `${spec.title ? spec.title + ': ' : ''}${text}`, empty: text, points: [] }
}

const KIND_NAME: Record<ChartKind, string> = {
  bar: 'Bar chart', line: 'Line chart', area: 'Area chart', combo: 'Combination chart', pie: 'Pie chart', donut: 'Donut chart', scatter: 'Scatter chart',
  heatmap: 'Heat map', gauge: 'Gauge', bullet: 'Bullet chart', kpi: 'KPI', funnel: 'Funnel', pareto: 'Pareto chart', histogram: 'Histogram', timeline: 'Timeline',
}

/* ------------------------------------------------------------------ axes */

interface Plot { x: number; y: number; w: number; h: number }

function valueAxis(marks: Mark[], s: LinearScale, plot: Plot, side: 'left' | 'right' | 'bottom', f: NumberFormat | undefined, spec: ChartSpec, grid: boolean): void {
  const span = Math.max(Math.abs(s.domain[0]), Math.abs(s.domain[1]))
  for (const t of s.ticks) {
    const p = s(t)
    const text = formatTick(t, f ?? spec.format ?? {}, spec.defaults ?? DEFAULT_FORMAT, span)
    if (side === 'bottom') {
      if (grid) marks.push({ t: 'line', x1: r2(p), y1: plot.y, x2: r2(p), y2: plot.y + plot.h, stroke: 'grid', width: 1 })
      marks.push({ t: 'text', x: r2(p), y: plot.y + plot.h + 14, text, size: FONT, fill: 'muted', anchor: 'middle' })
    } else {
      if (grid && side === 'left') marks.push({ t: 'line', x1: plot.x, y1: r2(p), x2: plot.x + plot.w, y2: r2(p), stroke: 'grid', width: 1 })
      marks.push({ t: 'text', x: side === 'left' ? plot.x - 6 : plot.x + plot.w + 6, y: r2(p), text, size: FONT, fill: 'muted', anchor: side === 'left' ? 'end' : 'start', baseline: 'middle' })
    }
  }
}

function tickWidth(s: LinearScale, f: NumberFormat | undefined, spec: ChartSpec): number {
  const span = Math.max(Math.abs(s.domain[0]), Math.abs(s.domain[1]))
  return Math.max(...s.ticks.map((t) => textWidth(formatTick(t, f ?? spec.format ?? {}, spec.defaults ?? DEFAULT_FORMAT, span), FONT)), 12)
}

/** category labels along x (thinned to fit) or y */
function categoryAxis(marks: Mark[], labels: string[], pos: (i: number) => number, step: number, plot: Plot, horizontal: boolean, leftWidth = 0): void {
  if (horizontal) {
    const max = Math.max(20, leftWidth - 8)
    const every = Math.max(1, Math.ceil((FONT + 2) / Math.max(1, step)))
    labels.forEach((l, i) => {
      if (i % every) return
      marks.push({ t: 'text', x: plot.x - 6, y: r2(pos(i)), text: fitText(l, FONT, max), size: FONT, fill: 'muted', anchor: 'end', baseline: 'middle' })
    })
    return
  }
  const widest = Math.max(...labels.map((l) => textWidth(l, FONT)), 1)
  const every = Math.max(1, Math.ceil((Math.min(widest, 120) + 8) / Math.max(1, step)))
  labels.forEach((l, i) => {
    if (i % every) return
    marks.push({ t: 'text', x: r2(pos(i)), y: plot.y + plot.h + 14, text: fitText(l, FONT, Math.max(step * every - 4, 24)), size: FONT, fill: 'muted', anchor: 'middle' })
  })
  marks.push({ t: 'line', x1: plot.x, y1: plot.y + plot.h, x2: plot.x + plot.w, y2: plot.y + plot.h, stroke: 'axis', width: 1 })
}

/* ------------------------------------------------------------------ cartesian: bar, line, area, combo, pareto, histogram */

function cartesian(spec: ChartSpec, rows: Row[]): Scene {
  const all = spec.series ?? []
  const hidden = new Set(spec.hidden ?? [])
  const legend: LegendItem[] = all.map((s, i) => ({ key: s.key, label: s.label ?? s.key, color: seriesColor(s, i), hidden: hidden.has(s.key), dashed: s.dashed }))
  const vis = all.map((s, i) => ({ s, i, color: seriesColor(s, i) })).filter((x) => !hidden.has(x.s.key))
  const labels = rows.map((r) => categoryText(spec.category ? r[spec.category] : undefined, spec.categoryType, spec.categoryGrain, spec))
  const table = { columns: [spec.category ?? 'Category', ...all.map((s) => s.label ?? s.key)], rows: rows.map((r, i) => [labels[i]!, ...all.map((s) => fmt(spec, num(r[s.key]), s.format))]) }
  if (!rows.length) return { ...emptyScene(spec, spec.emptyText ?? 'No data'), legend }
  const horizontal = spec.orientation === 'horizontal' && (spec.kind === 'bar' || spec.kind === 'histogram')
  const isCombo = spec.kind === 'combo' || spec.kind === 'pareto'
  const kindOf = (s: SeriesSpec): 'bar' | 'line' | 'area' => (isCombo ? s.kind ?? 'bar' : spec.kind === 'line' ? 'line' : spec.kind === 'area' ? 'area' : 'bar')
  const stack = spec.kind === 'pareto' ? 'none' : spec.stack ?? 'none'
  const left = vis.filter((x) => x.s.axis !== 'right')
  const right = vis.filter((x) => x.s.axis === 'right')
  const val = (r: Row, s: SeriesSpec): number | null => {
    const v = num(r[s.key])
    return v === null && spec.missing === 'zero' ? 0 : v
  }
  // stacked totals per category (positive and negative separately); percent: share of the absolute total
  const stackOf = (group: typeof vis) => rows.map((r) => {
    let pos = 0, neg = 0, abs = 0
    const parts = group.map((x) => {
      const v = val(r, x.s) ?? 0
      abs += Math.abs(v)
      if (v >= 0) { const p: [number, number] = [pos, pos + v]; pos += v; return p }
      const p: [number, number] = [neg + v, neg]; neg += v; return p
    })
    return { parts, pos, neg, abs }
  })
  const leftStacked = stack !== 'none' ? stackOf(left) : null
  const leftValues = stack === 'percent' ? [0, 1] : leftStacked ? leftStacked.flatMap((x) => [x.pos, x.neg]) : left.flatMap((x) => rows.map((r) => val(r, x.s) ?? NaN))
  for (const l of spec.referenceLines ?? []) if (l.axis !== 'right') leftValues.push(l.value)
  if (spec.target !== undefined && spec.target !== null) leftValues.push(spec.target)
  const rightValues = spec.kind === 'pareto' ? [0, 1] : right.flatMap((x) => rows.map((r) => val(r, x.s) ?? NaN))
  const leftFmt: NumberFormat | undefined = stack === 'percent' ? { style: 'percent', decimals: 0 } : spec.format ?? left[0]?.s.format
  const rightFmt: NumberFormat | undefined = spec.kind === 'pareto' ? { style: 'percent', decimals: 0 } : spec.rightFormat ?? right[0]?.s.format
  // margins: room for tick labels
  const pad = { top: 10, right: 10, bottom: 22, left: 8 }
  const marks: Mark[] = []
  const points: Datum[] = []
  let catScale: { pos: (i: number) => number; bw: number; step: number }
  let vScale: LinearScale
  let rScale: LinearScale | null = null
  if (horizontal) {
    const maxLabel = Math.min(Math.max(...labels.map((l) => textWidth(l, FONT))) + 10, spec.width * 0.35)
    pad.left = Math.max(40, maxLabel)
    pad.bottom = 22
    const plot: Plot = { x: pad.left, y: pad.top, w: Math.max(10, spec.width - pad.left - pad.right - 10), h: Math.max(10, spec.height - pad.top - pad.bottom) }
    vScale = linear(leftValues, [plot.x, plot.x + plot.w], { min: spec.min, max: stack === 'percent' ? 1 : spec.max })
    const b = band(rows.length, [plot.y, plot.y + plot.h], spec.kind === 'histogram' ? 0.04 : 0.25)
    catScale = { pos: (i) => b(i) + b.bandwidth / 2, bw: b.bandwidth, step: b.step }
    valueAxis(marks, vScale, plot, 'bottom', leftFmt, spec, spec.grid !== false)
    categoryAxis(marks, labels, catScale.pos, b.step, plot, true, pad.left)
    const zero = vScale(Math.max(vScale.domain[0], Math.min(0, vScale.domain[1])))
    marks.push({ t: 'line', x1: r2(zero), y1: plot.y, x2: r2(zero), y2: plot.y + plot.h, stroke: 'axis', width: 1 })
    rows.forEach((r, ci) => {
      const dim = spec.selected != null && spec.selected !== labels[ci] ? 0.35 : 1
      const group = left
      const sub = band(stack === 'none' ? group.length : 1, [b(ci), b(ci) + b.bandwidth], 0.1, 0)
      group.forEach((x, k) => {
        const v = val(r, x.s)
        if (v === null) return
        let a: number, z: number
        if (leftStacked) {
          const p = leftStacked[ci]!.parts[k]!
          const div = stack === 'percent' ? leftStacked[ci]!.abs || 1 : 1
          a = vScale(p[0] / div); z = vScale(p[1] / div)
        } else { a = vScale(0 < vScale.domain[0] ? vScale.domain[0] : 0); z = vScale(v) }
        const y = stack === 'none' ? sub(k) : b(ci)
        const h = stack === 'none' ? sub.bandwidth : b.bandwidth
        const datum: Datum = { index: ci, series: x.s.key, label: labels[ci]!, value: v, text: `${labels[ci]} · ${x.s.label ?? x.s.key}: ${fmt(spec, v, x.s.format)}`, row: r }
        marks.push({ t: 'rect', x: r2(Math.min(a, z)), y: r2(y), w: r2(Math.max(1, Math.abs(z - a))), h: r2(h), fill: x.color, rx: 3, opacity: dim, datum })
        points.push(datum)
        if (spec.dataLabels && stack === 'none') marks.push({ t: 'text', x: r2(Math.max(a, z) + 4), y: r2(y + h / 2), text: fmt(spec, v, x.s.format), size: 10, fill: 'muted', baseline: 'middle' })
      })
    })
    if (spec.target !== undefined && spec.target !== null) marks.push({ t: 'line', x1: r2(vScale(spec.target)), y1: plot.y, x2: r2(vScale(spec.target)), y2: plot.y + plot.h, stroke: 'bad', width: 1.5, dash: '4 3' })
  } else {
    // vertical: compute the value scale on a provisional plot, then the left margin from its tick labels
    const prov: Plot = { x: 0, y: pad.top, w: 100, h: Math.max(10, spec.height - pad.top - pad.bottom) }
    const vs0 = linear(leftValues.length ? leftValues : [0], [prov.y + prov.h, prov.y], { min: spec.min, max: stack === 'percent' ? 1 : spec.max })
    pad.left = tickWidth(vs0, leftFmt, spec) + 10
    if (right.length || spec.kind === 'pareto') {
      const rs0 = linear(rightValues.length ? rightValues : [0], [prov.y + prov.h, prov.y], spec.kind === 'pareto' ? { min: 0, max: 1 } : {})
      pad.right = tickWidth(rs0, rightFmt, spec) + 10
    }
    const plot: Plot = { x: pad.left, y: pad.top, w: Math.max(10, spec.width - pad.left - pad.right), h: Math.max(10, spec.height - pad.top - pad.bottom) }
    vScale = linear(leftValues.length ? leftValues : [0], [plot.y + plot.h, plot.y], { min: spec.min, max: stack === 'percent' ? 1 : spec.max })
    if (right.length || spec.kind === 'pareto') rScale = linear(rightValues.length ? rightValues : [0], [plot.y + plot.h, plot.y], spec.kind === 'pareto' ? { min: 0, max: 1 } : {})
    const barSeries = vis.filter((x) => kindOf(x.s) === 'bar')
    const b = band(rows.length, [plot.x, plot.x + plot.w], spec.kind === 'histogram' ? 0.04 : barSeries.length ? 0.25 : 0, barSeries.length ? 0.1 : 0)
    // lines over a band axis sit in the band centres
    catScale = { pos: (i) => b(i) + b.bandwidth / 2, bw: b.bandwidth, step: b.step }
    valueAxis(marks, vScale, plot, 'left', leftFmt, spec, spec.grid !== false)
    if (rScale) valueAxis(marks, rScale, plot, 'right', rightFmt, spec, false)
    categoryAxis(marks, labels, catScale.pos, b.step, plot, false)
    const zeroY = vScale(Math.max(vScale.domain[0], Math.min(0, vScale.domain[1])))
    if (vScale.domain[0] < 0) marks.push({ t: 'line', x1: plot.x, y1: r2(zeroY), x2: plot.x + plot.w, y2: r2(zeroY), stroke: 'axis', width: 1 })
    // bars
    const barsLeft = barSeries.filter((x) => x.s.axis !== 'right')
    const barStack = stack !== 'none' ? stackOf(barsLeft) : null
    rows.forEach((r, ci) => {
      const dim = spec.selected != null && spec.selected !== labels[ci] ? 0.35 : 1
      const sub = band(barStack ? 1 : barSeries.length, [b(ci), b(ci) + b.bandwidth], 0.08, 0)
      barSeries.forEach((x, k) => {
        const v = val(r, x.s)
        if (v === null) return
        const sc = x.s.axis === 'right' && rScale ? rScale : vScale
        let a: number, z: number
        const bi = barsLeft.indexOf(x)
        if (barStack && bi >= 0) {
          const p = barStack[ci]!.parts[bi]!
          const div = stack === 'percent' ? barStack[ci]!.abs || 1 : 1
          a = sc(p[0] / div); z = sc(p[1] / div)
        } else { a = sc(Math.max(sc.domain[0], Math.min(0, sc.domain[1]))); z = sc(v) }
        const xx = barStack ? b(ci) : sub(k)
        const w = barStack ? b.bandwidth : sub.bandwidth
        const datum: Datum = { index: ci, series: x.s.key, label: labels[ci]!, value: v, text: `${labels[ci]} · ${x.s.label ?? x.s.key}: ${fmt(spec, v, x.s.format)}${stack === 'percent' ? ` (${formatNumber(v / (barStack![ci]!.abs || 1), { style: 'percent', decimals: 1 }, spec.defaults)})` : ''}`, row: r }
        marks.push({ t: 'rect', x: r2(xx), y: r2(Math.min(a, z)), w: r2(Math.max(1, w)), h: r2(Math.max(v === 0 ? 0 : 1, Math.abs(z - a))), fill: x.color, rx: barStack ? 0 : Math.min(3, w / 4), opacity: dim, datum })
        points.push(datum)
        if (spec.dataLabels && !barStack && w > 14) marks.push({ t: 'text', x: r2(xx + w / 2), y: r2(Math.min(a, z) - 4), text: fmt(spec, v, { ...(x.s.format ?? spec.format ?? {}), compact: true }), size: 10, fill: 'muted', anchor: 'middle' })
      })
    })
    // lines and areas (stacked areas share one cumulative baseline)
    const lineSeries = vis.filter((x) => kindOf(x.s) !== 'bar')
    const areaStack = spec.kind === 'area' && stack !== 'none' ? stackOf(lineSeries) : null
    lineSeries.forEach((x, k) => {
      const sc = x.s.axis === 'right' && rScale ? rScale : vScale
      const pts: ({ x: number; y: number; y0: number; v: number; i: number } | null)[] = rows.map((r, i) => {
        const v = val(r, x.s)
        if (v === null) return null
        if (areaStack) {
          const p = areaStack[i]!.parts[k]!
          const div = stack === 'percent' ? areaStack[i]!.abs || 1 : 1
          return { x: catScale.pos(i), y: sc(p[1] / div), y0: sc(p[0] / div), v, i }
        }
        return { x: catScale.pos(i), y: sc(v), y0: sc(Math.max(sc.domain[0], Math.min(0, sc.domain[1]))), v, i }
      })
      const segs: { x: number; y: number; y0: number; v: number; i: number }[][] = []
      let cur: { x: number; y: number; y0: number; v: number; i: number }[] = []
      for (const p of pts) {
        if (p) cur.push(p)
        else if (spec.missing !== 'connect') { if (cur.length) segs.push(cur); cur = [] }
      }
      if (cur.length) segs.push(cur)
      const step = spec.curve === 'step'
      const linePath = (seg: typeof cur, key: 'y' | 'y0' = 'y'): string => seg.map((p, j) => {
        if (j === 0) return `M${r2(p.x)},${r2(p[key])}`
        if (step) return `H${r2((seg[j - 1]!.x + p.x) / 2)}V${r2(p[key])}H${r2(p.x)}`
        return `L${r2(p.x)},${r2(p[key])}`
      }).join('')
      for (const seg of segs) {
        if (kindOf(x.s) === 'area') {
          const back = [...seg].reverse()
          const d = `${linePath(seg)}L${r2(back[0]!.x)},${r2(back[0]!.y0)}${back.slice(1).map((p) => (step ? `H${r2(p.x)}V${r2(p.y0)}` : `L${r2(p.x)},${r2(p.y0)}`)).join('')}Z`
          marks.push({ t: 'path', d, fill: x.color, opacity: 0.18 })
        }
        marks.push({ t: 'path', d: linePath(seg), stroke: x.color, width: 2, dash: x.s.dashed ? '5 4' : undefined, cap: 'round' })
      }
      const showDots = rows.length <= 60
      for (const p of pts) {
        if (!p) continue
        const datum: Datum = { index: p.i, series: x.s.key, label: labels[p.i]!, value: p.v, text: `${labels[p.i]} · ${x.s.label ?? x.s.key}: ${fmt(spec, p.v, x.s.format)}`, row: rows[p.i] }
        const dim = spec.selected != null && spec.selected !== labels[p.i] ? 0.35 : 1
        marks.push({ t: 'circle', cx: r2(p.x), cy: r2(p.y), r: showDots ? 3 : 0, fill: x.color, stroke: 'bg', width: 1, opacity: dim, datum })
        points.push(datum)
      }
    })
    // pareto: cumulative share of the first series on the right axis, and the 80 % line
    if (spec.kind === 'pareto' && rScale && left[0]) {
      const total = rows.reduce((t, r) => t + Math.max(0, val(r, left[0]!.s) ?? 0), 0) || 1
      let acc = 0
      const cum = rows.map((r, i) => { acc += Math.max(0, val(r, left[0]!.s) ?? 0); return { x: catScale.pos(i), y: rScale!(acc / total), share: acc / total, i } })
      marks.push({ t: 'path', d: cum.map((p, j) => `${j ? 'L' : 'M'}${r2(p.x)},${r2(p.y)}`).join(''), stroke: 'warn', width: 2 })
      for (const p of cum) {
        const datum: Datum = { index: p.i, series: '__cum', label: labels[p.i]!, value: p.share, text: `${labels[p.i]} · cumulative: ${formatNumber(p.share, { style: 'percent', decimals: 1 }, spec.defaults)}`, row: rows[p.i] }
        marks.push({ t: 'circle', cx: r2(p.x), cy: r2(p.y), r: 3, fill: 'warn', stroke: 'bg', width: 1, datum })
      }
      const y80 = rScale(0.8)
      marks.push({ t: 'line', x1: plot.x, y1: r2(y80), x2: plot.x + plot.w, y2: r2(y80), stroke: 'muted', width: 1, dash: '3 3' })
      marks.push({ t: 'text', x: plot.x + plot.w - 4, y: r2(y80 - 4), text: '80%', size: 10, fill: 'muted', anchor: 'end' })
      legend.push({ key: '__cum', label: 'Cumulative %', color: 'warn', hidden: false })
    }
    for (const l of spec.referenceLines ?? []) {
      const sc = l.axis === 'right' && rScale ? rScale : vScale
      const y = sc(l.value)
      marks.push({ t: 'line', x1: plot.x, y1: r2(y), x2: plot.x + plot.w, y2: r2(y), stroke: 'muted', width: 1, dash: '4 3' })
      if (l.label) marks.push({ t: 'text', x: plot.x + plot.w - 4, y: r2(y - 4), text: l.label, size: 10, fill: 'muted', anchor: 'end' })
    }
    if (spec.target !== undefined && spec.target !== null) {
      const y = vScale(spec.target)
      marks.push({ t: 'line', x1: plot.x, y1: r2(y), x2: plot.x + plot.w, y2: r2(y), stroke: 'bad', width: 1.5, dash: '4 3' })
      marks.push({ t: 'text', x: plot.x + 4, y: r2(y - 4), text: `Target ${fmt(spec, spec.target)}`, size: 10, fill: 'bad' })
    }
  }
  const first = vis[0]
  let summary = `${KIND_NAME[spec.kind]}${spec.title ? ` "${spec.title}"` : ''}: ${vis.map((x) => x.s.label ?? x.s.key).join(', ') || 'no series'} by ${spec.category ?? 'category'}, ${rows.length} ${rows.length === 1 ? 'point' : 'points'}`
  if (first) {
    let hi = -Infinity, at = -1
    rows.forEach((r, i) => { const v = val(r, first.s); if (v !== null && v > hi) { hi = v; at = i } })
    if (at >= 0) summary += `; highest ${first.s.label ?? first.s.key} ${fmt(spec, hi, first.s.format)} at ${labels[at]}`
  }
  return { width: spec.width, height: spec.height, marks, legend, table, summary, points }
}

/* ------------------------------------------------------------------ pie / donut */

function arcPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  // angles in radians, 0 = 12 o'clock, clockwise
  const p = (r: number, a: number) => [r2(cx + r * Math.sin(a)), r2(cy - r * Math.cos(a))]
  const large = a1 - a0 > Math.PI ? 1 : 0
  if (a1 - a0 >= Math.PI * 2 - 1e-6) {
    // full circle: two halves
    const m = a0 + Math.PI
    return arcPath(cx, cy, r0, r1, a0, m) + arcPath(cx, cy, r0, r1, m, a1)
  }
  const [x0, y0] = p(r1, a0), [x1, y1] = p(r1, a1)
  if (r0 <= 0) return `M${r2(cx)},${r2(cy)}L${x0},${y0}A${r2(r1)},${r2(r1)} 0 ${large} 1 ${x1},${y1}Z`
  const [x2, y2] = p(r0, a1), [x3, y3] = p(r0, a0)
  return `M${x0},${y0}A${r2(r1)},${r2(r1)} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${r2(r0)},${r2(r0)} 0 ${large} 0 ${x3},${y3}Z`
}

function pie(spec: ChartSpec, rows: Row[]): Scene {
  const s = spec.series?.[0]
  const labels = rows.map((r) => categoryText(spec.category ? r[spec.category] : undefined, spec.categoryType, spec.categoryGrain, spec))
  const hidden = new Set(spec.hidden ?? [])
  const legend: LegendItem[] = rows.map((_, i) => ({ key: labels[i]!, label: labels[i]!, color: seriesPaint(i), hidden: hidden.has(labels[i]!) }))
  const values = rows.map((r) => (s ? Math.max(0, num(r[s.key]) ?? 0) : 0))
  const total = values.reduce((a, b, i) => a + (hidden.has(labels[i]!) ? 0 : b), 0)
  const table = { columns: [spec.category ?? 'Category', s?.label ?? s?.key ?? 'Value', 'Share'], rows: rows.map((_, i) => [labels[i]!, fmt(spec, values[i]!, s?.format), formatNumber(total ? values[i]! / total : 0, { style: 'percent', decimals: 1 }, spec.defaults)]) }
  if (!rows.length || !s) return { ...emptyScene(spec, spec.emptyText ?? 'No data'), legend, table }
  if (!total) return { ...emptyScene(spec, 'All values are zero'), legend, table }
  const marks: Mark[] = []
  const points: Datum[] = []
  const cx = spec.width / 2, cy = spec.height / 2
  const r1 = Math.max(10, Math.min(spec.width, spec.height) / 2 - 8)
  const r0 = spec.kind === 'donut' ? r1 * 0.6 : 0
  let a = 0
  rows.forEach((row, i) => {
    if (hidden.has(labels[i]!)) return
    const v = values[i]!
    const da = (v / total) * Math.PI * 2
    if (da <= 0) return
    const dim = spec.selected != null && spec.selected !== labels[i] ? 0.35 : 1
    const share = formatNumber(v / total, { style: 'percent', decimals: 1 }, spec.defaults)
    const datum: Datum = { index: i, series: s.key, label: labels[i]!, value: v, text: `${labels[i]}: ${fmt(spec, v, s.format)} (${share})`, row }
    marks.push({ t: 'path', d: arcPath(cx, cy, r0, r1, a, a + da), fill: seriesPaint(i), stroke: 'bg', width: 1.5, opacity: dim, datum })
    points.push(datum)
    if (da > 0.35 && r1 > 50) {
      const mid = a + da / 2
      const rr = r0 ? (r0 + r1) / 2 : r1 * 0.65
      marks.push({ t: 'text', x: r2(cx + rr * Math.sin(mid)), y: r2(cy - rr * Math.cos(mid)), text: share, size: 10, fill: '#ffffff', anchor: 'middle', baseline: 'middle', weight: 600 })
    }
    a += da
  })
  if (r0 > 24) {
    marks.push({ t: 'text', x: r2(cx), y: r2(cy - 2), text: fmt(spec, total, { ...(s.format ?? spec.format ?? {}), compact: total >= 1e5 }), size: Math.min(22, r0 / 2.4), fill: 'text', anchor: 'middle', weight: 600, baseline: 'auto' })
    marks.push({ t: 'text', x: r2(cx), y: r2(cy + 14), text: 'Total', size: 10, fill: 'muted', anchor: 'middle' })
  }
  const top = points.slice().sort((x, y) => (y.value ?? 0) - (x.value ?? 0))[0]
  return { width: spec.width, height: spec.height, marks, legend, table, points, summary: `${KIND_NAME[spec.kind]}${spec.title ? ` "${spec.title}"` : ''}: ${points.length} slices, total ${fmt(spec, total, s.format)}${top ? `; largest ${top.label} (${top.text.split('(').pop()?.replace(')', '')})` : ''}` }
}

/* ------------------------------------------------------------------ scatter */

function scatter(spec: ChartSpec, rows: Row[]): Scene {
  const xk = spec.x ?? spec.series?.[0]?.key ?? ''
  const yk = spec.y ?? spec.series?.[1]?.key ?? ''
  const table = { columns: [spec.colorBy ?? 'Point', xk, yk, ...(spec.size ? [spec.size] : [])], rows: rows.map((r, i) => [spec.colorBy ? categoryText(r[spec.colorBy], 'text', undefined, spec) : String(i + 1), fmt(spec, num(r[xk])), fmt(spec, num(r[yk])), ...(spec.size ? [fmt(spec, num(r[spec.size]))] : [])]) }
  const pts = rows.map((r, i) => ({ x: num(r[xk]), y: num(r[yk]), s: spec.size ? num(r[spec.size]) : null, i, r })).filter((p) => p.x !== null && p.y !== null) as { x: number; y: number; s: number | null; i: number; r: Row }[]
  if (!pts.length) return { ...emptyScene(spec, spec.emptyText ?? 'No data'), table }
  const cats = spec.colorBy ? [...new Set(rows.map((r) => categoryText(r[spec.colorBy!], 'text', undefined, spec)))] : []
  const hidden = new Set(spec.hidden ?? [])
  const legend: LegendItem[] = cats.map((c, i) => ({ key: c, label: c, color: seriesPaint(i), hidden: hidden.has(c) }))
  const marks: Mark[] = []
  const points: Datum[] = []
  const prov = linear(pts.map((p) => p.y), [spec.height - 24, 10], { zero: false })
  const plot: Plot = { x: tickWidth(prov, spec.format, spec) + 10, y: 10, w: 0, h: Math.max(10, spec.height - 34) }
  plot.w = Math.max(10, spec.width - plot.x - 12)
  const xs = linear(pts.map((p) => p.x), [plot.x, plot.x + plot.w], { zero: false })
  const ys = linear(pts.map((p) => p.y), [plot.y + plot.h, plot.y], { zero: false })
  valueAxis(marks, ys, plot, 'left', spec.format, spec, spec.grid !== false)
  valueAxis(marks, xs, plot, 'bottom', spec.format, spec, false)
  const smax = Math.max(...pts.map((p) => Math.abs(p.s ?? 0)), 1)
  for (const p of pts) {
    const cat = spec.colorBy ? categoryText(p.r[spec.colorBy], 'text', undefined, spec) : ''
    if (cat && hidden.has(cat)) continue
    const ci = cats.indexOf(cat)
    const datum: Datum = { index: p.i, label: cat || `Point ${p.i + 1}`, value: p.y, text: `${cat ? cat + ' · ' : ''}${xk}: ${fmt(spec, p.x)}, ${yk}: ${fmt(spec, p.y)}${p.s !== null ? `, ${spec.size}: ${fmt(spec, p.s)}` : ''}`, row: p.r }
    marks.push({ t: 'circle', cx: r2(xs(p.x)), cy: r2(ys(p.y)), r: r2(spec.size ? 3 + 9 * Math.sqrt(Math.abs(p.s ?? 0) / smax) : 4), fill: seriesPaint(Math.max(0, ci)), opacity: 0.75, stroke: 'bg', width: 1, datum })
    points.push(datum)
  }
  return { width: spec.width, height: spec.height, marks, legend, table, points, summary: `Scatter chart${spec.title ? ` "${spec.title}"` : ''}: ${yk} against ${xk}, ${pts.length} points` }
}

/* ------------------------------------------------------------------ heatmap */

function heatmap(spec: ChartSpec, rows: Row[]): Scene {
  const vk = spec.series?.[0]?.key ?? 'Value'
  const ck = spec.column ?? spec.category ?? ''
  const rk = spec.row ?? ''
  const colLabel = (v: unknown) => categoryText(v, spec.categoryType, spec.categoryGrain, spec)
  const rowLabel = (v: unknown) => categoryText(v, spec.rowType, spec.rowGrain, spec)
  const cols: string[] = [], rws: string[] = []
  const cell = new Map<string, { v: number | null; r: Row }>()
  for (const r of rows) {
    const c = colLabel(r[ck]), w = rowLabel(r[rk])
    if (!cols.includes(c)) cols.push(c)
    if (!rws.includes(w)) rws.push(w)
    cell.set(`${w}\u0001${c}`, { v: num(r[vk]), r })
  }
  const table = { columns: [rk || 'Row', ...cols], rows: rws.map((w) => [w, ...cols.map((c) => fmt(spec, cell.get(`${w}\u0001${c}`)?.v ?? null, spec.series?.[0]?.format))]) }
  if (!rows.length) return { ...emptyScene(spec, spec.emptyText ?? 'No data'), table }
  const values = [...cell.values()].map((x) => x.v).filter((v): v is number => v !== null)
  const lo = Math.min(...values, 0), hi = Math.max(...values, 1)
  const marks: Mark[] = []
  const points: Datum[] = []
  const left = Math.min(Math.max(...rws.map((w) => textWidth(w, FONT))) + 10, spec.width * 0.3)
  const plot: Plot = { x: left, y: 6, w: Math.max(10, spec.width - left - 6), h: Math.max(10, spec.height - 30) }
  const bx = band(cols.length, [plot.x, plot.x + plot.w], 0.06, 0)
  const by = band(rws.length, [plot.y, plot.y + plot.h], 0.06, 0)
  categoryAxis(marks, cols, (i) => bx(i) + bx.bandwidth / 2, bx.step, plot, false)
  marks.pop() // no axis line under a heat map
  categoryAxis(marks, rws, (i) => by(i) + by.bandwidth / 2, by.step, plot, true, left)
  rws.forEach((w, yi) => cols.forEach((c, xi) => {
    const x = cell.get(`${w}\u0001${c}`)
    const v = x?.v ?? null
    const t = v === null ? 0 : (v - lo) / (hi - lo || 1)
    const datum: Datum = { index: points.length, label: `${w} · ${c}`, value: v, text: `${w} · ${c}: ${fmt(spec, v, spec.series?.[0]?.format)}`, row: x?.r }
    marks.push({ t: 'rect', x: r2(bx(xi)), y: r2(by(yi)), w: r2(bx.bandwidth), h: r2(by.bandwidth), fill: v === null ? 'track' : seriesPaint(0), opacity: v === null ? 1 : r2(0.12 + 0.88 * t), rx: 2, datum })
    points.push(datum)
    if (v !== null && bx.bandwidth > 30 && by.bandwidth > 14) marks.push({ t: 'text', x: r2(bx(xi) + bx.bandwidth / 2), y: r2(by(yi) + by.bandwidth / 2), text: fmt(spec, v, { ...(spec.series?.[0]?.format ?? spec.format ?? {}), compact: true }), size: 10, fill: t > 0.55 ? '#ffffff' : 'text', anchor: 'middle', baseline: 'middle' })
  }))
  return { width: spec.width, height: spec.height, marks, legend: [], table, points, summary: `Heat map${spec.title ? ` "${spec.title}"` : ''}: ${vk} by ${rk} and ${ck}, ${rws.length} x ${cols.length}; range ${fmt(spec, lo)} to ${fmt(spec, hi)}` }
}

/* ------------------------------------------------------------------ gauge, bullet */

function statusOf(v: number | null, bands: ChartSpec['bands']): Status | undefined {
  if (v === null) return undefined
  for (const b of bands ?? []) if (b.status && v >= b.from && v <= b.to) return b.status
  return undefined
}

function singleValue(spec: ChartSpec, rows: Row[]): number | null {
  const k = spec.series?.[0]?.key
  if (spec.kpi) return spec.kpi.value
  return k && rows[0] ? num(rows[0][k]) : null
}

function gauge(spec: ChartSpec, rows: Row[]): Scene {
  const v = singleValue(spec, rows)
  const min = spec.min ?? 0
  const max = spec.max ?? (spec.format?.style === 'percent' && spec.format.fraction !== false ? 1 : Math.max(100, v ?? 0))
  const f = spec.series?.[0]?.format ?? spec.format
  const label = spec.series?.[0]?.label ?? spec.title ?? 'Value'
  const status = statusOf(v, spec.bands)
  const table = { columns: ['Measure', 'Value', ...(spec.target != null ? ['Target'] : [])], rows: [[label, fmt(spec, v, f), ...(spec.target != null ? [fmt(spec, spec.target, f)] : [])]] }
  const marks: Mark[] = []
  const cx = spec.width / 2
  const r1 = Math.max(20, Math.min(spec.width / 2 - 10, spec.height - 34))
  const cy = Math.min(spec.height - 24, r1 + 12)
  const r0 = r1 * 0.72
  const ang = (x: number) => -Math.PI / 2 + Math.PI * Math.max(0, Math.min(1, (x - min) / (max - min || 1)))
  marks.push({ t: 'path', d: arcPath(cx, cy, r0, r1, -Math.PI / 2, Math.PI / 2), fill: 'track' })
  for (const b of spec.bands ?? []) {
    const p = b.color ?? b.status ?? 'muted'
    marks.push({ t: 'path', d: arcPath(cx, cy, r1 + 3, r1 + 7, ang(Math.max(min, b.from)), ang(Math.min(max, b.to))), fill: p, opacity: 0.85 })
  }
  const datum: Datum = { index: 0, label, value: v, text: `${label}: ${fmt(spec, v, f)}${spec.target != null ? ` (target ${fmt(spec, spec.target, f)})` : ''}`, row: rows[0] }
  if (v !== null) marks.push({ t: 'path', d: arcPath(cx, cy, r0, r1, -Math.PI / 2, ang(v)), fill: status ?? seriesPaint(0), datum })
  if (spec.target != null) {
    const a = ang(spec.target)
    marks.push({ t: 'line', x1: r2(cx + (r0 - 4) * Math.sin(a)), y1: r2(cy - (r0 - 4) * Math.cos(a)), x2: r2(cx + (r1 + 8) * Math.sin(a)), y2: r2(cy - (r1 + 8) * Math.cos(a)), stroke: 'text', width: 2 })
  }
  marks.push({ t: 'text', x: r2(cx), y: r2(cy - r0 * 0.25), text: fmt(spec, v, f), size: Math.max(14, Math.min(34, r0 / 2.2)), fill: 'text', anchor: 'middle', weight: 650 })
  if (status) marks.push({ t: 'text', x: r2(cx), y: r2(cy - 2), text: status === 'good' ? 'On target' : status === 'warn' ? 'Watch' : 'Below target', size: 11, fill: status, anchor: 'middle', weight: 600 })
  marks.push({ t: 'text', x: r2(cx - (r0 + r1) / 2), y: r2(cy + 14), text: fmt(spec, min, { ...(f ?? {}), compact: true }), size: 10, fill: 'muted', anchor: 'middle' })
  marks.push({ t: 'text', x: r2(cx + (r0 + r1) / 2), y: r2(cy + 14), text: fmt(spec, max, { ...(f ?? {}), compact: true }), size: 10, fill: 'muted', anchor: 'middle' })
  return { width: spec.width, height: spec.height, marks, legend: [], table, points: [datum], summary: `Gauge${spec.title ? ` "${spec.title}"` : ''}: ${label} ${fmt(spec, v, f)} on a scale of ${fmt(spec, min, f)} to ${fmt(spec, max, f)}${status ? `, ${status === 'good' ? 'on target' : status === 'warn' ? 'watch' : 'below target'}` : ''}` }
}

function bullet(spec: ChartSpec, rows: Row[]): Scene {
  const s = spec.series?.[0]
  const items = spec.category ? rows : rows.slice(0, 1)
  const labels = items.map((r) => (spec.category ? categoryText(r[spec.category], spec.categoryType, spec.categoryGrain, spec) : s?.label ?? 'Value'))
  const vals = items.map((r) => (s ? num(r[s.key]) : null))
  const f = s?.format ?? spec.format
  const table = { columns: ['Measure', 'Value', ...(spec.target != null ? ['Target'] : [])], rows: items.map((_, i) => [labels[i]!, fmt(spec, vals[i]!, f), ...(spec.target != null ? [fmt(spec, spec.target, f)] : [])]) }
  if (!items.length) return { ...emptyScene(spec, spec.emptyText ?? 'No data'), table }
  const marks: Mark[] = []
  const points: Datum[] = []
  const left = Math.min(Math.max(...labels.map((l) => textWidth(l, FONT))) + 12, spec.width * 0.3)
  const plot: Plot = { x: left, y: 6, w: Math.max(10, spec.width - left - 14), h: Math.max(10, spec.height - 28) }
  const max = spec.max ?? Math.max(...vals.map((v) => v ?? 0), spec.target ?? 0, ...(spec.bands ?? []).map((b) => b.to)) * 1.05
  const xs = linear([spec.min ?? 0, max], [plot.x, plot.x + plot.w], { min: spec.min ?? 0, max })
  valueAxis(marks, xs, plot, 'bottom', f, spec, false)
  const by = band(items.length, [plot.y, plot.y + plot.h], 0.3, 0.05)
  items.forEach((r, i) => {
    const y = by(i), h = by.bandwidth
    marks.push({ t: 'rect', x: plot.x, y: r2(y), w: plot.w, h: r2(h), fill: 'track' })
    for (const b of spec.bands ?? []) marks.push({ t: 'rect', x: r2(xs(Math.max(xs.domain[0], b.from))), y: r2(y), w: r2(Math.max(0, xs(Math.min(max, b.to)) - xs(Math.max(xs.domain[0], b.from)))), h: r2(h), fill: b.color ?? b.status ?? 'muted', opacity: 0.22 })
    const v = vals[i]!
    const st = statusOf(v, spec.bands)
    const datum: Datum = { index: i, series: s?.key, label: labels[i]!, value: v, text: `${labels[i]}: ${fmt(spec, v, f)}${spec.target != null ? ` (target ${fmt(spec, spec.target, f)})` : ''}`, row: r }
    if (v !== null) marks.push({ t: 'rect', x: plot.x, y: r2(y + h * 0.3), w: r2(Math.max(1, xs(v) - plot.x)), h: r2(h * 0.4), fill: st ?? seriesPaint(0), datum })
    if (spec.target != null) marks.push({ t: 'line', x1: r2(xs(spec.target)), y1: r2(y + 2), x2: r2(xs(spec.target)), y2: r2(y + h - 2), stroke: 'text', width: 2.5 })
    marks.push({ t: 'text', x: plot.x - 6, y: r2(y + h / 2), text: fitText(labels[i]!, FONT, left - 8), size: FONT, fill: 'muted', anchor: 'end', baseline: 'middle' })
    points.push(datum)
  })
  return { width: spec.width, height: spec.height, marks, legend: [], table, points, summary: `Bullet chart${spec.title ? ` "${spec.title}"` : ''}: ${points.map((p) => p.text).join('; ')}` }
}

/* ------------------------------------------------------------------ KPI tile */

export interface KpiState { value: number | null; delta: number | null; deltaText: string; status?: Status; direction: 'up' | 'down' | 'flat' }

/** the KPI's delta and status (shared by the tile and the email snapshot) */
export function kpiState(k: KpiSpec, f: NumberFormat | undefined, d: FormatDefaults = DEFAULT_FORMAT): KpiState {
  const v = k.value
  const base = k.base ?? null
  let delta: number | null = null
  if (v !== null && base !== null) delta = k.deltaStyle === 'absolute' ? v - base : base === 0 ? null : (v - base) / Math.abs(base)
  // a change that rounds to zero in the shown text (0.0 %) is flat: no arrow colour for noise
  const flatBelow = k.deltaStyle === 'absolute' ? 1e-9 : 0.0005
  const direction = delta === null || Math.abs(delta) < flatBelow ? 'flat' : delta > 0 ? 'up' : 'down'
  let status: Status | undefined
  for (const r of k.rules ?? []) {
    const x = r.of === 'delta' ? delta : v
    if (x === null) continue
    const ok = r.op === 'lt' ? x < r.value : r.op === 'le' ? x <= r.value : r.op === 'gt' ? x > r.value : x >= r.value
    if (ok) { status = r.status; break }
  }
  if (!status && delta !== null && direction !== 'flat' && k.higherIsBetter !== undefined) status = (direction === 'up') === k.higherIsBetter ? 'good' : 'bad'
  const deltaText = delta === null ? '' : direction === 'flat' ? (k.deltaStyle === 'absolute' ? '0' : '0%') : k.deltaStyle === 'absolute' ? `${delta > 0 ? '+' : ''}${formatNumber(delta, f ?? {}, d)}` : `${delta > 0 ? '+' : ''}${formatNumber(delta, { style: 'percent', decimals: 1 }, d)}`
  return { value: v, delta, deltaText, status, direction }
}

function kpi(spec: ChartSpec, rows: Row[]): Scene {
  const k: KpiSpec = spec.kpi ?? { value: singleValue(spec, rows), label: spec.series?.[0]?.label }
  const f = spec.series?.[0]?.format ?? spec.format
  const st = kpiState(k, f, spec.defaults)
  const label = k.label ?? spec.title ?? 'Value'
  const marks: Mark[] = []
  const W = spec.width, H = spec.height
  const big = Math.max(16, Math.min(40, H * 0.3, W / Math.max(4, fmt(spec, k.value, f).length * 0.62)))
  if (k.showLabel !== false) marks.push({ t: 'text', x: 12, y: 20, text: fitText(label, 12, W - 24), size: 12, fill: 'muted' })
  marks.push({ t: 'text', x: 12, y: r2(20 + big + 6), text: fmt(spec, k.value, f), size: r2(big), fill: st.status && !k.base ? st.status : 'text', weight: 650 })
  if (st.deltaText) {
    const arrow = st.direction === 'up' ? '▲' : st.direction === 'down' ? '▼' : '■'
    marks.push({ t: 'text', x: 12, y: r2(20 + big + 26), text: `${arrow} ${st.deltaText}${k.baseLabel ? `  ${k.baseLabel}` : ''}`, size: 11, fill: st.status ?? 'muted', weight: 600 })
  }
  const spark = (k.spark ?? []).map((x) => (x === null || x === undefined ? null : Number(x)))
  if (spark.filter((x) => x !== null).length >= 2 && H > 90) {
    const top = 20 + big + 34, bottom = H - 6
    if (bottom - top > 12) {
      const ys = linear(spark.filter((x): x is number => x !== null), [bottom, top], { zero: false })
      const step = (W - 24) / Math.max(1, spark.length - 1)
      let d = ''
      spark.forEach((x, i) => { if (x !== null) d += `${d ? 'L' : 'M'}${r2(12 + i * step)},${r2(ys(x))}` })
      marks.push({ t: 'path', d, stroke: st.status ?? seriesPaint(0), width: 1.75, cap: 'round' })
      const lastI = spark.length - 1 - [...spark].reverse().findIndex((x) => x !== null)
      if (lastI >= 0 && spark[lastI] !== null) marks.push({ t: 'circle', cx: r2(12 + lastI * step), cy: r2(ys(spark[lastI]!)), r: 2.5, fill: st.status ?? seriesPaint(0) })
    }
  }
  const datum: Datum = { index: 0, label, value: k.value, text: `${label}: ${fmt(spec, k.value, f)}${st.deltaText ? `, ${st.deltaText} ${k.baseLabel ?? ''}` : ''}`, row: rows[0] }
  return {
    width: W, height: H, marks, legend: [], points: [datum],
    table: { columns: ['Measure', 'Value', ...(k.base !== undefined && k.base !== null ? [k.baseLabel ?? 'Comparison', 'Change'] : [])], rows: [[label, fmt(spec, k.value, f), ...(k.base !== undefined && k.base !== null ? [fmt(spec, k.base, f), st.deltaText] : [])]] },
    summary: `${label}: ${fmt(spec, k.value, f)}${st.deltaText ? `, ${st.direction === 'up' ? 'up' : st.direction === 'down' ? 'down' : 'unchanged'} ${st.deltaText.replace(/^[+-]/, '')} ${k.baseLabel ?? ''}` : ''}${st.status ? ` (${st.status === 'good' ? 'good' : st.status === 'warn' ? 'warning' : 'bad'})` : ''}`.trim(),
  }
}

/* ------------------------------------------------------------------ funnel */

function funnel(spec: ChartSpec, rows: Row[]): Scene {
  const s = spec.series?.[0]
  const labels = rows.map((r) => categoryText(spec.category ? r[spec.category] : undefined, spec.categoryType, spec.categoryGrain, spec))
  const vals = rows.map((r) => (s ? Math.max(0, num(r[s.key]) ?? 0) : 0))
  const first = vals[0] || 1
  const table = { columns: [spec.category ?? 'Stage', s?.label ?? s?.key ?? 'Value', 'Of first stage'], rows: rows.map((_, i) => [labels[i]!, fmt(spec, vals[i]!, s?.format), formatNumber(vals[i]! / first, { style: 'percent', decimals: 1 }, spec.defaults)]) }
  if (!rows.length || !s) return { ...emptyScene(spec, spec.emptyText ?? 'No data'), table }
  const marks: Mark[] = []
  const points: Datum[] = []
  const max = Math.max(...vals, 1)
  const by = band(rows.length, [4, spec.height - 4], 0.12, 0)
  const cx = spec.width / 2
  const wMax = spec.width - 16
  rows.forEach((r, i) => {
    const w = Math.max(2, (vals[i]! / max) * wMax)
    const dim = spec.selected != null && spec.selected !== labels[i] ? 0.35 : 1
    const datum: Datum = { index: i, series: s.key, label: labels[i]!, value: vals[i]!, text: `${labels[i]}: ${fmt(spec, vals[i]!, s.format)} (${formatNumber(vals[i]! / first, { style: 'percent', decimals: 1 }, spec.defaults)} of ${labels[0]})`, row: r }
    marks.push({ t: 'rect', x: r2(cx - w / 2), y: r2(by(i)), w: r2(w), h: r2(by.bandwidth), fill: seriesPaint(i), rx: 3, opacity: dim, datum })
    points.push(datum)
    if (by.bandwidth >= 14) marks.push({ t: 'text', x: r2(cx), y: r2(by(i) + by.bandwidth / 2), text: fitText(`${labels[i]}  ${fmt(spec, vals[i]!, { ...(s.format ?? spec.format ?? {}), compact: true })}  ${formatNumber(vals[i]! / first, { style: 'percent', decimals: 0 }, spec.defaults)}`, 11, wMax), size: 11, fill: w > 160 ? '#ffffff' : 'text', anchor: 'middle', baseline: 'middle', weight: 600 })
  })
  return { width: spec.width, height: spec.height, marks, legend: [], table, points, summary: `Funnel${spec.title ? ` "${spec.title}"` : ''}: ${rows.length} stages from ${labels[0]} (${fmt(spec, vals[0]!, s.format)}) to ${labels[labels.length - 1]} (${fmt(spec, vals[vals.length - 1]!, s.format)})` }
}

/* ------------------------------------------------------------------ timeline (machine status, Gantt-lite) */

function timeline(spec: ChartSpec, rows: Row[]): Scene {
  const lk = spec.lane ?? spec.category ?? ''
  const sk = spec.start ?? '', ek = spec.end ?? '', stk = spec.status ?? ''
  const t = (v: unknown): number | null => (v instanceof Date ? v.getTime() : typeof v === 'string' && v ? Date.parse(v) : typeof v === 'number' ? v : null)
  const items = rows.map((r, i) => ({ lane: categoryText(r[lk], 'text', undefined, spec), a: t(r[sk]), b: t(r[ek]), st: stk ? String(r[stk] ?? '') : '', r, i })).filter((x) => x.a !== null && Number.isFinite(x.a)) as { lane: string; a: number; b: number | null; st: string; r: Row; i: number }[]
  const when = (x: number) => formatDate(new Date(x), 'datetime', {}, spec.defaults ?? DEFAULT_FORMAT)
  const table = { columns: [lk || 'Lane', 'Start', 'End', ...(stk ? [stk] : [])], rows: items.map((x) => [x.lane, when(x.a), x.b !== null && Number.isFinite(x.b) ? when(x.b) : '(open)', ...(stk ? [x.st] : [])]) }
  if (!items.length) return { ...emptyScene(spec, spec.emptyText ?? 'No events'), table }
  const now = Date.now()
  const lo = spec.min ?? Math.min(...items.map((x) => x.a))
  const hi = spec.max ?? Math.max(...items.map((x) => (x.b !== null && Number.isFinite(x.b) ? x.b : Math.max(x.a, now))))
  const lanes = [...new Set(items.map((x) => x.lane))]
  const statuses = [...new Set(items.map((x) => x.st))]
  const colorOf = (st: string): Paint => spec.statusColors?.[st] ?? (/(run|up|ok|good|on)/i.test(st) ? 'good' : /(down|break|stop|fail|bad)/i.test(st) ? 'bad' : /(idle|change|setup|wait|warn|planned)/i.test(st) ? 'warn' : seriesPaint(statuses.indexOf(st)))
  const legend: LegendItem[] = stk ? statuses.map((s) => ({ key: s, label: s || '(blank)', color: colorOf(s), hidden: false })) : []
  const marks: Mark[] = []
  const points: Datum[] = []
  const left = Math.min(Math.max(...lanes.map((l) => textWidth(l, FONT))) + 12, spec.width * 0.3)
  const plot: Plot = { x: left, y: 6, w: Math.max(10, spec.width - left - 10), h: Math.max(10, spec.height - 28) }
  const xs = (x: number) => plot.x + ((x - lo) / (hi - lo || 1)) * plot.w
  const by = band(lanes.length, [plot.y, plot.y + plot.h], 0.25, 0.05)
  const ticks = 5
  for (let k = 0; k <= ticks; k++) {
    const x = lo + ((hi - lo) * k) / ticks
    marks.push({ t: 'line', x1: r2(xs(x)), y1: plot.y, x2: r2(xs(x)), y2: plot.y + plot.h, stroke: 'grid', width: 1 })
    marks.push({ t: 'text', x: r2(xs(x)), y: plot.y + plot.h + 14, text: formatDate(new Date(x), hi - lo > 3 * 86_400_000 ? 'day' : 'datetime', {}, spec.defaults ?? DEFAULT_FORMAT), size: 10, fill: 'muted', anchor: k === 0 ? 'start' : k === ticks ? 'end' : 'middle' })
  }
  lanes.forEach((l, i) => marks.push({ t: 'text', x: plot.x - 6, y: r2(by(i) + by.bandwidth / 2), text: fitText(l, FONT, left - 8), size: FONT, fill: 'muted', anchor: 'end', baseline: 'middle' }))
  for (const x of items) {
    const li = lanes.indexOf(x.lane)
    const b = x.b !== null && Number.isFinite(x.b) ? x.b : Math.max(x.a, Math.min(now, hi))
    const datum: Datum = { index: x.i, label: x.lane, text: `${x.lane}${x.st ? ` · ${x.st}` : ''}: ${when(x.a)} to ${x.b !== null && Number.isFinite(x.b) ? when(x.b) : 'now'} (${Math.round((b - x.a) / 60000)} min)`, row: x.r }
    marks.push({ t: 'rect', x: r2(xs(Math.max(lo, x.a))), y: r2(by(li)), w: r2(Math.max(1.5, xs(Math.min(hi, b)) - xs(Math.max(lo, x.a)))), h: r2(by.bandwidth), fill: colorOf(x.st), rx: 2, datum })
    points.push(datum)
  }
  return { width: spec.width, height: spec.height, marks, legend, table, points, summary: `Timeline${spec.title ? ` "${spec.title}"` : ''}: ${items.length} periods on ${lanes.length} ${lanes.length === 1 ? 'lane' : 'lanes'}` }
}

/* ------------------------------------------------------------------ entry */

/** the geometry of a chart: marks in a width x height box */
export function chartScene(spec: ChartSpec, rows: Row[]): Scene {
  const s: ChartSpec = { ...spec, width: Math.max(40, Math.round(spec.width)), height: Math.max(30, Math.round(spec.height)) }
  switch (s.kind) {
    case 'pie': case 'donut': return pie(s, rows)
    case 'scatter': return scatter(s, rows)
    case 'heatmap': return heatmap(s, rows)
    case 'gauge': return gauge(s, rows)
    case 'bullet': return bullet(s, rows)
    case 'kpi': return kpi(s, rows)
    case 'funnel': return funnel(s, rows)
    case 'timeline': return timeline(s, rows)
    default: return cartesian(s, rows)
  }
}
