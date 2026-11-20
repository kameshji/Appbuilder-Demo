/**
 * The install's licence client (hosting phase, package H-G; docs/dev/licensing.md, docs/admin/licensing.md).
 *
 * At start and every APPBUILDER_LICENCE_CHECK_HOURS (6) it sends the seat counts in use to the licence service and
 * stores the last VALID signed answer in ab.licence (document). From that answer and the clock it decides, at every
 * tick (1 minute) and after every check, whether the install is writable, and drives the read-only gate
 * (hosting/read-only.ts gate.setLicence):
 *
 *   - valid answer, status active                      -> writable
 *   - the service cannot be reached / refuses the key  -> writable until the last valid answer's valid-until (72 h after
 *                                                         it was issued), with a warning to administrators naming that
 *                                                         time; then read-only (reason licence)
 *   - never a valid answer since a licence was set up  -> 72 h from the first check, then read-only (reason licence)
 *   - status payment / suspended / cancelled           -> read-only (reason payment / suspended) from the answer's
 *                                                         readOnlyFrom (its notice); a warning before
 *   - status duplicate                                 -> read-only (reason licence) at once
 *   - the clock is earlier than the latest time seen by more than 5 minutes (stored high-water mark) -> read-only
 *     (reason licence) until a fresh valid answer
 *   - the next valid answer restores writing at once
 *   - no licence configured (no APPBUILDER_LICENCE_URL / _ID / _KEY) -> as before this package: writable, nothing sent
 *
 * Every time is the install's LOCAL clock: an answer's validity is anchored to the moment it was received
 * (receivedAt + validUntil - serverTime), so a server clock that is simply wrong neither shortens nor lengthens the
 * grace; moving the clock back is caught by the high-water mark, moving it forward only ends the grace sooner.
 *
 * Everything takes an injected clock, transport and store (client.test.ts drives the full 72-hour timeline without
 * sleeping). The timer is a plain interval (no job type: it writes no business data and must run while read-only).
 */
import fs from 'node:fs'
import {
  CLOCK_TOLERANCE_MS, GRACE_MS, INSTALL_ID_RE, INSTALL_KEY_RE, LICENCE_ID_RE, newInstallId, newNonce, shortId, verifyAnswer,
  type CheckRequest, type LicencePayload, type PassKind, type SeatCounts, type SignedAnswer, type TrustedLicenceKey,
} from './answer.ts'
import { errText, log } from '../util.ts'

export const DEFAULT_CHECK_HOURS = 6
export const DEFAULT_RETRY_MINUTES = 15
export const TICK_MS = 60_000
/** soft enforcement (spec 7): over the licensed count, 14 days of warnings, then no new assignments of that pass */
export const OVER_SEAT_GRACE_MS = 14 * 24 * 3600_000
const HIGH_WATER_PERSIST_MS = 60_000

/* ------------------------------------------------------------------ configuration */

export interface LicenceConfig {
  url: string | null
  licenceId: string | null
  /** the install key (secret; never logged) */
  key: string | null
  checkMs: number
  retryMs: number
  /** all three of url, id and key are set */
  configured: boolean
  problems: string[]
}

