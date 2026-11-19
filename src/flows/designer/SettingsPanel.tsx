/**
 * Flow settings: name and description, who the flow acts as (run as; a service account only for administrators, with
 * a confirmation), concurrency, time limit, retention, errors; variables; the connection references (attach, change,
 * detach; "use" access is checked by the server when the draft is saved); who may run it by hand.
 */
import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/platform'
import { useCaps } from '@/portal/security'
import { errMsg } from '@/portal/kit'
import { FLOW_LIMITS, type RunAs, type VariableDef } from '@/platform/flows'
import { flowsApi } from '../api'
import { useDesigner } from './store'
import { useDesignerData } from './context'
import { renameVariable, walk } from './model'
import { Labeled, Section, inputCls } from './fields'
import { FieldError } from './FxField'
import { refFor } from './StepPicker'

const editDoc = (fn: (d: ReturnType<typeof useDesigner.getState>['doc']) => ReturnType<typeof useDesigner.getState>['doc'], key?: string) =>
  useDesigner.getState().edit((x) => ({ ...x, doc: fn(x.doc) }), key)

export function SettingsPanel({ tab: initial }: { tab?: string }) {
  const [tab, setTab] = useState(initial ?? 'general')
  useEffect(() => { if (initial) setTab(initial) }, [initial])
  const tabs = [['general', 'General'], ['variables', 'Variables'], ['connections', 'Connections'], ['permissions', 'Run permissions']] as const
  return (
    <div className="flex h-full flex-col" data-testid="settings-panel">
      <header className="border-b border-border px-4 py-3"><div className="text-sm font-semibold">Flow settings</div></header>
      <div className="flex border-b border-border px-3 text-xs" role="tablist">
        {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={cn('-mb-px border-b-2 px-2 py-1.5', tab === k ? 'border-primary font-medium' : 'border-transparent text-muted-foreground')} onClick={() => setTab(k)} data-testid={`settings-tab-${k}`}>{l}</button>)}
      </div>
      <div className="min-h-0 flex-1 overflow-auto" data-no-canvas-wheel>
        {tab === 'general' && <General />}
        {tab === 'variables' && <Variables />}
        {tab === 'connections' && <Connections />}
        {tab === 'permissions' && <RunPermissions />}
      </div>
    </div>
  )
}

