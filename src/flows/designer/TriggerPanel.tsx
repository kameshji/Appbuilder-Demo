/**
 * The trigger panel: change the trigger type; table triggers (operations, changed columns, a condition builder,
 * coalescing, the flow's own changes), schedules (presets, or cron with the next five run times in the chosen time zone,
 * computed by the server), manual inputs (typed), web requests (create, rotate and revoke the flow's webhook through the
 * webhooks API; the address and the signing secret are shown once, with copy buttons and how to sign a request).
 */
import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, KeyRound, Plus, RotateCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { platform, usePlatform } from '@/platform'
import type { InputDef, Trigger, TriggerTypeDoc } from '@/platform/flows'
import { errMsg, fmtDate } from '@/portal/kit'
import { flowsApi, type WebhookInfo } from '../api'
import { useDesigner } from './store'
import { useDesignerData } from './context'
import { tableByName } from './dynamic'
import { ConditionBuilder, Labeled, Section, TablePicker, inputCls } from './fields'
import { FieldError } from './FxField'
import { TRIGGER_ICON, FALLBACK_ICON } from './palette'

type AnyTrigger = Trigger & Record<string, unknown>

const setTrigger = (fn: (t: AnyTrigger) => AnyTrigger, key?: string) =>
  useDesigner.getState().edit((x) => ({ ...x, doc: { ...x.doc, trigger: fn(x.doc.trigger as AnyTrigger) as Trigger } }), key)

const DEFAULTS: Record<string, AnyTrigger> = {
  table: { type: 'table', table: '', on: ['create'] } as AnyTrigger,
  schedule: { type: 'schedule', cron: '0 8 * * 1-5', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } as AnyTrigger,
  manual: { type: 'manual', inputs: [], from: 'any' } as AnyTrigger,
  webhook: { type: 'webhook' } as AnyTrigger,
  formSubmitted: { type: 'formSubmitted', app: '', form: '', on: ['create', 'update'] } as AnyTrigger,
}

export function triggerTitle(t: Trigger | undefined, docs: TriggerTypeDoc[]): string {
  return docs.find((d) => d.type === t?.type)?.title ?? (t?.type === 'table' ? 'When a row changes' : t?.type ?? 'Choose a trigger')
}

export function triggerSummary(t: Trigger | undefined): string {
  const a = t as AnyTrigger | undefined
  switch (a?.type) {
    case 'table': return a.table ? `${(a.on as string[] ?? []).join(', ')} in ${a.table}${a.condition ? ' · with a condition' : ''}` : 'Choose a table'
    case 'schedule': return a.cron ? `cron ${a.cron} (${a.timeZone})` : a.everyMinutes ? `every ${a.everyMinutes} min` : 'Set the schedule'
    case 'manual': return `${(a.inputs as InputDef[] ?? []).length} input${(a.inputs as InputDef[] ?? []).length === 1 ? '' : 's'} · from ${a.from === 'any' ? 'apps and the portal' : a.from}`
    case 'webhook': return 'A signed web request'
    case 'formSubmitted': return a.form ? `${a.form as string} submitted${a.app ? '' : ' (choose an app)'}` : 'Choose an app and a form'
    default: return ''
  }
}

