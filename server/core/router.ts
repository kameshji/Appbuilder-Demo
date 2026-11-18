/**
 * HTTP router for /api/v1: path params, JSON/raw bodies with limits, Host/Origin guard (DNS rebinding),
 * CSRF header rule, security headers, session resolution and auth levels, ApiError mapping.
 * Patterns may be written with or without the "/api/v1" prefix ("/apps/:id" == "/api/v1/apps/:id").
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { Readable } from 'node:stream'
import { HttpError } from './contracts.ts'
import type { Ctx, Handler, RawResponse, RouteOptions, Router, Services, UserContext } from './contracts.ts'
import { API_BASE, CSRF_HEADER, SESSION_COOKIE } from '../../src/platform/http.ts'
import { mapDbError } from '../connectors/mysql/index.ts'
import { isPgError, mapPgError } from '../connectors/postgres/db.ts'
import { DEFAULT_ENVIRONMENT_ID, requestedEnvironment, runInEnvironment } from './env-context.ts'
import { errText, log } from './util.ts'

/** default JSON body limit; a route's maxBodyMB overrides it (JSON and raw bodies alike) */
export const JSON_LIMIT_BYTES = 2 * 1024 * 1024
export const DEFAULT_RAW_MB = 25

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
interface Route {
  method: Method
  segments: string[]
  literalCount: number
  handler: Handler
  opts: RouteOptions
}

/**
 * resolves the signed-in user (null = no valid session) and the environment the request works in (checked against the
 * user's access; ctx.requestedEnvironment is what the request named); provided by auth.ts. allowNoEnvironment: a user
 * who may enter no environment still gets a context (in Default, without roles) instead of a 403.
 */
export type SessionResolver = (ctx: Ctx, o?: { allowNoEnvironment?: boolean }) => Promise<UserContext | null>

/**
 * Routes that change an environment's design (apps, tables and columns, roles, solutions and their components, data
 * files, linking a source table). In a locked production environment they answer 403: changes arrive by solution
 * import only (POST /solutions/import, /solutions/:id/deploy into it). Data, users, connections and access stay usable.
 */
export const DESIGN_ROUTES: ReadonlySet<string> = new Set([
  'POST /apps', 'PUT /apps/:id', 'PATCH /apps/:id', 'DELETE /apps/:id', 'POST /apps/:id/duplicate', 'POST /apps/import',
  'POST /tables', 'POST /tables/from-csv', 'PATCH /tables/:id', 'DELETE /tables/:id', 'POST /tables/:id/columns',
  'PATCH /tables/:id/columns/:name', 'DELETE /tables/:id/columns/:name', 'POST /tables/:id/move',
  'POST /roles', 'PATCH /roles/:id', 'DELETE /roles/:id',
  'POST /solutions', 'PATCH /solutions/:id', 'DELETE /solutions/:id', 'POST /solutions/:id/components', 'DELETE /solutions/:id/components/:kind/:cid',
  'POST /files', 'POST /files/:id/replace', 'DELETE /files/:id',
  'POST /connections/:id/link',
])

export const LOCKED_MESSAGE = 'This environment is locked: apps, tables and roles change only by importing or deploying a solution into it. An install administrator can unlock it in Admin console > Environments.'

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
}
/**
 * The HTML page's Content-Security-Policy. script-src allows only same-origin files and the inline scripts whose SHA-256
 * hashes are passed (computed from the served file by static.ts), never 'unsafe-inline'. style-src keeps 'unsafe-inline':
 * React and Radix set style attributes at run time (positions of popovers, sizes, transforms), which hashes cannot cover.
 */
export function htmlCsp(scriptHashes: string[] = []): string {
  const scripts = ["'self'", ...scriptHashes.map((h) => `'sha256-${h}'`)].join(' ')
  return `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src ${scripts}; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'`
}
/** CSP for an HTML file without inline scripts */
export const HTML_CSP = htmlCsp()

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1']

/** the TCP peer is this machine: 127.0.0.0/8, ::1 or an IPv4-mapped loopback (::ffff:127.x.y.z). Never from headers. */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false
  const a = addr.toLowerCase()
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true
  const v4 = a.startsWith('::ffff:') ? a.slice(7) : a
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)
}

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

/**
 * DNS-rebinding and cross-origin guard: Host must be one of the configured host names (default: the loopback names);
 * Origin (when sent) must be the same origin. Returns a reason or null. These are headers the client chooses, so this
 * stops web pages in a browser, not programs: it is never used as proof that a request comes from this computer
 * (see isLoopbackAddress and RouteOptions.loopbackOnly).
 */
