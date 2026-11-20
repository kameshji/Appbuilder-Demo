/**
 * The WhatsApp connector (kind `whatsapp`): Meta WhatsApp Business Cloud API through the connector actions framework
 * (actions/service.ts does validation, breaker, rate limit, idempotency keys, redaction and the activity log).
 *
 * Settings (non-secret): phoneNumberId, businessAccountId, apiVersion (default v21.0), defaultCountryCode (calling code
 * for numbers written without one; the form suggests 91), sendingEnabled (default true), inboundFlowId (optional: a flow
 * with a webhook trigger started for each inbound message), perMinute (default 60), maxConcurrent (default 4).
 * Secret (sealed, one JSON object): { accessToken, appSecret, verifyToken }. Never returned, logged or put in messages.
 * There is no base-address setting (graph.ts).
 */
import type { ConnectionRecord } from '../contracts.ts'
import type { ActionProvider, ProviderCall } from '../actions/service.ts'
import { OutboundError } from '../actions/outbound.ts'
import { API_VERSION, graphRequest, parseWhatsappSecret } from './graph.ts'
import { WHATSAPP_ACTIONS } from './defs.ts'
import { maskPhone, normalizePhone, PhoneError, validCountryCode } from './phone.ts'
import { getOptIn, recordOptIn } from './store.ts'
import { sendMessage, type TemplateMessage } from './send.ts'

const num = (v: string | undefined, def: number, min: number, max: number): number => {
  const n = Number(v)
  return v !== undefined && v !== '' && Number.isInteger(n) ? Math.max(min, Math.min(max, n)) : def
}

export function checkWhatsappSettings(st: Record<string, string>, secret: string | undefined): string[] {
  const out: string[] = []
  if (!/^\d{5,20}$/.test(st.phoneNumberId ?? '')) out.push('Enter the phone number id (digits, from WhatsApp Manager > API setup).')
  if (!/^\d{5,20}$/.test(st.businessAccountId ?? '')) out.push('Enter the WhatsApp Business account id (digits).')
  if (st.apiVersion && !API_VERSION.test(st.apiVersion)) out.push('The API version looks like v21.0.')
  if (!validCountryCode(st.defaultCountryCode)) out.push('Enter the default country calling code for numbers written without one (digits only, for example 91 for India).')
  if (st.sendingEnabled && !['true', 'false'].includes(st.sendingEnabled)) out.push('sendingEnabled must be true or false.')
  if (st.inboundFlowId && !/^[A-Za-z0-9_.:-]{1,100}$/.test(st.inboundFlowId)) out.push('The inbound flow id is not valid.')
  for (const k of ['perMinute', 'maxConcurrent']) if (st[k] && (!Number.isInteger(Number(st[k])) || Number(st[k]) < 1)) out.push(`${k} must be a whole number above 0.`)
  for (const k of Object.keys(st)) if (/url|base|host|endpoint/i.test(k)) out.push(`"${k}" is not a setting of WhatsApp connections: the address of Meta's API is fixed.`)
  if (secret) {
    let v: unknown
    try {
      v = JSON.parse(secret)
    } catch {
      v = null
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) out.push('The secret of a WhatsApp connection is a JSON object: { "accessToken", "appSecret", "verifyToken" }.')
    else {
      const o = v as Record<string, unknown>
      for (const k of Object.keys(o)) if (!['accessToken', 'appSecret', 'verifyToken'].includes(k)) out.push(`Unknown secret part "${k}" (use accessToken, appSecret, verifyToken).`)
      for (const k of ['accessToken', 'appSecret', 'verifyToken']) if (o[k] !== undefined && (typeof o[k] !== 'string' || /[\r\n]/.test(String(o[k])) || String(o[k]).length > 4000)) out.push(`The ${k} must be one line of text.`)
      if (typeof o.verifyToken === 'string' && o.verifyToken.length < 16) out.push('Choose a verify token of at least 16 characters (you enter the same one in Meta\'s webhook settings).')
    }
  }
  return out
}

function phoneOf(call: ProviderCall, raw: unknown): string {
  try {
    return normalizePhone(raw, call.connection.settings?.defaultCountryCode)
  } catch (e) {
    throw new OutboundError('invalid_input', e instanceof PhoneError ? e.message : 'The phone number is not valid.')
  }
}

const db = (call: { services: ProviderCall['services'] }) => {
  const d = call.services.state.db
  if (!d) throw new OutboundError('unavailable', 'The database is not available.', true)
  return d
}

interface GraphTemplate { name?: string; language?: string; status?: string; category?: string; id?: string; components?: { type?: string; format?: string; text?: string }[] }

const placeholders = (text: string | undefined) => new Set((text ?? '').match(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g) ?? []).size

/** reads every page of the account's templates (at most 10 pages of 100) */
export async function listTemplates(c: { connection: ConnectionRecord; cache: Map<string, unknown>; timeoutMs: number; signal?: AbortSignal }): Promise<{ name: string; language: string; status: string; category: string; bodyParams: number; headerParams: number }[]> {
  const waba = c.connection.settings?.businessAccountId
  if (!/^\d{5,20}$/.test(waba ?? '')) throw new OutboundError('not_configured', 'The WhatsApp connection has no business account id: an administrator sets it on the connection.')
  const out: { name: string; language: string; status: string; category: string; bodyParams: number; headerParams: number }[] = []
  let after: string | undefined
  for (let page = 0; page < 10; page++) {
    const res = await graphRequest(c, 'GET', `/${waba}/message_templates`, undefined, { fields: 'name,status,language,category,components', limit: '100', ...(after ? { after } : {}) })
    const b = (res.body ?? {}) as { data?: GraphTemplate[]; paging?: { cursors?: { after?: string }; next?: string } }
    for (const t of b.data ?? []) {
      const comp = t.components ?? []
      out.push({
        name: String(t.name ?? ''), language: String(t.language ?? ''), status: String(t.status ?? ''), category: String(t.category ?? ''),
        bodyParams: placeholders(comp.find((x) => x.type?.toUpperCase() === 'BODY')?.text),
        headerParams: placeholders(comp.find((x) => x.type?.toUpperCase() === 'HEADER' && (x.format ?? 'TEXT').toUpperCase() === 'TEXT')?.text),
      })
    }
    after = b.paging?.next ? b.paging?.cursors?.after : undefined
    if (!after) break
  }
  return out
}

