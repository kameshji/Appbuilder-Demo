/**
 * User mode built-in pages of the core data model (P0 package N): "Tasks" (activities of type Task assigned to me, my
 * teams, or mine unassigned: a list and a board by status, quick add with assignee and due date, the record each task
 * is about) and "Mentions" (where I was @mentioned, with a link back to the app it was written in).
 */
import { UndoDelete } from '@/runtime/UndoDelete'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AtSign, Check, CheckSquare, Circle, ExternalLink, Loader2, Plus, Repeat, UserRound } from 'lucide-react'
import { platform, usePlatform } from '@/platform'
import type { MentionItem, PersonOption, TaskItem, TimelinePage } from '@/platform/collab-api'
import { richTextToPlain } from '@/platform/system-tables'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { ScheduleFields, browserZone, fieldSelect } from './ScheduleFields'
import type { ScheduleValue } from './ScheduleFields'
import { describeRecurrence, parseRecurrence } from '@/platform/recurrence'
import { Empty, PageHeader, Segmented, errMsg, fmtRelative, useToast } from './kit'
import { isChatMention, loadChatMentions, mergeMentions, openChatMention } from '@/chat/mentions'

const STATUSES = ['Open', 'In progress', 'Done'] as const

function useLive(load: () => void, topics: string[]) {
  const version = usePlatform((s) => (s.mode === 'demo' ? s.dataVersion : 0))
  useEffect(() => load(), [load, version])
  useEffect(() => {
    const offs = topics.map((t) => platform.live.subscribe(t, () => load()))
    return () => offs.forEach((o) => o())
  }, [load, topics.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps
}

function Assignee({ value, onChange }: { value: PersonOption | null; onChange(p: PersonOption | null): void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [people, setPeople] = useState<PersonOption[]>([])
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => platform.collab!.people(q).then(setPeople).catch(() => setPeople([])), 120)
    return () => clearTimeout(t)
  }, [q, open])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 max-w-48" data-testid="task-assignee"><UserRound className="size-3.5" /><span className="truncate">{value?.name ?? 'Me'}</span></Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Assign to" value={q} onValueChange={setQ} />
          <CommandList>
            <CommandEmpty>No one found.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="__me" onSelect={() => { onChange(null); setOpen(false) }}>Me</CommandItem>
              {people.map((p) => (
                <CommandItem key={p.id} value={p.id} onSelect={() => { onChange(p); setOpen(false) }} data-testid={`assign-${p.id}`}>
                  <span className="truncate">{p.name}</span><span className="ml-auto truncate text-xs text-muted-foreground">{p.email}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** the task as the page holds it: the my-tasks row (full row at run time) plus what the detail panel edits */
type Task = TaskItem & { Description?: string | null; ReminderOn?: string | null; Recurrence?: string | null; owner?: string | null; shared?: boolean }
type Scope = 'mine' | 'by-me' | 'shared'
type Sort = 'due' | 'priority' | 'created'
const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent']
const PRIO_RANK: Record<string, number> = { Urgent: 0, High: 1, Normal: 2, Low: 3 }

const iso = (v: unknown): string | null => (v == null || v === '' ? null : v instanceof Date ? v.toISOString() : String(v))
const pad = (n: number) => String(n).padStart(2, '0')
/** an ISO instant as the value of a native datetime-local field (local time) and back */
const toLocalInput = (v: string | null | undefined) => { if (!v) return ''; const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` }
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null)
const dueText = (v: string | null) => (v ? new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '')
const isOverdue = (t: Task) => t.Status !== 'Done' && !!t.DueOn && new Date(t.DueOn).getTime() < Date.now()

function useMedia(q: string): boolean {
  const [m, setM] = useState(() => typeof matchMedia === 'function' && matchMedia(q).matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia(q)
    const on = () => setM(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [q])
  return m
}

function normalise(r: Record<string, unknown>): Task {
  return {
    id: String(r.id), Subject: String(r.Subject ?? ''), Type: String(r.Type ?? 'Task'), Status: String(r.Status ?? 'Open'), Priority: (r.Priority as string) ?? null,
    DueOn: iso(r.DueOn), AssignedTo: (r.AssignedTo as string) ?? null, AssignedTeam: (r.AssignedTeam as string) ?? null,
    regardingTable: (r.regardingTable as string) ?? null, regardingId: (r.regardingId as string) ?? null,
    createdOn: iso(r.createdOn) ?? '', createdBy: (r.createdBy as string) ?? null, owner: (r.owner as string) ?? null,
    Description: (r.Description as string) ?? null, ReminderOn: iso(r.ReminderOn), Recurrence: (r.Recurrence as string) ?? null,
  }
}

/** one task row: a 44 px complete button, the subject (tap to open), what matters at a glance */
function Row({ t, onToggle, onOpen }: { t: Task; onToggle(t: Task): void; onOpen(t: Task): void }) {
  const done = t.Status === 'Done'
  return (
    <div className="flex items-center gap-1 rounded-md px-1 hover:bg-accent/40" data-testid="task-row" data-task-id={t.id}>
      <button type="button" className="grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground" aria-label={done ? `Reopen ${t.Subject}` : `Mark ${t.Subject} done`} aria-pressed={done} onClick={() => onToggle(t)} data-testid="task-complete">
        {done ? <Check className="size-5 text-green-600" /> : <Circle className="size-5" />}
      </button>
      <button type="button" className="flex min-h-11 min-w-0 flex-1 flex-col justify-center py-1 text-left" onClick={() => onOpen(t)} data-testid="task-open">
        <span className={cn('truncate text-sm font-medium', done && 'text-muted-foreground line-through')}>{t.Subject}</span>
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {t.DueOn && <span className={cn(isOverdue(t) && 'font-medium text-destructive')}>{isOverdue(t) ? 'overdue ' : 'due '}{dueText(t.DueOn)}</span>}
          {t.Priority && t.Priority !== 'Normal' && <span>{t.Priority}</span>}
          {t.regardingLabel && <span className="truncate">{t.regardingTableName}: {t.regardingLabel}</span>}
          {t.Recurrence && <span className="inline-flex items-center gap-0.5"><Repeat className="size-3" />repeats</span>}
          {t.shared && <span>shared</span>}
        </span>
      </button>
    </div>
  )
}

const repeatJson = (r: ScheduleValue): string => JSON.stringify({
  frequency: r.frequency === 'weekly' || r.frequency === 'monthly' ? r.frequency : 'daily', interval: r.interval ?? 1,
  ...(r.frequency === 'weekly' && r.weekdays?.length ? { weekdays: r.weekdays } : {}), ...(r.frequency === 'monthly' ? { day: r.day ?? 1 } : {}),
  time: r.time ?? '09:00', timeZone: r.timeZone ?? browserZone(), ...(r.until ? { until: r.until } : {}),
})
const repeatText = (r: ScheduleValue): string => { try { return describeRecurrence(parseRecurrence(repeatJson(r))) } catch { return 'check the repeat settings' } }

/** the details of one task: edit, repeat, comments, sharing. Opens as a bottom sheet on a phone. */
function Detail({ task, me, server, phone, onClose, onSaved }: { task: Task; me: string | null; server: boolean; phone: boolean; onClose(): void; onSaved(): void }) {
  const { toast } = useToast()
  const people = usePlatform((s) => s.users)
  const [subject, setSubject] = useState(task.Subject)
  const [description, setDescription] = useState(richTextToPlain(task.Description ?? ''))
  const [priority, setPriority] = useState(task.Priority ?? 'Normal')
  const [dueOn, setDueOn] = useState(toLocalInput(task.DueOn))
  const [reminderOn, setReminderOn] = useState(toLocalInput(task.ReminderOn))
  const initial = useMemo<ScheduleValue | null>(() => {
    if (!task.Recurrence) return null
    try { const r = parseRecurrence(task.Recurrence); return { frequency: r.frequency, interval: r.interval, weekdays: r.weekdays, day: r.day, time: r.time, timeZone: r.timeZone, until: r.until ?? null } as ScheduleValue } catch { return null }
  }, [task.Recurrence])
  const [repeat, setRepeat] = useState<ScheduleValue | null>(initial)
  const [busy, setBusy] = useState(false)
  const canRepeat = server && task.Type === 'Task'
  const isOwner = !task.owner || task.owner === me
  const save = async () => {
    setBusy(true)
    try {
      const changes: Record<string, string | null> = { Subject: subject.trim() || task.Subject, Description: description || null, Priority: priority, DueOn: fromLocalInput(dueOn), ReminderOn: fromLocalInput(reminderOn) }
      if (canRepeat) changes.Recurrence = repeat ? repeatJson(repeat) : null
      await platform.collab!.updateActivity(task.id, changes)
      onSaved()
      onClose()
    } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  const quick = (changes: Record<string, string | null>) => { void platform.collab!.updateActivity(task.id, changes).then(onSaved).catch((er) => toast(errMsg(er), 'error')) }
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side={phone ? 'bottom' : 'right'} className="max-h-[92dvh] overflow-y-auto p-4 sm:max-w-md" data-testid="task-sheet">
        <SheetHeader className="p-0"><SheetTitle>Task</SheetTitle></SheetHeader>
        <div className="grid gap-3 text-sm" data-testid="task-detail">
          <Input className="h-11 md:h-9" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" data-testid="task-subject" />
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" aria-label="Description" />
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1 text-xs"><span className="font-medium text-muted-foreground">Priority</span>
              <select className={cn(fieldSelect, 'h-11 md:h-8')} value={priority} onChange={(e) => setPriority(e.target.value)} data-testid="task-priority">{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></label>
            <label className="grid gap-1 text-xs"><span className="font-medium text-muted-foreground">Status</span>
              <select className={cn(fieldSelect, 'h-11 md:h-8')} value={task.Status} onChange={(e) => quick({ Status: e.target.value })}>{STATUSES.map((p) => <option key={p}>{p}</option>)}</select></label>
            <label className="grid gap-1 text-xs"><span className="font-medium text-muted-foreground">Due</span>
              <Input type="datetime-local" className="h-11 md:h-8" value={dueOn} onChange={(e) => setDueOn(e.target.value)} data-testid="task-due" /></label>
            <label className="grid gap-1 text-xs"><span className="font-medium text-muted-foreground">Remind me</span>
              <Input type="datetime-local" className="h-11 md:h-8" value={reminderOn} onChange={(e) => setReminderOn(e.target.value)} data-testid="task-reminder" /></label>
          </div>
          <div className="flex items-center gap-2 text-xs"><span className="font-medium text-muted-foreground">Assigned to</span>
            <Assignee value={task.AssignedTo ? { id: task.AssignedTo, name: people.find((u) => u.id === task.AssignedTo)?.name ?? 'Someone', email: '' } : null} onChange={(p) => quick({ AssignedTo: p?.id ?? me })} /></div>
          {task.regardingLabel && <div className="text-xs text-muted-foreground">About {task.regardingTableName}: {task.regardingLabel}</div>}
          {canRepeat && (
            <div className="grid gap-2 rounded-md border p-2" data-testid="task-repeat">
              <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-0"><input type="checkbox" className="size-4" checked={!!repeat} onChange={(e) => setRepeat(e.target.checked ? ({ frequency: 'weekly', interval: 1, time: '09:00', timeZone: browserZone() } as ScheduleValue) : null)} data-testid="task-repeat-toggle" />Repeat this task</label>
              {repeat && <ScheduleFields<ScheduleValue> layout="repeat" testPrefix="task" schedule={repeat} onChange={setRepeat} />}
              {repeat && <p className="text-xs text-muted-foreground">When you complete it, the next one is created: {repeatText(repeat)}.</p>}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" className="h-11 md:h-9" onClick={onClose}>Cancel</Button>
            <Button className="h-11 md:h-9" disabled={busy} onClick={() => void save()} data-testid="task-save">{busy && <Loader2 className="animate-spin" />}Save</Button>
          </div>
          {server && isOwner && <Share id={task.id} />}
          <Comments id={task.id} />
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** the people this task is shared with (read access); only its owner adds or removes */
function Share({ id }: { id: string }) {
  const { toast } = useToast()
  const users = usePlatform((s) => s.users)
  const [rows, setRows] = useState<{ id: string; Principal: string; PrincipalType: string; Access: string }[]>([])
  const load = useCallback(() => {
    platform.tables.query({ version: 2, table: 'ActivityShares', filter: { col: 'Activity', op: 'eq', value: id } }).then((s) => setRows(s.rows as never)).catch(() => setRows([]))
  }, [id])
  useEffect(() => load(), [load])
  const add = async (userId: string) => {
    try { platform.tables.insert('ActivityShares', { Activity: id, PrincipalType: 'user', Principal: userId, Access: 'read' }); await platform.tables.flush(); load() } catch (e) { toast(errMsg(e), 'error') }
  }
  const remove = async (rid: string) => {
    try { platform.tables.delete('ActivityShares', [rid]); await platform.tables.flush(); load() } catch (e) { toast(errMsg(e), 'error') }
  }
  return (
    <div className="grid gap-1.5 rounded-md border p-2" data-testid="task-share">
      <div className="text-xs font-medium">Shared with</div>
      <div className="flex flex-wrap gap-1">
        {rows.length === 0 && <span className="text-xs text-muted-foreground">No one yet. People you share with can see this task and its comments.</span>}
        {rows.map((r) => <Badge key={r.id} variant="secondary" className="gap-1">{r.PrincipalType === 'team' ? 'Team ' : ''}{users.find((u) => u.id === r.Principal)?.name ?? r.Principal}<button type="button" className="px-1" aria-label="Stop sharing" onClick={() => void remove(r.id)}>x</button></Badge>)}
      </div>
      <select className={cn(fieldSelect, 'h-11 md:h-8')} value="" onChange={(e) => e.target.value && void add(e.target.value)} aria-label="Share with" data-testid="task-share-add">
        <option value="">Share with a person...</option>
        {users.filter((u) => !rows.some((r) => r.Principal === u.id) && (u as { kind?: string }).kind !== 'service').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
    </div>
  )
}

function Comments({ id }: { id: string }) {
  const { toast } = useToast()
  const [page, setPage] = useState<TimelinePage | null>(null)
  const [text, setText] = useState('')
  const load = useCallback(() => { platform.collab!.timeline(id, { table: 'sys_activities', limit: 30 }).then(setPage).catch(() => setPage(null)) }, [id])
  useEffect(() => load(), [load])
  const send = async () => {
    if (!text.trim()) return
    try { await platform.collab!.addComment({ rowId: id, table: 'sys_activities', body: text.trim() }); setText(''); load() } catch (e) { toast(errMsg(e), 'error') }
  }
  const comments = (page?.items ?? []).filter((i) => i.kind === 'comment')
  return (
    <div className="grid gap-1.5" data-testid="task-comments">
      <div className="text-xs font-medium">Comments</div>
      {comments.map((c) => <div key={c.id} className="rounded-md bg-muted/50 p-2 text-sm"><span className="font-medium">{c.byName ?? 'Someone'}</span> <span className="text-xs text-muted-foreground">{fmtRelative(c.at)}</span><div>{richTextToPlain(String(c.data.Body ?? ''))}</div></div>)}
      {(!page || page.canComment) && (
        <div className="flex gap-2"><Input className="h-11 md:h-9" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void send()} placeholder="Write a comment" aria-label="Comment" data-testid="task-comment-input" /><Button className="h-11 md:h-9" variant="outline" disabled={!text.trim()} onClick={() => void send()}>Send</Button></div>
      )}
    </div>
  )
}

export function TasksPage() {
  const { toast } = useToast()
  const me = usePlatform((s) => s.currentUserId)
  const server = usePlatform((s) => s.mode) === 'server'
  const phone = useMedia('(max-width: 599px)')
  const [view, setView] = useState<'list' | 'board'>('list')
  const [show, setShow] = useState<'open' | 'all'>('open')
  const [scope, setScope] = useState<Scope>('mine')
  const [sort, setSort] = useState<Sort>('due')
  const [prio, setPrio] = useState('')
  const [col, setCol] = useState<(typeof STATUSES)[number]>('Open')
  const [items, setItems] = useState<Task[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [subject, setSubject] = useState('')
  const [dueOn, setDueOn] = useState('')
  const [assignee, setAssignee] = useState<PersonOption | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    const fail = (e: unknown) => { setItems([]); toast(errMsg(e), 'error') }
    const mine = platform.collab!.myTasks({ all: true }).then((l) => l.map((t) => ({ ...normalise(t as unknown as Record<string, unknown>), regardingLabel: t.regardingLabel, regardingTableName: t.regardingTableName })))
    if (scope === 'mine') { mine.then(setItems).catch(fail); return }
    // the other two scopes read the activities this person may see through the data API (the server decides what that is)
    Promise.all([mine, platform.tables.query({ version: 2, table: 'Activities', filter: { col: 'Type', op: 'eq', value: 'Task' }, take: { n: 500, from: 'end' } })])
      .then(async ([m, q]) => {
        const mineIds = new Set(m.map((t) => t.id))
        const all = q.rows.map((r) => normalise(r as unknown as Record<string, unknown>)).filter((t) => !mineIds.has(t.id))
        if (scope === 'by-me') return all.filter((t) => t.createdBy === me)
        const shares = await platform.tables.query({ version: 2, table: 'ActivityShares', take: { n: 1000, from: 'end' } }).then((s) => s.rows as unknown as { Activity: string }[]).catch(() => [])
        const ids = new Set(shares.map((s) => String(s.Activity)))
        return all.filter((t) => ids.has(t.id) && t.owner !== me).map((t) => ({ ...t, shared: true }))
      })
      .then(setItems).catch(fail)
  }, [scope, me, toast])
  useLive(load, platform.collab!.topics().slice(0, 2))

  const shown = useMemo(() => {
    let l = (items ?? []).filter((t) => !prio || t.Priority === prio)
    if (view === 'list' && show === 'open') l = l.filter((t) => t.Status !== 'Done')
    const by: Record<Sort, (a: Task, b: Task) => number> = {
      due: (a, b) => (a.DueOn ?? '9').localeCompare(b.DueOn ?? '9'),
      priority: (a, b) => (PRIO_RANK[a.Priority ?? 'Normal'] ?? 2) - (PRIO_RANK[b.Priority ?? 'Normal'] ?? 2),
      created: (a, b) => b.createdOn.localeCompare(a.createdOn),
    }
    return [...l].sort(by[sort])
  }, [items, prio, view, show, sort])
  const opened = items?.find((t) => t.id === openId) ?? null

  const add = async () => {
    if (!subject.trim()) return
    setBusy(true)
    try {
      await platform.collab!.addActivity({ subject: subject.trim(), type: 'Task', dueOn: dueOn ? new Date(dueOn).toISOString() : null, assignedTo: assignee?.id ?? me })
      setSubject(''); setDueOn(''); setAssignee(null)
      load()
    } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  const setStatus = async (t: Task, status: string) => {
    try { await platform.collab!.updateActivity(t.id, { Status: status }); load() } catch (e) { toast(errMsg(e), 'error') }
  }
  const toggle = (t: Task) => void setStatus(t, t.Status === 'Done' ? 'Open' : 'Done')

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-3 overflow-y-auto p-3 sm:p-6" data-testid="tasks-page">
      <PageHeader icon={CheckSquare} title="Tasks" subtitle="Tasks assigned to you or your teams, and your own." actions={
        <div className="flex flex-wrap items-center gap-2">
          {view === 'list' && <Segmented label="Show" size="sm" value={show} onChange={setShow} options={[{ value: 'open', label: 'Open' }, { value: 'all', label: 'All' }]} />}
          <Segmented label="View" size="sm" value={view} onChange={setView} options={[{ value: 'list', label: 'List' }, { value: 'board', label: 'Board' }]} />
        </div>
      } />
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2">
        <Input className="h-11 min-w-0 flex-1 basis-48 md:h-9" placeholder="Add a task" value={subject} onChange={(e) => setSubject(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} data-testid="task-quick-add" />
        <Input className="h-11 w-40 md:h-9" type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} aria-label="Due date" data-testid="task-quick-due" />
        <Assignee value={assignee} onChange={setAssignee} />
        <Button className="h-11 md:h-9" disabled={busy || !subject.trim()} onClick={() => void add()} data-testid="task-add">{busy ? <Loader2 className="animate-spin" /> : <Plus />}Add</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="task-filters">
        {server && (
          <select className={cn(fieldSelect, 'h-11 md:h-8')} value={scope} onChange={(e) => setScope(e.target.value as Scope)} aria-label="Which tasks" data-testid="task-scope">
            <option value="mine">Mine and my teams</option><option value="by-me">Assigned by me</option><option value="shared">Shared with me</option>
          </select>
        )}
        <select className={cn(fieldSelect, 'h-11 md:h-8')} value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort by" data-testid="task-sort">
          <option value="due">Sort: due date</option><option value="priority">Sort: priority</option><option value="created">Sort: newest</option>
        </select>
        <select className={cn(fieldSelect, 'h-11 md:h-8')} value={prio} onChange={(e) => setPrio(e.target.value)} aria-label="Priority" data-testid="task-prio-filter">
          <option value="">Any priority</option>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}
        </select>
        <span className="text-muted-foreground">Tasks belong to this environment.</span>
      </div>
      {items === null ? (
        <div className="flex justify-center p-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : view === 'list' ? (
        shown.length === 0 ? <Empty icon={CheckSquare} title="No tasks" description="Tasks assigned to you, or added from a record's timeline, show up here." /> : (
          <div className="rounded-lg border bg-card p-1.5" data-testid="tasks-list">
            {shown.map((t) => <Row key={t.id} t={t} onToggle={toggle} onOpen={(x) => setOpenId(x.id)} />)}
          </div>
        )
      ) : (
        <>
          {phone && <Segmented label="Status" value={col} onChange={setCol} options={STATUSES.map((s) => ({ value: s, label: `${s} (${shown.filter((t) => t.Status === s).length})` }))} />}
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-3" data-testid="tasks-board">
            {STATUSES.filter((s) => !phone || s === col).map((s) => {
              const list = shown.filter((t) => t.Status === s)
              return (
                <div key={s} className="flex min-h-40 flex-col rounded-lg border bg-muted/40" data-testid={`board-${s}`}>
                  <div className="flex items-center gap-2 px-3 py-2 text-sm font-medium">{s}<Badge variant="secondary" className="font-normal">{list.length}</Badge></div>
                  <div className="flex flex-col gap-2 p-2">
                    {list.map((t) => (
                      <div key={t.id} className="rounded-md border bg-card p-2.5 text-sm shadow-xs" data-testid="board-card">
                        <button type="button" className="block min-h-11 w-full text-left md:min-h-0" onClick={() => setOpenId(t.id)}>
                          <span className={cn('font-medium', s === 'Done' && 'text-muted-foreground line-through')}>{t.Subject}</span>
                          {t.regardingLabel && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{t.regardingTableName}: {t.regardingLabel}</span>}
                        </button>
                        <div className="mt-1 flex items-center gap-1">
                          {t.DueOn && <span className={cn('text-xs text-muted-foreground', isOverdue(t) && 'text-destructive')}>due {dueText(t.DueOn)}</span>}
                          <div className="ml-auto flex gap-1">
                            {STATUSES.filter((x) => x !== s).map((x) => (
                              <Button key={x} size="sm" variant="ghost" className="h-11 px-2 text-xs md:h-6 md:px-1.5" onClick={() => void setStatus(t, x)}>{x === 'Done' ? 'Done' : x === 'Open' ? 'Reopen' : 'Start'}</Button>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
      {opened && <Detail key={opened.id + (opened.Recurrence ?? '')} task={opened} me={me} server={server} phone={phone} onClose={() => setOpenId(null)} onSaved={load} />}
      {/* Activities with a recycle bin: Undo after deleting a task */}
      <UndoDelete />
    </div>
  )
}

export function MentionsPage() {
  const { toast } = useToast()
  const [items, setItems] = useState<MentionItem[] | null>(null)
  const load = useCallback(() => {
    // P3-E: chat mentions too (from the chat environment, with the link that opens the message)
    Promise.all([platform.collab!.mentions(), platform.getState().mode === 'server' ? loadChatMentions() : Promise.resolve([])]).then(([a, b]) => setItems(mergeMentions(a, b))).catch((e) => {
      setItems([])
      toast(errMsg(e), 'error')
    })
  }, [toast])
  useLive(load, ['table:sys_mentions'])
  const open = async (m: MentionItem) => {
    if (isChatMention(m)) {
      await openChatMention(m)
      load()
      return
    }
    if (!m.IsRead) await platform.collab!.markMentionRead(m.id).catch(() => {})
    if (m.Link && m.Link.startsWith('#')) location.hash = m.Link.slice(1)
    else load()
  }
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto p-6" data-testid="mentions-page">
      <PageHeader icon={AtSign} title="Mentions" subtitle="Comments and chat messages where someone mentioned you." />
      {items === null ? (
        <div className="flex justify-center p-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : items.length === 0 ? (
        <Empty icon={AtSign} title="No mentions" description="When someone writes @ and your name in a comment, it shows up here." />
      ) : (
        <div className="divide-y rounded-lg border bg-card">
          {items.map((m) => (
            <button key={m.id} type="button" onClick={() => void open(m)} className="flex w-full items-start gap-3 p-3 text-left hover:bg-accent/40" data-testid="mention-row" data-kind={isChatMention(m) ? 'chat' : 'comment'}>
              <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', m.IsRead ? 'bg-transparent' : 'bg-primary')} aria-label={m.IsRead ? 'Read' : 'Unread'} />
              <div className="min-w-0 flex-1">
                <div className="text-sm"><span className="font-medium">{m.byName ?? 'Someone'}</span> mentioned you{m.regardingLabel ? <> on <span className="font-medium">{m.regardingTableName}: {m.regardingLabel}</span></> : null}</div>
                <div className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{richTextToPlain(m.Body ?? '')}</div>
                <div className="mt-1 text-xs text-muted-foreground">{fmtRelative(m.createdOn)}</div>
              </div>
              {m.Link && <ExternalLink className="mt-1 size-3.5 shrink-0 text-muted-foreground" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
