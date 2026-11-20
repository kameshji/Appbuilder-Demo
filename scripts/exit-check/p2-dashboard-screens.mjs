#!/usr/bin/env node
/**
 * The dashboard screens whose server side came first (P2-C wave 3), against a REAL server: view tokens, the kiosk / TV
 * page, email snapshots, pinned tiles, and the wave-2 screens (settings, viewer roles, drill-through) that were only run in
 * demo mode before. DEVELOPER TOOL (sandbox values only), not part of the product. Re-runnable.
 *
 *   npm run build   (the server serves dist/)
 *   node scripts/exit-check/p2-dashboard-screens.mjs
 *
 * A server is started in this process (EXIT_PORT, default 5187) on an EMPTY database (EXIT_DB_NAME, default ab_s7: created
 * and dropped here; KEEP=1 keeps it) with a fake SMTP server. Every request the server receives is recorded, so the
 * kiosk checks look at what really arrived (Cookie header, CSRF header, URLs) and not only at what the browser says.
 *
 *  1. settings: an administrator changes the week start, saves, reloads, sees it; a non-administrator sees them read only
 *     (and PUT is refused);
 *  2. viewer roles: ticked in the dialog and saved; the role's user opens the dashboard, a user without it gets 404;
 *  3. drill-through: "Clicking opens an app" in the tile editor, Save: the server's checkDashboardDef keeps it; a bad
 *     parameter name is refused (422);
 *  4. view tokens: created on the screen (the administrator's "sees every row" warning shown), the one-time address;
 *  5. kiosk: a fresh browser context without cookies draws the tiles; the same address in a context where another person
 *     is signed in shows the token's view, not theirs; the requests carry no Cookie and no CSRF header and the token is in
 *     no URL the server saw; nothing in browser storage; a network drop keeps the data and recovers; the cursor hides;
 *     revoke -> "not valid", no data on the screen;
 *  6. snapshots: created on the screen with two recipients (one who cannot open the dashboard), "Send now", the mail with
 *     the PDF, the history with the skip reason; the PDF is kept in SHOTS and page 1 rendered to PNG when PyMuPDF exists;
 *  7. pins: pin two tiles, the launcher's "My dashboard", reload, reorder, unpin, a removed tile shows "No longer
 *     available" with Remove; the Dev home shows pins too.
 *
 * Settings: EXIT_DB_HOST (127.0.0.1), EXIT_DB_PORT (5435), EXIT_DB_USER (abdev), EXIT_DB_PASSWORD (abdev-sandbox-only),
 * EXIT_DB_NAME (ab_s7), EXIT_MAINT_DB (appbuilder_test), EXIT_PORT (5187), EXIT_WORKSPACE (a new temp folder),
 * PUPPETEER_CORE, CHROME_PATH, SHOTS (screenshots and the received PDF), PYTHON (python, for the PDF page image).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const DB = { host: E.EXIT_DB_HOST || '127.0.0.1', port: Number(E.EXIT_DB_PORT || 5435), user: E.EXIT_DB_USER || 'abdev', password: E.EXIT_DB_PASSWORD || 'abdev-sandbox-only', database: E.EXIT_DB_NAME || 'ab_s7' }
const MAINT = E.EXIT_MAINT_DB || 'appbuilder_test'
const PORT = Number(E.EXIT_PORT || 5187)
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = E.SHOTS || ''
const ADMIN = { name: 'Exit Admin', email: 'exit-admin@example.test', password: 'Exit-Example-Pass-2026' }
const VERA = { name: 'Vera Viewer', email: 'vera@example.test', password: 'Vera-Example-Pass-2026' }
const OTTO = { name: 'Otto Outsider', email: 'otto@example.test', password: 'Otto-Example-Pass-2026' }
if (!/^(ab_s\d+|appbuilder_exit)/.test(DB.database)) { console.error('The database name must start with ab_s<n> or appbuilder_exit (it is dropped).'); process.exit(2) }
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) { console.error('Build the app first (npm run build).'); process.exit(2) }

const imp = (p) => import(pathToFileURL(path.join(root, p)).href)
const { createApp } = await imp('server/core/app.ts')
const { serveStatic } = await imp('server/core/static.ts')
const { setQuiet } = await imp('server/core/util.ts').catch(() => ({ setQuiet: null }))
const { startFakeSmtp } = await imp('server/core/identity/fake-smtp.ts')
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

/* ------------------------------------------------------------------ server (every request recorded), SMTP, API */

