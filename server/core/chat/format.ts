/**
 * Chat message format (P3-A, docs/dev/chat.md "Message format"): pure functions, unit-tested.
 *
 *  - body: the comment rich-text subset (sanitizeRichText), sanitised on every write; the plain text (BodyText) is derived
 *    here, never taken from the client;
 *  - mentions: `<span data-mention="<userId>">` (people) and `<span data-mention="channel">` (@channel), extracted from the
 *    sanitised body only;
 *  - cards: at most 3 references (never values), checked for shape;
 *  - search: the reader's words -> a PostgreSQL tsquery with prefix matching, built from letters and digits only (no
 *    tsquery syntax from the client can reach the database).
 */
import { createHash } from 'node:crypto'
import { HttpError } from '../contracts.ts'
import { mentionedUserIds, richTextToPlain, sanitizeRichText } from '../../../src/platform/system-tables.ts'
import { CHAT_EMOJI, CHAT_LIMITS } from '../../../src/platform/chat-protocol.ts'
import type { ChatCardRef } from '../../../src/platform/chat-protocol.ts'

const invalid = (message: string, field?: string) => new HttpError(422, 'invalid', message, field)

export interface ParsedBody {
  body: string
  text: string
  /** people mentioned (ids), without "channel" */
  mentions: string[]
  mentionsChannel: boolean
}

/** a client body -> what is stored (refuses text above the limits) */
export function parseBody(raw: unknown): ParsedBody {
  if (raw !== undefined && raw !== null && typeof raw !== 'string') throw invalid('body must be text.', 'body')
  const src = String(raw ?? '')
  if (src.length > CHAT_LIMITS.maxBodyChars * 2) throw invalid(`The message is too long (at most ${CHAT_LIMITS.maxTextChars} characters).`, 'body')
  const body = sanitizeRichText(src, CHAT_LIMITS.maxBodyChars + 1)
  if (body.length > CHAT_LIMITS.maxBodyChars) throw invalid(`The message is too long (at most ${CHAT_LIMITS.maxTextChars} characters).`, 'body')
  const text = richTextToPlain(body)
  if (text.length > CHAT_LIMITS.maxTextChars) throw invalid(`The message is too long (at most ${CHAT_LIMITS.maxTextChars} characters).`, 'body')
  const ids = mentionedUserIds(body)
  return { body, text, mentions: ids.filter((x) => x !== 'channel'), mentionsChannel: ids.includes('channel') }
}

/** the stored MentionIds JSON: the people, plus "channel" for @channel */
export function mentionIdsJson(p: { mentions: string[]; mentionsChannel: boolean }): string | null {
  const all = [...p.mentions, ...(p.mentionsChannel ? ['channel'] : [])]
  return all.length ? JSON.stringify(all) : null
}

export function parseJsonList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (typeof v !== 'string' || !v) return []
  try {
    const x = JSON.parse(v)
    return Array.isArray(x) ? x : []
  } catch {
    return []
  }
}

const ENV_ID = /^[a-z][a-z0-9_]{0,39}$/
const REF_ID = /^[A-Za-z0-9_.:-]{1,128}$/
const COL = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** client cards -> stored references (shape only; access is decided per reader when a card is resolved) */
export function parseCards(raw: unknown): ChatCardRef[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw invalid('cards must be a list.', 'cards')
  if (raw.length > CHAT_LIMITS.maxCards) throw invalid(`At most ${CHAT_LIMITS.maxCards} cards per message.`, 'cards')
  return raw.map((c, i): ChatCardRef => {
    const o = c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {}
    const env = typeof o.env === 'string' && ENV_ID.test(o.env) ? o.env : ''
    if (!env) throw invalid(`Card ${i + 1}: env must name an environment.`, 'cards')
    const id = (k: string) => {
      const v = o[k]
      if (typeof v !== 'string' || !REF_ID.test(v)) throw invalid(`Card ${i + 1}: ${k} is missing or not valid.`, 'cards')
      return v
    }
    if (o.kind === 'record') {
      const fields = Array.isArray(o.fields) ? [...new Set(o.fields.filter((f): f is string => typeof f === 'string' && COL.test(f)))] : []
      if (fields.length > CHAT_LIMITS.maxCardFields) throw invalid(`Card ${i + 1}: at most ${CHAT_LIMITS.maxCardFields} fields.`, 'cards')
      return { kind: 'record', env, table: id('table'), row: id('row'), fields }
    }
    if (o.kind === 'app') return { kind: 'app', env, app: id('app'), ...(typeof o.screen === 'string' && REF_ID.test(o.screen) ? { screen: o.screen } : {}) }
    if (o.kind === 'dashboard') return { kind: 'dashboard', env, dashboard: id('dashboard') }
    throw invalid(`Card ${i + 1}: kind is record, app or dashboard.`, 'cards')
  })
}

export function checkEmoji(raw: unknown): string {
  if (typeof raw !== 'string' || !CHAT_EMOJI.includes(raw)) throw invalid(`emoji must be one of ${CHAT_EMOJI.join(' ')}.`, 'emoji')
  return raw
}

/**
 * The reader's words -> a tsquery for to_tsquery('simple', ...): every word becomes `word:*` (prefix), words are ANDed.
 * Only letters (with their combining marks: Devanagari vowel signs) and digits survive (any script), lower-cased; at most 8 words of at most 40 characters. null when nothing
 * is left (the search answers no hits without a query).
 */
export function searchQuery(q: unknown): string | null {
  if (typeof q !== 'string') return null
  const words = q.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []
  const list = [...new Set(words.map((w) => w.slice(0, 40)))].filter(Boolean).slice(0, 8)
  return list.length ? list.map((w) => `${w}:*`).join(' & ') : null
}

/** a short plain preview of a message for notifications (no card values exist in the text) */
export function preview(text: string, max = 140): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** the stable id of a message a client sends with a clientId (a retried send finds the first one) */
export function messageIdFor(userId: string, channelId: string, clientId: string): string {
  const h = createHash('sha256').update(`chat.message\u0000${userId}\u0000${channelId}\u0000${clientId}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}
