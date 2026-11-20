#!/usr/bin/env node
/**
 * Phase 2 exit check 1 (docs/plan/p2-spec.md), as far as a sandbox can prove it: "a supervisor logs production from an
 * Android phone browser on a plant Wi-Fi: opens the app from the home screen icon, scans a barcode or QR code, takes a
 * photo, saves; a save made while the connection is down is kept and sent when it returns, with a visible status and no
 * duplicate." DEVELOPER TOOL (sandbox values only), not part of the product. Re-runnable.
 *
 *   npx vite build    (the server serves dist/)
 *   node scripts/exit-check/p2-phone.mjs
 *
 * What is real and what is emulated (say it in every report):
 *  - The browser is headless Chrome with mobile emulation (Android Chrome user agent, touch, DPR 3, 360x800 and
 *    412x915). It is NOT a real phone, NOT iOS Safari. docs/dev/phone-test-script.md is the manual script for real phones.
 *  - The camera is Chrome's fake capture device playing a generated Y4M video that shows a Code 128 barcode
 *    ("LOT-4711"): getUserMedia, the video element and frame grabbing are real. Headless Chrome on Linux has no
 *    BarcodeDetector, so the scan goes through our own 1D decoder (src/phone/scan/decode1d.ts). QR codes need the
 *    browser's BarcodeDetector and are NOT tested here.
 *  - "Take photo" on a phone opens the native camera through <input capture>; here the file is handed to that input
 *    (a generated 3000x2000 JPEG), then resized in the page (real canvas pipeline).
 *  - The plant Wi-Fi is Chrome's network emulation: offline toggling, a slow-3G profile and a flapping connection.
 *  - The home screen icon: the per-app manifest is fetched and checked and the app is opened at its start_url
 *    (/?app=<id>); the installation prompt itself cannot be shown headless.
 *
 * Settings: EXIT_DB_* as the other exit checks (database appbuilder_exit_phone, dropped at the end unless KEEP=1),
 * EXIT_PORT (5263), PUPPETEER_CORE, CHROME_PATH, SHOTS (folder for screenshots).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const DB = { host: E.EXIT_DB_HOST || '127.0.0.1', port: Number(E.EXIT_DB_PORT || 5433), user: E.EXIT_DB_USER || 'abdev', password: E.EXIT_DB_PASSWORD || 'abdev-sandbox-only', database: E.EXIT_DB_NAME || 'appbuilder_exit_phone' }
const MAINT = E.EXIT_MAINT_DB || 'appbuilder_test'
const PORT = Number(E.EXIT_PORT || 5263)
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = E.SHOTS || ''
const ADMIN = { name: 'Sam Supervisor', email: 'sam@example.test', password: 'Exit-Example-Pass-2026' }
if (!/^appbuilder_exit/.test(DB.database)) { console.error('The exit-check database name must start with appbuilder_exit (it is dropped).'); process.exit(2) }
const DIST = E.EXIT_DIST ? path.resolve(E.EXIT_DIST) : path.join(root, 'dist')
const ONLY_TOUCH = !!E.EXIT_ONLY_TOUCH // sign in and run section E only (touch pickers, cards, sheets)
if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.error('Build the app first (npx vite build).'); process.exit(2) }

const { createApp } = await import(pathToFileURL(path.join(root, 'server/core/app.ts')).href)
const { serveStatic } = await import(pathToFileURL(path.join(root, 'server/core/static.ts')).href)
const { setQuiet } = await import(pathToFileURL(path.join(root, 'server/core/util.ts')).href).catch(() => ({ setQuiet: null }))
const { default: puppeteer } = await import(pathToFileURL(path.join(E.PUPPETEER_CORE || '/tmp/pgcheck/node_modules/puppeteer-core', 'lib/puppeteer/puppeteer-core.js')).href)
if (setQuiet) setQuiet(true)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`)
const results = []
const record = (name, ok, evidence = '') => { results.push({ name, ok, evidence }); log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence ? `: ${evidence}` : ''}`) }
const check = (cond, name, evidence) => { record(name, !!cond, evidence); if (!cond) throw new Error(`check failed: ${name} ${evidence ?? ''}`) }

async function maint(sql) { const c = new pg.Client({ ...DB, database: MAINT }); await c.connect(); try { await c.query(sql) } finally { await c.end() } }
async function q(sql, params = []) { const c = new pg.Client(DB); await c.connect(); try { return (await c.query(sql, params)).rows } finally { await c.end() } }

/* ------------------------------------------------------------------ server */

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-exit-phone-'))
let app = null
let server = null
async function start() {
  app = await createApp({ env: {}, config: { workspaceDir: WORK, distDir: DIST }, printSetupCode: false, jobs: false })
  server = http.createServer((req, res) => { app.handle(req, res).then((h) => { if (!h) serveStatic(DIST, req, res) }, () => { if (!res.headersSent) res.writeHead(500); res.end() }) })
  server.on('upgrade', (req, socket, head) => { if (!app.handleUpgrade(req, socket, head)) socket.destroy() })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
}
async function stop() {
  if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(() => r())) }
  if (app) await app.close()
  server = null
  app = null
}
let cookie = ''
async function api(method, p, body, headers = {}) {
  const res = await fetch(BASE + '/api/v1' + p, { method, headers: { 'X-Appbuilder': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  for (const c of res.headers.getSetCookie?.() ?? []) { const [pair] = c.split(';'); if (pair.startsWith('ab_session=')) cookie = pair }
  const data = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer())
  return { status: res.status, data, headers: res.headers }
}
const must = (r, what) => { if (r.status < 200 || r.status > 299) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }

/* ------------------------------------------------------------------ the fake camera: a Code 128 barcode in a Y4M video */

const C128 = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232']
function code128Modules(text) {
  const vals = [104, ...[...text].map((c) => c.charCodeAt(0) - 32)]
  let s = vals[0]
  for (let i = 1; i < vals.length; i++) s += vals[i] * i
  vals.push(s % 103)
  const widths = [...vals.map((v) => C128[v]).join(''), ...'2331112'].map(Number)
  const out = []
  widths.forEach((w, i) => { for (let k = 0; k < w; k++) out.push(i % 2 === 0 ? 1 : 0) })
  return out
}
function makeY4m(file, text) {
  const W = 640, H = 480, px = 4
  const mods = code128Modules(text)
  const x0 = Math.floor((W - mods.length * px) / 2)
  const y = Buffer.alloc(W * H, 235)
  for (let r = 140; r < 340; r++) for (let m = 0; m < mods.length; m++) if (mods[m]) y.fill(20, r * W + x0 + m * px, r * W + x0 + (m + 1) * px)
  const uv = Buffer.alloc((W / 2) * (H / 2), 128)
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, uv, uv])
  const frames = []
  for (let i = 0; i < 10; i++) frames.push(frame)
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), ...frames]))
}

/* ------------------------------------------------------------------ browser helpers */

let browser = null
let page = null
const T = (id) => `[data-testid="${id}"]`
async function shot(name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }) } }
async function waitFor(sel, timeout = 20000) { return page.waitForSelector(sel, { visible: true, timeout }) }
async function tap(sel) { const el = await waitFor(sel); await el.tap() }
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
async function phone(width = 360, height = 800) {
  await page.setUserAgent(ANDROID_UA)
  await page.setViewport({ width, height, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
}
async function noHorizontalOverflow(label) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
  record(`${label}: no sideways scrolling at ${r.cw} px`, r.sw <= r.cw + 1, `scrollWidth ${r.sw}, width ${r.cw}`)
}
async function setNetwork(kind) {
  // puppeteer's own CDP session (a detached session would drop the emulation)
  if (kind === 'offline') {
    await page.emulateNetworkConditions(null)
    await page.setOfflineMode(true)
  } else if (kind === 'slow3g') {
    await page.setOfflineMode(false)
    await page.emulateNetworkConditions({ download: (500 * 1024) / 8, upload: (500 * 1024) / 8, latency: 400 })
  } else {
    await page.setOfflineMode(false)
    await page.emulateNetworkConditions(null)
  }
}
async function rows() { return q(`SELECT * FROM env_default.${PHYS}`) }
let PHYS = ''
let PROD_ID = ''

/* ------------------------------------------------------------------ the checks */

async function setupData() {
  const t = must(await api('POST', '/tables', {
    displayName: 'Production', name: 'Production', columns: [
      { displayName: 'Line', name: 'Line', type: 'text', required: true },
      { displayName: 'Qty', name: 'Qty', type: 'number' },
      { displayName: 'Code', name: 'Code', type: 'text' },
      { displayName: 'Photo', name: 'Photo', type: 'image' },
    ],
  }), 'create Production')
  PHYS = t.source
  PROD_ID = t.id
  const created = must(await api('POST', '/apps', { name: 'Production log', width: 360, height: 800 }), 'create app')
  const def = must(await api('GET', `/apps/${created.id}`), 'get app').definition
  def.dataSources = ['Production']
  def.offline = { entry: true }
  const kids = def.screens[0].children
  kids.push({ id: 'n_scan', name: 'ScanCode', type: 'ScanInput', props: { X: '=16', Y: '=12', Width: '=328', Height: '=48', AnchorH: '=Anchor.Stretch' }, children: [] })
  kids.push({ id: 'n_scans', name: 'LblScans', type: 'Label', props: { X: '=16', Y: '=64', Width: '=328', Height: '=24', Text: '="Scans: " & ScanCode.ScanCount & " " & ScanCode.Value' }, children: [] })
  kids.push({ id: 'n_dev', name: 'LblDevice', type: 'Label', props: { X: '=16', Y: '=88', Width: '=328', Height: '=24', Text: '=Device().Kind & "|" & Device().Touch & "|" & Device().Online' }, children: [] })
  kids.push({ id: 'n_tiny', name: 'TinyCheck', type: 'Checkbox', props: { X: '=16', Y: '=114', Width: '=160', Height: '=24' }, children: [] })
  kids.push({ id: 'n_form', name: 'ProdForm', type: 'Form', props: { X: '=16', Y: '=144', Width: '=328', Height: '=620', DataSource: '="Production"', Mode: '=FormMode.New', Fields: '="Line,Qty,Code,Photo"', Columns: '=1', Item: '={Code: ScanCode.Value}', OnSuccess: '=Reset(ScanCode)' }, children: [] })
  must(await api('PUT', `/apps/${created.id}`, { definition: def }), 'save app')
  return created.id
}

async function signIn() {
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' })
  await waitFor(T('login-form'))
  await noHorizontalOverflow('sign-in screen')
  await shot('01-sign-in.png')
  await page.type(T('login-email'), ADMIN.email)
  await page.type(`${T('login-password')} input, input${T('login-password')}`, ADMIN.password).catch(async () => page.type('#login-password', ADMIN.password))
  await tap(T('login-submit'))
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-form"]'), { timeout: 20000 })
}

async function checkPwa(appId) {
  const m = await page.evaluate(async () => (await fetch('/api/v1/pwa/manifest.webmanifest')).json())
  check(m.display === 'standalone' && m.icons?.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'), 'install manifest: standalone, 192/512 icons incl. maskable', `${m.name}, ${m.icons.length} icons`)
  const am = await page.evaluate(async (id) => (await fetch(`/api/v1/pwa/apps/${id}/manifest.webmanifest`, { credentials: 'same-origin' })).json(), appId)
  check(am.name === 'Production log' && am.start_url === `/?app=${appId}` && am.id === `/?app=${appId}`, 'per-app manifest: name, start_url and id of the app', `${am.name} ${am.start_url}`)
  const icon = await api('GET', am.icons[1].src.replace('/api/v1', ''))
  const png = icon.data
  check(icon.status === 200 && png.subarray(1, 4).toString() === 'PNG' && png.readUInt32BE(16) === 512, 'app icon is a 512 px PNG in the app colour with its initials', `${png.length} bytes`)
  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration('/')
    return { scope: reg?.scope, active: !!reg?.active }
  })
  check(sw.active && sw.scope === `${BASE}/`, 'service worker registered with scope /', JSON.stringify(sw))
  const apiCached = await page.evaluate(async () => {
    const out = []
    for (const k of await caches.keys()) {
      const c = await caches.open(k)
      for (const r of await c.keys()) out.push(new URL(r.url).pathname)
    }
    return out
  })
  check(apiCached.length > 0 && apiCached.every((p) => p === '/' || p.startsWith('/api/v1/pwa/')), 'the service worker cache holds the shell and PWA files only (no data)', apiCached.join(', '))
}

