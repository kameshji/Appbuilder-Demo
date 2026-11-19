/**
 * Screenshots of the Phase 1 close (package E) and the retake of the User mode picture. DEVELOPER TOOL, not part of the
 * product. Starts its own server in this process on an EMPTY sandbox database (created and dropped here), so no setup
 * code or second server is needed. Needs the built app (`npm run build`), puppeteer-core (PUPPETEER_CORE, default
 * /tmp/pgcheck/node_modules/puppeteer-core) and Chrome (CHROME_PATH).
 *
 *   node scripts/docs-shots/p1-close.mjs
 *
 * Writes to docs/images/ (OUT): user-mode-tabs.png (My apps with two app tabs), admin-flows.png (Admin console > Flows),
 * approvals-policy-editor.png (the visual policy editor: stages, a threshold rule, answers), solutions-deploy-mapping.png
 * (the Deploy dialog asking for the target connection and a person), admin-health-alerts.png (health email and heartbeat).
 * Settings: SHOT_DB_* like the exit checks (database appbuilder_test_p1_shots), SHOT_PORT (5266).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const DB = { host: E.SHOT_DB_HOST || '127.0.0.1', port: Number(E.SHOT_DB_PORT || 5433), user: E.SHOT_DB_USER || 'abdev', password: E.SHOT_DB_PASSWORD || 'abdev-sandbox-only', database: E.SHOT_DB_NAME || 'appbuilder_test_p1_shots' }
const MAINT = E.SHOT_MAINT_DB || 'appbuilder_test'
const PORT = Number(E.SHOT_PORT || 5266)
const BASE = `http://127.0.0.1:${PORT}`
const OUT = E.OUT || path.join(root, 'docs', 'images')
const ADMIN = { name: 'Test Admin', email: 'admin@example.test', password: 'Example-Only-Pass-2026' }
if (!/^appbuilder_test_/.test(DB.database)) { console.error('The database name must start with appbuilder_test_ (it is dropped).'); process.exit(2) }

const { createApp } = await import(pathToFileURL(path.join(root, 'server/core/app.ts')).href)
const { serveStatic } = await import(pathToFileURL(path.join(root, 'server/core/static.ts')).href)
const { setQuiet } = await import(pathToFileURL(path.join(root, 'server/core/util.ts')).href)
const { default: puppeteer } = await import(pathToFileURL(path.join(E.PUPPETEER_CORE || '/tmp/pgcheck/node_modules/puppeteer-core', 'lib/puppeteer/puppeteer-core.js')).href)
setQuiet(true)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (cond, what) => { if (!cond) throw new Error(`CHECK FAILED: ${what}`); console.log(`ok - ${what}`) }
async function maint(sql) { const c = new pg.Client({ ...DB, database: MAINT }); await c.connect(); try { await c.query(sql) } finally { await c.end() } }

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-shots-p1-'))
await maint(`DROP DATABASE IF EXISTS "${DB.database}" WITH (FORCE)`)
await maint(`CREATE DATABASE "${DB.database}" ENCODING 'UTF8' TEMPLATE template0`)
const app = await createApp({ env: { APPBUILDER_DB_HOST: DB.host, APPBUILDER_DB_PORT: String(DB.port), APPBUILDER_DB_NAME: DB.database, APPBUILDER_DB_USER: DB.user, APPBUILDER_DB_PASSWORD: DB.password, APPBUILDER_MIGRATION_BACKUP: 'skip' }, config: { workspaceDir: DIR }, printSetupCode: false, jobs: true })
const server = http.createServer((req, res) => { app.handle(req, res).then((h) => { if (!h) serveStatic(path.join(root, 'dist'), req, res) }, () => { if (!res.headersSent) res.writeHead(500); res.end() }) })
server.on('upgrade', (req, socket, head) => { if (!app.handleUpgrade(req, socket, head)) socket.destroy() })
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

let cookie = ''
async function api(method, p, body, o = {}) {
  const res = await fetch(BASE + '/api/v1' + p, { method, headers: { 'X-Appbuilder': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(o.env ? { 'X-Appbuilder-Environment': o.env } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  for (const c of res.headers.getSetCookie?.() ?? []) { const [pair] = c.split(';'); if (pair.startsWith('ab_session=')) cookie = pair }
  const data = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : await res.text()
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(data).slice(0, 300)}`)
  return data
}

let browser = null
const T = (id) => `[data-testid="${id}"]`
try {
  await api('POST', '/setup/admin', { setupCode: app.services.setupCode.current() ?? '', ...ADMIN })
  await api('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password })
  const settings = { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' }
  // data: two apps, a few flows, a policy, people
  for (const [name, email] of [['Mona Manager', 'mona@example.test'], ['Dev Director', 'dev@example.test']]) await api('POST', '/users', { name, email, roleIds: ['role_maker'], password: 'Temporary-Pass-1234' })
  const fin = await api('POST', '/roles', { name: 'Finance', privileges: [], apps: 'all' })
  void fin
  await api('POST', '/tables', { displayName: 'Purchase requests', name: 'PurchaseRequests', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Amount', type: 'number' }, { displayName: 'Status', type: 'text' }] })
  const apps = []
  for (const name of ['Equipment checkout', 'Purchases']) {
    const a = await api('POST', '/apps', { name, width: 1280, height: 800 })
    await api('PUT', `/apps/${a.id}`, { definition: { formatVersion: 2, name, width: 1280, height: 800, scaleMode: 'responsive', theme: { mode: 'light' }, dataSources: [], appProps: {}, screens: [{ id: 'scr1', name: 'Home', type: 'Screen', props: { Fill: '=RGBA(248, 250, 252, 1)' }, children: [{ id: 'l1', name: 'Heading', type: 'Label', props: { X: '=32', Y: '=32', Width: '=700', Height: '=48', Text: `="${name}"`, Size: '=26' }, children: [] }] }] } })
    apps.push(a)
  }
  const conn = await api('POST', '/connections', { name: 'Orders API', connector: 'http', settings: { baseUrl: 'https://orders.example.test', allowedHosts: 'orders.example.test' } })
  const flows = []
  flows.push(await api('POST', '/flows', { name: 'Sync orders', enabled: true, settings, connections: { api: conn.id }, trigger: { type: 'schedule', everyMinutes: 60, timeZone: 'Asia/Kolkata' }, steps: [{ id: 'h', name: 'Call', kind: 'http', method: 'GET', url: '"https://orders.example.test/orders"', auth: 'api' }] }))
  flows.push(await api('POST', '/flows', { name: 'Notify the requester', enabled: true, settings, trigger: { type: 'table', table: 'PurchaseRequests', on: ['create'] }, steps: [{ id: 'n', name: 'Tell', kind: 'notify', to: '"mona@example.test"', title: '"New request: " & Trigger.Record.Title', channels: ['inApp'] }] }))
  flows.push(await api('POST', '/flows', { name: 'Weekly clean-up', enabled: false, settings, trigger: { type: 'schedule', cron: '0 6 * * 1', timeZone: 'Asia/Kolkata' }, steps: [{ id: 'c', name: 'C', kind: 'compose', value: '1' }] }))
  const pol = await api('POST', '/approvals/policies', { name: 'Purchase', description: 'Manager, then Finance above 10,000; the board above 500,000.', definition: {
    type: 'sequential', dueMinutes: 48 * 60, escalation: { action: 'manager' }, requireCommentOnReject: true,
    stages: [{ name: 'Manager', approvers: ['manager'], dueMinutes: 24 * 60 }, { name: 'Finance', approvers: ['role:Finance'], condition: 'Amount > 10000' }],
    rules: [{ name: 'Board', condition: 'Amount > 500000', approvers: ['manager-chain-until-title:CEO'] }],
    responses: [{ label: 'Approve', kind: 'approve' }, { label: 'Reject', kind: 'reject', requireComment: true }, { label: 'Need more info', kind: 'info' }],
  } })
  await api('POST', '/approvals/policies', { name: 'Supplier', definition: { type: 'any', approvers: ['mona@example.test', 'ghost@example.test'] } })
  const sol = await api('POST', '/solutions', { name: 'Purchasing', displayName: 'Purchasing', publisher: 'Acme', version: '1.0.0' })
  for (const [kind, id] of [['flow', flows[0].flow.id], ['approvalPolicy', (await api('GET', '/approvals/policies')).items.find((x) => x.name === 'Supplier').id]]) await api('POST', `/solutions/${sol.id}/components`, { kind, id })
  const env = await api('POST', '/environments', { name: 'Production', type: 'production' })
  for (let i = 0; i < 60; i++) { const e = (await api('GET', '/environments')).items.find((x) => x.id === env.id); if (e?.state === 'ready') break; await sleep(500) }
  await api('POST', '/connections', { name: 'Production orders API', connector: 'http', settings: { baseUrl: 'https://orders.example.test', allowedHosts: 'orders.example.test' } }, { env: env.id })
  await api('PUT', '/admin/health-alerts', { email: { enabled: true, dailyTime: '07:30', timeZone: 'Asia/Kolkata' }, heartbeat: { url: 'https://hc-ping.com/00000000-0000-0000-0000-000000000000', everyMinutes: 5, enabled: true } })

  browser = await puppeteer.launch({ executablePath: E.CHROME_PATH || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  page.on('dialog', (d) => d.accept())
  await page.goto(`${BASE}/#home`, { waitUntil: 'networkidle0' })
  await page.waitForSelector(T('login-form'), { visible: true })
  await page.type(T('login-email'), ADMIN.email)
  await page.type(T('login-password'), ADMIN.password)
  await page.click(T('login-submit'))
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-form"]'), { timeout: 20000 })
  const shot = async (name, clip) => { await sleep(700); const el = clip ? await page.$(clip) : null; if (el) await el.screenshot({ path: path.join(OUT, name) }); else await page.screenshot({ path: path.join(OUT, name) }); console.log(`shot ${name}`) }

  // User mode: two app tabs over My apps
  for (const a of apps) { await page.goto(`${BASE}/#u-${a.id}`, { waitUntil: 'networkidle0' }); await sleep(800) }
  await page.goto(`${BASE}/#u`, { waitUntil: 'networkidle0' })
  await sleep(800)
  const soon = await page.evaluate(() => [...document.querySelectorAll('nav, aside')].map((x) => x.innerText).join(' '))
  ok(!/Tasks\s*Soon|Scheduled reports\s*Soon/i.test(soon), 'Tasks and Scheduled reports are not marked Soon')
  await shot('user-mode-tabs.png')

  // Admin console > Flows
  await page.goto(`${BASE}/#admin-flows`, { waitUntil: 'networkidle0' })
  await page.waitForSelector(T('admin-flows-table'), { visible: true, timeout: 20000 })
  await shot('admin-flows.png')

  // the visual policy editor
  await page.goto(`${BASE}/#u-approvals`, { waitUntil: 'networkidle0' })
  await page.waitForSelector(T('approvals-page'), { timeout: 20000 })
  await page.evaluate(() => { const b = [...document.querySelectorAll('[data-testid="approvals-page"] button')].find((x) => x.textContent?.trim() === 'Policies'); b?.click() })
  await page.waitForSelector(T('policy-row'), { visible: true, timeout: 20000 })
  await page.evaluate((name) => { const r = [...document.querySelectorAll('[data-testid="policy-row"]')].find((x) => x.textContent.includes(name)); r?.querySelector('button')?.click() }, 'Purchase')
  await page.waitForSelector(T('stages-editor'), { visible: true, timeout: 20000 })
  ok((await page.$$(T('stage-card'))).length === 2 && (await page.$$(T('rule-card'))).length === 1, 'the editor shows two stages and the threshold rule')
  ok(await page.evaluate(() => document.body.innerText.includes('Manager chain until "CEO"')), 'approvers are shown in words')
  await page.setViewport({ width: 1440, height: 2400 })
  await shot('approvals-policy-editor.png', T('policy-editor'))
  await page.setViewport({ width: 1440, height: 900 })
  void pol

  // the Deploy dialog with the mapping
  await page.goto(`${BASE}/#solution-${sol.id}`, { waitUntil: 'networkidle0' })
  await page.click(T('deploy-solution-button'))
  await page.waitForSelector(T('deploy-dialog'), { visible: true })
  await page.select(T('deploy-target'), env.id)
  await page.click(T('deploy-review'))
  await page.waitForSelector(T('plan-mappings'), { visible: true, timeout: 20000 })
  ok(await page.$eval(T('deploy-confirm'), (b) => b.disabled), 'Deploy waits for the mapping')
  await page.setViewport({ width: 1440, height: 1200 })
  await shot('solutions-deploy-mapping.png', T('deploy-dialog'))
  await page.setViewport({ width: 1440, height: 900 })
  await page.keyboard.press('Escape')

  // health email and heartbeat
  await page.goto(`${BASE}/#admin-logs`, { waitUntil: 'networkidle0' })
  await page.waitForSelector(T('health-alerts'), { visible: true, timeout: 20000 })
  await shot('admin-health-alerts.png', T('health-alerts'))
} finally {
  await browser?.close().catch(() => {})
  server.closeAllConnections?.()
  await new Promise((r) => server.close(() => r()))
  await app.close()
  await maint(`DROP DATABASE IF EXISTS "${DB.database}" WITH (FORCE)`).catch(() => {})
  fs.rmSync(DIR, { recursive: true, force: true })
}
console.log('done')
process.exit(0)
