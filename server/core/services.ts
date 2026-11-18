/**
 * Services container + database bootstrap (server.json / APPBUILDER_DB_* env) and the setup step that
 * (re)configures the default store. `meta` / `data` throw 503 while no database is configured.
 */
import mysql from 'mysql2/promise'
import { randomInt, timingSafeEqual } from 'node:crypto'
import { HttpError } from './contracts.ts'
import type {
  ConnectorEnv, MetaStore, MigrationSummary, MySqlSettings, ServerConfig, Services, SqlDb,
} from './contracts.ts'
import { createSqlDb, friendlyConnectionError } from '../connectors/mysql/index.ts'
import { flushFiles } from '../connectors/files/index.ts'
import { createSecretBox, loadSecretKey } from './secrets.ts'
import { SchemaTooNewError, createMetaStore } from './meta-store.ts'
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
  /** a database is configured (server.json or APPBUILDER_DB_*) but could not be opened; boot keeps retrying */
  unavailable?: boolean
  /** the configured database has a newer schema than this server (downgrade guard): it is not used at all */
  incompatible?: { database: number; server: number }
  /** the last schema migration (logged at boot and written to the audit log) */
  migration?: MigrationSummary
}

/** unambiguous alphabet for the one-time setup code (no 0/O, 1/I/L) */
const SETUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const SETUP_CODE_LENGTH = 8

export function newSetupCode(): string {
  let out = ''
  for (let i = 0; i < SETUP_CODE_LENGTH; i++) out += SETUP_ALPHABET[randomInt(SETUP_ALPHABET.length)]
  return out
}

/** the first-run setup code: printed to the server console, required by POST /setup/database and /setup/admin */
export interface SetupCode {
  /** current code (null until issued) */
  current(): string | null
  /** new random code, printed prominently unless quiet */
  issue(opts?: { print?: boolean }): string
  /** constant-time comparison; spaces, dashes and case are ignored */
  matches(given: unknown): boolean
}

function createSetupCode(port: number): SetupCode {
  let code: string | null = null
  const norm = (v: string) => v.replace(/[\s-]/g, '').toUpperCase()
  return {
    current: () => code,
    issue(o = {}) {
      code = newSetupCode()
      if (o.print !== false) {
        const bar = '='.repeat(60)
        const lines = [
          bar,
          '  FIRST-RUN SETUP CODE:  ' + code.slice(0, 4) + '-' + code.slice(4),
          `  Open Appbuilder on THIS computer (http://localhost:${port}/) and`,
          '  type this code in the setup screen. It changes on every start.',
          bar,
        ]
        // console directly (not log()): the code must be visible even when logs are quiet
        process.stdout.write('\n' + lines.join('\n') + '\n\n')
      }
      return code
    },
    matches(given) {
      if (!code || typeof given !== 'string') return false
      const a = Buffer.from(norm(given))
      const b = Buffer.from(code)
      return a.length === b.length && timingSafeEqual(a, b)
    },
  }
}

export type CoreServices = Services & {
  state: CoreState
  security: ReturnType<typeof createSecurityEngine>
  data: ReturnType<typeof createDataService>
  connections: ReturnType<typeof createConnectionManager>
  /** test + connect + migrate the default store; persist=true seals the password into server.json */
  configureDatabase(settings: MySqlSettings, password: string, opts: { createDatabase?: boolean; persist: boolean }): Promise<void>
  /**
   * reads env / server.json and connects (errors are kept in state.databaseError, never thrown). When a configured
   * database cannot be reached it keeps retrying in the background (1 s, doubling, at most 30 s) until it can.
   */
  boot(): Promise<void>
  /** resolves when the background retry (if any) has connected or been stopped (tests) */
  retrying(): Promise<void> | null
  close(): Promise<void>
  setupCode: SetupCode
  /** true once the first administrator exists (server.json setupComplete, or users in the database) */
  setupComplete(): boolean
  /** records setupComplete in server.json (false: clears it, when the database was re-pointed to an empty one) */
  markSetupComplete(value?: boolean): void
  /** a database is configured (env or server.json), reachable or not */
  databaseConfigured(): boolean
}

/** boot retry backoff: 1 s, 2 s, 4 s ... capped at 30 s */
export function retryDelayMs(attempt: number): number {
  return Math.min(30000, 1000 * 2 ** Math.max(0, attempt))
}

const DB_NAME_RE = /^[A-Za-z0-9_$]{1,64}$/

