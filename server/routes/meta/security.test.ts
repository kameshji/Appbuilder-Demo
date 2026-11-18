import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness } from './testing.ts'
import type { Harness } from './testing.ts'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(() => h.cleanup())
const A = 'user_admin'
const M = 'user_maker'

const table = async () => (await h.call(M, 'POST', '/api/v1/tables', { displayName: 'Deals', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Region', type: 'text' }, { displayName: 'Amount', type: 'currency' }] })).body
const priv = (t: string, extra: object = {}) => ({ table: t, create: false, read: 'all', update: 'own', delete: 'none', ...extra })

describe('roles', () => {
  it('creates with Maker flag, privileges, CLS and RLS; admin-only; unique names', async () => {
    const t = await table()
    const r = await h.call(A, 'POST', '/api/v1/roles', {
      name: 'Sales rep', description: 'd', isMaker: true, apps: 'all',
      privileges: [priv(t.id, { columns: { Amount: 'read', Region: 'update' }, rowFilter: [{ column: 'owner', op: 'eq', value: '@me' }, { column: 'Region', op: 'eq', value: 'West' }] })],
    })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.isMaker).toBe(true)
    const p = r.body.privileges.find((x: { table: string }) => x.table === t.id)
    expect(p.columns).toEqual({ Amount: 'read' })
    expect(p.rowFilter).toHaveLength(2)
    expect((await h.call(A, 'POST', '/api/v1/roles', { name: 'sales REP' })).status).toBe(409)
    expect((await h.call(M, 'POST', '/api/v1/roles', { name: 'Zed' })).status).toBe(403)
    const upd = await h.call(A, 'PATCH', `/api/v1/roles/${r.body.id}`, { name: 'Reps', isMaker: false })
    expect(upd.body).toMatchObject({ name: 'Reps' })
    expect(upd.body.isMaker).toBeUndefined()
    expect(h.meta.auditLog.filter((a) => a.action.startsWith('role.')).length).toBe(2)
  })

  it('validates row filters and column security against the table', async () => {
    const t = await table()
    const bad = async (extra: object, msgPart?: string) => {
      const r = await h.call(A, 'POST', '/api/v1/roles', { name: 'R' + Math.random(), privileges: [priv(t.id, extra)] })
      expect(r.status, JSON.stringify(extra)).toBe(422)
      if (msgPart) expect(r.body.error.message).toContain(msgPart)
    }
    await bad({ rowFilter: [{ column: 'Nope', op: 'eq', value: 'x' }] }, 'does not exist')
    await bad({ rowFilter: [{ column: 'Region', op: 'regex', value: 'x' }] }, 'unknown operator')
    await bad({ rowFilter: [{ column: 'Region', op: 'eq' }] }, 'value is required')
    await bad({ rowFilter: [{ column: 'Region', op: 'in', value: 'West' }] }, 'list')
    await bad({ rowFilter: [{ column: 'owner', op: 'eq', value: '@ME' }] }, '@me')
    await bad({ rowFilter: 'x' })
    await bad({ columns: { Ghost: 'none' } }, 'not a column')
    await bad({ columns: { Region: 'hidden' } })
    await bad({ columns: { id: 'none' } }, 'Id column')
    const ok = await h.call(A, 'POST', '/api/v1/roles', { name: 'Fine', privileges: [priv(t.id, { rowFilter: [{ column: 'Region', op: 'isBlank' }, { column: 'owner', op: 'in', value: ['@me', 'x'] }] })] })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect((await h.call(A, 'POST', '/api/v1/roles', { name: 'T', privileges: [{ table: 'tbl_nope', create: false, read: 'all', update: 'all', delete: 'all' }] })).status).toBe(404)
    expect((await h.call(A, 'POST', '/api/v1/roles', { name: 'S', privileges: [priv(t.id, { read: 'some' })] })).status).toBe(422)
    expect((await h.call(A, 'POST', '/api/v1/roles', { name: 'Ap', apps: ['app_nope'] })).status).toBe(404)
  })

  it('last administrator role cannot be removed or demoted; other roles can be deleted and leave users', async () => {
    expect((await h.call(A, 'DELETE', '/api/v1/roles/role_admin')).status).toBe(409)
    expect((await h.call(A, 'PATCH', '/api/v1/roles/role_admin', { isAdmin: false })).status).toBe(409)
    const r = (await h.call(A, 'POST', '/api/v1/roles', { name: 'Temp' })).body
    const u = (await h.call(A, 'POST', '/api/v1/users', { name: 'T', email: 't@x.io', roleIds: [r.id] })).body
    expect((await h.call(A, 'DELETE', `/api/v1/roles/${r.id}`)).body).toEqual({ ok: true })
    expect((await h.meta.users.get(u.id))!.roleIds).toEqual([])
    // with a second admin role holding an active user the first can go
    const r2 = (await h.call(A, 'POST', '/api/v1/roles', { name: 'Admin2', isAdmin: true })).body
    expect(r2.privileges).toEqual([])
    expect((await h.call(A, 'DELETE', '/api/v1/roles/role_admin')).status).toBe(409) // no user holds Admin2
    await h.call(A, 'PATCH', `/api/v1/users/${u.id}`, { roleIds: [r2.id] })
    expect((await h.call(A, 'DELETE', '/api/v1/roles/role_admin')).status).toBe(200)
  })
})

describe('users', () => {
  it('creates, validates, updates, sets password, disables, deletes', async () => {
    const r = await h.call(A, 'POST', '/api/v1/users', { name: 'Zoe', email: 'Zoe@Example.com', roleIds: ['role_viewer'] })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toMatchObject({ email: 'zoe@example.com', status: 'active', hasPassword: false, roleIds: ['role_viewer'] })
    expect(r.body.passwordHash).toBeUndefined()
    const id = r.body.id
    expect((await h.call(A, 'POST', '/api/v1/users', { name: 'Z2', email: 'ZOE@example.com' })).status).toBe(409)
    expect((await h.call(A, 'POST', '/api/v1/users', { name: 'Z3', email: 'nope' })).status).toBe(422)
    expect((await h.call(A, 'POST', '/api/v1/users', { name: 'Z4', email: 'z4@x.io', roleIds: ['role_zzz'] })).status).toBe(404)
    expect((await h.call(A, 'PATCH', `/api/v1/users/${id}`, { name: 'Zoe B', roleIds: ['role_maker'] })).body).toMatchObject({ name: 'Zoe B', roleIds: ['role_maker'] })
    // password policy
    expect((await h.call(A, 'POST', `/api/v1/users/${id}/password`, { password: 'short' })).status).toBe(422)
    expect((await h.call(A, 'POST', `/api/v1/users/${id}/password`, { password: 'zoe@example.com' })).status).toBe(422)
    expect((await h.call(A, 'POST', `/api/v1/users/${id}/password`, { password: 'a-long-enough-pass' })).body).toEqual({ ok: true })
    const rec = (await h.meta.users.get(id))!
    expect(rec.passwordHash).toMatch(/^scrypt\$32768\$8\$1\$/)
    expect((await h.call(A, 'GET', `/api/v1/security/preview?user=${id}`)).body.user.hasPassword).toBe(true)
    // disable removes sessions and makes the user unusable
    await h.meta.sessions.insert({ idHash: 'h1', userId: id, expiresOn: new Date(Date.now() + 1e6), userAgent: '' })
    const dis = await h.call(A, 'PATCH', `/api/v1/users/${id}`, { status: 'disabled' })
    expect(dis.body.status).toBe('disabled')
    expect(await h.meta.sessions.get('h1')).toBeNull()
    expect((await h.call(A, 'PATCH', `/api/v1/users/${id}`, { status: 'weird' })).status).toBe(422)
    expect((await h.call(A, 'DELETE', `/api/v1/users/${id}`)).body).toEqual({ ok: true })
    expect((await h.call(A, 'DELETE', `/api/v1/users/${id}`)).status).toBe(404)
    // audit never carries passwords
    expect(JSON.stringify(h.meta.auditLog)).not.toContain('a-long-enough-pass')
  })

  it('guards the last admin and self-deletion', async () => {
    expect((await h.call(A, 'DELETE', `/api/v1/users/${A}`)).status).toBe(409)
    expect((await h.call(A, 'PATCH', `/api/v1/users/${A}`, { status: 'disabled' })).status).toBe(409)
    expect((await h.call(A, 'PATCH', `/api/v1/users/${A}`, { roleIds: ['role_viewer'] })).status).toBe(409)
    // deleting accounts needs an install administrator (an environment administrator only assigns roles)
    const second = (await h.call(A, 'POST', '/api/v1/users', { name: 'Ad2', email: 'ad2@x.io', roleIds: ['role_admin'], isInstallAdmin: true })).body
    expect((await h.call(second.id, 'DELETE', `/api/v1/users/${second.id}`)).status).toBe(409) // yourself
    expect((await h.call(second.id, 'DELETE', `/api/v1/users/${A}`)).status).toBe(200)
    // the remaining admin is the last one
    expect((await h.call(second.id, 'PATCH', `/api/v1/users/${second.id}`, { roleIds: [] })).status).toBe(409)
    // a disabled admin does not count
    const third = (await h.call(second.id, 'POST', '/api/v1/users', { name: 'Ad3', email: 'ad3@x.io', roleIds: ['role_admin'], status: 'disabled' })).body
    expect(third.status).toBe('disabled')
    expect((await h.call(second.id, 'PATCH', `/api/v1/users/${second.id}`, { roleIds: [] })).status).toBe(409)
  })
})

describe('security preview', () => {
  it('reports visible rows and hidden / read-only columns per table for a user', async () => {
    const t = await table()
    const def = (await h.meta.tables.get(t.id))!
    for (const [i, region] of ['West', 'West', 'East'].entries()) await h.services.data.insert(null, def, { Title: `d${i}`, Region: region, Amount: i })
    const role = (await h.call(A, 'POST', '/api/v1/roles', {
      name: 'West reps', apps: 'all',
      privileges: [priv(t.id, { update: 'all', columns: { Amount: 'none', Region: 'read' }, rowFilter: [{ column: 'Region', op: 'eq', value: 'West' }] })],
    })).body
    const u = (await h.call(A, 'POST', '/api/v1/users', { name: 'W', email: 'w@x.io', roleIds: [role.id] })).body
    const r = await h.call(A, 'GET', `/api/v1/security/preview?user=${u.id}`)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const e = r.body.tables.find((x: { table: string }) => x.table === t.id)
    expect(e).toMatchObject({ rowCount: 2, hiddenColumns: ['Amount'], readOnlyColumns: ['Region'], filtered: true, read: 'all' })
    expect(r.body.items.find((x: { tableId: string }) => x.tableId === t.id)).toEqual({ tableId: t.id, visibleRows: 2, hiddenColumns: ['Amount'], readOnlyColumns: ['Region'], why: ['Role "West reps": all rows, limited by its row rules'] })
    // admins see everything
    const adm = (await h.call(A, 'GET', `/api/v1/security/preview?user=${A}`)).body
    expect(adm.isAdmin).toBe(true)
    expect(adm.tables.find((x: { table: string }) => x.table === t.id)).toMatchObject({ rowCount: 3, hiddenColumns: [] })
    expect((await h.call(A, 'GET', '/api/v1/security/preview')).status).toBe(422)
    expect((await h.call(A, 'GET', '/api/v1/security/preview?user=nobody')).status).toBe(404)
  })
})
