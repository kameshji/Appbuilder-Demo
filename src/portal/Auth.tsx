/**
 * Server-mode startup gates (setup wizard, login), the user menu and the change-password dialog.
 * Exported for reuse: AuthGate, UserMenu (see index.ts).
 */
import { useState, type FormEvent, type ReactNode } from 'react'
import { ArrowRight, Check, ChevronDown, CircleAlert, Database, KeyRound, LogOut, Moon, ShieldCheck, Shapes, Sun, UserRound } from 'lucide-react'
import { PlatformError, platform, usePlatform } from '@/platform'
import { CODE_MESSAGES } from '@/platform/errorMessages'
import { go } from '@/router'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Field, ToastProvider, errMsg, useToast } from './kit'
import { NewPasswordFields, PasswordInput, passwordsValid } from './PasswordFields'
import { useTheme } from './theme'

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
  return (
    <Field label="Setup code (shown in the server window)" htmlFor="setup-code" hint="Printed in the window where the Appbuilder server runs, for example ABCD-EFGH. It proves you are at this computer.">
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
  const [port, setPort] = useState('3306')
  const [database, setDatabase] = useState('appbuilder')
  const [user, setUser] = useState('appbuilder')
  const [password, setPassword] = useState('')
  const [createDatabase, setCreateDatabase] = useState(true)
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
      await platform.auth.setupDatabase({ host: host.trim(), port: portNum, database: database.trim(), user: user.trim(), password, createDatabase, setupCode: code })
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
    <GateFrame step={<Steps current={1} />} title="Connect your database" subtitle="Appbuilder keeps your tables, apps and users in MySQL or MariaDB. Enter the connection details of the database to use as the default store.">
      <form onSubmit={(e) => void submit(e)} className="grid gap-4" data-testid="setup-database-form" autoComplete="off">
        <SetupCodeField value={code} onChange={setCode} autoFocus />
        <div className="grid grid-cols-[1fr_96px] gap-3">
          <Field label="Host" htmlFor="setup-host"><Input id="setup-host" value={host} onChange={(e) => setHost(e.target.value)} data-testid="setup-host" /></Field>
          <Field label="Port" htmlFor="setup-port"><Input id="setup-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} data-testid="setup-port" /></Field>
        </div>
        <Field label="Database" htmlFor="setup-database"><Input id="setup-database" value={database} onChange={(e) => setDatabase(e.target.value)} data-testid="setup-database" /></Field>
        <Field label="User" htmlFor="setup-user"><Input id="setup-user" value={user} autoComplete="off" onChange={(e) => setUser(e.target.value)} data-testid="setup-user" /></Field>
        <Field label="Password" htmlFor="setup-password" hint="Typed by you, sent to the local server once and stored there encrypted. It is never shown again.">
          <PasswordInput id="setup-password" value={password} onChange={setPassword} testId="setup-password" />
        </Field>
        <label className="flex items-start gap-2.5 text-sm">
          <Checkbox checked={createDatabase} onCheckedChange={(v) => setCreateDatabase(v === true)} className="mt-0.5" data-testid="setup-create-db" />
          <span>Create the database if it does not exist<span className="block text-xs text-muted-foreground">Needs a user with the CREATE privilege.</span></span>
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
        : 'Appbuilder cannot reach its database right now and keeps trying in the background. Make sure MySQL or MariaDB is running; no restart of Appbuilder is needed.'}
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
    if (e.code === 'unavailable') return 'The server cannot reach its database right now. Make sure MySQL is running, then try again.'
    if (e.code === 'unauthenticated' || e.code === 'denied' || e.code === 'invalid') return 'That email and password do not match. Check both and try again.'
  }
  return m
}

