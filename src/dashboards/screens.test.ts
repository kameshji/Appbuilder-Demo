/**
 * Drill-through (drill.ts, checkDashboardDef, the editor's setDrill), viewer roles in words (access.ts) and the settings
 * screen's validation (settings.ts).
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_CALENDAR } from './dates.ts'
import type { DashboardDef, TileDef } from './types.ts'
import { checkDashboardDef } from './types.ts'
import { defaultDrillParams, describeDrill, drillFields, drillHash, drillValues, paramNameOf, paramText } from './drill.ts'
import { addMeasure, applyTile, editorColumns, removeValue, renameValue, setBucket, setDrill, setGroupBy, setTable, validateTile } from './editor.ts'
import { VIEWER_NOTE, alwaysSees, cleanRoles, missingRoles, toggleRole, viewerSummary } from './access.ts'
import type { SettingsDraft } from './settings.ts'
import { MAX_SHIFTS, describeSettings, draftOf, sameSettings, validateSettings, valuesOf } from './settings.ts'

const empty: DashboardDef = { version: 1, title: 'D', range: 'thisMonth', tiles: [] }
const cols = editorColumns([{ name: 'Machine', type: 'text' }, { name: 'Good', type: 'number' }, { name: 'LoggedOn', type: 'datetime' }])
const tile = (extra: Record<string, unknown> = {}): TileDef => ({
  id: 't1', title: 'Good by machine', kind: 'bar', layout: { x: 0, y: 0, w: 4, h: 3 },
  query: { table: 'Log', groupBy: ['Machine'], measures: [{ id: 'Good', label: 'Good qty', fn: 'sum', col: 'Good' }] }, ...extra,
} as TileDef)

describe('checkDashboardDef: drill-through', () => {
  const check = (drill: unknown) => checkDashboardDef({ ...empty, tiles: [tile({ drill })] }).tiles[0]!.drill
  it('old definitions without a drill are unchanged', () => {
    expect(checkDashboardDef({ ...empty, tiles: [tile()] }).tiles[0]).not.toHaveProperty('drill')
  })
  it('keeps a valid target and cleans it', () => {
    expect(check({ appId: 'app_1', params: [{ name: 'Machine', field: 'Machine' }], extra: 1 })).toEqual({ appId: 'app_1', params: [{ name: 'Machine', field: 'Machine' }] })
    expect(check({ appId: 'app_1', params: [] })).toEqual({ appId: 'app_1' })
    expect(check({ appId: 'app_1' })).toEqual({ appId: 'app_1' })
  })
  it('is strict: every malformed target is refused with a message', () => {
    for (const bad of ['x', 5, [], { appId: '' }, { appId: 'a b' }, { appId: 'a'.repeat(81) }, { appId: 'a', params: 'x' }, { appId: 'a', params: [{ name: '1x', field: 'F' }] },
      { appId: 'a', params: [{ name: 'p', field: '' }] }, { appId: 'a', params: [{ name: 'p', field: 'F' }, { name: 'P', field: 'G' }] },
      { appId: 'a', params: Array.from({ length: 9 }, (_, i) => ({ name: `p${i}`, field: 'F' })) }, { appId: 'a', params: [null] }]) {
      expect(() => check(bad), JSON.stringify(bad)).toThrow(/Tile t1/)
    }
  })
})

describe('drill values and address', () => {
  const drill = { appId: 'app_1', params: [{ name: 'Machine', field: 'Machine' }, { name: 'date', field: '__bucket' }, { name: 'qty', field: 'Good' }] }
  it('values as text; blanks and objects are not sent', () => {
    expect(paramText('Press 1')).toBe('Press 1')
    expect(paramText(12.5)).toBe('12.5')
    expect(paramText(0)).toBe('0')
    expect(paramText(false)).toBe('false')
    expect(paramText(null)).toBeNull()
    expect(paramText(undefined)).toBeNull()
    expect(paramText('')).toBeNull()
    expect(paramText({ a: 1 })).toBeNull()
    expect(paramText(new Date(2026, 2, 1))).toBe('2026-03-01')
    expect(paramText(new Date('2026-03-01T04:30:00.000Z'))).toBe('2026-03-01T04:30:00.000Z')
    expect(paramText(new Date('x'))).toBeNull()
  })
  it('the address is #u-<appId> with the clicked values; Param("name") reads them with URLSearchParams', () => {
    const h = drillHash(drill, { Machine: 'Press 1 & 2', __bucket: new Date(2026, 2, 1), Good: 40 })
    expect(h).toBe('#u-app_1?Machine=Press+1+%26+2&date=2026-03-01&qty=40')
    const q = new URLSearchParams(h.split('?')[1])
    expect(q.get('Machine')).toBe('Press 1 & 2')
    expect(q.get('date')).toBe('2026-03-01')
    expect(drillHash(drill, { Machine: null, Good: 1 })).toBe('#u-app_1?qty=1')
    expect(drillHash(drill)).toBe('#u-app_1')
    expect(drillHash({ appId: 'x' }, { Machine: 'a' })).toBe('#u-x')
    expect(drillValues(drill, { Machine: 'a' })).toEqual([['Machine', 'a']])
  })
  it('router: the id of #u-<appId>?... is the app id (query ignored)', async () => {
    const { parseRoute } = await import('../router.ts')
    expect(parseRoute(drillHash(drill, { Machine: 'a' }))).toEqual({ page: 'u', id: 'app_1' })
  })
})

describe('drill fields and defaults', () => {
  it('group columns, the date grouping, measures and calculations', () => {
    const t = setBucket(tile(), { col: 'LoggedOn', unit: 'day' })
    expect(drillFields(t).map((f) => f.field)).toEqual(['Machine', '__bucket', 'Good'])
    expect(defaultDrillParams(t)).toEqual([{ name: 'Machine', field: 'Machine' }])
    expect(defaultDrillParams(setGroupBy(t, []))).toEqual([{ name: 'date', field: '__bucket' }])
    expect(defaultDrillParams({ ...tile(), query: { table: 'Log', measures: [] } })).toEqual([])
    expect(drillFields({ id: 'x', title: '', kind: 'text', layout: tile().layout })).toEqual([])
  })
  it('parameter names are valid identifiers', () => {
    expect(paramNameOf('__bucket')).toBe('date')
    expect(paramNameOf('Order date')).toBe('Order_date')
    expect(paramNameOf('9lives')).toBe('p9lives')
    expect(paramNameOf('x'.repeat(60)).length).toBe(41)
  })
  it('the target in words', () => {
    expect(describeDrill({ appId: 'a' }, 'Orders app')).toBe('Clicking opens Orders app.')
    expect(describeDrill({ appId: 'a', params: [{ name: 'Machine', field: 'Machine' }] }, 'Orders app', (f) => `the ${f}`)).toBe('Clicking opens Orders app and passes the Machine as Machine; the app reads them with Param("Machine").')
  })
})

describe('the editor and drill-through', () => {
  const t0 = setTable(tile(), 'Log', cols)
  const withDrill = (): TileDef => setDrill(tile(), { appId: 'app_1', params: [{ name: 'Machine', field: 'Machine' }, { name: 'qty', field: 'Good' }] })
  it('setDrill sets and removes the target and keeps every other field', () => {
    const t = { ...tile(), futureTile: 1 } as TileDef
    const u = setDrill(t, { appId: 'a' })
    expect(u).toMatchObject({ futureTile: 1, drill: { appId: 'a' } })
    expect(setDrill(u, undefined)).toEqual(t)
  })
  it('unknown fields inside the drill target survive other operations and applyTile', () => {
    const t = setDrill(tile(), { appId: 'a', params: [{ name: 'Machine', field: 'Machine' }], future: 'x' } as never)
    const u = renameValue(addMeasure(t, cols[1]), 'Good', 'Qty')
    expect((u.drill as unknown as Record<string, unknown>).future).toBe('x')
    expect((applyTile(empty, u).tiles[0]!.drill as unknown as Record<string, unknown>).future).toBe('x')
  })
  it('a measure that is renamed or removed, a group column that goes: its parameter follows or is dropped', () => {
    expect(renameValue(withDrill(), 'Good', 'Qty').drill!.params).toEqual([{ name: 'Machine', field: 'Machine' }, { name: 'qty', field: 'Qty' }])
    expect(removeValue(withDrill(), 'Good').drill!.params).toEqual([{ name: 'Machine', field: 'Machine' }])
    const g = setGroupBy(withDrill(), [])
    expect(g.drill!.params).toEqual([{ name: 'qty', field: 'Good' }])
    expect(setGroupBy(setDrill(tile(), { appId: 'a', params: [{ name: 'Machine', field: 'Machine' }] }), []).drill).toEqual({ appId: 'a' })
    expect(setTable(withDrill(), 'Other', cols).drill).toEqual({ appId: 'app_1' })
    expect(t0.drill).toBeUndefined()
  })
  it('no-op operations return the same tile (identity)', () => {
    const t = withDrill()
    expect(setGroupBy(t, ['Machine']).drill).toBe(t.drill)
  })
  it('validation in plain words', () => {
    const colsOf = () => cols
    const ok = validateTile(withDrill(), colsOf, () => true)
    expect(ok.filter((i) => i.level === 'error')).toEqual([])
    expect(validateTile(setDrill(tile(), { appId: '' }), colsOf).map((i) => i.message)).toContain('Drill-through: choose the app to open.')
    expect(validateTile(setDrill(tile(), { appId: 'gone' }), colsOf, () => false).map((i) => i.message)).toContain('Drill-through: the app gone does not exist or you cannot run it.')
    expect(validateTile(setDrill(tile(), { appId: 'a', params: [{ name: 'p', field: 'Nope' }] }), colsOf).map((i) => i.message)).toContain('Drill-through: p passes Nope, which this tile does not produce.')
    expect(validateTile(setDrill(tile(), { appId: 'a', params: [{ name: '1', field: 'Machine' }] }), colsOf).some((i) => /cannot be a parameter name/.test(i.message))).toBe(true)
    expect(validateTile(setDrill(tile(), { appId: 'a', params: [{ name: 'p', field: 'Machine' }, { name: 'P', field: 'Good' }] }), colsOf).some((i) => /listed twice/.test(i.message))).toBe(true)
    const both = validateTile({ ...withDrill(), crossFilter: true }, colsOf, () => true)
    expect(both.find((i) => /filters the other tiles/.test(i.message))?.level).toBe('warning')
  })
})

describe('who can see a dashboard, in words', () => {
  const roles = [
    { id: 'r_admin', name: 'Administrator', isAdmin: true }, { id: 'r_maker', name: 'Maker', isMaker: true },
    { id: 'r_sup', name: 'Supervisor' }, { id: 'r_plan', name: 'Planner' }, { id: 'r_op', name: 'Operator' },
  ]
  it('no extra roles: only the owner, makers and administrators', () => {
    expect(viewerSummary([], roles)).toBe('Only the owner, makers and administrators can see this dashboard.')
    expect(viewerSummary(['r_admin', 'r_maker'], roles)).toBe('Only the owner, makers and administrators can see this dashboard.')
  })
  it('names the roles, singular and plural, in the order of the roles list', () => {
    expect(viewerSummary(['r_sup'], roles)).toBe('The owner, makers and administrators, and people with the role Supervisor, can see this dashboard.')
    expect(viewerSummary(['r_op', 'r_sup'], roles)).toBe('The owner, makers and administrators, and people with the roles Supervisor and Operator, can see this dashboard.')
    expect(viewerSummary(['r_op', 'r_plan', 'r_sup'], roles)).toBe('The owner, makers and administrators, and people with the roles Supervisor, Planner and Operator, can see this dashboard.')
    expect(viewerSummary(['gone'], roles)).toBe('Only the owner, makers and administrators can see this dashboard.')
    expect(VIEWER_NOTE).toMatch(/own access/)
  })
  it('clean, toggle, missing, always', () => {
    expect(cleanRoles(['r_op', 'gone', 'r_op', 'r_sup'], roles)).toEqual(['r_sup', 'r_op'])
    expect(toggleRole(['a'], 'b', true)).toEqual(['a', 'b'])
    expect(toggleRole(['a', 'b'], 'a', false)).toEqual(['b'])
    expect(toggleRole(['a'], 'a', true)).toEqual(['a'])
    expect(missingRoles(['r_sup', 'gone'], roles)).toBe(1)
    expect(roles.filter(alwaysSees).map((r) => r.id)).toEqual(['r_admin', 'r_maker'])
  })
})

describe('the settings screen', () => {
  const base = draftOf({ ...DEFAULT_CALENDAR, locale: 'en-IN', currency: 'INR' })
  const messages = (d: SettingsDraft) => validateSettings(d).errors.map((e) => e.message)
  const withShifts = (shifts: SettingsDraft['shifts']): SettingsDraft => ({ ...base, shifts })
  it('the defaults are valid; the shift C of the defaults ends the next day', () => {
    expect(validateSettings(base)).toEqual({ errors: [], warnings: [] })
    expect(base.shifts.map((s) => s.nextDay)).toEqual([false, false, true])
    expect(valuesOf(base)).toEqual({ ...DEFAULT_CALENDAR, locale: 'en-IN', currency: 'INR' })
    expect(describeSettings(valuesOf(base))).toBe('Fiscal year from April, weeks start on Monday, 3 shifts, Asia/Kolkata')
  })
  it('locale, currency, time zone, month, week in plain English', () => {
    expect(messages({ ...base, locale: '' })).toEqual(['Enter a language and region code such as en-IN, en-US or de-DE.'])
    expect(messages({ ...base, locale: 'english india' })[0]).toMatch(/is not a locale code/)
    expect(messages({ ...base, currency: 'RS' })[0]).toMatch(/exactly three letters/)
    expect(messages({ ...base, currency: '' })[0]).toMatch(/three-letter currency code/)
    expect(messages({ ...base, timeZone: 'Mars/Base' })[0]).toMatch(/"Mars\/Base" is not a time zone name/)
    expect(messages({ ...base, timeZone: '' })[0]).toMatch(/Enter a time zone/)
    expect(messages({ ...base, fiscalYearStart: 13 })).toEqual(['Choose the month the fiscal year starts in.'])
    expect(messages({ ...base, weekStart: 3 as never })).toEqual(['Choose Monday or Sunday as the first day of the week.'])
    expect(messages({ ...base, currency: 'usd', locale: ' de-DE ', timeZone: 'Europe/Berlin' })).toEqual([])
    expect(valuesOf({ ...base, currency: ' usd ', locale: ' de-DE ' })).toMatchObject({ currency: 'USD', locale: 'de-DE' })
  })
  it('shifts: names, times, past midnight', () => {
    const s = (name: string, start: string, end: string, nextDay = false) => ({ name, start, end, nextDay })
    expect(messages(withShifts([s('', '06:00', '14:00')]))).toEqual(['Give shift 1 a name, such as A or Morning.'])
    expect(messages(withShifts([s('A', '06:00', '14:00'), s('a', '14:00', '22:00')]))).toEqual(['Two shifts are called a. Give each shift its own name.'])
    expect(messages(withShifts([s('A', '', '14:00')]))).toEqual(['A: enter the start time.'])
    expect(messages(withShifts([s('A', '06:00', '')]))).toEqual(['A: enter the end time.'])
    expect(messages(withShifts([s('A', '06:00', '06:00')]))).toEqual(['A starts and ends at the same time. Change one of the times.'])
    expect(messages(withShifts([s('C', '22:00', '06:00')]))[0]).toMatch(/ends before it starts\. Tick "Ends the next day"/)
    expect(messages(withShifts([s('C', '22:00', '06:00', true)]))).toEqual([])
    expect(messages(withShifts([s('A', '06:00', '14:00', true)]))[0]).toMatch(/marked "Ends the next day", but its end time is later/)
    expect(messages(withShifts([s('x'.repeat(21), '06:00', '14:00')]))[0]).toMatch(/longer than 20 characters/)
    expect(messages(withShifts(Array.from({ length: MAX_SHIFTS + 1 }, (_, i) => s(`S${i}`, '01:00', '02:00'))))).toContain(`There can be at most ${MAX_SHIFTS} shifts.`)
    expect(valuesOf(withShifts([s(' C ', '22:00', '06:00', true)])).shifts).toEqual([{ name: 'C', start: '22:00', end: '06:00' }])
  })
  it('overlapping shifts and no shifts are warnings, not errors', () => {
    const s = (name: string, start: string, end: string, nextDay = false) => ({ name, start, end, nextDay })
    const a = validateSettings(withShifts([s('A', '06:00', '14:00'), s('B', '13:00', '22:00')]))
    expect(a.errors).toEqual([])
    expect(a.warnings[0]!.message).toMatch(/Shifts A and B overlap/)
    expect(validateSettings(withShifts([s('A', '06:00', '14:00'), s('C', '22:00', '07:00', true)])).warnings[0]!.message).toMatch(/Shifts A and C overlap/)
    expect(validateSettings(withShifts([s('A', '06:00', '14:00'), s('B', '14:00', '22:00'), s('C', '22:00', '06:00', true)])).warnings).toEqual([])
    expect(validateSettings(withShifts([])).warnings[0]!.message).toMatch(/With no shifts/)
  })
  it('detects changes', () => {
    expect(sameSettings(base, { ...base, currency: 'inr' })).toBe(true)
    expect(sameSettings(base, { ...base, fiscalYearStart: 1 })).toBe(false)
  })
})
