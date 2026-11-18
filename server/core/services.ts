/**
 * Services container + database bootstrap (server.json / APPBUILDER_DB_* env) and the setup step that
 * (re)configures the default store. `meta` / `data` throw 503 while no database is configured.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomInt, timingSafeEqual } from 'node:crypto'
import { HttpError } from './contracts.ts'
import type {
  ConnectorEnv, DatabaseSettings, InstallStore, MetaStore, MigrationSummary, ServerConfig, Services, SqlDb,
} from './contracts.ts'
import { createPgDb, friendlyConnectionError, isPgError, withClient } from '../connectors/postgres/db.ts'
import { flushAllFiles } from '../connectors/files/index.ts'
import { createSecretBox, loadSecretKey } from './secrets.ts'
import { SCHEMA_VERSION, SchemaTooNewError, UnsuitableDatabaseError, createMetaStore } from './meta-store.ts'
import { DEFAULT_ENVIRONMENT_ID, currentEnvironment, runInEnvironment } from './env-context.ts'
import { createInstallStore } from './install-store.ts'
import { createEnvironmentManager, maxEnvironments, moveLegacyWorkspace } from './environments.ts'
import { createBackupService, type BackupServiceImpl } from './backup/service.ts'
import { createSecurityEngine } from './security.ts'
import { createConnectionManager, DEFAULT_CONNECTION_ID, FILES_CONNECTION_ID } from './connections.ts'
import { createDataService } from './data.ts'
import { createAttachmentStore } from './attachment-store.ts'
import { envDatabase, readServerJson, writeServerJson } from './config.ts'
import { errText, log, nowIso, uid } from './util.ts'
import { createKernel } from './kernel.ts'
import type { Kernel } from './kernel.ts'
import { watchSessions } from './live/session-events.ts'
import { createCollab, registerCollabJobs } from './collab.ts'
import { setNextNumberProvider } from './event-fx.ts'
import type { Collab } from './collab.ts'

export type SqlDbFactory = (settings: DatabaseSettings, password: string) => SqlDb

export interface CoreState {
  db: SqlDb | null
  meta: MetaStore | null
  /** schema ab: environment registry, access, install audit */
  install: InstallStore | null
  settings: DatabaseSettings | null
  /** the password of the system database (the default connection of every environment uses it) */
  password?: string
  /** e.g. "PostgreSQL 16.4 at 127.0.0.1:5432/appbuilder" */
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

/**
 * file: APPBUILDER_SETUP_CODE_FILE (set by the installers, package L): the printed code is also written there (owner-only
 * file in the workspace) so an administrator finds it without reading the service log; removed when the code is rotated
 * after the first administrator exists.
 */
