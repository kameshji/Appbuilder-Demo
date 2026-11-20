import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FileUp, HardDrive, Lock, Plus, Table2, Wand2, X } from 'lucide-react'
import { SYSTEM_GROUP_LABELS } from '@/platform/system-tables'
import { platform, usePlatform, type ColumnDef, type ColumnType, type TableDef } from '@/platform'
import { go } from '@/router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Empty, Field, Panel, PageHeader, fmtDate, useToast } from './kit'
import { TYPE_GROUPS, TYPE_INFO } from './columnTypes'
import { matches, useSearch } from './Shell'
import { TABLE_HOSTS, connectorInfo } from './ConnectionBits'
import { useCaps } from './security'
import { AutoAppDialog } from '@/autoapp/AutoAppDialog'

export function TypeSelect({ value, onChange, disabled, id, className }: { value: ColumnType; onChange(t: ColumnType): void; disabled?: boolean; id?: string; className?: string }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as ColumnType)} disabled={disabled}>
      <SelectTrigger id={id} className={className ?? 'w-full'} size="sm"><SelectValue /></SelectTrigger>
      <SelectContent>
        {TYPE_GROUPS.map((g) => (
          <SelectGroup key={g.label}>
            <SelectLabel>{g.label}</SelectLabel>
            {g.types.map((t) => {
              const I = TYPE_INFO[t].icon
              return (
                <SelectItem key={t} value={t}>
                  <span className="flex items-center gap-2"><I className="size-3.5 text-muted-foreground" />{TYPE_INFO[t].label}</span>
                </SelectItem>
              )
            })}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}

interface DraftCol { displayName: string; type: ColumnType }

function NewTableDialog({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const { fail, toast } = useToast()
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [cols, setCols] = useState<DraftCol[]>([{ displayName: 'Name', type: 'text' }])
  const [busy, setBusy] = useState(false)
  const connections = usePlatform((s) => s.connections)
  const mode = usePlatform((s) => s.mode)
  const hosts = connections.filter((c) => TABLE_HOSTS.includes(c.connector) && c.status !== 'not-configured')
  const defaultConn = hosts.find((c) => c.isDefault) ?? hosts[0]
  const [connId, setConnId] = useState('')
  useEffect(() => { if (open) { setName(''); setDesc(''); setCols([{ displayName: 'Name', type: 'text' }]); setConnId(defaultConn?.id ?? '') } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = hosts.find((c) => c.id === connId)
  const create = async () => {
    setBusy(true)
    try {
      const columns: Partial<ColumnDef>[] = cols.filter((c) => c.displayName.trim()).map((c) => ({ displayName: c.displayName.trim(), type: c.type }))
      // connectionId travels to POST /tables; the shared contract's create() input does not list it yet
      const input = { displayName: name.trim(), description: desc.trim() || undefined, columns, ...(mode === 'server' && chosen ? { connectionId: chosen.id } : {}) }
      let t = await platform.tables.create(input)
      if (mode === 'server' && chosen && t.connectionId && t.connectionId !== chosen.id) t = await platform.tables.moveToConnection(t.id, chosen.id)
      toast(`Created table "${t.displayName}"`, 'success')
      onOpenChange(false)
      go({ page: 'table', id: t.id })
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="new-table-dialog">
        <DialogHeader>
          <DialogTitle>New table</DialogTitle>
          <DialogDescription>Define the table and, optionally, its first columns. You can change everything later in the designer.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void create() }}>
          <Field label="Display name" htmlFor="new-table-name" hint="The formula name is derived from this, e.g. Project tasks becomes ProjectTasks.">
            <Input id="new-table-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Projects" data-testid="new-table-name" />
          </Field>
          <Field label="Description (optional)">
            <Input value={desc} onChange={(e) => setDesc(e.target.value)} />
          </Field>
          {mode === 'server' && hosts.length > 0 && (
            <Field label="Store in" hint={chosen?.scope === 'device' ? 'Device only: this table stays on this machine.' : chosen?.connector === 'gsheets' ? 'A new tab is added to the spreadsheet.' : 'The default connection holds new tables unless you pick another.'}>
              <Select value={connId} onValueChange={setConnId}>
                <SelectTrigger className="w-full" size="sm" data-testid="new-table-connection"><SelectValue placeholder="Choose a connection" /></SelectTrigger>
                <SelectContent>
                  {hosts.map((c) => {
                    const I = connectorInfo(c.connector).icon
                    return <SelectItem key={c.id} value={c.id}><span className="flex items-center gap-2"><I className="size-3.5 text-muted-foreground" />{c.name}{c.isDefault ? ' (default)' : ''}</span></SelectItem>
                  })}
                </SelectContent>
              </Select>
            </Field>
          )}
          <div className="grid gap-1.5">
            <div className="text-xs font-medium">First columns (optional)</div>
            <div className="grid max-h-52 gap-1.5 overflow-auto pr-1">
              {cols.map((c, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input aria-label={`Column ${i + 1} name`} className="h-8 flex-1" placeholder="Column name" value={c.displayName} onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, displayName: e.target.value } : x)))} />
                  <TypeSelect className="w-52" value={c.type} onChange={(t) => setCols(cols.map((x, j) => (j === i ? { ...x, type: t } : x)))} />
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove column" onClick={() => setCols(cols.filter((_, j) => j !== i))}><X /></Button>
                </div>
              ))}
            </div>
            <div><Button type="button" variant="ghost" size="xs" onClick={() => setCols([...cols, { displayName: '', type: 'text' }])}><Plus /> Add column</Button></div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !name.trim()} data-testid="new-table-create">Create table</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function CsvNewTableDialog({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const { fail, toast } = useToast()
  const [name, setName] = useState('')
  const [csv, setCsv] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (open) { setName(''); setCsv('') } }, [open])
  const run = async () => {
    setBusy(true)
    try {
      const t = await platform.tables.createFromCsv(name.trim(), csv)
      toast(`Created table "${t.displayName}" with ${platform.tables.rows(t.name, { secure: false }).length} rows`, 'success')
      onOpenChange(false)
      go({ page: 'table', id: t.id })
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="csv-table-dialog">
        <DialogHeader>
          <DialogTitle>Import CSV as new table</DialogTitle>
          <DialogDescription>The first row is the header. Column types are inferred from the values.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Table name" htmlFor="csv-table-name">
            <Input id="csv-table-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Suppliers" data-testid="csv-table-name" />
          </Field>
          <textarea value={csv} onChange={(e) => setCsv(e.target.value)} spellCheck={false} aria-label="CSV text" placeholder={'Name,City,Active\nAda,London,true'} data-testid="csv-table-text" className="h-48 w-full resize-none rounded-md border border-input bg-muted/40 p-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30" />
          <div>
            <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" className="sr-only" aria-label="Choose CSV file" data-testid="csv-table-file"
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (!f) return
                f.text().then((t) => { setCsv(t); setName((n) => n || f.name.replace(/\.csv$/i, '')) }).catch(fail)
              }} />
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}><FileUp /> Choose file</Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || !name.trim() || !csv.trim()} onClick={() => void run()} data-testid="csv-table-create">Create table</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ConnectionCell({ t }: { t: TableDef }) {
  const conn = usePlatform((s) => s.connections.find((c) => c.id === (t.connectionId ?? 'conn_default')) ?? s.connections.find((c) => c.isDefault && !t.connectionId))
  const m = conn ? connectorInfo(conn.connector) : null
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={`table-connection-${t.id}`}>
      {m && <span className="flex items-center gap-1.5 text-muted-foreground"><m.icon className="size-3.5" />{conn?.name}</span>}
      {!m && <span className="text-muted-foreground">{t.connectionId ?? 'Browser storage'}</span>}
      {conn?.scope === 'device' && <Badge variant="outline"><HardDrive /> Device only</Badge>}
      {t.origin?.kind === 'file' && <Badge variant="secondary" title={`From file ${t.origin.fileName}`}>File</Badge>}
      {t.readOnly && <Badge variant="outline"><Lock /> Read-only</Badge>}
    </div>
  )
}

