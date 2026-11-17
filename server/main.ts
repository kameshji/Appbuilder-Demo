#!/usr/bin/env node
/**
 * Appbuilder local server: `node server/main.ts` (Node 22.18+ type stripping).
 * Serves the Data API v1 under /api/v1 and the built app from dist/ (SPA fallback).
 *   PORT (5174)   APPBUILDER_HOST (127.0.0.1)   APPBUILDER_WORKSPACE (./workspace)   APPBUILDER_SECRET_KEY
 *   APPBUILDER_DB_HOST / _PORT / _NAME / _USER / _PASSWORD  (optional bootstrap, skips the setup screen)
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
  log('info', app.services.ready() ? `Database: ${app.services.state.location}` : 'Database not configured yet: open the app to run the setup.')
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
