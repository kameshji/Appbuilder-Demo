/**
 * A fake of the parts of Meta's Graph API (WhatsApp Business Cloud API) that the WhatsApp connector calls, for tests and the
 * exit check (scripts/exit-check/p2-whatsapp.mjs). DEVELOPER TOOL, not used by the product.
 *
 * WHERE THE SHAPES COME FROM. Nothing here was recorded from a real Meta account: no account exists for this project. The
 * request and response shapes are modelled on Meta's public developer documentation of the Cloud API as the author knows
 * it (the "Messages" reference for template and text messages, the "Message templates" endpoint of the WhatsApp Business
 * account, the "Webhooks" payload examples for messages and statuses, and the "Error codes" page). Details that the
 * documentation leaves open are ASSUMPTIONS and are marked "assumed" below; docs/dev/whatsapp.md lists what must be
 * confirmed against a real account.
 *
 *   GET  /<version>/<phone number id>?fields=...            { display_phone_number, verified_name, quality_rating, id }
 *   POST /<version>/<phone number id>/messages              template or text message -> { messaging_product, contacts, messages: [{ id }] }
 *   GET  /<version>/<business account id>/message_templates { data: [{ name, language, status, category, id, components }], paging }
 *   errors                                                  { error: { message, type, code, error_subcode?, error_data?, fbtrace_id } }
 *
 * Builders for webhook payloads (statusEvent, inboundEvent) and Meta's signature (signMeta in webhook.ts) are here too.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'

export interface MockTemplate { name: string; language: string; status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED' | 'DISABLED'; category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION'; body: string; header?: string }

export interface MockSent { to: string; type: string; template?: { name: string; language: string; body: string[]; header: string[] }; text?: string; id: string; at: number }

export interface MockGraph {
  url: string
  /** every accepted message, in order */
  sent: MockSent[]
  /** every request (method, path, authorization present?) */
  requests: { method: string; path: string; auth: boolean; body: unknown }[]
  templates: MockTemplate[]
  /** the next N /messages calls fail with this answer (then normal again) */
  failNext(times: number, status: number, error: Record<string, unknown>, headers?: Record<string, string>): void
  close(): Promise<void>
}

export const MOCK_TOKEN = 'EAAG-fake-test-token-not-real-0000000000'
export const MOCK_APP_SECRET = 'fake-app-secret-for-tests-only-0000'
export const MOCK_VERIFY_TOKEN = 'fake-verify-token-for-tests-0000'
export const MOCK_PHONE_NUMBER_ID = '100000000000001'
export const MOCK_WABA_ID = '200000000000002'
/** the business number shown in webhooks (a fake number) */
export const MOCK_DISPLAY_NUMBER = '910000000001'

export const DEFAULT_TEMPLATES: MockTemplate[] = [
  { name: 'order_update', language: 'en', status: 'APPROVED', category: 'UTILITY', body: 'Hello {{1}}, your order {{2}} is {{3}}.' },
  { name: 'order_update', language: 'hi', status: 'APPROVED', category: 'UTILITY', body: 'नमस्ते {{1}}, आपका ऑर्डर {{2}} {{3}} है।' },
  { name: 'appbuilder_alert', language: 'en', status: 'APPROVED', category: 'UTILITY', body: 'Appbuilder: {{1}} - {{2}}' },
  { name: 'festival_offer', language: 'en', status: 'PENDING', category: 'MARKETING', body: 'Happy Diwali {{1}}! {{2}}% off this week.' },
  { name: 'old_promo', language: 'en', status: 'PAUSED', category: 'MARKETING', body: 'Old promotion' },
]

const placeholders = (t: string) => new Set(t.match(/\{\{\s*\d+\s*\}\}/g) ?? []).size
const fbtrace = () => `A${randomBytes(8).toString('hex')}`
/** documented shape: wamid. followed by a base64 string (the exact content is opaque; assumed) */
const wamid = () => `wamid.HBgM${randomBytes(18).toString('base64url')}`

export function graphError(code: number, message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { error: { message, type: code === 190 ? 'OAuthException' : 'OAuthException', code, ...extra, fbtrace_id: fbtrace() } }
}

