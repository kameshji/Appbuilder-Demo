import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRemotePlatform } from './remote'
import { createPlatformFacade, probeServer } from './index'
import { PlatformError } from './contracts'
import type { DataErrorEvent, PlatformApi, Session, TableDef, WorkspaceState } from './contracts'

/* ------------------------------------------------------------------ fake server */

const SYS = [
  { name: 'id', displayName: 'Id', type: 'text', system: true },
  { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true },
  { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime', system: true },
  { name: 'createdBy', displayName: 'Created by', type: 'text', system: true },
  { name: 'owner', displayName: 'Owner', type: 'text', system: true },
] as const
const CONTACTS: TableDef = {
  id: 'tbl_c', name: 'Contacts', displayName: 'Contacts', primaryColumn: 'Name', createdOn: '', modifiedOn: '',
  columns: [
    ...SYS.map((c) => ({ ...c })) as TableDef['columns'],
    { name: 'Name', displayName: 'Name', type: 'text', required: true },
    { name: 'Email', displayName: 'Email', type: 'email', unique: true },
    { name: 'Age', displayName: 'Age', type: 'number' },
    { name: 'Born', displayName: 'Born', type: 'date' },
    { name: 'Active', displayName: 'Active', type: 'boolean', default: 'true' },
    { name: 'Status', displayName: 'Status', type: 'choice', choices: ['Lead', 'Customer'] },
    { name: 'Photo', displayName: 'Photo', type: 'file' },
  ],
}
type J = Record<string, string | number | boolean | null>

interface Req { method: string; path: string; headers: Record<string, string>; body: unknown; credentials?: RequestCredentials; contentType?: string }

function adminSession(): Session {
  return {
    user: { id: 'u1', name: 'Ann', email: 'ann@x.io', roleIds: ['r1'] },
    privileges: { isAdmin: true, isMaker: true, tables: {}, apps: 'all' },
    expiresOn: '2099-01-01T00:00:00Z',
  }
}
function viewerSession(): Session {
  return {
    user: { id: 'u2', name: 'Vi', email: 'vi@x.io', roleIds: ['r2'] },
    privileges: {
      isAdmin: false, isMaker: false, apps: 'all',
      tables: { tbl_c: { create: false, read: 'all', update: 'own', delete: 'none', columns: { Email: 'read' }, filtered: false } },
    },
    expiresOn: '2099-01-01T00:00:00Z',
  }
}

function makeServer(opts: { signedIn?: boolean; session?: Session; rowCount?: number; cap?: number } = {}) {
  let session: Session | null = opts.signedIn === false ? null : (opts.session ?? adminSession())
  const rows: J[] = []
  for (let i = 0; i < (opts.rowCount ?? 3); i++) {
    rows.push({
      id: `row-${i + 1}`, createdOn: '2026-03-15T10:30:00.000Z', modifiedOn: '2026-03-15T10:30:00.000Z', createdBy: 'u1', owner: 'u1',
      Name: `Person ${i + 1}`, Email: `p${i + 1}@x.io`, Age: 30 + i, Born: '1990-05-17', Active: true, Status: 'Lead', Photo: null,
    })
  }
  const log: Req[] = []
  const rules = { rejectNext: null as null | { status: number; code: string; message: string }, delayQuery: 0, expire: false }
  let queries = 0
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const err = (status: number, code: string, message: string) => json(status, { error: { code, message } })

  const fetchStub = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost')
    const method = init.method ?? 'GET'
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>))
    let body: unknown
    if (typeof init.body === 'string') {
      try { body = JSON.parse(init.body) } catch { body = init.body }
    } else body = init.body
    log.push({ method, path: url.pathname + url.search, headers, body, credentials: init.credentials, contentType: headers['Content-Type'] })
    const p = url.pathname.replace('/api/v1', '')
    if (method !== 'GET' && headers['X-Appbuilder'] !== '1') return err(403, 'denied', 'CSRF')
    if (p === '/status') return json(200, { app: 'appbuilder', apiVersion: 1, backend: 'node', setup: { needsDatabase: false, needsAdmin: false }, storage: { kind: 'postgres', location: 'test' }, session })
    if (p === '/auth/login') {
      const b = body as { password: string }
      if (b.password !== 'secret-password') return err(401, 'unauthenticated', 'Wrong email or password')
      session = opts.session ?? adminSession()
      return json(200, session)
    }
    if (p === '/auth/logout') { session = null; return json(200, { ok: true }) }
    if (!session || rules.expire) { rules.expire = false; session = null; return err(401, 'unauthenticated', 'Sign in required') }
    if (p === '/workspace') {
      return json(200, { apps: [], tables: [CONTACTS], roles: [], users: [session.user], connections: [], solutions: [], dataFiles: [], session, storage: { kind: 'postgres', location: 'test' } })
    }
    const m = /^\/data\/([^/]+)(\/.*)?$/.exec(p)
    if (m) {
      if (rules.rejectNext) { const r = rules.rejectNext; rules.rejectNext = null; return err(r.status, r.code, r.message) }
      const rest = m[2] ?? ''
      if (rest === '/query' && method === 'POST') {
        queries++
        if (rules.delayQuery) await new Promise((r) => setTimeout(r, rules.delayQuery))
        const cap = opts.cap ?? 5000
        const top = (body as { top?: number }).top
        const out = rows.slice(0, Math.min(top ?? cap, cap))
        return json(200, { rows: out.map((r) => ({ ...r })), truncated: rows.length > out.length })
      }
      if (rest === '/rows' && method === 'POST') {
        const v = (body as { values: J }).values
        if (rows.some((r) => r.Email && v.Email && r.Email === v.Email)) return err(422, 'invalid', 'Email: already exists')
        const row: J = { createdOn: '2026-03-16T00:00:00.000Z', modifiedOn: '2026-03-16T00:00:00.000Z', createdBy: session.user.id, owner: session.user.id, Name: null, Email: null, Age: null, Born: null, Active: true, Status: null, Photo: null, ...v }
        rows.push(row)
        return json(200, { row })
      }
      const um = /^\/rows\/(.+)$/.exec(rest)
      if (um && method === 'PATCH') {
        const row = rows.find((r) => r.id === decodeURIComponent(um[1]))
        if (!row) return err(404, 'not-found', 'No such row')
        Object.assign(row, (body as { changes: J }).changes, { modifiedOn: '2026-03-17T00:00:00.000Z' })
        return json(200, { row: { ...row } })
      }
      if (rest === '/delete' && method === 'POST') {
        const ids = (body as { ids: string[] }).ids
        for (const id of ids) { const i = rows.findIndex((r) => r.id === id); if (i >= 0) rows.splice(i, 1) }
        return json(200, { deleted: ids.length })
      }
    }
    if (p === '/solutions/import' && method === 'POST') return json(200, { id: 'sol_1', name: 'S', displayName: 'S', components: [], createdOn: '', modifiedOn: '' })
    if (p === '/attachments' && method === 'POST') return json(200, { id: 'att_1', fileName: url.searchParams.get('name'), mime: headers['Content-Type'], sizeBytes: 3, url: '/api/v1/attachments/att_1' })
    if (p === '/attachments/resolve') return json(200, { items: [{ id: 'att_1', fileName: 'a.png', mime: 'image/png', sizeBytes: 3, url: '/api/v1/attachments/att_1' }] })
    if (p === '/files' && method === 'POST') return json(200, { id: 'file_1', connectionId: 'conn_files', fileName: url.searchParams.get('name'), kind: 'csv', sizeBytes: 1, checksum: 'x', importedOn: '', tableIds: [], modifiedSinceImport: false })
    if (p === '/files/file_1/download') return new Response('a,b\n1,2\n', { status: 200 })
    return err(404, 'not-found', `no route ${method} ${p}`)
  })
  return { fetch: fetchStub as unknown as typeof fetch, rows, log, rules, queryCount: () => queries, setSession: (s: Session | null) => { session = s } }
}

