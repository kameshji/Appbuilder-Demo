/**
 * The configuration panel of a step: generated from the step kind (catalogue fields) but with real pickers: tables and
 * columns, the field mapping grid, the visual filter and condition builders, people pickers, durations, a rich text
 * email body, inputs from an action's JSON Schema, a child flow's typed inputs. "Advanced": retry policy, time limit, run
 * after, the note and the step's id. Unknown step kinds (a newer runtime) are edited as JSON, nothing is lost.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Bold, Italic, Link2, List, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { platform, usePlatform } from '@/platform'
import type { InputDef, RetryPolicy, RunAfterStatus, Step } from '@/platform/flows'
import { kindInfo } from './palette'
import { useDesigner } from './store'
import { patchStep, rename, setNote, setRunAfter } from './actions'
import { findStep, renameLoopItem, walk } from './model'
import { useDesignerData } from './context'
import { tableByName } from './dynamic'
import { FxField, FormulaInput, FieldError, DynamicContent } from './FxField'
import {
  ActionInputs, ConditionBuilder, DurationPicker, FilterBuilder, KeyValues, Labeled, MappingGrid, PeoplePicker, Section, TablePicker, inputCls,
  writableColumns, type Schema,
} from './fields'
import { ApprovalConfig } from './approvalAdapter'
import { refFor } from './StepPicker'
import { textOf, textFx } from './literal'
import { overlayOf, fmtDuration, type StepOverlay } from './overlay'
import { StatusBadge } from '../RunViews'

type AnyStep = Step & Record<string, unknown>

export function StepPanel({ id }: { id: string }) {
  const doc = useDesigner((s) => s.doc)
  const f = findStep(doc.steps, id)
  const run = useDesigner((st) => st.run)
  const iteration = useDesigner((st) => st.iteration)
  const ov = useMemo(() => overlayOf(run, iteration).get(id), [run, iteration, id])
  const [tab, setTab] = useState<'settings' | 'advanced' | 'run'>(ov ? 'run' : 'settings')
  useEffect(() => { if (!ov && tab === 'run') setTab('settings') }, [ov, tab])
  if (!f) return null
  const s = f.step as AnyStep
  const info = kindInfo(s.kind)
  const Icon = info.icon
  const set = (patch: Record<string, unknown>, key?: string) => patchStep(id, (x) => {
    const n = { ...(x as AnyStep) }
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete n[k]
      else n[k] = v
    }
    return n as Step
  }, key)
  return (
    <div className="flex h-full flex-col" data-testid="step-panel" data-step={s.id}>
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-md', info.tone)}><Icon className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <NameEditor id={id} name={s.name} />
          <div className="truncate text-[11px] text-muted-foreground">{info.title}{info.blurb ? ` · ${info.blurb}` : ''}</div>
        </div>
      </header>
      <div className="flex border-b border-border px-4 text-xs" role="tablist">
        {(['settings', 'advanced', ...(ov ? ['run'] : [])] as ('settings' | 'advanced' | 'run')[]).map((t) => <button key={t} role="tab" aria-selected={tab === t} type="button" className={cn('-mb-px border-b-2 px-2 py-1.5', tab === t ? 'border-primary font-medium' : 'border-transparent text-muted-foreground')} onClick={() => setTab(t)} data-testid={`panel-tab-${t}`}>{t === 'settings' ? 'Settings' : t === 'advanced' ? 'Advanced' : 'In this run'}</button>)}
      </div>
      <div className="min-h-0 flex-1 overflow-auto" data-no-canvas-wheel>
        {tab === 'run' && ov ? <RunOfStep ov={ov} /> : tab === 'settings' ? <KindForm s={s} set={set} /> : <AdvancedForm s={s} set={set} />}
      </div>
    </div>
  )
}

/** what the step did in the run shown on the canvas: status, timing, attempts, inputs, outputs, error (secrets are redacted by the server) */
function RunOfStep({ ov }: { ov: StepOverlay }) {
  const r = ov.row
  const box = (v: unknown) => <pre className="max-h-72 overflow-auto rounded-md bg-muted p-2 text-[11px]">{JSON.stringify(v ?? null, null, 2)}</pre>
  return (
    <div data-testid="step-run">
      <Section title="In this run">
        <div className="flex flex-wrap items-center gap-2 text-xs"><StatusBadge status={r.status} />{r.durationMs !== undefined && <span>{fmtDuration(r.durationMs)}</span>}<span>attempt {r.attempt}</span>{r.simulated && <span className="rounded bg-amber-500/15 px-1 text-amber-800 dark:text-amber-300">simulated (test run)</span>}{ov.count > 1 && <span className="text-muted-foreground">{ov.count} executions shown for this iteration</span>}</div>
        <p className="text-[11px] text-muted-foreground">Started {new Date(r.startedOn).toLocaleString()}{r.finishedOn ? `, ended ${new Date(r.finishedOn).toLocaleString()}` : ''} · <code className="font-mono">{r.key}</code></p>
        {r.error && <p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive" data-testid="step-run-error">{r.error.message}</p>}
        {r.truncated && <p className="text-[11px] text-muted-foreground">Large inputs or outputs are cut for display.</p>}
      </Section>
      <Section title="Inputs">{box(r.input)}</Section>
      <Section title="Output">{box(r.output)}</Section>
    </div>
  )
}

function NameEditor({ id, name }: { id: string; name: string }) {
  const ro = useDesigner((s) => s.readOnly)
  const [v, setV] = useState(name)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { setV(name); setErr(null) }, [name])
  const commit = () => {
    if (v === name) return
    const e = rename(id, v)
    setErr(e)
    if (e) setV(name)
  }
  return (
    <div>
      <input className="w-full rounded border border-transparent bg-transparent px-1 text-sm font-semibold hover:border-border focus:border-primary focus:outline-none" value={v} readOnly={ro} aria-label="Step name" data-testid="step-name-input"
        onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setV(name); (e.target as HTMLInputElement).blur() } }} />
      {err && <p className="px-1 text-[11px] text-destructive">{err}</p>}
    </div>
  )
}

