/**
 * Moving a solution between environments (docs/guide/maker/solutions.md): the plan of an import or a deployment
 * (what is new, changed, removed; destructive changes in red; blocking problems; whether a backup is taken), and the
 * "Deploy to..." dialog of a solution page: export from this environment and import into another in one step, after
 * the administrator reviewed and confirmed the plan.
 */
import { useEffect, useState } from 'react'
import { ArrowRight, Boxes, Cable, CircleAlert, FileSpreadsheet, Info, LayoutGrid, Rocket, ShieldCheck, Table2, TriangleAlert, type LucideIcon } from 'lucide-react'
import { ENVIRONMENT_TYPE_LABEL, usePlatform, type SolutionDef } from '@/platform'
import type { PlanItem, SolutionPlan } from '@/platform/http'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Spinner } from '@/components/ui/spinner'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { TypeBadge } from './EnvironmentPicker'
import { Field, errMsg, useToast } from './kit'
import { deploy, planDeploy } from './environmentApi'

const KIND_ICON: Record<PlanItem['kind'], LucideIcon> = { app: LayoutGrid, table: Table2, role: ShieldCheck, connection: Cable, file: FileSpreadsheet }
const KIND_LABEL: Record<PlanItem['kind'], string> = { app: 'App', table: 'Table', role: 'Role', connection: 'Connection', file: 'Data file' }
const CHANGE_STYLE: Record<PlanItem['change'], string> = {
  new: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  changed: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  removed: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  unchanged: 'bg-muted text-muted-foreground',
}

