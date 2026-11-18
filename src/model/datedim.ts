/**
 * Rows of a date dimension (pure): one per day from `from` to `to` (inclusive, at most 40 years), with calendar and
 * fiscal attributes. Fiscal year label "FY2026-27" when the year does not start in January (India: April), else "FY2026".
 */
import type { DateDimDef } from './types.ts'

export const MAX_DATE_DIM_DAYS = 366 * 40
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

export interface DateDimRow {
  Date: string
  DateKey: number
  Year: number
  Quarter: number
  Month: number
  MonthName: string
  Day: number
  /** 1 = Monday ... 7 = Sunday (ISO) */
  Weekday: number
  WeekdayName: string
  IsWeekend: boolean
  FiscalYear: string
  FiscalQuarter: number
  FiscalMonth: number
}

export function fiscalYearLabel(year: number, month: number, start: number): string {
  if (start === 1) return `FY${year}`
  const first = month >= start ? year : year - 1
  return `FY${first}-${String((first + 1) % 100).padStart(2, '0')}`
}

export function dateDimRows(def: DateDimDef): DateDimRow[] {
  const from = Date.parse(`${def.from}T00:00:00Z`)
  const to = Date.parse(`${def.to}T00:00:00Z`)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new Error('The date range is not valid.')
  const days = Math.round((to - from) / 86_400_000) + 1
  if (days > MAX_DATE_DIM_DAYS) throw new Error('A date dimension can cover at most 40 years.')
  const start = Math.min(12, Math.max(1, Math.trunc(def.fiscalYearStartMonth || 1)))
  const out: DateDimRow[] = []
  for (let i = 0; i < days; i++) {
    const d = new Date(from + i * 86_400_000)
    const y = d.getUTCFullYear()
    const mo = d.getUTCMonth() + 1
    const day = d.getUTCDate()
    const wd = ((d.getUTCDay() + 6) % 7) + 1
    const fm = ((mo - start + 12) % 12) + 1
    out.push({
      Date: `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      DateKey: y * 10000 + mo * 100 + day,
      Year: y, Quarter: Math.floor((mo - 1) / 3) + 1, Month: mo, MonthName: MONTHS[mo - 1], Day: day,
      Weekday: wd, WeekdayName: DAYS[wd - 1], IsWeekend: wd >= 6,
      FiscalYear: fiscalYearLabel(y, mo, start), FiscalQuarter: Math.floor((fm - 1) / 3) + 1, FiscalMonth: fm,
    })
  }
  return out
}
