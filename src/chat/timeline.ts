/**
 * One conversation's messages in the browser (pure; no React, no DOM): history pages from the server merged with live
 * changes by sequence number, with gap detection (docs/dev/chat.md "Ordering and gaps").
 *
 * Rules:
 *  - `applied` is the conversation's change counter as far as this timeline has seen it. A push whose seq is not above
 *    it is old (ignored); a push whose `prev` is not `applied` is a gap: it is NOT applied, the caller fetches
 *    /changes?after=<applied> (which carries it too) and applies that.
 *  - a message is replaced only by a version with the same or a newer `changeSeq`, so a late answer never overwrites a
 *    newer push, and applying the same change twice changes nothing (exactly once on screen).
 *  - top-level messages are ordered by `seq`; thread replies live with their thread (only threads that are open).
 *  - only the pages the person scrolled through are held (older pages on demand): never the whole conversation.
 *  - a deep link to an old message loads one page AROUND it (package E): the window then is not the newest part of the
 *    conversation (`hasNewer`); messages newer than the window are not inserted (they would leave a hole) until the
 *    person pages forward or jumps to the latest page.
 */
import { CHAT_CHANGES_PAGE, type ChatChanges, type ChatMessageView, type ChatPushMessage } from '@/platform/chat-protocol'

export interface ThreadState {
  rootId: string
  root: ChatMessageView | null
  replies: ChatMessageView[]
  more: boolean
  loaded: boolean
}

export interface Timeline {
  channelId: string
  /** a history page arrived at least once */
  loaded: boolean
  /** top-level messages, seq ascending */
  items: ChatMessageView[]
  /** older messages exist on the server (page back with before=<items[0].seq>) */
  hasOlder: boolean
  /** the window was loaded around an old message: newer messages exist (page forward with after=<last seq>) */
  hasNewer: boolean
  /** the change counter applied so far */
  applied: number
  /** history up to this seq was removed by retention */
  purgedSeq: number
  /** open threads by root id */
  threads: Record<string, ThreadState>
}

export function emptyTimeline(channelId: string): Timeline {
  return { channelId, loaded: false, items: [], hasOlder: false, hasNewer: false, applied: 0, purgedSeq: 0, threads: {} }
}

/** the newer of two versions of one message (same or newer changeSeq wins; ties keep the incoming one) */
export function newer(a: ChatMessageView | undefined, b: ChatMessageView): ChatMessageView {
  if (!a) return b
  return b.changeSeq >= a.changeSeq ? b : a
}

/** insert or replace a message in a seq-ordered list (by id); returns the same array when nothing changed */
export function upsertSorted(list: ChatMessageView[], m: ChatMessageView): ChatMessageView[] {
  const i = list.findIndex((x) => x.id === m.id)
  if (i >= 0) {
    const next = newer(list[i], m)
    if (next === list[i]) return list
    const out = list.slice()
    out[i] = next
    return out
  }
  // binary search for the position by seq
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].seq < m.seq) lo = mid + 1
    else hi = mid
  }
  const out = list.slice()
  out.splice(lo, 0, m)
  return out
}

/**
 * a history page: 'latest' (the newest page, also a reload), 'older' (paging back), 'around' (a deep link to an old
 * message: replaces the window; `newer` says newer messages exist) or 'newer' (paging forward from such a window)
 */
