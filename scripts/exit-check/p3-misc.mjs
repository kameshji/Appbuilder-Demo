#!/usr/bin/env node
/**
 * P3 package D, against a REAL server and the production build: the formSubmitted flow trigger and the error boundaries.
 * DEVELOPER TOOL (sandbox values only), not part of the product. Re-runnable.
 *
 *   npm run build   (the server serves dist/)
 *   node scripts/exit-check/p3-misc.mjs
 *
 * A server is started in this process (EXIT_PORT, default 5189) on an EMPTY database (EXIT_DB_NAME, default ab_s12: created
 * and dropped here; KEEP=1 keeps it).
 *
 *  A. formSubmitted (docs/dev/flows.md "The formSubmitted trigger"):
 *     1. a person submits a Form in the browser: the flow starts ONCE and runs as the submitter;
 *     2. a forged claim (a Form that is not the written table's, an unknown form, a refused write, a plain write) starts nothing;
 *     3. the same keyed write sent twice starts it once;
 *     4. a submit saved OFFLINE and replayed when the network is back starts it once.
 *  B. error boundaries (src/components/ErrorBoundary.tsx; the test hook window.__abForceCrash):
 *     5. a forced crash in one app tab shows the fallback in that tab; the shell, another tab and the chat dock keep working;
 *     6. a forced crash in one dashboard tile leaves the other tiles;
 *     7. the boundary resets on navigation (page area) and on a tab change (app tab); "Reload" resets one part;
 *     8. no stack or error text in the production fallback; the root logged the error with its component stack.
 *
 * Settings: EXIT_DB_HOST (127.0.0.1), EXIT_DB_PORT (5435), EXIT_DB_USER (abdev), EXIT_DB_PASSWORD (abdev-sandbox-only),
 * EXIT_DB_NAME (ab_s12), EXIT_MAINT_DB (appbuilder_test), EXIT_PORT (5189), EXIT_WORKSPACE, PUPPETEER_CORE, CHROME_PATH, SHOTS.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const DB = { host: E.EXIT_DB_HOST || '127.0.0.1', port: Number(E.EXIT_DB_PORT || 5435), user: E.EXIT_DB_USER || 'abdev', password: E.EXIT_DB_PASSWORD || 'abdev-sandbox-only', database: E.EXIT_DB_NAME || 'ab_s12' }
const MAINT = E.EXIT_MAINT_DB || 'appbuilder_test'
const PORT = Number(E.EXIT_PORT || 5189)
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = E.SHOTS || ''
const ADMIN = { name: 'Exit Admin', email: 'exit-admin@example.test', password: 'Exit-Example-Pass-2026' }
const CLEO = { name: 'Cleo Clerk', email: 'cleo@example.test', password: 'Cleo-Example-Pass-2026' }
if (!/^(ab_s\d+|appbuilder_exit)/.test(DB.database)) { console.error('The database name must start with ab_s<n> or appbuilder_exit (it is dropped).'); process.exit(2) }
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) { console.error('Build the app first (npm run build).'); process.exit(2) }

const imp = (p) => import(pathToFileURL(path.join(root, p)).href)
const { createApp } = await imp('server/core/app.ts')
const { serveStatic } = await imp('server/core/static.ts')
const { setQuiet } = await imp('server/core/util.ts').catch(() => ({ setQuiet: null }))
const { Client } = await imp('server/core/kernel-testkit.ts')
const { SHAPE, productionOverview } = await imp('src/dashboards/manufacturing.ts')
const { default: puppeteer } = await import(pathToFileURL(path.join(E.PUPPETEER_CORE || path.join(root, 'node_modules', 'puppeteer-core'), 'lib/puppeteer/puppeteer-core.js')).href)
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

const DIR = E.EXIT_WORKSPACE ? path.resolve(E.EXIT_WORKSPACE) : fs.mkdtempSync(path.join(os.tmpdir(), 'ab-exit-misc-'))
if (E.EXIT_WORKSPACE) {
  if (path.resolve(DIR) === root || !/workspace/i.test(path.basename(DIR))) { console.error('EXIT_WORKSPACE must be a folder named ...workspace... (it is emptied).'); process.exit(2) }
  fs.rmSync(DIR, { recursive: true, force: true })
}
fs.mkdirSync(DIR, { recursive: true })
let app = null
let server = null
async function start() {
  app = await createApp({ env: { APPBUILDER_MIGRATION_BACKUP: 'skip' }, config: { workspaceDir: DIR }, printSetupCode: false, jobs: true })
  server = http.createServer((req, res) => {
    app.handle(req, res).then((h) => { if (!h) serveStatic(app.config.distDir ?? path.join(root, 'dist'), req, res) }, () => { if (!res.headersSent) res.writeHead(500); res.end() })
  })
  server.on('upgrade', (req, socket, head) => { if (!app.handleUpgrade(req, socket, head)) socket.destroy() })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
}
async function stop() {
  if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(() => r())) }
  if (app) await app.close()
}
const admin = new Client(BASE)
const cleo = new Client(BASE)
async function api(c, method, p, body) {
  const r = await c.req(method, p, body)
  if (r.status !== 200) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`)
  return r.data
}
/** a row write with a header the testkit Client cannot send */
async function write(c, table, body, headers = {}) {
  const res = await fetch(`${BASE}/api/v1/data/${table}/rows`, { method: 'POST', headers: { 'X-Appbuilder': '1', 'Content-Type': 'application/json', Cookie: c.cookie, ...headers }, body: JSON.stringify(body) })
  return { status: res.status, data: await res.json().catch(() => null) }
}

