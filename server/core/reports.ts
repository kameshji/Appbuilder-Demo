/**
 * Scheduled reports (P1 package D, first version; PDF is Phase 2). A report subscription is a saved query (a table and a
 * Query v2 plan made by the builder: columns, filters, sort, group and totals) or a formula that returns a table, a
 * schedule, and recipients (users and teams). Each run is a `report.run` job in the environment's queue:
 *
 *  - run as the RECIPIENT (default): the data of every email is computed with that recipient's own rights (row and column
 *    security apply per person; someone who cannot read the table gets no email);
 *  - run as a SERVICE ACCOUNT (administrators only, audited, shown with a warning): one result for everybody.
 *
 * The email has an inline HTML table (first N rows), a CSV attachment (spreadsheet formula injection guarded) and a link
 * to the Reports page; an empty result is skipped or sent (choice). History: ab_report_runs (per recipient: sent,
 * skipped and why). A retried job does not send twice to a recipient it already reached (statuses kept per run).
 *
 * API (docs/dev/data-api.md "Scheduled reports"):
 *   GET /reports                    mine (owner), the ones I receive, all for administrators
 *   POST /reports                   create          PATCH /reports/:id   DELETE /reports/:id
 *   POST /reports/preview           { def } -> first rows as me (the builder's preview)
 *   POST /reports/:id/run           run now (job)   GET /reports/:id/runs   history
 */
import type { ApiRouter } from './router.ts'
import type { CoreServices } from './services.ts'
import type { Ctx, UserContext } from './contracts.ts'
import type { TableDef } from '../../src/platform/contracts.ts'
import type { QueryValue } from '../../src/platform/http.ts'
import type { QueryPlan } from '../../src/platform/query.ts'
import { HttpError } from './contracts.ts'
import { JobError } from './jobs.ts'
import { currentEnvironment, runInEnvironment } from './env-context.ts'
import { toUserDef } from './auth.ts'
import { identity } from './identity/index.ts'
import { suppressedAmong } from './actions/suppressions.ts'
import { csvExportText } from './values.ts'
import { checkTimeZone, parseCron, nextCron, describeCron } from './cron.ts'
import { evaluateFormula, eventEngine, newLimits } from './event-fx.ts'
import { userRecord } from '../../src/fx/rowrules.ts'
import { emailFrame, signToken, type DeliveryService } from './notifications-delivery.ts'
import { errText, log, rowUid } from './util.ts'

export const REPORT_JOB = 'report.run'
export const REPORT_MAX_RECIPIENTS = 200
export const REPORT_MAX_CSV_ROWS = 10_000
export const REPORT_MAX_INLINE_ROWS = 200

export type ReportSchedule =
  | { frequency: 'hourly'; minute: number; timeZone: string }
  | { frequency: 'daily' | 'weekdays'; time: string; timeZone: string }
  | { frequency: 'weekly'; time: string; weekday: number; timeZone: string }
  | { frequency: 'monthly'; time: string; day: number; timeZone: string }
  | { frequency: 'cron'; cron: string; timeZone: string }
  | { frequency: 'manual'; timeZone?: string }

export interface ReportDef {
  name: string
  description?: string
  source: { kind: 'table'; tableId: string; plan: QueryPlan; builder?: unknown } | { kind: 'formula'; formula: string }
  runAs: 'recipient' | { serviceAccount: string }
  schedule: ReportSchedule
  recipients: { userIds: string[]; teamIds: string[] }
  inlineRows: number
  csvRows: number
  onEmpty: 'skip' | 'send'
  /** P2-B: a PDF attached to every email: the automatic table layout of the report's rows, or a print template (query, formula or no source) generated as the recipient */
  pdf?: { mode: 'auto' } | { mode: 'template'; template: string }
  /** people who unsubscribed with the link in the email */
  optOut?: string[]
}

