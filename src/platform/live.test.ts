/**
 * The browser's live connection with a fake WebSocket and fake timers: reconnect with backoff and jitter, resubscribe,
 * presence and locks re-sent, gap detection (prev mismatch, ack ahead, new epoch), session problems, degraded status,
 * and remote-live's per-table debounce (bursts coalesce) and self messages.
 */
import { describe, expect, it } from 'vitest'
import { LiveClient, backoffMs } from './live'
import type { WebSocketLike } from './live'
import { createRemoteLive } from './remote-live'
import type { WorkspaceState } from './contracts'

class FakeSocket implements WebSocketLike {
  readyState = 0
  sent: any[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  send(d: string) {
    this.sent.push(JSON.parse(d))
  }
  close(code = 1000) {
    this.readyState = 3
    this.onclose?.({ code, reason: '' })
  }
  // test helpers
  open(epoch = 'e1') {
    this.readyState = 1
    this.push({ t: 'hello', v: 1, epoch, connection: 'conn_1234567890', user: { id: 'u1', name: 'Una' }, limits: { maxSubscriptions: 200, maxMessageBytes: 16384, heartbeatMs: 25000 } })
  }
  push(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) })
  }
  drop(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code, reason: '' })
  }
}

function harness(o: { onSessionProblem?: (code: number) => Promise<boolean> } = {}) {
  const sockets: FakeSocket[] = []
  const timers: { fn: () => void; at: number; id: number }[] = []
  let now = 0
  let seq = 0
  const client = new LiveClient({
    url: 'ws://x/api/v1/live',
    createSocket: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    random: () => 0.5,
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, at: now + ms, id: ++seq }
      timers.push(t)
      return t.id
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id)
      if (i >= 0) timers.splice(i, 1)
    },
    watchEnvironment: false,
    onSessionProblem: o.onSessionProblem,
  })
  const advance = (ms: number) => {
    now += ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const t = timers[0]
      if (!t || t.at > now) break
      timers.shift()
      t.fn()
    }
  }
  return { client, sockets, advance, last: () => sockets[sockets.length - 1] }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('LiveClient', () => {
  it('backoff grows with full jitter, capped at 30 s, with a floor for limit closes', () => {
    expect(backoffMs(0, () => 0)).toBe(500)
    expect(backoffMs(0, () => 1)).toBe(1000)
    expect(backoffMs(3, () => 0.5)).toBe(6000)
    expect(backoffMs(20, () => 1)).toBe(30000)
    expect(backoffMs(0, () => 0, 30000)).toBe(30000)
  })

  it('subscribes after hello, resubscribes after a reconnect, re-sends presence and locks', async () => {
    const h = harness()
    const got: any[] = []
    h.client.start()
    h.client.subscribe('table:t1', 'default', (m) => got.push(m))
    h.client.setPresence('app:a1', 'default', 'viewing')
    h.last().open()
    expect(h.client.status().state).toBe('open')
    expect(h.last().sent.map((m) => m.t)).toEqual(['sub', 'presence'])
    const lock = h.client.lock('studio:a1', 'default', 'acquire')
    const lreq = h.last().sent.find((m) => m.t === 'lock')
    h.last().push({ t: 'lock', id: lreq.id, scope: 'studio:a1', env: 'default', ok: true, holder: { id: 'u1', name: 'Una' }, mine: true })
    expect(await lock).toMatchObject({ ok: true, mine: true })
    h.last().drop()
    expect(h.client.status().state).toBe('connecting')
    expect(h.sockets).toHaveLength(1)
    h.advance(1000)
    expect(h.sockets).toHaveLength(2)
    h.last().open()
    expect(h.last().sent.map((m) => m.t)).toEqual(['sub', 'presence', 'lock'])
    expect(h.client.connectionId()).toBe('conn_1234567890')
    h.client.stop()
    expect(h.client.status().state).toBe('off')
  })

  it('gap detection: prev mismatch, an acknowledgement ahead of what was seen, and a new server epoch resync the topic', () => {
    const h = harness()
    const got: any[] = []
    h.client.start()
    h.client.subscribe('table:t1', 'default', (m) => got.push(m))
    h.last().open('e1')
    h.last().push({ t: 'subscribed', id: h.last().sent[0].id, topic: 'table:t1', env: 'default', seq: 5, epoch: 'e1' })
    h.last().push({ t: 'table', env: 'default', topic: 'table:t1', table: 't1', seq: 6, prev: 5, op: 'update', rows: null, columns: [], at: '' })
    expect(got.map((m) => m.t)).toEqual(['table'])
    h.last().push({ t: 'table', env: 'default', topic: 'table:t1', table: 't1', seq: 9, prev: 8, op: 'update', rows: null, columns: [], at: '' })
    expect(got.map((m) => m.t)).toEqual(['table', 'resync', 'table'])
    // reconnect: the ack says 12 but we saw 9
    h.last().drop()
    h.advance(1000)
    h.last().open('e1')
    h.last().push({ t: 'subscribed', id: h.last().sent[0].id, topic: 'table:t1', env: 'default', seq: 12, epoch: 'e1' })
    expect(got.slice(-1)[0]).toMatchObject({ t: 'resync', reason: 'missed changes' })
    // the server restarted: new epoch
    h.last().drop()
    h.advance(1000)
    h.last().open('e2')
    expect(got.slice(-1)[0]).toMatchObject({ t: 'resync', reason: 'server restarted' })
  })

  it('4401: asks the platform; still signed in -> reconnect at once, signed out -> stop', async () => {
    let answer = true
    const h = harness({ onSessionProblem: async () => answer })
    h.client.start()
    h.last().open()
    h.last().drop(4401)
    await flush()
    h.advance(1000)
    expect(h.sockets).toHaveLength(2)
    answer = false
    h.last().open()
    h.last().drop(4401)
    await flush()
    h.advance(60_000)
    expect(h.sockets).toHaveLength(2)
    expect(h.client.status().state).toBe('off')
  })

  it('no socket for a while: degraded (periodic refetch); a limit close waits at least 30 s', () => {
    const h = harness()
    h.client.start()
    h.advance(4000)
    expect(h.client.status().state).toBe('degraded')
    h.last().drop(4429)
    h.advance(29_000)
    expect(h.sockets).toHaveLength(1)
    h.advance(1_000)
    expect(h.sockets).toHaveLength(2)
    h.last().open()
    expect(h.client.status().state).toBe('open')
  })
})

