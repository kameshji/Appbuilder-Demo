/**
 * The chat client of one window (the main window and the pop-out each have their own): the conversation list with
 * unread counts, the open conversation's timeline, threads, pending sends, typing, cards. Everything comes from the
 * HTTP API and the live pushes (docs/dev/chat.md); the pure rules are in timeline.ts, unread.ts, optimistic.ts and
 * format.ts. Message bodies are kept in memory only (never in browser storage).
 */
import { create } from 'zustand'
import { platform } from '@/platform'
import { richTextToPlain } from '@/platform/system-tables'
import { chatTopic, chatTypingTopic, CHAT_LIMITS, type ChatCardRef, type ChatCardView, type ChatConversation, type ChatFile, type ChatMessageView, type ChatPushMessage } from '@/platform/chat-protocol'
import { ChatApiError, chatApi, errText, setLiveIdSource, type ChatMe } from './api'
import { ChatSocket, type SocketState, type TopicMessage } from './socket'
import { composeBody, liveMentions, type MentionMap } from './format'
import {
  applyChanges, applyHistory, applyPush, applyReplies, closeThread, emptyTimeline, findBySeq, openThread, patchMessage, toggleReaction, upsertMessage, type Timeline,
} from './timeline'
import { applyReadAnswer, applyUnreadEvent, emptyList, markReadLocal, removeConversation, setConversations, touchConversation, upsertConversation, type ConvList } from './unread'
import { createPending, failPending, newClientId, reconcile, removePending, retryPending, retryableError, type PendingSend } from './optimistic'

export type CardEntry = ChatCardView | 'loading' | 'error'

export interface ChatState {
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  /** unavailable: why, in words */
  reason: string
  me: ChatMe | null
  conn: SocketState
  list: ConvList
  /** open channels shown before joining (not in the list) */
  previews: Record<string, ChatConversation>
  timelines: Record<string, Timeline>
  /** `<id>:latest`, `<id>:older`, `thread:<rootId>` while a request runs */
  busy: Record<string, boolean>
  openId: string | null
  threadId: string | null
  /** a message to scroll to and highlight (deep links, search) */
  focus: { channelId: string; seq: number; at: number } | null
  pending: PendingSend[]
  typing: Record<string, { id: string; name: string; until: number }[]>
  /** a line shown over the conversation area (lost access, a failed request) */
  notice: string
  cards: Record<string, CardEntry>
  /** cards waiting in the composer (shareToChat) */
  shareCards: ChatCardRef[]
  /** the open conversation is scrolled to its newest message */
  atBottom: boolean
  /** chat panels showing in this window */
  visible: number
}

const initial = (): ChatState => ({
  status: 'idle', reason: '', me: null, conn: 'off', list: emptyList(), previews: {}, timelines: {}, busy: {}, openId: null, threadId: null, focus: null,
  pending: [], typing: {}, notice: '', cards: {}, shareCards: [], atBottom: true, visible: 0,
})

