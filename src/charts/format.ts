/**
 * Number, currency, percent and date formatting for charts and dashboards (P2-C). Pure (Intl only): used by the UI
 * components in the browser and by renderChartSvg on the server (PDF, email snapshots), so both show the same text.
 *
 * Locale "en-IN" gives Indian digit grouping (12,34,567.8) and, in compact notation, lakh / crore (12.3L, 1.2Cr).
 * The defaults come from the environment's dashboard settings (DashboardSettings: locale, currency, time zone).
 */

export type NumberStyle = 'number' | 'currency' | 'percent'

export interface NumberFormat {
  style?: NumberStyle
  /** fraction digits (default: 0 for whole numbers, up to 2 otherwise; percent 1) */
  decimals?: number
  /** ISO 4217, for style currency (default from settings, INR) */
  currency?: string
  /** BCP 47 locale, e.g. en-IN (default from settings) */
  locale?: string
  /** 12.3L / 1.2M style */
  compact?: boolean
  /** percent values are fractions (0.85 = 85%) unless false (85 = 85%) */
  fraction?: boolean
  prefix?: string
  suffix?: string
}

export interface FormatDefaults { locale: string; currency: string; timeZone: string }
export const DEFAULT_FORMAT: FormatDefaults = { locale: 'en-IN', currency: 'INR', timeZone: 'Asia/Kolkata' }

const cache = new Map<string, Intl.NumberFormat>()
function nf(locale: string, o: Intl.NumberFormatOptions): Intl.NumberFormat {
  const k = locale + JSON.stringify(o)
  let f = cache.get(k)
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, o)
    } catch {
      f = new Intl.NumberFormat('en-IN', { ...o, currency: o.currency && /^[A-Z]{3}$/.test(o.currency) ? o.currency : undefined, style: o.style === 'currency' && !o.currency ? 'decimal' : o.style })
    }
    if (cache.size > 300) cache.clear()
    cache.set(k, f)
  }
  return f
}

/** text of a number; '' for blank / non-finite */
export function formatNumber(v: unknown, f: NumberFormat = {}, d: FormatDefaults = DEFAULT_FORMAT): string {
  if (v === null || v === undefined || v === '') return ''
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return ''
  const locale = f.locale || d.locale
  const style = f.style ?? 'number'
  const o: Intl.NumberFormatOptions = {}
  let x = n
  if (style === 'percent') {
    o.style = 'percent'
    if (f.fraction === false) x = n / 100
    o.maximumFractionDigits = f.decimals ?? 1
    o.minimumFractionDigits = 0
  } else {
    if (style === 'currency') {
      o.style = 'currency'
      o.currency = (f.currency || d.currency || 'INR').toUpperCase()
    }
    const whole = Number.isInteger(n)
    o.maximumFractionDigits = f.decimals ?? (whole ? 0 : 2)
    o.minimumFractionDigits = f.decimals ?? (style === 'currency' && !whole ? 2 : 0)
  }
  if (f.compact) {
    o.notation = 'compact'
    o.maximumFractionDigits = f.decimals ?? 1
    o.minimumFractionDigits = 0
  }
  const s = nf(locale, o).format(Object.is(x, -0) ? 0 : x)
  return `${f.prefix ?? ''}${s}${f.suffix ?? ''}`
}

/** short axis tick text: compact for large values */
export function formatTick(v: number, f: NumberFormat = {}, d: FormatDefaults = DEFAULT_FORMAT, span = Math.abs(v)): string {
  const compact = f.compact ?? span >= 100_000
  return formatNumber(v, { ...f, compact, decimals: compact ? undefined : f.decimals ?? (Math.abs(v) < 10 && !Number.isInteger(v) ? 1 : 0) }, d)
}

export type DateGrain = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'fiscalQuarter' | 'fiscalYear' | 'hour' | 'datetime'

const dfCache = new Map<string, Intl.DateTimeFormat>()
function df(locale: string, o: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = locale + JSON.stringify(o)
  let f = dfCache.get(k)
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, o)
    } catch {
      f = new Intl.DateTimeFormat('en-IN', o)
    }
    dfCache.set(k, f)
  }
  return f
}

/** a calendar date (Date at local midnight, or "YYYY-MM-DD") */
function ymdOf(v: unknown): [number, number, number] | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return [v.getFullYear(), v.getMonth() + 1, v.getDate()]
  if (typeof v === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v)
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
  }
  return null
}

/**
 * label of a bucket start or a date. Fiscal years: "FY2026-27" (start month > 1) or "FY2026"; fiscal quarters "Q1
 * FY2026-27". `fiscalYearStart` is the first month of the fiscal year.
 */
export function formatDate(v: unknown, grain: DateGrain = 'day', o: { locale?: string; timeZone?: string; fiscalYearStart?: number } = {}, d: FormatDefaults = DEFAULT_FORMAT): string {
  if (v === null || v === undefined || v === '') return ''
  const locale = o.locale || d.locale
  if (grain === 'datetime' || grain === 'hour') {
    const t = v instanceof Date ? v : new Date(String(v))
    if (Number.isNaN(t.getTime())) return String(v)
    return df(locale, { timeZone: o.timeZone || d.timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(t)
  }
  const ymd = ymdOf(v)
  if (!ymd) return String(v)
  const [y, m, day] = ymd
  const utc = new Date(Date.UTC(y, m - 1, day))
  const fy = o.fiscalYearStart ?? 4
  const fyLabel = (first: number) => (fy === 1 ? `FY${first}` : `FY${first}-${String((first + 1) % 100).padStart(2, '0')}`)
  switch (grain) {
    case 'year': return String(y)
    case 'quarter': return `Q${Math.floor((m - 1) / 3) + 1} ${y}`
    case 'month': return df(locale, { timeZone: 'UTC', month: 'short', year: 'numeric' }).format(utc)
    case 'fiscalYear': return fyLabel(m >= fy ? y : y - 1)
    case 'fiscalQuarter': {
      const first = m >= fy ? y : y - 1
      const q = Math.floor(((m - fy + 12) % 12) / 3) + 1
      return `Q${q} ${fyLabel(first)}`
    }
    case 'week': return `Wk ${df(locale, { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(utc)}`
    default: return df(locale, { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(utc)
  }
}

export const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
