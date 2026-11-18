/**
 * Demo mode realtime (package H): the browser-only platform has no server, so tabs of the same browser keep each other
 * in sync over a BroadcastChannel ("appbuilder-demo-live"). Same LiveApi / NotificationsApi as server mode:
 *  - table:<id>  a tab that persisted rows of a table tells the others; they re-read the table from browser storage
 *  - app:<id>    an app definition was saved (running copies offer "Update available")
 *  - user:<id>   notifications (stored in browser storage, notifications.json) for the run-as user
 *  - presence    who has an app open in which tab (heartbeat every 10 s, gone after 30 s); Studio locks are not
 *                simulated (every tab may edit; the last save wins, as before)
 * Nothing here is security: demo mode simulates everything in one browser.
 */
import type { LiveApi, LiveMessage, NotificationsApi } from './live-api.ts'
import type { LiveStatus } from './live.ts'
import type { LivePerson, NotificationItem, NotificationSettings, PresenceMember, PresenceState } from './live-protocol.ts'
import { defaultNotificationSettings, parseNotificationSettings } from './live-protocol.ts'
import { PlatformError } from './contracts.ts'

export const DEMO_CHANNEL = 'appbuilder-demo-live'

export interface DemoLiveDeps {
  /** the run-as user */
  me(): LivePerson
  /** users of the demo workspace (SendNotification by id or email) */
  users(): { id: string; name: string; email: string }[]
  readText(path: string): Promise<string | null>
  writeText(path: string, text: string): Promise<void>
  /** another tab persisted rows of this table (id): re-read it */
  reloadTable(tableId: string): void
  /** another tab saved this app: re-read it */
  reloadApp(appId: string): void
  setUnread(n: number): void
  /** channel factory (tests); default BroadcastChannel when the browser has it */
  channel?: () => { postMessage(m: unknown): void; close(): void; onmessage: ((ev: { data: unknown }) => void) | null } | null
  now?: () => Date
}

interface Wire {
  from: string
  msg: LiveMessage
}

interface PresenceEntry { tab: string; scope: string; user: LivePerson; state: PresenceState; since: string; seen: number }

export interface DemoLive {
  live: LiveApi
  notifications: NotificationsApi
  /** this tab wrote rows of a table to storage */
  tableSaved(tableId: string): void
  /** this tab saved an app */
  appSaved(appId: string, modifiedOn: string): void
  /** the run-as user changed (unread count of the new one) */
  userChanged(): void
  close(): void
}

const tabId = () => Math.random().toString(36).slice(2, 10)

