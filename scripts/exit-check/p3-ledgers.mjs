#!/usr/bin/env node
/**
 * Phase 3 package L (ledgers and India GST), the exit checks of docs/plan/ledgers-gst-spec.md section 6, against a REAL
 * server and, with a headless browser, the real Accounts area. DEVELOPER TOOL (sandbox values only), not part of the
 * product. Re-runnable.
 *
 *   npm run build   (the server serves dist/)
 *   node scripts/exit-check/p3-ledgers.mjs
 *
 * The figures are worked examples of docs/plan/gst-spec-draft.md (W1, W2, W8), a DRAFT that no accountant has reviewed:
 * this script checks that the software does what the draft says, not that the draft is right in law. The State codes and
 * rates it enters are test data.
 *
 * A server is started in this process (EXIT_PORT, default 5336) on an EMPTY database (EXIT_DB_NAME, default
 * appbuilder_exit_p3ledgers: created and dropped here; KEEP=1 keeps it), workspace EXIT_WORKSPACE (default
 * .sandbox/L/workspace, emptied). All documents are dated today (a number is never back-dated and the browser's new
 * document is dated today); the period that gets locked is next month.
 *
 *  1. setup through the API: nothing ships as data; example reference data (marked not approved, no rates), the default
 *     chart with the GST accounts of draft 9.1, the business registration, the financial year with 12 periods, rates;
 *  2. W1: an intra-State tax invoice: numbered at issue, CGST = SGST, journal G9.1 balanced;
 *  3. W2: an inter-State tax invoice with IGST (G9.2a);
 *  4. W8: a credit note against the first invoice; a second one above what the invoice still has is refused (G5.12);
 *  5. a STOP case (a service with a special place-of-supply rule) issues nothing and takes no number;
 *  6. the browser, as the administrator: Settings shows the "draft, not reviewed" notice; a third invoice is entered and
 *     issued in the page; the document list shows all four; the PDF link answers a PDF; the trial balance page shows
 *     equal totals; next month is locked in the Periods page;
 *  7. the locked period refuses an issue and a journal for everybody; unlocking needs a reason;
 *  8. the trial balance balances with the expected output tax and receivable; an issued document cannot be edited; the
 *     PDFs of the invoices and the credit note exist;
 *  9. return summaries answer as data and as CSV; a person without an Accounts level gets nothing.
 *
 * Settings: EXIT_DB_HOST (127.0.0.1), EXIT_DB_PORT (5435), EXIT_DB_USER (abdev), EXIT_DB_PASSWORD (abdev-sandbox-only),
 * EXIT_DB_NAME, EXIT_MAINT_DB (appbuilder_test), EXIT_PORT (5336), EXIT_WORKSPACE, PUPPETEER_CORE, CHROME_PATH, SHOTS.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { chromePath, puppeteerCorePath } from './browser-env.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const DB = { host: E.EXIT_DB_HOST || '127.0.0.1', port: Number(E.EXIT_DB_PORT || 5435), user: E.EXIT_DB_USER || 'abdev', password: E.EXIT_DB_PASSWORD || 'abdev-sandbox-only', database: E.EXIT_DB_NAME || 'appbuilder_exit_p3ledgers' }
const MAINT = E.EXIT_MAINT_DB || 'appbuilder_test'
const PORT = Number(E.EXIT_PORT || 5336)
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = E.SHOTS || ''
const S = 'env_default'
const PASS = 'Exit-Example-Pass-2026'
const ADMIN = { name: 'Exit Admin', email: 'exit-admin@example.test', password: PASS }
if (PORT === 5174 || DB.port === 5433) { console.error('Ports 5174 and 5433 belong to the real install; choose others.'); process.exit(2) }
if (!/^(ab_d\d+|ab_s\d+|appbuilder_exit)/.test(DB.database)) { console.error('The database name must start with ab_d<n>, ab_s<n> or appbuilder_exit (it is dropped).'); process.exit(2) }
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) { console.error('Build the app first (npm run build).'); process.exit(2) }

const imp = (p) => import(pathToFileURL(path.join(root, p)).href)
const { createApp } = await imp('server/core/app.ts')
const { serveStatic } = await imp('server/core/static.ts')
const { setQuiet } = await imp('server/core/util.ts').catch(() => ({ setQuiet: null }))
const { Client } = await imp('server/core/kernel-testkit.ts')
const { hashPassword } = await imp('server/core/password.ts')
const { runInEnvironment } = await imp('server/core/env-context.ts')
const { default: puppeteer } = await import(pathToFileURL(path.join(puppeteerCorePath(root), 'lib/puppeteer/puppeteer-core.js')).href)
if (setQuiet) setQuiet(true)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`)
const results = []
const record = (name, ok, evidence = '') => { results.push({ name, ok, evidence }); log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence ? `: ${evidence}` : ''}`) }
const check = (cond, name, evidence) => { record(name, !!cond, evidence); if (!cond) throw new Error(`check failed: ${name} ${evidence ?? ''}`) }
async function maint(sql) { const c = new pg.Client({ ...DB, database: MAINT }); await c.connect(); try { await c.query(sql) } finally { await c.end() } }
async function q(sql, params = []) { const c = new pg.Client(DB); await c.connect(); try { return (await c.query(sql, params)).rows } finally { await c.end() } }

/* ------------------------------------------------------------------ server, API */