export async function startMockGraph(o: { token?: string; phoneNumberId?: string; wabaId?: string; templates?: MockTemplate[] } = {}): Promise<MockGraph> {
  const token = o.token ?? MOCK_TOKEN
  const pnid = o.phoneNumberId ?? MOCK_PHONE_NUMBER_ID
  const waba = o.wabaId ?? MOCK_WABA_ID
  const templates = (o.templates ?? DEFAULT_TEMPLATES).map((t) => ({ ...t }))
  const sent: MockSent[] = []
  const requests: MockGraph['requests'] = []
  let failures: { times: number; status: number; body: Record<string, unknown>; headers: Record<string, string> } | null = null

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = null
      try { body = raw ? JSON.parse(raw) : null } catch { body = '<<not json>>' }
      const u = new URL(req.url ?? '/', 'http://x')
      const auth = String(req.headers.authorization ?? '')
      requests.push({ method: req.method ?? '', path: u.pathname, auth: !!auth, body })
      const json = (status: number, v: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=UTF-8', 'x-fb-trace-id': fbtrace(), ...headers })
        res.end(JSON.stringify(v))
      }
      const m = /^\/(v\d+\.\d+)\/([0-9]+)(\/[a-z_]+)?$/.exec(u.pathname)
      if (!m) return json(400, graphError(2500, 'Unknown path components'))
      if (auth !== `Bearer ${token}`) return json(401, graphError(190, 'Error validating access token: Session has expired.', { error_subcode: 463 }))
      const [, , id, sub] = m
      // the phone number itself (connection test)
      if (req.method === 'GET' && id === pnid && !sub) return json(200, { verified_name: 'Fake Test Business', display_phone_number: '+91 00000 00001', quality_rating: 'GREEN', id: pnid })
      // templates of the business account (pagination with cursors; assumed: `after` cursor = index)
      if (req.method === 'GET' && id === waba && sub === '/message_templates') {
        const limit = Math.max(1, Math.min(100, Number(u.searchParams.get('limit') ?? 25)))
        const start = Number(u.searchParams.get('after') ?? 0) || 0
        const page = templates.slice(start, start + limit)
        const data = page.map((t, i) => ({
          name: t.name, language: t.language, status: t.status, category: t.category, id: String(900000 + start + i),
          components: [...(t.header ? [{ type: 'HEADER', format: 'TEXT', text: t.header }] : []), { type: 'BODY', text: t.body }],
        }))
        const next = start + limit < templates.length
        return json(200, { data, paging: { cursors: { before: String(start), after: String(start + page.length) }, ...(next ? { next: `${u.origin}${u.pathname}?after=${start + page.length}` } : {}) } })
      }
      if (req.method === 'POST' && id === pnid && sub === '/messages') {
        if (failures && failures.times > 0) {
          failures.times--
          const f = failures
          if (!failures.times) failures = null
          return json(f.status, f.body, f.headers)
        }
        const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
        if (b.messaging_product !== 'whatsapp') return json(400, graphError(100, '(#100) The parameter messaging_product is required.'))
        const to = String(b.to ?? '')
        if (!/^\d{8,15}$/.test(to)) return json(400, graphError(100, '(#100) Invalid parameter', { error_data: { messaging_product: 'whatsapp', details: 'Invalid phone number' } }))
        if (b.type === 'template') {
          const t = (b.template ?? {}) as { name?: string; language?: { code?: string }; components?: { type: string; parameters?: { type: string; text?: string }[] }[] }
          const tpl = templates.find((x) => x.name === t.name && x.language === t.language?.code)
          if (!tpl) return json(404, graphError(132001, '(#132001) Template name does not exist in the translation', { error_data: { messaging_product: 'whatsapp', details: `template name (${t.name}) does not exist in ${t.language?.code}` } }))
          if (tpl.status === 'PAUSED') return json(400, graphError(132015, '(#132015) Template is paused'))
          if (tpl.status !== 'APPROVED') return json(404, graphError(132001, '(#132001) Template name does not exist in the translation'))
          const bodyParams = (t.components ?? []).find((c) => c.type === 'body')?.parameters ?? []
          const headerParams = (t.components ?? []).find((c) => c.type === 'header')?.parameters ?? []
          if (bodyParams.length !== placeholders(tpl.body)) return json(400, graphError(132000, '(#132000) Number of parameters does not match the expected number of params', { error_data: { messaging_product: 'whatsapp', details: `body: number of localizable_params (${bodyParams.length}) does not match the expected number of params (${placeholders(tpl.body)})` } }))
          const s: MockSent = { to, type: 'template', template: { name: tpl.name, language: tpl.language, body: bodyParams.map((p) => String(p.text ?? '')), header: headerParams.map((p) => String(p.text ?? '')) }, id: wamid(), at: Date.now() }
          sent.push(s)
          return json(200, { messaging_product: 'whatsapp', contacts: [{ input: to, wa_id: to }], messages: [{ id: s.id, message_status: 'accepted' }] })
        }
        if (b.type === 'text') {
          const t = (b.text ?? {}) as { body?: string }
          if (!t.body) return json(400, graphError(100, '(#100) The parameter text[\'body\'] is required.'))
          const s: MockSent = { to, type: 'text', text: t.body, id: wamid(), at: Date.now() }
          sent.push(s)
          return json(200, { messaging_product: 'whatsapp', contacts: [{ input: to, wa_id: to }], messages: [{ id: s.id }] })
        }
        return json(400, graphError(131051, '(#131051) Message type unknown'))
      }
      return json(400, graphError(100, `(#100) Unsupported ${req.method} request.`))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url, sent, requests, templates,
    failNext(times, status, error, headers = {}) { failures = { times, status, body: error, headers } },
    async close() {
      server.closeAllConnections?.()
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}

/* ------------------------------------------------------------------ webhook payloads (documented shapes) */

const envelope = (value: Record<string, unknown>, o: { wabaId?: string; phoneNumberId?: string } = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{
    id: o.wabaId ?? MOCK_WABA_ID,
    changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: MOCK_DISPLAY_NUMBER, phone_number_id: o.phoneNumberId ?? MOCK_PHONE_NUMBER_ID }, ...value } }],
  }],
})

