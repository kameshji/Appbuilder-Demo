/**
 * Realtime protocol v1 (docs/dev/live.md): the JSON messages on the WebSocket /api/v1/live. Shared by the server
 * (server/core/live/*) and the browser (src/platform/live.ts), so this file follows the server's rules: no React, no
 * DOM, no `@/` alias, erasable TypeScript only, relative `.ts` imports.
 *
 * Every message is one JSON object with a type `t`. The client subscribes to topics; the server pushes. Topics:
 *   table:<tableId>    rows of a table changed (environment-bound)
 *   user:<userId>      the signed-in user's own notifications and session events (install-wide; only one's own id)
 *   presence:<scope>   who is viewing / editing: app:<appId>, studio:<appId>, record:<tableId>:<rowId>, online
 *   env                the environment changed (locked, deleted, metadata or security changed)
 *   app:<appId>        an app definition was saved, renamed or deleted
 */

import type { BackupLiveEvent } from './backup.ts'
import type { ChatPushMessage, ChatTypingMessage, ChatUserEvent } from './chat-protocol.ts'

export const LIVE_PROTOCOL_VERSION = 1
/** the endpoint (same origin, same port as the API); ws:// or wss:// as the page */
export const LIVE_PATH = '/api/v1/live'
/** HTTP header a client sets on writes: the id of its live connection, so the server does not echo its own changes back */
export const LIVE_CLIENT_HEADER = 'X-Appbuilder-Live'

/** close codes (4000-4999 are the application's) */
export const LIVE_CLOSE = {
  /** the server stops (restart): reconnect */
  shutdown: 1001,
  /** a message was not valid protocol: do not retry the same thing */
  protocol: 4400,
  /** no session, the session ended (signed out, revoked, password changed, account disabled) */
  unauthenticated: 4401,
  /** signed in, but the account must change its password before anything else */
  passwordChange: 4403,
  /** the client could not keep up (buffer above the limit): reconnect and resync every subscription */
  slowConsumer: 4408,
  /** too many connections (per user or for the whole server), or too many messages: back off longer */
  limit: 4429,
} as const

/** per-connection and server limits; the server announces the effective ones in `hello` */
export const LIVE_LIMITS = {
  /** largest inbound message (bytes); larger ones close the socket with 1009 */
  maxMessageBytes: 16 * 1024,
  /** subscriptions one connection may hold */
  maxSubscriptions: 200,
  /** sockets per user (all tabs and devices together) */
  maxConnectionsPerUser: 20,
  /** sockets for the whole server (APPBUILDER_LIVE_MAX_CONNECTIONS) */
  maxConnections: 5000,
  /** outbound bytes waiting in a socket's buffer before the server drops it as a slow consumer */
  maxBufferedBytes: 1024 * 1024,
  /** inbound messages per connection: burst size and refill per second */
  inboundBurst: 60,
  inboundPerSecond: 20,
  /** WebSocket ping interval; a socket that misses a pong within the next interval is terminated */
  heartbeatMs: 25_000,
  /** row ids in one table message: above it the message carries rows: null (refetch the table) */
  maxRowIds: 50,
} as const

export type LiveOp = 'insert' | 'update' | 'delete' | 'import'

export type PresenceState = 'viewing' | 'editing'

export interface LivePerson {
  id: string
  name: string
}

export interface PresenceMember extends LivePerson {
  state: PresenceState
  /** ISO time the member joined the scope */
  since: string
}

/* ------------------------------------------------------------------ client -> server */

export type ClientMessage =
  | { t: 'sub'; id?: string; topic: string; env?: string }
  | { t: 'unsub'; id?: string; topic: string; env?: string }
  /** join (state) or leave (state null) a presence scope */
  | { t: 'presence'; id?: string; scope: string; env: string; state: PresenceState | null }
  /** Studio soft lock: acquire (first editor wins), release, takeover (makers) */
  | { t: 'lock'; id?: string; scope: string; env: string; action: 'acquire' | 'release' | 'takeover' }
  /** application-level ping (latency measurement); the WebSocket ping/pong keeps the connection alive */
  | { t: 'ping'; id?: string }