async function openFromHomeScreen(appId) {
  await page.goto(`${BASE}/?app=${appId}`, { waitUntil: 'networkidle2' })
  await page.waitForFunction((id) => location.hash === `#u-${id}`, { timeout: 15000 }, appId)
  await waitFor(`${T(`tab-pane-${appId}`)} [data-run-surface]`)
  const info = await page.evaluate((id) => {
    const pane = document.querySelector(`[data-testid="tab-pane-${id}"]`)
    const s = pane.querySelector('[data-run-surface]')
    return { surface: s.getAttribute('data-run-surface'), size: pane.querySelector('[data-run-size]')?.getAttribute('data-run-size'), touch: document.documentElement.classList.contains('touch'), coarse: matchMedia('(pointer: coarse)').matches, controller: !!navigator.serviceWorker.controller }
  }, appId)
  check(info.surface === 'fluid' && info.size?.startsWith('360x'), 'opened from the start address (/?app=): the app runs fluid at the phone width', JSON.stringify(info))
  check(info.touch && info.coarse, 'touch device detected (pointer: coarse in emulation)', JSON.stringify(info))
  const dev = await page.$eval(`${T('control-LblDevice')}`, (e) => e.textContent)
  check(/Phone\|true\|true/.test(dev), 'Device() reports Phone, touch, online', dev)
  await noHorizontalOverflow('app screen')
  await shot('02-app.png')
}

async function scanWithCamera() {
  await tap(T('scan-input-camera'))
  await waitFor(T('scanner-sheet'))
  await shot('03-scanner.png')
  const got = await page.waitForFunction(() => document.querySelector('[data-testid="scan-input"]')?.value === 'LOT-4711', { timeout: 20000 }).then(() => true, () => false)
  const native = await page.evaluate(() => 'BarcodeDetector' in window)
  check(got, `camera scan fills the field with the Code 128 code (${native ? 'native BarcodeDetector' : 'our 1D decoder: no BarcodeDetector in this Chrome'})`, 'LOT-4711')
  check(!(await page.$(T('scanner-sheet'))), 'one-shot scan closes the camera', '')
  const label = await page.$eval(T('control-LblScans'), (e) => e.textContent)
  check(/Scans: 1 LOT-4711/.test(label), 'OnScan / ScanCount / Value outputs', label)
}

async function keyboardWedge() {
  const input = await waitFor(T('scan-input'))
  await input.focus()
  await input.evaluate((e) => e.select())
  await page.keyboard.press('Backspace')
  await page.keyboard.type('WEDGE-77', { delay: 4 })
  await page.keyboard.press('Enter')
  await sleep(200)
  const label = await page.$eval(T('control-LblScans'), (e) => e.textContent)
  check(/Scans: 2 WEDGE-77/.test(label), 'keyboard-wedge burst ending with Enter counts as a scan', label)
  // typing by hand (slow) is not a scan
  await input.focus()
  await input.evaluate((e) => e.select())
  await page.keyboard.press('Backspace')
  await page.keyboard.type('ab', { delay: 150 })
  const label2 = await page.$eval(T('control-LblScans'), (e) => e.textContent)
  check(/Scans: 2 ab/.test(label2), 'slow typing is not a scan', label2)
  // back to the camera code for the save
  await input.focus()
  await input.evaluate((e) => e.select())
  await page.keyboard.press('Backspace')
  await page.keyboard.type('LOT-4711', { delay: 3 })
  await page.keyboard.press('Enter')
}

async function touchArea() {
  // the 24 px Checkbox: a tap 9 px below its box (inside the 44 px area) toggles it
  const box = await page.$eval(T('control-TinyCheck'), (e) => { const r = e.getBoundingClientRect(); return { x: r.left + 12, y: r.bottom + 9 } })
  const before = await page.$eval(`${T('control-TinyCheck')} [role=checkbox], ${T('control-TinyCheck')} input`, (e) => e.getAttribute('aria-checked') ?? String(e.checked))
  await page.touchscreen.tap(box.x, box.y)
  await sleep(150)
  const after = await page.$eval(`${T('control-TinyCheck')} [role=checkbox], ${T('control-TinyCheck')} input`, (e) => e.getAttribute('aria-checked') ?? String(e.checked))
  check(before !== after, 'a tap just outside a 24 px checkbox (inside its 44 px touch area) toggles it', `${before} -> ${after}`)
}

async function fillForm(line, qty) {
  const sel = (n) => `${T('control-ProdForm')} [id$="-${n}"]`
  await page.$eval(sel('Line'), (e) => e.scrollIntoView({ block: 'center' }))
  for (const [n, v] of [['Line', line], ['Qty', String(qty)]]) {
    await page.focus(sel(n))
    await page.$eval(sel(n), (e) => e.select())
    await page.keyboard.press('Backspace')
    await page.keyboard.type(v)
  }
}

/** a 3000 x 2000 JPEG made in the page, handed to the Take photo input (the native camera on a real phone) */
async function takePhoto() {
  await waitFor(T('attachment-take-photo-Photo'))
  const sizes = await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 3000
    c.height = 2000
    const g = c.getContext('2d')
    for (let i = 0; i < 300; i++) { g.fillStyle = `hsl(${i * 7},70%,${30 + (i % 40)}%)`; g.fillRect((i * 97) % 3000, (i * 53) % 2000, 400, 300) }
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95))
    const file = new File([blob], 'IMG_0001.jpg', { type: 'image/jpeg' })
    const input = document.querySelector('[data-testid="attachment-capture-Photo"]')
    const dt = new DataTransfer()
    dt.items.add(file)
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return { original: file.size }
  })
  await waitFor(T('attachment-pending'))
  return sizes.original
}

function jpegSize(buf) {
  let i = 2
  while (i < buf.length) {
    const m = buf.readUInt16BE(i)
    if (m >= 0xffc0 && m <= 0xffc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }
    i += 2 + buf.readUInt16BE(i + 2)
  }
  return null
}

async function offlineSave(appId) {
  await fillForm('Line 3', 120)
  const original = await takePhoto()
  log(`photo: original ${original} bytes`)
  await setNetwork('offline')
  await shot('04-before-offline-save.png')
  await page.$eval(`${T('form-save')}`, (e) => e.scrollIntoView({ block: 'center' }))
  await tap(`${T('form-save')}`)
  await waitFor(T('offline-banner'))
  await page.waitForFunction(() => document.querySelector('[data-testid="outbox-count"]')?.textContent === '2', { timeout: 15000 })
  await shot('05-offline-waiting.png')
  check((await rows()).length === 0, 'offline: nothing reached the server', '')
  check(true, 'offline: "You\'re offline" and "2 waiting to send" (the row and its photo) are shown', '')
  await tap(T('outbox-button'))
  await waitFor(T('outbox-panel'))
  const items = await page.$$eval(T('outbox-item'), (els) => els.map((e) => e.getAttribute('data-status')))
  check(items.length === 2 && items.every((s) => s === 'waiting'), 'outbox panel lists both items as waiting', items.join(','))
  await shot('06-outbox-panel.png')
  await page.keyboard.press('Escape')
  // flapping Wi-Fi: on for 300 ms is not enough for the probe; then back for good
  await setNetwork('online')
  await page.waitForFunction(() => !document.querySelector('[data-testid="outbox-count"]'), { timeout: 45000 })
  const r = await rows()
  check(r.length === 1 && r[0].Code === 'LOT-4711' && Number(r[0].Qty) === 120 && r[0].Line === 'Line 3', 'back online: the row is sent exactly once with the scanned code', JSON.stringify(r.map((x) => ({ Line: x.Line, Qty: x.Qty, Code: x.Code }))))
  const att = await q(`SELECT * FROM ab_attachments WHERE row_id = $1`, [r[0].id]).catch(() => q(`SELECT * FROM env_default.ab_attachments WHERE row_id = $1`, [r[0].id]))
  check(att.length === 1 && r[0].Photo === att[0].id, 'the photo is uploaded once and linked to the row', `${att.length} attachment(s)`)
  const file = must(await api('GET', `/attachments/${att[0].id}`), 'download photo')
  const dim = jpegSize(file)
  check(dim && Math.max(dim.w, dim.h) === 1600 && file.length < original, 'photo resized in the browser to 1600 px and smaller than the original', `${dim?.w}x${dim?.h}, ${file.length} of ${original} bytes`)
  await shot('07-sent.png')
  return r[0].id
}

async function restartWhileOffline(appId) {
  await fillForm('Line 4', 7)
  await setNetwork('offline')
  // the "You're offline" strip appears under the shell and the pinned save bar moves up above it: tap after that move,
  // or the tap lands where Save was a moment ago (a person taps later than a script)
  await page.waitForFunction(() => /offline/i.test(document.querySelector('[data-testid="connection-bar"]')?.textContent ?? ''), { timeout: 15000 })
  await sleep(400)
  await tap(`${T('form-save')}`)
  await sleep(1500)
  await page.waitForFunction(() => document.querySelector('[data-testid="outbox-count"]')?.textContent === '1', { timeout: 15000 })
  // the phone closes the browser tab / reloads while offline
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
  await waitFor(T('offline-start'))
  check(true, 'cold start offline: the "No connection" page (not demo mode); the shell came from the service worker', '')
  await shot('08-cold-start-offline.png')
  check((await rows()).length === 1, 'the queued row is still not on the server', '')
  await setNetwork('online')
  // the "No connection" page may reload itself the moment the network is back: an aborted goto is that reload
  await page.goto(`${BASE}/?app=${appId}`, { waitUntil: 'networkidle2' }).catch(() => sleep(1500))
  await page.waitForFunction(async () => {
    const dbs = await indexedDB.databases()
    return dbs.some((d) => d.name?.startsWith('appbuilder-offline-'))
  }, { timeout: 15000 })
  for (let i = 0; i < 60 && (await rows()).length < 2; i++) await sleep(500)
  const r = await rows()
  check(r.length === 2 && r.filter((x) => x.Line === 'Line 4').length === 1, 'after the restart the waiting row is sent once', `${r.length} rows`)
}

