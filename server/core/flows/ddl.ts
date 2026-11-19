/**
 * Tables of the flow runtime (P1 package A, schema version 8; docs/dev/flows.md "Tables", docs/dev/schema.md).
 * CREATE ... IF NOT EXISTS: idempotent, run on every start (environmentDdl in meta-store.ts).
 *
 *   ab_flows             definitions (current version), enabled, owner, run-as, solution; the designer's draft (package B)
 *   ab_flow_versions     every saved version (restore, ALM compares the current one)
 *   ab_flow_runs         one row per run (state machine, trigger payload, run-as, correlation, variables, response)
 *   ab_flow_steps        one row per step execution (state, input, output, error, attempt, timings, container state)
 *   ab_flow_waits        suspended steps: delay until, approval id, child run, callback token, timeout
 *   ab_flow_connections  connection references a flow may use, and who granted them
 *   ab_flow_run_grants   roles that may run a flow (flow_id '*' = every flow of the environment)
 *   ab_flow_settings     environment settings of flows (kill switch, limits)
 *   ab_flow_alerts       failure notifications per flow (first failure at once, then a daily digest)
 */
import type { SqlDb } from '../contracts.ts'

export const FLOW_TABLES = [
  'ab_flows', 'ab_flow_versions', 'ab_flow_runs', 'ab_flow_steps', 'ab_flow_waits', 'ab_flow_connections', 'ab_flow_run_grants',
  'ab_flow_settings', 'ab_flow_alerts',
]