export function TriggerPanel() {
  const doc = useDesigner((s) => s.doc)
  const ro = useDesigner((s) => s.readOnly)
  const data = useDesignerData()
  const t = doc.trigger as AnyTrigger
  const docs = (data.catalog?.triggers ?? []).filter((d) => !d.reserved)
  const Icon = TRIGGER_ICON[t?.type] ?? FALLBACK_ICON
  const change = (type: string) => {
    if (type === t?.type) return
    if (!confirm('Change the trigger? Its settings are replaced, and formulas that read Trigger.* may need changes.')) return
    setTrigger(() => (DEFAULTS[type] ?? ({ type } as AnyTrigger)))
  }
  return (
    <div className="flex h-full flex-col" data-testid="trigger-panel">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary"><Icon className="size-4" /></span>
        <div className="min-w-0"><div className="text-sm font-semibold">Trigger</div><div className="truncate text-[11px] text-muted-foreground">{triggerTitle(t, data.catalog?.triggers ?? [])}</div></div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto" data-no-canvas-wheel>
        <Section title="When does it run">
          <div className="grid grid-cols-2 gap-1.5">
            {(docs.length ? docs : (['table', 'schedule', 'manual', 'webhook'].map((x) => ({ type: x, title: x, summary: '' })) as TriggerTypeDoc[])).map((d) => {
              const I = TRIGGER_ICON[d.type] ?? FALLBACK_ICON
              return (
                <button key={d.type} type="button" disabled={ro} className={cn('flex items-start gap-2 rounded-md border p-2 text-left text-xs', t?.type === d.type ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50')} onClick={() => change(d.type)} data-testid={`trigger-type-${d.type}`}>
                  <I className="mt-0.5 size-4 shrink-0 text-primary" /><span><span className="block font-medium">{d.title}</span><span className="line-clamp-2 text-[10px] text-muted-foreground">{d.summary}</span></span>
                </button>
              )
            })}
          </div>
          <FieldError stepId="trigger" field="type" />
        </Section>
        {t?.type === 'table' && <TableTrigger t={t} />}
        {t?.type === 'schedule' && <ScheduleTrigger t={t} />}
        {t?.type === 'manual' && <ManualTrigger t={t} />}
        {t?.type === 'webhook' && <WebhookTrigger t={t} />}
        {t?.type === 'formSubmitted' && <FormSubmittedTrigger t={t} />}
        {t && !['table', 'schedule', 'manual', 'webhook', 'formSubmitted'].includes(t.type) && <GenericTrigger t={t} doc={data.catalog?.triggers.find((d) => d.type === t.type)} />}
      </div>
    </div>
  )
}

/** formSubmitted: pick the app (stored by id) and one of its Forms; which saves count (new rows, changes) */
function FormSubmittedTrigger({ t }: { t: AnyTrigger }) {
  const ro = useDesigner((s) => s.readOnly)
  const apps = usePlatform((s) => s.apps)
  const appId = (t.app as string) ?? ''
  const [forms, setForms] = useState<string[] | null>(null)
  useEffect(() => {
    setForms(null)
    if (!appId) return
    let alive = true
    void platform.apps.load(appId).then((def) => {
      if (!alive) return
      const out: string[] = []
      const walk = (n: { type: string; name: string; children?: unknown[] }): void => {
        if (n.type === 'Form') out.push(n.name)
        for (const c of (n.children ?? []) as { type: string; name: string; children?: unknown[] }[]) walk(c)
      }
      for (const sc of def?.screens ?? []) walk(sc as never)
      setForms(out)
    }, () => { if (alive) setForms([]) })
    return () => { alive = false }
  }, [appId])
  const form = (t.form as string) ?? ''
  const on = (t.on as string[] | undefined) ?? ['create', 'update']
  return (
    <>
      <Section title="App and form" hint="Runs for the person who submits, after the save went through (also for a submit saved offline, once it is sent).">
        <Labeled label="App">
          <select className={inputCls} disabled={ro} value={appId} data-testid="trigger-form-app" onChange={(e) => setTrigger((x) => ({ ...x, app: e.target.value, form: '' }))}>
            <option value="">Choose an app</option>
            {apps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            {appId && !apps.some((a) => a.id === appId) && <option value={appId}>{appId} (not found)</option>}
          </select>
        </Labeled>
        <FieldError stepId="trigger" field="app" />
        <Labeled label="Form">
          <select className={inputCls} disabled={ro || !appId} value={form} data-testid="trigger-form-form" onChange={(e) => setTrigger((x) => ({ ...x, form: e.target.value }))}>
            <option value="">{forms === null && appId ? 'Loading...' : 'Choose a form'}</option>
            {(forms ?? []).map((f) => <option key={f} value={f}>{f}</option>)}
            {form && forms && !forms.includes(form) && <option value={form}>{form} (not in this app)</option>}
          </select>
        </Labeled>
        <FieldError stepId="trigger" field="form" />
      </Section>
      <Section title="Which saves">
        <div className="flex gap-3 text-xs">
          {(['create', 'update'] as const).map((o) => (
            <label key={o} className="flex items-center gap-1"><input type="checkbox" disabled={ro} checked={on.includes(o)} data-testid={`trigger-form-on-${o}`} onChange={(e) => setTrigger((x) => ({ ...x, on: e.target.checked ? [...on, o] : on.filter((y) => y !== o) }) as AnyTrigger)} />{o === 'create' ? 'New records' : 'Changed records'}</label>
          ))}
        </div>
        <FieldError stepId="trigger" field="on" />
      </Section>
    </>
  )
}

function TableTrigger({ t }: { t: AnyTrigger }) {
  const ro = useDesigner((s) => s.readOnly)
  const settings = useDesigner((s) => s.doc.settings)
  const data = useDesignerData()
  const table = tableByName(data.tables, t.table as string)
  const on = (t.on as string[]) ?? []
  const cols = (t.columns as string[] | undefined) ?? []
  return (
    <>
      <Section title="Table and changes">
        <TablePicker value={(t.table as string) ?? ''} disabled={ro} testId="trigger-table" onChange={(v) => setTrigger((x) => ({ ...x, table: v, columns: undefined }))} />
        <FieldError stepId="trigger" field="table" />
        <div className="flex gap-3 text-xs">
          {(['create', 'update', 'delete', 'restore'] as const).map((o) => (
            <label key={o} className="flex items-center gap-1" title={o === 'restore' ? 'Rows that come back from the recycle bin (off unless you tick it)' : undefined}><input type="checkbox" disabled={ro} checked={on.includes(o)} data-testid={`trigger-on-${o}`} onChange={(e) => setTrigger((x) => ({ ...x, on: e.target.checked ? [...on, o] : on.filter((y) => y !== o) }) as AnyTrigger)} />{o === 'create' ? 'Added' : o === 'update' ? 'Changed' : o === 'delete' ? 'Deleted' : 'Restored'}</label>
          ))}
        </div>
        <FieldError stepId="trigger" field="on" />
      </Section>
      {on.includes('update') && table && (
        <Section title="Only when these columns change" hint="None ticked: any change.">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {table.columns.filter((c) => !c.system).map((c) => <label key={c.name} className="flex items-center gap-1"><input type="checkbox" disabled={ro} checked={cols.includes(c.name)} onChange={(e) => { const n = e.target.checked ? [...cols, c.name] : cols.filter((x) => x !== c.name); setTrigger((x) => { const y = { ...x }; if (n.length) y.columns = n; else delete y.columns; return y }) }} />{c.displayName}</label>)}
          </div>
          <FieldError stepId="trigger" field="columns" />
        </Section>
      )}
      <Section title="Condition" hint="Optional: start a run only when this holds for the changed row (Trigger.Old is the row before the change).">
        <ConditionBuilder stepId="trigger" field="condition" label="Run only when" value={t.condition as string} testId="trigger-condition" onChange={(v) => setTrigger((x) => { const y = { ...x }; if (v) y.condition = v; else delete y.condition; return y }, 'trigger:condition')} />
      </Section>
      <Section title="Repeated changes">
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" disabled={ro} checked={t.coalesce === true} onChange={(e) => setTrigger((x) => { const y = { ...x }; if (e.target.checked) y.coalesce = true; else delete y.coalesce; return y })} /><span><b>Fold changes together.</b> While a run for a row is still waiting to start, later changes of that row update it instead of adding runs.</span></label>
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" disabled={ro} checked={settings.triggerOnOwnChanges === true} onChange={(e) => useDesigner.getState().edit((x) => ({ ...x, doc: { ...x.doc, settings: { ...x.doc.settings, triggerOnOwnChanges: e.target.checked || undefined } } }))} /><span><b>Run for changes this flow makes itself.</b> Off by default so a flow that updates its own row does not loop (at most 3 times per row when on).</span></label>
      </Section>
    </>
  )
}

const PRESETS: { label: string; cron?: string; every?: number }[] = [
  { label: 'Every 15 minutes', every: 15 }, { label: 'Every hour', cron: '0 * * * *' }, { label: 'Every day at 08:00', cron: '0 8 * * *' },
  { label: 'Weekdays at 08:30', cron: '30 8 * * 1-5' }, { label: 'Mondays at 09:00', cron: '0 9 * * 1' }, { label: 'The 1st of the month at 07:00', cron: '0 7 1 * *' },
]
const ZONES = (() => { try { return (Intl as unknown as { supportedValuesOf?(k: string): string[] }).supportedValuesOf?.('timeZone') ?? [] } catch { return [] } })()

function ScheduleTrigger({ t }: { t: AnyTrigger }) {
  const ro = useDesigner((s) => s.readOnly)
  const [preview, setPreview] = useState<{ next: string[]; description?: string; error?: string } | null>(null)
  const tz = (t.timeZone as string) || 'UTC'
  const cron = t.cron as string | undefined
  const every = t.everyMinutes as number | undefined
  useEffect(() => {
    const h = setTimeout(() => {
      flowsApi.schedulePreview({ ...(cron ? { cron } : { everyMinutes: every }), timeZone: tz }).then(setPreview).catch((e) => setPreview({ next: [], error: errMsg(e) }))
    }, 300)
    return () => clearTimeout(h)
  }, [cron, every, tz])
  const fmt = (iso: string) => { try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(iso)) } catch { return iso } }
  const presetOf = PRESETS.find((p) => (p.cron && p.cron === cron) || (p.every && p.every === every && !cron))
  return (
    <Section title="Schedule">
      <Labeled label="How often">
        <select className={inputCls} disabled={ro} value={presetOf ? presetOf.label : 'custom'} data-testid="schedule-preset" onChange={(e) => {
          const p = PRESETS.find((x) => x.label === e.target.value)
          if (p) setTrigger((x) => { const y = { ...x }; if (p.cron) { y.cron = p.cron; delete y.everyMinutes } else { y.everyMinutes = p.every; delete y.cron } return y })
        }}>
          {PRESETS.map((p) => <option key={p.label}>{p.label}</option>)}
          <option value="custom">Custom (cron)</option>
        </select>
      </Labeled>
      <div className="grid grid-cols-2 gap-2">
        <Labeled label="Cron (advanced)" hint="minute hour day month weekday">
          <input className={cn(inputCls, 'font-mono')} value={cron ?? ''} readOnly={ro} placeholder="30 8 * * 1-5" data-testid="schedule-cron" onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setTrigger((x) => { const y = { ...x }; if (e.target.value) { y.cron = e.target.value; delete y.everyMinutes } else delete y.cron; return y }, 'trigger:cron')} />
        </Labeled>
        <Labeled label="Or every N minutes">
          <input type="number" min={1} className={inputCls} value={cron ? '' : every ?? ''} readOnly={ro} onChange={(e) => setTrigger((x) => { const y = { ...x }; if (e.target.value) { y.everyMinutes = Number(e.target.value); delete y.cron } else delete y.everyMinutes; return y })} />
        </Labeled>
      </div>
      <Labeled label="Time zone">
        <input className={inputCls} list="flow-tz" value={tz} readOnly={ro} data-testid="schedule-tz" onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setTrigger((x) => ({ ...x, timeZone: e.target.value }), 'trigger:tz')} />
        <datalist id="flow-tz">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>
      </Labeled>
      <FieldError stepId="trigger" field="cron" />
      <FieldError stepId="trigger" field="timeZone" />
      <div className="rounded-md bg-muted/50 p-2 text-xs" data-testid="schedule-preview">
        {preview?.error ? <span className="text-destructive">{preview.error}</span> : (
          <>
            <div className="mb-1 font-medium">{preview?.description ? `Runs ${preview.description}` : 'Next runs'} ({tz})</div>
            <ol className="list-decimal pl-4">{(preview?.next ?? []).map((n) => <li key={n}>{fmt(n)}</li>)}</ol>
            <p className="mt-1 text-[10px] text-muted-foreground">Only while the flow is on.</p>
          </>
        )}
      </div>
    </Section>
  )
}

