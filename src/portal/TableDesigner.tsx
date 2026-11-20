import { useEffect, useState } from 'react'
import { ArrowLeft, Calculator, CheckCheck, Columns3, Link2, Lock, Settings2, ShieldCheck, Sigma, Table2, Trash2, UserCheck, Wand2, Workflow, Zap } from 'lucide-react'
import { AutoAppDialog } from '@/autoapp/AutoAppDialog'
import { automate } from '@/flows/intent'
import { EventsPanel, FormulaColumnsPanel, RollupsPanel, ValidationRulesPanel } from './TableLogic'
import { platform, usePlatform } from '@/platform'
import { go } from '@/router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConfirmDialog, Empty, Field, Panel, fmtDate, useToast } from './kit'
import { DataGrid } from './DataGrid'
import { RecycleSettingPanel } from './RecycleBin'
import { ColumnsPanel } from './ColumnsPanel'
import { TableSecurity } from './TableSecurity'
import { ConnectionFlags, connectorInfo } from './ConnectionBits'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { useCaps } from './security'
import { assignOwnerToUnownedRows } from './serverApi'

/** server mode: Appbuilder created the physical table (only then may it be dropped); demo tables are always its own */
function isPlatformTable(t: { managed?: boolean; origin?: { kind: string }; connectionId?: string }, server: boolean): boolean {
  return !server || t.managed === true || t.origin?.kind === 'file'
}

