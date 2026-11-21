/**
 * Outbound HTTP for connector actions: every request (and every redirect hop) passes the connection's host allow-list and
 * the outbound address policy (net-policy.ts), and connects to the address that was checked.
 *
 *  - Schemes: http and https only (no file:, ftp:, data: ...). A redirect from https to http is refused.
 *  - Host allow-list: exact names or `*.example.com` (subdomains only). Required: a connection without one cannot call
 *    anything, so it is never an open proxy.
 *  - Addresses: link-local (cloud metadata), unspecified, multicast and broadcast are always refused, and so are the
 *    metadata host names. Loopback and private networks are refused unless the connection allows them
 *    (`allowPrivateNetwork`, set by an administrator for on-premises APIs); APPBUILDER_OUTBOUND_PRIVATE=deny refuses them
 *    for every connection. A name whose answer contains ANY refused address is refused.
 *  - DNS rebinding: the name is resolved here, the answer is checked and pinned (per connection and host, 60 s), and the
 *    socket connects to that pinned address through a `lookup` hook (no second resolution between check and connect).
 *    TLS still verifies the certificate against the host name (SNI).
 *  - TLS verification is on unless the connection turns it off (administrators; internal self-signed services).
 *  - Limits: total time (one deadline for all hops), response size (decompressed size too), redirects (default 3).
 *  - On a redirect to another host the headers marked sensitive (Authorization, API key headers, Cookie) are dropped.
 */
import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns'
import net from 'node:net'
import zlib from 'node:zlib'
import { classifyAddress, deniedAddressProblem, hostProblem, type AddressClass } from '../net-policy.ts'
import type { ActionErrorCode } from './contracts.ts'

export type LookupFn = (host: string) => Promise<{ address: string; family?: number }[]>

export interface OutboundPolicy {
  /** host names (lowercase) or `*.suffix` */
  allowedHosts: string[]
  /** loopback and private addresses are allowed (ignored when APPBUILDER_OUTBOUND_PRIVATE=deny) */
  allowPrivate: boolean
  maxRedirects: number
  maxResponseBytes: number
  timeoutMs: number
  verifyTls: boolean
  /** tests: a DNS resolver (default dns.promises.lookup with all addresses) */
  lookup?: LookupFn
  /** per connection: host -> pinned address (shared across calls of one connection) */
  pins?: Map<string, { address: string; family: number; until: number }>
  /** header names (lowercase) dropped when a redirect goes to another host */
  sensitiveHeaders?: string[]
  env?: NodeJS.ProcessEnv
  /** extra CA certificates (PEM), e.g. an internal CA */
  ca?: string
}

export interface OutboundRequest {
  method: string
  url: string
  headers?: Record<string, string>
  body?: Buffer | string
}

export interface OutboundResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
  /** the final address after redirects */
  url: string
  redirects: number
}

export class OutboundError extends Error {
  code: ActionErrorCode
  retryable: boolean
  status?: number
  constructor(code: ActionErrorCode, message: string, retryable = false, status?: number) {
    super(message)
    this.code = code
    this.retryable = retryable
    this.status = status
  }
}

const PIN_TTL_MS = 60_000

let testLookup: LookupFn | null = null
/** tests only: a DNS resolver for every connection (DNS rebinding simulations); null restores the real one */
export function setLookupForTests(fn: LookupFn | null): void {
  testLookup = fn
}
const ALWAYS_DENIED: AddressClass[] = ['link-local', 'unspecified', 'multicast', 'broadcast']

/** `api.example.com` matches itself; `*.example.com` matches `a.example.com` and `a.b.example.com`, not `example.com` */
export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
  for (const raw of allowed) {
    const a = raw.trim().toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
    if (!a) continue
    if (a.startsWith('*.')) {
      if (h.endsWith(a.slice(1)) && h.length > a.length - 1) return true
    } else if (h === a) return true
  }
  return false
}

