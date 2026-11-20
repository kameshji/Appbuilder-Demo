/**
 * Settings > Notifications, the WhatsApp column (P2 package E): a switch per kind when WhatsApp is offered to this person
 * (the environment has a WhatsApp connection and an approved template mapped for notifications, and the person's
 * number is opted in), the opt-in / opt-out of their own number, and the reason when it is not offered.
 */
import { useEffect, useState } from 'react'
import { MessageCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useToast } from './kit'
import { whatsappApi, type WaMe } from './whatsappApi'

export function useWhatsappMe(): { me: WaMe | null; set(next: WaMe): void } {
  const [me, setMe] = useState<WaMe | null>(null)
  useEffect(() => { whatsappApi.me().then(setMe).catch(() => setMe(null)) }, [])
  return { me, set: setMe }
}

export function WhatsappCell({ kind, label, me, onChange }: { kind: string; label: string; me: WaMe | null; onChange(next: WaMe): void }) {
  const { fail } = useToast()
  if (!me || !me.offered) return <span className="text-xs text-muted-foreground" title={me?.reason ?? 'WhatsApp is not available'}>Not available</span>
  return (
    <Switch
      checked={me.kinds[kind] === true}
      onCheckedChange={(v) => whatsappApi.saveMe({ ...me.kinds, [kind]: v }).then(onChange).catch(fail)}
      aria-label={`${label} on WhatsApp`}
      data-testid={`channel-whatsapp-${kind}`}
    />
  )
}

export function WhatsappConsent({ me, onChange }: { me: WaMe | null; onChange(next: WaMe): void }) {
  const { fail, toast } = useToast()
  if (!me) return null
  return (
    <div className="grid gap-2 rounded-md border border-border/60 px-3 py-2 text-xs" data-testid="whatsapp-consent">
      <div className="flex items-center gap-2 font-medium"><MessageCircle className="size-3.5" /> WhatsApp{me.phone ? ` (${me.phone})` : ''}</div>
      <p className="text-muted-foreground">{me.reason} WhatsApp messages are sent right away (no digest); during your do-not-disturb hours they wait until the hours end. Writing STOP to the business number stops them.</p>
      {me.canOptIn && (
        <div className="flex flex-wrap items-center gap-2">
          <span>Send my Appbuilder notifications to this number on WhatsApp. I can stop them at any time by writing STOP.</span>
          <Button size="xs" onClick={() => whatsappApi.optInMe().then((m) => { onChange(m); toast('WhatsApp opt-in recorded', 'success') }).catch(fail)} data-testid="whatsapp-opt-in">I agree</Button>
        </div>
      )}
      {me.optedIn && <div><Button size="xs" variant="outline" onClick={() => whatsappApi.optOutMe().then((m) => { onChange(m); toast('WhatsApp opt-out recorded', 'success') }).catch(fail)} data-testid="whatsapp-opt-out">Stop WhatsApp messages to my number</Button></div>}
    </div>
  )
}
