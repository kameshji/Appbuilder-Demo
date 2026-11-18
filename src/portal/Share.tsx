/**
 * Share one row with people or teams (read, or read and change). Opened from the data grid's row menu; the formula
 * functions Share / Unshare / SharedWith use the same API (platform.org). docs/admin/security-model.md.
 */
import { useEffect, useState } from 'react'
import { Share2, X } from 'lucide-react'
import { platform, type OrgDirectoryInfo, type SharesInfo, type TableDef } from '@/platform'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { Field, useToast } from './kit'

export function ShareDialog({ table, rowId, label, onOpenChange }: { table: TableDef; rowId: string | null; label?: string; onOpenChange(o: boolean): void }) {
  const { fail, toast } = useToast()
  const [info, setInfo] = useState<SharesInfo | null>(null)
  const [dir, setDir] = useState<OrgDirectoryInfo | null>(null)
  const [who, setWho] = useState('')
  const [access, setAccess] = useState<'read' | 'update'>('read')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!rowId) return
    let alive = true
    setInfo(null)
    setWho('')
    setAccess('read')
    Promise.all([platform.org.shares(rowId, table.id), platform.org.directory()])
      .then(([i, d]) => { if (alive) { setInfo(i); setDir(d) } })
      .catch((e) => { if (alive) { fail(e); onOpenChange(false) } })
    return () => { alive = false }
  }, [rowId, table.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (fn: () => Promise<SharesInfo>, msg: string) => {
    setBusy(true)
    try {
      setInfo(await fn())
      toast(msg, 'success')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const taken = new Set((info?.shares ?? []).map((s) => s.principalId))
  return (
    <Dialog open={!!rowId} onOpenChange={onOpenChange}>
      <DialogContent data-testid="share-dialog">
        <DialogHeader>
          <DialogTitle>Share {label ? `"${label}"` : 'this row'}</DialogTitle>
          <DialogDescription>People and teams you share with see this row even when their role would not show it (they still need a role that lets them use {table.displayName}).</DialogDescription>
        </DialogHeader>
        {!info ? <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Spinner /> Loading...</div> : (
          <div className="grid gap-4">
            {!info.sharing && <p className="text-sm text-muted-foreground">Sharing is off for this table (table designer, Settings).</p>}
            <ul className="grid gap-1.5" data-testid="share-list">
              {info.shares.length === 0 && <li className="text-sm text-muted-foreground">Not shared with anyone.</li>}
              {info.shares.map((s) => (
                <li key={`${s.principalType}:${s.principalId}`} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm" data-testid={`share-${s.principalId}`}>
                  <span className="font-medium">{s.principalName ?? s.principalId}</span>
                  <Badge variant="outline">{s.principalType === 'team' ? 'Team' : 'Person'}</Badge>
                  <span className="text-xs text-muted-foreground">{s.access === 'update' ? 'can read and change' : 'can read'}</span>
                  {info.canShare && <Button variant="ghost" size="icon-sm" className="ml-auto" disabled={busy} aria-label={`Stop sharing with ${s.principalName ?? s.principalId}`} onClick={() => void run(() => platform.org.unshare(info.row, s.principalId, table.id), 'Sharing removed')}><X /></Button>}
                </li>
              ))}
            </ul>
            {info.canShare ? (
              <form className="grid grid-cols-[1fr_auto_auto] items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (who) void run(() => platform.org.share(info.row, who, access, table.id), 'Shared') }}>
                <Field label="Share with" htmlFor="share-who">
                  <select id="share-who" value={who} onChange={(e) => setWho(e.target.value)} className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm" data-testid="share-who">
                    <option value="">Choose a person or team</option>
                    <optgroup label="Teams">{(dir?.teams ?? []).filter((t) => !taken.has(t.id)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>
                    <optgroup label="People">{(dir?.users ?? []).filter((u) => !taken.has(u.id) && u.id !== platform.security.currentUser().id).map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}</optgroup>
                  </select>
                </Field>
                <Field label="Access" htmlFor="share-access">
                  <select id="share-access" value={access} onChange={(e) => setAccess(e.target.value as 'read' | 'update')} className="h-8 rounded-md border border-input bg-background px-2 text-sm" data-testid="share-access">
                    <option value="read">Read</option>
                    {info.canShareUpdate && <option value="update">Read and change</option>}
                  </select>
                </Field>
                <Button type="submit" size="sm" disabled={busy || !who} data-testid="share-add"><Share2 /> Share</Button>
              </form>
            ) : info.sharing && <p className="text-sm text-muted-foreground">Only the owner of this row, or someone whose role has the Share privilege, can share it.</p>}
          </div>
        )}
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
