/**
 * A small fleet for the cross-instance isolation suite (H-B; docs/plan/hosting-spec.md exit check 2). DEVELOPER AND CI
 * TOOL, not part of the product. It starts real installs of THIS tree (`node server/main.ts`), each as its own process
 * with its own database and PostgreSQL role (set up the way the fleet tool will: no superuser, CREATEDB or CREATEROLE,
 * CONNECT only to its own database, PUBLIC revoked on it and on postgres / template1, connection limits, statement
 * timeout), its own folder, workspace and secret key, its own locked https public URL, hosted settings on, behind an
 * in-process reverse proxy that routes by exact host name the way the Caddy site template does (catch-all 404, the
 * canonical Host only, X-Forwarded-Host removed, X-Forwarded-For replaced by the client's address, X-Forwarded-Proto
 * https). No TLS: the proxy terminates "https" by saying so in X-Forwarded-Proto, as Caddy does to its upstream.
 *
 * PostgreSQL, in this order:
 *   APPBUILDER_HB_ADMIN_DB=postgres://<superuser>:<pw>@127.0.0.1:<port>/postgres   a cluster the suite may change
 *       (CI: the job's own service container). The suite revokes CONNECT on postgres / template1 from PUBLIC for the run
 *       and grants it back afterwards; APPBUILDER_HB_SHARED_CLUSTER=1 leaves them alone (those two checks are then
 *       reported as not run).
 *   otherwise a private cluster: initdb + pg_ctl from APPBUILDER_HB_PG_BIN (default .sandbox/pg/pgsql/bin) on
 *       127.0.0.1:APPBUILDER_HB_PG_PORT (default 5319), password authentication (scram-sha-256), removed afterwards.
 *       Private, because revoking CONNECT on postgres / template1 in a shared cluster breaks every other test suite
 *       that creates databases through them.
 * Ports 5300-5319 (proxy 5300, installs 5301-5303, canaries 5310-5311, private cluster 5319). 5174 and 5433 are refused.
 * Everything created is named ab_hb_* and removed by stop(), also after a failure and on Ctrl-C.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const MAIN = path.join(root, 'server', 'main.ts')
const SHIM = pathToFileURL(path.join(root, 'scripts', 'fleet', 'testing', 'dns-shim.mjs')).href
export const WIN = process.platform === 'win32'
export const DOMAIN = 'hb.test.invalid'
export const DNS_DOMAIN = 'hb-dns.test.invalid'
const FORBIDDEN_PORTS = new Set([5174, 5433])
export const PORTS = { proxy: 5300, a: 5301, b: 5302, c: 5303, httpCanary: 5310, tcpCanary: 5311, pg: Number(process.env.APPBUILDER_HB_PG_PORT || 5319) }
for (const p of Object.values(PORTS)) if (FORBIDDEN_PORTS.has(p)) throw new Error(`port ${p} is not a sandbox port`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const b32 = (n) => [...randomBytes(n)].map((x) => 'abcdefghijklmnopqrstuvwxyz234567'[x & 31]).join('')
export const opaqueId = () => `ab_hb_o${b32(8)}`

/** the test DNS (dns-shim.mjs): org names point at the fleet server (this machine), the others at the named targets */
export const DNS_MAP = {
  [`*.${DOMAIN}`]: '127.0.0.1',
  [`loop.${DNS_DOMAIN}`]: '127.0.0.1',
  [`ten.${DNS_DOMAIN}`]: '10.0.0.7',
  [`six.${DNS_DOMAIN}`]: '::1',
  [`mapped.${DNS_DOMAIN}`]: '::ffff:127.0.0.1',
  [`meta.${DNS_DOMAIN}`]: '169.254.169.254',
  [`cgnat.${DNS_DOMAIN}`]: '100.64.0.9',
}

/* ------------------------------------------------------------------ cleanup registry (also on Ctrl-C) */

const children = new Set()
const syncStops = []
let handlersOn = false
function installHandlers(stopAsync) {
  if (handlersOn) return
  handlersOn = true
  const hard = () => {
    for (const c of children) { try { c.kill('SIGKILL') } catch { /* gone */ } }
    for (const f of syncStops) { try { f() } catch { /* best effort */ } }
  }
  process.once('exit', hard)
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      process.stderr.write(`\n${sig}: stopping the test fleet...\n`)
      const t = setTimeout(() => process.exit(130), 20_000)
      t.unref()
      stopAsync().catch(() => {}).finally(() => process.exit(130))
    })
  }
}