export function PlanView({ plan }: { plan: SolutionPlan }) {
  const [showSame, setShowSame] = useState(false)
  const order: PlanItem['change'][] = ['removed', 'changed', 'new', 'unchanged']
  const items = [...plan.items].sort((a, b) => order.indexOf(a.change) - order.indexOf(b.change))
  const same = items.filter((i) => i.change === 'unchanged')
  const shown = showSame ? items : items.filter((i) => i.change !== 'unchanged')
  const count = (c: PlanItem['change']) => plan.items.filter((i) => i.change === c).length
  return (
    <div className="grid gap-3" data-testid="solution-plan" data-mode={plan.mode}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Boxes className="size-4 text-primary" />
        <span className="font-semibold">{plan.solution.displayName}</span>
        {plan.solution.fromVersion && plan.solution.fromVersion !== plan.solution.version ? (
          <span className="flex items-center gap-1 font-mono text-xs text-muted-foreground">v{plan.solution.fromVersion} <ArrowRight className="size-3" /> v{plan.solution.version}</span>
        ) : plan.solution.version ? <span className="font-mono text-xs text-muted-foreground">v{plan.solution.version}</span> : null}
        <span className="text-muted-foreground">into</span>
        <span className="font-medium">{plan.target.name}</span>
        <TypeBadge type={plan.target.type} locked={plan.target.locked} />
        <Badge variant="outline" className="ml-auto" data-testid="plan-mode">{plan.mode === 'upgrade' ? 'Upgrade in place' : plan.mode === 'install' ? 'New install' : 'Import as copies'}</Badge>
      </div>
      <div className="flex flex-wrap gap-1.5 text-xs" data-testid="plan-counts">
        {order.map((c) => count(c) > 0 && <span key={c} className={cn('rounded px-1.5 py-0.5 font-medium', CHANGE_STYLE[c])}>{count(c)} {c}</span>)}
      </div>
      {plan.problems.length > 0 && (
        <div className="grid gap-1 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive" role="alert" data-testid="plan-problems">
          <span className="flex items-center gap-1.5 font-semibold"><CircleAlert className="size-3.5" /> This cannot be imported:</span>
          {plan.problems.map((p) => <span key={p}>{p}</span>)}
        </div>
      )}
      {plan.destructive && (
        <div className="flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-2.5 text-xs text-rose-800 dark:text-rose-200" data-testid="plan-destructive">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <span><b>Data will be lost.</b> Items marked in red drop a table or a column in {plan.target.name}; their values cannot be brought back by this import.</span>
        </div>
      )}
      <div className="max-h-72 overflow-auto rounded-md border border-border" data-testid="plan-items">
        {shown.length === 0 && <p className="p-3 text-sm text-muted-foreground">Nothing changes.</p>}
        {shown.map((i) => {
          const Icon = KIND_ICON[i.kind]
          return (
            <div key={`${i.kind}:${i.id}:${i.name}`} className={cn('border-b border-border px-3 py-2 text-sm last:border-0', i.destructive && 'bg-rose-500/5')} data-testid={`plan-item-${i.kind}-${i.change}`} data-destructive={i.destructive ? 'true' : undefined}>
              <div className="flex items-center gap-2">
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">{KIND_LABEL[i.kind]}</span>
                <span className="truncate font-medium">{i.name}</span>
                <span className={cn('ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium', CHANGE_STYLE[i.change])}>{i.change}</span>
                {i.destructive && <TriangleAlert className="size-3.5 text-rose-600" aria-label="destructive" />}
              </div>
              {i.note && <div className="mt-0.5 pl-5 text-xs text-muted-foreground">{i.note}</div>}
              {i.columns && i.columns.length > 0 && (
                <ul className="mt-1 grid gap-0.5 pl-5 text-xs">
                  {i.columns.map((c) => (
                    <li key={c.name} className={cn(c.destructive ? 'font-medium text-rose-700 dark:text-rose-300' : 'text-muted-foreground')} data-testid={`plan-col-${c.name}`}>
                      {c.change === 'added' ? `+ ${c.name} (${c.to})` : c.change === 'removed' ? `− ${c.name} (${c.from}): dropped, its values are lost` : c.change === 'type' ? `${c.name}: ${c.from} → ${c.to}` : `${c.name}: settings change`}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
      </div>
      {same.length > 0 && <button type="button" className="w-fit text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setShowSame((v) => !v)}>{showSame ? 'Hide' : 'Show'} {same.length} unchanged</button>}
      {plan.warnings.map((w) => <p key={w} className="flex items-start gap-1.5 text-xs text-muted-foreground"><Info className="mt-px size-3.5 shrink-0" /> {w}</p>)}
      <p className={cn('flex items-start gap-1.5 text-xs', plan.mode === 'upgrade' && !plan.backup.available ? 'font-medium text-amber-700 dark:text-amber-300' : 'text-muted-foreground')} data-testid="plan-backup">
        <Info className="mt-px size-3.5 shrink-0" /> {plan.backup.message}
      </p>
    </div>
  )
}

/** what the admin must tick before confirming a plan that loses data */
export function useConfirmable(plan: SolutionPlan | null): { ok: boolean; box: React.ReactNode } {
  const [ack, setAck] = useState(false)
  useEffect(() => setAck(false), [plan?.token])
  if (!plan) return { ok: false, box: null }
  const blocked = plan.problems.length > 0
  const box = plan.destructive && !blocked ? (
    <label className="flex items-center gap-2 text-sm">
      <Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} data-testid="plan-ack" />
      I understand that the data in the red items is lost.
    </label>
  ) : null
  return { ok: !blocked && (!plan.destructive || ack), box }
}

export function DeployDialog({ open, onOpenChange, solution }: { open: boolean; onOpenChange(o: boolean): void; solution: SolutionDef }) {
  const list = usePlatform((s) => s.environments)
  const currentId = usePlatform((s) => s.environmentId)
  const { fail, toast } = useToast()
  const targets = list.filter((e) => e.id !== currentId && (!e.state || e.state === 'ready'))
  const [target, setTarget] = useState('')
  const [includeData, setIncludeData] = useState(false)
  const [plan, setPlan] = useState<SolutionPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { ok, box } = useConfirmable(plan)
  useEffect(() => {
    if (!open) return
    setPlan(null); setError(''); setIncludeData(false)
    setTarget((targets.find((e) => e.type === 'production') ?? targets[0])?.id ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => { setPlan(null); setError('') }, [target, includeData])

  const review = async () => {
    setBusy(true)
    setError('')
    try {
      setPlan(await planDeploy(solution.id, target, includeData))
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  const run = async () => {
    if (!plan) return
    setBusy(true)
    try {
      const res = await deploy(solution.id, target, plan.token, includeData)
      const t = list.find((e) => e.id === target)
      toast(`Deployed "${solution.displayName}" v${res.version} to ${t?.name ?? target}${res.backup && !res.backup.taken ? ' (no backup was taken)' : ''}`, 'success')
      onOpenChange(false)
    } catch (e) {
      fail(e)
      // the target may have changed meanwhile: plan again
      setPlan(null)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-2xl" data-testid="deploy-dialog">
        <DialogHeader>
          <DialogTitle>Deploy "{solution.displayName}" to another environment</DialogTitle>
          <DialogDescription>Exports v{solution.version} from this environment and imports it into the target in one step. Where it already exists it is upgraded in place, in one transaction: if anything fails, nothing changes there.</DialogDescription>
        </DialogHeader>
        {targets.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground" data-testid="deploy-no-target">There is no other environment you can enter. An install administrator can create one in Admin console &gt; Environments.</p>
        ) : (
          <div className="grid gap-4">
            <div className="grid grid-cols-[1fr_auto] items-end gap-3">
              <Field label="Target environment" htmlFor="deploy-target">
                <select id="deploy-target" value={target} onChange={(e) => setTarget(e.target.value)} data-testid="deploy-target" className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm">
                  {targets.map((e) => <option key={e.id} value={e.id}>{e.name} ({ENVIRONMENT_TYPE_LABEL[e.type]}{e.locked ? ', locked' : ''})</option>)}
                </select>
              </Field>
              <label className="flex h-8 items-center gap-2 text-sm" title="Rows are only loaded into tables the deployment creates; existing rows are never replaced">
                <Checkbox checked={includeData} onCheckedChange={(v) => setIncludeData(v === true)} data-testid="deploy-data" /> Include rows for new tables
              </label>
            </div>
            {error && <p className="text-sm text-destructive" role="alert" data-testid="deploy-error">{error}</p>}
            {plan ? <PlanView plan={plan} /> : (
              <p className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">Review the plan first: you see every app, table, column and role that will be added, changed or removed before anything happens.</p>
            )}
            {box}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          {!plan ? (
            <Button onClick={review} disabled={!target || busy} data-testid="deploy-review">{busy ? <Spinner /> : null} Review plan</Button>
          ) : (
            <Button onClick={run} disabled={!ok || busy} variant={plan.destructive ? 'destructive' : 'default'} data-testid="deploy-confirm">{busy ? <Spinner /> : <Rocket />} {plan.mode === 'upgrade' ? 'Upgrade' : 'Install'} in {list.find((e) => e.id === target)?.name ?? target}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
