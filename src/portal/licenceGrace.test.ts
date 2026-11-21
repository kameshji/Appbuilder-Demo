import { describe, expect, it } from 'vitest'
import { licenceBanner, timeLeft } from './licenceGrace'
import type { LicenceView } from './licenceApi'

const NOW = Date.parse('2026-11-21T10:00:00Z')
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 16)
const view = (o: Partial<LicenceView>): LicenceView => ({
  configured: true, mode: 'ok', readOnly: null, readOnlyAt: null, warnings: [], problems: [], licence: null, lastCheck: null, installId: 'i1', clockBack: false, keySource: 'built-in', ...o,
})
const lic = (status: string) => ({ licenceId: 'L', status, plan: 'pilot', kind: 'subscription' as const, seats: null, paidUntil: null, maintenanceUntil: null, issuedAt: '', validUntil: '', receivedAt: '', message: '' })

describe('the licence strip under the top bar', () => {
  it('counts the time left in words', () => {
    expect(timeLeft(30_000)).toBe('less than a minute')
    expect(timeLeft(12 * 60_000)).toBe('12 minutes')
    expect(timeLeft(3 * 3600_000 + 10 * 60_000)).toBe('3 hours 10 minutes')
    expect(timeLeft(2 * 86400_000 + 5 * 3600_000 + 59_000)).toBe('2 days 5 hours')
    expect(timeLeft(86400_000)).toBe('1 day')
  })

  it('says nothing when the licence is fine, not set up, or unknown', () => {
    expect(licenceBanner(view({ mode: 'ok' }), NOW, true)).toBeNull()
    expect(licenceBanner(view({ configured: false, mode: 'unlicensed' }), NOW, true)).toBeNull()
    expect(licenceBanner(null, NOW, true)).toBeNull()
  })

  it('grace period because the check fails: the state, how long is left, what to do', () => {
    const b = licenceBanner(view({ mode: 'warning', readOnlyAt: '2026-11-23T15:30:00Z', lastCheck: { at: '', ok: false, error: 'timeout' }, licence: lic('active') }), NOW, true, fmt)!
    expect(b.kind).toBe('grace')
    expect(b.title).toBe('Licence grace period: read-only in 2 days 5 hours (2026-11-23T15:30).')
    expect(b.detail).toMatch(/could not be verified/)
    expect(b.action).toMatch(/^Check that this server can reach the licence service.*Check now/)
  })

  it('grace period of an unpaid subscription; an environment administrator is told whom to ask', () => {
    const b = licenceBanner(view({ mode: 'warning', readOnlyAt: '2026-11-21T10:45:00Z', licence: lic('payment') }), NOW, false, fmt)!
    expect(b.title).toMatch(/read-only in 45 minutes/)
    expect(b.detail).toMatch(/unpaid/)
    expect(b.action).toMatch(/^Ask an install administrator to settle it/)
  })

  it('read-only because of the licence: what ends it', () => {
    const b = licenceBanner(view({ mode: 'read-only', readOnly: { reason: 'licence', message: 'The licence could not be verified since ...', since: '2026-11-20T10:00:00Z' } }), NOW, true)!
    expect(b.kind).toBe('read-only')
    expect(b.action).toMatch(/restore the connection to the licence service/i)
    expect(licenceBanner(view({ mode: 'read-only', readOnly: { reason: 'payment', message: 'Unpaid', since: '' } }), NOW, true)!.action).toMatch(/settle the subscription/i)
  })
})