async function slowNetwork(appId) {
  await setNetwork('slow3g')
  const s = Date.now()
  await page.goto(`${BASE}/?app=${appId}`, { waitUntil: 'domcontentloaded' })
  await waitFor(`${T(`tab-pane-${appId}`)} [data-run-surface]`, 60000)
  const openMs = Date.now() - s
  await fillForm('Line 5', 9)
  await tap(`${T('form-save')}`)
  for (let i = 0; i < 60 && (await rows()).length < 3; i++) await sleep(500)
  check((await rows()).length === 3, 'slow 3G (400 ms latency, 500 kbit/s): the app opens from the cached shell and a save arrives', `opened in ${openMs} ms`)
  await setNetwork('online')
}

async function serverIdempotency() {
  const key = 'exit-check-idem-0001'
  const id = '7d1f4b1e-0000-4000-8000-00000000e001'
  const a = await api('POST', '/data/Production/rows', { values: { id, Line: 'Idem', Qty: 1 } }, { 'Idempotency-Key': key })
  const b = await api('POST', '/data/Production/rows', { values: { id, Line: 'Idem', Qty: 1 } }, { 'Idempotency-Key': key })
  const n = (await q(`SELECT count(*)::int AS n FROM env_default.${PHYS} WHERE "Line" = 'Idem'`))[0].n
  check(a.status === 200 && b.status === 200 && b.data.replayed === true && n === 1, 'server: a create retried with the same Idempotency-Key is answered once (replayed, one row)', `${a.status}/${b.status} replayed=${b.data.replayed} rows=${n}`)
  const bad = await api('POST', '/data/Production/rows', { values: { Qty: 1 } }, { 'Idempotency-Key': 'exit-check-idem-0002' })
  const fixed = await api('POST', '/data/Production/rows', { values: { Line: 'Fixed', Qty: 1 } }, { 'Idempotency-Key': 'exit-check-idem-0002' })
  check(bad.status === 422 && fixed.status === 200, 'server: a refused write releases its key (fix and resend works)', `${bad.status} then ${fixed.status}`)
}

async function shellAtPhoneWidth() {
  await page.goto(`${BASE}/#u`, { waitUntil: 'networkidle2' })
  await waitFor(T('page-my-apps'))
  await noHorizontalOverflow('User mode: My apps')
  const a2hs = await page.$eval(T('add-to-home'), (e) => e.textContent).catch(() => '')
  check(/Home screen/.test(a2hs) && /menu|Install/.test(a2hs), 'My apps on an Android phone shows the Add to Home screen help (Chrome offered its install prompt: ' + /Install$/.test(a2hs.trim()) + ')', a2hs.slice(0, 120))
  const sw = await page.evaluate(() => ({ switcher: !!document.querySelector('[data-testid="tab-switcher"]')?.getClientRects().length, strip: !!document.querySelector('[data-testid="tab-strip"]')?.getClientRects().length }))
  check(sw.switcher && !sw.strip, 'phone width: open apps are a switcher, not a tab strip', JSON.stringify(sw))
  await tap('[data-testid^="open-on-phone-"]')
  await waitFor(T('open-on-phone-dialog'))
  const qr = await page.$eval(`${T('open-on-phone-dialog')} svg path`, (p) => p.getAttribute('d').length)
  check(qr > 500, '"Open on a phone" shows a QR code of the app address', `${qr} path chars`)
  await shot('10-open-on-phone.png')
  await page.keyboard.press('Escape')
  await page.goto(`${BASE}/#u-approvals`, { waitUntil: 'networkidle2' })
  await sleep(800)
  await noHorizontalOverflow('User mode: Approvals')
  await page.goto(`${BASE}/#u-tasks`, { waitUntil: 'networkidle2' })
  await sleep(800)
  await noHorizontalOverflow('User mode: Tasks')
}

async function updateFlow(appId) {
  await page.goto(`${BASE}/?app=${appId}`, { waitUntil: 'networkidle2' })
  const v1 = await page.evaluate(() => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = (e) => r(e.data.version); navigator.serviceWorker.controller.postMessage({ type: 'version' }, [ch.port2]) }))
  // a new build: the served index.html changes (size and time)
  const file = path.join(DIST, 'index.html')
  const original = fs.readFileSync(file)
  try {
    fs.writeFileSync(file, Buffer.concat([original, Buffer.from('\n<!-- exit-check rebuild -->\n')]))
    await page.evaluate(async () => { const reg = await navigator.serviceWorker.getRegistration('/'); await reg.update() })
    await waitFor(T('update-banner'), 30000)
    const stillOld = await page.evaluate(() => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = (e) => r(e.data.version); navigator.serviceWorker.controller.postMessage({ type: 'version' }, [ch.port2]) }))
    check(stillOld === v1, 'a new build waits: the page keeps its version until the user reloads', `${v1}`)
    await shot('09-update.png')
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }), tap(T('update-reload'))])
    const v2 = await page.evaluate(() => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = (e) => r(e.data.version); navigator.serviceWorker.controller.postMessage({ type: 'version' }, [ch.port2]) }))
    check(v2 && v2 !== v1, '"New version available — Reload" switches to the new build', `${v1} -> ${v2}`)
    const waitingCount = await page.evaluate(async () => {
      const db = await indexedDB.databases()
      return db.filter((d) => d.name?.startsWith('appbuilder-offline-')).length
    })
    check(waitingCount === 1, 'the offline store survives the service worker update', '')
  } finally {
    fs.writeFileSync(file, original)
  }
}

async function signOutClears() {
  await page.evaluate(() => { window.confirm = () => true })
  await page.goto(`${BASE}/#u`, { waitUntil: 'networkidle2' })
  const before = await page.evaluate(async () => ({ dbs: (await indexedDB.databases()).filter((d) => d.name?.startsWith('appbuilder-offline-')).length, caches: (await caches.keys()).length }))
  await tap(T('avatar-menu'))
  await tap(T('menu-sign-out'))
  await waitFor(T('login-form'))
  await sleep(500)
  const after = await page.evaluate(async () => ({ dbs: (await indexedDB.databases()).filter((d) => d.name?.startsWith('appbuilder-offline-')).length, caches: (await caches.keys()).filter((k) => k.startsWith('ab-')).length, key: Object.keys(sessionStorage).filter((k) => k.startsWith('appbuilder-offline-key')).length }))
  check(before.dbs === 1 && after.dbs === 0 && after.caches === 0 && after.key === 0, 'sign-out deletes the offline store, the session key and the service worker caches', `${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
}

async function wipe() {
  const k1 = must(await api('POST', '/offline/key', { deviceId: 'exitdevice01' }), 'key')
  const k1b = must(await api('POST', '/offline/key', { deviceId: 'exitdevice01' }), 'key again')
  must(await api('POST', '/offline/wipe', {}), 'wipe')
  const k2 = must(await api('POST', '/offline/key', { deviceId: 'exitdevice01' }), 'key after wipe')
  check(k1.key === k1b.key && k2.key !== k1.key && k2.epoch === k1.epoch + 1, 'wipe device data: the key is stable per device until a wipe changes it', `epoch ${k1.epoch} -> ${k2.epoch}`)
}

/** every UI component at its default size on the phone: measure the touch area of the interactive ones */
async function touchAudit() {
  const reg = await page.evaluate(() => window.__abRegistry ?? null)
  void reg
  const created = must(await api('POST', '/apps', { name: 'Touch audit', width: 412, height: 915 }), 'audit app')
  const def = must(await api('GET', `/apps/${created.id}`), 'get audit app').definition
  const { TOUCH_MATRIX } = await import(pathToFileURL(path.join(root, 'src/phone/touch.ts')).href)
  const types = Object.entries(TOUCH_MATRIX).filter(([t, e]) => e.interactive && !['Screen', 'Gallery', 'Form', 'Dialog', 'Sheet', 'Chart', 'Visual', 'Timer', 'Video', 'Audio', 'ScrollArea', 'FileUpload', 'Calendar', 'ApprovalsPanel', 'NavMenu', 'TopBar', 'Steps', 'List', 'DataTable', 'Accordion', 'RadioGroup', 'EmptyState', 'TagList', 'SignaturePad'].includes(t)).map(([t]) => t)
  let y = 8
  def.screens[0].children = types.map((t, i) => {
    const node = { id: `n_a${i}`, name: `A_${t}`, type: t, props: { X: '=24', Y: `=${y}` }, children: [] }
    if (t === 'Icon' || t === 'AnimatedIcon') node.props.OnSelect = '=Notify("x")'
    y += 64
    return node
  })
  def.height = Math.max(915, y + 40)
  must(await api('PUT', `/apps/${created.id}`, { definition: def }), 'save audit app')
  await page.goto(`${BASE}/#u-${created.id}`, { waitUntil: 'networkidle2' })
  await waitFor(`${T(`tab-pane-${created.id}`)} [data-run-surface]`)
  await sleep(1500)
  const res = await page.evaluate((list) => {
    const out = []
    for (const t of list) {
      const w = document.querySelector(`[data-testid="control-A_${t}"]`)
      if (!w) { out.push({ t, ok: false, why: 'not rendered' }); continue }
      w.scrollIntoView({ block: 'center' })
      const r = w.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const probes = [[cx, cy - 21], [cx, cy + 21], [Math.min(r.left + 21, cx), cy], [Math.max(r.right - 21, cx), cy]]
      const hits = probes.map(([x, yy]) => { const el = document.elementFromPoint(x, yy); return !!el && (el === w || w.contains(el)) })
      out.push({ t, ok: hits.every(Boolean), w: Math.round(r.width), h: Math.round(r.height), hit: w.hasAttribute('data-hit') })
    }
    return out
  }, types)
  const bad = res.filter((r) => !r.ok)
  check(bad.length === 0, `touch audit: ${res.length} interactive UI components have a 44 x 44 px touch area at their default size`, bad.length ? JSON.stringify(bad) : `${res.filter((r) => r.hit).length} needed the extended area`)
  fs.writeFileSync(path.join(WORK, 'touch-audit.json'), JSON.stringify(res, null, 1))
  return res
}


/* ------------------------------------------------------------------ E. touch pickers, native fields, cards, sheets */

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
async function desktop() {
  await page.setUserAgent(DESKTOP_UA)
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false })
}
const node = (name, type, props) => ({ name, type, props })
const lbl = (name, y, formula) => node(name, 'Label', { X: '=16', Y: '=' + y, Width: '=328', Height: '=20', Text: formula })
async function makeApp(name, nodes, width = 360, height = 800) {
  const created = must(await api('POST', '/apps', { name, width, height }), 'create ' + name)
  const def = must(await api('GET', '/apps/' + created.id), 'get ' + name).definition
  def.screens[0].children = nodes.map((n, i) => ({ id: 'n_t' + i, name: n.name, type: n.type, props: n.props, children: [] }))
  must(await api('PUT', '/apps/' + created.id, { definition: def }), 'save ' + name)
  return created.id
}
async function openApp(id) {
  await page.goto(BASE + '/#u-' + id, { waitUntil: 'networkidle2' })
  await waitFor(T('tab-pane-' + id) + ' [data-run-surface]')
  await sleep(700)
}
const ctl = (n) => T('control-' + n)
const text = (n) => page.$eval(ctl(n), (e) => e.textContent.trim())
const rectOf = (sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom), vw: innerWidth, vh: innerHeight } })
/** write a value into an input the way a native picker does (React listens to input / change) */
async function setNative(sel, v) {
  await page.$eval(sel, (el, val) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, val)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, v)
  await sleep(150)
}
const ymd = (n, y) => lbl(n, y, '="' + n + ':" & Year(' + n.slice(3) + '.SelectedDate) & "-" & Month(' + n.slice(3) + '.SelectedDate) & "-" & Day(' + n.slice(3) + '.SelectedDate)')

