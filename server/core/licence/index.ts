/**
 * The licence client and seat passes inside the product server (H-G client, H-H): wiring, the ab.licence store and the
 * Admin console's routes (docs/dev/licensing.md).
 *
 *   GET  /api/v1/install/licence            administrators: the licence state, warnings, seats (Admin console > Licence)
 *   POST /api/v1/install/licence/check      install administrators: check now (works while read-only: the retry)
 *   GET  /api/v1/install/licence/passes     administrators: every person's pass and the seat state
 *   PUT  /api/v1/install/licence/passes     install administrators: { userIds, pass } (bulk; audited licence.pass_assign)
 *
 * Started by createApp (app.ts startLicence) once the database is ready; stopped by app.close().
 */
import type { Router, SqlDb } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import type { CoreServices } from '../services.ts'
import { serverVersion } from '../auth.ts'
import { readOnlyGateFor } from '../hosting/read-only.ts'
import { errText, log } from '../util.ts'
import { PASS_KINDS, type PassKind } from './answer.ts'
import { createLicenceClient, evaluate, fmtUtc, licenceClock, licenceConfig, parseStored, validLast, OVER_SEAT_GRACE_MS, type LicenceClient, type LicenceConfig, type LicenceStore, type LicenceView, type StoredLicence, type Transport } from './client.ts'
import { licenceKeys } from './keys.ts'
import { ASSIGNABLE, PASS_LABEL, assignPasses, listPasses, seatCounts, seatState, trackOver, type SeatState } from './seats.ts'
import type { TrustedLicenceKey } from './answer.ts'

/* ------------------------------------------------------------------ the store: ab.licence (one row, id 1) */

export function dbStore(db: () => SqlDb | null): LicenceStore {
  return {
    async load() {
      const d = db()
      if (!d) throw new Error('no database')
      const r = await d.query<{ document: unknown }>(`SELECT document FROM "ab"."licence" WHERE id = 1`)
      return parseStored(r[0]?.document)
    },
    async save(s) {
      const d = db()
      if (!d) throw new Error('no database')
      await d.exec(`INSERT INTO "ab"."licence" (id, document, installed_on) VALUES (1, $1::jsonb, now()) ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document`, [JSON.stringify(s)])
    },
  }
}

/* ------------------------------------------------------------------ one client per install */

interface Running { client: LicenceClient; config: LicenceConfig; keys: readonly TrustedLicenceKey[]; keySource: string; clock: () => number; retry?: ReturnType<typeof setInterval> }
const running = new WeakMap<object, Running>()

export interface StartLicenceOptions {
  env?: NodeJS.ProcessEnv
  /** tests: an injected clock and transport */
  clock?: () => number
  transport?: Transport
}

export function licenceFor(services: object): LicenceClient | null {
  return running.get(services)?.client ?? null
}

async function installAdmins(db: SqlDb): Promise<string[]> {
  return (await db.query<{ id: string }>(`SELECT id FROM "ab"."users" WHERE is_install_admin AND status <> 'disabled' AND kind <> 'service'`)).map((r) => r.id)
}

async function notifyAdmins(services: CoreServices, st: StoredLicence, key: string, now: number, title: string, body: string): Promise<void> {
  if (st.notices[key]) return
  st.notices[key] = now
  // keep the notice list short (the newest 50)
  const keys = Object.keys(st.notices)
  if (keys.length > 50) for (const k of keys.sort((a, b) => st.notices[a] - st.notices[b]).slice(0, keys.length - 50)) delete st.notices[k]
  const db = services.state.db
  if (!db || !services.notifications) return
  const ids = await installAdmins(db)
  if (ids.length) await services.notifications.notify({ userIds: ids }, { kind: 'system', title, body, link: '#admin-licences', source: 'system', environmentId: null })
}

/** starts (or restarts) the licence client of these services; returns it */
export function startLicence(services: CoreServices, o: StartLicenceOptions = {}): LicenceClient {
  stopLicence(services)
  const env = o.env ?? process.env
  const config = licenceConfig(env)
  const k = licenceKeys(env)
  const clock = o.clock ?? licenceClock(env)
  const gate = readOnlyGateFor(services)
  const client = createLicenceClient({
    config, keys: k.keys, keyProblems: k.problems, clock, transport: o.transport,
    store: dbStore(() => services.state.db),
    seats: async () => (services.state.db ? seatCounts(services.state.db) : { full: 0, operator: 0, external: 0 }),
    version: serverVersion(),
    setReadOnly: (s) => gate.setLicence(s),
    events: {
      async onChange(view, prev, st) {
        const now = clock()
        if (view.mode === 'read-only' && view.readOnly) {
          await notifyAdmins(services, st, `ro:${view.readOnly.reason}:${view.readOnly.since}`, now, 'Appbuilder is read-only (licence)', `${view.readOnly.message} Sign-in, reading and export still work. See Admin console > Licences.`)
        } else if (view.mode === 'warning' && view.readOnlyAt) {
          await notifyAdmins(services, st, `warn:${view.readOnlyAt}`, now, `Licence: Appbuilder becomes read-only at ${fmtUtc(Date.parse(view.readOnlyAt))}`, view.warnings.join(' '))
        } else if (prev?.mode === 'read-only' && (view.mode === 'ok' || view.mode === 'warning')) {
          await notifyAdmins(services, st, `back:${now}`, now, 'Appbuilder is writable again', 'The licence was verified; changes are possible again.')
        }
      },
      async onAnswer(p, st, now) {
        const db = services.state.db
        if (!db) return
        const inUse = await seatCounts(db)
        trackOver(st.overSince, inUse, p.seats, now)
        const s = seatState(inUse, p.seats, st.overSince, now, OVER_SEAT_GRACE_MS)
        for (const kind of PASS_KINDS) {
          const x = s.over[kind]
          if (!x) continue
          await notifyAdmins(services, st, `over:${kind}:${x.since}`, now, `More ${PASS_LABEL[kind]} passes than licensed seats`, `${inUse[kind]} people hold a ${PASS_LABEL[kind]} pass; the licence has ${p.seats?.[kind] ?? 0}. Nobody is locked out; from ${fmtUtc(Date.parse(x.blockedFrom))} no new ${PASS_LABEL[kind]} passes can be assigned until the counts fit.`)
          if (x.blocked) await notifyAdmins(services, st, `blocked:${kind}:${x.since}`, now, `New ${PASS_LABEL[kind]} passes are blocked`, `The ${PASS_LABEL[kind]} seats have been over the licence for 14 days. People who hold the pass keep it.`)
        }
      },
    },
  })
  const r: Running = { client, config, keys: k.keys, keySource: k.source, clock }
  running.set(services, r)
  const begin = () => client.start().catch((e) => log('warn', `licence client did not start: ${errText(e)}`))
  if (services.ready()) void begin()
  else {
    // the database comes later (unreachable at start): start once it is there
    r.retry = setInterval(() => {
      if (!services.ready()) return
      clearInterval(r.retry)
      r.retry = undefined
      void begin()
    }, 30_000)
    r.retry.unref?.()
  }
  return client
}

