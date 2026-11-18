/**
 * Realtime end-to-end check and screenshots (package H). DEVELOPER TOOL, not part of the product.
 * Needs puppeteer-core (PUPPETEER_CORE, default /tmp/pgcheck/node_modules/puppeteer-core) and Chrome (CHROME_PATH).
 *
 * Start a server on an EMPTY sandbox database and workspace from the built app (npm run build first):
 *   APPBUILDER_DB_HOST=127.0.0.1 APPBUILDER_DB_PORT=5433 APPBUILDER_DB_NAME=appbuilder_test_live APPBUILDER_DB_USER=abdev \
 *   APPBUILDER_DB_PASSWORD=abdev-sandbox-only APPBUILDER_WORKSPACE=/tmp/ws-live PORT=5197 node server/main.ts
 * then:  SETUP_CODE=<printed code> node scripts/docs-shots/live.mjs
 *
 * Three browser contexts (three people): Ada (administrator), Bea (maker) and Raj (a role that sees only his own rows and
 * not the Email column). Checks: Bea's data table follows Ada's edit without a reload; Bea's form with unsaved edits gets
 * the conflict panel instead of being overwritten, and "Keep mine" saves; a notification from Ada reaches Bea's bell;
 * presence avatars; Raj's socket never carries a hidden column name or one of Ada's row ids; the Studio soft lock.
 * Fails with exit code 1 on the first broken check. Writes PNGs to docs/images/ (OUT).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const PUPPETEER_CORE = process.env.PUPPETEER_CORE || '/tmp/pgcheck/node_modules/puppeteer-core'
const { default: puppeteer } = await import(pathToFileURL(path.join(PUPPETEER_CORE, 'lib/puppeteer/puppeteer-core.js')).href)
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome'
const BASE = (process.env.BASE || 'http://localhost:5197').replace(/\/$/, '')
const OUT = process.env.OUT || path.join(root, 'docs', 'images')
const CODE = process.env.SETUP_CODE || ''
fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) failures++
}

async function api(cookie, method, p, body) {
  const headers = { 'X-Appbuilder': '1', ...(cookie ? { Cookie: cookie } : {}) }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(BASE + '/api/v1' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const set = res.headers.getSetCookie().find((c) => c.startsWith('ab_session='))
  const data = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : await res.text()
  return { status: res.status, data, cookie: set ? set.split(';')[0] : cookie }
}

/* ---------------------------------------------------------------- data via the API */
const PW = 'Example-Only-Pass-2026'
let r = await api('', 'POST', '/setup/admin', { name: 'Ada Admin', email: 'ada@example.test', password: PW, setupCode: CODE })
if (r.status !== 200) throw new Error(`setup: ${JSON.stringify(r.data)}`)
const adaCookie = r.cookie
const ws = (await api(adaCookie, 'GET', '/workspace')).data
const contacts = ws.tables.find((t) => t.name === 'Contacts')
const app = ws.apps[0]
const restricted = (await api(adaCookie, 'POST', '/roles', { name: 'Own contacts', apps: 'all', privileges: [{ table: contacts.id, create: true, read: 'own', update: 'own', delete: 'own', columns: { Email: 'none' } }] })).data
async function person(name, email, roleIds) {
  await api(adaCookie, 'POST', '/users', { name, email, roleIds, password: 'Temporary-Pass-1' })
  let c = (await api('', 'POST', '/auth/login', { email, password: 'Temporary-Pass-1' })).cookie
  c = (await api(c, 'POST', '/auth/password', { current: 'Temporary-Pass-1', next: PW })).cookie
  return c
}
await person('Bea Maker', 'bea@example.test', ['role_maker'])
await person('Raj Field', 'raj@example.test', [restricted.id])
const rows = (await api(adaCookie, 'POST', `/data/${contacts.name}/query`, { orderBy: [{ col: 'Name', dir: 'asc' }] })).data.rows
const target = rows[0]
const adaRowIds = rows.map((x) => x.id)

/* ---------------------------------------------------------------- browsers */
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'] })
async function signedIn(email) {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('appbuilder-theme', 'light') } catch { /* ignore */ }
  })
  page.on('pageerror', (e) => console.log(`  [${email} page error]`, e.message))
  const frames = []
  const cdp = await page.createCDPSession()
  await cdp.send('Network.enable')
  cdp.on('Network.webSocketFrameReceived', (e) => frames.push(e.response.payloadData))
  await page.goto(BASE + '/', { waitUntil: 'networkidle0' })
  await page.evaluate(async (e, p) => {
    await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'X-Appbuilder': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e, password: p }) })
  }, email, PW)
  return { page, frames }
}
const shot = async (page, name, clip) => {
  await page.screenshot({ path: path.join(OUT, name), ...(clip ? { clip } : {}) })
  console.log('  wrote', name)
}
const textOf = (page) => page.evaluate(() => document.body.innerText)
const waitText = async (page, needle, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if ((await textOf(page)).includes(needle)) return true
    await sleep(150)
  }
  return false
}