/* ------------------------------------------------------------------ HTTP helper */

/**
 * one request; target: { port } (TCP on 127.0.0.1) or { socketPath }. raw: send exactly these bytes (request line and
 * headers chosen by the test) and read the answer.
 */
export function call(target, method, p, o = {}) {
  if (o.raw) return rawCall(target, o.raw)
  return new Promise((resolve) => {
    const payload = o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body)
    const headers = {
      ...(o.host !== null ? { host: o.host ?? 'localhost' } : {}),
      'x-appbuilder': '1',
      ...(payload !== undefined ? { 'content-type': o.contentType ?? 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
      ...(o.cookie ? { cookie: o.cookie } : {}),
      ...(o.headers ?? {}),
    }
    const req = http.request({ ...(target.socketPath ? { socketPath: target.socketPath } : { host: '127.0.0.1', port: target.port }), method, path: p, headers, timeout: o.timeout ?? 30_000, agent: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => { try { return JSON.parse(body) } catch { return null } } })
      })
      res.on('error', (e) => resolve({ status: 0, headers: {}, body: String(e), json: () => null }))
    })
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: `network: ${e.code ?? e.message}`, json: () => null }))
    req.on('timeout', () => req.destroy(new Error('timeout')))
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

function rawCall(target, bytes) {
  return new Promise((resolve) => {
    const s = target.socketPath ? net.connect(target.socketPath) : net.connect(target.port, '127.0.0.1')
    const chunks = []
    const done = () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? 0)
      const i = text.indexOf('\r\n\r\n')
      resolve({ status, headers: {}, head: i >= 0 ? text.slice(0, i) : text, body: i >= 0 ? text.slice(i + 4) : '', json: () => null })
    }
    s.setTimeout(15_000, () => s.destroy())
    s.on('data', (c) => {
      chunks.push(c)
      // one answer is enough (keep-alive would otherwise wait for the timeout)
      const t = Buffer.concat(chunks).toString('utf8')
      const i = t.indexOf('\r\n\r\n')
      const len = /content-length:\s*(\d+)/i.exec(t)?.[1]
      if (i >= 0 && len !== undefined && Buffer.byteLength(t.slice(i + 4)) >= Number(len)) s.destroy()
      if (i >= 0 && /^HTTP\/1\.1 101/.test(t)) s.destroy()
    })
    s.on('close', done)
    s.on('error', () => {})
    s.write(bytes)
  })
}

/* ------------------------------------------------------------------ PostgreSQL */

async function client(conn, database) {
  const c = new pg.Client({ host: conn.host, port: conn.port, user: conn.user, password: conn.password, database, connectionTimeoutMillis: 10_000 })
  c.on('error', () => {})
  await c.connect()
  return c
}

/** tries to connect; returns 'connected' or the PostgreSQL error code and message (never the password) */
export async function tryConnect(conn, database) {
  let c
  try {
    c = await client(conn, database)
    return { ok: true, code: 'connected', message: 'connected' }
  } catch (e) {
    return { ok: false, code: e.code ?? 'error', message: String(e.message ?? e).replace(conn.password, '***') }
  } finally {
    if (c) await c.end().catch(() => {})
  }
}

