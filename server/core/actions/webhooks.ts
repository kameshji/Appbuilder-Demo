/**
 * Inbound webhooks of flows (P1 package D; docs/guide/maker/webhooks.md, docs/admin/webhook-security.md).
 *
 *   POST /api/v1/hooks/:env/:flowId/:token        unauthenticated, verified:
 *     1. the environment, flow and token must match a webhook (token: 32 random bytes; only its SHA-256 is stored);
 *        any mismatch answers the same 404
 *     2. rate limit per webhook (default 60 a minute; 429 with Retry-After)
 *     3. body read only now, capped per webhook (default 256 KB, at most 1 MB; 413)
 *     4. signature (when the webhook requires one, or when the header is sent): header
 *        `X-Appbuilder-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` with the webhook's secret;
 *        |now - t| must be within the tolerance (default 300 s) and a signature is accepted once (replay: 409)
 *     5. content type: application/json, application/x-www-form-urlencoded or text/*; others 415
 *     6. hands the verified payload to the flow runtime (services.flows.triggerWebhook) and answers 202 { accepted, id }
 *
 * Management (makers who may change the flow): list, create (token and secret shown once), change, rotate token or
 * secret (shown once), revoke. Every management step is audited; calls and rejections are counted per webhook.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ApiRouter } from '../router.ts'
import type { CoreServices } from '../services.ts'
import type { Ctx, SqlDb, UserContext } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import type { FlowWebhookTarget, VerifiedWebhookPayload } from './contracts.ts'
import { currentEnvironment, runInEnvironment } from '../env-context.ts'
import { identity } from '../identity/index.ts'
import { errText, log, rowUid } from '../util.ts'

export const SIGNATURE_HEADER = 'x-appbuilder-signature'
export const MAX_HOOK_BODY_KB = 1024
const DEFAULT_BODY_KB = 256
const DEFAULT_PER_MINUTE = 60
const DEFAULT_TOLERANCE_S = 300

export interface WebhookInfo {
  id: string
  flowId: string
  name: string | null
  tokenHint: string
  hasSecret: boolean
  requireSignature: boolean
  toleranceSeconds: number
  maxBodyKB: number
  perMinute: number
  enabled: boolean
  createdBy: string | null
  createdOn: string
  rotatedOn: string | null
  lastUsedOn: string | null
  calls: number
  rejected: number
  /** the address to call, without the token (the token is shown once) */
  urlPrefix: string
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
const newToken = () => randomBytes(32).toString('base64url')
const newSecret = () => `whsec_${randomBytes(32).toString('base64url')}`
const q = (id: string) => `"${id}"`
const T = (t: string) => `${q(currentEnvironment().schema)}.${q(t)}`
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** `t=..,v1=..` -> parts (several v1 allowed) */
export function parseSignatureHeader(h: string): { t: number; v1: string[] } | null {
  let t = NaN
  const v1: string[] = []
  for (const part of h.split(',')) {
    const [k, v] = part.split('=', 2).map((x) => x?.trim() ?? '')
    if (k === 't') t = Number(v)
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) v1.push(v.toLowerCase())
  }
  return Number.isInteger(t) && v1.length ? { t, v1 } : null
}

/** what a sender computes: hex HMAC-SHA256 of "<t>.<body>" */
export function signPayload(secret: string, t: number, body: Buffer | string): string {
  return createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex')
}

/** checks a signature header; returns null when fine, else the reason */
export function verifySignature(secret: string, header: string | undefined, body: Buffer, toleranceSeconds: number, nowMs = Date.now()): { ok: true; t: number; sig: string } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: 'The signature header is missing.' }
  const p = parseSignatureHeader(header)
  if (!p) return { ok: false, reason: 'The signature header is malformed (expected t=<unix seconds>,v1=<hex>).' }
  if (Math.abs(nowMs / 1000 - p.t) > toleranceSeconds) return { ok: false, reason: 'The signature timestamp is outside the allowed tolerance.' }
  const expected = Buffer.from(signPayload(secret, p.t, body), 'hex')
  for (const v of p.v1) {
    const got = Buffer.from(v, 'hex')
    if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true, t: p.t, sig: v }
  }
  return { ok: false, reason: 'The signature does not match.' }
}

