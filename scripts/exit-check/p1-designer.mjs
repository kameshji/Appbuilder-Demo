#!/usr/bin/env node
/**
 * Phase 1 exit check 2 (docs/plan/p1-spec.md): "a flow built in the designer by clicking only (no JSON) passes the same
 * test" as exit check 1. DEVELOPER TOOL (sandbox values only), not part of the product. Re-runnable.
 *
 *   npm run build   (or npx vite build: the server serves dist/)
 *   node scripts/exit-check/p1-designer.mjs
 *
 * What it does, against a server started in this process on an EMPTY database (created and dropped here):
 *  A. In a headless browser, as an administrator: Flows > New flow > blank "When a row changes", then builds the
 *     purchase approval flow with the visual designer only (the step picker, panels, the condition builder, dynamic
 *     content, run after, renames; formulas typed into formula fields where one is needed, never JSON): manager approval
 *     with a 2-day time limit, an escalation scope that runs after it timed out, a condition (timed out, or approved and
 *     above 10000) with a director approval inside, the outcome, the status written back, the requester told. Publishes
 *     it (a draft until then), turns it on, adds a request through an app's form in a second tab, and watches the run
 *     overlay on the canvas: the manager step waits.
 *  B. The definition the clicks produced is compared with the exit-check-1 flow (same steps, kinds, run after, settings).
 *  C. The same test as exit check 1 on that flow: four requests over a simulated week (flow clock), answers by manager
 *     and director, one escalation after two days, two server restarts; every run ends once, statuses and messages are
 *     exactly the expected ones, every data change happens once. Approvals: package C's service when it is registered
 *     (answers go through its respond()), otherwise a stub (answers go through services.flows.resumeWait).
 *  D. Performance: a 150-step flow opened in the designer (render time, selecting and adding a step).
 *
 * Settings: EXIT_DB_HOST (127.0.0.1), EXIT_DB_PORT (5433), EXIT_DB_USER (abdev), EXIT_DB_PASSWORD (abdev-sandbox-only),
 * EXIT_DB_NAME (appbuilder_exit_designer), EXIT_MAINT_DB (appbuilder_test), EXIT_PORT (5262), PUPPETEER_CORE
 * (/tmp/pgcheck/node_modules/puppeteer-core), CHROME_PATH (/usr/bin/google-chrome), SHOTS (a folder for screenshots),
 * KEEP=1 keeps the database. Prints PASS/FAIL lines and a summary; exit code 1 when a check fails.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const DB = { host: E.EXIT_DB_HOST || '127.0.0.1', port: Number(E.EXIT_DB_PORT || 5433), user: E.EXIT_DB_USER || 'abdev', password: E.EXIT_DB_PASSWORD || 'abdev-sandbox-only', database: E.EXIT_DB_NAME || 'appbuilder_exit_designer' }
const MAINT = E.EXIT_MAINT_DB || 'appbuilder_test'
const PORT = Number(E.EXIT_PORT || 5262)
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = E.SHOTS || ''
const ADMIN = { name: 'Exit Admin', email: 'exit@example.test', password: 'Exit-Example-Pass-2026' }
if (!/^appbuilder_exit/.test(DB.database)) { console.error('The exit-check database name must start with appbuilder_exit (it is dropped).'); process.exit(2) }
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) { console.error('Build the app first (npm run build).'); process.exit(2) }

const { createApp } = await import(pathToFileURL(path.join(root, 'server/core/app.ts')).href)
const { serveStatic } = await import(pathToFileURL(path.join(root, 'server/core/static.ts')).href)
const { runInEnvironment } = await import(pathToFileURL(path.join(root, 'server/core/env-context.ts')).href)
const { setQuiet } = await import(pathToFileURL(path.join(root, 'server/core/util.ts')).href).catch(() => ({ setQuiet: null }))
const { default: puppeteer } = await import(pathToFileURL(path.join(E.PUPPETEER_CORE || '/tmp/pgcheck/node_modules/puppeteer-core', 'lib/puppeteer/puppeteer-core.js')).href)
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

/* ------------------------------------------------------------------ the server, in this process */

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-exit-designer-'))
let app = null
let server = null
let now = new Date('2030-03-04T09:00:00Z') // a Monday; the flow clock
const stubRequests = []
let usingStub = false

