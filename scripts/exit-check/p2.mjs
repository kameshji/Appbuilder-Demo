#!/usr/bin/env node
/**
 * Phase 2 exit check (docs/plan/p2-spec.md "Exit check", the seven checks), all in one run. DEVELOPER TOOL (sandbox values
 * only), not part of the product.
 *
 *   npm run build                                  (the server serves dist/; the browser checks need it)
 *   node scripts/exit-check/p2.mjs                 everything, in order, one after the other
 *   EXIT_SKIP=dashboard,phone node scripts/exit-check/p2.mjs
 *   EXIT_ONLY=whatsapp,docs node scripts/exit-check/p2.mjs
 *
 * Every check is an existing script that creates and drops its own database; this script starts them as child processes
 * (never in parallel: the timings are part of the evidence), saves each one's output, and prints one Markdown table:
 *
 *   1  phone                p2-phone.mjs                Android phone emulation, fake camera, barcode/QR, offline outbox
 *   2  PDF                  p2-pdf.mjs                  daily OEE PDF by email from a print template; print a record's report
 *   3  dashboard            p2-dashboard.mjs            1,000,000 rows, a restricted user, under two seconds. This script starts the
 *                                                       server it needs (own database, free port) and stops it afterwards. Supporting
 *                                                       evidence: p2-tile-editor.mjs (against that server too), p2-dashboard-layout.mjs,
 *                                                       p2-dashboard-screens.mjs
 *   4  auto apps            p2-autoapp.mjs
 *   5  templates            p2-templates.mjs
 *   6  WhatsApp             p2-whatsapp.mjs             against the recorded mock of the provider API, never Meta
 *   7  docs and regression  p0.mjs, p1.mjs, the docs link / naming / staleness tests, and the existence of
 *                           docs/internal/security-review-p2.md (PENDING while the file is absent)
 *
 * Settings (all optional):
 *   EXIT_DB_HOST, EXIT_DB_PORT, EXIT_DB_USER, EXIT_DB_PASSWORD, EXIT_MAINT_DB: the sandbox PostgreSQL. Default: the parts of
 *       APPBUILDER_TEST_DB when that is set (dot-source .sandbox/env.ps1), else 127.0.0.1:5433, abdev / abdev-sandbox-only,
 *       appbuilder_test. The role needs CREATEDB.
 *   PUPPETEER_CORE, CHROME_PATH: puppeteer-core and Chrome (scripts/exit-check/browser-env.mjs looks in the usual places).
 *   OUT: the folder for the children's output (<name>.log), their screenshots and files (<name>/), summary.md and
 *       results.json. Default: <temp>/ab-p2-exit.
 *   EXIT_SKIP: comma list of steps to skip (they show as SKIP, never as PASS): phone, pdf, dashboard, tile-editor,
 *       dashboard-layout, dashboard-screens, autoapp, templates, whatsapp, p0, p1, docs; or check1..check7; or the parts
 *       p0-browser, p0-drill, p1-browser, p1-designer, p1-suites, dashboard-browser. EXIT_ONLY: run only these (same names).
 *   EXIT_ROWS: rows of the big tables (1000000) in p2-dashboard and p0. EXIT_PORT_FROM (5270): first of the ports tried
 *       (5270..5289 are used; each step takes the first free one, p0 and p1 two in a row). EXIT_STEP_TIMEOUT_MIN (40).
 *   EXIT_RETRY=1: a failed script is run once more and, when it then passes, the evidence says it passed only on the second attempt
 *       (default off: a flaky check should be seen, not hidden).
 *   KEEP=1 keeps the databases (not recommended: a million rows take about 1 GB).
 *
 * Exit code: 1 when anything FAILS, 3 when nothing failed but something is PENDING (the security review is not written
 * yet), 0 otherwise (skipped steps are printed as SKIP). Sandbox values only; never run against real data.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { chromePath, puppeteerCorePath } from './browser-env.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const fromUrl = (() => { try { return E.APPBUILDER_TEST_DB ? new URL(E.APPBUILDER_TEST_DB) : null } catch { return null } })()
const DB = {
  host: E.EXIT_DB_HOST || fromUrl?.hostname || '127.0.0.1',
  port: Number(E.EXIT_DB_PORT || fromUrl?.port || 5433),
  user: E.EXIT_DB_USER || (fromUrl ? decodeURIComponent(fromUrl.username) : '') || 'abdev',
  password: E.EXIT_DB_PASSWORD || (fromUrl ? decodeURIComponent(fromUrl.password) : '') || 'abdev-sandbox-only',
}
const MAINT = E.EXIT_MAINT_DB || (fromUrl ? fromUrl.pathname.replace(/^\//, '') : '') || 'appbuilder_test'
const ROWS = String(Number(E.EXIT_ROWS || 1_000_000))
const OUT = path.resolve(E.OUT || path.join(os.tmpdir(), 'ab-p2-exit'))
const SKIP = new Set((E.EXIT_SKIP || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
const ONLY = new Set((E.EXIT_ONLY || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
const KEEP = E.KEEP === '1'
const PORT_FROM = Number(E.EXIT_PORT_FROM || 5270)
const PORT_TO = PORT_FROM + 19
const RETRY = E.EXIT_RETRY === '1'
const STEP_TIMEOUT = Number(E.EXIT_STEP_TIMEOUT_MIN || 40) * 60_000
const VITEST = path.join(root, 'node_modules', 'vitest', 'vitest.mjs')
const CHROME = chromePath(E)
const PUPPETEER = puppeteerCorePath(root, E)
const t0 = Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)} s] ${m}`)
// eslint-disable-next-line no-control-regex
const plain = (s) => s.replace(/\u001b\[[0-9;]*m/g, '').replace(/\r/g, '')
const fmt = (n) => Number(n).toLocaleString('en-US')

fs.mkdirSync(OUT, { recursive: true })
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) { console.error('Build the app first (npm run build): the server serves dist/.'); process.exit(2) }
if (!fs.existsSync(path.join(PUPPETEER, 'lib', 'puppeteer', 'puppeteer-core.js'))) log(`warning: puppeteer-core not found at ${PUPPETEER} (set PUPPETEER_CORE); the browser checks will fail`)
if (!fs.existsSync(CHROME)) log(`warning: Chrome not found at ${CHROME} (set CHROME_PATH); the browser checks will fail`)

/* ------------------------------------------------------------------ helpers */

