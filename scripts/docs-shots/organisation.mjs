/**
 * Organisation, relationship rules and sharing in a headless browser: the end-to-end check of P0 package F and the
 * screenshots of docs/admin/organisation.md and docs/admin/users-and-roles.md. DEVELOPER TOOL, not part of the product.
 *
 * Needs puppeteer-core (PUPPETEER_CORE, default /tmp/pgcheck/node_modules/puppeteer-core) and Chrome (CHROME_PATH), and
 * one server started from the built app with an EMPTY sandbox database and workspace, e.g.
 *   APPBUILDER_DB_HOST=127.0.0.1 APPBUILDER_DB_PORT=5433 APPBUILDER_DB_NAME=appbuilder_test_orgshots \
 *   APPBUILDER_DB_USER=abdev APPBUILDER_DB_PASSWORD=abdev-sandbox-only APPBUILDER_WORKSPACE=/tmp/ws-org PORT=5233 node server/main.ts
 * then  SETUP_CODE=<the code it printed> BASE=http://localhost:5233 node scripts/docs-shots/organisation.mjs
 *
 * Steps (each one is checked; exit 1 on the first failure):
 *   1. first administrator; departments PLANT1 > LINE1, LINE2 (API), the Departments page
 *   2. Import users from CSV in the dialog: preview, import, the one-time passwords; Teams page (a team made in the dialog);
 *      Org chart
 *   3. tables Lines and Production (sharing, team ownership) with rows owned by the operators
 *   4. role "Supervisor" made in the role editor: Read All with the rule "Line > Supervisor is the current user"
 *      (rule builder); "Plant manager" with the Department tree scope and "Operator" with Team (API)
 *   5. Who can see a row? and Test as user (with the reasons)
 *   6. a restricted session: the supervisor sees only the rows of their line; the operator shares a row with the team
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const PUPPETEER_CORE = process.env.PUPPETEER_CORE || '/tmp/pgcheck/node_modules/puppeteer-core'
const { default: puppeteer } = await import(pathToFileURL(path.join(PUPPETEER_CORE, 'lib/puppeteer/puppeteer-core.js')).href)
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome'
const BASE = (process.env.BASE || 'http://localhost:5233').replace(/\/$/, '')
const OUT = process.env.OUT || path.join(root, 'docs', 'images')
const SHOTS = process.env.SHOTS !== '0'
const ADMIN = { name: 'Test Admin', email: 'admin@example.test', password: 'Example-Only-Pass-2026' }
fs.mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (id) => `[data-testid="${id}"]`
const fail = (m) => { throw new Error(m) }
const ok = (cond, m) => { if (!cond) fail(m); console.log('  ok:', m) }

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'] })
const errors = []
async function newPage(ctx) {
  const page = await (ctx ?? browser).newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('appbuilder-theme', 'light') } catch { /* ignore */ } })
  page.on('pageerror', (e) => { errors.push(e.message); console.log('  [page error]', e.message) })
  return page
}
let page = await newPage()