export function licenceConfig(env: NodeJS.ProcessEnv = process.env): LicenceConfig {
  const problems: string[] = []
  const url = env.APPBUILDER_LICENCE_URL?.trim() || null
  const licenceId = env.APPBUILDER_LICENCE_ID?.trim() || null
  let key = env.APPBUILDER_LICENCE_KEY?.trim() || null
  if (!key && env.APPBUILDER_LICENCE_KEY_FILE?.trim()) {
    try {
      key = fs.readFileSync(env.APPBUILDER_LICENCE_KEY_FILE.trim(), 'utf8').trim() || null
    } catch (e) {
      problems.push(`APPBUILDER_LICENCE_KEY_FILE cannot be read (${errText(e)}).`)
    }
  }
  if (url) {
    try {
      const u = new URL(url)
      const local = u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === 'localhost'
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) problems.push('APPBUILDER_LICENCE_URL must start with https:// (http:// only for 127.0.0.1 in tests).')
    } catch {
      problems.push('APPBUILDER_LICENCE_URL is not a web address.')
    }
  }
  if (licenceId && !LICENCE_ID_RE.test(licenceId)) problems.push('APPBUILDER_LICENCE_ID is not a licence id (lic_...).')
  if (key && !INSTALL_KEY_RE.test(key)) problems.push('The install key is not an Appbuilder install key (abl_...).')
  const any = !!(url || licenceId || key)
  const configured = !!(url && licenceId && key)
  if (any && !configured) problems.push('A licence needs all three settings: APPBUILDER_LICENCE_URL, APPBUILDER_LICENCE_ID and APPBUILDER_LICENCE_KEY (or _KEY_FILE).')
  const num = (v: string | undefined, d: number, min: number, max: number) => {
    const n = Number(v)
    return v && Number.isFinite(n) && n >= min && n <= max ? n : d
  }
  return {
    url: url ? url.replace(/\/+$/, '') : null, licenceId, key,
    checkMs: num(env.APPBUILDER_LICENCE_CHECK_HOURS, DEFAULT_CHECK_HOURS, 0.01, 24) * 3600_000,
    retryMs: num(env.APPBUILDER_LICENCE_RETRY_MINUTES, DEFAULT_RETRY_MINUTES, 0.1, 360) * 60_000,
    // a configuration with a problem still counts as configured when all three are present: a typo must not switch
    // the licence check off; it shows as a failing check with its grace
    configured, problems,
  }
}

/**
 * The clock: Date.now, plus (tests and the exit check only) the offset in milliseconds written in
 * APPBUILDER_LICENCE_TEST_CLOCK_FILE. The offset cannot extend the grace: a negative one is the clock moved back
 * (caught by the high-water mark), a positive one ends the grace sooner.
 */
export function licenceClock(env: NodeJS.ProcessEnv = process.env): () => number {
  const file = env.APPBUILDER_LICENCE_TEST_CLOCK_FILE?.trim()
  if (!file) return Date.now
  let cached = 0, readAt = -Infinity
  return () => {
    const t = Date.now()
    if (t - readAt > 500) {
      readAt = t
      try {
        const n = Number(fs.readFileSync(file, 'utf8').trim())
        cached = Number.isFinite(n) ? n : 0
      } catch {
        cached = 0
      }
    }
    return t + cached
  }
}

/* ------------------------------------------------------------------ stored state */

export interface StoredLicence {
  v: 1
  installId: string
  /** local ms of the first check with a licence configured (start of the grace while there was never a valid answer) */
  firstCheckAt: number | null
  /** the latest local time seen (monotonic high-water mark; only a fresh valid answer may lower it) */
  highWater: number
  /** the last VALID answer as received (signature verified again whenever it is used) */
  last: { answer: SignedAnswer; receivedAt: number } | null
  lastCheck: { at: number; ok: boolean; error: string | null } | null
  /** local ms of the first failed check since the last valid answer */
  failingSince: number | null
  /** per pass kind: since when more people hold it than the licence has seats (local ms) */
  overSince: Partial<Record<PassKind, number>>
  /** notifications already sent (key -> local ms), so each is sent once */
  notices: Record<string, number>
}

export function emptyStored(): StoredLicence {
  return { v: 1, installId: newInstallId(), firstCheckAt: null, highWater: 0, last: null, lastCheck: null, failingSince: null, overSince: {}, notices: {} }
}

export function parseStored(v: unknown): StoredLicence | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Partial<StoredLicence>
  if (o.v !== 1 || typeof o.installId !== 'string' || !INSTALL_ID_RE.test(o.installId)) return null
  const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
  return {
    v: 1, installId: o.installId, firstCheckAt: num(o.firstCheckAt), highWater: num(o.highWater) ?? 0,
    last: o.last && typeof o.last === 'object' && o.last.answer && num(o.last.receivedAt) !== null ? { answer: o.last.answer, receivedAt: o.last.receivedAt } : null,
    lastCheck: o.lastCheck && num(o.lastCheck.at) !== null ? { at: o.lastCheck.at, ok: !!o.lastCheck.ok, error: o.lastCheck.error ? String(o.lastCheck.error).slice(0, 300) : null } : null,
    failingSince: num(o.failingSince),
    overSince: o.overSince && typeof o.overSince === 'object' ? o.overSince : {},
    notices: o.notices && typeof o.notices === 'object' ? o.notices : {},
  }
}

