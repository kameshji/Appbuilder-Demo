#!/usr/bin/env node
/**
 * Phase 3 package P, exit check 12 (docs/plan/p3-spec.md): the built-in ERP-lite pack (operational, no tax) and the
 * synchronous stock balance against a REAL server, with a headless browser for the stores phone. DEVELOPER TOOL (sandbox
 * values only), not part of the product. Re-runnable.
 *
 *   npm run build   (the server serves dist/)
 *   node scripts/exit-check/p3-erp.mjs
 *
 * A server is started in this process (EXIT_PORT, default 5326) on an EMPTY database (EXIT_DB_NAME, default
 * appbuilder_exit_p3erp: created and dropped here; KEEP=1 keeps it), workspace EXIT_WORKSPACE (default
 * .sandbox/erp/workspace, emptied). Through the API, as the person named: the installs (the CRM template first when the
 * catalogue has it, so ERP-lite must reuse the common business model it installed; else the business model alone), the
 * purchase cycle, sales, deliveries, invoices, roles, the parallel issues, the upgrade, Remove sample data and the
 * uninstall. In the browser (360 x 800, touch, Android user agent): the stores phone app, scanning an item code (a
 * keyboard-wedge scanner typing into the scan field), receiving, and an issue saved offline that the server refuses when
 * the phone reconnects: it stays in the phone's outbox with the server's message. The 1.1.0 version is a test fixture
 * (server/core/templates/testdata/erp-lite-next.ts), registered in this process; it is not built in.
 *
 *  1. install: the common business model (through the CRM template if it is in the catalogue), then ERP-lite Linked
 *     with SAMPLE rows; it creates no Products or Accounts of its own; its stock table is a synchronous balance;
 *     the flows arrive off and are switched on;
 *  2. purchase: a request (raised by the requester) is approved by the manager on behalf of the requester (who cannot
 *     approve it), becomes a purchase order (flow), above Rs 50,000 is approved by the manager, is received in two
 *     partial goods receipts; the stock follows every movement; the order becomes Partly received, then Received;
 *  3. the stores phone: scan the item code, receive (online), then an issue beyond the stock saved offline: on
 *     reconnect it is refused with the server's message and stays in the outbox; the stock is unchanged;
 *  4. sales: an order priced from the price list, delivered in part with a delivery challan (PDF), a delivery beyond
 *     the stock refused in plain words; delivered: a commercial invoice is created with no tax (PDF, "NOT A TAX INVOICE");
 *  5. 20 parallel issues of the last 10 units: exactly 10 succeed, the stock never goes below zero;
 *  6. the Stock dashboard's "below reorder level" tile as the stores see it; roles: a sales person sees only their own
 *     orders, the stores cannot read purchase rates, a requester cannot create purchase orders, nobody writes the stock;
 *  7. upgrade to 1.1.0 (new column, new reference row), the stock untouched; Remove sample data removes exactly the
 *     SAMPLE rows; uninstall keeps the tables with data and removes the apps, flows and roles.
 *
 * Settings: EXIT_DB_HOST (127.0.0.1), EXIT_DB_PORT (5435), EXIT_DB_USER (abdev), EXIT_DB_PASSWORD (abdev-sandbox-only),
 * EXIT_DB_NAME, EXIT_MAINT_DB (appbuilder_test), EXIT_PORT (5326), EXIT_WORKSPACE, PUPPETEER_CORE, CHROME_PATH, SHOTS.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { chromePath, puppeteerCorePath } from './browser-env.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const DB = { host: E.EXIT_DB_HOST || '127.0.0.1', port: Number(E.EXIT_DB_PORT || 5435), user: E.EXIT_DB_USER || 'abdev', password: E.EXIT_DB_PASSWORD || 'abdev-sandbox-only', database: E.EXIT_DB_NAME || 'appbuilder_exit_p3erp' }
const MAINT = E.EXIT_MAINT_DB || 'appbuilder_test'
const PORT = Number(E.EXIT_PORT || 5326)
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = E.SHOTS || ''
const S = 'env_default'
const PASS = 'Exit-Example-Pass-2026'
const ADMIN = { name: 'Exit Admin', email: 'exit-admin@example.test', password: PASS }
const PEOPLE = {
  mgr: { name: 'Mala Manager', email: 'mala@example.test', role: 'Manager' },
  req: { name: 'Ravi Requester', email: 'ravi@example.test', role: 'Requester', manager: 'mgr' },
  pur: { name: 'Priya Purchase', email: 'priya@example.test', role: 'Purchase' },
  st: { name: 'Sunil Stores', email: 'sunil@example.test', role: 'Stores' },
  s1: { name: 'Sara Sales', email: 'sara@example.test', role: 'Sales' },
  s2: { name: 'Sam Sales', email: 'sam@example.test', role: 'Sales' },
}
if (!/^(ab_d\d+|ab_s\d+|appbuilder_exit)/.test(DB.database)) { console.error('The database name must start with ab_d<n>, ab_s<n> or appbuilder_exit (it is dropped).'); process.exit(2) }
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) { console.error('Build the app first (npm run build).'); process.exit(2) }

const imp = (p) => import(pathToFileURL(path.join(root, p)).href)
const { createApp } = await imp('server/core/app.ts')
const { serveStatic } = await imp('server/core/static.ts')
const { setQuiet } = await imp('server/core/util.ts').catch(() => ({ setQuiet: null }))
const { Client } = await imp('server/core/kernel-testkit.ts')
const { hashPassword } = await imp('server/core/password.ts')
const { registerTestTemplates } = await imp('server/core/templates/catalogue.ts')
const { erpLiteNext } = await imp('server/core/templates/testdata/erp-lite-next.ts')
const { compileQuery, finishQuery } = await imp('src/dashboards/measures.ts')
const { runInEnvironment } = await imp('server/core/env-context.ts')
const { default: puppeteer } = await import(pathToFileURL(path.join(puppeteerCorePath(root), 'lib/puppeteer/puppeteer-core.js')).href)
if (setQuiet) setQuiet(true)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`)
const results = []
const record = (name, ok, evidence = '') => { results.push({ name, ok, evidence }); log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence ? `: ${evidence}` : ''}`) }
const check = (cond, name, evidence) => { record(name, !!cond, evidence); if (!cond) throw new Error(`check failed: ${name} ${evidence ?? ''}`) }
async function until(fn, what, ms = 60000, step = 400) {
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

const DIR = path.resolve(E.EXIT_WORKSPACE || path.join(root, '.sandbox', 'erp', 'workspace'))
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
const who = {}
async function api(method, p, body, c = admin) {
  const r = await c.req(method, p, body)
  if (r.status !== 200) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`)
  return r.data
}
const as = (k) => who[k].api
const insert = async (k, table, values) => (await api('POST', `/data/${table}/rows`, { values }, k === 'admin' ? admin : as(k))).row
const patch = async (k, table, id, changes) => (await api('PATCH', `/data/${table}/rows/${id}`, { changes }, as(k))).row
const tableOf = async (name) => (await q(`SELECT id, name, source, def FROM ${S}.ab_tables WHERE lower(name) = lower($1)`, [name]))[0]
const rowsOf = async (name, where = 'TRUE', params = []) => { const t = await tableOf(name); return q(`SELECT * FROM ${S}."${t.source}" WHERE ${where}`, params) }
const notified = async (email, re) => (await q(`SELECT n.title FROM ab.notifications n JOIN ab.users u ON u.id = n.user_id WHERE lower(u.email) = lower($1)`, [email])).filter((n) => re.test(n.title))
const onHand = async (item, loc) => Number((await rowsOf('StockBalances', '"Item" = $1 AND "Location" = $2', [item, loc]))[0]?.OnHand ?? 0)
/** the job queue, approvals and flow waits worked off (as the running server would) */
async function settle() {
  for (let i = 0; i < 8; i++) {
    await app.services.kernel.drain({ timeoutMs: 60000 })
    const t = await runInEnvironment('default', () => app.services.approvals.tick(true))
    const n = await runInEnvironment('default', () => app.services.flows.sweep(true))
    if (!n && !t.delegations && !t.reminders && !t.escalations) break
  }
  await app.services.kernel.drain({ timeoutMs: 60000 })
}
async function pdfOf(templateId, recordId, c) {
  const g = await api('POST', '/print/generate', { template: templateId, recordId }, c)
  return { ok: /.pdf$/i.test(g.file?.fileName ?? ''), name: g.file?.fileName, pages: g.pages ?? g.file?.pages }
}
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
async function installTemplate(id, sample) {
  const p = await api('POST', `/templates/${id}/plan`, { mode: 'linked', sample })
  if (p.plan.problems.length) throw new Error(`${id}: ${p.plan.problems.join(' ')}`)
  return (await api('POST', `/templates/${id}/install`, { mode: 'linked', bindings: p.bindings, sample, confirm: p.plan.token, ...(p.plan.systemEvents?.length ? { approveSystem: true } : {}) })).install
}

