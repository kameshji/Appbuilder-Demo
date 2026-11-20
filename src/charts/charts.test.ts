/**
 * Chart core (P2-C): formatting (Indian grouping, lakh/crore, fiscal labels), scales, geometry of every chart kind,
 * and renderChartSvg (well-formed, escaped, no script). Pure: runs in Node.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { formatDate, formatNumber, formatTick } from './format.ts'
import { band, linear, niceStep, fitText } from './scales.ts'
import { CHART_KINDS, chartScene, kpiState } from './geometry.ts'
import type { ChartSpec, Mark } from './geometry.ts'
import { renderChartSvg } from './svg.ts'
import { cssVariables, resolveCss, resolveHex } from './palette.ts'

const months = ['2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01']
const rows = months.map((m, i) => ({ Month: m, Good: [120, 160, null, 210][i], Scrap: [10, 6, 8, 4][i], Line: ['A', 'B', 'C', 'D'][i] }))

describe('format', () => {
  it('Indian grouping, currency, compact lakh and crore', () => {
    expect(formatNumber(1234567.891, {}, { locale: 'en-IN', currency: 'INR', timeZone: 'UTC' })).toBe('12,34,567.89')
    expect(formatNumber(1234567, { style: 'currency' })).toBe('₹12,34,567')
    expect(formatNumber(1234567, { compact: true })).toBe('12.3L')
    expect(formatNumber(23_400_000, { compact: true })).toBe('2.3Cr')
    expect(formatNumber(1234567, { locale: 'en-US' })).toBe('1,234,567')
    expect(formatNumber(0.853, { style: 'percent' })).toBe('85.3%')
    expect(formatNumber(85.3, { style: 'percent', fraction: false })).toBe('85.3%')
    expect(formatNumber(null)).toBe('')
    expect(formatNumber('x')).toBe('')
    expect(formatNumber(-0)).toBe('0')
    expect(formatTick(250000)).toBe('2.5L')
  })
  it('dates and fiscal labels', () => {
    expect(formatDate('2026-03-15', 'fiscalYear')).toBe('FY2025-26')
    expect(formatDate('2026-04-01', 'fiscalYear')).toBe('FY2026-27')
    expect(formatDate('2026-04-01', 'fiscalQuarter')).toBe('Q1 FY2026-27')
    expect(formatDate('2027-01-01', 'fiscalQuarter')).toBe('Q4 FY2026-27')
    expect(formatDate('2026-07-01', 'fiscalYear', { fiscalYearStart: 1 })).toBe('FY2026')
    expect(formatDate('2026-11-01', 'quarter')).toBe('Q4 2026')
    expect(formatDate(new Date(2026, 10, 1), 'month')).toBe('Nov 2026')
  })
})

describe('scales', () => {
  it('nice ticks include zero and cover the data', () => {
    expect(niceStep(97, 5)).toBe(20)
    const s = linear([3, 97], [100, 0])
    expect(s.ticks[0]).toBe(0)
    expect(s.ticks[s.ticks.length - 1]).toBeGreaterThanOrEqual(97)
    expect(s(0)).toBe(100)
    const neg = linear([-12, 5], [0, 100])
    expect(neg.domain[0]).toBeLessThanOrEqual(-12)
    const flat = linear([0, 0], [0, 10])
    expect(flat.domain).toEqual([0, 1])
    const b = band(4, [0, 100], 0.2, 0.1)
    expect(b(3) + b.bandwidth).toBeLessThanOrEqual(100)
    expect(fitText('A very long machine name', 11, 60).endsWith('…')).toBe(true)
  })
})

const inBox = (marks: Mark[], w: number, h: number) => marks.every((m) => {
  const xs = m.t === 'rect' ? [m.x, m.x + m.w] : m.t === 'circle' ? [m.cx] : m.t === 'line' ? [m.x1, m.x2] : m.t === 'text' ? [m.x] : []
  const ys = m.t === 'rect' ? [m.y, m.y + m.h] : m.t === 'circle' ? [m.cy] : m.t === 'line' ? [m.y1, m.y2] : m.t === 'text' ? [m.y] : []
  return [...xs, ...ys].every((v) => Number.isFinite(v)) && xs.every((v) => v >= -1 && v <= w + 1) && ys.every((v) => v >= -1 && v <= h + 1)
})

describe('geometry', () => {
  const base: Omit<ChartSpec, 'kind'> = { width: 400, height: 240, category: 'Month', categoryType: 'date', categoryGrain: 'month', series: [{ key: 'Good', label: 'Good qty' }, { key: 'Scrap' }] }
  it('grouped, stacked, 100% and horizontal bars stay in the box; blanks make no bar', () => {
    for (const extra of [{}, { stack: 'stacked' }, { stack: 'percent' }, { orientation: 'horizontal' }] as Partial<ChartSpec>[]) {
      const sc = chartScene({ ...base, kind: 'bar', ...extra } as ChartSpec, rows)
      expect(inBox(sc.marks, 400, 240)).toBe(true)
      expect(sc.marks.filter((m) => m.t === 'rect' && m.datum).length).toBe(7)
      expect(sc.table.rows[2]).toEqual(['Jun 2026', '(blank)', '8'])
    }
    const pct = chartScene({ ...base, kind: 'bar', stack: 'percent' } as ChartSpec, rows)
    expect(pct.points[0]!.text).toContain('%')
  })
  it('lines break at blanks (gap), connect or read zero', () => {
    const gap = chartScene({ ...base, kind: 'line', series: [{ key: 'Good' }] } as ChartSpec, rows)
    expect(gap.marks.filter((m) => m.t === 'path').length).toBe(2)
    const conn = chartScene({ ...base, kind: 'line', missing: 'connect', series: [{ key: 'Good' }] } as ChartSpec, rows)
    expect(conn.marks.filter((m) => m.t === 'path').length).toBe(1)
    const zero = chartScene({ ...base, kind: 'line', missing: 'zero', series: [{ key: 'Good' }] } as ChartSpec, rows)
    expect(zero.points.length).toBe(4)
    const step = chartScene({ ...base, kind: 'line', curve: 'step', series: [{ key: 'Scrap' }] } as ChartSpec, rows)
    expect((step.marks.find((m) => m.t === 'path') as { d: string }).d).toMatch(/H.*V/)
  })
  it('legend toggles hide a series; selection dims other categories', () => {
    const sc = chartScene({ ...base, kind: 'bar', hidden: ['Scrap'], selected: 'May 2026' } as ChartSpec, rows)
    expect(sc.legend.find((l) => l.key === 'Scrap')?.hidden).toBe(true)
    const bars = sc.marks.filter((m): m is Extract<Mark, { t: 'rect' }> => m.t === 'rect' && !!m.datum)
    expect(bars.every((b) => b.datum!.series === 'Good')).toBe(true)
    expect(bars.find((b) => b.datum!.label === 'May 2026')!.opacity).toBe(1)
    expect(bars.find((b) => b.datum!.label === 'Apr 2026')!.opacity).toBe(0.35)
  })
  it('pareto adds the cumulative line on a 0-100 % right axis', () => {
    const sc = chartScene({ width: 400, height: 240, kind: 'pareto', category: 'Line', series: [{ key: 'Scrap' }] }, rows)
    const cum = sc.points.length
    expect(cum).toBe(4)
    expect(sc.legend.map((l) => l.key)).toContain('__cum')
    expect(sc.marks.some((m) => m.t === 'text' && m.text === '80%')).toBe(true)
  })
  it('every kind renders something in its box, or an empty state without rows', () => {
    const specFor = (kind: ChartSpec['kind']): ChartSpec => ({
      width: 360, height: 220, kind, category: 'Line', series: [{ key: 'Good' }, { key: 'Scrap' }], x: 'Good', y: 'Scrap', row: 'Line', column: 'Month',
      lane: 'Line', start: 'S', end: 'E', status: 'St', bands: [{ from: 0, to: 0.6, status: 'bad' }, { from: 0.6, to: 0.85, status: 'warn' }, { from: 0.85, to: 1, status: 'good' }],
      format: kind === 'gauge' ? { style: 'percent' } : undefined, kpi: kind === 'kpi' ? { value: 0.72, base: 0.68, label: 'OEE', higherIsBetter: true, spark: [0.6, 0.7, 0.72] } : undefined,
      target: kind === 'gauge' || kind === 'bullet' ? 0.85 : undefined,
    })
    const data = rows.map((r, i) => ({ ...r, Good: kindRowsValue(i), S: new Date(Date.UTC(2026, 10, 19, 6 + i)), E: new Date(Date.UTC(2026, 10, 19, 7 + i)), St: i % 2 ? 'Down' : 'Running' }))
    for (const kind of CHART_KINDS) {
      const sc = chartScene(specFor(kind), kind === 'gauge' ? [{ Good: 0.72 }] : data)
      expect(sc.marks.length, kind).toBeGreaterThan(0)
      expect(inBox(sc.marks, 360, 220), kind).toBe(true)
      expect(sc.summary.length, kind).toBeGreaterThan(5)
      expect(sc.table.rows.length, kind).toBeGreaterThan(0)
      if (kind !== 'kpi' && kind !== 'gauge') expect(chartScene(specFor(kind), []).empty, kind).toBeTruthy()
    }
  })
  it('KPI delta and status rules', () => {
    expect(kpiState({ value: 110, base: 100, higherIsBetter: true }, undefined)).toMatchObject({ direction: 'up', status: 'good', deltaText: '+10%' })
    expect(kpiState({ value: 90, base: 100, higherIsBetter: true }, undefined)).toMatchObject({ direction: 'down', status: 'bad' })
    expect(kpiState({ value: 5, base: 0 }, undefined).delta).toBe(null)
    expect(kpiState({ value: 0.5, rules: [{ op: 'lt', value: 0.6, status: 'bad' }, { op: 'ge', value: 0.6, status: 'good' }] }, undefined).status).toBe('bad')
    expect(kpiState({ value: 7, base: 5, deltaStyle: 'absolute' }, undefined).deltaText).toBe('+2')
    // a change that would show as 0.0 % is flat, without a good / bad colour
    expect(kpiState({ value: 1000.2, base: 1000, higherIsBetter: false }, undefined)).toMatchObject({ direction: 'flat', status: undefined, deltaText: '0%' })
  })
  it('gauge status follows the bands', () => {
    const sc = chartScene({ kind: 'gauge', width: 300, height: 180, series: [{ key: 'OEE' }], format: { style: 'percent' }, bands: [{ from: 0, to: 0.6, status: 'bad' }, { from: 0.6, to: 0.85, status: 'warn' }, { from: 0.85, to: 1, status: 'good' }] }, [{ OEE: 0.9 }])
    expect(sc.summary).toContain('on target')
    expect(sc.marks.some((m) => m.t === 'text' && m.text === '90%')).toBe(true)
  })
})

function kindRowsValue(i: number): number { return [120, 160, 90, 210][i]! }

describe('renderChartSvg', () => {
  it('is a standalone, escaped SVG without scripts in both themes', () => {
    for (const kind of ['bar', 'line', 'area', 'pie', 'donut', 'gauge', 'kpi'] as const) {
      for (const theme of ['light', 'dark'] as const) {
        const svg = renderChartSvg({ kind, width: 320, height: 200, title: 'Scrap <by> "line" & shift', category: 'Line', series: [{ key: 'Good' }, { key: 'Scrap' }], stack: kind === 'bar' ? 'stacked' : undefined, kpi: kind === 'kpi' ? { value: 12, base: 10, label: 'Good <qty>' } : undefined }, kind === 'gauge' ? [{ Good: 72 }] : rows, { theme })
        expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
        expect(svg.endsWith('</svg>')).toBe(true)
        expect(svg).not.toMatch(/<script|foreignObject|href=|var\(--/)
        expect(svg).not.toContain('<by>')
        expect(svg).toContain(theme === 'dark' ? '#1e2433' : '#ffffff')
        // balanced tags
        const open = (svg.match(/<(svg|g|text|title|desc)\b/g) ?? []).length
        const close = (svg.match(/<\/(svg|g|text|title|desc)>/g) ?? []).length
        expect(open).toBe(close)
      }
    }
  })
  it('is importable without React or the DOM (no imports outside src/charts)', () => {
    for (const f of ['format.ts', 'scales.ts', 'palette.ts', 'geometry.ts', 'svg.ts', 'index.ts']) {
      const src = fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')
      for (const m of src.matchAll(/from '([^']+)'/g)) expect(m[1]!.startsWith('./') && m[1]!.endsWith('.ts'), `${f}: ${m[1]}`).toBe(true)
      expect(src).not.toMatch(/\bdocument\.|\bwindow\./)
    }
  })
  it('palette: screen tokens are CSS variables with the light value as fallback; index.css carries both themes', () => {
    expect(resolveCss('series:1')).toBe('var(--viz-1, #0891b2)')
    expect(resolveHex('series:1', 'dark')).toBe('#22d3ee')
    const css = fs.readFileSync(new URL('../index.css', import.meta.url), 'utf8')
    for (const decl of cssVariables('light').split('; ')) expect(css).toContain(decl.replace(/;$/, ''))
    for (const decl of cssVariables('dark').split('; ')) expect(css).toContain(decl.replace(/;$/, ''))
  })
})

describe('renderChartSvg legend', () => {
  const rows = [{ Line: 'A', Availability: 0.9, Performance: 0.8, Quality: 0.95 }]
  const spec = (width: number) => ({ kind: 'bar' as const, width, height: 220, title: 'OEE', category: 'Line', series: [{ key: 'Availability' }, { key: 'Performance' }, { key: 'Quality' }] })
  const labels = (svg: string) => ['Availability', 'Performance', 'Quality'].filter((l) => svg.includes(`>${l}</text>`))
  it('wraps onto a second line in a narrow chart: no series is dropped', () => {
    expect(labels(renderChartSvg(spec(600), rows))).toHaveLength(3)
    const narrow = renderChartSvg(spec(200), rows)
    expect(labels(narrow)).toEqual(['Availability', 'Performance', 'Quality'])
    // the plot moved down by the extra legend line, so the lines do not overlap the bars
    const shift = (svg: string) => Number(/<g transform="translate\(0 (\d+)\)">/.exec(svg)![1])
    expect(shift(narrow)).toBeGreaterThan(shift(renderChartSvg(spec(600), rows)))
  })
})
