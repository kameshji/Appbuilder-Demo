/**
 * User mode built-in pages of the core data model (P0 package N): "Tasks" (activities of type Task assigned to me, my
 * teams, or mine unassigned: a list and a board by status, quick add with assignee and due date, the record each task
 * is about) and "Mentions" (where I was @mentioned, with a link back to the app it was written in).
 */
import { UndoDelete } from '@/runtime/UndoDelete'
import { useCallback, useEffect, useState } from 'react'
import { AtSign, CheckSquare, ExternalLink, Loader2, Plus, UserRound } from 'lucide-react'
import { platform, usePlatform } from '@/platform'
import type { MentionItem, PersonOption, TaskItem } from '@/platform/collab-api'
import { richTextToPlain } from '@/platform/system-tables'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { TaskRow } from '@/controls/display/collab'
import { Empty, PageHeader, Segmented, errMsg, fmtRelative, useToast } from './kit'

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

export function TasksPage() {
  const { toast } = useToast()
  const me = usePlatform((s) => s.currentUserId)
  const [view, setView] = useState<'list' | 'board'>('list')
  const [show, setShow] = useState<'open' | 'all'>('open')
  const [items, setItems] = useState<TaskItem[] | null>(null)
  const [subject, setSubject] = useState('')
  const [dueOn, setDueOn] = useState('')
  const [assignee, setAssignee] = useState<PersonOption | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    platform.collab!.myTasks({ all: show === 'all' || view === 'board' }).then(setItems).catch((e) => {
      setItems([])
      toast(errMsg(e), 'error')
    })
  }, [show, view, toast])
  useLive(load, platform.collab!.topics().slice(0, 2))

  const add = async () => {
    if (!subject.trim()) return
    setBusy(true)
    try {
      await platform.collab!.addActivity({ subject: subject.trim(), type: 'Task', dueOn: dueOn ? new Date(dueOn).toISOString() : null, assignedTo: assignee?.id ?? me })
      setSubject('')
      setDueOn('')
      setAssignee(null)
      load()
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const setStatus = async (t: TaskItem, status: string) => {
    try {
      await platform.collab!.updateActivity(t.id, { Status: status })
      load()
    } catch (e) {
      toast(errMsg(e), 'error')
    }
  }

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-4 overflow-y-auto p-6" data-testid="tasks-page">
      <PageHeader icon={CheckSquare} title="Tasks" subtitle="Tasks assigned to you or your teams, and your own." actions={
        <div className="flex items-center gap-2">
          {view === 'list' && <Segmented label="Show" size="sm" value={show} onChange={setShow} options={[{ value: 'open', label: 'Open' }, { value: 'all', label: 'All' }]} />}
          <Segmented label="View" size="sm" value={view} onChange={setView} options={[{ value: 'list', label: 'List' }, { value: 'board', label: 'Board' }]} />
        </div>
      } />
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2">
        <Input className="h-9 min-w-56 flex-1" placeholder="Add a task" value={subject} onChange={(e) => setSubject(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} data-testid="task-quick-add" />
        <Input className="h-9 w-40" type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} aria-label="Due date" />
        <Assignee value={assignee} onChange={setAssignee} />
        <Button className="h-9" disabled={busy || !subject.trim()} onClick={() => void add()} data-testid="task-add">{busy ? <Loader2 className="animate-spin" /> : <Plus />}Add</Button>
      </div>
      {items === null ? (
        <div className="flex justify-center p-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : view === 'list' ? (
        items.length === 0 ? <Empty icon={CheckSquare} title="No tasks" description="Tasks assigned to you, or added from a record's timeline, show up here." /> : (
          <div className="rounded-lg border bg-card p-1.5" data-testid="tasks-list">
            {items.map((t) => <TaskRow key={t.id} t={t} onToggle={(x) => void setStatus(x, x.Status === 'Done' ? 'Open' : 'Done')} />)}
          </div>
        )
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-3" data-testid="tasks-board">
          {STATUSES.map((s) => {
            const col = items.filter((t) => t.Status === s)
            return (
              <div key={s} className="flex min-h-40 flex-col rounded-lg border bg-muted/40" data-testid={`board-${s}`}>
                <div className="flex items-center gap-2 px-3 py-2 text-sm font-medium">{s}<Badge variant="secondary" className="font-normal">{col.length}</Badge></div>
                <div className="flex flex-col gap-2 p-2">
                  {col.map((t) => (
                    <div key={t.id} className="rounded-md border bg-card p-2.5 text-sm shadow-xs" data-testid="board-card">
                      <div className={cn('font-medium', s === 'Done' && 'text-muted-foreground line-through')}>{t.Subject}</div>
                      {t.regardingLabel && <div className="mt-0.5 truncate text-xs text-muted-foreground">{t.regardingTableName}: {t.regardingLabel}</div>}
                      <div className="mt-2 flex items-center gap-1">
                        {t.DueOn && <span className="text-xs text-muted-foreground">due {new Date(t.DueOn).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>}
                        <div className="ml-auto flex gap-1">
                          {STATUSES.filter((x) => x !== s).map((x) => (
                            <Button key={x} size="sm" variant="ghost" className="h-6 px-1.5 text-xs" onClick={() => void setStatus(t, x)}>{x === 'Done' ? 'Done' : x === 'Open' ? 'Reopen' : 'Start'}</Button>
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
      )}
      {/* Activities with a recycle bin: Undo after deleting a task */}
      <UndoDelete />
    </div>
  )
}

export function MentionsPage() {
  const { toast } = useToast()
  const [items, setItems] = useState<MentionItem[] | null>(null)
  const load = useCallback(() => {
    platform.collab!.mentions().then(setItems).catch((e) => {
      setItems([])
      toast(errMsg(e), 'error')
    })
  }, [toast])
  useLive(load, ['table:sys_mentions'])
  const open = async (m: MentionItem) => {
    if (!m.IsRead) await platform.collab!.markMentionRead(m.id).catch(() => {})
    if (m.Link && m.Link.startsWith('#')) location.hash = m.Link.slice(1)
    else load()
  }
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto p-6" data-testid="mentions-page">
      <PageHeader icon={AtSign} title="Mentions" subtitle="Comments where someone mentioned you." />
      {items === null ? (
        <div className="flex justify-center p-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : items.length === 0 ? (
        <Empty icon={AtSign} title="No mentions" description="When someone writes @ and your name in a comment, it shows up here." />
      ) : (
        <div className="divide-y rounded-lg border bg-card">
          {items.map((m) => (
            <button key={m.id} type="button" onClick={() => void open(m)} className="flex w-full items-start gap-3 p-3 text-left hover:bg-accent/40" data-testid="mention-row">
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
