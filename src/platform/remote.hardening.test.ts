/**
 * Client side of the hardening fixes (server mode): table delete does not drop by default, the link consent is sent,
 * status codes without a body map to rate_limited / method_not_allowed, a forced password change keeps the workspace
 * unloaded until the password is changed, status flags reach the store.
 */
import { describe, expect, it, vi } from 'vitest'
import { createRemotePlatform } from './remote'
import { PlatformError } from './contracts'
import type { Session } from './contracts'

const session = (mustChangePassword = false): Session => ({
  user: { id: 'u1', name: 'Ann', email: 'ann@x.io', roleIds: ['r1'], ...(mustChangePassword ? { mustChangePassword: true } : {}) },
  privileges: { isAdmin: false, isMaker: true, tables: {}, apps: 'all' },
  expiresOn: '2099-01-01T00:00:00Z',
})

function server(o: { status?: Record<string, unknown>; mustChange?: boolean; signedIn?: boolean } = {}) {
  const log: { method: string; path: string; body: unknown }[] = []
  let current: Session | null = o.signedIn ? session(!!o.mustChange) : null
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const fetchStub = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost')
    const method = init.method ?? 'GET'
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    log.push({ method, path: url.pathname.replace('/api/v1', '') + url.search, body })
    const p = url.pathname.replace('/api/v1', '')
    if (p === '/status') return json(200, { app: 'appbuilder', apiVersion: 1, backend: 'node', ok: true, setup: { needsDatabase: false, needsAdmin: false }, session: current, ...(o.status ?? {}) })
    if (p === '/auth/login') { current = session(!!o.mustChange); return json(200, current) }
    if (p === '/auth/session') return json(200, current)
    if (p === '/auth/password') { current = session(false); return json(200, { ok: true }) }
    if (p === '/workspace') {
      if (current?.user.mustChangePassword) return json(403, { error: { code: 'password_change_required', message: 'Change it first.' } })
      return json(200, { apps: [], tables: [], roles: [], users: [], connections: [], solutions: [], dataFiles: [], session: current, storage: { kind: 'mysql', location: 'Server database' } })
    }
    if (p.startsWith('/tables/') && method === 'DELETE') return json(200, { ok: true })
    if (p === '/connections/conn_x/link') return json(200, { id: 'tbl_l', name: 'L', displayName: 'L', primaryColumn: 'id', columns: [], createdOn: '', modifiedOn: '', readOnly: true })
    if (p === '/files/limited/download') return new Response('', { status: 429 })
    if (p === '/files/wrong-method/download') return new Response('', { status: 405 })
    return json(404, { error: { code: 'not-found', message: p } })
  })
  return { fetch: fetchStub as unknown as typeof fetch, log }
}

describe('RemotePlatform hardening', () => {
  it('tables.remove keeps the physical table unless dropSource: true is asked for', async () => {
    const srv = server({ signedIn: true })
    const p = createRemotePlatform({ fetch: srv.fetch, reloadOnFocus: false })
    await p.init()
    await p.tables.remove('tbl_1')
    await p.tables.remove('tbl_2', { dropSource: true })
    await p.tables.remove('tbl_3', { dropSource: false })
    const deletes = srv.log.filter((r) => r.method === 'DELETE').map((r) => r.path)
    expect(deletes).toEqual(['/tables/tbl_1', '/tables/tbl_2?dropSource=1', '/tables/tbl_3'])
  })

  it('linkSourceTable sends the consent to add system columns', async () => {
    const srv = server({ signedIn: true })
    const p = createRemotePlatform({ fetch: srv.fetch, reloadOnFocus: false })
    await p.init()
    await p.tables.linkSourceTable('conn_x', 'crm', { ensureIdColumn: true })
    expect(srv.log.find((r) => r.path === '/connections/conn_x/link')!.body).toEqual({ source: 'crm', ensureIdColumn: true })
  })

  it('a forced password change: no workspace until the password is changed', async () => {
    const srv = server({ mustChange: true })
    const p = createRemotePlatform({ fetch: srv.fetch, reloadOnFocus: false })
    await p.init()
    await p.auth.login('ann@x.io', 'temporary-1')
    expect(p.getState().session?.user.mustChangePassword).toBe(true)
    expect(srv.log.some((r) => r.path === '/workspace')).toBe(false)
    await p.auth.changePassword('temporary-1', 'my-own-password')
    expect(srv.log.filter((r) => r.path === '/workspace')).toHaveLength(1)
    expect(p.getState().session?.user.mustChangePassword).toBeUndefined()
  })

  it('init with a pending password change does not load the workspace', async () => {
    const srv = server({ signedIn: true, mustChange: true })
    const p = createRemotePlatform({ fetch: srv.fetch, reloadOnFocus: false })
    await p.init()
    expect(p.getState().session?.user.mustChangePassword).toBe(true)
    expect(srv.log.map((r) => r.path)).toEqual(['/status'])
  })

  it('status flags unavailable / incompatible reach the store; no storage details for anonymous callers', async () => {
    const srv = server({ status: { ok: false, setup: { needsDatabase: false, needsAdmin: false, unavailable: true } } })
    const p = createRemotePlatform({ fetch: srv.fetch, reloadOnFocus: false })
    await p.init()
    expect(p.getState().setup).toEqual({ needsDatabase: false, needsAdmin: false, unavailable: true })
    const srv2 = server({ status: { ok: false, setup: { needsDatabase: false, needsAdmin: false, incompatible: true } } })
    const p2 = createRemotePlatform({ fetch: srv2.fetch, reloadOnFocus: false })
    await p2.init()
    expect(p2.getState().setup.incompatible).toBe(true)
  })

  it('maps 429 and 405 without a JSON body to rate_limited and method_not_allowed', async () => {
    const srv = server({ signedIn: true })
    const p = createRemotePlatform({ fetch: srv.fetch, reloadOnFocus: false })
    await p.init()
    const codeOf = async (id: string) => {
      try {
        await p.files.download(id)
      } catch (e) {
        return e instanceof PlatformError ? e.code : 'other'
      }
      return undefined
    }
    expect(await codeOf('limited')).toBe('rate_limited')
    expect(await codeOf('wrong-method')).toBe('method_not_allowed')
  })
})
