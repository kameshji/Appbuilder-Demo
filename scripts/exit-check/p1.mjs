#!/usr/bin/env node
/**
 * Phase 1 exit check (docs/plan/p1-spec.md "Exit check") against a server started here on an EMPTY database. DEVELOPER
 * TOOL (sandbox values only), not part of the product. Needs the built app (npm run build), puppeteer-core and Chrome.
 *
 *   node scripts/exit-check/p1.mjs                     everything
 *   EXIT_SKIP=designer,suites node scripts/exit-check/p1.mjs
 *
 *  (1) the purchase approval flow over a simulated week with two server restarts: the flow clock can only be moved
 *      in-process, so this runs the integration tests that do exactly that (approvals-exit.integration.test.ts with the
 *      real approvals service, and flows-durability "exit check 1") and reports their result.
 *  (2) the click-only designer script (scripts/exit-check/p1-designer.mjs, its own server and database).
 *  (3) approvals answered from the inbox page, the bell and an email link (fake SMTP relay), a delegation (the deputy
 *      answers) and an escalation (the flow clock moves past the due date; the manager's manager answers), in a headless
 *      browser as each person.
 *  (4) a scheduled report (daily, 07:00) run now: every recipient gets an email with the table and a CSV; a recipient
 *      who may read only their own rows gets only those.
 *  (5) a solution with two flows (one uses an HTTP connection), an approval policy naming people and the connection
 *      reference, deployed to a second environment from the Deploy dialog: the plan screen asks for the target
 *      connection (blocked until chosen) and for the person without an account there; checked in the target afterwards.
 *  (6) a restricted maker's flow reads and writes only what the maker may; a service-account run-as needs an
 *      administrator's confirmation and is audited.
 *  (7) docs: the link checker (scripts/docs-links.test.ts) and the required pages.
 *  Also: Admin console > Flows shows the kill switch's state and pauses all flows (gap i); the recycle bin (r): a deleted
 *  row is out of queries, its owner sees and restores it, nobody else does.
 *
 * Settings: EXIT_DB_HOST (127.0.0.1), EXIT_DB_PORT (5433), EXIT_DB_USER (abdev), EXIT_DB_PASSWORD (abdev-sandbox-only),
 * EXIT_DB_NAME (appbuilder_exit_p1, dropped before and after unless KEEP=1), EXIT_MAINT_DB (appbuilder_test), EXIT_PORT
 * (5264), PUPPETEER_CORE, CHROME_PATH, EXIT_SKIP (designer, suites, browser). Prints a Markdown table; exit code 1 when a
 * check fails.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { chromePath, puppeteerCorePath } from './browser-env.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const DB = { host: E.EXIT_DB_HOST || '127.0.0.1', port: Number(E.EXIT_DB_PORT || 5433), user: E.EXIT_DB_USER || 'abdev', password: E.EXIT_DB_PASSWORD || 'abdev-sandbox-only', database: E.EXIT_DB_NAME || 'appbuilder_exit_p1' }
const MAINT = E.EXIT_MAINT_DB || 'appbuilder_test'
const PORT = Number(E.EXIT_PORT || 5264)
const BASE = `http://127.0.0.1:${PORT}`
const SKIP = new Set((E.EXIT_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean))
const ADMIN = { name: 'Exit Admin', email: 'exit@example.test', password: 'Exit-Example-Pass-2026' }
const PASS = 'Exit-Example-Pass-2027'
if (!/^appbuilder_exit/.test(DB.database)) { console.error('The exit-check database name must start with appbuilder_exit (it is dropped).'); process.exit(2) }
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) { console.error('Build the app first (npm run build).'); process.exit(2) }

const { createApp } = await import(pathToFileURL(path.join(root, 'server/core/app.ts')).href)
const { serveStatic } = await import(pathToFileURL(path.join(root, 'server/core/static.ts')).href)
const { runInEnvironment } = await import(pathToFileURL(path.join(root, 'server/core/env-context.ts')).href)
const { setQuiet } = await import(pathToFileURL(path.join(root, 'server/core/util.ts')).href)
const { startFakeSmtp } = await import(pathToFileURL(path.join(root, 'server/core/identity/fake-smtp.ts')).href)
const { default: puppeteer } = await import(pathToFileURL(path.join(puppeteerCorePath(root, E), 'lib/puppeteer/puppeteer-core.js')).href)
setQuiet(true)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`)
const results = []
const record = (n, name, ok, evidence) => { results.push({ n, name, ok, evidence }); log(`${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'} (${n}) ${name}: ${evidence}`) }
const need = (cond, what) => { if (!cond) throw new Error(`not as expected: ${what}`) }

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

// vitest through node itself: `npx` is a .cmd file on Windows and cannot be started without a shell
const VITEST = path.join(root, 'node_modules', 'vitest', 'vitest.mjs')
/** a child process with its output; resolves with the exit code */
function run(cmd, args, env = {}, timeoutMs = 30 * 60_000) {
  return new Promise((resolve) => {
    let outText = ''
    const p = spawn(cmd, args, { cwd: root, env: { ...E, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    p.stdout.on('data', (d) => { outText += d })
    p.stderr.on('data', (d) => { outText += d })
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs)
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out: outText }) })
  })
}
// eslint-disable-next-line no-control-regex
const plain = (s) => s.replace(/\u001b\[[0-9;]*m/g, '')

/* ------------------------------------------------------------------ the server, in this process (the flow clock) */

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-exit-p1-'))
let app = null
let server = null
let now = new Date('2030-03-04T09:00:00Z')
async function start() {
  app = await createApp({ env: { APPBUILDER_DB_HOST: DB.host, APPBUILDER_DB_PORT: String(DB.port), APPBUILDER_DB_NAME: DB.database, APPBUILDER_DB_USER: DB.user, APPBUILDER_DB_PASSWORD: DB.password, APPBUILDER_MIGRATION_BACKUP: 'skip' }, config: { workspaceDir: DIR }, printSetupCode: false, jobs: true })
  server = http.createServer((req, res) => { app.handle(req, res).then((h) => { if (!h) serveStatic(path.join(root, 'dist'), req, res) }, () => { if (!res.headersSent) res.writeHead(500); res.end() }) })
  server.on('upgrade', (req, socket, head) => { if (!app.handleUpgrade(req, socket, head)) socket.destroy() })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
}
async function stop() {
  if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(() => r())) }
  if (app) await app.close()
  server = null
  app = null
}
const inEnv = (fn, env = 'default') => runInEnvironment(env, fn)
async function settle() {
  for (let i = 0; i < 8; i++) {
    await app.services.kernel.drain({ timeoutMs: 60_000 })
    const n = await inEnv(() => app.services.flows.sweep(true))
    const t = app.services.approvals ? await inEnv(() => app.services.approvals.tick(true)) : { escalations: 0, reminders: 0, delegations: 0 }
    if (!n && !t.escalations && !t.reminders && !t.delegations) break
  }
  await app.services.kernel.drain({ timeoutMs: 60_000 })
}

