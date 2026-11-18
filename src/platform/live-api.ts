/**
 * The realtime and notification parts of the platform API (PlatformApi['live'], PlatformApi['notifications']), shared
 * by server mode (remote-live.ts over the WebSocket) and demo mode (demo-live.ts over BroadcastChannel between tabs).
 */
import type {
  LivePerson, NotificationItem, NotificationSettings, PresenceMember, PresenceState, ServerMessage,
} from './live-protocol.ts'
import type { LiveStatus, LockReply } from './live.ts'

export type { LiveStatus, LiveState, LockReply } from './live.ts'
export type { LivePerson, NotificationItem, NotificationSettings, PresenceMember, PresenceState } from './live-protocol.ts'

export type LiveMessage = ServerMessage | { t: 'resync'; reason: string }

export interface LiveApi {
  /** 'open': pushes arrive; 'degraded': no socket, data refreshes periodically; 'off': signed out / demo without tabs */
  status(): LiveStatus
  onStatus(listener: (s: LiveStatus) => void): () => void
  /**
   * subscribe to a topic (docs/dev/live.md); env defaults to the current environment, null for install-wide topics
   * (user:<id>). The handler also gets { t: 'resync' } when messages may have been missed.
   */
  subscribe(topic: string, handler: (m: LiveMessage) => void, opts?: { env?: string | null }): () => void
  /** join (state) or leave (null) a presence scope in the current environment: app:<id>, studio:<id>, record:<table>:<row> */
  setPresence(scope: string, state: PresenceState | null): void
  /** Studio soft lock on studio:<appId> */
  lock(scope: string, action: 'acquire' | 'release' | 'takeover'): Promise<LockReply>
  /** who last changed a row, as far as this page has seen (live messages with row ids, 409 answers) */
  lastRowChange(table: string, rowId: string): { by: LivePerson; at: string } | null
  /** the signed-in person as the live connection knows it */
  me(): LivePerson | null
}

export interface NotificationsApi {
  list(o?: { limit?: number; cursor?: string | null; unreadOnly?: boolean }): Promise<{ items: NotificationItem[]; nextCursor: string | null; unread: number }>
  markRead(ids: string[] | 'all'): Promise<void>
  remove(id: string): Promise<void>
  settings(): Promise<NotificationSettings>
  saveSettings(s: NotificationSettings): Promise<NotificationSettings>
  /** SendNotification: to = user id or email of someone in the current environment */
  send(input: { to: string; title: string; body?: string; link?: string; app?: string }): Promise<void>
  /** a new notification arrived for the signed-in user (live push) */
  onNotification(listener: (n: NotificationItem) => void): () => void
}

/** presence members other than me */
export function others(members: PresenceMember[], meId: string | undefined): PresenceMember[] {
  return members.filter((m) => m.id !== meId)
}
