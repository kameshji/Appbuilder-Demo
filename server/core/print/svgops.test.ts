/**
 * Charts in PDFs (no database): the SVG subset converter (svgops.ts), every chart kind of renderChartSvg drawn as
 * operations inside its box, Devanagari labels shaped with the bundled fonts, determinism, the mapping of stored chart
 * blocks (chart.ts) including the built-ins' legacy shape, and golden text positions of one chart
 * (testdata/golden-chart.json, tolerance 0.5 pt; UPDATE_GOLDEN=1 rewrites it).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { CHART_KINDS, type ChartKind } from '../../../src/charts/geometry.ts'
import { renderChartSvg } from '../../../src/charts/svg.ts'
import { chartFromBlock, statusBands, type ChartBlockInput, type ChartInputs } from './chart.ts'
import { chartOps, layoutDocument, type Op, type RBlock } from './layout.ts'
import { parseColor, scalePath, svgToOps, SvgSubsetError, type TextLine } from './svgops.ts'
import { segments, textWidth } from './text.ts'
import { pdfBuffer } from './pdf.ts'

const base: Omit<ChartInputs, 'rows' | 'single'> = { asText: (v) => (v instanceof Date ? v.toISOString() : String(v ?? '')), now: new Date('2026-11-19T10:00:00Z'), grouping: 'indian', currency: 'INR', timeZone: 'Asia/Kolkata' }
const plain: TextLine = (text, x, y, st, color) => segments(text, st).map((s) => ({ t: 'text' as const, x, y, text: s.text, face: s.face, size: st.size, color }))
const conv = (svg: string, width: number) => svgToOps(svg, { width, text: plain }).ops

const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** a block and its evaluated values for every kind */
function sample(kind: ChartKind): { b: ChartBlockInput; i: ChartInputs } {
  const v = (name: string, extra: Partial<ChartBlockInput['values'][number]> = {}) => ({ name, value: name, ...extra })
  switch (kind) {
    case 'gauge': case 'bullet': return { b: { chartType: kind, values: [v('OEE'), v('Target')], min: 0, max: 100, unit: '%', bands: [0.6, 0.85] }, i: { ...base, title: 'Plant OEE', rows: [], single: [78.5, 85] } }
    case 'kpi': return { b: { chartType: kind, values: [v('Output'), v('last week')], higherIsBetter: true }, i: { ...base, title: 'Output', rows: [], single: [1234567, 1100000] } }
    case 'scatter': return { b: { chartType: kind, values: [v('Speed'), v('Scrap'), v('Count')] }, i: { ...base, rows: days.map((d, k) => ({ label: k % 2 ? 'A' : 'B', values: [k * 3 + 1, (k * 7) % 5, k + 1] })), single: [] } }
    case 'heatmap': return { b: { chartType: kind, values: [v('Shift'), v('Scrap')] }, i: { ...base, rows: days.flatMap((d) => ['S1', 'S2', 'S3'].map((s, k) => ({ label: d, values: [s, (d.length * (k + 2)) % 7] }))), single: [] } }
    case 'timeline': return { b: { chartType: kind, values: [v('Start'), v('End'), v('Status')] }, i: { ...base, rows: [
      { label: 'CNC-01', values: ['2026-11-19T06:00:00Z', '2026-11-19T08:00:00Z', 'Running'] },
      { label: 'CNC-01', values: ['2026-11-19T08:00:00Z', '2026-11-19T08:30:00Z', 'Down'] },
      { label: 'CNC-02', values: [new Date('2026-11-19T06:30:00Z'), null, 'Idle'] },
    ], single: [] } }
    case 'combo': return { b: { chartType: kind, values: [v('Output'), v('Rate', { axis: 'right' })] }, i: { ...base, title: 'Output and rate', rows: days.map((d, k) => ({ label: d, values: [100 + k * 20, 0.5 + k / 20] })), single: [] } }
    default: return { b: { chartType: kind, values: [v('Good'), v('Scrap', { color: '#dc2626' })], unit: kind === 'pareto' ? '' : ' pcs' }, i: { ...base, title: `${kind} chart`, rows: days.map((d, k) => ({ label: d, values: [120 - k * 15, 3 + k] })), single: [] } }
  }
}

