/**
 * Tables of the in-app notifications (P0 package H, server/core/notifications.ts) in schema `ab` (install-wide):
 * ab.notifications (one row per recipient; environment id nullable) and ab.user_settings (per-user settings stored on the
 * server: notification preferences, hidden presence). Part of INSTALL_DDL (meta-store.ts): CREATE ... IF NOT EXISTS, runs
 * on every start, idempotent.
 */
export const NOTIFICATION_TABLES = ['notifications', 'user_settings']

const A = (t: string) => `"ab"."${t}"`

export const NOTIFICATION_INSTALL_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS ${A('notifications')} (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES ${A('users')} (id) ON DELETE CASCADE,
    environment_id text NULL,
    kind text NOT NULL,
    title text NOT NULL,
    body text NOT NULL DEFAULT '',
    link text NULL,
    source text NOT NULL,
    sender_id text NULL,
    sender_name text NULL,
    created_on timestamptz NOT NULL,
    read_on timestamptz NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ab_ix_notifications_user ON ${A('notifications')} (user_id, created_on DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS ab_ix_notifications_unread ON ${A('notifications')} (user_id) WHERE read_on IS NULL`,
  `CREATE TABLE IF NOT EXISTS ${A('user_settings')} (
    user_id text NOT NULL REFERENCES ${A('users')} (id) ON DELETE CASCADE,
    key text NOT NULL,
    value jsonb NOT NULL,
    modified_on timestamptz NOT NULL,
    PRIMARY KEY (user_id, key)
  )`,
]