export function createDemoLive(deps: DemoLiveDeps): DemoLive {
  const now = deps.now ?? (() => new Date())
  const me = tabId()
  const make = deps.channel ?? (() => {
    const BC = (globalThis as { BroadcastChannel?: new (name: string) => { postMessage(m: unknown): void; close(): void; onmessage: ((ev: { data: unknown }) => void) | null } }).BroadcastChannel
    return BC ? new BC(DEMO_CHANNEL) : null
  })
  const ch = make()
  const status: LiveStatus = { state: ch ? 'open' : 'off', since: Date.now() }
  const handlers = new Map<string, Set<(m: LiveMessage) => void>>()
  const notificationListeners = new Set<(n: NotificationItem) => void>()
  const presence = new Map<string, PresenceEntry>()
  const mine = new Map<string, PresenceState>()

  const post = (msg: LiveMessage) => {
    try {
      ch?.postMessage({ from: me, msg } satisfies Wire)
    } catch { /* the channel closed */ }
  }
  const deliver = (topic: string, m: LiveMessage) => {
    for (const h of [...(handlers.get(topic) ?? [])]) {
      try {
        h(m)
      } catch (e) {
        console.error('[demo live] handler failed', e)
      }
    }
  }

  /* -------------------------------------------------------------- presence */

  const pkey = (tab: string, scope: string) => `${tab}\u0001${scope}`
  function members(scope: string): PresenceMember[] {
    const cutoff = Date.now() - 30_000
    const byUser = new Map<string, PresenceMember>()
    for (const e of presence.values()) {
      if (e.scope !== scope || e.seen < cutoff) continue
      // demo mode: every tab of this browser runs as some user, often the same one; other tabs count as other people
      const id = e.tab === me ? e.user.id : `${e.user.id}@${e.tab}`
      const prev = byUser.get(id)
      if (!prev) byUser.set(id, { id, name: e.user.name, state: e.state, since: e.since })
      else if (e.state === 'editing') prev.state = 'editing'
    }
    return [...byUser.values()]
  }
  function presenceChanged(scope: string) {
    const topic = `presence:${scope}`
    deliver(topic, { t: 'presence', env: 'default', topic, scope, members: members(scope), ...(scope.startsWith('studio:') ? { lock: { holder: deps.me(), mine: true } } : {}) })
  }
  function announce(scope: string, state: PresenceState | null) {
    const user = deps.me()
    const wire = { t: 'presence-demo', tab: me, scope, user, state } as unknown as LiveMessage
    post(wire)
    const k = pkey(me, scope)
    if (state === null) presence.delete(k)
    else presence.set(k, { tab: me, scope, user, state, since: presence.get(k)?.since ?? now().toISOString(), seen: Date.now() })
    presenceChanged(scope)
  }
  const heartbeat = setInterval(() => {
    for (const [scope, state] of mine) announce(scope, state)
    // drop tabs that went away without saying so
    for (const [k, e] of presence) if (e.seen < Date.now() - 30_000) {
      presence.delete(k)
      presenceChanged(e.scope)
    }
  }, 10_000)
  ;(heartbeat as unknown as { unref?: () => void }).unref?.()
  const onUnload = () => {
    for (const scope of mine.keys()) post({ t: 'presence-demo', tab: me, scope, user: deps.me(), state: null } as unknown as LiveMessage)
  }
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onUnload)

  /* -------------------------------------------------------------- incoming */

  if (ch) {
    ch.onmessage = (ev) => {
      const w = ev.data as Wire
      if (!w || typeof w !== 'object' || w.from === me || !w.msg) return
      const m = w.msg as LiveMessage & { tab?: string; scope?: string; user?: LivePerson; state?: PresenceState | null }
      if ((m as { t: string }).t === 'presence-demo') {
        const k = pkey(m.tab!, m.scope!)
        if (m.state === null || m.state === undefined) presence.delete(k)
        else {
          const known = presence.has(k)
          presence.set(k, { tab: m.tab!, scope: m.scope!, user: m.user!, state: m.state, since: presence.get(k)?.since ?? now().toISOString(), seen: Date.now() })
          // a tab that just arrived learns about us too
          if (!known) for (const [scope, state] of mine) post({ t: 'presence-demo', tab: me, scope, user: deps.me(), state } as unknown as LiveMessage)
        }
        presenceChanged(m.scope!)
        return
      }
      if (m.t === 'table') deps.reloadTable(m.table)
      if (m.t === 'app' && m.kind === 'saved') deps.reloadApp(m.app)
      if (m.t === 'user') {
        if (m.topic !== `user:${deps.me().id}`) return
        if (m.event === 'notification') {
          deps.setUnread(m.unread)
          for (const l of [...notificationListeners]) l(m.notification)
        } else if (m.event === 'unread') deps.setUnread(m.unread)
      }
      if ('topic' in m && typeof m.topic === 'string') deliver(m.topic, m)
    }
  }

  /* -------------------------------------------------------------- notifications (browser storage) */

  const FILE = 'notifications.json'
  interface Stored { items: (NotificationItem & { user: string })[]; settings: Record<string, NotificationSettings> }
  async function readStore(): Promise<Stored> {
    try {
      const t = await deps.readText(FILE)
      const o = t ? (JSON.parse(t) as Stored) : null
      return { items: Array.isArray(o?.items) ? o!.items : [], settings: o?.settings && typeof o.settings === 'object' ? o.settings : {} }
    } catch {
      return { items: [], settings: {} }
    }
  }
  const writeStore = (s: Stored) => deps.writeText(FILE, JSON.stringify(s))
  const unreadOf = (s: Stored, user: string) => s.items.filter((n) => n.user === user && !n.readOn).length
  async function refreshUnread() {
    const s = await readStore()
    deps.setUnread(unreadOf(s, deps.me().id))
  }
  const strip = ({ user: _u, ...n }: NotificationItem & { user: string }): NotificationItem => {
    void _u
    return n
  }

  const notifications: NotificationsApi = {
    async list(o = {}) {
      const s = await readStore()
      const user = deps.me().id
      let items = s.items.filter((n) => n.user === user && (!o.unreadOnly || !n.readOn)).sort((a, b) => b.createdOn.localeCompare(a.createdOn))
      const start = o.cursor ? Math.max(0, Number(o.cursor) || 0) : 0
      const limit = Math.max(1, Math.min(100, o.limit ?? 30))
      const page = items.slice(start, start + limit)
      const next = start + limit < items.length ? String(start + limit) : null
      items = page
      const unread = unreadOf(s, user)
      deps.setUnread(unread)
      return { items: items.map(strip), nextCursor: next, unread }
    },
    async markRead(ids) {
      const s = await readStore()
      const user = deps.me().id
      const at = now().toISOString()
      for (const n of s.items) if (n.user === user && !n.readOn && (ids === 'all' || ids.includes(n.id))) n.readOn = at
      await writeStore(s)
      const unread = unreadOf(s, user)
      deps.setUnread(unread)
      post({ t: 'user', topic: `user:${user}`, event: 'unread', unread })
    },
    async remove(id) {
      const s = await readStore()
      const user = deps.me().id
      const before = s.items.length
      s.items = s.items.filter((n) => !(n.user === user && n.id === id))
      if (s.items.length === before) throw new PlatformError('not-found', 'Notification not found.')
      await writeStore(s)
      deps.setUnread(unreadOf(s, user))
    },
    async settings() {
      const s = await readStore()
      return parseNotificationSettings(s.settings[deps.me().id] ?? defaultNotificationSettings())
    },
    async saveSettings(next) {
      const s = await readStore()
      const v = parseNotificationSettings(next)
      s.settings[deps.me().id] = v
      await writeStore(s)
      return v
    },
    async send(input) {
      const to = input.to.trim().toLowerCase()
      const target = deps.users().find((u) => u.id.toLowerCase() === to || u.email.toLowerCase() === to)
      if (!target) throw new PlatformError('not-found', `There is no user "${input.to}" in this environment.`)
      if (!input.title?.trim()) throw new PlatformError('invalid', 'title is required.')
      if (input.link && !/^#[A-Za-z0-9/_\-.~?=&%:+,]*$/.test(input.link)) throw new PlatformError('invalid', 'link must be a link inside Appbuilder, such as #u.')
      const s = await readStore()
      const prefs = parseNotificationSettings(s.settings[target.id] ?? {})
      if (prefs.kinds.app === false) return
      const sender = deps.me()
      const item: NotificationItem & { user: string } = {
        id: `ntf_${Date.now().toString(36)}${tabId()}`, user: target.id, kind: 'app', title: input.title.trim().slice(0, 200), body: (input.body ?? '').slice(0, 2000),
        link: input.link || null, environmentId: 'default', createdOn: now().toISOString(), readOn: null, source: input.app ? `app:${input.app}` : `user:${sender.id}`, from: sender.name,
      }
      s.items.push(item)
      s.items = s.items.slice(-500)
      await writeStore(s)
      const unread = unreadOf(s, target.id)
      const msg: LiveMessage = { t: 'user', topic: `user:${target.id}`, event: 'notification', notification: strip(item), unread }
      post(msg)
      if (target.id === sender.id) {
        deps.setUnread(unread)
        for (const l of [...notificationListeners]) l(strip(item))
      }
    },
    onNotification(listener) {
      notificationListeners.add(listener)
      return () => {
        notificationListeners.delete(listener)
      }
    },
  }

  /* -------------------------------------------------------------- live */

  const live: LiveApi = {
    status: () => status,
    onStatus: () => () => {},
    subscribe(topic, handler) {
      let set = handlers.get(topic)
      if (!set) handlers.set(topic, (set = new Set()))
      set.add(handler)
      if (topic.startsWith('presence:')) queueMicrotask(() => presenceChanged(topic.slice('presence:'.length)))
      return () => {
        set!.delete(handler)
        if (!set!.size) handlers.delete(topic)
      }
    },
    setPresence(scope, state) {
      if (state === null) mine.delete(scope)
      else mine.set(scope, state)
      announce(scope, state)
    },
    // demo mode does not simulate the Studio soft lock: every tab may edit
    lock: async () => ({ ok: true, holder: deps.me(), mine: true }),
    lastRowChange: () => null,
    me: () => deps.me(),
  }

  void refreshUnread()

  return {
    live,
    notifications,
    tableSaved(tableId) {
      post({ t: 'table', env: 'default', topic: `table:${tableId}`, table: tableId, seq: 0, prev: 0, op: 'update', rows: null, columns: [], at: now().toISOString() })
    },
    appSaved(appId, modifiedOn) {
      post({ t: 'app', env: 'default', topic: `app:${appId}`, app: appId, kind: 'saved', by: deps.me(), modifiedOn, at: now().toISOString() })
    },
    userChanged() {
      void refreshUnread()
      for (const [scope, state] of mine) announce(scope, state)
    },
    close() {
      clearInterval(heartbeat)
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onUnload)
      onUnload()
      ch?.close()
    },
  }
}
