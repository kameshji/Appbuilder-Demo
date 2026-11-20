#!/usr/bin/env node
/**
 * Phase 2 exit check 2 (docs/plan/p2-spec.md): "A manager receives a daily OEE PDF by email, generated from a print
 * template, and can print an inspection report from a record." DEVELOPER TOOL (sandbox values only), not part of the
 * product. Re-runnable.
 *
 *   npm run build   (the server serves dist/)
 *   node scripts/exit-check/p2-pdf.mjs
 *
 * Against a server started in this process on an EMPTY database (created and dropped here) and a fake SMTP server:
 *  A. The pilot's tables and sample data (inspections with defects and photos, today's production log), the letterhead,
 *     the built-in "Daily production and OEE summary" and "Inspection report" templates.
 *  B. The daily OEE PDF: a flow with a schedule trigger (07:30 India time) generates it with document.generate and emails
 *     it to the manager; the schedule's slot is run now (Admin console > Jobs and schedules > Run now). The manager's
 *     email arrives through SMTP with "OEE <date>.pdf" attached: a real PDF with the OEE summary (text checked with
 *     pdftotext when installed). Also a scheduled report with the same template attached (as the recipient).
 *  C. In a headless browser: Dev mode > Print templates > New template, built by clicking (a heading with a field from
 *     the field picker, a related list, a defects table with totals, a QR code), the server PDF preview, Publish.
 *  D. Printing a record from an app: a Print button UI component (Template, Record = LookUp(...)) opens the PDF in a new
 *     tab; a button with Print(...) does the same; a button Patch(..., {Report: GeneratePdf(...)}) stores it in the
 *     record's file column. The record timeline's "Document" action (API) stores it in Documents.
 *
 * Settings: EXIT_DB_HOST (127.0.0.1), EXIT_DB_PORT (5433), EXIT_DB_USER (abdev), EXIT_DB_PASSWORD (abdev-sandbox-only),
 * EXIT_DB_NAME (appbuilder_exit_pdf), EXIT_MAINT_DB (appbuilder_test), EXIT_PORT (5263), PUPPETEER_CORE
 * (/tmp/pgcheck/node_modules/puppeteer-core), CHROME_PATH (/usr/bin/google-chrome), SHOTS (a folder for screenshots and
 * the received PDFs), KEEP=1 keeps the database. Prints PASS/FAIL lines and a summary; exit code 1 when a check fails.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const DB = { host: E.EXIT_DB_HOST || '127.0.0.1', port: Number(E.EXIT_DB_PORT || 5433), user: E.EXIT_DB_USER || 'abdev', password: E.EXIT_DB_PASSWORD || 'abdev-sandbox-only', database: E.EXIT_DB_NAME || 'appbuilder_exit_pdf' }
const MAINT = E.EXIT_MAINT_DB || 'appbuilder_test'
const PORT = Number(E.EXIT_PORT || 5263)
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = E.SHOTS || ''
const ADMIN = { name: 'Exit Admin', email: 'exit@example.test', password: 'Exit-Example-Pass-2026' }
if (!/^appbuilder_exit/.test(DB.database)) { console.error('The exit-check database name must start with appbuilder_exit (it is dropped).'); process.exit(2) }
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) { console.error('Build the app first (npm run build).'); process.exit(2) }

const imp = (p) => import(pathToFileURL(path.join(root, p)).href)
const { createApp } = await imp('server/core/app.ts')
const { serveStatic } = await imp('server/core/static.ts')
const { setQuiet } = await imp('server/core/util.ts').catch(() => ({ setQuiet: null }))
const { startFakeSmtp } = await imp('server/core/identity/fake-smtp.ts')
const { Client } = await imp('server/core/kernel-testkit.ts')
const { createPilot } = await imp('server/core/print/print-testkit.ts')
const { default: puppeteer } = await import(pathToFileURL(path.join(E.PUPPETEER_CORE || '/tmp/pgcheck/node_modules/puppeteer-core', 'lib/puppeteer/puppeteer-core.js')).href)
if (setQuiet) setQuiet(true)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`)
const results = []
const record = (name, ok, evidence = '') => { results.push({ name, ok, evidence }); log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence ? `: ${evidence}` : ''}`) }
const check = (cond, name, evidence) => { record(name, !!cond, evidence); if (!cond) throw new Error(`check failed: ${name} ${evidence ?? ''}`) }
const hasPdftotext = spawnSync('pdftotext', ['-v']).status === 0
function pdfText(bytes) {
  if (!hasPdftotext) return null
  const f = path.join(os.tmpdir(), `exit-pdf-${process.pid}-${Date.now()}.pdf`)
  fs.writeFileSync(f, bytes)
  try { return execFileSync('pdftotext', ['-layout', f, '-']).toString('utf8') } finally { fs.rmSync(f, { force: true }) }
}
const keep = (name, bytes) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, name), bytes) } }

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

/* ------------------------------------------------------------------ server, SMTP, API */

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-exit-pdf-'))
let app = null
let server = null
let smtp = null
async function start() {
  app = await createApp({ env: { APPBUILDER_MIGRATION_BACKUP: 'skip' }, config: { workspaceDir: DIR }, printSetupCode: false, jobs: true })
  server = http.createServer((req, res) => { app.handle(req, res).then((h) => { if (!h) serveStatic(app.config.distDir ?? path.join(root, 'dist'), req, res) }, () => { if (!res.headersSent) res.writeHead(500); res.end() }) })
  server.on('upgrade', (req, socket, head) => { if (!app.handleUpgrade(req, socket, head)) socket.destroy() })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
}
async function stop() {
  if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(() => r())) }
  if (app) await app.close()
}
const admin = new Client(BASE)
async function api(method, p, body) {
  const r = await admin.req(method, p, body)
  if (r.status !== 200) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`)
  return r.data
}
async function getBytes(p) {
  const res = await fetch(`${BASE}/api/v1${p}`, { headers: { 'X-Appbuilder': '1', Cookie: admin.cookie } })
  return { status: res.status, type: res.headers.get('content-type'), bytes: Buffer.from(await res.arrayBuffer()) }
}
async function waitMail(pred, what, ms = 60_000) {
  const end = Date.now() + ms
  for (;;) {
    const m = smtp.inbox.find(pred)
    if (m) return m
    if (Date.now() > end) throw new Error(`no email: ${what}; inbox: ${smtp.inbox.map((x) => `${x.to}:${x.subject}`).join(', ')}`)
    await sleep(250)
  }
}

/* ------------------------------------------------------------------ browser */

let browser = null
let page = null
const T = (id) => `[data-testid="${id}"]`
async function shot(name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }) } }
async function waitFor(sel, timeout = 20000) { return page.waitForSelector(sel, { visible: true, timeout }) }
async function click(sel) { await page.waitForSelector(`${sel}:not([disabled])`, { visible: true, timeout: 20000 }); await (await waitFor(sel)).click() }
async function typeInto(sel, text, { clear = true } = {}) {
  const el = await waitFor(sel)
  await el.click()
  if (clear) { await el.evaluate((e) => { if (typeof e.select === 'function') e.select() }); await page.keyboard.press('Backspace') }
  await page.type(sel, text)
}
async function select(sel, value) { await waitFor(sel); await page.select(sel, value); await sleep(200) }

async function designByClicking() {
  await page.goto(`${BASE}/#printtemplates`, { waitUntil: 'domcontentloaded' })
  await waitFor(T('print-templates-page'))
  await shot('print-templates-list.png')
  await click(T('print-new-button'))
  await typeInto(T('print-new-name'), 'Inspection (designed)')
  await select(T('print-new-kind'), 'record')
  await select(T('print-new-table'), 'Inspections')
  await click(T('print-new-create'))
  await waitFor(T('print-designer'))
  record('Print templates > New template opens the designer', true)
  // the title: "Inspection " and the Number field from the field picker
  await click('[data-testid^="canvas-block-title"]')
  await typeInto(T('prop-text'), 'Inspection ')
  await click(T('field-Number'))
  await page.waitForFunction(() => document.querySelector('[data-testid="prop-text"]')?.value === 'Inspection {Number}', { timeout: 10000 })
  record('the field picker inserts {Number} into the heading', true)
  // a related list: Defects of InspectionDefects by the lookup Inspection
  await click(T('print-tab-source'))
  await click(T('related-add'))
  await typeInto(T('related-name-0'), 'Defects')
  await select(T('related-table-0'), 'InspectionDefects')
  await select(T('related-column-0'), 'Inspection')
  // a table of the defects with a total, and a QR code
  await click(T('palette-table'))
  await waitFor(T('block-panel-table'))
  await typeInto(T('prop-rows'), 'Related.Defects')
  const cols = await page.$$(T('prop-col-value'))
  for (const [i, v] of [[0, 'ThisItem.Defect'], [1, 'ThisItem.Qty']]) {
    await cols[i].click()
    await cols[i].evaluate((e) => e.select())
    await page.keyboard.press('Backspace')
    await page.keyboard.type(v)
  }
  await click(T('palette-barcode'))
  await waitFor(T('block-panel-barcode'))
  await click(T('print-save'))
  await sleep(800)
  await shot('print-designer.png')
  // the real preview: the server's PDF of the draft for the sample record
  await select(T('print-sample-record'), await page.$eval(T('print-sample-record'), (s) => [...s.options].find((o) => o.textContent === 'INSP-2026-0042')?.value ?? s.value))
  await click(T('print-preview-button'))
  await waitFor(T('print-preview-pages'), 30000)
  const pages = Number(await page.$eval(T('print-preview-pages'), (e) => e.textContent))
  const warnings = await page.$(T('print-preview-warnings'))
  check(pages === 1 && !warnings, 'Preview PDF: the server renders the draft (1 page, no warnings)', `${pages} page(s)`)
  await sleep(500)
  await shot('print-preview.png')
  await click(T('print-publish'))
  await sleep(1200)
  const t = (await api('GET', '/print/templates')).items.find((x) => x.name === 'Inspection (designed)')
  check(t && t.version === 1 && t.status === 'published', 'Publish: version 1', JSON.stringify({ version: t?.version }))
  const doc = (await api('GET', `/print/templates/${t.id}`)).template.published
  const tbl = doc.body.find((b) => b.kind === 'table')
  check(doc.source.related[0].table === 'InspectionDefects' && doc.source.related[0].column === 'Inspection' && tbl?.rows === 'Related.Defects' && tbl.columns.map((c) => c.value).join() === 'ThisItem.Defect,ThisItem.Qty' && doc.body.some((b) => b.kind === 'barcode'), 'the clicks produced the template (related list, defects table with a total, QR code)', JSON.stringify(tbl?.columns.map((c) => c.value)))
  return t
}

