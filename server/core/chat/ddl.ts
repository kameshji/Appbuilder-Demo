/**
 * Chat (P3 package A, docs/dev/chat.md): tables and indexes.
 *
 * Schema version 14 (independent step): two metadata tables per environment schema, written by the chat service only
 * (they are used in the chat environment; every environment has them, empty):
 *   ab_chat_reports   messages members reported to the administrators (message, reporter, reason, state, handled by / on)
 *   ab_chat_exports   administrator exports of one conversation (channel, typed reason, by, on, download token hash, expiry)
 *
 * The four communication system tables (Channels, Channel members, Messages, Message reactions) gain their columns as a
 * system-table provisioning step (src/platform/system-tables.ts specs, ADD COLUMN IF NOT EXISTS in
 * server/core/system-tables.ts); their extra indexes come from chatSystemIndexes below, called by that provisioning.
 * Neither the chat tables nor these two metadata tables are copied with an environment (environment-ops.ts) or put in
 * a solution.
 */
import type { SqlDb } from '../contracts.ts'
import { SYS } from '../../../src/platform/system-tables.ts'
import { log } from '../util.ts'

/** the tables this package adds to every environment schema (checked by the upgrade step) */
export const CHAT_TABLES: string[] = ['ab_chat_reports', 'ab_chat_exports']

/** the four communication system tables (ids = physical names) */
export const CHAT_SYSTEM_TABLES: string[] = [SYS.channels, SYS.channelMembers, SYS.messages, SYS.messageReactions]

const q = (id: string): string => `"${id.replace(/"/g, '""')}"`

/** CREATE TABLE / INDEX ... IF NOT EXISTS statements for an environment schema (schema-qualified, idempotent) */
export function chatEnvironmentDdl(schema: string): string[] {
  const E = (t: string): string => `${q(schema)}.${q(t)}`
  return [
    `CREATE TABLE IF NOT EXISTS ${E('ab_chat_reports')} (
      id text PRIMARY KEY,
      message_id text NOT NULL,
      channel_id text NOT NULL,
      reporter_id text NOT NULL,
      reason text NOT NULL,
      state text NOT NULL DEFAULT 'open',
      outcome text NULL,
      handled_by text NULL,
      handled_on timestamptz NULL,
      created_on timestamptz NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_chat_reports_state ON ${E('ab_chat_reports')} (state, created_on DESC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_chat_reports_once ON ${E('ab_chat_reports')} (message_id, reporter_id) WHERE state = 'open'`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_chat_exports')} (
      id text PRIMARY KEY,
      channel_id text NOT NULL,
      reason text NOT NULL,
      by_id text NOT NULL,
      created_on timestamptz NOT NULL,
      token_hash text NOT NULL,
      expires_on timestamptz NOT NULL,
      downloaded_on timestamptz NULL,
      messages integer NOT NULL DEFAULT 0,
      files integer NOT NULL DEFAULT 0
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_chat_exports_token ON ${E('ab_chat_exports')} (token_hash)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_chat_exports_channel ON ${E('ab_chat_exports')} (channel_id, created_on DESC)`,
  ]
}

/**
 * Indexes of the communication system tables beyond the column ones (run by provisionSystemTables after the columns
 * exist): history pages (Channel, Seq DESC), the change feed (Channel, ChangeSeq), thread replies, full-text search of
 * the message text ('simple' configuration, no extension), one 1:1 conversation per pair, "my conversations".
 */
export function chatSystemIndexes(schema: string, tableId: string): string[] {
  const T = (t: string): string => `${q(schema)}.${q(t)}`
  if (tableId === SYS.messages) {
    return [
      `CREATE INDEX IF NOT EXISTS ab_ix_chat_msg_history ON ${T(SYS.messages)} ("Channel", "Seq" DESC)`,
      `CREATE INDEX IF NOT EXISTS ab_ix_chat_msg_changes ON ${T(SYS.messages)} ("Channel", "ChangeSeq")`,
      `CREATE INDEX IF NOT EXISTS ab_ix_chat_msg_replies ON ${T(SYS.messages)} ("ParentMessage", "Seq") WHERE "ParentMessage" IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS ab_ix_chat_msg_fts ON ${T(SYS.messages)} USING gin (to_tsvector('simple', COALESCE("BodyText", '')))`,
      `CREATE INDEX IF NOT EXISTS ab_ix_chat_msg_age ON ${T(SYS.messages)} ("createdOn")`,
    ]
  }
  if (tableId === SYS.channels) {
    return [`CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_chat_direct_key ON ${T(SYS.channels)} ("DirectKey") WHERE "DirectKey" IS NOT NULL AND "DirectKey" <> ''`]
  }
  if (tableId === SYS.channelMembers) return [`CREATE INDEX IF NOT EXISTS ab_ix_chat_member_user ON ${T(SYS.channelMembers)} ("User")`]
  if (tableId === SYS.messageReactions) return [`CREATE INDEX IF NOT EXISTS ab_ix_chat_reaction_msg ON ${T(SYS.messageReactions)} ("Message")`]
  return []
}

async function checkTables(db: SqlDb, schema: string, tables: string[]): Promise<void> {
  for (const t of tables) {
    const r = await db.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [`${q(schema)}.${q(t)}`])
    if (!r[0]?.ok) throw new Error(`table ${schema}.${t} is missing after the schema update`)
  }
}

/**
 * Upgrade step to 14 (independent): the two tables come from environmentDdl (run just before the steps); the step checks
 * they exist so a server of version 13 refuses this schema (downgrade guard). The system-table columns follow in
 * provisionSystemTables (after the steps); no data is migrated (nothing wrote the placeholder tables before).
 */
export async function upgradeEnvironmentTo14Chat(db: SqlDb, schema: string): Promise<void> {
  await checkTables(db, schema, CHAT_TABLES)
  // before version 14 the placeholder tables were writable through the data API (the gap closed by package A): rows
  // written then are kept (nothing is deleted by an upgrade), but the administrator is told they exist
  for (const t of CHAT_SYSTEM_TABLES) {
    const has = await db.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [`${q(schema)}.${q(t)}`])
    if (!has[0]?.ok) continue
    const n = Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${q(schema)}.${q(t)}`))[0]?.n ?? 0)
    if (n > 0) log('warn', `${schema}.${t} holds ${n} row(s) written before chat existed (through the data API); review them in Admin console > Chat`)
  }
}
