import { describe, expect, it } from 'vitest'
import type { ChatChanges, ChatConversation, ChatMessageView, ChatPushMessage } from '@/platform/chat-protocol'
import {
  CHANGES_PAGE, applyChanges, applyHistory, applyPush, applyReplies, closeThread, emptyTimeline, findBySeq, firstUnread, newer, openThread,
  patchMessage, toggleReaction, upsertMessage, upsertSorted, type Timeline,
} from './timeline'

const CH = '11111111-1111-4111-8111-111111111111'
function msg(seq: number, o: Partial<ChatMessageView> = {}): ChatMessageView {
  return {
    id: o.id ?? `m${seq}`, channelId: CH, seq, changeSeq: o.changeSeq ?? seq, kind: 'message', parentId: null, body: `<p>${seq}</p>`, text: String(seq),
    sender: { id: 'u1', name: 'Asha' }, createdOn: new Date(1_700_000_000_000 + seq * 1000).toISOString(), editedOn: null, deleted: false, moderated: false,
    mentions: [], mentionsChannel: false, files: [], cards: [], reactions: [], replyCount: 0, lastReplyOn: null, ...o,
  }
}
const page = (seqs: number[], more: boolean, lastSeq = Math.max(0, ...seqs)) => ({ messages: seqs.map((s) => msg(s)), more, lastSeq, purgedSeq: 0 })
const push = (seq: number, op: ChatPushMessage['op'], message?: ChatMessageView, prev = seq - 1): ChatPushMessage => ({ t: 'chat', topic: `chat:${CH}`, channelId: CH, seq, prev, op, message, at: new Date().toISOString() })
const loaded = (seqs: number[], more = false, lastSeq?: number): Timeline => applyHistory(emptyTimeline(CH), page(seqs, more, lastSeq), 'latest')
const seqs = (t: Timeline) => t.items.map((m) => m.seq)
const conv = { id: CH } as ChatConversation
const changes = (_after: number, list: ChatMessageView[], lastSeq: number, o: Partial<ChatChanges> = {}): ChatChanges => ({ channelId: CH, lastSeq, purgedSeq: 0, reset: false, messages: list, conversation: conv, ...o })

describe('history pages', () => {
  it('the latest page sets the window and the applied seq; older pages prepend and keep order', () => {
    let t = loaded([51, 52, 53], true, 60)
    expect(seqs(t)).toEqual([51, 52, 53])
    expect(t.applied).toBe(60)
    expect(t.hasOlder).toBe(true)
    t = applyHistory(t, page([48, 49, 50], false), 'older')
    expect(seqs(t)).toEqual([48, 49, 50, 51, 52, 53])
    expect(t.hasOlder).toBe(false)
    expect(t.applied).toBe(60)
  })
  it('a page never duplicates a message it already holds, and keeps the newer version', () => {
    let t = loaded([1, 2, 3])
    t = upsertMessage(t, msg(2, { changeSeq: 9, text: 'edited' }))
    t = applyHistory(t, page([1, 2, 3], false), 'latest')
    expect(seqs(t)).toEqual([1, 2, 3])
    expect(t.items[1].text).toBe('edited')
  })
  it('a reload of the latest page keeps older pages already held', () => {
    let t = loaded([51, 52], true)
    t = applyHistory(t, page([49, 50], true), 'older')
    t = applyHistory(t, page([51, 52, 53], true, 53), 'latest')
    expect(seqs(t)).toEqual([49, 50, 51, 52, 53])
    expect(t.hasOlder).toBe(true)
  })
  it('thread replies are not part of the top-level list', () => {
    const t = applyHistory(emptyTimeline(CH), { messages: [msg(1), msg(2, { parentId: 'm1' })], more: false, lastSeq: 2, purgedSeq: 0 }, 'latest')
    expect(seqs(t)).toEqual([1])
  })
})

