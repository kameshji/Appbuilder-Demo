/** One message: sender, time, body (the server's sanitised rich text), files, cards, reactions, thread summary, actions. */
import { memo, useState } from 'react'
import { Flag, MessageSquareReply, MoreHorizontal, Pencil, RotateCcw, SmilePlus, Trash2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { sanitizeRichText } from '@/platform/system-tables'
import { CHAT_EMOJI, type ChatConversation, type ChatFile, type ChatMessageView } from '@/platform/chat-protocol'
import { Avatar } from './bits'
import { bodyToText, fileSize, listTime, markMentions, timeLabel } from './format'
import { Composer } from './Composer'
import { ChatCard } from './cards/ChatCard'
import { deleteMessage, discardSend, editMessage, openThreadOf, react, retrySend, takeBack, useChat } from './store'
import type { PendingSend } from './optimistic'

const RICH = 'ab-richtext break-words text-sm [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12px] [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_pre]:font-mono [&_pre]:text-[12px] [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_blockquote]:text-muted-foreground [&_span[data-mention]]:rounded [&_span[data-mention]]:bg-primary/10 [&_span[data-mention]]:px-0.5 [&_span[data-mention]]:font-medium [&_span[data-mention]]:text-primary [&_span[data-me]]:bg-amber-400/25 [&_span[data-me]]:text-amber-800 dark:[&_span[data-me]]:text-amber-200'

export function Body({ html, me }: { html: string; me: string }) {
  // the server sanitised it; sanitising again here keeps the rule in one place for whatever reaches the screen
  return <div className={RICH} dangerouslySetInnerHTML={{ __html: markMentions(sanitizeRichText(html), me) }} />
}

function Files({ files }: { files: ChatFile[] }) {
  if (!files.length) return null
  return (
    <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Files">
      {files.map((f) => f.mime.startsWith('image/') && f.url ? (
        <li key={f.id}>
          <a href={f.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border border-border" data-testid="chat-file" data-name={f.name} title={`${f.name} (${fileSize(f.size)})`}>
            <img src={f.url} alt={f.name} loading="lazy" className="max-h-48 max-w-60 object-contain" />
          </a>
        </li>
      ) : (
        <li key={f.id}>
          <a href={f.url || undefined} target="_blank" rel="noreferrer" className="inline-flex max-w-64 items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-muted" data-testid="chat-file" data-name={f.name}>
            <span className="truncate font-medium">{f.name}</span>
            <span className="shrink-0 text-muted-foreground">{fileSize(f.size)}</span>
          </a>
        </li>
      ))}
    </ul>
  )
}

function Reactions({ m, me, canReact }: { m: ChatMessageView; me: string; canReact: boolean }) {
  if (!m.reactions.length) return null
  return (
    <div className="mt-1 flex flex-wrap gap-1" aria-label="Reactions">
      {m.reactions.map((r) => {
        const mine = r.users.includes(me)
        return (
          <button key={r.emoji} type="button" disabled={!canReact} aria-pressed={mine} onClick={() => void react(m, r.emoji)} data-testid="chat-reaction" data-emoji={r.emoji} data-count={r.users.length}
            aria-label={`${r.emoji} ${r.users.length}${mine ? ', including you' : ''}`}
            className={cn('inline-flex h-6 items-center gap-1 rounded-full border px-1.5 text-xs', mine ? 'border-primary/50 bg-primary/10' : 'border-border bg-background hover:bg-muted')}>
            <span>{r.emoji}</span><span className="tabular-nums">{r.users.length}</span>
          </button>
        )
      })}
    </div>
  )
}

export function EmojiPicker({ onPick, label = 'Add a reaction' }: { onPick(e: string): void; label?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} title={label} data-testid="chat-react"><SmilePlus /></Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-1.5" align="end">
        <div className="grid grid-cols-6 gap-0.5" role="group" aria-label="Reactions">
          {CHAT_EMOJI.map((e) => (
            <button key={e} type="button" className="grid size-8 place-items-center rounded text-lg hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" aria-label={`React with ${e}`} data-testid="chat-emoji" data-emoji={e}
              onClick={() => { onPick(e); setOpen(false) }}>{e}</button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export const MessageItem = memo(function MessageItem({ m, conversation, compact, inThread, highlight, editing, setEditing, onReport }: {
  m: ChatMessageView
  conversation: ChatConversation
  compact: boolean
  inThread?: boolean
  highlight?: boolean
  editing: boolean
  setEditing(id: string | null): void
  onReport(m: ChatMessageView): void
}) {
  const me = useChat((s) => s.me)
  const meId = me?.id ?? ''
  const mine = m.sender?.id === meId
  const canAct = conversation.canPost
  if (m.kind === 'system') {
    return (
      <div className="flex justify-center px-3 py-1" data-testid="chat-system" data-seq={m.seq} data-event={m.event?.type ?? ''}>
        <span className="rounded-full bg-muted px-2.5 py-0.5 text-center text-[11.5px] text-muted-foreground">{m.text || 'Something changed in this conversation.'} <span className="opacity-70">{listTime(m.createdOn)}</span></span>
      </div>
    )
  }
  // a card from Appbuilder itself (no sender): the system sender "Approvals"
  const fromSystem = !m.sender && m.cards.some((c) => c.kind === 'approval')
  const name = m.sender?.name ?? (fromSystem ? 'Approvals' : 'Someone')
  return (
    <div
      role="article"
      tabIndex={0}
      aria-label={`${name}, ${timeLabel(m.createdOn)}${m.deleted ? ', deleted' : ''}`}
      data-testid="chat-message"
      data-id={m.id}
      data-seq={m.seq}
      data-mine={mine ? '1' : '0'}
      className={cn('group relative flex gap-2.5 px-3 outline-none focus-visible:bg-accent/40 hover:bg-muted/40', compact ? 'py-0.5' : 'pt-2 pb-0.5', highlight && 'bg-amber-400/15 ring-1 ring-inset ring-amber-400/50')}
    >
      <div className="w-7 shrink-0">{!compact && <Avatar id={m.sender?.id ?? ''} name={name} size={28} />}</div>
      <div className="min-w-0 flex-1">
        {!compact && (
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13px] font-semibold">{name}</span>
            <time className="shrink-0 text-[11px] text-muted-foreground" dateTime={m.createdOn} title={new Date(m.createdOn).toLocaleString()}>{timeLabel(m.createdOn)}</time>
          </div>
        )}
        {m.deleted ? (
          <p className="text-sm italic text-muted-foreground" data-testid="chat-deleted">{m.moderated ? 'Message deleted by an administrator' : 'Message deleted'}</p>
        ) : editing ? (
          <div className="py-1">
            <Composer conversation={conversation} autoFocus edit={{ ...bodyToText(m.body), save: (t, mm) => editMessage(m, t, mm) }} onDone={() => setEditing(null)} />
          </div>
        ) : (
          <>
            {m.body && <Body html={m.body} me={meId} />}
            {m.editedOn && <span className="text-[11px] text-muted-foreground" data-testid="chat-edited">(edited)</span>}
            <Files files={m.files} />
            {m.cards.map((c, i) => <ChatCard key={i} messageId={m.id} index={i} card={c} version={c.kind === 'approval' ? m.changeSeq : 0} />)}
            <Reactions m={m} me={meId} canReact={canAct} />
          </>
        )}
        {!inThread && m.replyCount > 0 && (
          <button type="button" className="mt-1 inline-flex items-center gap-1.5 rounded px-1 text-xs font-medium text-primary hover:underline" onClick={() => void openThreadOf(m.id)} data-testid="chat-thread-summary" data-replies={m.replyCount}>
            <MessageSquareReply className="size-3.5" />
            {m.replyCount === 1 ? '1 reply' : `${m.replyCount} replies`}
            {m.lastReplyOn && <span className="font-normal text-muted-foreground">last {listTime(m.lastReplyOn)}</span>}
          </button>
        )}
      </div>
      {!m.deleted && !editing && !fromSystem && (
        <div className="absolute -top-3 right-2 hidden items-center rounded-md border border-border bg-card shadow-sm group-hover:flex group-focus-within:flex has-[[data-state=open]]:flex" data-testid="chat-actions">
          {canAct && <EmojiPicker onPick={(e) => void react(m, e)} />}
          {!inThread && canAct && (
            <Button variant="ghost" size="icon-sm" aria-label="Reply in a thread" title="Reply in a thread" onClick={() => void openThreadOf(m.id)} data-testid="chat-reply">
              <MessageSquareReply />
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="More actions" title="More actions" data-testid="chat-more"><MoreHorizontal /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {mine && canAct && <DropdownMenuItem onSelect={() => setEditing(m.id)} data-testid="chat-edit-action"><Pencil /> Edit</DropdownMenuItem>}
              {mine && <DropdownMenuItem onSelect={() => { if (window.confirm('Delete this message? A "message deleted" line stays in the conversation.')) void deleteMessage(m) }} className="text-destructive" data-testid="chat-delete-action"><Trash2 /> Delete</DropdownMenuItem>}
              {!mine && <DropdownMenuItem onSelect={() => onReport(m)} data-testid="chat-report-action"><Flag /> Report to the administrators</DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(m.text).catch(() => {})}>Copy text</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  )
})

/** a message on its way (optimistic) or one that failed */
export function PendingItem({ p, onFix }: { p: PendingSend; onFix(text: string): void }) {
  const me = useChat((s) => s.me)
  return (
    <div className="flex gap-2.5 px-3 py-1" data-testid="chat-pending" data-state={p.state}>
      <div className="w-7 shrink-0" />
      <div className={cn('min-w-0 flex-1', p.state === 'sending' && 'opacity-60')}>
        <Body html={p.body} me={me?.id ?? ''} />
        {p.files.length > 0 && <p className="text-xs text-muted-foreground">{p.files.map((f) => f.name).join(', ')}</p>}
        {p.state === 'sending' ? (
          <p className="text-[11px] text-muted-foreground">Sending...</p>
        ) : (
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-destructive" role="alert">
            <TriangleAlert className="size-3.5" />
            <span data-testid="chat-pending-error">Not sent: {p.error}</span>
            {p.retryable ? (
              <Button size="xs" variant="outline" onClick={() => retrySend(p.clientId)} data-testid="chat-retry"><RotateCcw /> Retry</Button>
            ) : (
              <Button size="xs" variant="outline" onClick={() => { const b = takeBack(p.clientId); if (b) onFix(b.text) }}>Edit and send again</Button>
            )}
            <Button size="xs" variant="ghost" onClick={() => discardSend(p.clientId)}>Delete</Button>
          </div>
        )}
      </div>
    </div>
  )
}
