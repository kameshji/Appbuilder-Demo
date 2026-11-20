/**
 * THE send path of WhatsApp messages (docs/dev/whatsapp.md "Opt-in enforcement"). Every message Appbuilder sends to a
 * number goes through sendMessage(): the actions sendTemplate and sendText (flows, table events, the Test action form)
 * and the notification channel. There is no other code that posts to Meta's /messages endpoint, and the HTTP connector
 * refuses Meta's Graph API host (graph.ts isReservedGraphHost), so the checks below cannot be skipped:
 *
 *   1. the connection is a WhatsApp connection with sending enabled, a phone number id and an access token;
 *   2. the number is normalised to E.164 (the connection's default country code for numbers written without one);
 *   3. CURRENT OPT-IN: the environment's opt-in store must say opted_in for that number at this moment; otherwise
 *      `denied`, nothing is sent, and the refusal is written to the message log;
 *   4. text replies only inside the 24-hour customer service window as this server knows it (the last inbound message
 *      from that number to that WhatsApp number, recorded from the webhook); otherwise `denied` with the reason;
 *   5. idempotency: a key (the flow's run:step, the notification id) is stored with Meta's message id in the message log; a
 *      second call with the same key returns the stored message instead of sending again (the actions framework keeps its
 *      own 24-hour key store as well);
 *   6. the call to Meta (graph.ts), then the log row is updated with Meta's message id or the error.
 */
import type { ConnectionRecord, SqlDb, UserContext } from '../contracts.ts'
import { OutboundError } from '../actions/outbound.ts'
import { rowUid } from '../util.ts'
import { graphRequest } from './graph.ts'
import { PhoneError, graphNumber, maskPhone, normalizePhone } from './phone.ts'
import { T, WINDOW_MS, hasCurrentOptIn, lastInbound, messageByKey, toMessage, type MessageRow } from './store.ts'

export interface TemplateMessage {
  kind: 'template'
  template: string
  language: string
  bodyParams?: unknown[]
  headerParams?: unknown[]
  buttonParams?: { index: number; subType?: 'url' | 'quick_reply'; value: unknown }[]
}
export interface TextMessage { kind: 'text'; text: string; previewUrl?: boolean }

export interface SendRequest {
  db: SqlDb
  connection: ConnectionRecord
  to: unknown
  message: TemplateMessage | TextMessage
  identity: UserContext | null
  idempotencyKey?: string
  source: string
  actionRunId?: string
  correlationId?: string
  notificationId?: string
  cache: Map<string, unknown>
  timeoutMs: number
  signal?: AbortSignal
  note?(d: Record<string, unknown>): void
}

export interface SendResult { messageId: string; providerMessageId: string; to: string; status: string; replayed?: boolean }

/** a template value: text, number, or a formula record { Value } (a one-column table row from a flow) */
export function paramText(v: unknown): string {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    const inner = 'Value' in o ? o.Value : 'value' in o ? o.value : 'text' in o ? o.text : undefined
    if (inner !== undefined) return paramText(inner)
    throw new OutboundError('invalid_input', 'A template value must be text or a number.')
  }
  if (v === null || v === undefined) return ''
  return String(v)
}

/** the `template` object of Meta's request: components header, body and buttons with text parameters */
export function templatePayload(m: TemplateMessage): Record<string, unknown> {
  const text = (list: unknown[] | undefined) => (list ?? []).map((v) => {
    const t = paramText(v)
    if (!t.trim()) throw new OutboundError('invalid_input', 'Template values must not be empty (Meta refuses empty values).')
    if (t.length > 1024) throw new OutboundError('invalid_input', 'A template value may be at most 1024 characters.')
    if (/[\n\t]| {5,}/.test(t)) throw new OutboundError('invalid_input', 'A template value may not contain new lines, tabs or more than four spaces in a row (Meta\'s rule).')
    return { type: 'text', text: t }
  })
  const components: Record<string, unknown>[] = []
  if (m.headerParams?.length) components.push({ type: 'header', parameters: text(m.headerParams) })
  if (m.bodyParams?.length) components.push({ type: 'body', parameters: text(m.bodyParams) })
  for (const b of m.buttonParams ?? []) {
    const sub = b.subType === 'quick_reply' ? 'quick_reply' : 'url'
    const value = paramText(b.value)
    components.push({ type: 'button', sub_type: sub, index: String(b.index), parameters: [sub === 'quick_reply' ? { type: 'payload', payload: value } : { type: 'text', text: value }] })
  }
  return { name: m.template, language: { code: m.language || 'en' }, ...(components.length ? { components } : {}) }
}