export interface LicenceStore {
  load(): Promise<StoredLicence | null>
  save(s: StoredLicence): Promise<void>
}

export function memoryStore(initial: StoredLicence | null = null): LicenceStore & { value: StoredLicence | null } {
  const m = {
    value: initial ? structuredClone(initial) : null,
    async load() { return m.value ? structuredClone(m.value) : null },
    async save(s: StoredLicence) { m.value = structuredClone(s) },
  }
  return m
}

/* ------------------------------------------------------------------ evaluation (pure) */

export type LicenceMode = 'unlicensed' | 'ok' | 'warning' | 'read-only'
export type LicenceReadOnlyReason = 'licence' | 'payment' | 'suspended'

export interface LicenceView {
  configured: boolean
  mode: LicenceMode
  readOnly: { reason: LicenceReadOnlyReason; message: string; since: string } | null
  /** when the install becomes read-only if nothing changes (ISO, UTC), null when not planned */
  readOnlyAt: string | null
  warnings: string[]
  problems: string[]
  licence: {
    licenceId: string; status: LicencePayload['status']; plan: string | null; kind: LicencePayload['kind']; seats: SeatCounts | null
    paidUntil: string | null; maintenanceUntil: string | null; issuedAt: string; validUntil: string; receivedAt: string; message: string
  } | null
  lastCheck: { at: string; ok: boolean; error: string | null } | null
  installId: string | null
  clockBack: boolean
}

export const fmtUtc = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace(/:\d\d\.\d{3}Z$/, ' UTC')
const isoOf = (ms: number): string => new Date(ms).toISOString()

/** the last answer's signature checked again, and its local validity: receivedAt + (validUntil - serverTime), at most 72 h */
export function validLast(s: StoredLicence, keys: readonly TrustedLicenceKey[], licenceId: string | null): { p: LicencePayload; validUntilLocal: number; toLocal(iso: string): number } | null {
  if (!s.last) return null
  const r = verifyAnswer(s.last.answer, keys)
  if (!r.ok || r.payload.installId !== s.installId || (licenceId && r.payload.licenceId !== licenceId) || r.payload.status === 'refused') return null
  const server = Date.parse(r.payload.serverTime)
  const span = Math.min(GRACE_MS, Date.parse(r.payload.validUntil) - server)
  const toLocal = (iso: string) => s.last!.receivedAt + (Date.parse(iso) - server)
  return { p: r.payload, validUntilLocal: s.last.receivedAt + Math.max(0, span), toLocal }
}