function bounds(ops: Op[], w: number, h: number): string[] {
  const bad: string[] = []
  const tol = 1
  const inBox = (x: number, y: number, what: string) => { if (x < -tol || y < -tol || x > w + tol || y > h + tol) bad.push(`${what} at ${x.toFixed(1)},${y.toFixed(1)}`) }
  for (const o of ops) {
    if (o.t === 'text') {
      const tw = textWidth(o.text, { size: o.size, bold: o.face.includes('bold') })
      if (o.rotate) { inBox(o.x, o.y, `"${o.text}"`); continue }
      inBox(o.x, o.y - o.size * 0.75, `"${o.text}" top`)
      inBox(o.x + tw, o.y, `"${o.text}" end`)
    } else if (o.t === 'rect') { inBox(o.x, o.y, 'rect'); inBox(o.x + o.w, o.y + o.h, 'rect end') }
    else if (o.t === 'line') { inBox(o.x1, o.y1, 'line'); inBox(o.x2, o.y2, 'line end') }
    else if (o.t === 'path') {
      // every coordinate pair of absolute M/L commands (arcs: their end points)
      const nums = o.d.match(/[MLA][^MLAHVZ]*/g) ?? []
      for (const seg of nums) {
        const n = seg.slice(1).trim().split(/[\s,]+/).map(Number)
        const pairs = seg[0] === 'A' ? [[n[5], n[6]]] : n.reduce<number[][]>((a, x, k) => (k % 2 ? (a[a.length - 1].push(x), a) : [...a, [x]]), [])
        for (const [x, y] of pairs) inBox(o.x + x, o.y + y, 'path point')
      }
    }
  }
  return bad
}

