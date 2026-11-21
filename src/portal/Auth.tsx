/**
 * Server-mode startup gates (setup wizard, login) and the change-password dialog.
 * The account menu is the avatar menu in Profile.tsx. Exported for reuse: AuthGate (see index.ts), ChangePasswordDialog.
 */
import { beforeSignOut } from '@/phone/offline'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check, CircleAlert, Database, KeyRound, LogOut, Mail, Moon, ShieldCheck, Shapes, Sun } from 'lucide-react'
import { PlatformError, platform, usePlatform, type Session } from '@/platform'
import { CODE_MESSAGES } from '@/platform/errorMessages'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Field, ToastProvider, errMsg, useToast } from './kit'
import { NewPasswordFields, PasswordInput, passwordsValid } from './PasswordFields'
import { useTheme } from './theme'
import { setMinPassword } from './security'
import { CodeInput, RecoveryCodes, TotpEnrolment } from './Identity'
import {
  acceptInvitation, checkInvitation, checkResetToken, confirmEmail, forgotPassword, identityInfo, linkFromHash, resetPassword, sendSignInCode,
  verifySecondStep, type IdentityInfo, type MfaChallenge, type SecondStepMethod,
} from './identityApi'

/** finishes a sign-in that returned a session (second step, invitation): loads the workspace */
async function signedIn(session: Session): Promise<void> {
  if (platform.auth.completeSignIn) await platform.auth.completeSignIn(session)
  else window.location.reload()
}

/** what the server offers before sign-in (email set up, password rules); also sets the minimum length for the meters */
function useIdentityInfo(): IdentityInfo | null {
  const [info, setInfo] = useState<IdentityInfo | null>(null)
  useEffect(() => {
    identityInfo().then((i) => { setMinPassword(i.passwordMinLength); setInfo(i) }).catch(() => setInfo({ email: false, emailCodes: false, passwordMinLength: 10, rememberDays: 0 }))
  }, [])
  return info
}

/* ------------------------------------------------------------------ shared bits */

function FormError({ message }: { message: string }) {
  if (!message) return null
  return (
    <Alert variant="destructive" data-testid="form-error">
      <CircleAlert />
      <AlertDescription className="col-start-2 text-destructive">{message}</AlertDescription>
    </Alert>
  )
}

function GateFrame({ title, subtitle, children, step }: { title: string; subtitle: string; children: ReactNode; step?: ReactNode }) {
  const { theme, toggle } = useTheme()
  return (
    <div className="relative grid min-h-full place-items-center overflow-auto bg-canvas px-4 py-10 text-foreground">
      <Button variant="ghost" size="icon-sm" className="absolute right-4 top-4" onClick={toggle} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
        {theme === 'dark' ? <Sun /> : <Moon />}
      </Button>
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-xs"><Shapes className="size-5" /></span>
          <span className="text-lg font-semibold tracking-tight">Appbuilder</span>
        </div>
        <div className="rounded-xl border border-border bg-card p-6 shadow-xs">
          {step}
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <p className="mb-5 mt-1 text-sm text-muted-foreground">{subtitle}</p>
          {children}
        </div>
      </div>
    </div>
  )
}

function Steps({ current }: { current: 1 | 2 }) {
  const items = ['Database', 'Administrator']
  return (
    <ol className="mb-4 flex items-center gap-2 text-xs" aria-label="Setup progress">
      {items.map((label, i) => {
        const n = i + 1
        const done = n < current
        const active = n === current
        return (
          <li key={label} className="flex items-center gap-2" aria-current={active ? 'step' : undefined}>
            <span className={`grid size-5 place-items-center rounded-full text-[11px] font-semibold ${done ? 'bg-primary text-primary-foreground' : active ? 'bg-accent text-accent-foreground ring-1 ring-primary' : 'bg-muted text-muted-foreground'}`}>
              {done ? <Check className="size-3" /> : n}
            </span>
            <span className={active ? 'font-medium' : 'text-muted-foreground'}>{label}</span>
            {n < items.length && <span className="mx-1 h-px w-6 bg-border" aria-hidden />}
          </li>
        )
      })}
    </ol>
  )
}

/* ------------------------------------------------------------------ setup wizard */

