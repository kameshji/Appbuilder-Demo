/**
 * Server calls of P1 package D: connector actions (kinds, actions, test runs, custom actions, OpenAPI import, access,
 * activity, state), notification channels and delivery log, notification policy, mail suppressions and scheduled
 * reports. Server mode only (callers check `mode === 'server'`).
 */
import { idCall } from './identityApi'

export interface JsonSchema {
  type?: string | string[]
  title?: string
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  default?: unknown
  format?: string
  anyOf?: JsonSchema[]
  additionalProperties?: boolean | JsonSchema
  'x-ui'?: string
  'x-order'?: string[]
  [k: string]: unknown
}

export interface ActionDef {
  id: string
  title: string
  description: string
  inputs: JsonSchema
  outputs: JsonSchema
  idempotent: boolean
  sideEffect: 'none' | 'external'
  timeoutMs: number
  origin?: 'builtin' | 'custom'
  http?: { method: string; path: string; params?: { name: string; in: string; input: string }[]; bodyFields?: string[]; bodyInput?: string; outputPath?: string; sample?: unknown; headers?: Record<string, string>; query?: Record<string, string> }
}
export type ActionResult = { ok: true; output: unknown; runId?: string; durationMs?: number; replayed?: boolean } | { ok: false; error: { code: string; message: string; retryable: boolean; status?: number }; runId?: string; durationMs?: number }
export interface Grant { principalKind: 'role' | 'user'; principalId: string; level: 'use' | 'manage'; grantedBy?: string | null; grantedOn?: string }
export interface ActivityItem { id: string; at: string; actionId: string; userId: string | null; source: string | null; status: string; errorCode: string | null; message: string | null; httpStatus: number | null; durationMs: number; replayed: boolean; details: Record<string, unknown> | null }
export interface ConnState { circuit: 'closed' | 'open' | 'half-open'; failures: number; retryAt: string | null; inFlight: number; maxConcurrent: number; perMinute: number; maxTimeoutMs?: number; lastError: string | null; secretParts?: string[] }
export interface OpenApiPreview { title: string; version: string; baseUrl: string | null; auth: Record<string, string> | null; warnings: string[]; actions: { id: string; title: string; method: string; path: string; sideEffect: string; exists: boolean }[]; applied: boolean; imported?: number }

const enc = encodeURIComponent

export const actionsApi = {
  kinds: () => idCall<{ items: { kind: string; label: string; description: string; tables: boolean; actions: ActionDef[] }[] }>('GET', '/actions/kinds'),
  usable: () => idCall<{ items: { id: string; name: string; connector: string; status: string; canManage: boolean }[] }>('GET', '/actions/connections'),
  list: (conn: string) => idCall<{ items: ActionDef[] }>('GET', `/connections/${enc(conn)}/actions`),
  test: (conn: string, action: string, inputs: unknown) => idCall<ActionResult>('POST', `/connections/${enc(conn)}/actions/${enc(action)}/test`, { inputs }),
  saveCustom: (conn: string, id: string, def: unknown) => idCall<ActionDef>('PUT', `/connections/${enc(conn)}/custom-actions/${enc(id)}`, def),
  removeCustom: (conn: string, id: string) => idCall<{ ok: true }>('DELETE', `/connections/${enc(conn)}/custom-actions/${enc(id)}`),
  openapi: (conn: string, text: string, o: { apply?: boolean; replace?: boolean; only?: string[] } = {}) => idCall<OpenApiPreview>('POST', `/connections/${enc(conn)}/custom-actions/openapi`, { text, ...o }),
  access: (conn: string) => idCall<{ items: Grant[] }>('GET', `/connections/${enc(conn)}/access`),
  setAccess: (conn: string, grants: Grant[]) => idCall<{ items: Grant[] }>('PUT', `/connections/${enc(conn)}/access`, { grants }),
  activity: (conn: string) => idCall<{ items: ActivityItem[]; all: boolean }>('GET', `/connections/${enc(conn)}/activity?limit=100`),
  state: (conn: string) => idCall<ConnState>('GET', `/connections/${enc(conn)}/state`),
  resetState: (conn: string) => idCall<ConnState>('POST', `/connections/${enc(conn)}/state/reset`),
}

