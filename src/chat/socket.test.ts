import { describe, expect, it } from 'vitest'
import { ChatSocket, type SocketLike } from './socket'

class FakeSocket implements SocketLike {
  readyState = 0
  sent: Record<string, unknown>[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  send(d: string) { this.sent.push(JSON.parse(d)) }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code, reason: '' }) }
  open(conn = 'conn_1', epoch = 'e1') { this.readyState = 1; this.recv({ t: 'hello', v: 1, epoch, connection: conn, user: { id: 'u1', name: 'A' }, limits: {} }) }
  recv(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }) }
  subs() { return this.sent.filter((m) => m.t === 'sub') }
}

function setup() {
  const sockets: FakeSocket[] = []
  const timers: { fn: () => void; ms: number }[] = []
  const ended: number[] = []
  const s = new ChatSocket({
    url: 'ws://x/api/v1/live', watch: false, random: () => 0,
    createSocket: () => { const f = new FakeSocket(); sockets.push(f); return f },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimer: () => {},
    onSessionEnd: (c) => ended.push(c),
  })
  const runTimers = () => { const t = timers.splice(0); for (const x of t) x.fn() }
  return { s, sockets, timers, runTimers, ended }
}

describe('chat socket', () => {
  it('subscribes after hello, routes chat, typing and user messages by topic, and the subscribed answer with its seq', () => {
    const { s, sockets } = setup()
    const got: string[] = []
    s.subscribe('chat:c1', (m) => got.push(`${m.t}:${'seq' in m ? m.seq : ''}`))
    s.subscribe('chat:typing:c1', (m) => got.push(`typing:${m.t}`))
    s.subscribe('user:u1', (m) => got.push(`user:${m.t}`))
    s.start()
    expect(s.state()).toBe('connecting')
    const ws = sockets[0]
    ws.open()
    expect(s.state()).toBe('open')
    expect(s.connectionId()).toBe('conn_1')
    expect(ws.subs().map((m) => m.topic)).toEqual(['chat:c1', 'chat:typing:c1', 'user:u1'])
    // chat topics are install-wide: no env
    expect(ws.subs().every((m) => !('env' in m))).toBe(true)
    const subId = ws.subs()[0].id
    ws.recv({ t: 'subscribed', id: subId, topic: 'chat:c1', seq: 7, epoch: 'e1' })
    ws.recv({ t: 'chat', topic: 'chat:c1', channelId: 'c1', seq: 8, prev: 7, op: 'message', at: '' })
    ws.recv({ t: 'typing', topic: 'chat:typing:c1', channelId: 'c1', userId: 'u2', name: 'R', at: '' })
    ws.recv({ t: 'user', topic: 'user:u1', event: 'chat.unread', channelId: 'c1', lastSeq: 8 })
    ws.recv({ t: 'chat', topic: 'chat:other', channelId: 'other', seq: 1, prev: 0, op: 'message', at: '' })
    expect(got.filter((x) => !x.startsWith('hello') && !x.includes(':hello'))).toEqual(['subscribed:7', 'chat:8', 'typing:typing', 'user:user'])
  })
  it('table topics carry their environment', () => {
    const { s, sockets } = setup()
    const got: number[] = []
    s.subscribe('table:t1', (m) => { if (m.t === 'table') got.push(m.seq) }, 'env1')
    s.start()
    sockets[0].open()
    expect(sockets[0].subs()[0]).toMatchObject({ topic: 'table:t1', env: 'env1' })
    sockets[0].recv({ t: 'table', env: 'env2', topic: 'table:t1', seq: 1, prev: 0 })
    sockets[0].recv({ t: 'table', env: 'env1', topic: 'table:t1', seq: 2, prev: 1 })
    expect(got).toEqual([2])
  })
  it('an ended subscription (removed from the conversation) reaches the handler, with or without an id', () => {
    const { s, sockets } = setup()
    const got: string[] = []
    s.subscribe('chat:c1', (m) => got.push(m.t))
    s.start()
    sockets[0].open()
    sockets[0].recv({ t: 'unsubscribed', topic: 'chat:c1', reason: 'removed' })
    const errs: string[] = []
    s.subscribe('chat:c2', (m) => errs.push(m.t))
    const id = sockets[0].subs()[1].id
    sockets[0].recv({ t: 'error', id, code: 'not-found', message: 'x' })
    expect(got.filter((t) => t !== 'hello')).toEqual(['unsubscribed'])
    expect(errs).toEqual(['error'])
  })
  it('reconnects after a drop and subscribes everything again (the store compares the seq)', () => {
    const { s, sockets, timers, runTimers } = setup()
    const got: string[] = []
    s.subscribe('chat:c1', (m) => got.push(m.t))
    s.start()
    sockets[0].open()
    s.drop()
    expect(s.state()).toBe('connecting')
    expect(timers).toHaveLength(1)
    runTimers()
    expect(sockets).toHaveLength(2)
    sockets[1].open('conn_2')
    expect(sockets[1].subs().map((m) => m.topic)).toEqual(['chat:c1'])
    expect(s.connectionId()).toBe('conn_2')
    expect(got).toEqual(['hello', 'hello'])
  })
  it('waits 30 s after a "too many" close; stops on a session end', () => {
    const a = setup()
    a.s.start()
    a.sockets[0].open()
    a.sockets[0].close(4429)
    expect(a.timers[0].ms).toBeGreaterThanOrEqual(30_000)
    const b = setup()
    b.s.start()
    b.sockets[0].open()
    b.sockets[0].close(4401)
    expect(b.s.state()).toBe('off')
    expect(b.ended).toEqual([4401])
    expect(b.timers).toHaveLength(0)
  })
  it('the last handler leaving unsubscribes on the server', () => {
    const { s, sockets } = setup()
    s.start()
    sockets[0].open()
    const off1 = s.subscribe('chat:c1', () => {})
    const off2 = s.subscribe('chat:c1', () => {})
    expect(sockets[0].subs()).toHaveLength(1)
    off1()
    expect(sockets[0].sent.some((m) => m.t === 'unsub')).toBe(false)
    off2()
    expect(sockets[0].sent.filter((m) => m.t === 'unsub')).toEqual([{ t: 'unsub', topic: 'chat:c1' }])
    expect(s.has('chat:c1')).toBe(false)
  })
})
