/**
 * Scheduled email snapshots of a dashboard (P2-C second wave; docs/dev/dashboards.md "Snapshots"). The machinery and the
 * rules are the scheduled reports' (server/core/reports.ts): the same schedule shapes (parseSchedule / scheduleCron), an
 * ab_schedules row per enabled snapshot, one `dashboard.snapshot` job per run in the environment's queue, the same
 * recipient rules (users and teams, at most 200; people who are not makers or administrators may only subscribe
 * themselves; disabled accounts, addresses on the suppression list and people without access to the environment are
 * skipped), a run log per recipient, and a retried job does not send twice to a recipient it already reached.
 *
 * Every recipient gets the dashboard computed AS THAT RECIPIENT (computeDashboard: the server compiles the stored tiles
 * and runs them with the recipient's row and column security), drawn into a PDF (render.ts: the dashboards' charts as
 * vectors through the print engine's SVG path) and attached to the email. A recipient who cannot open the dashboard
 * gets nothing and the run log says so. There is no "run as a service account" for snapshots.
 *
 *   GET    /dashboards/:id/snapshots            the snapshots of a dashboard I own or receive (all of them: its editors)
 *   POST   /dashboards/:id/snapshots            { name?, schedule, recipients?, range?, filters?, enabled? }
 *   PATCH  /dashboards/snapshots/:sid           the snapshot's owner or an administrator
 *   DELETE /dashboards/snapshots/:sid
 *   POST   /dashboards/snapshots/:sid/run       run now (owner / administrator: everyone; a recipient: their own copy)
 *   GET    /dashboards/snapshots/:sid/runs      history (recipients see their own line)
 *   GET|POST /dashboards/snapshots/unsubscribe  the signed link of the email (no sign-in)
 */
import { createHmac } from 'node:crypto'
import type { ApiRouter } from '../router.ts'
import type { CoreServices } from '../services.ts'
import type { Ctx, SqlDb, UserContext } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import { JobError } from '../jobs.ts'
import { currentEnvironment, runInEnvironment } from '../env-context.ts'
import { identity } from '../identity/index.ts'
import { suppressedAmong } from '../actions/suppressions.ts'
import { describeCron, nextCron, parseCron } from '../cron.ts'
import { parseSchedule, scheduleCron, REPORT_MAX_RECIPIENTS, type ReportSchedule } from '../reports.ts'
import { emailFrame, signToken, signingKey, verifyToken } from '../notifications-delivery.ts'
import { errText, log, rowUid } from '../util.ts'
import { RANGE_PRESETS, rangeLabel, localNow } from '../../../src/dashboards/dates.ts'
import type { RangePreset } from '../../../src/dashboards/dates.ts'
import { canEdit, canView, checkChoices, computeDashboard, dashboardRow, loadSettings, type DashboardRow } from './compute.ts'
import { identityIn } from './tokens.ts'
import { renderSnapshotPdf } from './render.ts'

export const SNAPSHOT_JOB = 'dashboard.snapshot'

export interface SnapshotDef {
  name: string
  schedule: ReportSchedule
  recipients: { userIds: string[]; teamIds: string[] }
  /** the date range preset of the snapshot (default: the dashboard's own) */
  range?: RangePreset
  /** dashboard filter id -> value */
  filters?: Record<string, string>
  /** people who unsubscribed with the link in the email */
  optOut?: string[]
}

export interface SnapshotInfo {
  id: string
  dashboardId: string
  name: string
  ownerId: string
  enabled: boolean
  def: SnapshotDef
  scheduleText: string
  nextRunAt: string | null
  lastRun: { id: string; startedOn: string; status: string; message: string | null } | null
  createdOn: string
  modifiedOn: string
  canEdit: boolean
}

type Row = Record<string, unknown>
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const T = (t: string) => `"${currentEnvironment().schema}"."${t}"`
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const invalid = (m: string, f?: string) => new HttpError(422, 'invalid', m, f)

