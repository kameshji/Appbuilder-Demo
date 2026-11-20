/**
 * WhatsApp connector end to end against the sandbox PostgreSQL (APPBUILDER_TEST_DB) and the fake Graph API
 * (mock-graph.ts; no real Meta account, no real numbers: +91 00000 0000x test numbers):
 *  - exit check 6: a flow with the `action` step sends a template message through the real engine to the mock; the
 *    opt-in is recorded; nothing is sent without it; a retried step sends once (idempotency key and Meta's message id);
 *  - every route to send refused without a current opt-in (action run, the Test action form, a flow, the text reply, the
 *    notification channel, an opted-out number, an HTTP connection to Meta's host);
 *  - the 24-hour window for text replies; plain-English provider errors without the token;
 *  - the webhook: handshake, signature (forged, missing, other secret), replay, status updates in the message log,
 *    inbound STOP (English and Hindi) and START, another WhatsApp number's events ignored;
 *  - the notification channel (offered only with a mapping, an approved template and the person's opt-in; quiet hours);
 *  - administrators only for the opt-in list and message log; secrets never in answers or logs;
 *  - environment copies take no opt-ins, no log, no mapping and no secrets; the schema 12 -> 13 step.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { Client, startHarness, type KernelHarness } from '../kernel-testkit.ts'
import { setQuiet } from '../util.ts'
import { runInEnvironment } from '../env-context.ts'
import { hashPassword } from '../password.ts'
import type { UserRecord } from '../contracts.ts'
import { ROLE_ADMIN, ROLE_MAKER } from '../auth.ts'
import { setGraphBaseForTests } from './graph.ts'
import { signMeta } from './webhook.ts'
import { sendMessage } from './send.ts'
import {
  MOCK_APP_SECRET, MOCK_PHONE_NUMBER_ID, MOCK_TOKEN, MOCK_VERIFY_TOKEN, MOCK_WABA_ID, graphError, inboundEvent, startMockGraph, statusEvent, type MockGraph,
} from './mock-graph.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[whatsapp integration] ${SKIP_PG}\n`)

const PW = 'member-password-1'
const A_NUM = '+910000000011' // opted in
const B_NUM = '+910000000012' // never opted in
const C_NUM = '+910000000013' // opts in, then STOP
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!PG_URL)(PG_URL ? 'WhatsApp connector (PostgreSQL)' : `WhatsApp connector ${SKIP_PG}`, { timeout: 240_000 }, () => {
  let h: KernelHarness
  let mock: MockGraph
  let maker: Client
  let nina: Client
  let connId = ''
  const A = () => h.admin
  const drain = async () => {
    for (let i = 0; i < 6; i++) {
      await h.app.services.kernel.drain({ timeoutMs: 60_000 })
      const n = await runInEnvironment('default', () => h.app.services.flows.sweep(true))
      if (!n) break
    }
  }
  const put = (c: Client, p: string, b: unknown) => c.req('PUT', p, b)
  const runAction = (action: string, inputs: unknown, key?: string) => h.app.services.actions!.run('default', connId, action, inputs, null, { source: 'test', ...(key ? { idempotencyKey: key } : {}) })
  const log = () => h.q<any>('SELECT * FROM env_default.ab_whatsapp_messages ORDER BY created_on, id')
  const hook = async (payload: unknown, o: { secret?: string; sig?: string | null; type?: string; conn?: string } = {}) => {
    const raw = JSON.stringify(payload)
    const headers: Record<string, string> = { 'Content-Type': o.type ?? 'application/json' }
    const sig = o.sig === undefined ? signMeta(o.secret ?? MOCK_APP_SECRET, raw) : o.sig
    if (sig) headers['X-Hub-Signature-256'] = sig
    const res = await fetch(`${h.base}/api/v1/whatsapp/webhook/default/${o.conn ?? connId}`, { method: 'POST', headers, body: raw })
    const text = await res.text()
    let data: any = text
    try { data = JSON.parse(text) } catch { /* text */ }
    return { status: res.status, data }
  }
  const addUser = async (id: string, email: string, roleIds: string[], phone?: string): Promise<Client> => {
    await runInEnvironment('default', () => h.app.services.meta.users.insert({ id, name: id.replace('user_', '').replace(/^./, (c) => c.toUpperCase()), email, roleIds, status: 'active', passwordHash: '' } as UserRecord))
    await h.q('UPDATE ab.users SET password_hash = $1, phone = $3 WHERE id = $2', [await hashPassword(PW), id, phone ?? null])
    await h.q('INSERT INTO ab.environment_access (environment_id, user_id, is_env_admin, granted_on) VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING', ['default', id, roleIds.includes(ROLE_ADMIN)]).catch(() => undefined)
    h.app.services.security.invalidate('all')
    const c = new Client(h.base)
    const r = await c.post('/auth/login', { email, password: PW })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return c
  }

  beforeAll(async () => {
    mock = await startMockGraph()
    setGraphBaseForTests(mock.url)
    h = await startHarness('whatsapp', { env: { APPBUILDER_MIGRATION_BACKUP: 'skip' } })
    maker = await addUser('user_mia', 'mia@example.com', [ROLE_MAKER])
    nina = await addUser('user_nina', 'nina@example.com', ['role_viewer'], '+91 00000 00021')
  }, 180_000)

  afterAll(async () => {
    setGraphBaseForTests(null)
    await h?.close()
    await mock?.close()
  }, 60_000)

  it('creates a WhatsApp connection (administrators only); no base address setting; secrets never returned', async () => {
    const secret = JSON.stringify({ accessToken: MOCK_TOKEN, appSecret: MOCK_APP_SECRET, verifyToken: MOCK_VERIFY_TOKEN })
    const settings = { phoneNumberId: MOCK_PHONE_NUMBER_ID, businessAccountId: MOCK_WABA_ID, defaultCountryCode: '91' }
    expect((await maker.post('/connections', { name: 'WA', connector: 'whatsapp', settings, secret })).status).toBe(403)
    const ssrf = await A().post('/connections', { name: 'WA evil', connector: 'whatsapp', settings: { ...settings, baseUrl: 'http://169.254.169.254' }, secret })
    expect(ssrf.status).toBe(422)
    expect(ssrf.data.error?.message ?? JSON.stringify(ssrf.data)).toMatch(/fixed/)
    const r = await A().post('/connections', { name: 'WhatsApp', connector: 'whatsapp', settings, secret })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    expect(r.data.status, JSON.stringify(r.data)).toBe('connected')
    expect(JSON.stringify(r.data)).not.toContain(MOCK_TOKEN)
    connId = r.data.id
    for (const p of ['/workspace', `/connections/${connId}/state`]) {
      const t = JSON.stringify((await A().get(p)).data)
      for (const s of [MOCK_TOKEN, MOCK_APP_SECRET, MOCK_VERIFY_TOKEN]) expect(t, p).not.toContain(s)
    }
    // the HTTP connector cannot be pointed at Meta's Graph API (that would skip the opt-in check)
    const http = await A().post('/connections', { name: 'Graph by HTTP', connector: 'http', settings: { baseUrl: 'https://graph.facebook.com/v21.0', authMode: 'bearer' }, secret: JSON.stringify({ token: MOCK_TOKEN }) })
    expect(http.status).toBe(422)
    expect(JSON.stringify(http.data)).toMatch(/only the WhatsApp connector/)
    // the actions are listed for the flow designer
    const kinds = (await maker.get('/actions/kinds')).data.items
    expect(kinds.find((k: any) => k.kind === 'whatsapp').actions.map((a: any) => a.id)).toEqual(['sendTemplate', 'sendText', 'listTemplates', 'checkOptIn', 'recordOptIn'])
  })

  it('refuses to send to a number without a current opt-in, by every route; nothing reaches Meta', async () => {
    const before = mock.sent.length
    const tpl = { to: B_NUM, template: 'order_update', language: 'en', bodyParams: ['Asha', 'SO-1', 'packed'] }
    // 1. services.actions.run (what flows, table events RunConnector and the Test form call)
    const a = await runAction('sendTemplate', tpl, 'k-route-1')
    expect(a.ok).toBe(false)
    expect(!a.ok && a.error).toMatchObject({ code: 'denied', retryable: false })
    expect(!a.ok && a.error.message).toMatch(/no current WhatsApp opt-in/)
    expect(!a.ok && a.error.message).not.toContain('0000000012')
    // 2. the Test action form (as an administrator)
    const t = await A().post(`/connections/${connId}/actions/sendTemplate/test`, { inputs: tpl })
    expect(t.data.ok).toBe(false)
    expect(t.data.error.code).toBe('denied')
    // 3. a text reply
    expect((await runAction('sendText', { to: B_NUM, text: 'hello' })).ok).toBe(false)
    // 4. a flow with the action step (the real engine)
    const f = await A().post('/flows', {
      name: 'No consent', enabled: true, settings: { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' },
      trigger: { type: 'manual', inputs: [], from: 'any' }, connections: { wa: connId },
      steps: [{ id: 's', name: 'S', kind: 'action', connection: 'wa', action: 'sendTemplate', inputs: { to: `"${B_NUM}"`, template: '"order_update"', bodyParams: '["Asha", "SO-1", "packed"]' } }],
    })
    expect(f.status, JSON.stringify(f.data)).toBe(200)
    const run = await A().post(`/flows/${f.data.flow.id}/run`, {})
    await drain()
    const d = (await A().get(`/flows/runs/${run.data.runId}`)).data.run
    expect(d.status).toBe('failed')
    expect(JSON.stringify(d.steps)).toMatch(/no current WhatsApp opt-in/)
    // 5. the send path itself (the notification channel's way in)
    const rec = await runInEnvironment('default', () => h.app.services.meta.connections.get(connId))
    await expect(runInEnvironment('default', () => sendMessage({ db: h.app.services.state.db!, connection: rec!, to: B_NUM, message: { kind: 'template', template: 'order_update', language: 'en', bodyParams: ['a', 'b', 'c'] }, identity: null, source: 'test', cache: new Map(), timeoutMs: 5000 }))).rejects.toMatchObject({ code: 'denied' })
    expect(mock.sent.length).toBe(before)
    // the refusals are in the message log
    const refused = (await log()).filter((m: any) => m.phone === B_NUM)
    expect(refused.length).toBeGreaterThanOrEqual(5)
    expect(refused.every((m: any) => m.status === 'refused' && m.error_code === 'no_opt_in' && !m.provider_id)).toBe(true)
  })

  it('exit check 6: opt-in recorded, a flow sends a template message to the mock through the real engine, once', async () => {
    // opt-in by an administrator, with evidence; makers cannot use the admin API
    expect((await maker.post('/whatsapp/optins', { phone: A_NUM, status: 'opted_in', source: 'administrator', evidence: 'Signed paper form at the counter, 20 Nov' })).status).toBe(403)
    const o = await A().post('/whatsapp/optins', { phone: '+91 00000 00011', status: 'opted_in', source: 'form', evidence: 'Ticked "Send me order updates on WhatsApp" on order form SO-1001' })
    expect(o.status, JSON.stringify(o.data)).toBe(200)
    expect(o.data.optIn).toMatchObject({ phone: A_NUM, status: 'opted_in', source: 'form' })
    expect(o.data.optIn.recordedBy).toBeTruthy()
    const f = await A().post('/flows', {
      name: 'Order shipped', enabled: true, settings: { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' },
      trigger: { type: 'manual', inputs: [], from: 'any' }, connections: { wa: connId },
      steps: [
        { id: 'chk', name: 'Check', kind: 'action', connection: 'wa', action: 'checkOptIn', inputs: { to: `"${A_NUM}"` } },
        { id: 's', name: 'Send', kind: 'action', connection: 'wa', action: 'sendTemplate', inputs: { to: '"+91 00000 00011"', template: '"order_update"', language: '"en"', bodyParams: '["Asha", "SO-1001", "shipped"]' } },
      ],
    })
    expect(f.status, JSON.stringify(f.data)).toBe(200)
    const before = mock.sent.length
    const run = await A().post(`/flows/${f.data.flow.id}/run`, {})
    await drain()
    const d = (await A().get(`/flows/runs/${run.data.runId}`)).data.run
    expect(d.status, JSON.stringify(d.steps)).toBe('succeeded')
    expect(mock.sent.length).toBe(before + 1)
    const sent = mock.sent.at(-1)!
    expect(sent).toMatchObject({ to: '910000000011', type: 'template', template: { name: 'order_update', language: 'en', body: ['Asha', 'SO-1001', 'shipped'] } })
    const step = d.steps.find((s: any) => s.key === '/s')
    expect(JSON.stringify(step.output)).toContain(sent.id)
    expect(JSON.stringify(step.output)).not.toContain('0000000011')
    const chk = d.steps.find((s: any) => s.key === '/chk')
    expect(JSON.stringify(chk.output)).toMatch(/"OptedIn":true|"optedIn":true/i)
    // the message log: key, Meta's id, the flow link
    const row = (await log()).find((m: any) => m.provider_id === sent.id)
    expect(row).toMatchObject({ direction: 'out', phone: A_NUM, status: 'accepted', template: 'order_update', idempotency_key: `${run.data.runId}:/s`, source: `flow:${f.data.flow.id}` })
    // a retry of the same step (same key) does not send again: the framework's key, and the message log's key
    const again = await runAction('sendTemplate', { to: A_NUM, template: 'order_update', bodyParams: ['Asha', 'SO-1001', 'shipped'] }, `${run.data.runId}:/s`)
    expect(again.ok && again.replayed).toBe(true)
    await h.q('DELETE FROM env_default.ab_action_idempotency')
    const again2 = await runAction('sendTemplate', { to: A_NUM, template: 'order_update', bodyParams: ['Asha', 'SO-1001', 'shipped'] }, `${run.data.runId}:/s`)
    expect(again2.ok && (again2.output as any).replayed).toBe(true)
    expect(again2.ok && (again2.output as any).providerMessageId).toBe(sent.id)
    expect(mock.sent.length).toBe(before + 1)
  })

  it('the 24-hour window: a text reply only after the person wrote; plain-English provider errors without the token', async () => {
    const no = await runAction('sendText', { to: A_NUM, text: 'Thanks!' })
    expect(!no.ok && no.error.message).toMatch(/has not written to this WhatsApp number/)
    expect((await hook(inboundEvent(A_NUM, 'Where is my order?'))).status).toBe(200)
    const yes = await runAction('sendText', { to: A_NUM, text: 'It ships today.' })
    expect(yes.ok, JSON.stringify(yes)).toBe(true)
    expect(mock.sent.at(-1)).toMatchObject({ type: 'text', text: 'It ships today.' })
    // a window older than 24 hours
    await h.q(`UPDATE env_default.ab_whatsapp_windows SET last_inbound_on = now() - interval '25 hours' WHERE phone = $1`, [A_NUM])
    const old = await runAction('sendText', { to: A_NUM, text: 'Late reply' })
    expect(!old.ok && old.error.message).toMatch(/more than 24 hours ago/)
    // provider errors
    const tpl = { to: A_NUM, template: 'order_update', bodyParams: ['A', 'B', 'C'] }
    expect(await runAction('sendTemplate', { ...tpl, template: 'no_such_template' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    const pending = await runAction('sendTemplate', { to: A_NUM, template: 'festival_offer', bodyParams: ['A', '10'] })
    expect(!pending.ok && pending.error.message).toMatch(/not approved/)
    const count = await runAction('sendTemplate', { ...tpl, bodyParams: ['only one'] })
    expect(!count.ok && count.error.message).toMatch(/number of values/)
    mock.failNext(1, 429, graphError(130429, 'Rate limit hit'), { 'retry-after': '60' })
    const rl = await runAction('sendTemplate', tpl, 'k-rl')
    expect(rl).toMatchObject({ ok: false, error: { code: 'rate_limited', retryable: true } })
    expect(!rl.ok && rl.error.message).toMatch(/Try again in 60 s/)
    mock.failNext(1, 401, graphError(190, `Error validating access token: ${MOCK_TOKEN} has expired`, { error_subcode: 463 }))
    const exp = await runAction('sendTemplate', tpl)
    expect(exp).toMatchObject({ ok: false, error: { code: 'not_configured' } })
    expect(JSON.stringify(exp)).not.toContain(MOCK_TOKEN)
    mock.failNext(1, 400, graphError(131026, 'Message undeliverable'))
    expect(!((await runAction('sendTemplate', tpl)) as any).ok).toBe(true)
    // the retry after the rate limit sends (the key was released)
    const retry = await runAction('sendTemplate', tpl, 'k-rl')
    expect(retry.ok).toBe(true)
    // no secret anywhere in the logs
    const dump = (await h.q<{ t: string }>(`SELECT (SELECT coalesce(string_agg(r::text, ' '), '') FROM env_default.ab_action_runs r) || (SELECT coalesce(string_agg(m::text, ' '), '') FROM env_default.ab_whatsapp_messages m) || (SELECT coalesce(string_agg(a::text, ' '), '') FROM env_default.ab_audit a) || (SELECT coalesce(string_agg(j::text, ' '), '') FROM env_default.ab_jobs j) AS t`))[0]!.t
    for (const s of [MOCK_TOKEN, MOCK_APP_SECRET, MOCK_VERIFY_TOKEN]) expect(dump).not.toContain(s)
    // the activity of actions shows masked numbers only
    const act = await h.q<{ d: string }>(`SELECT details::text AS d FROM env_default.ab_action_runs WHERE connection_id = $1`, [connId])
    expect(act.map((x) => x.d).join(' ')).not.toContain('0000000011')
  })

  it('the webhook: handshake, signatures, replay, status updates, STOP / START (Hindi too), other numbers ignored', async () => {
    const base = `${h.base}/api/v1/whatsapp/webhook/default/${connId}`
    const ok = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=${MOCK_VERIFY_TOKEN}&hub.challenge=1158201444`)
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('1158201444')
    expect((await fetch(`${base}?hub.mode=subscribe&hub.verify_token=wrong-token-xxxxxxxxx&hub.challenge=1`)).status).toBe(403)
    expect((await fetch(`${h.base}/api/v1/whatsapp/webhook/default/conn_nope?hub.mode=subscribe&hub.verify_token=${MOCK_VERIFY_TOKEN}&hub.challenge=1`)).status).toBe(404)
    // a status update for the flow's message
    const msg = (await log()).find((m: any) => m.direction === 'out' && m.status === 'accepted' && m.phone === A_NUM)!
    const now = Date.now()
    // forged, missing, wrong-secret signatures change nothing
    expect((await hook(statusEvent(msg.provider_id, 'read', A_NUM), { sig: 'sha256=' + '0'.repeat(64) })).status).toBe(401)
    expect((await hook(statusEvent(msg.provider_id, 'read', A_NUM), { sig: null })).status).toBe(401)
    expect((await hook(statusEvent(msg.provider_id, 'read', A_NUM), { secret: 'another-app-secret-0000' })).status).toBe(401)
    expect((await h.q<any>('SELECT status FROM env_default.ab_whatsapp_messages WHERE id = $1', [msg.id]))[0].status).toBe('accepted')
    const sentEv = statusEvent(msg.provider_id, 'sent', A_NUM, { at: now - 3000 })
    expect((await hook(sentEv)).data).toMatchObject({ ok: true, statuses: 1 })
    expect((await hook(statusEvent(msg.provider_id, 'read', A_NUM, { at: now - 1000 }))).data.statuses).toBe(1)
    // a late "delivered" does not move "read" back; it is still in the history
    expect((await hook(statusEvent(msg.provider_id, 'delivered', A_NUM, { at: now - 2000 }))).data.statuses).toBe(1)
    const row = (await h.q<any>('SELECT status, history FROM env_default.ab_whatsapp_messages WHERE id = $1', [msg.id]))[0]
    expect(row.status).toBe('read')
    expect(row.history.map((x: any) => x.status)).toEqual(['sending', 'accepted', 'sent', 'read', 'delivered'])
    // replay: the same signed delivery again is acknowledged and ignored
    expect((await hook(sentEv)).data).toEqual({ ok: true, duplicate: true })
    // not JSON
    expect((await hook({ a: 1 }, { type: 'text/plain' })).status).toBe(415)
    // a failed status keeps Meta's error
    const f = (await log()).filter((m: any) => m.direction === 'out' && m.status === 'accepted').at(-1)!
    await hook(statusEvent(f.provider_id, 'failed', A_NUM, { error: { code: 131047, title: 'Re-engagement message', details: 'More than 24 hours have passed' } }))
    expect((await h.q<any>('SELECT status, error_code FROM env_default.ab_whatsapp_messages WHERE id = $1', [f.id]))[0]).toEqual({ status: 'failed', error_code: '131047' })

    // STOP: C opts in, then writes STOP; sending is refused afterwards; the full history is kept
    await A().post('/whatsapp/optins', { phone: C_NUM, status: 'opted_in', source: 'import', evidence: 'Customer list export from the old system, consent column = yes' })
    await sleep(20)
    expect((await hook(inboundEvent(C_NUM, 'Stop'))).data).toMatchObject({ inbound: 1, optedOut: 1 })
    const st = (await A().get(`/whatsapp/optins?search=0000000013`)).data.items[0]
    expect(st).toMatchObject({ phone: C_NUM, status: 'opted_out', source: 'inbound keyword', recordedBy: 'whatsapp-webhook' })
    expect(st.evidence).toMatch(/Sent "STOP"/)
    const before = mock.sent.length
    expect((await runAction('sendTemplate', { to: C_NUM, template: 'order_update', bodyParams: ['a', 'b', 'c'] })).ok).toBe(false)
    expect(mock.sent.length).toBe(before)
    // START opts in again; a Hindi stop word opts out again
    await sleep(1100)
    expect((await hook(inboundEvent(C_NUM, 'START'))).data.optedIn).toBe(1)
    await sleep(1100)
    expect((await hook(inboundEvent(C_NUM, 'बंद करो'))).data.optedOut).toBe(1)
    const hist = (await A().get(`/whatsapp/optins/${encodeURIComponent(C_NUM)}/history`)).data.items
    expect(hist.map((x: any) => `${x.status}:${x.source}`)).toEqual(['opted_out:inbound keyword', 'opted_in:inbound keyword', 'opted_out:inbound keyword', 'opted_in:import'])
    // an old message (replayed or delayed) never changes a newer consent record
    expect((await hook(inboundEvent(C_NUM, 'START', { at: Date.now() - 3600_000 }))).data.optedIn).toBe(0)
    // events of another WhatsApp number of the same app are ignored
    expect((await hook(inboundEvent(B_NUM, 'START', { phoneNumberId: '999999999999' }))).data).toMatchObject({ ignored: 1, inbound: 0 })
    expect((await A().get(`/whatsapp/optins?search=0000000012`)).data.items).toEqual([])
    // inbound messages are logged without their text
    const inbound = (await log()).filter((m: any) => m.direction === 'in')
    expect(inbound.length).toBeGreaterThanOrEqual(4)
    expect(JSON.stringify(inbound)).not.toMatch(/Where is my order/)
  })

  it('administrators only: the opt-in list, history and message log; makers can check opt-ins through the action', async () => {
    for (const p of ['/whatsapp/optins', '/whatsapp/messages', '/whatsapp/settings', `/whatsapp/optins/${encodeURIComponent(A_NUM)}/history`]) {
      expect((await maker.get(p)).status, p).toBe(403)
      expect((await nina.get(p)).status, p).toBe(403)
    }
    expect((await A().get('/whatsapp/messages?limit=5')).data.items.length).toBe(5)
    // a maker with "use" checks an opt-in and records one with evidence (source "administrator" refused)
    await put(A(), `/connections/${connId}/access`, { grants: [{ principalKind: 'user', principalId: 'user_mia', level: 'use' }] })
    const chk = await maker.post(`/connections/${connId}/actions/checkOptIn/test`, { inputs: { to: A_NUM } })
    expect(chk.data.output).toMatchObject({ optedIn: true, status: 'opted_in', to: '+91 •••••••011' })
    const adm = await maker.post(`/connections/${connId}/actions/recordOptIn/test`, { inputs: { to: '+910000000014', status: 'opted_in', source: 'administrator', evidence: 'I am pretending to be an administrator' } })
    expect(adm.data.ok).toBe(false)
    const rec = await maker.post(`/connections/${connId}/actions/recordOptIn/test`, { inputs: { to: '+910000000014', status: 'opted_in', source: 'form', evidence: 'Web form "Contact us", WhatsApp box ticked' } })
    expect(rec.data.ok, JSON.stringify(rec.data)).toBe(true)
    const h14 = (await A().get(`/whatsapp/optins/${encodeURIComponent('+910000000014')}/history`)).data.items
    expect(h14[0]).toMatchObject({ source: 'form', recordedBy: 'user_mia', connectionId: connId })
    // bulk import with problems: nothing imported
    const bad = await A().post('/whatsapp/optins/import', { evidence: 'Import from the CRM, consent column', rows: [{ phone: '+910000000015' }, { phone: 'abc' }] })
    expect(bad.data).toMatchObject({ imported: 0 })
    const good = await A().post('/whatsapp/optins/import', { evidence: 'Import from the CRM, consent column', rows: [{ phone: '+910000000015' }, '+91 00000 00016'] })
    expect(good.data).toMatchObject({ imported: 2 })
    // the list templates action reads from the mock
    const lt = await runAction('listTemplates', {})
    expect(lt.ok && (lt.output as any).templates.map((t: any) => `${t.name}:${t.language}`)).toEqual(['order_update:en', 'order_update:hi', 'appbuilder_alert:en'])
  })

  it('notification channel: offered only with a mapping, an approved template and an opt-in; quiet hours hold it', async () => {
    // not offered yet: no mapping
    let me = (await nina.get('/whatsapp/me')).data
    expect(me).toMatchObject({ offered: false, canOptIn: false })
    expect(me.reason).toMatch(/not set up WhatsApp notifications/)
    expect((await put(nina, '/whatsapp/me', { kinds: { flow: true } })).status).toBe(409)
    // the mapping needs an approved template with as many values as chosen
    expect((await put(A(), '/whatsapp/settings', { notifications: { connectionId: connId, template: 'festival_offer', language: 'en', params: ['title', 'body'] } })).data.error.message).toMatch(/pending/)
    expect((await put(A(), '/whatsapp/settings', { notifications: { connectionId: connId, template: 'appbuilder_alert', language: 'en', params: ['title'] } })).data.error.message).toMatch(/2 body value/)
    const ok = await put(A(), '/whatsapp/settings', { notifications: { connectionId: connId, template: 'appbuilder_alert', language: 'en', params: ['title', 'body'] } })
    expect(ok.status, JSON.stringify(ok.data)).toBe(200)
    me = (await nina.get('/whatsapp/me')).data
    expect(me).toMatchObject({ offered: false, canOptIn: true, phone: '+91 •••••••021', optedIn: false })
    expect((await put(nina, '/whatsapp/me', { kinds: { flow: true } })).status).toBe(409)
    // the person opts in their own number (consent required)
    expect((await nina.post('/whatsapp/me/opt-in', {})).status).toBe(422)
    me = (await nina.post('/whatsapp/me/opt-in', { consent: true })).data
    expect(me).toMatchObject({ offered: true, optedIn: true })
    me = (await put(nina, '/whatsapp/me', { kinds: { flow: true } })).data
    expect(me.kinds).toEqual({ flow: true })
    // a notification goes out on WhatsApp through the template
    const before = mock.sent.length
    await h.app.services.notifications!.notify({ userIds: ['user_nina'] }, { kind: 'flow', title: 'Machine 4 stopped', body: 'Line 2\nneeds a look', environmentId: 'default', source: 'flow:test' })
    await drain()
    expect(mock.sent.length).toBe(before + 1)
    expect(mock.sent.at(-1)).toMatchObject({ to: '910000000021', template: { name: 'appbuilder_alert', body: ['Machine 4 stopped', 'Line 2 needs a look'] } })
    const dl = await h.q<any>(`SELECT status, reason FROM ab.notification_deliveries WHERE user_id = 'user_nina' AND channel = 'whatsapp' ORDER BY at DESC LIMIT 1`)
    expect(dl[0].status).toBe('sent')
    // a kind not chosen: nothing on WhatsApp
    await h.app.services.notifications!.notify({ userIds: ['user_nina'] }, { kind: 'app', title: 'An app message', environmentId: 'default', source: 'app:x' })
    await drain()
    expect(mock.sent.length).toBe(before + 1)
    // quiet hours: held until they end (a delayed job)
    await h.app.services.notifications!.saveSettings('user_nina', { kinds: {}, desktop: false, hidePresence: false, dnd: { start: '00:00', end: '23:59' }, timeZone: 'UTC' })
    await h.app.services.notifications!.notify({ userIds: ['user_nina'] }, { kind: 'flow', title: 'Night alert', environmentId: 'default', source: 'flow:test' })
    await drain()
    expect(mock.sent.length).toBe(before + 1)
    const held = await h.q<any>(`SELECT status, reason FROM ab.notification_deliveries WHERE user_id = 'user_nina' AND channel = 'whatsapp' ORDER BY at DESC LIMIT 1`)
    expect(held[0]).toMatchObject({ status: 'queued' })
    expect(held[0].reason).toMatch(/do-not-disturb/)
    const job = await h.q<any>(`SELECT state, run_at FROM env_default.ab_jobs WHERE type = 'whatsapp.notify' ORDER BY created_on DESC LIMIT 1`)
    expect(new Date(job[0].run_at).getTime()).toBeGreaterThan(Date.now())
    // opting out (here by STOP) stops the channel; the held job then sends nothing
    await h.app.services.notifications!.saveSettings('user_nina', { kinds: {}, desktop: false, hidePresence: false, dnd: null })
    await sleep(1100)
    await hook(inboundEvent('+910000000021', 'STOP'))
    me = (await nina.get('/whatsapp/me')).data
    expect(me).toMatchObject({ offered: false, optedIn: false })
    await h.q(`UPDATE env_default.ab_jobs SET run_at = now() WHERE type = 'whatsapp.notify' AND state = 'queued'`)
    await drain()
    expect(mock.sent.length).toBe(before + 1)
    const last = await h.q<any>(`SELECT status, reason FROM ab.notification_deliveries WHERE user_id = 'user_nina' AND channel = 'whatsapp' ORDER BY at DESC LIMIT 1`)
    expect(last[0].status).toBe('skipped')
    expect(last[0].reason).toMatch(/no WhatsApp opt-in/)
  })

  it('environment copies arrive without opt-ins, log, mapping or secrets', async () => {
    const env = await A().post('/environments', { name: 'WA copy', type: 'sandbox', copyFrom: 'default' })
    expect(env.status, JSON.stringify(env.data)).toBe(200)
    const schema = `env_${env.data.id}`
    for (const t of ['ab_whatsapp_optins', 'ab_whatsapp_optin_history', 'ab_whatsapp_messages', 'ab_whatsapp_settings', 'ab_whatsapp_prefs', 'ab_whatsapp_windows']) {
      expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM "${schema}"."${t}"`))[0]!.n, t).toBe(0)
    }
    const c = (await h.q<any>(`SELECT secret_sealed, status FROM "${schema}".ab_connections WHERE id = $1`, [connId]))[0]
    expect(c).toMatchObject({ secret_sealed: null, status: 'not-configured' })
    // and its webhook refuses calls (no app secret in the copy)
    const raw = JSON.stringify(inboundEvent(A_NUM, 'hi'))
    const r = await fetch(`${h.base}/api/v1/whatsapp/webhook/${env.data.id}/${connId}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signMeta(MOCK_APP_SECRET, raw) }, body: raw })
    expect(r.status).toBe(401)
  })

  it('schema 12 -> 13: the WhatsApp tables appear, nothing else changes', async () => {
    const flows = (await h.q<{ n: number }>('SELECT count(*)::int AS n FROM env_default.ab_flows'))[0]!.n
    await h.q('DROP TABLE env_default.ab_whatsapp_optins, env_default.ab_whatsapp_optin_history, env_default.ab_whatsapp_messages, env_default.ab_whatsapp_windows, env_default.ab_whatsapp_prefs, env_default.ab_whatsapp_settings, env_default.ab_whatsapp_hook_seen')
    await h.q(`UPDATE ab.environments SET schema_version = 12 WHERE id = 'default'`)
    const { migrateEnvironmentSchema, SCHEMA_VERSION } = await import('../meta-store.ts')
    expect(SCHEMA_VERSION).toBe(13)
    expect(await migrateEnvironmentSchema(h.app.services.state.db!, { id: 'default', schema: 'env_default' })).toEqual({ from: 12, to: 13 })
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'env_default' AND table_name LIKE 'ab_whatsapp_%'`))[0]!.n).toBe(7)
    expect((await h.q<{ n: number }>('SELECT count(*)::int AS n FROM env_default.ab_flows'))[0]!.n).toBe(flows)
    // the upgrade step refuses a schema that lost a table (downgrade guard)
    const { upgradeEnvironmentTo13Whatsapp } = await import('./ddl.ts')
    await h.q('DROP TABLE env_default.ab_whatsapp_hook_seen')
    await expect(upgradeEnvironmentTo13Whatsapp(h.app.services.state.db!, 'env_default')).rejects.toThrow(/ab_whatsapp_hook_seen is missing/)
  })
})
