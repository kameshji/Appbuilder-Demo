/**
 * Real installs for the load test (scripts/bench/load): one process of THIS tree per organisation (`node server/main.ts`),
 * hosted settings on (APPBUILDER_HOSTED=1: pool 6, job polling 5 s, trusted proxy, __Host- cookies, outbound private
 * deny, setup closed), its own database and role made exactly as the fleet tool makes them (createInstallDatabase of the
 * isolation suite, scripts/fleet/testing/fleet.mjs: no superuser, CONNECT only to its own database, connection limit 12,
 * statement timeout 60 s), its own instance folder, workspace and secret key, its locked https public URL, first-run setup
 * by `seed-config`, `migrate` and `admin invite` (spec section 5). Ports 5410-5499 on 127.0.0.1 (the spec's TCP
 * fallback, DC-3: Windows has no Unix sockets for the server). The harness talks to each install directly with the
 * headers Caddy would set (Host, X-Forwarded-For, X-Forwarded-Proto https): no proxy process in the measured path.
 *
 * Every process started here is registered and killed on exit, on Ctrl-C and on failure; every database and role is
 * dropped with the private cluster.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createInstallDatabase } from '../../../fleet/testing/fleet.mjs'
import { root, sleep, WIN } from './util.mjs'

const MAIN = path.join(root, 'server', 'main.ts')
export const DOMAIN = 'load.test.invalid'
export const INSTALL_PORTS = [5410, 5499]
const FORBIDDEN = new Set([5174, 5433, 5435])

/* ------------------------------------------------------------------ cleanup registry */

const children = new Set()
const exitHooks = []
let handlersOn = false
export function onCleanup(fn) { exitHooks.push(fn) }
export function installHandlers(stopAsync) {
  if (handlersOn) return
  handlersOn = true
  const hard = () => {
    for (const c of children) { try { c.kill('SIGKILL') } catch { /* gone */ } }
    for (const f of exitHooks) { try { f() } catch { /* best effort */ } }
  }
  process.once('exit', hard)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => {
      process.stderr.write(`\n${sig}: stopping the load test fleet and its PostgreSQL...\n`)
      const t = setTimeout(() => process.exit(130), 60_000)
      t.unref()
      stopAsync().catch(() => {}).finally(() => process.exit(130))
    })
  }
}
export const liveChildren = () => [...children].filter((c) => c.exitCode === null && c.signalCode === null)

/* ------------------------------------------------------------------ one process */