/* ------------------------------------------------------------------ browser */

let browser = null
const T = (id) => `[data-testid="${id}"]`
const errors = []
async function shot(page, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }) } }
const waitFor = (page, sel, timeout = 20000) => page.waitForSelector(sel, { visible: true, timeout })
async function tap(page, sel, timeout = 20000) { await page.waitForSelector(`${sel}:not([disabled])`, { visible: true, timeout }); await (await waitFor(page, sel)).tap() }
async function phonePage() {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.accept())
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36')
  await page.setViewport({ width: 360, height: 800, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
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
async function typeInto(page, sel, v) {
  await page.$eval(sel, (e) => e.scrollIntoView({ block: 'center' }))
  await page.focus(sel)
  await page.$eval(sel, (e) => e.select?.())
  await page.keyboard.press('Backspace')
  await page.keyboard.type(v)
}
async function scan(page, code) {
  await page.waitForFunction(() => !!document.querySelector('[data-testid="scan-input"]'), { timeout: 30000 })
  await page.focus(T('scan-input'))
  await page.$eval(T('scan-input'), (e) => e.select?.())
  await page.keyboard.press('Backspace')
  await page.keyboard.type(code) // a keyboard-wedge scanner types the code fast, then Enter
  await page.keyboard.press('Enter')
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

  /* 1. installs */
  const catalogue = (await api('GET', '/templates')).items ?? (await api('GET', '/templates')).templates ?? []
  const hasCrm = JSON.stringify(catalogue).includes('"builtin.crm"')
  const first = hasCrm ? await installTemplate('builtin.crm', false) : await installTemplate('builtin.business-model', false)
  await settle()
  const sharedBefore = (await q(`SELECT id, name FROM ${S}.ab_tables ORDER BY id`)).map((t) => `${t.id}:${t.name}`)
  const erp = await installTemplate('builtin.erp-lite', true)
  await settle()
  const installs = await q(`SELECT * FROM ${S}.ab_template_installs ORDER BY installed_on`)
  const erpRow = installs.find((r) => r.template_id === 'builtin.erp-lite')
  const bm = installs.find((r) => r.template_id === 'builtin.business-model')
  const tablesAfter = await q(`SELECT id, name FROM ${S}.ab_tables`)
  const products = tablesAfter.filter((t) => /Products$/i.test(t.name))
  check(erpRow && bm && installs.filter((r) => r.template_id === 'builtin.business-model').length === 1 && erpRow.depends_on?.[0]?.install === bm.id && products.length === 1 && products[0].name === 'Products' && sharedBefore.every((x) => tablesAfter.some((t) => `${t.id}:${t.name}` === x)),
    `ERP-lite installed Linked after ${hasCrm ? 'the CRM template, reusing the common business model tables the CRM template installed' : 'the common business model (the CRM template is not in this catalogue), reusing its tables'}: one Products table, no copies`, `${first.templateId ?? ''}; tables ${tablesAfter.length}`)
  const sb = await tableOf('StockBalances')
  check(sb.def.balance?.movements === 'StockMovements' && sb.def.balance.column === 'OnHand' && sb.def.balance.floor === 0, 'the stock on hand table is a synchronous balance of the stock movements (floor 0)', JSON.stringify(sb.def.balance))
  const created = erp.created
  const flowIds = created.flows.map((f) => f.id)
  check((await q(`SELECT count(*)::int AS n FROM ${S}.ab_flows WHERE id = ANY($1) AND enabled`, [flowIds]))[0].n === 0, `the ${flowIds.length} flows arrived turned off`)
  await api('POST', `/templates/installed/${erp.id}/flows`, { enable: flowIds })
  check((await q(`SELECT count(*)::int AS n FROM ${S}.ab_flows WHERE id = ANY($1) AND enabled`, [flowIds]))[0].n === flowIds.length, 'the administrator switched every flow on')
  const roleId = (key) => created.roles.find((r) => r.key === key).id
  for (const [k, p] of Object.entries(PEOPLE)) {
    const u = await api('POST', '/users', { name: p.name, email: p.email, password: PASS, roleIds: [roleId(p.role)], ...(p.manager ? { managerId: who[p.manager].id } : {}) })
    await q('UPDATE ab.users SET must_change_password = false, password_hash = $1 WHERE email = $2', [await hashPassword(PASS), p.email])
    who[k] = { ...p, id: u.id ?? u.user?.id, password: PASS, api: new Client(BASE) }
    await api('POST', '/auth/login', { email: p.email, password: PASS }, who[k].api)
  }
  // masters (shared tables of the common business model) as the administrator
  const ids = {}
  ids.bolt = (await insert('admin', 'Products', { Code: 'BOLT-M10', Name: 'Hex bolt M10', Kind: 'Goods', HsnSac: '7318', StandardPrice: 12 })).id
  ids.pin = (await insert('admin', 'Products', { Code: 'PIN-6', Name: 'Dowel pin 6', Kind: 'Goods', StandardPrice: 3 })).id
  ids.supplier = (await insert('admin', 'Accounts', { Name: 'Example Fasteners (fictional)', Type: 'Supplier' })).id
  ids.customer = (await insert('admin', 'Accounts', { Name: 'Example Motors (fictional)', Type: 'Customer' })).id
  ids.pl = (await insert('admin', 'PriceLists', { Name: 'Trade 2026', IsDefault: true })).id
  await insert('admin', 'PriceListItems', { PriceList: ids.pl, Product: ids.bolt, UnitPrice: 20 })
  ids.main = (await rowsOf('Locations', `"Code" = 'SAMPLE-MAIN'`))[0].id
  await api('PATCH', `/data/Locations/rows/${ids.main}`, { changes: { Manager: who.st.id } })

  /* 2. purchase */
  const pr = await insert('req', 'PurchaseRequests', { Title: 'Bolts for the line', NeededBy: '2026-12-01', PreferredSupplier: ids.supplier, Justification: 'Monthly use' })
  await insert('req', 'PurchaseRequestLines', { Request: pr.id, Item: ids.bolt, Qty: 100, Unit: 'Nos', Rate: 700 })
  await patch('req', 'PurchaseRequests', pr.id, { Status: 'Submitted' })
  await settle()
  const ask = (await q(`SELECT * FROM ${S}.ab_approval_requests WHERE regarding_id = $1`, [pr.id]))[0]
  const asked = (await q(`SELECT u.email FROM ${S}.ab_approval_assignments a JOIN ab.users u ON u.id = a.user_id WHERE a.request_id = $1 AND a.status = 'pending'`, [ask.id])).map((x) => x.email)
  const selfTry = await as('req').post(`/approvals/${ask.id}/respond`, { response: 'Approve' })
  check(asked.join() === PEOPLE.mgr.email && (ask.definition.onBehalfOf ?? []).includes(who.req.id) && selfTry.status >= 400, 'the purchase request asks the manager on behalf of the requester; the requester is not asked and cannot approve it', `asked ${asked.join()}`)
  await api('POST', `/approvals/${ask.id}/respond`, { response: 'Approve' }, as('mgr'))
  await settle()
  const po = (await rowsOf('PurchaseOrders', '"Request" = $1', [pr.id]))[0]
  const pol = (await rowsOf('PurchaseOrderLines', '"Order" = $1', [po?.id ?? '']))
  check(po && po.Status === 'Draft' && pol.length === 1 && Number(pol[0].Quantity) === 100 && (await rowsOf('PurchaseRequests', 'id = $1', [pr.id]))[0].Status === 'Ordered' && /^PO\//.test(po.Number), 'the approved request became a draft purchase order with its line (flow); the request is Ordered', po?.Number)
  await patch('pur', 'PurchaseOrders', po.id, { Status: 'Awaiting approval' })
  await settle()
  const oask = (await q(`SELECT * FROM ${S}.ab_approval_requests WHERE regarding_id = $1`, [po.id]))[0]
  await api('POST', `/approvals/${oask.id}/respond`, { response: 'Approve' }, as('mgr'))
  await settle()
  check((await rowsOf('PurchaseOrders', 'id = $1', [po.id]))[0].Status === 'Approved', 'the purchase order of Rs 70,000 (above the Rs 50,000 limit) was approved by the manager')
  const g1 = await insert('st', 'GoodsReceipts', { PurchaseOrder: po.id, Location: ids.main, SupplierDocument: 'DC-1' })
  await insert('st', 'StockMovements', { Kind: 'Receipt', GoodsReceipt: g1.id, PurchaseOrderLine: pol[0].id, Item: ids.bolt, Location: ids.main, Quantity: 60 })
  const afterG1 = await onHand(ids.bolt, ids.main)
  await settle()
  const st1 = (await rowsOf('PurchaseOrders', 'id = $1', [po.id]))[0].Status
  const g2 = await insert('st', 'GoodsReceipts', { PurchaseOrder: po.id, Location: ids.main, SupplierDocument: 'DC-2' })
  await insert('st', 'StockMovements', { Kind: 'Receipt', GoodsReceipt: g2.id, PurchaseOrderLine: pol[0].id, Item: ids.bolt, Location: ids.main, Quantity: 40 })
  await settle()
  const st2 = (await rowsOf('PurchaseOrders', 'id = $1', [po.id]))[0].Status
  const grnPdf = await pdfOf(created.printTemplates.find((x) => x.key === 'GoodsReceipt').id, g2.id, as('st'))
  check(afterG1 === 60 && st1 === 'Partly received' && (await onHand(ids.bolt, ids.main)) === 100 && st2 === 'Received' && grnPdf.ok, 'two partial goods receipts: stock 60 then 100 at the main store; the order is Partly received, then Received; the GRN prints', `${st1} -> ${st2}`)

  /* 3. the stores phone */
  browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1000'] })
  const phone = await phonePage()
  await signIn(phone, who.st)
  const phoneApp = created.apps.find((a) => a.key === 'StoresPhone').id
  await phone.goto(`${BASE}/?app=${phoneApp}`, { waitUntil: 'networkidle2' })
  await phone.waitForFunction((id) => location.hash === `#u-${id}`, { timeout: 20000 }, phoneApp)
  await phone.waitForFunction(() => document.body.innerText.includes('Stores') && document.body.innerText.includes('Receive'), { timeout: 45000 })
  await sleep(800)
  await scan(phone, 'bolt-m10')
  await phone.waitForFunction(() => document.body.innerText.includes('Hex bolt M10'), { timeout: 30000 })
  check(true, 'phone: scanning the item code (BOLT-M10, a keyboard-wedge scan) finds the item and shows its stock')
  await shot(phone, 'erp-phone-home.png')
  await tap(phone, T('control-Receive') + ' button')
  await waitFor(phone, T('control-MoveForm'), 20000)
  const qsel = `${T('control-MoveForm')} [id$="-Quantity"]`
  await phone.waitForSelector(qsel, { timeout: 20000 })
  await typeInto(phone, qsel, '25')
  await sleep(300)
  await phone.$eval(T('form-save'), (e) => e.scrollIntoView({ block: 'center' }))
  await tap(phone, T('form-save'))
  await until(async () => (await onHand(ids.bolt, ids.main)) === 125, 'the phone receipt', 30000).catch(async (e) => { await shot(phone, 'erp-phone-receive-failed.png'); log(`phone: ${(await phone.evaluate(() => document.body.innerText)).replace(/s+/g, ' ').slice(0, 900)}`); throw e })
  check(true, 'phone: Receive 25 (location: the store the person is in charge of) raised the stock to 125 at once')
  // offline issue beyond the stock
  await phone.waitForFunction(() => document.body.innerText.includes('Receive'), { timeout: 30000 })
  await sleep(500)
  await scan(phone, 'BOLT-M10')
  await sleep(500)
  await tap(phone, T('control-Issue') + ' button')
  await waitFor(phone, T('control-MoveForm'), 20000)
  await phone.waitForSelector(qsel, { timeout: 20000 })
  await phone.setOfflineMode(true)
  await phone.waitForFunction(() => /offline/i.test(document.querySelector('[data-testid="connection-bar"]')?.textContent ?? ''), { timeout: 20000 })
  await sleep(600)
  await typeInto(phone, qsel, '500')
  await phone.$eval(T('form-save'), (e) => e.scrollIntoView({ block: 'center' }))
  await sleep(300)
  await tap(phone, T('form-save'))
  await phone.waitForFunction(() => document.querySelector('[data-testid="outbox-count"]')?.textContent === '1', { timeout: 20000 })
  check((await onHand(ids.bolt, ids.main)) === 125, 'phone offline: the issue of 500 waits on the phone (1 waiting to send); nothing reached the server')
  await phone.setOfflineMode(false)
  await phone.waitForFunction(() => /need/.test(document.querySelector('[data-testid="outbox-button"]')?.textContent ?? ''), { timeout: 60000 })
  await sleep(600)
  await shot(phone, 'erp-phone-needs-you.png')
  await phone.$eval(T('outbox-button'), (e) => e.click())
  await waitFor(phone, T('outbox-panel'), 30000)
  await sleep(400)
  const shown = await phone.$eval(`${T('outbox-item')}[data-status="rejected"] ${T('outbox-error')}`, (e) => e.textContent).catch(() => '')
  await shot(phone, 'erp-phone-rejected.png')
  const expected = 'Stock of Hex bolt M10 at SAMPLE-MAIN would go below zero: available 125, requested 500.'
  check(shown === expected && (await onHand(ids.bolt, ids.main)) === 125 && (await phone.$eval(T('outbox-count'), (e) => e.textContent)) === '1', 'back online: the server refused the issue; it stays in the phone\'s outbox with the server\'s message; the stock is unchanged', shown)

  /* 4. sales */
  const so = await insert('s1', 'SalesOrders', { Customer: ids.customer, PriceList: ids.pl, Status: 'Confirmed' })
  const sol = await insert('s1', 'SalesOrderLines', { Order: so.id, PriceList: ids.pl, Item: ids.bolt, Quantity: 500 })
  const dl = await insert('st', 'Deliveries', { SalesOrder: so.id, Location: ids.main, VehicleNo: 'XX 00 X 0000', Transporter: 'Example Transport (fictional)' })
  await insert('st', 'StockMovements', { Kind: 'Issue', Delivery: dl.id, SalesOrderLine: sol.id, Item: ids.bolt, Location: ids.main, Quantity: 100 })
  const beyond = await as('st').post('/data/StockMovements/rows', { values: { Kind: 'Issue', Delivery: dl.id, SalesOrderLine: sol.id, Item: ids.bolt, Location: ids.main, Quantity: 30 } })
  await settle()
  const soNow = (await rowsOf('SalesOrders', 'id = $1', [so.id]))[0]
  check(Number(sol.UnitPrice) === 20 && beyond.status === 422 && beyond.data.error.message === 'Stock of Hex bolt M10 at SAMPLE-MAIN would go below zero: available 25, requested 30.' && (await onHand(ids.bolt, ids.main)) === 25 && soNow.Status === 'Partly delivered',
    'a sales order (price 20 from the price list) is delivered in part (100 of 500); a further 30 is refused in plain words; the order is Partly delivered', beyond.data?.error?.message)
  await patch('st', 'Deliveries', dl.id, { Status: 'Dispatched' })
  await settle()
  const challan = await pdfOf(created.printTemplates.find((x) => x.key === 'Challan').id, dl.id, as('st'))
  check(challan.ok && (await notified(PEOPLE.s1.email, /^Dispatched: DC\//)).length === 1, 'the delivery challan prints (PDF); dispatching it notified the sales order\'s owner', challan.name)
  await patch('st', 'Deliveries', dl.id, { Status: 'Delivered' })
  await settle()
  const inv = (await rowsOf('CommercialInvoices', '"Delivery" = $1', [dl.id]))[0]
  const lines = await rowsOf('CommercialInvoiceLines', '"Invoice" = $1', [inv?.id ?? ''])
  const invTpl = created.printTemplates.find((x) => x.key === 'Invoice')
  const invDoc = JSON.stringify((await q(`SELECT doc FROM ${S}.ab_print_templates WHERE id = $1`, [invTpl.id]))[0].doc)
  const taxCols = [...(await tableOf('CommercialInvoices')).def.columns, ...(await tableOf('CommercialInvoiceLines')).def.columns].filter((c) => /tax|gst/i.test(c.name))
  const invPdf = await pdfOf(invTpl.id, inv.id, as('s1'))
  check(inv && lines.length === 1 && Number(lines[0].Amount) === 2000 && !taxCols.length && invDoc.includes('NOT A TAX INVOICE') && !/GSTIN|CGST|SGST|IGST|tax rate/i.test(invDoc) && invPdf.ok,
    'delivered: a commercial invoice (100 x 20 = 2,000, no tax column, no tax computed) is created and prints, marked NOT A TAX INVOICE', inv?.Number)

  /* 5. 20 parallel issues */
  await insert('st', 'StockMovements', { Kind: 'Receipt', Item: ids.pin, Location: ids.main, Quantity: 10 })
  const par = await Promise.all(Array.from({ length: 20 }, () => as('st').post('/data/StockMovements/rows', { values: { Kind: 'Issue', Item: ids.pin, Location: ids.main, Quantity: 1 } })))
  const okN = par.filter((r) => r.status === 200).length
  const neg = (await q(`SELECT count(*)::int AS n FROM ${S}."${sb.source}" WHERE "OnHand" < 0`))[0].n
  check(okN === 10 && par.filter((r) => r.status === 422).length === 10 && (await onHand(ids.pin, ids.main)) === 0 && neg === 0, '20 parallel issues of the last 10 units: exactly 10 succeed, 10 are refused, the stock is 0 and never below', `${okN} succeeded`)

  /* 6. dashboard and roles */
  const bal = (await rowsOf('StockBalances', '"Item" = $1 AND "Location" = $2', [ids.bolt, ids.main]))[0]
  await patch('st', 'StockBalances', bal.id, { ReorderLevel: 25, OnHand: 9999 })
  await insert('st', 'StockMovements', { Kind: 'Issue', Item: ids.bolt, Location: ids.main, Quantity: 1 })
  await settle()
  const dash = created.dashboards.find((d) => d.key === 'Stock').id
  const below = await tileValue(dash, 'below', as('st'))
  check(Number(below.Below) >= 1 && (await onHand(ids.bolt, ids.main)) === 24 && (await notified(PEOPLE.pur.email, /^Reorder: Hex bolt M10 at SAMPLE-MAIN/)).length === 1, 'the stores set a reorder level of 25 (the stock column itself cannot be written); an issue takes the stock from 25 to 24: the Purchase role got the reorder alert and the Stock dashboard counts the item below its level', JSON.stringify(below))
  await insert('s2', 'SalesOrders', { Customer: ids.customer, Status: 'Draft' })
  const saraSees = (await api('POST', '/query', { plan: { version: 2, table: 'SalesOrders', select: ['owner'] } }, as('s1'))).rows
  const samSees = (await api('POST', '/query', { plan: { version: 2, table: 'SalesOrders', select: ['owner'] } }, as('s2'))).rows
  const rate = await as('st').post('/query', { plan: { version: 2, table: 'PurchaseOrderLines', select: ['Rate'] } })
  const reqPo = await as('req').post('/data/PurchaseOrders/rows', { values: { Supplier: ids.supplier } })
  const direct = await admin.post('/data/StockBalances/rows', { values: { Item: ids.pin, Location: ids.main, OnHand: 5 } })
  check(saraSees.length >= 1 && saraSees.every((r) => r.owner === who.s1.id) && samSees.length === 1 && samSees[0].owner === who.s2.id && rate.status === 403 && [403, 404].includes(reqPo.status) && direct.status === 403,
    'roles: each sales person sees only their own sales orders; the stores cannot read purchase rates; a requester cannot create purchase orders; nobody (not even an administrator) adds stock rows directly', `sara ${saraSees.length}, sam ${samSees.length}, rate ${rate.status}, requester PO ${reqPo.status}, stock row ${direct.status} ${JSON.stringify(direct.data).slice(0, 160)}`)

  /* 7. upgrade, Remove sample data, uninstall */
  const stockBefore = JSON.stringify(await q(`SELECT id, "OnHand"::text AS q FROM ${S}."${sb.source}" ORDER BY id`))
  const unreg = registerTestTemplates([erpLiteNext()])
  try {
    const up = await api('POST', `/templates/installed/${erp.id}/upgrade/plan`, {})
    if (up.plan.problems.length) throw new Error(up.plan.problems.join(' '))
    await api('POST', `/templates/installed/${erp.id}/upgrade`, { confirm: up.plan.token, proceedWithoutBackup: true })
  } finally { unreg() }
  const locCols = (await tableOf('Locations')).def.columns.map((c) => c.name)
  check(locCols.includes('Address') && (await rowsOf('MovementReasons', `"Name" LIKE 'Sample sent%'`)).length === 1 && JSON.stringify(await q(`SELECT id, "OnHand"::text AS q FROM ${S}."${sb.source}" ORDER BY id`)) === stockBefore && (await tableOf('StockBalances')).def.balance?.movements === 'StockMovements',
    'upgraded to 1.1.0: the new column and reference row are added; the stock rows and the balance setting are untouched')
  const sampleIds = Object.values((await q(`SELECT sample_rows FROM ${S}.ab_template_installs WHERE id = $1`, [erp.id]))[0].sample_rows).flat()
  const rm = await api('POST', `/templates/installed/${erp.id}/sample/remove`, {})
  const left = []
  for (const t of await q(`SELECT source, def FROM ${S}.ab_tables`)) {
    if (!t.source || t.def.system) continue
    left.push(...(await q(`SELECT id FROM ${S}."${t.source}" WHERE id::text = ANY($1::text[])`, [sampleIds]).catch(() => [])))
  }
  check(left.length === (rm.kept?.length ?? 0) && left.length < sampleIds.length && (await rowsOf('MovementReasons')).length >= 12, '"Remove sample data" removed the SAMPLE rows (a SAMPLE location the stock still points at is kept and reported); reference rows stay', `removed ${sampleIds.length - left.length} of ${sampleIds.length}, kept ${JSON.stringify(rm.kept ?? []).slice(0, 200)}`)
  const uplan = await api('POST', `/templates/installed/${erp.id}/uninstall/plan`, {})
  await api('POST', `/templates/installed/${erp.id}/uninstall`, { confirm: uplan.token, confirmText: uplan.confirmText })
  const appsLeft = (await q(`SELECT count(*)::int AS n FROM ${S}.ab_apps WHERE id = ANY($1)`, [created.apps.map((a) => a.id)]))[0].n
  const flowsLeft = (await q(`SELECT count(*)::int AS n FROM ${S}.ab_flows WHERE id = ANY($1)`, [flowIds]))[0].n
  const rolesLeft = (await q(`SELECT count(*)::int AS n FROM ${S}.ab_roles WHERE id = ANY($1)`, [created.roles.map((r) => r.id)]))[0].n
  check(appsLeft === 0 && flowsLeft === 0 && rolesLeft === 0 && !!(await tableOf('StockMovements')) && !!(await tableOf('StockBalances')) && !!(await tableOf('Products')), 'uninstall: the apps, flows and roles are gone; the tables with data (movements, stock) and the shared business model stay')
  check(!errors.length, 'no script errors in the browser', errors.slice(0, 3).join(' | '))
} catch (e) {
  failed = true
  console.error(e)
  const runs = await q(`SELECT r.flow_name, r.state, r.error::text AS error, (SELECT string_agg(s.step_id || ':' || s.state || coalesce(' ' || s.error::text, ''), ' | ') FROM ${S}.ab_flow_steps s WHERE s.run_id = r.id) AS steps FROM ${S}.ab_flow_runs r ORDER BY r.created_on DESC LIMIT 12`).catch(() => [])
  for (const r of runs) console.error(`  run ${r.flow_name}: ${r.state} ${r.error ?? ''} [${(r.steps ?? '').slice(0, 400)}]`)
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stop().catch(() => undefined)
  if (!E.KEEP) await maint(`DROP DATABASE IF EXISTS "${DB.database}"`).catch((e) => console.error(`could not drop ${DB.database}: ${e.message}`))
}
const bad = results.filter((r) => !r.ok)
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed${failed ? ' (stopped at the first failure)' : ''}`)
process.exit(failed || bad.length ? 1 : 0)