function parseBody(contentType: string, raw: Buffer): unknown {
  if (!raw.length) return null
  if (contentType === 'application/json' || /\+json$/.test(contentType)) {
    try {
      return JSON.parse(raw.toString('utf8'))
    } catch {
      throw new HttpError(400, 'invalid', 'The body is not valid JSON.')
    }
  }
  if (contentType === 'application/x-www-form-urlencoded') {
    const out: Record<string, string | string[]> = {}
    for (const [k, v] of new URLSearchParams(raw.toString('utf8'))) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
      const cur = out[k]
      out[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v]
    }
    return out
  }
  if (contentType.startsWith('text/')) return raw.toString('utf8')
  throw new HttpError(415, 'invalid', 'Send JSON, form fields (application/x-www-form-urlencoded) or text.')
}

function safeHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  let n = 0
  for (const [k0, v] of Object.entries(h)) {
    const k = k0.toLowerCase()
    if (v === undefined) continue
    const keep = k === 'content-type' || k === 'user-agent' || (k.startsWith('x-') && !/signature|token|secret|key|auth|cookie/.test(k))
    if (!keep || ++n > 30) continue
    out[k] = (Array.isArray(v) ? v.join(', ') : v).slice(0, 500)
  }
  return out
}

/** sliding window per webhook (in memory) */
class HookLimiter {
  private hits = new Map<string, number[]>()
  allow(key: string, perMinute: number, now = Date.now()): { ok: boolean; retryAfter: number } {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000)
    if (list.length >= perMinute) {
      this.hits.set(key, list)
      return { ok: false, retryAfter: Math.max(1, Math.ceil((60_000 - (now - list[0])) / 1000)) }
    }
    list.push(now)
    this.hits.set(key, list)
    if (this.hits.size > 5000) for (const k of [...this.hits.keys()].slice(0, 2500)) this.hits.delete(k)
    return { ok: true, retryAfter: 0 }
  }
}

export interface WebhookService {
  list(flowId?: string): Promise<WebhookInfo[]>
  get(id: string): Promise<WebhookInfo | null>
  create(flowId: string, o: Record<string, unknown>, by: string | null): Promise<{ hook: WebhookInfo; token: string; secret: string | null; url: string }>
  update(id: string, o: Record<string, unknown>): Promise<WebhookInfo>
  rotate(id: string, o: { token?: boolean; secret?: boolean }): Promise<{ hook: WebhookInfo; token?: string; secret?: string; url?: string }>
  remove(id: string): Promise<boolean>
}

