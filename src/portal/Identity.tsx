/**
 * Identity UI pieces (P0 package I), shared by Settings > Profile, the sign-in screens and Admin console > Users:
 * re-authentication before sensitive actions (useReauth), authenticator-app enrolment with a QR code, recovery codes,
 * session lists, email change, sign-in history. Server mode only.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Check, Copy, Download, LogOut, Monitor, ShieldCheck, Smartphone } from 'lucide-react'
import { PlatformError } from '@/platform'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Field, downloadText, errMsg, fmtDate, fmtRelative, useToast } from './kit'
import { PasswordInput } from './PasswordFields'
import {
  changeEmail, confirmTotp, mySignIns, reauthenticate, startTotp, type SessionEntry, type SignInEntry, type TotpStart,
} from './identityApi'

/* ------------------------------------------------------------------ re-authentication */

const CANCELLED = 'reauth-cancelled'
/** the person closed the "confirm it is you" dialog: callers stay quiet */
export const isCancelled = (e: unknown): boolean => e instanceof Error && e.message === CANCELLED

/**
 * Wraps a sensitive action: when the server answers reauth_required, asks for the password (or an authenticator code)
 * and runs the action again. Render `dialog` once in the component.
 */
export function useReauth(): { run<T>(fn: () => Promise<T>): Promise<T>; dialog: ReactNode } {
  const [pending, setPending] = useState<{ resolve(): void; reject(e: Error): void } | null>(null)
  async function run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      if (!(e instanceof PlatformError && e.code === 'reauth_required')) throw e
      await new Promise<void>((resolve, reject) => setPending({ resolve, reject }))
      return fn()
    }
  }
  const dialog = (
    <ReauthDialog
      open={!!pending}
      onDone={() => { pending?.resolve(); setPending(null) }}
      onCancel={() => { pending?.reject(new Error(CANCELLED)); setPending(null) }}
    />
  )
  return { run, dialog }
}

function ReauthDialog({ open, onDone, onCancel }: { open: boolean; onDone(): void; onCancel(): void }) {
  const [useCode, setUseCode] = useState(false)
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { if (open) { setPassword(''); setCode(''); setError(''); setUseCode(false) } }, [open])
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await reauthenticate(useCode ? { code } : { password })
      setPassword('')
      onDone()
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent data-testid="reauth-dialog">
        <DialogHeader>
          <DialogTitle>Confirm it is you</DialogTitle>
          <DialogDescription>This change needs a fresh proof of identity. It stays valid for 10 minutes.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => void submit(e)}>
          {useCode
            ? <Field label="Code from your authenticator app" htmlFor="reauth-code"><Input id="reauth-code" autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))} className="font-mono tracking-widest" data-testid="reauth-code" /></Field>
            : <Field label="Your password" htmlFor="reauth-password"><PasswordInput id="reauth-password" autoFocus autoComplete="current-password" value={password} onChange={setPassword} testId="reauth-password" /></Field>}
          <button type="button" className="justify-self-start text-xs text-primary hover:underline" onClick={() => setUseCode(!useCode)}>
            {useCode ? 'Use my password instead' : 'Use a code from my authenticator app instead'}
          </button>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={busy || (useCode ? code.length !== 6 : !password)} data-testid="reauth-submit">{busy && <Spinner />} Confirm</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ recovery codes */

export function RecoveryCodes({ codes, account }: { codes: string[]; account?: string }) {
  const { toast } = useToast()
  const text = `Recovery codes${account ? ` for ${account}` : ''}\nEach code works once. Keep them somewhere safe.\n\n${codes.join('\n')}\n`
  return (
    <div className="grid gap-3" data-testid="recovery-codes">
      <ol className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border border-border bg-muted/40 p-4 font-mono text-sm">
        {codes.map((c) => <li key={c} className="tracking-wide">{c}</li>)}
      </ol>
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => downloadText('recovery-codes.txt', text)} data-testid="recovery-download"><Download /> Download</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(text).then(() => toast('Recovery codes copied', 'success')) }}><Copy /> Copy</Button>
      </div>
      <p className="text-xs text-muted-foreground">Each code works once, instead of a code from your app, if you lose your phone. They are shown only now; you can make a new set later in Settings.</p>
    </div>
  )
}

