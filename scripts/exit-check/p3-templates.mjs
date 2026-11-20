#!/usr/bin/env node
/**
 * Phase 3 package M1 (docs/plan/p3-spec.md 5.11 to 5.13, exit check 13 and the mechanics of 10), against a REAL server in
 * a headless browser: a solution template (the built-in Visitor log pack, every component kind) is installed in Linked
 * mode by clicking through the binding step and the plan screen, used, changed locally, upgraded twice (a local change
 * kept, then replaced), its sample data removed, uninstalled keeping tables, installed again as a Copy and uninstalled
 * deleting its tables; the common business model it depends on is installed first and refused to uninstall while the
 * pack needs it. DEVELOPER TOOL (sandbox values only), not part of the product. Re-runnable.
 *
 *   npm run build   (the server serves dist/)
 *   node scripts/exit-check/p3-templates.mjs
 *
 * A server is started in this process (EXIT_PORT, default 5298) on an EMPTY database (EXIT_DB_NAME, default
 * appbuilder_exit_p3tpl: created and dropped here; KEEP=1 keeps it), workspace EXIT_WORKSPACE (default
 * .sandbox/p3m/workspace, emptied). What exists BEFORE (an Accounts table with a row, a Visitors table with a row, a
 * number sequence called "Visitor passes" with another format, a role called Reception, a dashboard, an approval policy,
 * an app, a flow) goes through the API, and so do the parts that are not template mechanics (the approval request, the
 * printed pass, the restricted role's rows, the local changes); every install, upgrade, sample removal and uninstall is
 * clicked through in the browser. The versions 2.0.0 and 2.1.0 are test fixtures (server/core/templates/testdata),
 * registered in this process; they are not built in.
 *
 *  1. the catalogue: two solution templates; the Visitor log detail says what it contains and needs;
 *  2. Use: Linked by default; the business model listed as "installed first"; the shared Companies slot shown; the
 *     Visitors clash resolved with the pack's prefixed name; SAMPLE rows ticked; the plan screen shows the dependency's
 *     plan and the pack's plan grouped by kind, nothing removed; Install (one transaction, pre-install backup); the
 *     "Switch on these flows" step (the flow arrived off), ticked and switched on;
 *  3. each part used once: the desktop app shows the SAMPLE visits; the phone app opens at 390x844 with its offline
 *     setting; a visit by a person with the pack's Host role gets the next pass number, goes through the flow to an
 *     approval answered in the browser by reception, and the answer is written back; the Host sees only their own
 *     visits; the dashboard shows its tiles; the pass prints;
 *  4. the business model cannot be uninstalled while the pack needs it (the dialog says why; Uninstall disabled);
 *  5. local changes (the desk app's title, the dashboard); upgrade to 2.0.0 keeps the app and replaces the dashboard
 *     (chosen on the upgrade screen); upgrade to 2.1.0 replaces the app;
 *  6. "Remove sample data" removes exactly the SAMPLE rows;
 *  7. uninstall keeping the tables with data; a Copy install; uninstall deleting tables with the typed confirmation;
 *     the business model uninstalled last (the Accounts table it mapped is untouched);
 *  8. before/after: everything that existed is byte-equal (apps, tables with definitions, rows and columns, roles,
 *     privileges, user roles, flows, relationships, table events, solutions, dashboards, print templates, approval
 *     policies, number sequences).
 *
 * Settings: EXIT_DB_HOST (127.0.0.1), EXIT_DB_PORT (5435), EXIT_DB_USER (abdev), EXIT_DB_PASSWORD (abdev-sandbox-only),
 * EXIT_DB_NAME, EXIT_MAINT_DB (appbuilder_test), EXIT_PORT (5298), EXIT_WORKSPACE, PUPPETEER_CORE, CHROME_PATH, SHOTS.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { chromePath, puppeteerCorePath } from './browser-env.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const DB = { host: E.EXIT_DB_HOST || '127.0.0.1', port: Number(E.EXIT_DB_PORT || 5435), user: E.EXIT_DB_USER || 'abdev', password: E.EXIT_DB_PASSWORD || 'abdev-sandbox-only', database: E.EXIT_DB_NAME || 'appbuilder_exit_p3tpl' }
const MAINT = E.EXIT_MAINT_DB || 'appbuilder_test'
const PORT = Number(E.EXIT_PORT || 5298)
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = E.SHOTS || ''
const ADMIN = { name: 'Exit Admin', email: 'exit-admin@example.test', password: 'Exit-Example-Pass-2026' }
const HOST = { name: 'Hari Host', email: 'hari@example.test', password: 'Host-Example-Pass-2026' }
const S = 'env_default'
if (!/^(ab_d\d+|ab_s\d+|appbuilder_exit)/.test(DB.database)) { console.error('The database name must start with ab_d<n>, ab_s<n> or appbuilder_exit (it is dropped).'); process.exit(2) }
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) { console.error('Build the app first (npm run build).'); process.exit(2) }

const imp = (p) => import(pathToFileURL(path.join(root, p)).href)
const { createApp } = await imp('server/core/app.ts')
const { serveStatic } = await imp('server/core/static.ts')
const { setQuiet } = await imp('server/core/util.ts').catch(() => ({ setQuiet: null }))
const { Client } = await imp('server/core/kernel-testkit.ts')
const { hashPassword } = await imp('server/core/password.ts')
const { registerTestTemplates } = await imp('server/core/templates/catalogue.ts')
const { visitorLogNext } = await imp('server/core/templates/testdata/visitor-log-next.ts')
const { default: puppeteer } = await import(pathToFileURL(path.join(puppeteerCorePath(root), 'lib/puppeteer/puppeteer-core.js')).href)
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

const DIR = path.resolve(E.EXIT_WORKSPACE || path.join(root, '.sandbox', 'p3m', 'workspace'))
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
const hostApi = new Client(BASE)
async function api(method, p, body, c = admin) {
  const r = await c.req(method, p, body)
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
    if (t.source && def.managed && !def.system && !def.reporting && (t.connection_id ?? 'conn_default') === 'conn_default') {
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
  for (const r of await q(`SELECT id, name, roles::text AS roles, def::text AS def FROM ${S}.ab_dashboards`)) put(`dashboard:${r.id}`, r)
  for (const r of await q(`SELECT id, name, version, doc::text AS doc, published::text AS published FROM ${S}.ab_print_templates`)) put(`print:${r.id}`, r)
  for (const r of await q(`SELECT id, name, definition::text AS definition FROM ${S}.ab_approval_policies`)) put(`policy:${r.id}`, r)
  for (const r of await q(`SELECT * FROM ${S}.sys_number_sequences`)) put(`sequence:${r.id}`, r)
  for (const r of await q(`SELECT id, name, connector, settings::text AS settings, status, is_default FROM ${S}.ab_connections`)) put(`connection:${r.id}`, r)
  return m
}

/* ------------------------------------------------------------------ browser helpers */