describe('charts in PDFs: renderChartSvg -> operations', () => {
  it.each(CHART_KINDS)('%s: renders inside its box with only known SVG', (kind) => {
    const { b, i } = sample(kind)
    const chart = chartFromBlock(b, i)
    const w = 480, h = 170
    const ops = chartOps(chart, w, h)
    expect(ops[0]).toEqual({ t: 'clip', x: 0, y: 0, w, h })
    expect(ops[ops.length - 1]).toEqual({ t: 'unclip' })
    const body = ops.slice(1, -1)
    expect(body.length).toBeGreaterThan(kind === 'kpi' ? 2 : 5)
    expect(body.some((o) => o.t === 'text')).toBe(true)
    if (kind !== 'kpi') expect(body.some((o) => o.t !== 'text')).toBe(true)
    expect(bounds(body, w, h)).toEqual([])
    expect(JSON.stringify(ops)).not.toMatch(/NaN|Infinity|null/)
  })

  it('every kind: each shape and each text of the SVG becomes operations (nothing dropped)', () => {
    for (const kind of CHART_KINDS) {
      const { b, i } = sample(kind)
      const c = chartFromBlock(b, i)
      const svg = renderChartSvg({ ...c.spec, width: 640, height: 226 }, c.rows, { background: false })
      const shapes = (svg.match(/<(rect|path|circle|line)\b/g) ?? []).length - (svg.match(/<(rect|circle)\b[^>]*\s(width|height|r)="0"/g) ?? []).length
      const texts = svg.match(/<text\b[^>]*>[^<]*\S[^<]*<\/text>/g) ?? []
      // the KPI arrows are drawn as shapes (no bundled font has ▲ ▼ ■); the text after them is one more call
      const symbols = texts.join('').match(/[▲▼■]/g)?.length ?? 0
      let calls = 0
      const ops = svgToOps(svg, { width: 480, text: (...a) => { calls++; return plain(...a) } }).ops
      expect(ops.filter((o) => o.t !== 'text').length, kind).toBe(shapes + symbols)
      expect(calls, kind).toBe(texts.length)
      expect(ops.filter((o) => o.t === 'text').some((o) => /[▲▼■]/.test((o as Extract<Op, { t: 'text' }>).text)), kind).toBe(false)
      if (kind === 'kpi') expect(symbols).toBe(1)
    }
  })

  it('fails loudly on SVG outside the subset', () => {
    const bad = [
      '<svg viewBox="0 0 10 10"><ellipse cx="1" cy="1" rx="1" ry="1"/></svg>',
      '<svg viewBox="0 0 10 10"><polygon points="0,0 1,1 1,0"/></svg>',
      '<svg viewBox="0 0 10 10"><rect x="0" y="0" width="1" height="1" fill="url(#g)"/></svg>',
      '<svg viewBox="0 0 10 10"><rect x="0" y="0" width="1" height="1" fill="red"/></svg>',
      '<svg viewBox="0 0 10 10"><rect x="0" y="0" width="1" height="1" filter="x"/></svg>',
      '<svg viewBox="0 0 10 10"><g transform="skewX(10)"><rect width="1" height="1"/></g></svg>',
      '<svg viewBox="0 0 10 10"><g transform="scale(1 2)"><rect width="1" height="1"/></g></svg>',
      '<svg viewBox="0 0 10 10"><text x="0" y="0">a &nbsp; b</text></svg>',
      '<svg viewBox="0 0 10 10"><text x="0" y="0">a & b</text></svg>',
      '<svg viewBox="0 0 10 10"><text x="0" y="0"><tspan>a</tspan></text></svg>',
      '<svg viewBox="0 0 10 10"><path d="M0 0 X 1 1"/></svg>',
      '<svg viewBox="0 0 10 10"><!-- c --></svg>',
      '<svg viewBox="0 0 10 10"><rect width="1" height="1">',
      '<g/>',
    ]
    for (const s of bad) expect(() => conv(s, 100), s).toThrow(SvgSubsetError)
  })

  it('places text by anchor and baseline with the bundled fonts, scales and rotates', () => {
    const [t] = conv('<svg viewBox="0 0 100 50"><text x="50" y="20" font-size="10" text-anchor="middle" fill="#334155">Hi</text></svg>', 200) as Extract<Op, { t: 'text' }>[]
    expect(t.size).toBe(20)
    expect(t.x).toBeCloseTo(100 - textWidth('Hi', { size: 20 }) / 2, 2)
    expect(t.y).toBeCloseTo(40, 2)
    expect(t.color).toBe('#334155')
    const [e] = conv('<svg viewBox="0 0 100 50"><g transform="translate(10 5)"><text x="50" y="20" font-size="10" text-anchor="end" dominant-baseline="central" font-weight="600">Hi</text></g></svg>', 100) as Extract<Op, { t: 'text' }>[]
    expect(e.face).toBe('sans-bold')
    expect(e.x).toBeCloseTo(60 - textWidth('Hi', { size: 10, bold: true }), 2)
    expect(e.y).toBeGreaterThan(25 + 3)
    expect(e.y).toBeLessThan(25 + 4.5)
    const [r] = conv('<svg viewBox="0 0 100 50"><text x="20" y="30" font-size="10" transform="rotate(-45 20 30)">Long label</text></svg>', 100) as Extract<Op, { t: 'text' }>[]
    expect(r.rotate).toBe(-45)
    expect([r.x, r.y]).toEqual([20, 30])
  })

  it('converts shapes: rounded rects, circles, dashes, caps, opacity, rgba', () => {
    const ops = conv('<svg viewBox="0 0 100 100"><g transform="translate(0 10)">'
      + '<rect x="1" y="2" width="10" height="20" rx="3" fill="#4f46e5" opacity="0.35"/>'
      + '<circle cx="50" cy="50" r="4" fill="rgba(255,0,0,0.5)" stroke="#ffffff" stroke-width="1"/>'
      + '<line x1="0" y1="0" x2="100" y2="0" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="4 3"/>'
      + '<path d="M0,0L10,10A5,5 0 1 1 20,20Z" stroke="#0891b2" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
      + '<circle cx="1" cy="1" r="0" fill="#000"/></g></svg>', 200)
    expect(ops).toEqual([
      { t: 'rect', x: 2, y: 24, w: 20, h: 40, r: 6, fill: '#4f46e5', fillOpacity: 0.35 },
      { t: 'path', d: 'M-8 0A8 8 0 1 0 8 0A8 8 0 1 0 -8 0Z', x: 100, y: 120, fill: '#ff0000', stroke: '#ffffff', lw: 2, fillOpacity: 0.5 },
      { t: 'line', x1: 0, y1: 20, x2: 200, y2: 20, color: '#e2e8f0', lw: 2, dash: [8, 6] },
      { t: 'path', d: 'M0 0L20 20A10 10 0 1 1 40 40Z', x: 0, y: 20, stroke: '#0891b2', lw: 4, dash: [10, 8], cap: 'round' },
    ])
    expect(scalePath('M1,2 3,4h5v-6a1 2 30 0110 20z', 2)).toBe('M2 4 6 8h10v-12a2 4 30 0 1 20 40z')
    expect(parseColor('#abc')).toEqual({ hex: '#aabbcc', alpha: 1 })
    expect(parseColor('none')).toBeNull()
  })

  it('shapes Devanagari labels with Noto Sans Devanagari and gives them ActualText', () => {
    const chart = chartFromBlock({ chartType: 'bar', values: [{ name: 'उत्पादन', value: 'x' }] }, { ...base, title: 'दैनिक निरीक्षण', rows: [{ label: 'कर्म', values: [3] }, { label: 'पूर्ण', values: [5] }, { label: 'क्षमता', values: [4] }], single: [] })
    const texts = chartOps(chart, 400, 160).filter((o): o is Extract<Op, { t: 'text' }> => o.t === 'text')
    const deva = texts.filter((o) => o.face === 'deva' || o.face === 'deva-bold')
    expect(deva.map((o) => o.text)).toEqual(expect.arrayContaining(['दैनिक', 'निरीक्षण', 'कर्म', 'पूर्ण', 'क्षमता']))
    expect(deva.find((o) => o.text === 'निरीक्षण')!.face).toBe('deva-bold')
    // one ActualText span per line with the logical text (copy, search)
    expect(texts.filter((o) => o.actual !== undefined).map((o) => o.actual)).toEqual(expect.arrayContaining(['दैनिक निरीक्षण', 'कर्म', 'पूर्ण', 'क्षमता']))
    expect(texts.filter((o) => o.actual !== undefined).length).toBe(texts.filter((o) => o.endActual).length)
    // centred under the bar with the shaped width
    const k = deva.find((o) => o.text === 'कर्म')!
    expect(textWidth('कर्म', { size: k.size })).toBeGreaterThan(5)
  })

  it('is deterministic: the same chart gives the same operations and the same PDF bytes', async () => {
    const mk = () => chartOps(chartFromBlock(sample('combo').b, sample('combo').i), 480, 170)
    expect(mk()).toEqual(mk())
    const body: RBlock[] = CHART_KINDS.map((k) => ({ k: 'chart', chart: chartFromBlock(sample(k).b, sample(k).i), height: 45 }))
    const pdf = async () => pdfBuffer({ pageW: 595.28, pageH: 841.89, pages: layoutDocument({ pageW: 595.28, pageH: 841.89, margins: { top: 40, right: 40, bottom: 40, left: 40 }, style: { fontSize: 10, color: '#1e293b', accent: '#4f46e5', headingColor: '#0f172a', tableStyle: 'zebra', lineHeight: 1.3 }, body, header: () => [], footer: () => [], images: new Map(), maxPages: 20 }), images: new Map(), meta: { createdOn: new Date('2026-11-19T00:00:00Z') } })
    const a = await pdf()
    expect(a.equals(await pdf())).toBe(true)
    expect(a.toString('latin1')).not.toMatch(/\/Subtype \/Image/)
  })

  it('golden: text and positions of a bar chart (tolerance 0.5 pt)', () => {
    const ops = chartOps(chartFromBlock(sample('bar').b, sample('bar').i), 480, 170)
    const got = ops.filter((o): o is Extract<Op, { t: 'text' }> => o.t === 'text').map((t) => [t.text, t.face, +t.x.toFixed(2), +t.y.toFixed(2), t.size] as [string, string, number, number, number])
    const file = new URL('./testdata/golden-chart.json', import.meta.url)
    if (process.env.UPDATE_GOLDEN === '1' || !fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(got, null, 0).replace(/\],\[/g, '],\n['))
    const want = JSON.parse(fs.readFileSync(file, 'utf8')) as [string, string, number, number, number][]
    expect(got.map((g) => [g[0], g[1], g[4]])).toEqual(want.map((g) => [g[0], g[1], g[4]]))
    got.forEach((g, i) => {
      expect(Math.abs(g[2] - want[i][2])).toBeLessThanOrEqual(0.5)
      expect(Math.abs(g[3] - want[i][3])).toBeLessThanOrEqual(0.5)
    })
  })
})