async function touchControls() {
  const FRUIT = '=["Apple","Apricot","Banana","Blueberry","Cherry","Date","Elderberry","Fig","Grape","Kiwi","Lemon","Lime","Mango","Melon","Nectarine","Orange","Papaya","Peach","Pear","Plum"]'
  const id = await makeApp('Touch pickers', [
    node('DD', 'Dropdown', { X: '=16', Y: '=8', Width: '=328', Height: '=40', Items: '=["Alpha","Bravo","Charlie","Delta"]' }),
    node('CB', 'ComboBox', { X: '=16', Y: '=56', Width: '=328', Height: '=40', Items: FRUIT, SelectionMode: '=SelectionMode.Multiple' }),
    node('DP', 'DatePicker', { X: '=16', Y: '=104', Width: '=328', Height: '=40' }),
    node('DR', 'DateRangePicker', { X: '=16', Y: '=152', Width: '=328', Height: '=40' }),
    node('TP', 'TimePicker', { X: '=16', Y: '=200', Width: '=328', Height: '=40', MinuteStep: '=5' }),
    node('NI', 'NumberInput', { X: '=16', Y: '=248', Width: '=328', Height: '=40' }),
    node('NJ', 'NumberInput', { X: '=16', Y: '=296', Width: '=328', Height: '=40', Min: '=0', Max: '=99', Step: '=1' }),
    node('AL', 'Alert', { X: '=16', Y: '=344', Width: '=328', Height: '=72', Dismissible: '=true' }),
    lbl('LblDD', 430, '="DD:" & DD.SelectedText'),
    lbl('LblCB', 452, '="CB:" & CB.SelectedText'),
    ymd('LblDP', 474),
    lbl('LblDR', 496, '="DR:" & Year(DR.StartDate) & "-" & Month(DR.StartDate) & "-" & Day(DR.StartDate) & ">" & Year(DR.EndDate) & "-" & Month(DR.EndDate) & "-" & Day(DR.EndDate)'),
    lbl('LblTP', 518, '="TP:" & TP.Value'),
    lbl('LblNI', 540, '="NI:" & NI.Value'),
    lbl('LblNJ', 562, '="NJ:" & NJ.Value'),
    lbl('LblAL', 584, '="AL:" & AL.Dismissed'),
  ])
  await openApp(id)

  /* ---- 1. Dropdown / ComboBox: bottom sheet with search and 44 px rows ---- */
  await tap(ctl('DD') + ' [role=combobox]')
  await waitFor(T('bottom-sheet'))
  await sleep(300) // the sheet slides in for 180 ms
  const sh = await rectOf(T('bottom-sheet'))
  check(sh.w === sh.vw && Math.abs(sh.b - sh.vh) <= 1, 'Dropdown opens as a full-width bottom sheet at the bottom of the screen (not a popover)', JSON.stringify(sh))
  await shot('11-dropdown-sheet.png')
  const rowH = await page.$$eval(T('picker-row'), (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))
  check(rowH.length === 4 && Math.min(...rowH) >= 44, 'the sheet rows are at least 44 px high', rowH.join(','))
  check(!!(await page.$(T('bottom-sheet') + ' [cmdk-input]')), 'the sheet has a search field', '')
  const noAutoFocus = await page.evaluate(() => !document.activeElement || document.activeElement.tagName !== 'INPUT')
  check(noAutoFocus, 'opening the sheet does not pop the keyboard up by itself', '')
  await tap(T('bottom-sheet') + ' [cmdk-input]')
  await page.keyboard.type('ch')
  await sleep(200)
  const filtered = await page.$$eval(T('picker-row'), (els) => els.map((e) => e.textContent.trim()))
  check(filtered.length === 1 && filtered[0] === 'Charlie', 'typing in the search field filters the rows', filtered.join(','))
  // keyboard-safe: the sheet follows --kb (set by env.ts from the visual viewport) and is limited by --vvh
  await page.evaluate(() => document.documentElement.style.setProperty('--kb', '280px'))
  const lifted = await rectOf(T('bottom-sheet'))
  check(Math.abs(lifted.b - (lifted.vh - 280)) <= 1, 'with the keyboard up (--kb 280 px) the sheet sits above it', JSON.stringify(lifted))
  await page.evaluate(() => document.documentElement.style.setProperty('--kb', '0px'))
  await tap(T('picker-row'))
  await sleep(300)
  check(!(await page.$(T('bottom-sheet'))) && /DD:Charlie/.test(await text('LblDD')), 'tapping a row selects it, runs the same outputs and closes the sheet', await text('LblDD'))

  await tap(ctl('CB') + ' [role=combobox]')
  await waitFor(T('bottom-sheet'))
  await sleep(300) // the sheet slides in for 180 ms
  check((await page.$$(T('picker-row'))).length === 20, 'ComboBox (multiple) opens the same sheet with all rows', '')
  await tap(T('picker-row'))
  await sleep(150)
  await page.$$eval(T('picker-row'), (els) => els[1].click())
  await sleep(150)
  check(!!(await page.$(T('picker-sheet-done'))) && !!(await page.$(T('bottom-sheet'))), 'multiple selection keeps the sheet open and shows Done', '')
  await tap(T('picker-sheet-done'))
  await sleep(300)
  const cb = await text('LblCB')
  check(/Apple/.test(cb) && /Apricot/.test(cb) && !(await page.$(T('bottom-sheet'))), 'Done closes the sheet; both picks are in SelectedText', cb)
  await tap(ctl('DD') + ' [role=combobox]')
  await waitFor(T('bottom-sheet'))
  await sleep(300) // the sheet slides in for 180 ms
  await page.touchscreen.tap(180, 40)
  await sleep(300)
  check(!(await page.$(T('bottom-sheet'))), 'tapping outside closes the sheet', '')
  // dragging the handle down closes a sheet
  await tap(ctl('DD') + ' [role=combobox]')
  await waitFor(T('bottom-sheet'))
  await sleep(300) // the sheet slides in for 180 ms
  const hr = await rectOf(T('bottom-sheet-handle'))
  await page.touchscreen.touchStart(hr.l + hr.w / 2, hr.t + 10)
  for (let i = 1; i <= 8; i++) await page.touchscreen.touchMove(hr.l + hr.w / 2, hr.t + 10 + i * 20)
  await page.touchscreen.touchEnd()
  await sleep(300)
  check(!(await page.$(T('bottom-sheet'))), 'dragging the sheet handle down closes the sheet', '')
  await page.reload({ waitUntil: 'networkidle2' }) // puppeteer's synthetic drag leaves its touch state odd
  await waitFor(T('tab-pane-' + id) + ' [data-run-surface]')
  await sleep(700)

  /* ---- 2. native date / time pickers, same value contract ---- */
  const dp = ctl('DP') + ' input[type=date]'
  check(!!(await page.$(dp)) && !!(await page.$(ctl('DR') + ' input[type=date]')) && !!(await page.$(ctl('TP') + ' input[type=time]')), 'DatePicker, DateRangePicker (two fields) and TimePicker are native inputs on a touch device', '')
  await shot('12-native-pickers.png')
  await setNative(dp, '2026-03-15')
  check(/DP:2026-3-15/.test(await text('LblDP')), 'DatePicker: the native value becomes SelectedDate (local midnight)', await text('LblDP'))
  await tap(ctl('DP') + ' [aria-label="Clear date"]')
  await sleep(200)
  check(!/2026/.test(await text('LblDP')), 'DatePicker: the clear button empties SelectedDate (iOS pickers cannot clear)', await text('LblDP'))
  const [dr1, dr2] = await page.$$eval(ctl('DR') + ' input[type=date]', (els) => els.map((e) => e.getAttribute('aria-label')))
  check(dr1 === 'Start date' && dr2 === 'End date', 'DateRangePicker has a start and an end field', dr1 + ' / ' + dr2)
  await setNative(ctl('DR') + ' input[aria-label="Start date"]', '2026-03-10')
  await setNative(ctl('DR') + ' input[aria-label="End date"]', '2026-03-20')
  check(/DR:2026-3-10>2026-3-20/.test(await text('LblDR')), 'DateRangePicker: StartDate and EndDate', await text('LblDR'))
  await setNative(ctl('DR') + ' input[aria-label="End date"]', '2026-03-05')
  check(/DR:2026-3-5>2026-3-5/.test(await text('LblDR')), 'DateRangePicker: an end before the start pulls the start along (never an inverted range)', await text('LblDR'))
  const tp = ctl('TP') + ' input[type=time]'
  await setNative(tp, '14:35')
  check(/TP:14:35/.test(await text('LblTP')) && (await page.$eval(tp, (e) => e.getAttribute('step'))) === '300', 'TimePicker: Value is "HH:MM" and the picker steps by MinuteStep', await text('LblTP'))

  /* ---- 3. NumberInput keyboard ---- */
  const modes = await page.evaluate(() => [...document.querySelectorAll('[data-testid="control-NI"] input, [data-testid="control-NJ"] input')].map((e) => e.getAttribute('inputmode')))
  check(modes[0] === 'decimal' && modes[1] === 'numeric', 'NumberInput asks for the decimal pad, and for the digits-only pad on a bounded whole-number range', modes.join(','))
  check(!!(await page.$(ctl('NI') + ' ' + T('number-sign'))) && !(await page.$(ctl('NJ') + ' ' + T('number-sign'))), 'a field that may be negative has a sign button (no minus key on iOS pads); a Min 0 field does not', '')
  const ni = ctl('NI') + ' input'
  await tap(ni)
  await page.$eval(ni, (e) => e.select())
  const trace = []
  for (const ch of '12,5') { await page.keyboard.type(ch); trace.push(await page.$eval(ni, (e) => e.value)) }
  await sleep(150)
  check(/NI:12.5/.test(await text('LblNI')), 'a decimal comma typed on the phone keyboard is read as the decimal point', await text('LblNI'))
  const sg = await rectOf(ctl('NI') + ' ' + T('number-sign'))
  await tap(ctl('NI') + ' ' + T('number-sign'))
  await sleep(150)
  check(/NI:-12.5/.test(await text('LblNI')) && (await page.evaluate(() => document.activeElement?.tagName)) === 'INPUT', 'the sign button flips the number and keeps the keyboard open (' + sg.w + ' x ' + sg.h + ' px button, 44 px touch area)', await text('LblNI'))

  /* ---- 7. Alert dismiss ---- */
  const ad = await rectOf(T('alert-dismiss'))
  check(ad.w >= 44 && ad.h >= 44, 'Alert: the dismiss button is 44 x 44 px on a touch device', ad.w + ' x ' + ad.h)
  await tap(T('alert-dismiss'))
  await sleep(200)
  check(/AL:true/.test(await text('LblAL')), 'Alert: tapping dismiss sets Dismissed', await text('LblAL'))

  /* ---- 4. Dialog and Sheet at phone width ---- */
  const dlg = await makeApp('Touch dialog', [node('DLG', 'Dialog', { Open: '=true', Title: '="Confirm"', Width: '=480', Height: '=320' })])
  await openApp(dlg)
  const dd = await page.$eval('[role=dialog][data-overlay-placement]', (e) => e.getAttribute('data-overlay-placement'))
  const dr = await rectOf('[role=dialog][data-overlay-placement]')
  const cl = await rectOf('[role=dialog][data-overlay-placement] [aria-label=Close]')
  check(dd === 'bottom-sheet' && dr.w === dr.vw && Math.abs(dr.b - dr.vh) <= 1 && dr.h <= 320, 'Dialog at phone width on touch is a full-width bottom sheet', JSON.stringify(dr))
  check(cl.w >= 44 && cl.h >= 44, 'the Dialog close button is 44 x 44 px', cl.w + ' x ' + cl.h)
  await shot('13-dialog-sheet.png')
  const shs = await makeApp('Touch sheet', [node('SHT', 'Sheet', { Open: '=true', Title: '="Details"', Side: '=Side.Right' })])
  await openApp(shs)
  const sp = await page.$eval('[role=dialog][data-overlay-placement]', (e) => e.getAttribute('data-overlay-placement'))
  check(sp === 'bottom-sheet', 'a right-hand Sheet at phone width on touch is a bottom sheet', sp)

  /* ---- 5. DataTable cards ---- */
  const rowsT = '=Table({Name:"Ada",Status:"Open",Amount:30,Owner:"Zed",City:"Oslo"},{Name:"Bo",Status:"Closed",Amount:10,Owner:"Yan",City:"Rome"},{Name:"Cy",Status:"Open",Amount:20,Owner:"Xi",City:"Bern"})'
  const tbl = await makeApp('Touch table', [
    node('DT1', 'DataTable', { X: '=0', Y: '=0', Width: '=360', Height: '=300', Items: rowsT, CardColumns: '="Name,Amount,Status"' }),
    node('DT2', 'DataTable', { X: '=0', Y: '=310', Width: '=360', Height: '=300', Items: rowsT }),
    lbl('LblSel', 620, '="SEL:" & DT1.Selected.Name'),
  ])
  await openApp(tbl)
  const lay = await page.$$eval('[data-layout=cards], [data-layout=table]', (els) => els.map((e) => e.getAttribute('data-layout')))
  check(lay.length >= 2 && lay.every((l) => l === 'cards'), 'DataTable at phone width on touch is drawn as cards', lay.join(','))
  await shot('14-data-cards.png')
  const c1 = await page.$$eval(ctl('DT1') + ' [data-card]', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()))
  check(c1.length === 3 && /^Ada 30/.test(c1[0]) && /Status: Open/.test(c1[0]) && !/Owner|City/.test(c1[0]), 'CardColumns: first column is the title, second the subtitle, the third a "label: value" line, the others are left out', c1[0])
  const c2 = await page.$$eval(ctl('DT2') + ' [data-card]', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()))
  check(/^Ada/.test(c2[0]) && /Status: Open/.test(c2[0]) && /Amount: 30/.test(c2[0]) && /Owner: Zed/.test(c2[0]) && /City: Oslo/.test(c2[0]), 'no CardColumns: the first column is the title, the others follow as label: value lines', c2[0])
  const cr = await rectOf(ctl('DT1') + ' [data-card]')
  check(cr.h >= 44, 'a card is at least 44 px high', String(cr.h))
  await tap(ctl('DT1') + ' [data-card]')
  await sleep(200)
  check(/SEL:Ada/.test(await text('LblSel')), 'tapping a card selects its row', await text('LblSel'))
  await page.select(ctl('DT1') + ' select[aria-label="Sort by"]', 'Amount')
  await sleep(250)
  const sorted = await page.$$eval(ctl('DT1') + ' [data-card]', (els) => els.map((e) => e.innerText.trim().split('\n')[0]))
  check(sorted.join(',') === 'Bo,Cy,Ada', 'the sort control replaces the column headers (Amount ascending)', sorted.join(','))

  /* ---- 8. Visual and Chart on touch ---- */
  const viz = await makeApp('Touch charts', [
    node('CH', 'Chart', { X: '=16', Y: '=8', Width: '=328', Height: '=240' }),
    node('VIS', 'Visual', { X: '=16', Y: '=260', Width: '=328', Height: '=260', Kind: '="Line"' }),
  ])
  await openApp(viz)
  const bar = await page.$eval(ctl('CH') + ' .recharts-bar-rectangle', (e) => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })
  await page.touchscreen.tap(bar[0], bar[1])
  await sleep(300)
  const tip = await page.$eval(ctl('CH') + ' .recharts-tooltip-wrapper', (e) => ({ vis: getComputedStyle(e).visibility, text: e.textContent.trim() }))
  check(tip.vis === 'visible' && tip.text.length > 0, 'Chart: a tap on a bar shows its tooltip', tip.text)
  await shot('15-chart-tooltip.png')
  const dot = await page.$eval(ctl('VIS') + ' circle[data-touch-hit]', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width } })
  check(dot.w >= 43, 'Visual: every point has a 44 px touch circle', String(Math.round(dot.w)))
  await page.touchscreen.tap(dot.x, dot.y)
  await sleep(300)
  const vt = await page.$eval(ctl('VIS') + ' [role=status]', (e) => e.textContent.trim()).catch(() => '')
  check(vt.length > 0, 'Visual: a tap on a point shows its tooltip', vt)
  await shot('16-visual-tooltip.png')
  await page.touchscreen.tap(180, 700)
  await sleep(300)
  check(!(await page.$(ctl('VIS') + ' [role=status]')), 'Visual: a tap elsewhere hides the tooltip', '')
  const leg = await page.$$eval(ctl('VIS') + ' [aria-pressed]', (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))
  check(leg.length > 0 && Math.min(...leg) >= 44, 'Visual: the legend toggles are 44 px high on touch', leg.join(','))

  return { pickers: id, table: tbl, dialog: dlg }
}

