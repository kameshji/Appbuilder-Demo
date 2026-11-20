/**
 * Admin console > WhatsApp (P2 package E, environment administrators): the webhook addresses to enter in Meta's app
 * settings, the opt-in list (record an opt-in or opt-out with evidence, see the full history of a number), the message log,
 * the STOP / START keywords and the notification mapping (connection, approved template, what fills its values).
 * Minimal tables; the data and every rule live on the server (server/core/whatsapp).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { History, MessageCircle, RefreshCw } from 'lucide-react'
import { usePlatform } from '@/platform'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
import { Field, Panel, errMsg, fmtRelative, useToast } from './kit'
import { whatsappApi, type NotificationMapping, type OptIn, type WaMessage, type WaSettings } from './whatsappApi'

const sel = 'h-8 rounded-md border border-input bg-background px-2 text-sm outline-none'
const th = 'py-1.5 pr-2 font-medium'

export function WhatsappAdminSection({ title }: { title(t: string, sub?: ReactNode, actions?: ReactNode): ReactNode }) {
  const connections = usePlatform((s) => s.connections).filter((c) => c.connector === 'whatsapp')
  const { fail, toast } = useToast()
  const [st, setSt] = useState<WaSettings | null>(null)
  const [error, setError] = useState('')
  const [optins, setOptins] = useState<OptIn[]>([])
  const [filter, setFilter] = useState('')
  const [history, setHistory] = useState<{ phone: string; items: OptIn[] } | null>(null)
  const [msgs, setMsgs] = useState<WaMessage[]>([])
  const [form, setForm] = useState({ phone: '', status: 'opted_in' as 'opted_in' | 'opted_out', source: 'administrator', evidence: '' })
  const [map, setMap] = useState<NotificationMapping>({ enabled: true, connectionId: '', template: '', language: 'en', params: ['title', 'body'] })
  const [stop, setStop] = useState('')
  const [start, setStart] = useState('')

  const loadOptins = () => whatsappApi.optins({ search: filter || undefined }).then((r) => setOptins(r.items)).catch(fail)
  const loadMsgs = () => whatsappApi.messages().then((r) => setMsgs(r.items)).catch(fail)
  useEffect(() => {
    whatsappApi.settings().then((s) => {
      setSt(s)
      setStop(s.keywords.stop.join(', '))
      setStart(s.keywords.start.join(', '))
      if (s.notifications) setMap(s.notifications)
    }).catch((e) => setError(errMsg(e)))
    void loadOptins()
    void loadMsgs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (error) return <>{title('WhatsApp')}<p className="text-sm text-destructive">{error}</p></>
  if (!st) return <Spinner />
  const list = (t: string) => t.split(',').map((x) => x.trim()).filter(Boolean)
  const record = async () => {
    try {
      await whatsappApi.record(form)
      toast('Recorded', 'success')
      setForm({ ...form, phone: '', evidence: '' })
      void loadOptins()
    } catch (e) {
      fail(e)
    }
  }
  const saveKeywords = () => whatsappApi.saveSettings({ keywords: { stop: list(stop), start: list(start) } }).then(() => toast('Keywords saved', 'success')).catch(fail)
  const saveMapping = (m: NotificationMapping | null) => whatsappApi.saveSettings({ notifications: m }).then((r) => { toast(m ? 'Notification template checked with Meta and saved' : 'WhatsApp notifications turned off', 'success'); if (r.notifications) setMap(r.notifications) }).catch(fail)

  return (
    <div className="grid gap-6" data-testid="whatsapp-admin">
      {title('WhatsApp', 'Opt-ins, the message log and notifications of this environment. Nothing is sent to a number without a current opt-in; your business is responsible for the consent being real and for template approval by Meta.')}

      <Panel className="grid gap-2 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold"><MessageCircle className="size-4" /> Webhook addresses</div>
        {!st.webhooks.length ? <p className="text-xs text-muted-foreground">No WhatsApp connection yet: add one in Connections.</p> : st.webhooks.map((w) => (
          <div key={w.connectionId} className="grid gap-0.5 text-xs" data-testid={`wa-webhook-${w.connectionId}`}>
            <div className="font-medium">{w.name} {!w.sendingEnabled && <Badge variant="outline">sending off</Badge>}</div>
            <code className="break-all rounded bg-muted px-2 py-1">{w.url}</code>
            <span className="text-muted-foreground">App secret {w.hasAppSecret ? 'set' : 'missing (webhook calls are refused)'} · verify token {w.hasVerifyToken ? 'set' : 'missing'} · default country code {w.defaultCountryCode || '-'}</span>
          </div>
        ))}
      </Panel>

      <Panel className="grid gap-3 p-4">
        <div className="text-sm font-semibold">Opt-ins</div>
        <div className="grid gap-2 sm:grid-cols-[160px_130px_150px_minmax(0,1fr)_auto]">
          <Input placeholder="+91 ..." value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} aria-label="Phone number" data-testid="wa-optin-phone" />
          <select className={sel} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as 'opted_in' })} aria-label="Status"><option value="opted_in">Opted in</option><option value="opted_out">Opted out</option></select>
          <select className={sel} value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} aria-label="Source"><option value="administrator">Administrator</option><option value="form">Form</option><option value="import">Import</option><option value="inbound keyword">Inbound keyword</option></select>
          <Input placeholder="Evidence: what the person agreed to, where and when" value={form.evidence} onChange={(e) => setForm({ ...form, evidence: e.target.value })} aria-label="Evidence" data-testid="wa-optin-evidence" />
          <Button size="sm" disabled={!form.phone.trim() || form.evidence.trim().length < 10} onClick={() => void record()} data-testid="wa-optin-record">Record</Button>
        </div>
        <div className="flex gap-2"><Input className="h-8 max-w-xs" placeholder="Search digits" value={filter} onChange={(e) => setFilter(e.target.value)} /><Button size="xs" variant="outline" onClick={() => void loadOptins()}><RefreshCw /> Search</Button></div>
        <table className="w-full text-xs" data-testid="wa-optins">
          <thead><tr className="text-left text-muted-foreground"><th className={th}>Number</th><th className={th}>Status</th><th className={th}>Source</th><th className={th}>Recorded</th><th className={th}>Evidence</th><th /></tr></thead>
          <tbody>
            {optins.map((o) => (
              <tr key={o.phone} className="border-t border-border/60 align-top">
                <td className="py-1.5 pr-2 font-mono">{o.phone}</td>
                <td className="pr-2"><Badge variant={o.status === 'opted_in' ? 'secondary' : 'outline'}>{o.status === 'opted_in' ? 'Opted in' : 'Opted out'}</Badge></td>
                <td className="pr-2">{o.source}</td>
                <td className="pr-2">{fmtRelative(o.recordedOn)}<div className="text-muted-foreground">{o.recordedBy ?? ''}</div></td>
                <td className="pr-2">{o.evidence}</td>
                <td><Button size="xs" variant="ghost" onClick={() => whatsappApi.history(o.phone).then((r) => setHistory({ phone: o.phone, items: r.items })).catch(fail)} aria-label={`History of ${o.phone}`}><History /></Button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!optins.length && <p className="text-xs text-muted-foreground">No opt-ins recorded.</p>}
        {history && (
          <div className="grid gap-1 rounded-md border border-border/60 p-2 text-xs" data-testid="wa-optin-history">
            <div className="font-medium">History of {history.phone} (kept in full)</div>
            {history.items.map((h, i) => <div key={i}>{fmtRelative(h.recordedOn)} · {h.status === 'opted_in' ? 'opted in' : 'opted out'} · {h.source} · {h.recordedBy ?? ''} · {h.evidence}</div>)}
          </div>
        )}
      </Panel>

      <Panel className="grid gap-3 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold">Message log <Button size="xs" variant="outline" onClick={() => void loadMsgs()}><RefreshCw /> Refresh</Button></div>
        <table className="w-full text-xs" data-testid="wa-messages">
          <thead><tr className="text-left text-muted-foreground"><th className={th}>When</th><th className={th}>Direction</th><th className={th}>Number</th><th className={th}>Template</th><th className={th}>Status</th><th className={th}>From</th><th className={th}>Error</th></tr></thead>
          <tbody>
            {msgs.map((m) => (
              <tr key={m.id} className="border-t border-border/60 align-top" title={m.history.map((h) => `${h.status} ${h.at}`).join('\n')}>
                <td className="py-1.5 pr-2">{fmtRelative(m.createdOn)}</td>
                <td className="pr-2">{m.direction === 'out' ? 'Sent' : 'Received'}</td>
                <td className="pr-2 font-mono">{m.phone}</td>
                <td className="pr-2">{m.template ? `${m.template} (${m.language})` : m.kind}</td>
                <td className="pr-2">{m.status}</td>
                <td className="pr-2">{m.source ?? ''}{m.idempotencyKey ? <div className="text-muted-foreground">{m.idempotencyKey}</div> : null}</td>
                <td>{m.error ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!msgs.length && <p className="text-xs text-muted-foreground">No messages yet. Entries are kept 90 days (Admin console &gt; Jobs, "WhatsApp message log retention").</p>}
      </Panel>

      <Panel className="grid gap-3 p-4">
        <div className="text-sm font-semibold">Keywords</div>
        <p className="text-xs text-muted-foreground">A message that is exactly one of these words (any case, punctuation ignored) opts the number out or in again. Separate with commas.</p>
        <Field label="Stop"><Input value={stop} onChange={(e) => setStop(e.target.value)} data-testid="wa-stop-keywords" /></Field>
        <Field label="Start"><Input value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <div className="flex gap-2"><Button size="sm" onClick={() => void saveKeywords()}>Save keywords</Button><Button size="sm" variant="outline" onClick={() => { setStop(st.defaults.stop.join(', ')); setStart(st.defaults.start.join(', ')) }}>Defaults</Button></div>
      </Panel>

      <Panel className="grid gap-3 p-4">
        <div className="text-sm font-semibold">Notifications on WhatsApp</div>
        <p className="text-xs text-muted-foreground">People can choose WhatsApp in Settings &gt; Notifications once this is set and their own number is opted in. The template must be approved by Meta and have one body value per item chosen below.</p>
        <div className="grid gap-2 sm:grid-cols-4">
          <Field label="Connection"><select className={sel} value={map.connectionId} onChange={(e) => setMap({ ...map, connectionId: e.target.value })} data-testid="wa-map-connection"><option value="">Choose</option>{connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Template"><Input value={map.template} onChange={(e) => setMap({ ...map, template: e.target.value.trim() })} placeholder="appbuilder_alert" data-testid="wa-map-template" /></Field>
          <Field label="Language"><Input value={map.language} onChange={(e) => setMap({ ...map, language: e.target.value.trim() })} placeholder="en" /></Field>
          <Field label="Values, in order">
            <div className="flex gap-2 text-xs">
              {(['title', 'body', 'link'] as const).map((p) => (
                <label key={p} className="flex items-center gap-1"><input type="checkbox" checked={map.params.includes(p)} onChange={(e) => setMap({ ...map, params: e.target.checked ? [...map.params, p] : map.params.filter((x) => x !== p) })} />{p}</label>
              ))}
            </div>
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><Switch checked={map.enabled} onCheckedChange={(v) => setMap({ ...map, enabled: v })} aria-label="WhatsApp notifications enabled" /> Enabled</label>
        <div className="flex gap-2"><Button size="sm" disabled={!map.connectionId || !map.template} onClick={() => void saveMapping(map)} data-testid="wa-map-save">Check with Meta and save</Button>{st.notifications && <Button size="sm" variant="outline" onClick={() => void saveMapping(null)}>Remove</Button>}</div>
      </Panel>
    </div>
  )
}
