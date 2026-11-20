/**
 * Email snapshots of a dashboard (P2-C): the dashboard as a PDF by email on a schedule. Server only (server/core/dashboards/
 * snapshots.ts): list, create, edit, pause / resume, delete, "Send now" and the run history with each recipient's result
 * and the reason a recipient was skipped. Every recipient's copy is computed with THAT recipient's own access; someone who
 * cannot open the dashboard gets nothing. The schedule and recipient fields are the scheduled reports' (same shapes, same
 * rules, same wording as src/portal/Reports.tsx: both use the ONE shared ScheduleFields and RecipientFields of
 * src/portal/ScheduleFields.tsx). Everything happens inside the sheet (a dialog would open behind it).
 */
import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, History, Mail, Pause, Pencil, Play, Plus, Send, Trash2, TriangleAlert } from 'lucide-react'
import { usePlatform } from '@/platform'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import type { DashboardDef, DashboardInfo } from '@/dashboards/types'
import { RANGE_PRESETS } from '@/dashboards/dates'
import type { RangePreset } from '@/dashboards/dates'
import type { ReportSchedule } from '../actionsApi'
import { errMsg, fmtRelative, useToast } from '../kit'
import { dashboardsApi } from './api'
import type { SnapshotInfo, SnapshotInput, SnapshotRun } from './api'
import { sel } from './ConditionBuilder'
import { RecipientFields, ScheduleFields, browserZone } from '../ScheduleFields'

export const SNAPSHOT_RULE = 'Each recipient gets the dashboard computed with their own access: only the rows and columns they may see. Someone who cannot open this dashboard gets nothing, and the history says why.'

type View = { kind: 'list' } | { kind: 'edit'; snap: SnapshotInfo | null } | { kind: 'runs'; snap: SnapshotInfo }

