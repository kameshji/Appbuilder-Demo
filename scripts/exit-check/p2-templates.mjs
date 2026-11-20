#!/usr/bin/env node
/**
 * Phase 2 exit check 5 (docs/plan/p2-spec.md), against a REAL server in a headless browser: "A screen template, a UI
 * component template, an app template and a data model template are installed from the catalogue with the binding step
 * and the plan screen, without changing anything that existed." DEVELOPER TOOL (sandbox values only), not part of the
 * product. Re-runnable.
 *
 *   npm run build   (the server serves dist/)
 *   node scripts/exit-check/p2-templates.mjs
 *
 * A server is started in this process (EXIT_PORT, default 5192) on an EMPTY database (EXIT_DB_NAME, default ab_d2:
 * created and dropped here; KEEP=1 keeps it), workspace EXIT_WORKSPACE (default .sandbox/d2/workspace, emptied).
 * Setup and the things that exist BEFORE (tables with rows, a role, two apps, a flow) go through the API; then every
 * install is clicked through in the browser:
 *
 *  1. app template (Templates page): the Requests table exists -> the clash is shown -> "Use Requests" (resolved by
 *     mapping) -> plan screen -> Install;
 *  2. data model template (Templates page): the Customers table exists -> "Install as Customers2" (resolved by another
 *     name), SAMPLE rows ticked -> plan screen -> Install;
 *  3. a blocked install: the app template mapped to Tickets, whose columns do not include a Status: the required slot
 *     column is unmapped, the plan screen lists the problem and Install stays disabled;
 *  4. UI component template (Studio, Insert pane > "UI components from a template"): a new Decisions table -> plan ->
 *     Install -> the components are in the current screen;
 *  5. screen template (Templates page > Use > Open in the Studio): mapped to Tickets with Status -> State -> plan ->
 *     Install -> the new screen is in the app;
 *  6. the environment before and after: every app, table (definition, rows, physical columns), role, privilege, user
 *     role, flow and version, relationship, table event, solution and connection that existed is byte-equal, except
 *     the app the Studio inserted into, whose earlier screens and UI components are compared instead (only additions).
 *
 * Settings: EXIT_DB_HOST (127.0.0.1), EXIT_DB_PORT (5435), EXIT_DB_USER (abdev), EXIT_DB_PASSWORD (abdev-sandbox-only),
 * EXIT_DB_NAME (ab_d2), EXIT_MAINT_DB (appbuilder_test), EXIT_PORT (5192), EXIT_WORKSPACE, PUPPETEER_CORE, CHROME_PATH,
 * SHOTS (screenshots), DEBUG_WS=1 (log the environment messages the browser receives over the live socket).
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const DB = { host: E.EXIT_DB_HOST || '127.0.0.1', port: Number(E.EXIT_DB_PORT || 5435), user: E.EXIT_DB_USER || 'abdev', password: E.EXIT_DB_PASSWORD || 'abdev-sandbox-only', database: E.EXIT_DB_NAME || 'ab_d2' }
const MAINT = E.EXIT_MAINT_DB || 'appbuilder_test'
const PORT = Number(E.EXIT_PORT || 5192)
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = E.SHOTS || ''
const ADMIN = { name: 'Exit Admin', email: 'exit-admin@example.test', password: 'Exit-Example-Pass-2026' }
const S = 'env_default'
if (!/^(ab_d\d+|ab_s\d+|appbuilder_exit)/.test(DB.database)) { console.error('The database name must start with ab_d<n>, ab_s<n> or appbuilder_exit (it is dropped).'); process.exit(2) }
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) { console.error('Build the app first (npm run build).'); process.exit(2) }

const imp = (p) => import(pathToFileURL(path.join(root, p)).href)
const { createApp } = await imp('server/core/app.ts')
const { serveStatic } = await imp('server/core/static.ts')
const { setQuiet } = await imp('server/core/util.ts').catch(() => ({ setQuiet: null }))
const { Client } = await imp('server/core/kernel-testkit.ts')
const { default: puppeteer } = await import(pathToFileURL(path.join(E.PUPPETEER_CORE || path.join(root, '.sandbox', 's1', 'tools', 'node_modules', 'puppeteer-core'), 'lib/puppeteer/puppeteer-core.js')).href)
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

/* ------------------------------------------------------------------ server, API */

