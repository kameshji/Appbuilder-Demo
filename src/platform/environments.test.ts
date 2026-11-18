import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPlatform } from './core'
import { createRemotePlatform } from './remote'
import { MemoryStorage } from './storage'
import { PlatformError, type EnvironmentDef, type Session } from './contracts'
import { environmentHeaders, getRequestEnvironment, pickEnvironment, readSelectedEnvironment, selectEnvironment, setRequestEnvironment, withEnvironment } from './environments'

/** a localStorage stand-in for the node test environment */
let store: Map<string, string>
beforeEach(() => {
  setRequestEnvironment('')
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
  it('the server\'s choice for the session wins over the built-in; links and headers name the environment', () => {
    const dev: EnvironmentDef = { id: 'dev', name: 'Dev', type: 'developer', builtIn: false }
    expect(pickEnvironment([DEF, dev], null, 'dev')?.id).toBe('dev')
    expect(pickEnvironment([DEF, dev], 'default', 'dev')?.id).toBe('default')
    setRequestEnvironment('')
    expect(environmentHeaders()).toEqual({})
    expect(withEnvironment('/api/v1/attachments/a')).toBe('/api/v1/attachments/a')
    setRequestEnvironment('dev')
    expect(environmentHeaders()).toEqual({ 'X-Appbuilder-Environment': 'dev' })
    expect(withEnvironment('/api/v1/attachments/a')).toBe('/api/v1/attachments/a?env=dev')
    expect(withEnvironment('/api/v1/attachments/a?download=1', 'x y')).toBe('/api/v1/attachments/a?download=1&env=x%20y')
    expect(withEnvironment('/api/v1/attachments/a?env=dev')).toBe('/api/v1/attachments/a?env=dev')
    setRequestEnvironment('')
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
    const envOf: string[] = []
    let name = 'Ann'
    let last = 'default'
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    const fetch = async (input: string, init: RequestInit = {}) => {
      const p = new URL(input, 'http://localhost').pathname.replace('/api/v1', '')
      const method = init.method ?? 'GET'
      calls.push(`${method} ${p}`)
      const hdr = ((init.headers ?? {}) as Record<string, string>)['X-Appbuilder-Environment']
      envOf.push(hdr ?? '')
      const env = hdr ?? last
      const s = { ...session, user: { ...session.user, name }, environmentId: env }
      if (p === '/status') return json({ app: 'appbuilder', apiVersion: 1, backend: 'node', setup: { needsDatabase: false, needsAdmin: false }, ok: true, session: s })
      if (p === '/workspace') return json({ apps: [{ id: `app_${env}`, name: env, width: 1920, height: 1080, createdOn: '', modifiedOn: '', modifiedBy: '' }], tables: [], roles: [], users: [s.user], connections: [], solutions: [], dataFiles: [], session: s, storage: { kind: 'postgres', location: 'Server database' }, environments: [DEF, SBX] })
      if (p === '/environments') return json({ items: [DEF, SBX] })
      if (p === '/auth/logout') return json({ ok: true })
      const sel = /^\/environments\/([a-z_]+)\/select$/.exec(p)
      if (sel && method === 'POST') { last = sel[1]; return json(sel[1] === 'sandbox' ? SBX : DEF) }
      if (p === '/auth/profile' && method === 'PATCH') {
        name = (JSON.parse(String(init.body)) as { name: string }).name
        return json({ ...s.user, name })
      }
      return json({ error: { code: 'not-found', message: 'no route' } }, 404)
    }
    return { fetch: fetch as typeof globalThis.fetch, calls, envOf, setLast: (id: string) => { last = id } }
  }
  const SBX: EnvironmentDef = { id: 'sandbox', name: 'Sandbox', type: 'sandbox', builtIn: false }

  it('environments come with the workspace; select remembers the choice; list re-fetches', async () => {
    store.set('appbuilder-environment:u1', 'default')
    const srv = server()
    const p = createRemotePlatform({ fetch: srv.fetch, reloadOnFocus: false })
    await p.init()
    expect(p.getState().environments).toEqual([DEF, SBX])
    expect(p.getState().environmentId).toBe('default')
    expect(p.environments.current()).toEqual(DEF)
    await p.environments.select('default')
    expect(store.get('appbuilder-environment:u1')).toBe('default')
    await expect(p.environments.select('nope')).rejects.toBeInstanceOf(PlatformError)
    expect(await p.environments.list()).toEqual([DEF, SBX])
    expect(srv.calls).toContain('GET /environments')
    expect(srv.calls).not.toContain('POST /environments/default/select') // already there
  })

  it('switching: remembered on the server, every later request names the environment, the workspace is reloaded', async () => {
    const srv = server()
    srv.setLast('sandbox') // the user's last environment on the server record
    const p = createRemotePlatform({ fetch: srv.fetch, reloadOnFocus: false })
    await p.init()
    // the first workspace load names no environment: the server answers with the user's last one
    expect(p.getState().environmentId).toBe('sandbox')
    expect(p.getState().apps.map((a) => a.id)).toEqual(['app_sandbox'])
    expect(p.attachments.url('att_1')).toBe('/api/v1/attachments/att_1?env=sandbox')
    await p.environments.select('default')
    expect(srv.calls).toContain('POST /environments/default/select')
    expect(p.getState().environmentId).toBe('default')
    expect(p.getState().apps.map((a) => a.id)).toEqual(['app_default'])
    expect(store.get('appbuilder-environment:u1')).toBe('default')
    expect(getRequestEnvironment()).toBe('default')
    await p.environments.list()
    expect(srv.envOf.at(-1)).toBe('default')
    await p.auth.logout()
    expect(getRequestEnvironment()).toBe('')
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