export function flowsEnvironmentDdl(schema: string): string[] {
  const E = (t: string): string => `"${schema}"."${t}"`
  return [
    `CREATE TABLE IF NOT EXISTS ${E('ab_flows')} (
      id text PRIMARY KEY,
      name text NOT NULL,
      description text NULL,
      definition jsonb NOT NULL,
      enabled boolean NOT NULL DEFAULT false,
      version integer NOT NULL DEFAULT 1,
      owner_id text NOT NULL,
      run_as jsonb NOT NULL,
      solution_id text NULL,
      suspended text NULL,
      created_by text NULL,
      created_on timestamptz NOT NULL,
      modified_by text NULL,
      modified_on timestamptz NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_flows_name ON ${E('ab_flows')} (lower(name))`,
    // P1 package B (designer): the unpublished draft of a flow (definition and connection references), one per flow;
    // "Publish" saves it as a new version and clears it. Additive and idempotent (no schema version step needed).
    `ALTER TABLE ${E('ab_flows')} ADD COLUMN IF NOT EXISTS draft jsonb NULL`,
    `ALTER TABLE ${E('ab_flows')} ADD COLUMN IF NOT EXISTS draft_by text NULL`,
    `ALTER TABLE ${E('ab_flows')} ADD COLUMN IF NOT EXISTS draft_on timestamptz NULL`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_flow_versions')} (
      flow_id text NOT NULL,
      version integer NOT NULL,
      doc jsonb NOT NULL,
      saved_by text NULL,
      saved_on timestamptz NOT NULL,
      note text NULL,
      PRIMARY KEY (flow_id, version)
    )`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_flow_runs')} (
      id text PRIMARY KEY,
      flow_id text NOT NULL,
      flow_name text NOT NULL,
      flow_version integer NOT NULL,
      owner_id text NULL,
      state text NOT NULL,
      mode text NOT NULL DEFAULT 'normal',
      dry_run boolean NOT NULL DEFAULT false,
      trigger_kind text NOT NULL,
      trigger_key text NULL,
      trigger_summary text NULL,
      trigger jsonb NULL,
      run_as text NULL,
      run_as_kind text NOT NULL,
      triggered_by text NULL,
      correlation_id text NOT NULL,
      chain jsonb NULL,
      depth integer NOT NULL DEFAULT 0,
      call_depth integer NOT NULL DEFAULT 0,
      parent_run_id text NULL,
      parent_wait_id text NULL,
      resubmitted_from text NULL,
      concurrency_key text NULL,
      seq bigint NOT NULL DEFAULT 0,
      variables jsonb NULL,
      response jsonb NULL,
      responded boolean NOT NULL DEFAULT false,
      error jsonb NULL,
      step_count integer NOT NULL DEFAULT 0,
      regarding_table text NULL,
      regarding_id text NULL,
      deadline_at timestamptz NULL,
      doc jsonb NULL,
      options jsonb NULL,
      created_on timestamptz NOT NULL,
      started_on timestamptz NULL,
      finished_on timestamptz NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_flow_runs_trigger ON ${E('ab_flow_runs')} (trigger_key) WHERE trigger_key IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ab_ix_flow_runs_flow ON ${E('ab_flow_runs')} (flow_id, created_on DESC)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_flow_runs_active ON ${E('ab_flow_runs')} (state) WHERE state IN ('queued', 'running', 'waiting')`,
    `CREATE INDEX IF NOT EXISTS ab_ix_flow_runs_key ON ${E('ab_flow_runs')} (concurrency_key, seq) WHERE concurrency_key IS NOT NULL AND state IN ('queued', 'running', 'waiting')`,
    `CREATE INDEX IF NOT EXISTS ab_ix_flow_runs_deadline ON ${E('ab_flow_runs')} (deadline_at) WHERE state IN ('queued', 'running', 'waiting')`,
    `CREATE INDEX IF NOT EXISTS ab_ix_flow_runs_finished ON ${E('ab_flow_runs')} (flow_id, finished_on) WHERE finished_on IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ab_ix_flow_runs_parent ON ${E('ab_flow_runs')} (parent_run_id) WHERE parent_run_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ab_ix_flow_runs_regarding ON ${E('ab_flow_runs')} (regarding_id) WHERE regarding_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_flow_steps')} (
      run_id text NOT NULL,
      step_key text NOT NULL,
      step_id text NOT NULL,
      scope text NOT NULL,
      name text NOT NULL,
      kind text NOT NULL,
      state text NOT NULL,
      attempt integer NOT NULL DEFAULT 1,
      input jsonb NULL,
      output jsonb NULL,
      error jsonb NULL,
      data jsonb NULL,
      job_id text NULL,
      simulated boolean NOT NULL DEFAULT false,
      truncated boolean NOT NULL DEFAULT false,
      started_on timestamptz NOT NULL,
      finished_on timestamptz NULL,
      ord bigint GENERATED ALWAYS AS IDENTITY,
      PRIMARY KEY (run_id, step_key)
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_flow_steps_scope ON ${E('ab_flow_steps')} (run_id, scope)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_flow_waits')} (
      id text PRIMARY KEY,
      run_id text NOT NULL,
      step_key text NOT NULL,
      kind text NOT NULL,
      state text NOT NULL,
      wake_at timestamptz NULL,
      timeout_at timestamptz NULL,
      approval_id text NULL,
      child_run_id text NULL,
      token_hash text NULL,
      outcome jsonb NULL,
      created_on timestamptz NOT NULL,
      resolved_on timestamptz NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_flow_waits_step ON ${E('ab_flow_waits')} (run_id, step_key)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_flow_waits_wake ON ${E('ab_flow_waits')} (wake_at) WHERE state = 'waiting' AND wake_at IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ab_ix_flow_waits_timeout ON ${E('ab_flow_waits')} (timeout_at) WHERE state = 'waiting' AND timeout_at IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ab_ix_flow_waits_token ON ${E('ab_flow_waits')} (token_hash) WHERE token_hash IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ab_ix_flow_waits_approval ON ${E('ab_flow_waits')} (approval_id) WHERE approval_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_flow_connections')} (
      flow_id text NOT NULL,
      ref text NOT NULL,
      connection_id text NOT NULL,
      granted_by text NULL,
      granted_on timestamptz NOT NULL,
      PRIMARY KEY (flow_id, ref)
    )`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_flow_run_grants')} (
      flow_id text NOT NULL,
      role_id text NOT NULL,
      granted_by text NULL,
      granted_on timestamptz NOT NULL,
      PRIMARY KEY (flow_id, role_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_flow_settings')} (
      k text PRIMARY KEY,
      v jsonb NOT NULL,
      modified_by text NULL,
      modified_on timestamptz NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_flow_alerts')} (
      flow_id text PRIMARY KEY,
      last_notified_on timestamptz NULL,
      pending integer NOT NULL DEFAULT 0,
      last_error text NULL,
      last_failure_on timestamptz NULL
    )`,
  ]
}

/**
 * Version 8 step of package A (independent of the other version 8 steps): the tables come from environmentDdl; the
 * placeholder table sys_flow_runs of the core data model (P0-N) makes way for the view over ab_flow_runs that
 * provisionSystemTables creates right after the steps. A placeholder that holds rows (it never should) is kept under
 * another name.
 */
export async function upgradeEnvironmentTo8Flows(db: SqlDb, schema: string): Promise<void> {
  for (const t of FLOW_TABLES) {
    const r = await db.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [`"${schema}"."${t}"`])
    if (!r[0]?.ok) throw new Error(`table ${schema}.${t} is missing after the schema update`)
  }
  const k = await db.query<{ k: string }>(
    `SELECT c.relkind::text AS k FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'sys_flow_runs'`, [schema],
  )
  if (k[0]?.k === 'r') {
    const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${schema}"."sys_flow_runs"`)
    if (Number(n[0]?.n) > 0) await db.exec(`ALTER TABLE "${schema}"."sys_flow_runs" RENAME TO "sys_flow_runs_placeholder_v7"`)
    else await db.exec(`DROP TABLE "${schema}"."sys_flow_runs"`)
  }
}
