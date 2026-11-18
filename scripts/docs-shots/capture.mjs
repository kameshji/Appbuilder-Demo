/**
 * Documentation screenshot capture. DEVELOPER TOOL, not part of the product or of `npm start`.
 *
 * Needs (neither is a dependency of this repository):
 *   - puppeteer-core: imported from PUPPETEER_CORE (default /tmp/pgcheck/node_modules/puppeteer-core)
 *   - Chrome or Chromium: CHROME_PATH (default /usr/bin/google-chrome)
 *
 * What it does: drives a real Appbuilder server in a headless browser (1440x900, light theme) and writes PNGs to
 * docs/images/. It follows the "Equipment checkout" walkthrough of docs/guide/getting-started.md.
 *
 * It needs TWO servers, both started by you from the built app (`npm run build` first), using SANDBOX values only:
 *   1. A main server with a database, for everything except the setup wizard:
 *        APPBUILDER_DB_HOST=127.0.0.1 APPBUILDER_DB_PORT=3306 APPBUILDER_DB_NAME=appbuilder_test_docs \
 *        APPBUILDER_DB_USER=abdev APPBUILDER_DB_PASSWORD=abdev-sandbox-only APPBUILDER_WORKSPACE=/tmp/ws-docs \
 *        PORT=5196 node server/main.ts
 *      The workspace and database must be EMPTY (no administrator yet): the script creates the first administrator.
 *   2. A wizard server with a fresh workspace and no APPBUILDER_DB_* variables, for the setup wizard screens:
 *        APPBUILDER_WORKSPACE=/tmp/ws-docs-wizard PORT=5296 node server/main.ts
 *
 * Environment:
 *   BASE         main server URL            (default http://localhost:5196)
 *   WIZARD_BASE  wizard server URL          (default http://localhost:5296)
 *   DB_*         sandbox database values typed into the wizard (defaults match the commands above)
 *   ONLY         comma list of step names to run (default: all, in order)
 *   OUT          output folder              (default docs/images next to this repository's docs/)
 *
 * Only fake data is used: the test email admin@example.test and an obviously fake password.
 * Run:  node scripts/docs-shots/capture.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const PUPPETEER_CORE = process.env.PUPPETEER_CORE || '/tmp/pgcheck/node_modules/puppeteer-core'
const { default: puppeteer } = await import(pathToFileURL(path.join(PUPPETEER_CORE, 'lib/puppeteer/puppeteer-core.js')).href)

const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome'
const BASE = (process.env.BASE || 'http://localhost:5196').replace(/\/$/, '')
const WIZARD = (process.env.WIZARD_BASE || 'http://localhost:5296').replace(/\/$/, '')
const OUT = process.env.OUT || path.join(root, 'docs', 'images')
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean)
const DB = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || '3306',
  name: process.env.DB_NAME || 'appbuilder_test_docs',
  user: process.env.DB_USER || 'abdev',
  password: process.env.DB_PASSWORD || 'abdev-sandbox-only',
}
const ADMIN = { name: 'Test Admin', email: 'admin@example.test', password: 'Example-Only-Pass-2026' }

fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
})

async function newPage(url) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('appbuilder-theme', 'light') } catch { /* ignore */ }
  })
  page.on('pageerror', (e) => console.log('  [page error]', e.message))
  if (url) await page.goto(url, { waitUntil: 'networkidle0' })
  return page
}
const shot = async (page, name, opts = {}) => {
  await sleep(opts.wait ?? 350)
  await page.screenshot({ path: path.join(OUT, name + '.png') })
  console.log('  wrote', name + '.png')
}
const tid = (id) => `[data-testid="${id}"]`
const click = async (page, sel) => { await page.waitForSelector(sel, { visible: true }); await page.click(sel) }
const type = async (page, sel, text, { clear = true } = {}) => {
  await page.waitForSelector(sel, { visible: true })
  await page.click(sel)
  if (clear) {
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control')
    await page.keyboard.press('Backspace')
  }
  await page.type(sel, text)
}
/** click the first visible element whose text matches */
async function clickText(page, text, selector = 'button, [role="menuitem"], [role="tab"], a', root) {
  const ok = await page.evaluate((text, selector) => {
    const els = [...document.querySelectorAll(selector)].filter((e) => {
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && (e.textContent || '').replace(/\s+/g, ' ').trim() === text
    })
    if (!els.length) return false
    els[0].click()
    return true
  }, text, selector)
  if (!ok) throw new Error(`No clickable element with text "${text}"`)
}

