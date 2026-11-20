/**
 * The conversation list and its unread arithmetic (pure). Counts come from the server (GET /chat/conversations, the
 * read answer, chat.unread events with counts); between those, the list only moves what it knows for sure and asks the
 * server again (`refetch`) when an event says a conversation changed without saying how.
 */
import type { ChatConversation, ChatUserEvent } from '@/platform/chat-protocol'

export interface ConvList {
  byId: Record<string, ChatConversation>
  /** latest activity first; archived ones last */
  order: string[]
}

export const emptyList = (): ConvList => ({ byId: {}, order: [] })

const time = (c: ChatConversation) => (c.lastMessageOn ? Date.parse(c.lastMessageOn) || 0 : 0)

/** list order: not archived first, then the latest message first, then by name */
export function compareConversations(a: ChatConversation, b: ChatConversation): number {
  if (a.archived !== b.archived) return a.archived ? 1 : -1
  const d = time(b) - time(a)
  if (d) return d
  return a.name.localeCompare(b.name)
}

function sorted(byId: Record<string, ChatConversation>): string[] {
  return Object.values(byId).sort(compareConversations).map((c) => c.id)
}

export function setConversations(items: ChatConversation[]): ConvList {
  const byId: Record<string, ChatConversation> = {}
  for (const c of items) if (c.me) byId[c.id] = c
  return { byId, order: sorted(byId) }
}

/** add or replace one conversation (only ones I am a member of are listed) */
export function upsertConversation(l: ConvList, c: ChatConversation): ConvList {
  if (!c.me) return removeConversation(l, c.id)
  const byId = { ...l.byId, [c.id]: c }
  return { byId, order: sorted(byId) }
}

export function removeConversation(l: ConvList, id: string): ConvList {
  if (!l.byId[id]) return l
  const byId = { ...l.byId }
  delete byId[id]
  return { byId, order: l.order.filter((x) => x !== id) }
}

/**
 * a chat.unread event. With counts (my own read marker moved, in this or another tab): set them. Without (a change in
 * the conversation): raise lastSeq and ask the server for the exact counts (refetch), unless nothing new happened.
 */
export function applyUnreadEvent(l: ConvList, ev: Extract<ChatUserEvent, { event: 'chat.unread' }>): { list: ConvList; refetch: boolean } {
  const c = l.byId[ev.channelId]
  if (!c) return { list: l, refetch: true }
  if (ev.lastReadSeq !== undefined && ev.unread !== undefined) {
    const me = c.me ? { ...c.me, lastReadSeq: Math.max(c.me.lastReadSeq, ev.lastReadSeq) } : c.me
    return { list: upsertConversation(l, { ...c, me, lastSeq: Math.max(c.lastSeq, ev.lastSeq), unread: ev.unread, mentions: ev.mentions ?? c.mentions }), refetch: false }
  }
  if (ev.lastSeq <= c.lastSeq) return { list: l, refetch: false }
  return { list: upsertConversation(l, { ...c, lastSeq: ev.lastSeq }), refetch: true }
}

/** I read up to seq here (optimistic, before the server answers): no unread left at or below it */
export function markReadLocal(l: ConvList, id: string, seq: number): ConvList {
  const c = l.byId[id]
  if (!c?.me || c.me.lastReadSeq >= seq) return l
  const all = seq >= c.lastSeq
  return upsertConversation(l, { ...c, me: { ...c.me, lastReadSeq: seq }, unread: all ? 0 : c.unread, mentions: all ? 0 : c.mentions })
}

/** the read answer of the server */
export function applyReadAnswer(l: ConvList, id: string, a: { lastReadSeq: number; unread: number; mentions: number }): ConvList {
  const c = l.byId[id]
  if (!c?.me) return l
  return upsertConversation(l, { ...c, me: { ...c.me, lastReadSeq: Math.max(c.me.lastReadSeq, a.lastReadSeq) }, unread: a.unread, mentions: a.mentions })
}

/** a message seen live in a conversation (moves it to the top before the server's counts arrive) */
export function touchConversation(l: ConvList, id: string, at: string, seq: number): ConvList {
  const c = l.byId[id]
  if (!c) return l
  const later = !c.lastMessageOn || Date.parse(at) > Date.parse(c.lastMessageOn)
  if (!later && seq <= c.lastSeq) return l
  return upsertConversation(l, { ...c, lastMessageOn: later ? at : c.lastMessageOn, lastSeq: Math.max(c.lastSeq, seq) })
}

/**
 * what a conversation contributes to the badge: muted ones nothing (they show their own dot), direct and group
 * conversations every unread message, channels their unread mentions (ordinary channel messages are not a badge, as
 * they are not a notification: default 15 of the spec)
 */
export function badgeOf(c: ChatConversation): number {
  if (!c.me || c.me.muted) return 0
  if (c.kind === 'channel') return c.mentions
  return c.unread
}

export function totalBadge(l: ConvList): number {
  let n = 0
  for (const id of l.order) n += badgeOf(l.byId[id])
  return n
}

/** any unread message at all (not muted): the dot on the chat button when the badge is 0 */
export function anyUnread(l: ConvList): boolean {
  return l.order.some((id) => {
    const c = l.byId[id]
    return !!c.me && !c.me.muted && c.unread > 0
  })
}

/** the list filtered by a search box: name, description and the people of direct and group conversations */
export function filterConversations(list: ChatConversation[], q: string): ChatConversation[] {
  const words = q.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return list
  return list.filter((c) => {
    const hay = [c.name, c.description, ...(c.members ?? []).map((p) => p.name)].join(' ').toLocaleLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** "3", "99+" */
export const countLabel = (n: number): string => (n > 99 ? '99+' : String(n))
