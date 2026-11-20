/**
 * Core data model UI components (P0 package N): the record timeline (activities, comments, files and record events in
 * one feed, with a composer), a person picker, a tag input and an activity list. Everything goes through
 * platform.collab (server: the collaboration API, secured by the regarding rule; demo: the browser workspace).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Bell, BellOff, CalendarClock, CheckSquare, FileText, History, ListTodo, Loader2, Mail, MessageSquare, Paperclip, Phone, Plus, StickyNote,
  Tag as TagIcon, UserRound, X,
} from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { platform, usePlatform } from '@/platform'
import type { PersonOption, TaskItem, TimelineItem, TimelinePage } from '@/platform/collab-api'
import { sanitizeRichText } from '@/platform/system-tables'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { toBool, toNum, toText } from '../util'
import { AvatarCircle } from './basics'
import { GenerateDocumentButton } from '@/print/GenerateDocument'
import { recordIdOf, usePeopleNames } from './people'
import { useDevice } from '@/phone/env'
import { BottomSheet } from '@/phone/sheet'

/* ------------------------------------------------------------------ helpers */

const when = (iso: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}
const due = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '')
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** the app this component runs in, for links in notifications (#u-<appId>?record=<id>) */
function appLink(rowId: string): string | undefined {
  if (typeof location === 'undefined') return undefined
  const m = /^#(?:u|run)-([A-Za-z0-9_-]+)/.exec(location.hash)
  return m ? `#u-${m[1]}?record=${encodeURIComponent(rowId)}` : undefined
}

const TYPE_ICON: Record<string, typeof CheckSquare> = { Task: CheckSquare, Call: Phone, Meeting: CalendarClock, Email: Mail, Note: StickyNote, Custom: ListTodo }

/** plain text with @Name tokens -> the comment's rich text (mentions as spans with the user id) */
export function composeBody(text: string, mentions: Map<string, string>): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  let html = esc(text)
  for (const [name, id] of [...mentions].sort((a, b) => b[0].length - a[0].length)) {
    const token = esc(`@${name}`)
    if (html.includes(token)) html = html.split(token).join(`<span data-mention="${id}">@${esc(name)}</span>`)
  }
  return html.split(/\r?\n/).map((l) => `<p>${l}</p>`).join('')
}

/* ------------------------------------------------------------------ person picker (also used inside the timeline) */

