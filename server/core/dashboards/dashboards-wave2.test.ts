/**
 * Pure parts of the second wave (no database): what a view-token or snapshot request may choose (checkChoices), view
 * token format, and the snapshot PDF of the Production overview template computed with the reference executor.
 */
import { describe, expect, it } from 'vitest'
import type { FxRecord } from '../../../src/contracts.ts'
import type { QueryPlan, TableSchemaInfo } from '../../../src/platform/query.ts'
import { executePlan } from '../../../src/fx/query/reference.ts'
import { checkPlan } from '../../../src/fx/query/validate.ts'
import { productionOverview, sampleProduction } from '../../../src/dashboards/manufacturing.ts'
import { assemble, buildBatch } from '../../../src/dashboards/viewer.ts'
import { checkDashboardDef } from '../../../src/dashboards/types.ts'
import { DEFAULT_CALENDAR } from '../../../src/dashboards/dates.ts'
import { checkChoices } from './compute.ts'
import { newViewToken, parseViewToken } from './tokens.ts'
import { renderSnapshotPdf, snapshotBlocks } from './render.ts'

const def = checkDashboardDef(productionOverview())
const now = new Date('2026-11-19T10:30:00Z')

describe('checkChoices: a token or snapshot only parameterises the stored dashboard', () => {
  it('defaults to the dashboard range; presets, null and explicit ranges', () => {
    expect(checkChoices(def, {}, DEFAULT_CALENDAR, now)).toMatchObject({ range: { from: '2026-11-01T00:00', to: '2026-12-01T00:00' }, filters: {}, cross: null, now: '2026-11-19T16:00' })
    expect(checkChoices(def, { range: 'today' }, DEFAULT_CALENDAR, now).range).toEqual({ from: '2026-11-19T00:00', to: '2026-11-20T00:00' })
    expect(checkChoices(def, { range: null }, DEFAULT_CALENDAR, now).range).toBe(null)
    expect(checkChoices(def, { range: { from: '2026-01-01T00:00', to: '2026-02-01T00:00' } }, DEFAULT_CALENDAR, now).range).toEqual({ from: '2026-01-01T00:00', to: '2026-02-01T00:00' })
    expect(() => checkChoices(def, { range: 'forever' }, DEFAULT_CALENDAR, now)).toThrow(/Unknown date range/)
    expect(() => checkChoices(def, { range: { from: '2026-02-01T00:00', to: '2026-01-01T00:00' } }, DEFAULT_CALENDAR, now)).toThrow(/from before to/)
    expect(() => checkChoices(def, { range: { from: "2026-01-01'; drop", to: 'x' } }, DEFAULT_CALENDAR, now)).toThrow()
  })
  it('filters: only the dashboard\'s own, values among the options', () => {
    expect(checkChoices(def, { filters: { shift: 'B' } }, DEFAULT_CALENDAR, now).filters).toEqual({ shift: 'B' })
    expect(checkChoices(def, { filters: { shift: '' } }, DEFAULT_CALENDAR, now).filters).toEqual({})
    expect(() => checkChoices(def, { filters: { shift: 'Z' } }, DEFAULT_CALENDAR, now)).toThrow(/not one of the values/)
    expect(() => checkChoices(def, { filters: { Secret: 'x' } }, DEFAULT_CALENDAR, now)).toThrow(/no filter/)
    expect(() => checkChoices(def, { filters: { shift: { op: 'ne' } } }, DEFAULT_CALENDAR, now)).toThrow(/must be text/)
  })
  it('cross-filter: only from a tile that allows it, on one of its group columns', () => {
    expect(checkChoices(def, { cross: { tileId: 'machines', column: 'Machine', value: 'Sample press 2' } }, DEFAULT_CALENDAR, now).cross).toEqual({ tileId: 'machines', table: 'ProductionLog', column: 'Machine', value: 'Sample press 2' })
    expect(() => checkChoices(def, { cross: { tileId: 'pareto', column: 'Reason', value: 'Breakdown' } }, DEFAULT_CALENDAR, now)).toThrow(/allows it/)
    expect(() => checkChoices(def, { cross: { tileId: 'machines', column: 'Secret', value: 'x' } }, DEFAULT_CALENDAR, now)).toThrow(/group column/)
    expect(() => checkChoices(def, { cross: { tileId: 'machines', column: 'Machine', value: { $gt: 1 } } }, DEFAULT_CALENDAR, now)).toThrow(/value/)
  })
})

