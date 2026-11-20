#!/usr/bin/env node
/**
 * Phase 3 package R, exit check 11 (docs/plan/p3-spec.md): the built-in CRM pack against a REAL server in a headless
 * browser. DEVELOPER TOOL (sandbox values only), not part of the product. Re-runnable.
 *
 *   npm run build   (the server serves dist/)
 *   node scripts/exit-check/p3-crm.mjs
 *
 * A server is started in this process (EXIT_PORT, default 5321) on an EMPTY database (EXIT_DB_NAME, default
 * appbuilder_exit_p3crm: created and dropped here; KEEP=1 keeps it), workspace EXIT_WORKSPACE (default
 * .sandbox/crm/workspace, emptied) and a fake SMTP server. Before the install there is a table called Leads with a row
 * and a role called "Sales rep" (compared byte for byte at the end). Clicked in the browser: the install (Linked, the
 * Leads clash resolved with the pack's prefix, SAMPLE rows, the plan screen, switching on the flows), the sales rep's
 * phone (360 x 800, touch: open a deal, log a call), the manager's approval screen is not needed (answered by the API
 * as the person named), the dashboard page, the upgrade screen, "Remove sample data" and the uninstall.
 *
 *  1. install: Linked, the business model first, the Leads clash -> CrmLeads, "Sales rep" -> "Sales rep (2)", SAMPLE rows,
 *     the plan, Install, Switch on every flow;
 *  2. a lead converts to an account, a contact and an opportunity (once), all the rep's own;
 *  3. who sees what: the rep their own leads, accounts and opportunities, another rep none of them, the manager the
 *     team's, the viewer everything;
 *  4. the pipeline dashboard shows each viewer only their rows (equal to a reference computation), and follows a stage
 *     change; the dashboard page opens;
 *  5. a quote: numbered, totals from its lines, no tax anywhere; a discount above the limit needs an approval (the rep
 *     is refused, a manager approves, the rep is told), and cannot be sent before; the quote prints as a PDF;
 *  6. an email and a WhatsApp message sent from an opportunity (no connection first, then the Email connection and the
 *     fake SMTP server) are logged as activities on its timeline; nothing fails without a connection;
 *  7. the rep's phone (360 x 800): the deal list, a deal, "Log a call" saved to the Activities table on that deal;
 *  8. the stale-deal schedule runs;
 *  9. upgrade to 1.1.0 (a test fixture, registered in this process) keeps the local changes;
 * 10. "Remove sample data" and the uninstall keeping the tables; nothing that existed before changed; audit; no script
 *     errors in the browser.
 *
 * Settings: EXIT_DB_HOST (127.0.0.1), EXIT_DB_PORT (5435), EXIT_DB_USER (abdev), EXIT_DB_PASSWORD (abdev-sandbox-only),
 * EXIT_DB_NAME, EXIT_MAINT_DB (appbuilder_test), EXIT_PORT (5321), EXIT_WORKSPACE, PUPPETEER_CORE, CHROME_PATH, SHOTS.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { chromePath, puppeteerCorePath } from './browser-env.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const DB = { host: E.EXIT_DB_HOST || '127.0.0.1', port: Number(E.EXIT_DB_PORT || 5435), user: E.EXIT_DB_USER || 'abdev', password: E.EXIT_DB_PASSWORD || 'abdev-sandbox-only', database: E.EXIT_DB_NAME || 'appbuilder_exit_p3crm' }
const MAINT = E.EXIT_MAINT_DB || 'appbuilder_test'
const PORT = Number(E.EXIT_PORT || 5321)
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = E.SHOTS || ''
const S = 'env_default'
const PASS = 'Exit-Example-Pass-2026'
const ADMIN = { name: 'Exit Admin', email: 'exit-admin@example.test', password: PASS }
const PEOPLE = {
  rep: { name: 'Ravi Rep', email: 'ravi@example.test', role: 'SalesRep' },
  rep2: { name: 'Rina Rep', email: 'rina@example.test', role: 'SalesRep' },
  mgr: { name: 'Maya Manager', email: 'maya@example.test', role: 'SalesManager' },
  view: { name: 'Vik Viewer', email: 'vik@example.test', role: 'SalesViewer' },
}
if (!/^(ab_d\d+|ab_s\d+|appbuilder_exit)/.test(DB.database)) { console.error('The database name must start with ab_d<n>, ab_s<n> or appbuilder_exit (it is dropped).'); process.exit(2) }
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) { console.error('Build the app first (npm run build).'); process.exit(2) }

const imp = (p) => import(pathToFileURL(path.join(root, p)).href)
const { createApp } = await imp('server/core/app.ts')
const { serveStatic } = await imp('server/core/static.ts')
const { setQuiet } = await imp('server/core/util.ts').catch(() => ({ setQuiet: null }))
const { Client } = await imp('server/core/kernel-testkit.ts')
const { hashPassword } = await imp('server/core/password.ts')
const { startFakeSmtp } = await imp('server/core/identity/fake-smtp.ts')
const { registerTestTemplates } = await imp('server/core/templates/catalogue.ts')
const { crmNext } = await imp('server/core/templates/testdata/crm-next.ts')
const { compileQuery, finishQuery } = await imp('src/dashboards/measures.ts')
const { default: puppeteer } = await import(pathToFileURL(path.join(puppeteerCorePath(root), 'lib/puppeteer/puppeteer-core.js')).href)
if (setQuiet) setQuiet(true)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`)
const results = []
const record = (name, ok, evidence = '') => { results.push({ name, ok, evidence }); log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence ? `: ${evidence}` : ''}`) }
const check = (cond, name, evidence) => { record(name, !!cond, evidence); if (!cond) throw new Error(`check failed: ${name} ${evidence ?? ''}`) }
async function until(fn, what, ms = 45000, step = 400) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(step)
  }
}

async function maint(sql) { const c = new pg.Client({ ...DB, database: MAINT }); await c.connect(); try { await c.query(sql) } finally { await c.end() } }
async function q(sql, params = []) { const c = new pg.Client(DB); await c.connect(); try { return (await c.query(sql, params)).rows } finally { await c.end() } }

/* ------------------------------------------------------------------ server, API */

