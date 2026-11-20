/**
 * Personal pinned tiles ("My dashboard" on the User mode launcher and the Dev home; docs/dev/dashboards.md "Pinned
 * tiles"). A person pins a tile of a dashboard they can open; the list is theirs only and is kept like other per-user
 * settings in ab.user_settings (no table of its own; key `dashboard-pins:<environment id>`, since dashboards belong to an
 * environment). Only ids are stored: the tile is always read from the stored dashboard, and the data is computed in the
 * browser through the normal batch endpoint as the viewer, so a pin never widens anything.
 *
 *   GET /dashboards/pins     the caller's pins, in order. A pin whose dashboard or tile is gone, or whose dashboard the
 *                            caller can no longer open, is `{ dashboardId, tileId, available: false }` and nothing else
 *                            (not even whether the dashboard exists).
 *   PUT /dashboards/pins     { items: [{ dashboardId, tileId }] } (at most MAX_PINS): the whole list (pin, unpin, reorder).
 *                            A pin that is NOT already in the caller's list must name a tile of a dashboard the caller can
 *                            open (404 otherwise, the same answer for "missing" and "not yours to see"); pins already in
 *                            the list are kept as they are, so a person can still reorder or remove "no longer available" ones.
 *
 * There is no way to read or change another person's pins: both routes act on ctx.user only.
 */
import type { ApiRouter } from '../router.ts'
import type { CoreServices } from '../services.ts'
import type { SqlDb, UserContext } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import type { RangePreset } from '../../../src/dashboards/dates.ts'
import type { TileDef } from '../../../src/dashboards/types.ts'
import { currentEnvironment } from '../env-context.ts'
import { canView, dashboardRow } from './compute.ts'

export const MAX_PINS = 24
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/

export interface PinRef { dashboardId: string; tileId: string }
export type PinView =
  | { dashboardId: string; tileId: string; available: true; dashboardName: string; range: RangePreset; tile: TileDef }
  | { dashboardId: string; tileId: string; available: false }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const keyOf = () => `dashboard-pins:${currentEnvironment().id}`

/** the body of PUT /dashboards/pins -> a clean list (ids only, no duplicates, at most MAX_PINS); throws 422 */
export function checkPins(raw: unknown): PinRef[] {
  const items = isObj(raw) ? raw.items : undefined
  if (!Array.isArray(items)) throw new HttpError(422, 'invalid', 'items is a list of { dashboardId, tileId }.', 'items')
  if (items.length > MAX_PINS) throw new HttpError(422, 'invalid', `You can pin at most ${MAX_PINS} tiles.`, 'items')
  const seen = new Set<string>()
  const out: PinRef[] = []
  for (const x of items) {
    const o = isObj(x) ? x : {}
    const dashboardId = typeof o.dashboardId === 'string' ? o.dashboardId : ''
    const tileId = typeof o.tileId === 'string' ? o.tileId : ''
    if (!ID_RE.test(dashboardId) || !ID_RE.test(tileId)) throw new HttpError(422, 'invalid', 'A pin is { dashboardId, tileId } (ids of letters, digits, - or _).', 'items')
    const k = `${dashboardId}\u0000${tileId}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ dashboardId, tileId })
  }
  return out
}

/** the stored list (tolerant: anything malformed in storage is dropped) */
export async function readPins(db: SqlDb, userId: string): Promise<PinRef[]> {
  const r = await db.query<{ value: unknown }>(`SELECT value FROM "ab"."user_settings" WHERE user_id = $1 AND key = $2`, [userId, keyOf()])
  const v = r[0]?.value
  try { return checkPins(isObj(v) ? v : { items: [] }) } catch { return [] }
}

async function writePins(db: SqlDb, userId: string, items: PinRef[]): Promise<void> {
  await db.exec(
    `INSERT INTO "ab"."user_settings" (user_id, key, value, modified_on) VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, modified_on = EXCLUDED.modified_on`,
    [userId, keyOf(), JSON.stringify({ items })],
  )
}

/** each pin resolved for `who`: the tile of a dashboard they can open, or "not available" with nothing else */
export async function resolvePins(db: SqlDb, who: UserContext, items: PinRef[]): Promise<PinView[]> {
  const dashes = new Map<string, Awaited<ReturnType<typeof dashboardRow>>>()
  const out: PinView[] = []
  for (const p of items) {
    if (!dashes.has(p.dashboardId)) dashes.set(p.dashboardId, await dashboardRow(db, p.dashboardId))
    const d = dashes.get(p.dashboardId)
    const tile = d && canView(who, d) ? d.def.tiles.find((t) => t.id === p.tileId) : undefined
    out.push(d && tile ? { dashboardId: p.dashboardId, tileId: p.tileId, available: true, dashboardName: d.name, range: d.def.range, tile } : { dashboardId: p.dashboardId, tileId: p.tileId, available: false })
  }
  return out
}

export function pinRoutes(router: ApiRouter, services: CoreServices): void {
  const db = () => {
    const d = services.state.db
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }

  router.add('GET', '/dashboards/pins', async (ctx) => {
    const me = ctx.user!
    return { items: await resolvePins(db(), me, await readPins(db(), me.user.id)), max: MAX_PINS }
  }, { auth: 'user' })

  router.add('PUT', '/dashboards/pins', async (ctx) => {
    const me = ctx.user!
    const next = checkPins(ctx.body)
    const had = new Set((await readPins(db(), me.user.id)).map((p) => `${p.dashboardId}\u0000${p.tileId}`))
    for (const p of next) {
      if (had.has(`${p.dashboardId}\u0000${p.tileId}`)) continue
      // a new pin: a tile of a dashboard I can open (one answer for "missing" and "not mine to see")
      const d = await dashboardRow(db(), p.dashboardId)
      if (!d || !canView(me, d) || !d.def.tiles.some((t) => t.id === p.tileId)) throw new HttpError(404, 'not-found', 'Tile not found.')
    }
    await writePins(db(), me.user.id, next)
    return { items: await resolvePins(db(), me, next), max: MAX_PINS }
  }, { auth: 'user' })
}
