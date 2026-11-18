/**
 * Backups walkthrough in a headless browser: the end-to-end check of the Admin console > Backups page (P0 package J)
 * and the screenshots of docs/admin/backup-and-restore.md. DEVELOPER TOOL, not part of the product.
 *
 * Needs puppeteer-core (PUPPETEER_CORE, default /tmp/pgcheck/node_modules/puppeteer-core) and Chrome (CHROME_PATH), and
 * one server started from the built app with an EMPTY sandbox database and workspace, e.g.
 *   APPBUILDER_DB_HOST=127.0.0.1 APPBUILDER_DB_PORT=5433 APPBUILDER_DB_NAME=appbuilder_test_bkshots \
 *   APPBUILDER_DB_USER=abdev APPBUILDER_DB_PASSWORD=abdev-sandbox-only APPBUILDER_WORKSPACE=/tmp/ws-bk PORT=5198 node server/main.ts
 * then  SETUP_CODE=<the code it printed> BASE=http://localhost:5198 node scripts/docs-shots/backups.mjs
 *
 * Steps (each one is checked, the script exits 1 on the first failure):
 *   1. create the first administrator (Default has the sample); the Admin console shows the backup health line
 *   2. Backups > Back up now (whole install): the row goes Waiting -> Running -> Verified
 *   3. Restore > as a new environment: the progress ends "Restored", the environment exists with the same rows
 *   4. Restore > browse a table of the backup (read-only rows, paging)
 *   5. the Schedule and retention and Settings tabs; the environment details show the last backup
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
const SHOTS = process.env.SHOTS !== '0'
const ADMIN = { name: 'Test Admin', email: 'admin@example.test', password: 'Example-Only-Pass-2026' }
fs.mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (id) => `[data-testid="${id}"]`
const fail = (m) => { throw new Error(m) }
const ok = (cond, m) => { if (!cond) fail(m); console.log('  ok:', m) }

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('appbuilder-theme', 'light') } catch { /* ignore */ } })
const errors = []
page.on('pageerror', (e) => { errors.push(e.message); console.log('  [page error]', e.message) })

const shot = async (name, el) => {
  if (!SHOTS) return
  await sleep(400)
  if (el) { const h = await page.$(el); if (h) { await h.screenshot({ path: path.join(OUT, name + '.png') }); console.log('  wrote', name + '.png'); return } }
  await page.screenshot({ path: path.join(OUT, name + '.png') })
  console.log('  wrote', name + '.png')
}
const click = async (sel) => { await page.waitForSelector(sel, { visible: true, timeout: 15000 }); await page.click(sel) }
const type = async (sel, text) => {
  await page.waitForSelector(sel, { visible: true })
  await page.click(sel)
  // clear what is there (prefilled inputs): select everything, delete
  await page.$eval(sel, (e) => e.select?.())
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control')
  await page.keyboard.press('Backspace')
  await page.type(sel, text)
}
const go = async (hash) => { await page.evaluate((h) => { location.hash = h }, hash); await sleep(700) }
const api = (method, p, body, env) => page.evaluate(async (method, p, body, env) => {
  const headers = { 'X-Appbuilder': '1', 'Content-Type': 'application/json' }
  if (env) headers['X-Appbuilder-Environment'] = env
  const r = await fetch('/api/v1' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, data: await r.json().catch(() => null) }
}, method, p, body, env)
const closeToasts = () => page.evaluate(() => document.querySelectorAll('[aria-label="Dismiss"]').forEach((b) => b.click()))
const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim())