/** a connection reference of the flow of one connector kind: pick an attached one or attach another usable connection */
function ConnectionRef({ field, label, kinds, value, onChange, required, stepId }: { field: string; label: string; kinds: string[]; value: string | undefined; onChange(ref: string | undefined): void; required?: boolean; stepId: string }) {
  const data = useDesignerData()
  const all = usePlatform((s) => s.connections)
  const connections = useDesigner((s) => s.connections)
  const ro = useDesigner((s) => s.readOnly)
  const usable = new Map((data.usable ?? []).map((c) => [c.id, c]))
  const candidates = all.filter((c) => kinds.includes(c.connector))
  const current = value ? connections[value] : undefined
  const onPick = (connId: string) => {
    if (!connId) { onChange(undefined); return }
    const c = all.find((x) => x.id === connId)
    if (!c) return
    if (!usable.has(connId) && !Object.values(connections).includes(connId)) { alert(`You need "use" access to ${c.name} to attach it to a flow. Ask an administrator to grant it (Connections > ${c.name} > Access).`); return }
    const st = useDesigner.getState()
    const ref = refFor(st.connections, connId, c.name)
    st.edit((x) => (x.connections[ref] === connId ? x : { ...x, connections: { ...x.connections, [ref]: connId } }))
    onChange(ref)
  }
  return (
    <Labeled label={label} required={required} hint={value && !current ? `The reference "${value}" is not attached to this flow: pick a connection.` : undefined}>
      <select className={inputCls} value={current ?? ''} disabled={ro} onChange={(e) => onPick(e.target.value)} data-testid={`conn-${field}`}>
        <option value="">{required ? 'Choose a connection' : 'The environment\'s default'}</option>
        {candidates.map((c) => <option key={c.id} value={c.id} disabled={!usable.has(c.id) && current !== c.id}>{c.name}{!usable.has(c.id) && current !== c.id ? ' (needs "use" access)' : ''}</option>)}
      </select>
      <FieldError stepId={stepId} field={field} />
    </Labeled>
  )
}

