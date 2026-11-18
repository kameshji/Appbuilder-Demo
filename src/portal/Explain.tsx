/**
 * "Who can see this row?": pick a table and a row; the server (or demo mode, with the same rules from
 * src/platform/orgsec.ts) lists every user who may read, change or delete it and why (role and scope, a row rule,
 * a share, administrator).
 */
import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { platform, usePlatform, type ExplainResult } from '@/platform'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Field, useToast } from './kit'

export function WhoCanSeeDialog({ open, onOpenChange, table: initialTable, rowId: initialRow }: { open: boolean; onOpenChange(o: boolean): void; table?: string; rowId?: string }) {
  const tables = usePlatform((s) => s.tables)
  const dataVersion = usePlatform((s) => s.dataVersion)
  const { fail } = useToast()
  const [tableId, setTableId] = useState('')
  const [rowId, setRowId] = useState('')
  const [q, setQ] = useState('')
  const [res, setRes] = useState<ExplainResult | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    setRes(null)
    setQ('')
    setTableId(initialTable ?? tables[0]?.id ?? '')
    setRowId(initialRow ?? '')
  }, [open, initialTable, initialRow]) // eslint-disable-line react-hooks/exhaustive-deps
  const table = tables.find((t) => t.id === tableId || t.name === tableId)
  useEffect(() => { if (open && table) void platform.tables.ensureLoaded([table.name]).catch(() => {}) }, [open, table])
  const rows = useMemo(() => {
    if (!table) return []
    const all = platform.tables.rows(table.name, { secure: false })
    const n = q.trim().toLowerCase()
    return (n ? all.filter((r) => String(r[table.primaryColumn] ?? '').toLowerCase().includes(n) || String(r.id ?? '').includes(n)) : all).slice(0, 100)
  }, [table, q, open, dataVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open || !table || !rowId) return
    let alive = true
    setBusy(true)
    setRes(null)
    platform.org.explain(table.id, rowId).then((r) => alive && setRes(r)).catch((e) => { if (alive) fail(e) }).finally(() => alive && setBusy(false))
    return () => { alive = false }
  }, [open, table, rowId]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-3xl" data-testid="who-can-see-dialog">
        <DialogHeader>
          <DialogTitle>Who can see this row?</DialogTitle>
          <DialogDescription>Everyone who may read, change or delete one row, and the role, rule or share that allows it. Computed with the same rules that enforce access.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Table" htmlFor="who-table">
            <select id="who-table" value={table?.id ?? ''} onChange={(e) => { setTableId(e.target.value); setRowId('') }} className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm" data-testid="who-table">
              {tables.map((t) => <option key={t.id} value={t.id}>{t.displayName}</option>)}
            </select>
          </Field>
          <Field label="Row" htmlFor="who-row">
            <div className="grid gap-1.5">
              <Input id="who-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search rows" className="h-8" aria-label="Search rows" />
              <select id="who-row" value={rowId} onChange={(e) => setRowId(e.target.value)} className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm" data-testid="who-row">
                <option value="">Choose a row</option>
                {rows.map((r) => <option key={String(r.id)} value={String(r.id)}>{String(r[table?.primaryColumn ?? 'id'] ?? r.id)}</option>)}
              </select>
            </div>
          </Field>
        </div>
        {busy && <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Spinner /> Checking every user...</div>}
        {res && (
          <table className="w-full text-sm" data-testid="who-table-result">
            <thead><tr className="border-b border-border bg-muted/50 text-left text-xs font-medium text-muted-foreground"><th className="px-3 py-2">User</th><th className="px-3 py-2">Read</th><th className="px-3 py-2">Update</th><th className="px-3 py-2">Delete</th></tr></thead>
            <tbody>
              {res.users.map((u) => (
                <tr key={u.userId} className="border-b border-border align-top last:border-0" data-testid={`who-${u.userId}`}>
                  <td className="px-3 py-2"><div className="font-medium">{u.name}</div><div className="text-xs text-muted-foreground">{u.email}</div></td>
                  {(['read', 'update', 'delete'] as const).map((op) => (
                    <td key={op} className="px-3 py-2 text-xs">{u[op].length ? u[op].map((w, i) => <div key={i}>{w}</div>) : <span className="text-muted-foreground">No</span>}</td>
                  ))}
                </tr>
              ))}
              {res.users.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">Nobody can see this row.</td></tr>}
            </tbody>
          </table>
        )}
        {!res && !busy && <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Search className="size-4" /> Choose a row to see who has access.</p>}
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
