/**
 * The visual flow designer (P1 package B; docs/dev/flows.md "Designer"). Replaces the JSON editor with the same props.
 *
 * Edits are kept as the flow's **draft** on the server (PUT /flows/:id/draft, saved a moment after each change);
 * **Publish** saves the draft as a new version, which becomes the running definition. Problems come from the server's
 * validator (POST /flows/validate) as you edit, listed under the canvas and next to each field; publishing is refused
 * while there are errors. The soft edit lock is the Studio's (live hub, `studio:<flowId>`): the first maker edits, others
 * see the flow read-only and may take over; a locked production environment is read-only. "Advanced: definition" shows
 * the definition as JSON, both ways.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Eye, FlaskConical, Lock, Redo2, Search, Settings2, Undo2, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/platform'
import { useLiveTopic } from '@/platform/useLive'
import type { FlowDef, ValidationProblem } from '@/platform/flows'
import { errMsg, fmtDate, fmtRelative, useToast } from '@/portal/kit'
import { useStudioLive, useStudioLock, takeOver } from '@/studio/live'
import { useEnvironmentLocked } from '@/studio/Studio'
import { flowsApi, type FlowError, type FlowInput } from '../api'
import { useDesigner, selectedIds } from './store'
import { DesignerDataProvider, useDesignerData } from './context'
import { Canvas } from './Canvas'
import { StepPicker } from './StepPicker'
import { StepPanel, RunAfterEditor } from './StepPanel'
import { TriggerPanel, triggerSummary, triggerTitle } from './TriggerPanel'
import { SettingsPanel } from './SettingsPanel'
import { TestDialog } from './TestDialog'
import { findStep, type FlowDoc, type Slot } from './model'
import { rename, setNote } from './actions'
import { StatusBadge } from '../RunViews'
import { fmtDuration } from './overlay'

export interface FlowEditorProps {
  /** the flow (absent: a new one) */
  flowId?: string
  initial: Record<string, unknown>
  readOnly?: boolean
  onSaved(flow: FlowDef): void
  onCancel?(): void
  /** a test run started (the designer shows it on the canvas too) */
  onTested?(runId: string): void
  /** a run to show on the canvas when the designer opens */
  showRun?: string | null
}

/** the editable document and connection map from the page's `initial` (editable(flow)) */
function split(initial: Record<string, unknown>): { doc: FlowDoc; connections: Record<string, string> } {
  const { connections, ...doc } = initial as Record<string, unknown> & { connections?: Record<string, string> }
  return { doc: doc as FlowDoc, connections: connections ?? {} }
}

export function FlowDesigner(props: FlowEditorProps) {
  return (
    <DesignerDataProvider>
      <DesignerBody {...props} />
    </DesignerDataProvider>
  )
}