export const useChat = create<ChatState>(() => initial())
const get = () => useChat.getState()
const set = (p: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => useChat.setState(p)

let sock: ChatSocket | null = null
let offUser: (() => void) | null = null
let topicOffs: (() => void)[] = []
let hadOpen = false
let startedFor: string | null = null
let pendingOpen: { id: string; seq: number | null } | null = null
let sessionWatch: (() => void) | null = null
const buffers = new Map<string, ChatPushMessage[]>()
const recovering = new Set<string>()
const recoverAgain = new Set<string>()
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
let readTimer: ReturnType<typeof setTimeout> | null = null
let typingSentAt = 0
const MAX_TIMELINES = 10

export const convOf = (s: ChatState, id: string | null): ChatConversation | null => (id ? s.list.byId[id] ?? s.previews[id] ?? null : null)

function setTimeline(id: string, t: Timeline) {
  set((s) => ({ timelines: { ...s.timelines, [id]: t } }))
}
const tl = (id: string): Timeline | undefined => get().timelines[id]
function setBusy(key: string, on: boolean) {
  set((s) => {
    const busy = { ...s.busy }
    if (on) busy[key] = true
    else delete busy[key]
    return { busy }
  })
}
function fail(e: unknown) {
  set({ notice: errText(e) })
}

/* ------------------------------------------------------------------ start, stop */

/** starts chat in this window once a person is signed in (idempotent); demo mode: chat needs the server */
export async function startChat(): Promise<void> {
  watchSession()
  const st = platform.getState()
  if (st.mode !== 'server') {
    if (get().status === 'idle') set({ status: 'unavailable', reason: 'Chat needs the Appbuilder server. It is not part of the try-out that runs in the browser alone.' })
    return
  }
  const userId = st.session?.user.id ?? null
  if (!userId || startedFor === userId) return
  startedFor = userId
  set({ ...initial(), status: 'loading' })
  let me: ChatMe
  try {
    me = await chatApi.me()
  } catch (e) {
    startedFor = null
    set({ status: 'unavailable', reason: e instanceof ChatApiError && e.status === 401 ? 'Sign in to use chat.' : errText(e) })
    return
  }
  if (startedFor !== userId) return
  set({ me })
  sock = new ChatSocket({ onSessionEnd: () => { resetChat() } })
  setLiveIdSource(() => sock?.connectionId() ?? null)
  hadOpen = false
  sock.onState((c) => {
    set({ conn: c })
    if (c === 'open') {
      // after a reconnect the counts may have moved while away (the conversation topics catch up by their seq)
      if (hadOpen) void loadList()
      hadOpen = true
    }
  })
  offUser = sock.subscribe(`user:${me.id}`, onUser)
  sock.start()
  await loadList()
  set({ status: 'ready' })
  const p = pendingOpen
  pendingOpen = null
  if (p) void openConversation(p.id, p.seq)
}

/** signed out, another person signed in, the session ended: forget everything of the previous person */
export function resetChat(): void {
  for (const off of topicOffs) off()
  topicOffs = []
  offUser?.()
  offUser = null
  sock?.stop()
  sock = null
  startedFor = null
  buffers.clear()
  recovering.clear()
  recoverAgain.clear()
  for (const t of refreshTimers.values()) clearTimeout(t)
  refreshTimers.clear()
  set(initial())
}

function watchSession() {
  if (sessionWatch) return
  let last = platform.getState().session?.user.id ?? null
  sessionWatch = platform.subscribe(() => {
    const now = platform.getState().session?.user.id ?? null
    if (now === last) return
    last = now
    resetChat()
    if (now) void startChat()
  })
}

/* ------------------------------------------------------------------ the list */

export async function loadList(): Promise<void> {
  try {
    const r = await chatApi.conversations()
    set({ list: setConversations(r.items) })
  } catch (e) {
    fail(e)
  }
}

/** the server's view of one conversation (debounced per conversation: events come in bursts) */
export function refreshSoon(id: string, ms = 300): void {
  const t = refreshTimers.get(id)
  if (t) clearTimeout(t)
  refreshTimers.set(id, setTimeout(() => {
    refreshTimers.delete(id)
    void refreshConversation(id)
  }, ms))
}

export async function refreshConversation(id: string): Promise<ChatConversation | null> {
  try {
    const c = await chatApi.conversation(id)
    set((s) => {
      const previews = { ...s.previews }
      if (c.me) delete previews[id]
      else previews[id] = c
      return { list: upsertConversation(s.list, c), previews }
    })
    return c
  } catch (e) {
    if (e instanceof ChatApiError && e.status === 404) lostAccess(id)
    return null
  }
}

function onUser(m: TopicMessage) {
  if (m.t !== 'user') return
  if (m.event === 'chat.unread') {
    const r = applyUnreadEvent(get().list, m)
    set({ list: r.list })
    if (r.refetch) refreshSoon(m.channelId)
  } else if (m.event === 'chat.channels') {
    if (m.change === 'removed') lostAccess(m.channelId)
    else refreshSoon(m.channelId, 50)
  }
}

/** the person may no longer read a conversation (removed, left, deleted, archived open channel) */
function lostAccess(id: string, why = 'You are no longer in this conversation.') {
  const s = get()
  const wasOpen = s.openId === id
  if (wasOpen) unsubscribeOpen()
  set((st) => {
    const timelines = { ...st.timelines }
    delete timelines[id]
    const previews = { ...st.previews }
    delete previews[id]
    return {
      list: removeConversation(st.list, id), timelines, previews,
      ...(wasOpen ? { openId: null, threadId: null, notice: why } : {}),
      pending: st.pending.filter((p) => p.channelId !== id),
    }
  })
  buffers.delete(id)
}

/* ------------------------------------------------------------------ one conversation */

function unsubscribeOpen() {
  for (const off of topicOffs) off()
  topicOffs = []
}

function subscribeOpen(id: string) {
  unsubscribeOpen()
  if (!sock) return
  topicOffs = [
    sock.subscribe(chatTopic(id), (m) => onTopic(id, m)),
    sock.subscribe(chatTypingTopic(id), (m) => onTyping(id, m)),
  ]
}

/** opens a conversation (and scrolls to a message when seq is given); queued until chat has started */
export async function openConversation(id: string, seq: number | null = null): Promise<void> {
  const s = get()
  if (s.status !== 'ready') {
    pendingOpen = { id, seq }
    return
  }
  if (s.openId !== id) {
    set({ openId: id, threadId: null, notice: '', atBottom: true })
    subscribeOpen(id)
    evictTimelines(id)
  }
  if (!convOf(get(), id)) {
    const c = await refreshConversation(id)
    if (!c) {
      set({ openId: null, notice: 'This conversation is not available. It may have been deleted, or you are not in it.' })
      unsubscribeOpen()
      return
    }
  }
  if (!tl(id)?.loaded) await loadLatest(id)
  if (seq) await focusOn(id, seq)
  else scheduleRead(id)
}

export function closeConversation(): void {
  unsubscribeOpen()
  set({ openId: null, threadId: null, focus: null })
}

function evictTimelines(keep: string) {
  const ids = Object.keys(get().timelines)
  if (ids.length <= MAX_TIMELINES) return
  set((s) => {
    const timelines: Record<string, Timeline> = {}
    for (const k of ids.slice(-MAX_TIMELINES)) timelines[k] = s.timelines[k]
    if (s.timelines[keep]) timelines[keep] = s.timelines[keep]
    return { timelines }
  })
}

export async function loadLatest(id: string, reset = false): Promise<void> {
  const key = `${id}:latest`
  if (get().busy[key]) return
  setBusy(key, true)
  try {
    const page = await chatApi.history(id, { limit: CHAT_LIMITS.pageSize })
    const base = reset || !tl(id) ? emptyTimeline(id) : tl(id)!
    setTimeline(id, applyHistory(base, page, 'latest'))
    replayBuffer(id)
    scheduleRead(id)
  } catch (e) {
    if (e instanceof ChatApiError && e.status === 404) lostAccess(id, 'This conversation is not available. It may have been deleted, or you are not in it.')
    else fail(e)
  } finally {
    setBusy(key, false)
  }
}

/** pages back 50 at a time (never the whole conversation) */
export async function loadOlder(id: string): Promise<boolean> {
  const t = tl(id)
  const key = `${id}:older`
  if (!t?.loaded || !t.hasOlder || !t.items.length || get().busy[key]) return false
  setBusy(key, true)
  try {
    const page = await chatApi.history(id, { before: t.items[0].seq, limit: CHAT_LIMITS.pageSize })
    setTimeline(id, applyHistory(tl(id) ?? t, page, 'older'))
    return page.messages.length > 0
  } catch (e) {
    fail(e)
    return false
  } finally {
    setBusy(key, false)
  }
}

/** scroll to a message: page back until it is loaded (top-level), or find it in its thread */
export async function focusOn(id: string, seq: number): Promise<void> {
  for (let n = 0; n < 40; n++) {
    const t = tl(id)
    if (!t?.loaded) return
    const hit = findBySeq(t, seq)
    if (hit && !hit.parentId) {
      set({ focus: { channelId: id, seq, at: Date.now() }, atBottom: false })
      return
    }
    if (hit?.parentId) {
      await openThreadOf(hit.parentId)
      set({ focus: { channelId: id, seq, at: Date.now() } })
      return
    }
    if (seq <= t.purgedSeq) break
    if (t.items.length && seq >= t.items[0].seq) break
    if (!t.hasOlder) break
    if (!(await loadOlder(id))) break
  }
  // not a top-level message in the history: a thread reply (its latest change is at or after its seq)
  try {
    const ch = await chatApi.changes(id, Math.max(0, seq - 1))
    const m = ch.messages.find((x) => x.seq === seq)
    if (m?.parentId) {
      await openThreadOf(m.parentId)
      set({ focus: { channelId: id, seq, at: Date.now() } })
      return
    }
  } catch { /* not found */ }
  set({ notice: 'That message is no longer here. It may have been deleted or removed by the retention period.' })
}

function replayBuffer(id: string) {
  const list = buffers.get(id)
  if (!list?.length) return
  buffers.delete(id)
  for (const m of list.sort((a, b) => a.seq - b.seq)) onPush(m)
}

function onTopic(id: string, m: TopicMessage) {
  if (m.t === 'subscribed') {
    const t = tl(id)
    if (t?.loaded && typeof m.seq === 'number' && m.seq !== t.applied) void recover(id)
    return
  }
  if (m.t === 'chat') return onPush(m)
  if (m.t === 'resync') return void recover(id)
  if (m.t === 'unsubscribed') return lostAccess(id)
  if (m.t === 'error' && (m.code === 'not-found' || m.code === 'denied')) return lostAccess(id, 'This conversation is not available. It may have been deleted, or you are not in it.')
}

function onPush(m: ChatPushMessage) {
  const id = m.channelId
  const t = tl(id)
  if (!t?.loaded) {
    // the first page is on its way: keep the push and replay it after
    const list = buffers.get(id) ?? []
    list.push(m)
    buffers.set(id, list.slice(-500))
    return
  }
  const r = applyPush(t, m)
  if (r.kind === 'old') return
  if (r.kind === 'gap') return void recover(id)
  if (r.kind === 'reload') return void loadLatest(id, true)
  setTimeline(id, r.t)
  const me = get().me?.id ?? ''
  if (m.message) {
    const msg = m.message
    set((s) => ({ pending: reconcile(s.pending, msg, me), list: msg.kind === 'message' && m.op === 'message' ? touchConversation(s.list, id, msg.createdOn, m.seq) : s.list }))
  }
  if (m.op === 'members' || m.op === 'channel') refreshSoon(id)
  scheduleRead(id)
}

/** catches up with /changes after a gap, a reconnect or a server restart (single flight per conversation) */
export async function recover(id: string): Promise<void> {
  if (recovering.has(id)) {
    recoverAgain.add(id)
    return
  }
  recovering.add(id)
  try {
    for (let n = 0; n < 50; n++) {
      const t = tl(id)
      if (!t?.loaded) return
      const ch = await chatApi.changes(id, t.applied)
      const r = applyChanges(tl(id) ?? t, ch)
      if (r.reload) {
        setTimeline(id, r.t)
        await loadLatest(id, true)
        return
      }
      setTimeline(id, r.t)
      const me = get().me?.id ?? ''
      set((s) => {
        let pending = s.pending
        for (const m of ch.messages) pending = reconcile(pending, m, me)
        return { pending, list: ch.conversation.me ? upsertConversation(s.list, ch.conversation) : s.list }
      })
      if (!r.more) break
    }
    scheduleRead(id)
  } catch (e) {
    if (e instanceof ChatApiError && e.status === 404) lostAccess(id)
  } finally {
    recovering.delete(id)
    if (recoverAgain.delete(id)) void recover(id)
  }
}

/* ------------------------------------------------------------------ read marker, visibility */

export function setPanelVisible(delta: 1 | -1): void {
  set((s) => ({ visible: Math.max(0, s.visible + delta) }))
  const id = get().openId
  if (id) scheduleRead(id)
}

export function setAtBottom(v: boolean): void {
  if (get().atBottom === v) return
  set({ atBottom: v })
  const id = get().openId
  if (v && id) scheduleRead(id)
}

export function scheduleRead(id: string): void {
  if (readTimer) clearTimeout(readTimer)
  readTimer = setTimeout(() => {
    readTimer = null
    void readNow(id)
  }, 350)
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    const id = get().openId
    if (id && document.visibilityState === 'visible') scheduleRead(id)
  })
}

