/**
 * Dashboards (P2-C): the list, the viewer and the layout editor (#u-dashboards, #u-dashboards?d=<id>; Dev and User
 * mode). One batch request per refresh (server: POST /dashboards/query), tiles on a 12-column grid (6 columns on a tablet,
 * derived; one column on a phone), a date range and filters, cross-filtering by clicking a category, drill-through to an
 * app, live refresh when a table changes (previous rows stay on screen until the new ones arrive), auto-refresh, per-tile
 * errors and the "based on the rows you can see" note. Makers create dashboards from the "Production overview" template
 * (with SAMPLE tables when the plant tables do not exist yet) and edit the layout (drag to move, a corner handle to
 * resize, or the step buttons / arrow keys; src/dashboards/grid.ts has the arithmetic), the title, who can view it
 * (ViewerRoles.tsx) and the tiles (TileEditor.tsx). The environment's settings are DashboardSettings.tsx.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Download, ExternalLink, Factory, GripVertical, KeyRound, LayoutDashboard, Mail, Minus, Pencil, Pin, PinOff, Plus, RefreshCw, Save, Settings2, Table2, Trash2, TriangleAlert, Users, X } from 'lucide-react'
import { platform, usePlatform } from '@/platform'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { useLiveTopic } from '@/platform/useLive'
import type { DashboardDef, DashboardInfo, TileDef } from '@/dashboards/types'
import type { GridItem } from '@/dashboards/grid'
import { GRID_COLS, cellSteps, columnsFor, deriveColumns, dragRect, layoutModeFor, place, readingOrder, resizeRect, stepItem } from '@/dashboards/grid'
import { cleanRoles, viewerSummary } from '@/dashboards/access'
import { RANGE_PRESETS, localNow, rangeLabel, resolvePreset } from '@/dashboards/dates'
import type { CalendarSettings, RangePreset } from '@/dashboards/dates'
import { assemble, buildBatch } from '@/dashboards/viewer'
import type { CrossFilter, TileData } from '@/dashboards/viewer'
import { tileChartSpec } from '@/dashboards/tile'
import { DOWNTIME, PRODUCTION_LOG, SHAPE, productionOverview, sampleProduction } from '@/dashboards/manufacturing'
import { formatNumber } from '@/charts/format'
import type { ChartSpec, Scene, SeriesSpec } from '@/charts/geometry'
import { VizView, exportCsv, exportPng, exportSvg, useBoxSize } from '@/controls/display/viz'
import { ConfirmDialog, Empty, PageHeader, errMsg, useToast } from '../kit'
import { useCaps } from '../security'
import { dashboardsApi, DEFAULT_SETTINGS, MAX_PINS } from './api'
import type { DashboardSettings, PinRef } from './api'
import { ViewTokensSheet } from './ViewTokens'
import { SnapshotsSheet } from './Snapshots'
import { TileEditor } from './TileEditor'
import { DashboardSettingsSheet } from './DashboardSettings'
import { ViewerRolesDialog } from './ViewerRoles'
import { openDrill } from './drillTo'
import { ShareToChatButton } from '@/chat/share'

const sel = 'h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30'
const ROW_PX = 80
const GAP_PX = 12

function selectedId(): string | null {
  const m = /[?&]d=([A-Za-z0-9_-]+)/.exec(location.hash)
  return m ? m[1]! : null
}
function openDashboard(id: string | null) {
  location.hash = id ? `#u-dashboards?d=${id}` : '#u-dashboards'
}

export function DashboardsPage() {
  const [id, setId] = useState(selectedId)
  useEffect(() => {
    const f = () => setId(selectedId())
    window.addEventListener('hashchange', f)
    return () => window.removeEventListener('hashchange', f)
  }, [])
  return id ? <DashboardScreen key={id} id={id} /> : <DashboardList />
}

/* ------------------------------------------------------------------ list and template */

function csvOf(rows: Record<string, unknown>[], cols: string[]): string {
  const f = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  return [cols.join(','), ...rows.map((r) => cols.map((c) => f(r[c])).join(','))].join('\r\n') + '\r\n'
}

/** creates the minimal plant tables with SAMPLE rows (only those that do not exist yet) */
async function createSampleTables(): Promise<void> {
  const sample = sampleProduction(new Date(), 60)
  for (const [name, rows] of [[PRODUCTION_LOG, sample.log], [DOWNTIME, sample.downtime]] as const) {
    if (platform.tables.get(name)) continue
    await platform.tables.create({ displayName: name === PRODUCTION_LOG ? 'Production log (sample)' : 'Downtime (sample)', name, description: 'SAMPLE data for the Production overview dashboard. Delete it when you use real data.', columns: SHAPE[name] })
    await platform.tables.importCsv(name, csvOf(rows as Record<string, unknown>[], SHAPE[name]!.map((c) => c.name!)), 'append')
  }
}

