/**
 * Charts of the print engine: bar, line, pie and gauge drawn as vector shapes (docs/dev/pdf.md "Charts").
 *
 * `chartShapes(spec, w, h, measure)` returns shapes in a w x h box (points, origin top-left); the layout engine turns
 * them into PDF drawing operations, and `printChartSvg(spec, w, h)` turns the same shapes into an SVG string. A
 * deliberately small renderer for paper output. Package C's renderChartSvg (src/charts/svg.ts) produces SVG only; using it
 * here needs an SVG-to-PDF step (not built yet): this duplication is known (docs/dev/pdf.md).
 */

export interface ChartSpec {
  type: 'bar' | 'line' | 'pie' | 'gauge'
  title?: string
  categories: string[]
  series: { name: string; values: (number | null)[]; color?: string }[]
  /** gauge */
  value?: number | null
  min?: number
  max?: number
  bands?: number[]
  unit?: string
  /** formats a number for labels (the template's grouping) */
  format?: (n: number) => string
}

export type Shape =
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; lw?: number }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; color: string; lw: number; dash?: number[] }
  | { t: 'path'; d: string; fill?: string; stroke?: string; lw?: number }
  | { t: 'text'; x: number; y: number; text: string; size: number; color: string; anchor: 'start' | 'middle' | 'end'; bold?: boolean }

export const PALETTE = ['#4f46e5', '#0891b2', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#475569']
const AXIS = '#94a3b8'
const GRID = '#e2e8f0'
const INK = '#334155'

type Measure = (text: string, size: number, bold?: boolean) => number
const roughMeasure: Measure = (t, s) => t.length * s * 0.55

function niceMax(v: number): number {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p
  return 10 * p
}

const fmt = (spec: ChartSpec, n: number): string => (spec.format ? spec.format(n) : Number.isInteger(n) ? String(n) : n.toFixed(1)) + (spec.unit ?? '')

function clipText(t: string, maxW: number, size: number, measure: Measure): string {
  if (measure(t, size) <= maxW) return t
  let s = t
  while (s.length > 1 && measure(s + '…', size) > maxW) s = s.slice(0, -1)
  return s + '…'
}

export function chartShapes(spec: ChartSpec, w: number, h: number, measure: Measure = roughMeasure): Shape[] {
  const out: Shape[] = []
  let top = 0
  if (spec.title) {
    out.push({ t: 'text', x: 0, y: 10, text: spec.title, size: 9, color: INK, anchor: 'start', bold: true })
    top = 16
  }
  const color = (i: number, c?: string) => c || PALETTE[i % PALETTE.length]
  if (spec.type === 'gauge') return [...out, ...gauge(spec, w, h - top, top, measure)]
  if (spec.type === 'pie') return [...out, ...pie(spec, w, h - top, top, measure, color)]
  // bar and line: a value axis on the left, categories along the bottom, a legend when there are several series
  const all = spec.series.flatMap((s) => s.values).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const maxV = niceMax(Math.max(0, ...all))
  const minV = Math.min(0, ...all)
  const lo = minV < 0 ? -niceMax(-minV) : 0
  const legendH = spec.series.length > 1 ? 14 : 0
  const labelW = Math.max(measure(fmt(spec, maxV), 7), measure(fmt(spec, lo), 7)) + 6
  const x0 = labelW
  const y0 = top + 4
  const ph = h - top - 4 - 16 - legendH
  const pw = w - x0 - 4
  const yOf = (v: number) => y0 + ph - ((v - lo) / (maxV - lo)) * ph
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((maxV - lo) * k) / 4
    const y = yOf(v)
    out.push({ t: 'line', x1: x0, y1: y, x2: x0 + pw, y2: y, color: k === 0 ? AXIS : GRID, lw: 0.5 })
    out.push({ t: 'text', x: x0 - 3, y: y + 2.5, text: fmt(spec, Math.round(v * 100) / 100), size: 7, color: '#64748b', anchor: 'end' })
  }
  const n = Math.max(1, spec.categories.length)
  const slot = pw / n
  const every = Math.max(1, Math.ceil((measure('XXXXXXXX', 7) + 4) / slot))
  spec.categories.forEach((c, i) => {
    if (i % every) return
    out.push({ t: 'text', x: x0 + slot * (i + 0.5), y: y0 + ph + 10, text: clipText(c, slot * every - 2, 7, measure), size: 7, color: '#475569', anchor: 'middle' })
  })
  if (spec.type === 'bar') {
    const ns = Math.max(1, spec.series.length)
    const bw = Math.min(28, (slot * 0.7) / ns)
    spec.series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return
        const x = x0 + slot * i + (slot - bw * ns) / 2 + bw * si
        const ya = yOf(Math.max(0, v))
        const yb = yOf(Math.min(0, v))
        out.push({ t: 'rect', x, y: ya, w: bw * 0.92, h: Math.max(0.3, yb - ya), fill: color(si, s.color) })
        if (ns === 1 && n <= 16) out.push({ t: 'text', x: x + bw * 0.46, y: ya - 2, text: fmt(spec, Math.round(v * 10) / 10), size: 6.5, color: INK, anchor: 'middle' })
      })
    })
  } else {
    spec.series.forEach((s, si) => {
      let d = ''
      s.values.forEach((v, i) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return
        const x = x0 + slot * (i + 0.5)
        d += `${d ? 'L' : 'M'}${x.toFixed(2)} ${yOf(v).toFixed(2)} `
      })
      if (d) out.push({ t: 'path', d: d.trim(), stroke: color(si, s.color), lw: 1.4 })
      s.values.forEach((v, i) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return
        const x = x0 + slot * (i + 0.5)
        out.push({ t: 'path', d: circle(x, yOf(v), 1.6), fill: color(si, s.color) })
      })
    })
  }
  if (legendH) {
    let x = x0
    const y = h - 4
    spec.series.forEach((s, si) => {
      out.push({ t: 'rect', x, y: y - 6, w: 7, h: 7, fill: color(si, s.color) })
      out.push({ t: 'text', x: x + 10, y, text: s.name, size: 7, color: INK, anchor: 'start' })
      x += 18 + measure(s.name, 7)
    })
  }
  return out
}

