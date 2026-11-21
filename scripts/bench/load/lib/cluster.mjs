/**
 * The load test's PRIVATE PostgreSQL cluster (scripts/bench/load). initdb + pg_ctl from APPBUILDER_LOAD_PG_BIN (default
 * .sandbox/pg/pgsql/bin) on 127.0.0.1:<port in 5400-5409>, data under .sandbox/load/run-*, password authentication,
 * tuned the way a small fleet server would be (spec "Connections for 20 installs" and install.sh --fleet), with slow
 * statements, lock waits and checkpoints logged, pg_stat_statements when the binaries have it. Stopped and removed by
 * stop() (also on Ctrl-C through the cleanup registry of fleet.mjs). Never the shared sandbox (5435) or the owner's
 * PostgreSQL (5433).
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { root, WIN } from './util.mjs'

export const PG_PORTS = [5400, 5409]

/**
 * Settings of the cluster. A small fleet server (DC-12: 8 vCPU, 32 GB) would run shared_buffers 4 GB; on a shared
 * developer PC the harness uses a scaled value (option `sharedBuffers`), everything else as the spec says.
 */
export function clusterSettings(o) {
  return {
    port: o.port,
    listen_addresses: "'127.0.0.1'",
    max_connections: o.maxConnections ?? 300,
    shared_buffers: o.sharedBuffers ?? "'1GB'",
    effective_cache_size: o.effectiveCache ?? "'8GB'",
    work_mem: "'8MB'",
    maintenance_work_mem: "'256MB'",
    wal_buffers: "'16MB'",
    max_wal_size: "'4GB'",
    min_wal_size: "'512MB'",
    checkpoint_timeout: "'15min'",
    checkpoint_completion_target: 0.9,
    random_page_cost: 1.1,
    // durability as on a real server unless the run asks otherwise (the shared sandbox runs fsync off)
    fsync: o.fsync === false ? 'off' : 'on',
    synchronous_commit: o.fsync === false ? 'off' : 'on',
    full_page_writes: o.fsync === false ? 'off' : 'on',
    // what the report reads from the log
    log_min_duration_statement: o.slowMs ?? 250,
    log_lock_waits: 'on',
    deadlock_timeout: "'1s'",
    log_checkpoints: 'on',
    log_temp_files: 0,
    log_line_prefix: "'%m [%p] db=%d app=%a '",
    log_statement: "'none'",
    track_io_timing: 'on',
    unix_socket_directories: "''",
    ...(o.statements ? { shared_preload_libraries: "'pg_stat_statements'", 'pg_stat_statements.track': "'top'", 'pg_stat_statements.max': 2000 } : {}),
  }
}

export async function startCluster(o) {
  const port = o.port
  if (port < PG_PORTS[0] || port > PG_PORTS[1]) throw new Error(`the private cluster's port must be in ${PG_PORTS.join('-')} (got ${port})`)
  const bin = process.env.APPBUILDER_LOAD_PG_BIN || path.join(root, '.sandbox', 'pg', 'pgsql', 'bin')
  const exe = (n) => path.join(bin, n + (WIN ? '.exe' : ''))
  if (!fs.existsSync(exe('initdb'))) throw new Error(`No PostgreSQL binaries in ${bin} (set APPBUILDER_LOAD_PG_BIN to a folder with initdb and pg_ctl).`)
  const libDir = path.join(bin, '..', 'lib')
  const statements = fs.existsSync(path.join(libDir, WIN ? 'pg_stat_statements.dll' : 'pg_stat_statements.so'))
  const data = path.join(o.runDir, 'pgdata')
  const logFile = path.join(o.runDir, 'pg.log')
  const password = randomBytes(18).toString('base64url')
  const pw = path.join(o.runDir, 'pw.txt')
  fs.writeFileSync(pw, password + '\n', { mode: 0o600 })
  const init = spawnSync(exe('initdb'), ['-D', data, '-U', 'postgres', '--pwfile', pw, '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '-E', 'UTF8', '--locale=C', '--no-instructions', '--no-sync'], { encoding: 'utf8', timeout: 180_000 })
  fs.rmSync(pw, { force: true })
  if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr || init.stdout}`)
  const settings = clusterSettings({ ...o, port, statements })
  fs.appendFileSync(path.join(data, 'postgresql.conf'), ['', '# load test (scripts/bench/load/lib/cluster.mjs)', ...Object.entries(settings).map(([k, v]) => `${k} = ${v}`), ''].join('\n'))
  // no pipes: on Windows the postmaster inherits pg_ctl's handles, and spawnSync would wait for them until its timeout
  const st = spawnSync(exe('pg_ctl'), ['start', '-D', data, '-w', '-t', '90', '-l', logFile], { stdio: 'ignore', timeout: 120_000 })
  if (st.status !== 0) throw new Error(`pg_ctl start failed (${st.status}): ${fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-2000) : ''}`)
  const pid = Number(fs.readFileSync(path.join(data, 'postmaster.pid'), 'utf8').split(/\r?\n/)[0])
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    spawnSync(exe('pg_ctl'), ['stop', '-D', data, '-m', 'fast', '-w', '-t', '60'], { stdio: 'ignore', timeout: 90_000 })
    if (fs.existsSync(path.join(data, 'postmaster.pid'))) spawnSync(exe('pg_ctl'), ['stop', '-D', data, '-m', 'immediate', '-w', '-t', '30'], { stdio: 'ignore', timeout: 60_000 })
  }
  const conn = { host: '127.0.0.1', port, user: 'postgres', password }
  const admin = async (database = 'postgres', appName = 'ab_load_admin') => {
    const c = new pg.Client({ ...conn, database, application_name: appName, connectionTimeoutMillis: 15_000 })
    c.on('error', () => {})
    await c.connect()
    return c
  }
  const version = (await (async () => { const c = await admin(); try { return (await c.query('SHOW server_version')).rows[0].server_version } finally { await c.end() } })())
  return { conn, admin, data, logFile, pid, port, settings, statements, version, bin, stop }
}

/** clusters of earlier runs of THIS harness that were killed (only folders under .sandbox/load): stopped and removed */
export function cleanStale(base) {
  const bin = process.env.APPBUILDER_LOAD_PG_BIN || path.join(root, '.sandbox', 'pg', 'pgsql', 'bin')
  const exe = (n) => path.join(bin, n + (WIN ? '.exe' : ''))
  const found = []
  if (!fs.existsSync(base)) return found
  for (const n of fs.readdirSync(base).filter((x) => x.startsWith('run-'))) {
    const d = path.join(base, n, 'pgdata')
    if (fs.existsSync(path.join(d, 'postmaster.pid'))) {
      spawnSync(exe('pg_ctl'), ['stop', '-D', d, '-m', 'immediate', '-w', '-t', '30'], { stdio: 'ignore', timeout: 60_000 })
      found.push(d)
    }
    fs.rmSync(path.join(base, n), { recursive: true, force: true })
  }
  return found
}