function jar() {
  let cookie = ''
  const api = async (method, p, body, o = {}) => {
    const res = await fetch(BASE + '/api/v1' + p, { method, headers: { 'X-Appbuilder': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(o.env ? { 'X-Appbuilder-Environment': o.env } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const c of res.headers.getSetCookie?.() ?? []) { const [pair] = c.split(';'); if (pair.startsWith('ab_session=')) cookie = pair }
    const data = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : await res.text()
    if (!res.ok && !o.allowError) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(data).slice(0, 400)}`)
    return o.allowError ? { status: res.status, data } : data
  }
  return api
}
const admin = jar()
const people = {}
async function person(name, email, extra = {}) {
  const u = await admin('POST', '/users', { name, email, roleIds: ['role_maker'], password: 'Temporary-Pass-1234', ...extra })
  const me = jar()
  await me('POST', '/auth/login', { email, password: 'Temporary-Pass-1234' })
  await me('POST', '/auth/password', { current: 'Temporary-Pass-1234', next: PASS })
  people[email] = { id: u.id, api: me, email }
  return people[email]
}

/* ------------------------------------------------------------------ browser */

let browser = null
async function tab(email) {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  page.on('dialog', (d) => d.accept())
  await page.goto(`${BASE}/#home`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-testid="login-form"]', { visible: true, timeout: 20000 })
  await page.type('[data-testid="login-email"]', email)
  await page.type('[data-testid="login-password"]', email === ADMIN.email ? ADMIN.password : PASS)
  await page.click('[data-testid="login-submit"]')
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-form"]'), { timeout: 20000 })
  return page
}
const T = (id) => `[data-testid="${id}"]`
async function click(page, sel, timeout = 20000) { await page.waitForSelector(`${sel}:not([disabled])`, { visible: true, timeout }); await page.click(sel) }
async function status(id) { return (await admin('GET', `/approvals/${id}`)).request.status }
async function waitStatus(id, want, ms = 20000) {
  const end = Date.now() + ms
  for (;;) {
    await settle()
    const s = await status(id)
    if (s === want) return s
    if (Date.now() > end) throw new Error(`request ${id} is ${s}, expected ${want}`)
    await sleep(300)
  }
}
async function answerOnPage(page, id, label = 'Approve') {
  await page.waitForSelector(T('approval-detail'), { visible: true, timeout: 20000 })
  await click(page, T(`approval-answer-${label}`))
  await waitStatus(id, label === 'Approve' ? 'approved' : 'rejected')
}

/* ------------------------------------------------------------------ (3) approvals in the browser */

let smtp = null
async function checkApprovals() {
  const notes = []
  try {
    const mona = await person('Mona Manager', 'mona@example.test')
    const dev = await person('Dev Director', 'dev@example.test')
    await admin('PATCH', `/users/${mona.id}`, { managerId: dev.id })
    const raj = await person('Raj Requester', 'raj@example.test')
    await admin('PATCH', `/users/${raj.id}`, { managerId: mona.id })
    const dee = await person('Dee Deputy', 'dee@example.test')
    const ask = (title, extra = {}) => raj.api('POST', '/approvals', { approvers: 'mona@example.test', title, ...extra })
    const page = await tab('mona@example.test')

    // a. the inbox page
    const a = await ask('Exit: from the inbox')
    await page.goto(`${BASE}/#u-approvals`, { waitUntil: 'networkidle2' })
    await page.waitForSelector(T('approvals-row'), { timeout: 20000 })
    await page.evaluate((title) => { const r = [...document.querySelectorAll('[data-testid="approvals-row"]')].find((x) => x.textContent.includes(title)); r?.querySelector('[data-testid="approvals-open"]')?.click() }, 'Exit: from the inbox')
    await answerOnPage(page, a.id)
    notes.push('inbox: approved')

    // b. the bell
    const b = await ask('Exit: from the bell')
    await settle()
    await page.goto(`${BASE}/#home`, { waitUntil: 'networkidle2' })
    await click(page, T('notification-bell'))
    await page.waitForSelector(T('notification-item'), { timeout: 20000 })
    const opened = await page.evaluate((title) => {
      const it = [...document.querySelectorAll('[data-testid="notification-item"]')].find((x) => x.textContent.includes(title))
      const btn = it?.querySelector('button')
      btn?.click()
      return !!btn
    }, 'Exit: from the bell')
    need(opened, 'a bell notification for the request')
    await page.waitForFunction((id) => location.hash.includes(id), { timeout: 20000 }, b.id)
    await answerOnPage(page, b.id)
    notes.push('bell: deep link, approved')

    // c. the email link (fake SMTP relay)
    const c = await ask('Exit: from the email')
    await settle()
    let mail = null
    for (let i = 0; i < 60 && !mail; i++) { mail = smtp.inbox.find((m) => m.to.includes('mona@example.test') && (m.text ?? '').includes('Exit: from the email')); if (!mail) { await settle(); await sleep(250) } }
    need(mail, 'the approval email to Mona')
    const url = /Approve: (\S+)/.exec(mail.text ?? '')?.[1]
    need(url && url.includes('#u-approvals?link='), 'an Approve link in the email')
    need((await status(c.id)) === 'pending', 'opening nothing yet decided nothing')
    await page.goto(url, { waitUntil: 'networkidle2' })
    await page.waitForSelector(T('approval-link'), { visible: true, timeout: 20000 })
    await click(page, T('approval-link-confirm'))
    await page.waitForSelector(T('approval-link-done'), { timeout: 20000 })
    await waitStatus(c.id, 'approved')
    notes.push('email link: confirmation page, approved')

    // d. a delegation: Mona is away, Dee answers
    const dl = await mona.api('POST', '/approvals/delegations', { toUser: 'dee@example.test', startsOn: new Date(Date.now() - 60_000).toISOString(), endsOn: new Date(Date.now() + 86_400_000).toISOString(), note: 'Leave' })
    const d = await ask('Exit: delegated')
    const det = (await admin('GET', `/approvals/${d.id}`)).request
    need(det.assignments.some((x) => x.userId === dee.id && x.source === 'delegation' && x.status === 'pending'), 'the deputy is asked (source delegation)')
    const deePage = await tab('dee@example.test')
    await deePage.goto(`${BASE}/#u-approvals?id=${d.id}`, { waitUntil: 'networkidle2' })
    await answerOnPage(deePage, d.id)
    await mona.api('DELETE', `/approvals/delegations/${dl.delegation?.id ?? dl.id}`)
    notes.push('delegation: the deputy approved on her page')

    // e. an escalation: due in 1 hour, then to the manager's manager (the flow clock moves)
    await admin('POST', '/approvals/policies', { name: 'Exit escalation', definition: { type: 'single', approvers: ['mona@example.test'], dueMinutes: 60, escalation: { action: 'manager' } } })
    now = new Date()
    app.services.flows.setClock({ now: () => now })
    const e = await raj.api('POST', '/approvals', { policy: 'Exit escalation', title: 'Exit: escalated' })
    now = new Date(Date.now() + 2 * 3600_000)
    await settle()
    const ed = (await admin('GET', `/approvals/${e.id}`)).request
    need(ed.assignments.some((x) => x.userId === dev.id && x.source === 'escalation' && x.status === 'pending'), 'after the due date Dev (Mona\'s manager) is asked')
    const devPage = await tab('dev@example.test')
    await devPage.goto(`${BASE}/#u-approvals?id=${e.id}`, { waitUntil: 'networkidle2' })
    await answerOnPage(devPage, e.id)
    app.services.flows.setClock({ now: () => new Date() })
    notes.push('escalation: Dev asked after 2 h (simulated), approved')
    record(3, 'approvals answered from the inbox, the bell and an email link; delegation and escalation', true, notes.join('; '))
  } catch (e) {
    record(3, 'approvals answered from the inbox, the bell and an email link; delegation and escalation', false, `${notes.join('; ')}; ${e.message}`)
  }
}

/* ------------------------------------------------------------------ (4) a scheduled report */

async function checkReport() {
  const notes = []
  try {
    const t = await admin('POST', '/tables', { displayName: 'Exit deals', name: 'ExitDeals', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Amount', type: 'number' }] })
    const role = await admin('POST', '/roles', { name: 'Own deals', apps: 'all', privileges: [{ table: t.id, create: true, read: 'own', update: 'own', delete: 'own' }] })
    const rita = await person('Rita Rep', 'rita@example.test', { roleIds: [role.id] })
    await rita.api('POST', `/data/${t.id}/rows`, { values: { Title: 'Rita deal', Amount: 100 } })
    await admin('POST', `/data/${t.id}/rows`, { values: { Title: 'Board deal', Amount: 9000 } })
    const adminId = (await q(`SELECT id FROM ab.users WHERE email = $1`, [ADMIN.email]))[0].id
    const rep = await admin('POST', '/reports', {
      name: 'Exit morning deals', source: { kind: 'table', tableId: t.id, plan: { version: 2, table: 'ExitDeals', sort: [{ col: 'Amount', dir: 'desc' }], select: ['Title', 'Amount'] } },
      schedule: { frequency: 'daily', time: '07:00', timeZone: 'Asia/Kolkata' }, recipients: { userIds: [adminId, rita.id], teamIds: [] }, inlineRows: 20, onEmpty: 'send',
    })
    const sched = await q(`SELECT cron, time_zone FROM env_default.ab_schedules WHERE id = (SELECT schedule_id FROM env_default.ab_report_subscriptions WHERE id = $1)`, [rep.id])
    need(sched[0]?.cron === '0 7 * * *', `a daily 07:00 schedule (${JSON.stringify(sched[0])})`)
    notes.push(`schedule ${sched[0].cron} ${sched[0].time_zone}`)
    await admin('POST', `/reports/${rep.id}/run`)
    const mails = async () => {
      for (let i = 0; i < 80; i++) {
        await settle()
        const r = smtp.inbox.find((m) => m.to.includes('rita@example.test') && /Exit morning deals/.test(m.subject))
        const a = smtp.inbox.find((m) => m.to.includes(ADMIN.email) && /Exit morning deals/.test(m.subject))
        if (r && a) return { r, a }
        await sleep(250)
      }
      throw new Error('the report emails did not arrive')
    }
    const { r, a } = await mails()
    const csv = (m) => (m.attachments.find((x) => x.fileName.endsWith('.csv'))?.content.toString('utf8') ?? '')
    need(/<table/i.test(a.html ?? '') && a.html.includes('Board deal') && csv(a).includes('Board deal'), 'the administrator gets a table and a CSV with every row')
    need(r.html.includes('Rita deal') && !r.html.includes('Board deal') && !csv(r).includes('Board deal'), 'Rita gets only her own row')
    notes.push('administrator: table + CSV, 2 rows; Rita (own rows only): 1 row, no other row in the HTML or the CSV')
    record(4, 'a scheduled report emails a table to its recipients; a restricted recipient gets only their rows', true, notes.join('; '))
  } catch (e) {
    record(4, 'a scheduled report emails a table to its recipients; a restricted recipient gets only their rows', false, `${notes.join('; ')}; ${e.message}`)
  }
}

/* ------------------------------------------------------------------ (5) ALM with the plan screen */

async function checkAlm() {
  const notes = []
  let page = null
  const settings = { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' }
  try {
    const conn = await admin('POST', '/connections', { name: 'Orders API', connector: 'http', settings: { baseUrl: 'https://orders.example.test', allowedHosts: 'orders.example.test' } })
    const reqTable = await admin('POST', '/tables', { displayName: 'Exit requests', name: 'ExitRequests', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Amount', type: 'number' }] })
    const f1 = await admin('POST', '/flows', { name: 'Exit sync orders', settings, connections: { api: conn.id }, trigger: { type: 'manual', inputs: [], from: 'any' }, steps: [{ id: 'h', name: 'Call', kind: 'http', method: 'GET', url: '"https://orders.example.test/orders"', auth: 'api' }] })
    const f2 = await admin('POST', '/flows', { name: 'Exit request approval', settings, trigger: { type: 'table', table: 'ExitRequests', on: ['create'] }, steps: [{ id: 'a', name: 'Approve', kind: 'approval', title: '"Request " & Trigger.Record.Title', policy: 'Exit purchase' }] }).catch(async () => null)
    const pol = await admin('POST', '/approvals/policies', { name: 'Exit purchase', definition: { type: 'any', approvers: ['mona@example.test', 'ghost@example.test'] } })
    const f2b = f2 ?? await admin('POST', '/flows', { name: 'Exit request approval', settings, trigger: { type: 'table', table: 'ExitRequests', on: ['create'] }, steps: [{ id: 'a', name: 'Approve', kind: 'approval', title: '"Request " & Trigger.Record.Title', policy: 'Exit purchase' }] })
    const sol = await admin('POST', '/solutions', { name: 'ExitAlm', displayName: 'Exit ALM', publisher: 'Acme', version: '1.0.0' })
    for (const [kind, id] of [['table', reqTable.id], ['flow', f1.flow.id], ['flow', f2b.flow.id], ['approvalPolicy', pol.policy.id]]) await admin('POST', `/solutions/${sol.id}/components`, { kind, id })
    const env = await admin('POST', '/environments', { name: 'Exit production', type: 'production' })
    for (let i = 0; i < 60; i++) { const e = (await admin('GET', '/environments')).items.find((x) => x.id === env.id); if (e?.state === 'ready') break; await sleep(500) }
    const target = await admin('POST', '/connections', { name: 'Production orders API', connector: 'http', settings: { baseUrl: 'https://orders.example.test', allowedHosts: 'orders.example.test' } }, { env: env.id })
    notes.push(`target ${env.id} with connection "Production orders API"`)

    // the Deploy dialog
    page = await tab(ADMIN.email)
    const answers = []
    page.on('response', async (res) => { if (res.url().includes('/deploy') && res.request().method() === 'POST') answers.push(`${res.status()} ${(await res.text().catch(() => '')).slice(0, 300)}`) })
    page.answers = answers
    await page.goto(`${BASE}/#solution-${sol.id}`, { waitUntil: 'networkidle2' })
    await click(page, T('deploy-solution-button'))
    await page.waitForSelector(T('deploy-dialog'), { visible: true })
    await page.select(T('deploy-target'), env.id)
    await click(page, T('deploy-review'))
    await page.waitForSelector(T('plan-mappings'), { visible: true, timeout: 20000 })
    const blocked = await page.$eval(T('deploy-confirm'), (b) => b.disabled)
    need(blocked, 'the deploy button waits for the mapping')
    notes.push('plan shown, Deploy blocked until mapped')
    const sel = T('plan-map-connection-Orders API')
    await page.waitForSelector(sel)
    await page.select(sel, target.id)
    await page.waitForFunction((id) => document.querySelector('[data-testid="plan-map-connection-Orders API"]')?.value === id, { timeout: 20000 }, target.id)
    // the person without an account: map to Dev
    const ghost = T('plan-map-person-ghost@example.test')
    await page.waitForSelector(ghost, { visible: true })
    await page.click(ghost)
    await page.type(ghost, 'dev@example.test')
    await page.keyboard.press('Tab')
    await page.waitForFunction(() => !document.querySelector('[data-testid="plan-mappings-missing"]'), { timeout: 20000 })
    await click(page, T('deploy-confirm'))
    await page.waitForFunction(() => !document.querySelector('[data-testid="deploy-dialog"]'), { timeout: 30000 })
    notes.push('connection chosen, ghost@ mapped to dev@, deployed')

    // the target
    const flows = (await admin('GET', '/flows', undefined, { env: env.id })).items
    const sync = flows.find((x) => x.name === 'Exit sync orders')
    need(sync && sync.enabled === false, 'the flow arrived turned off')
    const full = await admin('GET', `/flows/${sync.id}`, undefined, { env: env.id })
    need(full.flow.connections.some((c) => c.ref === 'api' && c.connectionId === target.id), `the reference maps to the target's connection (${JSON.stringify(full.flow.connections)})`)
    const pols = (await admin('GET', '/approvals/policies', undefined, { env: env.id })).items
    const p = pols.find((x) => x.name === 'Exit purchase')
    need(p && JSON.stringify(p.definition.approvers).includes('dev@example.test') && !JSON.stringify(p.definition.approvers).includes('ghost@'), `the policy names Dev instead of the ghost (${JSON.stringify(p?.definition.approvers)})`)
    notes.push('target: 2 flows (off), reference -> Production orders API, policy approvers mona@ + dev@')
    record(5, 'flows, an approval policy and a connection reference deploy to a second environment with the plan screen (connection and people mapping)', true, notes.join('; '))
  } catch (e) {
    const shown = page?.answers ? page.answers.filter((a) => !a.startsWith('200')).join(' / ') : ''
    record(5, 'flows, an approval policy and a connection reference deploy to a second environment with the plan screen (connection and people mapping)', false, `${notes.join('; ')}; ${e.message}${shown ? `; the server answered: ${shown}` : ''}`)
  }
}

/* ------------------------------------------------------------------ (6) restricted flows, service accounts */

async function checkRestricted() {
  const notes = []
  const settings = { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' }
  try {
    const t = await admin('POST', '/tables', { displayName: 'Exit ledger', name: 'ExitLedger', columns: [{ displayName: 'Entry', type: 'text' }] })
    const log = await admin('POST', '/tables', { displayName: 'Exit log', name: 'ExitLog', columns: [{ displayName: 'Text', type: 'text' }] })
    const role = await admin('POST', '/roles', { name: 'Restricted maker', apps: 'all', isMaker: true, privileges: [{ table: t.id, create: true, read: 'own', update: 'own', delete: 'none' }, { table: log.id, create: false, read: 'none', update: 'none', delete: 'none' }] })
    const sam = await person('Sam Restricted', 'sam@example.test', { roleIds: [role.id] })
    const secret = (await admin('POST', `/data/${t.id}/rows`, { values: { Entry: 'admin only' } })).row.id
    await sam.api('POST', `/data/${t.id}/rows`, { values: { Entry: 'sam row' } })
    // Sam's flow (runs as Sam, its owner): reads, counts, tries to write the log and to change the admin's row
    const f = await sam.api('POST', '/flows', {
      name: 'Sam peeks', enabled: true, settings: { ...settings, onError: 'continue' }, trigger: { type: 'manual', inputs: [], from: 'any' },
      steps: [
        { id: 'l', name: 'List', kind: 'data.list', table: 'ExitLedger', top: 100 },
        { id: 'c', name: 'Count', kind: 'compose', value: 'CountRows(Steps.List.Output)' },
        { id: 'w', name: 'WriteLog', kind: 'data.create', table: 'ExitLog', values: { Text: '"sam was here"' } },
        { id: 'u', name: 'Change', kind: 'data.update', table: 'ExitLedger', rowId: `"${secret}"`, values: { Entry: '"changed by sam"' } },
      ],
    })
    const r = await sam.api('POST', `/flows/${f.flow.id}/run`, {})
    await settle()
    const steps = await q(`SELECT step_id, state, output FROM env_default.ab_flow_steps WHERE run_id = $1`, [r.runId])
    const by = Object.fromEntries(steps.map((s) => [s.step_id, s]))
    need(Number(by.c?.output) === 1, `the flow sees Sam's one row (${JSON.stringify(by.c?.output)})`)
    need(by.w?.state === 'failed' && by.u?.state === 'failed', `writing the log and changing the admin's row fail (${by.w?.state}, ${by.u?.state})`)
    need((await q(`SELECT count(*)::int AS n FROM env_default.t_exitlog`))[0].n === 0 && (await q(`SELECT "Entry" FROM env_default.t_exitledger WHERE id = $1`, [secret]))[0].Entry === 'admin only', 'nothing was written')
    notes.push('restricted maker\'s flow: read 1 row (own), log write and foreign update failed, nothing written')
    // service account: Sam may not; an administrator confirms; audited
    const sa = await admin('POST', '/identity/service-accounts', { name: 'Exit robot', environmentId: 'default', roleIds: ['role_admin'] })
    const refused = await sam.api('PUT', `/flows/${f.flow.id}`, { ...f.flow, runAs: { serviceAccount: sa.id }, confirmRunAs: true }, { allowError: true })
    need(refused.status === 403, `the restricted maker cannot make it a service flow (${refused.status})`)
    const noConfirm = await admin('POST', '/flows', { name: 'Exit service flow', settings, runAs: { serviceAccount: sa.id }, trigger: { type: 'manual', inputs: [], from: 'any' }, steps: [{ id: 'l', name: 'List', kind: 'data.list', table: 'ExitLedger', top: 100 }] }, { allowError: true })
    need(noConfirm.status === 409, `an administrator must confirm (${noConfirm.status})`)
    await admin('POST', '/flows', { name: 'Exit service flow', settings, enabled: true, confirmRunAs: true, runAs: { serviceAccount: sa.id }, trigger: { type: 'manual', inputs: [], from: 'any' }, steps: [{ id: 'l', name: 'List', kind: 'data.list', table: 'ExitLedger', top: 100 }] })
    const audit = await q(`SELECT count(*)::int AS n FROM env_default.ab_audit WHERE action = 'flow.run_as_service'`)
    need(audit[0].n >= 1, 'the run-as is audited')
    notes.push(`service account: refused for the maker (403), needs confirmation (409), audited (flow.run_as_service x${audit[0].n})`)
    record(6, 'a restricted user cannot make a flow read or write beyond their rights; service-account run-as audited', true, notes.join('; '))
  } catch (e) {
    record(6, 'a restricted user cannot make a flow read or write beyond their rights; service-account run-as audited', false, `${notes.join('; ')}; ${e.message}`)
  }
}

/* ------------------------------------------------------------------ the recycle bin (built at the phase close) */

async function checkRecycle() {
  const notes = []
  try {
    const t = await admin('POST', '/tables', { displayName: 'Exit bin', name: 'ExitBin', columns: [{ displayName: 'Title', type: 'text' }] })
    need(t.recycleDays === 30, `a new table keeps deleted rows for 30 days (${t.recycleDays})`)
    const role = await admin('POST', '/roles', { name: 'Own bin', apps: 'all', privileges: [{ table: t.id, create: true, read: 'own', update: 'own', delete: 'own' }] })
    const ivy = await person('Ivy Own', 'ivy@example.test', { roleIds: [role.id] })
    const mine = (await ivy.api('POST', `/data/${t.id}/rows`, { values: { Title: 'ivy row' } })).row.id
    const other = (await admin('POST', `/data/${t.id}/rows`, { values: { Title: 'admin row' } })).row.id
    const d1 = await ivy.api('POST', `/data/${t.id}/delete`, { ids: [mine] })
    const d2 = await admin('POST', `/data/${t.id}/delete`, { ids: [other] })
    const live = await admin('POST', `/data/${t.id}/query`, {})
    need(live.rows.length === 0, 'deleted rows are gone from queries')
    const seen = await ivy.api('GET', `/data/${t.id}/deleted`)
    need(seen.rows.length === 1 && seen.rows[0].Title === 'ivy row', 'the Deleted view shows Ivy only her own deleted row')
    const r = await ivy.api('POST', `/data/${t.id}/restore`, { batch: d2.batch.id }, { allowError: true })
    need(r.status === 404, `Ivy cannot restore the administrator's row (${r.status})`)
    const pg = await ivy.api('POST', `/data/${t.id}/purge`, { all: true, confirm: t.name }, { allowError: true })
    need(pg.status === 403, `Ivy cannot empty the recycle bin (${pg.status})`)
    await ivy.api('POST', `/data/${t.id}/restore`, { batch: d1.batch.id })
    need((await ivy.api('POST', `/data/${t.id}/query`, {})).rows.length === 1, 'her row is back (Undo)')
    notes.push('new table: 30 days; deleted rows out of queries; Deleted view trimmed to her rows; foreign restore 404; Empty now 403 for her; Undo restores hers')
    record('r', 'recycle bin: deleted rows hidden, restorable by their owner only', true, notes.join('; '))
  } catch (e) {
    record('r', 'recycle bin: deleted rows hidden, restorable by their owner only', false, `${notes.join('; ')}; ${e.message}`)
  }
}

/* ------------------------------------------------------------------ gap (i): Admin console > Flows */

async function checkAdminFlows() {
  try {
    const page = await tab(ADMIN.email)
    await page.goto(`${BASE}/#admin-flows`, { waitUntil: 'networkidle2' })
    await page.waitForSelector(T('admin-kill-switch'), { visible: true, timeout: 20000 })
    const before = await page.$eval(T('kill-switch-state'), (e) => e.textContent)
    await click(page, T('admin-pause-flows'))
    await click(page, T('confirm-ok'))
    await page.waitForFunction(() => document.querySelector('[data-testid="kill-switch-state"]')?.textContent === 'paused', { timeout: 20000 })
    const api = await admin('GET', '/flows/settings')
    await click(page, T('admin-resume-flows'))
    await page.waitForFunction(() => document.querySelector('[data-testid="kill-switch-state"]')?.textContent === 'running', { timeout: 20000 })
    const rows = await page.$$eval('[data-testid^="admin-flow-"]', (x) => x.length)
    record('i', 'Admin console > Flows: kill switch state, pause and resume, every flow with its state', before === 'running' && api.paused === true && rows > 0, `state "${before}" -> paused (API paused=${api.paused}) -> running; ${rows} flow rows`)
  } catch (e) {
    record('i', 'Admin console > Flows: kill switch state, pause and resume, every flow with its state', false, e.message)
  }
}

/* ------------------------------------------------------------------ (1), (2), (7): other processes */

async function checkSuites() {
  const env = { APPBUILDER_TEST_DB: `postgres://${DB.user}:${DB.password}@${DB.host}:${DB.port}/${MAINT}`, FLOW_THROUGHPUT_RUNS: '50' }
  const r = await run(process.execPath, [VITEST, 'run', 'server/core/approvals/approvals-exit.integration.test.ts', 'server/core/flows/flows-durability.integration.test.ts', '-t', 'exit check 1|purchase'], env)
  const o = plain(r.out)
  const tests = /Tests\s+(.+)/.exec(o)?.[1]?.trim() ?? '?'
  const dur = /Duration\s+(\S+)/.exec(o)?.[1] ?? '?'
  record(1, 'the purchase approval flow over a simulated week with two server restarts: no lost or duplicated step', r.code === 0, `approvals-exit.integration.test.ts (real approvals service) and flows-durability "exit check 1": ${tests} in ${dur} (the flow clock is moved in-process)`)
}
async function checkDesigner() {
  // its own database and port (the child inherits this script's environment, whose EXIT_DB_NAME and EXIT_PORT belong to this run)
  const r = await run(process.execPath, ['scripts/exit-check/p1-designer.mjs'], { EXIT_DB_NAME: 'appbuilder_exit_designer', ...(E.EXIT_PORT ? { EXIT_PORT: String(PORT + 1) } : {}) })
  const o = plain(r.out)
  const passes = (o.match(/ PASS /g) ?? []).length
  const fails = o.split('\n').filter((l) => / FAIL /.test(l))
  const perf = o.split('\n').filter((l) => /ms|seconds/.test(l) && /open|draw|panel|adding|undo/i.test(l)).slice(-2).map((l) => l.replace(/^\[[^\]]+\]\s*/, '')).join('; ')
  record(2, 'a flow built in the designer by clicking only passes the same test (scripts/exit-check/p1-designer.mjs)', r.code === 0, `${passes} checks passed${fails.length ? `, failed: ${fails.slice(0, 3).join(' / ')}` : ''}${perf ? `; ${perf}` : ''}`)
}
async function checkDocs() {
  const required = [
    'docs/guide/maker/flows.md', 'docs/guide/maker/approvals.md', 'docs/guide/maker/connections-and-actions.md', 'docs/guide/maker/webhooks.md', 'docs/guide/maker/scheduled-reports.md', 'docs/guide/maker/notifications.md',
    'docs/admin/flows.md', 'docs/admin/approvals.md', 'docs/admin/connections.md', 'docs/admin/webhook-security.md', 'docs/admin/operations.md',
    'docs/dev/flows.md', 'docs/dev/approvals.md', 'docs/dev/connectors.md', 'docs/dev/notifications-delivery.md',
    'docs/reference/flows.md', 'docs/reference/approvals.md', 'docs/reference/connector-actions.md',
    'docs/help/quick-start-approver.md', 'docs/help/notifications.md', 'docs/internal/security-review-p1.md',
  ]
  const missing = required.filter((f) => !fs.existsSync(path.join(root, f)))
  const r = await run(process.execPath, [VITEST, 'run', 'scripts/docs-links.test.ts', 'scripts/naming.test.ts'])
  const tests = /Tests\s+(.+)/.exec(plain(r.out))?.[1]?.trim() ?? '?'
  record(7, 'docs: maker guide for flows and approvals, admin guide, dev docs, reference for triggers and actions', r.code === 0 && !missing.length, `${required.length - missing.length}/${required.length} required pages${missing.length ? ` (missing: ${missing.join(', ')})` : ''}; link checker and naming test: ${tests}`)
}

/* ------------------------------------------------------------------ run */

let code = 0
try {
  log(`Phase 1 exit check: database ${DB.database}, port ${PORT}`)
  if (!SKIP.has('suites')) await checkSuites()
  if (!SKIP.has('designer')) await checkDesigner()
  await maint(`DROP DATABASE IF EXISTS "${DB.database}" WITH (FORCE)`)
  await maint(`CREATE DATABASE "${DB.database}" ENCODING 'UTF8' TEMPLATE template0`)
  await start()
  need(app.services.ready(), 'the server is ready on the empty database')
  const setupCode = app.services.setupCode.current() ?? ''
  await admin('POST', '/setup/admin', { setupCode, ...ADMIN })
  await admin('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password })
  smtp = await startFakeSmtp()
  await admin('PUT', '/identity/email', { host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'apps@example.test', installName: 'Exit Apps', publicUrl: BASE })
  if (!SKIP.has('browser')) browser = await puppeteer.launch({ executablePath: chromePath(E), headless: 'new', args: ['--no-sandbox'] })
  if (browser) await checkApprovals()
  await checkReport()
  if (browser) await checkAlm()
  await checkRestricted()
  if (browser) await checkAdminFlows()
  await checkRecycle()
  await checkDocs()
} catch (e) {
  record('-', 'exit check run', false, e.message.slice(0, 400))
} finally {
  await browser?.close().catch(() => {})
  await smtp?.close().catch(() => {})
  await stop().catch(() => {})
  if (E.KEEP !== '1') {
    await maint(`DROP DATABASE IF EXISTS "${DB.database}" WITH (FORCE)`).catch(() => {})
    fs.rmSync(DIR, { recursive: true, force: true })
  }
}
const order = (n) => (n === 'i' ? 7.5 : n === 'r' ? 7.6 : Number(n) || 0)
results.sort((a, b) => order(a.n) - order(b.n))
console.log('\n| # | Check | Result | Evidence |\n| --- | --- | --- | --- |')
for (const r of results) {
  console.log(`| ${r.n} | ${r.name} | ${r.ok === null ? 'skipped' : r.ok ? 'PASS' : 'FAIL'} | ${String(r.evidence).replace(/\|/g, '/').replace(/\n/g, ' ')} |`)
  if (r.ok === false) code = 1
}
console.log(`\nTotal ${((Date.now() - t0) / 1000).toFixed(0)} s`)
process.exit(code)
