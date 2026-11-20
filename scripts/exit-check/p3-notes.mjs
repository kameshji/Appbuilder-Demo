#!/usr/bin/env node
/**
 * Notes (P3 package N, exit check 9's notes part) against a REAL server and a real browser. DEVELOPER TOOL (sandbox
 * values only), not part of the product. Re-runnable.
 *
 *   npm run build   (the server serves dist/)
 *   node scripts/exit-check/p3-notes.mjs
 *
 * A server runs in this process (EXIT_PORT, default 5278) on an EMPTY database (EXIT_DB_NAME, default appbuilder_exit_n:
 * created and dropped here; KEEP=1 keeps it). Jobs are drained by hand (app.services.kernel.drain()).
 *
 * People: Bob writes the note (he reads Orders), Cy gets a read share (through the mention's share offer), Di an edit
 * share (she also reads Orders), Fay is in the team "Quality" it is shared with, Eve is a bystander (no share, no Orders).
 *
 *  1. Bob writes a note on the screen: a heading, bold text, a bulleted list, a checklist, a table, a record card, an image
 *     and a file, Devanagari text (typed, and committed through an input-method composition), and a mention of Cy: Cy
 *     cannot read it, so the page offers to share it with her first; the stored body has each of these and nothing else;
 *  2. hostile HTML pasted into the editor and sent straight to the API is stored sanitised (no script, no handler, no
 *     javascript: URL, no style) and never runs in the page;
 *  3. the mention notifies Cy with a link that opens the note; Eve cannot be mentioned (422) and cannot open it;
 *  4. sharing (the Share dialog): read for Cy, edit for Di, read for the team Quality; each can do exactly that, Fay opens
 *     it through the team, Eve sees nothing: not in the list, not in search, not at its address, not through the query
 *     API, and no response to her contains the note's text;
 *  5. two tabs editing the same note: the second save does not overwrite, the conflict choice appears, "Keep mine" saves;
 *  6. a note about a record (`#u-notes?new=1&table=&row=`, the record timeline's link): on the record's timeline for Di
 *     (a reader of the record), not for Eve (the timeline answers 404), and the card resolves for each reader;
 *  7. quick note from the shell; print shows only the note;
 *  8. phone width (360 px, touch): list and editor fit without sideways scrolling, touch targets of 44 px, a tap and
 *     typing edit the note, the editor leaves room for the on-screen keyboard (--kb);
 *  9. no script errors in the browser.
 *
 * Settings: EXIT_DB_HOST (127.0.0.1), EXIT_DB_PORT (5435), EXIT_DB_USER (abdev), EXIT_DB_PASSWORD (abdev-sandbox-only),
 * EXIT_DB_NAME (appbuilder_exit_n), EXIT_MAINT_DB (appbuilder_test), EXIT_PORT (5278), EXIT_WORKSPACE (a new temp folder),
 * PUPPETEER_CORE, CHROME_PATH, SHOTS (screenshots).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { chromePath, puppeteerCorePath } from './browser-env.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const DB = { host: E.EXIT_DB_HOST || '127.0.0.1', port: Number(E.EXIT_DB_PORT || 5435), user: E.EXIT_DB_USER || 'abdev', password: E.EXIT_DB_PASSWORD || 'abdev-sandbox-only', database: E.EXIT_DB_NAME || 'appbuilder_exit_n' }
const MAINT = E.EXIT_MAINT_DB || 'appbuilder_test'
const PORT = Number(E.EXIT_PORT || 5278)
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = E.SHOTS || ''
const ADMIN = { name: 'Exit Admin', email: 'exit-admin@example.test', password: 'Exit-Example-Pass-2026' }
const PEOPLE = {
  bob: { name: 'Bob Builder', email: 'bob@example.test', password: 'Bob-Example-Pass-2026', orders: true },
  cy: { name: 'Cy Reader', email: 'cy@example.test', password: 'Cy-Example-Pass-2026' },
  di: { name: 'Di Editor', email: 'di@example.test', password: 'Di-Example-Pass-2026', orders: true },
  fay: { name: 'Fay Quality', email: 'fay@example.test', password: 'Fay-Example-Pass-2026' },
  eve: { name: 'Eve Bystander', email: 'eve@example.test', password: 'Eve-Example-Pass-2026' },
}
const SECRET = 'Quokkapassword'
if (!/^(ab_s\d+|appbuilder_exit)/.test(DB.database)) { console.error('The database name must start with ab_s<n> or appbuilder_exit (it is dropped).'); process.exit(2) }
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) { console.error('Build the app first (npm run build).'); process.exit(2) }

const imp = (p) => import(pathToFileURL(path.join(root, p)).href)
const { createApp } = await imp('server/core/app.ts')
const { serveStatic } = await imp('server/core/static.ts')
const { setQuiet } = await imp('server/core/util.ts').catch(() => ({ setQuiet: null }))
const { Client } = await imp('server/core/kernel-testkit.ts')
const { default: puppeteer } = await import(pathToFileURL(path.join(puppeteerCorePath(root), 'lib/puppeteer/puppeteer-core.js')).href)
if (setQuiet) setQuiet(true)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`)
const results = []
const record = (name, ok, evidence = '') => { results.push({ name, ok, evidence }); log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence ? `: ${evidence}` : ''}`) }
const check = (cond, name, evidence) => { record(name, !!cond, evidence); if (!cond) throw new Error(`check failed: ${name} ${evidence ?? ''}`) }

async function maint(sql) {
  const c = new pg.Client({ ...DB, database: MAINT })
  await c.connect()
  try { await c.query(sql) } finally { await c.end() }
}
async function q(sql, params = []) {
  const c = new pg.Client(DB)
  await c.connect()
  try { return (await c.query(sql, params)).rows } finally { await c.end() }
}

const DIR = E.EXIT_WORKSPACE ? path.resolve(E.EXIT_WORKSPACE) : fs.mkdtempSync(path.join(os.tmpdir(), 'ab-exit-notes-'))
if (E.EXIT_WORKSPACE) {
  if (path.resolve(DIR) === root || !/workspace/i.test(path.basename(DIR))) { console.error('EXIT_WORKSPACE must be a folder named ...workspace... (it is emptied).'); process.exit(2) }
  fs.rmSync(DIR, { recursive: true, force: true })
}
fs.mkdirSync(DIR, { recursive: true })
let app = null
let server = null
async function start() {
  app = await createApp({ env: { APPBUILDER_MIGRATION_BACKUP: 'skip' }, config: { workspaceDir: DIR }, printSetupCode: false, jobs: false })
  server = http.createServer((req, res) => {
    app.handle(req, res).then((h) => { if (!h) serveStatic(app.config.distDir ?? path.join(root, 'dist'), req, res) }, () => { if (!res.headersSent) res.writeHead(500); res.end() })
  })
  server.on('upgrade', (req, socket, head) => { if (!app.handleUpgrade(req, socket, head)) socket.destroy() })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
}
async function stop() {
  if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(() => r())); server = null }
  if (app) { await app.close(); app = null }
}
const admin = new Client(BASE)
const cl = Object.fromEntries(Object.keys(PEOPLE).map((k) => [k, new Client(BASE)]))
async function api(c, method, p, body) {
  const r = await c.req(method, p, body)
  if (r.status !== 200) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`)
  return r.data
}
const login = (c, u) => api(c, 'POST', '/auth/login', { email: u.email, password: u.password })
const drain = () => app.services.kernel.drain({ timeoutMs: 20_000 }).catch(() => undefined)
const bodyOf = async (id) => String((await q('SELECT "Body" FROM env_default.sys_activities WHERE id = $1', [id]).catch(async () => {
  const t = (await q(`SELECT table_schema AS s FROM information_schema.columns WHERE table_name = 'sys_activities' AND column_name = 'Body' LIMIT 1`))[0]
  return q(`SELECT "Body" FROM "${t.s}".sys_activities WHERE id = $1`, [id])
}))[0]?.Body ?? '')

let browser = null
const T = (id) => `[data-testid="${id}"]`
const errors = []
async function shot(page, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }) } }
const waitFor = (page, sel, timeout = 20000) => page.waitForSelector(sel, { visible: true, timeout })
async function click(page, sel) { await page.waitForSelector(`${sel}:not([disabled])`, { visible: true, timeout: 20000 }); await sleep(120); await (await waitFor(page, sel)).click() }
async function newPage(ctx, viewport = { width: 1400, height: 900 }) {
  const page = await ctx.newPage()
  await page.setViewport(viewport)
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.accept())
  return page
}
async function signIn(page, who) {
  await page.goto(`${BASE}/#u`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[type=email]', { timeout: 20000 })
  await page.type('input[type=email]', who.email)
  await page.type('input[type=password]', who.password)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 30000 })
  await sleep(500)
}
const saved = (page, timeout = 20000) => page.waitForFunction(() => document.querySelector('[data-testid="note-status"]')?.dataset.state === 'saved', { timeout })
/** puts the caret at the end of the note body */
const caretToEnd = (page) => page.evaluate(() => {
  const el = document.querySelector('[data-testid="note-body"]')
  el.focus()
  const r = document.createRange()
  r.selectNodeContents(el)
  r.collapse(false)
  const s = getSelection()
  s.removeAllRanges()
  s.addRange(r)
})
// a 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

