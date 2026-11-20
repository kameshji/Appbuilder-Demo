/**
 * Dashboard date ranges (P2-C): presets (today, this shift, this week, this month, this quarter, this fiscal year,
 * fiscal-year-to-date, last N days ...) resolved in the dashboard's time zone, comparison periods (previous period,
 * same period last year) and the conditions they put on a date or datetime column. Pure.
 *
 * A range is a pair of local date-times in the time zone, end exclusive: { from: 'YYYY-MM-DDTHH:MM', to: ... }.
 */
import type { ConditionV2 } from '../platform/query.ts'
import type { Ymd } from '../fx/query/buckets.ts'
import { addDays, addMonths, dayNumber, fiscalYearStartOf, isoWeekday, parseYmd, ymdText, zonedParts } from '../fx/query/buckets.ts'

export interface DateRange { from: string; to: string }

export interface Shift { name: string; start: string; end: string }

export interface CalendarSettings {
  timeZone: string
  fiscalYearStart: number
  weekStart: 1 | 7
  /** shift pattern for "this shift" (end may be past midnight) */
  shifts: Shift[]
}

export const DEFAULT_CALENDAR: CalendarSettings = {
  timeZone: 'Asia/Kolkata', fiscalYearStart: 4, weekStart: 1,
  shifts: [{ name: 'A', start: '06:00', end: '14:00' }, { name: 'B', start: '14:00', end: '22:00' }, { name: 'C', start: '22:00', end: '06:00' }],
}

export type RangePreset =
  | 'today' | 'yesterday' | 'thisShift' | 'thisWeek' | 'lastWeek' | 'thisMonth' | 'lastMonth' | 'thisQuarter' | 'thisFiscalYear'
  | 'fiscalYearToDate' | 'last7' | 'last30' | 'last90' | 'last12Months' | 'all'

export const RANGE_PRESETS: { key: RangePreset; label: string }[] = [
  { key: 'thisShift', label: 'This shift' }, { key: 'today', label: 'Today' }, { key: 'yesterday', label: 'Yesterday' },
  { key: 'thisWeek', label: 'This week' }, { key: 'lastWeek', label: 'Last week' }, { key: 'last7', label: 'Last 7 days' },
  { key: 'thisMonth', label: 'This month' }, { key: 'lastMonth', label: 'Last month' }, { key: 'last30', label: 'Last 30 days' },
  { key: 'thisQuarter', label: 'This quarter' }, { key: 'last90', label: 'Last 90 days' }, { key: 'thisFiscalYear', label: 'This fiscal year' },
  { key: 'fiscalYearToDate', label: 'Fiscal year to date' }, { key: 'last12Months', label: 'Last 12 months' }, { key: 'all', label: 'All time' },
]

const at = (d: Ymd, hm = '00:00'): string => `${ymdText(d)}T${hm}`
const hmOk = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s)

/** the shift running at local time hh:mm on day d (a shift past midnight started the day before) */
export function currentShift(now: { ymd: Ymd; minutes: number }, shifts: Shift[]): { shift: Shift; range: DateRange } | null {
  const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5))
  for (const s of shifts) {
    if (!hmOk(s.start) || !hmOk(s.end)) continue
    const a = mins(s.start), b = mins(s.end)
    if (a < b && now.minutes >= a && now.minutes < b) return { shift: s, range: { from: at(now.ymd, s.start), to: at(now.ymd, s.end) } }
    if (a >= b) {
      if (now.minutes >= a) return { shift: s, range: { from: at(now.ymd, s.start), to: at(addDays(now.ymd, 1), s.end) } }
      if (now.minutes < b) return { shift: s, range: { from: at(addDays(now.ymd, -1), s.start), to: at(now.ymd, s.end) } }
    }
  }
  return null
}

/** a preset as a range in the calendar's time zone, at instant `now` (null: no restriction) */
export function resolvePreset(p: RangePreset, now: Date, cal: CalendarSettings = DEFAULT_CALENDAR): DateRange | null {
  const z = zonedParts(now, cal.timeZone)
  const today = z.ymd
  const minutes = z.hour * 60 + Number(new Intl.DateTimeFormat('en-US', { timeZone: cal.timeZone, minute: 'numeric' }).format(now))
  const wd = isoWeekday(today)
  const weekStart = addDays(today, -(cal.weekStart === 7 ? wd % 7 : wd - 1))
  const month: Ymd = [today[0], today[1], 1]
  const quarter: Ymd = [today[0], Math.floor((today[1] - 1) / 3) * 3 + 1, 1]
  const fy = fiscalYearStartOf(today, cal.fiscalYearStart)
  switch (p) {
    case 'today': return { from: at(today), to: at(addDays(today, 1)) }
    case 'yesterday': return { from: at(addDays(today, -1)), to: at(today) }
    case 'thisShift': return currentShift({ ymd: today, minutes }, cal.shifts)?.range ?? { from: at(today), to: at(addDays(today, 1)) }
    case 'thisWeek': return { from: at(weekStart), to: at(addDays(weekStart, 7)) }
    case 'lastWeek': return { from: at(addDays(weekStart, -7)), to: at(weekStart) }
    case 'thisMonth': return { from: at(month), to: at(addMonths(month, 1)) }
    case 'lastMonth': return { from: at(addMonths(month, -1)), to: at(month) }
    case 'thisQuarter': return { from: at(quarter), to: at(addMonths(quarter, 3)) }
    case 'thisFiscalYear': return { from: at(fy), to: at(addMonths(fy, 12)) }
    case 'fiscalYearToDate': return { from: at(fy), to: at(addDays(today, 1)) }
    case 'last7': return { from: at(addDays(today, -6)), to: at(addDays(today, 1)) }
    case 'last30': return { from: at(addDays(today, -29)), to: at(addDays(today, 1)) }
    case 'last90': return { from: at(addDays(today, -89)), to: at(addDays(today, 1)) }
    case 'last12Months': return { from: at(addMonths(month, -11)), to: at(addMonths(month, 1)) }
    case 'all': return null
  }
}