export function SnapshotsSheet({ info, def, onClose }: { info: DashboardInfo; def: DashboardDef; onClose(): void }) {
  const [view, setView] = useState<View>({ kind: 'list' })
  const [items, setItems] = useState<SnapshotInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const load = useCallback(() => { dashboardsApi.snapshots(info.id).then((x) => { setItems(x); setLoadError(null) }, (e) => setLoadError(errMsg(e))) }, [info.id])
  useEffect(load, [load])
  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-2xl" data-testid="snapshots-sheet" onInteractOutside={(e) => e.preventDefault()}>
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2"><Mail className="size-4" /> Email snapshots</SheetTitle>
          <SheetDescription>The dashboard "{info.name}" as a PDF by email, on a schedule. {SNAPSHOT_RULE}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto">
          {view.kind === 'list' && <SnapshotList items={items} loadError={loadError} reload={load} onEdit={(s) => setView({ kind: 'edit', snap: s })} onRuns={(s) => setView({ kind: 'runs', snap: s })} />}
          {view.kind === 'edit' && <SnapshotEditor dashboardId={info.id} def={def} snap={view.snap} onDone={(changed) => { if (changed) load(); setView({ kind: 'list' }) }} />}
          {view.kind === 'runs' && <SnapshotRuns snap={view.snap} onBack={() => setView({ kind: 'list' })} />}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function SnapshotList({ items, loadError, reload, onEdit, onRuns }: { items: SnapshotInfo[] | null; loadError: string | null; reload(): void; onEdit(s: SnapshotInfo | null): void; onRuns(s: SnapshotInfo): void }) {
  const { toast, fail } = useToast()
  const [confirm, setConfirm] = useState<string | null>(null)
  const sendNow = async (s: SnapshotInfo) => {
    try {
      await dashboardsApi.runSnapshot(s.id)
      toast(s.canEdit ? 'The snapshot is being sent to its recipients.' : 'Your copy is being sent.', 'success')
      setTimeout(reload, 2000)
    } catch (e) { fail(e) }
  }
  const toggle = async (s: SnapshotInfo) => { try { await dashboardsApi.updateSnapshot(s.id, { enabled: !s.enabled }); reload() } catch (e) { fail(e) } }
  const remove = async (s: SnapshotInfo) => { try { await dashboardsApi.removeSnapshot(s.id); setConfirm(null); toast('Snapshot deleted.', 'success'); reload() } catch (e) { fail(e) } }
  return (
    <section className="grid gap-3 p-4" aria-label="Snapshots">
      <div className="flex items-center">
        <h3 className="text-sm font-semibold">Snapshots of this dashboard</h3>
        <Button size="sm" className="ml-auto" onClick={() => onEdit(null)} data-testid="snapshot-new"><Plus /> New snapshot</Button>
      </div>
      {loadError ? <p className="text-sm text-destructive" role="alert">{loadError}</p> : !items ? <Spinner /> : !items.length ? (
        <p className="text-sm text-muted-foreground">None yet. You see the snapshots you made or receive (the dashboard's owner and administrators see all of them).</p>
      ) : (
        <ul className="grid gap-2" data-testid="snapshot-list">
          {items.map((s) => (
            <li key={s.id} className="rounded-md border bg-card p-3 text-sm" data-testid={`snapshot-${s.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{s.name}</span>
                {!s.enabled && <Badge variant="outline">paused</Badge>}
                <span className="text-xs text-muted-foreground">{s.scheduleText}{s.nextRunAt ? ` · next ${fmtRelative(s.nextRunAt)}` : ''}</span>
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {s.def.recipients.userIds.length} {s.def.recipients.userIds.length === 1 ? 'person' : 'people'}{s.def.recipients.teamIds.length ? `, ${s.def.recipients.teamIds.length} team${s.def.recipients.teamIds.length === 1 ? '' : 's'}` : ''}
                {' · '}{s.def.range ? RANGE_PRESETS.find((p) => p.key === s.def.range)?.label : 'the dashboard\'s own range'}
                {' · last run: '}{s.lastRun ? <span className={cn(s.lastRun.status === 'succeeded' ? '' : 'text-destructive')} data-testid={`snapshot-last-${s.id}`}>{s.lastRun.status} {fmtRelative(s.lastRun.startedOn)}{s.lastRun.message ? ` (${s.lastRun.message})` : ''}</span> : 'never'}
              </div>
              <div className="mt-2 flex flex-wrap justify-end gap-1">
                <Button size="xs" variant="outline" onClick={() => void sendNow(s)} data-testid={`snapshot-run-${s.id}`}><Send /> {s.canEdit ? 'Send now' : 'Send me a copy'}</Button>
                <Button size="xs" variant="ghost" onClick={() => onRuns(s)} data-testid={`snapshot-history-${s.id}`}><History /> History</Button>
                {s.canEdit && <Button size="xs" variant="ghost" onClick={() => void toggle(s)} data-testid={`snapshot-toggle-${s.id}`}>{s.enabled ? <><Pause /> Pause</> : <><Play /> Resume</>}</Button>}
                {s.canEdit && <Button size="xs" variant="ghost" onClick={() => onEdit(s)} data-testid={`snapshot-edit-${s.id}`}><Pencil /> Edit</Button>}
                {s.canEdit && confirm !== s.id && <Button size="xs" variant="ghost" aria-label={`Delete ${s.name}`} onClick={() => setConfirm(s.id)} data-testid={`snapshot-delete-${s.id}`}><Trash2 /></Button>}
              </div>
              {confirm === s.id && (
                <div className="mt-2 flex flex-wrap items-center justify-end gap-2 rounded-md bg-destructive/10 p-2 text-xs" data-testid={`snapshot-confirm-${s.id}`}>
                  <span className="mr-auto">Delete "{s.name}"? Its schedule and history go too; nobody gets it any more.</span>
                  <Button size="xs" variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
                  <Button size="xs" variant="destructive" onClick={() => void remove(s)} data-testid={`snapshot-delete-ok-${s.id}`}>Delete</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">Email must be set up by an administrator (Admin console &gt; Email). Every email has an unsubscribe link.</p>
    </section>
  )
}

function SnapshotEditor({ dashboardId, def, snap, onDone }: { dashboardId: string; def: DashboardDef; snap: SnapshotInfo | null; onDone(changed: boolean): void }) {
  const me = usePlatform((s) => s.session?.user.id ?? s.currentUserId)
  const d = snap?.def
  const [name, setName] = useState(d?.name ?? def.title)
  const [schedule, setSchedule] = useState<ReportSchedule>(d?.schedule ?? { frequency: 'daily', time: '08:00', timeZone: browserZone() })
  const [rec, setRec] = useState<{ userIds: string[]; teamIds: string[] }>(d?.recipients ?? { userIds: me ? [me] : [], teamIds: [] })
  const [range, setRange] = useState<RangePreset | ''>(d?.range ?? '')
  const [filters, setFilters] = useState<Record<string, string>>(d?.filters ?? {})
  const [enabled, setEnabled] = useState(snap?.enabled ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { toast } = useToast()
  const save = async () => {
    setBusy(true)
    setError(null)
    const body: SnapshotInput = { name: name.trim(), schedule, recipients: rec, range: range || null, filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), enabled }
    try {
      if (snap) await dashboardsApi.updateSnapshot(snap.id, body)
      else await dashboardsApi.createSnapshot(dashboardId, body)
      toast(snap ? 'Snapshot saved.' : 'Snapshot created.', 'success')
      onDone(true)
    } catch (e) { setError(errMsg(e)) } finally { setBusy(false) }
  }
  return (
    <section className="grid gap-4 p-4" aria-label={snap ? 'Edit snapshot' : 'New snapshot'} data-testid="snapshot-editor">
      <div className="flex items-center gap-2">
        <Button size="icon-sm" variant="ghost" aria-label="Back to the list" onClick={() => onDone(false)}><ArrowLeft /></Button>
        <h3 className="text-sm font-semibold">{snap ? `Edit "${snap.name}"` : 'New snapshot'}</h3>
      </div>
      <label className="grid gap-1 text-xs"><span className="font-medium text-muted-foreground">Name (the email's subject uses the dashboard's title)</span>
        <Input className="h-8" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} data-testid="snapshot-name" /></label>
      <ScheduleFields schedule={schedule} onChange={setSchedule} />
      <RecipientFields userIds={rec.userIds} teamIds={rec.teamIds} onChange={setRec} testPrefix="snapshot" noun="snapshots" />
      <p className="rounded-md bg-muted/60 p-2.5 text-xs" data-testid="snapshot-rule">{SNAPSHOT_RULE}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs"><span className="font-medium text-muted-foreground">Date range</span>
          <select className={sel} value={range} onChange={(e) => setRange(e.target.value as RangePreset | '')} data-testid="snapshot-range">
            <option value="">The dashboard's own ({RANGE_PRESETS.find((p) => p.key === def.range)?.label})</option>
            {RANGE_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select></label>
        {(def.filters ?? []).map((f) => (
          <label key={f.id} className="grid gap-1 text-xs"><span className="font-medium text-muted-foreground">{f.label}</span>
            {f.options.length ? (
              <select className={sel} value={filters[f.id] ?? ''} onChange={(e) => setFilters({ ...filters, [f.id]: e.target.value })} data-testid={`snapshot-filter-${f.id}`}>
                <option value="">All</option>{f.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : <Input className="h-8" value={filters[f.id] ?? ''} onChange={(e) => setFilters({ ...filters, [f.id]: e.target.value })} placeholder="All" data-testid={`snapshot-filter-${f.id}`} />}
          </label>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-primary" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} data-testid="snapshot-enabled" />Send on the schedule (unticked: paused; "Send now" still works)</label>
      {error && <p className="flex gap-1.5 text-xs text-destructive" role="alert"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" />{error}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => onDone(false)}>Cancel</Button>
        <Button size="sm" onClick={() => void save()} disabled={busy || !name.trim() || (!rec.userIds.length && !rec.teamIds.length)} data-testid="snapshot-save">{busy && <Spinner />} {snap ? 'Save' : 'Create snapshot'}</Button>
      </div>
    </section>
  )
}

function SnapshotRuns({ snap, onBack }: { snap: SnapshotInfo; onBack(): void }) {
  const users = usePlatform((s) => s.users)
  const me = usePlatform((s) => s.session?.user)
  const [runs, setRuns] = useState<SnapshotRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => { dashboardsApi.snapshotRuns(snap.id).then(setRuns, (e) => setError(errMsg(e))) }, [snap.id])
  useEffect(load, [load])
  const nameOf = (id: string) => users.find((u) => u.id === id)?.name ?? (me?.id === id ? me.name : id)
  return (
    <section className="grid gap-3 p-4" aria-label="History" data-testid="snapshot-runs">
      <div className="flex items-center gap-2">
        <Button size="icon-sm" variant="ghost" aria-label="Back to the list" onClick={onBack}><ArrowLeft /></Button>
        <h3 className="text-sm font-semibold">History of "{snap.name}"</h3>
        <Button size="xs" variant="outline" className="ml-auto" onClick={load}>Refresh</Button>
      </div>
      <p className="text-xs text-muted-foreground">Each run and what happened for each recipient.{snap.canEdit ? '' : ' You see your own line only.'}</p>
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : !runs ? <Spinner /> : !runs.length ? <p className="text-sm text-muted-foreground">No runs yet.</p> : (
        <ul className="grid gap-2">
          {runs.map((r) => (
            <li key={r.id} className="rounded-md border p-2 text-xs" data-testid={`snapshot-run-row-${r.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={r.status === 'succeeded' ? 'secondary' : r.status === 'running' ? 'outline' : 'destructive'}>{r.status}</Badge>
                <span>{fmtRelative(r.startedOn)}</span>
                <span className="text-muted-foreground">{r.trigger === 'manual' ? 'sent by hand' : 'on the schedule'}{r.message ? ` · ${r.message}` : ''}</span>
              </div>
              <ul className="mt-1 grid gap-0.5 pl-2">
                {(r.recipients ?? []).map((x) => (
                  <li key={x.userId} data-testid={`snapshot-recipient-${x.userId}`}>
                    <span className="font-medium">{nameOf(x.userId)}</span>: <span className={cn(x.status === 'failed' && 'text-destructive')}>{x.status === 'sent' ? `sent${x.pages ? ` (${x.pages} page${x.pages === 1 ? '' : 's'})` : ''}` : x.status === 'skipped' ? 'nothing sent' : 'failed'}</span>{x.reason ? `: ${x.reason}` : ''}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
