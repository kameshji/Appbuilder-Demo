/**
 * Headless check and screenshots of the recycle bin (docs/dev/recycle-bin.md). DEVELOPER TOOL, not part of the product.
 *
 * Needs puppeteer-core (PUPPETEER_CORE, default /tmp/pgcheck/node_modules/puppeteer-core), Chrome (CHROME_PATH) and a
 * running server on an EMPTY sandbox database (built app: `npm run build` first):
 *   APPBUILDER_DB_HOST=127.0.0.1 APPBUILDER_DB_PORT=5433 APPBUILDER_DB_NAME=appbuilder_test_rb_shots \
 *   APPBUILDER_DB_USER=abdev APPBUILDER_DB_PASSWORD=abdev-sandbox-only APPBUILDER_WORKSPACE=/tmp/ws-rb \
 *   APPBUILDER_SETUP_CODE_FILE=/tmp/ws-rb/setup-code PORT=5199 node server/main.ts
 * Run:  SETUP_CODE_FILE=/tmp/ws-rb/setup-code BASE=http://localhost:5199 node scripts/docs-shots/recycle.mjs
 *
 * What it checks, in the browser: in a running app, deleting a parent with children shows "4 rows deleted ... Undo";
 * Undo brings all of them back; a second delete, the app closed, is restored from the portal's Data > Deleted view
 * (whole batch); DeletedRows() and Restore() in an app; a restricted user sees only the deleted rows they could delete.
 * Writes PNGs to docs/images/ (OUT).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const PUPPETEER_CORE = process.env.PUPPETEER_CORE || '/tmp/pgcheck/node_modules/puppeteer-core'
const { default: puppeteer } = await import(pathToFileURL(path.join(PUPPETEER_CORE, 'lib/puppeteer/puppeteer-core.js')).href)
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome'
const BASE = (process.env.BASE || 'http://localhost:5199').replace(/\/$/, '')
const OUT = process.env.OUT || path.join(root, 'docs', 'images')
const ADMIN = { name: 'Test Admin', email: 'admin@example.test', password: 'Example-Only-Pass-2026' }
const REP = { name: 'Rae Rep', email: 'rep@example.test', password: 'Example-Only-Pass-2027' }
fs.mkdirSync(OUT, { recursive: true })
const setupCode = process.env.SETUP_CODE ?? (process.env.SETUP_CODE_FILE ? fs.readFileSync(process.env.SETUP_CODE_FILE, 'utf8').split('\n')[0].trim() : '')

function client() {
  let cookie = ''
  return async function api(method, p, body) {
    const res = await fetch(BASE + '/api/v1' + p, { method, headers: { 'X-Appbuilder': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const c of res.headers.getSetCookie?.() ?? []) { const [pair] = c.split(';'); if (pair.startsWith('ab_session=')) cookie = pair }
    const data = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : await res.text()
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(data)}`)
    return data
  }
}
const api = client()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (cond, what) => { if (!cond) throw new Error(`CHECK FAILED: ${what}`); console.log(`ok - ${what}`) }
const uid = (() => { let n = 0; return () => `n_rb_${++n}` })()
const node = (type, name, props, children = []) => ({ id: uid(), name, type, props, children })
const box = (x, y, w, h) => ({ X: `=${x}`, Y: `=${y}`, Width: `=${w}`, Height: `=${h}` })

/* ------------------------------------------------------------------ data over the API */

