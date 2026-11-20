/**
 * "Add to Home screen" help (P2-A): shown on My apps on a phone or tablet that has not opened Appbuilder from its home
 * screen. Android Chrome: the browser's install prompt when it offers one, otherwise the menu steps. iOS Safari: Share >
 * Add to Home Screen. Other browsers: the browser menu. Plain HTTP on a LAN address cannot install: it says to ask for the
 * HTTPS address. Dismissal is remembered on this device.
 */
import { useState } from 'react'
import { Download, Share, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDevice } from './env'
import { installPlatform, promptInstall, usePwa } from './pwa'

const DISMISS = 'appbuilder-a2hs-dismissed'

export function AddToHome() {
  const d = useDevice()
  const canPrompt = usePwa((s) => s.canPrompt)
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(DISMISS) === '1'
    } catch {
      return false
    }
  })
  if (!d.touch || d.standalone || hidden) return null
  const p = installPlatform(navigator.userAgent, navigator.maxTouchPoints)
  const dismiss = () => {
    setHidden(true)
    try {
      localStorage.setItem(DISMISS, '1')
    } catch {
      /* ignore */
    }
  }
  return (
    <section className="mb-5 rounded-xl border border-border bg-card p-3 text-sm" data-testid="add-to-home" aria-label="Add to Home screen">
      <div className="flex items-start gap-2">
        <Download className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="font-medium">Add Appbuilder to your Home screen</p>
          {!d.secure ? (
            <p className="text-muted-foreground">This address is not secure (no HTTPS), so it cannot be added. Ask your administrator for the HTTPS address.</p>
          ) : p === 'android-chrome' ? (
            canPrompt ? (
              <Button size="sm" className="h-10" onClick={() => void promptInstall()} data-testid="add-to-home-install"><Download /> Install</Button>
            ) : (
              <p className="text-muted-foreground">Tap the menu (⋮) at the top right, then <b>Add to Home screen</b> or <b>Install app</b>. Open an app first to add that app with its own icon.</p>
            )
          ) : p === 'ios-safari' ? (
            <p className="text-muted-foreground">Tap <Share className="inline size-3.5" /> <b>Share</b> at the bottom, then <b>Add to Home Screen</b>. Open an app first to add that app with its own icon.</p>
          ) : p === 'ios-other' ? (
            <p className="text-muted-foreground">Open this page in <b>Safari</b>, then tap Share &gt; <b>Add to Home Screen</b>.</p>
          ) : (
            <p className="text-muted-foreground">Use your browser's menu: <b>Add to Home screen</b> or <b>Install</b>.</p>
          )}
        </div>
        <button type="button" onClick={dismiss} aria-label="Hide" className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted"><X className="size-4" /></button>
      </div>
    </section>
  )
}