try {
  const A = await signedIn('ada@example.test')
  const B = await signedIn('bea@example.test')
  const R = await signedIn('raj@example.test')
  for (const p of [A, B, R]) {
    await p.page.goto(`${BASE}/#u-${app.id}`, { waitUntil: 'networkidle0' })
    await p.page.reload({ waitUntil: 'networkidle0' })
  }
  await sleep(1500)
  const liveOn = await B.page.evaluate(() => !document.querySelector('[data-testid="live-status"]'))
  check(liveOn, 'live connection open (no "live updates paused")')
  check(await waitText(B.page, target.Name), 'Bea sees the contacts table')

  // presence: Ada and Bea see each other on the running app
  const presence = await B.page.waitForSelector('[data-testid="app-live-bar"] [data-testid="presence-avatars"]', { timeout: 8000 }).then(() => true, () => false)
  check(presence, 'Bea sees presence avatars on the app')
  await shot(B.page, 'live-presence-app.png', { x: 900, y: 80, width: 540, height: 260 })

  // 1. Ada edits a row; Bea's table updates without a reload
  const newCity = `Pune ${Date.now() % 1000}`
  const navs = await B.page.evaluate(() => performance.getEntriesByType('navigation').length)
  const up = await api(adaCookie, 'PATCH', `/data/${contacts.name}/rows/${target.id}`, { changes: { City: newCity } })
  check(up.status === 200, 'Ada saved a change')
  check(await waitText(B.page, newCity), "Bea's data table shows Ada's change without a reload")
  check((await B.page.evaluate(() => performance.getEntriesByType('navigation').length)) === navs, 'no page reload happened')

  // 2. Bea edits the same record in the form; Ada saves meanwhile -> conflict panel, Keep mine saves
  await B.page.evaluate((name) => {
    const cell = [...document.querySelectorAll('[data-testid="tab-run-root"] td, [data-testid="tab-run-root"] [role="cell"], [data-testid="tab-run-root"] [role="gridcell"]')].find((el) => el.textContent?.trim() === name)
    cell?.click()
  }, target.Name)
  await sleep(600)
  const companyInput = await B.page.evaluateHandle(() => {
    const label = [...document.querySelectorAll('[data-testid="tab-run-root"] label')].find((l) => l.textContent?.trim().startsWith('Company'))
    return label ? document.getElementById(label.getAttribute('for')) : null
  })
  const hasInput = await B.page.evaluate((el) => !!el, companyInput)
  check(hasInput, 'Bea has the record open in the form')
  if (hasInput) {
    await companyInput.click()
    await companyInput.type('Bea Industries')
    await api(adaCookie, 'PATCH', `/data/${contacts.name}/rows/${target.id}`, { changes: { Company: 'Ada Holdings' } })
    const conflict = await B.page.waitForSelector('[data-testid="form-conflict"]', { timeout: 8000 }).then(() => true, () => false)
    check(conflict, 'Bea gets "This record was changed by ..." instead of losing her edit')
    const typed = await B.page.evaluate((el) => el.value, companyInput)
    check(typed.endsWith('Bea Industries'), "Bea's typed value is kept")
    check(await waitText(B.page, 'changed by Ada Admin'), 'the panel names Ada')
    await shot(B.page, 'live-form-conflict.png', { x: 560, y: 120, width: 880, height: 520 })
    await B.page.click('[data-testid="form-conflict-keep"]')
    await B.page.click('[data-testid="form-save"]')
    await sleep(1500)
    const after = (await api(adaCookie, 'POST', `/data/${contacts.name}/query`, { where: { col: 'id', op: 'eq', value: target.id } })).data.rows[0]
    check(after.Company === typed, 'Keep mine + Save stored Bea\'s value')
    // a stale save over the API answers 409
    const stale = await api(adaCookie, 'PATCH', `/data/${contacts.name}/rows/${target.id}`, { changes: { City: 'x' }, ifModifiedOn: target.modifiedOn })
    check(stale.status === 409, 'a stale save answers 409')
  }

  // 3. a notification from Ada appears on Bea's bell
  const sent = await api(adaCookie, 'POST', '/notifications/send', { to: 'bea@example.test', title: 'Please review the Pune contacts', body: 'Two new leads came in this morning.', link: `#u-${app.id}` })
  check(sent.status === 200, 'Ada sent a notification')
  const badge = await B.page.waitForSelector('[data-testid="notification-badge"]', { timeout: 8000 }).then(() => true, () => false)
  check(badge, "Bea's bell shows the unread badge")
  await B.page.click('[data-testid="notification-bell"]')
  const item = await B.page.waitForSelector('[data-testid="notification-item"]', { timeout: 8000 }).then(() => true, () => false)
  check(item && (await waitText(B.page, 'Please review the Pune contacts')), 'the notification is listed in the panel')
  await shot(B.page, 'live-notifications.png', { x: 840, y: 0, width: 600, height: 420 })
  await B.page.keyboard.press('Escape')

  // 4. Raj (own rows, Email hidden) never receives a hidden column name or Ada's row ids
  await api(adaCookie, 'PATCH', `/data/${contacts.name}/rows/${target.id}`, { changes: { Email: 'changed@example.test' } })
  await api(adaCookie, 'POST', `/data/${contacts.name}/rows`, { values: { Name: 'Zed Newrow', Email: 'zed@example.test' } })
  await sleep(1500)
  const rajTable = R.frames.filter((f) => f.includes('"t":"table"'))
  check(rajTable.length >= 2, `Raj received table ticks (${rajTable.length})`)
  check(R.frames.every((f) => !f.includes('"Email"') && !f.includes('changed@example.test')), 'no hidden column name or value on Raj\'s socket')
  check(R.frames.every((f) => adaRowIds.every((id) => !f.includes(id))), "no row id of Ada's rows on Raj's socket")
  check(B.frames.some((f) => f.includes(target.id)), 'Bea (all rows) does receive row ids (control check)')

  // 5. Studio soft lock: Ada edits, Bea opens read-only and may take over
  await B.page.waitForSelector('[data-testid="notification-toast"]', { hidden: true, timeout: 10000 }).catch(() => {})
  await A.page.goto(`${BASE}/#studio-${app.id}`, { waitUntil: 'networkidle0' })
  await A.page.waitForSelector('[data-testid="studio-root"]', { timeout: 10000 })
  await sleep(1500)
  await B.page.goto(`${BASE}/#studio-${app.id}`, { waitUntil: 'networkidle0' })
  const ro = await B.page.waitForSelector('[data-testid="studio-soft-locked"]', { timeout: 10000 }).then(() => true, () => false)
  check(ro, "Bea's Studio opens read-only while Ada edits")
  check(await B.page.evaluate(() => document.querySelector('[data-testid="studio-root"]')?.getAttribute('data-readonly') === 'true'), 'the canvas and properties are read-only')
  const people = await A.page.waitForSelector('[data-testid="studio-people"]', { timeout: 8000 }).then(() => true, () => false)
  check(people, "Ada's Studio shows Bea's avatar")
  await shot(B.page, 'live-studio-readonly.png', { x: 0, y: 0, width: 1440, height: 260 })
  await B.page.$eval('[data-testid="studio-take-over"]', (el) => el.click())
  const aRo = await A.page.waitForSelector('[data-testid="studio-soft-locked"]', { timeout: 8000 }).then(() => true, () => false)
  check(aRo, 'after the take-over Ada is read-only')
  if (!aRo) console.log('  Bea frames:', B.frames.filter((f) => f.includes('lock')).slice(-3).join('\n  '))
  if (!aRo) console.log('  Ada frames:', A.frames.filter((f) => f.includes('lock') || f.includes('studio')).slice(-6).join('\n  '))
  check(await waitText(A.page, 'took over editing'), 'Ada is told who took over')

  // 6. Settings > Notifications
  await B.page.goto(`${BASE}/#settings-notifications`, { waitUntil: 'networkidle0' })
  await B.page.waitForSelector('[data-testid="settings-notifications"]', { timeout: 8000 })
  await B.page.waitForSelector('[data-testid="notification-toast"]', { hidden: true, timeout: 10000 }).catch(() => {})
  await sleep(500)
  await shot(B.page, 'live-settings-notifications.png')
} catch (e) {
  console.error(e)
  failures++
} finally {
  await browser.close()
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed')
process.exit(failures ? 1 : 0)