function PersonList({ onPick, load, placeholder, touch = false }: { onPick(p: PersonOption): void; load(q: string): Promise<PersonOption[]>; placeholder?: string; touch?: boolean }) {
  const [q, setQ] = useState('')
  const [items, setItems] = useState<PersonOption[] | null>(null)
  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      load(q).then((r) => live && setItems(r)).catch(() => live && setItems([]))
    }, 150)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [q, load])
  return (
    <Command shouldFilter={false} className={touch ? 'min-h-0 flex-1 rounded-none bg-transparent' : undefined}>
      <CommandInput placeholder={placeholder ?? 'Search people'} value={q} onValueChange={setQ} />
      <CommandList className={touch ? 'max-h-none min-h-0 flex-1 overscroll-contain' : undefined}>
        {items === null ? <div className="p-3 text-sm text-muted-foreground">Loading…</div> : <CommandEmpty>No one found.</CommandEmpty>}
        <CommandGroup>
          {(items ?? []).map((p) => (
            <CommandItem key={p.id} value={p.id} onSelect={() => onPick(p)} data-testid={`person-${p.id}`} className={touch ? 'min-h-11 gap-3 py-2.5 text-base' : undefined}>
              <AvatarCircle src="" name={p.name} size="22px" />
              <span className="truncate">{p.name}</span>
              <span className="ml-auto truncate text-xs text-muted-foreground">{p.email}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

function PersonPickerRender({ props, mode, outputs, setOutput, fire }: ControlRenderProps) {
  const names = usePeopleNames()
  const touch = useDevice().touch
  const [open, setOpen] = useState(false)
  const defaultId = recordIdOf(props.Default)
  const [value, setValue] = useState<string>(defaultId)
  useEffect(() => setValue(defaultId), [defaultId])
  const selected = (outputs.Value as string) ?? ''
  useEffect(() => {
    if (value === selected) return
    setOutput('Value', value || null)
    setOutput('Selected', value ? { Id: value, FullName: names.get(value) ?? '', Email: '' } : null)
  }, [value, selected, names, setOutput])
  const load = useCallback((q: string) => platform.collab!.people(q), [])
  const name = value ? names.get(value) ?? value : ''
  const trigger = (
    <button type="button" className="flex size-full items-center gap-2 rounded-md border bg-background px-2 text-left text-sm" disabled={mode !== 'run'} data-testid="person-picker">
      {value ? <AvatarCircle src="" name={name} size="22px" /> : <UserRound className="size-4 text-muted-foreground" />}
      <span className={cn('truncate', !value && 'text-muted-foreground')}>{value ? name : toText(props.Placeholder) || 'Choose a person'}</span>
      {value && mode === 'run' && (
        <span role="button" aria-label="Clear person" data-touch-target="" className="ml-auto grid size-6 shrink-0 place-items-center text-muted-foreground" onClick={(e) => { e.stopPropagation(); setValue(''); fire('OnChange') }}>
          <X className="size-3.5" />
        </span>
      )}
    </button>
  )
  if (mode !== 'run') return trigger
  // touch devices: a bottom sheet with a search field and 44 px rows (src/phone/sheet.tsx)
  if (touch) {
    return (
      <>
        <button type="button" className="flex size-full items-center gap-2 rounded-md border bg-background px-2 text-left text-sm" onClick={() => setOpen(true)} data-testid="person-picker">
          {value ? <AvatarCircle src="" name={name} size="22px" /> : <UserRound className="size-4 text-muted-foreground" />}
          <span className={cn('truncate', !value && 'text-muted-foreground')}>{value ? name : toText(props.Placeholder) || 'Choose a person'}</span>
          {value && (
            <span role="button" aria-label="Clear person" data-touch-target="" className="ml-auto grid size-6 shrink-0 place-items-center text-muted-foreground" onClick={(e) => { e.stopPropagation(); setValue(''); fire('OnChange') }}>
              <X className="size-3.5" />
            </span>
          )}
        </button>
        <BottomSheet open={open} onClose={() => setOpen(false)} label={toText(props.Placeholder) || 'Choose a person'}>
          <PersonList touch load={load} onPick={(p) => { setValue(p.id); setOpen(false); setTimeout(() => fire('OnChange'), 0) }} />
        </BottomSheet>
      </>
    )
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <PersonList load={load} onPick={(p) => { setValue(p.id); setOpen(false); setTimeout(() => fire('OnChange'), 0) }} />
      </PopoverContent>
    </Popover>
  )
}

export const PersonPicker: ControlType = {
  type: 'PersonPicker',
  label: 'Person picker',
  icon: UserRound,
  category: 'Input',
  props: [
    { name: 'Default', kind: 'text', group: 'Data', default: '=""' },
    { name: 'Placeholder', kind: 'text', group: 'Content', default: '="Choose a person"' },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
  ],
  outputs: [{ name: 'Value', initial: null }, { name: 'Selected', initial: null }],
  defaultSize: { width: 260, height: 40 },
  primaryProp: 'Default',
  render: PersonPickerRender,
}

/* ------------------------------------------------------------------ the record timeline */

const DESIGN_ITEMS: TimelineItem[] = [
  { kind: 'comment', id: 'd1', at: new Date(Date.now() - 3_600_000).toISOString(), by: null, byName: 'Asha Rao', data: { Body: '<p>Called the customer: delivery moved to Friday. <span data-mention="x">@Ravi</span> please update the plan.</p>' } },
  { kind: 'activity', id: 'd2', at: new Date(Date.now() - 7_200_000).toISOString(), by: null, byName: 'Ravi Kumar', assignedName: 'Asha Rao', data: { Type: 'Task', Subject: 'Send the revised quote', Status: 'Open', DueOn: new Date(Date.now() + 86_400_000).toISOString() } },
  { kind: 'file', id: 'd3', at: new Date(Date.now() - 86_400_000).toISOString(), by: null, byName: 'Asha Rao', data: { FileName: 'drawing-rev2.pdf', SizeBytes: 182_000 } },
  { kind: 'event', id: 'd4', at: new Date(Date.now() - 172_800_000).toISOString(), by: null, byName: 'Ravi Kumar', data: { action: 'created', columns: [] } },
]

function TimelineEntry({ item, onToggle, onDelete }: { item: TimelineItem; onToggle(i: TimelineItem): void; onDelete(i: TimelineItem): void }) {
  const who = item.byName ?? 'Someone'
  const head = (icon: ReactNode, text: ReactNode) => (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {icon}
      <span className="min-w-0 truncate">{text}</span>
      <span className="ml-auto shrink-0">{when(item.at)}</span>
    </div>
  )
  if (item.kind === 'comment') {
    const html = sanitizeRichText(String(item.data.Body ?? ''))
    return (
      <div className="flex gap-2.5" data-testid="timeline-comment">
        <AvatarCircle src="" name={who} size="28px" />
        <div className="min-w-0 flex-1">
          {head(null, <><span className="font-medium text-foreground">{who}</span>{item.data.EditedOn ? ' (edited)' : ''}</>)}
          <div className="ab-richtext mt-0.5 break-words text-sm [&_span[data-mention]]:rounded [&_span[data-mention]]:bg-primary/10 [&_span[data-mention]]:px-1 [&_span[data-mention]]:font-medium [&_span[data-mention]]:text-primary" dangerouslySetInnerHTML={{ __html: html }} />
          {item.data.canEdit === true && (
            <button type="button" className="mt-0.5 text-xs text-muted-foreground hover:text-destructive" onClick={() => onDelete(item)}>Delete</button>
          )}
        </div>
      </div>
    )
  }
  if (item.kind === 'activity') {
    const Icon = TYPE_ICON[String(item.data.Type)] ?? ListTodo
    const done = item.data.Status === 'Done'
    return (
      <div className="flex gap-2.5" data-testid="timeline-activity">
        <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-muted"><Icon className="size-3.5" /></span>
        <div className="min-w-0 flex-1">
          {head(null, <><span className="font-medium text-foreground">{who}</span> added a {String(item.data.Type ?? 'task').toLowerCase()}{item.assignedName ? ` for ${item.assignedName}` : ''}</>)}
          <div className="mt-0.5 flex items-center gap-2 text-sm">
            {item.data.Type === 'Task' && <Checkbox checked={done} onCheckedChange={() => onToggle(item)} aria-label="Done" />}
            <span className={cn('min-w-0 truncate', done && 'text-muted-foreground line-through')}>{String(item.data.Subject ?? '')}</span>
            {item.data.DueOn ? <Badge variant="outline" className="shrink-0 font-normal">due {due(String(item.data.DueOn))}</Badge> : null}
            {item.data.Status && !done ? <Badge variant="secondary" className="shrink-0 font-normal">{String(item.data.Status)}</Badge> : null}
          </div>
        </div>
      </div>
    )
  }
  if (item.kind === 'file') {
    const att = item.data.Attachment ? String(item.data.Attachment) : ''
    const size = Number(item.data.SizeBytes ?? 0)
    return (
      <div className="flex gap-2.5" data-testid="timeline-file">
        <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-muted"><Paperclip className="size-3.5" /></span>
        <div className="min-w-0 flex-1">
          {head(null, <><span className="font-medium text-foreground">{who}</span> attached a file</>)}
          <div className="mt-0.5 flex items-center gap-2 text-sm">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            {att ? <a className="truncate text-primary underline-offset-2 hover:underline" href={platform.attachments.url(att)} target="_blank" rel="noreferrer">{String(item.data.FileName ?? 'file')}</a> : <span className="truncate">{String(item.data.FileName ?? 'file')}</span>}
            {size > 0 && <span className="shrink-0 text-xs text-muted-foreground">{size >= 1_048_576 ? `${(size / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`}</span>}
          </div>
        </div>
      </div>
    )
  }
  // P1-C: approval requests about this record (shown to those who may see the request)
  if (typeof item.data.action === 'string' && item.data.action.startsWith('approval.')) {
    const decided = item.data.action === 'approval.decided'
    const st = String(item.data.status ?? '')
    return (
      <div className="flex gap-2.5" data-testid="timeline-approval">
        <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-muted"><History className="size-3.5" /></span>
        <div className="min-w-0 flex-1 pt-1.5">{head(null, <>
          {decided ? <>Approval <a className="font-medium text-primary underline-offset-2 hover:underline" href={`#u-approvals?id=${encodeURIComponent(String(item.data.approvalId))}`}>{String(item.data.title ?? '')}</a> was <span className="font-medium text-foreground" data-testid="timeline-approval-outcome">{st === 'completed' ? `answered "${String(item.data.outcome ?? '')}"` : st}{st !== 'completed' && item.data.outcome && !['Expired', 'Cancelled'].includes(String(item.data.outcome)) ? ` (${String(item.data.outcome)})` : ''}</span></>
            : <><span className="font-medium text-foreground">{who}</span> asked for approval: <a className="text-primary underline-offset-2 hover:underline" href={`#u-approvals?id=${encodeURIComponent(String(item.data.approvalId))}`}>{String(item.data.title ?? '')}</a></>}
        </>)}</div>
      </div>
    )
  }
  const cols = (item.data.columns as string[] | undefined) ?? []
  return (
    <div className="flex gap-2.5" data-testid="timeline-event">
      <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-muted"><History className="size-3.5" /></span>
      <div className="min-w-0 flex-1 pt-1.5">{head(null, <><span className="font-medium text-foreground">{who}</span> {item.data.action === 'created' ? 'created this record' : `changed ${cols.join(', ')}`}</>)}</div>
    </div>
  )
}

function Composer({ rowId, table, onDone }: { rowId: string; table?: string; onDone(): void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [mention, setMention] = useState<{ q: string; at: number } | null>(null)
  const [people, setPeople] = useState<PersonOption[]>([])
  const mentions = useRef(new Map<string, string>())
  const ta = useRef<HTMLTextAreaElement>(null)
  const [task, setTask] = useState<{ subject: string; due: string; assignee: PersonOption | null } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!mention) return
    let live = true
    platform.collab!.mentionable(rowId, mention.q, table).then((r) => live && setPeople(r)).catch(() => live && setPeople([]))
    return () => { live = false }
  }, [mention, rowId, table])

  const onChange = (v: string, caret: number) => {
    setText(v)
    const before = v.slice(0, caret)
    const m = /(^|\s)@([\p{L}\p{N}._-]{0,30})$/u.exec(before)
    setMention(m ? { q: m[2], at: caret - m[2].length - 1 } : null)
  }
  const pick = (p: PersonOption) => {
    if (!mention) return
    const next = `${text.slice(0, mention.at)}@${p.name} ${text.slice(mention.at + 1 + mention.q.length)}`
    mentions.current.set(p.name, p.id)
    setText(next)
    setMention(null)
    ta.current?.focus()
  }
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      onDone()
      return true
    } catch (e) {
      setError(errText(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  const send = async () => {
    if (!text.trim()) return
    if (await run(() => platform.collab!.addComment({ rowId, table, body: composeBody(text.trim(), mentions.current), link: appLink(rowId) }))) {
      setText('')
      mentions.current.clear()
    }
  }
  const addTask = async () => {
    if (!task?.subject.trim()) return
    if (await run(() => platform.collab!.addActivity({ rowId, table, subject: task.subject.trim(), type: 'Task', dueOn: task.due ? new Date(task.due).toISOString() : null, assignedTo: task.assignee?.id ?? null }))) setTask(null)
  }
  const loadPeople = useCallback((q: string) => platform.collab!.people(q), [])

  return (
    <div className="space-y-2 border-b pb-3">
      <div className="relative">
        <Textarea
          ref={ta}
          value={text}
          placeholder="Write a comment. Type @ to mention someone who can see this record."
          className="min-h-[64px] resize-none text-sm"
          data-testid="timeline-composer"
          onChange={(e) => onChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send()
            if (e.key === 'Escape') setMention(null)
          }}
        />
        {mention && (
          <div className="absolute left-2 top-full z-20 mt-1 w-72 rounded-md border bg-popover p-1 shadow-md" data-testid="mention-list">
            {people.length === 0 ? (
              <div className="p-2 text-xs text-muted-foreground">No match among the people who can see this record. Only they can be mentioned.</div>
            ) : people.map((p) => (
              <button key={p.id} type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent" onMouseDown={(e) => { e.preventDefault(); pick(p) }} data-testid={`mention-${p.id}`}>
                <AvatarCircle src="" name={p.name} size="20px" />
                <span className="truncate">{p.name}</span>
                <span className="ml-auto truncate text-xs text-muted-foreground">{p.email}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {task && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border p-2">
          <Input className="h-8 min-w-40 flex-1" placeholder="Task" value={task.subject} onChange={(e) => setTask({ ...task, subject: e.target.value })} data-testid="task-subject" autoFocus />
          <Input className="h-8 w-36" type="date" value={task.due} onChange={(e) => setTask({ ...task, due: e.target.value })} aria-label="Due" />
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 max-w-40"><UserRound className="size-3.5" /><span className="truncate">{task.assignee?.name ?? 'Assign'}</span></Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-0" align="start"><PersonList load={loadPeople} onPick={(p) => setTask({ ...task, assignee: p })} /></PopoverContent>
          </Popover>
          <Button size="sm" className="h-8" disabled={busy || !task.subject.trim()} onClick={() => void addTask()}>Add task</Button>
          <Button size="sm" variant="ghost" className="h-8" onClick={() => setTask(null)}>Cancel</Button>
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="ghost" className="h-8" onClick={() => setTask(task ?? { subject: '', due: '', assignee: null })}><Plus className="size-3.5" />Task</Button>
        <Button size="sm" variant="ghost" className="h-8" onClick={() => fileRef.current?.click()}><Paperclip className="size-3.5" />File</Button>
        {platform.getState().mode === 'server' && <GenerateDocumentButton rowId={rowId} table={table} run={run} />}
        <input ref={fileRef} type="file" className="hidden" onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void run(() => platform.collab!.attachFile(rowId, f, table))
        }} />
        <span className="ml-auto truncate text-xs text-destructive">{error}</span>
        <Button size="sm" className="h-8" disabled={busy || !text.trim()} onClick={() => void send()} data-testid="timeline-send">
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <MessageSquare className="size-3.5" />}Comment
        </Button>
      </div>
    </div>
  )
}

function Tags({ rowId, table, tags, onDone }: { rowId: string; table?: string; tags: TimelinePage['tags']; onDone(): void }) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const set = async (tag: string, on: boolean) => {
    await platform.collab!.tag(rowId, tag, on, table)
    onDone()
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((t) => (
        <Badge key={t.id} variant="secondary" className="gap-1 font-normal" data-testid="timeline-tag">
          <TagIcon className="size-3" />{t.name}
          <button type="button" aria-label={`Remove ${t.name}`} onClick={() => void set(t.name, false)}><X className="size-3" /></button>
        </Badge>
      ))}
      {adding ? (
        <Input className="h-6 w-32 text-xs" autoFocus value={name} placeholder="Tag" onChange={(e) => setName(e.target.value)}
          onBlur={() => setAdding(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim()) { void set(name.trim(), true); setName(''); setAdding(false) }
            if (e.key === 'Escape') setAdding(false)
          }} />
      ) : (
        <button type="button" className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent" onClick={() => setAdding(true)}><TagIcon className="size-3" />Add tag</button>
      )}
    </div>
  )
}

/** the timeline of one record, live: refetched when a collaboration table changes (pushes) or the data changes (demo) */
export function useTimeline(rowId: string, table: string | undefined, pageSize: number) {
  const [page, setPage] = useState<TimelinePage | null>(null)
  const [more, setMore] = useState<TimelineItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const version = usePlatform((s) => (s.mode === 'demo' ? s.dataVersion : 0))
  const seq = useRef(0)
  const reload = useCallback(() => {
    if (!rowId) {
      setPage(null)
      return
    }
    const n = ++seq.current
    setLoading(true)
    platform.collab!.timeline(rowId, { table, limit: pageSize }).then((p) => {
      if (n !== seq.current) return
      setPage(p)
      setMore([])
      setCursor(p.nextCursor)
      setError('')
    }).catch((e) => {
      if (n !== seq.current) return
      setPage(null)
      setError((e as { code?: string }).code === 'not-found' ? 'You cannot see this record.' : errText(e))
    }).finally(() => n === seq.current && setLoading(false))
  }, [rowId, table, pageSize])
  useEffect(() => reload(), [reload, version])
  useEffect(() => {
    if (!rowId) return
    let t: ReturnType<typeof setTimeout> | null = null
    const bump = () => {
      if (t) clearTimeout(t)
      t = setTimeout(reload, 250)
    }
    const offs = platform.collab!.topics().map((topic) => platform.live.subscribe(topic, bump))
    return () => {
      if (t) clearTimeout(t)
      for (const off of offs) off()
    }
  }, [rowId, reload])
  const loadMore = async () => {
    if (!cursor) return
    const p = await platform.collab!.timeline(rowId, { table, limit: pageSize, cursor })
    setMore((m) => [...m, ...p.items])
    setCursor(p.nextCursor)
  }
  return { page, items: page ? [...page.items, ...more] : [], cursor, error, loading, reload, loadMore }
}

function RecordTimelineRender({ props, mode, setOutput }: ControlRenderProps) {
  const rowId = recordIdOf(props.Record)
  const table = toText(props.Table) || undefined
  const pageSize = Math.max(5, Math.min(100, Math.round(toNum(props.PageSize, 20))))
  const showComposer = toBool(props.ShowComposer, true)
  const design = mode !== 'run'
  const t = useTimeline(design ? '' : rowId, table, pageSize)
  useEffect(() => {
    if (!design) setOutput('Count', t.items.length)
  }, [design, t.items.length, setOutput])
  const toggle = async (i: TimelineItem) => {
    await platform.collab!.updateActivity(i.id, { Status: i.data.Status === 'Done' ? 'Open' : 'Done' }).catch(() => {})
    t.reload()
  }
  const del = async (i: TimelineItem) => {
    await platform.collab!.deleteComment(i.id).catch(() => {})
    t.reload()
  }
  const items = design ? DESIGN_ITEMS : t.items
  const page = design ? { following: false, followers: 2, tags: [{ id: 't', name: 'Priority', color: null }], title: 'Sample record' } : t.page
  return (
    <div className="flex size-full flex-col overflow-hidden rounded-lg border bg-card text-card-foreground" data-testid="record-timeline">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <History className="size-4 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium">{toText(props.Title) || (page?.title ? `Timeline: ${page.title}` : 'Timeline')}</span>
        {page && (
          <Button
            size="sm" variant={page.following ? 'secondary' : 'ghost'} className="ml-auto h-7" disabled={design} data-testid="timeline-follow"
            onClick={async () => { await platform.collab!.follow(rowId, !page.following, table).catch(() => {}); t.reload() }}
          >
            {page.following ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />}{page.following ? 'Following' : 'Follow'}
            {page.followers > 0 && <span className="text-xs text-muted-foreground">{page.followers}</span>}
          </Button>
        )}
      </div>
      {!design && !rowId ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground">Choose a record to see its timeline.</div>
      ) : !design && t.error ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground" data-testid="timeline-error">{t.error}</div>
      ) : (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {page && (design ? <Tags rowId="" tags={page.tags} onDone={() => {}} /> : <Tags rowId={rowId} table={table} tags={page.tags} onDone={t.reload} />)}
          {showComposer && !design && t.page?.canComment && <Composer rowId={rowId} table={table} onDone={t.reload} />}
          {items.length === 0 && !t.loading && <div className="py-6 text-center text-sm text-muted-foreground">Nothing here yet.</div>}
          {items.map((i) => <TimelineEntry key={`${i.kind}:${i.id}`} item={i} onToggle={toggle} onDelete={del} />)}
          {!design && t.cursor && <Button variant="ghost" size="sm" className="w-full" onClick={() => void t.loadMore()}>Show older</Button>}
          {t.loading && <div className="flex justify-center"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>}
        </div>
      )}
    </div>
  )
}

export const RecordTimeline: ControlType = {
  type: 'RecordTimeline',
  label: 'Record timeline',
  icon: History,
  category: 'Data',
  props: [
    { name: 'Record', kind: 'record', group: 'Data', default: '=Blank()' },
    { name: 'Table', kind: 'text', group: 'Data', default: '=""', simple: false },
    { name: 'Title', kind: 'text', group: 'Content', default: '=""' },
    { name: 'ShowComposer', label: 'Show composer', kind: 'boolean', group: 'Behaviour', default: '=true' },
    { name: 'PageSize', label: 'Page size', kind: 'number', group: 'Data', default: '=20', simple: false },
  ],
  outputs: [{ name: 'Count', initial: 0 }],
  defaultSize: { width: 420, height: 520 },
  primaryProp: 'Record',
  render: RecordTimelineRender,
}

/* ------------------------------------------------------------------ tag input */

function TagInputRender({ props, mode, setOutput }: ControlRenderProps) {
  const rowId = recordIdOf(props.Record)
  const table = toText(props.Table) || undefined
  const t = useTimeline(mode === 'run' ? rowId : '', table, 5)
  const tags = mode === 'run' ? t.page?.tags ?? [] : [{ id: 'a', name: 'Priority', color: null }, { id: 'b', name: 'Export', color: null }]
  useEffect(() => {
    if (mode === 'run') setOutput('Tags', tags.map((x) => ({ Name: x.name, Id: x.id })))
  }, [mode, tags, setOutput])
  if (mode === 'run' && !rowId) return <div className="flex size-full items-center text-sm text-muted-foreground">No record</div>
  return <div className="flex size-full items-center overflow-hidden" data-testid="tag-input"><Tags rowId={rowId} table={table} tags={tags} onDone={t.reload} /></div>
}

export const TagInput: ControlType = {
  type: 'TagInput',
  label: 'Tag input',
  icon: TagIcon,
  category: 'Input',
  props: [
    { name: 'Record', kind: 'record', group: 'Data', default: '=Blank()' },
    { name: 'Table', kind: 'text', group: 'Data', default: '=""', simple: false },
  ],
  outputs: [{ name: 'Tags', initial: [] }],
  defaultSize: { width: 320, height: 36 },
  primaryProp: 'Record',
  render: TagInputRender,
}

/* ------------------------------------------------------------------ activity list (my open tasks) */

export function TaskRow({ t, onToggle, onOpen }: { t: TaskItem; onToggle(t: TaskItem): void; onOpen?(t: TaskItem): void }) {
  const done = t.Status === 'Done'
  const overdue = !done && t.DueOn && new Date(t.DueOn).getTime() < Date.now()
  return (
    <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent/50" data-testid="task-row">
      <Checkbox checked={done} onCheckedChange={() => onToggle(t)} aria-label={`Mark "${t.Subject}" done`} />
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen?.(t)}>
        <div className={cn('truncate text-sm', done && 'text-muted-foreground line-through')}>{t.Subject}</div>
        {t.regardingLabel && <div className="truncate text-xs text-muted-foreground">{t.regardingTableName}: {t.regardingLabel}</div>}
      </button>
      {t.Priority && t.Priority !== 'Normal' && <Badge variant={t.Priority === 'Urgent' ? 'destructive' : 'outline'} className="font-normal">{t.Priority}</Badge>}
      {t.DueOn && <span className={cn('shrink-0 text-xs', overdue ? 'font-medium text-destructive' : 'text-muted-foreground')}>{due(t.DueOn)}</span>}
    </div>
  )
}

