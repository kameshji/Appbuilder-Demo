/**
 * The HTTP connector (kind `http`): generic REST calls through the outbound policy (outbound.ts), with the built-in
 * action `request` and custom actions a maker defines (form or OpenAPI import: openapi.ts).
 *
 * Settings (non-secret, ab_connections.settings): baseUrl, allowedHosts (comma-separated; default: the host of baseUrl),
 * authMode (none | apiKey | basic | bearer | oauth2cc), apiKeyIn (header | query), apiKeyName, username, tokenUrl,
 * clientId, scope, audience, clientAuth (body | basic), defaultHeaders (JSON object), allowPrivateNetwork, verifyTls,
 * maxRedirects, timeoutMs, maxResponseKB, perMinute, maxConcurrent.
 * Secret (sealed, one JSON object): { apiKey?, password?, token?, clientSecret?, headers?: { name: value } }.
 *
 * OAuth 2.0: client credentials only (token cached per connection until 30 s before it expires; a 401 from the API
 * fetches a new token once). Authorization code with user consent is not supported in this version.
 */
import type { ConnectionRecord } from '../contracts.ts'
import type { ActionDef, JsonSchema } from './contracts.ts'
import type { ActionProvider, ProviderCall } from './service.ts'
import { OutboundError, allowListProblem, hostAllowed, safeRequest, type OutboundPolicy, type OutboundResponse } from './outbound.ts'
import { TemplateError, lookupPath, renderJson, renderPath, renderText } from './template.ts'
import { checkSchema } from './schema.ts'
import { REQUEST_ACTION } from './builtin-defs.ts'
export { REQUEST_ACTION }

export type AuthMode = 'none' | 'apiKey' | 'basic' | 'bearer' | 'oauth2cc'
export const AUTH_MODES: AuthMode[] = ['none', 'apiKey', 'basic', 'bearer', 'oauth2cc']
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const
type Method = (typeof METHODS)[number]
/** request headers an action may not set (the client sets them, or they change the connection) */
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'te', 'upgrade', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'trailer', 'expect'])
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/
/** response headers that are not returned (cookies may be session secrets) */
const HIDDEN_RESPONSE_HEADERS = new Set(['set-cookie', 'set-cookie2', 'www-authenticate', 'proxy-authenticate'])

export interface HttpSecret { apiKey?: string; password?: string; token?: string; clientSecret?: string; headers?: Record<string, string> }

/** custom actions: how inputs become a request */
export interface HttpActionSpec {
  method: Method
  /** relative to the base URL, `{{input}}` placeholders (encoded as one path segment each) */
  path: string
  /** inputs sent as query parameters or headers (left out when the input is missing) */
  params?: { name: string; in: 'query' | 'header'; input: string }[]
  /** fixed or templated query values and headers */
  query?: Record<string, string>
  headers?: Record<string, string>
  /** inputs sent as top-level fields of a JSON body */
  bodyFields?: string[]
  /** the input whose value is the whole JSON body (OpenAPI request bodies) */
  bodyInput?: string
  /** a JSON body template (`{{input}}` placeholders) */
  bodyTemplate?: unknown
  /** accepted statuses (default: any 2xx) */
  expectStatus?: number[]
  /** return this part of the response body (dotted path, e.g. data.items) instead of the whole answer */
  outputPath?: string
  /** a sample response (documentation; the output schema is inferred from it) */
  sample?: unknown
}

export type CustomHttpAction = ActionDef & { http: HttpActionSpec }

/* ------------------------------------------------------------------ settings */

const num = (v: string | undefined, def: number, min: number, max: number): number => {
  const n = Number(v)
  return Number.isFinite(n) && v !== undefined && v !== '' ? Math.max(min, Math.min(max, Math.round(n))) : def
}

export function parseSecret(c: Pick<ConnectionRecord, 'secret'>): HttpSecret {
  if (!c.secret) return {}
  try {
    const v = JSON.parse(c.secret) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as HttpSecret) : {}
  } catch {
    return {}
  }
}

export function allowedHostsOf(settings: Record<string, string>): string[] {
  const list = (settings.allowedHosts ?? '').split(/[,\s]+/).map((h) => h.trim().toLowerCase()).filter(Boolean)
  if (list.length) return list
  try {
    return [new URL(settings.baseUrl).hostname.toLowerCase()]
  } catch {
    return []
  }
}

