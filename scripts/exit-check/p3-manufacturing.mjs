#!/usr/bin/env node
/**
 * Phase 3 package M2, exit check 10 (docs/plan/p3-spec.md; the spec calls the script p3-mfg.mjs): the built-in
 * Manufacturing pack against a REAL server in a headless browser. DEVELOPER TOOL (sandbox values only), not part of the
 * product. Re-runnable.
 *
 *   npm run build   (the server serves dist/)
 *   node scripts/exit-check/p3-manufacturing.mjs
 *
 * A server is started in this process (EXIT_PORT, default 5281) on an EMPTY database (EXIT_DB_NAME, default
 * appbuilder_exit_p3mfg: created and dropped here; KEEP=1 keeps it), workspace EXIT_WORKSPACE (default
 * .sandbox/m2/workspace, emptied), and a fake SMTP server. Before the install there is a table called ProductionLog
 * with a row, a role called Operator and an app (all compared byte for byte at the end). Clicked in the browser: the
 * install (Linked, the ProductionLog clash resolved with the pack's prefix, SAMPLE rows, the plan screen, switching on
 * the flows), the operator's phone (360 x 800, touch, Android user agent, Chrome's fake camera showing a QR code), the
 * quality head's approval, the dashboard, the deploy dialog, the upgrade screen, "Remove sample data" and the
 * uninstall. Through the API (as the person named): role assignment and the team (manual steps by design), the
 * inspection, the breakdown, the handover, prints, and the row-rule checks. The 1.1.0 version is a test fixture
 * (server/core/templates/testdata/manufacturing-next.ts), registered in this process; it is not built in.
 *
 *  1. install: Linked by default, the business model installed first, ProductionLog clash -> MfgProductionLog, SAMPLE
 *     rows, the plan (no problem, nothing removed, flows arrive off, backup line), Install, Switch on every flow;
 *  2. the operator's phone: sign in, open Shop floor from its start address, scan the machine QR code with the camera,
 *     log production with a photo while offline (row and photo wait), reconnect: the row arrives exactly once;
 *  3. an inspection that fails (with a defect) raises an NCR (it belongs to the inspector); the disposition is sent for
 *     approval; the inspector cannot approve it (not asked, refused), the quality head approves in the browser; the
 *     answer is written back on the NCR; a second NCR of the inspector sent by the quality head goes to the inspector's
 *     manager (the fallback), who approves;
 *  4. a breakdown stoppage creates a maintenance request (it belongs to the operator who reported it) routed to the
 *     machine's technician (notified); a request on a
 *     machine without a technician goes to the Maintenance role; 30 minutes later (flow clock) the unacknowledged one
 *     is escalated to the plant manager and the acknowledged one is not;
 *  5. the preventive maintenance schedule (run now) creates the tasks of the plans that are due, once;
 *  6. a shift handover is written (the next supervisor is notified) and acknowledged by the next supervisor;
 *  7. OEE: the Plant overview's OEE tile computed as the viewer does (as the plant manager: all rows; as the supervisor:
 *     the team's rows) equals a reference computation over the same rows read from the database; the dashboard page
 *     shows the same value;
 *  8. PDFs: the daily OEE schedule (run now) emails the PDF of yesterday to the plant manager (fake SMTP); the
 *     inspection report, the NCR and the maintenance work order print from their records;
 *  9. row rules: operator own rows only (and no repair cost), supervisor the team's rows, quality all production rows
 *     but no maintenance plans, maintenance cannot write NCRs;
 * 10. deploy to a production environment: the business model's solution by the API, the pack's with the deploy dialog
 *     (plan screen); the target has the apps, the flows off;
 * 11. local changes (the Supervisor console's title, the Plant overview, a downtime reason); upgrade to 1.1.0 keeps the
 *     app and the reference row, replaces the dashboard (chosen on the screen), adds the new column and reference row;
 * 12. "Remove sample data" removes exactly the SAMPLE rows; uninstall keeps the tables with data, and the emptied pack
 *     tables they look up (no masters of the plant's own added first);
 * 13. before/after: everything that existed is byte-equal; audit entries; no script errors in the browser.
 *
 * Settings: EXIT_DB_HOST (127.0.0.1), EXIT_DB_PORT (5435), EXIT_DB_USER (abdev), EXIT_DB_PASSWORD (abdev-sandbox-only),
 * EXIT_DB_NAME, EXIT_MAINT_DB (appbuilder_test), EXIT_PORT (5281), EXIT_WORKSPACE, PUPPETEER_CORE, CHROME_PATH, SHOTS.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import qrcode from 'qrcode-generator'
import { chromePath, puppeteerCorePath } from './browser-env.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const DB = { host: E.EXIT_DB_HOST || '127.0.0.1', port: Number(E.EXIT_DB_PORT || 5435), user: E.EXIT_DB_USER || 'abdev', password: E.EXIT_DB_PASSWORD || 'abdev-sandbox-only', database: E.EXIT_DB_NAME || 'appbuilder_exit_p3mfg' }
const MAINT = E.EXIT_MAINT_DB || 'appbuilder_test'
const PORT = Number(E.EXIT_PORT || 5281)
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = E.SHOTS || ''
const S = 'env_default'
const PASS = 'Exit-Example-Pass-2026'
const ADMIN = { name: 'Exit Admin', email: 'exit-admin@example.test', password: PASS }
const PEOPLE = {
  op: { name: 'Om Operator', email: 'om@example.test', role: 'Operator' },
  op2: { name: 'Oni Other', email: 'oni@example.test', role: 'Operator' },
  sup: { name: 'Sunil Supervisor', email: 'sunil@example.test', role: 'Supervisor' },
  sup2: { name: 'Sita Supervisor', email: 'sita@example.test', role: 'Supervisor' },
  qc: { name: 'Kavita Inspector', email: 'kavita@example.test', role: 'Quality' },
  qh: { name: 'Qamar Quality Head', email: 'qamar@example.test', role: 'Quality' },
  tech: { name: 'Tara Technician', email: 'tara@example.test', role: 'Maintenance' },
  pm: { name: 'Meera Plant Manager', email: 'meera@example.test', role: 'PlantManager' },
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
const { manufacturingNext } = await imp('server/core/templates/testdata/manufacturing-next.ts')
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

const DIR = path.resolve(E.EXIT_WORKSPACE || path.join(root, '.sandbox', 'm2', 'workspace'))
if (path.resolve(DIR) === root || !/workspace/i.test(path.basename(DIR))) { console.error('EXIT_WORKSPACE must be a folder named ...workspace... (it is emptied).'); process.exit(2) }
fs.rmSync(DIR, { recursive: true, force: true })
fs.mkdirSync(DIR, { recursive: true })
const WORK = path.join(path.dirname(DIR), 'work')
fs.mkdirSync(WORK, { recursive: true })
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
async function waitMail(pred, what, ms = 60000) {
  return until(() => smtp.inbox.find(pred), `${what}; inbox: ${smtp.inbox.map((x) => `${x.to}:${x.subject}`).join(', ')}`, ms, 250)
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

/* ------------------------------------------------------------------ the fake camera: the machine's QR code in a Y4M video */

