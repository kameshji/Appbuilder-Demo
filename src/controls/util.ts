import { useEffect, useRef } from 'react'
import type { FxRecord, FxValue, PropMeta } from '@/contracts'

/* ---- defensive coercion of evaluated props ---- */

export function toNum(v: FxValue | undefined, fallback: number): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }
  if (typeof v === 'boolean') return v ? 1 : 0
  return fallback
}

export function toText(v: FxValue | undefined): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v instanceof Date) return v.toLocaleString()
  try {
    return JSON.stringify(v)
  } catch {
    return ''
  }
}

export function toBool(v: FxValue | undefined, fallback = false): boolean {
  if (typeof v === 'boolean') return v
  if (v == null) return fallback
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (s === 'true') return true
    if (s === 'false' || s === '') return false
  }
  return fallback
}

/** CSS colour string or undefined when blank. */
export function toColor(v: FxValue | undefined): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  return s === '' ? undefined : s
}

export function isRecord(v: FxValue | undefined): v is FxRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)
}

/** Table (array of records or of primitives) -> array of records. Primitives become {Value}. */
export function toRecords(v: FxValue | undefined): FxRecord[] {
  if (!Array.isArray(v)) return []
  return v.map((item) => (isRecord(item) ? item : { Value: item }))
}

/** Text shown for a table row: `Value` field, else the first scalar field. */
export function recordText(rec: FxRecord): string {
  if ('Value' in rec) return toText(rec.Value)
  for (const [k, val] of Object.entries(rec)) {
    if (k.startsWith('__')) continue
    if (typeof val === 'string' || typeof val === 'number') return String(val)
  }
  return ''
}

export type Mode = 'Edit' | 'View' | 'Disabled'
export function toDisplayMode(v: FxValue | undefined): Mode {
  const s = toText(v).trim().toLowerCase()
  if (s === 'disabled') return 'Disabled'
  if (s === 'view') return 'View'
  return 'Edit'
}

export function fontWeightOf(v: FxValue | undefined): number {
  const s = toText(v).trim().toLowerCase()
  if (s === 'bold') return 700
  if (s === 'semibold') return 600
  if (s === 'lighter' || s === 'light') return 300
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? n : 400
}

export function alignOf(v: FxValue | undefined): 'left' | 'center' | 'right' {
  const s = toText(v).trim().toLowerCase()
  if (s === 'center') return 'center'
  if (s === 'right') return 'right'
  return 'left'
}

export function borderStyle(color: string | undefined, width: number): React.CSSProperties {
  if (width <= 0) return {}
  return { borderStyle: 'solid', borderWidth: width, borderColor: color ?? 'transparent' }
}

/* ---- shared prop metadata ---- */

export const displayModeProp: PropMeta = {
  name: 'DisplayMode',
  kind: 'enum',
  group: 'Behaviour',
  default: '=DisplayMode.Edit',
  options: ['DisplayMode.Edit', 'DisplayMode.View', 'DisplayMode.Disabled'],
  simple: true,
}

export const alignProp: PropMeta = {
  name: 'Align',
  kind: 'enum',
  group: 'Style',
  default: '=Align.Left',
  options: ['Align.Left', 'Align.Center', 'Align.Right'],
}

export function commonProps(width: number, height: number): PropMeta[] {
  return [
    { name: 'X', kind: 'number', group: 'Layout', default: '=40' },
    { name: 'Y', kind: 'number', group: 'Layout', default: '=40' },
    { name: 'Width', kind: 'number', group: 'Layout', default: `=${width}` },
    { name: 'Height', kind: 'number', group: 'Layout', default: `=${height}` },
    { name: 'Visible', kind: 'boolean', group: 'Layout', default: '=true' },
    // Responsive behaviour inside a Manual-layout parent (see SPEC2 section 4).
    { name: 'AnchorH', label: 'Horizontal anchor', kind: 'enum', group: 'Layout', default: '=Anchor.Start', options: ['Anchor.Start', 'Anchor.End', 'Anchor.Stretch', 'Anchor.Center', 'Anchor.Scale'] },
    { name: 'AnchorV', label: 'Vertical anchor', kind: 'enum', group: 'Layout', default: '=Anchor.Start', options: ['Anchor.Start', 'Anchor.End', 'Anchor.Stretch', 'Anchor.Center', 'Anchor.Scale'] },
    // Behaviour inside an auto-layout (Row / Column / Grid) parent.
    { name: 'Grow', kind: 'number', group: 'Layout', default: '=0', simple: false },
    { name: 'AlignSelf', kind: 'enum', group: 'Layout', default: '=AlignItems.Auto', options: ['AlignItems.Auto', 'AlignItems.Start', 'AlignItems.Center', 'AlignItems.End', 'AlignItems.Stretch'], simple: false },
    { name: 'Tooltip', kind: 'text', group: 'Content', default: '=""', simple: false },
  ]
}

/**
 * Keeps an output in step with a (primitive) Default: initialises on mount, follows when the
 * evaluated Default changes, and re-initialises if the output is cleared (e.g. Reset).
 */
export function useDefaultSync(
  def: string | boolean,
  value: FxValue | undefined,
  blankValue: string | boolean,
  write: (v: string | boolean) => void,
) {
  const prev = useRef<string | boolean | null>(null)
  const blank = value == null
  useEffect(() => {
    const first = prev.current === null
    const changed = !first && prev.current !== def
    const untouched = first && value === blankValue && def !== blankValue
    if (blank || changed || untouched) write(def)
    prev.current = def
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, blank])
}
