/**
 * Health (package L).
 *
 *  - publicHealth: what GET /api/v1/health tells anyone (service managers, the updater, a load balancer): ok, starting or
 *    degraded, nothing else. No versions, no database names, no error text.
 *  - detailedHealth: the install administrator's view (Admin console > Server logs and the diagnostics bundle): database,
 *    environments, disk space, backup age, job queue, live sockets, mail, clock skew, versions.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CoreServices } from '../services.ts'
import type { DetailedHealth, HealthCheck, HealthStatus, VersionInfo } from '../../../src/platform/ops.ts'
import { SCHEMA_VERSION } from '../meta-store.ts'
import { serverVersion } from '../auth.ts'
import { runInEnvironment } from '../env-context.ts'
import { errText } from '../util.ts'
import { activeFileLog, effectiveLevel } from './logger.ts'
import { readReleaseInfo } from '../update/release.ts'
import { installRoot } from '../update/layout.ts'
import { identity } from '../identity/index.ts'

/** how long after start a database that is not reachable yet counts as "starting" rather than "degraded" */
export const STARTING_GRACE_SECONDS = 120
const CLOCK_SKEW_WARN_MS = 5_000
const DISK_WARN_FREE = 0.1
const DISK_ERROR_FREE_BYTES = 1024 * 1024 * 1024

