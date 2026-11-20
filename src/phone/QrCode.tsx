/**
 * QR codes in the UI (P2-A): "Open on phone" on an app card. Encoding: qrcode-generator (MIT, already a dependency of
 * the server's two-step enrolment), drawn as one SVG path (no scripts, no inline styles beyond React's).
 */
import { useMemo, useState } from 'react'
import qrcode from 'qrcode-generator'
import { QrCode as QrIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/** SVG path data of a QR code for text, with a 4-module margin; size = modules + 8 */
export function qrPath(text: string): { d: string; size: number } {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  let d = ''
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4},${r + 4}h1v1h-1z`
  return { d, size: n + 8 }
}

export function QrSvg({ text, label, className }: { text: string; label: string; className?: string }) {
  const { d, size } = useMemo(() => qrPath(text), [text])
  return (
    <svg viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" role="img" aria-label={label} className={className}>
      <rect width={size} height={size} fill="#ffffff" />
      <path fill="#000000" d={d} />
    </svg>
  )
}

/** the address a phone opens for an app: the same as the home screen icon's start address */
export const appPhoneUrl = (appId: string, origin = typeof location !== 'undefined' ? location.origin : '') => `${origin}/?app=${encodeURIComponent(appId)}`

export function OpenOnPhone({ appId, appName }: { appId: string; appName: string }) {
  const [open, setOpen] = useState(false)
  const url = appPhoneUrl(appId)
  const local = /^https?:\/\/(localhost|127\.|\[::1\])/.test(url)
  return (
    <>
      <Button size="icon-sm" variant="ghost" title="Open on a phone" aria-label={`Open ${appName} on a phone`} data-testid={`open-on-phone-${appId}`} onClick={(e) => { e.stopPropagation(); setOpen(true) }}>
        <QrIcon />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm" data-testid="open-on-phone-dialog">
          <DialogHeader>
            <DialogTitle>Open {appName} on a phone</DialogTitle>
            <DialogDescription>Scan with the phone's camera. Then use the browser menu's "Add to Home screen" to get an icon for the app.</DialogDescription>
          </DialogHeader>
          <QrSvg text={url} label={`QR code for ${url}`} className="mx-auto size-56 rounded-md border border-border" />
          <p className="break-all text-center text-xs text-muted-foreground">{url}</p>
          {local && <p className="text-xs text-amber-700 dark:text-amber-300">This address only works on this computer. Open Appbuilder by its network (HTTPS) address to show a code a phone can use; see Admin guide &gt; Phones on the LAN.</p>}
        </DialogContent>
      </Dialog>
    </>
  )
}
