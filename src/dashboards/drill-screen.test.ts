/** Drill-through to a screen (P3-D): the address, its round trip through the runtime's parser, and the strict check. */
import { describe, expect, it } from 'vitest'
import { describeDrill, drillHash, paramNameOf } from './drill.ts'
import { checkDashboardDef, checkDrill } from './types.ts'
import type { DashboardDef, TileDrill } from './types.ts'
import { findStartScreen, parseStartHash, startPlan } from '../runtime/startparams.ts'
import { parseRoute } from '../router.ts'

const base: TileDrill = { appId: 'app_1', screen: 'Machine detail', params: [{ name: 'Machine', field: 'Machine' }, { name: 'date', field: '__bucket' }] }

describe('drill address with a screen', () => {
  it('puts the screen first, encoded, then the values', () => {
    expect(drillHash(base, { Machine: 'Press 1 & 2', __bucket: new Date(2026, 2, 1) })).toBe('#u-app_1?screen=Machine+detail&Machine=Press+1+%26+2&date=2026-03-01')
    expect(drillHash({ appId: 'app_1', screen: 'Orders' })).toBe('#u-app_1?screen=Orders')
    expect(drillHash({ appId: 'app_1', screen: '  ' })).toBe('#u-app_1')
    expect(drillHash({ appId: 'app_1' }, { Machine: 'x' })).toBe('#u-app_1')
  })
  it('a hand-made value named screen cannot override the screen', () => {
    const h = drillHash({ appId: 'a', screen: 'Orders', params: [{ name: 'Screen', field: 'S' }] }, { S: 'Admin' })
    expect(h).toBe('#u-a?screen=Orders')
  })
  it('the runtime parser reads back exactly what the builder wrote (round trip, odd characters)', () => {
    const row = { Machine: 'Ünïcode & "quotes" #1 ?x=y', __bucket: new Date(2026, 2, 1) }
    const a = parseStartHash(drillHash({ ...base, screen: 'Détail & more #2' }, row))
    expect(a).toEqual({ page: 'u', appId: 'app_1', screen: 'Détail & more #2', params: [['Machine', 'Ünïcode & "quotes" #1 ?x=y'], ['date', '2026-03-01']] })
  })
  it('the router still sees only the app: the query is for the app', () => {
    expect(parseRoute(drillHash(base, { Machine: 'a' }))).toEqual({ page: 'u', id: 'app_1' })
  })
  it('words for the tile editor', () => {
    expect(describeDrill({ appId: 'a', screen: 'Orders' }, 'Shop')).toBe('Clicking opens the screen "Orders" of Shop.')
    expect(describeDrill({ appId: 'a', screen: 'Orders', params: [{ name: 'M', field: 'Machine' }] }, 'Shop', (f) => `the ${f}`)).toBe('Clicking opens the screen "Orders" of Shop and passes the Machine as M; the app reads them with Param("M").')
    expect(describeDrill({ appId: 'a' }, 'Shop')).toBe('Clicking opens Shop.')
  })
  it('a column called Screen gets a parameter name that is not the reserved word', () => {
    expect(paramNameOf('Screen')).toBe('Screen_value')
    expect(paramNameOf('screen')).toBe('screen_value')
  })
})