export interface ReportInfo {
  id: string
  name: string
  ownerId: string
  ownerName?: string
  enabled: boolean
  def: ReportDef
  createdOn: string
  modifiedOn: string
  scheduleText: string
  nextRunAt: string | null
  lastRun?: { id: string; startedOn: string; status: string; message: string | null } | null
  canEdit: boolean
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const q = (id: string) => `"${id}"`
const T = (t: string) => `${q(currentEnvironment().schema)}.${q(t)}`
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const invalid = (m: string, f?: string) => new HttpError(422, 'invalid', m, f)

export function scheduleCron(s: ReportSchedule): string | null {
  const hm = (t: string) => t.split(':').map(Number) as [number, number]
  switch (s.frequency) {
    case 'hourly': return `${s.minute} * * * *`
    case 'daily': { const [h, m] = hm(s.time); return `${m} ${h} * * *` }
    case 'weekdays': { const [h, m] = hm(s.time); return `${m} ${h} * * 1-5` }
    case 'weekly': { const [h, m] = hm(s.time); return `${m} ${h} * * ${s.weekday}` }
    case 'monthly': { const [h, m] = hm(s.time); return `${m} ${h} ${s.day} * *` }
    case 'cron': return s.cron
    default: return null
  }
}

export function parseSchedule(raw: unknown): ReportSchedule {
  const o = isObj(raw) ? raw : {}
  const tz = typeof o.timeZone === 'string' && o.timeZone ? o.timeZone : 'UTC'
  try {
    checkTimeZone(tz)
  } catch (e) {
    throw invalid((e as Error).message, 'schedule.timeZone')
  }
  const time = typeof o.time === 'string' && HHMM.test(o.time) ? o.time : '08:00'
  switch (o.frequency) {
    case 'hourly': {
      const m = Number(o.minute ?? 0)
      if (!Number.isInteger(m) || m < 0 || m > 59) throw invalid('The minute is 0 to 59.', 'schedule.minute')
      return { frequency: 'hourly', minute: m, timeZone: tz }
    }
    case undefined:
    case 'daily': return { frequency: 'daily', time, timeZone: tz }
    case 'weekdays': return { frequency: 'weekdays', time, timeZone: tz }
    case 'weekly': {
      const d = Number(o.weekday ?? 1)
      if (!Number.isInteger(d) || d < 0 || d > 6) throw invalid('The weekday is 0 (Sunday) to 6 (Saturday).', 'schedule.weekday')
      return { frequency: 'weekly', time, weekday: d, timeZone: tz }
    }
    case 'monthly': {
      const d = Number(o.day ?? 1)
      if (!Number.isInteger(d) || d < 1 || d > 28) throw invalid('The day of the month is 1 to 28.', 'schedule.day')
      return { frequency: 'monthly', time, day: d, timeZone: tz }
    }
    case 'cron': {
      const c = String(o.cron ?? '').trim()
      try {
        parseCron(c)
      } catch (e) {
        throw invalid((e as Error).message, 'schedule.cron')
      }
      return { frequency: 'cron', cron: c, timeZone: tz }
    }
    case 'manual': return { frequency: 'manual', timeZone: tz }
    default: throw invalid('The schedule is hourly, daily, weekdays, weekly, monthly, cron or manual.', 'schedule.frequency')
  }
}

/* ------------------------------------------------------------------ rendering */

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** RFC 4180 CSV with the spreadsheet formula injection guard on text cells */
export function toCsv(columns: { name: string; label: string }[], rows: Record<string, unknown>[]): string {
  const field = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const head = columns.map((c) => field(csvExportText(c.label))).join(',')
  const body = rows.map((r) => columns.map((c) => {
    const v = r[c.name]
    return field(typeof v === 'string' ? csvExportText(v) : v instanceof Date ? v.toISOString() : typeof v === 'object' && v !== null ? csvExportText(JSON.stringify(v)) : csvExportText(v as QueryValue))
  }).join(',')).join('\r\n')
  return '﻿' + head + '\r\n' + body + (rows.length ? '\r\n' : '')
}

export function htmlTable(columns: { name: string; label: string }[], rows: Record<string, unknown>[]): string {
  const th = columns.map((c) => `<th style="text-align:left;padding:6px 8px;border-bottom:2px solid #e2e8f0;font-size:12px;color:#475569">${esc(c.label)}</th>`).join('')
  const tr = rows.map((r, i) => `<tr style="background:${i % 2 ? '#f8fafc' : '#ffffff'}">${columns.map((c) => {
    const v = r[c.name]
    const num = typeof v === 'number'
    return `<td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:13px;${num ? 'text-align:right;font-variant-numeric:tabular-nums' : ''}">${esc(cellText(v))}</td>`
  }).join('')}</tr>`).join('')
  return `<table style="border-collapse:collapse;width:100%;margin:0 0 14px">${th ? `<thead><tr>${th}</tr></thead>` : ''}<tbody>${tr}</tbody></table>`
}

/* ------------------------------------------------------------------ the service */

export interface ReportResult { columns: { name: string; label: string }[]; rows: Record<string, unknown>[]; total: number; truncated: boolean }

export function createReports(services: CoreServices, delivery: DeliveryService) {
  const db = () => {
    const d = services.state.db
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }

  async function userCtx(userId: string): Promise<UserContext | null> {
    const u = await services.meta.users.get(userId)
    if (!u || u.status === 'disabled') return null
    const env = currentEnvironment().id
    const ok = (await services.environments.accessible(toUserDef(u))).some((e) => e.id === env)
    if (!ok) return null
    return services.security.forUser(toUserDef(u))
  }

  /** the data of a report as one identity */
  async function compute(def: ReportDef, who: UserContext, maxRows: number): Promise<ReportResult> {
    if (def.source.kind === 'table') {
      const t = await services.meta.tables.get(def.source.tableId)
      if (!t) throw new HttpError(404, 'not-found', 'The table of this report no longer exists.')
      const plan: QueryPlan = { ...def.source.plan, version: 2, table: t.name }
      const visible = who.visibleDef(t)
      const label = (n: string) => visible.columns.find((c) => c.name === n)?.displayName ?? n
      if (plan.aggregate) {
        const res = await services.data.queryV2(who, t, { ...plan, count: true })
        const rows = res.rows.slice(0, maxRows)
        const names = rows.length ? Object.keys(rows[0]) : [...plan.aggregate.groupBy, ...plan.aggregate.measures.map((m) => m.name)]
        return { columns: names.map((n) => ({ name: n, label: label(n) })), rows, total: res.count ?? res.rows.length, truncated: res.rows.length > maxRows }
      }
      const select = plan.select?.length ? plan.select : visible.columns.filter((c) => !c.system && c.type !== 'image' && c.type !== 'file').map((c) => c.name)
      const rows: Record<string, unknown>[] = []
      let cursor: string | undefined
      let total = 0
      for (let i = 0; i < 100 && rows.length < maxRows; i++) {
        const res = await services.data.queryV2(who, t, { ...plan, select, count: i === 0, page: { size: Math.min(500, maxRows - rows.length), ...(cursor ? { cursor } : {}) } })
        if (i === 0) total = res.count ?? 0
        rows.push(...res.rows)
        if (!res.nextCursor) break
        cursor = res.nextCursor
      }
      return { columns: select.map((n) => ({ name: n, label: label(n) })), rows, total: Math.max(total, rows.length), truncated: total > rows.length }
    }
    // a formula that returns a table, evaluated with the identity's rights (pushed-down reads only)
    const tables = await services.meta.tables.list()
    const o = await evaluateFormula({
      formula: def.source.formula, role: 'condition', record: {}, old: null, user: userRecord({ id: who.user.id, name: who.user.name, email: who.user.email }),
      tables, readAs: who, data: services.data, limits: newLimits(30_000, Math.max(maxRows, 5000), 20), engine: eventEngine(),
    })
    if (!o.ok) throw new HttpError(422, 'invalid', `The formula of this report failed: ${o.error}`)
    const v = o.value as unknown
    const list = Array.isArray(v) ? v : isObj(v) ? [v] : []
    const rows = list.filter(isObj).map((r) => {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(r)) if (!k.startsWith('__')) out[k] = x instanceof Date ? x.toISOString() : x
      return out
    })
    const names = [...new Set(rows.flatMap((r) => Object.keys(r)))]
    return { columns: names.map((n) => ({ name: n, label: n })), rows: rows.slice(0, maxRows), total: rows.length, truncated: rows.length > maxRows }
  }

  async function teamMembers(teamIds: string[]): Promise<string[]> {
    if (!teamIds.length) return []
    const rows = await db().query<{ user_id: string }>(
      `SELECT DISTINCT m.user_id FROM "ab"."team_members" m JOIN "ab"."teams" t ON t.id = m.team_id WHERE t.id = ANY($1::text[]) AND (t.environment_id IS NULL OR t.environment_id = $2)`,
      [teamIds, currentEnvironment().id],
    )
    return rows.map((r) => r.user_id)
  }

  const toInfo = async (r: Record<string, unknown>, viewer: UserContext | null): Promise<ReportInfo> => {
    const def = r.def as ReportDef
    const cron = scheduleCron(def.schedule)
    let next: string | null = null
    if (cron && r.enabled) next = nextCron(parseCron(cron), new Date(), def.schedule.timeZone ?? 'UTC')?.toISOString() ?? null
    const last = (await db().query<Record<string, unknown>>(`SELECT id, started_on, status, message FROM ${T('ab_report_runs')} WHERE report_id = $1 ORDER BY started_on DESC LIMIT 1`, [r.id]))[0]
    const owner = await services.meta.users.get(String(r.owner_id))
    return {
      id: String(r.id), name: String(r.name), ownerId: String(r.owner_id), ...(owner ? { ownerName: owner.name } : {}), enabled: !!r.enabled, def,
      createdOn: new Date(r.created_on as string).toISOString(), modifiedOn: new Date(r.modified_on as string).toISOString(),
      scheduleText: cron ? `${describeCron(cron)} (${def.schedule.timeZone ?? 'UTC'})` : 'only when run by hand', nextRunAt: next,
      lastRun: last ? { id: String(last.id), startedOn: new Date(last.started_on as string).toISOString(), status: String(last.status), message: last.message ? String(last.message) : null } : null,
      canEdit: !!viewer && (viewer.privileges.isAdmin || viewer.user.id === String(r.owner_id)),
    }
  }

  async function row(id: string): Promise<Record<string, unknown> | null> {
    return (await db().query<Record<string, unknown>>(`SELECT * FROM ${T('ab_report_subscriptions')} WHERE id = $1`, [id]))[0] ?? null
  }

  /** P2-B: the PDF option of a report */
  async function checkPdf(raw: unknown): Promise<{ pdf?: ReportDef['pdf'] }> {
    if (raw === undefined || raw === null || raw === false) return {}
    if (isObj(raw) && raw.mode === 'auto') return { pdf: { mode: 'auto' } }
    if (isObj(raw) && raw.mode === 'template' && typeof raw.template === 'string' && raw.template) {
      const print = services.print
      if (!print) throw invalid('Print templates are not available on this server.', 'pdf')
      const t = await print.get(raw.template, null)
      if (!t) throw invalid(`There is no print template "${raw.template}".`, 'pdf.template')
      if ((t.published ?? t.doc).source.kind === 'record') throw invalid('A report can attach a template with a query, a formula or no source; this one prints one record.', 'pdf.template')
      return { pdf: { mode: 'template', template: t.id } }
    }
    throw invalid('pdf is {mode: "auto"} or {mode: "template", template}.', 'pdf')
  }

  /** validates a definition for `who`; returns the cleaned definition */
  async function check(raw: unknown, who: UserContext, prev?: ReportDef): Promise<ReportDef> {
    const o = isObj(raw) ? raw : {}
    const name = String(o.name ?? prev?.name ?? '').trim().slice(0, 200)
    if (!name) throw invalid('A report needs a name.', 'name')
    const src = isObj(o.source) ? o.source : prev?.source
    let source: ReportDef['source']
    if (isObj(src) && src.kind === 'formula') {
      const f = String(src.formula ?? '').trim()
      if (!f || f.length > 4000) throw invalid('Write the formula that returns the table (at most 4,000 characters).', 'source.formula')
      source = { kind: 'formula', formula: f }
    } else if (isObj(src) && src.kind === 'table') {
      const t = await services.meta.tables.get(String(src.tableId ?? ''))
      if (!t) throw invalid('Choose a table.', 'source.tableId')
      if (!isObj(src.plan)) throw invalid('The report needs a query.', 'source.plan')
      const plan = { ...(src.plan as unknown as QueryPlan), version: 2 as const, table: t.name }
      delete (plan as Partial<QueryPlan>).page
      delete (plan as Partial<QueryPlan>).single
      if (JSON.stringify(plan).length > 64 * 1024) throw invalid('The query is too large.', 'source.plan')
      source = { kind: 'table', tableId: t.id, plan, ...(src.builder !== undefined ? { builder: src.builder } : {}) }
    } else throw invalid('Choose a table (with the builder) or write a formula.', 'source')
    let runAs: ReportDef['runAs'] = 'recipient'
    const ra = o.runAs ?? prev?.runAs
    if (isObj(ra) && typeof ra.serviceAccount === 'string') {
      if (!who.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only administrators can run a report as a service account.')
      const sa = await services.meta.users.get(ra.serviceAccount)
      if (!sa || toUserDef(sa).kind !== 'service' || sa.status === 'disabled') throw invalid('Choose an active service account.', 'runAs')
      runAs = { serviceAccount: sa.id }
    }
    const schedule = parseSchedule(o.schedule ?? prev?.schedule)
    const rec = isObj(o.recipients) ? o.recipients : prev?.recipients ?? { userIds: [who.user.id], teamIds: [] }
    const userIds = [...new Set((Array.isArray(rec.userIds) ? rec.userIds : []).map(String))].slice(0, REPORT_MAX_RECIPIENTS)
    const teamIds = [...new Set((Array.isArray(rec.teamIds) ? rec.teamIds : []).map(String))].slice(0, 50)
    if (!userIds.length && !teamIds.length) throw invalid('Add at least one recipient.', 'recipients')
    const canPick = who.privileges.isMaker || who.privileges.isAdmin
    if (!canPick && (teamIds.length || userIds.some((u) => u !== who.user.id))) throw new HttpError(403, 'denied', 'Only makers and administrators can send a report to other people; you can subscribe yourself.')
    for (const u of userIds) if (!(await services.meta.users.get(u))) throw invalid(`There is no user "${u}".`, 'recipients')
    const int = (v: unknown, d: number, min: number, max: number) => {
      const n = Number(v ?? d)
      return Number.isInteger(n) && n >= min && n <= max ? n : d
    }
    const def: ReportDef = {
      name, ...(typeof (o.description ?? prev?.description) === 'string' ? { description: String(o.description ?? prev?.description).slice(0, 1000) } : {}),
      source, runAs, schedule, recipients: { userIds, teamIds },
      inlineRows: int(o.inlineRows ?? prev?.inlineRows, 20, 0, REPORT_MAX_INLINE_ROWS), csvRows: int(o.csvRows ?? prev?.csvRows, 5000, 0, REPORT_MAX_CSV_ROWS),
      onEmpty: (o.onEmpty ?? prev?.onEmpty) === 'send' ? 'send' : 'skip',
      ...(await checkPdf(o.pdf === undefined ? prev?.pdf : o.pdf)),
      ...(prev?.optOut?.length ? { optOut: prev.optOut.filter((x) => userIds.includes(x) || teamIds.length > 0) } : {}),
    }
    // a dry run as the editor: the plan or formula must work (the editor must be able to read the table)
    await compute(def, who, 1)
    return def
  }

  async function syncSchedule(id: string, def: ReportDef, enabled: boolean, scheduleId: string | null): Promise<string | null> {
    const cron = scheduleCron(def.schedule)
    const sched = services.kernel.jobs.schedules
    if (!cron || !enabled) {
      if (scheduleId) await sched.remove(scheduleId).catch(() => {})
      return null
    }
    const input = { name: `Report: ${def.name}`.slice(0, 200), description: 'Scheduled report (Reports page)', cron, timeZone: def.schedule.timeZone ?? 'UTC', jobType: REPORT_JOB, payload: { reportId: id }, enabled: true, misfire: 'run_once' as const }
    if (scheduleId && (await sched.get(scheduleId))) return (await sched.update(scheduleId, input)).id
    return (await sched.create(input, null)).id
  }

  /* ---------------------------------------------------------------- the run */

  async function run(reportId: string, o: { jobId: string; trigger: string; only?: string[] }): Promise<{ runId: string; sent: number; skipped: number; failed: number }> {
    const r = await row(reportId)
    if (!r) throw new JobError('The report no longer exists.', { retry: false })
    const def = r.def as ReportDef
    const runId = `rrun_${o.jobId.replace(/-/g, '').slice(-24)}`
    const prior = (await db().query<{ recipients: { userId: string; status: string }[] | null }>(`SELECT recipients FROM ${T('ab_report_runs')} WHERE id = $1`, [runId]))[0]
    await db().exec(
      `INSERT INTO ${T('ab_report_runs')} (id, report_id, started_on, status, trigger, job_id, recipients) VALUES ($1, $2, now(), 'running', $3, $4, '[]'::jsonb) ON CONFLICT (id) DO UPDATE SET status = 'running'`,
      [runId, reportId, o.trigger, o.jobId],
    )
    const results: { userId: string; status: 'sent' | 'skipped' | 'failed'; rows?: number; mailId?: string; reason?: string }[] = []
    const already = new Map((prior?.recipients ?? []).filter((x) => x.status === 'sent').map((x) => [x.userId, x]))
    const mail = identity(services).mail
    if (!(await mail.configured())) {
      await db().exec(`UPDATE ${T('ab_report_runs')} SET status = 'failed', finished_on = now(), message = $2 WHERE id = $1`, [runId, 'Email is not set up on this server.'])
      throw new JobError('Email is not set up on this server.', { retry: false })
    }
    let ids = [...new Set([...def.recipients.userIds, ...(await teamMembers(def.recipients.teamIds))])].filter((x) => !(def.optOut ?? []).includes(x))
    if (o.only) ids = ids.filter((x) => o.only!.includes(x))
    ids = ids.slice(0, REPORT_MAX_RECIPIENTS)
    const brand = await delivery.brand()
    const env = currentEnvironment().id
    let shared: { who: UserContext; data: ReportResult } | null = null
    if (typeof def.runAs === 'object') {
      const who = await userCtx(def.runAs.serviceAccount)
      if (!who) throw new JobError('The service account of this report is missing, disabled or has no access to this environment.', { retry: false })
      shared = { who, data: await compute(def, who, Math.max(def.csvRows, def.inlineRows, 1)) }
    }
    for (const uid of ids) {
      const prev = already.get(uid)
      if (prev) {
        results.push(prev as (typeof results)[number])
        continue
      }
      const u = await services.meta.users.get(uid)
      if (!u || u.status === 'disabled' || !u.email) { results.push({ userId: uid, status: 'skipped', reason: 'The account is disabled or has no email address.' }); continue }
      if ((await suppressedAmong(db(), [u.email])).size) { results.push({ userId: uid, status: 'skipped', reason: 'The address is on the suppression list.' }); continue }
      try {
        let data: ReportResult
        if (shared) data = shared.data
        else {
          const who = await userCtx(uid)
          if (!who) { results.push({ userId: uid, status: 'skipped', reason: 'No access to this environment.' }); continue }
          try {
            data = await compute(def, who, Math.max(def.csvRows, def.inlineRows, 1))
          } catch (e) {
            const he = e instanceof HttpError ? e : null
            if (he && (he.status === 403 || he.status === 404)) { results.push({ userId: uid, status: 'skipped', reason: `This person cannot read the report's data: ${he.message}` }); continue }
            throw e
          }
        }
        if (!data.rows.length && def.onEmpty === 'skip') { results.push({ userId: uid, status: 'skipped', rows: 0, reason: 'No rows (the report skips empty results).' }); continue }
        const inline = data.rows.slice(0, def.inlineRows)
        const link = brand.publicUrl ? `${brand.publicUrl}/#u-reports` : ''
        const unsub = brand.publicUrl ? `${brand.publicUrl}/api/v1/notifications/unsubscribe?t=${signToken(delivery.key(), { u: uid, r: reportId, e: env })}` : ''
        const when = new Date().toISOString().slice(0, 16).replace('T', ' ')
        const countText = data.rows.length ? `${data.total} row${data.total === 1 ? '' : 's'}${inline.length < data.total ? `; the first ${inline.length} are shown below${def.csvRows ? ', all of them are in the attached CSV' : ''}` : ''}${data.truncated ? ` (the CSV holds the first ${data.rows.length})` : ''}.` : 'No rows this time.'
        const warn = shared ? `<p style="margin:0 0 12px;padding:8px 10px;border-radius:8px;background:#fef3c7;color:#92400e;font-size:12px">This report runs as a service account: everyone on the list gets the same data, whatever their own access.</p>` : ''
        const inner = `${def.description ? `<p style="margin:0 0 12px;color:#475569">${esc(def.description)}</p>` : ''}${warn}<p style="margin:0 0 12px;font-size:13px;color:#475569">${esc(countText)}</p>${inline.length ? htmlTable(data.columns, inline) : ''}${link ? `<p><a href="${esc(link)}" style="display:inline-block;padding:8px 14px;border-radius:8px;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;font-size:13px">Open Reports in ${esc(brand.installName)}</a></p>` : ''}`
        const footer = `You get this because you are on the recipient list of the report "${esc(def.name)}"${shared ? '' : ' (the data is what your own access allows)'}. ${unsub ? `<a href="${esc(unsub)}" style="color:#64748b">Unsubscribe from this report</a> (no sign-in needed).` : ''}`
        const html = emailFrame(brand, def.name, inner, footer)
        const text = [def.name, '', countText, '', data.columns.map((c) => c.label).join(' | '), ...inline.map((r2) => data.columns.map((c) => cellText(r2[c.name])).join(' | ')), '', ...(link ? [`Open: ${link}`] : []), ...(unsub ? [`Unsubscribe: ${unsub}`] : [])].join('\n')
        const csvRows = data.rows.slice(0, def.csvRows)
        const attachments = def.csvRows && data.rows.length ? [{ fileName: `${def.name.replace(/[^A-Za-z0-9 _-]+/g, '').trim().slice(0, 60) || 'report'}-${when.slice(0, 10)}.csv`, contentType: 'text/csv', content: Buffer.from(toCsv(data.columns, csvRows), 'utf8') }] : []
        if (def.pdf && services.print) {
          // P2-B: the PDF, as the same identity as the data of this email
          const who = shared ? shared.who : (await userCtx(uid))!
          const g = def.pdf.mode === 'template'
            ? await services.print.generate(def.pdf.template, undefined, who, { source: `report:${reportId}`, fixedIdentity: true })
            : await services.print.generate(null, undefined, who, { source: `report:${reportId}`, fixedIdentity: true, presetDoc: autoReportDoc(def, data), presetRows: data.rows.slice(0, Math.max(def.csvRows, def.inlineRows, 1)), presetName: def.name })
          attachments.push({ fileName: g.fileName, contentType: 'application/pdf', content: Buffer.from(g.bytes) })
        }
        const m = await mail.send({
          to: u.email, subject: `${brand.installName}: ${def.name} (${when.slice(0, 10)})`, text, html, attachments, template: 'report', userId: uid,
          ...(unsub ? { headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}),
        })
        results.push({ userId: uid, status: 'sent', rows: data.total, mailId: m.id })
      } catch (e) {
        results.push({ userId: uid, status: 'failed', reason: errText(e).slice(0, 300) })
      }
      await db().exec(`UPDATE ${T('ab_report_runs')} SET recipients = $2::jsonb WHERE id = $1`, [runId, JSON.stringify(results)])
    }
    const sent = results.filter((x) => x.status === 'sent').length
    const failed = results.filter((x) => x.status === 'failed').length
    const skipped = results.length - sent - failed
    const status = failed ? (sent ? 'partial' : 'failed') : 'succeeded'
    await db().exec(`UPDATE ${T('ab_report_runs')} SET status = $2, finished_on = now(), recipients = $3::jsonb, message = $4 WHERE id = $1`, [runId, status, JSON.stringify(results), `${sent} sent, ${skipped} skipped, ${failed} failed`])
    if (failed && !sent) throw new JobError(`The report failed for every recipient: ${results.find((x) => x.status === 'failed')?.reason ?? ''}`)
    return { runId, sent, skipped, failed }
  }

  services.kernel.jobs.register<{ reportId: string; trigger?: string; only?: string[] }>({
    type: REPORT_JOB,
    description: 'Runs a scheduled report and emails it to its recipients (Reports page).',
    parse(raw) {
      if (!isObj(raw) || typeof raw.reportId !== 'string') throw new JobError('malformed report job', { retry: false })
      return { reportId: raw.reportId, trigger: typeof raw.trigger === 'string' ? raw.trigger : 'schedule', ...(Array.isArray(raw.only) ? { only: raw.only.map(String) } : {}) }
    },
    maxAttempts: 3,
    concurrency: 2,
    timeoutMs: 10 * 60_000,
    async handler(p, ctx) {
      const r = await row(p.reportId)
      if (!r) return { skipped: 'The report no longer exists.' }
      if (!r.enabled && p.trigger === 'schedule') return { skipped: 'The report is paused.' }
      return run(p.reportId, { jobId: ctx.job.id, trigger: p.trigger ?? 'schedule', only: p.only })
    },
  })

  return {
    compute,
    check,
    run,
    async list(viewer: UserContext): Promise<ReportInfo[]> {
      const rows = await db().query<Record<string, unknown>>(`SELECT * FROM ${T('ab_report_subscriptions')} ORDER BY lower(name), id`)
      const out: ReportInfo[] = []
      const myTeams = new Set((await db().query<{ team_id: string }>(`SELECT team_id FROM "ab"."team_members" WHERE user_id = $1`, [viewer.user.id])).map((x) => x.team_id))
      for (const r of rows) {
        const def = r.def as ReportDef
        const mine = String(r.owner_id) === viewer.user.id
        const receive = def.recipients.userIds.includes(viewer.user.id) || def.recipients.teamIds.some((t) => myTeams.has(t))
        if (mine || receive || viewer.privileges.isAdmin) out.push(await toInfo(r, viewer))
      }
      return out
    },
    async get(id: string, viewer: UserContext | null): Promise<ReportInfo | null> {
      const r = await row(id)
      return r ? toInfo(r, viewer) : null
    },
    async create(raw: unknown, who: UserContext): Promise<ReportInfo> {
      const def = await check(raw, who)
      const id = `rpt_${rowUid().replace(/-/g, '').slice(-16)}`
      const enabled = !isObj(raw) || raw.enabled !== false
      await db().exec(`INSERT INTO ${T('ab_report_subscriptions')} (id, name, owner_id, def, enabled, created_on, modified_on) VALUES ($1, $2, $3, $4::jsonb, $5, now(), now())`, [id, def.name, who.user.id, JSON.stringify(def), enabled])
      const sid = await syncSchedule(id, def, enabled, null)
      await db().exec(`UPDATE ${T('ab_report_subscriptions')} SET schedule_id = $2 WHERE id = $1`, [id, sid])
      return (await this.get(id, who))!
    },
    async update(id: string, raw: unknown, who: UserContext): Promise<ReportInfo> {
      const r = await row(id)
      if (!r) throw new HttpError(404, 'not-found', 'Report not found.')
      if (!who.privileges.isAdmin && String(r.owner_id) !== who.user.id) throw new HttpError(403, 'denied', 'Only the owner and administrators can change this report.')
      const prev = r.def as ReportDef
      // keeping a service account set by an administrator needs an administrator again
      const def = await check({ ...(isObj(raw) ? raw : {}), runAs: isObj(raw) && raw.runAs !== undefined ? raw.runAs : prev.runAs }, who, prev)
      const enabled = isObj(raw) && typeof raw.enabled === 'boolean' ? raw.enabled : !!r.enabled
      const sid = await syncSchedule(id, def, enabled, r.schedule_id ? String(r.schedule_id) : null)
      await db().exec(`UPDATE ${T('ab_report_subscriptions')} SET name = $2, def = $3::jsonb, enabled = $4, schedule_id = $5, modified_on = now() WHERE id = $1`, [id, def.name, JSON.stringify(def), enabled, sid])
      return (await this.get(id, who))!
    },
    async remove(id: string, who: UserContext): Promise<void> {
      const r = await row(id)
      if (!r) throw new HttpError(404, 'not-found', 'Report not found.')
      if (!who.privileges.isAdmin && String(r.owner_id) !== who.user.id) throw new HttpError(403, 'denied', 'Only the owner and administrators can delete this report.')
      if (r.schedule_id) await services.kernel.jobs.schedules.remove(String(r.schedule_id)).catch(() => {})
      await db().exec(`DELETE FROM ${T('ab_report_subscriptions')} WHERE id = $1`, [id])
      await db().exec(`DELETE FROM ${T('ab_report_runs')} WHERE report_id = $1`, [id])
    },
    async runs(id: string): Promise<Record<string, unknown>[]> {
      const rows = await db().query<Record<string, unknown>>(`SELECT * FROM ${T('ab_report_runs')} WHERE report_id = $1 ORDER BY started_on DESC LIMIT 50`, [id])
      return rows.map((x) => ({ id: x.id, startedOn: new Date(x.started_on as string).toISOString(), finishedOn: x.finished_on ? new Date(x.finished_on as string).toISOString() : null, status: x.status, trigger: x.trigger, message: x.message, recipients: x.recipients }))
    },
    /** the unsubscribe link of a report email (no sign-in): adds the user to optOut */
    async unsubscribe(env: string, reportId: string, userId: string): Promise<{ name: string } | null> {
      return runInEnvironment(env, async () => {
        const r = await row(reportId)
        if (!r) return null
        const def = r.def as ReportDef
        const optOut = [...new Set([...(def.optOut ?? []), userId])]
        await db().exec(`UPDATE ${T('ab_report_subscriptions')} SET def = $2::jsonb WHERE id = $1`, [reportId, JSON.stringify({ ...def, optOut })])
        return { name: def.name }
      })
    },
  }
}

