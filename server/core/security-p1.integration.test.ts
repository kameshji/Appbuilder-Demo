/**
 * Security re-check of Phase 1 (package E) over HTTP on PostgreSQL: flow privilege escalation (child flows, drafts,
 * test runs, owners, run-as, resubmit), locked production (flows and approval policies), approvals (bulk answers and
 * required comments, two approvers at once, delegation back to the requester), loop and trigger storms and the
 * environment run limit, manual-run inputs as data, template injection into notification emails, webhook enumeration,
 * secrets of the new settings (SMTP OAuth) never in answers or the audit log, request ids.
 * Findings and residual risks: docs/internal/security-review-p1.md.
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/security-p1.integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from './testdb.ts'
import { setQuiet } from './util.ts'
import { runInEnvironment } from './env-context.ts'
import { Client, startHarness, type KernelHarness } from './kernel-testkit.ts'
import { startFakeSmtp, type FakeSmtp } from './identity/fake-smtp.ts'
import type { UserContext } from './contracts.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[security-p1 integration] ${SKIP_PG}\n`)

/* eslint-disable @typescript-eslint/no-explicit-any */
describe.skipIf(!PG_URL)('security re-check of Phase 1 (PostgreSQL)', () => {
  let h: KernelHarness
  let smtp: FakeSmtp
  const C: Record<string, Client> = {}
  const ids: Record<string, string> = {}
  const settings = { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' }
  const inEnv = <T>(fn: () => Promise<T>) => runInEnvironment('default', fn)
  const ctx = (email: string) => inEnv(async () => h.app.services.security.forUser((await h.app.services.meta.users.byEmail(email))!)) as Promise<UserContext>
  const drain = async () => {
    for (let i = 0; i < 10; i++) {
      await h.app.services.kernel.drain({ timeoutMs: 60_000 })
      const n = await inEnv(() => h.app.services.flows.sweep(true))
      const t = await inEnv(() => h.app.services.approvals!.tick(true))
      if (!n && !t.escalations && !t.reminders && !t.delegations) break
    }
  }
  const put = (c: Client, p: string, b: unknown) => c.req('PUT', p, b)
  const login = async (email: string) => {
    const c = new Client(h.base)
    const r = await c.post('/auth/login', { email, password: 'some-password-1' })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return c
  }

  beforeAll(async () => {
    h = await startHarness('secp1')
    smtp = await startFakeSmtp()
    for (const [name, email, roles] of [['Mia Maker', 'mia@example.com', ['role_maker']], ['Max Maker', 'max@example.com', ['role_maker']], ['Rae Requester', 'rae@example.com', ['role_maker']], ['Abe Approver', 'abe@example.com', ['role_maker']], ['Bea Approver', 'bea@example.com', ['role_maker']]] as [string, string, string[]][]) {
      const u = await h.admin.post('/users', { name, email, roleIds: roles, password: 'some-password-1' })
      expect(u.status, JSON.stringify(u.data)).toBe(200)
      ids[email] = u.data.id
    }
    await h.q(`UPDATE ab.users SET must_change_password = false`)
    for (const e of ['mia@example.com', 'max@example.com', 'rae@example.com', 'abe@example.com', 'bea@example.com']) C[e] = await login(e)
    for (const t of [{ displayName: 'Ping', name: 'Ping', columns: [{ displayName: 'N', type: 'number' }] }, { displayName: 'Pong', name: 'Pong', columns: [{ displayName: 'N', type: 'number' }] }, { displayName: 'Log', name: 'SecLog', columns: [{ displayName: 'Text', type: 'text' }] }]) {
      expect((await h.admin.post('/tables', t)).status).toBe(200)
    }
  }, 240000)
  afterAll(async () => {
    await smtp?.close()
    await h?.close()
  }, 60000)

  it('FINDING 2: a maker\'s flow cannot call a flow its identity may not run (save time and run time)', async () => {
    const target = await h.admin.post('/flows', { name: 'AdminOnly', enabled: true, settings, trigger: { type: 'manual', inputs: [{ name: 'T', type: 'text' }], from: 'any' }, steps: [{ id: 'w', name: 'W', kind: 'data.create', table: 'SecLog', values: { Text: '"admin flow: " & Trigger.Inputs.T' } }] })
    expect(target.status, JSON.stringify(target.data)).toBe(200)
    const parent = { name: 'CallsAdmin', enabled: true, settings, trigger: { type: 'manual', inputs: [], from: 'any' }, steps: [{ id: 'c', name: 'C', kind: 'callFlow', flow: 'AdminOnly', inputs: { T: '"from mia"' } }] }
    const refused = await C['mia@example.com'].post('/flows', parent)
    expect(refused.status).toBe(403)
    expect(refused.data.error.message).toMatch(/may not run "AdminOnly"/)
    // granted to makers: Mia may save it; revoked later: the run-time check stops the call
    expect((await put(h.admin, `/flows/${target.data.flow.id}/permissions`, { roleIds: ['role_maker'] })).status).toBe(200)
    const saved = await C['mia@example.com'].post('/flows', parent)
    expect(saved.status, JSON.stringify(saved.data)).toBe(200)
    expect((await put(h.admin, `/flows/${target.data.flow.id}/permissions`, { roleIds: [] })).status).toBe(200)
    const run = await C['mia@example.com'].post(`/flows/${saved.data.flow.id}/run`, {})
    expect(run.status, JSON.stringify(run.data)).toBe(200)
    await drain()
    const st = await h.q<any>('SELECT state, error FROM env_default.ab_flow_runs WHERE id = $1', [run.data.runId])
    expect(st[0].state).toBe('failed')
    expect(JSON.stringify(st[0].error)).toMatch(/may not run/)
    expect((await h.q<any>(`SELECT count(*)::int AS n FROM env_default.t_seclog WHERE "Text" LIKE 'admin flow%'`))[0].n).toBe(0)
  }, 120000)

  it('drafts, test runs, owners and run-as: only editors; a maker cannot hand a flow to someone else or make it a service', async () => {
    const f = await C['mia@example.com'].post('/flows', { name: 'MiasFlow', settings, trigger: { type: 'manual', inputs: [], from: 'any' }, steps: [{ id: 'a', name: 'A', kind: 'compose', value: '1' }] })
    expect(f.status).toBe(200)
    const id = f.data.flow.id
    expect((await put(C['mia@example.com'], `/flows/${id}/draft`, { flow: { ...f.data.flow, steps: [{ id: 'a', name: 'A', kind: 'compose', value: '"secret draft"' }] } })).status).toBe(200)
    const other = await C['max@example.com'].get(`/flows/${id}/draft`)
    expect(other.data.draft ?? null).toBeNull()
    expect(JSON.stringify(other.data)).not.toContain('secret draft')
    expect((await C['max@example.com'].post(`/flows/${id}/test`, { definition: { ...f.data.flow, steps: [{ id: 'x', name: 'X', kind: 'data.create', table: 'SecLog', values: { Text: '"max via test"' } }] } })).status).toBe(403)
    expect((await put(C['max@example.com'], `/flows/${id}`, { ...f.data.flow })).status).toBe(403)
    expect((await put(C['mia@example.com'], `/flows/${id}`, { ...f.data.flow, ownerId: ids['max@example.com'], confirmRunAs: true })).status).toBe(403)
    const sa = await h.admin.post('/identity/service-accounts', { name: 'Robot', environmentId: 'default', roleIds: ['role_maker'] })
    expect(sa.status, JSON.stringify(sa.data)).toBe(200)
    expect((await put(C['mia@example.com'], `/flows/${id}`, { ...f.data.flow, runAs: { serviceAccount: sa.data.id }, confirmRunAs: true })).status).toBe(403)
    // a draft never runs: the saved version runs
    const r = await C['mia@example.com'].post(`/flows/${id}/enable`)
    expect(r.status).toBe(200)
    const run = await C['mia@example.com'].post(`/flows/${id}/run`, {})
    await drain()
    const out = await h.q<any>(`SELECT output FROM env_default.ab_flow_steps WHERE run_id = $1 AND step_id = 'a'`, [run.data.runId])
    expect(JSON.stringify(out[0].output)).toBe('1')
    // resubmit of Mia's run: not Max
    expect((await C['max@example.com'].post(`/flows/runs/${run.data.runId}/resubmit`, { from: 'start' })).status).toBe(404)
  }, 120000)

  it('manual-run inputs are values, never formulas', async () => {
    const f = await C['mia@example.com'].post('/flows', { name: 'Echo', enabled: true, settings, trigger: { type: 'manual', inputs: [{ name: 'T', type: 'text' }], from: 'any' }, steps: [{ id: 'w', name: 'W', kind: 'data.create', table: 'SecLog', values: { Text: 'Trigger.Inputs.T' } }] })
    expect(f.status, JSON.stringify(f.data)).toBe(200)
    const evil = '" & Text(1+1) & Patch(SecLog, Defaults(SecLog), {Text: "pwned"}) & "'
    const run = await C['mia@example.com'].post(`/flows/${f.data.flow.id}/run`, { inputs: { T: evil } })
    expect(run.status).toBe(200)
    await drain()
    const rows = (await h.q<any>(`SELECT "Text" FROM env_default.t_seclog`)).map((x) => x.Text)
    expect(rows).toContain(evil)
    expect(rows).not.toContain('pwned')
  }, 60000)

  it('FINDING 3: flows and approval policies are read-only in a locked production environment', async () => {
    const f = await h.admin.post('/flows', { name: 'Locked', settings, trigger: { type: 'manual', inputs: [], from: 'any' }, steps: [{ id: 'a', name: 'A', kind: 'compose', value: '1' }] })
    const pol = await h.admin.post('/approvals/policies', { name: 'LockMe', definition: { type: 'single', approvers: ['manager'] } })
    expect(pol.status, JSON.stringify(pol.data)).toBe(200)
    const before = (await h.admin.get('/environments')).data.items.find((e: any) => e.id === 'default')
    expect((await h.admin.patch('/environments/default', { type: 'production', locked: true })).status).toBe(200)
    try {
      expect((await put(h.admin, `/flows/${f.data.flow.id}`, { ...f.data.flow, description: 'x' })).status).toBe(403)
      expect((await h.admin.post('/approvals/policies', { name: 'New in prod', definition: { type: 'single', approvers: ['manager'] } })).status).toBe(403)
      expect((await put(h.admin, `/approvals/policies/${pol.data.policy.id}`, { name: 'LockMe', definition: { type: 'single', approvers: ['abe@example.com'] } })).status).toBe(403)
      expect((await h.admin.del(`/approvals/policies/${pol.data.policy.id}`)).status).toBe(403)
      // the kill switch and turning a flow off still work
      expect((await h.admin.post(`/flows/${f.data.flow.id}/disable`)).status).toBe(200)
    } finally {
      expect((await h.admin.patch('/environments/default', { locked: false, type: before.type })).status).toBe(200)
    }
  }, 60000)

  it('approvals: bulk answers keep required comments; two approvers at once decide once; a delegation back to the requester does not let them approve', async () => {
    const ap = h.app.services.approvals!
    await inEnv(async () => ap.savePolicy(await ctx('ada@example.com'), null, { name: 'Comment on reject', definition: { type: 'single', approvers: ['abe@example.com'], requireCommentOnReject: true } }))
    const mk = async (body: any) => inEnv(async () => ap.requestFromUser(await ctx('rae@example.com'), body, 'api'))
    const a = await mk({ policy: 'Comment on reject', title: 'Bulk A' })
    const b = await mk({ policy: 'Comment on reject', title: 'Bulk B' })
    const res = await C['abe@example.com'].post('/approvals/respond-many', { ids: [a.id, b.id], response: 'Reject' })
    expect(res.data.results.map((x: any) => x.ok)).toEqual([false, false])
    expect(res.data.results[0].error).toMatch(/comment is required/)
    // first to respond, two people at the same moment
    const race = await mk({ approvers: ['abe@example.com', 'bea@example.com'], type: 'any', title: 'Race' })
    const both = await Promise.all([C['abe@example.com'].post(`/approvals/${race.id}/respond`, { response: 'Approve' }), C['bea@example.com'].post(`/approvals/${race.id}/respond`, { response: 'Reject', comment: 'no' })])
    expect(both.filter((x) => x.status === 200).length).toBe(1)
    const decided = await h.q<any>(`SELECT count(*)::int AS n FROM env_default.ab_approval_history WHERE request_id = $1 AND action = 'decided'`, [race.id])
    expect(decided[0].n).toBe(1)
    // Abe delegates to Rae; Rae asks Abe: Rae must not end up approving her own request
    const dl = await inEnv(async () => ap.createDelegation(await ctx('abe@example.com'), { toUser: 'rae@example.com', startsOn: new Date(Date.now() - 60_000).toISOString(), endsOn: new Date(Date.now() + 86_400_000).toISOString() }))
    expect(dl).toBeTruthy()
    const own = await mk({ approvers: ['abe@example.com'], title: 'Own request' })
    const pending = await h.q<any>(`SELECT user_id FROM env_default.ab_approval_assignments WHERE request_id = $1 AND status = 'pending'`, [own.id])
    expect(pending.map((x) => x.user_id)).not.toContain(ids['rae@example.com'])
    expect((await C['rae@example.com'].post(`/approvals/${own.id}/respond`, { response: 'Approve' })).status).not.toBe(200)
  }, 120000)

  it('loop and trigger storms: Ping -> Pong -> Ping stops; the environment run limit holds under a burst', async () => {
    const mkFlow = async (name: string, on: string, to: string) => {
      const r = await h.admin.post('/flows', { name, enabled: true, settings, trigger: { type: 'table', table: on, on: ['create'] }, steps: [{ id: 'c', name: 'C', kind: 'data.create', table: to, values: { N: 'Trigger.Record.N + 1' } }] })
      expect(r.status, JSON.stringify(r.data)).toBe(200)
      return r.data.flow.id
    }
    const a = await mkFlow('PingToPong', 'Ping', 'Pong')
    const b = await mkFlow('PongToPing', 'Pong', 'Ping')
    const tPing = (await inEnv(() => h.app.services.meta.tables.list())).find((t) => t.name === 'Ping')!
    expect((await h.admin.post(`/data/${tPing.id}/rows`, { values: { N: 0 } })).status).toBe(200)
    await drain()
    await drain()
    const n = (await h.q<any>(`SELECT (SELECT count(*) FROM env_default.t_ping)::int + (SELECT count(*) FROM env_default.t_pong)::int AS n`))[0].n
    expect(n).toBeGreaterThan(1)
    expect(n).toBeLessThanOrEqual(12) // depth 8 (FLOW_MAX_DEPTH) plus the first row
    await h.admin.post(`/flows/${a}/disable`)
    await h.admin.post(`/flows/${b}/disable`)
    // burst: 40 manual runs with an environment limit of 5 per minute: at most 5 start now, nothing is dropped
    expect((await put(h.admin, '/flows/settings', { environmentRunsPerMinute: 5 })).status).toBe(200)
    const f = await h.admin.post('/flows', { name: 'Burst', enabled: true, settings, trigger: { type: 'manual', inputs: [], from: 'any' }, steps: [{ id: 'a', name: 'A', kind: 'compose', value: '1' }] })
    await Promise.all(Array.from({ length: 40 }, () => h.admin.post(`/flows/${f.data.flow.id}/run`, {})))
    await drain()
    const states = await h.q<any>(`SELECT state, count(*)::int AS n FROM env_default.ab_flow_runs WHERE flow_id = $1 GROUP BY state`, [f.data.flow.id])
    const by = Object.fromEntries(states.map((x) => [x.state, x.n]))
    expect((by.succeeded ?? 0)).toBeLessThanOrEqual(5)
    expect(Object.values(by).reduce((x: number, y: any) => x + y, 0)).toBe(40)
    expect((await put(h.admin, '/flows/settings', { environmentRunsPerMinute: 6000 })).status).toBe(200)
  }, 180000)

  it('template injection: HTML in a notification is text in the app and escaped in the email', async () => {
    expect((await h.admin.req('PUT', '/identity/email', { host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'apps@example.com', installName: 'Acme', publicUrl: 'http://127.0.0.1' })).status).toBe(200)
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>'
    await h.app.services.notifications!.notify({ userIds: [ids['mia@example.com']] }, { kind: 'health', title: `Alert ${evil}`, body: `Body ${evil}`, source: 'test', environmentId: null })
    await drain()
    const mails = await smtp.waitFor(1, 20000)
    const m = mails.find((x) => x.subject.includes('Alert'))!
    expect(m.html).not.toMatch(/<img src=x|<script>/i)
    expect(m.html).toContain('&lt;img')
    const stored = await h.q<any>(`SELECT title FROM ab.notifications WHERE user_id = $1 AND kind = 'health'`, [ids['mia@example.com']])
    expect(stored[0].title).toContain('<img') // stored as text; the app renders notifications as text
  }, 60000)

  it('secrets of the new settings: SMTP OAuth client secret and refresh token never in answers or the audit log', async () => {
    const r = await h.admin.req('PUT', '/identity/email', { host: '127.0.0.1', port: smtp.port, security: 'none', username: 'apps@example.com', fromAddress: 'apps@example.com', auth: 'oauth2', oauth2: { provider: 'google', grant: 'refresh_token', clientId: 'cid', clientSecret: 'TOPSECRET-client', refreshToken: 'TOPSECRET-refresh' } })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    expect(JSON.stringify(r.data)).not.toContain('TOPSECRET')
    expect(r.data.settings.oauth2).toMatchObject({ hasClientSecret: true, hasRefreshToken: true, scope: 'https://mail.google.com/' })
    expect(JSON.stringify((await h.admin.get('/identity/email')).data)).not.toContain('TOPSECRET')
    expect(JSON.stringify(await h.q('SELECT details FROM ab.audit'))).not.toContain('TOPSECRET')
    expect(JSON.stringify(await h.q(`SELECT v FROM ab.settings WHERE k = 'identity.smtp'`))).not.toContain('TOPSECRET')
    // a non-https token address is refused
    expect((await h.admin.req('PUT', '/identity/email', { host: '127.0.0.1', port: smtp.port, security: 'none', username: 'apps@example.com', fromAddress: 'apps@example.com', auth: 'oauth2', oauth2: { provider: 'custom', grant: 'client_credentials', tokenUrl: 'http://login.example.com/token', clientId: 'c', clientSecret: 's', scope: 'x' } })).status).toBe(422)
    await h.admin.req('PUT', '/identity/email', { host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'apps@example.com', auth: 'password' })
  }, 60000)

  it('FINDING 10: recycle bin: batch details, DeletedRows, restore of hidden rows, guessed batch ids, purge and Empty now', async () => {
    const t = await h.admin.post('/tables', { displayName: 'Bin', name: 'SecBin', columns: [{ displayName: 'Title', type: 'text' }] })
    expect(t.status).toBe(200)
    expect(t.data.recycleDays).toBe(30)
    const own = await h.admin.post('/roles', { name: 'Own bin rows', apps: 'all', privileges: [{ table: t.data.id, create: true, read: 'own', update: 'own', delete: 'own' }] })
    const u = await h.admin.post('/users', { name: 'Ola Own', email: 'ola@example.com', roleIds: [own.data.id], password: 'some-password-1' })
    await h.q(`UPDATE ab.users SET must_change_password = false WHERE id = $1`, [u.data.id])
    const ola = await login('ola@example.com')
    const mine = (await ola.post(`/data/${t.data.id}/rows`, { values: { Title: 'ola row' } })).data.row.id
    const secret = (await h.admin.post(`/data/${t.data.id}/rows`, { values: { Title: 'admin secret' } })).data.row.id
    const del = (await h.admin.post(`/data/${t.data.id}/delete`, { ids: [secret] })).data
    const delMine = (await ola.post(`/data/${t.data.id}/delete`, { ids: [mine] })).data
    // the details of someone else's batch (row ids, who deleted) are not given to a user who sees none of its rows
    const info = await ola.get(`/data/${t.data.id}/recycle?batch=${encodeURIComponent(del.batch.id)}`)
    expect(info.status).toBe(404)
    expect(JSON.stringify(info.data)).not.toContain(secret)
    expect((await ola.get(`/data/${t.data.id}/recycle?batch=${encodeURIComponent(delMine.batch.id)}`)).data.batch.rootIds).toEqual([mine])
    // the Deleted view (and DeletedRows on the server) lists only her own deleted row
    const seen = await ola.get(`/data/${t.data.id}/deleted`)
    expect(seen.data.rows.map((r: any) => r.Title)).toEqual(['ola row'])
    expect(JSON.stringify(seen.data)).not.toContain('admin secret')
    // restoring the hidden row, by batch, by row id or by the batch id alone: answered like a missing one
    expect((await ola.post(`/data/${t.data.id}/restore`, { batch: del.batch.id })).status).toBe(404)
    expect((await ola.post(`/data/${t.data.id}/restore`, { rowId: secret })).status).toBe(404)
    expect((await ola.post('/recycle/restore', { batch: del.batch.id })).status).toBe(404)
    // a guessed batch id (a UUIDv7 a millisecond later) does not exist
    expect((await ola.post('/recycle/restore', { batch: `${del.batch.id.slice(0, -4)}ffff` })).status).toBe(404)
    // purge and Empty now: administrators only
    expect((await ola.post(`/data/${t.data.id}/purge`, { batch: delMine.batch.id })).status).toBe(403)
    expect((await ola.post(`/data/${t.data.id}/purge`, { all: true, confirm: 'SecBin' })).status).toBe(403)
    // her own row comes back; the administrator's stays deleted
    expect((await ola.post(`/data/${t.data.id}/restore`, { batch: delMine.batch.id })).status).toBe(200)
    expect((await h.q<any>(`SELECT "deletedOn" FROM env_default.t_secbin WHERE id = $1`, [secret]))[0].deletedOn).not.toBeNull()
  }, 60000)

  it('webhook enumeration: unknown environment, flow and token answer the same 404; request ids carry no data; no recovery route over HTTP', async () => {
    const f = await h.admin.post('/flows', { name: 'Hooked', enabled: true, settings, trigger: { type: 'webhook' }, steps: [{ id: 'a', name: 'A', kind: 'compose', value: '1' }] })
    expect(f.status, JSON.stringify(f.data)).toBe(200)
    const hook = await h.admin.post(`/flows/${f.data.flow.id}/webhooks`, {})
    expect(hook.status, JSON.stringify(hook.data)).toBe(200)
    const tok = 'A'.repeat(32)
    const answers = []
    for (const p of [`/hooks/nope/${f.data.flow.id}/${tok}`, `/hooks/default/flow_nope/${tok}`, `/hooks/default/${f.data.flow.id}/${tok}`]) {
      const r = await fetch(`${h.base}/api/v1${p}`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })
      answers.push(`${r.status} ${JSON.stringify(((await r.json()) as any).error?.message)}`)
      expect(r.headers.get('x-request-id') ?? '').toMatch(/^[0-9a-f]{16}$/)
    }
    expect(new Set(answers).size).toBe(1)
    expect(answers[0]).toMatch(/^404/)
    for (const p of ['/admin/recovery', '/admin/reset-password', '/admin/reset-mfa', '/cli/admin', '/admin/make-install-admin']) {
      const r = await h.admin.post(p, {})
      expect([404, 405], p).toContain(r.status)
    }
  }, 60000)
})