function General() {
  const doc = useDesigner((s) => s.doc)
  const ro = useDesigner((s) => s.readOnly)
  const caps = useCaps()
  const users = usePlatform((s) => s.users)
  const services = users.filter((u) => u.kind === 'service' && u.status !== 'disabled')
  const st = doc.settings
  const runAs = doc.runAs
  const kind = typeof runAs === 'object' ? 'service' : runAs
  const setRunAs = (r: RunAs) => {
    const what = typeof r === 'object' ? `the service account ${users.find((u) => u.id === r.serviceAccount)?.name ?? ''}` : r === 'triggeringUser' ? 'the person who starts each run (their rights)' : 'you, the owner (your rights, also when others start it)'
    if (!confirm(`Runs will read and write data as ${what}. Publishing asks once more. Change it?`)) return
    editDoc((d) => ({ ...d, runAs: r }))
  }
  const setSetting = (patch: Record<string, unknown>, key?: string) => editDoc((d) => {
    const s = { ...d.settings } as Record<string, unknown>
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete s[k]; else s[k] = v }
    return { ...d, settings: s as unknown as typeof d.settings }
  }, key)
  return (
    <>
      <Section title="Flow">
        <Labeled label="Name" required><input className={inputCls} value={doc.name} readOnly={ro} data-testid="flow-name" onKeyDown={(e) => e.stopPropagation()} onChange={(e) => editDoc((d) => ({ ...d, name: e.target.value }), 'name')} /><FieldError stepId="" field="name" /></Labeled>
        <Labeled label="Description"><textarea className="min-h-14 rounded-md border border-input bg-background p-2 text-sm" value={doc.description ?? ''} readOnly={ro} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => editDoc((d) => { const n = { ...d }; if (e.target.value) n.description = e.target.value; else delete n.description; return n }, 'description')} /></Labeled>
      </Section>
      <Section title="Run as" hint="Whose rights the steps use when they read and write data.">
        <div className="grid gap-1 text-xs">
          <label className="flex items-start gap-2"><input type="radio" disabled={ro} checked={kind === 'owner'} onChange={() => setRunAs('owner')} data-testid="runas-owner" /><span><b>The owner</b> (default): the owner's rights, also when someone else starts it.</span></label>
          <label className="flex items-start gap-2"><input type="radio" disabled={ro} checked={kind === 'triggeringUser'} onChange={() => setRunAs('triggeringUser')} data-testid="runas-trigger" /><span><b>The person who starts it</b>: they can only do what they could do by hand. Not for schedules and web requests.</span></label>
          <label className={cn('flex items-start gap-2', !caps.isAdmin && 'opacity-60')}><input type="radio" disabled={ro || !caps.isAdmin || !services.length} checked={kind === 'service'} onChange={() => services[0] && setRunAs({ serviceAccount: services[0].id })} data-testid="runas-service" /><span><b>A service account</b>: {caps.isAdmin ? (services.length ? 'chosen below; audited.' : 'there is no active service account (Admin > Users).') : 'only administrators can choose this.'}</span></label>
          {kind === 'service' && caps.isAdmin && (
            <select className={inputCls} disabled={ro} value={(runAs as { serviceAccount: string }).serviceAccount} onChange={(e) => setRunAs({ serviceAccount: e.target.value })}>{services.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
          )}
        </div>
        <FieldError stepId="" field="runAs" />
      </Section>
      <Section title="Runs">
        <Labeled label="At the same time">
          <select className={inputCls} disabled={ro} value={st.concurrency} onChange={(e) => setSetting({ concurrency: e.target.value })} data-testid="settings-concurrency">
            <option value="parallel">Any number of runs at once</option><option value="singleton">One run at a time (others wait their turn)</option><option value="perRecord">One run per record at a time, in the order of the changes</option>
          </select>
          <FieldError stepId="" field="settings.concurrency" />
        </Labeled>
        <Labeled label="Time limit of a run (minutes)" hint={`At most ${FLOW_LIMITS.runTimeoutMinutesMax} (30 days).`}><input type="number" min={1} max={FLOW_LIMITS.runTimeoutMinutesMax} className={inputCls} value={st.timeoutMinutes} readOnly={ro} onChange={(e) => setSetting({ timeoutMinutes: Number(e.target.value) || 1 }, 'timeout')} /><FieldError stepId="" field="settings.timeoutMinutes" /></Labeled>
        <Labeled label="Keep run history (days)"><input type="number" min={1} className={inputCls} value={st.retentionDays} readOnly={ro} onChange={(e) => setSetting({ retentionDays: Number(e.target.value) || 1 }, 'retention')} /></Labeled>
        <Labeled label="When a step fails">
          <select className={inputCls} disabled={ro} value={st.onError} onChange={(e) => setSetting({ onError: e.target.value })}><option value="fail">Stop (later steps run only when set to run after the failure)</option><option value="continue">Carry on with later steps (the run still shows as failed)</option></select>
        </Labeled>
        <Labeled label="At most runs per minute" hint="More wait for the next minute; nothing is dropped."><input type="number" min={1} max={FLOW_LIMITS.runsPerMinute} className={inputCls} value={st.maxRunsPerMinute ?? ''} placeholder={String(FLOW_LIMITS.runsPerMinute)} readOnly={ro} onChange={(e) => setSetting({ maxRunsPerMinute: e.target.value ? Number(e.target.value) : undefined }, 'rpm')} /></Labeled>
      </Section>
    </>
  )
}

const VAR_TYPES: VariableDef['type'][] = ['text', 'number', 'boolean', 'date', 'record', 'table', 'any']