/** an allow-list entry is a host name, an IP address or *.domain (no scheme, path or port) */
export function allowListProblem(entry: string): string | null {
  const e = entry.trim().toLowerCase()
  if (!e) return 'An allowed host is empty.'
  if (e === '*' || e === '*.') return 'An allowed host cannot be "*": list the hosts this connection may call.'
  if (/[/:@\s?#]/.test(e.replace(/^\[.*\]$/, ''))) return `"${entry}" must be a host name only (no scheme, port or path), for example api.example.com or *.example.com.`
  const bare = e.replace(/^\*\./, '')
  if (!net.isIP(bare.replace(/^\[|\]$/g, '')) && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(bare)) return `"${entry}" is not a valid host name.`
  if (e.startsWith('*.') && !bare.includes('.')) return `"${entry}" is too broad: use a domain such as *.example.com.`
  return null
}

function deniedClasses(p: OutboundPolicy): AddressClass[] {
  const env = p.env ?? process.env
  if (env.APPBUILDER_OUTBOUND_PRIVATE === 'deny' || !p.allowPrivate) return [...ALWAYS_DENIED, 'loopback', 'private']
  return ALWAYS_DENIED
}

/** checks the host name and resolves it to one pinned, allowed address */
export async function resolveAllowed(host: string, p: OutboundPolicy): Promise<{ address: string; family: number }> {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase()
  const literal = hostProblem(bare, p.env ?? process.env)
  if (literal) throw new OutboundError('blocked', literal)
  const denied = deniedClasses(p)
  const check = (address: string) => {
    const c = classifyAddress(address)
    if (denied.includes(c)) {
      const why = c === 'loopback' || c === 'private'
        ? `${host} is ${address === bare ? 'a' : `resolved to a`} ${c} address${address === bare ? '' : ` (${address})`}; this connection may not call private networks (an administrator can allow it on the connection).`
        : `${host} ${address === bare ? 'is' : `resolves to`} a ${c} address${address === bare ? '' : ` (${address})`}; Appbuilder does not connect to it.`
      throw new OutboundError('blocked', why)
    }
  }
  // P3-4: APPBUILDER_OUTBOUND_DENY by address too (the install's own public address by its IP or another name)
  const listed = async (addresses: string[]) => {
    const why = await deniedAddressProblem(host, addresses, p.env ?? process.env, p.lookup ?? testLookup ?? undefined)
    if (why) throw new OutboundError('blocked', why)
  }
  if (net.isIP(bare)) {
    check(bare)
    await listed([bare])
    return { address: bare, family: net.isIP(bare) }
  }
  const now = Date.now()
  const pin = p.pins?.get(bare)
  if (pin && pin.until > now) return { address: pin.address, family: pin.family }
  let addrs: { address: string; family?: number }[]
  try {
    addrs = await (p.lookup ?? testLookup ?? ((h: string) => dns.promises.lookup(h, { all: true, verbatim: true })))(bare)
  } catch {
    throw new OutboundError('network', `The host name ${host} could not be resolved.`, true)
  }
  if (!addrs.length) throw new OutboundError('network', `The host name ${host} could not be resolved.`, true)
  for (const a of addrs) check(a.address)
  await listed(addrs.map((a) => a.address))
  const chosen = { address: addrs[0].address, family: addrs[0].family ?? net.isIP(addrs[0].address) }
  if (p.pins) {
    if (p.pins.size > 200) p.pins.clear()
    p.pins.set(bare, { ...chosen, until: now + PIN_TTL_MS })
  }
  return chosen
}

const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|SSL|ALTNAME/i

function mapError(e: unknown, host: string): OutboundError {
  if (e instanceof OutboundError) return e
  const code = String((e as { code?: unknown })?.code ?? '')
  const msg = e instanceof Error ? e.message : String(e)
  if (TLS_CODES.test(code) || TLS_CODES.test(msg)) return new OutboundError('network', `The TLS certificate of ${host} could not be verified (${code || 'TLS error'}).`, false)
  if (code === 'ECONNREFUSED') return new OutboundError('network', `${host} refused the connection.`, true)
  if (code === 'ECONNRESET' || code === 'EPIPE') return new OutboundError('network', `The connection to ${host} was reset.`, true)
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new OutboundError('network', `${host} cannot be reached.`, true)
  return new OutboundError('network', `The request to ${host} failed (${code || 'network error'}).`, true)
}

function headerRecord(h: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v)
  return out
}

function decode(body: Buffer, encoding: string | undefined, max: number): Buffer {
  const enc = (encoding ?? '').trim().toLowerCase()
  if (!enc || enc === 'identity') return body
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(body, { maxOutputLength: max })
    if (enc === 'deflate') return zlib.inflateSync(body, { maxOutputLength: max })
    if (enc === 'br') return zlib.brotliDecompressSync(body, { maxOutputLength: max })
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|too large/i.test(String((e as Error).message))) {
      throw new OutboundError('too_large', `The response is larger than ${Math.round(max / 1024)} KB once unpacked.`)
    }
    throw new OutboundError('upstream', 'The response could not be unpacked.')
  }
  throw new OutboundError('upstream', `The response uses an unsupported encoding (${enc}).`)
}

