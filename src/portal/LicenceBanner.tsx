/**
 * A strip under the top bar for administrators while the licence is in its grace period (hosting phase, H-G): what is
 * wrong, how long is left before the install becomes read-only, and what to do (words: licenceGrace.ts). When the
 * install is already read-only for a licence reason, the read-only strip (ReadOnlyBanner.tsx, shown to everyone) says so
 * and this strip adds what an administrator can do about it. Read from GET /api/v1/install/licence (administrators)
 * when the page opens, every five minutes and when the window gets the focus; the time left is recounted every minute.
 * Nothing is enforced here: the server decides.
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, KeyRound } from 'lucide-react'
import { usePlatform } from '@/platform'
import { useCaps } from './security'
import { fetchLicence, type LicenceView } from './licenceApi'
import { licenceBanner } from './licenceGrace'

const POLL_MS = 5 * 60_000

export function LicenceBanner() {
  const server = usePlatform((s) => s.mode) === 'server'
  const caps = useCaps()
  const [view, setView] = useState<LicenceView | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const admin = server && caps.isAdmin
  useEffect(() => {
    if (!admin) return
    let live = true
    const load = () => {
      setNow(Date.now())
      fetchLicence().then((r) => { if (live) setView(r.licence) }).catch(() => { /* not allowed, an older server, or offline */ })
    }
    load()
    const t = setInterval(load, POLL_MS)
    const tick = setInterval(() => setNow(Date.now()), 60_000)
    window.addEventListener('focus', load)
    return () => {
      live = false
      clearInterval(t)
      clearInterval(tick)
      window.removeEventListener('focus', load)
    }
  }, [admin])
  const b = admin ? licenceBanner(view, now, caps.isInstallAdmin) : null
  if (!b) return null
  const Icon = b.kind === 'grace' ? AlertTriangle : KeyRound
  return (
    <div role="status" data-testid="licence-banner" data-kind={b.kind} className="flex items-start gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-900 dark:text-amber-100">
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span>
        <strong className="font-medium">{b.title}</strong>
        {b.kind === 'grace' ? ` ${b.detail}` : ''}
        <span className="text-amber-800/90 dark:text-amber-200/90"> What to do: {b.action}</span>
      </span>
    </div>
  )
}