let browser = null
const T = (id) => `[data-testid="${id}"]`
const errors = []
const consoleErrors = []
async function shot(page, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }) } }
const waitFor = (page, sel, timeout = 20000) => page.waitForSelector(sel, { visible: true, timeout })
async function newPage(ctx) {
  const page = await ctx.newPage()
  await page.setViewport({ width: 1600, height: 1000 })
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('dialog', (d) => d.accept())
  // the error-boundary test hook is inert in a production build unless switched on (P3 security review, P3-5)
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('ab:test-hooks', '1') } catch { /* no storage */ } })
  return page
}
async function signIn(page, who) {
  await page.goto(`${BASE}/#u`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[type=email]', { timeout: 20000 })
  await page.type('input[type=email]', who.email)
  await page.type('input[type=password]', who.password)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 30000 })
  await sleep(500)
}
const flowRuns = (flowId) => q(`SELECT id, state, run_as, triggered_by, trigger_kind, trigger->'Record'->>'Title' AS title FROM env_default.ab_flow_runs WHERE flow_id = $1 ORDER BY created_on`, [flowId])
async function waitRuns(flowId, n, ms = 30000) {
  const end = Date.now() + ms
  for (;;) {
    const r = await flowRuns(flowId)
    if (r.length >= n) return r
    if (Date.now() > end) return r
    await sleep(300)
  }
}
const label = (id, name, text, y = 20) => ({ id, name, type: 'Label', props: { X: '=20', Y: `=${y}`, Width: '=600', Height: '=40', Text: text }, children: [] })

