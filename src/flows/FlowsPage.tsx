/**
 * Dev mode > Flows (P1 package A): the list with status and health, the kill switch, and per flow its definition, runs,
 * versions and run permissions. The definition is edited as JSON here (FlowJsonEditor); package B replaces that one
 * component with the visual designer and keeps the rest (RunViews, the list, versions, permissions).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pause, Play, Plus, Power, PowerOff, Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { go } from '@/router'
import { usePlatform } from '@/platform'
import type { FlowDef, FlowListItem, FlowVersionInfo, InputDef } from '@/platform/flows'
import { Empty, PageHeader, Panel, errMsg, fmtDate, fmtRelative, useToast } from '@/portal/kit'
import { useCaps } from '@/portal/security'
import { FLOW_TEMPLATE, editable, flowsApi, type EnvFlowSettings } from './api'
import { FlowJsonEditor } from './FlowJsonEditor'
import { RunDetail, RunHistory, StatusBadge } from './RunViews'

function DemoNotice() {
  return (
    <Empty icon={Workflow} title="Flows run on the server" description="Flows react to data changes, schedules, buttons in apps and web requests, and they keep running when nobody has the app open. That needs the Appbuilder server: in demo mode (everything in this browser) there are no flows. Install the server to use them." />
  )
}

const pct = (x: number | null) => (x === null ? '-' : `${Math.round(x * 100)} %`)

export function FlowsPage({ flowId }: { flowId?: string }) {
  const caps = useCaps()
  if (!caps.server) return <><PageHeader icon={Workflow} title="Flows" subtitle="Automate work when data changes, on a schedule or at a button press." /><DemoNotice /></>
  return flowId ? <FlowDetail flowId={flowId} /> : <FlowList />
}

function FlowList() {
  const caps = useCaps()
  const { toast } = useToast()
  const [items, setItems] = useState<FlowListItem[] | null>(null)
  const [settings, setSettings] = useState<EnvFlowSettings | null>(null)
  const [creating, setCreating] = useState(false)
  const load = useCallback(() => {
    flowsApi.list().then((r) => { setItems(r.items); setSettings(r.settings) }).catch((e) => toast(errMsg(e), 'error'))
  }, [toast])
  useEffect(load, [load])
  const [openRun, setOpenRun] = useState<string | null>(null)
  return (
    <div data-testid="flows-page">
      <PageHeader icon={Workflow} title="Flows" subtitle="Automate work when data changes, on a schedule, at a button press or a web request. Every run is recorded."
        actions={<>
          {caps.isAdmin && settings && (
            <Button variant={settings.paused ? 'destructive' : 'outline'} size="sm" data-testid="kill-switch" onClick={() => flowsApi.setPaused(!settings.paused).then((s) => { setSettings(s); toast(s.paused ? 'All flows are paused.' : 'Flows run again.', 'success') }).catch((e) => toast(errMsg(e), 'error'))}>
              {settings.paused ? <><Play className="size-4" />Resume all flows</> : <><Pause className="size-4" />Pause all flows</>}
            </Button>
          )}
          <Button size="sm" data-testid="new-flow" onClick={() => setCreating(true)}><Plus className="size-4" />New flow</Button>
        </>} />
      {settings?.paused && <Panel className="mb-3 border-destructive p-3 text-sm text-destructive">All flows of this environment are paused (kill switch{settings.pausedOn ? `, since ${fmtDate(settings.pausedOn)}` : ''}). Triggers still record their runs; they start when flows are resumed.</Panel>}
      {creating && (
        <Panel className="mb-4 p-3">
          <h2 className="mb-2 text-sm font-semibold">New flow</h2>
          <FlowJsonEditor initial={FLOW_TEMPLATE} onSaved={(f) => { setCreating(false); go({ page: 'flow', id: f.id }) }} onCancel={() => setCreating(false)} />
        </Panel>
      )}
      {items === null ? <p className="text-sm text-muted-foreground">Loading flows...</p> : !items.length ? (
        <Empty icon={Workflow} title="No flows yet" description="Create one to start a run when a row changes, on a schedule, or from a button in an app." action={<Button onClick={() => setCreating(true)}><Plus className="size-4" />New flow</Button>} />
      ) : (
        <Panel className="mb-4 overflow-x-auto">
          <table className="w-full text-sm" data-testid="flow-list">
            <thead className="text-left text-xs text-muted-foreground"><tr><th className="p-2">Name</th><th className="p-2">Trigger</th><th className="p-2">State</th><th className="p-2">Success (7 days)</th><th className="p-2">Last run</th><th className="p-2">Average</th><th className="p-2">Owner</th><th /></tr></thead>
            <tbody>
              {items.map((f) => (
                <tr key={f.id} className="border-t border-border" data-testid="flow-row">
                  <td className="p-2"><button type="button" className="font-medium text-primary hover:underline" onClick={() => go({ page: 'flow', id: f.id })}>{f.name}</button>{f.description && <div className="text-xs text-muted-foreground">{f.description}</div>}</td>
                  <td className="p-2">{f.trigger?.type}{f.trigger?.type === 'table' ? `: ${f.trigger.table}` : ''}</td>
                  <td className="p-2">{f.suspended ? <Badge variant="destructive" title={f.suspended}>suspended</Badge> : f.enabled ? <Badge>on</Badge> : <Badge variant="outline">off</Badge>}</td>
                  <td className="p-2">{pct(f.health.successRate)} <span className="text-xs text-muted-foreground">({f.health.runs7d} runs)</span></td>
                  <td className="p-2">{f.health.lastStatus ? <><StatusBadge status={f.health.lastStatus} /> <span className="text-xs text-muted-foreground">{fmtRelative(f.health.lastRunOn)}</span></> : '-'}</td>
                  <td className="p-2">{f.health.avgDurationMs === null ? '-' : `${(f.health.avgDurationMs / 1000).toFixed(1)} s`}</td>
                  <td className="p-2">{f.ownerName ?? ''}</td>
                  <td className="p-2 text-right">
                    {f.canEdit && <Switch aria-label={`Turn ${f.name} ${f.enabled ? 'off' : 'on'}`} checked={f.enabled} onCheckedChange={(on) => flowsApi.enable(f.id, on).then(load).catch((e) => toast(errMsg(e), 'error'))} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
      <h2 className="mb-2 text-sm font-semibold">Recent runs</h2>
      {openRun ? <><Button size="sm" variant="ghost" className="mb-2" onClick={() => setOpenRun(null)}>Back to the runs</Button><RunDetail runId={openRun} onOpen={setOpenRun} canManage /></> : <RunHistory onOpen={setOpenRun} />}
    </div>
  )
}

function RunNow({ flow, onStarted }: { flow: FlowDef; onStarted(runId: string): void }) {
  const inputs = flow.trigger?.type === 'manual' ? flow.trigger.inputs : []
  const [values, setValues] = useState<Record<string, string>>({})
  const { toast } = useToast()
  const conv = (d: InputDef, v: string): unknown => (d.type === 'number' ? Number(v) : d.type === 'boolean' ? v === 'true' : d.type === 'record' || d.type === 'table' ? JSON.parse(v || 'null') : v)
  return (
    <div className="flex flex-wrap items-end gap-2" data-testid="run-now">
      {inputs.map((d) => (
        <label key={d.name} className="grid gap-1 text-xs">{d.name}{d.required ? ' *' : ''}
          {d.type === 'choice' ? (
            <select className="h-8 rounded-md border border-border bg-background px-2 text-sm" value={values[d.name] ?? ''} onChange={(e) => setValues({ ...values, [d.name]: e.target.value })}><option value="" />{(d.choices ?? []).map((c) => <option key={c}>{c}</option>)}</select>
          ) : <input className="h-8 rounded-md border border-border bg-background px-2 text-sm" type={d.type === 'number' ? 'number' : d.type === 'date' ? 'date' : d.type === 'datetime' ? 'datetime-local' : 'text'} value={values[d.name] ?? ''} onChange={(e) => setValues({ ...values, [d.name]: e.target.value })} />}
        </label>
      ))}
      <Button size="sm" onClick={() => {
        let body: Record<string, unknown>
        try { body = Object.fromEntries(inputs.filter((d) => values[d.name] !== undefined && values[d.name] !== '').map((d) => [d.name, conv(d, values[d.name])])) } catch { toast('A record or table input must be JSON.', 'error'); return }
        flowsApi.run(flow.id, body).then((r) => onStarted(r.runId)).catch((e) => toast(errMsg(e), 'error'))
      }}><Play className="size-4" />Run now</Button>
    </div>
  )
}

function FlowDetail({ flowId }: { flowId: string }) {
  const { toast } = useToast()
  const [data, setData] = useState<{ flow: FlowDef; canEdit: boolean; canRun: boolean } | null>(null)
  const [tab, setTab] = useState('definition')
  const [openRun, setOpenRun] = useState<string | null>(null)
  const load = useCallback(() => { flowsApi.get(flowId).then(setData).catch((e) => toast(errMsg(e), 'error')) }, [flowId, toast])
  useEffect(load, [load])
  if (!data) return <p className="text-sm text-muted-foreground">Loading the flow...</p>
  const f = data.flow
  const open = (id: string) => { setOpenRun(id); setTab('runs') }
  return (
    <div data-testid="flow-detail">
      <PageHeader icon={Workflow} title={f.name} subtitle={<>{f.description ?? ''} {f.suspended && <span className="text-destructive">Suspended: {f.suspended}</span>}</>}
        back={<Button variant="link" size="sm" className="mb-1 px-0" onClick={() => go({ page: 'flows' })}>All flows</Button>}
        actions={<>
          <Badge variant={f.enabled ? 'default' : 'outline'}>{f.enabled ? 'on' : 'off'}</Badge>
          <span className="text-xs text-muted-foreground">version {f.version}</span>
          {data.canEdit && (f.enabled
            ? <Button size="sm" variant="outline" onClick={() => flowsApi.enable(f.id, false).then(load).catch((e) => toast(errMsg(e), 'error'))}><PowerOff className="size-4" />Turn off</Button>
            : <Button size="sm" onClick={() => flowsApi.enable(f.id, true).then(load).catch((e) => toast(errMsg(e), 'error'))}><Power className="size-4" />Turn on</Button>)}
        </>} />
      {data.canRun && f.enabled && <Panel className="mb-3 p-3"><RunNow flow={f} onStarted={open} /></Panel>}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="definition">Definition</TabsTrigger>
          <TabsTrigger value="runs" data-testid="tab-runs">Runs</TabsTrigger>
          <TabsTrigger value="versions">Versions</TabsTrigger>
          <TabsTrigger value="permissions">Who may run it</TabsTrigger>
        </TabsList>
        <TabsContent value="definition">
          <FlowJsonEditor key={f.version} flowId={f.id} readOnly={!data.canEdit} initial={editable(f)} onSaved={() => load()} onTested={open} />
        </TabsContent>
        <TabsContent value="runs">
          {openRun ? <><Button size="sm" variant="ghost" className="mb-2" onClick={() => setOpenRun(null)}>Back to the runs</Button><RunDetail runId={openRun} onOpen={setOpenRun} canManage={data.canEdit} /></> : <RunHistory flowId={f.id} onOpen={setOpenRun} />}
        </TabsContent>
        <TabsContent value="versions"><Versions flow={f} canEdit={data.canEdit} onRestored={load} /></TabsContent>
        <TabsContent value="permissions"><Permissions flow={f} canEdit={data.canEdit} /></TabsContent>
      </Tabs>
    </div>
  )
}

function Versions({ flow, canEdit, onRestored }: { flow: FlowDef; canEdit: boolean; onRestored(): void }) {
  const [items, setItems] = useState<FlowVersionInfo[]>([])
  const [shown, setShown] = useState<{ version: number; doc: unknown } | null>(null)
  const { toast } = useToast()
  useEffect(() => { flowsApi.versions(flow.id).then((r) => setItems(r.items)).catch((e) => toast(errMsg(e), 'error')) }, [flow.id, flow.version, toast])
  return (
    <Panel className="p-3">
      <table className="w-full text-sm">
        <tbody>
          {items.map((v) => (
            <tr key={v.version} className="border-t border-border">
              <td className="p-2 font-medium">Version {v.version}{v.version === flow.version ? ' (current)' : ''}</td>
              <td className="p-2">{fmtDate(v.savedOn)}</td><td className="p-2">{v.savedByName ?? ''}</td><td className="p-2 text-muted-foreground">{v.note ?? ''}</td>
              <td className="p-2 text-right">
                <Button size="sm" variant="ghost" onClick={() => flowsApi.version(flow.id, v.version).then(setShown).catch((e) => toast(errMsg(e), 'error'))}>Show</Button>
                {canEdit && v.version !== flow.version && <Button size="sm" variant="outline" onClick={() => flowsApi.restore(flow.id, v.version).catch((e) => (e.status === 409 && confirm(`${errMsg(e)}\n\nRestore anyway?`) ? flowsApi.restore(flow.id, v.version, true) : Promise.reject(e))).then(() => { toast(`Version ${v.version} restored as a new version.`, 'success'); onRestored() }).catch((e) => toast(errMsg(e), 'error'))}>Restore</Button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown && <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-muted p-2 text-xs">{JSON.stringify(shown.doc, null, 2)}</pre>}
    </Panel>
  )
}

function Permissions({ flow, canEdit }: { flow: FlowDef; canEdit: boolean }) {
  const roles = usePlatform((s) => s.roles)
  const [ids, setIds] = useState<string[] | null>(null)
  const { toast } = useToast()
  useEffect(() => { flowsApi.permissions(flow.id).then((r) => setIds(r.roleIds)).catch((e) => toast(errMsg(e), 'error')) }, [flow.id, toast])
  const sorted = useMemo(() => [...roles].sort((a, b) => a.name.localeCompare(b.name)), [roles])
  if (ids === null) return null
  return (
    <Panel className="p-3 text-sm">
      <p className="mb-2 text-muted-foreground">{flow.trigger?.type === 'manual' ? 'Besides its owner and administrators, people with these roles may run this flow (Run now, RunFlow in apps).' : 'Only flows started by a person or an app (manual trigger) are run by hand; this list applies once the trigger is manual.'} {flow.runAs === 'owner' ? 'The flow runs with its owner\'s rights.' : flow.runAs === 'triggeringUser' ? 'The flow runs with the rights of the person who starts it.' : 'The flow runs as a service account.'}</p>
      {sorted.map((r) => (
        <label key={r.id} className="flex items-center gap-2 py-1">
          <input type="checkbox" disabled={!canEdit} checked={ids.includes(r.id)} onChange={(e) => {
            const next = e.target.checked ? [...ids, r.id] : ids.filter((x) => x !== r.id)
            flowsApi.setPermissions(flow.id, next).then((x) => setIds(x.roleIds)).catch((er) => toast(errMsg(er), 'error'))
          }} />{r.name}
        </label>
      ))}
    </Panel>
  )
}
