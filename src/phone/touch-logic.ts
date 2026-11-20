/**
 * Decision logic of the touch behaviour (P2-A follow-up, docs/dev/phone.md "Touch"): small pure functions so the rules
 * are unit-tested without a DOM (src/phone/phone.test.ts). The components that use them: the bottom sheet pickers
 * (Dropdown, ComboBox, PersonPicker), the native date / time fields, NumberInput, the DataTable card layout, Dialog and
 * Sheet at phone width, the Form's sticky save bar and the Visual's touch targets.
 */

/** the widest area (px) that counts as "phone width" for card layouts and bottom sheets */
export const PHONE_WIDTH = 600

/* ------------------------------------------------------------------ pickers (search in a bottom sheet) */

/** indexes of the options whose text contains the search text (case-insensitive); blank search keeps everything */
export function filterOptions(texts: string[], search: string, limit = 500): number[] {
  const q = search.trim().toLowerCase()
  const out: number[] = []
  for (let i = 0; i < texts.length && out.length < limit; i++) if (q === '' || texts[i].toLowerCase().includes(q)) out.push(i)
  return out
}

/* ------------------------------------------------------------------ native date and time fields */

const p2 = (n: number) => String(n).padStart(2, '0')

/** `<input type="date">` value of a date: yyyy-mm-dd in local time, '' for none */
export function dateToNative(d: Date | null | undefined): string {
  if (!d || Number.isNaN(d.getTime())) return ''
  return `${String(d.getFullYear()).padStart(4, '0')}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

const dayNumber = (d: Date) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()

/**
 * The date a native date field reports: `null` for an empty field (cleared), a date at local midnight (the value
 * contract of the DatePicker: SelectedDate is the start of the day), `undefined` for text that is not a real date or is
 * outside Min / Max (ignore it: the field snaps back to the last good value).
 */
export function nativeToDate(s: string, min?: Date | null, max?: Date | null): Date | null | undefined {
  const t = s.trim()
  if (t === '') return null
  const m = /^(\d{4,6})-(\d{2})-(\d{2})$/.exec(t)
  if (!m) return undefined
  const y = Number(m[1])
  const mo = Number(m[2])
  const da = Number(m[3])
  const d = new Date(y, mo - 1, da)
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) return undefined
  if (min && !Number.isNaN(min.getTime()) && dayNumber(d) < dayNumber(min)) return undefined
  if (max && !Number.isNaN(max.getTime()) && dayNumber(d) > dayNumber(max)) return undefined
  return d
}

export interface NativeRange { start: Date | null; end: Date | null }

/**
 * The range after one of the two native fields of a DateRangePicker changed. A start after the end pulls the end along,
 * an end before the start pulls the start along (never an inverted range). Clearing the start clears the range;
 * clearing the end keeps an open range.
 */
export function applyNativeRange(which: 'start' | 'end', value: Date | null, cur: NativeRange): NativeRange {
  if (which === 'start') {
    if (!value) return { start: null, end: null }
    return { start: value, end: cur.end && dayNumber(cur.end) < dayNumber(value) ? value : cur.end }
  }
  if (!value) return { start: cur.start, end: null }
  return { start: cur.start && dayNumber(value) < dayNumber(cur.start) ? value : cur.start, end: value }
}

/** `<input type="time">` value (HH:MM) of a time of day; '' for none */
export function timeToNative(t: { h: number; m: number } | null | undefined): string {
  return t ? `${p2(t.h)}:${p2(t.m)}` : ''
}

/** the time a native time field reports: null for empty, undefined for text that is not a time (HH:MM or HH:MM:SS) */
export function nativeToTime(s: string): { h: number; m: number } | null | undefined {
  const t = s.trim()
  if (t === '') return null
  const m = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(t)
  if (!m) return undefined
  const h = Number(m[1])
  const min = Number(m[2])
  return h > 23 || min > 59 ? undefined : { h, m: min }
}

/* ------------------------------------------------------------------ NumberInput */

/**
 * Which on-screen keyboard a NumberInput asks for. `numeric` (digits only) only for a bounded whole-number range (Min,
 * Max and Step all whole numbers, Min not negative): people typing a quantity. Everything else gets `decimal`, so a
 * decimal separator is always there. (iOS has no minus key on either pad: see allowsNegative / toggleSign.)
 */
export function numberInputMode(min: number | null, max: number | null, step: number): 'numeric' | 'decimal' {
  const whole = (n: number) => Number.isInteger(n)
  return min != null && max != null && min >= 0 && whole(min) && whole(max) && whole(step) && step >= 1 ? 'numeric' : 'decimal'
}

/** true when the field may hold a negative number (then touch devices get a sign button: no minus key on iOS pads) */
export function allowsNegative(min: number | null): boolean {
  return min == null || min < 0
}

/**
 * Typed text of a number field, ready to store, or null when it is not a number being typed. A decimal comma (many
 * phone keyboards show a comma for the locale) becomes the point; a second separator is refused.
 */
export function normalizeNumberText(t: string): string | null {
  const s = t.replace(',', '.')
  return /^-?\d*\.?\d*$/.test(s) ? s : null
}

/** the sign button: flips a leading minus ('' becomes '-' so the next digits are negative) */
export function toggleSign(t: string): string {
  return t.startsWith('-') ? t.slice(1) : '-' + t
}

/* ------------------------------------------------------------------ DataTable cards */

/** true when a DataTable draws cards instead of a table: a touch device, run mode and a table narrower than a phone */
export function cardMode(touch: boolean, width: number, design = false): boolean {
  return touch && !design && width > 0 && width < PHONE_WIDTH
}

/** the field names of a CardColumns text ("Name, Status:Stage, Amount"): the part before a colon, trimmed, no repeats */
export function parseCardColumns(spec: string): string[] {
  const out: string[] = []
  for (const part of spec.split(',')) {
    const t = part.trim()
    if (t === '') continue
    const f = (t.includes(':') ? t.slice(0, t.indexOf(':')) : t).trim()
    if (f !== '' && !out.some((o) => o.toLowerCase() === f.toLowerCase())) out.push(f)
  }
  return out
}

export interface CardPlan<C> {
  /** the first line of the card, bold */
  title: C
  /** a second prominent value under the title (value only, no label); only with an explicit priority list */
  subtitle: C | null
  /** the rest as "label: value" lines, in this order (blank values are skipped when drawn) */
  lines: C[]
}

/**
 * Which columns a phone card shows and how. With a priority list (`CardColumns`): the listed columns that exist, in that
 * order, and nothing else: the first is the title, the second the subtitle, the rest label: value lines. Without one:
 * the first text column (else the first column) is the title and the other columns follow as lines in table order, at
 * most `maxLines` of them (a card is not a table). Returns null when there are no columns.
 */
export function cardPlan<C extends { field: string; kind: string }>(cols: C[], priority: string[], maxLines = 5): CardPlan<C> | null {
  if (cols.length === 0) return null
  const named = priority
    .map((p) => cols.find((c) => c.field.toLowerCase() === p.toLowerCase()))
    .filter((c, i, a): c is C => !!c && a.indexOf(c) === i)
  if (named.length > 0) return { title: named[0], subtitle: named[1] ?? null, lines: named.slice(2) }
  const title = cols.find((c) => c.kind === 'text') ?? cols[0]
  return { title, subtitle: null, lines: cols.filter((c) => c !== title).slice(0, Math.max(0, maxLines)) }
}

/* ------------------------------------------------------------------ Dialog / Sheet */

export type OverlayPlacement = 'dialog' | 'left' | 'right' | 'top' | 'bottom' | 'bottom-sheet'

/**
 * Where a Dialog or Sheet UI component goes: at phone width on a touch device a Dialog and a left / right / bottom
 * Sheet are bottom sheets (full width, rounded top, drag handle, above the keyboard); a top Sheet stays a top sheet;
 * everything else (desktop, tablets and wide windows) is drawn as before.
 */
export function overlayPlacement(kind: 'Dialog' | 'Sheet', side: string, touch: boolean, areaWidth: number): OverlayPlacement {
  const s = side.trim().toLowerCase()
  const narrow = touch && areaWidth > 0 && areaWidth < PHONE_WIDTH
  if (kind === 'Dialog') return narrow ? 'bottom-sheet' : 'dialog'
  if (s === 'left' || s === 'right') return narrow ? 'bottom-sheet' : s
  if (s === 'top') return 'top'
  return narrow ? 'bottom-sheet' : 'bottom'
}

/** a sheet dragged down by `dy` px in `ms` ms is dismissed when pulled far enough or flicked */
export function dragDismiss(dy: number, ms: number): boolean {
  if (dy <= 0) return false
  return dy > 100 || (dy > 36 && ms > 0 && dy / ms > 0.6)
}

/* ------------------------------------------------------------------ Form: the sticky save bar */

export interface PinInput {
  /** the form's box (px, page viewport coordinates) */
  formTop: number
  formBottom: number
  /** the bar's height */
  barHeight: number
  /** the visible part of the page: the visual viewport (above the on-screen keyboard) */
  viewTop: number
  viewBottom: number
}

/**
 * Whether the save bar must be pinned to the bottom of the visible screen: when the form's own bottom (where its bar
 * sits) is below what the user can see (the keyboard covers it, or the form is taller than the screen) but a useful part
 * of the form (at least 120 px above the bar) is on screen. Otherwise the bar stays where it is.
 */
export function barPinned(i: PinInput): boolean {
  if (i.formBottom <= i.viewBottom + 1) return false
  if (i.formBottom < i.viewTop + i.barHeight) return false
  return i.formTop < i.viewBottom - i.barHeight - 120
}

/* ------------------------------------------------------------------ charts */

/** the height (px) of a chart legend row: 26 px normally, a 44 px touch row on touch devices */
export const legendHeight = (touch: boolean): number => (touch ? 44 : 26)

/** the radius (px) of the invisible touch circle around a chart point: at least 22 px (a 44 px target) on touch devices */
export const pointHitRadius = (r: number, touch: boolean): number => (touch ? Math.max(22, r) : r)
