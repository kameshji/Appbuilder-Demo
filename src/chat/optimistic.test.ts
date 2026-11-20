import { describe, expect, it } from 'vitest'
import type { ChatMessageView } from '@/platform/chat-protocol'
import { CLIENT_ID, createPending, failPending, newClientId, pendingFor, reconcile, removePending, retryPending, retryableError } from './optimistic'

const CH = 'c1'
const server = (text: string, o: Partial<ChatMessageView> = {}): ChatMessageView => ({
  id: `m-${text}`, channelId: CH, seq: 5, changeSeq: 5, kind: 'message', parentId: null, body: `<p>${text}</p>`, text, sender: { id: 'me', name: 'Me' },
  createdOn: new Date().toISOString(), editedOn: null, deleted: false, moderated: false, mentions: [], mentionsChannel: false, files: [], cards: [], reactions: [],
  replyCount: 0, lastReplyOn: null, ...o,
})
const p = (text: string, id = text.replace(/\W/g, '') + 'xxxxxxxx', parentId: string | null = null) => createPending({ clientId: id, channelId: CH, parentId, body: `<p>${text}</p>`, text })

describe('optimistic sends', () => {
  it('client ids match the server rule and differ', () => {
    const a = newClientId()
    expect(CLIENT_ID.test(a)).toBe(true)
    expect(newClientId()).not.toBe(a)
  })
  it('the server message removes the oldest matching pending send only (same text twice)', () => {
    const list = [p('hello', 'aaaaaaaa1'), p('hello', 'aaaaaaaa2'), p('other', 'bbbbbbbb1')]
    const after = reconcile(list, server('hello'), 'me')
    expect(after.map((x) => x.clientId)).toEqual(['aaaaaaaa2', 'bbbbbbbb1'])
    // someone else's message with the same text does not match
    expect(reconcile(list, server('hello', { sender: { id: 'u2', name: 'R' } }), 'me')).toBe(list)
    // another place (a thread) does not match
    expect(reconcile(list, server('hello', { parentId: 'root' }), 'me')).toBe(list)
    // whitespace differences are not differences
    expect(reconcile([p('a  b')], server(' a b '), 'me')).toEqual([])
  })
  it('failure states: retryable for no answer, 429 and 5xx; final for refusals', () => {
    expect([0, 429, 500, 503].map(retryableError)).toEqual([true, true, true, true])
    expect([400, 403, 404, 413, 422].map(retryableError)).toEqual([false, false, false, false, false])
    let list = failPending([p('x', 'xxxxxxxx1')], 'xxxxxxxx1', 'The server cannot be reached.', true)
    expect(list[0]).toMatchObject({ state: 'failed', retryable: true, error: 'The server cannot be reached.' })
    // a failed send is not answered by a push (it was not sent)
    expect(reconcile(list, server('x'), 'me')).toBe(list)
    list = retryPending(list, 'xxxxxxxx1')
    expect(list[0]).toMatchObject({ state: 'sending', attempts: 2, error: undefined })
    // the retry keeps the client id: the server finds the first message instead of making a second one
    expect(list[0].clientId).toBe('xxxxxxxx1')
    expect(removePending(list, 'xxxxxxxx1')).toEqual([])
  })
  it('pending sends per place', () => {
    const list = [p('a', 'aaaaaaaa1'), p('b', 'bbbbbbbb1', 'root')]
    expect(pendingFor(list, CH, null).map((x) => x.text)).toEqual(['a'])
    expect(pendingFor(list, CH, 'root').map((x) => x.text)).toEqual(['b'])
  })
})
