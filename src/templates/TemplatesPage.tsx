/**
 * The Templates page (Dev mode; docs/guide/maker/templates.md): the built-in catalogue by kind with search, a detail
 * view (what it contains, what it needs, integrity), "Use", and the templates installed in this environment (uninstall
 * for apps, data models and solutions; upgrade for Linked installs with a newer version). Solution templates (P3-M1):
 * "Remove sample data", "Switch on these flows" (administrators), what an install depends on and what depends on it,
 * and the local changes of every component kind on the upgrade screen.
 */
import { useEffect, useMemo, useState } from 'react'
import { AppWindow, Boxes, Eraser, Package, Workflow, CheckCircle2, LayoutTemplate, Network, PanelsTopLeft, RefreshCw, Search, ShieldAlert, ShieldCheck, Trash2, type LucideIcon } from 'lucide-react'
import { platform, usePlatform } from '@/platform'
import { go } from '@/router'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { BackupRefusal, PlanView, isBackupRefusal, useConfirmable, useWideningConsent } from '@/portal/SolutionPlan'
import { Empty, PageHeader, errMsg, fmtDate, useToast } from '@/portal/kit'
import { KIND_LABEL, LOCAL_CHANGE_LABEL, TEMPLATE_KINDS, type TemplateDetail, type TemplateInstallRecord, type TemplateKind, type TemplateSummary, type UninstallItem, type UninstallPlan, type UpgradePlan } from './format'
import { enableFlows, fetchCatalogue, fetchInstalled, fetchTemplate, planUninstall, planUpgrade, removeSample, uninstall, upgrade } from './api'
import { UseTemplateDialog } from './UseTemplateDialog'

const KIND_ICON: Record<TemplateKind, LucideIcon> = { component: Boxes, screen: PanelsTopLeft, app: AppWindow, dataModel: Network, solution: Package }
const KIND_PLURAL: Record<TemplateKind, string> = { component: 'UI components', screen: 'Screens', app: 'Apps', dataModel: 'Data models', solution: 'Solutions' }

/** the hash that opens an app in the Studio with a template's use dialog */
export const studioWithTemplate = (appId: string, templateId: string): string => `#studio-${appId}?template=${encodeURIComponent(templateId)}`