const DIR = path.resolve(E.EXIT_WORKSPACE || path.join(root, '.sandbox', 'd2', 'workspace'))
if (path.resolve(DIR) === root || !/workspace/i.test(path.basename(DIR))) { console.error('EXIT_WORKSPACE must be a folder named ...workspace... (it is emptied).'); process.exit(2) }
fs.rmSync(DIR, { recursive: true, force: true })
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
async function api(method, p, body) {
  const r = await admin.req(method, p, body)
  if (r.status !== 200) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`)
  return r.data
}

/** everything that exists, as text keyed by what it is (jsonb::text is normalised, so equal text = equal content) */
async function snapshot() {
  const m = new Map()
  const put = (k, v) => m.set(k, typeof v === 'string' ? v : JSON.stringify(v))
  for (const r of await q(`SELECT id, name, description, definition::text AS definition, width, height FROM ${S}.ab_apps`)) put(`app:${r.id}`, r)
  for (const t of await q(`SELECT id, name, def::text AS def, source, connection_id FROM ${S}.ab_tables`)) {
    put(`table:${t.id}`, t)
    const def = JSON.parse(t.def)
    if (t.source && def.managed && !def.reporting && (t.connection_id ?? 'conn_default') === 'conn_default') {
      put(`rows:${t.id}`, (await q(`SELECT coalesce(json_agg(x ORDER BY x.id)::text, '[]') AS j FROM ${S}."${t.source}" x`))[0].j)
      put(`columns:${t.id}`, await q('SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name', [S, t.source]))
    }
  }
  for (const r of await q(`SELECT id, name, description, is_admin, is_maker, apps::text AS apps FROM ${S}.ab_roles`)) put(`role:${r.id}`, r)
  for (const r of await q(`SELECT role_id, table_id, can_create, read_scope, update_scope, delete_scope, columns::text AS columns, row_filter::text AS row_filter FROM ${S}.ab_role_tables`)) put(`privilege:${r.role_id}:${r.table_id}`, r)
  for (const r of await q(`SELECT user_id, role_id FROM ${S}.ab_user_roles`)) put(`userrole:${r.user_id}:${r.role_id}`, r)
  for (const r of await q(`SELECT * FROM ${S}.ab_flows`)) put(`flow:${r.id}`, r)
  for (const r of await q(`SELECT * FROM ${S}.ab_flow_versions`)) put(`flowversion:${r.flow_id}:${r.version}`, r)
  for (const r of await q(`SELECT * FROM ${S}.ab_relationships`)) put(`relationship:${r.id}`, r)
  for (const r of await q(`SELECT * FROM ${S}.ab_table_events`)) put(`event:${r.id}`, r)
  for (const r of await q(`SELECT id, name, display_name, version, components::text AS components FROM ${S}.ab_solutions`)) put(`solution:${r.id}`, r)
  for (const r of await q(`SELECT id, name, connector, settings::text AS settings, status, is_default FROM ${S}.ab_connections`)) put(`connection:${r.id}`, r)
  return m
}

/* ------------------------------------------------------------------ browser helpers */

let browser = null
const T = (id) => `[data-testid="${id}"]`
const errors = []
async function shot(page, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }) } }
const waitFor = (page, sel, timeout = 20000) => page.waitForSelector(sel, { visible: true, timeout })
async function click(page, sel) { await page.waitForSelector(`${sel}:not([disabled])`, { visible: true, timeout: 20000 }); await (await waitFor(page, sel)).click() }
/** the dialog finished planning (its buttons are enabled again) */
const idle = (page) => page.waitForFunction(() => { const b = document.querySelector('[data-testid="tpl-review"], [data-testid="tpl-install"]'); return !!b && !document.querySelector('[data-testid="tpl-dialog"] .animate-spin') }, { timeout: 20000 })
async function pick(page, sel, value) { await page.waitForSelector(`${sel}:not([disabled])`, { visible: true, timeout: 20000 }); await page.select(sel, value); await sleep(150); await idle(page) }
async function signIn(page, who) {
  await page.goto(`${BASE}/#home`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[type=email]', { timeout: 20000 })
  await page.type('input[type=email]', who.email)
  await page.type('input[type=password]', who.password)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 30000 })
  await sleep(500)
}
/** review the plan, check it, install; returns the plan text */
async function reviewAndInstall(page, label, shotName) {
  await click(page, T('tpl-review'))
  await waitFor(page, T('solution-plan'))
  const text = await page.$eval(T('solution-plan'), (e) => e.innerText)
  check(!(await page.$(T('plan-problems'))), `${label}: the plan screen shows no problem`, text.replace(/\s+/g, ' ').slice(0, 300))
  const counts = await page.$eval(T('plan-counts'), (e) => e.innerText)
  check(/(new|changed)/.test(counts) && !/removed/.test(counts), `${label}: the plan lists what is new or changed, and nothing removed`, (await page.$eval(T('plan-counts'), (e) => e.innerText)).replace(/\s+/g, ' '))
  await shot(page, `${shotName}-plan.png`)
  await click(page, T('tpl-install'))
  await page.waitForFunction(() => !document.querySelector('[data-testid="tpl-dialog"]'), { timeout: 60000 })
  return text
}
async function openTemplate(page, id) {
  await page.goto(`${BASE}/#templates`, { waitUntil: 'domcontentloaded' })
  await waitFor(page, T('templates-page'), 30000)
  // the page keeps its search and kind while it stays open
  await click(page, T('tpl-kind-all'))
  if (await page.$eval(T('tpl-search'), (e) => e.value !== '')) {
    await page.focus(T('tpl-search'))
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control')
    await page.keyboard.press('Backspace')
  }
  await click(page, T(`tpl-card-${id}`))
  await page.waitForSelector(`${T('tpl-detail')}[data-template="${id}"]`, { visible: true, timeout: 20000 })
}
async function appDef(id) { return (await q(`SELECT definition FROM ${S}.ab_apps WHERE id = $1`, [id]))[0].definition }

