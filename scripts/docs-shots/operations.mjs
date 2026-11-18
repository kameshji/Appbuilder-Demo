/**
 * Operations walkthrough in a headless browser (P0 package L): Admin console > Server logs (health, log filters,
 * diagnostics bundle), Usage and Updates (upload a release ZIP), and the screenshots of docs/admin/operations.md and
 * docs/admin/upgrades.md. DEVELOPER TOOL, not part of the product.
 *
 * Needs puppeteer-core (PUPPETEER_CORE, default /tmp/pgcheck/node_modules/puppeteer-core), Chrome (CHROME_PATH), a release
 * ZIP (RELEASE_ZIP, from npm run release) and one server started from the built app with an EMPTY sandbox database:
 *   APPBUILDER_DB_HOST=127.0.0.1 APPBUILDER_DB_PORT=5433 APPBUILDER_DB_NAME=appbuilder_test_opsshots \
 *   APPBUILDER_DB_USER=abdev APPBUILDER_DB_PASSWORD=abdev-sandbox-only APPBUILDER_WORKSPACE=/tmp/ws-ops PORT=5198 node server/main.ts
 * then  SETUP_CODE=<the code> BASE=http://localhost:5198 RELEASE_ZIP=release/appbuilder-0.5.0.zip node scripts/docs-shots/operations.mjs
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
const ZIP = process.env.RELEASE_ZIP ? path.resolve(process.env.RELEASE_ZIP) : ''
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
const shot = async (name) => { if (!SHOTS) return; await page.evaluate(() => document.querySelectorAll('[aria-label="Dismiss"]').forEach((b) => b.click())); await sleep(500); await page.screenshot({ path: path.join(OUT, name + '.png') }); console.log('  wrote', name + '.png') }
const click = async (sel) => { await page.waitForSelector(sel, { visible: true, timeout: 15000 }); await page.click(sel) }
const type = async (sel, t) => { await page.waitForSelector(sel, { visible: true }); await page.click(sel, { clickCount: 3 }); await page.keyboard.press('Backspace'); await page.type(sel, t) }
const go = async (hash) => { await page.evaluate((h) => { location.hash = h }, hash); await sleep(800) }
const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim())

try {
  console.log('1. sign in')
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

  console.log('2. Server logs')
  await go('#admin-logs')
  ok(!(await page.$(`${tid('admin-nav-logs')} [data-testid="soon-badge"]`)), 'Server logs has no "Soon" badge')
  await page.waitForSelector(tid('health-checks'), { visible: true })
  ok((await text(tid('health-status'))) === 'OK', 'health: OK')
  ok(/Database:/.test(await text(tid('health-check-database'))), 'the database check is listed')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="logs-table"] tbody tr').length > 2, { timeout: 15000 })
  ok(true, 'log lines are listed')
  await shot('admin-logs')
  await type(tid('logs-q'), 'schema')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="logs-table"] tbody tr')].every((r) => /schema|No lines/i.test(r.textContent)), { timeout: 15000 })
  ok(true, 'the text filter narrows the lines')
  await click(tid('logs-bundle'))
  await page.waitForFunction(() => /Diagnostics bundle downloaded/.test(document.body.textContent), { timeout: 30000 })
  ok(true, 'the diagnostics bundle was created')

  console.log('3. Usage')
  await go('#admin-usage')
  await page.waitForSelector(tid('usage-env-default'), { visible: true, timeout: 20000 })
  ok(/t_contacts/.test(await text(tid('usage-env-default'))), 'the sample tables are counted')
  ok((await text(tid('usage-active'))).includes('1'), 'one active account')
  await shot('admin-usage')

  console.log('4. Updates')
  await go('#admin-updates')
  await page.waitForSelector(tid('updates-current'), { visible: true })
  if (ZIP) {
    const input = await page.$(tid('updates-file'))
    await input.uploadFile(ZIP)
    await page.waitForSelector(tid('updates-staged'), { visible: true, timeout: 60000 })
    ok(/files match their checksums/.test(await text(tid('updates-checksums'))), 'the uploaded release passes its checksums')
    ok(/Not signed|Signed/.test(await text(tid('updates-signature'))), `signature shown: ${await text(tid('updates-signature'))}`)
    await page.waitForSelector(tid('updates-notes'), { visible: true })
    await shot('admin-updates')
  } else console.log('  (no RELEASE_ZIP: upload skipped)')
  ok(errors.length === 0, 'no page errors')
  console.log('done')
} catch (e) {
  console.error('FAILED:', e.message)
  await page.screenshot({ path: '/tmp/operations-failure.png' }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
