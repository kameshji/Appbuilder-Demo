#!/usr/bin/env node
/**
 * Phase 2 exit check 6 (docs/plan/p2-spec.md): "A WhatsApp message (template message) is sent from a flow through the
 * connector against a recorded mock of the provider API; opt-in is recorded; nothing is sent without opt-in."
 * DEVELOPER TOOL (sandbox values only), not part of the product. Re-runnable. Never contacts Meta: the Graph API is the fake
 * of server/core/whatsapp/mock-graph.ts (shapes modelled on Meta's documentation; nothing recorded from a real account),
 * swapped in with setGraphBaseForTests in this process. Numbers are fake (+91 00000 0000x).
 *
 *   node scripts/exit-check/p2-whatsapp.mjs
 *
 * Against a server started in this process (HTTP on 127.0.0.1:EXIT_PORT) on an EMPTY database (created and dropped here):
 *  1. an administrator creates the WhatsApp connection (no address setting exists; a base-address setting is refused);
 *  2. a send to a number WITHOUT an opt-in is refused, by a flow and by the Test action form; nothing reaches the mock;
 *  3. the opt-in is recorded (with evidence) and a flow with the `action` step sends a template message to the mock
 *     through the real flow engine; the message log has Meta's message id and the flow's idempotency key; a second run of
 *     the same step key does not send again;
 *  4. a signed status webhook (delivered) updates the message log; a forged signature is refused (401) and changes nothing;
 *  5. an inbound STOP (signed webhook) opts the number out; the next flow run is refused and nothing is sent.
 *
 * Settings: EXIT_DB_HOST (127.0.0.1), EXIT_DB_PORT (5435), EXIT_DB_USER (abdev), EXIT_DB_PASSWORD (abdev-sandbox-only),
 * EXIT_DB_NAME (ab_e1; dropped and created), EXIT_MAINT_DB (appbuilder_test), EXIT_PORT (5193), EXIT_WORKSPACE
 * (.sandbox/e1/workspace), KEEP=1 keeps the database. Prints PASS/FAIL lines and a summary; exit code 1 when a check fails.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const DB = { host: E.EXIT_DB_HOST || '127.0.0.1', port: Number(E.EXIT_DB_PORT || 5435), user: E.EXIT_DB_USER || 'abdev', password: E.EXIT_DB_PASSWORD || 'abdev-sandbox-only', database: E.EXIT_DB_NAME || 'ab_e1' }
const MAINT = E.EXIT_MAINT_DB || 'appbuilder_test'
const PORT = Number(E.EXIT_PORT || 5193)
const BASE = `http://127.0.0.1:${PORT}`
const WORKSPACE = path.resolve(root, E.EXIT_WORKSPACE || path.join('.sandbox', 'e1', 'workspace'))
const ADMIN = { name: 'Exit Admin', email: 'exit@example.test', password: 'Exit-Example-Pass-2026' }
if (PORT === 5174 || DB.port === 5433) { console.error('Refusing to touch ports 5174 / 5433 (a real install).'); process.exit(2) }
if (!/^(ab_e1|appbuilder_exit.*)$/.test(DB.database)) { console.error('The exit-check database must be ab_e1 or start with appbuilder_exit (it is dropped).'); process.exit(2) }

const imp = (p) => import(pathToFileURL(path.join(root, p)).href)
const { createApp } = await imp('server/core/app.ts')
const { serveStatic } = await imp('server/core/static.ts')
const { setQuiet } = await imp('server/core/util.ts').catch(() => ({ setQuiet: null }))
const { Client } = await imp('server/core/kernel-testkit.ts')
const { setGraphBaseForTests } = await imp('server/core/whatsapp/graph.ts')
const { signMeta } = await imp('server/core/whatsapp/webhook.ts')
const mockMod = await imp('server/core/whatsapp/mock-graph.ts')
const { MOCK_APP_SECRET, MOCK_PHONE_NUMBER_ID, MOCK_TOKEN, MOCK_VERIFY_TOKEN, MOCK_WABA_ID, startMockGraph, statusEvent, inboundEvent } = mockMod
if (setQuiet) setQuiet(true)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`)
const results = []
const record = (name, ok, evidence = '') => { results.push({ name, ok, evidence }); log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence ? `: ${evidence}` : ''}`) }
const check = (cond, name, evidence) => { record(name, !!cond, evidence); if (!cond) throw new Error(`check failed: ${name} ${evidence ?? ''}`) }

async function maint(sql) {
  const c = new pg.Client({ ...DB, database: MAINT })
  await c.connect()
  try { await c.query(sql) } finally { await c.end() }
}
async function q(sql, params = []) {
  const c = new pg.Client(DB)
  await c.connect()
  try { return (await c.query(sql, params)).rows } finally { await c.end() }
}

let app = null
let server = null
let mock = null
async function start() {
  fs.mkdirSync(WORKSPACE, { recursive: true })
  app = await createApp({ env: { APPBUILDER_MIGRATION_BACKUP: 'skip' }, config: { workspaceDir: WORKSPACE }, printSetupCode: false, jobs: true })
  const dist = app.config.distDir ?? path.join(root, 'dist')
  server = http.createServer((req, res) => { app.handle(req, res).then((h) => { if (h) return; if (fs.existsSync(path.join(dist, 'index.html'))) serveStatic(dist, req, res); else res.writeHead(404).end() }, () => { if (!res.headersSent) res.writeHead(500); res.end() }) })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
}
async function stop() {
  if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(() => r())) }
  if (app) await app.close()
}
const admin = new Client(BASE)
async function api(method, p, body) {
  const r = await admin.req(method, p, body)
  if (r.status !== 200) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`)
  return r.data
}
async function waitRun(runId) {
  for (let i = 0; i < 160; i++) {
    const r = (await api('GET', `/flows/runs/${runId}`)).run
    if (!['queued', 'running', 'waiting'].includes(r.status)) return r
    await sleep(250)
  }
  throw new Error(`flow run ${runId} did not finish`)
}
async function hook(connId, payload, sig) {
  const raw = JSON.stringify(payload)
  const res = await fetch(`${BASE}/api/v1/whatsapp/webhook/default/${connId}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig ?? signMeta(MOCK_APP_SECRET, raw) }, body: raw })
  return { status: res.status, data: await res.json().catch(() => null) }
}

const A_NUM = '+910000000001'
const B_NUM = '+910000000002'
const settings = { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' }

let failed = false
try {
  await maint(`DROP DATABASE IF EXISTS "${DB.database}"`)
  fs.rmSync(WORKSPACE, { recursive: true, force: true })
  mock = await startMockGraph()
  setGraphBaseForTests(mock.url)
  await start()
  const setupCode = app.services.setupCode.current() ?? ''
  await api('POST', '/setup/database', { setupCode, host: DB.host, port: DB.port, database: DB.database, user: DB.user, password: DB.password, createDatabase: true })
  await api('POST', '/setup/admin', { setupCode, ...ADMIN })
  await api('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password })

  log('1. the WhatsApp connection')
  const cs = { phoneNumberId: MOCK_PHONE_NUMBER_ID, businessAccountId: MOCK_WABA_ID, defaultCountryCode: '91' }
  const secret = JSON.stringify({ accessToken: MOCK_TOKEN, appSecret: MOCK_APP_SECRET, verifyToken: MOCK_VERIFY_TOKEN })
  const ssrf = await admin.req('POST', '/connections', { name: 'WA with address', connector: 'whatsapp', settings: { ...cs, baseUrl: 'http://127.0.0.1:1' }, secret })
  check(ssrf.status === 422, 'a base-address setting on a WhatsApp connection is refused (the address of Meta\'s API is fixed)', `${ssrf.status}`)
  const conn = await api('POST', '/connections', { name: 'WhatsApp', connector: 'whatsapp', settings: cs, secret })
  check(conn.status === 'connected' && !JSON.stringify(conn).includes(MOCK_TOKEN), 'the connection is created and tested against the mock; its secrets are not returned', conn.status)
  const flowDef = (name, to) => ({
    name, settings, enabled: true, trigger: { type: 'manual', inputs: [], from: 'any' }, connections: { wa: conn.id },
    steps: [{ id: 'send', name: 'Send', kind: 'action', connection: 'wa', action: 'sendTemplate', inputs: { to: `"${to}"`, template: '"order_update"', language: '"en"', bodyParams: '["Asha", "SO-1001", "shipped"]' } }],
  })

  log('2. without an opt-in nothing is sent')
  const noConsent = (await api('POST', '/flows', flowDef('Order update (no consent)', B_NUM))).flow
  const r0 = await waitRun((await api('POST', `/flows/${noConsent.id}/run`, {})).runId)
  check(r0.status === 'failed' && /no current WhatsApp opt-in/.test(JSON.stringify(r0.steps)), 'a flow sending to a number without an opt-in fails with the reason', r0.status)
  const t = await api('POST', `/connections/${conn.id}/actions/sendTemplate/test`, { inputs: { to: B_NUM, template: 'order_update', bodyParams: ['a', 'b', 'c'] } })
  check(t.ok === false && t.error.code === 'denied', 'the Test action form is refused the same way', t.error?.code)
  check(mock.sent.length === 0, 'nothing reached the (mock) provider', `${mock.sent.length} sent`)

  log('3. opt-in recorded, then the flow sends the template message')
  const o = await api('POST', '/whatsapp/optins', { phone: '+91 00000 00001', status: 'opted_in', source: 'form', evidence: 'Ticked "Send me order updates on WhatsApp" on order form SO-1001' })
  check(o.optIn.status === 'opted_in' && o.optIn.phone === A_NUM, 'the opt-in is recorded with source, evidence, who and when', `${o.optIn.source}, ${o.optIn.recordedOn}`)
  const flow = (await api('POST', '/flows', flowDef('Order update', A_NUM))).flow
  const runId = (await api('POST', `/flows/${flow.id}/run`, {})).runId
  const r1 = await waitRun(runId)
  const sent = mock.sent.at(-1)
  check(r1.status === 'succeeded' && mock.sent.length === 1 && sent.type === 'template' && sent.template.name === 'order_update' && sent.to === '910000000001' && sent.template.body.join('|') === 'Asha|SO-1001|shipped',
    'a flow with the action step sent the template message to the mock through the real engine', `${sent?.template?.name} to ${sent?.to}: ${sent?.template?.body?.join(', ')}`)
  const row = (await q('SELECT * FROM env_default.ab_whatsapp_messages WHERE provider_id = $1', [sent.id]))[0]
  check(row && row.status === 'accepted' && row.idempotency_key === `${runId}:/send` && row.source === `flow:${flow.id}`, 'the message log has Meta\'s message id, the flow run\'s idempotency key and the flow', `${row?.provider_id?.slice(0, 20)}..., key ${row?.idempotency_key}`)
  const again = await app.services.actions.run('default', conn.id, 'sendTemplate', { to: A_NUM, template: 'order_update', bodyParams: ['Asha', 'SO-1001', 'shipped'] }, null, { idempotencyKey: `${runId}:/send`, source: `flow:${flow.id}` })
  check(again.ok && again.replayed && mock.sent.length === 1, 'a retry of the same step (same key) returns the stored result and does not send again', `replayed=${again.replayed}`)

  log('4. status webhook and a forged signature')
  const ev = statusEvent(sent.id, 'delivered', A_NUM)
  const forged = await hook(conn.id, ev, 'sha256=' + '0'.repeat(64))
  const still = (await q('SELECT status FROM env_default.ab_whatsapp_messages WHERE id = $1', [row.id]))[0].status
  check(forged.status === 401 && still === 'accepted', 'a webhook call with a forged signature is refused and changes nothing', `${forged.status}, status ${still}`)
  const ok = await hook(conn.id, ev)
  const after = (await q('SELECT status, history FROM env_default.ab_whatsapp_messages WHERE id = $1', [row.id]))[0]
  check(ok.status === 200 && after.status === 'delivered', 'a signed status webhook updates the message log', `${after.history.map((h) => h.status).join(' > ')}`)

  log('5. inbound STOP opts the number out')
  const stopRes = await hook(conn.id, inboundEvent(A_NUM, 'STOP'))
  const cur = (await api('GET', '/whatsapp/optins?search=0000000001')).items[0]
  check(stopRes.status === 200 && cur.status === 'opted_out' && cur.source === 'inbound keyword', 'an inbound STOP opted the number out (history kept)', `${cur.status} by ${cur.source}: ${cur.evidence.slice(0, 60)}...`)
  const hist = (await api('GET', `/whatsapp/optins/${encodeURIComponent(A_NUM)}/history`)).items
  check(hist.length === 2, 'the opt-in history keeps both entries', hist.map((h) => `${h.status}:${h.source}`).join(', '))
  const r2 = await waitRun((await api('POST', `/flows/${flow.id}/run`, {})).runId)
  check(r2.status === 'failed' && mock.sent.length === 1, 'after STOP the flow is refused and nothing more is sent', `${r2.status}, ${mock.sent.length} sent in all`)
  const dump = (await q(`SELECT (SELECT coalesce(string_agg(r::text, ' '), '') FROM env_default.ab_action_runs r) || (SELECT coalesce(string_agg(m::text, ' '), '') FROM env_default.ab_whatsapp_messages m) || (SELECT coalesce(string_agg(a::text, ' '), '') FROM env_default.ab_audit a) AS t`))[0].t
  check(![MOCK_TOKEN, MOCK_APP_SECRET, MOCK_VERIFY_TOKEN].some((s) => dump.includes(s)), 'no access token, app secret or verify token in the activity, message log or audit', '')
} catch (e) {
  failed = true
  console.error(e)
} finally {
  setGraphBaseForTests(null)
  await stop().catch(() => undefined)
  await mock?.close().catch(() => undefined)
  if (!E.KEEP) await maint(`DROP DATABASE IF EXISTS "${DB.database}"`).catch((e) => console.error(`could not drop ${DB.database}: ${e.message}`))
}
const bad = results.filter((r) => !r.ok)
console.log(`\n${results.length - bad.length}/${results.length} checks passed${failed || bad.length ? ' - EXIT CHECK 6 FAILED' : ' - EXIT CHECK 6 PASSED'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
process.exit(failed || bad.length ? 1 : 0)