function OpenInStudioDialog({ template, onClose }: { template: TemplateSummary | null; onClose(): void }) {
  const apps = usePlatform((s) => s.apps)
  const [appId, setAppId] = useState('')
  useEffect(() => { if (template) setAppId(apps[0]?.id ?? '') }, [template, apps])
  return (
    <Dialog open={!!template} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="tpl-open-studio">
        <DialogHeader>
          <DialogTitle>Use "{template?.name}" in an app</DialogTitle>
          <DialogDescription>
            {template?.kind === 'component' ? 'UI component templates are inserted as a copy into the screen you are on in the Studio.' : 'Screen templates are added as a new screen of the app you are editing.'} Choose the app; the Studio opens with the template ready to bind.
          </DialogDescription>
        </DialogHeader>
        {apps.length === 0 ? <p className="text-sm text-muted-foreground">There is no app yet: create one on the Apps page first.</p> : (
          <select className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={appId} onChange={(e) => setAppId(e.target.value)} data-testid="tpl-open-app">
            {apps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!appId || !template} data-testid="tpl-open-go" onClick={() => { if (template) location.hash = studioWithTemplate(appId, template.id) }}>Open in the Studio</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const UNINSTALL_KIND: Record<UninstallItem['kind'], string> = { app: 'App', table: 'Table', role: 'Role', flow: 'Flow', solution: 'Solution', approvalPolicy: 'Approval policy', dashboard: 'Dashboard', printTemplate: 'Print template', numberSequence: 'Number sequence' }

/** "Remove sample data": exactly the SAMPLE rows the install added (rows people added, and SAMPLE rows they still use, stay) */
function SampleDialog({ rec, onClose, onDone }: { rec: TemplateInstallRecord | null; onClose(): void; onDone(): void }) {
  const { toast, fail } = useToast()
  const [busy, setBusy] = useState(false)
  const run = async () => {
    if (!rec) return
    setBusy(true)
    try {
      const r = await removeSample(rec.id)
      await platform.init().catch(() => undefined)
      toast(`Removed ${r.removed} SAMPLE row${r.removed === 1 ? '' : 's'}${r.kept.length ? `; ${r.kept.length} kept because your rows use them` : ''}`, 'success')
      onDone()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={!!rec} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent data-testid="tpl-sample-dialog">
        <DialogHeader>
          <DialogTitle>Remove the sample data of "{rec?.name}"</DialogTitle>
          <DialogDescription>Deletes the {rec?.sampleRemaining ?? 0} SAMPLE rows this template added (they are recorded by id). Rows you added stay; a SAMPLE row one of your rows still points at stays too.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={() => void run()} disabled={busy} data-testid="tpl-sample-go">{busy ? <Spinner /> : <Eraser />} Remove sample data</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** "Switch on these flows" (rule 8: the flows of a pack arrive turned off; an administrator switches them on explicitly) */
function FlowsDialog({ rec, onClose, onDone }: { rec: TemplateInstallRecord | null; onClose(): void; onDone(): void }) {
  const { toast, fail } = useToast()
  const [pick, setPick] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  useEffect(() => { setPick(new Set()) }, [rec])
  const run = async () => {
    if (!rec) return
    setBusy(true)
    try {
      await enableFlows(rec.id, [...pick])
      toast(`Switched on ${pick.size} flow${pick.size === 1 ? '' : 's'}`, 'success')
      onDone()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={!!rec} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent data-testid="tpl-flows-dialog">
        <DialogHeader>
          <DialogTitle>Switch on the flows of "{rec?.name}"</DialogTitle>
          <DialogDescription>They arrived turned off. Once on, they run as their owner (the administrator who installed the template). Recorded in the audit log.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          {(rec?.flowsOff ?? []).map((f) => (
            <label key={f.id} className="flex items-center gap-2 text-sm">
              <Checkbox checked={pick.has(f.id)} disabled={busy} data-testid={`tpl-flow-${f.id}`} onCheckedChange={(v) => { const n = new Set(pick); if (v === true) n.add(f.id); else n.delete(f.id); setPick(n) }} />
              {f.name}
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void run()} disabled={busy || !pick.size} data-testid="tpl-flows-go">{busy ? <Spinner /> : <Workflow />} Switch on</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function UninstallDialog({ rec, onClose, onDone }: { rec: TemplateInstallRecord | null; onClose(): void; onDone(): void }) {
  const { toast, fail } = useToast()
  const [plan, setPlan] = useState<UninstallPlan | null>(null)
  const [del, setDel] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState('')
  useEffect(() => {
    if (!rec) return
    setPlan(null); setTyped(''); setRefused('')
    void planUninstall(rec.id, del).then(setPlan, (e) => fail(e))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec, del])
  useEffect(() => { if (!rec) setDel(false) }, [rec])
  const losing = !!plan?.items.some((i) => i.kind === 'table' && i.action === 'removed' && (i.rows ?? 0) > 0)
  const run = async (proceedWithoutBackup = false) => {
    if (!rec || !plan) return
    setBusy(true)
    try {
      await uninstall(rec.id, { confirm: plan.token, deleteTables: del, ...(losing ? { confirmText: typed } : {}), ...(proceedWithoutBackup ? { proceedWithoutBackup: true } : {}) })
      await platform.init().catch(() => undefined)
      toast(`Uninstalled "${rec.name}"`, 'success')
      onDone()
    } catch (e) {
      if (isBackupRefusal(e)) setRefused(errMsg(e))
      else fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={!!rec} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl" data-testid="tpl-uninstall">
        <DialogHeader>
          <DialogTitle>Uninstall "{rec?.name}"</DialogTitle>
          <DialogDescription>Removes the apps, flows, roles, approval policies, dashboards and print templates the template created. Tables with data stay unless you tick delete below; tables it did not create are never touched.</DialogDescription>
        </DialogHeader>
        {!plan ? <div className="grid place-items-center py-6"><Spinner /></div> : (
          <div className="grid gap-3">
            {plan.problems.length > 0 && <div className="grid gap-1 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive" role="alert" data-testid="tpl-uninstall-problems">{plan.problems.map((p) => <span key={p}>{p}</span>)}</div>}
            <div className="max-h-64 overflow-auto rounded-md border border-border" data-testid="tpl-uninstall-items">
              {plan.items.length === 0 && <p className="p-3 text-sm text-muted-foreground">Nothing is left to remove.</p>}
              {plan.items.map((i) => (
                <div key={`${i.kind}:${i.id}`} className={cn('flex items-start gap-2 border-b border-border px-3 py-2 text-sm last:border-0', i.destructive && 'bg-rose-500/5')} data-testid={`tpl-uninstall-${i.kind}-${i.action}`}>
                  <span className="w-28 shrink-0 text-xs text-muted-foreground">{UNINSTALL_KIND[i.kind] ?? i.kind}</span>
                  <span className="font-medium">{i.name}</span>
                  <span className={cn('ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium', i.action === 'removed' ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300' : 'bg-muted text-muted-foreground')}>{i.action}</span>
                  {i.note && <span className="basis-full pl-[7.5rem] text-xs text-muted-foreground">{i.note}</span>}
                </div>
              ))}
            </div>
            {plan.tablesWithData.length > 0 && (
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={del} onCheckedChange={(v) => setDel(v === true)} className="mt-0.5" data-testid="tpl-uninstall-delete" />
                <span>Also delete the tables with data ({plan.tablesWithData.map((t) => `${t.name}: ${t.rows} rows`).join(', ')}). Administrators only; the rows cannot be brought back except from a backup.</span>
              </label>
            )}
            {losing && (
              <div className="grid gap-1">
                <label className="text-xs" htmlFor="tpl-confirm-text">Type <b>{plan.confirmText}</b> to confirm</label>
                <Input id="tpl-confirm-text" value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="tpl-uninstall-confirm-text" />
              </div>
            )}
            {plan.warnings.map((w) => <p key={w} className="text-xs text-muted-foreground">{w}</p>)}
            <p className="text-xs text-muted-foreground">{plan.backup.message}</p>
            {refused && <BackupRefusal message={refused} busy={busy} onProceed={() => void run(true)} label="Uninstall without a backup" />}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="destructive" data-testid="tpl-uninstall-go" disabled={!plan || plan.problems.length > 0 || busy || (losing && typed !== plan.confirmText)} onClick={() => void run()}>{busy ? <Spinner /> : <Trash2 />} Uninstall</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function UpgradeDialog({ rec, onClose, onDone }: { rec: TemplateInstallRecord | null; onClose(): void; onDone(): void }) {
  const { toast, fail } = useToast()
  const [choices, setChoices] = useState<Record<string, 'keep' | 'replace'>>({})
  const [up, setUp] = useState<UpgradePlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState('')
  const { ok: confirmed, box } = useConfirmable(up?.plan ?? null)
  const widening = useWideningConsent(up?.widens, up?.plan.token)
  const ok = confirmed && widening.ok
  useEffect(() => {
    if (!rec) return
    setUp(null)
    void planUpgrade(rec.id, choices).then(setUp, (e) => fail(e))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec, choices])
  useEffect(() => { if (!rec) { setChoices({}); setRefused('') } }, [rec])
  const run = async (proceedWithoutBackup = false) => {
    if (!rec || !up) return
    setBusy(true)
    try {
      await upgrade(rec.id, { confirm: up.plan.token, choices, ...(proceedWithoutBackup ? { proceedWithoutBackup: true } : {}), ...(widening.accepted ? { acceptWidening: true } : {}) })
      await platform.init().catch(() => undefined)
      toast(`Upgraded "${rec.name}" to v${up.to}`, 'success')
      onDone()
    } catch (e) {
      if (isBackupRefusal(e)) setRefused(errMsg(e))
      else fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={!!rec} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl" data-testid="tpl-upgrade">
        <DialogHeader>
          <DialogTitle>Upgrade "{rec?.name}"</DialogTitle>
          <DialogDescription>A Linked template is upgraded in place, like a solution: review the plan; it runs in one transaction after a backup.</DialogDescription>
        </DialogHeader>
        {!up ? <div className="grid place-items-center py-6"><Spinner /></div> : (
          <div className="grid gap-3">
            {up.localChanges.length > 0 && (
              <div className="grid gap-1.5 rounded-md border border-border p-2.5 text-sm" data-testid="tpl-local-changes">
                <span className="text-xs font-semibold">Changed here since the template delivered it</span>
                {up.localChanges.map((l) => (
                  <label key={l.key} className="flex items-center gap-2">
                    <span className="flex-1">{LOCAL_CHANGE_LABEL[l.kind] ?? l.kind} {l.name}</span>
                    <select className="h-8 rounded-md border border-input bg-background px-2 text-sm" value={choices[l.key] ?? l.choice} data-testid={`tpl-local-${l.key}`} onChange={(e) => setChoices({ ...choices, [l.key]: e.target.value as 'keep' | 'replace' })}>
                      <option value="keep">Keep my changes</option>
                      <option value="replace">Replace with v{up.to}</option>
                    </select>
                  </label>
                ))}
              </div>
            )}
            {up.noLongerUsed && up.noLongerUsed.length > 0 && (
              <div className="grid gap-0.5 rounded-md border border-border p-2.5 text-xs text-muted-foreground" data-testid="tpl-no-longer-used">
                <span className="font-semibold text-foreground">Kept here although the new version no longer has them (data is never removed by an upgrade)</span>
                {up.noLongerUsed.map((n) => <span key={n}>{n}</span>)}
              </div>
            )}
            {widening.box}
            <PlanView plan={up.plan} />
            {box}
            {refused && <BackupRefusal message={refused} busy={busy} onProceed={() => void run(true)} />}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button disabled={!up || !ok || busy} onClick={() => void run()} data-testid="tpl-upgrade-go">{busy ? <Spinner /> : <RefreshCw />} Upgrade to v{up?.to ?? ''}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Detail({ summary, onUse }: { summary: TemplateSummary; onUse(): void }) {
  const [d, setD] = useState<TemplateDetail | null>(null)
  useEffect(() => { setD(null); void fetchTemplate(summary.id).then(setD, () => setD(null)) }, [summary.id])
  const Icon = KIND_ICON[summary.kind]
  const usable = summary.integrity !== 'damaged' && !summary.tooNew
  return (
    <div className="grid content-start gap-3 rounded-lg border border-border bg-card p-4" data-testid="tpl-detail" data-template={summary.id}>
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-5 text-primary" />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">{summary.name}</h2>
          <p className="text-xs text-muted-foreground">{KIND_LABEL[summary.kind]} template · v{summary.version}{summary.publisher ? ` · ${summary.publisher}` : ''} · needs Appbuilder {summary.minPlatformVersion} or newer</p>
        </div>
        <Button onClick={onUse} disabled={!usable} data-testid="tpl-use"><LayoutTemplate /> Use</Button>
      </div>
      <p className="text-sm">{summary.description}</p>
      <div className={cn('flex items-start gap-1.5 text-xs', summary.integrity === 'damaged' ? 'text-destructive' : 'text-emerald-700 dark:text-emerald-300')} data-testid="tpl-integrity">
        {summary.integrity === 'damaged' ? <ShieldAlert className="size-3.5" /> : <ShieldCheck className="size-3.5" />} {summary.integrityNote}
      </div>
      {summary.tooNew && <p className="text-xs text-destructive">This template needs a newer Appbuilder.</p>}
      <div className="grid gap-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What it contains</h3>
        <ul className="list-inside list-disc text-sm" data-testid="tpl-contains">{summary.contains.map((c) => <li key={c}>{c}</li>)}</ul>
      </div>
      <div className="grid gap-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What it needs</h3>
        <ul className="list-inside list-disc text-sm" data-testid="tpl-needs">{summary.needs.map((c) => <li key={c}>{c}</li>)}</ul>
      </div>
      {d && d.roles.length > 0 && <p className="text-xs text-muted-foreground">Roles: {d.roles.join(', ')} (created when an administrator installs it).</p>}
      <p className="text-xs text-muted-foreground">
        {summary.modes.includes('linked') ? 'Copy (yours to edit, no updates) or Linked (versioned: updates arrive as an upgrade plan; your local changes are listed and kept or replaced by choice).' : 'Copy only: it becomes part of your app, yours to edit, without updates.'}
      </p>
    </div>
  )
}

export function TemplatesPage() {
  const { fail } = useToast()
  const mode = usePlatform((s) => s.mode)
  const [items, setItems] = useState<TemplateSummary[] | null>(null)
  const [installed, setInstalled] = useState<TemplateInstallRecord[]>([])
  const [kind, setKind] = useState<TemplateKind | 'all'>('all')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [use, setUse] = useState<string | null>(null)
  const [inStudio, setInStudio] = useState<TemplateSummary | null>(null)
  const [unin, setUnin] = useState<TemplateInstallRecord | null>(null)
  const [upg, setUpg] = useState<TemplateInstallRecord | null>(null)
  const [smp, setSmp] = useState<TemplateInstallRecord | null>(null)
  const [flw, setFlw] = useState<TemplateInstallRecord | null>(null)
  const isAdmin = usePlatform((s) => !!s.session?.privileges.isAdmin)
  const load = () => {
    void fetchCatalogue().then((l) => { setItems(l); setSel((s) => s ?? l[0]?.id ?? null) }, (e) => { setItems([]); fail(e) })
    void fetchInstalled().then(setInstalled, () => setInstalled([]))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (mode === 'server') load() }, [mode])
  const shown = useMemo(() => (items ?? []).filter((t) => (kind === 'all' || t.kind === kind) && (!q.trim() || `${t.name} ${t.description} ${t.tags.join(' ')}`.toLowerCase().includes(q.trim().toLowerCase()))), [items, kind, q])
  const current = (items ?? []).find((t) => t.id === sel) ?? null
  if (mode !== 'server') return <Empty icon={LayoutTemplate} title="Templates need the server" description="The catalogue installs into an environment on the server; it is not available in the demo." />
  const startUse = (t: TemplateSummary) => (t.kind === 'component' || t.kind === 'screen' ? setInStudio(t) : setUse(t.id))
  return (
    <div className="grid gap-4 p-6" data-testid="templates-page">
      <PageHeader title="Templates" icon={LayoutTemplate} subtitle="Ready-made UI components, screens, apps, data models and solutions. Using one never overwrites anything you have; install in a sandbox first, then Deploy." />
      <div className="flex flex-wrap items-center gap-2">
        {(['all', ...TEMPLATE_KINDS] as const).map((k) => (
          <Button key={k} size="sm" variant={kind === k ? 'default' : 'outline'} onClick={() => setKind(k)} data-testid={`tpl-kind-${k}`}>{k === 'all' ? 'All' : KIND_PLURAL[k]}</Button>
        ))}
        <div className="relative ml-auto w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-8 pl-8" placeholder="Search templates" value={q} onChange={(e) => setQ(e.target.value)} data-testid="tpl-search" />
        </div>
      </div>
      {!items ? <div className="grid place-items-center py-10"><Spinner /></div> : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="grid content-start gap-2" data-testid="tpl-list">
            {shown.length === 0 && <p className="text-sm text-muted-foreground">No template matches.</p>}
            {shown.map((t) => {
              const Icon = KIND_ICON[t.kind]
              return (
                <button key={t.id} type="button" onClick={() => setSel(t.id)} data-testid={`tpl-card-${t.id}`}
                  className={cn('grid gap-1 rounded-lg border p-3 text-left transition-colors hover:border-primary/50', sel === t.id ? 'border-primary bg-primary/5' : 'border-border bg-card')}>
                  <span className="flex items-center gap-2"><Icon className="size-4 text-primary" /><span className="font-medium">{t.name}</span><Badge variant="outline" className="ml-auto">{KIND_LABEL[t.kind]}</Badge></span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">{t.description}</span>
                  {t.integrity === 'damaged' && <span className="text-xs text-destructive">Damaged: cannot be used</span>}
                </button>
              )
            })}
          </div>
          {current ? <Detail summary={current} onUse={() => startUse(current)} /> : <div />}
        </div>
      )}
      <div className="grid gap-2" data-testid="tpl-installed">
        <h2 className="text-sm font-semibold">Installed in this environment</h2>
        {installed.length === 0 ? <p className="text-sm text-muted-foreground">No template was used here yet.</p> : (
          <div className="overflow-hidden rounded-lg border border-border">
            {installed.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm last:border-0" data-testid={`tpl-installed-${r.id}`} data-template={r.templateId} data-status={r.status}>
                <CheckCircle2 className={cn('size-4', r.status === 'installed' ? 'text-emerald-600' : 'text-muted-foreground')} />
                <span className="font-medium">{r.name}</span>
                <span className="text-xs text-muted-foreground">{KIND_LABEL[r.kind]} · v{r.templateVersion} · {r.mode === 'linked' ? 'Linked' : 'Copy'} · {fmtDate(r.installedOn)}</span>
                <span className="text-xs text-muted-foreground">
                  {[r.created.apps.length ? `app ${r.created.apps.map((a) => a.name).join(', ')}` : '', r.created.tables.length ? `tables ${r.created.tables.map((t) => t.name).join(', ')}` : '', r.created.mapped.length ? `uses ${r.created.mapped.map((m) => m.name).join(', ')}` : '', r.created.target?.appName ? `into ${r.created.target.appName}` : ''].filter(Boolean).join(' · ')}
                </span>
                {r.status === 'uninstalled' && <Badge variant="outline">uninstalled</Badge>}
                {r.status === 'installed' && r.dependsOn && r.dependsOn.length > 0 && <span className="text-xs text-muted-foreground" data-testid={`tpl-needs-${r.id}`}>needs {r.dependsOn.map((d) => d.name).join(', ')}</span>}
                {r.status === 'installed' && r.usedBy && r.usedBy.length > 0 && <span className="text-xs text-muted-foreground" data-testid={`tpl-usedby-${r.id}`}>used by {r.usedBy.map((d) => d.name).join(', ')}</span>}
                <span className="ml-auto flex gap-1.5">
                  {r.flowsOff && r.flowsOff.length > 0 && isAdmin && <Button size="xs" variant="outline" onClick={() => setFlw(r)} data-testid={`tpl-flows-${r.id}`}><Workflow /> Switch on {r.flowsOff.length} flow{r.flowsOff.length === 1 ? '' : 's'}</Button>}
                  {r.sampleRemaining ? <Button size="xs" variant="outline" onClick={() => setSmp(r)} data-testid={`tpl-sample-remove-${r.id}`}><Eraser /> Remove sample data</Button> : null}
                  {r.upgradeTo && <Button size="xs" variant="outline" onClick={() => setUpg(r)} data-testid={`tpl-upgrade-${r.id}`}><RefreshCw /> Upgrade to v{r.upgradeTo}</Button>}
                  {r.created.apps[0] && r.status === 'installed' && <Button size="xs" variant="ghost" onClick={() => go({ page: 'studio', id: r.created.apps[0].id })}>Open app</Button>}
                  {r.canUninstall && <Button size="xs" variant="outline" onClick={() => setUnin(r)} data-testid={`tpl-uninstall-${r.id}`}><Trash2 /> Uninstall</Button>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <UseTemplateDialog open={!!use} onOpenChange={(o) => !o && setUse(null)} templateId={use} onInstalled={() => load()} />
      <OpenInStudioDialog template={inStudio} onClose={() => setInStudio(null)} />
      <UninstallDialog rec={unin} onClose={() => setUnin(null)} onDone={() => { setUnin(null); load() }} />
      <UpgradeDialog rec={upg} onClose={() => setUpg(null)} onDone={() => { setUpg(null); load() }} />
      <SampleDialog rec={smp} onClose={() => setSmp(null)} onDone={() => { setSmp(null); load() }} />
      <FlowsDialog rec={flw} onClose={() => setFlw(null)} onDone={() => { setFlw(null); load() }} />
    </div>
  )
}
