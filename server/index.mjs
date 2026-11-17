#!/usr/bin/env node
// Appbuilder local server: serves the built app from ./dist and the workspace file API under /api/fs/*.
// Dependency free. Binds to 127.0.0.1 only (set APPBUILDER_HOST to change it, at your own risk).
//   PORT                   default 5174
//   APPBUILDER_WORKSPACE   default ./workspace (next to package.json)
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFsHandler } from './handler.mjs'
import { pathProblem } from './pathGuard.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(here, '..', 'dist')
const host = process.env.APPBUILDER_HOST || '127.0.0.1'
const port = Number(process.env.PORT) || 5174

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const fsApi = createFsHandler()

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end()
    return
  }
  let rel = ''
  try {
    rel = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname).replace(/^\/+/, '')
  } catch {
    res.writeHead(400).end()
    return
  }
  if (rel !== '' && pathProblem(rel.replace(/\/$/, '')) !== null) {
    res.writeHead(400).end('bad path')
    return
  }
  let file = rel === '' ? path.join(distDir, 'index.html') : path.join(distDir, ...rel.split('/'))
  let stat = fs.existsSync(file) ? fs.statSync(file) : null
  if (stat?.isDirectory()) {
    file = path.join(file, 'index.html')
    stat = fs.existsSync(file) ? fs.statSync(file) : null
  }
  if (!stat) {
    // Single page app: unknown paths without an extension fall back to index.html.
    if (path.extname(rel)) {
      res.writeHead(404).end('not found')
      return
    }
    file = path.join(distDir, 'index.html')
    stat = fs.existsSync(file) ? fs.statSync(file) : null
    if (!stat) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('The app has not been built yet. Run "npm run build" first, then "npm start". (The file API at /api/fs/* is running.)')
      return
    }
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': path.basename(file) === 'index.html' ? 'no-cache' : 'public, max-age=3600',
  })
  if (req.method === 'HEAD') res.end()
  else fs.createReadStream(file).pipe(res)
}

const server = http.createServer((req, res) => {
  fsApi.handle(req, res).then(
    (handled) => {
      if (!handled) serveStatic(req, res)
    },
    () => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    },
  )
})

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Set PORT to another value.` : e)
  process.exit(1)
})

server.listen(port, host, () => {
  console.log(`Appbuilder is running at http://${host === '127.0.0.1' ? 'localhost' : host}:${port}/`)
  console.log(`Workspace folder: ${fsApi.root}`)
})