let browser = null
const T = (id) => `[data-testid="${id}"]`
const errors = []
async function shot(page, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }) } }
const waitFor = (page, sel, timeout = 20000) => page.waitForSelector(sel, { visible: true, timeout })
async function click(page, sel, timeout = 20000) { await page.waitForSelector(`${sel}:not([disabled])`, { visible: true, timeout }); await (await waitFor(page, sel)).click() }
const idle = (page) => page.waitForFunction(() => { const b = document.querySelector('[data-testid="tpl-review"], [data-testid="tpl-install"], [data-testid="tpl-flows-enable"]'); return !!b && !document.querySelector('[data-testid="tpl-dialog"] .animate-spin') }, { timeout: 30000 })
const text = (page, sel) => page.$eval(sel, (e) => e.innerText)
async function signIn(page, who) {
  await page.goto(`${BASE}/#home`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[type=email]', { timeout: 20000 })
  await page.type('input[type=email]', who.email)
  await page.type('input[type=password]', who.password)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 30000 })
  await sleep(500)
}
async function templatesPage(page) {
  // through another page, so the Templates page mounts again and loads the catalogue and the installed list afresh
  await page.goto(`${BASE}/#home`, { waitUntil: 'domcontentloaded' })
  await sleep(200)
  await page.goto(`${BASE}/#templates`, { waitUntil: 'domcontentloaded' })
  await waitFor(page, T('templates-page'), 30000)
  await page.waitForFunction(() => !document.querySelector('[data-testid="templates-page"] .animate-spin'), { timeout: 30000 })
  await sleep(300)
}
async function openTemplate(page, id) {
  await templatesPage(page)
  await click(page, T('tpl-kind-solution'))
  await click(page, T(`tpl-card-${id}`))
  await page.waitForSelector(`${T('tpl-detail')}[data-template="${id}"]`, { visible: true, timeout: 20000 })
}
const installRows = () => q(`SELECT * FROM ${S}.ab_template_installs ORDER BY installed_on`)
const tableOf = async (name) => (await q(`SELECT id, source, def FROM ${S}.ab_tables WHERE lower(name) = lower($1)`, [name]))[0]
const appDef = async (id) => (await q(`SELECT definition FROM ${S}.ab_apps WHERE id = $1`, [id]))[0]?.definition
/** the dialog of an installed row: wait until the plan is there (no spinner) */
async function rowDialog(page, button, dialog) {
  await click(page, T(button))
  await waitFor(page, T(dialog))
  await page.waitForFunction((d) => { const x = document.querySelector(`[data-testid="${d}"]`); return !!x && !x.querySelector('.animate-spin') }, { timeout: 30000 }, dialog)
  await sleep(300)
}