export function createWhatsappProvider(): ActionProvider {
  return {
    kind: 'whatsapp',
    label: 'WhatsApp',
    description: 'Template messages and replies through Meta\'s WhatsApp Business Cloud API, only to numbers with a current opt-in.',
    tables: false,
    builtin: () => WHATSAPP_ACTIONS,
    checkSettings: checkWhatsappSettings,
    secrets(c) {
      const s = parseWhatsappSecret(c)
      return [s.accessToken, s.appSecret, s.verifyToken].filter((x): x is string => !!x)
    },
    limits(c) {
      const st = c.settings ?? {}
      return { perMinute: num(st.perMinute, 60, 1, 6000), maxConcurrent: num(st.maxConcurrent, 4, 1, 20), maxTimeoutMs: 30_000 }
    },
    async test({ connection, cache }) {
      const st = connection.settings ?? {}
      if (!parseWhatsappSecret(connection).accessToken) return { ok: false, message: 'Enter the access token (a system user token of the WhatsApp Business account).' }
      const res = await graphRequest({ connection, cache, timeoutMs: 15_000 }, 'GET', `/${st.phoneNumberId}`, undefined, { fields: 'display_phone_number,verified_name,quality_rating' })
      const b = (res.body ?? {}) as { display_phone_number?: string; verified_name?: string; quality_rating?: string }
      const sec = parseWhatsappSecret(connection)
      const missing = [!sec.appSecret && 'the app secret (needed to verify webhook calls)', !sec.verifyToken && 'the verify token (needed for the webhook handshake)'].filter(Boolean)
      return { ok: true, message: `Connected to ${b.verified_name ? `"${String(b.verified_name).slice(0, 80)}" ` : ''}${b.display_phone_number ? String(b.display_phone_number).slice(0, 30) : 'the WhatsApp number'}${b.quality_rating ? ` (quality ${String(b.quality_rating).slice(0, 10)})` : ''}.${missing.length ? ` Still missing: ${missing.join(' and ')}.` : ''}${st.sendingEnabled === 'false' ? ' Sending is turned off.' : ''}` }
    },
    async invoke(call) {
      const { inputs } = call
      const base = {
        db: db(call), connection: call.connection, identity: call.identity, idempotencyKey: call.idempotencyKey, source: call.source ?? 'action',
        actionRunId: call.runId, correlationId: call.correlationId, cache: call.cache, timeoutMs: call.timeoutMs, signal: call.signal, note: call.note,
      }
      switch (call.action.id) {
        case 'sendTemplate': {
          const m: TemplateMessage = {
            kind: 'template', template: String(inputs.template), language: String(inputs.language ?? 'en'),
            bodyParams: inputs.bodyParams as unknown[] | undefined, headerParams: inputs.headerParams as unknown[] | undefined,
            buttonParams: inputs.buttonParams as TemplateMessage['buttonParams'],
          }
          return sendMessage({ ...base, to: inputs.to, message: m })
        }
        case 'sendText':
          return sendMessage({ ...base, to: inputs.to, message: { kind: 'text', text: String(inputs.text), previewUrl: inputs.previewUrl === true } })
        case 'listTemplates': {
          const want = String(inputs.status ?? 'APPROVED')
          const name = typeof inputs.name === 'string' ? inputs.name.toLowerCase() : ''
          const all = await listTemplates(call)
          return { templates: all.filter((t) => (want === 'ANY' || t.status === want) && (!name || t.name.includes(name))) }
        }
        case 'checkOptIn': {
          const phone = phoneOf(call, inputs.to)
          const o = await getOptIn(db(call), phone)
          return { optedIn: o?.status === 'opted_in', status: o?.status ?? 'none', source: o?.source ?? '', recordedOn: o?.recordedOn ?? '', to: maskPhone(phone) }
        }
        case 'recordOptIn': {
          const phone = phoneOf(call, inputs.to)
          if (inputs.source === 'administrator') throw new OutboundError('invalid_input', 'The source "administrator" is only for administrators in the Admin console.')
          // P2 security re-check (finding P2-10): "inbound keyword" means the person wrote START or STOP to the number;
          // a flow claiming it would make a maker's record look like the person's own message
          if (inputs.source === 'inbound keyword') throw new OutboundError('invalid_input', 'The source "inbound keyword" is recorded only by the webhook, when the person writes the keyword to the WhatsApp number.')
          const o = await recordOptIn(db(call), {
            phone, status: inputs.status as 'opted_in' | 'opted_out', source: inputs.source as 'form', evidence: String(inputs.evidence ?? ''),
            by: call.identity ? call.identity.user.id : 'system', contactTable: inputs.contactTable as string | undefined, contactRow: inputs.contactRow as string | undefined, connectionId: call.connection.id,
          }).catch((e: Error) => { throw new OutboundError('invalid_input', e.message) })
          call.note({ to: maskPhone(phone), status: o.status })
          return { to: maskPhone(phone), status: o.status, recordedOn: o.recordedOn }
        }
        default:
          throw new OutboundError('not_found', `The WhatsApp connector has no action "${call.action.id}".`)
      }
    },
  }
}