function defaultHeaders(settings: Record<string, string>): Record<string, string> {
  if (!settings.defaultHeaders) return {}
  try {
    const v = JSON.parse(settings.defaultHeaders) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, x] of Object.entries(v ?? {})) if (typeof x === 'string') out[k] = x
    return out
  } catch {
    return {}
  }
}

export function policyOf(c: ConnectionRecord, cache: Map<string, unknown>, extra: Partial<OutboundPolicy> = {}): OutboundPolicy {
  const st = c.settings ?? {}
  let pins = cache.get('pins') as OutboundPolicy['pins']
  if (!pins) cache.set('pins', (pins = new Map()))
  const sec = parseSecret(c)
  const sensitive = Object.keys(sec.headers ?? {}).map((h) => h.toLowerCase())
  if (st.authMode === 'apiKey' && (st.apiKeyIn ?? 'header') === 'header' && st.apiKeyName) sensitive.push(st.apiKeyName.toLowerCase())
  return {
    allowedHosts: allowedHostsOf(st),
    allowPrivate: st.allowPrivateNetwork === 'true',
    maxRedirects: num(st.maxRedirects, 3, 0, 10),
    maxResponseBytes: num(st.maxResponseKB, 5120, 1, 20480) * 1024,
    timeoutMs: num(st.timeoutMs, 30_000, 1000, 120_000),
    verifyTls: st.verifyTls !== 'false',
    pins,
    sensitiveHeaders: sensitive,
    lookup: (cache.get('lookup') as OutboundPolicy['lookup']) ?? undefined,
    ...extra,
  }
}

export function checkHttpSettings(st: Record<string, string>, secret: string | undefined): string[] {
  const out: string[] = []
  let base: URL | null = null
  try {
    base = new URL(st.baseUrl ?? '')
    if (base.protocol !== 'https:' && base.protocol !== 'http:') out.push('The base URL must start with https:// or http://.')
    if (base.username || base.password) out.push('Put credentials in the authentication fields, not in the base URL.')
    if (base.search || base.hash) out.push('The base URL must not contain a query string or fragment.')
  } catch {
    out.push('The base URL is required, for example https://api.example.com/v1.')
  }
  const hosts = allowedHostsOf(st)
  if (!hosts.length) out.push('List at least one allowed host.')
  for (const h of hosts) {
    const p = allowListProblem(h)
    if (p) out.push(p)
  }
  if (base && hosts.length && !hostAllowed(base.hostname, hosts)) out.push(`The host of the base URL (${base.hostname}) must be on the list of allowed hosts.`)
  const mode = (st.authMode || 'none') as AuthMode
  if (!AUTH_MODES.includes(mode)) out.push('Unknown authentication mode.')
  const sec = parseSecret({ secret })
  if (secret) {
    try {
      const v = JSON.parse(secret)
      if (!v || typeof v !== 'object' || Array.isArray(v)) out.push('The secret must be a JSON object.')
    } catch {
      out.push('The secret must be a JSON object.')
    }
  }
  if (mode === 'apiKey') {
    if (!st.apiKeyName || !HEADER_NAME.test(st.apiKeyName)) out.push('Enter the name of the API key header or query parameter.')
    if (st.apiKeyIn && !['header', 'query'].includes(st.apiKeyIn)) out.push('The API key goes in a header or the query string.')
  }
  if (mode === 'basic' && !st.username) out.push('Enter the user name for basic authentication.')
  if (mode === 'oauth2cc') {
    if (!st.clientId) out.push('Enter the OAuth client id.')
    try {
      const t = new URL(st.tokenUrl ?? '')
      if (t.protocol !== 'https:' && !(t.protocol === 'http:' && st.allowPrivateNetwork === 'true')) out.push('The token URL must use https.')
      if (!hostAllowed(t.hostname, hosts)) out.push(`The host of the token URL (${t.hostname}) must be on the list of allowed hosts.`)
    } catch {
      out.push('Enter the token URL of the OAuth server.')
    }
    if (st.clientAuth && !['body', 'basic'].includes(st.clientAuth)) out.push('The client is authenticated in the body or with basic authentication.')
  }
  if (st.defaultHeaders) {
    try {
      const v = JSON.parse(st.defaultHeaders)
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('x')
      for (const [k, x] of Object.entries(v)) {
        if (!HEADER_NAME.test(k) || FORBIDDEN_HEADERS.has(k.toLowerCase()) || typeof x !== 'string' || /[\r\n]/.test(x)) out.push(`Default header "${k}" is not allowed.`)
      }
    } catch {
      out.push('Default headers must be a JSON object of names and texts, for example {"Accept": "application/json"}.')
    }
  }
  for (const [k, x] of Object.entries(sec.headers ?? {})) {
    if (!HEADER_NAME.test(k) || FORBIDDEN_HEADERS.has(k.toLowerCase()) || typeof x !== 'string' || /[\r\n]/.test(x)) out.push(`Secret header "${k}" is not allowed.`)
  }
  for (const k of ['verifyTls', 'allowPrivateNetwork']) if (st[k] && !['true', 'false'].includes(st[k])) out.push(`${k} must be true or false.`)
  return out
}

