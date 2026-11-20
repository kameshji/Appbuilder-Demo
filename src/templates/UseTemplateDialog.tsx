/**
 * "Use" a template (master-plan 11.3; docs/guide/maker/templates.md): the BINDING step (each slot mapped to one of your
 * tables and its columns, created, or left out; type mismatches and name clashes explained, the two ways out of a clash
 * one click away), then the PLAN screen of solution import (PlanView: new / changed / nothing removed, problems block,
 * the backup line, the run-as-system approval), then the install in one transaction. Used by the Templates page (apps,
 * data models, solutions) and by the Studio (UI components into the current screen, screens into the current app).
 *
 * Solution templates (P3-M1): Linked by default; shared slots are bound to the table of the pack they depend on (shown,
 * not edited); the packs it needs are listed (here, or installed first in the same transaction, with their own plan);
 * after the install an administrator is offered "Switch on these flows" (they arrive turned off: rule 8).
 */
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, CircleAlert, Download, LayoutTemplate, Link2, Package, Table2, TriangleAlert, Workflow } from 'lucide-react'
import { platform, usePlatform } from '@/platform'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { BackupRefusal, PlanView, isBackupRefusal, useConfirmable } from '@/portal/SolutionPlan'
import { errMsg, useToast } from '@/portal/kit'
import { KIND_LABEL, LINKED_KINDS, type SlotBinding, type SlotReport, type TemplateDetail, type TemplateInstallRecord, type TemplateInstallResult, type TemplateMode, type TemplatePlanResponse, type TemplateUseRequest } from './format'
import { enableFlows, fetchTemplate, installTemplate, planTemplate } from './api'

export interface UseTarget { appId?: string; appName?: string; screenName?: string; takenNames?: string[] }

const selectCls = 'h-8 w-full rounded-md border border-input bg-background px-2 text-sm'

