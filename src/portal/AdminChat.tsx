/**
 * Admin console > Chat (P3 package B; docs/admin/chat.md): settings (who creates channels, retention per kind, the chat
 * environment while chat is empty), read-only people, conversations as metadata (never message text), moderation
 * (archive, remove a member, delete), the reports queue (the reported message's text, which the reporter chose to
 * show), the audited export of one conversation with a typed reason (members are told), and retention run now.
 * Administrators of the chat environment; the server checks every action and audits it.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Archive, Download, Flag, Loader2, Lock, RefreshCw, Search, Trash2, UserMinus, Users } from 'lucide-react'
import { usePlatform } from '@/platform'
import { CHAT_LIMITS, type ChatMemberView, type ChatPerson } from '@/platform/chat-protocol'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'
import { chatAdminApi, errText, needsReauth, type ChatAdminChannel, type ChatAdminExport, type ChatAdminReport, type ChatAdminSettings } from '@/chat/api'
import { PeoplePicker } from '@/chat/dialogs'
import { Field, Panel, Segmented, fmtRelative, useToast } from './kit'

const th = 'py-1.5 pr-2 text-left font-medium'
const KINDS = [{ value: 'channel', label: 'Channels' }, { value: 'direct', label: 'Direct' }, { value: 'group', label: 'Groups' }] as const
type Kind = 'channel' | 'direct' | 'group'

const kindText = (k: string, isPrivate?: boolean) => (k === 'direct' ? 'Direct' : k === 'group' ? 'Group' : isPrivate ? 'Private channel' : 'Open channel')

export function ChatAdminSection({ title }: { title(t: string, sub?: ReactNode, actions?: ReactNode): ReactNode }) {
  const [st, setSt] = useState<ChatAdminSettings | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => chatAdminApi.settings().then(setSt).catch((e) => setError(errText(e))), [])
  useEffect(() => { void load() }, [load])
  if (error) return <>{title('Chat')}<p className="text-sm text-destructive" data-testid="chat-admin-error">{error}</p></>
  if (!st) return <Spinner />
  return (
    <div className="grid gap-6" data-testid="chat-admin">
      {title('Chat', 'Settings, conversations, reports and exports. Administrators see names, kinds and members of every conversation, never the messages of conversations they are not in; a conversation is read only through the announced, audited export.')}
      <SettingsPanel st={st} onSaved={setSt} />
      <ReadOnlyPanel st={st} onChanged={load} />
      <ReportsPanel />
      <ConversationsPanel />
      <ExportsPanel />
      <p className="text-xs text-muted-foreground">
        Whether reading, keeping, exporting or deleting employees' conversations is allowed or must be announced where you work is a question for your lawyer. These are the product's defaults, not legal advice.
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ settings */

function RetentionField({ label, value, onChange, testId }: { label: string; value: number | null; onChange(v: number | null): void; testId: string }) {
  const keep = value === null
  return (
    <div className="grid gap-1.5" data-testid={testId}>
      <span className="text-sm font-medium">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label={label} size="sm" value={keep ? 'keep' : 'days'} onChange={(v) => onChange(v === 'keep' ? null : value !== null && Number.isFinite(value) ? value : 365)} options={[{ value: 'keep', label: 'Keep everything' }, { value: 'days', label: 'Remove after' }]} />
        {!keep && (
          <>
            <Input type="number" min={CHAT_LIMITS.minRetentionDays} className="h-8 w-24" value={value === null || Number.isNaN(value) ? '' : value} onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))} aria-label={`${label}: days`} data-testid={`${testId}-days`} />
            <span className="text-sm text-muted-foreground">days</span>
          </>
        )}
      </div>
    </div>
  )
}

