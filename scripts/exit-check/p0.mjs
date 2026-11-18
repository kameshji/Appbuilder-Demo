#!/usr/bin/env node
/**
 * Phase 0 exit check (docs/plan/p0-spec.md "Exit check"), the parts that can be automated, against a freshly started
 * server on an EMPTY database. DEVELOPER TOOL (sandbox values only), not part of the product.
 *
 *   node scripts/exit-check/p0.mjs                 everything
 *   EXIT_SKIP=browser,drill node scripts/exit-check/p0.mjs
 *
 *  (2) a table of 1,000,000 rows: paged, filtered, sorted, searched pages, exact counts and aggregates through the API,
 *      each under a threshold (median of 3 after a warm-up); then a headless browser opens the portal grid and an app
 *      DataTable on it (scripts/bench/browser-check.mjs, which needs the built UI in dist/, puppeteer-core and Chrome).
 *  (3) a formula that cannot be pushed down on that table is an error (the translator's diagnostic), and an unpaged
 *      query that would return more rows than the server sends at once is an error too, never a partial result.
 *  (4) the backup, wipe and restore drill (scripts/drill/restore-drill.mjs, its own server and database).
 *  (6) with a fake SMTP relay: forgotten password by email link, two-step verification (TOTP enrolment and sign-in),
 *      the session list and ending another session.
 *  (7) a second environment: created, written to, isolated from Default (both ways), deleted (schema gone).
 * (1) CI and (5) the Windows installer are reported from their own evidence (not run here).
 *
 * Settings: EXIT_DB_HOST (127.0.0.1), EXIT_DB_PORT (5433), EXIT_DB_USER (abdev), EXIT_DB_PASSWORD (abdev-sandbox-only),
 * EXIT_DB_NAME (appbuilder_exitcheck, dropped before and after unless KEEP=1), EXIT_MAINT_DB (appbuilder_test),
 * EXIT_PORT (5251), EXIT_ROWS (1000000), EXIT_SKIP (comma list: browser, drill). Prints a Markdown table; exit code 1
 * when a check fails.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const DB = { host: E.EXIT_DB_HOST || '127.0.0.1', port: Number(E.EXIT_DB_PORT || 5433), user: E.EXIT_DB_USER || 'abdev', password: E.EXIT_DB_PASSWORD || 'abdev-sandbox-only', database: E.EXIT_DB_NAME || 'appbuilder_exitcheck' }
const MAINT = E.EXIT_MAINT_DB || 'appbuilder_test'
const PORT = Number(E.EXIT_PORT || 5251)
const ROWS = Number(E.EXIT_ROWS || 1_000_000)
const SKIP = new Set((E.EXIT_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean))
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-exit-'))
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN = { name: 'Exit Admin', email: 'exit@example.test', password: 'Exit-Example-Pass-2026' }
if (!/^appbuilder_exit/.test(DB.database)) { console.error('The exit-check database name must start with appbuilder_exit (it is dropped).'); process.exit(2) }

const { startFakeSmtp } = await import(pathToFileURL(path.join(root, 'server/core/identity/fake-smtp.ts')).href)
const { totp, base32Decode } = await import(pathToFileURL(path.join(root, 'server/core/identity/totp.ts')).href)
const { analyze } = await import(pathToFileURL(path.join(root, 'src/fx/query/translate.ts')).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const t0 = Date.now()
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`)

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

/* ------------------------------------------------------------------ server */

let server = null
let out = ''
async function startServer() {
  server = spawn(process.execPath, ['server/main.ts'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...E, APPBUILDER_DB_HOST: DB.host, APPBUILDER_DB_PORT: String(DB.port), APPBUILDER_DB_NAME: DB.database, APPBUILDER_DB_USER: DB.user, APPBUILDER_DB_PASSWORD: DB.password, APPBUILDER_WORKSPACE: path.join(DIR, 'workspace'), PORT: String(PORT), APPBUILDER_HOST: '127.0.0.1', APPBUILDER_MIGRATION_BACKUP: 'skip' },
  })
  server.stdout.on('data', (d) => { out += d })
  server.stderr.on('data', (d) => { out += d })
  for (let i = 0; i < 240 && !/is running at/.test(out); i++) {
    if (server.exitCode !== null) throw new Error(`the server stopped:\n${out}`)
    await sleep(250)
  }
  if (!/is running at/.test(out)) throw new Error(`the server did not start:\n${out}`)
}
async function stopServer() {
  if (!server) return
  const s = server
  server = null
  s.kill('SIGTERM')
  for (let i = 0; i < 80 && s.exitCode === null; i++) await sleep(100)
  if (s.exitCode === null) s.kill('SIGKILL')
}

