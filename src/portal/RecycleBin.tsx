/**
 * Recycle bin in the portal (docs/dev/recycle-bin.md, docs/guide/maker/data.md "Deleted rows"): the table designer's
 * setting ("Keep deleted rows for N days") with the storage note and "Empty now", and the data grid's Deleted view
 * (who deleted, when, batch, days left; restore a row or the whole batch; delete for good for administrators).
 */
import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, RotateCcw, Trash2, Undo2 } from 'lucide-react'
import { platform, type ColumnDef, type TableDef } from '@/platform'
import { daysLeftText, recycleUnavailable, type DeletedRow, type RecycleStats } from '@/platform/recycle-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, Panel, fmtDate, fmtRelative, useToast } from './kit'
import { displayText } from './cells'
import { useCaps } from './security'

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/** does this table show a Deleted view (it keeps deleted rows now, or did and may still hold some)? */
export const hasDeletedView = (t: TableDef): boolean => (t.recycleDays ?? 0) > 0 || t.recycleBin === true

/* ------------------------------------------------------------------ the setting (table designer, Settings tab) */

export function RecycleSettingPanel({ table }: { table: TableDef }) {
  const { toast, fail } = useToast()
  const caps = useCaps()
  const why = recycleUnavailable(table)
  const days = table.recycleDays ?? 0
  const [draft, setDraft] = useState(String(days || 30))
  const [stats, setStats] = useState<RecycleStats | null>(null)
  const [empty, setEmpty] = useState(false)
  useEffect(() => setDraft(String(days || 30)), [days, table.id])
  const load = useCallback(() => {
    if (why || !hasDeletedView(table)) { setStats(null); return }
    platform.recycle?.stats(table.name).then(setStats).catch(() => setStats(null))
  }, [table, why])
  useEffect(() => { load() }, [load])
  const save = (n: number) => {
    platform.tables.update(table.id, { recycleDays: n })
      .then(() => toast(n > 0 ? `Deleted rows are kept for ${n} ${n === 1 ? 'day' : 'days'}` : 'Deletes are final now; rows already in the recycle bin stay until their time runs out', 'success'))
      .then(load)
      .catch(fail)
  }
  return (
    <Panel className="grid gap-3 p-5" data-testid="recycle-setting">
      <h3 className="text-sm font-semibold">Recycle bin</h3>
      {why ? (
        <p className="text-sm text-muted-foreground" data-testid="recycle-unavailable">{why} Deleted rows cannot be restored; use a backup of that system instead.</p>
      ) : (
        <>
          <label className="flex items-start justify-between gap-3 text-sm">
            <span>
              <span className="font-medium">Keep deleted rows</span>
              <span className="block text-xs text-muted-foreground">
                A deleted row disappears at once from apps, queries, reports and exports, but stays in this table's recycle bin for the number of days below.
                People who could delete it (and administrators) can restore it from <span className="font-medium">Data &gt; Deleted</span>, apps show an Undo after a delete,
                and makers can build their own screen with DeletedRows() and Restore(). After the days run out the rows (and their attachment files) are deleted for good.
                Turned off, deletes are final as before.
              </span>
            </span>
            <Switch checked={days > 0} disabled={!caps.isMaker} onCheckedChange={(v) => save(v ? Math.max(1, Number(draft) || 30) : 0)} aria-label="Keep deleted rows" data-testid="recycle-switch" />
          </label>
          {days > 0 && (
            <div className="flex items-center gap-2 text-sm">
              <span>Keep for</span>
              <Input value={draft} onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))} onBlur={() => { const n = Number(draft); if (n >= 1 && n <= 3650 && n !== days) save(n) }} className="h-8 w-20" inputMode="numeric" aria-label="Days to keep deleted rows" data-testid="recycle-days" />
              <span>days</span>
            </div>
          )}
          {stats && (stats.deletedRows ?? 0) > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground" data-testid="recycle-storage">
              <span>In the recycle bin: <span className="font-medium text-foreground">{(stats.deletedRows ?? 0).toLocaleString('en-US')} {stats.deletedRows === 1 ? 'row' : 'rows'}</span> from {stats.batches} {stats.batches === 1 ? 'delete' : 'deletes'}{stats.bytes ? `, about ${fmtBytes(stats.bytes)} (attachment files not counted)` : ''}.</span>
              {caps.isAdmin && <Button size="xs" variant="outline" onClick={() => setEmpty(true)} data-testid="recycle-empty"><Trash2 /> Empty now</Button>}
            </div>
          )}
          <p className="text-xs text-muted-foreground">Deleting the whole table is different: it is not kept in a recycle bin (restore a backup to get a deleted table back).</p>
        </>
      )}
      <EmptyBinDialog open={empty} onOpenChange={setEmpty} table={table} onDone={load} />
    </Panel>
  )
}

