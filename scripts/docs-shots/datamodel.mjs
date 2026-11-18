/**
 * Headless check and screenshots of the data model designer (package K). DEVELOPER TOOL, not part of the product.
 *
 * Needs puppeteer-core (PUPPETEER_CORE, default /tmp/pgcheck/node_modules/puppeteer-core), Chrome (CHROME_PATH) and a
 * running server on an EMPTY sandbox database (built app: `npm run build` or `npx vite build` first):
 *   APPBUILDER_DB_HOST=127.0.0.1 APPBUILDER_DB_PORT=5433 APPBUILDER_DB_NAME=appbuilder_test_k_shots \
 *   APPBUILDER_DB_USER=abdev APPBUILDER_DB_PASSWORD=abdev-sandbox-only APPBUILDER_WORKSPACE=/tmp/ws-k PORT=5198 node server/main.ts
 * Run:  SETUP_CODE=<printed code> node scripts/docs-shots/datamodel.mjs
 *
 * What it does, in the browser as the administrator: creates two tables on the canvas, draws a relationship between
 * them (drag from the connector dot), reviews and applies the plan; generates the Master-detail pattern and applies it;
 * generates a star schema from its lines and applies it; exports PNG and DBML. Then, over the API, a restricted user
 * reads the fact view and sees only their own rows, without the hidden column. Writes PNGs to docs/images/ (OUT).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const PUPPETEER_CORE = process.env.PUPPETEER_CORE || '/tmp/pgcheck/node_modules/puppeteer-core'
const { default: puppeteer } = await import(pathToFileURL(path.join(PUPPETEER_CORE, 'lib/puppeteer/puppeteer-core.js')).href)
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome'
const BASE = (process.env.BASE || 'http://localhost:5198').replace(/\/$/, '')
const OUT = process.env.OUT || path.join(root, 'docs', 'images')
const ADMIN = { name: 'Test Admin', email: 'admin@example.test', password: 'Example-Only-Pass-2026' }
const REP = { name: 'Rae Rep', email: 'rep@example.test', password: 'Example-Only-Pass-2027' }
fs.mkdirSync(OUT, { recursive: true })
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-k-dl-'))

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

await api('POST', '/setup/admin', { setupCode: process.env.SETUP_CODE ?? '', ...ADMIN })

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--window-size=1440,900'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('appbuilder-theme', 'light') } catch { /* ignore */ } })
page.on('pageerror', (e) => console.log('  [page error]', e.message))
const cdp = await page.createCDPSession()
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
const shot = async (name) => { await sleep(500); await page.screenshot({ path: path.join(OUT, name) }); console.log(`shot ${name}`) }
const click = async (sel) => { await page.waitForSelector(sel, { visible: true, timeout: 15000 }); await page.click(sel) }
const type = async (sel, text) => {
  await page.waitForSelector(sel, { visible: true, timeout: 15000 })
  await page.click(sel)
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control')
  await page.keyboard.press('Backspace')
  await page.type(sel, text)
}
const center = async (sel) => {
  const el = await page.waitForSelector(sel, { timeout: 15000 })
  const b = await el.boundingBox()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b }
}
const pickOption = async (text) => {
  await page.waitForSelector('[role="option"]')
  await page.evaluate((t) => [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.trim().startsWith(t))?.click(), text)
  await sleep(300)
}
const applyDraft = async (shotName) => {
  await click('[data-testid="model-review-btn"]')
  await page.waitForSelector('[data-testid="model-plan"]', { timeout: 20000 })
  if (shotName) await shot(shotName)
  if (await page.$('[data-testid="model-plan-ack"]')) await click('[data-testid="model-plan-ack"]')
  await click('[data-testid="model-apply"]')
  await page.waitForFunction(() => !document.querySelector('[data-testid="model-review"]'), { timeout: 30000 })
  await page.waitForFunction(() => !document.querySelector('[data-testid="model-review-btn"]')?.textContent?.includes('('), { timeout: 30000 })
}

