/**
 * Command-line tools of an installed Appbuilder (package L). The installers put a wrapper on the PATH:
 * `appbuilder <command>` (Linux /usr/local/bin/appbuilder, Windows <root>\appbuilder.cmd), which runs
 * `node <root>/app/server/main.ts <command>` with the service's environment file loaded.
 *
 *   appbuilder version                       the installed release (version, commit, build date, schema)
 *   appbuilder verify-release <zip|folder>   checksums and signature of a package (against this install's keys)
 *   appbuilder update <zip|folder>           installs a release: see apply.ts      [--staged] [--yes] [--allow-unsigned]
 *                                            [--reinstall] [--allow-downgrade] [--force] [--health-timeout <seconds>]
 *   appbuilder diagnostics [--out <file>]    writes a diagnostics bundle (secrets removed), also when the server is down
 *   appbuilder health                        asks the running server: ok / starting / degraded
 *   appbuilder restore <archive> ...         disaster recovery (backup/cli.ts)
 *   appbuilder db-check                      installers: exit 0 when the saved database login works
 *   appbuilder admin list|reset-password|reset-mfa|make-install-admin <email>   locked out: identity/admin-cli.ts
 *   appbuilder seed-config ...               installers only: writes server.json with the database password sealed
 *                                            (the password is read from standard input, never from the command line)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DatabaseSettings } from '../contracts.ts'
import { envDatabase, loadConfig, readServerJson, writeServerJson } from '../config.ts'
import { createSecretBox, loadSecretKey } from '../secrets.ts'
import { createPgDb } from '../../connectors/postgres/db.ts'
import { SCHEMA_VERSION } from '../meta-store.ts'
import { CONFIG_KEY as BACKUP_CONFIG_KEY } from '../backup/service.ts'
import { applyUpdate, packageProblems, preparePackage, type ServiceControl, type UpdateDeps } from './apply.ts'
import { appRoot, readReleaseInfo, readTrustedKeys } from './release.ts'
import { detectInstallRoot, parseEnvFile, readInstallInfo, updatesDir, type InstallInfo } from './layout.ts'
import type { HealthStatus } from '../../../src/platform/ops.ts'
import type { CoreServices } from '../services.ts'

const run = promisify(execFile)
const out = (line = ''): void => { process.stdout.write(line + '\n') }
const err = (line: string): void => { process.stderr.write(line + '\n') }

export const CLI_COMMANDS = new Set(['version', 'verify-release', 'update', 'diagnostics', 'health', 'seed-config', 'db-check'])

function parse(argv: string[], flags: string[]): { args: string[]; o: Record<string, string | true> } {
  const o: Record<string, string | true> = {}
  const args: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      if (flags.includes(k)) o[k] = true
      else o[k] = argv[++i] ?? ''
    } else args.push(a)
  }
  return { args, o }
}

/** loads the service environment file of the install into process.env (values already set win) */
export function loadInstallEnv(env: NodeJS.ProcessEnv = process.env): InstallInfo | null {
  const root = detectInstallRoot(appRoot(), env)
  const info = readInstallInfo(root)
  if (info?.envFile) {
    try {
      for (const [k, v] of Object.entries(parseEnvFile(fs.readFileSync(info.envFile, 'utf8')))) if (env[k] === undefined) env[k] = v
    } catch (e) {
      err(`WARNING: could not read ${info.envFile}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return info
}

/** the system database login: APPBUILDER_DB_*, else server.json with the password unsealed (needs the key) */
export function databaseLogin(env: NodeJS.ProcessEnv = process.env): { settings: DatabaseSettings; password: string } | null {
  const fromEnv = envDatabase(env)
  if (fromEnv) return fromEnv
  const config = loadConfig(env)
  const sj = readServerJson(config).defaultConnection
  if (!sj) return null
  const box = createSecretBox(loadSecretKey(config.workspaceDir, env))
  return { settings: { host: sj.host, port: Number(sj.port) || 5432, database: sj.database, user: sj.user, ssl: !!sj.ssl }, password: sj.passwordSealed ? box.decrypt(sj.passwordSealed) : '' }
}

async function withDb<T>(fn: (db: ReturnType<typeof createPgDb>) => Promise<T>, env: NodeJS.ProcessEnv = process.env): Promise<T | null> {
  const login = databaseLogin(env)
  if (!login) return null
  const db = createPgDb(login.settings, login.password, { max: 1, onError: () => {} })
  try {
    return await fn(db)
  } finally {
    await db.close().catch(() => {})
  }
}

export async function probeHealth(port: number, timeoutMs = 3000): Promise<HealthStatus | 'down'> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(timeoutMs) })
    const body = (await res.json().catch(() => ({}))) as { status?: string }
    return body.status === 'ok' || body.status === 'starting' || body.status === 'degraded' ? body.status : 'down'
  } catch {
    return 'down'
  }
}

export function serviceControl(info: InstallInfo): ServiceControl {
  if (info.platform === 'linux') {
    return {
      stop: async () => { await run('systemctl', ['stop', info.serviceName]) },
      start: async () => { await run('systemctl', ['start', info.serviceName]) },
      running: async () => (await run('systemctl', ['is-active', '--quiet', info.serviceName]).then(() => true, () => false)),
    }
  }
  const query = async (): Promise<string> => (await run('sc.exe', ['query', info.serviceName]).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }))).stdout
  const waitFor = async (state: string, ms: number) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if ((await query()).includes(state)) return
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error(`The service ${info.serviceName} did not reach ${state} within ${ms / 1000} s.`)
  }
  return {
    stop: async () => {
      if ((await query()).includes('STOPPED')) return
      await run('sc.exe', ['stop', info.serviceName]).catch(() => {})
      await waitFor('STOPPED', 90_000)
    },
    start: async () => {
      await run('sc.exe', ['start', info.serviceName]).catch(() => {})
      await waitFor('RUNNING', 60_000)
    },
    running: async () => (await query()).includes('RUNNING'),
  }
}

async function secureAppFolder(info: InstallInfo, dir: string): Promise<void> {
  if (info.platform === 'linux') {
    await run('chown', ['-R', 'root:root', dir])
    await run('chmod', ['-R', 'u=rwX,go=rX', dir])
  } else {
    // inherit the install root's ACL (Administrators/SYSTEM full, the service account read)
    await run('icacls.exe', [dir, '/reset', '/T', '/C', '/Q'])
  }
}

function ask(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false)
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(`${question} [y/N] `, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())) })
  })
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}

/* ------------------------------------------------------------------ commands */

async function cmdVersion(): Promise<number> {
  const r = readReleaseInfo()
  if (!r) {
    out(`Appbuilder (source checkout), schema ${SCHEMA_VERSION}, Node.js ${process.version}`)
    return 0
  }
  out(`Appbuilder ${r.version}`)
  out(`  commit   ${r.commit}`)
  out(`  built    ${r.built}`)
  out(`  schema   ${r.schemaVersion}`)
  out(`  node     ${process.version} (needs ${r.node})`)
  const keys = readTrustedKeys()
  out(`  trusts   ${keys.length ? keys.map((k) => `${k.id}${k.comment ? ` (${k.comment})` : ''}`).join(', ') : 'no release keys (development build: unsigned updates are accepted)'}`)
  return 0
}

async function cmdVerify(argv: string[]): Promise<number> {
  const { args, o } = parse(argv, ['allow-unsigned'])
  if (!args[0]) { err('Usage: appbuilder verify-release <release.zip | folder>'); return 64 }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-verify-'))
  try {
    const p = preparePackage(args[0], path.join(tmp, 'pkg'), appRoot())
    const problems = packageProblems(p, readTrustedKeys().length, { allowUnsigned: o['allow-unsigned'] === true })
    out(`Appbuilder ${p.info.version} (${p.info.commit}), schema ${p.info.schemaVersion}, built ${p.info.built}`)
    out(`Checksums: ${p.check.ok ? `all ${p.check.files} files match` : `MISMATCH missing=${p.check.missing.length} changed=${p.check.changed.length} extra=${p.check.extra.length}`}`)
    out(`Signature: ${p.signature.state}${'keyId' in p.signature ? ` (key ${p.signature.keyId})` : ''}${p.signature.state === 'invalid' ? `: ${p.signature.reason}` : ''}`)
    for (const x of problems) err(`PROBLEM: ${x}`)
    return problems.length ? 2 : 0
  } catch (e) {
    err(`ERROR: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

async function cmdUpdate(argv: string[], info: InstallInfo | null): Promise<number> {
  const { args, o } = parse(argv, ['staged', 'yes', 'allow-unsigned', 'reinstall', 'allow-downgrade', 'force'])
  if (!info) {
    err('This command updates an install made by the installer (install.json was not found next to the app folder).')
    err('A source checkout is updated with git pull, npm ci and npm run build (docs/admin/upgrades.md).')
    return 64
  }
  let source = args[0]
  if (o.staged) source = path.join(updatesDir(info, loadConfig().workspaceDir), 'staged', 'package')
  if (!source) { err('Usage: appbuilder update <release.zip | folder> | --staged'); return 64 }
  try {
    fs.accessSync(info.root, fs.constants.W_OK)
  } catch {
    err(`ERROR: ${info.root} is not writable: run this as ${info.platform === 'linux' ? 'root (sudo appbuilder update ...)' : 'an administrator (elevated PowerShell)'}.`)
    return 77
  }
  const deps: UpdateDeps = {
    control: serviceControl(info),
    probe: () => probeHealth(info.port),
    readSchema: async () => (await withDb(async (db) => Number((await db.query<{ v: string }>(`SELECT v FROM "ab"."settings" WHERE k = 'schemaVersion'`))[0]?.v) || null)) ?? null,
    findBackup: async (since) => (await withDb(async (db) => {
      const r = (await db.query<{ file_name: string }>(`SELECT file_name FROM "ab"."backups" WHERE trigger = 'pre-migration' AND created_on >= $1 ORDER BY created_on DESC LIMIT 1`, [since]))[0]
      if (!r) return null
      const cfg = (await db.query<{ v: string }>(`SELECT v FROM "ab"."settings" WHERE k = $1`, [BACKUP_CONFIG_KEY]))[0]
      const folder = process.env.APPBUILDER_BACKUP_DIR || (cfg ? (JSON.parse(cfg.v) as { folder?: string | null }).folder : null) || path.join(loadConfig().workspaceDir, 'backups')
      return path.join(folder, r.file_name)
    })) ?? null,
    nodeVersion: async () => (await run(info.node, ['--version'])).stdout.trim(),
    secure: (dir) => secureAppFolder(info, dir),
    log: (l) => out(l),
    confirm: ask,
  }
  const timeout = Number(o['health-timeout'])
  const r = await applyUpdate(info, source, deps, {
    yes: o.yes === true, allowUnsigned: o['allow-unsigned'] === true, reinstall: o.reinstall === true,
    allowDowngrade: o['allow-downgrade'] === true, force: o.force === true,
    ...(timeout > 0 ? { healthTimeoutMs: timeout * 1000 } : {}),
  }, path.join(updatesDir(info, loadConfig().workspaceDir), 'history.json'))
  if (r.result === 'updated' || r.result === 'unchanged') {
    if (r.result === 'unchanged') out(r.message)
    if (o.staged) fs.rmSync(path.join(updatesDir(info, loadConfig().workspaceDir), 'staged'), { recursive: true, force: true })
    return 0
  }
  err(`${r.result === 'refused' ? 'REFUSED' : 'FAILED'}: ${r.message}`)
  return r.result === 'refused' ? 3 : 2
}

async function cmdHealth(info: InstallInfo | null): Promise<number> {
  const port = info?.port ?? (Number(process.env.PORT) || 5174)
  const s = await probeHealth(port)
  out(s)
  return s === 'ok' ? 0 : 1
}

async function cmdDiagnostics(argv: string[]): Promise<number> {
  const { o } = parse(argv, [])
  const { buildDiagnosticsBundle } = await import('../diagnostics/bundle.ts')
  const config = loadConfig()
  const notes: string[] = []
  let services: CoreServices | null = null
  let db: ReturnType<typeof createPgDb> | null = null
  try {
    const login = databaseLogin()
    if (login) {
      db = createPgDb(login.settings, login.password, { max: 1, onError: () => {} })
      await db.query('SELECT 1')
      const d = db
      // read-only view for the bundle: schema versions and recent errors, no migration, no job worker
      services = {
        ready: () => true,
        state: { db: d, meta: null, install: null, settings: login.settings, location: `${login.settings.host}:${login.settings.port}/${login.settings.database}` },
        environments: {
          list: async () => (await d.query<Record<string, unknown>>(`SELECT id, name, schema_name, state, schema_version, last_error FROM "ab"."environments" ORDER BY id`))
            .map((r) => ({ id: String(r.id), name: String(r.name), schema: String(r.schema_name), state: String(r.state ?? 'ready'), schemaVersion: Number(r.schema_version) || 0, ...(r.last_error ? { lastError: String(r.last_error) } : {}) })),
        },
      } as unknown as CoreServices
    } else notes.push('No database is configured.')
  } catch (e) {
    notes.push(`The database could not be opened: ${e instanceof Error ? e.message : String(e)}`)
    services = null
  }
  const health = await probeHealth(Number(process.env.PORT) || 5174)
  notes.push(`GET /api/v1/health of the running server: ${health}`)
  try {
    const b = await buildDiagnosticsBundle({ config, services, notes, skipHealth: true })
    const file = path.resolve(typeof o.out === 'string' && o.out ? o.out : b.name)
    fs.writeFileSync(file, b.data, { mode: 0o600 })
    out(`Diagnostics bundle written: ${file} (${b.data.length} bytes). Secrets are removed; check it before sending it.`)
    return 0
  } finally {
    await db?.close().catch(() => {})
  }
}

/** installers only: server.json with the system database, password sealed with the install key (created if missing) */
async function cmdSeedConfig(argv: string[]): Promise<number> {
  const { o } = parse(argv, ['ssl', 'test'])
  const workspace = typeof o.workspace === 'string' ? o.workspace : ''
  const host = typeof o['db-host'] === 'string' ? o['db-host'] : '127.0.0.1'
  const port = Number(o['db-port']) || 5432
  const database = typeof o['db-name'] === 'string' ? o['db-name'] : 'appbuilder'
  const user = typeof o['db-user'] === 'string' ? o['db-user'] : 'appbuilder'
  if (!workspace) { err('Usage: appbuilder seed-config --workspace <dir> [--db-host h] [--db-port p] [--db-name n] [--db-user u] [--ssl] [--test]  (password on standard input)'); return 64 }
  const password = await readStdin()
  if (!password) { err('ERROR: no password on standard input.'); return 64 }
  const config = loadConfig({ ...process.env, APPBUILDER_WORKSPACE: workspace })
  const settings: DatabaseSettings = { host, port, database, user, ssl: o.ssl === true }
  if (o.test) {
    const db = createPgDb(settings, password, { max: 1, onError: () => {} })
    try {
      await db.query('SELECT 1')
    } catch (e) {
      err(`ERROR: cannot sign in to PostgreSQL as ${user} at ${host}:${port}/${database}: ${e instanceof Error ? e.message : String(e)}`)
      return 2
    } finally {
      await db.close().catch(() => {})
    }
  }
  // the key the server will use (APPBUILDER_SECRET_KEY when set in the service environment, else workspace/.secret-key)
  const box = createSecretBox(loadSecretKey(config.workspaceDir, process.env))
  const prev = readServerJson(config)
  writeServerJson(config, { ...prev, defaultConnection: { ...settings, passwordSealed: box.encrypt(password) } })
  out(`Wrote ${path.join(config.workspaceDir, 'server.json')} (database ${user}@${host}:${port}/${database}, password sealed).`)
  return 0
}

export async function runOpsCli(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  const info = loadInstallEnv()
  try {
    switch (cmd) {
      case 'version': return await cmdVersion()
      case 'verify-release': return await cmdVerify(rest)
      case 'update': return await cmdUpdate(rest, info)
      case 'diagnostics': return await cmdDiagnostics(rest)
      case 'health': return await cmdHealth(info)
      case 'seed-config': return await cmdSeedConfig(rest)
      case 'db-check': {
        const r = await withDb(async (db) => { await db.query('SELECT 1'); return true }).catch((e) => { err(`The database login does not work: ${e instanceof Error ? e.message : String(e)}`); return false })
        if (r === null) err('No database login is saved.')
        return r ? 0 : 1
      }
      default: err(`Unknown command ${cmd}`); return 64
    }
  } catch (e) {
    err(`ERROR: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}