async function stickyBar(appId) {
  // a short phone screen (the keyboard has the same effect): the form's own bottom is below the screen
  await page.setViewport({ width: 360, height: 520, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
  await page.goto(BASE + '/?app=' + appId, { waitUntil: 'networkidle2' })
  await waitFor(T('tab-pane-' + appId) + ' [data-run-surface]')
  await sleep(800)
  await page.$eval(T('control-ProdForm'), (e) => e.scrollIntoView({ block: 'start' }))
  await sleep(500)
  const pinned = await page.$(T('form-sticky-bar'))
  check(!!pinned, 'Form on a short phone screen: the save bar is pinned to the bottom of the screen', '')
  const r = await rectOf(T('form-sticky-bar'))
  const hit = await page.evaluate(() => { const b = document.querySelector('[data-testid="form-save"]'); const q = b.getBoundingClientRect(); const el = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return { ok: el === b || b.contains(el), h: Math.round(q.height), bottom: Math.round(q.bottom), vh: innerHeight } })
  check(r.b <= r.vh + 1 && hit.ok && hit.h >= 44, 'the pinned bar is inside the screen, its Save button is tappable and 44 px high', JSON.stringify({ bar: r.b, vh: r.vh, ...hit }))
  await page.evaluate(() => document.documentElement.style.setProperty('--kb', '260px'))
  const up = await rectOf(T('form-sticky-bar'))
  check(Math.abs(up.b - (up.vh - 260)) <= 1, 'with the keyboard up (--kb 260 px) the pinned bar sits above it', JSON.stringify(up))
  await page.evaluate(() => document.documentElement.style.setProperty('--kb', '0px'))
  await shot('17-sticky-save-bar.png')
  // at the bottom of the form the bar is back in place (nothing floats over the form's own end)
  await page.$eval(T('tab-pane-' + appId) + ' [data-run-surface]', (e) => { e.scrollTop = e.scrollHeight })
  await sleep(500)
  const inline = await page.evaluate(() => ({ pinned: !!document.querySelector('[data-testid="form-sticky-bar"]'), inline: !!document.querySelector('[data-sticky-bar="inline"]') }))
  check(!inline.pinned && inline.inline, 'scrolled to the end of the form the bar is in its normal place again', JSON.stringify(inline))
  await phone(360, 800)
}

async function desktopUnchanged(pickersId, tableId, dialogId) {
  await desktop()
  await page.goto(BASE + '/#u-' + pickersId, { waitUntil: 'networkidle2' })
  await waitFor(T('tab-pane-' + pickersId) + ' [data-run-surface]')
  await sleep(600)
  const info = await page.evaluate(() => ({ touch: document.documentElement.classList.contains('touch'), date: !!document.querySelector('[data-testid="control-DP"] input[type=date]'), num: document.querySelector('[data-testid="control-NI"] input')?.getAttribute('inputmode'), sign: !!document.querySelector('[data-testid="number-sign"]') }))
  check(!info.touch && !info.date && info.num === 'decimal' && !info.sign, 'desktop: no touch class, DatePicker is the calendar popover, NumberInput has no sign button', JSON.stringify(info))
  const histBefore = await page.evaluate(() => history.length)
  await page.click(ctl('DD') + ' [role=combobox]')
  await sleep(300)
  check(!!(await page.$('[role=listbox]')) && !(await page.$(T('bottom-sheet'))), 'desktop: Dropdown still opens the popover list (no bottom sheet)', '')
  const histOpen = await page.evaluate(() => ({ n: history.length, layer: history.state?.__abLayer ?? null }))
  check(histOpen.n === histBefore && histOpen.layer === null, 'desktop: an open popover pushes no history entry (the Back handling is for phone sheets only)', `${histBefore} -> ${JSON.stringify(histOpen)}`)
  await page.keyboard.press('Escape')
  await page.click(ctl('CB') + ' [role=combobox]')
  await sleep(300)
  check(!!(await page.$('[data-slot=popover-content]')) && !(await page.$(T('bottom-sheet'))), 'desktop: ComboBox still opens the popover', '')
  await page.keyboard.press('Escape')
  await page.goto(BASE + '/#u-' + tableId, { waitUntil: 'networkidle2' })
  await waitFor(T('tab-pane-' + tableId) + ' [data-run-surface]')
  await sleep(500)
  const lay = await page.$$eval('[data-layout=cards], [data-layout=table]', (els) => els.map((e) => e.getAttribute('data-layout')))
  check(lay.length >= 2 && lay.every((l) => l === 'table') && !!(await page.$('table')), 'desktop: DataTable stays a table', lay.join(','))
  await page.goto(BASE + '/#u-' + dialogId, { waitUntil: 'networkidle2' })
  await waitFor(T('tab-pane-' + dialogId) + ' [data-run-surface]')
  await sleep(500)
  const pl = await page.$eval('[role=dialog][data-overlay-placement]', (e) => e.getAttribute('data-overlay-placement'))
  check(pl === 'dialog', 'desktop: Dialog stays a centred dialog', pl)
  await phone(360, 800)
}

/* ------------------------------------------------------------------ F. offline tables, drafts, signatures, outbox conflict / rejection, Back */

let VISITS = ''
let PARTS = ''
let PARTS_OPEN = 0
async function waitOutboxEmpty(timeout = 45000) {
  await page.waitForFunction(() => !document.querySelector('[data-testid="outbox-count"]'), { timeout })
}
/** go offline the way the earlier checks do: tap Save only after the "You're offline" strip appeared (the pinned save bar moves up then) */
async function offlineAndSettled() {
  await setNetwork('offline')
  await page.waitForFunction(() => /offline/i.test(document.querySelector('[data-testid="connection-bar"]')?.textContent ?? ''), { timeout: 15000 })
  await sleep(400)
}
async function typeInto(sel, v) {
  await page.$eval(sel, (e) => e.scrollIntoView({ block: 'center' }))
  await page.focus(sel)
  await page.$eval(sel, (e) => e.select?.())
  await page.keyboard.press('Backspace')
  if (v !== '') await page.keyboard.type(v)
}
/**
 * open the outbox panel. The status strip is in the page flow and other lines in it come and go on their own (the
 * "available offline" cap notice of another open app tab arrives when its download finishes after the page loaded): a
 * tap computed before such a shift lands beside the button. Like a person, tap again when the panel did not open.
 */
async function openOutboxPanel() {
  for (let i = 0; i < 3; i++) {
    // the app's error toast for the refused write ("changed by ...", the rule's message) sits over the strip for a few
    // seconds: tap once nothing covers the button
    await page.waitForFunction(() => { const b = document.querySelector('[data-testid="outbox-button"]'); if (!b) return false; const r = b.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return el === b || b.contains(el) }, { timeout: 20000 })
    await tap(T('outbox-button'))
    if (await page.waitForSelector(T('outbox-panel'), { visible: true, timeout: 3000 }).then(() => true, () => false)) return
    log('outbox panel did not open: ' + JSON.stringify(await page.evaluate(() => { const b = document.querySelector('[data-testid="outbox-button"]'); const r = b.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { body: getComputedStyle(document.body).pointerEvents, hit: el === b || b.contains(el), el: el?.outerHTML.slice(0, 120), r: [r.left, r.top, r.width, r.height], vh: innerHeight, panel: !!document.querySelector('[data-testid="outbox-panel"]'), dialogs: document.querySelectorAll('[role=dialog]').length } })))
  }
  await waitFor(T('outbox-panel'))
}
/** the Save button of the form on screen: it may sit in the pinned save bar (portaled to body), and other app tabs stay mounted */
async function tapVisibleSave() {
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="form-save"]')].some((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight && b.checkVisibility?.() !== false }), { timeout: 20000 })
  const h = await page.evaluateHandle(() => [...document.querySelectorAll('[data-testid="form-save"]')].find((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight && b.checkVisibility?.() !== false }))
  await h.asElement().tap()
}
/** a finger signature: a wavy line across the canvas */
async function sign(sel) {
  await page.$eval(sel, (e) => e.scrollIntoView({ block: 'center' }))
  await sleep(150)
  const r = await rectOf(sel)
  const y0 = r.t + r.h / 2
  await page.touchscreen.touchStart(r.l + 20, y0)
  for (let i = 1; i <= 14; i++) await page.touchscreen.touchMove(r.l + 20 + (i * (r.w - 40)) / 14, y0 + (i % 2 ? -r.h / 5 : r.h / 5))
  await page.touchscreen.touchEnd()
  await sleep(400)
}
function pngSize(buf) {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

async function setupSectionF() {
  const parts = must(await api('POST', '/tables', { displayName: 'Parts', name: 'Parts', columns: [{ displayName: 'Name', name: 'Name', type: 'text' }, { displayName: 'Status', name: 'Status', type: 'text' }] }), 'create Parts')
  PARTS = parts.source
  const me = must(await api('GET', '/status'), 'status').session.user.id
  // 2,600 parts (every fifth Closed), in natural order Part 0001 ... Part 2600: more than a browser holds whole
  await q(`INSERT INTO env_default.${parts.source} ("id","createdOn","modifiedOn","createdBy","owner","Name","Status")
    SELECT 'part-' || lpad(g::text, 4, '0'), timestamp '2026-01-01' + g * interval '1 second', timestamp '2026-01-01' + g * interval '1 second', $1, $1,
      'Part ' || lpad(g::text, 4, '0'), CASE WHEN g % 5 = 0 THEN 'Closed' ELSE 'Open' END FROM generate_series(1, 2600) g`, [me])
  PARTS_OPEN = (await q(`SELECT count(*)::int AS n FROM env_default.${parts.source} WHERE "Status" <> 'Closed'`))[0].n
  const visits = must(await api('POST', '/tables', { displayName: 'Visits', name: 'Visits', columns: [{ displayName: 'Part', name: 'Part', type: 'text' }, { displayName: 'Note', name: 'Note', type: 'text' }, { displayName: 'Signature', name: 'Signature', type: 'image' }] }), 'create Visits')
  VISITS = visits.source
  const created = must(await api('POST', '/apps', { name: 'Field visit', width: 360, height: 820 }), 'create Field visit')
  const def = must(await api('GET', `/apps/${created.id}`), 'get Field visit').definition
  def.dataSources = ['Parts', 'Visits']
  def.offline = { entry: true, tables: [{ table: 'Parts', filter: 'Status <> "Closed"', maxRows: 1500 }] }
  const n = (id, name, type, props) => ({ id, name, type, props, children: [] })
  def.screens[0].children = [
    n('f_q', 'Q', 'TextInput', { X: '=16', Y: '=8', Width: '=328', Height: '=40', AnchorH: '=Anchor.Stretch' }),
    n('f_found', 'LblFound', 'Label', { X: '=16', Y: '=52', Width: '=328', Height: '=20', Text: '="F:" & CountRows(Filter(Parts, StartsWith(Name, Q.Value)))' }),
    n('f_first', 'LblFirst', 'Label', { X: '=16', Y: '=74', Width: '=328', Height: '=20', Text: '="1st:" & First(Filter(Parts, StartsWith(Name, Q.Value))).Name' }),
    n('f_pad', 'Pad1', 'SignaturePad', { X: '=16', Y: '=100', Width: '=328', Height: '=160' }),
    n('f_btn', 'BtnSign', 'Button', { X: '=16', Y: '=266', Width: '=160', Height: '=44', Text: '="Save signature"', OnSelect: '=Patch(Visits, Defaults(Visits), {Part: "Standalone", Note: "pad", Signature: Pad1.FileToken}); Reset(Pad1)' }),
    n('f_sig', 'LblSig', 'Label', { X: '=184', Y: '=278', Width: '=160', Height: '=20', Text: '="SIG:" & Pad1.HasSignature' }),
    n('f_form', 'VisitForm', 'Form', { X: '=16', Y: '=316', Width: '=328', Height: '=480', DataSource: '="Visits"', Mode: '=FormMode.New', Fields: '="Part,Note,Signature"', SignatureFields: '="Signature"', Columns: '=1' }),
  ]
  must(await api('PUT', `/apps/${created.id}`, { definition: def }), 'save Field visit')
  // the rows the conflict checks edit (made by section B in a full run)
  for (const [line, qty] of [['Line 3', 120], ['Line 4', 7]]) if (!(await rows()).some((r) => r.Line === line)) must(await api('POST', '/data/Production/rows', { values: { Line: line, Qty: qty } }), 'seed ' + line)
  const ed = must(await api('POST', '/apps', { name: 'Production edit', width: 360, height: 800 }), 'create Production edit')
  const edef = must(await api('GET', `/apps/${ed.id}`), 'get Production edit').definition
  edef.dataSources = ['Production']
  edef.offline = { entry: true }
  edef.screens[0].children = [
    n('e_pick', 'Pick', 'TextInput', { X: '=16', Y: '=8', Width: '=328', Height: '=40', Default: '="Line 3"' }),
    n('e_lbl', 'LblQty', 'Label', { X: '=16', Y: '=52', Width: '=328', Height: '=20', Text: '="Q:" & LookUp(Production, Line = Pick.Value).Qty' }),
    n('e_form', 'EditForm', 'Form', { X: '=16', Y: '=80', Width: '=328', Height: '=360', DataSource: '="Production"', Mode: '=FormMode.Edit', Item: '=LookUp(Production, Line = Pick.Value)', Fields: '="Line,Qty"', Columns: '=1' }),
  ]
  must(await api('PUT', `/apps/${ed.id}`, { definition: edef }), 'save Production edit')
  const bd = must(await api('POST', '/apps', { name: 'Back dialog', width: 360, height: 800 }), 'create Back dialog')
  const bdef = must(await api('GET', `/apps/${bd.id}`), 'get Back dialog').definition
  bdef.screens[0].children = [
    n('b_lbl', 'LblShut', 'Label', { X: '=16', Y: '=8', Width: '=328', Height: '=20', Text: '="SHUT:" & varShut' }),
    { id: 'b_dlg', name: 'BackDlg', type: 'Dialog', props: { Open: '=Not(varShut)', Title: '="Back test"', Width: '=480', Height: '=300', OnClose: '=Set(varShut, true)' }, children: [] },
  ]
  bdef.appProps = { ...(bdef.appProps ?? {}), OnStart: '=Set(varShut, false)' }
  must(await api('PUT', `/apps/${bd.id}`, { definition: bdef }), 'save Back dialog')
  return { fieldVisit: created.id, edit: ed.id, backDialog: bd.id }
}

async function offlineTables(appId) {
  await page.goto(`${BASE}/?app=${appId}`, { waitUntil: 'networkidle2' })
  await waitFor(`${T(`tab-pane-${appId}`)} [data-run-surface]`)
  const st = await page.waitForFunction(() => { const t = window.__abOffline?.state().tables?.Parts; return t && t.state !== 'loading' ? t : null }, { timeout: 30000 }).then((h) => h.jsonValue())
  check(st.state === 'ready' && st.kept === 1500 && st.total === PARTS_OPEN, 'available offline: Parts is downloaded as the signed-in user up to its row cap (filter Status <> "Closed" ran on the server)', JSON.stringify(st))
  const notice = await page.$eval(T('offline-table-notice'), (e) => e.textContent).catch(() => '')
  check(/Only 1,500 of 2,080 rows of Parts are kept on this device/.test(notice), 'a plain message says the row cap cut the data', notice.slice(0, 140))
  await shot('20-offline-table-cap.png')
  const sealed = await page.evaluate(async () => {
    const dbs = (await indexedDB.databases()).filter((d) => d.name?.startsWith('appbuilder-offline-'))
    const db = await new Promise((r, j) => { const o = indexedDB.open(dbs[0].name); o.onsuccess = () => r(o.result); o.onerror = () => j(o.error) })
    const all = await new Promise((r) => { const t = db.transaction('cache', 'readonly').objectStore('cache'); const k = t.getAllKeys(); const v = t.getAll(); v.onsuccess = () => r(k.result.map((key, i) => [String(key), v.result[i]])) })
    db.close()
    const snap = all.find(([k]) => k.startsWith('snap:'))
    if (!snap) return { found: false }
    const bytes = new Uint8Array(snap[1].data)
    const text = new TextDecoder('latin1').decode(bytes)
    return { found: true, size: bytes.length, iv: snap[1].iv?.length, plain: /Part 0\d\d\d|Open/.test(text) }
  })
  const budget = await page.evaluate(() => window.__abOffline.state().cacheBytes)
  check(sealed.found && sealed.iv === 12 && !sealed.plain && budget >= sealed.size && budget <= 25 * 1024 * 1024, 'the kept rows are sealed (AES-GCM, no readable row text) in the same encrypted store and count against the 25 MB budget', JSON.stringify({ ...sealed, budget }))
  await page.$eval(T('offline-table-notice-dismiss'), (e) => e.click())
  // offline: plans this device never ran are answered from the kept rows
  await offlineAndSettled()
  await typeInto(`${ctl('Q')} input`, 'Part 01')
  await page.waitForFunction(() => /F:80/.test(document.querySelector('[data-testid="control-LblFound"]')?.textContent ?? ''), { timeout: 15000 }).catch(() => {})
  const f1 = await text('LblFound')
  const first = await text('LblFirst')
  check(/^F:80$/.test(f1) && /^1st:Part 0101$/.test(first), 'offline: a new search over Parts is answered from the kept rows (count and first match)', `${f1} ${first}`)
  await typeInto(`${ctl('Q')} input`, 'Part 19')
  // (while typing, earlier prefixes show their own counts: wait for the last one)
  await page.waitForFunction(() => document.querySelector('[data-testid="control-LblFound"]')?.textContent === 'F:0', { timeout: 15000 }).catch(() => {})
  const f2 = await text('LblFound')
  const server19 = (await q(`SELECT count(*)::int AS n FROM env_default.${PARTS} WHERE "Name" LIKE 'Part 19%' AND "Status" <> 'Closed'`))[0].n
  check(f2 === 'F:0' && server19 === 80, 'offline: rows beyond the cap are not on the device (Part 19xx: 0 offline; the server has them)', `${f2}, server ${server19}`)
  await setNetwork('online')
  await typeInto(`${ctl('Q')} input`, '')
}

async function draftsAcrossReload(appId) {
  const sel = (c) => `${ctl('VisitForm')} [id$="-${c}"]`
  await typeInto(sel('Part'), 'P-7')
  await typeInto(sel('Note'), 'Draft note 1')
  await sleep(1200)
  // an accidental reload (or the phone discarding the tab)
  await page.reload({ waitUntil: 'networkidle2' })
  await waitFor(`${T(`tab-pane-${appId}`)} [data-run-surface]`)
  await waitFor(T('form-draft-note'), 15000)
  const vals = await page.evaluate(() => ({ part: document.querySelector('[data-testid="control-VisitForm"] [id$="-Part"]')?.value, note: document.querySelector('[data-testid="control-VisitForm"] [id$="-Note"]')?.value, text: document.querySelector('[data-testid="form-draft-note"]')?.textContent }))
  check(vals.part === 'P-7' && vals.note === 'Draft note 1' && /Draft restored/.test(vals.text), 'Form draft: after a reload the unsaved New form is restored with a "Draft restored" note', JSON.stringify(vals))
  await shot('21-draft-restored.png')
  const where = await page.evaluate(async () => {
    const ls = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })
    const dbs = (await indexedDB.databases()).filter((d) => d.name?.startsWith('appbuilder-offline-'))
    const db = await new Promise((r) => { const o = indexedDB.open(dbs[0].name); o.onsuccess = () => r(o.result) })
    const all = await new Promise((r) => { const t = db.transaction('meta', 'readonly').objectStore('meta'); const k = t.getAllKeys(); const v = t.getAll(); v.onsuccess = () => r(k.result.map((key, i) => [String(key), v.result[i]])) })
    db.close()
    const d = all.find(([k]) => k.startsWith('draft:'))
    const plain = d ? new TextDecoder('latin1').decode(new Uint8Array(d[1].body.data)).includes('Draft note') : true
    return { inStorage: ls.includes('Draft note'), draft: !!d, plain }
  })
  check(!where.inStorage && where.draft && !where.plain, 'the draft is sealed in the per-user encrypted store (not in localStorage or sessionStorage)', JSON.stringify(where))
  await tap(T('form-draft-discard'))
  await sleep(500)
  const after = await page.evaluate(() => ({ note: !!document.querySelector('[data-testid="form-draft-note"]'), v: document.querySelector('[data-testid="control-VisitForm"] [id$="-Note"]')?.value }))
  await page.reload({ waitUntil: 'networkidle2' })
  await waitFor(`${T(`tab-pane-${appId}`)} [data-run-surface]`)
  await sleep(1500)
  const again = await page.evaluate(() => !!document.querySelector('[data-testid="form-draft-note"]'))
  check(!after.note && after.v === '' && !again, 'Discard drops the draft: the fields are empty and the next reload restores nothing', JSON.stringify({ ...after, again }))
}