/* ------------------------------------------------------------------ authentication */

interface CachedToken { token: string; expiresAt: number; type: string }

async function oauthToken(call: { connection: ConnectionRecord; cache: Map<string, unknown>; signal?: AbortSignal }, force = false): Promise<CachedToken> {
  const st = call.connection.settings ?? {}
  const sec = parseSecret(call.connection)
  const cached = call.cache.get('oauth') as CachedToken | undefined
  if (!force && cached && cached.expiresAt > Date.now() + 30_000) return cached
  // one token request at a time per connection
  const pending = call.cache.get('oauthPending') as Promise<CachedToken> | undefined
  if (pending && !force) return pending
  const p = (async () => {
    const form = new URLSearchParams({ grant_type: 'client_credentials' })
    if (st.scope) form.set('scope', st.scope)
    if (st.audience) form.set('audience', st.audience)
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
    if (st.clientAuth === 'basic') headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(st.clientId ?? '')}:${encodeURIComponent(sec.clientSecret ?? '')}`).toString('base64')}`
    else {
      form.set('client_id', st.clientId ?? '')
      form.set('client_secret', sec.clientSecret ?? '')
    }
    const res = await safeRequest({ method: 'POST', url: st.tokenUrl ?? '', headers, body: form.toString() }, policyOf(call.connection, call.cache, { maxRedirects: 0, timeoutMs: 15_000 }), call.signal)
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(res.body.toString('utf8'))
    } catch {
      /* below */
    }
    if (res.status < 200 || res.status >= 300 || typeof body.access_token !== 'string') {
      const why = typeof body.error === 'string' ? ` (${body.error.slice(0, 80)})` : ''
      throw new OutboundError(res.status >= 500 ? 'upstream' : 'not_configured', `The OAuth server did not issue a token: HTTP ${res.status}${why}.`, res.status >= 500, res.status)
    }
    const expiresIn = Number(body.expires_in)
    const tok: CachedToken = { token: body.access_token, type: typeof body.token_type === 'string' && /^bearer$/i.test(body.token_type) ? 'Bearer' : 'Bearer', expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3600_000) }
    call.cache.set('oauth', tok)
    return tok
  })()
  call.cache.set('oauthPending', p)
  try {
    return await p
  } finally {
    call.cache.delete('oauthPending')
  }
}

async function applyAuth(call: { connection: ConnectionRecord; cache: Map<string, unknown>; signal?: AbortSignal }, url: URL, headers: Record<string, string>, forceToken = false): Promise<void> {
  const st = call.connection.settings ?? {}
  const sec = parseSecret(call.connection)
  for (const [k, v] of Object.entries(sec.headers ?? {})) headers[k.toLowerCase()] = v
  switch ((st.authMode || 'none') as AuthMode) {
    case 'apiKey':
      if (!sec.apiKey) throw new OutboundError('not_configured', 'The API key of this connection is not set.')
      if ((st.apiKeyIn ?? 'header') === 'query') url.searchParams.set(st.apiKeyName ?? 'api_key', sec.apiKey)
      else headers[(st.apiKeyName ?? 'X-API-Key').toLowerCase()] = sec.apiKey
      break
    case 'basic':
      headers.authorization = `Basic ${Buffer.from(`${st.username ?? ''}:${sec.password ?? ''}`, 'utf8').toString('base64')}`
      break
    case 'bearer':
      if (!sec.token) throw new OutboundError('not_configured', 'The bearer token of this connection is not set.')
      headers.authorization = `Bearer ${sec.token}`
      break
    case 'oauth2cc': {
      const t = await oauthToken(call, forceToken)
      headers.authorization = `${t.type} ${t.token}`
      break
    }
    default:
      break
  }
}