function SettingsPanel({ st, onSaved }: { st: ChatAdminSettings; onSaved(s: ChatAdminSettings): void }) {
  const { toast, fail } = useToast()
  const envs = usePlatform((s) => s.environments)
  const [create, setCreate] = useState(st.createChannels)
  const [ret, setRet] = useState(st.retention)
  const [env, setEnv] = useState(st.environmentId)
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)
  useEffect(() => {
    setCreate(st.createChannels)
    setRet(st.retention)
    setEnv(st.environmentId)
  }, [st])
  // a period being typed may be incomplete (NaN, too short): Save waits for a whole number of at least the minimum
  const short = Object.values(ret).some((v) => v !== null && (!Number.isInteger(v) || v < CHAT_LIMITS.minRetentionDays))
  const dirty = create !== st.createChannels || JSON.stringify(ret) !== JSON.stringify(st.retention) || env !== st.environmentId
  const save = async () => {
    setBusy(true)
    try {
      onSaved(await chatAdminApi.saveSettings({ createChannels: create, retention: ret, ...(env !== st.environmentId ? { environmentId: env } : {}) }))
      toast('Chat settings saved', 'success')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const runNow = async () => {
    setRunning(true)
    try {
      const r = await chatAdminApi.runRetention()
      toast(`Retention ran: ${Object.entries(r).map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ') || 'done'}`, 'success')
    } catch (e) {
      fail(e)
    } finally {
      setRunning(false)
    }
  }
  return (
    <Panel className="grid gap-4 p-4" data-testid="chat-admin-settings">
      <div className="text-sm font-semibold">Settings</div>
      <Field label="Who may create channels" hint="Direct and group conversations are open to everyone who uses chat.">
        <Segmented label="Who may create channels" value={create} onChange={setCreate} options={[{ value: 'everyone', label: 'Everyone who uses chat' }, { value: 'makers', label: 'Makers and administrators only' }]} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <RetentionField label="Channels" value={ret.channel} onChange={(v) => setRet({ ...ret, channel: v })} testId="chat-ret-channel" />
        <RetentionField label="Direct conversations" value={ret.direct} onChange={(v) => setRet({ ...ret, direct: v })} testId="chat-ret-direct" />
        <RetentionField label="Group conversations" value={ret.group} onChange={(v) => setRet({ ...ret, group: v })} testId="chat-ret-group" />
      </div>
      <p className="text-xs text-muted-foreground">
        Every night (job "chat.retention", 02:17) messages older than the period are removed for good, with their reactions, mentions and files; a thread goes with its first message. At least {CHAT_LIMITS.minRetentionDays} days. Backups taken before still hold them.
      </p>
      {short && <p className="text-xs text-destructive">A period is a whole number of days, at least {CHAT_LIMITS.minRetentionDays}.</p>}
      <Field label="The chat environment" hint={st.canChangeEnvironment ? (st.messages > 0 ? `Chat holds ${st.messages} messages: it stays in this environment (moving history is not built).` : 'Chat is empty: an install administrator may store it in another environment.') : 'Install administrators choose it, only while chat is empty.'}>
        <select className="h-8 rounded-md border border-input bg-background px-2 text-sm" value={env} disabled={!st.canChangeEnvironment || st.messages > 0} onChange={(e) => setEnv(e.target.value)} aria-label="The chat environment" data-testid="chat-admin-env">
          {(envs.some((e) => e.id === env) ? envs : [{ id: env, name: env }, ...envs]).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!dirty || busy || short} onClick={() => void save()} data-testid="chat-admin-save">{busy && <Spinner />}Save</Button>
        <Button size="sm" variant="outline" disabled={running} onClick={() => void runNow()} data-testid="chat-admin-retention-run">{running ? <Spinner /> : <RefreshCw />}Run retention now</Button>
      </div>
    </Panel>
  )
}

/* ------------------------------------------------------------------ read-only people */

function ReadOnlyPanel({ st, onChanged }: { st: ChatAdminSettings; onChanged(): void }) {
  const { toast, fail } = useToast()
  const [picked, setPicked] = useState<ChatPerson[]>([])
  const set = async (userId: string, readOnly: boolean) => {
    try {
      await chatAdminApi.setReadOnly(userId, readOnly)
      toast(readOnly ? 'Made read-only in chat' : 'Can post in chat again', 'success')
      setPicked([])
      onChanged()
    } catch (e) {
      fail(e)
    }
  }
  return (
    <Panel className="grid gap-3 p-4" data-testid="chat-admin-readonly">
      <div className="text-sm font-semibold">Read-only people</div>
      <p className="text-xs text-muted-foreground">They read chat, they cannot post, react or start conversations. Recorded in the audit log ("chat.readonly").</p>
      {st.readOnly.length === 0 ? <p className="text-sm text-muted-foreground">Nobody.</p> : (
        <ul className="grid gap-1">
          {st.readOnly.map((p) => (
            <li key={p.id} className="flex items-center gap-2 text-sm" data-testid="chat-admin-readonly-person" data-name={p.name}>
              <span className="flex-1">{p.name}</span>
              <Button size="xs" variant="outline" onClick={() => void set(p.id, false)}>Allow posting</Button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-2 sm:max-w-md">
        <PeoplePicker picked={picked} onChange={setPicked} max={1} exclude={st.readOnly.map((p) => p.id)} label="Make someone read-only" testId="chat-admin-ro-people" />
        <Button size="sm" className="justify-self-start" disabled={!picked.length} onClick={() => void set(picked[0].id, true)} data-testid="chat-admin-ro-add">Make read-only</Button>
      </div>
    </Panel>
  )
}

/* ------------------------------------------------------------------ reports */

function ReportsPanel() {
  const { toast, fail } = useToast()
  const [state, setState] = useState<'open' | 'handled' | 'all'>('open')
  const [items, setItems] = useState<ChatAdminReport[] | null>(null)
  const [busy, setBusy] = useState('')
  const load = useCallback(() => chatAdminApi.reports(state).then((r) => setItems(r.items)).catch((e) => { setItems([]); fail(e) }), [state, fail])
  useEffect(() => { setItems(null); void load() }, [load])
  const handle = async (r: ChatAdminReport, action: 'delete' | 'dismiss') => {
    setBusy(r.id)
    try {
      await chatAdminApi.handleReport(r.id, action)
      toast(action === 'delete' ? 'The message was deleted; its members see "deleted by an administrator"' : 'Report dismissed', 'success')
      void load()
    } catch (e) {
      fail(e)
    } finally {
      setBusy('')
    }
  }
  return (
    <Panel className="grid gap-3 p-4" data-testid="chat-admin-reports">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-1 items-center gap-2 text-sm font-semibold"><Flag className="size-4" /> Reported messages</div>
        <Segmented label="Reports" size="sm" value={state} onChange={setState} options={[{ value: 'open', label: 'Waiting' }, { value: 'handled', label: 'Handled' }, { value: 'all', label: 'All' }]} />
      </div>
      <p className="text-xs text-muted-foreground">A member reported these messages and chose to show their text to you. Deleting removes the text, files and reactions; a "deleted by an administrator" line stays. The audit log keeps who, when and which message, never the text.</p>
      {items === null ? <Spinner /> : items.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="chat-admin-reports-empty">No reports.</p> : (
        <ul className="grid gap-2">
          {items.map((r) => (
            <li key={r.id} className="grid gap-1 rounded-md border border-border p-3 text-sm" data-testid="chat-admin-report" data-message={r.message.id}>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{r.channel.kind === 'channel' ? `#${r.channel.name}` : kindText(r.channel.kind)}</span>
                <span>·</span>
                <span>{r.message.sender?.name ?? 'Someone'} wrote{r.message.sentOn ? ` ${fmtRelative(r.message.sentOn)}` : ''}</span>
                <span>·</span>
                <span>reported by {r.reporter.name}{r.createdOn ? ` ${fmtRelative(r.createdOn)}` : ''}</span>
                {r.state === 'handled' && <Badge variant="outline">{r.outcome ?? 'handled'}{r.handledBy ? ` by ${r.handledBy}` : ''}</Badge>}
              </div>
              <blockquote className="whitespace-pre-wrap border-l-2 border-border pl-2" data-testid="chat-admin-report-text">{r.message.deleted ? <em className="text-muted-foreground">The message was deleted.</em> : r.message.text}</blockquote>
              <p className="text-xs"><span className="text-muted-foreground">Reason:</span> {r.reason}</p>
              {r.state === 'open' && (
                <div className="flex gap-2">
                  <Button size="xs" variant="destructive" disabled={busy === r.id || r.message.deleted} onClick={() => void handle(r, 'delete')} data-testid="chat-admin-report-delete"><Trash2 /> Delete the message</Button>
                  <Button size="xs" variant="outline" disabled={busy === r.id} onClick={() => void handle(r, 'dismiss')} data-testid="chat-admin-report-dismiss">Dismiss</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/* ------------------------------------------------------------------ conversations (metadata only) */

function ConversationsPanel() {
  const { toast, fail } = useToast()
  const [kind, setKind] = useState<Kind>('channel')
  const [q, setQ] = useState('')
  const [items, setItems] = useState<ChatAdminChannel[] | null>(null)
  const [more, setMore] = useState(false)
  const [members, setMembers] = useState<ChatAdminChannel | null>(null)
  const [exporting, setExporting] = useState<ChatAdminChannel | null>(null)
  const [deleting, setDeleting] = useState<ChatAdminChannel | null>(null)
  const load = useCallback(async (offset = 0) => {
    try {
      const r = await chatAdminApi.channels({ q: q.trim() || undefined, kind, offset })
      setItems((cur) => (offset && cur ? [...cur, ...r.items] : r.items))
      setMore(r.more)
    } catch (e) {
      setItems([])
      fail(e)
    }
  }, [q, kind, fail])
  useEffect(() => {
    const t = setTimeout(() => void load(0), 250)
    return () => clearTimeout(t)
  }, [load])
  const archive = async (c: ChatAdminChannel) => {
    try {
      await chatAdminApi.archive(c.id, !c.archived)
      toast(c.archived ? 'Unarchived' : 'Archived: read-only for its members', 'success')
      void load(0)
    } catch (e) {
      fail(e)
    }
  }
  return (
    <Panel className="grid gap-3 p-4" data-testid="chat-admin-conversations">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 text-sm font-semibold">Conversations</div>
        <Segmented label="Kind" size="sm" value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k.value, label: k.label }))} />
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-8 w-48 pl-7" placeholder="Name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search conversations by name" data-testid="chat-admin-search" />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Names, kinds, members and counts only. Message text is not shown here.</p>
      {items === null ? <Spinner /> : items.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground"><tr><th className={th}>Name</th><th className={th}>Kind</th><th className={th}>Members</th><th className={th}>Messages</th><th className={th}>Reports</th><th className={th}>Last message</th><th className={th} /></tr></thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} className="border-t border-border" data-testid="chat-admin-conv" data-name={c.name} data-id={c.id}>
                  <td className="py-1.5 pr-2">
                    <span className="flex items-center gap-1.5">{c.isPrivate && c.kind === 'channel' && <Lock className="size-3.5 text-muted-foreground" />}<span className="font-medium">{c.kind === 'channel' ? `#${c.name}` : c.name || '-'}</span>{c.archived && <Badge variant="outline">archived</Badge>}</span>
                    {c.description && <span className="block text-xs text-muted-foreground">{c.description}</span>}
                  </td>
                  <td className="py-1.5 pr-2 text-xs">{kindText(c.kind, c.isPrivate)}</td>
                  <td className="py-1.5 pr-2 tabular-nums">{c.members}</td>
                  <td className="py-1.5 pr-2 tabular-nums">{c.messages}</td>
                  <td className="py-1.5 pr-2 tabular-nums">{c.openReports ? <Badge variant="destructive">{c.openReports}</Badge> : 0}</td>
                  <td className="py-1.5 pr-2 text-xs text-muted-foreground">{c.lastMessageOn ? fmtRelative(c.lastMessageOn) : '-'}</td>
                  <td className="py-1.5">
                    <div className="flex justify-end gap-1">
                      <Button size="icon-sm" variant="ghost" title="Members" aria-label={`Members of ${c.name}`} onClick={() => setMembers(c)} data-testid="chat-admin-members"><Users /></Button>
                      <Button size="icon-sm" variant="ghost" title={c.archived ? 'Unarchive' : 'Archive'} aria-label={c.archived ? 'Unarchive' : 'Archive'} onClick={() => void archive(c)} data-testid="chat-admin-archive"><Archive /></Button>
                      <Button size="icon-sm" variant="ghost" title="Export with a reason" aria-label={`Export ${c.name}`} onClick={() => setExporting(c)} data-testid="chat-admin-export"><Download /></Button>
                      <Button size="icon-sm" variant="ghost" title="Delete for good" aria-label={`Delete ${c.name}`} onClick={() => setDeleting(c)} data-testid="chat-admin-delete"><Trash2 /></Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {more && <Button size="xs" variant="ghost" onClick={() => void load(items.length)}>Show more</Button>}
        </div>
      )}
      <MembersDialog c={members} onClose={() => { setMembers(null); void load(0) }} />
      <ExportDialog c={exporting} onClose={() => setExporting(null)} />
      <DeleteDialog c={deleting} onClose={() => setDeleting(null)} onDone={() => void load(0)} />
    </Panel>
  )
}

function MembersDialog({ c, onClose }: { c: ChatAdminChannel | null; onClose(): void }) {
  const { toast, fail } = useToast()
  const [items, setItems] = useState<ChatMemberView[] | null>(null)
  const load = useCallback(() => { if (c) chatAdminApi.channelMembers(c.id).then((r) => setItems(r.items)).catch(fail) }, [c, fail])
  useEffect(() => { setItems(null); load() }, [load])
  const remove = async (m: ChatMemberView) => {
    if (!c) return
    try {
      await chatAdminApi.removeMember(c.id, m.id)
      toast(`${m.name} was removed; they stop receiving the conversation at once`, 'success')
      load()
    } catch (e) {
      fail(e)
    }
  }
  return (
    <Dialog open={!!c} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="chat-admin-members-dialog">
        <DialogHeader>
          <DialogTitle>Members of {c ? (c.kind === 'channel' ? `#${c.name}` : kindText(c.kind)) : ''}</DialogTitle>
          <DialogDescription>Removing a member is recorded in the audit log ("chat.member.remove").</DialogDescription>
        </DialogHeader>
        {items === null ? <Spinner /> : (
          <ul className="grid max-h-80 gap-1 overflow-y-auto">
            {items.map((m) => (
              <li key={m.id} className="flex items-center gap-2 text-sm" data-testid="chat-admin-member" data-name={m.name}>
                <span className="flex-1">{m.name} {m.role === 'owner' && <Badge variant="outline">owner</Badge>}</span>
                {c?.kind !== 'direct' && <Button size="xs" variant="outline" onClick={() => void remove(m)} data-testid="chat-admin-member-remove"><UserMinus /> Remove</Button>}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ExportDialog({ c, onClose }: { c: ChatAdminChannel | null; onClose(): void }) {
  const [reason, setReason] = useState('')
  const [password, setPassword] = useState('')
  const [reauth, setReauth] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState<{ url: string; expiresOn: string } | null>(null)
  useEffect(() => {
    setReason('')
    setPassword('')
    setReauth(false)
    setErr('')
    setDone(null)
  }, [c])
  const go = async () => {
    if (!c) return
    setBusy(true)
    setErr('')
    try {
      if (reauth) await chatAdminApi.reauth(password)
      setDone(await chatAdminApi.exportChannel(c.id, reason.trim()))
    } catch (e) {
      if (needsReauth(e)) setReauth(true)
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={!!c} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="chat-admin-export-dialog">
        <DialogHeader>
          <DialogTitle>Export {c ? (c.kind === 'channel' ? `#${c.name}` : `this ${kindText(c.kind).toLowerCase()} conversation`) : ''}</DialogTitle>
          <DialogDescription>
            The only way an administrator reads a conversation they are not in. The reason is kept in the audit log ("chat.export"), and a message in the conversation tells its members: "An administrator exported this conversation on {new Date().toISOString().slice(0, 10)}." The ZIP (transcript.html and the files) can be downloaded by you, within an hour.
          </DialogDescription>
        </DialogHeader>
        {done ? (
          <div className="grid gap-2 text-sm" data-testid="chat-admin-export-done">
            <p>The export is ready and the members were told.</p>
            <Button asChild size="sm" className="justify-self-start"><a href={done.url} data-testid="chat-admin-export-download"><Download /> Download the ZIP</a></Button>
            <p className="text-xs text-muted-foreground">The link works until {new Date(done.expiresOn).toLocaleTimeString()}; each download is audited.</p>
          </div>
        ) : (
          <div className="grid gap-3">
            <Field label="Reason (at least 10 characters)" htmlFor="chat-export-reason">
              <Textarea id="chat-export-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder="Why this conversation is exported, for whom" data-testid="chat-admin-export-reason" />
            </Field>
            {reauth && (
              <Field label="Confirm it is you: your password or a code from your authenticator app" htmlFor="chat-export-pw">
                <Input id="chat-export-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="chat-admin-export-password" />
              </Field>
            )}
          </div>
        )}
        {err && <p className="text-sm text-destructive" role="alert" data-testid="chat-admin-export-error">{err}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{done ? 'Close' : 'Cancel'}</Button>
          {!done && <Button disabled={reason.trim().length < 10 || busy || (reauth && !password)} onClick={() => void go()} data-testid="chat-admin-export-confirm">{busy && <Loader2 className="animate-spin" />}Export and tell the members</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeleteDialog({ c, onClose, onDone }: { c: ChatAdminChannel | null; onClose(): void; onDone(): void }) {
  const { toast, fail } = useToast()
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => setConfirm(''), [c])
  const want = c ? (c.kind === 'channel' ? c.name : 'delete') : ''
  return (
    <Dialog open={!!c} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="chat-admin-delete-dialog">
        <DialogHeader>
          <DialogTitle>Delete for good?</DialogTitle>
          <DialogDescription>Every message, reaction and file of this conversation is removed; this cannot be undone (backups taken before still hold it). Type {c?.kind === 'channel' ? <>the channel's name, <b>{want}</b>,</> : <b>delete</b>} to confirm.</DialogDescription>
        </DialogHeader>
        <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-label="Confirm" data-testid="chat-admin-delete-confirm" />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={confirm.trim() !== want || busy} onClick={async () => {
            if (!c) return
            setBusy(true)
            try {
              await chatAdminApi.deleteChannel(c.id, confirm.trim())
              toast('Deleted', 'success')
              onDone()
              onClose()
            } catch (e) {
              fail(e)
            } finally {
              setBusy(false)
            }
          }}>Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ exports */

function ExportsPanel() {
  const { fail } = useToast()
  const [items, setItems] = useState<ChatAdminExport[] | null>(null)
  const load = useCallback(() => chatAdminApi.exports().then((r) => setItems(r.items)).catch((e) => { setItems([]); fail(e) }), [fail])
  useEffect(() => { void load() }, [load])
  return (
    <Panel className="grid gap-3 p-4" data-testid="chat-admin-exports">
      <div className="flex items-center gap-2">
        <div className="flex-1 text-sm font-semibold">Exports</div>
        <Button size="icon-sm" variant="ghost" aria-label="Refresh" onClick={() => void load()}><RefreshCw /></Button>
      </div>
      {items === null ? <Spinner /> : items.length === 0 ? <p className="text-sm text-muted-foreground">No exports yet.</p> : (
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground"><tr><th className={th}>Conversation</th><th className={th}>By</th><th className={th}>When</th><th className={th}>Reason</th><th className={th}>Messages</th><th className={th}>Downloaded</th></tr></thead>
          <tbody>
            {items.map((x) => (
              <tr key={x.id} className="border-t border-border" data-testid="chat-admin-export-row">
                <td className="py-1.5 pr-2">{x.channel.kind === 'channel' ? `#${x.channel.name}` : kindText(x.channel.kind)}</td>
                <td className="py-1.5 pr-2">{x.by}</td>
                <td className="py-1.5 pr-2 text-xs text-muted-foreground">{fmtRelative(x.createdOn)}</td>
                <td className="py-1.5 pr-2 text-xs">{x.reason}</td>
                <td className="py-1.5 pr-2 tabular-nums">{x.messages} ({x.files} files)</td>
                <td className="py-1.5 pr-2 text-xs text-muted-foreground">{x.downloadedOn ? fmtRelative(x.downloadedOn) : 'not yet'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  )
}