try {
  await page.goto(BASE + '/#home', { waitUntil: 'networkidle0' })
  await type('input[type=email]', ADMIN.email)
  await type('input[type=password]', ADMIN.password)
  await page.keyboard.press('Enter')
  await page.waitForSelector('[data-testid="nav-datamodel"]', { timeout: 20000 })
  await click('[data-testid="nav-datamodel"]')
  await page.waitForSelector('[data-testid="data-model"]', { timeout: 20000 })

  // 1. two tables on the canvas, a relationship drawn between them, applied
  for (const [name, cols] of [['Customer', 'Name, City'], ['Order', 'Ref, Notes']]) {
    await click('[data-testid="model-new-table-btn"]')
    await type('[data-testid="nt-name"]', name)
    await type('[data-testid="nt-columns"]', cols)
    await click('[data-testid="nt-create"]')
    await page.waitForSelector(`[data-testid="card-${name}"]`)
  }
  await click('[data-testid="model-autolayout"]')
  await click('[data-testid="model-fit"]')
  await sleep(400)
  const from = await center('[data-testid="connect-Order"]')
  const to = await center('[data-testid="card-Customer"]')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 })
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
  await page.waitForSelector('[data-testid="relationship-dialog"]')
  await click('[data-testid="rel-dialog-required"]')
  await shot('datamodel-relationship-dialog.png')
  await click('[data-testid="rel-create"]')
  await page.waitForSelector('[data-testid="rel-Order-Customer"]')
  await shot('datamodel-draft.png')
  await applyDraft('datamodel-review.png')
  const m1 = await api('GET', '/model')
  const order = m1.model.tables.find((t) => t.name === 'Order')
  ok(order?.columns.some((c) => c.name === 'Customer' && c.type === 'lookup' && c.required), 'Order.Customer is a required lookup after apply')
  ok(m1.model.relationships.some((r) => r.fromTable === order.id && r.onDelete === 'restrict'), 'the relationship is recorded with delete behaviour restrict')

  // 2. the Master-detail pattern
  await click('[data-testid="model-patterns-btn"]')
  await click('[data-testid="pattern-master-detail"]')
  await type('[data-testid="param-header"]', 'Invoice')
  await type('[data-testid="param-lines"]', 'Invoice line')
  await shot('datamodel-patterns.png')
  await click('[data-testid="pattern-add"]')
  await page.waitForSelector('[data-testid="card-InvoiceLine"]')
  await applyDraft()
  const m2 = await api('GET', '/model')
  const inv = m2.model.tables.find((t) => t.name === 'Invoice')
  const line = m2.model.tables.find((t) => t.name === 'InvoiceLine')
  ok(inv && line && m2.model.relationships.some((r) => r.fromTable === line.id && r.toTable === inv.id && r.onDelete === 'cascade'), 'Master-detail applied: lines cascade with their invoice')

  // 3. a star schema from the invoice lines
  await click('[data-testid="model-patterns-btn"]')
  await click('[data-testid="pattern-star-schema"]')
  await click('[data-testid="param-fact"]')
  await pickOption('Invoice line')
  await click('[data-testid="param-measures-Amount"]')
  await click('[data-testid="param-measures-Quantity"]')
  await click('[data-testid="param-dimensions-Invoice"]')
  await shot('datamodel-star-schema.png')
  await click('[data-testid="pattern-add"]')
  await page.waitForSelector('[data-testid="card-FactInvoiceLine"]')
  await applyDraft()
  await page.waitForSelector('[data-testid="card-DimInvoice"]')
  await click('[data-testid="model-autolayout"]')
  await click('[data-testid="model-fit"]')
  await sleep(300)
  const lineCard = await center('[data-testid="card-InvoiceLine"] [data-header]')
  await page.mouse.click(lineCard.x, lineCard.y)
  await shot('datamodel-canvas.png')
  await click('[data-testid="model-checks-tab"]')
  await shot('datamodel-checks.png')
  const views = await api('GET', '/model/views')
  ok(views.items.map((v) => v.name).sort().join(',') === 'DimInvoice,FactInvoiceLine', 'fact and dimension views are registered')

  // 4. exports
  await click('[data-testid="model-export-btn"]')
  await click('[data-testid="export-png"]')
  for (let i = 0; i < 40 && !fs.readdirSync(downloads).some((f) => f.endsWith('.png')); i++) await sleep(250)
  const png = fs.readdirSync(downloads).find((f) => f.endsWith('.png'))
  ok(png && fs.readFileSync(path.join(downloads, png)).subarray(1, 4).toString() === 'PNG', 'Export PNG downloads a PNG file')
  await click('[data-testid="model-export-btn"]')
  await click('[data-testid="export-dbml"]')
  await page.waitForSelector('[data-testid="export-text"]')
  const dbml = await page.$eval('[data-testid="export-text"]', (el) => el.value ?? el.textContent)
  ok(/Table InvoiceLine( \[[^\]]*\])? \{/.test(dbml) && /Ref: InvoiceLine\.Invoice > Invoice\.id \[delete: cascade\]/.test(dbml), 'Export DBML shows the tables and the cascade relationship')
  await page.keyboard.press('Escape')

  // 5. a restricted user reads the fact view: own rows only, hidden column absent
  const role = await api('POST', '/roles', { name: 'Rep', apps: 'all', privileges: [
    { table: inv.id, create: true, read: 'own', update: 'own', delete: 'none' },
    { table: line.id, create: true, read: 'own', update: 'own', delete: 'none', columns: { Amount: 'none' } },
  ] })
  await api('POST', '/users', { name: REP.name, email: REP.email, roleIds: [role.id], password: REP.password })
  const h1 = (await api('POST', `/data/${inv.id}/rows`, { values: {} })).row
  await api('POST', `/data/${line.id}/rows`, { values: { Invoice: h1.id, Item: 'Admin bolt', Quantity: 5, UnitPrice: 2 } })
  const rep = client()
  await rep('POST', '/auth/login', { email: REP.email, password: REP.password })
  // a password set by an administrator is temporary
  await rep('POST', '/auth/password', { current: REP.password, next: `${REP.password}-new` })
  const h2 = (await rep('POST', `/data/${inv.id}/rows`, { values: {} })).row
  await rep('POST', `/data/${line.id}/rows`, { values: { Invoice: h2.id, Item: 'Rep nut', Quantity: 3, UnitPrice: 4 } })
  await sleep(1500)
  const adminView = await api('POST', '/query', { plan: { version: 2, table: 'FactInvoiceLine', count: true } })
  const repView = await rep('POST', '/query', { plan: { version: 2, table: 'FactInvoiceLine', count: true } })
  ok(adminView.count === 2 && repView.count === 1, `restricted user sees 1 of 2 fact rows (admin ${adminView.count}, rep ${repView.count})`)
  ok(adminView.rows.some((r) => r.Amount === 10) && !('Amount' in repView.rows[0]), 'the Amount column, hidden for the rep in the lines, is absent from their view rows')
  const hidden = await rep('POST', '/query', { plan: { version: 2, table: 'FactInvoiceLine', select: ['Amount'] } }).then(() => 'allowed', (e) => String(e.message))
  ok(hidden.includes('403'), 'selecting the hidden column through the view is refused (403)')
  console.log('DONE: data model designer headless run passed')
} catch (e) {
  await page.screenshot({ path: path.join(os.tmpdir(), 'datamodel-failure.png') }).catch(() => {})
  console.error(e)
  process.exitCode = 1
} finally {
  await browser.close()
}
