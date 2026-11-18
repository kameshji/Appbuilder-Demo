/**
 * Realtime hub (P0 package H, docs/dev/live.md): the WebSocket endpoint /api/v1/live on the same HTTP server.
 *
 * - Upgrade: same Host/Origin allow-list as HTTP (DNS rebinding), an Origin header is REQUIRED and must be this origin
 *   (browsers always send it on WebSocket handshakes; this is the CSRF-equivalent check: cross-site WebSocket hijacking
 *   needs a foreign page, whose Origin is foreign), then the session cookie (SameSite=Strict, HttpOnly). No session:
 *   closed with 4401; a session that must change its password: 4403.
 * - Limits: connections per user and in total, subscriptions per connection, inbound message size (ws maxPayload) and
 *   rate (token bucket), outbound buffer (slow consumers get `resync` and close 4408, never unbounded buffering),
 *   ping/pong heartbeat (a socket missing one pong is terminated).
 * - Every subscription names its environment and is checked against the user's access there (userContextFor). Security
 *   contexts are cached per connection and environment for a few seconds and dropped on every security change.
 * - Session revocation (logout, password change, disable, delete, admin reset) closes the user's sockets at once
 *   (session-events.ts); a sweep re-checks every socket's session once a minute.
 * - Table pushes follow the leak rule (tableMessageFor): readers only, visible column names only, row ids only for
 *   subscribers whose read access covers every row.
 *
 * Single process: all state is in memory (see docs/dev/live.md, "Scaling limits").
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import type { RawData } from 'ws'
import { HttpError } from '../contracts.ts'
import type { TableDef } from '../../../src/platform/contracts.ts'
import type { UserContext } from '../contracts.ts'
import type {
  ClientMessage, LiveErrorCode, PresenceMember, PresenceMessage, PresenceState, ServerMessage, SessionEndReason, TableMessage,
  UserEvent,
} from '../../../src/platform/live-protocol.ts'
import {
  LIVE_CLOSE, LIVE_LIMITS, LIVE_PATH, LIVE_PROTOCOL_VERSION, parsePresenceScope, parseTopic, presenceTopic, userTopic,
} from '../../../src/platform/live-protocol.ts'
import { SESSION_COOKIE } from '../../../src/platform/http.ts'
import { cookieValue, originProblem } from '../router.ts'
import type { CoreServices } from '../services.ts'
import { hashToken, toUserDef, userContextFor } from '../auth.ts'
import { allColumns } from '../data.ts'
import { hasAnyTableAccess } from '../security.ts'
import { runInEnvironment } from '../env-context.ts'
import { onTableChange } from './changes.ts'
import type { TableChange } from './changes.ts'
import { onSessionEvent } from './session-events.ts'
import { errText, log } from '../util.ts'

export interface LiveLimits {
  maxMessageBytes: number
  maxSubscriptions: number
  maxConnectionsPerUser: number
  maxConnections: number
  maxBufferedBytes: number
  inboundBurst: number
  inboundPerSecond: number
  heartbeatMs: number
  maxRowIds: number
  /** how long a security context is reused (ms) */
  contextTtlMs: number
  /** how long a Studio lock outlives its holder's socket (a reload keeps it) */
  lockGraceMs: number
  /** session re-check interval (ms) */
  sessionSweepMs: number
}

export function liveLimits(env: NodeJS.ProcessEnv = process.env, over: Partial<LiveLimits> = {}): LiveLimits {
  const n = (v: string | undefined, d: number, min: number) => {
    const x = Number(v)
    return Number.isFinite(x) && x >= min ? Math.floor(x) : d
  }
  return {
    ...LIVE_LIMITS,
    maxConnections: n(env.APPBUILDER_LIVE_MAX_CONNECTIONS, LIVE_LIMITS.maxConnections, 1),
    maxConnectionsPerUser: n(env.APPBUILDER_LIVE_MAX_PER_USER, LIVE_LIMITS.maxConnectionsPerUser, 1),
    contextTtlMs: 10_000,
    lockGraceMs: 10_000,
    sessionSweepMs: 60_000,
    ...over,
  }
}

/** who changed what, for app / env messages */
export interface LiveActor { id: string; name: string }

export interface LiveHub {
  /** true when the URL is the live endpoint (the caller then hands the upgrade to handleUpgrade) */
  isLiveRequest(req: IncomingMessage): boolean
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
  /** a user's own topic (notifications, unread counts); install-wide */
  pushUser(userId: string, ev: UserEvent): void
  /** environment state / metadata / security changed */
  emitEnv(env: string, kind: 'metadata' | 'security' | 'state' | 'deleted', extra?: { locked?: boolean; restoring?: boolean; by?: LiveActor; origin?: string }): void
  /** an app definition changed */
  emitApp(env: string, appId: string, kind: 'saved' | 'renamed' | 'deleted', by: LiveActor, extra?: { modifiedOn?: string; origin?: string }): void
  /** user ids with at least one open socket (install-wide), minus users hiding their presence */
  onlineUsers(): string[]
  /** a user's notification settings changed (hidden presence is honoured from now on) */
  setHidden(userId: string, hidden: boolean): void
  stats(): { connections: number; users: number; subscriptions: number; sent: number; dropped: number; slowClosed: number }
  close(): Promise<void>
}