describe('chart blocks -> ChartSpec (backward compatible)', () => {
  it('maps the built-ins\' bar and gauge blocks', () => {
    const bar = chartFromBlock({ chartType: 'bar', values: [{ name: 'OEE', value: 'x' }], unit: '%' }, { ...base, title: 'OEE by machine', rows: [{ label: 'CNC-01 A', values: [78.5] }, { label: 'CNC-02 A', values: ['64.2'] }], single: [] })
    expect(bar.spec).toMatchObject({ kind: 'bar', title: 'OEE by machine', category: 'c', series: [{ key: 's0', label: 'OEE' }], format: { suffix: '%' }, defaults: { locale: 'en-IN' } })
    expect(bar.rows).toEqual([{ c: 'CNC-01 A', s0: 78.5 }, { c: 'CNC-02 A', s0: 64.2 }])
    const g = chartFromBlock({ chartType: 'gauge', values: [{ name: 'OEE', value: 'x' }], min: 0, max: 100, unit: '%', bands: [0.6, 0.85] }, { ...base, rows: [], single: [71.3] })
    expect(g.spec).toMatchObject({ kind: 'gauge', min: 0, max: 100, series: [{ key: 'v', label: 'OEE' }] })
    expect(g.spec.bands).toEqual([{ from: 0, to: 60, status: 'bad' }, { from: 60, to: 85, status: 'warn' }, { from: 85, to: 100, status: 'good' }])
    expect(g.rows).toEqual([{ v: 71.3 }])
  })
  it('defaults: an unknown type draws as bar, colours must be #hex, international grouping, open periods end now', () => {
    const c = chartFromBlock({ chartType: 'sunburst', values: [{ name: 'A', value: 'x', color: 'javascript:1' }, { name: 'B', value: 'y', color: '#0a0' }] }, { ...base, grouping: 'international', rows: [{ label: 'x', values: [1, 2] }], single: [] })
    expect(c.spec.kind).toBe('bar')
    expect(c.spec.series).toEqual([{ key: 's0', label: 'A' }, { key: 's1', label: 'B', color: '#0a0' }])
    expect(c.spec.defaults?.locale).toBe('en-US')
    const t = chartFromBlock(sample('timeline').b, sample('timeline').i)
    expect(t.rows[2].s1).toEqual(base.now)
    expect(statusBands([], 0, 10)).toHaveLength(3)
  })
  it('limits rows per kind', () => {
    const rows = Array.from({ length: 1500 }, (_, k) => ({ label: `r${k}`, values: [k, k] }))
    expect(chartFromBlock({ chartType: 'bar', values: [{ name: 'v', value: 'v' }] }, { ...base, rows, single: [] }).rows).toHaveLength(200)
    expect(chartFromBlock({ chartType: 'scatter', values: [{ name: 'x', value: 'x' }, { name: 'y', value: 'y' }] }, { ...base, rows, single: [] }).rows).toHaveLength(1000)
  })
})
