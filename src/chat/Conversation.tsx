/** One open conversation: header, messages paged from the server, the thread pane, the composer, the info pane. */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, Info, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ChatConversation, ChatMessageView } from '@/platform/chat-protocol'
import { KindIcon, displayName, kindLabel } from './bits'
import { Composer, onComposerDraft, setComposerDraft } from './Composer'
import { continues, dayLabel, sameDay } from './format'
import { MessageItem, PendingItem } from './MessageItem'
import { ConversationInfo } from './ConversationInfo'
import { ReportDialog } from './dialogs'
import { pendingFor } from './optimistic'
import { firstUnread } from './timeline'
import { closeThreadPane, convOf, joinConversation, jumpToLatest, loadNewer, loadOlder, loadReplies, setAtBottom, useChat } from './store'

export function TypingLine({ channelId }: { channelId: string }) {
  const typing = useChat((s) => s.typing[channelId])
  const names = (typing ?? []).filter((t) => t.until > Date.now()).map((t) => t.name)
  return (
    <div className="h-4 shrink-0 truncate px-4 text-[11px] text-muted-foreground" aria-live="polite" data-testid="chat-typing">
      {names.length === 1 ? `${names[0]} is typing...` : names.length === 2 ? `${names[0]} and ${names[1]} are typing...` : names.length > 2 ? 'Several people are typing...' : ''}
    </div>
  )
}

function CannotPost({ c }: { c: ChatConversation }) {
  const me = useChat((s) => s.me)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  let text = 'You cannot post here.'
  if (c.system === 'approvals') text = 'Appbuilder sends the approval requests waiting for you here. Answer each with the buttons on its card.'
  else if (me?.readOnlyReason === 'install') text = 'This install is read-only: chat can be read but not written.'
  else if (me?.readOnly) text = 'An administrator made you read-only in chat: you can read, not post or react.'
  else if (c.archived) text = 'This conversation is archived: it can be read, not written.'
  else if (!c.me) text = 'You are not in this channel yet.'
  else if (c.postingPolicy === 'owners' && c.me.role !== 'owner') text = 'Only the owners of this channel post in it.'
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground" data-testid="chat-cannot-post">
      <span className="min-w-0 flex-1">{text}</span>
      {!c.me && c.kind === 'channel' && !c.isPrivate && !c.archived && !me?.readOnly && (
        <Button size="xs" disabled={busy} data-testid="chat-join" onClick={async () => {
          setBusy(true)
          try { await joinConversation(c.id) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
        }}>Join</Button>
      )}
      {err && <span className="text-destructive">{err}</span>}
    </div>
  )
}

