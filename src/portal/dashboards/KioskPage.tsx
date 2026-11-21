/**
 * The kiosk / TV page (P2-C; docs/dev/dashboards.md "Kiosk page"): `#u-kiosk?t=<view token>` shows ONE dashboard full
 * screen with no shell, no sign-in and no cookie authority. App.tsx mounts it before the platform starts (no session is
 * read, nothing of a signed-in person is loaded), so it shows the token's view whoever is signed in to this browser.
 *
 * Network: only GET /dashboards/kiosk and POST /dashboards/kiosk/query, with a plain fetch, `credentials: 'omit'` (the
 * session cookie is never sent), no CSRF or environment header, `Authorization: Bearer <token>` only, `cache: 'no-store'`
 * (the service worker never caches /api/ either). The token stays in this module's memory and the address bar; it is
 * never written to browser storage, the console, document.title, error messages or any URL sent to the server.
 *
 * Behaviour: refresh on the dashboard's interval (default every minute); the definition is read again every 5 minutes;
 * a passing failure (offline, 429, 5xx) keeps the last data on screen with a small note and retries quietly with backoff;
 * a token that is revoked, expired or wrong (401), an account that can no longer open the dashboard (403) or a deleted
 * dashboard (404) clears the data and shows a full-page message, and keeps retrying so a re-enabled screen recovers. No
 * editing, no drill-through, no links into the app. The cursor hides after 3 seconds without movement.
 *
 * Cycling (P3-D), only when the address asks (`&every=30&ranges=today,last7&pages=2`, src/dashboards/kiosk.ts): the step
 * follows the clock; each range is fetched with the `range` the query route has always accepted (a preset name, checked
 * by the server) and kept, so the rotation goes on through a network drop with what it has. Pages are cut on the screen.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MonitorX, WifiOff } from 'lucide-react'
import { API_BASE } from '@/platform/http'
import type { DashboardDef } from '@/dashboards/types'
import type { TileData } from '@/dashboards/viewer'
import { rangeLabel } from '@/dashboards/dates'
import type { DateRange, RangePreset } from '@/dashboards/dates'
import { PROBLEM_TEXT, blocksData, cycleAt, cycleFromHash, cycleQuery, cycleSteps, kioskRefreshMs, kioskRetryMs, kioskTiles, pageDef, problemOf, splitPages, tokenFromHash } from '@/dashboards/kiosk'
import type { KioskAnswer, KioskCycle, KioskInfo, KioskProblem } from '@/dashboards/kiosk'
import { cn } from '@/lib/utils'
import { Grid, Tile } from './DashboardsPage'

const DEF_RELOAD_MS = 5 * 60_000
const CURSOR_IDLE_MS = 3000

class KioskError extends Error {
  status: number | null
  retryAfter: number | null
  constructor(status: number | null, retryAfter: number | null) {
    super(status === null ? 'unreachable' : `status ${status}`)
    this.status = status
    this.retryAfter = retryAfter
  }
}

/** the only two requests the page makes; never with cookies, never with the token anywhere but the header */
async function kioskFetch<T>(token: string, method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  } catch {
    throw new KioskError(null, null)
  }
  if (!res.ok) {
    const ra = Number(res.headers.get('Retry-After'))
    throw new KioskError(res.status, Number.isFinite(ra) && ra > 0 ? ra : null)
  }
  return (await res.json()) as T
}

export function KioskPage() {
  const [address, setAddress] = useState(() => location.hash)
  useEffect(() => {
    const f = () => setAddress(location.hash)
    window.addEventListener('hashchange', f)
    return () => window.removeEventListener('hashchange', f)
  }, [])
  const token = tokenFromHash(address)
  const cycle = cycleFromHash(address)
  // the address keeps the token (a screen that restarts must come back), the tab title never does
  useEffect(() => { document.title = 'Dashboard screen' }, [])
  // a different cycle in the address starts the screen again, at its first step
  return token ? <KioskScreen key={`${token}|${cycle ? cycleQuery(cycle) : ''}`} token={token} cycle={cycle} /> : <KioskMessage problem="no-token" />
}

/** what one date range showed the last time it was fetched; kept so the cycle goes on through a network drop */
interface Entry { data: Record<string, TileData>; range: DateRange | null; stamp: Date; at: number }
const keyOf = (r: RangePreset | null): string => r ?? ''