export function evaluate(s: StoredLicence | null, cfg: LicenceConfig, keys: readonly TrustedLicenceKey[], now: number, extraProblems: string[] = []): LicenceView {
  const problems = [...cfg.problems, ...extraProblems]
  const base: LicenceView = { configured: cfg.configured, mode: 'unlicensed', readOnly: null, readOnlyAt: null, warnings: [], problems, licence: null, lastCheck: null, installId: s?.installId ?? null, clockBack: false }
  if (!cfg.configured) return base
  if (!keys.length) problems.push('This release has no licence public key, so no answer can be verified (set APPBUILDER_LICENCE_PUBLIC_KEY for a test or evaluation service).')
  const st = s ?? emptyStored()
  const v: LicenceView = { ...base, mode: 'ok', installId: st.installId }
  if (st.lastCheck) v.lastCheck = { at: isoOf(st.lastCheck.at), ok: st.lastCheck.ok, error: st.lastCheck.error }
  const last = validLast(st, keys, cfg.licenceId)
  if (last) {
    const p = last.p
    v.licence = {
      licenceId: p.licenceId, status: p.status, plan: p.plan, kind: p.kind, seats: p.seats, paidUntil: p.paidUntil, maintenanceUntil: p.maintenanceUntil,
      issuedAt: p.issuedAt, validUntil: isoOf(last.validUntilLocal), receivedAt: isoOf(st.last!.receivedAt), message: p.message,
    }
  }
  const ro = (reason: LicenceReadOnlyReason, message: string, since: number): LicenceView => ({ ...v, mode: 'read-only', readOnly: { reason, message, since: isoOf(since) }, readOnlyAt: isoOf(since) })

  // the clock moved back (more than 5 minutes behind the latest time seen): expired until a fresh answer
  if (st.highWater && now < st.highWater - CLOCK_TOLERANCE_MS) {
    v.clockBack = true
    return ro('licence', `The server clock (${fmtUtc(now)}) is earlier than a time this install has already seen (${fmtUtc(st.highWater)}). The licence counts as expired until the licence service answers again.`, now)
  }

  const failing = !!st.lastCheck && !st.lastCheck.ok
  if (!last) {
    // never a valid answer since a licence was set up: 72 hours from the first check
    const start = st.firstCheckAt ?? now
    const end = start + GRACE_MS
    if (now >= end) return ro('licence', `No valid licence answer since ${fmtUtc(start)}${st.lastCheck?.error ? ` (last check: ${st.lastCheck.error})` : ''}.`, end)
    v.mode = 'warning'
    v.readOnlyAt = isoOf(end)
    v.warnings.push(`The licence has not been verified yet${st.lastCheck?.error ? ` (${st.lastCheck.error})` : ''}. Appbuilder becomes read-only at ${fmtUtc(end)} unless a check succeeds before then.`)
    return v
  }
  const p = last.p
  if (now >= last.validUntilLocal) {
    return ro('licence', `The licence could not be verified since ${fmtUtc(st.last!.receivedAt)}${st.lastCheck?.error ? ` (last check: ${st.lastCheck.error})` : ''}.`, last.validUntilLocal)
  }
  if (p.status === 'duplicate') return ro('licence', p.message || 'Another install uses this licence; this one is the older. The operator can release it.', st.last!.receivedAt)
  if (p.status === 'payment' || p.status === 'suspended' || p.status === 'cancelled') {
    const reason: LicenceReadOnlyReason = p.status === 'payment' ? 'payment' : 'suspended'
    const from = p.readOnlyFrom ? last.toLocal(p.readOnlyFrom) : st.last!.receivedAt
    if (now >= from) return ro(reason, p.message, from)
    v.mode = 'warning'
    v.readOnlyAt = isoOf(from)
    v.warnings.push(`${p.message || (reason === 'payment' ? 'The subscription is unpaid.' : 'The licence was suspended by the operator.')} Appbuilder becomes read-only at ${fmtUtc(from)}.`)
  }
  if (failing) {
    v.mode = 'warning'
    if (!v.readOnlyAt || Date.parse(v.readOnlyAt) > last.validUntilLocal) v.readOnlyAt = isoOf(last.validUntilLocal)
    v.warnings.push(`The licence service could not be reached or refused the check since ${fmtUtc(st.failingSince ?? st.lastCheck!.at)} (${st.lastCheck!.error ?? 'no answer'}). Appbuilder keeps working on the last valid answer and becomes read-only at ${fmtUtc(last.validUntilLocal)} unless a check succeeds before then.`)
  }
  if (p.status === 'active' && p.paidUntil && p.kind === 'subscription' && Date.parse(p.paidUntil) < Date.parse(p.serverTime)) {
    v.warnings.push(`The subscription was paid until ${p.paidUntil.slice(0, 10)}.`)
  }
  return v
}

/* ------------------------------------------------------------------ accepting an answer */

export type AcceptResult = { ok: true; payload: LicencePayload } | { ok: false; error: string; refused?: boolean }

