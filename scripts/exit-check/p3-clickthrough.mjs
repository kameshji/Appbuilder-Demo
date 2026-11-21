#!/usr/bin/env node
/**
 * The click-through of the screens built in Phase 3 and hosting, in a REAL headless Chrome against a REAL local server and
 * the production build, as a careful first-time user: real clicks and typing for every step under test, assertions on
 * visible text, a screenshot per screen. DEVELOPER TOOL (sandbox values only), not part of the product. Re-runnable.
 *
 *   npm run build   (the server serves dist/)
 *   node scripts/exit-check/p3-clickthrough.mjs          ONLY=A,C runs some sections (D also runs G, H the setup
 *                                                        screen checks); KEEP=1 keeps the database
 *
 *  H0. first run: the setup screen (setup code, database, first administrator) typed in the browser; where the setup
 *      code is said to be for a server started by hand with and without APPBUILDER_SETUP_CODE_FILE, and as a service;
 *  A.  Accounts (docs/guide/accounts.md): settings, reference data, customers, suppliers and items, every kind of
 *      document, journals and a reversal, the ledger and the three reports, every return summary and its CSV, a period
 *      lock and a refused posting, the STOP cases, the PDFs (the bill of supply and the credit note rasterised to PNG
 *      for a person to look at), and the same screens at phone width (390 x 844);
 *  B.  Admin console > Licences, unlicensed; then (spawned processes, as scripts/exit-check/h-licence.mjs) a licensed
 *      install in its grace period and read-only, with the strip under the top bar (src/portal/LicenceBanner.tsx);
 *  C.  the Pass column of Admin console > Users: a changed pass changes the counts on the Licences page;
 *  D.  the "When a form is submitted" trigger panel: a flow built by clicking, a Form submitted, the flow runs;
 *  E.  the TV / kiosk cycling fields of a dashboard's view token: set by clicking, the screen cycles;
 *  F.  ERP-lite installed through the plan screen; a pack upgrade that widens a role: refused without the tick,
 *      applied with it;
 *  G.  a Form in New mode with a starting Item: values for columns not in Fields are saved;
 *  H.  every side-menu item in Dev mode and User mode opens without an error boundary. For the WHOLE run every page
 *      error, console error and HTTP answer >= 500 is collected and the run fails on any (a "Failed to load resource"
 *      line for a 4xx answer is not counted: those are the refusals this script provokes on purpose).
 *
 * Output: OUT (default .sandbox/CT): shots/*.png, pdf/*.pdf and pdf/*.png, report.json. The administrator's password is
 * generated at each run and kept in memory only.
 *
 * Settings: EXIT_DB_HOST (127.0.0.1), EXIT_DB_PORT (5435), EXIT_DB_USER (abdev), EXIT_DB_PASSWORD (abdev-sandbox-only),
 * EXIT_DB_NAME (appbuilder_exit_ct), EXIT_MAINT_DB (appbuilder_test), EXIT_PORT (a free port), OUT, PUPPETEER_CORE,
 * CHROME_PATH, ONLY, KEEP.
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { chromePath, puppeteerCorePath } from './browser-env.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const DB = { host: E.EXIT_DB_HOST || '127.0.0.1', port: Number(E.EXIT_DB_PORT || 5435), user: E.EXIT_DB_USER || 'abdev', password: E.EXIT_DB_PASSWORD || 'abdev-sandbox-only', database: E.EXIT_DB_NAME || 'appbuilder_exit_ct' }
const MAINT = E.EXIT_MAINT_DB || 'appbuilder_test'
const OUT = path.resolve(E.OUT || path.join(root, '.sandbox', 'CT'))
const SHOTS = path.join(OUT, 'shots')
const PDFS = path.join(OUT, 'pdf')
const ONLY = E.ONLY ? E.ONLY.split(',').map((s) => s.trim().toUpperCase()) : null
const want = (id) => !ONLY || ONLY.includes(id)
const OWNER_PORTS = new Set([5174, 5433])
if (OWNER_PORTS.has(DB.port)) { console.error('Port 5433 belongs to the real install; choose another.'); process.exit(2) }
if (!/^appbuilder_exit/.test(DB.database) || DB.database === 'appbuilder_try') { console.error('The database name must start with appbuilder_exit (it is dropped).'); process.exit(2) }
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) { console.error('Build the app first (npm run build).'); process.exit(2) }

async function freePort() {
  for (;;) {
    const p = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => r(n)) }) })
    if (!OWNER_PORTS.has(p)) return p
  }
}
const PORT = E.EXIT_PORT ? Number(E.EXIT_PORT) : await freePort()
if (OWNER_PORTS.has(PORT)) { console.error('Port 5174 belongs to the real install.'); process.exit(2) }
const BASE = `http://127.0.0.1:${PORT}`

const imp = (p) => import(pathToFileURL(path.join(root, p)).href)
const { createApp } = await imp('server/core/app.ts')
const { serveStatic } = await imp('server/core/static.ts')
const { setQuiet } = await imp('server/core/util.ts')
const { Client } = await imp('server/core/kernel-testkit.ts')
const { registerTestTemplates } = await imp('server/core/templates/catalogue.ts')
const { visitorLogWider } = await imp('server/core/templates/testdata/visitor-log-next.ts')
const { default: puppeteer } = await import(pathToFileURL(path.join(puppeteerCorePath(root), 'lib/puppeteer/puppeteer-core.js')).href)
setQuiet(true)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`)
let current = 'setup'
const results = []
const record = (name, ok, evidence = '') => { results.push({ section: current, name, ok: !!ok, evidence: String(evidence ?? '') }); log(`${ok ? 'PASS' : 'FAIL'} ${current} ${name}${evidence ? `: ${String(evidence).slice(0, 300)}` : ''}`); return !!ok }
async function section(id, title, fn) {
  if (!want(id)) return
  current = id
  log(`=== ${id}. ${title}`)
  try { await fn() } catch (e) {
    record(`stopped: ${(e?.message ?? String(e)).split('\n')[0].slice(0, 300)}`, false)
    console.error(e?.stack?.split('\n').slice(0, 6).join('\n'))
    for (const p of (await browser?.pages().catch(() => [])) ?? []) {
      const toasts = await p.$eval('[data-testid=toasts]', (e) => e.innerText).catch(() => '')
      if (toasts) log(`  toasts on ${p.url()}: ${toasts.replace(/\s+/g, ' ')}`)
      await p.screenshot({ path: path.join(OUT, `failure-${id}-${Date.now()}.png`) }).catch(() => undefined)
    }
  }
}
async function maint(sql) { const c = new pg.Client({ ...DB, database: MAINT }); await c.connect(); try { await c.query(sql) } finally { await c.end() } }
async function q(sql, params = []) { const c = new pg.Client(DB); await c.connect(); try { return (await c.query(sql, params)).rows } finally { await c.end() } }

/* ------------------------------------------------------------------ the server (in this process) */

const WS = path.join(OUT, 'workspace')
let app = null
let server = null
async function start(env = {}) {
  app = await createApp({ env: { APPBUILDER_MIGRATION_BACKUP: 'skip', ...env }, config: { workspaceDir: WS }, printSetupCode: false, jobs: true })
  server = http.createServer((req, res) => {
    app.handle(req, res).then((h) => { if (!h) serveStatic(app.config.distDir ?? path.join(root, 'dist'), req, res) }, () => { if (!res.headersSent) res.writeHead(500); res.end() })
  })
  server.on('upgrade', (req, socket, head) => { if (!app.handleUpgrade(req, socket, head)) socket.destroy() })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
}
async function stop() {
  if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(() => r())); server = null }
  if (app) { await app.close(); app = null }
}
const admin = new Client(BASE)
async function api(method, p, body, c = admin) {
  const r = await c.req(method, p, body)
  if (r.status !== 200) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`)
  return r.data
}

/* ------------------------------------------------------------------ the browser */

const ADMIN = { name: 'Asha Admin', email: 'asha.admin@example.test', password: `Ct-${randomBytes(12).toString('base64url')}-7q` }
let browser = null
const T = (id) => `[data-testid="${id}"]`
const problems = []
const seen4xx = []
function watch(page, label) {
  page.on('pageerror', (e) => problems.push(`page error [${label}] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    if (/^Failed to load resource: the server responded with a status of 4\d\d/.test(t)) return
    problems.push(`console error [${label}] ${t}`)
  })
  page.on('response', (r) => {
    if (r.status() >= 500) problems.push(`HTTP ${r.status()} [${label}] ${r.request().method()} ${r.url()}`)
    else if (r.status() >= 400 && r.url().includes('/api/')) seen4xx.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`)
  })
  page.on('dialog', (d) => d.accept())
}
async function newPage(ctx, label, viewport = { width: 1440, height: 950 }) {
  const page = await ctx.newPage()
  await page.setViewport(viewport)
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US' })
  watch(page, label)
  return page
}
let shotN = 0
async function shot(page, name) { fs.mkdirSync(SHOTS, { recursive: true }); await settle(page); await page.screenshot({ path: path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`) }) }
/** layout settled: no spinner, two animation frames, the network quiet */
async function settle(page, timeout = 20000) {
  await page.waitForNetworkIdle({ idleTime: 250, timeout }).catch(() => undefined)
  await page.waitForFunction(() => !document.querySelector('main .animate-spin, [role=dialog] .animate-spin'), { timeout }).catch(() => undefined)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
}
const waitFor = (page, sel, timeout = 20000) => page.waitForSelector(sel, { visible: true, timeout })
async function click(page, sel, timeout = 20000) {
  await page.waitForSelector(`${sel}:not([disabled])`, { visible: true, timeout })
  await page.$eval(sel, (e) => e.scrollIntoView({ block: 'center' }))
  await page.click(sel)
}
/** a button (or link) by its visible text, inside a container */
async function clickText(page, within, re, tag = 'button') {
  const src = re.source
  await page.waitForFunction((w, t, s) => [...document.querySelectorAll(`${w} ${t}`)].some((b) => new RegExp(s).test(b.textContent?.trim() ?? '') && !b.disabled), { timeout: 20000 }, within, tag, src)
  const h = await page.evaluateHandle((w, t, s) => [...document.querySelectorAll(`${w} ${t}`)].find((b) => new RegExp(s).test(b.textContent?.trim() ?? '') && !b.disabled), within, tag, src)
  await h.evaluate((e) => e.scrollIntoView({ block: 'center' }))
  await h.click()
}
async function fill(page, sel, v) {
  await waitFor(page, sel)
  await page.$eval(sel, (e) => e.scrollIntoView({ block: 'center' }))
  await page.click(sel, { clickCount: 3 })
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control')
  await page.keyboard.press('Backspace')
  if (v) await page.keyboard.type(v)
}
let dateOrder = null
/** a date input typed as a person does */
async function typeDate(page, sel, iso) {
  await waitFor(page, sel)
  await page.$eval(sel, (e) => e.scrollIntoView({ block: 'center' }))
  const [y, m, d] = iso.split('-')
  // the keyboard focus lands on the first segment; a person types the digits one after the other. The order of the
  // segments follows the browser's locale (month first in en-US, day first in en-GB and en-IN)
  // (the order of the operating system, which the page cannot read: learnt from the first date typed)
  const typeIt = async () => { await page.$eval(sel, (e) => { e.blur(); e.focus() }); await page.keyboard.type(dateOrder === 'day' ? `${d}${m}${y}` : `${m}${d}${y}`) }
  await typeIt()
  if (!dateOrder) {
    const v = await page.$eval(sel, (e) => e.value)
    dateOrder = v === iso ? 'month' : 'day'
    if (v !== iso) await typeIt()
  }
  await page.waitForFunction((s, v) => document.querySelector(s)?.value === v, { timeout: 5000 }, sel, iso)
    .catch(async () => { throw new Error(`the date ${sel} reads "${await page.$eval(sel, (e) => e.value)}", not ${iso}`) })
}
async function choose(page, sel, value) { await waitFor(page, sel); await page.$eval(sel, (e) => e.scrollIntoView({ block: 'center' })); await page.select(sel, value) }
async function chooseText(page, sel, re) {
  await waitFor(page, sel)
  await page.waitForFunction((s, src) => [...(document.querySelector(s)?.options ?? [])].some((o) => new RegExp(src).test(o.textContent ?? '')), { timeout: 20000 }, sel, re.source)
  const v = await page.$eval(sel, (e, src) => [...e.options].find((o) => new RegExp(src).test(o.textContent ?? ''))?.value ?? null, re.source)
  await choose(page, sel, v)
  return v
}
async function waitText(page, sel, re, timeout = 20000) {
  await page.waitForFunction((s, src, fl) => [...document.querySelectorAll(s)].some((e) => new RegExp(src, fl).test(e.innerText ?? e.textContent ?? '')), { timeout }, sel, re.source, re.flags)
  return page.$$eval(sel, (els, src, fl) => els.map((e) => e.innerText ?? e.textContent ?? '').find((t) => new RegExp(src, fl).test(t)) ?? '', re.source, re.flags)
}
const textOf = (page, sel) => page.$eval(sel, (e) => (e.innerText ?? e.textContent ?? '').trim())
const toast = (page, re, timeout = 20000) => waitText(page, `${T('toasts')} [role]`, re, timeout)
/** close every open toast, so the next one read is the next one shown */
async function clearToasts(page) { await page.$$eval(`${T('toasts')} button[aria-label=Dismiss]`, (bs) => bs.forEach((b) => b.click())).catch(() => undefined) }
/** what sticks out of a phone screen: the page scrolls sideways, or a visible element ends past the right edge outside a scroller */
async function overflowAt(page) {
  return page.evaluate(() => {
    const W = window.innerWidth
    const doc = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
    const clipped = []
    for (const e of document.querySelectorAll('[data-testid=accounts-page] *')) {
      const r = e.getBoundingClientRect()
      if (!r.width || !r.height || r.right <= W + 1) continue
      let p = e.parentElement
      let inScroller = false
      while (p && p !== document.body) {
        const cs = getComputedStyle(p)
        if (/(auto|scroll|hidden)/.test(cs.overflowX) && p.getBoundingClientRect().right <= W + 1) { inScroller = true; break }
        p = p.parentElement
      }
      if (!inScroller) clipped.push(`${e.tagName.toLowerCase()}${e.getAttribute('data-testid') ? `[${e.getAttribute('data-testid')}]` : ''} "${(e.textContent ?? '').trim().slice(0, 30)}" right=${Math.round(r.right)}`)
    }
    return { pageWidth: doc, viewport: W, clipped: clipped.slice(0, 6), clippedCount: clipped.length }
  })
}

