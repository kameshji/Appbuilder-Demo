/**
 * Approvals on PostgreSQL (P1 package C; docs/dev/approvals.md): lifecycle of every type, "need more info", reassign,
 * delegation (at assignment time and retroactively), reminders and escalation with the flow clock, cancellation and
 * expiry, the security rule with leak tests (a person not involved sees nothing anywhere; an approver who cannot read
 * the record sees only the declared details), email links (single use, expiring, bound to a person, prefetch-safe, a
 * POST with the CSRF header and a session), bulk answers, the record timeline, the system tables, the API, ALM of
 * policies, backup restore rules and the approvalDecided flow trigger.
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/approvals
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { setQuiet } from '../util.ts'
import { runInEnvironment } from '../env-context.ts'
import { Client, startHarness, type KernelHarness } from '../kernel-testkit.ts'
import type { UserContext } from '../contracts.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[server/core/approvals integration] ${SKIP_PG}\n`)

/* eslint-disable @typescript-eslint/no-explicit-any */
describe.skipIf(!PG_URL)('approvals (PostgreSQL)', () => {
  let h: KernelHarness
  let now = new Date('2030-05-06T08:00:00Z') // a Monday
  const inEnv = <T>(fn: () => Promise<T>) => runInEnvironment('default', fn)
  const ap = () => h.app.services.approvals!
  const ids: Record<string, string> = {}
  const clients: Record<string, Client> = {}
  const ctx = (email: string) => inEnv(async () => h.app.services.security.forUser((await h.app.services.meta.users.byEmail(email))!)) as Promise<UserContext>
  const drain = async () => {
    for (let i = 0; i < 6; i++) {
      await h.app.services.kernel.drain({ timeoutMs: 60_000 })
      const t = await inEnv(() => ap().tick(true))
      const n = await inEnv(() => h.app.services.flows.sweep(true))
      if (!t.delegations && !t.reminders && !t.escalations && !n) break
    }
    await h.app.services.kernel.drain({ timeoutMs: 60_000 })
  }
  const login = async (email: string): Promise<Client> => {
    const c = new Client(h.base)
    const r = await c.post('/auth/login', { email, password: 'some-password-1' })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return c
  }
  const create = async (who: string, body: any) => inEnv(async () => ap().requestFromUser(await ctx(who), body, 'api'))
  const detail = async (who: string, id: string) => inEnv(async () => ap().detail(await ctx(who), id))
  const respond = async (who: string, id: string, response: string, comment: string | null = null) => inEnv(async () => ap().respond(await ctx(who), id, response, comment))
  const status = async (id: string) => (await h.q<any>('SELECT status, outcome FROM env_default.ab_approval_requests WHERE id = $1', [id]))[0]
  const pendingOf = async (id: string) => (await h.q<any>(`SELECT u.email FROM env_default.ab_approval_assignments a JOIN ab.users u ON u.id = a.user_id WHERE a.request_id = $1 AND a.status = 'pending' ORDER BY u.email`, [id])).map((x) => x.email)

  beforeAll(async () => {
    h = await startHarness('approvals')
    h.app.services.flows.setClock({ now: () => now })
    const A = h.admin
    // organisation: Finance department, Raj (requester) -> Mona (manager) -> Dev (director, job title Director) -> Ceo
    const dept = await A.post('/departments', { code: 'FIN', name: 'Finance' })
    expect(dept.status, JSON.stringify(dept.data)).toBe(200)
    const viewer = 'role_viewer'
    const fin = await A.post('/roles', { name: 'Finance', privileges: [], apps: 'all' })
    expect(fin.status, JSON.stringify(fin.data)).toBe(200)
    ids.roleFinance = fin.data.id
    const mk = async (name: string, email: string, extra: any = {}) => {
      const u = await A.post('/users', { name, email, roleIds: ['role_maker'], password: 'some-password-1', ...extra })
      expect(u.status, JSON.stringify(u.data)).toBe(200)
      ids[email] = u.data.id
      return u.data.id as string
    }
    const ceo = await mk('Cleo Ceo', 'ceo@example.com', { jobTitle: 'CEO' })
    const dev = await mk('Dev Director', 'dev@example.com', { jobTitle: 'Director', managerId: ceo, departmentId: dept.data.id })
    const mona = await mk('Mona Manager', 'mona@example.com', { jobTitle: 'Manager', managerId: dev, departmentId: dept.data.id })
    await mk('Raj Requester', 'raj@example.com', { managerId: mona, departmentId: dept.data.id })
    await mk('Fay Finance', 'fay@example.com', { roleIds: ['role_maker', fin.data.id] })
    await mk('Fio Finance', 'fio@example.com', { roleIds: ['role_maker', fin.data.id] })
    await mk('Gus Colleague', 'gus@example.com', { managerId: mona })
    await mk('Nia Nobody', 'nia@example.com', { roleIds: [viewer] })
    await mk('Vic Viewer', 'vic@example.com', { roleIds: [viewer] })
    await h.q(`UPDATE ab.users SET must_change_password = false`)
    const team = await A.post('/teams', { code: 'QA', name: 'Quality', memberIds: [ids['fay@example.com'], ids['gus@example.com']] })
    expect(team.status, JSON.stringify(team.data)).toBe(200)
    // a table with row security: makers read their own rows only (Raj's order is invisible to Fay, Nia, Vic)
    const t = await A.post('/tables', { displayName: 'Purchase orders', name: 'POrders', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Amount', type: 'number' }, { displayName: 'Secret', type: 'text' }] })
    expect(t.status, JSON.stringify(t.data)).toBe(200)
    ids.table = t.data.id
    for (const role of ['role_maker', viewer]) {
      const def: any = await inEnv(() => h.app.services.meta.roles.get(role))
      const privileges = [...(def.privileges ?? []).filter((p: any) => p.table !== ids.table), { table: ids.table, create: role === 'role_maker', read: 'own', update: 'own', delete: 'own' }]
      const p = await A.patch(`/roles/${role}`, { privileges })
      expect(p.status, JSON.stringify(p.data)).toBe(200)
    }
    for (const e of ['raj@example.com', 'mona@example.com', 'dev@example.com', 'fay@example.com', 'nia@example.com', 'vic@example.com', 'gus@example.com']) clients[e] = await login(e)
    const row = await clients['raj@example.com'].post(`/data/${ids.table}/rows`, { values: { Title: 'Laptops', Amount: 20000, Secret: 'budget code 77' } })
    expect(row.status, JSON.stringify(row.data)).toBe(200)
    ids.order = row.data.row.id
    await inEnv(async () => ap().invalidateOrg())
  }, 240000)

  afterAll(async () => { await h?.close() }, 60000)

  it('routes a single manager approval; decides once; records history; immutable', async () => {
    const r = await create('raj@example.com', { approvers: ['manager'], title: 'Laptops for QA', fields: { Amount: 20000 }, regarding: { table: ids.table, rowId: ids.order } })
    expect(await pendingOf(r.id)).toEqual(['mona@example.com'])
    await drain()
    // Mona got a bell notification that deep-links to the request
    const n = await h.q<any>(`SELECT title, link FROM ab.notifications WHERE user_id = $1 AND title LIKE 'Approval needed:%'`, [ids['mona@example.com']])
    expect(n.map((x) => x.link)).toContain(`#u-approvals?id=${r.id}`)
    // someone not asked cannot answer (and cannot even see it)
    await expect(respond('gus@example.com', r.id, 'Approve')).rejects.toMatchObject({ status: 404 })
    // the requester cannot approve their own request
    await expect(respond('raj@example.com', r.id, 'Approve')).rejects.toMatchObject({ status: 403 })
    expect(await respond('mona@example.com', r.id, 'Approve', 'Fine')).toEqual({ status: 'approved', outcome: 'Approve' })
    await expect(respond('mona@example.com', r.id, 'Reject')).rejects.toMatchObject({ status: 409 })
    const d = await detail('raj@example.com', r.id)
    expect(d.history.map((x) => x.action)).toEqual(['requested', 'asked', 'responded', 'decided'])
    expect(d.assignments[0]).toMatchObject({ userName: 'Mona Manager', source: 'manager', status: 'responded', response: 'Approve', comment: 'Fine' })
    await drain()
    const told = await h.q<any>(`SELECT title FROM ab.notifications WHERE user_id = $1 AND title LIKE 'Your request was approved:%'`, [ids['raj@example.com']])
    expect(told).toHaveLength(1)
  })

  it('first to respond (any), everyone (all, reject on first), quorum (2 of 3), role and team approvers', async () => {
    const any = await create('raj@example.com', { approvers: ['role:Finance'], type: 'any', title: 'Any finance' })
    expect(await pendingOf(any.id)).toEqual(['fay@example.com', 'fio@example.com'])
    await respond('fio@example.com', any.id, 'Reject', 'No budget')
    expect(await status(any.id)).toEqual({ status: 'rejected', outcome: 'Reject' })
    expect(await pendingOf(any.id)).toEqual([])
    const all = await create('raj@example.com', { approvers: ['team:QA', 'fio@example.com'], type: 'all', title: 'All of them' })
    expect(await pendingOf(all.id)).toEqual(['fay@example.com', 'fio@example.com', 'gus@example.com'])
    await respond('fay@example.com', all.id, 'Approve')
    await respond('gus@example.com', all.id, 'Approve')
    expect((await status(all.id)).status).toBe('pending')
    await respond('fio@example.com', all.id, 'Approve')
    expect(await status(all.id)).toEqual({ status: 'approved', outcome: 'Approve' })
    const all2 = await create('raj@example.com', { approvers: ['team:QA'], type: 'all', title: 'All, one rejects' })
    await respond('gus@example.com', all2.id, 'Reject')
    expect((await status(all2.id)).status).toBe('rejected')
    const q = await create('raj@example.com', { policy: undefined, approvers: ['fay@example.com', 'fio@example.com', 'gus@example.com'], type: 'quorum', title: 'Two of three', ...{} } as any)
      .catch((e) => e)
    // quorum needs the number: through a policy
    expect(q).toMatchObject({ status: 422 })
    const pol = await inEnv(async () => ap().savePolicy(await ctx('ada@example.com'), null, { name: 'Two of three', definition: { type: 'quorum', quorum: 2, approvers: ['fay@example.com', 'fio@example.com', 'gus@example.com'] } }))
    const q2 = await create('raj@example.com', { policy: pol.name, title: 'Quorum' })
    await respond('fay@example.com', q2.id, 'Approve')
    await respond('gus@example.com', q2.id, 'Reject')
    expect((await status(q2.id)).status).toBe('pending')
    await respond('fio@example.com', q2.id, 'Approve')
    expect((await status(q2.id)).status).toBe('approved')
    const q3 = await create('raj@example.com', { policy: pol.name, title: 'Quorum lost' })
    await respond('fay@example.com', q3.id, 'Reject')
    await respond('gus@example.com', q3.id, 'Reject')
    expect((await status(q3.id)).status).toBe('rejected')
  })

  it('sequential stages with thresholds, manager chain until a title, separation of duties, self-approval fallback', async () => {
    const pol = await inEnv(async () => ap().savePolicy(await ctx('ada@example.com'), null, {
      name: 'Purchase', definition: {
        type: 'sequential', separationOfDuties: true,
        stages: [{ name: 'Manager', approvers: ['manager'] }, { name: 'Finance', approvers: ['role:Finance', 'mona@example.com'], mode: 'any' }],
        rules: [{ name: 'Big', condition: 'Amount > 10000', approvers: ['manager-chain-until-title:CEO'] }],
      },
    }))
    const small = await create('raj@example.com', { policy: 'Purchase', title: 'Small', fields: { Amount: 500 } })
    expect((await detail('raj@example.com', small.id)).stages.map((s) => s.name)).toEqual(['Manager', 'Finance'])
    await respond('mona@example.com', small.id, 'Approve')
    // separation of duties: Mona approved stage 1 and is not asked in stage 2
    expect(await pendingOf(small.id)).toEqual(['fay@example.com', 'fio@example.com'])
    expect((await detail('raj@example.com', small.id)).history.some((x) => x.action === 'routing.separation')).toBe(true)
    await respond('fay@example.com', small.id, 'Approve')
    expect((await status(small.id)).status).toBe('approved')
    const big = await create('raj@example.com', { policy: pol.id, title: 'Big', fields: { Amount: 50000 } })
    const d = await detail('raj@example.com', big.id)
    // the chain from Raj up to the first CEO: Mona, Dev, Cleo (one stage each)
    expect(d.stages.map((s) => s.name)).toEqual(['Manager', 'Finance', 'Big (level 1)', 'Big (level 2)', 'Big (level 3)'])
    // self-approval: Mona asks with herself as the only approver -> her manager (Dev), and why is recorded
    const self = await create('mona@example.com', { approvers: ['mona@example.com'], title: 'My own' })
    expect(await pendingOf(self.id)).toEqual(['dev@example.com'])
    const h2 = (await detail('mona@example.com', self.id)).history
    expect(h2.find((x) => x.action === 'routing.self')?.details.text).toMatch(/may not approve/)
    expect(h2.find((x) => x.action === 'routing.fallback')?.details.text).toMatch(/Dev Director/)
    // department head of the requester's department (Finance: Dev, whose manager is outside it)
    const head = await create('raj@example.com', { approvers: ['department-head'], title: 'Head' })
    expect(await pendingOf(head.id)).toEqual(['dev@example.com'])
  })

  it('need more info returns to the requester and resumes; custom answers; required comments; reassign; cancel', async () => {
    const pol = await inEnv(async () => ap().savePolicy(await ctx('ada@example.com'), null, {
      name: 'NCR disposition', definition: { type: 'single', approvers: ['fay@example.com'], requireCommentOnReject: true, responses: [{ label: 'Use as is', kind: 'approve' }, { label: 'Scrap', kind: 'reject' }, { label: 'Rework', kind: 'other' }, { label: 'Need more info', kind: 'info' }] },
    }))
    void pol
    const r = await create('raj@example.com', { policy: 'NCR disposition', title: 'NCR 12' })
    await expect(respond('fay@example.com', r.id, 'Scrap')).rejects.toMatchObject({ status: 422 })
    await respond('fay@example.com', r.id, 'Need more info', 'Photos please')
    expect((await status(r.id)).status).toBe('info')
    await expect(respond('fay@example.com', r.id, 'Rework')).rejects.toMatchObject({ status: 409 })
    await inEnv(async () => ap().answerInfo(await ctx('raj@example.com'), r.id, 'Attached'))
    expect((await status(r.id)).status).toBe('pending')
    await respond('fay@example.com', r.id, 'Rework', 'Grind the edge')
    expect(await status(r.id)).toEqual({ status: 'completed', outcome: 'Rework' })
    // reassign by the approver (audited), then cancel by the requester
    const r2 = await create('raj@example.com', { approvers: ['fay@example.com'], title: 'Reassign me' })
    await inEnv(async () => ap().reassign(await ctx('fay@example.com'), r2.id, { to: 'fio@example.com', comment: 'Fio knows' }))
    expect(await pendingOf(r2.id)).toEqual(['fio@example.com'])
    await expect(respond('fay@example.com', r2.id, 'Approve')).rejects.toMatchObject({ status: 403 })
    const audit = await h.q<any>(`SELECT action FROM env_default.ab_audit WHERE action = 'approval.reassign'`)
    expect(audit.length).toBeGreaterThan(0)
    await expect(inEnv(async () => ap().cancel(await ctx('fio@example.com'), r2.id, 'no'))).rejects.toMatchObject({ status: 403 })
    await inEnv(async () => ap().cancel(await ctx('raj@example.com'), r2.id, ''))
    expect(await status(r2.id)).toEqual({ status: 'cancelled', outcome: 'Cancelled' })
  })

  it('delegation at assignment time and retroactively; ends hand back; reminders and escalation follow the clock', async () => {
    now = new Date('2030-05-06T09:00:00Z')
    const before = await create('raj@example.com', { approvers: ['fay@example.com'], title: 'Before delegation' })
    // Fay is away from tomorrow 00:00 to Thursday: delegates to Fio
    const dl = await inEnv(async () => ap().createDelegation(await ctx('fay@example.com'), { toUser: 'fio@example.com', startsOn: '2030-05-07T00:00:00Z', endsOn: '2030-05-09T00:00:00Z', note: 'Leave' }))
    expect(dl.active).toBe(false)
    expect(await pendingOf(before.id)).toEqual(['fay@example.com'])
    now = new Date('2030-05-07T08:00:00Z')
    await drain()
    // retroactive: the pending one moved to Fio; a new one goes to Fio at once
    expect(await pendingOf(before.id)).toEqual(['fio@example.com'])
    const during = await create('raj@example.com', { approvers: ['fay@example.com'], title: 'During delegation' })
    expect(await pendingOf(during.id)).toEqual(['fio@example.com'])
    const dd = await detail('fay@example.com', during.id)
    expect(dd.assignments[0]).toMatchObject({ source: 'delegation', reassignedFrom: ids['fay@example.com'] })
    // Fay (who delegated) still sees it; Fio decides
    now = new Date('2030-05-09T08:00:00Z')
    await drain()
    // the delegation ended: what is still pending goes back to Fay
    expect(await pendingOf(before.id)).toEqual(['fay@example.com'])
    // reminders and escalation
    await inEnv(async () => ap().savePolicy(await ctx('ada@example.com'), null, { name: 'Escalating', definition: { type: 'single', approvers: ['gus@example.com'], dueMinutes: 24 * 60, reminders: { afterMinutes: 60, everyMinutes: 120, max: 2 }, escalation: { action: 'manager' } } }))
    await inEnv(async () => ap().savePolicy(await ctx('ada@example.com'), null, { name: 'Auto approve', definition: { type: 'single', approvers: ['gus@example.com'], dueMinutes: 60, escalation: { action: 'approve', afterMinutes: 30 } } }))
    const esc = await create('raj@example.com', { policy: 'Escalating', title: 'Escalate me' })
    const auto = await create('raj@example.com', { policy: 'Auto approve', title: 'Auto' })
    now = new Date(now.getTime() + 61 * 60_000)
    await drain()
    now = new Date(now.getTime() + 121 * 60_000)
    await drain()
    now = new Date(now.getTime() + 121 * 60_000)
    await drain()
    const reminders = await h.q<any>(`SELECT count(*)::int AS n FROM env_default.ab_approval_history WHERE request_id = $1 AND action = 'reminded'`, [esc.id])
    expect(reminders[0].n).toBe(2)
    expect(await status(auto.id)).toEqual({ status: 'approved', outcome: 'Approve' })
    const autoHist = (await detail('raj@example.com', auto.id)).history.find((x) => x.action === 'decided')!
    expect(autoHist).toMatchObject({ actorKind: 'system', details: { automatic: true } })
    now = new Date(now.getTime() + 24 * 3600_000)
    await drain()
    // Gus's manager Mona is asked in his place (escalation recorded)
    expect(await pendingOf(esc.id)).toEqual(['mona@example.com'])
    const ed = await detail('raj@example.com', esc.id)
    expect(ed.assignments.find((a) => a.userId === ids['mona@example.com'])).toMatchObject({ source: 'escalation', reassignedFrom: ids['gus@example.com'] })
  })

  it('LEAK: people not involved see nothing; an approver without access to the record sees only the declared details', async () => {
    const r = await create('raj@example.com', { approvers: ['fay@example.com'], title: 'About the laptops', details: '<p>Please approve <b>quickly</b><script>x</script></p>', fields: { Amount: 20000 }, regarding: { table: ids.table, rowId: ids.order } })
    // Fay cannot read Raj's order: she sees the title, details and fields, never the record
    const f = await clients['fay@example.com'].get(`/approvals/${r.id}`)
    expect(f.status).toBe(200)
    expect(f.data.request.record).toBe(null)
    expect(f.data.request.recordHidden).toBe(true)
    expect(f.data.request.details).not.toContain('<script>')
    expect(JSON.stringify(f.data)).not.toContain('budget code 77')
    // Raj (the requester, who can read it) sees the record summary
    const rr = await clients['raj@example.com'].get(`/approvals/${r.id}`)
    expect(rr.data.request.record.fields.find((x: any) => x.name === 'Secret').value).toBe('budget code 77')
    // Nia: not involved, no privilege: 404 everywhere, empty lists, nothing in the system tables, timeline 404
    const N = clients['nia@example.com']
    expect((await N.get(`/approvals/${r.id}`)).status).toBe(404)
    expect((await N.get('/approvals?view=toApprove')).data.items).toEqual([])
    expect((await N.get('/approvals?view=involved')).data.items).toEqual([])
    expect((await N.get('/approvals?view=all')).status).toBe(403)
    expect((await N.post(`/approvals/${r.id}/respond`, { response: 'Approve' })).status).toBe(404)
    for (const t of ['sys_approval_requests', 'sys_approval_assignments', 'sys_approval_history', 'sys_approval_stages']) {
      const q = await N.post(`/data/${t}/query`, { select: ['id'], count: true })
      expect(q.status, `${t} ${JSON.stringify(q.data)}`).toBe(200)
      expect(q.data.rows, t).toEqual([])
      expect(q.data.total, t).toBe(0)
    }
    expect((await N.get(`/approvals/record/${ids.table}/${ids.order}`)).status).toBe(404)
    // Vic has "Approvals: view" but cannot read the record either: still nothing
    await inEnv(async () => ap().saveSettings(await ctx('ada@example.com'), { viewerRoles: ['role_viewer'] }))
    expect((await clients['vic@example.com'].get(`/approvals/${r.id}`)).status).toBe(404)
    const vq = await clients['vic@example.com'].post('/data/sys_approval_requests/query', { select: ['id'] })
    expect(vq.data.rows).toEqual([])
    // Fay sees her own request rows through the system tables (assigned), and the Comments rule follows the request
    const fq = await clients['fay@example.com'].post('/data/sys_approval_requests/query', { select: ['id', 'Title'] })
    expect(fq.data.rows.map((x: any) => x.id)).toContain(r.id)
    const cm = await clients['raj@example.com'].post(`/data/sys_comments/rows`, { values: { regardingTable: 'sys_approval_requests', regardingId: r.id, Body: 'See the quote' } })
    expect(cm.status, JSON.stringify(cm.data)).toBe(200)
    const nc = await N.post('/data/sys_comments/query', { select: ['id'], where: { col: 'regardingId', op: 'eq', value: r.id } })
    expect(nc.data.rows).toEqual([])
    const fc = await clients['fay@example.com'].post('/data/sys_comments/query', { select: ['id'], where: { col: 'regardingId', op: 'eq', value: r.id } })
    expect(fc.data.rows).toHaveLength(1)
    await respond('fay@example.com', r.id, 'Approve')
    // the record timeline: the requester sees the approval events; Nia cannot open the record at all
    const tl = await clients['raj@example.com'].get(`/collab/timeline?table=${ids.table}&row=${ids.order}`)
    expect(tl.status).toBe(200)
    expect(tl.data.items.filter((i: any) => i.kind === 'event' && String(i.data.action).startsWith('approval.')).map((i: any) => i.data.action)).toEqual(expect.arrayContaining(['approval.requested', 'approval.decided']))
    expect((await N.get(`/collab/timeline?table=${ids.table}&row=${ids.order}`)).status).toBe(404)
    await inEnv(async () => ap().saveSettings(await ctx('ada@example.com'), { viewerRoles: [] }))
  })

  it('email links: open only a confirmation; single use; bound to the person; expire; need a session and the CSRF header', async () => {
    const r = await create('raj@example.com', { approvers: ['fay@example.com'], title: 'Link me' })
    const a = (await h.q<any>(`SELECT id FROM env_default.ab_approval_assignments WHERE request_id = $1`, [r.id]))[0]
    const links = await inEnv(async () => ap().makeLinks(r.id, a.id, ids['fay@example.com'], [{ label: 'Approve', kind: 'approve' }, { label: 'Reject', kind: 'reject' }]))
    const approve = links.find((l) => l.label === 'Approve')!.token
    // a mail scanner fetching the link URL gets the app page only: the token is in the #fragment, never sent to the server;
    // and there is no GET route that answers
    expect((await new Client(h.base).get(`/approvals/links/use?token=${approve}`)).status).toBeGreaterThanOrEqual(400)
    // no session: 401; no CSRF header: refused
    expect((await new Client(h.base).post('/approvals/links/inspect', { token: approve })).status).toBe(401)
    const raw = await fetch(`${h.base}/api/v1/approvals/links/use`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: clients['fay@example.com'].cookie }, body: JSON.stringify({ token: approve }) })
    expect(raw.status).toBe(403)
    // another person's session: refused
    const g = await clients['gus@example.com'].post('/approvals/links/inspect', { token: approve })
    expect(g.data).toMatchObject({ ok: false, code: 'other-user' })
    expect((await clients['gus@example.com'].post('/approvals/links/use', { token: approve })).status).toBe(403)
    // a forged token
    expect((await clients['fay@example.com'].post('/approvals/links/inspect', { token: approve.slice(0, -2) + 'xx' })).data).toMatchObject({ ok: false, code: 'invalid' })
    // inspecting changes nothing
    const i = await clients['fay@example.com'].post('/approvals/links/inspect', { token: approve })
    expect(i.data).toMatchObject({ ok: true, response: 'Approve' })
    expect((await status(r.id)).status).toBe('pending')
    const u = await clients['fay@example.com'].post('/approvals/links/use', { token: approve, comment: 'from my phone' })
    expect(u.status, JSON.stringify(u.data)).toBe(200)
    expect(u.data).toMatchObject({ status: 'approved' })
    // single use, and the other answer's link is dead too (decided)
    expect((await clients['fay@example.com'].post('/approvals/links/use', { token: approve })).status).toBe(409)
    expect((await clients['fay@example.com'].post('/approvals/links/inspect', { token: links[1].token })).data).toMatchObject({ ok: false })
    const hist = (await detail('raj@example.com', r.id)).history.find((x) => x.action === 'responded')!
    expect(hist.details).toMatchObject({ via: 'email', comment: 'from my phone' })
    // expiry
    const r2 = await create('raj@example.com', { approvers: ['fay@example.com'], title: 'Expiring link' })
    const a2 = (await h.q<any>(`SELECT id FROM env_default.ab_approval_assignments WHERE request_id = $1`, [r2.id]))[0]
    const l2 = await inEnv(async () => ap().makeLinks(r2.id, a2.id, ids['fay@example.com'], [{ label: 'Approve', kind: 'approve' }]))
    now = new Date(now.getTime() + 73 * 3600_000)
    expect((await clients['fay@example.com'].post('/approvals/links/inspect', { token: l2[0].token })).data).toMatchObject({ ok: false, code: 'expired' })
  })

  it('bulk approve with one comment; a policy can forbid bulk', async () => {
    await inEnv(async () => ap().savePolicy(await ctx('ada@example.com'), null, { name: 'One by one', definition: { type: 'single', approvers: ['gus@example.com'], allowBulk: false } }))
    const a = await create('raj@example.com', { approvers: ['gus@example.com'], title: 'Bulk 1' })
    const b = await create('raj@example.com', { approvers: ['gus@example.com'], title: 'Bulk 2' })
    const c = await create('raj@example.com', { policy: 'One by one', title: 'Not in bulk' })
    const list = await clients['gus@example.com'].get('/approvals?view=toApprove')
    expect(list.data.items.map((x: any) => x.id)).toEqual(expect.arrayContaining([a.id, b.id, c.id]))
    const res = await clients['gus@example.com'].post('/approvals/respond-many', { ids: [a.id, b.id, c.id], response: 'Approve', comment: 'All fine' })
    expect(res.data.results.map((x: any) => x.ok)).toEqual([true, true, false])
    expect(res.data.results[2].error).toMatch(/on its own/)
    expect((await status(a.id)).status).toBe('approved')
    expect((await status(c.id)).status).toBe('pending')
  })

  it('the API from apps: RequestApproval with a client id is idempotent; Approvals panel per record', async () => {
    const R = clients['raj@example.com']
    const body = { id: 'appr_app000000001', approvers: 'mona@example.com', title: 'From an app', regarding: { rowId: ids.order }, source: 'app' }
    const one = await R.post('/approvals', body)
    expect(one.status, JSON.stringify(one.data)).toBe(200)
    const two = await R.post('/approvals', body)
    expect(two.data).toEqual({ id: 'appr_app000000001', created: false })
    expect((await clients['gus@example.com'].post('/approvals', { ...body, regarding: undefined })).status).toBe(409)
    const panel = await R.get(`/approvals/record/${ids.table}/${ids.order}`)
    expect(panel.data.items.map((x: any) => x.id)).toContain('appr_app000000001')
    // a record the requester cannot read cannot be named
    const other = await clients['gus@example.com'].post('/approvals', { approvers: 'mona@example.com', title: 'x', regarding: { rowId: ids.order } })
    expect(other.status).toBe(422)
  })

  it('approvalDecided starts a flow once per decided request', async () => {
    const t = await h.admin.post('/tables', { displayName: 'Decisions', name: 'Decisions', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Outcome', type: 'text' }] })
    expect(t.status).toBe(200)
    const f = await h.admin.post('/flows', {
      name: 'Log decisions', enabled: true, settings: { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' },
      trigger: { type: 'approvalDecided', policy: 'Purchase', statuses: ['approved', 'rejected'] },
      steps: [{ id: 'c', name: 'C', kind: 'data.create', table: 'Decisions', values: { Title: 'Trigger.Request.Title', Outcome: 'Trigger.Request.Outcome & " by " & First(Trigger.Responses).Name' } }],
    })
    expect(f.status, JSON.stringify(f.data)).toBe(200)
    const r = await create('raj@example.com', { policy: 'Purchase', title: 'Chairs', fields: { Amount: 10 } })
    await respond('mona@example.com', r.id, 'Reject', 'Too many')
    const other = await create('raj@example.com', { approvers: ['mona@example.com'], title: 'No policy' })
    await respond('mona@example.com', other.id, 'Approve')
    await drain()
    await drain()
    const rows = await h.q<any>(`SELECT "Title", "Outcome" FROM env_default.t_decisions`)
    expect(rows).toEqual([{ Title: 'Chairs', Outcome: 'Reject by Mona Manager' }])
  })

  it('policies travel in solutions (approvers by reference; users by email); pending requests do not', async () => {
    const pol = (await h.admin.get('/approvals/policies')).data.items.find((p: any) => p.name === 'Purchase')
    const sol = await h.admin.post('/solutions', { name: 'Purchasing', displayName: 'Purchasing', publisher: 'Acme', version: '1.0.0' })
    expect(sol.status, JSON.stringify(sol.data)).toBe(200)
    const add = await h.admin.post(`/solutions/${sol.data.id}/components`, { kind: 'approvalPolicy', id: pol.id })
    expect(add.status, JSON.stringify(add.data)).toBe(200)
    const exp = await h.admin.get(`/solutions/${sol.data.id}/package`)
    expect(exp.status, JSON.stringify(exp.data).slice(0, 300)).toBe(200)
    const text = exp.data.yaml as string
    expect(text).toContain('manager-chain-until-title:CEO')
    expect(text).not.toContain('appr_')
    // a policy that names a person directly travels by email
    const direct = (await h.admin.get('/approvals/policies')).data.items.find((p: any) => p.name === 'Escalating')
    await h.admin.post(`/solutions/${sol.data.id}/components`, { kind: 'approvalPolicy', id: direct.id })
    await inEnv(async () => ap().savePolicy(await ctx('ada@example.com'), direct.id, { name: 'Escalating', definition: { type: 'single', approvers: [ids['gus@example.com'], 'role:Finance'], dueMinutes: 60, escalation: { action: 'manager' } } }))
    const yaml = (await h.admin.get(`/solutions/${sol.data.id}/package`)).data.yaml as string
    expect(yaml).toContain('user:gus@example.com')
    expect(yaml).not.toContain(ids['gus@example.com'])
    // round trip into a new environment (copy of the schema: policies come along, requests do not)
    const env = await h.admin.post('/environments', { name: 'Test approvals', type: 'developer', copyFrom: 'default', copy: 'schema' })
    expect(env.status, JSON.stringify(env.data)).toBe(200)
    const T = new Client(h.base)
    T.cookie = h.admin.cookie
    T.env = env.data.id
    expect((await h.q<any>(`SELECT count(*)::int AS n FROM env_${env.data.id.replace(/-/g, '_')}.ab_approval_requests`).catch(() => [{ n: 0 }]))[0].n).toBe(0)
    expect((await T.get('/approvals/policies')).data.items.map((p: any) => p.name)).toContain('Purchase')
    // an import of the package: plan shows people found or flagged; peopleMap maps them
    await h.q(`UPDATE ab.users SET email = 'gus.old@example.com' WHERE email = 'gus@example.com'`)
    const plan = await T.post('/solutions/import/plan', { yaml })
    expect(plan.status, JSON.stringify(plan.data)).toBe(200)
    expect(plan.data.approvalPeople).toEqual(expect.arrayContaining([expect.objectContaining({ email: 'gus@example.com', to: null, usedBy: ['Escalating'] }), expect.objectContaining({ email: 'mona@example.com', toName: 'Mona Manager' })]))
    expect(plan.data.warnings.join(' ')).toMatch(/gus@example\.com.*no account here/)
    const plan2 = await T.post('/solutions/import/plan', { yaml, peopleMap: { 'gus@example.com': 'gus.old@example.com' } })
    expect(plan2.data.approvalPeople.find((p: any) => p.email === 'gus@example.com')).toMatchObject({ to: ids['gus@example.com'] })
    const imp = await T.post('/solutions/import', { yaml, peopleMap: { 'gus@example.com': 'gus.old@example.com' }, confirm: plan2.data.token })
    expect(imp.status, JSON.stringify(imp.data)).toBe(200)
    const after = (await T.get('/approvals/policies')).data.items.find((p: any) => p.name === 'Escalating')
    expect(after.definition.approvers).toEqual(['user:gus.old@example.com', 'role:Finance'])
    await h.q(`UPDATE ab.users SET email = 'gus@example.com' WHERE email = 'gus.old@example.com'`)
  })
})
