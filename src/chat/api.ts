/**
 * The chat HTTP API (docs/dev/chat.md) as plain functions. Everything chat shows comes from here or from the live
 * pushes; the browser enforces nothing (the server answers 403 / 404 / 422 with the reason, shown as it is).
 * Chat routes ignore the environment header (chat lives in one environment of the install), so none is sent.
 */
import { API_BASE, CSRF_HEADER } from '@/platform/http'
import { LIVE_CLIENT_HEADER } from '@/platform/live-protocol'
import type {
  ChatCardRef, ChatCardView, ChatChanges, ChatConversation, ChatFile, ChatMemberRole, ChatMemberView, ChatMessageView,
  ChatNotifyLevel, ChatPerson, CHAT_LIMITS,
} from '@/platform/chat-protocol'

export class ChatApiError extends Error {
  status: number
  code: string
  field?: string
  constructor(status: number, code: string, message: string, field?: string) {
    super(message)
    this.status = status
    this.code = code
    this.field = field
  }
}

export interface ChatMe {
  id: string
  name: string
  environmentId: string
  isAdmin: boolean
  readOnly: boolean
  readOnlyReason: 'install' | 'chat' | null
  canCreateChannels: boolean
  limits: typeof CHAT_LIMITS
  emoji: string[]
}

export interface HistoryPage { messages: ChatMessageView[]; more: boolean; lastSeq: number; purgedSeq: number }
export interface RepliesPage { root: ChatMessageView; messages: ChatMessageView[]; more: boolean }
export interface SearchHit { message: ChatMessageView; conversation: { id: string; kind: ChatConversation['kind']; name: string } }