async function boot(opts: Parameters<typeof makeServer>[0] = {}, extra: Parameters<typeof createRemotePlatform>[0] = {}) {
  const srv = makeServer(opts)
  const p = createRemotePlatform({ fetch: srv.fetch, reloadOnFocus: false, ...extra })
  await p.init()
  return { p, srv }
}
const tick = () => new Promise((r) => setTimeout(r, 0))
const code = (fn: () => unknown) => {
  try { fn() } catch (e) { return (e as PlatformError).code }
  return undefined
}
afterEach(() => { vi.unstubAllGlobals() })

/* ------------------------------------------------------------------ tests */

describe('RemotePlatform: init, auth, 401, CSRF', () => {
  it('init signed in loads status then workspace; mode server', async () => {
    const { p, srv } = await boot()
    const s = p.getState()
    expect(s.mode).toBe('server')
    expect(s.ready).toBe(true)
    expect(s.session?.user.name).toBe('Ann')
    expect(s.tables.map((t) => t.name)).toEqual(['Contacts'])
    expect(srv.log.map((r) => r.path)).toEqual(['/api/v1/status', '/api/v1/workspace'])
    expect(srv.queryCount()).toBe(0) // rows are lazy
    expect(srv.log.every((r) => r.credentials === 'same-origin')).toBe(true)
  })

  it('init signed out does not load the workspace; login does, with CSRF header', async () => {
    const { p, srv } = await boot({ signedIn: false })
    expect(p.getState().session).toBeNull()
    expect(p.getState().ready).toBe(true)
    expect(srv.log.some((r) => r.path.endsWith('/workspace'))).toBe(false)
    const bad = await p.auth.login('a@b.c', 'nope').catch((e) => e as PlatformError)
    expect((bad as PlatformError).code).toBe('unauthenticated')
    const session = await p.auth.login('a@b.c', 'secret-password')
    expect(session.user.name).toBe('Ann')
    expect(p.getState().tables).toHaveLength(1)
    const posts = srv.log.filter((r) => r.method !== 'GET')
    expect(posts.length).toBeGreaterThan(0)
    expect(posts.every((r) => r.headers['X-Appbuilder'] === '1')).toBe(true)
    await p.auth.logout()
    expect(p.getState().session).toBeNull()
    expect(p.getState().tables).toEqual([])
  })

  it('401 anywhere clears the session, drops rows and notifies listeners', async () => {
    const { p, srv } = await boot()
    await p.tables.ensureLoaded(['Contacts'])
    expect(p.tables.rows('Contacts')).toHaveLength(3)
    const seen: (Session | null)[] = []
    p.subscribe(() => seen.push(p.getState().session))
    srv.rules.expire = true
    await expect(p.tables.reload('Contacts')).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(p.getState().session).toBeNull()
    expect(seen).toContain(null)
    expect(p.tables.rows('Contacts')).toEqual([])
  })
})

