/**
 * Chat protocol (P3 package A; docs/dev/chat.md): the shapes of the chat HTTP API (/api/v1/chat/*) and of the chat
 * messages on the live connection. Shared by the server (server/core/chat/) and the browser (package B), so this file
 * follows the server's rules: no React, no DOM, no `@/` alias, erasable TypeScript only, relative `.ts` imports.
 *
 * Live topics (install-wide: subscribe WITHOUT `env`; the server resolves them against the chat environment):
 *   chat:<channelId>          every change of one conversation, in order (seq / prev, contiguous per channel)
 *   chat:typing:<channelId>   who is typing (not stored)
 *   user:<me>                 (exists) gains the events chat.unread and chat.channels
 */

/** limits (default 18 of docs/plan/p3-spec.md), enforced by the server */
export const CHAT_LIMITS = {
  /** characters of the plain text of a message */
  maxTextChars: 4000,
  /** characters of the stored rich text of a message */
  maxBodyChars: 20000,
  /** files per message */
  maxFiles: 10,
  /** bytes per file (the attachment store's limit for Documents) */
  maxFileBytes: 25 * 1024 * 1024,
  /** messages per person and minute (sends, all conversations together) */
  sendsPerMinute: 30,
  /** members of one channel */
  maxChannelMembers: 1000,
  /** people in a group conversation (the creator included) */
  maxGroupMembers: 8,
  /** cards per message */
  maxCards: 3,
  /** fields a record card shows */
  maxCardFields: 6,
  /** one typing event per person and conversation per this many ms */
  typingIntervalMs: 3000,
  /** a history page */
  pageSize: 50,
  /** a search page */
  searchPageSize: 20,
  /** @channel by anyone up to this many members; above it owners and administrators only */
  channelMentionMembers: 50,
  /** a file must have been uploaded by the sender within this many ms before it is named in a message */
  fileClaimMs: 60 * 60 * 1000,
  /** retention: the shortest period an administrator may set (days) */
  minRetentionDays: 30,
} as const

/** the reactions offered in this phase (any other is refused) */
export const CHAT_EMOJI: readonly string[] = ['👍', '👎', '❤️', '😄', '🎉', '😮', '😢', '🙏', '👀', '✅', '❌', '🔥']

export type ChatKind = 'channel' | 'direct' | 'group'
export type ChatNotifyLevel = 'all' | 'mentions' | 'none'
export type ChatMemberRole = 'member' | 'owner'

export interface ChatPerson { id: string; name: string }

/** a conversation as one reader sees it (GET /chat/conversations) */
export interface ChatConversation {
  id: string
  kind: ChatKind
  /** channels: the channel name; direct and group: the other people's names (computed for the reader) */
  name: string
  description: string
  isPrivate: boolean
  archived: boolean
  postingPolicy: 'everyone' | 'owners'
  /** the change counter: the seq of the latest change */
  lastSeq: number
  /** changes up to this seq were removed by retention (history below it is gone) */
  purgedSeq: number
  lastMessageOn: string | null
  memberCount: number
  /** direct and group conversations: the people in it */
  members?: ChatPerson[]
  /** null: not a member (an open channel the reader may join) */
  me: { role: ChatMemberRole; lastReadSeq: number; notifyLevel: ChatNotifyLevel; muted: boolean; joinedOn: string | null } | null
  /** messages from others after lastReadSeq (top-level and replies) */
  unread: number
  /** unread mentions of the reader (or @channel) */
  mentions: number
  /** may the reader post (member, not archived, posting policy, not read-only in chat) */
  canPost: boolean
  /**
   * a conversation from Appbuilder itself (package E): 'approvals' is each person's direct conversation with the system
   * sender "Approvals", which carries approval cards. Nobody posts in it; its cards are answered with their buttons.
   */
  system?: 'approvals'
}

/** a card reference stored in a message (never values; resolved per reader with POST /chat/cards/resolve) */
export type ChatCardRef =
  | { kind: 'record'; env: string; table: string; row: string; fields: string[] }
  | { kind: 'app'; env: string; app: string; screen?: string }
  | { kind: 'dashboard'; env: string; dashboard: string }
  /**
   * an approval request (package E): only the system sender "Approvals" posts these (never a person: parseCards on the
   * server refuses the kind), one per assignment of the approver; `state` is 'pending' until the assignment or the
   * request is no longer waiting for this person, then 'done' (the card is pushed as an edit so readers resolve again)
   */
  | { kind: 'approval'; env: string; request: string; assignment: string; state: 'pending' | 'done' }

/** an approval card as its reader may see it (the same visibility rule as the inbox: canSee) */
export interface ChatApprovalCardView {
  available: true
  kind: 'approval'
  env: string
  request: string
  title: string
  /** pending, info, approved, rejected, completed, cancelled, expired */
  status: string
  outcome: string | null
  requestedByName: string | null
  dueOn: string | null
  /** the fields the requester declared (shown to everyone who may see the request, as in the inbox) */
  fields: { name: string; value: unknown }[]
  /** the record, only when THIS reader may read it */
  record: { tableName: string; title: string } | null
  /** the answers offered; requireComment: the server refuses the answer without a comment */
  options: { label: string; kind: string; requireComment: boolean }[]
  /** the reader holds a pending assignment of the current stage (and the request waits for answers) */
  canDecide: boolean
  /** the reader's own answer, once given */
  myAnswer: { response: string; comment: string | null; at: string | null } | null
}

