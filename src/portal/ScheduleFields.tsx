/**
 * The shared schedule and recipient fields (P3 package T, spec 5.10 / package D): ONE component for "when" and "who"
 * wherever the product asks for them, with the same behaviour and the same words.
 *
 *  - `ScheduleFields` layout "report" (default): the scheduled reports' and dashboard snapshots' When row (daily, weekdays,
 *    weekly on a day, monthly on a day, hourly at a minute, only by hand; time; time zone).
 *  - `ScheduleFields` layout "repeat": recurring tasks ("every N days / weeks on weekdays / months on day, at, time zone,
 *    until"; the value is stored in Activities.Recurrence, src/platform/recurrence.ts).
 *  - `RecipientFields`: people and teams; people who may not pick others subscribe only themselves.
 *
 * Used by src/portal/Reports.tsx, src/portal/dashboards/Snapshots.tsx and src/portal/TasksPage.tsx.
 */
import { usePlatform } from '@/platform'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { ReportSchedule } from './actionsApi'
import { useCaps } from './security'

export const fieldSelect = 'h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50'
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const browserZone = (): string => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } }

/** a scheduled report's schedule, plus the fields only the "repeat" layout uses (every N, several weekdays, until) */
export type ScheduleValue = ReportSchedule & { interval?: number; weekdays?: number[]; until?: string | null }

export function ScheduleFields<T extends ScheduleValue>({ schedule, onChange, testPrefix = 'snapshot', layout = 'report' }: { schedule: T; onChange(s: T): void; testPrefix?: string; layout?: 'report' | 'repeat' }) {
  if (layout === 'repeat') return <RepeatFields schedule={schedule} onChange={onChange} testPrefix={testPrefix} />
  return (
    <div className="grid grid-cols-[150px_1fr] items-end gap-3" data-testid={`${testPrefix}-schedule`}>
      <label className="grid gap-1 text-xs"><span className="font-medium text-muted-foreground">When</span>
        <select className={fieldSelect} value={schedule.frequency} onChange={(e) => onChange({ ...schedule, frequency: e.target.value as ReportSchedule['frequency'] })} data-testid={`${testPrefix}-frequency`}>
          {['daily', 'weekdays', 'weekly', 'monthly', 'hourly', 'manual'].map((f) => <option key={f} value={f}>{f === 'manual' ? 'only by hand' : f}</option>)}
        </select></label>
      <div className="flex flex-wrap items-center gap-2">
        {schedule.frequency === 'weekly' && <select className={fieldSelect} value={schedule.weekday ?? 1} onChange={(e) => onChange({ ...schedule, weekday: Number(e.target.value) })} aria-label="Weekday">{WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}</select>}
        {schedule.frequency === 'monthly' && <Input className="h-8 w-20" inputMode="numeric" value={String(schedule.day ?? 1)} onChange={(e) => onChange({ ...schedule, day: Number(e.target.value) || 1 })} aria-label="Day of month" />}
        {schedule.frequency === 'hourly' && <Input className="h-8 w-20" inputMode="numeric" value={String(schedule.minute ?? 0)} onChange={(e) => onChange({ ...schedule, minute: Number(e.target.value) || 0 })} aria-label="Minute" />}
        {['daily', 'weekdays', 'weekly', 'monthly'].includes(schedule.frequency) && <Input type="time" className="h-8 w-28" value={schedule.time ?? '08:00'} onChange={(e) => onChange({ ...schedule, time: e.target.value })} aria-label="Time" data-testid={`${testPrefix}-time`} />}
        {schedule.frequency !== 'manual' && <Input className="h-8 w-48" value={schedule.timeZone ?? 'UTC'} onChange={(e) => onChange({ ...schedule, timeZone: e.target.value })} aria-label="Time zone" />}
      </div>
    </div>
  )
}

