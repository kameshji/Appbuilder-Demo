/**
 * Health alerts (P1-E): so an administrator learns about trouble without opening Appbuilder.
 *
 *  - Health email (optional): a daily summary at a set time, and an alert at once when the server is degraded, a backup
 *    failed, a job went dead (retries used up) or a flow run failed. Sent to the install administrators through the
 *    notification service (kind "health": in the app, and by email right away unless the administrator or the person
 *    changed that), each condition once until it clears (or at most once in 12 hours while it lasts).
 *  - Heartbeat (optional): while the server is healthy it requests an address the administrator sets (a free uptime
 *    monitor's "ping" URL) every N minutes; when the PC is off or the server is unhealthy the pings stop and the monitor
 *    alerts. The request goes through the outbound policy (actions/outbound.ts: the host is checked and pinned, no
 *    redirects, 10 s, 4 KB), carries no data, and the address is stored sealed (it usually contains a secret token).
 *
 * Settings: ab.settings `ops.healthAlerts`; state: `ops.healthAlerts.state`. Jobs (install schedules in the Default
 * environment): ops.health_watch every 5 minutes, ops.health_daily, ops.heartbeat.
 */
import type { CoreServices } from '../services.ts'
import type { Kernel } from '../kernel.ts'
import { HttpError } from '../contracts.ts'
import { DEFAULT_ENVIRONMENT_ID, runInEnvironment, environmentSchema } from '../env-context.ts'
import { publicHealth, detailedHealth } from './health.ts'
import { safeRequest, OutboundError } from '../actions/outbound.ts'
import { hostProblem } from '../net-policy.ts'
import { errText, log } from '../util.ts'

export const HEALTH_WATCH_JOB = 'ops.health_watch'
export const HEALTH_DAILY_JOB = 'ops.health_daily'
export const HEARTBEAT_JOB = 'ops.heartbeat'
const KEY = 'ops.healthAlerts'
const STATE_KEY = 'ops.healthAlerts.state'
const REPEAT_MS = 12 * 3600_000
const HEARTBEAT_MINUTES = [1, 2, 5, 10, 15, 30, 60] as const

export interface HealthAlertSettings {
  email: { enabled: boolean; dailyTime: string; timeZone: string; immediate: boolean }
  heartbeat: { enabled: boolean; everyMinutes: number; allowPrivateNetwork: boolean; urlSealed: string | null; urlHint: string }
}
export type PublicHealthAlertSettings = Omit<HealthAlertSettings, 'heartbeat'> & {
  heartbeat: Omit<HealthAlertSettings['heartbeat'], 'urlSealed'> & { hasUrl: boolean; last?: { at: string; ok: boolean; message: string } }
}
interface AlertState {
  /** condition key -> when it was last sent */
  sent: Record<string, string>
  /** dead jobs per environment last seen, the newest failed flow run per environment seen */
  dead: Record<string, number>
  flowRun: Record<string, string>
  heartbeat?: { at: string; ok: boolean; message: string }
}

const DEFAULTS: HealthAlertSettings = {
  email: { enabled: false, dailyTime: '07:30', timeZone: 'UTC', immediate: true },
  heartbeat: { enabled: false, everyMinutes: 5, allowPrivateNetwork: false, urlSealed: null, urlHint: '' },
}

