/**
 * Run history and run detail (kept when the visual designer replaces the JSON editor). Live: the list and the detail
 * refetch when the hub reports a change of the Flow runs system table (table:sys_flow_runs).
 */
import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, RefreshCw, RotateCcw, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useLiveTopic } from '@/platform/useLive'
import type { FlowRunDetail, FlowRunInfo, FlowStepRun, RunStatus, StepStatus } from '@/platform/flows'
import { Panel, errMsg, fmtDate, useToast } from '@/portal/kit'
import { flowsApi } from './api'

const LIVE_TOPIC = 'table:sys_flow_runs'

export function StatusBadge({ status }: { status: RunStatus | StepStatus | string }) {
  const tone = status === 'succeeded' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
    : status === 'failed' || status === 'timedOut' ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'
      : status === 'running' || status === 'queued' ? 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300'
        : status === 'waiting' ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
          : 'bg-muted text-muted-foreground'
  return <span data-testid="run-status" className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{status}</span>
}

const dur = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${ms} ms` : ms < 120_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`)

/** runs of one flow (or of every flow the user may see), newest first, live */
export function RunHistory({ flowId, onOpen }: { flowId?: string; onOpen(runId: string): void }) {
  const [items, setItems] = useState<FlowRunInfo[] | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => {
    flowsApi.runs({ flowId, status: status || undefined, limit: 100 }).then((r) => { setItems(r.items); setError(null) }).catch((e) => setError(errMsg(e)))
  }, [flowId, status])
  useEffect(load, [load])
  useLiveTopic(LIVE_TOPIC, () => load())
  return (
    <Panel className="p-3">
      <div className="mb-2 flex items-center gap-2">
        <select aria-label="Status" className="h-8 rounded-md border border-border bg-background px-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'timedOut'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <Button size="sm" variant="ghost" onClick={load}><RefreshCw className="size-4" />Refresh</Button>
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>
      {items === null ? <p className="p-3 text-sm text-muted-foreground">Loading runs...</p> : items.length === 0 ? <p className="p-3 text-sm text-muted-foreground">No runs yet.</p> : (
        <table className="w-full text-sm" data-testid="run-list">
          <thead className="text-left text-xs text-muted-foreground"><tr><th className="p-2">Status</th>{!flowId && <th className="p-2">Flow</th>}<th className="p-2">Started</th><th className="p-2">Trigger</th><th className="p-2">Duration</th><th className="p-2">Error</th><th /></tr></thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id} className="cursor-pointer border-t border-border hover:bg-accent/40" onClick={() => onOpen(r.id)} data-testid="run-row">
                <td className="p-2"><StatusBadge status={r.status} />{r.mode === 'test' && <Badge variant="outline" className="ml-1">test{r.dryRun ? ', simulated' : ''}</Badge>}</td>
                {!flowId && <td className="p-2">{r.flowName}</td>}
                <td className="p-2 whitespace-nowrap">{fmtDate(r.startedOn ?? r.createdOn)}</td>
                <td className="p-2 text-muted-foreground">{r.triggerSummary ?? r.triggerKind}</td>
                <td className="p-2 whitespace-nowrap">{dur(r.durationMs)}</td>
                <td className="max-w-[24rem] truncate p-2 text-destructive">{r.error?.message ?? ''}</td>
                <td className="p-2"><ChevronRight className="size-4 text-muted-foreground" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  )
}

function Json({ value }: { value: unknown }) {
  return <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs">{JSON.stringify(value, null, 2)}</pre>
}

