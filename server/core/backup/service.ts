/**
 * The backup service (docs/admin/backup-and-restore.md, docs/dev/backup.md): settings, the catalogue of archives in the
 * backup folder, backups as jobs (manual "Back up now", schedules, automatic snapshots before risky changes), retention,
 * the off-site copy, verification, restore tests, restores (environment in place or as a new one, selected tables),
 * browsing a backup, health and notifications. The archive work itself is engine.ts.
 *
 * One backup or restore runs at a time per install: an in-process queue plus a PostgreSQL advisory lock (two servers on
 * one database wait for each other).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type pg from 'pg'
import { HttpError } from '../contracts.ts'
import type { EnvironmentRecord, EnvironmentRef, SnapshotResult, SqlDb, UserContext } from '../contracts.ts'
import type { CoreServices } from '../services.ts'
import type { Kernel } from '../kernel.ts'
import type { LiveHub } from '../live/hub.ts'
import type { TableDef } from '../../../src/platform/contracts.ts'
import type {
  BackupContents, BackupHealth, BackupInfo, BackupKind, BackupOp, BackupProgress, BackupRowsPage, BackupSettings, BackupSettingsInput,
  BackupState, BackupSummary, BackupTrigger, RestoreRequest, TableRestorePlan, TableRestorePlanItem, TableRestoreRequest,
} from '../../../src/platform/backup.ts'
import { DEFAULT_ENVIRONMENT_ID, environmentSchema, runInEnvironment } from '../env-context.ts'
import { SCHEMA_VERSION, migrateEnvironmentSchema } from '../meta-store.ts'
import { DEFAULT_CONNECTION_ID, FILES_CONNECTION_ID } from '../connections.ts'
import { CHAT_SYSTEM_TABLES } from '../chat/ddl.ts'
import { flushFiles, forgetFilesFolder } from '../../connectors/files/index.ts'
import { createTableSql } from '../../connectors/postgres/sql.ts'
import { uniqueIdentifier } from '../../routes/meta/util.ts'
import { emitTableChange } from '../live/changes.ts'
import { JobError } from '../jobs.ts'
import { errText, log, uid } from '../util.ts'
import { ArchiveError, isEncryptedFile, sha256OfFile } from './archive.ts'
import {
  closeAfter, connect, createArchive, extractEnvironmentFiles, openArchive, restoreSchema, schemaOf, tableData, verifyArchive,
  type BackupArchive, type EnvSource, type Manifest, type Progress,
} from './engine.ts'
import { copyColumns, parseCopyLine, preDataSql, qi, readCopyLines, copyInto } from './dbdump.ts'
import { findPgTools, toolProblem } from './pgtools.ts'
import { DEFAULT_RETENTION, decideRetention, type RetentionPolicy } from './retention.ts'
import { hostingFor, isInside } from '../hosting/settings.ts'

export const BACKUP_JOB = 'backup.run'
export const RESTORE_TEST_JOB = 'backup.restore-test'
export const HEALTH_JOB = 'backup.health'
export const CONFIG_KEY = 'backup.config'
const STALE_NOTICE_KEY = 'backup.staleNoticeOn'
const LOCK_KEY = 'appbuilder.backup'
export const EXT = '.abbak'
export const MIN_PASSPHRASE = 10
const LOCAL_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } })()

/* ------------------------------------------------------------------ settings */

interface StoredConfig {
  enabled: boolean
  folder: string | null
  method: 'auto' | 'pg_dump' | 'builtin'
  pgBinPath: string | null
  install: { enabled: boolean; cron: string; timeZone: string; includeKey: boolean }
  environments: Record<string, { enabled: boolean; cron: string; timeZone: string }>
  retention: RetentionPolicy
  passphraseSealed: string | null
  snapshots: { beforeUpgrade: boolean; beforeDelete: boolean; beforeRestore: boolean; beforeMigration: boolean }
  offsite: { enabled: boolean; folder: string | null }
  restoreTest: { enabled: boolean; cron: string; timeZone: string }
  staleHours: number
}

export function defaultConfig(): StoredConfig {
  return {
    enabled: true,
    folder: null,
    method: 'auto',
    pgBinPath: null,
    install: { enabled: true, cron: '0 2 * * *', timeZone: LOCAL_TZ, includeKey: false },
    environments: {},
    retention: { ...DEFAULT_RETENTION },
    passphraseSealed: null,
    snapshots: { beforeUpgrade: true, beforeDelete: true, beforeRestore: true, beforeMigration: true },
    offsite: { enabled: false, folder: null },
    restoreTest: { enabled: false, cron: '0 4 * * 0', timeZone: LOCAL_TZ },
    staleHours: 36,
  }
}

function mergeConfig(raw: unknown): StoredConfig {
  const d = defaultConfig()
  if (!raw || typeof raw !== 'object') return d
  const r = raw as Partial<StoredConfig>
  return {
    ...d, ...r,
    install: { ...d.install, ...(r.install ?? {}) },
    environments: { ...(r.environments ?? {}) },
    retention: { ...d.retention, ...(r.retention ?? {}) },
    snapshots: { ...d.snapshots, ...(r.snapshots ?? {}) },
    offsite: { ...d.offsite, ...(r.offsite ?? {}) },
    restoreTest: { ...d.restoreTest, ...(r.restoreTest ?? {}) },
  }
}

/* ------------------------------------------------------------------ rows */

type Row = Record<string, unknown>
const iso = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : new Date(v as string).toISOString())
const str = (v: unknown): string | undefined => (v === null || v === undefined || v === '' ? undefined : String(v))
const json = <T>(v: unknown): T | undefined => (v === null || v === undefined ? undefined : (typeof v === 'string' ? JSON.parse(v) : v) as T)

function toInfo(r: Row, names: Map<string, string>): BackupInfo {
  const by = str(r.created_by)
  return {
    id: String(r.id), fileName: String(r.file_name), kind: r.kind as BackupKind,
    ...(str(r.environment_id) ? { environmentId: str(r.environment_id) } : {}),
    ...(str(r.environment_name) ? { environmentName: str(r.environment_name) } : {}),
    trigger: r.trigger as BackupTrigger, state: r.state as BackupState,
    ...(str(r.method) ? { method: r.method as 'pg_dump' | 'builtin' } : {}),
    encrypted: !!r.encrypted, includesKey: !!r.includes_key,
    ...(r.size_bytes !== null && r.size_bytes !== undefined ? { sizeBytes: Number(r.size_bytes) } : {}),
    ...(str(r.sha256) ? { sha256: str(r.sha256) } : {}),
    createdOn: iso(r.created_on)!,
    ...(iso(r.finished_on) ? { finishedOn: iso(r.finished_on) } : {}),
    createdBy: by ? { id: by, name: names.get(by) ?? by } : null,
    ...(str(r.app_version) ? { appVersion: str(r.app_version) } : {}),
    ...(r.schema_version !== null && r.schema_version !== undefined ? { schemaVersion: Number(r.schema_version) } : {}),
    ...(r.summary ? { summary: json<BackupSummary>(r.summary) } : {}),
    ...(str(r.error) ? { error: str(r.error) } : {}),
    ...(iso(r.verified_on) ? { verifiedOn: iso(r.verified_on) } : {}),
    ...(str(r.verify_error) ? { verifyError: str(r.verify_error) } : {}),
    ...(iso(r.restore_tested_on) ? { restoreTestedOn: iso(r.restore_tested_on) } : {}),
    ...(str(r.restore_test_error) ? { restoreTestError: str(r.restore_test_error) } : {}),
    ...(r.offsite ? { offsite: json<BackupInfo['offsite']>(r.offsite) } : {}),
    pinned: !!r.pinned,
    ...(str(r.note) ? { note: str(r.note) } : {}),
    ...(r.progress && ['queued', 'running', 'verifying'].includes(String(r.state)) ? { progress: json<BackupProgress>(r.progress) } : {}),
  }
}

function toOp(r: Row): BackupOp {
  const result = json<Record<string, unknown>>(r.result)
  return {
    id: String(r.id), kind: r.kind as BackupOp['kind'],
    ...(str(r.backup_id) ? { backupId: str(r.backup_id) } : {}),
    ...(str(r.mode) ? { mode: str(r.mode) } : {}),
    ...(str(r.source_environment) ? { sourceEnvironment: str(r.source_environment) } : {}),
    ...(str(r.target_environment) ? { targetEnvironment: str(r.target_environment) } : {}),
    state: r.state as BackupOp['state'],
    ...(str(r.phase) ? { phase: str(r.phase) } : {}),
    ...(r.progress ? { progress: json<BackupProgress>(r.progress) } : {}),
    startedOn: iso(r.started_on)!,
    ...(iso(r.finished_on) ? { finishedOn: iso(r.finished_on) } : {}),
    ...(str(r.created_by) ? { createdBy: str(r.created_by) } : {}),
    ...(str(r.error) ? { error: str(r.error) } : {}),
    ...(result?.backupFailed ? { backupFailed: true } : {}),
    ...(result ? { result } : {}),
  }
}

/** a SqlDb over one client that is already inside a transaction (nested tx() = savepoint) */
function clientDb(c: pg.Client): SqlDb {
  let sp = 0
  const db: SqlDb = {
    dialect: 'postgres',
    async query<T>(sql: string, params?: unknown[]) { return (await c.query(sql, params as unknown[])).rows as T[] },
    async exec(sql, params) { return { affectedRows: (await c.query(sql, params as unknown[])).rowCount ?? 0 } },
    async tx<T>(fn: (d: SqlDb) => Promise<T>): Promise<T> {
      const name = `ab_sp_${++sp}`
      await c.query(`SAVEPOINT ${name}`)
      try {
        const r = await fn(db)
        await c.query(`RELEASE SAVEPOINT ${name}`)
        return r
      } catch (e) {
        await c.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {})
        throw e
      }
    },
    async serverVersion() { return 'PostgreSQL' },
    async close() { /* owned by the caller */ },
  }
  return db
}

const fileNameFor = (scope: string, at: Date, id: string): string =>
  `appbuilder-${scope}-${at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-')}-${id.slice(-6)}${EXT}`

const errMessage = (e: unknown): string => (e instanceof HttpError || e instanceof ArchiveError ? e.message : errText(e))

/* ------------------------------------------------------------------ the service */

export interface BackupServiceDeps {
  get(): CoreServices
  kernel: Kernel
  env: NodeJS.ProcessEnv
}

export type BackupServiceImpl = ReturnType<typeof createBackupService>

