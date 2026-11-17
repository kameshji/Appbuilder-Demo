import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { makeHarness } from './testing.ts'
import type { Harness } from './testing.ts'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(() => h.cleanup())
const A = 'user_admin'
const M = 'user_maker'

const mysql = { name: 'Reports DB', connector: 'mysql', settings: { host: 'db.example', port: 3307, database: 'rep', user: 'ro', ssl: 'true' }, secret: 'hunter2-secret' }

describe('connections', () => {
  it('creates a mysql connection, never returns the secret, tests it', async () => {
    const r = await h.call(A, 'POST', '/api/v1/connections', mysql)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toMatchObject({ name: 'Reports DB', connector: 'mysql', status: 'connected', hasSecret: true, isDefault: false, scope: 'server' })
    expect(r.body.settings).toEqual({ host: 'db.example', port: '3307', database: 'rep', user: 'ro', ssl: 'true' })
    expect(JSON.stringify(r.body)).not.toContain('hunter2')
    expect((await h.meta.connections.get(r.body.id))!.secret).toBe('hunter2-secret')
    expect(JSON.stringify(h.meta.auditLog)).not.toContain('hunter2')
    // failures are stored and the secret is redacted from messages
    h.mem.failTest = 'Access denied using hunter2-secret'
    const t = await h.call(M, 'POST', `/api/v1/connections/${r.body.id}/test`)
    expect(t.body).toEqual({ ok: false, message: 'Access denied using ***' })
    expect((await h.meta.connections.get(r.body.id))).toMatchObject({ status: 'error', lastError: 'Access denied using ***' })
    h.mem.failTest = null
    expect((await h.call(M, 'POST', `/api/v1/connections/${r.body.id}/test`)).body.ok).toBe(true)
    expect((await h.meta.connections.get(r.body.id))!.lastError).toBeUndefined()
  })

  it('validates input and refuses duplicates', async () => {
    expect((await h.call(A, 'POST', '/api/v1/connections', { ...mysql, name: 'default database' })).status).toBe(409)
    expect((await h.call(A, 'POST', '/api/v1/connections', { ...mysql, connector: 'oracle' })).status).toBe(422)
    expect((await h.call(A, 'POST', '/api/v1/connections', { ...mysql, settings: { host: 'h', database: 'd' } })).status).toBe(422)
    expect((await h.call(A, 'POST', '/api/v1/connections', { ...mysql, settings: { ...mysql.settings, port: 99999 } })).status).toBe(422)
    expect((await h.call(A, 'POST', '/api/v1/connections', { name: 'F2', connector: 'files' })).status).toBe(409)
    expect((await h.call(A, 'POST', '/api/v1/connections', { name: 'G', connector: 'gsheets', settings: { spreadsheetId: 'abc' } })).status).toBe(422)
    expect((await h.call(A, 'POST', '/api/v1/connections', { name: 'G', connector: 'gsheets', settings: { spreadsheetId: 'abc' }, secret: 'not json' })).status).toBe(422)
    const g = await h.call(A, 'POST', '/api/v1/connections', { name: 'G', connector: 'gsheets', settings: { spreadsheetId: 'abc', serviceAccountEmail: 'sa@p.iam' }, secret: JSON.stringify({ client_email: 'sa@p.iam', private_key: 'k' }) })
    expect(g.body.settings).toEqual({ spreadsheetId: 'abc', serviceAccountEmail: 'sa@p.iam' })
  })

  it('patches name / settings / secret (keeping the old secret when omitted)', async () => {
    const c = (await h.call(A, 'POST', '/api/v1/connections', mysql)).body
    const r = await h.call(A, 'PATCH', `/api/v1/connections/${c.id}`, { name: 'Renamed', settings: { host: 'other' } })
    expect(r.body.name).toBe('Renamed')
    expect(r.body.settings.host).toBe('other')
    expect(r.body.settings.database).toBe('rep')
    expect((await h.meta.connections.get(c.id))!.secret).toBe('hunter2-secret')
    await h.call(A, 'PATCH', `/api/v1/connections/${c.id}`, { secret: 'new-pass' })
    expect((await h.meta.connections.get(c.id))!.secret).toBe('new-pass')
    expect((await h.call(A, 'PATCH', `/api/v1/connections/${c.id}`, { name: 'Default database' })).status).toBe(409)
    expect((await h.call(A, 'PATCH', '/api/v1/connections/conn_zzz', { name: 'x' })).status).toBe(404)
  })

  it('default store: mysql only; delete refused for the default and while tables use it', async () => {
    const c = (await h.call(A, 'POST', '/api/v1/connections', mysql)).body
    expect((await h.call(A, 'DELETE', '/api/v1/connections/conn_default')).status).toBe(409)
    expect((await h.call(A, 'POST', '/api/v1/connections/conn_files/default')).status).toBe(422)
    const t = (await h.call(M, 'POST', '/api/v1/tables', { displayName: 'Rep', connectionId: c.id })).body
    expect((await h.call(A, 'DELETE', `/api/v1/connections/${c.id}`)).status).toBe(409)
    const d = await h.call(A, 'POST', `/api/v1/connections/${c.id}/default`)
    expect(d.body.isDefault).toBe(true)
    expect((await h.meta.connections.get('conn_default'))!.isDefault).toBe(false)
    expect((await h.call(A, 'DELETE', `/api/v1/connections/${c.id}`)).status).toBe(409) // now the default
    // new tables land on the new default
    expect((await h.call(M, 'POST', '/api/v1/tables', { displayName: 'Next' })).body.connectionId).toBe(c.id)
    await h.call(A, 'POST', '/api/v1/connections/conn_default/default')
    await h.call(M, 'DELETE', `/api/v1/tables/${t.id}`)
    const other = (await h.meta.tables.list()).filter((x) => x.connectionId === c.id)
    for (const o of other) await h.call(M, 'DELETE', `/api/v1/tables/${o.id}`)
    expect((await h.call(A, 'DELETE', `/api/v1/connections/${c.id}`)).body).toEqual({ ok: true })
    expect((await h.call(A, 'DELETE', '/api/v1/connections/conn_files')).status).toBe(409)
    expect((await h.call(A, 'DELETE', `/api/v1/connections/${c.id}`)).status).toBe(404)
  })

  it('source tables skip registered and system tables; link writable, read-only fallback, id consent', async () => {
    h.mem.external.set('legacy_orders', { columns: [{ name: 'id', type: 'text' }, { name: 'total', type: 'decimal' }, { name: 'who', type: 'text' }], rows: [{ id: '11111111-1111-4111-8111-111111111111', total: 5, who: 'a' }] })
    h.mem.external.set('no_id', { columns: [{ name: 'total', type: 'decimal' }], rows: [] })
    h.mem.external.set('ab_users', { columns: [{ name: 'id', type: 'text' }], rows: [] })
    await h.call(M, 'POST', '/api/v1/tables', { displayName: 'Mine' })
    const list = await h.call(M, 'GET', '/api/v1/connections/conn_default/source-tables')
    expect(list.body.items.map((i: { source: string }) => i.source).sort()).toEqual(['legacy_orders', 'no_id'])
    expect(list.body.items[0].columns[0]).toHaveProperty('type')

    const ok = await h.call(M, 'POST', '/api/v1/connections/conn_default/link', { source: 'legacy_orders', displayName: 'Legacy orders' })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body).toMatchObject({ name: 'LegacyOrders', source: 'legacy_orders', connectionId: 'conn_default' })
    expect(ok.body.readOnly).toBeUndefined()
    expect(ok.body.columns.map((c: { name: string }) => c.name)).toEqual(['id', 'total', 'who'])
    expect((await h.call(M, 'POST', '/api/v1/connections/conn_default/link', { source: 'legacy_orders' })).status).toBe(409)
    expect((await h.call(M, 'POST', '/api/v1/connections/conn_default/link', { source: 'missing' })).status).toBe(404)

    const ro = await h.call(M, 'POST', '/api/v1/connections/conn_default/link', { source: 'no_id' })
    expect(ro.body.readOnly).toBe(true)
    // read-only tables get read-only default privileges, schema changes are refused
    expect((await h.meta.roles.get('role_maker'))!.privileges.find((p) => p.table === ro.body.id)).toMatchObject({ create: false, update: 'none', read: 'all' })
    expect((await h.call(M, 'POST', `/api/v1/tables/${ro.body.id}/columns`, { displayName: 'x', type: 'text' })).status).toBe(422)
    // a mysql table without an id stays read-only even with consent
    await h.call(M, 'DELETE', `/api/v1/tables/${ro.body.id}`)
    const consent = await h.call(M, 'POST', '/api/v1/connections/conn_default/link', { source: 'no_id', ensureIdColumn: true })
    expect(consent.body.readOnly).toBe(true)
  })

  it('files connection lists nothing to link and refuses linking', async () => {
    expect((await h.call(M, 'POST', '/api/v1/connections/conn_files/link', { source: 'x' })).status).toBe(422)
    expect((await h.call(M, 'GET', '/api/v1/connections/conn_files/source-tables')).body.items).toEqual([])
    expect(fs.existsSync(path.join(h.dir, 'files'))).toBe(true)
  })
})
