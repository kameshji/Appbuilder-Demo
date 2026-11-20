/**
 * The phone status strip (P2-A): rendered once by App, in the page flow under the shell (it never covers an app's
 * buttons; the app area gets shorter while it shows). It shows, only when needed:
 *  - "You're offline" (connectivity.ts), with "Try again";
 *  - "N waiting to send" (the outbox of offline apps); tapping it opens the outbox panel with each item's status:
 *    waiting, sending, changed on the server (keep mine / use the server's), refused (fix and resend / discard);
 *  - "New version available — Reload" (the service worker update flow, pwa.ts);
 *  - a short notice after a save was kept on the device.
 * What offline apps cannot do is said in the panel: no deletes, approvals or flows without a connection.
 */
import { useEffect, useState } from 'react'
import { CloudOff, RefreshCw, Send, TriangleAlert, Check, X, Loader2, Smartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { probe, useConnectivity } from './connectivity'
import { dismissTableNotice, outboxActions, useOffline } from './offline'
import type { ItemView } from './offline/outbox'
import { applyUpdate, usePwa } from './pwa'
import { progressText } from './offline/tables'

export function ConnectionBar() {
  const status = useConnectivity((s) => s.status)
  const items = useOffline((s) => s.items)
  const active = useOffline((s) => s.active)
  const notice = useOffline((s) => s.notice)
  const lastError = useOffline((s) => s.lastError)
  const updateReady = usePwa((s) => s.updateReady)
  const tables = useOffline((s) => s.tables)
  const tableNotice = useOffline((s) => s.tableNotice)
  const [open, setOpen] = useState(false)
  const [shownNotice, setShownNotice] = useState<number | null>(null)
  const [trying, setTrying] = useState(false)
  // "available offline" tables being downloaded (offline/index.ts syncTables)
  const loading = Object.values(tables).filter((t) => t.state === 'loading')

  useEffect(() => {
    if (!notice) return
    setShownNotice(notice.id)
    const t = setTimeout(() => setShownNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  const problems = items.filter((i) => i.status === 'conflict' || i.status === 'rejected').length
  const offline = status === 'offline'
  const showOutbox = items.length > 0
  if (!offline && !showOutbox && !updateReady && shownNotice === null && !(active && lastError) && !loading.length && !(active && tableNotice)) return null

  return (
    <>
      <div
        data-testid="connection-bar"
        role="status"
        aria-live="polite"
        className="flex shrink-0 flex-col items-center gap-1.5 border-t border-border bg-muted/60 px-2 py-1.5"
      >
        {shownNotice !== null && notice && (
          <div data-testid="offline-notice" className="flex max-w-md items-center gap-2 rounded-lg bg-foreground px-3 py-1.5 text-xs text-background">
            <Smartphone className="size-3.5 shrink-0" /> {notice.text}
          </div>
        )}
        {updateReady && (
          <div data-testid="update-banner" className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs">
            New version available
            <Button size="xs" onClick={applyUpdate} data-testid="update-reload"><RefreshCw /> Reload</Button>
          </div>
        )}
        {loading.map((t) => (
          <div key={t.table} data-testid="offline-table-progress" className="flex w-full max-w-md items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            <span className="min-w-0 flex-1 truncate">{progressText(t.table, t.loaded, t.total)}</span>
            {t.total ? <progress className="h-1.5 w-16 shrink-0" max={t.total} value={Math.min(t.loaded, t.total)} aria-label={`${t.table} download`} /> : null}
          </div>
        ))}
        {active && tableNotice && !loading.length && (
          <div data-testid="offline-table-notice" className="flex w-full max-w-md items-start gap-2 rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-900 dark:text-amber-100">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{tableNotice}</span>
            <button type="button" className="-m-1 grid size-8 shrink-0 place-items-center rounded hover:bg-amber-500/20" aria-label="Dismiss" onClick={dismissTableNotice} data-testid="offline-table-notice-dismiss">
              <X className="size-3.5" />
            </button>
          </div>
        )}
        {(offline || showOutbox) && (
          <div className="flex flex-wrap items-center justify-center gap-1.5 text-xs">
            {offline && (
              <span data-testid="offline-banner" className="flex items-center gap-1.5 px-1.5 font-medium text-amber-700 dark:text-amber-300">
                <CloudOff className="size-3.5" /> You're offline
              </span>
            )}
            {offline && (
              <Button size="xs" variant="ghost" disabled={trying} onClick={async () => { setTrying(true); await probe(); setTrying(false) }} data-testid="offline-retry">
                {trying ? <Loader2 className="animate-spin" /> : <RefreshCw />} Try again
              </Button>
            )}
            {showOutbox && (
              <Button size="xs" variant={problems ? 'destructive' : 'secondary'} className="min-h-8" onClick={() => setOpen(true)} data-testid="outbox-button">
                {problems ? <TriangleAlert /> : <Send />}
                <span data-testid="outbox-count">{items.length}</span> waiting to send{problems ? ` · ${problems} need${problems === 1 ? 's' : ''} you` : ''}
              </Button>
            )}
          </div>
        )}
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[85dvh] rounded-t-xl ab-sheet-pad-bottom" data-testid="outbox-panel">
          <SheetHeader>
            <SheetTitle>Waiting to send</SheetTitle>
            <SheetDescription>
              Saved on this device and sent in order when the connection returns. Without a connection you can add and change
              rows and take photos; deleting, approving and running flows need a connection.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4">
            {lastError && <p className="rounded-md bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-200">{lastError}</p>}
            {items.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Nothing is waiting.</p>}
            {items.map((it) => <OutboxRow key={it.id} item={it} />)}
            {Object.values(tables).length > 0 && (
              <div className="space-y-1 pt-2 text-xs" data-testid="offline-tables-list">
                <div className="font-medium">Kept on this device for offline use</div>
                {Object.values(tables).map((t) => (
                  <div key={t.table} className="text-muted-foreground">
                    {t.table}: {t.state === 'ready' ? `${(t.kept ?? 0).toLocaleString('en-US')} rows${t.at ? `, ${new Date(t.at).toLocaleTimeString()}` : ''}` : t.state === 'loading' ? 'downloading…' : t.message ?? t.state}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-2 px-4 pb-2">
            <Button className="h-11 flex-1" disabled={offline || items.length === 0} onClick={() => void outboxActions.sendNow()} data-testid="outbox-send-now"><Send /> Send now</Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

const STATUS: Record<ItemView['status'], string> = { waiting: 'Waiting', sending: 'Sending…', conflict: 'Changed on the server', rejected: 'Refused by the server' }

function OutboxRow({ item }: { item: ItemView }) {
  const [fix, setFix] = useState<Record<string, string> | null>(null)
  const label = item.body?.label ?? `${item.kind === 'create' ? 'New row' : item.kind === 'update' ? 'Change' : 'File'} in ${item.table}`
  const problem = item.status === 'conflict' || item.status === 'rejected'
  return (
    <div data-testid="outbox-item" data-status={item.status} className={cn('rounded-lg border p-3 text-sm', problem ? 'border-destructive/40 bg-destructive/5' : 'border-border')}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        <span className={cn('shrink-0 text-xs', problem ? 'text-destructive' : 'text-muted-foreground')}>{item.blocked && !problem ? 'Waiting for an earlier change' : STATUS[item.status]}</span>
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()}{item.attempts ? ` · ${item.attempts} ${item.attempts === 1 ? 'try' : 'tries'}` : ''}</div>
      {!item.body && <div className="mt-1 text-xs text-muted-foreground">Details appear once this device is connected and signed in.</div>}
      {item.body?.error && <div className="mt-1.5 text-xs text-destructive" data-testid="outbox-error">{item.body.error.message}</div>}
      {item.status === 'conflict' && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" className="h-10" onClick={() => void outboxActions.keepMine(item.id)} data-testid="outbox-keep-mine"><Check /> Keep mine</Button>
          <Button size="sm" variant="outline" className="h-10" onClick={() => void outboxActions.useServer(item.id)} data-testid="outbox-use-server">Use the server's</Button>
        </div>
      )}
      {item.status === 'rejected' && !fix && (
        <div className="mt-2 flex flex-wrap gap-2">
          {item.body?.values && item.kind !== 'upload' && (
            <Button size="sm" className="h-10" onClick={() => setFix(Object.fromEntries(Object.entries(item.body!.values!).map(([k, v]) => [k, v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v)])))} data-testid="outbox-fix">Fix and resend</Button>
          )}
          <Button size="sm" variant="outline" className="h-10" onClick={() => void outboxActions.resend(item.id)}>Resend</Button>
          <Button size="sm" variant="ghost" className="h-10 text-destructive" onClick={() => { if (confirm('Discard this change? It will not be sent.')) void outboxActions.discard(item.id) }} data-testid="outbox-discard"><X /> Discard</Button>
        </div>
      )}
      {fix && item.body?.values && (
        <form
          className="mt-2 space-y-2"
          data-phone-reveal
          onSubmit={(e) => {
            e.preventDefault()
            const orig = item.body!.values!
            const values: Record<string, unknown> = {}
            for (const [k, text] of Object.entries(fix)) {
              const o = orig[k]
              values[k] = typeof o === 'number' ? (text.trim() === '' ? null : Number(text)) : typeof o === 'boolean' ? text === 'true' : text === '' && o === null ? null : text
            }
            void outboxActions.resend(item.id, values)
            setFix(null)
          }}
        >
          {Object.keys(fix).map((k) => (
            <label key={k} className={cn('block text-xs', item.body?.error?.field === k && 'text-destructive')}>
              {k}
              <input
                value={fix[k]}
                inputMode={typeof item.body!.values![k] === 'number' ? 'decimal' : undefined}
                onChange={(e) => setFix({ ...fix, [k]: e.target.value })}
                className="mt-0.5 h-11 w-full rounded-md border border-input bg-background px-2 text-base"
                data-testid={`outbox-fix-${k}`}
              />
            </label>
          ))}
          <div className="flex gap-2">
            <Button type="submit" className="h-10" data-testid="outbox-fix-send"><Send /> Send</Button>
            <Button type="button" variant="ghost" className="h-10" onClick={() => setFix(null)}>Cancel</Button>
          </div>
        </form>
      )}
    </div>
  )
}
