import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import * as lucide from 'lucide-react'
import type { ComponentType } from 'react'
import type { FxRecord, FxValue, PropMeta } from '@/contracts'
import { cn } from '@/lib/utils'
import { isRecord, recordText, toText } from '../util'
import { animatedIconComponent } from '../icon'

/* ------------------------------------------------------------------ shell */

/**
 * Wrapper every input renders inside. In design mode the whole subtree is `inert`
 * (no focus, no pointer events, no popovers can be opened) because the canvas owns the pointer.
 */
export function Shell({
  design,
  children,
  className,
  style,
  rootRef,
}: {
  design: boolean
  children?: ReactNode
  className?: string
  style?: CSSProperties
  rootRef?: React.Ref<HTMLDivElement>
}) {
  return (
    <div
      ref={rootRef}
      inert={design}
      className={cn('size-full min-w-0', className)}
      style={{ pointerEvents: design ? 'none' : undefined, ...style }}
    >
      {children}
    </div>
  )
}

const FOCUSABLE =
  'input:not([disabled]),textarea:not([disabled]),button:not([disabled]),[role="combobox"],[role="slider"],[tabindex]:not([tabindex="-1"])'

/** Run mode: focus the first focusable element inside `root` when the focus token changes. */
export function useFocusToken(root: React.RefObject<HTMLElement | null>, token: number | undefined, design: boolean) {
  const initial = useRef(token)
  useEffect(() => {
    if (design || token === undefined || token === initial.current) return
    initial.current = token
    const el = root.current?.querySelector<HTMLElement>(FOCUSABLE)
    el?.focus()
  }, [token, design, root])
}

/* ------------------------------------------------------------------ default syncing */

/**
 * Applies a control's Default to its outputs: on mount when the output is blank, whenever the
 * evaluated default `key` changes, and again when the output is cleared from outside (Reset).
 * A blank that the user produced themselves (call `markBlank(true)` before writing it) is respected.
 */
export function useDefaultApply(key: string, blank: boolean, apply: () => void) {
  const first = useRef(true)
  const prevKey = useRef(key)
  const userBlank = useRef(false)
  useEffect(() => {
    if (!blank) userBlank.current = false
    if (first.current) {
      first.current = false
      prevKey.current = key
      if (blank) apply()
      return
    }
    if (prevKey.current !== key) {
      prevKey.current = key
      userBlank.current = false
      apply()
      return
    }
    if (blank && !userBlank.current) apply()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, blank])
  return {
    markBlank(b: boolean) {
      userBlank.current = b
    },
    isUserBlank: () => userBlank.current,
  }
}

/* ------------------------------------------------------------------ enum parsers */

export type VariantName = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive'
export function variantOf(v: FxValue | undefined, fallback: VariantName = 'default'): VariantName {
  switch (toText(v).trim().toLowerCase()) {
    case 'default':
    case 'primary':
      return 'default'
    case 'secondary':
      return 'secondary'
    case 'outline':
      return 'outline'
    case 'ghost':
      return 'ghost'
    case 'destructive':
      return 'destructive'
    default:
      return fallback
  }
}

export type SizeName = 'sm' | 'md' | 'lg'
export function sizeOf(v: FxValue | undefined, fallback: SizeName = 'md'): SizeName {
  switch (toText(v).trim().toLowerCase()) {
    case 'small':
    case 'sm':
      return 'sm'
    case 'medium':
    case 'md':
      return 'md'
    case 'large':
    case 'lg':
      return 'lg'
    default:
      return fallback
  }
}

export function isVertical(v: FxValue | undefined): boolean {
  return toText(v).trim().toLowerCase() === 'vertical'
}

export function isMultiple(v: FxValue | undefined): boolean {
  return toText(v).trim().toLowerCase() === 'multiple'
}

export const orientationProp = (def: 'Horizontal' | 'Vertical'): PropMeta => ({
  name: 'Orientation',
  kind: 'enum',
  group: 'Style',
  default: `=Orientation.${def}`,
  options: ['Orientation.Horizontal', 'Orientation.Vertical'],
})

