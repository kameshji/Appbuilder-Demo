/**
 * Headless check and screenshots of approvals (P1 package C). DEVELOPER TOOL, not part of the product.
 *
 * Needs puppeteer-core (PUPPETEER_CORE, default /tmp/pgcheck/node_modules/puppeteer-core), Chrome (CHROME_PATH), the
 * built app (`npm run build`) and a running server on an EMPTY sandbox database:
 *   APPBUILDER_DB_HOST=127.0.0.1 APPBUILDER_DB_PORT=5433 APPBUILDER_DB_NAME=appbuilder_test_c_shots \
 *   APPBUILDER_DB_USER=abdev APPBUILDER_DB_PASSWORD=abdev-sandbox-only APPBUILDER_WORKSPACE=/tmp/ws-c \
 *   APPBUILDER_SETUP_CODE_FILE=/tmp/ws-c/setup-code.txt PORT=5199 node server/main.ts
 * Run:  SETUP_CODE_FILE=/tmp/ws-c/setup-code.txt BASE=http://localhost:5199 node scripts/docs-shots/approvals.mjs
 *
 * The story (three people and a deputy): Raj submits a purchase from an app (a button with RequestApproval); Mona, his
 * manager, gets a bell notification and an email; on her phone (360 px wide) she opens the email's Approve link, signs
 * in first, and confirms on the confirmation page (opening the link decided nothing). The second stage goes to Dev, who
 * is away: he delegates to Del on the Approvals page; the waiting approval moves to Del, who rejects it on his phone with
 * a comment (required). Raj sees the outcome on the record's timeline in his app; a flow on "approval decided" set the
 * record's status. Writes PNGs to docs/images/ (OUT).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const PUPPETEER_CORE = process.env.PUPPETEER_CORE || '/tmp/pgcheck/node_modules/puppeteer-core'
const { default: puppeteer } = await import(pathToFileURL(path.join(PUPPETEER_CORE, 'lib/puppeteer/puppeteer-core.js')).href)
const { startFakeSmtp } = await import(pathToFileURL(path.join(root, 'server/core/identity/fake-smtp.ts')).href)
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome'
const BASE = (process.env.BASE || 'http://localhost:5199').replace(/\/$/, '')
const OUT = process.env.OUT || path.join(root, 'docs', 'images')
const ADMIN = { name: 'Test Admin', email: 'admin@example.test', password: 'Example-Only-Pass-2026' }
const PASS = 'Example-Only-Pass-2027'
fs.mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (cond, what) => { if (!cond) throw new Error(`CHECK FAILED: ${what}`); console.log(`ok - ${what}`) }
function jar() {
  let cookie = ''
  return async function api(method, p, body) {
    const res = await fetch(BASE + '/api/v1' + p, { method, headers: { 'X-Appbuilder': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const c of res.headers.getSetCookie?.() ?? []) { const [pair] = c.split(';'); if (pair.startsWith('ab_session=')) cookie = pair }
    const data = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : await res.text()
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(data)}`)
    return data
  }
}
const api = jar()

const smtp = await startFakeSmtp()
const setupCode = process.env.SETUP_CODE ?? (process.env.SETUP_CODE_FILE ? fs.readFileSync(process.env.SETUP_CODE_FILE, 'utf8').split('\n')[0].trim() : '')
await api('POST', '/setup/admin', { setupCode, ...ADMIN })
await api('PUT', '/identity/email', { host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'apps@example.test', installName: 'Acme Apps', publicUrl: BASE })

// people: Raj reports to Mona; Dev is the director; Del is Dev's deputy
const ids = {}
for (const [name, email, extra] of [['Mona Manager', 'mona@example.test', {}], ['Dev Director', 'dev@example.test', {}], ['Del Deputy', 'del@example.test', {}], ['Raj Requester', 'raj@example.test', {}]]) {
  const u = await api('POST', '/users', { name, email, roleIds: ['role_maker'], password: 'Temporary-Pass-1234', ...extra })
  ids[email] = u.id
  const me = jar()
  await me('POST', '/auth/login', { email, password: 'Temporary-Pass-1234' })
  await me('POST', '/auth/password', { current: 'Temporary-Pass-1234', next: PASS })
}
await api('PATCH', `/users/${ids['raj@example.test']}`, { managerId: ids['mona@example.test'] })

// the table, the policy, the flow that writes the outcome back, the app with the button
await api('POST', '/tables', { displayName: 'Purchase requests', name: 'PurchaseRequests', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Amount', type: 'number' }, { displayName: 'Status', type: 'text' }] })
await api('POST', '/approvals/policies', {
  name: 'Purchase', description: 'Manager, then the director. A comment is required to reject.',
  definition: { type: 'sequential', requireCommentOnReject: true, dueMinutes: 48 * 60, reminders: { afterMinutes: 24 * 60 }, escalation: { action: 'manager' }, stages: [{ name: 'Manager', approvers: ['manager'] }, { name: 'Director', approvers: ['dev@example.test'] }] },
})
await api('POST', '/flows', {
  name: 'Purchase status', enabled: true, settings: { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' },
  trigger: { type: 'approvalDecided', policy: 'Purchase' },
  steps: [{ id: 'u', name: 'SetStatus', kind: 'data.update', table: 'PurchaseRequests', rowId: 'Trigger.Request.RegardingId', values: { Status: 'If(Trigger.Request.Status = "approved", "Approved", "Rejected: " & First(Filter(Trigger.Responses, Response = "Reject")).Comment)' } }],
})
const app = await api('POST', '/apps', { name: 'Purchases', width: 1280, height: 800 })
const n = (id, name, type, props) => ({ id, name, type, props, children: [] })
const def = {
  formatVersion: 2, name: 'Purchases', width: 1280, height: 800, scaleMode: 'responsive', theme: { mode: 'light' }, dataSources: ['PurchaseRequests'], appProps: {},
  screens: [{
    id: 'scr1', name: 'Home', type: 'Screen', props: { Fill: '=RGBA(248, 250, 252, 1)' }, children: [
      n('c1', 'Heading1', 'Label', { X: '=32', Y: '=24', Width: '=600', Height: '=40', Text: '="New purchase request"', Size: '=24' }),
      n('c2', 'TitleInput', 'TextInput', { X: '=32', Y: '=80', Width: '=360', Height: '=40', Placeholder: '="What do you need?"' }),
      n('c3', 'AmountInput', 'TextInput', { X: '=404', Y: '=80', Width: '=160', Height: '=40', Placeholder: '="Amount"' }),
      n('c4', 'SubmitButton', 'Button', { X: '=576', Y: '=80', Width: '=220', Height: '=40', Text: '="Submit for approval"',
        OnSelect: '=Set(NewReq, Patch(PurchaseRequests, Defaults(PurchaseRequests), {Title: TitleInput.Value, Amount: Value(AmountInput.Value), Status: "Waiting"})); Set(ApprovalId, RequestApproval("Purchase", NewReq, "Purchase: " & NewReq.Title, "Please approve this purchase.", {Amount: NewReq.Amount})); Notify("Sent for approval", NotificationType.Success)' }),
      n('c5', 'Panel1', 'ApprovalsPanel', { X: '=32', Y: '=140', Width: '=520', Height: '=360', Record: '=NewReq', Table: '="PurchaseRequests"', Title: '="Approvals of this request"', ShowRequest: '=false' }),
      n('c6', 'Timeline1', 'RecordTimeline', { X: '=572', Y: '=140', Width: '=520', Height: '=520', Record: '=NewReq', Table: '="PurchaseRequests"' }),
      n('c7', 'StatusLabel', 'Label', { X: '=32', Y: '=520', Width: '=520', Height: '=30', Text: '="Status: " & LookUp(PurchaseRequests, id = NewReq.id, Status)' }),
    ],
  }],
}
await api('PUT', `/apps/${app.id}`, { definition: def })

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--window-size=1440,900'] })
const shots = []
const people = []
async function person(email, viewport) {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport(viewport)
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const p = { page, ctx, errors, email }
  people.push(p)
  return p
}
const shot = async (p, name) => { await sleep(500); await p.page.screenshot({ path: path.join(OUT, name) }); shots.push(name); console.log(`shot ${name}`) }
const click = async (p, sel) => { await p.page.waitForSelector(sel, { visible: true, timeout: 20000 }); await p.page.click(sel) }
const type = async (p, sel, text) => { await p.page.waitForSelector(sel, { visible: true, timeout: 20000 }); await p.page.click(sel, { clickCount: 3 }); await p.page.type(sel, text) }
const signIn = async (p) => {
  await p.page.waitForSelector('[data-testid="login-form"]', { visible: true, timeout: 20000 })
  await type(p, '[data-testid="login-email"]', p.email)
  await type(p, '[data-testid="login-password"]', p.email === ADMIN.email ? ADMIN.password : PASS)
  await click(p, '[data-testid="login-submit"]')
}
const text = async (p, sel) => p.page.$eval(sel, (e) => e.textContent ?? '')
const waitFor = async (fn, what, ms = 30000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(300)
  }
}
const PHONE = { width: 360, height: 740, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
const DESK = { width: 1440, height: 900 }

try {
  // 1. Raj submits from the app
  const raj = await person('raj@example.test', DESK)
  await raj.page.goto(`${BASE}/#u-${app.id}`, { waitUntil: 'networkidle0' })
  await signIn(raj)
  await raj.page.waitForSelector('[data-testid="control-TitleInput"] input', { visible: true, timeout: 30000 })
  await raj.page.type('[data-testid="control-TitleInput"] input', '20 laptops for QA')
  await raj.page.type('[data-testid="control-AmountInput"] input', '1800000')
  await click(raj, '[data-testid="control-SubmitButton"] button')
  const req = await waitFor(async () => (await api('GET', '/approvals?view=all&status=open')).items.find((x) => x.title === 'Purchase: 20 laptops for QA'), 'the request from the app')
  ok(req.requestedByName === 'Raj Requester' && req.regardingTableName === 'Purchase requests', 'Raj submitted from the app: RequestApproval made a request about the new record')
  await raj.page.waitForSelector('[data-testid="approvals-panel-row"]', { timeout: 20000 })
  await shot(raj, 'approvals-app-panel.png')

  // 2. Mona: bell notification and email with Approve / Reject links
  const mail = await waitFor(async () => smtp.inbox.find((m) => m.to.includes('mona@example.test') && /Approval needed/.test(m.subject)), 'the email to Mona')
  const approveUrl = /Approve: (\S+)/.exec(mail.text ?? '')?.[1]
  ok(approveUrl && approveUrl.includes('#u-approvals?link='), `the email has an Approve link to the confirmation page (${approveUrl?.slice(0, 60)}...)`)
  ok(/Reject: \S+#u-approvals\?link=/.test(mail.text ?? ''), 'and a Reject link')
  ok(!approveUrl.slice(0, approveUrl.indexOf('#')).includes('link='), 'the link token is in the #fragment (never sent to the server by a mail scanner)')
  // a mail scanner fetching the link URL gets the app page; nothing is decided
  const scan = await fetch(approveUrl)
  ok(scan.status === 200, 'prefetching the link only loads the app page')
  ok((await api('GET', `/approvals/${req.id}`)).request.status === 'pending', 'prefetching decided nothing')
  // the email at phone width
  const emailView = await person('mona@example.test', PHONE)
  await emailView.page.setContent(mail.html, { waitUntil: 'load' })
  await shot(emailView, 'approvals-email-phone.png')
  await emailView.ctx.close()
  const mona = await person('mona@example.test', PHONE)
  await mona.page.goto(approveUrl, { waitUntil: 'networkidle0' })
  await signIn(mona)
  await mona.page.waitForSelector('[data-testid="approval-link"]', { visible: true, timeout: 30000 })
  ok((await text(mona, '[data-testid="approval-link-response"]')) === 'Approve', 'after signing in, Mona sees the confirmation page (Approve)')
  ok((await api('GET', `/approvals/${req.id}`)).request.status === 'pending', 'still nothing decided before she confirms')
  const fitsLink = await mona.page.evaluate(() => { const r = document.querySelector('[data-testid="approval-link"]').getBoundingClientRect(); return r.left >= -1 && r.right <= window.innerWidth + 1 })
  ok(fitsLink, 'the confirmation page fits 360 px')
  await type(mona, '[data-testid="approval-link-comment"]', 'OK within budget')
  await shot(mona, 'approvals-link-confirm-phone.png')
  await click(mona, '[data-testid="approval-link-confirm"]')
  await mona.page.waitForSelector('[data-testid="approval-link-done"]', { timeout: 20000 })
  await shot(mona, 'approvals-link-done-phone.png')
  const bell = await (async () => { const m = jar(); await m('POST', '/auth/login', { email: 'mona@example.test', password: PASS }); return (await m('GET', '/notifications')).items })()
  ok(bell.some((x) => /Approval needed/.test(x.title) && x.link === `#u-approvals?id=${req.id}`), 'Mona also got the bell notification, deep-linking to the request')
  const after1 = (await api('GET', `/approvals/${req.id}`)).request
  ok(after1.currentStage === 1 && after1.assignments.some((a) => a.userName === 'Dev Director' && a.status === 'pending'), 'stage 2: Dev is asked')
  ok(after1.history.some((h) => h.action === 'responded' && h.details.via === 'email'), 'the answer is recorded as given by email link')
  // the link works once
  const again = jar()
  await again('POST', '/auth/login', { email: 'mona@example.test', password: PASS })
  const tok = decodeURIComponent(approveUrl.split('link=')[1])
  ok(!(await again('POST', '/approvals/links/inspect', { token: tok })).ok, 'the link cannot be used twice')

  // 3. Dev delegates to Del (Approvals > Delegations); the waiting approval moves to Del
  const dev = await person('dev@example.test', DESK)
  await dev.page.goto(`${BASE}/#u-approvals`, { waitUntil: 'networkidle0' })
  await signIn(dev)
  await dev.page.waitForSelector('[data-testid="approvals-page"]', { timeout: 30000 })
  await dev.page.waitForSelector('[data-testid="approvals-row"]', { timeout: 20000 })
  await shot(dev, 'approvals-inbox.png')
  await click(dev, '[data-testid="approvals-open"]')
  await dev.page.waitForSelector('[data-testid="approval-detail"]', { timeout: 20000 })
  await shot(dev, 'approvals-detail.png')
  await dev.page.evaluate(() => { const b = [...document.querySelectorAll('[data-testid="approvals-page"] button')].find((x) => x.textContent?.trim() === 'Delegations'); b?.click() })
  await type(dev, '[data-testid="delegate-to"]', 'del@example.test')
  await shot(dev, 'approvals-delegation.png')
  await click(dev, '[data-testid="delegate-save"]')
  await dev.page.waitForSelector('[data-testid="delegation-row"]', { timeout: 20000 })
  await waitFor(async () => (await api('GET', `/approvals/${req.id}`)).request.assignments.find((a) => a.userName === 'Del Deputy' && a.status === 'pending' && a.source === 'delegation'), 'the approval moved to Del')
  ok(true, 'Dev delegated to Del; the waiting approval moved to Del (retroactively)')

  // 4. Del rejects on his phone, with a comment (required)
  const del = await person('del@example.test', PHONE)
  await del.page.goto(`${BASE}/#u-approvals`, { waitUntil: 'networkidle0' })
  await signIn(del)
  await del.page.waitForSelector('[data-testid="approvals-row"]', { timeout: 30000 })
  const listFits = await del.page.evaluate(() => { const r = document.querySelector('[data-testid="approvals-list"]').getBoundingClientRect(); return r.left >= -1 && r.right <= window.innerWidth + 1 })
  ok(listFits, 'the list fits 360 px')
  await shot(del, 'approvals-list-phone.png')
  await click(del, '[data-testid="approvals-open"]')
  await del.page.waitForSelector('[data-testid="approval-detail"]', { visible: true, timeout: 20000 })
  ok(!(await del.page.$eval('[data-testid="approvals-list"]', (e) => !!e.offsetParent).catch(() => false)), 'at phone width the detail replaces the list')
  const fits = async (p, sel) => p.page.evaluate((q) => {
    const e = document.querySelector(q)
    if (!e) return 'missing'
    const r = e.getBoundingClientRect()
    const wide = [...e.querySelectorAll('*')].filter((x) => x.getBoundingClientRect().right > window.innerWidth + 1 && x.getClientRects().length).map((x) => x.tagName + '.' + String(x.className).slice(0, 40))
    return r.left >= -1 && r.right <= window.innerWidth + 1 && !wide.length ? 'ok' : `${r.left}..${r.right} of ${window.innerWidth}: ${wide.slice(0, 3).join(', ')}`
  }, sel)
  ok((await fits(del, '[data-testid="approval-detail"]')) === 'ok', `the detail fits 360 px (${await fits(del, '[data-testid="approval-detail"]')})`)
  await click(del, '[data-testid="approval-answer-Reject"]')
  await del.page.waitForSelector('[data-testid="approval-error"]', { visible: true })
  ok(/comment is required/.test(await text(del, '[data-testid="approval-error"]')), 'rejecting without a comment is refused')
  await type(del, '[data-testid="approval-comment"]', 'Wait for the new models in March')
  await shot(del, 'approvals-detail-phone.png')
  await click(del, '[data-testid="approval-answer-Reject"]')
  await waitFor(async () => (await api('GET', `/approvals/${req.id}`)).request.status === 'rejected', 'the rejection')
  ok(true, 'Del rejected with a comment')

  // 5. Raj sees the outcome on the record's timeline (and the flow set the status)
  const row = await waitFor(async () => (await api('POST', '/data/PurchaseRequests/query', { select: ['id', 'Status'] })).rows.find((r) => String(r.Status).startsWith('Rejected')), 'the approvalDecided flow')
  ok(row.Status === 'Rejected: Wait for the new models in March', `the approvalDecided flow set the status (${row.Status})`)
  await raj.page.reload({ waitUntil: 'networkidle0' })
  await raj.page.goto(`${BASE}/#u-approvals?id=${req.id}`, { waitUntil: 'networkidle0' })
  await raj.page.waitForSelector('[data-testid="approval-detail"]', { timeout: 20000 })
  ok((await text(raj, '[data-testid="approval-status"]')).includes('Rejected'), 'Raj sees "Rejected" in Approvals > Sent by me')
  await shot(raj, 'approvals-requester-detail.png')
  const tl = await (async () => { const r = jar(); await r('POST', '/auth/login', { email: 'raj@example.test', password: PASS }); return r('GET', `/collab/timeline?table=PurchaseRequests&row=${row.id}`) })()
  const events = tl.items.filter((i) => String(i.data.action).startsWith('approval.'))
  ok(events.some((e) => e.data.action === 'approval.decided' && e.data.status === 'rejected'), 'the record timeline shows the approval and its outcome (for Raj)')
  // the timeline UI component (on the record's page in an app)
  const tlPage = await person('raj@example.test', DESK)
  await tlPage.page.goto(`${BASE}/#u-approvals`, { waitUntil: 'networkidle0' })
  await signIn(tlPage)
  await tlPage.page.waitForSelector('[data-testid="approvals-page"]', { timeout: 30000 })
  await tlPage.page.evaluate(() => { const b = [...document.querySelectorAll('[data-testid="approvals-page"] button')].find((x) => x.textContent?.trim() === 'Sent by me'); b?.click() })
  await sleep(800)
  await shot(tlPage, 'approvals-sent-by-me.png')
  for (const p of [raj, mona, dev, del, tlPage]) ok(!p.errors.length, `no page errors for ${p.email} (${p.errors.join('; ').slice(0, 200)})`)
  console.log(`\nAPPROVALS HEADLESS RUN OK (${shots.length} screenshots)`)
} catch (e) {
  console.error(e)
  for (const [i, p] of people.entries()) {
    await p.page.screenshot({ path: path.join(OUT, `fail-${i}-${p.email}.png`) }).catch(() => {})
    if (p.errors.length) console.error(`page errors of ${p.email}: ${p.errors.join('; ')}`)
  }
  process.exitCode = 1
} finally {
  await browser.close()
  await smtp.close?.()
}
