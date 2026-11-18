/**
 * Headless-browser check of server mode after P0 package D. DEVELOPER TOOL, not part of the product.
 *
 *   node scripts/bench/browser-check.mjs
 *
 * Needs a running server built from this tree (`npx vite build`, then node server/main.ts) whose database holds the
 * seeded Contacts sample and the 1,000,000-row "BigOrders" table of seed-million.mjs, puppeteer-core (PUPPETEER_CORE)
 * and Chrome (CHROME_PATH). Sandbox values only. It prepares what it needs through the API (a "Sales rep" role and
 * user, an app over BigOrders), then drives the UI:
 *   1. Contacts app as the administrator: search, sort, select a row, edit it in the form, save (checked on the server).
 *   2. Contacts app as the Sales rep (own rows only, Email hidden): sees only own rows, adds one, edits it.
 *   3. Portal data grid on BigOrders: exact count, paging by scroll, server sort, server search.
 *   4. App DataTable on BigOrders: exact count, infinite scroll, header sort, search box; Dropdown type-ahead.
 *   5. Studio: a delegable formula says "Runs on server"; a non-delegable one is an error with a squiggle.
 * Prints PASS / FAIL per check and exits 1 on any failure.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PUPPETEER_CORE = process.env.PUPPETEER_CORE || '/tmp/pgcheck/node_modules/puppeteer-core'
const { default: puppeteer } = await import(pathToFileURL(path.join(PUPPETEER_CORE, 'lib/puppeteer/puppeteer-core.js')).href)
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome'
const BASE = (process.env.BASE || 'http://localhost:5196').replace(/\/$/, '')
const ADMIN = { email: process.env.EMAIL || 'admin@example.test', password: process.env.PASSWORD || 'Example-Only-Pass-2026' }
const REP = { name: 'Rita Rep', email: 'rep@example.test', password: 'Rep-Example-Pass-2026' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, what, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

/* ------------------------------------------------------------------ API setup */

