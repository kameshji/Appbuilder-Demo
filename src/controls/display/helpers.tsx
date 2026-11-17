/** Shared helpers for the Display agent's controls. */
import { useEffect, useRef } from 'react'
import type { CSSProperties, ComponentType, ReactNode } from 'react'
import * as Lucide from 'lucide-react'
import type { FxRecord, FxValue, PropMeta } from '@/contracts'
import { isRecord, recordText, toBool, toNum, toText } from '../util'

/* ------------------------------------------------------------------ icons */

type IconComp = ComponentType<{ className?: string; style?: CSSProperties; strokeWidth?: number }>

const lucideBag = Lucide as unknown as Record<string, unknown>

/** Resolve an icon name (PascalCase, kebab-case or snake_case) to a lucide component. */
export function iconByName(name: string): IconComp | undefined {
  const raw = name.trim()
  if (!raw) return undefined
  const pascal = raw.replace(/(^|[-_ ]+)([A-Za-z0-9])/g, (_m, _s, c: string) => c.toUpperCase())
  for (const key of [raw, pascal]) {
    const v = lucideBag[key]
    if (v && (typeof v === 'function' || (typeof v === 'object' && '$$typeof' in (v as object)))) return v as IconComp
  }
  return undefined
}

export function DynIcon({
  name,
  fallback,
  className,
  style,
  strokeWidth,
}: {
  name: FxValue | undefined
  fallback?: IconComp
  className?: string
  style?: CSSProperties
  strokeWidth?: number
}) {
  const C = iconByName(toText(name)) ?? fallback
  if (!C) return null
  return <C className={className} style={style} strokeWidth={strokeWidth} />
}

/* ------------------------------------------------------------------ theme colours */

/** Five-colour series palette derived from --primary plus neutral hues (all CSS, theme aware). */
export const SERIES_COLORS = [
  'var(--primary)',
  'oklch(0.72 0.13 195)',
  'oklch(0.78 0.14 75)',
  'oklch(0.68 0.16 345)',
  'oklch(0.62 0.02 265)',
]
export const seriesColor = (i: number) => SERIES_COLORS[((i % SERIES_COLORS.length) + SERIES_COLORS.length) % SERIES_COLORS.length]
/** Lighter tints for pie slices beyond the 5th. */
export function sliceColor(i: number): string {
  if (i < SERIES_COLORS.length) return SERIES_COLORS[i]
  const base = SERIES_COLORS[i % SERIES_COLORS.length]
  const mix = Math.min(70, 25 + Math.floor(i / SERIES_COLORS.length) * 20)
  return `color-mix(in oklch, ${base} ${100 - mix}%, var(--background))`
}
export const SUCCESS_COLOR = 'oklch(0.62 0.16 150)'
export const WARNING_COLOR = 'oklch(0.72 0.15 75)'

/* ------------------------------------------------------------------ records and tables */

/** Case-insensitive field lookup on a record. */
export function pick(rec: FxRecord, ...names: string[]): FxValue | undefined {
  for (const n of names) if (n in rec) return rec[n]
  const lower = new Map(Object.keys(rec).map((k) => [k.toLowerCase(), k]))
  for (const n of names) {
    const k = lower.get(n.toLowerCase())
    if (k !== undefined) return rec[k]
  }
  return undefined
}
export const pickText = (rec: FxRecord, ...names: string[]) => toText(pick(rec, ...names))

/** Text of a record by a named field (blank field name = recordText). */
export function fieldText(rec: FxRecord, field: string): string {
  const f = field.trim()
  if (!f) return recordText(rec)
  const v = pick(rec, f)
  return isRecord(v) ? recordText(v) : toText(v)
}