export function applyHistory(t: Timeline, page: { messages: ChatMessageView[]; more: boolean; newer?: boolean; lastSeq: number; purgedSeq: number }, dir: 'latest' | 'older' | 'around' | 'newer'): Timeline {
  if (dir === 'around') {
    let items: ChatMessageView[] = []
    for (const m of page.messages) if (!m.parentId) items = upsertSorted(items, m)
    return {
      ...t, loaded: true, items, hasOlder: page.more, hasNewer: !!page.newer, applied: Math.max(t.applied, page.lastSeq),
      purgedSeq: Math.max(t.purgedSeq, page.purgedSeq),
    }
  }
  if (dir === 'newer') {
    let items = t.items
    for (const m of page.messages) if (!m.parentId) items = upsertSorted(items, m)
    return { ...t, items, hasNewer: page.more, purgedSeq: Math.max(t.purgedSeq, page.purgedSeq) }
  }
  // the latest page joins a window loaded around an old message only when they touch; otherwise it replaces it
  const detached = dir === 'latest' && t.hasNewer && !(t.items.length && page.messages.length && page.messages[0].seq <= t.items[t.items.length - 1].seq + 1)
  let items = (dir === 'latest' && !t.loaded) || detached ? [] : t.items
  for (const m of page.messages) if (!m.parentId) items = upsertSorted(items, m)
  // a reload of the latest page while older pages were held keeps them (they are still right: changes are merged)
  const hasOlder = dir === 'older' ? page.more : t.loaded && t.items.length && page.messages.length && t.items[0].seq < page.messages[0].seq ? t.hasOlder : page.more
  return {
    ...t,
    loaded: true,
    items,
    hasOlder: detached ? page.more : hasOlder,
    hasNewer: dir === 'latest' ? false : t.hasNewer,
    applied: dir === 'latest' ? Math.max(t.applied, page.lastSeq) : t.applied,
    purgedSeq: Math.max(t.purgedSeq, page.purgedSeq),
  }
}

/** the window of loaded top-level messages: a message older than it is not inserted (it would leave a hole) */
function insideWindow(t: Timeline, m: ChatMessageView): boolean {
  if (!t.items.length) return true
  if (t.hasOlder && m.seq < t.items[0].seq) return false
  if (t.hasNewer && m.seq > t.items[t.items.length - 1].seq) return false
  return true
}

/**
 * one message (from a push, a /changes answer or an HTTP answer). `isNewReply`: a push of a NEW reply (op message): the
 * thread root's reply count goes up by one (the server changes the root in the same transaction but pushes the reply
 * only); /changes answers carry the root itself, so they never pass it.
 */
export function upsertMessage(t: Timeline, m: ChatMessageView, o: { isNewReply?: boolean } = {}): Timeline {
  if (m.channelId !== t.channelId) return t
  if (m.parentId) {
    let items = t.items
    if (o.isNewReply) {
      const i = items.findIndex((x) => x.id === m.parentId)
      if (i >= 0 && items[i].changeSeq < m.seq) {
        items = items.slice()
        items[i] = { ...items[i], replyCount: items[i].replyCount + 1, lastReplyOn: m.createdOn, changeSeq: m.seq }
      }
    }
    const th = t.threads[m.parentId]
    const threads = th ? { ...t.threads, [m.parentId]: { ...th, replies: upsertSorted(th.replies, m) } } : t.threads
    if (items === t.items && threads === t.threads) return t
    return { ...t, items, threads }
  }
  const exists = t.items.some((x) => x.id === m.id)
  if (!exists && !insideWindow(t, m)) return t
  const items = upsertSorted(t.items, m)
  // a root shown in an open thread follows too
  const th = t.threads[m.id]
  const threads = th ? { ...t.threads, [m.id]: { ...th, root: newer(th.root ?? undefined, m) } } : t.threads
  if (items === t.items && threads === t.threads) return t
  return { ...t, items, threads }
}

export type PushOutcome =
  /** applied (t is the new timeline) */
  | { kind: 'applied'; t: Timeline }
  /** older than what was applied: nothing to do */
  | { kind: 'old' }
  /** a change is missing between applied and this push: fetch /changes?after=<applied> */
  | { kind: 'gap'; after: number }
  /** history was removed by retention (a channel push without a message): reload the latest page */
  | { kind: 'reload' }

/** a live change of this conversation */
export function applyPush(t: Timeline, p: ChatPushMessage): PushOutcome {
  if (p.channelId !== t.channelId) return { kind: 'old' }
  if (p.seq <= t.applied) return { kind: 'old' }
  if (p.prev !== t.applied) return { kind: 'gap', after: t.applied }
  if (p.op === 'channel' && !p.message) return { kind: 'reload' }
  let next: Timeline = { ...t, applied: p.seq }
  if (p.message) next = upsertMessage(next, p.message, { isNewReply: p.op === 'message' && !!p.message.parentId })
  return { kind: 'applied', t: next }
}

/** the server returns at most this many messages per /changes answer */
export const CHANGES_PAGE = CHAT_CHANGES_PAGE

