/**
 * Chat's own connection to the live hub (pure TypeScript, no React; protocol v1 of docs/dev/live.md and the chat
 * topics of docs/dev/chat.md).
 *
 * Why its own socket and not platform.live: the page's LiveClient (src/platform/live.ts) routes only table, presence,
 * env, app and user messages to topic handlers; `chat`, `typing`, `unsubscribed` and the `subscribed` answer's seq reach
 * no handler of LiveApi, and an environment switch drops every topic (resetTopics). Chat is install-wide and needs all
 * of these, so it speaks the same documented protocol on a second socket of the same page (same cookie, same origin
 * checks on the server; one more of the 20 sockets a person may hold).
 *
 * - Reconnects with backoff and jitter (1 s .. 30 s; 30 s after a "limit" close); at once when the tab becomes visible
 *   or the browser comes back online; never while the browser says it is offline (the socket is closed then, so a cut
 *   network shows as "offline" at once instead of after the heartbeat).
 * - Every topic is subscribed again after a reconnect; handlers get the `subscribed` answer (with the conversation's
 *   seq), so the store can compare it with what it applied and fetch /changes when they differ.
 * - 4401 / 4403 (signed out, password change): stops and tells the owner; no reconnect loop.
 */
import { LIVE_CLOSE, LIVE_PATH, type ServerMessage } from '@/platform/live-protocol'
import { backoffMs } from '@/platform/live'

export type SocketState = 'off' | 'connecting' | 'open' | 'offline'

/** what a topic handler gets: the server's messages for it, and `hello` after every (re)connect */
export type TopicMessage = ServerMessage

export interface SocketLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code: number; reason: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export interface ChatSocketOptions {
  url?: string
  createSocket?: (url: string) => SocketLike
  random?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  /** the socket was closed because the session ended (4401) or needs a password change (4403) */
  onSessionEnd?: (code: number) => void
  /** listen to online/offline and visibility (default: in a browser) */
  watch?: boolean
}

interface Topic { topic: string; env?: string; handlers: Set<(m: TopicMessage) => void>; subId: string | null }

const OPEN = 1
const keyOf = (topic: string, env?: string) => `${env ?? ''}\u0001${topic}`

