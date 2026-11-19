/**
 * Screenshots of the visual flow designer for docs/guide/maker/flows.md (P1 package B). DEVELOPER TOOL, not part of
 * the product.
 *
 * Needs puppeteer-core (PUPPETEER_CORE, default /tmp/pgcheck/node_modules/puppeteer-core), Chrome (CHROME_PATH) and a
 * running server on an EMPTY sandbox database (built app: `npm run build` first):
 *   APPBUILDER_DB_HOST=127.0.0.1 APPBUILDER_DB_PORT=5433 APPBUILDER_DB_NAME=appbuilder_test_b_shots \
 *   APPBUILDER_DB_USER=abdev APPBUILDER_DB_PASSWORD=abdev-sandbox-only APPBUILDER_WORKSPACE=/tmp/ws-b PORT=5291 node server/main.ts
 * Run:  SETUP_CODE=<printed code> BASE=http://localhost:5291 node scripts/docs-shots/flow-designer.mjs
 *
 * Creates two tables, a few people, the purchase approval flow from its template and a daily summary flow (through the
 * API), then opens the designer and captures: the gallery, the canvas, the step picker, a data step with the field
 * mapping, dynamic content, the filter builder, the schedule builder, the webhook panel, the test dialog, a test run on
 * the canvas and the version history. Writes PNGs to docs/images/ (OUT).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const PUPPETEER_CORE = process.env.PUPPETEER_CORE || '/tmp/pgcheck/node_modules/puppeteer-core'
const { default: puppeteer } = await import(pathToFileURL(path.join(PUPPETEER_CORE, 'lib/puppeteer/puppeteer-core.js')).href)
const { instantiate, guessParams } = await import(pathToFileURL(path.join(root, 'src/flows/designer/templateKit.ts')).href)
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome'
const BASE = (process.env.BASE || 'http://localhost:5291').replace(/\/$/, '')
const OUT = process.env.OUT || path.join(root, 'docs', 'images')
const ADMIN = { name: 'Test Admin', email: 'admin@example.test', password: 'Example-Only-Pass-2026' }
fs.mkdirSync(OUT, { recursive: true })

let cookie = ''
async function api(method, p, body) {
  const res = await fetch(BASE + '/api/v1' + p, { method, headers: { 'X-Appbuilder': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  for (const c of res.headers.getSetCookie?.() ?? []) { const [pair] = c.split(';'); if (pair.startsWith('ab_session=')) cookie = pair }
  const data = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : await res.text()
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(data)}`)
  return data
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const T = (id) => `[data-testid="${id}"]`

await api('POST', '/setup/admin', { setupCode: process.env.SETUP_CODE ?? '', ...ADMIN })
await api('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password })
await api('POST', '/tables', { displayName: 'Purchase requests', name: 'PurchaseRequests', columns: [{ displayName: 'Title', type: 'text', required: true }, { displayName: 'Amount', type: 'number' }, { displayName: 'Requester', type: 'email' }, { displayName: 'Manager', type: 'email' }, { displayName: 'Status', type: 'choice', choices: ['New', 'Approved', 'Rejected', 'Escalated'] }, { displayName: 'Needed by', name: 'NeededBy', type: 'date' }] })
await api('POST', '/tables', { displayName: 'Request log', name: 'RequestLog', columns: [{ displayName: 'Title', type: 'text', required: true }, { displayName: 'Note', type: 'text' }] })
for (const [name, email] of [['Mona Manager', 'mona@example.com'], ['Dev Director', 'dev@example.com'], ['Rae Requester', 'rae@example.com']]) await api('POST', '/users', { name, email, roleIds: ['role_maker'], password: 'some-password-1' })
const tables = (await api('GET', '/workspace')).tables.filter((t) => !t.system)
const tpl = (id) => JSON.parse(fs.readFileSync(path.join(root, 'src/flows/templates', `${id}.json`), 'utf8'))
const pa = tpl('purchase-approval')
const flow = (await api('POST', '/flows', { ...instantiate(pa, guessParams(pa, tables, { table: 'PurchaseRequests' })), name: 'Purchase approval' })).flow
const ds = tpl('daily-summary-email')
const daily = (await api('POST', '/flows', { ...instantiate(ds, guessParams(ds, tables, { table: 'PurchaseRequests', timeZone: 'Asia/Kolkata', recipient: 'team@example.com' })), name: 'Daily summary of requests' })).flow
await api('POST', '/flows', { name: 'Requests from the shop', runAs: 'owner', trigger: { type: 'webhook', sample: { title: 'Paper', amount: 40 } }, settings: { concurrency: 'parallel', timeoutMinutes: 10, retentionDays: 30, onError: 'fail' }, steps: [{ id: 'add', name: 'AddRequest', kind: 'data.create', table: 'PurchaseRequests', values: { Title: 'Trigger.Body.title', Amount: 'Trigger.Body.amount' } }] })
for (const [Title, Amount] of [['Chairs', 5000], ['Server', 50000]]) await api('POST', '/data/PurchaseRequests/rows', { values: { Title, Amount, Requester: 'rae@example.com', Manager: 'mona@example.com', Status: 'New' } })

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--window-size=1440,900'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
page.on('dialog', (d) => d.accept())
const shot = async (name) => { await sleep(500); await page.screenshot({ path: path.join(OUT, name) }); console.log(`shot ${name}`) }
const click = async (sel) => { await page.waitForSelector(sel, { visible: true, timeout: 15000 }); await page.click(sel) }
const domClick = async (sel) => { await page.waitForSelector(sel, { timeout: 15000 }); await page.$eval(sel, (e) => e.click()) }
try {
  await page.goto(`${BASE}/#home`, { waitUntil: 'networkidle0' })
  await page.type('input[type=email]', ADMIN.email)
  await page.type('input[type=password]', ADMIN.password)
  await page.keyboard.press('Enter')
  await page.waitForSelector('nav', { timeout: 20000 })
  await page.goto(`${BASE}/#flows`, { waitUntil: 'networkidle0' })
  await click(T('new-flow'))
  await page.waitForSelector(T('new-flow-gallery'), { visible: true })
  await shot('flow-designer-gallery.png')
  await page.keyboard.press('Escape')
  await page.goto(`${BASE}/#flow-${flow.id}`, { waitUntil: 'networkidle0' })
  await page.waitForSelector(T('flow-canvas'), { visible: true, timeout: 20000 })
  await sleep(800)
  await shot('flow-designer-canvas.png')
  await domClick(T('insert-top-steps-6'))
  await page.waitForSelector(T('step-picker'), { visible: true })
  await shot('flow-designer-picker.png')
  await click(T('pick-data.create'))
  await page.waitForSelector(T('step-panel'), { visible: true })
  await page.select(T('f-table'), 'RequestLog')
  await sleep(300)
  await page.select(T('add-field-select'), 'Note')
  await sleep(100)
  await click(T('add-field'))
  await sleep(200)
  await page.$eval(`[data-field="values.Title"] ${T('dynamic-content')}`, (e) => e.click())
  await page.waitForSelector(T('dynamic-list'), { visible: true })
  await shot('flow-designer-dynamic-content.png')
  await click(`${T('dynamic-item')}[data-insert="Trigger.Record.Title"]`)
  await sleep(300)
  await shot('flow-designer-mapping.png')
  // a filter builder on the daily summary
  await page.goto(`${BASE}/#flow-${daily.id}`, { waitUntil: 'networkidle0' })
  await page.waitForSelector(T('flow-canvas'), { visible: true, timeout: 20000 })
  await sleep(600)
  await domClick(T('trigger-card'))
  await page.waitForSelector(T('schedule-preview'), { visible: true })
  await sleep(800)
  await shot('flow-designer-schedule.png')
  await page.focus(T('flow-canvas'))
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.waitForSelector(T('filter-builder'), { visible: true })
  await click(T('add-rule'))
  await sleep(200)
  const rules = await page.$$(T('rule-column'))
  await rules[rules.length - 1].select('Status')
  const vals = await page.$$(T('rule-value'))
  await vals[vals.length - 1].click()
  await page.keyboard.type('"New"')
  await page.keyboard.press('Escape')
  await sleep(600)
  await shot('flow-designer-filter.png')
  // the test dialog and a test run on the canvas (the step added above stays an unpublished draft: dropped first)
  await api('DELETE', `/flows/${flow.id}/draft`)
  await page.goto(`${BASE}/#flow-${flow.id}`, { waitUntil: 'networkidle0' })
  await page.waitForSelector(T('flow-canvas'), { visible: true, timeout: 20000 })
  await click(T('designer-test'))
  await page.waitForSelector(T('test-dialog'), { visible: true })
  await sleep(800)
  await page.$eval(T('test-row'), (s) => { const o = s.querySelector('option'); if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })) } })
  await shot('flow-designer-test.png')
  await click(T('test-start'))
  await page.waitForSelector(T('run-banner'), { visible: true, timeout: 20000 })
  await page.waitForFunction(() => document.querySelector('[data-testid="step-Tell"]')?.getAttribute('data-status') === 'succeeded', { timeout: 30000 }).catch(() => undefined)
  await shot('flow-designer-run.png')
  await click(T('tab-versions'))
  await page.waitForSelector(T('version-history'), { visible: true })
  await shot('flow-designer-versions.png')
  // the web request trigger
  const hooks = (await api('GET', '/flows')).items.find((f) => f.name === 'Requests from the shop')
  await page.goto(`${BASE}/#flow-${hooks.id}`, { waitUntil: 'networkidle0' })
  await page.waitForSelector(T('flow-canvas'), { visible: true, timeout: 20000 })
  await domClick(T('trigger-card'))
  await click(T('webhook-create'))
  await page.waitForSelector(T('webhook-secret-once'), { visible: true })
  await page.$$eval('[data-testid="webhook-url"], [data-testid="webhook-secret"]', (els) => els.forEach((e) => { e.value = e.value.slice(0, 48) + '…' }))
  await shot('flow-designer-webhook.png')
  console.log('DONE')
} finally {
  await browser.close()
}