/** a status update (sent / delivered / read / failed) for a message Meta accepted earlier */
export function statusEvent(messageId: string, status: 'sent' | 'delivered' | 'read' | 'failed', recipient: string, o: { at?: number; error?: { code: number; title: string; details?: string }; phoneNumberId?: string } = {}): Record<string, unknown> {
  const ts = String(Math.floor((o.at ?? Date.now()) / 1000))
  return envelope({
    statuses: [{
      id: messageId, status, timestamp: ts, recipient_id: recipient.replace(/^\+/, ''),
      // conversation and pricing objects as documented (values assumed)
      ...(status === 'sent' ? { conversation: { id: `conv_${randomBytes(6).toString('hex')}`, origin: { type: 'utility' } }, pricing: { billable: true, pricing_model: 'CBP', category: 'utility' } } : {}),
      ...(o.error ? { errors: [{ code: o.error.code, title: o.error.title, message: o.error.title, error_data: { details: o.error.details ?? o.error.title } }] } : {}),
    }],
  }, { phoneNumberId: o.phoneNumberId })
}

/** an inbound text message from a customer */
export function inboundEvent(from: string, text: string, o: { at?: number; name?: string; id?: string; phoneNumberId?: string; type?: 'text' | 'button' } = {}): Record<string, unknown> {
  const wa = from.replace(/^\+/, '')
  const ts = String(Math.floor((o.at ?? Date.now()) / 1000))
  const msg = o.type === 'button'
    ? { from: wa, id: o.id ?? wamid(), timestamp: ts, type: 'button', button: { text, payload: text } }
    : { from: wa, id: o.id ?? wamid(), timestamp: ts, type: 'text', text: { body: text } }
  return envelope({ contacts: [{ profile: { name: o.name ?? 'Test Customer' }, wa_id: wa }], messages: [msg] }, { phoneNumberId: o.phoneNumberId })
}