/** marks the open conversation read up to what is on screen, when someone can see it */
async function readNow(id: string): Promise<void> {
  const s = get()
  if (s.openId !== id || s.visible <= 0 || !s.atBottom || s.threadId) return
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
  const c = convOf(s, id)
  const t = s.timelines[id]
  if (!c?.me || !t?.loaded) return
  const seq = Math.max(t.applied, 0)
  if (c.me.lastReadSeq >= seq && c.unread === 0 && c.mentions === 0) return
  set({ list: markReadLocal(get().list, id, seq) })
  try {
    const a = await chatApi.markRead(id, seq)
    set({ list: applyReadAnswer(get().list, id, a) })
  } catch { /* the next read tries again */ }
}

/* ------------------------------------------------------------------ typing */

function onTyping(id: string, m: TopicMessage) {
  if (m.t !== 'typing' || m.userId === get().me?.id) return
  const until = Date.now() + 5000
  set((s) => ({ typing: { ...s.typing, [id]: [...(s.typing[id] ?? []).filter((x) => x.id !== m.userId && x.until > Date.now()), { id: m.userId, name: m.name, until }] } }))
  setTimeout(() => set((s) => ({ typing: { ...s.typing, [id]: (s.typing[id] ?? []).filter((x) => x.until > Date.now()) } })), 5100)
}

