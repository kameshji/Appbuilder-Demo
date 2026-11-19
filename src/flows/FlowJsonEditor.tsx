/**
 * The stopgap editor of a flow definition: JSON, checked by the server (POST /flows/validate) with every problem named
 * by step id and field, saved as a new version, test-run with a sample trigger (simulated by default). Package B
 * replaces this component with the visual designer; the props stay the contract with the page.
 */
import { useState } from 'react'
import { CheckCircle2, FlaskConical, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { FlowDef, ValidationProblem } from '@/platform/flows'
import { errMsg, useToast } from '@/portal/kit'
import { flowsApi, type FlowError, type FlowInput } from './api'

export interface FlowEditorProps {
  /** the flow (absent: a new one) */
  flowId?: string
  initial: Record<string, unknown>
  readOnly?: boolean
  onSaved(flow: FlowDef): void
  onCancel?(): void
  /** a test run started: open it */
  onTested?(runId: string): void
}

export function FlowJsonEditor({ flowId, initial, readOnly, onSaved, onCancel, onTested }: FlowEditorProps) {
  const [text, setText] = useState(() => JSON.stringify(initial, null, 2))
  const [problems, setProblems] = useState<ValidationProblem[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [sample, setSample] = useState('{}')
  const { toast } = useToast()
  const parsed = (): FlowInput | null => {
    try {
      const v = JSON.parse(text)
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('The definition must be a JSON object.')
      return v as FlowInput
    } catch (e) {
      setProblems([{ step: '', field: 'json', message: `The JSON is not valid: ${errMsg(e)}`, severity: 'error' }])
      return null
    }
  }
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try { await fn() } finally { setBusy(false) }
  }
  const validate = () => run(async () => {
    const doc = parsed()
    if (!doc) return
    try {
      const r = await flowsApi.validate({ ...doc, ...(flowId ? { id: flowId } : {}) })
      setProblems(r.problems)
    } catch (e) { toast(errMsg(e), 'error') }
  })
  const save = (confirmRunAs = false): Promise<void> => run(async () => {
    const doc = parsed()
    if (!doc) return
    try {
      const r = flowId ? await flowsApi.save(flowId, { ...doc, ...(confirmRunAs ? { confirmRunAs } : {}) }) : await flowsApi.create({ ...doc, ...(confirmRunAs ? { confirmRunAs } : {}) })
      setProblems(r.problems)
      toast(`Saved as version ${r.flow.version}.`, 'success')
      onSaved(r.flow)
    } catch (e) {
      const fe = e as FlowError
      if (fe.status === 409 && fe.field === 'confirmRunAs') {
        if (confirm(`${errMsg(e)}\n\nSave with this identity?`)) { setBusy(false); return save(true) }
        return
      }
      if (fe.problems) setProblems(fe.problems)
      toast(errMsg(e), 'error')
    }
  })
  const test = () => run(async () => {
    if (!flowId) return
    const doc = parsed()
    if (!doc) return
    let trigger: unknown
    try { trigger = JSON.parse(sample || '{}') } catch { toast('The sample trigger must be JSON.', 'error'); return }
    try {
      const isManual = (doc.trigger as { type?: string } | undefined)?.type === 'manual'
      const r = await flowsApi.test(flowId, { dryRun: true, definition: doc, ...(isManual ? { inputs: trigger as Record<string, unknown> } : { trigger }) })
      toast('Test run started (data changes and messages are simulated).', 'success')
      onTested?.(r.runId)
    } catch (e) {
      const fe = e as FlowError
      if (fe.problems) setProblems(fe.problems)
      toast(errMsg(e), 'error')
    }
  })
  const errors = problems?.filter((p) => p.severity === 'error') ?? []
  return (
    <div className="grid gap-2" data-testid="flow-json-editor">
      <Textarea aria-label="Flow definition (JSON)" data-testid="flow-json" className="min-h-[24rem] font-mono text-xs" spellCheck={false} value={text} readOnly={readOnly} onChange={(e) => { setText(e.target.value); setProblems(null) }} />
      {problems && (
        <div className="rounded-md border border-border p-2 text-sm" data-testid="flow-problems">
          {problems.length === 0 ? <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="size-4" />No problems.</span> : (
            <ul className="grid gap-1">
              {problems.map((p, i) => (
                <li key={i} className={p.severity === 'error' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400'}>
                  <span className="font-mono text-xs">{p.step ? `step ${p.step}` : 'flow'}{p.field ? ` · ${p.field}` : ''}</span>: {p.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={validate}><CheckCircle2 className="size-4" />Check</Button>
          <Button size="sm" disabled={busy} data-testid="flow-save" onClick={() => save()}><Save className="size-4" />{flowId ? 'Save new version' : 'Create'}</Button>
          {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
          {errors.length > 0 && <span className="text-xs text-destructive">{errors.length} problem{errors.length === 1 ? '' : 's'}</span>}
        </div>
      )}
      {flowId && !readOnly && (
        <div className="grid gap-1 rounded-md border border-dashed border-border p-2">
          <label className="text-xs font-semibold text-muted-foreground" htmlFor="flow-sample">Test run: sample trigger (JSON; a manual flow: its inputs, a table flow: {'{"Record": {...}, "Operation": "create"}'})</label>
          <Textarea id="flow-sample" className="min-h-16 font-mono text-xs" value={sample} onChange={(e) => setSample(e.target.value)} />
          <div><Button size="sm" variant="outline" disabled={busy} onClick={test}><FlaskConical className="size-4" />Test run (simulated)</Button></div>
        </div>
      )}
    </div>
  )
}
