/**
 * Definitions of the WhatsApp connector's built-in actions (pure data: no Node imports). Used by the provider
 * (provider.ts), the flow designer (GET /actions/kinds) and the reference generator (builtin-defs.ts -> scripts/docs).
 */
import type { ActionDef, JsonSchema } from '../actions/contracts.ts'

export const TEMPLATE_NAME = '^[a-z0-9_]{1,512}$'
export const LANGUAGE_CODE = '^[a-z]{2,3}(_[A-Z]{2,4})?$'
export const OPTIN_SOURCES = ['form', 'import', 'inbound keyword', 'administrator'] as const
export type OptInSource = (typeof OPTIN_SOURCES)[number]

const to: JsonSchema = { type: ['string', 'number'], title: 'To', description: 'The customer\'s phone number. Without a country code the connection\'s default country code is used (for example 98765 43210 -> +91 98765 43210).' }
const param: JsonSchema = { anyOf: [{ type: 'string', maxLength: 1024 }, { type: 'number' }, { type: 'object' }] }
const params = (title: string, description: string): JsonSchema => ({ type: 'array', title, description, maxItems: 20, items: param })

const SENT: JsonSchema = {
  type: 'object',
  properties: {
    messageId: { type: 'string', description: 'The entry in the WhatsApp message log' },
    providerMessageId: { type: 'string', description: 'Meta\'s message id (wamid...)' },
    to: { type: 'string', description: 'The number, masked (country code and last three digits)' },
    status: { type: 'string', description: 'accepted (by Meta); later sent, delivered, read or failed in the message log' },
  },
}

export const SEND_TEMPLATE_ACTION: ActionDef = {
  id: 'sendTemplate',
  title: 'Send a template message',
  description: 'Sends an approved message template to a number that has a current opt-in. Refused, and nothing is sent, without an opt-in. Business-initiated messages outside the 24-hour window must be template messages.',
  inputs: {
    type: 'object',
    'x-order': ['to', 'template', 'language', 'bodyParams', 'headerParams', 'buttonParams'],
    required: ['to', 'template'],
    additionalProperties: false,
    properties: {
      to,
      template: { type: 'string', pattern: TEMPLATE_NAME, title: 'Template', description: 'The template\'s name as approved in WhatsApp Manager (lowercase letters, digits and _).' },
      language: { type: 'string', pattern: LANGUAGE_CODE, default: 'en', title: 'Language', description: 'The template\'s language code, for example en, en_US or hi.' },
      bodyParams: params('Body values', 'Values for {{1}}, {{2}} ... of the template body, in order (text or numbers).'),
      headerParams: params('Header values', 'Values for the template header, in order (text headers only).'),
      buttonParams: {
        type: 'array', title: 'Button values', maxItems: 10, description: 'Dynamic button parts: { index, subType: "url" | "quick_reply", value }.',
        items: {
          type: 'object', additionalProperties: false, required: ['index', 'value'],
          properties: { index: { type: 'integer', minimum: 0, maximum: 9 }, subType: { type: 'string', enum: ['url', 'quick_reply'], default: 'url' }, value: { type: ['string', 'number'] } },
        },
      },
    },
  },
  outputs: SENT,
  idempotent: false,
  sideEffect: 'external',
  timeoutMs: 30_000,
  origin: 'builtin',
}

export const SEND_TEXT_ACTION: ActionDef = {
  id: 'sendText',
  title: 'Reply with a text message',
  description: 'Sends a free-text reply. Only inside the 24-hour customer service window: the number must have written to this WhatsApp number in the last 24 hours (as recorded by this server from the webhook), and must have a current opt-in. Otherwise it is refused with the reason and nothing is sent.',
  inputs: {
    type: 'object',
    'x-order': ['to', 'text', 'previewUrl'],
    required: ['to', 'text'],
    additionalProperties: false,
    properties: {
      to,
      text: { type: 'string', minLength: 1, maxLength: 4096, title: 'Text', 'x-ui': 'textarea' },
      previewUrl: { type: 'boolean', default: false, title: 'Show link preview' },
    },
  },
  outputs: SENT,
  idempotent: false,
  sideEffect: 'external',
  timeoutMs: 30_000,
  origin: 'builtin',
}

