/**
 * The Manufacturing pack's flows and lifecycle against the sandbox PostgreSQL (the platform gaps its build exposed;
 * docs/guide/maker/manufacturing-pack.md, docs/dev/solution-templates.md). The flows run as the administrator who
 * installed the pack:
 *  - the inspector whose failed inspection raised an NCR cannot approve its disposition (the NCR belongs to them; the
 *    approval is on their behalf), also when someone else sends it for approval: then their manager decides (fallback);
 *  - a maintenance request raised by the breakdown flow belongs to the operator who reported the stoppage (their
 *    own-rows role sees it);
 *  - the role notifications reach the role's people (no formula over RoleAssignments);
 *  - an environment copy with data knows the installed packs: its Templates page plans an upgrade and uninstalls;
 *  - "Uninstall keeping tables" after "Remove sample data": an empty pack table that a kept table looks up is kept too.
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/templates/manufacturing
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { Client, startHarness, type KernelHarness } from '../kernel-testkit.ts'
import { setQuiet } from '../util.ts'
import { runInEnvironment } from '../env-context.ts'
import { registerTestTemplates } from './catalogue.ts'
import { manufacturingNext } from './testdata/manufacturing-next.ts'
import type { UserContext } from '../contracts.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[manufacturing pack integration] ${SKIP_PG}\n`)
const S = 'env_default'
type Any = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(!PG_URL)(PG_URL ? 'the Manufacturing pack (PostgreSQL)' : `manufacturing pack ${SKIP_PG}`, { timeout: 300_000 }, () => {
  let h: KernelHarness
  let mfg: Any
  const who: Record<string, string> = {}
  const inEnv = <T>(fn: () => Promise<T>) => runInEnvironment('default', fn)
  const drain = async () => {
    for (let i = 0; i < 10; i++) {
      await h.app.services.kernel.drain({ timeoutMs: 60_000 })
      const t = await inEnv(() => h.app.services.approvals!.tick(true))
      const n = await inEnv(() => h.app.services.flows.sweep(true))
      if (!n && !t.delegations && !t.reminders && !t.escalations) break
    }
    await h.app.services.kernel.drain({ timeoutMs: 60_000 })
  }
  const ctxOf = async (email: string): Promise<UserContext> => inEnv(async () => h.app.services.security.forUser((await h.app.services.meta.users.byEmail(email))!))
  const tableDef = async (name: string) => inEnv(async () => (await h.app.services.meta.tables.list()).find((x) => x.name === name)!)
  const insert = async (email: string, table: string, values: Any) => inEnv(async () => h.app.services.data.insert(await ctxOf(email), await tableDef(table), values) as Promise<Any>)
  const update = async (email: string, table: string, id: string, values: Any) => inEnv(async () => h.app.services.data.update(await ctxOf(email), await tableDef(table), id, values))
  const rows = async (table: string, where = 'TRUE', params: unknown[] = []) => h.q<Any>(`SELECT * FROM ${S}."${(await tableDef(table)).source}" WHERE ${where}`, params)
  const requestAbout = async (rowId: string) => (await h.q<Any>(`SELECT * FROM ${S}.ab_approval_requests WHERE regarding_id = $1 ORDER BY created_on DESC`, [rowId]))[0]
  const pending = async (requestId: string) => (await h.q<Any>(`SELECT u.email, a.source FROM ${S}.ab_approval_assignments a JOIN ab.users u ON u.id = a.user_id WHERE a.request_id = $1 AND a.status = 'pending' ORDER BY u.email`, [requestId])).map((x) => `${x.email}:${x.source}`)
  const respond = async (email: string, id: string, outcome: string) => inEnv(async () => h.app.services.approvals!.respond(await ctxOf(email), id, outcome, null))
  const notified = async (email: string, re: RegExp) => (await h.q<Any>(`SELECT n.title FROM ab.notifications n JOIN ab.users u ON u.id = n.user_id WHERE lower(u.email) = lower($1)`, [email])).filter((n) => re.test(n.title))
  const failInspection = async (email: string, batch: string) => {
    const plan = (await rows('InspectionPlans', `"Name" = 'SAMPLE BR-10 hole diameter'`))[0]
    const insp = await insert(email, 'Inspections', { Plan: plan.id, Machine: 'SAMPLE-P2', Batch: batch, Stage: 'In-process', Measured: 10.12, SampleSize: 5, Result: 'Pass', Notes: 'Hole oversize' })
    expect(insp.Result).toBe('Fail')
    await drain()
    const ncr = (await rows('NCRs', `"Inspection" = $1`, [insp.id]))[0]
    expect(ncr, 'the NCR raised by the flow').toBeTruthy()
    return ncr
  }

  beforeAll(async () => {
    h = await startHarness('tplmfg')
    const A = h.admin
    const p = await A.post('/templates/builtin.manufacturing/plan', { mode: 'linked', sample: true })
    expect(p.data.plan?.problems, JSON.stringify(p.data).slice(0, 400)).toEqual([])
    const r = await A.post('/templates/builtin.manufacturing/install', { mode: 'linked', bindings: p.data.bindings, sample: true, confirm: p.data.plan.token, ...(p.data.plan.systemEvents?.length ? { approveSystem: true } : {}) })
    expect(r.status, JSON.stringify(r.data).slice(0, 600)).toBe(200)
    mfg = r.data.install
    // the install's own changes (SAMPLE rows) are dispatched while the flows are still off, as on a running server
    await drain()
    expect((await A.post(`/templates/installed/${mfg.id}/flows`, { enable: mfg.created.flows.map((f: Any) => f.id) })).status).toBe(200)
    const role = (key: string) => mfg.created.roles.find((x: Any) => x.key === key).id
    const mk = async (k: string, name: string, email: string, roleKey: string, extra: Any = {}) => {
      const u = await A.post('/users', { name, email, password: 'some-password-1', roleIds: [role(roleKey)], ...extra })
      expect(u.status, JSON.stringify(u.data)).toBe(200)
      who[k] = u.data.id
    }
    await mk('pm', 'Meera Plant Manager', 'meera@example.com', 'PlantManager')
    await mk('qc', 'Kavita Inspector', 'kavita@example.com', 'Quality', { managerId: who.pm })
    await mk('qh', 'Qamar Quality Head', 'qamar@example.com', 'Quality')
    await mk('op', 'Om Operator', 'om@example.com', 'Operator')
    await mk('tech', 'Tara Technician', 'tara@example.com', 'Maintenance')
  }, 300_000)

  afterAll(async () => { await h?.close() }, 60_000)

  it('the NCR raised from the inspector\'s failed inspection is theirs; the Quality role is told; the inspector cannot approve it, the quality head can', async () => {
    const ncr = await failInspection('kavita@example.com', 'LOT-1')
    expect(ncr.owner).toBe(who.qc)
    expect((await notified('qamar@example.com', /NCR .*failed/)).length).toBe(1)
    await update('kavita@example.com', 'NCRs', ncr.id, { Disposition: 'Rework', RootCause: 'Punch worn', Status: 'Awaiting approval' })
    await drain()
    const req = await requestAbout(ncr.id)
    expect(req, 'the approval request').toBeTruthy()
    expect(await pending(req.id)).toEqual(['qamar@example.com:role'])
    await expect(respond('kavita@example.com', req.id, 'Approve')).rejects.toThrow()
    expect(await respond('qamar@example.com', req.id, 'Approve')).toMatchObject({ status: 'approved' })
    await drain()
    expect((await rows('NCRs', 'id = $1', [ncr.id]))[0]).toMatchObject({ Approval: 'Approved', Status: 'Approved' })
  })

  it('sent for approval by the quality head, the inspector\'s NCR goes to the inspector\'s manager (the fallback), who approves', async () => {
    const ncr = await failInspection('kavita@example.com', 'LOT-2')
    await update('qamar@example.com', 'NCRs', ncr.id, { Disposition: 'Scrap', RootCause: 'Material', Status: 'Awaiting approval' })
    await drain()
    const req = await requestAbout(ncr.id)
    expect(await pending(req.id)).toEqual(['meera@example.com:fallback'])
    await expect(respond('kavita@example.com', req.id, 'Approve')).rejects.toThrow()
    await expect(respond('qamar@example.com', req.id, 'Approve')).rejects.toThrow()
    expect(await respond('meera@example.com', req.id, 'Approve')).toMatchObject({ status: 'approved' })
    await drain()
    expect((await rows('NCRs', 'id = $1', [ncr.id]))[0]).toMatchObject({ Approval: 'Approved' })
  })

  it('the maintenance request raised from an operator\'s breakdown is theirs: their own-rows role sees it', async () => {
    const stop = await insert('om@example.com', 'Downtime', { Machine: 'SAMPLE-P2', StartedOn: new Date().toISOString(), Reason: 'Breakdown', Notes: 'Ram does not return' })
    await drain()
    const mr = (await rows('MaintenanceRequests', `"Machine" = 'SAMPLE-P2' AND "Number" NOT LIKE 'SAMPLE%'`))[0]
    expect(mr, 'the request').toBeTruthy()
    expect(mr.owner).toBe(who.op)
    expect((await rows('Downtime', 'id = $1', [stop.id]))[0].MaintenanceRequest).toBe(mr.id)
    const seen = await inEnv(async () => (h.app.services.data as Any).queryV2(await ctxOf('om@example.com'), await tableDef('MaintenanceRequests'), { version: 2, table: 'MaintenanceRequests', select: ['id', 'Number'] }))
    expect(seen.rows.map((x: Any) => x.id)).toContain(mr.id)
    // the escalation path notifies the Maintenance and Plant manager roles by role (no formula over role assignments)
    const defs = await h.q<Any>(`SELECT definition::text AS d FROM ${S}.ab_flows WHERE id = ANY($1)`, [mfg.created.flows.map((f: Any) => f.id)])
    expect(defs.filter((x) => /RoleAssignments/.test(x.d)).length).toBeLessThanOrEqual(1)
  })

  it('an environment copy with data knows the installed packs: it plans an upgrade and an uninstall there', async () => {
    const env = await h.admin.post('/environments', { name: 'Plant copy', type: 'sandbox', copyFrom: 'default', copy: 'data' })
    expect(env.status, JSON.stringify(env.data).slice(0, 300)).toBe(200)
    const C = new Client(h.base)
    C.cookie = h.admin.cookie
    C.env = env.data.id
    const items = (await C.get('/templates/installed')).data.items as Any[]
    const there = items.find((x) => x.id === mfg.id)
    expect(there, JSON.stringify(items.map((x) => x.templateId))).toMatchObject({ templateId: 'builtin.manufacturing', status: 'installed' })
    expect(items.some((x) => x.templateId === 'builtin.business-model' && x.status === 'installed')).toBe(true)
    const unreg = registerTestTemplates([manufacturingNext()])
    try {
      const up = await C.post(`/templates/installed/${mfg.id}/upgrade/plan`, {})
      expect(up.status, JSON.stringify(up.data).slice(0, 400)).toBe(200)
      expect(up.data.plan.problems).toEqual([])
      const done = await C.post(`/templates/installed/${mfg.id}/upgrade`, { confirm: up.data.plan.token, proceedWithoutBackup: true })
      expect(done.status, JSON.stringify(done.data).slice(0, 400)).toBe(200)
      expect((await C.get('/templates/installed')).data.items.find((x: Any) => x.id === mfg.id).templateVersion).toBe('1.1.0')
    } finally { unreg() }
    const un = await C.post(`/templates/installed/${mfg.id}/uninstall/plan`, {})
    expect(un.data.problems).toEqual([])
    const gone = await C.post(`/templates/installed/${mfg.id}/uninstall`, { confirm: un.data.token, proceedWithoutBackup: true })
    expect(gone.status, JSON.stringify(gone.data).slice(0, 400)).toBe(200)
    // the original is untouched
    expect((await h.admin.get('/templates/installed')).data.items.find((x: Any) => x.id === mfg.id)).toMatchObject({ status: 'installed', templateVersion: '1.0.0' })
  })

  it('Remove sample data, then Uninstall keeping tables: empty pack tables that kept tables look up are kept too', async () => {
    const rm = await h.admin.post(`/templates/installed/${mfg.id}/sample/remove`, {})
    expect(rm.status, JSON.stringify(rm.data).slice(0, 300)).toBe(200)
    expect((await rows('InspectionPlans')).length).toBe(0)
    const p = await h.admin.post(`/templates/installed/${mfg.id}/uninstall/plan`, {})
    expect(p.data.problems, JSON.stringify(p.data.problems)).toEqual([])
    // Inspection plans is empty now, but Inspections (kept: it has rows) looks it up: kept, and the plan says why
    const plans = p.data.items.find((i: Any) => i.kind === 'table' && i.name === 'Inspection plans')
    expect(plans, JSON.stringify(p.data.items.filter((i: Any) => i.kind === 'table').map((i: Any) => [i.name, i.action]))).toMatchObject({ action: 'kept', rows: 0 })
    expect(plans.note).toMatch(/Inspections, kept, looks it up/)
    // an empty table nobody kept looks up still goes
    expect(p.data.items.find((i: Any) => i.kind === 'table' && i.name === 'Lines')).toMatchObject({ action: 'removed' })
    const u = await h.admin.post(`/templates/installed/${mfg.id}/uninstall`, { confirm: p.data.token, proceedWithoutBackup: true })
    expect(u.status, JSON.stringify(u.data).slice(0, 400)).toBe(200)
    expect(await tableDef('InspectionPlans')).toBeTruthy()
    expect(await tableDef('Lines')).toBeFalsy()
    expect(await tableDef('NCRs')).toBeTruthy()
    expect((await h.q(`SELECT 1 FROM ${S}.ab_flows WHERE id = ANY($1)`, [mfg.created.flows.map((f: Any) => f.id)])).length).toBe(0)
  })
})
