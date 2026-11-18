#!/usr/bin/env node
/**
 * The Phase-0 exit drill (docs/plan/p0-spec.md, exit check 4): backup, wipe, restore, by script, end to end.
 *
 *   node scripts/drill/restore-drill.mjs
 *
 * It runs a real Appbuilder server (node server/main.ts) against a database it creates, and:
 *   1. seeds: the first administrator, a table with rows of every common type, attachments, a data file, a second
 *      environment copied with its data, a connection with a saved password;
 *   2. records what is there: rows (count and a checksum of every row) of every table in every environment, and the
 *      sha256 of every attachment, read through the API;
 *   3. backs up the install from the API ("Back up now", encrypted, with the encryption key) and downloads the archive;
 *   4. stops the server and WIPES the database (dropped and created again, empty) and the workspace folder;
 *   5. restores with the command line (node server/main.ts restore <archive>) onto the empty database and workspace;
 *   6. starts the server again, signs in, and compares rows, checksums and attachments with step 2.
 * Exit code 0 when everything matches; 1 otherwise. Prints timings.
 *
 * Settings (environment): DRILL_DB_HOST (127.0.0.1), DRILL_DB_PORT (5433), DRILL_DB_USER (abdev),
 * DRILL_DB_PASSWORD (abdev-sandbox-only), DRILL_DB_NAME (appbuilder_drill), DRILL_MAINT_DB (appbuilder_test: an existing
 * database to connect to for CREATE/DROP DATABASE), DRILL_PORT (5241), DRILL_DIR (a new temporary folder),
 * DRILL_ROWS (2000). The database user needs CREATEDB. The database DRILL_DB_NAME is dropped: never point it at real data.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env
const DB = { host: E.DRILL_DB_HOST || '127.0.0.1', port: Number(E.DRILL_DB_PORT || 5433), user: E.DRILL_DB_USER || 'abdev', password: E.DRILL_DB_PASSWORD || 'abdev-sandbox-only', database: E.DRILL_DB_NAME || 'appbuilder_drill' }
const MAINT = E.DRILL_MAINT_DB || 'appbuilder_test'
const PORT = Number(E.DRILL_PORT || 5241)
const DIR = E.DRILL_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ab-drill-'))
const ROWS = Number(E.DRILL_ROWS || 2000)
const WS = path.join(DIR, 'workspace')
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN = { name: 'Drill Admin', email: 'drill@example.test', password: 'Drill-Example-Pass-2026' }
const PASSPHRASE = 'drill passphrase, example only'
if (!/^appbuilder_drill/.test(DB.database) && E.DRILL_I_KNOW !== '1') { console.error(`Refusing to drop "${DB.database}": the drill database name must start with appbuilder_drill (or set DRILL_I_KNOW=1).`); process.exit(2) }

const t0 = Date.now()
const times = {}
const step = (n, s) => console.log(`\n[${((Date.now() - t0) / 1000).toFixed(1)} s] ${n}. ${s}`)
const ok = (c, m) => { if (!c) throw new Error(m); console.log(`  ok: ${m}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function maint(sql) {
  const c = new pg.Client({ ...DB, database: MAINT })
  await c.connect()
  try { await c.query(sql) } finally { await c.end() }
}
const freshDb = async () => { await maint(`DROP DATABASE IF EXISTS "${DB.database}" WITH (FORCE)`); await maint(`CREATE DATABASE "${DB.database}" ENCODING 'UTF8' TEMPLATE template0`) }
const serverEnv = { ...E, APPBUILDER_DB_HOST: DB.host, APPBUILDER_DB_PORT: String(DB.port), APPBUILDER_DB_NAME: DB.database, APPBUILDER_DB_USER: DB.user, APPBUILDER_DB_PASSWORD: DB.password, APPBUILDER_WORKSPACE: WS, PORT: String(PORT), APPBUILDER_HOST: '127.0.0.1' }

let server = null
async function startServer() {
  let out = ''
  server = spawn(process.execPath, ['server/main.ts'], { cwd: root, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout.on('data', (d) => { out += d })
  server.stderr.on('data', (d) => { out += d })
  for (let i = 0; i < 120; i++) {
    if (/is running at/.test(out)) break
    if (server.exitCode !== null) throw new Error(`the server stopped:\n${out}`)
    await sleep(250)
  }
  ok(/is running at/.test(out), `server started on port ${PORT}`)
  return () => (/SETUP CODE:\s+([A-Z0-9-]+)/.exec(out)?.[1] ?? '').replace(/-/g, '')
}
async function stopServer() {
  if (!server) return
  const s = server
  server = null
  s.kill('SIGTERM')
  for (let i = 0; i < 60 && s.exitCode === null; i++) await sleep(100)
  if (s.exitCode === null) s.kill('SIGKILL')
}

let cookie = ''
async function api(method, p, body, o = {}) {
  const headers = { 'X-Appbuilder': '1', ...(cookie ? { Cookie: cookie } : {}), ...(o.env ? { 'X-Appbuilder-Environment': o.env } : {}) }
  let payload
  if (o.raw) { headers['Content-Type'] = o.type || 'application/octet-stream'; payload = o.raw } else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }
  const res = await fetch(BASE + '/api/v1' + p, { method, headers, body: payload })
  for (const c of res.headers.getSetCookie()) if (c.startsWith('ab_session=')) cookie = c.split(';')[0]
  const type = res.headers.get('content-type') || ''
  const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer())
  if (o.expect !== false && (res.status < 200 || res.status > 299)) throw new Error(`${method} ${p}: ${res.status} ${type.includes('json') ? JSON.stringify(data) : ''}`)
  return data
}

/** what is there: per environment and table, rows and a checksum of every row; attachment bytes */
async function inventory() {
  const envs = (await api('GET', '/environments')).items.filter((e) => !e.state)
  const out = { tables: {}, attachments: {} }
  for (const e of envs) {
    const ws = await api('GET', '/workspace', undefined, { env: e.id })
    for (const t of ws.tables) {
      if (t.system || (t.reporting && t.reporting.kind === 'view')) continue
      const h = createHash('sha256')
      let n = 0
      let total = null
      for (let skip = 0; ; skip += 5000) {
        const r = await api('POST', `/data/${encodeURIComponent(t.name)}/query`, { orderBy: [{ col: 'id', dir: 'asc' }], top: 5000, skip, count: skip === 0 }, { env: e.id, expect: false })
        if (!r.rows) break
        if (skip === 0) total = r.total ?? null
        for (const row of r.rows) {
          h.update(JSON.stringify(row))
          n++
          for (const col of t.columns.filter((c) => c.type === 'file' || c.type === 'image')) {
            const v = row[col.name]
            const ids = Array.isArray(v) ? v.map((x) => x?.id ?? x) : v ? [v?.id ?? v] : []
            for (const id of ids) if (typeof id === 'string' && !out.attachments[`${e.id}/${id}`]) {
              const b = await api('GET', `/attachments/${encodeURIComponent(id)}?env=${e.id}`, undefined, { env: e.id })
              out.attachments[`${e.id}/${id}`] = createHash('sha256').update(b).digest('hex')
            }
          }
        }
        if (r.rows.length < 5000) break
      }
      out.tables[`${e.id}/${t.name}`] = { rows: n, total, sha256: h.digest('hex') }
    }
  }
  return out
}