export function originProblem(req: IncomingMessage, allowAnyHost = false, allowedHosts: readonly string[] = LOCAL_HOSTS): string | null {
  if (allowAnyHost) return null
  const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()))
  const host = String(req.headers.host ?? '')
  if (!allowed.has(hostnameOf(host).toLowerCase())) return 'Requests must be made to a configured host name.'
  const origin = req.headers.origin
  if (origin !== undefined) {
    if (origin === 'null' || !allowed.has(hostnameOf(String(origin)).toLowerCase())) return 'Cross-origin requests are not allowed.'
    if (hostPortOf(String(origin)) !== hostPortOf(host)) return 'Cross-origin requests are not allowed.'
  }
  const site = req.headers['sec-fetch-site']
  if (site === 'cross-site') return 'Cross-origin requests are not allowed.'
  return null
}

const mbText = (bytes: number): string => {
  const mb = bytes / 1024 / 1024
  return Number.isInteger(mb) ? String(mb) : mb >= 1 ? String(Math.round(mb * 10) / 10) : String(Math.round(mb * 100) / 100)
}

/** the 413 of an oversized body; the router closes the connection after sending it (see sendError) */
export function tooLarge(limit: number, message?: string): HttpError {
  const e = new HttpError(413, 'invalid', message ?? `The request body is too large (limit ${mbText(limit)} MB).`)
  ;(e as HttpError & { closeConnection?: boolean }).closeConnection = true
  return e
}

/**
 * Reads the body up to `limit` bytes. A declared Content-Length above the limit is refused before reading; a body that
 * grows past the limit is refused as soon as the limit is crossed (nothing more is buffered and the stream is paused;
 * the router answers 413 and closes the connection, so the client cannot keep uploading).
 */
