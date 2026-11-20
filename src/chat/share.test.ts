/** Share to chat and chat mentions (package E): the pure rules (the server decides what each reader sees). */
import { describe, expect, it } from 'vitest'
import type { ChatConversation } from '@/platform/chat-protocol'
import type { MentionItem } from '@/platform/collab-api'
import { cardFor, postable, shareableColumns } from './share'
import { chatMentionItem, isChatMention, mergeMentions } from './mentions'

const conv = (o: Partial<ChatConversation>): ChatConversation => ({
  id: 'c', kind: 'channel', name: 'x', description: '', isPrivate: true, archived: false, postingPolicy: 'everyone', lastSeq: 0, purgedSeq: 0,
  lastMessageOn: null, memberCount: 1, me: { role: 'member', lastReadSeq: 0, notifyLevel: 'all', muted: false, joinedOn: null }, unread: 0, mentions: 0, canPost: true, ...o,
})

describe('share to chat', () => {
  it('offers only conversations the sharer may post to, never Appbuilder\'s own', () => {
    const list = [conv({ id: 'a' }), conv({ id: 'b', canPost: false }), conv({ id: 'c', archived: true }), conv({ id: 'd', kind: 'direct', system: 'approvals', canPost: false }), conv({ id: 'e', kind: 'group' })]
    expect(postable(list).map((c) => c.id)).toEqual(['a', 'e'])
  })
  it('a card is a reference: the record, the environment and at most 6 field names, never values', () => {
    const c = cardFor({ kind: 'record', table: 'tbl_orders', row: 'r1' }, 'default', ['A', 'B', 'C', 'D', 'E', 'F', 'G'])
    expect(c).toEqual({ kind: 'record', env: 'default', table: 'tbl_orders', row: 'r1', fields: ['A', 'B', 'C', 'D', 'E', 'F'] })
    expect(cardFor({ kind: 'app', app: 'app_1' }, 'prod', [])).toEqual({ kind: 'app', env: 'prod', app: 'app_1' })
    expect(cardFor({ kind: 'dashboard', dashboard: 'dsh_1' }, 'prod', ['x'])).toEqual({ kind: 'dashboard', env: 'prod', dashboard: 'dsh_1' })
  })
  it('field choices leave out system columns, the id, the primary column and files', () => {
    const cols = [
      { name: 'id', type: 'text', system: true }, { name: 'Title', type: 'text' }, { name: 'Amount', displayName: 'Amount (INR)', type: 'number' },
      { name: 'Photo', type: 'image' }, { name: 'createdOn', type: 'datetime', system: true },
    ]
    expect(shareableColumns(cols, 'Title')).toEqual([{ name: 'Amount', label: 'Amount (INR)' }])
  })
})

describe('chat mentions on the Mentions page', () => {
  const page: MentionItem[] = [
    { id: 'm1', Comment: 'c1', IsRead: false, createdOn: '2026-11-20T10:00:00.000Z', regardingTable: 'tbl_orders', regardingId: 'r1', Body: '<p>x</p>', Link: '#u-app?record=r1', byName: 'Asha' },
    // the chat environment's own list holds chat mentions without text or link: replaced by the chat route's rows
    { id: 'm2', Comment: null, IsRead: false, createdOn: '2026-11-20T11:00:00.000Z', regardingTable: 'sys_messages', regardingId: 'msg1', Body: null, Link: null, byName: null },
  ]
  const chat = [chatMentionItem({ id: 'm2', IsRead: false, createdOn: '2026-11-20T11:00:00.000Z', Body: 'please check pump 4', Link: '#chat?c=11111111-1111-4111-8111-111111111111&m=7', byName: 'Bina', conversation: '#Maintenance', regardingTable: 'sys_messages', regardingId: 'msg1' })]
  it('merges, newest first, and every chat row carries the link that opens the message', () => {
    const all = mergeMentions(page, chat)
    expect(all.map((m) => m.id)).toEqual(['m2', 'm1'])
    expect(all[0].Link).toBe('#chat?c=11111111-1111-4111-8111-111111111111&m=7')
    expect(all[0].regardingTableName).toBe('Chat')
    expect(all[0].regardingLabel).toBe('#Maintenance')
    expect(isChatMention(all[0])).toBe(true)
    expect(isChatMention(all[1])).toBe(false)
  })
})