/** the one-time code the server prints to its console; typed with or without the dash */
function SetupCodeField({ value, onChange, autoFocus }: { value: string; onChange(v: string): void; autoFocus?: boolean }) {
  // a server installed as a service has no window: the code is in its setup-code file (the server says which, not where)
  const where = usePlatform((s) => s.setup.codeIn)
  const os = usePlatform((s) => s.setup.platform)
  const inFile = where === 'file'
  // started by hand with APPBUILDER_SETUP_CODE_FILE set: the window shows it, and the file has it too
  const both = where === 'both'
  const label = inFile ? 'Setup code (in the setup-code file on the server)' : both ? 'Setup code (shown in the server window, also in the setup-code file)' : 'Setup code (shown in the server window)'
  const hint = both
    ? 'Printed in the window where you started the Appbuilder server, for example ABCD-EFGH. It is also written to the server\'s setup-code file. It proves you are at this computer.'
    : inFile ? (
    <span data-testid="setup-code-file-hint">
      Appbuilder runs as a service, so the code is in a file on this computer. {os === 'windows'
        ? <>In an <b>administrator</b> PowerShell, type <code className="rounded bg-muted px-1">appbuilder setup-code</code> (or <code className="rounded bg-muted px-1">Get-Content 'C:\ProgramData\Appbuilder\workspace\setup-code.txt'</code> for a default install).</>
        : <>In a terminal, type <code className="rounded bg-muted px-1">sudo appbuilder setup-code</code> (or <code className="rounded bg-muted px-1">sudo cat /var/lib/appbuilder/workspace/setup-code.txt</code> for a default install).</>}
      {' '}It looks like ABCD-EFGH, changes when the service restarts and proves you are at this computer.
    </span>
  ) : 'Printed in the window where the Appbuilder server runs, for example ABCD-EFGH. It proves you are at this computer.'
  return (
    <Field label={label} htmlFor="setup-code" hint={hint}>
      <Input
        id="setup-code"
        value={value}
        autoFocus={autoFocus}
        autoComplete="one-time-code"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 9))}
        className="font-mono tracking-widest"
        data-testid="setup-code"
      />
    </Field>
  )
}
const setupCodeOk = (v: string) => v.replace(/-/g, '').length === 8

function DatabaseStep({ onDone, code, setCode }: { onDone(): void; code: string; setCode(v: string): void }) {
  const { fail } = useToast()
  const [host, setHost] = useState('127.0.0.1')
  const [port, setPort] = useState('5432')
  const [database, setDatabase] = useState('appbuilder')
  const [user, setUser] = useState('appbuilder')
  const [password, setPassword] = useState('')
  const [createDatabase, setCreateDatabase] = useState(true)
  const [ssl, setSsl] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const portNum = Number(port)
  const valid = setupCodeOk(code) && !!host.trim() && Number.isInteger(portNum) && portNum > 0 && portNum < 65536 && !!database.trim() && !!user.trim()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError('')
    try {
      await platform.auth.setupDatabase({ host: host.trim(), port: portNum, database: database.trim(), user: user.trim(), password, createDatabase, ssl, setupCode: code })
      setPassword('') // write-only: never kept after use
      onDone()
    } catch (err) {
      const m = errMsg(err)
      setError(m)
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <GateFrame step={<Steps current={1} />} title="Connect your database" subtitle="Appbuilder keeps your tables, apps and users in PostgreSQL. Enter the database that scripts/setup-postgres created (or one your administrator gave you).">
      <form onSubmit={(e) => void submit(e)} className="grid gap-4" data-testid="setup-database-form" autoComplete="off">
        <SetupCodeField value={code} onChange={setCode} autoFocus />
        <div className="grid grid-cols-[1fr_96px] gap-3">
          <Field label="Host" htmlFor="setup-host"><Input id="setup-host" value={host} onChange={(e) => setHost(e.target.value)} data-testid="setup-host" /></Field>
          <Field label="Port" htmlFor="setup-port"><Input id="setup-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} data-testid="setup-port" /></Field>
        </div>
        <Field label="Database" htmlFor="setup-database"><Input id="setup-database" value={database} onChange={(e) => setDatabase(e.target.value)} data-testid="setup-database" /></Field>
        <Field label="User" htmlFor="setup-user" hint="A PostgreSQL role that owns the database (or may create schemas in it). Not the postgres superuser."><Input id="setup-user" value={user} autoComplete="off" onChange={(e) => setUser(e.target.value)} data-testid="setup-user" /></Field>
        <Field label="Password" htmlFor="setup-password" hint="Typed by you, sent to the local server once and stored there encrypted. It is never shown again.">
          <PasswordInput id="setup-password" value={password} onChange={setPassword} testId="setup-password" />
        </Field>
        <label className="flex items-start gap-2.5 text-sm">
          <Checkbox checked={createDatabase} onCheckedChange={(v) => setCreateDatabase(v === true)} className="mt-0.5" data-testid="setup-create-db" />
          <span>Create the database if it does not exist<span className="block text-xs text-muted-foreground">Needs a role with the CREATEDB attribute.</span></span>
        </label>
        <label className="flex items-start gap-2.5 text-sm">
          <Checkbox checked={ssl} onCheckedChange={(v) => setSsl(v === true)} className="mt-0.5" data-testid="setup-ssl" />
          <span>Use SSL<span className="block text-xs text-muted-foreground">For a database on another machine. The server's certificate must be valid.</span></span>
        </label>
        <FormError message={error} />
        <Button type="submit" disabled={!valid || busy} data-testid="setup-database-continue">
          {busy ? <Spinner /> : <Database />} {busy ? 'Testing connection...' : 'Test connection and continue'} {!busy && <ArrowRight />}
        </Button>
      </form>
    </GateFrame>
  )
}

