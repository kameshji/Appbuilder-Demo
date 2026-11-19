/**
 * Durability of flow runs (P1 exit check 1; docs/dev/flows.md "Guarantees"):
 *  - a crash matrix: the worker dies at each point of the step lifecycle (inside the step's transaction, after its
 *    commit, after an external call was claimed, after it was made, while suspending and resuming); the run still ends
 *    once, data steps write exactly once, external calls happen at most twice with the same idempotency key;
 *  - the purchase approval flow over a simulated week (flow clock) with two server restarts: no lost or duplicated step;
 *  - throughput: N runs of a 6-step flow (FLOW_THROUGHPUT_RUNS, default 2000): runs per second and p95 step latency.
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/flows/flows-durability
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { setQuiet } from '../util.ts'
import { runInEnvironment } from '../env-context.ts'
import { createApp, type AppServer } from '../app.ts'
import { startHarness, type KernelHarness } from '../kernel-testkit.ts'
import type { ActionsService } from '../actions/contracts.ts'
import type { UserContext } from '../contracts.ts'
import type { ApprovalRequest } from './contracts.ts'
import { FaultCrash, setFaultHook } from './engine.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[server/core/flows durability] ${SKIP_PG}\n`)

/* eslint-disable @typescript-eslint/no-explicit-any */
describe.skipIf(!PG_URL)('flow durability (PostgreSQL)', () => {
  let h: KernelHarness
  let app: AppServer
  let now = new Date('2030-03-04T09:00:00Z') // a Monday
  const approvals: ApprovalRequest[] = []
  const calls: { key?: string }[] = []
  const fl = () => app.services.flows
  const inEnv = <T>(fn: () => Promise<T>) => runInEnvironment('default', fn)
  const drain = async () => {
    for (let i = 0; i < 8; i++) {
      await app.services.kernel.drain({ timeoutMs: 120_000 })
      const n = await inEnv(() => fl().sweep(true))
      if (!n) break
    }
  }
  const q = <T = any>(sql: string, p: unknown[] = []) => h.q<T>(sql, p)
  const fake: ActionsService = {
    kinds: () => [], list: async () => [{ id: 'post', title: 'Post', description: '', inputs: {}, outputs: {}, idempotent: false, sideEffect: 'external', timeoutMs: 1000 }], describe: async () => { throw new Error('n/a') },
    async run(_e, _c, _a, inputs, _i, o) { calls.push({ key: o?.idempotencyKey }); return { ok: true, output: { status: 200, headers: {}, body: inputs } } },
    canUse: async () => true, canManage: async () => true, assertCanUse: async () => {},
    state: () => ({ circuit: 'closed', failures: 0, retryAt: null, inFlight: 0, maxConcurrent: 4, perMinute: 60, lastError: null }),
  }
  /** what every (re)started server needs: the stub approvals (package C), the fake actions (package D), the clock */
  const wire = (a: AppServer) => {
    a.services.flows.setApprovals({ async request(_env, req) { approvals.push(req); return { id: `appr_${approvals.length}` } } })
    ;(a.services as any).actions = fake
    a.services.flows.setClock({ now: () => now })
  }
  const restart = async () => {
    await app.close()
    app = await createApp({ env: {}, config: { workspaceDir: h.tmp }, printSetupCode: false, jobs: false })
    expect(app.services.ready()).toBe(true)
    wire(app)
    h.app = app
  }
  let admin: UserContext
  const ctxOf = async (email: string) => inEnv(async () => app.services.security.forUser((await app.services.meta.users.byEmail(email))!))
  const insert = async (table: string, values: Record<string, unknown>) => inEnv(async () => {
    const t = (await app.services.meta.tables.list()).find((x) => x.name === table)!
    return app.services.data.insert(await ctxOf('ada@example.com'), t, values as any)
  })

  beforeAll(async () => {
    h = await startHarness('flowsdur')
    app = h.app
    wire(app)
    const A = h.admin
    for (const t of [
      { displayName: 'Purchase requests', name: 'PurchaseRequests', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Amount', type: 'number' }, { displayName: 'Requester', type: 'text' }, { displayName: 'Manager', type: 'text' }, { displayName: 'Status', type: 'text' }] },
      { displayName: 'Crash log', name: 'CrashLog', columns: [{ displayName: 'Ref', type: 'text' }, { displayName: 'N', type: 'number' }] },
    ]) expect((await A.post('/tables', t)).status).toBe(200)
    for (const [name, email] of [['Mona Manager', 'mona@example.com'], ['Dev Director', 'dev@example.com'], ['Rae Requester', 'rae@example.com']]) {
      const u = await A.post('/users', { name, email, roleIds: ['role_maker'], password: 'some-password-1' })
      expect(u.status, JSON.stringify(u.data)).toBe(200)
    }
    await inEnv(async () => { admin = await ctxOf('ada@example.com') })
    void admin
  }, 180000)

  afterAll(async () => {
    setFaultHook(null)
    await h?.close()
  }, 60000)

  it('crash matrix: a worker that dies at any point loses and duplicates nothing', async () => {
    const settings = { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' }
    const r = await h.admin.post('/flows', {
      name: 'Crashy', settings, enabled: true, connections: { api: 'conn_default' },
      trigger: { type: 'manual', inputs: [{ name: 'Ref', type: 'text' }], from: 'any' },
      steps: [
        { id: 'c', name: 'C', kind: 'data.create', table: 'CrashLog', values: { Ref: 'Trigger.Inputs.Ref', N: '1' } },
        { id: 'h', name: 'H', kind: 'action', connection: 'api', action: 'post', inputs: { ref: 'Trigger.Inputs.Ref' } },
        { id: 'w', name: 'W', kind: 'delay', minutes: 1 },
        { id: 's', name: 'S', kind: 'scope', steps: [{ id: 'u', name: 'U', kind: 'data.update', table: 'CrashLog', rowId: 'Steps.C.Output', values: { N: 'Steps.C.Output.N + 6' } }] },
        { id: 'f', name: 'F', kind: 'compose', value: '"done"' },
      ],
    })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    const flow = r.data.flow
    const points = ['step:before-commit', 'step:after-commit', 'external:after-claim', 'external:after-call', 'suspend:before-commit', 'suspend:after-commit', 'resume:before-commit', 'resume:after-commit', 'enter:before-commit', 'enter:after-commit']
    for (const point of points) {
      let fired = 0
      let runId = ''
      setFaultHook((p, info) => {
        if (p === point && info.runId === runId && fired === 0 && (p !== 'step:before-commit' || info.kind === 'data.create') && (p !== 'step:after-commit' || info.kind === 'data.update')) {
          fired++
          throw new FaultCrash(`crash at ${p}`)
        }
      })
      const ref = `crash-${point}`
      const before = calls.length
      runId = (await inEnv(() => fl().runManual(admin, flow, { Ref: ref }))).id
      await drain()
      now = new Date(now.getTime() + 2 * 60_000)
      await drain()
      const run = (await q('SELECT state FROM env_default.ab_flow_runs WHERE id = $1', [runId]))[0]
      expect(fired, point).toBe(1)
      expect(run.state, point).toBe('succeeded')
      const rows = await q(`SELECT "N" FROM env_default.t_crashlog WHERE "Ref" = $1`, [ref])
      expect(rows.map((x) => Number(x.N)), point).toEqual([7])
      const mine = calls.slice(before).filter((c) => c.key === `${runId}:/h`)
      expect(mine.length, point).toBe(point === 'external:after-call' ? 2 : 1)
      const steps = await q('SELECT step_key, state FROM env_default.ab_flow_steps WHERE run_id = $1 ORDER BY ord', [runId])
      expect(steps.map((s) => `${s.step_key}=${s.state}`), point).toEqual(['/c=succeeded', '/h=succeeded', '/w=succeeded', '/s=succeeded', '/s/u=succeeded', '/f=succeeded'])
    }
    setFaultHook(null)
  }, 300000)

  it('notify after a crash between sending and recording: one in-app notification (idempotency key)', async () => {
    const settings = { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' }
    const r = await h.admin.post('/flows', {
      name: 'NotifyOnce', settings, enabled: true,
      trigger: { type: 'manual', inputs: [{ name: 'Ref', type: 'text' }], from: 'any' },
      steps: [{ id: 'n', name: 'N', kind: 'notify', to: '"mona@example.com"', title: '"once " & Trigger.Inputs.Ref', body: '"b"', channels: ['inApp', 'email'] }],
    })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    let fired = 0
    let runId = ''
    setFaultHook((p, info) => {
      if (p === 'external:after-call' && info.runId === runId && fired === 0) {
        fired++
        throw new FaultCrash('crash after the notification was sent')
      }
    })
    runId = (await inEnv(() => fl().runManual(admin, r.data.flow, { Ref: 'n1' }))).id
    await drain()
    setFaultHook(null)
    expect(fired).toBe(1)
    expect((await q('SELECT state FROM env_default.ab_flow_runs WHERE id = $1', [runId]))[0].state).toBe('succeeded')
    const mona = await app.services.meta.users.byEmail('mona@example.com')
    const rows = await q(`SELECT id FROM ab.notifications WHERE user_id = $1 AND title = 'once n1'`, [mona!.id])
    expect(rows.length).toBe(1)
    // the email channel (no SMTP here: logged as skipped) is recorded once too
    const log = await q(`SELECT channel FROM ab.notification_deliveries WHERE notification_id = $1 AND channel = 'email'`, [rows[0].id])
    expect(log.length).toBeLessThanOrEqual(1)
    // a direct second call with the same key is a no-op for that recipient
    const again = await app.services.notifications!.notify({ userIds: [mona!.id] }, { kind: 'flow', title: 'once n1', source: 'test', environmentId: 'default', idempotencyKey: `${runId}:/n` })
    expect(again.delivered).toEqual([mona!.id])
    expect((await q(`SELECT id FROM ab.notifications WHERE user_id = $1 AND title = 'once n1'`, [mona!.id])).length).toBe(1)
  }, 120000)

  it('throughput: runs of a 6-step flow', async () => {
    const N = Number(process.env.FLOW_THROUGHPUT_RUNS) || 2000
    now = new Date()
    app.services.flows.setClock({ now: () => new Date() })
    const r = await h.admin.post('/flows', {
      name: 'Six steps', enabled: true, settings: { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail', maxRunsPerMinute: 600 },
      trigger: { type: 'manual', inputs: [{ name: 'I', type: 'number' }], from: 'any' }, variables: [{ name: 'X', type: 'number' }],
      steps: [
        { id: 'a', name: 'A', kind: 'compose', value: 'Trigger.Inputs.I * 2' },
        { id: 'b', name: 'B', kind: 'setVariable', variable: 'X', value: 'Steps.A.Output + 1' },
        { id: 'c', name: 'C', kind: 'condition', if: 'Variables.X > 0', then: [{ id: 'd', name: 'D', kind: 'data.create', table: 'CrashLog', values: { Ref: '"tp"', N: 'Variables.X' } }] },
        { id: 'e', name: 'E', kind: 'compose', value: 'Steps.D.Output.N' },
        { id: 'f', name: 'F', kind: 'respond', body: '{N: Steps.E.Output}' },
      ],
    })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    const flow = (await inEnv(() => fl().store.get(r.data.flow.id)))!
    admin = await ctxOf('ada@example.com')
    // the per-flow rate would hold runs beyond 600 a minute for the next minute: lift it for the measurement
    await inEnv(() => fl().store.setSetting('environmentRunsPerMinute', 100000, null))
    const t0 = Date.now()
    await inEnv(async () => { for (let i = 0; i < N; i++) await fl().runManual(admin, flow, { I: i }) })
    const tq = Date.now()
    app.services.kernel.start()
    for (;;) {
      const left = (await q(`SELECT count(*)::int AS n FROM env_default.ab_flow_runs WHERE flow_id = $1 AND state NOT IN ('succeeded', 'failed', 'cancelled', 'timedOut')`, [flow.id]))[0].n
      if (!left) break
      if (Date.now() - t0 > 900_000) throw new Error(`${left} runs left after 15 minutes`)
      await new Promise((res) => setTimeout(res, 250))
    }
    const t1 = Date.now()
    await app.services.kernel.stop(5000)
    const states = await q(`SELECT state, count(*)::int AS n FROM env_default.ab_flow_runs WHERE flow_id = $1 GROUP BY state`, [flow.id])
    expect(states).toEqual([{ state: 'succeeded', n: N }])
    // step latency: from the previous step's end (or the run's start) to this step's end, as the queue sees it
    const lat = (await q(`SELECT EXTRACT(EPOCH FROM s.finished_on - COALESCE(lag(s.finished_on) OVER (PARTITION BY s.run_id ORDER BY s.ord), r.started_on)) * 1000 AS ms
      FROM env_default.ab_flow_steps s JOIN env_default.ab_flow_runs r ON r.id = s.run_id WHERE r.flow_id = $1 AND s.finished_on IS NOT NULL`, [flow.id])).map((x) => Number(x.ms)).sort((a, b) => a - b)
    const p = (x: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * x))]
    const report = { runs: N, steps: lat.length, enqueueSeconds: (tq - t0) / 1000, runSeconds: (t1 - tq) / 1000, runsPerSecond: Math.round((N / ((t1 - tq) / 1000)) * 10) / 10, stepsPerSecond: Math.round(lat.length / ((t1 - tq) / 1000)), p50StepMs: Math.round(p(0.5)), p95StepMs: Math.round(p(0.95)) }
    process.stdout.write(`\nFLOW THROUGHPUT ${JSON.stringify(report)}\n`)
    expect(lat.length).toBe(N * 6)
  }, 1_200_000)
  it('exit check 1: the purchase approval flow over a simulated week, across two restarts', async () => {
    now = new Date('2030-03-04T09:00:00Z')
    app.services.flows.setClock({ now: () => now })
    const def = {
      name: 'Purchase approval', enabled: true,
      settings: { concurrency: 'perRecord', timeoutMinutes: 14 * 24 * 60, retentionDays: 90, onError: 'fail' },
      trigger: { type: 'table', table: 'PurchaseRequests', on: ['create'] },
      steps: [
        { id: 'mgr', name: 'Mgr', kind: 'approval', title: '"Purchase: " & Trigger.Record.Title', approvers: 'Trigger.Record.Manager', timeoutMinutes: 2 * 24 * 60, regarding: { table: 'PurchaseRequests', rowId: 'Trigger.Record' } },
        { id: 'esc', name: 'Esc', kind: 'scope', runAfter: [{ step: 'mgr', when: ['timedOut'] }], steps: [
          { id: 'escn', name: 'EscNotify', kind: 'notify', to: '"dev@example.com"', title: '"Escalated: " & Trigger.Record.Title', body: '"The manager did not answer in 2 days."', channels: ['inApp'] },
          { id: 'escs', name: 'EscStatus', kind: 'data.update', table: 'PurchaseRequests', rowId: 'Trigger.Record', values: { Status: '"Escalated"' } },
        ] },
        { id: 'decide', name: 'Decide', kind: 'condition', runAfter: [{ step: 'esc', when: ['succeeded', 'skipped'] }],
          if: 'Steps.Mgr.Status = "timedOut" || (Steps.Mgr.Output.Outcome = "Approve" && Trigger.Record.Amount > 10000)',
          then: [{ id: 'dir', name: 'Dir', kind: 'approval', title: '"Second approval: " & Trigger.Record.Title', approvers: '"dev@example.com"', timeoutMinutes: 3 * 24 * 60 }] },
        { id: 'final', name: 'Final', kind: 'compose', value: 'If(Steps.Decide.Output.Result, Steps.Dir.Output.Outcome, Steps.Mgr.Output.Outcome)' },
        { id: 'status', name: 'SetStatus', kind: 'data.update', table: 'PurchaseRequests', rowId: 'Trigger.Record', values: { Status: 'If(Steps.Final.Output = "Approve", "Approved", "Rejected")' } },
        { id: 'tell', name: 'Tell', kind: 'notify', to: 'Trigger.Record.Requester', title: '"Request " & Trigger.Record.Title & ": " & If(Steps.Final.Output = "Approve", "approved", "rejected")', body: '""', channels: ['inApp'] },
      ],
    }
    const r = await h.admin.post('/flows', def)
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    const flowId = r.data.flow.id
    const mk = (Title: string, Amount: number) => insert('PurchaseRequests', { Title, Amount, Requester: 'rae@example.com', Manager: 'mona@example.com', Status: 'New' })
    const r1 = String((await mk('Chairs', 5000)).id)
    const r2 = String((await mk('Server', 50000)).id)
    const r3 = String((await mk('Laptops', 20000)).id)
    const r4 = String((await mk('Coffee', 3000)).id)
    await drain()
    const ask = (rowId: string, who: string) => approvals.filter((a) => a.regarding?.rowId === rowId || (a.title.endsWith(titleOf.get(rowId)!) && a.approvers.includes(who))).filter((a) => a.approvers.includes(who))
    const titleOf = new Map([[r1, 'Chairs'], [r2, 'Server'], [r3, 'Laptops'], [r4, 'Coffee']])
    expect(approvals.filter((a) => a.flowId === flowId)).toHaveLength(4)
    const answer = async (rowId: string, who: string, outcome: string) => {
      const a = ask(rowId, who)
      expect(a, `${rowId} ${who}`).toHaveLength(1)
      expect(await fl().resumeWait('default', a[0].waitId, { kind: 'approval', outcome, responses: [{ userId: who, response: outcome, at: now.toISOString() }] })).toEqual({ resumed: true })
    }
    // day 0, two hours later: the manager answers three of them
    now = new Date(now.getTime() + 2 * 3600_000)
    await answer(r1, 'mona@example.com', 'Approve')
    await answer(r2, 'mona@example.com', 'Approve')
    await answer(r4, 'mona@example.com', 'Reject')
    // restart 1 before the resume jobs ran (they are in the queue)
    await restart()
    now = new Date(now.getTime() + 24 * 3600_000)
    await drain()
    // day 2, 10:00: the manager never answered Laptops: escalation
    now = new Date('2030-03-06T10:00:00Z')
    await drain()
    expect(ask(r2, 'dev@example.com')).toHaveLength(1)
    expect(ask(r3, 'dev@example.com')).toHaveLength(1)
    // day 3: the director approves the server
    now = new Date('2030-03-07T11:00:00Z')
    await answer(r2, 'dev@example.com', 'Approve')
    await drain()
    // restart 2
    await restart()
    // day 4: the director rejects the laptops
    now = new Date('2030-03-08T15:00:00Z')
    await answer(r3, 'dev@example.com', 'Reject')
    await drain()
    // the rest of the week passes
    now = new Date('2030-03-11T09:00:00Z')
    await drain()
    const runs = await q('SELECT id, state, regarding_id FROM env_default.ab_flow_runs WHERE flow_id = $1', [flowId])
    expect(runs).toHaveLength(4)
    expect(runs.every((x) => x.state === 'succeeded'), JSON.stringify(runs)).toBe(true)
    const status = Object.fromEntries((await q(`SELECT id, "Status" FROM env_default.t_purchaserequests`)).map((x) => [x.id, x.Status]))
    expect(status).toEqual({ [r1]: 'Approved', [r2]: 'Approved', [r3]: 'Rejected', [r4]: 'Rejected' })
    // exactly the approvals asked for: 4 manager, 2 director; one escalation; one message per request
    expect(approvals.filter((a) => a.flowId === flowId)).toHaveLength(6)
    expect((await q(`SELECT title FROM ab.notifications WHERE title LIKE 'Escalated:%'`)).map((x) => x.title)).toEqual(['Escalated: Laptops'])
    expect((await q(`SELECT title FROM ab.notifications WHERE title LIKE 'Request %' ORDER BY title`)).map((x) => x.title)).toEqual(['Request Chairs: approved', 'Request Coffee: rejected', 'Request Laptops: rejected', 'Request Server: approved'])
    // every data change once: Laptops went New -> Escalated -> Rejected, the others New -> final
    const changes = await q(`SELECT row_id, count(*)::int AS n FROM env_default.ab_outbox o JOIN env_default.ab_tables t ON t.id = o.table_id WHERE t.name = 'PurchaseRequests' AND o.op = 'update' GROUP BY row_id`)
    expect(Object.fromEntries(changes.map((x) => [x.row_id, x.n]))).toEqual({ [r1]: 1, [r2]: 1, [r3]: 2, [r4]: 1 })
    // the manager's step of Laptops timed out (no answer within 2 days); its steps ran once each
    const s3 = await q(`SELECT step_key, state, attempt FROM env_default.ab_flow_steps WHERE run_id = (SELECT id FROM env_default.ab_flow_runs WHERE regarding_id = $1) ORDER BY ord`, [r3])
    expect(s3.map((x) => `${x.step_key}=${x.state}`)).toEqual(['/mgr=timedOut', '/esc=succeeded', '/esc/escn=succeeded', '/esc/escs=succeeded', '/decide=succeeded', '/decide.then/dir=succeeded', '/final=succeeded', '/status=succeeded', '/tell=succeeded'])
  }, 300000)

})
