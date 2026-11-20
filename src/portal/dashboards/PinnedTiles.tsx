/**
 * "My dashboard": the tiles a person pinned from dashboards they can open (P2-C), as a small grid on the User mode
 * launcher and the Dev home. The list is theirs (server: GET / PUT /dashboards/pins, kept in ab.user_settings; demo mode:
 * browser storage). Each tile is computed AS THE VIEWER through the normal batch endpoint (POST /dashboards/query, as
 * many requests as needed for at most 40 plans each), with its dashboard's own date range and no dashboard filters. A pin
 * whose dashboard or tile is gone, or that the person can no longer open, shows "No longer available" with Remove; the
 * server says nothing else about it. Unpin and reorder save the whole list.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, LayoutDashboard, Pin, RefreshCw, X } from 'lucide-react'
import { platform } from '@/platform'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import type { DashboardDef } from '@/dashboards/types'
import { localNow, resolvePreset } from '@/dashboards/dates'
import { assemble, buildBatch } from '@/dashboards/viewer'
import type { TileData } from '@/dashboards/viewer'
import type { QueryPlan } from '@/platform/query'
import { errMsg, useToast } from '../kit'
import { dashboardsApi, DEFAULT_SETTINGS } from './api'
import type { DashboardSettings, PinView } from './api'
import { Tile } from './DashboardsPage'

const MAX_PLANS = 40
const REFRESH_MS = 5 * 60_000
const keyOf = (p: { dashboardId: string; tileId: string }) => `${p.dashboardId}/${p.tileId}`

/** every available pin as a one-tile dashboard (tile id p<i>) with its dashboard's range; plans in requests of at most 40 */
async function computePins(pins: PinView[], settings: DashboardSettings): Promise<Record<string, TileData>> {
  const calendar = { timeZone: settings.timeZone, fiscalYearStart: settings.fiscalYearStart, weekStart: settings.weekStart, shifts: settings.shifts }
  const now = new Date()
  const columns = (t: string) => platform.tables.get(t)?.columns.map((c) => c.name) ?? null
  const jobs = pins.flatMap((p, i) => {
    if (!p.available || !p.tile.query) return []
    const def: DashboardDef = { version: 1, title: p.dashboardName, range: p.range, tiles: [{ ...p.tile, id: `p${i}` }] }
    const choices = { range: resolvePreset(p.range, now, calendar), now: localNow(now, calendar.timeZone), filters: {}, calendar, columns }
    return [{ key: keyOf(p), def, choices, ...buildBatch(def, choices) }]
  })
  const chunks: { id: string; plan: QueryPlan }[][] = []
  let cur: { id: string; plan: QueryPlan }[] = []
  for (const j of jobs) {
    if (cur.length + j.queries.length > MAX_PLANS) { chunks.push(cur); cur = [] }
    cur.push(...j.queries)
  }
  if (cur.length) chunks.push(cur)
  const answers = (await Promise.all(chunks.map((c) => dashboardsApi.query(c)))).flat()
  const out: Record<string, TileData> = {}
  for (const j of jobs) out[j.key] = assemble(j.def, j.choices, answers, j.errors)[j.def.tiles[0]!.id] ?? { rows: [], error: 'No answer for this tile.' }
  return out
}