export type Reports = ReturnType<typeof createReports>

/** P2-B: the automatic PDF layout of a report: a title, the row count and the rows as a table (landscape beyond 6 columns) */
export function autoReportDoc(def: ReportDef, data: ReportResult): import('../../src/platform/print.ts').PrintTemplateDoc {
  const ident = (n: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : `'${n.replace(/'/g, "''")}'`)
  const numeric = (n: string) => data.rows.slice(0, 50).some((r) => typeof r[n] === 'number') && data.rows.slice(0, 50).every((r) => r[n] === null || r[n] === undefined || typeof r[n] === 'number')
  const cols = data.columns.slice(0, 14)
  const esc = (t: string) => t.replace(/[{}]/g, (c) => c + c)
  return {
    version: 1,
    page: { size: 'A4', orientation: cols.length > 6 ? 'landscape' : 'portrait', margins: { top: 14, right: 12, bottom: 14, left: 12 } },
    source: { kind: 'none' },
    styles: { fontSize: 9, color: '#1e293b', accent: '#4f46e5', headingColor: '#0f172a', tableStyle: 'zebra' },
    header: { blocks: [], letterhead: 'first' },
    footer: { blocks: [], pageNumbers: true, left: `${esc(def.name)} · {FormatDate(Now(), "dd-MM-yyyy HH:mm")}` },
    fileName: `${esc(def.name)} {FormatDate(Now(), "yyyy-MM-dd")}`,
    body: [
      { id: 'h', kind: 'heading', level: 1, text: esc(def.name) },
      ...(def.description ? [{ id: 'd', kind: 'text' as const, text: esc(def.description), color: '#475569' }] : []),
      { id: 'n', kind: 'text', text: `${data.total} row${data.total === 1 ? '' : 's'}${data.truncated ? ` (the first ${data.rows.length} are printed)` : ''}`, size: 8, color: '#64748b' },
      { id: 't', kind: 'table', rows: 'Rows', fontSize: cols.length > 8 ? 7 : 8, columns: cols.map((c) => ({ header: c.label, value: `ThisItem.${ident(c.name)}`, ...(numeric(c.name) ? { format: 'number' as const, align: 'right' as const } : {}) })) },
    ],
  }
}

