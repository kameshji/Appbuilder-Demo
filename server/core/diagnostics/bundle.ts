/**
 * Diagnostics bundle (package L): one ZIP an administrator sends to support. Built from the running server (Admin console
 * > Server logs > Diagnostics bundle) or from the command line while the server is stopped or broken
 * (`appbuilder diagnostics`, server/core/diagnostics/cli.ts).
 *
 * Everything that goes in passes redactText / redactObject (redact.ts): no passwords, keys, sealed secrets, session
 * cookies, API key secrets or the setup code; e-mail addresses are masked. Not included at all: the database contents,
 * .secret-key, backups, attachments, data files, job payloads.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerConfig } from '../contracts.ts'
import type { CoreServices } from '../services.ts'
import { readServerJson } from '../config.ts'
import { errText } from '../util.ts'
import { writeZip, type ZipEntryInput } from '../update/zip.ts'
import { appRoot, readReleaseInfo, verifyTree } from '../update/release.ts'
import { installRoot, readInstallInfo } from '../update/layout.ts'
import { SCHEMA_VERSION } from '../meta-store.ts'
import { redactObject, redactText } from './redact.ts'
import { detailedHealth, diskOf, type LiveStatsSource } from './health.ts'
import { LOG_FILE, logDirOf, readOpsSettings, rotatedName } from './logger.ts'

type Row = Record<string, unknown>

const ENV_KEYS = /^(APPBUILDER_|PORT$|NODE_ENV$|NODE_OPTIONS$|TZ$|LANG$)/

/** what the server was started with: APPBUILDER_* variables (secrets redacted), the config, server.json minus the sealed password */
export function configSnapshot(config: ServerConfig, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (ENV_KEYS.test(k) && v !== undefined) vars[k] = v
  const sj = readServerJson(config)
  const conn = sj.defaultConnection
  return redactObject({
    config: { ...config },
    environment: vars,
    serverJson: {
      setupComplete: sj.setupComplete === true,
      ...(conn ? { defaultConnection: { host: conn.host, port: conn.port, database: conn.database, user: conn.user, ssl: conn.ssl, hasPassword: !!conn.passwordSealed } } : {}),
    },
    opsSettings: readOpsSettings(config.workspaceDir),
    install: readInstallInfo(installRoot(env)),
    workspaceFiles: {
      installKeyFile: fs.existsSync(path.join(config.workspaceDir, '.secret-key')) ? 'present' : 'absent',
      serverJson: fs.existsSync(path.join(config.workspaceDir, 'server.json')) ? 'present' : 'absent',
    },
  })
}

function logEntries(logDir: string): ZipEntryInput[] {
  const out: ZipEntryInput[] = []
  for (let i = 0; i < 100; i++) {
    const name = rotatedName(i)
    const p = path.join(logDir, name)
    if (!fs.existsSync(p)) {
      if (i > 0) break
      continue
    }
    try {
      out.push({ name: `logs/${name}`, data: Buffer.from(redactText(fs.readFileSync(p, 'utf8')), 'utf8') })
    } catch { /* unreadable */ }
  }
  // the service wrapper's own logs (Windows: WinSW *.out.log / *.err.log next to the data folder)
  const info = readInstallInfo(installRoot())
  if (info) {
    const svcLogs = path.join(info.dataDir, 'logs')
    try {
      for (const f of fs.readdirSync(svcLogs).filter((x) => /\.(log|txt)$/i.test(x)).sort().slice(-10)) {
        const st = fs.statSync(path.join(svcLogs, f))
        // only the last 2 MB of each
        const fd = fs.openSync(path.join(svcLogs, f), 'r')
        const len = Math.min(st.size, 2 * 1024 * 1024)
        const buf = Buffer.alloc(len)
        fs.readSync(fd, buf, 0, len, st.size - len)
        fs.closeSync(fd)
        out.push({ name: `service-logs/${f}`, data: Buffer.from(redactText(buf.toString('utf8')), 'utf8') })
      }
    } catch { /* no service log folder */ }
  }
  return out
}

/** recent errors from the database: failed/dead jobs, failed event runs, failed backups, failed emails (no payloads) */
export async function recentErrors(services: CoreServices): Promise<Record<string, unknown>> {
  const db = services.state.db
  if (!services.ready() || !db) return { unavailable: services.state.databaseError ?? 'The database is not available.' }
  const out: Record<string, unknown> = {}
  const envs = (await services.environments.list()).filter((e) => e.state === 'ready')
  for (const e of envs) {
    const s = `"${e.schema.replace(/"/g, '""')}"`
    const one = async (key: string, sql: string) => {
      try {
        ;(out[`${e.id}:${key}`] = await db.query<Row>(sql))
      } catch (err) {
        out[`${e.id}:${key}`] = { error: errText(err) }
      }
    }
    await one('jobs', `SELECT id, type, state, attempts, max_attempts, error, created_on, finished_on, modified_on, correlation_id FROM ${s}."ab_jobs" WHERE state IN ('failed', 'dead') ORDER BY modified_on DESC LIMIT 50`)
    await one('eventRuns', `SELECT id, at, event_name, table_id, timing, op, status, message, correlation_id FROM ${s}."ab_event_runs" WHERE status IN ('failed', 'error') ORDER BY id DESC LIMIT 50`)
  }
  try {
    out.backups = await db.query<Row>(`SELECT id, kind, trigger, state, error, created_on, finished_on FROM "ab"."backups" WHERE state = 'failed' ORDER BY created_on DESC LIMIT 20`)
  } catch (err) {
    out.backups = { error: errText(err) }
  }
  try {
    out.mail = await db.query<Row>(`SELECT id, created_on, status, attempts, template, last_error FROM "ab"."mail_log" WHERE status IN ('failed', 'retrying') ORDER BY created_on DESC LIMIT 20`)
  } catch (err) {
    out.mail = { error: errText(err) }
  }
  return out
}