/** a fresh answer to the request just sent: signature, nonce, ids, times */
export function acceptAnswer(raw: unknown, req: CheckRequest, keys: readonly TrustedLicenceKey[]): AcceptResult {
  const r = verifyAnswer(raw, keys)
  if (!r.ok) {
    const why = { malformed: 'the answer is not a signed licence answer', 'untrusted-key': 'the answer is signed by a key this install does not trust', 'bad-signature': 'the answer\'s signature is not valid', 'bad-payload': 'the signed answer cannot be read' }[r.reason]
    return { ok: false, error: why }
  }
  const p = r.payload
  if (p.nonce !== req.nonce) return { ok: false, error: 'the answer belongs to another request (replayed or old answer)' }
  if (p.licenceId !== req.licenceId) return { ok: false, error: 'the answer is for another licence' }
  if (p.installId !== req.installId) return { ok: false, error: 'the answer is for another install' }
  const issued = Date.parse(p.issuedAt), until = Date.parse(p.validUntil), server = Date.parse(p.serverTime)
  if (Math.abs(server - issued) > 60_000 || until <= issued || until - issued > GRACE_MS + 60_000) return { ok: false, error: 'the answer\'s times are not consistent' }
  if (p.status === 'refused') return { ok: false, refused: true, error: p.message || 'the licence service refused this install key (unknown, revoked or of another licence)' }
  return { ok: true, payload: p }
}

/* ------------------------------------------------------------------ the client */

export type Transport = (url: string, body: CheckRequest, key: string) => Promise<unknown>

