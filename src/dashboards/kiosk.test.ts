/**
 * The kiosk page's pure parts (src/dashboards/kiosk.ts) and a source check of the page itself: the token is read only
 * from the URL fragment, the page's requests omit cookies and never carry the CSRF or environment header, and nothing
 * writes the token to browser storage, the console or the tab title.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { blocksData, isKioskHash, kioskAddress, kioskRefreshMs, kioskRetryMs, kioskTiles, problemOf, tokenFromHash } from './kiosk.ts'
import type { DashboardDef } from './types.ts'
import { DEFAULT_CALENDAR } from './dates.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const TOKEN = `abv.default.Ab3dEf7h.${'x'.repeat(40)}_-Z`

describe('kiosk address and token', () => {
  it('reads the token from the fragment only, and only when it is shaped like a view token', () => {
    expect(isKioskHash('#u-kiosk')).toBe(true)
    expect(isKioskHash('#u-kiosk?t=1')).toBe(true)
    expect(isKioskHash('#u-kiosks')).toBe(false)
    expect(isKioskHash('#u-dashboards?d=x')).toBe(false)
    expect(tokenFromHash(`#u-kiosk?t=${TOKEN}`)).toBe(TOKEN)
    expect(tokenFromHash(`#u-kiosk?t=${encodeURIComponent(TOKEN)}&theme=dark`)).toBe(TOKEN)
    expect(tokenFromHash('#u-kiosk')).toBeNull()
    expect(tokenFromHash('#u-kiosk?t=abv.default.short.x')).toBeNull()
    expect(tokenFromHash(`#u-other?t=${TOKEN}`)).toBeNull()
    expect(tokenFromHash(`#u-kiosk?t=${TOKEN}x`)).toBeNull()
  })
  it('the screen address carries the token after # and never in a query string', () => {
    const a = kioskAddress('https://apps.example.com/', '/', TOKEN)
    expect(a).toBe(`https://apps.example.com/#u-kiosk?t=${TOKEN}`)
    const u = new URL(a)
    expect(u.search).toBe('')
    expect(u.hash).toContain(TOKEN)
    expect(tokenFromHash(u.hash)).toBe(TOKEN)
  })
})

describe('kiosk timing and problems', () => {
  it('refreshes on the dashboard interval, else every minute', () => {
    expect(kioskRefreshMs({ refreshSeconds: 30 })).toBe(30_000)
    expect(kioskRefreshMs({ refreshSeconds: 0 })).toBe(60_000)
    expect(kioskRefreshMs({})).toBe(60_000)
    expect(kioskRefreshMs({ refreshSeconds: 5 })).toBe(60_000)
  })
  it('retries quietly with backoff, honouring Retry-After', () => {
    expect(kioskRetryMs(1)).toBe(10_000)
    expect(kioskRetryMs(2)).toBe(20_000)
    expect(kioskRetryMs(20)).toBe(120_000)
    expect(kioskRetryMs(1, 7)).toBe(7_000)
  })
  it('revoked / expired / wrong, no access and deleted clear the data; offline and busy keep it', () => {
    expect(problemOf(401)).toBe('invalid')
    expect(problemOf(403)).toBe('no-access')
    expect(problemOf(404)).toBe('gone')
    expect(problemOf(429)).toBe('busy')
    expect(problemOf(null)).toBe('offline')
    expect(problemOf(500)).toBe('server')
    expect(['invalid', 'no-access', 'gone', 'no-token'].every((p) => blocksData(p as never))).toBe(true)
    expect(['offline', 'busy', 'server'].some((p) => blocksData(p as never))).toBe(false)
  })
})

describe('kioskTiles', () => {
  it('turns the server answers into tile rows like the viewer (date buckets become dates, measures numbers)', () => {
    const def: DashboardDef = {
      version: 1, title: 'T', range: 'all', tiles: [
        { id: 'k', title: 'Count', kind: 'kpi', layout: { x: 0, y: 0, w: 3, h: 3 }, query: { table: 'Orders', measures: [{ id: 'N', fn: 'count' }] } },
        { id: 'bad', title: 'Bad', kind: 'kpi', layout: { x: 3, y: 0, w: 3, h: 3 }, query: { table: 'Orders', measures: [{ id: 'N', fn: 'count' }] } },
        { id: 'c', title: 'Broken', kind: 'kpi', layout: { x: 6, y: 0, w: 3, h: 3 }, query: { table: 'Orders', measures: [{ id: 'N', fn: 'count' }] } },
      ],
    }
    const tiles = kioskTiles(def, DEFAULT_CALENDAR, {
      dashboardId: 'd', range: null, now: '2026-11-20T10:00', ms: 3,
      results: [{ id: 'k:main', ok: true, rows: [{ N: '42' }], filtered: true, ms: 1 }, { id: 'bad:main', ok: false, ms: 1, error: { status: 403, message: 'Hidden column.' } }],
      errors: { c: 'Does not compile.' },
    })
    expect(tiles.k).toMatchObject({ rows: [{ N: 42 }], filtered: true })
    expect(tiles.bad).toMatchObject({ error: 'Hidden column.', status: 403 })
    expect(tiles.c).toMatchObject({ error: 'Does not compile.' })
  })
})

describe('the kiosk page source', () => {
  const page = fs.readFileSync(path.join(here, '..', 'portal', 'dashboards', 'KioskPage.tsx'), 'utf8')
  const lib = fs.readFileSync(path.join(here, 'kiosk.ts'), 'utf8')
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  it('fetches without cookies and without the CSRF or environment header, with the token only in Authorization', () => {
    const c = code(page)
    expect(c).toContain("credentials: 'omit'")
    expect(c).toContain("cache: 'no-store'")
    expect(c).toContain('Authorization: `Bearer ${token}`')
    expect(c).not.toMatch(/CSRF_HEADER|X-Appbuilder|environmentHeaders|credentials: 'same-origin'|credentials: 'include'/)
    expect(c).not.toMatch(/dashboardsApi|@\/platform'/)
    // the only fetch is kioskFetch, to the two kiosk routes
    expect([...c.matchAll(/kioskFetch<[^>]+>\(token, '(GET|POST)', '([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`).sort()).toEqual(['GET /dashboards/kiosk', 'POST /dashboards/kiosk/query'])
    expect(c.match(/\bfetch\(/g)).toHaveLength(1)
  })
  it('never writes the token to storage, the console, the tab title or a URL', () => {
    for (const c of [code(page), code(lib)]) {
      expect(c).not.toMatch(/localStorage|sessionStorage|indexedDB|console\./)
      expect(c).not.toMatch(/document\.title\s*=\s*[^\n]*token/i)
      expect(c).not.toMatch(/history\.(push|replace)State/)
    }
    // the page builds no address with the token (only kioskAddress does, for the token screen, with the token after #)
    expect(code(page)).not.toMatch(/[?&]t=\$\{|location\.(href|search)\s*=/)
  })
})
