// The workspace file API: GET /api/fs/health, GET /api/fs/read, PUT /api/fs/write,
// DELETE /api/fs/remove, GET /api/fs/list. Used by server/index.mjs and the Vite dev middleware.
// Dependency free. Everything is confined to one root folder.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolveSafe, PathError } from './pathGuard.mjs'

export const MAX_BODY_BYTES = 50 * 1024 * 1024

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** APPBUILDER_WORKSPACE, else <project>/workspace */
export function defaultWorkspaceRoot() {
  return path.resolve(process.env.APPBUILDER_WORKSPACE || path.join(projectRoot, 'workspace'))
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(payload)
}
const fail = (res, status, message) => send(res, status, { ok: false, error: message })

function hostnameOf(value) {
  try {
    return new URL(/^[a-z]+:\/\//i.test(value) ? value : 'http://' + value).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return ''
  }
}
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * Local-only guard against DNS rebinding and cross-site requests: the Host header (and Origin, when
 * the browser sends one) must name this machine. Disable with `allowAnyHost` only for testing.
 */
function hostAllowed(req, allowAnyHost) {
  if (allowAnyHost) return true
  if (!LOCAL_HOSTS.has(hostnameOf(String(req.headers.host ?? '')))) return false
  const origin = req.headers.origin
  if (origin && origin !== 'null' && !LOCAL_HOSTS.has(hostnameOf(String(origin)))) return false
  if (origin === 'null') return false
  return true
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      reject(Object.assign(new Error('body too large'), { status: 413 }))
      return
    }
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * @param {{ root?: string, maxBodyBytes?: number, allowAnyHost?: boolean }} [options]
 * @returns {{ root: string, handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<boolean> }}
 * `handle` resolves true when the request was an /api/fs/* request (and has been answered).
 */
export function createFsHandler(options = {}) {
  const root = path.resolve(options.root ?? defaultWorkspaceRoot())
  const limit = options.maxBodyBytes ?? MAX_BODY_BYTES

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/api/fs/')) return false
    try {
      if (!hostAllowed(req, options.allowAnyHost)) {
        fail(res, 403, 'forbidden host')
        return true
      }
      const route = url.pathname.slice('/api/fs/'.length)
      const method = req.method ?? 'GET'

      if (route === 'health') {
        if (method !== 'GET') return fail(res, 405, 'method not allowed'), true
        fs.mkdirSync(root, { recursive: true })
        send(res, 200, { ok: true, app: 'appbuilder', root })
        return true
      }

      if (route === 'read') {
        if (method !== 'GET') return fail(res, 405, 'method not allowed'), true
        const abs = resolveSafe(root, url.searchParams.get('path') ?? '')
        let text
        try {
          text = await fs.promises.readFile(abs, 'utf8')
        } catch (e) {
          // A missing file is not an error: 204 with a marker header keeps browser consoles quiet.
          if (e.code === 'ENOENT' || e.code === 'EISDIR' || e.code === 'ENOTDIR') {
            res.writeHead(204, { 'X-Appbuilder-Missing': '1', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
            res.end()
            return true
          }
          throw e
        }
        send(res, 200, text, 'text/plain; charset=utf-8')
        return true
      }

      if (route === 'write') {
        if (method !== 'PUT' && method !== 'POST') return fail(res, 405, 'method not allowed'), true
        const abs = resolveSafe(root, url.searchParams.get('path') ?? '')
        const body = await readBody(req, limit)
        await fs.promises.mkdir(path.dirname(abs), { recursive: true })
        // Atomic: write a temp file in the same folder, then rename over the target.
        const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomBytes(6).toString('hex')}.tmp`)
        try {
          await fs.promises.writeFile(tmp, body)
          await fs.promises.rename(tmp, abs)
        } catch (e) {
          await fs.promises.rm(tmp, { force: true }).catch(() => {})
          throw e
        }
        send(res, 200, { ok: true, bytes: body.length })
        return true
      }

      if (route === 'remove') {
        if (method !== 'DELETE') return fail(res, 405, 'method not allowed'), true
        const abs = resolveSafe(root, url.searchParams.get('path') ?? '')
        const stat = await fs.promises.stat(abs).catch(() => null)
        if (stat?.isDirectory()) return fail(res, 400, 'refusing to remove a directory'), true
        await fs.promises.rm(abs, { force: true })
        send(res, 200, { ok: true })
        return true
      }

      if (route === 'list') {
        if (method !== 'GET') return fail(res, 405, 'method not allowed'), true
        const dir = url.searchParams.get('dir') ?? ''
        const abs = resolveSafe(root, dir.replace(/\/+$/, ''), { allowEmpty: true })
        let entries = []
        try {
          entries = await fs.promises.readdir(abs, { withFileTypes: true })
        } catch (e) {
          if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e
        }
        const files = entries.filter((d) => d.isFile() && !d.name.endsWith('.tmp')).map((d) => d.name).sort()
        send(res, 200, { ok: true, dir, files })
        return true
      }

      fail(res, 404, 'unknown api route')
      return true
    } catch (e) {
      if (e instanceof PathError) fail(res, 400, e.message)
      else if (e && e.status) fail(res, e.status, e.message)
      else fail(res, 500, 'internal error')
      return true
    }
  }

  return { root, handle }
}
