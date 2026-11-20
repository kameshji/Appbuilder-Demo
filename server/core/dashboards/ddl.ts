/**
 * Tables of dashboards (P2-C; docs/dev/dashboards.md). Per environment schema, CREATE ... IF NOT EXISTS: idempotent, run on
 * every start (environmentDdl in meta-store.ts).
 *
 * Schema version 11 (independent step):
 *   ab_dashboards          one row per dashboard: definition (tiles, filters, range) as JSON, owner, viewer roles
 *   ab_dashboard_settings  environment defaults of dashboards: locale, currency, time zone, fiscal year start, week start, shifts
 *
 * Schema version 12 (independent step, P2-C second wave):
 *   ab_dashboard_tokens         TV / kiosk view tokens: one dashboard, a "view as" identity, SHA-256 of the token only
 *   ab_dashboard_snapshots      scheduled email snapshots of a dashboard (schedule, recipients, range, filters)
 *   ab_dashboard_snapshot_runs  the run log of snapshots (per recipient: sent, skipped and why)
 */
import type { SqlDb } from '../contracts.ts'

export const DASHBOARD_TABLES = ['ab_dashboards', 'ab_dashboard_settings']
export const DASHBOARD_TABLES_12 = ['ab_dashboard_tokens', 'ab_dashboard_snapshots', 'ab_dashboard_snapshot_runs']

export function dashboardsEnvironmentDdl(schema: string): string[] {
  const q = (id: string): string => `"${id}"`
  const E = (t: string): string => `${q(schema)}.${q(t)}`
  return [
    `CREATE TABLE IF NOT EXISTS ${E('ab_dashboards')} (
      id text PRIMARY KEY,
      name text NOT NULL,
      owner_id text NOT NULL,
      roles jsonb NOT NULL DEFAULT '[]'::jsonb,
      def jsonb NOT NULL,
      created_on timestamptz NOT NULL,
      modified_on timestamptz NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_dashboard_settings')} (
      k text PRIMARY KEY,
      v jsonb NOT NULL
    )`,
    // version 12: view tokens (never copied with an environment, never in a solution)
    `CREATE TABLE IF NOT EXISTS ${E('ab_dashboard_tokens')} (
      id text PRIMARY KEY,
      dashboard_id text NOT NULL,
      label text NOT NULL,
      prefix text NOT NULL,
      secret_hash text NOT NULL,
      view_as text NOT NULL,
      view_as_kind text NOT NULL,
      created_by text NOT NULL,
      created_on timestamptz NOT NULL,
      expires_on timestamptz NULL,
      last_used_on timestamptz NULL,
      revoked_on timestamptz NULL,
      revoked_by text NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_dashboard_tokens_prefix ON ${E('ab_dashboard_tokens')} (prefix)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_dashboard_tokens_dashboard ON ${E('ab_dashboard_tokens')} (dashboard_id)`,
    // version 12: scheduled email snapshots and their run log
    `CREATE TABLE IF NOT EXISTS ${E('ab_dashboard_snapshots')} (
      id text PRIMARY KEY,
      dashboard_id text NOT NULL,
      name text NOT NULL,
      owner_id text NOT NULL,
      def jsonb NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      schedule_id text NULL,
      created_on timestamptz NOT NULL,
      modified_on timestamptz NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_dashboard_snapshots_dashboard ON ${E('ab_dashboard_snapshots')} (dashboard_id)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_dashboard_snapshot_runs')} (
      id text PRIMARY KEY,
      snapshot_id text NOT NULL,
      started_on timestamptz NOT NULL,
      finished_on timestamptz NULL,
      status text NOT NULL,
      trigger text NOT NULL,
      job_id text NULL,
      recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
      message text NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_dashboard_snapshot_runs_snapshot ON ${E('ab_dashboard_snapshot_runs')} (snapshot_id, started_on DESC)`,
  ]
}

async function checkTables(db: SqlDb, schema: string, tables: string[]): Promise<void> {
  for (const t of tables) {
    const r = await db.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [`"${schema}"."${t}"`])
    if (!r[0]?.ok) throw new Error(`table ${schema}.${t} is missing after the schema update`)
  }
}

/** Version 11 step of package C: the tables come from environmentDdl (run just before); the step checks they exist. */
export async function upgradeEnvironmentTo11Dashboards(db: SqlDb, schema: string): Promise<void> {
  await checkTables(db, schema, DASHBOARD_TABLES)
}

/**
 * Version 12 step (independent): view tokens and scheduled snapshots. The tables come from environmentDdl; the step checks
 * they exist so a server of version 11 refuses this schema (downgrade guard). Nothing existing changes.
 */
export async function upgradeEnvironmentTo12Dashboards(db: SqlDb, schema: string): Promise<void> {
  await checkTables(db, schema, DASHBOARD_TABLES_12)
}