export function createServices(config: ServerConfig, opts: { env?: NodeJS.ProcessEnv; sqlDbFactory?: SqlDbFactory; fetch?: typeof fetch } = {}): CoreServices {
  const procEnv = opts.env ?? process.env
  const sqlDbFactory = opts.sqlDbFactory ?? createSqlDb
  const secrets = createSecretBox(loadSecretKey(config.workspaceDir, procEnv))
  const state: CoreState = { db: null, meta: null, settings: null, location: null }
  let purgeTimer: NodeJS.Timeout | null = null
  let retryTimer: NodeJS.Timeout | null = null
  let retryPromise: Promise<void> | null = null
  let retryResolve: (() => void) | null = null
  let closed = false
  const setupCode = createSetupCode(config.port)

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
    let migration: MigrationSummary | undefined
    try {
      migration = (await meta.migrate()) ?? undefined
      await ensureBuiltinConnections(meta, settings, password)
    } catch (e) {
      await db.close().catch(() => {})
      if (e instanceof SchemaTooNewError) {
        state.incompatible = { database: e.database, server: e.server }
        log('error', `DATABASE NOT USED: ${e.message}`)
        throw new HttpError(503, 'unavailable', 'The database was upgraded by a newer version of Appbuilder. Run that version, or restore a backup taken before the upgrade.')
      }
      log('error', `system schema migration failed: ${errText(e)}`)
      throw new HttpError(500, 'storage', 'Could not create the system tables in this database (check the user\'s privileges).')
    }
    delete state.incompatible
    if (migration) {
      state.migration = migration
      if (migration.from !== migration.to) {
        log('info', `system schema migrated from version ${migration.from} to ${migration.to}: ${migration.steps.join('; ') || 'no changes'}`)
        try {
          await meta.audit({ userId: null, action: 'schema.migrate', details: migration })
        } catch (e) {
          log('error', `audit write failed (schema.migrate): ${errText(e)}`)
        }
      } else log('info', `system schema version ${migration.to} (up to date)`)
    }
    const old = state.db
    state.db = db
    state.meta = meta
    state.settings = settings
    state.location = `${version} at ${settings.host}:${settings.port}/${settings.database}`
    delete state.databaseError
    delete state.unavailable
    security.invalidate()
    await connections.reset(DEFAULT_CONNECTION_ID)
    if (old && old !== db) await old.close().catch(() => {})
    if (o.persist) {
      const prev = readServerJson(config)
      writeServerJson(config, {
        ...prev,
        defaultConnection: { ...settings, passwordSealed: secrets.encrypt(password) },
      })
    }
    try {
      await meta.sessions.purgeExpired()
    } catch {
      /* not important */
    }
    // older installations: the marker is written the first time a database with users is opened
    try {
      if (!setupCompleteFlag() && (await meta.users.count()) > 0) markSetupComplete()
    } catch {
      /* decided again on the next start */
    }
  }

  let completeCache: boolean | null = null
  function setupCompleteFlag(): boolean {
    if (completeCache === null) completeCache = readServerJson(config).setupComplete === true
    return completeCache
  }
  function markSetupComplete(value = true): void {
    completeCache = value
    try {
      const prev = readServerJson(config)
      if ((prev.setupComplete === true) !== value) {
        const next = { ...prev }
        if (value) next.setupComplete = true
        else delete next.setupComplete
        writeServerJson(config, next)
      }
    } catch (e) {
      log('warn', `could not record setupComplete in server.json: ${errText(e)}`)
    }
  }
  const databaseConfigured = (): boolean => !!envDatabase(procEnv) || !!readServerJson(config).defaultConnection

  /** one attempt to open the configured database (env first, then server.json); false when none is configured */
  async function connectConfigured(): Promise<boolean> {
    const fromEnv = envDatabase(procEnv)
    if (fromEnv) {
      await configureDatabase(fromEnv.settings, fromEnv.password, { createDatabase: true, persist: false })
      return true
    }
    const sj = readServerJson(config).defaultConnection
    if (!sj) return false
    let password = ''
    try {
      password = sj.passwordSealed ? secrets.decrypt(sj.passwordSealed) : ''
    } catch {
      throw Object.assign(new HttpError(503, 'unavailable', 'The saved database password cannot be decrypted (was workspace/.secret-key replaced?). Run the database setup again.'), { permanent: true })
    }
    await configureDatabase({ host: sj.host, port: Number(sj.port) || 3306, database: sj.database, user: sj.user, ssl: !!sj.ssl }, password, { persist: false })
    return true
  }

  function failed(e: unknown): void {
    state.databaseError = e instanceof HttpError ? e.message : 'The database could not be opened.'
    state.unavailable = true
  }

  /** background reconnect with backoff; stops when connected, when another setup succeeded, or on close() */
  function scheduleRetry(attempt: number): void {
    if (closed || state.meta) return
    if (!retryPromise) retryPromise = new Promise<void>((r) => (retryResolve = r))
    const delay = retryDelayMs(attempt)
    retryTimer = setTimeout(async () => {
      retryTimer = null
      if (closed || state.meta) return stopRetry()
      try {
        await connectConfigured()
        log('info', `database connected after ${attempt + 1} retr${attempt ? 'ies' : 'y'}: ${state.location}`)
        stopRetry()
      } catch (e) {
        failed(e)
        if (state.incompatible || (e as { permanent?: boolean }).permanent) {
          log('error', `database retry stopped: ${state.databaseError}`)
          return stopRetry()
        }
        if (attempt < 3 || attempt % 10 === 0) log('warn', `database still not available (retrying in ${Math.round(retryDelayMs(attempt + 1) / 1000)} s): ${state.databaseError}`)
        scheduleRetry(attempt + 1)
      }
    }, delay)
    retryTimer.unref()
  }
  function stopRetry(): void {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    const r = retryResolve
    retryResolve = null
    retryPromise = null
    r?.()
  }

  async function boot(): Promise<void> {
    try {
      await connectConfigured()
    } catch (e) {
      failed(e)
      log('warn', `database not available: ${state.databaseError}`)
      if (!state.incompatible && !(e as { permanent?: boolean }).permanent) {
        log('info', 'retrying the database connection in the background (no restart needed)')
        scheduleRetry(0)
      }
    }
    if (!purgeTimer) {
      purgeTimer = setInterval(() => {
        state.meta?.sessions.purgeExpired().catch(() => {})
      }, 60 * 60 * 1000)
      purgeTimer.unref()
    }
  }

  async function close(): Promise<void> {
    closed = true
    stopRetry()
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
    retrying: () => retryPromise,
    close,
    setupCode,
    setupComplete: setupCompleteFlag,
    markSetupComplete,
    databaseConfigured,
  }
  return services
}
