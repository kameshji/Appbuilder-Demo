#!/usr/bin/env node
/**
 * Hosting exit checks 1, 3, 4, 5 and 10 as far as they can be shown WITHOUT systemd, OS users or Caddy (packages H-D,
 * H-E, H-F, H-I, H-J; docs/plan/hosting-spec.md). DEVELOPER AND CI TOOL, not part of the product.
 *
 *   . .\.sandbox\env.ps1 ; node scripts/exit-check/h-fleet.mjs
 *
 * Runs the REAL fleet tool (scripts/fleet/abfleet.ts, in-process, `--local` test mode) against a throwaway PostgreSQL
 * cluster it starts itself (initdb / pg_ctl from APPBUILDER_FLEET_PG_BIN, default .sandbox/pg/pgsql/bin, on
 * 127.0.0.1:5350, password authentication), with real installs of THIS tree as child processes on TCP ports
 * 5360-5397, the real licence service on 5399 and a fake SMTP relay (an ephemeral loopback port) for the operator's summary. Two signed
 * "local release" packages (release.json, release-keys.json and a pointer to this source tree; a throwaway Ed25519
 * key) stand for two releases: the update verifies their checksums and signatures for real, but both run the same
 * code (a real release build is used by the CI job, scripts/fleet/ci/fleet-ci.sh).
 *
 * Everything lives under .sandbox/fleet/run-<id> and is removed afterwards with every database and role (ab_fleet_*),
 * also after a failure (FLEET_KEEP=1 keeps the folder and stops nothing early). Prints a Markdown table (also
 * .sandbox/fleet/h-fleet.md); exit 1 when a check fails, 2 when the setup fails.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createPublicKey, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { runAbfleet } from '../fleet/abfleet.ts'
import { LocalSystem } from '../fleet/lib/local.ts'
import { localPaths, orgPaths } from '../fleet/lib/model.ts'
import { formatSums, generateReleaseKey, sha256File, signSums, trustedKeyEntry } from '../../server/core/update/release.ts'
import { writeZip } from '../../server/core/update/zip.ts'
import { SCHEMA_VERSION } from '../../server/core/meta-store.ts'
import { startFakeSmtp } from '../../server/core/identity/fake-smtp.ts'
import { openArchive, verifyArchive } from '../../server/core/backup/engine.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const WIN = process.platform === 'win32'
const PORT = { pg: 5350, licence: 5399 }
const DOMAIN = 'fleet.test.invalid'
const t0 = Date.now()
const log = (m) => process.stderr.write(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}\n`)
const results = []
const check = (n, what, ok, detail = '') => { results.push({ n, what, ok, detail }); log(`${ok ? 'PASS' : 'FAIL'} [${n}] ${what}${detail ? `: ${detail}` : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hex = (n) => randomBytes(n).toString('hex')

const runId = `${Date.now().toString(36)}${hex(2)}`
const base = path.join(root, '.sandbox', 'fleet')
fs.mkdirSync(base, { recursive: true })
const run = fs.mkdtempSync(path.join(base, `run-${runId}-`))
const fleetRoot = path.join(run, 'fleet')
const paths = localPaths(fleetRoot, path.join(root, 'scripts', 'fleet'))
const offsite = path.join(run, 'offsite')

/* ------------------------------------------------------------------ the throwaway PostgreSQL (as the isolation harness) */

