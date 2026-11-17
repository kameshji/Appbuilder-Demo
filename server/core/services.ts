/**
 * Services container + database bootstrap (server.json / APPBUILDER_DB_* env) and the setup step that
 * (re)configures the default store. `meta` / `data` throw 503 while no database is configured.
 */
import mysql from 'mysql2/promise'
import { HttpError } from './contracts.ts'
import type {
  ConnectorEnv, MetaStore, MySqlSettings, ServerConfig, Services, SqlDb,
} from './contracts.ts'
import { createSqlDb, friendlyConnectionError } from '../connectors/mysql/index.ts'
import { flushFiles } from '../connectors/files/index.ts'
import { createSecretBox, loadSecretKey } from './secrets.ts'
import { createMetaStore } from './meta-store.ts'
import { createSecurityEngine } from './security.ts'
import { createConnectionManager, DEFAULT_CONNECTION_ID, FILES_CONNECTION_ID } from './connections.ts'
import { createDataService } from './data.ts'
import { createAttachmentStore } from './attachment-store.ts'
import { envDatabase, readServerJson, writeServerJson } from './config.ts'
import { errText, log, nowIso, uid } from './util.ts'

export type SqlDbFactory = (settings: MySqlSettings, password: string) => SqlDb

export interface CoreState {
  db: SqlDb | null
  meta: MetaStore | null
  settings: MySqlSettings | null
  /** e.g. "MySQL 8.4.3 at 127.0.0.1:3306/appbuilder" */
  location: string | null
  databaseError?: string
}

export type CoreServices = Services & {
  state: CoreState
  security: ReturnType<typeof createSecurityEngine>
  data: ReturnType<typeof createDataService>
  connections: ReturnType<typeof createConnectionManager>
  /** test + connect + migrate the default store; persist=true seals the password into server.json */
  configureDatabase(settings: MySqlSettings, password: string, opts: { createDatabase?: boolean; persist: boolean }): Promise<void>
  /** reads env / server.json and connects (errors are kept in state.databaseError, never thrown) */
  boot(): Promise<void>
  close(): Promise<void>
}

const DB_NAME_RE = /^[A-Za-z0-9_$]{1,64}$/

