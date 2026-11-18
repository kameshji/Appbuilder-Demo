/**
 * Schema version 7 (package J, shared number with the other wave 4 packages): the backup catalogue in schema ab.
 *
 *   ab.backups      one row per archive in the backup folder (made here, found in the folder, or uploaded)
 *   ab.backup_ops   restores, table restores and restore tests, with their progress and outcome
 *
 * The archives themselves are the source of truth: their rows are never part of a backup (AB_NO_DATA in engine.ts) and
 * the service rebuilds missing rows from the manifests it finds in the folder (after an install restore, for example).
 */
import type { SqlDb } from '../contracts.ts'

const A = (t: string): string => `"ab"."${t}"`

export const BACKUP_TABLES = ['backups', 'backup_ops']

export const BACKUP_INSTALL_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS ${A('backups')} (
    id text PRIMARY KEY,
    file_name text NOT NULL,
    kind text NOT NULL,
    environment_id text NULL,
    environment_name text NULL,
    trigger text NOT NULL,
    state text NOT NULL,
    method text NULL,
    encrypted boolean NOT NULL DEFAULT false,
    includes_key boolean NOT NULL DEFAULT false,
    size_bytes bigint NULL,
    sha256 text NULL,
    manifest_sha256 text NULL,
    created_on timestamptz NOT NULL,
    finished_on timestamptz NULL,
    created_by text NULL,
    app_version text NULL,
    schema_version integer NULL,
    summary jsonb NULL,
    error text NULL,
    verified_on timestamptz NULL,
    verify_error text NULL,
    restore_tested_on timestamptz NULL,
    restore_test_error text NULL,
    offsite jsonb NULL,
    pinned boolean NOT NULL DEFAULT false,
    note text NULL,
    job_id text NULL,
    progress jsonb NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_backups_file ON ${A('backups')} (file_name)`,
  `CREATE INDEX IF NOT EXISTS ab_ix_backups_created ON ${A('backups')} (created_on)`,
  `CREATE INDEX IF NOT EXISTS ab_ix_backups_scope ON ${A('backups')} (kind, environment_id, created_on)`,
  `CREATE TABLE IF NOT EXISTS ${A('backup_ops')} (
    id text PRIMARY KEY,
    kind text NOT NULL,
    backup_id text NULL,
    mode text NULL,
    source_environment text NULL,
    target_environment text NULL,
    state text NOT NULL,
    phase text NULL,
    progress jsonb NULL,
    started_on timestamptz NOT NULL,
    finished_on timestamptz NULL,
    created_by text NULL,
    error text NULL,
    result jsonb NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ab_ix_backup_ops_started ON ${A('backup_ops')} (started_on)`,
]

/** the version 7 step of package J (tables come from BACKUP_INSTALL_DDL, run just before): checks they exist */
export async function upgradeInstallTo7Backup(tx: SqlDb): Promise<string> {
  for (const t of BACKUP_TABLES) {
    const r = await tx.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [`"ab"."${t}"`])
    if (!r[0]?.ok) throw new Error(`table ab.${t} is missing after the schema update`)
  }
  return 'version 7 (backups): backup catalogue (ab.backups, ab.backup_ops)'
}
