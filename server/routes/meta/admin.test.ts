import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness } from './testing.ts'
import type { Harness } from './testing.ts'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(() => h.cleanup())
const A = 'user_admin'
const V = 'user_viewer'

describe('self-service profile (PATCH /auth/profile)', () => {
  it('any signed-in user changes their own display name; audited', async () => {
    const r = await h.call(V, 'PATCH', '/api/v1/auth/profile', { name: '  Victor V.  ' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toMatchObject({ id: V, name: 'Victor V.', email: 'user_viewer@example.test', roleIds: ['role_viewer'], hasPassword: false })
    expect(r.body.passwordHash).toBeUndefined()
    expect((await h.meta.users.get(V))!.name).toBe('Victor V.')
    const e = h.meta.auditLog.find((a) => a.action === 'user.profile')
    expect(e).toMatchObject({ userId: V, details: { id: V, changes: { name: { before: 'Vic Viewer', after: 'Victor V.' } } } })
    // unchanged name: no new audit entry
    await h.call(V, 'PATCH', '/api/v1/auth/profile', { name: 'Victor V.' })
    expect(h.meta.auditLog.filter((a) => a.action === 'user.profile')).toHaveLength(1)
  })

  it('only the name: email, roles, status and ids are refused; name is validated', async () => {
    for (const extra of [{ email: 'x@y.z' }, { roleIds: ['role_admin'] }, { status: 'disabled' }, { id: A }]) {
      const r = await h.call(V, 'PATCH', '/api/v1/auth/profile', { name: 'Ok', ...extra })
      expect(r.status, JSON.stringify(extra)).toBe(422)
    }
    expect((await h.meta.users.get(V))).toMatchObject({ name: 'Vic Viewer', roleIds: ['role_viewer'], status: 'active' })
    expect((await h.call(V, 'PATCH', '/api/v1/auth/profile', { name: '   ' })).status).toBe(422)
    expect((await h.call(V, 'PATCH', '/api/v1/auth/profile', { name: 'x'.repeat(101) })).status).toBe(422)
    expect((await h.call(V, 'PATCH', '/api/v1/auth/profile', { name: 5 })).status).toBe(422)
    expect((await h.call(null, 'PATCH', '/api/v1/auth/profile', { name: 'Anon' })).status).toBe(401)
    // the admin's account is untouched by anyone else's call
    expect((await h.meta.users.get(A))!.name).toBe('Ada Admin')
  })
})

describe('environments', () => {
  it('one built-in Default (production); details for administrators only', async () => {
    const v = await h.call(V, 'GET', '/api/v1/environments')
    expect(v.status).toBe(200)
    expect(v.body.items).toEqual([{ id: 'default', name: 'Default', type: 'production', builtIn: true }])
    const a = await h.call(A, 'GET', '/api/v1/environments')
    expect(a.body.items).toHaveLength(1)
    expect(a.body.items[0]).toMatchObject({ id: 'default', builtIn: true, details: { database: expect.any(String), schemaVersion: expect.any(Number) } })
    expect((await h.call(null, 'GET', '/api/v1/environments')).status).toBe(401)
  })

  it('the workspace carries the same list', async () => {
    const w = await h.call(V, 'GET', '/api/v1/workspace')
    expect(w.status).toBe(200)
    expect(w.body.environments).toEqual([{ id: 'default', name: 'Default', type: 'production', builtIn: true }])
  })
})

describe('audit log viewer (GET /audit)', () => {
  const seed = async () => {
    await h.call(A, 'POST', '/api/v1/users', { name: 'Zoe', email: 'zoe@example.test', roleIds: ['role_viewer'] })
    await h.call(V, 'PATCH', '/api/v1/auth/profile', { name: 'Vic 2' })
    await h.call(A, 'POST', '/api/v1/roles', { name: 'Clerks' })
    for (let i = 0; i < 60; i++) await h.meta.audit({ userId: null, action: 'auth.login_failed', details: { email: `n${i}@x.io` } })
  }

  it('administrators only', async () => {
    expect((await h.call(V, 'GET', '/api/v1/audit')).status).toBe(403)
    expect((await h.call(null, 'GET', '/api/v1/audit')).status).toBe(401)
  })

  it('newest first, 50 per page by default, with total, actions and the acting user', async () => {
    await seed()
    const p1 = await h.call(A, 'GET', '/api/v1/audit')
    expect(p1.status, JSON.stringify(p1.body)).toBe(200)
    expect(p1.body).toMatchObject({ page: 1, pageSize: 50, total: 63 })
    expect(p1.body.items).toHaveLength(50)
    expect(p1.body.items[0].details).toEqual({ email: 'n59@x.io' })
    expect(p1.body.items[0].id).toBeGreaterThan(p1.body.items[1].id)
    expect(p1.body.actions).toEqual(['auth.login_failed', 'role.create', 'user.create', 'user.profile'])
    const p2 = await h.call(A, 'GET', '/api/v1/audit?page=2')
    expect(p2.body.items).toHaveLength(13)
    const last = p2.body.items[p2.body.items.length - 1]
    expect(last).toMatchObject({ action: 'user.create', userId: A, userName: 'Ada Admin', userEmail: 'user_admin@example.test' })
  })

  it('filters by action, action prefix, user and date; validates parameters', async () => {
    await seed()
    const prof = await h.call(A, 'GET', '/api/v1/audit?action=user.profile')
    expect(prof.body.total).toBe(1)
    expect(prof.body.items[0]).toMatchObject({ action: 'user.profile', userId: V, userName: 'Vic 2' })
    expect((await h.call(A, 'GET', '/api/v1/audit?action=user.')).body.total).toBe(2)
    expect((await h.call(A, 'GET', `/api/v1/audit?user=${A}`)).body.total).toBe(2)
    expect((await h.call(A, 'GET', '/api/v1/audit?action=auth.&pageSize=10&page=3')).body).toMatchObject({ total: 60, page: 3, pageSize: 10 })
    expect((await h.call(A, 'GET', '/api/v1/audit?from=2000-01-01&to=2001-01-01')).body.total).toBe(0)
    expect((await h.call(A, 'GET', '/api/v1/audit?from=2000-01-01')).body.total).toBe(63)
    for (const bad of ['pageSize=0', 'pageSize=201', 'page=0', 'page=x', 'from=yesterday', "action=a'b", 'to=2026-13-45']) {
      expect((await h.call(A, 'GET', `/api/v1/audit?${bad}`)).status, bad).toBe(422)
    }
  })
})
