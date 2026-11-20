/**
 * The licence client with an injected clock and an in-process fake licence service (exit check 6, the unit part):
 * the full 72-hour grace timeline, clock rollback, suspension and payment with notice, duplicate, and every kind of
 * answer that must be refused. No database, no network, no sleeping. Keys are generated here, at test time.
 */
import { describe, expect, it } from 'vitest'
import {
  GRACE_MS, generateLicenceKey, loadSigningKey, signAnswer, trustedLicenceKey,
  type CheckRequest, type LicencePayload, type SignedAnswer,
} from './answer.ts'
import { createLicenceClient, emptyStored, evaluate, licenceConfig, memoryStore, type LicenceClient, type LicenceReadOnlyReason, type Transport } from './client.ts'

const H = 3600_000
const PASS = 'test-passphrase-only'
const k1 = generateLicenceKey(PASS)
const k2 = generateLicenceKey(PASS)
const signer = loadSigningKey(k1.privatePem, PASS)
const other = loadSigningKey(k2.privatePem, PASS)
const trusted = [trustedLicenceKey(k1.publicPem)]
const LIC = 'lic_testorg01'
const KEY = 'abl_' + 'x'.repeat(43)
const env = { APPBUILDER_LICENCE_URL: 'http://127.0.0.1:1', APPBUILDER_LICENCE_ID: LIC, APPBUILDER_LICENCE_KEY: KEY }

/** the fake service: answers like the real one; `mode` changes what it does */
function fakeService(clock: () => number) {
  const s = {
    mode: 'ok' as 'ok' | 'down' | 'forge' | 'otherKey' | 'replay' | 'otherOrg' | 'refused',
    status: 'active' as LicencePayload['status'],
    readOnlyFrom: null as string | null,
    seats: { full: 5, operator: 20, external: 0 },
    lastSeats: null as CheckRequest['seats'] | null,
    old: null as SignedAnswer | null,
    calls: 0,
  }
  const transport: Transport = async (_url, req, key) => {
    s.calls++
    s.lastSeats = req.seats
    if (s.mode === 'down') throw new Error('connect ECONNREFUSED 127.0.0.1:1')
    const now = clock()
    const t = new Date(now).toISOString()
    const p: LicencePayload = {
      v: 1, licenceId: s.mode === 'otherOrg' ? 'lic_someoneelse' : req.licenceId, installId: req.installId,
      status: s.mode === 'refused' || key !== KEY ? 'refused' : s.status, plan: 'standard', kind: 'subscription', seats: s.seats,
      paidUntil: new Date(now + 30 * 24 * H).toISOString(), maintenanceUntil: null, noticeDays: 2, readOnlyFrom: s.readOnlyFrom,
      message: s.status === 'suspended' ? 'Suspended for a test.' : '', issuedAt: t, validUntil: new Date(now + GRACE_MS).toISOString(), serverTime: t, nonce: req.nonce,
    }
    const a = signAnswer(p, s.mode === 'otherKey' ? other : signer)
    if (s.mode === 'forge') {
      const body = JSON.parse(Buffer.from(a.payload, 'base64').toString('utf8')) as LicencePayload
      body.seats = { full: 999, operator: 999, external: 999 }
      return { ...a, payload: Buffer.from(JSON.stringify(body)).toString('base64') }
    }
    if (s.mode === 'replay') return s.old
    if (s.mode === 'ok' && s.status === 'active') s.old = a
    return a
  }
  return { s, transport }
}

function setup(start = Date.UTC(2026, 10, 21, 9, 0, 0)) {
  let now = start
  const clock = () => now
  const svc = fakeService(clock)
  const store = memoryStore()
  const gate: { state: { reason: LicenceReadOnlyReason; message: string; since: string } | null } = { state: null }
  const make = (): LicenceClient => createLicenceClient({
    config: licenceConfig(env), keys: trusted, store, clock, transport: svc.transport, version: '0.8.0-test',
    seats: async () => ({ full: 2, operator: 7, external: 0 }), setReadOnly: (s) => { gate.state = s },
  })
  return { at: (ms: number) => { now = ms }, now: () => now, start, svc, store, gate, make }
}

