/**
 * The kiosk / TV page's pure parts (P2-C; docs/dev/dashboards.md "Kiosk page"). No React, no DOM, no network: the page
 * (src/portal/dashboards/KioskPage.tsx) uses them, and src/dashboards/kiosk.test.ts tests them.
 *
 * The address is `<origin><path>#u-kiosk?t=<token>`: the token is in the URL FRAGMENT, which browsers never send to the
 * server (not in access logs, proxy logs or Referer headers). It is never put in a query string.
 */
import type { DashboardDef, TileDef } from './types.ts'
import { RANGE_PRESETS } from './dates.ts'
import type { CalendarSettings, DateRange, RangePreset } from './dates.ts'
import { assemble, buildBatch } from './viewer.ts'
import type { BatchAnswer, TileData } from './viewer.ts'
import { rowsFromWire } from '../platform/query-wire.ts'
import type { QueryValue } from '../platform/http.ts'

export const KIOSK_ROUTE = 'u-kiosk'
const TOKEN_RE = /^abv\.[a-z][a-z0-9_]{0,39}\.[A-Za-z0-9]{8}\.[A-Za-z0-9_-]{43}$/

/** is this address the kiosk page? (`#u-kiosk` with or without `?...`) */
export function isKioskHash(hash: string): boolean {
  return /^#u-kiosk(\?|$)/.test(hash)
}

/** the token of a kiosk address, or null when there is none or it is not shaped like a view token */
export function tokenFromHash(hash: string): string | null {
  if (!isKioskHash(hash)) return null
  const i = hash.indexOf('?')
  if (i < 0) return null
  let t: string | null = null
  try { t = new URLSearchParams(hash.slice(i + 1)).get('t') } catch { return null }
  t = (t ?? '').trim()
  return TOKEN_RE.test(t) ? t : null
}

/** the address to open on the screen (origin and path of this install, the token after `#`, then the cycle settings if any) */
export function kioskAddress(origin: string, pathname: string, token: string, cycle?: KioskCycle | null): string {
  return `${origin.replace(/\/$/, '')}${pathname || '/'}#${KIOSK_ROUTE}?t=${encodeURIComponent(token)}${cycle ? cycleQuery(cycle) : ''}`
}

/* ------------------------------------------------------------------------------------------------ cycling (P3-D) */

/**
 * Cycling. A kiosk address may ask the screen to rotate, every N seconds, through a list of date ranges (the server's own
 * presets, sent as the `range` the kiosk query route already accepts) and / or through "pages" of the dashboard's tiles
 * (split on the screen, nothing is asked of the server for them). The settings are part of the address fragment (not of
 * the token): `#u-kiosk?t=<token>&every=30&ranges=today,last7&pages=2`. Without them nothing cycles. Nothing here widens
 * what a token may do: it is still one dashboard, one account, and the server validates every range exactly as before.
 */
export interface KioskCycle {
  /** seconds on each step (5 to 3600) */
  every: number
  /** date range presets, at most 12; empty: the dashboard's own range */
  ranges: RangePreset[]
  /** pages the tiles are split into (1 to 12; the screen may use fewer when the dashboard has fewer rows of tiles) */
  pages: number
}
export const CYCLE_MIN_SECONDS = 5
export const CYCLE_MAX_SECONDS = 3600
export const CYCLE_MAX_RANGES = 12
export const CYCLE_MAX_PAGES = 12
export const CYCLE_DEFAULT_SECONDS = 30

const PRESET_KEYS = new Set<string>(RANGE_PRESETS.map((p) => p.key))

/** the cycle settings of an address, or null when there is nothing to cycle (no ranges list and fewer than two pages) */
export function cycleFromHash(hash: string): KioskCycle | null {
  if (!isKioskHash(hash)) return null
  const i = hash.indexOf('?')
  if (i < 0) return null
  let q: URLSearchParams
  try { q = new URLSearchParams(hash.slice(i + 1)) } catch { return null }
  const ranges: RangePreset[] = []
  for (const r of (q.get('ranges') ?? '').split(',')) {
    const k = r.trim()
    if (PRESET_KEYS.has(k) && !ranges.includes(k as RangePreset) && ranges.length < CYCLE_MAX_RANGES) ranges.push(k as RangePreset)
  }
  const p = Math.floor(Number(q.get('pages') ?? '1'))
  const pages = Number.isFinite(p) ? Math.min(CYCLE_MAX_PAGES, Math.max(1, p)) : 1
  if (ranges.length < 2 && pages < 2) return null
  const e = Math.floor(Number(q.get('every') ?? CYCLE_DEFAULT_SECONDS))
  const every = Number.isFinite(e) ? Math.min(CYCLE_MAX_SECONDS, Math.max(CYCLE_MIN_SECONDS, e)) : CYCLE_DEFAULT_SECONDS
  return { every, ranges, pages }
}