function AdminStep({ code, setCode }: { code: string; setCode(v: string): void }) {
  const { fail } = useToast()
  const [askCode] = useState(() => !setupCodeOk(code))
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())
  const valid = setupCodeOk(code) && !!name.trim() && emailOk && passwordsValid(password, confirm, email)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError('')
    try {
      await platform.auth.setupAdmin({ name: name.trim(), email: email.trim(), password, setupCode: code })
      setPassword('')
      setConfirm('')
    } catch (err) {
      setError(errMsg(err))
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <GateFrame step={<Steps current={2} />} title="Create the administrator" subtitle="This account can manage connections, tables, roles and users. You can add more people afterwards.">
      <form onSubmit={(e) => void submit(e)} className="grid gap-4" data-testid="setup-admin-form">
        {askCode && <SetupCodeField value={code} onChange={setCode} autoFocus />}
        <Field label="Your name" htmlFor="admin-name"><Input id="admin-name" autoFocus={!askCode} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} data-testid="setup-admin-name" /></Field>
        <Field label="Email" htmlFor="admin-email" hint="Used to sign in.">
          <Input id="admin-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="setup-admin-email" />
        </Field>
        <NewPasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} email={email} idPrefix="admin-pw" labelNew="Password" />
        <FormError message={error} />
        <Button type="submit" disabled={!valid || busy} data-testid="setup-admin-create">
          {busy ? <Spinner /> : <ShieldCheck />} {busy ? 'Creating...' : 'Create administrator and sign in'}
        </Button>
      </form>
    </GateFrame>
  )
}

export function SetupWizard() {
  const needsDatabase = usePlatform((s) => s.setup.needsDatabase)
  const [dbDone, setDbDone] = useState(false)
  // typed once, used by both steps (the server checks it on each)
  const [code, setCode] = useState('')
  return (
    <div data-testid="setup-wizard" className="h-full">
      {needsDatabase && !dbDone ? <DatabaseStep onDone={() => setDbDone(true)} code={code} setCode={setCode} /> : <AdminStep code={code} setCode={setCode} />}
    </div>
  )
}

/** the configured database cannot be used right now (unreachable: the server retries by itself; or too new) */
function DatabaseProblem({ incompatible }: { incompatible: boolean }) {
  const [busy, setBusy] = useState(false)
  const retry = async () => {
    setBusy(true)
    try {
      await fetch('/api/v1/status', { credentials: 'same-origin' })
    } finally {
      window.location.reload()
    }
  }
  return (
    <GateFrame
      title={incompatible ? 'This database needs a newer Appbuilder' : 'The database is not reachable'}
      subtitle={incompatible
        ? 'The database was upgraded by a newer version of Appbuilder. This version will not use it, so nothing gets damaged. Start the newer version, or restore a backup taken before the upgrade.'
        : 'Appbuilder cannot reach its database right now and keeps trying in the background. Make sure PostgreSQL is running; no restart of Appbuilder is needed.'}
    >
      <div className="grid gap-3" data-testid={incompatible ? 'database-incompatible' : 'database-unavailable'}>
        {!incompatible && <Button onClick={() => void retry()} disabled={busy} data-testid="database-retry">{busy ? <Spinner /> : <Database />} Try again</Button>}
        <p className="text-center text-xs text-muted-foreground">An administrator can see details in the server window.</p>
      </div>
    </GateFrame>
  )
}

