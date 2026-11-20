/**
 * Who caused a run, and what a flow may do on their behalf (P3 package M2 follow-up; docs/dev/flows.md "Identity and
 * security", docs/dev/approvals.md "Flows"), with the REAL approvals service against the sandbox PostgreSQL:
 *  - an approval started by a flow that runs as its owner treats the person whose change started the run as the
 *    requester for routing: they are not asked (self-approval), the fallback is THEIR manager; the flow's identity is
 *    not asked either; `requester` can name one more person the flow knows (never un-blocks anyone);
 *  - data.create `owner`: an administrator's flow gives the new row to the triggering user (an own-rows role then sees
 *    it); a maker's flow may give it only to itself or a team of its own (the assign-owner rule);
 *  - notify `roles` / `teams`: resolved when the step runs to the active members (disabled people are not notified).
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/flows/flows-identity
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { setQuiet } from '../util.ts'
import { runInEnvironment } from '../env-context.ts'
import { Client, startHarness, type KernelHarness } from '../kernel-testkit.ts'
import { hashPassword } from '../password.ts'
import type { UserContext } from '../contracts.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[flows identity integration] ${SKIP_PG}\n`)

/* eslint-disable @typescript-eslint/no-explicit-any */
describe.skipIf(!PG_URL)('flows: the triggering user (PostgreSQL)', { timeout: 120_000 }, () => {
  let h: KernelHarness
  const A = () => h.admin
  const inEnv = <T>(fn: () => Promise<T>) => runInEnvironment('default', fn)
  const settings = { concurrency: 'parallel', timeoutMinutes: 600, retentionDays: 30, onError: 'fail' }
  const ids: Record<string, string> = {}
  let checkers = ''
  let solo = ''
  let team = ''
  const drain = async () => {
    for (let i = 0; i < 8; i++) {
      await h.app.services.kernel.drain({ timeoutMs: 60_000 })
      const t = await inEnv(() => h.app.services.approvals!.tick(true))
      const n = await inEnv(() => h.app.services.flows.sweep(true))
      if (!n && !t.delegations && !t.reminders && !t.escalations) break
    }
    await h.app.services.kernel.drain({ timeoutMs: 60_000 })
  }
  const ctxOf = async (email: string): Promise<UserContext> => inEnv(async () => h.app.services.security.forUser((await h.app.services.meta.users.byEmail(email))!))
  const insert = async (email: string, table: string, values: Record<string, unknown>) => inEnv(async () => {
    const t = (await h.app.services.meta.tables.list()).find((x) => x.name === table)!
    return h.app.services.data.insert(await ctxOf(email), t, values as any) as Promise<Record<string, unknown>>
  })
  const mkFlow = async (body: any, c: Client = A()) => {
    const r = await c.post('/flows', { settings, enabled: true, ...body })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return r.data.flow
  }
  const requestOf = async (flowId: string) => (await h.q<any>('SELECT * FROM env_default.ab_approval_requests WHERE flow_id = $1 ORDER BY created_on DESC', [flowId]))[0]
  const pending = async (requestId: string) => (await h.q<any>(`SELECT u.email, a.source FROM env_default.ab_approval_assignments a JOIN ab.users u ON u.id = a.user_id WHERE a.request_id = $1 AND a.status = 'pending' ORDER BY u.email`, [requestId])).map((x) => `${x.email}:${x.source}`)
  const failedSteps = async (flowId: string) => (await h.q<any>(`SELECT s.step_id, s.error FROM env_default.ab_flow_steps s JOIN env_default.ab_flow_runs r ON r.id = s.run_id WHERE r.flow_id = $1 AND s.state = 'failed'`, [flowId]))

  beforeAll(async () => {
    h = await startHarness('flowsid')
    for (const t of [
      { displayName: 'GRequests', name: 'GRequests', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Amount', type: 'number' }, { displayName: 'RequestedFor', type: 'text' }] },
      { displayName: 'GTasks', name: 'GTasks', columns: [{ displayName: 'Title', type: 'text' }] },
    ]) expect((await A().post('/tables', t)).status).toBe(200)
    const tables = await h.q<any>('SELECT id, name FROM env_default.ab_tables')
    const tid = (n: string) => tables.find((x: any) => x.name === n).id
    const role = async (name: string, read: string) => {
      const r = await A().post('/roles', { name, apps: 'all', privileges: [{ table: tid('GRequests'), create: true, read: 'all', update: 'all', delete: 'none' }, { table: tid('GTasks'), create: true, read, update: read, delete: 'none' }] })
      expect(r.status, JSON.stringify(r.data)).toBe(200)
      return r.data.id as string
    }
    checkers = await role('Checkers', 'own')
    solo = await role('Solo', 'own')
    const mk = async (name: string, email: string, extra: any = {}) => {
      const u = await A().post('/users', { name, email, password: 'some-password-1', ...extra })
      expect(u.status, JSON.stringify(u.data)).toBe(200)
      ids[email] = u.data.id
      await h.q('UPDATE ab.users SET must_change_password = false, password_hash = $1 WHERE email = $2', [await hashPassword('some-password-1'), email])
      return u.data.id as string
    }
    const staff = await A().post('/roles', { name: 'Staff', apps: 'all', privileges: [] })
    const mia = await mk('Mia Manager', 'mia@example.com', { roleIds: [staff.data.id] })
    await mk('Ivy Inspector', 'ivy@example.com', { roleIds: [checkers, solo], managerId: mia })
    await mk('Quinn Checker', 'quinn@example.com', { roleIds: [checkers] })
    await mk('Zed Disabled', 'zed@example.com', { roleIds: [checkers] })
    await mk('Max Maker', 'max@example.com', { roleIds: ['role_maker', checkers] })
    expect((await A().patch(`/users/${ids['zed@example.com']}`, { status: 'disabled' })).status).toBe(200)
    const tm = await A().post('/teams', { code: 'NIGHT', name: 'Night shift', memberIds: [ids['mia@example.com']] })
    expect(tm.status, JSON.stringify(tm.data)).toBe(200)
    team = tm.data.id
    ids['ada@example.com'] = (await h.q<any>(`SELECT id FROM ab.users WHERE email = 'ada@example.com'`))[0].id
  }, 180_000)

  afterAll(async () => { await h?.close() }, 60_000)

  it('approval from a flow: the person whose change started it is not asked; the flow\'s identity is not either', async () => {
    const f = await mkFlow({ name: 'Check request', trigger: { type: 'table', table: 'GRequests', on: ['create'], condition: 'Trigger.Record.Title = "A"' },
      steps: [{ id: 'ask', name: 'Ask', kind: 'approval', title: '"Check " & Trigger.Record.Title', approvers: '"role:Checkers"', regarding: { table: 'GRequests', rowId: 'Trigger.Record' } }] })
    await insert('ivy@example.com', 'GRequests', { Title: 'A', Amount: 5 })
    await drain()
    const r = await requestOf(f.id)
    expect(r, 'the request').toBeTruthy()
    // who asks stays the flow (visibility, withdraw, the decision notice are unchanged); Ivy is who it is about
    expect(r.requested_by).toBe(ids['ada@example.com'])
    expect(await pending(r.id)).toEqual(['max@example.com:role', 'quinn@example.com:role'])
    const notes = (await h.q<any>(`SELECT details FROM env_default.ab_approval_history WHERE request_id = $1 AND action = 'routing.self'`, [r.id])).map((x) => JSON.stringify(x.details))
    expect(notes.join(' ')).toMatch(/Ivy Inspector/)
    await expect(inEnv(async () => h.app.services.approvals!.respond(await ctxOf('ivy@example.com'), r.id, 'Approve', null))).rejects.toThrow()
    expect(await inEnv(async () => h.app.services.approvals!.respond(await ctxOf('quinn@example.com'), r.id, 'Approve', null))).toMatchObject({ status: 'approved' })
  })

  it('nobody else to ask: the fallback is the triggering user\'s manager, not the flow owner\'s', async () => {
    const f = await mkFlow({ name: 'Solo check', trigger: { type: 'table', table: 'GRequests', on: ['create'], condition: 'Trigger.Record.Title = "B"' },
      steps: [{ id: 'ask', name: 'Ask', kind: 'approval', title: '"Solo " & Trigger.Record.Title', approvers: '"role:Solo"' }] })
    await insert('ivy@example.com', 'GRequests', { Title: 'B' })
    await drain()
    const r = await requestOf(f.id)
    expect(await pending(r.id)).toEqual(['mia@example.com:fallback'])
    expect(await inEnv(async () => h.app.services.approvals!.respond(await ctxOf('mia@example.com'), r.id, 'Approve', null))).toMatchObject({ status: 'approved' })
  })

  it('requester names one more person the flow knows: routing starts from them; the triggering user stays blocked', async () => {
    const f = await mkFlow({ name: 'For someone', trigger: { type: 'table', table: 'GRequests', on: ['create'], condition: 'Trigger.Record.Title = "C"' },
      steps: [{ id: 'ask', name: 'Ask', kind: 'approval', title: '"For " & Trigger.Record.RequestedFor', approvers: '"role:Checkers"', requester: 'Trigger.Record.RequestedFor' }] })
    // Quinn enters it for Ivy: neither may approve; Max may; with Max gone too, Ivy's manager decides
    await insert('quinn@example.com', 'GRequests', { Title: 'C', RequestedFor: 'ivy@example.com' })
    await drain()
    const r = await requestOf(f.id)
    expect(await pending(r.id)).toEqual(['max@example.com:role'])
    // a requester that is nobody: the step fails with the reason (it never silently drops the rule)
    const g = await mkFlow({ name: 'For nobody', trigger: { type: 'table', table: 'GRequests', on: ['create'], condition: 'Trigger.Record.Title = "D"' },
      steps: [{ id: 'ask', name: 'Ask', kind: 'approval', title: '"x"', approvers: '"role:Checkers"', requester: 'Trigger.Record.RequestedFor' }] })
    await insert('quinn@example.com', 'GRequests', { Title: 'D', RequestedFor: 'nobody@example.com' })
    await drain()
    expect(JSON.stringify(await failedSteps(g.id))).toMatch(/requester/)
  })

  it('data.create owner: an administrator\'s flow gives the row to the triggering user; a maker\'s flow only to itself or its team', async () => {
    const tasks = (await h.q<any>(`SELECT source FROM env_default.ab_tables WHERE name = 'GTasks'`))[0].source
    const f = await mkFlow({ name: 'Task for the reporter', trigger: { type: 'table', table: 'GRequests', on: ['create'], condition: 'Trigger.Record.Title = "T"' },
      steps: [{ id: 'mk', name: 'MakeTask', kind: 'data.create', table: 'GTasks', values: { Title: '"Follow up"' }, owner: 'Trigger.User' }] })
    const own = await insert('ivy@example.com', 'GRequests', { Title: 'T' })
    await drain()
    expect(await failedSteps(f.id)).toEqual([])
    const task = (await h.q<any>(`SELECT t.* FROM env_default.ab_flow_steps s JOIN env_default.ab_flow_runs r ON r.id = s.run_id JOIN env_default."${tasks}" t ON t.id = (s.output->>'__id') WHERE r.flow_id = $1 AND r.regarding_id = $2`, [f.id, own.id]))[0]
    expect(task?.owner).toBe(ids['ivy@example.com'])
    expect(task?.createdBy).toBe(ids['ada@example.com'])
    // Ivy's own-rows role sees it now
    const seen = await inEnv(async () => (h.app.services.data as any).queryV2(await ctxOf('ivy@example.com'), (await h.app.services.meta.tables.list()).find((x) => x.name === 'GTasks')!, { version: 2, table: 'GTasks', select: ['id'] }))
    expect((seen as any).rows.map((x: any) => x.id)).toContain(task.id)
    // a maker's flow (runs as Max, not an administrator): giving the row to someone else is refused, to Max is fine
    const max = new Client(h.base)
    expect((await max.post('/auth/login', { email: 'max@example.com', password: 'some-password-1' })).status).toBe(200)
    const m1 = await mkFlow({ name: 'Maker gives away', trigger: { type: 'table', table: 'GRequests', on: ['create'], condition: 'Trigger.Record.Title = "M"' },
      steps: [{ id: 'mk', name: 'MakeTask', kind: 'data.create', table: 'GTasks', values: { Title: '"Given"' }, owner: 'Trigger.User' }] }, max)
    const m2 = await mkFlow({ name: 'Maker keeps', trigger: { type: 'table', table: 'GRequests', on: ['create'], condition: 'Trigger.Record.Title = "M"' },
      steps: [{ id: 'mk', name: 'MakeTask', kind: 'data.create', table: 'GTasks', values: { Title: '"Kept"' }, owner: '"max@example.com"' }] }, max)
    await insert('ivy@example.com', 'GRequests', { Title: 'M' })
    await drain()
    expect(JSON.stringify(await failedSteps(m1.id))).toMatch(/only to (itself|yourself)|administrator/)
    expect((await h.q<any>(`SELECT count(*)::int AS n FROM env_default."${tasks}" WHERE "Title" = 'Given'`))[0].n).toBe(0)
    expect(await failedSteps(m2.id)).toEqual([])
    expect((await h.q<any>(`SELECT owner FROM env_default."${tasks}" WHERE "Title" = 'Kept'`))[0].owner).toBe(ids['max@example.com'])
  })

  it('notify roles and teams: the active members when the step runs (a disabled person is not notified)', async () => {
    const f = await mkFlow({ name: 'Tell checkers', trigger: { type: 'table', table: 'GRequests', on: ['create'], condition: 'Trigger.Record.Title = "N"' },
      steps: [{ id: 'n', name: 'Tell', kind: 'notify', roles: ['Checkers'], teams: [team], title: '"Role notice " & Trigger.Record.Title', body: '""', channels: ['inApp'] }] })
    await insert('ivy@example.com', 'GRequests', { Title: 'N' })
    await drain()
    expect(await failedSteps(f.id)).toEqual([])
    const got = (await h.q<any>(`SELECT u.email FROM ab.notifications n JOIN ab.users u ON u.id = n.user_id WHERE n.title = 'Role notice N' ORDER BY u.email`)).map((x) => x.email)
    expect(got).toEqual(['ivy@example.com', 'max@example.com', 'mia@example.com', 'quinn@example.com'])
    // a role given by its id works too; an unknown role is a save-time problem
    const v = await A().post('/flows/validate', { name: 'x', settings, trigger: { type: 'manual', from: 'any', inputs: [] }, steps: [{ id: 'n', name: 'Tell', kind: 'notify', roles: ['No such role'], title: '"x"', body: '""', channels: ['inApp'] }] })
    expect(JSON.stringify(v.data.problems)).toMatch(/No such role/)
    const v2 = await A().post('/flows/validate', { name: 'x', settings, trigger: { type: 'manual', from: 'any', inputs: [] }, steps: [{ id: 'n', name: 'Tell', kind: 'notify', roles: [checkers, solo], title: '"x"', body: '""', channels: ['inApp'] }] })
    expect(v2.data.problems.filter((p: any) => p.severity === 'error')).toEqual([])
  })
})
