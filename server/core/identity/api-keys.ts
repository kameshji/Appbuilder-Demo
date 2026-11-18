/**
 * Service accounts and API keys (P0 package I).
 *
 * A service account is an ab.users row with kind 'service': it never signs in with a password, it is bound to one
 * environment (an access row and roles there) and it acts only through API keys. A key looks like
 *   abk_<8-character prefix>_<43-character secret>
 * The prefix identifies the key (shown in lists, stored in clear); the server keeps only SHA-256 of the whole key (the
 * secret has 256 bits, so a plain hash is enough). A request with `Authorization: Bearer <key>` is authenticated by
 * resolveApiKey(): cookies are ignored, the CSRF header is not required (router.ts), the environment is the key's, and
 * only the Data API is reachable. Per key: optional expiry, optional IP allow-list, a rate limit, last-used tracking.
 */
import { randomBytes } from 'node:crypto'
import type { Ctx, UserContext, UserRecord } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import type { CoreServices } from '../services.ts'
import { userContextFor } from '../auth.ts'
import { identity } from './index.ts'
import { ipAllowed, parseCidr, sameHash, sha256 } from './util.ts'

export const API_KEY_PREFIX = 'abk_'
export const DEFAULT_RATE_PER_MINUTE = 600
const KEY_RE = /^abk_([A-Za-z0-9]{8})_([A-Za-z0-9_-]{43})$/

/** what a key may reach: the Data API (rows, queries, attachments), reading table definitions, and its own identity */
export function bearerAllowed(method: string, path: string): boolean {
  const p = path.replace(/^\/api\/v1/, '')
  if (/^\/(data|query|attachments)(\/|$)/.test(p)) return true
  if (method === 'GET' && /^\/tables(\/[^/]+)?$/.test(p)) return true
  if (method === 'GET' && p === '/auth/session') return true
  return false
}

export interface ApiKeyRow {
  id: string
  userId: string
  environmentId: string
  name: string
  prefix: string
  createdOn: string
  createdBy: string | null
  expiresOn: string | null
  lastUsedOn: string | null
  lastUsedIp: string | null
  revokedOn: string | null
  ipAllow: string[]
  ratePerMinute: number | null
}

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null)
export function toKey(r: Record<string, unknown>): ApiKeyRow {
  return {
    id: String(r.id), userId: String(r.user_id), environmentId: String(r.environment_id), name: String(r.name), prefix: String(r.prefix),
    createdOn: iso(r.created_on)!, createdBy: r.created_by ? String(r.created_by) : null, expiresOn: iso(r.expires_on), lastUsedOn: iso(r.last_used_on),
    lastUsedIp: r.last_used_ip ? String(r.last_used_ip) : null, revokedOn: iso(r.revoked_on), ipAllow: Array.isArray(r.ip_allow) ? (r.ip_allow as string[]) : [],
    ratePerMinute: r.rate_per_minute === null || r.rate_per_minute === undefined ? null : Number(r.rate_per_minute),
  }
}

/** a new key: the full text (shown once), its prefix and hash */
export function newApiKey(): { key: string; prefix: string; hash: string } {
  const alnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(8)
  let prefix = ''
  for (const b of bytes) prefix += alnum[b % alnum.length]
  const key = `${API_KEY_PREFIX}${prefix}_${randomBytes(32).toString('base64url')}`
  return { key, prefix, hash: sha256(key) }
}

export function checkIpAllow(v: unknown): string[] {
  if (v === undefined || v === null || v === '') return []
  const list = Array.isArray(v) ? v : String(v).split(/[\s,]+/)
  const out: string[] = []
  for (const e of list) {
    const t = String(e).trim()
    if (!t) continue
    try {
      parseCidr(t)
    } catch (err) {
      throw new HttpError(422, 'invalid', (err as Error).message, 'ipAllow')
    }
    out.push(t)
  }
  if (out.length > 50) throw new HttpError(422, 'invalid', 'At most 50 addresses or ranges.', 'ipAllow')
  return out
}

