/**
 * Shared contracts of connector actions (P1 package D) and the flow runtime (P1 package A). Both packages import this
 * file; changes are additive only. Spec: docs/plan/p1-spec.md ("Connector actions"); design: docs/dev/connectors.md
 * ("Connector actions").
 *
 * Server rules: erasable TypeScript only (no enums), `import type` for types.
 */
import type { UserContext } from '../contracts.ts'

/* ------------------------------------------------------------------ JSON Schema (the subset actions use) */

/**
 * The JSON Schema subset understood by the validator (server/core/actions/schema.ts): type (one or a list), properties,
 * required, additionalProperties (boolean or schema), items, enum, const, minLength, maxLength, pattern, format
 * (email, uri, date, date-time), minimum, maximum, exclusiveMinimum, exclusiveMaximum, minItems, maxItems, default,
 * anyOf, title, description. Unknown keywords are ignored.
 */
export interface JsonSchema {
  type?: JsonType | JsonType[]
  title?: string
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean | JsonSchema
  items?: JsonSchema
  enum?: unknown[]
  const?: unknown
  minLength?: number
  maxLength?: number
  pattern?: string
  format?: 'email' | 'uri' | 'date' | 'date-time' | string
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  minItems?: number
  maxItems?: number
  default?: unknown
  anyOf?: JsonSchema[]
  /** UI hint for the "Test action" form: multi-line text, secret-looking input, ... */
  'x-ui'?: 'textarea' | 'json' | 'password'
  /** UI order of properties (otherwise insertion order) */
  'x-order'?: string[]
}
export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'

/* ------------------------------------------------------------------ actions */

/** one action of a connector kind (built in) or of one connection (custom actions, OpenAPI imports) */
export interface ActionDef {
  /** stable id, unique per connection: letters, digits, _ and - (e.g. `request`, `send`, `getOrder`) */
  id: string
  title: string
  description: string
  inputs: JsonSchema
  outputs: JsonSchema
  /** calling it twice with the same inputs has the same effect as once (GET, PUT of a whole resource, a lookup) */
  idempotent: boolean
  /** 'external': changes something outside Appbuilder (sends, creates, posts) */
  sideEffect: 'none' | 'external'
  /** default time limit of one call (a caller may lower it, never raise it above the connection's maximum) */
  timeoutMs: number
  /** where it comes from */
  origin?: 'builtin' | 'custom'
}

/** a connector kind that offers actions (the HTTP and Email connectors; table connectors offer none yet) */
export interface ActionKindInfo {
  kind: string
  label: string
  description: string
  /** the kind offers tables (rows through the table connector) as well */
  tables: boolean
  /** built-in actions (custom actions of a connection come on top) */
  actions: ActionDef[]
}

export type ActionErrorCode =
  | 'invalid_input'     // inputs do not fit the schema (never retried)
  | 'not_found'         // connection or action does not exist
  | 'denied'            // the identity may not do this (attachments, recipients)
  | 'blocked'           // outbound policy: host not on the allow-list, forbidden address, redirect refused
  | 'rate_limited'      // the connection's rate limit or an upstream 429 (retryable)
  | 'circuit_open'      // too many failures in a row: calls are refused for a while (retryable)
  | 'timeout'           // retryable
  | 'network'           // connect / TLS / reset (retryable)
  | 'upstream'          // the remote answered with an unexpected status (5xx retryable, 4xx not)
  | 'too_large'         // response or input above the caps
  | 'limit'             // a sending limit of the environment (email): retry later
  | 'in_progress'       // the same idempotency key is running right now (retryable)
  | 'not_configured'    // the connection is missing settings or secrets
  | 'unavailable'       // the server cannot do it now (email not set up, database down)
  | 'internal'

export interface ActionError {
  code: ActionErrorCode
  /** friendly, never contains a secret of the connection */
  message: string
  /** a later attempt may succeed (flows retry with backoff) */
  retryable: boolean
  /** the remote HTTP status, when there was one */
  status?: number
}

export type ActionResult =
  | { ok: true; output: unknown; runId?: string; durationMs?: number; replayed?: boolean }
  | { ok: false; error: ActionError; runId?: string; durationMs?: number }

