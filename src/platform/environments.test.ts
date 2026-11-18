import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPlatform } from './core'
import { createRemotePlatform } from './remote'
import { MemoryStorage } from './storage'
import { PlatformError, type EnvironmentDef, type Session } from './contracts'
import { pickEnvironment, readSelectedEnvironment, selectEnvironment } from './environments'

/** a localStorage stand-in for the node test environment */
let store: Map<string, string>
beforeEach(() => {
  store = new Map()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  }
})
afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage })

const DEF: EnvironmentDef = { id: 'default', name: 'Default', type: 'production', builtIn: true }

describe('environment selection', () => {
  it('picks the saved one when it exists, else the built-in, else the first', () => {
    const dev: EnvironmentDef = { id: 'dev', name: 'Dev', type: 'developer', builtIn: false }
    expect(pickEnvironment([dev, DEF], 'dev')?.id).toBe('dev')
    expect(pickEnvironment([dev, DEF], 'gone')?.id).toBe('default')
    expect(pickEnvironment([dev], null)?.id).toBe('dev')
    expect(pickEnvironment([], 'x')).toBeNull()
  })
  it('select validates the id and remembers it per user', () => {
    expect(selectEnvironment([DEF], 'default', 'u1').id).toBe('default')
    expect(readSelectedEnvironment('u1')).toBe('default')
    expect(readSelectedEnvironment('u2')).toBeNull()
    expect(() => selectEnvironment([DEF], 'nope', 'u1')).toThrow(PlatformError)
  })
  it('storage failures are swallowed', () => {
    ;(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    expect(readSelectedEnvironment('u1')).toBeNull()
    expect(selectEnvironment([DEF], 'default', 'u1').id).toBe('default')
  })
})

describe('demo backend', () => {
  it('has the single built-in Default environment; select and current work; updateProfile renames the run-as user', async () => {
    const p = createPlatform(new MemoryStorage('browser', 'test storage'))
    await p.init()
    expect(p.getState().environments).toEqual([{ ...DEF, details: { database: 'test storage' } }])
    expect(p.environments.current()?.id).toBe('default')
    expect((await p.environments.select('default')).name).toBe('Default')
    await expect(p.environments.select('prod2')).rejects.toMatchObject({ code: 'not-found' })
    expect(await p.environments.list()).toHaveLength(1)
    const me = p.getState().currentUserId
    const u = await p.auth.updateProfile({ name: 'Renamed Person' })
    expect(u).toMatchObject({ id: me, name: 'Renamed Person' })
    expect(p.security.currentUser().name).toBe('Renamed Person')
    await expect(p.auth.updateProfile({ name: '  ' })).rejects.toMatchObject({ code: 'invalid' })
  })
})

describe('server backend', () => {
  const session: Session = { user: { id: 'u1', name: 'Ann', email: 'ann@x.io', roleIds: [] }, privileges: { isAdmin: false, isMaker: false, tables: {}, apps: 'all' }, expiresOn: '2099-01-01T00:00:00Z' }
  function server() {
    const calls: string[] = []
    let name = 'Ann'
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    const fetch = async (input: string, init: RequestInit = {}) => {
      const p = new URL(input, 'http://localhost').pathname.replace('/api/v1', '')
      const method = init.method ?? 'GET'
      calls.push(`${method} ${p}`)
      const s = { ...session, user: { ...session.user, name } }
      if (p === '/status') return json({ app: 'appbuilder', apiVersion: 1, backend: 'node', setup: { needsDatabase: false, needsAdmin: false }, ok: true, session: s })
      if (p === '/workspace') return json({ apps: [], tables: [], roles: [], users: [s.user], connections: [], solutions: [], dataFiles: [], session: s, storage: { kind: 'mysql', location: 'Server database' }, environments: [DEF] })
      if (p === '/environments') return json({ items: [DEF] })
      if (p === '/auth/profile' && method === 'PATCH') {
        name = (JSON.parse(String(init.body)) as { name: string }).name
        return json({ ...s.user, name })
      }
      return json({ error: { code: 'not-found', message: 'no route' } }, 404)
    }
    return { fetch: fetch as typeof globalThis.fetch, calls }
  }

  it('environments come with the workspace; select remembers the choice; list re-fetches', async () => {
    store.set('appbuilder-environment:u1', 'default')
    const srv = server()
    const p = createRemotePlatform({ fetch: srv.fetch, reloadOnFocus: false })
    await p.init()
    expect(p.getState().environments).toEqual([DEF])
    expect(p.getState().environmentId).toBe('default')
    expect(p.environments.current()).toEqual(DEF)
    await p.environments.select('default')
    expect(store.get('appbuilder-environment:u1')).toBe('default')
    await expect(p.environments.select('nope')).rejects.toBeInstanceOf(PlatformError)
    expect(await p.environments.list()).toEqual([DEF])
    expect(srv.calls).toContain('GET /environments')
  })

  it('updateProfile sends only the name and refreshes the session', async () => {
    const srv = server()
    const p = createRemotePlatform({ fetch: srv.fetch, reloadOnFocus: false })
    await p.init()
    const u = await p.auth.updateProfile({ name: 'Annie' })
    expect(u.name).toBe('Annie')
    expect(p.getState().session?.user.name).toBe('Annie')
    expect(srv.calls).toContain('PATCH /auth/profile')
  })
})
