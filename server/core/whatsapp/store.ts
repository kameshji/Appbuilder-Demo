/**
 * The WhatsApp tables of the current environment (ddl.ts): opt-ins with their full history, the message log, the 24-hour
 * service windows, people's notification choices and environment settings. Every function works in the environment of
 * the caller (currentEnvironment()).
 */
import type { SqlDb } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import { currentEnvironment } from '../env-context.ts'
import { rowUid } from '../util.ts'
import { OPTIN_SOURCES, type OptInSource } from './defs.ts'

const q = (id: string) => `"${id}"`
export const T = (t: string) => `${q(currentEnvironment().schema)}.${q(t)}`
const iso = (v: unknown): string => new Date(v as string).toISOString()
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/* ------------------------------------------------------------------ settings */

/** default STOP words (case-insensitive, whole message after trimming punctuation): English, Hindi and Hinglish */
export const DEFAULT_STOP_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPT OUT', 'OPTOUT', 'BAND', 'BAND KARO', 'बंद', 'बंद करो', 'बंद करें', 'रोकें', 'रोको']
/** default START words: the number opts in again (source "inbound keyword") */
export const DEFAULT_START_KEYWORDS = ['START', 'UNSTOP', 'SUBSCRIBE', 'शुरू', 'चालू']

export interface KeywordSettings { stop: string[]; start: string[] }
export interface NotificationMapping { enabled: boolean; connectionId: string; template: string; language: string; params: ('title' | 'body' | 'link')[] }

export function cleanKeywords(raw: unknown, def: string[]): string[] {
  if (!Array.isArray(raw)) return def
  const out = [...new Set(raw.filter((k): k is string => typeof k === 'string').map((k) => k.trim().replace(/\s+/g, ' ').toUpperCase()).filter((k) => k.length >= 1 && k.length <= 40))]
  return out.slice(0, 50)
}