function ActivityListRender({ props, mode, setOutput }: ControlRenderProps) {
  const [items, setItems] = useState<TaskItem[] | null>(null)
  const version = usePlatform((s) => s.dataVersion)
  const all = toBool(props.ShowDone, false)
  const load = useCallback(() => {
    platform.collab!.myTasks({ all }).then(setItems).catch(() => setItems([]))
  }, [all])
  useEffect(() => {
    if (mode === 'run') load()
  }, [mode, load, version])
  useEffect(() => {
    if (mode !== 'run') return
    const offs = platform.collab!.topics().slice(0, 1).map((topic) => platform.live.subscribe(topic, () => load()))
    return () => offs.forEach((o) => o())
  }, [mode, load])
  useEffect(() => {
    if (mode === 'run') setOutput('Count', items?.length ?? 0)
  }, [mode, items, setOutput])
  const list: TaskItem[] = mode === 'run' ? items ?? [] : [
    { id: '1', Subject: 'Send the revised quote', Type: 'Task', Status: 'Open', Priority: 'High', DueOn: new Date(Date.now() + 86_400_000).toISOString(), AssignedTo: null, AssignedTeam: null, regardingTable: null, regardingId: null, regardingLabel: 'Acme Corp', regardingTableName: 'Accounts', createdOn: '', createdBy: null },
    { id: '2', Subject: 'Check the inspection report', Type: 'Task', Status: 'Open', Priority: 'Normal', DueOn: null, AssignedTo: null, AssignedTeam: null, regardingTable: null, regardingId: null, createdOn: '', createdBy: null },
  ]
  const toggle = async (t: TaskItem) => {
    await platform.collab!.updateActivity(t.id, { Status: t.Status === 'Done' ? 'Open' : 'Done' }).catch(() => {})
    load()
  }
  return (
    <div className="flex size-full flex-col overflow-hidden rounded-lg border bg-card" data-testid="activity-list">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-sm font-medium"><CheckSquare className="size-4 text-muted-foreground" />{toText(props.Title) || 'My tasks'}</div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {mode === 'run' && items === null && <div className="flex justify-center p-3"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>}
        {list.length === 0 && items !== null && <div className="p-4 text-center text-sm text-muted-foreground">No open tasks.</div>}
        {list.map((t) => <TaskRow key={t.id} t={t} onToggle={(x) => void toggle(x)} />)}
      </div>
    </div>
  )
}

export const ActivityList: ControlType = {
  type: 'ActivityList',
  label: 'Activity list',
  icon: ListTodo,
  category: 'Data',
  props: [
    { name: 'Title', kind: 'text', group: 'Content', default: '="My tasks"' },
    { name: 'ShowDone', label: 'Show done', kind: 'boolean', group: 'Data', default: '=false' },
  ],
  outputs: [{ name: 'Count', initial: 0 }],
  defaultSize: { width: 360, height: 320 },
  primaryProp: 'Title',
  render: ActivityListRender,
}


export { recordIdOf }
