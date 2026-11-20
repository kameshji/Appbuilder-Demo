/**
 * P2-C plan extensions in the reference executor and the validator: count distinct, date buckets (calendar, ISO and
 * Sunday weeks, fiscal years and quarters, time zones), groupOrder "key", top N with others. The same corpus runs on
 * PostgreSQL in server/connectors/postgres/query-v2-aggregates.integration.test.ts.
 */
import { describe, expect, it } from 'vitest'
import type { FxRecord } from '../../contracts.ts'
import type { QueryPlan, TableSchemaInfo } from '../../platform/query.ts'
import { executePlan, PlanError } from './reference.ts'
import { checkPlan } from './validate.ts'
import { bucketOfDate, bucketValue, fiscalYearStartOf, isoWeekday, nextBucket, zonedParts } from './buckets.ts'
import { aggregateCorpus } from './testdata-agg.ts'
import { SCHEMA, ticketRows } from './testdata.ts'

const S: TableSchemaInfo = { columns: { id: 'text', createdOn: 'datetime', City: 'text', Amount: 'number', Day: 'date', At: 'datetime', Ok: 'boolean' } }
const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, i))
const rows: FxRecord[] = [
  { id: 'a', createdOn: at(1), City: 'Pune', Amount: 10, Day: new Date(2026, 2, 31), At: new Date(Date.UTC(2026, 2, 31, 20, 0)), Ok: true },
  { id: 'b', createdOn: at(2), City: 'pune', Amount: 5, Day: new Date(2026, 3, 1), At: new Date(Date.UTC(2026, 3, 1, 1, 0)), Ok: false },
  { id: 'c', createdOn: at(3), City: 'Austin', Amount: 7, Day: new Date(2026, 3, 5), At: null, Ok: null },
  { id: 'd', createdOn: at(4), City: null, Amount: 1, Day: null, At: new Date(Date.UTC(2026, 11, 31, 23, 30)), Ok: true },
  { id: 'e', createdOn: at(5), City: '', Amount: null, Day: new Date(2027, 0, 1), At: null, Ok: false },
  { id: 'f', createdOn: at(6), City: 'Berlin', Amount: 20, Day: new Date(2026, 6, 15), At: null, Ok: true },
]
const run = (plan: Omit<QueryPlan, 'version' | 'table'>) => executePlan(checkPlan({ version: 2, table: 'T', ...plan }, S, 'T').plan, rows, S).rows

describe('date buckets (pure)', () => {
  it('calendar, week, fiscal units', () => {
    expect(bucketOfDate([2026, 11, 19], 'week')).toEqual([2026, 11, 16]) // Thursday -> Monday
    expect(bucketOfDate([2026, 11, 19], 'week', { weekStart: 7 })).toEqual([2026, 11, 15]) // -> Sunday
    expect(bucketOfDate([2026, 11, 15], 'week', { weekStart: 7 })).toEqual([2026, 11, 15])
    expect(bucketOfDate([2026, 11, 15], 'week')).toEqual([2026, 11, 9])
    expect(bucketOfDate([2026, 11, 19], 'quarter')).toEqual([2026, 10, 1])
    expect(bucketOfDate([2026, 3, 31], 'fiscalYear')).toEqual([2025, 4, 1])
    expect(bucketOfDate([2026, 4, 1], 'fiscalYear')).toEqual([2026, 4, 1])
    expect(bucketOfDate([2026, 1, 15], 'fiscalQuarter')).toEqual([2026, 1, 1])
    expect(bucketOfDate([2026, 3, 15], 'fiscalQuarter', { fiscalYearStart: 4 })).toEqual([2026, 1, 1])
    expect(bucketOfDate([2026, 5, 15], 'fiscalQuarter', { fiscalYearStart: 4 })).toEqual([2026, 4, 1])
    expect(bucketOfDate([2026, 12, 15], 'fiscalQuarter', { fiscalYearStart: 7 })).toEqual([2026, 10, 1])
    expect(bucketOfDate([2027, 2, 15], 'fiscalYear', { fiscalYearStart: 7 })).toEqual([2026, 7, 1])
    expect(bucketOfDate([2026, 2, 15], 'fiscalYear', { fiscalYearStart: 1 })).toEqual([2026, 1, 1])
    expect(fiscalYearStartOf([2026, 12, 1], 4)).toEqual([2026, 4, 1])
    expect(isoWeekday([2026, 11, 22])).toBe(7)
    expect(nextBucket([2026, 1, 31], 'month')).toEqual([2026, 2, 28])
    expect(nextBucket([2025, 4, 1], 'fiscalYear')).toEqual([2026, 4, 1])
  })
  it('time zones decide the calendar date of an instant', () => {
    const t = new Date(Date.UTC(2026, 2, 31, 20, 0))
    expect(zonedParts(t, 'UTC')).toEqual({ ymd: [2026, 3, 31], hour: 20 })
    expect(zonedParts(t, 'Asia/Kolkata')).toEqual({ ymd: [2026, 4, 1], hour: 1 })
    expect(zonedParts(t, 'America/Los_Angeles')).toEqual({ ymd: [2026, 3, 31], hour: 13 })
    expect(bucketValue(t, 'datetime', { unit: 'fiscalYear', timeZone: 'Asia/Kolkata' })).toEqual(new Date(2026, 3, 1))
    expect(bucketValue(t, 'datetime', { unit: 'fiscalYear', timeZone: 'UTC' })).toEqual(new Date(2025, 3, 1))
    expect(bucketValue(t, 'datetime', { unit: 'hour', timeZone: 'Asia/Kolkata' })).toBe(1)
    expect(bucketValue(null, 'date', { unit: 'day' })).toBe(null)
  })
})