export function reportRoutes(router: ApiRouter, services: CoreServices, reports: Reports): void {
  const audit = async (ctx: Ctx, action: string, details: unknown) => {
    try {
      await services.meta.audit({ userId: ctx.user?.user.id ?? null, action, details })
    } catch (e) {
      log('error', `audit write failed (${action}): ${errText(e)}`)
    }
  }
  const visible = async (ctx: Ctx, id: string) => {
    const list = await reports.list(ctx.user!)
    const r = list.find((x) => x.id === id)
    if (!r) throw new HttpError(404, 'not-found', 'Report not found.')
    return r
  }

  router.add('GET', '/reports', async (ctx) => ({ items: await reports.list(ctx.user!) }), { auth: 'user' })

  router.add('POST', '/reports/preview', async (ctx) => {
    const b = isObj(ctx.body) ? ctx.body : {}
    const def = await reports.check({ name: 'Preview', schedule: { frequency: 'manual' }, recipients: { userIds: [ctx.user!.user.id], teamIds: [] }, ...(isObj(b.def) ? b.def : b), runAs: 'recipient' }, ctx.user!)
    const r = await reports.compute(def, ctx.user!, 50)
    return { ...r, rows: r.rows.slice(0, 50) }
  }, { auth: 'user' })

  router.add('POST', '/reports', async (ctx) => {
    const r = await reports.create(ctx.body, ctx.user!)
    await audit(ctx, 'report.create', { id: r.id, name: r.name, runAs: r.def.runAs, recipients: r.def.recipients })
    if (typeof r.def.runAs === 'object') await audit(ctx, 'report.run_as_service', { id: r.id, serviceAccount: r.def.runAs.serviceAccount })
    return r
  }, { auth: 'user' })

  router.add('PATCH', '/reports/:id', async (ctx) => {
    const r = await reports.update(ctx.params.id, ctx.body, ctx.user!)
    await audit(ctx, 'report.update', { id: r.id, name: r.name, runAs: r.def.runAs, recipients: r.def.recipients, enabled: r.enabled })
    if (typeof r.def.runAs === 'object') await audit(ctx, 'report.run_as_service', { id: r.id, serviceAccount: r.def.runAs.serviceAccount })
    return r
  }, { auth: 'user' })

  router.add('DELETE', '/reports/:id', async (ctx) => {
    await reports.remove(ctx.params.id, ctx.user!)
    await audit(ctx, 'report.delete', { id: ctx.params.id })
    return { ok: true }
  }, { auth: 'user' })

  router.add('POST', '/reports/:id/run', async (ctx) => {
    const r = await visible(ctx, ctx.params.id)
    const me = ctx.user!
    // the owner and administrators run it for everybody; a recipient can ask for their own copy now
    const all = r.canEdit
    const job = await services.kernel.jobs.enqueue(REPORT_JOB, { reportId: r.id, trigger: 'manual', ...(all ? {} : { only: [me.user.id] }) }, { createdBy: me.user.id, correlationId: `report:${r.id}` })
    await audit(ctx, 'report.run', { id: r.id, forEveryone: all })
    return { jobId: job.id }
  }, { auth: 'user' })

  router.add('GET', '/reports/:id/runs', async (ctx) => {
    const r = await visible(ctx, ctx.params.id)
    const runs = await reports.runs(r.id)
    // recipients see only their own line
    if (!r.canEdit) for (const x of runs) x.recipients = Array.isArray(x.recipients) ? (x.recipients as { userId: string }[]).filter((y) => y.userId === ctx.user!.user.id) : []
    return { items: runs }
  }, { auth: 'user' })
}

export type { TableDef }
