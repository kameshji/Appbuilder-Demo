import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronsUpDown, FileDown, FileUp, Plus, Rows3, Search, Trash2, X } from 'lucide-react'
import { platform, usePlatform, type ColumnDef, type TableDef } from '@/platform'
import type { FxRecord } from '@/contracts'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CodeDialog, ConfirmDialog, Empty, Field, Segmented, useToast } from './kit'
import { CellEditor, buildLookups, compareValues, displayText, draftToValue, isNumeric, valueToDraft } from './cells'
import { TYPE_INFO } from './columnTypes'

const PAGE = 200

/* ------------------------------------------------------------------ add row */

function AddRowDialog({ open, onOpenChange, table, cols, onAdded }: { open: boolean; onOpenChange(o: boolean): void; table: TableDef; cols: ColumnDef[]; onAdded(id: string): void }) {
  const { fail, toast } = useToast()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const lookups = useMemo(() => (open ? buildLookups(cols) : {}), [open, cols])
  const editable = cols.filter((c) => !c.system && c.type !== 'autonumber')
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
          <DialogDescription>Fields marked * are required. Autonumber and system columns are filled in for you.</DialogDescription>
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

/* ------------------------------------------------------------------ grid */

export function DataGrid({ table }: { table: TableDef }) {
  const { fail } = useToast()
  const dataVersion = usePlatform((s) => s.dataVersion)
  const tables = usePlatform((s) => s.tables)
  const gridRef = useRef<HTMLDivElement>(null)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<{ col: string; dir: 'asc' | 'desc' } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [active, setActive] = useState<{ r: number; c: number } | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [dlg, setDlg] = useState<'add' | 'import' | 'export' | 'delete' | null>(null)
  const editingRef = useRef(false)
  editingRef.current = editing

  const cols = useMemo(() => {
    const user = table.columns.filter((c) => !c.system)
    const mod = table.columns.find((c) => c.name === 'modifiedOn')
    return mod ? [...user, mod] : user
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table])
  const lookups = useMemo(() => buildLookups(cols), [cols, tables, dataVersion])
  const rows = useMemo(() => platform.tables.rows(table.name, { secure: false }), [table.name, dataVersion])

  const view = useMemo(() => {
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
  }, [rows, filter, sort, cols, lookups])
  const shown = view.slice(0, limit)
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

  const isReadonly = (c: ColumnDef) => !!c.system || c.type === 'autonumber'
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
      case 'Backspace': if (!isReadonly(col) && col.type !== 'boolean') { e.preventDefault(); save(r, col, '') } return
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !isReadonly(col) && !['boolean', 'choice', 'lookup'].includes(col.type)) {
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
        <Button size="sm" onClick={() => setDlg('add')} data-testid="add-row-button"><Plus /> Add row</Button>
        <Button size="sm" variant="outline" disabled={selected.size === 0} onClick={() => setDlg('delete')} data-testid="delete-rows-button">
          <Trash2 /> Delete{selected.size > 0 ? ` (${selected.size})` : ''}
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground" data-testid="row-count">
            {filter.trim() ? `${view.length} of ${rows.length} rows` : `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`}
            {selected.size > 0 && ` · ${selected.size} selected`}
          </span>
          <Button size="sm" variant="outline" onClick={() => setDlg('import')} data-testid="csv-import-button"><FileUp /> Import CSV</Button>
          <Button size="sm" variant="outline" onClick={() => setDlg('export')} data-testid="csv-export-button"><FileDown /> Export CSV</Button>
        </div>
      </div>

      {rows.length === 0 ? (
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
            aria-rowcount={view.length + 1}
            tabIndex={0}
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
                      <td className="border-b border-r border-border px-2 text-center text-[11px] tabular-nums text-muted-foreground">{ri + 1}</td>
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
                            onDoubleClick={() => { setActive({ r: ri, c: ci }); if (c.type !== 'boolean') { setDraft(valueToDraft(c, v)); if (!ro) setEditing(true) } }}
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
          {view.length > shown.length && (
            <div className="flex items-center justify-center gap-3 border-t border-border bg-muted/40 py-2 text-xs text-muted-foreground">
              Showing {shown.length} of {view.length}
              <Button size="xs" variant="outline" onClick={() => setLimit((l) => l + PAGE)}>Show {Math.min(PAGE, view.length - shown.length)} more</Button>
            </div>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">Click a cell and press Enter or just start typing to edit. Arrow keys move, Tab and Enter commit, Escape cancels. Edits here ignore security roles.</p>

      <AddRowDialog open={dlg === 'add'} onOpenChange={(o) => !o && setDlg(null)} table={table} cols={table.columns} onAdded={() => setLimit((l) => Math.max(l, PAGE))} />
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
