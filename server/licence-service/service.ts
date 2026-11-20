/**
 * The licence service's one public endpoint (package H-G; docs/dev/licensing.md "Service").
 *
 *   POST /v1/licence/check   Authorization: Bearer <install key>; body CheckRequest (core/licence/answer.ts)
 *                            -> 200 SignedAnswer (Ed25519). An unknown key, a revoked key and a key of another licence
 *                            get the SAME answer (status refused, signed, echoing the request's ids and nonce), so the
 *                            service does not reveal which keys or licences exist.
 *                            -> 400 for a malformed request, 413 above 4 KB, 429 when rate limited (unsigned)
 *   GET  /healthz            -> { ok: true } (the operator's monitor)
 *
 * Rate limits (per client address, and per presented key): APPBUILDER_LICENCE_RATE_PER_MIN (30) and 10 per key. Behind
 * Caddy set APPBUILDER_LICENCE_TRUST_PROXY=1 so the client address is the X-Forwarded-For entry the proxy added.
 * Every check is stored (time, install id, version, seat counts, outcome): no address, no person.
 */
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SqlDb } from '../core/contracts.ts'
import {
  GRACE_MS, INSTALL_KEY_RE, parseCheckRequest, signAnswer,
  type CheckRequest, type LicencePayload, type LicenceStatus, type SigningKey,
} from '../core/licence/answer.ts'
import { getOrg, hashKey, tables, type OrgRow } from './store.ts'

const DAY = 86_400_000
/** two installs seen within this window count as "alternating" on one licence */
export const DUPLICATE_WINDOW_MS = DAY
/** after this long of alternating, the older install gets `duplicate` (spec 7) */
export const DUPLICATE_GRACE_MS = 7 * DAY
const MAX_BODY = 4096

export interface ServiceDeps {
  db: SqlDb
  key: SigningKey
  clock?: () => number
  ratePerMinute?: number
  /** checks per presented key per minute (10) */
  keyRatePerMinute?: number
  trustProxy?: boolean
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

/* ------------------------------------------------------------------ deciding the answer */

export function decide(org: OrgRow, now: number, duplicateOlder: boolean): Pick<LicencePayload, 'status' | 'readOnlyFrom' | 'message'> {
  const at = (ms: number) => new Date(ms).toISOString()
  if (org.state === 'suspended' || org.state === 'cancelled') {
    return {
      status: org.state, readOnlyFrom: at(org.stateSince.getTime() + org.stateNoticeDays * DAY),
      message: org.stateMessage || (org.state === 'suspended' ? 'The licence was suspended by the operator.' : 'The licence was cancelled.'),
    }
  }
  if (duplicateOlder) {
    return { status: 'duplicate', readOnlyFrom: at(now), message: 'Another install uses this licence and this one was set up earlier: it is read-only. The operator can release it (licence-service install release).' }
  }
  if (org.kind === 'subscription' && (!org.paidUntil || org.paidUntil.getTime() < now)) {
    const from = (org.paidUntil ?? org.createdOn).getTime() + org.noticeDays * DAY
    return { status: 'payment', readOnlyFrom: at(from), message: org.paidUntil ? `The subscription was paid until ${org.paidUntil.toISOString().slice(0, 10)}.` : 'No payment has been recorded for this subscription.' }
  }
  return { status: 'active', readOnlyFrom: null, message: '' }
}

function payload(req: CheckRequest, now: number, org: OrgRow | null, d: Pick<LicencePayload, 'status' | 'readOnlyFrom' | 'message'>): LicencePayload {
  const t = new Date(now).toISOString()
  return {
    v: 1, licenceId: req.licenceId, installId: req.installId, status: d.status,
    plan: org?.plan ?? null, kind: org?.kind ?? null, seats: org ? org.seats : null,
    paidUntil: org?.kind === 'subscription' ? (org.paidUntil?.toISOString() ?? null) : null,
    maintenanceUntil: org?.kind === 'lifetime' ? (org.maintenanceUntil?.toISOString() ?? null) : null,
    noticeDays: org ? (org.state === 'active' ? org.noticeDays : org.stateNoticeDays) : 0,
    readOnlyFrom: d.readOnlyFrom, message: d.message, issuedAt: t, validUntil: new Date(now + GRACE_MS).toISOString(), serverTime: t, nonce: req.nonce,
  }
}

const REFUSED = { status: 'refused' as LicenceStatus, readOnlyFrom: null, message: 'The licence service did not accept this install key for this licence (unknown, revoked or of another licence).' }

/** one check: the answer to sign (and its outcome for the check-in log) */
export async function check(db: SqlDb, key: string | null, req: CheckRequest, now: number): Promise<{ p: LicencePayload; outcome: string; orgId: string | null }> {
  let org: OrgRow | null = null
  if (key && INSTALL_KEY_RE.test(key)) {
    const rows = await db.query<{ org_id: string; revoked_on: Date | null }>(`SELECT org_id, revoked_on FROM ${tables.keys} WHERE key_hash = $1`, [hashKey(key)])
    if (rows[0] && !rows[0].revoked_on && rows[0].org_id === req.licenceId) org = await getOrg(db, rows[0].org_id)
  }
  if (!org) return { p: payload(req, now, null, REFUSED), outcome: 'refused', orgId: null }

  // the installs of this licence: two alternating within a day are flagged; after 7 days the older one is duplicate
  const at = new Date(now)
  await db.exec(
    `INSERT INTO ${tables.installs} (org_id, install_id, first_seen, last_seen, version, seats) VALUES ($1, $2, $3, $3, $4, $5::jsonb)
     ON CONFLICT (org_id, install_id) DO UPDATE SET last_seen = EXCLUDED.last_seen, version = EXCLUDED.version, seats = EXCLUDED.seats`,
    [org.id, req.installId, at, req.version, JSON.stringify(req.seats)],
  )
  const recent = await db.query<{ install_id: string; first_seen: Date }>(
    `SELECT install_id, first_seen FROM ${tables.installs} WHERE org_id = $1 AND NOT released AND last_seen > $2 ORDER BY first_seen DESC, install_id`,
    [org.id, new Date(now - DUPLICATE_WINDOW_MS)],
  )
  let older = false
  if (recent.length >= 2) {
    if (!org.duplicateSince) {
      await db.exec(`UPDATE ${tables.org} SET duplicate_since = $2 WHERE id = $1 AND duplicate_since IS NULL`, [org.id, at])
      org.duplicateSince = at
    }
    older = now - org.duplicateSince.getTime() >= DUPLICATE_GRACE_MS && recent[0].install_id !== req.installId
  } else if (org.duplicateSince) {
    await db.exec(`UPDATE ${tables.org} SET duplicate_since = NULL WHERE id = $1`, [org.id])
    org.duplicateSince = null
  }
  const dcs = decide(org, now, older)
  return { p: payload(req, now, org, dcs), outcome: dcs.status, orgId: org.id }
}

/* ------------------------------------------------------------------ rate limits */

export function rateLimiter(perMinute: number, clock: () => number) {
  const buckets = new Map<string, { tokens: number; at: number }>()
  return (key: string, limit = perMinute): boolean => {
    const now = clock()
    let b = buckets.get(key)
    if (!b) {
      if (buckets.size > 20_000) buckets.clear()
      b = { tokens: limit, at: now }
      buckets.set(key, b)
    }
    // a clock that went back adds nothing (and takes nothing)
    b.tokens = Math.min(limit, b.tokens + (Math.max(0, now - b.at) / 60_000) * limit)
    b.at = now
    if (b.tokens < 1) return false
    b.tokens -= 1
    return true
  }
}

/* ------------------------------------------------------------------ HTTP */

const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }

