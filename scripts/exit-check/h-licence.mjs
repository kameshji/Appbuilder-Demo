#!/usr/bin/env node
/**
 * Hosting exit check 6: the licence check with 3 days of grace (docs/plan/hosting-spec.md; packages H-G, H-H).
 * DEVELOPER AND CI TOOL, not part of the product. A REAL licence service process and a REAL install process of this
 * tree, each with its own database in the sandbox PostgreSQL (APPBUILDER_TEST_DB), a signing key generated now under
 * .sandbox/lic/run-*, and the install's licence clock moved by its test clock file (APPBUILDER_LICENCE_TEST_CLOCK_FILE).
 * Between the two sits a small proxy in this script, so the service can be "stopped" and so forged, foreign-key,
 * replayed and other-organisation answers can be sent to the install.
 *
 *   . .\.sandbox\env.ps1 ; node scripts/exit-check/h-licence.mjs
 *
 * Ports 5330 (install), 5331 (service), 5332 (proxy), 5333 (unlicensed install). Databases appbuilder_exit_lic_*,
 * dropped afterwards with the run folder (LIC_KEEP=1 keeps the folder and logs). Prints a Markdown table; exit 1 when
 * a check fails, 2 when the setup fails.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { generateLicenceKey, loadSigningKey, signAnswer } from '../../server/core/licence/answer.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const t0 = Date.now()
const log = (m) => process.stderr.write(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}\n`)
const PORT = { install: 5330, service: 5331, proxy: 5332, plain: 5333 }
const H = 3600_000

const url = process.env.APPBUILDER_TEST_DB
if (!url) {
  process.stderr.write('Set APPBUILDER_TEST_DB (dot-source .sandbox/env.ps1).\n')
  process.exit(2)
}
const pgu = new URL(url)
const conn = { host: pgu.hostname, port: Number(pgu.port) || 5432, user: decodeURIComponent(pgu.username), password: decodeURIComponent(pgu.password), maint: pgu.pathname.slice(1) || 'postgres' }
const hex = randomBytes(4).toString('hex')
const dbs = { svc: `appbuilder_exit_lic_svc_${hex}`, inst: `appbuilder_exit_lic_inst_${hex}`, plain: `appbuilder_exit_lic_plain_${hex}` }
const run = path.join(root, '.sandbox', 'lic', `run-${hex}`)
const procs = []
const results = []
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}

async function sql(database, text, params = []) {
  const c = new pg.Client({ host: conn.host, port: conn.port, user: conn.user, password: conn.password, database })
  c.on('error', () => {})
  await c.connect()
  try {
    return (await c.query(text, params)).rows
  } finally {
    await c.end().catch(() => {})
  }
}

function start(name, args, env) {
  const out = fs.openSync(path.join(run, `${name}.log`), 'a')
  const p = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', out, out] })
  procs.push(p)
  return p
}
async function stop(p) {
  if (!p || p.exitCode !== null) return
  await new Promise((r) => {
    p.once('exit', r)
    p.kill()
    setTimeout(r, 5000)
  })
}
async function waitFor(fn, what, ms = 30_000) {
  const end = Date.now() + ms
  for (;;) {
    try {
      if (await fn()) return
    } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}
function cliRun(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['server/licence-service/main.ts', ...args], { cwd: root, env: { ...process.env, ...env } })
    let text = ''
    p.stdout.on('data', (d) => { text += d })
    p.stderr.on('data', (d) => { text += d })
    p.on('exit', (code) => resolve({ code, text }))
  })
}

class Api {
  constructor(base) { this.base = base; this.cookie = '' }
  async req(method, p, body) {
    const headers = { 'X-Appbuilder': '1' }
    if (this.cookie) headers.Cookie = this.cookie
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(this.base + '/api/v1' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const [n, v] = pair.split('=')
      if (n === 'ab_session') this.cookie = v ? `ab_session=${v}` : ''
    }
    const type = res.headers.get('content-type') ?? ''
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() }
  }
  get(p) { return this.req('GET', p) }
  post(p, b = {}) { return this.req('POST', p, b) }
  put(p, b) { return this.req('PUT', p, b) }
}

/* ------------------------------------------------------------------ the proxy between install and service */

