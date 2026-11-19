/**
 * Small shared building blocks for the portal: toasts, page header, empty state, confirm/text/code dialogs,
 * formatting helpers. Local on purpose (no dependency on other agents' primitives).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { CheckCircle2, CircleAlert, Copy, Download, Info, X } from 'lucide-react'
import { PlatformError } from '@/platform'
import { cn } from '@/lib/utils'
import { CODE_MESSAGES, errorReference, referenceOf, rememberErrorReference } from '@/platform/errorMessages'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/* ------------------------------------------------------------------ errors + formatting */

export function errMsg(e: unknown): string {
  const msg = e instanceof PlatformError ? CODE_MESSAGES[e.code] ?? e.message : e instanceof Error ? e.message : String(e)
  // the server's request id travels with the message, so the toast or dialog showing it can add "Reference: ..."
  rememberErrorReference(msg, referenceOf(e))
  return msg
}

/** "Reference: abc123" with a copy button: the request id of a server error, for support (matches the server log) */
export function ErrorReference({ id, className }: { id: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className={cn('inline-flex items-center gap-1 text-[11px] text-muted-foreground', className)} data-testid="error-reference">
      Reference: <code className="font-mono select-all">{id}</code>
      <button
        type="button" aria-label="Copy the reference" className="rounded p-0.5 hover:text-foreground"
        onClick={() => { void navigator.clipboard?.writeText(id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {}) }}
      >
        {copied ? <CheckCircle2 className="size-3" /> : <Copy className="size-3" />}
      </button>
    </span>
  )
}

/** the reference (request id) of an error message shown to the user, if the server sent one */
export const referenceFor = (message: string): string | undefined => errorReference(message)

export function fmtDate(iso: string | undefined | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function fmtRelative(iso: string | undefined | null): string {
  if (!iso) return ''
  const d = new Date(iso).getTime()
  if (Number.isNaN(d)) return iso
  const s = Math.round((Date.now() - d) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 86400 * 14) return `${Math.floor(s / 86400)} d ago`
  return fmtDate(iso)
}

export function slugName(s: string): string {
  const t = s
    .trim()
    .replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ''))
  if (!t) return ''
  const n = /^[0-9]/.test(t) ? '_' + t : t
  return n.charAt(0).toUpperCase() + n.slice(1)
}

export function downloadText(filename: string, text: string, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/* ------------------------------------------------------------------ toasts */

type ToastKind = 'success' | 'error' | 'info'
interface ToastItem { id: number; kind: ToastKind; message: string; reference?: string }
interface ToastApi {
  toast(message: string, kind?: ToastKind): void
  /** shows the message of any thrown value as an error toast */
  fail(e: unknown): void
}
const ToastCtx = createContext<ToastApi>({ toast: () => undefined, fail: () => undefined })
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(0)
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), [])
  const toast = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = ++seq.current
      const reference = kind === 'error' ? errorReference(message) : undefined
      setItems((l) => [...l.slice(-3), { id, kind, message, ...(reference ? { reference } : {}) }])
      setTimeout(() => dismiss(id), kind === 'error' ? (reference ? 15000 : 7000) : 3500)
    },
    [dismiss],
  )
  const api = useMemo<ToastApi>(() => ({ toast, fail: (e) => toast(errMsg(e), 'error') }), [toast])
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[500] flex w-80 flex-col gap-2" role="region" aria-label="Notifications" data-testid="toasts">
        {items.map((t) => {
          const Icon = t.kind === 'success' ? CheckCircle2 : t.kind === 'error' ? CircleAlert : Info
          return (
            <div
              key={t.id}
              role={t.kind === 'error' ? 'alert' : 'status'}
              className={cn(
                'pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-card px-3 py-2.5 text-sm shadow-lg',
                t.kind === 'error' && 'border-destructive/40',
              )}
            >
              <Icon className={cn('mt-0.5 size-4 shrink-0', t.kind === 'success' && 'text-emerald-500', t.kind === 'error' && 'text-destructive', t.kind === 'info' && 'text-primary')} />
              <span className="flex min-w-0 flex-1 flex-col break-words">{t.message}{t.reference && <ErrorReference id={t.reference} />}</span>
              <button type="button" aria-label="Dismiss" className="rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={() => dismiss(t.id)}>
                <X className="size-3.5" />
              </button>
            </div>
          )
        })}
      </div>
    </ToastCtx.Provider>
  )
}

/* ------------------------------------------------------------------ layout bits */

