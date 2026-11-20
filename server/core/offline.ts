/**
 * Offline entry support on the server (P2 package A, docs/dev/phone.md "Offline entry").
 *
 * 1. Idempotent row writes. POST /data/:table/rows and PATCH /data/:table/rows/:id accept an `Idempotency-Key` header
 *    (8..128 of A-Z a-z 0-9 _ . : -). The key is claimed per user and environment in the existing ab_action_idempotency
 *    table (connector actions use it the same way; kept 24 h): the first request runs and stores its answer; a retry
 *    with the same key gets the stored answer (`replayed: true`) and writes nothing; a retry while the first is still
 *    running gets 409 "still being processed" (the client waits and retries). A write the server refuses (validation,
 *    permissions, version conflict) releases the key, so "fix and resend" may reuse it. Creates also carry the
 *    client-generated row id (values.id), which the server already accepts.
 *
 * 2. The offline data key. POST /offline/key { deviceId } returns a 256-bit key for this user and device, derived
 *    (HMAC-SHA256) from the install's secret key, the user id, the device id and the user's offline epoch. The browser
 *    holds it in memory and sessionStorage only and encrypts the offline store with it (AES-GCM). Nothing is stored for
 *    it on the server. POST /offline/wipe { userId? } raises the epoch (own devices; administrators: any user's), so
 *    every key issued before no longer matches: devices discard their offline data the next time they connect, and data
 *    left on a device that never connects again cannot be decrypted with a key the server will issue.
 */
import { createHash, createHmac } from 'node:crypto'
import { HttpError } from './contracts.ts'
import type { Ctx, ServerConfig, SqlDb, UserContext } from './contracts.ts'
import type { CoreServices } from './services.ts'
import type { ApiRouter } from './router.ts'
import { loadSecretKey } from './secrets.ts'
import { currentEnvironment } from './env-context.ts'

export const IDEMPOTENCY_HEADER = 'idempotency-key'
const KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/
const DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/
const HOURS = 24
/** a claim left 'running' longer than this (a crashed request) may be taken again */
const STALE_MS = 60_000

const q = (id: string) => `"${id}"`
const T = (t: string) => `${q(currentEnvironment().schema)}.${q(t)}`

function db(services: CoreServices): SqlDb {
  const d = services.state.db
  if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
  return d
}

/** the request's idempotency key, null when none; 422 when malformed */
export function idempotencyKeyOf(ctx: Pick<Ctx, 'req'>): string | null {
  const v = ctx.req?.headers?.[IDEMPOTENCY_HEADER]
  if (v === undefined) return null
  const s = Array.isArray(v) ? v[0] : v
  if (!KEY_RE.test(s)) throw new HttpError(422, 'invalid', 'Idempotency-Key must be 8 to 128 letters, digits or _ . : -', 'Idempotency-Key')
  return s
}

export const idempotencyHash = (env: string, userId: string, key: string) => createHash('sha256').update(`row\u0000${env}\u0000${userId}\u0000${key}`).digest('hex')

/**
 * Runs `fn` once per (user, environment, key). Returns its answer, or the stored answer of an earlier run with
 * `replayed: true`.
 */
export async function idempotentWrite<T extends object>(services: CoreServices, user: UserContext, key: string, tableId: string, op: 'create' | 'update' | 'upload', fn: () => Promise<T>): Promise<T & { replayed?: boolean }> {
  const d = db(services)
  const hash = idempotencyHash(currentEnvironment().id, user.user.id, key)
  const now = new Date()
  const claimed = await d.query<{ key_hash: string }>(
    `INSERT INTO ${T('ab_action_idempotency')} (key_hash, connection_id, action_id, state, created_on, expires_on) VALUES ($1, $2, $3, 'running', $4, $5)
     ON CONFLICT (key_hash) DO UPDATE SET state = 'running', created_on = EXCLUDED.created_on, expires_on = EXCLUDED.expires_on, result = NULL
       WHERE ${T('ab_action_idempotency')}.expires_on < $4 OR (${T('ab_action_idempotency')}.state = 'running' AND ${T('ab_action_idempotency')}.created_on < $6)
     RETURNING key_hash`,
    [hash, `data:${tableId}`, `row.${op}`, now, new Date(now.getTime() + HOURS * 3600_000), new Date(now.getTime() - STALE_MS)],
  )
  if (!claimed.length) {
    const row = (await d.query<{ state: string; result: unknown; connection_id: string; action_id: string }>(`SELECT state, result, connection_id, action_id FROM ${T('ab_action_idempotency')} WHERE key_hash = $1`, [hash]))[0]
    if (row && (row.connection_id !== `data:${tableId}` || row.action_id !== `row.${op}`)) {
      throw new HttpError(422, 'invalid', 'This Idempotency-Key was already used for a different change.', 'Idempotency-Key')
    }
    if (row?.state === 'done' && row.result && typeof row.result === 'object') return { ...(row.result as T), replayed: true }
    throw new HttpError(409, 'conflict', 'This change is still being processed. Try again in a moment.', 'Idempotency-Key')
  }
  let result: T
  try {
    result = await fn()
  } catch (e) {
    // nothing was written: release the key so the same change may be fixed and sent again
    await d.exec(`DELETE FROM ${T('ab_action_idempotency')} WHERE key_hash = $1`, [hash]).catch(() => {})
    throw e
  }
  await d.exec(`UPDATE ${T('ab_action_idempotency')} SET state = 'done', result = $2::jsonb WHERE key_hash = $1`, [hash, JSON.stringify(result)])
  return result
}