/** tells the others I am typing (at most every 3 s, as the server allows) */
export function sendTyping(id: string): void {
  const now = Date.now()
  if (now - typingSentAt < CHAT_LIMITS.typingIntervalMs) return
  typingSentAt = now
  void chatApi.typing(id).catch(() => {})
}

/* ------------------------------------------------------------------ threads */

export async function openThreadOf(rootId: string): Promise<void> {
  const id = get().openId
  if (!id) return
  const t = tl(id)
  if (t) setTimeline(id, openThread(t, rootId))
  set({ threadId: rootId })
  await loadReplies(id, rootId)
}

export async function loadReplies(id: string, rootId: string): Promise<void> {
  const key = `thread:${rootId}`
  if (get().busy[key]) return
  setBusy(key, true)
  try {
    const cur = tl(id)?.threads[rootId]
    const after = cur?.loaded && cur.replies.length ? cur.replies[cur.replies.length - 1].seq : undefined
    const page = await chatApi.replies(rootId, after ? { after } : {})
    const t = tl(id)
    if (t) setTimeline(id, applyReplies(t, page))
  } catch (e) {
    fail(e)
  } finally {
    setBusy(key, false)
  }
}

export function closeThreadPane(): void {
  const s = get()
  const id = s.openId
  if (id && s.threadId) {
    const t = tl(id)
    if (t) setTimeline(id, closeThread(t, s.threadId))
  }
  set({ threadId: null })
  if (id) scheduleRead(id)
}