const proxy = { mode: 'pass', old: null, last: null }
let signer = null
let foreign = null
function startProxy() {
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    const send = (status, obj) => {
      const s = JSON.stringify(obj)
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) })
      res.end(s)
    }
    try {
      if (proxy.mode === 'down') return send(502, { error: 'bad gateway' })
      const up = await fetch(`http://127.0.0.1:${PORT.service}${req.url}`, { method: req.method, headers: { 'Content-Type': 'application/json', Authorization: req.headers.authorization ?? '' }, body })
      const answer = await up.json()
      if (up.status !== 200) return send(up.status, answer)
      const p = JSON.parse(Buffer.from(answer.payload, 'base64').toString('utf8'))
      if (proxy.mode === 'pass') {
        proxy.old = proxy.last
        proxy.last = answer
        return send(200, answer)
      }
      if (proxy.mode === 'forge') {
        p.seats = { full: 999, operator: 999, external: 999 }
        return send(200, { ...answer, payload: Buffer.from(JSON.stringify(p)).toString('base64') })
      }
      if (proxy.mode === 'foreign') return send(200, signAnswer(p, foreign))
      if (proxy.mode === 'replay') return send(200, proxy.old ?? proxy.last)
      if (proxy.mode === 'other-org') return send(200, signAnswer({ ...p, licenceId: 'lic_000000000000' }, signer))
      send(500, { error: 'unknown mode' })
    } catch {
      send(502, { error: 'service unreachable' })
    }
  })
  return new Promise((r) => server.listen(PORT.proxy, '127.0.0.1', () => r(server)))
}

/* ------------------------------------------------------------------ run */

