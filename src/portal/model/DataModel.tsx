/**
 * Dev mode > Data model (docs/guide/maker/data-model.md): the visual schema designer. Everything edited here goes into
 * a draft (per user and environment); "Review changes" shows the plan and applies it in one transaction.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Boxes, ChevronDown, Download, Filter, GitPullRequestArrow, Import, LayoutDashboard, Lock, Network, Plus, Redo2, RotateCcw, Search, Sparkles, Undo2, Wand2,
} from 'lucide-react'
import { platform, usePlatform } from '@/platform'
import { go } from '@/router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import type { Model, RelationshipDef } from '@/model/types'
import { isSystemTable } from '@/model/types'
import {
  addColumn, addTable, applyOps, createRelationship, diffModels, removeColumn, removeRelationship, removeTable, updateColumn,
  updateRelationship, updateTable, type RelationshipInput,
} from '@/model/ops'
import { autoLayout, autoLayoutByArea, cardHeight } from '@/model/layout'
import { lintModel, type ColumnStats } from '@/model/lint'
import { toDbml, parseDbml } from '@/model/dbml'
import { renderModelSvg } from '@/model/svg'
import { inferenceToModel } from '@/model/infer'
import type { Pattern } from '@/model/patterns'
import { CodeDialog, Empty, downloadText, errMsg, useToast } from '../kit'
import { useCaps } from '../security'
import { useModel } from './store'
import { modelBackend } from './modelApi'
import { ModelCanvas } from './ModelCanvas'
import { ChecksPanel, RelationshipInspector, TableInspector, newAreaId, type InspectorActions } from './panels'
import { ImportDialog, NewTableDialog, PatternDialog, RelationshipDialog, ReviewDialog } from './dialogs'

function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** the SVG drawn on a canvas at twice the size, as PNG */
async function svgToPng(svg: string): Promise<Blob> {
  const img = new Image()
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('The diagram could not be drawn.')); img.src = url })
    const scale = 2
    const w = Math.min(16000, img.naturalWidth * scale)
    const h = Math.min(16000, img.naturalHeight * scale)
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0, w, h)
    return await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed.'))), 'image/png'))
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function DataModel() {
  const st = useModel()
  const caps = useCaps()
  const mode = usePlatform((s) => s.mode)
  const envId = usePlatform((s) => s.environmentId)
  const envs = usePlatform((s) => s.environments)
  const solutions = usePlatform((s) => s.solutions)
  const roles = usePlatform((s) => s.roles)
  const { toast, fail } = useToast()
  const [dlg, setDlg] = useState<null | 'new' | 'patterns' | 'import' | 'review' | 'dbml'>(null)
  const [connect, setConnect] = useState<{ from: string; to: string } | null>(null)
  const [stats, setStats] = useState<ColumnStats[]>([])
  const [checking, setChecking] = useState(false)
  const [panel, setPanel] = useState('inspect')
  const [pkg, setPkg] = useState<{ yaml: string; fileName: string } | null>(null)

  useEffect(() => { void useModel.getState().load() }, [envId])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) useModel.getState().redo(); else useModel.getState().undo() }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); useModel.getState().redo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const env = envs.find((e) => e.id === envId)
  const readOnly = st.locked || !!env?.locked
  const ops = useMemo(() => diffModels(st.base, st.model), [st.base, st.model])
  const staleBase = useMemo(() => diffModels(st.base, st.live).length > 0, [st.base, st.live])
  const liveIds = useMemo(() => new Set(st.live.tables.map((t) => t.id)), [st.live])
  const changedIds = useMemo(() => new Set(ops.flatMap((o) => (o.op === 'addColumn' || o.op === 'updateColumn' || o.op === 'dropColumn' ? [o.table] : o.op === 'updateTable' ? [o.id] : []))), [ops])

  const solutionTables = useMemo(() => {
    if (!st.options.solution) return null
    const sol = solutions.find((x) => x.id === st.options.solution)
    return new Set(sol?.components.filter((c) => c.kind === 'table').map((c) => c.id) ?? [])
  }, [st.options.solution, solutions])
  const visible = useMemo(() => new Set(st.model.tables.filter((t) => (st.options.showSystem || !isSystemTable(t)) && (!solutionTables || solutionTables.has(t.id) || !liveIds.has(t.id))).map((t) => t.id)), [st.model, st.options.showSystem, solutionTables, liveIds])
  const dimmed = useMemo(() => {
    const q = st.options.search.trim().toLowerCase()
    if (!q) return new Set<string>()
    return new Set(st.model.tables.filter((t) => !t.displayName.toLowerCase().includes(q) && !t.name.toLowerCase().includes(q) && !t.columns.some((c) => c.displayName.toLowerCase().includes(q))).map((t) => t.id))
  }, [st.model, st.options.search])
  const systemCount = st.model.tables.filter(isSystemTable).length

  const findings = useMemo(() => {
    const rules: { table: string; column: string; source: string }[] = []
    for (const r of roles) for (const p of r.privileges) for (const c of p.rowFilter ?? []) if ('column' in c) rules.push({ table: p.table, column: c.column.split('.')[0], source: `a row rule of the role ${r.name}` })
    const visibleModel: Model = { tables: st.model.tables.filter((t) => visible.has(t.id)), relationships: st.model.relationships.filter((r) => visible.has(r.fromTable) && visible.has(r.toTable)) }
    const external = st.model.tables.filter((t) => t.connectionId && t.connectionId !== 'conn_default' && t.connectionId !== 'conn_files').map((t) => t.id)
    return lintModel(visibleModel, { stats, rules, externalTables: external })
  }, [st.model, visible, stats, roles])

  const edit = st.edit
  const a: InspectorActions = {
    updateTable: (id, patch) => edit((m) => updateTable(m, id, patch)),
    removeTable: (id) => { edit((m) => removeTable(m, id), (l) => ({ ...l, areas: l.areas.map((x) => ({ ...x, tables: x.tables.filter((t) => t !== id) })) })); st.select(null) },
    addColumn: (table, col) => edit((m) => addColumn(m, table, col).model),
    updateColumn: (table, name, patch) => edit((m) => updateColumn(m, table, name, patch)),
    removeColumn: (table, name) => edit((m) => removeColumn(m, table, name)),
    updateRelationship: (id, patch) => edit((m) => updateRelationship(m, id, patch)),
    removeRelationship: (id) => { edit((m) => removeRelationship(m, id)); st.select(null) },
    setArea: (table, area, fresh) => {
      st.setLayout((l) => {
        let areas = l.areas.map((x) => ({ ...x, tables: x.tables.filter((t) => t !== table) }))
        if (fresh) areas = [...areas, { id: newAreaId(), name: fresh.name, color: fresh.color, tables: [table] }]
        else if (area) areas = areas.map((x) => (x.id === area ? { ...x, tables: [...x.tables, table] } : x))
        return { ...l, areas: areas.filter((x) => x.tables.length || x.id === area) }
      })
    },
    select: (kind, id) => st.select({ kind, id } as never),
    openTable: (id) => go({ page: 'table', id }),
  }

  /** a generated model (pattern, import) joins the draft; its new tables are laid out together and grouped */
  const addGenerated = (next: Model, newIds: string[], area?: string) => {
    const known = new Set(st.model.tables.map((t) => t.id))
    const ids = newIds.filter((id) => !known.has(id))
    edit(() => next, (l) => {
      // below what is on the diagram, so it stays compact
      const placed = st.model.tables.filter((t) => l.positions[t.id] && visible.has(t.id))
      const origin = placed.length
        ? { x: Math.min(...placed.map((t) => l.positions[t.id].x)), y: Math.max(...placed.map((t) => l.positions[t.id].y + cardHeight(t))) + 120 }
        : { x: 0, y: 0 }
      const pos = autoLayout(next, { ids, origin })
      const areas = area && ids.length ? [...l.areas, { id: newAreaId(), name: area, color: ['blue', 'green', 'amber', 'violet', 'teal', 'rose'][l.areas.length % 6], tables: ids }] : l.areas
      return { positions: { ...l.positions, ...pos }, areas }
    })
    if (ids[0]) setTimeout(() => useModel.getState().setFocus(ids[0]), 50)
  }

  const onPattern = (p: Pattern, params: Record<string, unknown>): string | null => {
    try {
      const r = p.generate(st.model, params)
      addGenerated(r.model, r.tables, r.area)
      for (const n of r.notes) toast(n, 'info')
      return null
    } catch (e) {
      return errMsg(e)
    }
  }

  const exportSvg = () => renderModelSvg(st.model, st.layout, { ids: [...visible], keysOnly: st.options.keysOnly, title: `Data model · ${env?.name ?? 'Default'}` })

  const doApply = useCallback(async (token: string) => {
    const s = useModel.getState()
    const res = await modelBackend().apply(diffModels(s.base, s.model), token, s.layout, s.options.layoutScope)
    await s.load()
    await platform.init().catch(() => undefined)
    toast(`Applied. ${res.backup.taken ? 'A backup was taken first.' : ''}`.trim(), 'success')
  }, [toast])

  if (!st.loaded) return <div className="grid h-full place-items-center"><Spinner /></div>
  if (st.error) return <div className="p-8"><Empty icon={Network} title="The data model could not be loaded" description={st.error} /></div>

  const sel = st.selection
  return (
    <div className="flex h-full flex-col" data-testid="data-model" data-readonly={readOnly ? 'true' : undefined}>
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 border-b bg-background px-3 py-2">
        <Network className="size-4 text-primary" />
        <span className="mr-2 text-sm font-semibold">Data model</span>
        {readOnly && <Badge variant="secondary" data-testid="model-locked"><Lock className="mr-1 size-3" />Read-only: locked environment</Badge>}
        {!readOnly && (
          <>
            <Button size="xs" onClick={() => setDlg('new')} data-testid="model-new-table-btn"><Plus />Table</Button>
            <Button size="xs" variant="outline" onClick={() => setDlg('patterns')} data-testid="model-patterns-btn"><Sparkles />Patterns</Button>
            <Button size="xs" variant="outline" onClick={() => setDlg('import')} data-testid="model-import-btn"><Import />Import</Button>
          </>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="xs" variant="outline" data-testid="model-export-btn"><Download />Export<ChevronDown /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem data-testid="export-png" onSelect={async () => { try { downloadBlob('data-model.png', await svgToPng(exportSvg())) } catch (e) { fail(e) } }}>Picture (PNG)</DropdownMenuItem>
            <DropdownMenuItem data-testid="export-svg" onSelect={() => downloadText('data-model.svg', exportSvg(), 'image/svg+xml')}>Drawing (SVG)</DropdownMenuItem>
            <DropdownMenuItem data-testid="export-dbml" onSelect={() => setDlg('dbml')}>Text schema (DBML)</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem data-testid="export-package" disabled={mode !== 'server'} onSelect={async () => {
              try { setPkg(await modelBackend().exportPackage(st.live.tables.filter((t) => visible.has(t.id) && !isSystemTable(t)).map((t) => t.id), `Data model ${env?.name ?? ''}`.trim())) } catch (e) { fail(e) }
            }}>Solution package (data model)</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="xs" variant="ghost" disabled={readOnly} onClick={() => st.setLayout((l) => ({ ...l, positions: { ...l.positions, ...autoLayoutByArea(st.model, l, { ids: [...visible], keysOnly: st.options.keysOnly }) } }))} data-testid="model-autolayout"><Wand2 />Auto-layout</Button>
        <Button size="icon-sm" variant="ghost" aria-label="Undo" disabled={!st.past.length || readOnly} onClick={st.undo} data-testid="model-undo"><Undo2 /></Button>
        <Button size="icon-sm" variant="ghost" aria-label="Redo" disabled={!st.future.length || readOnly} onClick={st.redo} data-testid="model-redo"><Redo2 /></Button>
        <div className="relative ml-2">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={st.options.search} onChange={(e) => st.setOption('search', e.target.value)} placeholder="Find a table or column" className="h-8 w-52 pl-7 text-xs" data-testid="model-search"
            onKeyDown={(e) => { if (e.key === 'Enter') { const hit = st.model.tables.find((t) => visible.has(t.id) && !dimmed.has(t.id)); if (hit) st.setFocus(hit.id) } }} />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="xs" variant="ghost" data-testid="model-view-btn"><Filter />View<ChevronDown /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>Show</DropdownMenuLabel>
            <label className="flex items-center gap-2 px-2 py-1 text-sm"><Checkbox checked={st.options.showSystem} onCheckedChange={(v) => st.setOption('showSystem', v === true)} data-testid="model-show-system" />System tables ({systemCount})</label>
            <label className="flex items-center gap-2 px-2 py-1 text-sm"><Checkbox checked={st.options.keysOnly} onCheckedChange={(v) => st.setOption('keysOnly', v === true)} />Key columns only</label>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Solution</DropdownMenuLabel>
            <div className="px-2 pb-1">
              <Select value={st.options.solution || '__all'} onValueChange={(v) => st.setOption('solution', v === '__all' ? '' : v)}>
                <SelectTrigger size="sm" className="w-full" data-testid="model-solution-filter"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="__all">All tables</SelectItem>{solutions.map((s) => <SelectItem key={s.id} value={s.id}>{s.displayName}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Positions</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => st.setOption('layoutScope', 'shared')}>{st.options.layoutScope === 'shared' ? '✓ ' : ''}Shared layout (everyone)</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => st.setOption('layoutScope', 'mine')}>{st.options.layoutScope === 'mine' ? '✓ ' : ''}My own layout</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground" data-testid="model-save-state">{st.saving === 'saving' ? 'Saving draft...' : st.saving === 'error' ? 'Draft not saved' : ops.length ? 'Draft saved' : ''}</span>
          {!readOnly && ops.length > 0 && <Button size="xs" variant="ghost" onClick={() => void st.discard()} data-testid="model-discard"><RotateCcw />Discard draft</Button>}
          <Button size="xs" disabled={readOnly || !ops.length} onClick={() => setDlg('review')} data-testid="model-review-btn"><GitPullRequestArrow />Review changes{ops.length ? ` (${ops.length})` : ''}</Button>
        </div>
      </div>

      {staleBase && !readOnly && (
        <div className="flex items-center gap-2 border-b bg-amber-500/10 px-3 py-1.5 text-xs" data-testid="model-stale">
          The environment's schema changed since your draft started.
          <Button size="xs" variant="outline" onClick={() => {
            const s = useModel.getState()
            const { model, conflicts } = applyOps(s.live, diffModels(s.base, s.model))
            useModel.setState({ base: s.live, model, past: [], future: [] })
            useModel.getState().edit((m) => m)
            toast(conflicts.length ? `Rebased; ${conflicts.length} change(s) no longer fit and were dropped: ${conflicts[0]}` : 'Your draft now starts from the current schema.', conflicts.length ? 'error' : 'success')
          }} data-testid="model-rebase">Rebase draft</Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {visible.size === 0 ? (
            <div className="grid h-full place-items-center p-8">
              <Empty icon={LayoutDashboard} title="No tables yet" description="Add a table, start from a pattern, or import a model from Excel, a database or DBML." action={!readOnly ? <Button onClick={() => setDlg('patterns')}><Boxes />Start from a pattern</Button> : undefined} />
            </div>
          ) : (
            <ModelCanvas
              model={st.model} layout={st.layout} visible={visible} dimmed={dimmed} selection={sel} keysOnly={st.options.keysOnly} readOnly={readOnly} focus={st.focus}
              liveIds={liveIds} changedIds={changedIds}
              onSelect={st.select}
              onMove={(id, x, y, done) => st.setLayout((l) => ({ ...l, positions: { ...l.positions, [id]: { x, y } } }), done)}
              onConnect={(from, to) => setConnect({ from, to })}
              onRenameColumn={(t, c, name) => a.updateColumn(t, c, { displayName: name })}
              onAddColumn={(t) => { a.addColumn(t, { displayName: 'New column', type: 'text' }); setPanel('inspect') }}
              onOpenTable={(id) => { if (liveIds.has(id)) go({ page: 'table', id }) }}
            />
          )}
        </div>
        <aside className="w-[340px] shrink-0 overflow-auto border-l bg-background" data-testid="model-side">
          <Tabs value={panel} onValueChange={setPanel}>
            <TabsList className="m-2">
              <TabsTrigger value="inspect">Inspector</TabsTrigger>
              <TabsTrigger value="checks" data-testid="model-checks-tab">Checks{findings.filter((f) => f.level === 'warning').length ? ` (${findings.filter((f) => f.level === 'warning').length})` : ''}</TabsTrigger>
            </TabsList>
            <TabsContent value="inspect">
              {sel?.kind === 'table' ? <TableInspector model={st.model} layout={st.layout} id={sel.id} readOnly={readOnly} live={liveIds.has(sel.id)} a={a} />
                : sel?.kind === 'relationship' ? <RelationshipInspector model={st.model} id={sel.id} readOnly={readOnly} a={a} />
                  : <SummaryPane model={st.model} live={st.live} ops={ops.length} />}
            </TabsContent>
            <TabsContent value="checks">
              <ChecksPanel findings={findings} onFocus={(id) => st.setFocus(id)} checking={checking} onCheckData={async () => {
                setChecking(true)
                try { setStats(await modelBackend().stats()) } catch (e) { fail(e) } finally { setChecking(false) }
              }} />
            </TabsContent>
          </Tabs>
        </aside>
      </div>

      <NewTableDialog open={dlg === 'new'} onOpenChange={(o) => setDlg(o ? 'new' : null)} onCreate={(name, columns) => {
        let id = ''
        edit((m) => { const r = addTable(m, { displayName: name, columns }); id = r.table.id; return r.model })
        setTimeout(() => useModel.getState().setFocus(id), 30)
      }} />
      {connect && (
        <RelationshipDialog open={!!connect} onOpenChange={(o) => { if (!o) setConnect(null) }} model={st.model} from={connect.from} to={connect.to} onCreate={(input: RelationshipInput) => {
          try {
            let made: RelationshipDef[] = []
            let junction = ''
            edit((m) => { const r = createRelationship(m, input); made = r.relationships; junction = r.junction?.id ?? ''; return r.model }, (l) => l)
            if (junction) {
              const pa = st.layout.positions[input.parent]
              const pc = st.layout.positions[input.child]
              if (pa && pc) st.setLayout((l) => ({ ...l, positions: { ...l.positions, [junction]: { x: Math.round((pa.x + pc.x) / 2), y: Math.max(pa.y, pc.y) + 220 } } }))
            }
            if (made[0]) st.select({ kind: 'relationship', id: made[0].id })
          } catch (e) { fail(e) }
        }} />
      )}
      <PatternDialog open={dlg === 'patterns'} onOpenChange={(o) => setDlg(o ? 'patterns' : null)} model={st.model} server={mode === 'server'} onApply={onPattern} />
      <ImportDialog open={dlg === 'import'} onOpenChange={(o) => setDlg(o ? 'import' : null)} server={mode === 'server'}
        onSheets={(inf, accepted) => { const r = inferenceToModel(inf, accepted, st.model); addGenerated(r.model, Object.values(r.ids), 'Imported') }}
        onDatabase={async (connectionId, m) => {
          const r = await modelBackend().introspect(connectionId, m, st.model)
          addGenerated(r.model, r.tables, m === 'link' ? 'Linked' : 'Copied')
          return r.warnings
        }}
        onDbml={(text) => {
          const r = parseDbml(text, st.model)
          const fresh = r.model.tables.filter((t) => !st.model.tables.some((x) => x.id === t.id)).map((t) => t.id)
          if (fresh.length) addGenerated(r.model, fresh, 'Imported')
          return fresh.length ? r.warnings.filter((w) => !w.startsWith('Ignored')) : [...r.warnings, 'No new tables found.']
        }} />
      <ReviewDialog open={dlg === 'review'} onOpenChange={(o) => setDlg(o ? 'review' : null)} load={() => modelBackend().plan(diffModels(useModel.getState().base, useModel.getState().model))} apply={doApply} />
      <CodeDialog open={dlg === 'dbml'} onOpenChange={(o) => setDlg(o ? 'dbml' : null)} title="Text schema (DBML)" description="The model as text, for documentation and reviews. Import it again with Import > DBML text." text={toDbml({ tables: st.model.tables.filter((t) => visible.has(t.id)), relationships: st.model.relationships }, { title: `Data model · ${env?.name ?? 'Default'}` })} filename="data-model.dbml" mime="text/plain" />
      <CodeDialog open={!!pkg} onOpenChange={(o) => { if (!o) setPkg(null) }} title="Solution package (data model)" description="Tables, relationships with their delete behaviours and reporting settings, no rows. Import it into another environment from Solutions." text={pkg?.yaml ?? ''} filename={pkg?.fileName ?? 'data-model.solution.yaml'} />
      {!caps.isMaker && <p className="sr-only">Makers only</p>}
    </div>
  )
}

function SummaryPane({ model, live, ops }: { model: Model; live: Model; ops: number }) {
  const user = model.tables.filter((t) => !isSystemTable(t))
  return (
    <div className="grid gap-2 p-3 text-sm text-muted-foreground" data-testid="model-summary">
      <p><b className="text-foreground">{user.length}</b> tables, <b className="text-foreground">{model.relationships.length}</b> relationships{model.tables.length - user.length ? `, ${model.tables.length - user.length} system tables` : ''}.</p>
      <p>{ops ? `${ops} change${ops === 1 ? '' : 's'} in your draft (${live.tables.length} tables live).` : 'Your draft has no changes.'}</p>
      <ul className="grid list-disc gap-1 pl-4 text-xs">
        <li>Drag a table by its header to move it; drag the dot on its right edge onto another table to relate them.</li>
        <li>Double-click a column to rename it; select a table to edit its columns here.</li>
        <li>Scroll to pan, Ctrl or Cmd + scroll to zoom; Ctrl+Z and Ctrl+Shift+Z undo and redo.</li>
        <li>Nothing changes in the environment until you review and apply.</li>
      </ul>
    </div>
  )
}