const UNITS = { daily: 'day', weekly: 'week', monthly: 'month' } as const
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "Every [N] [days|weeks|months] on ... at [time] [zone], until [date]": touch-sized, native date and time pickers */
function RepeatFields<T extends ScheduleValue>({ schedule, onChange, testPrefix }: { schedule: T; onChange(s: T): void; testPrefix: string }) {
  const freq = schedule.frequency === 'weekly' || schedule.frequency === 'monthly' ? schedule.frequency : 'daily'
  const n = schedule.interval ?? 1
  const days = schedule.weekdays ?? []
  return (
    <div className="grid gap-2" data-testid={`${testPrefix}-schedule`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">Every</span>
        <Input className="h-10 w-16 md:h-8" type="number" min={1} max={365} inputMode="numeric" value={String(n)} onChange={(e) => onChange({ ...schedule, interval: Math.max(1, Math.min(365, Math.trunc(Number(e.target.value)) || 1)) })} aria-label="Every" data-testid={`${testPrefix}-interval`} />
        <select className={cn(fieldSelect, 'h-10 md:h-8')} value={freq} onChange={(e) => onChange({ ...schedule, frequency: e.target.value as T['frequency'] })} aria-label="Unit" data-testid={`${testPrefix}-frequency`}>
          {(['daily', 'weekly', 'monthly'] as const).map((f) => <option key={f} value={f}>{UNITS[f]}{n === 1 ? '' : 's'}</option>)}
        </select>
        {freq === 'monthly' && (
          <>
            <span className="text-sm">on day</span>
            <Input className="h-10 w-16 md:h-8" type="number" min={1} max={31} inputMode="numeric" value={String(schedule.day ?? 1)} onChange={(e) => onChange({ ...schedule, day: Math.max(1, Math.min(31, Math.trunc(Number(e.target.value)) || 1)) })} aria-label="Day of month" data-testid={`${testPrefix}-day`} />
          </>
        )}
      </div>
      {freq === 'weekly' && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="On these days" data-testid={`${testPrefix}-weekdays`}>
          <span className="text-sm">on</span>
          {SHORT.map((w, i) => {
            const on = days.includes(i)
            return (
              <button key={w} type="button" aria-pressed={on} aria-label={WEEKDAYS[i]} data-testid={`${testPrefix}-weekday-${i}`}
                className={cn('h-10 min-w-10 rounded-md border px-2 text-sm md:h-8 md:min-w-0', on ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background')}
                onClick={() => onChange({ ...schedule, weekdays: (on ? days.filter((d) => d !== i) : [...days, i]).sort((a, b) => a - b) })}>{w}</button>
            )
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">at</span>
        <Input type="time" className="h-10 w-32 md:h-8 md:w-28" value={schedule.time ?? '09:00'} onChange={(e) => onChange({ ...schedule, time: e.target.value })} aria-label="Time" data-testid={`${testPrefix}-time`} />
        <Input className="h-10 w-44 md:h-8 md:w-48" value={schedule.timeZone ?? 'UTC'} onChange={(e) => onChange({ ...schedule, timeZone: e.target.value })} aria-label="Time zone" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">until</span>
        <Input type="date" className="h-10 w-44 md:h-8" value={schedule.until ?? ''} onChange={(e) => onChange({ ...schedule, until: e.target.value || null })} aria-label="Until (optional)" data-testid={`${testPrefix}-until`} />
        <span className="text-xs text-muted-foreground">optional: it stops repeating after this day.</span>
      </div>
    </div>
  )
}

/** the recipient picker: people and teams; others subscribe only themselves. `noun`: what is sent ("reports", "snapshots") */
export function RecipientFields({ userIds, teamIds, onChange, testPrefix = 'snapshot', noun = 'snapshots' }: { userIds: string[]; teamIds: string[]; onChange(r: { userIds: string[]; teamIds: string[] }): void; testPrefix?: string; noun?: string }) {
  const caps = useCaps()
  const users = usePlatform((s) => s.users)
  const teams = usePlatform((s) => s.teams)
  const canPick = caps.isAdmin || caps.isMaker
  return (
    <div className="grid gap-1.5" data-testid={`${testPrefix}-recipients`}>
      <div className="text-xs font-medium">Recipients</div>
      {canPick ? (
        <>
          <div className="flex flex-wrap gap-1">
            {userIds.map((u) => <Badge key={u} variant="secondary" className="gap-1">{users.find((x) => x.id === u)?.name ?? u}<button type="button" aria-label="Remove" onClick={() => onChange({ userIds: userIds.filter((x) => x !== u), teamIds })}>x</button></Badge>)}
            {teamIds.map((t) => <Badge key={t} variant="outline" className="gap-1">Team {teams.find((x) => x.id === t)?.name ?? t}<button type="button" aria-label="Remove" onClick={() => onChange({ userIds, teamIds: teamIds.filter((x) => x !== t) })}>x</button></Badge>)}
          </div>
          <select className={fieldSelect} value="" onChange={(e) => { const v = e.target.value; if (v.startsWith('team:')) onChange({ userIds, teamIds: [...new Set([...teamIds, v.slice(5)])] }); else if (v) onChange({ userIds: [...new Set([...userIds, v])], teamIds }) }} data-testid={`${testPrefix}-add-recipient`}>
            <option value="">Add a person or team...</option>
            {users.filter((u) => !userIds.includes(u.id) && (u as { kind?: string }).kind !== 'service').map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
            {teams.map((t) => <option key={t.id} value={`team:${t.id}`}>Team {t.name}</option>)}
          </select>
        </>
      ) : <p className="text-xs text-muted-foreground">You (only makers and administrators send {noun} to other people).</p>}
    </div>
  )
}
