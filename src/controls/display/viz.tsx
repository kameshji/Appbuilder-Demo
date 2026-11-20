/**
 * Interactive charts on the shared geometry (P2-C): VizView renders a Scene (src/charts/geometry.ts) as React SVG with
 * tooltips, keyboard navigation (arrow keys move between points, Enter selects), a legend that toggles series, a data
 * table alternative and exports (SVG, PNG, CSV). The same geometry makes renderChartSvg's PDF / email output, so screen
 * and paper match. Also the "Visual" UI component for canvas apps (Items + fields, like Chart, with every chart kind).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { ChartNoAxesCombined } from 'lucide-react'
import type { ControlRenderProps, ControlType, FxRecord } from '@/contracts'
import { cn } from '@/lib/utils'
import { CHART_KINDS, chartScene } from '@/charts/geometry'
import type { ChartKind, ChartSpec, Datum, Mark, Scene } from '@/charts/geometry'
import { resolveCss } from '@/charts/palette'
import { renderChartSvg } from '@/charts/svg'
import { toBool, toNum, toRecords, toText } from '../util'
import { lc } from './helpers'
import { useDevice } from '@/phone/env'
import { legendHeight, pointHitRadius } from '@/phone/touch-logic'

/* ------------------------------------------------------------------ size */

export function useBoxSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setSize((s) => (Math.abs(s.width - el.clientWidth) < 1 && Math.abs(s.height - el.clientHeight) < 1 ? s : { width: el.clientWidth, height: el.clientHeight }))
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size]
}

/* ------------------------------------------------------------------ marks */

function MarkEl({ m, focused, touch, onHover, onPick }: { m: Mark; focused: boolean; touch?: boolean; onHover(d: Datum | null, x: number, y: number): void; onPick(d: Datum): void }) {
  const c = resolveCss
  const d = 'datum' in m ? m.datum : undefined
  const handlers = d ? {
    onMouseEnter: (e: React.MouseEvent) => onHover(d, e.nativeEvent.offsetX, e.nativeEvent.offsetY),
    onMouseMove: (e: React.MouseEvent) => onHover(d, e.nativeEvent.offsetX, e.nativeEvent.offsetY),
    onMouseLeave: () => onHover(null, 0, 0),
    onClick: () => onPick(d),
    style: { cursor: 'pointer' },
  } : {}
  const ring = focused ? { stroke: 'var(--foreground)', strokeWidth: 2 } : {}
  switch (m.t) {
    case 'rect': return <rect x={m.x} y={m.y} width={Math.max(0, m.w)} height={Math.max(0, m.h)} rx={m.rx} fill={c(m.fill)} opacity={m.opacity} stroke={m.stroke ? c(m.stroke) : undefined} {...ring} {...handlers} />
    case 'path': return <path d={m.d} fill={m.fill ? c(m.fill) : 'none'} stroke={m.stroke ? c(m.stroke) : undefined} strokeWidth={m.width} strokeDasharray={m.dash} strokeLinecap={m.cap} strokeLinejoin={m.cap ? 'round' : undefined} opacity={m.opacity} {...ring} {...handlers} />
    case 'circle':
      // touch devices: points are small (r 3-4); an invisible 44 px circle around each one is what a finger hits
      if (touch && d) {
        return (
          <g {...handlers}>
            <circle cx={m.cx} cy={m.cy} r={pointHitRadius(m.r, true)} fill="transparent" data-touch-hit="" />
            <circle cx={m.cx} cy={m.cy} r={focused ? Math.max(m.r, 5) : Math.max(m.r, 0.01)} fill={c(m.fill)} stroke={m.stroke ? c(m.stroke) : undefined} strokeWidth={m.width} opacity={m.opacity} {...ring} pointerEvents="none" />
          </g>
        )
      }
      return <circle cx={m.cx} cy={m.cy} r={focused ? Math.max(m.r, 5) : d ? Math.max(m.r, 0.01) : m.r} fill={c(m.fill)} stroke={m.stroke ? c(m.stroke) : undefined} strokeWidth={m.width} opacity={m.opacity} {...ring} {...handlers} />
    case 'line': return <line x1={m.x1} y1={m.y1} x2={m.x2} y2={m.y2} stroke={c(m.stroke)} strokeWidth={m.width} strokeDasharray={m.dash} opacity={m.opacity} />
    case 'text': return <text x={m.x} y={m.y} fontSize={m.size} fill={c(m.fill)} textAnchor={m.anchor} dominantBaseline={m.baseline === 'middle' ? 'central' : m.baseline} fontWeight={m.weight} style={{ pointerEvents: 'none', fontVariantNumeric: 'tabular-nums' }}>{m.text}</text>
  }
}

