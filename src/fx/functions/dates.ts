import type { FxValue } from '@/contracts'
import { describe, toNumber } from '../values'
import { def, type CallCtx, type FnDef } from './types'

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
      case 'hours': return Math.floor(b.getTime() / 3600000) - Math.floor(a.getTime() / 3600000)
      case 'minutes': return Math.floor(b.getTime() / 60000) - Math.floor(a.getTime() / 60000)
      default: return Math.floor(b.getTime() / 1000) - Math.floor(a.getTime() / 1000)
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
]
