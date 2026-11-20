/**
 * "Share to chat" (P3 package E, spec 5.4): a record, an app or a dashboard goes into a conversation as a card
 * REFERENCE. The picker lists only the conversations the sharer may post to (the server's canPost); for a record the
 * sharer picks up to 6 fields. Nothing of the record travels in the message: every reader gets the card resolved by
 * the server with their own access (the fields they may read; "not available" for a row, app or dashboard they may not
 * see). Entry points: the record timeline's header, the app launcher, the dashboard viewer (one-line uses of
 * ShareToChatButton). Server mode only (chat needs the server).
 */
import { useEffect, useMemo, useState } from 'react'
import { Check, Loader2, Send, Share2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { platform, usePlatform } from '@/platform'
import { CHAT_LIMITS, type ChatCardRef, type ChatConversation } from '@/platform/chat-protocol'
import { chatApi, errText } from './api'
import { KindIcon, displayName, kindLabel } from './bits'
import { openChat } from './open'

/** what is shared, before the sharer picks fields (record cards) */
export type ShareTarget =
  | { kind: 'record'; table: string; row: string }
  | { kind: 'app'; app: string; screen?: string }
  | { kind: 'dashboard'; dashboard: string }

/** the columns a record card may offer: the table's own columns the page knows (system columns and files left out) */
export function shareableColumns(cols: { name: string; displayName?: string; type: string; system?: boolean }[], primary?: string): { name: string; label: string }[] {
  return cols
    .filter((c) => !c.system && c.name !== 'id' && c.name !== primary && !['file', 'files', 'image', 'attachment', 'richtext'].includes(String(c.type)))
    .map((c) => ({ name: c.name, label: c.displayName || c.name }))
}

/** the card reference that goes into the message (never values) */
export function cardFor(target: ShareTarget, env: string, fields: string[]): ChatCardRef {
  if (target.kind === 'record') return { kind: 'record', env, table: target.table, row: target.row, fields: fields.slice(0, CHAT_LIMITS.maxCardFields) }
  if (target.kind === 'app') return { kind: 'app', env, app: target.app, ...(target.screen ? { screen: target.screen } : {}) }
  return { kind: 'dashboard', env, dashboard: target.dashboard }
}

/** the conversations a person may post a card to (the server says canPost; Appbuilder's own conversations never) */
export function postable(list: ChatConversation[]): ChatConversation[] {
  return list.filter((c) => c.canPost && !c.archived && !c.system)
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function ShareToChatDialog({ open, onOpenChange, target, title }: { open: boolean; onOpenChange(v: boolean): void; target: ShareTarget; title?: string }) {
  const env = usePlatform((s) => s.environmentId)
  const tables = usePlatform((s) => s.tables)
  const def = target.kind === 'record' ? tables.find((t) => t.id === target.table || t.name === target.table) : undefined
  const columns = useMemo(() => (def ? shareableColumns(def.columns, def.primaryColumn) : []), [def])
  const [convs, setConvs] = useState<ChatConversation[] | null>(null)
  const [q, setQ] = useState('')
  const [pick, setPick] = useState<string | null>(null)
  const [fields, setFields] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<{ id: string; seq: number; name: string } | null>(null)

  useEffect(() => {
    if (!open) return
    setConvs(null)
    setPick(null)
    setNote('')
    setError('')
    setDone(null)
    setFields(columns.slice(0, 4).map((c) => c.name))
    let live = true
    chatApi.conversations().then((r) => live && setConvs(postable(r.items))).catch((e) => { if (live) { setConvs([]); setError(errText(e)) } })
    return () => { live = false }
  }, [open, columns])

  const shown = (convs ?? []).filter((c) => !q.trim() || displayName(c).toLowerCase().includes(q.trim().toLowerCase()))
  const toggle = (f: string) => setFields((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : cur.length >= CHAT_LIMITS.maxCardFields ? cur : [...cur, f]))
  const send = async () => {
    if (!pick) return
    setBusy(true)
    setError('')
    try {
      const tableId = def?.id ?? (target.kind === 'record' ? target.table : '')
      const t = target.kind === 'record' ? { ...target, table: tableId } : target
      const body = note.trim() ? note.trim().split(/\r?\n/).map((l) => `<p>${esc(l)}</p>`).join('') : ''
      const r = await chatApi.send(pick, { body, cards: [cardFor(t, env, fields)], clientId: `share-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` })
      const c = (convs ?? []).find((x) => x.id === pick)
      setDone({ id: pick, seq: r.message.seq, name: c ? displayName(c) : 'the conversation' })
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const what = target.kind === 'record' ? 'record' : target.kind === 'app' ? 'app' : 'dashboard'
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="chat-share-dialog">
        <DialogHeader>
          <DialogTitle>Share to chat</DialogTitle>
          <DialogDescription>
            {title ? <><span className="font-medium text-foreground">{title}</span> goes </> : `The ${what} goes `}
            into the conversation as a card. Each reader sees only what their own access allows; someone who may not see it gets "Not available".
          </DialogDescription>
        </DialogHeader>
        {done ? (
          <div className="space-y-3 py-2 text-sm" data-testid="chat-share-done">
            <p className="flex items-center gap-2"><Check className="size-4 text-emerald-600" /> Shared in {done.name}.</p>
            <Button size="sm" variant="outline" onClick={() => { onOpenChange(false); openChat({ c: done.id, m: done.seq }) }} data-testid="chat-share-open">Open the conversation</Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a conversation" aria-label="Find a conversation" data-testid="chat-share-search" />
              <div className="max-h-52 overflow-y-auto rounded-md border border-border p-1" role="listbox" aria-label="Conversations you can post to">
                {convs === null ? <div className="flex justify-center p-3"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
                  : shown.length === 0 ? <p className="p-2 text-xs text-muted-foreground">No conversation you can post to{q ? ' is called that' : ''}.</p>
                    : shown.map((c) => (
                      <button key={c.id} type="button" role="option" aria-selected={pick === c.id} data-testid="chat-share-conv" data-conv={c.id} data-name={c.name}
                        className={cn('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm', pick === c.id ? 'bg-accent text-accent-foreground' : 'hover:bg-muted')}
                        onClick={() => setPick(c.id)}>
                        <KindIcon c={c} className="size-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{displayName(c)}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{kindLabel(c)}</span>
                      </button>
                    ))}
              </div>
            </div>
            {target.kind === 'record' && columns.length > 0 && (
              <fieldset className="space-y-1">
                <legend className="text-xs font-medium">Fields on the card <span className="font-normal text-muted-foreground">(up to {CHAT_LIMITS.maxCardFields}; readers who may not see a field do not get it)</span></legend>
                <div className="grid max-h-36 grid-cols-2 gap-1 overflow-y-auto">
                  {columns.map((c) => (
                    <label key={c.name} className="flex items-center gap-1.5 text-xs" data-testid="chat-share-field" data-field={c.name}>
                      <Checkbox checked={fields.includes(c.name)} onCheckedChange={() => toggle(c.name)} disabled={!fields.includes(c.name) && fields.length >= CHAT_LIMITS.maxCardFields} />
                      <span className="truncate">{c.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Add a message (optional)" aria-label="Message" data-testid="chat-share-note" />
            {error && <p className="text-xs text-destructive" role="alert" data-testid="chat-share-error">{error}</p>}
          </div>
        )}
        {!done && (
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button disabled={!pick || busy} onClick={() => void send()} data-testid="chat-share-send">{busy ? <Loader2 className="animate-spin" /> : <Send />}Share</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** the entry point: a button that opens the share dialog (hidden in demo mode, where chat is not available) */
export function ShareToChatButton({ target, title, size = 'sm', variant = 'ghost', className, label = 'Share to chat' }: {
  target: ShareTarget
  title?: string
  size?: 'sm' | 'xs' | 'icon-sm'
  variant?: 'ghost' | 'outline' | 'secondary'
  className?: string
  label?: string
}) {
  const mode = usePlatform((s) => s.mode)
  const [open, setOpen] = useState(false)
  if (mode !== 'server' || !platform.getState().session) return null
  return (
    <>
      <Button size={size} variant={variant} className={className} onClick={(e) => { e.stopPropagation(); setOpen(true) }} title={label} aria-label={label} data-testid="chat-share-button">
        <Share2 className="size-3.5" />{size === 'icon-sm' ? null : label}
      </Button>
      <ShareToChatDialog open={open} onOpenChange={setOpen} target={target} title={title} />
    </>
  )
}
