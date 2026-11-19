/**
 * Tables of approvals (P1 package C, schema version 9; docs/dev/approvals.md, docs/dev/schema.md). Per environment
 * schema, CREATE ... IF NOT EXISTS: idempotent, run on every start (environmentDdl in meta-store.ts). The core data model
 * shows them as read-only projections in the group "Approvals" (system-tables.ts views sys_approval_*).
 *
 *   ab_approval_policies     reusable definitions (travel in solutions)
 *   ab_approval_requests     one row per request: title, details, fields, regarding record, requester, flow link, status
 *   ab_approval_stages       the stages of a request (single/any/all/quorum: one stage)
 *   ab_approval_assignments  one row per person asked (source, status, answer, comment, reassigned from)
 *   ab_approval_history      every action (append-only)
 *   ab_approval_delegations  user A delegates to user B for a date range (optionally per policy)
 *   ab_approval_links        email answer links: single use, expiring, bound to one person and one assignment
 *   ab_approval_settings     environment settings (viewer roles, retention, link lifetime)
 */
import type { SqlDb } from '../contracts.ts'

export const APPROVAL_TABLES = [
  'ab_approval_policies', 'ab_approval_requests', 'ab_approval_stages', 'ab_approval_assignments', 'ab_approval_history',
  'ab_approval_delegations', 'ab_approval_links', 'ab_approval_settings',
]

export function approvalsEnvironmentDdl(schema: string): string[] {
  const E = (t: string): string => `"${schema}"."${t}"`
  return [
    `CREATE TABLE IF NOT EXISTS ${E('ab_approval_policies')} (
      id text PRIMARY KEY,
      name text NOT NULL,
      description text NULL,
      definition jsonb NOT NULL,
      solution_id text NULL,
      created_by text NULL,
      created_on timestamptz NOT NULL,
      modified_by text NULL,
      modified_on timestamptz NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_approval_policies_name ON ${E('ab_approval_policies')} (lower(name))`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_approval_requests')} (
      id text PRIMARY KEY,
      title text NOT NULL,
      details text NOT NULL DEFAULT '',
      fields jsonb NOT NULL DEFAULT '{}'::jsonb,
      regarding_table text NULL,
      regarding_id text NULL,
      requested_by text NULL,
      type text NOT NULL,
      policy_id text NULL,
      definition jsonb NOT NULL,
      status text NOT NULL,
      outcome text NULL,
      outcome_kind text NULL,
      due_on timestamptz NULL,
      current_stage integer NOT NULL DEFAULT 0,
      source text NOT NULL,
      flow_id text NULL,
      flow_name text NULL,
      flow_run_id text NULL,
      wait_id text NULL,
      step_key text NULL,
      idempotency_key text NULL,
      escalate_at timestamptz NULL,
      escalated_on timestamptz NULL,
      info_from text NULL,
      cancelled_by text NULL,
      cancel_reason text NULL,
      created_on timestamptz NOT NULL,
      modified_on timestamptz NOT NULL,
      completed_on timestamptz NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_approval_requests_idem ON ${E('ab_approval_requests')} (idempotency_key) WHERE idempotency_key IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ab_ix_approval_requests_regarding ON ${E('ab_approval_requests')} (regarding_id, created_on DESC)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_approval_requests_requester ON ${E('ab_approval_requests')} (requested_by, created_on DESC)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_approval_requests_open ON ${E('ab_approval_requests')} (escalate_at) WHERE status IN ('pending', 'info')`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_approval_stages')} (
      request_id text NOT NULL,
      idx integer NOT NULL,
      name text NOT NULL,
      mode text NOT NULL,
      quorum integer NULL,
      refs jsonb NOT NULL DEFAULT '[]'::jsonb,
      status text NOT NULL,
      started_on timestamptz NULL,
      completed_on timestamptz NULL,
      PRIMARY KEY (request_id, idx)
    )`,
    // P1-E: per-stage due dates (idempotent, no schema version step)
    `ALTER TABLE ${E('ab_approval_stages')} ADD COLUMN IF NOT EXISTS due_minutes integer NULL`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_approval_assignments')} (
      id text PRIMARY KEY,
      request_id text NOT NULL,
      stage_idx integer NOT NULL,
      user_id text NOT NULL,
      source text NOT NULL,
      status text NOT NULL,
      response text NULL,
      response_kind text NULL,
      comment text NULL,
      responded_on timestamptz NULL,
      reassigned_from text NULL,
      delegation_id text NULL,
      note text NULL,
      next_reminder_at timestamptz NULL,
      reminders_sent integer NOT NULL DEFAULT 0,
      created_on timestamptz NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_approval_assignments_request ON ${E('ab_approval_assignments')} (request_id, stage_idx)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_approval_assignments_user ON ${E('ab_approval_assignments')} (user_id, status)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_approval_assignments_from ON ${E('ab_approval_assignments')} (reassigned_from) WHERE reassigned_from IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ab_ix_approval_assignments_remind ON ${E('ab_approval_assignments')} (next_reminder_at) WHERE status = 'pending' AND next_reminder_at IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_approval_history')} (
      id text PRIMARY KEY,
      request_id text NOT NULL,
      at timestamptz NOT NULL,
      seq bigserial,
      actor_id text NULL,
      actor_kind text NOT NULL,
      action text NOT NULL,
      stage_idx integer NULL,
      details jsonb NOT NULL DEFAULT '{}'::jsonb
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_approval_history_request ON ${E('ab_approval_history')} (request_id, at, seq)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_approval_delegations')} (
      id text PRIMARY KEY,
      from_user text NOT NULL,
      to_user text NOT NULL,
      starts_on timestamptz NOT NULL,
      ends_on timestamptz NULL,
      policies jsonb NOT NULL DEFAULT '[]'::jsonb,
      note text NULL,
      created_by text NULL,
      created_on timestamptz NOT NULL,
      cancelled_on timestamptz NULL,
      started_applied boolean NOT NULL DEFAULT false,
      ended_applied boolean NOT NULL DEFAULT false
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_approval_delegations_from ON ${E('ab_approval_delegations')} (from_user)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_approval_links')} (
      id text PRIMARY KEY,
      request_id text NOT NULL,
      assignment_id text NOT NULL,
      user_id text NOT NULL,
      response text NOT NULL,
      expires_on timestamptz NOT NULL,
      used_on timestamptz NULL,
      created_on timestamptz NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_approval_links_assignment ON ${E('ab_approval_links')} (assignment_id)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_approval_settings')} (
      k text PRIMARY KEY,
      v jsonb NOT NULL,
      modified_by text NULL,
      modified_on timestamptz NOT NULL
    )`,
  ]
}

/** Version 9 step of package C: the tables come from environmentDdl (run just before); the step checks they exist. */
export async function upgradeEnvironmentTo9Approvals(db: SqlDb, schema: string): Promise<void> {
  for (const t of APPROVAL_TABLES) {
    const r = await db.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [`"${schema}"."${t}"`])
    if (!r[0]?.ok) throw new Error(`table ${schema}.${t} is missing after the schema update`)
  }
}
