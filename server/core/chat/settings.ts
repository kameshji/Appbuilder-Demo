/**
 * Chat settings (P3-A, docs/admin/chat.md): one record per install in ab.settings, key `chat`.
 *
 *   environmentId     the chat environment: chat's tables, files and backups are those of this environment (default: Default);
 *                     changed only while chat holds no messages (moving history is not built)
 *   createChannels    who may create channels: everyone who uses chat, or makers and administrators only
 *   retention         days to keep messages per conversation kind (null = keep everything; at least 30)
 *   readOnly          people an administrator made read-only in chat (they read, they do not post)
 *
 * Also here: the environment hooks (deleting the chat environment is refused while it holds messages; a copy of an
 * environment never takes chat along).
 */
import type { SqlDb } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import type { CoreServices } from '../services.ts'
import { DEFAULT_ENVIRONMENT_ID } from '../env-context.ts'
import { SYS } from '../../../src/platform/system-tables.ts'
import { CHAT_LIMITS } from '../../../src/platform/chat-protocol.ts'
import type { ChatKind } from '../../../src/platform/chat-protocol.ts'
import { CHAT_SYSTEM_TABLES } from './ddl.ts'

export const CHAT_SETTINGS_KEY = 'chat'

export interface ChatSettings {
  environmentId: string
  createChannels: 'everyone' | 'makers'
  retention: Record<ChatKind, number | null>
  readOnly: string[]
}

export function defaultChatSettings(): ChatSettings {
  return { environmentId: DEFAULT_ENVIRONMENT_ID, createChannels: 'everyone', retention: { channel: null, direct: null, group: null }, readOnly: [] }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** stored JSON -> settings (unknown or bad values fall back to the defaults) */
export function parseChatSettings(raw: unknown): ChatSettings {
  const d = defaultChatSettings()
  const o = isObj(raw) ? raw : {}
  const env = typeof o.environmentId === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(o.environmentId) ? o.environmentId : d.environmentId
  const r = isObj(o.retention) ? o.retention : {}
  const days = (v: unknown): number | null => {
    const n = Number(v)
    return v === null || v === undefined || v === '' || !Number.isInteger(n) || n < CHAT_LIMITS.minRetentionDays || n > 36500 ? null : n
  }
  return {
    environmentId: env,
    createChannels: o.createChannels === 'makers' ? 'makers' : 'everyone',
    retention: { channel: days(r.channel), direct: days(r.direct), group: days(r.group) },
    readOnly: Array.isArray(o.readOnly) ? [...new Set(o.readOnly.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64))].slice(0, 5000) : [],
  }
}

/** validates an administrator's change (422 with the field on a bad value; retention below 30 days is refused, not clamped) */
export function checkChatSettingsChange(cur: ChatSettings, b: Record<string, unknown>): ChatSettings {
  const next: ChatSettings = { ...cur, retention: { ...cur.retention }, readOnly: [...cur.readOnly] }
  if (b.createChannels !== undefined) {
    if (b.createChannels !== 'everyone' && b.createChannels !== 'makers') throw new HttpError(422, 'invalid', 'createChannels is "everyone" or "makers".', 'createChannels')
    next.createChannels = b.createChannels
  }
  if (b.retention !== undefined) {
    if (!isObj(b.retention)) throw new HttpError(422, 'invalid', 'retention is { channel, direct, group } in days (null keeps everything).', 'retention')
    for (const k of ['channel', 'direct', 'group'] as const) {
      if (!(k in b.retention)) continue
      const v = b.retention[k]
      if (v === null) {
        next.retention[k] = null
        continue
      }
      const n = Number(v)
      if (!Number.isInteger(n) || n < CHAT_LIMITS.minRetentionDays || n > 36500) throw new HttpError(422, 'invalid', `Retention is a whole number of days, at least ${CHAT_LIMITS.minRetentionDays} (or empty to keep everything).`, `retention.${k}`)
      next.retention[k] = n
    }
  }
  return next
}

let cache: { at: number; s: ChatSettings } | null = null

export async function loadChatSettings(db: SqlDb): Promise<ChatSettings> {
  if (cache && Date.now() - cache.at < 3000) return cache.s
  const rows = await db.query<{ v: string | null }>(`SELECT v FROM "ab"."settings" WHERE k = $1`, [CHAT_SETTINGS_KEY])
  let raw: unknown = null
  try {
    raw = rows[0]?.v ? JSON.parse(rows[0].v) : null
  } catch {
    raw = null
  }
  const s = parseChatSettings(raw)
  cache = { at: Date.now(), s }
  return s
}

export async function saveChatSettings(db: SqlDb, s: ChatSettings): Promise<void> {
  await db.exec(`INSERT INTO "ab"."settings" (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [CHAT_SETTINGS_KEY, JSON.stringify(s)])
  cache = null
}

/** tests: forget the cached settings */
export function forgetChatSettings(): void {
  cache = null
}

const q = (id: string): string => `"${id.replace(/"/g, '""')}"`

/** the number of messages chat holds in an environment schema (0 when the table is not there) */
export async function chatMessageCount(db: SqlDb, schema: string): Promise<number> {
  const has = await db.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [`${q(schema)}.${q(SYS.messages)}`])
  if (!has[0]?.ok) return 0
  return Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${q(schema)}.${q(SYS.messages)}`))[0]?.n ?? 0)
}

/** environment-ops.ts: deleting the chat environment is refused while it holds chat messages (409) */
export async function refuseChatEnvironmentDelete(s: CoreServices, env: { id: string; schema: string; name: string }): Promise<void> {
  const db = s.state.db
  if (!db) return
  const st = await loadChatSettings(db)
  if (st.environmentId !== env.id) return
  if ((await chatMessageCount(db, env.schema)) > 0) {
    throw new HttpError(409, 'conflict', `"${env.name}" holds the install's chat (its messages and files). It cannot be deleted while chat has messages; move chat to another environment first (possible only while chat is empty) or remove the conversations in Admin console > Chat.`)
  }
}

/**
 * environment-ops.ts, after a copy with data: the copy never takes chat along. The chat tables are not copied
 * (COPYABLE_SYSTEM_TABLES); this removes what came with the generic copy: chat file records and their bytes (the
 * attachment folder is copied as a whole), and chat mentions.
 */
export async function dropChatFromCopy(s: CoreServices, schema: string): Promise<void> {
  const db = s.state.db
  if (!db) return
  const recs = await db.query<{ id: string }>(`SELECT id FROM ${q(schema)}."ab_attachments" WHERE table_id = ANY($1::text[])`, [CHAT_SYSTEM_TABLES])
  if (recs.length) {
    const full = await s.meta.attachments.many(recs.map((r) => r.id))
    await s.data.internals.removeAttachments(full)
  }
  await db.exec(`DELETE FROM ${q(schema)}.${q(SYS.mentions)} WHERE "regardingTable" = $1`, [SYS.messages])
  for (const t of CHAT_SYSTEM_TABLES) await db.exec(`DELETE FROM ${q(schema)}.${q(t)}`)
}
