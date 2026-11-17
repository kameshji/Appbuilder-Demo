/** Static serving of dist/ with SPA fallback, security headers and the HTML CSP. */
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { HTML_CSP, SECURITY_HEADERS } from './router.ts'

const MIME: Record<string, string> = {
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
  '.wasm': 'application/wasm',
}

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(text)
}

/** a request path is safe when it has no parent, hidden, empty or backslash segments */
export function safeStaticPath(rel: string): boolean {
  if (rel.includes('\0') || rel.includes('\\') || rel.length > 400) return false
  return rel.split('/').every((s) => s !== '..' && s !== '.' && !s.startsWith('.'))
}

export function serveStatic(distDir: string, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    plain(res, 405, 'Method not allowed')
    return
  }
  let rel = ''
  try {
    rel = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname).replace(/^\/+/, '').replace(/\/+$/, '')
  } catch {
    plain(res, 400, 'Bad request')
    return
  }
  if (rel !== '' && !safeStaticPath(rel)) {
    plain(res, 400, 'Bad path')
    return
  }
  const root = path.resolve(distDir)
  let file = rel === '' ? path.join(root, 'index.html') : path.resolve(root, ...rel.split('/'))
  if (file !== root && !file.startsWith(root + path.sep)) {
    plain(res, 400, 'Bad path')
    return
  }
  let stat = fs.statSync(file, { throwIfNoEntry: false })
  if (stat?.isDirectory()) {
    file = path.join(file, 'index.html')
    stat = fs.statSync(file, { throwIfNoEntry: false })
  }
  if (!stat || !stat.isFile()) {
    // single page app: extension-less paths fall back to index.html
    if (path.extname(rel)) {
      plain(res, 404, 'Not found')
      return
    }
    file = path.join(root, 'index.html')
    stat = fs.statSync(file, { throwIfNoEntry: false })
    if (!stat) {
      plain(res, 503, 'The app has not been built yet. Run "npm run build" first, then "npm start". (The API at /api/v1 is running.)')
      return
    }
  }
  const ext = path.extname(file).toLowerCase()
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': String(stat.size),
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  }
  if (ext === '.html') headers['Content-Security-Policy'] = HTML_CSP
  res.writeHead(200, headers)
  if (req.method === 'HEAD') res.end()
  else fs.createReadStream(file).on('error', () => res.destroy()).pipe(res)
}