const shot = async (name, p = page) => {
  if (!SHOTS) return
  await sleep(500)
  await p.screenshot({ path: path.join(OUT, name + '.png') })
  console.log('  wrote', name + '.png')
}
const click = async (sel, p = page) => { await p.waitForSelector(sel, { visible: true, timeout: 15000 }); await p.click(sel) }
const type = async (sel, text, p = page) => {
  await p.waitForSelector(sel, { visible: true })
  await p.click(sel, { clickCount: 3 })
  await p.keyboard.press('Backspace')
  await p.type(sel, text)
}
async function clickText(text, selector = 'button, [role="menuitem"], [role="option"], [role="radio"], [role="tab"]', p = page) {
  for (let i = 0; i < 20; i++) {
    const done = await p.evaluate((text, selector) => {
      const el = [...document.querySelectorAll(selector)].find((e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && (e.textContent || '').replace(/\s+/g, ' ').trim().startsWith(text)
      })
      if (!el) return false
      el.click()
      return true
    }, text, selector)
    if (done) return
    await sleep(200)
  }
  fail(`no clickable "${text}"`)
}
const go = async (hash, p = page) => { await p.evaluate((h) => { location.hash = h }, hash); await sleep(800) }
const api = (method, p, body, pg = page) => pg.evaluate(async (method, p, body) => {
  const r = await fetch('/api/v1' + p, { method, headers: { 'X-Appbuilder': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, data: await r.json().catch(() => null) }
}, method, p, body)
const closeToasts = (p = page) => p.evaluate(() => document.querySelectorAll('[aria-label="Dismiss"]').forEach((b) => b.click()))
/** choose an option of a Radix select: open its trigger, click the option text */
async function pick(triggerSel, optionText, p = page) {
  await click(triggerSel, p)
  await clickText(optionText, '[role="option"]', p)
  await sleep(200)
}

try {
  console.log('1. administrator, departments')
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
  const plant = (await api('POST', '/departments', { code: 'PLANT1', name: 'Pune plant' })).data
  for (const [code, name] of [['LINE1', 'Assembly line 1'], ['LINE2', 'Assembly line 2'], ['QC', 'Quality control']]) {
    ok((await api('POST', '/departments', { code, name, parentId: plant.id })).status === 200, `department ${code}`)
  }
  await page.reload({ waitUntil: 'networkidle0' })
  await go('#admin-departments')
  await page.waitForSelector(tid('dept-LINE1'), { visible: true })
  await shot('organisation-departments')

  console.log('2. import users from CSV, teams, org chart')
  await go('#admin-users')
  await click(tid('import-users-button'))
  const csv = [
    'name,email,department,manager,jobTitle,employeeCode',
    'Asha Rao,asha@example.test,PLANT1,,Plant manager,E001',
    'Ravi Kumar,ravi@example.test,LINE1,asha@example.test,Supervisor,E002',
    'Meena Iyer,meena@example.test,LINE2,asha@example.test,Supervisor,E003',
    'Arjun Das,arjun@example.test,LINE1,ravi@example.test,Operator,E004',
    'Kiran Shah,kiran@example.test,LINE2,meena@example.test,Operator,E005',
  ].join('\n')
  await page.waitForSelector(tid('user-import-csv'), { visible: true })
  await page.$eval(tid('user-import-csv'), (el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, csv)
  await click(tid('user-import-check'))
  await page.waitForSelector(tid('user-import-preview'), { visible: true })
  await shot('organisation-import-preview')
  await click(tid('user-import-commit'))
  await page.waitForSelector(tid('user-import-passwords'), { visible: true })
  const passwords = await page.$$eval(`${tid('user-import-passwords')} tbody tr`, (trs) => Object.fromEntries(trs.map((tr) => [tr.children[0].textContent, tr.children[1].textContent])))
  ok(Object.keys(passwords).length === 5, 'five users with one-time passwords')
  await shot('organisation-import-passwords')
  await page.keyboard.press('Escape')
  await sleep(500)
  const ws = (await api('GET', '/workspace')).data
  const uid = (email) => ws.users.find((u) => u.email === email).id
  ok(ws.users.find((u) => u.email === 'arjun@example.test').managerId === uid('ravi@example.test'), 'managers set by the import')
  await go('#admin-teams')
  await click(tid('new-team'))
  await type(tid('team-code'), 'CREW-A')
  await type(tid('team-name'), 'Assembly crew A')
  await click(tid(`team-member-${uid('arjun@example.test')}`))
  await click(tid(`team-member-${uid('kiran@example.test')}`))
  await shot('organisation-team-dialog')
  await click(tid('team-save'))
  await page.waitForSelector(tid('team-CREW-A'), { visible: true })
  await closeToasts()
  await shot('organisation-teams')
  await go('#admin-orgchart')
  await page.waitForSelector(tid('org-tree'), { visible: true })
  await shot('organisation-org-chart')

  console.log('3. tables with rows owned by the operators')
  const sys = []
  const lines = (await api('POST', '/tables', { displayName: 'Lines', columns: [{ displayName: 'Name', type: 'text' }, { displayName: 'Supervisor', type: 'text' }] })).data
  const prod = (await api('POST', '/tables', { displayName: 'Production', columns: [{ displayName: 'Batch', type: 'text' }, { displayName: 'Line', type: 'lookup', lookupTable: 'Lines' }, { displayName: 'Qty', type: 'number' }] })).data
  ok(lines.id && prod.id, 'tables created')
  void sys
  ok((await api('PATCH', `/tables/${prod.id}`, { sharing: true, teamOwnership: true })).status === 200, 'sharing and team ownership on')
  const l1 = (await api('POST', '/data/Lines/rows', { values: { Name: 'Line 1', Supervisor: uid('ravi@example.test') } })).data.row
  const l2 = (await api('POST', '/data/Lines/rows', { values: { Name: 'Line 2', Supervisor: uid('meena@example.test') } })).data.row
  const batches = [['B-101', l1.id, 120, 'arjun@example.test'], ['B-102', l1.id, 80, 'arjun@example.test'], ['B-201', l2.id, 95, 'kiran@example.test'], ['B-202', l2.id, 60, 'kiran@example.test'], ['B-103', l1.id, 40, 'ravi@example.test']]
  for (const [Batch, Line, Qty, who] of batches) {
    const r = (await api('POST', '/data/Production/rows', { values: { Batch, Line, Qty } })).data.row
    const pr = await api("PATCH", `/data/Production/rows/${r.id}`, { changes: { owner: uid(who) } })
    ok(pr.status === 200, `${Batch} owned by ${who} ${pr.status === 200 ? "" : JSON.stringify(pr.data)}`)
  }

  console.log('4. roles: Supervisor through the rule builder; Plant manager and Operator through the API')
  await page.reload({ waitUntil: 'networkidle0' })
  await go('#roles')
  await click(tid('new-role-button'))
  await type(tid('new-role-name'), 'Supervisor')
  await click(tid('new-role-create'))
  await sleep(1000)
  await pick(tid(`priv-${prod.id}-read`), 'All')
  await pick(tid(`priv-${prod.id}-update`), 'All')
  await click(tid(`matrix-detail-${prod.id}`))
  await clickText('Row rules', '[role="radio"]')
  await click(tid('rf-add'))
  await pick(tid('rf-0-path-0'), 'Line')
  await pick(tid('rf-0-path-1'), 'Supervisor')
  await sleep(300)
  const sentence = await page.$eval(tid('role-rowfilter-preview'), (e) => e.textContent)
  ok(sentence.includes('Line > Supervisor is the current user'), `plain-language sentence: ${sentence}`)
  await page.$eval(tid('table-rules'), (e) => e.scrollIntoView({ block: 'center' }))
  await shot('roles-rule-builder')
  await closeToasts()
  await click(tid('rf-save'))
  let sup
  for (let i = 0; i < 20; i++) {
    await sleep(300)
    sup = (await api('GET', '/workspace')).data.roles.find((r) => r.name === 'Supervisor')
    if (sup.privileges.find((p) => p.table === prod.id)?.rowFilter) break
  }
  const rf = sup.privileges.find((p) => p.table === prod.id).rowFilter
  ok(rf?.length === 1 && rf[0].column === 'Line.Supervisor' && rf[0].op === 'eq' && rf[0].value === '@me', `the rule was saved as a lookup path: ${JSON.stringify(sup.privileges.find((p) => p.table === prod.id))}`)
  const priv = (t, p) => ({ table: t, create: false, read: 'none', update: 'none', delete: 'none', ...p })
  const pm = (await api('POST', '/roles', { name: 'Plant manager', apps: 'all', privileges: [priv(prod.id, { read: 'departmentTree' }), priv(lines.id, { read: 'all' })] })).data
  const op = (await api('POST', '/roles', { name: 'Operator', apps: 'all', privileges: [priv(prod.id, { create: true, read: 'team', update: 'own', share: 'own' }), priv(lines.id, { read: 'all' })] })).data
  ok((await api('PATCH', `/roles/${sup.id}`, { privileges: [...sup.privileges.filter((p) => p.table !== lines.id), priv(lines.id, { read: 'all' })] })).status === 200, 'supervisor reads lines')
  // the grid of the portal is a maker page: Supervisor and Operator are makers here, which grants no data rights (the rows
  // they see are still decided by their table privileges)
  ok((await api('PATCH', `/roles/${sup.id}`, { isMaker: true })).status === 200 && (await api('PATCH', `/roles/${op.id}`, { isMaker: true })).status === 200, 'supervisor and operator open the portal grid')
  for (const [email, role] of [['asha@example.test', pm.id], ['ravi@example.test', sup.id], ['meena@example.test', sup.id], ['arjun@example.test', op.id], ['kiran@example.test', op.id]]) {
    ok((await api('PATCH', `/users/${uid(email)}`, { roleIds: [role] })).status === 200, `${email} has a role`)
  }
  await page.reload({ waitUntil: 'networkidle0' })
  await go('#roles')
  await sleep(800)
  await shot('roles-scopes')

  console.log('5. who can see a row, test as user')
  await click(tid('who-can-see-button'))
  await page.waitForSelector(tid('who-can-see-dialog'), { visible: true })
  await page.select(tid('who-table'), prod.id)
  let rowId
  for (let i = 0; i < 30 && !rowId; i++) {
    await sleep(300)
    rowId = await page.$eval(tid('who-row'), (sel) => [...sel.options].find((o) => o.textContent === 'B-101')?.value)
  }
  ok(!!rowId, 'the row list of Production loaded')
  await page.select(tid('who-row'), rowId)
  await page.waitForSelector(tid('who-table-result'), { visible: true, timeout: 15000 })
  const who = await page.$eval(tid('who-table-result'), (t) => t.textContent)
  ok(who.includes('Ravi Kumar') && who.includes('Asha Rao') && who.includes('Arjun Das') && !who.includes('Meena Iyer'), 'B-101: supervisor of line 1, plant manager, its owner; not the other supervisor')
  await shot('roles-who-can-see')
  await page.keyboard.press('Escape')
  await sleep(400)
  await click(tid('test-as-user-button'))
  await page.waitForSelector(tid('test-as-user-dialog'), { visible: true })
  await page.select(tid('preview-user'), uid('asha@example.test'))
  await page.waitForSelector(tid(`preview-why-${prod.id}`), { visible: true, timeout: 15000 })
  const why = await page.$eval(tid(`preview-why-${prod.id}`), (e) => e.textContent)
  ok(why.includes('department'), `test as user says why: ${why}`)
  await shot('roles-test-as-user-why')
  await page.keyboard.press('Escape')

  console.log('6. restricted sessions')
  const signIn = async (email) => {
    const ctx = await browser.createBrowserContext()
    const p = await newPage(ctx)
    await p.goto(BASE + '/#home', { waitUntil: 'networkidle0' })
    const first = passwords[email]
    const next = `New-${first}-x`
    const r = await api('POST', '/auth/login', { email, password: first }, p)
    ok(r.status === 200, `${email} signs in with the temporary password`)
    ok((await api('POST', '/auth/password', { current: first, next }, p)).status === 200, `${email} chooses a new password`)
    await p.goto(BASE + '/#tables', { waitUntil: 'networkidle0' })
    if (await p.$(tid('login-form'))) {
      await type(tid('login-email'), email, p)
      await type(tid('login-password'), next, p)
      await click(tid('login-submit'), p)
    }
    try {
      await p.waitForSelector(tid('portal-root'), { visible: true })
    } catch (e) {
      await p.screenshot({ path: '/tmp/orgshots-signin.png' })
      throw e
    }
    return p
  }
  const ravi = await signIn('ravi@example.test')
  await go(`#table-${prod.id}`, ravi)
  await ravi.waitForSelector('[data-testid^="row-"]', { visible: true, timeout: 15000 })
  await sleep(800)
  const raviRows = await ravi.$$eval('tbody tr[data-testid^="row-"]', (trs) => trs.map((t) => t.textContent))
  ok(raviRows.length === 3 && raviRows.every((t) => t.includes('B-10')), `the line 1 supervisor sees the 3 batches of line 1 (${raviRows.length})`)
  await shot('restricted-supervisor-grid', ravi)
  const arjun = await signIn('arjun@example.test')
  await go(`#table-${prod.id}`, arjun)
  await arjun.waitForSelector('[data-testid^="row-"]', { visible: true, timeout: 15000 })
  await sleep(800)
  const arjunRows = await arjun.$$eval('tbody tr[data-testid^="row-"]', (trs) => trs.length)
  ok(arjunRows === 4, `the operator sees the batches of their crew (own and Kiran's): ${arjunRows}`)
  const first = await arjun.$eval('[data-testid^="row-menu-"]', (b) => b.getAttribute('data-testid').slice('row-menu-'.length))
  await click(tid(`row-menu-${first}`), arjun)
  await click(tid(`row-share-${first}`), arjun)
  await arjun.waitForSelector(tid('share-who'), { visible: true, timeout: 15000 })
  await arjun.select(tid('share-who'), uid('meena@example.test'))
  await shot('share-dialog', arjun)
  await click(tid('share-add'), arjun)
  await arjun.waitForSelector(tid(`share-${uid('meena@example.test')}`), { visible: true, timeout: 15000 })
  ok(true, 'the operator shared a row with the other supervisor')
  ok(errors.length === 0, 'no page errors')
  console.log('done')
} catch (e) {
  console.error('FAILED:', e.message)
  try { await page.screenshot({ path: '/tmp/orgshots-failure.png' }) } catch { /* ignore */ }
  process.exitCode = 1
} finally {
  await browser.close()
}
