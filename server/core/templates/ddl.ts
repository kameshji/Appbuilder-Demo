/**
 * Templates catalogue (P2 package D, docs/dev/templates.md): the installed-templates register of schema version 13
 * (independent step). Per environment schema, CREATE ... IF NOT EXISTS: idempotent, run on every start (environmentDdl in
 * meta-store.ts, which calls this file).
 *
 *   ab_template_installs   one row per use of a template in this environment: which template and version, Copy or
 *                          Linked, the bindings chosen, what the install created (apps, tables, roles, flows, events,
 *                          sample rows; for UI components and screens the app and screen it went into), what each
 *                          created component looked like when delivered (hashes, for "local changes" of a Linked
 *                          install), the solution of a Linked install, and the uninstall (who, when, what was kept).
 *
 * Rows are never deleted: an uninstall sets status 'uninstalled'. A Linked template is installed at most once per
 * environment (partial unique index). An environment copy WITH DATA copies the register (environment-ops.ts
 * COPY_DATA_META; a schema-only copy does not); it never travels in a solution.
 */
import type { SqlDb } from '../contracts.ts'

/** the tables this package adds to every environment schema (checked by the upgrade step) */
export const TEMPLATE_TABLES: string[] = ['ab_template_installs']

/** CREATE TABLE IF NOT EXISTS statements for an environment schema (schema-qualified, idempotent) */
export function templatesEnvironmentDdl(schema: string): string[] {
  const q = (id: string): string => `"${id}"`
  const E = (t: string): string => `${q(schema)}.${q(t)}`
  return [
    `CREATE TABLE IF NOT EXISTS ${E('ab_template_installs')} (
      id text PRIMARY KEY,
      template_id text NOT NULL,
      template_version text NOT NULL,
      digest text NOT NULL,
      kind text NOT NULL,
      mode text NOT NULL,
      name text NOT NULL,
      status text NOT NULL DEFAULT 'installed',
      bindings jsonb NOT NULL DEFAULT '{}'::jsonb,
      created jsonb NOT NULL DEFAULT '{}'::jsonb,
      delivered jsonb NOT NULL DEFAULT '{}'::jsonb,
      solution_id text NULL,
      installed_by text NULL,
      installed_on timestamptz NOT NULL,
      modified_on timestamptz NOT NULL,
      uninstalled_by text NULL,
      uninstalled_on timestamptz NULL,
      details jsonb NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_template_installs_template ON ${E('ab_template_installs')} (template_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_template_installs_linked ON ${E('ab_template_installs')} (template_id) WHERE mode = 'linked' AND status = 'installed'`,
    // schema version 14 (P3 package M1, solution templates): the register remembers the SAMPLE rows it added (table id ->
    // row ids; "Remove sample data" deletes exactly those), the reference rows it delivered (per row: table, id, the hash
    // of the values delivered, so an upgrade keeps rows the customer changed) and the installs it depends on
    ...TEMPLATE_COLUMNS_14.map(([c, type]) => `ALTER TABLE ${E('ab_template_installs')} ADD COLUMN IF NOT EXISTS ${q(c)} ${type}`),
  ]
}

/** the register columns of schema version 14 (checked by the step) */
export const TEMPLATE_COLUMNS_14: [string, string][] = [
  ['sample_rows', `jsonb NOT NULL DEFAULT '{}'::jsonb`],
  ['reference_rows', `jsonb NOT NULL DEFAULT '{}'::jsonb`],
  ['depends_on', `jsonb NOT NULL DEFAULT '[]'::jsonb`],
]

/**
 * Upgrade step to 13 (independent): the table comes from environmentDdl (run before the steps); the step checks it exists
 * so a server of version 12 refuses this schema (downgrade guard). Nothing existing changes.
 */
export async function upgradeEnvironmentTo13Templates(db: SqlDb, schema: string): Promise<void> {
  for (const t of TEMPLATE_TABLES) {
    const r = await db.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [`"${schema}"."${t}"`])
    if (!r[0]?.ok) throw new Error(`table ${schema}.${t} is missing after the schema update`)
  }
}

/**
 * Upgrade step to 14 (P3 package M1, solution templates; independent): the register columns come from environmentDdl
 * (ADD COLUMN IF NOT EXISTS, run before the steps; existing rows get the defaults: no sample rows recorded, no reference
 * rows, no dependencies). The step checks they exist, so a server of version 13 refuses this schema (downgrade guard).
 */
export async function upgradeEnvironmentTo14Templates(db: SqlDb, schema: string): Promise<void> {
  const have = await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'ab_template_installs'`, [schema])
  for (const [c] of TEMPLATE_COLUMNS_14) if (!have.some((r) => r.column_name === c)) throw new Error(`column ${schema}.ab_template_installs.${c} is missing after the schema update`)
}
