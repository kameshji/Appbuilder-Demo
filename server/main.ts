#!/usr/bin/env node
/**
 * Appbuilder local server: `node server/main.ts` (Node 22.18+ type stripping).
 * Serves the Data API v1 under /api/v1 and the built app from dist/ (SPA fallback).
 * `node server/main.ts restore <archive.abbak> [options]` restores an install from a backup instead (backup/cli.ts).
 * `node server/main.ts version|verify-release|update|diagnostics|health|seed-config`: tools of an installed server
 * (update/cli.ts; the installers wrap them as the `appbuilder` command).
 * `node server/main.ts admin list|reset-password|reset-mfa|make-install-admin <email>`: recovery of administrator access
 * on the server machine (identity/admin-cli.ts).
 *   PORT (5174)   APPBUILDER_HOST (127.0.0.1)   APPBUILDER_WORKSPACE (./workspace)   APPBUILDER_SECRET_KEY
 *   APPBUILDER_DB_HOST / _PORT (5432) / _NAME / _USER / _PASSWORD / _SSL  (optional PostgreSQL bootstrap, skips the setup screen)
 *   APPBUILDER_ALLOWED_HOSTS (extra Host names)  APPBUILDER_SECURE_COOKIE=1  APPBUILDER_TRUST_PROXY=1
 */
import http from 'node:http'
import { createApp } from './core/app.ts'
import { serveStatic } from './core/static.ts'
import { log } from './core/util.ts'
import { startFileLogging } from './core/diagnostics/logger.ts'
import { loadConfig } from './core/config.ts'

// offline recovery of administrator access (identity/admin-cli.ts): appbuilder admin list | reset-password | reset-mfa |
// make-install-admin <email>; needs the workspace's secret key and database login, works with the server running or not
if (process.argv[2] === 'admin') {
  ;(await import('./core/update/cli.ts')).loadInstallEnv()
  const { runAdminCli } = await import('./core/identity/admin-cli.ts')
  process.exit(await runAdminCli(process.argv.slice(3)))
}
// the setup code of a server installed as a service (it is in the setup-code file, not in a window)
if (process.argv[2] === 'setup-code') {
  ;(await import('./core/update/cli.ts')).loadInstallEnv()
  const { runSetupCodeCli } = await import('./core/identity/admin-cli.ts')
  process.exit(runSetupCodeCli())
}

// installed-server tools: version, verify-release, update, diagnostics, health, seed-config (update/cli.ts)
const { CLI_COMMANDS, runOpsCli } = await import('./core/update/cli.ts')
// an installed server's `appbuilder restore` uses the service's environment file (database login, workspace)
if (process.argv[2] === 'restore') (await import('./core/update/cli.ts')).loadInstallEnv()
if (CLI_COMMANDS.has(process.argv[2] ?? '')) process.exit(await runOpsCli(process.argv.slice(2)))

// `node server/main.ts restore <archive>`: install restore from a backup (docs/admin/disaster-recovery.md), no server
if (process.argv[2] === 'restore') {
  const { runCli } = await import('./core/backup/cli.ts')
  process.exit(await runCli(process.argv.slice(2)))
}

// the rotating JSON-lines file log in <workspace>/logs (package L); the console keeps human-readable lines
startFileLogging(loadConfig().workspaceDir)

const app = await createApp()
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
  if (!app.handleUpgrade(req, socket, head)) socket.destroy()
})

server.on('error', (e: NodeJS.ErrnoException) => {
  log('error', e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Set PORT to another value.` : String(e))
  process.exit(1)
})

server.listen(port, host, () => {
  log('info', `Appbuilder is running at http://${host === '127.0.0.1' ? 'localhost' : host}:${port}/`)
  log('info', `Workspace folder: ${workspaceDir}`)
  const st = app.services.state
  log('info', app.services.ready()
    ? `Database: ${st.location}`
    : st.incompatible
      ? 'Database NOT used: its schema is newer than this Appbuilder (see the error above). Data routes are off.'
      : st.unavailable
        ? 'Database not reachable yet: retrying in the background.'
        : 'Database not configured yet: open the app on this computer to run the setup (use the setup code above).')
  if (app.services.setupCode.current() && !app.services.setupComplete()) log('info', `Setup code: ${app.services.setupCode.current()} (shown above; needed by the setup screen)`)
})

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  log('info', `${signal}: shutting down`)
  server.close()
  const force = setTimeout(() => process.exit(0), 5000)
  force.unref()
  try {
    await app.close()
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