/* ------------------------------------------------------------------ login */

export function loginMessage(e: unknown): string {
  const m = errMsg(e)
  if (e instanceof PlatformError) {
    if (e.code === 'rate_limited') return CODE_MESSAGES.rate_limited ?? m
    if (e.code === 'unavailable') return 'The server cannot reach its database right now. Make sure PostgreSQL is running, then try again.'
    if (e.code === 'unauthenticated' || e.code === 'denied' || e.code === 'invalid') return 'That email and password do not match. Check both and try again.'
  }
  return m
}

export function LoginScreen() {
  const { fail } = useToast()
  const info = useIdentityInfo()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null)
  const [forgot, setForgot] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !email.trim() || !password) return
    setBusy(true)
    setError('')
    try {
      await platform.auth.login(email.trim(), password)
      setPassword('')
    } catch (err) {
      setPassword('')
      if (err instanceof PlatformError && err.code === 'mfa_required') {
        const m = (err as PlatformError & { mfa?: MfaChallenge }).mfa
        setChallenge(m ?? { methods: ['totp', 'recovery_code'], rememberDays: 30 })
        return
      }
      setError(loginMessage(err))
      fail(new PlatformError(err instanceof PlatformError ? err.code : 'denied', loginMessage(err)))
    } finally {
      setBusy(false)
    }
  }
  if (challenge) return <SecondStep challenge={challenge} onRestart={() => setChallenge(null)} />
  if (forgot) return <ForgotPassword info={info} initialEmail={email} onBack={() => setForgot(false)} />
  return (
    <GateFrame title="Sign in" subtitle="Use the account an administrator created for you.">
      <form onSubmit={(e) => void submit(e)} className="grid gap-4" data-testid="login-form">
        <Field label="Email" htmlFor="login-email"><Input id="login-email" type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} data-testid="login-email" /></Field>
        <Field label="Password" htmlFor="login-password"><PasswordInput id="login-password" autoComplete="current-password" value={password} onChange={setPassword} testId="login-password" /></Field>
        <FormError message={error} />
        <Button type="submit" disabled={busy || !email.trim() || !password} data-testid="login-submit">
          {busy ? <Spinner /> : <KeyRound />} {busy ? 'Signing in...' : 'Sign in'}
        </Button>
        <button type="button" className="text-center text-xs text-primary hover:underline" onClick={() => setForgot(true)} data-testid="forgot-password">Forgot your password?</button>
      </form>
    </GateFrame>
  )
}

/** the second step after a correct password: authenticator code, recovery code or email code */
function SecondStep({ challenge, onRestart }: { challenge: MfaChallenge; onRestart(): void }) {
  const [method, setMethod] = useState<SecondStepMethod>(challenge.methods[0] ?? 'totp')
  const [code, setCode] = useState('')
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const session = await verifySecondStep(code, method, remember)
      await signedIn(session)
    } catch (err) {
      setCode('')
      if (err instanceof PlatformError && err.code === 'unauthenticated') {
        setError(errMsg(err))
        setTimeout(onRestart, 1500)
        return
      }
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }
  const sendCode = async () => {
    setError('')
    try {
      const r = await sendSignInCode()
      setSent(r.sentTo)
    } catch (err) {
      setError(errMsg(err))
    }
  }
  const valid = method === 'recovery_code' ? code.replace(/[\s-]/g, '').length >= 16 : code.length === 6
  return (
    <GateFrame title="Two-step verification" subtitle={method === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : method === 'email_code' ? 'We email you a 6-digit code.' : 'Enter one of the recovery codes you saved when you set up two-step verification.'}>
      <form onSubmit={(e) => void submit(e)} className="grid gap-4" data-testid="second-step-form">
        {method === 'recovery_code'
          ? <Field label="Recovery code" htmlFor="mfa-code"><Input id="mfa-code" autoFocus autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 24))} className="font-mono tracking-wider" data-testid="mfa-code" /></Field>
          : <Field label={method === 'totp' ? 'Code from the app' : 'Code from the email'} htmlFor="mfa-code"><CodeInput id="mfa-code" autoFocus value={code} onChange={setCode} testId="mfa-code" /></Field>}
        {method === 'email_code' && (
          <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => void sendCode()} data-testid="mfa-send-email"><Mail /> {sent ? 'Send another code' : 'Email me a code'}</Button>
        )}
        {sent && <p className="text-xs text-muted-foreground">Sent to {sent}. It works for 10 minutes.</p>}
        {challenge.rememberDays > 0 && (
          <label className="flex items-start gap-2.5 text-sm">
            <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} className="mt-0.5" data-testid="mfa-remember" />
            <span>Remember this device for {challenge.rememberDays} days<span className="block text-xs text-muted-foreground">Only on a computer that only you use. You can forget it in Settings.</span></span>
          </label>
        )}
        <FormError message={error} />
        <Button type="submit" disabled={busy || !valid} data-testid="mfa-submit">{busy ? <Spinner /> : <ShieldCheck />} Verify</Button>
        <div className="grid gap-1 text-center text-xs">
          {challenge.methods.filter((m) => m !== method).map((m) => (
            <button key={m} type="button" className="text-primary hover:underline" onClick={() => { setMethod(m); setCode(''); setError('') }} data-testid={`mfa-use-${m}`}>
              {m === 'totp' ? 'Use my authenticator app' : m === 'recovery_code' ? 'Use a recovery code' : 'Get a code by email'}
            </button>
          ))}
          <button type="button" className="text-muted-foreground hover:underline" onClick={onRestart}>Sign in as someone else</button>
        </div>
      </form>
    </GateFrame>
  )
}

