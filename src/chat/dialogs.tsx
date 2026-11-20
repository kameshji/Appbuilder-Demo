/** Chat dialogs: new conversation, browse open channels, people picker, report a message, confirm. */
import { useEffect, useState, type ReactNode } from 'react'
import { Hash, Loader2, Lock, User, Users, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { CHAT_LIMITS, type ChatConversation, type ChatMessageView, type ChatPerson } from '@/platform/chat-protocol'
import { chatApi, errText } from './api'
import { Avatar } from './bits'
import { createConversation, joinConversation, openConversation, useChat } from './store'

/* ------------------------------------------------------------------ people */

const loadPeople = (q: string) => chatApi.people(q).then((r) => r.users)

/** search people who use chat (the server applies the directory's visibility) and pick some; `load` must be stable */
export function PeoplePicker({ picked, onChange, max, exclude = [], load = loadPeople, label = 'People', testId = 'chat-people' }: {
  picked: ChatPerson[]
  onChange(p: ChatPerson[]): void
  max: number
  exclude?: string[]
  load?: (q: string) => Promise<ChatPerson[]>
  label?: string
  testId?: string
}) {
  const [q, setQ] = useState('')
  const [found, setFound] = useState<ChatPerson[] | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      load(q.trim()).then((r) => live && setFound(r)).catch((e) => live && setErr(errText(e)))
    }, 200)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [q, load])
  const skip = new Set([...exclude, ...picked.map((p) => p.id)])
  const full = picked.length >= max
  return (
    <div className="grid gap-2" data-testid={testId}>
      <label className="text-sm font-medium" htmlFor={`${testId}-q`}>{label}</label>
      {picked.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {picked.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1 rounded-full bg-muted py-0.5 pl-1 pr-1.5 text-xs">
              <Avatar id={p.id} name={p.name} size={18} />
              {p.name}
              <button type="button" aria-label={`Remove ${p.name}`} className="rounded-full p-0.5 hover:bg-background" onClick={() => onChange(picked.filter((x) => x.id !== p.id))}><X className="size-3" /></button>
            </span>
          ))}
        </div>
      )}
      <Input id={`${testId}-q`} value={q} onChange={(e) => setQ(e.target.value)} placeholder={full ? `At most ${max}` : 'Type a name'} disabled={full} data-testid={`${testId}-search`} />
      {err && <p className="text-xs text-destructive">{err}</p>}
      <ul className="max-h-44 overflow-y-auto rounded-md border border-border" aria-label="People found">
        {found === null && <li className="p-2 text-xs text-muted-foreground"><Loader2 className="inline size-3 animate-spin" /> Loading</li>}
        {found?.filter((p) => !skip.has(p.id)).slice(0, 30).map((p) => (
          <li key={p.id}>
            <button type="button" disabled={full} className="flex min-h-9 w-full items-center gap-2 px-2 py-1 text-left text-sm hover:bg-muted disabled:opacity-50" data-testid={`${testId}-pick`} data-person={p.name} onClick={() => { onChange([...picked, p]); setQ('') }}>
              <Avatar id={p.id} name={p.name} size={22} />
              <span className="truncate">{p.name}</span>
            </button>
          </li>
        ))}
        {found && found.filter((p) => !skip.has(p.id)).length === 0 && <li className="p-2 text-xs text-muted-foreground">No one found.</li>}
      </ul>
    </div>
  )
}

/* ------------------------------------------------------------------ new conversation */

type NewKind = 'direct' | 'group' | 'channel'