/** the unsubscribe links of snapshots are signed with their own key (they never verify as another kind of link) */
const snapshotKey = (services: CoreServices): Buffer => createHmac('sha256', signingKey(services)).update('appbuilder.dashboard-snapshot.v1').digest()

/** snapshots of a dashboard go with it (dashboard delete, solution removal): rows, their schedules and runs */
export async function removeDashboardSnapshots(services: CoreServices, db: SqlDb, dashboardId: string): Promise<number> {
  const rows = await db.query<Row>(`SELECT id, schedule_id FROM ${T('ab_dashboard_snapshots')} WHERE dashboard_id = $1`, [dashboardId])
  for (const r of rows) if (r.schedule_id) await services.kernel.jobs.schedules.remove(String(r.schedule_id)).catch(() => {})
  if (rows.length) {
    await db.exec(`DELETE FROM ${T('ab_dashboard_snapshot_runs')} WHERE snapshot_id = ANY($1::text[])`, [rows.map((r) => String(r.id))])
    await db.exec(`DELETE FROM ${T('ab_dashboard_snapshots')} WHERE dashboard_id = $1`, [dashboardId])
  }
  return rows.length
}

export function createSnapshots(services: CoreServices) {
  const db = () => {
    const d = services.state.db
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }

  async function teamMembers(teamIds: string[]): Promise<string[]> {
    if (!teamIds.length) return []
    const rows = await db().query<{ user_id: string }>(
      `SELECT DISTINCT m.user_id FROM "ab"."team_members" m JOIN "ab"."teams" t ON t.id = m.team_id WHERE t.id = ANY($1::text[]) AND (t.environment_id IS NULL OR t.environment_id = $2)`,
      [teamIds, currentEnvironment().id],
    )
    return rows.map((r) => r.user_id)
  }

  async function row(id: string): Promise<Row | null> {
    return (await db().query<Row>(`SELECT * FROM ${T('ab_dashboard_snapshots')} WHERE id = $1`, [id]))[0] ?? null
  }

  async function toInfo(r: Row, viewer: UserContext | null): Promise<SnapshotInfo> {
    const def = r.def as SnapshotDef
    const cron = scheduleCron(def.schedule)
    const next = cron && r.enabled ? nextCron(parseCron(cron), new Date(), def.schedule.timeZone ?? 'UTC')?.toISOString() ?? null : null
    const last = (await db().query<Row>(`SELECT id, started_on, status, message FROM ${T('ab_dashboard_snapshot_runs')} WHERE snapshot_id = $1 ORDER BY started_on DESC LIMIT 1`, [r.id]))[0]
    return {
      id: String(r.id), dashboardId: String(r.dashboard_id), name: String(r.name), ownerId: String(r.owner_id), enabled: !!r.enabled, def,
      scheduleText: cron ? `${describeCron(cron)} (${def.schedule.timeZone ?? 'UTC'})` : 'only when run by hand', nextRunAt: next,
      lastRun: last ? { id: String(last.id), startedOn: new Date(last.started_on as string).toISOString(), status: String(last.status), message: last.message ? String(last.message) : null } : null,
      createdOn: new Date(r.created_on as string).toISOString(), modifiedOn: new Date(r.modified_on as string).toISOString(),
      canEdit: !!viewer && (viewer.privileges.isAdmin || viewer.user.id === String(r.owner_id)),
    }
  }

  /** validates a definition for `who` (the dashboard must be one they can open) */
  async function check(raw: unknown, who: UserContext, dash: DashboardRow, prev?: SnapshotDef): Promise<SnapshotDef> {
    const o = isObj(raw) ? raw : {}
    const name = String(o.name ?? prev?.name ?? dash.name).trim().slice(0, 200)
    if (!name) throw invalid('A snapshot needs a name.', 'name')
    const schedule = parseSchedule(o.schedule ?? prev?.schedule)
    // P2 security re-check (finding P2-8): a snapshot (a PDF per recipient) runs at most once an hour; any person who can
    // open a dashboard may subscribe themselves, and a cron of every minute made each of them a steady load of PDFs and mail
    const cronText = scheduleCron(schedule)
    if (cronText && parseCron(cronText).minutes.size > 1) throw invalid('A snapshot runs at most once an hour: choose one minute of the hour.', 'schedule')
    const rec = isObj(o.recipients) ? o.recipients : prev?.recipients ?? { userIds: [who.user.id], teamIds: [] }
    const userIds = [...new Set((Array.isArray(rec.userIds) ? rec.userIds : []).map(String))].slice(0, REPORT_MAX_RECIPIENTS)
    const teamIds = [...new Set((Array.isArray(rec.teamIds) ? rec.teamIds : []).map(String))].slice(0, 50)
    if (!userIds.length && !teamIds.length) throw invalid('Add at least one recipient.', 'recipients')
    const canPick = who.privileges.isMaker || who.privileges.isAdmin
    if (!canPick && (teamIds.length || userIds.some((u) => u !== who.user.id))) throw new HttpError(403, 'denied', 'Only makers and administrators can send a snapshot to other people; you can subscribe yourself.')
    for (const u of userIds) if (!(await services.meta.users.get(u))) throw invalid(`There is no user "${u.slice(0, 64)}".`, 'recipients')
    const rangeRaw = o.range !== undefined ? o.range : prev?.range
    let range: RangePreset | undefined
    if (rangeRaw !== undefined && rangeRaw !== null && rangeRaw !== '') {
      if (!RANGE_PRESETS.some((p) => p.key === rangeRaw)) throw invalid(`Unknown date range "${String(rangeRaw).slice(0, 40)}".`, 'range')
      range = rangeRaw as RangePreset
    }
    const filtersRaw = o.filters !== undefined ? o.filters : prev?.filters
    const settings = await loadSettings(db())
    // the same checks as a viewer's choices: only the dashboard's own filters and their values
    const choices = checkChoices(dash.def, { ...(range ? { range } : {}), ...(filtersRaw !== undefined ? { filters: filtersRaw } : {}) }, settings)
    const def: SnapshotDef = {
      name, schedule, recipients: { userIds, teamIds },
      ...(range ? { range } : {}),
      ...(Object.keys(choices.filters).length ? { filters: choices.filters } : {}),
      ...(prev?.optOut?.length ? { optOut: prev.optOut.filter((x) => userIds.includes(x) || teamIds.length > 0) } : {}),
    }
    return def
  }

  async function syncSchedule(id: string, def: SnapshotDef, enabled: boolean, scheduleId: string | null): Promise<string | null> {
    const cron = scheduleCron(def.schedule)
    const sched = services.kernel.jobs.schedules
    if (!cron || !enabled) {
      if (scheduleId) await sched.remove(scheduleId).catch(() => {})
      return null
    }
    const input = { name: `Dashboard snapshot: ${def.name}`.slice(0, 200), description: 'Scheduled dashboard snapshot (Dashboards page)', cron, timeZone: def.schedule.timeZone ?? 'UTC', jobType: SNAPSHOT_JOB, payload: { snapshotId: id }, enabled: true, misfire: 'run_once' as const }
    if (scheduleId && (await sched.get(scheduleId))) return (await sched.update(scheduleId, input)).id
    return (await sched.create(input, null)).id
  }

  /* ---------------------------------------------------------------- the run */

  async function run(snapshotId: string, o: { jobId: string; trigger: string; only?: string[]; createdOn?: Date }): Promise<{ runId: string; sent: number; skipped: number; failed: number }> {
    const r = await row(snapshotId)
    if (!r) throw new JobError('The snapshot no longer exists.', { retry: false })
    const def = r.def as SnapshotDef
    const runId = `dsr_${o.jobId.replace(/-/g, '').slice(-24)}`
    const prior = (await db().query<{ recipients: { userId: string; status: string }[] | null }>(`SELECT recipients FROM ${T('ab_dashboard_snapshot_runs')} WHERE id = $1`, [runId]))[0]
    await db().exec(
      `INSERT INTO ${T('ab_dashboard_snapshot_runs')} (id, snapshot_id, started_on, status, trigger, job_id, recipients) VALUES ($1, $2, now(), 'running', $3, $4, '[]'::jsonb) ON CONFLICT (id) DO UPDATE SET status = 'running'`,
      [runId, snapshotId, o.trigger, o.jobId],
    )
    const finish = async (status: string, results: unknown[], message: string) => {
      await db().exec(`UPDATE ${T('ab_dashboard_snapshot_runs')} SET status = $2, finished_on = now(), recipients = $3::jsonb, message = $4 WHERE id = $1`, [runId, status, JSON.stringify(results), message])
    }
    const mail = identity(services).mail
    if (!(await mail.configured())) {
      await finish('failed', [], 'Email is not set up on this server.')
      throw new JobError('Email is not set up on this server.', { retry: false })
    }
    const dash = await dashboardRow(db(), String(r.dashboard_id))
    if (!dash) {
      await finish('failed', [], 'The dashboard no longer exists.')
      throw new JobError('The dashboard of this snapshot no longer exists.', { retry: false })
    }
    const settings = await loadSettings(db())
    let choices: ReturnType<typeof checkChoices>
    try {
      choices = checkChoices(dash.def, { ...(def.range ? { range: def.range } : {}), ...(def.filters ? { filters: def.filters } : {}) }, settings)
    } catch (e) {
      const msg = `The snapshot's range or filters no longer fit the dashboard: ${(e as Error).message}`
      await finish('failed', [], msg)
      throw new JobError(msg, { retry: false })
    }
    const results: { userId: string; status: 'sent' | 'skipped' | 'failed'; mailId?: string; pages?: number; reason?: string }[] = []
    const already = new Map((prior?.recipients ?? []).filter((x) => x.status === 'sent').map((x) => [x.userId, x]))
    let ids = [...new Set([...def.recipients.userIds, ...(await teamMembers(def.recipients.teamIds))])].filter((x) => !(def.optOut ?? []).includes(x))
    if (o.only) ids = ids.filter((x) => o.only!.includes(x))
    ids = ids.slice(0, REPORT_MAX_RECIPIENTS)
    const brand = { ...(await mail.brand()), logoUrl: '' }
    const env = currentEnvironment().id
    const asOf = localNow(new Date(), settings.timeZone).replace('T', ' ')
    const defaults = { locale: settings.locale, currency: settings.currency, timeZone: settings.timeZone }
    for (const uid of ids) {
      const prev = already.get(uid)
      if (prev) { results.push(prev as (typeof results)[number]); continue }
      const u = await services.meta.users.get(uid)
      if (!u || u.status === 'disabled' || !u.email) { results.push({ userId: uid, status: 'skipped', reason: 'The account is disabled or has no email address.' }); continue }
      if ((await suppressedAmong(db(), [u.email])).size) { results.push({ userId: uid, status: 'skipped', reason: 'The address is on the suppression list.' }); continue }
      try {
        const who = await identityIn(services, uid)
        if (!who) { results.push({ userId: uid, status: 'skipped', reason: 'No access to this environment.' }); continue }
        if (!canView(who, dash)) { results.push({ userId: uid, status: 'skipped', reason: 'This person cannot open the dashboard (not the owner, a maker, an administrator or in a viewer role).' }); continue }
        const data = await computeDashboard(services, who, dash.def, choices, settings)
        const pdf = await renderSnapshotPdf({ def: dash.def, tiles: data.tiles, range: data.range, calendar: settings, defaults, asOf, note: `the data ${u.name} can see`, ...(o.createdOn ? { createdOn: o.createdOn } : {}) })
        const failedTiles = dash.def.tiles.filter((t) => data.tiles[t.id]?.error)
        const link = brand.publicUrl ? `${brand.publicUrl}/#u-dashboards?d=${encodeURIComponent(dash.id)}` : ''
        const unsub = brand.publicUrl ? `${brand.publicUrl}/api/v1/dashboards/snapshots/unsubscribe?t=${signToken(snapshotKey(services), { u: uid, s: snapshotId, e: env })}` : ''
        const day = asOf.slice(0, 10)
        const summary = `${rangeLabel(data.range)}, as of ${asOf}. The dashboard is attached as a PDF (${pdf.pages} page${pdf.pages === 1 ? '' : 's'}).`
        const problems = failedTiles.length ? `<p style="margin:0 0 12px;font-size:12px;color:#b45309">${failedTiles.length} tile${failedTiles.length === 1 ? '' : 's'} could not be shown: ${esc(failedTiles.map((t) => t.title || t.id).join(', '))}.</p>` : ''
        const inner = `<p style="margin:0 0 12px;font-size:13px;color:#475569">${esc(summary)}</p>${problems}${link ? `<p><a href="${esc(link)}" style="display:inline-block;padding:8px 14px;border-radius:8px;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;font-size:13px">Open the dashboard in ${esc(brand.installName)}</a></p>` : ''}`
        const footer = `You get this because you are on the recipient list of the snapshot "${esc(def.name)}" (the data is what your own access allows). ${unsub ? `<a href="${esc(unsub)}" style="color:#64748b">Unsubscribe from this snapshot</a> (no sign-in needed).` : ''}`
        const text = [dash.def.title, '', summary, ...(failedTiles.length ? [`${failedTiles.length} tile(s) could not be shown.`] : []), '', ...(link ? [`Open: ${link}`] : []), ...(unsub ? [`Unsubscribe: ${unsub}`] : [])].join('\n')
        const fileName = `${dash.def.title.replace(/[^A-Za-z0-9 _-]+/g, '').trim().slice(0, 60) || 'dashboard'}-${day}.pdf`
        const m = await mail.send({
          to: u.email, subject: `${brand.installName}: ${dash.def.title} (${day})`, text, html: emailFrame(brand, dash.def.title, inner, footer),
          attachments: [{ fileName, contentType: 'application/pdf', content: pdf.bytes }], template: 'dashboard-snapshot', userId: uid,
          ...(unsub ? { headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}),
        })
        results.push({ userId: uid, status: 'sent', mailId: m.id, pages: pdf.pages })
      } catch (e) {
        log('warn', `dashboard snapshot ${snapshotId} for ${uid} failed: ${errText(e)}`)
        results.push({ userId: uid, status: 'failed', reason: e instanceof HttpError ? e.message.slice(0, 300) : 'The snapshot could not be made for this person (see the server log).' })
      }
      await db().exec(`UPDATE ${T('ab_dashboard_snapshot_runs')} SET recipients = $2::jsonb WHERE id = $1`, [runId, JSON.stringify(results)])
    }
    const sent = results.filter((x) => x.status === 'sent').length
    const failed = results.filter((x) => x.status === 'failed').length
    const skipped = results.length - sent - failed
    await finish(failed ? (sent ? 'partial' : 'failed') : 'succeeded', results, `${sent} sent, ${skipped} skipped, ${failed} failed`)
    if (failed && !sent) throw new JobError(`The snapshot failed for every recipient: ${results.find((x) => x.status === 'failed')?.reason ?? ''}`)
    return { runId, sent, skipped, failed }
  }

  services.kernel.jobs.register<{ snapshotId: string; trigger?: string; only?: string[] }>({
    type: SNAPSHOT_JOB,
    description: 'Emails a dashboard snapshot (PDF) to its recipients, each computed with the recipient\'s own access.',
    parse(raw) {
      if (!isObj(raw) || typeof raw.snapshotId !== 'string') throw new JobError('malformed snapshot job', { retry: false })
      return { snapshotId: raw.snapshotId, trigger: typeof raw.trigger === 'string' ? raw.trigger : 'schedule', ...(Array.isArray(raw.only) ? { only: raw.only.map(String) } : {}) }
    },
    maxAttempts: 3,
    concurrency: 1,
    timeoutMs: 15 * 60_000,
    async handler(p, ctx) {
      const r = await row(p.snapshotId)
      if (!r) return { skipped: 'The snapshot no longer exists.' }
      if (!r.enabled && p.trigger === 'schedule') return { skipped: 'The snapshot is paused.' }
      return run(p.snapshotId, { jobId: ctx.job.id, trigger: p.trigger ?? 'schedule', only: p.only })
    },
  })

  return {
    run,
    row,
    async list(viewer: UserContext, dash: DashboardRow): Promise<SnapshotInfo[]> {
      const rows = await db().query<Row>(`SELECT * FROM ${T('ab_dashboard_snapshots')} WHERE dashboard_id = $1 ORDER BY lower(name), id`, [dash.id])
      const myTeams = new Set((await db().query<{ team_id: string }>(`SELECT team_id FROM "ab"."team_members" WHERE user_id = $1`, [viewer.user.id])).map((x) => x.team_id))
      const all = canEdit(viewer, dash)
      const out: SnapshotInfo[] = []
      for (const r of rows) {
        const def = r.def as SnapshotDef
        const mine = String(r.owner_id) === viewer.user.id
        const receive = def.recipients.userIds.includes(viewer.user.id) || def.recipients.teamIds.some((t) => myTeams.has(t))
        if (all || mine || receive) out.push(await toInfo(r, viewer))
      }
      return out
    },
    async info(r: Row, viewer: UserContext): Promise<SnapshotInfo> { return toInfo(r, viewer) },
    async create(dash: DashboardRow, raw: unknown, who: UserContext): Promise<SnapshotInfo> {
      const def = await check(raw, who, dash)
      const id = `dss_${rowUid().replace(/-/g, '').slice(-16)}`
      const enabled = !isObj(raw) || raw.enabled !== false
      await db().exec(`INSERT INTO ${T('ab_dashboard_snapshots')} (id, dashboard_id, name, owner_id, def, enabled, created_on, modified_on) VALUES ($1, $2, $3, $4, $5::jsonb, $6, now(), now())`, [id, dash.id, def.name, who.user.id, JSON.stringify(def), enabled])
      const sid = await syncSchedule(id, def, enabled, null)
      await db().exec(`UPDATE ${T('ab_dashboard_snapshots')} SET schedule_id = $2 WHERE id = $1`, [id, sid])
      return toInfo((await row(id))!, who)
    },
    async update(r: Row, dash: DashboardRow, raw: unknown, who: UserContext): Promise<SnapshotInfo> {
      const def = await check(raw, who, dash, r.def as SnapshotDef)
      const enabled = isObj(raw) && typeof raw.enabled === 'boolean' ? raw.enabled : !!r.enabled
      const sid = await syncSchedule(String(r.id), def, enabled, r.schedule_id ? String(r.schedule_id) : null)
      await db().exec(`UPDATE ${T('ab_dashboard_snapshots')} SET name = $2, def = $3::jsonb, enabled = $4, schedule_id = $5, modified_on = now() WHERE id = $1`, [r.id, def.name, JSON.stringify(def), enabled, sid])
      return toInfo((await row(String(r.id)))!, who)
    },
    async remove(r: Row): Promise<void> {
      if (r.schedule_id) await services.kernel.jobs.schedules.remove(String(r.schedule_id)).catch(() => {})
      await db().exec(`DELETE FROM ${T('ab_dashboard_snapshot_runs')} WHERE snapshot_id = $1`, [r.id])
      await db().exec(`DELETE FROM ${T('ab_dashboard_snapshots')} WHERE id = $1`, [r.id])
    },
    async runs(id: string): Promise<Record<string, unknown>[]> {
      const rows = await db().query<Row>(`SELECT * FROM ${T('ab_dashboard_snapshot_runs')} WHERE snapshot_id = $1 ORDER BY started_on DESC LIMIT 50`, [id])
      return rows.map((x) => ({ id: x.id, startedOn: new Date(x.started_on as string).toISOString(), finishedOn: x.finished_on ? new Date(x.finished_on as string).toISOString() : null, status: x.status, trigger: x.trigger, message: x.message, recipients: x.recipients }))
    },
    async unsubscribe(env: string, snapshotId: string, userId: string): Promise<{ name: string } | null> {
      return runInEnvironment(env, async () => {
        const r = await row(snapshotId)
        if (!r) return null
        const def = r.def as SnapshotDef
        await db().exec(`UPDATE ${T('ab_dashboard_snapshots')} SET def = $2::jsonb WHERE id = $1`, [snapshotId, JSON.stringify({ ...def, optOut: [...new Set([...(def.optOut ?? []), userId])] })])
        return { name: def.name }
      })
    },
  }
}

