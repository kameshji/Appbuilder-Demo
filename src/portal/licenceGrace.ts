/** The words of the licence strip under the top bar (LicenceBanner.tsx): pure, unit-tested in licenceGrace.test.ts. */
import type { LicenceView } from './licenceApi'

/** "2 days 5 hours", "3 hours 10 minutes", "12 minutes", "less than a minute" */
export function timeLeft(ms: number): string {
  if (ms < 60_000) return 'less than a minute'
  const min = Math.floor(ms / 60_000)
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const m = min % 60
  const part = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  if (d) return h ? `${part(d, 'day')} ${part(h, 'hour')}` : part(d, 'day')
  if (h) return m ? `${part(h, 'hour')} ${part(m, 'minute')}` : part(h, 'hour')
  return part(m, 'minute')
}

export interface LicenceBannerText { kind: 'grace' | 'read-only'; title: string; detail: string; action: string }

/** what the strip says for a licence state at `now` (null: nothing to say); install administrators get the steps themselves */
export function licenceBanner(v: LicenceView | null | undefined, now: number, installAdmin: boolean, fmt: (ms: number) => string = (ms) => new Date(ms).toLocaleString()): LicenceBannerText | null {
  if (!v || !v.configured) return null
  const step = (s: string) => (installAdmin ? s.charAt(0).toUpperCase() + s.slice(1) : `Ask an install administrator to ${s}`)
  const failing = !!v.lastCheck && !v.lastCheck.ok
  const status = v.licence?.status
  if (v.mode === 'warning' && v.readOnlyAt) {
    const at = Date.parse(v.readOnlyAt)
    const known = !Number.isNaN(at)
    const unpaid = status === 'payment'
    const suspended = status === 'suspended' || status === 'cancelled'
    const what = unpaid ? 'The subscription is unpaid.' : suspended ? 'The licence was suspended.' : failing ? 'The licence could not be verified: the licence service did not answer or refused the check.' : 'The licence has not been verified yet.'
    const action = unpaid || suspended
      ? step('settle it with your provider; the strip goes away at the next successful check (Admin console > Licences > Check now).')
      : step('check that this server can reach the licence service (internet access, proxy, firewall) and that the licence id is right, then use Admin console > Licences > Check now.')
    return {
      kind: 'grace',
      title: known ? `Licence grace period: read-only in ${timeLeft(Math.max(0, at - now))} (${fmt(at)}).` : 'Licence grace period.',
      detail: `${what} Everything works until then; after it, sign-in, reading and export keep working but no change is saved.`,
      action,
    }
  }
  if (v.mode === 'read-only' && v.readOnly) {
    const action = v.readOnly.reason === 'licence'
      ? step('restore the connection to the licence service (internet access, proxy, firewall, the server clock), then use Admin console > Licences > Check now. It ends by itself when a check succeeds.')
      : step('settle the subscription with your provider; it ends by itself at the next successful check (Admin console > Licences > Check now).')
    return { kind: 'read-only', title: 'Read-only because of the licence.', detail: v.readOnly.message, action }
  }
  return null
}
