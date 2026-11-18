/**
 * Identity basics end-to-end run and screenshots (package I). DEVELOPER TOOL, not part of the product.
 * Needs puppeteer-core (PUPPETEER_CORE, default /tmp/pgcheck/node_modules/puppeteer-core), Chrome (CHROME_PATH) and curl.
 *
 * Start a server on an EMPTY sandbox database and workspace from the built app (npm run build first):
 *   APPBUILDER_DB_HOST=127.0.0.1 APPBUILDER_DB_PORT=5433 APPBUILDER_DB_NAME=appbuilder_test_identity APPBUILDER_DB_USER=abdev \
 *   APPBUILDER_DB_PASSWORD=abdev-sandbox-only APPBUILDER_WORKSPACE=/tmp/ws-identity APPBUILDER_JOBS_POLL_MS=200 PORT=5198 node server/main.ts
 * then:  SETUP_CODE=<printed code> node scripts/docs-shots/identity.mjs
 *
 * The script runs its own fake SMTP server (server/core/identity/fake-smtp.ts) and points the install's email settings at it.
 * Flow: invite (UI) -> set password from the emailed link -> enrol TOTP (codes computed here) -> sign out -> sign in with a
 * code -> sign in with a recovery code -> forgot password through the fake inbox -> session list revoke from a second
 * browser context (its page drops to the sign-in screen) -> service account and API key (UI) -> curl with the key.
 * Optional DEMO_FILE=dist/index.html: checks that the identity rows show as server-only in demo mode.
 * Fails with exit code 1 on the first broken check. Writes PNGs to docs/images/ (OUT).
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startFakeSmtp } from '../../server/core/identity/fake-smtp.ts'
import { base32Decode, totp, totpStep } from '../../server/core/identity/totp.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const PUPPETEER_CORE = process.env.PUPPETEER_CORE || '/tmp/pgcheck/node_modules/puppeteer-core'
const { default: puppeteer } = await import(pathToFileURL(path.join(PUPPETEER_CORE, 'lib/puppeteer/puppeteer-core.js')).href)
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome'
const BASE = (process.env.BASE || 'http://localhost:5198').replace(/\/$/, '')
const OUT = process.env.OUT || path.join(root, 'docs', 'images')
const CODE = process.env.SETUP_CODE || ''
fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) {
    process.exitCode = 1
    throw new Error(`check failed: ${what}`)
  }
}
const tid = (id) => `[data-testid="${id}"]`

/* ---------------------------------------------------------------- fake SMTP and the administrator (API) */
const smtp = await startFakeSmtp()
async function api(cookie, method, p, body) {
  const headers = { 'X-Appbuilder': '1', ...(cookie ? { Cookie: cookie } : {}) }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(BASE + '/api/v1' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const set = res.headers.getSetCookie().find((c) => c.startsWith('ab_session='))
  const data = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : await res.text()
  return { status: res.status, data, cookie: set ? set.split(';')[0] : cookie }
}
const ADMIN = { email: 'ada@example.test', password: 'Example-Only-Pass-2026' }
let r = await api('', 'POST', '/setup/admin', { name: 'Ada Admin', email: ADMIN.email, password: ADMIN.password, setupCode: CODE })
if (r.status !== 200) throw new Error(`setup: ${JSON.stringify(r.data)}`)
const adaCookie = r.cookie
r = await api(adaCookie, 'PUT', '/identity/email', { host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'apps@example.test', fromName: 'Acme Apps', installName: 'Acme Apps', publicUrl: BASE })
check(r.status === 200, 'email relay saved (fake SMTP)')

async function mail(to, subjectRe, n = 1) {
  const end = Date.now() + 20000
  for (;;) {
    const list = smtp.inbox.filter((m) => m.to.includes(to) && subjectRe.test(m.subject))
    if (list.length >= n) return list[n - 1]
    if (Date.now() > end) throw new Error(`no mail to ${to} matching ${subjectRe}`)
    await sleep(100)
  }
}

/* ---------------------------------------------------------------- browsers */
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'] })
async function context(label) {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('appbuilder-theme', 'light') } catch { /* ignore */ }
  })
  page.on('pageerror', (e) => console.log(`  [${label} page error]`, e.message))
  return { ctx, page }
}
const shot = async (page, name, wait = 400) => {
  await sleep(wait)
  await page.screenshot({ path: path.join(OUT, name + '.png') })
  console.log('  wrote', name + '.png')
}
const click = async (page, sel) => { await page.waitForSelector(sel, { visible: true }); await page.click(sel) }
const type = async (page, sel, text) => {
  await page.waitForSelector(sel, { visible: true })
  await page.click(sel, { clickCount: 3 })
  await page.keyboard.press('Backspace')
  await page.type(sel, text)
}
const visible = (page, sel, timeout = 8000) => page.waitForSelector(sel, { visible: true, timeout }).then(() => true, () => false)
async function signIn(page, email, password) {
  await page.goto(BASE + '/', { waitUntil: 'networkidle0' })
  await page.waitForSelector(tid('login-form'), { visible: true })
  await type(page, tid('login-email'), email)
  await type(page, tid('login-password'), password)
  await click(page, tid('login-submit'))
}
const signOut = (page) => page.evaluate(async () => {
  await fetch('/api/v1/auth/logout', { method: 'POST', headers: { 'X-Appbuilder': '1' } })
  location.hash = ''
  location.reload()
})
/** a code from the next unused 30-second step (a step can be used once) */
let lastStep = 0
async function nextCode(secret) {
  while (totpStep(Date.now()) <= lastStep) await sleep(1000)
  lastStep = totpStep(Date.now())
  return totp(secret)
}

