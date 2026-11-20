/**
 * The visual tile query editor (P2-C, Phase 2 wave 1): opened from a dashboard's edit mode ("Add tile", "Edit tile").
 * The maker picks the table, kind and title, measures (sum / average / minimum / maximum of a number column, count with
 * an optional condition, count of different values), simple calculations over measures, group columns and a date
 * grouping, the date range column, a fixed filter, sort, top N (+ the rest), comparison, running totals, targets and
 * the chart's fields and formats, by clicking only. A live preview runs the tile through the viewer's own path
 * (buildBatch -> dashboardsApi.query -> assemble: POST /dashboards/query on the server, the local executor in demo
 * mode) and draws it with the viewer's tile. "Apply" puts the tile into the dashboard draft through checkDashboardDef;
 * the dashboard's Save keeps it. All logic is in src/dashboards/editor.ts; the draft TileDef is the state, so fields
 * this screen does not show survive editing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Info, Plus, RotateCcw, Trash2, TriangleAlert, X } from 'lucide-react'
import { platform, usePlatform } from '@/platform'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import type { DateBucketUnit, MeasureFn } from '@/platform/query'
import type { DashboardDef, TileDef, TileDrill, TileKind } from '@/dashboards/types'
import type { CalendarSettings, RangePreset } from '@/dashboards/dates'
import { localNow, rangeLabel, resolvePreset } from '@/dashboards/dates'
import { assemble, buildBatch } from '@/dashboards/viewer'
import type { TileData } from '@/dashboards/viewer'
import type { MeasureSpec, QuerySpec } from '@/dashboards/measures'
import type { CalcOp, CalcOperand, EditorColumn, FormatChoice } from '@/dashboards/editor'
import {
  BUCKET_UNIT_LABELS, CALC_OP_LABELS, COMPARE_LABELS, FORMAT_LABELS, MEASURE_FN_LABELS, TILE_KIND_LABELS, TILE_KIND_OPTIONS,
  addComputed, addMeasure, applyTile, availableSeries, blocking, bucketUnitsFor, calcOfSimple, dateColumns, describeCalc, describeMeasure,
  describeNumExpr, describeTile, editorColumns, previewDef, effectiveSeries, formatChoiceOf, formatOfChoice, groupableColumns, newTile, numericColumns,
  removeValue, renameValue, resetSeries, seriesFormat, setBucket, setCompare, setComputedExpr, setDateColumn, setFilter, setGroupBy, setKind,
  setMeasureColumn, setMeasureFilter, setMeasureFn, setSeriesFormat, setSort, setTable, setTarget, setTop, setValueLabel, setVisual,
  setDrill, simpleCalcOf, toggleRunning, toggleSeries, usersOf, validateTile, valueIds,
} from '@/dashboards/editor'
import { defaultDrillParams, describeDrill, drillFields, paramNameOf } from '@/dashboards/drill'
import type { AppMeta } from '@/platform'
import { errMsg } from '../kit'
import { canRun } from '../workspace'
import { dashboardsApi } from './api'
import { ConditionBuilder, sel } from './ConditionBuilder'

export interface TileEditorProps {
  def: DashboardDef
  /** the tile to edit; null adds a new one */
  tile: TileDef | null
  range: RangePreset
  calendar: CalendarSettings
  onApply(def: DashboardDef): void
  onClose(): void
  /** draws a tile exactly as the viewer does (DashboardsPage's Tile) */
  renderTile(tile: TileDef, data: TileData | undefined): ReactNode
}

const FORMAT_CHOICES: FormatChoice[] = ['auto', 'number', 'decimal', 'currency', 'percent', 'compact']
const CARTESIAN: TileKind[] = ['bar', 'line', 'area', 'combo', 'pie', 'donut', 'funnel', 'pareto', 'scatter', 'histogram', 'timeline', 'heatmap']