export function createServices(config: ServerConfig, opts: { env?: NodeJS.ProcessEnv; sqlDbFactory?: SqlDbFactory; fetch?: typeof fetch } = {}): CoreServices {
  const procEnv = opts.env ?? process.env
  const sqlDbFactory = opts.sqlDbFactory ?? createSqlDb
  const secrets = createSecretBox(loadSecretKey(config.workspaceDir, procEnv))
  const state: CoreState = { db: null, meta: null, settings: null, location: null }
  let purgeTimer: NodeJS.Timeout | null = null

  const getMeta = (): MetaStore => {
    if (!state.meta) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return state.meta
  }

  const env: ConnectorEnv = {
    workspaceDir: config.workspaceDir,
    filesDir: config.filesDir,
    fetch: opts.fetch ?? globalThis.fetch,
    log: (level, msg) => log(level, msg),
  }
  const security = createSecurityEngine(getMeta)
  const connections = createConnectionManager(getMeta, env)
  const attachments = createAttachmentStore(config.attachmentsDir)
  const data = createDataService({ meta: getMeta, connections, attachments, log: env.log })

  async function ensureBuiltinConnections(meta: MetaStore, settings: MySqlSettings, password: string): Promise<void> {
    const all = await meta.connections.list()
    const current = all.find((c) => c.id === DEFAULT_CONNECTION_ID)
    const hasOtherDefault = all.some((c) => c.isDefault && c.id !== DEFAULT_CONNECTION_ID)
    const s: Record<string, string> = {
      host: settings.host, port: String(settings.port), database: settings.database, user: settings.user, ssl: settings.ssl ? 'true' : 'false',
    }
    let name = current?.name ?? 'Default database'
    if (!current && all.some((c) => c.name.toLowerCase() === name.toLowerCase())) name = `Default database (${settings.database})`
    await meta.connections.upsert({
      id: DEFAULT_CONNECTION_ID, name, connector: 'mysql', status: 'connected', settings: s, secret: password,
      isDefault: current ? !!current.isDefault : !hasOtherDefault, scope: 'server',
    })
    if (!all.some((c) => c.id === FILES_CONNECTION_ID)) {
      let fname = 'Data files'
      if (all.some((c) => c.name.toLowerCase() === fname.toLowerCase())) fname = 'Data files (device)'
      await meta.connections.upsert({ id: FILES_CONNECTION_ID, name: fname, connector: 'files', status: 'connected', settings: {}, isDefault: false, scope: 'device' })
    }
  }

  async function createDatabaseIfMissing(settings: MySqlSettings, password: string): Promise<void> {
    const c = await mysql.createConnection({
      host: settings.host, port: settings.port, user: settings.user, password,
      ssl: settings.ssl ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined, connectTimeout: 10000,
    })
    try {
      await c.query(`CREATE DATABASE IF NOT EXISTS \`${settings.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    } finally {
      try {
        await c.end()
      } catch {
        c.destroy()
      }
    }
  }

  async function configureDatabase(settings: MySqlSettings, password: string, o: { createDatabase?: boolean; persist: boolean }): Promise<void> {
    if (!DB_NAME_RE.test(settings.database)) throw new HttpError(422, 'invalid', 'The database name may contain letters, digits, _ and $ only.', 'database')
    if (o.createDatabase) {
      try {
        await createDatabaseIfMissing(settings, password)
      } catch (e) {
        // may lack CREATE privilege on an existing database: the connect below decides
        log('warn', `CREATE DATABASE skipped: ${friendlyConnectionError(e, settings, password)}`)
      }
    }
    const db = sqlDbFactory(settings, password)
    let version = ''
    try {
      await db.query('SELECT 1 AS ok')
      version = await db.serverVersion()
    } catch (e) {
      await db.close().catch(() => {})
      throw new HttpError(422, 'invalid', friendlyConnectionError(e, settings, password))
    }
    const meta = createMetaStore(db, secrets)
    try {
      await meta.migrate()
      await ensureBuiltinConnections(meta, settings, password)
    } catch (e) {
      await db.close().catch(() => {})
      log('error', `system schema migration failed: ${errText(e)}`)
      throw new HttpError(500, 'storage', 'Could not create the system tables in this database (check the user\'s privileges).')
    }
    const old = state.db
    state.db = db
    state.meta = meta
    state.settings = settings
    state.location = `${version} at ${settings.host}:${settings.port}/${settings.database}`
    delete state.databaseError
    security.invalidate()
    await connections.reset(DEFAULT_CONNECTION_ID)
    if (old && old !== db) await old.close().catch(() => {})
    if (o.persist) {
      writeServerJson(config, {
        defaultConnection: { ...settings, passwordSealed: secrets.encrypt(password) },
      })
    }
    try {
      await meta.sessions.purgeExpired()
    } catch {
      /* not important */
    }
  }

  async function boot(): Promise<void> {
    const fromEnv = envDatabase(procEnv)
    try {
      if (fromEnv) {
        await configureDatabase(fromEnv.settings, fromEnv.password, { createDatabase: true, persist: false })
      } else {
        const sj = readServerJson(config).defaultConnection
        if (sj) {
          let password = ''
          try {
            password = sj.passwordSealed ? secrets.decrypt(sj.passwordSealed) : ''
          } catch {
            throw new HttpError(503, 'unavailable', 'The saved database password cannot be decrypted (was workspace/.secret-key replaced?). Run the database setup again.')
          }
          await configureDatabase({ host: sj.host, port: Number(sj.port) || 3306, database: sj.database, user: sj.user, ssl: !!sj.ssl }, password, { persist: false })
        }
      }
    } catch (e) {
      state.databaseError = e instanceof HttpError ? e.message : 'The database could not be opened.'
      log('warn', `database not available: ${state.databaseError}`)
    }
    if (!purgeTimer) {
      purgeTimer = setInterval(() => {
        state.meta?.sessions.purgeExpired().catch(() => {})
      }, 60 * 60 * 1000)
      purgeTimer.unref()
    }
  }

  async function close(): Promise<void> {
    if (purgeTimer) clearInterval(purgeTimer)
    purgeTimer = null
    try {
      await flushFiles(env)
    } catch (e) {
      log('warn', `flushing data files failed: ${errText(e)}`)
    }
    await connections.closeAll()
    const db = state.db
    state.db = null
    state.meta = null
    if (db) await db.close().catch(() => {})
  }

  const services: CoreServices = {
    config,
    secrets,
    ready: () => state.meta !== null,
    get meta() {
      return getMeta()
    },
    security,
    get data() {
      getMeta()
      return data
    },
    connections,
    attachments,
    env,
    uid,
    now: nowIso,
    state,
    configureDatabase,
    boot,
    close,
  }
  return services
}