describe('aggregate extensions (reference executor)', () => {
  it('count distinct: text ignoring case, NULLs not counted', () => {
    expect(run({ aggregate: { groupBy: [], measures: [{ name: 'D', fn: 'countDistinct', col: 'City' }, { name: 'B', fn: 'countDistinct', col: 'Ok' }, { name: 'Y', fn: 'countDistinct', col: 'Day' }] } })).toEqual([{ D: 4, B: 2, Y: 5 }])
  })
  it('groupOrder key: groups by key, NULL before "", smallest spelling', () => {
    const out = run({ aggregate: { groupBy: ['City'], measures: [{ name: 'N', fn: 'count' }], groupOrder: 'key' } })
    expect(out).toEqual([{ City: null, N: 1 }, { City: '', N: 1 }, { City: 'Austin', N: 1 }, { City: 'Berlin', N: 1 }, { City: 'Pune', N: 2 }])
    const first = run({ aggregate: { groupBy: ['City'], measures: [{ name: 'N', fn: 'count' }] } })
    expect(first.map((r) => r.City)).toEqual(['Pune', 'Austin', null, '', 'Berlin'])
  })
  it('fiscal year buckets of a date column and of a datetime column in a zone', () => {
    expect(run({ aggregate: { groupBy: [], buckets: [{ name: 'FY', col: 'Day', unit: 'fiscalYear' }], measures: [{ name: 'S', fn: 'sum', col: 'Amount' }], groupOrder: 'key' } }))
      .toEqual([{ FY: null, S: 1 }, { FY: new Date(2025, 3, 1), S: 10 }, { FY: new Date(2026, 3, 1), S: 32 }])
    expect(run({ aggregate: { groupBy: [], buckets: [{ name: 'FY', col: 'At', unit: 'fiscalYear', timeZone: 'Asia/Kolkata' }], measures: [{ name: 'N', fn: 'count' }], groupOrder: 'key' } }))
      .toEqual([{ FY: null, N: 3 }, { FY: new Date(2026, 3, 1), N: 3 }])
  })
  it('top n with others: exact measures over the rest, sorted by the measure', () => {
    const out = run({ aggregate: { groupBy: ['City'], measures: [{ name: 'S', fn: 'sum', col: 'Amount' }, { name: 'A', fn: 'avg', col: 'Amount' }, { name: 'D', fn: 'countDistinct', col: 'Ok' }], groupOrder: 'key', sort: [{ col: 'S', dir: 'desc' }], top: { n: 2, others: 'Others' } } })
    expect(out).toEqual([{ City: 'Berlin', S: 20, A: 20, D: 1 }, { City: 'Pune', S: 15, A: 7.5, D: 2 }, { City: 'Others', S: 8, A: 4, D: 2 }])
    // no others row when nothing is left
    expect(run({ aggregate: { groupBy: ['City'], measures: [{ name: 'N', fn: 'count' }], groupOrder: 'key', top: { n: 10, others: 'Others' } } })).toHaveLength(5)
    expect(run({ aggregate: { groupBy: ['City'], measures: [{ name: 'N', fn: 'count' }], groupOrder: 'key', top: { n: 0 } } })).toEqual([])
  })
  it('the validator refuses malformed extensions', () => {
    const bad = (aggregate: unknown) => expect(() => checkPlan({ version: 2, table: 'T', aggregate }, S, 'T')).toThrow(PlanError)
    bad({ groupBy: [], measures: [{ name: 'D', fn: 'countDistinct' }] })
    bad({ groupBy: [], measures: [{ name: 'D', fn: 'countDistinct', expr: { col: 'Amount' } }] })
    bad({ groupBy: [], buckets: [{ name: 'B', col: 'City', unit: 'month' }], measures: [] })
    bad({ groupBy: [], buckets: [{ name: 'B', col: 'Day', unit: 'hour' }], measures: [] })
    bad({ groupBy: [], buckets: [{ name: 'B', col: 'Day', unit: 'decade' }], measures: [] })
    bad({ groupBy: [], buckets: [{ name: 'B', col: 'Day', unit: 'fiscalYear', fiscalYearStart: 13 }], measures: [] })
    bad({ groupBy: [], buckets: [{ name: 'B', col: 'At', unit: 'day', timeZone: 'Mars/Olympus' }], measures: [] })
    bad({ groupBy: [], buckets: [{ name: 'B', col: 'At', unit: 'day', timeZone: "UTC'; DROP" }], measures: [] })
    bad({ groupBy: [], buckets: [{ name: 'N', col: 'Day', unit: 'day' }], measures: [{ name: 'N', fn: 'count' }] })
    bad({ groupBy: ['City'], measures: [], top: { n: 2 } })
    bad({ groupBy: ['City'], measures: [], groupOrder: 'key', top: { n: -1 } })
    bad({ groupBy: ['Amount'], measures: [], groupOrder: 'key', top: { n: 2, others: 'x' } })
    bad({ groupBy: ['City', 'Ok'], measures: [], groupOrder: 'key', top: { n: 2, others: 'x' } })
    bad({ groupBy: [], measures: [], groupOrder: 'random' })
  })
  it('the corpus is valid and runs (the PostgreSQL parity test runs the same plans)', () => {
    const plans = aggregateCorpus()
    expect(plans.length).toBeGreaterThan(250)
    const data = ticketRows()
    for (const p of plans) {
      const checked = checkPlan(JSON.parse(JSON.stringify(p)), SCHEMA.tables.Tickets!, 'Tickets').plan
      const res = executePlan(checked, [...data].reverse(), SCHEMA.tables.Tickets!)
      expect(Array.isArray(res.rows)).toBe(true)
    }
  })
})
