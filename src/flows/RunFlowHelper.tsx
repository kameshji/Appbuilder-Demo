/**
 * The Studio's "Run a flow" helper for behaviour properties (OnSelect ...): pick a flow that is started by hand, fill
 * its typed inputs (each a formula of the app: TextInput1.Text, 3, Today()), optionally wait for its Respond step, and
 * the call `RunFlow("Name", {Input: ...}[, {Wait: true, Result: "Answer"}])` is added to the property. Server mode only.
 */
import { useEffect, useMemo, useState } from 'react'
import { Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { usePlatform } from '@/platform'
import type { FlowListItem, InputDef } from '@/platform/flows'
import { errMsg } from '@/portal/kit'
import { flowsApi } from './api'

const SAMPLE: Record<string, string> = { text: '""', number: '0', boolean: 'false', date: 'Today()', datetime: 'Now()', choice: '""', record: 'ThisItem', table: 'Gallery1.AllItems' }
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** the RunFlow call for a flow and its inputs */
export function runFlowCall(name: string, inputs: Record<string, string>, wait: { on: boolean; result: string }): string {
  const parts = Object.entries(inputs).filter(([, v]) => v.trim()).map(([k, v]) => `${IDENT.test(k) ? k : `'${k}'`}: ${v.trim()}`)
  const opts = wait.on ? `, {Wait: true${wait.result.trim() ? `, Result: "${wait.result.trim().replace(/"/g, '""')}"` : ''}}` : ''
  return `RunFlow("${name.replace(/"/g, '""')}", {${parts.join(', ')}}${opts})`
}

/** appends a call to a behaviour formula ("=Navigate(X)" + call -> "=Navigate(X); RunFlow(...)") */
export function appendCall(formula: string, call: string): string {
  const body = formula.replace(/^\s*=/, '').trim()
  return `=${body && body !== 'false' && body !== 'true' ? `${body}; ` : ''}${call}`
}

export function RunFlowHelper({ current, onInsert, disabled }: { current: string; onInsert(formula: string): void; disabled?: boolean }) {
  const mode = usePlatform((s) => s.mode)
  const [open, setOpen] = useState(false)
  const [flows, setFlows] = useState<FlowListItem[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pick, setPick] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [wait, setWait] = useState({ on: false, result: 'FlowAnswer' })
  useEffect(() => {
    if (!open) return
    setErr(null)
    flowsApi.list().then((r) => setFlows(r.items.filter((f) => f.trigger?.type === 'manual'))).catch((e) => { setFlows([]); setErr(errMsg(e)) })
  }, [open])
  const flow = flows?.find((f) => f.id === pick)
  const inputs: InputDef[] = useMemo(() => (flow?.trigger?.type === 'manual' ? flow.trigger.inputs : []), [flow])
  useEffect(() => { setValues(Object.fromEntries(inputs.map((i) => [i.name, i.required ? SAMPLE[i.type] ?? '""' : '']))) }, [inputs])
  if (mode !== 'server') return null
  const call = flow ? runFlowCall(flow.name, values, wait) : ''
  return (
    <>
      <Button size="sm" variant="ghost" className="h-7 shrink-0 gap-1 px-2 text-xs" disabled={disabled} onClick={() => setOpen(true)} data-testid="runflow-helper" title="Add a call to a flow (RunFlow)"><Workflow className="size-3.5" />Run a flow</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg" data-testid="runflow-dialog">
          <DialogHeader>
            <DialogTitle>Run a flow</DialogTitle>
            <DialogDescription>Flows started by hand can be run from an app. The call is added to this property.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 text-sm">
            {err && <p className="text-xs text-destructive">{err}</p>}
            <select className="h-8 rounded-md border border-border bg-background px-2" value={pick} onChange={(e) => setPick(e.target.value)} data-testid="runflow-pick" aria-label="Flow">
              <option value="">{flows === null ? 'Loading flows…' : flows.length ? 'Choose a flow' : 'No flow is started by hand yet'}</option>
              {(flows ?? []).map((f) => <option key={f.id} value={f.id}>{f.name}{f.enabled ? '' : ' (off)'}</option>)}
            </select>
            {flow && (
              <>
                {!inputs.length && <p className="text-xs text-muted-foreground">This flow takes no inputs.</p>}
                {inputs.map((i) => (
                  <label key={i.name} className="grid gap-1 text-xs">
                    <span className="font-medium">{i.name} <span className="text-muted-foreground">· {i.type}{i.required ? ', required' : ''}</span>{i.description ? <span className="text-muted-foreground"> · {i.description}</span> : null}</span>
                    {i.type === 'choice' && i.choices?.length ? (
                      <select className="h-8 rounded-md border border-border bg-background px-2 font-mono text-xs" value={values[i.name] ?? ''} onChange={(e) => setValues({ ...values, [i.name]: e.target.value })}>
                        <option value="">(formula below)</option>
                        {i.choices.map((c) => <option key={c} value={`"${c}"`}>{c}</option>)}
                      </select>
                    ) : null}
                    <input className="h-8 rounded-md border border-border bg-background px-2 font-mono text-xs" value={values[i.name] ?? ''} placeholder={SAMPLE[i.type]} onChange={(e) => setValues({ ...values, [i.name]: e.target.value })} data-testid={`runflow-input-${i.name}`} />
                  </label>
                ))}
                <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={wait.on} onChange={(e) => setWait({ ...wait, on: e.target.checked })} />Wait for its answer (Respond step, at most 30 s) and keep it in the variable</label>
                {wait.on && <input className="h-8 rounded-md border border-border bg-background px-2 font-mono text-xs" value={wait.result} onChange={(e) => setWait({ ...wait, result: e.target.value })} aria-label="Variable for the answer" />}
                <pre className="overflow-auto rounded-md bg-muted p-2 font-mono text-[11px]" data-testid="runflow-preview">{call}</pre>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!flow} onClick={() => { onInsert(appendCall(current, call)); setOpen(false) }} data-testid="runflow-insert">Add the call</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
