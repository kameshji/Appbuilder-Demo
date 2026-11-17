/**
 * HTTP router for /api/v1: path params, JSON/raw bodies with limits, Host/Origin guard (DNS rebinding),
 * CSRF header rule, security headers, session resolution and auth levels, ApiError mapping.
 * Patterns may be written with or without the "/api/v1" prefix ("/apps/:id" == "/api/v1/apps/:id").
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { Readable } from 'node:stream'
import { HttpError } from './contracts.ts'
import type { AuthLevel, Ctx, Handler, RawResponse, Router, Services, UserContext } from './contracts.ts'
import { API_BASE, CSRF_HEADER, SESSION_COOKIE } from '../../src/platform/http.ts'
import { mapDbError } from '../connectors/mysql/index.ts'
import { errText, log } from './util.ts'

export const JSON_LIMIT_BYTES = 2 * 1024 * 1024
export const DEFAULT_RAW_MB = 25

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
interface Route {
  method: Method
  segments: string[]
  literalCount: number
  handler: Handler
  opts: { auth: AuthLevel; raw?: boolean; maxBodyMB?: number }
}

/** resolves the signed-in user (null = no valid session); provided by auth.ts */
export type SessionResolver = (ctx: Ctx) => Promise<UserContext | null>

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
}
export const HTML_CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'"

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

function hostnameOf(value: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'http://' + value).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return ''
  }
}
function hostPortOf(value: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'http://' + value).host.toLowerCase()
  } catch {
    return ''
  }
}

/** Host must name this machine; Origin (when sent) must be the same origin. Returns a reason or null. */
export function originProblem(req: IncomingMessage, allowAnyHost = false): string | null {
  if (allowAnyHost) return null
  const host = String(req.headers.host ?? '')
  if (!LOCAL_HOSTS.has(hostnameOf(host))) return 'Requests must be made to localhost.'
  const origin = req.headers.origin
  if (origin !== undefined) {
    if (origin === 'null' || !LOCAL_HOSTS.has(hostnameOf(String(origin)))) return 'Cross-origin requests are not allowed.'
    if (hostPortOf(String(origin)) !== hostPortOf(host)) return 'Cross-origin requests are not allowed.'
  }
  const site = req.headers['sec-fetch-site']
  if (site === 'cross-site') return 'Cross-origin requests are not allowed.'
  return null
}

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      req.resume()
      reject(new HttpError(413, 'invalid', `The request body is too large (limit ${Math.round(limit / 1024 / 1024)} MB).`))
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (c: Buffer) => {
      if (done) return
      size += c.length
      if (size > limit) {
        done = true
        reject(new HttpError(413, 'invalid', `The request body is too large (limit ${Math.round(limit / 1024 / 1024)} MB).`))
        req.resume()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!done) {
        done = true
        resolve(Buffer.concat(chunks))
      }
    })
    req.on('error', (e) => {
      if (!done) {
        done = true
        reject(e)
      }
    })
  })
}

function isRaw(v: unknown): v is RawResponse {
  return !!v && typeof v === 'object' && (v as RawResponse).raw === true && 'body' in (v as object)
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end()
    return
  }
  const payload = JSON.stringify(body ?? null)
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload)),
    ...extra,
  })
  res.end(payload)
}