/** what every (re)started server needs: the flow clock; the approval stub when package C is not there */
function wire(a) {
  a.services.flows.setClock({ now: () => now })
  if (!a.services.flows.approvals()) {
    usingStub = true
    a.services.flows.setApprovals({ async request(_env, req) { stubRequests.push(req); return { id: `appr_stub_${stubRequests.length}` } } })
  }
}
async function start(jobs) {
  app = await createApp({ env: {}, config: { workspaceDir: DIR }, printSetupCode: false, jobs })
  server = http.createServer((req, res) => { app.handle(req, res).then((h) => { if (!h) serveStatic(app.config.distDir ?? path.join(root, 'dist'), req, res) }, () => { if (!res.headersSent) res.writeHead(500); res.end() }) })
  server.on('upgrade', (req, socket, head) => { if (!app.handleUpgrade(req, socket, head)) socket.destroy() })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
  if (app.services.ready()) wire(app)
}
async function stop() {
  if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(() => r())) }
  if (app) await app.close()
  server = null
  app = null
}
async function restart(jobs = false) { await stop(); await start(jobs); check(app.services.ready(), 'the server restarts on the same database') }

let cookie = ''
async function api(method, p, body) {
  const res = await fetch(BASE + '/api/v1' + p, { method, headers: { 'X-Appbuilder': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  for (const c of res.headers.getSetCookie?.() ?? []) { const [pair] = c.split(';'); if (pair.startsWith('ab_session=')) cookie = pair }
  const data = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : await res.text()
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(data).slice(0, 400)}`)
  return data
}

/* ------------------------------------------------------------------ browser helpers */

let browser = null
let page = null
async function shot(name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }) } }
const T = (id) => `[data-testid="${id}"]`
async function waitFor(sel, timeout = 15000) { return page.waitForSelector(sel, { visible: true, timeout }) }
/** DOM click (works for elements outside the visible part of the canvas) */
async function domClick(sel) { await page.waitForSelector(sel, { timeout: 15000 }); await page.$eval(sel, (e) => e.click()) }
async function click(sel) { await page.waitForSelector(`${sel}:not([disabled])`, { visible: true, timeout: 15000 }); const el = await waitFor(sel); await el.click() }
async function typeInto(sel, text, { clear = true } = {}) {
  const el = await waitFor(sel)
  await el.click()
  if (clear) { await el.evaluate((e) => { if (typeof e.select === 'function') e.select() }); await page.keyboard.press('Backspace') }
  await page.type(sel, text)
  await page.keyboard.press('Escape') // close suggestions
}
async function select(sel, value) { await waitFor(sel); await page.select(sel, value); await sleep(150) }
async function panelHas(name) { await page.waitForFunction((n) => document.querySelector('[data-testid="step-name-input"]')?.value === n, { timeout: 15000 }, name) }
/** add a step at an insertion point by picking a kind in the step picker, then rename it in the panel */
async function addStep(insert, kind, name) {
  await domClick(T(insert))
  await waitFor(T('step-picker'))
  await click(T(`pick-${kind}`))
  await page.waitForSelector(T('step-picker'), { hidden: true, timeout: 10000 })
  await waitFor(T('step-name-input'))
  const el = await page.$(T('step-name-input'))
  await el.click()
  await el.evaluate((e) => e.select())
  await page.keyboard.type(name)
  await page.keyboard.press('Enter')
  await panelHas(name)
}
/** pick dynamic content inside an element (the field's own button) */
async function dynamic(within, insert) {
  await page.$eval(`${within} ${T('dynamic-content')}`, (e) => e.click())
  await waitFor(T('dynamic-list'))
  await click(`${T('dynamic-item')}[data-insert="${insert}"]`)
  await sleep(150)
}
async function tab(name) { await click(T(`panel-tab-${name}`)) }
/** run after: tick / untick a status of an earlier sibling (Advanced tab) */
async function runAfter(step, status, on) {
  const sel = T(`ra-${step}-${status}`)
  await waitFor(sel)
  const checked = await page.$eval(sel, (e) => e.checked)
  if (checked !== on) await click(sel)
  await sleep(100)
}
async function setDuration(within, days) {
  const sel = `${within} ${T('duration-days')}`
  await typeInto(sel, String(days))
}
async function approvalForm(title, approvers, timeoutDays) {
  const external = await page.$(T('approval-step-form'))
  if (external) {
    await typeInto(T('appr-title'), title)
    await typeInto(T('appr-approvers'), approvers)
    await typeInto('#appr-timeout', String(timeoutDays * 24))
  } else {
    await typeInto(T('approval-title'), title.replace(/^"|"$/g, ''))
    await click(`${T('approval-approvers')} ${T('people-formula')}`)
    await typeInto(T('approval-approvers-fx'), approvers)
    await tab('advanced')
    await setDuration(T('f-timeout'), timeoutDays)
    await tab('settings')
  }
}

/* ------------------------------------------------------------------ A. build by clicking */

async function buildByClicking(appId) {
  browser = await puppeteer.launch({ executablePath: E.CHROME_PATH || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--window-size=1600,1000'] })
  page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000 })
  page.on('dialog', (d) => d.accept())
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${BASE}/#home`, { waitUntil: 'networkidle0' })
  await typeInto('input[type=email]', ADMIN.email)
  await typeInto('input[type=password]', ADMIN.password)
  await page.keyboard.press('Enter')
  await page.waitForSelector('nav', { timeout: 20000 })
  await page.goto(`${BASE}/#flows`, { waitUntil: 'networkidle0' })
  await waitFor(T('flows-walkthrough'))
  record('the Flows page shows the empty-state walkthrough', true)
  await click(T('new-flow'))
  await waitFor(T('new-flow-gallery'))
  await click(T('blank-table'))
  await waitFor(T('flow-designer'), 20000)
  await page.waitForFunction(() => !document.querySelector('[data-testid="flow-designer"]')?.hasAttribute('data-readonly'), { timeout: 20000 })
  record('a blank flow opens in the designer, editable (the edit lock is ours)', true)
  const flowId = await page.evaluate(() => location.hash.replace('#flow-', ''))

  // name and settings
  await click(T('toolbar-settings'))
  await typeInto(T('flow-name'), 'Purchase approval')
  await select(T('settings-concurrency'), 'perRecord')
  // the trigger
  await domClick(T('trigger-card'))
  await waitFor(T('trigger-panel'))
  await select(T('trigger-table'), 'PurchaseRequests')
  check(await page.$eval(T('trigger-on-create'), (e) => e.checked), 'the trigger: rows added to PurchaseRequests')

  // 1. Mgr: the manager's approval, 2 days
  await addStep('insert-top-steps-0', 'approval', 'Mgr')
  await approvalForm('"Purchase: " & Trigger.Record.Title', 'Trigger.Record.Manager', 2)
  // 2. Esc: a scope that runs after Mgr timed out
  await addStep('insert-top-steps-1', 'scope', 'Esc')
  await tab('advanced')
  await runAfter('Mgr', 'timedOut', true)
  await runAfter('Mgr', 'succeeded', false)
  await tab('settings')
  //    inside: tell the director, mark the request escalated
  await addStep('insert-scope-steps-0', 'notify', 'EscNotify')
  await typeInto(T('notify-to-search'), 'dev@example.com')
  await page.keyboard.press('Enter')
  await typeInto(T('f-title'), 'Escalated: ')
  await dynamic(`[data-field="title"]`, 'Trigger.Record.Title')
  await typeInto(T('f-body'), 'The manager did not answer in 2 days.')
  await addStep('insert-scope-steps-1', 'data.update', 'EscStatus')
  await select(T('f-table'), 'PurchaseRequests')
  await select(T('add-field-select'), 'Status')
  await click(T('add-field'))
  await typeInto(T('map-value-Status'), 'Escalated')
  // 3. Decide: a condition built with the rules builder, after Esc succeeded or was skipped
  await addStep('insert-top-steps-2', 'condition', 'Decide')
  await click(`${T('condition-if')} ${T('add-rule')}`)
  await dynamic(`${T('condition-if')} ${T('rule')}`, 'Steps.Mgr.Status')
  await typeInto(`${T('condition-if')} ${T('rule-value')}`, '"timedOut"')
  await page.evaluate(() => [...document.querySelectorAll('[data-testid="condition-if"] button')].find((b) => b.textContent?.trim() === 'Group')?.click())
  await sleep(200)
  await select(`${T('condition-if')} ${T('join-select')}`, 'or')
  // the group: Mgr approved and the amount above 10000
  const groupRule = async (i) => (await page.$$(`${T('condition-if')} .border-dashed ${T('rule')}`))[i]
  await page.evaluate(() => document.querySelector('[data-testid="condition-if"] .border-dashed [data-testid="add-rule"]')?.click())
  await sleep(200)
  await page.$$eval(`${T('condition-if')} .border-dashed select[data-testid="join-select"]`, (els) => { const s = els[0]; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'and'); s.dispatchEvent(new Event('change', { bubbles: true })) })
  await sleep(200)
  for (const [i, left, value] of [[0, 'Steps.Mgr.Output.Outcome', '"Approve"'], [1, 'Trigger.Record.Amount', '10000']]) {
    const r = await groupRule(i)
    const l = await r.$(T('rule-left'))
    await l.click()
    await page.keyboard.type(left)
    await page.keyboard.press('Escape')
    if (i === 1) { const op = await r.$(T('rule-op')); await op.select('gt') }
    const v = await r.$(T('rule-value'))
    await v.click()
    await page.keyboard.type(value)
    await page.keyboard.press('Escape')
  }
  await tab('advanced')
  await runAfter('Esc', 'skipped', true)
  await tab('settings')
  //    if yes: the director's approval, 3 days
  await addStep('insert-condition-then-0', 'approval', 'Dir')
  await approvalForm('"Second approval: " & Trigger.Record.Title', '"dev@example.com"', 3)
  // 4. Final: the outcome
  await addStep('insert-top-steps-3', 'compose', 'Final')
  await typeInto(T('f-value'), 'If(Steps.Decide.Output.Result, Steps.Dir.Output.Outcome, Steps.Mgr.Output.Outcome)')
  // 5. SetStatus
  await addStep('insert-top-steps-4', 'data.update', 'SetStatus')
  await select(T('f-table'), 'PurchaseRequests')
  await select(T('add-field-select'), 'Status')
  await click(T('add-field'))
  await click(`${T('map-value-Status-field')} ${T('mode-formula')}`)
  await typeInto(T('map-value-Status'), 'If(Steps.Final.Output = "Approve", "Approved", "Rejected")')
  // 6. Tell the requester
  await addStep('insert-top-steps-5', 'notify', 'Tell')
  await click(`${T('notify-to')} ${T('people-formula')}`)
  await dynamic(T('notify-to'), 'Trigger.Record.Requester')
  await click(`${T('f-title-field')} ${T('mode-formula')}`)
  await typeInto(T('f-title'), '"Request " & Trigger.Record.Title & ": " & If(Steps.Final.Output = "Approve", "approved", "rejected")')

  // the draft is saved on the server; problems are none; publish
  await sleep(1500)
  await page.waitForFunction(() => document.querySelector('[data-testid="draft-state"]')?.getAttribute('data-state') === 'saved', { timeout: 20000 })
  const draft = await api('GET', `/flows/${flowId}/draft`)
  check(draft.draft && draft.draft.doc.steps.length === 6, 'the edits are kept as a draft on the server before publishing', `${draft.draft?.doc.steps.length} top-level steps in the draft`)
  await page.waitForFunction(() => document.querySelector('[data-testid="problem-count"]')?.textContent === 'No problems', { timeout: 20000 }).catch(() => undefined)
  const probs = await page.$eval(T('flow-problems'), (e) => e.innerText)
  check(/No problems/.test(probs), 'the server validator finds no problem in the flow built by clicking', probs.replace(/\s+/g, ' ').slice(0, 200))
  await shot('designer-built.png')
  await click(T('publish'))
  await page.waitForFunction(() => document.querySelector('[data-testid="draft-state"]')?.textContent === 'Published', { timeout: 20000 })
  check((await api('GET', `/flows/${flowId}/draft`)).draft === null, 'Publish makes the draft the running version (the draft is cleared)')
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Turn on')?.click())
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Turn off'), { timeout: 15000 })
  record('the flow is turned on', true)

  // a request through an app's form, in a second tab
  const appPage = await browser.newPage()
  await appPage.setViewport({ width: 1280, height: 800 })
  await appPage.goto(`${BASE}/#run-${appId}`, { waitUntil: 'networkidle0' })
  await appPage.waitForSelector('label', { timeout: 20000 })
  await sleep(1500)
  const fill = async (label, value) => {
    const id = await appPage.evaluate((l) => [...document.querySelectorAll('label')].find((x) => x.textContent?.trim().startsWith(l))?.getAttribute('for'), label)
    if (!id) throw new Error(`no field ${label}`)
    await appPage.click(`[id="${id}"]`)
    await appPage.type(`[id="${id}"]`, value)
  }
  await fill('Title', 'Chairs')
  await fill('Amount', '5000')
  await fill('Requester', 'rae@example.com')
  await fill('Manager', 'mona@example.com')
  await fill('Status', 'New')
  await appPage.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save')?.click())
  await sleep(500)
  await appPage.close()
  // the run on the canvas: pick it, the manager's step waits
  await page.bringToFront()
  let runId = null
  for (let i = 0; i < 60 && !runId; i++) { runId = (await api('GET', `/flows/runs?flowId=${flowId}&limit=5`)).items[0]?.id ?? null; if (!runId) await sleep(500) }
  check(runId, 'adding a row in the app started a run', runId)
  await page.$eval(T('run-picker'), (s) => s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
  await page.waitForFunction((id) => !!document.querySelector(`[data-testid="run-picker"] option[value="${id}"]`), { timeout: 15000 }, runId)
  await page.select(T('run-picker'), runId)
  await page.waitForFunction(() => document.querySelector('[data-testid="step-Mgr"]')?.getAttribute('data-status') === 'waiting', { timeout: 30000 })
  const overlay = await page.$eval(T('step-Mgr'), (e) => e.innerText.replace(/\s+/g, ' '))
  check(/waiting/.test(overlay), 'the run overlay on the canvas shows the manager approval waiting (live)', overlay)
  await shot('designer-run-overlay.png')
  check(!errors.length, 'no script errors in the page', errors.join(' | ').slice(0, 300))
  await browser.close()
  browser = null
  return { flowId, runId }
}

/* ------------------------------------------------------------------ B. the definition */

function compareDefinition(flow) {
  const s = flow.steps
  const byName = (n) => { let out = null; const v = (l) => { for (const x of l ?? []) { if (x.name === n) out = x; v(x.steps); v(x.then); v(x.else) } }; v(s); return out }
  const shape = s.map((x) => `${x.name}:${x.kind}`).join(',')
  check(shape === 'Mgr:approval,Esc:scope,Decide:condition,Final:compose,SetStatus:data.update,Tell:notify', 'the top-level steps match the exit-check-1 flow', shape)
  check(JSON.stringify(byName('Esc').runAfter) === JSON.stringify([{ step: byName('Mgr').id, when: ['timedOut'] }]), 'Esc runs after Mgr timed out', JSON.stringify(byName('Esc').runAfter))
  check(JSON.stringify(byName('Decide').runAfter?.[0]?.when) === JSON.stringify(['succeeded', 'skipped']), 'Decide runs after Esc succeeded or was skipped', JSON.stringify(byName('Decide').runAfter))
  check(byName('Esc').steps.map((x) => x.name).join(',') === 'EscNotify,EscStatus' && byName('Decide').then.map((x) => x.name).join(',') === 'Dir', 'the escalation scope and the second approval are nested as in exit check 1')
  check(byName('Decide').if === 'Steps.Mgr.Status = "timedOut" || (Steps.Mgr.Output.Outcome = "Approve" && Trigger.Record.Amount > 10000)', 'the condition built with the rules builder is the exit-check-1 condition', byName('Decide').if)
  check(byName('Mgr').timeoutMinutes === 2880 && byName('Dir').timeoutMinutes === 4320, 'time limits 2 and 3 days')
  check(flow.settings.concurrency === 'perRecord' && flow.trigger.type === 'table' && flow.trigger.table === 'PurchaseRequests', 'one run per record; table trigger on PurchaseRequests')
}

/* ------------------------------------------------------------------ C. the simulated week */

async function simulatedWeek(flowId, firstRow) {
  const fl = () => app.services.flows
  const inEnv = (fn) => runInEnvironment('default', fn)
  const drain = async () => {
    for (let i = 0; i < 10; i++) {
      await app.services.kernel.drain({ timeoutMs: 120_000 })
      const n = await inEnv(() => fl().sweep(true))
      if (!n) break
    }
  }
  const ctxOf = (email) => inEnv(async () => app.services.security.forUser(await app.services.meta.users.byEmail(email)))
  const insert = (values) => inEnv(async () => {
    const t = (await app.services.meta.tables.list()).find((x) => x.name === 'PurchaseRequests')
    return app.services.data.insert(await ctxOf(ADMIN.email), t, values)
  })
  /** the approval waits of a request's run: step name -> wait */
  const waitsOf = async (rowId) => q(
    `SELECT w.id, w.approval_id, w.state, s.name FROM env_default.ab_flow_waits w JOIN env_default.ab_flow_runs r ON r.id = w.run_id
       JOIN env_default.ab_flow_steps s ON s.run_id = w.run_id AND s.step_key = w.step_key WHERE r.flow_id = $1 AND r.regarding_id = $2 AND w.kind = 'approval'`, [flowId, rowId])
  const answer = async (rowId, step, who, outcome) => {
    const w = (await waitsOf(rowId)).filter((x) => x.name === step && x.state === 'waiting')
    check(w.length === 1, `${step} of ${rowId.slice(0, 8)} waits for ${who}`, `${w.length} waiting`)
    if (!usingStub && app.services.approvals?.respond) {
      const ctx = await ctxOf(who)
      await inEnv(() => app.services.approvals.respond(ctx, w[0].approval_id, outcome, null))
    } else {
      const r = await fl().resumeWait('default', w[0].id, { kind: 'approval', outcome, responses: [{ userId: who, response: outcome, at: now.toISOString() }] })
      check(r.resumed, `${step} resumed once`)
    }
  }
  const r1 = firstRow
  const r2 = String((await insert({ Title: 'Server', Amount: 50000, Requester: 'rae@example.com', Manager: 'mona@example.com', Status: 'New' })).id)
  const r3 = String((await insert({ Title: 'Laptops', Amount: 20000, Requester: 'rae@example.com', Manager: 'mona@example.com', Status: 'New' })).id)
  const r4 = String((await insert({ Title: 'Coffee', Amount: 3000, Requester: 'rae@example.com', Manager: 'mona@example.com', Status: 'New' })).id)
  await drain()
  const asked = (await q(`SELECT count(*)::int AS n FROM env_default.ab_flow_waits w JOIN env_default.ab_flow_runs r ON r.id = w.run_id WHERE r.flow_id = $1 AND w.kind = 'approval'`, [flowId]))[0].n
  check(asked === 4, 'four requests: four manager approvals asked', `${asked}`)
  // day 0, two hours later: the manager answers three
  now = new Date(now.getTime() + 2 * 3600_000)
  await answer(r1, 'Mgr', 'mona@example.com', 'Approve')
  await answer(r2, 'Mgr', 'mona@example.com', 'Approve')
  await answer(r4, 'Mgr', 'mona@example.com', 'Reject')
  // restart 1 before the resume jobs ran
  await restart(false)
  now = new Date(now.getTime() + 24 * 3600_000)
  await drain()
  // day 2, 10:00: Laptops escalates
  now = new Date('2030-03-06T10:00:00Z')
  await drain()
  check((await waitsOf(r2)).some((w) => w.name === 'Dir') && (await waitsOf(r3)).some((w) => w.name === 'Dir'), 'the director is asked for Server (above 10000) and Laptops (escalated)')
  // day 3: the director approves the server
  now = new Date('2030-03-07T11:00:00Z')
  await answer(r2, 'Dir', 'dev@example.com', 'Approve')
  await drain()
  // restart 2
  await restart(false)
  // day 4: the director rejects the laptops
  now = new Date('2030-03-08T15:00:00Z')
  await answer(r3, 'Dir', 'dev@example.com', 'Reject')
  await drain()
  now = new Date('2030-03-11T09:00:00Z')
  await drain()
  const runs = await q('SELECT id, state, regarding_id FROM env_default.ab_flow_runs WHERE flow_id = $1 AND mode = $2', [flowId, 'normal'])
  check(runs.length === 4 && runs.every((x) => x.state === 'succeeded'), 'four runs, each succeeded once', JSON.stringify(runs.map((x) => x.state)))
  const status = Object.fromEntries((await q('SELECT id, "Status" FROM env_default.t_purchaserequests')).map((x) => [x.id, x.Status]))
  check(status[r1] === 'Approved' && status[r2] === 'Approved' && status[r3] === 'Rejected' && status[r4] === 'Rejected', 'statuses: Chairs and Server approved, Laptops and Coffee rejected', JSON.stringify(Object.values(status)))
  const total = (await q(`SELECT count(*)::int AS n FROM env_default.ab_flow_waits w JOIN env_default.ab_flow_runs r ON r.id = w.run_id WHERE r.flow_id = $1 AND w.kind = 'approval'`, [flowId]))[0].n
  check(total === 6, 'exactly six approvals asked (4 manager, 2 director)', `${total}`)
  const esc = (await q(`SELECT title FROM ab.notifications WHERE title LIKE 'Escalated:%'`)).map((x) => x.title)
  check(JSON.stringify(esc) === JSON.stringify(['Escalated: Laptops']), 'one escalation message', JSON.stringify(esc))
  const told = (await q(`SELECT title FROM ab.notifications WHERE title LIKE 'Request %' ORDER BY title`)).map((x) => x.title)
  check(JSON.stringify(told) === JSON.stringify(['Request Chairs: approved', 'Request Coffee: rejected', 'Request Laptops: rejected', 'Request Server: approved']), 'the requester is told once per request', JSON.stringify(told))
  const changes = Object.fromEntries((await q(`SELECT row_id, count(*)::int AS n FROM env_default.ab_outbox o JOIN env_default.ab_tables t ON t.id = o.table_id WHERE t.name = 'PurchaseRequests' AND o.op = 'update' GROUP BY row_id`)).map((x) => [x.row_id, x.n]))
  check(changes[r1] === 1 && changes[r2] === 1 && changes[r3] === 2 && changes[r4] === 1, 'every data change once (Laptops: escalated, then rejected)', JSON.stringify(changes))
  const s3 = await q(`SELECT s.name, s.state FROM env_default.ab_flow_steps s WHERE s.run_id = (SELECT id FROM env_default.ab_flow_runs WHERE regarding_id = $1 AND flow_id = $2) AND s.kind <> 'iteration' ORDER BY s.ord`, [r3, flowId])
  check(s3.map((x) => `${x.name}=${x.state}`).join(',') === 'Mgr=timedOut,Esc=succeeded,EscNotify=succeeded,EscStatus=succeeded,Decide=succeeded,Dir=succeeded,Final=succeeded,SetStatus=succeeded,Tell=succeeded', 'Laptops: each step ran once, the manager step timed out', s3.map((x) => `${x.name}=${x.state}`).join(','))
}

/* ------------------------------------------------------------------ D. performance */

async function performance() {
  const steps = []
  for (let i = 0; i < 30; i++) {
    steps.push({ id: `c${i}`, name: `Calc${i}`, kind: 'compose', value: `${i} * 2` })
    steps.push({ id: `k${i}`, name: `Check${i}`, kind: 'condition', if: `Steps.Calc${i}.Output > 10`, then: [{ id: `n${i}`, name: `Note${i}`, kind: 'compose', value: `"big ${i}"` }], else: [{ id: `m${i}`, name: `Small${i}`, kind: 'compose', value: `"small ${i}"` }] })
    steps.push({ id: `s${i}`, name: `Group${i}`, kind: 'scope', steps: [{ id: `g${i}`, name: `Inner${i}`, kind: 'compose', value: '1' }] })
  }
  const flow = (await api('POST', '/flows', { name: 'Big flow', runAs: 'owner', trigger: { type: 'manual', inputs: [], from: 'any' }, settings: { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' }, steps })).flow
  let count = 0
  const v = (l) => { for (const x of l ?? []) { count++; v(x.steps); v(x.then); v(x.else) } }
  v(flow.steps)
  browser = await puppeteer.launch({ executablePath: E.CHROME_PATH || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--window-size=1600,1000'] })
  page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000 })
  await page.goto(`${BASE}/#home`, { waitUntil: 'networkidle0' })
  await typeInto('input[type=email]', ADMIN.email)
  await typeInto('input[type=password]', ADMIN.password)
  await page.keyboard.press('Enter')
  await page.waitForSelector('nav', { timeout: 20000 })
  const a = Date.now()
  await page.goto(`${BASE}/#flow-${flow.id}`)
  await page.waitForFunction((n) => Number(document.querySelector('[data-testid="flow-canvas"]')?.getAttribute('data-steps')) === n, { timeout: 30000 }, count)
  const open = Date.now() - a
  // one edit round trip: select a step (keyboard), rename it in the panel, the canvas shows the new name
  const timeIt = async (fn) => { const s = await page.evaluate(() => performance.now()); await fn(); return Math.round((await page.evaluate(() => performance.now())) - s) }
  await page.focus(T('flow-canvas'))
  const nav = await timeIt(async () => { for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowDown') })
  const sel = await timeIt(async () => { await page.keyboard.press('Enter'); await waitFor(T('step-panel')) })
  const add = await timeIt(async () => {
    await domClick(T('insert-top-steps-0'))
    await click(T('pick-compose'))
    await page.waitForFunction((n) => Number(document.querySelector('[data-testid="flow-canvas"]')?.getAttribute('data-steps')) === n + 1, { timeout: 10000 }, count)
  })
  const undo = await timeIt(async () => {
    await page.focus(T('flow-canvas'))
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    await page.waitForFunction((n) => Number(document.querySelector('[data-testid="flow-canvas"]')?.getAttribute('data-steps')) === n, { timeout: 10000 }, count)
  })
  await shot('designer-150-steps.png')
  await browser.close()
  browser = null
  const report = { steps: count, openMs: open, arrowDown20Ms: nav, openStepPanelMs: sel, addStepMs: add, undoMs: undo }
  record(`performance with a ${count}-step flow`, count >= 150 && add < 1500 && undo < 1500, JSON.stringify(report))
  return report
}

/* ------------------------------------------------------------------ main */

let failed = false
try {
  await maint(`DROP DATABASE IF EXISTS "${DB.database}"`)
  await start(true)
  const setupCode = app.services.setupCode.current() ?? ''
  await api('POST', '/setup/database', { setupCode, host: DB.host, port: DB.port, database: DB.database, user: DB.user, password: DB.password, createDatabase: true })
  await api('POST', '/setup/admin', { setupCode, ...ADMIN })
  await login()
  wire(app)
  log(`approvals: ${usingStub ? 'the stub (package C is not registered)' : 'package C\'s service'}`)
  await api('POST', '/tables', { displayName: 'Purchase requests', name: 'PurchaseRequests', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Amount', type: 'number' }, { displayName: 'Requester', type: 'text' }, { displayName: 'Manager', type: 'text' }, { displayName: 'Status', type: 'text' }] })
  for (const [name, email] of [['Mona Manager', 'mona@example.com'], ['Dev Director', 'dev@example.com'], ['Rae Requester', 'rae@example.com']]) await api('POST', '/users', { name, email, roleIds: ['role_maker'], password: 'some-password-1' })
  const created = await api('POST', '/apps', { name: 'Requests', width: 1280, height: 800 })
  const full = await api('GET', `/apps/${created.id}`)
  const def = full.definition
  def.dataSources = ['PurchaseRequests']
  def.screens[0].children.push({ id: 'n_form1', name: 'ReqForm', type: 'Form', props: { X: '=80', Y: '=40', Width: '=900', Height: '=560', DataSource: '="PurchaseRequests"', Mode: '=FormMode.New', Fields: '="Title,Amount,Requester,Manager,Status"', OnSuccess: '=NewForm(ReqForm)' }, children: [] })
  await api('PUT', `/apps/${created.id}`, { definition: def })

  log('A. building the purchase approval flow by clicking')
  const { flowId } = await buildByClicking(created.id)
  log('B. the definition')
  const saved = (await api('GET', `/flows/${flowId}`)).flow
  compareDefinition(saved)
  const firstRow = String((await q(`SELECT id FROM env_default.t_purchaserequests WHERE "Title" = 'Chairs'`))[0].id)
  log('C. the simulated week (flow clock), two restarts')
  await restart(false)
  await simulatedWeek(flowId, firstRow)
  log('D. performance')
  await restart(true)
  await login()
  await performance()
} catch (e) {
  failed = true
  console.error(e)
  if (page && SHOTS) await shot('failure.png').catch(() => undefined)
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stop().catch(() => undefined)
  if (!E.KEEP) await maint(`DROP DATABASE IF EXISTS "${DB.database}"`).catch((e) => console.error(`could not drop ${DB.database}: ${e.message}`))
  fs.rmSync(DIR, { recursive: true, force: true })
}
async function login() { cookie = ''; await api('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password }) }
const bad = results.filter((r) => !r.ok)
console.log(`\n${results.length - bad.length}/${results.length} checks passed${failed || bad.length ? ' - EXIT CHECK 2 FAILED' : ' - EXIT CHECK 2 PASSED'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
process.exit(failed || bad.length ? 1 : 0)
