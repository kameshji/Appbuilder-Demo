/**
 * Builds the whole server: Services, the router with every route module (core + metadata), the connector
 * registry. Used by server/main.ts and by the Vite dev plugin (server/vite-plugin.mjs).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { ServerConfig } from './contracts.ts'
import { loadConfig } from './config.ts'
import { createServices } from './services.ts'
import type { CoreServices, SqlDbFactory } from './services.ts'
import { createRouter } from './router.ts'
import type { ApiRouter } from './router.ts'
import { authRoutes, sessionResolver } from './auth.ts'
import { dataRoutes } from './data-routes.ts'
import { attachmentRoutes, sweepOrphanAttachments } from './attachments.ts'
import { registerConnectors } from '../connectors/index.ts'
import { metaRoutes } from '../routes/meta/index.ts'
import { errText, log } from './util.ts'
import { runInEnvironment } from './env-context.ts'
import { notificationSink } from './kernel.ts'
import { registerExportRoutes } from './export-data.ts'
import { kernelRoutes } from './kernel-routes.ts'
import { backupRoutes } from './backup/routes.ts'
import { collabRoutes } from './collab-routes.ts'
import { createLiveHub } from './live/hub.ts'
import type { LiveHub } from './live/hub.ts'
import { wireLive } from './live/wiring.ts'
import { bridgeOutbox } from './live/changes.ts'
import { createNotificationService, notificationRoutes } from './notifications.ts'
import { identityRoutes } from './identity/routes.ts'
import { diagnosticsRoutes } from './diagnostics/routes.ts'
import { updateRoutes } from './update/routes.ts'
import { wireActions } from './actions/wiring.ts'
import { flowRoutes } from './flows/routes.ts'
import { createApprovals } from './approvals/service.ts'
import { approvalRoutes } from './approvals/routes.ts'

export interface AppServer {
  services: CoreServices
  router: ApiRouter
  config: ServerConfig
  /** answers /api/* (resolves true); resolves false for everything else */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>
  /** the realtime hub (WebSocket /api/v1/live) */
  live: LiveHub
  /** HTTP 'upgrade' event: true when it was the live endpoint (handled), false otherwise (the caller closes the socket) */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean
  close(): Promise<void>
}

export interface CreateAppOptions {
  config?: Partial<ServerConfig>
  env?: NodeJS.ProcessEnv
  sqlDbFactory?: SqlDbFactory
  fetch?: typeof fetch
  /** tests only */
  allowAnyHost?: boolean
  /** default true: connect to the database from env / server.json */
  boot?: boolean
  /** default true: print the first-run setup code to the console (tests read services.setupCode.current()) */
  printSetupCode?: boolean
  /** default true: start the job worker (jobs, schedules, outbox dispatch); tests may drive it with services.kernel.drain() */
  jobs?: boolean
}

export async function createApp(opts: CreateAppOptions = {}): Promise<AppServer> {
  const env = opts.env ?? process.env
  const config = loadConfig(env, opts.config)
  const services = createServices(config, { env, sqlDbFactory: opts.sqlDbFactory, fetch: opts.fetch })
  registerConnectors(services.connections)
  const router = createRouter(services, { allowAnyHost: opts.allowAnyHost })
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') {
    log('warn', `listening on ${config.host}: other computers can reach the sign-in page. There is no TLS; see docs/admin/hardening-checklist.md.`)
  }
  router.setSessionResolver(sessionResolver(services))
  // realtime hub and notifications (package H): the hub pushes notifications; hidden presence follows the settings
  const notifications = createNotificationService({ services })
  services.notifications = notifications
  const live = createLiveHub(services, { allowAnyHost: opts.allowAnyHost, env })
  notifications.setPush(live.pushUser)
  // teams (organisation model, package F): members of teams of this environment or install-wide ones, by id or code
  notifications.setTeamResolver(async (envId, teamIds) => {
    const db = services.state.db
    if (!db || !teamIds.length) return []
    const rows = await db.query<{ user_id: string }>(
      `SELECT DISTINCT m.user_id FROM "ab"."team_members" m JOIN "ab"."teams" t ON t.id = m.team_id
        WHERE (t.id = ANY($1::text[]) OR lower(t.code) = ANY($2::text[])) AND (t.environment_id IS NULL OR t.environment_id = $3)`,
      [teamIds, teamIds.map((x) => x.toLowerCase()), envId],
    )
    return rows.map((r) => r.user_id)
  })
  notifications.setSettingsListener((userId, st) => live.setHidden(userId, st.hidePresence))
  wireLive(router, live)
  // table-changed pushes come from the committed outbox rows (package G), in outbox order
  const offOutbox = bridgeOutbox(services.kernel.outbox, async (id) => (await services.meta.users.get(id))?.name)
  notificationRoutes(router, services, notifications)
  // core routes first; the router prefers literal segments over :params regardless of order
  authRoutes(router, services)
  // identity basics (package I): second step, reset, invitations, sessions, email relay, policy, API keys
  identityRoutes(router, services)
  dataRoutes(router, services)
  attachmentRoutes(router, services)
  metaRoutes(router, services)
  kernelRoutes(router, services)
  // export environment data (package M): a ZIP of CSVs, streamed, administrators after a recent sign-in
  registerExportRoutes(router, services)
  // backups and restores (package J): progress goes to install administrators over the hub
  backupRoutes(router, services)
  services.backup.setLive(live)
  collabRoutes(router, services)
  // operations (package L): health, server logs, usage, diagnostics bundle, staged updates
  diagnosticsRoutes(router, services, live)
  updateRoutes(router, services)
  // table events' NotifyUser goes to the in-app notifications when they are available
  services.kernel.events.setNotificationSink(notificationSink(services))
  // P1-D: connector actions (services.actions), webhooks in, notification delivery by email, scheduled reports
  wireActions(router, services, notifications)
  // P1-A: flows (definitions, runs, manual runs, callbacks)
  flowRoutes(router, services)
  // P1-C: approvals (the flow runtime's ApprovalsService, the API, email answer links, the record timeline)
  const approvals = createApprovals(services)
  services.approvals = approvals
  approvalRoutes(router, services, () => approvals)
  if (opts.boot !== false) {
    await services.boot()
    if (services.ready()) {
      // every usable environment has its own attachments
      ;(async () => {
        for (const e of await services.environments.list()) {
          if (e.state !== 'ready') continue
          try {
            const n = await runInEnvironment(e.id, () => sweepOrphanAttachments(services))
            if (n) log('info', `environment ${e.id}: removed ${n} orphaned attachment(s)`)
          } catch (err) {
            log('warn', `orphan sweep of environment ${e.id} failed: ${errText(err)}`)
          }
        }
      })().catch((e) => log('warn', `orphan sweep failed: ${errText(e)}`))
    }
    // while setup is needed: a one-time code, printed here, that the setup screen must send
    let needsSetup = !services.setupComplete()
    if (!needsSetup && services.ready()) needsSetup = (await services.meta.users.count().catch(() => 1)) === 0
    if (needsSetup && !services.state.incompatible) services.setupCode.issue({ print: opts.printSetupCode !== false })
  }
  if (opts.jobs !== false) services.kernel.start()
  return {
    services,
    router,
    config,
    handle: (req, res) => router.handle(req, res),
    live,
    handleUpgrade(req, socket, head) {
      if (!live.isLiveRequest(req)) return false
      live.handleUpgrade(req, socket, head)
      return true
    },
    async close() {
      offOutbox()
      await live.close().catch(() => {})
      await services.close()
    },
  }
}