/** POST /chat/cards/resolve answer */
export type ChatCardView =
  | { available: false; kind: ChatCardRef['kind'] }
  | { available: true; kind: 'record'; env: string; table: string; tableName: string; row: string; title: string | null; fields: { name: string; displayName: string; type: string; value: unknown }[] }
  | { available: true; kind: 'app'; env: string; app: string; name: string; description: string; screen?: string }
  | { available: true; kind: 'dashboard'; env: string; dashboard: string; name: string; description: string }
  | ChatApprovalCardView

export interface ChatFile { id: string; name: string; mime: string; size: number; url: string }

export interface ChatReaction { emoji: string; users: string[] }

/** a message as readers see it (history, replies, changes, pushes) */
export interface ChatMessageView {
  id: string
  channelId: string
  /** the change counter value of its creation (orders the history) */
  seq: number
  /** the change counter value of its latest change (edit, delete, reaction, reply count) */
  changeSeq: number
  kind: 'message' | 'system'
  /** thread root (one level of threads) */
  parentId: string | null
  /** sanitised rich text (RICH_TEXT_TAGS of src/platform/system-tables.ts); empty when deleted */
  body: string
  /** plain text of the body */
  text: string
  sender: ChatPerson | null
  createdOn: string
  editedOn: string | null
  deleted: boolean
  /** deleted by an administrator (moderation) rather than by the sender */
  moderated: boolean
  mentions: string[]
  mentionsChannel: boolean
  files: ChatFile[]
  cards: ChatCardRef[]
  reactions: ChatReaction[]
  replyCount: number
  lastReplyOn: string | null
  /** system messages: what happened (members, channel, export) */
  event?: { type: 'members' | 'channel' | 'export'; [k: string]: unknown }
}

/** GET /chat/conversations/:id/changes?after=<seq> */
export interface ChatChanges {
  channelId: string
  lastSeq: number
  purgedSeq: number
  /** after was below purgedSeq (retention removed history): reload the conversation from the latest page */
  reset: boolean
  /** messages whose latest change is after `after`, in change order (including deleted ones) */
  messages: ChatMessageView[]
  /** the conversation now (always) */
  conversation: ChatConversation
  /** the members now, when a member change happened after `after` */
  members?: ChatMemberView[]
  /** the answer is one full page (CHAT_CHANGES_PAGE messages): ask again after the last changeSeq it carries */
  more?: boolean
}

/** the most messages one /changes answer carries */
export const CHAT_CHANGES_PAGE = 1000

export interface ChatMemberView { id: string; name: string; role: ChatMemberRole; joinedOn: string | null }

/** live: a change of one conversation (topic chat:<channelId>) */
export interface ChatPushMessage {
  t: 'chat'
  topic: string
  channelId: string
  seq: number
  /** seq - 1: counters are contiguous per channel, so prev not equal to the last seq seen means a gap */
  prev: number
  op: 'message' | 'edit' | 'delete' | 'reaction' | 'members' | 'channel'
  /** the message created or changed (system messages for members and channel changes); never resolved card contents */
  message?: ChatMessageView
  at: string
  /** the change came from this connection's own request (X-Appbuilder-Live) */
  self?: true
}

/** live: someone is typing (topic chat:typing:<channelId>) */
export interface ChatTypingMessage { t: 'typing'; topic: string; channelId: string; userId: string; name: string; at: string }

/** live user events (topic user:<me>) added by chat */
export type ChatUserEvent =
  /** a conversation changed (lastSeq) or the reader's own read marker moved (lastReadSeq, unread, mentions: only then) */
  | { event: 'chat.unread'; channelId: string; lastSeq: number; lastReadSeq?: number; unread?: number; mentions?: number }
  | { event: 'chat.channels'; channelId: string; change: 'added' | 'removed' | 'updated' }

export const chatTopic = (channelId: string): string => `chat:${channelId}`
export const chatTypingTopic = (channelId: string): string => `chat:typing:${channelId}`

const CHANNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** a chat topic -> its channel and kind; null when it is not a well-formed chat topic */
export function parseChatTopic(topic: unknown): { kind: 'chat' | 'typing'; channelId: string } | null {
  if (typeof topic !== 'string' || topic.length > 100) return null
  if (topic.startsWith('chat:typing:')) {
    const id = topic.slice('chat:typing:'.length)
    return CHANNEL_ID.test(id) ? { kind: 'typing', channelId: id } : null
  }
  if (topic.startsWith('chat:')) {
    const id = topic.slice('chat:'.length)
    return CHANNEL_ID.test(id) ? { kind: 'chat', channelId: id } : null
  }
  return null
}

/** the in-app link of a chat notification: #chat?c=<channelId>&m=<seq> */
export const chatLink = (channelId: string, seq: number): string => `#chat?c=${channelId}&m=${seq}`
