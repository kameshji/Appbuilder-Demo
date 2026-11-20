#!/usr/bin/env node
/**
 * Phase 2 exit check 4, auto apps: "Create app from table" makes a working list / detail / edit app for desktop and for
 * phone in one click, and the result opens in the Studio as an ordinary app. DEVELOPER TOOL (sandbox values only), not
 * part of the product. Re-runnable.
 *
 *   npm run build   (the server serves dist/)
 *   node scripts/exit-check/p2-autoapp.mjs
 *
 * A server is started in this process (EXIT_PORT, default 5191) on an EMPTY database (EXIT_DB_NAME, default ab_d1:
 * created and dropped here; KEEP=1 keeps it). Tables are made through the API: Customers (every common column type,
 * the recycle bin on) and Orders (a required lookup to Customers). Then, by clicking in headless Chrome:
 *
 *  A. desktop app from the Tables page ("Create app", both tables): run it; home tile, the list shows the rows, search
 *     and sort run on the server, open a record, edit and save, the related Orders list shows the customer's orders,
 *     "+ Add" creates an order with the customer filled in, New order with the lookup picked in the form, Delete asks
 *     first (Cancel keeps it, Delete removes it), Undo brings it back; the timeline is there;
 *  B. phone app from Apps > From the data model, run at 360x800 with touch emulation (isMobile, hasTouch): cards, search,
 *     the card sort, open, edit, save, the related screen, + Add, delete with confirmation, Take photo on the image
 *     field, no sideways scrolling;
 *  C. the table page's "Create app" (one table) creates and opens an app in the Studio;
 *  D. the Studio: the desktop app opens there as a normal app; changing a property is saved like any other edit;
 *  E. a user without the Maker role sees no entry point;
 *  F. demo mode (dist/index.html from disk, no server): Apps > From a table on the seeded Contacts, run, open, delete.
 *
 * Real phones were not used: B is Chrome's phone emulation.
 *
 * Settings: EXIT_DB_HOST (127.0.0.1), EXIT_DB_PORT (5435), EXIT_DB_USER (abdev), EXIT_DB_PASSWORD (abdev-sandbox-only),
 * EXIT_DB_NAME (ab_d1), EXIT_MAINT_DB (appbuilder_test), EXIT_PORT (5191), EXIT_WORKSPACE (a folder named ...workspace...,
 * emptied; default a new temp folder), PUPPETEER_CORE, CHROME_PATH, SHOTS (screenshots).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const DB = { host: E.EXIT_DB_HOST || '127.0.0.1', port: Number(E.EXIT_DB_PORT || 5435), user: E.EXIT_DB_USER || 'abdev', password: E.EXIT_DB_PASSWORD || 'abdev-sandbox-only', database: E.EXIT_DB_NAME || 'ab_d1' }
const MAINT = E.EXIT_MAINT_DB || 'appbuilder_test'
const PORT = Number(E.EXIT_PORT || 5191)
if ([5174, 5433].includes(PORT) || DB.port === 5433) { console.error('Ports 5174 and 5433 belong to a real install: not used here.'); process.exit(2) }
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = E.SHOTS || ''
const ADMIN = { name: 'Exit Admin', email: 'exit-admin@example.test', password: 'Exit-Example-Pass-2026' }
const USER = { name: 'Una User', email: 'una@example.test', password: 'Una-Example-Pass-2026' }
if (!/^(ab_d\d+|ab_s\d+|appbuilder_exit)/.test(DB.database)) { console.error('The database name must start with ab_d<n>, ab_s<n> or appbuilder_exit (it is dropped).'); process.exit(2) }
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) { console.error('Build the app first (npm run build).'); process.exit(2) }

const imp = (p) => import(pathToFileURL(path.join(root, p)).href)
const { createApp } = await imp('server/core/app.ts')
const { serveStatic } = await imp('server/core/static.ts')
const { setQuiet } = await imp('server/core/util.ts').catch(() => ({ setQuiet: null }))
const { Client } = await imp('server/core/kernel-testkit.ts')
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

/* ------------------------------------------------------------------ server */

