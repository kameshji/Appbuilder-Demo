#!/usr/bin/env node
/**
 * Appbuilder local server: `node server/main.ts` (Node 22.18+ type stripping).
 * Serves the Data API v1 under /api/v1 and the built app from dist/ (SPA fallback).
 * `node server/main.ts restore <archive.abbak> [options]` restores an install from a backup instead (backup/cli.ts).
 * `node server/main.ts version|verify-release|update|diagnostics|health|seed-config`: tools of an installed server
 * (update/cli.ts; the installers wrap them as the `appbuilder` command).
 * `node server/main.ts admin list|reset-password|reset-mfa|make-install-admin <email>`: recovery of administrator access
 * on the server machine (identity/admin-cli.ts).
 * Hosting (docs/admin/hosting.md; hosting/cli.ts): `migrate`, `admin invite --email <e> --name <n>`,
 * `read-only on|off|status`, `hosting-check`; for operators and the fleet tool: `status [--json]`,
 * `backup create --out <file>`, `admin operator-access open|close`.
 *   PORT (5174)   APPBUILDER_HOST (127.0.0.1)   APPBUILDER_WORKSPACE (./workspace)   APPBUILDER_SECRET_KEY
 *   APPBUILDER_DB_HOST / _PORT (5432) / _NAME / _USER / _PASSWORD / _SSL  (optional PostgreSQL bootstrap, skips the setup screen)
 *   APPBUILDER_ALLOWED_HOSTS (extra Host names)  APPBUILDER_SECURE_COOKIE=1  APPBUILDER_TRUST_PROXY=1
 *   hosting (all optional, hosting/settings.ts): APPBUILDER_ENV_FILE, APPBUILDER_HOSTED, APPBUILDER_SOCKET, APPBUILDER_PUBLIC_URL,
 *   APPBUILDER_SETUP=closed, APPBUILDER_DB_POOL, APPBUILDER_JOBS_POLL_MS, APPBUILDER_INSTANCE_DIR, APPBUILDER_READ_ONLY,
 *   APPBUILDER_OUTBOUND_DENY, APPBUILDER_SHUTDOWN_MS
 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { createApp } from './core/app.ts'
import { serveStatic } from './core/static.ts'
import { log } from './core/util.ts'
import { startFileLogging } from './core/diagnostics/logger.ts'
import { loadConfig } from './core/config.ts'
import { applyHostingDefaults, hostingSettings, loadInstanceEnv, writePathProblems } from './core/hosting/settings.ts'
import { adaptCookiesIn } from './core/hosting/cookies.ts'

// H-A: the per-instance environment file first (values already set win), then the hosted profile's defaults, so the
// server and every command below read the same settings
try {
  loadInstanceEnv()
} catch (e) {
  process.stderr.write(`ERROR: cannot read APPBUILDER_ENV_FILE: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(78)
}
const hostingProblems = hostingSettings().problems
applyHostingDefaults()
const cmd = process.argv[2] ?? ''

// hosting commands (hosting/cli.ts): migrate, admin invite, read-only, hosting-check; health over the install's socket
if (cmd === 'migrate' || cmd === 'read-only' || cmd === 'hosting-check' || (cmd === 'admin' && process.argv[3] === 'invite') || (cmd === 'health' && hostingSettings().socket)) {
  ;(await import('./core/update/cli.ts')).loadInstallEnv()
  const { runHostingCli } = await import('./core/hosting/cli.ts')
  process.exit(await runHostingCli(cmd === 'admin' ? process.argv.slice(3) : process.argv.slice(2)))
}

// commands the fleet tool and operators script against (docs/admin/hosting.md "Server commands for operators"):
// status [--json] (hosting/status-cli.ts), backup create (backup/create-cli.ts), admin operator-access open|close
// (identity/operator-access-cli.ts). Each reads the install's environment like the commands above.
if (cmd === 'status') {
  ;(await import('./core/update/cli.ts')).loadInstallEnv()
  process.exit(await (await import('./core/hosting/status-cli.ts')).runStatusCli(process.argv.slice(3)))
}
if (cmd === 'backup') {
  if (process.argv[3] !== 'create') {
    process.stderr.write('Usage: appbuilder backup create --out <file> [options] (appbuilder backup create --help)\n')
    process.exit(64)
  }
  ;(await import('./core/update/cli.ts')).loadInstallEnv()
  process.exit(await (await import('./core/backup/create-cli.ts')).runBackupCreateCli(process.argv.slice(4)))
}
if (cmd === 'admin' && process.argv[3] === 'operator-access') {
  ;(await import('./core/update/cli.ts')).loadInstallEnv()
  process.exit(await (await import('./core/identity/operator-access-cli.ts')).runOperatorAccessCli(process.argv.slice(4)))
}

// offline recovery of administrator access (identity/admin-cli.ts): appbuilder admin list | reset-password | reset-mfa |
// make-install-admin <email>; needs the workspace's secret key and database login, works with the server running or not
if (cmd === 'admin') {
  ;(await import('./core/update/cli.ts')).loadInstallEnv()
  const { runAdminCli } = await import('./core/identity/admin-cli.ts')
  process.exit(await runAdminCli(process.argv.slice(3)))
}
// the setup code of a server installed as a service (it is in the setup-code file, not in a window)
if (cmd === 'setup-code') {
  ;(await import('./core/update/cli.ts')).loadInstallEnv()
  const { runSetupCodeCli } = await import('./core/identity/admin-cli.ts')
  process.exit(runSetupCodeCli())
}

// H-G: the licence service (a separate process with its own database; also `node server/licence-service/main.ts`)
if (cmd === 'licence-service') process.exit(await (await import('./licence-service/cli.ts')).runLicenceCli(process.argv.slice(3)))

// installed-server tools: version, verify-release, update, diagnostics, health, seed-config (update/cli.ts)
const { CLI_COMMANDS, runOpsCli } = await import('./core/update/cli.ts')
// an installed server's `appbuilder restore` uses the service's environment file (database login, workspace)
if (cmd === 'restore') (await import('./core/update/cli.ts')).loadInstallEnv()
if (CLI_COMMANDS.has(cmd)) process.exit(await runOpsCli(process.argv.slice(2)))

// `node server/main.ts restore <archive>`: install restore from a backup (docs/admin/disaster-recovery.md), no server
if (cmd === 'restore') {
  const { runCli } = await import('./core/backup/cli.ts')
  process.exit(await runCli(process.argv.slice(2)))
}

/* ------------------------------------------------------------------ the server */