/* ------------------------------------------------------------------ sending */

export interface SendInput { text: string; mentions: MentionMap; parentId: string | null; files: ChatFile[]; cards: ChatCardRef[] }

/** shows the message at once ("sending"), then sends it with its client id (a retry never makes a second message) */
export async function sendMessage(channelId: string, input: SendInput): Promise<void> {
  const body = composeBody(input.text, liveMentions(input.text, input.mentions))
  const p = createPending({ clientId: newClientId(), channelId, parentId: input.parentId, body, text: richTextToPlain(body), files: input.files, cards: input.cards })
  set((s) => ({ pending: [...s.pending, p] }))
  await deliver(p)
}

async function deliver(p: PendingSend): Promise<void> {
  try {
    const r = await chatApi.send(p.channelId, { body: p.body, parent: p.parentId, files: p.files.map((f) => f.id), cards: p.cards, clientId: p.clientId })
    const t = tl(p.channelId)
    if (t?.loaded) setTimeline(p.channelId, upsertMessage(t, r.message))
    set((s) => ({ pending: removePending(s.pending, p.clientId), list: r.message.parentId ? s.list : touchConversation(s.list, p.channelId, r.message.createdOn, r.message.seq) }))
  } catch (e) {
    const status = e instanceof ChatApiError ? e.status : 0
    set((s) => ({ pending: failPending(s.pending, p.clientId, errText(e), retryableError(status)) }))
  }
}