export function createWebhookService(s: CoreServices): WebhookService {
  const db = (): SqlDb => {
    const d = s.state.db
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }
  const prefix = async (flowId: string) => {
    const base = await identity(s).mail.brand().then((b) => b.publicUrl).catch(() => '')
    return `${base}/api/v1/hooks/${encodeURIComponent(currentEnvironment().id)}/${encodeURIComponent(flowId)}/`
  }
  const toInfo = async (r: Record<string, unknown>): Promise<WebhookInfo> => ({
    id: String(r.id), flowId: String(r.flow_id), name: r.name ? String(r.name) : null, tokenHint: String(r.token_hint), hasSecret: !!r.secret_sealed,
    requireSignature: !!r.require_signature, toleranceSeconds: Number(r.tolerance_seconds), maxBodyKB: Number(r.max_body_kb), perMinute: Number(r.per_minute),
    enabled: !!r.enabled, createdBy: r.created_by ? String(r.created_by) : null, createdOn: new Date(r.created_on as string).toISOString(),
    rotatedOn: r.rotated_on ? new Date(r.rotated_on as string).toISOString() : null, lastUsedOn: r.last_used_on ? new Date(r.last_used_on as string).toISOString() : null,
    calls: Number(r.calls ?? 0), rejected: Number(r.rejected ?? 0), urlPrefix: await prefix(String(r.flow_id)),
  })
  const opts = (o: Record<string, unknown>, cur?: { requireSignature: boolean; toleranceSeconds: number; maxBodyKB: number; perMinute: number; enabled: boolean; name: string | null }) => {
    const int = (v: unknown, def: number, min: number, max: number, what: string) => {
      if (v === undefined || v === null) return def
      const n = Number(v)
      if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(422, 'invalid', `${what} must be a whole number from ${min} to ${max}.`)
      return n
    }
    const name = o.name === undefined ? (cur?.name ?? null) : o.name === null || o.name === '' ? null : String(o.name).slice(0, 200)
    return {
      name,
      requireSignature: o.requireSignature === undefined ? (cur?.requireSignature ?? true) : o.requireSignature === true,
      toleranceSeconds: int(o.toleranceSeconds, cur?.toleranceSeconds ?? DEFAULT_TOLERANCE_S, 30, 3600, 'The timestamp tolerance (seconds)'),
      maxBodyKB: int(o.maxBodyKB, cur?.maxBodyKB ?? DEFAULT_BODY_KB, 1, MAX_HOOK_BODY_KB, 'The body limit (KB)'),
      perMinute: int(o.perMinute, cur?.perMinute ?? DEFAULT_PER_MINUTE, 1, 6000, 'Calls per minute'),
      enabled: o.enabled === undefined ? (cur?.enabled ?? true) : o.enabled === true,
    }
  }
  const svc: WebhookService = {
    async list(flowId) {
      const rows = flowId
        ? await db().query<Record<string, unknown>>(`SELECT * FROM ${T('ab_webhooks')} WHERE flow_id = $1 ORDER BY created_on`, [flowId])
        : await db().query<Record<string, unknown>>(`SELECT * FROM ${T('ab_webhooks')} ORDER BY created_on`)
      return Promise.all(rows.map(toInfo))
    },
    async get(id) {
      const r = await db().query<Record<string, unknown>>(`SELECT * FROM ${T('ab_webhooks')} WHERE id = $1`, [id])
      return r[0] ? toInfo(r[0]) : null
    },
    async create(flowId, o, by) {
      if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(flowId)) throw new HttpError(422, 'invalid', 'Invalid flow id.')
      const v = opts(o)
      const token = newToken()
      const secret = newSecret()
      const id = `whk_${rowUid().replace(/-/g, '').slice(-16)}`
      await db().exec(
        `INSERT INTO ${T('ab_webhooks')} (id, flow_id, name, token_hash, token_hint, secret_sealed, require_signature, tolerance_seconds, max_body_kb, per_minute, enabled, created_by, created_on)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())`,
        [id, flowId, v.name, sha256(token), token.slice(0, 4), s.secrets.encrypt(secret), v.requireSignature, v.toleranceSeconds, v.maxBodyKB, v.perMinute, v.enabled, by],
      )
      const hook = (await svc.get(id))!
      return { hook, token, secret, url: hook.urlPrefix + token }
    },
    async update(id, o) {
      const cur = await svc.get(id)
      if (!cur) throw new HttpError(404, 'not-found', 'Webhook not found.')
      const v = opts(o, cur)
      await db().exec(`UPDATE ${T('ab_webhooks')} SET name = $2, require_signature = $3, tolerance_seconds = $4, max_body_kb = $5, per_minute = $6, enabled = $7 WHERE id = $1`, [id, v.name, v.requireSignature, v.toleranceSeconds, v.maxBodyKB, v.perMinute, v.enabled])
      return (await svc.get(id))!
    },
    async rotate(id, o) {
      const cur = await svc.get(id)
      if (!cur) throw new HttpError(404, 'not-found', 'Webhook not found.')
      const out: { token?: string; secret?: string; url?: string } = {}
      if (o.token) {
        out.token = newToken()
        await db().exec(`UPDATE ${T('ab_webhooks')} SET token_hash = $2, token_hint = $3, rotated_on = now() WHERE id = $1`, [id, sha256(out.token), out.token.slice(0, 4)])
        out.url = cur.urlPrefix + out.token
      }
      if (o.secret) {
        out.secret = newSecret()
        await db().exec(`UPDATE ${T('ab_webhooks')} SET secret_sealed = $2, rotated_on = now() WHERE id = $1`, [id, s.secrets.encrypt(out.secret)])
      }
      return { hook: (await svc.get(id))!, ...out }
    },
    async remove(id) {
      return (await db().exec(`DELETE FROM ${T('ab_webhooks')} WHERE id = $1`, [id])).affectedRows > 0
    },
  }
  return svc
}

const flowsOf = (s: CoreServices): FlowWebhookTarget | undefined => (s as unknown as { flows?: FlowWebhookTarget }).flows