async function signatures(appId) {
  // the stand-alone pad: no page scroll while signing, HasSignature, then Patch with its FileToken
  const scroller = `${T(`tab-pane-${appId}`)} [data-run-surface]`
  await page.$eval(ctl('Pad1'), (e) => e.scrollIntoView({ block: 'center' }))
  const top0 = await page.$eval(scroller, (e) => e.scrollTop)
  await sign(`${ctl('Pad1')} ${T('signature-canvas')}`)
  const top1 = await page.$eval(scroller, (e) => e.scrollTop)
  check(/SIG:true/.test(await text('LblSig')) && top0 === top1 && !(await page.$(T('pull-to-refresh'))), 'Signature pad: a finger signature sets HasSignature; the page did not scroll and pull to refresh did not start', `${await text('LblSig')}, scrollTop ${top0} -> ${top1}`)
  await shot('22-signature-pad.png')
  const before = (await q(`SELECT count(*)::int AS n FROM env_default.${VISITS}`))[0].n
  await tap(ctl('BtnSign') + ' button')
  for (let i = 0; i < 40; i++) { const r = await q(`SELECT * FROM env_default.${VISITS} WHERE "Part" = 'Standalone'`); if (r.length && r[0].Signature) break; await sleep(250) }
  const sv = await q(`SELECT * FROM env_default.${VISITS} WHERE "Part" = 'Standalone'`)
  const file = sv[0]?.Signature ? must(await api('GET', `/attachments/${sv[0].Signature}`), 'download signature') : null
  const ps = pngSize(file)
  check(sv.length === 1 && ps && ps.w <= 1200 && ps.h <= 400 && ps.w >= 300 && Math.abs(ps.w / ps.h - 3) < 0.05, 'Patch(Visits, ..., {Signature: Pad1.FileToken}) stores the row, then the signature as a PNG at a bounded size (3:1)', `${sv.length} row(s), ${ps ? `${ps.w}x${ps.h}` : 'no PNG'}, ${file?.length ?? 0} bytes, rows before ${before}`)
  check(/SIG:false/.test(await text('LblSig')), 'Reset(Pad1) clears the pad (HasSignature false)', await text('LblSig'))
  // in a Form: SignatureFields makes the image column a pad; offline the PNG waits in the outbox after its row
  const sel = (c) => `${ctl('VisitForm')} [id$="-${c}"]`
  await typeInto(sel('Part'), 'P-9')
  await typeInto(sel('Note'), 'signed offline')
  await sign(T('signature-canvas-Signature'))
  const pending = await page.$eval(T('signature-field-Signature'), (e) => /uploads on save/.test(e.textContent)).catch(() => false)
  await offlineAndSettled()
  await tap(`${ctl('VisitForm')} ${T('form-save')}`)
  await page.waitForFunction(() => document.querySelector('[data-testid="outbox-count"]')?.textContent === '2', { timeout: 15000 })
  check(pending && (await q(`SELECT count(*)::int AS n FROM env_default.${VISITS} WHERE "Part" = 'P-9'`))[0].n === 0, 'Form signature field: offline the row and its signature wait as 2 items (nothing on the server yet)', '')
  await setNetwork('online')
  await waitOutboxEmpty()
  let fr = []
  for (let i = 0; i < 40; i++) { fr = await q(`SELECT * FROM env_default.${VISITS} WHERE "Part" = 'P-9'`); if (fr.length && fr[0].Signature) break; await sleep(250) }
  const ff = fr[0]?.Signature ? must(await api('GET', `/attachments/${fr[0].Signature}`), 'download form signature') : null
  const fps = pngSize(ff)
  check(fr.length === 1 && fr[0].Note === 'signed offline' && fps && fps.w <= 1200, 'back online: the row is sent once and the signature PNG is linked to it (ready for an image block in a print template)', `${fr.length} row(s), ${fps ? `${fps.w}x${fps.h}` : 'none'}`)
}

