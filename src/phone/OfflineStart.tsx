/**
 * Starting without a connection (P2-A). A browser that has used the Appbuilder server before (remembered in
 * localStorage) and cannot reach it now shows this page instead of falling back to the browser-only demo mode. Changes
 * kept on the device are not touched; they are sent after the connection returns and the user is signed in. The page
 * reloads by itself when the server answers again.
 *
 * Limit (docs/dev/phone.md): an app cannot be opened from a cold start without a connection; the offline key lives in
 * the browser session only, so cached screens are readable only in a session that was connected once.
 */
import { useEffect, useState } from 'react'
import { CloudOff, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

const MODE_KEY = 'appbuilder-last-mode'

export function rememberServerMode(mode: string): void {
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    /* ignore */
  }
}

/** true: this browser used the server before and the server cannot be reached now (no answer at all) */
export async function offlineAtStart(fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<boolean> {
  let mode: string | null = null
  try {
    mode = localStorage.getItem(MODE_KEY)
  } catch {
    return false
  }
  if (mode !== 'server') return false
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 4000)
    await fetchImpl('/api/v1/status', { cache: 'no-store', credentials: 'same-origin', signal: ctl.signal })
    clearTimeout(t)
    return false
  } catch {
    return true
  }
}

export function OfflineStart() {
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const retry = async () => {
      if (!(await offlineAtStart())) location.reload()
    }
    window.addEventListener('online', retry)
    const t = setInterval(retry, 10_000)
    return () => {
      window.removeEventListener('online', retry)
      clearInterval(t)
    }
  }, [])
  return (
    <div data-testid="offline-start" className="grid h-full place-items-center bg-background p-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-3">
        <CloudOff className="size-8 text-muted-foreground" />
        <p className="text-base font-semibold">No connection to the server</p>
        <p className="text-sm text-muted-foreground">
          Changes you saved on this device while offline are kept and sent when the connection returns. This page opens your
          apps again as soon as the server answers.
        </p>
        <Button className="h-11" disabled={busy} onClick={async () => { setBusy(true); if (!(await offlineAtStart())) location.reload(); setBusy(false) }}>
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />} Try again
        </Button>
      </div>
    </div>
  )
}