export function chatSocketUrl(): string {
  const loc = (globalThis as { location?: Location }).location
  if (!loc || !loc.host) return ''
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}${LIVE_PATH}`
}

export class ChatSocket {
  private o: Required<Omit<ChatSocketOptions, 'url' | 'onSessionEnd'>> & Pick<ChatSocketOptions, 'onSessionEnd'>
  private url: string
  private ws: SocketLike | null = null
  private started = false
  private attempt = 0
  private timer: unknown = null
  private topics = new Map<string, Topic>()
  private bySub = new Map<string, string>()
  private stateListeners = new Set<(s: SocketState) => void>()
  private _state: SocketState = 'off'
  private conn: string | null = null
  private epoch: string | null = null
  private n = 0
  private offline = false
  private unwatch: (() => void) | null = null

  constructor(opts: ChatSocketOptions = {}) {
    this.url = opts.url ?? chatSocketUrl()
    const WS = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket
    this.o = {
      createSocket: opts.createSocket ?? ((u) => {
        if (!WS) throw new Error('WebSocket is not available')
        return new WS(u)
      }),
      random: opts.random ?? Math.random,
      setTimer: opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)),
      onSessionEnd: opts.onSessionEnd,
      watch: opts.watch ?? (typeof window !== 'undefined' && typeof document !== 'undefined'),
    }
  }

  state(): SocketState {
    return this._state
  }
  onState(fn: (s: SocketState) => void): () => void {
    this.stateListeners.add(fn)
    return () => { this.stateListeners.delete(fn) }
  }
  /** this socket's id on the server (X-Appbuilder-Live on writes marks our own pushes `self`) */
  connectionId(): string | null {
    return this.conn
  }
  /** the server's epoch of the current connection */
  serverEpoch(): string | null {
    return this.epoch
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.attempt = 0
    if (this.o.watch && !this.unwatch) this.watch()
    this.connect()
  }

  stop(): void {
    this.started = false
    if (this.timer !== null) this.o.clearTimer(this.timer)
    this.timer = null
    const ws = this.ws
    this.ws = null
    this.conn = null
    if (ws) {
      ws.onclose = null
      try { ws.close(1000, 'chat closed') } catch { /* ignore */ }
    }
    this.unwatch?.()
    this.unwatch = null
    this.setState('off')
  }

  /** test and exit-check hook: drop the connection as a network cut would (it reconnects as usual) */
  drop(): void {
    const ws = this.ws
    if (!ws) return
    try { ws.close(4000, 'dropped') } catch { /* ignore */ }
  }

  /** subscribe a handler to a topic (env only for environment-bound topics such as table:<id>) */
  subscribe(topic: string, handler: (m: TopicMessage) => void, env?: string): () => void {
    const key = keyOf(topic, env)
    let t = this.topics.get(key)
    if (!t) {
      t = { topic, env, handlers: new Set(), subId: null }
      this.topics.set(key, t)
      this.sendSub(t)
    }
    t.handlers.add(handler)
    return () => {
      const cur = this.topics.get(key)
      if (!cur) return
      cur.handlers.delete(handler)
      if (cur.handlers.size) return
      this.topics.delete(key)
      if (cur.subId) this.bySub.delete(cur.subId)
      this.raw({ t: 'unsub', topic, ...(env ? { env } : {}) })
    }
  }

  has(topic: string, env?: string): boolean {
    return this.topics.has(keyOf(topic, env))
  }

  /* -------------------------------------------------------------- internals */

  private setState(s: SocketState) {
    if (this._state === s) return
    this._state = s
    for (const l of [...this.stateListeners]) {
      try { l(s) } catch { /* ignore */ }
    }
  }

  private raw(m: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== OPEN || !this.conn) return false
    try {
      this.ws.send(JSON.stringify(m))
      return true
    } catch {
      return false
    }
  }

  private sendSub(t: Topic) {
    if (t.subId) this.bySub.delete(t.subId)
    t.subId = `cs${++this.n}`
    this.bySub.set(t.subId, keyOf(t.topic, t.env))
    this.raw({ t: 'sub', id: t.subId, topic: t.topic, ...(t.env ? { env: t.env } : {}) })
  }

  private connect() {
    if (!this.started) return
    if (!this.url) return this.setState('off')
    if (this.offline) return this.setState('offline')
    this.setState('connecting')
    let ws: SocketLike
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
      this.conn = null
      if (!this.started) return
      if (ev.code === LIVE_CLOSE.unauthenticated || ev.code === LIVE_CLOSE.passwordChange) {
        this.stop()
        this.o.onSessionEnd?.(ev.code)
        return
      }
      if (this.offline) return this.setState('offline')
      this.retry(ev.code === LIVE_CLOSE.limit ? 30_000 : 0)
    }
  }

  private retry(minMs = 0) {
    if (!this.started) return
    if (this.timer !== null) this.o.clearTimer(this.timer)
    this.setState('connecting')
    const ms = backoffMs(this.attempt++, this.o.random, minMs)
    this.timer = this.o.setTimer(() => {
      this.timer = null
      this.connect()
    }, ms)
  }

  /** reconnect now (visible again, back online) */
  reconnectNow(): void {
    if (!this.started || this.ws) return
    if (this.timer !== null) this.o.clearTimer(this.timer)
    this.timer = null
    this.attempt = 0
    this.connect()
  }

  private deliver(t: Topic | undefined, m: TopicMessage) {
    if (!t) return
    for (const h of [...t.handlers]) {
      try { h(m) } catch (e) { console.error('[chat] handler failed', e) }
    }
  }

  private onData(data: unknown) {
    let m: ServerMessage
    try {
      m = JSON.parse(String(data)) as ServerMessage
    } catch {
      return
    }
    if (!m || typeof m !== 'object' || typeof (m as { t?: unknown }).t !== 'string') return
    if (m.t === 'hello') {
      this.conn = m.connection
      this.epoch = m.epoch
      this.attempt = 0
      this.setState('open')
      for (const t of this.topics.values()) {
        this.sendSub(t)
        this.deliver(t, m)
      }
      return
    }
    // answers to our subscriptions (by id), and messages about a topic
    if ((m.t === 'subscribed' || m.t === 'unsubscribed' || m.t === 'error') && m.id && this.bySub.has(m.id)) {
      const key = this.bySub.get(m.id)!
      const t = this.topics.get(key)
      if (m.t !== 'subscribed') {
        // the server refused or ended it: forget the id, keep the handlers (they decide)
        this.bySub.delete(m.id)
        if (t) t.subId = null
      }
      this.deliver(t, m)
      return
    }
    if (m.t === 'unsubscribed') {
      // ended by the server (removed from the conversation): no id
      for (const [key, t] of this.topics) if (t.topic === m.topic && (!m.env || key === keyOf(m.topic, m.env))) {
        if (t.subId) this.bySub.delete(t.subId)
        t.subId = null
        this.deliver(t, m)
      }
      return
    }
    if (m.t === 'resync') {
      for (const t of this.topics.values()) this.deliver(t, m)
      return
    }
    const topic = (m as { topic?: unknown }).topic
    if (typeof topic !== 'string') return
    const env = (m as { env?: unknown }).env
    this.deliver(this.topics.get(keyOf(topic, typeof env === 'string' && m.t === 'table' ? env : undefined)), m)
  }

  private watch() {
    const onOnline = () => {
      this.offline = false
      this.reconnectNow()
    }
    const onOffline = () => {
      this.offline = true
      if (!this.started) return
      // a cut network: close now (the server notices by its heartbeat); reconnect when it is back
      const ws = this.ws
      this.ws = null
      this.conn = null
      if (ws) {
        ws.onclose = null
        try { ws.close(4000, 'offline') } catch { /* ignore */ }
      }
      if (this.timer !== null) this.o.clearTimer(this.timer)
      this.timer = null
      this.setState('offline')
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') this.reconnectNow()
    }
    this.offline = typeof navigator !== 'undefined' && navigator.onLine === false
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVisible)
    this.unwatch = () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }
}