async function startPrivateCluster(run) {
  const bin = process.env.APPBUILDER_HB_PG_BIN || path.join(root, '.sandbox', 'pg', 'pgsql', 'bin')
  const exe = (n) => path.join(bin, n + (WIN ? '.exe' : ''))
  if (!fs.existsSync(exe('initdb'))) throw new Error(`No PostgreSQL for the isolation suite: set APPBUILDER_HB_ADMIN_DB (a cluster the suite may change) or APPBUILDER_HB_PG_BIN (a folder with initdb and pg_ctl); ${bin} has no initdb.`)
  // a cluster left by an earlier run of this suite that was killed: stopped (only clusters in our own folder)
  for (const n of fs.readdirSync(run.base).filter((x) => x.startsWith('pgdata-'))) {
    const d = path.join(run.base, n)
    if (fs.existsSync(path.join(d, 'postmaster.pid'))) spawnSync(exe('pg_ctl'), ['stop', '-D', d, '-m', 'immediate', '-w'], { stdio: 'ignore', timeout: 30_000 })
    fs.rmSync(d, { recursive: true, force: true })
  }
  const data = path.join(run.base, `pgdata-${run.id}`)
  const password = randomBytes(18).toString('base64url')
  const pw = path.join(run.dir, 'pw.txt')
  fs.writeFileSync(pw, password + '\n', { mode: 0o600 })
  const init = spawnSync(exe('initdb'), ['-D', data, '-U', 'postgres', '--pwfile', pw, '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '-E', 'UTF8', '--no-instructions'], { encoding: 'utf8', timeout: 120_000 })
  fs.rmSync(pw, { force: true })
  if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr || init.stdout}`)
  const sockDir = WIN ? '' : fs.mkdtempSync(path.join('/tmp', 'abhbpg-'))
  // the settings in postgresql.conf (no quoting of paths with spaces on a command line)
  fs.appendFileSync(path.join(data, 'postgresql.conf'), [
    '', '# isolation suite (scripts/fleet/testing/fleet.mjs)', `port = ${PORTS.pg}`, "listen_addresses = '127.0.0.1'", 'fsync = off', 'max_connections = 150',
    `unix_socket_directories = '${WIN ? '' : sockDir}'`, '',
  ].join('\n'))
  const st = spawnSync(exe('pg_ctl'), ['start', '-D', data, '-w', '-t', '60', '-l', path.join(run.dir, 'pg.log')], { encoding: 'utf8', timeout: 90_000 })
  if (st.status !== 0) throw new Error(`pg_ctl start failed: ${st.stderr || st.stdout} ${fs.existsSync(path.join(run.dir, 'pg.log')) ? fs.readFileSync(path.join(run.dir, 'pg.log'), 'utf8').slice(-2000) : ''}`)
  const stop = () => {
    spawnSync(exe('pg_ctl'), ['stop', '-D', data, '-m', 'fast', '-w', '-t', '30'], { stdio: 'ignore', timeout: 60_000 })
    fs.rmSync(data, { recursive: true, force: true })
    if (sockDir) fs.rmSync(sockDir, { recursive: true, force: true })
  }
  syncStops.push(stop)
  return { conn: { host: '127.0.0.1', port: PORTS.pg, user: 'postgres', password }, adminDb: 'postgres', mode: 'private', unixSocketDir: sockDir || null, stop }
}

function externalCluster() {
  const u = new URL(process.env.APPBUILDER_HB_ADMIN_DB)
  const port = Number(u.port) || 5432
  if (FORBIDDEN_PORTS.has(port)) throw new Error(`APPBUILDER_HB_ADMIN_DB points at port ${port}, which is not a sandbox: refused.`)
  return { conn: { host: u.hostname, port, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }, adminDb: u.pathname.slice(1) || 'postgres', mode: 'external', unixSocketDir: process.env.APPBUILDER_HB_PG_SOCKET_DIR || null, stop: () => {} }
}

/* ------------------------------------------------------------------ the proxy (Caddy's routing, without TLS) */

function startProxy(sites, log) {
  const route = (req) => {
    // an absolute request target names the host (Go's net/http, which Caddy uses, does the same)
    let host = String(req.headers.host ?? '')
    let p = req.url ?? '/'
    const abs = /^https?:\/\/([^/]+)(\/.*)?$/i.exec(p)
    if (abs) { host = abs[1]; p = abs[2] ?? '/' }
    const name = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
    return { site: sites.get(name), name, p }
  }
  const upstreamHeaders = (req, name) => {
    const h = { ...req.headers }
    delete h['x-forwarded-host']
    delete h['forwarded']
    h.host = name
    h['x-forwarded-for'] = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    h['x-forwarded-proto'] = 'https'
    return h
  }
  const server = http.createServer((req, res) => {
    const { site, name, p } = route(req)
    log.push({ host: name, path: p })
    if (!site) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no site'); return }
    const up = http.request({ ...site.target(), method: req.method, path: p, headers: upstreamHeaders(req, name), agent: false }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    })
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.pipe(up)
  })
  server.on('upgrade', (req, socket, head) => {
    const { site, name, p } = route(req)
    if (!site) { socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'); return }
    const t = site.target()
    const up = t.socketPath ? net.connect(t.socketPath) : net.connect(t.port, '127.0.0.1')
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
    up.on('connect', () => {
      const h = upstreamHeaders(req, name)
      up.write(`${req.method} ${p} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`)
      if (head?.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORTS.proxy, '127.0.0.1', () => resolve(server))
  })
}

/** TCP listeners on loopback that record every connection: an outbound call that reaches one was not refused */
async function startCanaries() {
  const hits = { http: [], tcp: [] }
  const mk = (kind, port, host) => new Promise((resolve) => {
    const s = net.createServer((sock) => {
      hits[kind].push({ at: Date.now(), host })
      sock.on('error', () => {})
      sock.once('data', () => {
        if (kind === 'http') sock.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 6\r\nConnection: close\r\n\r\ncanary')
        else sock.end()
      })
      setTimeout(() => sock.destroy(), 3000).unref()
    })
    s.on('error', () => resolve(null))
    s.listen(port, host, () => resolve(s))
  })
  const servers = []
  for (const host of ['127.0.0.1', '::1']) {
    servers.push(await mk('http', PORTS.httpCanary, host), await mk('tcp', PORTS.tcpCanary, host))
  }
  return { hits, close: () => Promise.all(servers.filter(Boolean).map((s) => new Promise((r) => s.close(() => r())))) }
}

/* ------------------------------------------------------------------ the fleet */

/**
 * startFleet({ installs: ['a', 'b', 'c'] }) -> the fleet; always call fleet.stop() (it is also called on Ctrl-C).
 * Each install: { key, host, url, dbName, role, password, secretKey, dir, workspace, target(), out(), env, adminCookie }.
 */
export async function startFleet(o = {}) {
  const keys = o.installs ?? ['a', 'b', 'c']
  const base = path.join(root, '.sandbox', 'hb')
  fs.mkdirSync(base, { recursive: true })
  const run = { id: `${Date.now().toString(36)}${b32(3)}`, base }
  run.dir = fs.mkdtempSync(path.join(base, `run-${run.id}-`))
  const fleet = { run, installs: {}, sites: new Map(), proxyLog: [], notes: [], stopped: false }
  /** a request through the proxy, as a client on the internet sends it (Host names the site) */
  fleet.via = (host, method, p, o = {}) => call({ port: PORTS.proxy }, method, p, { ...o, host })
  const stop = async () => {
    if (fleet.stopped) return
    fleet.stopped = true
    for (const inst of Object.values(fleet.installs)) await stopInstall(inst)
    await new Promise((r) => (fleet.proxy ? fleet.proxy.close(() => r()) : r()))
    await fleet.canaries?.close().catch(() => {})
    if (fleet.cluster) {
      await dropAll(fleet).catch((e) => fleet.notes.push(`cleanup: ${e.message}`))
      fleet.cluster.stop()
    }
    if (!process.env.HB_KEEP) {
      fs.rmSync(run.dir, { recursive: true, force: true })
      if (fleet.sockDir) fs.rmSync(fleet.sockDir, { recursive: true, force: true })
    }
  }
  fleet.stop = stop
  installHandlers(stop)
  try {
    fleet.cluster = process.env.APPBUILDER_HB_ADMIN_DB ? externalCluster() : await startPrivateCluster(run)
    fleet.admin = (db) => client(fleet.cluster.conn, db ?? fleet.cluster.adminDb)
    fleet.canaries = await startCanaries()
    fleet.proxy = await startProxy(fleet.sites, fleet.proxyLog)
    if (!WIN) fleet.sockDir = fs.mkdtempSync(path.join('/tmp', 'abhb-'))
    const made = await Promise.all(keys.map((k) => createInstall(fleet, k)))
    keys.forEach((k, i) => { fleet.installs[k] = made[i] })
    await Promise.all(keys.map((k) => startInstall(fleet.installs[k])))
    for (const k of keys) await firstAdmin(fleet, fleet.installs[k])
    return fleet
  } catch (e) {
    await stop()
    throw e
  }
}

/** the cluster preparation of the fleet tool (install.sh --fleet): PUBLIC loses CONNECT on postgres and template1 */
export async function revokeShared(fleet) {
  if (process.env.APPBUILDER_HB_SHARED_CLUSTER === '1') return false
  const c = await fleet.admin()
  try {
    fleet.sharedBefore = {}
    for (const d of ['postgres', 'template1']) {
      fleet.sharedBefore[d] = (await c.query(`SELECT has_database_privilege('public', $1, 'CONNECT') AS ok`, [d])).rows[0].ok
      await c.query(`REVOKE CONNECT ON DATABASE "${d}" FROM PUBLIC`)
    }
    return true
  } finally {
    await c.end()
  }
}

/** a database and role exactly as the fleet tool creates them (spec section 4 and threat model row 2) */
export async function createInstallDatabase(fleet, name, password, o = {}) {
  const c = await fleet.admin()
  try {
    await c.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 12`)
    await c.query(`ALTER ROLE "${name}" SET statement_timeout = '60s'`)
    await c.query(`ALTER ROLE "${name}" SET idle_in_transaction_session_timeout = '5min'`)
    await c.query(`CREATE DATABASE "${name}" OWNER "${name}" ENCODING 'UTF8' TEMPLATE template0 CONNECTION LIMIT 12`)
    if (!o.defaultGrants) {
      await c.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`)
      await c.query(`GRANT CONNECT, TEMPORARY ON DATABASE "${name}" TO "${name}"`)
    }
  } finally {
    await c.end()
  }
  const d = await fleet.admin(name)
  try {
    await d.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
    await d.query('CREATE EXTENSION IF NOT EXISTS pg_trgm')
  } finally {
    await d.end()
  }
}

async function dropAll(fleet) {
  const c = await fleet.admin()
  try {
    const dbs = (await c.query(`SELECT datname FROM pg_database WHERE datname LIKE 'ab\\_hb\\_%'`)).rows.map((r) => r.datname)
    for (const d of dbs) await c.query(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`).catch((e) => fleet.notes.push(`drop ${d}: ${e.message}`))
    const roles = (await c.query(`SELECT rolname FROM pg_roles WHERE rolname LIKE 'ab\\_hb\\_%'`)).rows.map((r) => r.rolname)
    for (const r of roles) await c.query(`DROP ROLE IF EXISTS "${r}"`).catch((e) => fleet.notes.push(`drop role ${r}: ${e.message}`))
    if (fleet.sharedBefore) for (const [d, was] of Object.entries(fleet.sharedBefore)) if (was) await c.query(`GRANT CONNECT ON DATABASE "${d}" TO PUBLIC`)
  } finally {
    await c.end()
  }
}

