/**
 * Dashboards (P2-C): the list, the viewer and the layout editor (#u-dashboards, #u-dashboards?d=<id>; Dev and User
 * mode). One batch request per refresh (server: POST /dashboards/query), tiles on a 12-column grid that becomes one
 * column at phone width, a date range and filters, cross-filtering by clicking a category, live refresh when a table
 * changes (previous rows stay on screen until the new ones arrive), auto-refresh, per-tile errors and the "based on the
 * rows you can see" note. Makers create dashboards from the "Production overview" template (with SAMPLE tables when
 * the plant tables do not exist yet) and edit the layout (size, position, remove) and the title.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Download, Factory, LayoutDashboard, Minus, Pencil, Plus, RefreshCw, Save, Table2, Trash2, TriangleAlert, X } from 'lucide-react'
import { platform, usePlatform } from '@/platform'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { useLiveTopic } from '@/platform/useLive'
import type { DashboardDef, DashboardInfo, TileDef } from '@/dashboards/types'
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
import { dashboardsApi, DEFAULT_SETTINGS } from './api'
import type { DashboardSettings } from './api'

const sel = 'h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30'
const ROW_PX = 80

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
      <PageHeader icon={LayoutDashboard} title="Dashboards" subtitle="Charts and KPIs over your tables. Everyone sees only the rows their own access allows." />
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
  const { toast, fail } = useToast()
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
      const saved = await dashboardsApi.update(info.id, { def, name: def.title })
      onSaved(saved)
      setDef(saved.def)
      setEditing(false)
      toast('Dashboard saved.', 'success')
    } catch (e) { fail(e) }
  }
  const remove = async () => {
    try { await dashboardsApi.remove(info.id); openDashboard(null) } catch (e) { fail(e) }
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
          {info.canEdit && !editing && <Button variant="outline" size="sm" onClick={() => setEditing(true)} data-testid="dashboard-edit"><Pencil /> Edit</Button>}
          {editing && <>
            <Button variant="outline" size="sm" onClick={() => { setDef(info.def); setEditing(false) }}>Cancel</Button>
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)} data-testid="dashboard-delete"><Trash2 /> Delete</Button>
            <Button size="sm" onClick={save} data-testid="dashboard-save"><Save /> Save</Button>
          </>}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-canvas p-3">
        {loading && !Object.keys(data).length ? <div className="flex justify-center p-10"><Spinner /></div> : (
          <Grid def={def}>
            {(t) => (
              <Tile key={t.id} tile={t} data={data[t.id]} calendar={calendar} defaults={defaults} editing={editing}
                selected={cross && cross.tileId !== t.id ? null : cross?.tileId === t.id ? (cross.value === null ? '(blank)' : String(cross.value)) : null}
                onEdit={(f) => editTile(t.id, f)}
                onPick={(row) => {
                  if (!t.crossFilter || !t.query || editing) return
                  const col = t.query.groupBy?.[0]
                  if (!col) return
                  const v = row[col] ?? null
                  setCross((c) => (c && c.tileId === t.id && c.value === v ? null : { tileId: t.id, table: t.query!.table, column: col, value: v }))
                }} />
            )}
          </Grid>
        )}
      </div>
      <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete this dashboard?" description="The tiles and layout go; the data in the tables stays." confirmLabel="Delete" destructive onConfirm={remove} />
    </div>
  )
}

function LiveTable({ table, onChange }: { table: string; onChange(): void }) {
  const id = platform.tables.get(table)?.id ?? null
  useLiveTopic(id ? `table:${id}` : null, onChange)
  return null
}

/** 12 columns of ROW_PX rows; one column (in layout order) when the area is narrower than 640 px */
function Grid({ def, children }: { def: DashboardDef; children(t: TileDef): React.ReactNode }) {
  const [ref, size] = useBoxSize<HTMLDivElement>()
  const phone = size.width > 0 && size.width < 640
  const tiles = [...def.tiles].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
  return (
    <div ref={ref} className="grid gap-3" data-testid="dashboard-grid" data-layout={phone ? 'phone' : 'grid'}
      style={phone ? { gridTemplateColumns: '1fr' } : { gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gridAutoRows: `${ROW_PX}px` }}>
      {tiles.map((t) => (
        <div key={t.id} style={phone ? { height: Math.max(3, t.layout.h) * ROW_PX } : { gridColumn: `${t.layout.x + 1} / span ${t.layout.w}`, gridRow: `${t.layout.y + 1} / span ${t.layout.h}` }} className="min-h-0 min-w-0">
          {children(t)}
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ a tile */

function Tile({ tile, data, calendar, defaults, editing, selected, onEdit, onPick }: {
  tile: TileDef; data?: TileData; calendar: CalendarSettings; defaults: { locale: string; currency: string; timeZone: string }
  editing: boolean; selected: string | null; onEdit(f: (t: TileDef) => TileDef | null): void; onPick(row: Record<string, unknown>): void
}) {
  const [tableView, setTableView] = useState(false)
  const scene = useRef<{ scene: Scene; spec: ChartSpec } | null>(null)
  const rows = useMemo(() => data?.rows ?? [], [data])
  const spec = useMemo(() => {
    const s = tileChartSpec(tile, rows, { width: 100, height: 100 }, { calendar, defaults, selected })
    const { width: _w, height: _h, ...rest } = s
    void _w; void _h
    return rest
  }, [tile, rows, calendar, defaults, selected])
  const L = tile.layout
  const move = (dx: number, dy: number, dw: number, dh: number) => onEdit((t) => {
    const w = Math.min(12, Math.max(1, t.layout.w + dw))
    return { ...t, layout: { x: Math.min(12 - w, Math.max(0, t.layout.x + dx)), y: Math.max(0, t.layout.y + dy), w, h: Math.min(12, Math.max(1, t.layout.h + dh)) } }
  })
  return (
    <section className={cn('flex size-full min-h-0 flex-col rounded-lg border bg-card p-3', editing && 'ring-1 ring-dashed ring-primary/40')} aria-label={tile.title} data-testid={`tile-${tile.id}`} data-state={data?.error ? 'error' : data ? 'ready' : 'loading'}>
      <header className="mb-1 flex shrink-0 items-center gap-1">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{tile.title}</h2>
        {!editing && tile.kind !== 'text' && tile.kind !== 'table' && data && !data.error && <>
          <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted" aria-pressed={tableView} aria-label={tableView ? 'Show the chart' : 'Show the data as a table'} onClick={() => setTableView((v) => !v)} data-testid={`tile-${tile.id}-tableview`}><Table2 className="size-3.5" /></button>
          <ExportMenu title={tile.title} get={() => scene.current} rows={rows} />
        </>}
        {editing && <div className="flex items-center" role="group" aria-label={`Layout of ${tile.title}`}>
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
          : <VizView spec={spec} rows={rows} interactive={!editing} tableView={tableView} testId={`tile-${tile.id}-viz`} onPick={(d) => d.row && onPick(d.row)} onScene={(s, sp) => { scene.current = { scene: s, spec: sp } }} />}
      </div>
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
            <tr key={i} className={cn('border-b border-border/60', tile.crossFilter && 'cursor-pointer hover:bg-muted/60')} onClick={() => onPick(r)} tabIndex={tile.crossFilter ? 0 : undefined} onKeyDown={(e) => { if (e.key === 'Enter') onPick(r) }}>
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