export function createHealthAlerts(deps: { get: () => CoreServices; kernel: Kernel }) {
  const s = () => deps.get()
  const db = () => {
    const d = s().state.db
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }
  async function readJson<T>(k: string, d: T): Promise<T> {
    const r = await db().query<{ v: string | null }>(`SELECT v FROM "ab"."settings" WHERE k = $1`, [k])
    if (!r[0]?.v) return d
    try { return { ...d, ...(JSON.parse(r[0].v) as T) } } catch { return d }
  }
  const writeJson = (k: string, v: unknown) => db().exec(`INSERT INTO "ab"."settings" (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [k, JSON.stringify(v)])
  async function settings(): Promise<HealthAlertSettings> {
    const v = await readJson<HealthAlertSettings>(KEY, DEFAULTS)
    return { email: { ...DEFAULTS.email, ...v.email }, heartbeat: { ...DEFAULTS.heartbeat, ...v.heartbeat } }
  }
  const state = () => readJson<AlertState>(STATE_KEY, { sent: {}, dead: {}, flowRun: {} })

  async function publicSettings(): Promise<PublicHealthAlertSettings> {
    const c = await settings()
    const st = await state()
    const { urlSealed, ...hb } = c.heartbeat
    return { email: c.email, heartbeat: { ...hb, hasUrl: !!urlSealed, ...(st.heartbeat ? { last: st.heartbeat } : {}) } }
  }

  /** validates and stores; heartbeat.url: undefined keeps it, '' clears it */
  async function save(b: Record<string, unknown>): Promise<PublicHealthAlertSettings> {
    const cur = await settings()
    const e = (b.email && typeof b.email === 'object' ? b.email : {}) as Record<string, unknown>
    const h = (b.heartbeat && typeof b.heartbeat === 'object' ? b.heartbeat : {}) as Record<string, unknown>
    const dailyTime = e.dailyTime === undefined ? cur.email.dailyTime : String(e.dailyTime)
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(dailyTime)) throw new HttpError(422, 'invalid', 'The time of the daily summary is HH:MM, for example 07:30.', 'email.dailyTime')
    const timeZone = e.timeZone === undefined ? cur.email.timeZone : String(e.timeZone)
    try { new Intl.DateTimeFormat('en', { timeZone }) } catch { throw new HttpError(422, 'invalid', `"${timeZone}" is not a time zone.`, 'email.timeZone') }
    const everyMinutes = h.everyMinutes === undefined ? cur.heartbeat.everyMinutes : Number(h.everyMinutes)
    if (!(HEARTBEAT_MINUTES as readonly number[]).includes(everyMinutes)) throw new HttpError(422, 'invalid', `The heartbeat interval is one of ${HEARTBEAT_MINUTES.join(', ')} minutes.`, 'heartbeat.everyMinutes')
    let urlSealed = cur.heartbeat.urlSealed
    let urlHint = cur.heartbeat.urlHint
    if (h.url !== undefined && h.url !== null) {
      const raw = String(h.url).trim()
      if (!raw) { urlSealed = null; urlHint = '' } else {
        let u: URL
        try { u = new URL(raw) } catch { throw new HttpError(422, 'invalid', 'The heartbeat address must be a web address such as https://hc-ping.com/<your check id>.', 'heartbeat.url') }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(422, 'invalid', 'The heartbeat address must start with https://.', 'heartbeat.url')
        if (u.username || u.password) throw new HttpError(422, 'invalid', 'The heartbeat address must not contain a user name or password.', 'heartbeat.url')
        if (raw.length > 2000) throw new HttpError(422, 'invalid', 'The heartbeat address is too long.', 'heartbeat.url')
        const p = hostProblem(u.hostname.replace(/^\[|\]$/g, ''))
        if (p) throw new HttpError(422, 'invalid', p, 'heartbeat.url')
        urlSealed = s().secrets.encrypt(u.toString())
        urlHint = `${u.protocol}//${u.host}/…`
      }
    }
    const heartbeatOn = h.enabled === undefined ? cur.heartbeat.enabled : h.enabled === true
    if (heartbeatOn && !urlSealed) throw new HttpError(422, 'invalid', 'Enter the heartbeat address first.', 'heartbeat.url')
    const next: HealthAlertSettings = {
      email: { enabled: e.enabled === undefined ? cur.email.enabled : e.enabled === true, immediate: e.immediate === undefined ? cur.email.immediate : e.immediate !== false, dailyTime, timeZone },
      heartbeat: { enabled: heartbeatOn, everyMinutes, allowPrivateNetwork: h.allowPrivateNetwork === undefined ? cur.heartbeat.allowPrivateNetwork : h.allowPrivateNetwork === true, urlSealed, urlHint },
    }
    await writeJson(KEY, next)
    await syncSchedules(next)
    return publicSettings()
  }

  async function installAdmins(): Promise<string[]> {
    const rows = await db().query<{ id: string }>(`SELECT id FROM "ab"."users" WHERE is_install_admin AND status = 'active'`)
    return rows.map((r) => String(r.id))
  }
  async function notifyAdmins(title: string, body: string, link: string, key: string): Promise<boolean> {
    const n = s().notifications
    if (!n) return false
    const ids = await installAdmins()
    if (!ids.length) return false
    await n.notify({ userIds: ids }, { kind: 'health', title: title.slice(0, 200), body: body.slice(0, 1900), link, source: 'system', environmentId: null, idempotencyKey: `health:${key}` })
    return true
  }

  /** the conditions that alert at once: [key, title, body, link] */
  async function conditions(st: AlertState): Promise<{ key: string; title: string; body: string; link: string; mark?: () => void }[]> {
    const out: { key: string; title: string; body: string; link: string; mark?: () => void }[] = []
    const status = await publicHealth(s())
    if (status === 'degraded') out.push({ key: 'degraded', title: 'Appbuilder is not healthy', body: 'The server reports "degraded": the database or an environment is not available. Open Admin console > Server logs for the checks.', link: '#admin-logs' })
    if (!s().ready()) return out
    try {
      const b = await s().backup.health()
      if (b.lastFailure) out.push({ key: `backup:${b.lastFailure.id}`, title: 'A backup failed', body: `${b.lastFailure.error.slice(0, 400)} (${b.lastFailure.at}). Open Admin console > Backups.`, link: '#admin-backups' })
    } catch (e) { log('warn', `health alerts: backups: ${errText(e)}`) }
    for (const env of (await s().environments.list()).filter((e) => e.state === 'ready')) {
      try {
        const m = await runInEnvironment(env.id, () => s().kernel.jobs.metrics())
        const before = st.dead[env.id] ?? 0
        if (m.states.dead > before) out.push({ key: `dead:${env.id}:${m.states.dead}`, title: `Jobs gave up in ${env.name}`, body: `${m.states.dead} job${m.states.dead === 1 ? ' has' : 's have'} used up their retries (dead letter). Open Admin console > Jobs in ${env.name} to retry or cancel them.`, link: '#admin-jobs', mark: () => { st.dead[env.id] = m.states.dead } })
        else st.dead[env.id] = m.states.dead
        const sch = environmentSchema(env.id)
        const rows = await db().query<{ id: string; flow_name: string; n: number }>(
          `SELECT id, flow_name, count(*) OVER ()::int AS n FROM "${sch}"."ab_flow_runs" WHERE state IN ('failed', 'timedOut') AND mode = 'normal' AND finished_on > now() - interval '1 day' ORDER BY finished_on DESC, id DESC LIMIT 5`,
        ).catch(() => [])
        if (rows.length && rows[0].id !== st.flowRun[env.id]) {
          const names = [...new Set(rows.map((r) => String(r.flow_name)))].join(', ')
          const newest = String(rows[0].id)
          out.push({ key: `flows:${env.id}:${newest}`, title: `Flows are failing in ${env.name}`, body: `${rows[0].n} failed flow run${rows[0].n === 1 ? '' : 's'} in the last 24 hours (${names}). Open the Flows page or Admin console > Flows.`, link: '#admin-flows', mark: () => { st.flowRun[env.id] = newest } })
        }
      } catch (e) { log('warn', `health alerts: ${env.id}: ${errText(e)}`) }
    }
    return out
  }

  async function watch(now = new Date()): Promise<{ sent: string[] }> {
    const c = await settings()
    if (!c.email.enabled || !c.email.immediate) return { sent: [] }
    const st = await state()
    const found = await conditions(st)
    const sent: string[] = []
    const active = new Set(found.map((f) => f.key))
    for (const f of found) {
      const last = st.sent[f.key] ? new Date(st.sent[f.key]).getTime() : 0
      if (last && now.getTime() - last < REPEAT_MS) { f.mark?.(); continue }
      if (await notifyAdmins(f.title, f.body, f.link, `${f.key}:${Math.floor(now.getTime() / REPEAT_MS)}`)) {
        st.sent[f.key] = now.toISOString()
        sent.push(f.key)
      }
      f.mark?.()
    }
    // a condition that cleared may alert again when it comes back
    for (const k of Object.keys(st.sent)) if (!active.has(k) && k === 'degraded') delete st.sent[k]
    // keep the state small
    const keys = Object.keys(st.sent).sort((a, b) => st.sent[b].localeCompare(st.sent[a]))
    for (const k of keys.slice(200)) delete st.sent[k]
    await writeJson(STATE_KEY, st)
    return { sent }
  }

  async function daily(now = new Date()): Promise<{ sent: boolean }> {
    const c = await settings()
    if (!c.email.enabled) return { sent: false }
    const h = await detailedHealth(s(), null)
    const bad = h.checks.filter((x) => x.status !== 'ok')
    const lines = [
      `Status: ${h.status}.`,
      ...(bad.length ? bad.map((x) => `${x.status === 'error' ? 'Problem' : 'Warning'} - ${x.label}: ${x.message}`) : ['Every check is ok.']),
      ...(h.backups ? [`Backups: ${h.backups.message}`] : []),
      ...(h.jobs ? [`Jobs: ${h.jobs.queued} queued, ${h.jobs.dead} dead, ${h.jobs.failures24h} failures in 24 hours.`] : []),
    ]
    // failed flow runs per environment over the last day
    if (s().ready()) for (const env of (await s().environments.list()).filter((e) => e.state === 'ready')) {
      const r = await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM "${environmentSchema(env.id)}"."ab_flow_runs" WHERE state IN ('failed', 'timedOut') AND mode = 'normal' AND finished_on > now() - interval '1 day'`).catch(() => [])
      if (Number(r[0]?.n)) lines.push(`Flows in ${env.name}: ${r[0].n} failed run${Number(r[0].n) === 1 ? '' : 's'} in 24 hours.`)
    }
    const st = await state()
    if (c.heartbeat.enabled && st.heartbeat) lines.push(`Heartbeat: last ${st.heartbeat.ok ? 'sent' : 'failed'} at ${st.heartbeat.at}${st.heartbeat.ok ? '' : ` (${st.heartbeat.message})`}.`)
    const title = `Daily health: ${h.status === 'ok' && !bad.length ? 'all good' : `${bad.length} item${bad.length === 1 ? '' : 's'} to look at`}`
    return { sent: await notifyAdmins(title, lines.join('\n'), '#admin-logs', `daily:${now.toISOString().slice(0, 10)}`) }
  }

  async function heartbeat(now = new Date(), o: { lookup?: (h: string) => Promise<{ address: string; family?: number }[]>; force?: boolean } = {}): Promise<{ sent: boolean; message: string }> {
    const c = await settings()
    if (!c.heartbeat.urlSealed) return { sent: false, message: 'No heartbeat address is saved.' }
    if (!c.heartbeat.enabled && !o.force) return { sent: false, message: 'off' }
    const st = await state()
    const record = async (ok: boolean, message: string) => {
      st.heartbeat = { at: now.toISOString(), ok, message: message.slice(0, 200) }
      await writeJson(STATE_KEY, st)
      return { sent: ok, message }
    }
    const status = await publicHealth(s())
    // no ping while unhealthy: the monitor notices the silence
    if (status !== 'ok') return record(false, `Not sent: the server is ${status}.`)
    let url: string
    try { url = s().secrets.decrypt(c.heartbeat.urlSealed) } catch { return record(false, 'The saved heartbeat address cannot be decrypted; enter it again.') }
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    try {
      const r = await safeRequest({ method: 'GET', url, headers: { 'User-Agent': 'Appbuilder-heartbeat' } }, {
        allowedHosts: [host], allowPrivate: c.heartbeat.allowPrivateNetwork, maxRedirects: 0, maxResponseBytes: 4096, timeoutMs: 10_000, verifyTls: true, ...(o.lookup ? { lookup: o.lookup } : {}),
      })
      return record(r.status >= 200 && r.status < 400, `HTTP ${r.status}`)
    } catch (e) {
      return record(false, e instanceof OutboundError ? e.message : errText(e))
    }
  }

  async function syncSchedules(c?: HealthAlertSettings): Promise<void> {
    const sv = s()
    if (!sv.ready()) return
    const cfg = c ?? await settings()
    const [hh, mm] = cfg.email.dailyTime.split(':').map(Number)
    const every = cfg.heartbeat.everyMinutes
    const want = [
      { id: 'sched_health_watch', name: 'Health alerts', description: 'Emails install administrators at once when the server is degraded, a backup failed, a job is dead or flow runs fail (Admin console > Server logs > Alerts).', cron: '*/5 * * * *', timeZone: 'UTC', enabled: cfg.email.enabled && cfg.email.immediate, jobType: HEALTH_WATCH_JOB },
      { id: 'sched_health_daily', name: 'Daily health summary', description: 'A daily health summary for install administrators.', cron: `${mm} ${hh} * * *`, timeZone: cfg.email.timeZone, enabled: cfg.email.enabled, jobType: HEALTH_DAILY_JOB },
      { id: 'sched_heartbeat', name: 'Heartbeat', description: 'Requests the uptime monitor address while the server is healthy.', cron: every === 60 ? '0 * * * *' : `*/${every} * * * *`, timeZone: 'UTC', enabled: cfg.heartbeat.enabled && !!cfg.heartbeat.urlSealed, jobType: HEARTBEAT_JOB },
    ]
    await runInEnvironment(DEFAULT_ENVIRONMENT_ID, async () => {
      const k = sv.kernel
      await k.jobs.schedules.ensureBuiltins(want.map((w) => ({ id: w.id, name: w.name, description: w.description, cron: w.cron, jobType: w.jobType, payload: {}, enabled: false, misfire: 'run_once' as const })))
      for (const w of want) {
        const cur = await k.jobs.schedules.get(w.id)
        if (!cur) continue
        if (cur.cron !== w.cron || cur.timeZone !== w.timeZone || cur.enabled !== w.enabled || cur.name !== w.name) {
          await k.jobs.schedules.update(w.id, { name: w.name, cron: w.cron, timeZone: w.timeZone, enabled: w.enabled, misfire: 'run_once' })
        }
      }
    })
  }

  deps.kernel.jobs.register({ type: HEALTH_WATCH_JOB, schedule: 'install', description: 'Health alerts: emails install administrators about a degraded server, failed backups, dead jobs and failing flows.', concurrency: 1, maxAttempts: 1, timeoutMs: 120_000, async handler() { return watch() } })
  deps.kernel.jobs.register({ type: HEALTH_DAILY_JOB, schedule: 'install', description: 'The daily health summary for install administrators.', concurrency: 1, maxAttempts: 2, timeoutMs: 120_000, async handler() { return daily() } })
  deps.kernel.jobs.register({ type: HEARTBEAT_JOB, schedule: 'install', description: 'Requests the heartbeat (uptime monitor) address while the server is healthy.', concurrency: 1, maxAttempts: 1, timeoutMs: 30_000, async handler() { return heartbeat() } })

  return {
    settings: publicSettings, save, watch, daily, heartbeat, syncSchedules,
    async onDatabaseReady() { await syncSchedules().catch((e) => log('warn', `health alert schedules: ${errText(e)}`)) },
  }
}
export type HealthAlerts = ReturnType<typeof createHealthAlerts>