export function webhookRoutes(router: ApiRouter, s: CoreServices, hooks: WebhookService): void {
  const limiter = new HookLimiter()

  async function canManage(u: UserContext, flowId: string): Promise<void> {
    const f = flowsOf(s)
    if (f?.canManage) {
      if (!(await f.canManage(u, flowId))) throw new HttpError(403, 'denied', 'Only people who may change this flow can manage its webhooks.')
    } else if (!u.privileges.isMaker && !u.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only makers can manage webhooks.')
  }
  const audit = async (ctx: Ctx, action: string, details: unknown) => {
    try {
      await s.meta.audit({ userId: ctx.user?.user.id ?? null, action, details })
    } catch (e) {
      log('error', `audit write failed (${action}): ${errText(e)}`)
    }
  }

  router.add('GET', '/flows/:flowId/webhooks', async (ctx) => {
    await canManage(ctx.user!, ctx.params.flowId)
    return { items: await hooks.list(ctx.params.flowId) }
  }, { auth: 'user' })

  router.add('POST', '/flows/:flowId/webhooks', async (ctx) => {
    await canManage(ctx.user!, ctx.params.flowId)
    const f = flowsOf(s)
    if (f?.webhookFlow && !(await f.webhookFlow(currentEnvironment().id, ctx.params.flowId))) throw new HttpError(404, 'not-found', 'There is no flow with a webhook trigger by that id.')
    const r = await hooks.create(ctx.params.flowId, isObj(ctx.body) ? ctx.body : {}, ctx.user!.user.id)
    await audit(ctx, 'webhook.create', { id: r.hook.id, flowId: r.hook.flowId, requireSignature: r.hook.requireSignature })
    return { ...r, note: 'Copy the address and the signing secret now: they are not shown again.' }
  }, { auth: 'user' })

  const hookFor = async (ctx: Ctx) => {
    const h = await hooks.get(ctx.params.id)
    if (!h) throw new HttpError(404, 'not-found', 'Webhook not found.')
    await canManage(ctx.user!, h.flowId)
    return h
  }

  router.add('PATCH', '/webhooks/:id', async (ctx) => {
    const h = await hookFor(ctx)
    const next = await hooks.update(h.id, isObj(ctx.body) ? ctx.body : {})
    await audit(ctx, 'webhook.update', { id: h.id, flowId: h.flowId, requireSignature: next.requireSignature, enabled: next.enabled })
    return next
  }, { auth: 'user' })

  router.add('POST', '/webhooks/:id/rotate', async (ctx) => {
    const h = await hookFor(ctx)
    const b = isObj(ctx.body) ? ctx.body : {}
    const r = await hooks.rotate(h.id, { token: b.token === true, secret: b.secret === true })
    if (!r.token && !r.secret) throw new HttpError(422, 'invalid', 'Say what to rotate: token, secret or both.')
    await audit(ctx, 'webhook.rotate', { id: h.id, flowId: h.flowId, token: !!r.token, secret: !!r.secret })
    return r
  }, { auth: 'user' })

  router.add('DELETE', '/webhooks/:id', async (ctx) => {
    const h = await hookFor(ctx)
    await hooks.remove(h.id)
    await audit(ctx, 'webhook.revoke', { id: h.id, flowId: h.flowId })
    return { ok: true }
  }, { auth: 'user' })

  /* ---------------------------------------------------------------- the inbound call */

  router.add('POST', '/hooks/:env/:flowId/:token', async (ctx) => {
    const notFound = () => new HttpError(404, 'not-found', 'Not found.')
    const env = ctx.params.env
    if (!/^[a-z0-9_-]{1,64}$/i.test(env) || !/^[A-Za-z0-9_.:-]{1,100}$/.test(ctx.params.flowId) || !/^[A-Za-z0-9_-]{20,100}$/.test(ctx.params.token)) throw notFound()
    const envs = await s.environments.list().catch(() => [])
    if (!envs.some((e) => e.id === env && e.state === 'ready')) throw notFound()
    return runInEnvironment(env, async () => {
      const rows = await s.state.db!.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_webhooks')} WHERE flow_id = $1 AND token_hash = $2`, [ctx.params.flowId, sha256(ctx.params.token)])
      const row = rows[0]
      if (!row || !row.enabled) throw notFound()
      const id = String(row.id)
      const reject = async (e: HttpError) => {
        await s.state.db!.exec(`UPDATE ${T('ab_webhooks')} SET rejected = rejected + 1 WHERE id = $1`, [id]).catch(() => {})
        return e
      }
      const rl = limiter.allow(`${env}:${id}`, Number(row.per_minute) || DEFAULT_PER_MINUTE)
      if (!rl.ok) {
        ctx.res.setHeader('Retry-After', String(rl.retryAfter))
        throw await reject(new HttpError(429, 'rate_limited', 'Too many calls to this webhook; try again later.'))
      }
      const limit = Math.min(MAX_HOOK_BODY_KB, Number(row.max_body_kb) || DEFAULT_BODY_KB) * 1024
      let raw: Buffer
      try {
        raw = await ctx.readBody!(limit)
      } catch (e) {
        throw await reject(e instanceof HttpError ? e : new HttpError(400, 'invalid', 'The body could not be read.'))
      }
      const header = ctx.req.headers[SIGNATURE_HEADER]
      const sigHeader = Array.isArray(header) ? header[0] : header
      let verifiedBy: VerifiedWebhookPayload['verifiedBy'] = 'token'
      if (row.require_signature || sigHeader) {
        let secret = ''
        try {
          secret = row.secret_sealed ? s.secrets.decrypt(String(row.secret_sealed)) : ''
        } catch {
          secret = ''
        }
        if (!secret) throw await reject(new HttpError(401, 'unauthenticated', 'This webhook has no signing secret; rotate it to get one.'))
        const v = verifySignature(secret, sigHeader, raw, Number(row.tolerance_seconds) || DEFAULT_TOLERANCE_S)
        if (!v.ok) throw await reject(new HttpError(401, 'unauthenticated', v.reason))
        const fresh = await s.state.db!.query(`INSERT INTO ${T('ab_webhook_replays')} (hook_id, sig_hash, seen_on) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING RETURNING hook_id`, [id, sha256(v.sig)])
        if (!fresh.length) throw await reject(new HttpError(409, 'conflict', 'This signed call was already received (replay).'))
        verifiedBy = 'hmac-sha256'
      }
      const contentType = String(ctx.req.headers['content-type'] ?? (raw.length ? 'application/octet-stream' : 'text/plain')).split(';')[0].trim().toLowerCase()
      let body: unknown
      try {
        body = parseBody(contentType, raw)
      } catch (e) {
        throw await reject(e as HttpError)
      }
      const bodySha256 = sha256(raw)
      const hdr = (n: string) => {
        const v = ctx.req.headers[n]
        const x = Array.isArray(v) ? v[0] : v
        return x && /^[\x21-\x7e]{1,200}$/.test(x) ? x : null
      }
      const receivedOn = new Date().toISOString()
      const payload: VerifiedWebhookPayload = {
        hookId: id, flowId: ctx.params.flowId, receivedOn, contentType, body,
        query: Object.fromEntries([...ctx.query.entries()].slice(0, 50).map(([k, v]) => [k.slice(0, 100), v.slice(0, 1000)])),
        headers: safeHeaders(ctx.req.headers), verifiedBy, bodySha256,
        deliveryId: hdr('x-appbuilder-delivery') ?? hdr('idempotency-key') ?? hdr('x-request-id') ?? `${bodySha256.slice(0, 32)}:${receivedOn}`,
      }
      const f = flowsOf(s)
      if (!f?.triggerWebhook) throw new HttpError(503, 'unavailable', 'Flows are not available on this server yet.')
      let run: { runId?: string } | void
      try {
        run = await f.triggerWebhook(env, ctx.params.flowId, payload)
      } catch (e) {
        const he = e instanceof HttpError ? e : null
        log('warn', `webhook ${id}: the flow did not accept the call: ${errText(e)}`)
        if (he && he.status < 500) throw await reject(he)
        throw new HttpError(503, 'unavailable', 'The flow could not take the call; try again later.')
      }
      await s.state.db!.exec(`UPDATE ${T('ab_webhooks')} SET calls = calls + 1, last_used_on = now() WHERE id = $1`, [id]).catch(() => {})
      return { raw: true as const, status: 202, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ accepted: true, id: (run && run.runId) || payload.deliveryId }) }
    })
  }, { auth: 'none', raw: true, streamBody: true, maxBodyMB: MAX_HOOK_BODY_KB / 1024, csrfExempt: true })
}