export function TileEditor({ def, tile: initial, range, calendar, onApply, onClose, renderTile }: TileEditorProps) {
  const tables = usePlatform((s) => s.tables)
  const columnsOf = useCallback((t: string): EditorColumn[] | null => {
    const d = tables.find((x) => x.name.toLowerCase() === t.toLowerCase() || x.id === t) ?? platform.tables.get(t)
    return d ? editorColumns(d.columns) : null
  }, [tables])
  const [tile, setTile] = useState<TileDef>(() => (initial ? JSON.parse(JSON.stringify(initial)) as TileDef : newTile(def)))
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [applyError, setApplyError] = useState<string | null>(null)
  const q = tile.query
  const table = q?.table ?? ''
  const cols = useMemo(() => (table ? columnsOf(table) : null) ?? [], [table, columnsOf])
  const apps = usePlatform((s) => s.apps)
  const runnable = useMemo(() => apps.filter((a) => canRun(a.id)).sort((a, b) => a.name.localeCompare(b.name)), [apps])
  const issues = useMemo(() => validateTile(tile, columnsOf, (id) => runnable.some((a) => a.id === id)), [tile, columnsOf, runnable])
  const errors = [...blocking(issues).map((i) => i.message), ...Object.values(fieldErrors)]
  const warnings = issues.filter((i) => i.level === 'warning').map((i) => i.message)
  const up = (f: (t: TileDef) => TileDef) => { setApplyError(null); setTile((t) => f(t)) }
  const fieldError = useCallback((key: string) => (m: string | null) => setFieldErrors((e) => {
    if ((e[key] ?? null) === m) return e
    const n = { ...e }
    if (m) n[key] = m; else delete n[key]
    return n
  }), [])

  /* ---------------------------------------------------------------- live preview (the viewer's own path) */
  const [preview, setPreview] = useState<{ data?: TileData; loading: boolean; ms?: number }>({ loading: false })
  const seq = useRef(0)
  const blocked = blocking(issues).length > 0
  useEffect(() => {
    const my = ++seq.current
    if (tile.kind === 'text' || blocked) { setPreview({ loading: false }); return }
    setPreview((p) => ({ ...p, loading: true }))
    const h = setTimeout(async () => {
      try {
        const r = resolvePreset(range, new Date(), calendar)
        const choices = { range: r, now: localNow(new Date(), calendar.timeZone), filters: {}, cross: null, calendar, columns: (t: string) => columnsOf(t)?.map((c) => c.name) ?? null }
        const d = previewDef(def, tile)
        const b = buildBatch(d, choices)
        const t0 = performance.now()
        const answers = await dashboardsApi.query(b.queries)
        if (my !== seq.current) return
        setPreview({ loading: false, ms: Math.round(performance.now() - t0), data: assemble(d, choices, answers, b.errors)[tile.id] ?? { rows: [], error: 'No answer for this tile.' } })
      } catch (e) {
        if (my === seq.current) setPreview({ loading: false, data: { rows: [], error: errMsg(e) } })
      }
    }, 400)
    return () => clearTimeout(h)
  }, [tile, blocked, range, calendar, def, columnsOf])

  const apply = () => {
    try { onApply(applyTile(def, tile, initial ?? undefined)) } catch (e) { setApplyError(errMsg(e)) }
  }

  const tableList = useMemo(() => [...tables].sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name)), [tables])
  const labelOfCol = (c: string) => cols.find((x) => x.name.toLowerCase() === c.toLowerCase())?.label ?? c
  const valueLabel = (id: string) => q?.measures.find((m) => m.id === id)?.label ?? q?.computed?.find((c) => c.id === id)?.label ?? id
  const ids = valueIds(q)
  const isText = tile.kind === 'text'
  const hasTable = !!q?.table && cols.length > 0
  const r = resolvePreset(range, new Date(), calendar)

  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-none xl:w-[1180px]" data-testid="tile-editor"
        // a click outside (the dashboard, a toast) must not throw away the work: close with Cancel, the X or Escape
        onInteractOutside={(e) => e.preventDefault()}>
        <SheetHeader className="border-b">
          <SheetTitle>{initial ? 'Edit tile' : 'Add a tile'}</SheetTitle>
          <SheetDescription>Choose what the tile shows. The preview uses the dashboard's date range ({rangeLabel(r)}) and your own access.</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {/* preview: on top at tablet width, on the right on a computer */}
          <aside className="order-1 shrink-0 border-b bg-canvas p-3 lg:order-2 lg:w-[420px] lg:overflow-auto lg:border-b-0 lg:border-l" aria-label="Preview" data-testid="tile-editor-preview">
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Preview</span>
              {preview.loading && <span data-testid="tile-editor-preview-loading">updating…</span>}
              {!preview.loading && preview.ms !== undefined && <span>{preview.ms} ms</span>}
            </div>
            <div className="h-56 lg:h-72" data-testid="tile-editor-preview-tile" data-state={blocked && !isText ? 'blocked' : preview.data?.error ? 'error' : preview.data ? 'ready' : 'loading'}>
              {blocked && !isText ? (
                <div className="flex size-full flex-col items-center justify-center gap-1 rounded-lg border bg-card p-3 text-center text-xs text-muted-foreground" role="status">
                  <TriangleAlert className="size-4 text-destructive" />
                  <span>The preview runs when the problems below are fixed.</span>
                  <span className="text-foreground">{blocking(issues)[0]?.message}</span>
                </div>
              ) : renderTile(tile, isText ? undefined : preview.data)}
            </div>
            <ul className="mt-3 hidden list-disc space-y-0.5 pl-4 text-xs text-muted-foreground lg:block" data-testid="tile-editor-summary">
              {describeTile(tile, columnsOf).map((l, i) => <li key={i}>{l}</li>)}
            </ul>
          </aside>

          <div className="order-2 min-h-0 flex-1 overflow-auto lg:order-1">
            <Section title="Tile">
              <div className="grid gap-3 sm:grid-cols-2">
                <Labeled label="Title"><Input className="h-8" value={tile.title} onChange={(e) => up((t) => ({ ...t, title: e.target.value }))} data-testid="tile-editor-title" /></Labeled>
                <Labeled label="Kind">
                  <select className={sel} value={tile.kind} onChange={(e) => up((t) => setKind(t, e.target.value as TileKind))} data-testid="tile-editor-kind">
                    {TILE_KIND_OPTIONS.map((k) => <option key={k} value={k}>{TILE_KIND_LABELS[k]}</option>)}
                  </select>
                </Labeled>
                {!isText && (
                  <Labeled label="Table" className="sm:col-span-2">
                    <select className={sel} value={tableList.find((t) => t.name.toLowerCase() === (q?.table ?? '').toLowerCase())?.name ?? q?.table ?? ''} data-testid="tile-editor-table"
                      onChange={(e) => { const n = e.target.value; if (n) up((t) => setTable(t, n, columnsOf(n) ?? [])) }}>
                      {!q?.table && <option value="">Choose a table…</option>}
                      {q?.table && !columnsOf(q.table) && <option value={q.table}>{q.table} (not found)</option>}
                      {tableList.map((t) => <option key={t.id} value={t.name}>{t.displayName || t.name}</option>)}
                    </select>
                  </Labeled>
                )}
                {isText && (
                  <Labeled label="Text" className="sm:col-span-2">
                    <Textarea rows={5} value={tile.text ?? ''} onChange={(e) => up((t) => ({ ...t, text: e.target.value }))} data-testid="tile-editor-text" />
                  </Labeled>
                )}
              </div>
            </Section>

            {!isText && hasTable && q && <>
              <Section title="Measures" hint="What the tile adds up. Each measure is computed in the database under the viewer's access.">
                {q.measures.map((m) => (
                  <MeasureCard key={m.id} m={m} q={q} tile={tile} cols={cols} timeZone={calendar.timeZone} up={up} labelOfCol={labelOfCol} onError={fieldError(`m:${m.id}`)} />
                ))}
                <select className={cn(sel, 'w-fit')} value="" data-testid="tile-editor-add-measure" aria-label="Add a measure"
                  onChange={(e) => { const v = e.target.value; if (!v) return; up((t) => addMeasure(t, v === '__count' ? undefined : cols.find((c) => c.name === v))) }}>
                  <option value="">+ Add a measure…</option>
                  <option value="__count">Count of rows</option>
                  <optgroup label="Of a column">
                    {cols.filter((c) => c.kind !== 'other').map((c) => <option key={c.name} value={c.name}>{c.label}{c.kind === 'number' ? ' (sum)' : ' (count of different values)'}</option>)}
                  </optgroup>
                </select>
              </Section>

              <Section title="Calculations" hint="A calculation over the measures of each result row, such as Good ÷ Total. Division by zero gives a blank.">
                {(q.computed ?? []).map((c) => {
                  const simple = simpleCalcOf(c.expr)
                  return (
                    <Card key={c.id} testId={`tile-editor-calc-${c.id}`} onRemove={() => up((t) => removeValue(t, c.id))} removeLabel={`Remove ${c.label ?? c.id}`}>
                      <div className="flex flex-wrap items-end gap-2">
                        <Labeled label="Label"><Input className="h-8 w-44" value={c.label ?? ''} placeholder={c.id} onChange={(e) => up((t) => setValueLabel(t, c.id, e.target.value))} /></Labeled>
                        <NameInput id={c.id} tile={tile} setTile={up} onError={fieldError(`n:${c.id}`)} />
                        <FormatSelect tile={tile} k={c.id} up={up} />
                      </div>
                      {simple ? (
                        <div className="flex flex-wrap items-center gap-1.5" data-testid={`tile-editor-calc-${c.id}-expr`}>
                          <Operand value={simple.a} measures={q.measures} onChange={(a) => up((t) => setComputedExpr(t, c.id, calcOfSimple({ ...simple, a })))} />
                          <select className={sel} value={simple.op ?? ''} aria-label="Operator" onChange={(e) => {
                            const op = (e.target.value || undefined) as CalcOp | undefined
                            up((t) => setComputedExpr(t, c.id, calcOfSimple({ a: simple.a, op, b: simple.b ?? (q.measures[1] ? { m: q.measures[1].id } : 1) })))
                          }}>
                            <option value="">(nothing more)</option>
                            {(Object.keys(CALC_OP_LABELS) as CalcOp[]).map((o) => <option key={o} value={o}>{CALC_OP_LABELS[o]}</option>)}
                          </select>
                          {simple.op && simple.b !== undefined && <Operand value={simple.b} measures={q.measures} onChange={(b) => up((t) => setComputedExpr(t, c.id, calcOfSimple({ ...simple, b })))} />}
                        </div>
                      ) : (
                        <div className="grid gap-1.5 text-xs">
                          <div>= {describeCalc(c.expr, valueLabel)}</div>
                          <div className="text-muted-foreground">This calculation was written outside the editor and is kept as it is.</div>
                          <div><Button type="button" size="sm" variant="outline" onClick={() => up((t) => setComputedExpr(t, c.id, { m: q.measures[0]!.id }))}>Replace it with a simple calculation</Button></div>
                        </div>
                      )}
                    </Card>
                  )
                })}
                <div><Button type="button" size="sm" variant="outline" disabled={!q.measures.length} onClick={() => up(addComputed)} data-testid="tile-editor-add-calc"><Plus /> Add a calculation</Button></div>
              </Section>

              <Section title="Group by" hint="One result row per value of the group columns, then per period of the date grouping.">
                <div className="flex flex-wrap items-center gap-1.5" data-testid="tile-editor-groups">
                  {(q.groupBy ?? []).map((g) => (
                    <span key={g} className="flex h-7 items-center gap-1 rounded-full bg-accent px-2.5 text-xs text-accent-foreground">
                      {labelOfCol(g)}
                      <button type="button" aria-label={`Stop grouping by ${labelOfCol(g)}`} onClick={() => up((t) => setGroupBy(t, (t.query?.groupBy ?? []).filter((x) => x !== g)))}><X className="size-3" /></button>
                    </span>
                  ))}
                  <select className={cn(sel, 'w-fit')} value="" aria-label="Add a group column" data-testid="tile-editor-add-group"
                    onChange={(e) => { const v = e.target.value; if (v) up((t) => setGroupBy(t, [...(t.query?.groupBy ?? []), v])) }}>
                    <option value="">+ Group by a column…</option>
                    {groupableColumns(cols).filter((c) => !(q.groupBy ?? []).some((g) => g.toLowerCase() === c.name.toLowerCase())).map((c) => <option key={c.name} value={c.name}>{c.label}</option>)}
                  </select>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <Labeled label="Date grouping">
                    <select className={sel} value={q.bucket?.col ?? ''} data-testid="tile-editor-bucket-col" onChange={(e) => {
                      const c = cols.find((x) => x.name === e.target.value)
                      up((t) => setBucket(t, c ? { col: c.name, unit: t.query?.bucket && bucketUnitsFor(c.kind).includes(t.query.bucket.unit) ? t.query.bucket.unit : 'day' } : undefined))
                    }}>
                      <option value="">None</option>
                      {q.bucket && !dateColumns(cols).some((c) => c.name === q.bucket!.col) && <option value={q.bucket.col}>{q.bucket.col}</option>}
                      {dateColumns(cols).map((c) => <option key={c.name} value={c.name}>{c.label}</option>)}
                    </select>
                  </Labeled>
                  {q.bucket && (
                    <Labeled label="By">
                      <select className={sel} value={q.bucket.unit} data-testid="tile-editor-bucket-unit" onChange={(e) => up((t) => setBucket(t, { ...t.query!.bucket!, unit: e.target.value as DateBucketUnit }))}>
                        {bucketUnitsFor(cols.find((c) => c.name === q.bucket!.col)?.kind ?? 'datetime').map((u) => <option key={u} value={u}>{BUCKET_UNIT_LABELS[u]}</option>)}
                      </select>
                    </Labeled>
                  )}
                </div>
              </Section>

              <Section title="Rows counted" hint="Which rows of the table the tile reads.">
                <Labeled label="The dashboard's date range applies to">
                  <select className={cn(sel, 'w-fit')} value={q.dateColumn?.col ?? ''} data-testid="tile-editor-date-col" onChange={(e) => up((t) => setDateColumn(t, cols.find((c) => c.name === e.target.value)))}>
                    <option value="">No column (every date)</option>
                    {q.dateColumn && !dateColumns(cols).some((c) => c.name === q.dateColumn!.col) && <option value={q.dateColumn.col}>{q.dateColumn.col}</option>}
                    {dateColumns(cols).map((c) => <option key={c.name} value={c.name}>{c.label}</option>)}
                  </select>
                </Labeled>
                <div className="grid gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Only rows where</span>
                  <ConditionBuilder value={q.filter} columns={cols} timeZone={calendar.timeZone} onChange={(c) => up((t) => setFilter(t, c))} onError={fieldError('filter')} testId="tile-editor-filter" emptyText="Every row (no fixed filter)." />
                </div>
              </Section>

              <Section title="Sort and limit">
                <div className="flex flex-wrap items-end gap-2">
                  <Labeled label="Sort by">
                    <select className={sel} value={q.sort?.by ?? ''} data-testid="tile-editor-sort" onChange={(e) => { const by = e.target.value; up((t) => setSort(t, by ? { by, dir: t.query?.sort?.dir ?? 'desc' } : undefined)) }}>
                      <option value="">{q.bucket ? 'Date (default)' : 'Group value (default)'}</option>
                      {ids.map((id) => <option key={id} value={id}>{valueLabel(id)}</option>)}
                      {(q.groupBy ?? []).map((g) => <option key={g} value={g}>{labelOfCol(g)}</option>)}
                      {q.bucket && <option value="__bucket">Date grouping</option>}
                    </select>
                  </Labeled>
                  {q.sort && (
                    <Labeled label="Order">
                      <select className={sel} value={q.sort.dir} onChange={(e) => up((t) => setSort(t, { ...t.query!.sort!, dir: e.target.value as 'asc' | 'desc' }))} data-testid="tile-editor-sort-dir">
                        <option value="desc">Largest first</option>
                        <option value="asc">Smallest first</option>
                      </select>
                    </Labeled>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Check checked={!!q.top} onChange={(on) => up((t) => setTop(t, on ? { n: 10 } : undefined))} testId="tile-editor-top">Show only the top</Check>
                  {q.top && <>
                    <NumInput value={q.top.n} onChange={(n) => up((t) => setTop(t, { ...t.query!.top!, n: n ?? 0 }))} label="How many" className="w-20" testId="tile-editor-top-n" />
                    <Check checked={q.top.others !== undefined} onChange={(on) => up((t) => { const top = { ...t.query!.top! }; if (on) top.others = 'Others'; else delete top.others; return setTop(t, top) })} testId="tile-editor-others">and add up the rest as</Check>
                    {q.top.others !== undefined && <Input className="h-8 w-32" value={q.top.others} aria-label="Name of the rest" onChange={(e) => up((t) => setTop(t, { ...t.query!.top!, others: e.target.value }))} />}
                  </>}
                </div>
              </Section>

              <Section title="Comparison, running totals and targets">
                <Labeled label="Compare with">
                  <select className={cn(sel, 'w-fit')} value={q.compare ?? ''} data-testid="tile-editor-compare" onChange={(e) => up((t) => setCompare(t, (e.target.value || undefined) as QuerySpec['compare']))}>
                    <option value="">No comparison</option>
                    <option value="previousPeriod">{COMPARE_LABELS.previousPeriod}</option>
                    <option value="samePeriodLastYear">{COMPARE_LABELS.samePeriodLastYear}</option>
                  </select>
                </Labeled>
                {q.compare && <p className="text-xs text-muted-foreground">Each measure gets a comparison value; show it as a dashed series under "Chart" below, or as the KPI's base.</p>}
                <div className="grid gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Running total of</span>
                  <div className="flex flex-wrap gap-3">
                    {ids.map((id) => <Check key={id} checked={(q.running ?? []).includes(id)} onChange={(on) => up((t) => toggleRunning(t, id, on))} testId={`tile-editor-running-${id}`}>{valueLabel(id)}</Check>)}
                  </div>
                </div>
                <TargetEditor q={q} tables={tableList} columnsOf={columnsOf} up={up} />
              </Section>
            </>}

            {!isText && hasTable && q && <VisualEditor tile={tile} q={q} up={up} labelOfCol={labelOfCol} valueLabel={valueLabel} />}
            {!isText && hasTable && q && <DrillEditor tile={tile} apps={runnable} up={up} />}
            {!isText && !hasTable && q?.table && <p className="p-4 text-sm text-muted-foreground">The table {q.table} does not exist or you cannot see it. Choose another table.</p>}
          </div>
        </div>

        <footer className="shrink-0 border-t bg-card p-3" data-testid="tile-editor-footer">
          {(errors.length > 0 || warnings.length > 0 || applyError) && (
            <ul className="mb-2 max-h-28 space-y-0.5 overflow-auto text-xs" data-testid="tile-editor-issues">
              {applyError && <li className="flex gap-1.5 text-destructive" role="alert"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" />{applyError}</li>}
              {errors.map((m, i) => <li key={`e${i}`} className="flex gap-1.5 text-destructive"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" />{m}</li>)}
              {warnings.map((m, i) => <li key={`w${i}`} className="flex gap-1.5 text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" />{m}</li>)}
            </ul>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="mr-auto text-xs text-muted-foreground">Apply puts the tile on the dashboard; Save the dashboard to keep it.</span>
            <Button variant="outline" size="sm" onClick={onClose} data-testid="tile-editor-cancel">Cancel</Button>
            <Button size="sm" onClick={apply} disabled={errors.length > 0} data-testid="tile-editor-apply">{initial ? 'Apply' : 'Add to the dashboard'}</Button>
          </div>
        </footer>
      </SheetContent>
    </Sheet>
  )
}

/* ------------------------------------------------------------------ pieces */

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="grid gap-3 border-b p-4" aria-label={title}>
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function Labeled({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn('grid gap-1 text-xs', className)}>
      <span className="font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

function Check({ checked, onChange, children, testId, disabled }: { checked: boolean; onChange(on: boolean): void; children: ReactNode; testId?: string; disabled?: boolean }) {
  return (
    <label className={cn('flex items-center gap-1.5 text-sm', disabled && 'opacity-50')}>
      <input type="checkbox" className="size-4 accent-primary" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      {children}
    </label>
  )
}

function Card({ children, onRemove, removeLabel, removeDisabled, testId }: { children: ReactNode; onRemove(): void; removeLabel: string; removeDisabled?: string; testId: string }) {
  return (
    <div className="relative grid gap-2 rounded-md border bg-card p-2.5 pr-9" data-testid={testId}>
      <button type="button" className="absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40" aria-label={removeLabel} title={removeDisabled ?? removeLabel} disabled={!!removeDisabled} onClick={onRemove} data-testid={`${testId}-remove`}><Trash2 className="size-3.5" /></button>
      {children}
    </div>
  )
}

/** a number field that keeps what is being typed and reports a number (or undefined when empty) */
function NumInput({ value, onChange, label, className, testId }: { value: number | undefined; onChange(n: number | undefined): void; label: string; className?: string; testId?: string }) {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  useEffect(() => { setText((t) => (Number(t) === value && t !== '' ? t : value === undefined ? '' : String(value))) }, [value])
  return (
    <Input className={cn('h-8', className)} type="number" value={text} aria-label={label} data-testid={testId} onChange={(e) => {
      setText(e.target.value)
      if (e.target.value === '') onChange(undefined)
      else if (Number.isFinite(Number(e.target.value))) onChange(Number(e.target.value))
    }} />
  )
}

/** the name used in calculations; renaming updates every reference */
function NameInput({ id, tile, setTile, onError }: { id: string; tile: TileDef; setTile(f: (t: TileDef) => TileDef): void; onError(m: string | null): void }) {
  const [text, setText] = useState(id)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { setText(id) }, [id])
  const commit = () => {
    if (text === id) { setErr(null); onError(null); return }
    try {
      renameValue(tile, id, text)
      setErr(null); onError(null)
      setTile((t) => renameValue(t, id, text))
    } catch (e) {
      const m = errMsg(e)
      setErr(m); onError(m)
    }
  }
  return (
    <Labeled label="Name in calculations">
      <Input className="h-8 w-36 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit() }} aria-invalid={!!err} data-testid={`tile-editor-name-${id}`} />
      {err && <span className="text-destructive">{err}</span>}
    </Labeled>
  )
}

function FormatSelect({ tile, k, up }: { tile: TileDef; k: string; up(f: (t: TileDef) => TileDef): void }) {
  const cur = seriesFormat(tile, k)
  return (
    <Labeled label="Number format">
      <select className={sel} value={formatChoiceOf(cur)} data-testid={`tile-editor-format-${k}`} onChange={(e) => up((t) => setSeriesFormat(t, k, formatOfChoice(e.target.value as FormatChoice, seriesFormat(t, k))))}>
        {FORMAT_CHOICES.map((c) => <option key={c} value={c}>{FORMAT_LABELS[c]}</option>)}
      </select>
    </Labeled>
  )
}

function MeasureCard({ m, q, tile, cols, timeZone, up, labelOfCol, onError }: {
  m: MeasureSpec; q: QuerySpec; tile: TileDef; cols: EditorColumn[]; timeZone: string; up(f: (t: TileDef) => TileDef): void; labelOfCol(c: string): string; onError(m: string | null): void
}) {
  const users = usersOf(q, m.id)
  const fns: MeasureFn[] = numericColumns(cols).length ? ['sum', 'avg', 'min', 'max', 'count', 'countDistinct'] : ['count', 'countDistinct']
  const colChoices = m.fn === 'countDistinct' ? groupableColumns(cols) : numericColumns(cols)
  return (
    <Card testId={`tile-editor-measure-${m.id}`} onRemove={() => up((t) => removeValue(t, m.id))} removeLabel={`Remove ${m.label ?? m.id}`} removeDisabled={users.length ? `Used by ${users.join(', ')}: remove those calculations first.` : undefined}>
      <div className="flex flex-wrap items-end gap-2">
        <Labeled label="Label"><Input className="h-8 w-44" value={m.label ?? ''} placeholder={m.id} onChange={(e) => up((t) => setValueLabel(t, m.id, e.target.value))} data-testid={`tile-editor-label-${m.id}`} /></Labeled>
        <Labeled label="Function">
          <select className={sel} value={m.fn} data-testid={`tile-editor-fn-${m.id}`} onChange={(e) => up((t) => setMeasureFn(t, m.id, e.target.value as MeasureFn, cols))}>
            {(fns.includes(m.fn) ? fns : [m.fn, ...fns]).map((f) => <option key={f} value={f}>{MEASURE_FN_LABELS[f]}</option>)}
          </select>
        </Labeled>
        {m.fn !== 'count' && (
          <Labeled label={m.expr !== undefined ? 'Of' : 'Column'}>
            <select className={cn(sel, 'max-w-[13rem]')} value={m.expr !== undefined ? '' : m.col ?? ''} data-testid={`tile-editor-col-${m.id}`} onChange={(e) => { if (e.target.value) up((t) => setMeasureColumn(t, m.id, e.target.value)) }}>
              {m.expr !== undefined && <option value="">a calculation over the row</option>}
              {m.expr === undefined && (m.col === undefined || !colChoices.some((c) => c.name.toLowerCase() === m.col!.toLowerCase())) && <option value={m.col ?? ''}>{m.col ? `${m.col} (not usable)` : 'Choose…'}</option>}
              {colChoices.map((c) => <option key={c.name} value={c.name}>{c.label}</option>)}
            </select>
          </Labeled>
        )}
        <FormatSelect tile={tile} k={m.id} up={up} />
        <NameInput id={m.id} tile={tile} setTile={up} onError={onError} />
      </div>
      {m.expr !== undefined && m.fn !== 'count' && (
        <div className="text-xs text-muted-foreground">Calculation: {describeNumExpr(m.expr, labelOfCol)} (written outside the editor; kept as it is unless you choose a column).</div>
      )}
      {m.fn === 'count' && (
        <div className="grid gap-1">
          <span className="text-xs font-medium text-muted-foreground">Count only rows where</span>
          <ConditionBuilder value={m.filter} columns={cols} timeZone={timeZone} onChange={(c) => up((t) => setMeasureFilter(t, m.id, c))} onError={onError} testId={`tile-editor-count-filter-${m.id}`} emptyText="Every row is counted." />
        </div>
      )}
      <div className="text-xs text-muted-foreground" data-testid={`tile-editor-measure-${m.id}-summary`}>{describeMeasure(m, labelOfCol)}</div>
    </Card>
  )
}

function Operand({ value, measures, onChange }: { value: CalcOperand; measures: MeasureSpec[]; onChange(v: CalcOperand): void }) {
  const isNum = typeof value === 'number'
  return (
    <span className="flex items-center gap-1">
      <select className={cn(sel, 'max-w-[12rem]')} value={isNum ? '__n' : `m:${value.m}`} aria-label="Operand" onChange={(e) => onChange(e.target.value === '__n' ? 1 : { m: e.target.value.slice(2) })}>
        {!isNum && !measures.some((m) => m.id === value.m) && <option value={`m:${value.m}`}>{value.m} (missing)</option>}
        {measures.map((m) => <option key={m.id} value={`m:${m.id}`}>{m.label ?? m.id}</option>)}
        <option value="__n">A number</option>
      </select>
      {isNum && <NumInput value={value} onChange={(n) => onChange(n ?? 0)} label="Number" className="w-24" />}
    </span>
  )
}

function TargetEditor({ q, tables, columnsOf, up }: { q: QuerySpec; tables: { id: string; name: string; displayName: string }[]; columnsOf(t: string): EditorColumn[] | null; up(f: (t: TileDef) => TileDef): void }) {
  const t = q.target
  const tc = t?.table ? columnsOf(t.table) ?? [] : []
  const set = (patch: Partial<NonNullable<QuerySpec['target']>>) => up((x) => {
    const n = { ...x.query!.target!, ...patch } as Record<string, unknown>
    for (const k of Object.keys(n)) if (n[k] === undefined) delete n[k]
    return setTarget(x, n as NonNullable<QuerySpec['target']>)
  })
  return (
    <div className="grid gap-2">
      <Check checked={!!t} onChange={(on) => up((x) => setTarget(x, on ? { table: '', valueCol: '' } : undefined))} testId="tile-editor-target">Compare with targets from a table</Check>
      {t && (
        <div className="flex flex-wrap items-end gap-2 pl-6">
          <Labeled label="Targets table">
            <select className={sel} value={t.table} data-testid="tile-editor-target-table" onChange={(e) => {
              const name = e.target.value
              const c = columnsOf(name) ?? []
              const d = dateColumns(c)[0]
              set({ table: name, valueCol: numericColumns(c)[0]?.name ?? '', keyCol: undefined, dateCol: d ? { col: d.name, kind: d.kind as 'date' | 'datetime' } : undefined })
            }}>
              {!t.table && <option value="">Choose…</option>}
              {tables.map((x) => <option key={x.id} value={x.name}>{x.displayName || x.name}</option>)}
            </select>
          </Labeled>
          {t.table && <>
            <Labeled label="Target value">
              <select className={sel} value={t.valueCol} onChange={(e) => set({ valueCol: e.target.value })} data-testid="tile-editor-target-value">
                {!numericColumns(tc).some((c) => c.name === t.valueCol) && <option value={t.valueCol}>{t.valueCol || 'Choose…'}</option>}
                {numericColumns(tc).map((c) => <option key={c.name} value={c.name}>{c.label}</option>)}
              </select>
            </Labeled>
            <Labeled label={`Matches the first group column${q.groupBy?.[0] ? ` (${q.groupBy[0]})` : ''}`}>
              <select className={sel} value={t.keyCol ?? ''} onChange={(e) => set({ keyCol: e.target.value || undefined })} data-testid="tile-editor-target-key">
                <option value="">No key (one total target)</option>
                {groupableColumns(tc).map((c) => <option key={c.name} value={c.name}>{c.label}</option>)}
              </select>
            </Labeled>
            <Labeled label="Date range applies to">
              <select className={sel} value={t.dateCol?.col ?? ''} onChange={(e) => { const c = tc.find((x) => x.name === e.target.value); set({ dateCol: c ? { col: c.name, kind: c.kind as 'date' | 'datetime' } : undefined }) }} data-testid="tile-editor-target-date">
                <option value="">No column (every target row)</option>
                {dateColumns(tc).map((c) => <option key={c.name} value={c.name}>{c.label}</option>)}
              </select>
            </Labeled>
          </>}
        </div>
      )}
    </div>
  )
}

function VisualEditor({ tile, q, up, labelOfCol, valueLabel }: { tile: TileDef; q: QuerySpec; up(f: (t: TileDef) => TileDef): void; labelOfCol(c: string): string; valueLabel(id: string): string }) {
  const v = tile.visual ?? {}
  const shown = effectiveSeries(tile)
  const avail = availableSeries(q)
  const extra = (v.series ?? []).filter((s) => !avail.some((a) => a.key === s.key))
  const groups = [...(q.groupBy ?? []), ...(q.bucket ? ['__bucket'] : [])]
  const fieldLabel = (k: string) => (k === '__bucket' ? 'Date grouping' : labelOfCol(k))
  const kind = tile.kind
  return (
    <Section title={kind === 'table' ? 'Table' : 'Chart'} hint={kind === 'kpi' || kind === 'gauge' ? undefined : 'The values drawn. The comparison, running totals and the target can be drawn too.'}>
      {kind !== 'kpi' && (
        <div className="grid gap-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">{kind === 'table' ? 'Columns' : 'Series'}</span>
            {v.series && <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => up(resetSeries)} data-testid="tile-editor-series-reset"><RotateCcw className="size-3" /> Every measure</Button>}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1" data-testid="tile-editor-series">
            {avail.map((s) => <Check key={s.key} checked={shown.some((x) => x.key === s.key)} onChange={(on) => up((t) => toggleSeries(t, s.key, on, s.label))} testId={`tile-editor-series-${s.key}`}>{s.label}</Check>)}
            {extra.map((s) => <Check key={s.key} checked onChange={() => up((t) => toggleSeries(t, s.key, false))}>{s.label ?? s.key} (not produced by the query)</Check>)}
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        {CARTESIAN.includes(kind) && groups.length > 1 && (
          <Labeled label={kind === 'heatmap' ? 'Columns' : 'Category'}>
            <select className={sel} value={v.category ?? ''} onChange={(e) => up((t) => setVisual(t, { category: e.target.value || undefined }))} data-testid="tile-editor-category">
              <option value="">Default ({fieldLabel(q.bucket ? '__bucket' : q.groupBy?.[0] ?? '')})</option>
              {groups.map((g) => <option key={g} value={g}>{fieldLabel(g)}</option>)}
            </select>
          </Labeled>
        )}
        {kind === 'heatmap' && groups.length > 1 && (
          <Labeled label="Rows">
            <select className={sel} value={v.row ?? ''} onChange={(e) => up((t) => setVisual(t, { row: e.target.value || undefined }))} data-testid="tile-editor-row">
              <option value="">Default ({fieldLabel(q.groupBy?.[0] ?? '')})</option>
              {groups.map((g) => <option key={g} value={g}>{fieldLabel(g)}</option>)}
            </select>
          </Labeled>
        )}
        <Labeled label="Number format of the tile">
          <select className={sel} value={formatChoiceOf(v.format)} onChange={(e) => up((t) => setVisual(t, { format: formatOfChoice(e.target.value as FormatChoice, t.visual?.format) }))} data-testid="tile-editor-tile-format">
            {FORMAT_CHOICES.map((c) => <option key={c} value={c}>{FORMAT_LABELS[c]}</option>)}
          </select>
        </Labeled>
        {(kind === 'bar' || kind === 'area' || kind === 'combo') && (
          <Labeled label="Stacking">
            <select className={sel} value={v.stack ?? 'none'} onChange={(e) => up((t) => setVisual(t, { stack: e.target.value === 'none' ? undefined : e.target.value as 'stacked' | 'percent' }))} data-testid="tile-editor-stack">
              <option value="none">Side by side</option>
              <option value="stacked">Stacked</option>
              <option value="percent">Stacked to 100%</option>
            </select>
          </Labeled>
        )}
        {kind === 'bar' && (
          <Labeled label="Bars">
            <select className={sel} value={v.orientation ?? 'vertical'} onChange={(e) => up((t) => setVisual(t, { orientation: e.target.value === 'horizontal' ? 'horizontal' : undefined }))} data-testid="tile-editor-orientation">
              <option value="vertical">Upright</option>
              <option value="horizontal">Lying</option>
            </select>
          </Labeled>
        )}
        {(kind === 'gauge' || kind === 'bullet') && <>
          <Labeled label="Minimum"><NumInput value={v.min} onChange={(n) => up((t) => setVisual(t, { min: n }))} label="Minimum" className="w-24" testId="tile-editor-min" /></Labeled>
          <Labeled label="Maximum"><NumInput value={v.max} onChange={(n) => up((t) => setVisual(t, { max: n }))} label="Maximum" className="w-24" testId="tile-editor-max" /></Labeled>
          <Labeled label="Target line"><NumInput value={v.target} onChange={(n) => up((t) => setVisual(t, { target: n }))} label="Target line" className="w-24" testId="tile-editor-target-line" /></Labeled>
        </>}
      </div>
      {kind === 'kpi' && (
        <div className="flex flex-wrap items-end gap-2">
          <Labeled label="Number shown">
            <select className={sel} value={v.kpi?.measure ?? ''} data-testid="tile-editor-kpi-measure" onChange={(e) => up((t) => setVisual(t, { kpi: { ...(t.visual?.kpi ?? {}), measure: e.target.value } }))}>
              {!v.kpi && <option value="">Choose…</option>}
              {v.kpi && !avail.some((a) => a.key === v.kpi!.measure) && <option value={v.kpi.measure}>{v.kpi.measure} (missing)</option>}
              {valueIds(q).map((id) => <option key={id} value={id}>{valueLabel(id)}</option>)}
            </select>
          </Labeled>
          <Labeled label="Compared with">
            <select className={sel} value={v.kpi?.base ?? ''} data-testid="tile-editor-kpi-base" disabled={!v.kpi} onChange={(e) => up((t) => {
              const k = { ...t.visual!.kpi! }
              if (e.target.value) k.base = e.target.value as 'compare' | 'target'; else delete k.base
              return setVisual(t, { kpi: k })
            })}>
              <option value="">Nothing</option>
              <option value="compare" disabled={!q.compare}>The comparison{q.compare ? '' : ' (turn it on above)'}</option>
              <option value="target" disabled={!q.target}>The target{q.target ? '' : ' (set it above)'}</option>
            </select>
          </Labeled>
          <Check checked={v.kpi?.higherIsBetter !== false} disabled={!v.kpi} onChange={(on) => up((t) => setVisual(t, { kpi: { ...t.visual!.kpi!, higherIsBetter: on } }))} testId="tile-editor-kpi-higher">Higher is better</Check>
        </div>
      )}
      <div className="flex flex-wrap gap-4">
        {kind !== 'table' && kind !== 'kpi' && <Check checked={!!v.dataLabels} onChange={(on) => up((t) => setVisual(t, { dataLabels: on || undefined }))} testId="tile-editor-data-labels">Show values on the chart</Check>}
        {(q.groupBy ?? []).length > 0 && (
          <Check checked={!!tile.crossFilter} disabled={!!tile.drill} onChange={(on) => up((t) => { const n = { ...t }; if (on) n.crossFilter = true; else delete n.crossFilter; return n })} testId="tile-editor-crossfilter">
            Clicking a {labelOfCol(q.groupBy![0]!)} filters the other tiles on this table{tile.drill ? ' (not while the tile opens an app)' : ''}
          </Check>
        )}
      </div>
    </Section>
  )
}


/** drill-through: clicking a point or a row opens an app, passing values of the clicked row as parameters (Param("name") in the app) */
function DrillEditor({ tile, apps, up }: { tile: TileDef; apps: AppMeta[]; up(f: (t: TileDef) => TileDef): void }) {
  const d = tile.drill
  const fields = drillFields(tile)
  const labelOf = (f: string) => fields.find((x) => x.field === f)?.label ?? f
  const app = d ? apps.find((a) => a.id === d.appId) : undefined
  const params = d?.params ?? []
  const setParams = (next: { name: string; field: string }[]) => up((t) => {
    const n: TileDrill = { ...t.drill! }
    if (next.length) n.params = next; else delete n.params
    return setDrill(t, n)
  })
  return (
    <Section title="When someone clicks" hint="A click on a point of a chart or a row of a table can open an app. A tile without points (a KPI, a gauge) gets an Open button instead.">
      <Check checked={!!d} testId="tile-editor-drill" onChange={(on) => up((t) => {
        if (!on) return setDrill(t, undefined)
        const n = setDrill(t, { appId: apps[0]?.id ?? '', params: defaultDrillParams(t) })
        delete n.crossFilter
        if (!n.drill!.params?.length) delete n.drill!.params
        return n
      })}>Clicking opens an app</Check>
      {d && (
        <div className="grid gap-3 pl-6">
          <Labeled label="App">
            <select className={cn(sel, 'w-fit max-w-full')} value={d.appId} data-testid="tile-editor-drill-app" onChange={(e) => up((t) => setDrill(t, { ...t.drill!, appId: e.target.value }))}>
              {!app && <option value={d.appId}>{d.appId ? `${d.appId} (not found or not allowed)` : 'Choose an app…'}</option>}
              {apps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Labeled>
          <div className="grid gap-1.5" data-testid="tile-editor-drill-params">
            <span className="text-xs font-medium text-muted-foreground">Values passed to the app</span>
            {params.length === 0 && <p className="text-xs text-muted-foreground">None: the app opens as it is.</p>}
            {params.map((p, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2" data-testid={`tile-editor-drill-param-${i}`}>
                <select className={cn(sel, 'max-w-[14rem]')} value={p.field} aria-label="Value" data-testid={`tile-editor-drill-field-${i}`}
                  onChange={(e) => setParams(params.map((x, j) => (j === i ? { name: x.name === paramNameOf(x.field) ? paramNameOf(e.target.value) : x.name, field: e.target.value } : x)))}>
                  {!fields.some((f) => f.field === p.field) && <option value={p.field}>{p.field} (not produced by the tile)</option>}
                  {fields.map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}
                </select>
                <span className="text-xs text-muted-foreground">as the parameter</span>
                <Input className="h-8 w-36 font-mono text-xs" value={p.name} aria-label="Parameter name" data-testid={`tile-editor-drill-name-${i}`}
                  onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Do not pass ${labelOf(p.field)}`} onClick={() => setParams(params.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></button>
              </div>
            ))}
            <div><Button type="button" size="sm" variant="outline" disabled={params.length >= 8 || !fields.length} data-testid="tile-editor-drill-add"
              onClick={() => { const used = new Set(params.map((x) => x.field)); const f = fields.find((x) => !used.has(x.field)) ?? fields[0]!; setParams([...params, { name: paramNameOf(f.field), field: f.field }]) }}><Plus /> Pass another value</Button></div>
          </div>
          <p className="text-xs text-muted-foreground" data-testid="tile-editor-drill-summary">
            {describeDrill(d, app?.name ?? (d.appId || 'the app'), labelOf)} The app starts with those values only when it is opened from here; inside the app, read each with Param("name") (for example in a screen's start formula).
            Opening a particular screen from an address is not possible.
          </p>
        </div>
      )}
    </Section>
  )
}