export function RecoveryCodesDialog({ codes, onClose }: { codes: string[] | null; onClose(): void }) {
  return (
    <Dialog open={!!codes} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent data-testid="recovery-codes-dialog">
        <DialogHeader>
          <DialogTitle>Save your recovery codes</DialogTitle>
          <DialogDescription>Store them in a password manager or print them. Anyone with a code and your password can sign in.</DialogDescription>
        </DialogHeader>
        {codes && <RecoveryCodes codes={codes} />}
        <DialogFooter><Button onClick={onClose} data-testid="recovery-saved"><Check /> I saved them</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ authenticator app enrolment */

/** the enrolment steps without a dialog frame (also used by the forced-enrolment screen) */
export function TotpEnrolment({ onDone, onCancel }: { onDone(codes: string[] | null): void; onCancel?(): void }) {
  const [start, setStart] = useState<TotpStart | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showKey, setShowKey] = useState(false)
  useEffect(() => {
    startTotp().then(setStart).catch((e) => setError(errMsg(e)))
  }, [])
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const r = await confirmTotp(code)
      onDone(r.recoveryCodes)
    } catch (err) {
      setError(errMsg(err))
      setCode('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="grid gap-4" onSubmit={(e) => void submit(e)} data-testid="totp-enrolment">
      <ol className="grid gap-1 text-sm text-muted-foreground">
        <li><b className="text-foreground">1.</b> Open an authenticator app on your phone (for example Google Authenticator, Microsoft Authenticator, 1Password or Aegis).</li>
        <li><b className="text-foreground">2.</b> Scan this QR code, or type the key by hand.</li>
        <li><b className="text-foreground">3.</b> Type the 6-digit code the app shows.</li>
      </ol>
      <div className="flex items-start gap-4">
        <div className="grid size-44 shrink-0 place-items-center rounded-lg border border-border bg-white p-2" data-testid="totp-qr">
          {/* server-made SVG: one path, no scripts or styles */}
          {start ? <div className="size-full [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: start.qrSvg }} /> : <Spinner />}
        </div>
        <div className="grid min-w-0 gap-2 text-xs text-muted-foreground">
          {start && <span>Account: <b className="text-foreground">{start.account}</b><br />Issuer: <b className="text-foreground">{start.issuer}</b></span>}
          {showKey && start
            ? <code className="break-all rounded bg-muted px-2 py-1.5 font-mono text-[13px] text-foreground" data-testid="totp-key">{start.secret}</code>
            : <button type="button" className="justify-self-start text-primary hover:underline" onClick={() => setShowKey(true)} data-testid="totp-show-key">Cannot scan? Show the key</button>}
          {showKey && <span>Time-based, 6 digits, every 30 seconds.</span>}
        </div>
      </div>
      <Field label="Code from the app" htmlFor="totp-code">
        <Input id="totp-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))} className="w-40 font-mono text-lg tracking-[0.3em]" data-testid="totp-code" />
      </Field>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" disabled={busy || code.length !== 6 || !start} data-testid="totp-confirm">{busy ? <Spinner /> : <ShieldCheck />} Turn on</Button>
      </div>
    </form>
  )
}

export function TotpEnrolDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange(o: boolean): void; onDone(codes: string[] | null): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="totp-dialog">
        <DialogHeader>
          <DialogTitle>Set up an authenticator app</DialogTitle>
          <DialogDescription>After this, signing in asks for a code from the app as well as your password.</DialogDescription>
        </DialogHeader>
        {open && <TotpEnrolment onDone={(c) => { onOpenChange(false); onDone(c) }} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ sessions */

export function SessionList({ items, onEnd, busyId, testId = 'session-list' }: { items: SessionEntry[]; onEnd(s: SessionEntry): void; busyId?: string | null; testId?: string }) {
  if (!items.length) return <p className="py-4 text-center text-sm text-muted-foreground">No active sessions.</p>
  return (
    <ul className="divide-y divide-border rounded-lg border border-border" data-testid={testId}>
      {items.map((s) => {
        const Icon = /iOS|Android/.test(s.device) ? Smartphone : Monitor
        return (
          <li key={s.id} className="flex items-center gap-3 px-3 py-2.5" data-testid={`session-${s.id}`}>
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className="truncate">{s.device}</span>
                {s.current && <Badge variant="secondary" data-testid="session-current">This browser</Badge>}
                {s.mfa && <Badge variant="outline" title="Signed in with two-step verification">2-step</Badge>}
              </div>
              <div className="text-xs text-muted-foreground">
                {s.ip ?? 'Unknown address'} · signed in {fmtDate(s.createdOn)} · last seen <span title={fmtDate(s.lastSeen)}>{fmtRelative(s.lastSeen)}</span>
              </div>
            </div>
            <Button size="sm" variant="ghost" disabled={busyId === s.id} onClick={() => onEnd(s)} data-testid={`session-end-${s.id}`}>
              {busyId === s.id ? <Spinner /> : <LogOut />} {s.current ? 'Sign out' : 'End'}
            </Button>
          </li>
        )
      })}
    </ul>
  )
}

/* ------------------------------------------------------------------ email change */

export function ChangeEmailDialog({ open, onOpenChange, run }: { open: boolean; onOpenChange(o: boolean): void; run<T>(fn: () => Promise<T>): Promise<T> }) {
  const { toast, fail } = useToast()
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) setEmail('') }, [open])
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const r = await run(() => changeEmail(email.trim()))
      toast(`We sent a confirmation link to ${r.sentTo}. Your email changes when you open it.`, 'success')
      onOpenChange(false)
    } catch (err) {
      if (!isCancelled(err)) fail(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="change-email-dialog">
        <DialogHeader>
          <DialogTitle>Change your sign-in email</DialogTitle>
          <DialogDescription>We send a confirmation link to the new address, and a notice to the current one. Nothing changes until the link is opened (it works for 24 hours).</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => void submit(e)}>
          <Field label="New email address" htmlFor="new-email"><Input id="new-email" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} data-testid="new-email" /></Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())} data-testid="new-email-send">{busy && <Spinner />} Send confirmation</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ sign-in history */

