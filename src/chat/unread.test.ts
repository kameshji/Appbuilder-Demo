import { describe, expect, it } from 'vitest'
import type { ChatConversation } from '@/platform/chat-protocol'
import {
  anyUnread, applyReadAnswer, applyUnreadEvent, badgeOf, countLabel, filterConversations, markReadLocal, removeConversation, setConversations,
  totalBadge, touchConversation, upsertConversation,
} from './unread'

function conv(id: string, o: Partial<ChatConversation> & { muted?: boolean; lastReadSeq?: number } = {}): ChatConversation {
  const { muted = false, lastReadSeq = 0, ...rest } = o
  return {
    id, kind: 'channel', name: id, description: '', isPrivate: false, archived: false, postingPolicy: 'everyone', lastSeq: 10, purgedSeq: 0,
    lastMessageOn: '2026-11-20T10:00:00.000Z', memberCount: 3,
    me: { role: 'member', lastReadSeq, notifyLevel: 'mentions', muted, joinedOn: null }, unread: 0, mentions: 0, canPost: true, ...rest,
  }
}

describe('conversation list', () => {
  it('orders by the latest message, archived last; only member conversations are listed', () => {
    const l = setConversations([
      conv('old', { lastMessageOn: '2026-11-19T10:00:00.000Z' }),
      conv('new', { lastMessageOn: '2026-11-20T12:00:00.000Z' }),
      conv('arch', { archived: true, lastMessageOn: '2026-11-21T00:00:00.000Z' }),
      conv('notme', { me: null }),
    ])
    expect(l.order).toEqual(['new', 'old', 'arch'])
    expect(upsertConversation(l, conv('old', { lastMessageOn: '2026-11-20T13:00:00.000Z' })).order[0]).toBe('old')
    expect(removeConversation(l, 'new').order).toEqual(['old', 'arch'])
    expect(upsertConversation(l, conv('new', { me: null })).byId.new).toBeUndefined()
  })
  it('a message seen live moves its conversation to the top', () => {
    const l = setConversations([conv('a', { lastMessageOn: '2026-11-20T10:00:00.000Z' }), conv('b', { lastMessageOn: '2026-11-20T11:00:00.000Z' })])
    const t = touchConversation(l, 'a', '2026-11-20T12:00:00.000Z', 11)
    expect(t.order[0]).toBe('a')
    expect(t.byId.a.lastSeq).toBe(11)
  })
})

describe('unread state machine', () => {
  const base = () => setConversations([conv('a', { unread: 3, mentions: 1, lastSeq: 10, lastReadSeq: 7 })])
  it('an event with counts (my own read marker moved, another tab) sets them', () => {
    const r = applyUnreadEvent(base(), { event: 'chat.unread', channelId: 'a', lastSeq: 10, lastReadSeq: 10, unread: 0, mentions: 0 })
    expect(r.refetch).toBe(false)
    expect(r.list.byId.a).toMatchObject({ unread: 0, mentions: 0, me: { lastReadSeq: 10 } })
  })
  it('an event without counts and a higher lastSeq asks the server; an old one does nothing', () => {
    const r = applyUnreadEvent(base(), { event: 'chat.unread', channelId: 'a', lastSeq: 12 })
    expect(r.refetch).toBe(true)
    expect(r.list.byId.a.lastSeq).toBe(12)
    // counts are not guessed: an edit or a reaction also moves lastSeq
    expect(r.list.byId.a.unread).toBe(3)
    expect(applyUnreadEvent(r.list, { event: 'chat.unread', channelId: 'a', lastSeq: 11 }).refetch).toBe(false)
  })
  it('an event for a conversation not in the list asks the server (it may have been added)', () => {
    expect(applyUnreadEvent(base(), { event: 'chat.unread', channelId: 'zz', lastSeq: 1 }).refetch).toBe(true)
  })
  it('reading to the end clears the counts at once; reading part of it leaves them for the server', () => {
    expect(markReadLocal(base(), 'a', 10).byId.a).toMatchObject({ unread: 0, mentions: 0 })
    expect(markReadLocal(base(), 'a', 8).byId.a).toMatchObject({ unread: 3, me: { lastReadSeq: 8 } })
    // never backwards
    expect(markReadLocal(base(), 'a', 5)).toEqual(base())
    expect(applyReadAnswer(base(), 'a', { lastReadSeq: 9, unread: 1, mentions: 0 }).byId.a).toMatchObject({ unread: 1, mentions: 0, me: { lastReadSeq: 9 } })
  })
})

describe('the badge', () => {
  it('direct and group: unread messages; channels: unread mentions; muted: nothing', () => {
    expect(badgeOf(conv('d', { kind: 'direct', unread: 4 }))).toBe(4)
    expect(badgeOf(conv('g', { kind: 'group', unread: 2, mentions: 1 }))).toBe(2)
    expect(badgeOf(conv('c', { unread: 9, mentions: 2 }))).toBe(2)
    expect(badgeOf(conv('m', { kind: 'direct', unread: 4, muted: true }))).toBe(0)
    const l = setConversations([conv('d', { kind: 'direct', unread: 4 }), conv('c', { unread: 9, mentions: 2 }), conv('m', { unread: 5, mentions: 5, muted: true })])
    expect(totalBadge(l)).toBe(6)
    expect(anyUnread(setConversations([conv('c', { unread: 1 })]))).toBe(true)
    expect(anyUnread(setConversations([conv('c', { unread: 1, muted: true })]))).toBe(false)
    expect(countLabel(120)).toBe('99+')
  })
})

describe('the list search box', () => {
  it('matches names, descriptions and the people of direct conversations, every word', () => {
    const list = [conv('Quality', { description: 'NCR and inspections' }), conv('dm', { kind: 'direct', name: 'Ravi Kumar', members: [{ id: 'u2', name: 'Ravi Kumar' }] })]
    expect(filterConversations(list, 'qual').map((c) => c.id)).toEqual(['Quality'])
    expect(filterConversations(list, 'ncr insp').map((c) => c.id)).toEqual(['Quality'])
    expect(filterConversations(list, 'ravi').map((c) => c.id)).toEqual(['dm'])
    expect(filterConversations(list, '  ')).toHaveLength(2)
  })
})