/* ------------------------------------------------------------------ notifications */

export type EmailMode = 'off' | 'immediate' | 'digest'
export interface ChannelKind { kind: string; label: string; description: string; inApp: boolean; email: EmailMode; locked: boolean; inAppReason: string; emailReason: string }
export interface Channels { emailAvailable: boolean; email: string; kinds: ChannelKind[]; digest: { frequency: 'hourly' | 'daily'; time: string }; timeZone: string; quietEmail: boolean }
export interface DeliveryEntry { id: string; at: string; userId: string; kind: string; title: string; channel: string; status: string; reason: string; mailId: string | null }
export interface DeliveryPolicy { kinds: Record<string, { inApp?: boolean; email?: EmailMode; lock?: boolean }>; logoUrl: string; perRecipientPerHour: number; kindsKnown?: { kind: string; label: string }[] }

export const deliveryApi = {
  channels: () => idCall<Channels>('GET', '/notifications/channels'),
  log: () => idCall<{ items: DeliveryEntry[] }>('GET', '/notifications/deliveries?limit=50'),
  adminLog: (userId?: string) => idCall<{ items: DeliveryEntry[] }>('GET', `/admin/notifications/deliveries?limit=100${userId ? `&userId=${enc(userId)}` : ''}`),
  policy: () => idCall<DeliveryPolicy>('GET', '/admin/notifications/policy'),
  savePolicy: (p: DeliveryPolicy) => idCall<DeliveryPolicy>('PUT', '/admin/notifications/policy', p),
  suppressions: (search = '') => idCall<{ items: { address: string; reason: string; note: string | null; addedOn: string }[]; total: number }>('GET', `/admin/mail-suppressions?limit=200&search=${enc(search)}`),
  suppress: (address: string, note?: string) => idCall<{ ok: true }>('POST', '/admin/mail-suppressions', { address, note }),
  unsuppress: (address: string) => idCall<{ ok: true }>('DELETE', `/admin/mail-suppressions/${enc(address)}`),
}

/* ------------------------------------------------------------------ reports */

export interface ReportSchedule { frequency: 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'cron' | 'manual'; time?: string; minute?: number; weekday?: number; day?: number; cron?: string; timeZone?: string }
export interface ReportDef {
  name: string
  description?: string
  source: { kind: 'table'; tableId: string; plan: Record<string, unknown>; builder?: unknown } | { kind: 'formula'; formula: string }
  runAs: 'recipient' | { serviceAccount: string }
  schedule: ReportSchedule
  recipients: { userIds: string[]; teamIds: string[] }
  inlineRows: number
  csvRows: number
  onEmpty: 'skip' | 'send'
  /** P2-B: a PDF attached to every email (automatic table layout, or a print template) */
  pdf?: { mode: 'auto' } | { mode: 'template'; template: string } | null
}
export interface ReportInfo { id: string; name: string; ownerId: string; ownerName?: string; enabled: boolean; def: ReportDef; scheduleText: string; nextRunAt: string | null; lastRun?: { id: string; startedOn: string; status: string; message: string | null } | null; canEdit: boolean }
export interface ReportRun { id: string; startedOn: string; finishedOn: string | null; status: string; trigger: string; message: string | null; recipients: { userId: string; status: string; rows?: number; reason?: string }[] }

export const reportsApi = {
  list: () => idCall<{ items: ReportInfo[] }>('GET', '/reports'),
  preview: (def: Partial<ReportDef>) => idCall<{ columns: { name: string; label: string }[]; rows: Record<string, unknown>[]; total: number; truncated: boolean }>('POST', '/reports/preview', { def }),
  create: (def: Partial<ReportDef> & { enabled?: boolean }) => idCall<ReportInfo>('POST', '/reports', def),
  update: (id: string, def: Partial<ReportDef> & { enabled?: boolean }) => idCall<ReportInfo>('PATCH', `/reports/${enc(id)}`, def),
  remove: (id: string) => idCall<{ ok: true }>('DELETE', `/reports/${enc(id)}`),
  run: (id: string) => idCall<{ jobId: string }>('POST', `/reports/${enc(id)}/run`),
  runs: (id: string) => idCall<{ items: ReportRun[] }>('GET', `/reports/${enc(id)}/runs`),
}