/* ------------------------------------------------------------------ the leak rule (pure, unit-tested) */

/**
 * The table message a subscriber may receive for a change, or null when they may not learn anything about it.
 *  - no read privilege on the table (read predicate false): null (no message at all);
 *  - columns: the changed column names whose access for this subscriber is not 'none' (id never listed);
 *  - rows: the row ids only when the subscriber's read predicate is unconditionally true (every row; admins, or a role
 *    with scope "all" and no row filter) and there are at most maxRowIds; otherwise null ("table changed" tick: the
 *    client refetches through the secured query path). Per-row visibility is never evaluated here: that would cost a
 *    query per subscriber per write, and a tick plus refetch is safe;
 *  - by: the actor, only together with row ids.
 */
export function tableMessageFor(
  ctx: UserContext, def: TableDef, env: string, change: TableChange, seq: number, prev: number, maxRowIds: number, at: string,
): TableMessage | null {
  const read = ctx.rowPredicate(def, 'read')
  if ('const' in read && !read.const) return null
  if (!ctx.privileges.isAdmin && !hasAnyTableAccess(ctx, def)) return null
  const known = new Set(allColumns(def).map((c) => c.name))
  const columns = [...new Set(change.changedColumns)].filter((c) => c !== 'id' && known.has(c) && ctx.columnAccess(def, c) !== 'none')
  const unrestricted = 'const' in read && read.const === true
  const rows = unrestricted && change.rowIds.length > 0 && change.rowIds.length <= maxRowIds ? [...change.rowIds] : null
  const msg: TableMessage = { t: 'table', env, topic: `table:${def.id}`, table: def.id, seq, prev, op: change.op, rows, columns, at }
  if (rows && change.actor) msg.by = { id: change.actor.id, name: change.actor.name }
  return msg
}

/* ------------------------------------------------------------------ connection state */

interface Conn {
  id: string
  ws: WebSocket
  userId: string
  name: string
  sessionHash: string
  /** subscription keys: `${env}\u0001${topic}` (user topics: env '') */
  subs: Set<string>
  /** presence keys this connection published: `${env}\u0001${scope}` */
  presence: Set<string>
  ctx: Map<string, { ctx: Promise<UserContext>; at: number }>
  alive: boolean
  tokens: number
  refillAt: number
  strikes: number
  chain: Promise<void>
  closed: boolean
}

interface PresenceEntry { conn: Conn; state: PresenceState; since: string }
interface LockEntry { connId: string | null; userId: string; name: string; since: string; graceTimer: NodeJS.Timeout | null }

const K = (env: string, topic: string) => `${env}\u0001${topic}`
const splitKey = (k: string): [string, string] => {
  const i = k.indexOf('\u0001')
  return [k.slice(0, i), k.slice(i + 1)]
}

/** HttpError -> protocol error code */
function codeOf(e: unknown): LiveErrorCode {
  if (e instanceof HttpError) {
    if (e.status === 404) return 'not-found'
    if (e.status === 403) return e.code === 'password_change_required' ? 'password_change_required' : 'denied'
    if (e.status === 503) return 'unavailable'
    if (e.status === 429) return 'limit'
    return 'invalid'
  }
  return 'unavailable'
}

export interface LiveHubOptions {
  allowAnyHost?: boolean
  allowedHosts?: readonly string[]
  limits?: Partial<LiveLimits>
  env?: NodeJS.ProcessEnv
}

