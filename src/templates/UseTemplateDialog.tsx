/**
 * "Use" a template (master-plan 11.3; docs/guide/maker/templates.md): the BINDING step (each slot mapped to one of your
 * tables and its columns, created, or left out; type mismatches and name clashes explained, the two ways out of a clash
 * one click away), then the PLAN screen of solution import (PlanView: new / changed / nothing removed, problems block,
 * the backup line, the run-as-system approval), then the install in one transaction. Used by the Templates page (apps,
 * data models) and by the Studio (UI components into the current screen, screens into the current app).
 */
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, CircleAlert, Download, LayoutTemplate, Table2, TriangleAlert } from 'lucide-react'
import { platform, usePlatform } from '@/platform'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { BackupRefusal, PlanView, isBackupRefusal, useConfirmable } from '@/portal/SolutionPlan'
import { errMsg, useToast } from '@/portal/kit'
import { KIND_LABEL, LINKED_KINDS, type SlotBinding, type SlotReport, type TemplateDetail, type TemplateInstallResult, type TemplateMode, type TemplatePlanResponse, type TemplateUseRequest } from './format'
import { fetchTemplate, installTemplate, planTemplate } from './api'

export interface UseTarget { appId?: string; appName?: string; screenName?: string; takenNames?: string[] }

const selectCls = 'h-8 w-full rounded-md border border-input bg-background px-2 text-sm'

function SlotEditor({ report, binding, onChange, busy }: { report: SlotReport; binding: SlotBinding | undefined; onChange(b: SlotBinding): void; busy: boolean }) {
  const tables = usePlatform((s) => s.tables).filter((t) => !t.reporting)
  const mode = binding?.mode ?? report.mode
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
    setDetail(null); setResp(null); setStep('bind'); setError(''); setRefused(''); setMode('copy'); setAppName(''); setSample(false); setBindings({})
    let alive = true
    fetchTemplate(templateId).then((d) => {
      if (!alive) return
      setDetail(d)
      setBindings(d.defaults)
      void replan({ mode: 'copy', bindings: d.defaults, sample: false, ...(target ? { target } : {}) })
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

  const blocked = !resp || resp.plan.problems.length > 0
  const linkedOk = !!detail && LINKED_KINDS.includes(detail.kind) && detail.modes.includes('linked')
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl" data-testid="tpl-dialog" data-step={step}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><LayoutTemplate className="size-4 text-primary" /> {detail ? `Use "${detail.name}"` : 'Use a template'}</DialogTitle>
          <DialogDescription>
            {step === 'bind'
              ? 'Choose the data it works on: one of your tables (and its columns), or a new table. Nothing that exists is overwritten.'
              : 'The plan: what is added before anything happens. It runs in one transaction: if anything fails, nothing changes.'}
          </DialogDescription>
        </DialogHeader>
        {!detail && !error && <div className="grid place-items-center py-8"><Spinner /></div>}
        {error && <p className="text-sm text-destructive" role="alert" data-testid="tpl-error">{error}</p>}
        {detail && step === 'bind' && (
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
            {detail.sampleRows > 0 && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={sample} disabled={busy} data-testid="tpl-sample" onCheckedChange={(v) => { setSample(v === true); void replan(request({ sample: v === true })) }} />
                Add the {detail.sampleRows} SAMPLE rows (marked SAMPLE; only into tables the template creates)
              </label>
            )}
            {resp && resp.stripped.length > 0 && (
              <div className="grid gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs" data-testid="tpl-stripped">
                {resp.stripped.map((s) => <span key={s}>{s}</span>)}
              </div>
            )}
          </div>
        )}
        {step === 'plan' && resp && (
          <div className="grid gap-3">
            <PlanView plan={resp.plan} />
            {box}
            {refused && <BackupRefusal message={refused} busy={busy} onProceed={() => void install(true)} label="Install without a backup" />}
          </div>
        )}
        <DialogFooter>
          {step === 'plan' && <Button variant="outline" disabled={busy} onClick={() => setStep('bind')} data-testid="tpl-back"><ArrowLeft /> Back to the data</Button>}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          {step === 'bind' ? (
            <Button disabled={!resp || busy} onClick={() => { void replan(request()).then(() => setStep('plan')) }} data-testid="tpl-review">{busy ? <Spinner /> : null} Review plan</Button>
          ) : (
            <Button disabled={blocked || !ok || busy} onClick={() => void install()} data-testid="tpl-install">{busy ? <Spinner /> : <Download />} Install</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