describe('RemotePlatform: lazy rows and typed conversion', () => {
  it('rows() schedules a load and notifies; types are converted', async () => {
    const { p, srv } = await boot()
    let notified = 0
    p.subscribe(() => notified++)
    srv.rules.delayQuery = 10
    expect(p.tables.rows('Contacts')).toEqual([])
    expect(p.getState().loading).toEqual([]) // set after the microtask
    await tick()
    expect(p.getState().loading).toEqual(['Contacts'])
    await p.tables.ensureLoaded(['Contacts'])
    expect(p.getState().loading).toEqual([])
    expect(srv.queryCount()).toBe(1)
    const q = srv.log.find((r) => r.path.endsWith('/query'))!
    expect(q.body).toEqual({ top: 5000 })
    expect(notified).toBeGreaterThan(1)
    const r = p.tables.rows('Contacts')[0]
    expect(r.__id).toBe('row-1')
    expect(r.id).toBe('row-1')
    expect(r.Age).toBe(30)
    expect(r.Active).toBe(true)
    expect(r.Born).toBeInstanceOf(Date)
    const b = r.Born as Date
    expect([b.getFullYear(), b.getMonth(), b.getDate(), b.getHours()]).toEqual([1990, 4, 17, 0])
    expect(r.createdOn).toBeInstanceOf(Date)
    expect((r.createdOn as Date).toISOString()).toBe('2026-03-15T10:30:00.000Z')
    expect(r.Photo).toBeNull()
    // a second call does not hit the server again
    await p.tables.ensureLoaded(['Contacts'])
    expect(srv.queryCount()).toBe(1)
  })

  it('records truncated when the server hit the row cap', async () => {
    const { p } = await boot({ rowCount: 5, cap: 3 })
    await p.tables.ensureLoaded(['Contacts'])
    expect(p.tables.rows('Contacts')).toHaveLength(3)
    expect(p.getState().truncated).toEqual(['Contacts'])
  })

  it('state updates produce new objects and dataVersion bumps', async () => {
    const { p } = await boot()
    const s0 = p.getState()
    await p.tables.ensureLoaded(['Contacts'])
    const s1 = p.getState()
    expect(s1).not.toBe(s0)
    expect(s1.dataVersion).toBeGreaterThan(s0.dataVersion)
    p.tables.insert('Contacts', { Name: 'Z' })
    expect(p.getState().dataVersion).toBeGreaterThan(s1.dataVersion)
    await p.tables.flush()
  })

  it('reloads on window focus when older than staleMs', async () => {
    const target = new EventTarget()
    vi.stubGlobal('window', target)
    let now = 1_000_000
    const srv = makeServer()
    const p = createRemotePlatform({ fetch: srv.fetch, now: () => now, staleMs: 30_000 })
    await p.init()
    await p.tables.ensureLoaded(['Contacts'])
    expect(srv.queryCount()).toBe(1)
    target.dispatchEvent(new Event('focus'))
    await tick()
    expect(srv.queryCount()).toBe(1) // fresh
    now += 31_000
    target.dispatchEvent(new Event('focus'))
    await tick(); await tick()
    expect(srv.queryCount()).toBe(2)
  })
})

