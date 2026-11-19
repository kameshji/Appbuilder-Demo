/**
 * Tables of the recycle bin (schema version 10; docs/dev/recycle-bin.md, docs/dev/schema.md). Per environment schema,
 * CREATE ... IF NOT EXISTS: idempotent, run on every start (environmentDdl in meta-store.ts).
 *
 *   ab_delete_batches  one row per delete operation that kept rows (who, when, what, source, state, expiry)
 *   ab_delete_effects  what that operation did, enough to undo exactly that operation: rows soft-deleted (own and
 *                      cascaded), lookup values cleared by set blank (old value), collaboration rows removed with their
 *                      record (full row), regarding links detached (old link), shares (full row), rows of tables
 *                      without a recycle bin that the cascade deleted for good ('final': they cannot come back)
 *
 * The deleted rows themselves stay in their tables ("deletedOn", "deletedBy", "deleteBatch"); the batch is the undo log.
 */
import type { SqlDb } from './contracts.ts'

export const RECYCLE_TABLES = ['ab_delete_batches', 'ab_delete_effects']

export function recycleEnvironmentDdl(schema: string): string[] {
  const q = (id: string): string => `"${id}"`
  const E = (t: string): string => `${q(schema)}.${q(t)}`
  return [
    `CREATE TABLE IF NOT EXISTS ${E('ab_delete_batches')} (
      id text PRIMARY KEY,
      table_id text NOT NULL,
      root_ids jsonb NOT NULL,
      row_count integer NOT NULL DEFAULT 0,
      deleted_by text NULL,
      deleted_on timestamptz NOT NULL,
      expires_on timestamptz NOT NULL,
      source text NOT NULL,
      state text NOT NULL,
      restored_by text NULL,
      restored_on timestamptz NULL,
      purged_on timestamptz NULL,
      details jsonb NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_delete_batches_table ON ${E('ab_delete_batches')} (table_id, deleted_on DESC)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_delete_batches_expiry ON ${E('ab_delete_batches')} (expires_on) WHERE state IN ('deleted', 'partial')`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_delete_effects')} (
      batch_id text NOT NULL,
      seq integer NOT NULL,
      kind text NOT NULL,
      table_id text NOT NULL,
      row_id text NULL,
      column_name text NULL,
      old_value jsonb NULL,
      PRIMARY KEY (batch_id, seq)
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_delete_effects_row ON ${E('ab_delete_effects')} (table_id, row_id) WHERE kind = 'row'`,
  ]
}

/** Version 10 step: the tables come from environmentDdl (run just before); the step checks they exist. Existing tables keep final deletes. */
export async function upgradeEnvironmentTo10Recycle(db: SqlDb, schema: string): Promise<void> {
  for (const t of RECYCLE_TABLES) {
    const r = await db.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [`"${schema}"."${t}"`])
    if (!r[0]?.ok) throw new Error(`table ${schema}.${t} is missing after the schema update`)
  }
}
