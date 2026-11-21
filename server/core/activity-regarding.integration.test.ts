/**
 * An Activity (note, task, call) may move to another record after it was created, with the check of its creation: the
 * writer must be able to read the new record. The move is audited (activity.regarding, from and to). Comments and other
 * collaboration rows keep their record. Against the sandbox PostgreSQL (APPBUILDER_TEST_DB).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from './testdb.ts'
import { Client, startHarness } from './kernel-testkit.ts'
import type { KernelHarness } from './kernel-testkit.ts'
import { setQuiet } from './util.ts'
import { runInEnvironment } from './env-context.ts'
import { hashPassword } from './password.ts'
import type { UserRecord } from './contracts.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[activity regarding] ${SKIP_PG}\n`)
const PW = 'member-password-1'
type Any = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(!PG_URL)(PG_URL ? 'changing the record of an activity (PostgreSQL)' : `activity regarding ${SKIP_PG}`, () => {
  let h: KernelHarness
  let bo: Client
  const ids: Record<string, string> = {}
  let ordersId = ''
  let otherId = ''

  beforeAll(async () => {
    h = await startHarness('actreg')
    const t = await h.admin.post('/tables', { displayName: 'Orders', columns: [{ displayName: 'Title', type: 'text' }] })
    expect(t.status, JSON.stringify(t.data)).toBe(200)
    ordersId = t.data.id
    otherId = (await h.admin.post('/tables', { displayName: 'Visits', columns: [{ displayName: 'Title', type: 'text' }] })).data.id
    const role = await h.admin.post('/roles', { name: 'Sales own', apps: 'all', privileges: [{ table: ordersId, create: true, read: 'own', update: 'own', delete: 'own' }, { table: otherId, create: true, read: 'own', update: 'own', delete: 'own' }] })
    expect(role.status, JSON.stringify(role.data)).toBe(200)
    await runInEnvironment('default', async () => {
      await h.app.services.meta.users.insert({ id: 'user_bo', name: 'Bo Brown', email: 'bo@example.com', roleIds: [role.data.id], status: 'active', passwordHash: await hashPassword(PW) } as UserRecord)
    })
    h.app.services.security.invalidate('all')
    bo = new Client(h.base)
    expect((await bo.post('/auth/login', { email: 'bo@example.com', password: PW })).status).toBe(200)
    ids.mine1 = (await bo.post(`/data/${ordersId}/rows`, { values: { Title: 'Bo order 1' } })).data.row.id
    ids.mine2 = (await bo.post(`/data/${ordersId}/rows`, { values: { Title: 'Bo order 2' } })).data.row.id
    ids.visit = (await bo.post(`/data/${otherId}/rows`, { values: { Title: 'Bo visit' } })).data.row.id
    ids.adas = (await h.admin.post(`/data/${ordersId}/rows`, { values: { Title: 'Admin order' } })).data.row.id
  }, 180_000)

  afterAll(async () => {
    await h?.close()
  }, 60_000)

  it('moves a task to another readable record (another table too), audited; unlinking is allowed', async () => {
    const a = await bo.post('/data/Activities/rows', { values: { Subject: 'Call back', regardingId: ids.mine1 } })
    expect(a.status, JSON.stringify(a.data)).toBe(200)
    const id = a.data.row.id
    const moved = await bo.patch(`/data/Activities/rows/${id}`, { changes: { regardingId: ids.mine2 } })
    expect(moved.status, JSON.stringify(moved.data)).toBe(200)
    expect(moved.data.row).toMatchObject({ regardingId: ids.mine2, regardingTable: ordersId })
    const audit = await h.q<Any>(`SELECT user_id, details FROM env_default.ab_audit WHERE action = 'activity.regarding' AND row_id = $1 ORDER BY at`, [id])
    expect(audit.length).toBe(1)
    expect(audit[0].user_id).toBe('user_bo')
    expect(audit[0].details).toEqual({ from: { table: ordersId, id: ids.mine1 }, to: { table: ordersId, id: ids.mine2 } })
    // to a row of another table: the table follows the id
    const other = await bo.patch(`/data/Activities/rows/${id}`, { changes: { regardingId: ids.visit } })
    expect(other.status, JSON.stringify(other.data)).toBe(200)
    expect(other.data.row).toMatchObject({ regardingId: ids.visit, regardingTable: otherId })
    const off = await bo.patch(`/data/Activities/rows/${id}`, { changes: { regardingId: null } })
    expect(off.status, JSON.stringify(off.data)).toBe(200)
    expect(off.data.row.regardingId ?? null).toBeNull()
    expect((await h.q(`SELECT 1 FROM env_default.ab_audit WHERE action = 'activity.regarding' AND row_id = $1`, [id])).length).toBe(3)
  })

  it('refuses a record the writer cannot read, or one that does not exist, and changes nothing', async () => {
    const id = (await bo.post('/data/Activities/rows', { values: { Subject: 'Note', Type: 'Note', regardingId: ids.mine1 } })).data.row.id
    const hidden = await bo.patch(`/data/Activities/rows/${id}`, { changes: { regardingId: ids.adas } })
    expect(hidden.status).toBe(422)
    expect(hidden.data.error.message).toMatch(/that you can see/)
    const none = await bo.patch(`/data/Activities/rows/${id}`, { changes: { regardingId: '00000000-0000-4000-8000-000000000000' } })
    expect(none.status).toBe(422)
    const still = await bo.post('/query', { plan: { version: 2, table: 'Activities', filter: { col: 'id', op: 'eq', value: id } } })
    expect(still.data.rows[0].regardingId).toBe(ids.mine1)
    expect((await h.q(`SELECT 1 FROM env_default.ab_audit WHERE action = 'activity.regarding' AND row_id = $1`, [id])).length).toBe(0)
  })

  it('a comment still keeps its record', async () => {
    const cm = await bo.post('/data/Comments/rows', { values: { Body: 'hello', regardingId: ids.mine1 } })
    expect(cm.status, JSON.stringify(cm.data)).toBe(200)
    const r = await bo.patch(`/data/Comments/rows/${cm.data.row.id}`, { changes: { regardingId: ids.mine2 } })
    expect(r.status).toBe(422)
    expect(r.data.error.message).toMatch(/cannot be changed/)
  })
})
