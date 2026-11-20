/**
 * Headless check and screenshots of the Flows page (P1 package A). DEVELOPER TOOL, not part of the product.
 *
 * Needs puppeteer-core (PUPPETEER_CORE, default /tmp/pgcheck/node_modules/puppeteer-core), Chrome (CHROME_PATH) and a
 * running server on an EMPTY sandbox database (built app: `npm run build` first):
 *   APPBUILDER_DB_HOST=127.0.0.1 APPBUILDER_DB_PORT=5433 APPBUILDER_DB_NAME=appbuilder_test_a_shots \
 *   APPBUILDER_DB_USER=abdev APPBUILDER_DB_PASSWORD=abdev-sandbox-only APPBUILDER_WORKSPACE=/tmp/ws-a PORT=5198 node server/main.ts
 * Run:  SETUP_CODE=<printed code> BASE=http://localhost:5198 node scripts/docs-shots/flows.mjs
 *
 * What it does, in the browser as an administrator: creates a table-triggered flow from JSON on the Flows page (with a
 * validation round first), turns it on, adds a row through an app's form in a second tab, watches the run appear in the
 * flow's run history live (no reload), and opens the run detail with its steps. Writes PNGs to docs/images/ (OUT).
 */
import fs from 'node:fs'
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

await api('POST', '/setup/admin', { setupCode: process.env.SETUP_CODE ?? '', ...ADMIN })
await api('POST', '/tables', { displayName: 'Purchase requests', name: 'PurchaseRequests', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Amount', type: 'number' }, { displayName: 'Status', type: 'text' }] })
await api('POST', '/tables', { displayName: 'Request log', name: 'RequestLog', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Note', type: 'text' }] })
const app = await api('POST', '/apps', { name: 'Requests', width: 1280, height: 800 })
const full = await api('GET', `/apps/${app.id}`)
const def = full.definition
def.dataSources = ['PurchaseRequests']
def.screens[0].children.push({ id: 'n_form1', name: 'ReqForm', type: 'Form', props: { X: '=80', Y: '=80', Width: '=900', Height: '=420', DataSource: '="PurchaseRequests"', Mode: '=FormMode.New', Fields: '="Title,Amount"', OnSuccess: '=NewForm(ReqForm)' }, children: [] })
await api('PUT', `/apps/${app.id}`, { definition: def })

const FLOW = {
  name: 'Big purchase check', description: 'Marks large requests for review and logs them.', runAs: 'owner',
  trigger: { type: 'table', table: 'PurchaseRequests', on: ['create'], condition: 'Trigger.Record.Amount > 1000' },
  variables: [], settings: { concurrency: 'perRecord', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' },
  steps: [
    { id: 'msg', name: 'Message', kind: 'compose', value: '"Review " & Trigger.Record.Title & " (" & Text(Trigger.Record.Amount) & ")"' },
    { id: 'mark', name: 'Mark', kind: 'data.update', table: 'PurchaseRequests', rowId: 'Trigger.Record', values: { Status: '"Needs review"' } },
    { id: 'log', name: 'Log', kind: 'data.create', table: 'RequestLog', values: { Title: 'Trigger.Record.Title', Note: 'Steps.Message.Output' } },
    { id: 'tell', name: 'Tell', kind: 'notify', to: 'User()', title: 'Steps.Message.Output', body: '""', channels: ['inApp'] },
  ],
  connections: {},
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--window-size=1440,900'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
const shot = async (p, name) => { await sleep(400); await p.screenshot({ path: path.join(OUT, name) }); console.log(`shot ${name}`) }
const click = async (sel, p = page) => { await p.waitForSelector(sel, { visible: true, timeout: 15000 }); await p.click(sel) }
const type = async (sel, text, p = page) => { await p.waitForSelector(sel, { visible: true, timeout: 15000 }); await p.click(sel, { clickCount: 3 }); await p.type(sel, text) }
/** sets a React-controlled textarea's value */
const setText = (sel, text) => page.evaluate((s, t) => {
  const el = document.querySelector(s)
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(el, t)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}, sel, text)

try {
  await page.goto(BASE + '/#home', { waitUntil: 'networkidle0' })
  await type('input[type=email]', ADMIN.email)
  await type('input[type=password]', ADMIN.password)
  await page.keyboard.press('Enter')
  await page.waitForSelector('nav', { timeout: 20000 })

  // 1. the Flows page from the menu (a live module now)
  await page.goto(`${BASE}/#flows`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('[data-testid="flows-page"]', { timeout: 15000 })
  ok(true, 'Dev mode > Flows opens')
  await click('[data-testid="new-flow"]')
  await page.waitForSelector('[data-testid="flow-json"]')
  // a mistake first: the server names the step and the field
  const bad = structuredClone(FLOW)
  bad.steps[2].values.Nope = '1'
  await setText('[data-testid="flow-json"]', JSON.stringify(bad, null, 2))
  await click('[data-testid="flow-save"]')
  await page.waitForSelector('[data-testid="flow-problems"]', { timeout: 15000 })
  const problems = await page.$eval('[data-testid="flow-problems"]', (e) => e.innerText)
  ok(/step log · values\.Nope/.test(problems) && /no column "Nope"/.test(problems), `validation names step and field (${problems.trim().slice(0, 90)})`)
  await shot(page, 'flows-validation.png')
  await setText('[data-testid="flow-json"]', JSON.stringify(FLOW, null, 2))
  await click('[data-testid="flow-save"]')
  await page.waitForSelector('[data-testid="flow-detail"]', { timeout: 15000 })
  ok(true, 'the flow was created from JSON and opened')
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Turn on')?.click())
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Turn off'), { timeout: 15000 })
  ok(true, 'the flow is on')
  await click('[data-testid="tab-runs"]')
  await page.waitForFunction(() => document.body.innerText.includes('No runs yet'), { timeout: 15000 })

  // 2. a row added in an app (second tab)
  const appPage = await browser.newPage()
  await appPage.setViewport({ width: 1280, height: 800 })
  await appPage.goto(`${BASE}/#run-${app.id}`, { waitUntil: 'networkidle0' })
  await appPage.waitForSelector('label', { timeout: 20000 })
  await sleep(1500)
  const fill = async (label, value) => {
    const id = await appPage.evaluate((l) => [...document.querySelectorAll('label')].find((x) => x.textContent?.trim().startsWith(l))?.getAttribute('for'), label)
    if (!id) throw new Error(`no field ${label}`)
    await appPage.click(`[id="${id}"]`)
    await appPage.type(`[id="${id}"]`, value)
  }
  await fill('Title', 'Forklift')
  await fill('Amount', '25000')
  await appPage.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save')?.click())
  await sleep(500)

  // 3. the run appears in the history without a reload (live), and succeeds
  await page.bringToFront()
  await page.waitForSelector('[data-testid="run-row"]', { timeout: 20000 })
  ok(true, 'the run appeared in the run history live')
  await page.waitForFunction(() => document.querySelector('[data-testid="run-row"] [data-testid="run-status"]')?.textContent === 'succeeded', { timeout: 20000 })
  ok(true, 'the run succeeded (status updated live)')
  await shot(page, 'flows-run-history.png')
  await click('[data-testid="run-row"]')
  await page.waitForSelector('[data-testid="run-detail"]', { timeout: 15000 })
  const steps = await page.$$eval('[data-testid="run-step"]', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()))
  ok(steps.length === 4 && steps.every((s) => s.startsWith('succeeded')), `run detail shows 4 succeeded steps (${steps.map((s) => s.split(' ')[1]).join(', ')})`)
  await page.evaluate(() => [...document.querySelectorAll('[data-testid="run-step"] button')][2]?.click())
  await sleep(300)
  await shot(page, 'flows-run-detail.png')
  const rows = await api('POST', '/query', { plan: { version: 2, table: 'PurchaseRequests' } })
  ok(rows.rows.some((r) => r.Title === 'Forklift' && r.Status === 'Needs review'), 'the flow updated the row as its owner')
  // 4. the list with health
  await page.goto(`${BASE}/#flows`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('[data-testid="flow-row"]', { timeout: 15000 })
  const row = await page.$eval('[data-testid="flow-row"]', (e) => e.innerText)
  ok(/100 %/.test(row), `the list shows the flow's health (${row.replace(/\s+/g, ' ').slice(0, 80)})`)
  await shot(page, 'flows-list.png')
  console.log('ALL CHECKS PASSED')
} finally {
  await browser.close()
}
