/**
 * Server mode realtime glue (package H): owns the page's LiveClient (live.ts) and turns pushes into platform effects.
 *  - table:<id>   debounced per table (bursts coalesce: 120 ms quiet, at most 800 ms late) -> the platform invalidates
 *                 that table's cached queries and reloads its small-table cache in the background (rows stay on screen
 *                 until the new ones arrive: no flicker, scroll position and form edits are kept by the controls)
 *  - user:<me>    notifications (bell, toasts, desktop notifications) and the unread count
 *  - env          metadata / security / state changes -> the workspace reloads
 *  - degraded     no socket: every tracked table refreshes every 30 s, and once more when the socket is back
 * remote.ts calls start() after sign-in, stop() at sign-out, envChanged() after an environment switch, trackTable()
 * whenever a table is read, and adds liveHeader() to writes (the server marks our own changes `self`).
 */
import { PlatformError } from './contracts.ts'
import type { WorkspaceState } from './contracts.ts'
import type { LiveApi, LiveMessage, NotificationsApi } from './live-api.ts'
import { LiveClient } from './live.ts'
import type { LiveClientOptions } from './live.ts'
import type { LivePerson, NotificationItem, NotificationSettings } from './live-protocol.ts'
import { LIVE_CLIENT_HEADER, parseNotificationSettings } from './live-protocol.ts'

/** periodic refetch while the socket is unavailable */
export const DEGRADED_REFRESH_MS = 30_000
const DEBOUNCE_MS = 120
const MAX_WAIT_MS = 800
/** at most this many table topics per page (the server allows 200 subscriptions per socket) */
const MAX_TABLE_TOPICS = 150

export interface RemoteLiveDeps {
  call<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, o?: { json?: unknown; query?: Record<string, string | undefined> }): Promise<T>
  getState(): WorkspaceState
  setState(patch: Partial<WorkspaceState>): void
  /** rows of this table (id) changed elsewhere: refetch its queries and its small-table cache */
  invalidateTable(tableId: string): void
  /** every table this page reads (degraded mode, reconnect after a server restart) */
  invalidateAll(): void
  /** environment metadata or privileges changed: reload the workspace */
  refreshWorkspace(kind: 'metadata' | 'security' | 'state' | 'deleted'): void
  /** the socket says the session ended (4401) or must change its password (4403): true = still signed in */
  checkSession(code: number): Promise<boolean>
  live?: LiveClientOptions
  /** timers (tests) */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (t: unknown) => void
  now?: () => number
}

export interface RemoteLive {
  live: LiveApi
  notifications: NotificationsApi
  client: LiveClient
  start(): void
  stop(): void
  envChanged(): void
  trackTable(tableId: string): void
  liveHeader(): Record<string, string>
  /** a 409 told us who changed a row */
  noteRowChange(tableId: string, rowId: string, by: LivePerson): void
}

