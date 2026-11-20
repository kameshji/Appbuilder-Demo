/**
 * A strip under the top bar while the install is read-only (hosting phase H-C; docs/admin/hosting.md): why (suspended,
 * unpaid, maintenance, licence), since when, and what still works. Every change is refused by the server meanwhile
 * (code install_read_only / licence_read_only); reads, sign-in and exports go on. The state is read from
 * GET /api/v1/install/read-only when the page opens, every minute, and when the window gets the focus again, so the strip
 * goes away by itself when the install is writable again. Install administrators also see how the state ends.
 */
import { useEffect, useState } from 'react'
import { Lock } from 'lucide-react'
import { usePlatform } from '@/platform'
import { getJson } from './serverApi'

interface ReadOnlyInfo {
  reason: 'suspended' | 'payment' | 'maintenance' | 'licence'
  message: string
  since: string
  text: string
  stillWorks: string
  leave?: string
}

const POLL_MS = 60_000

export function ReadOnlyBanner() {
  const server = usePlatform((s) => s.mode) === 'server'
  const signedIn = usePlatform((s) => !!s.session)
  const [info, setInfo] = useState<ReadOnlyInfo | null>(null)
  useEffect(() => {
    if (!server || !signedIn) return
    let live = true
    const load = () => {
      getJson<{ readOnly: ReadOnlyInfo | null }>('/install/read-only')
        .then((r) => { if (live) setInfo(r.readOnly ?? null) })
        .catch(() => { /* an older server, or offline: keep what we know */ })
    }
    load()
    const t = setInterval(load, POLL_MS)
    window.addEventListener('focus', load)
    return () => {
      live = false
      clearInterval(t)
      window.removeEventListener('focus', load)
    }
  }, [server, signedIn])
  if (!info || !server || !signedIn) return null
  const since = new Date(info.since)
  return (
    <div role="status" data-testid="read-only-banner" data-reason={info.reason} className="flex items-start gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-900 dark:text-amber-100">
      <Lock className="mt-0.5 size-3.5 shrink-0" />
      <span>
        <strong className="font-medium">{info.text}</strong>
        {info.message ? ` ${info.message}` : ''} {info.stillWorks} Changes are not saved until it is writable again; a phone keeps its offline changes waiting and sends them then.
        {!Number.isNaN(since.getTime()) && <span className="text-amber-800/80 dark:text-amber-200/80"> Since {since.toLocaleString()}.</span>}
        {info.leave && <span className="text-amber-800/80 dark:text-amber-200/80"> {info.leave}</span>}
      </span>
    </div>
  )
}
