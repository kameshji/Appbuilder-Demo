/**
 * The ONE answer to "which PostgreSQL client tools does the fleet use" (psql, pg_dumpall; the installs get the same
 * folder as APPBUILDER_PG_BIN for pg_dump). Order:
 *
 *   1. --pg-bin <dir> on the command line (the fleet installer passes the folder it installed or found);
 *   2. config.pgBin in the registry (/etc/appbuilder/fleet.json: recorded by `abfleet init`), when psql is there;
 *   3. detected: `pg_config --bindir`, else the highest /usr/lib/postgresql/<major>/bin that has psql.
 *
 * Nothing else in the fleet tool names a PostgreSQL version or folder.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const hasPsql = (dir: string) => { try { return fs.statSync(path.join(dir, 'psql')).isFile() } catch { return false } }

/** the newest PostgreSQL client folder on this Linux machine, '' when there is none */
export function detectPgBin(o: { root?: string; pgConfig?: () => string | null } = {}): string {
  const fromPgConfig = (o.pgConfig ?? (() => {
    try { return execFileSync('pg_config', ['--bindir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() } catch { return null }
  }))()
  if (fromPgConfig && hasPsql(fromPgConfig)) return fromPgConfig
  const base = path.join(o.root ?? '/', 'usr', 'lib', 'postgresql')
  let majors: string[] = []
  try { majors = fs.readdirSync(base).filter((d) => /^\d+(\.\d+)?$/.test(d)) } catch { /* no PostgreSQL from apt */ }
  majors.sort((a, b) => Number(b) - Number(a))
  for (const m of majors) { const d = path.join(base, m, 'bin'); if (hasPsql(d)) return d }
  return ''
}

/** the folder to use (see the order above); '' when nothing was found (init then refuses with a clear message) */
export function resolvePgBin(flag: string | undefined, configured: string | undefined, detect: () => string = detectPgBin): string {
  if (flag) return path.resolve(flag)
  if (configured && hasPsql(configured)) return configured
  return detect()
}