function KindForm({ s, set }: { s: AnyStep; set(p: Record<string, unknown>, key?: string): void }) {
  const data = useDesignerData()
  const doc = useDesigner((st) => st.doc)
  const ro = useDesigner((st) => st.readOnly)
  const t = 'table' in s ? tableByName(data.tables, s.table as string) : undefined
  const fx = (field: string, label: string, o: Partial<React.ComponentProps<typeof FxField>> = {}) => (
    <FxField stepId={s.id} field={field} label={label} value={s[field] as string | undefined} onChange={(v) => set({ [field]: v === '' && !o.required ? undefined : v }, `${s.id}:${field}`)} testId={`f-${field}`} {...o} />
  )
  switch (s.kind) {
    case 'condition': return <Section title="Condition"><ConditionBuilder stepId={s.id} field="if" label="Run the yes branch when" value={s.if as string} onChange={(v) => set({ if: v }, `${s.id}:if`)} testId="condition-if" /></Section>
    case 'switch': {
      const cases = (s.cases as { value: unknown; steps: Step[] }[]) ?? []
      return (
        <>
          <Section title="Switch on">{fx('on', 'Value', { formulaOnly: true, required: true })}</Section>
          <Section title="Cases" hint="Compared in order with =; the first case that matches runs.">
            {cases.map((c, i) => (
              <div key={i} className="flex items-center gap-1">
                <input className={inputCls} value={String(c.value ?? '')} readOnly={ro} aria-label={`Case ${i + 1}`} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => set({ cases: cases.map((x, j) => (j === i ? { ...x, value: /^-?\d+(\.\d+)?$/.test(e.target.value) ? Number(e.target.value) : e.target.value } : x)) }, `${s.id}:case${i}`)} />
                {!ro && <button type="button" className="rounded px-2 text-xs text-muted-foreground hover:bg-accent disabled:opacity-40" disabled={c.steps?.length > 0} title={c.steps?.length ? 'Move or delete its steps first' : 'Remove the case'} onClick={() => set({ cases: cases.filter((_, j) => j !== i) })}>Remove</button>}
              </div>
            ))}
            {!ro && <button type="button" className="w-fit rounded border border-border px-2 py-1 text-xs hover:bg-accent" onClick={() => set({ cases: [...cases, { value: '', steps: [] }] })} data-testid="add-case">Add a case</button>}
          </Section>
        </>
      )
    }
    case 'forEach': {
      const lists: { label: string; insert: string }[] = []
      walk(doc.steps, (x) => { if (x.kind === 'data.list' && x.id !== s.id) lists.push({ label: `Rows of ${x.name}`, insert: `Steps.${x.name}.Output` }) })
      return (
        <Section title="For each">
          <Labeled label="Items" hint="A list: rows a List rows step read, or any table formula.">
            {lists.length > 0 && !ro && (
              <select className={inputCls} value={lists.find((l) => l.insert === String(s.items ?? '').trim()) ? String(s.items).trim() : ''} onChange={(e) => e.target.value && set({ items: e.target.value })} data-testid="foreach-source">
                <option value="">Pick a list…</option>
                {lists.map((l) => <option key={l.insert} value={l.insert}>{l.label}</option>)}
              </select>
            )}
            <FormulaInput stepId={s.id} value={(s.items as string) ?? ''} onChange={(v) => set({ items: v }, `${s.id}:items`)} testId="f-items" readOnly={ro} />
            <FieldError stepId={s.id} field="items" />
          </Labeled>
          <Labeled label="Name of the current item" hint="Steps inside read it as <name>.Column (or ThisItem).">
            <input className={inputCls} value={(s.as as string) ?? ''} readOnly={ro} onKeyDown={(e) => e.stopPropagation()} data-testid="f-as"
              onChange={(e) => { const v = e.target.value.replace(/[^A-Za-z0-9_]/g, ''); if (v) useDesigner.getState().edit((x) => ({ ...x, doc: renameLoopItem(x.doc, s.id, v) }), `${s.id}:as`) }} />
            <FieldError stepId={s.id} field="as" />
          </Labeled>
          <Labeled label="At once" hint="1 = in order. More runs that many iterations in parallel (Set variable is not allowed inside then).">
            <input type="number" min={1} max={20} className={inputCls} value={(s.concurrency as number) ?? 1} readOnly={ro} onChange={(e) => set({ concurrency: Number(e.target.value) > 1 ? Math.min(20, Number(e.target.value)) : undefined })} data-testid="f-concurrency" />
          </Labeled>
          <Labeled label="At most items" hint="More items fail the step (default and cap 5000).">
            <input type="number" min={1} max={5000} className={inputCls} value={(s.max as number) ?? ''} readOnly={ro} onChange={(e) => set({ max: e.target.value ? Number(e.target.value) : undefined })} />
          </Labeled>
        </Section>
      )
    }
    case 'until': return (
      <Section title="Do until">
        <ConditionBuilder stepId={s.id} field="condition" label="Stop when" value={s.condition as string} onChange={(v) => set({ condition: v }, `${s.id}:condition`)} />
        <Labeled label="At most passes" required><input type="number" min={1} max={5000} className={inputCls} value={(s.maxIterations as number) ?? 10} readOnly={ro} onChange={(e) => set({ maxIterations: Math.max(1, Number(e.target.value) || 1) })} /></Labeled>
      </Section>
    )
    case 'scope': return <Section title="Scope" hint="Steps inside run as a group. Add a step after it with run after = failed to handle errors (try/catch)."><p className="text-xs text-muted-foreground">{((s.steps as Step[]) ?? []).length} steps inside.</p></Section>
    case 'setVariable': {
      const vars = doc.variables ?? []
      const v = vars.find((x) => x.name === s.variable)
      return (
        <Section title="Set variable">
          <Labeled label="Variable" required hint={!vars.length ? 'Declare variables in the flow settings (Variables).' : undefined}>
            <select className={inputCls} value={(s.variable as string) ?? ''} disabled={ro} onChange={(e) => set({ variable: e.target.value })} data-testid="f-variable">
              <option value="">Choose a variable</option>
              {vars.map((x) => <option key={x.name} value={x.name}>{x.name} ({x.type})</option>)}
            </select>
            <FieldError stepId={s.id} field="variable" />
          </Labeled>
          {fx('value', 'New value', { required: true, kind: v?.type === 'number' ? 'number' : v?.type === 'boolean' ? 'boolean' : v?.type === 'date' ? 'date' : 'text', formulaOnly: !v || ['record', 'table', 'any'].includes(v.type) })}
        </Section>
      )
    }
    case 'compose': return <Section title="Compose">{fx('value', 'Value', { required: true, formulaOnly: true, placeholder: '"Order " & Trigger.Record.Title' })}</Section>
    case 'respond': return (
      <Section title="Respond">
        {fx('body', 'Answer', { required: true, formulaOnly: true, placeholder: '{Total: Variables.Total}' })}
        <Labeled label="HTTP status (web requests)"><input type="number" className={inputCls} value={(s.status as number) ?? ''} placeholder="200" readOnly={ro} onChange={(e) => set({ status: e.target.value ? Number(e.target.value) : undefined })} /></Labeled>
      </Section>
    )
    case 'terminate': return (
      <Section title="Terminate">
        <Labeled label="End the run as">
          <select className={inputCls} value={(s.status as string) ?? 'succeeded'} disabled={ro} onChange={(e) => set({ status: e.target.value })} data-testid="f-status"><option value="succeeded">succeeded</option><option value="failed">failed</option><option value="cancelled">cancelled</option></select>
        </Labeled>
        {fx('message', 'Message')}
      </Section>
    )
    case 'data.get': case 'data.list': case 'data.create': case 'data.update': case 'data.delete':
      return <DataForm s={s} set={set} t={t} />
    case 'approval': return <ApprovalConfig step={s} onChange={(n) => patchStep(s.id, () => n, `${s.id}:approval`)} />
    case 'delay': {
      const mode = s.until !== undefined && s.minutes === undefined ? 'until' : 'for'
      return (
        <Section title="Delay">
          <div className="flex gap-3 text-xs">
            <label className="flex items-center gap-1"><input type="radio" checked={mode === 'for'} disabled={ro} onChange={() => set({ minutes: (s.minutes as number) ?? 60, until: undefined })} data-testid="delay-for" />Wait for</label>
            <label className="flex items-center gap-1"><input type="radio" checked={mode === 'until'} disabled={ro} onChange={() => set({ minutes: undefined, until: (s.until as string) ?? 'DateAdd(Now(), 1, "Days")' })} data-testid="delay-until" />Wait until</label>
          </div>
          {mode === 'for' ? <DurationPicker minutes={s.minutes as number} onChange={(m) => set({ minutes: m ?? 1 })} /> : fx('until', 'Until (date and time)', { formulaOnly: true, placeholder: 'DateAdd(Trigger.Record.Due, -2, "Days")' })}
        </Section>
      )
    }
    case 'notify': {
      const ch = (s.channels as string[]) ?? ['inApp']
      return (
        <Section title="Notify">
          <PeoplePicker stepId={s.id} field="to" label="To" required value={s.to as string} onChange={(v) => set({ to: v }, `${s.id}:to`)} testId="notify-to" />
          {fx('title', 'Title', { required: true })}
          {fx('body', 'Message', { multiline: true })}
          {fx('link', 'Link (inside Appbuilder, #...)')}
          <Labeled label="Channels">
            <div className="flex gap-3 text-xs">
              {(['inApp', 'email'] as const).map((c) => <label key={c} className="flex items-center gap-1"><input type="checkbox" disabled={ro} checked={ch.includes(c)} onChange={(e) => set({ channels: e.target.checked ? [...ch, c] : ch.filter((x) => x !== c) })} data-testid={`channel-${c}`} />{c === 'inApp' ? 'In the app (bell)' : 'Email'}</label>)}
            </div>
            <FieldError stepId={s.id} field="channels" />
          </Labeled>
        </Section>
      )
    }
    case 'email': return (
      <Section title="Send an email">
        <ConnectionRef stepId={s.id} field="connection" label="Email connection" kinds={['email']} value={s.connection as string} onChange={(r) => set({ connection: r })} />
        <PeoplePicker stepId={s.id} field="to" label="To" required value={s.to as string} onChange={(v) => set({ to: v }, `${s.id}:to`)} testId="email-to" />
        <PeoplePicker stepId={s.id} field="cc" label="Cc" value={s.cc as string} onChange={(v) => set({ cc: v || undefined }, `${s.id}:cc`)} testId="email-cc" />
        {fx('subject', 'Subject', { required: true })}
        <RichBody stepId={s.id} value={s.body as string} onChange={(v) => set({ body: v }, `${s.id}:body`)} />
        {fx('attachments', 'Attachments (attachment ids)', { formulaOnly: true })}
      </Section>
    )
    case 'http': return <HttpForm s={s} set={set} />
    case 'action': return <ActionForm s={s} set={set} />
    case 'callFlow': return <CallFlowForm s={s} set={set} />
    case 'waitForCallback': return (
      <Section title="Wait for a callback" hint="The run makes a one-time address (Flow.Callback.<step name>) and waits until something posts to it.">
        <Labeled label="Time limit"><DurationPicker minutes={s.timeoutMinutes as number} onChange={(m) => set({ timeoutMinutes: m })} /></Labeled>
      </Section>
    )
    default: return <RawStep s={s} />
  }
}