/* ------------------------------------------------------------------ exports */

const isDark = () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark')

function download(name: string, blob: Blob) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}
const safeName = (s: string) => (s.replace(/[^A-Za-z0-9 _-]+/g, '').trim().slice(0, 60) || 'chart')

export function exportCsv(scene: Scene, title: string) {
  const f = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : /^[=+\-@\t\r]/.test(s) ? `'${s}` : s)
  const text = '﻿' + [scene.table.columns, ...scene.table.rows].map((r) => r.map(f).join(',')).join('\r\n') + '\r\n'
  download(`${safeName(title)}.csv`, new Blob([text], { type: 'text/csv' }))
}
export function exportSvg(spec: ChartSpec, rows: Record<string, unknown>[], title: string) {
  download(`${safeName(title)}.svg`, new Blob([renderChartSvg({ ...spec, title }, rows, { theme: isDark() ? 'dark' : 'light' })], { type: 'image/svg+xml' }))
}
export function exportPng(spec: ChartSpec, rows: Record<string, unknown>[], title: string) {
  const svg = renderChartSvg({ ...spec, title }, rows, { theme: isDark() ? 'dark' : 'light' })
  const img = new Image()
  const scale = 2
  img.onload = () => {
    const cv = document.createElement('canvas')
    cv.width = spec.width * scale
    cv.height = spec.height * scale
    const g = cv.getContext('2d')
    if (!g) return
    g.scale(scale, scale)
    g.drawImage(img, 0, 0)
    cv.toBlob((b) => b && download(`${safeName(title)}.png`, b), 'image/png')
  }
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
}

/* ------------------------------------------------------------------ the view */

export interface VizViewProps {
  spec: Omit<ChartSpec, 'width' | 'height'>
  rows: Record<string, unknown>[]
  /** run mode: points are clickable / focusable */
  interactive?: boolean
  onPick?(d: Datum): void
  /** show the data table instead of the chart */
  tableView?: boolean
  /** legend shown above the chart (HTML buttons that toggle series) */
  legend?: boolean
  className?: string
  testId?: string
  /** receives the scene and the sized spec (exports, the tile toolbar) */
  onScene?(scene: Scene, spec: ChartSpec): void
}

