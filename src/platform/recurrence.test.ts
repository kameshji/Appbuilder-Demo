/**
 * Recurrence arithmetic (P3-T): the next due time of a repeating task, in the rule's time zone, from the completed task's
 * due date, with an injected clock. Also validation of the stored rule and its plain-words description.
 */
import { describe, expect, it } from 'vitest'
import { civilIn, describeRecurrence, nextDue, parseRecurrence, zonedInstant } from './recurrence.ts'
import type { RecurrenceRule } from './recurrence.ts'

const IST = 'Asia/Kolkata'
const rule = (r: Partial<RecurrenceRule> & Pick<RecurrenceRule, 'frequency'>): RecurrenceRule => parseRecurrence({ interval: 1, time: '09:00', timeZone: IST, ...r })
const at = (iso: string) => new Date(iso)
const local = (d: Date | null, tz = IST) => (d ? (({ y, m, d: dd, hh, mm }) => `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`)(civilIn(d, tz)) : null)

describe('nextDue', () => {
  const NOW = at('2026-11-20T04:00:00Z') // 09:30 on 20 Nov in Kolkata

  it('every day: the day after the due date, at the rule\'s time', () => {
    expect(local(nextDue(rule({ frequency: 'daily' }), at('2026-11-20T03:30:00Z'), NOW))).toBe('2026-11-21 09:00')
  })

  it('every 3 days counts from the due date, not from the day it was ticked off', () => {
    expect(local(nextDue(rule({ frequency: 'daily', interval: 3 }), at('2026-11-19T03:30:00Z'), NOW))).toBe('2026-11-22 09:00')
  })

  it('slots already behind us are skipped (completed a week late)', () => {
    expect(local(nextDue(rule({ frequency: 'daily' }), at('2026-11-10T03:30:00Z'), NOW))).toBe('2026-11-20 09:00')
    expect(local(nextDue(rule({ frequency: 'weekly', weekdays: [1] }), at('2026-11-02T03:30:00Z'), NOW))).toBe('2026-11-23 09:00')
  })

  it('without a due date it counts from today in the rule\'s zone', () => {
    expect(local(nextDue(rule({ frequency: 'daily' }), null, NOW))).toBe('2026-11-21 09:00')
  })

  it('weeks on weekdays: the next chosen weekday this week, else the first one `interval` weeks on', () => {
    const r = rule({ frequency: 'weekly', weekdays: [1, 4] }) // Mon, Thu
    expect(local(nextDue(r, at('2026-11-16T03:30:00Z'), at('2026-11-16T04:00:00Z')))).toBe('2026-11-19 09:00') // Mon -> Thu
    expect(local(nextDue(r, at('2026-11-19T03:30:00Z'), at('2026-11-19T04:00:00Z')))).toBe('2026-11-23 09:00') // Thu -> Mon
    const biweekly = rule({ frequency: 'weekly', interval: 2, weekdays: [1, 4] })
    expect(local(nextDue(biweekly, at('2026-11-19T03:30:00Z'), at('2026-11-19T04:00:00Z')))).toBe('2026-11-30 09:00') // Thu -> Mon two weeks on
  })

  it('weekly without weekdays repeats on the weekday of the due date', () => {
    expect(local(nextDue(rule({ frequency: 'weekly' }), at('2026-11-18T03:30:00Z'), at('2026-11-18T04:00:00Z')))).toBe('2026-11-25 09:00')
  })

  it('months on a day: short months use their last day; 31 means the last day', () => {
    const r = rule({ frequency: 'monthly', day: 31 })
    expect(local(nextDue(r, at('2026-01-31T03:30:00Z'), at('2026-01-31T04:00:00Z')))).toBe('2026-02-28 09:00')
    expect(local(nextDue(r, at('2026-02-28T03:30:00Z'), at('2026-02-28T04:00:00Z')))).toBe('2026-03-31 09:00')
    expect(local(nextDue(r, at('2027-01-31T03:30:00Z'), at('2027-01-31T04:00:00Z')))).toBe('2027-02-28 09:00')
    expect(local(nextDue(rule({ frequency: 'monthly', interval: 3, day: 15 }), at('2026-11-15T03:30:00Z'), at('2026-11-15T04:00:00Z')))).toBe('2027-02-15 09:00')
  })

  it('until: no occurrence after it, the last day included', () => {
    const r = rule({ frequency: 'daily', until: '2026-11-21' })
    expect(local(nextDue(r, at('2026-11-20T03:30:00Z'), NOW))).toBe('2026-11-21 09:00')
    expect(nextDue(r, at('2026-11-21T03:30:00Z'), at('2026-11-21T04:00:00Z'))).toBeNull()
  })

  it('keeps the wall-clock time across a daylight saving change', () => {
    const ny = rule({ frequency: 'daily', timeZone: 'America/New_York' })
    // 7 Mar 2026 is the day before the clocks go forward in New York: the next 09:00 is only 23 hours later
    const next = nextDue(ny, zonedInstant({ y: 2026, m: 3, d: 7 }, 9, 0, 'America/New_York'), at('2026-03-07T15:00:00Z'))
    expect(local(next, 'America/New_York')).toBe('2026-03-08 09:00')
    expect(next!.getTime() - zonedInstant({ y: 2026, m: 3, d: 7 }, 9, 0, 'America/New_York').getTime()).toBe(23 * 3600_000)
  })
})

describe('parseRecurrence / describeRecurrence', () => {
  it('normalises, sorts weekdays, takes JSON text', () => {
    expect(parseRecurrence('{"frequency":"weekly","interval":2,"weekdays":[4,1,1],"time":"07:30","timeZone":"UTC","until":"2027-06-30"}')).toEqual({ frequency: 'weekly', interval: 2, weekdays: [1, 4], time: '07:30', timeZone: 'UTC', until: '2027-06-30' })
    expect(parseRecurrence({ frequency: 'daily' })).toEqual({ frequency: 'daily', interval: 1, time: '09:00', timeZone: 'UTC' })
  })

  it('refuses nonsense in plain words', () => {
    expect(() => parseRecurrence({ frequency: 'hourly' })).toThrow(/day, week or month/)
    expect(() => parseRecurrence({ frequency: 'daily', interval: 0 })).toThrow(/1 to 365/)
    expect(() => parseRecurrence({ frequency: 'daily', time: '25:00' })).toThrow(/HH:MM/)
    expect(() => parseRecurrence({ frequency: 'daily', timeZone: 'Mars/Base' })).toThrow(/time zone/)
    expect(() => parseRecurrence({ frequency: 'weekly', weekdays: [7] })).toThrow(/Weekdays/)
    expect(() => parseRecurrence({ frequency: 'monthly', day: 32 })).toThrow(/1 to 31/)
    expect(() => parseRecurrence({ frequency: 'daily', until: 'tomorrow' })).toThrow(/Until/)
    expect(() => parseRecurrence('{nope')).toThrow(/JSON/)
    expect(() => parseRecurrence([])).toThrow(/object/)
  })

  it('describes a rule', () => {
    expect(describeRecurrence(rule({ frequency: 'weekly', interval: 2, weekdays: [1, 4], until: '2027-06-30' }))).toBe('Every 2 weeks on Mon, Thu at 09:00 until 2027-06-30')
    expect(describeRecurrence(rule({ frequency: 'monthly', day: 31 }))).toBe('Every month on the last day at 09:00')
    expect(describeRecurrence(rule({ frequency: 'daily' }))).toBe('Every day at 09:00')
  })
})