describe('start plan (the runtime side)', () => {
  const screens = [{ id: 's1', name: 'Home' }, { id: 's2', name: 'Machine detail' }, { id: 's3', name: 'Orders' }]
  it('opens the named screen: by name, ignoring case and blanks, or by id', () => {
    expect(findStartScreen(screens, 'Machine detail')).toBe('s2')
    expect(findStartScreen(screens, ' machine DETAIL ')).toBe('s2')
    expect(findStartScreen(screens, 's3')).toBe('s3')
    expect(findStartScreen(screens, 'Nope')).toBeNull()
    expect(findStartScreen(screens, null)).toBeNull()
    expect(findStartScreen(screens, '')).toBeNull()
  })
  it('at app load: opens the screen and never restarts (the start has just run)', () => {
    expect(startPlan('#u-app_1?screen=Orders&Machine=P1', 'app_1', screens, 's1', true)).toEqual({ restart: false, open: 's3', unknown: null })
  })
  it('while the app is open: values restart it (its start formulas read them again), then the screen opens', () => {
    expect(startPlan('#u-app_1?screen=Orders&Machine=P1', 'app_1', screens, 's2', false)).toEqual({ restart: true, open: 's3', unknown: null })
    // a restart goes back to the first screen, so asking for it needs nothing more
    expect(startPlan('#u-app_1?screen=Home&Machine=P1', 'app_1', screens, 's3', false)).toEqual({ restart: true, open: null, unknown: null })
    // only a screen: no restart (the app keeps its state), and no push when it is already shown
    expect(startPlan('#u-app_1?screen=Orders', 'app_1', screens, 's2', false)).toEqual({ restart: false, open: 's3', unknown: null })
    expect(startPlan('#u-app_1?screen=Orders', 'app_1', screens, 's3', false)).toEqual({ restart: false, open: null, unknown: null })
  })
  it('an unknown screen opens the start screen (nothing pushed) and is reported; the values still apply', () => {
    expect(startPlan('#u-app_1?screen=Deleted', 'app_1', screens, 's1', true)).toEqual({ restart: false, open: null, unknown: 'Deleted' })
    expect(startPlan('#u-app_1?screen=Deleted&a=1', 'app_1', screens, 's2', false)).toEqual({ restart: true, open: null, unknown: 'Deleted' })
  })
  it('does nothing for other apps, plain addresses, other pages and the kiosk', () => {
    const none = { restart: false, open: null, unknown: null }
    expect(startPlan('#u-other?screen=Orders', 'app_1', screens, 's1', false)).toEqual(none)
    expect(startPlan('#u-app_1', 'app_1', screens, 's1', false)).toEqual(none)
    expect(startPlan('#u-app_1?', 'app_1', screens, 's1', false)).toEqual(none)
    expect(startPlan('#home?screen=Orders', 'app_1', screens, 's1', false)).toEqual(none)
    expect(startPlan('#u-kiosk?t=x&screen=Orders', 'kiosk', screens, 's1', false)).toEqual(none)
    expect(parseStartHash('#u-kiosk?t=x')).toBeNull()
  })
  it('the debug window address is read the same way', () => {
    expect(parseStartHash('#run-app_1?screen=Orders')).toEqual({ page: 'run', appId: 'app_1', screen: 'Orders', params: [] })
  })
})

describe('checkDashboardDef: the screen of a drill-through', () => {
  const def = (drill: unknown): DashboardDef => ({
    version: 1, title: 'T', range: 'all',
    tiles: [{ id: 't1', title: 'A', kind: 'kpi', layout: { x: 0, y: 0, w: 3, h: 3 }, query: { table: 'Orders', measures: [{ id: 'N', fn: 'count' }] }, drill } as never],
  })
  it('keeps a trimmed screen name', () => {
    expect(checkDashboardDef(def({ appId: 'app_1', screen: '  Orders  ' })).tiles[0]!.drill).toEqual({ appId: 'app_1', screen: 'Orders' })
    expect(checkDrill({ appId: 'a', screen: 'x'.repeat(80) }, 't').screen).toHaveLength(80)
  })
  it('refuses a screen that is not text, empty, too long or with control characters', () => {
    for (const bad of [5, {}, [], true, '', '   ', 'x'.repeat(81), 'a\nb', 'a\u0000b']) {
      expect(() => checkDashboardDef(def({ appId: 'app_1', screen: bad })), JSON.stringify(bad)).toThrow(/screen/i)
    }
  })
  it('refuses a value named screen (any case): it is the address\'s word for the screen', () => {
    for (const name of ['screen', 'Screen', 'SCREEN']) {
      expect(() => checkDashboardDef(def({ appId: 'app_1', params: [{ name, field: 'N' }] }))).toThrow(/screen/i)
    }
  })
  it('null or absent means the start screen; unknown fields of the target are dropped', () => {
    expect(checkDashboardDef(def({ appId: 'app_1', screen: null, extra: 1 })).tiles[0]!.drill).toEqual({ appId: 'app_1' })
  })
})
