/**
 * Security re-check of Phase 2, browser side (pure logic and the offline store with an in-memory key-value store):
 *  - FINDING P2-2: after another person signs in on the same page (no reload: a session that ran out, a sign-out that did
 *    not go through beforeSignOut), the previous person's offline store never replays its outbox with the new
 *    session, never answers reads and never takes writes;
 *  - FINDING P2-2b: kept answers are stored under a keyed name per environment, not under the request text (which holds
 *    filter values and search words) in clear;
 *  - the start address, kiosk token parsing and drill-through addresses take ids and values only;
 *  - auto apps: a hostile table or column display name stays a text literal in every generated formula.
 * Findings: docs/internal/security-review-p2.md.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const st = vi.hoisted(() => ({
  state: { mode: 'server', session: { user: { id: 'user_a' } } } as { mode: string; session: { user: { id: string } } | null },
  listeners: new Set<() => void>(),
  kvs: new Map<string, unknown>(),
}))

vi.mock('@/platform', () => ({
  platform: {
    getState: () => st.state,
    subscribe: (fn: () => void) => { st.listeners.add(fn); return () => st.listeners.delete(fn) },
    onDataError: () => () => {},
    tables: { invalidateQueries() {}, reload: async () => {} },
  },
}))
vi.mock('./offline/kv', async (orig) => {
  const m = await orig<typeof import('./offline/kv')>()
  return { ...m, openKV: (userId: string) => { const k = new m.MemoryKV(); st.kvs.set(userId, k); return k } }
})

import { startOffline, registerOfflineApp, replay, pendingCount, useOffline } from './offline'
import { codecFor, toBase64Url } from './offline/codec'
import type { MemoryKV } from './offline/kv'
import { offlineHook, readKey } from '@/platform/offline-hook'
import { setRequestEnvironment } from '@/platform/environments'
import { useConnectivity } from './connectivity'
import { startRouteOf } from './pwa'
import { tokenFromHash, kioskAddress } from '../dashboards/kiosk'
import { drillHash } from '../dashboards/drill'
import { generateApp } from '../autoapp'
import { parse } from '../fx/parser'
import type { TableDef } from '../platform/contracts'
import type { ControlNode } from '../contracts'

const keyOf = (seed: number) => toBase64Url(new Uint8Array(32).fill(seed))
const calls: { url: string; method: string }[] = []
const realFetch = globalThis.fetch
const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}
const signIn = (id: string | null) => {
  st.state = { mode: 'server', session: id ? { user: { id } } : null }
  for (const l of [...st.listeners]) l()
}

describe('FINDING P2-2: the offline store of the previous person on a shared phone', () => {
  beforeAll(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? 'GET' })
      if (url === '/api/v1/offline/key') return new Response(JSON.stringify({ key: keyOf(st.state.session?.user.id === 'user_a' ? 1 : 2), epoch: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response(JSON.stringify({ row: { id: 'r1' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    setRequestEnvironment('default')
    startOffline()
  })
  afterAll(() => {
    globalThis.fetch = realFetch
  })

  it('is locked when another person signs in: no replay with their session, no answers, no writes into it', async () => {
    registerOfflineApp('app_orders', ['Orders'])
    await until(() => useOffline.getState().unlocked)
    const hook = offlineHook()!
    // Ana works offline: a change waits in her outbox, an answer is kept
    useConnectivity.setState({ status: 'offline' })
    await new Promise<void>((resolve, reject) => {
      hook.queue({ kind: 'create', table: 'Orders', rowId: 'r1', values: { Title: 'Ana\'s order' } } as never, { done: () => {}, fail: (e) => reject(e) })
      void until(() => pendingCount() === 1).then(resolve, reject)
    })
    const rk = readKey('/query', { plan: { table: 'Orders', filter: { col: 'Customer', op: 'eq', value: 'Smith' } } })
    hook.storeAnswer(rk, 'Orders', { rows: [{ Title: 'Ana\'s order' }] })
    await new Promise((r) => setTimeout(r, 100))
    expect(await hook.cachedAnswer(rk, 'Orders')).toEqual({ rows: [{ Title: 'Ana\'s order' }] })

    // FINDING P2-2b: the kept answer is not stored under the request text (it holds "Smith"), and only in its environment
    const kvA = st.kvs.get('user_a') as MemoryKV
    const names = (await kvA.entries('cache')).map(([k]) => k)
    expect(names.length).toBeGreaterThan(0)
    for (const n of names) {
      expect(n).toMatch(/^a:[A-Za-z0-9_-]{43}$/)
      expect(n).not.toContain('Smith')
    }
    expect(JSON.stringify(await kvA.get('meta', 'cache-index'))).not.toContain('Smith')
    setRequestEnvironment('sales')
    expect(await hook.cachedAnswer(rk, 'Orders')).toBeUndefined()
    setRequestEnvironment('default')

    // Ben signs in on the same page; the connection is back
    calls.length = 0
    signIn('user_b')
    useConnectivity.setState({ status: 'online' })
    await replay()
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.filter((c) => c.url.startsWith('/api/v1/data/'))).toEqual([])
    expect(await hook.cachedAnswer(rk, 'Orders')).toBeUndefined()
    expect(hook.accepts('Orders')).toBe(false)
    expect(hook.divert('Orders', 'r9')).toBe(false)
    expect(useOffline.getState().items).toEqual([])
    // Ana's change is still on the device, sealed with her key (it is sent when she signs in again)
    expect((await kvA.entries('outbox')).length).toBe(1)
  })
})

describe('the keyed names of the offline store', () => {
  it('depend on the key, never contain the text, and are stable for one key', async () => {
    const a = await codecFor(keyOf(1))
    const b = await codecFor(keyOf(2))
    const n = await a.name('default\u0000/query {"value":"Smith"}')
    expect(n).toBe(await a.name('default\u0000/query {"value":"Smith"}'))
    expect(n).not.toBe(await b.name('default\u0000/query {"value":"Smith"}'))
    expect(n).not.toBe(await a.name('sales\u0000/query {"value":"Smith"}'))
    expect(n).not.toContain('Smith')
  })
})

describe('addresses: ids and values only', () => {
  it('the ?app= start address takes an app id, nothing else', () => {
    expect(startRouteOf('?app=app_123', '')).toBe('#u-app_123')
    for (const s of ['?app=javascript:alert(1)', '?app=../x', '?app=a%23b', '?app=a b', `?app=${'x'.repeat(81)}`]) expect(startRouteOf(s, ''), s).toBeNull()
    expect(startRouteOf('?app=app_1', '#u-other')).toBeNull()
  })
  it('a kiosk address carries the token in the fragment only; anything that is not a token shape is ignored', () => {
    const t = `abv.default.Ab12Cd34.${'a'.repeat(43)}`
    const addr = kioskAddress('https://apps.example.com', '/', t)
    expect(new URL(addr).search).toBe('')
    expect(new URL(addr).hash).toBe(`#u-kiosk?t=${t}`)
    expect(tokenFromHash(`#u-kiosk?t=${t}`)).toBe(t)
    for (const h of [`#u-kiosk?t=${t}x`, '#u-kiosk?t=abv.default.short.x', `#u-other?t=${t}`, `#u-kiosk?t=${t.replace('default', 'Default')}`]) expect(tokenFromHash(h), h).toBeNull()
  })
  it('drill-through values are encoded; a value cannot add parameters or leave the app address', () => {
    const h = drillHash({ appId: 'app_1', params: [{ name: 'Machine', field: 'Machine' }] }, { Machine: 'Press&admin=1#u-admin' })
    expect(h).toBe('#u-app_1?Machine=Press%26admin%3D1%23u-admin')
    expect(new URLSearchParams(h.slice(h.indexOf('?') + 1)).get('Machine')).toBe('Press&admin=1#u-admin')
    expect([...new URLSearchParams(h.slice(h.indexOf('?') + 1)).keys()]).toEqual(['Machine'])
  })
})

describe('auto apps: hostile display names stay text', () => {
  it('every generated formula parses and keeps the names as literals (no formula injection through names)', () => {
    const evil = 'Orders" & Patch(Users, Defaults(Users), {Name: "pwned"}) & "'
    const now = new Date().toISOString()
    const t: TableDef = {
      id: 'tbl_evil', name: 'Evil', displayName: evil, primaryColumn: 'Title', createdOn: now, modifiedOn: now, connectionId: 'conn_default', source: 't_evil', managed: true,
      columns: [
        { name: 'id', displayName: 'Id', type: 'text', system: true }, { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true }, { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime', system: true },
        { name: 'Title', displayName: `Title" & Remove(Evil, First(Evil)) & "`, type: 'text' }, { name: 'Note', displayName: "Note: a, b; 'c'", type: 'text' },
      ],
    } as TableDef
    let seq = 0
    const res = generateApp([t], { name: evil, device: 'phone', tables: ['Evil'], newId: () => `n${++seq}` })
    const formulas: string[] = []
    const visit = (list: ControlNode[]) => { for (const n of list) { for (const v of Object.values(n.props ?? {})) if (typeof v === 'string' && v.startsWith('=')) formulas.push(v); visit(n.children) } }
    visit(res.def.screens)
    expect(formulas.length).toBeGreaterThan(5)
    for (const f of formulas) {
      expect(parse(f).ast, f).toBeTruthy()
      // the injected calls never appear outside a text literal
      const code = f.replace(/"(?:[^"]|"")*"/g, '""')
      expect(code, f).not.toMatch(/Users|pwned/)
      expect(code, f).not.toMatch(/Remove\(Evil, First/)
    }
  })
})
