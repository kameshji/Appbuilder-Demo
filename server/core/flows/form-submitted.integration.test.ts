/**
 * The formSubmitted trigger (P3-D; docs/dev/flows.md "The formSubmitted trigger"), through the REAL server, router and flow
 * engine against the sandbox PostgreSQL:
 *  - a committed write that carries the Form's identity starts the flow once, for the submitter;
 *  - a replay of the same write (same Idempotency-Key: an offline outbox retry) starts nothing more;
 *  - a claim the write does not back starts nothing: a write without the claim, a Form of another table, an unknown form
 *    or app, an app the person may not run, a write the server refused;
 *  - the validator knows the trigger (app and form must exist).
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/flows/form-submitted
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { setQuiet } from '../util.ts'
import { runInEnvironment } from '../env-context.ts'
import { Client, startHarness, type KernelHarness } from '../kernel-testkit.ts'
import { hashPassword } from '../password.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[form-submitted integration] ${SKIP_PG}\n`)

/* eslint-disable @typescript-eslint/no-explicit-any */
describe.skipIf(!PG_URL)('flows: the formSubmitted trigger (PostgreSQL)', { timeout: 120_000 }, () => {
  let h: KernelHarness
  const A = () => h.admin
  const inEnv = <T>(fn: () => Promise<T>) => runInEnvironment('default', fn)
  const settings = { concurrency: 'parallel', timeoutMinutes: 600, retentionDays: 30, onError: 'fail' }
  let appId = ''
  let otherAppId = ''
  let user: Client
  let userId = ''
  let key = 0
  const drain = async () => {
    for (let i = 0; i < 6; i++) {
      await h.app.services.kernel.drain({ timeoutMs: 60_000 })
      if (!(await inEnv(() => h.app.services.flows.sweep(true)))) break
    }
    await h.app.services.kernel.drain({ timeoutMs: 60_000 })
  }
  const settle = () => new Promise((r) => setTimeout(r, 250)) // the listener runs after the response
  const mkFlow = async (body: any) => {
    const r = await A().post('/flows', { settings, enabled: true, ...body })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return r.data.flow
  }
  const runs = async (flowId: string) => h.q<any>(`SELECT id, state, run_as, run_as_kind, triggered_by, trigger_kind, trigger->'Record'->>'Title' AS title, trigger->>'Form' AS form FROM env_default.ab_flow_runs WHERE flow_id = $1 ORDER BY created_on`, [flowId])
  const post = async (c: Client, table: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${h.base}/api/v1/data/${table}/rows`, { method: 'POST', headers: { 'X-Appbuilder': '1', 'Content-Type': 'application/json', Cookie: c.cookie, ...headers }, body: JSON.stringify(body) })
    return { status: res.status, data: (await res.json()) as any }
  }
  const form = (name: string, table: string) => ({ id: `n_${name}`, type: 'Form', name, props: { DataSource: `="${table}"` }, children: [] })
  const screenOf = (id: string, children: unknown[]) => ({ id, type: 'Screen', name: id, props: {}, children })

  beforeAll(async () => {
    h = await startHarness('formsub')
    for (const t of [
      { displayName: 'FOrders', name: 'FOrders', columns: [{ displayName: 'Title', type: 'text' }] },
      { displayName: 'FNotes', name: 'FNotes', columns: [{ displayName: 'Title', type: 'text' }] },
    ]) expect((await A().post('/tables', t)).status).toBe(200)
    const tables = await h.q<any>('SELECT id, name FROM env_default.ab_tables')
    const tid = (n: string) => tables.find((x: any) => x.name === n).id
    const role = await A().post('/roles', { name: 'Clerks', apps: 'all', privileges: [{ table: tid('FOrders'), create: true, read: 'all', update: 'all', delete: 'none' }, { table: tid('FNotes'), create: true, read: 'all', update: 'all', delete: 'none' }] })
    expect(role.status, JSON.stringify(role.data)).toBe(200)
    const u = await A().post('/users', { name: 'Cleo Clerk', email: 'cleo@example.com', password: 'some-password-1', roleIds: [role.data.id] })
    expect(u.status, JSON.stringify(u.data)).toBe(200)
    userId = u.data.id
    await h.q('UPDATE ab.users SET must_change_password = false, password_hash = $1 WHERE email = $2', [await hashPassword('some-password-1'), 'cleo@example.com'])
    user = new Client(h.base)
    expect((await user.post('/auth/login', { email: 'cleo@example.com', password: 'some-password-1' })).status).toBe(200)
    const mk = async (name: string, screens: unknown[], dataSources: string[]) => {
      const a = await A().post('/apps', { name, width: 1920, height: 1080 })
      expect(a.status, JSON.stringify(a.data)).toBe(200)
      const id = a.data.id ?? a.data.app?.id
      const def = (await A().get(`/apps/${id}`)).data.definition
      const put = await A().req('PUT', `/apps/${id}`, { definition: { ...def, screens, dataSources } })
      expect(put.status, JSON.stringify(put.data)).toBe(200)
      return id as string
    }
    appId = await mk('Order entry', [screenOf('s1', [form('OrderForm', 'FOrders'), form('NoteForm', 'FNotes')])], ['FOrders', 'FNotes'])
    otherAppId = await mk('Other app', [screenOf('s2', [form('OtherForm', 'FOrders')])], ['FOrders'])
  }, 180_000)

  afterAll(async () => { await h?.close() }, 60_000)

  it('the validator knows the trigger: an unknown app or form is an error', async () => {
    const bad = await A().post('/flows', { name: 'Bad form flow', settings, enabled: false, trigger: { type: 'formSubmitted', app: 'nope', form: 'OrderForm' }, steps: [] })
    expect(JSON.stringify(bad.data)).toMatch(/app/i)
    const bad2 = await A().post('/flows', { name: 'Bad form flow 2', settings, enabled: false, trigger: { type: 'formSubmitted', app: appId, form: 'Nope' }, steps: [] })
    expect(JSON.stringify(bad2.data)).toMatch(/form/i)
  })

  it('a keyed create starts the flow once, as the submitter; its replay starts nothing more', async () => {
    const f = await mkFlow({ name: 'On order', runAs: 'triggeringUser', trigger: { type: 'formSubmitted', app: appId, form: 'OrderForm', on: ['create'] }, steps: [{ id: 'c', name: 'Mark', kind: 'compose', value: '"seen " & Trigger.Record.Title' }] })
    const k = `form-key-${++key}-aaaaaaaa`
    const body = { values: { Title: 'Order 1' }, form: { app: appId, form: 'OrderForm' } }
    const r1 = await post(user, 'FOrders', body, { 'Idempotency-Key': k })
    expect(r1.status, JSON.stringify(r1.data)).toBe(200)
    await settle(); await drain()
    let rs = await runs(f.id)
    expect(rs).toHaveLength(1)
    expect(rs[0]).toMatchObject({ trigger_kind: 'formSubmitted', run_as: userId, triggered_by: userId, title: 'Order 1', form: 'OrderForm' })
    // the offline outbox replays the same item with the same key: the server answers from its stored answer, no second run
    const r2 = await post(user, 'FOrders', body, { 'Idempotency-Key': k })
    expect(r2.status).toBe(200)
    await settle(); await drain()
    rs = await runs(f.id)
    expect(rs).toHaveLength(1)
    // a new submit is a new run
    expect((await post(user, 'FOrders', { values: { Title: 'Order 2' }, form: { app: appId, form: 'OrderForm' } }, { 'Idempotency-Key': `form-key-${++key}-bbbbbbbb` })).status).toBe(200)
    await settle(); await drain()
    expect(await runs(f.id)).toHaveLength(2)
  })

  it('a claim the write does not back starts nothing', async () => {
    const f = await mkFlow({ name: 'Guarded', runAs: 'triggeringUser', trigger: { type: 'formSubmitted', app: appId, form: 'OrderForm' }, steps: [] })
    const before = (await runs(f.id)).length
    // 1. a plain write without the claim (any client, the Data API)
    expect((await post(user, 'FOrders', { values: { Title: 'plain' } })).status).toBe(200)
    // 2. the claim names a Form that saves into another table than the one written
    expect((await post(user, 'FNotes', { values: { Title: 'wrong table' }, form: { app: appId, form: 'OrderForm' } })).status).toBe(200)
    // 3. the claim names a form or an app that does not exist; the form of a different app
    expect((await post(user, 'FOrders', { values: { Title: 'no form' }, form: { app: appId, form: 'Nope' } })).status).toBe(200)
    expect((await post(user, 'FOrders', { values: { Title: 'no app' }, form: { app: 'app_nope', form: 'OrderForm' } })).status).toBe(200)
    expect((await post(user, 'FOrders', { values: { Title: 'other app' }, form: { app: otherAppId, form: 'OtherForm' } })).status).toBe(200)
    // 4. nonsense claims
    expect((await post(user, 'FOrders', { values: { Title: 'junk' }, form: 'OrderForm' })).status).toBe(200)
    expect((await post(user, 'FOrders', { values: { Title: 'junk2' }, form: { app: 5, form: ['x'] } })).status).toBe(200)
    // 5. a write the server refuses starts nothing (no such column value type, or a table the person may not write)
    const refused = await post(user, 'FOrders', { values: { Title: 'x', Nope: 1 }, form: { app: appId, form: 'OrderForm' } })
    expect(refused.status).toBeGreaterThanOrEqual(400)
    await settle(); await drain()
    expect(await runs(f.id)).toHaveLength(before)
  })

  it('an app the person may not run starts nothing; an operation the trigger does not list starts nothing', async () => {
    const f = await mkFlow({ name: 'Updates only', runAs: 'triggeringUser', trigger: { type: 'formSubmitted', app: appId, form: 'OrderForm', on: ['update'] }, steps: [] })
    expect((await post(user, 'FOrders', { values: { Title: 'created' }, form: { app: appId, form: 'OrderForm' } })).status).toBe(200)
    await settle(); await drain()
    expect(await runs(f.id)).toHaveLength(0)
    // an update with the claim starts it
    const created = await post(user, 'FOrders', { values: { Title: 'to change' } })
    const id = created.data.row.id as string
    const res = await fetch(`${h.base}/api/v1/data/FOrders/rows/${id}`, { method: 'PATCH', headers: { 'X-Appbuilder': '1', 'Content-Type': 'application/json', Cookie: user.cookie }, body: JSON.stringify({ changes: { Title: 'changed' }, form: { app: appId, form: 'OrderForm' } }) })
    expect(res.status).toBe(200)
    await settle(); await drain()
    expect(await runs(f.id)).toHaveLength(1)
  })

  it('a person whose roles do not include the app starts nothing', async () => {
    const f = await mkFlow({ name: 'Run-access guarded', runAs: 'owner', trigger: { type: 'formSubmitted', app: appId, form: 'OrderForm' }, steps: [] })
    const tid = (await h.q<any>(`SELECT id FROM env_default.ab_tables WHERE name = 'FOrders'`))[0].id
    const r = await A().post('/roles', { name: 'OtherAppOnly', apps: [otherAppId], privileges: [{ table: tid, create: true, read: 'all', update: 'all', delete: 'none' }] })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    const u = await A().post('/users', { name: 'Nia Narrow', email: 'nia@example.com', password: 'some-password-1', roleIds: [r.data.id] })
    expect(u.status, JSON.stringify(u.data)).toBe(200)
    await h.q('UPDATE ab.users SET must_change_password = false, password_hash = $1 WHERE email = $2', [await hashPassword('some-password-1'), 'nia@example.com'])
    const nia = new Client(h.base)
    expect((await nia.post('/auth/login', { email: 'nia@example.com', password: 'some-password-1' })).status).toBe(200)
    expect((await post(nia, 'FOrders', { values: { Title: 'not hers' }, form: { app: appId, form: 'OrderForm' } })).status).toBe(200)
    await settle(); await drain()
    expect(await runs(f.id)).toHaveLength(0)
    // the same write for an app she may run does start it
    const g = await mkFlow({ name: 'Other app flow', runAs: 'owner', trigger: { type: 'formSubmitted', app: otherAppId, form: 'OtherForm' }, steps: [] })
    expect((await post(nia, 'FOrders', { values: { Title: 'hers' }, form: { app: otherAppId, form: 'OtherForm' } })).status).toBe(200)
    await settle(); await drain()
    expect(await runs(g.id)).toHaveLength(1)
  })
})