export interface ActionRunOptions {
  /**
   * Required by flows for every side effect. For actions that are not idempotent and have an external side effect the
   * service stores key -> result for 24 hours: a second call with the same key returns the stored result (`replayed`)
   * instead of acting again.
   */
  idempotencyKey?: string
  correlationId?: string
  /** lower than the action's timeout to shorten it; never longer than the connection allows */
  timeoutMs?: number
  /** who called, for the activity log: `flow:<id>`, `event:<id>`, `test`, `report:<id>` */
  source?: string
  signal?: AbortSignal
}

/**
 * `services.actions` (server/core/actions/service.ts). `run` does not check "use" rights of the identity: a flow or event
 * may only reference a connection that a maker holding "use" attached (checked when the flow or event is saved, with
 * `assertCanUse`). The identity is what the action runs as (attachments it may read, the audit entry).
 */
export interface ActionsService {
  /** the action-capable kinds and their built-in actions */
  kinds(): ActionKindInfo[]
  /** a kind (`http`, `email`) -> its built-in actions; a connection id -> built-in + custom actions of that connection */
  list(kindOrConnectionId: string): Promise<ActionDef[]>
  describe(connectionId: string, actionId: string): Promise<ActionDef>
  run(env: string, connectionId: string, actionId: string, inputs: unknown, identity: UserContext | null, opts?: ActionRunOptions): Promise<ActionResult>
  /** the user may attach the connection to flows and events and test its actions */
  canUse(user: UserContext, connectionId: string): Promise<boolean>
  /** the user may change the connection's custom actions, see its activity, reset its circuit (administrators always) */
  canManage(user: UserContext, connectionId: string): Promise<boolean>
  /** 403 with a friendly message when canUse is false */
  assertCanUse(user: UserContext, connectionId: string): Promise<void>
  /** live state of the connection's protection: circuit breaker, calls in flight, rate budget */
  state(env: string, connectionId: string): ActionConnectionState
}

export interface ActionConnectionState {
  circuit: 'closed' | 'open' | 'half-open'
  /** failures in a row (resets on success) */
  failures: number
  /** when an open circuit lets one trial call through */
  retryAt: string | null
  inFlight: number
  maxConcurrent: number
  perMinute: number
  lastError: string | null
}

/* ------------------------------------------------------------------ inbound webhooks (package D route -> package A flows) */

/** what `POST /api/v1/hooks/:env/:flowId/:token` hands to the flow runtime after verification */
export interface VerifiedWebhookPayload {
  hookId: string
  flowId: string
  receivedOn: string
  /** the request's content type (lowercase, without parameters) */
  contentType: 'application/json' | 'application/x-www-form-urlencoded' | 'text/plain' | string
  /** parsed body: JSON value, form fields (name -> value, repeated names -> list), or text */
  body: unknown
  /** query string of the call (name -> value) */
  query: Record<string, string>
  /** a safe subset of headers (lowercase names): content-type, user-agent, x-request-id and other x-* except signatures */
  headers: Record<string, string>
  /** 'hmac-sha256' when the signature was required and checked, else 'token' (path token only) */
  verifiedBy: 'token' | 'hmac-sha256'
  /** hex SHA-256 of the raw body (dedupe on the flow side if wanted) */
  bodySha256: string
  /** idempotency key for the run: the X-Appbuilder-Delivery / Idempotency-Key header when sent, else the body hash + time */
  deliveryId: string
}

/**
 * What package A's flow runtime offers to the webhook route (services.flows). Optional members may be missing while
 * package A is in progress; the route then answers 503 (trigger) or allows makers only (canManage).
 */
export interface FlowWebhookTarget {
  /** enqueue a run of the flow; must be fast (the caller answers 202 right after) */
  triggerWebhook(env: string, flowId: string, payload: VerifiedWebhookPayload): Promise<{ runId?: string } | void>
  /** the flow exists, is enabled and has a webhook trigger */
  webhookFlow?(env: string, flowId: string): Promise<{ id: string; name: string; enabled: boolean; ownerId?: string } | null>
  /** the user may change the flow (and so its webhook) */
  canManage?(user: UserContext, flowId: string): Promise<boolean>
}