/** the scrolling list of one place (the conversation's top-level messages, or a thread's replies) */
function MessageList({ c, items, hasOlder, onOlder, loadingOlder, inThread, lastReadSeq, threadRoot, hasNewer = false, loadingNewer = false }: {
  c: ChatConversation
  items: ChatMessageView[]
  hasOlder: boolean
  /** the window was loaded around an old message: newer ones exist (package E) */
  hasNewer?: boolean
  loadingNewer?: boolean
  onOlder?(): Promise<boolean>
  loadingOlder: boolean
  inThread?: boolean
  lastReadSeq: number
  threadRoot?: ChatMessageView | null
}) {
  const me = useChat((s) => s.me)
  const focus = useChat((s) => s.focus)
  const pending = useChat((s) => s.pending)
  const [editing, setEditing] = useState<string | null>(null)
  const [report, setReport] = useState<ChatMessageView | null>(null)
  const [newBelow, setNewBelow] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const prevHeight = useRef<number | null>(null)
  const lastCount = useRef(items.length)
  const [highlight, setHighlight] = useState<number | null>(null)
  const parentId = inThread ? threadRoot?.id ?? null : null
  const mine = pendingFor(pending, c.id, parentId)
  // the "New" line: fixed when the conversation opens, so it does not jump while I read
  const [newFrom] = useState(() => firstUnread(items, lastReadSeq, me?.id ?? '')?.seq ?? null)

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    atBottomRef.current = bottom
    if (!inThread) setAtBottom(bottom)
    if (bottom) setNewBelow(false)
    if (el.scrollTop < 120 && hasOlder && !loadingOlder && onOlder) {
      prevHeight.current = el.scrollHeight
      void onOlder()
    }
  }

  // keep the place when older messages come in above; follow new ones when at the bottom
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (prevHeight.current !== null && items.length > lastCount.current && el.scrollHeight > prevHeight.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current
      prevHeight.current = null
    } else if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight
    } else if (items.length > lastCount.current) {
      setNewBelow(true)
    }
    lastCount.current = items.length
  }, [items, mine.length])

  // first paint: at the bottom (or at the focused message)
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [c.id, parentId])

  // a deep link or a search hit: scroll to that message and mark it for a moment
  useEffect(() => {
    if (!focus || focus.channelId !== c.id) return
    const el = scroller.current?.querySelector<HTMLElement>(`[data-seq="${focus.seq}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    el.focus({ preventScroll: true })
    setHighlight(focus.seq)
    const t = setTimeout(() => setHighlight(null), 4000)
    return () => clearTimeout(t)
  }, [focus, c.id, items])

  const editLast = useCallback(() => {
    const last = [...items].reverse().find((m) => m.sender?.id === me?.id && !m.deleted && m.kind === 'message')
    if (last) setEditing(last.id)
  }, [items, me?.id])

  const rows = useMemo(() => items.map((m, i) => ({ m, prev: items[i - 1] })), [items])
  const toBottom = () => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
    setNewBelow(false)
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2" role="log" aria-label={inThread ? 'Thread' : `Messages in ${displayName(c)}`} data-testid={inThread ? 'chat-thread-messages' : 'chat-messages'}>
        {threadRoot && (
          <div className="border-b border-border pb-2">
            <MessageItem m={threadRoot} conversation={c} compact={false} inThread editing={editing === threadRoot.id} setEditing={setEditing} onReport={setReport} />
          </div>
        )}
        {!inThread && (
          <div className="flex justify-center py-2">
            {loadingOlder ? <Loader2 className="size-4 animate-spin text-muted-foreground" />
              : hasOlder ? <Button variant="ghost" size="xs" onClick={() => { prevHeight.current = scroller.current?.scrollHeight ?? null; void onOlder?.() }} data-testid="chat-older">Load earlier messages</Button>
                : <span className="text-[11px] text-muted-foreground" data-testid="chat-start">This is the start of {displayName(c)}.</span>}
          </div>
        )}
        {rows.map(({ m, prev }) => (
          <Fragment key={m.id}>
            {(!prev || !sameDay(prev.createdOn, m.createdOn)) && (
              <div className="sticky top-0 z-[1] flex justify-center py-1" aria-hidden="true">
                <span className="rounded-full border border-border bg-card px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">{dayLabel(m.createdOn)}</span>
              </div>
            )}
            {!inThread && newFrom !== null && m.seq === newFrom && (
              <div className="flex items-center gap-2 px-3 py-1 text-[11px] font-semibold text-destructive" data-testid="chat-new-line"><span className="h-px flex-1 bg-destructive/40" /> New</div>
            )}
            <MessageItem m={m} conversation={c} compact={continues(prev, m) && m.seq !== newFrom} inThread={inThread} highlight={highlight === m.seq} editing={editing === m.id} setEditing={setEditing} onReport={setReport} />
          </Fragment>
        ))}
        {mine.map((p) => <PendingItem key={p.clientId} p={p} onFix={(text) => setComposerDraft(c.id, parentId, text)} />)}
        {!inThread && hasNewer && (
          <div className="flex justify-center gap-2 py-2" data-testid="chat-newer-bar">
            {loadingNewer ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : (
              <>
                <Button variant="ghost" size="xs" onClick={() => void loadNewer(c.id)} data-testid="chat-newer">Show newer messages</Button>
                <Button variant="outline" size="xs" onClick={() => void jumpToLatest(c.id)} data-testid="chat-latest"><ArrowDown /> Jump to the latest</Button>
              </>
            )}
          </div>
        )}
      </div>
      {newBelow && (
        <Button size="xs" className="absolute bottom-2 left-1/2 -translate-x-1/2 shadow-md" onClick={toBottom} data-testid="chat-jump"><ArrowDown /> New messages</Button>
      )}
      <ReportDialog message={report} onClose={() => setReport(null)} />
      {!inThread && <EditLastBridge onEditLast={editLast} />}
    </div>
  )
}

/** lets the composer (a sibling) ask for "edit my last message" */
let editLastFn: (() => void) | null = null
function EditLastBridge({ onEditLast }: { onEditLast(): void }) {
  useEffect(() => {
    editLastFn = onEditLast
    return () => { if (editLastFn === onEditLast) editLastFn = null }
  }, [onEditLast])
  return null
}

export function Conversation({ id, onBack, narrow }: { id: string; onBack?(): void; narrow: boolean }) {
  const c = useChat((s) => convOf(s, id))
  const t = useChat((s) => s.timelines[id])
  const threadId = useChat((s) => s.threadId)
  const busy = useChat((s) => s.busy)
  const [info, setInfo] = useState(false)
  const [composerKey, setComposerKey] = useState(0)
  useEffect(() => setInfo(false), [id])
  useEffect(() => onComposerDraft(() => setComposerKey((k) => k + 1)), [])

  if (!c) return <div className="grid flex-1 place-items-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
  const thread = threadId ? t?.threads[threadId] : undefined

  const header = (
    <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-2" data-testid="chat-conv-header">
      {(narrow || thread) && (
        <Button variant="ghost" size="icon-sm" aria-label={thread ? 'Back to the conversation' : 'Back to the conversations'} title="Back" onClick={() => (thread ? closeThreadPane() : onBack?.())} data-testid="chat-back">
          <ArrowLeft />
        </Button>
      )}
      <KindIcon c={c} />
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-semibold" data-testid="chat-conv-title">{thread ? 'Thread' : displayName(c)}</h2>
        <p className="truncate text-[11px] text-muted-foreground">{thread ? `in ${displayName(c)}` : `${kindLabel(c)} · ${c.memberCount} ${c.memberCount === 1 ? 'member' : 'members'}${c.archived ? ' · archived' : ''}${c.me?.muted ? ' · muted' : ''}`}</p>
      </div>
      {!thread && (
        <Button variant={info ? 'secondary' : 'ghost'} size="icon-sm" aria-label="Conversation details" title="Details, members and notifications" aria-pressed={info} onClick={() => setInfo((v) => !v)} data-testid="chat-info">
          {info ? <X /> : <Info />}
        </Button>
      )}
    </header>
  )

  if (info && !thread) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-conversation" data-id={id}>
        {header}
        <ConversationInfo c={c} onClose={() => setInfo(false)} />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-conversation" data-id={id} data-thread={thread ? thread.rootId : ''}>
      {header}
      {!t?.loaded ? (
        <div className="grid flex-1 place-items-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : thread ? (
        <>
          <MessageList key={`t:${thread.rootId}`} c={c} items={thread.replies} hasOlder={false} loadingOlder={!!busy[`thread:${thread.rootId}`]} inThread lastReadSeq={Infinity} threadRoot={thread.root} />
          {thread.more && <Button variant="ghost" size="xs" className="mx-auto" onClick={() => void loadReplies(id, thread.rootId)}>Show more replies</Button>}
          <TypingLine channelId={id} />
          {c.canPost ? <Composer key={`tc:${thread.rootId}:${composerKey}`} conversation={c} parentId={thread.rootId} autoFocus /> : <CannotPost c={c} />}
        </>
      ) : (
        <>
          <MessageList key={`m:${id}`} c={c} items={t.items} hasOlder={t.hasOlder} onOlder={() => loadOlder(id)} loadingOlder={!!busy[`${id}:older`]} lastReadSeq={c.me?.lastReadSeq ?? 0} hasNewer={t.hasNewer} loadingNewer={!!busy[`${id}:newer`]} />
          <TypingLine channelId={id} />
          {c.canPost ? <Composer key={`c:${id}:${composerKey}`} conversation={c} onEditLast={() => editLastFn?.()} autoFocus={!narrow} /> : <CannotPost c={c} />}
        </>
      )}
    </div>
  )
}

