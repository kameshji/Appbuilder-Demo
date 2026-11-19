/**
 * Headless check and screenshots of connector actions, notification delivery and scheduled reports (P1 package D).
 * DEVELOPER TOOL, not part of the product.
 *
 * Needs puppeteer-core (PUPPETEER_CORE, default /tmp/pgcheck/node_modules/puppeteer-core), Chrome (CHROME_PATH), the
 * built app (`npx vite build`) and a running server on an EMPTY sandbox database:
 *   APPBUILDER_DB_HOST=127.0.0.1 APPBUILDER_DB_PORT=5433 APPBUILDER_DB_NAME=appbuilder_test_d_shots \
 *   APPBUILDER_DB_USER=abdev APPBUILDER_DB_PASSWORD=abdev-sandbox-only APPBUILDER_WORKSPACE=/tmp/ws-d \
 *   APPBUILDER_SETUP_CODE_FILE=/tmp/ws-d/setup-code.txt PORT=5198 node server/main.ts
 * Run:  SETUP_CODE_FILE=/tmp/ws-d/setup-code.txt BASE=http://localhost:5198 node scripts/docs-shots/actions.mjs
 *
 * What it does: starts a fake SMTP server and a fake REST API in this process; as the administrator in the browser it
 * creates an HTTP connection to the fake API (the form), defines a custom action with the form and tests it, imports a
 * small OpenAPI document, looks at Access and Activity; sets "From apps" notifications to email in Settings and reads
 * the email from the fake inbox; creates a scheduled report with the builder, sends it now and reads the email with its
 * CSV attachment. Writes PNGs to docs/images/ (OUT).
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const PUPPETEER_CORE = process.env.PUPPETEER_CORE || '/tmp/pgcheck/node_modules/puppeteer-core'
const { default: puppeteer } = await import(pathToFileURL(path.join(PUPPETEER_CORE, 'lib/puppeteer/puppeteer-core.js')).href)
const { startFakeSmtp } = await import(pathToFileURL(path.join(root, 'server/core/identity/fake-smtp.ts')).href)
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome'
const BASE = (process.env.BASE || 'http://localhost:5198').replace(/\/$/, '')
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

// fake SMTP and a fake REST API (customers, orders) in this process
const smtp = await startFakeSmtp()
const apiHits = []
const fake = http.createServer((req, res) => {
  let b = ''
  req.on('data', (c) => (b += c))
  req.on('end', () => {
    apiHits.push({ method: req.method, url: req.url, key: req.headers['x-api-key'] })
    const json = (s, v) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)) }
    if (req.headers['x-api-key'] !== 'demo-key-123456') return json(401, { error: 'bad key' })
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/v1' || u.pathname === '/v1/') return json(200, { service: 'Acme ERP' })
    const m = /^\/v1\/customers\/([^/]+)$/.exec(u.pathname)
    if (m) return json(200, { data: { id: decodeURIComponent(m[1]), name: 'Asha Traders', city: 'Bhopal', creditLimit: 250000 } })
    if (u.pathname === '/v1/orders' && req.method === 'POST') return json(201, { id: 'SO-1001', status: 'created', received: JSON.parse(b || '{}') })
    json(404, { error: 'not found' })
  })
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
const FAKE = `http://127.0.0.1:${fake.address().port}`

const setupCode = process.env.SETUP_CODE ?? (process.env.SETUP_CODE_FILE ? fs.readFileSync(process.env.SETUP_CODE_FILE, 'utf8').split('\n')[0].trim() : '')
await api('POST', '/setup/admin', { setupCode, ...ADMIN })
await api('PUT', '/identity/email', { host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'apps@example.test', installName: 'Acme Apps', publicUrl: BASE })
await api('POST', '/tables', { displayName: 'Sales orders', name: 'SalesOrders', columns: [{ displayName: 'Customer', type: 'text' }, { displayName: 'Amount', type: 'number' }, { displayName: 'Status', type: 'choice', choices: ['Open', 'Shipped'] }] })
for (const [c, a, s] of [['Asha Traders', 12000, 'Open'], ['Bharat Tools', 54000, 'Open'], ['Chandra Steel', 8000, 'Shipped'], ['Deccan Parts', 31000, 'Open']]) await api('POST', '/data/SalesOrders/rows', { values: { Customer: c, Amount: a, Status: s } })
const waitMail = async (pred, what) => {
  for (let i = 0; i < 100; i++) {
    const m = smtp.inbox.find(pred)
    if (m) return m
    await sleep(200)
  }
  throw new Error(`no email: ${what}; inbox ${smtp.inbox.map((m) => m.subject).join(' | ')}`)
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--window-size=1440,900'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
const shot = async (name) => { await sleep(400); await page.screenshot({ path: path.join(OUT, name) }); console.log(`shot ${name}`) }
const click = async (sel) => { await page.waitForSelector(sel, { visible: true, timeout: 15000 }); await page.click(sel) }
const type = async (sel, text) => { await page.waitForSelector(sel, { visible: true, timeout: 15000 }); await page.click(sel, { clickCount: 3 }); await page.type(sel, text) }
const select = async (sel, value) => { await page.waitForSelector(sel, { visible: true }); await page.select(sel, value) }

try {
  await page.goto(BASE + '/#home', { waitUntil: 'networkidle0' })
  await type('input[type=email]', ADMIN.email)
  await type('input[type=password]', ADMIN.password)
  await page.keyboard.press('Enter')
  await page.waitForSelector('nav', { timeout: 20000 })

  // 1. an HTTP connection to the fake API, through the form
  await page.goto(`${BASE}/#connections`, { waitUntil: 'networkidle0' })
  await click('[data-testid="new-connection-button"]')
  await click('[data-testid="connector-http"]')
  await type('[data-testid="connection-name"]', 'Acme ERP')
  await type('[data-testid="http-base-url"]', `${FAKE}/v1`)
  await select('[data-testid="http-auth-mode"]', 'apiKey')
  await type('[data-testid="http-key-name"]', 'X-Api-Key')
  await type('[data-testid="http-api-key"]', 'demo-key-123456')
  await click('[data-testid="http-allow-private"]')
  await shot('actions-http-connection.png')
  await click('[data-testid="connection-save"]')
  await sleep(1500)
  const conns = (await api('GET', '/workspace')).connections
  const conn = conns.find((c) => c.name === 'Acme ERP')
  ok(conn && conn.status === 'connected', `HTTP connection created and tested (${conn?.status} ${conn?.lastError ?? ''})`)
  ok(!JSON.stringify(conns).includes('demo-key-123456'), 'the API key never comes back')

  // 2. a custom action defined with the form, then tested
  await click(`[data-testid="details-${conn.id}"]`)
  await click('[data-testid="tab-actions"]')
  await click('[data-testid="new-custom-action"]')
  await type('[data-testid="custom-id"]', 'getCustomer')
  await type('[data-testid="custom-title"]', 'Get a customer')
  await type('[data-testid="custom-path"]', '/customers/{{id}}')
  await click('[data-testid="custom-add-input"]')
  await page.type('[data-testid="custom-input-0"] input[aria-label="Input name"]', 'id')
  await page.select('[data-testid="custom-input-0"] select[aria-label="Sent in"]', 'path')
  await page.click('[data-testid="custom-input-0"] input[type=checkbox]')
  await type('[data-testid="custom-output-path"]', 'data')
  await type('[data-testid="custom-sample"]', '{"data": {"id": "C-1", "name": "Asha Traders", "city": "Bhopal", "creditLimit": 250000}}')
  await shot('actions-custom-action-form.png')
  await click('[data-testid="custom-save"]')
  await page.waitForSelector('[data-testid="action-getCustomer"]')
  await click('[data-testid="test-action-getCustomer"]')
  await type('[data-testid="test-action-form"] [data-testid="input-id"]', 'C-1')
  await click('[data-testid="run-test-action"]')
  await page.waitForSelector('[data-testid="test-action-result"]')
  const res = await page.$eval('[data-testid="test-action-result"]', (e) => e.textContent)
  ok(res.includes('Succeeded') && res.includes('Asha Traders'), 'custom action tested from the generated form')
  await shot('actions-test-action.png')

  // 3. OpenAPI import (a small document pasted)
  const spec = JSON.stringify({ openapi: '3.0.3', info: { title: 'Acme ERP orders', version: '1' }, paths: { '/orders': { post: { operationId: 'createOrder', summary: 'Create a sales order', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['customer', 'amount'], properties: { customer: { type: 'string' }, amount: { type: 'number' } } } } } }, responses: { 201: { content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } } } } } } } } } } }, null, 2)
  await click('[data-testid="import-openapi"]')
  await page.waitForSelector('[data-testid="openapi-text"]')
  await page.$eval('[data-testid="openapi-text"]', (el, v) => { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }, spec)
  await click('[data-testid="openapi-preview"]')
  await page.waitForSelector('[data-testid="openapi-preview-list"]')
  await shot('actions-openapi-import.png')
  await click('[data-testid="openapi-apply"]')
  await page.waitForSelector('[data-testid="action-createOrder"]')
  ok(true, 'OpenAPI document imported (createOrder)')
  const r = await api('POST', `/connections/${conn.id}/actions/createOrder/test`, { inputs: { body: { customer: 'Asha Traders', amount: 12000 } } })
  ok(r.ok && r.output.id === 'SO-1001', 'imported action runs against the fake API')
  await click('[data-testid="tab-access"]')
  await page.waitForSelector('[data-testid="access-tab"]')
  await shot('actions-access.png')
  await click('[data-testid="tab-activity"]')
  await page.waitForSelector('[data-testid="activity-tab"]')
  await shot('actions-activity.png')
  await page.keyboard.press('Escape')

  // 4. notification preferences: "From apps" by email right away, then a notification arrives by email
  await page.goto(`${BASE}/#settings-notifications`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('[data-testid="notification-channels"]', { timeout: 20000 })
  await select('[data-testid="channel-email-app"]', 'immediate')
  await sleep(800)
  await shot('notifications-channels.png')
  const me = (await api('GET', '/workspace')).users.find((u) => u.email === ADMIN.email)
  await api('POST', '/notifications/send', { to: me.id, title: 'Order SO-1001 needs a look', body: 'Credit limit almost reached.', link: '#u-tasks' })
  const nm = await waitMail((m) => m.subject.includes('Order SO-1001 needs a look'), 'notification email')
  ok(nm.html.includes(`${BASE}/#u-tasks`) && /unsubscribe/i.test(nm.headers['list-unsubscribe'] ?? ''), 'notification email with a deep link and an unsubscribe link')

  // 5. a scheduled report built with the builder, sent now
  await page.goto(`${BASE}/#reports`, { waitUntil: 'networkidle0' })
  await click('[data-testid="new-report"]')
  await type('[data-testid="report-name"]', 'Open orders')
  const tid = (await api('GET', '/workspace')).tables.find((t) => t.name === 'SalesOrders').id
  await select('[data-testid="report-table"]', tid)
  await click('[data-testid="report-col-Customer"]')
  await click('[data-testid="report-col-Amount"]')
  await click('[data-testid="report-add-filter"]')
  await page.select('[data-testid="report-filter-0"] select[aria-label="Column"]', 'Status')
  await page.type('[data-testid="report-filter-0"] input[aria-label="Value"]', 'Open')
  await select('[data-testid="report-sort"]', 'Amount')
  await page.select('select[aria-label="Direction"]', 'desc')
  await click('[data-testid="report-preview"]')
  await page.waitForSelector('[data-testid="report-preview-table"]')
  await shot('reports-builder.png')
  await click('[data-testid="report-save"]')
  await page.waitForSelector('[data-testid="report-list"]')
  const rep = (await api('GET', '/reports')).items.find((x) => x.name === 'Open orders')
  await click(`[data-testid="run-report-${rep.id}"]`)
  const rm = await waitMail((m) => m.subject.includes('Open orders'), 'report email')
  const csv = rm.attachments.find((a) => a.fileName.endsWith('.csv'))?.content.toString('utf8') ?? ''
  ok(csv.includes('Bharat Tools') && !csv.includes('Chandra Steel'), 'report email with the filtered rows in the CSV attachment')
  ok(rm.html.indexOf('Bharat Tools') < rm.html.indexOf('Deccan Parts'), 'report sorted by amount, descending')
  await sleep(1500)
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForSelector('[data-testid="report-list"]')
  await shot('reports-list.png')
  console.log('ALL CHECKS PASSED')
} catch (e) {
  await page.screenshot({ path: path.join(OUT, 'actions-failure.png') }).catch(() => {})
  console.error(e)
  process.exitCode = 1
} finally {
  await browser.close()
  await smtp.close()
  fake.close()
}