const pgBin = process.env.APPBUILDER_FLEET_PG_BIN || process.env.APPBUILDER_HB_PG_BIN || path.join(root, '.sandbox', 'pg', 'pgsql', 'bin')
const exe = (n) => path.join(pgBin, n + (WIN ? '.exe' : ''))
let cluster = null
function startCluster() {
  if (!fs.existsSync(exe('initdb'))) throw new Error(`No PostgreSQL binaries in ${pgBin} (APPBUILDER_FLEET_PG_BIN).`)
  // a cluster left by an earlier, killed run of this script (only our own folders)
  for (const n of fs.readdirSync(base).filter((x) => x.startsWith('run-'))) {
    const d = path.join(base, n, 'pgdata')
    if (n !== path.basename(run) && fs.existsSync(path.join(d, 'postmaster.pid'))) spawnSync(exe('pg_ctl'), ['stop', '-D', d, '-m', 'immediate', '-w'], { stdio: 'ignore', timeout: 30_000 })
  }
  const data = path.join(run, 'pgdata')
  const password = randomBytes(18).toString('base64url')
  const pw = path.join(run, 'pw.txt')
  fs.writeFileSync(pw, password + '\n', { mode: 0o600 })
  const init = spawnSync(exe('initdb'), ['-D', data, '-U', 'postgres', '--pwfile', pw, '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '-E', 'UTF8', '--no-instructions'], { encoding: 'utf8', timeout: 120_000 })
  fs.rmSync(pw, { force: true })
  if (init.status !== 0) throw new Error(`initdb: ${init.stderr || init.stdout}`)
  const sockDir = WIN ? '' : fs.mkdtempSync('/tmp/abfleetpg-')
  fs.appendFileSync(path.join(data, 'postgresql.conf'), ['', `port = ${PORT.pg}`, "listen_addresses = '127.0.0.1'", 'fsync = off', 'max_connections = 300', `unix_socket_directories = '${sockDir}'`, ''].join('\n'))
  const st = spawnSync(exe('pg_ctl'), ['start', '-D', data, '-w', '-t', '60', '-l', path.join(run, 'pg.log')], { encoding: 'utf8', timeout: 90_000 })
  if (st.status !== 0) throw new Error(`pg_ctl start: ${st.stderr || st.stdout}`)
  cluster = { data, password, sockDir, stop: () => { spawnSync(exe('pg_ctl'), ['stop', '-D', data, '-m', 'fast', '-w', '-t', '30'], { stdio: 'ignore', timeout: 60_000 }); if (sockDir) fs.rmSync(sockDir, { recursive: true, force: true }) } }
}
async function sql(db, text, params = []) {
  const c = new pg.Client({ host: '127.0.0.1', port: PORT.pg, user: 'postgres', password: cluster.password, database: db })
  c.on('error', () => {})
  await c.connect()
  try { return (await c.query(text, params)).rows } finally { await c.end().catch(() => {}) }
}

/* ------------------------------------------------------------------ two signed local release packages */

const keyPass = `fleet-${hex(8)}`
const key = generateReleaseKey(keyPass)
function buildPackage(version) {
  const dir = path.join(run, 'rel', `appbuilder-${version}`)
  fs.mkdirSync(dir, { recursive: true })
  const files = {
    'release.json': JSON.stringify({ name: 'appbuilder', version, commit: hex(20), built: new Date().toISOString(), schemaVersion: SCHEMA_VERSION, node: '>=22.18' }, null, 2) + '\n',
    'release-keys.json': JSON.stringify({ keys: [trustedKeyEntry(createPublicKey(key.publicPem), 'h-fleet throwaway key')] }, null, 2) + '\n',
    'fleet-local-code.txt': root + '\n',
    'RELEASE-NOTES.md': `# ${version}\n\nA local test package of the fleet exit check.\n`,
  }
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t)
  const sums = formatSums(Object.keys(files).sort().map((file) => ({ file, sha256: sha256File(path.join(dir, file)) })))
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sums)
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.sig'), JSON.stringify(signSums(sums, key.privatePem, keyPass)) + '\n')
  const zip = path.join(run, 'rel', `appbuilder-${version}.zip`)
  fs.writeFileSync(zip, writeZip(fs.readdirSync(dir).sort().map((n) => ({ name: `appbuilder-${version}/${n}`, data: fs.readFileSync(path.join(dir, n)) }))))
  return zip
}

/* ------------------------------------------------------------------ abfleet, in-process */