function RowCount({ t }: { t: TableDef }) {
  const loading = usePlatform((s) => s.loading.includes(t.name))
  const truncated = usePlatform((s) => s.truncated.includes(t.name))
  const n = platform.tables.rows(t.name, { secure: false }).length
  if (loading && n === 0) return <Spinner className="ml-auto size-3.5" aria-label="Loading rows" />
  return <>{n}{truncated ? '+' : ''}</>
}

export function Tables() {
  const tables = usePlatform((s) => s.tables)
  usePlatform((s) => s.dataVersion)
  const mode = usePlatform((s) => s.mode)
  const q = useSearch()
  const [dlg, setDlg] = useState<'new' | 'csv' | 'app' | null>(null)
  const close = (o: boolean) => { if (!o) setDlg(null) }
  const caps = useCaps()
  // core data model: system tables are listed apart, grouped (they exist in every environment)
  const list = tables.filter((t) => !t.system && matches(q, t.displayName, t.name, t.description))
  const system = tables.filter((t) => t.system && matches(q, t.displayName, t.name, t.description))

  return (
    <div data-testid="page-tables">
      <PageHeader
        icon={Table2}
        title="Tables"
        subtitle={mode === 'server' ? 'Your data. Tables live in a connection: the default database, a linked sheet or a data file.' : 'Your data. Each table is stored in this browser.'}
        actions={
          <>
            {caps.isMaker && tables.some((t) => !t.system) && <Button variant="outline" size="sm" onClick={() => setDlg('app')} data-testid="tables-create-app"><Wand2 /> Create app</Button>}
            <Button variant="outline" size="sm" onClick={() => setDlg('csv')} data-testid="import-csv-table-button"><FileUp /> Import CSV</Button>
            <Button size="sm" onClick={() => setDlg('new')} data-testid="new-table-button"><Plus /> New table</Button>
          </>
        }
      />
      {tables.filter((t) => !t.system).length === 0 && !q ? (
        <Empty icon={Table2} title="No tables yet" description="Create a table or import a CSV file to get started." action={<Button onClick={() => setDlg('new')}><Plus /> New table</Button>} />
      ) : list.length === 0 ? (
        <Empty icon={Table2} title="No matching tables" description={`Nothing matches "${q}".`} />
      ) : (
        <Panel className="overflow-hidden">
          <table className="w-full text-sm" data-testid="tables-list">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs font-medium text-muted-foreground">
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Connection</th>
                <th className="px-4 py-2.5">Formula name</th>
                <th className="px-4 py-2.5 text-right">Columns</th>
                <th className="px-4 py-2.5 text-right">Rows</th>
                <th className="px-4 py-2.5">Modified</th>
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr
                  key={t.id}
                  data-testid={`table-row-${t.id}`}
                  tabIndex={0}
                  onClick={() => go({ page: 'table', id: t.id })}
                  onKeyDown={(e) => { if (e.key === 'Enter') go({ page: 'table', id: t.id }) }}
                  className="cursor-pointer border-b border-border outline-none last:border-0 hover:bg-accent/40 focus-visible:bg-accent/60"
                >
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <span className="grid size-7 place-items-center rounded-md bg-accent text-accent-foreground"><Table2 className="size-3.5" /></span>
                      <div className="min-w-0">
                        <div className="font-medium">{t.displayName}</div>
                        {t.description && <div className="truncate text-xs text-muted-foreground">{t.description}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-xs"><ConnectionCell t={t} /></td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{t.name}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{t.columns.filter((c) => !c.system).length}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums"><RowCount t={t} /></td>
                  <td className="px-4 py-2.5 text-muted-foreground">{fmtDate(t.modifiedOn)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
      {system.length > 0 && <SystemTables tables={system} open={!!q} />}
      <NewTableDialog open={dlg === 'new'} onOpenChange={close} />
      <CsvNewTableDialog open={dlg === 'csv'} onOpenChange={close} />
      <AutoAppDialog open={dlg === 'app'} onOpenChange={close} multi />
    </div>
  )
}

/** the core data model's system tables, by group: readable, extensible, never deleted or renamed */
function SystemTables({ tables, open: forceOpen }: { tables: TableDef[]; open: boolean }) {
  const [open, setOpen] = useState(false)
  const shown = open || forceOpen
  const groups = Object.entries(SYSTEM_GROUP_LABELS).map(([g, label]) => ({ g, label, list: tables.filter((t) => t.systemGroup === g) })).filter((x) => x.list.length)
  return (
    <div className="mt-6" data-testid="system-tables">
      <button type="button" className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground" onClick={() => setOpen(!open)} aria-expanded={shown} data-testid="system-tables-toggle">
        {shown ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <Lock className="size-3.5" /> System tables <Badge variant="secondary" className="font-normal">{tables.length}</Badge>
        <span className="font-normal">In every environment: people, collaboration, files, logs and reference data.</span>
      </button>
      {shown && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {groups.map(({ g, label, list }) => (
            <Panel key={g} className="overflow-hidden" data-testid={`system-group-${g}`}>
              <div className="border-b border-border bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground">{label}</div>
              {list.map((t) => (
                <button key={t.id} type="button" onClick={() => go({ page: 'table', id: t.id })} data-testid={`table-row-${t.id}`}
                  className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-sm last:border-0 hover:bg-accent/40">
                  <span className="min-w-0 flex-1 truncate">{t.displayName}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{t.name}</span>
                  {t.systemKind === 'projection' ? <Badge variant="outline" className="font-normal">Read-only</Badge> : t.extensible ? <Badge variant="secondary" className="font-normal">Extensible</Badge> : null}
                </button>
              ))}
            </Panel>
          ))}
        </div>
      )}
    </div>
  )
}