export function createRemoteLive(deps: RemoteLiveDeps): RemoteLive {
  const setT = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearT = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>))
  const setI = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const clearI = deps.clearInterval ?? ((t: unknown) => clearInterval(t as ReturnType<typeof setInterval>))
  const client = new LiveClient({ ...deps.live, onSessionProblem: (code) => deps.checkSession(code) })
  const env = () => deps.getState().environmentId || undefined
  const tracked = new Map<string, () => void>()
  const pendingInvalidations = new Map<string, { timer: unknown; first: number }>()
  const rowChanges = new Map<string, { by: LivePerson; at: string }>()
  const notificationListeners = new Set<(n: NotificationItem) => void>()
  let started = false
  let offUser: (() => void) | null = null
  let offEnv: (() => void) | null = null
  let degradedTimer: unknown = null
  let wasDegraded = false
  let refreshTimer: unknown = null
  let refreshKind: 'metadata' | 'security' | 'state' | 'deleted' = 'metadata'

  /* -------------------------------------------------------------- status */

  client.onStatus((s) => {
    deps.setState({ live: s })
    if (s.state === 'degraded' && started) {
      wasDegraded = true
      if (!degradedTimer) degradedTimer = setI(() => deps.invalidateAll(), DEGRADED_REFRESH_MS)
    } else if (degradedTimer) {
      clearI(degradedTimer)
      degradedTimer = null
    }
    // back from a gap without pushes: catch up once
    if (s.state === 'open' && wasDegraded) {
      wasDegraded = false
      deps.invalidateAll()
    }
  })

  /* -------------------------------------------------------------- tables */

  function scheduleInvalidate(tableId: string) {
    const now = (deps.now ?? Date.now)()
    const cur = pendingInvalidations.get(tableId)
    if (cur) clearT(cur.timer)
    const first = cur?.first ?? now
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - (now - first)))
    const timer = setT(() => {
      pendingInvalidations.delete(tableId)
      deps.invalidateTable(tableId)
    }, wait)
    pendingInvalidations.set(tableId, { timer, first })
  }

  function onTable(tableId: string, m: LiveMessage) {
    if (m.t === 'resync') return scheduleInvalidate(tableId)
    if (m.t !== 'table') return
    if (m.rows && m.by) for (const r of m.rows) rowChanges.set(`${tableId}\u0001${r}`, { by: m.by, at: m.at })
    if (rowChanges.size > 2000) for (const k of [...rowChanges.keys()].slice(0, 1000)) rowChanges.delete(k)
    // our own write is already applied (and refetched by the write path)
    if (m.self) return
    scheduleInvalidate(tableId)
  }

  function trackTable(tableId: string) {
    if (!started || !tableId || tracked.has(tableId) || tracked.size >= MAX_TABLE_TOPICS) return
    tracked.set(tableId, client.subscribe(`table:${tableId}`, env(), (m) => onTable(tableId, m)))
  }

  /* -------------------------------------------------------------- user and env topics */

  function onUser(m: LiveMessage) {
    if (m.t === 'resync') {
      void refreshUnread()
      return
    }
    if (m.t !== 'user') return
    if (m.event === 'notification') {
      deps.setState({ unread: m.unread })
      for (const l of [...notificationListeners]) {
        try {
          l(m.notification)
        } catch (e) {
          console.error('[live] notification listener failed', e)
        }
      }
    } else if (m.event === 'unread') deps.setState({ unread: m.unread })
  }

  function onEnv(m: LiveMessage) {
    if (m.t !== 'env' || m.self) return
    // coalesce: a solution import changes many things at once
    const rank = { metadata: 0, state: 1, security: 2, deleted: 3 } as const
    if (!refreshTimer || rank[m.kind] > rank[refreshKind]) refreshKind = m.kind
    if (refreshTimer) clearT(refreshTimer)
    refreshTimer = setT(() => {
      refreshTimer = null
      deps.refreshWorkspace(refreshKind)
      refreshKind = 'metadata'
    }, 250)
  }

  async function refreshUnread() {
    try {
      const r = await deps.call<{ unread: number }>('GET', '/notifications/unread-count')
      deps.setState({ unread: r.unread })
    } catch { /* the bell shows nothing new */ }
  }

  function subscribeBase() {
    const me = deps.getState().session?.user.id
    offUser?.()
    offEnv?.()
    offUser = me ? client.subscribe(`user:${me}`, undefined, onUser) : null
    offEnv = env() ? client.subscribe('env', env(), onEnv) : null
  }

  /* -------------------------------------------------------------- lifecycle */

  function start() {
    const s = deps.getState().session
    if (!s || s.user.mustChangePassword || s.user.mfaEnrolmentRequired || !client.enabled()) return
    if (started) return
    started = true
    subscribeBase()
    client.start()
    void refreshUnread()
  }

  function stop() {
    started = false
    for (const off of tracked.values()) off()
    tracked.clear()
    for (const p of pendingInvalidations.values()) clearT(p.timer)
    pendingInvalidations.clear()
    offUser?.()
    offEnv?.()
    offUser = offEnv = null
    client.resetTopics()
    client.stop()
    rowChanges.clear()
    if (degradedTimer) clearI(degradedTimer)
    degradedTimer = null
    deps.setState({ unread: 0, live: client.status() })
  }

  function envChanged() {
    if (!started) return
    for (const off of tracked.values()) off()
    tracked.clear()
    client.resetTopics()
    subscribeBase()
  }

  /* -------------------------------------------------------------- APIs */

  const live: LiveApi = {
    status: () => client.status(),
    onStatus: (fn) => client.onStatus(fn),
    subscribe(topic, handler, o = {}) {
      const e = o.env === null ? undefined : (o.env ?? env())
      return client.subscribe(topic, e, handler)
    },
    setPresence(scope, state) {
      const e = env()
      if (e) client.setPresence(scope, e, state)
    },
    lock(scope, action) {
      const e = env()
      if (!e) return Promise.resolve({ ok: false, holder: null, mine: false, message: 'No environment.' })
      return client.lock(scope, e, action)
    },
    lastRowChange: (tableId, rowId) => rowChanges.get(`${tableId}\u0001${rowId}`) ?? null,
    me: () => client.me(),
  }

  const notifications: NotificationsApi = {
    async list(o = {}) {
      const r = await deps.call<{ items: NotificationItem[]; nextCursor: string | null; unread: number }>('GET', '/notifications', {
        query: { limit: o.limit ? String(o.limit) : undefined, cursor: o.cursor ?? undefined, unread: o.unreadOnly ? '1' : undefined },
      })
      deps.setState({ unread: r.unread })
      return r
    },
    async markRead(ids) {
      const r = ids === 'all'
        ? await deps.call<{ unread: number }>('POST', '/notifications/read-all')
        : ids.length === 1
          ? await deps.call<{ unread: number }>('POST', `/notifications/${encodeURIComponent(ids[0])}/read`)
          : null
      if (!r && ids !== 'all') for (const id of ids) await deps.call('POST', `/notifications/${encodeURIComponent(id)}/read`)
      if (r) deps.setState({ unread: r.unread })
      else await refreshUnread()
    },
    async remove(id) {
      const r = await deps.call<{ unread: number }>('DELETE', `/notifications/${encodeURIComponent(id)}`)
      deps.setState({ unread: r.unread })
    },
    async settings(): Promise<NotificationSettings> {
      return parseNotificationSettings(await deps.call('GET', '/notifications/settings'))
    },
    async saveSettings(s) {
      return parseNotificationSettings(await deps.call('PUT', '/notifications/settings', { json: s }))
    },
    async send(input) {
      if (!input.to || !input.title) throw new PlatformError('invalid', 'SendNotification needs a user and a title.')
      await deps.call('POST', '/notifications/send', { json: input })
    },
    onNotification(listener) {
      notificationListeners.add(listener)
      return () => {
        notificationListeners.delete(listener)
      }
    },
  }

  return {
    live,
    notifications,
    client,
    start,
    stop,
    envChanged,
    trackTable,
    liveHeader() {
      const id = client.connectionId()
      const h: Record<string, string> = {}
      if (id) h[LIVE_CLIENT_HEADER] = id
      return h
    },
    noteRowChange(tableId, rowId, by) {
      rowChanges.set(`${tableId}\u0001${rowId}`, { by, at: new Date().toISOString() })
    },
  }
}