async function maint(sql) {
  const c = new pg.Client({ ...DB, database: MAINT })
  await c.connect()
  try { return (await c.query(sql)).rows } finally { await c.end() }
}
/** drops a database; a server we just stopped may still hold a connection for a moment, so a refusal is retried */
async function dropDb(name) {
  if (KEEP) return
  let last = null
  for (let i = 0; i < 12; i++) {
    try { await maint(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); return } catch (e) { last = e; await sleep(1000) }
  }
  log(`could not drop ${name}: ${last?.message}`)
}
async function dbSize(name) {
  try { return Number((await maint(`SELECT pg_database_size('${name}') AS n`))[0].n) } catch { return null }
}
const mb = (n) => (n == null ? '?' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${Math.round(n / 1024 ** 2)} MB`)

const isFree = (port) => new Promise((resolve) => {
  const s = net.createServer()
  s.once('error', () => resolve(false))
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
})
/** the first free port (and the next ones, for scripts that use PORT, PORT + 1) in the range; never 5174 or 5433 */
async function freePort(count = 1) {
  for (let p = PORT_FROM; p + count - 1 <= PORT_TO; p++) {
    let ok = true
    for (let i = 0; i < count && ok; i++) ok = (await isFree(p + i)) && ![5174, 5433].includes(p + i)
    if (ok) return p
  }
  throw new Error(`no free port in ${PORT_FROM}..${PORT_TO}`)
}

/** stops a process tree we started (and nothing else) */
function killTree(child) {
  if (!child || child.exitCode !== null || child.pid == null) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
  } catch { /* already gone */ }
}
const children = new Set()
function cleanupAll() { for (const c of children) killTree(c) }
process.on('exit', cleanupAll)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanupAll(); process.exit(130) })

/** runs a script (or vitest) as a child; its output goes to OUT/<name>.log as it arrives; resolves { code, text, seconds, timedOut } */
function runChild(name, args, env = {}, { timeoutMs = STEP_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    const file = path.join(OUT, `${name}.log`)
    const out = fs.createWriteStream(file)
    let text = ''
    const s0 = Date.now()
    const child = spawn(process.execPath, args, { cwd: root, env: { ...E, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true })
    children.add(child)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; killTree(child) }, timeoutMs)
    const take = (d) => { text += d; out.write(d) }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', (e) => take(`\n[spawn error] ${e.message}\n`))
    child.on('close', (code) => {
      clearTimeout(timer)
      children.delete(child)
      out.end()
      resolve({ code: code ?? 1, text: plain(text), seconds: (Date.now() - s0) / 1000, timedOut, file })
    })
  })
}

const common = () => ({
  EXIT_DB_HOST: DB.host, EXIT_DB_PORT: String(DB.port), EXIT_DB_USER: DB.user, EXIT_DB_PASSWORD: DB.password, EXIT_MAINT_DB: MAINT,
  PUPPETEER_CORE: PUPPETEER, CHROME_PATH: CHROME, KEEP: KEEP ? '1' : '',
})
const folder = (name) => { const d = path.join(OUT, name); fs.mkdirSync(d, { recursive: true }); return d }
const workspace = (name) => { const d = path.join(OUT, `ws-${name}`, 'workspace'); fs.rmSync(path.dirname(d), { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d }
const lines = (text) => text.split('\n')
const lastLine = (text, re) => [...lines(text)].reverse().find((l) => re.test(l)) ?? ''
const failLines = (text) => lines(text).filter((l) => /^(\[[^\]]*\]\s*)?(FAIL|not ok)|CHECK FAILED|DRILL FAILED|FAILED/.test(l.trim())).map((l) => l.trim().slice(0, 200))
const tail = (text, n = 3) => lines(text).filter((l) => l.trim()).slice(-n).map((l) => l.trim().slice(0, 200)).join(' | ')

/* ------------------------------------------------------------------ the steps */

/** step results: { id, check, name, state: 'PASS' | 'FAIL' | 'SKIP', counts, seconds, evidence, log } */
const steps = []
const wanted = (id, check) => {
  if (ONLY.size) return ONLY.has(id) || ONLY.has(`check${check}`)
  return !(SKIP.has(id) || SKIP.has(`check${check}`))
}
function finish(r) {
  steps.push(r)
  if (!r.quiet) log(`${r.state} (${r.check}) ${r.id}: ${r.evidence}`)
  return r
}
const skipped = (id, check, name) => finish({ quiet: true, id, check, name, state: 'SKIP', counts: null, seconds: 0, evidence: 'skipped by EXIT_SKIP / EXIT_ONLY', log: null })

/** a script that prints "N/M checks passed" or "N passed, M failed" or "ok - ..." lines */
function countsOf(text) {
  let m = /(\d+)\/(\d+) checks passed/.exec(text)
  if (m) return { pass: Number(m[1]), fail: Number(m[2]) - Number(m[1]) }
  m = /(\d+) passed, (\d+) failed/.exec(text)
  if (m) return { pass: Number(m[1]), fail: Number(m[2]) }
  const ok = (text.match(/^ok - /gm) ?? []).length
  return { pass: ok, fail: 0 }
}

async function script(id, check, name, file, { env = {}, db = null, ports = 1, highlight = [], extra = null } = {}) {
  if (!wanted(id, check)) return skipped(id, check, name)
  log(`start ${id} (${file})`)
  const port = await freePort(ports)
  const e = { ...common(), EXIT_PORT: String(port), SHOTS: folder(id), OUT: folder(id), EXIT_WORKSPACE: workspace(id), ...(db ? { EXIT_DB_NAME: db } : {}), ...env }
  let r = await runChild(id, [path.join('scripts', 'exit-check', file)], e)
  let retried = ''
  // EXIT_RETRY=1: one more attempt of a failed script, and the report says so (a flaky check is not a clean pass)
  if (RETRY && !(r.code === 0 && countsOf(r.text).fail === 0 && !r.timedOut)) {
    const why = failLines(r.text)[0] || tail(r.text, 1)
    log(`${id} failed (${why.slice(0, 120)}); trying once more (EXIT_RETRY=1)`)
    if (db) await dropDb(db)
    r = await runChild(`${id}-retry`, [path.join('scripts', 'exit-check', file)], e)
    retried = ` (passed only on the second attempt; the first failed with: ${why.slice(0, 160)})`
  }
  const counts = countsOf(r.text)
  const fails = failLines(r.text)
  const ok = r.code === 0 && counts.fail === 0 && !r.timedOut
  if (ok && retried) { /* kept in the evidence below */ }
  let evidence = `${counts.pass} checks passed${counts.fail ? `, ${counts.fail} failed` : ''} in ${r.seconds.toFixed(0)} s`
  if (extra) evidence += `; ${extra(r.text)}`
  const hl = highlight.map((re) => { const l = lines(r.text).find((x) => re.test(x)); return l ? l.replace(/^ok - |^PASS\s+|^\[[^\]]*\]\s*PASS\s*/, '').trim().slice(0, 170) : null }).filter(Boolean)
  if (hl.length) evidence += `; ${hl.join('; ')}`
  if (ok) evidence += retried
  if (!ok) evidence += `; ${r.timedOut ? `TIMED OUT after ${Math.round(STEP_TIMEOUT / 60000)} min; ` : `exit code ${r.code}; `}${fails.slice(0, 3).join(' / ') || tail(r.text)}`
  if (db) await dropDb(db)
  return finish({ id, check, name, state: ok ? 'PASS' : 'FAIL', counts, seconds: r.seconds, evidence, log: r.file })
}

/* the server of check 3: its own database, a free port, stopped in every case */
async function withDashboardServer(fn) {
  const dbName = 'appbuilder_exit_p2dash'
  const port = await freePort(1)
  const ws = workspace('p2dash')
  await dropDb(dbName)
  await maint(`CREATE DATABASE "${dbName}" ENCODING 'UTF8' TEMPLATE template0`)
  let out = ''
  const server = spawn(process.execPath, ['server/main.ts'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
    env: { ...E, APPBUILDER_DB_HOST: DB.host, APPBUILDER_DB_PORT: String(DB.port), APPBUILDER_DB_NAME: dbName, APPBUILDER_DB_USER: DB.user, APPBUILDER_DB_PASSWORD: DB.password, APPBUILDER_WORKSPACE: ws, PORT: String(port), APPBUILDER_HOST: '127.0.0.1', APPBUILDER_MIGRATION_BACKUP: 'skip' },
  })
  children.add(server)
  server.stdout.on('data', (d) => { out += d })
  server.stderr.on('data', (d) => { out += d })
  try {
    for (let i = 0; i < 480 && !/is running at/.test(out); i++) {
      if (server.exitCode !== null) throw new Error(`the server stopped:\n${out.slice(-600)}`)
      await sleep(250)
    }
    if (!/is running at/.test(out)) throw new Error(`the server did not start:\n${out.slice(-600)}`)
    const setupCode = (/SETUP CODE:\s+([A-Z0-9-]+)/.exec(out)?.[1] ?? '').replace(/-/g, '')
    return await fn({ base: `http://127.0.0.1:${port}`, dbName, setupCode })
  } finally {
    killTree(server)
    children.delete(server)
    fs.writeFileSync(path.join(OUT, 'p2dash-server.log'), plain(out))
    await sleep(500)
  }
}