const DIR = E.EXIT_WORKSPACE ? path.resolve(E.EXIT_WORKSPACE) : fs.mkdtempSync(path.join(os.tmpdir(), 'ab-exit-autoapp-'))
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
async function api(c, method, p, body) {
  const r = await c.req(method, p, body)
  if (r.status !== 200) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`)
  return r.data
}
const rowsOf = async (table) => (await api(admin, 'POST', '/query', { plan: { version: 2, table } })).rows

/* ------------------------------------------------------------------ browser helpers */

let browser = null
const T = (id) => `[data-testid="${id}"]`
const errors = []
async function shot(page, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }) } }
const waitFor = (page, sel, timeout = 20000) => page.waitForSelector(sel, { visible: true, timeout })
async function click(page, sel) { await page.waitForSelector(`${sel}:not([disabled])`, { visible: true, timeout: 20000 }); await (await waitFor(page, sel)).click() }
async function newPage(ctx, phone = false) {
  const page = await ctx.newPage()
  if (phone) await page.setViewport({ width: 360, height: 800, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  else await page.setViewport({ width: 1600, height: 1000 })
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.accept())
  return page
}
async function signIn(page, who) {
  await page.goto(`${BASE}/#u`, { waitUntil: 'domcontentloaded' })
  if (!(await page.waitForSelector('input[type=email]', { timeout: 15000 }).catch(() => null))) {
    await page.goto(`${BASE}/#u`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('input[type=email]', { timeout: 20000 })
  }
  await page.type('input[type=email]', who.email)
  await page.type('input[type=password]', who.password)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 30000 })
  await sleep(500)
}

