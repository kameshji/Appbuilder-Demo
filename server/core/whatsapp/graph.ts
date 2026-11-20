/**
 * The client of Meta's WhatsApp Business Cloud API (Graph API). Every request goes through the connector actions'
 * outbound client (actions/outbound.ts: pinned DNS answers, address policy, size and time limits, TLS 1.2+ verified).
 *
 * The base address is FIXED: https://graph.facebook.com, allow-list exactly that host, private networks refused. It is not a
 * setting: no maker or administrator can point a WhatsApp connection anywhere else (so it cannot become a tool to reach
 * internal addresses). Tests replace it in-process with setGraphBaseForTests() (the same kind of injection as
 * setLookupForTests in outbound.ts); nothing reads it from settings, the environment or a request.
 *
 * Errors from Meta (`{ error: { message, type, code, error_subcode, error_data, fbtrace_id } }`) become plain-English
 * OutboundErrors (mapGraphError). Meta's own message text is not passed on verbatim (it can quote request values); the
 * access token is never in a message (the actions framework also redacts every secret of the connection).
 */
import type { ConnectionRecord } from '../contracts.ts'
import { OutboundError, hostAllowed, safeRequest, type OutboundPolicy } from '../actions/outbound.ts'

export const GRAPH_HOST = 'graph.facebook.com'
export const GRAPH_BASE = `https://${GRAPH_HOST}`
export const DEFAULT_API_VERSION = 'v21.0'
export const API_VERSION = /^v\d{1,2}\.\d{1,2}$/

let baseForTests: string | null = null
/** tests only: the address of a fake Graph API (http://127.0.0.1:<port>); null restores Meta's */
export function setGraphBaseForTests(url: string | null): void {
  baseForTests = url ? url.replace(/\/+$/, '') : null
}
export const graphBase = (): string => baseForTests ?? GRAPH_BASE

/**
 * Hosts reserved for the WhatsApp connector: the generic HTTP connector refuses them (http.ts policyOf), so the opt-in
 * check of the send path cannot be bypassed by calling Meta's API through an HTTP connection.
 */