export function TableDesigner({ tableId }: { tableId: string }) {
  const table = usePlatform((s) => s.tables.find((t) => t.id === tableId))
  const dataVersion = usePlatform((s) => s.dataVersion)
  const conn = usePlatform((s) => s.connections.find((c) => c.id === (table?.connectionId ?? 'conn_default')) ?? (table?.connectionId ? undefined : s.connections.find((c) => c.isDefault)))
  const { fail, toast } = useToast()
  const [tab, setTab] = useState('data')
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [del, setDel] = useState(false)
  const [dropSource, setDropSource] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const [appDlg, setAppDlg] = useState(false)
  const caps = useCaps()
  useEffect(() => { setName(table?.displayName ?? ''); setDesc(table?.description ?? '') }, [table?.id, table?.displayName, table?.description])
  useEffect(() => { setTab('data') }, [tableId])

  const back = (
    <button type="button" onClick={() => go({ page: 'tables' })} className="mb-2 inline-flex items-center gap-1 rounded text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40" data-testid="back-to-tables">
      <ArrowLeft className="size-3.5" /> Tables
    </button>
  )

  if (!table) {
    return (
      <div data-testid="page-table">
        {back}
        <Empty icon={Table2} title="Table not found" description="It may have been deleted." action={<Button onClick={() => go({ page: 'tables' })}>Back to tables</Button>} />
      </div>
    )
  }

  const commit = async (patch: { displayName?: string; description?: string }) => {
    try {
      await platform.tables.update(table.id, patch)
    } catch (e) {
      fail(e)
      setName(table.displayName)
      setDesc(table.description ?? '')
    }
  }
  const rowCount = platform.tables.rows(table.name, { secure: false }).length
  void dataVersion
  const own = isPlatformTable(table, caps.server)
  const linked = caps.server && !own
  const hasOwner = !(table.missingSystem ?? []).includes('owner')
  const assignOwners = async () => {
    setAssigning(true)
    try {
      const n = await assignOwnerToUnownedRows(table.id)
      await platform.tables.reload(table.name).catch(() => {})
      toast(n ? `You are now the owner of ${n} ${n === 1 ? 'row' : 'rows'} that had none` : 'Every row already has an owner', 'success')
    } catch (e) {
      fail(e)
    } finally {
      setAssigning(false)
    }
  }

  return (
    <div data-testid="page-table" className="flex min-h-0 flex-col">
      {back}
      <div className="mb-4 flex items-start gap-3">
        <div className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground"><Table2 className="size-[18px]" /></div>
        <div className="min-w-0 flex-1">
          <input
            value={name}
            readOnly={table.system}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => { const v = name.trim(); if (v && v !== table.displayName) void commit({ displayName: v }); else setName(table.displayName) }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setName(table.displayName); (e.target as HTMLInputElement).blur() } }}
            aria-label="Table name"
            data-testid="table-title"
            className="block h-8 w-full max-w-xl rounded-md border border-transparent bg-transparent px-1.5 text-xl font-semibold tracking-tight outline-none hover:border-border focus:border-ring focus:bg-background"
          />
          <input
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onBlur={() => { if (desc.trim() !== (table.description ?? '')) void commit({ description: desc.trim() }) }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            placeholder="Add a description"
            readOnly={table.system}
            aria-label="Table description"
            className="mt-0.5 block h-7 w-full max-w-xl rounded-md border border-transparent bg-transparent px-1.5 text-sm text-muted-foreground outline-none placeholder:text-muted-foreground/60 hover:border-border focus:border-ring focus:bg-background"
          />
        </div>
        {/* P1 package B: start a flow on this table (server mode, own tables) */}
        {caps.isMaker && !table.system && <Button size="sm" variant="outline" className="mt-1 shrink-0" onClick={() => setAppDlg(true)} data-testid="table-create-app"><Wand2 className="size-4" />Create app</Button>}
        {caps.server && own && !table.system && <Button size="sm" variant="outline" className="mt-1 shrink-0" onClick={() => automate({ table: table.name })} data-testid="table-automate"><Workflow className="size-4" />Automate</Button>}
        <div className="shrink-0 pt-1.5 text-right text-xs text-muted-foreground">
          <div className="flex items-center justify-end gap-1.5">
            {conn && <span className="flex items-center gap-1" data-testid="table-connection">{(() => { const I = connectorInfo(conn.connector).icon; return <I className="size-3.5" /> })()}{conn.name}</span>}
            <ConnectionFlags conn={conn?.isDefault ? undefined : conn} />
            {table.origin?.kind === 'file' && <Badge variant="secondary" title={`From file ${table.origin.fileName}`}>File</Badge>}
            {linked && <Badge variant="secondary" title="This table existed in the database before; Appbuilder never deletes it there"><Link2 /> Linked</Badge>}
            {table.readOnly && <Badge variant="outline"><Lock /> Read-only</Badge>}
            {table.system && <Badge variant="secondary" data-testid="system-table-badge" title="Part of the core data model: in every environment, cannot be deleted or renamed"><Lock /> System table</Badge>}
          </div>
          <div className="font-mono">{table.name}</div>
          <div>Modified {fmtDate(table.modifiedOn)}</div>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-9 self-start">
          <TabsTrigger value="data" className="flex-none px-4" data-testid="tab-data"><Table2 /> Data</TabsTrigger>
          <TabsTrigger value="columns" className="flex-none px-4" data-testid="tab-columns"><Columns3 /> Columns</TabsTrigger>
          <TabsTrigger value="validation" className="flex-none px-4" data-testid="tab-validation"><CheckCheck /> Validation rules</TabsTrigger>
          <TabsTrigger value="formulas" className="flex-none px-4" data-testid="tab-formulas"><Calculator /> Formula columns</TabsTrigger>
          <TabsTrigger value="rollups" className="flex-none px-4" data-testid="tab-rollups"><Sigma /> Rollups</TabsTrigger>
          <TabsTrigger value="events" className="flex-none px-4" data-testid="tab-events"><Zap /> Events</TabsTrigger>
          <TabsTrigger value="security" className="flex-none px-4" data-testid="tab-security"><ShieldCheck /> Security</TabsTrigger>
          <TabsTrigger value="settings" className="flex-none px-4" data-testid="tab-settings"><Settings2 /> Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="data" className="mt-2"><DataGrid table={table} /></TabsContent>
        <TabsContent value="columns" className="mt-2"><ColumnsPanel table={table} /></TabsContent>
        <TabsContent value="validation" className="mt-2"><ValidationRulesPanel table={table} /></TabsContent>
        <TabsContent value="formulas" className="mt-2"><FormulaColumnsPanel table={table} /></TabsContent>
        <TabsContent value="rollups" className="mt-2"><RollupsPanel table={table} /></TabsContent>
        <TabsContent value="events" className="mt-2"><EventsPanel table={table} /></TabsContent>
        <TabsContent value="security" className="mt-2"><TableSecurity table={table} /></TabsContent>
        <TabsContent value="settings" className="mt-2">
          <div className="grid max-w-2xl gap-4" data-testid="settings-tab">
            <Panel className="grid gap-4 p-5">
              <Field label="Primary column" hint="Shown for a row in lookups and titles.">
                <Select value={table.primaryColumn} onValueChange={(v) => { platform.tables.update(table.id, { primaryColumn: v }).then(() => toast('Primary column updated', 'success')).catch(fail) }}>
                  <SelectTrigger className="w-72" size="sm" data-testid="primary-column-select"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {table.columns.filter((c) => !c.system).map((c) => <SelectItem key={c.name} value={c.name}>{c.displayName}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <Field label="Formula name"><Input readOnly value={table.name} className="font-mono text-xs" /></Field>
                <Field label="Connection"><Input readOnly value={conn ? `${conn.name} (${connectorInfo(conn.connector).label})` : table.connectionId ?? 'Browser storage'} /></Field>
                <Field label="Stored as" hint={table.origin?.kind === 'file' ? `File ${table.origin.fileName}${table.origin.sheet ? `, sheet ${table.origin.sheet}` : ''}` : undefined}><Input readOnly value={table.source ?? table.name} className="font-mono text-xs" /></Field>
                <Field label="Table id"><Input readOnly value={table.id} className="font-mono text-xs" /></Field>
                <Field label="Rows"><Input readOnly value={String(rowCount)} /></Field>
                <Field label="Created"><Input readOnly value={fmtDate(table.createdOn)} /></Field>
              </div>
            </Panel>
            <Panel className="grid gap-3 p-5" data-testid="table-security-options">
              <h3 className="text-sm font-semibold">Ownership and sharing</h3>
              <label className="flex items-start justify-between gap-3 text-sm">
                <span><span className="font-medium">Rows can be owned by teams</span><span className="block text-xs text-muted-foreground">A row can be given to a team (its owner becomes the team). Members of the team see it under the Team scope.</span></span>
                <Switch checked={!!table.teamOwnership} disabled={!caps.isMaker || !!table.missingSystem?.includes('owner')} onCheckedChange={(v) => { platform.tables.update(table.id, { teamOwnership: v }).then(() => toast(v ? 'Rows can now be owned by teams' : 'Team ownership is off', 'success')).catch(fail) }} aria-label="Rows can be owned by teams" data-testid="team-ownership-switch" />
              </label>
              <label className="flex items-start justify-between gap-3 text-sm">
                <span><span className="font-medium">Record sharing</span><span className="block text-xs text-muted-foreground">Owners (and roles with the Share privilege) can share single rows with people or teams, for reading or for reading and changing. Recipients still need a role that lets them use this table.</span></span>
                <Switch checked={!!table.sharing} disabled={!caps.isMaker || !!table.missingSystem?.includes('id')} onCheckedChange={(v) => { platform.tables.update(table.id, { sharing: v }).then(() => toast(v ? 'Sharing is on' : 'Sharing is off: existing shares stop applying (they come back if you turn it on again)', 'success')).catch(fail) }} aria-label="Record sharing" data-testid="sharing-switch" />
              </label>
            </Panel>
            <RecycleSettingPanel table={table} />
            {caps.server && caps.isAdmin && hasOwner && !table.readOnly && (
              <Panel className="flex items-center gap-4 p-5" data-testid="assign-owner-panel">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">Assign owner to rows without owner</div>
                  <p className="mt-0.5 text-sm text-muted-foreground">Rows that existed before the table was linked have no owner, so roles limited to their own rows cannot see them. This makes you their owner; reassign rows afterwards if needed.</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => void assignOwners()} disabled={assigning} data-testid="assign-owner-button"><UserCheck /> Assign to me</Button>
              </Panel>
            )}
            {table.system ? (
              <Panel className="p-5 text-sm text-muted-foreground" data-testid="system-table-note">
                <div className="font-semibold text-foreground">System table</div>
                <p className="mt-0.5">Part of the core data model: it exists in every environment and cannot be deleted or renamed, and its own columns cannot be changed.{table.extensible ? ' You can add your own columns; they travel with solutions.' : ''}{table.systemKind === 'projection' ? ' Its rows come from the Admin console and the platform (read-only).' : ''}</p>
              </Panel>
            ) : (
            <Panel className="flex items-center gap-4 border-destructive/30 p-5">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">Delete this table</div>
                <p className="mt-0.5 text-sm text-muted-foreground">{linked
                  ? 'Removes the table from Appbuilder. The table and its rows stay in the database. Apps that use it will stop working.'
                  : 'Removes the table from Appbuilder. Apps that use it will stop working.'} A deleted table does not go to a recycle bin: only a backup brings it back.</p>
              </div>
              <Button variant="destructive" size="sm" onClick={() => { setDropSource(false); setDel(true) }} data-testid="delete-table-button"><Trash2 /> Delete table</Button>
            </Panel>
            )}
          </div>
        </TabsContent>
      </Tabs>

      <AutoAppDialog open={appDlg} onOpenChange={setAppDlg} tables={[table.name]} />
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        title={`Delete table "${table.displayName}"?`}
        description={!caps.server
          ? `This permanently deletes ${rowCount} ${rowCount === 1 ? 'row' : 'rows'} and the schema. This cannot be undone.`
          : (
            <div className="grid gap-3">
              <p>{linked
                ? 'Appbuilder forgets this linked table. The table and its rows stay in the database, untouched.'
                : 'Appbuilder forgets this table. Unless you tick the box, the table and its rows stay in the database.'}</p>
              {!linked && (
                <label className="flex items-start gap-2.5 text-sm text-foreground">
                  <Checkbox checked={dropSource} onCheckedChange={(v) => setDropSource(v === true)} className="mt-0.5" data-testid="delete-table-drop-source" />
                  <span>Also delete the table in the database<span className="block text-xs text-muted-foreground">Permanently deletes {rowCount} {rowCount === 1 ? 'row' : 'rows'}. This cannot be undone.</span></span>
                </label>
              )}
            </div>
          )}
        onConfirm={async () => {
          await platform.tables.remove(table.id, { dropSource: caps.server ? (!linked && dropSource) : true })
          toast(`Deleted table "${table.displayName}"`, 'success')
          go({ page: 'tables' })
        }}
      />
    </div>
  )
}
