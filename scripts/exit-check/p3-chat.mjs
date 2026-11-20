#!/usr/bin/env node
/**
 * Phase 3 exit checks 1 to 8 for chat (docs/plan/p3-spec.md section 3), API LEVEL: what package A (the server) can show
 * without a browser. Package B adds the browser part (dock, pop-out, phone size, three browsers) to this script.
 * DEVELOPER TOOL (sandbox values only), not part of the product. Re-runnable.
 *
 *   . .\.sandbox\env.ps1; node scripts/exit-check/p3-chat.mjs
 *
 * A server is started in this process (HTTP and WebSocket on 127.0.0.1:EXIT_PORT, default 5196) on an EMPTY database
 * whose name starts with appbuilder_exit_p3a (dropped and created here). Three people (Asha, Ravi with two "tabs",
 * Meera), an outsider (Nia) and an environment administrator (Dev).
 *   1  chat end to end      open, private, direct and group conversations; send, edit, delete, react, reply; every change
 *                           reaches the other sockets (p95 of push latency); unread counts after a "reload"; 10,000
 *                           messages page back 50 at a time (first page time); a socket killed while 20 messages are
 *                           sent recovers all 20 exactly once and in order through /changes
 *   2  mentions             a mention and a direct message notify in the app; a mention of a non-member in a private
 *                           channel is refused with the reason; muted members get nothing. (Email digest with a fake
 *                           SMTP server and the WhatsApp mock: SKIP here, covered by server/core/chat/chat.integration.test.ts
 *                           for the digest relevance check)
 *   3  files                a member opens a file; a non-member gets the missing-attachment answer; over the limit is
 *                           refused before upload; the file name is found by search
 *   4  cards                a hidden column is absent from the response bytes; a hidden row answers like a missing one;
 *                           an app the reader may not run is not available
 *   5  security             the leak checks of the integration suite in short (non-member, generic writes refused,
 *                           environment administrator through Query v2), the audited and announced export, a removed
 *                           member's socket ends within 5 s and the search hits go at once
 *   6  record discussions   SKIP: package E
 *   7  search at scale      EXIT_SCALE messages (default 100,000) in 200 channels; a member of 20 sees hits only from
 *                           those; p95 of 40 searches (target 500 ms on the sandbox); a word only in a private channel
 *                           returns nothing to a non-member
 *   8  retention, moderation, audit   retention 30 days with the clock moved 31 days; a report, a moderator delete, an
 *                           archive, a member removal, a read-only person: each in the audit log without message text
 *
 *
 * The BROWSER PART (package B; checks marked 1B ... 8B) runs after it in headless Chrome against the same server, when
 * dist/ is built (npm run build) and puppeteer-core is found (PUPPETEER_CORE, CHROME_PATH; scripts/exit-check/browser-env.mjs):
 * four browser contexts (Bina with two tabs and the pop-out, Chetan, Omar in no private conversation, Dev an
 * administrator) and Chetan on a 360 x 800 phone: a private channel made on screen, live delivery (p95), a second tab,
 * keyboard, unread counts live and after a reload, history paged 50 at a time, a network cut while 20 messages are sent,
 * the mention list and the notification deep link, a file, a photo and the 25 MB limit, a record card per reader (DOM and
 * response bytes) that follows a change of the record, thread, reaction, edit, delete, report, the pop-out, a non-member
 * (list, search, address), the phone screen with a keyboard inset, Admin console > Chat (report queue, read-only person,
 * member removal, archive, the export with its typed reason, retention) and the audit log, light and dark themes.
 * Package E (checks 4E, 6E, 15E, 1E): a record shared to a channel from the record timeline's "Share to chat" where one
 * reader lacks a column and another the row (DOM and response bytes); a discussion on the timeline with a mention whose
 * picker offers readers only, an edit of one's own comment, live on a second reader's timeline, listed under
 * Discussions with its unread count and opening the record; an approval card answered in chat (a comment-required
 * answer refused, the requester unable to approve their own) and the same request decided in the inbox; a card that
 * updates live when the request is decided in the inbox; the answer on the record timeline; chat on ONE WebSocket per
 * tab (counted) across an environment switch; the Mentions page opening a chat mention; a deep link to an old message
 * (one page around it, not paging back).
 *
 * Settings: APPBUILDER_TEST_DB (dot-source .sandbox/env.ps1) or EXIT_DB_HOST / EXIT_DB_PORT / EXIT_DB_USER /
 * EXIT_DB_PASSWORD / EXIT_MAINT_DB; EXIT_DB_NAME (appbuilder_exit_p3a); EXIT_PORT (5196); EXIT_SCALE (100000);
 * EXIT_WORKSPACE (.sandbox/p3a/workspace); KEEP=1 keeps the database. Refuses ports 5174 and 5433 (a real install).
 * Browser part: EXIT_BROWSER=0 skips it, EXIT_ONLY_BROWSER=1 runs only it, SHOTS=<folder> keeps screenshots,
 * EXIT_DEBUG_FREEZE=1 reports a stuck page's stack on failure. Temporary files go to .sandbox/p3b/tmp.
 * Prints PASS / FAIL / SKIP lines and a table; exit code 1 when a check fails.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { WebSocket } from 'ws'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const fromUrl = (() => { try { return E.APPBUILDER_TEST_DB ? new URL(E.APPBUILDER_TEST_DB) : null } catch { return null } })()
const DB = {
  host: E.EXIT_DB_HOST || fromUrl?.hostname || '',
  port: Number(E.EXIT_DB_PORT || fromUrl?.port || 0),
  user: E.EXIT_DB_USER || (fromUrl ? decodeURIComponent(fromUrl.username) : ''),
  password: E.EXIT_DB_PASSWORD || (fromUrl ? decodeURIComponent(fromUrl.password) : ''),
  database: E.EXIT_DB_NAME || 'appbuilder_exit_p3a',
}
const MAINT = E.EXIT_MAINT_DB || (fromUrl ? fromUrl.pathname.replace(/^\//, '') : '') || 'appbuilder_test'
const PORT = Number(E.EXIT_PORT || 5196)
const SCALE = Number(E.EXIT_SCALE || 100_000)
const BASE = `http://127.0.0.1:${PORT}`
const WS = `ws://127.0.0.1:${PORT}/api/v1/live`
const WORKSPACE = path.resolve(root, E.EXIT_WORKSPACE || path.join('.sandbox', 'p3a', 'workspace'))
const ADMIN = { name: 'Exit Admin', email: 'exit@example.test', password: 'Exit-Example-Pass-2026' }
if (!DB.host || !DB.port || !DB.user) { console.error('Name the sandbox database: dot-source .sandbox/env.ps1 (APPBUILDER_TEST_DB) or set EXIT_DB_HOST, EXIT_DB_PORT, EXIT_DB_USER, EXIT_DB_PASSWORD.'); process.exit(2) }
if (PORT === 5174 || DB.port === 5433) { console.error('Refusing to touch ports 5174 / 5433 (a real install).'); process.exit(2) }
if (!/^appbuilder_exit_p3a[a-z0-9_]*$/.test(DB.database)) { console.error('The database must start with appbuilder_exit_p3a (it is dropped).'); process.exit(2) }

const imp = (p) => import(pathToFileURL(path.join(root, p)).href)
const { createApp } = await imp('server/core/app.ts')
const { serveStatic } = await imp('server/core/static.ts')
const { setQuiet } = await imp('server/core/util.ts')
setQuiet(true)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`)
const results = []
const record = (check, name, status, evidence = '') => { results.push({ check, name, status, evidence }); log(`${status} ${check} ${name}${evidence ? `: ${evidence}` : ''}`) }
let failures = 0
const ok = (check, cond, name, evidence = '') => { if (!cond) failures++; record(check, name, cond ? 'PASS' : 'FAIL', evidence) }
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0 }

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

class P {
  constructor(label) { this.label = label; this.cookie = '' }
  async req(method, p, body, o = {}) {
    const headers = { 'X-Appbuilder': '1' }
    if (this.cookie) headers.Cookie = this.cookie
    let payload
    if (o.raw) { headers['Content-Type'] = o.type || 'application/octet-stream'; payload = o.raw } else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }
    const res = await fetch(BASE + '/api/v1' + p, { method, headers, body: payload })
    for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const [n, v] = pair.split('='); if (n === 'ab_session') this.cookie = v ? `ab_session=${v}` : '' }
    const text = await res.text()
    let data = text
    try { data = JSON.parse(text) } catch { /* text */ }
    return { status: res.status, data, text }
  }
  get(p) { return this.req('GET', p) }
  post(p, b) { return this.req('POST', p, b ?? {}) }
  patch(p, b) { return this.req('PATCH', p, b) }
  put(p, b) { return this.req('PUT', p, b) }
  del(p, b) { return this.req('DELETE', p, b) }
}
class Sock {
  constructor(p) {
    this.msgs = []
    this.arrived = new Map()
    this.ws = new WebSocket(WS, { headers: { Origin: BASE, Cookie: p.cookie } })
    this.ws.on('message', (d) => { const m = JSON.parse(d.toString()); this.msgs.push(m); if (m.t === 'chat' && m.message) this.arrived.set(m.message.id + ':' + m.op, Date.now()) })
    this.ws.on('error', () => {})
  }
  async wait(pred, ms = 8000) { const end = Date.now() + ms; for (;;) { const m = this.msgs.find(pred); if (m) return m; if (Date.now() > end) throw new Error('timed out on the socket'); await sleep(20) } }
  async sub(topic) { const id = Math.random().toString(36).slice(2); this.ws.send(JSON.stringify({ t: 'sub', id, topic })); return this.wait((m) => m.id === id) }
  close() { this.ws.terminate() }
}

/** debugging aid (EXIT_DEBUG_FREEZE=1): which page is stuck, and where */
async function freezeReport(browser) {
  for (const pg of await browser.pages().catch(() => [])) {
    const alive = await Promise.race([pg.evaluate(() => 1).then(() => true, () => true), sleep(4000).then(() => false)])
    log(`debug: ${pg.url()} ${alive ? 'responds' : 'FROZEN'}`)
    if (alive) {
      const info = await pg.evaluate(() => ({ notice: document.querySelector('[data-testid="chat-notice"]')?.textContent ?? '', status: document.querySelector('[data-testid="chat-panel"]')?.getAttribute('data-status') ?? '-', conv: document.querySelector('[data-testid="chat-conversation"]')?.getAttribute('data-id') ?? '-', text: (document.querySelector('[data-testid="chat-dock"]')?.textContent ?? '').slice(0, 300) })).catch(() => null)
      log(`debug:   ${JSON.stringify(info)}`)
      continue
    }
    const cdp = await pg.createCDPSession()
    cdp.on('Debugger.paused', (e) => log(`debug stack: ${e.callFrames.slice(0, 15).map((f) => `${f.functionName || '(anon)'}@${f.location.lineNumber}`).join(' < ')}`))
    await cdp.send('Debugger.enable')
    await cdp.send('Debugger.pause')
    await sleep(3000)
  }
}

/* ==================================================================== the browser part (package B) */

/**
 * Exit checks 1 to 8 on screen, in headless Chrome against this server (dist/ must be built): several signed-in browser
 * contexts (Bina with two tabs and the pop-out, Chetan, Omar who is in no private conversation, Dev an administrator,
 * Chetan on a 360 x 800 phone). Each step records PASS / FAIL with the check number of the spec.
 */