const INPUT_TYPES: InputDef['type'][] = ['text', 'number', 'boolean', 'date', 'datetime', 'choice', 'record', 'table']

function ManualTrigger({ t }: { t: AnyTrigger }) {
  const ro = useDesigner((s) => s.readOnly)
  const inputs = (t.inputs as InputDef[]) ?? []
  const put = (next: InputDef[], key?: string) => setTrigger((x) => ({ ...x, inputs: next }), key)
  return (
    <>
      <Section title="Started from">
        <select className={inputCls} disabled={ro} value={(t.from as string) ?? 'any'} onChange={(e) => setTrigger((x) => ({ ...x, from: e.target.value }) as AnyTrigger)} data-testid="manual-from">
          <option value="any">Apps, records and the Flows page</option><option value="app">Apps (RunFlow) and the Flows page</option><option value="record">A record</option>
        </select>
      </Section>
      <Section title="Inputs" hint="What the person or app passes in. Steps read them as Trigger.Inputs.<name>.">
        {inputs.map((i, n) => (
          <div key={n} className="grid gap-1 rounded-md border border-border p-2" data-testid={`input-def-${n}`}>
            <div className="flex gap-1">
              <input className={inputCls} value={i.name} readOnly={ro} placeholder="Name" aria-label="Input name" onKeyDown={(e) => e.stopPropagation()} onChange={(e) => put(inputs.map((x, j) => (j === n ? { ...x, name: e.target.value.replace(/[^A-Za-z0-9_]/g, '') } : x)), `trigger:input${n}`)} data-testid="input-name" />
              <select className="h-8 rounded-md border border-input bg-background px-1 text-xs" value={i.type} disabled={ro} onChange={(e) => put(inputs.map((x, j) => (j === n ? { ...x, type: e.target.value as InputDef['type'] } : x)))} aria-label="Input type" data-testid="input-type">{INPUT_TYPES.map((y) => <option key={y}>{y}</option>)}</select>
              {!ro && <button type="button" className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label="Remove input" onClick={() => put(inputs.filter((_, j) => j !== n))}><Trash2 className="size-4" /></button>}
            </div>
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1"><input type="checkbox" disabled={ro} checked={!!i.required} onChange={(e) => put(inputs.map((x, j) => (j === n ? { ...x, required: e.target.checked || undefined } : x)))} />Required</label>
              <input className="h-7 flex-1 rounded border border-input bg-background px-2 text-xs" value={i.description ?? ''} readOnly={ro} placeholder="What it is (shown to people)" onKeyDown={(e) => e.stopPropagation()} onChange={(e) => put(inputs.map((x, j) => (j === n ? { ...x, description: e.target.value || undefined } : x)), `trigger:inputd${n}`)} />
            </div>
            {i.type === 'choice' && <input className="h-7 rounded border border-input bg-background px-2 text-xs" value={(i.choices ?? []).join(', ')} readOnly={ro} placeholder="Choices, comma-separated" onKeyDown={(e) => e.stopPropagation()} onChange={(e) => put(inputs.map((x, j) => (j === n ? { ...x, choices: e.target.value.split(',').map((c) => c.trim()).filter(Boolean) } : x)), `trigger:inputc${n}`)} />}
            <FieldError stepId="trigger" field={`inputs[${n}]`} />
          </div>
        ))}
        {!ro && <Button size="sm" variant="outline" className="w-fit" onClick={() => put([...inputs, { name: `Input${inputs.length + 1}`, type: 'text' }])} data-testid="add-input"><Plus className="size-4" />Add an input</Button>}
      </Section>
    </>
  )
}

