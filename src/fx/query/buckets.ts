/**
 * Date bucketing of Query v2 aggregates (P2-C, docs/dev/query-v2.md section 6b): the pure calendar arithmetic shared by
 * the reference executor, the dashboards' period logic and the tests. The PostgreSQL builder computes the same values
 * in SQL (server/connectors/postgres/query-v2.ts bucketSql).
 *
 * Calendar dates are handled as [year, month (1-12), day] triples; no Date arithmetic in a local time zone, so DST never
 * shifts a bucket.
 */
import type { BucketV2, DateBucketUnit } from '../../platform/query.ts'

export type Ymd = [number, number, number]

const DAY = 86_400_000

/** output kind of a bucket (same as bucketKind in src/platform/query.ts; src/fx imports only types from there) */
export const bucketOutputKind = (unit: DateBucketUnit): 'date' | 'number' => (unit === 'weekday' || unit === 'hour' ? 'number' : 'date')

/** days since 1970-01-01 of a calendar date */
export const dayNumber = ([y, m, d]: Ymd): number => Math.round(Date.UTC(y, m - 1, d) / DAY)
export function fromDayNumber(n: number): Ymd {
  const t = new Date(n * DAY)
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]
}
export const addDays = (d: Ymd, n: number): Ymd => fromDayNumber(dayNumber(d) + n)
/** 1 = Monday .. 7 = Sunday */
export const isoWeekday = (d: Ymd): number => ((new Date(Date.UTC(d[0], d[1] - 1, d[2])).getUTCDay() + 6) % 7) + 1
export const ymdText = ([y, m, d]: Ymd): string => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
export function parseYmd(s: string): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
export function addMonths([y, m, d]: Ymd, n: number): Ymd {
  const total = y * 12 + (m - 1) + n
  const ny = Math.floor(total / 12)
  const nm = (total % 12 + 12) % 12 + 1
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
  return [ny, nm, Math.min(d, last)]
}

const fmtCache = new Map<string, Intl.DateTimeFormat>()
/** calendar date and hour of an instant in an IANA time zone */
export function zonedParts(t: Date, timeZone = 'UTC'): { ymd: Ymd; hour: number } {
  if (timeZone === 'UTC' || timeZone === 'Etc/UTC') return { ymd: [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()], hour: t.getUTCHours() }
  let f = fmtCache.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23' })
    fmtCache.set(timeZone, f)
  }
  const p: Record<string, number> = {}
  for (const x of f.formatToParts(t)) if (x.type !== 'literal') p[x.type] = Number(x.value)
  return { ymd: [p.year!, p.month!, p.day!], hour: p.hour! % 24 }
}

/** a valid IANA zone name this runtime knows */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** first day of the fiscal year holding `d` */
export function fiscalYearStartOf([y, m]: Ymd, start: number): Ymd {
  return [m >= start ? y : y - 1, start, 1]
}

/** the bucket of a calendar date: its first day (date units) or a number (weekday) */
export function bucketOfDate(d: Ymd, unit: DateBucketUnit, o: { fiscalYearStart?: number; weekStart?: 1 | 7 } = {}): Ymd | number {
  const fy = o.fiscalYearStart ?? 4
  switch (unit) {
    case 'day': return d
    case 'week': {
      const wd = isoWeekday(d)
      return addDays(d, -(o.weekStart === 7 ? wd % 7 : wd - 1))
    }
    case 'month': return [d[0], d[1], 1]
    case 'quarter': return [d[0], Math.floor((d[1] - 1) / 3) * 3 + 1, 1]
    case 'year': return [d[0], 1, 1]
    case 'fiscalYear': return fiscalYearStartOf(d, fy)
    case 'fiscalQuarter': {
      const [fyY] = fiscalYearStartOf(d, fy)
      const fm = (d[1] - fy + 12) % 12
      const sm = ((fy - 1 + Math.floor(fm / 3) * 3) % 12) + 1
      return [sm >= fy ? fyY : fyY + 1, sm, 1]
    }
    case 'weekday': return isoWeekday(d)
    case 'hour': return 0
  }
}

/**
 * The bucket value of a cell as the reference executor holds it: a date cell is a Date at local midnight, a datetime
 * cell an instant. Returns null for NULL, a Date at local midnight for date units, a number for weekday / hour.
 */
export function bucketValue(cell: unknown, kind: 'date' | 'datetime', b: Pick<BucketV2, 'unit' | 'fiscalYearStart' | 'weekStart' | 'timeZone'>): Date | number | null {
  if (!(cell instanceof Date) || Number.isNaN(cell.getTime())) return null
  let ymd: Ymd
  let hour = 0
  if (kind === 'date') ymd = [cell.getFullYear(), cell.getMonth() + 1, cell.getDate()]
  else {
    const z = zonedParts(cell, b.timeZone ?? 'UTC')
    ymd = z.ymd
    hour = z.hour
  }
  if (b.unit === 'hour') return hour
  const v = bucketOfDate(ymd, b.unit, b)
  if (typeof v === 'number') return v
  return new Date(v[0], v[1] - 1, v[2])
}

/** the next bucket start after `start` (date units), for gap filling and period arithmetic */
export function nextBucket(start: Ymd, unit: DateBucketUnit): Ymd {
  switch (unit) {
    case 'day': return addDays(start, 1)
    case 'week': return addDays(start, 7)
    case 'month': return addMonths(start, 1)
    case 'quarter': case 'fiscalQuarter': return addMonths(start, 3)
    case 'year': case 'fiscalYear': return addMonths(start, 12)
    default: return addDays(start, 1)
  }
}