function split(s: string): { ymd: Ymd; hm: string } {
  const ymd = parseYmd(s)
  if (!ymd) throw new Error(`Not a date: ${s}`)
  const hm = s.length >= 16 ? s.slice(11, 16) : '00:00'
  return { ymd, hm: hmOk(hm) ? hm : '00:00' }
}

/**
 * the comparison range: the same length just before (previousPeriod) or one year earlier (samePeriodLastYear). With
 * `now` (a local date-time) inside the range, only the elapsed part is compared ("to date"): this month until now
 * against last month until the same day and time, not against the whole of last month.
 */
export function comparisonRange(r: DateRange, mode: 'previousPeriod' | 'samePeriodLastYear', now?: string): DateRange {
  const a = split(r.from), b = split(r.to)
  const mins = (x: { ymd: Ymd; hm: string }) => dayNumber(x.ymd) * 1440 + Number(x.hm.slice(0, 2)) * 60 + Number(x.hm.slice(3))
  let shift: (x: { ymd: Ymd; hm: string }) => string
  // whole months (a month, a quarter, a fiscal year) shift by months so "this month" compares with last month
  const wholeMonths = a.ymd[2] === 1 && b.ymd[2] === 1 && a.hm === '00:00' && b.hm === '00:00' && (b.ymd[0] - a.ymd[0]) * 12 + (b.ymd[1] - a.ymd[1]) > 0
  if (mode === 'samePeriodLastYear') shift = (x) => at(addMonths(x.ymd, -12), x.hm)
  else if (wholeMonths) {
    const months = (b.ymd[0] - a.ymd[0]) * 12 + (b.ymd[1] - a.ymd[1])
    shift = (x) => at(addMonths(x.ymd, -months), x.hm)
  } else {
    const len = mins(b) - mins(a)
    shift = (x) => {
      const m = mins(x) - len
      const d = Math.floor(m / 1440)
      const rest = m - d * 1440
      return at(addDays(x.ymd, d - dayNumber(x.ymd)), `${String(Math.floor(rest / 60)).padStart(2, '0')}:${String(rest % 60).padStart(2, '0')}`)
    }
  }
  let end = b
  if (now) {
    const n = split(now)
    if (mins(n) > mins(a) && mins(n) < mins(b)) end = n
  }
  return { from: shift(a), to: shift(end) }
}

/** the local date-time of an instant in a time zone, as a range end ("YYYY-MM-DDTHH:MM") */
export function localNow(t: Date, timeZone: string): string {
  const z = zonedParts(t, timeZone)
  const m = new Intl.DateTimeFormat('en-US', { timeZone, minute: 'numeric' }).format(t)
  return `${ymdText(z.ymd)}T${String(z.hour).padStart(2, '0')}:${String(Number(m)).padStart(2, '0')}`
}

const minuteFmt = new Map<string, Intl.DateTimeFormat>()
/** the local wall-clock time of an instant, as if it were UTC (ms) */
function localMs(t: Date, timeZone: string): number {
  const z = zonedParts(t, timeZone)
  let f = minuteFmt.get(timeZone)
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone, minute: 'numeric' }); minuteFmt.set(timeZone, f) }
  return Date.UTC(z.ymd[0], z.ymd[1] - 1, z.ymd[2], z.hour, Number(f.format(t)))
}

/** the instant of a local date-time in a time zone (DST-safe: two correction steps) */
export function zonedInstant(local: string, timeZone: string): Date {
  const { ymd, hm } = split(local)
  const want = Date.UTC(ymd[0], ymd[1] - 1, ymd[2], Number(hm.slice(0, 2)), Number(hm.slice(3)))
  let t = want
  for (let i = 0; i < 3; i++) {
    const seen = localMs(new Date(t), timeZone)
    if (seen === want) break
    t += want - seen
  }
  return new Date(t)
}

/** conditions restricting a column to a range: dates by calendar day (an end with a time includes that day), datetimes by instant */
export function rangeCondition(col: string, kind: 'date' | 'datetime', r: DateRange, timeZone: string): ConditionV2 {
  if (kind === 'datetime') {
    return { and: [{ col, op: 'ge', value: { $datetime: zonedInstant(r.from, timeZone).toISOString() } }, { col, op: 'lt', value: { $datetime: zonedInstant(r.to, timeZone).toISOString() } }] }
  }
  const a = split(r.from), b = split(r.to)
  const end = b.hm === '00:00' ? b.ymd : addDays(b.ymd, 1)
  return { and: [{ col, op: 'ge', value: { $date: ymdText(a.ymd) } }, { col, op: 'lt', value: { $date: ymdText(end) } }] }
}

export function rangeLabel(r: DateRange | null): string {
  if (!r) return 'All time'
  const a = split(r.from), b = split(r.to)
  const end = b.hm === '00:00' ? addDays(b.ymd, -1) : b.ymd
  const day = (d: Ymd) => ymdText(d)
  return a.hm === '00:00' && b.hm === '00:00' ? (dayNumber(end) === dayNumber(a.ymd) ? day(a.ymd) : `${day(a.ymd)} to ${day(end)}`) : `${r.from.replace('T', ' ')} to ${r.to.replace('T', ' ')}`
}