/* ------------------------------------------------------------------ the request */

export interface PreparedRequest {
  method: Method
  url: URL
  headers: Record<string, string>
  body?: Buffer
}

function resolveUrl(c: ConnectionRecord, pathOrUrl: string): URL {
  const st = c.settings ?? {}
  if (/^[a-z][a-z0-9+.-]*:/i.test(pathOrUrl)) {
    try {
      return new URL(pathOrUrl)
    } catch {
      throw new OutboundError('invalid_input', 'The address is not a valid URL.')
    }
  }
  if (pathOrUrl.startsWith('//')) throw new OutboundError('invalid_input', 'A path must start with a single "/".')
  const base = new URL(st.baseUrl ?? '')
  const basePath = base.pathname.replace(/\/+$/, '')
  const rel = pathOrUrl ? (pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`) : ''
  const [p, qs] = rel.split('?', 2)
  const u = new URL(base.origin + basePath + (p ?? ''))
  if (qs) for (const [k, v] of new URLSearchParams(qs)) u.searchParams.append(k, v)
  // "/a/../../x" must not climb above the base path
  if (basePath && !u.pathname.startsWith(basePath)) throw new OutboundError('invalid_input', 'The path leaves the base URL of the connection.')
  return u
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  if (!HEADER_NAME.test(name)) throw new OutboundError('invalid_input', `"${name}" is not a valid header name.`)
  if (FORBIDDEN_HEADERS.has(name.toLowerCase())) throw new OutboundError('invalid_input', `The header "${name}" cannot be set.`)
  if (/[\r\n\0]/.test(value)) throw new OutboundError('invalid_input', `The header "${name}" must not contain line breaks.`)
  headers[name.toLowerCase()] = value
}

const scalar = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v))

/** the built-in `request` action's inputs -> a request */
export function prepareGeneric(c: ConnectionRecord, inputs: Record<string, unknown>): PreparedRequest {
  const method = String(inputs.method ?? 'GET').toUpperCase() as Method
  if (!METHODS.includes(method)) throw new OutboundError('invalid_input', `Unknown method ${method}.`)
  let path: string
  try {
    path = renderPath(String(inputs.path ?? ''), inputs.pathParams ?? {})
  } catch (e) {
    throw new OutboundError('invalid_input', (e as Error).message)
  }
  const url = resolveUrl(c, path)
  for (const [k, v] of Object.entries((inputs.query as Record<string, unknown>) ?? {})) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, scalar(x))
    else url.searchParams.set(k, scalar(v))
  }
  const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.9, */*;q=0.5' }
  for (const [k, v] of Object.entries(defaultHeaders(c.settings ?? {}))) setHeader(headers, k, v)
  for (const [k, v] of Object.entries((inputs.headers as Record<string, unknown>) ?? {})) if (v !== undefined && v !== null) setHeader(headers, k, scalar(v))
  let body: Buffer | undefined
  const kind = String(inputs.bodyType ?? (inputs.body === undefined ? 'none' : typeof inputs.body === 'string' ? 'text' : 'json'))
  if (inputs.body !== undefined && kind !== 'none') {
    if (method === 'GET' || method === 'HEAD') throw new OutboundError('invalid_input', `A ${method} request has no body.`)
    if (kind === 'json') {
      body = Buffer.from(JSON.stringify(inputs.body), 'utf8')
      headers['content-type'] ??= 'application/json'
    } else if (kind === 'form') {
      const f = new URLSearchParams()
      for (const [k, v] of Object.entries((inputs.body as Record<string, unknown>) ?? {})) if (v !== undefined && v !== null) f.append(k, scalar(v))
      body = Buffer.from(f.toString(), 'utf8')
      headers['content-type'] = 'application/x-www-form-urlencoded'
    } else {
      body = Buffer.from(scalar(inputs.body), 'utf8')
      headers['content-type'] ??= 'text/plain; charset=utf-8'
    }
  }
  return { method, url, headers, body }
}

/** a custom action's spec + inputs -> a request */
export function prepareCustom(c: ConnectionRecord, spec: HttpActionSpec, inputs: Record<string, unknown>): PreparedRequest {
  try {
    const url = resolveUrl(c, renderPath(spec.path, inputs))
    const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.9, */*;q=0.5' }
    for (const [k, v] of Object.entries(defaultHeaders(c.settings ?? {}))) setHeader(headers, k, v)
    for (const [k, t] of Object.entries(spec.query ?? {})) url.searchParams.set(k, renderText(t, inputs, `Query parameter ${k}`))
    for (const [k, t] of Object.entries(spec.headers ?? {})) setHeader(headers, k, renderText(t, inputs, `Header ${k}`, { header: true }))
    for (const p of spec.params ?? []) {
      const v = lookupPath(inputs, p.input)
      if (v === undefined || v === null) continue
      if (p.in === 'query') {
        if (Array.isArray(v)) for (const x of v) url.searchParams.append(p.name, scalar(x))
        else url.searchParams.set(p.name, scalar(v))
      } else setHeader(headers, p.name, scalar(v))
    }
    let body: Buffer | undefined
    let json: unknown
    if (spec.bodyTemplate !== undefined) json = renderJson(spec.bodyTemplate, inputs)
    else if (spec.bodyInput) json = lookupPath(inputs, spec.bodyInput)
    else if (spec.bodyFields?.length) {
      const o: Record<string, unknown> = {}
      for (const f of spec.bodyFields) {
        const v = lookupPath(inputs, f)
        if (v !== undefined) o[f] = v
      }
      json = o
    }
    if (json !== undefined) {
      body = Buffer.from(JSON.stringify(json), 'utf8')
      headers['content-type'] = 'application/json'
    }
    return { method: spec.method, url, headers, body }
  } catch (e) {
    if (e instanceof TemplateError) throw new OutboundError('invalid_input', e.message)
    throw e
  }
}

export interface HttpOutput { status: number; headers: Record<string, string>; body: unknown; bodyEncoding?: 'base64'; url: string }

export function toOutput(res: OutboundResponse): HttpOutput {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(res.headers)) if (!HIDDEN_RESPONSE_HEADERS.has(k)) headers[k] = v
  const type = (res.headers['content-type'] ?? '').toLowerCase()
  let body: unknown = null
  let bodyEncoding: 'base64' | undefined
  if (res.body.length) {
    if (/json/.test(type)) {
      try {
        body = JSON.parse(res.body.toString('utf8'))
      } catch {
        body = res.body.toString('utf8')
      }
    } else if (!type || /^text\/|xml|javascript|x-www-form-urlencoded|csv/.test(type)) body = res.body.toString('utf8')
    else {
      body = res.body.toString('base64')
      bodyEncoding = 'base64'
    }
  }
  const u = new URL(res.url)
  for (const k of [...u.searchParams.keys()]) if (/key|token|secret|sig|password/i.test(k)) u.searchParams.set(k, '[hidden]')
  return { status: res.status, headers, body, ...(bodyEncoding ? { bodyEncoding } : {}), url: u.toString() }
}

const statusOk = (status: number, expect?: number[]) => (expect?.length ? expect.includes(status) : status >= 200 && status < 300)

/** executes a prepared request with the connection's auth; a 401 with OAuth fetches a new token once */
export async function execute(call: Pick<ProviderCall, 'connection' | 'cache' | 'signal' | 'note' | 'timeoutMs'>, req: PreparedRequest, expect?: number[]): Promise<HttpOutput> {
  const policy = policyOf(call.connection, call.cache, { timeoutMs: Math.min(call.timeoutMs, policyOf(call.connection, call.cache).timeoutMs) })
  const attempt = async (force: boolean) => {
    const url = new URL(req.url.toString())
    const headers = { ...req.headers }
    await applyAuth(call, url, headers, force)
    return safeRequest({ method: req.method, url: url.toString(), headers, body: req.body }, policy, call.signal)
  }
  call.note({ method: req.method, host: req.url.hostname, path: req.url.pathname.slice(0, 300) })
  let res = await attempt(false)
  if (res.status === 401 && call.connection.settings?.authMode === 'oauth2cc') res = await attempt(true)
  call.note({ httpStatus: res.status, ...(res.redirects ? { redirects: res.redirects } : {}) })
  const out = toOutput(res)
  if (!statusOk(res.status, expect)) {
    const retryable = res.status === 429 || res.status === 408 || res.status >= 500
    const snippet = typeof out.body === 'string' ? out.body.slice(0, 200) : out.body && typeof out.body === 'object' ? JSON.stringify(out.body).slice(0, 200) : ''
    throw new OutboundError(res.status === 429 ? 'rate_limited' : 'upstream', `${req.url.hostname} answered HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`, retryable, res.status)
  }
  return out
}

/* ------------------------------------------------------------------ actions */

export function checkCustomAction(a: unknown): { def: CustomHttpAction; problems: string[] } {
  const problems: string[] = []
  const o = (a && typeof a === 'object' && !Array.isArray(a) ? a : {}) as Record<string, unknown>
  const h = (o.http && typeof o.http === 'object' ? o.http : {}) as Record<string, unknown>
  const id = String(o.id ?? '').trim()
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)) problems.push('The action id starts with a letter and has letters, digits, _ and - only (at most 64).')
  if (id.toLowerCase() === 'request') problems.push('"request" is the built-in action; choose another id.')
  const method = String(h.method ?? 'GET').toUpperCase() as Method
  if (!METHODS.includes(method)) problems.push('Choose a method: GET, POST, PUT, PATCH, DELETE or HEAD.')
  const path = String(h.path ?? '').trim().replace(/^\/{2,}/, '/')
  if (path.length > 1000 || (path && !path.startsWith('/'))) problems.push('The path starts with "/" (relative to the base URL of the connection).')
  const inputs = (o.inputs && typeof o.inputs === 'object' ? o.inputs : { type: 'object', properties: {} }) as JsonSchema
  problems.push(...checkSchema(inputs, 'inputs'))
  const outputs = (o.outputs && typeof o.outputs === 'object' ? o.outputs : {}) as JsonSchema
  problems.push(...checkSchema(outputs, 'outputs'))
  const names = new Set(Object.keys(inputs.properties ?? {}))
  for (const m of path.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)/g)) if (!names.has(m[1])) problems.push(`The path uses {{${m[1]}}}, which is not an input.`)
  const params = Array.isArray(h.params) ? (h.params as HttpActionSpec['params'])! : []
  for (const p of params) {
    if (!p || typeof p.name !== 'string' || !HEADER_NAME.test(p.name) || !['query', 'header'].includes(p.in) || typeof p.input !== 'string') problems.push('A parameter needs a name, a place (query or header) and the input it takes.')
    else if (p.in === 'header' && FORBIDDEN_HEADERS.has(p.name.toLowerCase())) problems.push(`The header "${p.name}" cannot be set.`)
  }
  const strMap = (v: unknown, what: string): Record<string, string> | undefined => {
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'object' || Array.isArray(v)) { problems.push(`${what} must be names and texts.`); return undefined }
    const out: Record<string, string> = {}
    for (const [k, x] of Object.entries(v)) {
      if (typeof x !== 'string') problems.push(`${what} "${k}" must be text.`)
      else out[k] = x
    }
    return out
  }
  const headers = strMap(h.headers, 'Headers')
  for (const k of Object.keys(headers ?? {})) if (!HEADER_NAME.test(k) || FORBIDDEN_HEADERS.has(k.toLowerCase())) problems.push(`The header "${k}" cannot be set.`)
  const expect = Array.isArray(h.expectStatus) ? (h.expectStatus as unknown[]).map(Number) : undefined
  if (expect && expect.some((s) => !Number.isInteger(s) || s < 100 || s > 599)) problems.push('Expected statuses are numbers between 100 and 599.')
  const timeout = o.timeoutMs === undefined ? 30_000 : Number(o.timeoutMs)
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120_000) problems.push('The time limit is between 1,000 and 120,000 ms.')
  const spec: HttpActionSpec = {
    method, path: path || '/',
    ...(params.length ? { params } : {}),
    ...(strMap(h.query, 'Query') ? { query: strMap(h.query, 'Query') } : {}),
    ...(headers ? { headers } : {}),
    ...(Array.isArray(h.bodyFields) ? { bodyFields: (h.bodyFields as unknown[]).map(String) } : {}),
    ...(typeof h.bodyInput === 'string' && h.bodyInput ? { bodyInput: h.bodyInput } : {}),
    ...(h.bodyTemplate !== undefined ? { bodyTemplate: h.bodyTemplate } : {}),
    ...(expect?.length ? { expectStatus: expect } : {}),
    ...(typeof h.outputPath === 'string' && h.outputPath ? { outputPath: h.outputPath } : {}),
    ...(h.sample !== undefined ? { sample: h.sample } : {}),
  }
  if (spec.sample !== undefined && JSON.stringify(spec.sample).length > 64 * 1024) problems.push('The sample response is too large (at most 64 KB).')
  const readOnly = method === 'GET' || method === 'HEAD'
  const def: CustomHttpAction = {
    id, title: String(o.title ?? id).trim().slice(0, 200) || id, description: String(o.description ?? '').slice(0, 2000),
    inputs: { type: 'object', ...inputs }, outputs,
    idempotent: o.idempotent === undefined ? readOnly || method === 'PUT' || method === 'DELETE' : o.idempotent === true,
    sideEffect: o.sideEffect === 'none' || o.sideEffect === 'external' ? o.sideEffect : readOnly ? 'none' : 'external',
    timeoutMs: Number.isInteger(timeout) ? timeout : 30_000, origin: 'custom', http: spec,
  }
  return { def, problems }
}

export function createHttpProvider(): ActionProvider {
  return {
    kind: 'http',
    label: 'HTTP (REST API)',
    description: 'Calls a web API: generic requests, and actions you define by hand or import from an OpenAPI document.',
    tables: false,
    builtin: () => [REQUEST_ACTION],
    checkSettings: checkHttpSettings,
    secrets(c) {
      const s = parseSecret(c)
      const st = c.settings ?? {}
      const list = [s.apiKey, s.password, s.token, s.clientSecret, ...Object.values(s.headers ?? {})].filter((x): x is string => typeof x === 'string' && x.length > 0)
      if (st.authMode === 'basic' && s.password) list.push(Buffer.from(`${st.username ?? ''}:${s.password}`, 'utf8').toString('base64'))
      return list
    },
    limits(c) {
      const st = c.settings ?? {}
      return { perMinute: num(st.perMinute, 60, 1, 6000), maxConcurrent: num(st.maxConcurrent, 4, 1, 32), maxTimeoutMs: num(st.timeoutMs, 30_000, 1000, 120_000) }
    },
    async test({ connection, cache }) {
      const problems = checkHttpSettings(connection.settings ?? {}, connection.secret)
      if (problems.length) return { ok: false, message: problems.join(' ') }
      const st = connection.settings ?? {}
      try {
        if (st.authMode === 'oauth2cc') await oauthToken({ connection, cache }, true)
        const req = prepareGeneric(connection, { method: 'GET', path: '' })
        const res = await execute({ connection, cache, signal: new AbortController().signal, note: () => {}, timeoutMs: 15_000 }, req, Array.from({ length: 500 }, (_, i) => i + 100))
        if (res.status === 401 || res.status === 403) return { ok: false, message: `${req.url.hostname} answered HTTP ${res.status}: check the authentication settings.` }
        return { ok: true, message: `${req.url.hostname} answered HTTP ${res.status}${st.authMode === 'oauth2cc' ? '; an OAuth token was issued' : ''}.` }
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : 'The test failed.' }
      }
    },
    async invoke(call) {
      const a = call.action as CustomHttpAction
      if (a.id === 'request' && a.origin !== 'custom') {
        const req = prepareGeneric(call.connection, call.inputs)
        if (call.idempotencyKey && !req.headers['idempotency-key']) req.headers['idempotency-key'] = call.idempotencyKey.slice(0, 200)
        return execute(call, req, call.inputs.expectStatus as number[] | undefined)
      }
      const req = prepareCustom(call.connection, a.http, call.inputs)
      if (call.idempotencyKey && !a.idempotent && !req.headers['idempotency-key']) req.headers['idempotency-key'] = call.idempotencyKey.slice(0, 200)
      const out = await execute(call, req, a.http.expectStatus)
      if (a.http.outputPath) return lookupPath(out.body, a.http.outputPath) ?? null
      return out.body
    },
  }
}
