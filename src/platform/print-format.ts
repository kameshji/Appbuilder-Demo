/**
 * Number, currency, percent and date formatting for print templates (docs/dev/pdf.md "Formatting"), from the
 * environment's print settings: Indian (lakh/crore: 12,34,56,789.00) or international (123,456,789.00) digit grouping,
 * a currency code, a date pattern and a time zone. Pure and deterministic (no locale data of the host is used for
 * grouping, so the server and the designer preview agree everywhere).
 */
import type { CellFormat } from './print.ts'

export interface FormatOptions {
  grouping: 'indian' | 'international'
  currency: string
  dateFormat: string
  timeZone: string
}

export const DEFAULT_FORMAT: FormatOptions = { grouping: 'indian', currency: 'INR', dateFormat: 'dd-MM-yyyy', timeZone: 'Asia/Kolkata' }

const SYMBOLS: Record<string, string> = { INR: '₹', USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', AED: 'AED ', SGD: 'S$', AUD: 'A$', CAD: 'C$', CHF: 'CHF ', BDT: '৳', NPR: 'Rs ', LKR: 'Rs ', PKR: 'Rs ' }
export const currencySymbol = (code: string): string => SYMBOLS[code.toUpperCase()] ?? `${code.toUpperCase()} `

/** groups the integer digits: indian 12,34,567; international 1,234,567 */
export function groupDigits(int: string, grouping: FormatOptions['grouping']): string {
  if (int.length <= 3) return int
  if (grouping === 'international') return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const last3 = int.slice(-3)
  const rest = int.slice(0, -3)
  return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3
}

/** a number with fixed decimals and digit grouping; non-numbers come back as text */
export function formatNumber(v: unknown, decimals: number | undefined, o: Pick<FormatOptions, 'grouping'>): string {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : NaN
  if (!Number.isFinite(n)) return v === null || v === undefined ? '' : String(v)
  const d = decimals === undefined ? (Number.isInteger(n) ? 0 : 2) : Math.max(0, Math.min(10, Math.trunc(decimals)))
  // round half away from zero on the decimal representation (toFixed rounds 1.005 down)
  const r = roundTo(Math.abs(n), d)
  const [int, frac] = r.split('.')
  const neg = n < 0 && Number(r) !== 0
  return `${neg ? '-' : ''}${groupDigits(int, o.grouping)}${frac ? '.' + frac : ''}`
}

function roundTo(x: number, d: number): string {
  // exponent arithmetic avoids binary rounding surprises (1.005 -> 1.01)
  if (x >= 1e21) return x.toFixed(d)
  const shifted = Number(`${x}e${d}`)
  const rounded = Math.round(shifted)
  const back = Number(`${rounded}e-${d}`)
  return Number.isFinite(back) ? back.toFixed(d) : x.toFixed(d)
}

export function formatCurrency(v: unknown, o: Pick<FormatOptions, 'grouping' | 'currency'>, decimals = 2, code?: string): string {
  const s = formatNumber(v, decimals, o)
  if (!s || !/\d/.test(s)) return s
  const sym = currencySymbol(code || o.currency || 'INR')
  return s.startsWith('-') ? `-${sym}${s.slice(1)}` : `${sym}${s}`
}

export function formatPercent(v: unknown, o: Pick<FormatOptions, 'grouping'>, decimals = 1): string {
  const n = typeof v === 'number' ? v : Number(v)
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return v === null || v === undefined ? '' : String(v)
  // values of 0..1 are fractions; larger values are already percentages
  return `${formatNumber(Math.abs(n) <= 1 ? n * 100 : n, decimals, o)}%`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** date parts in a time zone (date-only values are taken as they are) */
function partsOf(d: Date, tz: string, dateOnly: boolean): { y: number; M: number; d: number; h: number; m: number; s: number } {
  if (dateOnly) return { y: d.getUTCFullYear(), M: d.getUTCMonth() + 1, d: d.getUTCDate(), h: 0, m: 0, s: 0 }
  try {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
    const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]))
    return { y: Number(p.year), M: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, m: Number(p.minute), s: Number(p.second) }
  } catch {
    return { y: d.getUTCFullYear(), M: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds() }
  }
}

