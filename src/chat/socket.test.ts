/**
 * Chat on the page's one live connection (src/platform/live.ts; P3 package E moved chat off its second socket): the
 * routing chat needs (chat and typing pushes, the subscribed answer with its seq, unsubscribed, a refused subscription),
 * install-wide topics surviving an environment switch, kept topics, reconnects and the offline close.
 */
import { describe, expect, it } from 'vitest'
import { LiveClient, type WebSocketLike } from '@/platform/live'
import { socketStateOf } from './conn'

class FakeSocket implements WebSocketLike {
  readyState = 0
  sent: Record<string, unknown>[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  send(d: string) { this.sent.push(JSON.parse(d)) }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code, reason: '' }) }
  open(conn = 'conn_1234567890', epoch = 'e1') { this.readyState = 1; this.recv({ t: 'hello', v: 1, epoch, connection: conn, user: { id: 'u1', name: 'A' }, limits: {} }) }
  recv(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }) }
  subs() { return this.sent.filter((m) => m.t === 'sub') }
  unsubs() { return this.sent.filter((m) => m.t === 'unsub') }
}

function setup() {
  const sockets: FakeSocket[] = []
  const timers: { fn: () => void; ms: number }[] = []
  const s = new LiveClient({
    url: 'ws://x/api/v1/live', watchEnvironment: false, random: () => 0,
    createSocket: () => { const f = new FakeSocket(); sockets.push(f); return f },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimer: () => {},
  })
  const runTimers = () => { const t = timers.splice(0).filter((x) => x.ms < 4000); for (const x of t) x.fn() }
  return { s, sockets, timers, runTimers }
}