function DesignerBody({ flowId, initial, readOnly: roProp, onSaved, onCancel, onTested, showRun }: FlowEditorProps) {
  const { toast } = useToast()
  const data = useDesignerData()
  const envLocked = useEnvironmentLocked()
  const mode = usePlatform((s) => s.mode)
  const lock = useStudioLock(flowId ?? '__new_flow', envLocked || !!roProp || !flowId)
  const holder = useStudioLive((s) => s.holder)
  const readOnly = !!roProp || envLocked || (!!flowId && mode === 'server' && lock !== 'edit')
  const roRef = useRef(readOnly)
  roRef.current = readOnly
  const [ready, setReady] = useState(false)
  const [draftInfo, setDraftInfo] = useState<{ savedOn: string; savedByName?: string; baseVersion: number } | null>(null)
  const publishedVersion = Number((initial as { version?: number }).version) || 0
  const published = useMemo(() => split(initial), [initial])

  // load: the draft when there is one, else the published definition
  useEffect(() => {
    let alive = true
    const st = useDesigner.getState()
    const start = (doc: FlowDoc, connections: Record<string, string>, unpublished: boolean) => { if (alive) { st.reset({ flowId: flowId ?? null, doc, connections, readOnly: roRef.current, unpublished }); setReady(true) } }
    if (!flowId) { start(published.doc, published.connections, true); return }
    flowsApi.draft(flowId).then((r) => {
      if (r.draft) { setDraftInfo(r.draft); start({ ...published.doc, ...(r.draft.doc as FlowDoc) }, r.draft.connections, true) }
      else { setDraftInfo(null); start(published.doc, published.connections, false) }
    }).catch(() => start(published.doc, published.connections, false))
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId, initial])
  useEffect(() => { useDesigner.getState().set({ readOnly }) }, [readOnly])
  // when the edit lock comes back to us, follow the latest draft
  const prevLock = useRef(lock)
  useEffect(() => {
    if (prevLock.current !== 'edit' && lock === 'edit' && flowId && ready) {
      flowsApi.draft(flowId).then((r) => { if (r.draft) useDesigner.getState().set({ doc: { ...published.doc, ...(r.draft.doc as FlowDoc) }, connections: r.draft.connections, unpublished: true }) }).catch(() => undefined)
    }
    prevLock.current = lock
  }, [lock, flowId, ready, published.doc])

  const doc = useDesigner((s) => s.doc)
  const connections = useDesigner((s) => s.connections)
  const dirty = useDesigner((s) => s.dirty)
  const problems = useDesigner((s) => s.problems)
  const selection = useDesigner((s) => s.selection)
  const picker = useDesigner((s) => s.picker)
  const dialog = useDesigner((s) => s.dialog)
  const unpublished = useDesigner((s) => s.unpublished)
  const draftState = useDesigner((s) => s.draftState)
  const notes = useDesigner((s) => s.notes)
  const run = useDesigner((s) => s.run)
  const past = useDesigner((s) => s.past.length)
  const future = useDesigner((s) => s.future.length)
  const search = useDesigner((s) => s.search)
  const draftError = useDesigner((s) => s.draftError)

  // load the actions of attached connections (output schemas for dynamic content)
  useEffect(() => { for (const id of Object.values(connections)) data.loadActions(id) }, [connections, data])

  // validation (server), debounced
  useEffect(() => {
    if (!ready) return
    const h = setTimeout(() => {
      useDesigner.getState().set({ validating: true })
      flowsApi.validate({ ...(doc as FlowInput), connections, ...(flowId ? { id: flowId } : {}) })
        .then((r) => useDesigner.getState().set({ problems: r.problems, validating: false }))
        .catch(() => useDesigner.getState().set({ validating: false }))
    }, 500)
    return () => clearTimeout(h)
  }, [doc, connections, flowId, ready])

  // the draft, saved a moment after each change
  useEffect(() => {
    if (!ready || !flowId || !dirty || readOnly) return
    const h = setTimeout(() => {
      const st = useDesigner.getState()
      st.set({ draftState: 'saving' })
      flowsApi.saveDraft(flowId, st.doc, st.connections, publishedVersion)
        .then((r) => { useDesigner.getState().set({ draftState: 'saved', draftError: null, dirty: false }); setDraftInfo(r.draft) })
        .catch((e) => useDesigner.getState().set({ draftState: 'error', draftError: errMsg(e) }))
    }, 800)
    return () => clearTimeout(h)
  }, [doc, connections, dirty, flowId, ready, readOnly, publishedVersion])

  /* ---------------------------------------------------------------- runs on the canvas */
  const loadRun = useCallback((runId: string) => {
    flowsApi.runDetail(runId).then((r) => useDesigner.getState().set({ run: r.run })).catch((e) => toast(errMsg(e), 'error'))
  }, [toast])
  useEffect(() => { if (showRun && ready) loadRun(showRun) }, [showRun, ready, loadRun])
  useLiveTopic('table:sys_flow_runs', () => { const r = useDesigner.getState().run; if (r) loadRun(r.id) })
  useEffect(() => {
    if (!run || !['queued', 'running', 'waiting'].includes(run.status)) return
    const h = setInterval(() => loadRun(run.id), 2500)
    return () => clearInterval(h)
  }, [run, loadRun])

  /* ---------------------------------------------------------------- publish, discard */
  const errors = problems.filter((p) => p.severity === 'error')
  const [busy, setBusy] = useState(false)
  const publish = async (confirmRunAs = false): Promise<void> => {
    const st = useDesigner.getState()
    setBusy(true)
    try {
      const body = { ...(st.doc as FlowInput), connections: st.connections, ...(confirmRunAs ? { confirmRunAs } : {}) }
      const r = flowId ? await flowsApi.save(flowId, body) : await flowsApi.create(body)
      useDesigner.getState().set({ problems: r.problems, unpublished: false, dirty: false, draftState: 'none' })
      setDraftInfo(null)
      toast(`Published as version ${r.flow.version}.`, 'success')
      onSaved(r.flow)
    } catch (e) {
      const fe = e as FlowError
      if (fe.status === 409 && fe.field === 'confirmRunAs') {
        setBusy(false)
        if (confirm(`${errMsg(e)}\n\nPublish with this identity?`)) return publish(true)
        return
      }
      if (fe.problems) useDesigner.getState().set({ problems: fe.problems })
      toast(errMsg(e), 'error')
    } finally { setBusy(false) }
  }
  const discard = () => {
    if (!flowId || !confirm('Discard the unpublished changes and go back to the published version?')) return
    flowsApi.discardDraft(flowId).then(() => {
      useDesigner.getState().reset({ flowId, doc: published.doc, connections: published.connections, readOnly: roRef.current, unpublished: false })
      setDraftInfo(null)
      toast('Changes discarded.', 'success')
    }).catch((e) => toast(errMsg(e), 'error'))
  }

  /* ---------------------------------------------------------------- picker, panels */
  const openPicker = (slot: Slot, index: number) => { if (!useDesigner.getState().readOnly) useDesigner.getState().set({ picker: { slot, index } }) }
  const problemCount = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of problems) if (p.severity === 'error') m.set(p.step || '', (m.get(p.step || '') ?? 0) + 1)
    return m
  }, [problems])
  const focusProblem = (p: ValidationProblem) => {
    const st = useDesigner.getState()
    if (p.step === 'trigger') st.set({ selection: { kind: 'trigger' }, focus: 'trigger' })
    else if (!p.step) st.set({ selection: { kind: 'settings', tab: p.field.startsWith('variables') ? 'variables' : p.field === 'connections' ? 'connections' : 'general' } })
    else {
      // expand collapsed containers on the way
      const f = findStep(st.doc.steps, p.step)
      for (const a of f?.ancestors ?? []) st.toggleCollapsed(a, false)
      st.set({ selection: { kind: 'steps', ids: [p.step] }, focus: p.step })
    }
    st.set({ focusField: { step: p.step, field: p.field, at: Date.now() } })
  }
  const [tab, setTab] = useState<'designer' | 'json'>('designer')
  const [showProblems, setShowProblems] = useState(true)
  const [testing, setTesting] = useState(false)
  const sel = selectedIds(selection)
  const panel = selection?.kind === 'trigger' ? <TriggerPanel /> : selection?.kind === 'settings' ? <SettingsPanel tab={selection.tab} /> : sel.length === 1 ? <StepPanel key={sel[0]} id={sel[0]} /> : sel.length > 1 ? (
    <div className="p-4 text-sm"><p className="font-medium">{sel.length} steps selected</p><p className="mt-1 text-xs text-muted-foreground">Drag them to move them together; Ctrl+C copies, Ctrl+D duplicates, Delete removes them.</p></div>
  ) : (
    <div className="grid gap-2 p-4 text-sm text-muted-foreground" data-testid="panel-empty">
      <p className="font-medium text-foreground">Select a step to set it up.</p>
      <p className="text-xs">Click + between steps to add one. Drag a step to move it. Arrow keys move between steps; Enter opens one.</p>
      <Button size="sm" variant="outline" className="w-fit" onClick={() => useDesigner.getState().set({ selection: { kind: 'settings' } })} data-testid="open-settings"><Settings2 className="size-4" />Flow settings</Button>
    </div>
  )
  const triggerDocs = data.catalog?.triggers ?? []
  if (!ready) return <p className="p-4 text-sm text-muted-foreground">Loading the designer…</p>
  return (
    <div className="flex h-[calc(100vh-210px)] min-h-[560px] flex-col overflow-hidden rounded-lg border border-border bg-card" data-testid="flow-designer" data-readonly={readOnly || undefined}>
      {/* banners: locked environment, someone else editing */}
      {envLocked && <div className="flex items-center gap-2 border-b border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-800 dark:text-rose-200" role="status" data-testid="designer-locked"><Lock className="size-3.5" /><span><b>Read-only.</b> This production environment is locked: flows change only by deploying a solution into it.</span></div>}
      {!envLocked && !roProp && flowId && mode === 'server' && lock === 'readonly' && (
        <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs" role="status" data-testid="designer-readonly">
          <Eye className="size-3.5" /><span><b>Read-only.</b> {holder?.name ?? 'Another maker'} is editing this flow.</span>
          <Button size="sm" variant="outline" className="ml-auto h-6 text-xs" onClick={() => void takeOver(flowId)}>Take over editing</Button>
        </div>
      )}
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
        <div className="mr-2 flex rounded-md border border-border p-0.5 text-xs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'designer'} className={cn('rounded px-2 py-0.5', tab === 'designer' && 'bg-accent font-medium')} onClick={() => setTab('designer')} data-testid="tab-designer">Designer</button>
          <button type="button" role="tab" aria-selected={tab === 'json'} className={cn('rounded px-2 py-0.5', tab === 'json' && 'bg-accent font-medium')} onClick={() => setTab('json')} data-testid="tab-json">Advanced: definition</button>
        </div>
        <Button size="icon" variant="ghost" className="size-7" disabled={readOnly || !past} onClick={() => useDesigner.getState().undo()} aria-label="Undo" title="Undo (Ctrl+Z)" data-testid="undo"><Undo2 className="size-4" /></Button>
        <Button size="icon" variant="ghost" className="size-7" disabled={readOnly || !future} onClick={() => useDesigner.getState().redo()} aria-label="Redo" title="Redo (Ctrl+Y)" data-testid="redo"><Redo2 className="size-4" /></Button>
        <div className="relative ml-1">
          <Search className="absolute left-1.5 top-1.5 size-3.5 text-muted-foreground" />
          <input className="h-7 w-44 rounded-md border border-border bg-background pl-6 pr-2 text-xs" placeholder="Search steps (Ctrl+F)" data-testid="flow-search" aria-label="Search steps"
            value={search} onChange={(e) => useDesigner.getState().set({ search: e.target.value })} onKeyDown={(e) => { if (e.key === 'Escape') useDesigner.getState().set({ search: '' }) }} />
        </div>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => useDesigner.getState().set({ selection: { kind: 'settings' } })} data-testid="toolbar-settings"><Settings2 className="size-4" />Settings</Button>
        <span className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground" data-testid="draft-state" data-state={draftState} data-unpublished={unpublished || undefined}>
          {readOnly ? 'Read-only' : !flowId ? 'Not created yet' : draftState === 'saving' ? 'Saving draft…' : draftState === 'error' ? <span className="text-destructive" title={draftError ?? ''}>Draft not saved: {draftError}</span> : unpublished ? `Unpublished changes${draftInfo ? ` · draft saved ${fmtRelative(draftInfo.savedOn)}` : ''}` : 'Published'}
        </span>
        {flowId && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setTesting(true)} data-testid="designer-test"><FlaskConical className="size-4" />Test</Button>}
        {flowId && unpublished && !readOnly && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={discard} data-testid="discard-draft">Discard</Button>}
        {onCancel && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel}>Close</Button>}
        {!readOnly && <Button size="sm" className="h-7 text-xs" disabled={busy || errors.length > 0 || (!!flowId && !unpublished)} title={errors.length ? `Fix ${errors.length} problem${errors.length === 1 ? '' : 's'} first` : undefined} onClick={() => publish()} data-testid="publish"><Upload className="size-4" />{flowId ? 'Publish' : 'Create'}</Button>}
      </div>
      {/* run banner */}
      {run && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-1 text-xs" data-testid="run-banner">
          <span className="font-medium">Run on the canvas:</span><StatusBadge status={run.status} />
          {run.mode === 'test' && <span className="rounded bg-amber-500/15 px-1 text-amber-800 dark:text-amber-300">test{run.dryRun ? ', side effects simulated' : ', for real'}</span>}
          <span className="text-muted-foreground">{fmtDate(run.startedOn ?? run.createdOn)} · {run.triggerSummary}{run.durationMs !== undefined ? ` · ${fmtDuration(run.durationMs)}` : ''}</span>
          {run.error && <span className="text-destructive">{run.error.message}</span>}
          <RunPicker />
          <Button size="sm" variant="ghost" className="ml-auto h-6 text-xs" onClick={() => useDesigner.getState().set({ run: null, iteration: {} })} data-testid="run-close"><X className="size-3.5" />Hide</Button>
        </div>
      )}
      {tab === 'json' ? <JsonTab /> : (
        <div className="flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1">
            <Canvas onOpenPicker={openPicker} triggerTitle={triggerTitle(doc.trigger, triggerDocs)} triggerSummary={triggerSummary(doc.trigger)} triggerType={doc.trigger?.type ?? ''} problemCount={problemCount}
              onResubmit={run ? (stepId) => flowsApi.resubmit(run.id, 'failed').then((r) => { toast(`Run again from ${findStep(doc.steps, stepId)?.step.name ?? 'the failed step'}: the steps that succeeded are not repeated.`, 'success'); loadRun(r.runId) }).catch((e) => toast(errMsg(e), 'error')) : undefined} />
            {!run && flowId && <div className="absolute left-3 top-3"><RunPicker /></div>}
            {notes.length > 0 && (
              <div className="absolute left-1/2 top-3 z-10 max-w-md -translate-x-1/2 rounded-md border border-amber-500/40 bg-card px-3 py-2 text-xs shadow-md" role="status" data-testid="designer-notes">
                {notes.map((n, i) => <p key={i}>{n}</p>)}
                <button type="button" className="mt-1 text-primary hover:underline" onClick={() => useDesigner.getState().set({ notes: [] })}>OK</button>
              </div>
            )}
          </div>
          <aside className="w-[400px] shrink-0 border-l border-border" data-testid="designer-panel">{panel}</aside>
        </div>
      )}
      {/* problems */}
      <div className="border-t border-border text-xs" data-testid="flow-problems">
        <button type="button" className="flex w-full items-center gap-2 px-3 py-1 text-left" onClick={() => setShowProblems(!showProblems)}>
          {errors.length ? <AlertTriangle className="size-3.5 text-destructive" /> : <CheckCircle2 className="size-3.5 text-emerald-600" />}
          <span className={errors.length ? 'font-medium text-destructive' : ''} data-testid="problem-count">{errors.length ? `${errors.length} problem${errors.length === 1 ? '' : 's'}` : 'No problems'}</span>
          {problems.length > errors.length && <span className="text-amber-700 dark:text-amber-400">{problems.length - errors.length} warning{problems.length - errors.length === 1 ? '' : 's'}</span>}
          {errors.length > 0 && !readOnly && <span className="text-muted-foreground">· publishing and turning on wait until they are fixed</span>}
          <span className="ml-auto">{showProblems ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}</span>
        </button>
        {showProblems && problems.length > 0 && (
          <ul className="max-h-28 overflow-auto border-t border-border">
            {problems.map((p, i) => (
              <li key={i}>
                <button type="button" className="flex w-full gap-2 px-3 py-0.5 text-left hover:bg-accent" onClick={() => focusProblem(p)} data-testid="problem-item">
                  <span className={p.severity === 'error' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400'}>{p.severity === 'error' ? 'Error' : 'Warning'}</span>
                  <span className="font-medium">{p.step === 'trigger' ? 'Trigger' : p.step ? findStep(doc.steps, p.step)?.step.name ?? p.step : 'Flow'}{p.field ? ` · ${p.field}` : ''}</span>
                  <span className="min-w-0 truncate text-muted-foreground">{p.message}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <StepPicker open={!!picker} slot={picker?.slot ?? null} index={picker?.index ?? 0} onClose={() => useDesigner.getState().set({ picker: null })} />
      <TestDialog open={testing} onClose={() => setTesting(false)} onStarted={(runId) => { loadRun(runId); onTested?.(runId) }} />
      <StepDialog dialog={dialog} />
    </div>
  )
}

/** pick a recent run to show on the canvas */
function RunPicker() {
  const flowId = useDesigner((s) => s.flowId)
  const run = useDesigner((s) => s.run)
  const [items, setItems] = useState<{ id: string; label: string }[]>([])
  const load = () => { if (flowId) flowsApi.runs({ flowId, limit: 25 }).then((r) => setItems(r.items.map((x) => ({ id: x.id, label: `${fmtDate(x.createdOn)} · ${x.status}${x.mode === 'test' ? ' (test)' : ''}` })))).catch(() => setItems([])) }
  return (
    <select className="h-6 rounded border border-border bg-background px-1 text-[11px]" value={run?.id ?? ''} onFocus={load} onMouseDown={load} data-testid="run-picker" aria-label="Show a run on the canvas"
      onChange={(e) => { if (e.target.value) flowsApi.runDetail(e.target.value).then((r) => useDesigner.getState().set({ run: r.run, iteration: {} })).catch(() => undefined) }}>
      <option value="">{run ? 'Another run…' : 'Show a run on the canvas…'}</option>
      {items.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
    </select>
  )
}

/** the definition as JSON (both ways): edits that parse become one undo step */
function JsonTab() {
  const doc = useDesigner((s) => s.doc)
  const connections = useDesigner((s) => s.connections)
  const ro = useDesigner((s) => s.readOnly)
  const shown = useMemo(() => JSON.stringify({ ...doc, connections }, null, 2), [doc, connections])
  const [text, setText] = useState(shown)
  const [err, setErr] = useState<string | null>(null)
  const mine = useRef(false)
  useEffect(() => { if (!mine.current) setText(shown); mine.current = false }, [shown])
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 p-2">
      <p className="text-[11px] text-muted-foreground">The flow definition (the reference of every field: docs/reference/flows.md). Changes here show on the canvas, and the other way round.</p>
      <textarea className="min-h-0 flex-1 rounded-md border border-input bg-background p-2 font-mono text-xs" spellCheck={false} value={text} readOnly={ro} data-testid="flow-json" aria-label="Flow definition (JSON)"
        onChange={(e) => {
          setText(e.target.value)
          try {
            const v = JSON.parse(e.target.value)
            if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('The definition must be a JSON object.')
            if (!Array.isArray(v.steps)) throw new Error('steps must be a list.')
            const { connections: c, ...d } = v
            setErr(null)
            mine.current = true
            useDesigner.getState().edit(() => ({ doc: d as FlowDoc, connections: (c && typeof c === 'object' ? c : {}) as Record<string, string> }), 'json')
          } catch (x) { setErr(`Not applied: ${(x as Error).message}`) }
        }} />
      {err && <p className="text-[11px] text-destructive" data-testid="json-error">{err}</p>}
    </div>
  )
}

function StepDialog({ dialog }: { dialog: { kind: 'rename' | 'note' | 'runAfter'; id: string } | null }) {
  const doc = useDesigner((s) => s.doc)
  const step = dialog ? findStep(doc.steps, dialog.id)?.step : undefined
  const [v, setV] = useState('')
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { setErr(null); setV(dialog?.kind === 'rename' ? step?.name ?? '' : dialog?.kind === 'note' ? step?.description ?? '' : '') }, [dialog, step?.name, step?.description])
  const close = () => useDesigner.getState().set({ dialog: null })
  if (!dialog || !step) return null
  return (
    <Dialog open onOpenChange={(o) => { if (!o) close() }}>
      <DialogContent className="sm:max-w-lg" data-testid={`dialog-${dialog.kind}`}>
        <DialogHeader><DialogTitle>{dialog.kind === 'rename' ? `Rename ${step.name}` : dialog.kind === 'note' ? `Note on ${step.name}` : `Run ${step.name} after…`}</DialogTitle></DialogHeader>
        {dialog.kind === 'runAfter' ? <RunAfterEditor id={dialog.id} /> : dialog.kind === 'rename' ? (
          <div className="grid gap-1">
            <input autoFocus className="h-8 rounded-md border border-input bg-background px-2 text-sm" value={v} onChange={(e) => setV(e.target.value)} data-testid="rename-input" onKeyDown={(e) => { if (e.key === 'Enter') { const r = rename(dialog.id, v); if (r) setErr(r); else close() } }} />
            <p className="text-[11px] text-muted-foreground">Formulas that read Steps.{step.name} are updated.</p>
            {err && <p className="text-[11px] text-destructive">{err}</p>}
          </div>
        ) : <textarea autoFocus className="min-h-24 rounded-md border border-input bg-background p-2 text-sm" value={v} onChange={(e) => setV(e.target.value)} data-testid="note-input" />}
        <DialogFooter>
          <Button variant="ghost" onClick={close}>{dialog.kind === 'runAfter' ? 'Done' : 'Cancel'}</Button>
          {dialog.kind !== 'runAfter' && <Button data-testid="dialog-ok" onClick={() => { if (dialog.kind === 'rename') { const r = rename(dialog.id, v); if (r) { setErr(r); return } } else setNote(dialog.id, v); close() }}>Save</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