describe('RemotePlatform: optimistic writes', () => {
  it('insert is visible at once, uses a client uuid, serialises dates and confirms', async () => {
    const { p, srv } = await boot()
    await p.tables.ensureLoaded(['Contacts'])
    const row = p.tables.insert('Contacts', { Name: 'Neo', Email: 'neo@x.io', Born: new Date(2000, 0, 5), Age: '41' })
    expect(p.tables.rows('Contacts')).toHaveLength(4)
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(row.Age).toBe(41)
    expect(row.Active).toBe(true) // default
    expect(row.owner).toBe('u1')
    await p.tables.flush()
    const req = srv.log.find((r) => r.path.endsWith('/rows') && r.method === 'POST')!
    const values = (req.body as { values: J }).values
    expect(values).toMatchObject({ id: row.id, Name: 'Neo', Email: 'neo@x.io', Born: '2000-01-05', Age: 41 })
    expect('Active' in values).toBe(false)
    const after = p.tables.rows('Contacts').find((r) => r.id === row.id)!
    expect((after.createdOn as Date).toISOString()).toBe('2026-03-16T00:00:00.000Z') // server's row replaced ours
    expect(p.tables.rows('Contacts')).toHaveLength(4)
  })

  it('insert rolled back with a DataErrorEvent when the server refuses', async () => {
    const { p, srv } = await boot()
    await p.tables.ensureLoaded(['Contacts'])
    const events: DataErrorEvent[] = []
    p.onDataError((e) => events.push(e))
    srv.rules.rejectNext = { status: 403, code: 'denied', message: 'Row-level security says no' }
    const row = p.tables.insert('Contacts', { Name: 'Nope' })
    expect(p.tables.rows('Contacts')).toHaveLength(4)
    await expect(p.tables.flush()).rejects.toMatchObject({ code: 'denied' })
    expect(p.tables.rows('Contacts')).toHaveLength(3)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ table: 'Contacts', op: 'create', rowIds: [row.id] })
    expect(events[0].error.message).toContain('Row-level')
    await expect(p.tables.flush()).resolves.toBeUndefined() // errors are reported once
  })

  it('server-only unique conflict (not in cache) is rolled back', async () => {
    const { p, srv } = await boot()
    await p.tables.ensureLoaded(['Contacts'])
    srv.rows.push({ id: 'hidden', Email: 'taken@x.io', Name: 'H' })
    const events: DataErrorEvent[] = []
    p.onDataError((e) => events.push(e))
    p.tables.insert('Contacts', { Name: 'Dup', Email: 'taken@x.io' })
    await p.tables.flush().catch(() => {})
    expect(events[0].error.code).toBe('invalid')
    expect(p.tables.rows('Contacts')).toHaveLength(3)
  })

  it('update: optimistic, confirmed, and rolled back without clobbering later writes', async () => {
    const { p, srv } = await boot()
    await p.tables.ensureLoaded(['Contacts'])
    const next = p.tables.update('Contacts', 'row-1', { Name: 'Renamed', Born: new Date(1991, 1, 2) })
    expect(next.Name).toBe('Renamed')
    expect(p.tables.rows('Contacts')[0].Name).toBe('Renamed')
    await p.tables.flush()
    const req = srv.log.find((r) => r.method === 'PATCH')!
    expect(req.path).toBe('/api/v1/data/Contacts/rows/row-1')
    expect(req.body).toEqual({ changes: { Name: 'Renamed', Born: '1991-02-02' } })
    expect((p.tables.rows('Contacts')[0].modifiedOn as Date).toISOString()).toBe('2026-03-17T00:00:00.000Z')

    const events: DataErrorEvent[] = []
    p.onDataError((e) => events.push(e))
    srv.rules.rejectNext = { status: 403, code: 'denied', message: 'no' }
    p.tables.update('Contacts', 'row-2', { Age: 99 })
    p.tables.update('Contacts', 'row-2', { Status: 'Customer' }) // second write on the same row, accepted
    expect(p.tables.rows('Contacts')[1]).toMatchObject({ Age: 99, Status: 'Customer' })
    await p.tables.flush().catch(() => {})
    const r2 = p.tables.rows('Contacts')[1]
    expect(r2.Age).toBe(31) // first change rolled back
    expect(r2.Status).toBe('Customer') // second kept
    expect(events[0]).toMatchObject({ op: 'update', rowIds: ['row-2'] })
  })

  it('delete: optimistic, confirmed, and rolled back on failure', async () => {
    const { p, srv } = await boot()
    await p.tables.ensureLoaded(['Contacts'])
    p.tables.delete('Contacts', ['row-1'])
    expect(p.tables.rows('Contacts')).toHaveLength(2)
    await p.tables.flush()
    expect(srv.rows.some((r) => r.id === 'row-1')).toBe(false)
    expect(srv.log.find((r) => r.path.endsWith('/delete'))!.body).toEqual({ ids: ['row-1'] })
    const events: DataErrorEvent[] = []
    p.onDataError((e) => events.push(e))
    srv.rules.rejectNext = { status: 403, code: 'denied', message: 'no' }
    p.tables.delete('Contacts', ['row-2'])
    expect(p.tables.rows('Contacts')).toHaveLength(1)
    await p.tables.flush().catch(() => {})
    expect(p.tables.rows('Contacts')).toHaveLength(2)
    expect(events[0]).toMatchObject({ op: 'delete', rowIds: ['row-2'] })
  })

  it('a refresh while a write is in flight keeps the optimistic row', async () => {
    const { p, srv } = await boot()
    await p.tables.ensureLoaded(['Contacts'])
    srv.rules.delayQuery = 5
    const row = p.tables.insert('Contacts', { Name: 'Racer' })
    const reload = p.tables.reload('Contacts')
    await reload
    expect(p.tables.rows('Contacts').some((r) => r.id === row.id)).toBe(true)
    await p.tables.flush()
    expect(p.tables.rows('Contacts').filter((r) => r.id === row.id)).toHaveLength(1)
  })
})