export function toDate(v: FxValue | undefined): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  if (typeof v === 'number') {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

/** Stable-ish content signature of a table, cheap enough to run every render. */
export function tableSignature(items: FxRecord[]): string {
  try {
    if (items.length <= 300) return JSON.stringify(items)
    return `${items.length}:${JSON.stringify(items[0])}:${JSON.stringify(items[items.length >> 1])}:${JSON.stringify(items[items.length - 1])}`
  } catch {
    return String(items.length)
  }
}

/* ------------------------------------------------------------------ formatting */

export function prettify(field: string): string {
  const spaced = field
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
  if (!spaced) return field
  return spaced
    .split(/\s+/)
    .map((w) => (w.length > 1 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/
export function isIsoDateString(s: string): boolean {
  return ISO_DATE.test(s) && !Number.isNaN(new Date(s).getTime())
}

export function formatDate(d: Date, withTime?: boolean): string {
  const hasTime = withTime ?? (d.getHours() !== 0 || d.getMinutes() !== 0 || d.getSeconds() !== 0)
  return hasTime
    ? d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return ''
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

/* ------------------------------------------------------------------ enum parsing */

export function lc(v: FxValue | undefined): string {
  return toText(v).trim().toLowerCase()
}

export type Layout = 'manual' | 'row' | 'column' | 'grid'
export function layoutOf(v: FxValue | undefined): Layout {
  const s = lc(v)
  return s === 'row' ? 'row' : s === 'column' ? 'column' : s === 'grid' ? 'grid' : 'manual'
}
export function orientationOf(v: FxValue | undefined, fallback: 'horizontal' | 'vertical' = 'horizontal'): 'horizontal' | 'vertical' {
  const s = lc(v)
  return s === 'vertical' ? 'vertical' : s === 'horizontal' ? 'horizontal' : fallback
}
export type SelMode = 'none' | 'single' | 'multiple'
export function selModeOf(v: FxValue | undefined, fallback: SelMode = 'single'): SelMode {
  const s = lc(v)
  return s === 'none' ? 'none' : s === 'multiple' ? 'multiple' : s === 'single' ? 'single' : fallback
}
export type VariantName = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive'
export function variantOf(v: FxValue | undefined): VariantName {
  const s = lc(v)
  return s === 'secondary' || s === 'outline' || s === 'ghost' || s === 'destructive' ? s : 'default'
}

/* ------------------------------------------------------------------ layout box */

const JUSTIFY: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  spacebetween: 'space-between',
  spacearound: 'space-around',
}
const ALIGN: Record<string, string> = { auto: 'flex-start', start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' }

const LAYOUT_OPTIONS = ['Layout.Manual', 'Layout.Row', 'Layout.Column', 'Layout.Grid']

/** Layout properties shared by every control that renders one children box. */
export function layoutProps(opts: { layout?: Layout; gap?: number; padding?: number } = {}): PropMeta[] {
  const layout = opts.layout ?? 'manual'
  return [
    { name: 'LayoutMode', label: 'Layout', kind: 'enum', group: 'Layout', default: `=Layout.${layout[0].toUpperCase()}${layout.slice(1)}`, options: LAYOUT_OPTIONS },
    { name: 'Gap', kind: 'number', group: 'Layout', default: `=${opts.gap ?? 16}` },
    { name: 'Padding', kind: 'number', group: 'Layout', default: `=${opts.padding ?? 0}` },
    { name: 'Justify', kind: 'enum', group: 'Layout', default: '=Justify.Start', options: ['Justify.Start', 'Justify.Center', 'Justify.End', 'Justify.SpaceBetween', 'Justify.SpaceAround'], simple: false },
    { name: 'AlignItems', kind: 'enum', group: 'Layout', default: '=AlignItems.Auto', options: ['AlignItems.Auto', 'AlignItems.Start', 'AlignItems.Center', 'AlignItems.End', 'AlignItems.Stretch'], simple: false },
    { name: 'Wrap', kind: 'boolean', group: 'Layout', default: '=false', simple: false },
    { name: 'Columns', kind: 'number', group: 'Layout', default: '=3', simple: false },
    { name: 'Scroll', kind: 'boolean', group: 'Layout', default: '=false', simple: false },
  ]
}

/** CSS for the children box. `overflowRun` is the overflow used at run time when Scroll is false. */
export function boxStyle(
  props: Record<string, FxValue>,
  mode: 'design' | 'run',
  opts: { overflowRun?: 'hidden' | 'visible' } = {},
): { style: CSSProperties; layout: Layout } {
  const layout = layoutOf(props.LayoutMode)
  const scroll = toBool(props.Scroll, false)
  const gap = Math.max(0, toNum(props.Gap, 16))
  const padding = Math.max(0, toNum(props.Padding, 0))
  const style: CSSProperties = { padding: padding || undefined }
  if (layout === 'manual') {
    style.position = 'relative'
  } else {
    style.position = 'relative'
    style.display = layout === 'grid' ? 'grid' : 'flex'
    style.gap = gap
    style.alignItems = ALIGN[lc(props.AlignItems)] ?? 'flex-start'
    if (layout === 'grid') {
      style.gridTemplateColumns = `repeat(${Math.max(1, Math.round(toNum(props.Columns, 3)))}, minmax(0, 1fr))`
      style.alignContent = 'start'
      style.justifyContent = JUSTIFY[lc(props.Justify)] ?? undefined
    } else {
      style.flexDirection = layout === 'row' ? 'row' : 'column'
      style.flexWrap = toBool(props.Wrap, false) ? 'wrap' : 'nowrap'
      style.justifyContent = JUSTIFY[lc(props.Justify)] ?? 'flex-start'
    }
  }
  if (scroll) style.overflow = mode === 'design' ? 'hidden' : 'auto'
  else style.overflow = mode === 'design' ? 'visible' : opts.overflowRun ?? 'hidden'
  return { style, layout }
}

/** The ONE children box of a layout container. Children are passed straight through. */
export function LayoutBox({
  props,
  mode,
  children,
  className,
  style,
  overflowRun,
}: {
  props: Record<string, FxValue>
  mode: 'design' | 'run'
  children?: ReactNode
  className?: string
  style?: CSSProperties
  overflowRun?: 'hidden' | 'visible'
}) {
  const b = boxStyle(props, mode, { overflowRun })
  return (
    <div data-layout={b.layout} className={['box-border', className].filter(Boolean).join(' ')} style={{ ...b.style, ...style }}>
      {children}
    </div>
  )
}

/* ------------------------------------------------------------------ selection hook */

/**
 * Single-selection over a table: initialises to `defText` (or the first item), follows changes of the
 * items/default, and re-initialises when the outputs are cleared. Returns the selected 0-based index.
 */
export function useSelection(
  items: FxRecord[],
  defText: string,
  outputs: Record<string, FxValue>,
  setOutput: (name: string, value: FxValue) => void,
  opts: { initial?: boolean } = {},
): { index: number; select: (i: number) => void } {
  const initial = opts.initial ?? true
  const texts = items.map(recordText)
  const key = texts.join('\u0001') + '\u0002' + defText
  const outIdx = typeof outputs.SelectedIndex === 'number' ? outputs.SelectedIndex - 1 : -1
  const prevKey = useRef<string | null>(null)

  const write = (i: number) => {
    const rec = items[i]
    setOutput('Selected', rec ?? null)
    setOutput('SelectedText', rec ? recordText(rec) : '')
    setOutput('SelectedIndex', rec ? i + 1 : null)
  }

  useEffect(() => {
    if (!initial) return
    const changed = prevKey.current !== key
    prevKey.current = key
    const bad = outIdx < 0 || outIdx >= items.length
    if (!changed && !bad) return
    const di = defText ? texts.indexOf(defText) : -1
    const target = di >= 0 ? di : items.length ? 0 : -1
    if (target < 0 && outputs.SelectedIndex == null) return
    if (!changed && target === outIdx) return
    write(target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, outIdx])

  return { index: outIdx >= 0 && outIdx < items.length ? outIdx : -1, select: write }
}