/** `&every=30&ranges=today,last7&pages=2` (what an address carries after the token); empty when nothing cycles */
export function cycleQuery(c: KioskCycle): string {
  const ranges = c.ranges.filter((r, i) => PRESET_KEYS.has(r) && c.ranges.indexOf(r) === i).slice(0, CYCLE_MAX_RANGES)
  const pages = Math.min(CYCLE_MAX_PAGES, Math.max(1, Math.floor(c.pages || 1)))
  if (ranges.length < 2 && pages < 2) return ''
  const every = Math.min(CYCLE_MAX_SECONDS, Math.max(CYCLE_MIN_SECONDS, Math.floor(c.every || CYCLE_DEFAULT_SECONDS)))
  return `&every=${every}${ranges.length ? `&ranges=${ranges.join(',')}` : ''}${pages > 1 ? `&pages=${pages}` : ''}`
}

/**
 * The tiles cut into at most `n` pages of whole bands: tiles whose rows overlap stay together, so a page never splits a
 * row of tiles. Pages are balanced by height (the tallest page as short as possible) and each page's layout starts at row 0.
 */
export function splitPages(tiles: TileDef[], n: number): TileDef[][] {
  if (n <= 1 || tiles.length < 2) return [tiles]
  const sorted = tiles.slice().sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
  const bands: { start: number; end: number; tiles: TileDef[] }[] = []
  for (const t of sorted) {
    const last = bands[bands.length - 1]
    if (last && t.layout.y < last.end) { last.end = Math.max(last.end, t.layout.y + t.layout.h); last.tiles.push(t) }
    else bands.push({ start: t.layout.y, end: t.layout.y + t.layout.h, tiles: [t] })
  }
  const k = Math.min(n, bands.length)
  if (k <= 1) return [tiles]
  const h = bands.map((b) => b.end - b.start)
  const pre = [0]; for (const x of h) pre.push(pre[pre.length - 1]! + x)
  // linear partition: cost[j][i] = the least possible tallest page for the first i bands in j pages
  const cost: number[][] = Array.from({ length: k + 1 }, () => Array<number>(bands.length + 1).fill(Infinity))
  const cut: number[][] = Array.from({ length: k + 1 }, () => Array<number>(bands.length + 1).fill(0))
  cost[0]![0] = 0
  for (let j = 1; j <= k; j++) for (let i = j; i <= bands.length; i++) for (let m = j - 1; m < i; m++) {
    const c = Math.max(cost[j - 1]![m]!, pre[i]! - pre[m]!)
    if (c < cost[j]![i]!) { cost[j]![i] = c; cut[j]![i] = m }
  }
  const groups: number[] = []
  for (let j = k, i = bands.length; j > 0; i = cut[j]![i]!, j--) groups.unshift(i)
  const pages: TileDef[][] = []
  let from = 0
  for (const to of groups) {
    const part = bands.slice(from, to)
    const y0 = part[0]!.start
    pages.push(part.flatMap((b) => b.tiles).map((t) => ({ ...t, layout: { ...t.layout, y: t.layout.y - y0 } })))
    from = to
  }
  return pages
}

/** the dashboard as one page of the cycle (the same definition with only that page's tiles) */
export function pageDef(def: DashboardDef, pages: TileDef[][], index: number): DashboardDef {
  return pages.length <= 1 ? def : { ...def, tiles: pages[Math.min(Math.max(0, index), pages.length - 1)]! }
}

export interface CycleStep { range: RangePreset | null; page: number }

/** the steps in order: every range, and inside each range every page (null range: the dashboard's own) */
export function cycleSteps(c: KioskCycle | null, pageCount: number): CycleStep[] {
  if (!c) return [{ range: null, page: 0 }]
  const pages = Math.max(1, Math.min(c.pages, pageCount))
  const ranges: (RangePreset | null)[] = c.ranges.length ? c.ranges : [null]
  const out: CycleStep[] = []
  for (const range of ranges) for (let page = 0; page < pages; page++) out.push({ range, page })
  return out
}

/**
 * The step to show at time `now` (any clock: the page passes Date.now, the tests a fake). The index follows the elapsed
 * time, so a timer that fired late (a sleeping screen, a busy page) never shows a stale step, and the step never depends
 * on the network. A step that cannot be drawn yet (its range was never fetched and the network is down) is skipped
 * forward to the next one that can, so the screen keeps rotating through what it has; when none can be drawn the wanted
 * step is returned (the page then shows its "waiting" state).
 */