/** the id of a UI component of the app on screen (the shared store of the Studio and the standalone player) */
async function idOf(page, name) {
  const id = await page.waitForFunction((name) => {
    const st = window.__ab?.store?.getState?.()
    const stack = [...(st?.app?.screens ?? [])]
    while (stack.length) { const n = stack.pop(); if (n.name === name) return n.id; stack.push(...n.children) }
    return null
  }, { timeout: 20000 }, name)
  return id.jsonValue()
}
const N = async (page, name) => `[data-node-id="${await idOf(page, name)}"]`
const waitScreen = (page, name, timeout = 15000) => page.waitForFunction((name) => {
  const st = window.__ab?.store?.getState?.()
  if (!st) return false
  const cur = st.app.screens.find((s) => s.id === st.runtime.currentScreenId)?.name ?? st.app.screens[0]?.name
  return cur === name
}, { timeout }, name)
/** click the button inside a Button UI component */
async function press(page, name) {
  const sel = `${await N(page, name)} button`
  await page.waitForSelector(`${sel}:not([disabled])`, { visible: true, timeout: 15000 })
  await page.$eval(sel, (b) => b.scrollIntoView({ block: 'center' }))
  await (await page.$(sel)).click()
}
/** rows (table) or cards (phone) shown by a DataTable UI component */
const listItems = (page, sel) => page.$$eval(`${sel} tbody tr[aria-selected], ${sel} [data-card]`, (rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ').trim()))
async function waitItems(page, sel, pred, what, timeout = 15000) {
  const end = Date.now() + timeout
  let last = []
  for (;;) {
    last = await listItems(page, sel).catch(() => [])
    if (pred(last)) return last
    if (Date.now() > end) {
      await shot(page, `fail-${what.replace(/\W+/g, '-')}.png`).catch(() => undefined)
      const scroll = await page.$eval(`${sel} .overflow-auto`, (e) => `scrollTop ${e.scrollTop} of ${e.scrollHeight}, client ${e.clientHeight}`).catch(() => '')
      throw new Error(`${what}: ${JSON.stringify(last.slice(0, 5))} (${last.length}) ${scroll}`)
    }
    await sleep(200)
  }
}
/** replace the text of an input */
async function retype(page, sel, text) {
  await page.waitForSelector(sel, { visible: true, timeout: 15000 })
  await page.$eval(sel, (e) => e.scrollIntoView({ block: 'center' }))
  await page.click(sel)
  await page.$eval(sel, (e) => e.select())
  await page.keyboard.press('Backspace')
  if (text) await page.type(sel, text)
}
const setField = (page, formSel, col, text) => retype(page, `${formSel} [id$="-${col}"]`, text)
/** a choice / lookup field of the Form (Radix select): open it, pick the option */
async function pickOption(page, formSel, col, label) {
  const sel = `${formSel} [id$="-${col}"]`
  await page.waitForSelector(sel, { visible: true, timeout: 15000 })
  await page.$eval(sel, (e) => e.scrollIntoView({ block: 'center' }))
  await page.click(sel)
  await page.waitForSelector('[role="option"]', { visible: true, timeout: 10000 })
  const ok = await page.evaluate((label) => {
    const o = [...document.querySelectorAll('[role="option"]')].find((x) => x.textContent.trim() === label)
    if (!o) return false
    o.scrollIntoView({ block: 'center' })
    return true
  }, label)
  if (!ok) throw new Error(`no option ${label}`)
  const handles = await page.$$('[role="option"]')
  for (const h of handles) if ((await h.evaluate((x) => x.textContent.trim())) === label) { await h.click(); break }
  await sleep(200)
}
async function formValue(page, formSel, col) {
  return page.$eval(`${formSel} [id$="-${col}"]`, (e) => (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' ? e.value : e.textContent)).catch(() => null)
}
/** wait until the data API agrees */
async function waitApi(fn, what, timeout = 15000) {
  const end = Date.now() + timeout
  let last
  for (;;) {
    last = await fn()
    if (last) return last
    if (Date.now() > end) {
      if (lastPage) await shot(lastPage, `fail-${what.replace(/\W+/g, '-')}.png`).catch(() => undefined)
      const msg = lastPage ? await lastPage.evaluate(() => [...document.querySelectorAll('[role="alert"], [data-testid="toast"], [role="status"]')].map((e) => e.innerText).join(' | ') + ' LOG ' + JSON.stringify((window.__ab?.store?.getState?.().debugLog ?? []).slice(-6))).catch(() => '') : ''
      throw new Error(`${what}: not on the server ${msg}`)
    }
    await sleep(300)
  }
}

/* ------------------------------------------------------------------ the dialog */

async function createFromDialog(page, { open, tables, device, name, single, dark }) {
  await click(page, T(open))
  await waitFor(page, T('auto-app-dialog'))
  if (single) await page.select(T('auto-app-table'), single)
  for (const t of tables ?? []) {
    const box = T(`auto-app-table-${t}`)
    const on = await page.$eval(box, (e) => e.getAttribute('data-state') === 'checked')
    if (!on) await click(page, box)
  }
  await click(page, T(`auto-app-device-${device}`))
  await retype(page, T('auto-app-name'), name)
  const preview = await page.$$eval(T('auto-app-screen'), (l) => l.map((x) => x.innerText))
  const issues = await page.$$eval('[data-testid^="auto-app-issue-"]', (l) => l.map((x) => x.innerText.replace(/\s+/g, ' ')))
  await shot(page, `dialog-${device}.png`)
  if (dark) {
    // the dialog in the dark theme (screenshot only)
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    await shot(page, `dialog-${device}-dark.png`)
    await page.evaluate(() => document.documentElement.classList.remove('dark'))
  }
  await click(page, T('auto-app-create'))
  await page.waitForFunction(() => /^#studio-/.test(location.hash), { timeout: 30000 })
  await waitFor(page, T('studio-root'), 30000)
  const id = await page.evaluate(() => location.hash.slice('#studio-'.length))
  return { id, preview, issues }
}

/* ------------------------------------------------------------------ run checks shared by desktop and phone */

let lastPage = null
async function runChecks(page, label, appId, phone) {
  lastPage = page
  const P = (s) => `${label}: ${s}`
  await page.goto(`${BASE}/?r=${Date.now()}#run-${appId}`, { waitUntil: 'domcontentloaded' })
  await waitScreen(page, 'Home', 30000)
  await shot(page, `${label}-home.png`)
  const counts = await page.$eval(await N(page, 'CustomersCount'), (e) => e.innerText)
  check(/12 records/.test(counts), P('the home screen shows a tile per table with its row count (a count query)'), counts)
  await press(page, 'CustomersTile')
  await waitScreen(page, 'CustomersList')
  const list = await N(page, 'CustomersTable')
  let items = await waitItems(page, list, (r) => r.length === 12, 'list rows')
  check(items.length === 12 && items[0].includes('Customer 12'), P('the list shows the rows, newest first'), `${items.length} rows, first "${items[0].slice(0, 40)}"`)
  if (phone) check(await page.$(`${list} [data-testid="data-cards"]`) && /Gold/.test(items[0]) && /Employees: 120/.test(items[0]), P('phone: the list is drawn as cards (title, Tier as subtitle, number lines)'), items[0])
  await shot(page, `${label}-list.png`)

  // search (server side: the DataTable re-plans its Items with a contains search)
  await page.type(`${list} input[placeholder="Search"]`, 'Customer 07')
  items = await waitItems(page, list, (r) => r.length === 1, 'search result')
  check(items[0].includes('Customer 07'), P('search narrows the list'), items[0].slice(0, 60))
  await retype(page, `${list} input[placeholder="Search"]`, '')
  await waitItems(page, list, (r) => r.length === 12, 'search cleared')

  // sort by Name (header on desktop, the "Sort by" select on phone)
  if (phone) {
    await page.select(`${list} select[aria-label="Sort by"]`, 'Name')
    items = await waitItems(page, list, (r) => r[0]?.includes('Customer 01'), 'sorted ascending')
    await page.click(`${list} [data-testid="card-sort"] button`)
  } else {
    const headers = await page.$$(`${list} thead th`)
    let nameTh = null
    for (const h of headers) if ((await h.evaluate((e) => e.innerText.trim())) === 'Name') nameTh = h
    await nameTh.click()
    items = await waitItems(page, list, (r) => r[0]?.includes('Customer 01'), 'sorted ascending')
    await nameTh.click()
  }
  items = await waitItems(page, list, (r) => r[0]?.includes('Customer 12') && r[11]?.includes('Customer 01'), 'sorted descending')
  check(true, P('sorting by Name works both ways (on the server)'), `${items[0].slice(0, 20)} ... ${items[11].slice(0, 20)}`)

  // open a record, edit, save
  const row = phone ? `${list} [data-card]` : `${list} tbody tr[aria-selected]`
  const all = await page.$$(row)
  let target = null
  for (const r of all) if ((await r.evaluate((e) => e.innerText)).includes('Customer 03')) target = r
  await target.click()
  await waitScreen(page, 'CustomersDetail')
  const form = await N(page, 'CustomersForm')
  await page.waitForFunction((s) => document.querySelector(`${s} [id$="-Name"]`)?.value === 'Customer 03', { timeout: 15000 }, form)
  check(true, P('a row opens the detail screen with the record in the form'))
  if (phone) check(await page.$(`${form} [data-testid="attachment-take-photo-Logo"]`), P('phone: the image field offers Take photo'))
  else check(await page.$(`[data-testid="record-timeline"]`), P('desktop: the record timeline is beside the form'))
  await shot(page, `${label}-detail.png`)
  const newEmail = `${label}-03@example.test`
  await setField(page, form, 'Email', newEmail)
  await click(page, `${form} ${T('form-save')}`)
  await waitScreen(page, 'CustomersList')
  const c03 = await waitApi(async () => (await rowsOf('Customers')).find((r) => r.Name === 'Customer 03' && r.Email === newEmail), 'edit saved')
  check(c03, P('edit and Save stores the change and returns to the list'), newEmail)

  // related list (desktop: a tab beside the form; phone: the related screen)
  const open03 = async () => {
    const rows = await page.$$(row)
    for (const r of rows) if ((await r.evaluate((e) => e.innerText)).includes('Customer 03')) { await r.click(); break }
    await waitScreen(page, 'CustomersDetail')
  }
  await waitItems(page, list, (r) => r.length === 12, 'list back')
  await open03()
  if (phone) {
    await press(page, 'CustomersMoreButton')
    await waitScreen(page, 'CustomersRelated')
  }
  const tabs = await N(page, 'CustomersTabs')
  await page.waitForSelector(`${tabs} [role="tab"]`, { visible: true })
  for (const h of await page.$$(`${tabs} [role="tab"]`)) if ((await h.evaluate((e) => e.innerText.trim())) === 'Sales orders') await h.click()
  const rel = await N(page, 'CustomersRelatedSalesOrders')
  const mine = (await rowsOf('SalesOrders')).filter((o) => o.Customer === c03.id).length
  items = await waitItems(page, rel, (r) => r.length === mine, 'related orders')
  check(mine >= 3 && items.filter((x) => x.includes('ORD-03')).length === 3, P("the related list shows the customer's orders (a server filter on the lookup)"), `${items.length} of ${mine}`)
  await shot(page, `${label}-related.png`)

  // + Add: a new order with the customer already filled in
  await press(page, 'CustomersAddSalesOrders')
  await waitScreen(page, 'SalesOrdersDetail')
  const oform = await N(page, 'SalesOrdersForm')
  await page.waitForFunction((s) => !!document.querySelector(`${s} [id$="-OrderNo"]`), { timeout: 15000 }, oform)
  const pre = await formValue(page, oform, 'Customer')
  await setField(page, oform, 'Amount', '42')
  await setField(page, oform, 'OrderNo', `${label.toUpperCase()}-ADD`)
  await click(page, `${oform} ${T('form-save')}`)
  const added = await waitApi(async () => (await rowsOf('SalesOrders')).find((o) => o.OrderNo === `${label.toUpperCase()}-ADD`), '+ Add saved')
  check(added.Customer === c03.id, P('"+ Add" creates a child row with the lookup set to this record'), `picker showed "${(pre ?? '').trim()}"`)
  await waitScreen(page, phone ? 'CustomersRelated' : 'CustomersDetail')

  // New order from the Orders list, the lookup picked in the form
  await page.goto(`${BASE}/?r=${Date.now()}#run-${appId}`, { waitUntil: 'domcontentloaded' })
  await waitScreen(page, 'Home', 30000)
  await press(page, 'SalesOrdersTile')
  await waitScreen(page, 'SalesOrdersList')
  await press(page, 'SalesOrdersNewButton')
  await waitScreen(page, 'SalesOrdersDetail')
  const oform2 = await N(page, 'SalesOrdersForm')
  await setField(page, oform2, 'OrderNo', `${label.toUpperCase()}-NEW`)
  await pickOption(page, oform2, 'Customer', 'Customer 05')
  await pickOption(page, oform2, 'Status', 'Open')
  await shot(page, `${label}-new-order.png`)
  await click(page, `${oform2} ${T('form-save')}`)
  await waitScreen(page, 'SalesOrdersList')
  const c05 = (await rowsOf('Customers')).find((r) => r.Name === 'Customer 05')
  const made = await waitApi(async () => (await rowsOf('SalesOrders')).find((o) => o.OrderNo === `${label.toUpperCase()}-NEW`), 'new order saved')
  check(made.Customer === c05.id && made.Status === 'Open', P('New, with the lookup picked in the form, creates the row'), made.OrderNo)

  // delete with confirmation: Cancel keeps it, Delete removes it, Undo restores it
  const olist = await N(page, 'SalesOrdersTable')
  const orow = phone ? `${olist} [data-card]` : `${olist} tbody tr[aria-selected]`
  const openMade = async () => {
    await waitItems(page, olist, (r) => r.some((x) => x.includes(`${label.toUpperCase()}-NEW`)), 'order in the list')
    for (const r of await page.$$(orow)) if ((await r.evaluate((e) => e.innerText)).includes(`${label.toUpperCase()}-NEW`)) { await r.click(); break }
    await waitScreen(page, 'SalesOrdersDetail')
  }
  await openMade()
  await press(page, 'SalesOrdersDeleteButton')
  await page.waitForSelector('[role="dialog"][aria-label="Delete this record?"]', { visible: true, timeout: 10000 })
  await shot(page, `${label}-delete-confirm.png`)
  await press(page, 'SalesOrdersDeleteCancel')
  await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Delete this record?"]'), { timeout: 10000 })
  await sleep(600)
  check((await rowsOf('SalesOrders')).some((o) => o.id === made.id), P('Delete asks first; Cancel keeps the row'))
  await press(page, 'SalesOrdersDeleteButton')
  await press(page, 'SalesOrdersDeleteConfirm')
  await waitScreen(page, 'SalesOrdersList')
  await waitApi(async () => !(await rowsOf('SalesOrders')).some((o) => o.id === made.id), 'deleted')
  check(true, P('Delete in the confirmation removes the row and returns to the list'))
  const undo = await page.waitForSelector(T('undo-delete'), { visible: true, timeout: 8000 }).catch(() => null)
  if (undo) {
    await shot(page, `${label}-undo.png`)
    await page.click(`${T('undo-delete')} button`)
    await waitApi(async () => (await rowsOf('SalesOrders')).some((o) => o.id === made.id), 'restored')
    check(true, P('Undo (the table keeps deleted rows) brings the row back'))
  } else check(false, P('Undo offered after the delete'), 'no undo toast')
}

/* ------------------------------------------------------------------ main */

let failed = false
try {
  await maint(`DROP DATABASE IF EXISTS "${DB.database}"`)
  await start()
  const setupCode = app.services.setupCode.current() ?? ''
  await api(admin, 'POST', '/setup/database', { setupCode, host: DB.host, port: DB.port, database: DB.database, user: DB.user, password: DB.password, createDatabase: true })
  await api(admin, 'POST', '/setup/admin', { setupCode, ...ADMIN })
  await api(admin, 'POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password })

  log('setup: Customers (every common column type) and Sales orders (a lookup to Customers)')
  const customers = await api(admin, 'POST', '/tables', {
    displayName: 'Customers', name: 'Customers', recycleDays: 30, columns: [
      { displayName: 'Name', name: 'Name', type: 'text', required: true },
      { displayName: 'Email', name: 'Email', type: 'email' },
      { displayName: 'Phone', name: 'Phone', type: 'phone' },
      { displayName: 'Website', name: 'Website', type: 'url' },
      { displayName: 'Notes', name: 'Notes', type: 'multiline' },
      { displayName: 'Employees', name: 'Employees', type: 'number' },
      { displayName: 'Rating', name: 'Rating', type: 'decimal' },
      { displayName: 'Credit', name: 'Credit', type: 'currency' },
      { displayName: 'Active', name: 'Active', type: 'boolean' },
      { displayName: 'Since', name: 'Since', type: 'date' },
      { displayName: 'Last visit', name: 'LastVisit', type: 'datetime' },
      { displayName: 'Tier', name: 'Tier', type: 'choice', choices: ['Gold', 'Silver', 'Bronze'] },
      { displayName: 'Logo', name: 'Logo', type: 'image' },
      { displayName: 'Contract', name: 'Contract', type: 'file' },
      { displayName: 'Code', name: 'Code', type: 'autonumber', prefix: 'C-' },
    ],
  })
  const orders = await api(admin, 'POST', '/tables', {
    displayName: 'Sales orders', name: 'SalesOrders', recycleDays: 30, columns: [
      { displayName: 'Order no', name: 'OrderNo', type: 'text', required: true },
      { displayName: 'Customer', name: 'Customer', type: 'lookup', lookupTable: 'Customers', required: true },
      { displayName: 'Status', name: 'Status', type: 'choice', choices: ['Open', 'Done'] },
      { displayName: 'Amount', name: 'Amount', type: 'currency' },
      { displayName: 'Due', name: 'Due', type: 'date' },
    ],
  })
  const ids = []
  for (let i = 1; i <= 12; i++) {
    const n = String(i).padStart(2, '0')
    const r = await api(admin, 'POST', '/data/Customers/rows', { values: { Name: `Customer ${n}`, Email: `c${n}@example.test`, Phone: `+91 98000 000${n}`, Employees: i * 10, Credit: i * 1000, Active: i % 2 === 0, Since: `2026-0${1 + (i % 9)}-1${i % 9}`, Tier: ['Gold', 'Silver', 'Bronze'][i % 3] } })
    ids.push(r.id ?? r.row?.id)
    await sleep(15) // distinct createdOn: "newest first" is deterministic
  }
  for (let i = 1; i <= 12; i++) for (let k = 1; k <= 3; k++) await api(admin, 'POST', '/data/SalesOrders/rows', { values: { OrderNo: `ORD-${String(i).padStart(2, '0')}-${k}`, Customer: ids[i - 1], Status: k === 1 ? 'Open' : 'Done', Amount: i * k } })
  const role = await api(admin, 'POST', '/roles', { name: 'App users', apps: 'all', privileges: [customers, orders].map((t) => ({ table: t.id, create: true, read: 'all', update: 'all', delete: 'all' })) })
  const una = await api(admin, 'POST', '/users', { name: USER.name, email: USER.email, password: USER.password, roleIds: [role.id] })
  await q('UPDATE ab.users SET must_change_password = false WHERE id = $1', [una.id ?? una.user?.id])
  record('setup', true, `12 customers, 36 orders, a user without the Maker role`)

  browser = await puppeteer.launch({ executablePath: E.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1000', '--allow-file-access-from-files'] })
  const ctx = await browser.createBrowserContext()
  const page = await newPage(ctx)
  await signIn(page, ADMIN)

  /* ---------------------------------------------------------------- A. desktop, from the Tables page */
  log('A. desktop app from the Tables page')
  await page.goto(`${BASE}/#tables`, { waitUntil: 'domcontentloaded' })
  const A = await createFromDialog(page, { open: 'tables-create-app', tables: ['Customers', 'SalesOrders'], device: 'desktop', name: 'Customers desktop' })
  check(A.preview.length === 5 && A.preview[0].startsWith('Home'), 'A: the dialog previews the screens (home, list and details per table)', A.preview.map((s) => s.split(' - ')[0]).join(' | '))
  check(A.issues.some((s) => /Customer/.test(s) && /not a search box/.test(s)) && A.issues.some((s) => /Notes/.test(s)), 'A: the dialog lists what it cannot do (the lookup picker, long text and files only in the form)', `${A.issues.length} issues`)
  const defA = await api(admin, 'GET', `/apps/${A.id}`)
  const appA = defA.definition
  check(appA.width === 1920 && appA.screens.map((s) => s.name).join() === 'Home,CustomersList,CustomersDetail,SalesOrdersList,SalesOrdersDetail', 'A: created through the normal app path: an ordinary 1920x1080 app on the server', appA.screens?.map((s) => s.name).join())
  await runChecks(page, 'desktop', A.id, false)

  /* ---------------------------------------------------------------- D. the Studio */
  log('D. the Studio edits the generated app like any other')
  await page.goto(`${BASE}/#studio-${A.id}`, { waitUntil: 'domcontentloaded' })
  await waitFor(page, T('studio-root'), 30000)
  const treeOpen = await page.$(T('tree-node-CustomersListTitle'))
  if (!treeOpen) await click(page, T('rail-tree'))
  await page.evaluate(() => { const st = window.__ab.store.getState(); const s = st.app.screens.find((x) => x.name === 'CustomersList'); st.selectScreen?.(s.id) })
  await click(page, T('tree-node-CustomersList'))
  await click(page, T('tree-node-CustomersListTitle'))
  await waitFor(page, T('formula-input'))
  await page.click(T('formula-input'))
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control')
  await page.keyboard.type('="Our customers"')
  await page.keyboard.press('Tab')
  await page.waitForFunction(() => document.querySelector('[data-testid="save-state"]')?.getAttribute('data-state') === 'saved', { timeout: 20000 }).catch(() => null)
  await sleep(1500)
  await shot(page, 'studio.png')
  await click(page, T('error-count'))
  await waitFor(page, T('error-list'))
  const errList = await page.$eval(T('error-list'), (e) => e.innerText.replace(/\s+/g, ' ').trim())
  await shot(page, 'studio-errors.png')
  check(/No formula or runtime errors/.test(errList), 'D: the generated app has no formula errors in the Studio', errList.slice(0, 300))
  await page.keyboard.press('Escape')
  const after = (await api(admin, 'GET', `/apps/${A.id}`)).definition
  const findNode = (list, name) => { for (const n of list) { if (n.name === name) return n; const f = findNode(n.children, name); if (f) return f } return null }
  const titleNode = findNode(after.screens, 'CustomersListTitle')?.props.Text === '="Our customers"'
  check(titleNode, 'D: in the Studio, the list title was changed in the formula bar and saved like any other app', '="Our customers"')

  /* ---------------------------------------------------------------- C. the table page */
  log('C. the table page: Create app (one table)')
  await page.goto(`${BASE}/#table-${customers.id}`, { waitUntil: 'domcontentloaded' })
  const C = await createFromDialog(page, { open: 'table-create-app', device: 'desktop', name: 'Customers only' })
  const appC = await api(admin, 'GET', `/apps/${C.id}`)
  const cDef = appC.definition
  check(cDef.screens.map((s) => s.name).join() === 'CustomersList,CustomersDetail', 'C: the table page creates a one-table app and opens it in the Studio', cDef.screens.map((s) => s.name).join())

  /* ---------------------------------------------------------------- B. phone, from Apps > From the data model */
  log('B. phone app from Apps > From the data model, run at 360x800 with touch')
  await page.goto(`${BASE}/#apps`, { waitUntil: 'domcontentloaded' })
  const B = await createFromDialog(page, { open: 'app-from-model-button', tables: ['Customers', 'SalesOrders'], device: 'phone', name: 'Customers phone', dark: true })
  const appB = await api(admin, 'GET', `/apps/${B.id}`)
  const bDef = appB.definition
  check(bDef.width === 360 && bDef.height === 800, 'B: a 360x800 phone app', bDef.screens.map((s) => s.name).join())
  const phoneCtx = await browser.createBrowserContext()
  const pp = await newPage(phoneCtx, true)
  await signIn(pp, ADMIN)
  await runChecks(pp, 'phone', B.id, true)
  await pp.goto(`${BASE}/?r=${Date.now()}#run-${B.id}`, { waitUntil: 'domcontentloaded' })
  await waitScreen(pp, 'Home', 30000)
  await press(pp, 'CustomersTile')
  await waitScreen(pp, 'CustomersList')
  const wide = await pp.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, w: window.innerWidth, fluid: document.querySelector('[data-run-surface]')?.getAttribute('data-run-surface') }))
  check(wide.sw <= wide.w + 1 && wide.fluid === 'fluid', 'B: no sideways scrolling at 360 px; the fluid phone surface', JSON.stringify(wide))

  /* ---------------------------------------------------------------- E. no Maker role, no entry point */
  log('E. a user without the Maker role')
  const uctx = await browser.createBrowserContext()
  const up = await newPage(uctx)
  await signIn(up, USER)
  await up.goto(`${BASE}/#apps`, { waitUntil: 'domcontentloaded' })
  await sleep(1500)
  const hasEntry = await up.evaluate(() => !!document.querySelector('[data-testid="app-from-table-button"], [data-testid="app-from-model-button"], [data-testid="tables-create-app"]'))
  check(!hasEntry, 'E: a user without the Maker role gets no "Create app" entry point', await up.evaluate(() => location.hash))

  /* ---------------------------------------------------------------- F. demo mode */
  log('F. demo mode (dist/index.html from disk)')
  const dctx = await browser.createBrowserContext()
  const dp = await newPage(dctx)
  lastPage = dp
  const fileUrl = pathToFileURL(path.join(root, 'dist', 'index.html')).href
  await dp.goto(`${fileUrl}#apps`, { waitUntil: 'domcontentloaded' })
  await waitFor(dp, T('page-apps'), 30000)
  const F = await createFromDialog(dp, { open: 'app-from-table-button', single: 'Contacts', device: 'desktop', name: 'Contacts auto' })
  await dp.goto(`${fileUrl}#run-${F.id}`, { waitUntil: 'domcontentloaded' })
  await waitScreen(dp, 'ContactsList', 30000)
  const dlist = await N(dp, 'ContactsTable')
  const drows = await waitItems(dp, dlist, (r) => r.length > 3, 'demo rows')
  // New, Save; then open it and Delete (seeded contacts have orders pointing at them: their delete is refused, as it should be)
  await press(dp, 'ContactsNewButton')
  await waitScreen(dp, 'ContactsDetail')
  const dform = await N(dp, 'ContactsForm')
  await setField(dp, dform, 'Name', 'Demo person')
  await click(dp, `${dform} ${T('form-save')}`)
  await waitScreen(dp, 'ContactsList')
  const drows1 = await waitItems(dp, dlist, (r) => r.length === drows.length + 1 && r[0].includes('Demo person'), 'demo new')
  await (await dp.$(`${dlist} tbody tr[aria-selected]`)).click()
  await waitScreen(dp, 'ContactsDetail')
  await dp.waitForFunction((s) => document.querySelector(`${s} [id$="-Name"]`)?.value === 'Demo person', { timeout: 15000 }, dform)
  await press(dp, 'ContactsDeleteButton')
  await press(dp, 'ContactsDeleteConfirm')
  await waitScreen(dp, 'ContactsList')
  const drows2 = await waitItems(dp, dlist, (r) => r.length === drows.length && !r.some((x) => x.includes('Demo person')), 'demo delete')
  await shot(dp, 'demo-list.png')
  check(drows1.length === drows.length + 1 && drows2.length === drows.length, 'F: demo mode: created from Apps > From a table; the list shows the rows; New + Save adds one (newest first); it opens; Delete (confirmed) removes it', `${drows.length} -> ${drows1.length} -> ${drows2.length}`)

  check(!errors.length, 'no script errors in the browser', errors.slice(0, 3).join(' | '))
} catch (e) {
  failed = true
  console.error(e)
  if (lastPage) await shot(lastPage, 'failure.png').catch(() => undefined)
  if (lastPage) console.error('app log: ' + await lastPage.evaluate(() => JSON.stringify((window.__ab?.store?.getState?.().debugLog ?? []).slice(-5)) + ' toasts ' + JSON.stringify(window.__ab?.store?.getState?.().runtime.toasts ?? [])).catch(() => ''))
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stop().catch(() => undefined)
  if (!E.KEEP) await maint(`DROP DATABASE IF EXISTS "${DB.database}"`).catch((e) => console.error(`could not drop ${DB.database}: ${e.message}`))
  if (!E.EXIT_WORKSPACE) fs.rmSync(DIR, { recursive: true, force: true })
}
const bad = results.filter((r) => !r.ok)
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed${failed ? ' (stopped at the first failure)' : ''}`)
process.exit(failed || bad.length ? 1 : 0)
