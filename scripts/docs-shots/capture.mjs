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
 *        APPBUILDER_DB_HOST=127.0.0.1 APPBUILDER_DB_PORT=5433 APPBUILDER_DB_NAME=appbuilder_test_docs \
 *        APPBUILDER_DB_USER=abdev APPBUILDER_DB_PASSWORD=abdev-sandbox-only APPBUILDER_WORKSPACE=/tmp/ws-docs \
 *        PORT=5196 node server/main.ts
 *      The workspace and database must be EMPTY (no administrator yet): the script creates the first administrator.
 *      The sandbox PostgreSQL role must have CREATEDB (the server creates the database) or the database must exist.
 *   2. A wizard server with a fresh workspace and no APPBUILDER_DB_* variables, for the setup wizard screens:
 *        APPBUILDER_WORKSPACE=/tmp/ws-docs-wizard PORT=5296 node server/main.ts
 *      Give it its OWN database (the script uses appbuilder_test_docs_wiz). Two servers must never share one database:
 *      each seals the stored database password with its own key, and the other one then cannot read it.
 *      The wizard server is single-use: after the wizard step ran, delete its workspace and restart it to run it again.
 *
 * Environment:
 *   BASE         main server URL            (default http://localhost:5196)
 *   WIZARD_BASE  wizard server URL          (default http://localhost:5296)
 *   DB_*         sandbox database values typed into the wizard (defaults match the commands above)
 *   ONLY         comma list of step names to run (default: all, in order)
 *   SETUP_CODE   the setup code the main server printed (needed when its database comes from APPBUILDER_DB_*)
 *   WIZARD_SETUP_CODE  the setup code the wizard server printed
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
  port: process.env.DB_PORT || '5433',
  name: process.env.DB_NAME || 'appbuilder_test_docs',
  wizardName: process.env.WIZARD_DB_NAME || 'appbuilder_test_docs_wiz',
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
    // the database came from APPBUILDER_DB_*: the administrator step asks for the setup code the server printed
    if (await page.$(tid('setup-code'))) await type(page, tid('setup-code'), process.env.SETUP_CODE || '')
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

/** pick an option of a Radix Select: click the trigger (a handle or selector), then the option with this text */
async function pickOption(page, trigger, text) {
  const el = typeof trigger === 'string' ? await page.waitForSelector(trigger, { visible: true }) : trigger
  await el.click()
  await page.waitForSelector('[role="option"]', { visible: true })
  const ok = await page.evaluate((text) => {
    const o = [...document.querySelectorAll('[role="option"]')].find((e) => (e.textContent || '').replace(/\s+/g, ' ').trim() === text)
    if (!o) return false
    o.click()
    return true
  }, text)
  if (!ok) throw new Error(`No option "${text}"`)
  await sleep(150)
}

/** open the table designer of the table with this display name */
async function openTable(name) {
  const page = await openMain('#tables')
  await page.waitForSelector(tid('tables-list'), { visible: true })
  const ok = await page.evaluate((name) => {
    const row = [...document.querySelectorAll('[data-testid^="table-row-"]')].find((r) => r.querySelector('.font-medium')?.textContent === name)
    if (!row) return false
    row.click()
    return true
  }, name)
  if (!ok) throw new Error(`No table "${name}"`)
  await page.waitForSelector(tid('page-table'), { visible: true })
  await sleep(400)
  return page
}

/** open an app in Studio from the Apps list */
async function openStudio(appName) {
  const page = await openMain('#apps')
  await page.waitForSelector(tid('apps-table'), { visible: true })
  const ok = await page.evaluate((name) => {
    const b = [...document.querySelectorAll('[data-testid="apps-table"] tbody td:first-child button')].find((e) => e.textContent === name)
    if (!b) return false
    b.click()
    return true
  }, appName)
  if (!ok) throw new Error(`No app "${appName}"`)
  await page.waitForSelector(tid('studio-root'), { visible: true })
  await sleep(1200)
  return page
}
const selectNode = async (page, name) => { await click(page, tid(`tree-node-${name}`)); await sleep(250) }
/** choose a property in the formula bar and replace its formula */
async function setFormula(page, prop, text) {
  const cur = await page.$eval(tid('prop-select'), (e) => e.textContent)
  if (cur.trim() !== prop) await pickOption(page, tid('prop-select'), prop)
  await page.click(tid('formula-input'))
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control')
  await page.keyboard.press('Backspace')
  await page.keyboard.type(text.replace(/^=/, ''), { delay: 5 }) // the bar shows the = sign itself
  await page.keyboard.press('Escape') // closes a suggestion list, if one is open
  await page.keyboard.press('Enter')
  await sleep(250)
}
async function setSimple(page, prop, value) {
  await page.click(tid(`prop-${prop}`), { clickCount: 1 })
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control')
  await page.keyboard.type(String(value))
  await page.keyboard.press('Enter')
  await sleep(200)
}
const insertControl = async (page, label) => {
  await click(page, tid('insert-menu'))
  await page.waitForSelector('[role="menuitem"]', { visible: true })
  await clickText(page, label, '[role="menuitem"]')
  await sleep(400)
}

const steps = []
const step = (name, fn) => steps.push({ name, fn })

/* ------------------------------------------------------------------ 1. setup wizard (fresh workspace, no APPBUILDER_DB_*) */

step('wizard', async () => {
  const page = await newPage(WIZARD + '/')
  await page.waitForSelector(tid('setup-database-form'))
  // the one-time code the wizard server printed on its console
  await type(page, tid('setup-code'), process.env.WIZARD_SETUP_CODE || '')
  await shot(page, 'setup-database')

  // a wrong password shows the real error message (the sandbox server may listen on another port than 5432)
  await type(page, tid('setup-port'), String(DB.port))
  await type(page, tid('setup-database'), DB.wizardName)
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

/* ------------------------------------------------------------------ 3. the Equipment table */

step('table', async () => {
  const page = await openMain('#tables')
  await click(page, tid('new-table-button'))
  await page.waitForSelector(tid('new-table-dialog'), { visible: true })
  await type(page, tid('new-table-name'), 'Equipment')
  // the dialog starts with one text column called Name: rename it and add three more
  await type(page, '[aria-label="Column 1 name"]', 'Item')
  const addCol = async (n, name, typeLabel) => {
    await clickText(page, 'Add column')
    await type(page, `[aria-label="Column ${n} name"]`, name)
    const triggers = await page.$$(`${tid('new-table-dialog')} [role="combobox"]`)
    // triggers: [connection select (server mode), type of column 1, type of column 2, ...]
    await pickOption(page, triggers[triggers.length - 1], typeLabel)
  }
  await addCol(2, 'Checked out to', 'Single line of text')
  await addCol(3, 'Checked out', 'Yes / No')
  await addCol(4, 'Due date', 'Date')
  await shot(page, 'table-new')
  await click(page, tid('new-table-create'))
  await page.waitForSelector(tid('page-table'), { visible: true })
  await sleep(500)
  await shot(page, 'table-designer-data')
  await page.close()
})

step('columns', async () => {
  const page = await openTable('Equipment')
  await click(page, tid('tab-columns'))
  await click(page, tid('add-column-button'))
  await page.waitForSelector(tid('column-editor'), { visible: true })
  await type(page, tid('col-display-name'), 'Category')
  await pickOption(page, `${tid('column-editor')} [role="combobox"]`, 'Choice')
  for (const c of ['Laptop', 'Camera', 'Projector', 'Other']) {
    await type(page, tid('choice-input'), c)
    await page.keyboard.press('Enter')
  }
  await shot(page, 'table-column-choice')
  await click(page, tid('col-save'))
  await sleep(600)
  await page.evaluate(() => document.querySelector('[data-testid="column-editor"] button[aria-label="Close panel"]')?.click())
  await clearToasts(page)
  await shot(page, 'table-columns')
  await page.close()
})

step('rows', async () => {
  const page = await openTable('Equipment')
  await click(page, tid('add-row-button'))
  await page.waitForSelector(tid('add-row-dialog'), { visible: true })
  await type(page, '#add-Item', 'Dell laptop 14"')
  await page.select('#add-Category', 'Laptop')
  await shot(page, 'table-add-row')
  await click(page, tid('add-row-save'))
  await sleep(600)
  await click(page, tid('csv-import-button'))
  await page.waitForSelector(tid('csv-import-dialog'), { visible: true })
  const csv = ['Item,Category,CheckedOut', 'Canon camera,Camera,false', 'Epson projector,Projector,false', 'Lenovo laptop 15",Laptop,false', 'Tripod,Other,false', 'Wireless microphone,Other,false'].join('\n')
  await page.$eval(tid('csv-import-text'), (el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, csv)
  await shot(page, 'table-import-csv')
  await click(page, tid('csv-import-run'))
  await sleep(800)
  await clearToasts(page)
  await shot(page, 'table-rows')
  await page.close()
})

/* ------------------------------------------------------------------ 4. the app (Start with data) and Studio */

step('app', async () => {
  const page = await openMain('#home')
  // re-running this step replaces an earlier "Equipment app"
  await page.evaluate(async () => {
    const h = { 'X-Appbuilder': '1' }
    const list = await (await fetch('/api/v1/workspace', { headers: h })).json()
    for (const a of (Array.isArray(list) ? list : list.apps ?? []).filter((x) => /^Equipment app/.test(x.name))) await fetch('/api/v1/apps/' + a.id, { method: 'DELETE', headers: h })
  })
  await page.evaluate(() => location.reload())
  await page.waitForSelector(tid('portal-root'), { visible: true })
  await click(page, tid('start-with-data-button'))
  await page.waitForSelector(tid('start-with-data-dialog'), { visible: true })
  // server mode lists table names only (the row count is shown in demo mode, where every row is loaded)
  await pickOption(page, tid('start-table-select'), 'Equipment')
  await shot(page, 'home-start-with-data')
  await click(page, tid('start-with-data-create'))
  await page.waitForSelector(tid('studio-root'), { visible: true })
  await sleep(1500)
  await clearToasts(page)
  await shot(page, 'studio-start-with-data')
  await page.close()
})

step('studio', async () => {
  const page = await openStudio('Equipment app')
  await selectNode(page, 'DataTable1')
  await shot(page, 'studio-select-table')
  await setFormula(page, 'Columns', '="Item, Category, CheckedOutTo, CheckedOut, DueDate"')
  await setSimple(page, 'Y', 112)
  await setSimple(page, 'Height', 928)

  // a search box above the table
  await selectNode(page, 'Screen1')
  await insertControl(page, 'Search box')
  await setSimple(page, 'X', 40)
  await setSimple(page, 'Y', 40)
  await setSimple(page, 'Width', 520)
  await setSimple(page, 'Height', 48)

  // the table shows only rows that match the search box
  await selectNode(page, 'DataTable1')
  await setFormula(page, 'Items', 'Filter(Equipment, IsBlank(SearchBox1.Value) || SearchBox1.Value in Item)')
  await shot(page, 'studio-filter-formula')

  // a button that checks the selected item out
  await selectNode(page, 'Screen1')
  await insertControl(page, 'Button')
  await setSimple(page, 'Text', 'Check out')
  await setSimple(page, 'X', 1200)
  await setSimple(page, 'Y', 820)
  await setSimple(page, 'Width', 320)
  await setSimple(page, 'Height', 48)
  await setFormula(page, 'OnSelect', 'Patch(Equipment, DataTable1.Selected, {CheckedOut: true, CheckedOutTo: User().FullName, DueDate: DateAdd(Today(), 7, "Days")}); Notify("Checked out for 7 days", NotificationType.Success)')
  await shot(page, 'studio-button-onselect')
  // the button is disabled until a row is selected
  await setFormula(page, 'DisplayMode', 'If(IsBlank(DataTable1.Selected), DisplayMode.Disabled, DisplayMode.Edit)')
  await sleep(1200)
  await page.close()
})

step('preview', async () => {
  const page = await openStudio('Equipment app')
  await click(page, tid('preview-button'))
  await page.waitForSelector(tid('preview-root'), { visible: true })
  await sleep(1200)
  await shot(page, 'preview-start')
  // select a row, then check it out
  await page.evaluate(() => {
    const cell = [...document.querySelectorAll('[data-testid="preview-screen"] td')].find((e) => e.textContent === 'Canon camera')
    cell?.click()
  })
  await sleep(500)
  await clickText(page, 'Check out', '[data-testid="preview-screen"] button')
  await sleep(900)
  await shot(page, 'preview-checked-out', { wait: 100 })
  await click(page, tid('preview-back'))
  await sleep(300)
  await page.close()
})

/* ------------------------------------------------------------------ shell: top bar, Settings, Admin console */

step('shell-account', async () => {
  const page = await openMain('#home')
  await clearToasts(page)
  await click(page, tid('avatar-menu'))
  await page.waitForSelector(tid('avatar-menu-content'), { visible: true })
  await shot(page, 'shell-avatar-menu')
  await page.keyboard.press('Escape')
  await sleep(200)
  await click(page, tid('env-picker'))
  await page.waitForSelector(tid('env-menu'), { visible: true })
  await shot(page, 'shell-environment-picker')
  await page.keyboard.press('Escape')
  await page.close()
})

step('settings', async () => {
  const page = await openMain('#apps')
  await click(page, tid('settings-entry'))
  await page.waitForSelector(tid('settings-page'), { visible: true })
  await click(page, tid('settings-nav-appearance'))
  await shot(page, 'settings-appearance')
  await click(page, tid('settings-nav-profile'))
  await shot(page, 'settings-profile')
  await click(page, tid('settings-close'))
  await page.close()
})

step('admin-users', async () => {
  const page = await openMain('#admin-users')
  // a second person with a temporary password, so the page shows "Must change password" (fake data)
  await page.evaluate(async () => {
    const h = { 'Content-Type': 'application/json', 'X-Appbuilder': '1' }
    const users = await (await fetch('/api/v1/workspace', { headers: h })).json()
    if (!users.users.some((u) => u.email === 'operator@example.test')) {
      await fetch('/api/v1/users', { method: 'POST', headers: h, body: JSON.stringify({ name: 'Olu Operator', email: 'operator@example.test', roleIds: ['role_viewer'], password: 'Example-Temp-Pass-2026' }) })
    }
  })
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForSelector(tid('users-table'), { visible: true })
  await clearToasts(page)
  await shot(page, 'admin-users')
  await click(page, tid('admin-nav-audit'))
  await page.waitForSelector('[data-testid^="audit-row-"]', { visible: true })
  await shot(page, 'admin-audit')
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
