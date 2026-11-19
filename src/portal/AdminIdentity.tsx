/**
 * Admin console pages of identity basics (P0 package I): Sign-in and security (policy, sign-in log), Email (SMTP relay,
 * test email, delivery log) and Service accounts (API keys). Install administrators change them; other environment
 * administrators see a read-only note. Server mode only.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Copy, KeyRound, Plus, RefreshCw, Send, Trash2 } from 'lucide-react'
import { usePlatform } from '@/platform'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog, Empty, Field, Panel, Segmented, errMsg, fmtDate, fmtRelative, useToast } from './kit'
import { useCaps } from './security'
import { PasswordInput } from './PasswordFields'
import { SignInTable, isCancelled, useReauth } from './Identity'
import {
  createApiKey, createServiceAccount, deleteServiceAccount, emailLog, getEmailSettings, getPolicy, removeEmailSettings, revokeApiKey, saveEmailSettings,
  savePolicy, sendTestEmail, serviceAccounts, signInLog, updateServiceAccount, type MailLogEntry, type MfaMode, type SecurityPolicy, type ServiceAccount,
  type SignInEntry, type SmtpOAuth, type SmtpSettings,
} from './identityApi'

type TitleFn = (title: string, subtitle?: ReactNode, actions?: ReactNode) => ReactNode

function ServerOnly({ what }: { what: string }) {
  return <Empty icon={KeyRound} title={`${what} needs the local server`} description="Demo mode has no sign-in, email or API keys. Start the server (npm start) to use this page." />
}

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <Panel className="mb-5 p-4" data-testid={testId}>
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      <div className="grid gap-3">{children}</div>
    </Panel>
  )
}

const NumberField = ({ label, value, onChange, min, max, hint, id, disabled }: { label: string; value: number; onChange(n: number): void; min: number; max: number; hint?: string; id: string; disabled?: boolean }) => (
  <Field label={label} htmlFor={id} hint={hint}>
    <Input id={id} type="number" min={min} max={max} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} className="h-8 w-32" data-testid={id} />
  </Field>
)

/* ================================================================ sign-in and security */

