#!/usr/bin/env node
/**
 * Tasks (P3 package T) against a REAL server and a real browser. DEVELOPER TOOL (sandbox values only), not part of the
 * product. Re-runnable.
 *
 *   npm run build   (the server serves dist/)
 *   node scripts/exit-check/p3-tasks.mjs
 *
 * A server runs in this process (EXIT_PORT, default 5277) on an EMPTY database (EXIT_DB_NAME, default appbuilder_exit_t:
 * created and dropped here; KEEP=1 keeps it). Time is never waited for: the reminder and digest runs are driven with an
 * injected clock (app.services.tasks.runReminders({ now }) / runDigest({ now })).
 *
 *  1. a reminder that is due is sent ONCE: a second run, a run after the server was stopped and started again (a restart),
 *     and a run on a second server instance on the same database send nothing more (idempotency key and ReminderSentOn);
 *  2. the overdue digest: one notification a person a day, listing overdue and due-today tasks, not repeated;
 *  3. a task shared with Bob is visible to Bob (the "Shared with me" view, the data API) and to nobody else (Cy);
 *     sharing is done on the screen, by the owner;
 *  4. repeat: "Repeat this task" on the detail panel, Save; completing the task creates the next one;
 *  5. phone width (360 px, touch): the list and board fit without sideways scrolling, the board shows one status at a time,
 *     the touch targets are at least 44 px, quick add works, a task is completed with its button, the date field is native.
 *
 * Settings: EXIT_DB_HOST (127.0.0.1), EXIT_DB_PORT (5435), EXIT_DB_USER (abdev), EXIT_DB_PASSWORD (abdev-sandbox-only),
 * EXIT_DB_NAME (appbuilder_exit_t), EXIT_MAINT_DB (appbuilder_test), EXIT_PORT (5277), EXIT_WORKSPACE (a new temp folder),
 * PUPPETEER_CORE, CHROME_PATH, SHOTS (screenshots).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { chromePath, puppeteerCorePath } from './browser-env.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const DB = { host: E.EXIT_DB_HOST || '127.0.0.1', port: Number(E.EXIT_DB_PORT || 5435), user: E.EXIT_DB_USER || 'abdev', password: E.EXIT_DB_PASSWORD || 'abdev-sandbox-only', database: E.EXIT_DB_NAME || 'appbuilder_exit_t' }
const MAINT = E.EXIT_MAINT_DB || 'appbuilder_test'
const PORT = Number(E.EXIT_PORT || 5277)
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = E.SHOTS || ''
const ADMIN = { name: 'Exit Admin', email: 'exit-admin@example.test', password: 'Exit-Example-Pass-2026' }
const BOB = { name: 'Bob Builder', email: 'bob@example.test', password: 'Bob-Example-Pass-2026' }
const CY = { name: 'Cy Bystander', email: 'cy@example.test', password: 'Cy-Example-Pass-2026' }
if (!/^(ab_s\d+|appbuilder_exit)/.test(DB.database)) { console.error('The database name must start with ab_s<n> or appbuilder_exit (it is dropped).'); process.exit(2) }
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) { console.error('Build the app first (npm run build).'); process.exit(2) }

const imp = (p) => import(pathToFileURL(path.join(root, p)).href)
const { createApp } = await imp('server/core/app.ts')
const { serveStatic } = await imp('server/core/static.ts')
const { setQuiet } = await imp('server/core/util.ts').catch(() => ({ setQuiet: null }))
const { Client } = await imp('server/core/kernel-testkit.ts')
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

const DIR = E.EXIT_WORKSPACE ? path.resolve(E.EXIT_WORKSPACE) : fs.mkdtempSync(path.join(os.tmpdir(), 'ab-exit-tasks-'))
if (E.EXIT_WORKSPACE) {
  if (path.resolve(DIR) === root || !/workspace/i.test(path.basename(DIR))) { console.error('EXIT_WORKSPACE must be a folder named ...workspace... (it is emptied).'); process.exit(2) }
  fs.rmSync(DIR, { recursive: true, force: true })
}
fs.mkdirSync(DIR, { recursive: true })
let app = null
let server = null
async function start() {
  app = await createApp({ env: { APPBUILDER_MIGRATION_BACKUP: 'skip' }, config: { workspaceDir: DIR }, printSetupCode: false, jobs: false })
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
let admin = new Client(BASE)
let bob = new Client(BASE)
let cy = new Client(BASE)
async function api(c, method, p, body) {
  const r = await c.req(method, p, body)
  if (r.status !== 200) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`)
  return r.data
}
const login = (c, u) => api(c, 'POST', '/auth/login', { email: u.email, password: u.password })

let browser = null
const T = (id) => `[data-testid="${id}"]`
const errors = []
async function shot(page, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }) } }
const waitFor = (page, sel, timeout = 20000) => page.waitForSelector(sel, { visible: true, timeout })
async function click(page, sel) { await page.waitForSelector(`${sel}:not([disabled])`, { visible: true, timeout: 20000 }); await (await waitFor(page, sel)).click() }
async function newPage(ctx, viewport = { width: 1400, height: 900 }) {
  const page = await ctx.newPage()
  await page.setViewport(viewport)
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.accept())
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
const rowsOf = (c, status = 'all') => api(c, 'GET', `/collab/my-tasks?status=${status}`).then((d) => (Array.isArray(d) ? d : d.items ?? d.rows ?? []))
const notesOf = (c) => api(c, 'GET', '/notifications?limit=100').then((d) => d.items ?? [])
const taskNotes = async (c, text) => (await notesOf(c)).filter((n) => String(n.title ?? '').includes(text))

let failed = false
try {
  await maint(`DROP DATABASE IF EXISTS "${DB.database}"`)
  await start()
  const setupCode = app.services.setupCode.current() ?? ''
  await api(admin, 'POST', '/setup/database', { setupCode, host: DB.host, port: DB.port, database: DB.database, user: DB.user, password: DB.password, createDatabase: true })
  await api(admin, 'POST', '/setup/admin', { setupCode, ...ADMIN })
  await login(admin, ADMIN)
  const staff = await api(admin, 'POST', '/roles', { name: 'Staff', apps: 'all', privileges: [] })
  const mkUser = async (u) => {
    const rec = await api(admin, 'POST', '/users', { name: u.name, email: u.email, password: u.password, roleIds: [staff.id] })
    await q('UPDATE ab.users SET must_change_password = false WHERE id = $1', [rec.id ?? rec.user?.id])
    return rec.id ?? rec.user?.id
  }
  const bobId = await mkUser(BOB)
  await mkUser(CY)
  await login(bob, BOB)
  await login(cy, CY)
  const adminId = (await q('SELECT id FROM ab.users WHERE lower(email) = $1', [ADMIN.email]))[0].id
  record('setup', true, 'administrator, Bob and Cy (staff)')

  /* ---------------------------------------------------------------- 1. reminders fire once, across a restart */
  log('1. reminders')
  const now = new Date()
  const hourAgo = new Date(now.getTime() - 3600_000).toISOString()
  const remind = await api(admin, 'POST', '/data/Activities/rows', { values: { Subject: 'Send the exit-check invoice', Type: 'Task', AssignedTo: adminId, ReminderOn: hourAgo, DueOn: new Date(now.getTime() + 86400_000).toISOString() } })
  const remindId = remind.id ?? remind.row?.id
  const first = await app.services.tasks.runReminders({ now })
  check(first.sent === 1, 'reminders: the first run sends the due reminder', JSON.stringify(first))
  check((await taskNotes(admin, 'Reminder: Send the exit-check invoice')).length === 1, 'reminders: the person has exactly one notification')
  check((await app.services.tasks.runReminders({ now: new Date(now.getTime() + 60_000) })).sent === 0, 'reminders: a second run sends nothing')
  await stop()
  await start()
  admin = new Client(BASE); bob = new Client(BASE); cy = new Client(BASE)
  await login(admin, ADMIN); await login(bob, BOB); await login(cy, CY)
  check((await app.services.tasks.runReminders({ now: new Date(now.getTime() + 120_000) })).sent === 0, 'reminders: after a restart a run sends nothing')
  // the stamp is wiped (as if the write after sending was lost): the idempotency key still stops a second notification
  await q('UPDATE ab.sys_activities SET "ReminderSentOn" = NULL WHERE id = $1', [remindId]).catch(async () => {
    const t = (await q(`SELECT table_schema AS s, table_name AS n FROM information_schema.columns WHERE column_name = 'ReminderSentOn' LIMIT 1`))[0]
    await q(`UPDATE "${t.s}"."${t.n}" SET "ReminderSentOn" = NULL WHERE id = $1`, [remindId])
  })
  await app.services.tasks.runReminders({ now: new Date(now.getTime() + 180_000) })
  check((await taskNotes(admin, 'Reminder: Send the exit-check invoice')).length === 1, 'reminders: even with the stamp lost, the same reminder is not delivered twice (idempotency key)')

  /* ---------------------------------------------------------------- 2. overdue digest */
  log('2. digest')
  const dayStart = new Date(); dayStart.setUTCHours(4, 30, 0, 0) // 10:00 in Kolkata, the install default zone
  const two = new Date(dayStart.getTime() - 2 * 86400_000).toISOString()
  await api(admin, 'POST', '/data/Activities/rows', { values: { Subject: 'Overdue thing A', Type: 'Task', AssignedTo: bobId, DueOn: two } })
  await api(admin, 'POST', '/data/Activities/rows', { values: { Subject: 'Overdue thing B', Type: 'Task', AssignedTo: bobId, DueOn: two } })
  await app.services.tasks.runDigest({ now: dayStart })
  const digest = await taskNotes(bob, 'Tasks: 2 overdue')
  check(digest.length === 1, 'digest: Bob gets one "Tasks: 2 overdue" notification', digest.map((d) => d.title).join(' | '))
  await app.services.tasks.runDigest({ now: new Date(dayStart.getTime() + 3600_000) })
  check((await taskNotes(bob, 'Tasks: 2 overdue')).length === 1, 'digest: not repeated the same day')
  check((await taskNotes(cy, 'Tasks:')).length === 0, 'digest: Cy (nothing overdue) gets none')

  /* ---------------------------------------------------------------- 3. sharing, on the screen */
  log('3. sharing')
  browser = await puppeteer.launch({ executablePath: chromePath(E), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1400,900'] })
  const ctxA = await browser.createBrowserContext()
  const ctxB = await browser.createBrowserContext()
  const ctxC = await browser.createBrowserContext()
  const pa = await newPage(ctxA)
  await signIn(pa, ADMIN)
  await pa.goto(`${BASE}/#u-tasks`, { waitUntil: 'domcontentloaded' })
  await waitFor(pa, T('tasks-page'))
  await pa.type(T('task-quick-add'), 'Plan the offsite')
  await click(pa, T('task-add'))
  await pa.waitForFunction(() => [...document.querySelectorAll('[data-testid="task-row"]')].some((r) => r.textContent.includes('Plan the offsite')), { timeout: 20000 })
  await pa.evaluate(() => [...document.querySelectorAll('[data-testid="task-row"]')].find((r) => r.textContent.includes('Plan the offsite')).querySelector('[data-testid="task-open"]').click())
  await waitFor(pa, T('task-share'))
  await pa.select(T('task-share-add'), bobId)
  await pa.waitForFunction(() => document.querySelector('[data-testid="task-share"]')?.textContent.includes('Bob Builder'), { timeout: 20000 })
  await shot(pa, 'tasks-share.png')
  const planned = (await rowsOf(admin)).find((t) => t.Subject === 'Plan the offsite')
  check(planned, 'sharing: the owner added the task on the screen')
  const pb = await newPage(ctxB)
  await signIn(pb, BOB)
  await pb.goto(`${BASE}/#u-tasks`, { waitUntil: 'domcontentloaded' })
  await waitFor(pb, T('task-scope'))
  await pb.select(T('task-scope'), 'shared')
  await pb.waitForFunction(() => [...document.querySelectorAll('[data-testid="task-row"]')].some((r) => r.textContent.includes('Plan the offsite')), { timeout: 20000 })
  record('sharing: Bob sees it under "Shared with me"', true)
  const pc = await newPage(ctxC)
  await signIn(pc, CY)
  await pc.goto(`${BASE}/#u-tasks`, { waitUntil: 'domcontentloaded' })
  await waitFor(pc, T('task-scope'))
  await pc.select(T('task-scope'), 'shared')
  await sleep(1500)
  const cySees = await pc.evaluate(() => document.body.innerText.includes('Plan the offsite'))
  const readable = async (c, id) => ((await c.req('POST', '/query', { plan: { version: 2, table: 'Activities', filter: { col: 'id', op: 'eq', value: id } } })).data?.rows ?? []).length
  const cyRows = await readable(cy, planned.id)
  check(!cySees && cyRows === 0, 'sharing: Cy sees nothing (not on the screen, and the query returns no row)', `rows ${cyRows}`)
  check((await readable(bob, planned.id)) === 1, 'sharing: Bob reads it through the query API')
  const bobWrite = await bob.req('POST', '/data/ActivityShares/rows', { values: { Activity: planned.id, PrincipalType: 'user', Principal: 'someone', Access: 'read' } })
  check(bobWrite.status >= 400, 'sharing: Bob cannot pass it on (only the owner writes shares)', `status ${bobWrite.status}`)

  /* ---------------------------------------------------------------- 4. repeat */
  log('4. repeat')
  await pa.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(pa, T('tasks-page'))
  await pa.waitForFunction(() => [...document.querySelectorAll('[data-testid="task-row"]')].some((r) => r.textContent.includes('Plan the offsite')), { timeout: 20000 })
  await pa.evaluate(() => [...document.querySelectorAll('[data-testid="task-row"]')].find((r) => r.textContent.includes('Plan the offsite')).querySelector('[data-testid="task-open"]').click())
  await waitFor(pa, T('task-repeat-toggle'))
  await click(pa, T('task-repeat-toggle'))
  await waitFor(pa, T('task-weekdays'))
  await click(pa, T('task-weekday-1'))
  await shot(pa, 'tasks-repeat.png')
  await click(pa, T('task-save'))
  await pa.waitForFunction(() => !document.querySelector('[data-testid="task-sheet"]'), { timeout: 20000 })
  const rec = (await rowsOf(admin)).find((t) => t.id === planned.id)
  check(rec && /weekly/.test(String(rec.Recurrence)), 'repeat: Save stores the rule', String(rec?.Recurrence).slice(0, 80))
  await api(admin, 'PATCH', `/data/Activities/rows/${planned.id}`, { changes: { Status: 'Done' } })
  const all = await rowsOf(admin)
  check(all.filter((t) => t.Subject === 'Plan the offsite').length === 2 && all.some((t) => t.Subject === 'Plan the offsite' && t.Status === 'Open'), 'repeat: completing it creates the next one', `${all.filter((t) => t.Subject === 'Plan the offsite').length} tasks`)

  /* ---------------------------------------------------------------- 5. phone width */
  log('5. phone width')
  for (let i = 0; i < 3; i++) await api(bob, 'POST', '/data/Activities/rows', { values: { Subject: `Phone task ${i}`, Type: 'Task', AssignedTo: bobId } })
  const pp = await newPage(ctxB, { width: 360, height: 780, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  // the context already holds Bob's session
  await pp.goto(`${BASE}/#u-tasks`, { waitUntil: 'domcontentloaded' })
  await waitFor(pp, T('tasks-list'))
  await sleep(500)
  const fit = await pp.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, pageSw: document.querySelector('[data-testid="tasks-page"]').scrollWidth, pageCw: document.querySelector('[data-testid="tasks-page"]').clientWidth }))
  check(fit.sw <= fit.iw + 1 && fit.pageSw <= fit.pageCw + 1, 'phone: the Tasks page does not scroll sideways at 360 px', JSON.stringify(fit))
  await shot(pp, 'tasks-phone-list.png')
  const sizes = await pp.evaluate(() => {
    const h = (s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null }
    return { complete: h('[data-testid="task-complete"]'), open: h('[data-testid="task-open"]'), quick: h('[data-testid="task-quick-add"]'), add: h('[data-testid="task-add"]'), due: h('[data-testid="task-quick-due"]'), dueType: document.querySelector('[data-testid="task-quick-due"]')?.type }
  })
  check(sizes.complete.w >= 44 && sizes.complete.h >= 44 && sizes.open.h >= 44 && sizes.quick.h >= 44 && sizes.add.h >= 44 && sizes.due.h >= 44, 'phone: complete button, task, quick add, Add and date field are at least 44 px tall', JSON.stringify(sizes))
  check(sizes.dueType === 'date', 'phone: the due date is the native date picker')
  await pp.type(T('task-quick-add'), 'Added by thumb')
  await click(pp, T('task-add'))
  await pp.waitForFunction(() => [...document.querySelectorAll('[data-testid="task-row"]')].some((r) => r.textContent.includes('Added by thumb')), { timeout: 20000 })
  check((await rowsOf(bob)).some((t) => t.Subject === 'Added by thumb'), 'phone: quick add creates the task')
  const phoneTask = (await rowsOf(bob)).find((t) => t.Subject === 'Phone task 0')
  await pp.evaluate(() => [...document.querySelectorAll('[data-testid="task-row"]')].find((r) => r.textContent.includes('Phone task 0')).querySelector('[data-testid="task-complete"]').click())
  await pp.waitForFunction(() => ![...document.querySelectorAll('[data-testid="task-row"]')].some((r) => r.textContent.includes('Phone task 0')), { timeout: 20000 })
  check((await rowsOf(bob)).find((t) => t.id === phoneTask.id)?.Status === 'Done', 'phone: the complete button marks it Done (and it leaves the Open list)')
  // board: one status at a time
  await pp.evaluate(() => [...document.querySelectorAll('button, [role="radio"]')].find((b) => b.textContent.trim() === 'Board')?.click())
  await waitFor(pp, T('tasks-board'))
  const cols = await pp.$$eval('[data-testid="tasks-board"] > [data-testid^="board-"]', (l) => l.length)
  const fit2 = await pp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  check(cols === 1 && fit2, 'phone: the board collapses to one status column and fits', `${cols} column(s)`)
  await shot(pp, 'tasks-phone-board.png')
  // detail opens as a bottom sheet with a native date-time field
  await pp.evaluate(() => document.querySelector('[data-testid="board-card"] button')?.click())
  await waitFor(pp, T('task-due'))
  const sheet = await pp.evaluate(() => { const r = document.querySelector('[data-testid="task-sheet"]').getBoundingClientRect(); return { top: Math.round(r.top), w: Math.round(r.width), type: document.querySelector('[data-testid="task-due"]').type } })
  check(sheet.type === 'datetime-local' && sheet.w <= 360, 'phone: the detail panel fits the screen with a native date and time field', JSON.stringify(sheet))
  await shot(pp, 'tasks-phone-detail.png')

  check(!errors.length, 'no script errors in the browser', errors.slice(0, 3).join(' | '))
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
