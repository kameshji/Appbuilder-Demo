/**
 * Kiosk cycling (P3-D), pure parts of src/dashboards/kiosk.ts: the address settings, the page split, the steps and the
 * clock-driven choice of the step (with a fake clock: nothing here waits, sleeps or reads the real time).
 */
import { describe, expect, it } from 'vitest'
import { CYCLE_DEFAULT_SECONDS, cycleAt, cycleFromHash, cycleQuery, cycleSteps, kioskAddress, pageDef, splitPages, tokenFromHash } from './kiosk.ts'
import type { CycleStep, KioskCycle } from './kiosk.ts'
import type { DashboardDef, TileDef } from './types.ts'

const TOKEN = `abv.default.Ab3dEf7h.${'x'.repeat(40)}_-Z`
const tile = (id: string, x: number, y: number, w = 4, h = 3): TileDef => ({ id, title: id, kind: 'kpi', layout: { x, y, w, h } })

describe('cycle settings in the address', () => {
  it('nothing cycles by default', () => {
    expect(cycleFromHash(`#u-kiosk?t=${TOKEN}`)).toBeNull()
    expect(cycleFromHash(`#u-kiosk?t=${TOKEN}&every=10`)).toBeNull()
    expect(cycleFromHash(`#u-kiosk?t=${TOKEN}&ranges=today`)).toBeNull()
    expect(cycleFromHash(`#u-kiosk?t=${TOKEN}&pages=1`)).toBeNull()
    expect(cycleFromHash('#u-dashboards?ranges=today,last7')).toBeNull()
    expect(cycleFromHash('#u-kiosk')).toBeNull()
  })
  it('reads ranges, pages and seconds, keeping only what the server accepts', () => {
    expect(cycleFromHash(`#u-kiosk?t=${TOKEN}&every=20&ranges=today,last7&pages=2`)).toEqual({ every: 20, ranges: ['today', 'last7'], pages: 2 })
    // unknown presets, duplicates and blanks are dropped; the token is still read
    expect(cycleFromHash(`#u-kiosk?t=${TOKEN}&ranges=today,nope,today,,last30&every=15`)).toEqual({ every: 15, ranges: ['today', 'last30'], pages: 1 })
    expect(tokenFromHash(`#u-kiosk?t=${TOKEN}&every=20&ranges=today,last7`)).toBe(TOKEN)
  })
  it('clamps the seconds (5 to 3600) and the pages (1 to 12); a missing or bad value is the default 30', () => {
    expect(cycleFromHash('#u-kiosk?pages=2&every=1')?.every).toBe(5)
    expect(cycleFromHash('#u-kiosk?pages=2&every=99999')?.every).toBe(3600)
    expect(cycleFromHash('#u-kiosk?pages=2')?.every).toBe(CYCLE_DEFAULT_SECONDS)
    expect(cycleFromHash('#u-kiosk?pages=2&every=abc')?.every).toBe(CYCLE_DEFAULT_SECONDS)
    expect(cycleFromHash('#u-kiosk?pages=99')?.pages).toBe(12)
    expect(cycleFromHash('#u-kiosk?pages=-3&ranges=today,last7')?.pages).toBe(1)
    expect(cycleFromHash(`#u-kiosk?ranges=${Array.from({ length: 15 }, (_, i) => ['today', 'yesterday', 'thisWeek', 'lastWeek', 'last7', 'thisMonth', 'lastMonth', 'last30', 'thisQuarter', 'last90', 'thisFiscalYear', 'last12Months', 'all', 'thisShift', 'fiscalYearToDate'][i]).join(',')}`)?.ranges.length).toBe(12)
  })
  it('the address builder and the parser agree; the token stays after # and out of the query string', () => {
    const c: KioskCycle = { every: 25, ranges: ['today', 'last7', 'thisMonth'], pages: 3 }
    const a = kioskAddress('https://apps.example.com', '/', TOKEN, c)
    expect(a).toBe(`https://apps.example.com/#u-kiosk?t=${TOKEN}&every=25&ranges=today,last7,thisMonth&pages=3`)
    expect(new URL(a).search).toBe('')
    expect(cycleFromHash(new URL(a).hash)).toEqual(c)
    expect(kioskAddress('https://x.example', '/', TOKEN, { every: 25, ranges: ['today'], pages: 1 })).toBe(`https://x.example/#u-kiosk?t=${TOKEN}`)
    expect(kioskAddress('https://x.example', '/', TOKEN, null)).toBe(`https://x.example/#u-kiosk?t=${TOKEN}`)
    expect(cycleQuery({ every: 1, ranges: [], pages: 2 })).toBe('&every=5&pages=2')
  })
})