function Variables() {
  const doc = useDesigner((s) => s.doc)
  const ro = useDesigner((s) => s.readOnly)
  const vars = doc.variables ?? []
  const used = useMemo(() => {
    const out = new Set<string>()
    walk(doc.steps, (s) => { if (s.kind === 'setVariable') out.add(String((s as { variable?: string }).variable)) })
    return out
  }, [doc.steps])
  const put = (v: VariableDef[], key?: string) => editDoc((d) => ({ ...d, variables: v }), key)
  return (
    <Section title="Variables" hint="Values the run keeps and changes (Set variable); formulas read them as Variables.<name>.">
      {vars.map((v, i) => (
        <div key={i} className="grid gap-1 rounded-md border border-border p-2" data-testid={`var-${v.name}`}>
          <div className="flex gap-1">
            <input className={inputCls} value={v.name} readOnly={ro} aria-label="Variable name" onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => { const n = e.target.value.replace(/[^A-Za-z0-9_]/g, ''); if (n && n !== v.name) useDesigner.getState().edit((x) => ({ ...x, doc: renameVariable(x.doc, v.name, n) })) }} defaultValue={v.name} key={v.name} />
            <select className="h-8 rounded-md border border-input bg-background px-1 text-xs" value={v.type} disabled={ro} onChange={(e) => put(vars.map((x, j) => (j === i ? { ...x, type: e.target.value as VariableDef['type'] } : x)))}>{VAR_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
            {!ro && <button type="button" className="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-40" disabled={used.has(v.name)} title={used.has(v.name) ? 'A Set variable step uses it' : 'Remove'} aria-label="Remove variable" onClick={() => put(vars.filter((_, j) => j !== i))}><Trash2 className="size-4" /></button>}
          </div>
          <input className="h-7 rounded border border-input bg-background px-2 text-xs" value={v.initial === undefined ? '' : JSON.stringify(v.initial)} readOnly={ro} placeholder="Initial value (JSON: 0, &quot;text&quot;, true)" onKeyDown={(e) => e.stopPropagation()} onChange={(e) => { let init: unknown; try { init = e.target.value ? JSON.parse(e.target.value) : undefined } catch { return } put(vars.map((x, j) => { if (j !== i) return x; const n = { ...x }; if (init === undefined) delete n.initial; else n.initial = init; return n }), `var${i}`) }} />
          <FieldError stepId="" field={`variables[${i}]`} />
        </div>
      ))}
      {!ro && <Button size="sm" variant="outline" className="w-fit" data-testid="add-variable" onClick={() => { let n = 'Var1'; for (let i = 1; vars.some((x) => x.name === n); i++) n = `Var${i}`; put([...vars, { name: n, type: 'number', initial: 0 }]) }}><Plus className="size-4" />Add a variable</Button>}
    </Section>
  )
}

