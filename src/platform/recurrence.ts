/**
 * Recurring tasks (P3 package T, docs/plan/p3-spec.md 5.10): the value of the shared schedule fields
 * (src/portal/ScheduleFields.tsx, "repeat" layout) stored as JSON in Activities.Recurrence, and the arithmetic that turns
 * a completed task into the due time of the next one. Pure (no Node or DOM APIs beyond Intl): shared by the server (which
 * creates the next occurrence in the completing write), the client (text, preview) and the tests. Time is always civil
 * time in the rule's time zone: "every day at 09:00 Asia/Kolkata" stays 09:00 across daylight saving changes.
 *
 * Rule shape (the same field names as a scheduled report's schedule, so one component edits both):
 *   { frequency: 'daily' | 'weekly' | 'monthly', interval: 1..365, weekdays?: 0..6[] (weekly; 0 = Sunday), day?: 1..31
 *     (monthly; 31 means the last day of a shorter month), time: 'HH:MM', timeZone: IANA name, until?: 'YYYY-MM-DD' }
 *
 * Which occurrence comes next: counted from the due date of the task that was completed (from the completion day when it
 * had none), never from the day it was ticked off, so "every Monday" stays on Mondays when someone ticks late. Slots that
 * are already behind us (before today in the rule's zone) are skipped. After `until` there is no next occurrence.
 */

export const RECURRENCE_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number]

export interface RecurrenceRule {
  frequency: RecurrenceFrequency
  interval: number
  weekdays?: number[]
  day?: number
  time: string
  timeZone: string
  until?: string | null
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0)
    return true
  } catch {
    return false
  }
}

/** validates and normalises a stored or submitted rule; throws an Error with a plain-words message */
export function parseRecurrence(raw: unknown): RecurrenceRule {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      throw new Error('The repeat rule is not valid JSON.')
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('The repeat rule must be an object.')
  const o = v as Record<string, unknown>
  const frequency = o.frequency as RecurrenceFrequency
  if (!RECURRENCE_FREQUENCIES.includes(frequency)) throw new Error('Repeat every day, week or month.')
  const interval = o.interval === undefined ? 1 : o.interval
  if (!isInt(interval) || interval < 1 || interval > 365) throw new Error('"Every" must be a whole number from 1 to 365.')
  const time = o.time === undefined || o.time === null || o.time === '' ? '09:00' : String(o.time)
  const tm = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time)
  if (!tm) throw new Error('The time must be HH:MM (24 hours).')
  const timeZone = o.timeZone === undefined || o.timeZone === null || o.timeZone === '' ? 'UTC' : String(o.timeZone)
  if (!validTimeZone(timeZone)) throw new Error(`"${timeZone.slice(0, 60)}" is not a time zone.`)
  const out: RecurrenceRule = { frequency, interval, time, timeZone }
  if (frequency === 'weekly' && o.weekdays !== undefined && o.weekdays !== null) {
    if (!Array.isArray(o.weekdays) || o.weekdays.length > 7 || !o.weekdays.every((d) => isInt(d) && d >= 0 && d <= 6)) throw new Error('Weekdays are numbers from 0 (Sunday) to 6 (Saturday).')
    const days = [...new Set(o.weekdays as number[])].sort((a, b) => a - b)
    if (days.length) out.weekdays = days
  }
  if (frequency === 'monthly' && o.day !== undefined && o.day !== null) {
    if (!isInt(o.day) || o.day < 1 || o.day > 31) throw new Error('The day of the month must be from 1 to 31.')
    out.day = o.day
  }
  if (o.until !== undefined && o.until !== null && o.until !== '') {
    const u = String(o.until).slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(u) || Number.isNaN(Date.parse(`${u}T00:00:00Z`))) throw new Error('"Until" must be a date (YYYY-MM-DD).')
    out.until = u
  }
  return out
}