async function schemaSnapshot(services: CoreServices): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { server: SCHEMA_VERSION }
  if (services.state.incompatible) out.incompatible = services.state.incompatible
  if (services.state.migration) out.lastMigration = services.state.migration
  if (!services.ready() || !services.state.db) return out
  try {
    out.database = Number((await services.state.db.query<Row>(`SELECT v FROM "ab"."settings" WHERE k = 'schemaVersion'`))[0]?.v) || null
    out.environments = (await services.environments.list()).map((e) => ({ id: e.id, state: e.state, schemaVersion: e.schemaVersion, ...(e.lastError ? { lastError: e.lastError } : {}) }))
  } catch (e) {
    out.error = errText(e)
  }
  return out
}

export interface BundleInput {
  config: ServerConfig
  env?: NodeJS.ProcessEnv
  /** a running server's services (health, schema, recent errors); null from the CLI when the server could not start */
  services?: CoreServices | null
  live?: LiveStatsSource | null
  /** CLI: what went wrong while collecting (for example "the database could not be opened") */
  notes?: string[]
  /** the command line's read-only database view cannot compute the detailed health */
  skipHealth?: boolean
}

export async function buildDiagnosticsBundle(input: BundleInput): Promise<{ name: string; data: Buffer }> {
  const env = input.env ?? process.env
  const at = new Date()
  const entries: ZipEntryInput[] = []
  const notes = [...(input.notes ?? [])]
  const json = (name: string, v: unknown) => entries.push({ name, data: Buffer.from(JSON.stringify(redactObject(v), null, 2) + '\n', 'utf8') })

  const rel = readReleaseInfo()
  json('versions.json', {
    release: rel ?? { version: 'source checkout', commit: 'dev' },
    node: process.version, v8: process.versions.v8, openssl: process.versions.openssl,
    os: { type: os.type(), release: os.release(), platform: process.platform, arch: process.arch },
  })
  json('system.json', {
    hostnameLength: os.hostname().length,
    cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model ?? null,
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
    uptimeSeconds: Math.round(os.uptime()), loadAverage: os.loadavg(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, now: at.toISOString(),
    disk: [diskOf('Workspace', input.config.workspaceDir)].filter(Boolean),
  })
  json('config.json', configSnapshot(input.config, env))
  if (rel) {
    try {
      const check = verifyTree(appRoot())
      json('release-check.json', { ok: check.ok, files: check.files, missing: check.missing.slice(0, 200), changed: check.changed.slice(0, 200), extra: check.extra.slice(0, 200) })
    } catch (e) {
      notes.push(`release check failed: ${errText(e)}`)
    }
  }
  const s = input.services
  if (s) {
    if (!input.skipHealth) {
      try {
        json('health.json', await detailedHealth(s, input.live ?? null))
      } catch (e) {
        notes.push(`health: ${errText(e)}`)
      }
    }
    try {
      json('schema.json', await schemaSnapshot(s))
    } catch (e) {
      notes.push(`schema: ${errText(e)}`)
    }
    try {
      json('recent-errors.json', await recentErrors(s))
    } catch (e) {
      notes.push(`recent errors: ${errText(e)}`)
    }
  } else {
    notes.push('The server was not running in this process: no health, schema or recent errors from the database.')
  }
  entries.push(...logEntries(logDirOf(input.config.workspaceDir, env)))
  if (!entries.some((e) => e.name === `logs/${LOG_FILE}`)) notes.push('No log file was found (file logging off, or a different APPBUILDER_LOG_DIR).')
  entries.push({
    name: 'README.txt',
    data: Buffer.from([
      'Appbuilder diagnostics bundle',
      `Created ${at.toISOString()}`,
      '',
      'Contents: versions, system facts, configuration (secrets removed), health checks, schema versions,',
      'recent failed jobs / event runs / backups / emails (no payloads), and the server log files.',
      'Removed or masked before writing: passwords, passphrases, keys, sealed secrets, session cookies, bearer tokens,',
      'API key secrets, SCRAM verifiers, the first-run setup code; e-mail addresses are shortened to a***@domain.',
      'Not included: database contents, .secret-key, backups, attachments, data files.',
      '',
      ...(notes.length ? ['Notes:', ...notes.map((n) => `- ${redactText(n)}`)] : []),
      '',
    ].join('\n'), 'utf8'),
  })
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return { name: `appbuilder-diagnostics-${stamp}.zip`, data: writeZip(entries) }
}