function spawnTracked(args, env, cwd = root) {
  const c = spawn(process.execPath, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  children.add(c)
  c.on('exit', () => children.delete(c))
  return c
}

function cli(inst, args, input) {
  return new Promise((resolve) => {
    const c = spawnTracked([MAIN, ...args], inst.env)
    let stdout = ''
    let stderr = ''
    c.stdout.on('data', (x) => { stdout += x })
    c.stderr.on('data', (x) => { stderr += x })
    const t = setTimeout(() => c.kill('SIGKILL'), 180_000)
    c.on('exit', (status) => { clearTimeout(t); resolve({ status, stdout, stderr }) })
    c.stdin.end(input ?? '')
  })
}

/** a request straight to an install, as Caddy forwards it */
export function rawRequest(inst, method, p, o = {}) {
  return new Promise((resolve) => {
    const payload = o.body === undefined ? undefined : typeof o.body === 'string' || Buffer.isBuffer(o.body) ? o.body : JSON.stringify(o.body)
    const headers = {
      host: inst.host, 'x-appbuilder': '1', 'x-forwarded-proto': 'https', 'x-forwarded-for': o.ip ?? '198.51.100.1',
      ...(payload !== undefined ? { 'content-type': o.contentType ?? 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
      ...(o.cookie ? { cookie: o.cookie } : {}),
      ...(o.headers ?? {}),
    }
    const req = http.request({ host: '127.0.0.1', port: inst.port, method, path: p, headers, timeout: o.timeout ?? 120_000, agent: o.agent ?? false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        resolve({ status: res.statusCode ?? 0, headers: res.headers, buf, json: () => { try { return JSON.parse(buf.toString('utf8')) } catch { return null } } })
      })
      res.on('error', (e) => resolve({ status: 0, headers: {}, buf: Buffer.from(String(e)), json: () => null }))
    })
    req.on('error', (e) => resolve({ status: 0, headers: {}, buf: Buffer.from(`network: ${e.code ?? e.message}`), json: () => null }))
    req.on('timeout', () => req.destroy(new Error('timeout')))
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

export function sessionCookie(r) {
  const set = [].concat(r.headers['set-cookie'] ?? []).find((c) => /^(__Host-)?ab_session=/.test(c))
  return set ? set.split(';')[0] : ''
}

/* ------------------------------------------------------------------ provisioning */

const b32 = (n) => [...randomBytes(n)].map((x) => 'abcdefghijklmnopqrstuvwxyz234567'[x & 31]).join('')

/**
 * createInstall(ctx, i) -> the install, set up and started. ctx: { cluster, runDir, basePort }.
 */
export async function createInstall(ctx, i, log) {
  const port = ctx.basePort + i
  if (port < INSTALL_PORTS[0] || port > INSTALL_PORTS[1] || FORBIDDEN.has(port)) throw new Error(`install port ${port} is outside ${INSTALL_PORTS.join('-')}`)
  const key = `org${String(i + 1).padStart(2, '0')}`
  const name = `ab_load_o${b32(8)}`
  const password = randomBytes(18).toString('base64url')
  await createInstallDatabase({ admin: (db) => ctx.cluster.admin(db ?? 'postgres') }, name, password)
  const dir = path.join(ctx.runDir, 'installs', key)
  const workspace = path.join(dir, 'workspace')
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, '.secret-key'), randomBytes(32).toString('hex') + '\n', { mode: 0o600 })
  const host = `${key}.${DOMAIN}`
  const lines = {
    APPBUILDER_HOSTED: '1',
    APPBUILDER_PUBLIC_URL: `https://${host}`,
    APPBUILDER_INSTANCE_DIR: dir,
    APPBUILDER_WORKSPACE: workspace,
    APPBUILDER_BACKUP_DIR: path.join(dir, 'backups'),
    APPBUILDER_OUTBOUND_DENY: `*.${DOMAIN}`,
    APPBUILDER_MIGRATION_BACKUP: 'skip',
    PORT: String(port),
    APPBUILDER_HOST: '127.0.0.1',
    ...(ctx.extraEnv ?? {}),
  }
  const envFile = path.join(dir, 'instance.env')
  fs.writeFileSync(envFile, Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o640 })
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: path.join(dir, 'tmp'), TMP: path.join(dir, 'tmp'), TMPDIR: path.join(dir, 'tmp'),
    HOME: dir, USERPROFILE: dir, APPBUILDER_ENV_FILE: envFile,
    // the systemd unit's heap limit (spec section 4: --max-old-space-size=1024)
    NODE_OPTIONS: `--max-old-space-size=${ctx.heapMB ?? 1024}`,
  }
  const inst = { i, key, host, port, url: `https://${host}`, dbName: name, password, dir, workspace, env, envFile, output: '', child: null }
  const seed = await cli(inst, ['seed-config', '--workspace', workspace, '--db-host', ctx.cluster.conn.host, '--db-port', String(ctx.cluster.conn.port), '--db-name', name, '--db-user', name], password + '\n')
  if (seed.status !== 0) throw new Error(`seed-config (${key}): ${seed.stderr || seed.stdout}`)
  const m = await cli(inst, ['migrate'])
  if (m.status !== 0) throw new Error(`migrate (${key}): ${m.stderr || m.stdout}`)
  const email = `admin@${key}.example.test`
  const inv = await cli(inst, ['admin', 'invite', '--email', email, '--name', `Admin ${key}`, '--print-link'])
  if (inv.status !== 0) throw new Error(`admin invite (${key}): ${inv.stderr || inv.stdout}`)
  const token = decodeURIComponent(/#invite=(\S+)/.exec(inv.stdout + inv.stderr)?.[1] ?? '')
  if (!token) throw new Error(`admin invite (${key}) printed no link`)
  const t0 = Date.now()
  await startInstall(inst)
  inst.startMs = Date.now() - t0
  inst.adminEmail = email
  inst.adminPassword = `Ld-${randomBytes(12).toString('base64url')}-9`
  const r = await rawRequest(inst, 'POST', '/api/v1/auth/invitation/accept', { body: { token, password: inst.adminPassword } })
  if (r.status !== 200) throw new Error(`invitation (${key}): ${r.status} ${r.buf.toString().slice(0, 300)}`)
  inst.adminCookie = sessionCookie(r)
  inst.adminId = r.json()?.user?.id
  log?.(`  ${key}: ${host} on 127.0.0.1:${port}, database ${name}, started in ${inst.startMs} ms`)
  return inst
}

export async function startInstall(inst) {
  inst.output = ''
  const child = spawnTracked([MAIN], inst.env)
  child.stdin.end()
  inst.child = child
  inst.pid = child.pid
  const keep = (c) => { inst.output = (inst.output + String(c)).slice(-20_000) }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  child.on('exit', (code, sig) => { inst.exited = { code, sig, at: Date.now() } })
  const until = Date.now() + 180_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`install ${inst.key} stopped: ${inst.output.slice(-3000)}`)
    const h = await rawRequest(inst, 'GET', '/api/v1/health', { timeout: 3000 })
    if (h.status === 200) return
    if (Date.now() > until) throw new Error(`install ${inst.key} did not answer: ${inst.output.slice(-3000)}`)
    await sleep(300)
  }
}

export async function stopInstall(inst) {
  const c = inst.child
  if (!c || c.exitCode !== null) return
  const exited = new Promise((r) => c.once('exit', r))
  c.kill(WIN ? undefined : 'SIGTERM')
  await Promise.race([exited, sleep(20_000)])
  if (c.exitCode === null) { c.kill('SIGKILL'); await Promise.race([exited, sleep(5000)]) }
}

/** drops every ab_load_* database and role of the cluster (the cluster is removed afterwards anyway) */
export async function dropAll(cluster) {
  const c = await cluster.admin()
  try {
    for (const d of (await c.query(`SELECT datname FROM pg_database WHERE datname LIKE 'ab\\_load\\_%'`)).rows) await c.query(`DROP DATABASE IF EXISTS "${d.datname}" WITH (FORCE)`).catch(() => {})
    for (const r of (await c.query(`SELECT rolname FROM pg_roles WHERE rolname LIKE 'ab\\_load\\_%'`)).rows) await c.query(`DROP ROLE IF EXISTS "${r.rolname}"`).catch(() => {})
  } finally { await c.end() }
}

/** run fn over items with at most n at once */
export async function pool(items, n, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const k = next++; out[k] = await fn(items[k], k) }
  }))
  return out
}