/* per key token bucket (per process) and failure counter per address */
const buckets = new Map<string, { tokens: number; at: number }>()
const lastTouch = new Map<string, number>()

function admit(keyId: string, perMinute: number): number {
  const now = Date.now()
  const b = buckets.get(keyId) ?? { tokens: perMinute, at: now }
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute)
  b.at = now
  buckets.set(keyId, b)
  if (b.tokens >= 1) {
    b.tokens -= 1
    return 0
  }
  return Math.ceil(((1 - b.tokens) / perMinute) * 60)
}

const FAIL_LIMIT = 30
const FAIL_WINDOW_MS = 5 * 60_000

/** Authorization: Bearer -> the service account's context in the key's environment (throws 401/403/429) */
export async function resolveApiKey(services: CoreServices, ctx: Ctx): Promise<UserContext> {
  const idn = identity(services)
  const ip = idn.ip(ctx.req)
  const failKey = `apikey-fail:${ip}`
  if (idn.counters.count(failKey, FAIL_WINDOW_MS) >= FAIL_LIMIT) throw new HttpError(429, 'rate_limited', 'Too many invalid API keys from this address. Try again in a few minutes.')
  const raw = String(ctx.req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
  const fail = async (reason: string, userId: string | null = null): Promise<never> => {
    idn.counters.add(failKey)
    await idn.logSignIn(ctx, { userId, outcome: 'failure', reason, method: 'api_key' })
    throw new HttpError(401, 'unauthenticated', 'The API key is not valid (unknown, revoked or expired).')
  }
  const m = KEY_RE.exec(raw)
  if (!m) return fail('malformed_key')
  const db = services.state.db
  if (!db) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
  const rows = await db.query<Record<string, unknown>>(`SELECT k.*, k.secret_hash FROM "ab"."api_keys" k WHERE k.prefix = $1`, [m[1]])
  const row = rows[0]
  if (!row || !sameHash(String(row.secret_hash), sha256(raw))) return fail('unknown_key')
  const key = toKey(row)
  if (key.revokedOn) return fail('revoked_key', key.userId)
  if (key.expiresOn && new Date(key.expiresOn).getTime() <= Date.now()) return fail('expired_key', key.userId)
  if (!ipAllowed(ip, key.ipAllow)) {
    await idn.logSignIn(ctx, { userId: key.userId, outcome: 'failure', reason: 'ip_denied', method: 'api_key' })
    throw new HttpError(403, 'denied', 'This API key may not be used from this address.')
  }
  if (!bearerAllowed(ctx.method, ctx.path)) throw new HttpError(403, 'denied', 'API keys work on the Data API only (/api/v1/data, /api/v1/query, /api/v1/attachments, reading /api/v1/tables).')
  const wait = admit(key.id, key.ratePerMinute ?? DEFAULT_RATE_PER_MINUTE)
  if (wait > 0) {
    ctx.res.setHeader('Retry-After', String(wait))
    throw new HttpError(429, 'rate_limited', `Rate limit of this API key reached. Try again in ${wait} second(s).`)
  }
  const user: UserRecord | null = await services.meta.users.get(key.userId)
  if (!user || user.kind !== 'service' || user.status === 'disabled') return fail('account_disabled', key.userId)
  if (ctx.requestedEnvironment && ctx.requestedEnvironment !== key.environmentId) {
    throw new HttpError(403, 'denied', `This API key belongs to the environment "${key.environmentId}".`)
  }
  // last used: at most once a minute per key
  const now = Date.now()
  if (now - (lastTouch.get(key.id) ?? 0) > 60_000) {
    lastTouch.set(key.id, now)
    await db.exec(`UPDATE "ab"."api_keys" SET last_used_on = now(), last_used_ip = $2 WHERE id = $1`, [key.id, ip]).catch(() => {})
  }
  return userContextFor(services, user, key.environmentId)
}