export function stopLicence(services: object): void {
  const r = running.get(services)
  if (!r) return
  if (r.retry) clearInterval(r.retry)
  r.client.stop()
  running.delete(services)
}

/* ------------------------------------------------------------------ seats against the licence */

async function seatsNow(services: CoreServices): Promise<SeatState | null> {
  const db = services.state.db
  if (!db) return null
  const r = running.get(services)
  const inUse = await seatCounts(db)
  const st = r?.client.stored() ?? null
  const last = st && r ? validLast(st, r.keys, r.config.licenceId) : null
  const licensed = last?.p.seats ?? null
  return seatState(inUse, licensed, st?.overSince ?? {}, r?.clock() ?? Date.now(), OVER_SEAT_GRACE_MS)
}

function blockedReason(s: SeatState | null): (k: PassKind) => string | null {
  return (k) => {
    const x = s?.over[k]
    if (!x || !x.blocked) return null
    return `The ${PASS_LABEL[k]} seats have been over the licence since ${x.since.slice(0, 10)} (${x.by} more than licensed): no new ${PASS_LABEL[k]} passes until the counts fit (change another person's pass, disable an account, or ask for more seats). Nobody who holds a pass loses it.`
  }
}

/* ------------------------------------------------------------------ routes */

function viewFor(services: CoreServices): LicenceView & { keySource: string } {
  const r = running.get(services)
  if (r) return { ...r.client.view(), keySource: r.keySource }
  const env = process.env
  return { ...evaluate(null, licenceConfig(env), licenceKeys(env).keys, Date.now()), keySource: licenceKeys(env).source }
}

const requireInstallAdmin = (u: { privileges: { isInstallAdmin?: boolean } } | undefined) => {
  if (!u?.privileges.isInstallAdmin) throw new HttpError(403, 'denied', 'Only install administrators can do this.')
}

export function licenceRoutes(router: Router, services: CoreServices): void {
  router.add('GET', '/install/licence', async () => {
    const v = viewFor(services)
    return { licence: v, seats: await seatsNow(services), overSeatGraceDays: OVER_SEAT_GRACE_MS / 86_400_000 }
  }, { auth: 'admin', noEnvironment: true })

  router.add('POST', '/install/licence/check', async (ctx) => {
    requireInstallAdmin(ctx.user)
    const c = licenceFor(services)
    const v = c ? await c.check() : viewFor(services)
    return { licence: { ...v, keySource: running.get(services)?.keySource ?? 'built-in' }, seats: await seatsNow(services) }
  }, { auth: 'admin', noEnvironment: true })

  router.add('GET', '/install/licence/passes', async () => {
    const db = services.state.db
    if (!db) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    const list = await listPasses(db)
    return {
      passes: Object.fromEntries(list.map((p) => [p.userId, p.pass])),
      assignable: ASSIGNABLE, labels: PASS_LABEL, seats: await seatsNow(services),
    }
  }, { auth: 'admin', noEnvironment: true })

  router.add('PUT', '/install/licence/passes', async (ctx) => {
    requireInstallAdmin(ctx.user)
    const b = (ctx.body ?? {}) as { userIds?: unknown; pass?: unknown }
    if (!Array.isArray(b.userIds)) throw new HttpError(400, 'invalid', 'userIds is a list of user ids.', 'userIds')
    const before = await seatsNow(services)
    const out = await assignPasses(services, ctx.user!.user.id, b.userIds as string[], b.pass, blockedReason(before))
    // the over-seat clock follows the new counts at once (it is also updated at every check)
    const c = licenceFor(services)
    const r = running.get(services)
    if (c && r && services.state.db) {
      const inUse = await seatCounts(services.state.db)
      const st = c.stored()
      const last = st ? validLast(st, r.keys, r.config.licenceId) : null
      await c.update((s) => { trackOver(s.overSince, inUse, last?.p.seats ?? null, r.clock()) })
    }
    return { ...out, seats: await seatsNow(services) }
  }, { auth: 'admin', noEnvironment: true })
}
