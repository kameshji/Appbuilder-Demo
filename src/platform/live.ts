/**
 * The browser's one realtime connection (server mode): WebSocket /api/v1/live, protocol in live-protocol.ts and
 * docs/dev/live.md. One LiveClient per page (each tab has its own socket). Pure TypeScript, no React; remote.ts owns it.
 *
 * - Reconnects with exponential backoff and full jitter (1 s .. 30 s; at least 30 s after a "limit" close); immediately
 *   when the tab becomes visible or the browser comes back online; never while the browser says it is offline.
 * - Re-subscribes every topic after a reconnect and re-publishes presence and Studio locks.
 * - Gap detection per table topic: `prev` of a message must equal the last seq seen; a subscription acknowledgement whose
 *   seq is ahead of the last seen one (or a new server epoch) means changes were missed while away: the topic's handlers
 *   get a synthetic { t: 'resync' } message (the platform then invalidates the table).
 * - Session ends (4401) and forced password changes (4403) are reported to the platform, which checks the session over
 *   HTTP; no reconnect loop against a dead session.
 * - Chat (P3 package E moved chat onto this one socket): `chat` and `typing` pushes are routed by topic; `unsubscribed`
 *   (the server ended a subscription) and an `error` answering a subscription reach that topic's handlers; chat topics
 *   (`chat:*`) also get the `subscribed` answer with its seq (the chat store compares it with what it applied and asks
 *   /changes). Install-wide topics (no env: user:, chat:) and topics subscribed with `keep` survive an environment
 *   switch (resetEnvTopics); only environment-bound topics are dropped.
 * - The browser going offline closes the socket at once (a cut network shows as offline instead of after the
 *   heartbeat); it reconnects when the browser is back online.
 * - When the socket is unavailable the platform degrades to periodic refetch (status 'degraded'); the UI says so.
 */
import type {
  ClientMessage, HelloMessage, LivePerson, PresenceState, ServerMessage,
} from './live-protocol.ts'
import { LIVE_CLOSE, LIVE_PATH } from './live-protocol.ts'

export type LiveState = 'off' | 'connecting' | 'open' | 'degraded'

export interface LiveStatus {
  state: LiveState
  /** when the state last changed (ms) */
  since: number
  /** a short human sentence for degraded / connecting */
  reason?: string
}

export type LiveHandler = (msg: ServerMessage | { t: 'resync'; reason: string }) => void

export interface LockReply { ok: boolean; holder: LivePerson | null; mine: boolean; message?: string }

/** minimal WebSocket surface (the browser's, or a fake in tests) */
export interface WebSocketLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code: number; reason: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export interface LiveClientOptions {
  /** full ws(s):// URL; default from location */
  url?: string
  createSocket?: (url: string) => WebSocketLike
  /** randomness for the jitter (tests) */
  random?: () => number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  /** the socket closed with 4401 / 4403: the platform checks the session (resolve true = still signed in, reconnect) */
  onSessionProblem?: (code: number) => Promise<boolean>
  /** after how long without an open socket the client reports 'degraded' (ms; default 4000) */
  degradeAfterMs?: number
  /** listen to window online/offline and document visibility (default: when they exist) */
  watchEnvironment?: boolean
}

interface Topic {
  topic: string
  env?: string
  handlers: Set<LiveHandler>
  /** last seq seen (table topics) */
  last?: number
  acked: boolean
  /** the id of the last `sub` sent (answers and refusals are matched by it) */
  subId?: string
  /** survives an environment switch (install-wide topics always do) */
  keep: boolean
}

/** chat topics get the `subscribed` answer (with the conversation's seq) instead of the table-style resync */
const isChatTopic = (topic: string) => topic.startsWith('chat:')

const OPEN = 1
const keyOf = (topic: string, env?: string) => `${env ?? ''}\u0001${topic}`