const DIR = path.resolve(E.EXIT_WORKSPACE || path.join(root, '.sandbox', 'crm', 'workspace'))
if (path.resolve(DIR) === root || !/workspace/i.test(path.basename(DIR))) { console.error('EXIT_WORKSPACE must be a folder named ...workspace... (it is emptied).'); process.exit(2) }
fs.rmSync(DIR, { recursive: true, force: true })
fs.mkdirSync(DIR, { recursive: true })
let app = null
let server = null
let smtp = null
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
const who = {}
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
  for (const r of await q(`SELECT * FROM ${S}.ab_flows`)) put(`flow:${r.id}`, r)
  for (const r of await q(`SELECT * FROM ${S}.ab_relationships`)) put(`relationship:${r.id}`, r)
  for (const r of await q(`SELECT * FROM ${S}.ab_table_events`)) put(`event:${r.id}`, r)
  for (const r of await q(`SELECT id, name, roles::text AS roles, def::text AS def FROM ${S}.ab_dashboards`)) put(`dashboard:${r.id}`, r)
  for (const r of await q(`SELECT id, name, version, doc::text AS doc, published::text AS published FROM ${S}.ab_print_templates`)) put(`print:${r.id}`, r)
  for (const r of await q(`SELECT id, name, definition::text AS definition FROM ${S}.ab_approval_policies`)) put(`policy:${r.id}`, r)
  for (const r of await q(`SELECT * FROM ${S}.sys_number_sequences`)) put(`sequence:${r.id}`, r)
  return m
}

/* ------------------------------------------------------------------ browser helpers */

let browser = null
const T = (id) => `[data-testid="${id}"]`
const errors = []
async function shot(page, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }) } }
const waitFor = (page, sel, timeout = 20000) => page.waitForSelector(sel, { visible: true, timeout })
async function click(page, sel, timeout = 20000) { await page.waitForSelector(`${sel}:not([disabled])`, { visible: true, timeout }); await (await waitFor(page, sel)).click() }
async function tap(page, sel, timeout = 20000) { await page.waitForSelector(`${sel}:not([disabled])`, { visible: true, timeout }); await (await waitFor(page, sel)).tap() }
const idle = (page) => page.waitForFunction(() => { const b = document.querySelector('[data-testid="tpl-review"], [data-testid="tpl-install"], [data-testid="tpl-flows-enable"]'); return !!b && !document.querySelector('[data-testid="tpl-dialog"] .animate-spin') }, { timeout: 30000 })
const text = (page, sel) => page.$eval(sel, (e) => e.innerText)
async function newPage(mobile = false) {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.accept())
  if (mobile) {
    await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36')
    await page.setViewport({ width: 360, height: 800, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  } else await page.setViewport({ width: 1600, height: 1000 })
  return page
}
async function signIn(page, person) {
  await page.goto(`${BASE}/#home`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[type=email]', { timeout: 30000 })
  await page.type('input[type=email]', person.email)
  await page.type('input[type=password]', person.password ?? PASS)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 30000 })
  await sleep(500)
}
async function templatesPage(page) {
  await page.goto(`${BASE}/#home`, { waitUntil: 'domcontentloaded' })
  await sleep(200)
  await page.goto(`${BASE}/#templates`, { waitUntil: 'domcontentloaded' })
  await waitFor(page, T('templates-page'), 30000).catch(async (e) => { log(`the Templates page did not open: ${page.url()} | ${(await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 600)} | errors ${errors.slice(-3).join(' | ')}`); throw e })
  await page.waitForFunction(() => !document.querySelector('[data-testid="templates-page"] .animate-spin'), { timeout: 30000 })
  await sleep(300)
}
async function rowDialog(page, button, dialog) {
  await click(page, T(button))
  await waitFor(page, T(dialog))
  await page.waitForFunction((d) => { const x = document.querySelector(`[data-testid="${d}"]`); return !!x && !x.querySelector('.animate-spin') }, { timeout: 60000 }, dialog)
  await sleep(300)
}
const installRows = () => q(`SELECT * FROM ${S}.ab_template_installs ORDER BY installed_on`)
const tableOf = async (name) => (await q(`SELECT id, name, source, def FROM ${S}.ab_tables WHERE lower(name) = lower($1)`, [name]))[0]
const rowsOf = async (name, where = 'TRUE', params = []) => { const t = await tableOf(name); return q(`SELECT * FROM ${S}."${t.source}" WHERE ${where}`, params) }
const appDef = async (id) => (await q(`SELECT definition FROM ${S}.ab_apps WHERE id = $1`, [id]))[0]?.definition
const notified = async (email, re) => (await q(`SELECT n.title FROM ab.notifications n JOIN ab.users u ON u.id = n.user_id WHERE lower(u.email) = lower($1)`, [email])).filter((n) => re.test(n.title))
const num = (v) => Number(v ?? 0)
const sum = (rows, f) => rows.reduce((a, r) => a + f(r), 0)
const isOpen = (r) => r.Stage !== 'Won' && r.Stage !== 'Lost'