/** "Forgot your password?": a reset link by email, or (no email set up / an administrator gave a code) the one-time code */
function ForgotPassword({ info, initialEmail, onBack }: { info: IdentityInfo | null; initialEmail: string; onBack(): void }) {
  const [email, setEmail] = useState(initialEmail)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState('')
  const [error, setError] = useState('')
  const [withCode, setWithCode] = useState(info ? !info.email : false)
  const [code, setCode] = useState('')
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())
  const request = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const r = await forgotPassword(email.trim())
      setDone(r.message)
      if (!r.email) setWithCode(true)
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }
  const redeem = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await resetPassword({ email: email.trim(), code, password: pw })
      setPw(''); setConfirm('')
      setDone('Your password was changed and every session was signed out. Sign in with the new password.')
      setWithCode(false)
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }
  const back = <button type="button" className="inline-flex items-center gap-1 text-xs text-primary hover:underline" onClick={onBack} data-testid="back-to-login"><ArrowLeft className="size-3" /> Back to sign in</button>
  if (withCode) {
    return (
      <GateFrame title="Use a reset code" subtitle={info && !info.email ? 'Email is not set up on this server. An administrator can create a one-time reset code for you (Admin console > Users), valid for 24 hours.' : 'Type your email, the one-time code an administrator gave you, and a new password.'}>
        <form onSubmit={(e) => void redeem(e)} className="grid gap-4" data-testid="reset-code-form" autoComplete="off">
          <Field label="Email" htmlFor="rc-email"><Input id="rc-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="rc-email" /></Field>
          <Field label="Reset code" htmlFor="rc-code"><Input id="rc-code" value={code} spellCheck={false} onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 20))} className="font-mono tracking-wider" data-testid="rc-code" /></Field>
          <NewPasswordFields password={pw} confirm={confirm} onPassword={setPw} onConfirm={setConfirm} email={email} idPrefix="rc" />
          <FormError message={error} />
          <Button type="submit" disabled={busy || !emailOk || code.replace(/[\s-]/g, '').length < 12 || !passwordsValid(pw, confirm, email)} data-testid="rc-submit">{busy && <Spinner />} Set new password</Button>
          {info?.email && <button type="button" className="text-xs text-primary hover:underline" onClick={() => setWithCode(false)}>Send me a reset link instead</button>}
          {back}
        </form>
      </GateFrame>
    )
  }
  return (
    <GateFrame title="Reset your password" subtitle="Type the email you sign in with. If it belongs to an account, we send a link to choose a new password (it works for 15 minutes).">
      {done
        ? <div className="grid gap-4" data-testid="forgot-done"><Alert><Mail /><AlertDescription className="col-start-2">{done}</AlertDescription></Alert>{back}</div>
        : (
          <form onSubmit={(e) => void request(e)} className="grid gap-4" data-testid="forgot-form">
            <Field label="Email" htmlFor="forgot-email"><Input id="forgot-email" type="email" autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="forgot-email" /></Field>
            <FormError message={error} />
            <Button type="submit" disabled={busy || !emailOk} data-testid="forgot-submit">{busy ? <Spinner /> : <Mail />} Send reset link</Button>
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => setWithCode(true)} data-testid="have-reset-code">I have a reset code from an administrator</button>
            {back}
          </form>
        )}
    </GateFrame>
  )
}