/* ------------------------------------------------------------------ server -> client */

export interface HelloMessage {
  t: 'hello'
  v: number
  /** random per server start: a different epoch means sequences restarted (resync everything) */
  epoch: string
  /** this connection's id (send it as X-Appbuilder-Live on writes) */
  connection: string
  user: LivePerson
  limits: { maxSubscriptions: number; maxMessageBytes: number; heartbeatMs: number }
}

/**
 * Rows of a table changed. Leak rule (docs/dev/live.md): sent only to subscribers who may read the table; `columns`
 * holds only the changed column NAMES the subscriber may see; `rows` holds row ids only for subscribers whose read access
 * covers every row of the table (no row scope, no row filter), and only when there are at most maxRowIds of them;
 * everyone else gets rows: null (a "table changed" tick) and refetches through the secured query path. `by` comes with
 * row ids only.
 */
export interface TableMessage {
  t: 'table'
  env: string
  topic: string
  table: string
  /** the outbox id of this change (per environment, increasing; package G's ab_outbox) */
  seq: number
  /** seq of the previous change of the same table (0: none since the server started); a mismatch means a gap */
  prev: number
  op: LiveOp
  rows: string[] | null
  columns: string[]
  by?: LivePerson
  at: string
  /** the change came from this connection's own write (X-Appbuilder-Live): it is already applied */
  self?: true
}

export type UserEvent =
  | { event: 'notification'; notification: NotificationItem; unread: number }
  | { event: 'unread'; unread: number }
  /** the session ended or must change; the socket closes right after */
  | { event: 'session'; reason: SessionEndReason }
  /** install administrators: progress of a backup or restore (P0 package J, src/platform/backup.ts) */
  | ({ event: 'backup' } & BackupLiveEvent)
  /** P3-A chat: a conversation's unread state or the list of conversations changed (src/platform/chat-protocol.ts) */
  | ChatUserEvent

export type SessionEndReason = 'signed_out' | 'password_changed' | 'password_change_required' | 'disabled' | 'removed' | 'expired'

export type UserMessage = { t: 'user'; topic: string } & UserEvent

export interface PresenceMessage {
  t: 'presence'
  env: string
  topic: string
  scope: string
  members: PresenceMember[]
  /** studio scopes: who holds the edit lock (null: nobody). hidden: the holder hides their presence */
  lock?: { holder: LivePerson | null; mine: boolean; hidden?: boolean }
}

export interface EnvMessage {
  t: 'env'
  env: string
  topic: 'env'
  /** metadata: tables, columns, apps, solutions changed -> reload metadata; security: roles or access changed; state: locked/unlocked/renamed; deleted */
  kind: 'metadata' | 'security' | 'state' | 'deleted'
  locked?: boolean
  /** state: the environment is being restored from a backup (true), or the restore ended (false) (package J) */
  restoring?: boolean
  by?: LivePerson
  at: string
  self?: true
}

export interface AppMessage {
  t: 'app'
  env: string
  topic: string
  app: string
  kind: 'saved' | 'renamed' | 'deleted'
  by: LivePerson
  /** the app's modifiedOn after the change */
  modifiedOn?: string
  at: string
  self?: true
}

export type ServerMessage =
  | HelloMessage
  | { t: 'subscribed'; id?: string; topic: string; env?: string; seq?: number; epoch: string }
  /** reason: the server ended the subscription (lost access, removed from a chat conversation) */
  | { t: 'unsubscribed'; id?: string; topic: string; env?: string; reason?: string }
  | { t: 'error'; id?: string; code: LiveErrorCode; message: string; topic?: string }
  | { t: 'pong'; id?: string; at: string }
  | { t: 'resync'; reason: string }
  | { t: 'lock'; id?: string; scope: string; env: string; ok: boolean; holder: LivePerson | null; mine: boolean; message?: string }
  | TableMessage
  | UserMessage
  | PresenceMessage
  | EnvMessage
  | AppMessage
  /** P3-A chat topics chat:<channelId> and chat:typing:<channelId> (src/platform/chat-protocol.ts) */
  | ChatPushMessage
  | ChatTypingMessage

