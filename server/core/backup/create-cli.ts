/**
 * `appbuilder backup create --out <file>`: one verified install archive made from the command line by the product's
 * backup engine (engine.ts createArchive, then openArchive + verifyArchive), for the fleet tool and for operators who
 * keep their own copies (docs/admin/hosting.md, docs/admin/fleet-operations.md).
 *
 *   --out <file>             where the archive goes (refused when the file exists)
 *   --include-key            put the install's secret key in the archive (only with a passphrase)
 *   --passphrase-file <f>    encrypt with the first line of this file
 *   --passphrase-stdin       encrypt with the first line of standard input (an empty line: not encrypted)
 *   --trigger manual|pre-upgrade   recorded in the archive's manifest (default manual)
 *   --note <text>            recorded in the manifest (300 characters)
 *   --json                   one JSON document on stdout ({ ok, file, bytes, sha256, manifestSha256, rows, ... })
 *
 * It does NOT start the server's services and does not add a row to the install's backup list (ab.backups):
 * starting the services in a second process while the server runs marks the server's own running backups as
 * interrupted (backup/service.ts onDatabaseReady), and the archive lives outside the install's backup folder, so the
 * install's retention and folder scan must not manage it. The install audit records `install.cli_backup`.
 * Exit 0 written and verified; 1 failed (no file is left); 2 no database login; 64 usage.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPgDb } from '../../connectors/postgres/db.ts'
import { serverVersion } from '../auth.ts'
import { loadConfig } from '../config.ts'
import { environmentDirs } from '../environments.ts'
import { SCHEMA_VERSION } from '../meta-store.ts'
import { databaseLogin } from '../update/cli.ts'
import type { CliIo } from '../hosting/cli.ts'
import { createArchive, openArchive, verifyArchive, type BackupTrigger } from './engine.ts'

const stdio: CliIo = { out: (l) => process.stdout.write(l + '\n'), err: (l) => process.stderr.write(l + '\n') }
const USAGE = 'Usage: appbuilder backup create --out <file> [--include-key] [--passphrase-file <f> | --passphrase-stdin] [--trigger manual|pre-upgrade] [--note <text>] [--json]'

function flags(argv: string[], bool: string[]): { args: string[]; o: Record<string, string | true> } {
  const o: Record<string, string | true> = {}
  const args: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) { const k = a.slice(2); if (bool.includes(k)) o[k] = true; else o[k] = argv[++i] ?? '' } else args.push(a)
  }
  return { args, o }
}

async function readStdinLine(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? ''
}

const osUser = (): string => { try { return os.userInfo().username } catch { return process.env.USER || 'unknown' } }

export interface BackupCreateResult { ok: true; file: string; bytes: number; sha256: string; manifestSha256: string; rows: number | null; schemaVersion: number; environments: number; encrypted: boolean; includesKey: boolean }

export async function runBackupCreateCli(argv: string[], o: { env?: NodeJS.ProcessEnv; io?: CliIo; stdin?: () => Promise<string> } = {}): Promise<number> {
  const env = o.env ?? process.env
  const io = o.io ?? stdio
  const { args, o: f } = flags(argv, ['include-key', 'passphrase-stdin', 'json'])
  const json = f.json === true
  const fail = (code: number, error: string): number => {
    if (json) io.out(JSON.stringify({ ok: false, error }))
    else io.err(`${code === 64 ? '' : 'ERROR: '}${error}`)
    return code
  }
  const out = typeof f.out === 'string' && f.out.trim() ? path.resolve(f.out.trim()) : ''
  const trigger = (typeof f.trigger === 'string' ? f.trigger : 'manual') as BackupTrigger
  if (args.length || !out || !['manual', 'pre-upgrade'].includes(trigger) || (typeof f['passphrase-file'] === 'string' && f['passphrase-stdin'])) return fail(64, USAGE)
  if (fs.existsSync(out)) return fail(1, `${out} exists already: choose another file name.`)
  let pass = ''
  try {
    if (typeof f['passphrase-file'] === 'string') pass = (fs.readFileSync(f['passphrase-file'], 'utf8').split(/\r?\n/)[0] ?? '')
    else if (f['passphrase-stdin']) pass = await (o.stdin ?? readStdinLine)()
  } catch (e) {
    return fail(1, `cannot read the passphrase: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (pass && pass.length < 10) return fail(64, 'The passphrase must be at least 10 characters.')
  if (f['include-key'] && !pass) return fail(64, '--include-key needs a passphrase (an archive with the key must be encrypted).')
  let login: ReturnType<typeof databaseLogin>
  try {
    login = databaseLogin(env)
  } catch (e) {
    return fail(2, `the saved database login cannot be read: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!login) return fail(2, 'no database login is saved (APPBUILDER_DB_* or server.json)')
  const ws = loadConfig(env).workspaceDir
  let key: string | null = null
  if (f['include-key']) {
    try {
      key = (env.APPBUILDER_SECRET_KEY || fs.readFileSync(path.join(ws, '.secret-key'), 'utf8')).trim()
    } catch (e) {
      return fail(1, `cannot read the install key: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!/^[0-9a-f]{64}$/i.test(key)) return fail(1, 'the install key is not 64 hex characters')
  }
  const db = createPgDb(login.settings, login.password, { max: 1, onError: () => {} })
  try {
    const sources = await db.query<{ id: string; name: string; type: string; schema_name: string; schema_version: number | null; locked: boolean | null; description: string | null }>(
      `SELECT id, name, type, schema_name, schema_version, locked, description FROM "ab"."environments" WHERE state = 'ready' ORDER BY id`)
    const id = `cli${Date.now().toString(36)}`
    fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 })
    const note = typeof f.note === 'string' ? f.note.slice(0, 300) : 'appbuilder backup create'
    const res = await createArchive({ settings: login.settings, password: login.password }, {
      id, kind: 'install', file: out, method: 'auto', pgBin: env.APPBUILDER_PG_BIN || null, passphrase: pass || null, secretKey: key,
      environments: sources.map((e) => ({ id: e.id, name: e.name, type: e.type, schema: e.schema_name, schemaVersion: Number(e.schema_version) || SCHEMA_VERSION, locked: !!e.locked, ...(e.description ? { description: e.description } : {}) })),
      trigger, note, createdBy: null, appVersion: serverVersion(), schemaVersion: SCHEMA_VERSION,
      dirs: (eid) => environmentDirs(ws, eid),
    })
    const a = await openArchive(out, pass || null)
    let v
    try {
      v = await verifyArchive(a, { expectedManifestSha256: res.manifestSha256 })
    } finally {
      await a.close()
    }
    if (!v.ok) {
      fs.rmSync(out, { force: true })
      return fail(1, `verification failed (the archive was removed): ${v.errors.slice(0, 3).join(' ')}`)
    }
    const details = { file: out, bytes: res.bytes, sha256: res.sha256, trigger, encrypted: !!pass, includesKey: !!key, rows: v.rows, source: 'cli', osUser: osUser(), host: os.hostname() }
    await db.exec(`INSERT INTO "ab"."audit" (at, user_id, action, environment_id, details) VALUES ($1, NULL, 'install.cli_backup', NULL, $2::jsonb)`, [new Date(), JSON.stringify(details)])
      .catch((e) => io.err(`WARNING: the install audit entry could not be written: ${e instanceof Error ? e.message : String(e)}`))
    const r: BackupCreateResult = { ok: true, file: out, bytes: res.bytes, sha256: res.sha256, manifestSha256: res.manifestSha256, rows: v.rows ?? null, schemaVersion: SCHEMA_VERSION, environments: sources.length, encrypted: !!pass, includesKey: !!key }
    if (json) io.out(JSON.stringify(r))
    else io.out(`Backup ${out}: ${res.bytes} bytes, sha256 ${res.sha256}, ${sources.length} environment(s), ${v.rows ?? '?'} rows, verified${pass ? ', encrypted' : ''}${key ? ', with the install key' : ''}.`)
    return 0
  } catch (e) {
    fs.rmSync(out, { force: true })
    return fail(1, `the backup failed (no file was left): ${String(e instanceof Error ? e.message : e).replace(login.password || '\u0000', '***')}`)
  } finally {
    await db.close().catch(() => {})
  }
}