function KioskScreen({ token, cycle }: { token: string; cycle: KioskCycle | null }) {
  const [info, setInfo] = useState<KioskInfo | null>(null)
  const [entries, setEntries] = useState<Record<string, Entry>>({})
  const [problem, setProblem] = useState<KioskProblem | null>(null)
  const [idle, setIdle] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const failures = useRef(0)
  const defAt = useRef(0)
  const infoRef = useRef<KioskInfo | null>(null)
  const entriesRef = useRef<Record<string, Entry>>({})
  const wantKey = useRef(keyOf(cycle?.ranges[0] ?? null)) // the first step's range: the first request already asks for it
  const startAt = useRef(Date.now())
  // the ranges of the cycle (fixed for this screen: another cycle in the address mounts a new one)
  const cycleRanges = useRef(cycle?.ranges ?? [])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)

  const running = useRef(false)
  const refresh = useCallback(async () => {
    // one request chain at a time (a timer, "online" and "visible" may all ask at once)
    if (running.current) return
    running.current = true
    if (timer.current) clearTimeout(timer.current)
    // the range the screen shows now; while it has data, a range of the cycle never fetched yet is fetched first, so the
    // first round of the cycle does not skip it (a range without data is skipped, never waited for)
    const unfetched = cycleRanges.current.map((r) => keyOf(r)).filter((k) => !entriesRef.current[k])
    const key = entriesRef.current[wantKey.current] && unfetched.length ? unfetched[0] : wantKey.current
    let next: number
    try {
      let cur = infoRef.current
      if (!cur || Date.now() - defAt.current > DEF_RELOAD_MS) {
        cur = await kioskFetch<KioskInfo>(token, 'GET', '/dashboards/kiosk')
        defAt.current = Date.now()
        infoRef.current = cur
        if (alive.current) setInfo(cur)
      }
      // the range asked for is one of the server's own presets (the query route validates it as it always did)
      const a = await kioskFetch<KioskAnswer>(token, 'POST', '/dashboards/kiosk/query', { dashboardId: cur.dashboard.id, ...(key ? { range: key } : {}) })
      if (!alive.current) { running.current = false; return }
      entriesRef.current = { ...entriesRef.current, [key]: { data: kioskTiles(cur.dashboard.def, cur.settings, a), range: a.range, stamp: new Date(), at: Date.now() } }
      setEntries(entriesRef.current)
      setProblem(null)
      failures.current = 0
      const refreshMs = kioskRefreshMs(cur.dashboard.def)
      // the cycle moved on to a range that was not fetched yet (or not lately) while this request was running: ask for it now
      const e = entriesRef.current[wantKey.current]
      const stillUnfetched = cycleRanges.current.some((r) => !entriesRef.current[keyOf(r)])
      next = (wantKey.current !== key && (!e || Date.now() - e.at > refreshMs)) || stillUnfetched ? 0 : refreshMs
    } catch (e) {
      if (!alive.current) { running.current = false; return }
      const err = e instanceof KioskError ? e : new KioskError(0, null)
      const p = problemOf(err.status)
      failures.current++
      setProblem(p)
      if (blocksData(p)) {
        // the token no longer allows it: nothing of the dashboard stays on the screen
        infoRef.current = null
        setInfo(null)
        entriesRef.current = {}
        setEntries({})
      }
      next = blocksData(p) ? Math.max(60_000, kioskRetryMs(failures.current)) : kioskRetryMs(failures.current, err.retryAfter)
    }
    running.current = false
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void refresh(), next)
  }, [token])

  useEffect(() => {
    alive.current = true
    void refresh()
    // back online, or the tab shown again: ask now instead of waiting for the timer
    const ask = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('online', ask)
    document.addEventListener('visibilitychange', ask)
    return () => {
      alive.current = false
      if (timer.current) clearTimeout(timer.current)
      window.removeEventListener('online', ask)
      document.removeEventListener('visibilitychange', ask)
    }
  }, [refresh])

  // cycling: the step follows the clock; a range that has no data yet (the network was down) is skipped, never waited for
  const def = info?.dashboard.def ?? null
  const pages = useMemo(() => (def ? splitPages(def.tiles, cycle?.pages ?? 1) : [[]]), [def, cycle])
  const steps = useMemo(() => cycleSteps(cycle, pages.length), [cycle, pages.length])
  const pos = useMemo(() => cycleAt(steps, startAt.current, (cycle?.every ?? 0) * 1000, now, (s) => !!entries[keyOf(s.range)]), [steps, cycle, now, entries])
  const step = steps[pos.index] ?? steps[0]!
  const wantedKey = keyOf((steps[pos.wanted] ?? step).range)
  useEffect(() => {
    if (!cycle || steps.length < 2) return
    const t = setTimeout(() => setNow(Date.now()), Math.max(50, Math.min(pos.msToNext, 60_000)) + 5)
    return () => clearTimeout(t)
  }, [cycle, steps.length, pos.msToNext, now])
  const wantedAt = entries[wantedKey]?.at
  useEffect(() => {
    wantKey.current = wantedKey
    if (!info) return
    if (wantedAt === undefined || Date.now() - wantedAt > kioskRefreshMs(info.dashboard.def)) void refresh()
  }, [wantedKey, wantedAt, info, refresh])

  // the cursor hides after a while without movement
  useEffect(() => {
    let h: ReturnType<typeof setTimeout> | null = null
    const move = () => { setIdle(false); if (h) clearTimeout(h); h = setTimeout(() => setIdle(true), CURSOR_IDLE_MS) }
    move()
    window.addEventListener('pointermove', move)
    window.addEventListener('keydown', move)
    return () => { if (h) clearTimeout(h); window.removeEventListener('pointermove', move); window.removeEventListener('keydown', move) }
  }, [])

  // the dashboard's name while it is shown; nothing of it once the token stops working
  useEffect(() => { document.title = info ? info.dashboard.name : 'Dashboard screen' }, [info])

  if (!info) return <KioskMessage problem={problem} idle={idle} />
  const shown = entries[keyOf(step.range)]
  return (
    <KioskBoard def={pageDef(info.dashboard.def, pages, step.page)} settings={info.settings} data={shown?.data ?? {}} range={shown?.range ?? null} stamp={shown?.stamp ?? null}
      problem={problem} idle={idle} cycle={cycle && steps.length > 1 ? { index: pos.index, count: steps.length, page: step.page, pages: pages.length, range: step.range } : null} />
  )
}