describe('licence client: the 72-hour grace (exit check 6)', () => {
  it('valid -> service unreachable (warning with the exact time) -> read-only at 72 h -> clock back stays read-only -> service back writable', async () => {
    const t = setup()
    const c = t.make()
    let v = await c.check()
    expect(v.mode).toBe('ok')
    expect(t.gate.state).toBeNull()
    expect(t.svc.s.lastSeats).toEqual({ full: 2, operator: 7, external: 0 })
    expect(v.licence?.seats).toEqual({ full: 5, operator: 20, external: 0 })

    // the service goes away one hour later
    t.svc.s.mode = 'down'
    t.at(t.start + H)
    v = await c.check()
    expect(v.mode).toBe('warning')
    expect(v.readOnlyAt).toBe(new Date(t.start + GRACE_MS).toISOString())
    expect(v.warnings.join(' ')).toContain('2026-11-24 09:00 UTC')
    expect(t.gate.state).toBeNull()

    // still writable one minute before the end
    t.at(t.start + GRACE_MS - 60_000)
    expect((await c.tick()).readOnly).toBeNull()
    // read-only at exactly 72 hours after the last valid answer
    t.at(t.start + GRACE_MS)
    v = await c.tick()
    expect(v.mode).toBe('read-only')
    expect(t.gate.state?.reason).toBe('licence')
    expect(t.gate.state?.since).toBe(new Date(t.start + GRACE_MS).toISOString())

    // moving the clock back into the window does not restore writing
    t.at(t.start + 10 * H)
    v = await c.tick()
    expect(v.mode).toBe('read-only')
    expect(v.clockBack).toBe(true)
    expect(t.gate.state?.reason).toBe('licence')
    // nor does a restart with the clock still back (the high-water mark is stored)
    const c2 = t.make()
    expect((await c2.tick()).mode).toBe('read-only')

    // the service answers again: writable at once (also with the clock where it is)
    t.svc.s.mode = 'ok'
    v = await c2.check()
    expect(v.mode).toBe('ok')
    expect(t.gate.state).toBeNull()
  })

  it('a clock moved back while everything is fine is caught too (more than 5 minutes)', async () => {
    const t = setup()
    const c = t.make()
    await c.check()
    t.at(t.start + 5 * H)
    await c.tick()
    t.at(t.start + 5 * H - 4 * 60_000) // 4 minutes back: tolerated
    expect((await c.tick()).mode).toBe('ok')
    t.at(t.start + 4 * H) // an hour back
    expect((await c.tick()).mode).toBe('read-only')
  })

  it('never a valid answer: 72 hours from the first check, then read-only', async () => {
    const t = setup()
    t.svc.s.mode = 'down'
    const c = t.make()
    let v = await c.check()
    expect(v.mode).toBe('warning')
    expect(v.readOnlyAt).toBe(new Date(t.start + GRACE_MS).toISOString())
    t.at(t.start + GRACE_MS + 1)
    v = await c.check()
    expect(v.mode).toBe('read-only')
    expect(v.readOnly?.reason).toBe('licence')
  })

  it('suspended by the operator: read-only with that reason after the notice the answer carries', async () => {
    const t = setup()
    const c = t.make()
    t.svc.s.status = 'suspended'
    t.svc.s.readOnlyFrom = new Date(t.start + 48 * H).toISOString()
    let v = await c.check()
    expect(v.mode).toBe('warning')
    expect(v.readOnlyAt).toBe(new Date(t.start + 48 * H).toISOString())
    t.at(t.start + 48 * H)
    v = await c.check()
    expect(v.readOnly?.reason).toBe('suspended')
    expect(t.gate.state?.reason).toBe('suspended')
    // resumed
    t.svc.s.status = 'active'
    t.svc.s.readOnlyFrom = null
    expect((await c.check()).mode).toBe('ok')
  })

  it('unpaid: read-only with the payment reason from readOnlyFrom; duplicate: read-only at once', async () => {
    const t = setup()
    const c = t.make()
    t.svc.s.status = 'payment'
    t.svc.s.readOnlyFrom = new Date(t.start - H).toISOString()
    expect((await c.check()).readOnly?.reason).toBe('payment')
    t.svc.s.status = 'duplicate'
    t.svc.s.readOnlyFrom = new Date(t.start).toISOString()
    expect((await c.check()).readOnly?.reason).toBe('licence')
  })

  it.each([
    ['forge', /signature/],
    ['otherKey', /does not trust/],
    ['replay', /another request/],
    ['otherOrg', /another licence/],
    ['refused', /did not accept|refused/],
  ] as const)('refuses a %s answer: it never renews the grace', async (mode, error) => {
    const t = setup()
    const c = t.make()
    await c.check()
    t.at(t.start + 2 * H)
    t.svc.s.mode = mode
    const v = await c.check()
    expect(v.lastCheck?.ok).toBe(false)
    expect(v.lastCheck?.error).toMatch(error)
    expect(v.mode).toBe('warning')
    // the grace still ends 72 h after the LAST VALID answer
    expect(v.readOnlyAt).toBe(new Date(t.start + GRACE_MS).toISOString())
    expect(v.licence?.seats).toEqual({ full: 5, operator: 20, external: 0 })
  })

  it('a stored answer changed in the database (seats raised) no longer verifies and counts as none', async () => {
    const t = setup()
    const c = t.make()
    await c.check()
    const st = structuredClone(t.store.value!)
    const body = JSON.parse(Buffer.from(st.last!.answer.payload, 'base64').toString('utf8')) as LicencePayload
    body.seats = { full: 999, operator: 0, external: 0 }
    st.last!.answer.payload = Buffer.from(JSON.stringify(body)).toString('base64')
    const v = evaluate(st, licenceConfig(env), trusted, t.start + H)
    expect(v.licence).toBeNull()
    expect(v.mode).toBe('warning')
  })

  it('no licence configured: behaves as before (writable, nothing sent)', async () => {
    const t = setup()
    const c = createLicenceClient({ config: licenceConfig({}), keys: trusted, store: memoryStore(), clock: t.now, transport: t.svc.transport, version: 'x', seats: async () => ({ full: 1, operator: 0, external: 0 }), setReadOnly: (s) => { t.gate.state = s } })
    const v = await c.check()
    expect(v.mode).toBe('unlicensed')
    expect(t.gate.state).toBeNull()
    expect(t.svc.s.calls).toBe(0)
    expect(evaluate(emptyStored(), licenceConfig({}), [], 0).mode).toBe('unlicensed')
  })

  it('half a configuration is a problem shown to administrators, and still checks (a typo does not switch licensing off)', () => {
    const cfg = licenceConfig({ APPBUILDER_LICENCE_URL: 'http://example.com', APPBUILDER_LICENCE_ID: 'lic_x' })
    expect(cfg.configured).toBe(false)
    expect(cfg.problems.join(' ')).toMatch(/https|all three/)
  })
})