function DashboardList() {
  const caps = useCaps()
  const canMake = caps.isMaker || caps.isAdmin
  const [items, setItems] = useState<DashboardInfo[] | null>(null)
  const [busy, setBusy] = useState(false)
  const { toast, fail } = useToast()
  const tablesVersion = usePlatform((s) => s.tables.length)
  const [showSettings, setShowSettings] = useState(false)
  useEffect(() => { dashboardsApi.list().then(setItems, (e) => { fail(e); setItems([]) }) }, [fail])
  const haveTables = !!platform.tables.get(PRODUCTION_LOG) && !!platform.tables.get(DOWNTIME)
  void tablesVersion
  const fromTemplate = async () => {
    setBusy(true)
    try {
      if (!haveTables) await createSampleTables()
      const d = await dashboardsApi.create(productionOverview())
      toast(haveTables ? 'Dashboard created.' : 'Sample tables and the dashboard were created.', 'success')
      openDashboard(d.id)
    } catch (e) { fail(e) } finally { setBusy(false) }
  }
  return (
    <div className="mx-auto w-full max-w-5xl p-6" data-testid="dashboards-page">
      <PageHeader icon={LayoutDashboard} title="Dashboards" subtitle="Charts and KPIs over your tables. Everyone sees only the rows their own access allows."
        actions={<Button size="sm" variant="outline" onClick={() => setShowSettings(true)} data-testid="dashboard-settings-open"><Settings2 /> Settings</Button>} />
      {showSettings && <DashboardSettingsSheet canChange={caps.isAdmin} onClose={() => setShowSettings(false)} />}
      {canMake && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4">
          <Factory className="size-5 text-primary" />
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-medium">Production overview</div>
            <div className="text-muted-foreground">OEE gauge, output and scrap KPIs, daily trend, downtime Pareto and output by machine. {haveTables ? 'Uses your ProductionLog and Downtime tables.' : 'Creates two tables with SAMPLE data (clearly named) first.'}</div>
          </div>
          <Button size="sm" onClick={fromTemplate} disabled={busy} data-testid="dashboard-from-template">{busy ? <Spinner /> : <Plus />} Create from template</Button>
        </div>
      )}
      {items === null ? <div className="flex justify-center p-10"><Spinner /></div> : items.length === 0 ? (
        <Empty icon={LayoutDashboard} title="No dashboards yet" description={canMake ? 'Create one from the template above.' : 'Dashboards shared with your role appear here.'} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((d) => (
            <button key={d.id} type="button" onClick={() => openDashboard(d.id)} className="rounded-lg border bg-card p-4 text-left hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/40 outline-none" data-testid={`dashboard-card-${d.id}`}>
              <div className="flex items-center gap-2 font-medium"><LayoutDashboard className="size-4 text-primary" />{d.name}</div>
              <div className="mt-1 text-xs text-muted-foreground">{d.def.tiles.length} tiles · {RANGE_PRESETS.find((p) => p.key === d.def.range)?.label}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ the viewer */

function DashboardScreen({ id }: { id: string }) {
  const [info, setInfo] = useState<DashboardInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState<DashboardSettings>(DEFAULT_SETTINGS)
  useEffect(() => {
    dashboardsApi.get(id).then(setInfo, (e) => setError(errMsg(e)))
    dashboardsApi.settings().then(setSettings, () => {})
  }, [id])
  if (error) return <div className="p-6"><Empty icon={TriangleAlert} title="This dashboard cannot be opened" description={error} action={<Button size="sm" variant="outline" onClick={() => openDashboard(null)}>All dashboards</Button>} /></div>
  if (!info) return <div className="flex justify-center p-10"><Spinner /></div>
  return <DashboardView info={info} settings={settings} onSaved={setInfo} />
}

function DashboardView({ info, settings, onSaved }: { info: DashboardInfo; settings: DashboardSettings; onSaved(i: DashboardInfo): void }) {
  const [def, setDef] = useState<DashboardDef>(info.def)
  const [editing, setEditing] = useState(false)
  const [range, setRange] = useState<RangePreset>(info.def.range)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [cross, setCross] = useState<CrossFilter | null>(null)
  const [data, setData] = useState<Record<string, TileData>>({})
  const [loading, setLoading] = useState(true)
  const [stamp, setStamp] = useState<{ at: Date; ms: number } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [roles, setRoles] = useState<string[]>(info.roles)
  const [showRoles, setShowRoles] = useState(false)
  const allRoles = usePlatform((s) => s.roles)
  /** the tile query editor: a tile to edit, or null for a new one */
  const [editor, setEditor] = useState<{ tile: TileDef | null } | null>(null)
  const { toast, fail } = useToast()
  const mode = usePlatform((s) => s.mode)
  const [panel, setPanel] = useState<'tokens' | 'snapshots' | null>(null)
  // pinned tiles: the viewer's whole list (pins of other dashboards stay as they are)
  const [pins, setPins] = useState<PinRef[] | null>(null)
  useEffect(() => { dashboardsApi.pins().then((p) => setPins(p.map((x) => ({ dashboardId: x.dashboardId, tileId: x.tileId }))), () => setPins(null)) }, [])
  const isPinned = (tid: string) => !!pins?.some((p) => p.dashboardId === info.id && p.tileId === tid)
  const togglePin = async (t: TileDef) => {
    if (!pins) return
    const was = isPinned(t.id)
    const next = was ? pins.filter((p) => !(p.dashboardId === info.id && p.tileId === t.id)) : [...pins, { dashboardId: info.id, tileId: t.id }]
    if (next.length > MAX_PINS) { toast(`You can pin at most ${MAX_PINS} tiles. Unpin one on your home page first.`, 'error'); return }
    try {
      const saved = await dashboardsApi.savePins(next)
      setPins(saved.map((x) => ({ dashboardId: x.dashboardId, tileId: x.tileId })))
      toast(was ? 'Unpinned from My dashboard.' : 'Pinned to My dashboard (on your home page).', 'success')
    } catch (e) { fail(e) }
  }
  const seq = useRef(0)
  const calendar = useMemo(() => ({ timeZone: settings.timeZone, fiscalYearStart: settings.fiscalYearStart, weekStart: settings.weekStart, shifts: settings.shifts }), [settings])
  const defaults = useMemo(() => ({ locale: settings.locale, currency: settings.currency, timeZone: settings.timeZone }), [settings])
  const tables = useMemo(() => [...new Set(def.tiles.flatMap((t) => (t.query ? [t.query.table] : [])))], [def])
  usePlatform((s) => s.tables.length)

  const refresh = useCallback(async () => {
    const my = ++seq.current
    const r = resolvePreset(range, new Date(), calendar)
    const choices = { range: r, now: localNow(new Date(), calendar.timeZone), filters, cross, calendar, columns: (t: string) => platform.tables.get(t)?.columns.map((c) => c.name) ?? null }
    const b = buildBatch(def, choices)
    const t0 = performance.now()
    try {
      const answers = await dashboardsApi.query(b.queries)
      if (my !== seq.current) return
      setData(assemble(def, choices, answers, b.errors))
      setStamp({ at: new Date(), ms: Math.round(performance.now() - t0) })
    } catch (e) {
      if (my !== seq.current) return
      setData(Object.fromEntries(def.tiles.map((t) => [t.id, { rows: [], error: errMsg(e) }])))
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [def, range, filters, cross, calendar])

  useEffect(() => { void refresh() }, [refresh])
  // auto-refresh interval
  useEffect(() => {
    const s = def.refreshSeconds ?? 0
    if (!s || editing) return
    const h = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, s * 1000)
    return () => clearInterval(h)
  }, [def.refreshSeconds, editing, refresh])
  // live: a change to a table the dashboard reads refreshes it (debounced; old rows stay until the new ones arrive)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onChange = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void refresh(), 400)
  }, [refresh])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const save = async () => {
    try {
      // the server refuses a role that does not exist: send only the ones that do (when the role list is known)
      const known = allRoles.length ? cleanRoles(roles, allRoles) : roles
      const saved = await dashboardsApi.update(info.id, { def, name: def.title, roles: known })
      onSaved(saved)
      setDef(saved.def)
      setRoles(saved.roles)
      setEditing(false)
      toast('Dashboard saved.', 'success')
    } catch (e) { fail(e) }
  }
  const remove = async () => {
    try { await dashboardsApi.remove(info.id); openDashboard(null) } catch (e) { fail(e) }
  }
  const step = (id: string, d: { dx?: number; dy?: number; dw?: number; dh?: number }) => setDef((cur) => withLayout(cur, stepItem(itemsOf(cur), id, d)))
  const drill = (t: TileDef, row?: Record<string, unknown>) => {
    if (!t.drill) return
    const problem = openDrill(t.drill, row)
    if (problem) toast(problem, 'error')
  }
  const editTile = (tid: string, f: (t: TileDef) => TileDef | null) => setDef((d) => ({ ...d, tiles: d.tiles.flatMap((t) => { if (t.id !== tid) return [t]; const n = f(t); return n ? [n] : [] }) }))
  const r = resolvePreset(range, new Date(), calendar)

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="dashboard-view">
      {tables.map((t) => <LiveTable key={t} table={t} onChange={onChange} />)}
      <div className="flex flex-wrap items-center gap-2 border-b bg-card px-4 py-2.5">
        <Button variant="ghost" size="icon-sm" aria-label="All dashboards" onClick={() => openDashboard(null)}><ArrowLeft /></Button>
        {editing ? (
          <Input className="h-8 w-64" value={def.title} onChange={(e) => setDef({ ...def, title: e.target.value })} aria-label="Dashboard title" data-testid="dashboard-title-input" />
        ) : <h1 className="mr-2 text-base font-semibold" data-testid="dashboard-title">{def.title}</h1>}
        <select className={sel} value={range} onChange={(e) => setRange(e.target.value as RangePreset)} aria-label="Date range" data-testid="dashboard-range">
          {RANGE_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        {(def.filters ?? []).map((f) => (
          <select key={f.id} className={sel} value={filters[f.id] ?? ''} onChange={(e) => setFilters({ ...filters, [f.id]: e.target.value })} aria-label={f.label} data-testid={`dashboard-filter-${f.id}`}>
            <option value="">{f.label}: all</option>
            {f.options.map((o) => <option key={o} value={o}>{f.label}: {o}</option>)}
          </select>
        ))}
        {cross && (
          <button type="button" className="flex h-7 items-center gap-1 rounded-full bg-accent px-2.5 text-xs text-accent-foreground" onClick={() => setCross(null)} data-testid="dashboard-crossfilter">
            {cross.column}: {cross.value === null ? '(blank)' : String(cross.value)} <X className="size-3" /><span className="sr-only">Clear the filter</span>
          </button>
        )}
        <span className="text-xs text-muted-foreground" data-testid="dashboard-range-label">{rangeLabel(r)}</span>
        <div className="ml-auto flex items-center gap-2">
          {stamp && <span className="hidden text-xs text-muted-foreground sm:inline" data-testid="dashboard-stamp">Updated {stamp.at.toLocaleTimeString()} · {stamp.ms} ms</span>}
          <Button variant="outline" size="sm" onClick={() => void refresh()} aria-label="Refresh" data-testid="dashboard-refresh"><RefreshCw /></Button>
          {!editing && <ShareToChatButton target={{ kind: 'dashboard', dashboard: info.id }} title={info.def.title || info.name} variant="outline" size="icon-sm" />}
          {mode === 'server' && !editing && <Button variant="outline" size="sm" onClick={() => setPanel('snapshots')} aria-label="Email snapshots" title="Email this dashboard as a PDF on a schedule" data-testid="dashboard-snapshots"><Mail /><span className="hidden lg:inline"> Email</span></Button>}
          {mode === 'server' && info.canEdit && !editing && <Button variant="outline" size="sm" onClick={() => setPanel('tokens')} aria-label="TV and kiosk screens" title="View tokens: show this dashboard on a screen without signing in" data-testid="dashboard-tokens"><KeyRound /><span className="hidden lg:inline"> Screens</span></Button>}
          {info.canEdit && <Button variant="outline" size="sm" onClick={() => setShowRoles(true)} title={viewerSummary(roles, allRoles)} aria-label="Who can see this dashboard" data-testid="dashboard-viewers"><Users /><span className="hidden lg:inline"> Who can see this</span></Button>}
          {info.canEdit && !editing && <Button variant="outline" size="sm" onClick={() => setEditing(true)} data-testid="dashboard-edit"><Pencil /> Edit</Button>}
          {editing && <>
            <Button variant="outline" size="sm" onClick={() => setEditor({ tile: null })} data-testid="dashboard-add-tile"><Plus /> Add tile</Button>
            <Button variant="outline" size="sm" onClick={() => { setDef(info.def); setRoles(info.roles); setEditing(false) }} data-testid="dashboard-cancel">Cancel</Button>
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)} data-testid="dashboard-delete"><Trash2 /> Delete</Button>
            <Button size="sm" onClick={save} data-testid="dashboard-save"><Save /> Save</Button>
          </>}
        </div>
      </div>
      {editing && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-card px-4 py-1.5 text-xs text-muted-foreground" data-testid="dashboard-viewers-line">
          <Users className="size-3.5 shrink-0" /><span>{viewerSummary(roles, allRoles)}</span>
          <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => setShowRoles(true)} data-testid="dashboard-viewers-change">Change</button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto bg-canvas p-3">
        {loading && !Object.keys(data).length ? <div className="flex justify-center p-10"><Spinner /></div> : (
          <Grid def={def} editing={editing} onLayout={(items) => setDef((cur) => withLayout(cur, items))}>
            {(t, chrome) => (
              <Tile key={t.id} tile={t} data={data[t.id]} calendar={calendar} defaults={defaults} editing={editing} chrome={chrome}
                selected={cross && cross.tileId !== t.id ? null : cross?.tileId === t.id ? (cross.value === null ? '(blank)' : String(cross.value)) : null}
                onEdit={(f) => editTile(t.id, f)}
                onStep={(d) => step(t.id, d)}
                onOpen={() => drill(t)}
                onConfigure={() => setEditor({ tile: t })}
                pinned={isPinned(t.id)} onPin={pins && t.kind !== 'text' ? () => void togglePin(t) : undefined}
                onPick={(row) => {
                  if (editing) return
                  if (t.drill) { drill(t, row); return }
                  if (!t.crossFilter || !t.query) return
                  const col = t.query.groupBy?.[0]
                  if (!col) return
                  const v = row[col] ?? null
                  setCross((c) => (c && c.tileId === t.id && c.value === v ? null : { tileId: t.id, table: t.query!.table, column: col, value: v }))
                }} />
            )}
          </Grid>
        )}
      </div>
      {panel === 'tokens' && <ViewTokensSheet info={info} onClose={() => setPanel(null)} />}
      {panel === 'snapshots' && <SnapshotsSheet info={info} def={def} onClose={() => setPanel(null)} />}
      {showRoles && <ViewerRolesDialog roles={allRoles} selected={roles} editing={editing} onChange={setRoles} onClose={() => setShowRoles(false)} />}
      {editor && <TileEditor def={def} tile={editor.tile} range={range} calendar={calendar} onClose={() => setEditor(null)} onApply={(d) => { setDef(d); setEditor(null) }}
        renderTile={(t, d) => <Tile tile={t} data={d} calendar={calendar} defaults={defaults} editing={false} selected={null} onEdit={() => {}} onPick={() => {}} />} />}
      <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete this dashboard?" description="The tiles and layout go; the data in the tables stays." confirmLabel="Delete" destructive onConfirm={remove} />
    </div>
  )
}

function LiveTable({ table, onChange }: { table: string; onChange(): void }) {
  const id = platform.tables.get(table)?.id ?? null
  useLiveTopic(id ? `table:${id}` : null, onChange)
  return null
}

/* ------------------------------------------------------------------ the grid */

const itemsOf = (d: DashboardDef): GridItem[] => d.tiles.map((t) => ({ id: t.id, ...t.layout }))
/** the definition with the items' places (the same object when nothing moved, so nothing refreshes) */
function withLayout(d: DashboardDef, items: GridItem[]): DashboardDef {
  let changed = false
  const tiles = d.tiles.map((t) => {
    const i = items.find((x) => x.id === t.id)
    if (!i || (i.x === t.layout.x && i.y === t.layout.y && i.w === t.layout.w && i.h === t.layout.h)) return t
    changed = true
    return { ...t, layout: { x: i.x, y: i.y, w: i.w, h: i.h } }
  })
  return changed ? { ...d, tiles } : d
}
const sameItems = (a: GridItem[], b: GridItem[]) => a.length === b.length && a.every((x, i) => x.id === b[i]!.id && x.x === b[i]!.x && x.y === b[i]!.y && x.w === b[i]!.w && x.h === b[i]!.h)

type DragProps = Pick<React.HTMLAttributes<HTMLElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'>
/** what a tile needs from the grid to be moved or resized with the pointer */
interface Chrome { canDrag: boolean; dragging: boolean; grip: DragProps; corner: DragProps }

/**
 * 12 columns of ROW_PX rows. On a tablet (the grid area under 1024 px) six columns derived from the 12-column layout
 * (grid.ts `deriveColumns`: nothing stored), one column in reading order under 640 px. In edit mode on a computer the
 * pointer moves a tile (its grip) or resizes it (the corner handle): the pointer is captured, so mouse, touch and pen work
 * and the drag survives leaving the handle; the tile snaps to whole cells, the tiles it lands on are pushed down and the
 * rest rises to close gaps (grid.ts `place`), previewed live; releasing keeps it, Escape or a cancelled touch drops it.
 */
export function Grid({ def, editing, onLayout, children, rowPx = ROW_PX }: { def: DashboardDef; editing: boolean; onLayout(items: GridItem[]): void; children(t: TileDef, chrome: Chrome): React.ReactNode; rowPx?: number }) {
  const rowH = rowPx
  const [ref, size] = useBoxSize<HTMLDivElement>()
  const mode = layoutModeFor(size.width)
  const cols = columnsFor(mode)
  const base = useMemo(() => itemsOf(def), [def])
  const [drag, setDrag] = useState<{ id: string; items: GridItem[] } | null>(null)
  const session = useRef<{ id: string; kind: 'move' | 'resize'; pointerId: number; x0: number; y0: number; steps: { col: number; row: number }; start: GridItem; items: GridItem[] } | null>(null)
  const canDrag = editing && mode === 'desktop'
  const end = (commit: boolean) => {
    const s = session.current
    session.current = null
    setDrag(null)
    if (commit && s) onLayout(s.items)
  }
  useEffect(() => {
    if (!drag) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { session.current = null; setDrag(null) } }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [drag])
  useEffect(() => { if (!editing) { session.current = null; setDrag(null) } }, [editing])

  const handlers = (id: string, kind: 'move' | 'resize'): DragProps => ({
    onPointerDown: (e) => {
      if (!canDrag || !ref.current || (e.pointerType === 'mouse' && e.button !== 0)) return
      const start = base.find((i) => i.id === id)
      if (!start) return
      e.preventDefault()
      e.stopPropagation()
      try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* the drag still follows the pointer over the handle */ }
      session.current = { id, kind, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, steps: cellSteps(ref.current.clientWidth, GRID_COLS, GAP_PX, rowH), start, items: base }
      setDrag({ id, items: base })
    },
    onPointerMove: (e) => {
      const s = session.current
      if (!s || s.id !== id || s.kind !== kind || e.pointerId !== s.pointerId) return
      const dx = e.clientX - s.x0, dy = e.clientY - s.y0
      const items = place(base, id, kind === 'move' ? dragRect(s.start, dx, dy, s.steps) : resizeRect(s.start, dx, dy, s.steps), GRID_COLS, true)
      if (!sameItems(items, s.items)) { s.items = items; setDrag({ id, items }) }
    },
    onPointerUp: (e) => {
      if (session.current?.id !== id || session.current.kind !== kind) return
      try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* already released */ }
      end(true)
    },
    onPointerCancel: () => { if (session.current?.id === id && session.current.kind === kind) end(false) },
  })

  const shown: GridItem[] = mode === 'desktop' ? (drag?.items ?? base) : mode === 'tablet' ? deriveColumns(base, cols) : readingOrder(base)
  const at = new Map(shown.map((i) => [i.id, i]))
  const tiles = readingOrder(shown).map((i) => def.tiles.find((t) => t.id === i.id)!)
  return (
    <>
      {editing && mode !== 'desktop' && (
        <p className="mb-2 rounded-md border bg-card px-3 py-1.5 text-xs text-muted-foreground" data-testid="dashboard-layout-hint">
          {mode === 'tablet' ? 'The window is narrow, so the tiles are shown in 6 columns. ' : 'The window is narrow, so the tiles are shown in one column. '}
          Dragging needs a wider window; the buttons on each tile (and the arrow keys on its grip) change the saved 12-column layout at any width.
        </p>
      )}
      <div ref={ref} className="grid gap-3" data-testid="dashboard-grid" data-layout={mode === 'desktop' ? 'grid' : mode} data-dragging={drag ? 'true' : undefined}
        style={mode === 'phone' ? { gridTemplateColumns: '1fr' } : { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: `${rowH}px` }}>
        {tiles.map((t) => {
          const L = at.get(t.id)!
          const dragging = drag?.id === t.id
          return (
            <div key={t.id} style={mode === 'phone' ? { height: Math.max(3, t.layout.h) * rowH } : { gridColumn: `${L.x + 1} / span ${L.w}`, gridRow: `${L.y + 1} / span ${L.h}` }}
              className={cn('relative min-h-0 min-w-0', dragging && 'z-10 opacity-90 shadow-lg')}>
              {children(t, { canDrag, dragging, grip: handlers(t.id, 'move'), corner: handlers(t.id, 'resize') })}
            </div>
          )
        })}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ a tile */

/**
 * One tile. `bare`: read only and without the tile's own buttons (table view, export, drill-through, pin) and without
 * pointer interaction on the chart: the kiosk page and the pinned tiles on Home use it. `onPin`: the viewer's pin button.
 */
export function Tile({ tile, data, calendar, defaults, editing, selected, onEdit, onPick, onConfigure, onStep, onOpen, chrome, bare = false, pinned, onPin, titleClass }: {
  tile: TileDef; data?: TileData; calendar: CalendarSettings; defaults: { locale: string; currency: string; timeZone: string }
  editing: boolean; selected: string | null; onEdit(f: (t: TileDef) => TileDef | null): void; onPick(row: Record<string, unknown>): void; onConfigure?(): void
  onStep?(d: { dx?: number; dy?: number; dw?: number; dh?: number }): void; onOpen?(): void; chrome?: Chrome
  bare?: boolean; pinned?: boolean; onPin?(): void; titleClass?: string
}) {
  const [tableView, setTableView] = useState(false)
  const appName = usePlatform((s) => (tile.drill ? s.apps.find((a) => a.id === tile.drill!.appId)?.name : undefined))
  const scene = useRef<{ scene: Scene; spec: ChartSpec } | null>(null)
  const rows = useMemo(() => data?.rows ?? [], [data])
  const spec = useMemo(() => {
    const s = tileChartSpec(tile, rows, { width: 100, height: 100 }, { calendar, defaults, selected })
    const { width: _w, height: _h, ...rest } = s
    void _w; void _h
    return rest
  }, [tile, rows, calendar, defaults, selected])
  const L = tile.layout
  const move = (dx: number, dy: number, dw: number, dh: number) => onStep?.({ dx, dy, dw, dh })
  const keys: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
  return (
    <section className={cn('relative flex size-full min-h-0 flex-col rounded-lg border bg-card p-3', editing && 'ring-1 ring-dashed ring-primary/40', chrome?.dragging && 'ring-2 ring-solid ring-primary')} aria-label={tile.title} data-testid={`tile-${tile.id}`} data-state={data?.error ? 'error' : data ? 'ready' : 'loading'}>
      <header className={cn('mb-1 flex shrink-0 items-center gap-1', editing && 'flex-wrap')}>
        {editing && chrome && (
          <button type="button" {...chrome.grip} style={{ touchAction: 'none' }} className={cn('rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground', chrome.canDrag && 'cursor-grab active:cursor-grabbing')}
            aria-label={`Move ${tile.title || 'the tile'}: drag it, or use the arrow keys; with Shift the arrow keys resize`} title={chrome.canDrag ? 'Drag to move. Arrow keys also move it; Shift + arrows resize.' : 'Dragging needs a wider window. Arrow keys move it; Shift + arrows resize.'}
            onKeyDown={(e) => { const k = keys[e.key]; if (!k || !onStep) return; e.preventDefault(); if (e.shiftKey) move(0, 0, k[0], k[1]); else move(k[0], k[1], 0, 0) }}
            data-testid={`tile-${tile.id}-grip`}><GripVertical className="size-4" /></button>
        )}
        <h2 className={cn('min-w-0 flex-1 truncate text-sm font-medium', editing && 'basis-16', titleClass)}>{tile.title}</h2>
        {!editing && !bare && onPin && (
          <button type="button" className={cn('rounded p-1 hover:bg-muted', pinned ? 'text-primary' : 'text-muted-foreground')} aria-pressed={!!pinned}
            aria-label={pinned ? `Unpin ${tile.title || 'the tile'} from My dashboard` : `Pin ${tile.title || 'the tile'} to My dashboard`} title={pinned ? 'Pinned to My dashboard (click to unpin)' : 'Pin to My dashboard (on your home page)'}
            onClick={onPin} data-testid={`tile-${tile.id}-pin`}>{pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}</button>
        )}
        {!editing && !bare && tile.drill && onOpen && (
          <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label={`Open ${appName ?? 'the app'}`} title={`Open ${appName ?? 'the app'}`} onClick={onOpen} data-testid={`tile-${tile.id}-open`}><ExternalLink className="size-3.5" /></button>
        )}
        {!editing && !bare && tile.kind !== 'text' && tile.kind !== 'table' && data && !data.error && <>
          <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted" aria-pressed={tableView} aria-label={tableView ? 'Show the chart' : 'Show the data as a table'} onClick={() => setTableView((v) => !v)} data-testid={`tile-${tile.id}-tableview`}><Table2 className="size-3.5" /></button>
          <ExportMenu title={tile.title} get={() => scene.current} rows={rows} />
        </>}
        {editing && <div className="flex shrink-0 items-center" role="group" aria-label={`Layout of ${tile.title}`}>
          {onConfigure && <IconBtn label="Edit tile" onClick={onConfigure} icon={Pencil} testId={`tile-${tile.id}-configure`} />}
          <IconBtn label="Narrower" onClick={() => move(0, 0, -1, 0)} icon={Minus} testId={`tile-${tile.id}-narrower`} />
          <span className="px-1 text-[10.5px] tabular-nums text-muted-foreground">{L.w}x{L.h}</span>
          <IconBtn label="Wider" onClick={() => move(0, 0, 1, 0)} icon={Plus} testId={`tile-${tile.id}-wider`} />
          <IconBtn label="Taller" onClick={() => move(0, 0, 0, 1)} icon={ArrowDown} testId={`tile-${tile.id}-taller`} />
          <IconBtn label="Shorter" onClick={() => move(0, 0, 0, -1)} icon={ArrowUp} testId={`tile-${tile.id}-shorter`} />
          <IconBtn label="Move left" onClick={() => move(-1, 0, 0, 0)} icon={ArrowLeft} testId={`tile-${tile.id}-left`} />
          <IconBtn label="Move right" onClick={() => move(1, 0, 0, 0)} icon={ArrowRight} testId={`tile-${tile.id}-right`} />
          <IconBtn label="Move up" onClick={() => move(0, -1, 0, 0)} icon={ArrowUp} testId={`tile-${tile.id}-up`} />
          <IconBtn label="Move down" onClick={() => move(0, 1, 0, 0)} icon={ArrowDown} testId={`tile-${tile.id}-down`} />
          <IconBtn label="Remove tile" onClick={() => onEdit(() => null)} icon={Trash2} testId={`tile-${tile.id}-remove`} />
        </div>}
      </header>
      <div className="min-h-0 flex-1">
        {tile.kind === 'text' ? <p className="whitespace-pre-wrap text-sm text-muted-foreground">{tile.text}</p>
          : !data ? <div className="flex size-full items-center justify-center"><Spinner /></div>
          : data.error ? <div className="flex size-full flex-col items-center justify-center gap-1 text-center text-xs text-muted-foreground" role="alert" data-testid={`tile-${tile.id}-error`}><TriangleAlert className="size-4 text-destructive" />{data.status === 503 ? 'The query took too long. ' : ''}{data.error}</div>
          : tile.kind === 'table' ? <TableTile tile={tile} rows={rows} defaults={defaults} onPick={onPick} />
          : <VizView spec={spec} rows={rows} interactive={!editing && !bare} tableView={tableView} testId={`tile-${tile.id}-viz`} onPick={(d) => d.row && onPick(d.row)} onScene={(s, sp) => { scene.current = { scene: s, spec: sp } }} />}
      </div>
      {editing && chrome?.canDrag && (
        <span {...chrome.corner} style={{ touchAction: 'none' }} className="absolute bottom-0 right-0 z-10 flex size-7 cursor-se-resize items-end justify-end p-1.5" aria-hidden data-testid={`tile-${tile.id}-resize`}><span className="size-3 rounded-br border-b-2 border-r-2 border-primary/70" /></span>
      )}
      {data?.filtered && !data.error && <footer className="mt-1 shrink-0 truncate text-[10.5px] text-muted-foreground" title="Your access limits the rows this tile counts." data-testid={`tile-${tile.id}-filtered`}>Based on the rows you can see</footer>}
    </section>
  )
}

function IconBtn({ label, onClick, icon: I, testId }: { label: string; onClick(): void; icon: typeof Plus; testId: string }) {
  return <button type="button" aria-label={label} title={label} onClick={onClick} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" data-testid={testId}><I className="size-3.5" /></button>
}

function ExportMenu({ title, get, rows }: { title: string; get(): { scene: Scene; spec: ChartSpec } | null; rows: Record<string, unknown>[] }) {
  const [open, setOpen] = useState(false)
  const x = (f: (s: { scene: Scene; spec: ChartSpec }) => void) => () => { const s = get(); if (s) f(s); setOpen(false) }
  return (
    <div className="relative">
      <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label="Export" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Download className="size-3.5" /></button>
      {open && (
        <div className="absolute right-0 top-6 z-20 flex w-28 flex-col rounded-md border bg-popover p-1 text-xs shadow-md" role="menu">
          <button role="menuitem" type="button" className="rounded px-2 py-1 text-left hover:bg-muted" onClick={x((s) => exportPng(s.spec, rows, title))}>PNG image</button>
          <button role="menuitem" type="button" className="rounded px-2 py-1 text-left hover:bg-muted" onClick={x((s) => exportSvg(s.spec, rows, title))}>SVG image</button>
          <button role="menuitem" type="button" className="rounded px-2 py-1 text-left hover:bg-muted" onClick={x((s) => exportCsv(s.scene, title))}>CSV data</button>
        </div>
      )}
    </div>
  )
}

/** table tile: group columns and measures, conditional formatting from the visual's rules, click = cross-filter */
function TableTile({ tile, rows, defaults, onPick }: { tile: TileDef; rows: Record<string, unknown>[]; defaults: { locale: string; currency: string; timeZone: string }; onPick(r: Record<string, unknown>): void }) {
  const groups = tile.query?.groupBy ?? []
  const cols: SeriesSpec[] = tile.visual?.series ?? (tile.query?.measures ?? []).map((m) => ({ key: m.id, label: m.label ?? m.id }))
  const status = (key: string, v: unknown): string | undefined => {
    if (typeof v !== 'number') return undefined
    for (const r of tile.visual?.rules ?? []) {
      if (r.measure !== key) continue
      const ok = r.op === 'lt' ? v < r.value : r.op === 'le' ? v <= r.value : r.op === 'gt' ? v > r.value : v >= r.value
      if (ok) return r.status
    }
    return undefined
  }
  const color: Record<string, string> = { good: 'var(--viz-good)', warn: 'var(--viz-warn)', bad: 'var(--viz-bad)' }
  if (!rows.length) return <div className="flex size-full items-center justify-center text-sm text-muted-foreground">No data</div>
  return (
    <div className="size-full overflow-auto">
      <table className="w-full border-collapse text-xs" data-testid={`tile-${tile.id}-table`}>
        <thead><tr>{[...groups, ...cols.map((c) => c.label ?? c.key)].map((h, i) => <th key={i} scope="col" className={cn('sticky top-0 border-b bg-card px-2 py-1 font-medium text-muted-foreground', i >= groups.length ? 'text-right' : 'text-left')}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={cn('border-b border-border/60', (tile.crossFilter || tile.drill) && 'cursor-pointer hover:bg-muted/60')} onClick={() => onPick(r)} tabIndex={tile.crossFilter || tile.drill ? 0 : undefined} onKeyDown={(e) => { if (e.key === 'Enter') onPick(r) }}>
              {groups.map((g) => <td key={g} className="px-2 py-1">{r[g] === null || r[g] === undefined ? '(blank)' : String(r[g])}</td>)}
              {cols.map((c) => {
                const st = status(c.key, r[c.key])
                return <td key={c.key} className="px-2 py-1 text-right tabular-nums" style={st ? { color: color[st], fontWeight: 600 } : undefined} data-status={st}>{formatNumber(r[c.key], c.format ?? tile.visual?.format ?? {}, defaults)}{st === 'bad' ? ' ▼' : st === 'good' ? ' ▲' : ''}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