const circle = (cx: number, cy: number, r: number) => `M${(cx - r).toFixed(2)} ${cy.toFixed(2)} A${r} ${r} 0 1 0 ${(cx + r).toFixed(2)} ${cy.toFixed(2)} A${r} ${r} 0 1 0 ${(cx - r).toFixed(2)} ${cy.toFixed(2)} Z`

function arc(cx: number, cy: number, r: number, a0: number, a1: number, inner = 0): string {
  // angles in radians, 0 = 12 o'clock, clockwise
  const p = (a: number, rr: number) => [cx + rr * Math.sin(a), cy - rr * Math.cos(a)].map((v) => v.toFixed(2)).join(' ')
  const large = a1 - a0 > Math.PI ? 1 : 0
  if (inner > 0) return `M${p(a0, r)} A${r} ${r} 0 ${large} 1 ${p(a1, r)} L${p(a1, inner)} A${inner} ${inner} 0 ${large} 0 ${p(a0, inner)} Z`
  return `M${cx.toFixed(2)} ${cy.toFixed(2)} L${p(a0, r)} A${r} ${r} 0 ${large} 1 ${p(a1, r)} Z`
}

function pie(spec: ChartSpec, w: number, h: number, top: number, measure: Measure, color: (i: number, c?: string) => string): Shape[] {
  const out: Shape[] = []
  const vals = (spec.series[0]?.values ?? []).map((v) => (typeof v === 'number' && v > 0 ? v : 0))
  const total = vals.reduce((a, b) => a + b, 0)
  const r = Math.max(10, Math.min(h / 2 - 4, w * 0.25))
  const cx = r + 4
  const cy = top + h / 2
  if (!total) {
    out.push({ t: 'path', d: circle(cx, cy, r), stroke: AXIS, lw: 0.5 })
    out.push({ t: 'text', x: cx, y: cy + 3, text: 'No data', size: 8, color: '#64748b', anchor: 'middle' })
    return out
  }
  let a = 0
  vals.forEach((v, i) => {
    if (!v) return
    const b = a + (v / total) * Math.PI * 2
    out.push(b - a >= Math.PI * 2 - 1e-6 ? { t: 'path', d: circle(cx, cy, r), fill: color(i) } : { t: 'path', d: arc(cx, cy, r, a, b, r * 0.5), fill: color(i) })
    a = b
  })
  // legend with shares
  let y = cy - (Math.min(vals.length, 12) * 12) / 2 + 8
  const lx = cx + r + 14
  spec.categories.slice(0, 12).forEach((c, i) => {
    out.push({ t: 'rect', x: lx, y: y - 6, w: 7, h: 7, fill: color(i) })
    out.push({ t: 'text', x: lx + 10, y, text: clipText(`${c}: ${fmt(spec, vals[i])} (${Math.round((vals[i] / total) * 100)}%)`, w - lx - 12, 7, measure), size: 7, color: INK, anchor: 'start' })
    y += 12
  })
  return out
}