describe('RemotePlatform: pre-validation (synchronous, no request)', () => {
  it('rejects bad writes before any request is sent', async () => {
    const { p, srv } = await boot()
    await p.tables.ensureLoaded(['Contacts'])
    const before = srv.log.length
    expect(code(() => p.tables.insert('Contacts', { Email: 'a@b.cd' }))).toBe('invalid') // Name required
    expect(code(() => p.tables.insert('Contacts', { Name: 'x', Email: 'not-an-email' }))).toBe('invalid')
    expect(code(() => p.tables.insert('Contacts', { Name: 'x', Status: 'Gold' }))).toBe('invalid')
    expect(code(() => p.tables.insert('Contacts', { Name: 'x', Age: 1.5 }))).toBe('invalid')
    expect(code(() => p.tables.insert('Contacts', { Name: 'x', Email: 'P1@X.IO' }))).toBe('invalid') // unique vs cache, case-insensitive
    expect(code(() => p.tables.insert('Contacts', { Name: 'x', Nope: 1 }))).toBe('invalid')
    expect(code(() => p.tables.insert('Nope', { Name: 'x' }))).toBe('not-found')
    expect(code(() => p.tables.update('Contacts', 'missing', { Name: 'x' }))).toBe('not-found')
    expect(code(() => p.tables.update('Contacts', 'row-1', { Name: '' }))).toBe('invalid')
    expect(code(() => p.tables.update('Contacts', 'row-1', { Email: 'p2@x.io' }))).toBe('invalid')
    expect(srv.log.length).toBe(before)
    expect(p.tables.rows('Contacts')).toHaveLength(3)
  })

  it('mirrors privileges: create, own scope, read-only columns, delete', async () => {
    const { p, srv } = await boot({ session: viewerSession() })
    await p.tables.ensureLoaded(['Contacts'])
    const before = srv.log.length
    expect(p.security.can('Contacts', 'create')).toBe(false)
    expect(p.security.can('Contacts', 'update', p.tables.rows('Contacts')[0])).toBe(false) // owned by u1, we are u2
    expect(p.security.can('Contacts', 'read')).toBe(true)
    expect(code(() => p.tables.insert('Contacts', { Name: 'x' }))).toBe('denied')
    expect(code(() => p.tables.update('Contacts', 'row-1', { Name: 'x' }))).toBe('denied') // own scope, not owner
    expect(code(() => p.tables.delete('Contacts', ['row-1']))).toBe('denied')
    expect(srv.log.length).toBe(before)
    // own row + read-only column
    srv.setSession(viewerSession())
    srv.rows[0].owner = 'u2'
    await p.tables.reload('Contacts')
    expect(code(() => p.tables.update('Contacts', 'row-1', { Email: 'new@x.io' }))).toBe('denied')
    expect(p.tables.update('Contacts', 'row-1', { Name: 'mine' }).Name).toBe('mine')
    await p.tables.flush()
    expect(p.security.canRunApp('anything')).toBe(true)
    expect(() => p.security.setCurrentUser('u1')).toThrow(PlatformError)
  })
})