let svc = null
let inst = null
let plain = null
let proxyServer = null
let failed = false
try {
  fs.mkdirSync(run, { recursive: true })
  for (const d of Object.values(dbs)) await sql(conn.maint, `CREATE DATABASE "${d}" ENCODING 'UTF8' TEMPLATE template0`)
  const dbUrl = `postgres://${encodeURIComponent(conn.user)}:${encodeURIComponent(conn.password)}@${conn.host}:${conn.port}/${dbs.svc}`
  const passFile = path.join(run, 'passphrase')
  fs.writeFileSync(passFile, randomBytes(18).toString('base64url'), { mode: 0o600 })
  const svcEnv = { APPBUILDER_LICENCE_DB_URL: dbUrl, APPBUILDER_LICENCE_KEY_PASSPHRASE_FILE: passFile }

  // the signing key pair, made by the service's own command, outside git (the .sandbox folder is git-ignored)
  const kg = await cliRun(['keygen', '--out', path.join(run, 'keys')], svcEnv)
  if (kg.code !== 0) throw new Error(`keygen: ${kg.text}`)
  const keyFile = /Private key: (.+)/.exec(kg.text)[1].trim()
  const pubFile = /Public key:\s+(.+)/.exec(kg.text)[1].trim()
  signer = loadSigningKey(fs.readFileSync(keyFile, 'utf8'), fs.readFileSync(passFile, 'utf8'))
  const other = generateLicenceKey('another-passphrase-x')
  foreign = loadSigningKey(other.privatePem, 'another-passphrase-x')

  const mk = await cliRun(['org', 'create', '--name', 'Exit Check Org', '--plan', 'pilot', '--full', '1', '--operator', '0', '--paid-until', '2099-12-31'], svcEnv)
  const licId = /licence id (lic_[a-z0-9]+)/.exec(mk.text)?.[1]
  if (!licId) throw new Error(`org create: ${mk.text}`)
  const ki = await cliRun(['key', 'issue', licId], svcEnv)
  const installKey = /^(abl_\S+)$/m.exec(ki.text)?.[1]
  if (!installKey) throw new Error(`key issue: ${ki.text}`)
  // the key goes to the install in a file (as an operator would), never on the command line
  const keyPath = path.join(run, 'install.key')
  fs.writeFileSync(keyPath, installKey, { mode: 0o600 })

  const svcProcEnv = { ...svcEnv, APPBUILDER_LICENCE_SIGNING_KEY: keyFile, APPBUILDER_LICENCE_PORT: String(PORT.service), APPBUILDER_LICENCE_HOST: '127.0.0.1' }
  const startSvc = async () => {
    svc = start('service', ['server/licence-service/main.ts', 'serve'], svcProcEnv)
    await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT.service}/healthz`)).ok, 'the licence service')
  }
  await startSvc()
  proxyServer = await startProxy()

  const clockFile = path.join(run, 'clock-offset')
  fs.writeFileSync(clockFile, '0')
  const installEnv = (port, db, ws, licensed) => ({
    PORT: String(port), APPBUILDER_HOST: '127.0.0.1', APPBUILDER_WORKSPACE: ws, APPBUILDER_SETUP_CODE_FILE: path.join(ws, 'setup-code'),
    APPBUILDER_DB_HOST: conn.host, APPBUILDER_DB_PORT: String(conn.port), APPBUILDER_DB_NAME: db, APPBUILDER_DB_USER: conn.user, APPBUILDER_DB_PASSWORD: conn.password,
    APPBUILDER_LICENCE_URL: licensed ? `http://127.0.0.1:${PORT.proxy}` : '', APPBUILDER_LICENCE_ID: licensed ? licId : '', APPBUILDER_LICENCE_KEY_FILE: licensed ? keyPath : '',
    APPBUILDER_LICENCE_KEY: '', APPBUILDER_LICENCE_PUBLIC_KEY_FILE: licensed ? pubFile : '', APPBUILDER_LICENCE_TEST_CLOCK_FILE: licensed ? clockFile : '',
    APPBUILDER_HOSTED: '', APPBUILDER_PUBLIC_URL: '', APPBUILDER_ENV_FILE: '', APPBUILDER_READ_ONLY: '',
  })
  const boot = async (name, port, db, licensed) => {
    const ws = path.join(run, name)
    fs.mkdirSync(ws, { recursive: true })
    const p = start(name, ['server/main.ts'], installEnv(port, db, ws, licensed))
    const base = `http://127.0.0.1:${port}`
    await waitFor(async () => (await fetch(`${base}/api/v1/health`)).status < 500 && fs.existsSync(path.join(ws, 'setup-code')), `install ${name}`)
    const code = fs.readFileSync(path.join(ws, 'setup-code'), 'utf8').split(/\r?\n/)[0].trim()
    const a = new Api(base)
    const s = await a.post('/setup/admin', { setupCode: code, name: 'Ada', email: 'ada@example.test', password: 'admin-password-1' })
    if (s.status !== 200) throw new Error(`setup of ${name}: ${JSON.stringify(s.data)}`)
    return { p, a, base }
  }

  // ---------------------------------------------------------------- 1. licensed start
  const I = await boot('install', PORT.install, dbs.inst, true)
  inst = I.p
  const A = I.a
  const table = await A.post('/tables', { displayName: 'Exit items', name: 'ExitItems', columns: [{ displayName: 'Title', type: 'text' }] })
  if (table.status !== 200) throw new Error(`table: ${JSON.stringify(table.data)}`)
  const write = () => A.post(`/data/${table.data.id}/rows`, { values: { Title: 'x' } })
  let st = (await A.post('/install/licence/check')).data
  ok('1. licensed start: verified, writable', st.licence.mode === 'ok' && (await write()).status === 200, `status ${st.licence.licence?.status}, plan ${st.licence.licence?.plan}`)

  // ---------------------------------------------------------------- seats
  const op = await A.post('/users', { name: 'Olu Operator', email: 'olu@example.test', roleIds: [], password: 'operator-pass-12' })
  const assign = await A.put('/install/licence/passes', { userIds: [op.data.id], pass: 'operator' })
  st = (await A.post('/install/licence/check')).data
  const reported = (await sql(dbs.svc, `SELECT seats FROM lic.checkins WHERE org_id = $1 ORDER BY id DESC LIMIT 1`, [licId]))[0]?.seats
  ok('seat counts reported to the service (counts only)', assign.status === 200 && reported?.full === 1 && reported?.operator === 1 && reported?.external === 0, JSON.stringify(reported))
  ok('over-seat warning shown (1 Operator, 0 licensed), nobody locked out', !!st.seats?.over?.operator && st.seats.over.operator.blocked === false, `over since ${st.seats?.over?.operator?.since}, blocked from ${st.seats?.over?.operator?.blockedFrom}`)
  const cols = (await sql(dbs.svc, `SELECT column_name FROM information_schema.columns WHERE table_schema = 'lic' AND table_name IN ('checkins', 'installs')`)).map((r) => r.column_name)
  ok('the service stores no personal data (no email, name or address columns)', !cols.some((c) => /mail|name|addr|ip/.test(c)), [...new Set(cols)].sort().join(', '))

  // ---------------------------------------------------------------- refused answers (none may renew the grace)
  const validAt = Date.parse(st.licence.licence.receivedAt)
  for (const [mode, label, re] of [['forge', 'a forged answer (payload changed)', /signature/], ['foreign', 'an answer signed by another key', /does not trust/], ['replay', 'a replayed old answer', /another request/], ['other-org', 'an answer for another organisation', /another licence/]]) {
    proxy.mode = mode
    const r = (await A.post('/install/licence/check')).data.licence
    ok(`refused: ${label}`, r.lastCheck?.ok === false && re.test(r.lastCheck.error ?? '') && Date.parse(r.licence.receivedAt) === validAt && r.mode !== 'ok' && r.readOnly === null, r.lastCheck?.error)
  }

  // ---------------------------------------------------------------- 2. service stopped
  proxy.mode = 'pass'
  st = (await A.post('/install/licence/check')).data
  const lastGood = Date.parse(st.licence.licence.receivedAt)
  await stop(svc)
  st = (await A.post('/install/licence/check')).data
  const expected = new Date(lastGood + 72 * H).toISOString()
  ok('2. service stopped: warning with the exact time, still writable', st.licence.mode === 'warning' && st.licence.readOnlyAt === expected && st.licence.warnings.join(' ').includes(expected.slice(0, 16).replace('T', ' ')) && (await write()).status === 200, `read-only at ${st.licence.readOnlyAt}`)

  // ---------------------------------------------------------------- 3. clock past 72 h
  fs.writeFileSync(clockFile, String(lastGood + 72 * H + 2 * 60_000 - Date.now()))
  await new Promise((r) => setTimeout(r, 700))
  st = (await A.post('/install/licence/check')).data
  const w = await write()
  const ticket = await A.post('/admin/export-data/ticket', {})
  const zip = ticket.status === 200 ? await fetch(I.base + ticket.data.url, { headers: { Cookie: A.cookie } }) : null
  await A.post('/auth/logout')
  const login = await A.post('/auth/login', { email: 'ada@example.test', password: 'admin-password-1' })
  ok('3. clock past 72 h: read-only with the licence reason', st.licence.mode === 'read-only' && w.status === 503 && w.data?.error?.code === 'licence_read_only' && w.data?.readOnly?.reason === 'licence', `${w.status} ${w.data?.error?.code}`)
  ok('   export still works (data export ZIP)', zip?.status === 200 && zip.headers.get('content-type') === 'application/zip')
  ok('   sign-in still works', login.status === 200)

  // ---------------------------------------------------------------- 4. clock back
  fs.writeFileSync(clockFile, '0')
  await new Promise((r) => setTimeout(r, 700))
  st = (await A.post('/install/licence/check')).data
  ok('4. clock moved back does not restore writes', st.licence.mode === 'read-only' && st.licence.clockBack === true && (await write()).status === 503, st.licence.readOnly?.message?.slice(0, 90))

  // ---------------------------------------------------------------- 5. service back
  await startSvc()
  st = (await A.post('/install/licence/check')).data
  ok('5. service back: writable at once', st.licence.mode !== 'read-only' && (await write()).status === 200, st.licence.mode)

  // ---------------------------------------------------------------- 6. suspended by the operator
  const sus = await cliRun(['suspend', licId, '--message', 'Exit check suspension.'], svcEnv)
  st = (await A.post('/install/licence/check')).data
  const w2 = await write()
  ok('6. suspended by the operator: read-only with that reason', sus.code === 0 && w2.status === 503 && w2.data?.readOnly?.reason === 'suspended' && /Exit check suspension/.test(w2.data?.error?.message ?? ''), `${w2.status} ${w2.data?.readOnly?.reason}`)
  await cliRun(['resume', licId], svcEnv)
  st = (await A.post('/install/licence/check')).data
  ok('   resumed: writable', (await write()).status === 200)
  const audit = await sql(dbs.svc, `SELECT command FROM lic.audit`)
  ok('every operator command is audited', ['org create', 'key issue', 'suspend', 'resume'].every((c) => audit.some((a) => a.command === c)), `${audit.length} entries`)

  // ---------------------------------------------------------------- 7. Operator pass
  const O = new Api(I.base)
  await sql(dbs.inst, `UPDATE "ab"."users" SET must_change_password = false WHERE email = 'olu@example.test'`)
  await O.post('/auth/login', { email: 'olu@example.test', password: 'operator-pass-12' })
  const sess = await O.get('/auth/session')
  ok('Operator pass: no maker features on the server', sess.data?.privileges?.isMaker === false && (await O.post('/tables', { displayName: 'No', name: 'NoTable', columns: [] })).status === 403)

  // ---------------------------------------------------------------- 8. unlicensed install
  const P = await boot('plain', PORT.plain, dbs.plain, false)
  plain = P.p
  const pl = (await P.a.get('/install/licence')).data
  const pt = await P.a.post('/tables', { displayName: 'Plain', name: 'Plain', columns: [{ displayName: 'Title', type: 'text' }] })
  ok('unlicensed install: works as before (no licence, nothing sent, writable)', pl.licence.configured === false && pl.licence.mode === 'unlicensed' && pt.status === 200)
} catch (e) {
  failed = true
  process.stderr.write(`The licence exit check could not run: ${e instanceof Error ? e.stack : String(e)}\n`)
} finally {
  for (const p of [inst, plain, svc, ...procs]) await stop(p)
  await new Promise((r) => (proxyServer ? proxyServer.close(() => r()) : r()))
  for (const d of Object.values(dbs)) await sql(conn.maint, `DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`).catch((e) => log(`could not drop ${d}: ${e.message}`))
  if (process.env.LIC_KEEP !== '1') fs.rmSync(run, { recursive: true, force: true })
}

const md = ['| Check | Result | Detail |', '| --- | --- | --- |', ...results.map((r) => `| ${r.name} | ${r.pass ? 'pass' : 'FAIL'} | ${String(r.detail ?? '').replace(/\|/g, '/').slice(0, 140)} |`)].join('\n')
console.log(md)
console.log(`\n${results.filter((r) => r.pass).length} of ${results.length} passed. Not shown here (needs the rented Linux server): Caddy in front of the service with real TLS, the service under systemd, the release built with a vendor licence key.`)
process.exit(failed ? 2 : results.some((r) => !r.pass) ? 1 : 0)