export function SignInSecuritySection({ title }: { title: TitleFn }) {
  const server = usePlatform((s) => s.mode) === 'server'
  const environments = usePlatform((s) => s.environments)
  const caps = useCaps()
  const { toast, fail } = useToast()
  const [p, setP] = useState<SecurityPolicy | null>(null)
  const [saved, setSaved] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<{ items: SignInEntry[]; total: number; page: number } | null>(null)
  const [outcome, setOutcome] = useState<'all' | 'failure' | 'success'>('all')
  const [page, setPage] = useState(1)
  const edit = caps.isInstallAdmin
  useEffect(() => {
    if (!server) return
    getPolicy().then((r) => { setP(r.policy); setSaved(JSON.stringify(r.policy)) }).catch(fail)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server])
  useEffect(() => {
    if (!server || !caps.isInstallAdmin) return
    signInLog({ outcome: outcome === 'all' ? undefined : outcome, page, pageSize: 25 }).then(setLog).catch(fail)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, outcome, page, caps.isInstallAdmin])
  if (!server) return <ServerOnly what="Sign-in and security" />
  if (!p) return <Spinner />
  const set = <K extends keyof SecurityPolicy>(k: K, v: Partial<SecurityPolicy[K]>) => setP({ ...p, [k]: { ...(p[k] as object), ...v } } as SecurityPolicy)
  const dirty = JSON.stringify(p) !== saved
  const save = async () => {
    setBusy(true)
    try {
      const r = await savePolicy(p)
      setP(r.policy)
      setSaved(JSON.stringify(r.policy))
      toast('Sign-in and security policy saved', 'success')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const modes: { value: MfaMode; label: string }[] = [{ value: 'off', label: 'Off' }, { value: 'admins', label: 'Administrators' }, { value: 'all', label: 'Everyone' }]
  return (
    <div data-testid="admin-security">
      {title('Sign-in and security', 'Two-step verification, sessions, passwords and lockout for every account of this install.', edit && (
        <Button size="sm" disabled={!dirty || busy} onClick={() => void save()} data-testid="policy-save">{busy && <Spinner />} Save changes</Button>
      ))}
      {!edit && <p className="mb-4 text-sm text-muted-foreground">Only install administrators change these settings.</p>}
      <Section title="Two-step verification" testId="policy-mfa">
        <Field label="Required for (whole install)" hint="People it applies to must set up an authenticator app (or email codes). After the grace period, signing in leads straight to the setup.">
          <Segmented label="Required for" value={p.mfa.mode} disabled={!edit} onChange={(v) => set('mfa', { mode: v })} options={modes} />
        </Field>
        {environments.length > 0 && (
          <Field label="Per environment" hint="Stricter rules for people who may enter an environment (for example Production).">
            <div className="grid gap-1.5">
              {environments.map((e) => (
                <div key={e.id} className="flex items-center gap-3 text-sm">
                  <span className="w-40 truncate">{e.name}</span>
                  <Segmented label={`Required in ${e.name}`} size="sm" disabled={!edit} value={p.mfa.environments[e.id] ?? 'off'} onChange={(v) => set('mfa', { environments: { ...p.mfa.environments, [e.id]: v } })} options={modes} />
                </div>
              ))}
            </div>
          </Field>
        )}
        <div className="flex flex-wrap gap-6">
          <NumberField id="policy-grace" label="Grace period (days)" value={p.mfa.graceDays} min={0} max={90} disabled={!edit} onChange={(n) => set('mfa', { graceDays: n })} hint="Counted from when the rule was tightened or the account was created." />
          <NumberField id="policy-remember" label="Remember a device for (days)" value={p.mfa.rememberDays} min={0} max={90} disabled={!edit} onChange={(n) => set('mfa', { rememberDays: n })} hint="0: always ask for the code." />
        </div>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={p.mfa.emailCodes} disabled={!edit} onCheckedChange={(v) => set('mfa', { emailCodes: v === true })} /> Allow email codes as the second step (needs email set up)</label>
        {p.mfa.since && <p className="text-xs text-muted-foreground">Last tightened {fmtDate(p.mfa.since)}.</p>}
      </Section>
      <Section title="Sessions" testId="policy-sessions">
        <div className="flex flex-wrap gap-6">
          <NumberField id="policy-idle" label="Sign out after inactivity (minutes)" value={p.sessions.idleMinutes} min={5} max={129600} disabled={!edit} onChange={(n) => set('sessions', { idleMinutes: n })} hint="Default 10080 (7 days)." />
          <NumberField id="policy-absolute" label="Longest session (hours)" value={p.sessions.absoluteHours} min={0} max={8760} disabled={!edit} onChange={(n) => set('sessions', { absoluteHours: n })} hint="However active; 0 = no limit. Default 720 (30 days)." />
        </div>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={p.notifyNewDevice} disabled={!edit} onCheckedChange={(v) => setP({ ...p, notifyNewDevice: v === true })} /> Email people when their account signs in on a new device (needs email set up)</label>
      </Section>
      <Section title="Passwords" testId="policy-passwords">
        <div className="flex flex-wrap gap-6">
          <NumberField id="policy-minlength" label="Minimum length" value={p.password.minLength} min={8} max={64} disabled={!edit} onChange={(n) => set('password', { minLength: n })} />
          <NumberField id="policy-history" label="Cannot reuse the last" value={p.password.historyCount} min={0} max={24} disabled={!edit} onChange={(n) => set('password', { historyCount: n })} hint="Passwords (0 = off)." />
          <NumberField id="policy-maxage" label="Must change after (days)" value={p.password.maxAgeDays} min={0} max={3650} disabled={!edit} onChange={(n) => set('password', { maxAgeDays: n })} hint="0 = never (recommended)." />
        </div>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={p.password.checkCommon} disabled={!edit} onCheckedChange={(v) => set('password', { checkCommon: v === true })} /> Refuse common passwords (a bundled list of about 2,000)</label>
      </Section>
      <Section title="Lockout" testId="policy-lockout">
        <div className="flex flex-wrap gap-6">
          <NumberField id="policy-attempts" label="Wrong passwords per email and address" value={p.lockout.attempts} min={3} max={100} disabled={!edit} onChange={(n) => set('lockout', { attempts: n })} />
          <NumberField id="policy-window" label="... within (minutes)" value={p.lockout.windowMinutes} min={1} max={1440} disabled={!edit} onChange={(n) => set('lockout', { windowMinutes: n })} />
          <NumberField id="policy-slow" label="Slow down after (per email, an hour)" value={p.lockout.slowDownFrom} min={3} max={1000} disabled={!edit} onChange={(n) => set('lockout', { slowDownFrom: n })} />
          <NumberField id="policy-block" label="Block the email after (an hour)" value={p.lockout.blockAt} min={5} max={10000} disabled={!edit} onChange={(n) => set('lockout', { blockAt: n })} />
          <NumberField id="policy-mfa-attempts" label="Wrong second-step codes" value={p.lockout.mfaAttempts} min={3} max={100} disabled={!edit} onChange={(n) => set('lockout', { mfaAttempts: n })} />
          <NumberField id="policy-mfa-lock" label="... lock the second step for (minutes)" value={p.lockout.mfaLockMinutes} min={1} max={1440} disabled={!edit} onChange={(n) => set('lockout', { mfaLockMinutes: n })} />
        </div>
        <p className="text-xs text-muted-foreground">Counters live in the server's memory: a restart clears them.</p>
      </Section>
      {caps.isInstallAdmin && (
        <Section title="Sign-in log" testId="signin-log">
          <p className="text-xs text-muted-foreground">Entries older than 180 days are deleted every night (schedule "Sign-in log retention" on the Jobs page of the Default environment, where an install administrator can change the number of days).</p>
          <div className="flex items-center gap-2">
            <Segmented label="Outcome" size="sm" value={outcome} onChange={(v) => { setOutcome(v); setPage(1) }} options={[{ value: 'all', label: 'All' }, { value: 'failure', label: 'Failures' }, { value: 'success', label: 'Successes' }]} />
            <span className="ml-auto text-xs text-muted-foreground">{log ? `${log.total} entries` : ''}</span>
            <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</Button>
            <Button size="sm" variant="ghost" disabled={!log || page * 25 >= log.total} onClick={() => setPage(page + 1)}>Older</Button>
          </div>
          {log ? <SignInTable items={log.items} showUser /> : <Spinner />}
        </Section>
      )}
    </div>
  )
}

/* ================================================================ email */

const OAUTH_DEFAULT: SmtpOAuth = { provider: 'microsoft', grant: 'client_credentials', tenant: '', tokenUrl: '', clientId: '', scope: '' }
const EMPTY_SMTP: SmtpSettings = { host: '', port: 587, security: 'starttls', username: '', hasPassword: false, verifyCertificate: true, fromAddress: '', fromName: '', replyTo: '', installName: 'Appbuilder', publicUrl: '' }

export function EmailSection({ title }: { title: TitleFn }) {
  const server = usePlatform((s) => s.mode) === 'server'
  const me = usePlatform((s) => s.session?.user.email ?? '')
  const caps = useCaps()
  const { toast, fail } = useToast()
  const [cur, setCur] = useState<SmtpSettings | null | undefined>(undefined)
  const [f, setF] = useState<SmtpSettings>(EMPTY_SMTP)
  const [password, setPassword] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [refreshToken, setRefreshToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [testTo, setTestTo] = useState('')
  const [testResult, setTestResult] = useState('')
  const [log, setLog] = useState<{ items: MailLogEntry[]; total: number } | null>(null)
  const [remove, setRemove] = useState(false)
  const load = () => {
    getEmailSettings().then((r) => {
      setCur(r.settings)
      setF(r.settings ?? { ...EMPTY_SMTP, publicUrl: location.origin })
    }).catch((e) => { setCur(null); fail(e) })
    emailLog().then(setLog).catch(() => setLog(null))
  }
  useEffect(() => {
    if (server && caps.isInstallAdmin) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, caps.isInstallAdmin])
  useEffect(() => { setTestTo(me) }, [me])
  if (!server) return <ServerOnly what="Email" />
  if (!caps.isInstallAdmin) return <Empty icon={KeyRound} title="Install administrators only" description="The SMTP relay is set up for the whole install by an install administrator." />
  if (cur === undefined) return <Spinner />
  const set = (p: Partial<SmtpSettings>) => setF({ ...f, ...p })
  const save = async () => {
    setBusy(true)
    try {
      const oauth = f.auth === 'oauth2' ? { ...(f.oauth2 ?? OAUTH_DEFAULT), ...(clientSecret ? { clientSecret } : {}), ...(refreshToken ? { refreshToken } : {}) } : undefined
      const r = await saveEmailSettings({ ...f, oauth2: oauth, ...(password ? { password } : {}) })
      setCur(r.settings)
      setF(r.settings)
      setPassword('')
      setClientSecret('')
      setRefreshToken('')
      toast('Email settings saved', 'success')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const test = async () => {
    setBusy(true)
    setTestResult('')
    try {
      const r = await sendTestEmail(testTo)
      setTestResult(`Sent to ${r.to}. The relay answered: ${r.response}`)
      toast('Test email sent', 'success')
    } catch (e) {
      setTestResult(errMsg(e))
    } finally {
      setBusy(false)
      emailLog().then(setLog).catch(() => {})
    }
  }
  return (
    <div data-testid="admin-email">
      {title('Email', 'The SMTP relay Appbuilder sends system email through: password resets, invitations, sign-in codes and new-device notices (and, from P1, notifications).',
        <Badge variant={cur ? 'secondary' : 'outline'} data-testid="email-state">{cur ? 'Set up' : 'Not set up'}</Badge>)}
      {!cur && <p className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">Without email: people who forget their password need a one-time reset code from an administrator (Users), new people get a temporary password instead of an invitation, and email codes and new-device notices are off.</p>}
      <Section title="Relay" testId="email-relay">
        <div className="grid grid-cols-[1fr_110px] gap-3">
          <Field label="SMTP host" htmlFor="smtp-host"><Input id="smtp-host" value={f.host} onChange={(e) => set({ host: e.target.value })} placeholder="smtp.example.com" data-testid="smtp-host" /></Field>
          <Field label="Port" htmlFor="smtp-port"><Input id="smtp-port" inputMode="numeric" value={String(f.port)} onChange={(e) => set({ port: Number(e.target.value.replace(/[^0-9]/g, '')) || 0 })} data-testid="smtp-port" /></Field>
        </div>
        <Field label="Security" hint="STARTTLS on port 587 is the usual choice; TLS for port 465; None only for a relay on this computer.">
          <Segmented label="Security" value={f.security} onChange={(v) => set({ security: v, port: v === 'tls' ? 465 : v === 'starttls' && f.port === 465 ? 587 : f.port })} options={[{ value: 'starttls', label: 'STARTTLS' }, { value: 'tls', label: 'TLS' }, { value: 'none', label: 'None' }]} />
        </Field>
        <Field label="Sign-in" hint="Microsoft 365 and Google Workspace accept OAuth 2.0 (AUTH XOAUTH2); a password works where the provider still allows SMTP AUTH with a password or an app password.">
          <Segmented label="Sign-in" value={f.auth ?? 'password'} onChange={(v) => set({ auth: v, ...(v === 'oauth2' && !f.oauth2 ? { oauth2: OAUTH_DEFAULT } : {}) })} options={[{ value: 'password', label: 'Password' }, { value: 'oauth2', label: 'OAuth 2.0' }]} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={f.auth === 'oauth2' ? 'Mailbox (sends the mail)' : 'User name'} htmlFor="smtp-user"><Input id="smtp-user" autoComplete="off" value={f.username} onChange={(e) => set({ username: e.target.value })} data-testid="smtp-user" placeholder={f.auth === 'oauth2' ? 'appbuilder@example.com' : ''} /></Field>
          {f.auth !== 'oauth2' && <Field label="Password" htmlFor="smtp-password" hint={cur?.hasPassword ? 'Stored encrypted. Leave empty to keep it.' : 'Stored encrypted with the install key; never shown again.'}><PasswordInput id="smtp-password" autoComplete="new-password" value={password} onChange={setPassword} testId="smtp-password" /></Field>}
        </div>
        {f.auth === 'oauth2' && (() => {
          const o = f.oauth2 ?? OAUTH_DEFAULT
          const setO = (p: Partial<SmtpOAuth>) => set({ oauth2: { ...o, ...p } })
          return (
            <div className="grid gap-3 rounded-lg border border-border p-3" data-testid="smtp-oauth">
              <Field label="Provider">
                <Segmented label="Provider" value={o.provider} onChange={(v) => setO({ provider: v, grant: v === 'google' ? 'refresh_token' : o.grant, tokenUrl: '', scope: '' })} options={[{ value: 'microsoft', label: 'Microsoft 365' }, { value: 'google', label: 'Google Workspace' }, { value: 'custom', label: 'Other' }]} />
              </Field>
              {o.provider !== 'google' && (
                <Field label="Grant" hint={o.grant === 'client_credentials' ? 'App-only: the app has the application permission SMTP.SendAsApp, its service principal is registered in Exchange Online and has rights on the mailbox.' : 'A refresh token obtained once for the mailbox (delegated permission SMTP.Send with offline_access).'}>
                  <Segmented label="Grant" value={o.grant} onChange={(v) => setO({ grant: v, scope: '' })} options={[{ value: 'client_credentials', label: 'Client credentials' }, { value: 'refresh_token', label: 'Refresh token' }]} />
                </Field>
              )}
              <div className="grid grid-cols-2 gap-3">
                {o.provider === 'microsoft' && <Field label="Tenant" htmlFor="smtp-oauth-tenant" hint="Directory id or domain, e.g. contoso.onmicrosoft.com"><Input id="smtp-oauth-tenant" value={o.tenant} onChange={(e) => setO({ tenant: e.target.value })} data-testid="smtp-oauth-tenant" /></Field>}
                <Field label="Client (application) id" htmlFor="smtp-oauth-client"><Input id="smtp-oauth-client" autoComplete="off" value={o.clientId} onChange={(e) => setO({ clientId: e.target.value })} data-testid="smtp-oauth-client" /></Field>
                <Field label="Client secret" htmlFor="smtp-oauth-secret" hint={o.hasClientSecret ? 'Stored encrypted. Leave empty to keep it.' : o.grant === 'refresh_token' ? 'Needed by Google and by confidential Microsoft apps.' : 'Stored encrypted; never shown again.'}><PasswordInput id="smtp-oauth-secret" autoComplete="new-password" value={clientSecret} onChange={setClientSecret} testId="smtp-oauth-secret" /></Field>
                {o.grant === 'refresh_token' && <Field label="Refresh token" htmlFor="smtp-oauth-refresh" hint={o.hasRefreshToken ? 'Stored encrypted. Leave empty to keep it; a rotated token is stored automatically.' : 'Stored encrypted; never shown again.'}><PasswordInput id="smtp-oauth-refresh" autoComplete="off" value={refreshToken} onChange={setRefreshToken} testId="smtp-oauth-refresh" /></Field>}
                <Field label="Token address (optional)" htmlFor="smtp-oauth-url" hint="Empty: the provider's default."><Input id="smtp-oauth-url" value={o.tokenUrl} onChange={(e) => setO({ tokenUrl: e.target.value })} placeholder={o.provider === 'google' ? 'https://oauth2.googleapis.com/token' : o.provider === 'microsoft' ? 'https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token' : 'https://...'} /></Field>
                <Field label="Scope (optional)" htmlFor="smtp-oauth-scope" hint="Empty: the provider's default."><Input id="smtp-oauth-scope" value={o.scope} onChange={(e) => setO({ scope: e.target.value })} placeholder={o.provider === 'google' ? 'https://mail.google.com/' : o.grant === 'client_credentials' ? 'https://outlook.office365.com/.default' : 'https://outlook.office.com/SMTP.Send offline_access'} /></Field>
              </div>
              <p className="text-xs text-muted-foreground">The token is fetched by the server through the outbound network policy and kept in memory until it expires. See the admin guide, installation, "Email with Microsoft 365 or Google Workspace".</p>
            </div>
          )
        })()}
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={f.verifyCertificate} onCheckedChange={(v) => set({ verifyCertificate: v === true })} /> Verify the relay's certificate (turn off only for an internal relay with a self-signed certificate)</label>
      </Section>
      <Section title="Sender and branding" testId="email-sender">
        <div className="grid grid-cols-2 gap-3">
          <Field label="From address" htmlFor="smtp-from"><Input id="smtp-from" type="email" value={f.fromAddress} onChange={(e) => set({ fromAddress: e.target.value })} placeholder="appbuilder@example.com" data-testid="smtp-from" /></Field>
          <Field label="From name" htmlFor="smtp-from-name"><Input id="smtp-from-name" value={f.fromName} onChange={(e) => set({ fromName: e.target.value })} placeholder="Acme Apps" /></Field>
          <Field label="Reply-to (optional)" htmlFor="smtp-reply"><Input id="smtp-reply" type="email" value={f.replyTo} onChange={(e) => set({ replyTo: e.target.value })} /></Field>
          <Field label="Install name (in every email)" htmlFor="smtp-install"><Input id="smtp-install" value={f.installName} onChange={(e) => set({ installName: e.target.value })} data-testid="smtp-install-name" /></Field>
        </div>
        <Field label="Public address" htmlFor="smtp-url" hint="Where people open Appbuilder; links in emails start with it."><Input id="smtp-url" value={f.publicUrl} onChange={(e) => set({ publicUrl: e.target.value })} placeholder="https://apps.example.com" data-testid="smtp-url" /></Field>
        <div className="flex gap-2">
          <Button size="sm" disabled={busy || !f.host || !f.fromAddress} onClick={() => void save()} data-testid="smtp-save">{busy && <Spinner />} Save</Button>
          {cur && <Button size="sm" variant="outline" onClick={() => setRemove(true)}>Remove</Button>}
        </div>
      </Section>
      {cur && (
        <Section title="Send a test email" testId="email-test">
          <div className="flex items-end gap-2">
            <Field label="To" htmlFor="smtp-test-to"><Input id="smtp-test-to" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} className="w-72" data-testid="smtp-test-to" /></Field>
            <Button size="sm" disabled={busy || !testTo} onClick={() => void test()} data-testid="smtp-test"><Send /> Send test email</Button>
          </div>
          {testResult && <p className="text-sm" data-testid="smtp-test-result">{testResult}</p>}
        </Section>
      )}
      <Section title="Delivery log" testId="email-log">
        <div className="flex items-center"><span className="text-xs text-muted-foreground">Recipient, subject and status only; message bodies are never stored. Entries older than 90 days are deleted every night (schedule "Email delivery log retention", Jobs page of the Default environment).</span><Button size="sm" variant="ghost" className="ml-auto" onClick={() => emailLog().then(setLog).catch(fail)}><RefreshCw /> Refresh</Button></div>
        {!log?.items.length ? <p className="py-3 text-center text-sm text-muted-foreground">Nothing sent yet.</p> : (
          <table className="w-full text-sm" data-testid="email-log-table">
            <thead><tr className="border-b border-border text-left text-xs text-muted-foreground"><th className="px-2 py-2 font-medium">Queued</th><th className="px-2 py-2 font-medium">To</th><th className="px-2 py-2 font-medium">Subject</th><th className="px-2 py-2 font-medium">Status</th></tr></thead>
            <tbody>
              {log.items.map((m) => (
                <tr key={m.id} className="border-b border-border last:border-0">
                  <td className="whitespace-nowrap px-2 py-1.5 text-xs" title={fmtDate(m.createdOn)}>{fmtRelative(m.createdOn)}</td>
                  <td className="truncate px-2 py-1.5 text-xs">{m.to}</td>
                  <td className="truncate px-2 py-1.5 text-xs">{m.subject}</td>
                  <td className="px-2 py-1.5 text-xs" title={m.lastError ?? undefined}>
                    <Badge variant={m.status === 'failed' ? 'destructive' : m.status === 'sent' ? 'secondary' : 'outline'}>{m.status}</Badge>
                    {m.attempts > 1 && <span className="ml-1 text-muted-foreground">{m.attempts} tries</span>}
                    {m.lastError && m.status !== 'sent' && <div className="mt-0.5 max-w-80 truncate text-destructive">{m.lastError}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <ConfirmDialog open={remove} onOpenChange={setRemove} title="Remove the email settings?" description="Password resets fall back to administrator reset codes, invitations to temporary passwords; email codes and notices stop." confirmLabel="Remove" onConfirm={async () => { await removeEmailSettings(); toast('Email settings removed', 'success'); load() }} />
    </div>
  )
}

/* ================================================================ service accounts */

export function ServiceAccountsSection({ title }: { title: TitleFn }) {
  const server = usePlatform((s) => s.mode) === 'server'
  const environments = usePlatform((s) => s.environments)
  const environmentId = usePlatform((s) => s.environmentId)
  const roles = usePlatform((s) => s.roles)
  const caps = useCaps()
  const { toast, fail } = useToast()
  const { run, dialog } = useReauth()
  const [items, setItems] = useState<ServiceAccount[] | null>(null)
  const [create, setCreate] = useState(false)
  const [name, setName] = useState('')
  const [roleIds, setRoleIds] = useState<string[]>([])
  const [keyFor, setKeyFor] = useState<ServiceAccount | null>(null)
  const [keyName, setKeyName] = useState('')
  const [keyDays, setKeyDays] = useState('')
  const [keyIps, setKeyIps] = useState('')
  const [keyRate, setKeyRate] = useState('')
  const [shown, setShown] = useState<string | null>(null)
  const [del, setDel] = useState<ServiceAccount | null>(null)
  const load = () => { serviceAccounts().then((r) => setItems(r.items)).catch(fail) }
  useEffect(() => {
    if (server && caps.isInstallAdmin) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, caps.isInstallAdmin])
  if (!server) return <ServerOnly what="Service accounts" />
  if (!caps.isInstallAdmin) return <Empty icon={KeyRound} title="Install administrators only" description="Service accounts and API keys are managed by install administrators." />
  const envName = (id: string) => environments.find((e) => e.id === id)?.name ?? id
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id
  const makeKey = async () => {
    if (!keyFor) return
    try {
      const r = await run(() => createApiKey(keyFor.id, { name: keyName || 'API key', ...(keyDays ? { expiresInDays: Number(keyDays) } : {}), ...(keyIps ? { ipAllow: keyIps } : {}), ...(keyRate ? { ratePerMinute: Number(keyRate) } : {}) }))
      setKeyFor(null)
      setShown(r.key)
      load()
    } catch (e) {
      if (!isCancelled(e)) fail(e)
    }
  }
  return (
    <div data-testid="admin-service-accounts">
      {title('Service accounts', <>Non-human accounts for integrations and the LAN agent. Each belongs to one environment, has roles there, and calls the Data API with API keys (<code className="font-mono">Authorization: Bearer abk_...</code>). They never sign in with a password.</>,
        <Button size="sm" onClick={() => { setName(''); setRoleIds([]); setCreate(true) }} data-testid="sa-new"><Plus /> New service account</Button>)}
      {!items ? <Spinner /> : !items.length ? (
        <Empty icon={KeyRound} title="No service accounts" description="Create one for each integration, so its access can be limited and revoked on its own." />
      ) : items.map((sa) => (
        <Panel key={sa.id} className="mb-4 p-4" data-testid={`sa-${sa.id}`}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="font-medium">{sa.name}</span>
            <Badge variant="outline">{envName(sa.environmentId)}</Badge>
            {sa.status === 'disabled' && <Badge variant="destructive">Disabled</Badge>}
            {sa.roleIds.map((r) => <Badge key={r} variant="secondary">{roleName(r)}</Badge>)}
            {!sa.roleIds.length && <span className="text-xs text-muted-foreground">No roles: it can read nothing yet. Add roles in Users (switch to its environment) or here.</span>}
            <span className="ml-auto flex gap-1">
              <Button size="sm" variant="outline" onClick={() => { void updateServiceAccount(sa.id, { status: sa.status === 'disabled' ? 'active' : 'disabled' }).then(load).catch(fail) }}>{sa.status === 'disabled' ? 'Enable' : 'Disable'}</Button>
              <Button size="sm" onClick={() => { setKeyFor(sa); setKeyName(''); setKeyDays(''); setKeyIps(''); setKeyRate('') }} data-testid={`sa-key-${sa.id}`}><KeyRound /> New API key</Button>
              <Button size="icon-sm" variant="ghost" aria-label={`Delete ${sa.name}`} onClick={() => setDel(sa)}><Trash2 /></Button>
            </span>
          </div>
          {sa.keys.length ? (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-left text-xs text-muted-foreground"><th className="px-2 py-1.5 font-medium">Key</th><th className="px-2 py-1.5 font-medium">Created</th><th className="px-2 py-1.5 font-medium">Expires</th><th className="px-2 py-1.5 font-medium">Last used</th><th className="px-2 py-1.5 font-medium">Limits</th><th /></tr></thead>
              <tbody>
                {sa.keys.map((k) => (
                  <tr key={k.id} className="border-b border-border last:border-0" data-testid={`key-${k.id}`}>
                    <td className="px-2 py-1.5"><div className="font-medium">{k.name}</div><code className="font-mono text-xs text-muted-foreground">abk_{k.prefix}_...</code></td>
                    <td className="px-2 py-1.5 text-xs">{fmtDate(k.createdOn)}</td>
                    <td className="px-2 py-1.5 text-xs">{k.revokedOn ? <Badge variant="destructive">Revoked</Badge> : k.expiresOn ? fmtDate(k.expiresOn) : 'Never'}</td>
                    <td className="px-2 py-1.5 text-xs">{k.lastUsedOn ? `${fmtRelative(k.lastUsedOn)} from ${k.lastUsedIp ?? '?'}` : 'Never'}</td>
                    <td className="px-2 py-1.5 text-xs">{k.ratePerMinute ?? 600}/min{k.ipAllow.length ? `, from ${k.ipAllow.join(', ')}` : ''}</td>
                    <td className="px-2 py-1.5 text-right">{!k.revokedOn && <Button size="sm" variant="ghost" onClick={() => { void revokeApiKey(sa.id, k.id).then(() => { toast('Key revoked', 'success'); load() }).catch(fail) }} data-testid={`key-revoke-${k.id}`}>Revoke</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="text-xs text-muted-foreground">No keys yet.</p>}
        </Panel>
      ))}

      <Dialog open={create} onOpenChange={setCreate}>
        <DialogContent data-testid="sa-dialog">
          <DialogHeader><DialogTitle>New service account</DialogTitle><DialogDescription>In the environment {envName(environmentId)}, with roles from there. Switch environments first to create one elsewhere.</DialogDescription></DialogHeader>
          <div className="grid gap-4">
            <Field label="Name" htmlFor="sa-name"><Input id="sa-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Weighbridge agent" data-testid="sa-name" /></Field>
            <div className="grid gap-1.5">
              <span className="text-xs font-medium">Roles in {envName(environmentId)}</span>
              {roles.map((r) => <label key={r.id} className="flex items-center gap-2 text-sm"><Checkbox checked={roleIds.includes(r.id)} onCheckedChange={(v) => setRoleIds(v === true ? [...roleIds, r.id] : roleIds.filter((x) => x !== r.id))} data-testid={`sa-role-${r.id}`} /> {r.name}</label>)}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreate(false)}>Cancel</Button>
            <Button disabled={!name.trim()} onClick={() => { void createServiceAccount({ name: name.trim(), environmentId, roleIds }).then(() => { setCreate(false); toast('Service account created', 'success'); load() }).catch(fail) }} data-testid="sa-create">Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!keyFor} onOpenChange={(o) => !o && setKeyFor(null)}>
        <DialogContent data-testid="key-dialog">
          <DialogHeader><DialogTitle>New API key for {keyFor?.name}</DialogTitle><DialogDescription>The key is shown once. Store it in the integration's configuration; anyone who has it acts as this service account.</DialogDescription></DialogHeader>
          <div className="grid gap-4">
            <Field label="Name" htmlFor="key-name"><Input id="key-name" value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="Weighbridge PC" data-testid="key-name" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Expires after (days, optional)" htmlFor="key-days"><Input id="key-days" inputMode="numeric" value={keyDays} onChange={(e) => setKeyDays(e.target.value.replace(/[^0-9]/g, ''))} /></Field>
              <Field label="Requests per minute (optional)" htmlFor="key-rate" hint="Default 600."><Input id="key-rate" inputMode="numeric" value={keyRate} onChange={(e) => setKeyRate(e.target.value.replace(/[^0-9]/g, ''))} /></Field>
            </div>
            <Field label="Allowed addresses (optional)" htmlFor="key-ips" hint="IP addresses or ranges, separated by commas, for example 192.168.1.0/24. Empty: any address."><Input id="key-ips" value={keyIps} onChange={(e) => setKeyIps(e.target.value)} data-testid="key-ips" /></Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setKeyFor(null)}>Cancel</Button>
            <Button onClick={() => void makeKey()} data-testid="key-create"><KeyRound /> Create key</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!shown} onOpenChange={(o) => !o && setShown(null)}>
        <DialogContent data-testid="key-shown-dialog">
          <DialogHeader><DialogTitle>Copy the API key now</DialogTitle><DialogDescription>It is not shown again. Only a hash is stored; if it is lost, revoke it and create a new one.</DialogDescription></DialogHeader>
          <code className="break-all rounded-lg border border-border bg-muted/40 p-3 font-mono text-sm" data-testid="key-value">{shown}</code>
          <pre className="overflow-auto rounded-lg bg-muted/40 p-3 text-xs">{`curl -H "Authorization: Bearer ${shown ?? ''}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"plan":{"version":2,"table":"Orders","page":{"size":50}}}' \\\n  ${location.origin}/api/v1/query`}</pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => { void navigator.clipboard?.writeText(shown ?? '').then(() => toast('Key copied', 'success')) }}><Copy /> Copy</Button>
            <Button onClick={() => setShown(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title={`Delete "${del?.name ?? ''}"?`} description="Its API keys stop working at once. Rows it created keep it as their creator." onConfirm={async () => { if (del) { await deleteServiceAccount(del.id); toast('Service account deleted', 'success'); load() } }} />
      {dialog}
    </div>
  )
}
