/**
 * The mail suppression list (install-wide, ab.mail_suppressions): addresses that get no email from flows (the Email
 * connector), notifications and scheduled reports. System email (password resets, invitations, sign-in codes) still
 * goes out: those are needed to use the account.
 *
 * Hard bounces are not detected automatically: Appbuilder has no inbound mail, so it never sees the bounce messages a
 * relay sends back later. A 5xx answer of the relay at sending time is visible in the delivery log; administrators (or
 * a user for their own address, through the unsubscribe page) add addresses by hand.
 */
import type { SqlDb } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import { validAddress } from '../identity/smtp.ts'

export interface Suppression { address: string; reason: 'manual' | 'complaint' | 'bounce' | 'unsubscribed'; note: string | null; addedBy: string | null; addedOn: string }

export async function suppressedAmong(db: SqlDb, addresses: string[]): Promise<Set<string>> {
  if (!addresses.length) return new Set()
  const rows = await db.query<{ address: string }>(`SELECT address FROM "ab"."mail_suppressions" WHERE address = ANY($1::text[])`, [addresses.map((a) => a.toLowerCase())])
  return new Set(rows.map((r) => r.address))
}

export async function listSuppressions(db: SqlDb, o: { search?: string; limit: number; offset: number }): Promise<{ items: Suppression[]; total: number }> {
  const params: unknown[] = []
  let where = ''
  if (o.search) {
    params.push(`%${o.search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    where = `WHERE address LIKE $1`
  }
  const total = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "ab"."mail_suppressions" ${where}`, params)
  const rows = await db.query<Record<string, unknown>>(`SELECT * FROM "ab"."mail_suppressions" ${where} ORDER BY added_on DESC LIMIT ${Math.max(1, Math.min(500, o.limit))} OFFSET ${Math.max(0, o.offset)}`, params)
  return {
    total: Number(total[0]?.n ?? 0),
    items: rows.map((r) => ({ address: String(r.address), reason: r.reason as Suppression['reason'], note: r.note ? String(r.note) : null, addedBy: r.added_by ? String(r.added_by) : null, addedOn: new Date(r.added_on as string).toISOString() })),
  }
}

export async function addSuppression(db: SqlDb, address: string, reason: Suppression['reason'], by: string | null, note?: string): Promise<void> {
  const a = address.trim().toLowerCase()
  if (!validAddress(a)) throw new HttpError(422, 'invalid', `"${address.slice(0, 80)}" is not a valid email address.`, 'address')
  await db.exec(
    `INSERT INTO "ab"."mail_suppressions" (address, reason, note, added_by, added_on) VALUES ($1, $2, $3, $4, now()) ON CONFLICT (address) DO UPDATE SET reason = EXCLUDED.reason, note = EXCLUDED.note`,
    [a, reason, note?.slice(0, 500) ?? null, by],
  )
}

export async function removeSuppression(db: SqlDb, address: string): Promise<boolean> {
  return (await db.exec(`DELETE FROM "ab"."mail_suppressions" WHERE address = $1`, [address.trim().toLowerCase()])).affectedRows > 0
}
