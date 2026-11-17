import { useEffect, useState } from 'react'
import { Cable, Cloud, Database, FileSpreadsheet, FileText, Flame, Globe, Pencil, Plus, Server, Trash2, Zap, type LucideIcon } from 'lucide-react'
import { platform, usePlatform, type ConnectionRef, type ConnectorKind } from '@/platform'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog, Empty, Field, Panel, PageHeader, useToast } from './kit'
import { matches, useSearch } from './Shell'

const CONNECTORS: { kind: ConnectorKind; label: string; icon: LucideIcon; text: string; fields: { key: string; label: string; placeholder?: string }[] }[] = [
  { kind: 'local-csv', label: 'Local CSV', icon: FileText, text: 'Tables stored as CSV files in your workspace.', fields: [] },
  { kind: 'rest', label: 'REST API', icon: Globe, text: 'Call a JSON web service.', fields: [{ key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.example.com' }] },
  { kind: 'postgres', label: 'PostgreSQL', icon: Database, text: 'A PostgreSQL database.', fields: [{ key: 'host', label: 'Host' }, { key: 'database', label: 'Database' }] },
  { kind: 'mysql', label: 'MySQL', icon: Database, text: 'A MySQL or MariaDB database.', fields: [{ key: 'host', label: 'Host' }, { key: 'database', label: 'Database' }] },
  { kind: 'sqlserver', label: 'SQL Server', icon: Server, text: 'A SQL Server database.', fields: [{ key: 'host', label: 'Server' }, { key: 'database', label: 'Database' }] },
  { kind: 'supabase', label: 'Supabase', icon: Zap, text: 'A Supabase project.', fields: [{ key: 'projectUrl', label: 'Project URL' }] },
  { kind: 'firebase', label: 'Firebase', icon: Flame, text: 'A Firebase project.', fields: [{ key: 'projectId', label: 'Project id' }] },
  { kind: 'excel', label: 'Excel file', icon: FileSpreadsheet, text: 'Read a workbook from disk.', fields: [{ key: 'path', label: 'File path' }] },
]
const info = (k: ConnectorKind) => CONNECTORS.find((c) => c.kind === k) ?? CONNECTORS[0]

function ConnectionDialog({ open, onOpenChange, connection }: { open: boolean; onOpenChange(o: boolean): void; connection: ConnectionRef | null }) {
  const { fail, toast } = useToast()
  const [kind, setKind] = useState<ConnectorKind>('local-csv')
  const [name, setName] = useState('')
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    setKind(connection?.connector ?? 'local-csv')
    setName(connection?.name ?? '')
    setSettings(connection?.settings ?? {})
  }, [open, connection])
  const meta = info(kind)
  const run = async () => {
    setBusy(true)
    try {
      if (connection) await platform.connections.update(connection.id, { name: name.trim(), settings })
      else await platform.connections.create({ name: name.trim(), connector: kind, settings })
      toast(connection ? 'Connection updated' : `Added connection "${name.trim()}"`, 'success')
      onOpenChange(false)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="connection-dialog">
        <DialogHeader>
          <DialogTitle>{connection ? 'Edit connection' : 'New connection'}</DialogTitle>
          <DialogDescription>Only Local CSV works in this version. Other connectors are saved as placeholders and marked "Not configured".</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void run() }}>
          {!connection && (
            <div role="radiogroup" aria-label="Connector" className="grid grid-cols-4 gap-2">
              {CONNECTORS.map((c) => (
                <button
                  key={c.kind}
                  type="button"
                  role="radio"
                  aria-checked={kind === c.kind}
                  data-testid={`connector-${c.kind}`}
                  onClick={() => { setKind(c.kind); setSettings({}); if (!name.trim()) setName('') }}
                  className={cn('flex flex-col items-center gap-1.5 rounded-lg border p-2.5 text-center text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40', kind === c.kind ? 'border-primary bg-accent text-accent-foreground' : 'border-border hover:bg-muted')}
                >
                  <c.icon className="size-5" />
                  {c.label}
                  {c.kind !== 'local-csv' && <span className="text-[10px] font-normal text-muted-foreground">Coming later</span>}
                </button>
              ))}
            </div>
          )}
          <Field label="Connection name" htmlFor="conn-name"><Input id="conn-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={`e.g. ${meta.label} (main)`} data-testid="connection-name" /></Field>
          {meta.fields.map((f) => (
            <Field key={f.key} label={f.label}>
              <Input value={settings[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setSettings({ ...settings, [f.key]: e.target.value })} />
            </Field>
          ))}
          {kind !== 'local-csv' && <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">This connector is not functional yet. The reference is stored so solutions can carry it, and it will show as "Not configured".</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !name.trim()} data-testid="connection-save">{connection ? 'Save' : 'Add connection'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function Connections() {
  const connections = usePlatform((s) => s.connections)
  const q = useSearch()
  const [dlg, setDlg] = useState<{ conn: ConnectionRef | null } | null>(null)
  const [del, setDel] = useState<ConnectionRef | null>(null)
  const { toast } = useToast()
  const list = connections.filter((c) => matches(q, c.name, info(c.connector).label))
  return (
    <div data-testid="page-connections">
      <PageHeader
        icon={Cable}
        title="Connections"
        subtitle="Connection references describe where data comes from. Local CSV is the only working connector for now."
        actions={<Button size="sm" onClick={() => setDlg({ conn: null })} data-testid="new-connection-button"><Plus /> New connection</Button>}
      />
      {connections.length === 0 ? (
        <Empty icon={Cloud} title="No connections yet" description="Add a connection reference. Local CSV is ready to use." action={<Button onClick={() => setDlg({ conn: null })}><Plus /> New connection</Button>} />
      ) : list.length === 0 ? (
        <Empty icon={Cable} title="No matching connections" description={`Nothing matches "${q}".`} />
      ) : (
        <Panel className="overflow-hidden">
          <table className="w-full text-sm" data-testid="connections-list">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs font-medium text-muted-foreground">
                <th className="px-4 py-2.5">Name</th><th className="px-4 py-2.5">Connector</th><th className="px-4 py-2.5">Status</th><th className="w-24 px-4 py-2.5"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => {
                const m = info(c.connector)
                return (
                  <tr key={c.id} className="border-b border-border last:border-0 hover:bg-accent/40" data-testid={`connection-row-${c.id}`}>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5"><span className="grid size-7 place-items-center rounded-md bg-accent text-accent-foreground"><m.icon className="size-3.5" /></span><span className="font-medium">{c.name}</span></div>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{m.label}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        {c.status === 'connected' ? <Badge className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">Connected</Badge> : <Badge variant="secondary">Not configured</Badge>}
                        {c.connector !== 'local-csv' && <Badge variant="outline">Coming later</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-1.5">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${c.name}`} onClick={() => setDlg({ conn: c })}><Pencil /></Button>
                        <Button variant="ghost" size="icon-sm" aria-label={`Delete ${c.name}`} onClick={() => setDel(c)}><Trash2 /></Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Panel>
      )}
      <ConnectionDialog open={!!dlg} onOpenChange={(o) => !o && setDlg(null)} connection={dlg?.conn ?? null} />
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Delete connection "${del?.name ?? ''}"?`}
        description="Only the reference is removed. Your tables and files are not affected."
        onConfirm={async () => { if (del) { await platform.connections.remove(del.id); toast('Connection deleted', 'success') } }}
      />
    </div>
  )
}
