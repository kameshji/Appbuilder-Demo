/**
 * Optimistic sending (pure). A message shows at once as "sending"; it carries a client id, so a retried send (after a
 * lost answer, a failure, a reconnect) finds the first message on the server instead of making a second one
 * (docs/dev/chat.md: `clientId`). It leaves the pending list when the server's message is known: from the send's answer
 * or, if the live push is faster, from the push (matched by sender, place and text).
 * Chat sending needs a connection (spec 5.3): nothing is queued across reloads, and nothing is kept in browser storage.
 */
import type { ChatCardRef, ChatFile, ChatMessageView } from '@/platform/chat-protocol'

export interface PendingSend {
  clientId: string
  channelId: string
  parentId: string | null
  body: string
  /** plain text, for matching the server's message and for the screen */
  text: string
  files: ChatFile[]
  cards: ChatCardRef[]
  state: 'sending' | 'failed'
  /** failed: why, in words */
  error?: string
  /** failed: may it be retried as it is (network, rate limit, server error) or must it be changed (refused) */
  retryable?: boolean
  createdOn: string
  attempts: number
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** 8 to 80 of A-Za-z0-9_.:- (the server's rule); random part from crypto when there is one */
export function newClientId(random: () => number = Math.random, now = Date.now()): string {
  let r = ''
  for (let i = 0; i < 16; i++) r += ALPHABET[Math.floor(random() * ALPHABET.length) % ALPHABET.length]
  return `c${now.toString(36)}.${r}`
}

export const CLIENT_ID = /^[A-Za-z0-9_.:-]{8,80}$/

export function createPending(o: { clientId: string; channelId: string; parentId?: string | null; body: string; text: string; files?: ChatFile[]; cards?: ChatCardRef[]; now?: Date }): PendingSend {
  return {
    clientId: o.clientId, channelId: o.channelId, parentId: o.parentId ?? null, body: o.body, text: o.text, files: o.files ?? [], cards: o.cards ?? [],
    state: 'sending', createdOn: (o.now ?? new Date()).toISOString(), attempts: 1,
  }
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/** does this server message answer this pending send? */
export function matches(p: PendingSend, m: ChatMessageView, me: string): boolean {
  return m.kind === 'message' && m.sender?.id === me && m.channelId === p.channelId && (m.parentId ?? null) === p.parentId
    && norm(m.text) === norm(p.text) && m.files.length === p.files.length
}

/** a server message arrived (push or answer): the oldest pending send it answers leaves the list */
export function reconcile(list: PendingSend[], m: ChatMessageView, me: string): PendingSend[] {
  const i = list.findIndex((p) => p.state === 'sending' && matches(p, m, me))
  if (i < 0) return list
  return [...list.slice(0, i), ...list.slice(i + 1)]
}

export function removePending(list: PendingSend[], clientId: string): PendingSend[] {
  return list.filter((p) => p.clientId !== clientId)
}

export function failPending(list: PendingSend[], clientId: string, error: string, retryable: boolean): PendingSend[] {
  return list.map((p) => (p.clientId === clientId ? { ...p, state: 'failed' as const, error, retryable } : p))
}

export function retryPending(list: PendingSend[], clientId: string): PendingSend[] {
  return list.map((p) => (p.clientId === clientId ? { ...p, state: 'sending' as const, error: undefined, retryable: undefined, attempts: p.attempts + 1 } : p))
}

/** an error of a send: may the same send be tried again as it is? (no answer, 5xx, 429 yes; 4xx refusals no) */
export function retryableError(status: number): boolean {
  return status === 0 || status === 429 || status >= 500
}

/** the pending sends of one place (a conversation, or one thread), oldest first */
export function pendingFor(list: PendingSend[], channelId: string, parentId: string | null): PendingSend[] {
  return list.filter((p) => p.channelId === channelId && p.parentId === parentId)
}