async function checkDashboard() {
  const dash = wanted('dashboard', 3)
  const tile = wanted('tile-editor', 3)
  if (!dash) skipped('dashboard', 3, 'dashboard timing')
  if (!tile) skipped('tile-editor', 3, 'tile editor')
  if (dash || tile) {
    try {
      await withDashboardServer(async ({ base, dbName, setupCode }) => {
        if (dash) {
          log('start dashboard (p2-dashboard.mjs): loading the tables takes minutes')
          const pgUrl = `postgres://${encodeURIComponent(DB.user)}:${encodeURIComponent(DB.password)}@${DB.host}:${DB.port}/${dbName}`
          const r = await runChild('dashboard', ['scripts/exit-check/p2-dashboard.mjs'], { ...common(), BASE: base, PG_URL: pgUrl, SETUP_CODE: setupCode, ROWS, OUT: folder('dashboard'), SHOTS: folder('dashboard'), ...(SKIP.has('dashboard-browser') ? { BROWSER: '0' } : {}) })
          const med = (label) => { const m = new RegExp(`\\|\\s*${label}[^|]*\\|\\s*(\\d+)\\s*\\|\\s*(\\d+)\\s*\\|`).exec(r.text); return m ? { median: Number(m[1]), max: Number(m[2]) } : null }
          const cold = med('Batch endpoint, cold')
          const warm = med('Batch endpoint, cached')
          const brow = med('Browser: full page load')
          const rowsLine = /ProductionLog has ([\d,]+) rows/.exec(r.text)?.[1]
          const own = /equals SQL over the supervisor's own ([\d,]+) rows/.exec(r.text)?.[1]
          const tiles = /has (\d+) tiles/.exec(r.text)?.[1]
          const verdict = lastLine(r.text, /^(PASS|FAIL): under 2 s/)
          const ok = r.code === 0 && /^PASS: under 2 s/.test(verdict) && !r.timedOut
          const size = await dbSize(dbName)
          let ev = `${rowsLine ?? '?'} production rows (database ${mb(size)}), restricted user with ${own ?? '?'} own rows this month, ${tiles ?? '?'} tiles`
          ev += cold ? `; one batch for the whole dashboard, cold: median ${cold.median} ms, max ${cold.max} ms` : ''
          ev += warm ? `; cached: median ${warm.median} ms` : ''
          ev += brow ? `; browser, full page load until every tile is drawn: median ${brow.median} ms, max ${brow.max} ms` : (SKIP.has('dashboard-browser') ? '; browser part skipped' : '')
          ev += `; ${verdict.replace(/^(PASS|FAIL): /, '')}`
          const checks = (r.text.match(/^ok - /gm) ?? []).length
          if (!ok) ev += `; ${r.timedOut ? 'TIMED OUT' : `exit code ${r.code}`}: ${failLines(r.text).slice(0, 2).join(' / ') || tail(r.text)}`
          finish({ id: 'dashboard', check: 3, name: 'dashboard timing on 1,000,000 rows for a restricted user', state: ok ? 'PASS' : 'FAIL', counts: { pass: checks, fail: ok ? 0 : 1 }, seconds: r.seconds, evidence: ev, log: r.file, timings: { cold, warm, brow } })
        }
        if (tile) {
          log('start tile-editor (p2-tile-editor.mjs, demo part and against the same server)')
          const r = await runChild('tile-editor', ['scripts/exit-check/p2-tile-editor.mjs'], { ...common(), BASE: base, ADMIN_EMAIL: 'admin@example.test', ADMIN_PASSWORD: 'Example-Only-Pass-2026', OUT: folder('tile-editor'), HTML: path.join(root, 'dist', 'index.html') })
          const c = countsOf(r.text)
          const ok = r.code === 0 && !r.timedOut && c.pass > 0
          finish({ id: 'tile-editor', check: 3, name: 'visual tile editor (demo mode and against a server)', state: ok ? 'PASS' : 'FAIL', counts: c, seconds: r.seconds, evidence: `${c.pass} checks passed in ${r.seconds.toFixed(0)} s (demo mode from file://, then the same add-tile flow against the server)${ok ? '' : `; exit code ${r.code}: ${failLines(r.text).slice(0, 2).join(' / ') || tail(r.text)}`}`, log: r.file })
        }
      })
    } catch (e) {
      for (const id of ['dashboard', 'tile-editor']) if (wanted(id, 3) && !steps.some((s) => s.id === id)) finish({ id, check: 3, name: id, state: 'FAIL', counts: { pass: 0, fail: 1 }, seconds: 0, evidence: `could not run: ${String(e.message).slice(0, 300)}`, log: null })
    } finally {
      await dropDb('appbuilder_exit_p2dash')
    }
  }
  if (wanted('dashboard-layout', 3)) {
    log('start dashboard-layout (demo mode)')
    const r = await runChild('dashboard-layout', ['scripts/exit-check/p2-dashboard-layout.mjs'], { ...common(), OUT: folder('dashboard-layout'), HTML: path.join(root, 'dist', 'index.html') })
    const c = countsOf(r.text)
    const ok = r.code === 0 && !r.timedOut && c.pass > 0
    finish({ id: 'dashboard-layout', check: 3, name: 'dashboard layout, viewer roles, settings, drill-through', state: ok ? 'PASS' : 'FAIL', counts: c, seconds: r.seconds, evidence: `${c.pass} checks passed in ${r.seconds.toFixed(0)} s (demo mode from file://: drag and resize by mouse and touch, widths, viewer roles, settings, drill-through)${ok ? '' : `; exit code ${r.code}: ${failLines(r.text).slice(0, 2).join(' / ') || tail(r.text)}`}`, log: r.file })
  } else skipped('dashboard-layout', 3, 'dashboard layout')
  await script('dashboard-screens', 3, 'dashboard screens against a server: view tokens, kiosk, snapshots, pins', 'p2-dashboard-screens.mjs', { db: 'appbuilder_exit_screens', highlight: [/kiosk: the server received the kiosk requests with no Cookie/, /kiosk: after revoke/, /"Send now": the mail arrives/, /snapshots: Otto/, /pins: unpin/] })
}

