import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronsUpDown, Eye, FileDown, FileUp, Lock, Plus, Rows3, Search, Share2, Trash2, TriangleAlert, X } from 'lucide-react'
import { platform, usePlatform, type ColumnDef, type TableDef } from '@/platform'
import type { FxRecord } from '@/contracts'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Spinner } from '@/components/ui/spinner'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CodeDialog, ConfirmDialog, Empty, Field, Segmented, useToast } from './kit'
import { CellEditor, buildLookups, compareValues, displayText, draftToValue, isNumeric, valueToDraft } from './cells'
import { TYPE_INFO } from './columnTypes'
import { AttachmentCell, AttachmentsDialog, isAttachmentCol } from './Attachments'
import { useCaps, useMyAccess } from './security'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ShareDialog } from './Share'
import { WhoCanSeeDialog } from './Explain'
import { QUERY_FALLBACK_ROW_CAP, columnKind, type QueryPlan } from '@/platform/query'
import { useQuery } from '@/platform/useQuery'

const PAGE = 200

/* ------------------------------------------------------------------ add row */

function AddRowDialog({ open, onOpenChange, table, cols, onAdded, readOnlyCols }: { open: boolean; onOpenChange(o: boolean): void; table: TableDef; cols: ColumnDef[]; onAdded(id: string): void; readOnlyCols: Set<string> }) {
  const { fail, toast } = useToast()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const lookups = useMemo(() => (open ? buildLookups(cols) : {}), [open, cols])
  const editable = cols.filter((c) => !c.system && !c.computed && c.type !== 'autonumber' && !isAttachmentCol(c) && !readOnlyCols.has(c.name))
  const hasAttach = cols.some((c) => isAttachmentCol(c))
  useEffect(() => {
    if (!open) return
    const d: Record<string, string> = {}
    for (const c of editable) d[c.name] = c.default ?? (c.type === 'boolean' ? 'false' : '')
    setDrafts(d)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, table.id])
  const save = () => {
    try {
      const values: FxRecord = {}
      for (const c of editable) {
        const v = draftToValue(c, drafts[c.name] ?? '')
        if (v !== null) values[c.name] = v
      }
      const row = platform.tables.insert(table.name, values, { secure: false })
      toast('Row added', 'success')
      onOpenChange(false)
      onAdded(String(row.__id ?? row.id))
    } catch (e) {
      fail(e)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="add-row-dialog">
        <DialogHeader>
          <DialogTitle>Add row to {table.displayName}</DialogTitle>
          <DialogDescription>Fields marked * are required. Autonumber, system and calculated columns are filled in for you.{hasAttach ? ' Attach files and images after the row is added.' : ''}</DialogDescription>
        </DialogHeader>
        <form className="grid max-h-[60vh] gap-3 overflow-auto px-0.5 py-0.5" onSubmit={(e) => { e.preventDefault(); save() }}>
          {editable.map((c, i) => (
            <Field key={c.name} label={`${c.displayName}${c.required ? ' *' : ''}`} htmlFor={`add-${c.name}`}>
              <CellEditor id={`add-${c.name}`} autoFocus={i === 0} col={c} lookups={lookups} value={drafts[c.name] ?? ''} onChange={(v) => setDrafts((d) => ({ ...d, [c.name]: v }))} />
            </Field>
          ))}
          <button type="submit" className="sr-only" tabIndex={-1}>Add</button>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} data-testid="add-row-save">Add row</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ csv import */

function CsvImportDialog({ open, onOpenChange, table }: { open: boolean; onOpenChange(o: boolean): void; table: TableDef }) {
  const { fail, toast } = useToast()
  const [csv, setCsv] = useState('')
  const [mode, setMode] = useState<'append' | 'replace'>('append')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (open) { setCsv(''); setMode('append') } }, [open])
  const run = async () => {
    setBusy(true)
    try {
      const n = await platform.tables.importCsv(table.name, csv, mode)
      toast(`Imported ${n} ${n === 1 ? 'row' : 'rows'}`, 'success')
      onOpenChange(false)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="csv-import-dialog">
        <DialogHeader>
          <DialogTitle>Import CSV into {table.displayName}</DialogTitle>
          <DialogDescription>The header row must use the column names. Unknown columns are ignored.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Segmented label="Import mode" value={mode} onChange={setMode} options={[{ value: 'append', label: 'Add to existing rows' }, { value: 'replace', label: 'Replace all rows' }]} />
          {mode === 'replace' && <p className="text-xs text-destructive">All current rows in this table will be removed first.</p>}
          <textarea value={csv} onChange={(e) => setCsv(e.target.value)} spellCheck={false} aria-label="CSV text" data-testid="csv-import-text" placeholder={table.columns.filter((c) => !c.system).map((c) => c.name).join(',')} className="h-48 w-full resize-none rounded-md border border-input bg-muted/40 p-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30" />
          <div>
            <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" className="sr-only" aria-label="Choose CSV file" data-testid="csv-import-file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) f.text().then(setCsv).catch(fail) }} />
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}><FileUp /> Choose file</Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || !csv.trim()} variant={mode === 'replace' ? 'destructive' : 'default'} onClick={() => void run()} data-testid="csv-import-run">{mode === 'replace' ? 'Replace rows' : 'Import rows'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ lookup labels (server mode) */

/** labels of the lookup values on screen, read from the target tables (a query per lookup column, by id) */
function useLookupLabels(cols: ColumnDef[], rows: FxRecord[]) {
  const lookupCols = cols.filter((c) => c.type === 'lookup' && c.lookupTable)
  const plans = lookupCols.map((c) => {
    const target = platform.tables.get(c.lookupTable!)
    const ids = [...new Set(rows.map((r) => r[c.name]).filter((v): v is string => typeof v === 'string' && v !== ''))].slice(0, 1000)
    if (!target || !ids.length) return null
    return { col: c, target, plan: { version: 2, table: target.name, filter: { col: 'id', op: 'in', value: ids }, select: [target.primaryColumn] } as QueryPlan }
  })
  const states = plans.map((p, i) => (p ? platform.tables.queryState(p.plan, { owner: `portal-lookup:${lookupCols[i]!.name}` }) : null))
  const [, bump] = useState(0)
  const keys = states.map((s) => s?.key ?? '').join('|')
  useEffect(() => platform.tables.onQueryChange((k) => { if (k.some((x) => keys.includes(x))) bump((n) => n + 1) }), [keys])
  const out: ReturnType<typeof buildLookups> = {}
  lookupCols.forEach((c, i) => {
    const m = new Map<string, string>()
    const st = states[i]
    const p = plans[i]
    if (st && p) for (const r of st.rows) { const label = r[p.target.primaryColumn]; m.set(String(r.__id ?? r.id), label === null || label === undefined ? '(blank)' : String(label)) }
    out[c.name] = m
  })
  return out
}

/* ------------------------------------------------------------------ grid */

export function DataGrid({ table }: { table: TableDef }) {
  const { fail } = useToast()
  const dataVersion = usePlatform((s) => s.dataVersion)
  const tables = usePlatform((s) => s.tables)
  const access = useMyAccess(table)
  const loading = usePlatform((s) => s.loading.includes(table.name))
  const truncated = usePlatform((s) => s.truncated.includes(table.name))
  const gridRef = useRef<HTMLDivElement>(null)
  const [attach, setAttach] = useState<{ rowId: string; col: ColumnDef } | null>(null)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<{ col: string; dir: 'asc' | 'desc' } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [active, setActive] = useState<{ r: number; c: number } | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [dlg, setDlg] = useState<'add' | 'import' | 'export' | 'delete' | null>(null)
  const [shareRow, setShareRow] = useState<{ id: string; label: string } | null>(null)
  const [whoRow, setWhoRow] = useState<string | null>(null)
  const caps = useCaps()
  const editingRef = useRef(false)
  editingRef.current = editing

  const cols = useMemo(() => {
    const user = table.columns.filter((c) => !c.system)
    const mod = table.columns.find((c) => c.name === 'modifiedOn')
    return mod ? [...user, mod] : user
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table])
  // server mode: the grid pages through the table with Query v2 (sort, search and the exact count run on the server);
  // demo mode keeps every row in memory and filters / sorts here, as before
  const server = usePlatform((s) => s.mode) === 'server'
  const [search, setSearch] = useState('')
  useEffect(() => {
    if (!server) return
    const t = setTimeout(() => setSearch(filter.trim()), 300)
    return () => clearTimeout(t)
  }, [filter, server])
  const plan = useMemo<QueryPlan | null>(() => {
    if (!server) return null
    const searchCols = cols.filter((c) => columnKind(c.type) === 'text' && !c.system && c.type !== 'lookup').map((c) => c.name)
    const p: QueryPlan = { version: 2, table: table.name, count: true }
    if (sort && cols.some((c) => c.name === sort.col && columnKind(c.type) !== 'other')) p.sort = [{ col: sort.col, dir: sort.dir }]
    if (search) p.search = { text: search, columns: searchCols }
    return p
  }, [server, table.name, cols, sort, search])
  const q = useQuery(plan, { owner: `portal-grid:${table.id}`, pageSize: PAGE })
  const serverLookups = useLookupLabels(server ? cols : [], q?.rows ?? [])
  const lookups = useMemo(() => (server ? serverLookups : buildLookups(cols)), [server, serverLookups, cols, tables, dataVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => (server ? (q?.rows ?? []) : platform.tables.rows(table.name, { secure: false })), [server, q, table.name, dataVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  const total = server ? (q?.count ?? rows.length) : rows.length
  const serverLoading = server && (!q || q.status === 'loading')

  const view = useMemo(() => {
    if (server) return rows
    const n = filter.trim().toLowerCase()
    let r = rows
    if (n) r = r.filter((row) => cols.some((c) => displayText(c, row[c.name], lookups).toLowerCase().includes(n)))
    if (sort) {
      const c = cols.find((x) => x.name === sort.col)
      if (c) {
        const f = sort.dir === 'asc' ? 1 : -1
        r = [...r].sort((a, b) => f * compareValues(c, a[c.name], b[c.name], lookups))
      }
    }
    return r
  }, [rows, filter, sort, cols, lookups, server])
  const shown = server ? view : view.slice(0, limit)
  const idOf = (i: number) => String(shown[i].__id ?? shown[i].id)

  // drop selection of rows that no longer exist
  useEffect(() => {
    setSelected((s) => {
      const ids = new Set(rows.map((r) => String(r.__id ?? r.id)))
      const next = new Set([...s].filter((id) => ids.has(id)))
      return next.size === s.size ? s : next
    })
  }, [rows])
  useEffect(() => { setActive(null); setEditing(false); setSelected(new Set()); setSort(null); setFilter(''); setLimit(PAGE) }, [table.id])
  useEffect(() => {
    gridRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  const isReadonly = (c: ColumnDef) => !!c.system || !!c.computed || c.type === 'autonumber' || access.update === 'none' || access.readOnlyColumns.has(c.name)
  const openAttach = (ri: number, c: ColumnDef) => { const id = String(shown[ri]?.__id ?? shown[ri]?.id ?? ''); if (id) setAttach({ rowId: id, col: c }) }
  const refocus = () => requestAnimationFrame(() => gridRef.current?.focus({ preventScroll: true }))

  const save = (rowIdx: number, c: ColumnDef, text: string): boolean => {
    const row = shown[rowIdx]
    if (!row) return true
    if (text === valueToDraft(c, row[c.name])) return true
    try {
      platform.tables.update(table.name, idOf(rowIdx), { [c.name]: draftToValue(c, text) }, { secure: false })
      return true
    } catch (e) {
      fail(e)
      return false
    }
  }
  const startEdit = (initial?: string) => {
    if (!active) return
    const c = cols[active.c]
    const row = shown[active.r]
    if (c && row && isAttachmentCol(c)) { openAttach(active.r, c); return }
    if (!c || !row || isReadonly(c)) return
    setDraft(initial ?? valueToDraft(c, row[c.name]))
    setEditing(true)
  }
  const endEdit = (commit: boolean, move?: 'down' | 'right') => {
    if (!active) return
    if (!editingRef.current) return
    editingRef.current = false
    const c = cols[active.c]
    if (commit && c) save(active.r, c, draft)
    setEditing(false)
    if (move === 'down') setActive({ r: Math.min(active.r + 1, shown.length - 1), c: active.c })
    if (move === 'right') setActive({ r: active.r, c: Math.min(active.c + 1, cols.length - 1) })
    refocus()
  }
  const toggleSort = (name: string) => {
    setSort((s) => (!s || s.col !== name ? { col: name, dir: 'asc' } : s.dir === 'asc' ? { col: name, dir: 'desc' } : null))
  }

  const onGridKey = (e: React.KeyboardEvent) => {
    if (editing || !active || e.target !== e.currentTarget) return
    const { r, c } = active
    const col = cols[c]
    const mv = (dr: number, dc: number) => { e.preventDefault(); setActive({ r: Math.max(0, Math.min(shown.length - 1, r + dr)), c: Math.max(0, Math.min(cols.length - 1, c + dc)) }) }
    switch (e.key) {
      case 'ArrowDown': return mv(1, 0)
      case 'ArrowUp': return mv(-1, 0)
      case 'ArrowLeft': return mv(0, -1)
      case 'ArrowRight': return mv(0, 1)
      case 'Tab': if (e.shiftKey ? c > 0 : c < cols.length - 1) mv(0, e.shiftKey ? -1 : 1); return
      case 'Enter':
      case 'F2': e.preventDefault(); if (col.type === 'boolean' && !isReadonly(col)) { save(r, col, shown[r][col.name] ? 'false' : 'true') } else startEdit(); return
      case ' ': if (col.type === 'boolean' && !isReadonly(col)) { e.preventDefault(); save(r, col, shown[r][col.name] ? 'false' : 'true') } return
      case 'Delete':
      case 'Backspace': if (!isReadonly(col) && col.type !== 'boolean' && !isAttachmentCol(col)) { e.preventDefault(); save(r, col, '') } return
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !isReadonly(col) && !['boolean', 'choice', 'lookup', 'file', 'image'].includes(col.type)) {
          e.preventDefault()
          startEdit(e.key)
        }
    }
  }

  const allSelected = shown.length > 0 && shown.every((_, i) => selected.has(idOf(i)))
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(shown.map((_, i) => idOf(i))))
  const toggleRow = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  return (
    <div data-testid="data-tab" className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => { setFilter(e.target.value); setActive(null) }}
            placeholder="Filter rows..."
            aria-label="Filter rows"
            data-testid="grid-filter"
            className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-7 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          />
          {filter && <button type="button" aria-label="Clear filter" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setFilter('')}><X className="size-3.5" /></button>}
        </div>
        <Button size="sm" disabled={!access.create} title={!access.create ? 'You cannot add rows to this table' : undefined} onClick={() => setDlg('add')} data-testid="add-row-button"><Plus /> Add row</Button>
        <Button size="sm" variant="outline" disabled={selected.size === 0 || access.delete === 'none'} onClick={() => setDlg('delete')} data-testid="delete-rows-button">
          <Trash2 /> Delete{selected.size > 0 ? ` (${selected.size})` : ''}
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="row-count">
            {server && q && (q.refreshing || q.loadingMore) && <Spinner />}
            {server
              ? `${total.toLocaleString('en-US')} ${total === 1 ? 'row' : 'rows'}${search ? ' match' : ''}`
              : filter.trim() ? `${view.length} of ${rows.length} rows` : `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`}
            {selected.size > 0 && ` · ${selected.size} selected`}
          </span>
          <Button size="sm" variant="outline" disabled={!access.create} onClick={() => setDlg('import')} data-testid="csv-import-button"><FileUp /> Import CSV</Button>
          {server ? (
            <Button size="sm" variant="outline" asChild data-testid="csv-export-button">
              <a href={`/api/v1/tables/${encodeURIComponent(table.id)}/csv`} download={`${table.name}.csv`}><FileDown /> Export CSV</a>
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setDlg('export')} data-testid="csv-export-button"><FileDown /> Export CSV</Button>
          )}
        </div>
      </div>

      {(truncated || q?.truncated) && (
        <div role="status" className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300" data-testid="truncated-warning">
          <TriangleAlert className="size-3.5 shrink-0" /> This table's connection can't run queries itself, so only its first {QUERY_FALLBACK_ROW_CAP.toLocaleString('en-US')} rows are searched, sorted and counted. Move the table to the default database to work with all of its rows.
        </div>
      )}
      {q?.status === 'error' && (
        <div role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="grid-error">
          <TriangleAlert className="size-3.5 shrink-0" /> {q.error?.message ?? 'The rows could not be loaded.'}
        </div>
      )}
      {access.enforced && !access.isAdmin && (access.readOnlyTable || access.update === 'none' || access.readOnlyColumns.size > 0) && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground" data-testid="readonly-note">
          <Lock className="size-3.5 shrink-0" /> {access.readOnlyTable ? 'This table is read-only.' : access.update === 'none' ? 'You can read but not change rows here.' : `Read-only columns for you: ${[...access.readOnlyColumns].map((n) => cols.find((c) => c.name === n)?.displayName ?? n).join(', ')}.`}
        </div>
      )}
      {rows.length === 0 && (loading || serverLoading) ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border py-12 text-sm text-muted-foreground" data-testid="grid-loading"><Spinner /> Loading rows...</div>
) : rows.length === 0 && !(server && search) ? (
        <Empty icon={Rows3} title="No rows yet" description="Add a row, or import a CSV file to fill this table." action={<Button onClick={() => setDlg('add')}><Plus /> Add row</Button>} />
      ) : view.length === 0 ? (
        <Empty icon={Search} title="No rows match the filter" description={`Nothing matches "${filter}".`} action={<Button variant="outline" size="sm" onClick={() => setFilter('')}>Clear filter</Button>} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
          <div
            ref={gridRef}
            data-testid="data-grid"
            role="grid"
            aria-label={`${table.displayName} data`}
            aria-rowcount={(server ? total : view.length) + 1}
            tabIndex={0}
            onScroll={(e) => {
              const el = e.currentTarget
              if (server && q?.hasMore && !q.loadingMore && el.scrollTop + el.clientHeight > el.scrollHeight - 400) void platform.tables.loadMore(q.key)
            }}
            onKeyDown={onGridKey}
            onFocus={(e) => { if (e.target === e.currentTarget && !active && shown.length) setActive({ r: 0, c: 0 }) }}
            className="max-h-[calc(100vh-290px)] min-h-40 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
          >
            <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr role="row">
                  <th className="sticky left-0 top-0 z-20 w-10 border-b border-r border-border bg-muted px-2 py-0 text-center">
                    <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="Select all rows" data-testid="select-all-rows" />
                  </th>
                  <th className="sticky top-0 z-10 w-10 border-b border-r border-border bg-muted px-2 text-center text-[11px] font-medium text-muted-foreground">#</th>
                  {cols.map((c) => {
                    const I = TYPE_INFO[c.type].icon
                    const s = sort?.col === c.name ? sort.dir : null
                    return (
                      <th key={c.name} role="columnheader" aria-sort={s === 'asc' ? 'ascending' : s === 'desc' ? 'descending' : 'none'} className="sticky top-0 z-10 min-w-40 border-b border-r border-border bg-muted p-0 text-left last:border-r-0">
                        <button type="button" onClick={() => toggleSort(c.name)} className={cn('flex h-9 w-full items-center gap-1.5 px-2.5 text-xs font-medium outline-none hover:bg-accent/60 focus-visible:bg-accent', isNumeric(c.type) && 'flex-row-reverse text-right')} data-testid={`sort-${c.name}`}>
                          <I className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{c.displayName}{c.required ? ' *' : ''}</span>
                          {access.readOnlyColumns.has(c.name) && <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="Read-only for you" />}
                          {s === 'asc' ? <ArrowUp className="size-3 shrink-0 text-primary" /> : s === 'desc' ? <ArrowDown className="size-3 shrink-0 text-primary" /> : <ChevronsUpDown className="size-3 shrink-0 opacity-30" />}
                        </button>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {shown.map((row, ri) => {
                  const id = idOf(ri)
                  const sel = selected.has(id)
                  return (
                    <tr key={id} role="row" aria-selected={sel} data-testid={`row-${id}`} className={cn(sel ? 'bg-accent/50' : 'hover:bg-muted/40')}>
                      <td className="sticky left-0 z-[1] border-b border-r border-border bg-card px-2 text-center">
                        <Checkbox checked={sel} onCheckedChange={() => toggleRow(id)} aria-label={`Select row ${ri + 1}`} />
                      </td>
                      <td className="border-b border-r border-border p-0 text-center text-[11px] tabular-nums text-muted-foreground">
                        {(table.sharing || caps.isAdmin) ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger className="h-8 w-full px-2 outline-none hover:bg-accent/60 focus-visible:bg-accent" aria-label={`Row ${ri + 1} menu`} data-testid={`row-menu-${id}`}>{ri + 1}</DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                              {table.sharing && <DropdownMenuItem onSelect={() => setShareRow({ id, label: String(row[table.primaryColumn] ?? '') })} data-testid={`row-share-${id}`}><Share2 /> Share...</DropdownMenuItem>}
                              {caps.isAdmin && <DropdownMenuItem onSelect={() => setWhoRow(id)} data-testid={`row-who-${id}`}><Eye /> Who can see this row?</DropdownMenuItem>}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : <span className="px-2">{ri + 1}</span>}
                      </td>
                      {cols.map((c, ci) => {
                        const isActive = active?.r === ri && active.c === ci
                        const isEditing = isActive && editing
                        const v = row[c.name]
                        const ro = isReadonly(c)
                        return (
                          <td
                            key={c.name}
                            role="gridcell"
                            data-active={isActive ? 'true' : undefined}
                            data-testid={`cell-${id}-${c.name}`}
                            onClick={() => { if (!isActive) { if (editing) endEdit(true); setActive({ r: ri, c: ci }) } gridRef.current?.focus({ preventScroll: true }) }}
                            onDoubleClick={() => { setActive({ r: ri, c: ci }); if (isAttachmentCol(c)) { openAttach(ri, c); return } if (c.type !== 'boolean') { setDraft(valueToDraft(c, v)); if (!ro) setEditing(true) } }}
                            className={cn(
                              'relative h-8 max-w-80 border-b border-r border-border px-0 last:border-r-0',
                              isNumeric(c.type) && 'text-right tabular-nums',
                              ro && 'text-muted-foreground',
                              isActive && 'z-[2] outline outline-2 -outline-offset-2 outline-primary',
                            )}
                          >
                            {isEditing ? (
                              <CellEditor
                                col={c}
                                dense
                                autoFocus
                                lookups={lookups}
                                value={draft}
                                onChange={(t) => {
                                  setDraft(t)
                                  if (['boolean', 'choice', 'lookup'].includes(c.type)) {
                                    editingRef.current = false
                                    save(ri, c, t)
                                    setEditing(false)
                                    refocus()
                                  }
                                }}
                                onBlur={() => endEdit(true)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') { e.preventDefault(); endEdit(true, 'down') }
                                  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endEdit(false) }
                                  else if (e.key === 'Tab') { e.preventDefault(); endEdit(true, 'right') }
                                }}
                              />
                            ) : isAttachmentCol(c) ? (
                              <AttachmentCell col={c} value={v} canEdit={!ro} onManage={() => { setActive({ r: ri, c: ci }); openAttach(ri, c) }} testId={`attach-${id}-${c.name}`} />
                            ) : c.type === 'boolean' ? (
                              <div className="flex h-full items-center px-2.5">
                                <Checkbox checked={v === true} disabled={ro} aria-label={c.displayName} onCheckedChange={(chk) => save(ri, c, chk === true ? 'true' : 'false')} onClick={(e) => e.stopPropagation()} />
                              </div>
                            ) : (
                              <div className="truncate px-2.5 py-1.5" title={displayText(c, v, lookups)}>{displayText(c, v, lookups) || <span className="text-muted-foreground/40">&nbsp;</span>}</div>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {server && q?.hasMore && (
            <div className="flex items-center justify-center gap-3 border-t border-border bg-muted/40 py-2 text-xs text-muted-foreground" data-testid="grid-more">
              Showing {shown.length.toLocaleString('en-US')} of {total.toLocaleString('en-US')}
              <Button size="xs" variant="outline" disabled={q.loadingMore} onClick={() => void platform.tables.loadMore(q.key)}>{q.loadingMore ? 'Loading…' : `Show ${Math.min(PAGE, total - shown.length).toLocaleString('en-US')} more`}</Button>
            </div>
          )}
          {!server && view.length > shown.length && (
            <div className="flex items-center justify-center gap-3 border-t border-border bg-muted/40 py-2 text-xs text-muted-foreground">
              Showing {shown.length} of {view.length}
              <Button size="xs" variant="outline" onClick={() => setLimit((l) => l + PAGE)}>Show {Math.min(PAGE, view.length - shown.length)} more</Button>
            </div>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">Click a cell and press Enter or just start typing to edit. Arrow keys move, Tab and Enter commit, Escape cancels. {access.enforced ? 'The server applies your security roles to every change.' : 'Edits here ignore security roles.'}</p>

      <AddRowDialog open={dlg === 'add'} onOpenChange={(o) => !o && setDlg(null)} table={table} cols={table.columns} readOnlyCols={access.readOnlyColumns} onAdded={() => setLimit((l) => Math.max(l, PAGE))} />
      {attach && <AttachmentsDialog open onOpenChange={(o) => !o && setAttach(null)} table={table} col={attach.col} rowId={attach.rowId} canEdit={!isReadonly(attach.col)} />}
      <ShareDialog table={table} rowId={shareRow?.id ?? null} label={shareRow?.label} onOpenChange={(o) => !o && setShareRow(null)} />
      <WhoCanSeeDialog open={!!whoRow} onOpenChange={(o) => !o && setWhoRow(null)} table={table.id} rowId={whoRow ?? undefined} />
      <CsvImportDialog open={dlg === 'import'} onOpenChange={(o) => !o && setDlg(null)} table={table} />
      <CodeDialog
        open={dlg === 'export'}
        onOpenChange={(o) => !o && setDlg(null)}
        title={`Export ${table.displayName} as CSV`}
        description="Opens in Excel or any spreadsheet. System columns are included."
        text={dlg === 'export' ? platform.tables.exportCsv(table.name) : ''}
        filename={`${table.name}.csv`}
        mime="text/csv"
      />
      <ConfirmDialog
        open={dlg === 'delete'}
        onOpenChange={(o) => !o && setDlg(null)}
        title={`Delete ${selected.size} ${selected.size === 1 ? 'row' : 'rows'}?`}
        description="This permanently removes the selected rows from the table."
        onConfirm={() => {
          platform.tables.delete(table.name, [...selected], { secure: false })
          setSelected(new Set())
          setActive(null)
        }}
      />
    </div>
  )
}