/** close any toast so it does not end up in a screenshot */
const clearToasts = async (page) => {
  await page.evaluate(() => document.querySelectorAll('[aria-label="Dismiss"]').forEach((b) => b.click()))
  await sleep(200)
}

/** open a page of the main server; signs in (or creates the first administrator) when asked to */
async function openMain(hash = '#home') {
  const page = await newPage(BASE + '/' + hash)
  await page.waitForSelector(`${tid('setup-admin-form')}, ${tid('login-form')}, ${tid('portal-root')}, ${tid('studio-root')}, ${tid('run-root')}`, { visible: true })
  if (await page.$(tid('setup-admin-form'))) {
    await type(page, tid('setup-admin-name'), ADMIN.name)
    await type(page, tid('setup-admin-email'), ADMIN.email)
    await type(page, tid('admin-pw-new'), ADMIN.password)
    await type(page, tid('admin-pw-confirm'), ADMIN.password)
    await click(page, tid('setup-admin-create'))
  } else if (await page.$(tid('login-form'))) {
    await type(page, tid('login-email'), ADMIN.email)
    await type(page, tid('login-password'), ADMIN.password)
    await click(page, tid('login-submit'))
  }
  await page.waitForSelector(`${tid('portal-root')}, ${tid('studio-root')}, ${tid('run-root')}`, { visible: true })
  await page.evaluate((h) => { location.hash = h }, hash)
  await sleep(600)
  return page
}

const steps = []
const step = (name, fn) => steps.push({ name, fn })

/* ------------------------------------------------------------------ 1. setup wizard (fresh workspace, no APPBUILDER_DB_*) */

step('wizard', async () => {
  const page = await newPage(WIZARD + '/')
  await page.waitForSelector(tid('setup-database-form'))
  await shot(page, 'setup-database')

  // a wrong password shows the real error message
  await type(page, tid('setup-database'), DB.name)
  await type(page, tid('setup-user'), DB.user)
  await type(page, tid('setup-password'), 'not-the-right-password')
  await click(page, tid('setup-database-continue'))
  await page.waitForSelector(tid('form-error'), { visible: true })
  await shot(page, 'setup-database-error')

  // the right password moves on to the administrator step
  await type(page, tid('setup-password'), DB.password)
  await click(page, tid('setup-database-continue'))
  await page.waitForSelector(tid('setup-admin-form'), { visible: true })
  await type(page, tid('setup-admin-name'), ADMIN.name)
  await type(page, tid('setup-admin-email'), ADMIN.email)
  await type(page, tid('admin-pw-new'), ADMIN.password)
  await type(page, tid('admin-pw-confirm'), ADMIN.password)
  await clearToasts(page)
  await shot(page, 'setup-admin')
  await page.close()
})

/* ------------------------------------------------------------------ 2. sign in and tour of the portal */

step('tour', async () => {
  const page = await openMain('#home')
  await clearToasts(page)
  await shot(page, 'portal-home')
  for (const [hash, name] of [['#apps', 'portal-apps'], ['#tables', 'portal-tables'], ['#datafiles', 'portal-datafiles'], ['#connections', 'portal-connections'], ['#roles', 'portal-roles'], ['#solutions', 'portal-solutions']]) {
    await page.evaluate((h) => { location.hash = h }, hash)
    await sleep(700)
    await shot(page, name)
  }
  await page.close()
})

/* ------------------------------------------------------------------ runner */

const run = steps.filter((s) => !ONLY.length || ONLY.includes(s.name))
for (const s of run) {
  console.log(`step ${s.name}`)
  try {
    await s.fn()
  } catch (e) {
    console.log(`  FAILED: ${e.message}`)
    process.exitCode = 1
    break
  }
}
await browser.close()