/** the keyword a message matches (whole message, case-insensitive, surrounding punctuation ignored) */
export function matchKeyword(text: string, list: string[]): string | null {
  const t = text.normalize('NFC').trim().replace(/^[\s.!?,;:'"()-]+|[\s.!?,;:'"()।-]+$/gu, '').replace(/\s+/g, ' ').toUpperCase()
  if (!t || t.length > 60) return null
  return list.find((k) => k.normalize('NFC') === t) ?? null
}

export async function getSetting<T>(db: SqlDb, k: string): Promise<T | null> {
  const r = await db.query<{ v: T }>(`SELECT v FROM ${T('ab_whatsapp_settings')} WHERE k = $1`, [k])
  return r[0] ? r[0].v : null
}
export async function putSetting(db: SqlDb, k: string, v: unknown): Promise<void> {
  await db.exec(`INSERT INTO ${T('ab_whatsapp_settings')} (k, v) VALUES ($1, $2::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [k, JSON.stringify(v)])
}

export async function keywords(db: SqlDb): Promise<KeywordSettings> {
  const v = await getSetting<Record<string, unknown>>(db, 'keywords')
  return { stop: cleanKeywords(v?.stop, DEFAULT_STOP_KEYWORDS), start: cleanKeywords(v?.start, DEFAULT_START_KEYWORDS) }
}

export function parseMapping(raw: unknown): NotificationMapping | null {
  if (!isObj(raw)) return null
  const params = Array.isArray(raw.params) ? raw.params.filter((p): p is 'title' | 'body' | 'link' => p === 'title' || p === 'body' || p === 'link').slice(0, 3) : ['title', 'body'] as ('title' | 'body')[]
  if (typeof raw.connectionId !== 'string' || typeof raw.template !== 'string') return null
  return { enabled: raw.enabled !== false, connectionId: raw.connectionId, template: raw.template, language: typeof raw.language === 'string' ? raw.language : 'en', params }
}
export async function notificationMapping(db: SqlDb): Promise<NotificationMapping | null> {
  return parseMapping(await getSetting(db, 'notifications'))
}

/* ------------------------------------------------------------------ opt-ins */

export interface OptIn {
  phone: string
  status: 'opted_in' | 'opted_out'
  source: string
  evidence: string
  recordedBy: string | null
  recordedOn: string
  contactTable: string | null
  contactRow: string | null
}

const toOptIn = (r: Record<string, unknown>): OptIn => ({
  phone: String(r.phone), status: r.status === 'opted_in' ? 'opted_in' : 'opted_out', source: String(r.source), evidence: String(r.evidence),
  recordedBy: r.recorded_by ? String(r.recorded_by) : null, recordedOn: iso(r.recorded_on), contactTable: r.contact_table ? String(r.contact_table) : null, contactRow: r.contact_row ? String(r.contact_row) : null,
})

export async function getOptIn(db: SqlDb, phone: string): Promise<OptIn | null> {
  const r = await db.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_whatsapp_optins')} WHERE phone = $1`, [phone])
  return r[0] ? toOptIn(r[0]) : null
}

/** the enforcement point's question: is there a CURRENT opt-in for this number? */
export async function hasCurrentOptIn(db: SqlDb, phone: string): Promise<boolean> {
  const r = await db.query<{ status: string }>(`SELECT status FROM ${T('ab_whatsapp_optins')} WHERE phone = $1`, [phone])
  return r[0]?.status === 'opted_in'
}

export interface RecordInput {
  phone: string
  status: 'opted_in' | 'opted_out'
  source: OptInSource
  evidence: string
  by: string | null
  contactTable?: string | null
  contactRow?: string | null
  connectionId?: string | null
}

/** records a change: the current row is replaced, the history keeps every entry */
export async function recordOptIn(db: SqlDb, r: RecordInput): Promise<OptIn> {
  if (r.status !== 'opted_in' && r.status !== 'opted_out') throw new HttpError(422, 'invalid', 'The status is opted_in or opted_out.', 'status')
  if (!(OPTIN_SOURCES as readonly string[]).includes(r.source)) throw new HttpError(422, 'invalid', `The source is one of: ${OPTIN_SOURCES.join(', ')}.`, 'source')
  const evidence = String(r.evidence ?? '').trim().slice(0, 2000)
  if (evidence.length < 10) throw new HttpError(422, 'invalid', 'Describe the evidence (at least 10 characters): what the person agreed to, where and how.', 'evidence')
  const ct = r.contactTable ? String(r.contactTable).slice(0, 100) : null
  const cr = r.contactRow ? String(r.contactRow).slice(0, 100) : null
  const now = new Date()
  await db.tx(async (tx) => {
    await tx.exec(
      `INSERT INTO ${T('ab_whatsapp_optin_history')} (id, phone, status, source, evidence, recorded_by, recorded_on, contact_table, contact_row, connection_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [`woh_${rowUid().replace(/-/g, '').slice(-20)}`, r.phone, r.status, r.source, evidence, r.by, now, ct, cr, r.connectionId ?? null],
    )
    await tx.exec(
      `INSERT INTO ${T('ab_whatsapp_optins')} (phone, status, source, evidence, recorded_by, recorded_on, contact_table, contact_row) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (phone) DO UPDATE SET status = EXCLUDED.status, source = EXCLUDED.source, evidence = EXCLUDED.evidence, recorded_by = EXCLUDED.recorded_by, recorded_on = EXCLUDED.recorded_on,
         contact_table = COALESCE(EXCLUDED.contact_table, ${T('ab_whatsapp_optins')}.contact_table), contact_row = COALESCE(EXCLUDED.contact_row, ${T('ab_whatsapp_optins')}.contact_row)`,
      [r.phone, r.status, r.source, evidence, r.by, now, ct, cr],
    )
  })
  return (await getOptIn(db, r.phone))!
}

export async function listOptIns(db: SqlDb, o: { status?: string; search?: string; limit: number; offset: number }): Promise<{ items: OptIn[]; total: number }> {
  const where: string[] = []
  const params: unknown[] = []
  if (o.status === 'opted_in' || o.status === 'opted_out') {
    params.push(o.status)
    where.push(`status = $${params.length}`)
  }
  if (o.search) {
    params.push(`%${o.search.replace(/[^0-9]/g, '')}%`)
    where.push(`phone LIKE $${params.length}`)
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${T('ab_whatsapp_optins')} ${w}`, params))[0]?.n ?? 0
  params.push(Math.max(1, Math.min(500, o.limit)), Math.max(0, o.offset))
  const rows = await db.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_whatsapp_optins')} ${w} ORDER BY recorded_on DESC, phone LIMIT $${params.length - 1} OFFSET $${params.length}`, params)
  return { items: rows.map(toOptIn), total: Number(total) }
}

export async function optInHistory(db: SqlDb, phone: string): Promise<(OptIn & { id: string; connectionId: string | null })[]> {
  const rows = await db.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_whatsapp_optin_history')} WHERE phone = $1 ORDER BY recorded_on DESC, id DESC LIMIT 500`, [phone])
  return rows.map((r) => ({ ...toOptIn(r), id: String(r.id), connectionId: r.connection_id ? String(r.connection_id) : null }))
}

/* ------------------------------------------------------------------ 24-hour window */

export const WINDOW_MS = 24 * 3600_000

export async function noteInbound(db: SqlDb, connectionId: string, phone: string, at: Date): Promise<void> {
  await db.exec(
    `INSERT INTO ${T('ab_whatsapp_windows')} (connection_id, phone, last_inbound_on) VALUES ($1, $2, $3)
     ON CONFLICT (connection_id, phone) DO UPDATE SET last_inbound_on = GREATEST(${T('ab_whatsapp_windows')}.last_inbound_on, EXCLUDED.last_inbound_on)`,
    [connectionId, phone, at],
  )
}
export async function lastInbound(db: SqlDb, connectionId: string, phone: string): Promise<Date | null> {
  const r = await db.query<{ t: string }>(`SELECT last_inbound_on AS t FROM ${T('ab_whatsapp_windows')} WHERE connection_id = $1 AND phone = $2`, [connectionId, phone])
  return r[0] ? new Date(r[0].t) : null
}

/* ------------------------------------------------------------------ message log */

export interface MessageRow {
  id: string
  connectionId: string
  direction: 'out' | 'in'
  phone: string
  kind: string
  template: string | null
  language: string | null
  status: string
  history: { status: string; at: string; error?: string }[]
  providerId: string | null
  idempotencyKey: string | null
  source: string | null
  actionRunId: string | null
  correlationId: string | null
  notificationId: string | null
  userId: string | null
  errorCode: string | null
  error: string | null
  createdOn: string
  modifiedOn: string
}

export const toMessage = (r: Record<string, unknown>): MessageRow => ({
  id: String(r.id), connectionId: String(r.connection_id), direction: r.direction === 'in' ? 'in' : 'out', phone: String(r.phone), kind: String(r.kind),
  template: r.template ? String(r.template) : null, language: r.language ? String(r.language) : null, status: String(r.status), history: Array.isArray(r.history) ? (r.history as MessageRow['history']) : [],
  providerId: r.provider_id ? String(r.provider_id) : null, idempotencyKey: r.idempotency_key ? String(r.idempotency_key) : null, source: r.source ? String(r.source) : null,
  actionRunId: r.action_run_id ? String(r.action_run_id) : null, correlationId: r.correlation_id ? String(r.correlation_id) : null, notificationId: r.notification_id ? String(r.notification_id) : null,
  userId: r.user_id ? String(r.user_id) : null, errorCode: r.error_code ? String(r.error_code) : null, error: r.error ? String(r.error) : null, createdOn: iso(r.created_on), modifiedOn: iso(r.modified_on),
})

export async function messageByKey(db: SqlDb, connectionId: string, key: string): Promise<MessageRow | null> {
  const r = await db.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_whatsapp_messages')} WHERE connection_id = $1 AND idempotency_key = $2`, [connectionId, key])
  return r[0] ? toMessage(r[0]) : null
}

/** status order: a late "delivered" never replaces "read"; "failed" always wins */
const RANK: Record<string, number> = { sending: 0, accepted: 1, sent: 2, delivered: 3, read: 4, failed: 9 }

/** a status webhook: appends to the history, moves the status forward; returns whether a message matched */
export async function applyStatus(db: SqlDb, connectionId: string, providerId: string, status: string, at: Date, error?: { code: string; text: string }): Promise<boolean> {
  const rows = await db.query<Record<string, unknown>>(`SELECT id, status FROM ${T('ab_whatsapp_messages')} WHERE provider_id = $1 AND connection_id = $2 AND direction = 'out'`, [providerId, connectionId])
  if (!rows.length) return false
  for (const r of rows) {
    const cur = String(r.status)
    const forward = (RANK[status] ?? 0) > (RANK[cur] ?? 0)
    const entry = { status, at: at.toISOString(), ...(error ? { error: `${error.code}: ${error.text}`.slice(0, 300) } : {}) }
    const params: unknown[] = [r.id, JSON.stringify([entry])]
    const sets = ['history = history || $2::jsonb', 'modified_on = now()']
    if (forward) { params.push(status); sets.push(`status = $${params.length}`) }
    if (error) {
      params.push(error.code.slice(0, 40)); sets.push(`error_code = $${params.length}`)
      params.push(error.text.slice(0, 500)); sets.push(`error = $${params.length}`)
    }
    await db.exec(`UPDATE ${T('ab_whatsapp_messages')} SET ${sets.join(', ')} WHERE id = $1`, params)
  }
  return true
}

export async function listMessages(db: SqlDb, o: { phone?: string; status?: string; direction?: string; limit: number; before?: string }): Promise<MessageRow[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (o.phone) { params.push(o.phone); where.push(`phone = $${params.length}`) }
  if (o.status) { params.push(o.status); where.push(`status = $${params.length}`) }
  if (o.direction === 'in' || o.direction === 'out') { params.push(o.direction); where.push(`direction = $${params.length}`) }
  if (o.before && !Number.isNaN(Date.parse(o.before))) { params.push(new Date(o.before)); where.push(`created_on < $${params.length}`) }
  params.push(Math.max(1, Math.min(500, o.limit)))
  const rows = await db.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_whatsapp_messages')} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_on DESC, id DESC LIMIT $${params.length}`, params)
  return rows.map(toMessage)
}

/* ------------------------------------------------------------------ people's notification choices */

export async function prefsOf(db: SqlDb, userId: string): Promise<Record<string, boolean>> {
  const r = await db.query<{ kinds: Record<string, boolean> }>(`SELECT kinds FROM ${T('ab_whatsapp_prefs')} WHERE user_id = $1`, [userId])
  return isObj(r[0]?.kinds) ? r[0].kinds : {}
}
export async function savePrefs(db: SqlDb, userId: string, kinds: Record<string, boolean>): Promise<void> {
  await db.exec(`INSERT INTO ${T('ab_whatsapp_prefs')} (user_id, kinds, modified_on) VALUES ($1, $2::jsonb, now()) ON CONFLICT (user_id) DO UPDATE SET kinds = EXCLUDED.kinds, modified_on = EXCLUDED.modified_on`, [userId, JSON.stringify(kinds)])
}
