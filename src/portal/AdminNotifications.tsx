/**
 * Admin console > Email, below the relay settings (P1 package D, install administrators): notification defaults and
 * locks per kind, the logo of notification emails, the per-recipient email limit, the mail suppression list and the
 * delivery log of anyone.
 */
import { useEffect, useState } from 'react'
import { Ban, BellRing, Plus, Trash2 } from 'lucide-react'
import { usePlatform } from '@/platform'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
import { Field, Panel, errMsg, fmtRelative, useToast } from './kit'
import { deliveryApi, type DeliveryEntry, type DeliveryPolicy, type EmailMode } from './actionsApi'

const sel = 'h-8 rounded-md border border-input bg-background px-2 text-sm outline-none'

export function NotificationAdmin() {
  const users = usePlatform((s) => s.users)
  const { fail, toast } = useToast()
  const [p, setP] = useState<DeliveryPolicy | null>(null)
  const [error, setError] = useState('')
  const [sup, setSup] = useState<{ address: string; reason: string; note: string | null; addedOn: string }[]>([])
  const [addr, setAddr] = useState('')
  const [who, setWho] = useState('')
  const [log, setLog] = useState<DeliveryEntry[] | null>(null)
  const loadSup = () => deliveryApi.suppressions().then((r) => setSup(r.items)).catch(() => {})
  useEffect(() => { deliveryApi.policy().then(setP).catch((e) => setError(errMsg(e))); void loadSup() }, [])
  if (error) return null
  if (!p) return <Spinner />
  const kinds = p.kindsKnown ?? []
  const setKind = (k: string, patch: Partial<DeliveryPolicy['kinds'][string]>) => setP({ ...p, kinds: { ...p.kinds, [k]: { ...(p.kinds[k] ?? {}), ...patch } } })
  const save = async () => {
    try {
      setP({ ...(await deliveryApi.savePolicy({ kinds: p.kinds, logoUrl: p.logoUrl, perRecipientPerHour: p.perRecipientPerHour })), kindsKnown: kinds })
      toast('Notification defaults saved', 'success')
    } catch (e) {
      fail(e)
    }
  }
  return (
    <div className="mt-8 grid gap-6" data-testid="notification-admin">
      <Panel className="grid gap-3 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold"><BellRing className="size-4" /> Notification defaults</div>
        <p className="text-xs text-muted-foreground">What people get unless they choose otherwise. <strong>Lock</strong> a kind to make your choice apply to everyone (for example approvals always by email); locked kinds cannot be muted with the link in the email either.</p>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1">Kind</th><th>In the app</th><th>Email</th><th>Lock</th></tr></thead>
          <tbody>
            {kinds.map((k) => {
              const v = p.kinds[k.kind] ?? {}
              return (
                <tr key={k.kind} className="border-t border-border/60" data-testid={`policy-${k.kind}`}>
                  <td className="py-1.5">{k.label}</td>
                  <td><Switch checked={v.inApp ?? true} onCheckedChange={(x) => setKind(k.kind, { inApp: x })} aria-label={`${k.label} in the app by default`} /></td>
                  <td><select className={sel} value={v.email ?? 'off'} onChange={(e) => setKind(k.kind, { email: e.target.value as EmailMode })} aria-label={`${k.label} email default`} data-testid={`policy-email-${k.kind}`}><option value="off">No email</option><option value="immediate">Right away</option><option value="digest">Digest</option></select></td>
                  <td><Switch checked={!!v.lock} onCheckedChange={(x) => setKind(k.kind, { lock: x })} aria-label={`Lock ${k.label}`} data-testid={`policy-lock-${k.kind}`} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Logo in notification emails" hint="An https address of a small image (the install name always shows)"><Input value={p.logoUrl} onChange={(e) => setP({ ...p, logoUrl: e.target.value })} placeholder="https://apps.example.com/logo.png" /></Field>
          <Field label="Emails right away per person and hour" hint="More are collected into the next hourly email"><Input inputMode="numeric" value={String(p.perRecipientPerHour)} onChange={(e) => setP({ ...p, perRecipientPerHour: Number(e.target.value.replace(/[^0-9]/g, '')) || 1 })} /></Field>
        </div>
        <div><Button size="sm" onClick={() => void save()} data-testid="policy-save">Save defaults</Button></div>
      </Panel>
      <Panel className="grid gap-3 p-4" data-testid="suppression-list">
        <div className="flex items-center gap-2 text-sm font-semibold"><Ban className="size-4" /> Suppression list</div>
        <p className="text-xs text-muted-foreground">These addresses get no email from flows, notifications or reports (system email such as password resets still goes out). Bounces are not detected automatically: Appbuilder does not receive mail, so add addresses that bounce here.</p>
        <div className="flex gap-2"><Input className="h-8" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="address@example.com" data-testid="suppress-address" /><Button size="sm" disabled={!addr.trim()} onClick={() => deliveryApi.suppress(addr.trim()).then(() => { setAddr(''); void loadSup() }).catch(fail)} data-testid="suppress-add"><Plus /> Add</Button></div>
        {sup.length > 0 && <ul className="grid gap-1 text-xs">{sup.map((x) => <li key={x.address} className="flex items-center gap-2"><span className="flex-1 font-mono">{x.address}</span><span className="text-muted-foreground">{x.reason} · {fmtRelative(x.addedOn)}</span><Button size="icon-sm" variant="ghost" aria-label={`Remove ${x.address}`} onClick={() => deliveryApi.unsuppress(x.address).then(loadSup).catch(fail)}><Trash2 /></Button></li>)}</ul>}
      </Panel>
      <Panel className="grid gap-3 p-4">
        <div className="text-sm font-semibold">Notification deliveries</div>
        <div className="flex gap-2"><select className={sel} value={who} onChange={(e) => setWho(e.target.value)}><option value="">Everyone</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select><Button size="sm" variant="outline" onClick={() => deliveryApi.adminLog(who || undefined).then((r) => setLog(r.items)).catch(fail)}>Show</Button></div>
        {log && <ul className="grid max-h-72 gap-1 overflow-auto text-xs">{log.map((d) => <li key={d.id}>{fmtRelative(d.at)} · {users.find((u) => u.id === d.userId)?.name ?? d.userId} · {d.title} · {d.channel} {d.status}<div className="text-muted-foreground">{d.reason}</div></li>)}</ul>}
      </Panel>
    </div>
  )
}
