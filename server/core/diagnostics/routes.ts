/**
 * Health, server logs, usage and the diagnostics bundle over HTTP (package L; shapes in src/platform/ops.ts).
 * GET /health is public and says only ok / starting / degraded. Everything under /admin/* is for install administrators.
 */
import { HttpError } from '../contracts.ts'
import type { Ctx, RawResponse, Router, UserContext } from '../contracts.ts'
import type { CoreServices } from '../services.ts'
import type { LogPage, PublicHealth } from '../../../src/platform/ops.ts'
import { log } from '../util.ts'
import { activeFileLog, effectiveLevel, isLogLevel, readOpsSettings, writeOpsSettings } from './logger.ts'
import { detailedHealth, publicHealth } from './health.ts'
import { usageReport } from './usage.ts'
import { buildDiagnosticsBundle } from './bundle.ts'
import { redactText } from './redact.ts'

export interface LiveSource {
  stats(): { connections: number; users: number }
  onlineUsers(): string[]
}

function installAdmin(ctx: Ctx, what: string): UserContext {
  const u = ctx.user
  if (!u) throw new HttpError(401, 'unauthenticated', 'Please sign in.')
  if (!u.privileges.isInstallAdmin) throw new HttpError(403, 'denied', `Only install administrators can ${what}.`)
  return u
}

export function diagnosticsRoutes(router: Router, services: CoreServices, live: LiveSource | null): void {
  const opts = { auth: 'user' as const, noEnvironment: true }

  router.add('GET', '/api/v1/health', async (): Promise<RawResponse> => {
    const status = await publicHealth(services)
    const body: PublicHealth = { status }
    return { raw: true, status: status === 'ok' ? 200 : 503, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) }
  }, { auth: 'none' })

  router.add('GET', '/api/v1/admin/health', async (ctx) => {
    installAdmin(ctx, 'see the server health')
    return detailedHealth(services, live)
  }, opts)

  // P1-E: health email and heartbeat
  router.add('GET', '/api/v1/admin/health-alerts', async (ctx) => {
    installAdmin(ctx, 'see the health alert settings')
    return { settings: await services.healthAlerts.settings() }
  }, opts)
  router.add('PUT', '/api/v1/admin/health-alerts', async (ctx) => {
    const u = installAdmin(ctx, 'change the health alert settings')
    const b = (ctx.body && typeof ctx.body === 'object' ? ctx.body : {}) as Record<string, unknown>
    const saved = await services.healthAlerts.save(b)
    const hb = (b.heartbeat && typeof b.heartbeat === 'object' ? b.heartbeat : {}) as Record<string, unknown>
    // the heartbeat address may hold a secret token: audited as changed, never its value
    await services.install.audit({ userId: u.user.id, action: 'install.health_alerts', details: { email: saved.email, heartbeat: { enabled: saved.heartbeat.enabled, everyMinutes: saved.heartbeat.everyMinutes, allowPrivateNetwork: saved.heartbeat.allowPrivateNetwork, urlChanged: hb.url !== undefined } } }).catch(() => {})
    return { settings: saved }
  }, opts)
  router.add('POST', '/api/v1/admin/health-alerts/test', async (ctx) => {
    installAdmin(ctx, 'test the health alerts')
    const b = (ctx.body && typeof ctx.body === 'object' ? ctx.body : {}) as Record<string, unknown>
    if (b.what === 'heartbeat') return services.healthAlerts.heartbeat(new Date(), { force: true })
    return services.healthAlerts.daily()
  }, opts)

  router.add('GET', '/api/v1/admin/logs', async (ctx): Promise<LogPage> => {
    installAdmin(ctx, 'read the server logs')
    const fl = activeFileLog()
    const lvl = effectiveLevel(services.config.workspaceDir)
    if (!fl) return { items: [], truncated: false, level: lvl.level, levelFromEnv: lvl.fromEnv, files: [], enabled: false }
    const q = ctx.query
    const level = q.get('level')
    const limit = Number(q.get('limit')) || 300
    const r = fl.read({
      ...(isLogLevel(level) ? { level } : {}),
      ...(q.get('from') ? { from: q.get('from')! } : {}),
      ...(q.get('to') ? { to: q.get('to')! } : {}),
      ...(q.get('q') ? { q: q.get('q')! } : {}),
      limit,
    })
    return { items: r.items, truncated: r.truncated, level: fl.level(), levelFromEnv: lvl.fromEnv, files: fl.files(), enabled: true }
  }, opts)

  router.add('GET', '/api/v1/admin/logs/download', async (ctx): Promise<RawResponse> => {
    installAdmin(ctx, 'download the server logs')
    const fl = activeFileLog()
    if (!fl) throw new HttpError(404, 'not-found', 'File logging is off on this server.')
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
    return {
      raw: true,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="appbuilder-log-${stamp}.jsonl"`, 'Cache-Control': 'no-store' },
      body: redactText(fl.readAllText()),
    }
  }, opts)

  router.add('PUT', '/api/v1/admin/logs/settings', async (ctx) => {
    const u = installAdmin(ctx, 'change the log level')
    const b = (ctx.body ?? {}) as { level?: unknown }
    if (!isLogLevel(b.level)) throw new HttpError(400, 'invalid', 'The level must be info, warn or error.', 'level')
    const lvl = effectiveLevel(services.config.workspaceDir)
    if (lvl.fromEnv) throw new HttpError(409, 'conflict', 'The log level is set by APPBUILDER_LOG_LEVEL in the service configuration; change it there.')
    writeOpsSettings(services.config.workspaceDir, { ...readOpsSettings(services.config.workspaceDir), logLevel: b.level })
    activeFileLog()?.setLevel(b.level)
    log('info', `log level set to ${b.level} by ${u.user.id}`)
    return { level: b.level }
  }, opts)

  router.add('GET', '/api/v1/admin/usage', async (ctx) => {
    installAdmin(ctx, 'see usage')
    if (!services.ready()) throw new HttpError(503, 'unavailable', 'The database is not available.')
    return usageReport(services, live)
  }, opts)

  router.add('POST', '/api/v1/admin/diagnostics', async (ctx): Promise<RawResponse> => {
    const u = installAdmin(ctx, 'create a diagnostics bundle')
    const b = await buildDiagnosticsBundle({ config: services.config, services, live })
    log('info', `diagnostics bundle created by ${u.user.id} (${b.data.length} bytes)`)
    try {
      await services.install.audit({ userId: u.user.id, action: 'diagnostics.bundle', details: { bytes: b.data.length } })
    } catch { /* audit is best effort here */ }
    return {
      raw: true,
      headers: { 'Content-Type': 'application/zip', 'Content-Length': String(b.data.length), 'Content-Disposition': `attachment; filename="${b.name}"`, 'Cache-Control': 'no-store' },
      body: b.data,
    }
  }, opts)
}
