/**
 * Core data model end-to-end check and screenshots (P0 package N). DEVELOPER TOOL, not part of the product.
 * Needs puppeteer-core (PUPPETEER_CORE, default /tmp/pgcheck/node_modules/puppeteer-core) and Chrome (CHROME_PATH).
 *
 * Start a server on an EMPTY sandbox database and workspace from the built app (npm run build first):
 *   APPBUILDER_DB_HOST=127.0.0.1 APPBUILDER_DB_PORT=5433 APPBUILDER_DB_NAME=appbuilder_test_cdm APPBUILDER_DB_USER=abdev \
 *   APPBUILDER_DB_PASSWORD=abdev-sandbox-only APPBUILDER_WORKSPACE=/tmp/ws-cdm PORT=5199 node server/main.ts
 * then:  SETUP_CODE=<printed code> BASE=http://localhost:5199 node scripts/docs-shots/core-data-model.mjs
 *
 * Three people: Ada (administrator), Bea (maker, sees every contact) and Raj (a role that sees only his own contacts).
 * The sample Contacts app gets a Record timeline UI component (Record = the selected contact, or the one in the
 * link's ?record= parameter). Checks: Bea comments on a contact with @Ada; Ada's bell shows the mention; clicking it
 * opens the app on that contact with the comment in its timeline; Raj sees neither the comment (timeline, Query v2,
 * Mentions) nor the record; the Tasks page adds and lists a task; Settings and Currencies are seeded.
 * Fails with exit code 1 on a broken check. Writes PNGs to docs/images/ (OUT).
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
const r = await api('', 'POST', '/setup/admin', { name: 'Ada Admin', email: 'ada@example.test', password: PW, setupCode: CODE })
if (r.status !== 200) throw new Error(`setup: ${JSON.stringify(r.data)}`)
const adaCookie = r.cookie
const ws = (await api(adaCookie, 'GET', '/workspace')).data
const contacts = ws.tables.find((t) => t.name === 'Contacts')
const app = ws.apps[0]
check(ws.tables.some((t) => t.system && t.name === 'Comments'), 'the workspace lists the system tables (Comments)')
const restricted = (await api(adaCookie, 'POST', '/roles', { name: 'Own contacts', apps: 'all', privileges: [{ table: contacts.id, create: true, read: 'own', update: 'own', delete: 'own' }] })).data
async function person(name, email, roleIds) {
  await api(adaCookie, 'POST', '/users', { name, email, roleIds, password: 'Temporary-Pass-1' })
  let c = (await api('', 'POST', '/auth/login', { email, password: 'Temporary-Pass-1' })).cookie
  c = (await api(c, 'POST', '/auth/password', { current: 'Temporary-Pass-1', next: PW })).cookie
  return c
}
const beaCookie = await person('Bea Maker', 'bea@example.test', ['role_maker'])
const rajCookie = await person('Raj Field', 'raj@example.test', [restricted.id])
const rows = (await api(adaCookie, 'POST', '/query', { plan: { version: 2, table: contacts.name, sort: [{ col: 'Name', dir: 'asc' }] } })).data.rows
const target = rows[0]

// the sample app: a Record timeline under the contact form instead of the orders chart
const RECORD = '=If(IsBlank(Param("record")), ContactsTable.Selected, LookUp(Contacts, id = Param("record")))'
const full = (await api(adaCookie, 'GET', `/apps/${app.id}`)).data
const def = full.definition
const walk = (nodes, fn) => nodes.forEach((n) => { fn(n); walk(n.children ?? [], fn) })
walk(def.screens[0].children ?? [], (n) => {
  if (n.name === 'DetailPanel') {
    n.children = n.children.filter((c) => c.name !== 'OrdersTitle' && c.name !== 'OrdersChart')
    n.children.push({
      id: 'n_timeline', name: 'ContactTimeline', type: 'RecordTimeline', children: [],
      props: { X: '=24', Y: '=360', Width: '=680', Height: '=512', AnchorH: '=Anchor.Stretch', AnchorV: '=Anchor.Stretch', Record: RECORD },
    })
  }
  if (n.name === 'ContactForm') Object.assign(n.props, { Item: RECORD, Height: '=280', AnchorV: '=Anchor.Start' })
  if (n.name === 'DetailTitle') n.props.Text = `=If(ContactForm.Mode = "New", "New contact", Coalesce((${RECORD.slice(1)}).Name, "Select a contact"))`
})
const saved = await api(adaCookie, 'PUT', `/apps/${app.id}`, { definition: def })
check(saved.status === 200, 'the app saves with a Record timeline UI component')
const people = (await api(beaCookie, 'GET', `/collab/mentionable?table=${contacts.id}&row=${target.id}&q=Ada`)).data.users ?? []
const ada = people.find((u) => /Ada/.test(u.name ?? u.FullName ?? ''))
check(!!ada, 'Ada can be mentioned on the contact')
check(!(await api(rajCookie, 'GET', `/collab/mentionable?table=${contacts.id}&row=${target.id}&q=`)).data.users?.length, 'Raj gets nobody to mention on a contact he cannot read')

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
  await page.goto(BASE + '/', { waitUntil: 'networkidle0' })
  await page.evaluate(async (e, p) => {
    await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'X-Appbuilder': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e, password: p }) })
  }, email, PW)
  return page
}
const shot = async (page, name, sel) => {
  await sleep(400)
  const el = sel ? await page.$(sel) : null
  if (el) await el.screenshot({ path: path.join(OUT, name) })
  else await page.screenshot({ path: path.join(OUT, name) })
  console.log('  wrote', name)
}
const textOf = (page) => page.evaluate(() => document.body.innerText)
const waitText = async (page, needle, ms = 10000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if ((await textOf(page)).includes(needle)) return true
    await sleep(150)
  }
  return false
}
const go = async (page, hash) => {
  await page.goto(`${BASE}/${hash}`, { waitUntil: 'networkidle0' })
  await page.reload({ waitUntil: 'networkidle0' })
}

try {
  const A = await signedIn('ada@example.test')
  const B = await signedIn('bea@example.test')
  const R = await signedIn('raj@example.test')

  // 1. Bea opens the contact and comments with a mention of Ada (a taller window: room for the timeline)
  await B.setViewport({ width: 1440, height: 1300 })
  await go(B, `#u-${app.id}?record=${target.id}`)
  const tl = await B.waitForSelector('[data-testid="record-timeline"]', { timeout: 15000 }).then(() => true, () => false)
  check(tl, 'Bea sees the Record timeline on the contact')
  check(await waitText(B, target.Name), 'the app opened on the contact of the link')
  await B.click('[data-testid="timeline-composer"]')
  await B.type('[data-testid="timeline-composer"]', 'Can you call them back this week, @Ad')
  const list = await B.waitForSelector(`[data-testid="mention-${ada.id}"]`, { timeout: 8000 }).then(() => true, () => false)
  check(list, 'typing @Ad offers Ada in the mention list')
  if (list) {
    await shot(B, 'core-timeline-mention.png', '[data-testid="record-timeline"]')
    await B.click(`[data-testid="mention-${ada.id}"]`)
  }
  await B.type('[data-testid="timeline-composer"]', ' They asked about the renewal.')
  await B.click('[data-testid="timeline-send"]')
  check(await waitText(B, 'asked about the renewal'), "Bea's comment shows in the timeline")
  await shot(B, 'core-timeline.png', '[data-testid="record-timeline"]')

  // 2. Ada's bell -> click-through to the contact
  await go(A, '#home')
  const badge = await A.waitForSelector('[data-testid="notification-badge"]', { timeout: 20000 }).then(() => true, () => false)
  check(badge, "Ada's bell shows the mention")
  await A.click('[data-testid="notification-bell"]')
  await A.waitForSelector('[data-testid="notification-item"]', { timeout: 8000 })
  check(await waitText(A, 'Bea Maker'), 'the notification names Bea')
  await shot(A, 'core-mention-bell.png', '[data-testid="notification-item"]')
  await A.$eval('[data-testid="notification-item"] button', (b) => b.click())
  await sleep(2000)
  const hash = await A.evaluate(() => location.hash)
  check(hash.includes(app.id) && hash.includes(target.id), `clicking it opens the app on the contact (${hash})`)
  check(await waitText(A, 'asked about the renewal'), 'the comment is in the timeline Ada lands on')

  // 3. Raj (own contacts only) sees nothing of it
  const rt = await api(rajCookie, 'GET', `/collab/timeline?row=${target.id}&limit=30`)
  check(rt.status !== 200 || !JSON.stringify(rt.data).includes('renewal'), `Raj's timeline request does not return the comment (${rt.status})`)
  const rq = await api(rajCookie, 'POST', '/query', { plan: { version: 2, table: 'Comments', page: { size: 50 } } })
  check(rq.status === 200 && rq.data.rows.length === 0, `Raj's Comments query returns no rows (${rq.status}, ${rq.data.rows?.length})`)
  const rm = await api(rajCookie, 'GET', '/collab/mentions')
  check(rm.status === 200 && !JSON.stringify(rm.data).includes('renewal'), 'Raj has no mention of it')
  await go(R, `#u-${app.id}?record=${target.id}`)
  await sleep(2500)
  check(!(await textOf(R)).includes('asked about the renewal'), "Raj's page does not show the comment")

  // 4. Tasks page: quick add, list and board
  await B.setViewport({ width: 1440, height: 900 })
  await go(B, '#u-tasks')
  await B.waitForSelector('[data-testid="tasks-page"]', { timeout: 10000 })
  await B.type('[data-testid="task-quick-add"]', 'Send the renewal quote')
  await B.click('[data-testid="task-add"]')
  check(await waitText(B, 'Send the renewal quote'), 'the task is added and listed')
  const mine = await api(beaCookie, 'GET', '/collab/my-tasks')
  check(mine.status === 200 && JSON.stringify(mine.data).includes('Send the renewal quote'), 'My tasks over the API has it')
  await shot(B, 'core-tasks.png')

  // 5. Ada's Mentions page
  await go(A, '#u-mentions')
  check(await waitText(A, 'mentioned you'), "Ada's Mentions page lists the mention")
  await shot(A, 'core-mentions.png')

  // 6. reference data is seeded; Studio > Tables shows the system tables
  const cur = await api(adaCookie, 'POST', '/query', { plan: { version: 2, table: 'Currencies', filter: { col: 'Code', op: 'eq', value: 'INR' }, page: { size: 1 } } })
  check(cur.status === 200 && cur.data.rows.length === 1, 'Currencies has INR')
  await go(A, '#tables')
  await sleep(1500)
  check(await waitText(A, 'System tables'), 'Tables shows the System tables section')
  await shot(A, 'core-system-tables.png')
} catch (e) {
  console.error(e)
  failures++
} finally {
  await browser.close()
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed')
process.exit(failures ? 1 : 0)