const newId = () => `wam_${rowUid().replace(/-/g, '').slice(-20)}`

async function logRefusal(r: SendRequest, phone: string, code: string, message: string): Promise<void> {
  const m = r.message
  await r.db.exec(
    `INSERT INTO ${T('ab_whatsapp_messages')} (id, connection_id, direction, phone, kind, template, language, status, history, source, action_run_id, correlation_id, notification_id, user_id, error_code, error, created_on, modified_on)
     VALUES ($1, $2, 'out', $3, $4, $5, $6, 'refused', $7::jsonb, $8, $9, $10, $11, $12, $13, $14, now(), now())`,
    [newId(), r.connection.id, phone, m.kind, m.kind === 'template' ? m.template : null, m.kind === 'template' ? m.language : null, JSON.stringify([{ status: 'refused', at: new Date().toISOString(), error: message.slice(0, 300) }]),
      r.source.slice(0, 200), r.actionRunId ?? null, r.correlationId ?? null, r.notificationId ?? null, r.identity?.user.id ?? null, code, message.slice(0, 500)],
  ).catch(() => {})
}

export async function sendMessage(r: SendRequest): Promise<SendResult> {
  const st = r.connection.settings ?? {}
  if (r.connection.connector !== 'whatsapp') throw new OutboundError('invalid_input', 'This is not a WhatsApp connection.')
  // 2. number
  let phone: string
  try {
    phone = normalizePhone(r.to, st.defaultCountryCode)
  } catch (e) {
    throw new OutboundError('invalid_input', e instanceof PhoneError ? e.message : 'The phone number is not valid.')
  }
  const masked = maskPhone(phone)
  r.note?.({ to: masked, kind: r.message.kind, ...(r.message.kind === 'template' ? { template: r.message.template } : {}) })
  // 1. connection
  if (st.sendingEnabled === 'false') {
    const msg = 'Sending is turned off on this WhatsApp connection (an administrator turns it on in the connection settings); nothing was sent.'
    await logRefusal(r, phone, 'disabled', msg)
    throw new OutboundError('denied', msg)
  }
  if (!/^\d{5,20}$/.test(st.phoneNumberId ?? '')) throw new OutboundError('not_configured', 'The WhatsApp connection has no phone number id: an administrator sets it on the connection.')
  // 5. idempotency (before the checks: a replay of a message that was sent is answered even if the opt-in changed since)
  if (r.idempotencyKey) {
    const prev = await messageByKey(r.db, r.connection.id, r.idempotencyKey)
    if (prev) {
      if (prev.providerId) return { messageId: prev.id, providerMessageId: prev.providerId, to: masked, status: prev.status, replayed: true }
      if (prev.status === 'sending' && Date.now() - Date.parse(prev.createdOn) < Math.max(60_000, r.timeoutMs * 2 + 10_000)) throw new OutboundError('in_progress', 'The same WhatsApp message (same idempotency key) is being sent right now.', true)
      // an earlier attempt failed without a message id: release the key, this attempt makes a new log row
      await r.db.exec(`UPDATE ${T('ab_whatsapp_messages')} SET idempotency_key = NULL, modified_on = now() WHERE id = $1`, [prev.id])
    }
  }
  // 3. CURRENT OPT-IN (the enforcement point)
  if (!(await hasCurrentOptIn(r.db, phone))) {
    const msg = `${masked} has no current WhatsApp opt-in in this environment, so nothing was sent. Record the person's opt-in first (Admin console > WhatsApp, or the action "Record an opt-in or opt-out").`
    await logRefusal(r, phone, 'no_opt_in', msg)
    throw new OutboundError('denied', msg)
  }
  // 4. the 24-hour window for free text
  if (r.message.kind === 'text') {
    const last = await lastInbound(r.db, r.connection.id, phone)
    if (!last || Date.now() - last.getTime() > WINDOW_MS) {
      const msg = last
        ? `${masked} last wrote to this WhatsApp number on ${last.toISOString().slice(0, 16).replace('T', ' ')} UTC, more than 24 hours ago: outside the customer service window only a template message may be sent. Nothing was sent.`
        : `${masked} has not written to this WhatsApp number (no inbound message recorded by this server), so a free-text reply is not allowed: send a template message. Nothing was sent.`
      await logRefusal(r, phone, 'outside_window', msg)
      throw new OutboundError('denied', msg)
    }
  }
  // the request body (template values are checked before anything is logged as sending)
  const m = r.message
  const body: Record<string, unknown> = m.kind === 'template'
    ? { messaging_product: 'whatsapp', recipient_type: 'individual', to: graphNumber(phone), type: 'template', template: templatePayload(m) }
    : { messaging_product: 'whatsapp', recipient_type: 'individual', to: graphNumber(phone), type: 'text', text: { preview_url: !!m.previewUrl, body: m.text } }
  const id = newId()
  try {
    await r.db.exec(
      `INSERT INTO ${T('ab_whatsapp_messages')} (id, connection_id, direction, phone, kind, template, language, status, history, idempotency_key, source, action_run_id, correlation_id, notification_id, user_id, created_on, modified_on)
       VALUES ($1, $2, 'out', $3, $4, $5, $6, 'sending', $7::jsonb, $8, $9, $10, $11, $12, $13, now(), now())`,
      [id, r.connection.id, phone, m.kind, m.kind === 'template' ? m.template : null, m.kind === 'template' ? m.language : null, JSON.stringify([{ status: 'sending', at: new Date().toISOString() }]),
        r.idempotencyKey ?? null, r.source.slice(0, 200), r.actionRunId ?? null, r.correlationId ?? null, r.notificationId ?? null, r.identity?.user.id ?? null],
    )
  } catch (e) {
    if (String((e as { code?: string }).code) === '23505' || /unique|duplicate/i.test(String((e as Error).message))) throw new OutboundError('in_progress', 'The same WhatsApp message (same idempotency key) is being sent right now.', true)
    throw e
  }
  try {
    const res = await graphRequest({ connection: r.connection, cache: r.cache, timeoutMs: r.timeoutMs, signal: r.signal }, 'POST', `/${st.phoneNumberId}/messages`, body)
    const out = res.body as { messages?: { id?: string; message_status?: string }[] } | null
    const providerId = out?.messages?.[0]?.id
    if (!providerId || typeof providerId !== 'string') throw new OutboundError('upstream', 'Meta accepted the request but returned no message id.', false)
    await r.db.exec(
      `UPDATE ${T('ab_whatsapp_messages')} SET status = 'accepted', provider_id = $2, history = history || $3::jsonb, modified_on = now() WHERE id = $1`,
      [id, providerId.slice(0, 200), JSON.stringify([{ status: 'accepted', at: new Date().toISOString() }])],
    )
    r.note?.({ providerMessageId: providerId.slice(0, 200) })
    return { messageId: id, providerMessageId: providerId, to: masked, status: 'accepted' }
  } catch (e) {
    const err = e instanceof OutboundError ? e : new OutboundError('internal', 'The message could not be sent.', true)
    // the key is released so a retry makes a new attempt; the failed attempt stays in the log
    await r.db.exec(
      `UPDATE ${T('ab_whatsapp_messages')} SET status = 'failed', idempotency_key = NULL, error_code = $2, error = $3, history = history || $4::jsonb, modified_on = now() WHERE id = $1`,
      [id, err.code, err.message.slice(0, 500), JSON.stringify([{ status: 'failed', at: new Date().toISOString(), error: err.message.slice(0, 300) }])],
    ).catch(() => {})
    throw err
  }
}

export async function messageById(db: SqlDb, id: string): Promise<MessageRow | null> {
  const r = await db.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_whatsapp_messages')} WHERE id = $1`, [id])
  return r[0] ? toMessage(r[0]) : null
}