function once(req: OutboundRequest, url: URL, pinned: { address: string; family: number }, p: OutboundPolicy, deadline: number, signal?: AbortSignal): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http
    const remaining = deadline - Date.now()
    if (remaining <= 0) return reject(new OutboundError('timeout', `No answer from ${url.hostname} in time.`, true))
    const headers: Record<string, string> = { 'accept-encoding': 'identity', 'user-agent': 'Appbuilder', ...Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])) }
    const body = req.body === undefined ? undefined : Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body, 'utf8')
    if (body) headers['content-length'] = String(body.length)
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    const r = mod.request({
      protocol: url.protocol,
      host: hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: req.method,
      headers,
      agent: false,
      // the pinned address; no second DNS answer between the check and the connect
      lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => {
        if (o && o.all) cb(null, [{ address: pinned.address, family: pinned.family }])
        else cb(null, pinned.address, pinned.family)
      }) as unknown as typeof dns.lookup,
      ...(url.protocol === 'https:' ? { servername: net.isIP(hostname) ? undefined : hostname, rejectUnauthorized: p.verifyTls, minVersion: 'TLSv1.2' as const, ...(p.ca ? { ca: p.ca } : {}) } : {}),
    })
    let settled = false
    const fail = (e: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      r.destroy()
      reject(e instanceof OutboundError ? e : mapError(e, url.hostname))
    }
    const timer = setTimeout(() => fail(new OutboundError('timeout', `No answer from ${url.hostname} in time.`, true)), remaining)
    const onAbort = () => fail(new OutboundError('timeout', 'The call was cancelled.', true))
    signal?.addEventListener('abort', onAbort, { once: true })
    r.on('error', fail)
    r.on('response', (res) => {
      const declared = Number(res.headers['content-length'])
      if (Number.isFinite(declared) && declared > p.maxResponseBytes) {
        res.destroy()
        return fail(new OutboundError('too_large', `The response is larger than ${Math.round(p.maxResponseBytes / 1024)} KB.`))
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > p.maxResponseBytes) {
          res.destroy()
          fail(new OutboundError('too_large', `The response is larger than ${Math.round(p.maxResponseBytes / 1024)} KB.`))
          return
        }
        chunks.push(c)
      })
      res.on('error', fail)
      res.on('end', () => {
        if (settled) return
        try {
          const hdrs = headerRecord(res.headers)
          const raw = Buffer.concat(chunks)
          const decoded = decode(raw, hdrs['content-encoding'], p.maxResponseBytes)
          settled = true
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          resolve({ status: res.statusCode ?? 0, headers: hdrs, body: decoded })
        } catch (e) {
          fail(e)
        }
      })
    })
    if (body) r.end(body)
    else r.end()
  })
}

/** one call with redirects, under the policy */
export async function safeRequest(req: OutboundRequest, p: OutboundPolicy, signal?: AbortSignal): Promise<OutboundResponse> {
  const deadline = Date.now() + p.timeoutMs
  let url: URL
  try {
    url = new URL(req.url)
  } catch {
    throw new OutboundError('invalid_input', 'The address is not a valid URL.')
  }
  let current: OutboundRequest = { ...req, headers: { ...(req.headers ?? {}) } }
  const sensitive = new Set(['authorization', 'cookie', 'proxy-authorization', ...(p.sensitiveHeaders ?? []).map((h) => h.toLowerCase())])
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new OutboundError('blocked', `Only http and https addresses can be called (not ${url.protocol.replace(':', '')}).`)
    if (url.username || url.password) throw new OutboundError('blocked', 'Addresses with a user name or password in them are not allowed; use the connection\'s authentication.')
    if (!hostAllowed(url.hostname, p.allowedHosts)) {
      throw new OutboundError('blocked', hop ? `The server redirected to ${url.hostname}, which is not on this connection's list of allowed hosts.` : `${url.hostname} is not on this connection's list of allowed hosts.`)
    }
    const pinned = await resolveAllowed(url.hostname, p)
    const res = await once(current, url, pinned, p, deadline, signal)
    const loc = res.headers.location
    if ([301, 302, 303, 307, 308].includes(res.status) && loc) {
      if (hop >= p.maxRedirects) throw new OutboundError('blocked', `Too many redirects (at most ${p.maxRedirects}).`)
      let next: URL
      try {
        next = new URL(loc, url)
      } catch {
        throw new OutboundError('upstream', 'The server sent an invalid redirect.')
      }
      if (url.protocol === 'https:' && next.protocol === 'http:') throw new OutboundError('blocked', 'The server redirected from https to http; the redirect was not followed.')
      const headers = { ...(current.headers ?? {}) }
      if (next.host.toLowerCase() !== url.host.toLowerCase()) for (const k of Object.keys(headers)) if (sensitive.has(k.toLowerCase())) delete headers[k]
      let method = current.method
      let body = current.body
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET'
        body = undefined
        for (const k of Object.keys(headers)) if (/^content-(type|length)$/i.test(k)) delete headers[k]
      }
      current = { method, url: next.toString(), headers, body }
      url = next
      continue
    }
    return { status: res.status, headers: res.headers, body: res.body, url: url.toString(), redirects: hop }
  }
}