export const variantProp = (def: string, name = 'Variant'): PropMeta => ({
  name,
  kind: 'enum',
  group: 'Style',
  default: `=Variant.${def}`,
  options: ['Variant.Default', 'Variant.Secondary', 'Variant.Outline', 'Variant.Ghost', 'Variant.Destructive'],
})

export const sizeProp = (def: string, name = 'Size'): PropMeta => ({
  name,
  kind: 'enum',
  group: 'Style',
  default: `=Size.${def}`,
  options: ['Size.Small', 'Size.Medium', 'Size.Large'],
})

export const selectionModeProp = (def: 'Single' | 'Multiple', opts: string[] = ['SelectionMode.Single', 'SelectionMode.Multiple']): PropMeta => ({
  name: 'SelectionMode',
  kind: 'enum',
  group: 'Behaviour',
  default: `=SelectionMode.${def}`,
  options: opts,
})

/* ------------------------------------------------------------------ icons */

type IconComp = ComponentType<{ className?: string; style?: CSSProperties }>

/** lucide-react exports that are helpers, not icons (rendering them would throw). */
const NOT_ICONS = /^(createLucideIcon|icons|Icon|LucideProvider|useLucideContext|DynamicIcon|dynamicIconImports)$/i

/**
 * Resolve an evaluated icon name (PascalCase lucide name, aliases included, or "anim:<id>" for an animated icon) to a component.
 * Never throws; returns `fallback` for blank / unknown names.
 */
export function resolveIcon(name: FxValue | undefined, fallback?: IconComp): IconComp | undefined {
  const n = toText(name).trim()
  const animated = animatedIconComponent(n)
  if (animated) return animated
  if (n !== '' && /^[A-Za-z][A-Za-z0-9]*$/.test(n) && !NOT_ICONS.test(n)) {
    const map = lucide as unknown as Record<string, unknown>
    const cand = map[n] ?? map[n.charAt(0).toUpperCase() + n.slice(1)]
    if (typeof cand === 'function' || (typeof cand === 'object' && cand !== null && '$$typeof' in cand)) return cand as IconComp
  }
  return fallback
}

/* ------------------------------------------------------------------ items */

/** Display text of a table row; `field` (when set and present) wins, then Label/Title/Name/Value, then first scalar. */
export function itemText(rec: FxRecord, field?: string): string {
  if (field && field in rec) return toText(rec[field])
  for (const k of ['Value', 'Label', 'Title', 'Name', 'Text']) if (k in rec) return toText(rec[k])
  return recordText(rec)
}

export function sameRecord(a: FxValue | undefined, b: FxValue | undefined): boolean {
  if (!isRecord(a) || !isRecord(b)) return false
  if ('__id' in a && '__id' in b) return a.__id === b.__id
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/** A themed-or-custom colour: custom colour wins, else the CSS variable. */
export function themed(custom: string | undefined, variable: string): string {
  return custom ?? `var(${variable})`
}

/* ------------------------------------------------------------------ dates */

export function toDate(v: FxValue | undefined): Date | null {
  if (v == null) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  if (typeof v === 'number') {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  if (typeof v === 'string') {
    const s = v.trim()
    if (s === '') return null
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** Excel-style date format: yyyy yy mmmm mmm mm m dd d (case-insensitive; m is always the month). */
export function formatDate(d: Date, fmt: string): string {
  const f = fmt.trim() === '' ? 'yyyy-mm-dd' : fmt
  return f.replace(/yyyy|yy|mmmm|mmm|mm|m|dd|d/gi, (tok) => {
    switch (tok.toLowerCase()) {
      case 'yyyy': return String(d.getFullYear())
      case 'yy': return pad(d.getFullYear() % 100)
      case 'mmmm': return MONTHS[d.getMonth()]
      case 'mmm': return MONTHS[d.getMonth()].slice(0, 3)
      case 'mm': return pad(d.getMonth() + 1)
      case 'm': return String(d.getMonth() + 1)
      case 'dd': return pad(d.getDate())
      default: return String(d.getDate())
    }
  })
}

export function dateKey(d: Date | null): string {
  return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : ''
}

/* ------------------------------------------------------------------ small visuals */

/** Looks like a shadcn input/select trigger; used for static design-mode previews and run-mode triggers. */
export const triggerClass =
  'flex h-full w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50'