/** the rule in plain words ("Every 2 weeks on Mon, Thu at 09:00 until 2027-06-30") */
export function describeRecurrence(r: RecurrenceRule): string {
  const n = r.interval
  const unit = r.frequency === 'daily' ? 'day' : r.frequency === 'weekly' ? 'week' : 'month'
  let s = n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`
  if (r.frequency === 'weekly' && r.weekdays?.length) s += ` on ${r.weekdays.map((d) => WEEKDAY_SHORT[d]).join(', ')}`
  if (r.frequency === 'monthly' && r.day) s += r.day >= 31 ? ' on the last day' : ` on day ${r.day}`
  s += ` at ${r.time}`
  if (r.until) s += ` until ${r.until}`
  return s
}

/* ------------------------------------------------------------------ civil time in a zone */

interface Civil { y: number; m: number; d: number }

const formatters = new Map<string, Intl.DateTimeFormat>()
function zoneFormat(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formatters.set(tz, f)
  }
  return f
}

/** the civil date and time of an instant in a zone */
export function civilIn(at: Date, tz: string): Civil & { hh: number; mm: number } {
  const p = zoneFormat(tz).formatToParts(at)
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value)
  return { y: g('year'), m: g('month'), d: g('day'), hh: g('hour') % 24, mm: g('minute') }
}

/** the instant of a civil date and time in a zone (a time skipped by a daylight change moves forward) */
export function zonedInstant(c: Civil, hh: number, mm: number, tz: string): Date {
  const wall = Date.UTC(c.y, c.m - 1, c.d, hh, mm)
  let guess = wall
  for (let i = 0; i < 3; i++) {
    const k = civilIn(new Date(guess), tz)
    const seen = Date.UTC(k.y, k.m - 1, k.d, k.hh, k.mm)
    const diff = wall - seen
    if (diff === 0) break
    guess += diff
  }
  return new Date(guess)
}

const daysIn = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate()
const addDays = (c: Civil, n: number): Civil => {
  const t = new Date(Date.UTC(c.y, c.m - 1, c.d + n))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}
const weekday = (c: Civil): number => new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay()
const key = (c: Civil): number => c.y * 10000 + c.m * 100 + c.d

/** the civil date of the slot after `from` (strictly later) */
function nextSlot(r: RecurrenceRule, from: Civil, anchorDay: number): Civil {
  if (r.frequency === 'daily') return addDays(from, r.interval)
  if (r.frequency === 'weekly') {
    const days = r.weekdays?.length ? r.weekdays : [weekday(from)]
    const wd = weekday(from)
    const later = days.find((d) => d > wd)
    if (later !== undefined) return addDays(from, later - wd)
    // next period: the Sunday that starts the week `interval` weeks on, then the first chosen weekday
    return addDays(from, -wd + 7 * r.interval + days[0])
  }
  const total = from.y * 12 + (from.m - 1) + r.interval
  const y = Math.floor(total / 12)
  const m = (total % 12) + 1
  return { y, m, d: Math.min(r.day ?? anchorDay, daysIn(y, m)) }
}

/**
 * The due time of the occurrence after one due at `dueOn` (null: it had no due date, so count from today in the rule's
 * zone), or null when the rule has ended (`until`). `now` is injected (tests, the completing write's clock).
 */
export function nextDue(rule: RecurrenceRule, dueOn: Date | null, now: Date): Date | null {
  const [hh, mm] = rule.time.split(':').map(Number)
  const today = civilIn(now, rule.timeZone)
  const anchor = dueOn ? civilIn(dueOn, rule.timeZone) : today
  let cur: Civil = { y: anchor.y, m: anchor.m, d: anchor.d }
  const anchorDay = cur.d
  for (let i = 0; i < 800; i++) {
    cur = nextSlot(rule, cur, anchorDay)
    if (key(cur) < key(today)) continue // a slot that is already behind us is skipped
    if (rule.until && key(cur) > Number(rule.until.replace(/-/g, ''))) return null
    return zonedInstant(cur, hh, mm, rule.timeZone)
  }
  return null
}