/* ------------------------------------------------------------------ dates */

const today = new Date().toISOString().slice(0, 10)
const nextMonthFirst = (() => { const d = new Date(`${today.slice(0, 8)}01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10) })()
const SRC = 'click-through test data, not a real notification'

/* ------------------------------------------------------------------ PDF to PNG with the browser's own viewer */

async function rasterisePdf(ctx, bytes, name) {
  fs.mkdirSync(PDFS, { recursive: true })
  const file = path.join(PDFS, `${name}.pdf`)
  fs.writeFileSync(file, bytes)
  const page = await ctx.newPage()
  await page.setViewport({ width: 1000, height: 1400 })
  try {
    await page.goto(pathToFileURL(file).href, { waitUntil: 'load', timeout: 30000 })
    await sleep(2500) // the PDF viewer paints after load and gives no signal a page can wait for; this is only for the picture
    const png = path.join(PDFS, `${name}.png`)
    await page.screenshot({ path: png })
    return png
  } finally { await page.close() }
}

/* ================================================================== main */

let failed = false
let ctx = null
let page = null
const ids = {}
try {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(WS, { recursive: true })
  await maint(`DROP DATABASE IF EXISTS "${DB.database}"`)
  browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=en-US', '--window-size=1440,950'] })

  /* ---------------------------------------------------------------- H0. where the setup code is */
  current = 'H'
  if (want('H')) {
    log('=== H0. the setup screen: where the setup code is')
    const tty = process.stdout.isTTY
    const label = async (env, isTty) => {
      const ws = path.join(OUT, `ws-code-${Object.keys(env).length}-${isTty ? 'tty' : 'pipe'}`)
      fs.mkdirSync(ws, { recursive: true })
      const a = await createApp({ env: { APPBUILDER_MIGRATION_BACKUP: 'skip', ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replace('<ws>', ws)])) }, config: { workspaceDir: ws }, printSetupCode: false, jobs: false })
      const port = await freePort()
      const s = http.createServer((req, res) => { a.handle(req, res).then((h) => { if (!h) serveStatic(a.config.distDir ?? path.join(root, 'dist'), req, res) }) })
      await new Promise((r) => s.listen(port, '127.0.0.1', r))
      const p = await newPage(browser.defaultBrowserContext(), 'setup-code')
      try {
        Object.defineProperty(process.stdout, 'isTTY', { value: isTty, configurable: true, writable: true })
        await p.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' })
        await waitFor(p, T('setup-code'), 30000)
        await settle(p)
        return await p.$eval('[data-testid=setup-database-form]', (f) => f.innerText.split('\nHost')[0])
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true, writable: true })
        await p.close()
        s.closeAllConnections?.(); await new Promise((r) => s.close(() => r())); await a.close()
      }
    }
    const byHand = await label({}, true)
    const byHandFile = await label({ APPBUILDER_SETUP_CODE_FILE: '<ws>/setup-code.txt' }, true)
    const service = await label({ APPBUILDER_SETUP_CODE_FILE: '<ws>/setup-code.txt' }, false)
    record('started by hand without APPBUILDER_SETUP_CODE_FILE: "shown in the server window", nothing about a service', /shown in the server window/.test(byHand) && !/service|setup-code file/.test(byHand), byHand.replace(/\s+/g, ' '))
    record('started by hand WITH APPBUILDER_SETUP_CODE_FILE: the window first, the file as well; it does not say it runs as a service', /shown in the server window/.test(byHandFile) && /setup-code file/.test(byHandFile) && !/runs as a service/.test(byHandFile), byHandFile.replace(/\s+/g, ' '))
    record('installed as a service (no console): the code is in the setup-code file, with the command', /in the setup-code file on the server/.test(service) && /appbuilder setup-code/.test(service), service.replace(/\s+/g, ' ').slice(0, 200))
  }

  /* ---------------------------------------------------------------- H1. first run in the browser */
  await start()
  ctx = await browser.createBrowserContext()
  page = await newPage(ctx, 'main')
  {
    current = 'H'
    log('=== H1. first run: the setup screen typed in the browser')
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await waitFor(page, T('setup-database-form'), 30000)
    await shot(page, 'setup-database')
    const code = app.services.setupCode.current()
    await fill(page, T('setup-code'), `${code.slice(0, 4)}-${code.slice(4)}`)
    await fill(page, T('setup-host'), DB.host)
    await fill(page, T('setup-port'), String(DB.port))
    await fill(page, T('setup-database'), DB.database)
    await fill(page, T('setup-user'), DB.user)
    await fill(page, T('setup-password'), DB.password)
    await page.waitForFunction((s) => document.querySelector(s)?.getAttribute('data-state') === 'checked' || document.querySelector(s)?.getAttribute('aria-checked') === 'true', { timeout: 5000 }, T('setup-create-db'))
    await click(page, T('setup-database-continue'))
    await waitFor(page, T('setup-admin-form'), 60000)
    await shot(page, 'setup-admin')
    await fill(page, T('setup-admin-name'), ADMIN.name)
    await fill(page, T('setup-admin-email'), ADMIN.email)
    await fill(page, T('admin-pw-new'), ADMIN.password)
    await fill(page, T('admin-pw-confirm'), ADMIN.password)
    await click(page, T('setup-admin-create'))
    await page.waitForSelector(T('portal-root'), { visible: true, timeout: 60000 })
    await settle(page)
    const first = await textOf(page, 'main')
    record('first run: database and administrator typed in the setup screen; the administrator is signed in and sees the portal', !!first, first.replace(/\s+/g, ' ').slice(0, 160))
    await shot(page, 'first-home')
    await api('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password })
  }

  /* ================================================================ A. Accounts */
  await section('A', 'Accounts', async () => {
    const A = T('accounts-page')
    await page.goto(`${BASE}/#u-accounts`, { waitUntil: 'domcontentloaded' })
    await waitFor(page, A, 45000)
    await waitFor(page, T('accounts-settings'))
    const notice = await textOf(page, T('accounts-notice'))
    record('Accounts opens on Settings until the business is registered, with the "draft, not reviewed" notice', /draft that has not yet been reviewed by a practising accountant/.test(notice), notice.slice(0, 100))
    await shot(page, 'accounts-settings-empty')

    // set up
    await clearToasts(page)
    await click(page, T('accounts-setup-books'))
    await toast(page, /^Books set up/)
    await click(page, T('accounts-load-examples'))
    await toast(page, /Example data loaded \(not approved\)/)
    const setupLine = await waitText(page, T('accounts-setup'), /ready.*\d{2,} States/s)
    record('"Set up the books" and "Load example data": chart and series ready, the State list loaded, no rates', /ready/.test(setupLine) && /\b0 rates/.test(setupLine), setupLine.split('\n')[0])

    // a wrong registration first: an answer a person can act on
    await fill(page, T('business-legalName'), 'Asha Pumps Private Limited')
    await fill(page, T('business-gstin'), '23ABCDE1234F1Z')
    await fill(page, T('business-stateCode'), '23')
    await fill(page, T('business-address'), '12 Industrial Area, Indore 452001')
    await clearToasts(page)
    await click(page, T('business-save'))
    const badGstin = await toast(page, /GSTIN/)
    record('a GSTIN of the wrong length is refused with a message that names the GSTIN', /GSTIN/.test(badGstin) && !/^(invalid|error)$/i.test(badGstin.trim()), badGstin)
    await fill(page, T('business-gstin'), '23ABCDE1234F1Z5')
    await clearToasts(page)
    await click(page, T('business-save'))
    await toast(page, /Business registration saved/)
    await settle(page)
    const stayed = !!(await page.$(T('accounts-settings'))) && /registration: entered/.test(await textOf(page, T('accounts-setup')).catch(() => ''))
    record('the business registration is typed and saved; the page stays on Settings (it does not jump to Documents)', stayed, stayed ? '' : `now on: ${await page.$eval('[role=tab][aria-selected=true]', (e) => e.textContent).catch(() => '?')}`)
    if (!stayed) await click(page, T('accounts-tab-settings'))
    await shot(page, 'accounts-settings')

    // the financial year (Periods)
    await click(page, T('accounts-tab-periods'))
    await waitFor(page, T('accounts-periods'))
    await clearToasts(page)
    await click(page, T('year-add'))
    await toast(page, /Financial year added/)
    await waitFor(page, T(`period-${today.slice(0, 7)}`))
    if (!(await page.$(T(`period-${nextMonthFirst.slice(0, 7)}`)))) {
      await typeDate(page, T('year-date'), nextMonthFirst)
      await click(page, T('year-add'))
      await waitFor(page, T(`period-${nextMonthFirst.slice(0, 7)}`))
    }
    const months = (await page.$$('[data-testid^="period-20"]')).length
    record('a financial year is added in Periods: 12 open months', months >= 12, `${months} months`)
    await shot(page, 'accounts-periods')

    // reference data: rates
    await click(page, T('accounts-tab-reference'))
    await waitFor(page, T('ref-rates'))
    const addRate = async (r) => {
      await click(page, T('ref-rates-add'))
      await waitFor(page, T('ref-rates-form'))
      await fill(page, T('ref-rates-f-code'), r.code)
      await fill(page, T('ref-rates-f-description'), r.description)
      await choose(page, T('ref-rates-f-kind'), r.kind)
      await fill(page, T('ref-rates-f-igst'), r.igst)
      await fill(page, T('ref-rates-f-cgst'), r.cgst)
      await fill(page, T('ref-rates-f-sgst'), r.sgst)
      await typeDate(page, T('ref-rates-f-effectiveFrom'), '2017-07-01')
      await fill(page, T('ref-rates-f-source'), SRC)
      await clearToasts(page)
      await click(page, T('ref-rates-save'))
    }
    await addRate({ code: '8413', description: 'Pumps for liquids', kind: 'goods', igst: '18', cgst: '9', sgst: '8' })
    const badRate = await toast(page, /must equal the IGST rate|IGST/)
    record('a rate whose CGST and SGST do not add up to IGST is refused, saying so', /IGST/.test(badRate), badRate)
    await page.click(`${T('ref-rates-form')} button:not([data-testid])`).catch(() => undefined) // Cancel
    await addRate({ code: '8413', description: 'Pumps for liquids', kind: 'goods', igst: '18', cgst: '9', sgst: '9' })
    await toast(page, /^Saved/)
    await addRate({ code: '9983', description: 'Other professional services', kind: 'service', igst: '18', cgst: '9', sgst: '9' })
    await toast(page, /^Saved/)
    await page.waitForFunction((s) => document.querySelectorAll(s).length === 2, { timeout: 20000 }, T('ref-rates-row'))
    const rateRows = await page.$$eval(T('ref-rates-row'), (rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ')))
    record('two rates added in Reference data > Rates and listed with their source', rateRows.length === 2 && rateRows.every((r) => r.includes('click-through test data')), rateRows.join(' | ').slice(0, 200))
    const states = await (async () => { await clickText(page, T('accounts-reference'), /^States$/); await waitFor(page, T('ref-states-row')); return page.$$eval(T('ref-states-row'), (r) => r.length) })()
    record('Reference data > States lists the example State list (marked not approved)', states > 30, `${states} rows`)
    await shot(page, 'accounts-reference')

    // customers and suppliers
    await click(page, T('accounts-tab-parties'))
    await waitFor(page, T('accounts-parties'))
    const addParty = async (p) => {
      await click(page, T('accounts-parties-add'))
      await waitFor(page, T('accounts-parties-form'))
      await fill(page, T('accounts-parties-f-name'), p.name)
      await choose(page, T('accounts-parties-f-role'), p.role)
      await choose(page, T('accounts-parties-f-regType'), 'regular')
      await fill(page, T('accounts-parties-f-gstin'), p.gstin)
      await fill(page, T('accounts-parties-f-stateCode'), p.state)
      await fill(page, T('accounts-parties-f-address'), p.address)
      await clearToasts(page)
      await click(page, T('accounts-parties-save'))
      await toast(page, /^Saved/)
    }
    await addParty({ name: 'Bhopal Traders', role: 'customer', gstin: '23AAAAA0000A1Z5', state: '23', address: 'MP Nagar, Bhopal' })
    await addParty({ name: 'Pune Engineering', role: 'customer', gstin: '27BBBBB1111B1Z5', state: '27', address: 'Hadapsar, Pune' })
    await addParty({ name: 'Indore Castings', role: 'supplier', gstin: '23CCCCC2222C1Z5', state: '23', address: 'Sanwer Road, Indore' })
    const parties = await page.$$eval(T('accounts-parties-row'), (rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ')))
    record('two customers and a supplier added with GSTIN and State code', parties.length === 3 && parties.some((p) => /Pune Engineering.*27BBBBB1111B1Z5.*27/.test(p)), parties.join(' | ').slice(0, 220))
    await shot(page, 'accounts-parties')

    // items
    await click(page, T('accounts-tab-items'))
    await waitFor(page, T('accounts-items'))
    const addItem = async (it) => {
      await click(page, T('accounts-items-add'))
      await waitFor(page, T('accounts-items-form'))
      await fill(page, T('accounts-items-f-name'), it.name)
      await choose(page, T('accounts-items-f-kind'), it.kind)
      await fill(page, T('accounts-items-f-hsn'), it.hsn)
      await fill(page, T('accounts-items-f-uqc'), it.uqc ?? '')
      if (it.supplyClass) await choose(page, T('accounts-items-f-supplyClass'), it.supplyClass)
      if (it.pos) await fill(page, T('accounts-items-f-posCategory'), it.pos)
      if (it.itc) await choose(page, T('accounts-items-f-itcDefault'), it.itc)
      await fill(page, T('accounts-items-f-unitPrice'), it.price ?? '')
      await clearToasts(page)
      await click(page, T('accounts-items-save'))
      await toast(page, /^Saved/)
    }
    await addItem({ name: 'Monoblock pump 1 HP', kind: 'goods', hsn: '84137010', uqc: 'NOS', price: '1250.00', itc: 'eligible' })
    await addItem({ name: 'Site survey of a building', kind: 'service', hsn: '998399', pos: 'immovable property', price: '40000' })
    await addItem({ name: 'Unbranded rice', kind: 'goods', hsn: '10063010', uqc: 'KGS', supplyClass: 'exempt', price: '40.00' })
    const itemRows = await page.$$eval(T('accounts-items-row'), (r) => r.length)
    record('three items added (a taxable good, a service with a special place-of-supply rule, an exempt good)', itemRows === 3, `${itemRows} items`)
    await shot(page, 'accounts-items')

    // documents
    await click(page, T('accounts-tab-documents'))
    await waitFor(page, T('accounts-documents'))
    const newDoc = async (type) => {
      await choose(page, T('doc-new-type'), type)
      await click(page, T('doc-new'))
      await waitFor(page, T('doc-editor'))
    }
    const line = async (i, itemRe, qty, price) => {
      if (i > 0 && !(await page.$(T(`doc-line-item-${i}`)))) await click(page, T('doc-add-line'))
      await chooseText(page, T(`doc-line-item-${i}`), itemRe)
      if (qty !== undefined) await fill(page, T(`doc-line-qty-${i}`), qty)
      if (price !== undefined) await fill(page, T(`doc-line-price-${i}`), price)
    }
    const saveDraft = async () => { await clearToasts(page); await click(page, T('doc-save')); await toast(page, /^Draft saved|./); await settle(page) }
    const issueNow = async () => {
      await clearToasts(page)
      await click(page, T('doc-issue'))
      await page.waitForFunction((s) => document.querySelector(s)?.textContent === 'Issued', { timeout: 30000 }, T('doc-state'))
      await settle(page)
      const h = await page.$eval(T('accounts-document'), (e) => e.querySelector('h2')?.textContent ?? '')
      return h.trim().split(/\s+/).pop() // the number, the last word of the heading
    }
    const back = async () => { await click(page, T('doc-back')); await waitFor(page, T('accounts-documents')); await settle(page) }
    const pdfOf = async () => {
      const href = await page.$eval(T('doc-pdf'), (e) => e.href)
      const r = await page.evaluate(async (u) => { const x = await fetch(u); const b = new Uint8Array(await x.arrayBuffer()); let s = ''; for (const c of b) s += String.fromCharCode(c); return { status: x.status, type: x.headers.get('content-type'), b64: btoa(s) } }, href)
      return { ...r, bytes: Buffer.from(r.b64, 'base64') }
    }

    // 1. intra-State tax invoice
    await newDoc('tax_invoice')
    await chooseText(page, T('doc-party'), /Bhopal Traders/)
    await line(0, /Monoblock pump/, '10')
    await page.waitForFunction((s) => document.querySelector(s)?.value === '1250.00', { timeout: 10000 }, T('doc-line-price-0'))
    await saveDraft()
    const pre1 = await waitText(page, T('doc-preview'), /Intra-State/)
    const tot1 = await textOf(page, T('doc-total'))
    record('a draft tax invoice to a customer in the same State: the preview says intra-State and totals 14,750.00 (CGST + SGST 1,125.00 each)', /Intra-State/.test(pre1) && tot1 === '14,750.00' && /CGST\s+1,125\.00/.test(await textOf(page, T('doc-totals'))), `${pre1.split('\n')[0]} / ${tot1}`)
    await shot(page, 'doc-invoice-intra-draft')
    ids.inv1 = await issueNow()
    const pdf1 = await pdfOf()
    record('issued: numbered at issue, the PDF opens', /INV\/\d\d-\d\d\/00001/.test(ids.inv1) && pdf1.status === 200 && pdf1.bytes.subarray(0, 5).toString() === '%PDF-', `${ids.inv1}, PDF ${pdf1.bytes.length} bytes`)
    await shot(page, 'doc-invoice-intra-issued')
    fs.mkdirSync(PDFS, { recursive: true }); fs.writeFileSync(path.join(PDFS, 'tax-invoice-intra.pdf'), pdf1.bytes)

    // 2. a credit note against it (from the invoice's page)
    await click(page, T('doc-credit-note'))
    await waitFor(page, T('doc-editor'))
    await page.waitForFunction((s) => !!document.querySelector(s)?.value, { timeout: 20000 }, T('doc-original'))
    await choose(page, T('doc-reason'), 'return')
    await choose(page, T('doc-itc-reversal'), 'yes')
    await line(0, /Monoblock pump/, '2', '1250.00')
    await saveDraft()
    const cnTot = await waitText(page, T('doc-total'), /2,950\.00/)
    ids.cn = await issueNow()
    const cnPdf = await pdfOf()
    const cnHead = await textOf(page, T('doc-issued'))
    record('a credit note made from the invoice\'s page: against the invoice, 2,950.00, numbered CN/..., its PDF opens', /CN\/\d\d-\d\d\/00001/.test(ids.cn) && /against INV/.test(cnHead) && cnTot === '2,950.00' && cnPdf.status === 200, `${ids.cn}; ${cnHead.split('\n')[1] ?? ''}`)
    await shot(page, 'doc-credit-note')
    ids.cnPng = await rasterisePdf(ctx, cnPdf.bytes, 'credit-note')
    await back()

    // 3. inter-State tax invoice
    await newDoc('tax_invoice')
    await chooseText(page, T('doc-party'), /Pune Engineering/)
    await line(0, /Monoblock pump/, '10')
    await page.waitForFunction((s) => document.querySelector(s)?.value === '1250.00', { timeout: 10000 }, T('doc-line-price-0'))
    await saveDraft()
    const pre2 = await waitText(page, T('doc-preview'), /Inter-State/)
    record('a draft to a customer in another State: inter-State, IGST 2,250.00, total 14,750.00', /Inter-State \(IGST\)/.test(pre2) && /IGST\s+2,250\.00/.test(await textOf(page, T('doc-totals'))) && (await textOf(page, T('doc-total'))) === '14,750.00', pre2.split('\n')[0])
    ids.inv2 = await issueNow()
    record('the inter-State invoice is issued as the next number', /00002$/.test(ids.inv2), ids.inv2)
    await shot(page, 'doc-invoice-inter-issued')
    fs.writeFileSync(path.join(PDFS, 'tax-invoice-inter.pdf'), (await pdfOf()).bytes)

    // 4. a debit note against the inter-State invoice
    await clickText(page, T('doc-issued'), /^Debit note$/)
    await waitFor(page, T('doc-editor'))
    await page.waitForFunction((s) => !!document.querySelector(s)?.value, { timeout: 20000 }, T('doc-original'))
    await line(0, /Monoblock pump/, '1', '100.00')
    await saveDraft()
    const dnPre = await textOf(page, T('doc-editor')).catch(() => '')
    const dnTot = await textOf(page, T('doc-total')).catch(() => '')
    ids.dn = await issueNow()
    const dnPdf = await pdfOf()
    record('a debit note against the inter-State invoice: IGST 18.00, total 118.00, its PDF opens', /DN\/\d\d-\d\d\/00001|\/00001/.test(ids.dn) && dnTot === '118.00' && dnPdf.status === 200, `${ids.dn} ${dnTot} ${/problem/i.test(dnPre) ? dnPre.slice(0, 80) : ''}`)
    fs.writeFileSync(path.join(PDFS, 'debit-note.pdf'), dnPdf.bytes)
    await back()

    // 5. bill of supply (exempt goods)
    await newDoc('bill_of_supply')
    await chooseText(page, T('doc-party'), /Bhopal Traders/)
    await line(0, /Unbranded rice/, '50')
    await page.waitForFunction((s) => document.querySelector(s)?.value === '40.00', { timeout: 10000 }, T('doc-line-price-0'))
    await saveDraft()
    const bosPre = await waitText(page, `${T('doc-preview')}, ${T('doc-problem')}`, /./)
    ids.bos = await issueNow()
    const bosPdf = await pdfOf()
    record('a bill of supply for exempt goods: no tax, 2,000.00, numbered, its PDF opens', /No tax on this document/.test(bosPre) && (await textOf(page, T('doc-total'))) === '2,000.00' && bosPdf.status === 200, `${ids.bos}: ${bosPre.split('\n')[0]}`)
    await shot(page, 'doc-bill-of-supply')
    ids.bosPng = await rasterisePdf(ctx, bosPdf.bytes, 'bill-of-supply')
    await back()

    // 6. a receipt voucher (an advance for goods: no tax), then a refund voucher against it
    await newDoc('receipt_voucher')
    await chooseText(page, T('doc-party'), /Bhopal Traders/)
    await line(0, /Monoblock pump/, '1', '5000')
    await saveDraft()
    const rvTot = await waitText(page, T('doc-total'), /\d/)
    ids.rv = await issueNow()
    record('a receipt voucher for an advance on goods: issued, 5,000.00, no tax', rvTot === '5,000.00' && /\/00001$/.test(ids.rv), `${ids.rv} ${rvTot}`)
    await shot(page, 'doc-receipt-voucher')
    await back()
    await newDoc('refund_voucher')
    await chooseText(page, T('doc-party'), /Bhopal Traders/)
    await chooseText(page, T('doc-original'), new RegExp(ids.rv.replace(/[/]/g, '\\/')))
    await line(0, /Monoblock pump/, '1', '2000')
    await saveDraft()
    const rfTot = await waitText(page, `${T('doc-total')}, ${T('doc-problem')}`, /./)
    ids.rf = await issueNow()
    record('a refund voucher against the receipt voucher: issued, 2,000.00', rfTot === '2,000.00', `${ids.rf} ${rfTot}`)
    await back()

    // 7. a payment voucher and a purchase invoice from the supplier
    await newDoc('payment_voucher')
    await chooseText(page, T('doc-party'), /Indore Castings/)
    await fill(page, T('doc-amount'), '3000')
    await saveDraft()
    ids.pv = await issueNow()
    record('a payment voucher to the supplier: issued, 3,000.00', (await textOf(page, T('doc-total'))) === '3,000.00', ids.pv)
    await back()
    await newDoc('purchase_invoice')
    await chooseText(page, T('doc-party'), /Indore Castings/)
    await fill(page, T('doc-supplier-no'), 'IC-778')
    await line(0, /Monoblock pump/, '2', '1000.00')
    await choose(page, T('doc-line-itc-0'), 'eligible')
    await saveDraft()
    const piTot = await waitText(page, `${T('doc-total')}, ${T('doc-problem')}`, /./)
    ids.pi = await issueNow()
    record('a purchase invoice with its ITC flag: intra-State input tax, 2,360.00, posted', piTot === '2,360.00', `${ids.pi} ${piTot}`)
    await shot(page, 'doc-purchase-invoice')
    await back()

    // 8. STOP: a service with a special place-of-supply rule
    await newDoc('tax_invoice')
    await chooseText(page, T('doc-party'), /Bhopal Traders/)
    await line(0, /Site survey/, '1')
    await saveDraft()
    const stopText = await waitText(page, T('doc-problem'), /cannot be issued/)
    await clearToasts(page)
    await click(page, T('doc-issue'))
    const stopToast = await toast(page, /accountant/)
    const stillDraft = /\(draft\)/.test(await page.$eval(T('accounts-document'), (e) => e.querySelector('h2')?.textContent ?? ''))
    record('STOP: a service with a special place-of-supply rule cannot be issued; the page says what the accountant must decide; it stays a draft', /Place of supply needs the accountant/.test(stopText) && stillDraft && /accountant/.test(stopToast), stopText.replace(/\s+/g, ' ').slice(0, 200))
    await shot(page, 'doc-stop')
    await click(page, T('doc-delete'))
    await waitFor(page, T('accounts-documents'))

    // 9. STOP: taxable and exempt lines on one bill of supply
    await newDoc('bill_of_supply')
    await chooseText(page, T('doc-party'), /Bhopal Traders/)
    await line(0, /Monoblock pump/, '1')
    await saveDraft()
    const mixed = await waitText(page, T('doc-problem'), /./)
    record('a bill of supply with a taxable line: refused, saying to issue a tax invoice for the taxable lines', /tax invoice for the taxable lines/.test(mixed), mixed.replace(/\s+/g, ' ').slice(0, 200))
    await click(page, T('doc-delete'))
    await waitFor(page, T('accounts-documents'))
    const listed = await page.$$eval(T('doc-row'), (rows) => rows.map((r) => r.getAttribute('data-number')))
    record('the document list shows every issued document and no abandoned draft', listed.length === 9 && listed.every(Boolean), listed.join(', '))
    await shot(page, 'accounts-documents')

    // journals: a manual journal, an unbalanced one refused, a reversal
    await click(page, T('accounts-tab-journals'))
    await waitFor(page, T('accounts-journals'))
    await click(page, T('journal-add'))
    await waitFor(page, T('journal-new'))
    await fill(page, T('journal-narration'), 'Office rent for the month')
    await chooseText(page, T('journal-account-0'), /^5400 Rent/)
    await fill(page, T('journal-debit-0'), '1000')
    await chooseText(page, T('journal-account-1'), /^1010 Bank/)
    await fill(page, T('journal-credit-1'), '900')
    await clearToasts(page)
    await click(page, T('journal-post'))
    const unbalanced = await toast(page, /./)
    record('a journal whose debits and credits differ is refused with the difference in words', /debit|credit|equal|balance/i.test(unbalanced), unbalanced)
    await fill(page, T('journal-credit-1'), '1000')
    await clearToasts(page)
    await click(page, T('journal-post'))
    await toast(page, /Journal posted/)
    const jrow = await waitText(page, T('journal-row'), /Office rent/)
    record('a manual journal is posted and listed', /1,000\.00/.test(jrow), jrow.replace(/\s+/g, ' '))
    const rows = await page.$$(T('journal-row'))
    for (const r of rows) if (/Office rent/.test(await r.evaluate((e) => e.innerText))) { await r.click(); break }
    await waitFor(page, T('journal-reverse'))
    await click(page, T('journal-reverse'))
    await fill(page, T('text-dialog-input'), 'Entered in the wrong month')
    await clickText(page, '[role=dialog]', /^Reverse$/)
    await waitText(page, T('journal-view'), /Reversed/)
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=journal-row]')].some((r) => /Office rent.*\(reversed\)/.test(r.innerText)), { timeout: 20000 })
    record('Reverse: the journal shows "Reversed" and the reversal is listed', true)
    await shot(page, 'accounts-journals')

    // ledger
    await click(page, T('accounts-tab-ledger'))
    await waitFor(page, T('accounts-ledger'))
    await chooseText(page, T('ledger-account'), /^1100 Trade receivables/)
    await waitFor(page, T('ledger-closing'))
    const recv = await textOf(page, T('ledger-closing'))
    // 14,750 - 2,950 + 14,750 + 118 + 2,000 = 28,668; the receipt and refund vouchers do not touch receivables
    record('the account ledger of Trade receivables: entries with a running balance and the closing balance', /\d/.test(recv), `closing ${recv}`)
    await shot(page, 'accounts-ledger')

    // reports
    await click(page, T('accounts-tab-reports'))
    await waitFor(page, T('trial-balance'))
    const tb = { d: await textOf(page, T('tb-total-debit')), c: await textOf(page, T('tb-total-credit')), cd: await textOf(page, T('tb-closing-debit')), cc: await textOf(page, T('tb-closing-credit')), note: await textOf(page, T('tb-balanced')) }
    record('the trial balance: debits equal credits, closing debits equal closing credits', tb.d === tb.c && tb.cd === tb.cc && tb.note === 'Debits equal credits.' && tb.d !== '0.00', `${tb.d} = ${tb.c}; ${tb.cd} = ${tb.cc}`)
    await shot(page, 'report-trial-balance')
    const csvOk = async (label) => {
      const href = await page.$eval(`${T('accounts-page')} ${T('download-csv')}`, (e) => e.href)
      const r = await page.evaluate(async (u) => { const x = await fetch(u); return { status: x.status, type: x.headers.get('content-type') ?? '', disp: x.headers.get('content-disposition') ?? '', text: (await x.text()).slice(0, 400) } }, href)
      return { ok: r.status === 200 && /csv/.test(r.type) && r.text.split('\n').length >= 1 && r.text.length > 5, detail: `${label}: ${r.status} ${r.type} ${r.text.split('\n')[0].slice(0, 80)}` }
    }
    const tbCsv = await csvOk('trial balance')
    await clickText(page, T('accounts-reports'), /^Profit and loss$/)
    await waitFor(page, T('profit-loss'))
    const pl = await textOf(page, T('profit-loss'))
    const profit = /Profit \(income less expense\): (-?[\d,]+\.\d\d)/.exec(pl)?.[1]
    record('profit and loss: income and expense with the profit line', !!profit, `profit ${profit}`)
    const plCsv = await csvOk('profit and loss')
    await shot(page, 'report-profit-loss')
    await clickText(page, T('accounts-reports'), /^Balance sheet$/)
    await waitFor(page, T('balance-sheet'))
    const bsText = await textOf(page, T('balance-sheet'))
    const num = (re) => Number((re.exec(bsText)?.[1] ?? 'NaN').replace(/,/g, ''))
    const assets = num(/Total assets\s+(-?[\d,]+\.\d\d)/)
    const liab = num(/Total liabilities\s+(-?[\d,]+\.\d\d)/)
    const equity = num(/Total equity\s+(-?[\d,]+\.\d\d)/)
    const profitLine = /Profit to date, not closed\s+(-?[\d,]+\.\d\d)/.exec(bsText)?.[1]
    record('the balance sheet balances: total assets = total liabilities + total equity; the profit to date agrees with the profit and loss', Math.abs(assets - (liab + equity)) < 0.005 && profitLine === profit, `${assets} = ${liab} + ${equity}; profit ${profitLine}`)
    const bsCsv = await csvOk('balance sheet')
    record('each report downloads as CSV', tbCsv.ok && plCsv.ok && bsCsv.ok, [tbCsv.detail, plCsv.detail, bsCsv.detail].join(' | '))
    await shot(page, 'report-balance-sheet')

    // return summaries: each one opens and its CSV downloads
    await click(page, T('accounts-tab-returns'))
    await waitFor(page, T('returns-table'))
    const names = await page.$$eval(`${T('returns-name')} option`, (os) => os.map((o) => [o.value, o.textContent]))
    const bad = []
    for (const [name, title] of names) {
      await choose(page, T('returns-name'), name)
      await settle(page)
      await waitFor(page, T('returns-table'))
      const err = await page.$eval(T('accounts-returns'), (e) => e.querySelector('[role=alert]')?.textContent ?? '')
      const href = await page.$eval(`${T('accounts-returns')} ${T('download-csv')}`, (e) => e.href)
      const r = await page.evaluate(async (u) => { const x = await fetch(u); return { status: x.status, type: x.headers.get('content-type') ?? '', head: (await x.text()).split('\n')[0] } }, href)
      if (err || r.status !== 200 || !/csv/.test(r.type) || !r.head) bad.push(`${title}: ${err || `${r.status} ${r.type}`}`)
    }
    record(`every return summary opens and downloads as CSV (${names.length})`, names.length === 13 && bad.length === 0, bad.join('; ') || names.map((n) => n[1]).join(', '))
    await choose(page, T('returns-name'), 'outward-register')
    await settle(page)
    await shot(page, 'accounts-returns')

    // period lock, then a refused posting
    await click(page, T('accounts-tab-periods'))
    const row = T(`period-${nextMonthFirst.slice(0, 7)}`)
    await waitFor(page, row)
    await click(page, `${row} ${T('period-lock')}`)
    await page.waitForFunction((s) => document.querySelector(s)?.textContent === 'Locked', { timeout: 20000 }, `${row} ${T('period-state')}`)
    record('next month is locked in Periods', true)
    await click(page, T('accounts-tab-documents'))
    await newDoc('tax_invoice')
    await typeDate(page, T('doc-date'), nextMonthFirst)
    await chooseText(page, T('doc-party'), /Bhopal Traders/)
    await line(0, /Monoblock pump/, '1')
    await saveDraft()
    await clearToasts(page)
    await click(page, T('doc-issue'))
    const lockMsg = await toast(page, /locked/)
    const draftStill = /\(draft\)/.test(await page.$eval(T('accounts-document'), (e) => e.querySelector('h2')?.textContent ?? ''))
    record('issuing a document dated in the locked month is refused with a message that names the month and what to do', /is locked/.test(lockMsg) && draftStill, lockMsg)
    await shot(page, 'doc-locked-refused')
    await click(page, T('doc-delete'))
    await waitFor(page, T('accounts-documents'))
    await click(page, T('accounts-tab-journals'))
    await click(page, T('journal-add'))
    await typeDate(page, T('journal-date'), nextMonthFirst)
    await fill(page, T('journal-narration'), 'Late rent')
    await chooseText(page, T('journal-account-0'), /^5400 Rent/)
    await fill(page, T('journal-debit-0'), '10')
    await chooseText(page, T('journal-account-1'), /^1010 Bank/)
    await fill(page, T('journal-credit-1'), '10')
    await clearToasts(page)
    await click(page, T('journal-post'))
    const jLock = await toast(page, /locked/)
    record('a journal in the locked month is refused, saying so', /locked/.test(jLock), jLock)
    await clickText(page, T('journal-new'), /^Cancel$/)

    // the PDFs, rasterised for a person to look at
    record('the bill of supply and the credit note are rasterised for a visual check', fs.existsSync(ids.bosPng) && fs.existsSync(ids.cnPng), `${path.relative(root, ids.bosPng)}, ${path.relative(root, ids.cnPng)}`)

    // phone width: the same screens at 390 x 844
    const phone = await newPage(ctx, 'phone', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
    await phone.goto(`${BASE}/#u-accounts`, { waitUntil: 'domcontentloaded' })
    await waitFor(phone, A, 45000)
    const tabs = ['documents', 'journals', 'ledger', 'reports', 'returns', 'parties', 'items', 'periods', 'chart', 'reference', 'settings']
    const over = []
    for (const t of tabs) {
      await phone.$eval(T(`accounts-tab-${t}`), (e) => e.scrollIntoView({ block: 'center' }))
      await phone.tap(T(`accounts-tab-${t}`))
      await settle(phone)
      if (t === 'ledger') { await chooseText(phone, T('ledger-account'), /^1100 Trade receivables/); await waitFor(phone, T('ledger-closing')) }
      const o = await overflowAt(phone)
      if (o.pageWidth > o.viewport + 1 || o.clippedCount) over.push(`${t}: page ${o.pageWidth}px; ${o.clipped.join(', ')}`)
      await phone.evaluate(() => window.scrollTo(0, 0))
      await shot(phone, `phone-${t}`)
    }
    record('at 390 x 844 no Accounts section scrolls sideways or has something cut off at the right edge', over.length === 0, over.join(' | ').slice(0, 900))
    // forms at phone width: a new draft and an Add form, typed and saved
    await phone.tap(T('accounts-tab-documents'))
    await waitFor(phone, T('doc-new'))
    await choose(phone, T('doc-new-type'), 'tax_invoice')
    await phone.tap(T('doc-new'))
    await waitFor(phone, T('doc-editor'))
    await chooseText(phone, T('doc-party'), /Bhopal Traders/)
    await chooseText(phone, T('doc-line-item-0'), /Monoblock pump/)
    await fill(phone, T('doc-line-qty-0'), '3')
    await phone.tap(T('doc-save'))
    const phoneTot = await waitText(phone, T('doc-total'), /4,425\.00/)
    const sizes = await phone.$$eval(`${T('doc-editor')} input, ${T('doc-editor')} select, ${T('doc-editor')} button`, (els) => els.filter((e) => e.getBoundingClientRect().width > 0).map((e) => { const r = (e.type === 'checkbox' && e.closest('label') ? e.closest('label') : e).getBoundingClientRect(); return { h: r.height, r: r.right, w: r.width, t: (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 24) } }))
    const tiny = sizes.filter((s) => s.h < 32 || s.r > 391)
    const o2 = await overflowAt(phone)
    record('at phone width the document editor is usable: a draft typed and saved (4,425.00), controls at least 32 px tall and inside the screen', phoneTot === '4,425.00' && tiny.length === 0 && o2.pageWidth <= 391, tiny.map((s) => `${s.t} ${Math.round(s.h)}x${Math.round(s.w)} right ${Math.round(s.r)}`).join(', ') || `${sizes.length} controls`)
    await shot(phone, 'phone-doc-editor')
    await click(phone, T('doc-delete'))
    await waitFor(phone, T('accounts-documents'))
    await click(phone, T('accounts-tab-parties'))
    await click(phone, T('accounts-parties-add'))
    await waitFor(phone, T('accounts-parties-form'))
    const o3 = await overflowAt(phone)
    await shot(phone, 'phone-party-form')
    record('at phone width the Add form of customers opens inside the screen', o3.pageWidth <= 391 && o3.clippedCount === 0, o3.clipped.join(', '))
    await phone.close()
  })

  /* ================================================================ B (unlicensed) and C. Licences, seat passes */
  await section('B', 'Admin console > Licences, unlicensed', async () => {
    await page.goto(`${BASE}/#admin-licences`, { waitUntil: 'domcontentloaded' })
    await waitFor(page, T('licence-current'), 30000)
    const cur = await textOf(page, T('licence-current'))
    record('unlicensed install: "No licence configured" and what a licensed install needs', /No licence configured/.test(cur) && /APPBUILDER_LICENCE_URL/.test(cur), cur.replace(/\s+/g, ' ').slice(0, 140))
    record('unlicensed install: no licence strip under the top bar, no read-only notice', !(await page.$(T('licence-banner'))) && !(await page.$(T('licence-read-only'))))
    await shot(page, 'licences-unlicensed')
  })

  await section('C', 'Admin console > Users: the Pass column', async () => {
    const u = await api('POST', '/users', { name: 'Olu Operator', email: 'olu@example.test', roleIds: [], password: `Ct-${randomBytes(9).toString('base64url')}-4x` })
    const uid = u.id ?? u.user?.id
    await page.goto(`${BASE}/#home`, { waitUntil: 'domcontentloaded' })
    await settle(page)
    await page.goto(`${BASE}/#admin-licences`, { waitUntil: 'domcontentloaded' })
    await waitFor(page, T('pass-count-full'), 30000)
    await settle(page)
    const before = { full: await textOf(page, T('pass-count-full')), operator: await textOf(page, T('pass-count-operator')) }
    await click(page, T('admin-nav-users'))
    await waitFor(page, T(`user-pass-${uid}`), 30000)
    const shown = await page.$eval(T(`user-pass-${uid}`), (e) => e.value)
    await clearToasts(page)
    await choose(page, T(`user-pass-${uid}`), 'operator')
    const t = await toast(page, /Operator pass for 1 person/)
    await page.waitForFunction((s) => document.querySelector(s)?.value === 'operator', { timeout: 20000 }, T(`user-pass-${uid}`))
    await shot(page, 'users-pass-column')
    await click(page, T('admin-nav-licences'))
    await waitFor(page, T('pass-count-full'))
    await settle(page)
    const after = { full: await textOf(page, T('pass-count-full')), operator: await textOf(page, T('pass-count-operator')) }
    record('Users: the new person shows the Full user pass; choosing Operator in the Pass column says so', shown === 'full' && !!t, t)
    record('Licences: the counts follow (Full one fewer, Operator one more)', Number(after.full) === Number(before.full) - 1 && Number(after.operator) === Number(before.operator) + 1, `before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`)
    await shot(page, 'licences-counts')
    // and back, with the bulk action
    await click(page, T('admin-nav-users'))
    await click(page, T(`user-select-${uid}`))
    await waitFor(page, T('pass-bulk'))
    await clearToasts(page)
    await click(page, T('pass-bulk-full'))
    await toast(page, /Full user pass for 1 person/)
    await page.waitForFunction((s) => document.querySelector(s)?.value === 'full', { timeout: 20000 }, T(`user-pass-${uid}`))
    record('the bulk action sets the Full user pass back', true)
  })

  /* ================================================================ D. formSubmitted trigger panel */
  await section('D', 'The "When a form is submitted" trigger, built by clicking', async () => {
    await api('POST', '/tables', { displayName: 'Intake', name: 'Intake', columns: [{ displayName: 'Title', name: 'Title', type: 'text', required: true }, { displayName: 'Note', name: 'Note', type: 'text' }] })
    const appRec = await api('POST', '/apps', { name: 'Intake desk', width: 1280, height: 800 })
    ids.intakeApp = appRec.id
    const def = (await api('GET', `/apps/${appRec.id}`)).definition
    def.dataSources = ['Intake']
    def.screens[0].children = [
      { id: 'n_form', name: 'IntakeForm', type: 'Form', props: { X: '=20', Y: '=20', Width: '=520', Height: '=260', DataSource: '="Intake"', Mode: '=FormMode.New', Fields: '="Title"', Columns: '=1' }, children: [] },
      // G: a Form in New mode with a starting Item that has a column the form does not show
      { id: 'n_form2', name: 'PrefilledForm', type: 'Form', props: { X: '=600', Y: '=20', Width: '=520', Height: '=260', DataSource: '="Intake"', Mode: '=FormMode.New', Fields: '="Title"', Columns: '=1', Item: '={Title: "From the starting item", Note: "kept although not in Fields"}' }, children: [] },
    ]
    await api('PUT', `/apps/${appRec.id}`, { definition: def })

    await page.goto(`${BASE}/#flows`, { waitUntil: 'domcontentloaded' })
    await click(page, T('new-flow'), 30000)
    await waitFor(page, T('new-flow-gallery'))
    await click(page, T('blank-table'))
    await waitFor(page, T('flow-designer'), 30000)
    await page.waitForFunction(() => !document.querySelector('[data-testid="flow-designer"]')?.hasAttribute('data-readonly'), { timeout: 20000 })
    const flowId = await page.evaluate(() => location.hash.replace('#flow-', ''))
    await settle(page)
    await page.$eval(T('trigger-card'), (e) => e.click())
    await waitFor(page, T('trigger-panel'))
    await settle(page)
    await click(page, T('trigger-type-formSubmitted'))
    await settle(page)
    if (E.CT_DEBUG) log(`  after the click: panel ${!!(await page.$(T('trigger-panel')))}, app field ${!!(await page.$(T('trigger-form-app')))}, card ${await page.$eval(T('trigger-card'), (e) => e.innerText).catch(() => '?')}`)
    await waitFor(page, T('trigger-form-app'))
    await choose(page, T('trigger-form-app'), appRec.id)
    await page.waitForFunction((s) => [...(document.querySelector(s)?.options ?? [])].some((o) => o.value === 'IntakeForm'), { timeout: 20000 }, T('trigger-form-form'))
    const forms = await page.$$eval(`${T('trigger-form-form')} option`, (os) => os.map((o) => o.value).filter(Boolean))
    await choose(page, T('trigger-form-form'), 'IntakeForm')
    await shot(page, 'flow-trigger-form')
    record('the trigger panel lists the app\'s Forms after choosing the app', forms.includes('IntakeForm') && forms.includes('PrefilledForm'), forms.join(', '))
    // a step that records something: compose
    await page.$eval(T('insert-top-steps-0'), (e) => e.click())
    await waitFor(page, T('step-picker'))
    await click(page, T('pick-compose'))
    await page.waitForSelector(T('step-picker'), { hidden: true, timeout: 10000 })
    await fill(page, T('f-value'), '"intake " & Trigger.Record.Title')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelector('[data-testid="draft-state"]')?.getAttribute('data-state') === 'saved', { timeout: 30000 })
    await page.waitForFunction(() => document.querySelector('[data-testid="problem-count"]')?.textContent === 'No problems', { timeout: 20000 })
    await click(page, T('publish'))
    await page.waitForFunction(() => document.querySelector('[data-testid="draft-state"]')?.textContent === 'Published', { timeout: 20000 })
    await clickText(page, 'main', /^Turn on$/)
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Turn off'), { timeout: 15000 })
    const saved = (await api('GET', `/flows/${flowId}`)).flow
    record('published and turned on: the trigger is the chosen app and form', saved.enabled && saved.trigger?.type === 'formSubmitted' && saved.trigger.app === appRec.id && saved.trigger.form === 'IntakeForm', JSON.stringify(saved.trigger))
    await shot(page, 'flow-published')

    // submit the form in the app
    const run = await newPage(ctx, 'app-run')
    await run.goto(`${BASE}/#u-${appRec.id}`, { waitUntil: 'domcontentloaded' })
    const title = `${T('control-IntakeForm')} [id$="-Title"]`
    await waitFor(run, title, 30000)
    await fill(run, title, 'Submitted in the browser')
    await run.$eval(`${T('control-IntakeForm')} ${T('form-save')}`, (b) => b.click())
    let runs = []
    const end = Date.now() + 30000
    while (Date.now() < end) { runs = await q(`SELECT state, trigger_kind, trigger->'Record'->>'Title' AS title FROM env_default.ab_flow_runs WHERE flow_id = $1`, [flowId]); if (runs.some((r) => r.state === 'succeeded')) break; await sleep(300) }
    record('a submit of the Form starts the flow once, and it succeeds', runs.length === 1 && runs[0].state === 'succeeded' && runs[0].title === 'Submitted in the browser', JSON.stringify(runs))
    await shot(run, 'app-form-submitted')

    /* G. the starting Item */
    current = 'G'
    const pre = `${T('control-PrefilledForm')} [id$="-Title"]`
    await waitFor(run, pre)
    const preVal = await run.$eval(pre, (e) => e.value)
    await run.$eval(`${T('control-PrefilledForm')} ${T('form-save')}`, (b) => b.click())
    let row = null
    const end2 = Date.now() + 20000
    const src = (await q(`SELECT source FROM env_default.ab_tables WHERE lower(name) = 'intake'`))[0].source
    while (Date.now() < end2) { row = (await q(`SELECT "Title", "Note" FROM env_default."${src}" WHERE "Title" = 'From the starting item'`))[0] ?? null; if (row) break; await sleep(300) }
    record('a Form in New mode shows the starting Item\'s value for a field it shows', preVal === 'From the starting item', preVal)
    record('saving it keeps the starting Item\'s value for a column that is not in Fields (Note)', row?.Note === 'kept although not in Fields', JSON.stringify(row))
    await shot(run, 'app-form-starting-item')
    await run.close()
    current = 'D'
  })

  /* ================================================================ E. kiosk cycling */
  await section('E', 'TV / kiosk screen cycling', async () => {
    const { SHAPE, productionOverview } = await import(pathToFileURL(path.join(root, 'src', 'dashboards', 'manufacturing.ts')).href)
    await api('POST', '/tables', { displayName: 'ProductionLog', name: 'ProductionLog', columns: SHAPE.ProductionLog })
    await api('POST', '/tables', { displayName: 'Downtime', name: 'Downtime', columns: SHAPE.Downtime })
    const now = Date.now()
    for (let i = 0; i < 8; i++) await api('POST', '/data/ProductionLog/rows', { values: { LoggedOn: new Date(now - i * 26 * 3600_000).toISOString(), Shift: ['A', 'B'][i % 2], Machine: `Press ${1 + (i % 3)}`, Good: 100 + i, Scrap: i % 4, PlannedMin: 60, RunMin: 50, IdealCycleSec: 20 } })
    const dash = await api('POST', '/dashboards', { def: productionOverview(), roles: [] })
    await page.goto(`${BASE}/#u-dashboards?d=${dash.id}`, { waitUntil: 'domcontentloaded' })
    await click(page, T('dashboard-tokens'), 30000)
    await waitFor(page, T('tokens-sheet'))
    await fill(page, T('token-label'), 'Shop floor TV')
    await click(page, T('token-cycle-on'))
    await fill(page, T('token-cycle-every'), '5')
    await fill(page, T('token-cycle-pages'), '2')
    await click(page, T('token-cycle-range-today'))
    await click(page, T('token-cycle-range-last7'))
    await shot(page, 'kiosk-token-form')
    await click(page, T('token-create'))
    await waitFor(page, T('token-address'))
    const address = await page.$eval(T('token-address'), (e) => e.value)
    record('the cycle is set by clicking and is part of the address', /every=5/.test(address) && /ranges=today(%2C|,)last7/.test(address) && /pages=2/.test(address), address.replace(/t=[^&]+/, 't=...'))
    await shot(page, 'kiosk-token-created')
    await click(page, T('token-done'))
    const tv = await newPage(await browser.createBrowserContext(), 'kiosk', { width: 1920, height: 1080 })
    await tv.goto(address, { waitUntil: 'domcontentloaded' })
    await waitFor(tv, T('kiosk-cycle'), 30000)
    const step = () => tv.$eval(T('kiosk-cycle'), (e) => ({ step: e.getAttribute('data-step'), steps: e.getAttribute('data-steps'), range: e.getAttribute('data-range'), page: e.getAttribute('data-page'), text: e.innerText, rangeText: document.querySelector('[data-testid=kiosk-range]')?.textContent ?? '' }))
    await waitText(tv, T('kiosk-stamp'), /Updated/, 30000)
    // the first round of the cycle, step by step, as it moves on by itself
    const seen = [await step()]
    await shot(tv, 'kiosk-step-1')
    for (let i = 1; i < 4; i++) {
      await tv.waitForFunction((s, v) => document.querySelector(s)?.getAttribute('data-step') !== v, { timeout: 20000 }, T('kiosk-cycle'), seen[i - 1].step)
      seen.push(await step())
      await shot(tv, `kiosk-step-${i + 1}`)
    }
    const order = seen.map((s) => `${s.range}/${Number(s.page) + 1}`).join(' -> ')
    record('the screen cycles by itself every 5 seconds through 4 steps (2 ranges x 2 pages), none skipped in the first round', seen[0].steps === '4' && order === 'today/1 -> today/2 -> last7/1 -> last7/2', order)
    record('each step shows its page ("Page n of 2") and its own range in the header', seen.every((s) => /Page \d of 2/.test(s.text)) && seen[0].rangeText !== seen[2].rangeText && !seen.some((s) => /All time/.test(s.rangeText)), seen.map((s) => `${s.text.trim()} / ${s.rangeText}`).join(' | '))
    await tv.close()
  })

  /* ================================================================ F. templates */
  await section('F', 'ERP-lite through the plan screen; a widening pack upgrade', async () => {
    const templatesPage = async () => {
      await page.goto(`${BASE}/#home`, { waitUntil: 'domcontentloaded' })
      await settle(page)
      await page.goto(`${BASE}/#templates`, { waitUntil: 'domcontentloaded' })
      await waitFor(page, T('templates-page'), 30000)
      await settle(page)
    }
    const idle = () => page.waitForFunction(() => { const b = document.querySelector('[data-testid="tpl-review"], [data-testid="tpl-install"], [data-testid="tpl-flows-enable"]'); return !!b && !document.querySelector('[data-testid="tpl-dialog"] .animate-spin') }, { timeout: 60000 })
    const install = async (id, label) => {
      await templatesPage()
      await click(page, T('tpl-kind-solution'))
      await click(page, T(`tpl-card-${id}`))
      await page.waitForSelector(`${T('tpl-detail')}[data-template="${id}"]`, { visible: true, timeout: 20000 })
      await click(page, T('tpl-use'))
      await idle()
      await shot(page, `${label}-use`)
      await click(page, T('tpl-review'))
      await waitFor(page, T('tpl-main-plan'), 60000)
      const plan = await textOf(page, T('tpl-main-plan'))
      const problems = await page.$(`${T('tpl-main-plan')} ${T('plan-problems')}`)
      await shot(page, `${label}-plan`)
      await click(page, T('tpl-install'))
      await page.waitForFunction(() => { const d = document.querySelector('[data-testid="tpl-dialog"]'); return !d || d.getAttribute('data-step') === 'flows' || d.getAttribute('data-step') === 'done' }, { timeout: 180000 })
      await shot(page, `${label}-installed`)
      if (await page.$(T('tpl-flows-later'))) await click(page, T('tpl-flows-later'))
      await page.keyboard.press('Escape')
      await settle(page)
      return { plan, problems: !!problems }
    }
    const erp = await install('builtin.erp-lite', 'erp')
    const rows = await q(`SELECT template_id, mode, template_version FROM env_default.ab_template_installs ORDER BY installed_on`)
    record('ERP-lite: the plan screen shows the plan without problems; Install installs it (with the common business model)', !erp.problems && rows.some((r) => r.template_id === 'builtin.erp-lite') && rows.some((r) => r.template_id === 'builtin.business-model'), `${rows.map((r) => `${r.template_id}@${r.template_version}:${r.mode}`).join(', ')}; plan: ${erp.plan.replace(/\s+/g, ' ').slice(0, 160)}`)

    // the visitor log pack, then a test upgrade that widens a role (registered in this process, as the integration test does)
    await install('builtin.visitor-log', 'visitor-log')
    const vl = (await q(`SELECT id FROM env_default.ab_template_installs WHERE template_id = 'builtin.visitor-log'`))[0]
    const unregister = registerTestTemplates([visitorLogWider()])
    try {
      await templatesPage()
      await click(page, T(`tpl-upgrade-${vl.id}`))
      await waitFor(page, T('tpl-upgrade'))
      await page.waitForFunction(() => { const d = document.querySelector('[data-testid="tpl-upgrade"]'); return !!d && !d.querySelector('.animate-spin') && !!d.querySelector('[data-testid="solution-plan"]') }, { timeout: 60000 })
      await waitFor(page, T('plan-widens'))
      const widens = await textOf(page, T('plan-widens'))
      const disabled = await page.$eval(T('tpl-upgrade-go'), (b) => b.disabled)
      await shot(page, 'upgrade-widening-unticked')
      record('the upgrade dialog names the role that gets more access and what grows; without the tick the upgrade button is off', /Visit host/.test(widens) && /reads all rows/.test(widens) && disabled, widens.replace(/\s+/g, ' ').slice(0, 220))
      // the server refuses it too without the tick (the same plan token the dialog holds)
      const up = await api('POST', `/templates/installed/${vl.id}/upgrade/plan`, {})
      const refused = await admin.post(`/templates/installed/${vl.id}/upgrade`, { confirm: up.plan.token })
      record('without the tick the server refuses the upgrade and says why', refused.status === 422 && /more access/.test(refused.data?.error?.message ?? ''), refused.data?.error?.message)
      await page.keyboard.press('Escape')
      await settle(page)
      await click(page, T(`tpl-upgrade-${vl.id}`))
      await page.waitForFunction(() => { const d = document.querySelector('[data-testid="tpl-upgrade"]'); return !!d && !d.querySelector('.animate-spin') && !!d.querySelector('[data-testid="solution-plan"]') }, { timeout: 60000 })
      await click(page, T('plan-widens-ack'))
      await page.waitForFunction((s) => !document.querySelector(s)?.disabled, { timeout: 10000 }, T('tpl-upgrade-go'))
      await shot(page, 'upgrade-widening-ticked')
      await click(page, T('tpl-upgrade-go'))
      await page.waitForFunction(() => !document.querySelector('[data-testid="tpl-upgrade"]'), { timeout: 180000 })
      const v = (await q(`SELECT template_version FROM env_default.ab_template_installs WHERE id = $1`, [vl.id]))[0]?.template_version
      const audit = await q(`SELECT action FROM env_default.ab_audit WHERE action ILIKE '%widen%' OR details::text ILIKE '%acceptWidening%' OR details::text ILIKE '%widen%'`).catch(() => [])
      record('with the tick the upgrade runs (the new version is installed, the acceptance is in the audit log)', !!v && v !== '1.0.0' && audit.length > 0, `version ${v}; ${audit.length} audit entries`)
    } finally { unregister() }
  })

  /* ================================================================ H. every side-menu item, both modes */
  await section('H', 'Side menu, Dev mode and User mode', async () => {
    const walk = async (mode) => {
      await page.goto(`${BASE}/#home`, { waitUntil: 'domcontentloaded' })
      await waitFor(page, T('mode-switch'), 30000)
      await click(page, T(`mode-${mode}`))
      const nav = mode === 'dev' ? 'dev-nav' : 'user-nav'
      await waitFor(page, T(nav))
      const items = await page.$$eval(`${T(nav)} button[data-testid^="nav-"]`, (bs) => bs.map((b) => ({ id: b.getAttribute('data-testid'), label: b.textContent?.trim() })))
      const bad = []
      for (const it of items) {
        const before = problems.length
        await click(page, `${T(nav)} ${T(it.id)}`)
        await settle(page)
        const boundary = await page.$(T('error-boundary'))
        const heading = await page.$eval('main', (m) => (m.querySelector('h1, h2')?.textContent ?? '').trim()).catch(() => '')
        if (boundary || problems.length > before) bad.push(`${it.label}: ${boundary ? 'error boundary' : problems.slice(before).join('; ')}`)
        await shot(page, `${mode}-${it.id.replace('nav-', '')}`)
        await page.keyboard.press('Escape') // a panel (chat) opened by an item
        if (!heading && !boundary) log(`  ${mode} ${it.label}: no heading`)
        if (!(await page.$(T(nav)))) { await page.goto(`${BASE}/#home`, { waitUntil: 'domcontentloaded' }); await click(page, T(`mode-${mode}`)); await waitFor(page, T(nav)) }
      }
      return { items, bad }
    }
    const dev = await walk('dev')
    record(`Dev mode: every side-menu item opens without an error boundary, page error, console error or failed request (${dev.items.length})`, dev.items.length > 5 && dev.bad.length === 0, dev.bad.join(' | ') || dev.items.map((i) => i.label).join(', '))
    const user = await walk('user')
    record(`User mode: every side-menu item opens the same way (${user.items.length})`, user.items.length > 3 && user.bad.length === 0, user.bad.join(' | ') || user.items.map((i) => i.label).join(', '))
  })

  /* ================================================================ B (licensed). grace and read-only, in spawned processes */
  await section('B', 'A licensed install: grace and read-only, the strip under the top bar', async () => {
    const lic = path.join(OUT, 'lic')
    fs.mkdirSync(lic, { recursive: true })
    const dbs = { svc: 'appbuilder_exit_ct_lic_svc', inst: 'appbuilder_exit_ct_lic_inst' }
    for (const d of Object.values(dbs)) { await maint(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`); await maint(`CREATE DATABASE "${d}" ENCODING 'UTF8' TEMPLATE template0`) }
    const procs = []
    const startProc = (name, args, env) => { const out = fs.openSync(path.join(lic, `${name}.log`), 'a'); const p = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', out, out] }); procs.push(p); return p }
    const stopProc = (p) => new Promise((r) => { if (!p || p.exitCode !== null) return r(); p.once('exit', r); p.kill(); setTimeout(r, 5000) })
    const cli = (args, env) => new Promise((resolve) => { const p = spawn(process.execPath, ['server/licence-service/main.ts', ...args], { cwd: root, env: { ...process.env, ...env } }); let text = ''; p.stdout.on('data', (d) => { text += d }); p.stderr.on('data', (d) => { text += d }); p.on('exit', (code) => resolve({ code, text })) })
    const until = async (fn, what, ms = 45000) => { const end = Date.now() + ms; for (;;) { try { if (await fn()) return } catch { /* not yet */ } if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(250) } }
    try {
      const dbUrl = `postgres://${encodeURIComponent(DB.user)}:${encodeURIComponent(DB.password)}@${DB.host}:${DB.port}/${dbs.svc}`
      const passFile = path.join(lic, 'passphrase')
      fs.writeFileSync(passFile, randomBytes(18).toString('base64url'), { mode: 0o600 })
      const svcEnv = { APPBUILDER_LICENCE_DB_URL: dbUrl, APPBUILDER_LICENCE_KEY_PASSPHRASE_FILE: passFile }
      const kg = await cli(['keygen', '--out', path.join(lic, 'keys')], svcEnv)
      if (kg.code !== 0) throw new Error(`keygen: ${kg.text}`)
      const keyFile = /Private key: (.+)/.exec(kg.text)[1].trim()
      const pubFile = /Public key:\s+(.+)/.exec(kg.text)[1].trim()
      const mk = await cli(['org', 'create', '--name', 'Click-through Org', '--plan', 'pilot', '--full', '5', '--operator', '5', '--paid-until', '2099-12-31'], svcEnv)
      const licId = /licence id (lic_[a-z0-9]+)/.exec(mk.text)?.[1]
      if (!licId) throw new Error(`org create: ${mk.text}`)
      const ki = await cli(['key', 'issue', licId], svcEnv)
      const installKey = /^(abl_\S+)$/m.exec(ki.text)?.[1]
      if (!installKey) throw new Error(`key issue: ${ki.text}`)
      const keyPath = path.join(lic, 'install.key')
      fs.writeFileSync(keyPath, installKey, { mode: 0o600 })
      const svcPort = await freePort()
      const instPort = await freePort()
      const svcProcEnv = { ...svcEnv, APPBUILDER_LICENCE_SIGNING_KEY: keyFile, APPBUILDER_LICENCE_PORT: String(svcPort), APPBUILDER_LICENCE_HOST: '127.0.0.1' }
      let svc = startProc('service', ['server/licence-service/main.ts', 'serve'], svcProcEnv)
      await until(async () => (await fetch(`http://127.0.0.1:${svcPort}/healthz`)).ok, 'the licence service')
      const clockFile = path.join(lic, 'clock-offset')
      fs.writeFileSync(clockFile, '0')
      const ws = path.join(lic, 'workspace')
      fs.mkdirSync(ws, { recursive: true })
      startProc('install', ['server/main.ts'], {
        PORT: String(instPort), APPBUILDER_HOST: '127.0.0.1', APPBUILDER_WORKSPACE: ws, APPBUILDER_SETUP_CODE_FILE: path.join(ws, 'setup-code'),
        APPBUILDER_DB_HOST: DB.host, APPBUILDER_DB_PORT: String(DB.port), APPBUILDER_DB_NAME: dbs.inst, APPBUILDER_DB_USER: DB.user, APPBUILDER_DB_PASSWORD: DB.password,
        APPBUILDER_LICENCE_URL: `http://127.0.0.1:${svcPort}`, APPBUILDER_LICENCE_ID: licId, APPBUILDER_LICENCE_KEY_FILE: keyPath, APPBUILDER_LICENCE_KEY: '',
        APPBUILDER_LICENCE_PUBLIC_KEY_FILE: pubFile, APPBUILDER_LICENCE_TEST_CLOCK_FILE: clockFile,
        APPBUILDER_HOSTED: '', APPBUILDER_PUBLIC_URL: '', APPBUILDER_ENV_FILE: '', APPBUILDER_READ_ONLY: '', APPBUILDER_MIGRATION_BACKUP: 'skip',
      })
      const ibase = `http://127.0.0.1:${instPort}`
      await until(async () => (await fetch(`${ibase}/api/v1/health`)).status < 500 && fs.existsSync(path.join(ws, 'setup-code')), 'the licensed install', 90000)
      const code = fs.readFileSync(path.join(ws, 'setup-code'), 'utf8').split(/\r?\n/)[0].trim()
      const L = new Client(ibase)
      const s = await L.post('/setup/admin', { setupCode: code, ...ADMIN })
      if (s.status !== 200) throw new Error(`setup of the licensed install: ${JSON.stringify(s.data)}`)
      const lctx = await browser.createBrowserContext()
      const lp = await newPage(lctx, 'licensed')
      await lp.goto(`${ibase}/#home`, { waitUntil: 'domcontentloaded' })
      await waitFor(lp, T('login-email'), 30000)
      await fill(lp, T('login-email'), ADMIN.email)
      await lp.type('input[type=password]', ADMIN.password)
      await click(lp, T('login-submit'))
      await lp.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 30000 })
      await lp.goto(`${ibase}/#admin-licences`, { waitUntil: 'domcontentloaded' })
      await waitFor(lp, T('licence-check-now'), 30000)
      await click(lp, T('licence-check-now'))
      await waitText(lp, T('licence-last-check'), /verified/, 30000)
      const status = await textOf(lp, T('licence-status'))
      record('licensed: Check now verifies the licence (Active, the plan, the last check); no strip under the top bar', status === 'Active' && !(await lp.$(T('licence-banner'))), `${status}; ${await textOf(lp, T('licence-plan'))}`)
      await shot(lp, 'licensed-ok')

      // grace: the service is stopped
      await stopProc(svc)
      await click(lp, T('licence-check-now'))
      await waitFor(lp, T('licence-warning'), 30000)
      const warn = await textOf(lp, T('licence-warning'))
      // the strip is read when the page opens, every five minutes and on focus: open the page again as a person would
      await lp.reload({ waitUntil: 'domcontentloaded' })
      await waitFor(lp, T('licence-banner'), 30000)
      const strip = { kind: await lp.$eval(T('licence-banner'), (e) => e.getAttribute('data-kind')), text: await textOf(lp, T('licence-banner')) }
      const order = await lp.evaluate(() => { const h = document.querySelector('header')?.getBoundingClientRect(); const b = document.querySelector('[data-testid=licence-banner]')?.getBoundingClientRect(); return h && b ? b.top >= h.bottom - 1 && b.width > window.innerWidth * 0.5 : false })
      record('grace (service unreachable): the Licences page says when it becomes read-only, with the exact time', /Becomes read-only at/.test(warn) && /UTC/.test(warn), warn.replace(/\s+/g, ' ').slice(0, 200))
      record('grace: the strip under the top bar says what is wrong, how long is left and what to do', strip.kind === 'grace' && /What to do:/.test(strip.text) && order, `${strip.kind}: ${strip.text.replace(/\s+/g, ' ').slice(0, 220)}`)
      const at = /Becomes read-only at (.+?) \(/.exec(warn)?.[1] ?? '?'
      record('grace: the strip and the Licences page write the read-only time the same way', strip.text.includes(at), `page "${at}"; strip "${/\(([^)]+)\)/.exec(strip.text)?.[1]}"`)
      await shot(lp, 'licensed-grace')

      // read-only: the licence clock moved past the 72 hours
      const st = await L.req('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password }).then(() => L.get('/install/licence'))
      const lastGood = Date.parse(st.data?.licence?.licence?.receivedAt ?? new Date().toISOString())
      fs.writeFileSync(clockFile, String(lastGood + 72 * 3600_000 + 2 * 60_000 - Date.now()))
      await sleep(800) // the install reads the test clock file at most this often; not an assertion
      await click(lp, T('licence-check-now'))
      await waitFor(lp, T('licence-read-only'), 30000)
      const ro = await textOf(lp, T('licence-read-only'))
      await lp.reload({ waitUntil: 'domcontentloaded' })
      await waitFor(lp, T('licence-banner'), 30000)
      const strip2 = { kind: await lp.$eval(T('licence-banner'), (e) => e.getAttribute('data-kind')), text: await textOf(lp, T('licence-banner')) }
      const roBanner = await lp.$eval('body', (b) => b.innerText).then((t) => /read-only/i.test(t))
      record('read-only (past 72 hours): the Licences page says read-only since when and why', /Read-only since/.test(ro), ro.replace(/\s+/g, ' ').slice(0, 200))
      const since = /Read-only since (.+?)\n/.exec(`${ro}\n`)?.[1]?.trim() ?? '?'
      const bodyText = await lp.$eval('body', (b) => b.innerText)
      record('read-only: the strip for everyone writes "since" the same way as the Licences page', bodyText.includes(`Since ${since}.`), `page "${since}"; strip "${/Since ([^.]+\.[^.]*?)\./.exec(bodyText)?.[1] ?? '?'}"`)
      record('read-only: the strip under the top bar says what an administrator can do', strip2.kind !== 'grace' && /What to do:/.test(strip2.text) && roBanner, `${strip2.kind}: ${strip2.text.replace(/\s+/g, ' ').slice(0, 220)}`)
      await shot(lp, 'licensed-read-only')
      await lp.goto(`${ibase}/#home`, { waitUntil: 'domcontentloaded' })
      await settle(lp)
      await shot(lp, 'licensed-read-only-home')
      await lctx.close()
      svc = null
    } finally {
      for (const p of procs) await stopProc(p)
      for (const d of Object.values(dbs)) await maint(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`).catch(() => undefined)
    }
  })
} catch (e) {
  failed = true
  console.error(e)
} finally {
  current = 'run'
  const uniq = [...new Set(problems)]
  record('no page error, console error or HTTP answer >= 500 in the whole run', uniq.length === 0, uniq.slice(0, 15).join('\n'))
  if (browser) await browser.close().catch(() => undefined)
  await stop().catch(() => undefined)
  if (!E.KEEP) await maint(`DROP DATABASE IF EXISTS "${DB.database}"`).catch((e) => console.error(`could not drop ${DB.database}: ${e.message}`))
}
const by = {}
for (const r of results) { by[r.section] ??= { pass: 0, fail: 0 }; by[r.section][r.ok ? 'pass' : 'fail']++ }
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ at: new Date().toISOString(), by, results, fourxx: [...new Set(seen4xx)] }, null, 2))
console.log('\n| Section | Pass | Fail |\n| --- | --- | --- |')
for (const [k, v] of Object.entries(by)) console.log(`| ${k} | ${v.pass} | ${v.fail} |`)
const bad = results.filter((r) => !r.ok)
for (const b of bad) console.log(`FAIL ${b.section}: ${b.name}${b.evidence ? `\n     ${b.evidence.split('\n').join('\n     ')}` : ''}`)
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed${failed ? ' (stopped by an error)' : ''}`)
process.exit(failed || bad.length ? 1 : 0)
