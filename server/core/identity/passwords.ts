/**
 * Password history (policy: the last N passwords cannot be reused) and maximum age. Hashes in ab.password_history are
 * the same scrypt strings as ab.users.password_hash; at most 24 are kept per user.
 */
import { HttpError } from '../contracts.ts'
import type { UserRecord } from '../contracts.ts'
import type { CoreServices } from '../services.ts'
import { verifyPassword } from '../password.ts'
import { identity } from './index.ts'

const KEEP = 24

/** throws 422 when the password equals the current one or one of the last historyCount */
export async function checkPasswordHistory(services: CoreServices, user: UserRecord, password: string, field = 'password'): Promise<void> {
  const n = (await identity(services).policy.get()).password.historyCount
  if (!n) return
  const db = services.state.db
  if (!db) return
  const rows = await db.query<{ hash: string }>(`SELECT hash FROM "ab"."password_history" WHERE user_id = $1 ORDER BY created_on DESC LIMIT $2`, [user.id, n])
  const hashes = [...new Set([user.passwordHash, ...rows.map((r) => r.hash)].filter((h): h is string => !!h))].slice(0, n)
  for (const h of hashes) {
    if (await verifyPassword(password, h)) {
      throw new HttpError(422, 'invalid', `Choose a password you have not used recently (the last ${n} cannot be used again).`, field)
    }
  }
}

/** remembers a password hash that was just set */
export async function recordPassword(services: CoreServices, userId: string, hash: string): Promise<void> {
  const db = services.state.db
  if (!db) return
  await db.exec(`INSERT INTO "ab"."password_history" (user_id, hash, created_on) VALUES ($1, $2, now())`, [userId, hash])
  await db.exec(
    `DELETE FROM "ab"."password_history" WHERE user_id = $1 AND created_on < (
       SELECT min(created_on) FROM (SELECT created_on FROM "ab"."password_history" WHERE user_id = $1 ORDER BY created_on DESC LIMIT $2) k)`,
    [userId, KEEP],
  )
}

/** the password is older than the policy's maximum age (never when the age is unknown) */
export async function passwordExpired(services: CoreServices, user: UserRecord): Promise<boolean> {
  const days = (await identity(services).policy.get()).password.maxAgeDays
  if (!days || !user.passwordChangedOn) return false
  return Date.now() - new Date(user.passwordChangedOn).getTime() > days * 24 * 60 * 60 * 1000
}