let failed = false
try {
  await maint(`DROP DATABASE IF EXISTS "${DB.database}"`)
  await start()
  const setupCode = app.services.setupCode.current() ?? ''
  await api(admin, 'POST', '/setup/database', { setupCode, host: DB.host, port: DB.port, database: DB.database, user: DB.user, password: DB.password, createDatabase: true })
  await api(admin, 'POST', '/setup/admin', { setupCode, ...ADMIN })
  await login(admin, ADMIN)
  const orders = await api(admin, 'POST', '/tables', { displayName: 'Orders', columns: [{ displayName: 'Title', type: 'text' }] })
  const staff = await api(admin, 'POST', '/roles', { name: 'Staff', apps: 'all', privileges: [] })
  const readers = await api(admin, 'POST', '/roles', { name: 'Order readers', apps: 'all', privileges: [{ table: orders.id, create: true, read: 'all', update: 'all', delete: 'none' }] })
  const ids = {}
  for (const [k, u] of Object.entries(PEOPLE)) {
    const rec = await api(admin, 'POST', '/users', { name: u.name, email: u.email, password: u.password, roleIds: u.orders ? [staff.id, readers.id] : [staff.id] })
    ids[k] = rec.id ?? rec.user?.id
    await q('UPDATE ab.users SET must_change_password = false WHERE id = $1', [ids[k]])
  }
  const team = await api(admin, 'POST', '/teams', { name: 'Quality', code: 'quality', memberIds: [ids.fay], environmentId: 'default' })
  for (const [k, u] of Object.entries(PEOPLE)) await login(cl[k], u)
  const order = (await api(cl.bob, 'POST', `/data/${orders.id}/rows`, { values: { Title: 'Order for Pune' } })).row
  record('setup', true, 'Bob (Orders), Cy, Di (Orders), Fay (team Quality), Eve; one order')

  browser = await puppeteer.launch({ executablePath: chromePath(E), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1400,900'] })
  const ctx = Object.fromEntries(await Promise.all(Object.keys(PEOPLE).map(async (k) => [k, await browser.createBrowserContext()])))

  /* ---------------------------------------------------------------- 1. Bob writes a note */
  log('1. writing a note')
  const pb = await newPage(ctx.bob)
  await signIn(pb, PEOPLE.bob)
  await pb.goto(`${BASE}/#u-notes`, { waitUntil: 'domcontentloaded' })
  await waitFor(pb, T('notes-page'))
  check(await pb.$(T('nav-notes')), 'the Notes module is live in the User menu (not "coming soon")')
  await click(pb, T('notes-new'))
  await waitFor(pb, T('note-body'))
  await saved(pb)
  const noteId = await pb.$eval(T('note-panel'), (e) => e.dataset.noteId)
  await pb.$eval(T('note-title'), (e) => { e.focus(); e.select() })
  await pb.type(T('note-title'), `Plant visit ${SECRET}`)
  await click(pb, T('note-body'))
  await click(pb, T('note-tool-h2'))
  await pb.keyboard.type('Visit report')
  await pb.keyboard.press('Enter')
  await click(pb, T('note-tool-p'))
  await pb.keyboard.type(`Met the team about ${SECRET}. `)
  await click(pb, T('note-tool-bold'))
  await pb.keyboard.type('Important')
  await click(pb, T('note-tool-bold'))
  await pb.keyboard.press('Enter')
  await click(pb, T('note-tool-ul'))
  await pb.keyboard.type('Bolts')
  await pb.keyboard.press('Enter')
  await pb.keyboard.type('Nuts')
  await pb.keyboard.press('Enter')
  await pb.keyboard.press('Enter')
  await click(pb, T('note-tool-checklist'))
  await pb.keyboard.type('Call the supplier')
  await pb.keyboard.press('Enter')
  await pb.keyboard.press('Enter')
  // Devanagari: typed characters, then a composition committed by an input method (CDP Input.imeSetComposition)
  await pb.keyboard.type('नमस्ते ')
  let imeOk = false
  try {
    const cdp = await pb.createCDPSession()
    await cdp.send('Input.imeSetComposition', { text: 'दुनि', selectionStart: 4, selectionEnd: 4 })
    await cdp.send('Input.imeSetComposition', { text: 'दुनिया', selectionStart: 6, selectionEnd: 6 })
    await cdp.send('Input.insertText', { text: 'दुनिया' })
    imeOk = true
  } catch (e) {
    record('Devanagari: input-method composition (CDP) is not available in this Chrome; typed text only', true, String(e.message).slice(0, 80))
  }
  await click(pb, T('note-tool-table'))
  await sleep(300)
  await pb.evaluate(() => { const th = document.querySelector('[data-testid="note-body"] th'); const r = document.createRange(); r.selectNodeContents(th); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); th.closest('[contenteditable]').focus() })
  await pb.keyboard.type('Item')
  await caretToEnd(pb)
  await pb.keyboard.type('See ')
  await click(pb, T('note-tool-record'))
  await waitFor(pb, T('note-record-picker'))
  await pb.select(T('note-record-table'), orders.id)
  await pb.waitForFunction(() => [...document.querySelectorAll('[data-testid="note-record-row"]')].some((b) => b.textContent.includes('Order for Pune')), { timeout: 20000 })
  await pb.evaluate(() => [...document.querySelectorAll('[data-testid="note-record-row"]')].find((b) => b.textContent.includes('Order for Pune')).click())
  await pb.waitForFunction(() => !document.querySelector('[data-testid="note-record-picker"]'), { timeout: 10000 })
  await sleep(200)
  // mention Cy: she cannot read the note yet, so the page offers to share it first
  await caretToEnd(pb)
  await pb.keyboard.type(' and @Cy')
  await waitFor(pb, T(`note-mention-${ids.cy}`))
  await pb.evaluate((id) => document.querySelector(`[data-testid="note-mention-${id}"]`).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })), ids.cy)
  await waitFor(pb, T('note-share-offer'))
  record('mention: the page offers to share the note with Cy, who cannot read it yet', true)
  await click(pb, T('note-share-offer-yes'))
  await pb.waitForFunction(() => !!document.querySelector('[data-testid="note-body"] span[data-mention]'), { timeout: 20000 })
  // an image and a file (both go into the note's own Files)
  const imgPath = path.join(DIR, 'photo.png')
  fs.writeFileSync(imgPath, PNG)
  const txtPath = path.join(DIR, 'checklist.txt')
  fs.writeFileSync(txtPath, `inspection list ${SECRET}\n`)
  await caretToEnd(pb)
  await (await pb.$(T('note-image-input'))).uploadFile(imgPath)
  await pb.waitForFunction(() => document.querySelector('[data-testid="note-body"] img[data-att]')?.getAttribute('src'), { timeout: 20000 })
  await (await pb.$(T('note-file-input'))).uploadFile(txtPath)
  await pb.waitForFunction(() => [...document.querySelectorAll('[data-testid="note-file"]')].some((a) => a.textContent.includes('checklist.txt')), { timeout: 20000 })
  await sleep(1500)
  await saved(pb, 30000)
  await shot(pb, 'notes-editor.png')
  const stored = await bodyOf(noteId)
  const has = { h2: /<h2>Visit report<\/h2>/.test(stored), bold: /<b>Important<\/b>/.test(stored), list: /<ul><li>Bolts<\/li><li>Nuts<\/li><\/ul>/.test(stored), checklist: /<ul data-type="checklist"><li data-checked="false">Call the supplier<\/li><\/ul>/.test(stored),
    table: /<table>[\s\S]*?<th>(<br>)?\s*Item/.test(stored), card: stored.includes(`data-record="${orders.id}:${order.id}"></span>`), mention: stored.includes(`<span data-mention="${ids.cy}">@Cy Reader</span>`), image: /<img data-att="att_[^"]+">/.test(stored),
    devanagari: stored.includes('नमस्ते') && (!imeOk || stored.includes('दुनिया')) }
  check(Object.values(has).every(Boolean), 'the stored note has the heading, bold text, list, checklist, table, record card, mention, image and Devanagari text', Object.values(has).every(Boolean) ? JSON.stringify(has) : `${JSON.stringify(has)} ${stored.slice(0, 1500)}`)
  check(!/Order for Pune/.test(stored), 'the record card stores the reference only (the record\'s name is never in the note)')
  await pb.waitForFunction(() => document.querySelector('[data-testid="note-body"] span[data-record]')?.textContent === 'Orders: Order for Pune', { timeout: 15000 })
  record('the card shows Bob the record\'s name, resolved for him', true)
  const detail = await api(cl.bob, 'GET', `/notes/${noteId}`)
  const files = await api(cl.bob, 'POST', '/attachments/resolve', { ids: JSON.parse(String(detail.note.Files ?? '[]')) })
  check(files.items.length === 2 && files.items.some((f) => f.fileName === 'checklist.txt'), 'the image and the file are in the note\'s Files', files.items.map((f) => f.fileName).join(', '))
  const shareRows = await api(cl.bob, 'POST', '/query', { plan: { version: 2, table: 'ActivityShares', filter: { col: 'Activity', op: 'eq', value: noteId } } })
  check(shareRows.rows.length === 1 && shareRows.rows[0].Principal === ids.cy && shareRows.rows[0].Access === 'read', 'the share offer wrote a read share for Cy')

  /* ---------------------------------------------------------------- 2. hostile HTML */
  log('2. hostile HTML')
  await caretToEnd(pb)
  await pb.evaluate(() => {
    const dt = new DataTransfer()
    dt.setData('text/html', '<p>pasted <b>fine</b></p><img src=x onerror="window.__xss=1"><script>window.__xss=2</script><a href="javascript:window.__xss=3">j</a><p style="color:red" onclick="window.__xss=4">styled</p><svg onload="window.__xss=5"></svg><iframe src="javascript:window.__xss=6"></iframe>')
    dt.setData('text/plain', 'pasted fine')
    document.querySelector('[data-testid="note-body"]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await sleep(1500)
  await saved(pb)
  const domAfter = await pb.evaluate(() => ({ xss: window.__xss ?? null, bad: document.querySelector('[data-testid="note-body"]').querySelectorAll('script, svg, iframe, [onerror], [onclick], [style], img:not([data-att])').length, pasted: document.querySelector('[data-testid="note-body"]').textContent.includes('pasted fine') }))
  check(domAfter.xss === null && domAfter.bad === 0 && domAfter.pasted, 'pasted HTML: the text is kept, scripts, handlers, styles, SVG and iframes are gone and nothing ran', JSON.stringify(domAfter))
  const afterPaste = await bodyOf(noteId)
  check(afterPaste.includes('pasted <b>fine</b>') && !/script|onerror|onclick|javascript:|style=|<svg|<iframe/i.test(afterPaste), 'pasted HTML is stored sanitised')
  const hostile = await api(cl.bob, 'POST', '/data/Activities/rows', { values: { Type: 'Note', Subject: 'Hostile', Body: '<p>ok</p><script>alert(1)</script><img src=x onerror=alert(1)><a href="jav&#x61;script:alert(1)">x</a><p style="background:url(javascript:alert(1))" onmouseover="alert(1)">s</p><svg><script>alert(1)</script></svg><table><tr><td><table><tr><td>nested</td></tr></table></td></tr></table>' } })
  const hostileBody = await bodyOf(hostile.row.id)
  check(hostileBody === '<p>ok</p><a>x</a><p>s</p><table><tr><td>nested</td></tr></table>', 'hostile HTML sent straight to the API is stored sanitised', hostileBody)
  await api(cl.bob, 'POST', '/data/Activities/delete', { ids: [hostile.row.id] })

  /* ---------------------------------------------------------------- 3. the mention */
  log('3. mention')
  await drain()
  let cyNote = []
  for (let i = 0; i < 40 && !cyNote.length; i++) {
    cyNote = ((await api(cl.cy, 'GET', '/notifications?limit=100')).items ?? []).filter((n) => String(n.title ?? '').includes('mentioned you in the note'))
    if (!cyNote.length) { await drain(); await sleep(250) }
  }
  check(cyNote.length === 1 && cyNote[0].link === `#u-notes?n=${encodeURIComponent(noteId)}`, 'Cy is notified of the mention, with a link to the note', cyNote.map((n) => `${n.title} ${n.link}`).join(' | '))
  const pc = await newPage(ctx.cy)
  await signIn(pc, PEOPLE.cy)
  await pc.goto(`${BASE}/${cyNote[0].link}`, { waitUntil: 'domcontentloaded' })
  await waitFor(pc, T('note-panel'))
  await pc.waitForFunction((s) => document.querySelector('[data-testid="note-body"]')?.textContent.includes(s), { timeout: 20000 }, SECRET)
  const cyView = await pc.evaluate(() => ({ toolbar: !!document.querySelector('[data-testid="note-toolbar"]'), editable: document.querySelector('[data-testid="note-body"]').isContentEditable, titleRO: document.querySelector('[data-testid="note-title"]').readOnly, card: document.querySelector('[data-testid="note-body"] span[data-record]')?.textContent }))
  check(!cyView.toolbar && !cyView.editable && cyView.titleRO, 'Cy opens it from the link, read-only (no toolbar, not editable)', JSON.stringify(cyView))
  check(cyView.card === 'Record not available', 'the record card is not shown to Cy, who cannot read Orders', cyView.card)
  const eveMention = await cl.bob.req('PATCH', `/data/Activities/rows/${noteId}`, { changes: { Body: `${afterPaste}<p><span data-mention="${ids.eve}">@Eve</span></p>` } })
  check(eveMention.status === 422, 'Eve, who cannot read it, cannot be mentioned (422)', eveMention.data?.error?.message)

  /* ---------------------------------------------------------------- 4. sharing */
  log('4. sharing')
  await pb.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(pb, T('note-share'))
  await click(pb, T('note-share'))
  await waitFor(pb, T('note-share-dialog'))
  await pb.type(T('note-share-find'), 'Di Ed')
  await click(pb, T(`note-share-person-${ids.di}`))
  await pb.waitForFunction(() => document.querySelectorAll('[data-testid="note-share-row"]').length === 2, { timeout: 10000 })
  // the second row is Di: "Can edit"
  await (await pb.$$(T('note-share-access')))[1].select('edit')
  await pb.select(T('note-share-team'), `team:${team.id}`)
  await pb.waitForFunction(() => document.querySelectorAll('[data-testid="note-share-row"]').length === 3, { timeout: 10000 })
  await pb.waitForFunction(() => document.querySelectorAll('[data-testid="note-share-access"]')[1]?.value === 'edit', { timeout: 10000 })
  await shot(pb, 'notes-share.png')
  await click(pb, T('note-share-save'))
  await pb.waitForFunction(() => !document.querySelector('[data-testid="note-share-dialog"]'), { timeout: 20000 })
  const shares = (await api(cl.bob, 'GET', `/notes/${noteId}`)).shares
  check(shares.length === 3 && shares.find((s) => s.Principal === ids.di)?.Access === 'edit' && shares.find((s) => s.Principal === ids.cy)?.Access === 'read' && shares.find((s) => s.PrincipalType === 'team')?.name === 'Quality', 'the Share dialog saved: Cy read, Di edit, team Quality read', JSON.stringify(shares.map((s) => [s.name, s.Access])))
  const cyGet = await api(cl.cy, 'GET', `/notes/${noteId}`)
  const cyWrite = await cl.cy.req('PATCH', `/data/Activities/rows/${noteId}`, { changes: { Subject: 'changed by Cy' } })
  check(cyGet.canEdit === false && cyWrite.status >= 403, 'Cy (read) opens it and cannot change it', `canEdit ${cyGet.canEdit}, write ${cyWrite.status}`)
  const diGet = await api(cl.di, 'GET', `/notes/${noteId}`)
  const diWrite = await cl.di.req('PATCH', `/data/Activities/rows/${noteId}`, { changes: { Subject: `Plant visit ${SECRET} (checked by Di)` } })
  const diShare = await cl.di.req('POST', '/data/ActivityShares/rows', { values: { Activity: noteId, PrincipalType: 'user', Principal: ids.eve, Access: 'read' } })
  const diDelete = await cl.di.req('POST', '/data/Activities/delete', { ids: [noteId] })
  check(diGet.canEdit === true && diWrite.status === 200 && diShare.status >= 400 && diDelete.status >= 400, 'Di (edit) changes it, and cannot share it on or delete it', `write ${diWrite.status}, share ${diShare.status}, delete ${diDelete.status}`)
  const pd = await newPage(ctx.di)
  await signIn(pd, PEOPLE.di)
  await pd.goto(`${BASE}/#u-notes?n=${noteId}`, { waitUntil: 'domcontentloaded' })
  await waitFor(pd, T('note-toolbar'))
  check(await pd.$eval(T('note-body'), (e) => e.isContentEditable), 'Di gets the editor (toolbar, editable)')
  await pd.close()
  check((await api(cl.fay, 'GET', `/notes/${noteId}`)).note.id === noteId && (await api(cl.fay, 'GET', '/notes?view=shared')).items.some((n) => n.id === noteId), 'Fay opens it through the team Quality and finds it under "Shared with me"')
  const eve = {
    list: await cl.eve.req('GET', '/notes'), search: await cl.eve.req('GET', `/notes?q=${SECRET}`), direct: await cl.eve.req('GET', `/notes/${noteId}`), cards: await cl.eve.req('POST', `/notes/${noteId}/cards`, {}),
    query: await cl.eve.req('POST', '/query', { plan: { version: 2, table: 'Activities', filter: { col: 'Type', op: 'eq', value: 'Note' } } }),
    search2: await cl.eve.req('POST', '/query', { plan: { version: 2, table: 'Activities', search: { text: SECRET, columns: ['Subject', 'Body'] } } }),
    shares: await cl.eve.req('POST', '/query', { plan: { version: 2, table: 'ActivityShares' } }),
    timeline: await cl.eve.req('GET', `/collab/timeline?table=sys_activities&row=${noteId}`),
  }
  const eveBytes = Object.values(eve).map((r) => JSON.stringify(r.data)).join('\n')
  check(eve.list.data.items.length === 0 && eve.search.data.items.length === 0 && eve.direct.status === 404 && eve.cards.status === 404 && eve.query.data.rows.length === 0 && eve.search2.data.rows.length === 0 && eve.shares.data.rows.length === 0 && eve.timeline.status === 404,
    'Eve sees nothing: list, search, direct address, cards, query API (rows, search, shares), timeline', `direct ${eve.direct.status}, query ${eve.query.data.rows?.length}`)
  check(!eveBytes.includes(SECRET) && !eveBytes.includes(noteId.slice(0, 8) + 'x'), 'no response to Eve contains the note\'s text', `${eveBytes.length} bytes`)
  const pe = await newPage(ctx.eve)
  await signIn(pe, PEOPLE.eve)
  await pe.goto(`${BASE}/#u-notes?n=${noteId}`, { waitUntil: 'domcontentloaded' })
  await waitFor(pe, T('note-missing'))
  check(!(await pe.evaluate((s) => document.body.innerText.includes(s), SECRET)), 'Eve opening the address sees "Note not found" and nothing of the note')
  await pe.close()

  /* ---------------------------------------------------------------- 5. two tabs */
  log('5. two tabs')
  const tab1 = await newPage(ctx.bob)
  const tab2 = await newPage(ctx.bob)
  for (const t of [tab1, tab2]) {
    await t.bringToFront()
    await t.goto(`${BASE}/#u-notes?n=${noteId}`, { waitUntil: 'domcontentloaded' })
    await waitFor(t, T('note-toolbar')).catch(async () => { throw new Error(`no editor in a second tab: ${(await t.evaluate(() => document.body.innerText)).slice(0, 800)}`) })
    await saved(t)
  }
  await caretToEnd(tab1)
  await tab1.keyboard.type(' First tab edit.')
  await caretToEnd(tab2)
  await tab2.keyboard.type(' Second tab edit.')
  let conflictPage = null
  for (let i = 0; i < 60 && !conflictPage; i++) {
    await sleep(250)
    for (const t of [tab1, tab2]) if (await t.$(T('note-conflict'))) conflictPage = t
  }
  check(conflictPage, 'two tabs editing the same note: the second save does not overwrite, the conflict choice appears')
  const other = conflictPage === tab1 ? tab2 : tab1
  const otherText = conflictPage === tab1 ? 'Second tab edit.' : 'First tab edit.'
  const mineText = conflictPage === tab1 ? 'First tab edit.' : 'Second tab edit.'
  check((await bodyOf(noteId)).includes(otherText) && !(await bodyOf(noteId)).includes(mineText), 'the stored note is the first save; the second is held in its tab')
  await shot(conflictPage, 'notes-conflict.png')
  const choices = await conflictPage.evaluate(() => [...document.querySelectorAll('[data-testid="note-conflict"] button')].map((b) => b.textContent.trim()))
  check(choices.includes('Keep mine') && choices.includes('Take the saved text'), 'the choice offers "Keep mine" and "Take the saved text" (and "Merge both" when the edits do not overlap)', choices.join(', '))
  await click(conflictPage, T('note-conflict-mine-btn'))
  await conflictPage.waitForFunction(() => !document.querySelector('[data-testid="note-conflict"]'), { timeout: 10000 })
  await saved(conflictPage)
  check((await bodyOf(noteId)).includes(mineText), '"Keep mine" saves that tab\'s text on top of the saved version')
  await tab1.close()
  await tab2.close()
  void other

  /* ---------------------------------------------------------------- 6. a note about a record */
  log('6. note about a record')
  await pb.goto(`${BASE}/#u-notes?new=1&table=${orders.id}&row=${order.id}`, { waitUntil: 'domcontentloaded' })
  await pb.waitForFunction(() => document.querySelector('[data-testid="note-about"]')?.textContent.includes('Order for Pune'), { timeout: 20000 })
  const aboutId = await pb.$eval(T('note-panel'), (e) => e.dataset.noteId)
  await click(pb, T('note-body'))
  await pb.keyboard.type('Delivery is late by two days.')
  await sleep(1300)
  await saved(pb)
  const diTl = await api(cl.di, 'GET', `/collab/timeline?table=${orders.id}&row=${order.id}`)
  check(diTl.items.some((i) => i.kind === 'activity' && i.id === aboutId && i.data.Type === 'Note'), 'the note about the order is on the order\'s timeline for Di (she reads Orders, no share needed)')
  check((await api(cl.di, 'GET', `/notes/${aboutId}`)).note.Body.includes('Delivery is late'), 'Di opens it')
  const eveTl = await cl.eve.req('GET', `/collab/timeline?table=${orders.id}&row=${order.id}`)
  check(eveTl.status === 404 && (await cl.eve.req('GET', `/notes/${aboutId}`)).status === 404 && (await cl.cy.req('GET', `/notes/${aboutId}`)).status === 404, 'Eve (no Orders) gets 404 for the timeline and the note; Cy (not shared, no Orders) gets 404 for the note')
  const diCards = await api(cl.di, 'POST', `/notes/${noteId}/cards`, {})
  check(diCards.cards[`${orders.id}:${order.id}`]?.title === 'Order for Pune', 'the record card in the first note resolves for Di (a reader of Orders)')
  check((await api(cl.di, 'GET', '/notes?view=records')).items.some((n) => n.id === aboutId && n.regarding?.label === 'Order for Pune'), '"About records" lists it under the order')

  /* ---------------------------------------------------------------- 7. quick note, print */
  log('7. quick note, print')
  await pb.goto(`${BASE}/#u-tasks`, { waitUntil: 'domcontentloaded' })
  await click(pb, T('quick-note'))
  await waitFor(pb, T('quick-note-text'))
  await pb.type(T('quick-note-text'), 'Order more gloves\nsize L')
  await click(pb, T('quick-note-save'))
  await waitFor(pb, T('quick-note-saved'))
  const quick = (await api(cl.bob, 'GET', '/notes?q=gloves')).items
  check(quick.length === 1 && (await bodyOf(quick[0].id)) === '<p>Order more gloves</p><p>size L</p>', 'quick note from the shell header saves a note', quick.map((n) => n.title).join(', '))
  await click(pb, T('quick-note-open'))
  await waitFor(pb, T('note-panel'))
  await pb.emulateMediaType('print')
  const printView = await pb.evaluate(() => ({ note: getComputedStyle(document.querySelector('[data-testid="note-body"]')).visibility, nav: getComputedStyle(document.querySelector('[data-testid="user-nav"]') ?? document.body).visibility, toolbar: getComputedStyle(document.querySelector('[data-testid="note-toolbar"]')).display }))
  await pb.emulateMediaType('screen')
  check(printView.note === 'visible' && printView.nav === 'hidden' && printView.toolbar === 'none', 'print (and the browser\'s Save as PDF) shows only the note', JSON.stringify(printView))

  /* ---------------------------------------------------------------- 8. phone */
  log('8. phone width')
  const pp = await newPage(ctx.bob, { width: 360, height: 780, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await pp.goto(`${BASE}/#u-notes`, { waitUntil: 'domcontentloaded' })
  await waitFor(pp, T('notes-list'))
  await pp.waitForFunction(() => document.querySelectorAll('[data-testid="note-row"]').length >= 2, { timeout: 20000 })
  await sleep(500)
  const fit = await pp.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, page: document.querySelector('[data-testid="notes-page"]').scrollWidth <= document.querySelector('[data-testid="notes-page"]').clientWidth + 1 }))
  check(fit.sw <= fit.iw + 1 && fit.page, 'phone: the list fits 360 px without sideways scrolling', JSON.stringify(fit))
  const sizes = await pp.evaluate(() => {
    const h = (s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? Math.round(r.height) : 0 }
    return { search: h('[data-testid="notes-search"]'), add: h('[data-testid="notes-new"]'), row: h('[data-testid="note-row"]'), view: h('[data-testid="notes-view-all"]') }
  })
  check(Object.values(sizes).every((v) => v >= 44), 'phone: search, New, the views and the rows are at least 44 px tall', JSON.stringify(sizes))
  await shot(pp, 'notes-phone-list.png')
  await pp.evaluate((id) => document.querySelector(`[data-note-id="${id}"]`).click(), noteId)
  await waitFor(pp, T('note-toolbar'))
  await sleep(500)
  const fit2 = await pp.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, back: Math.round(document.querySelector('[data-testid="note-back"]').getBoundingClientRect().height), tool: Math.round(document.querySelector('[data-testid="note-tool-bold"]').getBoundingClientRect().height), list: !!document.querySelector('[data-testid="notes-list"]') }))
  check(fit2.sw <= fit2.iw + 1 && fit2.back >= 44 && fit2.tool >= 44 && !fit2.list, 'phone: the editor takes the screen (list hidden), fits, 44 px back and toolbar buttons', JSON.stringify(fit2))
  const box = await pp.$eval(T('note-body'), (e) => { const r = e.getBoundingClientRect(); return { x: r.x + 20, y: r.y + 10 } })
  await pp.touchscreen.tap(box.x, box.y)
  await caretToEnd(pp)
  await pp.keyboard.type(' Typed on the phone.')
  await sleep(1300)
  await saved(pp)
  check((await bodyOf(noteId)).includes('Typed on the phone.'), 'phone: a tap and typing edit the note and it saves')
  const kb = await pp.evaluate(() => {
    document.documentElement.style.setProperty('--kb', '300px')
    const sc = document.querySelector('[data-testid="note-body"]').parentElement
    return Math.round(parseFloat(getComputedStyle(sc).paddingBottom))
  })
  check(kb >= 300, 'phone: with the on-screen keyboard open (--kb 300 px) the editor keeps that much room below the text', `${kb} px`)
  await shot(pp, 'notes-phone-editor.png')

  check(!errors.length, 'no script errors in the browser', errors.slice(0, 3).join(' | '))
} catch (e) {
  failed = true
  console.error(e)
  // what the pages showed when it stopped (screenshots with SHOTS)
  if (browser && SHOTS) {
    let i = 0
    const within = (p) => Promise.race([p, sleep(5000)])
    for (const c of browser.browserContexts()) for (const pg of await c.pages().catch(() => [])) { await within(pg.bringToFront()).catch(() => undefined); await within(pg.screenshot({ path: path.join(SHOTS, `stopped-${++i}.png`) })).catch(() => undefined) }
  }
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stop().catch(() => undefined)
  if (!E.KEEP) await maint(`DROP DATABASE IF EXISTS "${DB.database}"`).catch((e) => console.error(`could not drop ${DB.database}: ${e.message}`))
  if (!E.EXIT_WORKSPACE) fs.rmSync(DIR, { recursive: true, force: true })
}
const bad = results.filter((r) => !r.ok)
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed${failed ? ' (stopped at the first failure)' : ''}`)
process.exit(failed || bad.length ? 1 : 0)