export function createBackupService(deps: BackupServiceDeps) {
  const env = deps.env
  /** tests only: make backups fail, stop restores half-way */
  const testHooks: { failAfterTables?: number; failBackup?: string } = {}
  let live: LiveHub | null = null
  let cached: StoredConfig = defaultConfig()
  let ready = false
  /** passphrases of queued manual backups (never stored): lost on restart, the backup then fails and says so */
  const pendingPass = new Map<string, string>()
  /** download tickets (one use, one minute) */
  const tickets = new Map<string, { backupId: string; userId: string; until: number }>()
  const s = () => deps.get()
  const db = (): SqlDb => {
    const d = s().state.db
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }
  const conn = () => {
    const st = s().state
    if (!st.settings) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return { settings: st.settings, password: st.password ?? '' }
  }

  /* ---------------------------------------------------------------- exclusive section */

  let chain: Promise<unknown> = Promise.resolve()
  let busy: string | null = null
  function exclusive<T>(what: string, fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      busy = what
      const lock = await connect(conn())
      try {
        await lock.query('SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext($1))', [LOCK_KEY])
        return await fn()
      } finally {
        busy = null
        await lock.query('SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1))', [LOCK_KEY]).catch(() => {})
        await lock.end().catch(() => {})
      }
    }
    const p = chain.then(run, run)
    chain = p.catch(() => {})
    return p
  }

  /* ---------------------------------------------------------------- settings */

  async function loadConfig(): Promise<StoredConfig> {
    const r = await db().query<Row>(`SELECT v FROM "ab"."settings" WHERE k = $1`, [CONFIG_KEY])
    cached = mergeConfig(r.length ? JSON.parse(String(r[0].v)) : null)
    return cached
  }
  async function storeConfig(c: StoredConfig): Promise<void> {
    await db().exec(`INSERT INTO "ab"."settings" (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [CONFIG_KEY, JSON.stringify(c)])
    cached = c
  }
  const defaultFolder = () => path.join(s().config.workspaceDir, 'backups')
  /**
   * H-B: APPBUILDER_INSTANCE_DIR (a hosted install): the one folder the install writes to. Backup folders typed in the
   * Admin console must be inside it, and the PostgreSQL tools folder (it names programs the server runs) belongs to the
   * operator: a stored value is ignored and it cannot be changed here. Unset (on-premises): unchanged.
   */
  const instanceDir = (): string | null => {
    const fromEnv = env.APPBUILDER_INSTANCE_DIR?.trim()
    return hostingFor(s()).instanceDir ?? (fromEnv ? path.resolve(fromEnv) : null)
  }
  const folderAllowed = (p: string | null | undefined): boolean => !p || !instanceDir() || isInside(p, instanceDir()!)
  const pgBinOf = (c: StoredConfig): string | null => (instanceDir() ? null : c.pgBinPath)
  const folderOf = (c: StoredConfig): string => path.resolve(env.APPBUILDER_BACKUP_DIR || (folderAllowed(c.folder) ? c.folder : null) || defaultFolder())

  /** a folder the server may write archives to: absolute, not served by the web server, not inside an environment folder */
  async function checkFolder(raw: string, what: string): Promise<string> {
    if (!path.isAbsolute(raw)) throw new HttpError(422, 'invalid', `The ${what} must be an absolute path (for example D:\\Backups\\Appbuilder or /srv/backups/appbuilder).`, 'folder')
    const p = path.resolve(raw)
    // before anything is created or written there
    if (!folderAllowed(p)) throw new HttpError(422, 'invalid', `The ${what} must be inside this install's folder (${instanceDir()}): a hosted install writes nowhere else.`, 'folder')
    const cfg = s().config
    const inside = (child: string, parent: string) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)) }
    if (inside(p, cfg.distDir) || inside(cfg.distDir, p)) throw new HttpError(422, 'invalid', `The ${what} must not be inside the web folder (${cfg.distDir}).`, 'folder')
    if (inside(p, path.join(cfg.workspaceDir, 'env'))) throw new HttpError(422, 'invalid', `The ${what} must not be inside an environment's folder.`, 'folder')
    try {
      await fs.promises.mkdir(p, { recursive: true, mode: 0o700 })
      const probe = path.join(p, `.probe-${randomBytes(4).toString('hex')}`)
      await fs.promises.writeFile(probe, 'ok')
      await fs.promises.rm(probe, { force: true })
    } catch (e) {
      throw new HttpError(422, 'invalid', `The server cannot write to ${p}: ${errText(e)}`, 'folder')
    }
    return p
  }

  async function settingsView(c: StoredConfig = cached): Promise<BackupSettings> {
    const tools = await findPgTools(pgBinOf(c))
    let serverMajor: number | null = null
    try {
      const r = await db().query<{ n: string }>("SELECT current_setting('server_version_num') AS n")
      serverMajor = Math.floor(Number(r[0].n) / 10000)
    } catch { /* no database */ }
    const problem = serverMajor === null ? null : toolProblem(tools.dump, 'pg_dump', serverMajor)
    return {
      enabled: c.enabled, folder: folderOf(c), folderFromEnv: !!env.APPBUILDER_BACKUP_DIR, defaultFolder: defaultFolder(), method: c.method, pgBinPath: pgBinOf(c),
      tools: {
        pgDump: tools.dump ? { path: tools.dump.path, version: tools.dump.version } : null,
        pgRestore: tools.restore ? { path: tools.restore.path, version: tools.restore.version } : null,
        serverMajor, usable: !problem, problem,
      },
      install: { ...c.install }, environments: { ...c.environments }, retention: { ...c.retention }, passphraseSaved: !!c.passphraseSealed,
      snapshots: { ...c.snapshots }, offsite: { ...c.offsite }, restoreTest: { ...c.restoreTest }, staleHours: c.staleHours, timeZone: LOCAL_TZ,
    }
  }

  async function saveSettings(input: BackupSettingsInput, actor: UserContext): Promise<BackupSettings> {
    const c = await loadConfig()
    const next: StoredConfig = mergeConfig(JSON.parse(JSON.stringify(c)))
    const bad = (m: string, f?: string): never => { throw new HttpError(422, 'invalid', m, f) }
    const { parseCron, checkTimeZone } = await import('../cron.ts')
    const sched = (cur: { enabled: boolean; cron: string; timeZone: string }, p: Partial<{ enabled: boolean; cron: string; timeZone: string }> | undefined, field: string) => {
      if (!p) return cur
      const out = { ...cur }
      if (p.enabled !== undefined) out.enabled = p.enabled === true
      if (p.cron !== undefined) {
        try { parseCron(String(p.cron)) } catch (e) { bad(`${(e as Error).message}`, `${field}.cron`) }
        out.cron = String(p.cron).trim()
      }
      if (p.timeZone !== undefined) {
        try { checkTimeZone(String(p.timeZone)) } catch (e) { bad((e as Error).message, `${field}.timeZone`) }
        out.timeZone = String(p.timeZone)
      }
      return out
    }
    if (input.enabled !== undefined) next.enabled = input.enabled === true
    if (input.folder !== undefined) {
      if (env.APPBUILDER_BACKUP_DIR) bad('The backup folder is set by APPBUILDER_BACKUP_DIR on the server and cannot be changed here.', 'folder')
      next.folder = input.folder ? await checkFolder(String(input.folder), 'backup folder') : null
    }
    if (input.method !== undefined) {
      if (!['auto', 'pg_dump', 'builtin'].includes(input.method)) bad('method must be auto, pg_dump or builtin.', 'method')
      next.method = input.method
    }
    if (input.pgBinPath !== undefined) {
      if (input.pgBinPath && instanceDir()) bad('In a hosted install the PostgreSQL tools folder is set by the operator of the server and cannot be changed here.', 'pgBinPath')
      if (input.pgBinPath && !path.isAbsolute(input.pgBinPath)) bad('The PostgreSQL tools folder must be an absolute path.', 'pgBinPath')
      next.pgBinPath = input.pgBinPath || null
    }
    if (input.install) {
      next.install = { ...sched(next.install, input.install, 'install'), includeKey: input.install.includeKey !== undefined ? input.install.includeKey === true : next.install.includeKey }
    }
    if (input.environments) {
      const known = new Set((await s().install.environments.list()).map((e) => e.id))
      for (const [id, v] of Object.entries(input.environments)) {
        if (v === null) { delete next.environments[id]; continue }
        if (!known.has(id)) bad(`There is no environment "${id}".`, 'environments')
        next.environments[id] = sched(next.environments[id] ?? { enabled: true, cron: '30 1 * * *', timeZone: LOCAL_TZ }, v, `environments.${id}`)
      }
    }
    if (input.retention) {
      for (const k of ['daily', 'weekly', 'monthly', 'snapshotDays'] as const) {
        const v = input.retention[k]
        if (v === undefined) continue
        if (!Number.isInteger(v) || v < 0 || v > 1000) bad(`retention.${k} must be a whole number from 0 to 1000.`, `retention.${k}`)
        next.retention[k] = v
      }
      if (next.retention.daily + next.retention.weekly + next.retention.monthly === 0) bad('Keep at least one daily, weekly or monthly backup.', 'retention')
    }
    if (input.passphrase !== undefined) {
      if (input.passphrase === null || input.passphrase === '') next.passphraseSealed = null
      else {
        if (typeof input.passphrase !== 'string' || input.passphrase.length < MIN_PASSPHRASE) bad(`A passphrase needs at least ${MIN_PASSPHRASE} characters.`, 'passphrase')
        next.passphraseSealed = s().secrets.encrypt(input.passphrase)
      }
    }
    if (input.snapshots) for (const k of Object.keys(next.snapshots) as (keyof StoredConfig['snapshots'])[]) if (input.snapshots[k] !== undefined) next.snapshots[k] = input.snapshots[k] === true
    if (input.offsite) {
      if (input.offsite.folder !== undefined) {
        if (input.offsite.folder) {
          const f = await checkFolder(String(input.offsite.folder), 'off-site folder')
          if (f === folderOf(next)) bad('The off-site folder must not be the backup folder itself.', 'offsite.folder')
          next.offsite.folder = f
        } else next.offsite.folder = null
      }
      if (input.offsite.enabled !== undefined) next.offsite.enabled = input.offsite.enabled === true
      if (next.offsite.enabled && !next.offsite.folder) bad('Choose the off-site folder first.', 'offsite.folder')
    }
    if (input.restoreTest) next.restoreTest = sched(next.restoreTest, input.restoreTest, 'restoreTest')
    if (input.staleHours !== undefined) {
      if (!Number.isInteger(input.staleHours) || input.staleHours < 1 || input.staleHours > 24 * 60) bad('staleHours must be between 1 and 1440.', 'staleHours')
      next.staleHours = input.staleHours
    }
    await storeConfig(next)
    await syncSchedules(next).catch((e) => log('warn', `backup schedules: ${errText(e)}`))
    const changed = Object.keys(input).filter((k) => k !== 'passphrase')
    await audit(actor.user.id, 'backup.settings', null, { changed, ...(input.passphrase !== undefined ? { passphrase: input.passphrase ? 'saved' : 'forgotten' } : {}) })
    return settingsView(next)
  }

  /* ---------------------------------------------------------------- catalogue */

  async function userNames(): Promise<Map<string, string>> {
    const rows = await db().query<Row>(`SELECT id, name FROM "ab"."users"`)
    return new Map(rows.map((r) => [String(r.id), String(r.name)]))
  }
  async function rowById(id: string): Promise<Row | null> {
    return (await db().query<Row>(`SELECT * FROM "ab"."backups" WHERE id = $1`, [id]))[0] ?? null
  }
  async function info(id: string): Promise<BackupInfo> {
    const r = await rowById(id)
    if (!r) throw new HttpError(404, 'not-found', 'There is no such backup.')
    return toInfo(r, await userNames())
  }
  async function setRow(id: string, patch: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(patch)
    if (!keys.length) return
    const sets = keys.map((k, i) => `${k} = $${i + 2}${['summary', 'offsite', 'progress'].includes(k) ? '::jsonb' : ''}`)
    const vals = keys.map((k) => (['summary', 'offsite', 'progress'].includes(k) && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k]))
    await db().exec(`UPDATE "ab"."backups" SET ${sets.join(', ')} WHERE id = $1`, [id, ...vals])
  }
  async function list(): Promise<BackupInfo[]> {
    const names = await userNames()
    const rows = await db().query<Row>(`SELECT * FROM "ab"."backups" ORDER BY created_on DESC, id DESC`)
    const items = rows.map((r) => toInfo(r, names))
    const d = decideRetention(items.map((i) => ({ id: i.id, createdOn: i.createdOn, trigger: i.trigger, state: i.state, pinned: i.pinned, scope: i.kind === 'install' ? 'install' : `env:${i.environmentId}` })), cached.retention, { timeZone: LOCAL_TZ })
    const keep = new Map(d.keep.map((k) => [k.id, k.reasons.join(', ')]))
    const prune = new Map(d.prune.map((p) => [p.id, p.reason]))
    for (const i of items) i.retention = keep.get(i.id) ?? (prune.has(i.id) ? `pruned at the next run: ${prune.get(i.id)}` : undefined)
    return items
  }

  async function opRow(id: string): Promise<Row | null> {
    return (await db().query<Row>(`SELECT * FROM "ab"."backup_ops" WHERE id = $1`, [id]))[0] ?? null
  }
  async function getOp(id: string): Promise<BackupOp> {
    const r = await opRow(id)
    if (!r) throw new HttpError(404, 'not-found', 'There is no such operation.')
    return toOp(r)
  }
  async function setOp(id: string, patch: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(patch)
    const sets = keys.map((k, i) => `${k} = $${i + 2}${['progress', 'result'].includes(k) ? '::jsonb' : ''}`)
    const vals = keys.map((k) => (['progress', 'result'].includes(k) && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k]))
    await db().exec(`UPDATE "ab"."backup_ops" SET ${sets.join(', ')} WHERE id = $1`, [id, ...vals])
    void pushOp(id)
  }
  async function newOp(o: { kind: BackupOp['kind']; backupId?: string; mode?: string; source?: string; target?: string; by?: string | null }): Promise<string> {
    const id = uid('bop')
    await db().exec(`INSERT INTO "ab"."backup_ops" (id, kind, backup_id, mode, source_environment, target_environment, state, phase, started_on, created_by) VALUES ($1, $2, $3, $4, $5, $6, 'running', 'starting', now(), $7)`,
      [id, o.kind, o.backupId ?? null, o.mode ?? null, o.source ?? null, o.target ?? null, o.by ?? null])
    void pushOp(id)
    return id
  }
  async function recentOps(): Promise<BackupOp[]> {
    return (await db().query<Row>(`SELECT * FROM "ab"."backup_ops" WHERE state = 'running' OR started_on > now() - interval '1 day' ORDER BY started_on DESC LIMIT 20`)).map(toOp)
  }

  /* ---------------------------------------------------------------- audit, live, notifications */

  async function audit(userId: string | null, action: string, environmentId: string | null, details: unknown): Promise<void> {
    try {
      await s().install.audit({ userId, action, environmentId, details })
    } catch (e) {
      log('error', `install audit write failed (${action}): ${errText(e)}`)
    }
  }
  let adminCache: { at: number; ids: string[] } | null = null
  async function installAdmins(): Promise<string[]> {
    if (adminCache && Date.now() - adminCache.at < 30_000) return adminCache.ids
    const rows = await db().query<Row>(`SELECT id FROM "ab"."users" WHERE is_install_admin AND status = 'active'`)
    adminCache = { at: Date.now(), ids: rows.map((r) => String(r.id)) }
    return adminCache.ids
  }
  async function push(ev: { backup?: BackupInfo; op?: BackupOp }): Promise<void> {
    if (!live) return
    try {
      for (const u of await installAdmins()) live.pushUser(u, { event: 'backup', ...ev })
    } catch { /* best effort */ }
  }
  async function pushOp(id: string): Promise<void> {
    if (!live) return
    const r = await opRow(id).catch(() => null)
    if (r) await push({ op: toOp(r) })
  }
  async function notifyAdmins(title: string, body: string): Promise<void> {
    const n = s().notifications
    if (!n) return
    try {
      await n.notify({ userIds: await installAdmins() }, { kind: 'system', title, body: body.slice(0, 900), link: '#admin-backups', source: 'system', environmentId: null })
    } catch (e) {
      log('warn', `backup notification failed: ${errText(e)}`)
    }
  }

  /** progress: stored at most every second, pushed at most every 300 ms */
  function progressFor(kind: 'backup' | 'op', id: string): (p: Progress) => void {
    let lastStore = 0
    let lastPush = 0
    return (p) => {
      const now = Date.now()
      const pr: BackupProgress = { phase: p.phase, done: p.done, total: p.total, ...(p.message ? { message: p.message } : {}), at: new Date().toISOString() }
      if (now - lastStore > 1000) {
        lastStore = now
        if (kind === 'backup') void setRow(id, { progress: pr }).catch(() => {})
        else void db().exec(`UPDATE "ab"."backup_ops" SET progress = $2::jsonb, phase = $3 WHERE id = $1`, [id, JSON.stringify(pr), p.phase]).catch(() => {})
      }
      if (now - lastPush > 300 && live) {
        lastPush = now
        if (kind === 'backup') {
          void rowById(id).then(async (r) => { if (r) await push({ backup: { ...toInfo(r, await userNames()), progress: pr, state: (r.state === 'queued' ? 'running' : r.state) as BackupState } }) }).catch(() => {})
        } else void opRow(id).then((r) => (r ? push({ op: { ...toOp(r), progress: pr } }) : undefined)).catch(() => {})
      }
    }
  }

  /* ---------------------------------------------------------------- environments in scope */

  async function envSources(scope: string): Promise<EnvSource[]> {
    const all = await s().install.environments.list()
    const pick = scope === 'install' ? all.filter((e) => e.state === 'ready') : all.filter((e) => e.id === scope)
    if (scope !== 'install') {
      const e = pick[0]
      if (!e) throw new HttpError(404, 'not-found', `There is no environment "${scope}".`)
      if (e.state !== 'ready') throw new HttpError(409, 'conflict', `"${e.name}" cannot be backed up while it is ${e.state}.`)
    }
    return pick.map((e) => ({ id: e.id, name: e.name, type: e.type, schema: e.schema, schemaVersion: e.schemaVersion || SCHEMA_VERSION, locked: e.locked, ...(e.description ? { description: e.description } : {}) }))
  }

  function summaryOf(m: Manifest): BackupSummary {
    const rowsOf = (schema: string) => m.schemas.find((x) => x.name === schema)?.tables.reduce((a, t) => a + t.rows, 0) ?? 0
    return {
      environments: m.environments.map((e) => ({
        id: e.id, name: e.name, type: e.type, tables: e.tables.length, rows: e.tables.reduce((a, t) => a + (t.rows ?? 0), 0),
        attachments: e.attachments.count, attachmentBytes: e.attachments.bytes, dataFiles: e.dataFiles.count, schemaVersion: e.schemaVersion,
      })),
      rows: m.schemas.reduce((a, x) => a + rowsOf(x.name), 0),
      warnings: m.warnings,
      ...(m.pgDump ? { pgDump: m.pgDump.version } : {}),
      server: m.server.version,
    }
  }

  /* ---------------------------------------------------------------- backup */

  interface BackupInput {
    id?: string
    scope: string
    trigger: BackupTrigger
    by: { id: string; name: string; email: string } | null
    note?: string
    passphrase?: string | null
    includeKey?: boolean
    jobId?: string
    signal?: AbortSignal
    /** tests */
    afterSnapshot?(): Promise<void>
  }

  async function createRow(i: { id: string; scope: string; trigger: BackupTrigger; by: string | null; note?: string; encrypted: boolean; includeKey: boolean; state: BackupState; jobId?: string }): Promise<string> {
    const at = new Date()
    const envName = i.scope === 'install' ? null : (await s().install.environments.get(i.scope))?.name ?? i.scope
    const fileName = fileNameFor(i.scope, at, i.id)
    await db().exec(
      `INSERT INTO "ab"."backups" (id, file_name, kind, environment_id, environment_name, trigger, state, encrypted, includes_key, created_on, created_by, note, job_id, app_version, schema_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [i.id, fileName, i.scope === 'install' ? 'install' : 'environment', i.scope === 'install' ? null : i.scope, envName, i.trigger, i.state, i.encrypted, i.includeKey, at, i.by, i.note ?? null, i.jobId ?? null, await appVersion(), SCHEMA_VERSION],
    )
    return fileName
  }

  async function appVersion(): Promise<string> {
    return (await import('../auth.ts')).serverVersion()
  }

  /** makes, verifies and records one backup; call inside exclusive() */
  async function performBackup(i: BackupInput): Promise<BackupInfo> {
    const cfg = await loadConfig()
    const id = i.id ?? uid('bk')
    const includeKey = i.scope === 'install' && !!i.includeKey
    let fileName: string
    const existing = i.id ? await rowById(i.id) : null
    if (existing) {
      fileName = String(existing.file_name)
      await setRow(id, { state: 'running', error: null, job_id: i.jobId ?? existing.job_id ?? null })
    } else {
      fileName = await createRow({ id, scope: i.scope, trigger: i.trigger, by: i.by?.id ?? null, note: i.note, encrypted: !!i.passphrase, includeKey, state: 'running', jobId: i.jobId })
    }
    const dir = folderOf(cfg)
    const file = path.join(dir, fileName)
    const started = Date.now()
    const progress = progressFor('backup', id)
    void push({ backup: await info(id) })
    try {
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
      if (testHooks.failBackup) throw new Error(testHooks.failBackup)
      const sources = await envSources(i.scope)
      const res = await createArchive(conn(), {
        id, kind: i.scope === 'install' ? 'install' : 'environment', environments: sources, file, method: cfg.method, pgBin: pgBinOf(cfg),
        passphrase: i.passphrase ?? null,
        secretKey: includeKey ? readKeyHex() : null,
        trigger: i.trigger, ...(i.note ? { note: i.note } : {}), createdBy: i.by,
        appVersion: await appVersion(), schemaVersion: SCHEMA_VERSION,
        dirs: (eid) => s().environments.dirs(eid),
        flushFiles: (eid) => runInEnvironment(eid, () => flushFiles(s().env)),
        onProgress: progress, signal: i.signal, afterSnapshot: i.afterSnapshot,
      })
      await setRow(id, {
        state: 'verifying', size_bytes: res.bytes, sha256: res.sha256, manifest_sha256: res.manifestSha256, method: res.manifest.method,
        summary: summaryOf(res.manifest), finished_on: new Date(), encrypted: !!i.passphrase, includes_key: res.manifest.includesKey,
      })
      // verification: read the archive back, checksums of every member, rows counted again
      const a = await openArchive(file, i.passphrase ?? null)
      let v
      try {
        v = await verifyArchive(a, { expectedManifestSha256: res.manifestSha256, onProgress: (p) => progress({ ...p, phase: 'verifying' }) })
      } finally {
        await a.close()
      }
      if (!v.ok) throw new Error(`Verification failed: ${v.errors.slice(0, 3).join(' ')}`)
      await setRow(id, { state: 'ok', verified_on: new Date(), verify_error: v.notes.length ? v.notes.join(' ') : null, progress: null })
      await audit(i.by?.id ?? null, 'backup.create', i.scope === 'install' ? null : i.scope, {
        id, file: fileName, kind: i.scope === 'install' ? 'install' : 'environment', trigger: i.trigger, method: res.manifest.method, bytes: res.bytes,
        encrypted: !!i.passphrase, includesKey: res.manifest.includesKey, ms: Date.now() - started, rows: v.rows,
      })
      if (cfg.offsite.enabled && cfg.offsite.folder && folderAllowed(cfg.offsite.folder)) await copyOffsite(id, file, res.sha256, cfg.offsite.folder)
    } catch (e) {
      const why = errMessage(e)
      log('error', `backup ${id} (${i.scope}) failed: ${why}`)
      await fs.promises.rm(file, { force: true }).catch(() => {})
      await setRow(id, { state: 'failed', error: why.slice(0, 2000), finished_on: new Date(), progress: null }).catch(() => {})
      await audit(i.by?.id ?? null, 'backup.fail', i.scope === 'install' ? null : i.scope, { id, trigger: i.trigger, error: why })
      await notifyAdmins(`Backup failed${i.scope === 'install' ? '' : ` (${i.scope})`}`, `${fileName}: ${why}`)
      void push({ backup: await info(id).catch(() => undefined) })
      throw Object.assign(new Error(why), { backupId: id })
    } finally {
      pendingPass.delete(id)
    }
    if (i.trigger === 'schedule' || i.trigger === 'manual') await prune().catch((e) => log('warn', `backup retention: ${errText(e)}`))
    const out = await info(id)
    void push({ backup: out })
    return out
  }

  function readKeyHex(): string | null {
    if (env.APPBUILDER_SECRET_KEY) return env.APPBUILDER_SECRET_KEY.trim()
    try {
      return fs.readFileSync(path.join(s().config.workspaceDir, '.secret-key'), 'utf8').trim()
    } catch {
      return null
    }
  }

  async function copyOffsite(id: string, file: string, sha256: string, folder: string): Promise<void> {
    const dest = path.join(folder, path.basename(file))
    const tmp = `${dest}.part`
    try {
      await fs.promises.mkdir(folder, { recursive: true })
      await fs.promises.copyFile(file, tmp)
      const h = await sha256OfFile(tmp)
      if (h.sha256 !== sha256) throw new Error('the copy does not match the original (checksum differs)')
      await fs.promises.rename(tmp, dest)
      await setRow(id, { offsite: { state: 'ok', path: dest, copiedOn: new Date().toISOString() } })
    } catch (e) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {})
      await setRow(id, { offsite: { state: 'failed', path: dest, error: errText(e) } })
      await notifyAdmins('Off-site copy failed', `${path.basename(file)} could not be copied to ${folder}: ${errText(e)}`)
    }
  }

  /** deletes the archives retention no longer keeps (and their off-site copies) */
  async function prune(): Promise<string[]> {
    const cfg = cached
    const rows = await db().query<Row>(`SELECT * FROM "ab"."backups"`)
    const names = await userNames()
    const items = rows.map((r) => toInfo(r, names))
    const d = decideRetention(items.map((i) => ({ id: i.id, createdOn: i.createdOn, trigger: i.trigger, state: i.state, pinned: i.pinned, scope: i.kind === 'install' ? 'install' : `env:${i.environmentId}` })), cfg.retention, { timeZone: LOCAL_TZ })
    const done: string[] = []
    for (const p of d.prune) {
      const it = items.find((x) => x.id === p.id)!
      await removeFiles(it, cfg)
      await db().exec(`DELETE FROM "ab"."backups" WHERE id = $1`, [it.id])
      await audit(null, 'backup.prune', it.environmentId ?? null, { id: it.id, file: it.fileName, reason: p.reason })
      done.push(it.id)
    }
    return done
  }

  async function removeFiles(it: BackupInfo, cfg: StoredConfig): Promise<void> {
    await fs.promises.rm(path.join(folderOf(cfg), it.fileName), { force: true })
    if (it.offsite?.path) await fs.promises.rm(it.offsite.path, { force: true }).catch(() => {})
  }

  /** "Back up now": queued as a job (the worker runs it); passphrase kept in memory only */
  async function backupNow(actor: UserContext, b: { scope?: unknown; includeKey?: unknown; passphrase?: unknown; note?: unknown }): Promise<BackupInfo> {
    const scope = typeof b.scope === 'string' && b.scope ? b.scope : 'install'
    await envSources(scope)
    let passphrase: string | null = null
    if (b.passphrase !== undefined && b.passphrase !== null && b.passphrase !== '') {
      if (typeof b.passphrase !== 'string' || b.passphrase.length < MIN_PASSPHRASE) throw new HttpError(422, 'invalid', `A passphrase needs at least ${MIN_PASSPHRASE} characters.`, 'passphrase')
      passphrase = b.passphrase
    }
    const note = typeof b.note === 'string' ? b.note.trim().slice(0, 300) : undefined
    const includeKey = b.includeKey === true
    if (includeKey && scope !== 'install') throw new HttpError(422, 'invalid', 'Only an install backup can include the encryption key.', 'includeKey')
    const id = uid('bk')
    await loadConfig()
    await createRow({ id, scope, trigger: 'manual', by: actor.user.id, note, encrypted: !!passphrase, includeKey, state: 'queued' })
    if (passphrase) pendingPass.set(id, passphrase)
    const k = s().kernel
    if (k.jobs.isRunning()) {
      const job = await runInEnvironment(DEFAULT_ENVIRONMENT_ID, () => k.jobs.enqueue(BACKUP_JOB, { backupId: id, scope, trigger: 'manual', by: actor.user.id }, { createdBy: actor.user.id, idempotencyKey: `backup:${id}`, priority: 5 }))
      await setRow(id, { job_id: job.id })
    } else {
      // no worker in this process (APPBUILDER_JOBS=off): run it here
      void exclusive('backup', () => performBackup({ id, scope, trigger: 'manual', by: { id: actor.user.id, name: actor.user.name, email: actor.user.email }, note, passphrase, includeKey })).catch(() => {})
    }
    const out = await info(id)
    void push({ backup: out })
    return out
  }

  /** a backup made right now, outside the queue (snapshots; tests) */
  function backupDirect(i: BackupInput): Promise<BackupInfo> {
    return exclusive('backup', () => performBackup(i))
  }

  /* ---------------------------------------------------------------- snapshots (BackupService) */

  function snapshotEnabled(trigger: 'pre-upgrade' | 'pre-delete' | 'pre-restore'): boolean {
    if (!ready || !cached.enabled) return false
    return trigger === 'pre-upgrade' ? cached.snapshots.beforeUpgrade : trigger === 'pre-delete' ? cached.snapshots.beforeDelete : cached.snapshots.beforeRestore
  }
  const OFF_MESSAGE = 'No backup was taken: automatic backups before risky changes are switched off in Admin console > Backups.'

  async function snapshotLocked(envId: string, trigger: 'pre-upgrade' | 'pre-delete' | 'pre-restore', reason: string, by: string | null): Promise<SnapshotResult> {
    if (!snapshotEnabled(trigger)) return { taken: false, message: OFF_MESSAGE }
    try {
      const u = by ? await s().meta.users.get(by).catch(() => null) : null
      const pass = cached.passphraseSealed ? s().secrets.decrypt(cached.passphraseSealed) : null
      const b = await performBackup({ scope: envId, trigger, by: u ? { id: u.id, name: u.name, email: u.email } : null, note: reason.slice(0, 300), passphrase: pass })
      return { taken: true, id: b.id, message: `A backup of this environment was taken first (${b.fileName}): it can be restored from Admin console > Backups.` }
    } catch (e) {
      return { taken: false, failed: true, message: `The backup before this change failed: ${errMessage(e)}` }
    }
  }

  /* ---------------------------------------------------------------- archives */

  async function archiveFor(id: string, passphrase?: string | null): Promise<{ row: Row; a: BackupArchive }> {
    const row = await rowById(id)
    if (!row) throw new HttpError(404, 'not-found', 'There is no such backup.')
    if (['queued', 'running', 'verifying'].includes(String(row.state))) throw new HttpError(409, 'conflict', 'This backup is not finished yet.')
    if (row.state === 'failed') throw new HttpError(409, 'conflict', `This backup failed and cannot be used: ${row.error ?? ''}`)
    const file = path.join(folderOf(cached), String(row.file_name))
    if (!fs.existsSync(file)) {
      await setRow(id, { state: 'missing' })
      throw new HttpError(410, 'not-found', `The archive ${row.file_name} is no longer in the backup folder.`)
    }
    let pass = passphrase || null
    if (!pass && row.encrypted && cached.passphraseSealed) {
      try { pass = s().secrets.decrypt(cached.passphraseSealed) } catch { pass = null }
    }
    try {
      return { row, a: await openArchive(file, pass) }
    } catch (e) {
      if (e instanceof ArchiveError) {
        const status = e.kind === 'needs-passphrase' || e.kind === 'passphrase' ? 422 : 409
        throw new HttpError(status, 'invalid', e.message, e.kind === 'needs-passphrase' || e.kind === 'passphrase' ? 'passphrase' : undefined)
      }
      throw e
    }
  }

  function restorableProblem(m: Manifest): string | null {
    const newest = Math.max(m.app.schemaVersion, ...m.environments.map((e) => e.schemaVersion))
    if (newest > SCHEMA_VERSION) return `This backup was made by a newer Appbuilder (${m.app.version}, schema version ${newest}); this server (schema version ${SCHEMA_VERSION}) cannot restore it. Restore it with that version or newer.`
    return null
  }

  async function contents(id: string, passphrase?: string | null): Promise<BackupContents> {
    const { a } = await archiveFor(id, passphrase)
    try {
      const m = a.manifest
      const problem = restorableProblem(m)
      return {
        id: m.id, kind: m.kind, createdOn: m.createdOn, method: m.method, app: m.app, includesKey: m.includesKey, warnings: m.warnings,
        restorable: !problem, ...(problem ? { problem } : {}),
        environments: m.environments.map((e) => ({
          id: e.id, name: e.name, type: e.type, schemaVersion: e.schemaVersion, attachments: e.attachments, dataFiles: e.dataFiles,
          tables: e.tables.map((t) => {
            const ok = t.connectionId === DEFAULT_CONNECTION_ID && !!t.source && t.rows !== null
            return { id: t.id, name: t.name, source: t.source, rows: t.rows, columns: t.columns, restorable: ok, ...(ok ? {} : { note: t.connectionId === FILES_CONNECTION_ID ? 'A data-file table: restore the environment to get its file back.' : (t.connectionId === DEFAULT_CONNECTION_ID ? 'A view or a table without rows of its own: nothing to restore.' : 'Not stored in the system database: its rows are not in the backup.') }) }
          }),
        })),
      }
    } finally {
      await a.close()
    }
  }

  /** the backup's table definitions (ab_tables rows of an environment) */
  async function backupTableDefs(a: BackupArchive, schema: string): Promise<Map<string, TableDef & { connectionId?: string }>> {
    const { columns, stream, done } = await tableData(a, schema, 'ab_tables')
    const { lines } = await readCopyLines(stream, 0, 100_000)
    await done.catch(() => {})
    const ix = (n: string) => columns.indexOf(n)
    const out = new Map<string, TableDef & { connectionId?: string }>()
    for (const l of lines) {
      const v = parseCopyLine(l)
      const def = JSON.parse(v[ix('def')] ?? '{}') as TableDef
      def.id = v[ix('id')] ?? def.id
      def.name = v[ix('name')] ?? def.name
      ;(def as TableDef & { connectionId?: string }).connectionId = v[ix('connection_id')] ?? undefined
      def.source = v[ix('source')] ?? def.source
      out.set(def.id, def)
    }
    return out
  }

  async function browse(id: string, b: { environment?: unknown; table?: unknown; offset?: unknown; limit?: unknown; passphrase?: unknown }): Promise<BackupRowsPage> {
    const { a } = await archiveFor(id, typeof b.passphrase === 'string' ? b.passphrase : null)
    try {
      const envId = String(b.environment ?? a.manifest.environments[0]?.id ?? '')
      const schema = schemaOf(a, envId)
      const me = a.manifest.environments.find((x) => x.id === envId)!
      const t = me.tables.find((x) => x.id === b.table || x.name === b.table)
      if (!t || !t.source || t.connectionId !== DEFAULT_CONNECTION_ID) throw new HttpError(404, 'not-found', 'This table has no rows in the backup (it is not stored in the system database).')
      // P3-A: conversations are not browsed (administrators export one conversation with a reason: docs/admin/chat.md)
      if (CHAT_SYSTEM_TABLES.includes(t.id)) throw new HttpError(403, 'denied', 'Chat tables cannot be browsed in a backup. To read one conversation, export it in Admin console > Chat (audited, and its members are told).')
      const offset = Math.max(0, Math.min(Number(b.offset) || 0, 10_000_000))
      const limit = Math.max(1, Math.min(Number(b.limit) || 50, 500))
      const defs = await backupTableDefs(a, schema)
      const def = defs.get(t.id)
      const { columns, stream, done } = await tableData(a, schema, t.source)
      const { lines, more } = await readCopyLines(stream, offset, limit)
      stream.destroy()
      void done.catch(() => {})
      const label = new Map((def?.columns ?? []).map((c) => [c.name, { displayName: c.displayName ?? c.name, type: String(c.type) }]))
      return {
        columns: columns.map((c) => ({ name: c, displayName: label.get(c)?.displayName ?? c, type: label.get(c)?.type ?? 'text' })),
        rows: lines.map((l) => { const v = parseCopyLine(l); return Object.fromEntries(columns.map((c, i) => [c, v[i] ?? null])) }),
        offset, total: t.rows, more,
      }
    } finally {
      await a.close()
    }
  }

  /* ---------------------------------------------------------------- restore: whole environment */

  async function restoreEnvironment(id: string, b: RestoreRequest, actor: UserContext): Promise<BackupOp> {
    const { row, a } = await archiveFor(id, b.passphrase ?? null)
    let handedOver = false
    try {
      const problem = restorableProblem(a.manifest)
      if (problem) throw new HttpError(409, 'conflict', problem)
      const src = a.manifest.environments.find((e) => e.id === b.environment) ?? (a.manifest.environments.length === 1 && !b.environment ? a.manifest.environments[0] : undefined)
      if (!src) throw new HttpError(422, 'invalid', `The backup does not contain the environment "${b.environment}".`, 'environment')
      const ops = await import('../environment-ops.ts')
      if (b.mode === 'in-place') {
        const targetId = b.target || src.id
        const target = await s().install.environments.get(targetId)
        if (!target) throw new HttpError(404, 'not-found', `There is no environment "${targetId}" to restore into. Restore the backup as a new environment instead.`)
        if (target.state !== 'ready') throw new HttpError(409, 'conflict', `"${target.name}" is ${target.state}: it cannot be restored now.`)
        if (typeof b.confirmName !== 'string' || b.confirmName.trim() !== target.name) throw new HttpError(422, 'invalid', `Type the name of the environment ("${target.name}") to confirm.`, 'confirmName')
        const opId = await newOp({ kind: 'restore', backupId: id, mode: 'in-place', source: src.id, target: target.id, by: actor.user.id })
        handedOver = true
        closeAfter(a, exclusive('restore', () => restoreInPlace(opId, a, src.id, target, b, actor, (row.manifest_sha256 as string | null) ?? null)))
        return getOp(opId)
      }
      if (b.mode !== 'new') throw new HttpError(422, 'invalid', 'mode must be "new" or "in-place".', 'mode')
      const blocked = await ops.createBlocked(s(), actor)
      if (blocked) throw new HttpError(409, 'conflict', blocked)
      const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().replace(/\s+/g, ' ') : `${src.name} (restored ${a.manifest.createdOn.slice(0, 10)})`
      if (name.length > 60) throw new HttpError(422, 'invalid', 'The name is too long (at most 60 characters).', 'name')
      const all = await s().install.environments.list()
      if (all.some((e) => e.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'conflict', `An environment named "${name}" already exists.`)
      const type = b.type && ['production', 'sandbox', 'developer'].includes(b.type) ? b.type : 'sandbox'
      const base = ops.slugFor(name)
      let newId = base
      for (let i = 2; all.some((e) => e.id === newId) || (await db().query('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1', [environmentSchema(newId)])).length; i++) newId = `${base.slice(0, 36)}_${i}`
      await s().install.environments.insert({ id: newId, schema: environmentSchema(newId), name, type, builtIn: false, state: 'creating', locked: false, createdBy: actor.user.id, description: `Restored from backup ${a.manifest.id} (${src.name}, ${a.manifest.createdOn.slice(0, 16).replace('T', ' ')} UTC)` })
      s().environments.invalidate()
      const opId = await newOp({ kind: 'restore', backupId: id, mode: 'new', source: src.id, target: newId, by: actor.user.id })
      handedOver = true
      closeAfter(a, exclusive('restore', () => restoreAsNew(opId, a, src.id, newId, name, b, actor, (row.manifest_sha256 as string | null) ?? null)))
      return getOp(opId)
    } finally {
      if (!handedOver) await a.close()
    }
  }

  /** what every restored environment schema needs: no stale queue work, roles only of existing users */
  async function fixups(c: pg.Client, schema: string): Promise<void> {
    const S = qi(schema)
    await c.query(`UPDATE ${S}."ab_outbox" SET dispatched_on = now() WHERE dispatched_on IS NULL`)
    await c.query(`UPDATE ${S}."ab_jobs" SET state = 'cancelled', finished_on = now(), locked_by = NULL, error = '{"message":"Cancelled: the environment was restored from a backup."}'::jsonb WHERE state IN ('queued', 'running', 'failed')`)
    await c.query(`DELETE FROM ${S}."ab_user_roles" r WHERE NOT EXISTS (SELECT 1 FROM "ab"."users" u WHERE u.id = r.user_id)`)
    // P1-A flows: runs that were queued, running or waiting cannot go on (their jobs were cancelled above, approvals and
    // callbacks may have moved on since the backup): they are cancelled with a note; nothing is re-armed
    const flowRuns = await c.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`${S}."ab_flow_runs"`])
    if (flowRuns.rows[0]?.ok) {
      await c.query(`UPDATE ${S}."ab_flow_runs" SET state = 'cancelled', finished_on = now(), error = '{"message":"Cancelled: the environment was restored from a backup taken while this run was in progress."}'::jsonb WHERE state IN ('queued', 'running', 'waiting')`)
      await c.query(`UPDATE ${S}."ab_flow_waits" SET state = 'cancelled', resolved_on = now() WHERE state IN ('waiting', 'early')`)
      await c.query(`UPDATE ${S}."ab_flow_steps" SET state = 'cancelled', finished_on = now() WHERE state IN ('running', 'waiting')`)
    }
    // P1-C approvals: open requests stay open; the flow runs that waited for them were cancelled above, so the link to the
    // run is cut (a later decision notifies, it resumes nothing). Notification jobs were cancelled with the queue: every
    // person still asked gets one reminder a minute after the restore (instead of the lost or late ones), escalations
    // that fell due while the backup was on the shelf move to an hour from now, and unused email links stop working.
    const approvals = await c.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`${S}."ab_approval_requests"`])
    if (approvals.rows[0]?.ok) {
      await c.query(`UPDATE ${S}."ab_approval_requests" SET wait_id = NULL, escalate_at = CASE WHEN escalate_at IS NOT NULL AND escalate_at < now() THEN now() + interval '1 hour' ELSE escalate_at END WHERE status IN ('pending', 'info')`)
      await c.query(`UPDATE ${S}."ab_approval_assignments" a SET next_reminder_at = now() + interval '1 minute' FROM ${S}."ab_approval_requests" r WHERE r.id = a.request_id AND r.status = 'pending' AND a.status = 'pending'`)
      await c.query(`UPDATE ${S}."ab_approval_links" SET used_on = now() WHERE used_on IS NULL`)
      await c.query(`INSERT INTO ${S}."ab_approval_history" (id, request_id, at, actor_id, actor_kind, action, details) SELECT 'ahst_' || md5(random()::text || id), id, now(), NULL, 'system', 'restored', '{"text":"The environment was restored from a backup; this request stays open. A flow that waited for it was cancelled by the restore; everyone still asked gets a reminder."}'::jsonb FROM ${S}."ab_approval_requests" WHERE status IN ('pending', 'info')`)
    }
  }

  /** brings a restored schema from the backup's schema version to this server's (same transaction) */
  async function migrateRestored(c: pg.Client, envId: string, schema: string, fromVersion: number): Promise<{ from: number; to: number }> {
    await c.query(`UPDATE "ab"."environments" SET schema_version = $2 WHERE id = $1`, [envId, fromVersion || SCHEMA_VERSION])
    return migrateEnvironmentSchema(clientDb(c), { id: envId, schema })
  }

  async function afterRestore(envId: string): Promise<void> {
    const sv = s()
    await sv.connections.closeEnvironment(envId).catch(() => {})
    sv.security.invalidate({ environment: envId })
    sv.environments.invalidate()
    sv.kernel.invalidate()
    await runInEnvironment(envId, () => sv.ensureBuiltinConnections()).catch((e) => log('warn', `environment ${envId}: built-in connections after the restore: ${errText(e)}`))
  }

  async function restoreInPlace(opId: string, a: BackupArchive, srcId: string, target: EnvironmentRecord, b: RestoreRequest, actor: UserContext, manifestSha: string | null): Promise<void> {
    const sv = s()
    const progress = progressFor('op', opId)
    const dirs = sv.environments.dirs(target.id)
    const staging = `${dirs.root}.restore-${opId}`
    const old = `${dirs.root}.pre-${opId}`
    let stateChanged = false
    let committed = false
    const started = Date.now()
    try {
      // 0. the archive is checked completely before anything changes
      await checkArchive(opId, a, manifestSha)
      // 1. a safety backup of what is there now
      let safety: SnapshotResult | null = null
      if (snapshotEnabled('pre-restore')) {
        await setOp(opId, { phase: 'safety-backup' })
        safety = await snapshotLocked(target.id, 'pre-restore', `before restoring backup ${a.manifest.id}`, actor.user.id)
        if (!safety.taken && safety.failed && !b.proceedWithoutBackup) {
          await setOp(opId, { state: 'failed', finished_on: new Date(), error: `${safety.message} Nothing was changed. Restore without a safety backup, or cancel.`, result: { backupFailed: true } })
          return
        }
      }
      // 2. maintenance: requests to the environment answer "being restored", sockets are told
      await sv.install.environments.update(target.id, { state: 'restoring' })
      stateChanged = true
      sv.environments.invalidate()
      live?.emitEnv(target.id, 'state', { restoring: true, by: { id: actor.user.id, name: actor.user.name } })
      await sv.connections.closeEnvironment(target.id).catch(() => {})
      await forgetFilesFolder(dirs.files).catch(() => {})
      // 3. files into a staging folder next to the environment's (checked against their checksums)
      await setOp(opId, { phase: 'files' })
      await fs.promises.rm(staging, { recursive: true, force: true })
      await extractEnvironmentFiles(a, srcId, staging, () => {})
      // 4. the database: one transaction (a failure leaves the old data untouched)
      await setOp(opId, { phase: 'database' })
      const srcSchema = schemaOf(a, srcId)
      const manifestEnv = a.manifest.environments.find((e) => e.id === srcId)!
      const c = await connect(conn())
      let migration: { from: number; to: number } | null = null
      try {
        await c.query('BEGIN')
        await c.query(`DROP SCHEMA IF EXISTS ${qi(target.schema)} CASCADE`)
        await restoreSchema(c, a, srcSchema, target.schema, { onProgress: progress, ...(testHooks.failAfterTables !== undefined ? { failAfterTables: testHooks.failAfterTables } : {}) })
        await fixups(c, target.schema)
        migration = await migrateRestored(c, target.id, target.schema, manifestEnv.schemaVersion)
        // access follows roles (environment_access is install-level: it stays, and gains whoever has roles in the backup)
        await c.query(`INSERT INTO "ab"."environment_access" (environment_id, user_id, is_env_admin, granted_on, granted_by) SELECT DISTINCT $1, r.user_id, false, now(), NULL FROM ${qi(target.schema)}."ab_user_roles" r ON CONFLICT DO NOTHING`, [target.id])
        await c.query(`UPDATE "ab"."environment_access" a SET is_env_admin = EXISTS (SELECT 1 FROM ${qi(target.schema)}."ab_user_roles" ur JOIN ${qi(target.schema)}."ab_roles" ro ON ro.id = ur.role_id WHERE ur.user_id = a.user_id AND ro.is_admin) WHERE a.environment_id = $1`, [target.id])
        await c.query(`UPDATE "ab"."backup_ops" SET phase = 'swap-files' WHERE id = $1`, [opId])
        await c.query('COMMIT')
        committed = true
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        await c.end().catch(() => {})
      }
      // 5. the folder: swap the staging folder in
      await swapFolders(dirs.root, staging, old)
      await sv.install.environments.update(target.id, { state: 'ready', lastError: '', schemaVersion: SCHEMA_VERSION })
      stateChanged = false
      await afterRestore(target.id)
      const result = { safetyBackup: safety?.id ?? null, migration, ms: Date.now() - started, tables: a.manifest.environments.find((e) => e.id === srcId)?.tables.length }
      await setOp(opId, { state: 'succeeded', phase: 'done', finished_on: new Date(), result, progress: null })
      await audit(actor.user.id, 'backup.restore', target.id, { op: opId, backup: a.manifest.id, mode: 'in-place', source: srcId, target: target.id, safetyBackup: safety?.id ?? null, proceededWithoutBackup: !!(safety && !safety.taken), ms: result.ms })
      await runInEnvironment(target.id, () => sv.meta.audit({ userId: actor.user.id, action: 'backup.restore', details: { backup: a.manifest.id, createdOn: a.manifest.createdOn, mode: 'in-place', safetyBackup: safety?.id ?? null } })).catch(() => {})
      live?.emitEnv(target.id, 'state', { restoring: false, by: { id: actor.user.id, name: actor.user.name } })
      live?.emitEnv(target.id, 'security', { by: { id: actor.user.id, name: actor.user.name } })
    } catch (e) {
      const why = errMessage(e)
      log('error', `restore ${opId} into ${target.id} failed: ${why}`)
      if (!committed) await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})
      if (stateChanged) {
        await sv.install.environments.update(target.id, committed ? { state: 'failed', lastError: `The restore stopped after the database was restored: ${why}` } : { state: 'ready' }).catch(() => {})
        sv.environments.invalidate()
        await afterRestore(target.id).catch(() => {})
        live?.emitEnv(target.id, 'state', { restoring: false })
      }
      await setOp(opId, { state: 'failed', finished_on: new Date(), error: (committed ? why : `${why} Nothing was changed: the environment keeps its data.`).slice(0, 2000), progress: null })
      await audit(actor.user.id, 'backup.restore_failed', target.id, { op: opId, backup: a.manifest.id, mode: 'in-place', error: why, changed: committed })
    } finally {
      await a.close()
    }
  }

  /** checksums of every member and rows counted again, before a restore changes anything */
  async function checkArchive(opId: string, a: BackupArchive, manifestSha: string | null): Promise<void> {
    await setOp(opId, { phase: 'checking' })
    const v = await verifyArchive(a, { expectedManifestSha256: manifestSha, onProgress: progressFor('op', opId) })
    if (!v.ok) throw new Error(`The backup failed its check, nothing was restored: ${v.errors.slice(0, 3).join(' ')}`)
  }

  async function swapFolders(live_: string, staging: string, old: string): Promise<void> {
    await fs.promises.rm(old, { recursive: true, force: true })
    if (fs.existsSync(live_)) await fs.promises.rename(live_, old)
    await fs.promises.rename(staging, live_)
    await fs.promises.rm(old, { recursive: true, force: true }).catch((e) => log('warn', `the old folder ${old} could not be removed: ${errText(e)}`))
  }

  async function restoreAsNew(opId: string, a: BackupArchive, srcId: string, newId: string, name: string, b: RestoreRequest, actor: UserContext, manifestSha: string | null): Promise<void> {
    const sv = s()
    const progress = progressFor('op', opId)
    const dirs = sv.environments.dirs(newId)
    const schema = environmentSchema(newId)
    const started = Date.now()
    try {
      await checkArchive(opId, a, manifestSha)
      await setOp(opId, { phase: 'files' })
      await fs.promises.rm(dirs.root, { recursive: true, force: true })
      await extractEnvironmentFiles(a, srcId, dirs.root)
      await setOp(opId, { phase: 'database' })
      const manifestEnv = a.manifest.environments.find((e) => e.id === srcId)!
      const c = await connect(conn())
      let migration: { from: number; to: number } | null = null
      try {
        await c.query('BEGIN')
        await restoreSchema(c, a, schemaOf(a, srcId), schema, { onProgress: progress })
        await fixups(c, schema)
        if (!b.keepConnectionSecrets) {
          await c.query(`UPDATE ${qi(schema)}."ab_connections" SET secret_sealed = NULL, status = 'not-configured', last_error = NULL WHERE id NOT IN ($1, $2)`, [DEFAULT_CONNECTION_ID, FILES_CONNECTION_ID])
        }
        if (!b.keepAccess) await c.query(`DELETE FROM ${qi(schema)}."ab_user_roles"`)
        migration = await migrateRestored(c, newId, schema, manifestEnv.schemaVersion)
        await c.query('COMMIT')
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        await c.end().catch(() => {})
      }
      // the restoring administrator administers it; with keepAccess, everyone with roles in the backup may enter
      await runInEnvironment(newId, async () => {
        const auth = await import('../auth.ts')
        await auth.ensureBuiltinRoles(sv)
        await sv.ensureBuiltinConnections()
        const me = await sv.meta.users.get(actor.user.id)
        await sv.meta.users.update(actor.user.id, { roleIds: [...new Set([...(me?.roleIds ?? []), auth.ROLE_ADMIN])] })
      })
      if (b.keepAccess) {
        await db().exec(`INSERT INTO "ab"."environment_access" (environment_id, user_id, is_env_admin, granted_on, granted_by) SELECT DISTINCT $1, r.user_id, false, now(), $2 FROM ${qi(schema)}."ab_user_roles" r ON CONFLICT DO NOTHING`, [newId, actor.user.id])
        await db().exec(`UPDATE "ab"."environment_access" a SET is_env_admin = EXISTS (SELECT 1 FROM ${qi(schema)}."ab_user_roles" ur JOIN ${qi(schema)}."ab_roles" ro ON ro.id = ur.role_id WHERE ur.user_id = a.user_id AND ro.is_admin) WHERE a.environment_id = $1`, [newId])
      }
      await sv.install.environments.update(newId, { state: 'ready', schemaVersion: SCHEMA_VERSION, lastError: '' })
      await afterRestore(newId)
      const result = { environment: newId, name, migration, ms: Date.now() - started }
      await setOp(opId, { state: 'succeeded', phase: 'done', finished_on: new Date(), result, progress: null })
      await audit(actor.user.id, 'backup.restore', newId, { op: opId, backup: a.manifest.id, mode: 'new', source: srcId, target: newId, name, keepConnectionSecrets: !!b.keepConnectionSecrets, keepAccess: !!b.keepAccess, ms: result.ms })
      await runInEnvironment(newId, () => sv.meta.audit({ userId: actor.user.id, action: 'backup.restore', details: { backup: a.manifest.id, createdOn: a.manifest.createdOn, mode: 'new', source: srcId } })).catch(() => {})
    } catch (e) {
      const why = errMessage(e)
      log('error', `restore ${opId} as ${newId} failed: ${why}`)
      await fs.promises.rm(dirs.root, { recursive: true, force: true }).catch(() => {})
      await db().exec(`DROP SCHEMA IF EXISTS ${qi(schema)} CASCADE`).catch(() => {})
      await sv.install.environments.update(newId, { state: 'failed', lastError: `Restoring it failed: ${why}`.slice(0, 1000) }).catch(() => {})
      sv.environments.invalidate()
      await setOp(opId, { state: 'failed', finished_on: new Date(), error: why.slice(0, 2000), progress: null })
      await audit(actor.user.id, 'backup.restore_failed', newId, { op: opId, backup: a.manifest.id, mode: 'new', error: why })
    } finally {
      await a.close()
    }
  }

  /* ---------------------------------------------------------------- restore: selected tables */

  async function planTables(id: string, b: TableRestoreRequest, envId: string): Promise<TableRestorePlan> {
    const { a } = await archiveFor(id, b.passphrase ?? null)
    try {
      return await planTablesWith(a, id, b, envId)
    } finally {
      await a.close()
    }
  }

  async function planTablesWith(a: BackupArchive, id: string, b: TableRestoreRequest, envId: string): Promise<TableRestorePlan & { defs: Map<string, TableDef> }> {
    const problem = restorableProblem(a.manifest)
    if (problem) throw new HttpError(409, 'conflict', problem)
    if (b.mode !== 'new' && b.mode !== 'replace') throw new HttpError(422, 'invalid', 'mode must be "new" or "replace".', 'mode')
    if (!Array.isArray(b.tables) || !b.tables.length) throw new HttpError(422, 'invalid', 'Choose at least one table.', 'tables')
    const schema = schemaOf(a, b.environment)
    const me = a.manifest.environments.find((x) => x.id === b.environment)!
    const defs = await backupTableDefs(a, schema)
    const current = await runInEnvironment(envId, () => s().meta.tables.list())
    const names = new Set(current.map((t) => t.name.toLowerCase()))
    const items: TableRestorePlanItem[] = []
    const day = a.manifest.createdOn.slice(0, 10)
    for (const tid of b.tables) {
      const mt = me.tables.find((t) => t.id === tid)
      const def = defs.get(tid)
      const problems: string[] = []
      const notes: string[] = []
      if (!mt || !def) { items.push({ tableId: tid, name: tid, mode: b.mode, rowsInBackup: 0, attachments: 0, columns: [], destructive: false, problems: ['The backup does not contain this table.'], notes }); continue }
      if (mt.connectionId !== DEFAULT_CONNECTION_ID || !mt.source) problems.push('Only tables stored in the system database can be restored on their own.')
      const kind = def as TableDef & { system?: boolean; reporting?: { kind?: string } }
      if (kind.reporting?.kind === 'view' || mt.rows === null) problems.push('This is a view or holds no rows of its own: there is nothing to restore.')
      else if (kind.system && b.mode === 'new') problems.push('A system table cannot be restored as a new table; replace its rows instead.')
      const attCols = def.columns.filter((c) => c.type === 'image' || c.type === 'file').map((c) => c.name)
      const item: TableRestorePlanItem = { tableId: tid, name: mt.name, mode: b.mode, rowsInBackup: mt.rows ?? 0, attachments: 0, columns: [], destructive: false, problems, notes }
      if (attCols.length) notes.push(`Attachments of ${attCols.join(', ')} are restored with the rows.`)
      if (b.mode === 'new') {
        const ident = uniqueIdentifier(`${mt.name}_restored_${day.replace(/-/g, '')}`, names)
        names.add(ident.toLowerCase())
        item.newName = `${def.displayName ?? mt.name} (restored ${day})`
        ;(item as TableRestorePlanItem & { newIdentifier?: string }).newIdentifier = ident
        notes.push('Restored as a new table (new name and id); the rows keep their ids. Lookups from other tables keep pointing at the live table. Its table events and role privileges are not restored: administrators see it, give roles access to it.')
      } else {
        const cur = current.find((t) => t.id === tid)
        if (!cur) problems.push('This table no longer exists here: restore it as a new table.')
        else {
          if (cur.connectionId !== DEFAULT_CONNECTION_ID) problems.push('The table here is not stored in the system database.')
          item.destructive = true
          const now = new Map(cur.columns.map((c) => [c.name, c]))
          const then = new Map(def.columns.map((c) => [c.name, c]))
          for (const [nm, c] of then) {
            if (!now.has(nm)) item.columns.push({ name: nm, change: 'only-in-backup', from: String(c.type) })
            else if (now.get(nm)!.type !== c.type) item.columns.push({ name: nm, change: 'type', from: String(c.type), to: String(now.get(nm)!.type) })
          }
          for (const [nm, c] of now) if (!then.has(nm)) item.columns.push({ name: nm, change: 'only-now', to: String(c.type) })
          try {
            const r = await db().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${qi(environmentSchema(envId))}.${qi(cur.source ?? '')}`)
            item.rowsNow = Number(r[0].n)
          } catch { item.rowsNow = undefined }
          if (item.columns.some((c) => c.change === 'only-in-backup')) notes.push('Columns that exist only in the backup are left out (their values are not restored).')
          if (item.columns.some((c) => c.change === 'only-now')) notes.push('Columns added since the backup are blank in the restored rows.')
          if (item.columns.some((c) => c.change === 'type')) notes.push('Columns whose type changed are converted; a value that does not convert stops the restore (nothing changes).')
        }
      }
      items.push(item)
    }
    const all = items.flatMap((i) => i.problems)
    const plan = { backupId: id, environment: b.environment, target: envId, items, destructive: items.some((i) => i.destructive), problems: all, token: '' }
    plan.token = createHash('sha256').update(JSON.stringify({ id, env: b.environment, target: envId, mode: b.mode, items: items.map((i) => ({ ...i, rowsNow: undefined })) })).digest('hex').slice(0, 32)
    return { ...plan, defs: defs as Map<string, TableDef> }
  }

  async function restoreTables(id: string, b: TableRestoreRequest & { confirm?: string }, actor: UserContext, envId: string): Promise<BackupOp> {
    const { a } = await archiveFor(id, b.passphrase ?? null)
    let handed = false
    try {
      const plan = await planTablesWith(a, id, b, envId)
      if (plan.problems.length) throw new HttpError(409, 'conflict', plan.problems[0])
      if (b.confirm !== plan.token) throw new HttpError(409, 'conflict', b.confirm ? 'The backup or this environment changed since the plan was made. Review the new plan and confirm it again.' : 'Review the plan and confirm it.')
      const target = await s().install.environments.get(envId)
      if (!target || target.state !== 'ready') throw new HttpError(409, 'conflict', 'This environment is not ready.')
      if (target.locked && target.type === 'production' && b.mode === 'new') throw new HttpError(403, 'denied', 'This environment is locked: new tables arrive by solution only. Unlock it, or replace the rows of an existing table.')
      const opId = await newOp({ kind: 'restore-tables', backupId: id, mode: b.mode, source: b.environment, target: envId, by: actor.user.id })
      handed = true
      closeAfter(a, exclusive('restore', () => applyTables(opId, a, plan, b, actor, envId)))
      return getOp(opId)
    } finally {
      if (!handed) await a.close()
    }
  }

  async function applyTables(opId: string, a: BackupArchive, plan: TableRestorePlan & { defs: Map<string, TableDef> }, b: TableRestoreRequest, actor: UserContext, envId: string): Promise<void> {
    const sv = s()
    const schema = schemaOf(a, b.environment)
    const target = environmentSchema(envId)
    const scratch = `ab_rs_${randomBytes(5).toString('hex')}`
    const dirs = sv.environments.dirs(envId)
    const cat = await a.catalog(schema)
    const done: { tableId: string; name: string; rows: number; newTableId?: string; attachments: number }[] = []
    const changedTables: string[] = []
    const c = await connect(conn())
    try {
      await c.query('BEGIN')
      await c.query(`CREATE SCHEMA ${qi(scratch)}`)
      const icu = (await c.query<{ ok: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_collation WHERE collname = 'und-x-icu') AS ok")).rows[0].ok
      const trgm = (await c.query<{ s: string }>("SELECT n.nspname AS s FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm'")).rows[0]?.s ?? null
      // attachment records of the backup (for the tables restored)
      const att = await tableData(a, schema, 'ab_attachments')
      const attLines = (await readCopyLines(att.stream, 0, 5_000_000)).lines
      await att.done.catch(() => {})
      const attRows = attLines.map((l) => Object.fromEntries(att.columns.map((col, i) => [col, parseCopyLine(l)[i]])) as Record<string, string | null>)
      const keysNeeded = new Set<string>()
      for (const item of plan.items) {
        const def = plan.defs.get(item.tableId)!
        const mt = a.manifest.environments.find((x) => x.id === b.environment)!.tables.find((t) => t.id === item.tableId)!
        const ct = cat.tables.find((t) => t.name === mt.source)
        if (!ct) throw new Error(`The backup has no data for ${mt.name}.`)
        // the backup's rows into a scratch table of the backup's own column types
        for (const st of preDataSql(cat, scratch, { tables: [ct.name] })) await c.query(st)
        const data = await tableData(a, schema, ct.name)
        const n = await copyInto(c, scratch, ct.name, data.columns, data.stream)
        await data.done
        if (ct.rows !== undefined && n !== ct.rows) throw new Error(`${mt.name}: ${n} rows read from the backup, its manifest says ${ct.rows}.`)
        await setOp(opId, { phase: `table ${mt.name}` })
        const tableAtts = attRows.filter((r) => r.table_id === item.tableId)
        if (b.mode === 'replace') {
          const cur = (await runInEnvironment(envId, () => sv.meta.tables.get(item.tableId)))!
          const types = await c.query<{ column_name: string; t: string }>(
            `SELECT a.attname AS column_name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS t FROM pg_catalog.pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`, [`${qi(target)}.${qi(cur.source!)}`])
          const now = new Map(types.rows.map((r) => [r.column_name, r.t]))
          const common = copyColumns(ct).filter((col) => now.has(col))
          await c.query(`DELETE FROM ${qi(target)}.${qi(cur.source!)}`)
          await c.query(`INSERT INTO ${qi(target)}.${qi(cur.source!)} (${common.map(qi).join(', ')}) SELECT ${common.map((col) => `${qi(col)}::${now.get(col)}`).join(', ')} FROM ${qi(scratch)}.${qi(ct.name)}`)
          await c.query(`DELETE FROM ${qi(target)}."ab_attachments" WHERE table_id = $1`, [item.tableId])
          for (const r of tableAtts) {
            await c.query(`INSERT INTO ${qi(target)}."ab_attachments" (id, table_id, col, row_id, file_name, mime, sha256, storage_key, size_bytes, created_by, created_on) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO UPDATE SET table_id = EXCLUDED.table_id, row_id = EXCLUDED.row_id, col = EXCLUDED.col`,
              [r.id, r.table_id, r.col, r.row_id, r.file_name, r.mime, r.sha256, r.storage_key, r.size_bytes, r.created_by, r.created_on])
            if (r.storage_key) keysNeeded.add(r.storage_key)
          }
          done.push({ tableId: item.tableId, name: item.name, rows: n, attachments: tableAtts.length })
          changedTables.push(item.tableId)
        } else {
          const newId = uid('tbl')
          const ident = (item as TableRestorePlanItem & { newIdentifier?: string }).newIdentifier ?? uniqueIdentifier(`${item.name}_restored`, [])
          const source = await freeSource(c, target, ident)
          const now = new Date().toISOString()
          const nd: TableDef = { ...JSON.parse(JSON.stringify(def)), id: newId, name: ident, displayName: item.newName!, source, createdOn: now, modifiedOn: now }
          ;(nd as TableDef & { connectionId?: string }).connectionId = DEFAULT_CONNECTION_ID
          for (const st of createTableSql({ schema: target, icu }, nd, trgm)) await c.query(st)
          const types = await c.query<{ column_name: string; t: string }>(
            `SELECT a.attname AS column_name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS t FROM pg_catalog.pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`, [`${qi(target)}.${qi(source)}`])
          const tt = new Map(types.rows.map((r) => [r.column_name, r.t]))
          const common = copyColumns(ct).filter((col) => tt.has(col))
          await c.query(`INSERT INTO ${qi(target)}.${qi(source)} (${common.map(qi).join(', ')}) SELECT ${common.map((col) => `${qi(col)}::${tt.get(col)}`).join(', ')} FROM ${qi(scratch)}.${qi(ct.name)}`)
          const { connectionId: _c, ...stored } = nd as TableDef & { connectionId?: string }
          void _c
          await c.query(`INSERT INTO ${qi(target)}."ab_tables" (id, name, connection_id, source, def, created_on, modified_on) VALUES ($1, $2, $3, $4, $5::jsonb, now(), now())`, [newId, nd.name, DEFAULT_CONNECTION_ID, source, JSON.stringify(stored)])
          // attachments get new ids (the originals may still exist here); cells are rewritten to the new ids
          const attCols = nd.columns.filter((col) => col.type === 'image' || col.type === 'file').map((col) => col.name).filter((col) => tt.has(col))
          if (tableAtts.length) {
            await c.query(`CREATE TEMP TABLE ab_rs_map (old text PRIMARY KEY, new text NOT NULL) ON COMMIT DROP`)
            for (const r of tableAtts) {
              const nid = uid('att')
              await c.query('INSERT INTO ab_rs_map (old, new) VALUES ($1, $2)', [r.id, nid])
              await c.query(`INSERT INTO ${qi(target)}."ab_attachments" (id, table_id, col, row_id, file_name, mime, sha256, storage_key, size_bytes, created_by, created_on) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [nid, newId, r.col, r.row_id, r.file_name, r.mime, r.sha256, r.storage_key, r.size_bytes, r.created_by, r.created_on])
              if (r.storage_key) keysNeeded.add(r.storage_key)
            }
            for (const col of attCols) {
              const Q = `${qi(target)}.${qi(source)}`
              await c.query(`UPDATE ${Q} t SET ${qi(col)} = m.new FROM ab_rs_map m WHERE t.${qi(col)} = m.old`)
              await c.query(`UPDATE ${Q} t SET ${qi(col)} = (SELECT jsonb_agg(COALESCE(m.new, e))::text FROM jsonb_array_elements_text(t.${qi(col)}::jsonb) e LEFT JOIN ab_rs_map m ON m.old = e) WHERE t.${qi(col)} LIKE '[%'`)
            }
            await c.query('DROP TABLE ab_rs_map')
          }
          done.push({ tableId: item.tableId, name: item.name, rows: n, newTableId: newId, attachments: tableAtts.length })
          changedTables.push(newId)
        }
      }
      // attachment files that are not in this environment's folder come from the archive
      for (const f of a.manifest.files) {
        const m = /^files\/([^/]+)\/attachments\/(.+)$/.exec(f.name)
        if (!m || m[1] !== b.environment) continue
        const key = path.posix.basename(m[2])
        if (!keysNeeded.has(key)) continue
        const dest = path.join(dirs.attachments, ...m[2].split('/'))
        if (fs.existsSync(dest)) continue
        await fs.promises.mkdir(path.dirname(dest), { recursive: true })
        const { pipeline } = await import('node:stream/promises')
        await pipeline(a.stream(f.name), fs.createWriteStream(dest))
      }
      await c.query(`DROP SCHEMA ${qi(scratch)} CASCADE`)
      await c.query('COMMIT')
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      const why = errMessage(e)
      await setOp(opId, { state: 'failed', finished_on: new Date(), error: `${why} Nothing was changed.`.slice(0, 2000), progress: null })
      await audit(actor.user.id, 'backup.restore_failed', envId, { op: opId, backup: a.manifest.id, mode: `tables-${b.mode}`, error: why })
      await c.end().catch(() => {})
      await a.close()
      return
    }
    await c.end().catch(() => {})
    await a.close()
    sv.security.invalidate({ environment: envId })
    sv.kernel.invalidate()
    for (const t of changedTables) emitTableChange(envId, t, { op: 'import', rowIds: [], changedColumns: null, actor: { id: actor.user.id, name: actor.user.name } } as unknown as Parameters<typeof emitTableChange>[2])
    if (b.mode === 'new') live?.emitEnv(envId, 'metadata', { by: { id: actor.user.id, name: actor.user.name } })
    await setOp(opId, { state: 'succeeded', phase: 'done', finished_on: new Date(), result: { tables: done } })
    await audit(actor.user.id, 'backup.restore', envId, { op: opId, backup: a.manifest.id, mode: `tables-${b.mode}`, source: b.environment, tables: done })
    await runInEnvironment(envId, () => sv.meta.audit({ userId: actor.user.id, action: 'backup.restore_tables', details: { backup: a.manifest.id, mode: b.mode, tables: done } })).catch(() => {})
  }

  async function freeSource(c: pg.Client, schema: string, name: string): Promise<string> {
    const base = ('t_' + name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')).slice(0, 60)
    let cand = base
    for (let i = 2; (await c.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`${qi(schema)}.${qi(cand)}`])).rows[0].ok; i++) cand = `${base.slice(0, 56)}_${i}`
    return cand
  }

  /* ---------------------------------------------------------------- verify, restore test */

  async function verify(id: string, passphrase: string | null, actor: UserContext | null): Promise<BackupOp> {
    const row = await rowById(id)
    if (!row) throw new HttpError(404, 'not-found', 'There is no such backup.')
    const { a } = await archiveFor(id, passphrase)
    let opId: string
    try {
      opId = await newOp({ kind: 'verify', backupId: id, by: actor?.user.id ?? null })
    } catch (e) {
      await a.close()
      throw e
    }
    closeAfter(a, exclusive('verify', async () => {
      try {
        const v = await verifyArchive(a, { expectedManifestSha256: (row.manifest_sha256 as string | null) ?? null, onProgress: progressFor('op', opId) })
        if (row.state === 'uploaded' || row.state === 'missing' || !row.summary) {
          await setRow(id, { summary: summaryOf(a.manifest), kind: a.manifest.kind, method: a.manifest.method, includes_key: a.manifest.includesKey, app_version: a.manifest.app.version, schema_version: a.manifest.app.schemaVersion, manifest_sha256: row.manifest_sha256 ?? a.manifestSha256, ...(a.manifest.kind === 'environment' ? { environment_id: a.manifest.environments[0]?.id ?? null, environment_name: a.manifest.environments[0]?.name ?? null } : {}) })
        }
        await setRow(id, v.ok ? { state: 'ok', verified_on: new Date(), verify_error: v.notes.join(' ') || null } : { verify_error: v.errors.slice(0, 5).join(' ') })
        await setOp(opId, { state: v.ok ? 'succeeded' : 'failed', finished_on: new Date(), ...(v.ok ? {} : { error: v.errors.slice(0, 5).join(' ') }), result: { files: v.files, bytes: v.bytes, rows: v.rows, notes: v.notes } })
        await audit(actor?.user.id ?? null, 'backup.verify', null, { id, ok: v.ok, errors: v.errors.slice(0, 5) })
        void push({ backup: await info(id) })
      } catch (e) {
        await setOp(opId, { state: 'failed', finished_on: new Date(), error: errMessage(e) })
      } finally {
        await a.close()
      }
    }))
    return getOp(opId)
  }

  /** restores every schema of the newest good backup into scratch schemas, compares the rows, drops them (rollback) */
  async function restoreTest(by: string | null): Promise<{ backupId: string | null; ok: boolean; error?: string; schemas: number; rows: number }> {
    const rows = await db().query<Row>(`SELECT * FROM "ab"."backups" WHERE state = 'ok' ORDER BY (kind = 'install') DESC, created_on DESC LIMIT 1`)
    if (!rows.length) return { backupId: null, ok: false, error: 'There is no good backup to test.', schemas: 0, rows: 0 }
    const id = String(rows[0].id)
    const opId = await newOp({ kind: 'restore-test', backupId: id, by })
    let a: BackupArchive | null = null
    let count = 0
    try {
      a = (await archiveFor(id)).a
      const v = await verifyArchive(a, { expectedManifestSha256: (rows[0].manifest_sha256 as string | null) ?? null, onProgress: progressFor('op', opId) })
      if (!v.ok) throw new Error(`Verification failed: ${v.errors.slice(0, 3).join(' ')}`)
      const c = await connect(conn())
      try {
        await c.query('BEGIN')
        let i = 0
        for (const sc of a.manifest.schemas) {
          const scratch = `ab_rt_${randomBytes(4).toString('hex')}_${i++}`
          const stored = await restoreSchema(c, a, sc.name, scratch, { onProgress: progressFor('op', opId) })
          for (const n of stored.values()) count += n
        }
      } finally {
        await c.query('ROLLBACK').catch(() => {})
        await c.end().catch(() => {})
      }
      await setRow(id, { restore_tested_on: new Date(), restore_test_error: null })
      await setOp(opId, { state: 'succeeded', finished_on: new Date(), result: { schemas: a.manifest.schemas.length, rows: count }, progress: null })
      await audit(by, 'backup.restore_test', null, { id, ok: true, schemas: a.manifest.schemas.length, rows: count })
      return { backupId: id, ok: true, schemas: a.manifest.schemas.length, rows: count }
    } catch (e) {
      const why = errMessage(e)
      await setRow(id, { restore_tested_on: new Date(), restore_test_error: why.slice(0, 2000) }).catch(() => {})
      await setOp(opId, { state: 'failed', finished_on: new Date(), error: why, progress: null })
      await audit(by, 'backup.restore_test', null, { id, ok: false, error: why })
      await notifyAdmins('Backup restore test failed', `${rows[0].file_name}: ${why}`)
      return { backupId: id, ok: false, error: why, schemas: 0, rows: count }
    } finally {
      await a?.close()
    }
  }

  /* ---------------------------------------------------------------- health */

  async function health(): Promise<BackupHealth> {
    const cfg = cached
    const ok = (await db().query<Row>(`SELECT id, kind, finished_on, created_on FROM "ab"."backups" WHERE state = 'ok' AND kind = 'install' ORDER BY created_on DESC LIMIT 1`))[0]
    const fail = (await db().query<Row>(`SELECT id, created_on, error FROM "ab"."backups" WHERE state = 'failed' ORDER BY created_on DESC LIMIT 1`))[0]
    const running = await db().query<Row>(`SELECT id, kind, environment_id, progress FROM "ab"."backups" WHERE state IN ('queued', 'running', 'verifying') ORDER BY created_on`)
    const at = ok ? iso(ok.created_on)! : null
    const ageHours = at ? Math.round(((Date.now() - new Date(at).getTime()) / 3_600_000) * 10) / 10 : Infinity
    const stale = cfg.enabled && ageHours > cfg.staleHours
    let nextRun: string | null = null
    try {
      const sc = await runInEnvironment(DEFAULT_ENVIRONMENT_ID, () => s().kernel.jobs.schedules.get('sched_backup_install'))
      nextRun = sc?.enabled ? sc.nextRunAt ?? null : null
    } catch { /* no schedules yet */ }
    const lastFailure = fail && (!ok || new Date(String(fail.created_on)) > new Date(String(ok.created_on))) ? { id: String(fail.id), at: iso(fail.created_on)!, error: String(fail.error ?? '') } : null
    const message = !cfg.enabled
      ? 'Automatic backups are off.'
      : !at ? 'No install backup has been made yet.'
        : stale ? `The last good install backup is ${Math.round(ageHours)} hours old (more than ${cfg.staleHours}).`
          : lastFailure ? `The last backup failed: ${lastFailure.error}` : `The last install backup is ${ageHours < 1 ? 'less than an hour' : `${Math.round(ageHours)} hours`} old.`
    return {
      enabled: cfg.enabled,
      lastOk: ok ? { id: String(ok.id), at: at!, kind: ok.kind as BackupKind, ageHours } : null,
      lastFailure, stale: stale || (cfg.enabled && !at), staleHours: cfg.staleHours,
      running: running.map((r) => ({ id: String(r.id), kind: r.kind as BackupKind, ...(str(r.environment_id) ? { environmentId: str(r.environment_id) } : {}), ...(r.progress ? { progress: json<BackupProgress>(r.progress) } : {}) })),
      nextRun, message,
    }
  }

  async function healthCheck(): Promise<void> {
    const h = await health()
    await prune().catch((e) => log('warn', `backup retention: ${errText(e)}`))
    if (!h.stale || !h.enabled) return
    // nobody is told twice within a day
    const last = (await db().query<Row>(`SELECT v FROM "ab"."settings" WHERE k = $1`, [STALE_NOTICE_KEY]))[0]
    if (last && Date.now() - new Date(String(last.v)).getTime() < 24 * 3_600_000) return
    // an install that never had a backup gets a day before the first warning
    if (!h.lastOk) {
      const firstUser = (await db().query<Row>(`SELECT min(created_on) AS m FROM "ab"."users"`))[0]
      if (firstUser?.m && Date.now() - new Date(String(firstUser.m)).getTime() < h.staleHours * 3_600_000) return
    }
    await db().exec(`INSERT INTO "ab"."settings" (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [STALE_NOTICE_KEY, new Date().toISOString()])
    await notifyAdmins('Backups are out of date', h.message)
  }

  /* ---------------------------------------------------------------- schedules and jobs */

  async function syncSchedules(cfg: StoredConfig = cached): Promise<void> {
    const sv = s()
    if (!sv.ready()) return
    const k = sv.kernel
    const envs = (await sv.install.environments.list()).map((e) => e.id)
    const want = [
      { id: 'sched_backup_install', name: 'Install backup', description: 'Backs up the whole install (schema ab, every environment, attachments and data files). Settings: Admin console > Backups.', cron: cfg.install.cron, timeZone: cfg.install.timeZone, enabled: cfg.enabled && cfg.install.enabled, jobType: BACKUP_JOB, payload: { scope: 'install', trigger: 'schedule' } },
      ...Object.entries(cfg.environments).filter(([id]) => envs.includes(id)).map(([id, e]) => ({
        id: `sched_backup_env_${id}`, name: `Environment backup: ${id}`, description: 'Backs up one environment. Settings: Admin console > Backups.', cron: e.cron, timeZone: e.timeZone, enabled: cfg.enabled && e.enabled, jobType: BACKUP_JOB, payload: { scope: id, trigger: 'schedule' },
      })),
      { id: 'sched_backup_restore_test', name: 'Backup restore test', description: 'Restores the newest good backup into temporary schemas, compares the rows, and drops them.', cron: cfg.restoreTest.cron, timeZone: cfg.restoreTest.timeZone, enabled: cfg.enabled && cfg.restoreTest.enabled, jobType: RESTORE_TEST_JOB, payload: {} },
      { id: 'sched_backup_health', name: 'Backup health', description: 'Prunes old backups and warns install administrators when backups are out of date.', cron: '41 * * * *', timeZone: 'UTC', enabled: true, jobType: HEALTH_JOB, payload: {} },
    ]
    await runInEnvironment(DEFAULT_ENVIRONMENT_ID, async () => {
      await k.jobs.schedules.ensureBuiltins(want.map((w) => ({ id: w.id, name: w.name, description: w.description, cron: w.cron, jobType: w.jobType, payload: w.payload, enabled: false, misfire: 'run_once' as const })))
      for (const w of want) {
        const cur = await k.jobs.schedules.get(w.id)
        if (!cur) continue
        if (cur.cron !== w.cron || cur.timeZone !== w.timeZone || cur.enabled !== w.enabled || JSON.stringify(cur.payload) !== JSON.stringify(w.payload) || cur.name !== w.name || cur.misfire !== 'run_once') {
          await k.jobs.schedules.update(w.id, { name: w.name, cron: w.cron, timeZone: w.timeZone, enabled: w.enabled, payload: w.payload, misfire: 'run_once' })
        }
      }
      for (const sc of await k.jobs.schedules.list()) {
        if (sc.id.startsWith('sched_backup_env_') && !want.some((w) => w.id === sc.id) && sc.enabled) await k.jobs.schedules.update(sc.id, { enabled: false })
      }
    })
  }

  const obj = (raw: unknown): Record<string, unknown> => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {})
  deps.kernel.jobs.register<Record<string, unknown>>({
    type: BACKUP_JOB,
    schedule: 'install',
    description: 'Makes a backup (install or one environment), verifies it, copies it off-site and applies retention.',
    parse: obj,
    concurrency: 1,
    maxAttempts: 1,
    timeoutMs: 24 * 3_600_000,
    async handler(p, ctx) {
      const scope = typeof p.scope === 'string' ? p.scope : 'install'
      const trigger = (p.trigger === 'manual' ? 'manual' : 'schedule') as BackupTrigger
      const backupId = typeof p.backupId === 'string' ? p.backupId : undefined
      if (backupId) {
        const r = await rowById(backupId)
        if (!r || r.state !== 'queued') return { skipped: true, reason: r ? `state ${r.state}` : 'deleted' }
      }
      const cfg = await loadConfig()
      if (trigger === 'schedule' && !cfg.enabled) return { skipped: true, reason: 'automatic backups are off' }
      let passphrase: string | null = null
      if (backupId) {
        const r = await rowById(backupId)
        if (r?.encrypted) {
          passphrase = pendingPass.get(backupId) ?? null
          if (!passphrase) {
            await setRow(backupId, { state: 'failed', error: 'The passphrase given for this backup was lost when the server restarted (it is never stored). Start the backup again.', finished_on: new Date() })
            throw new JobError('passphrase lost', { retry: false })
          }
        }
      } else if (cfg.passphraseSealed) {
        try { passphrase = s().secrets.decrypt(cfg.passphraseSealed) } catch { throw new JobError('The saved backup passphrase cannot be decrypted (was the secret key replaced?). Save it again in Admin console > Backups.', { retry: false }) }
      }
      const byId = typeof p.by === 'string' ? p.by : null
      const u = byId ? await s().meta.users.get(byId).catch(() => null) : null
      const includeKey = backupId ? !!(await rowById(backupId))?.includes_key : scope === 'install' && cfg.install.includeKey
      const beat = setInterval(() => { void ctx.heartbeat().catch(() => {}) }, 10_000)
      try {
        const b = await exclusive('backup', () => performBackup({
          id: backupId, scope, trigger, by: u ? { id: u.id, name: u.name, email: u.email } : null, passphrase,
          includeKey, jobId: ctx.job.id, signal: ctx.signal,
        }))
        return { id: b.id, file: b.fileName, bytes: b.sizeBytes }
      } catch (e) {
        throw new JobError(errMessage(e), { retry: false })
      } finally {
        clearInterval(beat)
      }
    },
  })
  deps.kernel.jobs.register({
    type: RESTORE_TEST_JOB,
    schedule: 'install',
    description: 'Restores the newest good backup into temporary schemas, compares row counts, and drops them.',
    concurrency: 1, maxAttempts: 1, timeoutMs: 24 * 3_600_000,
    async handler(_p, ctx) {
      const beat = setInterval(() => { void ctx.heartbeat().catch(() => {}) }, 10_000)
      try {
        const r = await exclusive('restore-test', () => restoreTest(null))
        if (!r.ok) throw new JobError(r.error ?? 'The restore test failed.', { retry: false })
        return r
      } finally {
        clearInterval(beat)
      }
    },
  })
  deps.kernel.jobs.register({
    type: HEALTH_JOB,
    schedule: 'install',
    description: 'Applies backup retention and warns install administrators when backups are out of date.',
    concurrency: 1, maxAttempts: 2, timeoutMs: 10 * 60_000,
    async handler() {
      await healthCheck()
      return { ok: true }
    },
  })

  /* ---------------------------------------------------------------- start, rescan, upload */

  /** after the database is (re)opened: settings, interrupted work, the folder, schedules */
  async function onDatabaseReady(): Promise<void> {
    await loadConfig()
    ready = true
    // backups that were running when the server stopped did not finish
    const stuck = await db().query<Row>(`UPDATE "ab"."backups" SET state = 'failed', error = 'Interrupted: the server stopped while this backup was being made.', finished_on = now(), progress = NULL WHERE state IN ('running', 'verifying') RETURNING id, file_name`)
    for (const r of stuck) await fs.promises.rm(path.join(folderOf(cached), `.tmp-${r.id}${EXT}`), { force: true }).catch(() => {})
    // restores: before the commit nothing changed (the transaction rolled back); after it only the folder swap remains
    const ops = await db().query<Row>(`SELECT * FROM "ab"."backup_ops" WHERE state = 'running'`)
    for (const o of ops) {
      const target = str(o.target_environment)
      if (o.kind === 'restore' && o.mode === 'in-place' && target) {
        const dirs = s().environments.dirs(target)
        const staging = `${dirs.root}.restore-${o.id}`
        if (o.phase === 'swap-files' && fs.existsSync(staging)) {
          await swapFolders(dirs.root, staging, `${dirs.root}.pre-${o.id}`).catch((e) => log('error', `restore ${o.id}: finishing the folder swap failed: ${errText(e)}`))
          await setOp(String(o.id), { state: 'succeeded', phase: 'done', finished_on: new Date(), error: 'Finished after a server restart (the folder swap).' })
        } else {
          await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})
          await setOp(String(o.id), { state: 'failed', finished_on: new Date(), error: 'Interrupted: the server stopped during the restore. Nothing was changed.' })
        }
        await db().exec(`UPDATE "ab"."environments" SET state = 'ready' WHERE id = $1 AND state = 'restoring'`, [target])
      } else {
        await setOp(String(o.id), { state: 'failed', finished_on: new Date(), error: 'Interrupted: the server stopped.' })
        if (o.kind === 'restore' && o.mode === 'new' && target) {
          await db().exec(`UPDATE "ab"."environments" SET state = 'failed', last_error = 'Restoring it was interrupted (the server stopped). Delete it and restore again.' WHERE id = $1 AND state = 'creating'`, [target]).catch(() => {})
        }
      }
    }
    await db().exec(`UPDATE "ab"."environments" SET state = 'ready' WHERE state = 'restoring'`)
    s().environments.invalidate()
    await rescan().catch((e) => log('warn', `backup folder scan: ${errText(e)}`))
    await syncSchedules().catch((e) => log('warn', `backup schedules: ${errText(e)}`))
    // the folder of the work files of interrupted runs
    try {
      for (const n of await fs.promises.readdir(folderOf(cached))) {
        if (n.startsWith('.work-') || n.startsWith('.upload-')) await fs.promises.rm(path.join(folderOf(cached), n), { recursive: true, force: true }).catch(() => {})
      }
    } catch { /* no folder yet */ }
  }

  /** archives in the folder that the catalogue does not know (after an install restore, copied in by hand) are added; missing ones marked */
  async function rescan(): Promise<{ added: number; missing: number }> {
    const dir = folderOf(cached)
    let names: string[] = []
    try { names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith(EXT) && !n.startsWith('.')) } catch { names = [] }
    const rows = await db().query<Row>(`SELECT id, file_name, state FROM "ab"."backups"`)
    const known = new Set(rows.map((r) => String(r.file_name)))
    let added = 0
    for (const n of names) {
      if (known.has(n)) continue
      await registerFile(path.join(dir, n), 'upload', null).then(() => added++, (e) => log('warn', `backup folder: ${n} is not a readable backup: ${errMessage(e)}`))
    }
    let missing = 0
    for (const r of rows) {
      if (['queued', 'running', 'verifying'].includes(String(r.state))) continue
      const exists = names.includes(String(r.file_name))
      if (!exists && r.state !== 'missing' && r.state !== 'failed') { await setRow(String(r.id), { state: 'missing' }); missing++ }
      if (exists && r.state === 'missing') await setRow(String(r.id), { state: 'ok' })
    }
    return { added, missing }
  }

  /** adds an archive in the folder to the catalogue (its manifest when readable; encrypted ones wait for their passphrase) */
  async function registerFile(file: string, trigger: BackupTrigger, by: string | null): Promise<string> {
    const name = path.basename(file)
    const st = await fs.promises.stat(file)
    const id = uid('bk')
    if (await isEncryptedFile(file)) {
      const m = /^appbuilder-(.+?)-\d{8}-\d{6}Z/.exec(name)
      const scope = m?.[1] ?? 'install'
      await db().exec(
        `INSERT INTO "ab"."backups" (id, file_name, kind, environment_id, environment_name, trigger, state, encrypted, size_bytes, created_on, created_by, note) VALUES ($1, $2, $3, $4, $4, $5, 'uploaded', true, $6, $7, $8, $9)`,
        [id, name, scope === 'install' ? 'install' : 'environment', scope === 'install' ? null : scope, trigger, st.size, st.mtime, by, 'Encrypted: enter its passphrase to check it and see what it contains.'])
      return id
    }
    const a = await openArchive(file)
    try {
      const m = a.manifest
      const h = await sha256OfFile(file)
      await db().exec(
        `INSERT INTO "ab"."backups" (id, file_name, kind, environment_id, environment_name, trigger, state, method, encrypted, includes_key, size_bytes, sha256, manifest_sha256, created_on, finished_on, created_by, app_version, schema_version, summary, note)
         VALUES ($1, $2, $3, $4, $5, $6, 'uploaded', $7, false, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18)`,
        [id, name, m.kind, m.kind === 'environment' ? m.environments[0]?.id ?? null : null, m.kind === 'environment' ? m.environments[0]?.name ?? null : null, trigger === 'upload' ? (m.trigger ?? 'upload') : trigger,
          m.method, m.includesKey, st.size, h.sha256, a.manifestSha256, m.createdOn, m.finishedOn, by, m.app.version, m.app.schemaVersion, JSON.stringify(summaryOf(m)), trigger === 'upload' && by ? 'Uploaded' : 'Found in the backup folder'])
      // checked in the background: a good one becomes "ok"
      void exclusive('verify', async () => {
        const b = await openArchive(file)
        try {
          const v = await verifyArchive(b)
          await setRow(id, v.ok ? { state: 'ok', verified_on: new Date(), verify_error: v.notes.join(' ') || null } : { state: 'failed', error: `Verification failed: ${v.errors.slice(0, 3).join(' ')}` })
          void push({ backup: await info(id) })
        } finally {
          await b.close()
        }
      }).catch((e) => setRow(id, { state: 'failed', error: errMessage(e) }).catch(() => {}))
      return id
    } finally {
      await a.close()
    }
  }

  async function upload(req: NodeJS.ReadableStream & { headers: Record<string, string | string[] | undefined> }, name: string, actor: UserContext): Promise<BackupInfo> {
    const maxGb = Number(env.APPBUILDER_BACKUP_MAX_UPLOAD_GB) || 50
    const limit = maxGb * 1024 ** 3
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'invalid', `The archive is larger than ${maxGb} GB (APPBUILDER_BACKUP_MAX_UPLOAD_GB).`)
    const dir = folderOf(await loadConfig())
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
    const id = randomBytes(6).toString('hex')
    const part = path.join(dir, `.upload-${id}.part`)
    let n = 0
    const { pipeline } = await import('node:stream/promises')
    const { Transform } = await import('node:stream')
    try {
      await pipeline(req, new Transform({ transform(c: Buffer, _e, cb) { n += c.length; if (n > limit) cb(new HttpError(413, 'invalid', `The archive is larger than ${maxGb} GB.`)); else cb(null, c) } }), fs.createWriteStream(part, { mode: 0o600 }))
      const base = (name || 'uploaded').replace(/\.abbak$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'uploaded'
      const final = path.join(dir, `${/^appbuilder-/.test(base) ? base : `appbuilder-${base}`}-up${id}${EXT}`)
      await fs.promises.rename(part, final)
      let bid: string
      try {
        bid = await registerFile(final, 'upload', actor.user.id)
      } catch (e) {
        await fs.promises.rm(final, { force: true })
        throw new HttpError(422, 'invalid', `This file is not an Appbuilder backup: ${errMessage(e)}`)
      }
      await audit(actor.user.id, 'backup.upload', null, { id: bid, file: path.basename(final), bytes: n })
      return info(bid)
    } finally {
      await fs.promises.rm(part, { force: true }).catch(() => {})
    }
  }

  async function remove(id: string, actor: UserContext): Promise<void> {
    const r = await rowById(id)
    if (!r) throw new HttpError(404, 'not-found', 'There is no such backup.')
    if (['queued', 'running', 'verifying'].includes(String(r.state)) && r.state !== 'queued') throw new HttpError(409, 'conflict', 'This backup is being made: wait until it finishes.')
    const it = toInfo(r, new Map())
    await removeFiles(it, cached)
    await db().exec(`DELETE FROM "ab"."backups" WHERE id = $1`, [id])
    await audit(actor.user.id, 'backup.delete', it.environmentId ?? null, { id, file: it.fileName })
  }

  async function update(id: string, b: { pinned?: unknown; note?: unknown }, actor: UserContext): Promise<BackupInfo> {
    const r = await rowById(id)
    if (!r) throw new HttpError(404, 'not-found', 'There is no such backup.')
    const patch: Record<string, unknown> = {}
    if (b.pinned !== undefined) patch.pinned = b.pinned === true
    if (b.note !== undefined) patch.note = typeof b.note === 'string' ? b.note.trim().slice(0, 300) || null : null
    await setRow(id, patch)
    await audit(actor.user.id, 'backup.update', null, { id, ...patch })
    return info(id)
  }

  /** the archive for download (after the caller checked the user); records it */
  async function downloadFile(id: string, actor: UserContext): Promise<{ file: string; name: string; size: number }> {
    const r = await rowById(id)
    if (!r) throw new HttpError(404, 'not-found', 'There is no such backup.')
    if (!['ok', 'uploaded', 'failed'].includes(String(r.state)) || r.state === 'failed') throw new HttpError(409, 'conflict', 'Only finished backups can be downloaded.')
    const file = path.join(folderOf(cached), String(r.file_name))
    const st = await fs.promises.stat(file).catch(() => null)
    if (!st) throw new HttpError(410, 'not-found', `The archive ${r.file_name} is no longer in the backup folder.`)
    await audit(actor.user.id, 'backup.download', str(r.environment_id) ?? null, { id, file: r.file_name, bytes: st.size, includesKey: !!r.includes_key, encrypted: !!r.encrypted })
    return { file, name: String(r.file_name), size: st.size }
  }

  function issueTicket(backupId: string, userId: string): string {
    const t = randomBytes(18).toString('base64url')
    for (const [k, v] of tickets) if (v.until < Date.now()) tickets.delete(k)
    tickets.set(t, { backupId, userId, until: Date.now() + 60_000 })
    return t
  }
  function useTicket(t: string, backupId: string, userId: string): boolean {
    const v = tickets.get(t)
    tickets.delete(t)
    return !!v && v.backupId === backupId && v.userId === userId && v.until >= Date.now()
  }

  /* ---------------------------------------------------------------- server upgrade: a backup before the migration */

  /**
   * Called by services.ts before migrate() when the database holds an older schema version (4 to SCHEMA_VERSION - 1):
   * an install backup of the database as it is, written straight to the backup folder (the catalogue may not exist
   * yet: the folder scan after the migration lists it). Returns the file, or throws (the caller stops the upgrade).
   */
  async function beforeMigration(dbx: SqlDb, connInfo: { settings: import('../contracts.ts').DatabaseSettings; password: string }, from: number): Promise<string | null> {
    const cfgRow = await dbx.query<Row>(`SELECT v FROM "ab"."settings" WHERE k = $1`, [CONFIG_KEY]).catch(() => [] as Row[])
    const cfg = mergeConfig(cfgRow.length ? JSON.parse(String(cfgRow[0].v)) : null)
    if (!cfg.enabled || !cfg.snapshots.beforeMigration || env.APPBUILDER_MIGRATION_BACKUP === 'skip') return null
    const envs = await dbx.query<Row>(`SELECT * FROM "ab"."environments" ORDER BY built_in DESC, id`)
    const sources: EnvSource[] = envs.filter((e) => (e.state ?? 'ready') === 'ready').map((e) => ({ id: String(e.id), name: String(e.name), type: String(e.type), schema: String(e.schema_name), schemaVersion: Number(e.schema_version) || from }))
    const id = uid('bk')
    const dir = folderOf(cfg)
    const file = path.join(dir, fileNameFor('install', new Date(), id))
    log('info', `taking an install backup before upgrading the database from schema version ${from} to ${SCHEMA_VERSION}: ${file}`)
    const started = Date.now()
    await createArchive(connInfo, {
      id, kind: 'install', environments: sources, file, method: cfg.method, pgBin: pgBinOf(cfg), passphrase: null, secretKey: null,
      trigger: 'pre-migration', note: `before upgrading from schema version ${from} to ${SCHEMA_VERSION}`, createdBy: null,
      appVersion: await appVersion(), schemaVersion: from, dirs: (eid) => s().environments.dirs(eid),
    })
    log('info', `pre-upgrade backup written in ${Math.round((Date.now() - started) / 100) / 10} s`)
    return file
  }

  /** the newest good backup that contains an environment (its own, or an install backup made after it existed) */
  async function lastBackupOf(envId: string): Promise<{ id: string; at: string; kind: BackupKind; fileName: string } | null> {
    const r = (await db().query<Row>(
      `SELECT b.id, b.created_on, b.kind, b.file_name FROM "ab"."backups" b WHERE b.state = 'ok' AND (b.environment_id = $1 OR (b.kind = 'install' AND b.summary::text LIKE $2))
        ORDER BY b.created_on DESC LIMIT 1`, [envId, `%"id": "${envId.replace(/[%_"\\]/g, '')}"%`]))[0]
    return r ? { id: String(r.id), at: iso(r.created_on)!, kind: r.kind as BackupKind, fileName: String(r.file_name) } : null
  }

  /* ---------------------------------------------------------------- the BackupService contract */


  return {
    // BackupService
    available: () => snapshotEnabled('pre-upgrade'),
    async snapshot(env_: EnvironmentRef, reason: string, o: { trigger?: 'pre-upgrade' | 'pre-delete' | 'pre-restore'; by?: string | null } = {}): Promise<SnapshotResult> {
      const trigger = o.trigger ?? 'pre-upgrade'
      if (!snapshotEnabled(trigger)) return { taken: false, message: OFF_MESSAGE }
      return exclusive('snapshot', () => snapshotLocked(env_.id, trigger, reason, o.by ?? null))
    },
    // everything else
    setLive(h: LiveHub | null) { live = h },
    onDatabaseReady,
    beforeMigration,
    config: () => cached,
    loadConfig,
    settings: () => settingsView(),
    saveSettings,
    list,
    info,
    health,
    healthCheck,
    lastBackupOf,
    recentOps,
    getOp,
    backupNow,
    backupDirect,
    contents,
    browse,
    restoreEnvironment,
    planTables: async (id: string, b: TableRestoreRequest, envId: string): Promise<TableRestorePlan> => {
      const p = await planTables(id, b, envId)
      const { defs: _d, ...plan } = p as TableRestorePlan & { defs?: unknown }
      void _d
      return plan
    },
    restoreTables,
    verify,
    restoreTest: (by: string | null) => exclusive('restore-test', () => restoreTest(by)),
    upload,
    remove,
    update,
    downloadFile,
    issueTicket,
    useTicket,
    prune: () => exclusive('prune', () => prune()),
    rescan,
    folder: () => folderOf(cached),
    busy: () => busy,
    /** wait until queued backups/restores of this process are done (tests, shutdown) */
    idle: () => chain.then(() => undefined),
    testHooks,
  }
}