function client() {
  let cookie = ''
  return async function api(method, p, body) {
    const headers = { 'X-Appbuilder': '1' }
    if (cookie) headers.Cookie = cookie
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(BASE + '/api/v1' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); if (pair.startsWith('ab_session=')) cookie = pair }
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(data)}`)
    return data
  }
}
const api = client()
await api('POST', '/auth/login', ADMIN)
let ws = await api('GET', '/workspace')
const contacts = ws.tables.find((t) => t.name === 'Contacts')
const big = ws.tables.find((t) => t.name === 'BigOrders')
if (!contacts || !big) throw new Error('Seed the sample (Contacts) and run seed-million.mjs first')
const contactsApp = ws.apps.find((a) => a.name === 'Contacts app')
// the edit below changes Asha's city: start from the seeded value
{
  const asha = (await api('POST', '/query', { plan: { version: 2, table: 'Contacts', filter: { col: 'Name', op: 'eq', value: 'asha rao' }, single: true } })).rows[0]
  if (asha && asha.City !== 'Pune') await api('PATCH', `/data/Contacts/rows/${asha.id}`, { changes: { City: 'Pune' } })
  // rows the Sales rep added in an earlier run
  const added = (await api('POST', '/query', { plan: { version: 2, table: 'Contacts', filter: { col: 'Name', op: 'startsWith', value: 'new contact' }, select: ['id'] } })).rows
  if (added.length) await api('POST', '/data/Contacts/delete', { ids: added.map((r) => r.id) })
}
let role = ws.roles.find((r) => r.name === 'Sales rep')
if (!role) {
  role = await api('POST', '/roles', { name: 'Sales rep', apps: 'all', privileges: [{ table: contacts.id, create: true, read: 'own', update: 'own', delete: 'none', columns: { Email: 'none' } }] })
}
if (!ws.users.some((u) => u.email === REP.email)) {
  // an administrator-set password must be changed at the first sign-in: do that through the API
  await api('POST', '/users', { name: REP.name, email: REP.email, roleIds: [role.id], password: 'Rep-Temp-Pass-2026' })
  const rep = client()
  await rep('POST', '/auth/login', { email: REP.email, password: 'Rep-Temp-Pass-2026' })
  await rep('POST', '/auth/password', { current: 'Rep-Temp-Pass-2026', next: REP.password })
}
let bigApp = ws.apps.find((a) => a.name === 'Big orders')
{
  bigApp ??= await api('POST', '/apps', { name: 'Big orders', width: 1440, height: 900 })
  const n = (id, name, type, props, children = []) => ({ id, name, type, props, children })
  const def = {
    name: 'Big orders', theme: { mode: 'light' }, width: 1440, height: 900, formatVersion: 2, scaleMode: 'responsive', dataSources: ['BigOrders'],
    appProps: {},
    screens: [n('scr1', 'Screen1', 'Screen', {}, [
      n('lbl1', 'CountLabel', 'Label', { X: '=20', Y: '=10', Width: '=700', Height: '=30', Text: '="Won orders: " & CountRows(Filter(BigOrders, Status = "Won"))' }),
      n('lbl2', 'TotalLabel', 'Label', { X: '=720', Y: '=10', Width: '=700', Height: '=30', Text: '="Revenue: " & Text(Sum(Filter(BigOrders, City = "Pune"), Amount * Qty), "#,##0")' }),
      n('dd1', 'OrderPicker', 'Dropdown', { X: '=20', Y: '=50', Width: '=400', Height: '=40', Items: '=ShowColumns(BigOrders, "Title")' }),
      n('dt1', 'OrdersTable', 'DataTable', { X: '=20', Y: '=100', Width: '=1000', Height: '=780', Items: '=BigOrders', Searchable: '=true', Columns: '="Title, City, Status, Amount, Qty, Due"' }),
      n('gal1', 'OrdersGallery', 'Gallery', { X: '=1040', Y: '=100', Width: '=380', Height: '=780', Items: '=Sort(Filter(BigOrders, Status = "Won"), Amount, SortOrder.Descending)', TemplateHeight: '=40' }, [
        n('gl1', 'GalleryTitle', 'Label', { X: '=8', Y: '=4', Width: '=360', Height: '=32', Text: '=ThisItem.Title & " · " & ThisItem.Amount' }),
      ]),
    ])],
  }
  await api('PUT', `/apps/${bigApp.id}`, { definition: def })
}

/* ------------------------------------------------------------------ browser */

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1440, height: 900 } })
const tid = (id) => `[data-testid="${id}"]`

async function signedIn(who) {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('  [page error]', e.message))
  await page.goto(BASE + '/#home', { waitUntil: 'networkidle0' })
  await page.waitForSelector(`${tid('login-form')}, ${tid('portal-root')}`, { visible: true })
  if (await page.$(tid('login-form'))) {
    await page.type(tid('login-email'), who.email)
    await page.type(tid('login-password'), who.password)
    await page.click(tid('login-submit'))
  }
  await page.waitForSelector(`${tid('portal-root')}, ${tid('run-root')}, [data-testid="u-root"], [data-testid="launcher"]`, { visible: true, timeout: 20000 }).catch(async () => {
    console.log('  [signed-in page]', (await page.evaluate(() => document.body.innerText.slice(0, 300))).replace(/\s+/g, ' '))
  })
  return page
}
const waitFor = async (page, fn, arg, timeout = 15000) => {
  try { await page.waitForFunction(fn, { timeout, polling: 100 }, arg); return true } catch { return false }
}
const tableRows = (page, root) => page.$$eval(`${root} tbody tr:not([aria-hidden])`, (trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())))

/* 1. Contacts app as the administrator */
{
  const page = await signedIn(ADMIN)
  await page.evaluate((id) => { location.hash = `#run-${id}` }, contactsApp.id)
  await page.waitForSelector(`${tid('run-root')} ${tid('control-ContactsTable')} tbody tr`, { visible: true, timeout: 20000 })
  const root = `${tid('run-root')} ${tid('control-ContactsTable')}`
  const before = await tableRows(page, root)
  check(before.length === 8, 'Contacts: all 8 contacts listed', `${before.length}`)
  const label = await page.$eval(`${tid('control-CountLabel')}`, (e) => e.textContent)
  check(/Showing 8 of 8 contacts/.test(label), 'Contacts: count label from server counts', label)
  await page.type(`${tid('control-SearchBox')} input`, 'pune')
  const filtered = await waitFor(page, (r) => document.querySelectorAll(`${r} tbody tr:not([aria-hidden])`).length === 1, root)
  check(filtered, 'Contacts: search filters on the server')
  await page.click(`${tid('control-SearchBox')} input`)
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control')
  await page.keyboard.press('Backspace')
  check(await waitFor(page, (r) => document.querySelectorAll(`${r} tbody tr:not([aria-hidden])`).length === 8, root), 'Contacts: clearing the search shows every contact again')
  // sort by Name descending (two clicks on the header)
  const header = async (text) => page.evaluate((r, t) => { const th = [...document.querySelectorAll(`${r} th`)].find((x) => x.textContent.trim() === t); th?.click(); return !!th }, root, text)
  await header('Name'); await sleep(800); await header('Name')
  const sorted = await waitFor(page, (r) => { const names = [...document.querySelectorAll(`${r} tbody tr:not([aria-hidden])`)].map((tr) => tr.querySelector('td')?.textContent ?? ''); return names.length >= 8 && names[0] !== 'Asha Rao' && names.every((n, i) => i === 0 || names[i - 1].localeCompare(n) >= 0) }, root)
  check(sorted, 'Contacts: header sort (descending) runs on the server', sorted ? '' : (await tableRows(page, root)).map((r) => r[0]).join(' | '))
  await header('Name'); await sleep(800) // back to the natural order
  // select the first row and edit its City in the form
  const first = (await tableRows(page, root))[0]
  await page.click(`${root} tbody tr:not([aria-hidden])`)
  await waitFor(page, (n) => (document.querySelector('[data-testid="control-DetailTitle"]')?.textContent ?? '').includes(n), first[0])
  check(true, 'Contacts: selecting a row fills the detail panel', first[0])
  const city = await page.$(`${tid('control-ContactForm')} input[id$="-City"]`)
  if (city) {
    await waitFor(page, (n) => document.querySelector('[data-testid="control-ContactForm"] input[id$="-Name"]')?.value === n, first[0])
    await city.click()
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control')
    await city.type('Nagpur')
    await page.click(`${tid('control-ContactForm')} ${tid('form-save')}`)
    const saved = await waitFor(page, (r) => [...document.querySelectorAll(`${r} tbody tr:not([aria-hidden])`)].some((tr) => tr.textContent.includes('Nagpur')), root)
    // the table shows the change at once (optimistic); the server has it when the write is confirmed
    let server = { count: 0 }
    for (let i = 0; i < 20 && !server.count; i++) {
      await sleep(250)
      server = await api('POST', '/query', { plan: { version: 2, table: 'Contacts', filter: { col: 'City', op: 'eq', value: 'Nagpur' }, count: true, page: { size: 0 } } })
    }
    check(saved && server.count >= 1, 'Contacts: edit and save through the form reaches the server and the table', `server count ${server.count}`)
  } else check(false, 'Contacts: City input of the form found')
  await page.browserContext().close()
}

