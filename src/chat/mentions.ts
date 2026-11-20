/**
 * Chat mentions on the Mentions page (P3 package E, follow-up b of package B): a chat mention is a Mentions row about a
 * message of the chat environment. The page's own list (GET /collab/mentions) reads the CURRENT environment's
 * Mentions and has no text or link for them; GET /chat/mentions reads the chat environment from any environment,
 * applies the conversation's read rule again and carries the link that opens the message (#chat?c=..&m=..).
 */
import type { MentionItem } from '@/platform/collab-api'
import { SYS } from '@/platform/system-tables'
import { chatApi, type ChatMentionItem } from './api'
import { parseChatLink } from './deeplink'
import { openChat } from './open'

export const isChatMention = (m: Pick<MentionItem, 'regardingTable'>): boolean => m.regardingTable === SYS.messages

/** a chat mention in the Mentions page's shape ("mentioned you on Chat: #Quality") */
export function chatMentionItem(c: ChatMentionItem): MentionItem {
  return {
    id: c.id, Comment: null, IsRead: c.IsRead, createdOn: c.createdOn, regardingTable: SYS.messages, regardingId: c.regardingId,
    regardingLabel: c.conversation, regardingTableName: 'Chat', Body: c.Body, Link: c.Link, byName: c.byName,
  }
}

/** the page's mentions and the chat mentions, newest first; chat rows the page's list holds without text are replaced */
export function mergeMentions(page: MentionItem[], chat: MentionItem[]): MentionItem[] {
  const ids = new Set(chat.map((m) => m.id))
  return [...page.filter((m) => !isChatMention(m) && !ids.has(m.id)), ...chat].sort((a, b) => (a.createdOn === b.createdOn ? (a.id < b.id ? 1 : -1) : a.createdOn < b.createdOn ? 1 : -1))
}

/** the chat mentions (none when chat is not available to this person) */
export async function loadChatMentions(): Promise<MentionItem[]> {
  try {
    return (await chatApi.mentions()).items.map(chatMentionItem)
  } catch {
    return []
  }
}

/** opens the mentioned message in chat (the dock, the pop-out or the phone screen) and marks the mention read */
export async function openChatMention(m: MentionItem): Promise<void> {
  if (!m.IsRead) await chatApi.mentionRead(m.id).catch(() => {})
  const t = parseChatLink(m.Link ?? '')
  if (t) openChat(t)
}
