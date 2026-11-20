/**
 * Inbound webhook from Meta (docs/admin/whatsapp.md "Webhook"). One address per environment and WhatsApp connection:
 *
 *   GET  /api/v1/whatsapp/webhook/:env/:connectionId   the verification handshake: hub.mode=subscribe, hub.verify_token
 *        (compared in constant time with the connection's verify token) -> 200 with hub.challenge as text; else 403
 *   POST /api/v1/whatsapp/webhook/:env/:connectionId   events, verified in this order:
 *     1. environment and connection must exist (a WhatsApp connection); otherwise the same 404
 *     2. rate limit per connection (600 a minute; 429 with Retry-After)
 *     3. the body is read only now, at most 512 KB (413)
 *     4. signature: X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body with the app secret>, constant-time; a
 *        connection without an app secret refuses every call (401)
 *     5. replay: each signature is accepted once for 8 days. A repeat answers 200 (duplicate) without doing anything, because
 *        Meta re-sends a delivery it thinks failed and would keep retrying a 409. Events older than 7 days are ignored; a STOP
 *        always opts out, a START opts in only when the message is newer than the current opt-in record
 *     6. JSON only (415); then statuses (sent, delivered, read, failed) update the message log, inbound messages are logged
 *        (no message text is stored), open the 24-hour window, and STOP / START keywords opt the number out / in;
 *        optionally each inbound message starts the flow named in the connection setting inboundFlowId (webhook trigger)
 *   Answers 200 quickly; Meta expects a 200 for every verified delivery.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { ApiRouter } from '../router.ts'
import type { CoreServices } from '../services.ts'
import type { ConnectionRecord, SqlDb } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import type { FlowWebhookTarget, VerifiedWebhookPayload } from '../actions/contracts.ts'
import { runInEnvironment } from '../env-context.ts'
import { errText, log, rowUid } from '../util.ts'
import { parseWhatsappSecret } from './graph.ts'
import { normalizePhone } from './phone.ts'
import { T, applyStatus, getOptIn, keywords, matchKeyword, noteInbound, recordOptIn } from './store.ts'

export const HOOK_BODY_LIMIT = 512 * 1024
export const HOOK_PER_MINUTE = 600
export const MAX_EVENT_AGE_MS = 7 * 86400_000
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

/** Meta's signature: "sha256=" + hex HMAC-SHA256(app secret, raw body) */
export function signMeta(appSecret: string, body: Buffer | string): string {
  return `sha256=${createHmac('sha256', appSecret).update(body).digest('hex')}`
}

export function verifyMetaSignature(appSecret: string, header: string | undefined, body: Buffer): boolean {
  if (!appSecret || !header) return false
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim())
  if (!m) return false
  const want = createHmac('sha256', appSecret).update(body).digest()
  const got = Buffer.from(m[1], 'hex')
  return got.length === want.length && timingSafeEqual(got, want)
}

function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest()
  const y = createHash('sha256').update(b).digest()
  return timingSafeEqual(x, y) && a.length === b.length
}