describe('RemotePlatform: attachments and files', () => {
  it('url(id) is the same-origin attachment path; upload sends the raw body with its MIME type', async () => {
    const { p, srv } = await boot()
    expect(p.attachments.url('att_1')).toBe('/api/v1/attachments/att_1')
    const file = new File([new Uint8Array([1, 2, 3])], 'my pic.png', { type: 'image/png' })
    const ref = await p.attachments.upload('Contacts', 'Photo', 'row-1', file)
    expect(ref.id).toBe('att_1')
    const req = srv.log.find((r) => r.path.startsWith('/api/v1/attachments?'))!
    expect(req.path).toBe('/api/v1/attachments?table=Contacts&column=Photo&rowId=row-1&name=my%20pic.png')
    expect(req.contentType).toBe('image/png')
    expect(req.headers['X-Appbuilder']).toBe('1')
    expect(req.body).toBe(file)
    await p.tables.ensureLoaded(['Contacts'])
    await p.attachments.upload('Contacts', 'Photo', 'row-1', file)
    expect(p.tables.rows('Contacts')[0].Photo).toBe('att_1') // cell mirrored in the cache
    expect(await p.attachments.resolve(['att_1'])).toHaveLength(1)
    expect(await p.attachments.resolve([])).toEqual([])
  })

  it('files.add uploads raw with ?name=; download returns a Blob', async () => {
    const { p, srv } = await boot()
    const f = await p.files.add(new File(['a,b\n1,2\n'], 'data.csv', { type: 'text/csv' }), { displayName: 'My data' })
    expect(f.id).toBe('file_1')
    expect(srv.log.find((r) => r.path.startsWith('/api/v1/files?'))!.path).toBe('/api/v1/files?name=data.csv&displayName=My%20data')
    const blob = await p.files.download('file_1')
    expect(await blob.text()).toBe('a,b\n1,2\n')
  })
})