/** where the live connection id comes from (chat's socket), for X-Appbuilder-Live */
let liveId: () => string | null = () => null
export function setLiveIdSource(fn: () => string | null): void {
  liveId = fn
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

async function call<T>(method: Method, path: string, body?: unknown, o: { raw?: Blob; type?: string; query?: Record<string, string | number | undefined | null> } = {}): Promise<T> {
  const q = o.query ? Object.entries(o.query).filter(([, v]) => v !== undefined && v !== null && v !== '') : []
  const qs = q.length ? `?${new URLSearchParams(q.map(([k, v]) => [k, String(v)])).toString()}` : ''
  const headers: Record<string, string> = { [CSRF_HEADER]: '1' }
  if (o.raw) headers['Content-Type'] = o.type || 'application/octet-stream'
  else if (body !== undefined) headers['Content-Type'] = 'application/json'
  const id = method === 'GET' ? null : liveId()
  if (id) headers[LIVE_CLIENT_HEADER] = id
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}${qs}`, { method, credentials: 'same-origin', cache: 'no-store', headers, body: o.raw ?? (body !== undefined ? JSON.stringify(body) : undefined) })
  } catch {
    throw new ChatApiError(0, 'unavailable', 'The server cannot be reached. Check the connection and try again.')
  }
  if (!res.ok) {
    type ErrBody = { error?: { code?: string; message?: string; field?: string } }
    const b: ErrBody | null = await res.json().then((x: unknown) => x as ErrBody, () => null)
    const msg = b?.error?.message ?? (res.status === 413 ? 'The file is too large.' : `The server answered ${res.status}.`)
    throw new ChatApiError(res.status, b?.error?.code ?? String(res.status), msg, b?.error?.field)
  }
  return (await res.json()) as T
}

const enc = encodeURIComponent

export const chatApi = {
  me: () => call<ChatMe>('GET', '/chat/me'),
  conversations: (browse = false) => call<{ items: ChatConversation[] }>('GET', '/chat/conversations', undefined, { query: { browse: browse ? 1 : undefined } }),
  conversation: (id: string) => call<ChatConversation>('GET', `/chat/conversations/${enc(id)}`),
  create: (b: { kind: ChatConversation['kind']; name?: string; description?: string; isPrivate?: boolean; members?: string[]; postingPolicy?: 'everyone' | 'owners' }) => call<ChatConversation>('POST', '/chat/conversations', b),
  update: (id: string, b: { name?: string; description?: string; postingPolicy?: 'everyone' | 'owners' }) => call<ChatConversation>('PATCH', `/chat/conversations/${enc(id)}`, b),
  join: (id: string) => call<ChatConversation>('POST', `/chat/conversations/${enc(id)}/join`),
  leave: (id: string) => call<{ left: boolean }>('POST', `/chat/conversations/${enc(id)}/leave`),
  archive: (id: string, archived: boolean) => call<ChatConversation>('POST', `/chat/conversations/${enc(id)}/archive`, { archived }),
  setMine: (id: string, b: { notifyLevel?: ChatNotifyLevel; muted?: boolean }) => call<ChatConversation>('PATCH', `/chat/conversations/${enc(id)}/me`, b),
  members: (id: string) => call<{ items: ChatMemberView[] }>('GET', `/chat/conversations/${enc(id)}/members`),
  addMembers: (id: string, userIds: string[], role?: ChatMemberRole) => call<{ items: ChatMemberView[] }>('POST', `/chat/conversations/${enc(id)}/members`, { userIds, ...(role ? { role } : {}) }),
  setRole: (id: string, userId: string, role: ChatMemberRole) => call<{ items: ChatMemberView[] }>('PATCH', `/chat/conversations/${enc(id)}/members/${enc(userId)}`, { role }),
  removeMember: (id: string, userId: string) => call<{ removed: boolean }>('DELETE', `/chat/conversations/${enc(id)}/members/${enc(userId)}`),
  mentionable: (id: string, q: string) => call<{ users: ChatPerson[] }>('GET', `/chat/conversations/${enc(id)}/mentionable`, undefined, { query: { q } }),
  people: (q: string) => call<{ users: ChatPerson[] }>('GET', '/chat/people', undefined, { query: { q } }),
  history: (id: string, o: { before?: number; after?: number; limit?: number } = {}) => call<HistoryPage>('GET', `/chat/conversations/${enc(id)}/messages`, undefined, { query: o }),
  send: (id: string, b: { body: string; parent?: string | null; files?: string[]; cards?: ChatCardRef[]; clientId: string }) => call<{ message: ChatMessageView; duplicate: boolean }>('POST', `/chat/conversations/${enc(id)}/messages`, { ...b, parent: b.parent ?? undefined }),
  replies: (messageId: string, o: { after?: number; limit?: number } = {}) => call<RepliesPage>('GET', `/chat/messages/${enc(messageId)}/replies`, undefined, { query: o }),
  edit: (messageId: string, body: string) => call<{ message: ChatMessageView }>('PATCH', `/chat/messages/${enc(messageId)}`, { body }),
  remove: (messageId: string) => call<{ deleted: boolean }>('DELETE', `/chat/messages/${enc(messageId)}`),
  react: (messageId: string, emoji: string, on: boolean) => call<{ message: ChatMessageView }>('POST', `/chat/messages/${enc(messageId)}/reactions`, { emoji, on }),
  report: (messageId: string, reason: string) => call<{ reported: boolean }>('POST', `/chat/messages/${enc(messageId)}/report`, { reason }),
  changes: (id: string, after: number) => call<ChatChanges>('GET', `/chat/conversations/${enc(id)}/changes`, undefined, { query: { after } }),
  markRead: (id: string, seq: number) => call<{ lastReadSeq: number; unread: number; mentions: number }>('POST', `/chat/conversations/${enc(id)}/read`, { seq }),
  typing: (id: string) => call<{ ok: boolean }>('POST', `/chat/conversations/${enc(id)}/typing`),
  upload: (id: string, file: File) => call<ChatFile>('POST', `/chat/conversations/${enc(id)}/files`, undefined, { raw: file, type: file.type || 'application/octet-stream', query: { name: file.name } }),
  discardFile: (fileId: string) => call<unknown>('DELETE', `/chat/files/${enc(fileId)}`),
  resolveCard: (messageId: string, index: number) => call<ChatCardView>('POST', '/chat/cards/resolve', { messageId, index }),
  search: (o: { q: string; channel?: string; page?: number }) => call<{ items: SearchHit[]; more: boolean }>('GET', '/chat/search', undefined, { query: o }),
}

/* ------------------------------------------------------------------ administrators (Admin console > Chat) */

export interface ChatAdminSettings {
  environmentId: string
  createChannels: 'everyone' | 'makers'
  retention: { channel: number | null; direct: number | null; group: number | null }
  readOnly: { id: string; name: string }[]
  canChangeEnvironment: boolean
  messages: number
}
export interface ChatAdminChannel {
  id: string; kind: ChatConversation['kind']; name: string; description: string; isPrivate: boolean; archived: boolean
  lastMessageOn: string | null; createdOn: string; createdBy: string | null; members: number; messages: number; openReports: number
}
export interface ChatAdminReport {
  id: string
  state: 'open' | 'handled'
  reason: string
  outcome: string | null
  createdOn: string | null
  reporter: { id: string; name: string }
  /** the reported message's text: the reporter chose to show it to the administrators */
  message: { id: string; text: string; deleted: boolean; sentOn: string | null; sender: { id: string; name: string } | null }
  /** name: channels only (direct and group conversations have none) */
  channel: { id: string; kind: string; name: string }
  handledBy: string | null
  handledOn: string | null
}
export interface ChatAdminExport {
  id: string
  channel: { id: string; kind: string; name: string }
  reason: string
  by: string
  createdOn: string | null
  expiresOn: string | null
  downloadedOn: string | null
  messages: number
  files: number
}

export const chatAdminApi = {
  settings: () => call<ChatAdminSettings>('GET', '/chat/admin/settings'),
  saveSettings: (b: { createChannels?: 'everyone' | 'makers'; retention?: Partial<ChatAdminSettings['retention']>; environmentId?: string }) => call<ChatAdminSettings>('PUT', '/chat/admin/settings', b),
  setReadOnly: (userId: string, readOnly: boolean) => call<unknown>('POST', '/chat/admin/readonly', { userId, readOnly }),
  channels: (o: { q?: string; kind?: string; offset?: number } = {}) => call<{ items: ChatAdminChannel[]; more: boolean }>('GET', '/chat/admin/channels', undefined, { query: o }),
  channelMembers: (id: string) => call<{ items: ChatMemberView[] }>('GET', `/chat/admin/channels/${enc(id)}/members`),
  archive: (id: string, archived: boolean) => call<unknown>('POST', `/chat/admin/channels/${enc(id)}/archive`, { archived }),
  removeMember: (id: string, userId: string) => call<unknown>('DELETE', `/chat/admin/channels/${enc(id)}/members/${enc(userId)}`),
  deleteChannel: (id: string, confirm: string) => call<unknown>('DELETE', `/chat/admin/channels/${enc(id)}`, { confirm }),
  moderate: (messageId: string, note?: string) => call<unknown>('POST', `/chat/admin/messages/${enc(messageId)}/moderate`, note ? { note } : {}),
  reports: (state: 'open' | 'handled' | 'all') => call<{ items: ChatAdminReport[] }>('GET', '/chat/admin/reports', undefined, { query: { state } }),
  handleReport: (id: string, action: 'delete' | 'dismiss') => call<unknown>('POST', `/chat/admin/reports/${enc(id)}`, { action }),
  exportChannel: (id: string, reason: string) => call<{ id: string; url: string; expiresOn: string }>('POST', `/chat/admin/channels/${enc(id)}/export`, { reason }),
  exports: () => call<{ items: ChatAdminExport[] }>('GET', '/chat/admin/exports'),
  runRetention: () => call<Record<string, unknown>>('POST', '/chat/admin/retention/run'),
  people: (q: string) => call<{ users: ChatPerson[] }>('GET', '/chat/people', undefined, { query: { q } }),
  /** confirm a recent sign-in (the export needs one): the person's own password or authenticator code */
  reauth: (password: string) => call<unknown>('POST', '/auth/reauth', { password }),
}

export const needsReauth = (e: unknown): boolean => e instanceof ChatApiError && e.code === 'reauth_required'

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