async function checkRegression() {
  // p0 and p1: their own tables; their failed rows are listed
  const tableRows = (text) => lines(text).filter((l) => /^\| (\d+|[a-z]) \|/.test(l)).map((l) => l.split('|').map((x) => x.trim())).map((c) => ({ n: c[1], name: c[2], result: c[3], evidence: c.slice(4, -1).join(' | ') }))
  const ps = { p0: [], p1: [] }
  for (const [id, file, parts] of [['p0', 'p0.mjs', { browser: 'p0-browser', drill: 'p0-drill' }], ['p1', 'p1.mjs', { browser: 'p1-browser', designer: 'p1-designer', suites: 'p1-suites' }]]) {
    if (!wanted(id, 7)) { skipped(id, 7, `${id} exit checks`); continue }
    log(`start ${id} (${file})`)
    const port = await freePort(2)
    const skipParts = Object.entries(parts).filter(([, token]) => SKIP.has(token)).map(([k]) => k).join(',')
    const r = await runChild(id, [path.join('scripts', 'exit-check', file)], { ...common(), EXIT_PORT: String(port), EXIT_ROWS: ROWS, EXIT_SKIP: skipParts, SHOTS: folder(id), EXIT_WORKSPACE: workspace(id) })
    const rows = tableRows(r.text)
    ps[id] = rows
    const pass = rows.filter((x) => x.result === 'PASS').length
    const fail = rows.filter((x) => x.result === 'FAIL')
    const other = rows.filter((x) => x.result !== 'PASS' && x.result !== 'FAIL').length
    const ok = r.code === 0 && fail.length === 0 && pass > 0 && !r.timedOut
    let ev = `${pass} of ${rows.length} rows PASS${other ? `, ${other} report their evidence elsewhere (CI, installer)` : ''} in ${r.seconds.toFixed(0)} s`
    if (id === 'p0') {
      const t = (re) => re.exec(r.text)?.[1]
      const million = rows.find((x) => /1,000,000 rows: paged/.test(x.name))
      const pick = (label) => new RegExp(`${label}: (\\d+) ms`).exec(million?.evidence ?? '')?.[1]
      const bits = [['first page + count', 'first page \\(100, natural order\\) \\+ exact count'], ['indexed filter', 'filter, indexed \\(City = "Pune North"\\)'], ['sorted page', 'sorted page \\(Amount desc\\)'], ['grouped aggregate', 'aggregate: by City, count \\+ sum\\(Amount\\)']].map(([n, re]) => (pick(re) ? `${n} ${pick(re)} ms` : null)).filter(Boolean)
      if (bits.length) ev += `; 1,000,000 rows via the API: ${bits.join(', ')}`
      const b = /(\d+) checks passed/.exec(rows.find((x) => /headless browser/.test(x.name))?.evidence ?? '')?.[1]
      if (b) ev += `; ${b} browser checks`
      const d = /DRILL PASSED in ([\d.]+) s \(backup \+ verification ([\d.]+) s, restore ([\d.]+) s, archive ([\d.]+ \w+)\)/.exec(r.text)
      if (d) ev += `; restore drill ${d[1]} s (backup + verification ${d[2]} s, restore ${d[3]} s, archive ${d[4]})`
      void t
    } else {
      const names = rows.map((x) => x.n).join(',')
      ev += `; rows ${names}`
    }
    if (fail.length) ev += `; FAILED: ${fail.map((x) => `(${x.n}) ${x.name.slice(0, 70)}: ${x.evidence.slice(0, 200)}`).join(' / ')}`
    if (!ok && !fail.length) ev += `; ${r.timedOut ? 'TIMED OUT' : `exit code ${r.code}`}: ${tail(r.text)}`
    finish({ id, check: 7, name: `${id.toUpperCase()} exit checks still pass`, state: ok ? 'PASS' : 'FAIL', counts: { pass, fail: fail.length }, seconds: r.seconds, evidence: ev, log: r.file })
  }
  // the docs tests (links, naming, generated reference pages up to date)
  if (!wanted('docs', 7)) skipped('docs', 7, 'docs tests')
  else {
    log('start docs (vitest: docs links, naming, generated docs)')
    const r = await runChild('docs', [VITEST, 'run', 'scripts/docs-links.test.ts', 'scripts/naming.test.ts', 'scripts/docs/generate.test.ts'], { ...common() }, { timeoutMs: 10 * 60_000 })
    const tests = /^\s*Tests\s+(.+)$/m.exec(r.text)?.[1]?.trim() ?? '?'
    const ok = r.code === 0 && /passed/.test(tests) && !/failed/.test(tests)
    finish({ id: 'docs', check: 7, name: 'docs link, naming and generated-reference tests', state: ok ? 'PASS' : 'FAIL', counts: { pass: Number(/(\d+) passed/.exec(tests)?.[1] ?? 0), fail: Number(/(\d+) failed/.exec(tests)?.[1] ?? 0) }, seconds: r.seconds, evidence: `scripts/docs-links.test.ts, naming.test.ts, docs/generate.test.ts: ${tests}${ok ? '' : `; ${lines(r.text).filter((l) => /^\s*(FAIL|Error:)/.test(l)).slice(0, 4).map((l) => l.trim().slice(0, 160)).join(' | ') || tail(r.text, 4)}`}`, log: r.file })
  }
  // the security re-check of Phase 2: written by someone else; absent is "pending", never a pass
  if (!wanted('security-review', 7)) skipped('security-review', 7, 'security re-check')
  else {
    const f = path.join(root, 'docs', 'internal', 'security-review-p2.md')
    if (fs.existsSync(f)) {
      const text = fs.readFileSync(f, 'utf8')
      const findings = (text.match(/^#{2,4}\s+(F|P2-)?\d+/gm) ?? []).length
      finish({ id: 'security-review', check: 7, name: 'security re-check of Phase 2 written', state: 'PASS', counts: { pass: 1, fail: 0 }, seconds: 0, evidence: `docs/internal/security-review-p2.md exists (${fmt(text.length)} characters${findings ? `, ${findings} numbered headings` : ''}); this script does not judge its content`, log: null })
    } else finish({ id: 'security-review', check: 7, name: 'security re-check of Phase 2 written', state: 'PENDING', counts: null, seconds: 0, evidence: 'docs/internal/security-review-p2.md does not exist yet', log: null })
  }
}

/* ------------------------------------------------------------------ run */

log(`Phase 2 exit check: database server ${DB.host}:${DB.port} as ${DB.user}, ${fmt(ROWS)} rows, output in ${OUT}`)
log(`Node ${process.version} on ${process.platform}; Chrome ${CHROME}`)
try {
  await maint('SELECT 1')
} catch (e) { console.error(`Cannot reach the sandbox PostgreSQL (${DB.host}:${DB.port}, maintenance database ${MAINT}): ${e.message}`); process.exit(2) }

try {
  await script('phone', 1, 'phone (Android emulation, fake camera, scan, photo, offline outbox)', 'p2-phone.mjs', { db: 'appbuilder_exit_phone', highlight: [/camera scan fills the field/, /offline: "You're offline"/, /back online: the row is sent exactly once/, /the photo is uploaded once/, /create retried with the same Idempotency-Key/, /QR code \(with Hindi/, /slow 3G/] })
  await script('pdf', 2, 'PDF from a print template, by email and from a record', 'p2-pdf.mjs', { db: 'appbuilder_exit_pdf', highlight: [/the manager receives the daily OEE PDF/, /scheduled report attaches/, /Print button UI component/, /Patch\(\.\.\., \{Report: GeneratePdf/, /record timeline action stores/, /pdftotext/] })
  await checkDashboard()
  await script('autoapp', 4, 'auto apps from a table (desktop, phone, Studio)', 'p2-autoapp.mjs', { db: 'appbuilder_exit_autoapp' })
  await script('templates', 5, 'templates from the catalogue (four kinds, plan screen, nothing existing changed)', 'p2-templates.mjs', { db: 'appbuilder_exit_templates' })
  await script('whatsapp', 6, 'WhatsApp template message from a flow against the mock; opt-in', 'p2-whatsapp.mjs', { db: 'appbuilder_exit_whatsapp', highlight: [/flow sending to a number without an opt-in/, /nothing reached the \(mock\) provider/, /a flow with the action step sent the template message/, /a retry of the same step/, /forged signature is refused/, /inbound STOP opted/, /after STOP the flow is refused/] })
  await checkRegression()
} catch (e) {
  steps.push({ id: 'run', check: '-', name: 'exit check run', state: 'FAIL', counts: null, seconds: 0, evidence: String(e.stack ?? e).slice(0, 500), log: null })
} finally {
  cleanupAll()
}

/* ------------------------------------------------------------------ report */

const CHECKS = [
  [1, 'A supervisor logs production from an Android phone browser: home screen icon, scan, photo, save; offline save kept and sent once', ['phone']],
  [2, 'A manager receives the daily OEE PDF by email from a print template, and can print an inspection report from a record', ['pdf']],
  [3, 'A dashboard with at least six tiles loads in under two seconds on 1,000,000 rows for a restricted user, showing only that user\'s rows', ['dashboard', 'tile-editor', 'dashboard-layout', 'dashboard-screens']],
  [4, '"Create app from table" gives a working list/detail/edit app for desktop and phone, editable in the Studio', ['autoapp']],
  [5, 'A screen, a UI component, an app and a data model template install from the catalogue with binding and plan screen, changing nothing that existed', ['templates']],
  [6, 'A WhatsApp template message is sent from a flow through the connector against a recorded mock; opt-in is recorded; nothing is sent without opt-in', ['whatsapp']],
  [7, 'Docs, security re-check, P0 and P1 exit checks still pass', ['p0', 'p1', 'docs', 'security-review']],
]
const verdict = (parts) => {
  if (parts.some((p) => p.state === 'FAIL')) return 'FAIL'
  if (parts.length && parts.every((p) => p.state === 'SKIP')) return 'SKIP'
  if (parts.some((p) => p.state === 'PENDING')) return 'PENDING'
  if (parts.some((p) => p.state === 'SKIP')) return 'PARTIAL (a part was skipped)'
  return parts.length ? 'PASS' : 'SKIP'
}
const cell = (s) => String(s).replace(/\|/g, '/').replace(/\n/g, ' ')
const md = []
md.push('| # | Check | Result | Evidence |', '| --- | --- | --- | --- |')
const summary = []
for (const [n, what, ids] of CHECKS) {
  const parts = ids.map((id) => steps.find((s) => s.id === id)).filter(Boolean)
  const v = verdict(parts)
  const main = parts.filter((p) => p.state !== 'SKIP')
  const evidence = (parts.length > 1 ? parts.map((p) => `${p.id}: ${p.state === 'PASS' ? '' : `${p.state}: `}${p.evidence}`) : parts.map((p) => p.evidence)).join(' || ')
  md.push(`| ${n} | ${cell(what)} | ${v} | ${cell(evidence)} |`)
  summary.push({ check: n, result: v, parts: main.map((p) => p.id) })
}
const extraFail = steps.filter((s) => s.check === '-')
for (const s of extraFail) md.push(`| - | ${cell(s.name)} | ${s.state} | ${cell(s.evidence)} |`)
md.push('', '| Script | Result | Checks passed | Seconds | Output |', '| --- | --- | ---: | ---: | --- |')
for (const s of steps) md.push(`| ${s.id} | ${s.state} | ${s.counts ? s.counts.pass : '-'} | ${s.seconds ? s.seconds.toFixed(0) : '-'} | ${s.log ? path.relative(OUT, s.log) : '-'} |`)
const total = (Date.now() - t0) / 1000
md.push('', `Total ${total.toFixed(0)} s (${(total / 60).toFixed(1)} min). Node ${process.version}, ${process.platform} ${os.release()}, PostgreSQL ${DB.host}:${DB.port}. Output: ${OUT}`)
const report = md.join('\n')
console.log('\n' + report)
fs.writeFileSync(path.join(OUT, 'summary.md'), report + '\n')
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ when: new Date().toISOString(), node: process.version, platform: process.platform, seconds: total, rows: Number(ROWS), summary, steps: steps.map(({ timings, ...s }) => ({ ...s, ...(timings ? { timings } : {}) })) }, null, 2))

const anyFail = steps.some((s) => s.state === 'FAIL')
const anyPending = steps.some((s) => s.state === 'PENDING')
process.exit(anyFail ? 1 : anyPending ? 3 : 0)
