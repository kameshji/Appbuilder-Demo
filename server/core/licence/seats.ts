/**
 * Seat passes (hosting phase, package H-H; docs/admin/licensing.md "Passes", docs/dev/licensing.md).
 *
 * Every person (not service accounts) holds one pass kind, assigned by an install administrator:
 *   full      everything (default; every existing user on upgrade, so nothing changes for anyone)
 *   operator  runs apps (web and phone), approvals, dashboards, tasks, chat, notes, data the roles allow; NOT Dev mode:
 *             no Studio, data model, flow designer, solutions, templates, print template design or any route a
 *             maker needs (auth 'maker', DESIGN_ROUTES, pass: 'full')
 *   external  reserved for external sites (Phase 6): counted, not assignable yet; treated like operator if it ever
 *             appears
 *
 * Stored in ab.user_settings (key `licence.pass`, value { pass, assignedOn, assignedBy }): no install-level schema
 * change. A user without the row holds a Full user pass.
 *
 * Enforced on the server only:
 *   - withPasses(resolver): the session resolver returns privileges.isMaker = false for a non-full pass, so every
 *     `auth: 'maker'` route and every handler that checks isMaker refuses, and the client hides Dev mode;
 *   - passRefusal (router.ts): DESIGN_ROUTES and routes flagged `pass: 'full'` refuse a non-full pass even for an
 *     administrator (403 pass_required).
 * Soft enforcement: more holders than licensed seats -> warnings to administrators for 14 days, then new assignments
 * of that kind are refused; nobody already holding a pass loses it or is locked out.
 */
import type { RouteOptions, SqlDb, UserContext } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import type { CoreServices } from '../services.ts'
import { PASS_KINDS, type PassKind, type SeatCounts } from './answer.ts'

export const PASS_KEY = 'licence.pass'
export const ASSIGNABLE: readonly PassKind[] = ['full', 'operator']
export const PASS_LABEL: Record<PassKind, string> = { full: 'Full user', operator: 'Operator', external: 'External' }
export const PASS_CACHE_MS = 5000

const isPass = (v: unknown): v is PassKind => typeof v === 'string' && (PASS_KINDS as readonly string[]).includes(v)

/* ------------------------------------------------------------------ reading */

/** every person's pass (people only; disabled users included, flagged) */
export async function listPasses(db: SqlDb): Promise<{ userId: string; pass: PassKind; active: boolean; assignedOn: string | null }[]> {
  const rows = await db.query<{ id: string; status: string; value: { pass?: unknown; assignedOn?: unknown } | null }>(
    `SELECT u.id, u.status, s.value FROM "ab"."users" u
       LEFT JOIN "ab"."user_settings" s ON s.user_id = u.id AND s.key = $1
      WHERE u.kind <> 'service' ORDER BY u.id`,
    [PASS_KEY],
  )
  return rows.map((r) => ({
    userId: r.id, pass: isPass(r.value?.pass) ? r.value!.pass : 'full', active: r.status !== 'disabled',
    assignedOn: typeof r.value?.assignedOn === 'string' ? r.value.assignedOn : null,
  }))
}

/** seats in use: active people (not disabled, not service accounts; invited people count) per pass kind */
export async function seatCounts(db: SqlDb): Promise<SeatCounts> {
  const c: SeatCounts = { full: 0, operator: 0, external: 0 }
  for (const p of await listPasses(db)) if (p.active) c[p.pass]++
  return c
}

const caches = new WeakMap<object, Map<string, { pass: PassKind; at: number }>>()
const cacheOf = (s: object) => {
  let m = caches.get(s)
  if (!m) caches.set(s, (m = new Map()))
  return m
}

export async function passOf(services: CoreServices, userId: string, now = Date.now()): Promise<PassKind> {
  const m = cacheOf(services)
  const hit = m.get(userId)
  if (hit && now - hit.at < PASS_CACHE_MS) return hit.pass
  const db = services.state.db
  if (!db) return 'full'
  const r = await db.query<{ value: { pass?: unknown } }>(`SELECT value FROM "ab"."user_settings" WHERE user_id = $1 AND key = $2`, [userId, PASS_KEY])
  const pass: PassKind = isPass(r[0]?.value?.pass) ? r[0].value.pass : 'full'
  if (m.size > 5000) m.clear()
  m.set(userId, { pass, at: now })
  return pass
}

/* ------------------------------------------------------------------ enforcement */

export const PASS_REQUIRED_MESSAGE = 'Your pass is Operator: building (Dev mode, Studio, data model, flows, solutions) needs a Full user pass. Ask an administrator.'

/**
 * the session resolver with passes: privileges.isMaker is false for a person without a Full user pass, and the pass
 * travels on the user context (ctx.user.pass) for passRefusal
 */
export function withPasses<A extends unknown[]>(services: CoreServices, resolve: (...a: A) => Promise<UserContext | null>): (...a: A) => Promise<UserContext | null> {
  return async (...a: A) => {
    const u = await resolve(...a)
    if (!u || u.user.kind === 'service') return u
    const pass = await passOf(services, u.user.id)
    u.pass = pass
    if (pass !== 'full' && u.privileges.isMaker) {
      u.privileges = { ...u.privileges, isMaker: false }
      // the session the client reads (GET /auth/session) shows the same: Dev mode is hidden for an Operator
      const session = u.session.bind(u)
      u.session = () => {
        const s = session()
        return { ...s, privileges: { ...s.privileges, isMaker: false } }
      }
    }
    return u
  }
}