export function LoginScreen() {
  const { fail } = useToast()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !email.trim() || !password) return
    setBusy(true)
    setError('')
    try {
      await platform.auth.login(email.trim(), password)
      setPassword('')
    } catch (err) {
      setError(loginMessage(err))
      fail(new PlatformError(err instanceof PlatformError ? err.code : 'denied', loginMessage(err)))
      setPassword('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <GateFrame title="Sign in" subtitle="Use the account an administrator created for you.">
      <form onSubmit={(e) => void submit(e)} className="grid gap-4" data-testid="login-form">
        <Field label="Email" htmlFor="login-email"><Input id="login-email" type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} data-testid="login-email" /></Field>
        <Field label="Password" htmlFor="login-password"><PasswordInput id="login-password" autoComplete="current-password" value={password} onChange={setPassword} testId="login-password" /></Field>
        <FormError message={error} />
        <Button type="submit" disabled={busy || !email.trim() || !password} data-testid="login-submit">
          {busy ? <Spinner /> : <KeyRound />} {busy ? 'Signing in...' : 'Sign in'}
        </Button>
        <p className="text-center text-xs text-muted-foreground">Forgot your password? Ask an administrator to set a new one for you.</p>
      </form>
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
  if (mode === 'server') {
    if (setup.incompatible) return <ToastProvider><DatabaseProblem incompatible /></ToastProvider>
    if (setup.needsDatabase || setup.needsAdmin) return <ToastProvider><SetupWizard /></ToastProvider>
    if (setup.unavailable && !session) return <ToastProvider><DatabaseProblem incompatible={false} /></ToastProvider>
    if (!session) return <ToastProvider><LoginScreen /></ToastProvider>
    if (session.user.mustChangePassword) return <ToastProvider><ForcedPasswordChange /></ToastProvider>
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
              ? <Button type="button" variant="ghost" onClick={() => { void platform.auth.logout() }} data-testid="cp-sign-out"><LogOut /> Sign out</Button>
              : <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>}
            <Button type="submit" disabled={!valid || busy} data-testid="cp-save">Change password</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ user menu */

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?'

/** Account menu: who is signed in, change password, sign out. The run-as switcher appears in demo mode only. */
export function UserMenu({ showTheme = false }: { showTheme?: boolean }) {
  const mode = usePlatform((s) => s.mode)
  const session = usePlatform((s) => s.session)
  const users = usePlatform((s) => s.users)
  const roles = usePlatform((s) => s.roles)
  const currentUserId = usePlatform((s) => s.currentUserId)
  const { fail, toast } = useToast()
  const { theme, toggle } = useTheme()
  const [pw, setPw] = useState(false)
  const demo = mode !== 'server'
  const user = demo ? users.find((u) => u.id === currentUserId) : session?.user
  const roleNames = user ? roles.filter((r) => user.roleIds.includes(r.id)).map((r) => r.name) : []

  const signOut = async () => {
    try {
      await platform.auth.logout()
    } catch (e) {
      fail(e)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="xs" className="h-7 gap-1.5" data-testid={demo ? 'user-switcher' : 'user-menu'} aria-label={demo ? 'Run as user' : 'Account menu'}>
            <span className="grid size-4 place-items-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground" aria-hidden>{user ? initials(user.name) : <UserRound className="size-3" />}</span>
            <span className="max-w-32 truncate">{user?.name ?? 'No user'}</span>
            <ChevronDown className="opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {demo ? (
            <>
              <DropdownMenuLabel>Run as user</DropdownMenuLabel>
              {users.map((u) => (
                <DropdownMenuItem
                  key={u.id}
                  data-testid={`run-as-${u.id}`}
                  onSelect={() => {
                    try { platform.security.setCurrentUser(u.id) } catch (e) { fail(e) }
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{u.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                  </div>
                  {u.id === currentUserId && <Check className="text-primary" />}
                </DropdownMenuItem>
              ))}
              {users.length === 0 && <div className="px-2 py-3 text-xs text-muted-foreground">No users. Add one under Security roles.</div>}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => go({ page: 'roles' })}>Manage users...</DropdownMenuItem>
              <div className="px-2 pb-1.5 pt-1 text-[11px] leading-snug text-muted-foreground">Demo mode simulates security in this browser. Sign-in needs the local server.</div>
            </>
          ) : (
            <>
              <div className="px-2 py-2">
                <div className="truncate text-sm font-medium">{user?.name}</div>
                <div className="truncate text-xs text-muted-foreground">{user?.email}</div>
                {roleNames.length > 0 && <div className="mt-1 truncate text-xs text-muted-foreground">{roleNames.join(', ')}</div>}
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setPw(true)} data-testid="menu-change-password"><KeyRound /> Change password</DropdownMenuItem>
              {showTheme && <DropdownMenuItem onSelect={toggle}>{theme === 'dark' ? <Sun /> : <Moon />} {theme === 'dark' ? 'Light theme' : 'Dark theme'}</DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => { void signOut().then(() => toast('Signed out', 'info')) }} data-testid="menu-sign-out"><LogOut /> Sign out</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {!demo && <ChangePasswordDialog open={pw} onOpenChange={setPw} />}
    </>
  )
}