function EmptyBinDialog({ open, onOpenChange, table, onDone }: { open: boolean; onOpenChange(o: boolean): void; table: TableDef; onDone(): void }) {
  const { toast, fail } = useToast()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) setTyped('') }, [open])
  const run = async () => {
    setBusy(true)
    try {
      const r = await platform.recycle!.purge(table.name, { all: true, confirm: typed })
      toast(`Deleted ${r.rows.toLocaleString('en-US')} ${r.rows === 1 ? 'row' : 'rows'} for good`, 'success')
      onOpenChange(false)
      onDone()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="recycle-empty-dialog">
        <DialogHeader>
          <DialogTitle>Empty the recycle bin of {table.displayName}?</DialogTitle>
          <DialogDescription>Every deleted row of this table (and the rows deleted together with them in other tables) is deleted for good, with its attachment files. This cannot be undone and is recorded in the audit log. Type <span className="font-mono font-medium text-foreground">{table.name}</span> to confirm.</DialogDescription>
        </DialogHeader>
        <Input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Table name" data-testid="recycle-empty-confirm" autoFocus />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" disabled={busy || typed.trim().toLowerCase() !== table.name.toLowerCase()} onClick={() => void run()} data-testid="recycle-empty-run">Delete for good</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ the Deleted view (data grid) */

const PAGE = 100

export function DeletedRowsView({ table, cols, lookups }: { table: TableDef; cols: ColumnDef[]; lookups: Parameters<typeof displayText>[2] }) {
  const { toast, fail } = useToast()
  const caps = useCaps()
  const [rows, setRows] = useState<DeletedRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [skip, setSkip] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [purge, setPurge] = useState<DeletedRow | null>(null)
  const shown = cols.filter((c) => !c.system).slice(0, 4)
  const load = useCallback(() => {
    if (!platform.recycle) { setRows([]); return }
    platform.recycle.list(table.name, { limit: PAGE, skip }).then((r) => { setRows(r.rows); setTotal(r.total) }).catch((e) => { fail(e); setRows([]) })
  }, [table.name, skip]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setRows(null); load() }, [load])
  // deletes, restores (the Undo toast too) and purges of this session change the list
  useEffect(() => platform.recycle?.onChange((t) => { if (t.includes(table.name) || t.includes(table.id)) load() }) ?? (() => {}), [table.name, table.id, load])

  const restore = async (r: DeletedRow, whole: boolean) => {
    setBusy(r.id)
    try {
      const res = await platform.recycle!.restore(table.name, whole ? { batch: r.__deleted.batch } : { rowId: r.id })
      toast(`Restored ${res.restored === 1 ? '1 row' : `${res.restored} rows`}${res.warnings.length ? `. ${res.warnings.join(' ')}` : ''}`, 'success')
      load()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }
  if (rows === null) return <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border py-12 text-sm text-muted-foreground"><Spinner /> Loading deleted rows...</div>
  return (
    <div className="grid gap-2" data-testid="deleted-view">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span data-testid="deleted-count">{total.toLocaleString('en-US')} deleted {total === 1 ? 'row' : 'rows'} you can restore</span>
        <Button size="xs" variant="ghost" onClick={load} aria-label="Refresh"><RefreshCw /></Button>
        <span className="ml-auto">Restoring a batch brings back everything that one delete did: related rows deleted with it and links that were cleared.</span>
      </div>
      {!rows.length ? (
        <Empty icon={Undo2} title="Nothing in the recycle bin" description={(table.recycleDays ?? 0) > 0 ? `Rows deleted from ${table.displayName} stay here for ${daysLeftText(table.recycleDays ?? 0)}.` : 'This table keeps no deleted rows now; rows deleted earlier stay here until their time runs out.'} />
      ) : (
        <div className="max-h-[calc(100vh-320px)] overflow-auto rounded-xl border border-border bg-card shadow-xs">
          <table className="w-max min-w-full border-separate border-spacing-0 text-sm" data-testid="deleted-table">
            <thead>
              <tr>
                {[...shown.map((c) => c.displayName), 'Deleted', 'By', 'Delete', 'Kept for', ''].map((h, i) => (
                  <th key={i} className="sticky top-0 z-10 border-b border-r border-border bg-muted px-2.5 py-2 text-left text-xs font-medium last:border-r-0">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const d = r.__deleted
                return (
                  <tr key={r.id} data-testid={`deleted-${r.id}`} className="hover:bg-muted/40">
                    {shown.map((c) => <td key={c.name} className="max-w-60 truncate border-b border-r border-border px-2.5 py-1.5">{displayText(c, r[c.name] as never, lookups)}</td>)}
                    <td className="border-b border-r border-border px-2.5 py-1.5 text-xs" title={fmtDate(d.on)}>{fmtRelative(d.on)}</td>
                    <td className="border-b border-r border-border px-2.5 py-1.5 text-xs">{d.byName ?? d.by ?? 'System'}{d.source !== 'user' ? <span className="text-muted-foreground"> ({d.source})</span> : null}</td>
                    <td className="border-b border-r border-border px-2.5 py-1.5 text-xs text-muted-foreground" title={d.batch}>
                      {d.cascaded ? `with a row of ${d.rootTableName}` : d.batchRows > 1 ? `${d.batchRows} rows together` : 'this row'}
                    </td>
                    <td className="border-b border-r border-border px-2.5 py-1.5 text-xs">{daysLeftText(d.daysLeft)}</td>
                    <td className="border-b border-border px-1.5 py-1 text-right">
                      <div className="flex justify-end gap-1">
                        {!d.cascaded && <Button size="xs" variant="outline" disabled={busy === r.id} onClick={() => void restore(r, false)} data-testid={`restore-row-${r.id}`}><RotateCcw /> Restore</Button>}
                        {(d.batchRows > 1 || d.cascaded) && <Button size="xs" variant="outline" disabled={busy === r.id} onClick={() => void restore(r, true)} data-testid={`restore-batch-${r.id}`}><Undo2 /> Restore {d.batchRows} rows</Button>}
                        {caps.isAdmin && <Button size="xs" variant="ghost" className="text-destructive" onClick={() => setPurge(r)} data-testid={`purge-${r.id}`} aria-label="Delete for good"><Trash2 /></Button>}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {total > skip + rows.length || skip > 0 ? (
            <div className="flex items-center justify-center gap-3 border-t border-border bg-muted/40 py-2 text-xs text-muted-foreground">
              <Button size="xs" variant="outline" disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - PAGE))}>Newer</Button>
              {skip + 1}-{skip + rows.length} of {total}
              <Button size="xs" variant="outline" disabled={skip + rows.length >= total} onClick={() => setSkip(skip + PAGE)}>Older</Button>
            </div>
          ) : null}
        </div>
      )}
      <Dialog open={!!purge} onOpenChange={(o) => !o && setPurge(null)}>
        <DialogContent data-testid="purge-dialog">
          <DialogHeader>
            <DialogTitle>Delete for good?</DialogTitle>
            <DialogDescription>This deletes the {purge?.__deleted.batchRows === 1 ? 'row' : `${purge?.__deleted.batchRows} rows of this delete`} for good, with attachment files. It cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPurge(null)}>Cancel</Button>
            <Button variant="destructive" data-testid="purge-run" onClick={() => {
              const r = purge!
              setPurge(null)
              platform.recycle!.purge(table.name, { batch: r.__deleted.batch }).then((x) => { toast(`Deleted ${x.rows} ${x.rows === 1 ? 'row' : 'rows'} for good`, 'success'); load() }).catch(fail)
            }}>Delete for good</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