export function PageHeader({ title, subtitle, actions, icon: Icon, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; icon?: ComponentType<{ className?: string }>; back?: ReactNode }) {
  return (
    <div className="mb-5">
      {back}
      <div className="flex items-start gap-3">
        {Icon && (
          <div className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground">
            <Icon className="size-[18px]" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>}
      </div>
    </div>
  )
}

export function Empty({ icon: Icon, title, description, action, className }: { icon: ComponentType<{ className?: string }>; title: string; description?: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border px-6 py-12 text-center', className)}>
      <div className="grid size-11 place-items-center rounded-full bg-accent text-accent-foreground">
        <Icon className="size-5" />
      </div>
      <div className="text-sm font-semibold">{title}</div>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function Panel({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-xl border border-border bg-card shadow-xs', className)} {...rest}>
      {children}
    </div>
  )
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor} className="text-xs font-medium">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** Segmented control (radio group semantics) used for scopes, view toggles, presets. */
export function Segmented<const T extends string>({ value, onChange, options, label, size = 'md', disabled }: { value: NoInfer<T>; onChange(v: NoInfer<T>): void; options: { value: T; label: ReactNode; title?: string }[]; label: string; size?: 'sm' | 'md'; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex rounded-md bg-muted p-0.5', disabled && 'opacity-50')}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex items-center justify-center gap-1 rounded-[5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
            size === 'sm' ? 'h-6 px-2 text-[11px]' : 'h-7 px-3 text-xs',
            value === o.value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ dialogs */

export function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel = 'Delete', destructive = true, onConfirm,
}: {
  open: boolean; onOpenChange(o: boolean): void; title: string; description: ReactNode; confirmLabel?: string; destructive?: boolean; onConfirm(): Promise<void> | void
}) {
  const [busy, setBusy] = useState(false)
  const { fail } = useToast()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="confirm-dialog" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild><div>{description}</div></DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy}
            data-testid="confirm-ok"
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm()
                onOpenChange(false)
              } catch (e) {
                fail(e)
              } finally {
                setBusy(false)
              }
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Single-text-field dialog (rename, new name). */
export function TextDialog({
  open, onOpenChange, title, description, label, initial = '', confirmLabel = 'Save', onSubmit,
}: {
  open: boolean; onOpenChange(o: boolean): void; title: string; description?: string; label: string; initial?: string; confirmLabel?: string; onSubmit(value: string): Promise<void> | void
}) {
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const { fail } = useToast()
  useEffect(() => { if (open) setValue(initial) }, [open, initial])
  const submit = async () => {
    if (!value.trim()) return
    setBusy(true)
    try {
      await onSubmit(value.trim())
      onOpenChange(false)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); void submit() }} className="grid gap-4">
          <Field label={label} htmlFor="text-dialog-input">
            <Input id="text-dialog-input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} data-testid="text-dialog-input" />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !value.trim()}>{confirmLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Read-only monospace text with Copy + Download (used for YAML and CSV exports). */
export function CodeBox({ text, filename, mime = 'text/yaml', className }: { text: string; filename: string; mime?: string; className?: string }) {
  const { toast } = useToast()
  const ref = useRef<HTMLTextAreaElement>(null)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      toast('Copied to clipboard', 'success')
    } catch {
      ref.current?.select()
      toast('Clipboard is not available here. The text is selected: press Ctrl+C.', 'info')
    }
  }
  return (
    <div className="grid gap-2">
      <textarea
        ref={ref}
        readOnly
        value={text}
        spellCheck={false}
        aria-label="Exported text"
        data-testid="export-text"
        className={cn('h-72 w-full resize-none rounded-md border border-input bg-muted/40 p-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/30', className)}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void copy()} data-testid="export-copy">
          <Copy /> Copy
        </Button>
        <Button size="sm" onClick={() => downloadText(filename, text, mime)} data-testid="export-download">
          <Download /> Download {filename}
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">{text.split('\n').length} lines</span>
      </div>
    </div>
  )
}

export function CodeDialog({ open, onOpenChange, title, description, text, filename, mime, loading, extra }: {
  open: boolean; onOpenChange(o: boolean): void; title: string; description?: string; text: string; filename: string; mime?: string; loading?: boolean; extra?: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="code-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {extra}
        {loading ? <div className="grid h-72 place-items-center text-sm text-muted-foreground">Preparing package...</div> : <CodeBox text={text} filename={filename} mime={mime} />}
      </DialogContent>
    </Dialog>
  )
}
