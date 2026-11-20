/**
 * Settings > Notifications, server mode (P1 package D): channels per kind (in the app, email: off / right away /
 * digest; WhatsApp when offered: WhatsappNotificationChoice.tsx, P2-E), the digest time, the time zone, quiet hours for email, and the delivery log ("why did I get
 * this"). Kinds an administrator locked show their fixed choice.
 */
import { useEffect, useState } from 'react'
import { Lock, MessageCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
import { errMsg, fmtRelative, useToast } from './kit'
import { useNotificationSettings } from './Notifications'
import { deliveryApi, type Channels, type DeliveryEntry, type EmailMode } from './actionsApi'
import { WhatsappCell, WhatsappConsent, useWhatsappMe } from './WhatsappNotificationChoice'

const sel = 'h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30'

export function NotificationChannels() {
  const { settings, save } = useNotificationSettings()
  const { fail } = useToast()
  const [ch, setCh] = useState<Channels | null>(null)
  const [error, setError] = useState('')
  const [log, setLog] = useState<DeliveryEntry[] | null>(null)
  const wa = useWhatsappMe()
  const reload = () => deliveryApi.channels().then(setCh).catch((e) => setError(errMsg(e)))
  useEffect(() => { void reload() }, [])
  const put = async (patch: Parameters<typeof save>[0]) => {
    try {
      await save(patch)
      await reload()
    } catch (e) {
      fail(e)
    }
  }
  if (error) return <p className="text-xs text-destructive">{error}</p>
  if (!ch) return <div className="py-4"><Spinner /></div>
  const zone = ch.timeZone
  return (
    <div className="grid gap-4" data-testid="notification-channels">
      {!ch.emailAvailable && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs">Email is not set up on this server: an install administrator sets up the mail relay in Admin console &gt; Email. Your email choices are kept for then.</p>}
      <table className="w-full text-sm">
        <thead><tr className="border-b border-border text-left text-xs text-muted-foreground"><th className="py-2">Kind</th><th className="py-2">In the app</th><th className="py-2">Email ({ch.email})</th><th className="py-2"><span className="inline-flex items-center gap-1"><MessageCircle className="size-3" /> WhatsApp</span></th></tr></thead>
        <tbody>
          {ch.kinds.map((k) => (
            <tr key={k.kind} className="border-b border-border/60" data-testid={`channel-${k.kind}`}>
              <td className="py-2 pr-2"><div className="font-medium">{k.label}</div><div className="text-xs text-muted-foreground">{k.description}</div></td>
              <td className="py-2">
                {k.locked ? <span className="inline-flex items-center gap-1 text-xs" title={k.inAppReason}><Lock className="size-3" />{k.inApp ? 'On' : 'Off'}</span> : (
                  <Switch checked={k.inApp} onCheckedChange={(v) => void put({ kinds: { ...settings.kinds, [k.kind]: v } })} aria-label={`${k.label} in the app`} data-testid={`channel-inapp-${k.kind}`} />
                )}
              </td>
              <td className="py-2">
                {k.locked ? <span className="inline-flex items-center gap-1 text-xs" title={k.emailReason} data-testid={`channel-locked-${k.kind}`}><Lock className="size-3" />{k.email === 'off' ? 'No email' : k.email === 'digest' ? 'Digest' : 'Right away'} (set by your administrator)</span> : (
                  <select className={sel} value={k.email} onChange={(e) => void put({ email: { ...(settings.email ?? {}), [k.kind]: e.target.value as EmailMode } })} aria-label={`${k.label} by email`} data-testid={`channel-email-${k.kind}`}>
                    <option value="off">No email</option>
                    <option value="immediate">Right away</option>
                    <option value="digest">In a digest</option>
                  </select>
                )}
              </td>
              <td className="py-2"><WhatsappCell kind={k.kind} label={k.label} me={wa.me} onChange={wa.set} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <WhatsappConsent me={wa.me} onChange={wa.set} />
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="grid gap-1 text-xs font-medium">Digest
          <div className="flex gap-2">
            <select className={sel} value={ch.digest.frequency} onChange={(e) => void put({ digest: { frequency: e.target.value as 'hourly' | 'daily', time: ch.digest.time } })} data-testid="digest-frequency"><option value="daily">Daily</option><option value="hourly">Hourly</option></select>
            {ch.digest.frequency === 'daily' && <Input type="time" className="h-8 w-28" value={ch.digest.time} onChange={(e) => e.target.value && void put({ digest: { frequency: 'daily', time: e.target.value } })} aria-label="Digest time" data-testid="digest-time" />}
          </div>
        </label>
        <label className="grid gap-1 text-xs font-medium">Time zone (digests and quiet hours)
          <div className="flex gap-2">
            <Input className="h-8" defaultValue={zone} key={zone} onBlur={(e) => e.target.value !== zone && void put({ timeZone: e.target.value })} aria-label="Time zone" data-testid="notify-timezone" />
            <Button size="xs" variant="outline" onClick={() => void put({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })}>Use this browser's</Button>
          </div>
        </label>
        <label className="flex items-center justify-between gap-2 text-xs font-medium">Do-not-disturb hours hold emails too
          <Switch checked={ch.quietEmail} onCheckedChange={(v) => void put({ quietEmail: v })} aria-label="Quiet hours hold emails" data-testid="quiet-email" />
        </label>
      </div>
      <div className="grid gap-2">
        <div className="flex items-center gap-2"><span className="text-sm font-medium">Why did I get this?</span><Button size="xs" variant="outline" onClick={() => deliveryApi.log().then((r) => setLog(r.items)).catch(fail)} data-testid="show-delivery-log">Show recent deliveries</Button></div>
        {log && (log.length === 0 ? <p className="text-xs text-muted-foreground">Nothing delivered yet.</p> : (
          <ul className="grid max-h-64 gap-1 overflow-auto text-xs" data-testid="delivery-log">
            {log.map((d) => <li key={d.id} className="rounded border border-border/60 px-2 py-1"><span className="font-medium">{d.title}</span> · {d.channel === 'in_app' ? 'in the app' : d.channel} · {d.status} · {fmtRelative(d.at)}<div className="text-muted-foreground">{d.reason}</div></li>)}
          </ul>
        ))}
      </div>
    </div>
  )
}