export function retrySend(clientId: string): void {
  const p = get().pending.find((x) => x.clientId === clientId)
  if (!p) return
  set((s) => ({ pending: retryPending(s.pending, clientId) }))
  void deliver({ ...p, state: 'sending' })
}

export function discardSend(clientId: string): void {
  const p = get().pending.find((x) => x.clientId === clientId)
  set((s) => ({ pending: removePending(s.pending, clientId) }))
  for (const f of p?.files ?? []) void chatApi.discardFile(f.id).catch(() => {})
}

/** the pending send's text back in the composer (a refused message is fixed, then sent again) */
export function takeBack(clientId: string): PendingSend | null {
  const p = get().pending.find((x) => x.clientId === clientId) ?? null
  if (p) set((s) => ({ pending: removePending(s.pending, clientId) }))
  return p
}

export async function editMessage(m: ChatMessageView, text: string, mentions: MentionMap): Promise<void> {
  const body = composeBody(text, liveMentions(text, mentions))
  const r = await chatApi.edit(m.id, body)
  const t = tl(m.channelId)
  if (t) setTimeline(m.channelId, upsertMessage(t, r.message))
}

export async function deleteMessage(m: ChatMessageView): Promise<void> {
  const t = tl(m.channelId)
  if (t) setTimeline(m.channelId, patchMessage(t, m.id, (x) => ({ ...x, deleted: true, body: '', text: '', files: [], cards: [], reactions: [] })))
  try {
    await chatApi.remove(m.id)
  } catch (e) {
    fail(e)
    void recover(m.channelId)
    // the optimistic change is undone by the newer version from the server
    const t2 = tl(m.channelId)
    if (t2) setTimeline(m.channelId, patchMessage(t2, m.id, () => m))
  }
}

export async function react(m: ChatMessageView, emoji: string): Promise<void> {
  const me = get().me?.id
  if (!me) return
  const on = !m.reactions.some((r) => r.emoji === emoji && r.users.includes(me))
  const t = tl(m.channelId)
  if (t) setTimeline(m.channelId, patchMessage(t, m.id, (x) => toggleReaction(x, emoji, me, on)))
  try {
    const r = await chatApi.react(m.id, emoji, on)
    const t2 = tl(m.channelId)
    if (t2) setTimeline(m.channelId, upsertMessage(t2, r.message))
  } catch (e) {
    fail(e)
    const t2 = tl(m.channelId)
    if (t2) setTimeline(m.channelId, patchMessage(t2, m.id, () => m))
  }
}

