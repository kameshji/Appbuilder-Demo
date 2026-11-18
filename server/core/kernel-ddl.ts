/**
 * Tables of the event and job kernel in every environment schema (docs/dev/events-and-jobs.md, docs/dev/schema.md):
 * ab_outbox, ab_jobs, ab_schedules, ab_table_events, ab_event_runs. Part of environmentDdl (meta-store.ts), so every
 * environment gets them when it is created or migrated (CREATE ... IF NOT EXISTS: idempotent).
 */
export const KERNEL_TABLES = ['ab_outbox', 'ab_jobs', 'ab_schedules', 'ab_table_events', 'ab_event_runs']

export function kernelDdl(schema: string): string[] {
  const E = (t: string): string => `"${schema}"."${t}"`
  return [
    // one row per data change, written in the same transaction as the change (see outbox.ts)
    `CREATE TABLE IF NOT EXISTS ${E('ab_outbox')} (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      table_id text NOT NULL,
      op text NOT NULL,
      row_id text NULL,
      row_ids jsonb NULL,
      row_count integer NOT NULL DEFAULT 1,
      changed jsonb NULL,
      before jsonb NULL,
      after jsonb NULL,
      actor_id text NULL,
      correlation_id text NULL,
      request_id text NULL,
      depth smallint NOT NULL DEFAULT 0,
      chain jsonb NULL,
      truncated boolean NOT NULL DEFAULT false,
      details jsonb NULL,
      created_on timestamptz NOT NULL DEFAULT now(),
      dispatched_on timestamptz NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_outbox_pending ON ${E('ab_outbox')} (id) WHERE dispatched_on IS NULL`,
    `CREATE INDEX IF NOT EXISTS ab_ix_outbox_table ON ${E('ab_outbox')} (table_id, id)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_outbox_created ON ${E('ab_outbox')} (created_on)`,
    // the job queue (jobs.ts)
    `CREATE TABLE IF NOT EXISTS ${E('ab_jobs')} (
      id text PRIMARY KEY,
      type text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      state text NOT NULL DEFAULT 'queued',
      priority integer NOT NULL DEFAULT 0,
      run_at timestamptz NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 5,
      backoff jsonb NULL,
      locked_by text NULL,
      locked_at timestamptz NULL,
      heartbeat_at timestamptz NULL,
      idempotency_key text NULL,
      correlation_id text NULL,
      run_as text NOT NULL DEFAULT 'system',
      created_by text NULL,
      result jsonb NULL,
      error jsonb NULL,
      created_on timestamptz NOT NULL,
      started_on timestamptz NULL,
      finished_on timestamptz NULL,
      modified_on timestamptz NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_jobs_idempotency ON ${E('ab_jobs')} (idempotency_key) WHERE idempotency_key IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ab_ix_jobs_due ON ${E('ab_jobs')} (type, priority DESC, run_at, id) WHERE state IN ('queued', 'failed')`,
    `CREATE INDEX IF NOT EXISTS ab_ix_jobs_running ON ${E('ab_jobs')} (heartbeat_at) WHERE state = 'running'`,
    `CREATE INDEX IF NOT EXISTS ab_ix_jobs_finished ON ${E('ab_jobs')} (state, finished_on)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_jobs_created ON ${E('ab_jobs')} (created_on)`,
    // schedules (jobs.ts): cron or interval, a job type and payload; slots enqueue exactly once (idempotency key)
    `CREATE TABLE IF NOT EXISTS ${E('ab_schedules')} (
      id text PRIMARY KEY,
      name text NOT NULL,
      description text NULL,
      cron text NULL,
      interval_seconds integer NULL,
      time_zone text NOT NULL DEFAULT 'UTC',
      job_type text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      enabled boolean NOT NULL DEFAULT true,
      misfire text NOT NULL DEFAULT 'run_once',
      built_in boolean NOT NULL DEFAULT false,
      last_run_at timestamptz NULL,
      next_run_at timestamptz NULL,
      last_job_id text NULL,
      created_by text NULL,
      created_on timestamptz NOT NULL,
      modified_on timestamptz NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_schedules_due ON ${E('ab_schedules')} (next_run_at) WHERE enabled`,
    // table events: validation rules and before/after events (table-events.ts); the definition is the jsonb document
    `CREATE TABLE IF NOT EXISTS ${E('ab_table_events')} (
      id text PRIMARY KEY,
      table_id text NOT NULL,
      timing text NOT NULL,
      order_no integer NOT NULL DEFAULT 0,
      enabled boolean NOT NULL DEFAULT true,
      def jsonb NOT NULL,
      created_on timestamptz NOT NULL,
      modified_on timestamptz NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_table_events_table ON ${E('ab_table_events')} (table_id, timing, order_no)`,
    // the events run log
    `CREATE TABLE IF NOT EXISTS ${E('ab_event_runs')} (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      at timestamptz NOT NULL,
      event_id text NULL,
      event_name text NOT NULL,
      table_id text NOT NULL,
      row_id text NULL,
      timing text NOT NULL,
      op text NOT NULL,
      status text NOT NULL,
      duration_ms integer NOT NULL DEFAULT 0,
      message text NULL,
      details jsonb NULL,
      job_id text NULL,
      correlation_id text NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_event_runs_table ON ${E('ab_event_runs')} (table_id, id)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_event_runs_at ON ${E('ab_event_runs')} (at)`,
  ]
}