function DataForm({ s, set, t }: { s: AnyStep; set(p: Record<string, unknown>, key?: string): void; t: ReturnType<typeof tableByName> }) {
  const doc = useDesigner((st) => st.doc)
  const ro = useDesigner((st) => st.readOnly)
  const trig = doc.trigger as { type: string; table?: string }
  const sameTable = trig.type === 'table' && t && tableByName([t], trig.table) === t
  const onTable = (name: string) => {
    const tt = platform.tables.get(name) ?? undefined
    const patch: Record<string, unknown> = { table: name }
    if (s.kind === 'data.create' && tt) patch.values = Object.fromEntries(writableColumns(tt).filter((c) => c.required).map((c) => [c.name, '']))
    if (s.kind === 'data.update') patch.values = {}
    if ((s.kind === 'data.update' || s.kind === 'data.delete' || s.kind === 'data.get') && !s.rowId && trig.type === 'table' && String(trig.table).toLowerCase() === name.toLowerCase()) patch.rowId = 'Trigger.Record'
    set(patch)
  }
  return (
    <>
      <Section title="Table">
        <TablePicker value={(s.table as string) ?? ''} onChange={onTable} disabled={ro} testId="f-table" />
        <FieldError stepId={s.id} field="table" />
      </Section>
      {(s.kind === 'data.get' || s.kind === 'data.update' || s.kind === 'data.delete') && (
        <Section title="Which row" hint={sameTable ? 'Trigger.Record is the row that started the run.' : 'A row id, or a row an earlier step read.'}>
          {s.kind === 'data.get' ? <RowChooser s={s} set={set} t={t} /> : <FxField stepId={s.id} field="rowId" label="Row" required formulaOnly value={s.rowId as string} onChange={(v) => set({ rowId: v }, `${s.id}:rowId`)} testId="f-rowId" />}
          {s.kind === 'data.get' && <label className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={ro} checked={s.failIfMissing !== false} onChange={(e) => set({ failIfMissing: e.target.checked ? undefined : false })} />Fail when there is no such row</label>}
        </Section>
      )}
      {s.kind === 'data.list' && (
        <>
          <Section title="Rows"><FilterBuilder stepId={s.id} field="filter" table={t} value={s.filter as string} onChange={(v) => set({ filter: v || undefined }, `${s.id}:filter`)} /></Section>
          <Section title="Sort and limit">
            <SortEditor s={s} set={set} t={t} />
            <Labeled label="At most rows" hint="Default 100, at most 5000."><input type="number" min={1} max={5000} className={inputCls} value={(s.top as number) ?? ''} placeholder="100" readOnly={ro} onChange={(e) => set({ top: e.target.value ? Number(e.target.value) : undefined })} data-testid="f-top" /></Labeled>
            {t && (
              <Labeled label="Columns" hint="Default: every column you may read.">
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  {t.columns.filter((c) => !c.system).map((c) => {
                    const sel = (s.select as string[]) ?? []
                    return <label key={c.name} className="flex items-center gap-1"><input type="checkbox" disabled={ro} checked={sel.includes(c.name)} onChange={(e) => { const n = e.target.checked ? [...sel, c.name] : sel.filter((x) => x !== c.name); set({ select: n.length ? n : undefined }) }} />{c.displayName}</label>
                  })}
                </div>
              </Labeled>
            )}
          </Section>
        </>
      )}
      {(s.kind === 'data.create' || s.kind === 'data.update') && (
        <Section title={s.kind === 'data.create' ? 'Values of the new row' : 'Columns to change'}>
          <MappingGrid stepId={s.id} table={t} values={(s.values as Record<string, string>) ?? {}} onChange={(v) => set({ values: v }, `${s.id}:values`)} requiredFirst={s.kind === 'data.create'} />
          <FieldError stepId={s.id} field="values" exact />
        </Section>
      )}
    </>
  )
}