let failed = false
try {
  await maint(`DROP DATABASE IF EXISTS "${DB.database}"`)
  await start()
  const setupCode = app.services.setupCode.current() ?? ''
  await api(admin, 'POST', '/setup/database', { setupCode, host: DB.host, port: DB.port, database: DB.database, user: DB.user, password: DB.password, createDatabase: true })
  await api(admin, 'POST', '/setup/admin', { setupCode, ...ADMIN })
  await api(admin, 'POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password })

  log('setup: tables, a role and a user, two apps, a flow, a dashboard')
  const subs = await api(admin, 'POST', '/tables', { displayName: 'Submissions', name: 'Submissions', columns: [{ displayName: 'Title', name: 'Title', type: 'text', required: true }] })
  const other = await api(admin, 'POST', '/tables', { displayName: 'Elsewhere', name: 'Elsewhere', columns: [{ displayName: 'Note', name: 'Note', type: 'text' }] })
  const logT = await api(admin, 'POST', '/tables', { displayName: 'ProductionLog', name: 'ProductionLog', columns: SHAPE.ProductionLog })
  const downT = await api(admin, 'POST', '/tables', { displayName: 'Downtime', name: 'Downtime', columns: SHAPE.Downtime })
  const clerks = await api(admin, 'POST', '/roles', { name: 'Clerks', apps: 'all', privileges: [subs, other, logT, downT].map((t) => ({ table: t.id, create: true, read: 'all', update: 'all', delete: 'none' })) })
  const rec = await api(admin, 'POST', '/users', { name: CLEO.name, email: CLEO.email, password: CLEO.password, roleIds: [clerks.id] })
  const cleoId = rec.id ?? rec.user?.id
  await q('UPDATE ab.users SET must_change_password = false WHERE id = $1', [cleoId])
  await api(cleo, 'POST', '/auth/login', { email: CLEO.email, password: CLEO.password })

  const intake = await api(admin, 'POST', '/apps', { name: 'Intake', width: 1280, height: 800 })
  const idef = (await api(admin, 'GET', `/apps/${intake.id}`)).definition
  idef.dataSources = ['Submissions', 'Elsewhere']
  idef.offline = { entry: true }
  idef.screens[0].children = [
    label('n_intro', 'IntakeIntro', '="Intake form"'),
    { id: 'n_form', name: 'IntakeForm', type: 'Form', props: { X: '=20', Y: '=70', Width: '=520', Height: '=300', DataSource: '="Submissions"', Mode: '=FormMode.New', Fields: '="Title"', Columns: '=1' }, children: [] },
    { id: 'n_form2', name: 'ElsewhereForm', type: 'Form', props: { X: '=560', Y: '=70', Width: '=300', Height: '=200', DataSource: '="Elsewhere"', Mode: '=FormMode.New', Fields: '="Note"', Columns: '=1' }, children: [] },
  ]
  await api(admin, 'PUT', `/apps/${intake.id}`, { definition: idef })
  const second = await api(admin, 'POST', '/apps', { name: 'Second app', width: 1280, height: 800 })
  const sdef = (await api(admin, 'GET', `/apps/${second.id}`)).definition
  sdef.screens[0].children = [label('n_s', 'SecondLabel', '="Second app is fine"')]
  await api(admin, 'PUT', `/apps/${second.id}`, { definition: sdef })

  const flow = await api(admin, 'POST', '/flows', {
    name: 'On intake', enabled: true, runAs: 'triggeringUser',
    settings: { concurrency: 'parallel', timeoutMinutes: 600, retentionDays: 30, onError: 'fail' },
    trigger: { type: 'formSubmitted', app: intake.id, form: 'IntakeForm', on: ['create'] },
    steps: [{ id: 'c', name: 'Mark', kind: 'compose', value: '"intake " & Trigger.Record.Title' }],
  })
  const flowId = flow.flow.id
  const now = Date.now()
  for (let i = 0; i < 12; i++) await api(admin, 'POST', '/data/ProductionLog/rows', { values: { LoggedOn: new Date(now - i * 5 * 60_000).toISOString(), Shift: ['A', 'B', 'C'][i % 3], Machine: `Press ${1 + (i % 4)}`, Good: 100 + i, Scrap: i % 5, PlannedMin: 60, RunMin: 50, IdealCycleSec: 20 } })
  const dash = await api(admin, 'POST', '/dashboards', { def: productionOverview(), roles: [] })
  record('setup', true, `flow ${flowId}, apps ${intake.id} / ${second.id}, dashboard ${dash.id}`)

  browser = await puppeteer.launch({ executablePath: E.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1000'] })

  /* ---------------------------------------------------------------- A. formSubmitted */
  log('A. formSubmitted')
  const ctxC = await browser.createBrowserContext()
  const pc = await newPage(ctxC)
  await signIn(pc, CLEO)
  await pc.goto(`${BASE}/#u-${intake.id}`, { waitUntil: 'domcontentloaded' })
  const titleSel = `${T('control-IntakeForm')} [id$="-Title"]`
  await waitFor(pc, titleSel, 30000)
  const fill = async (text) => {
    await pc.focus(titleSel)
    await pc.$eval(titleSel, (e) => e.select())
    await pc.keyboard.press('Backspace')
    await pc.keyboard.type(text)
  }
  const save = () => pc.$eval(`${T('control-IntakeForm')} ${T('form-save')}`, (b) => b.click())
  await fill('Browser submit')
  await save()
  const r1 = await waitRuns(flowId, 1)
  await sleep(1500)
  const r1b = await flowRuns(flowId)
  check(r1b.length === 1 && r1b[0].trigger_kind === 'formSubmitted' && r1b[0].title === 'Browser submit', 'formSubmitted: a submit in the browser starts the flow once', JSON.stringify(r1b.map((x) => [x.state, x.title])))
  check(r1b[0].run_as === cleoId && r1b[0].triggered_by === cleoId, 'formSubmitted: the run acts as the submitter (the flow is owned by the administrator and runs as the triggering user)', `run_as ${r1b[0].run_as === cleoId ? 'Cleo' : r1b[0].run_as}`)
  void r1

  // forged claims: the server only starts a flow for a claim the committed write backs
  const before = (await flowRuns(flowId)).length
  const claims = [
    ['no claim (a plain write)', { values: { Title: 'plain' } }],
    ['a Form of another table', { values: { Note: 'x' }, form: { app: intake.id, form: 'IntakeForm' }, table: 'Elsewhere' }],
    ['an unknown form', { values: { Title: 'u' }, form: { app: intake.id, form: 'NoSuchForm' } }],
    ['an unknown app', { values: { Title: 'u2' }, form: { app: 'app_nope', form: 'IntakeForm' } }],
    ['a refused write (required column missing)', { values: {}, form: { app: intake.id, form: 'IntakeForm' }, expectRefused: true }],
    ['nonsense', { values: { Title: 'n' }, form: ['IntakeForm'] }],
  ]
  const outcomes = []
  for (const [name, c] of claims) {
    const { table, expectRefused, ...body } = c
    const r = await write(cleo, table ?? 'Submissions', body)
    outcomes.push(`${name}: ${r.status}`)
    if (expectRefused && r.status < 400) throw new Error('the refused write was accepted')
  }
  await sleep(2000)
  check((await flowRuns(flowId)).length === before, 'formSubmitted: forged or unbacked claims start nothing', outcomes.join('; '))

  // the same keyed write sent twice: once
  const key = `exit-form-key-${Date.now()}`
  const keyed = { values: { Title: 'Keyed' }, form: { app: intake.id, form: 'IntakeForm' } }
  const k1 = await write(cleo, 'Submissions', keyed, { 'Idempotency-Key': key })
  const k2 = await write(cleo, 'Submissions', keyed, { 'Idempotency-Key': key })
  await waitRuns(flowId, before + 1)
  await sleep(1500)
  check(k1.status === 200 && k2.status === 200 && (await flowRuns(flowId)).length === before + 1, 'formSubmitted: the same keyed write sent twice (a retry) starts it once', `${k1.status}/${k2.status}`)

  // offline: saved on the device, replayed when the connection is back
  const countBefore = (await flowRuns(flowId)).length
  await pc.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(pc, titleSel, 30000)
  await sleep(1500)
  await pc.setOfflineMode(true)
  await pc.evaluate(() => window.dispatchEvent(new Event('offline')))
  await fill('Saved offline')
  await save()
  await pc.waitForSelector(T('outbox-count'), { timeout: 20000 })
  await sleep(1000)
  check((await flowRuns(flowId)).length === countBefore, 'formSubmitted: offline, nothing reached the server and no run started', `${await pc.$eval(T('outbox-count'), (e) => e.textContent)} waiting`)
  await pc.setOfflineMode(false)
  await pc.evaluate(() => window.dispatchEvent(new Event('online')))
  await pc.waitForFunction(() => !document.querySelector('[data-testid="outbox-count"]'), { timeout: 60000 })
  const rOff = await waitRuns(flowId, countBefore + 1)
  await sleep(2000)
  const finalRuns = await flowRuns(flowId)
  check(finalRuns.length === countBefore + 1 && finalRuns.filter((x) => x.title === 'Saved offline').length === 1 && finalRuns.at(-1).run_as === cleoId, 'formSubmitted: an offline submit, replayed when the network is back, starts the flow once, as the submitter', `${rOff.length} -> ${finalRuns.length} runs`)
  await pc.close()

  /* ---------------------------------------------------------------- B. error boundaries */
  log('B. error boundaries')
  const ctxA = await browser.createBrowserContext()
  const pa = await newPage(ctxA)
  await signIn(pa, ADMIN)
  const pane = (id) => `[data-testid="tab-pane-${id}"]`
  await pa.goto(`${BASE}/#u-${intake.id}`, { waitUntil: 'domcontentloaded' })
  await waitFor(pa, `${pane(intake.id)} ${T('control-IntakeIntro')}`, 30000)
  await pa.goto(`${BASE}/#u-${second.id}`, { waitUntil: 'domcontentloaded' })
  await waitFor(pa, `${pane(second.id)} ${T('control-SecondLabel')}`, 30000)
  await pa.click(T('chat-button')).catch(() => undefined)
  await pa.waitForSelector(`${T('chat-dock')} ${T('chat-panel')}[data-status="ready"]`, { timeout: 30000 }).catch(() => undefined)
  const chatOk = () => pa.$eval(T('chat-dock'), (e) => e.getBoundingClientRect().width > 0 && !e.querySelector('[data-testid="error-boundary"]')).catch(() => false)
  check(await chatOk(), 'boundaries: the chat dock is open and working before the crash')

  consoleErrors.length = 0
  await pa.evaluate((id) => window.__abForceCrash(`app-tab:${id}`), second.id)
  await waitFor(pa, `${pane(second.id)} ${T('error-boundary')}`)
  const fb = await pa.$eval(`${pane(second.id)} ${T('error-boundary')}`, (e) => ({ text: e.innerText, scope: e.getAttribute('data-scope') }))
  check(/This part of the page could not be shown/.test(fb.text) && fb.scope === `app-tab:${second.id}` && !!(await pa.$(`${pane(second.id)} ${T('error-boundary-reload')}`)), 'boundaries: a forced crash in an app tab shows "This part of the page could not be shown" with a Reload button in that tab', fb.text.replace(/\s+/g, ' '))
  check(!/Forced crash|at \w+ \(|Component stack|\.tsx/.test(fb.text), 'boundaries: the production fallback shows no error text or stack', fb.text.replace(/\s+/g, ' '))
  await shot(pa, 'boundary-app-tab.png')
  const shellOk = await pa.evaluate((a) => ({ frame: !!document.querySelector('[data-testid="app-frame"]'), pagesFallback: document.querySelectorAll('[data-testid="error-boundary"]').length, other: !!document.querySelector(`[data-testid="tab-pane-${a}"] [data-testid="control-IntakeIntro"]`) }), intake.id)
  check(shellOk.frame && shellOk.pagesFallback === 1 && shellOk.other, 'boundaries: the shell and the other app tab are untouched (one fallback on the page)', JSON.stringify(shellOk))
  check(await chatOk(), 'boundaries: the chat dock keeps working')
  await sleep(300)
  check(consoleErrors.some((m) => /\[render caught\][\s\S]*Forced crash/.test(m)) && consoleErrors.some((m) => /Component stack/.test(m)), 'boundaries: the root logged the error with its component stack (console)', consoleErrors.map((m) => m.slice(0, 60)).join(' | '))
  // switching to the other tab and back resets the crashed one
  await pa.goto(`${BASE}/#u-${intake.id}`, { waitUntil: 'domcontentloaded' })
  await sleep(500)
  await pa.goto(`${BASE}/#u-${second.id}`, { waitUntil: 'domcontentloaded' })
  await waitFor(pa, `${pane(second.id)} ${T('control-SecondLabel')}`, 20000)
  check(!(await pa.$(`${pane(second.id)} ${T('error-boundary')}`)), 'boundaries: changing the app tab resets the crashed tab (it shows its app again)')
  // Reload on one part
  await pa.evaluate((id) => window.__abForceCrash(`app-tab:${id}`), second.id)
  await waitFor(pa, `${pane(second.id)} ${T('error-boundary')}`)
  await pa.click(`${pane(second.id)} ${T('error-boundary-reload')}`)
  await waitFor(pa, `${pane(second.id)} ${T('control-SecondLabel')}`, 20000)
  record('boundaries: "Reload" on the fallback brings that part back', true)

  // a UI component: one that throws shows the fallback in its own box
  await pa.evaluate(() => window.__abForceCrash('component:SecondLabel'))
  await waitFor(pa, `${pane(second.id)} ${T('control-SecondLabel')} ${T('error-boundary')}`)
  record('boundaries: a forced crash of one UI component shows the fallback in its own box', true)
  await pa.evaluate(() => window.__abForceCrash('component:SecondLabel', false))
  await pa.click(`${pane(second.id)} ${T('control-SecondLabel')} ${T('error-boundary-reload')}`)
  await waitFor(pa, `${pane(second.id)} ${T('control-SecondLabel')}`)

  // the chat dock alone
  await pa.evaluate(() => window.__abForceCrash('chat-dock'))
  await waitFor(pa, `${T('app-frame')} [data-scope="chat-dock"]`)
  const paneFine = await pa.$eval(`${pane(second.id)} ${T('control-SecondLabel')}`, (e) => e.textContent.includes('Second app is fine'))
  check(paneFine, 'boundaries: a forced crash in the chat dock leaves the app tab alone')
  await pa.click(`${T('app-frame')} [data-scope="chat-dock"] ${T('error-boundary-reload')}`)
  await pa.waitForFunction(() => !document.querySelector('[data-scope="chat-dock"]'), { timeout: 10000 })
  record('boundaries: Reload brings the chat dock back', true)

  // dashboard tiles
  await pa.goto(`${BASE}/#u-dashboards?d=${dash.id}`, { waitUntil: 'domcontentloaded' })
  await pa.waitForFunction(() => document.querySelectorAll('section[data-testid^="tile-"][data-state="ready"]').length >= 7, { timeout: 40000 })
  await pa.evaluate(() => window.__abForceCrash('tile:good'))
  await waitFor(pa, '[data-scope="tile:good"]')
  const tiles = await pa.evaluate(() => ({ ready: document.querySelectorAll('section[data-testid^="tile-"][data-state="ready"]').length, fallbacks: document.querySelectorAll('[data-testid="error-boundary"]').length, good: !!document.querySelector('section[data-testid="tile-good"]') }))
  check(tiles.fallbacks === 1 && !tiles.good && tiles.ready >= 6, 'boundaries: a forced crash in one dashboard tile leaves the other tiles', JSON.stringify(tiles))
  await shot(pa, 'boundary-tile.png')
  await pa.click('[data-scope="tile:good"] [data-testid="error-boundary-reload"]')
  await waitFor(pa, 'section[data-testid="tile-good"]')
  record('boundaries: Reload brings the tile back', true)

  // the page area resets on navigation
  await pa.evaluate(() => window.__abForceCrash('portal-page'))
  await waitFor(pa, '[data-scope="portal-page"]')
  const nav = await pa.evaluate(() => !!document.querySelector('nav, header, [data-testid="app-frame"]'))
  check(nav, 'boundaries: a crash in the page area leaves the shell around it')
  await pa.evaluate(() => { location.hash = '#u' })
  await pa.waitForFunction(() => !document.querySelector('[data-scope="portal-page"]'), { timeout: 15000 })
  check(!!(await pa.$('[data-testid="app-frame"]')), 'boundaries: navigating to another page resets the page-area boundary (the page shows again)')
  await shot(pa, 'boundary-reset.png')

  // the kiosk page
  const made = await api(admin, 'POST', `/dashboards/${dash.id}/tokens`, { label: 'Boundary TV' })
  const ctxK = await browser.createBrowserContext()
  const pk = await newPage(ctxK)
  await pk.goto(`${BASE}/#u-kiosk?t=${encodeURIComponent(made.token)}`, { waitUntil: 'domcontentloaded' })
  await pk.waitForFunction(() => document.querySelectorAll('section[data-testid^="tile-"][data-state="ready"]').length >= 7, { timeout: 40000 })
  await pk.evaluate(() => window.__abForceCrash('tile:oee'))
  await waitFor(pk, '[data-scope="tile:oee"]')
  const kt = await pk.evaluate(() => document.querySelectorAll('section[data-testid^="tile-"][data-state="ready"]').length)
  check(kt >= 6, 'boundaries: on the kiosk page one failed tile leaves the rest', `${kt} tiles ready`)
  await pk.close()

  check(!errors.length, 'no uncaught script errors in the browser', errors.slice(0, 3).join(' | '))
} catch (e) {
  failed = true
  console.error(e)
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stop().catch(() => undefined)
  if (!E.KEEP) await maint(`DROP DATABASE IF EXISTS "${DB.database}"`).catch((e) => console.error(`could not drop ${DB.database}: ${e.message}`))
  if (!E.EXIT_WORKSPACE) fs.rmSync(DIR, { recursive: true, force: true })
}
const bad = results.filter((r) => !r.ok)
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed${failed ? ' (stopped at the first failure)' : ''}`)
process.exit(failed || bad.length ? 1 : 0)
