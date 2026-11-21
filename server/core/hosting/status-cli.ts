/**
 * `appbuilder status [--json]`: the install's state for an operator or the fleet tool (docs/admin/hosting.md). Reads
 * the database directly with the install's own login (server.json or APPBUILDER_DB_*): it never starts the server's
 * services, so it is safe to run while the server runs, and it changes nothing.
 *
 *   schema version, users (active / total), seat passes, read-only state (environment or stored), licence (configured,
 *   last check), database size, the newest good install backup, this release's version
 *
 * Exit 0 with the state; 2 when there is no database login or the database cannot be reached.
 * `--json` prints ONE JSON document ({ ok, ... }) and nothing else on stdout.
 */
import { createPgDb } from '../../connectors/postgres/db.ts'
import { serverVersion } from '../auth.ts'
import { seatCounts } from '../licence/seats.ts'
import { databaseLogin } from '../update/cli.ts'
import { storedReadOnly } from './read-only.ts'
import { hostingSettings } from './settings.ts'
import type { CliIo } from './cli.ts'

const stdio: CliIo = { out: (l) => process.stdout.write(l + '\n'), err: (l) => process.stderr.write(l + '\n') }

export interface InstallStatus {
  ok: true
  version: string
  schemaVersion: number | null
  users: { active: number; total: number } | null
  seats: { full: number; operator: number; external: number } | null
  readOnly: { reason: string; since: string | null; source: 'env' | 'cli' | 'licence' } | null
  licence: { configured: boolean; lastCheck: { at: string; ok: boolean; error: string | null } | null }
  dbBytes: number | null
  lastInstallBackup: string | null
}

/** one value, or null when its table or row is not there (an install that was never migrated) */
const opt = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null)

export async function installStatus(env: NodeJS.ProcessEnv): Promise<InstallStatus | { ok: false; error: string }> {
  let login: ReturnType<typeof databaseLogin>
  try {
    login = databaseLogin(env)
  } catch (e) {
    return { ok: false, error: `the saved database login cannot be read: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!login) return { ok: false, error: 'no database login is saved (APPBUILDER_DB_* or server.json)' }
  const db = createPgDb(login.settings, login.password, { max: 1, onError: () => {} })
  try {
    try {
      await db.query('SELECT 1')
    } catch (e) {
      return { ok: false, error: `the database cannot be reached: ${String((e as Error).message ?? e).replace(login.password || '\u0000', '***').slice(0, 300)}` }
    }
    const fromEnv = hostingSettings(env).readOnly
    const schema = await opt(db.query<{ v: string }>(`SELECT v FROM "ab"."settings" WHERE k = 'schemaVersion'`))
    const users = await opt(db.query<{ a: string; t: string }>(`SELECT count(*) FILTER (WHERE status <> 'disabled' AND kind <> 'service') AS a, count(*) AS t FROM "ab"."users"`))
    const stored = await opt(storedReadOnly(db))
    const lic = await opt(db.query<{ document: { lastCheck?: { at: number; ok: boolean; error: string | null } | null } }>(`SELECT document FROM "ab"."licence" WHERE id = 1`))
    const size = await opt(db.query<{ n: string }>(`SELECT pg_catalog.pg_database_size(pg_catalog.current_database()) AS n`))
    const last = await opt(db.query<{ at: Date | null }>(`SELECT max(created_on) AS at FROM "ab"."backups" WHERE state = 'ok' AND kind = 'install'`))
    const seats = await opt(seatCounts(db))
    const lc = lic?.[0]?.document?.lastCheck ?? null
    return {
      ok: true,
      version: serverVersion(),
      schemaVersion: schema?.[0] ? Number(schema[0].v) : null,
      users: users?.[0] ? { active: Number(users[0].a), total: Number(users[0].t) } : null,
      seats: seats ? { full: seats.full, operator: seats.operator, external: seats.external } : null,
      readOnly: fromEnv ? { reason: fromEnv.reason, since: null, source: 'env' } : stored ? { reason: stored.reason, since: stored.since ?? null, source: stored.source } : null,
      licence: { configured: !!(env.APPBUILDER_LICENCE_URL && env.APPBUILDER_LICENCE_ID), lastCheck: lc ? { at: new Date(lc.at).toISOString(), ok: !!lc.ok, error: lc.error ?? null } : null },
      dbBytes: size?.[0] ? Number(size[0].n) : null,
      lastInstallBackup: last?.[0]?.at ? new Date(last[0].at).toISOString() : null,
    }
  } finally {
    await db.close().catch(() => {})
  }
}

export async function runStatusCli(argv: string[], o: { env?: NodeJS.ProcessEnv; io?: CliIo } = {}): Promise<number> {
  const env = o.env ?? process.env
  const io = o.io ?? stdio
  const json = argv.includes('--json')
  const unknown = argv.filter((a) => a !== '--json')
  if (unknown.length) {
    io.err('Usage: appbuilder status [--json]')
    return 64
  }
  const s = await installStatus(env)
  if (json) {
    io.out(JSON.stringify(s))
    return s.ok ? 0 : 2
  }
  if (!s.ok) {
    io.err(`ERROR: ${s.error}`)
    return 2
  }
  io.out(`Appbuilder ${s.version}, schema ${s.schemaVersion ?? 'not created (run appbuilder migrate)'}`)
  io.out(`Users: ${s.users ? `${s.users.active} active of ${s.users.total}` : '-'}; seats: ${s.seats ? `${s.seats.full} full, ${s.seats.operator} operator, ${s.seats.external} external` : '-'}`)
  io.out(`Read-only: ${s.readOnly ? `${s.readOnly.reason} (${s.readOnly.source}${s.readOnly.since ? `, since ${s.readOnly.since}` : ''})` : 'no'}`)
  io.out(`Licence: ${s.licence.configured ? (s.licence.lastCheck ? `last check ${s.licence.lastCheck.at} ${s.licence.lastCheck.ok ? 'ok' : `FAILED: ${s.licence.lastCheck.error ?? ''}`}` : 'configured, not checked yet') : 'not configured'}`)
  io.out(`Database: ${s.dbBytes === null ? '-' : `${Math.round(s.dbBytes / 1048576)} MB`}; last install backup: ${s.lastInstallBackup ?? 'never'}`)
  return 0
}