export const LIST_TEMPLATES_ACTION: ActionDef = {
  id: 'listTemplates',
  title: 'List message templates',
  description: 'Reads the message templates of the WhatsApp Business account from Meta (name, language, status, category, number of body values).',
  inputs: {
    type: 'object',
    'x-order': ['status', 'name'],
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: ['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'ANY'], default: 'APPROVED', title: 'Status' },
      name: { type: 'string', maxLength: 512, title: 'Name contains' },
    },
  },
  outputs: {
    type: 'object',
    properties: { templates: { type: 'array', description: 'name, language, status, category, bodyParams (count), headerParams (count)' } },
  },
  idempotent: true,
  sideEffect: 'none',
  timeoutMs: 30_000,
  origin: 'builtin',
}

export const CHECK_OPTIN_ACTION: ActionDef = {
  id: 'checkOptIn',
  title: 'Check a number\'s opt-in',
  description: 'Whether a number has a current WhatsApp opt-in in this environment (status, source and when it was recorded).',
  inputs: { type: 'object', required: ['to'], additionalProperties: false, properties: { to } },
  outputs: {
    type: 'object',
    properties: {
      optedIn: { type: 'boolean' }, status: { type: 'string', description: 'opted_in, opted_out or none' }, source: { type: 'string' },
      recordedOn: { type: 'string', format: 'date-time' }, to: { type: 'string', description: 'The number, masked' },
    },
  },
  idempotent: true,
  sideEffect: 'none',
  timeoutMs: 10_000,
  origin: 'builtin',
}

export const RECORD_OPTIN_ACTION: ActionDef = {
  id: 'recordOptIn',
  title: 'Record an opt-in or opt-out',
  description: 'Records that a number opted in or out, with the source and evidence (for example the form and the consent text the person agreed to). The run-as identity and the time are recorded; the full history is kept. Your business is responsible for the consent being real.',
  inputs: {
    type: 'object',
    'x-order': ['to', 'status', 'source', 'evidence', 'contactTable', 'contactRow'],
    required: ['to', 'status', 'source', 'evidence'],
    additionalProperties: false,
    properties: {
      to,
      status: { type: 'string', enum: ['opted_in', 'opted_out'], title: 'Status' },
      source: { type: 'string', enum: ['form', 'import'], title: 'Source', description: 'Where the consent came from ("administrator" is only for administrators in the Admin console; "inbound keyword" only for the webhook, when the person writes START or STOP).' },
      evidence: { type: 'string', minLength: 10, maxLength: 2000, title: 'Evidence', 'x-ui': 'textarea', description: 'What the person agreed to and how, for example "Ticked \'Send me order updates on WhatsApp\' on the order form, order SO-1001".' },
      contactTable: { type: 'string', maxLength: 100, title: 'Contact table', description: 'Optional: the table of the person or contact row.' },
      contactRow: { type: 'string', maxLength: 100, title: 'Contact row', description: 'Optional: the row id.' },
    },
  },
  outputs: { type: 'object', properties: { to: { type: 'string', description: 'The number, masked' }, status: { type: 'string' }, recordedOn: { type: 'string', format: 'date-time' } } },
  idempotent: true,
  sideEffect: 'none',
  timeoutMs: 10_000,
  origin: 'builtin',
}

export const WHATSAPP_ACTIONS: ActionDef[] = [SEND_TEMPLATE_ACTION, SEND_TEXT_ACTION, LIST_TEMPLATES_ACTION, CHECK_OPTIN_ACTION, RECORD_OPTIN_ACTION]