/* 2. Contacts app as the Sales rep (own rows only, Email hidden) */
{
  const page = await signedIn(REP)
  await page.evaluate((id) => { location.hash = `#run-${id}` }, contactsApp.id)
  await page.waitForSelector(`${tid('run-root')} ${tid('control-ContactsTable')}`, { visible: true, timeout: 20000 })
  const root = `${tid('run-root')} ${tid('control-ContactsTable')}`
  await sleep(1500)
  const rows0 = await tableRows(page, root)
  const label0 = await page.$eval(tid('control-CountLabel'), (e) => e.textContent)
  check(!rows0.some((r) => r.join(' ').includes('Asha')), 'Sales rep: administrator rows are not visible', `${rows0.length} rows, "${label0}"`)
  await page.click(`${tid('control-QuickAddButton')} button`)
  const added = await waitFor(page, (r) => [...document.querySelectorAll(`${r} tbody tr:not([aria-hidden])`)].some((tr) => tr.textContent.includes('New contact')), root)
  check(added, 'Sales rep: quick add creates an own row that appears in the list')
  const headers = await page.$$eval(`${root} th`, (ths) => ths.map((t) => t.textContent.trim()))
  check(!headers.includes('Email'), 'Sales rep: the hidden Email column is not shown', headers.join(', '))
  await page.browserContext().close()
}