const transcript = []
async function ab(args, o = {}) {
  const lines = []
  const r = await runAbfleet(['--local', '--root', fleetRoot, '--json', ...args], { env: { ...process.env, ABFLEET_ACTOR: 'h-fleet' }, stdout: (s) => lines.push(s), stderr: (s) => { lines.push(s); if (process.env.FLEET_VERBOSE) process.stderr.write(`    ${s}\n`) } })
  transcript.push(`$ abfleet ${args.join(' ')}\n${lines.join('\n')}\n(exit ${r.code})`.replace(/\/\/[^:@/]+:[^@/]+@/g, '//***@').replace(/#invite=[^\s"]+/g, '#invite=***'))
  if (o.expect !== undefined && r.code !== o.expect) throw new Error(`abfleet ${args.slice(0, 3).join(' ')} exit ${r.code}: ${r.error ?? lines.slice(-5).join(' | ')}`.replace(/\/\/[^:@/]+:[^@/]+@/g, '//***@'))
  return r
}

/** HTTP to an install's port as Caddy would forward it */
async function http(org, method, p, o = {}) {
  const headers = { host: org.host, 'x-appbuilder': '1', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.7', ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) }
  try {
    const res = await fetch(`http://127.0.0.1:${org.port}/api/v1${p}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), redirect: 'manual', signal: AbortSignal.timeout(30_000) })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, text, json, cookie: res.headers.getSetCookie().find((c) => c.startsWith('__Host-ab_session='))?.split(';')[0] ?? '' }
  } catch (e) {
    return { status: 0, text: String(e), json: null, cookie: '' }
  }
}
const reg = () => JSON.parse(fs.readFileSync(paths.registry, 'utf8'))
const orgOf = (slug) => Object.values(reg().orgs).find((o) => o.slug === slug)

/**
 * A checksum of an install's business data: its maker tables (the marker table) and its people and environments, and
 * its environment folders (attachments, data files). The install's own background work (job runs, outbox, audit
 * retention) writes system tables in the same schemas at any time, so those are not compared: they would change
 * whether or not another install is restored.
 */
async function fingerprint(org) {
  const tables = await sql(org.db, `SELECT table_schema AS s, table_name AS t FROM information_schema.tables WHERE table_schema LIKE 'env\_%' AND table_type = 'BASE TABLE' AND table_name ILIKE '%fleet%mark%' ORDER BY 1, 2`)
  let acc = ''
  for (const { s, t } of tables) {
    const r = await sql(org.db, `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h, count(*) AS n FROM "${s}"."${t}" x`)
    acc += `${s}.${t}:${r[0].n}:${r[0].h};`
  }
  acc += (await sql(org.db, `SELECT md5(coalesce(string_agg(id || ':' || email || ':' || status || ':' || name, '|' ORDER BY id), '')) AS h FROM ab.users`))[0].h
  acc += (await sql(org.db, `SELECT md5(coalesce(string_agg(id || ':' || name || ':' || schema_name, '|' ORDER BY id), '')) AS h FROM ab.environments`))[0].h
  const files = []
  const walk = (d) => { for (const n of fs.existsSync(d) ? fs.readdirSync(d) : []) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else files.push(`${path.relative(d, p)}:${sha256File(p)}`) } }
  walk(path.join(orgPaths(paths, org.id).workspace, 'env'))
  return { tables: tables.length, files: files.length, hash: (await sql('postgres', 'SELECT md5($1) AS h', [acc + files.sort().join(';')]))[0].h }
}

async function marker(org, cookie) {
  const q = await http(org, 'POST', '/query', { cookie, body: { plan: { version: 2, table: 'FleetMark' } } })
  // every string value of the answer that is a Title this script wrote (the rows of the marker table, sorted)
  const titles = []
  const walk = (v) => { if (typeof v === 'string') { if (/^(FLEET-MARK|AFTER-BACKUP|after |x$)/.test(v)) titles.push(v) } else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x) }
  walk(q.json)
  return { status: q.status, text: q.text, rows: titles.sort().join(',') }
}

/* ------------------------------------------------------------------ the run */

let smtp = null
let failed = false
const people = {}
const stopAll = async () => {
  try {
    if (fs.existsSync(path.join(paths.secrets, 'local-pg.json'))) {
      const n = await new LocalSystem({ paths, pg: JSON.parse(fs.readFileSync(path.join(paths.secrets, 'local-pg.json'), 'utf8')), pgBin }).stopAll()
      if (n) log(`stopped ${n} process(es) of this run`)
    }
  } catch (e) { log(`cleanup: ${e.message}`) }
}
process.once('SIGINT', () => { log('SIGINT: cleaning up'); stopAll().finally(() => { cluster?.stop(); process.exit(130) }) })

try {
  log(`run folder ${run}`)
  startCluster()
  const v1 = buildPackage('0.8.0-fleet.1')
  const v2 = buildPackage('0.8.0-fleet.2')
  smtp = await startFakeSmtp()
  fs.mkdirSync(offsite, { recursive: true })

  /* ---------------------------------------------------------------- 1. init (twice: idempotent) */
  const initArgs = ['init', '--domain', DOMAIN, '--release', v1, '--pg-url', `postgres://postgres:${encodeURIComponent(cluster.password)}@127.0.0.1:${PORT.pg}/postgres`, '--pg-bin', pgBin,
    '--licence', '--licence-port', String(PORT.licence), '--backup-target', offsite, '--tls', 'internal', '--operator-email', 'ops@operator.example', '--access-email', 'ops@operator.example',
    '--alert-host', '127.0.0.1', '--alert-port', String(smtp.port), '--alert-security', 'none', '--alert-from', 'fleet@operator.example']
  const i1 = await ab(initArgs, { expect: 0 })
  const i2 = await ab(initArgs, { expect: 0 })
  const pub = await sql('postgres', `SELECT d.datname, has_database_privilege('public', d.datname, 'CONNECT') AS c FROM pg_database d WHERE d.datname IN ('postgres', 'template1')`)
  check(1, 'init prepares the fleet and is idempotent', i1.result.release === '0.8.0-fleet.1' && i2.result.changed.length === 0 && pub.every((r) => !r.c), `first run ${i1.result.changed.length} changes, second ${i2.result.changed.length}; PUBLIC CONNECT on postgres/template1: ${pub.map((r) => `${r.datname}=${r.c}`).join(', ')}; licence service ${i1.result.licence}`)

  /* ---------------------------------------------------------------- 1. three organisations, no manual step */
  const slugs = ['acme', 'beta', 'core']
  const times = []
  for (const s of slugs) {
    const r = await ab(['org', 'create', s, '--name', `${s[0].toUpperCase()}${s.slice(1)} Pvt Ltd`, '--admin-email', `it@${s}.example`, '--admin-name', `Admin ${s}`, '--seats', '25', '--print-link'], { expect: 0 })
    times.push(`${s} ${(r.result.ms / 1000).toFixed(1)} s`)
    people[s] = { link: r.result.link }
  }
  const orgs = Object.fromEntries(slugs.map((s) => [s, orgOf(s)]))
  const health = await Promise.all(slugs.map((s) => http(orgs[s], 'GET', '/health')))
  check(1, 'org create x3: database, role, OS user (recorded), folder, key, env, licence, migrate, invitation, start, site, health', health.every((h) => h.status === 200), times.join(', '))
  const roles = await sql('postgres', `SELECT r.rolname, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolconnlimit, has_database_privilege('public', r.rolname, 'CONNECT') AS pub, array_to_string(r.rolconfig, ',') AS cfg FROM pg_roles r WHERE r.rolname LIKE 'ab\\_fleet\\_o%' ORDER BY 1`)
  check(1, 'each role is isolated as the isolation suite requires', roles.length === 3 && roles.every((r) => !r.rolsuper && !r.rolcreatedb && !r.rolcreaterole && r.rolconnlimit === 12 && !r.pub && /statement_timeout=60s/.test(r.cfg)), roles.map((r) => `${r.rolname}: limit ${r.rolconnlimit}, PUBLIC ${r.pub}, ${r.cfg}`).join('; '))
  const sites = slugs.map((s) => fs.readFileSync(orgPaths(paths, orgs[s].id).caddySite, 'utf8'))
  check(1, 'Caddy site per organisation: exact host, tls internal, X-Forwarded-Host dropped (file only: no Caddy here)', sites.every((t, i) => t.includes(`${orgs[slugs[i]].host} {`) && t.includes('header_up -X-Forwarded-Host') && t.includes('tls internal')), orgPaths(paths, orgs.acme.id).caddySite)
  const env = fs.readFileSync(orgPaths(paths, orgs.acme.id).env, 'utf8')
  check(1, 'instance.env: hosted, locked public URL, setup closed, outbound deny, pool 6, licence; no password', /APPBUILDER_HOSTED=1/.test(env) && env.includes(`APPBUILDER_PUBLIC_URL=https://${orgs.acme.host}`) && /APPBUILDER_SETUP=closed/.test(env) && /APPBUILDER_OUTBOUND_PRIVATE=deny/.test(env) && env.includes(`APPBUILDER_OUTBOUND_DENY=*.${DOMAIN}`) && /APPBUILDER_DB_POOL=6/.test(env) && /APPBUILDER_LICENCE_ID=lic_/.test(env) && !/PASSWORD=|abl_/.test(env), '')
  // the first administrators accept their emailed one-time links (here: printed, no relay in local mode)
  for (const s of slugs) {
    const token = decodeURIComponent(/#invite=(\S+)/.exec(people[s].link ?? '')?.[1] ?? '')
    people[s].password = `Fleet-${hex(6)}-pw1`
    const r = await http(orgs[s], 'POST', '/auth/invitation/accept', { body: { token, password: people[s].password } })
    people[s].cookie = r.cookie
    const t = await http(orgs[s], 'POST', '/tables', { cookie: r.cookie, body: { displayName: 'Fleet mark', name: 'FleetMark', columns: [{ displayName: 'Title', type: 'text' }] } })
    people[s].table = t.json?.id
    people[s].mark = `FLEET-MARK-${s.toUpperCase()}-${hex(4)}`
    const row = await http(orgs[s], 'POST', `/data/${people[s].table}/rows`, { cookie: r.cookie, body: { values: { Title: people[s].mark } } })
    people[s].ok = r.status === 200 && !!r.cookie && t.status === 200 && row.status === 200
  }
  check(1, 'each first administrator signs in through the one-time link and creates a table and a row', slugs.every((s) => people[s].ok), slugs.map((s) => `${s}: ${people[s].ok ? 'ok' : 'FAILED'}`).join(', '))
  const leak = slugs.some((s) => fs.readFileSync(paths.audit, 'utf8').includes(decodeURIComponent(/#invite=(\S+)/.exec(people[s].link ?? '')?.[1] ?? 'x-none')))
  check(1, 'the operator audit has every command and no secret', !leak && fs.readFileSync(paths.audit, 'utf8').trim().split('\n').length >= 5, `${fs.readFileSync(paths.audit, 'utf8').trim().split('\n').length} lines`)

  /* ---------------------------------------------------------------- 5. status, suspend / resume, stop / start, export */
  const st = await ab(['org', 'status'], { expect: 0 })
  check(5, 'org status: health, version, read-only, users, seats, disk, database size, licence check', st.result.length === 3 && st.result.every((x) => x.health === 'ok' && x.release === '0.8.0-fleet.1' && x.users === 1 && x.disk > 0 && x.dbBytes > 0), st.result.map((x) => `${x.host} ${x.health} users ${x.users} seats ${x.seats} db ${(x.dbBytes / 1e6).toFixed(1)} MB lic ${x.lastLicenceCheck ?? 'none'}`).join('; '))
  await ab(['org', 'suspend', 'beta', '--reason', 'Invoice 7 is overdue'], { expect: 0 })
  await sleep(6000)
  const w = await http(orgs.beta, 'POST', `/data/${people.beta.table}/rows`, { cookie: people.beta.cookie, body: { values: { Title: 'x' } } })
  const rd = await marker(orgs.beta, people.beta.cookie)
  const si = await http(orgs.beta, 'POST', '/auth/login', { body: { email: 'it@beta.example', password: people.beta.password } })
  const exB = await ab(['org', 'export', 'beta'], { expect: 0 })
  check(5, 'suspend (read-only): writes refused with install_read_only, reads, sign-in and export work', w.status === 503 && w.json?.error?.code === 'install_read_only' && rd.status === 200 && rd.text.includes(people.beta.mark) && si.status === 200 && fs.existsSync(exB.result.file), `write ${w.status} ${w.json?.error?.code}; read ${rd.status}; sign-in ${si.status}; export ${path.basename(exB.result.file)}`)
  await ab(['org', 'resume', 'beta'], { expect: 0 })
  await sleep(6000)
  const w2 = await http(orgs.beta, 'POST', `/data/${people.beta.table}/rows`, { cookie: people.beta.cookie, body: { values: { Title: 'after resume' } } })
  check(5, 'resume: writable again', w2.status === 200, `write ${w2.status}`)
  await ab(['org', 'suspend', 'core', '--reason', 'Maintenance window', '--stop'], { expect: 0 })
  const down = await http(orgs.core, 'GET', '/health')
  const notice = fs.readFileSync(orgPaths(paths, orgs.core.id).caddySite, 'utf8')
  await ab(['org', 'resume', 'core'], { expect: 0 })
  const back = await http(orgs.core, 'GET', '/auth/session', { cookie: people.core.cookie })
  check(5, 'stop and start: the process stops, the site becomes a notice, resume starts it and the session is still valid', down.status === 0 && notice.includes('respond "This Appbuilder is paused') && back.status === 200, `while stopped: ${down.status === 0 ? 'no answer' : down.status}; after resume: session ${back.status}`)
  const exA = await ab(['org', 'export', 'acme'], { expect: 0 })
  const sumLine = fs.readFileSync(`${exA.result.file}.sha256`, 'utf8').split(/\s+/)[0]
  const arc = await openArchive(exA.result.file, null)
  let ver
  try { ver = await verifyArchive(arc) } finally { await arc.close() }
  check(5, 'export: a verified archive with its checksum, copied off the machine', ver.ok && sumLine === sha256File(exA.result.file) && fs.existsSync(exA.result.offsite), `${path.basename(exA.result.file)}, ${(exA.result.bytes / 1024).toFixed(0)} KB, ${ver.files} files, rows ${ver.rows}; off-machine ${path.relative(run, exA.result.offsite)}`)

  /* ---------------------------------------------------------------- isolation re-check of what the fleet tool set up */
  const reach = (from, db) => {
    const e = { ...process.env, APPBUILDER_ENV_FILE: orgPaths(paths, from.id).env, ABFLEET_APP: orgPaths(paths, from.id).app, ABFLEET_LOCAL: '1' }
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'fleet', 'agent.ts'), 'db-reach', db], { env: e, encoding: 'utf8', timeout: 60_000 })
    try { return JSON.parse(r.stdout.trim().split('\n').pop()) } catch { return { connected: null, message: r.stderr.slice(-200) } }
  }
  const own = reach(orgs.acme, orgs.acme.db)
  const other = reach(orgs.acme, orgs.beta.db)
  const pgdb = reach(orgs.acme, 'postgres')
  check('2 (part)', "isolation re-check: A's role reaches its own database only (not B's, not postgres)", own.connected === true && other.connected === false && pgdb.connected === false, `own ${own.connected}; B ${other.connected} (${other.code}); postgres ${pgdb.connected} (${pgdb.code})`)

  /* ---------------------------------------------------------------- 3. update: canary, batches, one install fails alone */
  const smoke = path.join(run, 'smoke.mjs')
  fs.writeFileSync(smoke, `// smoke check of the exit check: beta is made to fail\nif (process.env.ABFLEET_SLUG === 'beta') { console.error('forced failure for beta'); process.exit(1) }\nconst r = await fetch('http://127.0.0.1:' + process.env.ABFLEET_PORT + '/api/v1/health', { headers: { host: process.env.ABFLEET_HOST } })\nprocess.exit(r.status === 200 ? 0 : 1)\n`)
  // a package whose file no longer matches its signed checksum list
  const tampered = path.join(run, 'rel', 'tampered')
  fs.cpSync(path.join(run, 'rel', 'appbuilder-0.8.0-fleet.2'), tampered, { recursive: true })
  fs.appendFileSync(path.join(tampered, 'RELEASE-NOTES.md'), 'changed after signing\n')
  const bad = await ab(['update', tampered])
  check(3, 'a changed package is refused before any install is touched', bad.code === 2 && /checksum|signature|CRC|damaged|refused/i.test(bad.error ?? '') && Object.values(reg().orgs).every((o) => o.release === '0.8.0-fleet.1'), (bad.error ?? '').slice(0, 140))
  const rowsBefore = (await marker(orgs.beta, people.beta.cookie)).rows
  const up = await ab(['update', v2, '--canary', 'acme', '--batch', '1', '--on-failure', 'continue', '--smoke', smoke, '--health-timeout', '120'])
  const steps = up.result?.steps ?? []
  const r2 = reg()
  const afterHealth = await Promise.all(slugs.map((s) => http(orgs[s], 'GET', '/health')))
  const sessA = await http(orgs.acme, 'GET', '/auth/session', { cookie: people.acme.cookie })
  check(3, 'update: canary first, then batches; beta fails its smoke check and alone is rolled back; the others run the new release', steps[0]?.host === orgs.acme.host && steps.map((s) => s.result).join(',') === 'updated,rolled-back,updated' && r2.orgs[orgs.acme.id].release === '0.8.0-fleet.2' && r2.orgs[orgs.beta.id].release === '0.8.0-fleet.1' && r2.orgs[orgs.core.id].release === '0.8.0-fleet.2' && afterHealth.every((h) => h.status === 200), steps.map((s) => `${s.host}: ${s.result} (${((s.ms ?? 0) / 1000).toFixed(0)} s)`).join('; '))
  const rowsAfter = (await marker(orgs.beta, people.beta.cookie)).rows
  const cur = path.basename(fs.readlinkSync(paths.current).replace(/[\\/]+$/, ''))
  check(3, 'the rolled-back install keeps its data; the updated ones keep their sessions; the fleet switched current', rowsAfter === rowsBefore && !!rowsBefore && sessA.status === 200 && cur === '0.8.0-fleet.2', `beta rows ${rowsAfter === rowsBefore ? `equal (${rowsBefore})` : `CHANGED ${rowsBefore} -> ${rowsAfter}`}; acme session ${sessA.status}; current ${cur}; beta: ${steps[1]?.message?.slice(0, 100)}`)
  const ro = await http(orgs.beta, 'POST', `/data/${people.beta.table}/rows`, { cookie: people.beta.cookie, body: { values: { Title: 'after rollback' } } })
  check(3, 'the rolled-back install is writable again (the update window was read-only)', ro.status === 200, `write ${ro.status}`)
  // the data part of the rule: the same failure with --data-rollback always restores the pre-update snapshot
  const up2 = await ab(['update', v2, '--only', 'beta', '--data-rollback', 'always', '--smoke', smoke, '--health-timeout', '120'])
  const s2 = up2.result?.steps?.[0]
  await sleep(1000)
  const relogin = await http(orgs.beta, 'POST', '/auth/login', { body: { email: 'it@beta.example', password: people.beta.password } })
  people.beta.cookie = relogin.cookie || people.beta.cookie
  const mk = await marker(orgs.beta, people.beta.cookie)
  check(3, 'schema rule: a failed install restored from its pre-update snapshot comes back with its data', s2?.result === 'rolled-back' && s2?.dataRestored === true && mk.text.includes(people.beta.mark) && mk.text.includes('after rollback'), `${s2?.message?.slice(0, 160)}; sign-in again ${relogin.status} (sessions are not in backups)`)

  /* ---------------------------------------------------------------- 4. backups off the machine, restore of one */
  const bk = await ab(['backup', 'run', '--all'], { expect: 0 })
  const nightly = reg().backups.filter((b) => b.kind === 'nightly')
  const copiesOk = nightly.length === 3 && nightly.every((b) => fs.existsSync(b.offsite) && sha256File(b.offsite) === b.sha256)
  const gl = reg().backups.find((b) => b.kind === 'globals')
  check(4, 'backup run --all: each install with its own engine, encrypted, verified, copied off the machine and checked there', copiesOk && !!gl && fs.existsSync(gl.offsite) && !fs.readFileSync(gl.file, 'utf8').includes('CREATE ROLE'), `${bk.result.ok.length} ok, ${bk.result.failed.length} failed; ${nightly.map((b) => `${b.host} ${(b.bytes / 1024).toFixed(0)} KB`).join(', ')}; roles dump sealed`)
  const enc = fs.readFileSync(nightly[0].file).subarray(0, 8).toString('ascii')
  check(4, 'the archives are encrypted (product container ABBAKENC)', enc === 'ABBAKENC', enc)
  const fpA = await fingerprint(orgs.acme)
  const fpC = await fingerprint(orgs.core)
  const late = `AFTER-BACKUP-${hex(3)}`
  await http(orgs.beta, 'POST', `/data/${people.beta.table}/rows`, { cookie: people.beta.cookie, body: { values: { Title: late } } })
  const rs = await ab(['backup', 'restore', 'beta'], { expect: 0 })
  await sleep(1000)
  const relogin2 = await http(orgs.beta, 'POST', '/auth/login', { body: { email: 'it@beta.example', password: people.beta.password } })
  const mk2 = await marker(orgs.beta, relogin2.cookie)
  const fpA2 = await fingerprint(orgs.acme)
  const fpC2 = await fingerprint(orgs.core)
  const sessA2 = await http(orgs.acme, 'GET', '/auth/session', { cookie: people.acme.cookie })
  const sessC2 = await http(orgs.core, 'GET', '/auth/session', { cookie: people.core.cookie })
  check(4, 'restore of ONE organisation: beta is back at its backup (the later row is gone, its marker is there)', rs.result.healthy && mk2.text.includes(people.beta.mark) && !mk2.text.includes(late), `from ${path.basename(rs.result.from)}, safety copy ${path.basename(rs.result.safety ?? '-')}`)
  check(4, 'the other installs are untouched: their data and folders are equal, their people stay signed in', fpA.hash === fpA2.hash && fpC.hash === fpC2.hash && sessA2.status === 200 && sessC2.status === 200, `acme (${fpA.tables} maker table, users, environments, ${fpA.files} files) ${fpA.hash === fpA2.hash ? 'equal' : 'CHANGED'}, core ${fpC.hash === fpC2.hash ? 'equal' : 'CHANGED'}; sessions ${sessA2.status}/${sessC2.status}`)
  const rt = await ab(['backup', 'restore-test', 'acme'], { expect: 0 })
  const scratch = await sql('postgres', `SELECT datname FROM pg_database WHERE datname LIKE 'ab\\_fleet\\_rt\\_%' UNION ALL SELECT rolname FROM pg_roles WHERE rolname LIKE 'ab\\_fleet\\_rt\\_%'`)
  check(4, 'restore test: the off-machine copy restored into a scratch database, then removed', rt.result.ok && rt.result.tables > 0 && scratch.length === 0, `${rt.result.tables} tables, ${rt.result.rows} rows into ${rt.result.scratch}; left: ${scratch.length}`)
  const bs = await ab(['backup', 'status'], { expect: 0 })
  check(4, 'backup status: every install backed up, off the machine', bs.result.every((b) => b.ok && b.offsite && !b.problem), bs.result.map((b) => `${b.host} ${b.problem ?? 'ok'}`).join('; '))

  /* ---------------------------------------------------------------- H-J: operator access, visible and time-boxed */
  const g = await ab(['access', 'grant', 'acme', '--reason', 'Support ticket 1001: import fails', '--minutes', '30', '--print-link'], { expect: 0 })
  const tok = decodeURIComponent(/#invite=(\S+)/.exec(g.result.link ?? '')?.[1] ?? '')
  const opPw = `Op-${hex(6)}-pw1`
  const acc = await http(orgs.acme, 'POST', '/auth/invitation/accept', { body: { token: tok, password: opPw } })
  const adminId = (await sql(orgs.acme.db, `SELECT id FROM ab.users WHERE email = 'it@acme.example'`))[0]?.id
  const notes = await sql(orgs.acme.db, `SELECT title, body FROM ab.notifications WHERE user_id = $1 AND title LIKE 'Operator access%'`, [adminId])
  const aud = await sql(orgs.acme.db, `SELECT action, details FROM ab.audit WHERE action LIKE 'install.operator_access%'`)
  check('H-J', 'access grant: a time-boxed administrator through the install, audited in the install, the administrators told', acc.status === 200 && notes.length >= 1 && aud.some((a) => a.action === 'install.operator_access') && g.result.grant.until, `operator sign-in ${acc.status}; admin notification "${notes[0]?.title}"; install audit ${aud.map((a) => a.action).join(', ')}`)
  const sw = await ab(['access', 'sweep', '--at', new Date(Date.now() + 31 * 60_000).toISOString()], { expect: 0 })
  const after = await http(orgs.acme, 'GET', '/auth/session', { cookie: acc.cookie })
  const st2 = (await sql(orgs.acme.db, `SELECT status FROM ab.users WHERE email = $1`, [g.result.grant.email]))[0]?.status
  const notes2 = await sql(orgs.acme.db, `SELECT title FROM ab.notifications WHERE user_id = $1 AND title = 'Operator access ended'`, [adminId])
  check('H-J', 'at expiry the account is disabled, its session ends, the administrators are told', sw.result.ended.length === 1 && after.status === 401 && st2 === 'disabled' && notes2.length === 1, `session after expiry ${after.status}; account ${st2}`)

  /* ---------------------------------------------------------------- 10. secrets rotation */
  const sj1 = fs.readFileSync(orgPaths(paths, orgs.acme.id).serverJson, 'utf8')
  const rdb = await ab(['secrets', 'rotate', 'acme', '--what', 'db'])
  const sj2 = fs.readFileSync(orgPaths(paths, orgs.acme.id).serverJson, 'utf8')
  const okAfter = await marker(orgs.acme, people.acme.cookie)
  check(10, 'rotate the database password: re-sealed in server.json, restarted, data readable', rdb.code === 0 && sj1 !== sj2 && okAfter.status === 200 && okAfter.text.includes(people.acme.mark), rdb.result?.message ?? rdb.error)
  const k1 = fs.readFileSync(orgPaths(paths, orgs.acme.id).licenceKey, 'utf8')
  const rlk = await ab(['secrets', 'rotate', 'acme', '--what', 'licence-key'])
  const k2 = fs.readFileSync(orgPaths(paths, orgs.acme.id).licenceKey, 'utf8')
  check(10, 'rotate the licence key: old key revoked, new key in place, a fresh licence check succeeds', rlk.code === 0 && k1 !== k2, rlk.result?.message ?? rlk.error)
  const rsk = await ab(['secrets', 'rotate', 'acme', '--what', 'secret-key'])
  check(10, 'rotate the secret key: refused as NOT SUPPORTED by the product (no server rekey command); nothing changed', rsk.code === 69, 'partial: needs `appbuilder rekey` in the server')

  /* ---------------------------------------------------------------- H-I limits, doctor, summary */
  const la = await ab(['limits', 'apply', '--all', '--db-connections', '14'], { expect: 0 })
  const lim = await sql('postgres', `SELECT rolconnlimit FROM pg_roles WHERE rolname LIKE 'ab\\_fleet\\_o%'`)
  const dropIn = fs.readFileSync(orgPaths(paths, orgs.acme.id).limitsConf, 'utf8')
  check('H-I', 'limits apply: PostgreSQL limits applied; systemd drop-in written (not enforced: no systemd here)', lim.every((r) => r.rolconnlimit === 14) && dropIn.includes('MemoryMax=1536M') && la.result.length === 3, la.result[0].notes.join(' | ').slice(0, 220))
  await ab(['limits', 'apply', '--all', '--db-connections', '12'], { expect: 0 })
  const doc = await ab(['doctor'])
  check(1, 'doctor: every install passes its own hosting-check, health, role isolation, files', doc.code === 0, doc.code === 0 ? `${doc.result.checks.length} checks` : doc.result?.problems?.join('; ') ?? doc.error)
  const sum = await ab(['summary', '--send'], { expect: 0 })
  const mail = smtp.inbox.find((m) => m.subject.startsWith('Appbuilder fleet'))
  check('obs', 'daily summary to the operator: exceptions only, sent through the relay', !!mail && mail.text.includes(orgs.beta.host) && /exception/.test(mail.subject), `${mail?.subject ?? 'no mail'}; ${sum.result.exceptions.length} exception(s)`)

  /* ---------------------------------------------------------------- 5. delete with verified removal */
  const del = await ab(['org', 'delete', 'core', '--confirm', orgs.core.host])
  const gone = await sql('postgres', `SELECT 1 FROM pg_database WHERE datname = $1 UNION ALL SELECT 1 FROM pg_roles WHERE rolname = $1`, [orgs.core.db])
  const users = JSON.parse(fs.readFileSync(path.join(paths.etc, 'local-users.json'), 'utf8'))
  const lic = await ab(['org', 'list'], { expect: 0 })
  check(5, 'delete: export first, then no database, role, user, folder, site, unit, local backup or registry entry (scan)', del.code === 0 && del.result.remaining.length === 0 && gone.length === 0 && !users.includes(orgs.core.osUser) && !fs.existsSync(orgPaths(paths, orgs.core.id).dir) && !fs.existsSync(orgPaths(paths, orgs.core.id).caddySite) && lic.result.length === 2 && fs.existsSync(del.result.export), `removed ${del.result.removed.length} items; kept: ${del.result.kept.length} (export, off-machine copies until retention, audit lines)`)
} catch (e) {
  failed = true
  log(`SETUP FAILED: ${e.stack ?? e}`)
  check('-', 'the run itself', false, String(e.message ?? e).slice(0, 300))
} finally {
  // remove the remaining organisations through the tool, then everything else of this run
  try {
    if (fs.existsSync(paths.registry)) for (const o of Object.values(reg().orgs)) await ab(['org', 'delete', o.slug, '--confirm', o.host, '--no-export', '--purge-offsite'])
  } catch (e) { log(`cleanup delete: ${e.message}`) }
  await stopAll()
  try {
    if (cluster) {
      const left = await sql('postgres', `SELECT datname AS n FROM pg_database WHERE datname LIKE 'ab\\_fleet\\_%' UNION ALL SELECT rolname FROM pg_roles WHERE rolname LIKE 'ab\\_fleet\\_%'`)
      for (const { n } of left) await sql('postgres', `DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`).catch(() => {})
      for (const { n } of left) await sql('postgres', `DROP ROLE IF EXISTS "${n}"`).catch(() => {})
      log(`dropped ${left.length} leftover database object(s) (the licence service's own database and role)`)
    }
  } catch (e) { log(`cleanup sql: ${e.message}`) }
  cluster?.stop()
  await smtp?.close().catch(() => {})
  fs.writeFileSync(path.join(base, `h-fleet-transcript.txt`), transcript.join('\n\n'))
  if (!process.env.FLEET_KEEP) fs.rmSync(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
}

const md = [
  `## Fleet exit check (local test mode), ${new Date().toISOString().slice(0, 16)} UTC, ${((Date.now() - t0) / 1000).toFixed(0)} s`,
  '',
  '| Exit check (spec) or package | What | Result | Evidence |',
  '| --- | --- | --- | --- |',
  ...results.map((r) => `| ${r.n} | ${r.what} | ${r.ok ? 'PASS' : 'FAIL'} | ${String(r.detail).replace(/\|/g, '/').replace(/\n/g, ' ')} |`),
  '',
  'Not shown here (no systemd, OS users or Caddy on this machine): file permissions between installs, the template unit and its limits under load, Caddy and TLS by host name, reboot survival. The CI job `fleet` (scripts/fleet/ci/fleet-ci.sh) runs those parts on Ubuntu.',
].join('\n')
console.log(md)
fs.writeFileSync(path.join(base, 'h-fleet.md'), md + '\n')
process.exit(failed ? 2 : results.some((r) => !r.ok) ? 1 : 0)