describe('chat on the page live connection', () => {
  it('routes chat, typing and user messages by topic, and gives chat topics the subscribed answer with its seq', () => {
    const { s, sockets } = setup()
    const got: string[] = []
    s.subscribe('chat:c1', undefined, (m) => got.push(`${m.t}:${'seq' in m ? m.seq : ''}`))
    s.subscribe('chat:typing:c1', undefined, (m) => got.push(`typing:${m.t}`))
    s.subscribe('user:u1', undefined, (m) => got.push(`user:${m.t}`))
    s.start()
    const ws = sockets[0]
    ws.open()
    expect(s.status().state).toBe('open')
    expect(s.connectionId()).toBe('conn_1234567890')
    expect(ws.subs().map((m) => m.topic)).toEqual(['chat:c1', 'chat:typing:c1', 'user:u1'])
    // chat topics are install-wide: no env
    expect(ws.subs().every((m) => m.env === undefined)).toBe(true)
    const subId = ws.subs()[0].id
    ws.recv({ t: 'subscribed', id: subId, topic: 'chat:c1', seq: 7, epoch: 'e1' })
    ws.recv({ t: 'chat', topic: 'chat:c1', channelId: 'c1', seq: 8, prev: 7, op: 'message', at: '' })
    ws.recv({ t: 'typing', topic: 'chat:typing:c1', channelId: 'c1', userId: 'u2', name: 'R', at: '' })
    ws.recv({ t: 'user', topic: 'user:u1', event: 'chat.unread', channelId: 'c1', lastSeq: 8 })
    ws.recv({ t: 'chat', topic: 'chat:other', channelId: 'other', seq: 1, prev: 0, op: 'message', at: '' })
    expect(got).toEqual(['subscribed:7', 'chat:8', 'typing:typing', 'user:user'])
  })

  it('table topics carry their environment and still get the table-style resync (no subscribed answer)', () => {
    const { s, sockets } = setup()
    const got: string[] = []
    s.subscribe('table:t1', 'env1', (m) => got.push(m.t === 'table' ? `table:${m.seq}` : m.t))
    s.start()
    sockets[0].open()
    expect(sockets[0].subs()[0]).toMatchObject({ topic: 'table:t1', env: 'env1' })
    sockets[0].recv({ t: 'subscribed', id: sockets[0].subs()[0].id, topic: 'table:t1', env: 'env1', seq: 1, epoch: 'e1' })
    sockets[0].recv({ t: 'table', env: 'env2', topic: 'table:t1', seq: 3, prev: 2 })
    sockets[0].recv({ t: 'table', env: 'env1', topic: 'table:t1', seq: 2, prev: 1 })
    expect(got).toEqual(['table:2'])
  })

  it('an ended subscription (removed from the conversation) and a refused one reach the handler', () => {
    const { s, sockets } = setup()
    const got: string[] = []
    s.subscribe('chat:c1', undefined, (m) => got.push(m.t))
    s.start()
    sockets[0].open()
    sockets[0].recv({ t: 'unsubscribed', topic: 'chat:c1', reason: 'removed' })
    const errs: string[] = []
    s.subscribe('chat:c2', undefined, (m) => errs.push(m.t))
    const id = sockets[0].subs()[1].id
    sockets[0].recv({ t: 'error', id, code: 'not-found', message: 'x' })
    expect(got).toEqual(['unsubscribed'])
    expect(errs).toEqual(['error'])
  })

  it('an environment switch keeps install-wide and kept topics, drops environment-bound ones', () => {
    const { s, sockets } = setup()
    s.start()
    sockets[0].open()
    s.subscribe('chat:c1', undefined, () => {})
    s.subscribe('user:u1', undefined, () => {})
    s.subscribe('table:card', 'env1', () => {}, { keep: true })
    s.subscribe('table:t1', 'env1', () => {})
    s.subscribe('env', 'env1', () => {})
    s.resetEnvTopics()
    expect(sockets[0].unsubs().map((m) => m.topic).sort()).toEqual(['env', 'table:t1'])
    expect(s.has('chat:c1')).toBe(true)
    expect(s.has('user:u1')).toBe(true)
    expect(s.has('table:card', 'env1')).toBe(true)
    expect(s.has('table:t1', 'env1')).toBe(false)
    // a reconnect subscribes exactly what is left
    s.drop()
    const { length } = sockets
    expect(length).toBe(1)
  })

  it('reconnects after a drop, subscribes everything again; the subscribed seq lets the store compare', () => {
    const { s, sockets, runTimers } = setup()
    const got: string[] = []
    s.subscribe('chat:c1', undefined, (m) => got.push(m.t === 'subscribed' ? `subscribed:${m.seq}` : m.t))
    s.start()
    sockets[0].open()
    sockets[0].recv({ t: 'subscribed', id: sockets[0].subs()[0].id, topic: 'chat:c1', seq: 3, epoch: 'e1' })
    s.drop()
    expect(s.status().state).toBe('connecting')
    runTimers()
    expect(sockets).toHaveLength(2)
    sockets[1].open('conn_2222222222')
    expect(sockets[1].subs().map((m) => m.topic)).toEqual(['chat:c1'])
    sockets[1].recv({ t: 'subscribed', id: sockets[1].subs()[0].id, topic: 'chat:c1', seq: 9, epoch: 'e1' })
    expect(s.connectionId()).toBe('conn_2222222222')
    expect(got).toEqual(['subscribed:3', 'subscribed:9'])
  })

  it('a new server epoch resyncs chat topics too (the store asks /changes)', () => {
    const { s, sockets, runTimers } = setup()
    const got: string[] = []
    s.subscribe('chat:c1', undefined, (m) => got.push(m.t))
    s.start()
    sockets[0].open('conn_1234567890', 'e1')
    s.drop()
    runTimers()
    sockets[1].open('conn_3333333333', 'e2')
    expect(got).toContain('resync')
  })

  it('the last handler leaving unsubscribes on the server; a second off does nothing', () => {
    const { s, sockets } = setup()
    s.start()
    sockets[0].open()
    const off1 = s.subscribe('chat:c1', undefined, () => {})
    const off2 = s.subscribe('chat:c1', undefined, () => {})
    expect(sockets[0].subs()).toHaveLength(1)
    off1()
    off1()
    expect(sockets[0].unsubs()).toHaveLength(0)
    off2()
    expect(sockets[0].unsubs()).toEqual([{ t: 'unsub', topic: 'chat:c1' }])
    expect(s.has('chat:c1')).toBe(false)
  })

  it('maps the connection state to the banner chat shows', () => {
    expect(socketStateOf({ state: 'open', since: 0 })).toBe('open')
    expect(socketStateOf({ state: 'degraded', since: 0, reason: 'You are offline.' })).toBe('offline')
    expect(socketStateOf({ state: 'degraded', since: 0, reason: 'Live updates are not available right now' })).toBe('connecting')
    expect(socketStateOf({ state: 'connecting', since: 0 })).toBe('connecting')
    expect(socketStateOf({ state: 'off', since: 0 })).toBe('off')
  })
})