export function isReservedGraphHost(entry: string): boolean {
  const e = entry.trim().toLowerCase().replace(/\.$/, '')
  if (!e) return false
  if (hostAllowed(GRAPH_HOST, [e]) || hostAllowed('graph.whatsapp.com', [e]) || e === 'graph.whatsapp.com') return true
  // P2 security re-check (finding P2-11): Meta serves the same Graph API under other names of its domains
  // (b-graph.facebook.com, graph.facebook.net, ...): every host of these domains, and every pattern covering one, is reserved
  const host = e.replace(/^\*\./, '')
  return META_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`) || hostAllowed(`graph.${d}`, [e]))
}
const META_DOMAINS = ['facebook.com', 'facebook.net', 'fb.com', 'fbcdn.net', 'whatsapp.com', 'whatsapp.net', 'fbsbx.com']

export interface WhatsappSecret { accessToken?: string; appSecret?: string; verifyToken?: string }

export function parseWhatsappSecret(c: Pick<ConnectionRecord, 'secret'>): WhatsappSecret {
  if (!c.secret) return {}
  try {
    const v = JSON.parse(c.secret) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const o = v as Record<string, unknown>
    const s = (k: string) => (typeof o[k] === 'string' && o[k] ? String(o[k]) : undefined)
    return { accessToken: s('accessToken'), appSecret: s('appSecret'), verifyToken: s('verifyToken') }
  } catch {
    return {}
  }
}

export function policyFor(cache: Map<string, unknown>, timeoutMs: number): OutboundPolicy {
  let pins = cache.get('pins') as OutboundPolicy['pins']
  if (!pins) cache.set('pins', (pins = new Map()))
  const test = baseForTests ? new URL(baseForTests) : null
  return {
    allowedHosts: [test ? test.hostname : GRAPH_HOST],
    // the fake Graph API of the tests listens on 127.0.0.1; Meta's host is public, private networks are refused
    allowPrivate: !!test,
    maxRedirects: 0,
    maxResponseBytes: 2 * 1024 * 1024,
    timeoutMs,
    verifyTls: true,
    pins,
    sensitiveHeaders: ['authorization'],
  }
}

export interface GraphCall {
  connection: ConnectionRecord
  cache: Map<string, unknown>
  timeoutMs: number
  signal?: AbortSignal
}

/** a plain-English error for a Graph API answer (status + body) */
export function mapGraphError(status: number, body: unknown, headers: Record<string, string> = {}): OutboundError {
  const e = (body && typeof body === 'object' ? (body as { error?: Record<string, unknown> }).error : undefined) ?? {}
  const code = Number(e.code)
  const sub = Number(e.error_subcode)
  const retryAfter = Number(headers['retry-after'])
  const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(3600, Math.round(retryAfter)) : null
  const later = wait ? ` Try again in ${wait} s.` : ' Try again later.'
  const ref = Number.isFinite(code) && code ? ` (Meta error ${code}${Number.isFinite(sub) && sub ? `/${sub}` : ''})` : ` (HTTP ${status})`
  // access token
  if (code === 190 || status === 401) return new OutboundError('not_configured', `Meta refused the access token: it has expired or was revoked. An administrator enters a new one on the connection${ref}.`, false, status)
  if (code === 10 || code === 200 || (code >= 200 && code <= 299) || status === 403) return new OutboundError('denied', `The access token may not use this WhatsApp number or account (missing permission whatsapp_business_messaging or whatsapp_business_management)${ref}.`, false, status)
  // rate limits
  if (code === 4 || code === 80007 || code === 130429 || code === 131056 || code === 613 || status === 429) return new OutboundError('rate_limited', `Meta's rate limit for this WhatsApp number was reached; the message was not sent.${later}${ref}`, true, status === 200 ? 429 : status)
  if (code === 131048) return new OutboundError('rate_limited', `Meta is limiting messages from this number because too many were reported as spam; the message was not sent.${later}${ref}`, true, status)
  // templates
  if (code === 132001) return new OutboundError('invalid_input', `The template does not exist in this language or is not approved yet. Check its name and language in WhatsApp Manager${ref}.`, false, status)
  if (code === 132015 || code === 132016) return new OutboundError('invalid_input', `The template is paused or disabled by Meta (usually because of low quality ratings); use another approved template${ref}.`, false, status)
  if (code === 132000 || code === 132012) return new OutboundError('invalid_input', `The number of values does not match the template's placeholders (or a value has the wrong form)${ref}.`, false, status)
  if (code === 132005 || code === 132007) return new OutboundError('invalid_input', `The message text is too long or breaks the template's format rules${ref}.`, false, status)
  // the recipient
  if (code === 131050) return new OutboundError('denied', `The person has chosen in WhatsApp to stop receiving marketing messages from this business; nothing was sent${ref}.`, false, status)
  if (code === 131049) return new OutboundError('denied', `Meta chose not to deliver this marketing message to keep the person's experience healthy (a per-person limit); try a utility template or later${ref}.`, false, status)
  if (code === 131047) return new OutboundError('denied', `More than 24 hours have passed since the person last wrote: only a template message can be sent now${ref}.`, false, status)
  if (code === 131026 || code === 133010 || code === 131030 || code === 131021) return new OutboundError('invalid_input', `The number cannot receive WhatsApp messages from this business (not on WhatsApp, not a valid number, or not on the test recipient list)${ref}.`, false, status)
  if (code === 100 || code === 131008 || code === 131009) return new OutboundError('invalid_input', `Meta refused a value of the request (for example the number or a template value)${ref}.`, false, status)
  if (code === 368 || code === 131031) return new OutboundError('denied', `The WhatsApp Business account is restricted or locked by Meta; check WhatsApp Manager${ref}.`, false, status)
  if (code === 131000 || code === 131016 || code === 1 || code === 2 || status >= 500) return new OutboundError('upstream', `Meta's service had a problem; the message was probably not sent.${later}${ref}`, true, status >= 500 ? status : 503)
  return new OutboundError('upstream', `Meta refused the request${ref}.`, false, status)
}

/** one JSON call to the Graph API (path after the version, e.g. `/123/messages`) */
export async function graphRequest(c: GraphCall, method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string, string>): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  const token = parseWhatsappSecret(c.connection).accessToken
  if (!token) throw new OutboundError('not_configured', 'The WhatsApp connection has no access token: an administrator enters it on the connection.')
  const version = API_VERSION.test(c.connection.settings?.apiVersion ?? '') ? c.connection.settings!.apiVersion : DEFAULT_API_VERSION
  if (!/^(\/[A-Za-z0-9_]+)+$/.test(path)) throw new OutboundError('invalid_input', 'Invalid Graph API path.')
  const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : ''
  const res = await safeRequest({
    method,
    url: `${graphBase()}/${version}${path}${qs}`,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, policyFor(c.cache, c.timeoutMs), c.signal)
  let parsed: unknown = null
  const text = res.body.toString('utf8')
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
  }
  if (res.status < 200 || res.status >= 300 || (parsed && typeof parsed === 'object' && 'error' in (parsed as object))) throw mapGraphError(res.status, parsed, res.headers)
  return { status: res.status, body: parsed, headers: res.headers }
}