export const fetchTransport = (timeoutMs = 15_000): Transport => async (url, body, key) => {
  const res = await fetch(`${url}/v1/licence/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'User-Agent': 'Appbuilder-licence-client' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  })
  if (res.status === 429) throw new Error('the licence service is rate limiting this install (HTTP 429)')
  if (!res.ok && res.status !== 200) throw new Error(`the licence service answered HTTP ${res.status}`)
  const text = await res.text()
  if (text.length > 32_768) throw new Error('the licence service answer is too large')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('the licence service answer is not JSON')
  }
}

export interface LicenceEvents {
  /** the view changed its mode, warning or read-only state (notifications to administrators) */
  onChange?(view: LicenceView, prev: LicenceView | null, st: StoredLicence): Promise<void> | void
  /** a valid answer arrived (seats: over-seat tracking) */
  onAnswer?(p: LicencePayload, st: StoredLicence, now: number): Promise<void> | void
}

export interface LicenceClientDeps {
  config: LicenceConfig
  keys: readonly TrustedLicenceKey[]
  keyProblems?: string[]
  store: LicenceStore
  clock?: () => number
  transport?: Transport
  seats: () => Promise<SeatCounts>
  version: string
  /** the read-only gate (gate.setLicence) */
  setReadOnly(s: { reason: LicenceReadOnlyReason; message: string; since: string } | null): void
  events?: LicenceEvents
}

export interface LicenceClient {
  /** loads the stored state, applies it to the gate at once, checks, then checks on the interval */
  start(): Promise<void>
  stop(): void
  /** one check now (start, interval, the Admin console's "Check now"); never throws */
  check(): Promise<LicenceView>
  /** re-evaluates with the clock (the 1-minute tick); persists the high-water mark */
  tick(): Promise<LicenceView>
  view(): LicenceView
  /** the stored state (seats.ts reads overSince; tests) */
  stored(): StoredLicence | null
  update(fn: (s: StoredLicence) => void): Promise<void>
}

export function createLicenceClient(d: LicenceClientDeps): LicenceClient {
  const clock = d.clock ?? Date.now
  const transport = d.transport ?? fetchTransport()
  let st: StoredLicence | null = null
  let current: LicenceView = evaluate(null, d.config, d.keys, clock(), d.keyProblems)
  let savedHighWater = 0
  let checkTimer: ReturnType<typeof setTimeout> | null = null
  let tickTimer: ReturnType<typeof setInterval> | null = null
  let stopped = false
  let checking: Promise<LicenceView> | null = null
  let chain: Promise<unknown> = Promise.resolve()

  /** every state change runs one after the other (check, tick, update) */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => {})
    return next
  }

  async function ensure(): Promise<StoredLicence> {
    if (st) return st
    st = (await d.store.load().catch((e) => { log('warn', `licence state could not be read: ${errText(e)}`); return null })) ?? emptyStored()
    savedHighWater = st.highWater
    return st
  }

  async function persist(): Promise<void> {
    if (!st) return
    try {
      await d.store.save(st)
      savedHighWater = st.highWater
    } catch (e) {
      log('warn', `licence state could not be saved: ${errText(e)}`)
    }
  }

  async function apply(now: number): Promise<LicenceView> {
    const s = await ensure()
    const prev = current
    // the high-water mark only rises (a fresh valid answer resets it in check())
    if (!(s.highWater && now < s.highWater - CLOCK_TOLERANCE_MS) && now > s.highWater) s.highWater = now
    current = evaluate(s, d.config, d.keys, now, d.keyProblems)
    d.setReadOnly(current.readOnly)
    const changed = prev.mode !== current.mode || prev.readOnly?.reason !== current.readOnly?.reason || prev.readOnlyAt !== current.readOnlyAt || prev.warnings.join('|') !== current.warnings.join('|')
    if (changed && d.events?.onChange) {
      const before = JSON.stringify(s.notices)
      try {
        await d.events.onChange(current, prev, s)
      } catch (e) {
        log('warn', `licence notification failed: ${errText(e)}`)
      }
      if (JSON.stringify(s.notices) !== before) await persist()
    }
    return current
  }

  async function doCheck(): Promise<LicenceView> {
    const s = await ensure()
    if (!d.config.configured) return apply(clock())
    const sentAt = clock()
    if (s.firstCheckAt === null) s.firstCheckAt = sentAt
    let seats: SeatCounts
    try {
      seats = await d.seats()
    } catch (e) {
      log('warn', `licence check: seat counts unavailable (${errText(e)})`)
      seats = { full: 0, operator: 0, external: 0 }
    }
    const req: CheckRequest = { v: 1, licenceId: d.config.licenceId!, installId: s.installId, version: d.version, nonce: newNonce(), seats }
    let raw: unknown
    let error: string | null = null
    try {
      raw = await transport(d.config.url!, req, d.config.key!)
    } catch (e) {
      error = `the licence service could not be reached: ${errText(e).slice(0, 200)}`
    }
    const now = clock()
    if (!error) {
      const r = acceptAnswer(raw, req, d.keys)
      if (r.ok) {
        s.last = { answer: raw as SignedAnswer, receivedAt: now }
        s.lastCheck = { at: now, ok: true, error: null }
        s.failingSince = null
        // a fresh valid answer is the only thing that may lower the high-water mark (the clock was set back and the
        // service confirms the licence again)
        s.highWater = now
        log('info', `licence check: ${r.payload.status} (licence ${shortId(r.payload.licenceId)}, valid until ${r.payload.validUntil})`)
        if (d.events?.onAnswer) {
          try {
            await d.events.onAnswer(r.payload, s, now)
          } catch (e) {
            log('warn', `licence seats: ${errText(e)}`)
          }
        }
      } else error = r.error
    }
    if (error) {
      s.lastCheck = { at: now, ok: false, error }
      if (s.failingSince === null) s.failingSince = now
      log('warn', `licence check failed: ${error}`)
    }
    const view = await apply(now)
    await persist()
    return view
  }

  function schedule(): void {
    if (stopped || !d.config.configured) return
    if (checkTimer) clearTimeout(checkTimer)
    const ms = current.lastCheck && !current.lastCheck.ok ? d.config.retryMs : d.config.checkMs
    checkTimer = setTimeout(() => { void client.check().finally(schedule) }, ms)
    checkTimer.unref?.()
  }

  const client: LicenceClient = {
    async start() {
      stopped = false
      await serial(() => apply(clock()))
      if (!d.config.configured) return
      // the first check runs in the background: an unreachable service must not delay the start (the stored answer
      // already decided the state above)
      void client.check().finally(schedule)
      tickTimer = setInterval(() => { void client.tick() }, TICK_MS)
      tickTimer.unref?.()
    },
    stop() {
      stopped = true
      if (checkTimer) clearTimeout(checkTimer)
      if (tickTimer) clearInterval(tickTimer)
      checkTimer = tickTimer = null
    },
    check() {
      if (!checking) checking = serial(doCheck).finally(() => { checking = null })
      return checking
    },
    tick() {
      return serial(async () => {
        const v = await apply(clock())
        if (st && st.highWater - savedHighWater >= HIGH_WATER_PERSIST_MS) await persist()
        return v
      })
    },
    view: () => current,
    stored: () => st,
    update(fn) {
      return serial(async () => {
        fn(await ensure())
        await persist()
      })
    },
  }
  return client
}