function StepRow({ s }: { s: FlowStepRun }) {
  const [open, setOpen] = useState(s.status === 'failed')
  const depth = s.key.split('/').length - 2
  return (
    <div className="border-t border-border" data-testid="run-step">
      <button type="button" className="flex w-full items-center gap-2 p-2 text-left text-sm hover:bg-accent/40" style={{ paddingLeft: 8 + depth * 18 }} onClick={() => setOpen(!open)}>
        <ChevronRight className={`size-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <StatusBadge status={s.status} />
        <span className="font-medium">{s.name}</span>
        <span className="text-xs text-muted-foreground">{s.kind}{s.attempt > 1 ? `, attempt ${s.attempt}` : ''}{s.simulated ? ', simulated' : ''}</span>
        <span className="ml-auto text-xs text-muted-foreground">{dur(s.durationMs)}</span>
      </button>
      {open && (
        <div className="grid gap-2 px-3 pb-3 md:grid-cols-2" style={{ paddingLeft: 26 + depth * 18 }}>
          {s.error && <div className="md:col-span-2 text-sm text-destructive">{s.error.message}</div>}
          <div><div className="mb-1 text-xs font-semibold text-muted-foreground">Input</div><Json value={s.input ?? null} /></div>
          <div><div className="mb-1 text-xs font-semibold text-muted-foreground">Output</div><Json value={s.output ?? null} /></div>
        </div>
      )}
    </div>
  )
}

/** one run: steps as a timeline with their inputs and outputs, cancel and resubmit */
export function RunDetail({ runId, onOpen, canManage }: { runId: string; onOpen(runId: string): void; canManage: boolean }) {
  const [run, setRun] = useState<FlowRunDetail | null>(null)
  const [summaryOnly, setSummaryOnly] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { toast } = useToast()
  const load = useCallback(() => {
    flowsApi.runDetail(runId).then((r) => { setRun(r.run); setSummaryOnly(!!r.summaryOnly); setError(null) }).catch((e) => setError(errMsg(e)))
  }, [runId])
  useEffect(load, [load])
  useLiveTopic(LIVE_TOPIC, () => load())
  if (error) return <Panel className="p-4 text-sm text-destructive">{error}</Panel>
  if (!run) return <Panel className="p-4 text-sm text-muted-foreground">Loading the run...</Panel>
  const active = ['queued', 'running', 'waiting'].includes(run.status)
  const act = (p: Promise<unknown>, done: string) => p.then(() => { toast(done, 'success'); load() }).catch((e) => toast(errMsg(e), 'error'))
  return (
    <Panel className="p-3" data-testid="run-detail">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <StatusBadge status={run.status} />
        <span className="font-semibold">{run.flowName}</span>
        <span className="text-xs text-muted-foreground">version {run.flowVersion} · {run.triggerSummary ?? run.triggerKind} · runs as {run.runAsName ?? run.runAs} · {run.id}</span>
        <span className="ml-auto flex gap-2">
          {canManage && active && <Button size="sm" variant="outline" onClick={() => act(flowsApi.cancel(run.id), 'The run was cancelled.')}><Square className="size-4" />Cancel</Button>}
          {canManage && !active && <Button size="sm" variant="outline" onClick={() => flowsApi.resubmit(run.id, 'start').then((r) => onOpen(r.runId)).catch((e) => toast(errMsg(e), 'error'))}><RotateCcw className="size-4" />Run again</Button>}
          {canManage && (run.status === 'failed' || run.status === 'timedOut') && <Button size="sm" variant="outline" onClick={() => flowsApi.resubmit(run.id, 'failed').then((r) => onOpen(r.runId)).catch((e) => toast(errMsg(e), 'error'))}><RotateCcw className="size-4" />Run again from the failed step</Button>}
        </span>
      </div>
      {run.error && <p className="mb-2 text-sm text-destructive">{run.error.message}</p>}
      {summaryOnly ? <p className="text-sm text-muted-foreground">You started this run. Its steps and the data it read are shown to the flow's owner and administrators.</p> : (
        <>
          {run.response !== undefined && <div className="mb-2"><div className="mb-1 text-xs font-semibold text-muted-foreground">Response</div><Json value={run.response} /></div>}
          <details className="mb-2"><summary className="cursor-pointer text-xs font-semibold text-muted-foreground">Trigger and variables</summary><Json value={{ trigger: run.trigger, variables: run.variables }} /></details>
          <div className="rounded-md border border-border">
            {run.steps.filter((s) => s.kind !== 'iteration').map((s) => <StepRow key={s.key} s={s} />)}
            {!run.steps.length && <p className="p-2 text-sm text-muted-foreground">No steps ran yet.</p>}
          </div>
          {run.waits.some((w) => w.state === 'waiting') && (
            <p className="mt-2 text-xs text-muted-foreground">Waiting: {run.waits.filter((w) => w.state === 'waiting').map((w) => `${w.kind}${w.wakeAt ? ` until ${fmtDate(w.wakeAt)}` : ''}${w.timeoutAt ? ` (times out ${fmtDate(w.timeoutAt)})` : ''}`).join(', ')}</p>
          )}
        </>
      )}
    </Panel>
  )
}