/** a Date from a Date, an ISO text or a {$d} value; null when it is none */
export function toDate(v: unknown): { date: Date; dateOnly: boolean } | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : { date: v, dateOnly: false }
  if (v && typeof v === 'object' && typeof (v as { $d?: unknown }).$d === 'string') return toDate((v as { $d: string }).$d)
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const d = new Date(`${v}T00:00:00Z`)
      return Number.isNaN(d.getTime()) ? null : { date: d, dateOnly: true }
    }
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
      const d = new Date(v)
      return Number.isNaN(d.getTime()) ? null : { date: d, dateOnly: false }
    }
  }
  return null
}

/**
 * Date patterns: yyyy, yy, MMMM, MMM, MM, M, dd, d, HH, H, hh, h, mm, ss, a (AM/PM). Anything else is literal; text in
 * single quotes is literal.
 */
export function formatDate(v: unknown, pattern: string, tz: string, withTime = false): string {
  const t = toDate(v)
  if (!t) return v === null || v === undefined ? '' : String(v)
  const p = partsOf(t.date, tz, t.dateOnly)
  const pat = withTime && !/[Hh]/.test(pattern) ? `${pattern} HH:mm` : pattern
  const two = (n: number) => String(n).padStart(2, '0')
  const tokens: [RegExp, (x: typeof p) => string][] = [
    [/^yyyy/, (x) => String(x.y)], [/^yy/, (x) => two(x.y % 100)], [/^MMMM/, (x) => MONTHS_LONG[x.M - 1]], [/^MMM/, (x) => MONTHS[x.M - 1]],
    [/^MM/, (x) => two(x.M)], [/^M/, (x) => String(x.M)], [/^dd/, (x) => two(x.d)], [/^d/, (x) => String(x.d)],
    [/^HH/, (x) => two(x.h)], [/^H/, (x) => String(x.h)], [/^hh/, (x) => two(((x.h + 11) % 12) + 1)], [/^h/, (x) => String(((x.h + 11) % 12) + 1)],
    [/^mm/, (x) => two(x.m)], [/^ss/, (x) => two(x.s)], [/^a/, (x) => (x.h < 12 ? 'AM' : 'PM')],
  ]
  let out = ''
  let i = 0
  while (i < pat.length) {
    if (pat[i] === "'") {
      const j = pat.indexOf("'", i + 1)
      out += j < 0 ? pat.slice(i + 1) : pat.slice(i + 1, j)
      i = j < 0 ? pat.length : j + 1
      continue
    }
    const rest = pat.slice(i)
    const hit = tokens.find(([re]) => re.test(rest))
    if (hit) {
      const m = hit[0].exec(rest)!
      out += hit[1](p)
      i += m[0].length
    } else {
      out += pat[i]
      i++
    }
  }
  return out
}

/** a cell value in a format (table columns, key-value entries) */
export function formatValue(v: unknown, format: CellFormat | undefined, o: FormatOptions, decimals?: number): string {
  if (v === null || v === undefined) return ''
  switch (format) {
    case 'number': return formatNumber(v, decimals, o)
    case 'integer': return formatNumber(v, 0, o)
    case 'currency': return formatCurrency(v, o, decimals ?? 2)
    case 'percent': return formatPercent(v, o, decimals ?? 1)
    case 'date': return formatDate(v, o.dateFormat, o.timeZone)
    case 'datetime': return formatDate(v, o.dateFormat, o.timeZone, true)
    case 'boolean': return v === true ? 'Yes' : v === false ? 'No' : String(v)
    default: return plainText(v, o)
  }
}

/** the text of a value without a format: dates in the date format, numbers grouped (decimals as they are) */
export function plainText(v: unknown, o: FormatOptions): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6)
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (v instanceof Date) {
    const isMidnightUtc = v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0 && v.getUTCMilliseconds() === 0
    return formatDate(v, o.dateFormat, o.timeZone, !isMidnightUtc)
  }
  if (Array.isArray(v)) return v.map((x) => plainText(x, o)).join(', ')
  if (typeof v === 'object') {
    const r = v as Record<string, unknown>
    if (typeof r.$d === 'string') return formatDate(r.$d, o.dateFormat, o.timeZone, !/^\d{4}-\d{2}-\d{2}$/.test(r.$d))
    // a lookup record or a choice: its display value
    for (const k of ['Name', 'FullName', 'Title', 'Value', 'name', 'fileName']) if (typeof r[k] === 'string') return r[k] as string
    return ''
  }
  return String(v)
}
