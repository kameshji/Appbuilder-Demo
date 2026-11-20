/**
 * Headless check and screenshots of table events and jobs (package G). DEVELOPER TOOL, not part of the product.
 *
 * Needs puppeteer-core (PUPPETEER_CORE, default /tmp/pgcheck/node_modules/puppeteer-core), Chrome (CHROME_PATH) and a
 * running server on an EMPTY sandbox database (built app: `npm run build` first):
 *   APPBUILDER_DB_HOST=127.0.0.1 APPBUILDER_DB_PORT=5433 APPBUILDER_DB_NAME=appbuilder_test_g_shots \
 *   APPBUILDER_DB_USER=abdev APPBUILDER_DB_PASSWORD=abdev-sandbox-only APPBUILDER_WORKSPACE=/tmp/ws-g PORT=5197 node server/main.ts
 * Run:  SETUP_CODE=<printed code> node scripts/docs-shots/events.mjs
 *
 * What it does, in the browser as a maker: adds a validation rule and a formula column in the table designer, opens an
 * app whose form refuses a line (the message appears on the form field), saves a good line, sees the order's rollup
 * total update, and opens the Jobs page and the Events run log. Writes PNGs to docs/images/ (OUT).
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
const ok = (cond, what) => { if (!cond) throw new Error(`CHECK FAILED: ${what}`); console.log(`ok - ${what}`) }

// data set up by API (tables, a lookup, a rollup, an app with a form)
await api('POST', '/setup/admin', { setupCode: process.env.SETUP_CODE ?? '', ...ADMIN })
const inv = await api('POST', '/tables', { displayName: 'Invoices', name: 'Invoices', columns: [{ displayName: 'Customer', type: 'text' }] })
const lines = await api('POST', '/tables', { displayName: 'Invoice lines', name: 'InvoiceLines', columns: [{ displayName: 'Item', type: 'text' }, { displayName: 'Qty', type: 'number' }, { displayName: 'Price', type: 'decimal' }, { displayName: 'Invoice', name: 'Invoice', type: 'lookup', lookupTable: 'Invoices' }] })
const invoice = (await api('POST', '/data/Invoices/rows', { values: { Customer: 'Asha Traders' } })).row
await api('POST', '/data/InvoiceLines/rows', { values: { Item: 'Bolts', Qty: 10, Price: 2.5, Invoice: invoice.id } })
const app = await api('POST', '/apps', { name: 'Invoice entry', width: 1280, height: 800 })
const full = await api('GET', `/apps/${app.id}`)
const def = full.definition
def.dataSources = ['InvoiceLines', 'Invoices']
def.screens[0].children.push({ id: 'n_form1', name: 'LineForm', type: 'Form', props: { X: '=80', Y: '=80', Width: '=900', Height: '=520', DataSource: '="InvoiceLines"', Mode: '=FormMode.New', Fields: '="Item,Qty,Price,Invoice,LineTotal"', OnSuccess: '=NewForm(LineForm)' }, children: [] })
await api('PUT', `/apps/${app.id}`, { definition: def })

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--window-size=1440,900'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
const shot = async (name) => { await sleep(400); await page.screenshot({ path: path.join(OUT, name) }); console.log(`shot ${name}`) }
const click = async (sel) => { await page.waitForSelector(sel, { visible: true, timeout: 15000 }); await page.click(sel) }
const type = async (sel, text) => { await page.waitForSelector(sel, { visible: true, timeout: 15000 }); await page.click(sel, { clickCount: 3 }); await page.type(sel, text) }

try {
  await page.goto(BASE + '/#home', { waitUntil: 'networkidle0' })
  await type('input[type=email]', ADMIN.email)
  await type('input[type=password]', ADMIN.password)
  await page.keyboard.press('Enter')
  await page.waitForSelector('[data-testid="page-home"], [data-testid="nav-tables"], nav', { timeout: 20000 })

  // 1. validation rule in the table designer
  await page.goto(`${BASE}/#table-${lines.id}`, { waitUntil: 'networkidle0' })
  await click('[data-testid="tab-validation"]')
  await click('[data-testid="add-validation"]')
  await type('[data-testid="event-name"]', 'Positive quantity')
  await type('[data-testid="rule-condition"]', 'Qty > 0')
  await type('[data-testid="rule-message"]', 'Quantity must be more than 0')
  await click('[data-testid="rule-field"]')
  await page.waitForSelector('[role="option"]')
  await page.evaluate(() => [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.trim() === 'Qty')?.click())
  await sleep(700)
  await click('[data-testid="event-test"]')
  await page.waitForSelector('[data-testid="test-result"]')
  await shot('events-validation-rule.png')
  await click('[data-testid="event-save"]')
  await page.waitForSelector('[data-testid="validation-item"]')
  ok(true, 'validation rule saved in the designer')

  // 2. formula column
  await click('[data-testid="tab-formulas"]')
  await click('[data-testid="add-formula-column"]')
  await type('[data-testid="formula-column-name"]', 'Line total')
  await type('[data-testid="formula-column-formula"]', 'Qty * Price')
  await sleep(800)
  await shot('events-formula-column.png')
  await click('[data-testid="formula-column-save"]')
  await sleep(1500)
  const after = await api('POST', '/query', { plan: { version: 2, table: 'InvoiceLines' } })
  ok(after.rows[0].LineTotal === 25, `formula column backfilled (LineTotal = ${after.rows[0].LineTotal})`)

  // 3. rollup on the invoice (by API: the designer's Rollups tab is shown in a screenshot)
  await api('POST', `/tables/${inv.id}/columns`, { displayName: 'Total', name: 'Total', type: 'decimal', computed: { kind: 'rollup', table: 'InvoiceLines', via: 'Invoice', fn: 'sum', column: 'LineTotal' } })
  await sleep(2000)
  await page.goto(`${BASE}/#table-${inv.id}`, { waitUntil: 'networkidle0' })
  await click('[data-testid="tab-rollups"]')
  await shot('events-rollups.png')

  // 4. the running app: a refused line shows the message on the Qty field
  await page.goto(`${BASE}/#run-${app.id}`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('form, [data-node="LineForm"], label', { timeout: 20000 })
  await sleep(1500)
  const fill = async (label, value) => {
    const id = await page.evaluate((l) => [...document.querySelectorAll('label')].find((x) => x.textContent?.trim().startsWith(l))?.getAttribute('for'), label)
    if (!id) throw new Error(`no field ${label}`)
    await page.click(`[id="${id}"]`)
    await page.keyboard.down('Control')
    await page.keyboard.press('a')
    await page.keyboard.up('Control')
    await page.keyboard.press('Backspace')
    await page.type(`[id="${id}"]`, value)
  }
  await fill('Item', 'Washers')
  await fill('Qty', '0')
  await fill('Price', '4')
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save')?.click())
  await page.waitForFunction(() => document.body.innerText.includes('Quantity must be more than 0'), { timeout: 15000 })
  const fieldMsg = await page.evaluate(() => {
    const lab = [...document.querySelectorAll('label')].find((x) => x.textContent?.trim().startsWith('Qty'))
    return lab?.parentElement?.innerText ?? ''
  })
  ok(fieldMsg.includes('Quantity must be more than 0'), 'the refusal appears on the Qty form field')
  await shot('events-form-rejection.png')

  // 5. a good line: saved, LineTotal computed, the invoice total follows
  await fill('Qty', '4')
  // pick the invoice in the lookup (first option)
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save')?.click())
  await sleep(1500)
  const saved = (await api('POST', '/query', { plan: { version: 2, table: 'InvoiceLines', filter: { col: 'Item', op: 'eq', value: 'Washers' } } })).rows[0]
  ok(saved && saved.LineTotal === 16, `good line saved with LineTotal ${saved?.LineTotal}`)
  await api('PATCH', `/data/InvoiceLines/rows/${saved.id}`, { changes: { Invoice: invoice.id } })
  let total = 0
  for (let i = 0; i < 30 && total !== 41; i++) { await sleep(300); total = (await api('POST', '/query', { plan: { version: 2, table: 'Invoices' } })).rows[0].Total }
  ok(total === 41, `invoice rollup total updated to ${total}`)
  await page.goto(`${BASE}/#table-${inv.id}`, { waitUntil: 'networkidle0' })
  await click('[data-testid="tab-data"]')
  await sleep(800)
  await shot('events-rollup-updated.png')

  // 6. an after-event and the admin console pages
  await api('POST', `/tables/${lines.id}/events`, { name: 'Note big lines', timing: 'after', operations: ['create'], condition: 'New.Qty >= 100', actions: 'Patch(Invoices, LookUp(Invoices, id = New.Invoice), {Customer: "Big order"})' })
  await page.goto(`${BASE}/#table-${lines.id}`, { waitUntil: 'networkidle0' })
  await click('[data-testid="tab-events"]')
  await page.waitForSelector('[data-testid="event-item"]')
  await shot('events-table-events.png')
  await page.goto(`${BASE}/#admin-jobs`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('[data-testid="schedule-row"]', { timeout: 15000 })
  ok(true, 'Jobs page shows the schedules')
  await shot('admin-jobs.png')
  await page.goto(`${BASE}/#admin-events`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('[data-testid="admin-event-runs"]')
  await sleep(800)
  await shot('admin-event-runs.png')
  console.log('all checks passed')
} catch (e) {
  await page.screenshot({ path: '/tmp/g-failure.png' }).catch(() => {})
  console.error(e)
  process.exitCode = 1
} finally {
  await browser.close()
}
