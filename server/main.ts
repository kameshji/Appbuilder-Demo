#!/usr/bin/env node
/**
 * Appbuilder local server: `node server/main.ts` (Node 22.18+ type stripping).
 * Serves the Data API v1 under /api/v1 and the built app from dist/ (SPA fallback).
 *   PORT (5174)   APPBUILDER_HOST (127.0.0.1)   APPBUILDER_WORKSPACE (./workspace)   APPBUILDER_SECRET_KEY
 *   APPBUILDER_DB_HOST / _PORT (5432) / _NAME / _USER / _PASSWORD / _SSL  (optional PostgreSQL bootstrap, skips the setup screen)
 *   APPBUILDER_ALLOWED_HOSTS (extra Host names)  APPBUILDER_SECURE_COOKIE=1  APPBUILDER_TRUST_PROXY=1
 */
import http from 'node:http'
import { createApp } from './core/app.ts'
import { serveStatic } from './core/static.ts'
import { log } from './core/util.ts'

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