/* ------------------------------------------------------------------ main */

let failed = false
try {
  await maint(`DROP DATABASE IF EXISTS "${DB.database}"`)
  await start()
  const setupCode = app.services.setupCode.current() ?? ''
  await api('POST', '/setup/database', { setupCode, host: DB.host, port: DB.port, database: DB.database, user: DB.user, password: DB.password, createDatabase: true })
  await api('POST', '/setup/admin', { setupCode, ...ADMIN })
  await api('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password })

  log('setup: what exists before')
  const accounts = await api('POST', '/tables', { displayName: 'Accounts', name: 'Accounts', columns: [{ name: 'Name', displayName: 'Name', type: 'text', required: true }, { name: 'Industry', displayName: 'Industry', type: 'text' }] })
  await api('POST', '/data/Accounts/rows', { values: { Name: 'Existing Pvt Ltd', Industry: 'Steel' } })
  await api('POST', '/tables', { displayName: 'Visitors', name: 'Visitors', columns: [{ name: 'Who', displayName: 'Who', type: 'text' }] })
  await api('POST', '/data/Visitors/rows', { values: { Who: 'Someone from before' } })
  await api('POST', '/data/NumberSequences/rows', { values: { Name: 'Visitor passes', Prefix: 'V-', Padding: 3, NextValue: 41 } })
  await api('POST', '/roles', { name: 'Reception', apps: 'all', privileges: [] })
  await api('POST', '/dashboards', { name: 'Existing board', def: { version: 1, title: 'Existing board', range: 'thisMonth', tiles: [] } })
  await api('POST', '/approvals/policies', { name: 'Existing policy', definition: { type: 'single', approvers: ['manager'] } })
  await api('POST', '/apps', { name: 'Existing app', width: 1920, height: 1080 })
  await api('POST', '/flows', { name: 'Existing flow', trigger: { type: 'manual', inputs: [], from: 'any' }, steps: [{ id: 'f', name: 'F', kind: 'compose', value: '"x"' }] })
  const hari = await api('POST', '/users', { name: HOST.name, email: HOST.email, password: HOST.password, roleIds: [] })
  await q('UPDATE ab.users SET must_change_password = false, password_hash = $1 WHERE email = $2', [await hashPassword(HOST.password), HOST.email])
  const before = await snapshot()
  log(`snapshot: ${before.size} things that exist`)

  browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1000'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000 })
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.accept())
  await signIn(page, ADMIN)

  // 1. the catalogue
  await templatesPage(page)
  await click(page, T('tpl-kind-solution'))
  const cards = await page.$$eval('[data-testid^="tpl-card-"]', (els) => els.map((e) => e.getAttribute('data-testid')))
  check(cards.length === 2 && cards.includes('tpl-card-builtin.visitor-log') && cards.includes('tpl-card-builtin.business-model'), 'the catalogue lists the two solution templates (Solutions kind)', cards.join(', '))
  await openTemplate(page, 'builtin.visitor-log')
  const detail = await text(page, T('tpl-detail'))
  check(/2 apps/.test(detail) && /flow/.test(detail) && /number sequence/.test(detail) && /business-model/.test(detail) && /built in/i.test(detail), 'the detail says what the pack contains (apps, flow, number sequence ...) and that it needs the common business model', detail.replace(/\s+/g, ' ').slice(0, 260))

  // 2. Use: Linked, the dependency, the shared slot, the clash, SAMPLE rows, the plan, Install, Switch on these flows
  await click(page, T('tpl-use'))
  await waitFor(page, T('tpl-clash-Visitors'))
  await idle(page)
  check((await page.$eval(T('tpl-mode'), (e) => e.value)) === 'linked', 'Use: a solution template is Linked by default')
  check((await page.$eval(T('tpl-dep-builtin.business-model'), (e) => e.getAttribute('data-action'))) === 'install', 'Use: the common business model is listed as installed first', (await text(page, T('tpl-deps'))).replace(/\s+/g, ' '))
  check(/Shared with Common business model: its table Accounts/.test(await text(page, T('tpl-slot-shared-Companies'))), 'Use: the shared Companies slot is the business model\'s Accounts (your table, used as it is)')
  check(/Visitor log Visitor passes/.test(await text(page, T('tpl-sequences'))), 'Use: the number sequence clash is resolved by a prefixed name (yours keeps its own)')
  await shot(page, 'use-bind.png')
  await click(page, T('tpl-clash-rename-Visitors'))
  await idle(page)
  await page.waitForFunction(() => document.querySelector('[data-testid="tpl-slot-name-Visitors"]')?.value === 'VisVisitors', { timeout: 20000 })
  await click(page, T('tpl-sample'))
  await idle(page)
  check(true, 'Use: the Visitors clash resolved with the pack prefix (VisVisitors), SAMPLE rows ticked')
  await click(page, T('tpl-review'))
  await waitFor(page, T('tpl-main-plan'))
  await waitFor(page, T('tpl-dep-plan-builtin.business-model'))
  const mainPlan = await text(page, T('tpl-main-plan'))
  check(!(await page.$(`${T('tpl-main-plan')} ${T('plan-problems')}`)) && !/removed/.test(await text(page, `${T('tpl-main-plan')} ${T('plan-counts')}`)), 'the plan screen: no problem, nothing removed', mainPlan.replace(/\s+/g, ' ').slice(0, 200))
  const groups = await page.$$eval(`${T('tpl-main-plan')} [data-testid^="plan-group-"]`, (els) => els.map((e) => e.getAttribute('data-testid').replace('plan-group-', '')))
  check(['table', 'app', 'flow', 'approvalPolicy', 'dashboard', 'printTemplate', 'role', 'numberSequence'].every((k) => groups.includes(k)), 'the plan screen groups the pack\'s components by kind', groups.join(', '))
  check(/arrives turned off/.test(mainPlan) && /SAMPLE rows \(removable\)/.test(mainPlan) && /reference rows/.test(mainPlan) && /backup/i.test(mainPlan), 'the plan says the flow arrives off, the SAMPLE and reference rows, and the backup')
  const backupLine = await text(page, `${T('tpl-main-plan')} ${T('plan-backup')}`)
  await shot(page, 'use-plan.png')
  await click(page, T('tpl-install'))
  await page.waitForFunction(() => document.querySelector('[data-testid="tpl-dialog"]')?.getAttribute('data-step') === 'flows', { timeout: 90000 })
  const rows1 = await installRows()
  const bm = rows1.find((r) => r.template_id === 'builtin.business-model')
  const vl = rows1.find((r) => r.template_id === 'builtin.visitor-log')
  check(bm && vl && vl.mode === 'linked' && vl.solution_id && vl.depends_on[0]?.install === bm.id, 'installed in one go: the business model first, the pack Linked (a versioned solution) depending on it', rows1.map((r) => `${r.template_id}:${r.mode}`).join(', '))
  const backups = (await q(`SELECT count(*)::int AS n FROM ab.backups WHERE trigger = 'pre-upgrade' AND state <> 'failed'`))[0].n
  check(backups >= 1 || /no backup/i.test(backupLine), 'a pre-install backup was taken before the install (or the plan said plainly that backups are not set up here)', `${backups} pre-install backup(s); plan: ${backupLine}`)
  const flowId = vl.created.flows[0].id
  check((await q(`SELECT enabled FROM ${S}.ab_flows WHERE id = $1`, [flowId]))[0].enabled === false, 'the flow arrived turned off; the dialog offers "Switch on these flows"')
  await click(page, T(`tpl-flow-${flowId}`))
  await click(page, T('tpl-flows-enable'))
  await page.waitForFunction(() => !document.querySelector('[data-testid="tpl-dialog"]'), { timeout: 30000 })
  check((await q(`SELECT enabled FROM ${S}.ab_flows WHERE id = $1`, [flowId]))[0].enabled === true && (await q(`SELECT count(*)::int AS n FROM ${S}.ab_audit WHERE action = 'template.flows.enable'`))[0].n === 1, 'the administrator switched the flow on (explicit step, audited)')

  // 3. use each part once
  const desk = vl.created.apps.find((a) => !a.phone)
  const phone = vl.created.apps.find((a) => a.phone)
  await page.goto(`${BASE}/#u-${desk.id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.body.innerText.includes('SAMPLE-0002') && document.body.innerText.includes('In the building'), { timeout: 45000 })
  check(true, 'the desktop app (Reception desk) runs and lists the SAMPLE visits')
  await shot(page, 'desk.png')
  const mobile = await browser.newPage()
  mobile.on('pageerror', (e) => errors.push(e.message))
  await mobile.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await mobile.goto(`${BASE}/#u-${phone.id}`, { waitUntil: 'domcontentloaded' })
  await mobile.waitForFunction(() => document.body.innerText.includes('New visitor') && document.body.innerText.includes('Save visitor'), { timeout: 45000 })
  const phoneDef = await appDef(phone.id)
  check(phoneDef.offline?.entry === true && phoneDef.offline.tables?.[0]?.table === 'VisitPurposes', 'the phone app (Visitor check-in) opens at 390x844; it works offline (entry) with its reference table on the device')
  await shot(mobile, 'phone.png')
  await mobile.close()
  // the pack's roles: reception for the administrator (the approver), Host for Hari (assigning people stays manual)
  const roles = vl.created.roles
  const me = (await q(`SELECT id FROM ab.users WHERE email = $1`, [ADMIN.email]))[0]
  const myRoles = (await q(`SELECT role_id FROM ${S}.ab_user_roles WHERE user_id = $1`, [me.id])).map((r) => r.role_id)
  await api('PATCH', `/users/${me.id}`, { roleIds: [...myRoles, roles.find((r) => r.key === 'Reception').id] })
  await api('PATCH', `/users/${hari.id}`, { roleIds: [roles.find((r) => r.key === 'Host').id] })
  await api('POST', '/auth/login', { email: HOST.email, password: HOST.password }, hostApi)
  // the Host role does not see visitors' phone numbers (column security of the pack): writing one is refused too
  const withPhone = await hostApi.req('POST', '/data/VisVisitors/rows', { values: { FullName: 'Neha Shah', Phone: '+91 90000 11111' } })
  check(withPhone.status === 403 && /Phone/.test(JSON.stringify(withPhone.data)), 'the Host role has no access to the Phone column of visitors (column security of the pack)', `${withPhone.status}`)
  const neha = (await api('POST', '/data/VisVisitors/rows', { values: { FullName: 'Neha Shah' } }, hostApi)).row
  const visit = (await api('POST', '/data/Visits/rows', { values: { Visitor: neha.id, Status: 'Expected', Approval: 'Pending', Arrival: new Date().toISOString() } }, hostApi)).row
  check(visit.PassNumber === 'VIS-0001', 'numbering: the visit gets the pack\'s number sequence (VIS-0001)', visit.PassNumber)
  let req = null
  for (let i = 0; i < 80 && !req; i++) { req = (await q(`SELECT id, status FROM ${S}.ab_approval_requests WHERE title = $1`, [`Visitor pass ${visit.PassNumber}`]))[0]; if (!req) await sleep(500) }
  check(req, 'the flow started an approval for the visit (policy: reception)')
  await page.goto(`${BASE}/#u-approvals?id=${req.id}`, { waitUntil: 'domcontentloaded' })
  await waitFor(page, T('approval-detail'), 30000)
  await click(page, T('approval-answer-Approve'))
  let approved = null
  for (let i = 0; i < 80 && !approved; i++) { approved = (await q(`SELECT "Approval" FROM ${S}."${(await tableOf('Visits')).source}" WHERE id = $1 AND "Approval" = 'Approved'`, [visit.id]))[0]; if (!approved) await sleep(500) }
  check(approved, 'reception approved it in the browser; the flow wrote the answer back on the visit')
  const hostRows = await api('POST', '/query', { plan: { version: 2, table: 'Visits', select: ['id', 'PassNumber'] } }, hostApi)
  check(hostRows.rows.length === 1 && hostRows.rows[0].id === visit.id, 'the Host role sees only its own visits (own-rows rule)', hostRows.rows.map((r) => r.PassNumber).join(', '))
  const dashId = vl.created.dashboards[0].id
  await page.goto(`${BASE}/#u-dashboards?d=${dashId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.body.innerText.includes('Visits by status'), { timeout: 45000 })
  check(true, 'the dashboard (Visitor log: Visitors) shows its tiles')
  await shot(page, 'dashboard.png')
  const pass = await api('POST', '/print/generate', { template: vl.created.printTemplates[0].id, recordId: visit.id })
  check(/VIS-0001/.test(JSON.stringify(pass.file)), 'the visitor pass prints from the record', JSON.stringify(pass.file).slice(0, 160))

  // 4. the dependency cannot go while the pack needs it
  await templatesPage(page)
  await rowDialog(page, `tpl-uninstall-${bm.id}`, 'tpl-uninstall')
  check(/Visitor log needs this template/.test(await text(page, T('tpl-uninstall-problems'))) && await page.$eval(T('tpl-uninstall-go'), (b) => b.disabled), 'the business model cannot be uninstalled while the pack needs it (Uninstall disabled, the reason shown)')
  await page.keyboard.press('Escape')
  await sleep(400)

  // 5. local changes; upgrade 2.0.0 (app kept, dashboard replaced by choice); upgrade 2.1.0 (app replaced)
  const def = await appDef(desk.id)
  def.screens[0].children.find((c) => c.name === 'DeskTitle').props.Text = '="Our front desk"'
  await api('PUT', `/apps/${desk.id}`, { definition: def })
  const dd = (await q(`SELECT def FROM ${S}.ab_dashboards WHERE id = $1`, [dashId]))[0].def
  await api('PATCH', `/dashboards/${dashId}`, { def: { ...dd, description: 'Changed here' } })
  const unreg = [registerTestTemplates([visitorLogNext('2.0.0')])]
  await templatesPage(page)
  await rowDialog(page, `tpl-upgrade-${vl.id}`, 'tpl-upgrade')
  const lc = await text(page, T('tpl-local-changes'))
  check(/App Reception desk/.test(lc) && /Dashboard Visitor log: Visitors/.test(lc), 'upgrade to 2.0.0: the local changes are listed (the desk app, the dashboard), kept by default', lc.replace(/\s+/g, ' '))
  check(/Minutes on site: no longer used/.test(await text(page, T('tpl-no-longer-used'))), 'upgrade: a column the new version drops is kept and listed')
  await page.select(T(`tpl-local-dashboard:${dashId}`), 'replace')
  await page.waitForFunction(() => { const d = document.querySelector('[data-testid="tpl-upgrade"]'); return !!d && !d.querySelector('.animate-spin') && !!d.querySelector('[data-testid="solution-plan"]') }, { timeout: 30000 })
  await sleep(300)
  await shot(page, 'upgrade-2.png')
  await click(page, T('tpl-upgrade-go'))
  await page.waitForFunction(() => !document.querySelector('[data-testid="tpl-upgrade"]'), { timeout: 90000 })
  const dash2 = (await q(`SELECT def FROM ${S}.ab_dashboards WHERE id = $1`, [dashId]))[0].def
  const visitorsCols = (await tableOf('VisVisitors')).def.columns.map((c) => c.name)
  const seq = (await q(`SELECT "Padding", "NextValue" FROM ${S}.sys_number_sequences WHERE "Name" = 'Visitor log Visitor passes'`))[0]
  check(JSON.stringify(await appDef(desk.id)).includes('Our front desk') && dash2.tiles.length === 3 && !dash2.description && visitorsCols.includes('Badge') && Number(seq.Padding) === 5 && Number(seq.NextValue) === 2,
    'upgraded to 2.0.0: the app kept local, the dashboard replaced, the new column added, the sequence format changed and its next value kept', `tiles ${dash2.tiles.length}, seq ${JSON.stringify(seq)}`)
  unreg.push(registerTestTemplates([visitorLogNext('2.1.0')]))
  await templatesPage(page)
  await rowDialog(page, `tpl-upgrade-${vl.id}`, 'tpl-upgrade')
  await page.select(T(`tpl-local-app:${desk.id}`), 'replace')
  await page.waitForFunction(() => { const d = document.querySelector('[data-testid="tpl-upgrade"]'); return !!d && !d.querySelector('.animate-spin') && !!d.querySelector('[data-testid="solution-plan"]') }, { timeout: 30000 })
  await sleep(300)
  await click(page, T('tpl-upgrade-go'))
  await page.waitForFunction(() => !document.querySelector('[data-testid="tpl-upgrade"]'), { timeout: 90000 })
  const deskNow = JSON.stringify(await appDef(desk.id))
  check(deskNow.includes('Front desk') && !deskNow.includes('Our front desk') && (await installRows()).find((r) => r.id === vl.id).template_version === '2.1.0', 'upgraded to 2.1.0: the local change to the app replaced by choice')

  // 6. Remove sample data
  await templatesPage(page)
  await rowDialog(page, `tpl-sample-remove-${vl.id}`, 'tpl-sample-dialog')
  await click(page, T('tpl-sample-go'))
  await page.waitForFunction(() => !document.querySelector('[data-testid="tpl-sample-dialog"]'), { timeout: 30000 })
  const visits = await q(`SELECT "PassNumber" FROM ${S}."${(await tableOf('Visits')).source}"`)
  const people = await q(`SELECT "FullName" FROM ${S}."${(await tableOf('VisVisitors')).source}"`)
  check(!visits.some((r) => r.PassNumber.startsWith('SAMPLE')) && visits.length === 1 && people.map((r) => r.FullName).join() === 'Neha Shah', '"Remove sample data" removed exactly the SAMPLE rows; the rows people added stay', `${visits.map((r) => r.PassNumber)} | ${people.map((r) => r.FullName)}`)

  // 7. uninstall keeping tables; a Copy; uninstall deleting tables; the business model last
  await templatesPage(page)
  await rowDialog(page, `tpl-uninstall-${vl.id}`, 'tpl-uninstall')
  const items = await text(page, T('tpl-uninstall-items'))
  check(/Reception desk/.test(items) && /Approve visits/.test(items) && /Visitor pass/.test(items) && /kept with its/.test(items), 'uninstall: apps, flows, roles, policies, dashboards and print templates go; tables with data are kept', items.replace(/\s+/g, ' ').slice(0, 240))
  await click(page, T('tpl-uninstall-go'))
  await page.waitForFunction(() => !document.querySelector('[data-testid="tpl-uninstall"]'), { timeout: 60000 })
  check(!(await appDef(desk.id)) && !(await q(`SELECT 1 FROM ${S}.ab_flows WHERE id = $1`, [flowId])).length && (await tableOf('Visits')), 'uninstalled: the apps and the flow are gone, the Visits table (with data) is kept')
  // a Copy (not linked): every pack table exists now under its name: the clashes are resolved with the prefix
  await openTemplate(page, 'builtin.visitor-log')
  await click(page, T('tpl-use'))
  await waitFor(page, T('tpl-mode'))
  await idle(page)
  await page.select(T('tpl-mode'), 'copy')
  await idle(page)
  for (const slot of ['VisitPurposes', 'Visitors', 'Visits']) if (await page.$(T(`tpl-clash-${slot}`))) { await click(page, T(`tpl-clash-rename-${slot}`)); await idle(page) }
  await click(page, T('tpl-review'))
  await waitFor(page, T('tpl-main-plan'))
  check(!(await page.$(`${T('tpl-main-plan')} ${T('plan-problems')}`)), 'a Copy: the clashes with the kept tables resolved by prefixed names; the plan has no problem')
  await click(page, T('tpl-install'))
  await page.waitForFunction(() => document.querySelector('[data-testid="tpl-dialog"]')?.getAttribute('data-step') === 'flows', { timeout: 90000 })
  await click(page, T('tpl-flows-later'))
  await page.waitForFunction(() => !document.querySelector('[data-testid="tpl-dialog"]'), { timeout: 30000 })
  const copy = (await installRows()).find((r) => r.template_id === 'builtin.visitor-log' && r.mode === 'copy')
  check(copy && !copy.solution_id && copy.depends_on[0]?.install === bm.id, 'a Copy installed: no solution record (no upgrades), the business model already here is reused')
  await templatesPage(page)
  await rowDialog(page, `tpl-uninstall-${copy.id}`, 'tpl-uninstall')
  await click(page, T('tpl-uninstall-delete'))
  await page.waitForFunction(() => { const d = document.querySelector('[data-testid="tpl-uninstall"]'); return !!d && !d.querySelector('.animate-spin') && !!d.querySelector('[data-testid="tpl-uninstall-confirm-text"]') }, { timeout: 30000 })
  check(await page.$eval(T('tpl-uninstall-go'), (b) => b.disabled), 'deleting tables with data needs the typed confirmation (Uninstall disabled until then)')
  await page.type(T('tpl-uninstall-confirm-text'), copy.name)
  await click(page, T('tpl-uninstall-go'))
  await page.waitForFunction(() => !document.querySelector('[data-testid="tpl-uninstall"]'), { timeout: 60000 })
  const gone = []
  for (const t of copy.created.tables) if ((await q(`SELECT 1 FROM ${S}.ab_tables WHERE id = $1`, [t.id])).length) gone.push(t.name)
  check(!gone.length, 'uninstalled with "Delete tables with data": the Copy\'s tables are deleted', gone.join(', '))
  await templatesPage(page)
  await rowDialog(page, `tpl-uninstall-${bm.id}`, 'tpl-uninstall')
  check(!(await page.$(T('tpl-uninstall-problems'))), 'the business model can be uninstalled now that nothing needs it')
  await click(page, T('tpl-uninstall-go'))
  await page.waitForFunction(() => !document.querySelector('[data-testid="tpl-uninstall"]'), { timeout: 60000 })
  check(!(await tableOf('Products')) && (await tableOf('Accounts'))?.id === accounts.id, 'the business model uninstalled: its own empty tables dropped, the Accounts table it mapped untouched')
  for (const f of unreg) f()

  // 8. nothing that existed changed
  const after = await snapshot()
  const changed = [...before.entries()].filter(([k, v]) => after.get(k) !== v).map(([k]) => k)
  check(changed.length === 0, `nothing that existed changed (${before.size} things compared byte for byte, dashboards, print templates, policies and number sequences included)`, changed.join(', '))
  const audit = (await q(`SELECT action, count(*)::int AS n FROM ${S}.ab_audit WHERE action LIKE 'template.%' GROUP BY action ORDER BY action`)).map((r) => `${r.action} ${r.n}`)
  check(audit.join('|') === 'template.flows.enable 1|template.install 3|template.sample.remove 1|template.uninstall 3|template.upgrade 2', 'every install, upgrade, sample removal, flow switch and uninstall is in the audit log', audit.join(', '))
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
