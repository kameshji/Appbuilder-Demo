/**
 * OAuth 2.0 access tokens for the SMTP relay (P1-E): AUTH XOAUTH2 against Microsoft 365 (Exchange Online) and Google
 * Workspace (Gmail), without a dependency. Two grants:
 *  - client credentials (Microsoft 365 app-only: application permission SMTP.SendAsApp, the app's service principal
 *    registered in Exchange and given rights on the mailbox; scope https://outlook.office365.com/.default);
 *  - refresh token (Microsoft 365 delegated, scope https://outlook.office.com/SMTP.Send offline_access; Google, scope
 *    https://mail.google.com/): an administrator obtains the refresh token once, outside Appbuilder.
 *
 * Safety: the token endpoint must be https (http only to this computer, for tests); its host passes the outbound policy
 * (net-policy.ts) and the request connects to the address that was checked (no second DNS answer); redirects are not
 * followed; 10 s timeout; answers over 64 KB are refused; the client secret and refresh token are never logged or shown
 * (errors carry the provider's error code and description only). Tokens are cached in memory until a minute before
 * they expire.
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { assertOutboundHost } from '../net-policy.ts'

export type OAuthProvider = 'microsoft' | 'google' | 'custom'
export type OAuthGrant = 'client_credentials' | 'refresh_token'

export interface OAuthTokenConfig {
  provider: OAuthProvider
  grant: OAuthGrant
  tokenUrl: string
  clientId: string
  clientSecret: string
  /** refresh_token grant */
  refreshToken?: string
  scope: string
}

export class OAuthTokenError extends Error {
  permanent: boolean
  constructor(message: string, permanent: boolean) {
    super(message)
    this.permanent = permanent
  }
}

/** the defaults per provider (the admin may change scope and token URL) */
export function oauthDefaults(provider: OAuthProvider, grant: OAuthGrant, tenant = ''): { tokenUrl: string; scope: string } {
  if (provider === 'microsoft') {
    const t = encodeURIComponent(tenant || 'organizations')
    return {
      tokenUrl: `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,
      scope: grant === 'client_credentials' ? 'https://outlook.office365.com/.default' : 'https://outlook.office.com/SMTP.Send offline_access',
    }
  }
  if (provider === 'google') return { tokenUrl: 'https://oauth2.googleapis.com/token', scope: 'https://mail.google.com/' }
  return { tokenUrl: '', scope: '' }
}

/** checks a token URL: https (http only to loopback), no credentials in it; returns the parsed URL */
export function checkTokenUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new OAuthTokenError('The token address must be a web address such as https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token.', true)
  }
  const loop = u.hostname === 'localhost' || u.hostname === '[::1]' || /^127\./.test(u.hostname)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop)) throw new OAuthTokenError('The token address must start with https://.', true)
  if (u.username || u.password) throw new OAuthTokenError('The token address must not contain a user name or password.', true)
  return u
}

const cache = new Map<string, { token: string; until: number }>()
export function clearOAuthCache(): void { cache.clear() }

/**
 * an access token (cached). `onRefreshToken` receives a new refresh token when the provider rotates it (Microsoft does)
 * so the caller can store it.
 */
export async function getAccessToken(c: OAuthTokenConfig, o: { onRefreshToken?: (t: string) => Promise<void> | void; now?: () => number; lookup?: (h: string) => Promise<{ address: string }[]> } = {}): Promise<string> {
  const now = o.now ?? Date.now
  const key = `${c.tokenUrl}\u0000${c.clientId}\u0000${c.grant}\u0000${c.scope}\u0000${c.refreshToken ?? ''}`
  const hit = cache.get(key)
  if (hit && hit.until > now()) return hit.token
  const u = checkTokenUrl(c.tokenUrl)
  if (!c.clientId) throw new OAuthTokenError('The OAuth client id is missing.', true)
  const form = new URLSearchParams({ grant_type: c.grant, client_id: c.clientId, scope: c.scope })
  if (c.clientSecret) form.set('client_secret', c.clientSecret)
  if (c.grant === 'refresh_token') {
    if (!c.refreshToken) throw new OAuthTokenError('The refresh token is missing.', true)
    form.set('refresh_token', c.refreshToken)
  }
  const host = u.hostname.replace(/^\[|\]$/g, '')
  let addrs: string[]
  try {
    addrs = await assertOutboundHost(host, 'OAuth token endpoint', o.lookup ? { lookup: o.lookup } : {})
  } catch (e) {
    throw new OAuthTokenError((e as Error).message, true)
  }
  const pinned = addrs[0]
  const body = form.toString()
  const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request({
      method: 'POST', host: pinned, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search,
      // the checked address; TLS still verifies the certificate for the host name
      ...(u.protocol === 'https:' ? { servername: net.isIP(host) ? undefined : host } : {}),
      headers: { Host: u.host, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), Accept: 'application/json', 'User-Agent': 'Appbuilder' },
      timeout: 10_000,
    }, (r) => {
      let size = 0
      const chunks: Buffer[] = []
      r.on('data', (d: Buffer) => {
        size += d.length
        if (size > 64 * 1024) { req.destroy(new OAuthTokenError('The token endpoint sent an answer that is too large.', false)); return }
        chunks.push(d)
      })
      r.on('end', () => resolve({ status: r.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
      r.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new OAuthTokenError('The token endpoint did not answer in time.', false)))
    req.on('error', (e) => reject(e instanceof OAuthTokenError ? e : new OAuthTokenError(`Could not reach the token endpoint: ${e.message}`, false)))
    req.end(body)
  })
  let j: Record<string, unknown> = {}
  try { j = JSON.parse(res.text) as Record<string, unknown> } catch { /* not JSON */ }
  if (res.status < 200 || res.status >= 300 || typeof j.access_token !== 'string') {
    const code = typeof j.error === 'string' ? j.error : `HTTP ${res.status}`
    const desc = typeof j.error_description === 'string' ? `: ${j.error_description.split(/\r?\n/)[0].slice(0, 200)}` : ''
    // 4xx (invalid_client, invalid_grant ...) will not get better by retrying; 5xx and network problems may
    throw new OAuthTokenError(`The token endpoint refused (${code})${desc}`, res.status >= 400 && res.status < 500)
  }
  const expires = Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600
  cache.set(key, { token: j.access_token, until: now() + Math.max(30, expires - 60) * 1000 })
  if (typeof j.refresh_token === 'string' && j.refresh_token && j.refresh_token !== c.refreshToken && o.onRefreshToken) await o.onRefreshToken(j.refresh_token)
  return j.access_token
}