function CopyBox({ label, value, testId }: { label: string; value: string; testId?: string }) {
  const [done, setDone] = useState(false)
  return (
    <div className="grid gap-0.5">
      <span className="text-[11px] font-medium">{label}</span>
      <div className="flex gap-1">
        <input readOnly className={cn(inputCls, 'min-w-0 font-mono text-[11px]')} value={value} data-testid={testId} onFocus={(e) => e.target.select()} />
        <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500) }) }} aria-label={`Copy ${label}`}>{done ? <Check className="size-4" /> : <Copy className="size-4" />}</Button>
      </div>
    </div>
  )
}

function WebhookTrigger({ t }: { t: AnyTrigger }) {
  const flowId = useDesigner((s) => s.flowId)
  const ro = useDesigner((s) => s.readOnly)
  const unpublished = useDesigner((s) => s.unpublished)
  const [hooks, setHooks] = useState<WebhookInfo[] | null>(null)
  const [shown, setShown] = useState<{ url?: string; secret?: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [sample, setSample] = useState(t.sample !== undefined ? JSON.stringify(t.sample, null, 2) : '')
  const load = () => { if (flowId) flowsApi.webhooks(flowId).then((r) => setHooks(r.items)).catch((e) => setErr(errMsg(e))) }
  useEffect(load, [flowId])
  const abs = (u?: string) => (u && u.startsWith('/') ? `${location.origin}${u}` : u)
  const act = (p: Promise<unknown>) => p.then(() => { setErr(null); load() }).catch((e) => setErr(errMsg(e)))
  const exampleUrl = abs(shown?.url) ?? 'https://<server>/api/v1/hooks/<environment>/<flow>/<token>'
  return (
    <>
      <Section title="Web address" hint="Other systems post to this address to start a run. The address holds a secret token; the signing secret proves who sent it.">
        {!flowId ? <p className="text-xs text-muted-foreground">Save the flow first.</p> : (
          <>
            {unpublished && <p className="text-[11px] text-amber-700 dark:text-amber-400">The webhook starts the published version: publish to make calls run with this trigger.</p>}
            {err && <p className="text-xs text-destructive">{err}</p>}
            {shown && (
              <div className="grid gap-2 rounded-md border border-amber-500/50 bg-amber-500/5 p-2" data-testid="webhook-secret-once">
                <p className="text-[11px] font-medium text-amber-800 dark:text-amber-300">Copy these now: they are not shown again.</p>
                {shown.url && <CopyBox label="Address" value={abs(shown.url)!} testId="webhook-url" />}
                {shown.secret && <CopyBox label="Signing secret" value={shown.secret} testId="webhook-secret" />}
                <Button size="sm" variant="ghost" className="w-fit" onClick={() => setShown(null)}>I copied them</Button>
              </div>
            )}
            {hooks?.map((h) => (
              <div key={h.id} className="grid gap-1 rounded-md border border-border p-2 text-xs" data-testid="webhook-row">
                <div className="flex items-center gap-2"><KeyRound className="size-3.5" /><span className="font-mono">{h.urlPrefix}{h.tokenHint}…</span><span className={cn('ml-auto rounded px-1', h.enabled ? 'bg-emerald-500/15 text-emerald-700' : 'bg-muted')}>{h.enabled ? 'on' : 'off'}</span></div>
                <div className="text-muted-foreground">{h.calls} calls · {h.rejected} refused · last {h.lastUsedOn ? fmtDate(h.lastUsedOn) : 'never'} · {h.requireSignature ? 'signature required' : 'signature optional'}</div>
                {!ro && (
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="outline" onClick={() => flowsApi.rotateWebhook(h.id, { token: true }).then((r) => { setShown({ url: r.url }); load() }).catch((e) => setErr(errMsg(e)))} data-testid="webhook-rotate-token"><RotateCw className="size-3.5" />New address</Button>
                    <Button size="sm" variant="outline" onClick={() => flowsApi.rotateWebhook(h.id, { secret: true }).then((r) => { setShown({ secret: r.secret }); load() }).catch((e) => setErr(errMsg(e)))}><RotateCw className="size-3.5" />New secret</Button>
                    <Button size="sm" variant="outline" onClick={() => act(flowsApi.updateWebhook(h.id, { requireSignature: !h.requireSignature }))}>{h.requireSignature ? 'Allow unsigned' : 'Require signature'}</Button>
                    <Button size="sm" variant="outline" onClick={() => act(flowsApi.updateWebhook(h.id, { enabled: !h.enabled }))}>{h.enabled ? 'Turn off' : 'Turn on'}</Button>
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => { if (confirm('Revoke this webhook? Calls to its address are refused from now on.')) act(flowsApi.revokeWebhook(h.id)) }} data-testid="webhook-revoke"><Trash2 className="size-3.5" />Revoke</Button>
                  </div>
                )}
              </div>
            ))}
            {hooks && !hooks.length && !ro && <Button size="sm" className="w-fit" data-testid="webhook-create" onClick={() => flowsApi.createWebhook(flowId, { requireSignature: true }).then((r) => { setShown({ url: r.url, secret: r.secret }); load() }).catch((e) => setErr(errMsg(e)))}><Plus className="size-4" />Create the web address</Button>}
          </>
        )}
      </Section>
      <Section title="Signing a request (HMAC)">
        <div className="grid gap-1 text-[11px] text-muted-foreground">
          <p>Send the header <code className="font-mono">X-Appbuilder-Signature: t=&lt;unix seconds&gt;,v1=&lt;hex HMAC-SHA256 of "&lt;t&gt;.&lt;raw body&gt;" with the signing secret&gt;</code>. The time must be within 5 minutes; each signature is accepted once.</p>
          <pre className="overflow-auto rounded bg-muted p-2 font-mono text-[10px] text-foreground">{`body='{"name":"Ada"}'
t=$(date +%s)
sig=$(printf '%s.%s' "$t" "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST '${exampleUrl}' \\
  -H 'Content-Type: application/json' \\
  -H "X-Appbuilder-Signature: t=$t,v1=$sig" -d "$body"`}</pre>
        </div>
      </Section>
      <Section title="Sample body" hint="Paste an example request body (JSON) to get its fields as dynamic content (Trigger.Body.x).">
        <textarea className="min-h-24 rounded-md border border-input bg-background p-2 font-mono text-xs" value={sample} readOnly={ro} data-testid="webhook-sample" onKeyDown={(e) => e.stopPropagation()} placeholder='{"name": "Ada", "amount": 12}'
          onChange={(e) => { setSample(e.target.value); try { const v = e.target.value.trim() ? JSON.parse(e.target.value) : undefined; setTrigger((x) => { const y = { ...x }; if (v === undefined) delete y.sample; else y.sample = v; return y }, 'trigger:sample') } catch { /* not yet JSON */ } }} />
      </Section>
    </>
  )
}