/** any thrown value -> HttpError (never leaks stacks, SQL or secrets; unexpected errors are logged) */
export function toHttpError(e: unknown): HttpError {
  if (e instanceof HttpError) return e
  const code = (e as { code?: unknown })?.code
  if (typeof code === 'string' && (code.startsWith('ER_') || /^(ECONN|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|PROTOCOL_|POOL_)/.test(code))) {
    const mapped = mapDbError(e)
    if (mapped.status >= 500) log('error', `database error: ${errText(e)}`)
    return mapped
  }
  log('error', `unhandled error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  return new HttpError(500, 'storage', 'Internal server error.')
}

export function sendError(res: ServerResponse, e: unknown): void {
  const h = toHttpError(e)
  sendJson(res, h.status, { error: { code: h.code, message: h.message, ...(h.field ? { field: h.field } : {}) } })
}

export function cookieValue(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim()
      try {
        return decodeURIComponent(v)
      } catch {
        return null
      }
    }
  }
  return null
}

function sessionCookie(req: IncomingMessage, token: string | null, expires?: Date): string {
  const secure = (req.socket as TLSSocket).encrypted ? '; Secure' : ''
  if (token === null) return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`
  const exp = expires ? `; Expires=${expires.toUTCString()}` : ''
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/${exp}${secure}`
}

export interface ApiRouter extends Router {
  /** answers /api/* requests; resolves false for anything else */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>
  setSessionResolver(r: SessionResolver): void
}

export function createRouter(services: Services, opts: { allowAnyHost?: boolean } = {}): ApiRouter {
  const routes: Route[] = []
  let resolveSession: SessionResolver = async () => null

  function add(method: Method, pattern: string, handler: Handler, o: { auth: AuthLevel; raw?: boolean; maxBodyMB?: number }) {
    let p = pattern.trim()
    if (p.startsWith(API_BASE)) p = p.slice(API_BASE.length)
    const segments = p.split('/').filter(Boolean)
    routes.push({ method, segments, literalCount: segments.filter((s) => !s.startsWith(':')).length, handler, opts: o })
  }

  function match(method: string, segs: string[]): { route: Route; params: Record<string, string> } | null | 'method' {
    let best: { route: Route; params: Record<string, string> } | null = null
    let pathMatched = false
    for (const r of routes) {
      if (r.segments.length !== segs.length) continue
      const params: Record<string, string> = {}
      let ok = true
      for (let i = 0; i < segs.length; i++) {
        const s = r.segments[i]
        if (s.startsWith(':')) params[s.slice(1)] = segs[i]
        else if (s !== segs[i]) {
          ok = false
          break
        }
      }
      if (!ok) continue
      pathMatched = true
      if (r.method !== method) continue
      if (!best || r.literalCount > best.route.literalCount) best = { route: r, params }
    }
    if (!best && pathMatched) return 'method'
    return best
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return false
    try {
      const problem = originProblem(req, opts.allowAnyHost)
      if (problem) throw new HttpError(403, 'denied', problem)
      const method = (req.method ?? 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD' && req.headers[CSRF_HEADER.toLowerCase()] !== '1') {
        throw new HttpError(403, 'denied', `Missing ${CSRF_HEADER} header.`)
      }
      if (!url.pathname.startsWith(API_BASE + '/') && url.pathname !== API_BASE) throw new HttpError(404, 'not-found', 'Unknown API route.')
      let segs: string[]
      try {
        segs = url.pathname.slice(API_BASE.length).split('/').filter(Boolean).map((s) => decodeURIComponent(s))
      } catch {
        throw new HttpError(400, 'invalid', 'Malformed URL.')
      }
      const m = match(method === 'HEAD' ? 'GET' : method, segs)
      if (m === null) throw new HttpError(404, 'not-found', 'Unknown API route.')
      if (m === 'method') throw new HttpError(405, 'invalid', 'Method not allowed.')
      const { route, params } = m

      const ctx: Ctx = {
        req,
        res,
        method,
        path: url.pathname,
        params,
        query: url.searchParams,
        body: undefined,
        services,
        setSessionCookie(token, expires) {
          const prev = res.getHeader('Set-Cookie')
          const list = Array.isArray(prev) ? prev.filter((c) => !c.startsWith(SESSION_COOKIE + '=')) : []
          res.setHeader('Set-Cookie', [...list, sessionCookie(req, token, expires)])
        },
      }

      // body
      if (method !== 'GET' && method !== 'HEAD') {
        if (route.opts.raw) {
          ctx.rawBody = await readBody(req, (route.opts.maxBodyMB ?? DEFAULT_RAW_MB) * 1024 * 1024)
        } else {
          const buf = await readBody(req, JSON_LIMIT_BYTES)
          if (buf.length) {
            const type = String(req.headers['content-type'] ?? 'application/json')
            if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'invalid', 'Request body must be application/json.')
            try {
              ctx.body = JSON.parse(buf.toString('utf8'))
            } catch {
              throw new HttpError(422, 'invalid', 'Request body is not valid JSON.')
            }
          }
        }
      }

      // auth
      if (route.opts.auth !== 'none') {
        if (!services.ready()) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
        const user = await resolveSession(ctx)
        if (!user) throw new HttpError(401, 'unauthenticated', 'Please sign in.')
        if (route.opts.auth === 'maker' && !user.privileges.isMaker) throw new HttpError(403, 'denied', 'Only makers can do this.')
        if (route.opts.auth === 'admin' && !user.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only administrators can do this.')
        ctx.user = user
      } else if (services.ready() && cookieValue(req, SESSION_COOKIE)) {
        try {
          ctx.user = (await resolveSession(ctx)) ?? undefined
        } catch {
          ctx.user = undefined
        }
      }

      const out = await route.handler(ctx)
      if (res.writableEnded) return true
      if (isRaw(out)) {
        const headers: Record<string, string> = { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...(out.headers ?? {}) }
        if (!res.headersSent) res.writeHead(out.status ?? 200, headers)
        if (method === 'HEAD') {
          res.end()
        } else if (typeof out.body === 'string' || Buffer.isBuffer(out.body)) {
          res.end(out.body)
        } else {
          const stream = out.body as Readable
          await new Promise<void>((resolve) => {
            stream.on('error', (e) => {
              log('error', `stream failed: ${errText(e)}`)
              res.destroy()
              resolve()
            })
            res.on('close', () => resolve())
            stream.pipe(res)
          })
        }
        return true
      }
      sendJson(res, 200, out === undefined ? { ok: true } : out)
      return true
    } catch (e) {
      sendError(res, e)
      return true
    }
  }

  return {
    add,
    handle,
    setSessionResolver(r) {
      resolveSession = r
    },
  }
}
