/** Details of a conversation: name and description, my notifications (all / mentions / nothing, mute), members, leave, archive. */
import { useCallback, useEffect, useState } from 'react'
import { Archive, Crown, Loader2, LogOut, UserMinus, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { ChatConversation, ChatMemberView, ChatNotifyLevel, ChatPerson } from '@/platform/chat-protocol'
import { chatApi, errText } from './api'
import { Avatar, kindLabel } from './bits'
import { Confirm, PeoplePicker } from './dialogs'
import { leaveConversation, renameConversation, setArchived, updateMine, useChat } from './store'

const LEVELS: { value: ChatNotifyLevel; label: string; text: string }[] = [
  { value: 'all', label: 'Every message', text: 'A notification for every message.' },
  { value: 'mentions', label: 'Mentions only', text: 'Only when someone mentions you or @channel.' },
  { value: 'none', label: 'Nothing', text: 'No notifications; the unread count still shows.' },
]

export function ConversationInfo({ c, onClose }: { c: ChatConversation; onClose(): void }) {
  const me = useChat((s) => s.me)
  const [members, setMembers] = useState<ChatMemberView[] | null>(null)
  const [err, setErr] = useState('')
  const [adding, setAdding] = useState<ChatPerson[] | null>(null)
  const [confirm, setConfirm] = useState<null | 'leave' | 'archive'>(null)
  const [name, setName] = useState(c.name)
  const [description, setDescription] = useState(c.description)
  const owner = c.me?.role === 'owner'
  const isChannel = c.kind === 'channel'
  const canEdit = !c.archived && ((isChannel && owner) || c.kind === 'group') && !me?.readOnly
  const canAdd = !c.archived && !me?.readOnly && c.kind !== 'direct' && (!isChannel || !c.isPrivate || owner)
  const canRemove = !c.archived && !me?.readOnly && isChannel && owner

  const load = useCallback(() => {
    chatApi.members(c.id).then((r) => setMembers(r.items)).catch((e) => setErr(errText(e)))
  }, [c.id])
  useEffect(() => load(), [load, c.memberCount])
  const run = async (fn: () => Promise<unknown>) => {
    setErr('')
    try {
      await fn()
    } catch (e) {
      setErr(errText(e))
    }
  }
  const loadAddable = useCallback((q: string) => (c.isPrivate || c.kind === 'group' ? chatApi.people(q) : chatApi.mentionable(c.id, q)).then((r) => r.users), [c.id, c.isPrivate, c.kind])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3 text-sm" data-testid="chat-info-pane">
      <section className="grid gap-2">
        <p className="text-xs text-muted-foreground">{kindLabel(c)}{c.archived ? ' · archived (read-only)' : ''}</p>
        {canEdit && c.kind !== 'direct' ? (
          <div className="grid gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" maxLength={80} />
            {isChannel && <Input value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Description" placeholder="Description" maxLength={500} />}
            {(name !== c.name || description !== c.description) && (
              <Button size="xs" className="justify-self-start" onClick={() => void run(() => renameConversation(c.id, { name: name.trim(), ...(isChannel ? { description: description.trim() } : {}) }))}>Save</Button>
            )}
          </div>
        ) : (
          c.description && <p className="whitespace-pre-wrap">{c.description}</p>
        )}
      </section>

      {c.me && (
        <section className="mt-4 grid gap-2" aria-label="My notifications">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notifications</h3>
          <div role="radiogroup" aria-label="Notify me about" className="grid gap-1">
            {LEVELS.map((l) => (
              <label key={l.value} className={cn('flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5', c.me?.notifyLevel === l.value ? 'border-primary/60 bg-primary/5' : 'border-border')}>
                <input type="radio" name={`notify-${c.id}`} className="mt-1" checked={c.me?.notifyLevel === l.value} onChange={() => void run(() => updateMine(c.id, { notifyLevel: l.value }))} data-testid={`chat-notify-${l.value}`} />
                <span><span className="block font-medium">{l.label}</span><span className="block text-xs text-muted-foreground">{l.text}</span></span>
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2.5">
            <Switch checked={c.me.muted} onCheckedChange={(v) => void run(() => updateMine(c.id, { muted: v }))} aria-label="Mute" data-testid="chat-mute" />
            <span><span className="font-medium">Mute</span> <span className="text-xs text-muted-foreground">nothing at all, and no badge</span></span>
          </label>
        </section>
      )}

      <section className="mt-4 grid gap-1.5" aria-label="Members">
        <div className="flex items-center gap-2">
          <h3 className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Members {members ? `(${members.length})` : ''}</h3>
          {canAdd && adding === null && <Button size="xs" variant="outline" onClick={() => setAdding([])} data-testid="chat-add-members"><UserPlus /> Add</Button>}
        </div>
        {adding !== null && (
          <div className="grid gap-2 rounded-md border border-border p-2">
            <PeoplePicker picked={adding} onChange={setAdding} max={50} exclude={members?.map((m) => m.id) ?? []} load={loadAddable} label="Add people" testId="chat-add-people" />
            <div className="flex gap-2">
              <Button size="xs" disabled={!adding.length} onClick={() => void run(async () => { await chatApi.addMembers(c.id, adding.map((p) => p.id)); setAdding(null); load() })} data-testid="chat-add-confirm">Add {adding.length || ''}</Button>
              <Button size="xs" variant="ghost" onClick={() => setAdding(null)}>Cancel</Button>
            </div>
          </div>
        )}
        {members === null ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : (
          <ul className="grid gap-0.5">
            {members.map((m) => (
              <li key={m.id} className="flex min-h-9 items-center gap-2 rounded px-1 hover:bg-muted/50" data-testid="chat-member" data-name={m.name}>
                <Avatar id={m.id} name={m.name} size={24} />
                <span className="min-w-0 flex-1 truncate">{m.name}{m.id === me?.id ? ' (you)' : ''}</span>
                {m.role === 'owner' && <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><Crown className="size-3" /> owner</span>}
                {canRemove && m.id !== me?.id && (
                  <>
                    {m.role !== 'owner' && <Button size="icon-sm" variant="ghost" title="Make owner" aria-label={`Make ${m.name} an owner`} onClick={() => void run(async () => { await chatApi.setRole(c.id, m.id, 'owner'); load() })}><Crown /></Button>}
                    <Button size="icon-sm" variant="ghost" title="Remove from the channel" aria-label={`Remove ${m.name}`} data-testid="chat-remove-member" onClick={() => void run(async () => { await chatApi.removeMember(c.id, m.id); load() })}><UserMinus /></Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {err && <p className="mt-3 text-xs text-destructive" role="alert" data-testid="chat-info-error">{err}</p>}

      <section className="mt-5 flex flex-wrap gap-2 border-t border-border pt-3">
        {c.me && c.kind !== 'direct' && <Button size="sm" variant="outline" onClick={() => setConfirm('leave')} data-testid="chat-leave"><LogOut /> Leave</Button>}
        {c.me && ((isChannel && owner) || c.kind === 'group') && !me?.readOnly && (
          <Button size="sm" variant="outline" onClick={() => (c.archived ? void run(() => setArchived(c.id, false)) : setConfirm('archive'))}><Archive /> {c.archived ? 'Unarchive' : 'Archive'}</Button>
        )}
      </section>
      <Confirm open={confirm === 'leave'} title={`Leave ${isChannel ? `#${c.name}` : 'this conversation'}?`} action="Leave" onClose={() => setConfirm(null)} onConfirm={async () => { await leaveConversation(c.id); onClose() }} testId="chat-leave-confirm">
        {c.isPrivate || c.kind === 'group' ? 'You stop seeing its messages. Someone in it has to add you again.' : 'You can join this open channel again at any time.'}
      </Confirm>
      <Confirm open={confirm === 'archive'} title="Archive this conversation?" action="Archive" onClose={() => setConfirm(null)} onConfirm={() => setArchived(c.id, true)}>
        Its members can still read it, nobody can post. {isChannel && !c.isPrivate ? 'An archived open channel is no longer readable by people who are not in it.' : ''}
      </Confirm>
    </div>
  )
}