/* ------------------------------------------------------------------ the offline data key */

const OFFLINE_SETTING = 'offline'

interface OfflineState { epoch: number; wipedOn?: string; wipedBy?: string }

async function readState(d: SqlDb, userId: string): Promise<OfflineState> {
  const r = await d.query<{ value: unknown }>(`SELECT value FROM "ab"."user_settings" WHERE user_id = $1 AND key = $2`, [userId, OFFLINE_SETTING])
  const v = r[0]?.value as Partial<OfflineState> | undefined
  return { epoch: typeof v?.epoch === 'number' && Number.isInteger(v.epoch) ? v.epoch : 0, ...(v?.wipedOn ? { wipedOn: v.wipedOn } : {}) }
}

/** HMAC-SHA256(offline secret, user, device, epoch), base64url; pure (unit-tested) */
export function deriveOfflineKey(secret: Buffer, userId: string, deviceId: string, epoch: number): string {
  return createHmac('sha256', secret).update(`appbuilder-offline-v1\u0000${userId}\u0000${deviceId}\u0000${epoch}`).digest('base64url')
}

export function offlineRoutes(router: ApiRouter, services: CoreServices & { config: ServerConfig }): void {
  let secret: Buffer | null = null
  // a separate key from the install's secret key (never the secret key itself)
  const offlineSecret = () => (secret ??= createHmac('sha256', loadSecretKey(services.config.workspaceDir)).update('appbuilder offline store keys').digest())

  router.add('POST', '/offline/key', async (ctx) => {
    const b = (ctx.body ?? {}) as { deviceId?: unknown }
    if (typeof b.deviceId !== 'string' || !DEVICE_RE.test(b.deviceId)) throw new HttpError(422, 'invalid', 'deviceId must be 8 to 64 letters, digits, _ or -.', 'deviceId')
    const st = await readState(db(services), ctx.user!.user.id)
    return { key: deriveOfflineKey(offlineSecret(), ctx.user!.user.id, b.deviceId, st.epoch), epoch: st.epoch, ...(st.wipedOn ? { wipedOn: st.wipedOn } : {}) }
  }, { auth: 'user' })

  router.add('POST', '/offline/wipe', async (ctx) => {
    const me = ctx.user!
    const b = (ctx.body ?? {}) as { userId?: unknown }
    const target = typeof b.userId === 'string' && b.userId ? b.userId : me.user.id
    if (target !== me.user.id && !me.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only an administrator can wipe the device data of another user.')
    const d = db(services)
    const st = await readState(d, target)
    const next: OfflineState = { epoch: st.epoch + 1, wipedOn: new Date().toISOString(), wipedBy: me.user.id }
    await d.exec(
      `INSERT INTO "ab"."user_settings" (user_id, key, value, modified_on) VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, modified_on = EXCLUDED.modified_on`,
      [target, OFFLINE_SETTING, JSON.stringify(next)],
    )
    try {
      await services.install.audit({ userId: me.user.id, action: 'offline.wipe', environmentId: null, details: { user: target, epoch: next.epoch } })
    } catch {
      /* the audit is best effort here: the wipe itself is done */
    }
    return { epoch: next.epoch, wipedOn: next.wipedOn }
  }, { auth: 'user' })
}
