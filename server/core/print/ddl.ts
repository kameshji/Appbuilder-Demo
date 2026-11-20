/**
 * Tables of print templates (schema version 11, P2 package B; docs/dev/pdf.md, docs/dev/schema.md). Per environment
 * schema, CREATE ... IF NOT EXISTS: idempotent, run on every start (environmentDdl in meta-store.ts).
 *
 *   ab_print_templates          one row per template: the draft document, the published one, kind (pdf / docx), run-as
 *   ab_print_template_versions  every publish (history; restore = publish an old document again)
 *   ab_print_runs               the generation log: who, what, as whom, pages, size, time, warnings, errors
 *   ab_print_files              generated files (PDF, docx, zip) by token, kept 24 hours unless claimed by a record
 *   ab_print_settings           letterhead, number and date formats, limits of this environment
 */
import type { SqlDb } from '../contracts.ts'

export const PRINT_TABLES = ['ab_print_templates', 'ab_print_template_versions', 'ab_print_runs', 'ab_print_files', 'ab_print_settings']

export function printEnvironmentDdl(schema: string): string[] {
  const E = (t: string): string => `"${schema}"."${t}"`
  return [
    `CREATE TABLE IF NOT EXISTS ${E('ab_print_templates')} (
      id text PRIMARY KEY,
      name text NOT NULL,
      description text NULL,
      kind text NOT NULL DEFAULT 'pdf',
      table_name text NULL,
      doc jsonb NOT NULL,
      published jsonb NULL,
      version integer NOT NULL DEFAULT 0,
      run_as jsonb NOT NULL DEFAULT '"caller"'::jsonb,
      docx bytea NULL,
      docx_name text NULL,
      built_in text NULL,
      owner_id text NOT NULL,
      solution_id text NULL,
      created_by text NULL,
      created_on timestamptz NOT NULL,
      modified_by text NULL,
      modified_on timestamptz NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_print_templates_name ON ${E('ab_print_templates')} (lower(name))`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_print_template_versions')} (
      template_id text NOT NULL,
      version integer NOT NULL,
      doc jsonb NOT NULL,
      docx bytea NULL,
      saved_by text NULL,
      saved_on timestamptz NOT NULL,
      note text NULL,
      PRIMARY KEY (template_id, version)
    )`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_print_runs')} (
      id text PRIMARY KEY,
      template_id text NOT NULL,
      template_name text NOT NULL,
      version integer NOT NULL,
      kind text NOT NULL,
      status text NOT NULL,
      user_id text NULL,
      run_as text NOT NULL,
      record_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      pages integer NOT NULL DEFAULT 0,
      bytes integer NOT NULL DEFAULT 0,
      ms integer NOT NULL DEFAULT 0,
      warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
      error text NULL,
      progress jsonb NULL,
      file_token text NULL,
      source text NOT NULL,
      started_on timestamptz NOT NULL,
      finished_on timestamptz NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_print_runs_started ON ${E('ab_print_runs')} (started_on DESC)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_print_runs_template ON ${E('ab_print_runs')} (template_id, started_on DESC)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_print_files')} (
      token text PRIMARY KEY,
      storage_key text NULL,
      file_name text NOT NULL,
      mime text NOT NULL,
      size_bytes integer NOT NULL DEFAULT 0,
      sha256 text NULL,
      pages integer NULL,
      state text NOT NULL,
      error text NULL,
      run_id text NULL,
      created_by text NULL,
      created_on timestamptz NOT NULL,
      expires_on timestamptz NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_print_files_expiry ON ${E('ab_print_files')} (expires_on)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_print_settings')} (
      k text PRIMARY KEY,
      v jsonb NOT NULL,
      modified_by text NULL,
      modified_on timestamptz NOT NULL
    )`,
  ]
}

/** version 11 step: the tables come from environmentDdl; the step checks they exist */
export async function upgradeEnvironmentTo11Print(db: SqlDb, schema: string): Promise<void> {
  for (const t of PRINT_TABLES) {
    const r = await db.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [`"${schema}"."${t}"`])
    if (!r[0]?.ok) throw new Error(`table ${schema}.${t} is missing after the schema update`)
  }
}