function GenericTrigger({ t, doc }: { t: AnyTrigger; doc?: TriggerTypeDoc }) {
  const ro = useDesigner((s) => s.readOnly)
  const fields = useMemo(() => doc?.fields ?? [], [doc])
  return (
    <Section title={doc?.title ?? t.type} hint={doc?.summary}>
      {fields.map((f) => {
        const list = /\[\]$/.test(f.type)
        const v = t[f.name]
        const choices = /"([^"]+)"/g.test(f.type) ? [...f.type.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : null
        return (
          <Labeled key={f.name} label={f.name} hint={f.doc}>
            {list && choices ? (
              <div className="flex flex-wrap gap-2 text-xs">{choices.map((c) => <label key={c} className="flex items-center gap-1"><input type="checkbox" disabled={ro} checked={Array.isArray(v) && v.includes(c)} onChange={(e) => setTrigger((x) => { const cur = Array.isArray(x[f.name]) ? x[f.name] as string[] : []; const n = e.target.checked ? [...cur, c] : cur.filter((y) => y !== c); const y = { ...x }; if (n.length) y[f.name] = n; else delete y[f.name]; return y })} />{c}</label>)}</div>
            ) : (
              <input className={inputCls} readOnly={ro} value={typeof v === 'string' ? v : ''} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setTrigger((x) => { const y = { ...x }; if (e.target.value) y[f.name] = e.target.value; else delete y[f.name]; return y }, `trigger:${f.name}`)} />
            )}
            <FieldError stepId="trigger" field={f.name} />
          </Labeled>
        )
      })}
      <p className="text-[11px] text-muted-foreground">Expressions see: {doc?.scope}</p>
    </Section>
  )
}