function gauge(spec: ChartSpec, w: number, h: number, top: number, measure: Measure): Shape[] {
  const out: Shape[] = []
  const min = spec.min ?? 0
  const max = spec.max ?? 100
  const v = typeof spec.value === 'number' && Number.isFinite(spec.value) ? spec.value : null
  const r = Math.max(12, Math.min(w / 2 - 4, h - 22))
  const cx = w / 2
  const cy = top + r + 4
  const inner = r * 0.68
  const start = -Math.PI / 2
  const span = Math.PI
  const bands = spec.bands?.length ? spec.bands : [0.6, 0.85]
  const colors = ['#fecaca', '#fde68a', '#bbf7d0']
  let prev = 0
  ;[...bands, 1].forEach((b, i) => {
    const f = Math.max(prev, Math.min(1, b))
    if (f > prev) out.push({ t: 'path', d: arc(cx, cy, r, start + span * prev, start + span * f, r * 0.88), fill: colors[Math.min(i, colors.length - 1)] })
    prev = f
  })
  if (v !== null) {
    const f = Math.max(0, Math.min(1, (v - min) / (max - min || 1)))
    const col = f < bands[0] ? '#dc2626' : f < (bands[1] ?? 1) ? '#d97706' : '#16a34a'
    out.push({ t: 'path', d: arc(cx, cy, r * 0.84, start, start + span, inner), fill: '#f1f5f9' })
    if (f > 0) out.push({ t: 'path', d: arc(cx, cy, r * 0.84, start, start + span * f, inner), fill: col })
    const a = start + span * f
    out.push({ t: 'line', x1: cx, y1: cy, x2: cx + (r - 2) * Math.sin(a), y2: cy - (r - 2) * Math.cos(a), color: INK, lw: 1.5 })
  }
  out.push({ t: 'path', d: circle(cx, cy, 2.5), fill: INK })
  const label = v === null ? '–' : fmt(spec, Math.round(v * 10) / 10)
  out.push({ t: 'text', x: cx, y: cy + 16, text: label, size: Math.min(16, Math.max(9, r / 3)), color: INK, anchor: 'middle', bold: true })
  out.push({ t: 'text', x: cx - r, y: cy + 10, text: fmt(spec, min), size: 6.5, color: '#64748b', anchor: 'start' })
  out.push({ t: 'text', x: cx + r, y: cy + 10, text: fmt(spec, max), size: 6.5, color: '#64748b', anchor: 'end' })
  void measure
  return out
}

const escXml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** the chart as an SVG document (w x h points) */
export function printChartSvg(spec: ChartSpec, w = 400, h = 220, measure?: Measure): string {
  const parts = chartShapes(spec, w, h, measure).map((s) => {
    switch (s.t) {
      case 'rect': return `<rect x="${s.x.toFixed(2)}" y="${s.y.toFixed(2)}" width="${s.w.toFixed(2)}" height="${s.h.toFixed(2)}" fill="${s.fill ?? 'none'}"${s.stroke ? ` stroke="${s.stroke}" stroke-width="${s.lw ?? 1}"` : ''}/>`
      case 'line': return `<line x1="${s.x1.toFixed(2)}" y1="${s.y1.toFixed(2)}" x2="${s.x2.toFixed(2)}" y2="${s.y2.toFixed(2)}" stroke="${s.color}" stroke-width="${s.lw}"${s.dash ? ` stroke-dasharray="${s.dash.join(' ')}"` : ''}/>`
      case 'path': return `<path d="${s.d}" fill="${s.fill ?? 'none'}"${s.stroke ? ` stroke="${s.stroke}" stroke-width="${s.lw ?? 1}"` : ''}/>`
      case 'text': return `<text x="${s.x.toFixed(2)}" y="${s.y.toFixed(2)}" font-size="${s.size}" fill="${s.color}" text-anchor="${s.anchor}" font-family="Noto Sans, sans-serif"${s.bold ? ' font-weight="700"' : ''}>${escXml(s.text)}</text>`
    }
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${parts.join('')}</svg>`
}
