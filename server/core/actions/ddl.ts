/**
 * Tables of P1 package D (schema version 8, docs/dev/schema.md "Connector actions, webhooks, reports, notification
 * delivery"). CREATE ... IF NOT EXISTS: idempotent, run on every start.
 *
 * Per environment (environmentDdl in meta-store.ts):
 *   ab_connection_access   "use" and "manage" grants of a connection to roles and users
 *   ab_custom_actions      actions a maker defined for an HTTP connection (form or OpenAPI import)
 *   ab_action_runs         activity log of action calls (who, what, when, outcome; never inputs, outputs or secrets)
 *   ab_action_idempotency  idempotency key -> result for 24 h (non-idempotent external actions)
 *   ab_webhooks            inbound webhooks of flows (token hash, sealed signing secret)
 *   ab_webhook_replays     signatures seen within the timestamp tolerance (replay protection)
 *   ab_report_subscriptions, ab_report_runs   scheduled reports and their history
 *
 * Install-wide (schema ab, INSTALL_DDL):
 *   ab.mail_suppressions          addresses that get no email from flows, notifications and reports
 *   ab.notification_deliveries    delivery log per notification, recipient and channel ("why did I get this")
 *   ab.notification_digest        email items waiting for a digest (or for quiet hours to end)
 *   ab.mail_log.sealed_message    large queued messages (attachments) sealed outside the job payload
 */
export const ACTIONS_TABLES = [
  'ab_connection_access', 'ab_custom_actions', 'ab_action_runs', 'ab_action_idempotency', 'ab_webhooks', 'ab_webhook_replays',
  'ab_report_subscriptions', 'ab_report_runs',
]

export function actionsEnvironmentDdl(schema: string): string[] {
  const E = (t: string): string => `"${schema}"."${t}"`
  return [
    `CREATE TABLE IF NOT EXISTS ${E('ab_connection_access')} (
      connection_id text NOT NULL,
      principal_kind text NOT NULL,
      principal_id text NOT NULL,
      level text NOT NULL,
      granted_by text NULL,
      granted_on timestamptz NOT NULL,
      PRIMARY KEY (connection_id, principal_kind, principal_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_custom_actions')} (
      id text PRIMARY KEY,
      connection_id text NOT NULL,
      action_id text NOT NULL,
      def jsonb NOT NULL,
      created_by text NULL,
      created_on timestamptz NOT NULL,
      modified_on timestamptz NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_custom_actions ON ${E('ab_custom_actions')} (connection_id, lower(action_id))`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_action_runs')} (
      id text PRIMARY KEY,
      at timestamptz NOT NULL,
      connection_id text NOT NULL,
      action_id text NOT NULL,
      user_id text NULL,
      source text NULL,
      correlation_id text NULL,
      status text NOT NULL,
      error_code text NULL,
      message text NULL,
      http_status integer NULL,
      duration_ms integer NOT NULL DEFAULT 0,
      replayed boolean NOT NULL DEFAULT false,
      details jsonb NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_action_runs_conn ON ${E('ab_action_runs')} (connection_id, at DESC)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_action_runs_at ON ${E('ab_action_runs')} (at)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_action_idempotency')} (
      key_hash text PRIMARY KEY,
      connection_id text NOT NULL,
      action_id text NOT NULL,
      state text NOT NULL,
      result jsonb NULL,
      created_on timestamptz NOT NULL,
      expires_on timestamptz NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_action_idem_exp ON ${E('ab_action_idempotency')} (expires_on)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_webhooks')} (
      id text PRIMARY KEY,
      flow_id text NOT NULL,
      name text NULL,
      token_hash text NOT NULL,
      token_hint text NOT NULL,
      secret_sealed text NULL,
      require_signature boolean NOT NULL DEFAULT false,
      tolerance_seconds integer NOT NULL DEFAULT 300,
      max_body_kb integer NOT NULL DEFAULT 256,
      per_minute integer NOT NULL DEFAULT 60,
      enabled boolean NOT NULL DEFAULT true,
      created_by text NULL,
      created_on timestamptz NOT NULL,
      rotated_on timestamptz NULL,
      last_used_on timestamptz NULL,
      calls bigint NOT NULL DEFAULT 0,
      rejected bigint NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_webhooks_flow ON ${E('ab_webhooks')} (flow_id)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_webhook_replays')} (
      hook_id text NOT NULL,
      sig_hash text NOT NULL,
      seen_on timestamptz NOT NULL,
      PRIMARY KEY (hook_id, sig_hash)
    )`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_report_subscriptions')} (
      id text PRIMARY KEY,
      name text NOT NULL,
      owner_id text NOT NULL,
      def jsonb NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      schedule_id text NULL,
      created_on timestamptz NOT NULL,
      modified_on timestamptz NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_report_runs')} (
      id text PRIMARY KEY,
      report_id text NOT NULL,
      started_on timestamptz NOT NULL,
      finished_on timestamptz NULL,
      status text NOT NULL,
      trigger text NOT NULL,
      job_id text NULL,
      recipients jsonb NULL,
      message text NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_report_runs ON ${E('ab_report_runs')} (report_id, started_on DESC)`,
  ]
}

const A = (t: string) => `"ab"."${t}"`

export const DELIVERY_TABLES = ['mail_suppressions', 'notification_deliveries', 'notification_digest']

export const DELIVERY_INSTALL_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS ${A('mail_suppressions')} (
    address text PRIMARY KEY,
    reason text NOT NULL,
    note text NULL,
    added_by text NULL,
    added_on timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${A('notification_deliveries')} (
    id text PRIMARY KEY,
    at timestamptz NOT NULL,
    user_id text NOT NULL,
    notification_id text NULL,
    environment_id text NULL,
    kind text NOT NULL,
    title text NOT NULL,
    channel text NOT NULL,
    status text NOT NULL,
    reason text NOT NULL,
    mail_id text NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ab_ix_ndeliveries_user ON ${A('notification_deliveries')} (user_id, at DESC)`,
  `CREATE INDEX IF NOT EXISTS ab_ix_ndeliveries_at ON ${A('notification_deliveries')} (at)`,
  // P1-E: a notify call with an idempotency key looks up what was already delivered for its derived notification id
  `CREATE INDEX IF NOT EXISTS ab_ix_ndeliveries_ntf ON ${A('notification_deliveries')} (notification_id) WHERE notification_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS ${A('notification_digest')} (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES ${A('users')} (id) ON DELETE CASCADE,
    kind text NOT NULL,
    title text NOT NULL,
    body text NOT NULL DEFAULT '',
    link text NULL,
    environment_id text NULL,
    created_on timestamptz NOT NULL,
    reason text NOT NULL,
    hold_until timestamptz NULL,
    delivery_id text NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ab_ix_ndigest_user ON ${A('notification_digest')} (user_id, created_on)`,
  `ALTER TABLE ${A('mail_log')} ADD COLUMN IF NOT EXISTS sealed_message text NULL`,
]