try {
  console.log('1. first administrator; the backup health line')
  await page.goto(BASE + '/#home', { waitUntil: 'networkidle0' })
  await page.waitForSelector(`${tid('setup-admin-form')}, ${tid('login-form')}`, { visible: true })
  if (await page.$(tid('setup-admin-form'))) {
    if (await page.$(tid('setup-code'))) await type(tid('setup-code'), process.env.SETUP_CODE || '')
    await type(tid('setup-admin-name'), ADMIN.name)
    await type(tid('setup-admin-email'), ADMIN.email)
    await type(tid('admin-pw-new'), ADMIN.password)
    await type(tid('admin-pw-confirm'), ADMIN.password)
    await click(tid('setup-admin-create'))
  } else {
    await type(tid('login-email'), ADMIN.email)
    await type(tid('login-password'), ADMIN.password)
    await click(tid('login-submit'))
  }
  await page.waitForSelector(tid('portal-root'), { visible: true })
  await go('#admin-environments')
  await page.waitForSelector(tid('backup-health'), { visible: true })
  ok((await page.$eval(tid('backup-health'), (e) => e.getAttribute('data-state'))) === 'bad', 'the Admin console says there is no backup yet')
  ok(/No install backup has been made yet/.test(await text(tid('backup-health'))), 'health line text')
  ok(!(await page.$(`${tid('admin-nav-backups')} [data-testid="soon-badge"]`)), 'Backups has no "Soon" badge')

  console.log('2. back up now')
  await go('#admin-backups')
  await page.waitForSelector(tid('admin-backups'), { visible: true })
  await click(tid('backup-now'))
  await page.waitForSelector(tid('backup-now-dialog'), { visible: true })
  await click(tid('backup-now-encrypt'))
  await type(tid('backup-now-pass'), 'example passphrase 1')
  await shot('backups-now-dialog', tid('backup-now-dialog'))
  await click(tid('backup-now-encrypt'))
  await click(tid('backup-now-start'))
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid^="backup-row-"]')].some((r) => r.getAttribute('data-state') === 'ok'), { timeout: 120000 })
  ok(true, 'the backup is listed as verified')
  await closeToasts()
  const list = (await api('GET', '/backups')).data
  const b = list.items[0]
  ok(b.kind === 'install' && b.state === 'ok' && b.verifiedOn, `backup ${b.fileName}, ${b.sizeBytes} bytes, ${b.method}`)
  ok(list.health.stale === false, 'health is green after it')
  await page.waitForFunction(() => document.querySelector('[data-testid="backup-health"]')?.getAttribute('data-state') === 'ok', { timeout: 20000 })
  await shot('backups-list')

  console.log('3. restore as a new environment')
  await click(tid(`backup-restore-${b.id}`))
  await page.waitForSelector(tid('restore-tables'), { visible: true, timeout: 20000 })
  await click(tid('restore-mode-new'))
  await type(tid('restore-name'), 'Restored copy')
  await shot('backups-restore-dialog', tid('restore-dialog'))

  console.log('4. browse a table of the backup')
  await click(tid('restore-browse-Contacts'))
  await page.waitForSelector(tid('backup-browse-table'), { visible: true })
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="backup-browse-table"] tbody tr').length > 1, { timeout: 15000 })
  const range = await text(tid('backup-browse-range'))
  ok(/of \d+/.test(range), `browsing shows "${range}"`)
  await shot('backups-browse', tid('backup-browse'))
  await page.keyboard.press('Escape')
  await sleep(400)

  await click(tid('restore-start'))
  await page.waitForFunction(() => document.querySelector('[data-testid="restore-progress"]')?.getAttribute('data-state') === 'succeeded', { timeout: 120000 })
  ok(true, 'the restore finished')
  const envs = (await api('GET', '/environments')).data.items
  const restored = envs.find((e) => e.name === 'Restored copy')
  ok(restored && !restored.state, 'the new environment exists and is ready')
  const n1 = (await api('POST', '/data/Contacts/query', { count: true }, 'default')).data.total
  const n2 = (await api('POST', '/data/Contacts/query', { count: true }, restored.id)).data.total
  ok(n1 === n2 && n1 > 0, `same rows in both (${n1})`)
  await shot('backups-restore-done', tid('restore-dialog'))
  await page.keyboard.press('Escape')
  await sleep(400)

  console.log('5. schedule, settings, environment details')
  await click(tid('backup-tab-schedule'))
  await page.waitForSelector(tid('backup-schedule'), { visible: true })
  ok(/Whole install/.test(await text(tid('schedule-install'))), 'the nightly install schedule is shown')
  await shot('backups-schedule')
  await click(tid('backup-tab-settings'))
  await page.waitForSelector(tid('backup-settings'), { visible: true })
  await shot('backups-settings')
  await go('#admin-environments')
  await page.click(tid('env-row-default'))
  await page.waitForSelector(tid('env-detail-backup'), { visible: true, timeout: 15000 })
  ok(!/No backup contains it yet/.test(await text(tid('env-detail-backup'))), 'Default shows its last backup')
  ok(errors.length === 0, 'no page errors')
  console.log('\nBACKUPS WALKTHROUGH PASSED')
} catch (e) {
  console.error('\nFAILED:', e.message)
  await page.screenshot({ path: path.join('/tmp', 'backups-failure.png') }).catch(() => {})
  await browser.close()
  process.exit(1)
}
await browser.close()