describe('view tokens', () => {
  it('carry the environment, a prefix and a 256-bit secret; malformed text never parses', () => {
    const t = newViewToken('sales_test')
    expect(t.token).toMatch(/^abv\.sales_test\.[A-Za-z0-9]{8}\.[A-Za-z0-9_-]{43}$/)
    expect(parseViewToken(t.token)).toEqual({ environmentId: 'sales_test', prefix: t.prefix })
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(t.hash).not.toContain(t.token.split('.')[3])
    for (const bad of ['', 'abk_12345678_' + 'x'.repeat(43), t.token + 'x', t.token.replace('abv.', 'abv.Bad-Env.'), t.token.slice(0, -1)]) expect(parseViewToken(bad)).toBe(null)
  })
})

describe('snapshot PDF', () => {
  it('draws the Production overview from rows computed as one identity', async () => {
    const { log, downtime } = sampleProduction(new Date('2026-11-19T10:30:00Z'), 30)
    const info = (cols: Record<string, string>): TableSchemaInfo => ({ columns: { id: 'text', createdOn: 'datetime', ...cols } })
    const L = info({ LoggedOn: 'datetime', Shift: 'text', Machine: 'text', Good: 'number', Scrap: 'number', PlannedMin: 'number', RunMin: 'number', IdealCycleSec: 'number' })
    const D = info({ StartedOn: 'datetime', Machine: 'text', Reason: 'text', Minutes: 'number' })
    const rec = (rows: Record<string, unknown>[], dates: string[]): FxRecord[] => rows.map((r, i) => ({ id: `r${i}`, createdOn: new Date(0), ...r, ...Object.fromEntries(dates.map((d) => [d, new Date(r[d] as string)])) }) as FxRecord)
    const L_ROWS = rec(log, ['LoggedOn'])
    const D_ROWS = rec(downtime, ['StartedOn'])
    const choices = checkChoices(def, {}, DEFAULT_CALENDAR, now)
    const cols = (t: string) => Object.keys((t === 'ProductionLog' ? L : D).columns)
    const { queries, errors } = buildBatch(def, { range: choices.range, filters: {}, cross: null, calendar: DEFAULT_CALENDAR, now: choices.now, columns: cols })
    const answers = queries.map((q) => {
      const p = q.plan as QueryPlan
      const i = p.table === 'ProductionLog' ? L : D
      return { id: q.id, ok: true, rows: executePlan(checkPlan(JSON.parse(JSON.stringify(p)), i, p.table).plan, p.table === 'ProductionLog' ? L_ROWS : D_ROWS, i).rows as Record<string, unknown>[], ms: 1 }
    })
    const tiles = assemble(def, { range: choices.range, calendar: DEFAULT_CALENDAR, now: choices.now }, answers, errors)
    tiles.scrap = { rows: [], error: 'Table "ProductionLog" does not exist.' }
    const input = { def, tiles, range: choices.range, calendar: DEFAULT_CALENDAR, defaults: { locale: 'en-IN', currency: 'INR', timeZone: 'Asia/Kolkata' }, asOf: '2026-11-19 16:00', note: 'the data Rita can see', createdOn: new Date(0) }
    const blocks = snapshotBlocks(input)
    // heading, description, range line, then the grid rows: 4 tiles side by side, 2 side by side, the full-width table
    expect(blocks.filter((b) => b.k === 'columns').map((b) => (b as { cols: unknown[] }).cols.length)).toEqual([4, 2])
    expect(JSON.stringify(blocks)).toContain('does not exist')
    const pdf = await renderSnapshotPdf(input)
    expect(pdf.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pdf.pages).toBeGreaterThanOrEqual(1)
    // deterministic with a fixed creation date
    expect((await renderSnapshotPdf(input)).bytes.equals(pdf.bytes)).toBe(true)
  }, 60_000)
})