describe('remote live glue', () => {
  it('table pushes are debounced per table; self messages and other topics do not invalidate', () => {
    const timers: { fn: () => void; at: number; id: number }[] = []
    let now = 0
    let id = 0
    const invalidated: string[] = []
    const sockets: FakeSocket[] = []
    let state = { environmentId: 'default', session: { user: { id: 'u1', mustChangePassword: false } } } as unknown as WorkspaceState
    const rl = createRemoteLive({
      call: async () => ({ unread: 0 }) as never,
      getState: () => state,
      setState: (p) => (state = { ...state, ...p }),
      invalidateTable: (t) => invalidated.push(t),
      invalidateAll: () => invalidated.push('*'),
      refreshWorkspace: () => invalidated.push('workspace'),
      checkSession: async () => true,
      live: {
        url: 'ws://x', watchEnvironment: false, random: () => 0.5, now: () => now,
        createSocket: () => {
          const s = new FakeSocket()
          sockets.push(s)
          return s
        },
        setTimer: (fn, ms) => (timers.push({ fn, at: now + ms, id: ++id }), id),
        clearTimer: (x) => {
          const i = timers.findIndex((t) => t.id === x)
          if (i >= 0) timers.splice(i, 1)
        },
      },
      setTimer: (fn, ms) => (timers.push({ fn, at: now + ms, id: ++id }), id),
      clearTimer: (x) => {
        const i = timers.findIndex((t) => t.id === x)
        if (i >= 0) timers.splice(i, 1)
      },
      setInterval: () => 0,
      clearInterval: () => {},
      now: () => now,
    })
    const advance = (ms: number) => {
      const end = now + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const t = timers[0]
        if (!t || t.at > end) break
        timers.shift()
        now = t.at
        t.fn()
      }
      now = end
    }
    rl.start()
    rl.trackTable('t1')
    const s = sockets[0]
    s.open()
    expect(s.sent.map((m) => m.topic)).toEqual(['user:u1', 'env', 'table:t1'])
    const msg = (seq: number, extra = {}) => ({ t: 'table', env: 'default', topic: 'table:t1', table: 't1', seq, prev: seq - 1, op: 'update', rows: ['r1'], by: { id: 'u2', name: 'Bo' }, columns: ['A'], at: 'now', ...extra })
    s.push({ t: 'subscribed', id: s.sent[2].id, topic: 'table:t1', env: 'default', seq: 0, epoch: 'e1' })
    for (let i = 1; i <= 5; i++) {
      s.push(msg(i))
      advance(50)
    }
    expect(invalidated).toEqual([])
    advance(200)
    expect(invalidated).toEqual(['t1'])
    expect(rl.live.lastRowChange('t1', 'r1')).toMatchObject({ by: { name: 'Bo' } })
    // a long burst is still flushed after at most 800 ms
    invalidated.length = 0
    for (let i = 6; i <= 30; i++) {
      s.push(msg(i))
      advance(100)
    }
    expect(invalidated.length).toBeGreaterThanOrEqual(2)
    advance(1000)
    invalidated.length = 0
    s.push(msg(31, { self: true }))
    advance(1000)
    expect(invalidated).toEqual([])
    expect(rl.liveHeader()).toEqual({ 'X-Appbuilder-Live': 'conn_1234567890' })
    s.push({ t: 'user', topic: 'user:u1', event: 'unread', unread: 4 })
    expect(state.unread).toBe(4)
    s.push({ t: 'env', env: 'default', topic: 'env', kind: 'metadata', at: '' })
    advance(300)
    expect(invalidated).toEqual(['workspace'])
    rl.stop()
  })
})