export function cycleAt(steps: CycleStep[], startMs: number, everyMs: number, nowMs: number, available: (s: CycleStep) => boolean = () => true): { index: number; wanted: number; msToNext: number } {
  const n = steps.length
  if (n <= 1 || everyMs <= 0) return { index: 0, wanted: 0, msToNext: Infinity }
  const elapsed = Math.max(0, nowMs - startMs)
  const slot = Math.floor(elapsed / everyMs)
  const wanted = slot % n
  let index = wanted
  for (let k = 0; k < n; k++) {
    const j = (wanted + k) % n
    if (available(steps[j]!)) { index = j; break }
  }
  return { index, wanted, msToNext: (slot + 1) * everyMs - elapsed }
}

/** how often the screen asks again: the dashboard's own interval, else every minute (never faster than 15 s) */
export function kioskRefreshMs(def: Pick<DashboardDef, 'refreshSeconds'>): number {
  const s = def.refreshSeconds && def.refreshSeconds >= 15 ? def.refreshSeconds : 60
  return Math.min(3600, s) * 1000
}

/** how long to wait before the next try after a failure (quiet retries: 10 s, 20 s, 40 s ... at most 2 minutes) */
export function kioskRetryMs(failures: number, retryAfterSeconds?: number | null): number {
  if (retryAfterSeconds && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) return Math.min(300, retryAfterSeconds) * 1000
  return Math.min(120_000, 10_000 * 2 ** Math.max(0, Math.min(10, failures - 1)))
}

export type KioskProblem = 'no-token' | 'invalid' | 'no-access' | 'gone' | 'busy' | 'offline' | 'server'

/** an HTTP status (or null: the server could not be reached) -> what the screen says */
export function problemOf(status: number | null): KioskProblem {
  if (status === null) return 'offline'
  if (status === 401) return 'invalid'
  if (status === 403) return 'no-access'
  if (status === 404) return 'gone'
  if (status === 429) return 'busy'
  return 'server'
}

/** problems that mean "show no data at all" (the token no longer allows it), as opposed to a passing hiccup */
export const blocksData = (p: KioskProblem): boolean => p === 'no-token' || p === 'invalid' || p === 'no-access' || p === 'gone'

export const PROBLEM_TEXT: Record<KioskProblem, { title: string; text: string }> = {
  'no-token': { title: 'This screen has no view token', text: 'Open the address that was shown when the view token was created (it ends with #u-kiosk?t=...).' },
  invalid: { title: 'This screen\'s view token does not work', text: 'It was revoked, it expired, or the address is not complete. Ask the owner of the dashboard for a new address. This screen keeps trying.' },
  'no-access': { title: 'This dashboard cannot be shown here any more', text: 'The account this screen shows the dashboard as can no longer open it, is disabled, or has no access to this environment. This screen keeps trying.' },
  gone: { title: 'The dashboard no longer exists', text: 'It was deleted. This screen keeps trying.' },
  busy: { title: 'Too many requests', text: 'This screen asks again shortly.' },
  offline: { title: 'The server cannot be reached', text: 'The last data stays on the screen; it updates again when the connection is back.' },
  server: { title: 'The server had a problem', text: 'This screen asks again shortly.' },
}

/** GET /dashboards/kiosk */
export interface KioskInfo {
  dashboard: { id: string; name: string; def: DashboardDef; modifiedOn: string }
  settings: CalendarSettings & { locale: string; currency: string }
  token: { id: string; label: string; expiresOn: string | null; viewAs: 'creator' | 'service' }
  environmentId: string
}

/** POST /dashboards/kiosk/query */
export interface KioskAnswer {
  dashboardId: string
  results: { id: string; ok: boolean; rows?: Record<string, QueryValue>[]; filtered?: boolean; truncated?: boolean; ms: number; error?: { status: number; message: string } }[]
  errors: Record<string, string>
  range: DateRange | null
  now: string
  ms: number
}

/**
 * The server's answers -> each tile's rows, exactly as the signed-in viewer does it. The plans are compiled here too (the
 * same `buildBatch` the server used, with the server's range and clock) only to know each result column's type (date
 * buckets become dates, measures numbers); nothing compiled here is sent anywhere.
 */
export function kioskTiles(def: DashboardDef, calendar: CalendarSettings, a: KioskAnswer): Record<string, TileData> {
  const { queries } = buildBatch(def, { range: a.range, now: a.now, filters: {}, calendar, columns: () => [] })
  const plans = new Map(queries.map((q) => [q.id, q.plan]))
  const answers: BatchAnswer[] = a.results.map((r) => {
    const plan = plans.get(r.id)
    const rows = r.ok ? (plan ? rowsFromWire(plan, r.rows ?? [], {}) : ((r.rows ?? []) as Record<string, unknown>[])) : []
    return { id: r.id, ok: r.ok, rows: rows as Record<string, unknown>[], ms: r.ms, ...(r.error ? { error: r.error.message, status: r.error.status } : {}), ...(r.filtered ? { filtered: true } : {}), ...(r.truncated ? { truncated: true } : {}) }
  })
  return assemble(def, { range: a.range, calendar, now: a.now }, answers, a.errors ?? {})
}