function client() {
  // a cookie jar: the session, and the pending second step of a sign-in
  const jar = new Map()
  const api = async (method, p, body, o = {}) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
    const headers = { 'X-Appbuilder': '1', ...(cookie ? { Cookie: cookie } : {}), ...(o.env ? { 'X-Appbuilder-Environment': o.env } : {}) }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(BASE + '/api/v1' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const i = pair.indexOf('=')
      const k = pair.slice(0, i)
      const v = pair.slice(i + 1)
      if (v) jar.set(k, v)
      else jar.delete(k)
    }
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text()
    return { status: res.status, data }
  }
  return api
}
const must = (r, what) => { if (r.status < 200 || r.status > 299) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const record = (n, name, ok, evidence) => { results.push({ n, name, ok, evidence }); log(`${ok ? 'PASS' : 'FAIL'} (${n}) ${name}: ${evidence}`) }

/* ------------------------------------------------------------------ checks */

async function checkMillion(api) {
  const t = must(await api('POST', '/tables', {
    displayName: 'BigOrders', name: 'BigOrders', columns: [
      { displayName: 'Title', name: 'Title', type: 'text', required: true, indexed: true },
      { displayName: 'City', name: 'City', type: 'text', indexed: true },
      { displayName: 'Status', name: 'Status', type: 'choice', choices: ['Open', 'Won', 'Lost', 'Hold'], indexed: true },
      { displayName: 'Amount', name: 'Amount', type: 'currency', indexed: true },
      { displayName: 'Qty', name: 'Qty', type: 'number' },
      { displayName: 'Due', name: 'Due', type: 'date', indexed: true },
      { displayName: 'Active', name: 'Active', type: 'boolean' },
      { displayName: 'Note', name: 'Note', type: 'text' },
    ],
  }), 'create BigOrders')
  const phys = `"env_default"."${t.source}"`
  const s0 = Date.now()
  const c = new pg.Client(DB)
  await c.connect()
  try {
    for (let from = 1; from <= ROWS; from += 100_000) {
      const to = Math.min(ROWS, from + 99_999)
      await c.query(`INSERT INTO ${phys} ("id", "createdOn", "modifiedOn", "createdBy", "owner", "Title", "City", "Status", "Amount", "Qty", "Due", "Active", "Note")
        SELECT gen_random_uuid()::text, timestamptz '2025-01-01' + (g * interval '1 second'), timestamptz '2025-01-01' + (g * interval '1 second'), NULL, NULL,
               'Order ' || g, (ARRAY['Pune','Austin','Berlin','Lagos','Osaka','Lima','Oslo','Cairo','Perth','Quito'])[1 + g % 10] || CASE WHEN g % 1000 = 0 THEN ' North' ELSE '' END,
               (ARRAY['Open','Won','Lost','Hold'])[1 + (g / 7) % 4], round(((g::bigint * 7919) % 100000) / 100.0, 2), g % 50, date '2020-01-01' + (g % 2500), g % 3 = 0, 'note ' || md5(g::text)
        FROM generate_series($1::int, $2::int) AS g`, [from, to])
    }
    await c.query(`ANALYZE ${phys}`)
  } finally { await c.end() }
  log(`seeded ${ROWS.toLocaleString('en-US')} rows in ${((Date.now() - s0) / 1000).toFixed(1)} s`)
  const cases = [
    ['first page (100, natural order) + exact count', { count: true, page: { size: 100 } }, 1500],
    ['filter, indexed (City = "Pune North")', { filter: { col: 'City', op: 'eq', value: 'pune north' }, page: { size: 100 } }, 500],
    ['filter, indexed (Status = "Won") + count', { filter: { col: 'Status', op: 'eq', value: 'won' }, count: true, page: { size: 100 } }, 1500],
    ['filter, not indexed (Qty = 7)', { filter: { col: 'Qty', op: 'eq', value: 7 }, page: { size: 100 } }, 1000],
    ['sorted page (Amount desc)', { sort: [{ col: 'Amount', dir: 'desc' }], page: { size: 100 } }, 500],
    ['search "order 4242" (Title, City) + count', { search: { text: 'order 4242', columns: ['Title', 'City'] }, count: true, page: { size: 100 } }, 3000],
    ['exact count, whole table', { count: true, page: { size: 0 } }, 1500],
    ['aggregate: by City, count + sum(Amount)', { aggregate: { groupBy: ['City'], measures: [{ name: 'N', fn: 'count' }, { name: 'Total', fn: 'sum', col: 'Amount' }] } }, 3000],
    ['aggregate: sum(Amount), whole table', { aggregate: { groupBy: [], measures: [{ name: 'S', fn: 'sum', col: 'Amount' }] } }, 2000],
  ]
  const lines = []
  let allOk = true
  for (const [label, extra, limit] of cases) {
    const plan = { version: 2, table: 'BigOrders', ...extra }
    must(await api('POST', '/query', { plan }), label)
    const times = []
    let last
    for (let i = 0; i < 3; i++) {
      const s = performance.now()
      last = must(await api('POST', '/query', { plan }), label)
      times.push(performance.now() - s)
    }
    const ms = [...times].sort((a, b) => a - b)[1]
    const ok = ms <= limit
    allOk &&= ok
    lines.push(`${label}: ${ms.toFixed(0)} ms (limit ${limit})${last.count !== undefined ? `, count ${last.count.toLocaleString('en-US')}` : ''}`)
  }
  // deep paging by cursor: 20 pages of the Amount-descending order
  const sp = performance.now()
  let cursor
  for (let i = 0; i < 20; i++) cursor = must(await api('POST', '/query', { plan: { version: 2, table: 'BigOrders', sort: [{ col: 'Amount', dir: 'desc' }], page: { size: 100, ...(cursor ? { cursor } : {}) } } }), 'paging').nextCursor
  const per = (performance.now() - sp) / 20
  allOk &&= per <= 500
  lines.push(`20 pages by cursor: ${per.toFixed(0)} ms per page (limit 500)`)
  for (const l of lines) log(`  ${l}`)
  record(2, '1,000,000 rows: paged, filtered, sorted, searched, counted, aggregated through the API', allOk, lines.join('; '))
  return t
}

async function checkBrowser() {
  const r = await new Promise((resolve) => {
    let text = ''
    const p = spawn(process.execPath, ['scripts/bench/browser-check.mjs'], { cwd: root, env: { ...E, BASE, EMAIL: ADMIN.email, PASSWORD: ADMIN.password }, stdio: ['ignore', 'pipe', 'pipe'] })
    p.stdout.on('data', (d) => { text += d })
    p.stderr.on('data', (d) => { text += d })
    p.on('exit', (code) => resolve({ code, text }))
  })
  const pass = (r.text.match(/^PASS/gm) || []).length
  const fail = (r.text.match(/^FAIL.*$/gm) || [])
  record(2, 'headless browser: portal grid and an app DataTable on the 1,000,000-row table', r.code === 0, `${pass} checks passed${fail.length ? `; ${fail.join(' | ')}` : ''}${r.code !== 0 && !pass ? `; ${r.text.trim().split('\n').slice(-3).join(' ')}` : ''}`)
}

async function checkNotDelegable(api) {
  const schema = { tables: { BigOrders: { columns: { id: 'text', createdOn: 'datetime', Title: 'text', City: 'text', Status: 'text', Amount: 'number', Qty: 'number', Due: 'date', Active: 'boolean', Note: 'text' } } } }
  const res = analyze('=Filter(BigOrders, Len(Note) > 40)', schema)
  const err = (res.diagnostics || []).find((d) => d.severity === 'error')
  const unpaged = await api('POST', '/query', { plan: { version: 2, table: 'BigOrders', filter: { col: 'Status', op: 'eq', value: 'open' } } })
  const ok = err?.code === 'not-delegable-expression' && res.plan === null && unpaged.status === 422 && !unpaged.data.rows
  record(3, 'a formula that cannot be pushed down is an error, never a partial result', ok,
    `translator: ${err ? `${err.code} on "${err.text}", no plan sent` : 'no error'}; unpaged query of 250,000 rows: ${unpaged.status} "${String(unpaged.data?.error?.message ?? '').slice(0, 90)}"`)
}

async function checkDrill() {
  const r = await new Promise((resolve) => {
    let text = ''
    const p = spawn(process.execPath, ['scripts/drill/restore-drill.mjs'], { cwd: root, env: { ...E, DRILL_DB_NAME: 'appbuilder_drill_exit', DRILL_PORT: String(PORT + 1) }, stdio: ['ignore', 'pipe', 'pipe'] })
    p.stdout.on('data', (d) => { text += d })
    p.stderr.on('data', (d) => { text += d })
    p.on('exit', (code) => resolve({ code, text }))
  })
  const oks = (r.text.match(/ ok: /g) || []).length
  const last = r.text.trim().split('\n').filter(Boolean).slice(-1)[0] || ''
  record(4, 'backup, wipe, restore drill by script', r.code === 0, `${oks} drill steps ok; ${last.slice(0, 160)}`)
  await maint('DROP DATABASE IF EXISTS "appbuilder_drill_exit" WITH (FORCE)').catch(() => {})
}

async function checkIdentity(api) {
  const smtp = await startFakeSmtp()
  const notes = []
  try {
    must(await api('PUT', '/identity/email', { host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'apps@example.test', fromName: 'Apps', installName: 'Exit check', publicUrl: BASE }), 'smtp settings')
    // a second person: invited by the administrator, password set from the reset link
    const u = must(await api('POST', '/users', { name: 'Pia', email: 'pia@example.test', roleIds: ['role_admin'], password: 'Pia-First-Pass-2026' }), 'create user')
    const anon = client()
    must(await anon('POST', '/auth/password/forgot', { email: 'pia@example.test' }), 'forgot')
    const mails = await smtp.waitFor(1, 30_000)
    const mail = mails.find((m) => m.to.includes('pia@example.test'))
    const token = /#reset=([A-Za-z0-9_-]+)/.exec(mail?.text ?? '')?.[1]
    if (!token) throw new Error('no reset link in the email')
    must(await anon('POST', '/auth/password/reset', { token, password: 'Pia-Reset-Pass-2026' }), 'reset')
    const pia = client()
    must(await pia('POST', '/auth/login', { email: 'pia@example.test', password: 'Pia-Reset-Pass-2026' }), 'login with the new password')
    notes.push('reset by emailed link, sign-in with the new password')
    // TOTP: enrol, then the password alone is not enough, the code is
    const st = must(await pia('POST', '/auth/mfa/totp/start'), 'totp start')
    const secret = base32Decode(st.secret)
    must(await pia('POST', '/auth/mfa/totp/confirm', { code: totp(secret) }), 'totp confirm')
    const c2 = client()
    const first = await c2('POST', '/auth/login', { email: 'pia@example.test', password: 'Pia-Reset-Pass-2026' })
    if (first.status !== 401 || first.data?.error?.code !== 'mfa_required') throw new Error(`password alone: ${first.status}`)
    must(await c2('POST', '/auth/login/verify', { code: totp(secret, Date.now() + 30_000) }), 'second step')
    notes.push('TOTP enrolled; sign-in needs the code')
    // sessions: Pia has two; end the other one from c2
    const list = must(await c2('GET', '/auth/sessions'), 'sessions').items
    const other = list.find((x) => !x.current)
    if (list.length < 2 || !other) throw new Error(`session list: ${list.length}`)
    must(await c2('DELETE', `/auth/sessions/${encodeURIComponent(other.id)}`), 'end session')
    const ended = await pia('GET', '/auth/session')
    if (ended.status !== 401) throw new Error(`the ended session still works (${ended.status})`)
    notes.push(`session list (${list.length}), ending the other session signs it out`)
    void u
    record(6, 'password reset, two-step verification (TOTP), session list end to end', true, notes.join('; '))
  } catch (e) {
    record(6, 'password reset, two-step verification (TOTP), session list end to end', false, `${notes.join('; ')}${notes.length ? '; ' : ''}${e.message}`)
  } finally {
    await smtp.close()
  }
}

async function checkEnvironments(api) {
  const notes = []
  try {
    const env = must(await api('POST', '/environments', { name: 'Exit sandbox', type: 'sandbox' }), 'create environment')
    const id = env.id
    notes.push(`created ${id}`)
    const t = must(await api('POST', '/tables', { displayName: 'Only here', columns: [{ displayName: 'Name', type: 'text' }] }, { env: id }), 'table in it')
    must(await api('POST', `/data/${t.id}/rows`, { values: { Name: 'secret row' } }, { env: id }), 'row in it')
    const there = must(await api('POST', '/query', { plan: { version: 2, table: 'OnlyHere', count: true, page: { size: 10 } } }, { env: id }), 'read it there')
    const here = await api('POST', '/query', { plan: { version: 2, table: 'OnlyHere', count: true } })
    const defaultTables = must(await api('GET', '/workspace'), 'default workspace').tables.map((x) => x.name)
    const bigThere = await api('POST', '/query', { plan: { version: 2, table: 'BigOrders', count: true, page: { size: 0 } } }, { env: id })
    const isolated = there.count === 1 && here.status === 404 && !defaultTables.includes('OnlyHere') && bigThere.status === 404
    notes.push(`row visible there (${there.count}), not in Default (${here.status}), Default's table not there (${bigThere.status})`)
    const del = await api('DELETE', `/environments/${id}`, { confirmName: 'Exit sandbox' })
    must(del, 'delete environment')
    let gone = false
    for (let i = 0; i < 60 && !gone; i++) {
      const s = await q('SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = $1', [`env_${id}`])
      gone = s[0].n === 0
      if (!gone) await sleep(500)
    }
    notes.push(gone ? 'deleted, schema dropped' : 'deleted, schema still there')
    record(7, 'second environment: created, written, isolated, deleted', isolated && gone, notes.join('; '))
  } catch (e) {
    record(7, 'second environment: created, written, isolated, deleted', false, `${notes.join('; ')}; ${e.message}`)
  }
}

/* ------------------------------------------------------------------ run */

let code = 0
try {
  log(`Phase 0 exit check: database ${DB.database}, port ${PORT}, ${ROWS.toLocaleString('en-US')} rows`)
  await maint(`DROP DATABASE IF EXISTS "${DB.database}" WITH (FORCE)`)
  await maint(`CREATE DATABASE "${DB.database}" ENCODING 'UTF8' TEMPLATE template0`)
  await startServer()
  const setupCode = (/SETUP CODE:\s+([A-Z0-9-]+)/.exec(out)?.[1] ?? '').replace(/-/g, '')
  const api = client()
  must(await api('POST', '/setup/admin', { setupCode, ...ADMIN }), 'first administrator')
  must(await api('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password }), 'sign in')
  await checkMillion(api)
  await checkNotDelegable(api)
  if (!SKIP.has('browser')) await checkBrowser()
  await checkIdentity(api)
  await checkEnvironments(api)
  if (!SKIP.has('drill')) await checkDrill()
} catch (e) {
  record('-', 'exit check run', false, e.message.slice(0, 400))
} finally {
  await stopServer()
  if (E.KEEP !== '1') {
    await maint(`DROP DATABASE IF EXISTS "${DB.database}" WITH (FORCE)`).catch(() => {})
    fs.rmSync(DIR, { recursive: true, force: true })
  }
}
results.push({ n: 1, name: 'test suite green on PostgreSQL in CI; MySQL connector tests green', ok: null, evidence: 'not run here: .github/workflows/ci.yml (and the full local run on PostgreSQL 16 + MariaDB)' })
results.push({ n: 5, name: 'clean install on Windows by one script in under an hour', ok: null, evidence: 'not run here: package L (installer) reports its own evidence' })
results.sort((a, b) => (Number(a.n) || 0) - (Number(b.n) || 0))
console.log('\n| # | Check | Result | Evidence |\n| --- | --- | --- | --- |')
for (const r of results) {
  console.log(`| ${r.n} | ${r.name} | ${r.ok === null ? 'see evidence' : r.ok ? 'PASS' : 'FAIL'} | ${String(r.evidence).replace(/\|/g, '/').replace(/\n/g, ' ')} |`)
  if (r.ok === false) code = 1
}
console.log(`\nTotal ${((Date.now() - t0) / 1000).toFixed(0)} s`)
process.exit(code)