let failed = false
try {
  console.log(`Appbuilder restore drill\n  database ${DB.user}@${DB.host}:${DB.port}/${DB.database}\n  folder   ${DIR}`)
  step(1, 'fresh database and workspace, server, first administrator, seed data')
  await freshDb()
  fs.rmSync(WS, { recursive: true, force: true })
  const setupCode = await startServer()
  await api('POST', '/setup/admin', { setupCode: setupCode(), ...ADMIN })
  await api('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password })
  await api('POST', '/tables', { displayName: 'Drill items', columns: [
    { displayName: 'Title', type: 'text' }, { displayName: 'Qty', type: 'number' }, { displayName: 'Price', type: 'currency' }, { displayName: 'Ratio', type: 'decimal' },
    { displayName: 'Done', type: 'boolean' }, { displayName: 'Due', type: 'date' }, { displayName: 'At', type: 'datetime' }, { displayName: 'Notes', type: 'multiline' }, { displayName: 'Doc', type: 'file' },
  ] })
  const ids = []
  for (let i = 0; i < ROWS; i += 1) {
    const r = await api('POST', '/data/DrillItems/rows', { values: { Title: `Item ${i} – ünïcödé`, Qty: i, Price: i * 1.25, Ratio: i / 7, Done: i % 2 === 0, Due: '2026-11-18', At: '2026-11-18T10:20:30.000Z', Notes: i % 50 === 0 ? 'line one\nline two\ttab \\ backslash' : null } })
    ids.push(r.row?.id ?? r.id)
  }
  for (let i = 0; i < 5; i++) {
    await api('POST', `/attachments?table=DrillItems&column=Doc&rowId=${ids[i]}&name=doc${i}.bin`, undefined, { raw: Buffer.from(`attachment ${i} `.repeat(2000 + i * 100)) })
  }
  await api('POST', '/files?name=drill-people.csv', undefined, { raw: Buffer.from('Name,City\nAnn,Pune\nBo,Indore\nCy,Bhopal\n'), type: 'text/csv' })
  await api('POST', '/environments', { name: 'Drill sandbox', type: 'sandbox', copyFrom: 'default', copy: 'data' })
  await api('POST', '/connections', { name: 'Other database', connector: 'postgres', settings: { host: '127.0.0.1', port: '5432', database: 'other', user: 'other' }, secret: 'other-password-example' }, { expect: false })
  ok(true, `seeded ${ROWS} rows, 5 attachments, a data file, a second environment`)

  step(2, 'inventory before')
  const before = await inventory()
  ok(Object.keys(before.tables).length >= 4 && Object.keys(before.attachments).length >= 10, `${Object.keys(before.tables).length} tables, ${Object.keys(before.attachments).length} attachments read`)

  step(3, 'back up the install (encrypted, with the key) and download it')
  let t = Date.now()
  const b0 = await api('POST', '/backups', { scope: 'install', includeKey: true, passphrase: PASSPHRASE, note: 'restore drill' })
  let b = b0
  for (let i = 0; i < 600 && ['queued', 'running', 'verifying'].includes(b.state); i++) { await sleep(250); b = await api('GET', `/backups/${b0.id}`) }
  ok(b.state === 'ok', `backup ${b.fileName}: ${b.state}, ${b.sizeBytes} bytes, ${b.method}, verified ${b.verifiedOn ? 'yes' : 'no'}`)
  times.backup = Date.now() - t
  const ticket = await api('POST', `/backups/${b.id}/download-ticket`, {})
  const archive = await api('GET', `/backups/${b.id}/download?ticket=${encodeURIComponent(ticket.ticket)}`)
  const file = path.join(DIR, b.fileName)
  fs.writeFileSync(file, archive)
  ok(createHash('sha256').update(archive).digest('hex') === b.sha256, `downloaded ${archive.length} bytes, sha256 matches the catalogue`)

  step(4, 'stop the server; WIPE the database and the workspace')
  await stopServer()
  await freshDb()
  fs.rmSync(WS, { recursive: true, force: true })
  const left = await (async () => { const c = new pg.Client(DB); await c.connect(); try { return (await c.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'ab' OR nspname LIKE 'env\\_%'")).rows[0].n } finally { await c.end() } })()
  ok(left === 0 && !fs.existsSync(WS), 'the database is empty and the workspace is gone')

  step(5, 'restore from the command line')
  t = Date.now()
  const pf = path.join(DIR, 'passphrase.txt')
  fs.writeFileSync(pf, PASSPHRASE, { mode: 0o600 })
  const r = spawnSync(process.execPath, ['server/main.ts', 'restore', file, '--workspace', WS, '--passphrase-file', pf, '--yes'], { cwd: root, env: serverEnv, encoding: 'utf8', timeout: 600_000 })
  process.stdout.write(r.stdout.split('\n').map((l) => `  | ${l}`).join('\n') + '\n')
  ok(r.status === 0, 'the restore command succeeded')
  fs.rmSync(pf, { force: true })
  times.restore = Date.now() - t

  step(6, 'start again, sign in, compare')
  cookie = ''
  await startServer()
  await api('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password })
  const after = await inventory()
  const diffs = []
  for (const [k, v] of Object.entries(before.tables)) {
    const a = after.tables[k]
    if (!a) diffs.push(`${k}: missing after the restore`)
    else if (a.rows !== v.rows || a.sha256 !== v.sha256) diffs.push(`${k}: ${v.rows} rows (${v.sha256.slice(0, 12)}) before, ${a.rows} (${a.sha256.slice(0, 12)}) after`)
  }
  for (const [k, v] of Object.entries(before.attachments)) if (after.attachments[k] !== v) diffs.push(`attachment ${k}: checksum differs or missing`)
  for (const d of diffs) console.log(`  DIFF ${d}`)
  ok(!diffs.length, `${Object.keys(before.tables).length} tables (rows and row checksums) and ${Object.keys(before.attachments).length} attachments identical`)
  console.log(`\nDRILL PASSED in ${((Date.now() - t0) / 1000).toFixed(1)} s (backup + verification ${(times.backup / 1000).toFixed(1)} s, restore ${(times.restore / 1000).toFixed(1)} s, archive ${(fs.statSync(file).size / 1024 / 1024).toFixed(2)} MB)`)
} catch (e) {
  failed = true
  console.error(`\nDRILL FAILED: ${e.message}`)
} finally {
  await stopServer()
  if (E.DRILL_KEEP !== '1') {
    await maint(`DROP DATABASE IF EXISTS "${DB.database}" WITH (FORCE)`).catch(() => {})
    if (!E.DRILL_DIR) fs.rmSync(DIR, { recursive: true, force: true })
  }
}
process.exit(failed ? 1 : 0)
