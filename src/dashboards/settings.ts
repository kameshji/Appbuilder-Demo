/**
 * The dashboard settings screen's logic (P2-C), pure: no React, DOM or packages; shared-code rules. The screen is
 * src/portal/dashboards/DashboardSettings.tsx over GET / PUT /dashboards/settings. The server keeps only valid values and
 * silently drops the rest, so the screen checks first and says what is wrong in plain English.
 *
 * A shift is stored as name, start and end (HH:MM); one that ends after midnight has an end earlier than its start. The screen
 * shows that as a box, "Ends the next day", and refuses a combination that does not match the times.
 */
import { isTimeZone } from '../fx/query/buckets.ts'
import type { CalendarSettings } from './dates.ts'

export interface SettingsValues extends CalendarSettings { locale: string; currency: string }
export interface ShiftDraft { name: string; start: string; end: string; nextDay: boolean }
export interface SettingsDraft { locale: string; currency: string; timeZone: string; fiscalYearStart: number; weekStart: 1 | 7; shifts: ShiftDraft[] }
export interface SettingsIssue { field: string; message: string }

export const MAX_SHIFTS = 6
export const MAX_SHIFT_NAME = 20
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const HM = /^([01]\d|2[0-3]):[0-5]\d$/
const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5))

export function draftOf(s: SettingsValues): SettingsDraft {
  return {
    locale: s.locale, currency: s.currency, timeZone: s.timeZone, fiscalYearStart: s.fiscalYearStart, weekStart: s.weekStart,
    shifts: s.shifts.map((x) => ({ name: x.name, start: x.start, end: x.end, nextDay: HM.test(x.start) && HM.test(x.end) && minutes(x.end) <= minutes(x.start) })),
  }
}

/** the values to send (call after `validateSettings` found no errors) */
export function valuesOf(d: SettingsDraft): SettingsValues {
  return {
    locale: d.locale.trim(), currency: d.currency.trim().toUpperCase(), timeZone: d.timeZone.trim(), fiscalYearStart: d.fiscalYearStart, weekStart: d.weekStart,
    shifts: d.shifts.map((x) => ({ name: x.name.trim(), start: x.start, end: x.end })),
  }
}

export const sameSettings = (a: SettingsDraft, b: SettingsDraft): boolean => JSON.stringify(valuesOf(a)) === JSON.stringify(valuesOf(b))

/** the minute intervals of a day a shift covers (one that ends after midnight covers the end and the start of the day) */
function covered(s: ShiftDraft): [number, number][] {
  const a = minutes(s.start), b = minutes(s.end)
  return a < b ? [[a, b]] : [[a, 1440], [0, b]]
}
const overlaps = (x: ShiftDraft, y: ShiftDraft): boolean => covered(x).some(([a, b]) => covered(y).some(([c, d]) => a < d && c < b))

/** problems in plain English. `errors` block saving (the server would drop the value); `warnings` do not. */
export function validateSettings(d: SettingsDraft): { errors: SettingsIssue[]; warnings: SettingsIssue[] } {
  const errors: SettingsIssue[] = []
  const warnings: SettingsIssue[] = []
  const err = (field: string, message: string) => errors.push({ field, message })

  const locale = d.locale.trim()
  if (!locale) err('locale', 'Enter a language and region code such as en-IN, en-US or de-DE.')
  else if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(locale)) err('locale', `"${locale}" is not a locale code. Use a code such as en-IN, en-US or de-DE.`)
  else { try { new Intl.NumberFormat(locale) } catch { err('locale', `This computer does not know the locale "${locale}". Use a code such as en-IN or en-US.`) } }

  const currency = d.currency.trim()
  if (!currency) err('currency', 'Enter a three-letter currency code such as INR, USD or EUR.')
  else if (!/^[A-Za-z]{3}$/.test(currency)) err('currency', `"${currency}" is not a currency code. Use exactly three letters, such as INR, USD or EUR.`)

  const tz = d.timeZone.trim()
  if (!tz) err('timeZone', 'Enter a time zone such as Asia/Kolkata or Europe/Berlin.')
  else if (!isTimeZone(tz)) err('timeZone', `"${tz}" is not a time zone name. Use a name such as Asia/Kolkata, Europe/Berlin or America/New_York.`)

  if (!Number.isInteger(d.fiscalYearStart) || d.fiscalYearStart < 1 || d.fiscalYearStart > 12) err('fiscalYearStart', 'Choose the month the fiscal year starts in.')
  if (d.weekStart !== 1 && d.weekStart !== 7) err('weekStart', 'Choose Monday or Sunday as the first day of the week.')

  if (d.shifts.length > MAX_SHIFTS) err('shifts', `There can be at most ${MAX_SHIFTS} shifts.`)
  const seen = new Set<string>()
  const ok: ShiftDraft[] = []
  d.shifts.forEach((s, i) => {
    const f = `shift:${i}`
    const name = s.name.trim()
    const label = name || `Shift ${i + 1}`
    let bad = false
    if (!name) { err(f, `Give shift ${i + 1} a name, such as A or Morning.`); bad = true }
    else if (name.length > MAX_SHIFT_NAME) { err(f, `${label}: the name is longer than ${MAX_SHIFT_NAME} characters.`); bad = true }
    else if (seen.has(name.toLowerCase())) { err(f, `Two shifts are called ${name}. Give each shift its own name.`); bad = true }
    seen.add(name.toLowerCase())
    if (!HM.test(s.start)) { err(f, `${label}: enter the start time.`); bad = true }
    if (!HM.test(s.end)) { err(f, `${label}: enter the end time.`); bad = true }
    if (!bad && HM.test(s.start) && HM.test(s.end)) {
      const a = minutes(s.start), b = minutes(s.end)
      if (a === b) { err(f, `${label} starts and ends at the same time. Change one of the times.`); bad = true }
      else if (!s.nextDay && b < a) { err(f, `${label} ends before it starts. Tick "Ends the next day" if it runs past midnight, or correct the times.`); bad = true }
      else if (s.nextDay && b > a) { err(f, `${label} is marked "Ends the next day", but its end time is later than its start time. Untick the box, or change the times.`); bad = true }
    }
    if (!bad) ok.push({ ...s, name })
  })
  for (let i = 0; i < ok.length; i++) for (let j = i + 1; j < ok.length; j++) {
    if (overlaps(ok[i]!, ok[j]!)) warnings.push({ field: 'shifts', message: `Shifts ${ok[i]!.name} and ${ok[j]!.name} overlap; "This shift" picks the first one in the list.` })
  }
  if (!d.shifts.length) warnings.push({ field: 'shifts', message: 'With no shifts, the date range "This shift" shows today.' })
  return { errors, warnings }
}

/** a short line for the list page / the screen: "Fiscal year from April, weeks start on Monday, 3 shifts, Asia/Kolkata" */
export function describeSettings(s: SettingsValues): string {
  const n = s.shifts.length
  return `Fiscal year from ${MONTH_NAMES[s.fiscalYearStart - 1] ?? '?'}, weeks start on ${s.weekStart === 7 ? 'Sunday' : 'Monday'}, ${n} ${n === 1 ? 'shift' : 'shifts'}, ${s.timeZone}`
}