export function readBody(req: IncomingMessage, limit: number, message?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      req.pause()
      reject(tooLarge(limit, message))
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
        chunks.length = 0
        req.pause()
        reject(tooLarge(limit, message))
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
  if (isPgError(e)) {
    const mapped = mapPgError(e)
    if (mapped.status >= 500) log('error', `database error: ${errText(e)}`)
    return mapped
  }
  const code = (e as { code?: unknown })?.code
  if (typeof code === 'string' && (code.startsWith('ER_') || /^(ECONN|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|PROTOCOL_|POOL_)/.test(code))) {
    const mapped = mapDbError(e)
    if (mapped.status >= 500) log('error', `database error: ${errText(e)}`)
    return mapped
  }
  log('error', `unhandled error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  return new HttpError(500, 'storage', 'Internal server error.')
}

export function sendError(res: ServerResponse, e: unknown, req?: IncomingMessage): void {
  const h = toHttpError(e)
  const close = !!(h as HttpError & { closeConnection?: boolean }).closeConnection
  if (close && req) {
    // unread request bytes are not drained: answer, then drop the connection
    res.on('finish', () => req.destroy())
  }
  sendJson(res, h.status, { error: { code: h.code, message: h.message, ...(h.field ? { field: h.field } : {}) } }, close ? { Connection: 'close' } : {})
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

export interface CookieOptions {
  /** APPBUILDER_SECURE_COOKIE=1 */
  secureCookie?: boolean
  /** APPBUILDER_TRUST_PROXY=1: X-Forwarded-Proto: https marks the cookie Secure */
  trustProxy?: boolean
}

/** Secure when the socket is TLS, when configured, or behind a trusted proxy that reports https */
export function cookieIsSecure(req: IncomingMessage, o: CookieOptions = {}): boolean {
  if ((req.socket as TLSSocket | undefined)?.encrypted) return true
  if (o.secureCookie) return true
  if (o.trustProxy) {
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase()
    if (proto === 'https') return true
  }
  return false
}

export function sessionCookie(req: IncomingMessage, token: string | null, expires?: Date, o: CookieOptions = {}): string {
  const secure = cookieIsSecure(req, o) ? '; Secure' : ''
  if (token === null) return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`
  const exp = expires ? `; Expires=${expires.toUTCString()}` : ''
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/${exp}${secure}`
}

export interface ApiRouter extends Router {
  /** answers /api/* requests; resolves false for anything else */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>
  setSessionResolver(r: SessionResolver): void
}

export interface RouterOptions extends CookieOptions {
  allowAnyHost?: boolean
  /** default: services.config.allowedHosts, else the loopback names */
  allowedHosts?: readonly string[]
}

export function createRouter(services: Services, opts: RouterOptions = {}): ApiRouter {
  const cfg = (services as Partial<Services>).config
  const allowedHosts = opts.allowedHosts ?? cfg?.allowedHosts ?? LOCAL_HOSTS
  const cookieOpts: CookieOptions = { secureCookie: opts.secureCookie ?? cfg?.secureCookie, trustProxy: opts.trustProxy ?? cfg?.trustProxy }
  const routes: Route[] = []
  let resolveSession: SessionResolver = async () => null

  function add(method: Method, pattern: string, handler: Handler, o: RouteOptions) {
    let p = pattern.trim()
    if (p.startsWith(API_BASE)) p = p.slice(API_BASE.length)
    const segments = p.split('/').filter(Boolean)
    const design = o.design ?? DESIGN_ROUTES.has(`${method} /${segments.join('/')}`)
    routes.push({ method, segments, literalCount: segments.filter((s) => !s.startsWith(':')).length, handler, opts: design ? { ...o, design } : o })
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

  /**
   * every handler runs inside its environment (env-context.ts): meta store, caches, the default connector and the
   * workspace folders follow it. The environment is decided with the session (resolveSession checks the user's access).
   */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return false
    return handleIn(req, res, url)
  }

  async function handleIn(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    /** a streamBody route answered without reading its body: close instead of draining the upload */
    let unreadStream = false
    const closeIfUnread = () => {
      if (!unreadStream || req.complete) return
      if (!res.headersSent) res.setHeader('Connection', 'close')
      res.on('finish', () => req.destroy())
    }
    try {
      const problem = originProblem(req, opts.allowAnyHost, allowedHosts)
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
      if (m === 'method') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.')
      const { route, params } = m
      // setup endpoints: the TCP peer must be this machine, whatever the headers say
      if (route.opts.loopbackOnly && !isLoopbackAddress(req.socket?.remoteAddress)) {
        throw new HttpError(403, 'denied', 'This can only be done on the computer that runs Appbuilder (open it at http://localhost).')
      }
      const requested = requestedEnvironment(req, url)

      const ctx: Ctx = {
        req,
        res,
        method,
        path: url.pathname,
        params,
        query: url.searchParams,
        body: undefined,
        environmentId: DEFAULT_ENVIRONMENT_ID,
        requestedEnvironment: requested,
        services,
        setSessionCookie(token, expires) {
          const prev = res.getHeader('Set-Cookie')
          const list = Array.isArray(prev) ? prev.filter((c) => !c.startsWith(SESSION_COOKIE + '=')) : []
          res.setHeader('Set-Cookie', [...list, sessionCookie(req, token, expires, cookieOpts)])
        },
      }

      // body (limit: the route's maxBodyMB, else 2 MB for JSON / 25 MB for raw)
      const hasBody = method !== 'GET' && method !== 'HEAD'
      const routeLimit = route.opts.maxBodyMB !== undefined ? route.opts.maxBodyMB * 1024 * 1024 : route.opts.raw ? DEFAULT_RAW_MB * 1024 * 1024 : JSON_LIMIT_BYTES
      if (hasBody && route.opts.raw && route.opts.streamBody) {
        unreadStream = true
        ctx.readBody = (limitBytes: number) => {
          if (!unreadStream) return Promise.reject(new Error('readBody called twice'))
          unreadStream = false
          return readBody(req, Math.min(limitBytes, routeLimit))
        }
      } else if (hasBody) {
        if (route.opts.raw) {
          ctx.rawBody = await readBody(req, routeLimit)
        } else {
          const buf = await readBody(req, routeLimit)
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

      // auth (and the environment: the session's access decides which one the request may work in)
      if (route.opts.auth !== 'none') {
        if (!services.ready()) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
        const user = await resolveSession(ctx, { allowNoEnvironment: route.opts.noEnvironment })
        if (!user) throw new HttpError(401, 'unauthenticated', 'Please sign in.')
        ctx.environmentId = user.environmentId
        if (route.opts.auth === 'maker' && !user.privileges.isMaker) throw new HttpError(403, 'denied', 'Only makers can do this.')
        if (user.user.mustChangePassword && !route.opts.allowPendingPasswordChange) {
          throw new HttpError(403, 'password_change_required', 'You must change your password before you can continue.')
        }
        if (route.opts.auth === 'admin' && !user.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only administrators can do this.')
        ctx.user = user
        if (route.opts.design && method !== 'GET' && (await services.environments?.isLocked(ctx.environmentId))) {
          throw new HttpError(403, 'denied', LOCKED_MESSAGE)
        }
      } else if (services.ready() && cookieValue(req, SESSION_COOKIE)) {
        try {
          ctx.user = (await resolveSession(ctx, { allowNoEnvironment: true })) ?? undefined
        } catch {
          ctx.user = undefined
        }
        if (ctx.user) ctx.environmentId = ctx.user.environmentId
      }

      const out = await runInEnvironment(ctx.environmentId, () => route.handler(ctx))
      closeIfUnread()
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
      closeIfUnread()
      sendError(res, e, req)
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
