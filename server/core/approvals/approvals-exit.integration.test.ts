/**
 * P1 exit check 1 with the REAL approvals service (package C): the purchase approval flow (request row created ->
 * manager approval -> above a limit, second approval -> notify the requester -> escalate after a deadline) over a
 * simulated week (flow clock), across two server restarts, with a delegation that starts mid-way and an escalation of
 * an overdue approval to the manager's manager (who has delegated). No step may be lost or run twice; every decision
 * resumes its flow exactly once. (The flow suite keeps its stub version: flows-durability.integration.test.ts.)
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/approvals/approvals-exit
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { setQuiet } from '../util.ts'
import { runInEnvironment } from '../env-context.ts'
import { createApp, type AppServer } from '../app.ts'
import { startHarness, type KernelHarness } from '../kernel-testkit.ts'
import type { UserContext } from '../contracts.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[approvals exit check] ${SKIP_PG}\n`)

/* eslint-disable @typescript-eslint/no-explicit-any */
describe.skipIf(!PG_URL)('exit check 1 with real approvals (PostgreSQL)', () => {
  let h: KernelHarness
  let app: AppServer
  let now = new Date('2030-03-04T09:00:00Z') // a Monday
  const inEnv = <T>(fn: () => Promise<T>) => runInEnvironment('default', fn)
  const q = <T = any>(sql: string, p: unknown[] = []) => h.q<T>(sql, p)
  const ap = () => app.services.approvals!
  const drain = async () => {
    for (let i = 0; i < 10; i++) {
      await app.services.kernel.drain({ timeoutMs: 120_000 })
      const t = await inEnv(() => ap().tick(true))
      const n = await inEnv(() => app.services.flows.sweep(true))
      if (!n && !t.delegations && !t.reminders && !t.escalations) break
    }
    await app.services.kernel.drain({ timeoutMs: 120_000 })
  }
  const restart = async () => {
    await app.close()
    app = await createApp({ env: {}, config: { workspaceDir: h.tmp }, printSetupCode: false, jobs: false })
    expect(app.services.ready()).toBe(true)
    app.services.flows.setClock({ now: () => now })
    h.app = app
  }
  const ctxOf = async (email: string): Promise<UserContext> => inEnv(async () => app.services.security.forUser((await app.services.meta.users.byEmail(email))!))
  const reqOf = async (rowId: string, step: string) => (await q(`SELECT r.* FROM env_default.ab_approval_requests r JOIN env_default.ab_flow_runs f ON f.id = r.flow_run_id WHERE f.regarding_id = $1 AND r.step_key = $2`, [rowId, step]))[0]
  const answer = async (rowId: string, step: string, who: string, outcome: string, comment?: string) => {
    const r = await reqOf(rowId, step)
    expect(r, `${rowId} ${step}`).toBeTruthy()
    return inEnv(async () => ap().respond(await ctxOf(who), r.id, outcome, comment ?? null))
  }
  const pendingOf = async (rowId: string, step: string) => {
    const r = await reqOf(rowId, step)
    return (await q(`SELECT u.email, a.source FROM env_default.ab_approval_assignments a JOIN ab.users u ON u.id = a.user_id WHERE a.request_id = $1 AND a.status = 'pending' ORDER BY u.email`, [r.id])).map((x) => `${x.email}:${x.source}`)
  }

  beforeAll(async () => {
    h = await startHarness('apprexit')
    app = h.app
    app.services.flows.setClock({ now: () => now })
    const A = h.admin
    expect((await A.post('/tables', { displayName: 'Purchase requests', name: 'PurchaseRequests', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Amount', type: 'number' }, { displayName: 'Requester', type: 'text' }, { displayName: 'Manager', type: 'text' }, { displayName: 'Status', type: 'text' }] })).status).toBe(200)
    const mk = async (name: string, email: string, extra: any = {}) => {
      const u = await A.post('/users', { name, email, roleIds: ['role_maker'], password: 'some-password-1', ...extra })
      expect(u.status, JSON.stringify(u.data)).toBe(200)
      return u.data.id as string
    }
    const dev = await mk('Dev Director', 'dev@example.com')
    await mk('Mona Manager', 'mona@example.com', { managerId: dev })
    await mk('Rae Requester', 'rae@example.com')
    await mk('Del Deputy', 'del@example.com')
  }, 180000)

  afterAll(async () => { await h?.close() }, 60000)

  it('purchase approval over a simulated week: two restarts, a delegation mid-way, an escalation', async () => {
    const def = {
      name: 'Purchase approval', enabled: true,
      settings: { concurrency: 'perRecord', timeoutMinutes: 14 * 24 * 60, retentionDays: 90, onError: 'fail' },
      trigger: { type: 'table', table: 'PurchaseRequests', on: ['create'] },
      steps: [
        { id: 'mgr', name: 'Mgr', kind: 'approval', title: '"Purchase: " & Trigger.Record.Title', approvers: 'Trigger.Record.Manager', fields: { Amount: 'Trigger.Record.Amount', Requester: 'Trigger.Record.Requester' },
          dueMinutes: 2 * 24 * 60, escalation: { action: 'manager' }, reminders: { afterMinutes: 24 * 60 }, timeoutMinutes: 5 * 24 * 60, regarding: { table: 'PurchaseRequests', rowId: 'Trigger.Record' } },
        { id: 'esc', name: 'Esc', kind: 'scope', runAfter: [{ step: 'mgr', when: ['timedOut'] }], steps: [
          { id: 'escn', name: 'EscNotify', kind: 'notify', to: '"dev@example.com"', title: '"Escalated: " & Trigger.Record.Title', body: '"Nobody answered in 5 days."', channels: ['inApp'] },
          { id: 'escs', name: 'EscStatus', kind: 'data.update', table: 'PurchaseRequests', rowId: 'Trigger.Record', values: { Status: '"Escalated"' } },
        ] },
        { id: 'decide', name: 'Decide', kind: 'condition', runAfter: [{ step: 'esc', when: ['succeeded', 'skipped'] }],
          if: 'Steps.Mgr.Status = "timedOut" || (Steps.Mgr.Output.Outcome = "Approve" && Trigger.Record.Amount > 10000)',
          then: [{ id: 'dir', name: 'Dir', kind: 'approval', title: '"Second approval: " & Trigger.Record.Title', approvers: '"dev@example.com"', options: ['Approve', 'Reject'], requireCommentOnReject: true, timeoutMinutes: 4 * 24 * 60, regarding: { table: 'PurchaseRequests', rowId: 'Trigger.Record' } }] },
        { id: 'final', name: 'Final', kind: 'compose', value: 'If(Steps.Decide.Output.Result, Steps.Dir.Output.Outcome, Steps.Mgr.Output.Outcome)' },
        { id: 'status', name: 'SetStatus', kind: 'data.update', table: 'PurchaseRequests', rowId: 'Trigger.Record', values: { Status: 'If(Steps.Final.Output = "Approve", "Approved", "Rejected")' } },
        { id: 'tell', name: 'Tell', kind: 'notify', to: 'Trigger.Record.Requester', title: '"Request " & Trigger.Record.Title & ": " & If(Steps.Final.Output = "Approve", "approved", "rejected") & " by " & Last(If(Steps.Decide.Output.Result, Steps.Dir.Output.Responses, Steps.Mgr.Output.Responses)).Name', body: '""', channels: ['inApp'] },
      ],
    }
    const r = await h.admin.post('/flows', def)
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    const flowId = r.data.flow.id
    const insert = async (Title: string, Amount: number) => inEnv(async () => {
      const t = (await app.services.meta.tables.list()).find((x) => x.name === 'PurchaseRequests')!
      return app.services.data.insert(await ctxOf('ada@example.com'), t, { Title, Amount, Requester: 'rae@example.com', Manager: 'mona@example.com', Status: 'New' } as any)
    })
    const r1 = String((await insert('Chairs', 5000)).id)
    const r2 = String((await insert('Server', 50000)).id)
    const r3 = String((await insert('Laptops', 20000)).id)
    const r4 = String((await insert('Coffee', 3000)).id)
    await drain()
    expect((await q(`SELECT count(*)::int AS n FROM env_default.ab_approval_requests WHERE flow_id = $1`, [flowId]))[0].n).toBe(4)
    expect(await pendingOf(r1, '/mgr')).toEqual(['mona@example.com:direct'])

    // Monday 11:00: Mona answers three of them (the decisions commit with their flow.resume jobs)
    now = new Date('2030-03-04T11:00:00Z')
    expect(await answer(r1, '/mgr', 'mona@example.com', 'Approve')).toMatchObject({ status: 'approved' })
    expect(await answer(r2, '/mgr', 'mona@example.com', 'Approve', 'Needed for the build farm')).toMatchObject({ status: 'approved' })
    expect(await answer(r4, '/mgr', 'mona@example.com', 'Reject', 'Not this month')).toMatchObject({ status: 'rejected' })
    // restart 1 before the resume jobs ran (they wait in the queue)
    await restart()
    await drain()
    expect(await pendingOf(r2, '/decide.then/dir')).toEqual(['dev@example.com:direct'])

    // Dev goes on leave Tuesday to Friday: Del decides for him, also what is already waiting (retroactively)
    await inEnv(async () => ap().createDelegation(await ctxOf('dev@example.com'), { toUser: 'del@example.com', startsOn: '2030-03-05T00:00:00Z', endsOn: '2030-03-08T00:00:00Z', note: 'Conference' }))
    now = new Date('2030-03-05T08:00:00Z')
    await drain()
    expect(await pendingOf(r2, '/decide.then/dir')).toEqual(['del@example.com:delegation'])
    // Tuesday 09:30: the reminder of the Laptops (asked a day ago, unanswered) went to Mona
    now = new Date('2030-03-05T09:30:00Z')
    await drain()
    expect((await q(`SELECT count(*)::int AS n FROM env_default.ab_approval_history h JOIN env_default.ab_approval_requests r ON r.id = h.request_id WHERE h.action = 'reminded' AND r.title = 'Purchase: Laptops'`))[0].n).toBe(1)

    // Wednesday 10:00: the Laptops approval is overdue (due Wednesday 09:00): escalated to Mona's manager Dev, who
    // delegated: Del is asked in Mona's place
    now = new Date('2030-03-06T10:00:00Z')
    await drain()
    expect(await pendingOf(r3, '/mgr')).toEqual(['del@example.com:escalation'])
    // Del approves the server (second approval) and the laptops (first approval, escalated)
    now = new Date('2030-03-06T11:00:00Z')
    expect(await answer(r2, '/decide.then/dir', 'del@example.com', 'Approve')).toMatchObject({ status: 'approved' })
    expect(await answer(r3, '/mgr', 'del@example.com', 'Approve')).toMatchObject({ status: 'approved' })
    await drain()
    // the laptops' second approval went to Dev, delegated to Del at once
    expect(await pendingOf(r3, '/decide.then/dir')).toEqual(['del@example.com:delegation'])

    // restart 2
    await restart()
    // Thursday 15:00: Del rejects the laptops (a comment is required)
    now = new Date('2030-03-07T15:00:00Z')
    await expect(answer(r3, '/decide.then/dir', 'del@example.com', 'Reject')).rejects.toMatchObject({ status: 422 })
    expect(await answer(r3, '/decide.then/dir', 'del@example.com', 'Reject', 'Wait for the new models')).toMatchObject({ status: 'rejected' })
    await drain()
    // the rest of the week passes (the delegation ends Friday 00:00)
    now = new Date('2030-03-11T09:00:00Z')
    await drain()

    const runs = await q('SELECT id, state, regarding_id FROM env_default.ab_flow_runs WHERE flow_id = $1', [flowId])
    expect(runs).toHaveLength(4)
    expect(runs.every((x) => x.state === 'succeeded'), JSON.stringify(runs)).toBe(true)
    const status = Object.fromEntries((await q(`SELECT id, "Status" FROM env_default.t_purchaserequests`)).map((x) => [x.id, x.Status]))
    expect(status).toEqual({ [r1]: 'Approved', [r2]: 'Approved', [r3]: 'Rejected', [r4]: 'Rejected' })
    // exactly the approvals asked for: 4 first, 2 second; every request decided once and resumed its step once
    const reqs = await q(`SELECT title, status, outcome FROM env_default.ab_approval_requests WHERE flow_id = $1 ORDER BY title`, [flowId])
    expect(reqs.map((x) => `${x.title}=${x.status}`)).toEqual([
      'Purchase: Chairs=approved', 'Purchase: Coffee=rejected', 'Purchase: Laptops=approved', 'Purchase: Server=approved', 'Second approval: Laptops=rejected', 'Second approval: Server=approved',
    ])
    const waits = await q(`SELECT w.state, count(*)::int AS n FROM env_default.ab_flow_waits w JOIN env_default.ab_flow_runs f ON f.id = w.run_id WHERE f.flow_id = $1 GROUP BY w.state`, [flowId])
    expect(waits).toEqual([{ state: 'resumed', n: 6 }])
    const resumes = await q(`SELECT count(*)::int AS n FROM env_default.ab_jobs WHERE type = 'flow.resume' AND state = 'succeeded'`)
    expect(resumes[0].n).toBe(6)
    // one message per request, naming who decided
    expect((await q(`SELECT title FROM ab.notifications WHERE title LIKE 'Request %' ORDER BY title`)).map((x) => x.title)).toEqual([
      'Request Chairs: approved by Mona Manager', 'Request Coffee: rejected by Mona Manager', 'Request Laptops: rejected by Del Deputy', 'Request Server: approved by Del Deputy',
    ])
    // every data change once
    const changes = await q(`SELECT row_id, count(*)::int AS n FROM env_default.ab_outbox o JOIN env_default.ab_tables t ON t.id = o.table_id WHERE t.name = 'PurchaseRequests' AND o.op = 'update' GROUP BY row_id`)
    expect(Object.fromEntries(changes.map((x) => [x.row_id, x.n]))).toEqual({ [r1]: 1, [r2]: 1, [r3]: 1, [r4]: 1 })
    // the steps of the laptops ran once each; the escalation and delegations are in the request history
    const s3 = await q(`SELECT step_key, state, attempt FROM env_default.ab_flow_steps WHERE run_id = (SELECT id FROM env_default.ab_flow_runs WHERE regarding_id = $1) ORDER BY ord`, [r3])
    expect(s3.map((x) => `${x.step_key}=${x.state}`)).toEqual(['/mgr=succeeded', '/esc=skipped', '/decide=succeeded', '/decide.then/dir=succeeded', '/final=succeeded', '/status=succeeded', '/tell=succeeded'])
    const hist = (await q(`SELECT h.action FROM env_default.ab_approval_history h JOIN env_default.ab_approval_requests r ON r.id = h.request_id WHERE r.title = 'Purchase: Laptops' ORDER BY h.at, h.seq`)).map((x) => x.action)
    expect(hist).toEqual(['requested', 'asked', 'reminded', 'escalated', 'asked', 'responded', 'decided'])
    // the step output carries the responses with name and comment
    const dirOut = (await q(`SELECT output FROM env_default.ab_flow_steps WHERE run_id = (SELECT id FROM env_default.ab_flow_runs WHERE regarding_id = $1) AND step_key = '/decide.then/dir'`, [r3]))[0].output
    expect(dirOut).toMatchObject({ Outcome: 'Reject', Status: 'rejected', Comments: 'Del Deputy: Wait for the new models' })
    expect(dirOut.Responses[0]).toMatchObject({ Approver: 'del@example.com', Name: 'Del Deputy', Response: 'Reject', Comment: 'Wait for the new models' })
    expect(dirOut.Approvers.map((a: any) => `${a.Approver}:${a.Source}:${a.Status}`)).toEqual(['del@example.com:delegation:responded'])
  }, 300000)
})