function makeQrY4m(file, text) {
  const qr = qrcode(0, 'M')
  qr.addData(text, 'Byte')
  qr.make()
  const n = qr.getModuleCount()
  const W = 640, H = 480, px = 8
  const side = n * px, x0 = Math.floor((W - side) / 2), y0 = Math.floor((H - side) / 2)
  const y = Buffer.alloc(W * H, 235)
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) for (let k = 0; k < px; k++) y.fill(20, (y0 + r * px + k) * W + x0 + c * px, (y0 + r * px + k) * W + x0 + (c + 1) * px)
  const uv = Buffer.alloc((W / 2) * (H / 2), 128)
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, uv, uv])
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), ...Array.from({ length: 10 }, () => frame)]))
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
  await ctx.overridePermissions(BASE, ['camera'])
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
async function pdfOk(file) {
  const id = file?.attachmentId ?? file?.id ?? file?.token
  const res = await fetch(`${BASE}/api/v1${file?.url ?? `/print/files/${id}`}`, { headers: { 'X-Appbuilder': '1', Cookie: admin.cookie } }).catch(() => null)
  if (!res || res.status !== 200) return { ok: false, why: `download ${res?.status}` }
  const b = Buffer.from(await res.arrayBuffer())
  return { ok: b.subarray(0, 5).toString() === '%PDF-', bytes: b.length }
}

