/** The conversation list: my conversations with unread counts, a search box (names here, messages on the server), New. */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Compass, Loader2, MessageSquarePlus, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { richTextToPlain } from '@/platform/system-tables'
import { chatApi, errText, type SearchHit } from './api'
import { Avatar, KindIcon, UnreadBadge, displayName, kindLabel } from './bits'
import { listTime } from './format'
import { openConversation, useChat } from './store'
import { filterConversations } from './unread'
import { BrowseChannelsDialog, NewConversationDialog } from './dialogs'

export function ConversationList({ className }: { className?: string }) {
  const list = useChat((s) => s.list)
  const openId = useChat((s) => s.openId)
  const me = useChat((s) => s.me)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<{ q: string; items: SearchHit[]; more: boolean; page: number } | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [newOpen, setNewOpen] = useState(false)
  const [browseOpen, setBrowseOpen] = useState(false)
  const items = useMemo(() => filterConversations(list.order.map((id) => list.byId[id]), q), [list, q])
  const listRef = useRef<HTMLUListElement>(null)

  // messages: searched on the server (only conversations I may read), 300 ms after typing stops
  useEffect(() => {
    const words = q.trim()
    if (words.length < 2) {
      setHits(null)
      setSearchError('')
      return
    }
    let live = true
    const t = setTimeout(() => {
      setSearching(true)
      chatApi.search({ q: words }).then((r) => { if (live) { setHits({ q: words, items: r.items, more: r.more, page: 0 }); setSearchError('') } })
        .catch((e) => { if (live) setSearchError(errText(e)) })
        .finally(() => { if (live) setSearching(false) })
    }, 300)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [q])

  const more = async () => {
    if (!hits) return
    setSearching(true)
    try {
      const r = await chatApi.search({ q: hits.q, page: hits.page + 1 })
      setHits({ ...hits, items: [...hits.items, ...r.items], more: r.more, page: hits.page + 1 })
    } catch (e) {
      setSearchError(errText(e))
    } finally {
      setSearching(false)
    }
  }

  // arrow keys move between conversations (roving focus)
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-conv]') ?? [])]
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (next) {
      e.preventDefault()
      next.focus()
    }
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)} data-testid="chat-list">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border p-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQ('') }}
            placeholder="Search conversations and messages"
            aria-label="Search conversations and messages"
            data-testid="chat-search"
            className="h-8 w-full rounded-md border border-transparent bg-muted pl-7 pr-7 text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:bg-background focus:ring-2 focus:ring-ring/20 [&::-webkit-search-cancel-button]:hidden"
          />
          {q && (
            <button type="button" aria-label="Clear search" className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={() => setQ('')}>
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <Button variant="ghost" size="icon-sm" title="Browse open channels" aria-label="Browse open channels" data-testid="chat-browse" onClick={() => setBrowseOpen(true)}>
          <Compass />
        </Button>
        <Button variant="ghost" size="icon-sm" title="New conversation" aria-label="New conversation" data-testid="chat-new" onClick={() => setNewOpen(true)} disabled={!!me?.readOnly}>
          <MessageSquarePlus />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {items.length === 0 && !q && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground" data-testid="chat-empty">
            <p className="font-medium text-foreground">No conversations yet</p>
            <p className="mt-1 text-xs">Start one with the button above, or browse the open channels.</p>
          </div>
        )}
        {items.length === 0 && q && <p className="px-3 pt-3 text-xs text-muted-foreground">No conversation is called that.</p>}
        <ul ref={listRef} className="p-1" onKeyDown={onKey} aria-label="Conversations">
          {items.map((c) => {
            const bold = !!c.me && !c.me.muted && c.unread > 0
            return (
              <li key={c.id}>
                <button
                  type="button"
                  data-conv={c.id}
                  data-testid="chat-conv"
                  data-name={c.name}
                  data-unread={c.unread}
                  data-mentions={c.mentions}
                  aria-current={openId === c.id ? 'true' : undefined}
                  aria-label={`${displayName(c)}, ${kindLabel(c)}${c.unread ? `, ${c.unread} unread` : ''}${c.mentions ? `, ${c.mentions} mentions` : ''}${c.me?.muted ? ', muted' : ''}${c.archived ? ', archived' : ''}`}
                  onClick={() => void openConversation(c.id)}
                  className={cn(
                    'flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
                    openId === c.id ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                    c.archived && 'opacity-60',
                  )}
                >
                  {c.kind === 'direct' && c.members?.length ? (
                    <Avatar id={c.members.find((p) => p.id !== me?.id)?.id ?? c.id} name={c.name} size={26} />
                  ) : (
                    <span className="grid size-[26px] shrink-0 place-items-center rounded-md bg-muted"><KindIcon c={c} /></span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate', bold ? 'font-semibold' : 'font-medium')}>{displayName(c)}</span>
                    {c.archived && <span className="block truncate text-[11px] text-muted-foreground">Archived</span>}
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-0.5">
                    <span className="text-[11px] text-muted-foreground">{listTime(c.lastMessageOn)}</span>
                    <UnreadBadge c={c} />
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        {q.trim().length >= 2 && (
          <section className="border-t border-border p-2" aria-label="Messages found" data-testid="chat-search-results">
            <h3 className="flex items-center gap-2 px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Messages {searching && <Loader2 className="size-3 animate-spin" />}
            </h3>
            {searchError && <p className="px-1 text-xs text-destructive">{searchError}</p>}
            {hits && hits.items.length === 0 && !searching && <p className="px-1 text-xs text-muted-foreground">No messages found in the conversations you can read.</p>}
            <ul>
              {hits?.items.map((h) => (
                <li key={h.message.id}>
                  <button
                    type="button"
                    data-testid="chat-search-hit"
                    className="w-full rounded-md px-2 py-1.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    onClick={() => void openConversation(h.conversation.id, h.message.seq)}
                  >
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <KindIcon c={{ kind: h.conversation.kind, isPrivate: true }} className="size-3" />
                      <span className="truncate">{h.conversation.kind === 'channel' ? `#${h.conversation.name}` : h.conversation.name}</span>
                      <span className="ml-auto shrink-0">{listTime(h.message.createdOn)}</span>
                    </span>
                    <span className="mt-0.5 block text-sm"><span className="font-medium">{h.message.sender?.name ?? 'Someone'}:</span> <span className="line-clamp-2 text-muted-foreground">{h.message.text || richTextToPlain(h.message.body) || h.message.files.map((f) => f.name).join(', ')}</span></span>
                  </button>
                </li>
              ))}
            </ul>
            {hits?.more && <Button variant="ghost" size="xs" className="mt-1" onClick={() => void more()} disabled={searching}>Show more</Button>}
          </section>
        )}
      </div>
      <NewConversationDialog open={newOpen} onOpenChange={setNewOpen} />
      <BrowseChannelsDialog open={browseOpen} onOpenChange={setBrowseOpen} />
    </div>
  )
}