export function liveUrl(): string {
  const loc = (globalThis as { location?: Location }).location
  if (!loc) return ''
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}${LIVE_PATH}`
}

export function backoffMs(attempt: number, random: () => number, minMs = 0): number {
  const cap = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))
  return Math.max(minMs, Math.round(cap / 2 + random() * (cap / 2)))
}

export class LiveClient {
  private o: Required<Omit<LiveClientOptions, 'url' | 'onSessionProblem'>> & Pick<LiveClientOptions, 'onSessionProblem'>
  private url: string
  private ws: WebSocketLike | null = null
  private started = false
  private attempt = 0
  private timer: unknown = null
  private degradeTimer: unknown = null
  private topics = new Map<string, Topic>()
  private bySub = new Map<string, string>()
  private presence = new Map<string, { scope: string; env: string; state: PresenceState }>()
  private locks = new Map<string, { scope: string; env: string }>()
  private pending = new Map<string, (m: ServerMessage) => void>()
  private listeners = new Set<LiveHandler>()
  private statusListeners = new Set<(s: LiveStatus) => void>()
  private _status: LiveStatus
  private hello: HelloMessage | null = null
  private epoch: string | null = null
  private seq = 0
  private offline = false
  private cleanup: (() => void) | null = null

  constructor(opts: LiveClientOptions = {}) {
    this.url = opts.url ?? liveUrl()
    const WS = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket
    this.o = {
      createSocket: opts.createSocket ?? ((u) => {
        if (!WS) throw new Error('WebSocket is not available')
        return new WS(u)
      }),
      random: opts.random ?? Math.random,
      now: opts.now ?? (() => Date.now()),
      setTimer: opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)),
      onSessionProblem: opts.onSessionProblem,
      degradeAfterMs: opts.degradeAfterMs ?? 4000,
      watchEnvironment: opts.watchEnvironment ?? (typeof window !== 'undefined' && typeof document !== 'undefined'),
    }
    this._status = { state: 'off', since: this.o.now() }
  }

  /* -------------------------------------------------------------- lifecycle */

  /** connect (signed in); idempotent */
  start(): void {
    if (this.started) return
    this.started = true
    this.attempt = 0
    if (this.o.watchEnvironment && !this.cleanup) this.watch()
    this.connect()
  }

  /** disconnect and forget topics (sign-out, environment switch keeps topics: use resetTopics) */
  stop(): void {
    this.started = false
    this.clear(this.timer)
    this.timer = null
    this.clear(this.degradeTimer)
    this.degradeTimer = null
    const ws = this.ws
    this.ws = null
    this.hello = null
    if (ws) {
      ws.onclose = null
      try {
        ws.close(1000, 'signed out')
      } catch { /* ignore */ }
    }
    this.cleanup?.()
    this.cleanup = null
    this.setStatus('off')
  }

  /** drop every subscription, presence and lock (sign-out) */
  resetTopics(): void {
    for (const t of this.topics.values()) this.raw({ t: 'unsub', topic: t.topic, env: t.env })
    for (const p of this.presence.values()) this.raw({ t: 'presence', scope: p.scope, env: p.env, state: null })
    this.topics.clear()
    this.bySub.clear()
    this.presence.clear()
    this.locks.clear()
  }

  /**
   * an environment switch: environment-bound topics (table:, env, app:, presence: of the old environment), presence and
   * locks are dropped; install-wide topics (user:, chat:) and topics subscribed with `keep` stay subscribed
   */
  resetEnvTopics(): void {
    for (const [key, t] of [...this.topics]) {
      if (t.env === undefined || t.keep) continue
      this.raw({ t: 'unsub', topic: t.topic, env: t.env })
      if (t.subId) this.bySub.delete(t.subId)
      this.topics.delete(key)
    }
    for (const p of this.presence.values()) this.raw({ t: 'presence', scope: p.scope, env: p.env, state: null })
    this.presence.clear()
    this.locks.clear()
  }

  /** test and exit-check hook: drop the connection as a network cut would (it reconnects as usual) */
  drop(): void {
    const ws = this.ws
    if (!ws) return
    try {
      ws.close(4000, 'dropped')
    } catch { /* ignore */ }
  }

  /** the server's epoch of the current (or last) connection */
  serverEpoch(): string | null {
    return this.epoch
  }

  status(): LiveStatus {
    return this._status
  }
  onStatus(fn: (s: LiveStatus) => void): () => void {
    this.statusListeners.add(fn)
    return () => {
      this.statusListeners.delete(fn)
    }
  }
  /** every message (after topic handlers) */
  onMessage(fn: LiveHandler): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  /** false when there is nothing to connect to (no page address: unit tests under Node) */
  enabled(): boolean {
    return !!this.url
  }
  /** this socket's id (sent as X-Appbuilder-Live on writes); null while not connected */
  connectionId(): string | null {
    return this.hello?.connection ?? null
  }
  me(): LivePerson | null {
    return this.hello?.user ?? null
  }

  /* -------------------------------------------------------------- topics */

  /**
   * subscribe a handler; the topic is subscribed on the server while at least one handler wants it. `keep`: the topic
   * survives an environment switch (a chat card's table in another environment); install-wide topics (no env) always do.
   */
  subscribe(topic: string, env: string | undefined, handler: LiveHandler, o: { keep?: boolean } = {}): () => void {
    const key = keyOf(topic, env)
    let t = this.topics.get(key)
    if (!t) {
      t = { topic, env, handlers: new Set(), acked: false, keep: !!o.keep }
      this.topics.set(key, t)
      this.sendSub(t)
    } else if (o.keep) t.keep = true
    t.handlers.add(handler)
    return () => {
      const cur = this.topics.get(key)
      if (!cur || !cur.handlers.has(handler)) return
      cur.handlers.delete(handler)
      if (!cur.handlers.size) {
        this.topics.delete(key)
        if (cur.subId) this.bySub.delete(cur.subId)
        this.raw({ t: 'unsub', topic, env })
      }
    }
  }

  has(topic: string, env?: string): boolean {
    return this.topics.has(keyOf(topic, env))
  }

  /** join (state) or leave (null) a presence scope; remembered and re-sent after reconnects */
  setPresence(scope: string, env: string, state: PresenceState | null): void {
    const key = keyOf(scope, env)
    if (state === null) this.presence.delete(key)
    else this.presence.set(key, { scope, env, state })
    this.raw({ t: 'presence', scope, env, state })
  }

  /** Studio soft lock; the reply comes from the server (or ok:false with a message when not connected) */
  lock(scope: string, env: string, action: 'acquire' | 'release' | 'takeover'): Promise<LockReply> {
    const key = keyOf(scope, env)
    if (action === 'release') this.locks.delete(key)
    if (!this.ws || this.ws.readyState !== OPEN) {
      return Promise.resolve({ ok: false, holder: null, mine: false, message: 'Live updates are not connected.' })
    }
    const id = `l${++this.seq}`
    return new Promise((resolve) => {
      const done = (m: ServerMessage) => {
        if (m.t === 'lock') {
          if (m.mine) this.locks.set(key, { scope, env })
          else this.locks.delete(key)
          resolve({ ok: m.ok, holder: m.holder, mine: m.mine, ...(m.message ? { message: m.message } : {}) })
        } else resolve({ ok: false, holder: null, mine: false, message: m.t === 'error' ? m.message : 'No answer.' })
      }
      this.pending.set(id, done)
      this.o.setTimer(() => {
        if (this.pending.delete(id)) resolve({ ok: false, holder: null, mine: false, message: 'No answer from the server.' })
      }, 8000)
      this.raw({ t: 'lock', id, scope, env, action })
    })
  }

  /* -------------------------------------------------------------- internals */

  private clear(t: unknown) {
    if (t !== null && t !== undefined) this.o.clearTimer(t)
  }

  private setStatus(state: LiveState, reason?: string) {
    if (this._status.state === state && this._status.reason === reason) return
    this._status = { state, since: this.o.now(), ...(reason ? { reason } : {}) }
    for (const l of [...this.statusListeners]) {
      try {
        l(this._status)
      } catch { /* ignore */ }
    }
  }

  private raw(m: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== OPEN) return false
    try {
      this.ws.send(JSON.stringify(m))
      return true
    } catch {
      return false
    }
  }

  private sendSub(t: Topic) {
    t.acked = false
    if (t.subId) this.bySub.delete(t.subId)
    t.subId = `s${++this.seq}`
    this.bySub.set(t.subId, keyOf(t.topic, t.env))
    this.raw({ t: 'sub', id: t.subId, topic: t.topic, env: t.env })
  }

  private connect() {
    if (!this.started) return
    // no page address (unit tests under Node): nothing to connect to
    if (!this.url) return this.setStatus('off')
    if (this.offline) return this.setStatus('degraded', 'You are offline.')
    if (this._status.state !== 'degraded') this.setStatus('connecting')
    // after a few seconds without a socket the platform falls back to periodic refetch
    if (!this.degradeTimer) {
      this.degradeTimer = this.o.setTimer(() => {
        this.degradeTimer = null
        if (this.started && this._status.state !== 'open') this.setStatus('degraded', 'Live updates are not available right now; data refreshes every 30 seconds.')
      }, this.o.degradeAfterMs)
    }
    let ws: WebSocketLike
    try {
      ws = this.o.createSocket(this.url)
    } catch {
      return this.retry()
    }
    this.ws = ws
    ws.onmessage = (ev) => this.onData(ev.data)
    ws.onerror = () => { /* onclose follows */ }
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.ws = null
      this.hello = null
      for (const [id, fn] of this.pending) {
        this.pending.delete(id)
        fn({ t: 'error', id, code: 'unavailable', message: 'The connection closed.' })
      }
      this.onClosed(ev.code)
    }
  }

  private async onClosed(code: number) {
    if (!this.started) return
    if (code === LIVE_CLOSE.unauthenticated || code === LIVE_CLOSE.passwordChange) {
      this.setStatus('degraded', code === LIVE_CLOSE.passwordChange ? 'Change your password to continue.' : 'Checking your session...')
      const ok = this.o.onSessionProblem ? await this.o.onSessionProblem(code).catch(() => false) : false
      if (!this.started) return
      if (ok && code === LIVE_CLOSE.unauthenticated) {
        this.attempt = 0
        return this.retry(0)
      }
      // signed out, or must change the password: stay quiet until the platform starts us again
      return this.stop()
    }
    this.retry(code === LIVE_CLOSE.limit ? 30_000 : 0)
  }

  private retry(minMs = 0) {
    if (!this.started) return
    this.clear(this.timer)
    const ms = backoffMs(this.attempt++, this.o.random, minMs)
    if (this._status.state === 'open') this.setStatus('connecting')
    this.timer = this.o.setTimer(() => {
      this.timer = null
      this.connect()
    }, ms)
  }

  /** reconnect now (tab visible again, back online) */
  reconnectNow(): void {
    if (!this.started || this.ws) return
    this.clear(this.timer)
    this.timer = null
    this.attempt = 0
    this.connect()
  }

  private onData(data: unknown) {
    let m: ServerMessage
    try {
      m = JSON.parse(String(data)) as ServerMessage
    } catch {
      return
    }
    if (!m || typeof m !== 'object') return
    if (m.t === 'hello') return this.onHello(m)
    if ('id' in m && typeof m.id === 'string' && this.pending.has(m.id) && (m.t === 'lock' || m.t === 'error')) {
      const fn = this.pending.get(m.id)!
      this.pending.delete(m.id)
      fn(m)
      if (m.t === 'lock') this.deliverAll(m)
      return
    }
    if (m.t === 'subscribed') return this.onAck(m)
    // the server refused a subscription (not-found, denied, too many): its handlers decide
    if (m.t === 'error' && typeof m.id === 'string' && this.bySub.has(m.id)) {
      const t = this.topics.get(this.bySub.get(m.id)!)
      this.bySub.delete(m.id)
      if (t) {
        t.subId = undefined
        this.deliver(t, m)
      }
      this.deliverAll(m)
      return
    }
    // the server ended a subscription (removed from a conversation, lost access): the handlers decide
    if (m.t === 'unsubscribed') {
      for (const t of this.topics.values()) {
        if (t.topic !== m.topic || (m.env !== undefined && t.env !== m.env)) continue
        if (t.subId) this.bySub.delete(t.subId)
        t.subId = undefined
        t.acked = false
        this.deliver(t, m)
      }
      this.deliverAll(m)
      return
    }
    if (m.t === 'resync') {
      for (const t of this.topics.values()) this.deliver(t, { t: 'resync', reason: m.reason })
      return
    }
    let topic: string | undefined
    let env: string | undefined
    if (m.t === 'table' || m.t === 'presence' || m.t === 'env' || m.t === 'app') {
      topic = m.topic
      env = m.env
    } else if (m.t === 'user' || m.t === 'chat' || m.t === 'typing') topic = m.topic
    else if (m.t === 'lock') {
      topic = `presence:${m.scope}`
      env = m.env
    }
    if (topic) {
      const t = this.topics.get(keyOf(topic, env))
      if (t) {
        if (m.t === 'table') {
          const gap = t.last !== undefined && m.prev !== t.last
          t.last = m.seq
          if (gap) this.deliver(t, { t: 'resync', reason: 'gap' })
        }
        this.deliver(t, m)
      }
    }
    this.deliverAll(m)
  }

  private onHello(m: HelloMessage) {
    const newEpoch = this.epoch !== null && this.epoch !== m.epoch
    this.epoch = m.epoch
    this.hello = m
    this.attempt = 0
    this.clear(this.degradeTimer)
    this.degradeTimer = null
    this.setStatus('open')
    for (const t of this.topics.values()) {
      // a server restart: sequences start again, everything may have changed
      if (newEpoch) {
        t.last = undefined
        this.deliver(t, { t: 'resync', reason: 'server restarted' })
      }
      this.sendSub(t)
    }
    for (const p of this.presence.values()) this.raw({ t: 'presence', scope: p.scope, env: p.env, state: p.state })
    for (const l of this.locks.values()) this.raw({ t: 'lock', scope: l.scope, env: l.env, action: 'acquire' })
    this.deliverAll(m)
  }

  private onAck(m: Extract<ServerMessage, { t: 'subscribed' }>) {
    const t = this.topics.get(keyOf(m.topic, m.env))
    if (!t) return
    t.acked = true
    // chat: the handlers compare the conversation's seq with what they applied (and fetch /changes)
    if (isChatTopic(t.topic)) return this.deliver(t, m)
    if (typeof m.seq !== 'number') return
    // ahead of what we saw: changes happened while we were away
    if (t.last !== undefined && m.seq !== t.last) this.deliver(t, { t: 'resync', reason: 'missed changes' })
    t.last = m.seq
  }

  private deliver(t: Topic, m: Parameters<LiveHandler>[0]) {
    for (const h of [...t.handlers]) {
      try {
        h(m)
      } catch (e) {
        console.error('[live] handler failed', e)
      }
    }
  }

  private deliverAll(m: ServerMessage) {
    for (const l of [...this.listeners]) {
      try {
        l(m)
      } catch (e) {
        console.error('[live] listener failed', e)
      }
    }
  }

  private watch() {
    const onOnline = () => {
      this.offline = false
      this.reconnectNow()
    }
    const onOffline = () => {
      this.offline = true
      if (!this.started) return
      // a cut network: close now (the server notices by its heartbeat); reconnect when the browser is back online
      const ws = this.ws
      this.ws = null
      this.hello = null
      if (ws) {
        ws.onclose = null
        try {
          ws.close(4000, 'offline')
        } catch { /* ignore */ }
      }
      for (const [id, fn] of this.pending) {
        this.pending.delete(id)
        fn({ t: 'error', id, code: 'unavailable', message: 'The connection closed.' })
      }
      this.clear(this.timer)
      this.timer = null
      this.setStatus('degraded', 'You are offline.')
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') this.reconnectNow()
    }
    this.offline = typeof navigator !== 'undefined' && navigator.onLine === false
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVisible)
    this.cleanup = () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }
}