try {
  /* ---------- 1. administrator invites Ivy from Admin console > Users */
  const A = await context('ada')
  await signIn(A.page, ADMIN.email, ADMIN.password)
  await A.page.waitForSelector(tid('portal-root'), { visible: true })
  await A.page.evaluate(() => { location.hash = '#admin-users' })
  await A.page.waitForSelector(tid('users-table'), { visible: true })
  await sleep(800)
  await click(A.page, tid('new-user-button'))
  await type(A.page, tid('user-name'), 'Ivy Field')
  await type(A.page, tid('user-email'), 'ivy@example.test')
  check(await visible(A.page, tid('user-invite')), 'add-user dialog offers an invitation (email is set up)')
  await shot(A.page, 'identity-add-user-invite')
  await click(A.page, tid('user-save'))
  const invite = await mail('ivy@example.test', /invited/)
  const inviteLink = /(http\S+#invite=[A-Za-z0-9_-]+)/.exec(invite.text)[1]
  check(inviteLink.startsWith(BASE), 'invitation email with a link to this install')
  await sleep(800)
  await shot(A.page, 'identity-users-invited')

  /* ---------- 2. Ivy opens the link and sets her password */
  const B = await context('ivy')
  await B.page.goto(inviteLink, { waitUntil: 'networkidle0' })
  await B.page.waitForSelector(tid('link-invite'), { visible: true })
  const IVY_PW = 'Ivy-Example-Pass-2026'
  await type(B.page, '#link-new', IVY_PW)
  await type(B.page, '#link-confirm', IVY_PW)
  await shot(B.page, 'identity-invitation')
  await click(B.page, tid('link-submit'))
  check(await visible(B.page, tid('portal-root'), 15000), 'invitation accepted: Ivy is signed in')

  /* ---------- 3. enrol TOTP in Settings > Profile */
  await B.page.evaluate(() => { location.hash = '#settings-profile' })
  await click(B.page, tid('mfa-setup'))
  await B.page.waitForSelector(`${tid('totp-qr')} svg`, { visible: true })
  await click(B.page, tid('totp-show-key'))
  await B.page.waitForSelector(tid('totp-key'), { visible: true })
  const key = await B.page.$eval(tid('totp-key'), (e) => e.textContent)
  const secret = base32Decode(key)
  await shot(B.page, 'identity-totp-enrol')
  await type(B.page, tid('totp-code'), await nextCode(secret))
  await click(B.page, tid('totp-confirm'))
  await B.page.waitForSelector(tid('recovery-codes'), { visible: true, timeout: 15000 })
  const recovery = await B.page.$$eval(`${tid('recovery-codes')} li`, (els) => els.map((e) => e.textContent))
  check(recovery.length === 10, 'ten recovery codes shown once')
  await shot(B.page, 'identity-recovery-codes')
  await click(B.page, tid('recovery-saved'))
  check(await visible(B.page, tid('mfa-on')), 'Settings shows two-step verification on')
  await shot(B.page, 'settings-security')

  /* ---------- 4. sign out, sign in with an authenticator code */
  await signOut(B.page)
  await signIn(B.page, 'ivy@example.test', IVY_PW)
  check(await visible(B.page, tid('second-step-form')), 'password accepted, second step asked')
  await shot(B.page, 'identity-second-step')
  await type(B.page, tid('mfa-code'), await nextCode(secret))
  await click(B.page, tid('mfa-submit'))
  check(await visible(B.page, tid('portal-root'), 15000), 'signed in with the authenticator code')

  /* ---------- 5. a recovery code instead */
  await signOut(B.page)
  await signIn(B.page, 'ivy@example.test', IVY_PW)
  await click(B.page, tid('mfa-use-recovery_code'))
  await type(B.page, tid('mfa-code'), recovery[0])
  await click(B.page, tid('mfa-submit'))
  check(await visible(B.page, tid('portal-root'), 15000), 'signed in with a recovery code')

  /* ---------- 6. forgot password through the fake inbox */
  await signOut(B.page)
  await B.page.waitForSelector(tid('login-form'), { visible: true })
  await click(B.page, tid('forgot-password'))
  await type(B.page, tid('forgot-email'), 'ivy@example.test')
  await click(B.page, tid('forgot-submit'))
  check(await visible(B.page, tid('forgot-done')), 'uniform "check your inbox" answer')
  await shot(B.page, 'identity-forgot-password')
  const reset = await mail('ivy@example.test', /reset your password/)
  const resetLink = /(http\S+#reset=[A-Za-z0-9_-]+)/.exec(reset.text)[1]
  await B.page.goto(resetLink, { waitUntil: 'networkidle0' })
  await B.page.waitForSelector(tid('link-reset'), { visible: true })
  const IVY_PW2 = 'Ivy-Second-Pass-2026'
  await type(B.page, '#link-new', IVY_PW2)
  await type(B.page, '#link-confirm', IVY_PW2)
  await click(B.page, tid('link-submit'))
  check(await visible(B.page, tid('link-done')), 'password reset from the emailed link')
  await click(B.page, tid('link-continue'))
  await signIn(B.page, 'ivy@example.test', IVY_PW2)
  check(await visible(B.page, tid('second-step-form')), 'two-step verification still applies after a reset')
  await type(B.page, tid('mfa-code'), await nextCode(secret))
  await click(B.page, tid('mfa-submit'))
  check(await visible(B.page, tid('portal-root'), 15000), 'signed in with the new password and a code')

  /* ---------- 7. a second browser; Ivy ends its session from the first */
  const C = await context('ivy-laptop')
  await signIn(C.page, 'ivy@example.test', IVY_PW2)
  await click(C.page, tid('mfa-use-recovery_code'))
  await type(C.page, tid('mfa-code'), recovery[1])
  await click(C.page, tid('mfa-submit'))
  check(await visible(C.page, tid('portal-root'), 15000), 'second browser signed in')
  await B.page.evaluate(() => { location.hash = '#settings-profile' })
  await B.page.waitForSelector(tid('session-list'), { visible: true })
  const rows = await B.page.$$eval(`${tid('session-list')} li`, (els) => els.map((e) => ({ id: e.getAttribute('data-testid').slice(8), current: !!e.querySelector('[data-testid="session-current"]') })))
  check(rows.length === 2 && rows.filter((x) => x.current).length === 1, 'session list: two sessions, one marked as this browser')
  await shot(B.page, 'identity-sessions')
  const other = rows.find((x) => !x.current)
  await click(B.page, tid(`session-end-${other.id}`))
  // the other browser's live socket closes; its next request finds no session and it shows the sign-in screen
  await sleep(1500)
  await C.page.evaluate(() => fetch('/api/v1/workspace', { headers: { 'X-Appbuilder': '1' } }))
  check(await visible(C.page, tid('login-form'), 10000), 'the revoked browser drops to the sign-in screen')

  /* ---------- 8. administrator: policy and email pages, service account, API key, curl */
  await A.page.evaluate(() => { location.hash = '#admin-security' })
  await A.page.waitForSelector(tid('admin-security'), { visible: true })
  await shot(A.page, 'admin-sign-in-security')
  await A.page.evaluate(() => { location.hash = '#admin-email' })
  await A.page.waitForSelector(tid('email-log-table'), { visible: true })
  await shot(A.page, 'admin-email')
  await A.page.evaluate(() => { location.hash = '#admin-service-accounts' })
  await click(A.page, tid('sa-new'))
  await type(A.page, tid('sa-name'), 'Weighbridge agent')
  await click(A.page, tid('sa-role-role_viewer'))
  await click(A.page, tid('sa-create'))
  await A.page.waitForSelector('[data-testid^="sa-key-"]', { visible: true })
  await A.page.click('[data-testid^="sa-key-"]')
  await type(A.page, tid('key-name'), 'Weighbridge PC')
  await click(A.page, tid('key-create'))
  if (await visible(A.page, tid('reauth-dialog'), 2000)) {
    await type(A.page, tid('reauth-password'), ADMIN.password)
    await click(A.page, tid('reauth-submit'))
  }
  await A.page.waitForSelector(tid('key-value'), { visible: true })
  const apiKey = await A.page.$eval(tid('key-value'), (e) => e.textContent)
  check(/^abk_[A-Za-z0-9]{8}_/.test(apiKey), 'API key shown once')
  await shot(A.page, 'admin-api-key')
  const out = execFileSync('curl', ['-sS', '-w', '\n%{http_code}', '-H', `Authorization: Bearer ${apiKey}`, '-H', 'Content-Type: application/json',
    '-d', JSON.stringify({ plan: { version: 2, table: 'Contacts', page: { size: 5 } } }), `${BASE}/api/v1/query`]).toString()
  const status = out.trim().split('\n').pop()
  check(status === '200', `curl with the API key: POST /api/v1/query answered ${status}`)
  const denied = execFileSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '-H', `Authorization: Bearer ${apiKey}`, `${BASE}/api/v1/workspace`]).toString()
  check(denied === '403', 'the key cannot reach routes outside the Data API')
  await click(A.page, '[data-testid="key-shown-dialog"] button:last-of-type')
  await sleep(500)
  await shot(A.page, 'admin-service-accounts')
  await A.page.evaluate(() => { location.hash = '#admin-users' })
  await sleep(800)
  await shot(A.page, 'admin-users')

  /* ---------- 9. demo build: identity shows as server-only */
  if (process.env.DEMO_FILE) {
    const D = await context('demo')
    await D.page.goto(pathToFileURL(path.resolve(root, process.env.DEMO_FILE)).href + '#settings-profile', { waitUntil: 'networkidle0' })
    const text = await D.page.$eval(tid('setting-2fa'), (e) => e.textContent)
    check(/Needs the local server/.test(text), 'demo mode: two-step verification row says it needs the server')
    await D.page.evaluate(() => { location.hash = '#admin-email' })
    await sleep(500)
    check(/needs the local server/i.test(await D.page.evaluate(() => document.body.innerText)), 'demo mode: Admin console > Email says it needs the server')
  }
  console.log('ALL CHECKS PASSED')
} catch (e) {
  // what each browser showed when it broke
  let i = 0
  for (const ctx of browser.browserContexts()) for (const p of await ctx.pages()) await p.screenshot({ path: path.join(OUT, `identity-failure-${i++}.png`) }).catch(() => {})
  throw e
} finally {
  await browser.close()
  await smtp.close()
}