function send(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body)
  res.writeHead(status, { ...HEADERS, 'Content-Length': String(Buffer.byteLength(s)) })
  res.end(s)
}

function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    if (xff.length) return xff[xff.length - 1]
  }
  return req.socket.remoteAddress ?? 'unknown'
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let n = 0
    let over = false
    req.on('data', (c: Buffer) => {
      n += c.length
      if (n > MAX_BODY) {
        over = true
        chunks.length = 0
        return
      }
      if (!over) chunks.push(c)
    })
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function createHandler(deps: ServiceDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const clock = deps.clock ?? Date.now
  const limit = rateLimiter(deps.ratePerMinute ?? 30, clock)
  const say = deps.log ?? (() => {})
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://licence.invalid')
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true })
      if (url.pathname !== '/v1/licence/check') return send(res, 404, { error: 'not found' })
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      if (!limit(`ip:${clientAddress(req, !!deps.trustProxy)}`)) return send(res, 429, { error: 'too many requests' })
      const body = await readBody(req)
      if (!body) return send(res, 413, { error: 'request too large' })
      let parsed: unknown
      try {
        parsed = JSON.parse(body.toString('utf8'))
      } catch {
        return send(res, 400, { error: 'not JSON' })
      }
      const cr = parseCheckRequest(parsed)
      if (!cr) return send(res, 400, { error: 'not a licence check request' })
      const auth = String(req.headers.authorization ?? '')
      const key = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? null
      if (!limit(`key:${key ? hashKey(key) : 'none'}`, deps.keyRatePerMinute ?? 10)) return send(res, 429, { error: 'too many requests' })
      const now = clock()
      const out = await check(deps.db, key, cr, now)
      await deps.db.exec(`INSERT INTO ${tables.checkins} (at, org_id, install_id, version, seats, outcome) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`, [new Date(now), out.orgId, cr.installId, cr.version, JSON.stringify(cr.seats), out.outcome])
      send(res, 200, signAnswer(out.p, deps.key))
    } catch (e) {
      say('error', `licence check failed: ${e instanceof Error ? e.message : String(e)}`)
      if (!res.headersSent) send(res, 500, { error: 'internal error' })
      else res.end()
    }
  }
}

export interface ListenOptions { host: string; port: number; tlsCert?: string | null; tlsKey?: string | null }

export function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>, o: ListenOptions): Promise<http.Server> {
  const onReq = (req: IncomingMessage, res: ServerResponse) => { void handler(req, res) }
  const server = o.tlsCert && o.tlsKey
    ? https.createServer({ cert: fs.readFileSync(o.tlsCert), key: fs.readFileSync(o.tlsKey), minVersion: 'TLSv1.2' }, onReq)
    : http.createServer(onReq)
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.port, o.host, () => resolve(server))
  })
}