async function createInstall(fleet, key) {
  const name = opaqueId()
  const password = randomBytes(18).toString('base64url')
  await createInstallDatabase(fleet, name, password)
  const dir = path.join(fleet.run.dir, key)
  const workspace = path.join(dir, 'workspace')
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  const secretKey = randomBytes(32).toString('hex')
  fs.writeFileSync(path.join(workspace, '.secret-key'), secretKey + '\n', { mode: 0o600 })
  const host = `${key}.${DOMAIN}`
  const socketPath = fleet.sockDir ? path.join(fleet.sockDir, `${key}.sock`) : null
  const lines = {
    APPBUILDER_HOSTED: '1',
    APPBUILDER_PUBLIC_URL: `https://${host}`,
    APPBUILDER_INSTANCE_DIR: dir,
    APPBUILDER_WORKSPACE: workspace,
    APPBUILDER_BACKUP_DIR: path.join(dir, 'backups'),
    // the fleet tool's refusals: every sibling by name (the install's own name is added by the server itself)
    APPBUILDER_OUTBOUND_DENY: `*.${DOMAIN}`,
    APPBUILDER_MIGRATION_BACKUP: 'skip',
    ...(socketPath ? { APPBUILDER_SOCKET: socketPath } : { PORT: String(PORTS[key]), APPBUILDER_HOST: '127.0.0.1' }),
  }
  const envFile = path.join(dir, 'instance.env')
  fs.writeFileSync(envFile, Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o640 })
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: path.join(dir, 'tmp'), TMP: path.join(dir, 'tmp'), TMPDIR: path.join(dir, 'tmp'),
    HOME: dir, USERPROFILE: dir, APPBUILDER_ENV_FILE: envFile, HB_DNS_MAP: JSON.stringify(DNS_MAP), NODE_OPTIONS: '',
  }
  fs.mkdirSync(env.TEMP, { recursive: true })
  const inst = {
    key, host, url: `https://${host}`, dbName: name, role: name, password, secretKey, dir, workspace, socketPath, env, envFile,
    port: socketPath ? null : PORTS[key], output: '', child: null,
    target: () => (socketPath ? { socketPath } : { port: PORTS[key] }),
  }
  inst.out = () => inst.output
  // seed-config: the database password sealed with the install's key, as abfleet create does
  const cli = (args, input) => spawnSync(process.execPath, ['--import', SHIM, MAIN, ...args], { env, cwd: root, encoding: 'utf8', timeout: 120_000, input })
  inst.cli = cli
  inst.cliAsync = (args, input) => new Promise((resolve) => {
    const c = spawn(process.execPath, ['--import', SHIM, MAIN, ...args], { env, cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    children.add(c)
    let stdout = ''
    let stderr = ''
    c.stdout.on('data', (x) => { stdout += x })
    c.stderr.on('data', (x) => { stderr += x })
    const t = setTimeout(() => c.kill('SIGKILL'), 120_000)
    c.on('exit', (status) => { clearTimeout(t); children.delete(c); resolve({ status, stdout, stderr }) })
    c.stdin.end(input ?? '')
  })
  const seed = await inst.cliAsync(['seed-config', '--workspace', workspace, '--db-host', fleet.cluster.conn.host, '--db-port', String(fleet.cluster.conn.port), '--db-name', name, '--db-user', name], password + '\n')
  if (seed.status !== 0) throw new Error(`seed-config (${key}): ${seed.stderr || seed.stdout}`)
  const m = await inst.cliAsync(['migrate'])
  if (m.status !== 0) throw new Error(`migrate (${key}): ${m.stderr || m.stdout}`)
  const inv = await inst.cliAsync(['admin', 'invite', '--email', `admin@${key}-org.example`, '--name', `Admin ${key.toUpperCase()}`, '--print-link'])
  if (inv.status !== 0) throw new Error(`admin invite (${key}): ${inv.stderr || inv.stdout}`)
  inst.inviteToken = decodeURIComponent(/#invite=(\S+)/.exec(inv.stdout + inv.stderr)?.[1] ?? '')
  if (!inst.inviteToken) throw new Error(`admin invite (${key}) printed no link`)
  inst.adminEmail = `admin@${key}-org.example`
  fleet.sites.set(host, inst)
  return inst
}

async function startInstall(inst) {
  inst.output = ''
  const child = spawn(process.execPath, ['--import', SHIM, MAIN], { env: inst.env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  inst.child = child
  child.stdout.on('data', (c) => { inst.output += String(c) })
  child.stderr.on('data', (c) => { inst.output += String(c) })
  child.on('exit', () => children.delete(child))
  const until = Date.now() + 120_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`install ${inst.key} stopped: ${inst.output.slice(-3000)}`)
    const h = await call(inst.target(), 'GET', '/api/v1/health', { host: inst.host, timeout: 3000 })
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

export { startInstall }

/** the invitation signs the first administrator in through the proxy; returns the __Host- cookie */
async function firstAdmin(fleet, inst) {
  inst.adminPassword = `Hb-${randomBytes(9).toString('base64url')}-1`
  const r = await fleet.via(inst.host, 'POST', '/api/v1/auth/invitation/accept', { body: { token: inst.inviteToken, password: inst.adminPassword } })
  if (r.status !== 200) throw new Error(`invitation (${inst.key}): ${r.status} ${r.body}`)
  inst.adminCookie = cookieFrom(r)
  inst.adminId = r.json()?.user?.id
}

/** "__Host-ab_session=..." from a sign-in answer */
export function cookieFrom(r) {
  const set = [].concat(r.headers['set-cookie'] ?? []).find((c) => c.startsWith('__Host-ab_session='))
  return set ? set.split(';')[0] : ''
}
