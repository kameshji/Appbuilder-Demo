/**
 * Cron expressions for schedules (written here, no package): five fields "minute hour day-of-month month day-of-week",
 * each `*`, a number, a range `a-b`, a step `*\/n` or `a-b/n`, or a comma list of those; month and weekday names
 * (JAN..DEC, SUN..SAT); weekday 0 and 7 are Sunday. Shortcuts: @yearly @annually @monthly @weekly @daily @midnight
 * @hourly. When both day-of-month and day-of-week are restricted a day matches either (the classic cron rule).
 *
 * Times are wall-clock times in an IANA time zone (Intl). A wall time that does not exist (spring forward) is skipped;
 * one that happens twice (fall back) fires once, at its first occurrence.
 */

export interface CronSpec {
  source: string
  minutes: Set<number>
  hours: Set<number>
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  /** day-of-month field was "*" */
  anyDay: boolean
  /** day-of-week field was "*" */
  anyWeekday: boolean
}

export class CronError extends Error {}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const SHORTCUTS: Record<string, string> = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
}

function field(text: string, min: number, max: number, what: string, names?: string[], nameBase = 0): Set<number> {
  const out = new Set<number>()
  const num = (s: string): number => {
    const up = s.toUpperCase()
    if (names) {
      const i = names.indexOf(up)
      if (i >= 0) return i + nameBase
    }
    if (!/^\d+$/.test(s)) throw new CronError(`${what}: "${s}" is not a number`)
    return Number(s)
  }
  for (const part of text.split(',')) {
    if (!part) throw new CronError(`${what}: empty list item`)
    const [range, stepText] = part.split('/')
    if (part.split('/').length > 2) throw new CronError(`${what}: "${part}" has more than one step`)
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw new CronError(`${what}: the step in "${part}" must be a positive number`)
      step = Number(stepText)
    }
    let lo: number
    let hi: number
    if (range === '*') {
      lo = min
      hi = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-')
      lo = num(a)
      hi = num(b)
    } else {
      lo = num(range)
      hi = stepText !== undefined ? max : lo
    }
    if (lo < min || hi > max || lo > hi) throw new CronError(`${what}: "${part}" is outside ${min}-${max}`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

export function parseCron(expr: string): CronSpec {
  const src = String(expr ?? '').trim()
  const text = SHORTCUTS[src.toLowerCase()] ?? src
  const parts = text.split(/\s+/)
  if (parts.length !== 5) throw new CronError('A cron expression has five fields: minute hour day-of-month month day-of-week (for example "0 2 * * *").')
  const [mi, ho, dm, mo, dw] = parts
  const weekdays = field(dw, 0, 7, 'Day of week', DAYS)
  if (weekdays.has(7)) {
    weekdays.delete(7)
    weekdays.add(0)
  }
  return {
    source: src,
    minutes: field(mi, 0, 59, 'Minute'),
    hours: field(ho, 0, 23, 'Hour'),
    days: field(dm, 1, 31, 'Day of month'),
    months: field(mo, 1, 12, 'Month', MONTHS, 1),
    weekdays,
    anyDay: dm === '*',
    anyWeekday: dw === '*',
  }
}

/** a time zone Intl knows, else an error */
export function checkTimeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0)
    return tz
  } catch {
    throw new CronError(`"${tz}" is not a time zone (use an IANA name such as Asia/Kolkata or UTC).`)
  }
}

interface Wall { y: number; mo: number; d: number; h: number; mi: number; wd: number }
const formatters = new Map<string, Intl.DateTimeFormat>()
function wallTime(t: number, tz: string): Wall {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' })
    formatters.set(tz, f)
  }
  const p: Record<string, string> = {}
  for (const x of f.formatToParts(t)) p[x.type] = x.value
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), wd: DAYS.indexOf(p.weekday.toUpperCase().slice(0, 3)) }
}

const wallKey = (w: Wall): string => `${w.y}-${w.mo}-${w.d} ${w.h}:${w.mi}`
const MINUTE = 60_000

function dayMatches(s: CronSpec, w: Wall): boolean {
  const dom = s.days.has(w.d)
  const dow = s.weekdays.has(w.wd)
  if (s.anyDay && s.anyWeekday) return true
  if (s.anyDay) return dow
  if (s.anyWeekday) return dom
  return dom || dow
}

/**
 * The first slot strictly after `after` (a UTC instant) in time zone `tz`, or null when none within `horizonDays`.
 * Walks minute by minute but skips whole hours and days that cannot match, so a year costs a few thousand steps.
 */
export function nextCron(spec: CronSpec, after: Date, tz = 'UTC', horizonDays = 1500): Date | null {
  let t = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE
  const end = after.getTime() + horizonDays * 86_400_000
  const prevKey = wallKey(wallTime(after.getTime(), tz))
  while (t <= end) {
    const w = wallTime(t, tz)
    if (!spec.months.has(w.mo) || !dayMatches(spec, w)) {
      // towards the next wall-clock midnight; stop an hour short so a DST shift cannot jump past it
      const toMidnight = (23 - w.h) * 60 + (60 - w.mi)
      t += Math.max(1, toMidnight > 60 ? toMidnight - 60 : toMidnight) * MINUTE
      continue
    }
    if (!spec.hours.has(w.h)) {
      t += Math.max(1, 60 - w.mi) * MINUTE
      continue
    }
    if (spec.minutes.has(w.mi) && wallKey(w) !== prevKey) {
      // fall back: the same wall time an hour later in UTC is its second occurrence
      const earlier = wallTime(t - 3_600_000, tz)
      if (wallKey(earlier) !== wallKey(w)) return new Date(t)
    }
    t += MINUTE
  }
  return null
}

/** human summary for the admin console ("every day at 02:00", or the expression itself) */
export function describeCron(expr: string): string {
  const s = expr.trim().toLowerCase()
  const known: Record<string, string> = { '@hourly': 'every hour', '@daily': 'every day at 00:00', '@midnight': 'every day at 00:00', '@weekly': 'every Sunday at 00:00', '@monthly': 'on the 1st of every month', '@yearly': 'every 1 January', '@annually': 'every 1 January' }
  if (known[s]) return known[s]
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(s)
  if (m) return `every day at ${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`
  const h = /^(\d{1,2}) \* \* \* \*$/.exec(s)
  if (h) return `every hour at minute ${h[1]}`
  return expr
}