function SlotEditor({ report, binding, onChange, busy }: { report: SlotReport; binding: SlotBinding | undefined; onChange(b: SlotBinding): void; busy: boolean }) {
  const tables = usePlatform((s) => s.tables).filter((t) => !t.reporting)
  const mode = binding?.mode ?? report.mode
  if (report.shared) {
    // a shared slot: the table of the pack this one depends on (bound by the server, not edited here)
    return (
      <div className="grid gap-1 rounded-md border border-border bg-muted/30 p-3 text-sm" data-testid={`tpl-slot-${report.slot}`} data-shared="true">
        <div className="flex flex-wrap items-center gap-2"><Link2 className="size-4 text-primary" /><span className="font-medium">{report.label}</span></div>
        <span className="text-xs text-muted-foreground" data-testid={`tpl-slot-shared-${report.slot}`}>Shared with {report.shared.templateName}: its table <b>{report.shared.table}</b>{report.shared.planned ? ' (installed first, in the same transaction)' : ''}. Nothing of it changes.</span>
        {report.problems.map((p) => <p key={p} className="flex items-start gap-1 text-xs text-destructive"><CircleAlert className="mt-px size-3.5 shrink-0" />{p}</p>)}
      </div>
    )
  }
  return (
    <div className={cn('grid gap-2 rounded-md border p-3', report.problems.length ? 'border-destructive/50' : 'border-border')} data-testid={`tpl-slot-${report.slot}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Table2 className="size-4 text-primary" />
        <span className="font-medium">{report.label}</span>
        {!report.required && <span className="text-xs text-muted-foreground">(optional)</span>}
        {report.description && <span className="text-xs text-muted-foreground">{report.description}</span>}
      </div>
      <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-2 text-sm">
        <select className={selectCls} value={mode} disabled={busy} data-testid={`tpl-slot-mode-${report.slot}`}
          onChange={(e) => {
            const m = e.target.value as SlotBinding['mode']
            if (m === 'create') onChange({ mode: 'create', name: report.mode === 'create' && report.table ? report.table.name : (binding?.mode === 'create' ? binding.name : report.slot) })
            else if (m === 'map') onChange({ mode: 'map', table: report.clash?.id ?? '' })
            else onChange({ mode: 'skip' })
          }}>
          <option value="map">Use one of my tables</option>
          {report.canCreate && <option value="create">Create a new table</option>}
          {!report.required && <option value="skip">Leave out</option>}
        </select>
        {mode === 'create' && (
          <div className="flex items-center gap-2">
            <Input className="h-8" value={binding?.mode === 'create' ? binding.name : report.table?.name ?? ''} disabled={busy} data-testid={`tpl-slot-name-${report.slot}`} aria-label="Table name"
              onChange={(e) => onChange({ mode: 'create', name: e.target.value, ...(binding?.mode === 'create' && binding.displayName ? { displayName: binding.displayName } : {}) })} />
            <span className="shrink-0 text-xs text-muted-foreground">table name</span>
          </div>
        )}
        {mode === 'map' && (
          <select className={selectCls} value={binding?.mode === 'map' ? binding.table : report.table?.id ?? ''} disabled={busy} data-testid={`tpl-slot-table-${report.slot}`}
            onChange={(e) => onChange({ mode: 'map', table: e.target.value })}>
            <option value="" disabled>Choose a table</option>
            {tables.map((t) => <option key={t.id} value={t.id}>{t.displayName} ({t.name})</option>)}
          </select>
        )}
        {mode === 'skip' && <span className="text-xs text-muted-foreground">What the template shows from it stays blank.</span>}
      </div>
      {report.clash && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-100" data-testid={`tpl-clash-${report.slot}`}>
          <TriangleAlert className="size-3.5" /> A table named <b>{report.clash.name}</b> already exists here. Nothing of it is overwritten: choose
          <Button size="xs" variant="outline" disabled={busy} data-testid={`tpl-clash-map-${report.slot}`} onClick={() => onChange({ mode: 'map', table: report.clash!.id })}>Use {report.clash.displayName}</Button>
          or
          <Button size="xs" variant="outline" disabled={busy} data-testid={`tpl-clash-rename-${report.slot}`} onClick={() => onChange({ mode: 'create', name: report.clash!.suggestion, displayName: report.clash!.suggestion })}>Install as {report.clash.suggestion}</Button>
        </div>
      )}
      {mode === 'map' && report.table && (
        <div className="grid gap-1.5 text-sm">
          {report.columns.map((c) => (
            <div key={c.id} className="grid grid-cols-[180px_minmax(0,1fr)] items-start gap-2">
              <span className="pt-1.5 text-xs">{c.label} <span className="text-muted-foreground">({c.types.join(' or ')}{c.required ? ', required' : ''})</span></span>
              <div className="grid gap-0.5">
                <select className={cn(selectCls, c.problem && 'border-destructive')} value={c.bound ?? ''} disabled={busy} data-testid={`tpl-col-${report.slot}-${c.id}`}
                  onChange={(e) => {
                    const cur = binding?.mode === 'map' ? binding : { mode: 'map' as const, table: report.table!.id ?? '', columns: {} }
                    onChange({ ...cur, columns: { ...Object.fromEntries(report.columns.map((x) => [x.id, x.bound])), ...(cur.columns ?? {}), [c.id]: e.target.value || null } })
                  }}>
                  <option value="">{c.required ? 'Choose a column' : 'Not mapped'}</option>
                  {c.candidates.map((x) => <option key={x.name} value={x.name}>{x.displayName} ({x.type}){x.ok ? '' : ' - does not fit'}</option>)}
                </select>
                {c.problem && <span className="text-xs text-destructive" data-testid={`tpl-col-problem-${report.slot}-${c.id}`}>{c.problem}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      {mode === 'create' && <p className="text-xs text-muted-foreground">Columns: {report.columns.map((c) => c.label).join(', ')}.</p>}
      {report.problems.filter((p) => !report.clash || !/already exists/.test(p)).map((p) => <p key={p} className="flex items-start gap-1 text-xs text-destructive"><CircleAlert className="mt-px size-3.5 shrink-0" />{p}</p>)}
    </div>
  )
}

export function UseTemplateDialog({ open, onOpenChange, templateId, target, onInstalled }: { open: boolean; onOpenChange(o: boolean): void; templateId: string | null; target?: UseTarget; onInstalled?(r: TemplateInstallResult): void }) {
  const { toast, fail } = useToast()
  const [detail, setDetail] = useState<TemplateDetail | null>(null)
  const [mode, setMode] = useState<TemplateMode>('copy')
  const [bindings, setBindings] = useState<Record<string, SlotBinding>>({})
  const [appName, setAppName] = useState('')
  const [sample, setSample] = useState(false)
  const [resp, setResp] = useState<TemplatePlanResponse | null>(null)
  const [step, setStep] = useState<'bind' | 'plan'>('bind')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refused, setRefused] = useState('')
  /** solution templates: the install is done, its flows are off; an administrator may switch them on now */
  const [installed, setInstalled] = useState<TemplateInstallRecord | null>(null)
  const [flowPick, setFlowPick] = useState<Set<string>>(new Set())
  const isAdmin = usePlatform((s) => !!s.session?.privileges.isAdmin)
  const seq = useRef(0)
  const { ok, box } = useConfirmable(step === 'plan' ? resp?.plan ?? null : null)

  const request = (o: { bindings?: Record<string, SlotBinding>; mode?: TemplateMode; appName?: string; sample?: boolean } = {}): TemplateUseRequest => ({
    mode: o.mode ?? mode, bindings: o.bindings ?? bindings, ...((o.appName ?? appName) ? { appName: o.appName ?? appName } : {}), sample: o.sample ?? sample,
    ...(target ? { target } : {}),
  })
  const replan = async (req: TemplateUseRequest) => {
    if (!templateId) return
    const n = ++seq.current
    setBusy(true)
    setError('')
    try {
      const r = await planTemplate(templateId, req)
      if (n !== seq.current) return
      setResp(r)
      setBindings(r.bindings)
      if (r.appName && !req.appName) setAppName(r.appName.value)
    } catch (e) {
      if (n === seq.current) setError(errMsg(e))
    } finally {
      if (n === seq.current) setBusy(false)
    }
  }

  useEffect(() => {
    if (!open || !templateId) return
    setDetail(null); setResp(null); setStep('bind'); setError(''); setRefused(''); setMode('copy'); setAppName(''); setSample(false); setBindings({}); setInstalled(null); setFlowPick(new Set())
    let alive = true
    fetchTemplate(templateId).then((d) => {
      if (!alive) return
      setDetail(d)
      setBindings(d.defaults)
      // solution templates are versioned solutions: Linked unless the maker chooses a copy
      const m: TemplateMode = d.kind === 'solution' && d.modes.includes('linked') ? 'linked' : 'copy'
      setMode(m)
      void replan({ mode: m, bindings: d.defaults, sample: false, ...(target ? { target } : {}) })
    }, (e) => alive && setError(errMsg(e)))
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, templateId])

  const change = (slot: string, b: SlotBinding) => {
    const next = { ...bindings, [slot]: b }
    setBindings(next)
    void replan(request({ bindings: next }))
  }

  const install = async (proceedWithoutBackup = false) => {
    if (!templateId || !resp) return
    setBusy(true)
    try {
      const r = await installTemplate(templateId, { ...request({ bindings: resp.bindings }), confirm: resp.plan.token, ...(resp.plan.systemEvents?.length ? { approveSystem: true } : {}), ...(proceedWithoutBackup ? { proceedWithoutBackup: true } : {}) })
      await platform.init().catch(() => undefined)
      toast(`Installed "${detail?.name ?? templateId}"${r.backup && !r.backup.taken && resp.plan.backup.available ? ' (no backup was taken)' : ''}`, 'success')
      onInstalled?.(r)
      // rule 8: the flows a pack brought arrive turned off; an administrator switches them on explicitly
      if (r.install.flowsOff?.length && isAdmin) { setInstalled(r.install); setFlowPick(new Set()); return }
      onOpenChange(false)
    } catch (e) {
      if (isBackupRefusal(e)) { setRefused(errMsg(e)); return }
      fail(e)
      setStep('bind')
      void replan(request())
    } finally {
      setBusy(false)
    }
  }

  const switchOn = async () => {
    if (!installed) return
    setBusy(true)
    try {
      await enableFlows(installed.id, [...flowPick])
      toast(`Switched on ${flowPick.size} flow${flowPick.size === 1 ? '' : 's'}`, 'success')
      onOpenChange(false)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const blocked = !resp || resp.plan.problems.length > 0
  const linkedOk = !!detail && LINKED_KINDS.includes(detail.kind) && detail.modes.includes('linked')
  const deps = resp?.dependencies ?? []
  const flowsOff = installed?.flowsOff ?? []
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl" data-testid="tpl-dialog" data-step={installed ? 'flows' : step}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><LayoutTemplate className="size-4 text-primary" /> {detail ? `Use "${detail.name}"` : 'Use a template'}</DialogTitle>
          <DialogDescription>
            {installed
              ? 'Installed. Its flows arrived turned off: switch on the ones you tick (they run as you, the administrator who installed them).'
              : step === 'bind'
                ? 'Choose the data it works on: one of your tables (and its columns), or a new table. Nothing that exists is overwritten.'
                : 'The plan: what is added before anything happens. It runs in one transaction: if anything fails, nothing changes.'}
          </DialogDescription>
        </DialogHeader>
        {!detail && !error && <div className="grid place-items-center py-8"><Spinner /></div>}
        {error && <p className="text-sm text-destructive" role="alert" data-testid="tpl-error">{error}</p>}
        {installed && (
          <div className="grid gap-2 rounded-md border border-border p-3" data-testid="tpl-flows">
            <span className="flex items-center gap-1.5 text-sm font-semibold"><Workflow className="size-4 text-primary" /> Switch on these flows</span>
            {flowsOff.map((f) => (
              <label key={f.id} className="flex items-center gap-2 text-sm">
                <Checkbox checked={flowPick.has(f.id)} disabled={busy} data-testid={`tpl-flow-${f.id}`} onCheckedChange={(v) => { const n = new Set(flowPick); if (v === true) n.add(f.id); else n.delete(f.id); setFlowPick(n) }} />
                {f.name}
              </label>
            ))}
            <span className="text-xs text-muted-foreground">Recorded in the audit log. You can also switch them on later from the Templates page or the Flows page.</span>
          </div>
        )}
        {detail && !installed && step === 'bind' && (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-xs text-muted-foreground">{KIND_LABEL[detail.kind]} template v{detail.version}</span>
              {linkedOk ? (
                <label className="flex items-center gap-2">
                  <select className="h-8 rounded-md border border-input bg-background px-2 text-sm" value={mode} disabled={busy} data-testid="tpl-mode"
                    onChange={(e) => { const m = e.target.value as TemplateMode; setMode(m); void replan(request({ mode: m })) }}>
                    <option value="copy">Copy (yours to edit, no updates)</option>
                    <option value="linked">Linked (versioned: updates arrive as an upgrade plan)</option>
                  </select>
                </label>
              ) : <span className="text-xs text-muted-foreground">Used as a copy: it becomes yours to edit, and gets no updates.</span>}
            </div>
            {deps.length > 0 && (
              <div className="grid gap-1.5 rounded-md border border-border p-2.5 text-sm" data-testid="tpl-deps">
                <span className="text-xs font-semibold">It needs</span>
                {deps.map((d) => (
                  <div key={d.id} className="flex flex-wrap items-center gap-2" data-testid={`tpl-dep-${d.id}`} data-action={d.action}>
                    <Package className="size-3.5 text-primary" /><span className="font-medium">{d.name}</span><span className="text-xs text-muted-foreground">{d.minVersion} or newer</span>
                    <span className={cn('ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium', d.action === 'installed' ? 'bg-muted text-muted-foreground' : d.action === 'install' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-rose-500/15 text-rose-700 dark:text-rose-300')}>
                      {d.action === 'installed' ? `installed here (v${d.version})` : d.action === 'install' ? `installed first (v${d.version})` : 'not usable'}
                    </span>
                    {d.problems.map((p) => <span key={p} className="basis-full text-xs text-destructive">{p}</span>)}
                  </div>
                ))}
              </div>
            )}
            {detail.kind === 'app' && (
              <div className="grid gap-1">
                <label className="text-xs font-medium" htmlFor="tpl-app-name">Name of the new app</label>
                <div className="flex items-center gap-2">
                  <Input id="tpl-app-name" className={cn('h-8', resp?.appName?.clash && 'border-destructive')} value={appName} disabled={busy} data-testid="tpl-app-name"
                    onChange={(e) => setAppName(e.target.value)} onBlur={(e) => void replan(request({ appName: e.target.value }))} />
                  {resp?.appName?.clash && resp.appName.suggestion && (
                    <Button size="xs" variant="outline" disabled={busy} data-testid="tpl-app-rename" onClick={() => { setAppName(resp.appName!.suggestion!); void replan(request({ appName: resp.appName!.suggestion! })) }}>Use "{resp.appName.suggestion}"</Button>
                  )}
                </div>
                {resp?.appName?.clash && <span className="text-xs text-destructive">An app with this name exists here.</span>}
              </div>
            )}
            {resp?.slots.map((r) => <SlotEditor key={r.slot} report={r} binding={bindings[r.slot]} busy={busy} onChange={(b) => change(r.slot, b)} />)}
            {!detail.slots.length && <p className="text-sm text-muted-foreground">This template needs no data.</p>}
            {resp?.sequences && resp.sequences.length > 0 && (
              <div className="grid gap-0.5 text-xs text-muted-foreground" data-testid="tpl-sequences">
                {resp.sequences.map((q) => <span key={q.key}>Number sequence <b>{q.name}</b>: {q.action === 'reuse' ? 'yours is used' : q.action === 'renamed' ? 'created under this name (yours keeps its own)' : 'created'}{q.note ? ` (${q.note})` : ''}.</span>)}
              </div>
            )}
            {detail.sampleRows > 0 && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={sample} disabled={busy} data-testid="tpl-sample" onCheckedChange={(v) => { setSample(v === true); void replan(request({ sample: v === true })) }} />
                Add the {detail.sampleRows} SAMPLE rows (marked SAMPLE; only into tables the template creates{detail.kind === 'solution' ? '; "Remove sample data" takes them out again' : ''})
              </label>
            )}
            {resp && resp.stripped.length > 0 && (
              <div className="grid gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs" data-testid="tpl-stripped">
                {resp.stripped.map((s) => <span key={s}>{s}</span>)}
              </div>
            )}
          </div>
        )}
        {!installed && step === 'plan' && resp && (
          <div className="grid gap-3">
            {deps.filter((d) => d.action === 'install' && d.plan).map((d) => (
              <div key={d.id} className="grid gap-1.5 rounded-md border border-dashed border-border p-2.5" data-testid={`tpl-dep-plan-${d.id}`}>
                <span className="text-xs font-semibold">First, in the same transaction: {d.name} v{d.version}</span>
                <PlanView plan={d.plan!} />
              </div>
            ))}
            <div data-testid="tpl-main-plan"><PlanView plan={resp.plan} /></div>
            {box}
            {refused && <BackupRefusal message={refused} busy={busy} onProceed={() => void install(true)} label="Install without a backup" />}
          </div>
        )}
        <DialogFooter>
          {installed ? (
            <>
              <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)} data-testid="tpl-flows-later">Not now</Button>
              <Button disabled={busy || !flowPick.size} onClick={() => void switchOn()} data-testid="tpl-flows-enable">{busy ? <Spinner /> : <Workflow />} Switch on {flowPick.size || ''}</Button>
            </>
          ) : (
            <>
              {step === 'plan' && <Button variant="outline" disabled={busy} onClick={() => setStep('bind')} data-testid="tpl-back"><ArrowLeft /> Back to the data</Button>}
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
              {step === 'bind' ? (
                <Button disabled={!resp || busy} onClick={() => { void replan(request()).then(() => setStep('plan')) }} data-testid="tpl-review">{busy ? <Spinner /> : null} Review plan</Button>
              ) : (
                <Button disabled={blocked || !ok || busy} onClick={() => void install()} data-testid="tpl-install">{busy ? <Spinner /> : <Download />} Install</Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
