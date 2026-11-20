/**
 * Tables of dashboards (P2-C, schema version 11, independent step; docs/dev/dashboards.md). Per environment schema,
 * CREATE ... IF NOT EXISTS: idempotent, run on every start (environmentDdl in meta-store.ts).
 *
 *   ab_dashboards          one row per dashboard: definition (tiles, filters, range) as JSON, owner, viewer roles
 *   ab_dashboard_settings  environment defaults of dashboards: locale, currency, time zone, fiscal year start, week start, shifts
 */
import type { SqlDb } from '../contracts.ts'

export const DASHBOARD_TABLES = ['ab_dashboards', 'ab_dashboard_settings']

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
  ]
}

/** Version 11 step of package C: the tables come from environmentDdl (run just before); the step checks they exist. */
export async function upgradeEnvironmentTo11Dashboards(db: SqlDb, schema: string): Promise<void> {
  for (const t of DASHBOARD_TABLES) {
    const r = await db.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [`"${schema}"."${t}"`])
    if (!r[0]?.ok) throw new Error(`table ${schema}.${t} is missing after the schema update`)
  }
}
