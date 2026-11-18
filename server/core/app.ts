/**
 * Builds the whole server: Services, the router with every route module (core + metadata), the connector
 * registry. Used by server/main.ts and by the Vite dev plugin (server/vite-plugin.mjs).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
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

export interface AppServer {
  services: CoreServices
  router: ApiRouter
  config: ServerConfig
  /** answers /api/* (resolves true); resolves false for everything else */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>
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
  // core routes first; the router prefers literal segments over :params regardless of order
  authRoutes(router, services)
  dataRoutes(router, services)
  attachmentRoutes(router, services)
  metaRoutes(router, services)
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
  return {
    services,
    router,
    config,
    handle: (req, res) => router.handle(req, res),
    close: () => services.close(),
  }
}
