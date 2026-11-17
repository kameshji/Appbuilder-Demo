import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness } from './testing.ts'
import type { Harness } from './testing.ts'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(() => h.cleanup())
const A = 'user_admin'
const M = 'user_maker'
const V = 'user_viewer'
const csv = (s: string) => Buffer.from(s)

const upload = (csvText: string, name = 'people.csv', q = '') => h.call(M, 'POST', `/api/v1/files?name=${name}${q}`, undefined, { raw: csv(csvText) })

describe('data files', () => {
  it('uploads a csv: registers the file, one table with origin, default privileges', async () => {
    const r = await upload('Name,Age\nAnn,31\nBob,45\n', 'people.csv', '&displayName=People')
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toMatchObject({ connectionId: 'conn_files', fileName: 'people.csv', kind: 'csv', modifiedSinceImport: false })
    expect(r.body.tableIds).toHaveLength(1)
    const t = (await h.meta.tables.get(r.body.tableIds[0]))!
    expect(t).toMatchObject({ name: 'People', displayName: 'People', connectionId: 'conn_files', origin: { kind: 'file', fileId: r.body.id, fileName: 'people.csv' } })
    expect(t.source).toMatch(new RegExp(`^${r.body.id}/`))
    expect(t.columns.filter((c) => !c.system).map((c) => c.name)).toEqual(['Name', 'Age'])
    expect((await h.meta.roles.get('role_viewer'))!.privileges.find((p) => p.table === t.id)).toMatchObject({ read: 'all', update: 'none' })
    const rows = await h.services.data.query(null, t, {})
    expect(rows.rows.map((x) => x.Name)).toEqual(['Ann', 'Bob'])
    expect(rows.rows[0].id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('rejects bad names, empty bodies, wrong levels and unreadable files', async () => {
    expect((await h.call(M, 'POST', '/api/v1/files?name=x.txt', undefined, { raw: csv('a') })).status).toBe(422)
    expect((await h.call(M, 'POST', '/api/v1/files', undefined, { raw: csv('a') })).status).toBe(422)
    expect((await h.call(M, 'POST', '/api/v1/files?name=a.csv', undefined, { raw: Buffer.alloc(0) })).status).toBe(422)
    expect((await h.call(V, 'POST', '/api/v1/files?name=a.csv', undefined, { raw: csv('a\n1') })).status).toBe(403)
    const bad = await h.call(M, 'POST', '/api/v1/files?name=b.json', undefined, { raw: csv('{not json') })
    expect(bad.status).toBeGreaterThanOrEqual(400)
    expect((await h.meta.files.list())).toHaveLength(0)
  })

  it('downloads the current copy including edits (needs full read access)', async () => {
    const f = (await upload('Name\nAnn\n')).body
    const t = (await h.meta.tables.get(f.tableIds[0]))!
    await h.services.data.insert(null, t, { Name: 'Zed' })
    const d = await h.call(M, 'GET', `/api/v1/files/${f.id}/download`)
    expect(d.status).toBe(200)
    expect(d.raw!.headers!['Content-Disposition']).toContain('people.csv'.replace('people', 'people'))
    expect(String(d.raw!.body)).toContain('Zed')
    // a maker limited by a row filter may not download the raw file
    const role = (await h.call(A, 'POST', '/api/v1/roles', { name: 'LimitedMaker', isMaker: true, privileges: [{ table: t.id, create: false, read: 'all', update: 'none', delete: 'none', rowFilter: [{ column: 'Name', op: 'eq', value: 'Ann' }] }] })).body
    const u = (await h.call(A, 'POST', '/api/v1/users', { name: 'L', email: 'l@x.io', roleIds: [role.id] })).body
    expect((await h.call(u.id, 'GET', `/api/v1/files/${f.id}/download`)).status).toBe(403)
    expect((await h.call(M, 'GET', '/api/v1/files/file_none/download')).status).toBe(404)
  })

  it('replaces the file (columns follow, ids matched) and refuses another kind', async () => {
    const f = (await upload('Name\nAnn\n')).body
    const t = (await h.meta.tables.get(f.tableIds[0]))!
    const id = (await h.services.data.query(null, t, {})).rows[0].id
    const r = await h.call(M, 'POST', `/api/v1/files/${f.id}/replace?name=people.csv`, undefined, { raw: csv(`id,Name,City\n${id},Ann B,Pune\n`) })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const t2 = (await h.meta.tables.get(t.id))!
    expect(t2.columns.filter((c) => !c.system).map((c) => c.name)).toEqual(['Name', 'City'])
    const rows = (await h.services.data.query(null, t2, {})).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id, Name: 'Ann B', City: 'Pune' })
    expect((await h.call(M, 'POST', `/api/v1/files/${f.id}/replace?name=people.json`, undefined, { raw: csv('[{"a":1}]') })).status).toBeGreaterThanOrEqual(400)
  })

  it('delete needs dropTables; "move to database" converts a file table keeping name and id', async () => {
    const f = (await upload('Name\nAnn\nBob\n')).body
    const tid = f.tableIds[0]
    expect((await h.call(M, 'DELETE', `/api/v1/files/${f.id}`)).status).toBe(409)
    const moved = await h.call(M, 'POST', `/api/v1/tables/${tid}/move`, { connectionId: 'conn_default' })
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    expect(moved.body).toMatchObject({ id: tid, name: 'People', connectionId: 'conn_default' })
    expect(moved.body.origin).toBeUndefined()
    expect((await h.meta.files.get(f.id))!.tableIds).toEqual([])
    expect((await h.services.data.query(null, moved.body, {})).rows.map((r) => r.Name)).toEqual(['Ann', 'Bob'])
    expect((await h.call(M, 'DELETE', `/api/v1/files/${f.id}`)).body).toEqual({ ok: true })
    expect(await h.meta.files.get(f.id)).toBeNull()

    const g = (await upload('X\n1\n', 'other.csv')).body
    expect((await h.call(M, 'DELETE', `/api/v1/files/${g.id}?dropTables=1`)).body).toEqual({ ok: true })
    expect(await h.meta.tables.get(g.tableIds[0])).toBeNull()
    expect((await h.call(M, 'DELETE', `/api/v1/files/${g.id}`)).status).toBe(404)
  })
})