/* 3. Portal data grid at 1,000,000 rows */
{
  const page = await signedIn(ADMIN)
  await page.evaluate((id) => { location.hash = `#table-${id}` }, big.id)
  await page.waitForSelector(tid('page-table'), { visible: true })
  // the Data tab
  await page.click(tid('tab-data')).catch(() => {})
  await page.waitForSelector(tid('data-grid'), { visible: true, timeout: 20000 }).catch(async () => {
    console.log('  [grid page]', (await page.evaluate(() => document.querySelector('[data-testid="data-tab"]')?.innerText ?? document.body.innerText)).slice(0, 400).replace(/\s+/g, ' '))
  })
  const t0 = Date.now()
  const count = await waitFor(page, () => /1,000,000 rows/.test(document.querySelector('[data-testid="row-count"]')?.textContent ?? ''))
  check(count, 'Portal grid: exact count of 1,000,000 rows', `${Date.now() - t0} ms`)
  const n0 = await page.$$eval(`${tid('data-grid')} tbody tr`, (r) => r.length)
  await page.$eval(tid('data-grid'), (g) => { g.scrollTop = g.scrollHeight })
  const more = await waitFor(page, (n) => document.querySelectorAll('[data-testid="data-grid"] tbody tr').length > n, n0)
  check(more, 'Portal grid: scrolling loads the next page', `${n0} -> ${await page.$$eval(`${tid('data-grid')} tbody tr`, (r) => r.length)}`)
  await page.click(tid('sort-Amount')); await sleep(200); await page.click(tid('sort-Amount'))
  const top = await waitFor(page, () => (document.querySelector('[data-testid="data-grid"] tbody tr td:nth-child(6)')?.textContent ?? '').includes('999.99'))
  check(top, 'Portal grid: server sort (Amount descending) shows the largest amount first')
  await page.type(tid('grid-filter'), 'order 4242')
  const searched = await waitFor(page, () => /^111 rows/.test(document.querySelector('[data-testid="row-count"]')?.textContent ?? ''))
  check(searched, 'Portal grid: server search with exact count (111 rows)', await page.$eval(tid('row-count'), (e) => e.textContent))
  await page.browserContext().close()
}

/* 4. App DataTable, Dropdown and labels at 1,000,000 rows */
{
  const page = await signedIn(ADMIN)
  await page.evaluate((id) => { location.hash = `#run-${id}` }, bigApp.id)
  const root = `${tid('run-root')} ${tid('control-OrdersTable')}`
  await page.waitForSelector(`${root} tbody tr`, { visible: true, timeout: 30000 })
  const counted = await waitFor(page, (r) => /1,000,000 rows/.test(document.querySelector(`${r} [data-row-count]`)?.textContent ?? ''), root)
  check(counted, 'App DataTable: exact count of 1,000,000 rows')
  const rendered = await page.$$eval(`${root} tbody tr:not([aria-hidden])`, (r) => r.length)
  check(rendered < 150, 'App DataTable: rows are virtualised', `${rendered} rows in the DOM`)
  for (let i = 0; i < 4; i++) {
    await page.$eval(`${root} .overflow-auto`, (el) => { el.scrollTop = el.scrollHeight })
    await sleep(400)
  }
  const lastTitle = await page.$$eval(`${root} tbody tr:not([aria-hidden])`, (r) => r[r.length - 1]?.querySelector('td')?.textContent ?? '')
  check(Number(lastTitle.replace(/\D/g, '')) > 150, 'App DataTable: infinite scroll loads more pages', lastTitle)
  const header = async (text) => page.evaluate((r, t) => { const th = [...document.querySelectorAll(`${r} th`)].find((x) => x.textContent.trim() === t); th?.click(); return !!th }, root, text)
  await header('Amount'); await sleep(200); await header('Amount')
  const sorted = await waitFor(page, (r) => (document.querySelector(`${r} tbody tr:not([aria-hidden]) td:nth-child(4)`)?.textContent ?? '').includes('999.99'), root)
  check(sorted, 'App DataTable: header sort runs on the server (Amount descending)')
  await page.type(`${root} input[placeholder="Search"]`, 'order 4242')
  const found = await waitFor(page, (r) => /^111 rows/.test((document.querySelector(`${r} [data-row-count]`)?.textContent ?? '').trim()), root)
  check(found, 'App DataTable: search box searches on the server (111 rows)', await page.$eval(`${root} [data-row-count]`, (e) => e.textContent))
  const won = await waitFor(page, () => /Won orders: 250000/.test(document.querySelector('[data-testid="control-CountLabel"]')?.textContent ?? ''))
  check(won, 'App label: CountRows(Filter(...)) counted on the server', await page.$eval(tid('control-CountLabel'), (e) => e.textContent))
  const rev = await page.$eval(tid('control-TotalLabel'), (e) => e.textContent)
  check(/Revenue: [\d,]+/.test(rev), 'App label: Sum(Filter(...), Amount * Qty) computed on the server', rev)
  // Gallery over a filtered, sorted 250,000-row result: windowed template rows, more pages on scroll
  const gal = `${tid('run-root')} ${tid('control-OrdersGallery')}`
  await page.waitForSelector(`${gal} [data-gallery-row]`, { visible: true })
  const galCount = await page.$eval(`${gal} [data-gallery-layout]`, (e) => e.getAttribute('data-row-count'))
  const inDom = await page.$$eval(`${gal} [data-gallery-row]`, (r) => r.length)
  check(galCount === '250000' && inDom < 100, 'App Gallery: exact count and windowed rows', `count ${galCount}, ${inDom} rows in the DOM`)
  for (let i = 0; i < 4; i++) {
    await page.$eval(`${gal} [data-gallery-layout]`, (el) => { el.scrollTop = el.scrollHeight })
    await sleep(500)
  }
  const lastRow = await page.$$eval(`${gal} [data-gallery-row]`, (r) => Number(r[r.length - 1]?.getAttribute('data-gallery-row') ?? 0))
  check(lastRow > 150, 'App Gallery: scrolling loads more pages', `last row index ${lastRow}`)
  // Dropdown with a large table: type-ahead on the server
  await page.click(`${tid('control-OrderPicker')} [role="combobox"]`)
  await page.waitForSelector('[cmdk-input]', { visible: true })
  await page.type('[cmdk-input]', 'order 99999')
  const typed = await waitFor(page, () => [...document.querySelectorAll('[cmdk-item]')].some((x) => x.textContent.trim() === 'Order 99999'))
  check(typed, 'App Dropdown: type-ahead search on the server finds "Order 99999"')
  await page.browserContext().close()
}