const DIR = path.resolve(E.EXIT_WORKSPACE || path.join(root, '.sandbox', 'L', 'workspace'))
if (path.resolve(DIR) === root || !/workspace/i.test(path.basename(DIR))) { console.error('EXIT_WORKSPACE must be a folder named ...workspace... (it is emptied).'); process.exit(2) }
fs.rmSync(DIR, { recursive: true, force: true })
fs.mkdirSync(DIR, { recursive: true })
let app = null
let server = null
async function start() {
  app = await createApp({ env: { APPBUILDER_MIGRATION_BACKUP: 'skip' }, config: { workspaceDir: DIR }, printSetupCode: false, jobs: true })
  server = http.createServer((req, res) => {
    app.handle(req, res).then((h) => { if (!h) serveStatic(app.config.distDir ?? path.join(root, 'dist'), req, res) }, () => { if (!res.headersSent) res.writeHead(500); res.end() })
  })
  server.on('upgrade', (req, socket, head) => { if (!app.handleUpgrade(req, socket, head)) socket.destroy() })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
}
async function stop() {
  if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(() => r())) }
  if (app) await app.close()
}
const admin = new Client(BASE)
async function api(method, p, body, c = admin) {
  const r = await c.req(method, p, body)
  if (r.status !== 200) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`)
  return r.data
}
const rs = (p) => (p / 100).toFixed(2)
const draft = async (body) => (await api('POST', '/accounts/documents', body)).document
const issue = async (id) => (await api('POST', `/accounts/documents/${id}/issue`, {})).document
async function journalOf(id, keyOf) {
  const j = (await api('GET', `/accounts/journals/${id}`)).journal
  const d = j.lines.reduce((s, l) => s + l.debit, 0)
  const c = j.lines.reduce((s, l) => s + l.credit, 0)
  return { balanced: d === c && d > 0, text: j.lines.map((l) => `${keyOf(l.accountId)} ${rs(l.debit)} ${rs(l.credit)}`).sort().join('; ') }
}
async function pdfOk(id) {
  const res = await fetch(`${BASE}/api/v1/accounts/documents/${id}/pdf`, { headers: { Cookie: admin.cookie, 'X-Appbuilder': '1' } })
  const bytes = Buffer.from(await res.arrayBuffer())
  return { ok: res.status === 200 && bytes.subarray(0, 5).toString() === '%PDF-' && bytes.length > 1000, size: bytes.length }
}

/* ------------------------------------------------------------------ browser */

let browser = null
const T = (id) => `[data-testid="${id}"]`
const errors = []
async function shot(page, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }) } }
async function click(page, sel, timeout = 20000) { await page.waitForSelector(`${sel}:not([disabled])`, { visible: true, timeout }); await page.$eval(sel, (e) => e.scrollIntoView({ block: 'center' })); await page.click(sel) }
const textOf = (page, sel) => page.$eval(sel, (e) => e.textContent ?? '')
async function fill(page, sel, v) {
  await page.waitForSelector(sel, { visible: true, timeout: 20000 })
  await page.$eval(sel, (e) => e.scrollIntoView({ block: 'center' }))
  await page.focus(sel)
  await page.$eval(sel, (e) => e.select?.())
  await page.keyboard.press('Backspace')
  await page.keyboard.type(v)
}

/* ------------------------------------------------------------------ main */

const today = new Date().toISOString().slice(0, 10)
const nextMonth = (() => { const d = new Date(`${today.slice(0, 8)}01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10) })()
const SRC = 'exit-check test data, not a real notification'
let failed = false
try {
  await maint(`DROP DATABASE IF EXISTS "${DB.database}"`)
  await start()
  const setupCode = app.services.setupCode.current() ?? ''
  await api('POST', '/setup/database', { setupCode, host: DB.host, port: DB.port, database: DB.database, user: DB.user, password: DB.password, createDatabase: true })
  await api('POST', '/setup/admin', { setupCode, ...ADMIN })
  await api('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password })

  /* 1. setup */
  const st0 = await api('GET', '/accounts/state')
  check(st0.level === 'admin' && st0.business === null && st0.setup.states === 0 && st0.setup.rates === 0 && st0.setup.thresholds === 0 && !st0.setup.chart && /draft that has not yet been reviewed by a practising accountant/.test(st0.notice),
    'a new install ships no rates, State codes, thresholds or chart; the state carries the "draft, not reviewed" notice')
  const ex = (await api('POST', '/accounts/reference/examples', {})).added
  const states = (await api('GET', '/accounts/reference/states')).items
  const rates0 = (await api('GET', '/accounts/reference/rates')).items
  check(ex.states > 30 && states.every((s) => /NOT APPROVED/.test(s.source) && !s.approvedBy) && rates0.length === 0, 'example reference data: States and values marked "not approved"; no rates are added', `${ex.states} States, ${ex.values} values`)
  const added = (await api('POST', '/accounts/setup', {})).added
  const chart = (await api('GET', '/accounts/chart')).items
  const acc = Object.fromEntries(chart.filter((a) => a.systemKey).map((a) => [a.systemKey, a.id]))
  const keyOf = (id) => Object.entries(acc).find(([, v]) => v === id)?.[0] ?? id
  const need = ['output_cgst', 'output_sgst', 'output_utgst', 'output_igst', 'output_cess', 'input_cgst', 'input_sgst', 'input_utgst', 'input_igst', 'input_cess', 'rcm_cgst', 'rcm_sgst', 'rcm_utgst', 'rcm_igst', 'input_cgst_rcm', 'input_sgst_rcm',
    'input_utgst_rcm', 'input_igst_rcm', 'advance_gst_suspense', 'customer_advances', 'composition_cgst', 'composition_sgst', 'composition_expense', 'round_off', 'sales_taxable', 'sales_exempt', 'sales_nil', 'sales_zero_rated', 'sales_non_gst', 'receivables', 'payables']
  check(added.accounts === chart.length && need.every((k) => acc[k]) && added.series >= 8, 'the default chart of accounts has the GST accounts of draft section 9.1; a default number series exists per document type', `${chart.length} accounts, ${added.series} series`)
  const business = (await api('PUT', '/accounts/business', { legalName: 'Asha Pumps Private Limited', address: '12 Industrial Area, Indore 452001', stateCode: '23', regType: 'regular', gstin: '23ABCDE1234F1Z5' })).business
  const years = [(await api('POST', '/accounts/years', { date: today })).item]
  const second = await admin.post('/accounts/years', { date: nextMonth })
  if (second.status === 200) years.push(second.data.item)
  const periods = years.flatMap((y) => y.periods)
  check(business.gstin === '23ABCDE1234F1Z5' && years[0].periods.length === 12 && periods.every((p) => p.state === 'open'), 'the business registration is saved; the financial year has 12 open monthly periods', years.map((y) => y.name).join(', '))
  const badRate = await admin.post('/accounts/reference/rates', { code: '8413', kind: 'goods', igst: '18', cgst: '9', sgst: '8', effectiveFrom: '2017-07-01', source: SRC })
  for (const [code, kind, igst, half] of [['8413', 'goods', '18', '9'], ['9983', 'service', '18', '9']]) await api('POST', '/accounts/reference/rates', { code, kind, igst, cgst: half, sgst: half, effectiveFrom: '2017-07-01', source: SRC })
  check(badRate.status === 422 && /must equal the IGST rate/.test(badRate.data.error.message), 'a rate row whose CGST and SGST do not add up to IGST is refused; rates entered by the administrator are accepted (G4.2)')
  const party = async (b) => (await api('POST', '/accounts/parties', b)).item.id
  const mp = await party({ name: 'Bhopal Traders', regType: 'regular', stateCode: '23', gstin: '23AAAAA0000A1Z5', address: 'MP Nagar, Bhopal' })
  const mh = await party({ name: 'Pune Engineering', regType: 'regular', stateCode: '27', gstin: '27BBBBB1111B1Z5', address: 'Hadapsar, Pune' })
  const item = async (b) => (await api('POST', '/accounts/items', b)).item.id
  const pump = await item({ name: 'Monoblock pump 1 HP', kind: 'goods', hsn: '84137010', uqc: 'NOS', unitPrice: '1250.00' })
  const survey = await item({ name: 'Site survey of a building', kind: 'service', hsn: '998399', posCategory: 'immovable property' })

  /* 2. W1 */
  const d1 = await draft({ docType: 'tax_invoice', date: today, partyId: mp, lines: [{ itemId: pump, quantity: '10', unitPrice: '1250.00' }] })
  check(d1.state === 'draft' && d1.number === null && d1.problem === null && rs(d1.totals.total) === '14750.00', 'a draft has no number and shows the figures it would get', `total ${rs(d1.totals.total)}`)
  const w1 = await issue(d1.id)
  const j1 = await journalOf(w1.journalId, keyOf)
  check(/^INV\/\d\d-\d\d\/00001$/.test(w1.number) && w1.taxKind === 'intra' && w1.placeOfSupply === '23' && rs(w1.totals.cgst) === '1125.00' && w1.totals.cgst === w1.totals.sgst && w1.totals.igst === 0 && rs(w1.totals.total) === '14750.00',
    'W1: the intra-State tax invoice is numbered at issue; CGST 1,125.00 = SGST 1,125.00; total 14,750.00', w1.number)
  check(j1.balanced && j1.text === 'output_cgst 0.00 1125.00; output_sgst 0.00 1125.00; receivables 14750.00 0.00; sales_taxable 0.00 12500.00', 'its journal is posted in the same step and balances (G9.1)', j1.text)

  /* 3. W2 */
  const w2 = await issue((await draft({ docType: 'tax_invoice', date: today, partyId: mh, lines: [{ itemId: pump, quantity: '10', unitPrice: '1250.00' }] })).id)
  const j2 = await journalOf(w2.journalId, keyOf)
  check(/00002$/.test(w2.number) && w2.taxKind === 'inter' && w2.placeOfSupply === '27' && rs(w2.totals.igst) === '2250.00' && w2.totals.cgst === 0 && j2.balanced && j2.text === 'output_igst 0.00 2250.00; receivables 14750.00 0.00; sales_taxable 0.00 12500.00',
    'W2: the inter-State tax invoice carries IGST 2,250.00 and posts G9.2a', `${w2.number}: ${j2.text}`)

  /* 4. W8 */
  const cnBody = { docType: 'credit_note', date: today, partyId: mp, originalId: w1.id, reason: 'return', itcReversalConfirmed: 'yes', lines: [{ itemId: pump, quantity: '2', unitPrice: '1250.00' }] }
  const cn = await issue((await draft(cnBody)).id)
  const j3 = await journalOf(cn.journalId, keyOf)
  check(/^CN\/\d\d-\d\d\/00001$/.test(cn.number) && rs(cn.totals.total) === '2950.00' && cn.taxKind === 'intra' && j3.balanced && j3.text === 'output_cgst 225.00 0.00; output_sgst 225.00 0.00; receivables 0.00 2950.00; sales_returns 2500.00 0.00',
    'W8: the credit note takes the tax type and rate of its invoice and posts G9.3', `${cn.number}: ${j3.text}`)
  const over = await draft({ ...cnBody, lines: [{ itemId: pump, quantity: '9', unitPrice: '1250.00' }] })
  const overIssue = await admin.post(`/accounts/documents/${over.id}/issue`, {})
  check(overIssue.status === 422 && overIssue.data.stop?.rule === 'G5.12' && (await api('GET', `/accounts/documents/${over.id}`)).document.state === 'draft', 'a second credit note above what the invoice still has is refused and stays a draft (G5.12)', overIssue.data.error?.message)
  await api('DELETE', `/accounts/documents/${over.id}`)

  /* 5. STOP */
  const stopDraft = await draft({ docType: 'tax_invoice', date: today, partyId: mp, lines: [{ itemId: survey, quantity: '1', unitPrice: '40000' }] })
  const stopIssue = await admin.post(`/accounts/documents/${stopDraft.id}/issue`, {})
  const counter = (await q(`SELECT c.last_value FROM ${S}.ab_gst_series_counters c JOIN ${S}.ab_gst_series s ON s.id = c.series_id WHERE s.doc_type = 'tax_invoice'`))[0].last_value
  check(stopIssue.status === 422 && stopIssue.data.stop?.rule === 'G3.9' && /^Place of supply needs the accountant: /.test(stopIssue.data.error.message) && Number(counter) === 2,
    'a STOP case (a service with a special place-of-supply rule) issues nothing, says what the accountant must decide and takes no number', stopIssue.data.error?.message)
  await api('DELETE', `/accounts/documents/${stopDraft.id}`)

  /* 6. the browser */
  browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1500,1000'] })
  const page = await (await browser.createBrowserContext()).newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.setViewport({ width: 1500, height: 1000 })
  await page.goto(`${BASE}/#home`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[type=email]', { timeout: 30000 })
  await page.type('input[type=email]', ADMIN.email)
  await page.type('input[type=password]', PASS)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 30000 })
  await sleep(500)
  await page.goto(`${BASE}/#u-accounts`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(T('accounts-page'), { visible: true, timeout: 45000 })
  await click(page, T('accounts-tab-settings'))
  await page.waitForSelector(T('accounts-notice'), { visible: true, timeout: 20000 })
  const notice = await textOf(page, T('accounts-notice'))
  const gstinShown = await page.$eval(T('business-gstin'), (e) => e.value)
  check(/draft that has not yet been reviewed by a practising accountant/.test(notice) && gstinShown === '23ABCDE1234F1Z5', 'the browser: Accounts > Settings shows the "draft, not reviewed" notice and the business registration', notice.slice(0, 90))
  await shot(page, 'ledgers-settings.png')

  await click(page, T('accounts-tab-documents'))
  await page.waitForSelector(T('doc-row'), { visible: true, timeout: 20000 })
  await click(page, T('doc-new'))
  await page.waitForSelector(T('doc-editor'), { visible: true, timeout: 20000 })
  await page.select(T('doc-party'), mh)
  await page.select(T('doc-line-item-0'), pump)
  await fill(page, T('doc-line-qty-0'), '4')
  await page.waitForFunction((s) => document.querySelector(s)?.value === '1250.00', { timeout: 10000 }, T('doc-line-price-0'))
  await click(page, T('doc-save'))
  await page.waitForFunction((s) => document.querySelector(s)?.textContent === '5,900.00', { timeout: 20000 }, T('doc-total'))
  await shot(page, 'ledgers-draft.png')
  await click(page, T('doc-issue'))
  await page.waitForFunction((s) => document.querySelector(s)?.textContent === 'Issued', { timeout: 30000 }, T('doc-state'))
  const heading = await page.$eval(T('accounts-document'), (e) => e.querySelector('h2')?.textContent ?? '')
  const pdfHref = await page.$eval(T('doc-pdf'), (e) => e.href)
  const pdfInPage = await page.evaluate(async (u) => { const r = await fetch(u); const b = new Uint8Array(await r.arrayBuffer()); return { status: r.status, type: r.headers.get('content-type'), head: String.fromCharCode(...b.slice(0, 5)), size: b.length } }, pdfHref)
  check(/INV\/\d\d-\d\d\/00003/.test(heading) && pdfInPage.status === 200 && pdfInPage.type === 'application/pdf' && pdfInPage.head === '%PDF-' && pdfInPage.size > 1000, 'the browser: an inter-State invoice is entered, previewed (5,900.00), issued as number 00003, and its PDF link answers a PDF', `${heading.trim()}, PDF ${pdfInPage.size} bytes`)
  await shot(page, 'ledgers-issued.png')
  await click(page, T('doc-back'))
  // the list reloads after "back": wait for the row of the invoice just issued, not for the old rows
  await page.waitForFunction((s) => [...document.querySelectorAll(s)].some((r) => /00003$/.test(r.getAttribute('data-number') ?? '')), { timeout: 20000 }, T('doc-row'))
  const listed = await page.$$eval(T('doc-row'), (rows) => rows.map((r) => r.getAttribute('data-number')))
  check([w1.number, w2.number, cn.number].every((n) => listed.includes(n)) && listed.some((n) => /00003$/.test(n ?? '')), 'the browser: the document list shows the two invoices, the credit note and the invoice issued in the page', listed.join(', '))

  await click(page, T('accounts-tab-reports'))
  await page.waitForSelector(T('trial-balance'), { visible: true, timeout: 20000 })
  const tbUi = { debit: await textOf(page, T('tb-total-debit')), credit: await textOf(page, T('tb-total-credit')), cd: await textOf(page, T('tb-closing-debit')), cc: await textOf(page, T('tb-closing-credit')), note: await textOf(page, T('tb-balanced')) }
  check(tbUi.debit === tbUi.credit && tbUi.cd === tbUi.cc && tbUi.debit !== '0.00' && tbUi.note === 'Debits equal credits.', 'the browser: the trial balance page shows equal debit and credit totals', `${tbUi.debit} = ${tbUi.credit}; closing ${tbUi.cd} = ${tbUi.cc}`)
  await shot(page, 'ledgers-trial-balance.png')

  await click(page, T('accounts-tab-periods'))
  const row = T(`period-${nextMonth.slice(0, 7)}`)
  await page.waitForSelector(row, { visible: true, timeout: 20000 })
  await click(page, `${row} ${T('period-lock')}`)
  await page.waitForFunction((s) => document.querySelector(s)?.textContent === 'Locked', { timeout: 20000 }, `${row} ${T('period-state')}`)
  await shot(page, 'ledgers-periods.png')
  const locked = (await api('GET', '/accounts/years')).items.flatMap((y) => y.periods).find((p) => p.start === nextMonth)
  check(locked.state === 'locked', 'the browser: next month is locked in the Periods page', `${nextMonth.slice(0, 7)} is ${locked.state}`)

  /* 7. the locked period */
  const lateDraft = await draft({ docType: 'tax_invoice', date: nextMonth, partyId: mp, lines: [{ itemId: pump, quantity: '1', unitPrice: '1250.00' }] })
  const lateIssue = await admin.post(`/accounts/documents/${lateDraft.id}/issue`, {})
  const lateJournal = await admin.post('/accounts/journals', { date: nextMonth, narration: 'Rent', lines: [{ accountId: acc.rent, debit: '100.00' }, { accountId: acc.bank, credit: '100.00' }] })
  const journalsBefore = (await q(`SELECT count(*)::int AS n FROM ${S}.ab_led_journals`))[0].n
  check(lateIssue.status === 409 && /is locked: nobody can issue a document in it/.test(lateIssue.data.error.message) && lateJournal.status === 409 && (await api('GET', `/accounts/documents/${lateDraft.id}`)).document.number === null,
    'a locked period refuses an issue and a journal, also for the administrator; the draft keeps no number', lateIssue.data.error?.message)
  const noReason = await admin.post(`/accounts/periods/${locked.id}/unlock`, {})
  const unlocked = await api('POST', `/accounts/periods/${locked.id}/unlock`, { reason: 'exit check: a late bill' })
  const audit = await q(`SELECT action, details FROM ${S}.ab_audit WHERE action LIKE 'accounts.period.%' ORDER BY id`)
  check(noReason.status === 422 && unlocked.item.state === 'open' && audit.length === 2 && audit[1].details.reason === 'exit check: a late bill' && (await q(`SELECT count(*)::int AS n FROM ${S}.ab_led_journals`))[0].n === journalsBefore,
    'unlocking needs a typed reason; the lock and the unlock are in the audit log', audit.map((a) => a.action).join(', '))
  await api('DELETE', `/accounts/documents/${lateDraft.id}`)

  /* 8. trial balance, immutability, PDFs */
  const tb = await api('GET', `/accounts/reports/trial-balance?to=${today}`)
  const closing = (k) => tb.rows.find((r) => r.accountId === acc[k])?.closing ?? 0
  const unbalanced = await q(`SELECT journal_id FROM ${S}.ab_led_lines GROUP BY journal_id HAVING sum(debit) <> sum(credit)`)
  // receivable: 14,750 + 14,750 - 2,950 + 5,900; output CGST and SGST 1,125 - 225; output IGST 2,250 + 900
  check(tb.balanced && tb.totals.debit === tb.totals.credit && tb.totals.closingDebit === tb.totals.closingCredit && unbalanced.length === 0 && rs(closing('receivables')) === '32450.00' && rs(closing('output_cgst')) === '-900.00' && rs(closing('output_sgst')) === '-900.00' && rs(closing('output_igst')) === '-3150.00' && rs(closing('sales_taxable')) === '-30000.00' && rs(closing('sales_returns')) === '2500.00',
    'the trial balance balances; receivables 32,450.00, output CGST and SGST 900.00 each, output IGST 3,150.00; every journal balances on its own', `debits ${rs(tb.totals.debit)} = credits ${rs(tb.totals.credit)}`)
  const bs = await api('GET', `/accounts/reports/balance-sheet?asOf=${today}`)
  const pl = await api('GET', `/accounts/reports/profit-loss?from=${years[0].start}&to=${today}`)
  check(bs.balanced && rs(pl.profit) === '27500.00' && bs.profitToDate === pl.profit, 'the balance sheet balances and agrees with the profit and loss (27,500.00)')
  const edit = await admin.patch(`/accounts/documents/${w1.id}`, { lines: [{ itemId: pump, quantity: '1', unitPrice: '1.00' }] })
  const del = await admin.del(`/accounts/documents/${w1.id}`)
  const after = (await api('GET', `/accounts/documents/${w1.id}`)).document
  check(edit.status === 409 && /credit note or a debit note/.test(edit.data.error.message) && del.status === 409 && after.totals.total === w1.totals.total && after.number === w1.number, 'an issued document cannot be edited or deleted; the answer names the credit or debit note', edit.data.error?.message)
  const pdfs = [await pdfOk(w1.id), await pdfOk(w2.id), await pdfOk(cn.id)]
  check(pdfs.every((p) => p.ok), 'the PDFs of the intra-State invoice, the inter-State invoice and the credit note exist', pdfs.map((p) => `${p.size} bytes`).join(', '))

  /* 9. return summaries; no access */
  const list = (await api('GET', '/accounts/returns')).items
  const reg = await api('GET', `/accounts/returns/outward-register?from=${today}&to=${today}`)
  const regRow = reg.rows.find((r) => r[1] === w1.number)
  const csv = await admin.get(`/accounts/returns/b2b?from=${today}&to=${today}&format=csv`)
  const tbCsv = await admin.get(`/accounts/reports/trial-balance?to=${today}&format=csv`)
  check(list.length === 13 && regRow && regRow[4] === '23AAAAA0000A1Z5' && regRow[14] === '12500.00' && csv.status === 200 && /Recipient GSTIN,Document number/.test(String(csv.data)) && String(csv.data).includes(w2.number) && tbCsv.status === 200 && /Output IGST/.test(String(tbCsv.data)),
    'return summaries answer as data and as CSV (13 summaries; nothing is filed anywhere); the trial balance exports as CSV', `${reg.rows.length} register rows`)
  await runInEnvironment('default', async () => app.services.meta.users.insert({ id: 'user_nobody', name: 'Nora Nobody', email: 'nora@example.test', roleIds: [], status: 'active', passwordHash: await hashPassword(PASS) }))
  await q(`INSERT INTO ab.environment_access (environment_id, user_id, is_env_admin, granted_on) VALUES ('default', 'user_nobody', false, now()) ON CONFLICT DO NOTHING`)
  app.services.security.invalidate('all')
  const nora = new Client(BASE)
  await api('POST', '/auth/login', { email: 'nora@example.test', password: PASS }, nora)
  const anon = new Client(BASE)
  const denied = [(await nora.get('/accounts/documents')).status, (await nora.get('/accounts/reports/trial-balance')).status, (await nora.post('/accounts/journals', {})).status, (await anon.get('/accounts/documents')).status]
  check(denied.join(',') === '403,403,403,401' && (await api('GET', '/accounts/state', undefined, nora)).level === 'none', 'a person without an Accounts level reads and writes nothing; without a session the answer is 401', denied.join(', '))
  check(!errors.length, 'no script errors in the browser', errors.slice(0, 3).join(' | '))
} catch (e) {
  failed = true
  console.error(e)
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stop().catch(() => undefined)
  if (!E.KEEP) await maint(`DROP DATABASE IF EXISTS "${DB.database}"`).catch((e) => console.error(`could not drop ${DB.database}: ${e.message}`))
}
const bad = results.filter((r) => !r.ok)
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed${failed ? ' (stopped at the first failure)' : ''}`)
process.exit(failed || bad.length ? 1 : 0)