/**
 * a /changes answer (gap recovery, reconnect): reset means reload the latest page. A full page (CHANGES_PAGE
 * messages) may not reach lastSeq: then `applied` moves only to the last change it carries and `more` says to ask again
 * from there.
 */
export function applyChanges(t: Timeline, ch: ChatChanges): { t: Timeline; reload: boolean; more: boolean } {
  if (ch.channelId !== t.channelId) return { t, reload: false, more: false }
  if (ch.reset) return { t: emptyTimeline(t.channelId), reload: true, more: false }
  let next = t
  for (const m of ch.messages) next = upsertMessage(next, m)
  // the server says so (package E); an older server: a full page means there may be more
  const more = ch.more ?? ch.messages.length >= CHANGES_PAGE
  const reached = more ? Math.max(...ch.messages.map((m) => m.changeSeq)) : ch.lastSeq
  return { t: { ...next, applied: Math.max(next.applied, reached), purgedSeq: Math.max(next.purgedSeq, ch.purgedSeq) }, reload: false, more }
}

/** a thread's replies page (GET /chat/messages/:id/replies) */
export function applyReplies(t: Timeline, page: { root: ChatMessageView; messages: ChatMessageView[]; more: boolean }): Timeline {
  const rootId = page.root.id
  const cur = t.threads[rootId]
  let replies = cur?.replies ?? []
  for (const m of page.messages) replies = upsertSorted(replies, m)
  const th: ThreadState = { rootId, root: newer(cur?.root ?? undefined, page.root), replies, more: page.more, loaded: true }
  // the root in the main list follows the newer version too
  const t2 = upsertMessage(t, page.root)
  return { ...t2, threads: { ...t2.threads, [rootId]: th } }
}

export function openThread(t: Timeline, rootId: string): Timeline {
  if (t.threads[rootId]) return t
  const root = t.items.find((x) => x.id === rootId) ?? null
  return { ...t, threads: { ...t.threads, [rootId]: { rootId, root, replies: [], more: false, loaded: false } } }
}

export function closeThread(t: Timeline, rootId: string): Timeline {
  if (!t.threads[rootId]) return t
  const threads = { ...t.threads }
  delete threads[rootId]
  return { ...t, threads }
}

/** replace one message locally (optimistic reaction / delete); a later push or answer with a newer changeSeq wins */
export function patchMessage(t: Timeline, id: string, fn: (m: ChatMessageView) => ChatMessageView): Timeline {
  const i = t.items.findIndex((x) => x.id === id)
  let items = t.items
  if (i >= 0) {
    items = items.slice()
    items[i] = fn(items[i])
  }
  let threads = t.threads
  for (const [k, th] of Object.entries(t.threads)) {
    const j = th.replies.findIndex((x) => x.id === id)
    if (j >= 0 || th.root?.id === id) {
      const replies = j >= 0 ? th.replies.map((x, n) => (n === j ? fn(x) : x)) : th.replies
      threads = { ...threads, [k]: { ...th, replies, root: th.root?.id === id ? fn(th.root) : th.root } }
    }
  }
  if (items === t.items && threads === t.threads) return t
  return { ...t, items, threads }
}

/** toggled reaction (optimistic): my id added to or removed from the emoji's users */
export function toggleReaction(m: ChatMessageView, emoji: string, me: string, on: boolean): ChatMessageView {
  const list = m.reactions.map((r) => ({ ...r, users: [...r.users] }))
  const r = list.find((x) => x.emoji === emoji)
  if (on) {
    if (r) { if (!r.users.includes(me)) r.users.push(me) } else list.push({ emoji, users: [me] })
  } else if (r) r.users = r.users.filter((u) => u !== me)
  return { ...m, reactions: list.filter((x) => x.users.length > 0) }
}

/** find a loaded message by seq (top-level or in an open thread) */
export function findBySeq(t: Timeline, seq: number): ChatMessageView | undefined {
  return t.items.find((m) => m.seq === seq) ?? Object.values(t.threads).flatMap((th) => th.replies).find((m) => m.seq === seq)
}

/** the first message after the read marker that someone else wrote (the "New" line) */
export function firstUnread(items: ChatMessageView[], lastReadSeq: number, me: string): ChatMessageView | undefined {
  return items.find((m) => m.seq > lastReadSeq && m.kind === 'message' && m.sender?.id !== me && !m.deleted)
}