/* ------------------------------------------------------------------ main */

let failed = false
try {
  await maint(`DROP DATABASE IF EXISTS "${DB.database}"`)
  await start()
  const setupCode = app.services.setupCode.current() ?? ''
  await api('POST', '/setup/database', { setupCode, host: DB.host, port: DB.port, database: DB.database, user: DB.user, password: DB.password, createDatabase: true })
  await api('POST', '/setup/admin', { setupCode, ...ADMIN })
  await api('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password })

  log('setup: what exists before (tables with rows, a role, two apps, a flow)')
  const tickets = await api('POST', '/tables', { displayName: 'Tickets', name: 'Tickets', columns: [
    { name: 'Title', displayName: 'Title', type: 'text', required: true }, { name: 'State', displayName: 'State', type: 'choice', choices: ['Open', 'Closed'] }, { name: 'Body', displayName: 'Body', type: 'multiline' },
  ] })
  const requests = await api('POST', '/tables', { displayName: 'Requests', name: 'Requests', columns: [{ name: 'Title', displayName: 'Title', type: 'text', required: true }, { name: 'Status', displayName: 'Status', type: 'text' }] })
  const customers = await api('POST', '/tables', { displayName: 'Customers', name: 'Customers', columns: [{ name: 'Name', displayName: 'Name', type: 'text', required: true }] })
  for (let i = 0; i < 3; i++) await api('POST', '/data/Tickets/rows', { values: { Title: `Ticket ${i}`, State: 'Open', Body: `Body ${i}` } })
  await api('POST', '/data/Requests/rows', { values: { Title: 'An old request', Status: 'New' } })
  await api('POST', '/data/Customers/rows', { values: { Name: 'An existing customer' } })
  await api('POST', '/roles', { name: 'Field staff', apps: 'all', privileges: [{ table: tickets.id, create: true, read: 'own', update: 'own', delete: 'none' }] })
  await api('POST', '/apps', { name: 'Existing app', width: 1920, height: 1080 })
  const target = await api('POST', '/apps', { name: 'Template target', width: 1920, height: 1080 })
  await api('POST', '/flows', { name: 'Existing flow', trigger: { type: 'manual', inputs: [], from: 'any' }, steps: [{ id: 'f', name: 'F', kind: 'compose', value: '"x"' }] })
  const before = await snapshot()
  const targetBefore = await appDef(target.id)
  log(`snapshot: ${before.size} things that exist`)

  browser = await puppeteer.launch({ executablePath: E.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1000'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000 })
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.accept())
  if (E.DEBUG_WS) {
    const cdp = await page.createCDPSession()
    await cdp.send('Network.enable')
    cdp.on('Network.webSocketFrameReceived', (f) => { if (/"env"/.test(f.response.payloadData)) log(`ws <- ${f.response.payloadData.slice(0, 200)}`) })
    cdp.on('Network.webSocketCreated', (f) => log(`ws created ${f.url}`))
  }
  await signIn(page, ADMIN)

  // the catalogue page
  await page.goto(`${BASE}/#templates`, { waitUntil: 'domcontentloaded' })
  await waitFor(page, T('templates-page'), 30000)
  const cards = await page.$$eval('[data-testid^="tpl-card-"]', (els) => els.map((e) => e.getAttribute('data-testid')))
  // P3-M1 added two solution templates (checked by p3-templates.mjs); the four P2 kinds are counted here
  const p2cards = cards.filter((c) => !/builtin.(business-model|visitor-log)$/.test(c))
  check(p2cards.length === 4, 'the Templates page (live in Dev mode) lists the four built-in templates of the P2 kinds', p2cards.join(', '))
  await click(page, T('tpl-kind-dataModel'))
  check((await page.$$('[data-testid^="tpl-card-"]')).length === 1, 'kinds filter the catalogue')
  await click(page, T('tpl-kind-all'))
  await page.type(T('tpl-search'), 'tracker')
  check((await page.$$('[data-testid^="tpl-card-"]')).length === 1, 'search filters the catalogue')
  await shot(page, 'catalogue.png')

  // 1. app template: the clash resolved by mapping to the existing table
  await openTemplate(page, 'builtin.request-tracker')
  const detail = await page.$eval(T('tpl-detail'), (e) => e.innerText)
  check(/what it contains/i.test(detail) && /what it needs/i.test(detail) && /built in/i.test(detail), 'the detail view says what it contains, what it needs, and that it is verified', detail.replace(/\s+/g, ' ').slice(0, 200))
  await click(page, T('tpl-use'))
  await waitFor(page, T('tpl-clash-Requests'))
  await idle(page)
  check(true, 'app template: the binding step shows the Requests name clash with its two ways out')
  await shot(page, 'app-clash.png')
  await click(page, T('tpl-clash-map-Requests'))
  await idle(page)
  await page.waitForFunction(() => document.querySelector('[data-testid="tpl-col-Requests-Status"]')?.value === 'Status', { timeout: 20000 })
  check(true, 'app template: mapped to the existing Requests, its columns matched (Title, Status)')
  await reviewAndInstall(page, 'app template', 'app')
  const trackerApp = (await q(`SELECT id, definition FROM ${S}.ab_apps WHERE name = 'Request tracker'`))[0]
  check(trackerApp && JSON.stringify(trackerApp.definition).includes('Filter(Requests,') && !JSON.stringify(trackerApp.definition).includes('Slot_'), 'app template: the new app reads the existing Requests table (formulas rewritten)')

  // 2. data model template: the clash resolved by installing under another name, with SAMPLE rows
  await openTemplate(page, 'builtin.customers-contacts')
  await click(page, T('tpl-use'))
  await waitFor(page, T('tpl-clash-Customers'))
  await idle(page)
  await click(page, T('tpl-clash-rename-Customers'))
  await idle(page)
  await page.waitForFunction(() => document.querySelector('[data-testid="tpl-slot-name-Customers"]')?.value === 'Customers2', { timeout: 20000 })
  // the sample app's Contacts table exists in a new install: that clash is resolved the same way
  if (await page.$(T('tpl-clash-Contacts'))) { await click(page, T('tpl-clash-rename-Contacts')); await idle(page) }
  await click(page, T('tpl-sample'))
  await idle(page)
  check(true, 'data model template: the Customers clash resolved by another name (Customers2), SAMPLE rows ticked')
  const dmPlan = await reviewAndInstall(page, 'data model template', 'datamodel')
  check(/SAMPLE/.test(dmPlan), 'data model template: the plan says the SAMPLE rows go in')
  const c2 = (await q(`SELECT source FROM ${S}.ab_tables WHERE name = 'Customers2'`))[0]
  const sample = c2 ? await q(`SELECT "Name" FROM ${S}."${c2.source}"`) : []
  check(sample.length === 3 && sample.every((r) => r.Name.startsWith('SAMPLE ')), 'data model template: three tables, the SAMPLE rows (marked SAMPLE) in Customers2', sample.map((r) => r.Name).join(', '))
  check((await q(`SELECT count(*)::int AS n FROM ${S}.ab_relationships r JOIN ${S}.ab_tables t ON t.id = r.to_table WHERE t.name = 'Customers2'`))[0].n === 2, 'data model template: the relationships to Customers2 exist')

  // 3. a blocked install: an unmapped required slot column
  await openTemplate(page, 'builtin.request-tracker')
  await click(page, T('tpl-use'))
  await waitFor(page, T('tpl-slot-Requests'))
  await idle(page)
  await pick(page, T('tpl-slot-mode-Requests'), 'map')
  await pick(page, T('tpl-slot-table-Requests'), tickets.id)
  await waitFor(page, T('tpl-col-problem-Requests-Status'))
  const why = await page.$eval(T('tpl-col-problem-Requests-Status'), (e) => e.innerText)
  check(/Choose the column of Tickets for Status \(required\)/.test(why), 'blocked: the unmapped required column is named in words', why)
  await click(page, T('tpl-review'))
  await waitFor(page, T('plan-problems'))
  check(await page.$eval(T('tpl-install'), (b) => b.disabled), 'blocked: the plan screen lists the problem and Install stays disabled', (await page.$eval(T('plan-problems'), (e) => e.innerText)).replace(/\s+/g, ' ').slice(0, 200))
  await shot(page, 'blocked.png')
  await page.keyboard.press('Escape')
  await sleep(400)

  // 4. UI component template, from the Studio's Insert pane (into the current screen of "Template target")
  await page.goto(`${BASE}/#studio-${target.id}`, { waitUntil: 'domcontentloaded' })
  await waitFor(page, T('studio-root'), 30000)
  await click(page, T('rail-insert'))
  await click(page, T('insert-from-template'))
  await click(page, T('studio-template-builtin.approval-bar'))
  await waitFor(page, T('tpl-slot-Request'))
  await idle(page)
  check((await page.$eval(T('tpl-slot-mode-Request'), (e) => e.value)) === 'create', 'UI component template: the binding step offers a new Decisions table')
  await reviewAndInstall(page, 'UI component template', 'component')
  await page.waitForFunction(() => !!document.querySelector('[data-testid="studio-root"]'), { timeout: 20000 })
  let saved = null
  for (let i = 0; i < 60 && !saved; i++) { const d = await appDef(target.id); if (JSON.stringify(d).includes('ApprovalBar')) saved = d; else await sleep(500) }
  check(saved && JSON.stringify(saved).includes('Filter(Decisions, Status = \\"Pending\\")'), 'UI component template: the UI components are in the current screen, bound to Decisions (saved)')
  await sleep(1500)
  await click(page, T('rail-debug'))
  await sleep(500)
  let debugText = await page.$eval(T('pane-debug'), (e) => e.innerText).catch(() => '')
  const errBtn = await page.evaluateHandle(() => [...document.querySelectorAll('button, span, div')].find((e) => /^\d+ errors?$/.test((e.textContent ?? '').trim()) && e.children.length <= 2))
  if (errBtn && errBtn.asElement()) {
    await errBtn.asElement().click().catch(() => undefined)
    await sleep(500)
    debugText += ` | ${await page.evaluate(() => [...document.querySelectorAll('[role="dialog"], [data-radix-popper-content-wrapper], [role="menu"]')].map((e) => e.innerText).join(' / '))}`
  }
  const title = await page.evaluate(() => [...document.querySelectorAll('[data-canvas-viewport] *')].map((e) => e.textContent ?? '').find((t) => t.startsWith('Waiting for a decision')) ?? '')
  check(/Waiting for a decision: 0/.test(title) && !/isn't recognised|FORMULAS/.test(debugText), 'UI component template: the inserted UI components work on the canvas (no formula errors)', `${title} | ${debugText.replace(/\s+/g, ' ').slice(0, 300)}`)

  // 5. screen template: Templates page > Use > Open in the Studio, mapped to Tickets (Status -> State)
  await openTemplate(page, 'builtin.list-detail')
  await click(page, T('tpl-use'))
  await waitFor(page, T('tpl-open-studio'))
  await page.select(T('tpl-open-app'), target.id)
  await click(page, T('tpl-open-go'))
  await waitFor(page, T('studio-root'), 30000)
  await waitFor(page, T('tpl-slot-Items'), 30000)
  await idle(page)
  await pick(page, T('tpl-slot-mode-Items'), 'map')
  await pick(page, T('tpl-slot-table-Items'), tickets.id)
  await pick(page, T('tpl-col-Items-Status'), 'State')
  check(!(await page.$(T('tpl-col-problem-Items-Title'))), 'screen template: mapped to Tickets, Title found, Status -> State, Notes left out (optional)')
  await reviewAndInstall(page, 'screen template', 'screen')
  saved = null
  for (let i = 0; i < 60 && !saved; i++) { const d = await appDef(target.id); if (d.screens.some((s) => s.name === 'ListDetail')) saved = d; else await sleep(500) }
  const form = saved && JSON.stringify(saved.screens.find((s) => s.name === 'ListDetail'))
  check(form && form.includes('\\"Tickets\\"') && form.includes('Title, State') && !form.includes('Slot_'), 'screen template: the new screen is in the app, bound to Tickets (saved)')
  await shot(page, 'studio-after.png')

  // the register
  const installs = await q(`SELECT template_id, kind, mode FROM ${S}.ab_template_installs ORDER BY installed_on`)
  check(installs.length === 4 && new Set(installs.map((r) => r.kind)).size === 4, 'the installed-templates register has one install of each kind', installs.map((r) => `${r.kind}:${r.template_id}`).join(', '))
  check((await q(`SELECT count(*)::int AS n FROM ${S}.ab_audit WHERE action = 'template.install'`))[0].n === 4, 'every install is in the audit log')

  // 6. nothing that existed changed
  const after = await snapshot()
  const changed = [...before.entries()].filter(([k, v]) => k !== `app:${target.id}` && after.get(k) !== v).map(([k]) => k)
  check(changed.length === 0, `nothing that existed changed (${before.size - 1} things compared byte for byte)`, changed.join(', '))
  const tAfter = await appDef(target.id)
  const prior = targetBefore.screens.map((s) => ({ ...s, children: tAfter.screens.find((x) => x.id === s.id)?.children.slice(0, s.children.length) }))
  check(JSON.stringify(prior) === JSON.stringify(targetBefore.screens) && tAfter.screens.length === targetBefore.screens.length + 1 && JSON.stringify(tAfter.appProps) === JSON.stringify(targetBefore.appProps),
    'the app the Studio inserted into: its earlier screens and UI components are unchanged (only additions)')
  check(!errors.length, 'no script errors in the browser', errors.slice(0, 3).join(' | '))
} catch (e) {
  failed = true
  console.error(e)
} finally {
  if (browser) {
    const pages = await browser.pages().catch(() => [])
    if (SHOTS && pages[1]) await shot(pages[1], 'failure.png').catch(() => undefined)
    await browser.close().catch(() => undefined)
  }
  await stop().catch(() => undefined)
  if (!E.KEEP) await maint(`DROP DATABASE IF EXISTS "${DB.database}"`).catch((e) => console.error(`could not drop ${DB.database}: ${e.message}`))
}
const bad = results.filter((r) => !r.ok)
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed${failed ? ' (stopped at the first failure)' : ''}`)
process.exit(failed || bad.length ? 1 : 0)