describe('pages of tiles', () => {
  const tiles = [tile('a', 0, 0), tile('b', 4, 0), tile('c', 0, 3), tile('d', 0, 6), tile('e', 4, 6, 4, 3), tile('f', 0, 9)]
  it('one page (the dashboard as it is) unless asked and possible', () => {
    expect(splitPages(tiles, 1)).toEqual([tiles])
    expect(splitPages([tile('only', 0, 0)], 3)).toHaveLength(1)
    expect(splitPages([tile('a', 0, 0, 4, 6), tile('b', 4, 2, 4, 3)], 2)).toHaveLength(1) // overlapping rows stay together
  })
  it('splits into whole bands, balanced by height, each page starting at row 0 and keeping every tile once', () => {
    const p = splitPages(tiles, 2)
    expect(p).toHaveLength(2)
    expect(p.flat().map((t) => t.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    // bands: [a,b] 3 rows, [c] 3, [d,e] 3, [f] 3 -> two pages of two bands
    expect(p[0]!.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(p[1]!.map((t) => t.id)).toEqual(['d', 'e', 'f'])
    expect(p[1]!.map((t) => t.layout.y)).toEqual([0, 0, 3])
    expect(p[0]!.every((t) => t.layout.y >= 0)).toBe(true)
  })
  it('never more pages than bands; a tall band is not split', () => {
    expect(splitPages(tiles, 12)).toHaveLength(4)
    const p = splitPages([tile('x', 0, 0, 12, 9), tile('y', 0, 9), tile('z', 0, 12)], 2)
    expect(p.map((pg) => pg.map((t) => t.id))).toEqual([['x'], ['y', 'z']])
  })
  it('a page of the dashboard is the same definition with only that page\'s tiles', () => {
    const def: DashboardDef = { version: 1, title: 'T', range: 'today', tiles }
    const p = splitPages(tiles, 2)
    expect(pageDef(def, p, 1).tiles).toBe(p[1])
    expect(pageDef(def, p, 1).title).toBe('T')
    expect(pageDef(def, p, 9).tiles).toBe(p[1])
    expect(pageDef(def, [tiles], 0)).toBe(def)
  })
})

describe('steps and the clock', () => {
  const c: KioskCycle = { every: 10, ranges: ['today', 'last7'], pages: 2 }
  it('steps: each range, and inside it each page (pages follow what the dashboard really has)', () => {
    expect(cycleSteps(c, 2)).toEqual([{ range: 'today', page: 0 }, { range: 'today', page: 1 }, { range: 'last7', page: 0 }, { range: 'last7', page: 1 }])
    expect(cycleSteps(c, 1)).toEqual([{ range: 'today', page: 0 }, { range: 'last7', page: 0 }])
    expect(cycleSteps({ every: 10, ranges: [], pages: 2 }, 2)).toEqual([{ range: null, page: 0 }, { range: null, page: 1 }])
    expect(cycleSteps(null, 5)).toEqual([{ range: null, page: 0 }])
  })
  it('the step follows the clock: a fake clock moved by hand, including a late tick', () => {
    const steps = cycleSteps(c, 2)
    let now = 1_000_000
    const at = () => cycleAt(steps, 1_000_000, 10_000, now)
    expect(at()).toMatchObject({ index: 0, msToNext: 10_000 })
    now += 9_999; expect(at()).toMatchObject({ index: 0, msToNext: 1 })
    now += 1; expect(at()).toMatchObject({ index: 1, msToNext: 10_000 })
    now += 20_000; expect(at().index).toBe(3)
    now += 10_000; expect(at().index).toBe(0) // wraps
    now += 10_000 * 400 + 5_000; expect(at()).toMatchObject({ index: 0, msToNext: 5_000 }) // a screen that slept for a long time is not behind
    now = 500; expect(at().index).toBe(0) // a clock set back never goes negative
  })
  it('does not cycle with one step', () => {
    expect(cycleAt([{ range: null, page: 0 }], 0, 10_000, 99_999)).toEqual({ index: 0, wanted: 0, msToNext: Infinity })
  })
  it('keeps rotating through the steps it can draw when the network is down, and shows the wanted step as soon as it can', () => {
    const steps = cycleSteps(c, 2)
    const fetched = new Set<string>(['today']) // only "today" was ever loaded; "last7" never arrived
    const ok = (s: CycleStep) => fetched.has(String(s.range))
    const at = (ms: number) => cycleAt(steps, 0, 10_000, ms, ok)
    // slots 2 and 3 want "last7": each is skipped forward to the next step that can be drawn (today, page 0)
    expect([0, 10_000, 20_000, 30_000, 40_000, 50_000].map((ms) => at(ms).index)).toEqual([0, 1, 0, 0, 0, 1])
    expect(at(20_000)).toMatchObject({ wanted: 2, index: 0 })
    fetched.add('last7')
    expect([0, 10_000, 20_000, 30_000].map((ms) => at(ms).index)).toEqual([0, 1, 2, 3])
    expect(cycleAt(steps, 0, 10_000, 20_000, () => false)).toMatchObject({ index: 2, wanted: 2 }) // nothing drawable: the wanted step
  })
})