class Limiter {
  private hits = new Map<string, number[]>()
  allow(key: string, perMinute: number, now = Date.now()): { ok: boolean; retryAfter: number } {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000)
    if (list.length >= perMinute) {
      this.hits.set(key, list)
      return { ok: false, retryAfter: Math.max(1, Math.ceil((60_000 - (now - list[0])) / 1000)) }
    }
    list.push(now)
    this.hits.set(key, list)
    if (this.hits.size > 2000) for (const k of [...this.hits.keys()].slice(0, 1000)) this.hits.delete(k)
    return { ok: true, retryAfter: 0 }
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const STATUSES = new Set(['sent', 'delivered', 'read', 'failed'])

export interface HookOutcome { statuses: number; unknownStatuses: number; inbound: number; optedOut: number; optedIn: number; ignored: number; flowRuns: number }

/** the text a person sent: text body, button text or payload, interactive reply title */
function inboundText(m: Record<string, unknown>): string {
  const t = isObj(m.text) ? m.text.body : isObj(m.button) ? (m.button.text ?? m.button.payload) : isObj(m.interactive) ? (isObj(m.interactive.button_reply) ? m.interactive.button_reply.title : isObj(m.interactive.list_reply) ? m.interactive.list_reply.title : '') : ''
  return typeof t === 'string' ? t.slice(0, 4096) : ''
}

/** processes one verified delivery (exported for tests) */
export async function processDelivery(s: CoreServices, env: string, conn: ConnectionRecord, body: unknown, now = Date.now()): Promise<HookOutcome> {
  const db = s.state.db as SqlDb
  const out: HookOutcome = { statuses: 0, unknownStatuses: 0, inbound: 0, optedOut: 0, optedIn: 0, ignored: 0, flowRuns: 0 }
  if (!isObj(body) || body.object !== 'whatsapp_business_account') return out
  const st = conn.settings ?? {}
  const kw = await keywords(db)
  for (const entry of arr(body.entry).slice(0, 100)) {
    if (!isObj(entry)) continue
    for (const change of arr(entry.changes).slice(0, 100)) {
      if (!isObj(change) || change.field !== 'messages' || !isObj(change.value)) continue
      const v = change.value
      // events of another WhatsApp number of the same app are not this connection's
      if (isObj(v.metadata) && String(v.metadata.phone_number_id ?? '') !== String(st.phoneNumberId ?? '')) {
        out.ignored++
        continue
      }
      const display = isObj(v.metadata) ? String(v.metadata.display_phone_number ?? '').slice(0, 30) : ''
      for (const x of arr(v.statuses).slice(0, 1000)) {
        if (!isObj(x) || typeof x.id !== 'string' || !STATUSES.has(String(x.status))) continue
        const at = Number(x.timestamp) * 1000
        if (!Number.isFinite(at) || now - at > MAX_EVENT_AGE_MS) { out.ignored++; continue }
        const e0 = arr(x.errors)[0]
        const err = isObj(e0) ? { code: String(e0.code ?? 'error'), text: String((isObj(e0.error_data) ? e0.error_data.details : null) ?? e0.title ?? e0.message ?? 'failed') } : undefined
        if (await applyStatus(db, conn.id, x.id, String(x.status), new Date(at), err)) out.statuses++
        else out.unknownStatuses++
      }
      const names = new Map<string, string>()
      for (const c of arr(v.contacts)) if (isObj(c) && typeof c.wa_id === 'string' && isObj(c.profile) && typeof c.profile.name === 'string') names.set(c.wa_id, c.profile.name.slice(0, 100))
      for (const m of arr(v.messages).slice(0, 1000)) {
        if (!isObj(m) || typeof m.from !== 'string' || typeof m.id !== 'string') continue
        const at = Number(m.timestamp) * 1000
        if (!Number.isFinite(at) || now - at > MAX_EVENT_AGE_MS) { out.ignored++; continue }
        let phone: string
        try {
          phone = normalizePhone(`+${m.from.replace(/^\+/, '')}`, undefined)
        } catch {
          out.ignored++
          continue
        }
        // one log row per Meta message id (a re-sent delivery with another signature is still one message)
        const seen = await db.query(`SELECT 1 FROM ${T('ab_whatsapp_messages')} WHERE provider_id = $1 AND direction = 'in' AND connection_id = $2`, [m.id, conn.id])
        if (seen.length) continue
        out.inbound++
        await noteInbound(db, conn.id, phone, new Date(at))
        const text = inboundText(m)
        const stop = text ? matchKeyword(text, kw.stop) : null
        const start = !stop && text ? matchKeyword(text, kw.start) : null
        const history: { status: string; at: string; error?: string }[] = [{ status: 'received', at: new Date(at).toISOString() }]
        if (stop || start) {
          const cur = await getOptIn(db, phone)
          const want = stop ? 'opted_out' : 'opted_in'
          // STOP always applies (the safe direction, also when it arrives late); START only when the message is newer
          // than the current record, so a delayed or replayed START never undoes a later opt-out
          const applies = stop ? true : !cur || Date.parse(cur.recordedOn) < at
          if (applies && cur?.status !== want) {
            await recordOptIn(db, {
              phone, status: want, source: 'inbound keyword', by: 'whatsapp-webhook', connectionId: conn.id,
              evidence: `Sent "${stop ?? start}" to the WhatsApp number ${display || st.phoneNumberId} at ${new Date(at).toISOString()} (Meta message id ${m.id.slice(0, 120)}).`,
            })
            if (stop) out.optedOut++
            else out.optedIn++
            history.push({ status: want, at: new Date(now).toISOString() })
          }
        }
        await db.exec(
          `INSERT INTO ${T('ab_whatsapp_messages')} (id, connection_id, direction, phone, kind, status, history, provider_id, source, created_on, modified_on) VALUES ($1, $2, 'in', $3, $4, 'received', $5::jsonb, $6, 'webhook', $7, now())`,
          [`wam_${rowUid().replace(/-/g, '').slice(-20)}`, conn.id, phone, String(m.type ?? 'unknown').slice(0, 30), JSON.stringify(history), m.id.slice(0, 200), new Date(at)],
        )
        // optional: a flow with a webhook trigger runs for each inbound message
        const flowId = st.inboundFlowId
        const flows = (s as unknown as { flows?: FlowWebhookTarget }).flows
        if (flowId && flows?.triggerWebhook) {
          const payload: VerifiedWebhookPayload = {
            hookId: `whatsapp:${conn.id}`, flowId, receivedOn: new Date(now).toISOString(), contentType: 'application/json',
            body: { From: phone, Name: names.get(m.from) ?? '', Type: String(m.type ?? ''), Text: text, MessageId: m.id, SentOn: new Date(at).toISOString(), Keyword: stop ? 'stop' : start ? 'start' : '', Connection: conn.name },
            query: {}, headers: {}, verifiedBy: 'hmac-sha256', bodySha256: sha256(m.id), deliveryId: `wa:${m.id}`.slice(0, 200),
          }
          try {
            await flows.triggerWebhook(env, flowId, payload)
            out.flowRuns++
          } catch (e) {
            log('warn', `whatsapp ${conn.id}: the inbound flow ${flowId} did not start: ${errText(e)}`)
          }
        }
      }
    }
  }
  return out
}

export function whatsappWebhookRoutes(router: ApiRouter, s: CoreServices): void {
  const limiter = new Limiter()
  const notFound = () => new HttpError(404, 'not-found', 'Not found.')

  async function resolve(envId: string, connectionId: string): Promise<ConnectionRecord> {
    if (!/^[a-z0-9_-]{1,64}$/i.test(envId) || !/^[A-Za-z0-9_.:-]{1,100}$/.test(connectionId)) throw notFound()
    if (!s.ready()) throw new HttpError(503, 'unavailable', 'Not ready.')
    const envs = await s.environments.list().catch(() => [])
    if (!envs.some((e) => e.id === envId && e.state === 'ready')) throw notFound()
    const rec = await s.meta.connections.get(connectionId)
    if (!rec || rec.connector !== 'whatsapp') throw notFound()
    return rec
  }

  router.add('GET', '/whatsapp/webhook/:env/:connectionId', async (ctx) => {
    if (!/^[a-z0-9_-]{1,64}$/i.test(ctx.params.env)) throw notFound()
    return runInEnvironment(ctx.params.env, async () => {
      const rec = await resolve(ctx.params.env, ctx.params.connectionId)
      const rl = limiter.allow(`${ctx.params.env}:${rec.id}:get`, 60)
      if (!rl.ok) {
        ctx.res.setHeader('Retry-After', String(rl.retryAfter))
        throw new HttpError(429, 'rate_limited', 'Too many calls; try again later.')
      }
      const want = parseWhatsappSecret(rec).verifyToken ?? ''
      const mode = ctx.query.get('hub.mode') ?? ''
      const token = ctx.query.get('hub.verify_token') ?? ''
      const challenge = ctx.query.get('hub.challenge') ?? ''
      if (mode !== 'subscribe' || !want || !safeEqual(token, want) || !/^[A-Za-z0-9_-]{1,200}$/.test(challenge)) {
        log('warn', `whatsapp ${rec.id}: webhook verification refused (${mode !== 'subscribe' ? 'mode' : !want ? 'no verify token set' : 'token or challenge'})`)
        throw new HttpError(403, 'denied', 'Verification failed.')
      }
      return { raw: true as const, status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: challenge }
    })
  }, { auth: 'none' })

  router.add('POST', '/whatsapp/webhook/:env/:connectionId', async (ctx) => {
    if (!/^[a-z0-9_-]{1,64}$/i.test(ctx.params.env)) throw notFound()
    return runInEnvironment(ctx.params.env, async () => {
      const rec = await resolve(ctx.params.env, ctx.params.connectionId)
      const rl = limiter.allow(`${ctx.params.env}:${rec.id}`, HOOK_PER_MINUTE)
      if (!rl.ok) {
        ctx.res.setHeader('Retry-After', String(rl.retryAfter))
        throw new HttpError(429, 'rate_limited', 'Too many calls; try again later.')
      }
      const raw = await ctx.readBody!(HOOK_BODY_LIMIT)
      const header = ctx.req.headers['x-hub-signature-256']
      const sig = Array.isArray(header) ? header[0] : header
      const appSecret = parseWhatsappSecret(rec).appSecret ?? ''
      if (!appSecret) throw new HttpError(401, 'unauthenticated', 'This WhatsApp connection has no app secret: an administrator enters it before webhook calls are accepted.')
      if (!verifyMetaSignature(appSecret, sig, raw)) {
        log('warn', `whatsapp ${rec.id}: webhook call with a missing or wrong signature refused`)
        throw new HttpError(401, 'unauthenticated', 'The signature does not match.')
      }
      const db = s.state.db!
      const fresh = await db.query(`INSERT INTO ${T('ab_whatsapp_hook_seen')} (sig_hash, connection_id, seen_on) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING RETURNING sig_hash`, [sha256(String(sig).toLowerCase()), rec.id])
      if (!fresh.length) return { raw: true as const, status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ ok: true, duplicate: true }) }
      const type = String(ctx.req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      if (type !== 'application/json') throw new HttpError(415, 'invalid', 'Send JSON.')
      let body: unknown
      try {
        body = JSON.parse(raw.toString('utf8'))
      } catch {
        throw new HttpError(400, 'invalid', 'The body is not valid JSON.')
      }
      const r = await processDelivery(s, ctx.params.env, rec, body)
      if (r.optedOut || r.optedIn) log('info', `whatsapp ${rec.id}: ${r.optedOut} opted out, ${r.optedIn} opted in by keyword`)
      return { raw: true as const, status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ ok: true, ...r }) }
    })
  }, { auth: 'none', raw: true, streamBody: true, maxBodyMB: 1, csrfExempt: true })
}

