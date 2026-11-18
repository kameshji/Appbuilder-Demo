/**
 * Identity tables (P0 package I) in schema `ab` (install-wide), part of INSTALL_DDL (meta-store.ts): CREATE ... IF NOT
 * EXISTS / ADD COLUMN IF NOT EXISTS, idempotent, run on every start. Schema version 7 (shared with the other wave 4
 * packages): upgradeInstallTo7Identity() is this package's own step and only checks that its objects exist.
 * Column reference: docs/dev/schema.md ("Identity").
 */
import type { SqlDb } from '../contracts.ts'

export const IDENTITY_TABLES = ['user_mfa', 'auth_tokens', 'trusted_devices', 'password_history', 'signin_log', 'mail_log', 'api_keys']

const A = (t: string) => `"ab"."${t}"`

export const IDENTITY_INSTALL_DDL: string[] = [
  // users: person or service account; when the password was last set (maximum age, history)
  `ALTER TABLE ${A('users')} ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'person'`,
  `ALTER TABLE ${A('users')} ADD COLUMN IF NOT EXISTS password_changed_on timestamptz NULL`,
  // sessions: where from, a public id for the session list, the absolute end, the last proof of identity (re-authentication),
  // whether a second factor was used, and a restriction (mfa_enrol: may only set up two-step verification)
  `ALTER TABLE ${A('sessions')} ADD COLUMN IF NOT EXISTS ip text NULL`,
  `ALTER TABLE ${A('sessions')} ADD COLUMN IF NOT EXISTS public_id text NULL`,
  `ALTER TABLE ${A('sessions')} ADD COLUMN IF NOT EXISTS absolute_expires_on timestamptz NULL`,
  `ALTER TABLE ${A('sessions')} ADD COLUMN IF NOT EXISTS auth_on timestamptz NULL`,
  `ALTER TABLE ${A('sessions')} ADD COLUMN IF NOT EXISTS mfa boolean NOT NULL DEFAULT false`,
  `ALTER TABLE ${A('sessions')} ADD COLUMN IF NOT EXISTS restricted text NULL`,
  `CREATE INDEX IF NOT EXISTS ab_ix_sessions_public ON ${A('sessions')} (public_id)`,
  `CREATE TABLE IF NOT EXISTS ${A('user_mfa')} (
    user_id text PRIMARY KEY REFERENCES ${A('users')} (id) ON DELETE CASCADE,
    totp_secret_sealed text NULL,
    totp_enabled_on timestamptz NULL,
    totp_last_step bigint NULL,
    totp_pending_sealed text NULL,
    totp_pending_on timestamptz NULL,
    email_enabled boolean NOT NULL DEFAULT false,
    recovery jsonb NULL,
    recovery_created_on timestamptz NULL,
    modified_on timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${A('auth_tokens')} (
    id text PRIMARY KEY,
    kind text NOT NULL,
    user_id text NOT NULL REFERENCES ${A('users')} (id) ON DELETE CASCADE,
    token_hash text NOT NULL,
    created_on timestamptz NOT NULL,
    expires_on timestamptz NOT NULL,
    used_on timestamptz NULL,
    created_by text NULL,
    attempts integer NOT NULL DEFAULT 0,
    data jsonb NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_auth_tokens_hash ON ${A('auth_tokens')} (token_hash)`,
  `CREATE INDEX IF NOT EXISTS ab_ix_auth_tokens_user ON ${A('auth_tokens')} (user_id, kind)`,
  `CREATE INDEX IF NOT EXISTS ab_ix_auth_tokens_expires ON ${A('auth_tokens')} (expires_on)`,
  `CREATE TABLE IF NOT EXISTS ${A('trusted_devices')} (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES ${A('users')} (id) ON DELETE CASCADE,
    created_on timestamptz NOT NULL,
    expires_on timestamptz NOT NULL,
    last_used_on timestamptz NULL,
    user_agent text NULL,
    ip text NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ab_ix_trusted_devices_user ON ${A('trusted_devices')} (user_id)`,
  `CREATE TABLE IF NOT EXISTS ${A('password_history')} (
    user_id text NOT NULL REFERENCES ${A('users')} (id) ON DELETE CASCADE,
    hash text NOT NULL,
    created_on timestamptz NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ab_ix_password_history_user ON ${A('password_history')} (user_id, created_on DESC)`,
  // no foreign key: the log outlives a deleted account
  `CREATE TABLE IF NOT EXISTS ${A('signin_log')} (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at timestamptz NOT NULL,
    user_id text NULL,
    email text NULL,
    outcome text NOT NULL,
    reason text NOT NULL,
    method text NOT NULL,
    ip text NULL,
    user_agent text NULL,
    session_id text NULL,
    device_hash text NULL,
    new_device boolean NOT NULL DEFAULT false
  )`,
  `CREATE INDEX IF NOT EXISTS ab_ix_signin_log_at ON ${A('signin_log')} (at DESC)`,
  `CREATE INDEX IF NOT EXISTS ab_ix_signin_log_user ON ${A('signin_log')} (user_id, at DESC)`,
  `CREATE TABLE IF NOT EXISTS ${A('mail_log')} (
    id text PRIMARY KEY,
    created_on timestamptz NOT NULL,
    sent_on timestamptz NULL,
    status text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    to_address text NOT NULL,
    subject text NOT NULL,
    template text NOT NULL,
    user_id text NULL,
    job_id text NULL,
    message_id text NULL,
    last_error text NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ab_ix_mail_log_created ON ${A('mail_log')} (created_on DESC)`,
  `CREATE TABLE IF NOT EXISTS ${A('api_keys')} (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES ${A('users')} (id) ON DELETE CASCADE,
    environment_id text NOT NULL,
    name text NOT NULL,
    prefix text NOT NULL,
    secret_hash text NOT NULL,
    created_on timestamptz NOT NULL,
    created_by text NULL,
    expires_on timestamptz NULL,
    last_used_on timestamptz NULL,
    last_used_ip text NULL,
    revoked_on timestamptz NULL,
    revoked_by text NULL,
    ip_allow jsonb NULL,
    rate_per_minute integer NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_api_keys_prefix ON ${A('api_keys')} (prefix)`,
  `CREATE INDEX IF NOT EXISTS ab_ix_api_keys_user ON ${A('api_keys')} (user_id)`,
]

/**
 * Package I's part of the version 7 install step (runs inside the install migration transaction, after INSTALL_DDL):
 * the objects come from IDENTITY_INSTALL_DDL; this makes sure they all exist before the database is stamped 7, so a
 * version 6 server refuses a database that has them (downgrade guard). Independent of the other packages' steps.
 */
export async function upgradeInstallTo7Identity(tx: SqlDb): Promise<string> {
  for (const t of IDENTITY_TABLES) {
    const r = await tx.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [`"ab"."${t}"`])
    if (!r[0]?.ok) throw new Error(`table ab.${t} is missing after the schema update`)
  }
  return 'version 7 (identity): two-step verification, one-time tokens, remembered devices, password history, sign-in log, mail delivery log, API keys; users.kind, sessions.ip/public_id/absolute_expires_on/auth_on/mfa/restricted'
}
