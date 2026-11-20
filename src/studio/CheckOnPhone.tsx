import { useState } from 'react'
import { Smartphone } from 'lucide-react'
import { usePlatform } from '@/platform'
import { useStore } from '@/runtime/store'
import { QrSvg, appPhoneUrl } from '@/phone/QrCode'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const DEMO_HELP = 'Needs the server: demo mode runs only in this browser, so a phone cannot open the app.'

/** Studio button: a QR code of the app's phone start address (the same one the portal's app card shows) */
export function CheckOnPhone({ iconOnly = false, className }: { iconOnly?: boolean; className?: string }) {
  const [open, setOpen] = useState(false)
  const demo = usePlatform((s) => s.mode) === 'demo'
  const appId = useStore((s) => s.appId)
  const name = useStore((s) => s.app.name)
  const saveState = useStore((s) => s.saveState)
  const url = appPhoneUrl(appId ?? '')
  const local = /^https?:\/\/(localhost|127\.|\[::1\])/.test(url)
  return (
    <>
      <Button
        variant="ghost"
        size={iconOnly ? 'icon-sm' : 'xs'}
        className={className}
        data-testid="check-on-phone"
        disabled={demo || !appId}
        title={demo ? DEMO_HELP : 'Check on phone: open the saved app on a real phone'}
        onClick={() => setOpen(true)}
      >
        <Smartphone /> {!iconOnly && <span className="@max-[1180px]/cmd:hidden">Check on phone</span>}
      </Button>
      <Dialog open={open && !demo} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm" data-testid="check-on-phone-dialog">
          <DialogHeader>
            <DialogTitle>Check {name} on a phone</DialogTitle>
            <DialogDescription>Scan with the phone's camera to open the app.</DialogDescription>
          </DialogHeader>
          <QrSvg text={url} label={`QR code for ${url}`} className="mx-auto size-56 rounded-md border border-border" />
          <p className="break-all text-center text-xs text-muted-foreground" data-testid="check-on-phone-url">{url}</p>
          <p className="text-xs text-muted-foreground">
            The phone must be able to reach this server. Camera, offline use and installing need HTTPS. The phone shows saved changes only.
          </p>
          {saveState !== 'saved' && <p className="text-xs text-amber-700 dark:text-amber-300">This app has changes that are not saved yet; wait for "Saved" before you check.</p>}
          {local && <p className="text-xs text-amber-700 dark:text-amber-300">This address only works on this computer. Open Appbuilder by its network address to show a code a phone can use.</p>}
        </DialogContent>
      </Dialog>
    </>
  )
}