function Connections() {
  const connections = useDesigner((s) => s.connections)
  const doc = useDesigner((s) => s.doc)
  const ro = useDesigner((s) => s.readOnly)
  const all = usePlatform((s) => s.connections)
  const data = useDesignerData()
  const usable = new Map((data.usable ?? []).map((c) => [c.id, c]))
  const [adding, setAdding] = useState('')
  const usedRefs = useMemo(() => {
    const out = new Map<string, string[]>()
    walk(doc.steps, (s) => {
      const a = s as unknown as Record<string, unknown>
      for (const k of ['connection', 'auth']) if (typeof a[k] === 'string' && a[k]) out.set(a[k] as string, [...(out.get(a[k] as string) ?? []), s.name])
    })
    return out
  }, [doc.steps])
  const setConns = (c: Record<string, string>) => useDesigner.getState().edit((x) => ({ ...x, connections: c }))
  return (
    <Section title="Connections this flow uses" hint={'Steps name a connection by a short reference. Attaching one needs "use" access to it; in another environment the import asks which connection replaces it.'}>
      {Object.entries(connections).map(([ref, id]) => {
        const c = all.find((x) => x.id === id)
        return (
          <div key={ref} className="grid gap-1 rounded-md border border-border p-2 text-xs" data-testid={`conn-ref-${ref}`}>
            <div className="flex items-center gap-2"><code className="font-mono font-medium">{ref}</code><span className="text-muted-foreground">→</span><span>{c?.name ?? id}</span><span className="text-muted-foreground">{c?.connector}</span>
              {!ro && <button type="button" className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-40" disabled={usedRefs.has(ref)} title={usedRefs.has(ref) ? `Used by ${usedRefs.get(ref)!.join(', ')}` : 'Detach'} aria-label={`Detach ${ref}`} onClick={() => { const n = { ...connections }; delete n[ref]; setConns(n) }}><Trash2 className="size-3.5" /></button>}
            </div>
            <div className="text-muted-foreground">{usedRefs.has(ref) ? `Used by ${usedRefs.get(ref)!.join(', ')}` : 'Not used by any step'}{c && !usable.has(c.id) ? ' · you do not have "use" access (an administrator attached it)' : ''}</div>
          </div>
        )
      })}
      {!Object.keys(connections).length && <p className="text-xs text-muted-foreground">None yet. Connector steps attach their connection when you pick it.</p>}
      {!ro && (
        <div className="flex gap-1">
          <select className={inputCls} value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Connection to attach" data-testid="attach-connection">
            <option value="">Attach a connection…</option>
            {all.filter((c) => !Object.values(connections).includes(c.id) && (c.connector === 'http' || c.connector === 'email')).map((c) => <option key={c.id} value={c.id} disabled={!usable.has(c.id)}>{c.name} ({c.connector}){!usable.has(c.id) ? ' - needs "use" access' : ''}</option>)}
          </select>
          <Button size="sm" variant="outline" disabled={!adding} onClick={() => { const c = all.find((x) => x.id === adding)!; setConns({ ...connections, [refFor(connections, c.id, c.name)]: c.id }); setAdding('') }}><Plus className="size-4" />Attach</Button>
        </div>
      )}
      <FieldError stepId="" field="connections" />
    </Section>
  )
}

function RunPermissions() {
  const flowId = useDesigner((s) => s.flowId)
  const doc = useDesigner((s) => s.doc)
  const ro = useDesigner((s) => s.readOnly)
  const roles = usePlatform((s) => s.roles)
  const [ids, setIds] = useState<string[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { if (flowId) flowsApi.permissions(flowId).then((r) => setIds(r.roleIds)).catch((e) => setErr(errMsg(e))) }, [flowId])
  const sorted = useMemo(() => [...roles].sort((a, b) => a.name.localeCompare(b.name)), [roles])
  if (!flowId) return <Section title="Run permissions"><p className="text-xs text-muted-foreground">Save the flow first.</p></Section>
  return (
    <Section title="Who may run it by hand" hint={doc.trigger?.type === 'manual' ? 'Besides its owner and administrators: people with these roles (Run now, RunFlow in apps). Changes apply at once.' : 'Only flows started by a person or an app (manual trigger) are run by hand; this list applies once the trigger is manual.'}>
      {err && <p className="text-xs text-destructive">{err}</p>}
      {ids && sorted.map((r) => (
        <label key={r.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" disabled={ro} checked={ids.includes(r.id)} data-testid={`perm-${r.name}`} onChange={(e) => {
            const next = e.target.checked ? [...ids, r.id] : ids.filter((x) => x !== r.id)
            flowsApi.setPermissions(flowId, next).then((x) => { setIds(x.roleIds); setErr(null) }).catch((er) => setErr(errMsg(er)))
          }} />{r.name}
        </label>
      ))}
      <p className="text-[11px] text-muted-foreground">{doc.runAs === 'owner' ? 'The flow runs with the owner\'s rights: whoever may run it acts with them.' : doc.runAs === 'triggeringUser' ? 'The flow runs with the rights of the person who starts it.' : 'The flow runs as a service account.'}</p>
    </Section>
  )
}
