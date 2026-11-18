/**
 * Environments walkthrough in a headless browser: the end-to-end check of P0 package E and the screenshots of
 * docs/admin/environments.md and docs/guide/maker/solutions.md. DEVELOPER TOOL, not part of the product.
 *
 * Needs puppeteer-core (PUPPETEER_CORE, default /tmp/pgcheck/node_modules/puppeteer-core) and Chrome (CHROME_PATH), and
 * one server started from the built app with an EMPTY sandbox database and workspace, e.g.
 *   APPBUILDER_DB_HOST=127.0.0.1 APPBUILDER_DB_PORT=5433 APPBUILDER_DB_NAME=appbuilder_test_envshots \
 *   APPBUILDER_DB_USER=abdev APPBUILDER_DB_PASSWORD=abdev-sandbox-only APPBUILDER_WORKSPACE=/tmp/ws-env PORT=5197 node server/main.ts
 * then  SETUP_CODE=<the code it printed> BASE=http://localhost:5197 node scripts/docs-shots/environments.mjs
 *
 * Steps (each one is checked, the script exits 1 on the first failure):
 *   1. create the first administrator; Default has the sample
 *   2. Admin console > Environments > New environment: "Sales sandbox", Sandbox, copied from Default with data
 *   3. switch to it with the picker; change an app and a table there; Default is unchanged
 *   4. a solution in the sandbox, "Deploy to..." Default with the plan dialog; confirm; Default has the changes
 *   5. lock Default; the Studio opens read-only there and the server refuses design changes
 *   6. delete the sandbox with the typed confirmation
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

const shot = async (name) => {
  if (!SHOTS) return
  await sleep(400)
  await page.screenshot({ path: path.join(OUT, name + '.png') })
  console.log('  wrote', name + '.png')
}
const click = async (sel) => { await page.waitForSelector(sel, { visible: true, timeout: 15000 }); await page.click(sel) }
const type = async (sel, text) => {
  await page.waitForSelector(sel, { visible: true })
  await page.click(sel, { clickCount: 3 })
  await page.keyboard.press('Backspace')
  await page.type(sel, text)
}
async function clickText(text, selector = 'button, [role="menuitem"], [role="radio"], [role="tab"]') {
  const done = await page.evaluate((text, selector) => {
    const el = [...document.querySelectorAll(selector)].find((e) => {
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && (e.textContent || '').replace(/\s+/g, ' ').trim() === text
    })
    if (!el) return false
    el.click()
    return true
  }, text, selector)
  if (!done) fail(`no clickable "${text}"`)
}
const go = async (hash) => { await page.evaluate((h) => { location.hash = h }, hash); await sleep(700) }
/** the app's own API from the page (same session cookie), naming an environment */
const api = (method, p, body, env) => page.evaluate(async (method, p, body, env) => {
  const headers = { 'X-Appbuilder': '1', 'Content-Type': 'application/json' }
  if (env) headers['X-Appbuilder-Environment'] = env
  const r = await fetch('/api/v1' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, data: await r.json().catch(() => null) }
}, method, p, body, env)
const currentEnv = () => page.$eval(tid('env-picker'), (e) => e.getAttribute('data-env'))
const closeToasts = () => page.evaluate(() => document.querySelectorAll('[aria-label="Dismiss"]').forEach((b) => b.click()))

