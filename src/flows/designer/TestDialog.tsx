/**
 * "Test": runs the definition on the canvas (the draft) with a sample trigger: a recent real trigger from the run history,
 * an existing record of the trigger's table, or values filled in a form (manual inputs, a web request body). Dry run by
 * default (data changes, messages, calls and approvals are simulated and marked); "run for real" asks first.
 */
import { useEffect, useMemo, useState } from 'react'
import { FlaskConical, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { platform } from '@/platform'
import type { FlowRunInfo, InputDef, Step } from '@/platform/flows'
import { errMsg, fmtDate } from '@/portal/kit'
import { lookupSearchPlan } from '@/portal/cells'
import { flowsApi, type FlowError } from '../api'
import { useDesigner } from './store'
import { useDesignerData } from './context'
import { tableByName } from './dynamic'
import { inputCls, Labeled } from './fields'
import { walk } from './model'

type Source = 'recent' | 'record' | 'form'

export function TestDialog({ open, onClose, onStarted }: { open: boolean; onClose(): void; onStarted(runId: string): void }) {
  const flowId = useDesigner((s) => s.flowId)
  const doc = useDesigner((s) => s.doc)
  const data = useDesignerData()
  const t = doc.trigger as { type: string; table?: string; inputs?: InputDef[]; sample?: unknown }
  const table = t.type === 'table' ? tableByName(data.tables, t.table) : undefined
  const [source, setSource] = useState<Source>(t.type === 'table' ? 'record' : 'form')
  const [runs, setRuns] = useState<FlowRunInfo[]>([])
  const [recent, setRecent] = useState('')
  const [rowId, setRowId] = useState('')
  const [rowSearch, setRowSearch] = useState('')
  const [rows, setRows] = useState<{ id: string; label: string }[]>([])
  const [op, setOp] = useState('create')
  const [form, setForm] = useState<Record<string, string>>({})
  const [body, setBody] = useState(t.sample !== undefined ? JSON.stringify(t.sample, null, 2) : '{}')
  const [real, setReal] = useState(false)
  const [outcome, setOutcome] = useState('Approve')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const hasApproval = useMemo(() => { let x = false; walk(doc.steps, (s: Step) => { if (s.kind === 'approval') x = true }); return x }, [doc.steps])
  useEffect(() => {
    if (!open || !flowId) return
    setErr(null)
    flowsApi.runs({ flowId, limit: 20 }).then((r) => setRuns(r.items.filter((x) => x.mode === 'normal'))).catch(() => setRuns([]))
  }, [open, flowId])
  useEffect(() => {
    if (!open || !table) return
    let alive = true
    const h = setTimeout(() => {
      platform.tables.query(lookupSearchPlan(table, rowSearch)).then((st) => { if (alive) setRows(st.rows.map((r) => ({ id: String(r.__id ?? r.id), label: String(r[table.primaryColumn] ?? '(blank)') }))) }).catch(() => setRows([]))
    }, 200)
    return () => { alive = false; clearTimeout(h) }
  }, [open, table, rowSearch])

  const go = async () => {
    if (!flowId) return
    if (real && !confirm('Run for real? Data changes, messages, web calls and approvals happen as if a real trigger came in.')) return
    setBusy(true)
    setErr(null)
    try {
      let trigger: unknown
      let inputs: Record<string, unknown> | undefined
      if (t.type === 'table') {
        if (source === 'recent') {
          if (!recent) throw new Error('Pick a run.')
          trigger = (await flowsApi.runDetail(recent)).run.trigger
        } else if (source === 'record') {
          if (!rowId || !table) throw new Error('Pick a row.')
          const st = await platform.tables.query({ version: 2, table: table.name, filter: { col: 'id', op: 'eq', value: rowId }, page: { size: 1 } })
          const row = st.rows[0]
          if (!row) throw new Error('That row cannot be read.')
          const rec = Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith('__')))
          trigger = { Record: rec, Old: rec, Operation: op, ChangedColumns: [], Table: table.name }
        } else {
          const rec: Record<string, unknown> = {}
          for (const c of table?.columns ?? []) {
            const v = form[c.name]
            if (v === undefined || v === '') continue
            rec[c.name] = ['number', 'decimal', 'currency'].includes(c.type) ? Number(v) : c.type === 'boolean' ? v === 'true' : v
          }
          trigger = { Record: rec, Old: rec, Operation: op, ChangedColumns: [], Table: table?.name ?? '' }
        }
      } else if (t.type === 'manual') {
        inputs = {}
        for (const i of t.inputs ?? []) {
          const v = form[i.name]
          if (v === undefined || v === '') continue
          inputs[i.name] = i.type === 'number' ? Number(v) : i.type === 'boolean' ? v === 'true' : i.type === 'record' || i.type === 'table' ? JSON.parse(v) : v
        }
      } else if (t.type === 'webhook') {
        if (source === 'recent' && recent) trigger = (await flowsApi.runDetail(recent)).run.trigger
        else trigger = { Body: JSON.parse(body || 'null'), Query: {}, Headers: {}, ReceivedOn: new Date().toISOString(), DeliveryId: `test-${Date.now()}` }
      } else if (source === 'recent' && recent) trigger = (await flowsApi.runDetail(recent)).run.trigger
      const st = useDesigner.getState()
      const r = await flowsApi.test(flowId, { dryRun: !real, definition: { ...st.doc }, ...(inputs ? { inputs } : {}), ...(trigger !== undefined ? { trigger } : {}), ...(hasApproval && !real ? { approvalOutcome: outcome } : {}) })
      onStarted(r.runId)
      onClose()
    } catch (e) {
      const fe = e as FlowError
      if (fe.problems) useDesigner.getState().set({ problems: fe.problems })
      setErr(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const can = (s: Source) => (s === 'recent' ? runs.length > 0 : s === 'record' ? !!table : true)
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-lg" data-testid="test-dialog">
        <DialogHeader>
          <DialogTitle>Test the flow</DialogTitle>
          <DialogDescription>Runs what is on the canvas now (also unpublished changes). The steps show their results on the canvas.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          {(t.type === 'table' || t.type === 'webhook' || runs.length > 0) && (
            <div className="flex flex-wrap gap-3 text-xs" role="radiogroup" aria-label="Sample trigger">
              {(['record', 'recent', 'form'] as Source[]).filter((x) => t.type === 'table' || x !== 'record').map((x) => (
                <label key={x} className={can(x) ? 'flex items-center gap-1' : 'flex items-center gap-1 opacity-50'}><input type="radio" disabled={!can(x)} checked={source === x} onChange={() => setSource(x)} data-testid={`test-source-${x}`} />{x === 'record' ? 'An existing row' : x === 'recent' ? 'A recent real trigger' : t.type === 'table' ? 'Fill in values' : t.type === 'webhook' ? 'A request body' : 'Fill in the inputs'}</label>
              ))}
            </div>
          )}
          {source === 'recent' && (
            <select className={inputCls} value={recent} onChange={(e) => setRecent(e.target.value)} data-testid="test-recent">
              <option value="">Pick a run…</option>
              {runs.map((r) => <option key={r.id} value={r.id}>{fmtDate(r.createdOn)} · {r.triggerSummary ?? r.triggerKind} · {r.status}</option>)}
            </select>
          )}
          {t.type === 'table' && source !== 'recent' && (
            <Labeled label="As if the row was">
              <select className={inputCls} value={op} onChange={(e) => setOp(e.target.value)} data-testid="test-op">{((t as { on?: string[] }).on ?? ['create']).map((o) => <option key={o} value={o}>{o === 'create' ? 'added' : o === 'update' ? 'changed' : 'deleted'}</option>)}</select>
            </Labeled>
          )}
          {t.type === 'table' && source === 'record' && table && (
            <Labeled label={`Row of ${table.displayName}`}>
              <input className={inputCls} placeholder="Search" value={rowSearch} onChange={(e) => setRowSearch(e.target.value)} data-testid="test-row-search" />
              <select className={inputCls} size={Math.min(6, Math.max(2, rows.length))} value={rowId} onChange={(e) => setRowId(e.target.value)} data-testid="test-row">
                {rows.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </Labeled>
          )}
          {t.type === 'table' && source === 'form' && table && (
            <div className="grid max-h-60 gap-2 overflow-auto">
              {table.columns.filter((c) => !c.system).map((c) => <Labeled key={c.name} label={c.displayName}><input className={inputCls} value={form[c.name] ?? ''} onChange={(e) => setForm({ ...form, [c.name]: e.target.value })} data-testid={`test-field-${c.name}`} /></Labeled>)}
            </div>
          )}
          {t.type === 'manual' && (
            <div className="grid gap-2">
              {!(t.inputs ?? []).length && <p className="text-xs text-muted-foreground">This flow has no inputs.</p>}
              {(t.inputs ?? []).map((i) => <Labeled key={i.name} label={`${i.name}${i.required ? ' *' : ''}`} hint={i.type}><input className={inputCls} value={form[i.name] ?? ''} onChange={(e) => setForm({ ...form, [i.name]: e.target.value })} data-testid={`test-input-${i.name}`} /></Labeled>)}
            </div>
          )}
          {t.type === 'webhook' && source !== 'recent' && <textarea className="min-h-28 rounded-md border border-input bg-background p-2 font-mono text-xs" value={body} onChange={(e) => setBody(e.target.value)} data-testid="test-body" />}
          {hasApproval && !real && (
            <Labeled label="Simulated approval answer"><select className={inputCls} value={outcome} onChange={(e) => setOutcome(e.target.value)} data-testid="test-approval-outcome"><option>Approve</option><option>Reject</option></select></Labeled>
          )}
          <label className="flex items-start gap-2 rounded-md border border-border p-2 text-xs">
            <input type="checkbox" checked={real} onChange={(e) => setReal(e.target.checked)} data-testid="test-real" />
            <span><b>Run for real.</b> Off (default): data changes, messages, web calls and approvals are <b>simulated</b> and marked as such; reads are real.</span>
          </label>
          {real && <p className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400"><TriangleAlert className="size-3.5" />This run changes data and reaches people and other systems.</p>}
          {err && <p className="text-xs text-destructive" data-testid="test-error">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={go} disabled={busy} data-testid="test-start"><FlaskConical className="size-4" />{real ? 'Run for real' : 'Run the test'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