export type LiveErrorCode = 'invalid' | 'denied' | 'not-found' | 'unavailable' | 'limit' | 'password_change_required'

/* ------------------------------------------------------------------ notifications (also the HTTP API's shape) */

export interface NotificationItem {
  id: string
  /** e.g. app, system, flow, approval, mention */
  kind: string
  title: string
  body: string
  /** deep link inside Appbuilder (a hash route such as #u/app/<id>), never an external address */
  link: string | null
  /** the environment the notification is about (null: install-wide) */
  environmentId: string | null
  createdOn: string
  readOn: string | null
  /** who or what sent it: app:<id>, flow:<id>, user:<id>, system */
  source: string
  /** the sender's display name, when a person sent it */
  from?: string
}

/** per-user notification settings (stored on the server; GET/PUT /api/v1/notifications/settings) */
export interface NotificationSettings {
  /** in-app delivery per kind; a kind set to false is not stored for this user at all */
  kinds: Record<string, boolean>
  /** browser (desktop) notifications while Appbuilder is open in the background */
  desktop: boolean
  /** do-not-disturb hours, local time "HH:MM" (start may be after end: overnight); null = off */
  dnd: { start: string; end: string } | null
  /** hide my presence (avatars, online dot) from everyone */
  hidePresence: boolean
  /**
   * P1: email per kind: 'off', 'immediate' or 'digest'. A kind that is not listed follows the administrator's default
   * (Admin console > Notifications); a kind the administrator locked ignores this.
   */
  email?: Record<string, EmailMode>
  /** P1: digest timing (default daily at 08:00) */
  digest?: { frequency: 'hourly' | 'daily'; time: string }
  /** P1: the user's IANA time zone for digests and quiet hours (default UTC) */
  timeZone?: string
  /** P1: do-not-disturb hours hold emails too (default true): they go out when the hours end */
  quietEmail?: boolean
}

export type EmailMode = 'off' | 'immediate' | 'digest'
export const EMAIL_MODES: readonly EmailMode[] = ['off', 'immediate', 'digest']

export const NOTIFICATION_KINDS: readonly { kind: string; label: string; description: string }[] = [
  { kind: 'app', label: 'From apps', description: 'Sent by an app with SendNotification (for example "your request was approved").' },
  { kind: 'system', label: 'From Appbuilder', description: 'Account and environment notices (for example "you were given access to Production").' },
  { kind: 'event', label: 'From table events', description: 'Sent by a table event with NotifyUser (for example "a new order over 10,000 arrived").' },
  { kind: 'flow', label: 'From flows', description: 'Sent by automations.' },
  { kind: 'approval', label: 'Approvals', description: 'Approval requests waiting for you.' },
  { kind: 'mention', label: 'Mentions and comments', description: 'Someone mentioned you or commented on a record you follow.' },
  { kind: 'task', label: 'Tasks', description: 'A task was assigned to you.' },
  { kind: 'chat', label: 'Chat', description: 'Direct messages and mentions in chat (ordinary channel messages only raise the unread count).' },
  { kind: 'health', label: 'Server health', description: 'Install administrators: the daily health summary and alerts (degraded server, failed backup, dead jobs, failing flows), when turned on in Admin console > Server logs.' },
]