describe('platform facade', () => {
  const stub = (tag: string): PlatformApi => {
    let state = { ready: false, mode: tag } as unknown as WorkspaceState
    const ls = new Set<() => void>()
    return {
      init: async () => { state = { ...state, ready: true }; ls.forEach((l) => l()) },
      getState: () => state,
      subscribe: (l: () => void) => { ls.add(l); return () => ls.delete(l) },
      onDataError: () => () => {},
      apps: { create: async () => ({ id: tag }) },
      tables: { rows: () => [{ tag }] },
    } as unknown as PlatformApi
  }

  it('picks the remote platform when the probe says so, else the demo', async () => {
    for (const server of [true, false]) {
      const f = createPlatformFacade({ probe: async () => server, makeRemote: () => stub('server'), makeDemo: () => stub('demo') })
      expect(f.getState().ready).toBe(false)
      const heard: boolean[] = []
      f.subscribe(() => heard.push(f.getState().ready))
      expect(f.tables.rows('x')).toEqual([]) // safe before init
      expect(() => f.tables.insert('x', {})).toThrow(PlatformError)
      const early = f.apps.create({ name: 'a', width: 1, height: 1 }) // waits for init
      await f.init()
      expect((f.getState() as unknown as { mode: string }).mode).toBe(server ? 'server' : 'demo')
      expect(await early).toEqual({ id: server ? 'server' : 'demo' })
      expect(f.tables.rows('x')).toEqual([{ tag: server ? 'server' : 'demo' }])
      expect(heard).toContain(true)
    }
  })

  it('solutions.importPackage sends filesAs only when asked for', async () => {
    const { p, srv } = await boot()
    await p.solutions.importPackage('kind: x')
    await p.solutions.importPackage('kind: x', { filesAs: 'file' })
    const posts = srv.log.filter((r) => r.path === '/api/v1/solutions/import').map((r) => r.body)
    expect(posts[0]).toEqual({ yaml: 'kind: x' })
    expect(posts[1]).toEqual({ yaml: 'kind: x', filesAs: 'file' })
  })

  it('probeServer: true only for an appbuilder status, false for html or errors', async () => {
    const ok = (body: string, type = 'application/json', status = 200) => (async () => new Response(body, { status, headers: { 'Content-Type': type } })) as unknown as typeof fetch
    expect(await probeServer(800, ok(JSON.stringify({ app: 'appbuilder' })))).toBe(true)
    expect(await probeServer(800, ok(JSON.stringify({ app: 'other' })))).toBe(false)
    expect(await probeServer(800, ok('<html>', 'text/html'))).toBe(false)
    expect(await probeServer(800, ok('{}', 'application/json', 404))).toBe(false)
    expect(await probeServer(800, (async () => { throw new Error('down') }) as unknown as typeof fetch)).toBe(false)
    expect(await probeServer(20, (() => new Promise(() => {})) as unknown as typeof fetch)).toBe(false)
  })
})