/** a link from an email: #reset=, #invite=, #confirm-email= */
function LinkScreen({ link, onDone }: { link: { kind: 'reset' | 'invite' | 'confirm-email'; token: string }; onDone(): void }) {
  useIdentityInfo()
  const [state, setState] = useState<{ email: string; name?: string } | null>(null)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const p = link.kind === 'reset' ? checkResetToken(link.token) : link.kind === 'invite' ? checkInvitation(link.token) : confirmEmail(link.token)
    p.then((r) => {
      if (link.kind === 'confirm-email') setDone(`Your sign-in email is now ${r.email}.`)
      else setState(r as { email: string; name?: string })
    }).catch((e) => setError(errMsg(e)))
  }, [link])
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (link.kind === 'reset') {
        await resetPassword({ token: link.token, password: pw })
        setDone('Your password was changed and every session was signed out. Sign in with the new password.')
      } else {
        const session = await acceptInvitation(link.token, pw)
        onDone()
        await signedIn(session)
      }
      setPw(''); setConfirm('')
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }
  const title = link.kind === 'reset' ? 'Choose a new password' : link.kind === 'invite' ? 'Welcome' : 'Confirm your email'
  return (
    <GateFrame title={title} subtitle={link.kind === 'invite' && state ? `Hello ${state.name ?? ''}. Choose a password for ${state.email} to finish setting up your account.` : link.kind === 'reset' && state ? `For ${state.email}. Other sessions are signed out afterwards.` : ''}>
      <div className="grid gap-4" data-testid={`link-${link.kind}`}>
        {done ? (
          <>
            <Alert><Check /><AlertDescription className="col-start-2" data-testid="link-done">{done}</AlertDescription></Alert>
            <Button onClick={onDone} data-testid="link-continue">Continue <ArrowRight /></Button>
          </>
        ) : state ? (
          <form onSubmit={(e) => void submit(e)} className="grid gap-4">
            <input type="email" autoComplete="username" value={state.email} readOnly hidden />
            <NewPasswordFields password={pw} confirm={confirm} onPassword={setPw} onConfirm={setConfirm} email={state.email} idPrefix="link" labelNew="New password" autoFocus />
            <FormError message={error} />
            <Button type="submit" disabled={busy || !passwordsValid(pw, confirm, state.email)} data-testid="link-submit">{busy ? <Spinner /> : <KeyRound />} {link.kind === 'invite' ? 'Set password and sign in' : 'Change password'}</Button>
          </form>
        ) : error ? (
          <>
            <FormError message={error} />
            <Button variant="outline" onClick={onDone}>Go to sign in</Button>
          </>
        ) : <Spinner />}
      </div>
    </GateFrame>
  )
}

/** the policy requires two-step verification and the grace period is over: set it up before anything else */
function ForcedEnrolment() {
  const [codes, setCodes] = useState<string[] | null>(null)
  const email = usePlatform((s) => s.session?.user.email)
  const finish = async () => {
    const r = await fetch('/api/v1/auth/session', { credentials: 'same-origin', headers: { 'X-Appbuilder': '1' } })
    if (r.ok) await signedIn((await r.json()) as Session)
    else window.location.reload()
  }
  return (
    <GateFrame title="Set up two-step verification" subtitle="Your administrator requires a code from an authenticator app in addition to your password. Set it up now to continue.">
      <div data-testid="forced-mfa">
        {codes
          ? <div className="grid gap-4"><RecoveryCodes codes={codes} account={email} /><Button onClick={() => void finish()} data-testid="forced-mfa-done"><Check /> I saved them, continue</Button></div>
          : <TotpEnrolment onDone={(c) => { if (c) setCodes(c); else void finish() }} />}
        <button type="button" className="mt-4 w-full text-center text-xs text-muted-foreground hover:underline" onClick={() => { void beforeSignOut((t) => window.confirm(t)).then((ok) => { if (ok) void platform.auth.logout() }) }}>Sign out</button>
      </div>
    </GateFrame>
  )
}