/** a tile computed the way the dashboard viewer does: compile, POST /dashboards/query as the viewer, finish */
async function tileValue(dashId, tileId, c) {
  const def = (await q(`SELECT def FROM ${S}.ab_dashboards WHERE id = $1`, [dashId]))[0].def
  const tile = def.tiles.find((t) => t.id === tileId)
  const ctx = { range: null }
  const comp = compileQuery(tile.query, ctx)
  const r = await api('POST', '/dashboards/query', { queries: [{ id: 'main', plan: comp.main }] }, c)
  const res = r.results[0]
  if (!res.ok) throw new Error(`tile ${tileId}: ${JSON.stringify(res.error)}`)
  return finishQuery(tile.query, ctx, res.rows).rows[0]
}
/** the four KPI tiles against a reference over the rows the viewer may see */
function reference(rows) {
  const open = rows.filter(isOpen)
  const won = rows.filter((r) => r.Stage === 'Won').length, lost = rows.filter((r) => r.Stage === 'Lost').length
  return { open: sum(open, (r) => num(r.Amount)), weighted: sum(open, (r) => num(r.WeightedAmount)), winRate: won + lost ? won / (won + lost) : null, n: rows.length }
}
const near = (a, b) => Math.abs(num(a) - num(b)) < 1e-6

/* ------------------------------------------------------------------ main */