function RowChooser({ s, set, t }: { s: AnyStep; set(p: Record<string, unknown>, key?: string): void; t: ReturnType<typeof tableByName> }) {
  const ro = useDesigner((st) => st.readOnly)
  const isLookup = /^\s*=?\s*LookUp\(/.test(String(s.rowId ?? ''))
  const [mode, setMode] = useState<'id' | 'condition'>(isLookup ? 'condition' : 'id')
  return (
    <div className="grid gap-2">
      <div className="flex gap-3 text-xs">
        <label className="flex items-center gap-1"><input type="radio" disabled={ro} checked={mode === 'id'} onChange={() => setMode('id')} />By id</label>
        <label className="flex items-center gap-1"><input type="radio" disabled={ro} checked={mode === 'condition'} onChange={() => setMode('condition')} data-testid="get-by-condition" />The first row that matches</label>
      </div>
      {mode === 'id' ? <FxField stepId={s.id} field="rowId" label="Row" required formulaOnly value={s.rowId as string} onChange={(v) => set({ rowId: v }, `${s.id}:rowId`)} testId="f-rowId" />
        : <LookupFilter s={s} set={set} t={t} />}
    </div>
  )
}

function LookupFilter({ s, set, t }: { s: AnyStep; set(p: Record<string, unknown>, key?: string): void; t: ReturnType<typeof tableByName> }) {
  const raw = String(s.rowId ?? '').trim().replace(/^=/, '')
  const m = /^LookUp\(\s*[^,]+,\s*([\s\S]*)\)$/.exec(raw)
  const inner = m ? m[1] : ''
  return <FilterBuilder stepId={s.id} field="rowId" table={t} value={inner} onChange={(v) => set({ rowId: v && t ? `LookUp(${t.name}, ${v})` : '' }, `${s.id}:rowId`)} />
}

function SortEditor({ s, set, t }: { s: AnyStep; set(p: Record<string, unknown>): void; t: ReturnType<typeof tableByName> }) {
  const ro = useDesigner((st) => st.readOnly)
  const sort = (s.sort as { column: string; descending?: boolean }[]) ?? []
  const cols = ['createdOn', 'modifiedOn', ...(t?.columns ?? []).filter((c) => !c.system).map((c) => c.name)]
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium">Sort by</span>
      {sort.map((x, i) => (
        <div key={i} className="flex gap-1">
          <select className={inputCls} value={x.column} disabled={ro} onChange={(e) => set({ sort: sort.map((y, j) => (j === i ? { ...y, column: e.target.value } : y)) })}>{cols.map((c) => <option key={c} value={c}>{t?.columns.find((y) => y.name === c)?.displayName ?? c}</option>)}</select>
          <select className="h-8 rounded-md border border-input bg-background px-1 text-xs" value={x.descending ? 'desc' : 'asc'} disabled={ro} onChange={(e) => set({ sort: sort.map((y, j) => (j === i ? { ...y, descending: e.target.value === 'desc' || undefined } : y)) })}><option value="asc">A to Z, oldest first</option><option value="desc">Z to A, newest first</option></select>
          {!ro && <button type="button" className="rounded px-2 text-xs hover:bg-accent" onClick={() => set({ sort: sort.length > 1 ? sort.filter((_, j) => j !== i) : undefined })}>Remove</button>}
        </div>
      ))}
      {!ro && <button type="button" className="w-fit rounded border border-border px-2 py-1 text-xs hover:bg-accent" onClick={() => set({ sort: [...sort, { column: cols[0] }] })}>Add a sort</button>}
    </div>
  )
}