/** router.ts: design routes and `pass: 'full'` routes need a Full user pass (also for administrators) */
export function passRefusal(opts: RouteOptions, method: string, user: UserContext): HttpError | null {
  if (!user.pass || user.pass === 'full') return null
  if (opts.pass === 'full' || (opts.design && method !== 'GET') || opts.auth === 'maker') return new HttpError(403, 'denied', PASS_REQUIRED_MESSAGE)
  return null
}

/* ------------------------------------------------------------------ assigning */

export interface AssignOutcome { changed: string[]; unchanged: string[] }

/**
 * sets the pass of these people (install administrators; audited). Refused: external (not assignable yet), service
 * accounts, unknown ids, and a kind whose seats have been over the licence for longer than 14 days (blocked) unless
 * the person already holds it.
 */
export async function assignPasses(
  services: CoreServices, actorId: string, userIds: string[], pass: unknown, blocked: (k: PassKind) => string | null,
): Promise<AssignOutcome> {
  if (!isPass(pass)) throw new HttpError(400, 'invalid', 'The pass is full or operator.', 'pass')
  if (pass === 'external') throw new HttpError(400, 'invalid', 'External passes arrive with external sites (a later phase): nobody can be given one yet.', 'pass')
  const ids = [...new Set(userIds.map(String))]
  if (!ids.length || ids.length > 1000) throw new HttpError(400, 'invalid', 'Choose between 1 and 1000 people.', 'userIds')
  const db = services.state.db
  if (!db) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
  const current = new Map((await listPasses(db)).map((p) => [p.userId, p.pass]))
  const unknown = ids.filter((id) => !current.has(id))
  if (unknown.length) throw new HttpError(404, 'not-found', `Not a person of this install: ${unknown.slice(0, 3).join(', ')}.`)
  const toChange = ids.filter((id) => current.get(id) !== pass)
  const why = toChange.length ? blocked(pass) : null
  if (why) throw new HttpError(409, 'conflict', why)
  const at = new Date().toISOString()
  await db.tx(async (tx) => {
    for (const id of toChange) {
      if (pass === 'full') await tx.exec(`DELETE FROM "ab"."user_settings" WHERE user_id = $1 AND key = $2`, [id, PASS_KEY])
      else {
        await tx.exec(
          `INSERT INTO "ab"."user_settings" (user_id, key, value, modified_on) VALUES ($1, $2, $3::jsonb, now())
           ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, modified_on = EXCLUDED.modified_on`,
          [id, PASS_KEY, JSON.stringify({ pass, assignedOn: at, assignedBy: actorId })],
        )
      }
    }
    if (toChange.length) {
      await tx.exec(`INSERT INTO "ab"."audit" (at, user_id, action, environment_id, details) VALUES ($1, $2, 'licence.pass_assign', NULL, $3::jsonb)`, [
        new Date(), actorId, JSON.stringify({ pass, users: toChange.slice(0, 200), count: toChange.length, from: Object.fromEntries(toChange.slice(0, 200).map((id) => [id, current.get(id)])) }),
      ])
    }
  })
  const m = cacheOf(services)
  for (const id of toChange) m.delete(id)
  return { changed: toChange, unchanged: ids.filter((id) => !toChange.includes(id)) }
}

/* ------------------------------------------------------------------ over the licence */

export interface SeatState {
  inUse: SeatCounts
  licensed: SeatCounts | null
  /** per kind: over since (ISO), blocked from (ISO: over since + 14 days), blocked now */
  over: Partial<Record<PassKind, { since: string; blockedFrom: string; blocked: boolean; by: number }>>
}

/** updates overSince (local ms per kind) from counts and the licensed seats; returns whether it changed */
export function trackOver(overSince: Partial<Record<PassKind, number>>, inUse: SeatCounts, licensed: SeatCounts | null, now: number): boolean {
  let changed = false
  for (const k of PASS_KINDS) {
    const over = !!licensed && inUse[k] > licensed[k]
    if (over && overSince[k] === undefined) {
      overSince[k] = now
      changed = true
    } else if (!over && overSince[k] !== undefined) {
      delete overSince[k]
      changed = true
    }
  }
  return changed
}

export function seatState(inUse: SeatCounts, licensed: SeatCounts | null, overSince: Partial<Record<PassKind, number>>, now: number, graceMs: number): SeatState {
  const over: SeatState['over'] = {}
  for (const k of PASS_KINDS) {
    const since = overSince[k]
    if (since === undefined || !licensed || inUse[k] <= licensed[k]) continue
    over[k] = { since: new Date(since).toISOString(), blockedFrom: new Date(since + graceMs).toISOString(), blocked: now >= since + graceMs, by: inUse[k] - licensed[k] }
  }
  return { inUse, licensed, over }
}