/** OEE of rows (sums): availability x performance x quality, the definition of src/dashboards/manufacturing.ts */
function referenceOee(rows) {
  const n = (v) => Number(v ?? 0)
  const s = (f) => rows.reduce((a, r) => a + f(r), 0)
  const planned = s((r) => n(r.PlannedMin)), run = s((r) => n(r.RunMin)), good = s((r) => n(r.Good)), total = s((r) => n(r.Good) + n(r.Scrap))
  const ideal = s((r) => (n(r.IdealCycleSec) * (n(r.Good) + n(r.Scrap))) / 60)
  return { oee: (run / planned) * (ideal / run) * (good / total), rows: rows.length }
}
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
  await api('PUT', '/identity/email', { host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'plant@example.test', installName: 'Example Plant Apps', publicUrl: 'https://apps.example.test' })

  log('setup: what exists before (a ProductionLog table, a role called Operator, an app)')
  await api('POST', '/tables', { displayName: 'Production log', name: 'ProductionLog', columns: [{ name: 'LoggedOn', displayName: 'Logged on', type: 'datetime', required: true }, { name: 'Machine', displayName: 'Machine', type: 'text' }, { name: 'Good', displayName: 'Good', type: 'number' }] })
  await api('POST', '/data/ProductionLog/rows', { values: { LoggedOn: '2026-10-01T05:00:00.000Z', Machine: 'OLD-01', Good: 99 } })
  await api('POST', '/roles', { name: 'Operator', apps: 'all', privileges: [] })
  await api('POST', '/apps', { name: 'Existing app', width: 1920, height: 1080 })
  for (const [k, p] of Object.entries(PEOPLE)) {
    const u = await api('POST', '/users', { name: p.name, email: p.email, password: PASS, roleIds: [] })
    await q('UPDATE ab.users SET must_change_password = false, password_hash = $1 WHERE email = $2', [await hashPassword(PASS), p.email])
    who[k] = { ...p, id: u.id ?? u.user?.id, password: PASS, api: new Client(BASE) }
  }
  const before = await snapshot()
  log(`snapshot: ${before.size} things that exist`)

  const y4m = path.join(WORK, 'machine-qr.y4m')
  makeQrY4m(y4m, 'SAMPLE-P2')
  browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1000', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`] })
  const page = await newPage()
  await signIn(page, ADMIN)

  /* 1. install by clicking */
  await templatesPage(page)
  await click(page, T('tpl-kind-solution'))
  await click(page, T('tpl-card-builtin.manufacturing'))
  await page.waitForSelector(`${T('tpl-detail')}[data-template="builtin.manufacturing"]`, { visible: true, timeout: 20000 })
  const detail = await text(page, T('tpl-detail'))
  check(/7 apps/.test(detail) && /10 flows/.test(detail) && /6 print templates/.test(detail) && /5 roles/.test(detail) && /business-model/.test(detail), 'the catalogue: the Manufacturing pack says what it contains (7 apps, 10 flows, 6 print templates, 5 roles) and that it needs the business model', detail.replace(/\s+/g, ' ').slice(0, 300))
  await click(page, T('tpl-use'))
  await waitFor(page, T('tpl-clash-ProductionLog'), 30000)
  await idle(page)
  check((await page.$eval(T('tpl-mode'), (e) => e.value)) === 'linked' && (await page.$eval(T('tpl-dep-builtin.business-model'), (e) => e.getAttribute('data-action'))) === 'install', 'Use: Linked by default; the common business model is installed first')
  check(/Shared with Common business model/.test(await text(page, T('tpl-slot-shared-Products'))), 'Use: Products is the business model\'s shared table')
  await click(page, T('tpl-clash-rename-ProductionLog'))
  await idle(page)
  await page.waitForFunction(() => document.querySelector('[data-testid="tpl-slot-name-ProductionLog"]')?.value === 'MfgProductionLog', { timeout: 20000 })
  await click(page, T('tpl-sample'))
  await idle(page)
  record('Use: the ProductionLog clash resolved with the pack prefix (MfgProductionLog); SAMPLE rows ticked', true)
  await click(page, T('tpl-review'))
  await waitFor(page, T('tpl-main-plan'), 60000)
  const mainPlan = await text(page, T('tpl-main-plan'))
  check(!(await page.$(`${T('tpl-main-plan')} ${T('plan-problems')}`)) && !/removed/.test(await text(page, `${T('tpl-main-plan')} ${T('plan-counts')}`)) && /arrives turned off|arrive turned off/.test(mainPlan) && /SAMPLE rows/.test(mainPlan), 'the plan screen: no problem, nothing removed, flows arrive off, SAMPLE rows listed', mainPlan.replace(/\s+/g, ' ').slice(0, 200))
  await shot(page, 'mfg-plan.png')
  await click(page, T('tpl-install'))
  await page.waitForFunction(() => document.querySelector('[data-testid="tpl-dialog"]')?.getAttribute('data-step') === 'flows', { timeout: 120000 })
  const rows1 = await installRows()
  const mfg = rows1.find((r) => r.template_id === 'builtin.manufacturing')
  const bm = rows1.find((r) => r.template_id === 'builtin.business-model')
  check(mfg && bm && mfg.mode === 'linked' && mfg.solution_id && mfg.depends_on[0]?.install === bm.id, 'installed Linked (a versioned solution) after the business model, in one go')
  const flowIds = mfg.created.flows.map((f) => f.id)
  check(flowIds.length === 10 && (await q(`SELECT count(*)::int AS n FROM ${S}.ab_flows WHERE id = ANY($1) AND enabled`, [flowIds]))[0].n === 0, 'the 10 flows arrived turned off')
  for (const id of flowIds) {
    const box = await page.$(T(`tpl-flow-${id}`))
    if (box && (await box.evaluate((e) => e.getAttribute('data-state') !== 'checked'))) await box.click()
  }
  await click(page, T('tpl-flows-enable'))
  await page.waitForFunction(() => !document.querySelector('[data-testid="tpl-dialog"]'), { timeout: 60000 })
  check((await q(`SELECT count(*)::int AS n FROM ${S}.ab_flows WHERE id = ANY($1) AND enabled`, [flowIds]))[0].n === 10, 'the administrator switched every flow on (they validate against this environment)')
  const created = mfg.created
  const appId = (key) => created.apps.find((a) => a.key === key).id
  const roleId = (key) => created.roles.find((r) => r.key === key).id
  const flowId = (key) => created.flows.find((f) => f.key === key).id
  const printId = (key) => created.printTemplates.find((p) => p.key === key).id
  const dashId = (key) => created.dashboards.find((d) => d.key === key).id
  check(created.roles.find((r) => r.key === 'Operator').name === 'Operator (2)', 'the pack\'s Operator role is "Operator (2)": the existing Operator role is untouched')

  // the first day in the plant (manual by design): roles, a team, the machine's technician, the Email connection
  for (const p of Object.values(who)) await api('PATCH', `/users/${p.id}`, { roleIds: [roleId(p.role)] })
  // the inspector reports to the plant manager (the fallback approver of an NCR nobody else in Quality may approve)
  await api('PATCH', `/users/${who.qc.id}`, { managerId: who.pm.id })
  await api('POST', '/teams', { name: 'Shift A team', code: 'SHIFTA', memberIds: [who.op.id, who.sup.id] })
  await api('POST', '/connections', { name: 'Mail', connector: 'email', settings: {} })
  const p2 = (await rowsOf('Machines', `"Code" = 'SAMPLE-P2'`))[0]
  await api('PATCH', `/data/Machines/rows/${p2.id}`, { changes: { Technician: who.tech.id } })
  for (const p of Object.values(who)) await api('POST', '/auth/login', { email: p.email, password: PASS }, p.api)
  record('first day: roles assigned, a team (operator + supervisor), the technician of SAMPLE-P2, an Email connection (manual steps, rule 8)', true)

  /* 1b. every app and every tab opens without a formula error (the run view's error count, as the administrator) */
  const opened = []
  const tour = [
    ['SupervisorConsole', 'SupTabs', ['Today', 'Production log', 'Downtime', 'Work orders', 'Shift handover']],
    ['QualityDesk', 'QTabs', ['Inspections', 'NCRs', 'Inspection plans', 'Defect types']],
    ['MaintenanceDesk', 'MTabs', ['Requests', 'PM plans', 'PM tasks', 'Machines']],
    ['PlantSetup', 'SetupTabs', ['Machines', 'Lines', 'Shifts', 'Downtime reasons']],
    ['MaintenancePhone', 'MaintTabs', ['Requests', 'PM tasks', 'Report']],
    ['InspectionPhone', null, []],
    ['ShopFloor', null, []],
  ]
  for (const [key, tabsName, tabNames] of tour) {
    await page.goto(`${BASE}/#u-${appId(key)}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction((id) => !!window.__ab?.tabs?.get(id) && !!document.querySelector(`[data-testid="tab-pane-${id}"] [data-testid^="control-"]`), { timeout: 45000 }, appId(key))
    await sleep(1500)
    for (const tab of tabNames) {
      await page.evaluate((tn, label) => { const el = [...document.querySelectorAll(`[data-testid="control-${tn}"] [role=tab]`)].find((b) => b.textContent.trim() === label); el?.click() }, tabsName, tab)
      await sleep(900)
    }
    if (key === 'InspectionPhone') { await page.evaluate(() => [...document.querySelectorAll('[data-testid="control-NewInspection"] button')][0]?.click()); await sleep(1200) }
    const errs = await page.evaluate((id) => window.__ab.tabs.get(id).getState().debugLog.filter((l) => l.kind === 'error').map((l) => l.message), appId(key))
    opened.push(`${key} ${errs.length}`)
    if (errs.length) log(`${key}: ${errs.slice(0, 5).join(' | ')}`)
    await shot(page, `mfg-app-${key}.png`)
  }
  check(opened.every((x) => x.endsWith(' 0')), 'every app of the pack opens, every tab is shown, and no formula reports an error (the app\'s error log)', opened.join(', '))

  /* 2. the operator's phone */
  const phone = await newPage(true)
  await signIn(phone, who.op)
  await phone.goto(`${BASE}/?app=${appId('ShopFloor')}`, { waitUntil: 'networkidle2' })
  await phone.waitForFunction((id) => location.hash === `#u-${id}`, { timeout: 20000 }, appId('ShopFloor'))
  await phone.waitForFunction(() => document.body.innerText.includes('Shop floor') && document.body.innerText.includes('Log production'), { timeout: 45000 })
  const surface = await phone.evaluate(() => ({ s: document.querySelector('[data-run-surface]')?.getAttribute('data-run-surface'), touch: document.documentElement.classList.contains('touch'), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
  check(surface.s === 'fluid' && surface.touch && surface.sw <= surface.cw + 1, 'phone: Shop floor opens from its start address at 360 px, fluid, touch, no sideways scroll', JSON.stringify(surface))
  await shot(phone, 'mfg-phone-home.png')
  await phone.evaluate(() => { Object.defineProperty(window, 'BarcodeDetector', { value: undefined, configurable: true, writable: true }) })
  await tap(phone, T('scan-input-camera'))
  await waitFor(phone, T('scanner-sheet'))
  await phone.waitForFunction(() => document.body.innerText.includes('SAMPLE press 2'), { timeout: 30000 })
  check(true, 'phone: the machine QR code (camera, the bundled QR reader) finds SAMPLE-P2 and shows the machine')
  await sleep(500)
  await tap(phone, T('control-LogProduction') + ' button')
  await waitFor(phone, T('control-LogForm'), 20000)
  await phone.waitForFunction(() => { const e = document.querySelector('[data-testid="control-LogForm"] [id$="-Machine"]'); return e && e.value === 'SAMPLE-P2' }, { timeout: 20000 })
  const sel = (n) => `${T('control-LogForm')} [id$="-${n}"]`
  for (const [n, v] of [['Good', '480'], ['Scrap', '12']]) {
    await phone.$eval(sel(n), (e) => e.scrollIntoView({ block: 'center' }))
    await phone.focus(sel(n))
    await phone.$eval(sel(n), (e) => e.select())
    await phone.keyboard.press('Backspace')
    await phone.keyboard.type(v)
  }
  const runMin = await phone.$eval(sel('RunMin'), (e) => e.value)
  await waitFor(phone, T('attachment-take-photo-Photo'))
  await phone.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 2400; c.height = 1600
    const g = c.getContext('2d'); for (let i = 0; i < 200; i++) { g.fillStyle = `hsl(${i * 7},70%,45%)`; g.fillRect((i * 97) % 2400, (i * 53) % 1600, 300, 200) }
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))
    const input = document.querySelector('[data-testid="attachment-capture-Photo"]')
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'machine.jpg', { type: 'image/jpeg' }))
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await waitFor(phone, T('attachment-pending'))
  const logTable = (await tableOf('MfgProductionLog'))
  const mine = () => q(`SELECT * FROM ${S}."${logTable.source}" WHERE owner = $1`, [who.op.id])
  await phone.setOfflineMode(true)
  await phone.waitForFunction(() => /offline/i.test(document.querySelector('[data-testid="connection-bar"]')?.textContent ?? ''), { timeout: 20000 })
  await sleep(600) // the strip moves the pinned save bar: tap after the layout settled
  await phone.$eval(T('form-save'), (e) => e.scrollIntoView({ block: 'center' }))
  await sleep(300)
  await tap(phone, T('form-save'))
  await phone.waitForFunction(() => document.querySelector('[data-testid="outbox-count"]')?.textContent === '2', { timeout: 20000 })
  check((await mine()).length === 0, 'phone offline: the production row and its photo wait on the phone (2 waiting to send); nothing reached the server', `run minutes prefilled ${runMin}`)
  await shot(phone, 'mfg-phone-offline.png')
  await phone.setOfflineMode(false)
  await phone.waitForFunction(() => !document.querySelector('[data-testid="outbox-count"]'), { timeout: 60000 })
  const sent = await until(async () => { const r = await mine(); return r.length && r[0].Photo ? r : null }, 'the phone row with its photo')
  await sleep(2000)
  const again = await mine()
  check(again.length === 1 && again[0].Machine === 'SAMPLE-P2' && Number(again[0].Good) === 480 && Number(again[0].Scrap) === 12 && Number(again[0].IdealCycleSec) === 28 && Number(again[0].PlannedMin) === 450 && again[0].Operator === who.op.id && !!again[0].Photo,
    'back online: the row arrives exactly once, with the photo; the server filled the ideal cycle (28 s) and the planned minutes (450) from the machine and the shift, and the operator', JSON.stringify({ n: again.length, Shift: sent[0].Shift, RunMin: again[0].RunMin }))
  await phone.close()

  /* 3. inspection -> NCR -> approval */
  const plan = (await rowsOf('InspectionPlans', `"Name" = 'SAMPLE BR-10 hole diameter'`))[0]
  const insp = (await api('POST', '/data/Inspections/rows', { values: { Plan: plan.id, Machine: 'SAMPLE-P2', Batch: 'LOT-2211', Stage: 'In-process', Measured: 10.12, SampleSize: 5, Result: 'Pass', Notes: 'Hole oversize on 2 of 5 pieces' } }, who.qc.api)).row
  check(insp.Result === 'Fail' && /^INS\/\d{4}-\d{2}\/00001$/.test(insp.Number) && insp.Inspector === who.qc.id, 'an inspection measured outside its plan\'s limits is saved as Fail (before-event), numbered INS/<financial year>/00001, the inspector filled in', `${insp.Number} ${insp.Result}`)
  await api('POST', '/data/InspectionDefects/rows', { values: { Inspection: insp.id, Defect: 'Hole oversize', Severity: 'Major', Qty: 2, Action: 'Hold the lot' } }, who.qc.api)
  const ncr = await until(async () => (await rowsOf('NCRs', `"Inspection" = $1`, [insp.id]))[0], 'the NCR')
  check(ncr.Status === 'Open' && /^NCR\//.test(ncr.Number) && (await notified(who.qh.email, /NCR .*failed/)).length === 1, 'the failed inspection raised an NCR (flow) and the quality role was notified', `${ncr.Number}`)
  await api('PATCH', `/data/NCRs/rows/${ncr.id}`, { changes: { Disposition: 'Rework', RootCause: 'Punch worn', Status: 'Awaiting approval' } }, who.qc.api)
  const areq = await until(async () => (await q(`SELECT id FROM ${S}.ab_approval_requests WHERE regarding_id = $1`, [ncr.id]).catch(() => q(`SELECT id FROM ${S}.ab_approval_requests WHERE title LIKE $1`, [`NCR ${ncr.Number}%`])))[0], 'the NCR approval request')
  const askedFor = async (id) => (await q(`SELECT u.email, a.source FROM ${S}.ab_approval_assignments a JOIN ab.users u ON u.id = a.user_id WHERE a.request_id = $1 AND a.status = 'pending' ORDER BY u.email`, [id])).map((x) => `${x.email}:${x.source}`)
  const asked1 = await until(async () => { const a = await askedFor(areq.id); return a.length ? a : null }, 'the people asked')
  const selfTry = await who.qc.api.req('POST', `/approvals/${areq.id}/respond`, { response: 'Approve' })
  check(ncr.owner === who.qc.id && asked1.join() === `${who.qh.email}:role` && selfTry.status >= 400, 'the NCR belongs to the inspector; the inspector is not asked to approve the NCR raised from their own failed inspection (an answer is refused); the other Quality person is', `asked ${asked1.join(', ')}; inspector's answer ${selfTry.status}`)
  const qhPage = await newPage()
  await signIn(qhPage, who.qh)
  await qhPage.goto(`${BASE}/#u-approvals?id=${areq.id}`, { waitUntil: 'domcontentloaded' })
  await waitFor(qhPage, T('approval-detail'), 30000)
  await shot(qhPage, 'mfg-ncr-approval.png')
  await click(qhPage, T('approval-answer-Approve'))
  const ncr2 = await until(async () => { const r = (await rowsOf('NCRs', 'id = $1', [ncr.id]))[0]; return r.Approval === 'Approved' ? r : null }, 'the approval written back')
  check(ncr2.Status === 'Approved' && ncr2.Approval === 'Approved', 'the quality head approved the disposition in the browser; the flow wrote Approved back on the NCR')
  await qhPage.close()
  // the inspector's second NCR, sent for approval by the quality head: neither may approve it; the inspector's manager decides
  const insp2 = (await api('POST', '/data/Inspections/rows', { values: { Plan: plan.id, Machine: 'SAMPLE-P2', Batch: 'LOT-2212', Stage: 'In-process', Measured: 10.15, SampleSize: 5, Result: 'Pass', Notes: 'Hole oversize again' } }, who.qc.api)).row
  const ncrB = await until(async () => (await rowsOf('NCRs', '"Inspection" = $1', [insp2.id]))[0], 'the second NCR')
  await api('PATCH', `/data/NCRs/rows/${ncrB.id}`, { changes: { Disposition: 'Scrap', RootCause: 'Material', Status: 'Awaiting approval' } }, who.qh.api)
  const breq = await until(async () => (await q(`SELECT id FROM ${S}.ab_approval_requests WHERE regarding_id = $1`, [ncrB.id]))[0], 'the second NCR approval request')
  const asked2 = await until(async () => { const a = await askedFor(breq.id); return a.length ? a : null }, 'the fallback approver')
  const bySelf = await who.qc.api.req('POST', `/approvals/${breq.id}/respond`, { response: 'Approve' })
  const bySender = await who.qh.api.req('POST', `/approvals/${breq.id}/respond`, { response: 'Approve' })
  const byManager = await who.pm.api.req('POST', `/approvals/${breq.id}/respond`, { response: 'Approve' })
  const ncrB2 = await until(async () => { const r = (await rowsOf('NCRs', 'id = $1', [ncrB.id]))[0]; return r.Approval === 'Approved' ? r : null }, 'the second approval written back')
  check(asked2.join() === `${who.pm.email}:fallback` && bySelf.status >= 400 && bySender.status >= 400 && byManager.status === 200 && ncrB2.Approval === 'Approved', 'sent for approval by the quality head, the inspector\'s second NCR goes to the inspector\'s manager (fallback): the inspector and the sender are refused, the plant manager approves', `asked ${asked2.join(', ')}; inspector ${bySelf.status}, sender ${bySender.status}, manager ${byManager.status}`)

  /* 4. maintenance routing and escalation */
  let now = new Date()
  app.services.flows.setClock({ now: () => now })
  await api('POST', '/data/Downtime/rows', { values: { Machine: 'SAMPLE-P2', StartedOn: new Date().toISOString(), Reason: 'Breakdown', Notes: 'Ram does not return' } }, who.op.api)
  const mr1 = await until(async () => (await rowsOf('MaintenanceRequests', `"Machine" = 'SAMPLE-P2' AND "Number" NOT LIKE 'SAMPLE%'`))[0], 'the maintenance request from the breakdown')
  const routed = await until(async () => { const r = (await rowsOf('MaintenanceRequests', 'id = $1', [mr1.id]))[0]; return r.AssignedTo ? r : null }, 'the routing')
  check(routed.AssignedTo === who.tech.id && routed.Priority === 'High' && routed.owner === who.op.id && (await notified(who.tech.email, /Breakdown: SAMPLE-P2/)).length === 1 && (await rowsOf('Downtime', `"MaintenanceRequest" = $1`, [mr1.id])).length === 1, 'a breakdown stoppage created a high-priority maintenance request that belongs to the operator who reported it, linked to the stoppage, assigned to and notified to the machine\'s technician', routed.Number)
  const mr2 = (await api('POST', '/data/MaintenanceRequests/rows', { values: { Machine: 'SAMPLE-P1', Problem: 'Coolant pump noisy', Kind: 'Repair', Priority: 'Medium' } }, who.op.api)).row
  await until(async () => (await notified(who.tech.email, new RegExp(`\\(${mr2.Number.replace(/\//g, '\\/')}\\)`))).length, 'the Maintenance role notified')
  await api('PATCH', `/data/MaintenanceRequests/rows/${mr2.id}`, { changes: { Status: 'Acknowledged' } }, who.tech.api)
  record('a request on a machine without a technician went to the Maintenance role; the technician acknowledged it', true, mr2.Number)
  await until(async () => (await q(`SELECT count(*)::int AS n FROM ${S}.ab_flow_waits w JOIN ${S}.ab_flow_runs r ON r.id = w.run_id WHERE r.flow_id = $1 AND w.state = 'waiting'`, [flowId('RouteRequest')]))[0].n >= 2, 'the routing flows waiting 30 minutes')
  now = new Date(Date.now() + 31 * 60000)
  await app.services.flows.sweep()
  const esc = await until(async () => { const r = (await rowsOf('MaintenanceRequests', 'id = $1', [mr1.id]))[0]; return r.Escalated ? r : null }, 'the escalation')
  await sleep(1500)
  const mr2b = (await rowsOf('MaintenanceRequests', 'id = $1', [mr2.id]))[0]
  check(esc.Escalated && !mr2b.Escalated && (await notified(who.pm.email, /Not acknowledged in 30 minutes/)).length === 1, '30 minutes later (flow clock): the unacknowledged request is escalated to the plant manager; the acknowledged one is not')
  app.services.flows.setClock({ now: () => new Date() })

  /* 5. preventive maintenance on schedule */
  const sched = async (key) => (await api('GET', '/admin/schedules')).items.find((s) => s.payload?.flowId === flowId(key) || String(s.id).includes(flowId(key)))
  const pmSched = await sched('CreatePmTasks')
  check(pmSched && /0 6 \* \* \*/.test(pmSched.cron ?? ''), 'the preventive maintenance flow is scheduled at 06:00 India time', `${pmSched?.cron} ${pmSched?.timeZone ?? ''}`)
  const tasksBefore = (await rowsOf('PMTasks')).length
  await api('POST', `/admin/schedules/${pmSched.id}/run`)
  const tasks = await until(async () => { const r = await rowsOf('PMTasks', `"Number" NOT LIKE 'SAMPLE%'`); return r.length >= 2 ? r : null }, 'the PM tasks')
  await until(async () => (await q(`SELECT count(*)::int AS n FROM ${S}.ab_flow_runs WHERE flow_id = $1 AND state = 'succeeded'`, [flowId('CreatePmTasks')]))[0].n >= 1, 'the PM run')
  await api('POST', `/admin/schedules/${pmSched.id}/run`)
  await until(async () => (await q(`SELECT count(*)::int AS n FROM ${S}.ab_flow_runs WHERE flow_id = $1 AND state = 'succeeded'`, [flowId('CreatePmTasks')]))[0].n >= 2, 'the second PM run')
  const plans = await rowsOf('PMPlans')
  check(tasks.length === 2 && (await rowsOf('PMTasks')).length === tasksBefore + 2 && plans.every((p) => new Date(p.NextDue) > new Date()), 'the schedule created one task per due plan (2) and moved the plans on; running it again creates none', tasks.map((t) => `${t.Number} ${t.Machine}`).join(', '))

  /* 6. shift handover */
  const ho = (await api('POST', '/data/ShiftHandovers/rows', { values: { Summary: 'A to B: P2 down, MR raised', HandoverDate: new Date().toISOString().slice(0, 10), Shift: 'A', ToSupervisor: who.sup2.id, OpenIssues: 'P2 hydraulic' } }, who.sup.api)).row
  await until(async () => (await notified(who.sup2.email, /Shift handover/)).length, 'the next supervisor notified')
  const selfAck = await who.sup.api.req('PATCH', `/data/ShiftHandovers/rows/${ho.id}`, { changes: { Status: 'Acknowledged' } })
  await api('PATCH', `/data/ShiftHandovers/rows/${ho.id}`, { changes: { Status: 'Acknowledged' } }, who.sup2.api)
  const ho2 = (await rowsOf('ShiftHandovers', 'id = $1', [ho.id]))[0]
  check(selfAck.status !== 200 && ho2.Status === 'Acknowledged' && ho2.AcknowledgedBy === who.sup2.id && ho2.FromSupervisor === who.sup.id && ho2.AcknowledgedOn, 'a shift handover is written (the next supervisor notified), refused as acknowledged by its writer, acknowledged by the next supervisor', `self-ack ${selfAck.status}`)

  /* 7. OEE on the dashboard = reference */
  const allLog = await q(`SELECT * FROM ${S}."${logTable.source}"`)
  const refAll = referenceOee(allLog)
  const pmTile = await tileValue(dashId('PlantOverview'), 'oee', who.pm.api)
  const teamLog = allLog.filter((r) => r.owner === who.op.id || r.owner === who.sup.id)
  const refTeam = referenceOee(teamLog)
  const supTile = await tileValue(dashId('ShiftBoard'), 'oee', who.sup.api)
  check(Math.abs(pmTile.OEE - refAll.oee) < 1e-9 && Math.abs(supTile.OEE - refTeam.oee) < 1e-9 && refTeam.rows === 1, 'OEE: the plant manager\'s Plant overview equals the reference over all rows; the supervisor\'s Shift board equals the reference over the team\'s rows', `manager ${(100 * pmTile.OEE).toFixed(3)}% of ${refAll.rows} rows, supervisor ${(100 * supTile.OEE).toFixed(3)}% of ${refTeam.rows} row(s)`)
  const mgrPage = await newPage()
  await signIn(mgrPage, who.pm)
  await mgrPage.goto(`${BASE}/#u-dashboards?d=${dashId('PlantOverview')}`, { waitUntil: 'domcontentloaded' })
  await mgrPage.waitForSelector(`${T('tile-oee')}[data-state="ready"]`, { timeout: 60000 })
  await sleep(1000)
  const shown = await text(mgrPage, T('tile-oee'))
  const want = (100 * refAll.oee).toFixed(1)
  await shot(mgrPage, 'mfg-dashboard.png')
  check(shown.includes(`${want}%`), 'the dashboard page shows the same OEE (rounded to 0.1%)', `${want}% in "${shown.replace(/\s+/g, ' ').slice(0, 80)}"`)

  /* 8. PDFs */
  const y = new Date(Date.now() - 86400000)
  for (const [m, good] of [['SAMPLE-P1', 900], ['SAMPLE-P3', 700]]) await api('POST', `/data/${logTable.name}/rows`, { values: { LoggedOn: new Date(Date.UTC(y.getUTCFullYear(), y.getUTCMonth(), y.getUTCDate(), 6, 0)).toISOString(), Shift: 'A', Machine: m, Good: good, Scrap: 10, RunMin: 400 } })
  const oeeSched = await sched('DailyOee')
  await api('POST', `/admin/schedules/${oeeSched.id}/run`)
  const mail = await waitMail((m) => m.to.includes(who.pm.email) && /^Daily OEE/.test(m.subject), 'the daily OEE email', 90000)
  const att = mail.attachments.find((a) => /\.pdf$/i.test(a.fileName))
  check(att && att.content.subarray(0, 5).toString() === '%PDF-' && /0 7 \* \* \*/.test(oeeSched.cron), 'the daily OEE PDF (schedule 07:00 India time, run now) arrives by email to the plant manager', att ? `${mail.subject}; ${att.fileName}, ${att.content.length} bytes` : 'no attachment')
  if (SHOTS && att) fs.writeFileSync(path.join(SHOTS, 'mfg-daily-oee.pdf'), att.content)
  const printed = []
  for (const [key, id] of [['Inspection', insp.id], ['Ncr', ncr.id], ['JobCard', mr1.id]]) {
    const g = await api('POST', '/print/generate', { template: printId(key), recordId: id }, who.pm.api)
    printed.push(`${key}: ${g.file?.fileName ?? JSON.stringify(g).slice(0, 60)} (${g.pages ?? g.file?.pages ?? '?'} p.)`)
  }
  check(printed.length === 3 && printed.every((p) => /\.pdf/i.test(p)), 'the inspection report, the NCR and the maintenance work order print from their records (as the plant manager)', printed.join('; '))

  /* 9. row rules */
  const denied = (s) => s === 403 || s === 404 // no privilege: refused, or the table is not even visible
  const qv = async (c, table, select) => c.req('POST', '/query', { plan: { version: 2, table, select } })
  const opLog = await qv(who.op.api, logTable.name, ['id', 'Machine'])
  const op2Log = await qv(who.op2.api, logTable.name, ['id'])
  const opIns = await qv(who.op.api, 'Inspections', ['id'])
  const opMr = await qv(who.op.api, 'MaintenanceRequests', ['id', 'Number', 'Cost'])
  check(opLog.data.rows?.length === 1 && op2Log.data.rows?.length === 0 && denied(opIns.status) && opMr.status === 403, 'operator: only their own production rows (another operator sees none), no inspections, and the repair cost column is refused', `own ${opLog.data.rows?.length}, other ${op2Log.data.rows?.length}, inspections ${opIns.status}, MR with Cost ${opMr.status}`)
  const opMr2 = await qv(who.op.api, 'MaintenanceRequests', ['id', 'Number'])
  const supLog = await qv(who.sup.api, logTable.name, ['id'])
  const qcLog = await qv(who.qc.api, logTable.name, ['id'])
  const qcPm = await qv(who.qc.api, 'PMPlans', ['id'])
  const techNcr = await who.tech.api.req('POST', '/data/NCRs/rows', { values: { Defect: 'x', Status: 'Open' } })
  const allCount = (await q(`SELECT count(*)::int AS n FROM ${S}."${logTable.source}"`))[0].n
  check(opMr2.data.rows?.length === 2 && opMr2.data.rows.some((r) => r.id === mr1.id) && supLog.data.rows?.length === 1 && qcLog.data.rows?.length === allCount && denied(qcPm.status) && denied(techNcr.status), 'operator sees the request they reported and the one raised from their own breakdown; supervisor the team\'s production rows only; quality all production rows but not the PM plans; maintenance cannot write NCRs', `operator MR ${opMr2.data.rows?.length}, supervisor ${supLog.data.rows?.length}, quality ${qcLog.data.rows?.length}/${allCount}, PM plans ${qcPm.status}, NCR ${techNcr.status}`)

  /* 10. deploy to production */
  try {
    const env = await api('POST', '/environments', { name: 'Plant production', type: 'production' })
    await until(async () => (await api('GET', '/environments')).items.find((x) => x.id === env.id && (!x.state || x.state === 'ready')), 'the production environment', 90000)
    const bmPlan = await api('POST', `/solutions/${bm.solution_id}/deploy`, { target: env.id, plan: true })
    await api('POST', `/solutions/${bm.solution_id}/deploy`, { target: env.id, confirm: bmPlan.token })
    await page.goto(`${BASE}/#solution-${mfg.solution_id}`, { waitUntil: 'domcontentloaded' })
    await click(page, T('deploy-solution-button'), 30000)
    await waitFor(page, T('deploy-dialog'))
    await page.select(T('deploy-target'), env.id)
    await click(page, T('deploy-review'))
    await page.waitForFunction(() => { const d = document.querySelector('[data-testid="deploy-dialog"]'); return !!d && !d.querySelector('.animate-spin') && !!d.querySelector('[data-testid="solution-plan"], [data-testid="plan-counts"]') }, { timeout: 60000 })
    await shot(page, 'mfg-deploy-plan.png')
    await click(page, T('deploy-confirm'), 30000)
    await page.waitForFunction(() => !document.querySelector('[data-testid="deploy-dialog"]'), { timeout: 120000 })
    const schema = (await api('GET', '/environments')).items.find((x) => x.id === env.id).details.schema
    const apps = await q(`SELECT name FROM "${schema}".ab_apps`)
    const flows = await q(`SELECT name, enabled FROM "${schema}".ab_flows`)
    const tablesThere = (await q(`SELECT name FROM "${schema}".ab_tables`)).map((t) => t.name)
    const mf = flows.filter((f) => /^Manufacturing: /.test(f.name))
    record('deployed to a production environment with the plan screen (the business model by the API first): the target has the 7 apps and the 10 flows, turned off', apps.filter((a) => ['Shop floor', 'Supervisor console', 'Quality desk'].includes(a.name)).length === 3 && mf.length === 10 && mf.every((f) => !f.enabled) && tablesThere.includes('MfgProductionLog'), `${apps.length} apps, ${mf.length} flows (${mf.filter((f) => f.enabled).length} on)`)
  } catch (e) {
    record('deployed to a production environment with the plan screen', false, String(e.message).slice(0, 400))
  }

  /* 11. local changes; upgrade to 1.1.0 */
  const supId = appId('SupervisorConsole')
  const def = await appDef(supId)
  const hdr = (nodes) => { for (const n of nodes) { if (n.name === 'HeaderTitle') return n; const h = hdr(n.children ?? []); if (h) return h } }
  hdr(def.screens).props.Text = '="Our shift console"'
  await api('PUT', `/apps/${supId}`, { definition: def })
  const ov = (await q(`SELECT def FROM ${S}.ab_dashboards WHERE id = $1`, [dashId('PlantOverview')]))[0].def
  await api('PATCH', `/dashboards/${dashId('PlantOverview')}`, { def: { ...ov, description: 'Changed here' } })
  const other = (await rowsOf('DowntimeReasons', `"Code" = 'OT'`))[0]
  await api('PATCH', `/data/DowntimeReasons/rows/${other.id}`, { changes: { Name: 'Other (our wording)' } })
  const seqBefore = (await q(`SELECT "NextValue" FROM ${S}.sys_number_sequences WHERE "Name" = 'Work orders'`))[0]
  const unreg = registerTestTemplates([manufacturingNext()])
  await templatesPage(page)
  await rowDialog(page, `tpl-upgrade-${mfg.id}`, 'tpl-upgrade')
  const lc = await text(page, T('tpl-local-changes'))
  check(/App Supervisor console/.test(lc) && /Dashboard Manufacturing: Plant overview/.test(lc) && /Reference row/.test(lc), 'upgrade to 1.1.0: the local changes are listed (the console, the dashboard, a downtime reason), kept by default', lc.replace(/\s+/g, ' ').slice(0, 300))
  await page.select(T(`tpl-local-dashboard:${dashId('PlantOverview')}`), 'replace')
  await page.waitForFunction(() => { const d = document.querySelector('[data-testid="tpl-upgrade"]'); return !!d && !d.querySelector('.animate-spin') && !!d.querySelector('[data-testid="solution-plan"]') }, { timeout: 60000 })
  await sleep(300)
  await shot(page, 'mfg-upgrade.png')
  await click(page, T('tpl-upgrade-go'))
  await page.waitForFunction(() => !document.querySelector('[data-testid="tpl-upgrade"]'), { timeout: 120000 })
  const dash2 = (await q(`SELECT def FROM ${S}.ab_dashboards WHERE id = $1`, [dashId('PlantOverview')]))[0].def
  const machCols = (await tableOf('Machines')).def.columns.map((c) => c.name)
  const reasonsNow = await rowsOf('DowntimeReasons')
  const seq = (await q(`SELECT "Padding", "NextValue" FROM ${S}.sys_number_sequences WHERE "Name" = 'Work orders'`))[0]
  check(JSON.stringify(await appDef(supId)).includes('Our shift console') && dash2.tiles.some((t) => t.id === 'byshift') && dash2.description !== 'Changed here' && machCols.includes('Criticality')
    && reasonsNow.some((r) => r.Code === 'NM-CRANE') && reasonsNow.find((r) => r.Code === 'OT').Name === 'Other (our wording)' && Number(seq.Padding) === 5 && Number(seq.NextValue) === Number(seqBefore.NextValue)
    && (await installRows()).find((r) => r.id === mfg.id).template_version === '1.1.0',
  'upgraded to 1.1.0: the console kept (local change), the dashboard replaced (chosen), the new column and reference row added, the changed reference row kept, the sequence format changed with its next value kept')
  unreg()

  /* 12. Remove sample data; uninstall keeping tables */
  // no masters of the plant's own are added: after the removal, Inspection plans (and others) are empty while the kept
  // Inspections look them up; uninstall keeping tables keeps them too
  const sampleIds = (await q(`SELECT sample_rows FROM ${S}.ab_template_installs WHERE id = $1`, [mfg.id]))[0].sample_rows
  const sampleCount = Object.values(sampleIds).reduce((n, l) => n + l.length, 0)
  await templatesPage(page)
  await rowDialog(page, `tpl-sample-remove-${mfg.id}`, 'tpl-sample-dialog')
  await click(page, T('tpl-sample-go'))
  await page.waitForFunction(() => !document.querySelector('[data-testid="tpl-sample-dialog"]'), { timeout: 60000 })
  let left = 0
  for (const [tid, ids] of Object.entries(sampleIds)) { const t = (await q(`SELECT source FROM ${S}.ab_tables WHERE id = $1`, [tid]))[0]; left += (await q(`SELECT count(*)::int AS n FROM ${S}."${t.source}" WHERE id::text = ANY($1::text[])`, [ids]))[0].n }
  const stillHere = (await mine()).length === 1 && (await rowsOf('Inspections', 'id = $1', [insp.id])).length === 1 && (await rowsOf('NCRs', 'id = $1', [ncr.id])).length === 1 && (await rowsOf('MaintenanceRequests', 'id = ANY($1)', [[mr1.id, mr2.id]])).length === 2 && (await rowsOf('ShiftHandovers', 'id = $1', [ho.id])).length === 1
  check(left === 0 && stillHere && (await rowsOf('DowntimeReasons')).length >= 13, '"Remove sample data" removed exactly the SAMPLE rows; the rows people added and the reference rows stay', `${sampleCount} SAMPLE rows removed`)
  await templatesPage(page)
  await rowDialog(page, `tpl-uninstall-${mfg.id}`, 'tpl-uninstall')
  const items = await text(page, T('tpl-uninstall-items'))
  check(/Shop floor/.test(items) && /kept with its/.test(items), 'uninstall: the apps, flows, roles, policies, dashboards and print templates go; tables with data are kept', items.replace(/\s+/g, ' ').slice(0, 200))
  const uplan = await api('POST', `/templates/installed/${mfg.id}/uninstall/plan`, {})
  const plansItem = uplan.items.find((i) => i.kind === 'table' && i.name === 'Inspection plans')
  check(!uplan.problems.length && (await rowsOf('InspectionPlans')).length === 0 && plansItem?.action === 'kept' && /looks it up/.test(plansItem.note) && !(await page.$eval(T('tpl-uninstall-go'), (b) => b.disabled)), 'after "Remove sample data", uninstall keeping tables is allowed: the emptied Inspection plans table is kept because the kept Inspections table looks it up (the plan says so)', plansItem ? `${plansItem.action}: ${plansItem.note}` : 'no item')
  const uproblems = await page.$(T('tpl-uninstall-problems')) ? await text(page, T('tpl-uninstall-problems')) : ''
  if (uproblems) log(`uninstall dialog says: ${uproblems.replace(/\s+/g, ' ').slice(0, 300)}`)
  if (await page.$eval(T('tpl-uninstall-go'), (b) => b.disabled)) log(`uninstall dialog: ${(await text(page, T('tpl-uninstall'))).replace(/\s+/g, ' ').slice(0, 900)}`)
  await click(page, T('tpl-uninstall-go'))
  await page.waitForFunction(() => !document.querySelector('[data-testid="tpl-uninstall"]'), { timeout: 90000 })
  check(!(await appDef(appId('ShopFloor'))) && !(await q(`SELECT 1 FROM ${S}.ab_flows WHERE id = ANY($1)`, [flowIds])).length && (await tableOf('MfgProductionLog')) && (await tableOf('NCRs')) && (await tableOf('InspectionPlans')), 'uninstalled: apps and flows gone, MfgProductionLog and NCRs (with data) kept, and the empty Inspection plans they look up')

  /* 13. nothing that existed changed */
  const after = await snapshot()
  const changed = [...before.entries()].filter(([k, v]) => after.get(k) !== v).map(([k]) => k)
  check(changed.length === 0, `nothing that existed before changed (${before.size} things compared byte for byte, the old ProductionLog and its row, the Operator role, the app)`, changed.join(', '))
  const audit = (await q(`SELECT action, count(*)::int AS n FROM ${S}.ab_audit WHERE action LIKE 'template.%' GROUP BY action ORDER BY action`)).map((r) => `${r.action} ${r.n}`)
  check(audit.includes('template.install 2') && audit.includes('template.upgrade 1') && audit.includes('template.sample.remove 1') && audit.includes('template.uninstall 1') && audit.includes('template.flows.enable 1'), 'every install, flow switch, upgrade, sample removal and uninstall is in the audit log', audit.join(', '))
  check(!errors.length, 'no script errors in the browser', errors.slice(0, 3).join(' | '))
} catch (e) {
  failed = true
  console.error(e)
  // what the flows did (a failed step says why)
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