const hosting = hostingSettings()
const startProblems = [...hostingProblems, ...writePathProblems(hosting, { workspaceDir: loadConfig().workspaceDir })]
if (startProblems.length) {
  for (const p of startProblems) log('error', `CONFIGURATION: ${p}`)
  log('error', 'Not started: fix the settings above (`appbuilder hosting-check` lists them).')
  process.exit(78)
}

// the rotating JSON-lines file log in <workspace>/logs (package L); the console keeps human-readable lines
startFileLogging(loadConfig().workspaceDir)

/** a socket file left by a server that did not stop cleanly is removed; one a running server answers on is not */
async function clearStaleSocket(file: string): Promise<void> {
  if (!fs.existsSync(file)) return
  const alive = await new Promise<boolean>((resolve) => {
    const c = net.connect(file)
    c.once('connect', () => { c.destroy(); resolve(true) })
    c.once('error', () => resolve(false))
  })
  if (alive) {
    log('error', `Another server is already listening on ${file}.`)
    process.exit(1)
  }
  fs.rmSync(file, { force: true })
}
if (hosting.socket && process.platform !== 'win32') await clearStaleSocket(hosting.socket)

// start-up order: database (migrations) and the job worker inside createApp, then the listener: the proxy sees the
// socket or port only once the install can answer
const { createPgDb } = await import('./connectors/postgres/db.ts')
const app = await createApp({
  // APPBUILDER_DB_POOL (hosted default 6): the system database pool, which every environment's default connection shares
  sqlDbFactory: (settings, password) => createPgDb(settings, password, { max: hosting.dbPool, onError: (e) => log('warn', `database pool: ${e.message}`) }),
  // a hosted install's first-run setup is done by `migrate` and `admin invite`: no setup code to print
  printSetupCode: !hosting.setupClosed,
})
const { host, port, distDir, workspaceDir } = app.config

const server = http.createServer((req, res) => {
  app.handle(req, res).then(
    (handled) => {
      if (!handled) serveStatic(distDir, req, res)
    },
    () => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    },
  )
})
server.requestTimeout = 10 * 60 * 1000
// the realtime endpoint /api/v1/live (WebSocket); every other upgrade is refused
server.on('upgrade', (req, socket, head) => {
  // H-A: the session cookie arrives as __Host-ab_session behind a locked https public URL (hosting/cookies.ts)
  if (hosting.hostCookies) adaptCookiesIn(req)
  if (!app.handleUpgrade(req, socket, head)) socket.destroy()
})

server.on('error', (e: NodeJS.ErrnoException) => {
  log('error', e.code === 'EADDRINUSE' ? (hosting.socket ? `${hosting.socket} is already in use.` : `Port ${port} is already in use. Set PORT to another value.`) : String(e))
  process.exit(1)
})

function listening(): void {
  if (hosting.socket) {
    // the install's user and the proxy's group (default 660); nobody else may open it
    if (process.platform !== 'win32') fs.chmodSync(hosting.socket, hosting.socketMode)
    log('info', `Appbuilder is listening on ${hosting.socket}${hosting.publicUrl ? ` (public address ${hosting.publicUrl})` : ''}`)
  } else log('info', `Appbuilder is running at http://${host === '127.0.0.1' ? 'localhost' : host}:${port}/${hosting.publicUrl ? ` (public address ${hosting.publicUrl})` : ''}`)
  log('info', `Workspace folder: ${workspaceDir}`)
  const st = app.services.state
  log('info', app.services.ready()
    ? `Database: ${st.location}`
    : st.incompatible
      ? 'Database NOT used: its schema is newer than this Appbuilder (see the error above). Data routes are off.'
      : st.unavailable
        ? 'Database not reachable yet: retrying in the background.'
        : hosting.setupClosed
          ? 'Database not configured yet: run `appbuilder migrate` and `appbuilder admin invite` (setup over HTTP is closed).'
          : 'Database not configured yet: open the app on this computer to run the setup (use the setup code above).')
  if (!hosting.setupClosed && app.services.setupCode.current() && !app.services.setupComplete()) log('info', `Setup code: ${app.services.setupCode.current()} (shown above; needed by the setup screen)`)
}
if (hosting.socket) server.listen(hosting.socket, listening)
else server.listen(port, host, listening)

/**
 * Shutdown order: stop accepting connections and end idle keep-alive ones; then the app closes the live sockets, stops
 * the job worker (running jobs get their grace, the rest are released for the next start) and closes the database;
 * the process exits after APPBUILDER_SHUTDOWN_MS at the latest. A Unix socket file is removed by server.close().
 */
let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  log('info', `${signal}: shutting down`)
  server.close()
  server.closeIdleConnections()
  const force = setTimeout(() => {
    log('warn', `shutdown took longer than ${hosting.shutdownMs} ms: exiting`)
    process.exit(0)
  }, hosting.shutdownMs)
  force.unref()
  try {
    await app.close()
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
