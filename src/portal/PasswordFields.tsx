import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Field } from './kit'
import { passwordStrength } from './security'

/** Password input with a show/hide toggle. Always write-only: callers never prefill it. */
export function PasswordInput({ value, onChange, id, autoFocus, autoComplete = 'new-password', placeholder, testId, ariaLabel }: {
  value: string; onChange(v: string): void; id?: string; autoFocus?: boolean; autoComplete?: string; placeholder?: string; testId?: string; ariaLabel?: string
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        spellCheck={false}
        autoCapitalize="none"
        placeholder={placeholder}
        aria-label={ariaLabel}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value)}
        className="pr-9"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Hide password' : 'Show password'}
        aria-pressed={show}
        className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
    </div>
  )
}

const BAR = ['bg-muted', 'bg-destructive', 'bg-amber-500', 'bg-emerald-500', 'bg-emerald-600']

export function StrengthMeter({ password, email }: { password: string; email?: string }) {
  const s = passwordStrength(password, email)
  return (
    <div className="grid gap-1" data-testid="password-strength" aria-live="polite">
      <div className="flex gap-1" aria-hidden>
        {[1, 2, 3, 4].map((i) => <span key={i} className={cn('h-1 flex-1 rounded-full', i <= s.score ? BAR[s.score] : 'bg-muted')} />)}
      </div>
      <p className="text-xs text-muted-foreground">{s.label ? <span className="font-medium text-foreground">{s.label}. </span> : null}{s.hint}</p>
    </div>
  )
}

/** New password + confirm + strength hint. `valid` is reported through the returned helper. */
export function NewPasswordFields({ password, confirm, onPassword, onConfirm, email, idPrefix = 'pw', labelNew = 'New password', autoFocus }: {
  password: string; confirm: string; onPassword(v: string): void; onConfirm(v: string): void; email?: string; idPrefix?: string; labelNew?: string; autoFocus?: boolean
}) {
  const mismatch = confirm.length > 0 && confirm !== password
  return (
    <>
      <Field label={labelNew} htmlFor={`${idPrefix}-new`}>
        <PasswordInput id={`${idPrefix}-new`} value={password} onChange={onPassword} autoFocus={autoFocus} testId={`${idPrefix}-new`} />
        <StrengthMeter password={password} email={email} />
      </Field>
      <Field label="Confirm password" htmlFor={`${idPrefix}-confirm`}>
        <PasswordInput id={`${idPrefix}-confirm`} value={confirm} onChange={onConfirm} testId={`${idPrefix}-confirm`} />
        {mismatch && <p className="text-xs text-destructive" role="alert">The two passwords do not match.</p>}
      </Field>
    </>
  )
}

export const passwordsValid = (password: string, confirm: string, email?: string) => passwordStrength(password, email).ok && password === confirm