export interface LiveStatsSource { stats(): { connections: number; users: number } }

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} did not answer within ${ms} ms`)), ms) })])
  } finally {
    if (t) clearTimeout(t)
  }
}

/** ok / starting / degraded: the only thing anonymous callers learn */
export async function publicHealth(services: CoreServices, uptimeSeconds = process.uptime()): Promise<HealthStatus> {
  if (services.state.incompatible) return 'degraded'
  if (!services.ready()) {
    if (!services.databaseConfigured()) return 'starting'
    return uptimeSeconds < STARTING_GRACE_SECONDS ? 'starting' : 'degraded'
  }
  try {
    await withTimeout(services.state.db!.query('SELECT 1'), 3000, 'The database')
  } catch {
    return 'degraded'
  }
  try {
    const envs = await services.environments.list()
    if (envs.some((e) => e.state === 'failed')) return 'degraded'
  } catch {
    return 'degraded'
  }
  return 'ok'
}

export function versionInfo(services: CoreServices, postgres?: string, databaseSchema?: number): VersionInfo {
  const rel = readReleaseInfo()
  return {
    app: rel?.version ?? serverVersion(),
    commit: rel?.commit ?? 'dev',
    built: rel?.built ?? null,
    node: process.version,
    platform: `${os.type()} ${os.release()}`,
    arch: process.arch,
    ...(postgres ? { postgres } : {}),
    schema: { server: SCHEMA_VERSION, ...(databaseSchema !== undefined ? { database: databaseSchema } : {}) },
    installRoot: installRoot(),
  }
}

export function diskOf(label: string, p: string): DetailedHealth['disk'][number] | null {
  try {
    let probe = path.resolve(p)
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe)
    const s = fs.statfsSync(probe)
    return { label, path: p, freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) }
  } catch {
    return null
  }
}

export async function detailedHealth(services: CoreServices, live: LiveStatsSource | null): Promise<DetailedHealth> {
  const checks: HealthCheck[] = []
  const add = (key: string, label: string, status: HealthCheck['status'], message: string) => checks.push({ key, label, status, message })
  const status = await publicHealth(services)
  const st = services.state

  // database: reachability, latency, server version, schema versions, clock
  const database: DetailedHealth['database'] = { configured: services.databaseConfigured(), reachable: false, location: st.location }
  let postgres: string | undefined
  let dbSchema: number | undefined
  const clock: DetailedHealth['clock'] = { serverTime: new Date().toISOString() }
  if (services.ready() && st.db) {
    try {
      const t0 = Date.now()
      const r = await withTimeout(st.db.query<{ now: Date; v: string | null }>(`SELECT now() AS now, (SELECT v FROM "ab"."settings" WHERE k = 'schemaVersion') AS v`), 5000, 'The database')
      const t1 = Date.now()
      database.reachable = true
      database.latencyMs = t1 - t0
      const dbNow = new Date(r[0].now)
      clock.databaseTime = dbNow.toISOString()
      clock.skewMs = Math.round(dbNow.getTime() - (t0 + t1) / 2)
      dbSchema = Number(r[0].v) || undefined
      postgres = await st.db.serverVersion().catch(() => undefined)
    } catch (e) {
      database.error = errText(e)
    }
  } else if (st.databaseError) {
    database.error = st.databaseError
  }
  if (st.incompatible) add('database', 'Database', 'error', `The database schema (version ${st.incompatible.database}) is newer than this Appbuilder (version ${st.incompatible.server}).`)
  else if (!database.configured) add('database', 'Database', 'warn', 'No database is configured yet (first-run setup).')
  else if (!database.reachable) add('database', 'Database', 'error', `The database is not reachable${database.error ? `: ${database.error}` : '.'}`)
  else add('database', 'Database', (database.latencyMs ?? 0) > 1000 ? 'warn' : 'ok', `Answers in ${database.latencyMs} ms${postgres ? ` (${/^postgres/i.test(postgres) ? postgres : `PostgreSQL ${postgres}`})` : ''}.`)

  if (clock.skewMs !== undefined) {
    const s = Math.abs(clock.skewMs)
    add('clock', 'Clock', s > CLOCK_SKEW_WARN_MS ? 'warn' : 'ok', s > CLOCK_SKEW_WARN_MS
      ? `This computer's clock and the database server's differ by ${(s / 1000).toFixed(1)} s. Sign-in codes (two-step verification) and schedules need correct clocks: turn on time synchronisation.`
      : `In step with the database server (${s} ms).`)
  }

  // environments
  let environments: DetailedHealth['environments'] = []
  if (services.ready()) {
    try {
      environments = (await services.environments.list()).map((e) => ({ id: e.id, name: e.name, state: e.state, schemaVersion: e.schemaVersion ?? null }))
      const failed = environments.filter((e) => e.state === 'failed')
      add('environments', 'Environments', failed.length ? 'error' : 'ok', failed.length ? `Not available: ${failed.map((e) => e.name).join(', ')} (see Admin console > Environments).` : `${environments.length} ready.`)
    } catch (e) {
      add('environments', 'Environments', 'error', errText(e))
    }
  }

  // disk space: workspace, backups, logs
  const disk: DetailedHealth['disk'] = []
  const ws = diskOf('Workspace', services.config.workspaceDir)
  if (ws) disk.push(ws)
  let backups: DetailedHealth['backups'] = null
  if (services.ready()) {
    try {
      const h = await services.backup.health()
      backups = { enabled: h.enabled, lastOkAt: h.lastOk?.at ?? null, ageHours: h.lastOk?.ageHours ?? null, stale: h.stale, message: h.message }
      add('backups', 'Backups', !h.enabled || h.stale ? 'warn' : h.lastFailure ? 'warn' : 'ok', h.message)
      const folder = (await services.backup.settings().catch(() => null))?.folder
      if (folder) {
        const d = diskOf('Backups', folder)
        if (d && !disk.some((x) => x.path === d.path)) disk.push(d)
      }
    } catch (e) {
      add('backups', 'Backups', 'warn', `Backup status unavailable: ${errText(e)}`)
    }
  }
  const fileLog = activeFileLog()
  if (fileLog) {
    const d = diskOf('Logs', fileLog.dir)
    if (d && d.freeBytes !== ws?.freeBytes) disk.push(d)
  }
  for (const d of disk) {
    const ratio = d.totalBytes ? d.freeBytes / d.totalBytes : 1
    const gb = (d.freeBytes / 1024 ** 3).toFixed(1)
    add(`disk:${d.label.toLowerCase()}`, `Disk (${d.label})`, d.freeBytes < DISK_ERROR_FREE_BYTES ? 'error' : ratio < DISK_WARN_FREE ? 'warn' : 'ok', `${gb} GB free of ${(d.totalBytes / 1024 ** 3).toFixed(1)} GB.`)
  }

  // jobs: summed over the ready environments
  let jobs: DetailedHealth['jobs'] = null
  if (services.ready()) {
    try {
      const acc = { queued: 0, running: 0, failed: 0, dead: 0, failures24h: 0, oldestQueuedSeconds: 0, outboxPending: 0 }
      for (const e of environments.filter((x) => x.state === 'ready')) {
        const m = await runInEnvironment(e.id, () => services.kernel.jobs.metrics())
        acc.queued += m.states.queued
        acc.running += m.states.running
        acc.failed += m.states.failed
        acc.dead += m.states.dead
        acc.failures24h += m.failures24h
        acc.oldestQueuedSeconds = Math.max(acc.oldestQueuedSeconds, m.oldestQueuedSeconds)
        acc.outboxPending += m.outbox.pending
      }
      jobs = acc
      const behind = acc.oldestQueuedSeconds > 600
      add('jobs', 'Job queue', acc.dead || behind ? 'warn' : 'ok', `${acc.queued} queued, ${acc.running} running, ${acc.dead} dead${behind ? `; the oldest due job has waited ${Math.round(acc.oldestQueuedSeconds / 60)} minutes` : ''}.`)
    } catch (e) {
      add('jobs', 'Job queue', 'warn', errText(e))
    }
  }

  // mail
  let mailConfigured = false
  if (services.ready()) {
    try {
      mailConfigured = await identity(services).mail.configured()
    } catch { /* not available */ }
    add('mail', 'Email', mailConfigured ? 'ok' : 'warn', mailConfigured ? 'An SMTP relay is set up.' : 'No SMTP relay: password reset links and invitations cannot be emailed (Admin console > Email).')
  }

  const liveStats = live ? live.stats() : { connections: 0, users: 0 }
  const mem = process.memoryUsage()
  const lvl = effectiveLevel(services.config.workspaceDir)
  let logBytes = 0
  try {
    logBytes = fileLog ? fileLog.files().reduce((s, f) => s + f.bytes, 0) : 0
  } catch { /* ignore */ }
  if (!fileLog) add('logs', 'Log file', 'warn', 'File logging is off; the server log is only on the console.')

  return {
    status,
    checkedAt: new Date().toISOString(),
    checks,
    versions: versionInfo(services, postgres, dbSchema),
    database,
    environments,
    disk,
    backups,
    jobs,
    live: { connections: liveStats.connections, users: liveStats.users },
    mail: { configured: mailConfigured },
    clock,
    process: { pid: process.pid, uptimeSeconds: Math.round(process.uptime()), rssBytes: mem.rss, heapUsedBytes: mem.heapUsed },
    logs: { dir: fileLog?.dir ?? null, level: fileLog?.level() ?? lvl.level, levelFromEnv: lvl.fromEnv, bytes: logBytes },
  }
}
