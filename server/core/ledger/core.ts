/**
 * Shared plumbing of the ledger and GST package (P3 package L): table names in the current environment, the key/value
 * settings, who may do what in Accounts, the audit writer, request-body readers, CSV.
 *
 * Access levels (docs/plan/ledgers-gst-spec.md section 2): 'view' reads everything in Accounts; 'post' also writes
 * drafts, issues documents and posts journals; 'admin' (the "Accounts admin role" of draft G9.10) also changes settings
 * and reference data, locks periods and posts into a soft-locked period. Environment administrators are 'admin'. Other
 * roles get a level in the `access` setting (role id -> level): the role model has no permissions of its own to add.
 */
import { HttpError } from '../contracts.ts'
import type { Ctx, SqlDb, UserContext } from '../contracts.ts'
import type { CoreServices } from '../services.ts'
import { currentEnvironment } from '../env-context.ts'
import { errText, log } from '../util.ts'
import { DecimalError } from '../gst/money.ts'
import { StopError, isDate } from '../gst/engine.ts'

export type Level = 'none' | 'view' | 'post' | 'admin'
export const LEVELS: Level[] = ['none', 'view', 'post', 'admin']
const RANK: Record<Level, number> = { none: 0, view: 1, post: 2, admin: 3 }

/** the sentence the settings page and the docs must show (never on customer-facing PDFs) */
export const DRAFT_NOTICE = 'The GST calculation rules in Accounts are a draft that has not yet been reviewed by a practising accountant. Check every figure with your accountant before you rely on it.'

export const T = (t: string): string => `"${currentEnvironment().schema}"."${t}"`

export function dbOf(s: CoreServices): SqlDb {
  const d = s.state.db
  if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
  return d
}

export const invalid = (message: string, field?: string) => new HttpError(422, 'invalid', message, field)
export const notFound = (what: string) => new HttpError(404, 'not-found', `${what} not found.`)
export const conflict = (message: string, field?: string) => new HttpError(409, 'conflict', message, field)

/** engine refusals (STOP cases, malformed decimals) become 422 with the rule number in the body */
export function asHttp(e: unknown): unknown {
  if (e instanceof StopError) return new HttpError(422, 'invalid', e.message, undefined, { stop: { rule: e.rule } })
  if (e instanceof DecimalError) return new HttpError(422, 'invalid', e.message)
  return e
}
export async function guarded<R>(fn: () => Promise<R>): Promise<R> {
  try { return await fn() } catch (e) { throw asHttp(e) }
}

/* ------------------------------------------------------------------ settings */

export async function getSetting<V>(db: SqlDb, k: string, fallback: V): Promise<V> {
  const r = await db.query<{ v: unknown }>(`SELECT v FROM ${T('ab_led_settings')} WHERE k = $1`, [k])
  return r.length ? (r[0].v as V) : fallback
}
export async function putSetting(db: SqlDb, k: string, v: unknown): Promise<void> {
  await db.exec(`INSERT INTO ${T('ab_led_settings')} (k, v) VALUES ($1, $2::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [k, JSON.stringify(v)])
}

/* ------------------------------------------------------------------ access */

export async function levelOf(s: CoreServices, user: UserContext): Promise<Level> {
  if (user.privileges.isAdmin) return 'admin'
  const access = await getSetting<Record<string, Level>>(dbOf(s), 'access', {})
  let best: Level = 'none'
  for (const r of user.roles) {
    const l = access[r.id]
    if (l && RANK[l] > RANK[best]) best = l
  }
  return best
}
/** the caller's level, at least `min` (403 otherwise; 'none' reads as "not available") */
export async function need(s: CoreServices, ctx: Ctx, min: Exclude<Level, 'none'>): Promise<Level> {
  const level = await levelOf(s, ctx.user!)
  if (RANK[level] < RANK[min]) {
    throw new HttpError(403, 'denied', level === 'none'
      ? 'Accounts is not available for your role. Ask an administrator for access.'
      : min === 'admin' ? 'Only an Accounts administrator can do this.' : 'Your role can read Accounts but not change it.')
  }
  return level
}

export async function audit(s: CoreServices, ctx: Ctx | { user?: UserContext }, action: string, details: unknown, rowId?: string): Promise<void> {
  try {
    await s.meta.audit({ userId: ctx.user?.user.id ?? null, action, rowId, details })
  } catch (e) {
    log('error', `audit write failed (${action}): ${errText(e)}`)
  }
}

/* ------------------------------------------------------------------ request bodies */

export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export function bodyOf(ctx: Ctx): Record<string, unknown> {
  if (!isObj(ctx.body)) throw invalid('Request body must be a JSON object.')
  return ctx.body
}
export const text = (v: unknown, max: number): string => (v === null || v === undefined ? '' : String(v)).trim().slice(0, max)
export function requiredText(v: unknown, max: number, what: string, field?: string): string {
  const t = text(v, max)
  if (!t) throw invalid(`${what} is required.`, field)
  return t
}
export function dateOf(v: unknown, what: string, field?: string): string {
  if (!isDate(v)) throw invalid(`${what} is a date written YYYY-MM-DD.`, field)
  return v
}
export const optionalDate = (v: unknown, what: string, field?: string): string | null => (v === null || v === undefined || v === '' ? null : dateOf(v, what, field))
export function oneOf<const V extends string>(v: unknown, values: readonly V[], what: string, field?: string): V {
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) throw invalid(`${what} is one of: ${values.join(', ')}.`, field)
  return v as V
}

/* ------------------------------------------------------------------ CSV */

const cell = (v: unknown): string => {
  let t = v === null || v === undefined ? '' : String(v)
  // a value that a spreadsheet would run as a formula is written as text
  if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = `'${t}`
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
}
export const toCsv = (columns: string[], rows: unknown[][]): string => [columns, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
export const csvResponse = (name: string, csv: string) => ({
  raw: true as const, status: 200,
  headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}.csv"`, 'Cache-Control': 'no-store' },
  body: '﻿' + csv,
})