export function VizView({ spec, rows, interactive = true, onPick, tableView, legend = true, className, testId, onScene }: VizViewProps) {
  const [ref, size] = useBoxSize<HTMLDivElement>()
  const touch = useDevice().touch
  const [hidden, setHidden] = useState<string[]>([])
  const [tip, setTip] = useState<{ d: Datum; x: number; y: number } | null>(null)
  const [focus, setFocus] = useState(-1)
  const descId = useId()
  // the legend is measured once without size, then the plot gets the rest of the height
  const probe = useMemo(() => chartScene({ ...spec, width: 200, height: 100, hidden }, rows), [spec, rows, hidden])
  const showLegend = legend && probe.legend.length > 1 && spec.kind !== 'kpi'
  const legendH = showLegend ? legendHeight(touch) : 0
  const full: ChartSpec = { ...spec, width: Math.max(40, size.width), height: Math.max(30, size.height - legendH), hidden }
  const scene = useMemo(() => chartScene(full, rows), [JSON.stringify(spec), rows, size.width, size.height, legendH, hidden.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onScene?.(scene, full) }, [scene]) // eslint-disable-line react-hooks/exhaustive-deps
  const pts = scene.points
  // touch devices: a tap shows the tooltip (and picks); a tap anywhere else hides it again
  useEffect(() => {
    if (!touch || !tip) return
    const off = (e: Event) => {
      const el = ref.current
      if (el && e.target instanceof Node && el.contains(e.target) && (e.target as Element).closest?.('[data-touch-hit], rect, path, circle')) return
      setTip(null)
    }
    document.addEventListener('pointerdown', off, true)
    return () => document.removeEventListener('pointerdown', off, true)
  }, [touch, tip, ref])
  const focused = focus >= 0 && focus < pts.length ? pts[focus]! : null
  const pick = (d: Datum) => { if (interactive) onPick?.(d) }
  const onKey = (e: KeyboardEvent) => {
    if (!interactive || !pts.length) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); setFocus((f) => Math.min(pts.length - 1, f + 1)) }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); setFocus((f) => Math.max(0, f < 0 ? 0 : f - 1)) }
    else if (e.key === 'Home') { e.preventDefault(); setFocus(0) }
    else if (e.key === 'End') { e.preventDefault(); setFocus(pts.length - 1) }
    else if ((e.key === 'Enter' || e.key === ' ') && focused) { e.preventDefault(); pick(focused) }
    else if (e.key === 'Escape') setFocus(-1)
  }
  const tipFor = tip ?? (focused ? { d: focused, x: size.width / 2, y: 8 } : null)
  let body: ReactNode
  if (tableView) {
    body = (
      <div className="size-full overflow-auto" data-testid={testId ? `${testId}-table` : undefined}>
        <table className="w-full border-collapse text-xs">
          <caption className="sr-only">{scene.summary}</caption>
          <thead><tr>{scene.table.columns.map((c, i) => <th key={i} scope="col" className="sticky top-0 border-b bg-card px-2 py-1 text-left font-medium text-muted-foreground">{c}</th>)}</tr></thead>
          <tbody>{scene.table.rows.map((r, i) => <tr key={i} className="border-b border-border/60">{r.map((c, j) => <td key={j} className={cn('px-2 py-1', j > 0 && 'text-right tabular-nums')}>{c}</td>)}</tr>)}</tbody>
        </table>
      </div>
    )
  } else if (scene.empty) {
    body = <div className="flex size-full items-center justify-center text-sm text-muted-foreground" data-testid={testId ? `${testId}-empty` : undefined}>{scene.empty}</div>
  } else {
    body = (
      <svg
        width={scene.width} height={scene.height} role="img" aria-label={scene.summary} aria-describedby={descId}
        tabIndex={interactive && pts.length ? 0 : -1} onKeyDown={onKey} onBlur={() => setFocus(-1)}
        className="block outline-none focus-visible:ring-2 focus-visible:ring-ring/40" style={{ fontFamily: 'inherit' }}
        data-testid={testId ? `${testId}-svg` : undefined}
      >
        {scene.marks.map((m, i) => <MarkEl key={i} m={m} touch={touch} focused={!!focused && 'datum' in m && m.datum === focused} onHover={(d, x, y) => setTip(d ? { d, x, y } : null)} onPick={pick} />)}
      </svg>
    )
  }
  return (
    <div className={cn('relative flex size-full min-h-0 min-w-0 flex-col', className)} data-testid={testId}>
      {showLegend && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden" style={{ height: legendH }} role="group" aria-label="Series">
          {scene.legend.map((l) => (
            <button
              key={l.key} type="button" aria-pressed={!l.hidden} tabIndex={interactive ? 0 : -1}
              onClick={() => interactive && setHidden((h) => (h.includes(l.key) ? h.filter((x) => x !== l.key) : [...h, l.key]))}
              className={cn('flex shrink-0 items-center gap-1.5 rounded text-muted-foreground hover:bg-muted', touch ? 'h-11 px-3 text-xs' : 'px-1.5 py-0.5 text-[11px]', l.hidden && 'opacity-45 line-through')}
              data-testid={testId ? `${testId}-legend-${l.key}` : undefined}
            >
              <span className="inline-block size-2.5 rounded-sm" style={{ background: resolveCss(l.color) }} />{l.label}
            </button>
          ))}
        </div>
      )}
      <div ref={ref} className="relative min-h-0 flex-1 overflow-hidden">
        {size.width > 0 && body}
        {tipFor && !tableView && (
          <div role="status" className={cn('pointer-events-none absolute z-10 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md', touch ? 'max-w-[200px]' : 'max-w-[260px]')}
            style={touch ? { left: Math.min(Math.max(0, tipFor.x - 100), Math.max(0, size.width - 200)), top: Math.max(0, tipFor.y - 58) } : { left: Math.min(Math.max(0, tipFor.x + 12), Math.max(0, size.width - 200)), top: Math.max(0, tipFor.y - 34) }} data-testid={testId ? `${testId}-tooltip` : undefined}>
            {tipFor.d.text}
          </div>
        )}
      </div>
      <p id={descId} className="sr-only">{scene.summary}. {interactive && pts.length ? 'Use the arrow keys to move between points and Enter to select one.' : ''}</p>
    </div>
  )
}

/* ------------------------------------------------------------------ the Visual UI component */

