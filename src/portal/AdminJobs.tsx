/**
 * Admin console: Jobs (queue metrics, jobs by state with retry and cancel, schedules with enable / run now and the
 * retention settings) and the Events run log (docs/admin/jobs.md). Server mode only; one environment at a time.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Ban, Play, RefreshCw, RotateCcw } from 'lucide-react'
import { usePlatform } from '@/platform'
import type { EventRunEntry, JobInfo, JobMetrics, JobState, ScheduleInfo } from '@/platform/events'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Empty, Panel, Segmented, errMsg, fmtDate, fmtRelative, useToast } from './kit'
import { useCaps } from './security'
import { cancelJob, fetchEventRuns, fetchJobMetrics, fetchJobs, fetchSchedules, retryJob, runSchedule, updateSchedule } from './eventsApi'
import { RunStatus } from './TableLogic'

type Title = (title: string, subtitle?: ReactNode, actions?: ReactNode) => ReactNode

function ServerOnly() {
  return <Empty icon={Play} title="Needs the server" description="Jobs, schedules and table events run on the Appbuilder server; the browser-only demo has none." />
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'bad' }) {
  return (
    <Panel className="p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${tone === 'bad' ? 'text-destructive' : ''}`}>{value}</div>
    </Panel>
  )
}

const STATE_TONE: Record<JobState, 'default' | 'secondary' | 'destructive' | 'outline'> = { queued: 'outline', running: 'default', succeeded: 'secondary', failed: 'destructive', dead: 'destructive', cancelled: 'outline' }
const FILTERS = [
  { value: 'active', label: 'Waiting and running' }, { value: 'failed', label: 'Failed' }, { value: 'dead', label: 'Dead' }, { value: 'succeeded', label: 'Succeeded' }, { value: '', label: 'All' },
] as const
type Filter = (typeof FILTERS)[number]['value']

const ago = (s: number) => (s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`)

export function JobsSection({ title }: { title: Title }) {
  const caps = useCaps()
  const env = usePlatform((s) => s.environments.find((e) => e.id === s.environmentId)?.name)
  const { fail, toast } = useToast()
  const [m, setM] = useState<JobMetrics | null>(null)
  const [filter, setFilter] = useState<Filter>('active')
  const [jobs, setJobs] = useState<{ items: JobInfo[]; total: number } | null>(null)
  const [schedules, setSchedules] = useState<ScheduleInfo[] | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    if (!caps.server) return
    Promise.all([fetchJobMetrics(), fetchJobs({ state: filter, limit: 50 }), fetchSchedules()])
      .then(([a, b, c]) => { setM(a); setJobs(b); setSchedules(c); setError('') })
      .catch((e) => setError(errMsg(e)))
  }, [caps.server, filter])
  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [load])
  if (!caps.server) return <ServerOnly />
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn()
      toast(done, 'success')
      load()
    } catch (e) { fail(e) }
  }
  return (
    <div data-testid="admin-jobs">
      {title('Jobs', <>Background work of {env ? <b>{env}</b> : 'this environment'}: table events after a save, rollups, backfills, index builds and scheduled maintenance. Failed jobs are retried with growing pauses; after the last attempt they are dead and wait for you here.</>,
        <Button variant="outline" size="sm" onClick={load}><RefreshCw /> Refresh</Button>)}
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      {m && (
        <div className="mb-5 grid grid-cols-3 gap-3 lg:grid-cols-6" data-testid="job-metrics">
          <Stat label="Waiting" value={m.states.queued + m.states.failed} />
          <Stat label="Running" value={m.states.running} />
          <Stat label="Oldest waiting" value={m.oldestQueuedSeconds ? ago(m.oldestQueuedSeconds) : '-'} />
          <Stat label="Failures (24 h)" value={m.failures24h} tone={m.failures24h ? 'bad' : undefined} />
          <Stat label="Dead" value={m.dead} tone={m.dead ? 'bad' : undefined} />
          <Stat label="Done (last hour)" value={m.succeededLastHour} />
        </div>
      )}
      {m && (
        <p className="mb-4 text-xs text-muted-foreground">
          Worker {m.worker.id}: {m.worker.running} of {m.worker.concurrency} slots busy, {m.worker.listening ? 'woken instantly by the database' : `checking every ${m.worker.pollMs} ms`}. Outbox: {m.outbox.pending} change{m.outbox.pending === 1 ? '' : 's'} waiting{m.outbox.pending ? ` (oldest ${ago(m.outbox.oldestSeconds)})` : ''}.
        </p>
      )}
      <div className="mb-2 flex items-center gap-3">
        <Segmented label="Jobs to show" size="sm" value={filter} onChange={setFilter} options={FILTERS.map((f) => ({ value: f.value, label: f.label }))} />
        {jobs && <span className="text-xs text-muted-foreground">{jobs.total} job{jobs.total === 1 ? '' : 's'}</span>}
      </div>
      <Panel className="mb-8 divide-y divide-border" data-testid="job-list">
        {jobs && !jobs.items.length && <p className="p-4 text-sm text-muted-foreground">No jobs here.</p>}
        {jobs?.items.map((j) => (
          <div key={j.id} className="grid grid-cols-[86px_minmax(0,200px)_minmax(0,1fr)_auto] items-start gap-3 px-3 py-2 text-xs">
            <Badge variant={STATE_TONE[j.state]} className="justify-center">{j.state}</Badge>
            <div className="min-w-0"><div className="truncate font-medium">{j.type}</div><div className="text-muted-foreground">{fmtRelative(j.createdOn)} · attempt {j.attempts}/{j.maxAttempts}</div></div>
            <div className="min-w-0">
              {j.error && <div className="text-destructive" data-testid="job-error">{j.error.message}</div>}
              {j.state === 'failed' && <div className="text-muted-foreground">Next try {fmtDate(j.runAt)}</div>}
              <code className="block truncate text-muted-foreground">{JSON.stringify(j.payload)}</code>
            </div>
            <div className="flex gap-1">
              {(j.state === 'failed' || j.state === 'dead' || j.state === 'cancelled') && <Button variant="outline" size="sm" onClick={() => void act(() => retryJob(j.id), 'Queued again')} data-testid="job-retry"><RotateCcw /> Retry</Button>}
              {(j.state === 'queued' || j.state === 'failed') && <Button variant="ghost" size="sm" onClick={() => void act(() => cancelJob(j.id), 'Cancelled')} data-testid="job-cancel"><Ban /> Cancel</Button>}
            </div>
          </div>
        ))}
      </Panel>
      <h3 className="mb-1 text-sm font-semibold">Schedules</h3>
      <p className="mb-2 text-xs text-muted-foreground">Times are in each schedule's time zone. A slot missed while the server was off runs once when it is back. Retention: how many days of old outbox rows, run log entries and finished jobs (or audit entries) to keep.</p>
      <Panel className="divide-y divide-border" data-testid="schedule-list">
        {schedules?.map((s) => <ScheduleRow key={s.id} s={s} onChange={load} />)}
      </Panel>
    </div>
  )
}

function ScheduleRow({ s, onChange }: { s: ScheduleInfo; onChange(): void }) {
  const { fail, toast } = useToast()
  const p = (s.payload ?? {}) as Record<string, unknown>
  const [days, setDays] = useState(String(p.days ?? ''))
  useEffect(() => setDays(String(p.days ?? '')), [p.days])
  const retention = typeof p.days === 'number'
  const save = (patch: Partial<ScheduleInfo>, msg: string) => updateSchedule(s.id, patch).then(() => { toast(msg, 'success'); onChange() }).catch(fail)
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 px-3 py-2 text-sm" data-testid="schedule-row">
      <Switch checked={s.enabled} onCheckedChange={(v) => void save({ enabled: v }, v ? 'Schedule on' : 'Schedule off')} aria-label={`${s.name} enabled`} />
      <div className="min-w-0">
        <div className="truncate font-medium">{s.name} {s.builtIn && <Badge variant="outline">Built in</Badge>}</div>
        <div className="text-xs text-muted-foreground">
          {s.cron ? <code>{s.cron}</code> : `every ${s.intervalSeconds} s`} {s.timeZone} · {s.jobType}
          {s.enabled && s.nextRunAt ? ` · next ${fmtDate(s.nextRunAt)}` : ''}{s.lastRunAt ? ` · last ${fmtRelative(s.lastRunAt)}${s.lastJobState ? ` (${s.lastJobState})` : ''}` : ''}
        </div>
      </div>
      {retention ? (
        <label className="flex items-center gap-1.5 text-xs">Keep <Input className="h-7 w-16" value={days} onChange={(e) => setDays(e.target.value)} onBlur={() => { if (days !== String(p.days)) void save({ payload: { ...p, days: Number(days) } }, 'Retention saved') }} inputMode="numeric" aria-label="Days to keep" /> days</label>
      ) : <span />}
      <Button variant="outline" size="sm" onClick={() => runSchedule(s.id).then(() => { toast('Started', 'success'); onChange() }).catch(fail)} data-testid="schedule-run"><Play /> Run now</Button>
    </div>
  )
}

export function EventRunsSection({ title }: { title: Title }) {
  const caps = useCaps()
  const tables = usePlatform((s) => s.tables)
  const [tableId, setTableId] = useState('')
  const [status, setStatus] = useState<'' | 'failed' | 'rejected' | 'ok' | 'skipped'>('')
  const [items, setItems] = useState<EventRunEntry[] | null>(null)
  const load = useCallback(() => {
    if (caps.server) fetchEventRuns({ tableId, status, limit: 200 }).then(setItems).catch(() => setItems([]))
  }, [caps.server, tableId, status])
  useEffect(load, [load])
  if (!caps.server) return <ServerOnly />
  const name = (id: string) => tables.find((t) => t.id === id)?.displayName ?? id
  return (
    <div data-testid="admin-event-runs">
      {title('Events run log', 'Every table event that did something, every refused save and every failure, newest first. Entries are kept for 30 days (see the retention schedule on the Jobs page).',
        <Button variant="outline" size="sm" onClick={load}><RefreshCw /> Refresh</Button>)}
      <div className="mb-3 flex gap-3">
        <Select value={tableId || '__all'} onValueChange={(v) => setTableId(v === '__all' ? '' : v)}>
          <SelectTrigger size="sm" className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="__all">All tables</SelectItem>{tables.map((t) => <SelectItem key={t.id} value={t.id}>{t.displayName}</SelectItem>)}</SelectContent>
        </Select>
        <Segmented label="Status" size="sm" value={status} onChange={setStatus} options={[{ value: '', label: 'All' }, { value: 'failed', label: 'Failed' }, { value: 'rejected', label: 'Refused' }, { value: 'ok', label: 'OK' }, { value: 'skipped', label: 'Skipped' }]} />
      </div>
      <Panel className="divide-y divide-border">
        {items && !items.length && <p className="p-4 text-sm text-muted-foreground">No runs.</p>}
        {items?.map((r) => (
          <div key={r.id} className="grid grid-cols-[76px_minmax(0,140px)_minmax(0,180px)_90px_60px_minmax(0,1fr)] items-center gap-3 px-3 py-2 text-xs">
            <RunStatus s={r.status} />
            <span className="truncate">{name(r.tableId)}</span>
            <span className="truncate font-medium">{r.eventName}</span>
            <span className="text-muted-foreground">{r.timing} {r.op}</span>
            <span className="text-right tabular-nums text-muted-foreground">{r.durationMs} ms</span>
            <span className="truncate" title={r.message}>{r.message ?? ''} <span className="text-muted-foreground">{fmtRelative(r.at)}</span></span>
          </div>
        ))}
      </Panel>
    </div>
  )
}
