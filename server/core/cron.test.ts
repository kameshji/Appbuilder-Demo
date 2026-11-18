import { describe, expect, it } from 'vitest'
import { CronError, checkTimeZone, describeCron, nextCron, parseCron } from './cron.ts'

const next = (expr: string, after: string, tz = 'UTC') => nextCron(parseCron(expr), new Date(after), tz)?.toISOString()

describe('cron', () => {
  it('parses fields, ranges, steps, lists and names', () => {
    const s = parseCron('*/15 9-17 * JAN,mar-may MON-FRI')
    expect([...s.minutes]).toEqual([0, 15, 30, 45])
    expect([...s.hours].length).toBe(9)
    expect([...s.months]).toEqual([1, 3, 4, 5])
    expect([...s.weekdays]).toEqual([1, 2, 3, 4, 5])
    expect([...parseCron('0 0 * * 7').weekdays]).toEqual([0])
    expect(parseCron('@daily').minutes.has(0)).toBe(true)
  })
  it('refuses malformed expressions with a clear message', () => {
    expect(() => parseCron('* * *')).toThrow(CronError)
    expect(() => parseCron('61 * * * *')).toThrow(/outside 0-59/)
    expect(() => parseCron('*/0 * * * *')).toThrow(/positive/)
    expect(() => parseCron('a * * * *')).toThrow(/not a number/)
    expect(() => checkTimeZone('Mars/Base')).toThrow(/not a time zone/)
  })
  it('finds the next slot strictly after a time', () => {
    expect(next('0 2 * * *', '2026-11-18T01:59:00Z')).toBe('2026-11-18T02:00:00.000Z')
    expect(next('0 2 * * *', '2026-11-18T02:00:00Z')).toBe('2026-11-19T02:00:00.000Z')
    expect(next('*/5 * * * *', '2026-11-18T10:03:20Z')).toBe('2026-11-18T10:05:00.000Z')
    expect(next('@monthly', '2026-11-18T10:00:00Z')).toBe('2026-12-01T00:00:00.000Z')
    expect(next('0 0 29 2 *', '2026-03-01T00:00:00Z', 'UTC')).toBe('2028-02-29T00:00:00.000Z')
    expect(next('0 0 30 2 *', '2026-03-01T00:00:00Z', 'UTC')).toBeUndefined()
    expect(next('30 9 * * MON', '2026-11-18T00:00:00Z')).toBe('2026-11-23T09:30:00.000Z')
  })
  it('day of month OR day of week when both are restricted', () => {
    // 1st of the month or a Friday
    expect(next('0 0 1 * FRI', '2026-11-18T00:00:00Z')).toBe('2026-11-20T00:00:00.000Z')
  })
  it('uses wall-clock time in a time zone', () => {
    // 02:00 in Kolkata (UTC+5:30) = 20:30 UTC the day before
    expect(next('0 2 * * *', '2026-11-18T00:00:00Z', 'Asia/Kolkata')).toBe('2026-11-18T20:30:00.000Z')
  })
  it('DST: a missing wall time is skipped, a repeated one fires once', () => {
    // Europe/Berlin springs forward 29 Mar 2026 02:00 -> 03:00: 02:30 does not exist that day
    expect(next('30 2 * * *', '2026-03-28T12:00:00Z', 'Europe/Berlin')).toBe('2026-03-30T00:30:00.000Z')
    // falls back 25 Oct 2026 03:00 -> 02:00: 02:30 happens twice; fire at the first (00:30 UTC), then next day
    const first = next('30 2 * * *', '2026-10-24T12:00:00Z', 'Europe/Berlin')
    expect(first).toBe('2026-10-25T00:30:00.000Z')
    expect(next('30 2 * * *', first!, 'Europe/Berlin')).toBe('2026-10-26T01:30:00.000Z')
  })
  it('describes common expressions', () => {
    expect(describeCron('0 2 * * *')).toBe('every day at 02:00')
    expect(describeCron('@hourly')).toBe('every hour')
  })
})