export type Snapshots = ReturnType<typeof createSnapshots>

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
function page(title: string, inner: string, status = 200) {
  return {
    raw: true as const, status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f8fafc;color:#0f172a;padding:40px 16px"><div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px">${inner}</div></body></html>`,
  }
}

export function snapshotRoutes(router: ApiRouter, services: CoreServices, snaps: Snapshots): void {
  const db = () => {
    const d = services.state.db
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }
  const audit = async (ctx: Ctx, action: string, details: unknown) => {
    try { await services.meta.audit({ userId: ctx.user?.user.id ?? null, action, details }) } catch (e) { log('error', `audit write failed (${action}): ${errText(e)}`) }
  }
  const viewable = async (ctx: Ctx, id: string): Promise<DashboardRow> => {
    const d = await dashboardRow(db(), id)
    if (!d || !canView(ctx.user!, d)) throw new HttpError(404, 'not-found', 'Dashboard not found.')
    return d
  }
  /** a snapshot the caller may see (owner, recipient, editors of its dashboard) */
  const visible = async (ctx: Ctx): Promise<{ r: Row; dash: DashboardRow; info: SnapshotInfo }> => {
    const r = await snaps.row(ctx.params.sid)
    if (!r) throw new HttpError(404, 'not-found', 'Snapshot not found.')
    const dash = await viewable(ctx, String(r.dashboard_id))
    const info = (await snaps.list(ctx.user!, dash)).find((x) => x.id === String(r.id))
    if (!info) throw new HttpError(404, 'not-found', 'Snapshot not found.')
    return { r, dash, info }
  }
  const owned = async (ctx: Ctx) => {
    const v = await visible(ctx)
    if (!v.info.canEdit) throw new HttpError(403, 'denied', 'Only the owner of this snapshot and administrators can change it.')
    return v
  }

  router.add('GET', '/dashboards/:id/snapshots', async (ctx) => {
    const d = await viewable(ctx, ctx.params.id)
    return { items: await snaps.list(ctx.user!, d) }
  }, { auth: 'user' })

  router.add('POST', '/dashboards/:id/snapshots', async (ctx) => {
    const d = await viewable(ctx, ctx.params.id)
    const s = await snaps.create(d, ctx.body, ctx.user!)
    await audit(ctx, 'dashboard.snapshot.create', { id: s.id, dashboard: d.id, name: s.name, recipients: s.def.recipients, range: s.def.range ?? null })
    return s
  }, { auth: 'user' })

  router.add('PATCH', '/dashboards/snapshots/:sid', async (ctx) => {
    const { r, dash } = await owned(ctx)
    const s = await snaps.update(r, dash, ctx.body, ctx.user!)
    await audit(ctx, 'dashboard.snapshot.update', { id: s.id, dashboard: dash.id, name: s.name, recipients: s.def.recipients, enabled: s.enabled })
    return s
  }, { auth: 'user' })

  router.add('DELETE', '/dashboards/snapshots/:sid', async (ctx) => {
    const { r, dash } = await owned(ctx)
    await snaps.remove(r)
    await audit(ctx, 'dashboard.snapshot.delete', { id: String(r.id), dashboard: dash.id })
    return { ok: true }
  }, { auth: 'user' })

  // P2 security re-check (finding P2-8): a recipient's "run now" (their own copy) at most once a minute per snapshot; the
  // snapshot's owner and administrators are not limited
  const lastManual = new Map<string, number>()
  router.add('POST', '/dashboards/snapshots/:sid/run', async (ctx) => {
    const { info } = await visible(ctx)
    const me = ctx.user!
    const k = `${info.id}\u0000${me.user.id}`
    const at = Date.now()
    const prevRun = lastManual.get(k) ?? 0
    if (!info.canEdit && at - prevRun < 60_000) {
      const wait = Math.ceil((60_000 - (at - prevRun)) / 1000)
      ctx.res.setHeader('Retry-After', String(wait))
      throw new HttpError(429, 'rate_limited', `This snapshot was run a moment ago; try again in ${wait} s.`)
    }
    lastManual.set(k, at)
    if (lastManual.size > 5000) for (const x of [...lastManual.keys()].slice(0, 2500)) lastManual.delete(x)
    const all = info.canEdit
    const job = await services.kernel.jobs.enqueue(SNAPSHOT_JOB, { snapshotId: info.id, trigger: 'manual', ...(all ? {} : { only: [me.user.id] }) }, { createdBy: me.user.id, correlationId: `dashboard-snapshot:${info.id}` })
    await audit(ctx, 'dashboard.snapshot.run', { id: info.id, dashboard: info.dashboardId, forEveryone: all })
    return { jobId: job.id }
  }, { auth: 'user' })

  router.add('GET', '/dashboards/snapshots/:sid/runs', async (ctx) => {
    const { info } = await visible(ctx)
    const runs = await snaps.runs(info.id)
    if (!info.canEdit) for (const x of runs) x.recipients = Array.isArray(x.recipients) ? (x.recipients as { userId: string }[]).filter((y) => y.userId === ctx.user!.user.id) : []
    return { items: runs }
  }, { auth: 'user' })

  /* ---------------------------------------------------------------- unsubscribe without signing in */

  const tokenOf = (ctx: Ctx): Record<string, string> | null => {
    const raw = (ctx.rawBody ?? Buffer.alloc(0)).toString('utf8').slice(0, 4000)
    const t = ctx.query.get('t') ?? new URLSearchParams(raw).get('t') ?? ''
    const v = verifyToken(snapshotKey(services), t)
    return v && typeof v.u === 'string' && typeof v.s === 'string' && typeof v.e === 'string' ? v : null
  }
  router.add('GET', '/dashboards/snapshots/unsubscribe', async (ctx) => {
    const t = tokenOf(ctx)
    if (!t) return page('Link not valid', '<h1 style="font-size:18px">This link is not valid</h1><p>It may have been changed or cut off.</p>')
    return page('Unsubscribe', `<h1 style="font-size:18px">Stop this dashboard snapshot?</h1><p>You will no longer get this snapshot by email.</p>
<form method="post" action=""><input type="hidden" name="t" value="${esc(ctx.query.get('t') ?? '')}"><button type="submit" style="padding:9px 16px;border-radius:8px;border:0;background:#4f46e5;color:#fff;font-weight:600;cursor:pointer">Stop these emails</button></form>`)
  }, { auth: 'none' })
  router.add('POST', '/dashboards/snapshots/unsubscribe', async (ctx) => {
    const t = tokenOf(ctx)
    if (!t) return page('Link not valid', '<h1 style="font-size:18px">This link is not valid</h1>', 400)
    const env = await services.environments.get(t.e)
    const r = env ? await snaps.unsubscribe(env.id, t.s, t.u) : null
    if (!r) return page('Snapshot not found', '<h1 style="font-size:18px">This snapshot no longer exists</h1>', 404)
    await services.install.audit({ userId: t.u, action: 'dashboard.snapshot.unsubscribe', environmentId: t.e, details: { snapshot: t.s } }).catch(() => {})
    return page('Unsubscribed', `<h1 style="font-size:18px">Done</h1><p>You will not get the snapshot "${esc(r.name)}" any more.</p>`)
  }, { auth: 'none', raw: true, maxBodyMB: 0.01, csrfExempt: true })
}