const DIR = E.EXIT_WORKSPACE ? path.resolve(E.EXIT_WORKSPACE) : fs.mkdtempSync(path.join(os.tmpdir(), 'ab-exit-screens-'))
if (E.EXIT_WORKSPACE) {
  // a given workspace starts empty every run (it holds server.json of the database dropped last time)
  if (path.resolve(DIR) === root || !/workspace/i.test(path.basename(DIR))) { console.error('EXIT_WORKSPACE must be a folder named ...workspace... (it is emptied).'); process.exit(2) }
  fs.rmSync(DIR, { recursive: true, force: true })
}
fs.mkdirSync(DIR, { recursive: true })
let app = null
let server = null
let smtp = null
/** what the server received: method, url, and the headers that matter here */
const seen = []
async function start() {
  app = await createApp({ env: { APPBUILDER_MIGRATION_BACKUP: 'skip' }, config: { workspaceDir: DIR }, printSetupCode: false, jobs: true })
  server = http.createServer((req, res) => {
    seen.push({ at: Date.now(), method: req.method, url: req.url, cookie: !!req.headers.cookie, csrf: req.headers['x-appbuilder'] ?? null, env: req.headers['x-appbuilder-environment'] ?? null, auth: String(req.headers.authorization ?? ''), referer: String(req.headers.referer ?? '') })
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
const vera = new Client(BASE)
const otto = new Client(BASE)
async function api(c, method, p, body) {
  const r = await c.req(method, p, body)
  if (r.status !== 200) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`)
  return r.data
}
async function waitMail(pred, what, ms = 60_000) {
  const end = Date.now() + ms
  for (;;) {
    const m = smtp.inbox.find(pred)
    if (m) return m
    if (Date.now() > end) throw new Error(`no email: ${what}; inbox: ${smtp.inbox.map((x) => `${x.to}:${x.subject}`).join(', ')}`)
    await sleep(250)
  }
}

/* ------------------------------------------------------------------ browser helpers */

let browser = null
const T = (id) => `[data-testid="${id}"]`
const errors = []
async function shot(page, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }) } }
const waitFor = (page, sel, timeout = 20000) => page.waitForSelector(sel, { visible: true, timeout })
async function click(page, sel) { await page.waitForSelector(`${sel}:not([disabled])`, { visible: true, timeout: 20000 }); await (await waitFor(page, sel)).click() }
async function typeInto(page, sel, text) {
  const el = await waitFor(page, sel)
  await el.click()
  await el.evaluate((e) => { if (typeof e.select === 'function') e.select() })
  await page.keyboard.press('Backspace')
  await page.type(sel, text)
}
async function newPage(ctx) {
  const page = await ctx.newPage()
  await page.setViewport({ width: 1600, height: 1000 })
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
const tilesReady = (page, n, scope = '') => page.waitForFunction((n, scope) => {
  const t = [...document.querySelectorAll(`${scope} section[data-testid^="tile-"][data-state]`)]
  return t.length >= n && t.every((x) => x.getAttribute('data-state') === 'ready')
}, { timeout: 30000 }, n, scope)
/** the number a KPI tile shows ("Good quantity 2,676 ..." -> "2,676") */
const tileText = (page, id, scope = '') => page.$eval(`${scope} section[data-testid="tile-${id}"]`, (e) => (/([\d][\d,.]*)/.exec(e.innerText.replace(/\s+/g, ' ')) ?? [''])[0])

/* ------------------------------------------------------------------ main */

let failed = false
let kioskPage = null
try {
  await maint(`DROP DATABASE IF EXISTS "${DB.database}"`)
  smtp = await startFakeSmtp()
  await start()
  const setupCode = app.services.setupCode.current() ?? ''
  await api(admin, 'POST', '/setup/database', { setupCode, host: DB.host, port: DB.port, database: DB.database, user: DB.user, password: DB.password, createDatabase: true })
  await api(admin, 'POST', '/setup/admin', { setupCode, ...ADMIN })
  await api(admin, 'POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password })
  await api(admin, 'PUT', '/identity/email', { host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'apps@example.test', installName: 'Exit Apps', publicUrl: BASE })

  log('setup: plant tables, roles, users, rows, the dashboard, an app')
  const logT = await api(admin, 'POST', '/tables', { displayName: 'ProductionLog', name: 'ProductionLog', columns: SHAPE.ProductionLog })
  const downT = await api(admin, 'POST', '/tables', { displayName: 'Downtime', name: 'Downtime', columns: SHAPE.Downtime })
  // viewers read their OWN rows only: the kiosk (the administrator's view) must show more than Vera sees
  const viewers = await api(admin, 'POST', '/roles', { name: 'Viewers', apps: 'all', privileges: [logT, downT].map((t) => ({ table: t.id, create: true, read: 'own', update: 'own', delete: 'none' })) })
  const others = await api(admin, 'POST', '/roles', { name: 'Others', apps: [], privileges: [] })
  const mkUser = async (u, roleIds) => {
    const rec = await api(admin, 'POST', '/users', { name: u.name, email: u.email, password: u.password, roleIds })
    await q('UPDATE ab.users SET must_change_password = false WHERE id = $1', [rec.id ?? rec.user?.id])
    return rec.id ?? rec.user?.id
  }
  const veraId = await mkUser(VERA, [viewers.id])
  const ottoId = await mkUser(OTTO, [others.id])
  await api(vera, 'POST', '/auth/login', { email: VERA.email, password: VERA.password })
  await api(otto, 'POST', '/auth/login', { email: OTTO.email, password: OTTO.password })
  const now = Date.now()
  const row = (i) => ({ LoggedOn: new Date(now - i * 5 * 60_000).toISOString(), Shift: ['A', 'B', 'C'][i % 3], Machine: `Press ${1 + (i % 4)}`, Good: 100 + i, Scrap: i % 5, PlannedMin: 60, RunMin: 50, IdealCycleSec: 20 })
  for (let i = 0; i < 24; i++) await api(i % 6 === 0 ? vera : admin, 'POST', '/data/ProductionLog/rows', { values: row(i) })
  for (let i = 0; i < 6; i++) await api(admin, 'POST', '/data/Downtime/rows', { values: { StartedOn: new Date(now - i * 7 * 60_000).toISOString(), Machine: `Press ${1 + (i % 4)}`, Reason: ['Breakdown', 'Changeover', 'Other'][i % 3], Minutes: 10 + i } })
  const dash = await api(admin, 'POST', '/dashboards', { def: productionOverview(), roles: [] })
  const appRec = await api(admin, 'POST', '/apps', { name: 'Machine details', width: 1280, height: 800 })
  record('setup', true, `dashboard ${dash.id} (${dash.def.tiles.length} tiles), 24 + 6 rows (4 of them Vera's)`)

  browser = await puppeteer.launch({ executablePath: E.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1000'] })
  const ctxA = await browser.createBrowserContext()
  const ctxV = await browser.createBrowserContext()
  const pa = await newPage(ctxA)
  await signIn(pa, ADMIN)
  const pv = await newPage(ctxV)
  await signIn(pv, VERA)

  /* ---------------------------------------------------------------- 1. settings */
  log('1. settings on a real server')
  await pa.goto(`${BASE}/#u-dashboards`, { waitUntil: 'domcontentloaded' })
  await click(pa, T('dashboard-settings-open'))
  await waitFor(pa, T('settings-week'))
  await pa.select(T('settings-week'), '7')
  await click(pa, T('settings-save'))
  await pa.waitForFunction(() => !document.querySelector('[data-testid="dashboard-settings"]'), { timeout: 15000 })
  check((await api(admin, 'GET', '/dashboards/settings')).settings.weekStart === 7, 'settings: Save stores the week start on the server', 'weekStart 7')
  await pa.reload({ waitUntil: 'domcontentloaded' })
  await click(pa, T('dashboard-settings-open'))
  await waitFor(pa, T('settings-week'))
  await sleep(500)
  check(await pa.$eval(T('settings-week'), (s) => s.value) === '7', 'settings: after a reload the screen shows the saved value')
  await shot(pa, 'settings-admin.png')
  await pa.keyboard.press('Escape')
  await api(admin, 'PUT', '/dashboards/settings', { settings: { ...(await api(admin, 'GET', '/dashboards/settings')).settings, weekStart: 1 } })
  await pv.goto(`${BASE}/#u-dashboards`, { waitUntil: 'domcontentloaded' })
  await click(pv, T('dashboard-settings-open'))
  await waitFor(pv, T('settings-readonly'))
  const ro = await pv.evaluate(() => ({ save: !!document.querySelector('[data-testid="settings-save"]'), disabled: !!document.querySelector('[data-testid="dashboard-settings"] fieldset')?.disabled }))
  const put = await vera.req('PUT', '/dashboards/settings', { settings: { weekStart: 7 } })
  check(!ro.save && ro.disabled && put.status === 403, 'settings: a non-administrator sees them read only (no Save, fields disabled) and the server refuses a PUT', `PUT ${put.status}`)
  await pv.keyboard.press('Escape')

  /* ---------------------------------------------------------------- 2. viewer roles */
  log('2. viewer roles')
  check((await vera.req('GET', `/dashboards/${dash.id}`)).status === 404, 'viewer roles: before, Vera (no listed role) gets 404')
  await pa.goto(`${BASE}/#u-dashboards?d=${dash.id}`, { waitUntil: 'domcontentloaded' })
  await tilesReady(pa, 6)
  await click(pa, T('dashboard-edit'))
  await click(pa, T('dashboard-viewers-change'))
  await click(pa, T(`viewer-role-${viewers.id}`))
  await click(pa, T('viewer-roles-close'))
  await click(pa, T('dashboard-save'))
  await sleep(1200)
  const afterRoles = await api(admin, 'GET', `/dashboards/${dash.id}`)
  check(afterRoles.roles.includes(viewers.id), 'viewer roles: ticked in the dialog and saved on the server', JSON.stringify(afterRoles.roles))
  const v200 = await vera.req('GET', `/dashboards/${dash.id}`)
  const o404 = await otto.req('GET', `/dashboards/${dash.id}`)
  check(v200.status === 200 && o404.status === 404 && !(await api(otto, 'GET', '/dashboards')).items.length, 'viewer roles: Vera (the role) opens it, Otto (without it) gets 404 and an empty list', `${v200.status} / ${o404.status}`)

  /* ---------------------------------------------------------------- 3. drill-through */
  log('3. drill-through')
  await pa.reload({ waitUntil: 'domcontentloaded' })
  await tilesReady(pa, 6)
  await click(pa, T('dashboard-edit'))
  await click(pa, T('tile-good-configure'))
  await waitFor(pa, T('tile-editor-drill'))
  await click(pa, T('tile-editor-drill'))
  await waitFor(pa, T('tile-editor-drill-app'))
  await pa.select(T('tile-editor-drill-app'), appRec.id)
  await click(pa, T('tile-editor-apply'))
  await pa.waitForFunction(() => !document.querySelector('[data-testid="tile-editor"]'), { timeout: 15000 }).catch(() => undefined)
  await click(pa, T('dashboard-save'))
  await sleep(1200)
  const drilled = (await api(admin, 'GET', `/dashboards/${dash.id}`)).def.tiles.find((t) => t.id === 'good')
  check(drilled?.drill?.appId === appRec.id, 'drill-through: chosen in the tile editor, saved, kept by the server\'s checkDashboardDef', JSON.stringify(drilled?.drill))
  const badDef = { ...afterRoles.def, tiles: afterRoles.def.tiles.map((t) => (t.id === 'good' ? { ...t, drill: { appId: appRec.id, params: [{ name: '1bad', field: 'Good' }] } } : t)) }
  const bad = await admin.req('PATCH', `/dashboards/${dash.id}`, { def: badDef })
  check(bad.status === 422 && /parameter name/.test(bad.data?.error?.message ?? ''), 'drill-through: a bad parameter name is refused by the server (422, in words)', bad.data?.error?.message)
  await pa.reload({ waitUntil: 'domcontentloaded' })
  await tilesReady(pa, 6)
  check(!!(await pa.$(T('tile-good-open'))), 'drill-through: after a reload the KPI tile has its Open button')

  /* ---------------------------------------------------------------- 4. view tokens screen */
  log('4. view tokens on the screen')
  await click(pa, T('dashboard-tokens'))
  await waitFor(pa, T('token-form'))
  await typeInto(pa, T('token-label'), 'Shop floor TV')
  await click(pa, T('token-create'))
  await waitFor(pa, T('token-created'))
  const warnText = await pa.$eval(T('token-warnings'), (e) => e.innerText)
  const order = await pa.evaluate(() => { const w = document.querySelector('[data-testid="token-warnings"]'); const a = document.querySelector('[data-testid="token-address"]'); return !!(w && a && (w.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) })
  check(/administrator you see every row/.test(warnText) && order, 'tokens: the server\'s warning (an administrator sees every row) is shown above the address before it is copied', warnText.slice(0, 90))
  const address = await pa.$eval(T('token-address'), (e) => e.value)
  const token = new URLSearchParams(address.split('#')[1].split('?')[1]).get('t')
  const secret = token.split('.')[3]
  const u = new URL(address)
  check(u.search === '' && u.hash.startsWith('#u-kiosk?t=abv.') && secret.length === 43, 'tokens: the address carries the token after # (never in a query string)', address.replace(secret, '<secret>'))
  await shot(pa, 'tokens-created.png')
  await click(pa, T('token-done'))
  await waitFor(pa, T('token-list'))
  const tokenRows = (await api(admin, 'GET', `/dashboards/${dash.id}/tokens`)).items
  check(tokenRows.length === 1 && tokenRows[0].status === 'active' && !(await pa.content()).includes(secret), 'tokens: the list shows it as active; the secret is no longer on the screen', tokenRows[0]?.label)
  const tokenId = tokenRows[0].id
  await pa.keyboard.press('Escape')

  /* ---------------------------------------------------------------- 5. kiosk */
  log('5. kiosk page')
  const ctxK = await browser.createBrowserContext()
  kioskPage = await newPage(ctxK)
  const pk = kioskPage
  await pk.setViewport({ width: 1920, height: 1080 })
  const browserUrls = []
  const fromSw = []
  // DevTools reports a navigation with its #fragment (which is not sent): only the part before # goes on the wire
  pk.on('request', (r) => browserUrls.push(r.isNavigationRequest() ? r.url().split('#')[0] : r.url()))
  pk.on('response', (r) => { if (r.url().includes('/api/v1/dashboards/kiosk')) fromSw.push(r.fromServiceWorker()) })
  const mark = seen.length
  await pk.goto(address, { waitUntil: 'domcontentloaded' })
  await waitFor(pk, T('kiosk-page'), 30000)
  await tilesReady(pk, 6, '[data-testid="kiosk-page"]')
  const kioskGood = await tileText(pk, 'good')
  const svgs = await pk.$$eval('[data-testid="kiosk-page"] svg', (x) => x.length)
  check(svgs >= 6 && (await pk.$eval(T('kiosk-title'), (e) => e.textContent)) === 'Production overview', 'kiosk: a fresh browser context with no cookies draws the tiles (no sign-in, no shell)', `${svgs} charts; Good quantity tile: "${kioskGood.slice(0, 60)}"`)
  const noShell = await pk.evaluate(() => !document.querySelector('nav') && !document.querySelector('input[type=password]') && !document.querySelector('a[href^="#"]') && !document.querySelector('[data-testid$="-open"]') && !document.querySelector('[data-testid$="-pin"]'))
  check(noShell, 'kiosk: no navigation, no sign-in form, no links into the app, no Open (drill-through) or pin buttons')
  await shot(pk, 'kiosk-light.png')
  const kioskReqs = () => seen.slice(mark).filter((x) => x.url.startsWith('/api/v1/dashboards/kiosk'))
  const kr = kioskReqs()
  check(kr.length >= 2 && kr.every((x) => !x.cookie && x.csrf === null && x.env === null && x.auth === `Bearer ${token}`), 'kiosk: the server received the kiosk requests with no Cookie, no CSRF and no environment header, only Authorization: Bearer', kr.map((x) => `${x.method} ${x.url} cookie=${x.cookie}`).join('; '))
  const leakUrl = seen.slice(mark).filter((x) => x.url.includes(secret) || x.referer.includes(secret))
  check(!leakUrl.length && !browserUrls.some((x) => x.includes(secret)), 'kiosk: the token is in no URL (and no Referer) the server received or the browser requested', `${seen.length - mark} requests at the server, ${browserUrls.length} in the browser; server URLs: ${[...new Set(seen.slice(mark).map((x) => x.url.split('?')[0]))].join(' ')}${leakUrl.length ? `; LEAK ${leakUrl.map((x) => x.url).join(' ')}` : ''}`)
  const stored = await pk.evaluate((s) => ({ ls: JSON.stringify({ ...localStorage }).includes(s), ss: JSON.stringify({ ...sessionStorage }).includes(s), title: document.title.includes(s), cookie: document.cookie }), secret)
  check(!stored.ls && !stored.ss && !stored.title && stored.cookie === '', 'kiosk: the token is not in localStorage, sessionStorage or the tab title; the context has no cookie', `title "${await pk.title()}"`)
  check(fromSw.every((x) => x === false), 'kiosk: no kiosk API answer came from the service worker', `${fromSw.length} answers`)

  // another person signed in to the same browser: the token's view, not theirs
  const veraDash = await newPage(ctxV)
  await veraDash.goto(`${BASE}/#u-dashboards?d=${dash.id}`, { waitUntil: 'domcontentloaded' })
  await tilesReady(veraDash, 6)
  const veraGood = await tileText(veraDash, 'good')
  await veraDash.close()
  const mark2 = seen.length
  const pvk = await newPage(ctxV)
  await pvk.goto(address, { waitUntil: 'domcontentloaded' })
  await waitFor(pvk, T('kiosk-page'), 30000)
  await tilesReady(pvk, 6, '[data-testid="kiosk-page"]')
  const vkGood = await tileText(pvk, 'good')
  const kr2 = seen.slice(mark2).filter((x) => x.url.startsWith('/api/v1/dashboards/kiosk'))
  const veraCookie = (await ctxV.cookies?.() ?? []).length
  check(vkGood === kioskGood && vkGood !== veraGood && kr2.length >= 2 && kr2.every((x) => !x.cookie && x.csrf === null), 'kiosk: with Vera signed in to the same browser it shows the token\'s view (not Vera\'s own rows) and still sends no cookie', `kiosk "${vkGood.slice(0, 40)}" vs Vera's own "${veraGood.slice(0, 40)}"; Vera's context has ${veraCookie} cookie(s)`)
  await pvk.close()

  // a network drop keeps the data, then it recovers
  await pk.setOfflineMode(true)
  await pk.evaluate(() => window.dispatchEvent(new Event('online')))
  await waitFor(pk, T('kiosk-hiccup'), 15000)
  const stillTiles = await pk.$$eval('[data-testid="kiosk-page"] section[data-testid^="tile-"][data-state="ready"]', (x) => x.length)
  check(stillTiles >= 6, 'kiosk: offline, the last data stays on the screen with a small note', `${stillTiles} tiles`)
  await pk.setOfflineMode(false)
  await pk.evaluate(() => window.dispatchEvent(new Event('online')))
  await pk.waitForFunction(() => !document.querySelector('[data-testid="kiosk-hiccup"]') && document.querySelector('[data-testid="kiosk-page"]')?.getAttribute('data-state') === 'ready', { timeout: 20000 })
  record('kiosk: back online it updates again', true)
  // the cursor hides after 3 s without movement
  await pk.mouse.move(400, 400)
  await sleep(3600)
  check(await pk.$eval(T('kiosk-page'), (e) => e.className.includes('cursor-none')), 'kiosk: the cursor hides after a few seconds without movement')
  // dark theme
  await pk.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
  await pk.evaluate(() => document.documentElement.classList.add('dark'))
  await sleep(400)
  await shot(pk, 'kiosk-dark.png')
  await pk.evaluate(() => document.documentElement.classList.remove('dark'))

  // revoke on the screen -> the kiosk shows "not valid" and no data
  await click(pa, T('dashboard-tokens'))
  await click(pa, T(`token-revoke-${tokenId}`))
  await click(pa, T(`token-revoke-ok-${tokenId}`))
  await pa.waitForFunction((id) => document.querySelector(`[data-testid="token-status-${id}"]`)?.textContent === 'revoked', { timeout: 15000 }, tokenId)
  await shot(pa, 'tokens-list.png')
  await pa.keyboard.press('Escape')
  await pk.evaluate(() => window.dispatchEvent(new Event('online')))
  await pk.waitForFunction(() => document.querySelector('[data-testid="kiosk-message"]')?.getAttribute('data-problem') === 'invalid', { timeout: 20000 })
  const gone = await pk.evaluate(() => ({ tiles: document.querySelectorAll('section[data-testid^="tile-"]').length, text: document.body.innerText + document.title }))
  check(gone.tiles === 0 && !gone.text.includes('Production overview') && !gone.text.includes('Good quantity'),'kiosk: after revoke the screen shows "not valid" and no data at all', gone.text.replace(/\s+/g, ' ').slice(0, 80))
  await shot(pk, 'kiosk-revoked.png')
  const audit = (await q(`SELECT action FROM env_default.ab_audit WHERE action LIKE 'dashboard.token.%' ORDER BY id`)).map((r) => r.action)
  check(audit.join() === 'dashboard.token.create,dashboard.token.revoke', 'tokens: create and revoke are in the audit log', audit.join(', '))

  /* ---------------------------------------------------------------- 6. snapshots */
  log('6. email snapshots')
  await click(pa, T('dashboard-snapshots'))
  await click(pa, T('snapshot-new'))
  await waitFor(pa, T('snapshot-editor'))
  check(/own access/.test(await pa.$eval(T('snapshot-rule'), (e) => e.textContent)), 'snapshots: the screen says each recipient gets the dashboard with their own access, and someone who cannot open it gets nothing')
  await typeInto(pa, T('snapshot-name'), 'Morning OEE')
  await pa.select(T('snapshot-add-recipient'), veraId)
  await pa.select(T('snapshot-add-recipient'), ottoId)
  await click(pa, T('snapshot-save'))
  await waitFor(pa, T('snapshot-list'))
  const snap = (await api(admin, 'GET', `/dashboards/${dash.id}/snapshots`)).items[0]
  check(snap?.name === 'Morning OEE' && snap.def.recipients.userIds.length === 3, 'snapshots: created on the screen (me, Vera, Otto)', `${snap?.scheduleText}; ${JSON.stringify(snap?.def.recipients)}`)
  await shot(pa, 'snapshots-list.png')
  await click(pa, T(`snapshot-run-${snap.id}`))
  const mail = await waitMail((m) => m.to.includes(VERA.email) && /Production overview/.test(m.subject), 'the snapshot email to Vera')
  const adminMail = await waitMail((m) => m.to.includes(ADMIN.email) && /Production overview/.test(m.subject), 'the snapshot email to the administrator')
  const att = mail.attachments.find((a) => /\.pdf$/.test(a.fileName))
  check(!!att && att.content.subarray(0, 5).toString() === '%PDF-' && !!adminMail, '"Send now": the mail arrives with a PDF attachment (Vera and the administrator)', att ? `${mail.subject}; ${att.fileName}, ${att.content.length} bytes` : 'no attachment')
  check(!smtp.inbox.some((m) => m.to.includes(OTTO.email)), 'snapshots: Otto (cannot open the dashboard) gets nothing')
  let viewed = 'not viewed (no PyMuPDF)'
  if (SHOTS && att) {
    fs.mkdirSync(SHOTS, { recursive: true })
    const pdfPath = path.join(SHOTS, 'snapshot-vera.pdf')
    fs.writeFileSync(pdfPath, att.content)
    const py = spawnSync(E.PYTHON || 'python', ['-E', '-P', '-c', 'import sys, fitz; d = fitz.open(sys.argv[1]); d[0].get_pixmap(dpi=110).save(sys.argv[2]); print(d.page_count)', pdfPath, path.join(SHOTS, 'snapshot-vera-page1.png')], { encoding: 'utf8' })
    if (py.status === 0) viewed = `page 1 rendered to snapshot-vera-page1.png (${py.stdout.trim()} page(s))`
  }
  record('snapshots: the PDF', true, viewed)
  // the history: per recipient, with Otto's skip reason
  let run = null
  for (let i = 0; i < 80; i++) { run = (await api(admin, 'GET', `/dashboards/snapshots/${snap.id}/runs`)).items[0]; if (run && run.status !== 'running') break; await sleep(250) }
  await click(pa, T(`snapshot-history-${snap.id}`))
  await waitFor(pa, T(`snapshot-recipient-${ottoId}`))
  const ottoLine = await pa.$eval(T(`snapshot-recipient-${ottoId}`), (e) => e.textContent)
  const veraLine = await pa.$eval(T(`snapshot-recipient-${veraId}`), (e) => e.textContent)
  check(/nothing sent/.test(ottoLine) && /cannot open the dashboard|No access/.test(ottoLine) && /sent/.test(veraLine), 'snapshots: the history shows each recipient, Otto skipped with the reason', `${veraLine} | ${ottoLine}`)
  await shot(pa, 'snapshots-history.png')
  // edit, pause and delete on the screen
  await pa.$$eval('[data-testid="snapshot-runs"] button[aria-label="Back to the list"]', (b) => b[0].click())
  await click(pa, T(`snapshot-toggle-${snap.id}`))
  await sleep(800)
  check((await api(admin, 'GET', `/dashboards/${dash.id}/snapshots`)).items[0].enabled === false, 'snapshots: Pause on the screen disables it')
  await click(pa, T(`snapshot-edit-${snap.id}`))
  await typeInto(pa, T('snapshot-name'), 'Morning OEE (edited)')
  await click(pa, T('snapshot-save'))
  await waitFor(pa, T('snapshot-list'))
  await sleep(500)
  check((await api(admin, 'GET', `/dashboards/${dash.id}/snapshots`)).items[0].name === 'Morning OEE (edited)', 'snapshots: Edit saves')
  await click(pa, T(`snapshot-delete-${snap.id}`))
  await click(pa, T(`snapshot-delete-ok-${snap.id}`))
  await sleep(800)
  check(!(await api(admin, 'GET', `/dashboards/${dash.id}/snapshots`)).items.length, 'snapshots: Delete (after the inline confirmation) removes it')
  const sAudit = (await q(`SELECT action FROM env_default.ab_audit WHERE action LIKE 'dashboard.snapshot.%' ORDER BY id`)).map((r) => r.action)
  record('snapshots: audit', sAudit.includes('dashboard.snapshot.create') && sAudit.includes('dashboard.snapshot.run') && sAudit.includes('dashboard.snapshot.delete'), sAudit.join(', '))
  await pa.keyboard.press('Escape')

  /* ---------------------------------------------------------------- 7. pins */
  log('7. pinned tiles')
  await pv.goto(`${BASE}/#u-dashboards?d=${dash.id}`, { waitUntil: 'domcontentloaded' })
  await tilesReady(pv, 6)
  await click(pv, T('tile-good-pin'))
  await sleep(700)
  await click(pv, T('tile-oee-pin'))
  await sleep(700)
  check((await api(vera, 'GET', '/dashboards/pins')).items.map((p) => p.tileId).join() === 'good,oee', 'pins: Vera pins two tiles from the dashboard')
  await pv.goto(`${BASE}/#u`, { waitUntil: 'domcontentloaded' })
  await waitFor(pv, T('pinned-tiles'), 30000)
  await tilesReady(pv, 2, '[data-testid="pinned-tiles"]')
  const pinnedGood = await tileText(pv, 'good', '[data-testid="pinned-tiles"]')
  check(pinnedGood === veraGood && pinnedGood !== kioskGood,'pins: "My dashboard" on the launcher draws them as Vera (her own rows)', pinnedGood.slice(0, 60))
  await shot(pv, 'pins-launcher.png')
  await pv.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(pv, T('pinned-tiles'), 30000)
  await tilesReady(pv, 2, '[data-testid="pinned-tiles"]')
  record('pins: still there after a reload', true)
  await click(pv, T('pinned-right-0'))
  await sleep(800)
  check((await api(vera, 'GET', '/dashboards/pins')).items.map((p) => p.tileId).join() === 'oee,good', 'pins: reorder saves the order')
  // the dashboard link
  check((await pv.$eval(T(`pinned-open-${dash.id}-good`), (a) => a.getAttribute('href'))) === `#u-dashboards?d=${dash.id}`, 'pins: each pin links to its dashboard')
  // a removed tile: "No longer available" with Remove
  const cur = await api(admin, 'GET', `/dashboards/${dash.id}`)
  await api(admin, 'PATCH', `/dashboards/${dash.id}`, { def: { ...cur.def, tiles: cur.def.tiles.filter((t) => t.id !== 'oee') } })
  await pv.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(pv, T('pinned-gone-0'), 30000)
  await shot(pv, 'pins-gone.png')
  await click(pv, T('pinned-gone-remove-0'))
  await sleep(800)
  check((await api(vera, 'GET', '/dashboards/pins')).items.map((p) => p.tileId).join() === 'good', 'pins: a removed tile shows "No longer available"; Remove drops it')
  await click(pv, T('pinned-remove-0'))
  await sleep(800)
  check(!(await api(vera, 'GET', '/dashboards/pins')).items.length && !(await pv.$(T('pinned-tiles'))), 'pins: unpin empties "My dashboard" (the section goes away)')
  // the Dev home shows pins too (the administrator pins one)
  await api(admin, 'PUT', '/dashboards/pins', { items: [{ dashboardId: dash.id, tileId: 'trend' }] })
  await pa.goto(`${BASE}/#home`, { waitUntil: 'domcontentloaded' })
  await waitFor(pa, T('pinned-tiles'), 30000)
  await tilesReady(pa, 1, '[data-testid="pinned-tiles"]')
  await shot(pa, 'pins-dev-home.png')
  record('pins: the Dev home shows "My dashboard"', true)

  check(!errors.length, 'no script errors in the browser', errors.slice(0, 3).join(' | '))
} catch (e) {
  failed = true
  console.error(e)
  if (kioskPage && SHOTS) await shot(kioskPage, 'failure-kiosk.png').catch(() => undefined)
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stop().catch(() => undefined)
  await smtp?.close().catch(() => undefined)
  if (!E.KEEP) await maint(`DROP DATABASE IF EXISTS "${DB.database}"`).catch((e) => console.error(`could not drop ${DB.database}: ${e.message}`))
  if (!E.EXIT_WORKSPACE) fs.rmSync(DIR, { recursive: true, force: true })
}
const bad = results.filter((r) => !r.ok)
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed${failed ? ' (stopped at the first failure)' : ''}`)
process.exit(failed || bad.length ? 1 : 0)