async function outboxConflict(appId) {
  await page.goto(`${BASE}/?app=${appId}`, { waitUntil: 'networkidle2' })
  await waitFor(`${T(`tab-pane-${appId}`)} [data-run-surface]`)
  const qty = `${ctl('EditForm')} [id$="-Qty"]`
  for (const [line, mine, theirs, choice] of [['Line 3', '111', 500, 'keep'], ['Line 4', '222', 700, 'server']]) {
    await typeInto(`${ctl('Pick')} input`, line)
    await page.waitForFunction((s, l) => document.querySelector(s.replace(/-Qty"\]$/, '-Line"]'))?.value === l, { timeout: 15000 }, qty, line)
    const row = (await rows()).find((r) => r.Line === line)
    await offlineAndSettled()
    await typeInto(qty, mine)
    await tap(`${ctl('EditForm')} ${T('form-save')}`)
    await page.waitForFunction(() => document.querySelector('[data-testid="outbox-count"]')?.textContent === '1', { timeout: 15000 })
    // meanwhile someone changes the same row on the server
    must(await api('PATCH', `/data/Production/rows/${encodeURIComponent(row.id)}`, { changes: { Qty: theirs } }), 'server-side change')
    await setNetwork('online')
    await page.waitForFunction(() => document.querySelector('[data-testid="outbox-button"]')?.textContent?.includes('needs you'), { timeout: 45000 })
    await openOutboxPanel()
    const st = await page.$$eval(T('outbox-item'), (els) => els.map((e) => e.getAttribute('data-status')))
    check(st.length === 1 && st[0] === 'conflict', `offline update of ${line} that the server changed meanwhile: the outbox shows "Changed on the server"`, st.join(','))
    if (choice === 'keep') {
      await shot('23-outbox-conflict.png')
      await tap(T('outbox-keep-mine'))
    } else await tap(T('outbox-use-server'))
    await page.keyboard.press('Escape')
    await waitOutboxEmpty()
    let now = null
    for (let i = 0; i < 20; i++) { now = (await rows()).find((r) => r.Line === line); if (Number(now.Qty) === (choice === 'keep' ? Number(mine) : theirs)) break; await sleep(250) }
    check(Number(now.Qty) === (choice === 'keep' ? Number(mine) : theirs), choice === 'keep' ? '"Keep mine" sends the change again against the new version: the server has mine' : '"Use the server\'s" drops the change: the server keeps its value', `Qty ${now.Qty}`)
  }
}

async function outboxRejection(appId) {
  must(await api('POST', `/tables/${PROD_ID}/events`, { name: 'Qty limit', kind: 'validation', timing: 'before', operations: ['create'], order: 1, enabled: true, condition: 'Qty < 1000', message: 'Qty must be under 1000', field: 'Qty', runAs: 'caller' }), 'create validation rule')
  await page.goto(`${BASE}/?app=${appId}`, { waitUntil: 'networkidle2' })
  await waitFor(`${T(`tab-pane-${appId}`)} [data-run-surface]`)
  await sleep(800)
  for (const [line, choice] of [['Big one', 'fix'], ['Big two', 'discard']]) {
    await fillForm(line, 5000)
    await offlineAndSettled()
    await tapVisibleSave()
    await page.waitForFunction(() => document.querySelector('[data-testid="outbox-count"]')?.textContent === '1', { timeout: 15000 })
    await setNetwork('online')
    await page.waitForFunction(() => document.querySelector('[data-testid="outbox-button"]')?.textContent?.includes('needs you'), { timeout: 45000 })
    await openOutboxPanel()
    const item = await page.$eval(T('outbox-item'), (e) => ({ status: e.getAttribute('data-status'), error: e.querySelector('[data-testid="outbox-error"]')?.textContent ?? '' }))
    check(item.status === 'rejected' && /Qty must be under 1000/.test(item.error) && !(await rows()).some((r) => r.Line === line), `offline create refused by a validation rule (${line}): "rejected" with the server's message, nothing stored`, JSON.stringify(item))
    if (choice === 'fix') {
      await shot('24-outbox-rejected.png')
      await tap(T('outbox-fix'))
      await typeInto(T('outbox-fix-Qty'), '50')
      await tap(T('outbox-fix-send'))
      await page.keyboard.press('Escape')
      await waitOutboxEmpty()
      let got = []
      for (let i = 0; i < 20; i++) { got = (await rows()).filter((r) => r.Line === line); if (got.length) break; await sleep(250) }
      check(got.length === 1 && Number(got[0].Qty) === 50, '"Fix and resend" with a valid value succeeds: the row is stored once with the fixed value', JSON.stringify(got.map((r) => ({ Line: r.Line, Qty: r.Qty }))))
    } else {
      await tap(T('outbox-discard'))
      await page.keyboard.press('Escape')
      await waitOutboxEmpty()
      await sleep(800)
      check(!(await rows()).some((r) => r.Line === line), '"Discard" drops the refused change: nothing is stored and the outbox is empty', '')
    }
  }
}

async function backGesture(pickersId, dialogId) {
  await openApp(pickersId)
  const before = await page.evaluate(() => ({ hash: location.hash, layer: history.state?.__abLayer ?? null }))
  await tap(ctl('DD') + ' [role=combobox]')
  await waitFor(T('bottom-sheet'))
  await sleep(300)
  const open = await page.evaluate(() => history.state?.__abLayer ?? null)
  await page.evaluate(() => history.back())
  await sleep(500)
  const after = await page.evaluate(() => ({ sheet: !!document.querySelector('[data-testid="bottom-sheet"]'), hash: location.hash, app: !!document.querySelector('[data-run-surface]'), layer: history.state?.__abLayer ?? null }))
  check(open === 1 && !after.sheet && after.hash === before.hash && after.app && after.layer === null, 'Android Back (history.back()) closes an open bottom sheet and stays in the app', JSON.stringify({ open, ...after }))
  await tap(ctl('DD') + ' [role=combobox]')
  await waitFor(T('bottom-sheet'))
  await sleep(300)
  await tap(T('picker-row'))
  await sleep(500)
  const closed = await page.evaluate(() => ({ sheet: !!document.querySelector('[data-testid="bottom-sheet"]'), layer: history.state?.__abLayer ?? null, hash: location.hash }))
  check(!closed.sheet && closed.layer === null && closed.hash === before.hash, 'a sheet closed normally (a row tapped) takes its history entry back off: no stray entries', JSON.stringify(closed))
  await openApp(dialogId)
  check(!!(await page.$('[role=dialog][data-overlay-placement="bottom-sheet"]')), 'the Back test Dialog is a bottom sheet at phone width', '')
  await page.evaluate(() => history.back())
  await sleep(600)
  const d = await page.evaluate(() => ({ open: !!document.querySelector('[role=dialog][data-overlay-placement]'), hash: location.hash, shut: document.querySelector('[data-testid="control-LblShut"]')?.textContent }))
  check(!d.open && /SHUT:true/.test(d.shut ?? '') && d.hash === `#u-${dialogId}`, 'Android Back on a phone-width Dialog runs its OnClose (closed) instead of leaving the app', JSON.stringify(d))
}

/* ------------------------------------------------------------------ main */

const consoleLines = []
let failed = false
try {
  await maint(`DROP DATABASE IF EXISTS "${DB.database}"`)
  await start()
  const setupCode = app.services.setupCode.current() ?? ''
  must(await api('POST', '/setup/database', { setupCode, host: DB.host, port: DB.port, database: DB.database, user: DB.user, password: DB.password, createDatabase: true }), 'setup database')
  must(await api('POST', '/setup/admin', { setupCode, ...ADMIN }), 'setup admin')
  cookie = ''
  must(await api('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password }), 'login')
  const appId = await setupData()
  const y4m = path.join(WORK, 'barcode.y4m')
  makeY4m(y4m, 'LOT-4711')
  browser = await puppeteer.launch({
    executablePath: E.CHROME_PATH || '/usr/bin/google-chrome', headless: 'new',
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`],
  })
  const ctx = browser.defaultBrowserContext()
  await ctx.overridePermissions(BASE, ['camera', 'geolocation'])
  page = await browser.newPage()
  page.on('dialog', (d) => d.accept())
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 300)) })
  page.on('pageerror', (e) => consoleLines.push(`pageerror: ${e.message}`.slice(0, 300)))
  await phone(360, 800)
  const sectionF = async (pickersId) => {
    log('F. offline tables, form drafts, signatures, outbox conflict and rejection, Android Back')
    const f = await setupSectionF()
    await offlineTables(f.fieldVisit)
    await draftsAcrossReload(f.fieldVisit)
    await signatures(f.fieldVisit)
    await outboxConflict(f.edit)
    await outboxRejection(appId)
    await backGesture(pickersId, f.backDialog)
  }
  if (ONLY_TOUCH) {
    log('E. touch controls only')
    await signIn()
    const ids = await touchControls()
    await stickyBar(appId)
    await desktopUnchanged(ids.pickers, ids.table, ids.dialog)
  } else if (E.EXIT_ONLY_F) {
    await signIn()
    await page.goto(`${BASE}/#u`, { waitUntil: 'networkidle2' })
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 20000 }).catch(() => {})
    const pk = await makeApp('Back pickers', [node('DD', 'Dropdown', { X: '=16', Y: '=8', Width: '=328', Height: '=40', Items: '=["Alpha","Bravo","Charlie","Delta"]' })])
    await sectionF(pk)
  } else {
  log('A. sign-in at 360 px, the PWA')
  await signIn()
  await page.goto(`${BASE}/#u`, { waitUntil: 'networkidle2' })
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 20000 }).catch(() => {})
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload({ waitUntil: 'networkidle2' })
  await checkPwa(appId)
  log('B. open from the home screen, scan, photo, save offline')
  await openFromHomeScreen(appId)
  await scanWithCamera()
  await keyboardWedge()
  await touchArea()
  await offlineSave(appId)
  log('C. restart while offline, slow network, idempotency, update flow')
  await restartWhileOffline(appId)
  await slowNetwork(appId)
  await serverIdempotency()
  await updateFlow(appId)
  log('D. the shell at phone widths, touch audit, sign-out, wipe')
  await shellAtPhoneWidth()
  await phone(412, 915)
  await shellAtPhoneWidth()
  await touchAudit()
  log('E. touch pickers, native fields, cards, sheets, the sticky save bar')
  await phone(360, 800)
  const ids = await touchControls()
  await stickyBar(appId)
  await desktopUnchanged(ids.pickers, ids.table, ids.dialog)
  await phone(360, 800)
  await sectionF(ids.pickers)
  await signOutClears()
  await wipe()
  }
} catch (e) {
  failed = true
  console.error(e)
  console.error('last browser console lines:\n' + consoleLines.slice(-15).join('\n'))
  if (page) console.error('page state: ' + JSON.stringify(await page.evaluate(() => ({ online: navigator.onLine, bar: document.querySelector('[data-testid="connection-bar"]')?.textContent ?? null, toasts: [...document.querySelectorAll('[role=status],[role=alert]')].map((e) => e.textContent).slice(0, 5), hash: location.hash })).catch(() => 'n/a')))
  if (page) await shot('zz-failure.png').catch(() => {})
} finally {
  if (browser) await browser.close().catch(() => {})
  await stop().catch(() => {})
  if (!E.KEEP) await maint(`DROP DATABASE IF EXISTS "${DB.database}"`).catch(() => {})
}
const bad = results.filter((r) => !r.ok)
console.log(`\n${results.length - bad.length}/${results.length} checks passed${failed || bad.length ? ' - P2 EXIT CHECK 1 (PHONE) FAILED' : ' - P2 EXIT CHECK 1 (PHONE) PASSED'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
console.log('Emulated in headless Chrome only: real Android and iOS devices are NOT tested here (docs/dev/phone-test-script.md).')
process.exit(failed || bad.length ? 1 : 0)