interface CycleView { index: number; count: number; page: number; pages: number; range: RangePreset | null }

function KioskBoard({ def, settings, data, range, stamp, problem, idle, cycle }: { def: DashboardDef; settings: KioskInfo['settings']; data: Record<string, TileData>; range: DateRange | null; stamp: Date | null; problem: KioskProblem | null; idle: boolean; cycle: CycleView | null }) {
  const calendar = useMemo(() => ({ timeZone: settings.timeZone, fiscalYearStart: settings.fiscalYearStart, weekStart: settings.weekStart, shifts: settings.shifts }), [settings])
  const defaults = useMemo(() => ({ locale: settings.locale, currency: settings.currency, timeZone: settings.timeZone }), [settings])
  const [height, setHeight] = useState(() => window.innerHeight)
  useEffect(() => { const f = () => setHeight(window.innerHeight); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f) }, [])
  // rows fill the screen height (a wall screen should not scroll), never smaller than the editor's 80 px
  const rows = Math.max(1, ...def.tiles.map((t) => t.layout.y + t.layout.h))
  const HEADER = 64
  const rowPx = Math.max(80, Math.floor((height - HEADER - 24 - (rows - 1) * 12) / rows))
  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-canvas text-foreground', idle && 'cursor-none [&_*]:cursor-none')} data-testid="kiosk-page" data-state={problem ?? 'ready'}>
      <header className="flex h-16 shrink-0 items-center gap-4 border-b bg-card px-6">
        <h1 className="truncate text-2xl font-semibold" data-testid="kiosk-title">{def.title}</h1>
        <span className="text-lg text-muted-foreground" data-testid="kiosk-range">{rangeLabel(range)}</span>
        {cycle && (
          <span className="flex items-center gap-1.5 text-base text-muted-foreground" data-testid="kiosk-cycle" data-step={cycle.index} data-steps={cycle.count} data-range={cycle.range ?? ''} data-page={cycle.page} data-pages={cycle.pages}>
            {cycle.pages > 1 && <span>Page {cycle.page + 1} of {cycle.pages}</span>}
            <span aria-hidden className="flex gap-1">{Array.from({ length: cycle.count }, (_, i) => <span key={i} className={cn('size-2 rounded-full', i === cycle.index ? 'bg-foreground' : 'bg-muted-foreground/30')} />)}</span>
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 text-base text-muted-foreground" data-testid="kiosk-stamp">
          {problem && !blocksData(problem) && <span className="flex items-center gap-1.5 rounded-full bg-amber-500/15 px-3 py-1 text-sm text-amber-900 dark:text-amber-200" data-testid="kiosk-hiccup"><WifiOff className="size-4" />{PROBLEM_TEXT[problem].title}</span>}
          {stamp ? `Updated ${stamp.toLocaleTimeString(settings.locale, { hour: '2-digit', minute: '2-digit' })}` : ''}
        </span>
      </header>
      <main className="min-h-0 flex-1 overflow-hidden p-3">
        <Grid def={def} editing={false} onLayout={() => {}} rowPx={rowPx}>
          {(t) => (
            <Tile key={t.id} tile={t} data={data[t.id]} calendar={calendar} defaults={defaults} editing={false} selected={null} bare
              onEdit={() => {}} onPick={() => {}} titleClass="text-lg" />
          )}
        </Grid>
      </main>
    </div>
  )
}

function KioskMessage({ problem, idle = false }: { problem: KioskProblem | null; idle?: boolean }) {
  const p = problem ? PROBLEM_TEXT[problem] : null
  return (
    <div className={cn('grid h-full place-items-center bg-background p-8 text-center', idle && 'cursor-none')} data-testid="kiosk-message" data-problem={problem ?? 'loading'}>
      {p ? (
        <div className="grid max-w-2xl justify-items-center gap-4">
          {problem === 'offline' ? <WifiOff className="size-16 text-muted-foreground" /> : <MonitorX className="size-16 text-muted-foreground" />}
          <h1 className="text-3xl font-semibold" data-testid="kiosk-message-title">{p.title}</h1>
          <p className="text-xl text-muted-foreground">{p.text}</p>
        </div>
      ) : <p className="text-xl text-muted-foreground">Loading the dashboard...</p>}
    </div>
  )
}
