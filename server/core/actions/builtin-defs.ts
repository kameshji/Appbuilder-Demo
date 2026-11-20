/**
 * Definitions of the built-in actions (pure data: no Node imports), shared by the providers (http.ts, email.ts) and the
 * reference generator (scripts/docs/actions.ts, `npm run docs:gen`).
 */
import type { ActionDef, JsonSchema } from './contracts.ts'
import { WHATSAPP_ACTIONS } from '../whatsapp/defs.ts'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
export const MAX_ATTACHMENTS = 10
const MAX_RECIPIENTS = 50

const HTTP_OUTPUT: JsonSchema = {
  type: 'object',
  properties: {
    status: { type: 'integer', description: 'HTTP status code' },
    headers: { type: 'object', description: 'Response headers (lowercase names; cookies are not returned)' },
    body: { description: 'The answer: JSON as data, text as text, anything else base64' },
    url: { type: 'string', description: 'The address that answered (after redirects)' },
  },
}

export const REQUEST_ACTION: ActionDef = {
  id: 'request',
  title: 'Send an HTTP request',
  description: 'Calls the API of this connection: a path relative to the base URL (or a full address on an allowed host), with query, headers and a body. The connection adds its authentication.',
  inputs: {
    type: 'object',
    'x-order': ['method', 'path', 'pathParams', 'query', 'headers', 'bodyType', 'body', 'expectStatus'],
    properties: {
      method: { type: 'string', enum: [...METHODS], default: 'GET', title: 'Method' },
      path: { type: 'string', title: 'Path', description: 'For example /orders/{{id}} (placeholders come from Path values) or a full address on an allowed host.', default: '', maxLength: 2000 },
      pathParams: { type: 'object', title: 'Path values', description: 'Values for the {{placeholders}} of the path (each is URL-encoded).', additionalProperties: { type: ['string', 'number', 'boolean'] } },
      query: { type: 'object', title: 'Query', additionalProperties: { type: ['string', 'number', 'boolean', 'array'] } },
      headers: { type: 'object', title: 'Headers', additionalProperties: { type: ['string', 'number', 'boolean'] } },
      bodyType: { type: 'string', enum: ['none', 'json', 'text', 'form'], title: 'Body type', description: 'json (default for objects), text, or form (URL-encoded fields).' },
      body: { title: 'Body', 'x-ui': 'json' },
      expectStatus: { type: 'array', title: 'Expected status', items: { type: 'integer', minimum: 100, maximum: 599 }, description: 'Statuses that count as success (default: any 2xx).' },
    },
    additionalProperties: false,
  },
  outputs: HTTP_OUTPUT,
  idempotent: false,
  sideEffect: 'external',
  timeoutMs: 30_000,
  origin: 'builtin',
}

const addresses: JsonSchema = { anyOf: [{ type: 'string', format: 'email' }, { type: 'array', items: { type: 'string', format: 'email' }, maxItems: MAX_RECIPIENTS }] }

export const SEND_ACTION: ActionDef = {
  id: 'send',
  title: 'Send an email',
  description: 'Sends an email through the install\'s mail relay, with copies, a reply-to address and attachments. Suppressed addresses are skipped.',
  inputs: {
    type: 'object',
    'x-order': ['to', 'cc', 'bcc', 'subject', 'text', 'html', 'replyTo', 'attachments'],
    required: ['to', 'subject'],
    additionalProperties: false,
    properties: {
      to: { ...addresses, title: 'To', description: 'One address or a list.' },
      cc: { type: 'array', items: { type: 'string', format: 'email' }, maxItems: MAX_RECIPIENTS, title: 'Cc' },
      bcc: { type: 'array', items: { type: 'string', format: 'email' }, maxItems: MAX_RECIPIENTS, title: 'Bcc' },
      subject: { type: 'string', minLength: 1, maxLength: 300, title: 'Subject' },
      text: { type: 'string', maxLength: 200_000, title: 'Text', 'x-ui': 'textarea', description: 'Plain text body (made from the HTML when left out).' },
      html: { type: 'string', maxLength: 500_000, title: 'HTML', 'x-ui': 'textarea', description: 'Rich body; scripts, styles and event handlers are removed.' },
      body: { type: 'string', maxLength: 500_000, title: 'Body', 'x-ui': 'textarea', description: 'The flow step email sends this: HTML when it has tags, else text (used when text and html are absent).' },
      replyTo: { type: 'string', format: 'email', title: 'Reply-to' },
      attachments: {
        type: 'array', maxItems: MAX_ATTACHMENTS, title: 'Attachments',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            attachmentId: { type: 'string', maxLength: 100, description: 'A file in an attachment column (the run-as identity must be able to open it).' },
            fileToken: { type: 'string', maxLength: 40, description: 'A generated document (print templates): the token from GeneratePdf or the step document.generate.' },
            fileName: { type: 'string', maxLength: 150 },
            contentType: { type: 'string', maxLength: 100 },
            text: { type: 'string', description: 'Generated file content as text (for example CSV).' },
            base64: { type: 'string', description: 'Generated file content, base64.' },
          },
        },
      },
    },
  },
  outputs: {
    type: 'object',
    properties: {
      mailId: { type: 'string', description: 'The entry in the email delivery log' },
      recipients: { type: 'integer' },
      suppressed: { type: 'integer', description: 'Recipients left out because they are on the suppression list' },
    },
  },
  idempotent: false,
  sideEffect: 'external',
  timeoutMs: 30_000,
  origin: 'builtin',
}


export const BUILTIN_ACTIONS: { kind: string; label: string; actions: ActionDef[] }[] = [
  { kind: 'http', label: 'HTTP (REST API)', actions: [REQUEST_ACTION] },
  { kind: 'email', label: 'Email', actions: [SEND_ACTION] },
  // P2-E (server/core/whatsapp/defs.ts)
  { kind: 'whatsapp', label: 'WhatsApp', actions: WHATSAPP_ACTIONS },
]
