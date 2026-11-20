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
const pg = { name: 'Warehouse', connector: 'postgres', settings: { host: 'pg.example', database: 'wh', user: 'ro' }, secret: 'pg-secret' }

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
    const r = await h.call(A, 'PATCH', `/api/v1/connections/${c.id}`, { name: 'Renamed', settings: { host: 'other.example' } })
    expect(r.body.name).toBe('Renamed')
    expect(r.body.settings.host).toBe('other.example')
    expect(r.body.settings.database).toBe('rep')
    expect((await h.meta.connections.get(c.id))!.secret).toBe('hunter2-secret')
    await h.call(A, 'PATCH', `/api/v1/connections/${c.id}`, { secret: 'new-pass' })
    expect((await h.meta.connections.get(c.id))!.secret).toBe('new-pass')
    expect((await h.call(A, 'PATCH', `/api/v1/connections/${c.id}`, { name: 'Default database' })).status).toBe(409)
    expect((await h.call(A, 'PATCH', '/api/v1/connections/conn_zzz', { name: 'x' })).status).toBe(404)
  })

  it('creates a postgres connection: port 5432 and schema public by default; system schemas are refused', async () => {
    const r = await h.call(A, 'POST', '/api/v1/connections', pg)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.settings).toEqual({ host: 'pg.example', port: '5432', database: 'wh', user: 'ro', ssl: 'false', schema: 'public' })
    for (const schema of ['ab', 'env_default', 'ENV_x', 'pg_catalog', 'information_schema']) {
      const bad = await h.call(A, 'POST', '/api/v1/connections', { ...pg, name: `W ${schema}`, settings: { ...pg.settings, schema } })
      expect(bad.status, schema).toBe(422)
      expect(bad.body.error.field).toBe('settings.schema')
    }
    expect((await h.call(A, 'POST', '/api/v1/connections', { ...pg, name: 'W2', settings: { ...pg.settings, schema: 'bad name' } })).status).toBe(422)
  })

  it('default store: postgres only; delete refused for the default and while tables use it', async () => {
    const my = (await h.call(A, 'POST', '/api/v1/connections', mysql)).body
    const notDefault = await h.call(A, 'POST', `/api/v1/connections/${my.id}/default`)
    expect(notDefault.status).toBe(422)
    expect(notDefault.body.error.message).toMatch(/Only a PostgreSQL connection/)
    const c = (await h.call(A, 'POST', '/api/v1/connections', pg)).body
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

    // a source that has id but lacks the other system columns links read-only (no consent) and its queries work
    const ok = await h.call(M, 'POST', '/api/v1/connections/conn_default/link', { source: 'legacy_orders', displayName: 'Legacy orders' })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body).toMatchObject({ name: 'LegacyOrders', source: 'legacy_orders', connectionId: 'conn_default', readOnly: true, missingSystem: ['createdOn', 'modifiedOn', 'createdBy', 'owner'] })
    expect(ok.body.managed).toBeUndefined()
    expect(ok.body.columns.map((c: { name: string }) => c.name)).toEqual(['id', 'total', 'who'])
    const q = await h.call(A, 'POST', `/api/v1/data/${ok.body.id}/query`, {})
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    expect(q.body.rows).toEqual([{ id: '11111111-1111-4111-8111-111111111111', total: 5, who: 'a' }])
    expect((await h.call(A, 'POST', `/api/v1/data/${ok.body.id}/rows`, { values: { who: 'b' } })).status).toBe(403)
    // re-linking the same physical table is refused, naming the existing table
    const again = await h.call(M, 'POST', '/api/v1/connections/conn_default/link', { source: 'legacy_orders' })
    expect(again.status).toBe(409)
    expect(again.body.error.message).toContain('Legacy orders')
    expect((await h.call(M, 'POST', '/api/v1/connections/conn_default/link', { source: 'missing' })).status).toBe(404)

    const ro = await h.call(M, 'POST', '/api/v1/connections/conn_default/link', { source: 'no_id' })
    expect(ro.body.readOnly).toBe(true)
    expect(ro.body.missingSystem).toEqual(['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner'])
    expect((await h.call(A, 'POST', `/api/v1/data/${ro.body.id}/query`, {})).status).toBe(200)
    // read-only tables get read-only default privileges, schema changes are refused
    expect((await h.meta.roles.get('role_maker'))!.privileges.find((p) => p.table === ro.body.id)).toMatchObject({ create: false, update: 'none', read: 'all' })
    expect((await h.call(M, 'POST', `/api/v1/tables/${ro.body.id}/columns`, { displayName: 'x', type: 'text' })).status).toBe(422)
    // with consent the missing system columns (id included) are added and the table links writable
    await h.call(M, 'DELETE', `/api/v1/tables/${ro.body.id}`)
    h.mem.external.get('no_id')!.rows.push({ total: 7 })
    const consent = await h.call(M, 'POST', '/api/v1/connections/conn_default/link', { source: 'no_id', ensureIdColumn: true })
    expect(consent.status, JSON.stringify(consent.body)).toBe(200)
    expect(consent.body.readOnly).toBeUndefined()
    expect(consent.body.missingSystem).toBeUndefined()
    expect(h.mem.ops).toContain('ensureSystemColumns:no_id:id,createdOn,modifiedOn,createdBy,owner')
    expect(consent.body.columns.map((c: { name: string }) => c.name)).toEqual(['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner', 'total'])
    const ins = await h.call(A, 'POST', `/api/v1/data/${consent.body.id}/rows`, { values: { total: 9 } })
    expect(ins.status, JSON.stringify(ins.body)).toBe(200)
    expect(ins.body.row.owner).toBe(A)
  })

  it('refuses linking a table already linked through another connection to the same database', async () => {
    h.mem.external.set('shared_tbl', { columns: [{ name: 'x', type: 'text' }], rows: [] })
    expect((await h.call(M, 'POST', '/api/v1/connections/conn_default/link', { source: 'shared_tbl', displayName: 'Shared' })).status).toBe(200)
    // two connections to the very same external database (host spelled differently)
    for (const connector of ['mysql', 'postgres']) {
      const first = (await h.call(A, 'POST', '/api/v1/connections', { name: `First ${connector}`, connector, settings: { host: 'db.x', database: 'x', user: 'a' }, secret: 'pw' })).body
      const alias = (await h.call(A, 'POST', '/api/v1/connections', { name: `Alias ${connector}`, connector, settings: { host: 'DB.X', database: 'x', user: 'other' }, secret: 'pw' })).body
      expect((await h.call(M, 'POST', `/api/v1/connections/${first.id}/link`, { source: 'shared_tbl', displayName: `Shared ${connector}` })).status).toBe(200)
      const r = await h.call(M, 'POST', `/api/v1/connections/${alias.id}/link`, { source: 'shared_tbl' })
      expect(r.status).toBe(409)
      expect(r.body.error.message).toMatch(new RegExp(`already linked as the table "Shared ${connector}"`))
      const list = await h.call(M, 'GET', `/api/v1/connections/${alias.id}/source-tables`)
      expect(list.body.items.map((i: { source: string }) => i.source)).not.toContain('shared_tbl')
    }
    // viewers cannot list source tables at all
    expect((await h.call('user_viewer', 'GET', '/api/v1/connections/conn_default/source-tables')).status).toBe(403)
  })

  it('the default database connection cannot be edited (managed by setup / server.json)', async () => {
    const r = await h.call(A, 'PATCH', '/api/v1/connections/conn_default', { name: 'Renamed', settings: { host: 'elsewhere' } })
    expect(r.status).toBe(400)
    expect(r.body.error.message).toMatch(/managed by the setup/)
    expect((await h.meta.connections.get('conn_default'))!.name).toBe('Default database')
  })

  it('files connection lists nothing to link and refuses linking', async () => {
    expect((await h.call(M, 'POST', '/api/v1/connections/conn_files/link', { source: 'x' })).status).toBe(422)
    expect((await h.call(M, 'GET', '/api/v1/connections/conn_files/source-tables')).body.items).toEqual([])
    expect(fs.existsSync(path.join(h.dir, 'files'))).toBe(true)
  })
})
