/**
 * Admin console: Flows (P1-E). The environment's kill switch ("Pause all flows") with its status, the environment's run
 * rate limit, and every flow with its state (on, off, suspended), health over 7 days and a switch to turn it off or on
 * (administrators may do that even in a locked production environment). The same API as the Flows page
 * (GET /flows, PUT /flows/settings, POST /flows/:id/enable|disable); docs/admin/flows.md.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Pause, Play, RefreshCw, Workflow } from 'lucide-react'
import { usePlatform } from '@/platform'
import type { FlowListItem } from '@/platform/flows'
import { go } from '@/router'
import { flowsApi, type EnvFlowSettings } from '@/flows/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog, Empty, Field, Panel, errMsg, fmtDate, fmtRelative, useToast } from './kit'
import { useCaps } from './security'

type Title = (title: string, subtitle?: ReactNode, actions?: ReactNode) => ReactNode

export function FlowsAdminSection({ title }: { title: Title }) {
  const caps = useCaps()
  const env = usePlatform((s) => s.environments.find((e) => e.id === s.environmentId)?.name)
  const { toast, fail } = useToast()
  const [items, setItems] = useState<FlowListItem[] | null>(null)
  const [settings, setSettings] = useState<EnvFlowSettings | null>(null)
  const [rate, setRate] = useState('')
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    if (!caps.server) return
    flowsApi.list().then((r) => { setItems(r.items); setSettings(r.settings); setRate(String(r.settings.environmentRunsPerMinute)); setError('') }).catch((e) => setError(errMsg(e)))
  }, [caps.server])
  useEffect(() => {
    load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [load])
  if (!caps.server) return <Empty icon={Workflow} title="Needs the server" description="Flows run on the Appbuilder server; the browser-only demo has none." />
  const failing = (items ?? []).filter((f) => f.health.failed7d > 0)
  const setPaused = async (paused: boolean) => {
    try {
      const s = await flowsApi.setPaused(paused)
      setSettings(s)
      toast(paused ? 'All flows of this environment are paused.' : 'Flows run again.', 'success')
    } catch (e) { fail(e) }
  }
  return (
    <div data-testid="admin-flows">
      {title('Flows', <>Automations of {env ? <b>{env}</b> : 'this environment'}: the kill switch, the run rate limit and the state of every flow. Makers build and edit flows on the Flows page.</>,
        <Button variant="outline" size="sm" onClick={load}><RefreshCw /> Refresh</Button>)}
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      {settings && (
        <Panel className={`mb-4 p-4 ${settings.paused ? 'border-destructive' : ''}`} data-testid="admin-kill-switch">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                Kill switch: {settings.paused ? <Badge variant="destructive" data-testid="kill-switch-state">paused</Badge> : <Badge variant="secondary" data-testid="kill-switch-state">running</Badge>}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {settings.paused
                  ? <>No flow of this environment starts a step{settings.pausedOn ? <> since {fmtDate(settings.pausedOn)}</> : null}. Triggers still record their runs; they continue when flows are resumed. Use it when a flow misbehaves and you do not know which one yet.</>
                  : <>Pausing stops every flow of this environment between steps (runs are kept and continue when resumed). To stop one flow, turn it off in the list below.</>}
              </p>
            </div>
            {caps.isAdmin && (settings.paused
              ? <Button size="sm" data-testid="admin-resume-flows" onClick={() => setPaused(false)}><Play className="size-4" />Resume all flows</Button>
              : <Button size="sm" variant="destructive" data-testid="admin-pause-flows" onClick={() => setAsking(true)}><Pause className="size-4" />Pause all flows</Button>)}
          </div>
          {caps.isAdmin && (
            <div className="mt-3 flex items-end gap-2">
              <Field label="Runs started per minute in this environment (at most)" hint="Above it, runs start a minute later; nothing is dropped.">
                <Input className="w-32" inputMode="numeric" value={rate} onChange={(e) => setRate(e.target.value)} data-testid="admin-flows-rate" />
              </Field>
              <Button size="sm" variant="outline" disabled={rate === String(settings.environmentRunsPerMinute)} onClick={async () => {
                try {
                  const s = await flowsApi.setRunRate(Number(rate))
                  setSettings(s)
                  setRate(String(s.environmentRunsPerMinute))
                  toast('Saved.', 'success')
                } catch (e) { fail(e) }
              }}>Save</Button>
            </div>
          )}
        </Panel>
      )}
      {failing.length > 0 && <p className="mb-2 text-sm text-destructive" data-testid="admin-flows-failing">{failing.length} flow{failing.length === 1 ? '' : 's'} failed in the last 7 days. Failing flows are never switched off by themselves: their owners and you get a notification and a daily digest.</p>}
      {items && !items.length && <Empty icon={Workflow} title="No flows yet" description="Makers create flows on the Flows page." />}
      {items && items.length > 0 && (
        <Panel className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="admin-flows-table">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Flow</th><th className="p-2">Owner</th><th className="p-2">State</th><th className="p-2">Last run</th><th className="p-2">7 days</th><th className="p-2">On</th></tr>
            </thead>
            <tbody>
              {items.map((f) => (
                <tr key={f.id} className="border-b border-border last:border-0" data-testid={`admin-flow-${f.name}`}>
                  <td className="p-2"><button type="button" className="font-medium text-primary hover:underline" onClick={() => go({ page: 'flow', id: f.id })}>{f.name}</button><div className="text-xs text-muted-foreground">{f.trigger?.type ?? ''}{typeof f.runAs === 'object' ? ' · runs as a service account' : ''}</div></td>
                  <td className="p-2 text-xs">{f.ownerName ?? f.ownerId}</td>
                  <td className="p-2">{f.suspended ? <Badge variant="destructive" title={f.suspended}>suspended</Badge> : settings?.paused && f.enabled ? <Badge variant="outline">paused (kill switch)</Badge> : f.enabled ? <Badge>on</Badge> : <Badge variant="outline">off</Badge>}{f.suspended && <div className="mt-0.5 max-w-xs text-xs text-muted-foreground">{f.suspended}</div>}</td>
                  <td className="p-2 text-xs">{f.health.lastRunOn ? <>{fmtRelative(f.health.lastRunOn)} · {f.health.lastStatus}</> : '-'}</td>
                  <td className="p-2 text-xs">{f.health.runs7d} runs{f.health.failed7d ? <span className="text-destructive"> · {f.health.failed7d} failed</span> : ''}{f.health.successRate !== null ? ` · ${Math.round(f.health.successRate * 100)}% ok` : ''}</td>
                  <td className="p-2">{caps.isAdmin && <Switch aria-label={`Turn ${f.name} ${f.enabled ? 'off' : 'on'}`} data-testid={`admin-flow-toggle-${f.name}`} checked={f.enabled} onCheckedChange={(on) => flowsApi.enable(f.id, on).then(() => { toast(on ? `${f.name} is on.` : `${f.name} is off: no new runs start; runs already going finish.`, 'success'); load() }).catch((e) => toast(errMsg(e), 'error'))} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
      <ConfirmDialog open={asking} onOpenChange={setAsking} title="Pause all flows?" confirmLabel="Pause all flows"
        description={<>Every flow of {env ? <b>{env}</b> : 'this environment'} stops between steps until you resume them. Triggers keep recording runs; nothing is lost. Approvals already sent can still be answered; their flows continue after the resume.</>}
        onConfirm={() => setPaused(true)} />
    </div>
  )
}