async function printFromApp(templateName, inspectionId) {
  const created = await api('POST', '/apps', { name: 'Quality', width: 1280, height: 800 })
  const full = await api('GET', `/apps/${created.id}`)
  const def = full.definition
  def.dataSources = ['Inspections']
  const rec = 'LookUp(Inspections, Number = "INSP-2026-0042")'
  def.screens[0].children.push(
    { id: 'n_pb', name: 'PrintInspection', type: 'PrintButton', props: { X: '=40', Y: '=40', Width: '=200', Height: '=44', Text: '="Print inspection"', Template: `="${templateName}"`, Record: `=${rec}` }, children: [] },
    { id: 'n_b1', name: 'PrintFx', type: 'Button', props: { X: '=40', Y: '=110', Width: '=200', Height: '=44', Text: '="Print()"', OnSelect: `=Print("${templateName}", ${rec})` }, children: [] },
    // the record as the app shows it (a delegated LookUp, loaded with the screen); the buttons act on it
    { id: 'n_lbl', name: 'Current', type: 'Label', props: { X: '=320', Y: '=40', Width: '=400', Height: '=40', Text: `=${rec}.Number & " · " & ${rec}.Product` }, children: [] },
    { id: 'n_b2', name: 'SavePdf', type: 'Button', props: { X: '=40', Y: '=180', Width: '=260', Height: '=44', Text: '="Save PDF to record"', OnSelect: `=Patch(Inspections, ${rec}, {Report: GeneratePdf("${templateName}", ${rec})})` }, children: [] },
  )
  await api('PUT', `/apps/${created.id}`, { definition: def })
  await page.goto(`${BASE}/#run-${created.id}`, { waitUntil: 'domcontentloaded' })
  await waitFor(T('print-button'))
  await sleep(1500)
  await shot('print-button-app.png')
  for (const [sel, what] of [[T('print-button'), 'the Print button UI component'], ['button:not([data-testid="print-button"])', 'Print() in a formula']]) {
    // headless Chrome has no PDF viewer (it would download): the new tab is a stand-in that records where it is sent
    await page.evaluate(() => {
      window.__printed = null
      const make = URL.createObjectURL.bind(URL)
      window.__blobs = new Map()
      URL.createObjectURL = (b) => { const u = make(b); window.__blobs.set(u, b); return u }
      window.open = () => ({ opener: null, close() { window.__printed = 'closed' }, location: { set href(u) { window.__printed = u } } })
    })
    if (what.startsWith('the Print')) await click(sel)
    else await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Print()')?.click())
    await page.waitForFunction(() => window.__printed, { timeout: 30000 })
    const tab = await page.evaluate(async () => {
      const u = window.__printed
      if (!String(u).startsWith('blob:')) return { url: u }
      const blob = window.__blobs.get(u)
      const b = new Uint8Array(await blob.arrayBuffer())
      let s = ''
      for (const c of b) s += String.fromCharCode(c)
      return { url: 'blob', type: blob.type, b64: btoa(s) }
    })
    const bytes = tab?.b64 ? Buffer.from(tab.b64, 'base64') : Buffer.alloc(0)
    const text = bytes.length ? pdfText(bytes) : ''
    keep(`inspection-from-app${what.startsWith('the') ? '' : '-fx'}.pdf`, bytes)
    check(tab?.type === 'application/pdf' && bytes.subarray(0, 5).toString() === '%PDF-' && (text === null || (/Inspection INSP-2026-0042/.test(text) && /Burr on inner bore/.test(text) && /^\s+11\s*$/m.test(text))), `${what} opens the inspection report PDF in a new tab`, `${tab?.url === 'blob' ? 'the tab gets the PDF' : `the tab got ${tab?.url}`}, ${bytes.length} bytes${text === null ? ' (pdftotext not installed: text not checked)' : ''}`)
  }
  await page.waitForFunction(() => document.body.innerText.includes('INSP-2026-0042 · Gear housing'), { timeout: 20000 })
  if (E.DEBUG) page.on('request', (r) => { if (r.url().includes('/api/v1/') && r.method() !== 'GET') console.log('request:', r.method(), r.url().replace(BASE, ''), (r.postData() ?? '').slice(0, 300)) })
  if (E.DEBUG) page.on('response', (r) => { if (r.url().includes('/api/v1/') && r.request().method() !== 'GET') r.text().then((t) => console.log('response:', r.status(), r.url().replace(BASE, ''), t.slice(0, 300))).catch(() => {}) })
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save PDF to record')?.click())
  await sleep(1500)
  if (E.DEBUG) console.log('page text after Save:', (await page.evaluate(() => document.body.innerText)).slice(0, 800))
  let cell = null
  for (let i = 0; i < 60 && !cell; i++) { await sleep(500); cell = (await q(`SELECT "Report" AS r FROM env_default.t_inspections WHERE id = $1`, [inspectionId]))[0]?.r }
  const att = cell ? await getBytes(`/attachments/${cell}`) : null
  check(!!cell && String(cell).startsWith('att') && att?.status === 200 && att.bytes.subarray(0, 5).toString() === '%PDF-', 'Patch(..., {Report: GeneratePdf(...)}) stores the PDF in the record\'s file column', String(cell))
}