try {
  console.log('1. first administrator')
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
  await go('#home')
  ok((await currentEnv()) === 'default', 'starts in Default')

  console.log('2. create a sandbox copied from Default (schema and data)')
  await go('#admin-environments')
  await click(tid('new-environment'))
  await page.waitForSelector(tid('new-environment-dialog'), { visible: true })
  await type(tid('env-name'), 'Sales sandbox')
  await clickText('Sandbox', '[role="radio"]')
  await type(tid('env-description'), 'Try changes before they reach production')
  await click(tid('env-start-copy'))
  await clickText('Schema and data', '[role="radio"]')
  await shot('environments-create-dialog')
  await click(tid('env-create'))
  await page.waitForSelector(tid('env-row-sales_sandbox'), { visible: true, timeout: 30000 })
  ok(true, 'the sandbox is listed')
  await closeToasts()
  await page.click(tid('env-row-sales_sandbox'))
  await page.waitForSelector(tid('env-detail-sizes'), { visible: true })
  await sleep(800)
  await shot('environments-admin')

  console.log('3. switch with the picker; change an app and a table there')
  await click(tid('env-picker'))
  await page.waitForSelector(tid('env-menu'), { visible: true })
  await shot('environments-picker')
  await click(tid('env-item-sales_sandbox'))
  await page.waitForFunction(() => document.querySelector('[data-testid="env-picker"]')?.getAttribute('data-env') === 'sales_sandbox', { timeout: 15000 })
  ok(true, 'switched to the sandbox')
  ok(await page.$(tid('env-stripe')) !== null, 'the top bar shows the environment colour')
  const ws = (await api('GET', '/workspace', undefined, 'sales_sandbox')).data
  const contacts = ws.tables.find((t) => t.name === 'Contacts')
  const app = ws.apps.find((a) => a.name === 'Contacts app')
  ok(contacts && app, 'the copy has the Contacts table and app')
  ok((await api('POST', `/tables/${contacts.id}/columns`, { displayName: 'Loyalty tier', type: 'choice', choices: ['Gold', 'Silver'] }, 'sales_sandbox')).status === 200, 'a column added in the sandbox')
  const def = (await api('GET', `/apps/${app.id}`, undefined, 'sales_sandbox')).data.definition
  def.screens[0].props.Fill = '=RGBA(255, 248, 230, 1)'
  ok((await api('PUT', `/apps/${app.id}`, { definition: def }, 'sales_sandbox')).status === 200, 'the app changed in the sandbox')
  await go('#tables')
  await page.waitForSelector(tid('tables-list'), { visible: true })
  const dws = (await api('GET', '/workspace', undefined, 'default')).data
  ok(!dws.tables.find((t) => t.id === contacts.id).columns.some((c) => c.name === 'LoyaltyTier'), 'Default does not have the new column')
  const ddef = (await api('GET', `/apps/${app.id}`, undefined, 'default')).data.definition
  ok(ddef.screens[0].props.Fill !== def.screens[0].props.Fill, 'Default still has the old app')

  console.log('4. deploy a solution from the sandbox to Default, with the plan')
  const sol = (await api('POST', '/solutions', { displayName: 'Customer care', version: '1.1.0' }, 'sales_sandbox')).data
  for (const [kind, id] of [['table', contacts.id], ['app', app.id]]) await api('POST', `/solutions/${sol.id}/components`, { kind, id }, 'sales_sandbox')
  // made through the API: reload the page so the client sees it (the environment is remembered on the user record)
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForSelector(tid('portal-root'), { visible: true })
  ok((await currentEnv()) === 'sales_sandbox', 'after a reload the sandbox is still the current environment')
  await go(`#solution-${sol.id}`)
  await click(tid('deploy-solution-button'))
  await page.waitForSelector(tid('deploy-dialog'), { visible: true })
  await page.select(tid('deploy-target'), 'default')
  await click(tid('deploy-review'))
  await page.waitForSelector(tid('solution-plan'), { visible: true, timeout: 15000 })
  ok((await page.$eval(tid('plan-mode'), (e) => e.textContent)) === 'Upgrade in place', 'the plan is an upgrade in place')
  ok(await page.$(tid('plan-item-table-changed')) !== null && await page.$(tid('plan-item-app-changed')) !== null, 'the plan shows the changed table and app')
  await shot('solutions-deploy-plan')
  await click(tid('deploy-confirm'))
  await page.waitForSelector(tid('deploy-dialog'), { hidden: true, timeout: 20000 })
  const after = (await api('GET', '/workspace', undefined, 'default')).data
  ok(after.tables.find((t) => t.id === contacts.id).columns.some((c) => c.name === 'LoyaltyTier'), 'Default has the new column after the deployment')
  ok((await api('GET', `/apps/${app.id}`, undefined, 'default')).data.definition.screens[0].props.Fill === def.screens[0].props.Fill, 'Default has the changed app')
  ok(after.solutions.some((s) => s.id === sol.id && s.version === '1.1.0'), 'the solution is in Default as 1.1.0')

  console.log('5. lock Default; edits are refused there')
  await click(tid('env-picker'))
  await click(tid('env-item-default'))
  await page.waitForFunction(() => document.querySelector('[data-testid="env-picker"]')?.getAttribute('data-env') === 'default', { timeout: 15000 })
  await go('#admin-environments')
  await click(tid('env-row-default'))
  await click(tid('env-lock'))
  await page.waitForFunction(() => document.querySelector('[data-testid="env-picker"] [data-testid="env-type"] [aria-label="locked"]') !== null, { timeout: 15000 })
  ok(true, 'Default shows as locked in the top bar')
  const refused = await api('POST', '/tables', { displayName: 'Not allowed' }, 'default')
  ok(refused.status === 403 && /locked/.test(refused.data.error.message), 'the server refuses a new table in Default')
  ok((await api('PUT', `/apps/${app.id}`, { definition: def }, 'default')).status === 403, 'the server refuses saving the app in Default')
  ok((await api('POST', '/data/Contacts/rows', { values: { Name: 'Still works' } }, 'default')).status === 200, 'data still changes in Default')
  await go(`#studio-${app.id}`)
  await page.waitForSelector(tid('studio-locked'), { visible: true, timeout: 15000 })
  await closeToasts()
  ok((await page.$eval(tid('save-state'), (e) => e.getAttribute('data-state'))) === 'read-only', 'the Studio opens read-only with a banner')
  await shot('environments-locked-studio')
  await go('#home')

  console.log('6. delete the sandbox with the typed confirmation')
  await go('#admin-environments')
  await click(tid('env-row-sales_sandbox'))
  await page.waitForFunction(() => document.querySelector('[data-testid="environment-details"] h3')?.textContent?.startsWith('Sales sandbox'), { timeout: 10000 })
  await closeToasts()
  await sleep(300)
  await click(tid('env-delete'))
  await page.waitForSelector(tid('delete-environment-dialog'), { visible: true })
  ok(await page.$eval(tid('env-delete-confirm'), (e) => e.disabled), 'delete is disabled until the name is typed')
  await type(tid('env-confirm-name'), 'Sales sandbox')
  await click(tid('env-delete-confirm'))
  await page.waitForFunction(() => !document.querySelector('[data-testid="env-row-sales_sandbox"]'), { timeout: 20000 })
  ok((await api('GET', '/environments')).data.items.length === 1, 'only Default is left')
  ok((await api('GET', '/workspace', undefined, 'sales_sandbox')).status === 404, 'the sandbox is gone')
  ok(errors.length === 0, 'no page errors')
  console.log('ALL STEPS PASSED')
} catch (e) {
  console.error('FAILED:', e.message)
  await page.screenshot({ path: '/tmp/env-walkthrough-failure.png' }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