export function defaultNotificationSettings(): NotificationSettings {
  return { kinds: {}, desktop: false, dnd: null, hidePresence: false }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/** anything -> valid settings (unknown fields dropped) */
export function parseNotificationSettings(raw: unknown): NotificationSettings {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const kinds: Record<string, boolean> = {}
  if (o.kinds && typeof o.kinds === 'object' && !Array.isArray(o.kinds)) {
    for (const [k, v] of Object.entries(o.kinds as Record<string, unknown>)) {
      if (/^[a-z][a-z0-9_-]{0,31}$/.test(k) && typeof v === 'boolean') kinds[k] = v
    }
  }
  let dnd: NotificationSettings['dnd'] = null
  const d = o.dnd as Record<string, unknown> | null | undefined
  if (d && typeof d === 'object' && typeof d.start === 'string' && typeof d.end === 'string' && HHMM.test(d.start) && HHMM.test(d.end)) dnd = { start: d.start, end: d.end }
  const out: NotificationSettings = { kinds, desktop: o.desktop === true, dnd, hidePresence: o.hidePresence === true }
  // P1: email channel, digest, time zone, quiet hours for email
  if (o.email && typeof o.email === 'object' && !Array.isArray(o.email)) {
    const email: Record<string, EmailMode> = {}
    for (const [k, v] of Object.entries(o.email as Record<string, unknown>)) {
      if (/^[a-z][a-z0-9_-]{0,31}$/.test(k) && (EMAIL_MODES as readonly unknown[]).includes(v)) email[k] = v as EmailMode
    }
    out.email = email
  }
  const g = o.digest as Record<string, unknown> | null | undefined
  if (g && typeof g === 'object' && (g.frequency === 'hourly' || g.frequency === 'daily')) {
    out.digest = { frequency: g.frequency, time: typeof g.time === 'string' && HHMM.test(g.time) ? g.time : '08:00' }
  }
  if (typeof o.timeZone === 'string' && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$|^UTC$/.test(o.timeZone) && o.timeZone.length <= 64) out.timeZone = o.timeZone
  if (o.quietEmail === false) out.quietEmail = false
  return out
}

/** is local time `now` inside the do-not-disturb window? */
export function inDoNotDisturb(s: NotificationSettings, now: Date): boolean {
  if (!s.dnd) return false
  const m = now.getHours() * 60 + now.getMinutes()
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
  const a = toMin(s.dnd.start)
  const b = toMin(s.dnd.end)
  if (a === b) return false
  return a < b ? m >= a && m < b : m >= a || m < b
}

/* ------------------------------------------------------------------ topic helpers */

export type ParsedTopic =
  | { kind: 'table'; table: string }
  | { kind: 'user'; user: string }
  | { kind: 'presence'; scope: string }
  | { kind: 'env' }
  | { kind: 'app'; app: string }

const ID = /^[A-Za-z0-9_.:-]{1,128}$/

/** a topic string -> its parts; null when malformed */
export function parseTopic(topic: unknown): ParsedTopic | null {
  if (typeof topic !== 'string' || topic.length > 300) return null
  if (topic === 'env') return { kind: 'env' }
  const i = topic.indexOf(':')
  if (i < 0) return null
  const head = topic.slice(0, i)
  const rest = topic.slice(i + 1)
  if (head === 'presence') return parsePresenceScope(rest) ? { kind: 'presence', scope: rest } : null
  if (!ID.test(rest) || rest.includes(':')) return null
  if (head === 'table') return { kind: 'table', table: rest }
  if (head === 'user') return { kind: 'user', user: rest }
  if (head === 'app') return { kind: 'app', app: rest }
  return null
}

export type PresenceScope =
  | { kind: 'app'; app: string }
  | { kind: 'studio'; app: string }
  | { kind: 'record'; table: string; row: string }
  | { kind: 'online' }

const PART = /^[A-Za-z0-9_.-]{1,128}$/

export function parsePresenceScope(scope: unknown): PresenceScope | null {
  if (typeof scope !== 'string' || scope.length > 280) return null
  if (scope === 'online') return { kind: 'online' }
  const p = scope.split(':')
  if ((p[0] === 'app' || p[0] === 'studio') && p.length === 2 && PART.test(p[1])) return { kind: p[0], app: p[1] }
  if (p[0] === 'record' && p.length === 3 && PART.test(p[1]) && PART.test(p[2])) return { kind: 'record', table: p[1], row: p[2] }
  return null
}

export const tableTopic = (tableId: string) => `table:${tableId}`
export const userTopic = (userId: string) => `user:${userId}`
export const appTopic = (appId: string) => `app:${appId}`
export const presenceTopic = (scope: string) => `presence:${scope}`
