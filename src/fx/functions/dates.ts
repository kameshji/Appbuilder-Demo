import type { FxValue } from '../../contracts.ts'
import { describe, toNumber } from '../values.ts'
import { def, type CallCtx, type FnDef } from './types.ts'

export function parseDateText(s: string): Date | null {
  const t = s.trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const ms = Date.parse(t)
  return Number.isNaN(ms) ? null : new Date(ms)
}

function dateArg(c: CallCtx, i: number): Date | null {
  const v: FxValue = c.value(i)
  if (v === null) return null
  if (v instanceof Date) return v
  if (typeof v === 'string') {
    const d = parseDateText(v)
    if (d) return d
    return c.fail(i, `Can't turn ${describe(v)} into a date`)
  }
  return c.fail(i, `Can't use ${describe(v)} as a date`)
}

/** Date text including a time part. Local time unless the text says otherwise. */
export function parseDateTimeText(s: string): Date | null {
  const t = s.trim()
  const d = parseDateText(t)
  if (d) return d
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0))
  return null
}

function dateTimeArg(c: CallCtx, i: number): Date | null {
  const v: FxValue = c.value(i)
  if (v === null || v === '') return null
  if (v instanceof Date) return v
  if (typeof v === 'string') {
    const d = parseDateTimeText(v)
    if (d) return d
    return c.fail(i, `Can't turn ${describe(v)} into a date`)
  }
  return c.fail(i, `Can't use ${describe(v)} as a date`)
}

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dow = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - dow)
  const y0 = Date.UTC(t.getUTCFullYear(), 0, 1)
  return Math.ceil(((t.getTime() - y0) / 86400000 + 1) / 7)
}

const UNITS = ['days', 'months', 'years', 'hours', 'minutes', 'seconds', 'quarters', 'weeks'] as const
type Unit = (typeof UNITS)[number]

function unitArg(c: CallCtx, i: number): Unit {
  const raw = c.text(i).trim().toLowerCase()
  const u = (raw.endsWith('s') ? raw : raw + 's') as Unit
  if (!UNITS.includes(u)) return c.fail(i, `Unknown unit: ${c.text(i)}. Use Days, Months, Years, Hours or Minutes`)
  return u
}

function addMonths(d: Date, n: number): Date {
  const r = new Date(d.getTime())
  const day = r.getDate()
  r.setDate(1)
  r.setMonth(r.getMonth() + n)
  const dim = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate()
  r.setDate(Math.min(day, dim))
  return r
}

export function addDays(d: Date, n: number): Date {
  const whole = Math.trunc(n)
  const r = new Date(d.getTime())
  r.setDate(r.getDate() + whole)
  const frac = n - whole
  if (frac) r.setTime(r.getTime() + frac * 86400000)
  return r
}

function dayNumber(d: Date): number {
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000)
}