const KIND_TEXT: Record<string, ChartKind> = Object.fromEntries(CHART_KINDS.map((k) => [k.toLowerCase(), k]))

function shapeFields(items: FxRecord[], category: string, values: string): { category: string; series: string[] } {
  const first = items[0] ?? {}
  const keys = Object.keys(first).filter((k) => !k.startsWith('__'))
  const cat = category.trim() || keys.find((k) => typeof first[k] !== 'number') || ''
  let series = values.split(',').map((s) => s.trim()).filter(Boolean)
  if (!series.length) series = keys.filter((k) => k !== cat && typeof first[k] === 'number').slice(0, 6)
  return { category: cat, series }
}

function VisualRender({ props, mode, setOutput, fire }: ControlRenderProps) {
  const run = mode === 'run'
  const items = useMemo(() => toRecords(props.Items), [props.Items])
  const kind = KIND_TEXT[lc(props.Kind)] ?? 'bar'
  const { category, series } = shapeFields(items, toText(props.CategoryField), toText(props.ValueFields))
  const fmt = lc(props.NumberFormat)
  const format = fmt === 'currency' ? { style: 'currency' as const } : fmt === 'percent' ? { style: 'percent' as const } : undefined
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : Number.isFinite(toNum(v as never, NaN)) ? toNum(v as never, 0) : undefined)
  const spec: Omit<ChartSpec, 'width' | 'height'> = {
    kind, category, series: series.map((s) => ({ key: s })), title: toText(props.Title) || undefined,
    stack: lc(props.Stack) === 'stacked' ? 'stacked' : lc(props.Stack) === 'percent' ? 'percent' : 'none',
    orientation: toBool(props.Horizontal, false) ? 'horizontal' : 'vertical', format,
    target: num(props.Target) ?? null, min: num(props.Min), max: num(props.Max), grid: toBool(props.ShowGrid, true),
    x: series[0], y: series[1], row: category, column: series[1],
  }
  const rows = items as unknown as Record<string, unknown>[]
  const title = toText(props.Title)
  return (
    <div className={cn('flex size-full min-h-0 min-w-0 flex-col', !run && 'pointer-events-none')}>
      {title !== '' && kind !== 'kpi' && <div className="shrink-0 px-1 pb-1 text-sm font-medium">{title}</div>}
      <VizView spec={spec} rows={rows} interactive={run} legend={toBool(props.ShowLegend, true)} onPick={(d) => {
        if (!run || !d.row) return
        setOutput('Selected', d.row as FxRecord)
        fire('OnSelect')
      }} />
    </div>
  )
}

export const Visual: ControlType = {
  type: 'Visual',
  label: 'Visual',
  icon: ChartNoAxesCombined,
  category: 'Charts',
  props: [
    { name: 'Items', kind: 'table', group: 'Data', default: '=Table({Line: "Press 1", Good: 420, Scrap: 12}, {Line: "Press 2", Good: 380, Scrap: 30}, {Line: "Press 3", Good: 455, Scrap: 8}, {Line: "Press 4", Good: 300, Scrap: 41})' },
    { name: 'Kind', label: 'Kind', kind: 'text', group: 'Style', default: '="Bar"' },
    { name: 'CategoryField', kind: 'text', group: 'Data', default: '=""' },
    { name: 'ValueFields', kind: 'text', group: 'Data', default: '=""' },
    { name: 'Title', kind: 'text', group: 'Content', default: '=""' },
    { name: 'Stack', kind: 'text', group: 'Style', default: '="None"', simple: false },
    { name: 'Horizontal', kind: 'boolean', group: 'Style', default: '=false', simple: false },
    { name: 'NumberFormat', kind: 'text', group: 'Style', default: '="Number"', simple: false },
    { name: 'Target', kind: 'any', group: 'Data', default: '=Blank()', simple: false },
    { name: 'Min', kind: 'any', group: 'Data', default: '=Blank()', simple: false },
    { name: 'Max', kind: 'any', group: 'Data', default: '=Blank()', simple: false },
    { name: 'ShowLegend', kind: 'boolean', group: 'Style', default: '=true' },
    { name: 'ShowGrid', kind: 'boolean', group: 'Style', default: '=true', simple: false },
    { name: 'OnSelect', kind: 'action', group: 'Behaviour', default: '=false' },
  ],
  outputs: [{ name: 'Selected', initial: null }],
  defaultSize: { width: 520, height: 320 },
  primaryProp: 'Items',
  render: VisualRender,
}
