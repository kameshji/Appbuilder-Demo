/**
 * The WhatsApp part of the connection dialog (P2 package E): ids from WhatsApp Manager, the default country code (91
 * suggested), sending on/off, and the three secrets (write-only). There is no address field: Meta's API address is fixed
 * on the server.
 */
import { PasswordInput } from './PasswordFields'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Field } from './kit'

export const WHATSAPP_DEFAULTS: Record<string, string> = { defaultCountryCode: '91', apiVersion: 'v21.0', sendingEnabled: 'true' }

export const whatsappSettingsOk = (s: Record<string, string>) => /^\d{5,20}$/.test(s.phoneNumberId ?? '') && /^\d{5,20}$/.test(s.businessAccountId ?? '') && /^[1-9]\d{0,2}$/.test(s.defaultCountryCode ?? '')

export function WhatsappConnectionFields({ settings, set, secret, setSecret, hasSecret }: {
  settings: Record<string, string>
  set(k: string, v: string): void
  secret: Record<string, string>
  setSecret(k: string, v: string): void
  hasSecret: boolean
}) {
  const hint = hasSecret ? 'Stored. Type to replace: replacing one replaces all three, so enter all of them.' : 'Stored encrypted; never shown again.'
  return (
    <div className="grid gap-3" data-testid="whatsapp-settings">
      <p className="text-xs text-muted-foreground">Meta WhatsApp Business Cloud API. Messages go only to numbers with a current opt-in (Admin console &gt; WhatsApp). Your business is responsible for consent and for getting templates approved by Meta.</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Phone number id" hint="WhatsApp Manager > API setup"><Input inputMode="numeric" value={settings.phoneNumberId ?? ''} onChange={(e) => set('phoneNumberId', e.target.value.replace(/\D/g, ''))} data-testid="wa-phone-number-id" /></Field>
        <Field label="WhatsApp Business account id"><Input inputMode="numeric" value={settings.businessAccountId ?? ''} onChange={(e) => set('businessAccountId', e.target.value.replace(/\D/g, ''))} data-testid="wa-business-account-id" /></Field>
        <Field label="Default country code" hint="For numbers written without +code (India: 91)"><Input inputMode="numeric" value={settings.defaultCountryCode ?? ''} onChange={(e) => set('defaultCountryCode', e.target.value.replace(/\D/g, '').slice(0, 3))} data-testid="wa-country-code" /></Field>
        <Field label="API version"><Input value={settings.apiVersion ?? ''} placeholder="v21.0" onChange={(e) => set('apiVersion', e.target.value.trim())} /></Field>
        <Field label="Access token" hint={hint}><PasswordInput value={secret.accessToken ?? ''} onChange={(v) => setSecret('accessToken', v)} testId="wa-access-token" /></Field>
        <Field label="App secret" hint="Checks the signature of webhook calls"><PasswordInput value={secret.appSecret ?? ''} onChange={(v) => setSecret('appSecret', v)} testId="wa-app-secret" /></Field>
        <Field label="Webhook verify token" hint="At least 16 characters; enter the same in Meta's webhook settings"><PasswordInput value={secret.verifyToken ?? ''} onChange={(v) => setSecret('verifyToken', v)} testId="wa-verify-token" /></Field>
        <Field label="Inbound flow (optional)" hint="Id of a flow with a webhook trigger, started for each message a person sends"><Input value={settings.inboundFlowId ?? ''} onChange={(e) => set('inboundFlowId', e.target.value.trim())} /></Field>
      </div>
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>Sending enabled<span className="block text-xs text-muted-foreground">Turn off to stop every message from this connection at once (flows and notifications get a refusal).</span></span>
        <Switch checked={settings.sendingEnabled !== 'false'} onCheckedChange={(v) => set('sendingEnabled', v ? 'true' : 'false')} aria-label="Sending enabled" data-testid="wa-sending-enabled" />
      </label>
    </div>
  )
}