export const dateFns: FnDef[] = [
  def('Now', 'Now()', 'The current date and time.', 0, 0, () => new Date()),
  def('Today', 'Today()', 'Today at midnight.', 0, 0, () => {
    const n = new Date()
    return new Date(n.getFullYear(), n.getMonth(), n.getDate())
  }),
  def('DateAdd', 'DateAdd(date, amount, unit)', 'Adds to a date. Unit is "Days", "Months", "Years", "Hours" or "Minutes".', 3, 3, (c) => {
    const d = dateArg(c, 0)
    if (d === null) return null
    const n = toNumber(c.value(1), c.argNode(1))
    const u = unitArg(c, 2)
    switch (u) {
      case 'days': return addDays(d, n)
      case 'weeks': return addDays(d, n * 7)
      case 'months': return addMonths(d, Math.trunc(n))
      case 'quarters': return addMonths(d, Math.trunc(n) * 3)
      case 'years': return addMonths(d, Math.trunc(n) * 12)
      case 'hours': return new Date(d.getTime() + n * 3600000)
      case 'minutes': return new Date(d.getTime() + n * 60000)
      default: return new Date(d.getTime() + n * 1000)
    }
  }),
  def('DateDiff', 'DateDiff(start, end [, unit])', 'Whole units from start to end. Unit defaults to Days.', 2, 3, (c) => {
    const a = dateArg(c, 0)
    const b = dateArg(c, 1)
    if (a === null || b === null) return null
    const u = c.argc > 2 ? unitArg(c, 2) : 'days'
    const months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth())
    switch (u) {
      case 'days': return dayNumber(b) - dayNumber(a)
      case 'weeks': return Math.trunc((dayNumber(b) - dayNumber(a)) / 7)
      case 'months': return months
      case 'quarters': return Math.trunc(months / 3)
      case 'years': return b.getFullYear() - a.getFullYear()
      // Boundaries are counted on the local clock (not UTC), so half-hour time zones such as IST agree.
      case 'hours': return Math.floor(localMs(b) / 3600000) - Math.floor(localMs(a) / 3600000)
      case 'minutes': return Math.floor(localMs(b) / 60000) - Math.floor(localMs(a) / 60000)
      default: return Math.floor(localMs(b) / 1000) - Math.floor(localMs(a) / 1000)
    }
  }),
  def('Date', 'Date(year, month, day)', 'Builds a date. Months and days may overflow into the next month or year.', 3, 3, (c) => {
    const y = Math.trunc(c.num(0))
    const d = new Date(2000, 0, 1)
    d.setFullYear(y, Math.trunc(c.num(1)) - 1, Math.trunc(c.num(2)))
    d.setHours(0, 0, 0, 0)
    return d
  }),
  def('Year', 'Year(date)', 'The year of a date.', 1, 1, (c) => dateArg(c, 0)?.getFullYear() ?? null),
  def('Month', 'Month(date)', 'The month of a date, 1 to 12.', 1, 1, (c) => {
    const d = dateArg(c, 0)
    return d ? d.getMonth() + 1 : null
  }),
  def('Day', 'Day(date)', 'The day of the month.', 1, 1, (c) => dateArg(c, 0)?.getDate() ?? null),
  def('Hour', 'Hour(date)', 'The hour, 0 to 23.', 1, 1, (c) => dateArg(c, 0)?.getHours() ?? null),
  def('Minute', 'Minute(date)', 'The minute, 0 to 59.', 1, 1, (c) => dateArg(c, 0)?.getMinutes() ?? null),
  def('Weekday', 'Weekday(date [, type])', 'Day of the week. Type 1 (default): Sunday = 1. Type 2: Monday = 1. Type 3: Monday = 0.', 1, 2, (c) => {
    const d = dateArg(c, 0)
    if (!d) return null
    const type = c.argc > 1 ? Math.trunc(c.num(1)) : 1
    const dow = d.getDay()
    if (type === 2) return dow === 0 ? 7 : dow
    if (type === 3) return dow === 0 ? 6 : dow - 1
    return dow + 1
  }),
  def('Second', 'Second(date)', 'The second, 0 to 59.', 1, 1, (c) => dateArg(c, 0)?.getSeconds() ?? null),
  def('Time', 'Time(hour, minute, second)', 'Today at the given time. Values may overflow into the next day.', 3, 3, (c) => {
    const n = new Date()
    n.setHours(Math.trunc(c.num(0)), Math.trunc(c.num(1)), Math.trunc(c.num(2)), 0)
    return n
  }),
  def('DateValue', 'DateValue(text [, language])', 'Turns text such as "2024-03-05" into a date (time removed).', 1, 2, (c) => {
    const d = dateTimeArg(c, 0)
    return d ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : null
  }),
  def('DateTimeValue', 'DateTimeValue(text [, language])', 'Turns text such as "2024-03-05 14:30" into a date and time.', 1, 2, (c) => dateTimeArg(c, 0)),
  def('TimeValue', 'TimeValue(text [, language])', 'Turns text such as "2:30 PM" or "14:30:15" into a time (on today\'s date).', 1, 2, (c) => {
    const v = c.value(0)
    if (v === null) return null
    if (v instanceof Date) return v
    if (typeof v !== 'string') return c.fail(0, `Can't use ${describe(v)} as a time`)
    const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([ap]m?)?\s*$/i.exec(v)
    if (m) {
      let h = Number(m[1])
      const mer = m[4]?.toLowerCase()
      if (mer) {
        if (h < 1 || h > 12) return c.fail(0, `Can't turn ${describe(v)} into a time`)
        h = (h % 12) + (mer.startsWith('p') ? 12 : 0)
      }
      if (h > 23 || Number(m[2]) > 59 || Number(m[3] ?? 0) > 59) return c.fail(0, `Can't turn ${describe(v)} into a time`)
      const n = new Date()
      n.setHours(h, Number(m[2]), Number(m[3] ?? 0), 0)
      return n
    }
    const d = parseDateTimeText(v)
    if (d && /\d:\d/.test(v)) return d
    return c.fail(0, `Can't turn ${describe(v)} into a time`)
  }),
  def('EDate', 'EDate(date, months)', 'The same day some months earlier or later (clamped to the end of a short month).', 2, 2, (c) => {
    const d = dateArg(c, 0)
    return d ? addMonths(d, Math.trunc(c.num(1))) : null
  }),
  def('EOMonth', 'EOMonth(date, months)', 'The last day of the month, some months earlier or later.', 2, 2, (c) => {
    const d = dateArg(c, 0)
    if (!d) return null
    const r = addMonths(new Date(d.getFullYear(), d.getMonth(), 1), Math.trunc(c.num(1)))
    return new Date(r.getFullYear(), r.getMonth() + 1, 0)
  }),
  def('WeekNum', 'WeekNum(date [, startOfWeek])', 'Week of the year. Week 1 holds 1 January. Start of week: 1 Sunday (default), 2 Monday, 11-17 Monday..Sunday, 21 ISO 8601 weeks.', 1, 2, (c) => {
    const d = dateArg(c, 0)
    if (!d) return null
    const sw = c.argc > 1 ? Math.trunc(c.num(1)) : 1
    if (sw === 21) return isoWeek(d)
    let startDow: number
    if (sw === 1) startDow = 0
    else if (sw === 2) startDow = 1
    else if (sw >= 11 && sw <= 17) startDow = (sw - 10) % 7
    else return c.fail(1, 'Start of week must be 1, 2, 11 to 17 or 21')
    const jan1 = new Date(d.getFullYear(), 0, 1)
    const offset = (jan1.getDay() - startDow + 7) % 7
    const dayOfYear = dayNumber(d) - dayNumber(jan1)
    return Math.floor((dayOfYear + offset) / 7) + 1
  }),
  def('IsToday', 'IsToday(date)', 'True when the date is today.', 1, 1, (c) => {
    const d = dateArg(c, 0)
    if (!d) return false
    const n = new Date()
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  }),
]

/** Milliseconds since the epoch as read on the local clock. */
function localMs(d: Date): number {
  return d.getTime() - d.getTimezoneOffset() * 60000
}