export const REASONS: Record<string, string> = {
  ok: 'Signed in', bad_password: 'Wrong password', unknown_user: 'Unknown email', disabled: 'Account disabled', no_password: 'No password set',
  throttled: 'Too many attempts', locked: 'Second step locked', bad_code: 'Wrong code', replay: 'Code used twice', service_account: 'Service account',
  bad_reset_token: 'Invalid reset code', malformed_key: 'Malformed API key', unknown_key: 'Unknown API key', revoked_key: 'Revoked API key',
  expired_key: 'Expired API key', ip_denied: 'Address not allowed', account_disabled: 'Account disabled',
}
export const METHODS: Record<string, string> = {
  password: 'Password', totp: 'Authenticator app', recovery_code: 'Recovery code', email_code: 'Email code', remembered_device: 'Remembered device',
  invitation: 'Invitation', api_key: 'API key', second_step: 'Second step', reset_link: 'Reset link', reset_code: 'Reset code',
}

export function SignInTable({ items, showUser }: { items: SignInEntry[]; showUser?: boolean }) {
  if (!items.length) return <p className="py-4 text-center text-sm text-muted-foreground">No sign-ins recorded yet.</p>
  return (
    <table className="w-full text-sm" data-testid="signin-table">
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted-foreground">
          <th className="px-2 py-2 font-medium">When</th>{showUser && <th className="px-2 py-2 font-medium">Account</th>}<th className="px-2 py-2 font-medium">Result</th><th className="px-2 py-2 font-medium">Method</th><th className="px-2 py-2 font-medium">Device and address</th>
        </tr>
      </thead>
      <tbody>
        {items.map((e) => (
          <tr key={e.id} className="border-b border-border last:border-0">
            <td className="whitespace-nowrap px-2 py-1.5 text-xs" title={fmtDate(e.at)}>{fmtRelative(e.at)}</td>
            {showUser && <td className="truncate px-2 py-1.5 text-xs">{e.email ?? e.userId ?? 'Unknown'}</td>}
            <td className="px-2 py-1.5 text-xs">
              {e.outcome === 'success'
                ? <span className="text-emerald-700 dark:text-emerald-300">Signed in{e.newDevice ? ' (new device)' : ''}</span>
                : <span className="text-destructive">{REASONS[e.reason] ?? e.reason}</span>}
            </td>
            <td className="px-2 py-1.5 text-xs">{METHODS[e.method] ?? e.method}</td>
            <td className="px-2 py-1.5 text-xs text-muted-foreground">{e.device} · {e.ip ?? 'unknown'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function SignInHistoryDialog({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const [items, setItems] = useState<SignInEntry[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    setItems(null)
    mySignIns().then((r) => setItems(r.items)).catch((e) => setError(errMsg(e)))
  }, [open])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-2xl" data-testid="signin-history-dialog">
        <DialogHeader>
          <DialogTitle>Your recent sign-ins</DialogTitle>
          <DialogDescription>The last 50 attempts to sign in to your account, successful or not. Something you do not recognise? Change your password and end other sessions.</DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : items ? <SignInTable items={items} /> : <Spinner />}
      </DialogContent>
    </Dialog>
  )
}

/** a code typed by people: 6 digits */
export function CodeInput({ value, onChange, id, testId, autoFocus }: { value: string; onChange(v: string): void; id: string; testId?: string; autoFocus?: boolean }) {
  return <Input id={id} autoFocus={autoFocus} inputMode="numeric" autoComplete="one-time-code" value={value} onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))} className="w-44 font-mono text-lg tracking-[0.3em]" data-testid={testId} />
}