export function PinnedTiles({ title = 'My dashboard' }: { title?: string }) {
  const [pins, setPins] = useState<PinView[] | null>(null)
  const [settings, setSettings] = useState<DashboardSettings>(DEFAULT_SETTINGS)
  const [data, setData] = useState<Record<string, TileData>>({})
  const [busy, setBusy] = useState(false)
  const { toast, fail } = useToast()
  const calendar = useMemo(() => ({ timeZone: settings.timeZone, fiscalYearStart: settings.fiscalYearStart, weekStart: settings.weekStart, shifts: settings.shifts }), [settings])
  const defaults = useMemo(() => ({ locale: settings.locale, currency: settings.currency, timeZone: settings.timeZone }), [settings])

  const refresh = useCallback(async (list?: PinView[]) => {
    setBusy(true)
    try {
      const p = list ?? await dashboardsApi.pins()
      const s = await dashboardsApi.settings().catch(() => DEFAULT_SETTINGS)
      setPins(p)
      setSettings(s)
      if (p.some((x) => x.available)) {
        try { setData(await computePins(p, s)) } catch (e) { const m = errMsg(e); setData(Object.fromEntries(p.map((x) => [keyOf(x), { rows: [], error: m }]))) }
      }
    } catch {
      setPins((cur) => cur ?? [])
    } finally { setBusy(false) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const h = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, REFRESH_MS)
    return () => clearInterval(h)
  }, [refresh])

  const save = async (next: PinView[], message: string) => {
    try {
      const saved = await dashboardsApi.savePins(next.map((p) => ({ dashboardId: p.dashboardId, tileId: p.tileId })))
      setPins(saved)
      toast(message, 'success')
    } catch (e) { fail(e) }
  }
  const move = (i: number, d: -1 | 1) => {
    if (!pins) return
    const j = i + d
    if (j < 0 || j >= pins.length) return
    const next = [...pins]
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    void save(next, 'Order saved.')
  }
  const remove = (i: number) => { if (pins) void save(pins.filter((_, k) => k !== i), 'Unpinned.') }

  if (!pins || pins.length === 0) return null
  return (
    <section aria-label={title} className="mb-7" data-testid="pinned-tiles">
      <div className="mb-2.5 flex items-center gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold"><Pin className="size-3.5 text-muted-foreground" /> {title}</h2>
        <span className="text-xs text-muted-foreground">Tiles you pinned, with the rows your own access allows.</span>
        <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label="Refresh pinned tiles" onClick={() => void refresh()} disabled={busy} data-testid="pinned-refresh">{busy ? <Spinner /> : <RefreshCw />}</Button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3" data-testid="pinned-grid">
        {pins.map((p, i) => (
          <div key={keyOf(p)} className="flex h-60 min-w-0 flex-col" data-testid={`pinned-${p.dashboardId}-${p.tileId}`} data-available={p.available ? 'true' : 'false'}>
            <div className="flex shrink-0 items-center gap-1 px-1 pb-1 text-xs">
              {p.available ? (
                <a href={`#u-dashboards?d=${encodeURIComponent(p.dashboardId)}`} className="flex min-w-0 flex-1 items-center gap-1 truncate text-muted-foreground hover:text-foreground hover:underline" title={`Open the dashboard "${p.dashboardName}"`} data-testid={`pinned-open-${p.dashboardId}-${p.tileId}`}>
                  <LayoutDashboard className="size-3 shrink-0" /><span className="truncate">{p.dashboardName}</span>
                </a>
              ) : <span className="flex-1 text-muted-foreground">Pinned tile</span>}
              <button type="button" className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-40" aria-label="Move earlier" disabled={i === 0} onClick={() => move(i, -1)} data-testid={`pinned-left-${i}`}><ArrowLeft className="size-3.5" /></button>
              <button type="button" className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-40" aria-label="Move later" disabled={i === pins.length - 1} onClick={() => move(i, 1)} data-testid={`pinned-right-${i}`}><ArrowRight className="size-3.5" /></button>
              <button type="button" className="rounded p-0.5 text-muted-foreground hover:bg-muted" aria-label={p.available ? `Unpin ${p.tile.title || 'the tile'}` : 'Remove this pin'} title={p.available ? 'Unpin' : 'Remove'} onClick={() => remove(i)} data-testid={`pinned-remove-${i}`}><X className="size-3.5" /></button>
            </div>
            <div className="min-h-0 flex-1">
              {p.available ? (
                <Tile tile={p.tile} data={p.tile.query ? data[keyOf(p)] : undefined} calendar={calendar} defaults={defaults} editing={false} selected={null} bare onEdit={() => {}} onPick={() => {}} />
              ) : (
                <div className="flex size-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-card p-3 text-center text-xs text-muted-foreground" data-testid={`pinned-gone-${i}`}>
                  <span className="text-sm font-medium text-foreground">No longer available</span>
                  <span>The dashboard or the tile was removed, or you can no longer open it.</span>
                  <Button size="xs" variant="outline" onClick={() => remove(i)} data-testid={`pinned-gone-remove-${i}`}>Remove</Button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