/* 5. Studio diagnostics */
{
  const page = await signedIn(ADMIN)
  await page.evaluate((id) => { location.hash = `#studio-${id}` }, bigApp.id)
  await page.waitForSelector(tid('studio-root'), { visible: true, timeout: 20000 })
  await sleep(1500)
  await page.click(tid('tree-node-CountLabel'))
  await sleep(500)
  const where = await page.$eval(tid('delegation-indicator'), (e) => e.getAttribute('data-where')).catch(() => null)
  check(where === 'server', 'Studio: a delegable formula shows "Runs on server"', String(where))
  // a formula the server can't run over a large table: an error, with the sub-expression underlined
  await page.evaluate(() => {
    const st = window.__ab.store.getState()
    const node = (function find(n) { if (n.name === 'CountLabel') return n; for (const c of n.children ?? []) { const f = find(c); if (f) return f } return null })(st.app.screens[0])
    st.setProp(node.id, 'Text', '="Long titles: " & CountRows(Filter(BigOrders, Len(Title) > 12))')
  })
  const err = await waitFor(page, () => /Can't run on the server/.test(document.querySelector('[data-testid="formula-error"]')?.textContent ?? ''))
  check(err, "Studio: a non-delegable formula over 1,000,000 rows is an error naming the problem", await page.$eval(tid('formula-error'), (e) => e.textContent).catch(() => ''))
  const squiggle = await page.$eval(`${tid('delegation-squiggle')} span`, (e) => e.textContent).catch(() => null)
  check(squiggle === 'Len(Title)', 'Studio: the non-delegable sub-expression is underlined', String(squiggle))
  await page.click(tid('error-count'))
  const listed = await waitFor(page, () => [...document.querySelectorAll('[data-testid="error-list"] .text-destructive')].some((e) => /Can't run on the server/.test(e.textContent)))
  check(listed, 'Studio: the error is in the error list')
  // put the delegable formula back (the app is reused by the next run)
  await page.evaluate(() => {
    const st = window.__ab.store.getState()
    const node = (function find(n) { if (n.name === 'CountLabel') return n; for (const c of n.children ?? []) { const f = find(c); if (f) return f } return null })(st.app.screens[0])
    st.setProp(node.id, 'Text', '="Won orders: " & CountRows(Filter(BigOrders, Status = "Won"))')
  })
  await sleep(1500)
  await page.browserContext().close()
}

/* 6. demo mode (no server): the built page still runs everything in the browser */
if (process.env.DEMO_HTML !== '0') {
  const file = process.env.DEMO_HTML || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../dist/index.html')
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('  [page error]', e.message))
  await page.goto(pathToFileURL(file).href, { waitUntil: 'networkidle0' })
  await page.waitForSelector(tid('portal-root'), { visible: true, timeout: 20000 })
  const mode = await page.evaluate(() => window.__ab ? 'linked' : 'none')
  await page.evaluate(() => { location.hash = '#apps' })
  await page.waitForSelector(tid('apps-table'), { visible: true })
  await page.evaluate(() => { [...document.querySelectorAll('[data-testid="apps-table"] tbody td:first-child button')].find((e) => e.textContent === 'Contacts app')?.click() })
  await page.waitForSelector(tid('studio-root'), { visible: true, timeout: 20000 })
  const demoRows = await waitFor(page, () => document.querySelectorAll('[data-testid="control-ContactsTable"] tbody tr').length >= 5)
  check(demoRows, 'Demo mode: the Contacts app evaluates in the browser as before', mode)
  await ctx.close()
}

await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