async function browserPart({ C, ids, admin }) {
  if (E.EXIT_BROWSER === '0') return record('B', 'browser part', 'SKIP', 'EXIT_BROWSER=0')
  if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) return record('B', 'browser part', 'SKIP', 'dist/index.html missing: run npm run build first')
  const { chromePath, puppeteerCorePath } = await import(pathToFileURL(path.join(root, 'scripts', 'exit-check', 'browser-env.mjs')).href)
  let puppeteer
  try {
    puppeteer = (await import(pathToFileURL(path.join(puppeteerCorePath(root), 'lib', 'puppeteer', 'puppeteer-core.js')).href)).default
  } catch (e) {
    return record('B', 'browser part', 'SKIP', `puppeteer-core not found (PUPPETEER_CORE): ${e.message}`)
  }
  log('browser part: starting Chrome')
  const TMP = path.resolve(root, '.sandbox', 'p3b', 'tmp')
  fs.mkdirSync(TMP, { recursive: true })
  const SHOTS = E.SHOTS ? path.resolve(E.SHOTS) : ''
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], protocolTimeout: 60000 })
  const errors = []
  const T = (id) => `[data-testid="${id}"]`
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }) } }
  const waitFn = (page, fn, arg, timeout = 20000) => page.waitForFunction(fn, { timeout, polling: 50 }, arg)
  const has = (page, sel) => page.$(sel).then((h) => !!h)
  const settle = () => sleep(250)
  // a tab in the background gets no frames: puppeteer's clicks wait for one. The page acted on comes to the front
  let fronted = null
  const front = async (page) => { if (fronted !== page) { await page.bringToFront(); fronted = page; await sleep(50) } }
  const pw = 'Some-Example-Pass-1'
  async function newPage(ctx, vp = { width: 1440, height: 900 }) {
    const page = await ctx.newPage()
    await page.setViewport(vp)
    page.on('pageerror', (e) => errors.push(`${e.message}`.slice(0, 300)))
    page.on('dialog', (d) => d.accept())
    return page
  }
  async function signIn(page, key) {
    await front(page)
    await page.goto(`${BASE}/#u`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('input[type=email]', { timeout: 30000 })
    await page.type('input[type=email]', `${key}@example.test`)
    await page.type('input[type=password]', pw)
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 30000 })
    await page.waitForSelector(T('chat-button'), { timeout: 30000 })
  }
  /** the dock is open and chat is ready and live */
  async function dockReady(page) {
    await front(page)
    if (!(await has(page, T('chat-dock')))) await page.click(T('chat-button'))
    await page.waitForSelector(`${T('chat-dock')} ${T('chat-panel')}[data-status="ready"][data-live="open"]`, { timeout: 30000 })
    await settle()
  }
  /** open a conversation in a narrow panel (back to the list first) */
  async function openConv(page, id) {
    await front(page)
    const cur = await page.$eval(T('chat-conversation'), (e) => e.getAttribute('data-id')).catch(() => null)
    if (cur === id) return
    if (cur) await page.click(T('chat-back'))
    await page.waitForSelector(`[data-conv="${id}"]`, { visible: true, timeout: 20000 })
    // a DOM click on that row: the list reorders itself when messages arrive, a click by position could hit another row
    await page.$eval(`[data-conv="${id}"]`, (e) => e.click())
    await page.waitForSelector(`${T('chat-conversation')}[data-id="${id}"] ${T('chat-messages')}`, { timeout: 20000 })
    await settle()
  }
  async function toList(page) {
    await front(page)
    if (await has(page, T('chat-back'))) await page.click(T('chat-back'))
    await page.waitForSelector(T('chat-list'), { visible: true, timeout: 20000 })
  }
  async function sendUi(page, text, scope = T('chat-composer')) {
    await front(page)
    const sel = `${scope} ${T('chat-input')}`
    await page.waitForSelector(sel, { visible: true, timeout: 20000 })
    await page.type(sel, text)
    await page.keyboard.press('Enter')
  }
  const textsIn = (page, scope = T('chat-messages')) => page.$$eval(`${scope} ${T('chat-message')}`, (els) => els.map((e) => (e.querySelector('.ab-richtext')?.textContent ?? '').trim()))
  const waitText = (page, text, timeout) => waitFn(page, (t) => [...document.querySelectorAll('[data-testid="chat-message"]')].some((e) => e.textContent.includes(t)), text, timeout)
  const msgSel = async (page, text) => {
    const id = await page.$$eval(T('chat-message'), (els, t) => els.find((e) => e.textContent.includes(t))?.getAttribute('data-id') ?? null, text)
    if (!id) throw new Error(`no message "${text}" on screen`)
    return `${T('chat-message')}[data-id="${id}"]`
  }
  async function act(page, text, testId) {
    await front(page)
    const sel = await msgSel(page, text)
    await page.hover(sel)
    await settle()
    await page.click(`${sel} ${T(testId)}`)
  }
  const api = async (c, method, p, body) => {
    const r = await c.req(method, p, body)
    if (r.status !== 200) throw new Error(`${method} ${p}: ${r.status} ${r.text.slice(0, 300)}`)
    return r.data
  }

  try {
    /* -------------------------------------------------------------- setup through the API */
    const open = (await api(C.bina, 'POST', '/chat/conversations', { kind: 'channel', name: 'Plant floor', isPrivate: false })).id
    await api(C.chet, 'POST', `/chat/conversations/${open}/join`)
    await api(C.omar, 'POST', `/chat/conversations/${open}/join`)
    const side = (await api(C.bina, 'POST', '/chat/conversations', { kind: 'channel', name: 'Side room', isPrivate: true, members: [ids.chet] })).id
    const dm = (await api(C.bina, 'POST', '/chat/conversations', { kind: 'direct', members: [ids.chet] })).id
    const grp = (await api(C.bina, 'POST', '/chat/conversations', { kind: 'group', members: [ids.chet, ids.dev] })).id
    const arch = (await api(C.bina, 'POST', '/chat/conversations', { kind: 'channel', name: 'Old shifts', isPrivate: true })).id
    await q(`INSERT INTO env_default.sys_messages ("id", "createdOn", "modifiedOn", "createdBy", "owner", "Channel", "Body", "BodyText", "Seq", "ChangeSeq", "Kind", "ReplyCount")
             SELECT md5('b3' || g)::uuid::text, now() - ((400 - g) || ' minutes')::interval, now(), $1, $1, $2, '<p>shift note ' || g || '</p>', 'shift note ' || g, 1 + g, 1 + g, 'message', 0 FROM generate_series(1, 300) g`, [ids.bina, arch])
    await q(`UPDATE env_default.sys_channels SET "LastSeq" = 301, "LastMessageOn" = now() - interval '100 minutes' WHERE id = $1`, [arch])

    const ctxB = await browser.createBrowserContext()
    const ctxC = await browser.createBrowserContext()
    const ctxO = await browser.createBrowserContext()
    const ctxD = await browser.createBrowserContext()
    const A = await newPage(ctxB)
    const Cp = await newPage(ctxC)
    const O = await newPage(ctxO)
    const D = await newPage(ctxD)
    for (const [p, k] of [[A, 'bina'], [Cp, 'chet'], [O, 'omar'], [D, 'dev']]) await signIn(p, k)
    await dockReady(A)
    await dockReady(Cp)
    ok('1B', true, 'four people signed in, each in a browser context of their own, with chat live in the dock')

    /* -------------------------------------------------------------- 1: a private channel made on screen, live */
    await front(A)
    await A.click(T('chat-new'))
    await A.waitForSelector(T('chat-new-dialog'))
    await front(A)
    await A.click(T('chat-new-channel'))
    await front(A)
    await A.type(T('chat-new-name'), 'Maintenance')
    await front(A)
    await A.click(T('chat-new-private'))
    await front(A)
    await A.type(T('chat-people-search'), 'Chet')
    await A.waitForSelector(`${T('chat-people-pick')}[data-person="Chetan Rao"]`)
    await front(A)
    await A.click(`${T('chat-people-pick')}[data-person="Chetan Rao"]`)
    await front(A)
    await A.click(T('chat-new-create'))
    await A.waitForSelector(`${T('chat-conversation')} ${T('chat-messages')}`, { timeout: 20000 })
    const maint = await A.$eval(T('chat-conversation'), (e) => e.getAttribute('data-id'))
    await Cp.waitForSelector(`[data-conv="${maint}"]`, { timeout: 10000 })
    ok('1B', !!maint, 'a private channel created on screen appears in the member\'s list live (no reload)')
    await shot(A, 'chat-dock.png')

    /* -------------------------------------------------------------- 1: live delivery, people and tabs */
    await openConv(Cp, maint)
    const lat = []
    for (let i = 0; i < 10; i++) {
      const t1 = Date.now()
      await sendUi(A, `latency check ${i}`)
      await waitText(Cp, `latency check ${i}`, 10000)
      lat.push(Date.now() - t1)
    }
    ok('1B', p95(lat) < 1000, 'a message typed in one browser reaches the other person on screen: p95 under 1 s', `p95 ${p95(lat)} ms over ${lat.length} (typing included)`)
    const B = await newPage(ctxB)
    await B.goto(`${BASE}/#u`, { waitUntil: 'domcontentloaded' })
    await B.waitForSelector(T('chat-button'), { timeout: 30000 })
    await dockReady(B)
    await openConv(B, maint)
    await api(C.chet, 'POST', `/chat/conversations/${maint}/messages`, { body: '<p>seen in both tabs</p>', clientId: 'tabs-check-0001' })
    await waitText(A, 'seen in both tabs')
    await waitText(B, 'seen in both tabs')
    const bTexts = await textsIn(B)
    ok('1B', bTexts.filter((x) => x === 'latency check 9').length === 1 && bTexts.includes('seen in both tabs'), 'a second tab of the same person shows the conversation and gets every change live')

    /* -------------------------------------------------------------- keyboard */
    await toList(B)
    await front(B)
    await B.focus(`[data-conv]`)
    await front(B)
    await B.keyboard.press('ArrowDown')
    const focusedConv = await B.evaluate(() => document.activeElement?.getAttribute('data-conv'))
    await front(B)
    await B.keyboard.press('Enter')
    await B.waitForSelector(`${T('chat-conversation')}[data-id="${focusedConv}"]`, { timeout: 10000 })
    await B.waitForSelector(`${T('chat-composer')} ${T('chat-input')}`, { timeout: 10000 })
    await front(B)
    await B.focus(`${T('chat-composer')} ${T('chat-input')}`)
    await front(B)
    await B.keyboard.press('Escape')
    await B.waitForSelector(T('chat-list'), { visible: true, timeout: 5000 })
    ok('1B', !!focusedConv, 'keyboard: arrows move through the list, Enter opens, Escape goes back')

    /* -------------------------------------------------------------- 1: unread counts, live and after a reload */
    await openConv(A, dm)
    await openConv(B, dm)
    for (let i = 0; i < 3; i++) await api(C.chet, 'POST', `/chat/conversations/${open}/messages`, { body: `<p>unread ${i}</p>`, clientId: `unread-check-${i}-x` })
    await toList(A)
    await waitFn(A, (id) => document.querySelector(`[data-conv="${id}"]`)?.getAttribute('data-unread') === '3', open, 10000).catch(() => null)
    const liveUnread = await A.$eval(`[data-conv="${open}"]`, (e) => e.getAttribute('data-unread'))
    await front(B)
    await B.reload({ waitUntil: 'domcontentloaded' })
    await B.waitForSelector(T('chat-button'), { timeout: 30000 })
    await dockReady(B)
    await toList(B)
    await B.waitForSelector(`[data-conv="${open}"]`, { timeout: 10000 })
    const reloadUnread = await B.$eval(`[data-conv="${open}"]`, (e) => e.getAttribute('data-unread'))
    await openConv(B, open)
    await waitFn(A, (id) => document.querySelector(`[data-conv="${id}"]`)?.getAttribute('data-unread') === '0', open, 10000).catch(() => null)
    const afterRead = await A.$eval(`[data-conv="${open}"]`, (e) => e.getAttribute('data-unread'))
    ok('1B', liveUnread === '3' && reloadUnread === '3' && afterRead === '0', 'unread counts: live in the list, right after a reload, and cleared in the other tab when read', `live ${liveUnread}, after reload ${reloadUnread}, after reading in the other tab ${afterRead}`)

    /* -------------------------------------------------------------- 1: history pages back 50 at a time */
    const histReq = []
    const onReq = (r) => { if (r.url().includes(`/chat/conversations/${arch}/messages`)) histReq.push(r.url()) }
    B.on('request', onReq)
    await openConv(B, arch)
    const first = (await textsIn(B)).length
    await front(B)
    // a DOM click: scrolling the button into view would start the automatic load of older messages first (a race)
    await B.$eval(T('chat-older'), (e) => e.click())
    await waitFn(B, () => document.querySelectorAll('[data-testid="chat-messages"] [data-testid="chat-message"]').length >= 100, null, 10000)
    const second = (await textsIn(B)).length
    B.off('request', onReq)
    const oldest = (await textsIn(B))[0]
    ok('1B', first === 50 && second === 100 && histReq.length === 2 && histReq.every((u) => /limit=50/.test(u)) && /before=/.test(histReq[1]) && oldest === 'shift note 201', 'a long conversation shows 50 messages and pages back 50 at a time from the server (never the whole conversation)', `${first} then ${second}; oldest on screen "${oldest}"; requests ${histReq.map((u) => u.replace(/^.*\?/, '?')).join(' ')}`)

    /* -------------------------------------------------------------- 1: network cut while 20 messages are sent */
    await openConv(B, grp)
    await front(B)
    await B.setOfflineMode(true)
    const cut = await B.waitForSelector(T('chat-conn'), { timeout: 8000 }).then(() => true, () => false)
    if (!cut) await B.evaluate(() => window.__abChat?.drop())
    const sentAway = []
    for (let i = 0; i < 20; i++) sentAway.push((await api(C.dev, 'POST', `/chat/conversations/${grp}/messages`, { body: `<p>while away ${i}</p>`, clientId: `away-${i}-abcdefgh` })).message.id)
    await sleep(500)
    const duringCut = (await textsIn(B)).filter((t) => t.startsWith('while away')).length
    await front(B)
    await B.setOfflineMode(false)
    await waitFn(B, () => [...document.querySelectorAll('[data-testid="chat-messages"] [data-testid="chat-message"]')].filter((e) => e.textContent.includes('while away')).length >= 20, null, 45000).catch(() => null)
    await sleep(800)
    const away = (await textsIn(B)).filter((t) => t.startsWith('while away'))
    const inOrder = away.length === 20 && away.every((t, i) => t === `while away ${i}`)
    ok('1B', duringCut === 0 && inOrder && (await B.$eval(T('chat-panel'), (e) => e.getAttribute('data-live'))) === 'open', 'the network is cut while 20 messages are sent: after it is back all 20 show exactly once and in order', `offline banner ${cut ? 'shown' : 'not shown (socket dropped by the hook)'}; ${duringCut} during the cut, ${away.length} after`)

    /* -------------------------------------------------------------- 2: a mention picker of readers only, the notification deep link */
    await front(Cp)
    await Cp.click(T('chat-dock-close'))
    await openConv(A, maint)
    await front(A)
    await A.type(`${T('chat-composer')} ${T('chat-input')}`, '@')
    await A.waitForSelector(T('chat-mention-list'), { timeout: 10000 })
    await sleep(400)
    const offered = await A.$$eval(T('chat-mention-option'), (els) => els.map((e) => e.getAttribute('data-person')))
    await front(A)
    await A.type(`${T('chat-composer')} ${T('chat-input')}`, 'Chet')
    await waitFn(A, () => [...document.querySelectorAll('[data-testid="chat-mention-option"]')].some((e) => e.getAttribute('data-person') === 'Chetan Rao'), null, 10000)
    await front(A)
    await A.keyboard.press('Enter')
    await front(A)
    await A.type(`${T('chat-composer')} ${T('chat-input')}`, 'please check pump 4')
    await front(A)
    await A.keyboard.press('Enter')
    await waitText(A, 'please check pump 4')
    const mentionSeq = Number(await A.$eval(await msgSel(A, 'please check pump 4'), (e) => e.getAttribute('data-seq')))
    const mentionHtml = await A.$eval(`${await msgSel(A, 'please check pump 4')} [data-mention]`, (e) => e.getAttribute('data-mention'))
    ok('2B', offered.includes('Chetan Rao') && !offered.includes('Omar Ali') && !offered.includes('Bina Shah') && mentionHtml === ids.chet, 'the mention list offers only people who can read the private channel; the sent mention names the person', `offered: ${offered.join(', ')}`)
    await Cp.waitForSelector(T('notification-badge'), { timeout: 15000 })
    await front(Cp)
    await Cp.click(T('notification-bell'))
    await Cp.waitForSelector(T('notification-item'), { timeout: 10000 })
    const hashBefore = await Cp.evaluate(() => location.hash)
    const items = await Cp.$$(T('notification-item'))
    let clicked = false
    for (const it of items) {
      if ((await it.evaluate((e) => e.textContent)).includes('mentioned you')) { await (await it.$('button')).click(); clicked = true; break }
    }
    await Cp.waitForSelector(`${T('chat-dock')} ${T('chat-conversation')}[data-id="${maint}"]`, { timeout: 15000 })
    await waitFn(Cp, (s) => window.__abChat?.state().focus?.seq === s, mentionSeq, 10000).catch(() => null)
    const focusSeq = await Cp.evaluate(() => window.__abChat?.state().focus?.seq ?? null)
    const onScreen = await has(Cp, `${T('chat-message')}[data-seq="${mentionSeq}"]`)
    const hashAfter = await Cp.evaluate(() => location.hash)
    ok('2B', clicked && focusSeq === mentionSeq && onScreen && !hashAfter.startsWith('#chat'), 'a mention notification in the bell opens the dock at that message; the page underneath stays', `focus seq ${focusSeq} (message ${mentionSeq}); address ${hashBefore} -> ${hashAfter}`)

    /* -------------------------------------------------------------- 3: a file and a photo, the size limit */
    const png = path.join(TMP, 'pump-photo.png')
    fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
    const doc = path.join(TMP, 'pump-manual.txt')
    fs.writeFileSync(doc, 'pump manual\n')
    const fileInput = await A.$(`${T('chat-composer')} ${T('chat-file-input')}`)
    await fileInput.uploadFile(png, doc)
    await waitFn(A, () => document.querySelectorAll('[data-testid="chat-draft-file"][data-state="ready"]').length === 2, null, 15000)
    await front(A)
    await A.type(`${T('chat-composer')} ${T('chat-input')}`, 'photo and manual')
    await front(A)
    await A.click(T('chat-send'))
    await Cp.waitForSelector(`${T('chat-file')}[data-name="pump-photo.png"] img`, { timeout: 15000 })
    await Cp.waitForSelector(`${T('chat-file')}[data-name="pump-manual.txt"]`, { timeout: 15000 })
    const fileUrl = await Cp.$eval(`${T('chat-file')}[data-name="pump-manual.txt"]`, (e) => e.getAttribute('href'))
    const memberGet = await Cp.evaluate((u) => fetch(u).then(async (r) => ({ s: r.status, t: await r.text() })), fileUrl)
    const outsiderGet = await O.evaluate((u) => fetch(u).then(async (r) => ({ s: r.status, t: await r.text() })), fileUrl)
    const missingGet = await O.evaluate(() => fetch('/api/v1/attachments/att_000000000000?env=default').then(async (r) => ({ s: r.status, t: await r.text() })))
    const strip = (t) => t.replace(/"requestId":"[^"]+"/, '')
    ok('3B', memberGet.s === 200 && memberGet.t === 'pump manual\n' && outsiderGet.s === 404 && strip(outsiderGet.t) === strip(missingGet.t), 'a file and a photo sent on screen open for a member (the photo as an image); a non-member gets the answer of a missing attachment', `member ${memberGet.s}, non-member ${outsiderGet.s}`)
    const big = path.join(TMP, 'big-26mb.bin')
    if (!fs.existsSync(big) || fs.statSync(big).size !== 26 * 1024 * 1024) fs.writeFileSync(big, Buffer.alloc(26 * 1024 * 1024))
    const uploads = []
    const onUp = (r) => { if (r.method() === 'POST' && r.url().includes('/files?')) uploads.push(r.url()) }
    A.on('request', onUp)
    await (await A.$(`${T('chat-composer')} ${T('chat-file-input')}`)).uploadFile(big)
    await A.waitForSelector(T('chat-composer-error'), { timeout: 10000 })
    const bigErr = await A.$eval(T('chat-composer-error'), (e) => e.textContent)
    A.off('request', onUp)
    ok('3B', /larger than 25 MB/.test(bigErr) && uploads.length === 0, 'a file over 25 MB is refused on screen before anything is uploaded', bigErr)

    /* -------------------------------------------------------------- 4: a card, per reader (DOM and response bytes) */
    const tb = (await api(admin, 'POST', '/tables', { displayName: 'Pumps', name: 'ExitPumps', columns: [{ displayName: 'Code', type: 'text' }, { displayName: 'Cost', type: 'text' }] }))
    const partial = await api(admin, 'POST', '/roles', { name: 'Pumps without cost', apps: [], privileges: [{ table: tb.id, create: false, read: 'all', update: 'none', delete: 'none', columns: { Cost: 'none' } }] })
    const full = await api(admin, 'POST', '/roles', { name: 'Pumps in full', apps: [], privileges: [{ table: tb.id, create: true, read: 'all', update: 'all', delete: 'none' }] })
    await api(admin, 'PATCH', `/users/${ids.chet}`, { roleIds: [partial.id] })
    await api(admin, 'PATCH', `/users/${ids.bina}`, { roleIds: [full.id] })
    const row = (await api(admin, 'POST', `/data/${tb.id}/rows`, { values: { Code: 'P-04', Cost: 'COST-SECRET-9131' } })).row.id
    const cardBodies = []
    const onRes = async (r) => { if (r.url().includes('/chat/cards/resolve')) cardBodies.push(await r.text().catch(() => '')) }
    Cp.on('response', onRes)
    await api(C.bina, 'POST', `/chat/conversations/${open}/messages`, { body: '<p>pump card</p>', cards: [{ kind: 'record', env: 'default', table: tb.id, row, fields: ['Code', 'Cost'] }], clientId: 'card-check-0001' })
    await openConv(A, open)
    await openConv(Cp, open)
    await A.waitForSelector(`${T('chat-card')}[data-state="available"] ${T('chat-card-field')}[data-field="Cost"]`, { timeout: 15000 })
    await Cp.waitForSelector(`${T('chat-card')}[data-state="available"]`, { timeout: 15000 })
    await sleep(500)
    const fullText = await A.$eval(`${T('chat-card')}[data-state="available"]`, (e) => e.textContent)
    const partText = await Cp.$eval(`${T('chat-card')}[data-state="available"]`, (e) => e.textContent)
    const partFields = await Cp.$$eval(`${T('chat-card')} ${T('chat-card-field')}`, (els) => els.map((e) => e.getAttribute('data-field')))
    const chetHtml = await Cp.content()
    ok('4B', fullText.includes('COST-SECRET-9131') && partText.includes('P-04') && !partText.includes('COST-SECRET') && partFields.join() === 'Code' && !chetHtml.includes('COST-SECRET'), 'a record card shows a full reader the chosen fields and leaves a hidden column out for another reader (on screen)', `full: "${fullText.trim()}"; partial: "${partText.trim()}"`)
    ok('4B', cardBodies.length > 0 && cardBodies.every((b) => !b.includes('COST-SECRET') && !b.includes('"Cost"')), 'the partial reader\'s card responses carry neither the value nor the column name (response bytes)', `${cardBodies.length} responses`)
    await api(admin, 'PATCH', `/data/${tb.id}/rows/${row}`, { changes: { Code: 'P-04B' } })
    const followed = await waitFn(A, () => [...document.querySelectorAll('[data-testid="chat-card"]')].some((e) => e.textContent.includes('P-04B')), null, 15000).then(() => true, () => false)
    Cp.off('response', onRes)
    ok('4B', followed, 'a change to the record updates the card on screen (the table topic ticks, the card asks the server again)')

    /* -------------------------------------------------------------- 1: thread, reaction, edit, delete on screen */
    await sendUi(A, 'thread root here')
    await waitText(Cp, 'thread root here')
    await act(Cp, 'thread root here', 'chat-reply')
    await Cp.waitForSelector(T('chat-thread-messages'), { timeout: 10000 })
    await sendUi(Cp, 'first reply in the thread', T('chat-thread-composer'))
    await waitText(Cp, 'first reply in the thread')
    const rootSel = await msgSel(A, 'thread root here')
    const replied = await waitFn(A, (s) => document.querySelector(`${s} [data-testid="chat-thread-summary"]`)?.getAttribute('data-replies') === '1', rootSel, 10000).then(() => true, () => false)
    await front(Cp)
    await Cp.click(T('chat-back'))
    await Cp.waitForSelector(T('chat-messages'), { timeout: 10000 })
    ok('1B', replied, 'a reply in a thread shows as "1 reply" under the message for the other person, live')
    await act(Cp, 'thread root here', 'chat-react')
    await Cp.waitForSelector(`${T('chat-emoji')}[data-emoji="👍"]`, { timeout: 5000 })
    await front(Cp)
    await Cp.click(`${T('chat-emoji')}[data-emoji="👍"]`)
    const reacted = await waitFn(A, (s) => document.querySelector(`${s} [data-testid="chat-reaction"][data-emoji="👍"]`)?.getAttribute('data-count') === '1', rootSel, 10000).then(() => true, () => false)
    ok('1B', reacted, 'a reaction reaches the other person live')
    await sendUi(A, 'edit me please')
    await waitText(Cp, 'edit me please')
    await act(A, 'edit me please', 'chat-more')
    await A.waitForSelector(T('chat-edit-action'), { visible: true, timeout: 5000 })
    await front(A)
    await A.click(T('chat-edit-action'))
    await A.waitForSelector(T('chat-edit-input'), { timeout: 5000 })
    await A.$eval(T('chat-edit-input'), (e) => e.select())
    await front(A)
    await A.type(T('chat-edit-input'), 'edited on screen')
    await front(A)
    await A.keyboard.press('Enter')
    const edited = await waitFn(Cp, () => [...document.querySelectorAll('[data-testid="chat-message"]')].some((e) => e.textContent.includes('edited on screen') && e.querySelector('[data-testid="chat-edited"]')), null, 10000).then(() => true, () => false)
    ok('1B', edited, 'an edit of my own message reaches the other person, marked "(edited)"')
    await sendUi(A, 'delete me please')
    await waitText(Cp, 'delete me please')
    const delSel = await msgSel(Cp, 'delete me please')
    await act(A, 'delete me please', 'chat-more')
    await A.waitForSelector(T('chat-delete-action'), { visible: true, timeout: 5000 })
    await front(A)
    await A.click(T('chat-delete-action'))
    const deleted = await waitFn(Cp, (s) => !!document.querySelector(`${s} [data-testid="chat-deleted"]`), delSel, 10000).then(() => true, () => false)
    ok('1B', deleted, 'a deleted message leaves a "Message deleted" line for the other person, live')
    await sendUi(A, 'please report me')
    await waitText(Cp, 'please report me')
    const reportedId = await Cp.$eval(await msgSel(Cp, 'please report me'), (e) => e.getAttribute('data-id'))
    await act(Cp, 'please report me', 'chat-more')
    await Cp.waitForSelector(T('chat-report-action'), { visible: true, timeout: 5000 })
    await front(Cp)
    await Cp.click(T('chat-report-action'))
    await front(Cp)
    await Cp.type(T('chat-report-reason'), 'Not appropriate here')
    await front(Cp)
    await Cp.click(T('chat-report-send'))
    await Cp.waitForSelector(T('chat-report-done'), { timeout: 10000 })
    await front(Cp)
    await Cp.keyboard.press('Escape')

    /* -------------------------------------------------------------- 1: the pop-out window */
    await shot(A, 'chat-dock-conversation.png')
    const popTarget = browser.waitForTarget((t) => t.url().includes('#chat') && t.browserContext() === ctxB, { timeout: 15000 })
    await front(A)
    await A.click(T('chat-popout'))
    const P = await (await popTarget).page()
    P.on('pageerror', (e) => errors.push(`${e.message}`.slice(0, 300)))
    await P.setViewport({ width: 900, height: 760 })
    await P.waitForSelector(`${T('chat-window')}[data-popup="1"] ${T('chat-panel')}[data-status="ready"]`, { timeout: 30000 })
    await P.waitForSelector(`${T('chat-conversation')}[data-id="${open}"]`, { timeout: 15000 })
    await A.waitForSelector(T('chat-popped-out'), { timeout: 10000 })
    const bPopped = await B.waitForSelector(T('chat-popped-out'), { timeout: 10000 }).then(() => true, () => false)
    await api(C.chet, 'POST', `/chat/conversations/${open}/messages`, { body: '<p>to the window</p>', clientId: 'popout-check-01' })
    const inPop = await waitText(P, 'to the window', 10000).then(() => true, () => false)
    const wide = await P.$(T('chat-list')).then(Boolean)
    await shot(P, 'chat-popout.png')
    ok('1B', inPop && bPopped && wide, 'popped out: the window shows the list and the conversation side by side and gets messages live; both tabs\' docks say chat is in another window')
    await front(A)
    await A.click(T('chat-bring-back'))
    await A.waitForSelector(`${T('chat-dock')} ${T('chat-panel')}`, { timeout: 15000 })
    await sleep(500)
    ok('1B', !(await has(A, T('chat-popped-out'))), 'Bring back puts chat into the dock again')
    if (!P.isClosed()) await P.close().catch(() => {})
    await dockReady(A)
    await openConv(A, open)

    /* -------------------------------------------------------------- 5: a non-member: list, search, direct address */
    await dockReady(O)
    await toList(O)
    const oList = await O.$$eval('[data-conv]', (els) => els.map((e) => e.getAttribute('data-conv')))
    const searchBodies = []
    const onSearch = async (r) => { if (r.url().includes('/chat/search')) searchBodies.push(await r.text().catch(() => '')) }
    O.on('response', onSearch)
    await front(O)
    await O.type(T('chat-search'), 'pump')
    await O.waitForSelector(T('chat-search-results'), { timeout: 10000 })
    await sleep(1200)
    const oHits = await O.$$eval(T('chat-search-hit'), (els) => els.map((e) => e.textContent))
    O.off('response', onSearch)
    await O.$eval(T('chat-search'), (e) => { e.value = '' })
    await O.goto(`${BASE}/#chat?c=${maint}`, { waitUntil: 'domcontentloaded' })
    await O.waitForSelector(T('chat-button'), { timeout: 30000 })
    await O.waitForSelector(T('chat-notice'), { timeout: 15000 })
    const notice = await O.$eval(T('chat-notice'), (e) => e.textContent)
    const leaked = await has(O, `${T('chat-conversation')}[data-id="${maint}"]`)
    const oPage = await O.content()
    ok('5B', !oList.includes(maint) && !oList.includes(side) && oHits.every((h) => !h.includes('please check pump 4')) && searchBodies.every((b) => !b.includes('please check pump') && !b.includes(maint)) && /not available/.test(notice) && !leaked && !oPage.includes('please check pump 4'),
      'a private channel is invisible to a non-member: not in the list, not in search (screen and response bytes), and its address shows "not available"', `list ${oList.length}, hits ${oHits.length}, notice "${notice.trim()}"`)

    /* -------------------------------------------------------------- 1: phone width, keyboard inset */
    const Ph = await newPage(ctxC, { width: 360, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
    await Ph.goto(`${BASE}/#u`, { waitUntil: 'domcontentloaded' })
    await Ph.waitForSelector(T('nav-toggle'), { timeout: 30000 })
    await settle()
    await front(Ph)
    await Ph.tap(T('nav-toggle'))
    await Ph.waitForSelector(T('nav-chat'), { visible: true, timeout: 10000 })
    await settle()
    await front(Ph)
    await Ph.tap(T('nav-chat'))
    await Ph.waitForSelector(`${T('chat-window')}[data-popup="0"] ${T('chat-panel')}[data-status="ready"]`, { timeout: 30000 }).catch(async (e) => {
      log(`phone: ${Ph.url()} ${await Ph.evaluate(() => JSON.stringify({ w: innerWidth, name: window.name, body: document.body.innerText.slice(0, 300), panel: document.querySelector('[data-testid="chat-panel"]')?.outerHTML.slice(0, 200) ?? null }))}`)
      throw e
    })
    const phHash = await Ph.evaluate(() => location.hash)
    await Ph.waitForSelector(`[data-conv="${open}"]`, { timeout: 15000 })
    await settle()
    await front(Ph)
    await Ph.tap(`[data-conv="${open}"]`)
    await Ph.waitForSelector(`${T('chat-conversation')}[data-id="${open}"] ${T('chat-composer')}`, { timeout: 15000 })
    await settle()
    const listHidden = !(await has(Ph, T('chat-list')))
    const rowH = await Ph.$eval(T('chat-back'), (e) => e.getBoundingClientRect().height)
    const before = await Ph.$eval(T('chat-composer'), (e) => e.getBoundingClientRect().bottom)
    await Ph.evaluate(() => document.documentElement.style.setProperty('--kb', '300px'))
    await settle()
    const lifted = await Ph.$eval(T('chat-composer'), (e) => e.getBoundingClientRect().bottom)
    await shot(Ph, 'chat-phone-keyboard.png')
    await Ph.evaluate(() => document.documentElement.style.setProperty('--kb', '0px'))
    await front(Ph)
    await Ph.type(`${T('chat-composer')} ${T('chat-input')}`, 'sent from the phone')
    await front(Ph)
    await Ph.tap(T('chat-send'))
    const fromPhone = await waitText(A, 'sent from the phone', 10000).then(() => true, () => false)
    await Ph.evaluate(() => history.back())
    const backToList = await Ph.waitForSelector(T('chat-list'), { visible: true, timeout: 10000 }).then(() => true, () => false)
    const hashAfterBack = await Ph.evaluate(() => location.hash)
    ok('1B', phHash.startsWith('#chat') && listHidden && rowH >= 44 && before <= 800 && lifted <= 800 - 300 + 2 && fromPhone && backToList && hashAfterBack.startsWith('#chat'),
      'phone size (360 x 800): chat fills the screen from the menu, list and conversation are two screens, buttons are 44 px touch targets, the composer sits above the keyboard inset, a message sent from the phone arrives, Back returns to the list',
      `composer bottom ${Math.round(before)} -> ${Math.round(lifted)} px with --kb 300px; back button ${Math.round(rowH)} px; ${hashAfterBack}`)
    await Ph.close()

    /* -------------------------------------------------------------- 8 and 5: Admin console > Chat */
    await openConv(Cp, maint)
    await D.goto(`${BASE}/#admin-chat`, { waitUntil: 'domcontentloaded' })
    await D.waitForSelector(T('chat-admin'), { timeout: 30000 })
    await D.waitForSelector(`${T('chat-admin-report')}[data-message="${reportedId}"]`, { timeout: 15000 })
    const repText = await D.$eval(`${T('chat-admin-report')}[data-message="${reportedId}"] ${T('chat-admin-report-text')}`, (e) => e.textContent)
    const convTable = await D.$eval(T('chat-admin-conversations'), (e) => e.textContent)
    await front(D)
    await D.click(`${T('chat-admin-report')}[data-message="${reportedId}"] ${T('chat-admin-report-delete')}`)
    const moderated = await waitFn(A, (id) => document.querySelector(`[data-testid="chat-message"][data-id="${id}"]`)?.textContent.includes('deleted by an administrator'), reportedId, 10000).then(() => true, () => false)
    ok('8B', repText.includes('please report me') && !convTable.includes('please check pump') && moderated, 'a member reports a message on screen; the administrator sees it in the queue (conversations show no text) and deletes it; the members see "deleted by an administrator"')
    // read-only person
    await front(D)
    await D.type(T('chat-admin-ro-people-search'), 'Omar')
    await D.waitForSelector(`${T('chat-admin-ro-people-pick')}[data-person="Omar Ali"]`, { timeout: 10000 })
    await front(D)
    await D.click(`${T('chat-admin-ro-people-pick')}[data-person="Omar Ali"]`)
    await front(D)
    await D.click(T('chat-admin-ro-add'))
    await D.waitForSelector(`${T('chat-admin-readonly-person')}[data-name="Omar Ali"]`, { timeout: 10000 })
    const omarMe = await api(C.omar, 'GET', '/chat/me')
    ok('8B', omarMe.readOnly === true, 'an administrator makes a person read-only in chat on screen')
    // remove a member: the removed person's screen loses the conversation within 5 s
    await D.waitForSelector(`${T('chat-admin-conv')}[data-id="${side}"]`, { timeout: 10000 })
    await front(D)
    await D.click(`${T('chat-admin-conv')}[data-id="${side}"] ${T('chat-admin-members')}`)
    await D.waitForSelector(`${T('chat-admin-member')}[data-name="Chetan Rao"]`, { timeout: 10000 })
    const tRemove = Date.now()
    await front(D)
    await D.click(`${T('chat-admin-member')}[data-name="Chetan Rao"] ${T('chat-admin-member-remove')}`)
    const gone = await waitFn(Cp, (id) => !window.__abChat?.state().list.byId[id], side, 5000).then(() => Date.now() - tRemove, () => -1)
    await front(D)
    await D.keyboard.press('Escape')
    ok('5B', gone >= 0 && gone < 5000, 'a member removed by an administrator loses the conversation on screen within 5 s', `${gone} ms`)
    // archive
    await front(D)
    await D.click(`${T('chat-admin-conv')}[data-id="${side}"] ${T('chat-admin-archive')}`)
    await sleep(800)
    const sideNow = await api(C.bina, 'GET', `/chat/conversations/${side}`)
    ok('8B', sideNow.archived === true, 'an administrator archives a conversation on screen')
    // the export with its typed reason, announced in the conversation
    await front(D)
    await D.click(`${T('chat-admin-conv')}[data-id="${maint}"] ${T('chat-admin-export')}`)
    await D.waitForSelector(T('chat-admin-export-dialog'), { timeout: 10000 })
    await front(D)
    await D.type(T('chat-admin-export-reason'), 'Exit check: an audited export on screen')
    await front(D)
    await D.click(T('chat-admin-export-confirm'))
    const needPw = await D.waitForSelector(`${T('chat-admin-export-password')}, ${T('chat-admin-export-done')}`, { timeout: 10000 }).then((h) => h.evaluate((e) => e.getAttribute('data-testid')))
    if (needPw === 'chat-admin-export-password') {
      await front(D)
      await D.type(T('chat-admin-export-password'), pw)
      await front(D)
      await D.click(T('chat-admin-export-confirm'))
    }
    await D.waitForSelector(T('chat-admin-export-done'), { timeout: 15000 })
    const announced = await Cp.waitForSelector(`${T('chat-system')}[data-event="export"]`, { timeout: 10000 }).then(() => true, () => false)
    const dl = await D.$eval(T('chat-admin-export-download'), (e) => e.getAttribute('href'))
    const zip = await D.evaluate((u) => fetch(u).then(async (r) => ({ s: r.status, type: r.headers.get('content-type'), n: (await r.arrayBuffer()).byteLength })), dl)
    await shot(D, 'chat-admin.png')
    await front(D)
    await D.keyboard.press('Escape')
    ok('5B', announced && zip.s === 200 && zip.n > 100, 'the administrator exports a conversation with a typed reason on screen; its members see the announcement live; the ZIP downloads', `${needPw === 'chat-admin-export-password' ? 'recent sign-in asked; ' : ''}ZIP ${zip.n} bytes (${zip.type})`)
    // retention set on screen
    await front(D)
    await D.click(`${T('chat-ret-channel')} button:nth-of-type(2)`).catch(async () => {
      const btn = await D.$$(`${T('chat-ret-channel')} button`)
      await btn[1].click()
    })
    await D.waitForSelector(T('chat-ret-channel-days'), { timeout: 5000 })
    await front(D)
    await D.click(T('chat-ret-channel-days'))
    await D.keyboard.down('Control')
    await D.keyboard.press('KeyA')
    await D.keyboard.up('Control')
    await D.keyboard.press('Backspace')
    await front(D)
    await D.type(T('chat-ret-channel-days'), '30')
    await front(D)
    const putBodies = []
    const onPut = (r) => { if (r.method() === 'PUT' && r.url().includes('/chat/admin/settings')) putBodies.push(r.postData()) }
    D.on('request', onPut)
    await D.click(T('chat-admin-save'))
    await sleep(800)
    D.off('request', onPut)
    await shot(D, 'chat-admin-retention.png')
    if (!putBodies.length) log(`retention: no PUT sent; days field "${await D.$eval(T('chat-ret-channel-days'), (e) => e.value)}", save disabled ${await D.$eval(T('chat-admin-save'), (e) => e.disabled)}`)
    const stNow = await api(C.dev, 'GET', '/chat/admin/settings')
    await api(C.dev, 'PUT', '/chat/admin/settings', { retention: { channel: null } })
    ok('8B', stNow.retention.channel === 30, 'retention per kind is set on screen (30 days for channels)', JSON.stringify(stNow.retention))
    const acts = await q(`SELECT action, details::text AS d FROM env_default.ab_audit WHERE action LIKE 'chat.%' AND user_id = $1 AND at > now() - interval '30 minutes'`, [ids.dev]).catch(async () => q(`SELECT action, details::text AS d FROM env_default.ab_audit WHERE action LIKE 'chat.%' AND user_id = $1`, [ids.dev]))
    const need = ['chat.report.handle', 'chat.readonly', 'chat.member.remove', 'chat.channel.archive', 'chat.export', 'chat.settings']
    ok('8B', need.every((a) => acts.some((x) => x.action === a)) && !acts.some((x) => x.d.includes('please report me') || x.d.includes('please check pump')), 'every administrator action done on screen is in the audit log, without message text', need.filter((a) => acts.some((x) => x.action === a)).join(', '))

    /* -------------------------------------------------------------- themes */
    const lightBg = await A.$eval(T('chat-dock'), (e) => getComputedStyle(e).backgroundColor)
    await front(A)
    await A.click(T('portal-theme-toggle'))
    await sleep(400)
    const dark = await A.evaluate(() => document.documentElement.classList.contains('dark'))
    const darkBg = await A.$eval(T('chat-dock'), (e) => getComputedStyle(e).backgroundColor)
    await shot(A, 'chat-dock-dark.png')
    await front(A)
    await A.click(T('portal-theme-toggle'))
    ok('1B', dark && lightBg !== darkBg, 'chat follows the light and dark themes', `${lightBg} / ${darkBg}`)


    /* ============================================================== package E: records and approvals in chat */
    // a table, three readers: Bina reads everything, Chetan all rows without Cost, Omar only his own rows
    const vt = await api(admin, 'POST', '/tables', { displayName: 'Valves', name: 'ExitValves', columns: [{ displayName: 'Code', type: 'text' }, { displayName: 'Cost', type: 'text' }] })
    const vFull = await api(admin, 'POST', '/roles', { name: 'Valves in full', apps: 'all', privileges: [{ table: vt.id, create: true, read: 'all', update: 'all', delete: 'none' }] })
    const vNoCost = await api(admin, 'POST', '/roles', { name: 'Valves without cost', apps: 'all', privileges: [{ table: vt.id, create: false, read: 'all', update: 'none', delete: 'none', columns: { Cost: 'none' } }] })
    const vOwn = await api(admin, 'POST', '/roles', { name: 'Own valves', apps: 'all', privileges: [{ table: vt.id, create: true, read: 'own', update: 'own', delete: 'none' }] })
    await api(admin, 'PATCH', `/users/${ids.bina}`, { roleIds: [full.id, vFull.id] })
    await api(admin, 'PATCH', `/users/${ids.chet}`, { roleIds: [partial.id, vNoCost.id] })
    await api(admin, 'PATCH', `/users/${ids.omar}`, { roleIds: [vOwn.id] })
    const valve = (await api(admin, 'POST', `/data/${vt.id}/rows`, { values: { Code: 'V-17', Cost: 'VALVE-COST-5521' } })).row.id
    // an app with the Record timeline UI component on the valve of the link (#u-<app>?record=<id>)
    const desk = await api(admin, 'POST', '/apps', { name: 'Valves desk', width: 1280, height: 800 })
    const deskDef = (await api(admin, 'GET', `/apps/${desk.id}`)).definition
    deskDef.dataSources = ['ExitValves']
    deskDef.screens[0].children.push({ id: 'n_vtl', name: 'ValveTimeline', type: 'RecordTimeline', props: { X: '=20', Y: '=20', Width: '=640', Height: '=740', Record: '=LookUp(ExitValves, id = Param("record"))' }, children: [] })
    await api(admin, 'PUT', `/apps/${desk.id}`, { definition: deskDef })
    // Bina's new tab counts the live sockets it opens (chat must use the page's one connection)
    const BE = await newPage(ctxB)
    await BE.evaluateOnNewDocument(() => {
      const W = window.WebSocket
      window.__ws = { opened: 0, open: 0 }
      window.WebSocket = class extends W {
        constructor(u, p) {
          super(u, p)
          if (String(u).includes('/api/v1/live')) {
            window.__ws.opened++
            window.__ws.open++
            this.addEventListener('close', () => { window.__ws.open-- })
          }
        }
      }
    })
    const deskUrl = `${BASE}/#u-${desk.id}?record=${valve}`
    await front(BE)
    await BE.goto(deskUrl, { waitUntil: 'domcontentloaded' })
    await BE.waitForSelector(`${T('record-timeline')} ${T('timeline-composer')}`, { timeout: 30000 })
    await dockReady(BE)
    await settle()

    /* ---------------------------------------- 4E: share the record from its timeline; each reader gets their own card */
    await front(BE)
    await BE.click(`${T('record-timeline')} ${T('chat-share-button')}`)
    await BE.waitForSelector(T('chat-share-dialog'), { timeout: 10000 })
    await BE.waitForSelector(`${T('chat-share-conv')}[data-conv="${open}"]`, { timeout: 10000 })
    const offeredConvs = await BE.$$eval(T('chat-share-conv'), (els) => els.map((e) => e.getAttribute('data-conv')))
    await front(BE)
    await BE.click(`${T('chat-share-conv')}[data-conv="${open}"]`)
    // every field offered goes on the card (the primary column, Code, is the card's title and is not offered)
    const offeredFields = await BE.$$eval(T('chat-share-field'), (els) => els.map((e) => e.getAttribute('data-field')))
    for (const f of offeredFields) {
      const on = await BE.$eval(`${T('chat-share-field')}[data-field="${f}"] button`, (e) => e.getAttribute('data-state') === 'checked').catch(() => false)
      if (!on) { await front(BE); await BE.click(`${T('chat-share-field')}[data-field="${f}"] button`) }
    }
    await front(BE)
    await BE.type(T('chat-share-note'), 'valve card from the timeline')
    const shareReq = []
    const onShare = (r) => { if (r.method() === 'POST' && r.url().includes(`/chat/conversations/${open}/messages`)) shareReq.push(r.postData() ?? '') }
    BE.on('request', onShare)
    await front(BE)
    await BE.click(T('chat-share-send'))
    await BE.waitForSelector(T('chat-share-done'), { timeout: 15000 })
    BE.off('request', onShare)
    await front(BE)
    await BE.keyboard.press('Escape')
    await openConv(BE, open)
    await waitFn(BE, () => [...document.querySelectorAll('[data-testid="chat-message"]')].some((e) => e.textContent.includes('valve card from the timeline') && e.querySelector('[data-testid="chat-card"][data-state="available"]')), null, 15000).catch(() => null)
    const chetCards = []
    const omarCards = []
    const onC = async (r) => { if (r.url().includes('/chat/cards/resolve')) chetCards.push(await r.text().catch(() => '')) }
    const onO = async (r) => { if (r.url().includes('/chat/cards/resolve')) omarCards.push(await r.text().catch(() => '')) }
    Cp.on('response', onC)
    O.on('response', onO)
    await dockReady(Cp)
    await openConv(Cp, open)
    await dockReady(O)
    await openConv(O, open)
    await waitText(Cp, 'valve card from the timeline', 15000)
    await waitText(O, 'valve card from the timeline', 15000)
    const cardOf = (page) => page.evaluate(() => {
      const m = [...document.querySelectorAll('[data-testid="chat-message"]')].find((e) => e.textContent.includes('valve card from the timeline'))
      const c = m?.querySelector('[data-testid="chat-card"]')
      return c ? { state: c.getAttribute('data-state'), text: c.textContent, fields: [...c.querySelectorAll('[data-testid="chat-card-field"]')].map((f) => f.getAttribute('data-field')) } : null
    })
    await waitFn(Cp, () => [...document.querySelectorAll('[data-testid="chat-message"]')].some((e) => e.textContent.includes('valve card from the timeline') && e.querySelector('[data-testid="chat-card"][data-state="available"]')), null, 15000).catch(() => null)
    await waitFn(O, () => [...document.querySelectorAll('[data-testid="chat-message"]')].some((e) => e.textContent.includes('valve card from the timeline') && e.querySelector('[data-testid="chat-card"][data-state="unavailable"]')), null, 15000).catch(() => null)
    await sleep(400)
    const cc = await cardOf(Cp)
    const oc = await cardOf(O)
    Cp.off('response', onC)
    O.off('response', onO)
    const valveFor = (list) => list.filter((b) => b.includes('V-17') || b.includes('"available":false'))
    ok('4E', offeredConvs.includes(open) && !offeredConvs.includes(side) && shareReq.length === 1 && !shareReq[0].includes('VALVE-COST') && !shareReq[0].includes('V-17'),
      '"Share to chat" on the record timeline offers the conversations the sharer may post to; the message carries a reference, never a value (request bytes)', `${offeredConvs.length} offered`)
    const binaCard = await cardOf(BE)
    ok('4E', binaCard?.state === 'available' && binaCard.text.includes('VALVE-COST-5521'), 'the sharer (a full reader) sees the chosen fields on the card', `Bina: "${binaCard?.text?.trim()}"; fields offered ${offeredFields.join(', ')}`)
    ok('4E', cc?.state === 'available' && cc.text.includes('V-17') && !cc.text.includes('VALVE-COST') && !cc.fields.includes('Cost') && chetCards.length > 0 && chetCards.every((b) => !b.includes('VALVE-COST') && !b.includes('"Cost"')),
      'a reader without the Cost column gets the card without it (DOM and response bytes)', `Chetan: "${cc?.text?.trim()}"`)
    ok('4E', oc?.state === 'unavailable' && !(await O.content()).includes('V-17') && omarCards.length > 0 && omarCards.every((b) => !b.includes('V-17') && !b.includes('VALVE-COST')) && valveFor(omarCards).length > 0,
      'a reader without access to the row gets "Not available" and no value (DOM and response bytes)', `Omar: ${omarCards[omarCards.length - 1]}`)

    /* ---------------------------------------- 6E: a discussion: mention (readers only), edit, live, Discussions list */
    const CT = await newPage(ctxC)
    await front(CT)
    await CT.goto(deskUrl, { waitUntil: 'domcontentloaded' })
    await CT.waitForSelector(`${T('record-timeline')} ${T('timeline-composer')}`, { timeout: 30000 })
    await settle()
    await front(BE)
    await BE.click(`${T('record-timeline')} ${T('timeline-composer')}`)
    await BE.type(`${T('record-timeline')} ${T('timeline-composer')}`, 'Please check the seal @')
    await BE.waitForSelector(T('mention-list'), { timeout: 10000 })
    await sleep(500)
    const pickable = await BE.$$eval(`${T('mention-list')} button`, (els) => els.map((e) => e.textContent))
    await front(BE)
    await BE.type(`${T('record-timeline')} ${T('timeline-composer')}`, 'Chet')
    await BE.waitForSelector(`${T('mention-list')} [data-testid="mention-${ids.chet}"]`, { timeout: 10000 })
    await front(BE)
    await BE.click(`${T('mention-list')} [data-testid="mention-${ids.chet}"]`)
    await front(BE)
    await BE.type(`${T('record-timeline')} ${T('timeline-composer')}`, 'today')
    await front(BE)
    await BE.click(T('timeline-send'))
    const liveTl = await waitFn(CT, () => [...document.querySelectorAll('[data-testid="timeline-comment"]')].some((e) => e.textContent.includes('Please check the seal')), null, 15000).then(() => true, () => false)
    ok('6E', pickable.some((t) => t.includes('Chetan Rao')) && !pickable.some((t) => t.includes('Omar Ali')) && liveTl,
      'a comment on the record timeline mentions a reader (the picker offers only people who can read the record) and reaches the other reader\'s timeline live', `offered: ${pickable.map((t) => t.replace(/\S+@\S+/, '').trim()).join(', ')}`)
    // Chetan's Discussions list: the record, with an unread comment; a click opens the record
    await front(Cp)
    await toList(Cp)
    await front(Cp)
    await Cp.click(T('chat-tab-discussions'))
    const listed = await Cp.waitForSelector(`${T('chat-discussion')}[data-row="${valve}"]`, { timeout: 15000 }).then(() => true, () => false)
    const unreadD = listed ? await Cp.$eval(`${T('chat-discussion')}[data-row="${valve}"]`, (e) => Number(e.getAttribute('data-unread'))) : -1
    const omarD = await api(C.omar, 'GET', '/chat/discussions')
    // the edit of one's own comment: "(edited)", live on the other reader's timeline
    const mineSel = await BE.evaluate(() => [...document.querySelectorAll('[data-testid="timeline-comment"]')].find((e) => e.textContent.includes('Please check the seal'))?.getAttribute('data-id'))
    await front(BE)
    await BE.click(`${T('timeline-comment')}[data-id="${mineSel}"] ${T('timeline-edit-action')}`)
    await BE.waitForSelector(T('timeline-edit-input'), { timeout: 5000 })
    await BE.$eval(T('timeline-edit-input'), (e) => e.select())
    await front(BE)
    await BE.type(T('timeline-edit-input'), 'Please check the seal and the gasket @')
    await BE.waitForSelector(`${T('mention-list')} [data-testid="mention-${ids.chet}"]`, { timeout: 10000 })
    await front(BE)
    await BE.click(`${T('mention-list')} [data-testid="mention-${ids.chet}"]`)
    await front(BE)
    await BE.click(T('timeline-edit-save'))
    const editedLive = await waitFn(CT, () => [...document.querySelectorAll('[data-testid="timeline-comment"]')].some((e) => e.textContent.includes('and the gasket') && e.querySelector('[data-testid="timeline-edited"]')), null, 15000).then(() => true, () => false)
    const chetOnly = await CT.$$eval(T('timeline-edit-action'), (els) => els.length)
    ok('6E', listed && unreadD >= 1 && !JSON.stringify(omarD).includes('Please check the seal') && editedLive && chetOnly === 0,
      'the discussion is listed under Discussions for the mentioned reader with its unread count (not for a person who cannot read the record); the author\'s edit shows "(edited)" live on the other reader\'s timeline, which offers no Edit of someone else\'s comment', `unread ${unreadD}`)
    await front(Cp)
    await Cp.click(`${T('chat-discussion')}[data-row="${valve}"]`)
    const opened = await waitFn(Cp, (u) => location.hash.includes(`record=${u}`), valve, 10000).then(() => true, () => false)
    ok('6E', opened, 'a click on the discussion opens the record in the app it was discussed in', await Cp.evaluate(() => location.hash))
    await CT.close()

    /* ---------------------------------------- 15E: an approval card answered in chat, the inbox, the timeline */
    await api(admin, 'POST', '/approvals/policies', { name: 'Valve repairs', definition: { type: 'single', approvers: ['chet@example.test'], requireCommentOnReject: true } })
    const ar = await api(C.bina, 'POST', '/approvals', { policy: 'Valve repairs', title: 'Repair valve V-17', fields: { Estimate: 18000 }, regarding: { table: vt.id, rowId: valve } })
    await front(Cp)
    await Cp.goto(`${BASE}/#u`, { waitUntil: 'domcontentloaded' })
    await Cp.waitForSelector(T('chat-button'), { timeout: 30000 })
    await dockReady(Cp)
    await toList(Cp)
    // back to the Conversations tab (6E left the Discussions tab open)
    await front(Cp)
    await Cp.$eval(T('chat-tab-conversations'), (e) => e.click())
    await Cp.waitForSelector(`${T('chat-tab-conversations')}[aria-selected="true"]`, { timeout: 5000 })
    const apConv = await Cp.waitForSelector('[data-conv][data-name="Approvals"]', { timeout: 30000 }).then((h) => h.evaluate((e) => e.getAttribute('data-conv')), () => null)
    if (!apConv) throw new Error(`no Approvals conversation in chat: ${JSON.stringify(await q('SELECT a.status, a.user_id = $1 AS chet, a.stage_idx, r.status AS rs, r.current_stage FROM env_default.ab_approval_assignments a JOIN env_default.ab_approval_requests r ON r.id = a.request_id', [ids.chet]))} channels ${JSON.stringify(await q("SELECT \"DirectKey\" FROM env_default.sys_channels WHERE \"DirectKey\" LIKE 'system:%'"))}`)
    await openConv(Cp, apConv)
    const cardSel = `${T('chat-card')}[data-kind="approval"]`
    await Cp.waitForSelector(`${cardSel}[data-status="pending"][data-can-decide="1"]`, { timeout: 20000 })
    const cannotPost = await has(Cp, T('chat-cannot-post'))
    // Reject needs a comment (the policy): refused by the server, shown on the card
    await front(Cp)
    await Cp.click(`${cardSel} ${T('chat-approval-answer')}[data-answer="Reject"]`)
    await front(Cp)
    await Cp.click(`${cardSel} ${T('chat-approval-send')}`)
    const refusal = await Cp.waitForSelector(`${cardSel} ${T('chat-approval-error')}`, { timeout: 10000 }).then((h) => h.evaluate((e) => e.textContent), () => '')
    const selfAnswer = await C.bina.req('POST', `/approvals/${ar.id}/respond`, { response: 'Approve' })
    const binaConvs = (await api(C.bina, 'GET', '/chat/conversations')).items
    await front(Cp)
    await Cp.click(`${cardSel} ${T('chat-approval-answer')}[data-answer="Approve"]`)
    await front(Cp)
    await Cp.type(`${cardSel} ${T('chat-approval-comment')}`, 'approved from chat')
    await front(Cp)
    await Cp.click(`${cardSel} ${T('chat-approval-send')}`)
    const approvedCard = await Cp.waitForSelector(`${cardSel}[data-status="approved"]`, { timeout: 15000 }).then(() => true, () => false)
    const inbox = await api(C.chet, 'GET', `/approvals/${ar.id}`)
    await front(Cp)
    await Cp.goto(`${BASE}/#u-approvals?id=${ar.id}`, { waitUntil: 'domcontentloaded' })
    const inboxShows = await waitFn(Cp, () => /Repair valve V-17/.test(document.body.innerText) && /approved/i.test(document.body.innerText), null, 20000).then(() => true, () => false)
    ok('15E', cannotPost && /comment is required/i.test(refusal) && selfAnswer.status === 403 && !binaConvs.some((c) => c.system === 'approvals') && approvedCard && inbox.request.status === 'approved' && inbox.request.history.filter((h) => h.action === 'responded').length === 1 && inboxShows,
      'an approval card in the approver\'s "Approvals" conversation: a rejection without the required comment is refused, the requester cannot approve their own, the approval from the card is the same decision in the inbox (one answer in its history)', `refusal "${refusal.trim()}"; requester ${selfAnswer.status}`)
    // decided elsewhere: a second request answered in the inbox; the open card follows live
    const ar2 = await api(C.bina, 'POST', '/approvals', { policy: 'Valve repairs', title: 'Replace valve V-18', regarding: { table: vt.id, rowId: valve } })
    await front(Cp)
    await Cp.goto(`${BASE}/#u`, { waitUntil: 'domcontentloaded' })
    await Cp.waitForSelector(T('chat-button'), { timeout: 30000 })
    await dockReady(Cp)
    await openConv(Cp, apConv)
    const card2 = await waitFn(Cp, (t) => [...document.querySelectorAll('[data-testid="chat-card"][data-kind="approval"]')].some((e) => e.textContent.includes(t) && e.getAttribute('data-status') === 'pending'), 'Replace valve V-18', 30000).then(() => true, () => false)
    await api(C.chet, 'POST', `/approvals/${ar2.id}/respond`, { response: 'Approve' })
    const followedLive = await waitFn(Cp, (t) => [...document.querySelectorAll('[data-testid="chat-card"][data-kind="approval"]')].some((e) => e.textContent.includes(t) && e.getAttribute('data-status') === 'approved'), 'Replace valve V-18', 20000).then(() => true, () => false)
    ok('15E', card2 && followedLive, 'a card updates live when its request is decided elsewhere (here: answered in the inbox)')
    // the answer on the record timeline (who, what, comment), for the requester
    await front(BE)
    await BE.goto(deskUrl, { waitUntil: 'domcontentloaded' })
    // the same address: reload, so the timeline is read again
    await BE.reload({ waitUntil: 'domcontentloaded' })
    await BE.waitForSelector(T('record-timeline'), { timeout: 30000 })
    const answerEv = await waitFn(BE, () => [...document.querySelectorAll('[data-testid="timeline-approval-answer"][data-response="Approve"]')].map((e) => e.textContent).find((t) => t.includes('approved from chat')), null, 15000).then((h) => h.jsonValue(), () => '')
    const omarTl = await C.omar.req('GET', `/collab/timeline?table=${vt.id}&row=${valve}`)
    ok('15E', answerEv.includes('Chetan Rao') && answerEv.includes('approved from chat') && omarTl.status === 404 && !omarTl.text.includes('approved from chat'),
      'each answer is on the record timeline (who, what, when, comment) for people who may see the approval', answerEv.trim().slice(0, 160))

    /* ---------------------------------------- 1E: one WebSocket per tab, across an environment switch */
    await dockReady(BE)
    await openConv(BE, maint)
    const env2 = await api(admin, 'POST', '/environments', { name: 'Exit second', type: 'sandbox' })
    await api(admin, 'PUT', `/environments/${env2.id}/access/${ids.bina}`, {})
    const before1 = await BE.evaluate(() => ({ ...window.__ws }))
    await front(BE)
    await BE.goto(`${BASE}/#u`, { waitUntil: 'domcontentloaded' })
    // a reload: the new environment is in the list the page loads
    await BE.reload({ waitUntil: 'domcontentloaded' })
    await BE.waitForSelector(T('env-picker'), { timeout: 30000 })
    await front(BE)
    await BE.click(T('env-picker'))
    await BE.waitForSelector(T(`env-item-${env2.id}`), { visible: true, timeout: 10000 })
    await front(BE)
    await BE.click(T(`env-item-${env2.id}`))
    await waitFn(BE, (n) => document.querySelector('[data-testid="env-current"]')?.textContent?.includes(n), 'Exit second', 20000)
    await settle()
    await dockReady(BE)
    await openConv(BE, maint)
    await api(C.chet, 'POST', `/chat/conversations/${maint}/messages`, { body: '<p>after the environment switch</p>', clientId: 'env-switch-check-1' })
    const afterSwitch = await waitText(BE, 'after the environment switch', 15000).then(() => true, () => false)
    const ws1 = await BE.evaluate(() => ({ ...window.__ws }))
    ok('1E', before1.open === 1 && ws1.open === 1 && afterSwitch && (await BE.$eval(T('chat-panel'), (e) => e.getAttribute('data-live'))) === 'open',
      'chat runs on the page\'s ONE WebSocket (counted in the tab) and keeps working live across an environment switch', `before: ${before1.opened} opened / ${before1.open} open; after the switch: ${ws1.opened} opened / ${ws1.open} open`)
    // back to Default for what follows
    await front(BE)
    await BE.click(T('env-picker'))
    await BE.waitForSelector(T('env-item-default'), { visible: true, timeout: 10000 })
    await front(BE)
    await BE.click(T('env-item-default'))
    await settle()

    /* ---------------------------------------- 1E: the Mentions page opens a chat mention */
    await front(Cp)
    await Cp.goto(`${BASE}/#u-mentions`, { waitUntil: 'domcontentloaded' })
    await Cp.waitForSelector(`${T('mention-row')}[data-kind="chat"]`, { timeout: 20000 })
    const mentionText = await Cp.$eval(`${T('mention-row')}[data-kind="chat"]`, (e) => e.textContent)
    await front(Cp)
    await Cp.click(`${T('mention-row')}[data-kind="chat"]`)
    const mentionOpened = await Cp.waitForSelector(`${T('chat-dock')} ${T('chat-conversation')}[data-id="${maint}"]`, { timeout: 15000 }).then(() => true, () => false)
    const mFocus = await waitFn(Cp, (s) => window.__abChat?.state().focus?.seq === s, mentionSeq, 10000).then(() => true, () => false)
    ok('1E', mentionText.includes('please check pump 4') && mentionOpened && mFocus, 'the Mentions page lists the chat mention with its text and opens the message in chat', mentionText.trim().slice(0, 120))

    /* ---------------------------------------- 1E: a deep link to an old message loads the page around it */
    const deepReq = []
    const onDeep = (r) => { if (r.url().includes(`/chat/conversations/${arch}/messages`)) deepReq.push(r.url().replace(/^.*\?/, '?')) }
    await front(B)
    B.on('request', onDeep)
    await B.goto(`${BASE}/#chat?c=${arch}&m=6`, { waitUntil: 'domcontentloaded' })
    await B.waitForSelector(T('chat-button'), { timeout: 30000 })
    const deepShown = await B.waitForSelector(`${T('chat-message')}[data-seq="6"]`, { timeout: 20000 }).then(() => true, () => false)
    const deepFocus = await waitFn(B, () => window.__abChat?.state().focus?.seq === 6, null, 10000).then(() => true, () => false)
    await sleep(500)
    B.off('request', onDeep)
    const newerBar = await has(B, T('chat-newer-bar'))
    ok('1E', deepShown && deepFocus && deepReq.some((u) => /around=6/.test(u)) && deepReq.length <= 3 && newerBar,
      'a deep link to an old message (seq 6 of 301) loads one page around it instead of paging back; newer messages are a click away', deepReq.join(' '))

    ok('B', errors.length === 0, 'no script errors in any page', errors.slice(0, 3).join(' | '))
  } catch (e) {
    failures++
    const where = String(e?.stack ?? '').split('\n').filter((l) => l.includes('p3-chat.mjs')).map((l) => l.replace(/^.*p3-chat\.mjs:/, 'line ')).join(', ')
    record('B', 'the browser part', 'FAIL', `${String(e?.message ?? e).slice(0, 400)} (${where})`)
    if (E.EXIT_DEBUG_FREEZE === '1') await freezeReport(browser)
    if (SHOTS) { let i = 0; for (const pg of await browser.pages().catch(() => [])) await pg.screenshot({ path: path.join(SHOTS, `fail-${i++}.png`) }).catch(() => {}) }
  } finally {
    await browser.close().catch(() => {})
  }
}

let app = null
let server = null
const socks = []
const sock = async (p) => { const s = new Sock(p); socks.push(s); await s.wait((m) => m.t === 'hello'); return s }

try {
  await maint(`DROP DATABASE IF EXISTS "${DB.database}"`)
  fs.rmSync(WORKSPACE, { recursive: true, force: true })
  fs.mkdirSync(WORKSPACE, { recursive: true })
  app = await createApp({ env: { APPBUILDER_MIGRATION_BACKUP: 'skip' }, config: { workspaceDir: WORKSPACE }, printSetupCode: false, jobs: true })
  // the browser part needs the built client (npm run build): dist/ is served for everything the API does not answer
  const dist = path.join(root, 'dist')
  server = http.createServer((req, res) => { app.handle(req, res).then((h) => { if (!h) { if (fs.existsSync(path.join(dist, 'index.html'))) serveStatic(dist, req, res); else res.writeHead(404).end() } }, () => { if (!res.headersSent) res.writeHead(500); res.end() }) })
  server.on('upgrade', (req, socket, head) => { if (!app.handleUpgrade(req, socket, head)) socket.destroy() })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
  const admin = new P('admin')
  const code = app.services.setupCode.current() ?? ''
  if ((await admin.post('/setup/database', { setupCode: code, host: DB.host, port: DB.port, database: DB.database, user: DB.user, password: DB.password, createDatabase: true })).status !== 200) throw new Error('setup failed')
  await admin.post('/setup/admin', { setupCode: code, ...ADMIN })
  await admin.post('/auth/login', { email: ADMIN.email, password: ADMIN.password })
  const ids = {}
  const C = {}
  for (const [key, name, roles] of [['asha', 'Asha', ['role_viewer']], ['ravi', 'Ravi', ['role_viewer']], ['meera', 'Meera', ['role_viewer']], ['nia', 'Nia', ['role_viewer']], ['kiran', 'Kiran', ['role_viewer']], ['dev', 'Dev', ['role_admin']], ['bina', 'Bina Shah', ['role_viewer']], ['chet', 'Chetan Rao', ['role_viewer']], ['omar', 'Omar Ali', ['role_viewer']]]) {
    const u = await admin.post('/users', { name, email: `${key}@example.test`, roleIds: roles, password: 'Some-Example-Pass-1' })
    ids[key] = u.data.id
    await q('UPDATE ab.users SET must_change_password = false WHERE id = $1', [u.data.id])
    C[key] = new P(name)
    await C[key].post('/auth/login', { email: `${key}@example.test`, password: 'Some-Example-Pass-1' })
  }
  C.ravi2 = new P('Ravi (second tab)')
  C.ravi2.cookie = C.ravi.cookie

  // EXIT_ONLY_BROWSER=1: the browser part only (the API part below is skipped)
  api: {
  if (E.EXIT_ONLY_BROWSER === '1') { record('-', 'API part', 'SKIP', 'EXIT_ONLY_BROWSER=1'); break api }
  /* ---------------------------------------------------------------- 1 */
  log('check 1: chat end to end')
  const open = (await C.asha.post('/chat/conversations', { kind: 'channel', name: 'General', isPrivate: false })).data.id
  const priv = (await C.asha.post('/chat/conversations', { kind: 'channel', name: 'Quality', isPrivate: true, members: [ids.ravi, ids.meera, ids.kiran] })).data.id
  const dm = (await C.asha.post('/chat/conversations', { kind: 'direct', members: [ids.ravi] })).data.id
  const grp = (await C.asha.post('/chat/conversations', { kind: 'group', members: [ids.ravi, ids.meera, ids.kiran] })).data.id
  ok(1, [open, priv, dm, grp].every((x) => typeof x === 'string'), 'an open channel, a private channel, a 1:1 and a group conversation')
  await C.ravi.post(`/chat/conversations/${open}/join`)
  await C.meera.post(`/chat/conversations/${open}/join`)
  await C.kiran.post(`/chat/conversations/${open}/join`)
  const tabs = [await sock(C.ravi), await sock(C.ravi2), await sock(C.meera)]
  for (const s of tabs) for (const c of [open, priv, grp]) await s.sub(`chat:${c}`)
  await tabs[0].sub(`chat:${dm}`)
  await tabs[1].sub(`chat:${dm}`)
  const lat = []
  for (let i = 0; i < 20; i++) {
    const c = [open, priv, grp][i % 3]
    const sent = Date.now()
    // (a sender is limited to 30 messages a minute: Kiran sends these)
    const m = (await C.kiran.post(`/chat/conversations/${c}/messages`, { body: `message ${i}` })).data.message
    for (const s of tabs) { await s.wait((x) => x.t === 'chat' && x.message?.id === m.id); lat.push(s.arrived.get(m.id + ':message') - sent) }
  }
  const m0 = (await C.asha.post(`/chat/conversations/${dm}/messages`, { body: 'direct hello' })).data.message
  await tabs[1].wait((x) => x.t === 'chat' && x.message?.id === m0.id)
  await C.asha.patch(`/chat/messages/${m0.id}`, { body: 'direct hello (edited)' })
  await C.ravi.post(`/chat/messages/${m0.id}/reactions`, { emoji: '👍' })
  const reply = (await C.ravi.post(`/chat/conversations/${dm}/messages`, { body: 'a reply', parent: m0.id })).data.message
  await C.ravi.del(`/chat/messages/${reply.id}`)
  for (const op of ['edit', 'reaction', 'message', 'delete']) await tabs[1].wait((x) => x.t === 'chat' && x.op === op && x.channelId === dm)
  ok(1, true, 'send, edit, react, reply and delete reach the other tab of the same person')
  ok(1, p95(lat) < 1000, 'every change reaches the other people and tabs live: push p95 under 1 s', `p95 ${p95(lat)} ms over ${lat.length} deliveries`)
  const list = (await C.meera.get('/chat/conversations')).data.items
  const un = Object.fromEntries(list.map((c) => [c.id, c.unread]))
  ok(1, un[open] === 7 && un[priv] === 7 && un[grp] === 6, 'unread counts are right after a reload', JSON.stringify({ open: un[open], priv: un[priv], grp: un[grp] }))
  // 10,000 messages in one channel (written directly: the change counter, as the service does)
  const big = (await C.asha.post('/chat/conversations', { kind: 'channel', name: 'Archive of ten thousand', isPrivate: true, members: [ids.ravi] })).data.id
  await q(`INSERT INTO env_default.sys_messages ("id", "createdOn", "modifiedOn", "createdBy", "owner", "Channel", "Body", "BodyText", "Seq", "ChangeSeq", "Kind", "ReplyCount")
           SELECT md5('big' || g)::uuid::text, now() - ((10000 - g) || ' seconds')::interval, now(), $1, $1, $2, '<p>row ' || g || '</p>', 'row ' || g, 1 + g, 1 + g, 'message', 0 FROM generate_series(1, 10000) g`, [ids.asha, big])
  await q(`UPDATE env_default.sys_channels SET "LastSeq" = 10001 WHERE id = $1`, [big])
  await q('ANALYZE env_default.sys_messages')
  const tp = Date.now()
  const page1 = await C.ravi.get(`/chat/conversations/${big}/messages`)
  const firstMs = Date.now() - tp
  const page2 = await C.ravi.get(`/chat/conversations/${big}/messages?before=${page1.data.messages[0].seq}`)
  ok(1, page1.data.messages.length === 50 && page1.data.more && page2.data.messages.length === 50 && page2.data.messages[49].seq === page1.data.messages[0].seq - 1, 'a channel with 10,000 messages pages back from the server 50 at a time', `pages of ${page1.data.messages.length} and ${page2.data.messages.length}`)
  ok(1, firstMs < 300, 'first page under 300 ms on the sandbox', `${firstMs} ms`)
  // a socket killed while 20 messages are sent: recovered exactly once and in order
  const victim = await sock(C.meera)
  const ack = await victim.sub(`chat:${grp}`)
  const lastSeen = ack.seq
  victim.close()
  const sent20 = []
  for (let i = 0; i < 20; i++) sent20.push((await C.ravi.post(`/chat/conversations/${grp}/messages`, { body: `while offline ${i}`, clientId: `offline-${i}-abcdefgh` })).data.message.id)
  // the client retries a send it is unsure of (same clientId): still one message
  await C.ravi.post(`/chat/conversations/${grp}/messages`, { body: 'while offline 0', clientId: 'offline-0-abcdefgh' })
  const back = await sock(C.meera)
  const ack2 = await back.sub(`chat:${grp}`)
  const ch = (await C.meera.get(`/chat/conversations/${grp}/changes?after=${lastSeen}`)).data
  const got = ch.messages.filter((m) => m.text.startsWith('while offline')).map((m) => m.id)
  ok(1, ack2.seq === lastSeen + 20 && got.length === 20 && got.every((x, i) => x === sent20[i]), 'a socket killed while 20 messages are sent recovers all 20 exactly once and in order', `gap ${lastSeen} -> ${ack2.seq}, ${got.length} recovered`)

  /* ---------------------------------------------------------------- 2 */
  log('check 2: mentions and notifications')
  const mm = (await C.asha.post(`/chat/conversations/${priv}/messages`, { body: `<span data-mention="${ids.meera}">@Meera</span> please check` })).data.message
  await sleep(200)
  const nm = (await C.meera.get('/notifications?limit=50')).data.items.filter((n) => n.kind === 'chat' && n.link === `#chat?c=${priv}&m=${mm.seq}`)
  ok(2, nm.length === 1, 'a mention in a channel creates one in-app notification', nm[0]?.title)
  const nd = (await C.ravi.get('/notifications?limit=50')).data.items.filter((n) => n.kind === 'chat' && n.link.startsWith(`#chat?c=${dm}&`))
  ok(2, nd.length >= 1, 'a direct message creates an in-app notification', nd[0]?.title)
  const refused = await C.asha.post(`/chat/conversations/${priv}/messages`, { body: `<span data-mention="${ids.nia}">@Nia</span> look` })
  ok(2, refused.status === 422 && /not in this conversation/.test(refused.data.error.message), 'a mention of a non-member in a private channel is refused with the reason', refused.data.error?.message)
  await C.ravi.patch(`/chat/conversations/${priv}/me`, { muted: true })
  const before = (await C.ravi.get('/notifications?limit=100')).data.items.length
  await C.asha.post(`/chat/conversations/${priv}/messages`, { body: `<span data-mention="${ids.ravi}">@Ravi</span> muted` })
  await sleep(200)
  ok(2, (await C.ravi.get('/notifications?limit=100')).data.items.length === before, 'nothing goes to a muted member')
  record(2, 'email digest at the digest slot (fake SMTP) and WhatsApp template (mock)', 'SKIP', 'browser/mail part of the exit check; the digest relevance check is in server/core/chat/chat.integration.test.ts')

  /* ---------------------------------------------------------------- 3 */
  log('check 3: files')
  const up = await C.asha.req('POST', `/chat/conversations/${priv}/files?name=inspection-photo.jpg`, undefined, { raw: Buffer.from('JPEG'), type: 'image/jpeg' })
  const fm = (await C.asha.post(`/chat/conversations/${priv}/messages`, { body: 'the photo', files: [up.data.id] })).data.message
  const url = fm.files[0].url.replace('/api/v1', '')
  ok(3, (await C.meera.get(url)).status === 200, 'a file sent in a message opens for members')
  const nf = await C.nia.get(url)
  const missing = await C.nia.get('/attachments/att_000000000000?env=default')
  ok(3, nf.status === 404 && nf.text.replace(/"requestId":"[^"]+"/, '') === missing.text.replace(/"requestId":"[^"]+"/, ''), 'a non-member gets the same answer as for a missing attachment', `${nf.status}`)
  const tooBig = await new Promise((resolve) => {
    const r = http.request(`${BASE}/api/v1/chat/conversations/${priv}/files?name=big.bin`, { method: 'POST', headers: { 'X-Appbuilder': '1', Cookie: C.asha.cookie, 'Content-Type': 'application/octet-stream', 'Content-Length': String(26 * 1024 * 1024) } }, (res) => { res.resume(); resolve(res.statusCode) })
    r.on('error', () => resolve(-1))
    r.write(Buffer.alloc(1024))
    setTimeout(() => r.destroy(), 3000)
  })
  ok(3, tooBig === 413, 'a file over the limit is refused before upload', `${tooBig}`)
  const fs1 = (await C.ravi.get('/chat/search?q=inspection-photo')).data.items.map((i) => i.message.id)
  ok(3, fs1.includes(fm.id), 'the file name is found by search')

  /* ---------------------------------------------------------------- 4 */
  log('check 4: cards')
  const t = (await admin.post('/tables', { displayName: 'Machines', name: 'ExitMachines', columns: [{ displayName: 'Code', type: 'text' }, { displayName: 'Cost', type: 'text' }] })).data
  const partial = (await admin.post('/roles', { name: 'Partial machines', apps: [], privileges: [{ table: t.id, create: true, read: 'own', update: 'own', delete: 'none', columns: { Cost: 'none' } }] })).data
  const full = (await admin.post('/roles', { name: 'Full machines', apps: [], privileges: [{ table: t.id, create: true, read: 'all', update: 'all', delete: 'none' }] })).data
  // (the Viewer role reads every table: Meera keeps only the partial role)
  await admin.patch(`/users/${ids.meera}`, { roleIds: [partial.id] })
  await admin.patch(`/users/${ids.ravi}`, { roleIds: [full.id] })
  const meeraRow = (await C.meera.post(`/data/${t.id}/rows`, { values: { Code: 'M-01' } })).data.row.id
  await admin.patch(`/data/${t.id}/rows/${meeraRow}`, { changes: { Cost: 'COST-SECRET-4711' } })
  const other = (await admin.post(`/data/${t.id}/rows`, { values: { Code: 'M-02', Cost: 'OTHER-SECRET' } })).data.row.id
  const cm = (await C.asha.post(`/chat/conversations/${open}/messages`, { body: 'machines', cards: [{ kind: 'record', env: 'default', table: t.id, row: meeraRow, fields: ['Code', 'Cost'] }, { kind: 'record', env: 'default', table: t.id, row: other, fields: ['Code'] }, { kind: 'record', env: 'default', table: t.id, row: '00000000-0000-5000-8000-000000000000', fields: ['Code'] }, { kind: 'app', env: 'default', app: 'app_does_not_exist' }].slice(0, 3) })).data.message
  const fullCard = await C.ravi.post('/chat/cards/resolve', { messageId: cm.id, index: 0 })
  const partCard = await C.meera.post('/chat/cards/resolve', { messageId: cm.id, index: 0 })
  ok(4, fullCard.text.includes('COST-SECRET-4711'), 'a full reader sees the chosen fields')
  ok(4, partCard.data.available && !partCard.text.includes('COST-SECRET') && !partCard.text.includes('"Cost"'), 'a reader without access to one column does not get that column (response bytes)')
  const hiddenRow = await C.meera.post('/chat/cards/resolve', { messageId: cm.id, index: 1 })
  const missingRow = await C.meera.post('/chat/cards/resolve', { messageId: cm.id, index: 2 })
  ok(4, hiddenRow.text === missingRow.text && !hiddenRow.text.includes('M-02'), 'a reader without access to the row gets the same answer as for a record that does not exist', hiddenRow.text)
  const am = (await C.asha.post(`/chat/conversations/${open}/messages`, { body: 'an app', cards: [{ kind: 'app', env: 'default', app: 'app_does_not_exist' }] })).data.message
  ok(4, JSON.stringify((await C.meera.post('/chat/cards/resolve', { messageId: am.id, index: 0 })).data) === JSON.stringify({ available: false, kind: 'app' }), 'a reader who may not run the app gets "not available"')
  const hist = await C.nia.get(`/chat/conversations/${open}/messages`)
  ok(4, !hist.text.includes('COST-SECRET') && !hist.text.includes('OTHER-SECRET'), 'messages carry references only, never field values')
  record(4, 'the notification email for a card holds no field value; a record change updates the card', 'SKIP', 'mail and browser part (package E); notification bodies never carry card values (server/core/chat/service.ts notifyMessage)')

  /* ---------------------------------------------------------------- 5 */
  log('check 5: nothing leaks from chat')
  const ns = await C.nia.get('/chat/search?q=photo')
  const nl = await C.nia.get('/chat/conversations')
  ok(5, ns.data.items.length === 0 && !nl.text.includes(priv) && (await C.nia.get(`/chat/conversations/${priv}`)).status === 404, 'for a non-member a private channel is absent from the list and search, and answers 404')
  const writes = await Promise.all(['Channels', 'ChannelMembers', 'Messages', 'MessageReactions'].map((tb) => C.dev.post(`/data/${tb}/rows`, { values: { Name: 'x', Channel: priv, User: ids.nia, Message: fm.id, Emoji: '👍', Body: 'x' } })))
  ok(5, writes.every((r) => r.status >= 400), 'writes to the four chat tables through the generic data API are refused (here: an environment administrator)', writes.map((r) => r.status).join(','))
  const qv = await C.dev.post('/query', { plan: { version: 2, table: 'Messages', select: ['BodyText'] } })
  ok(5, qv.status === 200 && !qv.text.includes('please check') && !qv.text.includes('the photo'), 'an environment administrator who is not a member does not see private messages through Query v2')
  const ex = await C.dev.post(`/chat/admin/channels/${priv}/export`, { reason: 'Exit check: audited export' })
  const audit = await q(`SELECT 1 FROM env_default.ab_audit WHERE action = 'chat.export' AND user_id = $1`, [ids.dev])
  const announced = (await C.meera.get(`/chat/conversations/${priv}/messages`)).data.messages.some((m) => m.event?.type === 'export')
  ok(5, ex.status === 200 && audit.length === 1 && announced, 'an administrator export is audited and announced in the conversation')
  const watch = await sock(C.meera)
  await watch.sub(`chat:${priv}`)
  const tr = Date.now()
  await C.asha.del(`/chat/conversations/${priv}/members/${ids.meera}`)
  let ended = -1
  try { await watch.wait((m) => m.t === 'unsubscribed' && m.topic === `chat:${priv}`, 5000); ended = Date.now() - tr } catch { /* not within 5 s */ }
  const gone = (await C.meera.get('/chat/search?q=please')).data.items.filter((i) => i.message.channelId === priv).length === 0
  ok(5, ended >= 0 && ended < 5000 && gone, 'a removed member stops receiving its messages within 5 s and loses search hits at once', `${ended} ms`)
  record(5, 'the full leak suite (every route, every persona)', 'SKIP', 'not run by this script: npx vitest run server/core/chat/chat-security.integration')

  record(6, 'per-record discussions (Comments in chat\'s Discussions list)', 'SKIP', 'API level: server/core/chat/chat-security.integration.test.ts (package E); on screen: the 6E checks of the browser part')

  /* ---------------------------------------------------------------- 7 */
  log(`check 7: search over ${SCALE} messages`)
  await q(`INSERT INTO env_default.sys_channels ("id", "createdOn", "modifiedOn", "Name", "Kind", "IsPrivate", "LastSeq", "PurgedSeq", "PostingPolicy")
           SELECT md5('s' || g)::uuid::text, now(), now(), 'scale ' || g, 'channel', true, 0, 0, 'everyone' FROM generate_series(1, 200) g`)
  await q(`INSERT INTO env_default.sys_channel_members ("id", "createdOn", "modifiedOn", "Channel", "User", "MemberRole", "LastReadSeq", "NotifyLevel", "Muted")
           SELECT md5('sm' || g)::uuid::text, now(), now(), md5('s' || g)::uuid::text, $1, 'member', 0, 'mentions', false FROM generate_series(1, 20) g`, [ids.nia])
  await q(`INSERT INTO env_default.sys_messages ("id", "createdOn", "modifiedOn", "createdBy", "owner", "Channel", "Body", "BodyText", "Seq", "ChangeSeq", "Kind", "ReplyCount")
           SELECT md5('sg' || g)::uuid::text, now() - (g || ' seconds')::interval, now(), $1, $1, md5('s' || (1 + g % 200))::uuid::text, 'x',
                  'machine ' || (g % 97) || ' downtime report ' || CASE WHEN g % 200 = 150 THEN 'secretword' ELSE 'normal' END, (g / 200) + 1, (g / 200) + 1, 'message', 0
             FROM generate_series(1, $2::int) g`, [ids.asha, SCALE])
  await q('ANALYZE env_default.sys_messages')
  const allowed = new Set([...(await q('SELECT "Channel" AS c FROM env_default.sys_channel_members WHERE "User" = $1', [ids.nia])).map((r) => r.c),
    ...(await q(`SELECT id AS c FROM env_default.sys_channels WHERE "Kind" = 'channel' AND "IsPrivate" = false AND "ArchivedOn" IS NULL`)).map((r) => r.c)])
  const times = []
  let outside = 0
  for (let i = 0; i < 40; i++) {
    const s = Date.now()
    const r = await C.nia.get(`/chat/search?q=${['downtime', 'machine 4', 'report normal', 'machine'][i % 4]}`)
    times.push(Date.now() - s)
    for (const it of r.data.items) if (!allowed.has(it.message.channelId)) outside++
  }
  ok(7, outside === 0, 'a member of 20 channels sees hits only from those 20 (and open channels)', `${outside} hits outside`)
  ok(7, p95(times) < 500, 'search p95 under 500 ms on the sandbox', `p95 ${p95(times)} ms, ${SCALE} messages in 200 channels`)
  ok(7, (await C.nia.get('/chat/search?q=secretword')).data.items.length === 0, 'a word that occurs only in a private channel returns nothing to a non-member')

  /* ---------------------------------------------------------------- 8 */
  log('check 8: retention, moderation, audit')
  await C.dev.put('/chat/admin/settings', { retention: { channel: 30 } })
  const oldMsg = (await C.asha.post(`/chat/conversations/${open}/messages`, { body: 'very old' })).data.message
  await q(`UPDATE env_default.sys_messages SET "createdOn" = now() - interval '31 days' WHERE id = $1`, [oldMsg.id])
  const ret = await C.dev.post('/chat/admin/retention/run')
  const stillThere = (await q('SELECT 1 FROM env_default.sys_messages WHERE id = $1', [oldMsg.id])).length
  const chg = (await C.ravi.get(`/chat/conversations/${open}/changes?after=1`)).data
  ok(8, ret.status === 200 && stillThere === 0 && chg.reset === true, 'retention 30 days, clock moved 31 days: older messages are gone and clients reload cleanly (reset)', JSON.stringify(ret.data))
  await C.dev.put('/chat/admin/settings', { retention: { channel: null } })
  const bad = (await C.ravi.post(`/chat/conversations/${open}/messages`, { body: 'not nice' })).data.message
  await C.asha.post(`/chat/messages/${bad.id}/report`, { reason: 'not nice' })
  const rep = (await C.dev.get('/chat/admin/reports')).data.items.find((r) => r.message.id === bad.id)
  await C.dev.post(`/chat/admin/reports/${rep.id}`, { action: 'delete' })
  const side = (await C.asha.post('/chat/conversations', { kind: 'channel', name: 'Side', isPrivate: true, members: [ids.ravi] })).data.id
  await C.dev.post(`/chat/admin/channels/${side}/archive`, { archived: true })
  await C.dev.del(`/chat/admin/channels/${side}/members/${ids.ravi}`)
  await C.dev.post('/chat/admin/readonly', { userId: ids.ravi, readOnly: true })
  const ro = await C.ravi.post(`/chat/conversations/${open}/messages`, { body: 'x' })
  const acts = (await q(`SELECT action, details::text AS d FROM env_default.ab_audit WHERE action LIKE 'chat.%' AND user_id = $1`, [ids.dev]))
  const need = ['chat.report.handle', 'chat.channel.archive', 'chat.member.remove', 'chat.readonly', 'chat.settings']
  ok(8, ro.status === 403, 'a person made read-only in chat cannot post')
  ok(8, need.every((a) => acts.some((x) => x.action === a)) && !acts.some((x) => x.d.includes('not nice') && x.action !== 'chat.report.handle'), 'every administrator action is in the audit log with who, when and what (not message text)', acts.map((a) => a.action).join(', '))
  } // api

  /* ---------------------------------------------------------------- the browser part (package B) */
  await browserPart({ C, ids, admin })
} catch (e) {
  failures++
  record('-', 'the run', 'FAIL', String(e?.stack ?? e).slice(0, 600))
} finally {
  for (const s of socks) s.close()
  if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(() => r())) }
  if (app) await app.close().catch(() => {})
  if (!E.KEEP) await maint(`DROP DATABASE IF EXISTS "${DB.database}"`).catch((e) => console.error(`could not drop ${DB.database}: ${e.message}`))
}

console.log('\n| Check | What | Result | Evidence |\n| --- | --- | --- | --- |')
for (const r of results) console.log(`| ${r.check} | ${r.name.replace(/\|/g, '/')} | ${r.status} | ${String(r.evidence).replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 200)} |`)
console.log(`\n${failures ? `FAIL: ${failures} check(s) failed` : 'PASS (SKIP lines are other packages\' parts)'} in ${((Date.now() - t0) / 1000).toFixed(0)} s`)
process.exit(failures ? 1 : 0)
