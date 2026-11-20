/**
 * The kiosk / TV page's pure parts (P2-C; docs/dev/dashboards.md "Kiosk page"). No React, no DOM, no network: the page
 * (src/portal/dashboards/KioskPage.tsx) uses them, and src/dashboards/kiosk.test.ts tests them.
 *
 * The address is `<origin><path>#u-kiosk?t=<token>`: the token is in the URL FRAGMENT, which browsers never send to the
 * server (not in access logs, proxy logs or Referer headers). It is never put in a query string.
 */
import type { DashboardDef } from './types.ts'
import type { CalendarSettings, DateRange } from './dates.ts'
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

/** the address to open on the screen (origin and path of this install, the token after `#`) */
export function kioskAddress(origin: string, pathname: string, token: string): string {
  return `${origin.replace(/\/$/, '')}${pathname || '/'}#${KIOSK_ROUTE}?t=${encodeURIComponent(token)}`
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