export function NewConversationDialog({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const me = useChat((s) => s.me)
  const [kind, setKind] = useState<NewKind>('direct')
  const [people, setPeople] = useState<ChatPerson[]>([])
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isPrivate, setPrivate] = useState(false)
  const [ownersPost, setOwnersPost] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    if (!open) return
    setPeople([])
    setName('')
    setDescription('')
    setPrivate(false)
    setOwnersPost(false)
    setErr('')
    setBusy(false)
  }, [open])
  useEffect(() => { setPeople([]); setErr('') }, [kind])
  const canChannel = !!me?.canCreateChannels
  const max = kind === 'direct' ? 1 : kind === 'group' ? CHAT_LIMITS.maxGroupMembers - 1 : 200
  const ready = kind === 'direct' ? people.length === 1 : kind === 'group' ? people.length >= 2 : name.trim().length > 0
  const create = async () => {
    setBusy(true)
    setErr('')
    try {
      await createConversation(kind === 'channel'
        ? { kind, name: name.trim(), description: description.trim() || undefined, isPrivate, members: people.map((p) => p.id), postingPolicy: ownersPost ? 'owners' : 'everyone' }
        : { kind, members: people.map((p) => p.id) })
      onOpenChange(false)
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const tab = (k: NewKind, label: string, Icon: typeof User, disabled = false) => (
    <button type="button" role="tab" aria-selected={kind === k} disabled={disabled} title={disabled ? 'Only makers and administrators may create channels here.' : undefined} data-testid={`chat-new-${k}`} onClick={() => setKind(k)}
      className={cn('inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[5px] text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50', kind === k ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
      <Icon className="size-3.5" /> {label}
    </button>
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="chat-new-dialog">
        <DialogHeader>
          <DialogTitle>New conversation</DialogTitle>
          <DialogDescription>A direct conversation with one person, a group of up to {CHAT_LIMITS.maxGroupMembers}, or a channel for a team or topic.</DialogDescription>
        </DialogHeader>
        <div role="tablist" aria-label="Kind" className="flex gap-0.5 rounded-md bg-muted p-0.5">
          {tab('direct', 'Direct', User)}
          {tab('group', 'Group', Users)}
          {tab('channel', 'Channel', Hash, !canChannel)}
        </div>
        {kind === 'channel' && (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <label className="text-sm font-medium" htmlFor="chat-new-name">Name</label>
              <Input id="chat-new-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Quality" data-testid="chat-new-name" autoFocus />
            </div>
            <div className="grid gap-1.5">
              <label className="text-sm font-medium" htmlFor="chat-new-desc">Description <span className="font-normal text-muted-foreground">(optional)</span></label>
              <Input id="chat-new-desc" value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <label className="flex items-start gap-3 text-sm">
              <Switch checked={isPrivate} onCheckedChange={setPrivate} aria-label="Private channel" data-testid="chat-new-private" />
              <span><span className="flex items-center gap-1 font-medium"><Lock className="size-3.5" /> Private</span><span className="text-xs text-muted-foreground">Only the people you add can find and read it. Fixed once created.</span></span>
            </label>
            <label className="flex items-start gap-3 text-sm">
              <Switch checked={ownersPost} onCheckedChange={setOwnersPost} aria-label="Only owners post" />
              <span><span className="font-medium">Only owners post</span><span className="block text-xs text-muted-foreground">For announcements: everyone reads, owners write.</span></span>
            </label>
          </div>
        )}
        <PeoplePicker
          key={kind}
          picked={people}
          onChange={setPeople}
          max={max}
          exclude={me ? [me.id] : []}
          label={kind === 'direct' ? 'Person' : kind === 'group' ? 'People (2 or more)' : isPrivate ? 'Members' : 'Members (optional: anyone can join an open channel)'}
        />
        {err && <p className="text-sm text-destructive" role="alert" data-testid="chat-new-error">{err}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!ready || busy} onClick={() => void create()} data-testid="chat-new-create">{busy && <Loader2 className="animate-spin" />} {kind === 'direct' ? 'Open' : 'Create'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ browse open channels */

export function BrowseChannelsDialog({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const [items, setItems] = useState<ChatConversation[] | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  useEffect(() => {
    if (!open) return
    setItems(null)
    setErr('')
    chatApi.conversations(true).then((r) => setItems(r.items)).catch((e) => setErr(errText(e)))
  }, [open])
  const join = async (c: ChatConversation) => {
    setBusy(c.id)
    try {
      await joinConversation(c.id)
      await openConversation(c.id)
      onOpenChange(false)
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy('')
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="chat-browse-dialog">
        <DialogHeader>
          <DialogTitle>Open channels</DialogTitle>
          <DialogDescription>Channels everyone may read and join. Private channels are not listed.</DialogDescription>
        </DialogHeader>
        {err && <p className="text-sm text-destructive">{err}</p>}
        <ul className="max-h-80 overflow-y-auto">
          {items === null && !err && <li className="p-2 text-sm text-muted-foreground"><Loader2 className="inline size-3.5 animate-spin" /> Loading</li>}
          {items?.length === 0 && <li className="p-2 text-sm text-muted-foreground">You are in every open channel.</li>}
          {items?.map((c) => (
            <li key={c.id} className="flex items-center gap-2 border-b border-border py-2 last:border-0">
              <Hash className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{c.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{c.description || `${c.memberCount} members`}</span>
              </span>
              <Button size="xs" variant="outline" onClick={() => void openConversation(c.id).then(() => onOpenChange(false))}>View</Button>
              <Button size="xs" disabled={busy === c.id} onClick={() => void join(c)} data-testid="chat-browse-join">{busy === c.id && <Loader2 className="animate-spin" />}Join</Button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ report */

export function ReportDialog({ message, onClose }: { message: ChatMessageView | null; onClose(): void }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(false)
  useEffect(() => {
    setReason('')
    setErr('')
    setDone(false)
  }, [message])
  const send = async () => {
    if (!message) return
    setBusy(true)
    try {
      await chatApi.report(message.id, reason.trim())
      setDone(true)
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={!!message} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="chat-report-dialog">
        <DialogHeader>
          <DialogTitle>Report this message</DialogTitle>
          <DialogDescription>The administrators of chat are told that a report waits. They will see this message's text and your reason; nobody else is told who reported it.</DialogDescription>
        </DialogHeader>
        {done ? (
          <p className="text-sm" data-testid="chat-report-done">Thank you. The administrators were told.</p>
        ) : (
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder="What is wrong with it?" data-testid="chat-report-reason" autoFocus />
        )}
        {err && <p className="text-sm text-destructive" role="alert">{err}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{done ? 'Close' : 'Cancel'}</Button>
          {!done && <Button disabled={!reason.trim() || busy} onClick={() => void send()} data-testid="chat-report-send">{busy && <Loader2 className="animate-spin" />}Report</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ confirm */

export function Confirm({ open, title, children, action, destructive, onConfirm, onClose, testId }: { open: boolean; title: string; children: ReactNode; action: string; destructive?: boolean; onConfirm(): Promise<void> | void; onClose(): void; testId?: string }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { if (open) setErr('') }, [open])
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm" data-testid={testId}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild><div>{children}</div></DialogDescription>
        </DialogHeader>
        {err && <p className="text-sm text-destructive" role="alert">{err}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant={destructive ? 'destructive' : 'default'} disabled={busy} data-testid={testId ? `${testId}-ok` : undefined} onClick={async () => {
            setBusy(true)
            try {
              await onConfirm()
              onClose()
            } catch (e) {
              setErr(errText(e))
            } finally {
              setBusy(false)
            }
          }}>{busy && <Loader2 className="animate-spin" />}{action}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