await api('POST', '/setup/admin', { setupCode, ...ADMIN })
await api('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password })
const parent = await api('POST', '/tables', { displayName: 'Projects', name: 'Projects', columns: [{ displayName: 'Name', type: 'text' }] })
const child = await api('POST', '/tables', { displayName: 'Project tasks', name: 'ProjectTasks', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Project', name: 'Project', type: 'lookup', lookupTable: 'Projects', required: true }] })
ok(parent.recycleDays === 30 && child.recycleDays === 30, 'new tables keep deleted rows for 30 days')
// the tasks go with their project (cascade), through the data model designer's plan and apply
const model = await api('GET', '/model')
const rel = model.model.relationships.find((r) => r.fromTable === child.id && r.fromColumn === 'Project')
const ops = [{ op: 'putRelationship', rel: { ...rel, onDelete: 'cascade' }, before: rel }]
const plan = await api('POST', '/model/plan', { ops })
await api('POST', '/model/apply', { ops, token: plan.token })
const p1 = (await api('POST', '/data/Projects/rows', { values: { Name: 'Warehouse move' } })).row
const p2 = (await api('POST', '/data/Projects/rows', { values: { Name: 'New website' } })).row
for (const t of ['Book trucks', 'Pack shelves', 'Label boxes']) await api('POST', '/data/ProjectTasks/rows', { values: { Title: t, Project: p1.id } })
await api('POST', '/data/ProjectTasks/rows', { values: { Title: 'Pick a theme', Project: p2.id } })

const app = await api('POST', '/apps', { name: 'Projects', width: 1280, height: 800 })
const full = await api('GET', `/apps/${app.id}`)
const def = full.definition
def.dataSources = ['Projects', 'ProjectTasks']
def.screens[0].children.push(
  node('Label', 'Counts', { ...box(40, 30, 700, 40), Text: '="Projects: " & CountRows(Projects) & " · Tasks: " & CountRows(ProjectTasks)', Size: '=20' }),
  node('DataTable', 'ProjectList', { ...box(40, 90, 560, 260), Items: '=Projects', Columns: '="Name"' }),
  node('Button', 'DeleteProject', { ...box(40, 370, 260, 44), Text: '="Delete selected project"', OnSelect: '=Remove(Projects, ProjectList.Selected)' }),
  node('Label', 'BinTitle', { ...box(660, 90, 560, 30), Text: '="My recycle bin: " & CountRows(DeletedRows(Projects)) & " deleted"', Size: '=16' }),
  node('DataTable', 'BinList', { ...box(660, 130, 560, 220), Items: '=DeletedRows(Projects)', Columns: '="Name, DeletedBy, DaysLeft"' }),
  node('Button', 'RestoreFromBin', { ...box(660, 370, 260, 44), Text: '="Restore selected"', OnSelect: '=Restore(BinList.Selected)' }),
)
await api('PUT', `/apps/${app.id}`, { definition: def })

/* ------------------------------------------------------------------ the browser */

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--window-size=1440,900'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('appbuilder-theme', 'light') } catch { /* ignore */ } })
page.on('pageerror', (e) => console.log('  [page error]', e.message))
const shot = async (p, name) => { await sleep(500); await p.screenshot({ path: path.join(OUT, name) }); console.log(`shot ${name}`) }
const click = async (p, sel) => { await p.waitForSelector(sel, { visible: true, timeout: 20000 }); await p.click(sel) }
const type = async (p, sel, text) => { await p.waitForSelector(sel, { visible: true, timeout: 15000 }); await p.click(sel, { clickCount: 3 }); await p.type(sel, text) }
const text = (p) => p.evaluate(() => document.body.innerText)
const waitText = (p, re, timeout = 20000) => p.waitForFunction((src) => new RegExp(src).test(document.body.innerText), { timeout }, re.source)
const login = async (p, who) => {
  await p.goto(BASE + '/#home', { waitUntil: 'networkidle0' })
  await type(p, 'input[type=email]', who.email)
  await type(p, 'input[type=password]', who.password)
  await p.keyboard.press('Enter')
  await p.waitForSelector('nav', { timeout: 20000 })
}
const clickText = async (p, t) => {
  await p.waitForFunction((x) => [...document.querySelectorAll('tr')].some((e) => (e.innerText ?? '').includes(x)), { timeout: 20000 }, t).catch(() => {})
  await sleep(600)
  return clickNow(p, t)
}
const clickNow = (p, t) => p.evaluate((x) => {
  const el = [...document.querySelectorAll('tr')].find((e) => (e.innerText ?? '').split('\t').map((s) => s.trim()).includes(x) || (e.innerText ?? '').trim().startsWith(x))
  el?.click()
  return !!el
}, t)

try {
  await login(page, ADMIN)

  // 1. in a running app: delete a project with its tasks; Undo brings all four rows back
  await page.goto(`${BASE}/#run-${app.id}`, { waitUntil: 'networkidle0' })
  await waitText(page, /Projects: 2 · Tasks: 4/)
  ok(true, 'the app shows 2 projects and 4 tasks')
  ok(await clickText(page, 'Warehouse move'), 'selected the project in the app')
  await sleep(400)
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Delete selected project')?.click())
  await page.waitForSelector('[data-testid="undo-delete"]', { timeout: 20000 })
  const undoText = await page.$eval('[data-testid="undo-delete-text"]', (e) => e.textContent)
  ok(/4 rows deleted \(with related rows\)\. Kept for 30 days/.test(undoText), `the Undo toast says what went: "${undoText}"`)
  await waitText(page, /Projects: 1 · Tasks: 1/)
  ok(true, 'the project and its 3 tasks disappeared from the app at once')
  await waitText(page, /My recycle bin: 1 deleted/)
  ok(true, 'DeletedRows(Projects) shows the deleted project in the app')
  await shot(page, 'recycle-undo-toast.png')
  await click(page, '[data-testid="undo-delete-undo"]')
  await waitText(page, /Projects: 2 · Tasks: 4/)
  ok(true, 'Undo restored the project and all its tasks')
  const after = await api('POST', '/data/ProjectTasks/query', { count: true, top: 0 })
  ok(after.total === 4, 'the server has the 4 tasks back')

  // 2. delete again, close the app; the portal's Deleted view restores the whole batch
  ok(await clickText(page, 'Warehouse move'), 'selected the project again')
  await sleep(400)
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Delete selected project')?.click())
  await waitText(page, /Projects: 1 · Tasks: 1/)
  await page.goto(`${BASE}/#table-${child.id}`, { waitUntil: 'networkidle0' })
  await click(page, '[data-testid="view-deleted"]')
  await page.waitForSelector('[data-testid="deleted-view"]', { timeout: 20000 })
  await waitText(page, /3 deleted rows you can restore/)
  ok(true, 'the tasks table lists the 3 tasks deleted with the project (cascade)')
  await page.goto(`${BASE}/#table-${parent.id}`, { waitUntil: 'networkidle0' })
  await click(page, '[data-testid="view-deleted"]')
  await page.waitForSelector(`[data-testid="deleted-${p1.id}"]`, { timeout: 20000 })
  await shot(page, 'recycle-deleted-view.png')
  await click(page, `[data-testid="restore-batch-${p1.id}"]`)
  await waitText(page, /Restored 4 rows/)
  ok(true, 'Restore 4 rows in the Deleted view brought the batch back after the app was closed')
  const tasks = await api('POST', '/data/ProjectTasks/query', { count: true, top: 0 })
  ok(tasks.total === 4, 'all 4 tasks are back')

  // 3. the setting in the table designer
  await click(page, '[data-testid="tab-settings"]')
  await page.waitForSelector('[data-testid="recycle-setting"]')
  await page.evaluate(() => document.querySelector('[data-testid="recycle-setting"]')?.scrollIntoView({ block: 'center' }))
  await shot(page, 'recycle-setting.png')

  // 4. Restore() in an app, from the maker's own recycle bin screen
  await api('POST', '/data/Projects/delete', { ids: [p2.id] })
  await page.goto(`${BASE}/#run-${app.id}`, { waitUntil: 'networkidle0' })
  await waitText(page, /My recycle bin: 1 deleted/)
  ok(await clickText(page, 'New website'), 'selected the deleted project in the app\'s own bin')
  await sleep(300)
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Restore selected')?.click())
  await waitText(page, /Projects: 2 · Tasks: 4/)
  ok(true, 'Restore(BinList.Selected) brought the project back')

  // 5. a restricted user sees only the deleted rows they could delete
  const role = await api('POST', '/roles', { name: 'Project member', apps: 'all', privileges: [{ table: parent.id, create: true, read: 'own', update: 'own', delete: 'own' }, { table: child.id, create: true, read: 'own', update: 'own', delete: 'own' }] })
  const temp = 'Temporary-Pass-2026-x'
  await api('POST', '/users', { name: REP.name, email: REP.email, password: temp, roleIds: [role.id] })
  const rep = client()
  await rep('POST', '/auth/login', { email: REP.email, password: temp })
  // a password set by an administrator is temporary: replaced at the first sign-in
  await rep('POST', '/auth/password', { current: temp, next: REP.password })
  const mine = (await rep('POST', '/data/Projects/rows', { values: { Name: 'Rae\'s project' } })).row
  await rep('POST', '/data/Projects/delete', { ids: [mine.id] })
  await api('POST', '/data/Projects/delete', { ids: [p2.id] })
  const repList = await rep('GET', '/data/Projects/deleted')
  ok(repList.rows.length === 1 && repList.rows[0].id === mine.id, 'the restricted user lists only their own deleted row')
  const ctx2 = await browser.createBrowserContext()
  const repPage = await ctx2.newPage()
  await repPage.setViewport({ width: 1440, height: 900 })
  await login(repPage, REP)
  // end users have no portal data grid: their recycle bin is the app's own screen (DeletedRows, security-trimmed)
  await repPage.goto(`${BASE}/#run-${app.id}`, { waitUntil: 'networkidle0' })
  await waitText(repPage, /My recycle bin: 1 deleted/)
  await sleep(500)
  const repText = await text(repPage)
  ok(repText.includes('Rae\'s project') && !repText.includes('New website'), 'the restricted user\'s DeletedRows(Projects) hides the administrator\'s deleted row')
  await shot(repPage, 'recycle-app-bin-restricted.png')
  await ctx2.close()
  console.log('ALL CHECKS PASSED')
} catch (e) {
  await page.screenshot({ path: path.join(OUT, '_recycle-failure.png') }).catch(() => {})
  console.error(e)
  process.exitCode = 1
} finally {
  await browser.close()
}
