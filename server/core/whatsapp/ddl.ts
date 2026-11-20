/**
 * WhatsApp connector (P2 package E; docs/dev/whatsapp.md): tables of schema version 13 (independent step). Per environment
 * schema, CREATE ... IF NOT EXISTS: idempotent, run on every start (environmentDdl in meta-store.ts).
 *
 *   ab_whatsapp_optins         the CURRENT consent per phone number (E.164): opted_in / opted_out, source, who, when, evidence
 *   ab_whatsapp_optin_history  every change ever recorded (append only; the evidence of consent stays when the status changes)
 *   ab_whatsapp_messages       the message log: direction, number, template, status and its history, provider message id,
 *                              idempotency key, flow run / notification link, error (retention: 90 days by default)
 *   ab_whatsapp_windows        last inbound message per business number and customer number (the 24-hour service window)
 *   ab_whatsapp_prefs          per person: which notification kinds go to WhatsApp
 *   ab_whatsapp_settings       environment settings (k/v): stop and start keywords, the notification mapping
 *   ab_whatsapp_hook_seen      replay marks of verified webhook calls (SHA-256 of the signature; kept 7 days)
 *
 * None of these are copied into a new environment (environment-ops.ts COPY_META does not list them): a copy arrives with no
 * opt-ins, no message log, no notification mapping, and its WhatsApp connections without secrets (like every connection).
 */
import type { SqlDb } from '../contracts.ts'

/** the tables this package adds to every environment schema (checked by the upgrade step) */
export const WHATSAPP_TABLES: string[] = [
  'ab_whatsapp_optins', 'ab_whatsapp_optin_history', 'ab_whatsapp_messages', 'ab_whatsapp_windows', 'ab_whatsapp_prefs', 'ab_whatsapp_settings', 'ab_whatsapp_hook_seen',
]

/** CREATE TABLE IF NOT EXISTS statements for an environment schema (schema-qualified, idempotent) */
export function whatsappEnvironmentDdl(schema: string): string[] {
  const q = (id: string): string => `"${id}"`
  const E = (t: string): string => `${q(schema)}.${q(t)}`
  return [
    `CREATE TABLE IF NOT EXISTS ${E('ab_whatsapp_optins')} (
      phone text PRIMARY KEY,
      status text NOT NULL,
      source text NOT NULL,
      evidence text NOT NULL,
      recorded_by text NULL,
      recorded_on timestamptz NOT NULL,
      contact_table text NULL,
      contact_row text NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_whatsapp_optin_history')} (
      id text PRIMARY KEY,
      phone text NOT NULL,
      status text NOT NULL,
      source text NOT NULL,
      evidence text NOT NULL,
      recorded_by text NULL,
      recorded_on timestamptz NOT NULL,
      contact_table text NULL,
      contact_row text NULL,
      connection_id text NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_whatsapp_optin_history_phone ON ${E('ab_whatsapp_optin_history')} (phone, recorded_on DESC)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_whatsapp_messages')} (
      id text PRIMARY KEY,
      connection_id text NOT NULL,
      direction text NOT NULL,
      phone text NOT NULL,
      kind text NOT NULL,
      template text NULL,
      language text NULL,
      status text NOT NULL,
      history jsonb NOT NULL DEFAULT '[]'::jsonb,
      provider_id text NULL,
      idempotency_key text NULL,
      source text NULL,
      action_run_id text NULL,
      correlation_id text NULL,
      notification_id text NULL,
      user_id text NULL,
      error_code text NULL,
      error text NULL,
      created_on timestamptz NOT NULL,
      modified_on timestamptz NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_whatsapp_messages_key ON ${E('ab_whatsapp_messages')} (connection_id, idempotency_key) WHERE idempotency_key IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ab_ix_whatsapp_messages_provider ON ${E('ab_whatsapp_messages')} (provider_id)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_whatsapp_messages_created ON ${E('ab_whatsapp_messages')} (created_on DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_whatsapp_messages_phone ON ${E('ab_whatsapp_messages')} (phone, created_on DESC)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_whatsapp_windows')} (
      connection_id text NOT NULL,
      phone text NOT NULL,
      last_inbound_on timestamptz NOT NULL,
      PRIMARY KEY (connection_id, phone)
    )`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_whatsapp_prefs')} (
      user_id text PRIMARY KEY,
      kinds jsonb NOT NULL DEFAULT '{}'::jsonb,
      modified_on timestamptz NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_whatsapp_settings')} (
      k text PRIMARY KEY,
      v jsonb NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_whatsapp_hook_seen')} (
      sig_hash text PRIMARY KEY,
      connection_id text NOT NULL,
      seen_on timestamptz NOT NULL
    )`,
  ]
}

/**
 * Version 13 step (independent): the tables come from environmentDdl (run just before the steps); the step checks they
 * exist so a server of version 12 refuses this schema (downgrade guard). Nothing existing changes.
 */
export async function upgradeEnvironmentTo13Whatsapp(db: SqlDb, schema: string): Promise<void> {
  for (const t of WHATSAPP_TABLES) {
    const r = await db.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [`"${schema}"."${t}"`])
    if (!r[0]?.ok) throw new Error(`table ${schema}.${t} is missing after the schema update`)
  }
}