describe('live pushes: order, gaps, exactly once', () => {
  it('applies contiguous pushes and ignores old ones', () => {
    let t = loaded([1, 2], false, 2)
    const r = applyPush(t, push(3, 'message', msg(3)))
    expect(r.kind).toBe('applied')
    t = (r as { t: Timeline }).t
    expect(seqs(t)).toEqual([1, 2, 3])
    expect(t.applied).toBe(3)
    expect(applyPush(t, push(3, 'message', msg(3))).kind).toBe('old')
    expect(applyPush(t, push(2, 'edit', msg(2, { changeSeq: 2 }))).kind).toBe('old')
  })
  it('a missing change is a gap: nothing is applied, recovery asks after the last applied seq', () => {
    const t = loaded([1, 2], false, 2)
    expect(applyPush(t, push(5, 'message', msg(5), 4))).toEqual({ kind: 'gap', after: 2 })
  })
  it('a channel push without a message (retention) asks for a reload', () => {
    const t = loaded([10], false, 10)
    expect(applyPush(t, push(11, 'channel')).kind).toBe('reload')
  })
  it('a push of another conversation is ignored', () => {
    const t = loaded([1], false, 1)
    expect(applyPush(t, { ...push(2, 'message', msg(2)), channelId: 'other' }).kind).toBe('old')
  })
  it('edits, deletes and reactions replace the message by id with the newer change', () => {
    let t = loaded([1, 2], false, 2)
    t = (applyPush(t, push(3, 'edit', msg(1, { changeSeq: 3, text: 'one!' }))) as { t: Timeline }).t
    t = (applyPush(t, push(4, 'delete', msg(2, { changeSeq: 4, deleted: true, body: '' }))) as { t: Timeline }).t
    t = (applyPush(t, push(5, 'reaction', msg(1, { changeSeq: 5, text: 'one!', reactions: [{ emoji: '👍', users: ['u2'] }] }))) as { t: Timeline }).t
    expect(seqs(t)).toEqual([1, 2])
    expect(t.items[0]).toMatchObject({ text: 'one!', reactions: [{ emoji: '👍', users: ['u2'] }] })
    expect(t.items[1].deleted).toBe(true)
    // an older answer arriving late never overwrites the newer push
    t = upsertMessage(t, msg(1, { changeSeq: 3, text: 'one!' }))
    expect(t.items[0].reactions).toHaveLength(1)
  })
  it('a socket cut while 20 messages are sent: /changes recovers all 20 exactly once and in order', () => {
    let t = loaded([1, 2, 3], false, 3)
    // two arrived live before the cut
    for (const s of [4, 5]) t = (applyPush(t, push(s, 'message', msg(s))) as { t: Timeline }).t
    // 20 more while away; the changes answer also repeats the two already applied (after was 5: not here) and an edit of 4
    const missed = Array.from({ length: 20 }, (_, i) => msg(6 + i))
    const r = applyChanges(t, changes(5, [...missed, msg(4, { changeSeq: 26, text: 'four (edited)' })], 26))
    t = r.t
    expect(r.reload).toBe(false)
    expect(seqs(t)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
    expect(t.applied).toBe(26)
    expect(t.items[3].text).toBe('four (edited)')
    // a late duplicate push of the same changes changes nothing
    expect(applyPush(t, push(10, 'message', msg(10))).kind).toBe('old')
    // applying the same answer again changes nothing
    expect(seqs(applyChanges(t, changes(5, missed, 26)).t)).toEqual(seqs(t))
  })
  it('a full /changes page moves applied only to its last change and asks for more', () => {
    const t = loaded([1], false, 1)
    const list = Array.from({ length: CHANGES_PAGE }, (_, i) => msg(2 + i))
    const r = applyChanges(t, changes(1, list, 5000))
    expect(r.more).toBe(true)
    expect(r.t.applied).toBe(CHANGES_PAGE + 1)
  })
  it('reset (after was below purgedSeq) empties the timeline and asks for a reload', () => {
    const r = applyChanges(loaded([5, 6], false, 6), changes(1, [], 9, { reset: true, purgedSeq: 7 }))
    expect(r.reload).toBe(true)
    expect(r.t.loaded).toBe(false)
    expect(r.t.items).toEqual([])
  })
  it('a live message older than the loaded window is not inserted (it would leave a hole)', () => {
    const t = loaded([50, 51], true, 51)
    expect(seqs(upsertMessage(t, msg(10)))).toEqual([50, 51])
    // but an update of a loaded message is applied
    expect(upsertMessage(t, msg(50, { changeSeq: 60, text: 'x' })).items[0].text).toBe('x')
  })
})

describe('threads', () => {
  it('a new reply push raises the root reply count once; the replies page fills the thread', () => {
    let t = loaded([1, 2], false, 2)
    t = openThread(t, 'm1')
    const reply = msg(3, { id: 'r3', parentId: 'm1' })
    t = (applyPush(t, push(3, 'message', reply)) as { t: Timeline }).t
    expect(t.items[0].replyCount).toBe(1)
    expect(t.threads.m1.replies.map((m) => m.id)).toEqual(['r3'])
    // the send's own answer of the same reply: no second count
    t = upsertMessage(t, reply)
    expect(t.items[0].replyCount).toBe(1)
    // an edit of the reply is not a new reply
    t = (applyPush(t, push(4, 'edit', { ...reply, changeSeq: 4, text: 'edited' })) as { t: Timeline }).t
    expect(t.items[0].replyCount).toBe(1)
    expect(t.threads.m1.replies[0].text).toBe('edited')
    t = applyReplies(t, { root: msg(1, { changeSeq: 3, replyCount: 1 }), messages: [reply], more: false })
    expect(t.threads.m1.loaded).toBe(true)
    expect(t.threads.m1.replies).toHaveLength(1)
    expect(closeThread(t, 'm1').threads.m1).toBeUndefined()
  })
  it('/changes carry the root itself: the count is the server\'s', () => {
    let t = openThread(loaded([1], false, 1), 'm1')
    t = applyChanges(t, changes(1, [msg(1, { changeSeq: 2, replyCount: 1 }), msg(2, { id: 'r2', parentId: 'm1' })], 2)).t
    expect(t.items[0].replyCount).toBe(1)
    expect(t.threads.m1.replies).toHaveLength(1)
    expect(findBySeq(t, 2)?.id).toBe('r2')
  })
})

describe('helpers', () => {
  it('newer keeps the higher changeSeq, upsertSorted keeps seq order', () => {
    expect(newer(msg(1, { changeSeq: 5 }), msg(1, { changeSeq: 4 })).changeSeq).toBe(5)
    expect(upsertSorted([msg(1), msg(5)], msg(3)).map((m) => m.seq)).toEqual([1, 3, 5])
    const same = [msg(1)]
    expect(upsertSorted(same, msg(1, { changeSeq: 0 }))).toBe(same)
  })
  it('optimistic reactions toggle my id and drop empty ones', () => {
    const m = msg(1, { reactions: [{ emoji: '👍', users: ['u2'] }] })
    expect(toggleReaction(m, '👍', 'u1', true).reactions).toEqual([{ emoji: '👍', users: ['u2', 'u1'] }])
    expect(toggleReaction(m, '🎉', 'u1', true).reactions).toHaveLength(2)
    expect(toggleReaction(m, '👍', 'u2', false).reactions).toEqual([])
    const t = patchMessage(loaded([1], false, 1), 'm1', (x) => toggleReaction(x, '❤️', 'u1', true))
    expect(t.items[0].reactions[0].emoji).toBe('❤️')
  })
  it('the "New" line is the first message from someone else after my read marker', () => {
    const items = [msg(1), msg(2, { sender: { id: 'me', name: 'Me' } }), msg(3), msg(4)]
    expect(firstUnread(items, 1, 'me')?.seq).toBe(3)
    expect(firstUnread(items, 4, 'me')).toBeUndefined()
  })
})

describe('a deep link to an old message: the page around it (package E)', () => {
  it('replaces the window, ignores newer messages until paged forward, and rejoins the latest page', () => {
    let t = loaded([9951, 9952, 9953], true, 10000)
    t = applyHistory(t, { ...page([120, 121, 122], true, 10000), newer: true }, 'around')
    expect(seqs(t)).toEqual([120, 121, 122])
    expect(t.hasOlder).toBe(true)
    expect(t.hasNewer).toBe(true)
    // a new message arrives live: it is newer than the window, so it would leave a hole: not inserted, but applied
    const r = applyPush({ ...t, applied: 10000 }, push(10001, 'message', msg(10001)))
    expect(r.kind).toBe('applied')
    if (r.kind === 'applied') {
      expect(seqs(r.t)).toEqual([120, 121, 122])
      expect(r.t.applied).toBe(10001)
      t = r.t
    }
    // an edit of a message inside the window still applies
    t = upsertMessage(t, msg(121, { changeSeq: 10002, text: 'edited' }))
    expect(t.items[1].text).toBe('edited')
    // paging forward
    t = applyHistory(t, page([123, 124], true), 'newer')
    expect(seqs(t)).toEqual([120, 121, 122, 123, 124])
    expect(t.hasNewer).toBe(true)
    // the latest page far away replaces the window (it does not leave a hole); it touches: it joins
    const far = applyHistory(t, page([9999, 10000, 10001], true, 10001), 'latest')
    expect(seqs(far)).toEqual([9999, 10000, 10001])
    expect(far.hasNewer).toBe(false)
    expect(far.hasOlder).toBe(true)
    const near = applyHistory(t, page([125, 126], true, 126), 'latest')
    expect(seqs(near)).toEqual([120, 121, 122, 123, 124, 125, 126])
    expect(near.hasNewer).toBe(false)
  })
  it('a /changes answer says when there is more (the server signal), else a full page means more', () => {
    const t = loaded([1, 2, 3], false, 3)
    expect(applyChanges(t, changes(3, [msg(4)], 10, { more: true })).more).toBe(true)
    expect(applyChanges(t, changes(3, [msg(4)], 4)).more).toBe(false)
    expect(applyChanges(t, changes(3, [msg(4)], 4, { more: true })).t.applied).toBe(4)
  })
})