function createSetupCode(port: number, file?: string): SetupCode {
  let code: string | null = null
  const norm = (v: string) => v.replace(/[\s-]/g, '').toUpperCase()
  const writeFile = (c: string | null) => {
    if (!file) return
    try {
      if (c === null) fs.rmSync(file, { force: true })
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, `${c.slice(0, 4)}-${c.slice(4)}\nOpen http://localhost:${port}/ on the server and type this code in the setup screen. It changes at every start; this file is removed once the first administrator exists.\n`, { mode: 0o600 })
      }
    } catch (e) {
      log('warn', `could not write the setup code file ${file}: ${errText(e)}`)
    }
  }
  return {
    current: () => code,
    issue(o = {}) {
      code = newSetupCode()
      writeFile(o.print === false ? null : code)
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
  environments: ReturnType<typeof createEnvironmentManager>
  /** backups and restores (backup/service.ts; package J) */
  backup: BackupServiceImpl
  /** the install store (503 while no database is configured) */
  install: InstallStore
  /** (re)writes the built-in connections (default database, data files) of the current environment */
  ensureBuiltinConnections(): Promise<void>
  security: ReturnType<typeof createSecurityEngine>
  data: ReturnType<typeof createDataService>
  /** event and job kernel: job queue and worker, schedules, outbox, table events (kernel.ts) */
  kernel: Kernel
  /** core data model at run time: system-table hooks, timeline, number sequences (collab.ts) */
  collab: Collab
  connections: ReturnType<typeof createConnectionManager>
  /** test + connect + migrate the default store; persist=true seals the password into server.json */
  configureDatabase(settings: DatabaseSettings, password: string, opts: { createDatabase?: boolean; persist: boolean }): Promise<void>
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

const DB_NAME_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/

const defaultFactory: SqlDbFactory = (settings, password) => createPgDb(settings, password, { onError: (e) => log('warn', `database pool: ${e.message}`) })

/** the system tables could not be created: say why in words the administrator can act on */
function migrationProblem(e: unknown, settings: DatabaseSettings): HttpError {
  if (e instanceof UnsuitableDatabaseError) return new HttpError(422, 'invalid', e.message, 'database')
  if (isPgError(e) && e.code === '42501') {
    return new HttpError(422, 'invalid', `User "${settings.user}" may not create schemas in the database "${settings.database}". Make the user the owner (ALTER DATABASE ${settings.database} OWNER TO ${settings.user}) or run GRANT CREATE ON DATABASE ${settings.database} TO ${settings.user}, then try again.`, 'user')
  }
  return new HttpError(500, 'storage', 'Could not create the system tables in this database (check the user\'s privileges).')
}

export function createServices(config: ServerConfig, opts: { env?: NodeJS.ProcessEnv; sqlDbFactory?: SqlDbFactory; fetch?: typeof fetch } = {}): CoreServices {
  const procEnv = opts.env ?? process.env
  const sqlDbFactory = opts.sqlDbFactory ?? defaultFactory
  const secrets = createSecretBox(loadSecretKey(config.workspaceDir, procEnv))
  const state: CoreState = { db: null, meta: null, install: null, settings: null, location: null }
  let purgeTimer: NodeJS.Timeout | null = null
  let retryTimer: NodeJS.Timeout | null = null
  let retryPromise: Promise<void> | null = null
  let retryResolve: (() => void) | null = null
  let closed = false
  const setupCode = createSetupCode(config.port, procEnv.APPBUILDER_SETUP_CODE_FILE || undefined)

  const getMeta = (): MetaStore => {
    if (!state.meta) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return state.meta
  }

  const environments = createEnvironmentManager({ install: () => state.install, workspaceDir: config.workspaceDir, max: maxEnvironments(procEnv) })
  // the data files folder is the current environment's (workspace/env/<id>/files); the ConnectionManager copies this
  // object per environment and connection, so each connector instance keeps the folder of its own environment
  const env: ConnectorEnv = {
    systemDb: () => state.db,
    workspaceDir: config.workspaceDir,
    get filesDir() {
      return environments.dirs(currentEnvironment().id).files
    },
    fetch: opts.fetch ?? globalThis.fetch,
    log: (level, msg) => log(level, msg),
  }
  const security = createSecurityEngine(getMeta)
  // every role / user / table change invalidates the security cache: access to environments follows roles, so the
  // environment registry cache goes with it
  const invalidateSecurity = security.invalidate
  security.invalidate = (scope) => {
    invalidateSecurity(scope)
    environments.invalidate()
    // table definitions feed the event rules (formula columns, rollups)
    kernelRef?.invalidate()
  }
  let kernelRef: { invalidate(): void } | null = null
  const connections = createConnectionManager(getMeta, env)
  const attachments = createAttachmentStore(() => environments.dirs(currentEnvironment().id).attachments, () => currentEnvironment().id)
  const data = createDataService({ meta: getMeta, connections, attachments, log: env.log, hooks: () => (state.db ? kernel.hooks : null), system: () => (state.db ? collab.hooks : null) })
  const kernel = createKernel({
    db: () => state.db,
    listenSettings: () => (state.settings ? { settings: state.settings, password: state.password ?? '' } : null),
    meta: getMeta,
    data: () => data,
    forUser: (u) => security.forUser(u),
    environments: async () => (state.install ? (await environments.list()).filter((e) => e.state === 'ready').map((e) => ({ id: e.id, schema: e.schema })) : []),
    removeFile: (key) => attachments.remove(key),
    sweepAttachments: async (graceMs) => (await import('./attachments.ts')).sweepOrphanAttachments(services, graceMs),
    log: (level, msg) => log(level, msg),
  })
  kernelRef = kernel
  // backups and restores (package J): registers its job types on the kernel before the worker starts
  const backup = createBackupService({ get: () => services, kernel, env: procEnv })
  // core data model (P0-N): system-table hooks, polymorphic cascade, number sequences, timeline and notification jobs
  const collab = createCollab({
    db: () => state.db,
    meta: getMeta,
    data: () => data,
    forUser: (u) => security.forUser(u),
    notifications: () => services.notifications,
    enqueue: async (type, payload, o) => { await kernel.jobs.enqueue(type, payload, { priority: 1, ...(o?.delayMs ? { delayMs: o.delayMs } : {}) }) },
    log: (level, msg) => log(level, msg),
  })
  registerCollabJobs(kernel, collab)
  setNextNumberProvider((name) => collab.nextNumber(name))

  /** every environment's conn_default points at the system database (its tables live in that environment's schema) */
  async function ensureBuiltinConnections(meta: MetaStore, settings: DatabaseSettings, password: string): Promise<void> {
    const all = await meta.connections.list()
    const current = all.find((c) => c.id === DEFAULT_CONNECTION_ID)
    const hasOtherDefault = all.some((c) => c.isDefault && c.id !== DEFAULT_CONNECTION_ID)
    const s: Record<string, string> = {
      host: settings.host, port: String(settings.port), database: settings.database, user: settings.user, ssl: settings.ssl ? 'true' : 'false',
    }
    let name = current?.name ?? 'Default database'
    if (!current && all.some((c) => c.name.toLowerCase() === name.toLowerCase())) name = `Default database (${settings.database})`
    await meta.connections.upsert({
      id: DEFAULT_CONNECTION_ID, name, connector: 'postgres', status: 'connected', settings: s, secret: password,
      isDefault: current ? !!current.isDefault : !hasOtherDefault, scope: 'server',
    })
    if (!all.some((c) => c.id === FILES_CONNECTION_ID)) {
      let fname = 'Data files'
      if (all.some((c) => c.name.toLowerCase() === fname.toLowerCase())) fname = 'Data files (device)'
      await meta.connections.upsert({ id: FILES_CONNECTION_ID, name: fname, connector: 'files', status: 'connected', settings: {}, isDefault: false, scope: 'device' })
    }
  }

  /** CREATE DATABASE (UTF8) through the maintenance database; false when it already exists */
  async function createDatabaseIfMissing(settings: DatabaseSettings, password: string): Promise<boolean> {
    let lastError: unknown = null
    for (const maintenance of ['postgres', 'template1']) {
      try {
        return await withClient(settings, password, maintenance, async (c) => {
          const has = await c.query('SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1', [settings.database])
          if (has.rowCount) return false
          // the name is validated (DB_NAME_RE) and quoted
          await c.query(`CREATE DATABASE "${settings.database}" ENCODING 'UTF8' TEMPLATE template0`)
          return true
        })
      } catch (e) {
        lastError = e
        // the maintenance database itself is missing or closed to this user: try the next one
        if (isPgError(e) && (e.code === '3D000' || e.code === '42501')) continue
        throw e
      }
    }
    throw lastError
  }

  async function configureDatabase(settings: DatabaseSettings, password: string, o: { createDatabase?: boolean; persist: boolean }): Promise<void> {
    if (!DB_NAME_RE.test(settings.database)) throw new HttpError(422, 'invalid', 'The database name may contain letters, digits, _ and $ only (not starting with a digit or $).', 'database')
    if (o.createDatabase) {
      try {
        if (await createDatabaseIfMissing(settings, password)) log('info', `created the database "${settings.database}"`)
      } catch (e) {
        // the user may lack CREATEDB while the database exists: the connect below decides (and explains)
        const why = isPgError(e) && e.code === '42501' ? `user "${settings.user}" may not create databases` : friendlyConnectionError(e, settings, password)
        log('warn', `CREATE DATABASE skipped: ${why}`)
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
    const meta = watchSessions(createMetaStore(db, secrets))
    const install = createInstallStore(db)
    let migration: MigrationSummary | undefined
    // a server upgrade: an install backup of the database as it is, before the first migration step (package J)
    try {
      const has = await db.query<{ ok: boolean }>(`SELECT to_regclass('ab.settings') IS NOT NULL AS ok`)
      const v = has[0]?.ok ? await db.query<{ v: string | null }>(`SELECT v FROM "ab"."settings" WHERE k = 'schemaVersion'`) : []
      const from = Number(v[0]?.v) || 0
      if (from >= 4 && from < SCHEMA_VERSION) await backup.beforeMigration(db, { settings, password }, from)
    } catch (e) {
      await db.close().catch(() => {})
      log('error', `DATABASE NOT UPGRADED: the backup before the schema upgrade failed: ${errText(e)}`)
      throw Object.assign(new HttpError(503, 'unavailable', `The database needs an upgrade, and the backup taken before upgrading failed: ${errText(e)}. Fix the cause (disk space, the backup folder), or start once with APPBUILDER_MIGRATION_BACKUP=skip to upgrade without that backup.`), { permanent: true })
    }
    try {
      migration = (await meta.migrate()) ?? undefined
      // the built-in connections of every usable environment (password or host may have changed)
      for (const e of await install.environments.list()) {
        if (e.state !== 'ready') continue
        try {
          await runInEnvironment(e.id, () => ensureBuiltinConnections(meta, settings, password))
        } catch (err) {
          if (e.id === DEFAULT_ENVIRONMENT_ID) throw err
          log('error', `environment ${e.id}: could not update its built-in connections: ${errText(err)}`)
        }
      }
    } catch (e) {
      await db.close().catch(() => {})
      if (e instanceof SchemaTooNewError) {
        state.incompatible = { database: e.database, server: e.server }
        log('error', `DATABASE NOT USED: ${e.message}`)
        throw new HttpError(503, 'unavailable', 'The database was upgraded by a newer version of Appbuilder. Run that version, or restore a backup taken before the upgrade.')
      }
      log('error', `system schema migration failed: ${errText(e)}`)
      throw migrationProblem(e, settings)
    }
    delete state.incompatible
    if (migration) {
      state.migration = migration
      if (migration.from !== migration.to) {
        log('info', `system schema migrated from version ${migration.from} to ${migration.to}: ${migration.steps.join('; ') || 'no changes'}`)
        try {
          await meta.audit({ userId: null, action: 'schema.migrate', details: migration })
          await install.audit({ userId: null, action: 'schema.migrate', details: migration })
        } catch (e) {
          log('error', `audit write failed (schema.migrate): ${errText(e)}`)
        }
      } else log('info', `system schema version ${migration.to} (up to date)`)
      for (const f of migration.environments ?? []) {
        if (!f.ok) log('error', `ENVIRONMENT ${f.id} NOT AVAILABLE: ${f.error}`)
      }
      if ((migration.environments ?? []).some((f) => !f.ok)) {
        await install.audit({ userId: null, action: 'environment.migrate_failed', details: (migration.environments ?? []).filter((f) => !f.ok) }).catch(() => {})
      }
    }
    // version 5 layout: the files of an older install belong to the Default environment
    moveLegacyWorkspace({ filesDir: config.filesDir, attachmentsDir: config.attachmentsDir }, environments.dirs(DEFAULT_ENVIRONMENT_ID), (l, m) => log(l, m))
    const old = state.db
    state.db = db
    state.meta = meta
    state.install = install
    state.settings = settings
    state.password = password
    environments.invalidate()
    state.location = `${version} at ${settings.host}:${settings.port}/${settings.database}`
    delete state.databaseError
    delete state.unavailable
    security.invalidate('all')
    for (const e of await install.environments.list().catch(() => [])) await runInEnvironment(e.id, () => connections.reset(DEFAULT_CONNECTION_ID)).catch(() => {})
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
    // backups: settings, interrupted backups and restores, the backup folder, schedules (package J)
    await backup.onDatabaseReady().catch((e) => log('warn', `backups: ${errText(e)}`))
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
    await configureDatabase({ host: sj.host, port: Number(sj.port) || 5432, database: sj.database, user: sj.user, ssl: !!sj.ssl }, password, { persist: false })
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
    // running jobs get a moment to finish; the rest are released for the next start
    await kernel.stop(Number(procEnv.APPBUILDER_JOBS_STOP_GRACE_MS) || 10_000).catch((e) => log('warn', `job worker stop: ${errText(e)}`))
    if (purgeTimer) clearInterval(purgeTimer)
    purgeTimer = null
    try {
      await flushAllFiles()
    } catch (e) {
      log('warn', `flushing data files failed: ${errText(e)}`)
    }
    await connections.closeAll()
    const db = state.db
    state.db = null
    state.meta = null
    state.install = null
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
    kernel,
    collab,
    env,
    environment: currentEnvironment,
    environments,
    backup,
    get install() {
      if (!state.install) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
      return state.install
    },
    async ensureBuiltinConnections() {
      if (!state.settings) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
      await ensureBuiltinConnections(getMeta(), state.settings, state.password ?? '')
    },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      const db = state.db
      if (!db) return fn()
      try {
        return await db.tx(() => fn())
      } finally {
        // caches filled inside the transaction may hold rolled-back rows
        security.invalidate()
      }
    },
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