export function createLiveHub(services: CoreServices, opts: LiveHubOptions = {}): LiveHub {
  const limits = liveLimits(opts.env ?? process.env, opts.limits)
  const allowedHosts = opts.allowedHosts ?? services.config.allowedHosts ?? ['localhost', '127.0.0.1', '::1']
  const epoch = randomBytes(6).toString('hex')
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxMessageBytes, perMessageDeflate: false, clientTracking: false })
  const conns = new Map<string, Conn>()
  const byUser = new Map<string, Set<Conn>>()
  const topics = new Map<string, Set<Conn>>()
  const presence = new Map<string, Map<string, PresenceEntry>>()
  const locks = new Map<string, LockEntry>()
  const hidden = new Set<string>()
  const hiddenLoaded = new Set<string>()
  /** environment sequence and the last seq per table */
  const envSeq = new Map<string, number>()
  const lastSeq = new Map<string, number>()
  let sent = 0
  let dropped = 0
  let slowClosed = 0
  let closing = false

  /* -------------------------------------------------------------- sending */

  function send(c: Conn, msg: ServerMessage): void {
    if (c.closed || c.ws.readyState !== WebSocket.OPEN) return
    if (c.ws.bufferedAmount > limits.maxBufferedBytes) {
      // a slow consumer: never buffer without bound. Tell it to resync (best effort) and close.
      dropped++
      slowClose(c)
      return
    }
    try {
      c.ws.send(JSON.stringify(msg))
      sent++
    } catch {
      dropped++
    }
  }

  function slowClose(c: Conn): void {
    if (c.closed) return
    slowClosed++
    try {
      c.ws.send(JSON.stringify({ t: 'resync', reason: 'The connection could not keep up; reconnect and reload.' } satisfies ServerMessage))
    } catch { /* ignore */ }
    closeConn(c, LIVE_CLOSE.slowConsumer, 'slow consumer')
    // a client that does not read its socket does not complete the close handshake either
    setTimeout(() => {
      if (c.ws.readyState !== WebSocket.CLOSED) c.ws.terminate()
    }, 2000).unref()
  }

  /** runs per-connection work in order (acks and pushes keep their order) */
  function enqueue(c: Conn, fn: () => Promise<void> | void): void {
    c.chain = c.chain.then(async () => {
      if (c.closed) return
      try {
        await fn()
      } catch (e) {
        log('warn', `live: ${errText(e)}`)
      }
    })
  }

  function closeConn(c: Conn, code: number, reason: string): void {
    if (!c.closed) {
      c.closed = true
      cleanup(c)
    }
    try {
      c.ws.close(code, reason.slice(0, 120))
    } catch {
      c.ws.terminate()
    }
  }

  /* -------------------------------------------------------------- security contexts */

  function ctxFor(c: Conn, env: string): Promise<UserContext> {
    const now = Date.now()
    const hit = c.ctx.get(env)
    if (hit && now - hit.at < limits.contextTtlMs) return hit.ctx
    const p = (async () => {
      const rec = await services.meta.users.get(c.userId)
      if (!rec || rec.status === 'disabled') {
        endUser(c.userId, rec ? 'disabled' : 'removed')
        throw new HttpError(401, 'unauthenticated', 'Please sign in.')
      }
      if (rec.mustChangePassword) throw new HttpError(403, 'password_change_required', 'You must change your password before you can continue.')
      return userContextFor(services, rec, env)
    })()
    c.ctx.set(env, { ctx: p, at: now })
    p.catch(() => {
      if (c.ctx.get(env)?.ctx === p) c.ctx.delete(env)
    })
    return p
  }

  // every role / user / table change drops the cached contexts (and re-checks subscriptions)
  const invalidateSecurity = services.security.invalidate
  let recheckTimer: NodeJS.Timeout | null = null
  services.security.invalidate = (scope) => {
    invalidateSecurity(scope)
    for (const c of conns.values()) c.ctx.clear()
    if (!recheckTimer && conns.size) {
      recheckTimer = setTimeout(() => {
        recheckTimer = null
        for (const c of conns.values()) enqueue(c, () => recheck(c))
      }, 250)
      recheckTimer.unref()
    }
  }

  /** drop subscriptions the user is no longer allowed */
  async function recheck(c: Conn): Promise<void> {
    for (const key of [...c.subs]) {
      const [env, topic] = splitKey(key)
      if (!env) continue
      try {
        await authorize(c, env, topic)
      } catch (e) {
        unsubscribeKey(c, key)
        send(c, { t: 'unsubscribed', topic, env })
        send(c, { t: 'error', code: codeOf(e), message: 'You no longer have access to this.', topic })
      }
    }
  }

  /** throws when the connection may not subscribe to / publish on this topic in env */
  async function authorize(c: Conn, env: string, topic: string): Promise<{ ctx: UserContext; table?: TableDef }> {
    const p = parseTopic(topic)
    if (!p || p.kind === 'user') throw new HttpError(422, 'invalid', 'Unknown topic.')
    const ctx = await ctxFor(c, env)
    if (p.kind === 'env') return { ctx }
    if (p.kind === 'app') {
      if (!ctx.privileges.isMaker && !ctx.canRunApp(p.app)) throw new HttpError(404, 'not-found', 'App not found.')
      return { ctx }
    }
    if (p.kind === 'table') return { ctx, table: await readableTable(ctx, env, p.table) }
    const scope = parsePresenceScope(p.scope)!
    if (scope.kind === 'app') {
      if (!ctx.privileges.isMaker && !ctx.canRunApp(scope.app)) throw new HttpError(404, 'not-found', 'App not found.')
    } else if (scope.kind === 'studio') {
      if (!ctx.privileges.isMaker) throw new HttpError(403, 'denied', 'Only makers can open the Studio.')
    } else if (scope.kind === 'record') {
      await readableTable(ctx, env, scope.table)
    } else if (scope.kind === 'online') {
      if (!ctx.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only administrators can see who is online.')
    }
    return { ctx }
  }

  async function readableTable(ctx: UserContext, env: string, idOrName: string): Promise<TableDef> {
    const t = await runInEnvironment(env, () => services.meta.tables.get(idOrName))
    if (!t || (!ctx.privileges.isMaker && !hasAnyTableAccess(ctx, t))) throw new HttpError(404, 'not-found', 'Table not found.')
    const read = ctx.rowPredicate(t, 'read')
    if ('const' in read && !read.const) throw new HttpError(403, 'denied', 'You may not read this table.')
    return t
  }

  /* -------------------------------------------------------------- subscriptions */

  function subscribeKey(c: Conn, key: string): void {
    c.subs.add(key)
    let set = topics.get(key)
    if (!set) topics.set(key, (set = new Set()))
    set.add(c)
  }
  function unsubscribeKey(c: Conn, key: string): void {
    c.subs.delete(key)
    const set = topics.get(key)
    if (set) {
      set.delete(c)
      if (!set.size) topics.delete(key)
    }
  }

  async function onSub(c: Conn, m: { id?: string; topic: string; env?: string }): Promise<void> {
    const p = parseTopic(m.topic)
    if (!p) return send(c, { t: 'error', id: m.id, code: 'invalid', message: 'Unknown topic.', topic: m.topic })
    if (p.kind === 'user') {
      if (p.user !== c.userId) return send(c, { t: 'error', id: m.id, code: 'denied', message: 'You can only subscribe to your own user topic.', topic: m.topic })
      const key = K('', m.topic)
      if (!c.subs.has(key) && c.subs.size >= limits.maxSubscriptions) return send(c, { t: 'error', id: m.id, code: 'limit', message: 'Too many subscriptions.', topic: m.topic })
      subscribeKey(c, key)
      return send(c, { t: 'subscribed', id: m.id, topic: m.topic, epoch })
    }
    const env = typeof m.env === 'string' ? m.env : ''
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(env)) return send(c, { t: 'error', id: m.id, code: 'invalid', message: 'The subscription must name its environment.', topic: m.topic })
    const key = K(env, m.topic)
    if (!c.subs.has(key) && c.subs.size >= limits.maxSubscriptions) return send(c, { t: 'error', id: m.id, code: 'limit', message: 'Too many subscriptions.', topic: m.topic })
    let auth: { ctx: UserContext; table?: TableDef }
    try {
      auth = await authorize(c, env, m.topic)
    } catch (e) {
      return send(c, { t: 'error', id: m.id, code: codeOf(e), message: e instanceof HttpError ? e.message : 'Not available.', topic: m.topic })
    }
    subscribeKey(c, key)
    const seq = p.kind === 'table' ? (lastSeq.get(K(env, auth.table!.id)) ?? 0) : undefined
    send(c, { t: 'subscribed', id: m.id, topic: m.topic, env, ...(seq !== undefined ? { seq } : {}), epoch })
    if (p.kind === 'presence') await sendPresence(c, env, p.scope)
  }

  function onUnsub(c: Conn, m: { id?: string; topic: string; env?: string }): void {
    const p = parseTopic(m.topic)
    const key = K(p?.kind === 'user' ? '' : (m.env ?? ''), m.topic)
    unsubscribeKey(c, key)
    send(c, { t: 'unsubscribed', id: m.id, topic: m.topic, ...(m.env ? { env: m.env } : {}) })
  }

  /* -------------------------------------------------------------- presence and Studio locks */

  function membersOf(env: string, scope: string, viewer: string): PresenceMember[] {
    const entries = presence.get(K(env, scope))
    const byUser = new Map<string, PresenceMember>()
    for (const e of entries?.values() ?? []) {
      if (hidden.has(e.conn.userId) && e.conn.userId !== viewer) continue
      const prev = byUser.get(e.conn.userId)
      if (!prev) byUser.set(e.conn.userId, { id: e.conn.userId, name: e.conn.name, state: e.state, since: e.since })
      else {
        if (e.state === 'editing') prev.state = 'editing'
        if (e.since < prev.since) prev.since = e.since
      }
    }
    return [...byUser.values()].sort((a, b) => a.since.localeCompare(b.since))
  }

  const onlineCache = new Map<string, { at: number; ids: Promise<Set<string> | null> }>()
  /** users that may enter env (null: everyone, e.g. while the registry is unavailable) */
  function accessSet(env: string): Promise<Set<string> | null> {
    const hit = onlineCache.get(env)
    if (hit && Date.now() - hit.at < 30_000) return hit.ids
    const ids = (async () => {
      try {
        const [rows, users] = await Promise.all([services.install.access.forEnvironment(env), services.meta.users.list()])
        const s = new Set(rows.map((r) => r.userId))
        for (const u of users) if (u.isInstallAdmin) s.add(u.id)
        return s
      } catch {
        return null
      }
    })()
    onlineCache.set(env, { at: Date.now(), ids })
    return ids
  }

  async function presenceMessage(c: Conn, env: string, scope: string): Promise<PresenceMessage> {
    let members: PresenceMember[]
    if (scope === 'online') {
      const allowed = await accessSet(env)
      members = []
      for (const [uid, set] of byUser) {
        if (hidden.has(uid) && uid !== c.userId) continue
        if (allowed && !allowed.has(uid)) continue
        const first = [...set][0]
        if (first) members.push({ id: uid, name: first.name, state: 'viewing', since: '' })
      }
    } else members = membersOf(env, scope, c.userId)
    const msg: PresenceMessage = { t: 'presence', env, topic: presenceTopic(scope), scope, members }
    if (scope.startsWith('studio:')) {
      const l = locks.get(K(env, scope))
      if (!l) msg.lock = { holder: null, mine: false }
      else {
        const isHidden = hidden.has(l.userId) && l.userId !== c.userId
        msg.lock = { holder: isHidden ? { id: '', name: 'Another maker' } : { id: l.userId, name: l.name }, mine: l.connId === c.id, ...(isHidden ? { hidden: true } : {}) }
      }
    }
    return msg
  }

  async function sendPresence(c: Conn, env: string, scope: string): Promise<void> {
    send(c, await presenceMessage(c, env, scope))
  }

  function broadcastPresence(env: string, scope: string): void {
    const subs = topics.get(K(env, presenceTopic(scope)))
    if (!subs) return
    for (const c of subs) enqueue(c, () => sendPresence(c, env, scope))
  }

  /** online changes go to every environment's presence:online subscribers (debounced) */
  let onlineTimer: NodeJS.Timeout | null = null
  function onlineChanged(): void {
    if (onlineTimer) return
    onlineTimer = setTimeout(() => {
      onlineTimer = null
      for (const key of topics.keys()) {
        const [env, topic] = splitKey(key)
        if (env && topic === presenceTopic('online')) broadcastPresence(env, 'online')
      }
    }, 300)
    onlineTimer.unref()
  }

  async function onPresence(c: Conn, m: { id?: string; scope: string; env: string; state: PresenceState | null }): Promise<void> {
    const scope = parsePresenceScope(m.scope)
    if (!scope || scope.kind === 'online' || (m.state !== null && m.state !== 'viewing' && m.state !== 'editing')) {
      return send(c, { t: 'error', id: m.id, code: 'invalid', message: 'Invalid presence.' })
    }
    const env = typeof m.env === 'string' ? m.env : ''
    const key = K(env, m.scope)
    if (m.state === null) {
      leavePresence(c, key)
      return
    }
    try {
      await authorize(c, env, presenceTopic(m.scope))
    } catch (e) {
      return send(c, { t: 'error', id: m.id, code: codeOf(e), message: e instanceof HttpError ? e.message : 'Not available.' })
    }
    if (!c.presence.has(key) && c.presence.size >= limits.maxSubscriptions) return send(c, { t: 'error', id: m.id, code: 'limit', message: 'Too many presence scopes.' })
    let map = presence.get(key)
    if (!map) presence.set(key, (map = new Map()))
    const prev = map.get(c.id)
    map.set(c.id, { conn: c, state: m.state, since: prev?.since ?? new Date().toISOString() })
    c.presence.add(key)
    if (!prev || prev.state !== m.state) broadcastPresence(env, m.scope)
  }

  function leavePresence(c: Conn, key: string): void {
    const map = presence.get(key)
    c.presence.delete(key)
    if (!map?.delete(c.id)) return
    if (!map.size) presence.delete(key)
    const [env, scope] = splitKey(key)
    broadcastPresence(env, scope)
  }

  async function onLock(c: Conn, m: { id?: string; scope: string; env: string; action: 'acquire' | 'release' | 'takeover' }): Promise<void> {
    const scope = parsePresenceScope(m.scope)
    if (!scope || scope.kind !== 'studio' || !['acquire', 'release', 'takeover'].includes(m.action)) {
      return send(c, { t: 'error', id: m.id, code: 'invalid', message: 'Invalid lock request.' })
    }
    const env = typeof m.env === 'string' ? m.env : ''
    try {
      await authorize(c, env, presenceTopic(m.scope))
    } catch (e) {
      return send(c, { t: 'error', id: m.id, code: codeOf(e), message: e instanceof HttpError ? e.message : 'Not available.' })
    }
    const key = K(env, m.scope)
    const cur = locks.get(key)
    const reply = (ok: boolean, message?: string) => {
      const l = locks.get(key)
      const isHidden = !!l && hidden.has(l.userId) && l.userId !== c.userId
      send(c, { t: 'lock', id: m.id, scope: m.scope, env, ok, holder: l ? (isHidden ? { id: '', name: 'Another maker' } : { id: l.userId, name: l.name }) : null, mine: !!l && l.connId === c.id, ...(message ? { message } : {}) })
    }
    if (m.action === 'release') {
      if (cur && cur.connId === c.id) dropLock(key)
      reply(true)
      broadcastPresence(env, m.scope)
      return
    }
    // free, ours already, or a lock whose holder left (grace) and that belongs to this user: take it
    const free = !cur || cur.connId === c.id || (cur.connId === null && cur.userId === c.userId)
    if (free || m.action === 'takeover') {
      const previous = cur && cur.connId && cur.connId !== c.id ? conns.get(cur.connId) : undefined
      if (cur?.graceTimer) clearTimeout(cur.graceTimer)
      locks.set(key, { connId: c.id, userId: c.userId, name: c.name, since: new Date().toISOString(), graceTimer: null })
      reply(true)
      if (previous) send(previous, { t: 'lock', scope: m.scope, env, ok: false, holder: hidden.has(c.userId) && previous.userId !== c.userId ? { id: '', name: 'Another maker' } : { id: c.userId, name: c.name }, mine: false, message: `${hidden.has(c.userId) ? 'Another maker' : c.name} took over editing.` })
      broadcastPresence(env, m.scope)
      return
    }
    reply(false, 'Someone else is editing this app.')
  }

  function dropLock(key: string): void {
    const l = locks.get(key)
    if (l?.graceTimer) clearTimeout(l.graceTimer)
    locks.delete(key)
  }

  /* -------------------------------------------------------------- connection lifecycle */

  function cleanup(c: Conn): void {
    conns.delete(c.id)
    const set = byUser.get(c.userId)
    set?.delete(c)
    const wentOffline = !!set && set.size === 0
    if (wentOffline) byUser.delete(c.userId)
    for (const key of [...c.subs]) unsubscribeKey(c, key)
    for (const key of [...c.presence]) leavePresence(c, key)
    for (const [key, l] of locks) {
      if (l.connId !== c.id) continue
      // keep it for a short grace (a reload of the Studio keeps the lock), then free it
      l.connId = null
      const [env, scope] = splitKey(key)
      l.graceTimer = setTimeout(() => {
        if (locks.get(key) === l && l.connId === null) {
          locks.delete(key)
          broadcastPresence(env, scope)
        }
      }, limits.lockGraceMs)
      l.graceTimer.unref()
    }
    if (wentOffline) onlineChanged()
  }

  /** every socket of a user ends now (session revoked, account disabled or deleted) */
  function endUser(userId: string, reason: SessionEndReason, onlyHash?: string): void {
    for (const c of [...(byUser.get(userId) ?? [])]) {
      if (onlyHash && c.sessionHash !== onlyHash) continue
      if (c.subs.has(K('', userTopic(userId)))) send(c, { t: 'user', topic: userTopic(userId), event: 'session', reason })
      closeConn(c, LIVE_CLOSE.unauthenticated, reason)
    }
  }

  const offSession = onSessionEvent((e) => {
    if (e.kind === 'rotated') {
      for (const c of conns.values()) if (c.sessionHash === e.from) c.sessionHash = e.to
      return
    }
    if (e.kind === 'session') {
      for (const c of [...conns.values()]) if (c.sessionHash === e.idHash) endUser(c.userId, 'signed_out', e.idHash)
      return
    }
    if (e.reason === 'removed') return endUser(e.userId, 'removed')
    if (!byUser.has(e.userId)) return
    // why: look at the account (disabled, must change password, or a plain sign-out of every device)
    void (async () => {
      let reason: SessionEndReason = 'signed_out'
      try {
        const u = await services.meta.users.get(e.userId)
        reason = !u ? 'removed' : u.status === 'disabled' ? 'disabled' : u.mustChangePassword ? 'password_change_required' : 'password_changed'
      } catch { /* the database is gone: still end them */ }
      // a session created after the removal (the password changer's own new cookie) is not on these sockets
      endUser(e.userId, reason)
    })()
  })

  /** belt and braces: a session that expired or vanished without an event (another process, direct SQL) */
  const sweep = setInterval(() => {
    for (const c of [...conns.values()]) {
      enqueue(c, async () => {
        try {
          const s = await services.meta.sessions.get(c.sessionHash)
          if (!s || s.expiresOn.getTime() <= Date.now()) endUser(c.userId, 'expired', c.sessionHash)
        } catch { /* database unreachable: keep the socket */ }
      })
    }
  }, limits.sessionSweepMs)
  sweep.unref()

  const heartbeat = setInterval(() => {
    for (const c of [...conns.values()]) {
      if (!c.alive) {
        c.closed = true
        cleanup(c)
        c.ws.terminate()
        continue
      }
      c.alive = false
      try {
        c.ws.ping()
      } catch { /* closed */ }
    }
  }, limits.heartbeatMs)
  heartbeat.unref()

  /** inbound token bucket; true when the message may be handled */
  function admit(c: Conn): boolean {
    const now = Date.now()
    c.tokens = Math.min(limits.inboundBurst, c.tokens + ((now - c.refillAt) / 1000) * limits.inboundPerSecond)
    c.refillAt = now
    if (c.tokens >= 1) {
      c.tokens -= 1
      return true
    }
    c.strikes++
    if (c.strikes > limits.inboundBurst) closeConn(c, LIVE_CLOSE.limit, 'too many messages')
    else send(c, { t: 'error', code: 'limit', message: 'Too many messages; slow down.' })
    return false
  }

  function onMessage(c: Conn, data: RawData, isBinary: boolean): void {
    if (isBinary) return closeConn(c, LIVE_CLOSE.protocol, 'binary frames are not supported')
    if (!admit(c)) return
    let m: ClientMessage
    try {
      m = JSON.parse(data.toString()) as ClientMessage
    } catch {
      return closeConn(c, LIVE_CLOSE.protocol, 'not JSON')
    }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof (m as { t?: unknown }).t !== 'string') return closeConn(c, LIVE_CLOSE.protocol, 'not a message')
    const id = typeof m.id === 'string' && m.id.length <= 64 ? m.id : undefined
    switch (m.t) {
      case 'sub':
        return enqueue(c, () => onSub(c, { id, topic: String(m.topic), env: typeof m.env === 'string' ? m.env : undefined }))
      case 'unsub':
        return enqueue(c, () => onUnsub(c, { id, topic: String(m.topic), env: typeof m.env === 'string' ? m.env : undefined }))
      case 'presence':
        return enqueue(c, () => onPresence(c, { id, scope: String(m.scope), env: String(m.env), state: m.state ?? null }))
      case 'lock':
        return enqueue(c, () => onLock(c, { id, scope: String(m.scope), env: String(m.env), action: m.action }))
      case 'ping':
        return send(c, { t: 'pong', id, at: new Date().toISOString() })
      default:
        return send(c, { t: 'error', id, code: 'invalid', message: `Unknown message type "${String((m as { t: unknown }).t).slice(0, 20)}".` })
    }
  }

  async function loadHidden(userId: string): Promise<void> {
    if (hiddenLoaded.has(userId)) return
    hiddenLoaded.add(userId)
    try {
      const s = await services.notifications?.settings(userId)
      if (s?.hidePresence) hidden.add(userId)
    } catch {
      hiddenLoaded.delete(userId)
    }
  }

  function accept(ws: WebSocket, user: { id: string; name: string }, sessionHash: string): void {
    const c: Conn = {
      id: randomBytes(12).toString('base64url'), ws, userId: user.id, name: user.name, sessionHash, subs: new Set(), presence: new Set(),
      ctx: new Map(), alive: true, tokens: limits.inboundBurst, refillAt: Date.now(), strikes: 0, chain: Promise.resolve(), closed: false,
    }
    if (closing) return void ws.close(LIVE_CLOSE.shutdown, 'server stopping')
    if (conns.size >= limits.maxConnections) return void ws.close(LIVE_CLOSE.limit, 'too many connections on the server')
    const mine = byUser.get(user.id)
    if (mine && mine.size >= limits.maxConnectionsPerUser) return void ws.close(LIVE_CLOSE.limit, 'too many connections for this user')
    conns.set(c.id, c)
    const firstOfUser = !mine || mine.size === 0
    if (mine) mine.add(c)
    else byUser.set(user.id, new Set([c]))
    ws.on('pong', () => {
      c.alive = true
    })
    ws.on('message', (data, isBinary) => onMessage(c, data, isBinary))
    ws.on('close', () => {
      if (!c.closed) {
        c.closed = true
        cleanup(c)
      }
    })
    ws.on('error', () => {
      if (!c.closed) {
        c.closed = true
        cleanup(c)
      }
      ws.terminate()
    })
    send(c, {
      t: 'hello', v: LIVE_PROTOCOL_VERSION, epoch, connection: c.id, user: { id: user.id, name: user.name },
      limits: { maxSubscriptions: limits.maxSubscriptions, maxMessageBytes: limits.maxMessageBytes, heartbeatMs: limits.heartbeatMs },
    })
    if (firstOfUser) void loadHidden(user.id).then(onlineChanged)
  }

  function reject(socket: Duplex, status: number, message: string): void {
    const body = JSON.stringify({ error: { code: status === 403 ? 'denied' : 'unavailable', message } })
    try {
      socket.write(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : status === 400 ? 'Bad Request' : 'Service Unavailable'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
    } catch { /* ignore */ }
    socket.destroy()
  }

  /** completes the WebSocket handshake, then closes at once with a code the client can act on */
  function acceptAndClose(req: IncomingMessage, socket: Duplex, head: Buffer, code: number, reason: string): void {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => ws.terminate())
      ws.close(code, reason)
    })
  }

  const offChanges = onTableChange(onChange)

  return {
    isLiveRequest(req) {
      const url = req.url ?? ''
      return url === LIVE_PATH || url.startsWith(LIVE_PATH + '?')
    },
    handleUpgrade(req, socket, head) {
      socket.on('error', () => socket.destroy())
      if (closing) return reject(socket, 503, 'The server is stopping.')
      if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') return reject(socket, 400, 'Expected a WebSocket upgrade.')
      // same Host/Origin rules as HTTP, plus: the Origin header is required (the CSRF-equivalent check, see above)
      const problem = originProblem(req, opts.allowAnyHost, allowedHosts)
      if (problem) return reject(socket, 403, problem)
      if (req.headers.origin === undefined) return reject(socket, 403, 'Cross-origin requests are not allowed.')
      if (!services.ready()) return reject(socket, 503, 'The database is not configured yet.')
      const token = cookieValue(req, SESSION_COOKIE)
      void (async () => {
        if (!token || token.length > 200) return acceptAndClose(req, socket, head, LIVE_CLOSE.unauthenticated, 'sign in first')
        const idHash = hashToken(token)
        try {
          const s = await services.meta.sessions.get(idHash)
          if (!s || s.expiresOn.getTime() <= Date.now()) return acceptAndClose(req, socket, head, LIVE_CLOSE.unauthenticated, 'sign in first')
          const rec = await services.meta.users.get(s.userId)
          if (!rec || rec.status === 'disabled') return acceptAndClose(req, socket, head, LIVE_CLOSE.unauthenticated, 'sign in first')
          if (rec.mustChangePassword) return acceptAndClose(req, socket, head, LIVE_CLOSE.passwordChange, 'password change required')
          // package I: a session that may only set up two-step verification gets no live data either
          if (s.restricted) return acceptAndClose(req, socket, head, LIVE_CLOSE.passwordChange, 'two-step verification setup required')
          const user = toUserDef(rec)
          wss.handleUpgrade(req, socket, head, (ws) => accept(ws, { id: user.id, name: user.name }, idHash))
        } catch (e) {
          log('warn', `live: upgrade failed: ${errText(e)}`)
          reject(socket, 503, 'The database is not reachable.')
        }
      })()
    },
    pushUser(userId, ev) {
      const subs = topics.get(K('', userTopic(userId)))
      if (!subs) return
      for (const c of subs) send(c, { t: 'user', topic: userTopic(userId), ...ev })
    },
    emitEnv(env, kind, extra = {}) {
      const subs = topics.get(K(env, 'env'))
      const at = new Date().toISOString()
      if (kind === 'security') for (const c of conns.values()) c.ctx.delete(env)
      if (subs) {
        for (const c of subs) {
          enqueue(c, () => send(c, { t: 'env', env, topic: 'env', kind, ...(extra.locked !== undefined ? { locked: extra.locked } : {}), ...(extra.restoring !== undefined ? { restoring: extra.restoring } : {}), ...(extra.by ? { by: extra.by } : {}), at, ...(extra.origin === c.id ? { self: true as const } : {}) }))
        }
      }
      if (kind === 'deleted') {
        // the environment is gone: every subscription and presence in it ends
        for (const c of [...conns.values()]) {
          enqueue(c, () => {
            for (const key of [...c.subs]) if (splitKey(key)[0] === env) unsubscribeKey(c, key)
            for (const key of [...c.presence]) if (splitKey(key)[0] === env) leavePresence(c, key)
            c.ctx.delete(env)
          })
        }
        for (const key of [...locks.keys()]) if (splitKey(key)[0] === env) dropLock(key)
      }
    },
    emitApp(env, appId, kind, by, extra = {}) {
      const subs = topics.get(K(env, `app:${appId}`))
      if (!subs) return
      const at = new Date().toISOString()
      for (const c of subs) {
        enqueue(c, () => send(c, { t: 'app', env, topic: `app:${appId}`, app: appId, kind, by, ...(extra.modifiedOn ? { modifiedOn: extra.modifiedOn } : {}), at, ...(extra.origin === c.id ? { self: true as const } : {}) }))
      }
    },
    onlineUsers: () => [...byUser.keys()].filter((u) => !hidden.has(u)),
    setHidden(userId, on) {
      hiddenLoaded.add(userId)
      const was = hidden.has(userId)
      if (on) hidden.add(userId)
      else hidden.delete(userId)
      if (was === on) return
      // every scope this user is present in, and the online lists, are sent again
      const scopes = new Set<string>()
      for (const c of byUser.get(userId) ?? []) for (const k of c.presence) scopes.add(k)
      for (const [key, l] of locks) if (l.userId === userId) scopes.add(key)
      for (const k of scopes) {
        const [env, scope] = splitKey(k)
        broadcastPresence(env, scope)
      }
      onlineChanged()
    },
    stats: () => ({
      connections: conns.size, users: byUser.size, subscriptions: [...topics.values()].reduce((n, s) => n + s.size, 0), sent, dropped, slowClosed,
    }),
    async close() {
      closing = true
      offSession()
      offChanges()
      clearInterval(heartbeat)
      clearInterval(sweep)
      if (recheckTimer) clearTimeout(recheckTimer)
      if (onlineTimer) clearTimeout(onlineTimer)
      for (const l of locks.values()) if (l.graceTimer) clearTimeout(l.graceTimer)
      services.security.invalidate = invalidateSecurity
      for (const c of [...conns.values()]) closeConn(c, LIVE_CLOSE.shutdown, 'server stopping')
      await new Promise<void>((r) => wss.close(() => r()))
    },
  }

  /* -------------------------------------------------------------- table changes -> table messages */

  function onChange(env: string, tableId: string, change: TableChange): void {
    // the outbox id is the sequence (per environment, increasing); a change outside the outbox reuses the latest one
    const seq = change.seq ?? (envSeq.get(env) ?? 0)
    if (seq > (envSeq.get(env) ?? 0)) envSeq.set(env, seq)
    const tkey = K(env, tableId)
    const prev = lastSeq.get(tkey) ?? 0
    lastSeq.set(tkey, seq)
    const subs = topics.get(K(env, `table:${tableId}`))
    if (!subs?.size) return
    const at = new Date().toISOString()
    let def: Promise<TableDef | null> | null = null
    for (const c of subs) {
      enqueue(c, async () => {
        def ??= runInEnvironment(env, () => services.meta.tables.get(tableId)).catch(() => null)
        const d = await def
        if (!d) return
        let ctx: UserContext
        try {
          ctx = await ctxFor(c, env)
        } catch {
          return
        }
        const msg = tableMessageFor(ctx, d, env, change, seq, prev, limits.maxRowIds, at)
        if (!msg) return
        send(c, change.origin === c.id ? { ...msg, self: true } : msg)
      })
    }
  }
}
