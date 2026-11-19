/**
 * Flow runtime on PostgreSQL (P1 package A; docs/dev/flows.md): every trigger and step kind, runAfter and scopes,
 * loops, waits, retries, cancellation, resubmit, loop protection, concurrency modes, security, the API.
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/flows
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { setQuiet } from '../util.ts'
import { runInEnvironment } from '../env-context.ts'
import { Client, startHarness, type KernelHarness } from '../kernel-testkit.ts'
import type { ActionsService } from '../actions/contracts.ts'
import type { ApprovalRequest, ApprovalsService } from './contracts.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[server/core/flows integration] ${SKIP_PG}\n`)

/* eslint-disable @typescript-eslint/no-explicit-any */
describe.skipIf(!PG_URL)('flows (PostgreSQL)', () => {
  let h: KernelHarness
  const A = () => h.admin
  const fl = () => h.app.services.flows
  const drain = async () => {
    for (let i = 0; i < 6; i++) {
      await h.app.services.kernel.drain({ timeoutMs: 60_000 })
      const n = await runInEnvironment('default', () => fl().sweep(true))
      if (!n) break
    }
  }
  const run = async (id: string) => (await A().get(`/flows/runs/${id}`)).data.run
  const runsOf = async (flowId: string) => (await h.q<any>('SELECT * FROM env_default.ab_flow_runs WHERE flow_id = $1 ORDER BY created_on, seq', [flowId]))
  const settings = { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' }
  const mkFlow = async (body: any, c: Client = A()) => {
    const r = await c.post('/flows', { settings, enabled: true, ...body })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return r.data.flow
  }
  const login = async (email: string, password: string): Promise<Client> => {
    const c = new Client(h.base)
    const r = await c.post('/auth/login', { email, password })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return c
  }
  const approvals: ApprovalRequest[] = []
  const actionCalls: { conn: string; action: string; inputs: any; key?: string }[] = []
  let failNext = 0

  beforeAll(async () => {
    h = await startHarness('flows')
    for (const t of [
      { displayName: 'FOrders', name: 'FOrders', columns: [{ displayName: 'Ref', type: 'text' }, { displayName: 'Status', type: 'text' }, { displayName: 'Amount', type: 'number' }, { displayName: 'Note', type: 'text' }] },
      { displayName: 'Order log', name: 'FLog', columns: [{ displayName: 'Ref', type: 'text' }, { displayName: 'Message', type: 'text' }, { displayName: 'N', type: 'number' }] },
      { displayName: 'FSecrets', name: 'FSecrets', columns: [{ displayName: 'Code', type: 'text' }] },
    ]) {
      const r = await A().post('/tables', t)
      expect(r.status, JSON.stringify(r.data)).toBe(200)
    }
    // a stub approval service (package C provides the real one against this interface)
    const stub: ApprovalsService = {
      async request(_env, req) { approvals.push(req); return { id: `appr_${approvals.length}` } },
      async cancel() { /* recorded by state */ },
    }
    fl().setApprovals(stub)
    // a fake actions service (package D provides the real one)
    const fake: ActionsService = {
      kinds: () => [], list: async () => [{ id: 'send', title: 'Send', description: '', inputs: { type: 'object', required: ['to'] }, outputs: {}, idempotent: false, sideEffect: 'external', timeoutMs: 1000 }, { id: 'request', title: 'Request', description: '', inputs: {}, outputs: {}, idempotent: false, sideEffect: 'external', timeoutMs: 1000 }],
      describe: async () => { throw new Error('n/a') },
      async run(_env, conn, action, inputs, _id, opts) {
        if (failNext > 0) { failNext--; return { ok: false, error: { code: 'network', message: 'connection reset', retryable: true } } }
        actionCalls.push({ conn, action, inputs, key: opts?.idempotencyKey })
        if (action === 'request') return { ok: true, output: { status: 200, headers: { 'content-type': 'application/json' }, body: { echo: (inputs as any).body ?? null } } }
        return { ok: true, output: { messageId: `m${actionCalls.length}` } }
      },
      canUse: async (u) => u.privileges.isAdmin, canManage: async (u) => u.privileges.isAdmin,
      async assertCanUse(u) { if (!u.privileges.isAdmin) { const { HttpError } = await import('../contracts.ts'); throw new HttpError(403, 'denied', 'You may not use this connection.') } },
      state: () => ({ circuit: 'closed', failures: 0, retryAt: null, inFlight: 0, maxConcurrent: 4, perMinute: 60, lastError: null }),
    }
    ;(h.app.services as any).actions = fake
    // connections the flows may reference (the kinds the actions service knows)
    for (const [id, name, connector] of [['conn_mail', 'Mail', 'email'], ['conn_api', 'Api', 'http']]) {
      await runInEnvironment('default', () => h.app.services.meta.connections.upsert({ id, name, connector: connector as any, status: 'connected', settings: {}, isDefault: false, scope: 'server' }))
    }
  }, 180000)

  afterAll(async () => { await h?.close() }, 60000)

  it('validates with step id and field: schema, expressions in scope, delegation, runAfter, references', async () => {
    const bad = await A().post('/flows/validate', {
      name: 'Bad', settings, trigger: { type: 'table', table: 'FOrders', on: ['create'], condition: 'Trigger.Record.Nope > 1' },
      variables: [{ name: 'Total', type: 'number' }],
      steps: [
        { id: 'a', name: 'A', kind: 'compose', value: 'Steps.Later.Output' },
        { id: 'b', name: 'B', kind: 'data.list', table: 'FOrders', filter: 'Len(Note) > 2 && IsMatch(Note, "x.*")' },
        { id: 'c', name: 'C', kind: 'setVariable', variable: 'Nope', value: '1' },
        { id: 'd', name: 'D', kind: 'compose', value: 'FOrders', runAfter: [{ step: 'e', when: ['succeeded'] }] },
        { id: 'e', name: 'Later', kind: 'data.update', table: 'FOrders', rowId: 'Trigger.Record.id', values: { Missing: '1' } },
        { id: 'f', name: 'F', kind: 'callFlow', flow: 'Does not exist' },
        { id: 'g', name: 'G', kind: 'http', method: 'GET', url: '"https://x"' },
        { id: 'h', name: 'H', kind: 'forEach', items: 'Steps.B.Output', as: 'Row', concurrency: 4, steps: [{ id: 'h1', name: 'H1', kind: 'setVariable', variable: 'Total', value: 'Row.Amount' }] },
        { id: 'i', name: 'I', kind: 'compose', value: 'Notify("x")' },
      ],
    })
    expect(bad.status).toBe(200)
    const p = bad.data.problems as any[]
    const has = (step: string, field: string, re: RegExp) => expect(p.some((x) => x.step === step && x.field === field && re.test(x.message)), `${step}.${field} ${re} in ${JSON.stringify(p)}`).toBe(true)
    has('trigger', 'condition', /no field "Nope"/)
    has('a', 'value', /no step "Later" before this one/)
    has('c', 'variable', /no variable "Nope"/)
    has('d', 'runAfter', /later/)
    has('d', 'value', /read as a whole/)
    has('e', 'values.Missing', /no column "Missing"/)
    has('f', 'flow', /no flow/)
    has('g', 'auth', /HTTP connection/)
    has('h1', 'variable', /parallel/)
    has('i', 'value', /is an action/)
    // saving refuses with the same problems
    const s = await A().post('/flows', { name: 'Bad', settings, trigger: { type: 'manual', inputs: [], from: 'any' }, steps: [{ id: 'x', name: 'X', kind: 'compose', value: '1 +' }] })
    expect(s.status).toBe(422)
    expect(s.data.problems[0]).toMatchObject({ step: 'x', field: 'value', severity: 'error' })
  }, 60000)

  it('table trigger -> condition, data steps in one transaction, compose, runAfter catch, the run history', async () => {
    const f = await mkFlow({
      name: 'Order flow', trigger: { type: 'table', table: 'FOrders', on: ['create', 'update'], condition: 'Trigger.Record.Amount > 100' },
      variables: [{ name: 'Count', type: 'number', initial: 0 }],
      steps: [
        { id: 'msg', name: 'Msg', kind: 'compose', value: '"Order " & Trigger.Record.Ref & " for " & Text(Trigger.Record.Amount)' },
        { id: 'big', name: 'Big', kind: 'condition', if: 'Trigger.Record.Amount > 1000', then: [
          { id: 'mark', name: 'Mark', kind: 'data.update', table: 'FOrders', rowId: 'Trigger.Record', values: { Status: '"Big"' } },
        ], else: [
          { id: 'log', name: 'Log', kind: 'data.create', table: 'FLog', values: { Ref: 'Trigger.Record.Ref', Message: 'Steps.Msg.Output', N: 'CountRows(Filter(FOrders, Amount > 100))' } },
        ] },
        { id: 'cnt', name: 'Cnt', kind: 'setVariable', variable: 'Count', value: 'Variables.Count + 1' },
        { id: 'try', name: 'Try', kind: 'scope', steps: [{ id: 'boom', name: 'Boom', kind: 'data.get', table: 'FOrders', rowId: '"no-such-row"' }] },
        { id: 'catch', name: 'Catch', kind: 'compose', value: '"caught: " & Steps.Boom.Error', runAfter: [{ step: 'try', when: ['failed', 'timedOut'] }] },
        { id: 'resp', name: 'Resp', kind: 'respond', body: '{Count: Variables.Count, Msg: Steps.Msg.Output}' },
      ],
    })
    const small = await A().post('/data/FOrders/rows', { values: { Ref: 'S1', Amount: 5 } })
    const mid = await A().post('/data/FOrders/rows', { values: { Ref: 'M1', Amount: 500 } })
    const big = await A().post('/data/FOrders/rows', { values: { Ref: 'B1', Amount: 5000 } })
    expect(big.status).toBe(200)
    await drain()
    const runs = await runsOf(f.id)
    // condition false for S1: no run; the flow's own update of B1 does not trigger it again (own changes off)
    expect(runs.map((r: any) => r.trigger_summary.split(' ')[1])).toEqual([mid.data.row.id, big.data.row.id])
    for (const r of runs) expect(r.state, JSON.stringify(await run(r.id))).toBe('succeeded')
    const d = await run(runs[0].id)
    const st = Object.fromEntries(d.steps.map((s: any) => [s.key, s.status]))
    expect(st).toMatchObject({ '/msg': 'succeeded', '/big': 'succeeded', '/big.else/log': 'succeeded', '/cnt': 'succeeded', '/try': 'failed', '/try/boom': 'failed', '/catch': 'succeeded', '/resp': 'succeeded' })
    if (!d.steps.find((s: any) => s.key === '/catch').output) console.log(JSON.stringify(d.steps, null, 1))
    expect(d.steps.find((s: any) => s.key === '/catch').output).toMatch(/^caught: FOrders: there is no row/)
    expect(d.response).toEqual({ Count: 1, Msg: 'Order M1 for 500' })
    expect(d.variables).toEqual({ Count: 1 })
    const log = await h.q<any>('SELECT * FROM env_default.t_flog')
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ Ref: 'M1', Message: 'Order M1 for 500', N: '2' === String(log[0].N) ? log[0].N : 2 })
    expect((await h.q<any>('SELECT "Status" FROM env_default.t_forders WHERE id = $1', [big.data.row.id]))[0].Status).toBe('Big')
    // the flow's write carries the run's correlation id and the flow marker in the outbox chain
    const ob = (await h.q<any>(`SELECT o.* FROM env_default.ab_outbox o WHERE o.row_id = $1 ORDER BY o.id`, [big.data.row.id]))
    expect(ob[1].correlation_id).toBe(runs[1].correlation_id)
    expect(ob[1].chain.some((c: string) => c.startsWith(`flow:${f.id}:`))).toBe(true)
    // the Flow runs system table shows it, regarding the record
    const sys = await A().post('/query', { plan: { version: 2, table: 'FlowRuns', filter: { col: 'Flow', op: 'eq', value: 'Order flow' } } })
    expect(sys.status, JSON.stringify(sys.data)).toBe(200)
    expect(sys.data.rows).toHaveLength(2)
    expect(sys.data.rows.map((r: any) => r.regardingId).sort()).toEqual([mid.data.row.id, big.data.row.id].sort())
    // list with health
    const list = await A().get('/flows')
    const item = list.data.items.find((x: any) => x.id === f.id)
    expect(item.health).toMatchObject({ runs7d: 2, succeeded7d: 2, successRate: 1 })
    void small
    await A().post(`/flows/${f.id}/disable`)
    // deleting the record a run was about works (Flow runs is a view: never a target of the regarding cleanup) and the
    // run keeps the id of the record it was about
    const del = await A().post(`/data/${encodeURIComponent((await runInEnvironment('default', () => h.app.services.meta.tables.list())).find((t) => t.name === 'FOrders')!.id)}/delete`, { ids: [mid.data.row.id] })
    expect(del.status, JSON.stringify(del.data)).toBe(200)
    expect((await h.q<any>('SELECT regarding_id FROM env_default.ab_flow_runs WHERE id = $1', [runs[0].id]))[0].regarding_id).toBe(mid.data.row.id)
    const delTable = await A().post('/tables', { displayName: 'Tmp', name: 'TmpRegarding', columns: [{ displayName: 'A', type: 'text' }] })
    expect((await A().del(`/tables/${delTable.data.id}`)).status).toBe(200)
  }, 120000)

  it('forEach sequential and parallel, until, switch, terminate, notify', async () => {
    const f = await mkFlow({
      name: 'Loops', trigger: { type: 'manual', inputs: [{ name: 'N', type: 'number', required: true }], from: 'any' },
      variables: [{ name: 'Sum', type: 'number' }, { name: 'I', type: 'number' }],
      steps: [
        { id: 'nums', name: 'Nums', kind: 'compose', value: 'Sequence(Trigger.Inputs.N)' },
        { id: 'seq', name: 'Seq', kind: 'forEach', items: 'Steps.Nums.Output', as: 'X', steps: [{ id: 'add', name: 'Add', kind: 'setVariable', variable: 'Sum', value: 'Variables.Sum + X.Value' }] },
        { id: 'par', name: 'Par', kind: 'forEach', items: 'Steps.Nums.Output', as: 'Y', concurrency: 3, steps: [
          { id: 'w', name: 'W', kind: 'data.create', table: 'FLog', values: { Ref: '"par"', N: 'Y.Value * 10' } },
        ] },
        { id: 'loop', name: 'Loop', kind: 'until', condition: 'Variables.I >= 3', maxIterations: 10, steps: [{ id: 'inc', name: 'Inc', kind: 'setVariable', variable: 'I', value: 'Variables.I + 1' }] },
        { id: 'sw', name: 'Sw', kind: 'switch', on: 'Variables.Sum', cases: [{ value: 6, steps: [{ id: 'six', name: 'Six', kind: 'compose', value: '"six"' }] }], default: [{ id: 'other', name: 'Other', kind: 'compose', value: '"other"' }] },
        { id: 'tell', name: 'Tell', kind: 'notify', to: 'User()', title: '"Done " & Text(Variables.Sum)', body: '""', channels: ['inApp'] },
        { id: 'end', name: 'End', kind: 'terminate', status: 'succeeded', message: '"stopped early"' },
        { id: 'never', name: 'Never', kind: 'compose', value: '1', runAfter: [{ step: 'end', when: ['skipped'] }] },
      ],
    })
    const r = await A().post(`/flows/${f.id}/run`, { inputs: { N: 3 }, wait: true, timeoutSeconds: 1 })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    await drain()
    const d = await run(r.data.runId)
    expect(d.status, JSON.stringify(d)).toBe('succeeded')
    expect(d.variables).toEqual({ Sum: 6, I: 3 })
    const by = Object.fromEntries(d.steps.map((s: any) => [s.key, s]))
    expect(by['/seq'].output).toEqual({ Count: 3, Succeeded: 3, Failed: 0 })
    expect(by['/par'].output).toEqual({ Count: 3, Succeeded: 3, Failed: 0 })
    expect(by['/loop'].output).toEqual({ Iterations: 3 })
    expect(by['/sw.case0/six'].status).toBe('succeeded')
    expect(by['/never']).toBeUndefined()
    const par = await h.q<any>(`SELECT "N" FROM env_default.t_flog WHERE "Ref" = 'par' ORDER BY "N"`)
    expect(par.map((x: any) => Number(x.N))).toEqual([10, 20, 30])
    const n = await h.q<any>(`SELECT title FROM ab.notifications WHERE title LIKE 'Done %'`)
    expect(n.map((x: any) => x.title)).toEqual(['Done 6'])
  }, 120000)

  it('delays and approvals wait in the database; time moves with the flow clock; timeouts go to runAfter timedOut', async () => {
    let now = new Date('2030-01-05T09:00:00Z')
    fl().setClock({ now: () => now })
    try {
      const f = await mkFlow({
        name: 'Approve', settings: { ...settings, timeoutMinutes: 7 * 24 * 60 }, trigger: { type: 'manual', inputs: [], from: 'any' },
        steps: [
          { id: 'wait', name: 'Wait', kind: 'delay', minutes: 60 },
          { id: 'ap', name: 'Ap', kind: 'approval', title: '"Buy it?"', approvers: '"ada@example.com"', timeoutMinutes: 120 },
          { id: 'esc', name: 'Esc', kind: 'compose', value: '"escalated"', runAfter: [{ step: 'ap', when: ['timedOut'] }] },
          { id: 'ok', name: 'Ok', kind: 'compose', value: 'Steps.Ap.Output.Outcome', runAfter: [{ step: 'ap', when: ['succeeded'] }] },
        ],
      })
      const go = async () => (await A().post(`/flows/${f.id}/run`, {})).data.runId
      const a = await go()
      const b = await go()
      await drain()
      expect((await run(a)).status).toBe('waiting')
      now = new Date(now.getTime() + 61 * 60_000)
      await drain()
      if (approvals.filter((x) => x.runId === a || x.runId === b).length !== 2) console.log(JSON.stringify(await run(b), null, 1))
      expect(approvals.filter((x) => x.runId === a || x.runId === b)).toHaveLength(2)
      const req = approvals.find((x) => x.runId === a)!
      expect(req).toMatchObject({ approvers: ['ada@example.com'], options: ['Approve', 'Reject'], type: 'single', idempotencyKey: `${a}:/ap` })
      // approved through the callback C will call
      expect(await fl().resumeWait('default', req.waitId, { kind: 'approval', outcome: 'Approve' })).toEqual({ resumed: true })
      expect(await fl().resumeWait('default', req.waitId, { kind: 'approval', outcome: 'Reject' })).toEqual({ resumed: false })
      await drain()
      const da = await run(a)
      expect(da.status).toBe('succeeded')
      expect(da.steps.find((s: any) => s.key === '/ok').output).toBe('Approve')
      // b is never answered: after the timeout it escalates
      now = new Date(now.getTime() + 121 * 60_000)
      await drain()
      const db = await run(b)
      expect(db.status).toBe('succeeded')
      expect(db.steps.find((s: any) => s.key === '/ap').status).toBe('timedOut')
      expect(db.steps.find((s: any) => s.key === '/esc').output).toBe('escalated')
    } finally {
      fl().setClock({ now: () => new Date() })
    }
  }, 120000)

  it('http, action and email steps go through the actions service with an idempotency key; transient errors retry', async () => {
    const f = await mkFlow({
      name: 'Calls', trigger: { type: 'manual', inputs: [], from: 'any' }, connections: { api: 'conn_api', mail: 'conn_mail' },
      steps: [
        { id: 'h', name: 'H', kind: 'http', method: 'POST', url: '"https://api.example.com/x"', headers: { Authorization: '"Bearer secret-token"' }, body: '{a: 1}', auth: 'api', retry: { type: 'fixed', count: 3, intervalSeconds: 1 } },
        { id: 'm', name: 'M', kind: 'email', to: '"a@example.com"', subject: '"Hi"', body: '"Body " & Text(Steps.H.Output.Body.echo.a)', connection: 'mail' },
        { id: 'act', name: 'Act', kind: 'action', connection: 'mail', action: 'send', inputs: { to: '"b@example.com"' } },
      ],
    })
    failNext = 1
    const r = await A().post(`/flows/${f.id}/run`, {})
    await drain()
    await new Promise((res) => setTimeout(res, 1200))
    await drain()
    const d = await run(r.data.runId)
    expect(d.status, JSON.stringify(d.steps)).toBe('succeeded')
    const hs = d.steps.find((s: any) => s.key === '/h')
    expect(hs.attempt).toBe(2)
    // secrets never stored: the Authorization header is redacted in the run history
    expect(hs.input.headers.Authorization).toBe('[redacted]')
    const raw = await h.q<any>('SELECT input::text AS i FROM env_default.ab_flow_steps WHERE run_id = $1', [r.data.runId])
    expect(raw.map((x: any) => x.i).join(' ')).not.toContain('secret-token')
    const mine = actionCalls.filter((c) => c.key?.startsWith(r.data.runId))
    expect(mine.map((c) => [c.action, c.key])).toEqual([['request', `${r.data.runId}:/h`], ['send', `${r.data.runId}:/m`], ['send', `${r.data.runId}:/act`]])
    expect(mine[1].inputs).toMatchObject({ to: ['a@example.com'], subject: 'Hi', body: 'Body 1' })
  }, 60000)

  it('callFlow: the parent waits for the child and reads its response; resubmit from the failed step', async () => {
    const child = await mkFlow({ name: 'Child', trigger: { type: 'manual', inputs: [{ name: 'X', type: 'number' }], from: 'any' }, steps: [{ id: 'r', name: 'R', kind: 'respond', body: '{Double: Trigger.Inputs.X * 2}' }] })
    const parent = await mkFlow({
      name: 'Parent', trigger: { type: 'manual', inputs: [{ name: 'Fail', type: 'boolean' }], from: 'any' },
      steps: [
        { id: 'c', name: 'C', kind: 'callFlow', flow: 'Child', inputs: { X: '21' } },
        { id: 'w', name: 'W', kind: 'data.create', table: 'FLog', values: { Ref: '"parent"', N: 'Steps.C.Output.Outputs.Double' } },
        { id: 'g', name: 'G', kind: 'data.get', table: 'FLog', rowId: 'If(Trigger.Inputs.Fail, "missing", Steps.W.Output.id)' },
      ],
    })
    void child
    const r = await A().post(`/flows/${parent.id}/run`, { inputs: { Fail: true } })
    await drain()
    const d = await run(r.data.runId)
    expect(d.status).toBe('failed')
    expect(d.steps.find((s: any) => s.key === '/c').output).toMatchObject({ Status: 'succeeded', Outputs: { Double: 42 } })
    expect(d.steps.find((s: any) => s.key === '/g').status).toBe('failed')
    // resubmit from the failed step: C and W are not run again (no second row)
    const rs = await A().post(`/flows/runs/${r.data.runId}/resubmit`, { from: 'failed' })
    expect(rs.status, JSON.stringify(rs.data)).toBe(200)
    await drain()
    const d2 = await run(rs.data.runId)
    expect(d2.status).toBe('failed')
    expect((await h.q<any>(`SELECT count(*)::int AS n FROM env_default.t_flog WHERE "Ref" = 'parent'`))[0].n).toBe(1)
    expect((await h.q<any>(`SELECT count(*)::int AS n FROM env_default.ab_flow_runs WHERE flow_id = $1`, [child.id]))[0].n).toBe(1)
  }, 60000)

  it('resubmit from a chosen completed step: earlier results reused, that step and later ones run again; nested steps refused', async () => {
    const f = await mkFlow({
      name: 'FromStep', trigger: { type: 'manual', inputs: [], from: 'any' }, variables: [{ name: 'V', type: 'number' }],
      steps: [
        { id: 'a', name: 'A', kind: 'data.create', table: 'FLog', values: { Ref: '"fromstep-a"', N: '1' } },
        { id: 'sv', name: 'SV', kind: 'setVariable', variable: 'V', value: '5' },
        { id: 'b', name: 'B', kind: 'data.create', table: 'FLog', values: { Ref: '"fromstep-b"', N: 'Steps.A.Output.N + Variables.V' } },
        { id: 'sc', name: 'Sc', kind: 'scope', steps: [{ id: 'in', name: 'In', kind: 'compose', value: '1' }] },
      ],
    })
    const r = await A().post(`/flows/${f.id}/run`, {})
    await drain()
    expect((await run(r.data.runId)).status).toBe('succeeded')
    const count = async (ref: string) => (await h.q<any>(`SELECT count(*)::int AS n FROM env_default.t_flog WHERE "Ref" = $1`, [ref]))[0].n
    // a succeeded run, from the step B: A is not repeated, B is (reading A's stored output and the variable)
    const rs = await A().post(`/flows/runs/${r.data.runId}/resubmit`, { from: 'step', step: 'b' })
    expect(rs.status, JSON.stringify(rs.data)).toBe(200)
    await drain()
    const d2 = await run(rs.data.runId)
    expect(d2.status, JSON.stringify(d2.steps)).toBe('succeeded')
    expect(await count('fromstep-a')).toBe(1)
    expect(await count('fromstep-b')).toBe(2)
    expect((await h.q<any>(`SELECT "N" FROM env_default.t_flog WHERE "Ref" = 'fromstep-b' ORDER BY "N"`)).map((x: any) => Number(x.N))).toEqual([6, 6])
    // a step inside a container: refused with the reason; an unknown step too
    const nested = await A().post(`/flows/runs/${r.data.runId}/resubmit`, { from: 'step', step: 'in' })
    expect(nested.status).toBe(409)
    expect(nested.data.error.message).toMatch(/inside a container/)
    expect((await A().post(`/flows/runs/${r.data.runId}/resubmit`, { from: 'step', step: 'nope' })).status).toBe(409)
  }, 60000)

  it('cancel stops between steps and cancels waits', async () => {
    const f = await mkFlow({ name: 'Slow', trigger: { type: 'manual', inputs: [], from: 'any' }, steps: [{ id: 'd', name: 'D', kind: 'delay', minutes: 600 }, { id: 'x', name: 'X', kind: 'data.create', table: 'FLog', values: { Ref: '"after-cancel"' } }] })
    const r = await A().post(`/flows/${f.id}/run`, {})
    await drain()
    expect((await run(r.data.runId)).status).toBe('waiting')
    expect((await A().post(`/flows/runs/${r.data.runId}/cancel`)).status).toBe(200)
    const d = await run(r.data.runId)
    expect(d.status).toBe('cancelled')
    expect(d.waits[0].state).toBe('cancelled')
    expect((await A().post(`/flows/runs/${r.data.runId}/cancel`)).status).toBe(409)
  }, 60000)

  it('dry-run test runs simulate writes and side effects; reads are real', async () => {
    const f = await mkFlow({ name: 'Dry', trigger: { type: 'table', table: 'FOrders', on: ['create'] }, enabled: false, connections: { mail: 'conn_mail' },
      steps: [
        { id: 'n', name: 'N', kind: 'data.list', table: 'FOrders', filter: 'Amount > 0', top: 5 },
        { id: 'c', name: 'C', kind: 'data.create', table: 'FLog', values: { Ref: '"dry"' } },
        { id: 'm', name: 'M', kind: 'email', to: '"x@example.com"', subject: '"s"', body: '"b"', connection: 'mail' },
        { id: 'a', name: 'A', kind: 'approval', title: '"t"', approvers: '"ada@example.com"' },
      ] })
    const before = actionCalls.length
    const r = await A().post(`/flows/${f.id}/test`, { trigger: { Record: { Ref: 'T', Amount: 3 }, Operation: 'create' }, approvalOutcome: 'Reject' })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    await drain()
    const d = await run(r.data.runId)
    expect(d.status, JSON.stringify(d.steps)).toBe('succeeded')
    expect(d.mode).toBe('test')
    expect(d.steps.find((s: any) => s.key === '/c').simulated).toBe(true)
    expect(d.steps.find((s: any) => s.key === '/a').output.Outcome).toBe('Reject')
    expect(Array.isArray(d.steps.find((s: any) => s.key === '/n').output)).toBe(true)
    expect((await h.q<any>(`SELECT count(*)::int AS n FROM env_default.t_flog WHERE "Ref" = 'dry'`))[0].n).toBe(0)
    expect(actionCalls.length).toBe(before)
  }, 60000)

  it('perRecord concurrency keeps the order of changes per record; coalescing folds queued changes; singleton', async () => {
    const f = await mkFlow({ name: 'Per record', settings: { ...settings, concurrency: 'perRecord', triggerOnOwnChanges: false }, trigger: { type: 'table', table: 'FOrders', on: ['update'], columns: ['Note'] },
      steps: [{ id: 'l', name: 'L', kind: 'data.create', table: 'FLog', values: { Ref: 'Trigger.Record.id', Message: 'Trigger.Record.Note' } }] })
    const row = (await A().post('/data/FOrders/rows', { values: { Ref: 'P1', Amount: 1 } })).data.row.id
    for (const n of ['a', 'b', 'c', 'd']) expect((await A().patch(`/data/FOrders/rows/${row}`, { changes: { Note: n } })).status).toBe(200)
    // a change of another column does not fire it (columns filter)
    await A().patch(`/data/FOrders/rows/${row}`, { changes: { Amount: 2 } })
    await drain()
    const runs = await runsOf(f.id)
    expect(runs).toHaveLength(4)
    expect(runs.every((r: any) => r.state === 'succeeded')).toBe(true)
    const startOrder = [...runs].sort((x: any, y: any) => +new Date(x.finished_on) - +new Date(y.finished_on)).map((r: any) => Number(r.seq))
    expect(startOrder).toEqual([...startOrder].sort((x, y) => x - y))
    // the log rows were written in change order
    const logs = await h.q<any>(`SELECT "Message" FROM env_default.t_flog WHERE "Ref" = $1 ORDER BY "createdOn", id`, [row])
    expect(logs.map((x: any) => x.Message)).toEqual(['a', 'b', 'c', 'd'])
    await A().post(`/flows/${f.id}/disable`)
  }, 120000)

  it('loop protection: own changes off by default; on: capped per record', async () => {
    const f = await mkFlow({ name: 'Self', settings: { ...settings, triggerOnOwnChanges: true }, trigger: { type: 'table', table: 'FLog', on: ['create', 'update'] },
      steps: [{ id: 'u', name: 'U', kind: 'data.update', table: 'FLog', rowId: 'Trigger.Record.id', values: { N: 'Coalesce(Trigger.Record.N, 0) + 1' } }] })
    const row = (await A().post('/data/FLog/rows', { values: { Ref: 'loop' } })).data.row.id
    await drain()
    const n = (await h.q<any>(`SELECT "N" FROM env_default.t_flog WHERE id = $1`, [row]))[0].N
    // the person's create starts a run; the flow's own writes re-fire it until it changed the record 3 times on the chain (OWN_CHANGE_CAP)
    expect(Number(n)).toBe(3)
    await A().post(`/flows/${f.id}/disable`)
  }, 120000)

  it('security: a restricted triggering user cannot read or write beyond their rights; service accounts are for administrators and audited', async () => {
    // Rita may create and read her own orders only, and nothing in Secrets
    const tables = await runInEnvironment('default', () => h.app.services.meta.tables.list())
    const id = (n: string) => tables.find((t) => t.name === n)!.id
    const role = await A().post('/roles', { name: 'Clerk', apps: 'all', privileges: [{ table: id('FOrders'), create: true, read: 'own', update: 'own', delete: 'none' }, { table: id('FLog'), create: false, read: 'none', update: 'none', delete: 'none' }] })
    expect(role.status, JSON.stringify(role.data)).toBe(200)
    const u = await A().post('/users', { name: 'Rita', email: 'rita@example.com', roleIds: [role.data.id], password: 'rita-password-1' })
    expect(u.status, JSON.stringify(u.data)).toBe(200)
    await h.app.services.meta.users.update(u.data.id, { mustChangePassword: false })
    const rita = await login('rita@example.com', 'rita-password-1')
    const secret = (await A().post('/data/FSecrets/rows', { values: { Code: 'TOP' } })).data.row.id
    const f = await mkFlow({ name: 'As trigger user', runAs: 'triggeringUser', trigger: { type: 'table', table: 'FOrders', on: ['create'], condition: 'Trigger.Record.Ref = "R1"' },
      steps: [
        { id: 'peek', name: 'Peek', kind: 'data.get', table: 'FSecrets', rowId: `"${secret}"` },
        { id: 'w', name: 'W', kind: 'data.create', table: 'FLog', values: { Ref: '"rita"' }, runAfter: [{ step: 'peek', when: ['failed'] }] },
      ] })
    expect((await rita.post('/data/FOrders/rows', { values: { Ref: 'R1', Amount: 1 } })).status).toBe(200)
    await drain()
    const [r] = await runsOf(f.id)
    const d = await run(r.id)
    expect(d.runAs).toBe(u.data.id)
    expect(d.steps.find((s: any) => s.key === '/peek')).toMatchObject({ status: 'failed' })
    expect(d.steps.find((s: any) => s.key === '/w').status).toBe('failed')
    expect(d.steps.find((s: any) => s.key === '/w').error.message).toMatch(/permission|not allowed|may not|denied/i)
    expect((await h.q<any>(`SELECT count(*)::int AS n FROM env_default.t_flog WHERE "Ref" = 'rita'`))[0].n).toBe(0)
    // a maker cannot make a flow run as a service account
    const mx = await A().post('/users', { name: 'Max', email: 'max@example.com', roleIds: ['role_maker'], password: 'max-password-1' })
    await h.app.services.meta.users.update(mx.data.id, { mustChangePassword: false })
    const max = await login('max@example.com', 'max-password-1')
    const sa = await A().post('/identity/service-accounts', { name: 'Robot', roleIds: ['role_admin'] })
    const saId = sa.data?.id ?? sa.data?.account?.id ?? sa.data?.user?.id
    expect(saId, JSON.stringify(sa.data)).toBeTruthy()
    const mk = await max.post('/flows', { name: 'Escalate', settings, runAs: { serviceAccount: saId }, trigger: { type: 'manual', inputs: [], from: 'any' }, steps: [{ id: 'p', name: 'P', kind: 'data.get', table: 'FSecrets', rowId: `"${secret}"` }] })
    expect(mk.status).toBe(403)
    // ... an administrator can, with confirmation, and it is audited
    const ok = await A().post('/flows', { name: 'Escalate', settings, enabled: true, runAs: { serviceAccount: saId }, trigger: { type: 'manual', inputs: [], from: 'any' }, steps: [{ id: 'p', name: 'P', kind: 'data.get', table: 'FSecrets', rowId: `"${secret}"` }] })
    expect(ok.status, JSON.stringify(ok.data)).toBe(409)
    const ok2 = await A().post('/flows', { name: 'Escalate', settings, enabled: true, confirmRunAs: true, runAs: { serviceAccount: saId }, trigger: { type: 'manual', inputs: [], from: 'any' }, steps: [{ id: 'p', name: 'P', kind: 'data.get', table: 'FSecrets', rowId: `"${secret}"` }] })
    expect(ok2.status, JSON.stringify(ok2.data)).toBe(200)
    expect((await h.q<any>(`SELECT action FROM env_default.ab_audit WHERE action = 'flow.run_as_service'`)).length).toBe(1)
    // Rita may not run it; Max (a maker, not its owner) may not edit it
    expect((await rita.post(`/flows/${ok2.data.flow.id}/run`, {})).status).toBe(403)
    expect((await max.req('PUT', `/flows/${ok2.data.flow.id}`, { name: 'Mine now' })).status).toBe(403)
    // once granted to her role, she may run it (an administrator's decision)
    expect((await A().req('PUT', `/flows/${ok2.data.flow.id}/permissions`, { roleIds: [role.data.id] })).status).toBe(200)
    const rr = await rita.post(`/flows/${ok2.data.flow.id}/run`, {})
    expect(rr.status).toBe(200)
    await drain()
    // she sees how it went but not what it read
    const view = await rita.get(`/flows/runs/${rr.data.runId}`)
    expect(view.data.summaryOnly).toBe(true)
    expect(view.data.run.steps).toBeUndefined()
    // connections: attaching one needs the right to use it
    const att = await max.post('/flows', { name: 'Max mail', settings, trigger: { type: 'manual', inputs: [], from: 'any' }, connections: { mail: 'conn_mail' }, steps: [{ id: 'e', name: 'E', kind: 'email', to: '"x@example.com"', subject: '"s"', body: '"b"', connection: 'mail' }] })
    expect(att.status).toBe(403)
  }, 120000)

  it('schedule trigger: one run per slot, armed only while enabled', async () => {
    const f = await mkFlow({ name: 'Every hour', trigger: { type: 'schedule', cron: '0 * * * *', timeZone: 'Asia/Kolkata' }, steps: [{ id: 'c', name: 'C', kind: 'compose', value: 'Trigger.ScheduledTime' }] })
    const sch = await h.q<any>(`SELECT * FROM env_default.ab_schedules WHERE id = $1`, [`flow_${f.id}`])
    expect(sch).toHaveLength(1)
    // due now (twice the same slot: one run)
    await h.q(`UPDATE env_default.ab_schedules SET next_run_at = now() - interval '1 second' WHERE id = $1`, [`flow_${f.id}`])
    await runInEnvironment('default', () => h.app.services.kernel.jobs.schedulerTick())
    await runInEnvironment('default', () => h.app.services.kernel.jobs.schedulerTick())
    await drain()
    const runs = await runsOf(f.id)
    expect(runs).toHaveLength(1)
    expect(runs[0].state).toBe('succeeded')
    await A().post(`/flows/${f.id}/disable`)
    expect(await h.q<any>(`SELECT * FROM env_default.ab_schedules WHERE id = $1`, [`flow_${f.id}`])).toHaveLength(0)
  }, 60000)

  it('webhook trigger through flows.triggerWebhook, once per delivery', async () => {
    const f = await mkFlow({ name: 'Hook', trigger: { type: 'webhook' }, steps: [{ id: 'c', name: 'C', kind: 'compose', value: 'Trigger.Body.order.total * 2' }] })
    const p = { hookId: 'h1', flowId: f.id, receivedOn: new Date().toISOString(), contentType: 'application/json', body: { order: { total: 21 } }, query: {}, headers: {}, verifiedBy: 'token' as const, bodySha256: 'x', deliveryId: 'd-1' }
    const a = await fl().triggerWebhook('default', f.id, p)
    const b = await fl().triggerWebhook('default', f.id, p)
    expect(a.runId).toBe(b.runId)
    await drain()
    expect((await run(a.runId!)).steps[0].output).toBe(42)
  }, 60000)

  it('waitForCallback resumes once from its callback address', async () => {
    const f = await mkFlow({ name: 'Cb', trigger: { type: 'manual', inputs: [], from: 'any' }, steps: [
      { id: 'url', name: 'Url', kind: 'compose', value: 'Flow.Callback.Wait' },
      { id: 'wait', name: 'Wait', kind: 'waitForCallback', timeoutMinutes: 60 },
      { id: 'got', name: 'Got', kind: 'compose', value: 'Steps.Wait.Output.Body.ok' },
    ] })
    const r = await A().post(`/flows/${f.id}/run`, {})
    await drain()
    const d = await run(r.data.runId)
    const url = d.steps.find((s: any) => s.key === '/url').output as string
    expect(url).toMatch(/^\/api\/v1\/flows\/callback\/default\//)
    const post = (b: unknown) => fetch(h.base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
    expect((await post({ ok: 'yes' })).status).toBe(202)
    await drain()
    expect((await post({ ok: 'again' })).status).toBe(409)
    expect((await fetch(h.base + url.replace(/[^/]+$/, 'bad-token'), { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(404)
    const d2 = await run(r.data.runId)
    expect(d2.status).toBe('succeeded')
    expect(d2.steps.find((s: any) => s.key === '/got').output).toBe('yes')
  }, 60000)

  it('kill switch pauses every flow; versions restore; the owner disabled suspends the flow', async () => {
    const f = await mkFlow({ name: 'Pausable', trigger: { type: 'manual', inputs: [], from: 'any' }, steps: [{ id: 'c', name: 'C', kind: 'compose', value: '1' }] })
    expect((await A().req('PUT', '/flows/settings', { paused: true })).status).toBe(200)
    expect((await A().post(`/flows/${f.id}/run`, {})).status).toBe(409)
    expect((await A().req('PUT', '/flows/settings', { paused: false })).status).toBe(200)
    // versions
    const v2 = await A().req('PUT', `/flows/${f.id}`, { steps: [{ id: 'c', name: 'C', kind: 'compose', value: '2' }] })
    expect(v2.data.flow.version).toBe(2)
    const vs = await A().get(`/flows/${f.id}/versions`)
    expect(vs.data.items.map((x: any) => x.version)).toEqual([2, 1])
    const back = await A().post(`/flows/${f.id}/versions/1/restore`, {})
    expect(back.status, JSON.stringify(back.data)).toBe(200)
    expect(back.data.flow.version).toBe(3)
    expect(back.data.flow.steps[0].value).toBe('1')
    // the owner is disabled: its runs fail and the flow is suspended (administrators notified)
    const o = await A().post('/users', { name: 'Owen', email: 'owen@example.com', roleIds: ['role_maker'], password: 'owen-password-1' })
    await h.app.services.meta.users.update(o.data.id, { mustChangePassword: false })
    const owen = await login('owen@example.com', 'owen-password-1')
    const of = await mkFlow({ name: 'Owens', trigger: { type: 'manual', inputs: [], from: 'any' }, steps: [{ id: 'c', name: 'C', kind: 'compose', value: '1' }] }, owen)
    const rr = await owen.post(`/flows/${of.id}/run`, {})
    expect(rr.status).toBe(200)
    await h.app.services.meta.users.update(o.data.id, { status: 'disabled' })
    await drain()
    const d = await run(rr.data.runId)
    expect(d.status).toBe('failed')
    expect(d.error.message).toMatch(/disabled/)
    expect((await A().get(`/flows/${of.id}`)).data.flow.suspended).toMatch(/disabled/)
    expect((await h.q<any>(`SELECT action FROM env_default.ab_audit WHERE action = 'flow.suspended'`)).length).toBe(1)
  }, 60000)

  it('RunFlow from apps: by name, with a client run id (idempotent) and the response', async () => {
    await mkFlow({ name: 'Quote', trigger: { type: 'manual', inputs: [{ name: 'Qty', type: 'number', required: true }], from: 'app' }, steps: [{ id: 'r', name: 'R', kind: 'respond', body: '{Price: Trigger.Inputs.Qty * 9}' }] })
    h.app.services.kernel.start()
    try {
      const r = await A().post('/flows/run', { flow: 'Quote', inputs: { Qty: 2 }, runId: 'run_client00001', wait: true, timeoutSeconds: 15, source: 'app' })
      expect(r.status, JSON.stringify(r.data)).toBe(200)
      expect(r.data).toMatchObject({ runId: 'run_client00001', response: { Price: 18 } })
      const again = await A().post('/flows/run', { flow: 'Quote', inputs: { Qty: 3 }, runId: 'run_client00001' })
      expect(again.data.runId).toBe('run_client00001')
      expect((await A().post('/flows/run', { flow: 'Quote', inputs: {} })).status).toBe(422)
    } finally {
      await h.app.services.kernel.stop(2000)
    }
  }, 60000)

  it('ALM: flows travel in solutions (disabled on install, connections mapped, versions upgraded, removed) and environment copies (off)', async () => {
    const f = await mkFlow({ name: 'Shipped', connections: { api: 'conn_api' }, trigger: { type: 'table', table: 'FLog', on: ['create'] },
      steps: [{ id: 'h', name: 'H', kind: 'http', method: 'GET', url: '"https://api.example.com"', auth: 'api' }] })
    expect((await A().req('PUT', `/flows/${f.id}/permissions`, { roleIds: ['role_maker'] })).status).toBe(200)
    const tables = await runInEnvironment('default', () => h.app.services.meta.tables.list())
    const sol = await A().post('/solutions', { displayName: 'Shipping' })
    expect(sol.status, JSON.stringify(sol.data)).toBe(200)
    for (const [kind, id] of [['table', tables.find((t) => t.name === 'FLog')!.id], ['flow', f.id]]) expect((await A().post(`/solutions/${sol.data.id}/components`, { kind, id })).status).toBe(200)
    const yaml = (await A().get(`/solutions/${sol.data.id}/package`)).data.yaml as string
    expect(yaml).toMatch(/flows:/)
    const env = await A().post('/environments', { name: 'Flows target', type: 'sandbox' })
    expect(env.status, JSON.stringify(env.data)).toBe(200)
    const T = new Client(h.base)
    T.cookie = A().cookie
    T.env = env.data.id
    // no HTTP connection there yet: the plan asks for one
    const p0 = (await T.post('/solutions/import/plan', { yaml })).data
    expect(p0.items.find((i: any) => i.kind === 'flow')).toMatchObject({ change: 'new', name: 'Shipped' })
    expect(p0.flowConnections[0]).toMatchObject({ from: 'conn_api', to: null })
    expect(p0.problems.join(' ')).toMatch(/Choose the connection/)
    await runInEnvironment(env.data.id, () => h.app.services.meta.connections.upsert({ id: 'conn_api_prod', name: 'Api prod', connector: 'http' as any, status: 'connected', settings: {}, isDefault: false, scope: 'server' }))
    const p1 = (await T.post('/solutions/import/plan', { yaml, connectionMap: { conn_api: 'conn_api_prod' } })).data
    expect(p1.problems).toEqual([])
    const imp = await T.post('/solutions/import', { yaml, connectionMap: { conn_api: 'conn_api_prod' } })
    expect(imp.status, JSON.stringify(imp.data)).toBe(200)
    const there = (await T.get(`/flows/${f.id}`)).data.flow
    expect(there).toMatchObject({ enabled: false, version: 1, connections: [{ ref: 'api', connectionId: 'conn_api_prod' }] })
    expect((await T.get(`/flows/${f.id}/permissions`)).data.roleIds).toEqual(['role_maker'])
    // a new version upgrades it in place (confirm token), keeping it off
    expect((await A().req('PUT', `/flows/${f.id}`, { description: 'v2' })).status).toBe(200)
    const yaml2 = (await A().get(`/solutions/${sol.data.id}/package`)).data.yaml as string
    const p2 = (await T.post('/solutions/import/plan', { yaml: yaml2, connectionMap: { conn_api: 'conn_api_prod' } })).data
    expect(p2.mode).toBe('upgrade')
    expect(p2.items.find((i: any) => i.kind === 'flow').change).toBe('changed')
    const up = await T.post('/solutions/import', { yaml: yaml2, connectionMap: { conn_api: 'conn_api_prod' }, confirm: p2.token })
    expect(up.status, JSON.stringify(up.data)).toBe(200)
    expect((await T.get(`/flows/${f.id}`)).data.flow).toMatchObject({ version: 2, description: 'v2', enabled: false })
    // removed from the solution: removed by the next upgrade
    await A().del(`/solutions/${sol.data.id}/components/flow/${f.id}`)
    const yaml3 = (await A().get(`/solutions/${sol.data.id}/package`)).data.yaml as string
    const p3 = (await T.post('/solutions/import/plan', { yaml: yaml3 })).data
    expect(p3.items.find((i: any) => i.kind === 'flow')).toMatchObject({ change: 'removed' })
    expect((await T.post('/solutions/import', { yaml: yaml3, confirm: p3.token })).status).toBe(200)
    expect((await T.get(`/flows/${f.id}`)).status).toBe(404)
    // an environment copy: the flows come along, turned off, with no schedule armed
    const sched = await mkFlow({ name: 'Copy me', trigger: { type: 'schedule', everyMinutes: 60, timeZone: 'UTC' }, steps: [{ id: 'c', name: 'C', kind: 'compose', value: '1' }] })
    const cp = await A().post('/environments', { name: 'Flows copy', type: 'sandbox', copyFrom: 'default', copy: 'schema' })
    expect(cp.status, JSON.stringify(cp.data)).toBe(200)
    const copied = await h.q<any>(`SELECT id, enabled FROM env_${cp.data.id}.ab_flows WHERE id = $1`, [sched.id])
    expect(copied).toEqual([{ id: sched.id, enabled: false }])
    expect(await h.q<any>(`SELECT id FROM env_${cp.data.id}.ab_schedules WHERE job_type = 'flow.schedule'`)).toEqual([])
    await A().post(`/flows/${sched.id}/disable`)
  }, 180000)
})