/* ------------------------------------------------------------------ main */

let failed = false
try {
  await maint(`DROP DATABASE IF EXISTS "${DB.database}"`)
  smtp = await startFakeSmtp()
  await start()
  const setupCode = app.services.setupCode.current() ?? ''
  await api('POST', '/setup/database', { setupCode, host: DB.host, port: DB.port, database: DB.database, user: DB.user, password: DB.password, createDatabase: true })
  await api('POST', '/setup/admin', { setupCode, ...ADMIN })
  await api('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password })
  await api('PUT', '/identity/email', { host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'apps@example.com', installName: 'Shakti Apps', publicUrl: 'https://apps.example.com' })
  await api('POST', '/connections', { name: 'Mail', connector: 'email', settings: {} })
  const manager = await api('POST', '/users', { name: 'Meera Manager', email: 'manager@example.com', roleIds: ['role_maker'], password: 'manager-password-1' })

  log('A. pilot data, letterhead, built-in templates')
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
  const p = await createPilot({ admin, base: BASE }, today)
  await api('PUT', '/print/settings', { letterhead: { companyName: 'Shakti Precision Components Pvt Ltd', address: 'Plot 22, Govindpura Industrial Area, Bhopal 462023', gstin: '23AABCS1234F1Z5', phone: '+91 755 400 1234' } })
  const oeeTpl = (await api('POST', '/print/builtins', { key: 'daily-oee' })).template
  const insTpl = (await api('POST', '/print/builtins', { key: 'inspection-report' })).template
  record('the pilot\'s tables, sample data and the built-in templates exist', !!oeeTpl.id && !!insTpl.id, `${today}`)

  log('B. the daily OEE PDF by email from a scheduled flow')
  const settings = { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' }
  const flow = (await api('POST', '/flows', {
    name: 'Daily OEE to the manager', settings, enabled: true, trigger: { type: 'schedule', cron: '30 7 * * *', timeZone: 'Asia/Kolkata' },
    steps: [
      { id: 'pdf', name: 'OeePdf', kind: 'document.generate', template: oeeTpl.name },
      { id: 'mail', name: 'MailManager', kind: 'email', to: '"manager@example.com"', subject: '"Daily OEE " & Steps.OeePdf.Output.FileName', body: '"<p>Good morning. The daily production and OEE summary is attached.</p>"', attachments: 'Table({fileToken: Steps.OeePdf.Output.FileToken})' },
    ],
  })).flow
  const sched = (await api('GET', '/admin/schedules')).items.find((s) => s.payload?.flowId === flow.id || String(s.id).includes(flow.id))
  check(!!sched, 'the flow\'s schedule exists (07:30 India time)', sched ? `${sched.cron} ${sched.timeZone ?? ''}` : '')
  await api('POST', `/admin/schedules/${sched.id}/run`)
  const mail = await waitMail((m) => m.to.includes('manager@example.com') && /^Daily OEE/.test(m.subject), 'the daily OEE email')
  const att = mail.attachments.find((a) => /^OEE .*\.pdf$/.test(a.fileName))
  const oeeText = att ? pdfText(att.content) : null
  check(!!att && att.content.subarray(0, 5).toString() === '%PDF-' && (oeeText === null || (/Daily production and OEE/.test(oeeText) && /OEE by machine and shift/.test(oeeText) && /Production log/.test(oeeText) && /Shakti Precision Components/.test(oeeText))),
    'the manager receives the daily OEE PDF by email (fake SMTP), generated from the print template', att ? `${mail.subject}; ${att.fileName}, ${att.content.length} bytes${oeeText === null ? ' (pdftotext not installed)' : ''}` : 'no attachment')
  if (att) keep('daily-oee-emailed.pdf', att.content)
  let runRow = null
  for (let i = 0; i < 80; i++) {
    runRow = (await q(`SELECT state, trigger_kind FROM env_default.ab_flow_runs WHERE flow_id = $1 ORDER BY created_on DESC LIMIT 1`, [flow.id]))[0]
    if (runRow && !['queued', 'running', 'waiting'].includes(runRow.state)) break
    await sleep(250)
  }
  check(runRow?.state === 'succeeded' && runRow.trigger_kind === 'schedule', 'the flow run succeeded (schedule trigger)', JSON.stringify(runRow))
  const report = await api('POST', '/reports', { name: 'Daily OEE (report)', source: { kind: 'table', tableId: p.logs, plan: { version: 2, table: 'ProductionLogs' } }, schedule: { frequency: 'daily', time: '07:30', timeZone: 'Asia/Kolkata' }, recipients: { userIds: [manager.id ?? manager.user?.id], teamIds: [] }, csvRows: 0, pdf: { mode: 'template', template: oeeTpl.id } })
  await api('POST', `/reports/${report.id}/run`)
  const rmail = await waitMail((m) => m.to.includes('manager@example.com') && /Daily OEE \(report\)/.test(m.subject), 'the scheduled report email')
  check(rmail.attachments.some((a) => /^OEE .*\.pdf$/.test(a.fileName)), 'a scheduled report attaches the same template\'s PDF (made as the recipient)', rmail.attachments.map((a) => a.fileName).join(', '))

  log('C. the designer, by clicking')
  browser = await puppeteer.launch({ executablePath: E.CHROME_PATH || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--window-size=1600,1000'] })
  page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000 })
  page.on('dialog', (d) => d.accept())
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  if (E.DEBUG) page.on('console', (m) => console.log('console:', m.type(), m.text().slice(0, 300)))
  await page.goto(`${BASE}/#home`, { waitUntil: 'domcontentloaded' })
  await typeInto('input[type=email]', ADMIN.email)
  await typeInto('input[type=password]', ADMIN.password)
  await page.keyboard.press('Enter')
  await page.waitForSelector('nav', { timeout: 30000 })
  const designed = await designByClicking()

  log('D. printing an inspection report from a record')
  await printFromApp(designed.name, p.inspection1)
  const doc = await api('POST', `/print/templates/${insTpl.id}/documents`, { recordId: p.inspection1 })
  const docRow = (await q(`SELECT "Name", "regardingId", "File" FROM env_default.sys_documents WHERE id = $1`, [doc.documentId]))[0]
  check(docRow?.regardingId === p.inspection1 && String(docRow.File).startsWith('att'), 'the record timeline action stores the inspection report in the record\'s Documents', docRow?.Name)
  check(!errors.length, 'no script errors in the browser', errors.slice(0, 3).join(' | '))
} catch (e) {
  failed = true
  console.error(e)
  if (page && SHOTS) await shot('failure.png').catch(() => undefined)
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stop().catch(() => undefined)
  await smtp?.close().catch(() => undefined)
  if (!E.KEEP) await maint(`DROP DATABASE IF EXISTS "${DB.database}"`).catch((e) => console.error(`could not drop ${DB.database}: ${e.message}`))
  fs.rmSync(DIR, { recursive: true, force: true })
}
const bad = results.filter((r) => !r.ok)
console.log(`\n${results.length - bad.length}/${results.length} checks passed${failed || bad.length ? ' - EXIT CHECK 2 FAILED' : ' - EXIT CHECK 2 PASSED'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
process.exit(failed || bad.length ? 1 : 0)