let failed = false
try {
  await maint(`DROP DATABASE IF EXISTS "${DB.database}"`)
  smtp = await startFakeSmtp()
  await start()
  const setupCode = app.services.setupCode.current() ?? ''
  await api('POST', '/setup/database', { setupCode, host: DB.host, port: DB.port, database: DB.database, user: DB.user, password: DB.password, createDatabase: true })
  await api('POST', '/setup/admin', { setupCode, ...ADMIN })
  await api('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password })
  await api('PUT', '/identity/email', { host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'sales@example.test', installName: 'Example Sales Apps', publicUrl: 'https://apps.example.test' })

  log('setup: what exists before (a Leads table with a row, a role called "Sales rep")')
  await api('POST', '/tables', { displayName: 'Leads', name: 'Leads', columns: [{ name: 'Who', displayName: 'Who', type: 'text' }, { name: 'Note', displayName: 'Note', type: 'text' }] })
  await api('POST', '/data/Leads/rows', { values: { Who: 'OLD lead', Note: 'was here before' } })
  await api('POST', '/roles', { name: 'Sales rep', apps: 'all', privileges: [] })
  for (const [k, p] of Object.entries(PEOPLE)) {
    const u = await api('POST', '/users', { name: p.name, email: p.email, password: PASS, roleIds: [] })
    await q('UPDATE ab.users SET must_change_password = false, password_hash = $1 WHERE email = $2', [await hashPassword(PASS), p.email])
    who[k] = { ...p, id: u.id ?? u.user?.id, password: PASS, api: new Client(BASE) }
  }
  const before = await snapshot()
  log(`snapshot: ${before.size} things that exist`)

  browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1000'] })
  const page = await newPage()
  await signIn(page, ADMIN)

  /* 1. install by clicking */
  await templatesPage(page)
  await click(page, T('tpl-kind-solution'))
  await click(page, T('tpl-card-builtin.crm'))
  await page.waitForSelector(`${T('tpl-detail')}[data-template="builtin.crm"]`, { visible: true, timeout: 20000 })
  const detail = await text(page, T('tpl-detail'))
  check(/2 apps/.test(detail) && /7 flows/.test(detail) && /3 roles/.test(detail) && /business-model/.test(detail), 'the catalogue: the CRM pack says what it contains (2 apps, 7 flows, 3 roles) and that it needs the business model', detail.replace(/\s+/g, ' ').slice(0, 300))
  await click(page, T('tpl-use'))
  await waitFor(page, T('tpl-clash-Leads'), 30000)
  await idle(page)
  check((await page.$eval(T('tpl-mode'), (e) => e.value)) === 'linked' && (await page.$eval(T('tpl-dep-builtin.business-model'), (e) => e.getAttribute('data-action'))) === 'install', 'Use: Linked by default; the common business model is installed first')
  check(/Shared with Common business model/.test(await text(page, T('tpl-slot-shared-Accounts'))), 'Use: Accounts is the business model\'s shared table')
  await click(page, T('tpl-clash-rename-Leads'))
  await idle(page)
  await page.waitForFunction(() => document.querySelector('[data-testid="tpl-slot-name-Leads"]')?.value === 'CrmLeads', { timeout: 20000 })
  await click(page, T('tpl-sample'))
  await idle(page)
  record('Use: the Leads clash resolved with the pack prefix (CrmLeads); SAMPLE rows ticked', true)
  await click(page, T('tpl-review'))
  await waitFor(page, T('tpl-main-plan'), 60000)
  const mainPlan = await text(page, T('tpl-main-plan'))
  check(!(await page.$(`${T('tpl-main-plan')} ${T('plan-problems')}`)) && !/removed/.test(await text(page, `${T('tpl-main-plan')} ${T('plan-counts')}`)) && /arrives turned off|arrive turned off/.test(mainPlan) && /SAMPLE rows/.test(mainPlan), 'the plan screen: no problem, nothing removed, flows arrive off, SAMPLE rows listed', mainPlan.replace(/\s+/g, ' ').slice(0, 200))
  await shot(page, 'crm-plan.png')
  await click(page, T('tpl-install'))
  await page.waitForFunction(() => document.querySelector('[data-testid="tpl-dialog"]')?.getAttribute('data-step') === 'flows', { timeout: 120000 })
  const rows1 = await installRows()
  const crm = rows1.find((r) => r.template_id === 'builtin.crm')
  const bm = rows1.find((r) => r.template_id === 'builtin.business-model')
  check(crm && bm && crm.mode === 'linked' && crm.solution_id && crm.depends_on[0]?.install === bm.id, 'installed Linked (a versioned solution) after the business model, in one go')
  const flowIds = crm.created.flows.map((f) => f.id)
  check(flowIds.length === 7 && (await q(`SELECT count(*)::int AS n FROM ${S}.ab_flows WHERE id = ANY($1) AND enabled`, [flowIds]))[0].n === 0, 'the 7 flows arrived turned off')
  for (const id of flowIds) {
    const box = await page.$(T(`tpl-flow-${id}`))
    if (box && (await box.evaluate((e) => e.getAttribute('data-state') !== 'checked'))) await box.click()
  }
  await click(page, T('tpl-flows-enable'))
  await page.waitForFunction(() => !document.querySelector('[data-testid="tpl-dialog"]'), { timeout: 60000 })
  check((await q(`SELECT count(*)::int AS n FROM ${S}.ab_flows WHERE id = ANY($1) AND enabled`, [flowIds]))[0].n === 7, 'the administrator switched every flow on (they validate against this environment)')
  const created = crm.created
  const CONTACTS = bm.created.tables.find((t) => t.slot === 'Contacts').name // the core Contacts table exists, so the business model's is CbmContacts
  const appId = (key) => created.apps.find((a) => a.key === key).id
  const roleId = (key) => created.roles.find((r) => r.key === key).id
  const flowId = (key) => created.flows.find((f) => f.key === key).id
  const printId = (key) => created.printTemplates.find((p) => p.key === key).id
  const dashId = (key) => created.dashboards.find((d) => d.key === key).id
  check(created.roles.find((r) => r.key === 'SalesRep').name === 'Sales rep (2)', 'the pack\'s "Sales rep" role is "Sales rep (2)": the existing role is untouched')
  const sampleCount = Object.values((await q(`SELECT sample_rows FROM ${S}.ab_template_installs WHERE id = $1`, [crm.id]))[0].sample_rows).reduce((n, l) => n + l.length, 0)

  // the first day (manual by design): roles, a team (the rep and the manager), the Email connection later
  for (const p of Object.values(who)) await api('PATCH', `/users/${p.id}`, { roleIds: [roleId(p.role)] })
  await api('POST', '/teams', { name: 'North team', code: 'NORTH', memberIds: [who.rep.id, who.mgr.id] })
  for (const p of Object.values(who)) await api('POST', '/auth/login', { email: p.email, password: PASS }, p.api)
  record('first day: roles assigned, a team (rep + manager): manual steps by design', true)

  /* 2. a lead converts to an account, a contact and an opportunity */
  const lead = (await api('POST', '/data/CrmLeads/rows', { values: { Name: 'Zeta Buyer (SAMPLE test)', Company: 'Zeta Fabrics (fictional)', JobTitle: 'Buyer', Email: 'zeta@example.test', Phone: '+91 90000 99999', Status: 'New', EstimatedValue: 400000 } }, who.rep.api)).row
  await until(async () => (await notified(who.mgr.email, /New lead/)).length, 'the manager told about the new lead')
  check(lead.owner === who.rep.id && (await notified(who.rep.email, /New lead/)).length === 1, 'a new lead belongs to the rep who made it; the rep and the sales managers are told')
  await api('PATCH', `/data/CrmLeads/rows/${lead.id}`, { changes: { Status: 'Converted' } }, who.rep.api)
  const converted = await until(async () => { const r = (await rowsOf('CrmLeads', 'id = $1', [lead.id]))[0]; return r.ConvertedOpportunity ? r : null }, 'the conversion')
  await api('PATCH', `/data/CrmLeads/rows/${lead.id}`, { changes: { Notes: 'a later change' } }, who.rep.api)
  await sleep(1500)
  const accts = await rowsOf('Accounts', `"Name" = 'Zeta Fabrics (fictional)'`)
  const conts = await rowsOf(CONTACTS, `"FullName" = 'Zeta Buyer (SAMPLE test)'`)
  const opps = await rowsOf('Opportunities', `id = $1`, [converted.ConvertedOpportunity])
  check(accts.length === 1 && conts.length === 1 && opps.length === 1 && converted.ConvertedAccount === accts[0].id && conts[0].Account === accts[0].id && opps[0].Account === accts[0].id
    && accts[0].owner === who.rep.id && conts[0].owner === who.rep.id && opps[0].owner === who.rep.id && num(opps[0].Amount) === 400000 && (await rowsOf('Opportunities', `"Name" LIKE 'Zeta%'`)).length === 1,
  'a lead set to Converted created one account, one contact and one opportunity (all the rep\'s own, linked, the estimate as the amount); a later change creates no second set', `${opps[0].Name} ${opps[0].Stage} ${opps[0].Probability}%`)
  const opp = opps[0]
  const acct = accts[0]

  /* 3. who sees what */
  const qv = (c, table, select = ['id']) => c.req('POST', '/query', { plan: { version: 2, table, select } })
  const rep2Acct = (await api('POST', '/data/Accounts/rows', { values: { Name: 'Rina\'s own account (fictional)' } }, who.rep2.api)).row
  const rep2Opp = (await api('POST', '/data/Opportunities/rows', { values: { Name: 'Rina\'s deal (fictional)', Account: rep2Acct.id, Stage: 'Prospect', Amount: 50000, CloseDate: '2026-12-31' } }, who.rep2.api)).row
  const ownOf = async (c, t) => (await qv(c, t)).data.rows?.map((r) => r.id) ?? []
  const repOpps = await ownOf(who.rep.api, 'Opportunities'), rep2Opps = await ownOf(who.rep2.api, 'Opportunities'), mgrOpps = await ownOf(who.mgr.api, 'Opportunities'), viewOpps = await ownOf(who.view.api, 'Opportunities')
  const allOppCount = (await rowsOf('Opportunities')).length
  check(repOpps.includes(opp.id) && !repOpps.includes(rep2Opp.id) && rep2Opps.length === 1 && rep2Opps[0] === rep2Opp.id && repOpps.length === 1, 'a rep sees only their own opportunities (another rep\'s and the SAMPLE ones are not shown)', `rep ${repOpps.length}, other rep ${rep2Opps.length}`)
  check(mgrOpps.includes(opp.id) && !mgrOpps.includes(rep2Opp.id) && mgrOpps.length === 1 && viewOpps.length === allOppCount, 'the manager sees the team\'s (the rep\'s, not the other rep\'s); the viewer sees all of them', `manager ${mgrOpps.length}, viewer ${viewOpps.length}/${allOppCount}`)
  const leadsRep = await ownOf(who.rep.api, 'CrmLeads'), leadsRep2 = await ownOf(who.rep2.api, 'CrmLeads'), acctsRep = await ownOf(who.rep.api, 'Accounts'), acctsRep2 = await ownOf(who.rep2.api, 'Accounts')
  check(leadsRep.length === 1 && leadsRep2.length === 0 && acctsRep.length === 1 && acctsRep[0] === acct.id && acctsRep2.length === 1 && acctsRep2[0] === rep2Acct.id, 'a rep sees only their own leads and accounts', `leads ${leadsRep.length}/${leadsRep2.length}, accounts ${acctsRep.length}/${acctsRep2.length}`)
  const noWrite = await who.view.api.req('POST', '/data/Opportunities/rows', { values: { Name: 'x', Stage: 'Prospect' } })
  check(noWrite.status >= 400, 'the viewer cannot create anything', `status ${noWrite.status}`)

  /* 4. the pipeline dashboard */
  const board = dashId('SalesPipeline')
  const kpis = async (c) => ({ open: (await tileValue(board, 'open', c)).Open, weighted: (await tileValue(board, 'weighted', c)).Weighted, winRate: (await tileValue(board, 'winrate', c)).WinRate })
  const mineOf = async (ids) => (await rowsOf('Opportunities')).filter((r) => ids.includes(r.owner))
  const compare = async (label, c, ids) => {
    const got = await kpis(c), want = reference(ids ? await mineOf(ids) : await rowsOf('Opportunities'))
    const ok = near(got.open, want.open) && near(got.weighted, want.weighted) && (want.winRate == null ? got.winRate == null || num(got.winRate) === 0 : near(got.winRate, want.winRate))
    return { ok, text: `${label}: open ${got.open}/${want.open}, weighted ${got.weighted}/${want.weighted}, win rate ${got.winRate}/${want.winRate}` }
  }
  let tiles = [await compare('rep', who.rep.api, [who.rep.id]), await compare('manager', who.mgr.api, [who.rep.id, who.mgr.id]), await compare('viewer', who.view.api, null), await compare('rep 2', who.rep2.api, [who.rep2.id])]
  check(tiles.every((t) => t.ok), 'the pipeline dashboard: each viewer\'s open pipeline, weighted forecast and win rate equal a reference computation over only the rows that viewer may see', tiles.map((t) => t.text).join('; '))
  await api('PATCH', `/data/Opportunities/rows/${opp.id}`, { changes: { Stage: 'Won' } }, who.rep.api)
  const wonRow = await until(async () => { const r = (await rowsOf('Opportunities', 'id = $1', [opp.id]))[0]; return r.Stage === 'Won' && r.ClosedOn ? r : null }, 'the stage change (probability and closing date)')
  tiles = [await compare('rep', who.rep.api, [who.rep.id]), await compare('manager', who.mgr.api, [who.rep.id, who.mgr.id]), await compare('viewer', who.view.api, null)]
  const repKpi = await kpis(who.rep.api)
  check(num(wonRow.Probability) === 100 && tiles.every((t) => t.ok) && num(repKpi.open) === 0 && num(repKpi.winRate) === 1, 'after the stage change to Won (probability 100, closing date set) the tiles follow: the rep\'s open pipeline is empty and the win rate 100%', tiles.map((t) => t.text).join('; '))
  await api('PATCH', `/data/Opportunities/rows/${opp.id}`, { changes: { Stage: 'Proposal' } }, who.rep.api) // back to an open deal for the next steps
  await until(async () => (await rowsOf('Opportunities', 'id = $1', [opp.id]))[0].Stage === 'Proposal', 'the stage back')
  const mgrPage = await newPage()
  await signIn(mgrPage, who.mgr)
  await mgrPage.goto(`${BASE}/#u-dashboards?d=${board}`, { waitUntil: 'domcontentloaded' })
  await mgrPage.waitForSelector(`${T('tile-open')}[data-state="ready"]`, { timeout: 60000 })
  await sleep(800)
  await shot(mgrPage, 'crm-dashboard.png')
  check(!(await text(mgrPage, T('tile-open'))).match(/error/i), 'the dashboard page opens for the manager and the tiles are ready')
  await mgrPage.close()

  /* 5. a quote: totals, no tax, the discount approval, the PDF */
  const quote = (await api('POST', '/data/Quotes/rows', { values: { Opportunity: opp.id, DiscountPercent: 0 } }, who.rep.api)).row
  check(/^QT\//.test(quote.Number) && quote.owner === who.rep.id && quote.Account === acct.id, 'a quote is numbered from its sequence (QT/<financial year>/), takes the opportunity\'s account, and is the rep\'s', quote.Number)
  await api('POST', '/data/QuoteLines/rows', { values: { Quote: quote.id, Description: 'Service visit (fictional)', Quantity: 2, UnitPrice: 50000 } }, who.rep.api)
  await api('POST', '/data/QuoteLines/rows', { values: { Quote: quote.id, Description: 'Spare kit (fictional)', Quantity: 1, UnitPrice: 20000 } }, who.rep.api)
  const q1 = await until(async () => { const r = (await rowsOf('Quotes', 'id = $1', [quote.id]))[0]; return num(r.Subtotal) === 120000 ? r : null }, 'the subtotal from the lines')
  const qCols = (await tableOf('Quotes')).def.columns.map((c) => c.name.toLowerCase()), lCols = (await tableOf('QuoteLines')).def.columns.map((c) => c.name.toLowerCase())
  check(num(q1.Total) === 120000 && ![...qCols, ...lCols].some((c) => /tax|gst/.test(c)), 'the quote\'s subtotal and total come from its lines (120000), and no table of the quote has a tax or GST column', `subtotal ${q1.Subtotal}, total ${q1.Total}`)
  await api('PATCH', `/data/Quotes/rows/${quote.id}`, { changes: { DiscountPercent: 15 } }, who.rep.api)
  const areq = await until(async () => (await q(`SELECT id FROM ${S}.ab_approval_requests WHERE regarding_id = $1`, [quote.id]))[0], 'the discount approval request')
  const askedFor = async (id) => (await q(`SELECT u.email, a.source FROM ${S}.ab_approval_assignments a JOIN ab.users u ON u.id = a.user_id WHERE a.request_id = $1 AND a.status = 'pending' ORDER BY u.email`, [id])).map((x) => `${x.email}:${x.source}`)
  const asked = await until(async () => { const a = await askedFor(areq.id); return a.length ? a : null }, 'the people asked')
  const q2 = (await rowsOf('Quotes', 'id = $1', [quote.id]))[0]
  const sendEarly = await who.rep.api.req('PATCH', `/data/Quotes/rows/${quote.id}`, { changes: { Status: 'Sent' } })
  const selfTry = await who.rep.api.req('POST', `/approvals/${areq.id}/respond`, { response: 'Approve' })
  const repSets = await who.rep.api.req('PATCH', `/data/Quotes/rows/${quote.id}`, { changes: { Approval: 'Approved', ApprovedDiscount: 15 } })
  check(q2.Approval === 'Pending' && asked.join() === `${who.mgr.email}:role` && sendEarly.status >= 400 && selfTry.status >= 400 && repSets.status >= 400 && num(q2.Total) === 102000,
    'a 15% discount (limit 10%) is marked Pending and asked of the sales manager only; the rep cannot send the quote, approve it, or write the approval columns; the total follows the discount (102000)', `asked ${asked.join(', ')}; send ${sendEarly.status}, answer ${selfTry.status}, write ${repSets.status}`)
  const approved = await who.mgr.api.req('POST', `/approvals/${areq.id}/respond`, { response: 'Approve' })
  const q3 = await until(async () => { const r = (await rowsOf('Quotes', 'id = $1', [quote.id]))[0]; return r.Approval === 'Approved' ? r : null }, 'the approval written back')
  await until(async () => (await notified(who.rep.email, /discount approved/)).length, 'the rep told')
  const sent = await who.rep.api.req('PATCH', `/data/Quotes/rows/${quote.id}`, { changes: { Status: 'Sent' } })
  check(approved.status === 200 && num(q3.ApprovedDiscount) === 15 && sent.status === 200, 'the manager approved; the answer is written back on the quote, the rep is told, and the quote can now be sent')
  const g = await api('POST', '/print/generate', { template: printId('Quote'), recordId: quote.id }, who.rep.api)
  check(/\.pdf/i.test(g.file?.fileName ?? JSON.stringify(g)), 'the quote prints as a PDF from its record (as the rep)', `${g.file?.fileName ?? JSON.stringify(g).slice(0, 60)} (${g.pages ?? g.file?.pages ?? '?'} p.)`)

  /* 6. email and WhatsApp from an opportunity -> activities on its timeline */
  const contact = (await api('POST', `/data/${CONTACTS}/rows`, { values: { FullName: 'Buyer Contact (fictional)', Account: acct.id, Email: 'buyer@example.test' } }, who.rep.api)).row
  const touch = (channel, subject) => api('POST', '/data/Touchpoints/rows', { values: { Subject: subject, Channel: channel, Opportunity: opp.id, Contact: contact.id, Message: 'Hello from the sales desk (fictional)' } }, who.rep.api).then((r) => r.row)
  const settled = async (id) => until(async () => { const r = (await rowsOf('Touchpoints', 'id = $1', [id]))[0]; return r.Status !== 'Queued' && r.Status ? r : null }, 'the touchpoint to settle')
  const t1 = await settled((await touch('Email', 'First email')).id)
  const t2 = await settled((await touch('WhatsApp', 'First WhatsApp')).id)
  await api('POST', '/connections', { name: 'Mail', connector: 'email', settings: {} })
  const t3 = await settled((await touch('Email', 'Second email')).id)
  const mail = await until(() => smtp.inbox.find((m) => m.to.includes('buyer@example.test') && /Second email/.test(m.subject)), 'the email in the fake SMTP inbox', 60000, 250)
  const acts = await until(async () => { const r = await rowsOf('Activities', `"regardingId" = $1`, [opp.id]); return r.length >= 3 ? r : null }, 'three activities on the opportunity')
  const failedRuns = (await q(`SELECT count(*)::int AS n FROM ${S}.ab_flow_runs WHERE flow_id = $1 AND state <> 'succeeded'`, [flowId('LogTouchpoint')]))[0].n
  check(t1.Status === 'Not sent' && t2.Status === 'Logged' && /not send/i.test(t2.Result) && t3.Status === 'Sent' && !!mail && failedRuns === 0,
    'an email without an Email connection is logged as not sent, a WhatsApp message as logged only (the platform sends none), an email with the connection arrives at the contact (fake SMTP); no flow run failed', `${t1.Status} / ${t2.Status} / ${t3.Status}; failed runs ${failedRuns}`)
  check(acts.length === 3 && acts.filter((a) => a.Type === 'Email').length === 2 && acts.some((a) => a.Type === 'Custom' && a.Category === 'WhatsApp') && acts.every((a) => a.owner === who.rep.id),
    'all three are logged as activities on the opportunity\'s timeline (Email x2, WhatsApp as Custom), the rep\'s own', acts.map((a) => `${a.Type}:${a.Subject}`).join(' | '))

  /* 7. the rep's phone */
  const phone = await newPage(true)
  await signIn(phone, who.rep)
  await phone.goto(`${BASE}/?app=${appId('SalesOnTheGo')}`, { waitUntil: 'networkidle2' })
  await phone.waitForFunction((id) => location.hash === `#u-${id}`, { timeout: 20000 }, appId('SalesOnTheGo'))
  await phone.waitForSelector(`${T('data-cards')} [role=listitem]`, { visible: true, timeout: 45000 })
  const surface = await phone.evaluate(() => ({ s: document.querySelector('[data-run-surface]')?.getAttribute('data-run-surface'), touch: document.documentElement.classList.contains('touch'), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
  check(surface.s === 'fluid' && surface.touch && surface.sw <= surface.cw + 1, 'phone: Sales on the go opens from its start address at 360 px, fluid, touch, no sideways scroll; the deal list shows the rep\'s deals as cards', JSON.stringify(surface))
  await shot(phone, 'crm-phone-home.png')
  await sleep(600) // let the layout settle before tapping
  await phone.$eval(`${T('data-cards')} [role=listitem]`, (e) => e.scrollIntoView({ block: 'center' }))
  await tap(phone, `${T('data-cards')} [role=listitem]`)
  await waitFor(phone, T('control-LogCall'), 20000)
  await sleep(600)
  await shot(phone, 'crm-phone-deal.png')
  await tap(phone, T('control-LogCall') + ' button').catch(() => tap(phone, T('control-LogCall')))
  await waitFor(phone, T('control-LogSave'), 20000)
  const subj = `${T('control-LogSubject')} input`
  await waitFor(phone, subj)
  await phone.$eval(subj, (e) => e.scrollIntoView({ block: 'center' }))
  await phone.focus(subj)
  await phone.keyboard.type('Phone call about the quote (fictional)')
  await sleep(400)
  await shot(phone, 'crm-phone-log.png')
  await sleep(300)
  await tap(phone, T('control-LogSave') + ' button').catch(() => tap(phone, T('control-LogSave')))
  const call = await until(async () => (await rowsOf('Activities', `"Type" = 'Call' AND "regardingId" = $1`, [opp.id]))[0], 'the call saved').catch(async (e) => { log(`phone log: ${JSON.stringify(await phone.evaluate((id) => window.__ab.tabs.get(id).getState().debugLog.slice(-8), appId('SalesOnTheGo')).catch((x) => String(x))).slice(0, 900)}`); throw e })
  await sleep(1500)
  const calls = await rowsOf('Activities', `"Type" = 'Call' AND "regardingId" = $1`, [opp.id])
  check(calls.length === 1 && /Phone call/.test(call.Subject) && call.owner === who.rep.id && call.Status === 'Done' && call.regardingTable != null, 'phone: a deal opens from the list; "Log a call" saves one Call activity on that deal (the rep\'s own, done)', `${call.Subject}`)
  await phone.close()

  /* 8. the stale-deal schedule */
  const scheds = (await api('GET', '/admin/schedules')).items
  const stale = scheds.find((s) => s.payload?.flowId === flowId('StaleOpportunity') || String(s.id).includes(flowId('StaleOpportunity')))
  check(stale && /0 9 \* \* 1-6/.test(stale.cron ?? ''), 'the stale-deal flow is scheduled at 09:00 India time, Monday to Saturday', `${stale?.cron} ${stale?.timeZone ?? ''}`)
  await api('POST', `/admin/schedules/${stale.id}/run`)
  await until(async () => (await q(`SELECT count(*)::int AS n FROM ${S}.ab_flow_runs WHERE flow_id = $1 AND state = 'succeeded'`, [flowId('StaleOpportunity')]))[0].n >= 1, 'the stale-deal run')
  record('the stale-deal schedule ran (run now) and succeeded', true)

  /* 9. local changes; upgrade to 1.1.0 */
  const salesId = appId('Sales')
  const def = await appDef(salesId)
  const hdr = (nodes) => { for (const n of nodes) { if (n.name === 'HeaderTitle') return n; const h = hdr(n.children ?? []); if (h) return h } }
  hdr(def.screens).props.Text = '="Our sales desk"'
  await api('PUT', `/apps/${salesId}`, { definition: def })
  const ov = (await q(`SELECT def FROM ${S}.ab_dashboards WHERE id = $1`, [board]))[0].def
  await api('PATCH', `/dashboards/${board}`, { def: { ...ov, description: 'Changed here' } })
  const web = (await rowsOf('LeadSources'))[0]
  await api('PATCH', `/data/LeadSources/rows/${web.id}`, { changes: { Name: 'Local wording' } })
  const seqName = (await q(`SELECT "Name", "NextValue" FROM ${S}.sys_number_sequences WHERE "Name" ILIKE '%quote%'`))[0]
  const unreg = registerTestTemplates([crmNext()])
  await templatesPage(page)
  await rowDialog(page, `tpl-upgrade-${crm.id}`, 'tpl-upgrade')
  const lc = await text(page, T('tpl-local-changes'))
  check(/App/.test(lc) && /Dashboard/.test(lc) && /Reference row/.test(lc), 'upgrade to 1.1.0: the local changes are listed (the app, the dashboard, a reference row), kept by default', lc.replace(/\s+/g, ' ').slice(0, 300))
  await page.select(T(`tpl-local-dashboard:${board}`), 'replace')
  await page.waitForFunction(() => { const d = document.querySelector('[data-testid="tpl-upgrade"]'); return !!d && !d.querySelector('.animate-spin') && !!d.querySelector('[data-testid="solution-plan"]') }, { timeout: 60000 })
  await sleep(300)
  await shot(page, 'crm-upgrade.png')
  await click(page, T('tpl-upgrade-go'))
  await page.waitForFunction(() => !document.querySelector('[data-testid="tpl-upgrade"]'), { timeout: 120000 })
  const dash2 = (await q(`SELECT def FROM ${S}.ab_dashboards WHERE id = $1`, [board]))[0].def
  const leadCols = (await tableOf('CrmLeads')).def.columns.map((c) => c.name)
  const sources = await rowsOf('LeadSources')
  const reasons = await rowsOf('LossReasons')
  const seq = (await q(`SELECT "Padding", "NextValue" FROM ${S}.sys_number_sequences WHERE "Name" = $1`, [seqName.Name]))[0]
  check(JSON.stringify(await appDef(salesId)).includes('Our sales desk') && dash2.tiles.some((t) => t.id === 'bysource') && dash2.description !== 'Changed here' && leadCols.includes('Campaign')
    && sources.some((r) => r.Name === 'Exhibition') && sources.some((r) => r.Name === 'Local wording') && reasons.some((r) => r.Name === 'Timing was wrong') && Number(seq.Padding) === 5 && Number(seq.NextValue) === Number(seqName.NextValue)
    && (await installRows()).find((r) => r.id === crm.id).template_version === '1.1.0',
  'upgraded to 1.1.0: the app kept (local change), the dashboard replaced (chosen), the new column and lead source added, the changed loss reason updated, the changed lead source kept, the quote sequence format changed with its next value kept')
  unreg()

  /* 10. Remove sample data; uninstall keeping tables */
  const sampleIds = (await q(`SELECT sample_rows FROM ${S}.ab_template_installs WHERE id = $1`, [crm.id]))[0].sample_rows
  await templatesPage(page)
  await rowDialog(page, `tpl-sample-remove-${crm.id}`, 'tpl-sample-dialog')
  await click(page, T('tpl-sample-go'))
  await page.waitForFunction(() => !document.querySelector('[data-testid="tpl-sample-dialog"]'), { timeout: 60000 })
  let left = 0
  for (const [tid, ids] of Object.entries(sampleIds)) { const t = (await q(`SELECT source FROM ${S}.ab_tables WHERE id = $1`, [tid]))[0]; left += (await q(`SELECT count(*)::int AS n FROM ${S}."${t.source}" WHERE id::text = ANY($1::text[])`, [ids]))[0].n }
  const kept = (await rowsOf('Opportunities', 'id = ANY($1)', [[opp.id, rep2Opp.id]])).length === 2 && (await rowsOf('Quotes', 'id = $1', [quote.id])).length === 1 && (await rowsOf('CrmLeads', 'id = $1', [lead.id])).length === 1 && (await rowsOf('Activities', `"regardingId" = $1`, [opp.id])).length >= 4
  check(left === 0 && kept && (await rowsOf('SalesStages')).length >= 6, '"Remove sample data" removed exactly the SAMPLE rows; the rows people added and the reference rows stay', `${sampleCount} SAMPLE rows removed`)
  await templatesPage(page)
  await rowDialog(page, `tpl-uninstall-${crm.id}`, 'tpl-uninstall')
  const items = await text(page, T('tpl-uninstall-items'))
  check(/Sales/.test(items) && /kept with its/.test(items), 'uninstall: the apps, flows, roles, policy, dashboard and print template go; tables with data are kept', items.replace(/\s+/g, ' ').slice(0, 200))
  const uplan = await api('POST', `/templates/installed/${crm.id}/uninstall/plan`, {})
  check(!uplan.problems.length && !(await page.$eval(T('tpl-uninstall-go'), (b) => b.disabled)), 'the uninstall plan has no problem and can be confirmed', JSON.stringify(uplan.problems).slice(0, 200))
  await click(page, T('tpl-uninstall-go'))
  await page.waitForFunction(() => !document.querySelector('[data-testid="tpl-uninstall"]'), { timeout: 90000 })
  check(!(await appDef(appId('Sales'))) && !(await appDef(appId('SalesOnTheGo'))) && !(await q(`SELECT 1 FROM ${S}.ab_flows WHERE id = ANY($1)`, [flowIds])).length && (await tableOf('Opportunities')) && (await tableOf('Quotes')) && (await tableOf('CrmLeads')), 'uninstalled: apps and flows gone, the tables with data (Opportunities, Quotes, Leads) kept')

  /* 11. nothing that existed changed */
  const after = await snapshot()
  const changed = [...before.entries()].filter(([k, v]) => after.get(k) !== v).map(([k]) => k)
  check(changed.length === 0, `nothing that existed before changed (${before.size} things compared byte for byte, the old Leads table and its row, the "Sales rep" role)`, changed.join(', '))
  const audit = (await q(`SELECT action, count(*)::int AS n FROM ${S}.ab_audit WHERE action LIKE 'template.%' GROUP BY action ORDER BY action`)).map((r) => `${r.action} ${r.n}`)
  check(audit.includes('template.install 2') && audit.includes('template.upgrade 1') && audit.includes('template.sample.remove 1') && audit.includes('template.uninstall 1') && audit.includes('template.flows.enable 1'), 'every install, flow switch, upgrade, sample removal and uninstall is in the audit log', audit.join(', '))
  check(!errors.length, 'no script errors in the browser', errors.slice(0, 3).join(' | '))
} catch (e) {
  failed = true
  console.error(e)
  const runs = await q(`SELECT r.flow_name, r.state, r.error::text AS error, (SELECT string_agg(s.step_id || ':' || s.state || coalesce(' ' || s.error::text, ''), ' | ') FROM ${S}.ab_flow_steps s WHERE s.run_id = r.id) AS steps FROM ${S}.ab_flow_runs r ORDER BY r.created_on DESC LIMIT 12`).catch(() => [])
  for (const r of runs) console.error(`  run ${r.flow_name}: ${r.state} ${r.error ?? ''} [${(r.steps ?? '').slice(0, 400)}]`)
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stop().catch(() => undefined)
  await smtp?.close().catch(() => undefined)
  if (!E.KEEP) await maint(`DROP DATABASE IF EXISTS "${DB.database}"`).catch((e) => console.error(`could not drop ${DB.database}: ${e.message}`))
}
const bad = results.filter((r) => !r.ok)
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed${failed ? ' (stopped at the first failure)' : ''}`)
process.exit(failed || bad.length ? 1 : 0)