/* ------------------------------------------------------------------ conversations: create, join, settings */

export async function createConversation(b: Parameters<typeof chatApi.create>[0]): Promise<ChatConversation> {
  const c = await chatApi.create(b)
  set((s) => ({ list: upsertConversation(s.list, c) }))
  await openConversation(c.id)
  return c
}

export async function joinConversation(id: string): Promise<void> {
  const c = await chatApi.join(id)
  set((s) => {
    const previews = { ...s.previews }
    delete previews[id]
    return { list: upsertConversation(s.list, c), previews }
  })
}

export async function leaveConversation(id: string): Promise<void> {
  await chatApi.leave(id)
  lostAccess(id, '')
  void refreshConversation(id).catch(() => {})
}

export async function updateMine(id: string, b: Parameters<typeof chatApi.setMine>[1]): Promise<void> {
  const c = await chatApi.setMine(id, b)
  set((s) => ({ list: upsertConversation(s.list, c) }))
}

export async function setArchived(id: string, archived: boolean): Promise<void> {
  const c = await chatApi.archive(id, archived)
  set((s) => ({ list: upsertConversation(s.list, c) }))
}

export async function renameConversation(id: string, b: Parameters<typeof chatApi.update>[1]): Promise<void> {
  const c = await chatApi.update(id, b)
  set((s) => ({ list: upsertConversation(s.list, c) }))
}

export function clearNotice(): void {
  set({ notice: '' })
}

/* ------------------------------------------------------------------ cards: resolved per reader by the server */

const cardRefs = new Map<string, { env: string; table: string | null }>()
const cardWatch = new Map<string, { off: () => void; count: number }>()

export const cardKey = (messageId: string, index: number) => `${messageId}:${index}`

export async function resolveCard(messageId: string, index: number, ref: ChatCardRef): Promise<void> {
  const key = cardKey(messageId, index)
  const cur = get().cards[key]
  if (cur === 'loading') return
  cardRefs.set(key, { env: ref.env, table: ref.kind === 'record' ? ref.table : null })
  set((s) => ({ cards: { ...s.cards, [key]: 'loading' } }))
  try {
    const v = await chatApi.resolveCard(messageId, index)
    set((s) => ({ cards: { ...s.cards, [key]: v } }))
  } catch {
    set((s) => ({ cards: { ...s.cards, [key]: 'error' } }))
  }
}

/** a record card follows its table for the reader: a change ticks the table topic, the card asks the server again */
export function watchCardTable(env: string, table: string): () => void {
  const k = `${env}\u0001${table}`
  const cur = cardWatch.get(k)
  if (cur) {
    cur.count++
  } else if (sock) {
    const off = sock.subscribe(`table:${table}`, (m) => {
      if (m.t !== 'table') return
      // forget the answers of this table's cards: the mounted cards resolve again
      set((s) => {
        const cards = { ...s.cards }
        for (const [key, r] of cardRefs) if (r.env === env && r.table === table && cards[key] !== 'loading') delete cards[key]
        return { cards }
      })
    }, env)
    cardWatch.set(k, { off, count: 1 })
  }
  return () => {
    const w = cardWatch.get(k)
    if (!w) return
    if (--w.count <= 0) {
      w.off()
      cardWatch.delete(k)
    }
  }
}

/** package E's "Share to chat": the card waits in the composer of the conversation the person picks */
export function shareToChat(card: ChatCardRef): void {
  set((s) => ({ shareCards: [...s.shareCards, card].slice(-CHAT_LIMITS.maxCards) }))
}

export function clearShareCards(): void {
  set({ shareCards: [] })
}

/* ------------------------------------------------------------------ test hooks (exit checks, debugging) */

if (typeof window !== 'undefined') {
  ;(window as unknown as { __abChat?: unknown }).__abChat = {
    state: () => get(),
    /** drop the live connection as a network cut would */
    drop: () => sock?.drop(),
    socketState: () => sock?.state() ?? 'off',
  }
}
