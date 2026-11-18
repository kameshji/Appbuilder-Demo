/** Static serving of dist/ with SPA fallback, security headers and the HTML CSP. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SECURITY_HEADERS, htmlCsp } from './router.ts'

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

/**
 * SHA-256 (base64) of the text of every inline <script> element (no src attribute) of an HTML document, as CSP
 * 'sha256-...' sources need it: the exact characters between <script ...> and </script>, UTF-8 encoded.
 */
export function inlineScriptHashes(html: string): string[] {
  const out = new Set<string>()
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const attrs = m[1]
    if (/\bsrc\s*=/i.test(attrs)) continue
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase()
    // data blocks (application/json, importmap...) are not executed, but hashing them is harmless; skip empty scripts
    if (type && type !== 'module' && type !== 'text/javascript' && type !== 'application/javascript') continue
    if (m[2] === '') continue
    out.add(createHash('sha256').update(m[2], 'utf8').digest('base64'))
  }
  return [...out]
}

/** CSP per HTML file, recomputed when the file's mtime or size changes (the build replaces dist/index.html) */
const cspCache = new Map<string, { mtimeMs: number; size: number; csp: string }>()
export function cspForHtmlFile(file: string, stat: fs.Stats): string {
  const hit = cspCache.get(file)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.csp
  let csp: string
  try {
    csp = htmlCsp(inlineScriptHashes(fs.readFileSync(file, 'utf8')))
  } catch {
    csp = htmlCsp()
  }
  cspCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, csp })
  return csp
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
  if (ext === '.html') headers['Content-Security-Policy'] = cspForHtmlFile(file, stat)
  res.writeHead(200, headers)
  if (req.method === 'HEAD') res.end()
  else fs.createReadStream(file).on('error', () => res.destroy()).pipe(res)
}