/* ------------------------------------------------------------------ gate */

/**
 * Renders the setup wizard / login screen when the workspace runs in server mode and setup is incomplete or nobody is
 * signed in; otherwise the children. Demo mode: always the children.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const mode = usePlatform((s) => s.mode)
  const setup = usePlatform((s) => s.setup)
  const session = usePlatform((s) => s.session)
  // a link from an email (reset, invitation, email confirmation) is handled before anything else
  const [link, setLink] = useState(() => (mode === 'server' ? linkFromHash() : null))
  // also when the link is opened in a tab that already shows Appbuilder (only the hash changes)
  useEffect(() => {
    if (mode !== 'server') return
    const on = () => { const l = linkFromHash(); if (l) setLink(l) }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [mode])
  if (mode === 'server' && link && !setup.needsDatabase && !setup.needsAdmin) {
    const done = () => {
      history.replaceState(null, '', location.pathname + location.search)
      setLink(null)
    }
    return <ToastProvider><LinkScreen link={link} onDone={done} /></ToastProvider>
  }
  if (mode === 'server') {
    if (setup.incompatible) return <ToastProvider><DatabaseProblem incompatible /></ToastProvider>
    if (setup.needsDatabase || setup.needsAdmin) return <ToastProvider><SetupWizard /></ToastProvider>
    if (setup.unavailable && !session) return <ToastProvider><DatabaseProblem incompatible={false} /></ToastProvider>
    if (!session) return <ToastProvider><LoginScreen /></ToastProvider>
    if (session.user.mustChangePassword) return <ToastProvider><ForcedPasswordChange /></ToastProvider>
    if (session.user.mfaEnrolmentRequired) return <ToastProvider><ForcedEnrolment /></ToastProvider>
  }
  return <>{children}</>
}

/** after signing in with a password an administrator set: a new password is required before anything else */
function ForcedPasswordChange() {
  return (
    <div className="h-full bg-canvas" data-testid="forced-password-change">
      <ChangePasswordDialog open onOpenChange={() => {}} forced />
    </div>
  )
}

/* ------------------------------------------------------------------ change password */

/** forced: after an administrator set the password; cannot be dismissed (only signing out leaves it) */
export function ChangePasswordDialog({ open, onOpenChange, forced = false }: { open: boolean; onOpenChange(o: boolean): void; forced?: boolean }) {
  const { fail, toast } = useToast()
  const email = usePlatform((s) => s.session?.user.email)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const reset = () => { setCurrent(''); setNext(''); setConfirm(''); setError('') }
  const valid = !!current && passwordsValid(next, confirm, email)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError('')
    try {
      await platform.auth.changePassword(current, next)
      toast(forced ? 'Password changed. Welcome!' : 'Password changed. Other devices were signed out.', 'success')
      reset()
      onOpenChange(false)
    } catch (err) {
      setError(errMsg(err))
      fail(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (forced) return; if (!o) reset(); onOpenChange(o) }}>
      <DialogContent
        data-testid="change-password-dialog"
        showCloseButton={!forced}
        onEscapeKeyDown={(e) => { if (forced) e.preventDefault() }}
        onPointerDownOutside={(e) => { if (forced) e.preventDefault() }}
        onInteractOutside={(e) => { if (forced) e.preventDefault() }}
      >
        <DialogHeader>
          <DialogTitle>{forced ? 'Choose a new password' : 'Change password'}</DialogTitle>
          <DialogDescription>{forced
            ? 'An administrator set your password. Choose your own before you continue: type the password you were given, then the new one.'
            : 'You will stay signed in here. Sessions on other devices end.'}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void submit(e)} className="grid gap-4">
          <Field label="Current password" htmlFor="cp-current"><PasswordInput id="cp-current" autoComplete="current-password" autoFocus value={current} onChange={setCurrent} testId="cp-current" /></Field>
          <NewPasswordFields password={next} confirm={confirm} onPassword={setNext} onConfirm={setConfirm} email={email} idPrefix="cp" />
          <FormError message={error} />
          <DialogFooter>
            {forced
              ? <Button type="button" variant="ghost" onClick={() => { void beforeSignOut((t) => window.confirm(t)).then((ok) => { if (ok) void platform.auth.logout() }) }} data-testid="cp-sign-out"><LogOut /> Sign out</Button>
              : <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>}
            <Button type="submit" disabled={!valid || busy} data-testid="cp-save">Change password</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