/** an email body: rich text (bold, italic, link, list) with dynamic content as {token}; or a formula */
function RichBody({ stepId, value, onChange }: { stepId: string; value: string | undefined; onChange(v: string): void }) {
  const ro = useDesigner((st) => st.readOnly)
  const text = textOf(value)
  const [mode, setMode] = useState<'rich' | 'formula'>(text === null ? 'formula' : 'rich')
  const ed = useRef<HTMLDivElement>(null)
  const last = useRef<string | null>(null)
  useEffect(() => {
    if (mode !== 'rich' || !ed.current) return
    const html = text ?? ''
    if (html !== last.current) { ed.current.innerHTML = html; last.current = html }
  }, [text, mode])
  const emit = () => {
    const html = ed.current?.innerHTML ?? ''
    last.current = html
    onChange(html.replace(/<br>$/, '') ? textFx(html) : '')
  }
  const cmd = (c: string, arg?: string) => { ed.current?.focus(); document.execCommand(c, false, arg); emit() }
  return (
    <div className="grid gap-1" data-testid="email-body">
      <div className="flex items-center gap-1">
        <span className="text-xs font-medium">Body<span className="text-destructive"> *</span></span>
        <span className="ml-auto inline-flex rounded border border-border p-0.5 text-[10px]">
          <button type="button" className={cn('rounded px-1.5', mode === 'rich' && 'bg-accent font-medium')} onClick={() => { if (text === null && value && !confirm('The body is a formula. Switch to rich text and clear it?')) return; if (text === null) onChange(''); setMode('rich') }}>Rich text</button>
          <button type="button" className={cn('rounded px-1.5 font-serif italic', mode === 'formula' && 'bg-accent font-medium')} onClick={() => setMode('formula')}>fx</button>
        </span>
      </div>
      {mode === 'formula' ? <FormulaInput stepId={stepId} value={value ?? ''} onChange={onChange} readOnly={ro} /> : (
        <div className="rounded-md border border-input">
          {!ro && (
            <div className="flex items-center gap-0.5 border-b border-border p-1">
              <button type="button" className="rounded p-1 hover:bg-accent" aria-label="Bold" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('bold')}><Bold className="size-3.5" /></button>
              <button type="button" className="rounded p-1 hover:bg-accent" aria-label="Italic" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('italic')}><Italic className="size-3.5" /></button>
              <button type="button" className="rounded p-1 hover:bg-accent" aria-label="List" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('insertUnorderedList')}><List className="size-3.5" /></button>
              <button type="button" className="rounded p-1 hover:bg-accent" aria-label="Link" onMouseDown={(e) => e.preventDefault()} onClick={() => { const u = prompt('Link address (https://...)'); if (u && /^https?:\/\//.test(u)) cmd('createLink', u) }}><Link2 className="size-3.5" /></button>
              <span className="ml-auto"><DynamicContent stepId={stepId} onPick={(t) => cmd('insertText', `{${t.insert}}`)} trigger={<button type="button" className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-primary hover:bg-primary/10" data-testid="dynamic-content" onMouseDown={(e) => e.preventDefault()}><Sparkles className="size-3.5" />Dynamic content</button>} /></span>
            </div>
          )}
          <div ref={ed} contentEditable={!ro} suppressContentEditableWarning className="prose-sm min-h-28 p-2 text-sm outline-none [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5" onInput={emit} onKeyDown={(e) => e.stopPropagation()} data-testid="email-body-editor" role="textbox" aria-multiline aria-label="Email body" />
        </div>
      )}
      <FieldError stepId={stepId} field="body" />
    </div>
  )
}

function HttpForm({ s, set }: { s: AnyStep; set(p: Record<string, unknown>, key?: string): void }) {
  const ro = useDesigner((st) => st.readOnly)
  const [sample, setSample] = useState(s.sample !== undefined ? JSON.stringify(s.sample, null, 2) : '')
  const [err, setErr] = useState<string | null>(null)
  return (
    <>
      <Section title="Request">
        <ConnectionRef stepId={s.id} field="auth" label="HTTP connection" kinds={['http']} required value={s.auth as string} onChange={(r) => set({ auth: r ?? '' })} />
        <Labeled label="Method"><select className={inputCls} value={(s.method as string) ?? 'GET'} disabled={ro} onChange={(e) => set({ method: e.target.value })} data-testid="f-method">{['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}</select></Labeled>
        <FxField stepId={s.id} field="url" label="Address" required value={s.url as string} onChange={(v) => set({ url: v }, `${s.id}:url`)} hint="An absolute address on one of the connection's allowed hosts, or a path relative to its base address." testId="f-url" />
        <Labeled label="Headers"><KeyValues stepId={s.id} field="headers" value={s.headers as Record<string, string>} onChange={(v) => set({ headers: Object.keys(v).length ? v : undefined })} keyLabel="Header name" /></Labeled>
        {s.method !== 'GET' && s.method !== 'DELETE' && <FxField stepId={s.id} field="body" label="Body" value={s.body as string} onChange={(v) => set({ body: v || undefined }, `${s.id}:body`)} formulaOnly placeholder="{number: Trigger.Record.Number}" hint="A record becomes JSON." />}
      </Section>
      <Section title="Sample response" hint="Paste a response body (JSON) to get its fields as dynamic content in later steps.">
        <textarea className="min-h-24 rounded-md border border-input bg-background p-2 font-mono text-xs" value={sample} readOnly={ro} placeholder='{"id": 12, "status": "open"}' data-testid="http-sample" onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            setSample(e.target.value)
            if (!e.target.value.trim()) { setErr(null); set({ sample: undefined }); return }
            try { set({ sample: JSON.parse(e.target.value) }, `${s.id}:sample`); setErr(null) } catch { setErr('Not valid JSON yet.') }
          }} />
        {err && <p className="text-[11px] text-destructive">{err}</p>}
      </Section>
    </>
  )
}

function ActionForm({ s, set }: { s: AnyStep; set(p: Record<string, unknown>, key?: string): void }) {
  const data = useDesignerData()
  const connections = useDesigner((st) => st.connections)
  const ro = useDesigner((st) => st.readOnly)
  const connId = connections[s.connection as string]
  useEffect(() => { if (connId) data.loadActions(connId) }, [connId, data])
  const acts = connId ? data.actions[connId] : undefined
  const act = acts?.find((a) => a.id === s.action)
  const conn = usePlatform((st) => st.connections).find((c) => c.id === connId)
  return (
    <>
      <Section title="Action">
        <ConnectionRef stepId={s.id} field="connection" label="Connection" kinds={conn ? [conn.connector] : ['http', 'email']} required value={s.connection as string} onChange={(r) => set({ connection: r ?? '' })} />
        <Labeled label="Action" required>
          <select className={inputCls} value={(s.action as string) ?? ''} disabled={ro || !acts} onChange={(e) => set({ action: e.target.value, inputs: {} })} data-testid="f-action">
            <option value="">{acts ? 'Choose an action' : 'Choose a connection first'}</option>
            {(acts ?? []).map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
          </select>
          {act?.description && <p className="text-[11px] text-muted-foreground">{act.description}</p>}
          <FieldError stepId={s.id} field="action" />
        </Labeled>
      </Section>
      <Section title="Inputs">
        <ActionInputs stepId={s.id} schema={(act?.inputs as Schema) ?? null} values={(s.inputs as Record<string, string>) ?? {}} onChange={(v) => set({ inputs: v }, `${s.id}:inputs`)} />
      </Section>
    </>
  )
}

function CallFlowForm({ s, set }: { s: AnyStep; set(p: Record<string, unknown>, key?: string): void }) {
  const data = useDesignerData()
  const flowId = useDesigner((st) => st.flowId)
  const ro = useDesigner((st) => st.readOnly)
  const manual = data.flows.filter((f) => f.trigger?.type === 'manual' && f.id !== flowId)
  const child = manual.find((f) => f.id === s.flow || f.name.toLowerCase() === String(s.flow ?? '').toLowerCase())
  const inputs: InputDef[] = child?.trigger?.type === 'manual' ? child.trigger.inputs : []
  const values = (s.inputs as Record<string, string>) ?? {}
  return (
    <>
      <Section title="Child flow" hint="Only flows started by hand (manual trigger) can be run from another flow.">
        <select className={inputCls} value={child?.name ?? ''} disabled={ro} onChange={(e) => set({ flow: e.target.value, inputs: {} })} data-testid="f-flow">
          <option value="">Choose a flow</option>
          {manual.map((f) => <option key={f.id} value={f.name}>{f.name}</option>)}
        </select>
        <FieldError stepId={s.id} field="flow" />
      </Section>
      {child && (
        <Section title="Its inputs">
          {!inputs.length && <p className="text-xs text-muted-foreground">This flow takes no inputs.</p>}
          {inputs.map((i) => (
            <FxField key={i.name} stepId={s.id} field={`inputs.${i.name}`} label={`${i.name} · ${i.type}`} required={i.required} hint={i.description}
              value={values[i.name]} onChange={(v) => { const n = { ...values }; if (v) n[i.name] = v; else delete n[i.name]; set({ inputs: n }, `${s.id}:in:${i.name}`) }}
              kind={i.type === 'number' ? 'number' : i.type === 'boolean' ? 'boolean' : i.type === 'date' ? 'date' : i.type === 'choice' ? 'choice' : 'text'} choices={i.choices} formulaOnly={i.type === 'record' || i.type === 'table' || i.type === 'datetime'} />
          ))}
        </Section>
      )}
    </>
  )
}

function RawStep({ s }: { s: AnyStep }) {
  const ro = useDesigner((st) => st.readOnly)
  const [text, setText] = useState(JSON.stringify(s, null, 2))
  const [err, setErr] = useState<string | null>(null)
  return (
    <Section title="Step definition" hint={`This designer does not know the step kind "${s.kind}" yet: edit it as JSON. Nothing in it is lost.`}>
      <textarea className="min-h-60 rounded-md border border-input bg-background p-2 font-mono text-xs" value={text} readOnly={ro} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => {
        setText(e.target.value)
        try {
          const v = JSON.parse(e.target.value)
          if (!v || typeof v !== 'object' || v.id !== s.id) throw new Error('Keep the id of the step.')
          setErr(null)
          patchStep(s.id, () => v as Step, `${s.id}:raw`)
        } catch (x) { setErr((x as Error).message) }
      }} />
      {err && <p className="text-[11px] text-destructive">{err}</p>}
    </Section>
  )
}

const STATUSES: RunAfterStatus[] = ['succeeded', 'failed', 'skipped', 'timedOut']
export const statusLabel = (w: string): string => (w === 'timedOut' ? 'timed out' : w)

/** run after: which earlier steps of the same list, with which outcomes */
export function RunAfterEditor({ id }: { id: string }) {
  const doc = useDesigner((st) => st.doc)
  const ro = useDesigner((st) => st.readOnly)
  const f = findStep(doc.steps, id)
  const siblings = useMemo(() => {
    if (!f) return []
    const list = f.slot.parent ? (findStep(doc.steps, f.slot.parent)?.step ? listOf(doc, f.slot) : []) : doc.steps
    return list.slice(0, f.index)
  }, [doc, f])
  if (!f) return null
  const ra = f.step.runAfter ?? []
  const prev = siblings[siblings.length - 1]
  const toggle = (stepId: string, w: RunAfterStatus, on: boolean) => {
    const cur = ra.length ? ra : prev ? [{ step: prev.id, when: ['succeeded' as RunAfterStatus] }] : []
    const e = cur.find((x) => x.step === stepId)
    const next = e ? cur.map((x) => (x.step === stepId ? { ...x, when: on ? [...x.when, w] : x.when.filter((y) => y !== w) } : x)) : [...cur, { step: stepId, when: [w] }]
    setRunAfter(id, next.filter((x) => x.when.length))
  }
  return (
    <div className="grid gap-2" data-testid="runafter-editor">
      {!siblings.length ? <p className="text-xs text-muted-foreground">This is the first step of its list: it runs when the list starts.</p> : (
        <>
          <p className="text-[11px] text-muted-foreground">{ra.length ? 'Runs when every ticked condition holds.' : `Default: after ${prev?.name} succeeded.`} Only earlier steps of the same list can be chosen.</p>
          <table className="text-xs">
            <thead><tr><th className="text-left font-medium">Step</th>{STATUSES.map((w) => <th key={w} className="px-1 font-medium">{statusLabel(w)}</th>)}</tr></thead>
            <tbody>
              {siblings.map((x) => {
                const e = (ra.length ? ra : prev ? [{ step: prev.id, when: ['succeeded'] }] : []).find((r) => r.step === x.id)
                return (
                  <tr key={x.id} className="border-t border-border">
                    <td className="py-1 pr-2">{x.name}</td>
                    {STATUSES.map((w) => <td key={w} className="text-center"><input type="checkbox" disabled={ro} aria-label={`${x.name} ${statusLabel(w)}`} data-testid={`ra-${x.name}-${w}`} checked={!!e?.when.includes(w)} onChange={(ev) => toggle(x.id, w, ev.target.checked)} /></td>)}
                  </tr>
                )
              })}
            </tbody>
          </table>
          {ra.length > 0 && !ro && <button type="button" className="w-fit text-xs text-primary hover:underline" onClick={() => setRunAfter(id, [])}>Back to the default</button>}
        </>
      )}
      <FieldError stepId={id} field="runAfter" />
    </div>
  )
}

function listOf(doc: { steps: Step[] }, slot: { parent: string; list: string }): Step[] {
  const p = findStep(doc.steps, slot.parent)?.step as AnyStep | undefined
  if (!p) return []
  if (slot.list.startsWith('case:')) return ((p.cases as { steps: Step[] }[])?.[Number(slot.list.slice(5))]?.steps) ?? []
  return (p[slot.list] as Step[]) ?? []
}

function AdvancedForm({ s, set }: { s: AnyStep; set(p: Record<string, unknown>, key?: string): void }) {
  const ro = useDesigner((st) => st.readOnly)
  const retry = (s.retry as RetryPolicy | undefined)
  const [note, setNoteText] = useState(s.description ?? '')
  useEffect(() => setNoteText(s.description ?? ''), [s.description])
  const external = ['http', 'action', 'email', 'approval', 'delay', 'callFlow', 'waitForCallback', 'notify', 'data.get', 'data.list', 'data.create', 'data.update', 'data.delete'].includes(s.kind)
  return (
    <>
      <Section title="Run after"><RunAfterEditor id={s.id} /></Section>
      {external && (
        <Section title="Retry policy" hint="Temporary failures (network, busy servers) are tried again; permanent ones fail at once. Default depends on the step kind.">
          <select className={inputCls} value={retry?.type ?? 'default'} disabled={ro} data-testid="f-retry" onChange={(e) => set({ retry: e.target.value === 'default' ? undefined : { type: e.target.value, ...(e.target.value === 'none' ? {} : { count: retry?.count ?? 3, intervalSeconds: retry?.intervalSeconds ?? 30 }) } })}>
            <option value="default">Default for this kind</option><option value="none">No retries</option><option value="fixed">Fixed interval</option><option value="exponential">Growing interval</option>
          </select>
          {retry && retry.type !== 'none' && (
            <div className="grid grid-cols-3 gap-2 text-xs">
              <Labeled label="Attempts"><input type="number" min={1} max={10} className={inputCls} value={retry.count ?? 3} readOnly={ro} onChange={(e) => set({ retry: { ...retry, count: Number(e.target.value) } })} /></Labeled>
              <Labeled label={retry.type === 'fixed' ? 'Every (s)' : 'First wait (s)'}><input type="number" min={1} className={inputCls} value={retry.intervalSeconds ?? 30} readOnly={ro} onChange={(e) => set({ retry: { ...retry, intervalSeconds: Number(e.target.value) } })} /></Labeled>
              {retry.type === 'exponential' && <Labeled label="Longest (s)"><input type="number" min={1} className={inputCls} value={retry.maxIntervalSeconds ?? ''} readOnly={ro} onChange={(e) => set({ retry: { ...retry, maxIntervalSeconds: e.target.value ? Number(e.target.value) : undefined } })} /></Labeled>}
            </div>
          )}
          <FieldError stepId={s.id} field="retry" />
        </Section>
      )}
      {s.kind !== 'until' && s.kind !== 'waitForCallback' && (
        <Section title="Time limit" hint={['approval', 'delay', 'callFlow'].includes(s.kind) ? 'After this long the step ends as "timed out": add a step that runs after it timed out to escalate.' : 'Calls to other systems are stopped after this long.'}>
          <DurationPicker minutes={s.timeoutMinutes as number} onChange={(m) => set({ timeoutMinutes: m })} testId="f-timeout" />
          <FieldError stepId={s.id} field="timeoutMinutes" />
        </Section>
      )}
      {s.kind === 'until' && <Section title="Time limit of the loop"><DurationPicker minutes={s.timeoutMinutes as number} onChange={(m) => set({ timeoutMinutes: m })} /></Section>}
      <Section title="Note" hint="For the people who read this flow later. Shown on the card.">
        <textarea className="min-h-16 rounded-md border border-input bg-background p-2 text-sm" value={note} readOnly={ro} data-testid="f-note" onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setNoteText(e.target.value)} onBlur={() => { if (note !== (s.description ?? '')) setNote(s.id, note) }} />
      </Section>
      <Section title="Identity"><p className="text-[11px] text-muted-foreground">Step id <code className="font-mono">{s.id}</code> (run after and run history use it). Formulas read it as <code className="font-mono">Steps.{s.name}</code>.</p></Section>
    </>
  )
}
