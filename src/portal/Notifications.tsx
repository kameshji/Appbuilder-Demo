/**
 * In-app notifications (package H): the bell with the unread badge in the top bar, its panel (list, mark read, mark all
 * read, delete, click-through to the deep link), toasts for new notifications while Appbuilder is focused, browser
 * (desktop) notifications while it is in the background (opt-in in Settings > Notifications), do-not-disturb hours, and
 * the "live updates paused" indicator. Server mode: pushed over the realtime hub; demo mode: between tabs.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { Bell, BellOff, CheckCheck, Loader2, Trash2, WifiOff, X } from 'lucide-react'
import { platform, usePlatform } from '@/platform'
import type { NotificationItem, NotificationSettings } from '@/platform/live-api'
import { defaultNotificationSettings, inDoNotDisturb } from '@/platform/live-protocol'
import { useLiveStatus } from '@/platform/useLive'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { errMsg, useToast } from './kit'

/* ------------------------------------------------------------------ settings (server-stored, cached here) */

interface SettingsStore {
  settings: NotificationSettings
  loaded: boolean
  load(): Promise<void>
  save(patch: Partial<NotificationSettings>): Promise<void>
}

export const useNotificationSettings = create<SettingsStore>((set, get) => ({
  settings: defaultNotificationSettings(),
  loaded: false,
  async load() {
    try {
      set({ settings: await platform.notifications.settings(), loaded: true })
    } catch {
      set({ loaded: true })
    }
  },
  async save(patch) {
    const next = { ...get().settings, ...patch }
    set({ settings: next })
    set({ settings: await platform.notifications.saveSettings(next) })
  },
}))

/* ------------------------------------------------------------------ helpers */

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** open a notification's deep link (switching environment first when it belongs to another one) */
export async function openNotification(n: NotificationItem): Promise<void> {
  if (!n.readOn) await platform.notifications.markRead([n.id]).catch(() => {})
  if (!n.link) return
  const st = platform.getState()
  if (n.environmentId && st.environmentId && n.environmentId !== st.environmentId && st.environments.some((e) => e.id === n.environmentId)) {
    await platform.environments.select(n.environmentId).catch(() => {})
  }
  if (n.link.startsWith('#')) window.location.hash = n.link.slice(1)
}

/* ------------------------------------------------------------------ toasts + desktop notifications (mounted once) */

interface Toast { id: string; n: NotificationItem }

/** listens for new notifications: a toast while focused, a browser notification while in the background */
export function NotificationCenter() {
  const ready = usePlatform((s) => s.ready && !!s.session)
  const [toasts, setToasts] = useState<Toast[]>([])
  const dismiss = useCallback((id: string) => setToasts((l) => l.filter((t) => t.id !== id)), [])

  useEffect(() => {
    if (!ready) return
    void useNotificationSettings.getState().load()
    return platform.notifications.onNotification((n) => {
      const s = useNotificationSettings.getState().settings
      if (s.kinds[n.kind] === false || inDoNotDisturb(s, new Date())) return
      const focused = typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()
      if (focused) {
        setToasts((l) => [...l.slice(-2), { id: n.id, n }])
        setTimeout(() => dismiss(n.id), 7000)
      } else if (s.desktop && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          const d = new Notification(n.title, { body: n.body || (n.from ? `From ${n.from}` : ''), tag: n.id })
          d.onclick = () => {
            window.focus()
            void openNotification(n)
            d.close()
          }
        } catch { /* the browser refused */ }
      }
    })
  }, [ready, dismiss])

  if (!toasts.length) return null
  return (
    <div className="pointer-events-none fixed right-4 top-28 z-[480] flex w-80 flex-col gap-2" data-testid="notification-toasts">
      {toasts.map(({ id, n }) => (
        <div key={id} role="status" data-testid="notification-toast" className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-sm shadow-lg">
          <Bell className="mt-0.5 size-4 shrink-0 text-primary" />
          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { dismiss(id); void openNotification(n) }}>
            <span className="block truncate font-medium">{n.title}</span>
            {n.body && <span className="line-clamp-2 block text-xs text-muted-foreground">{n.body}</span>}
            {n.from && <span className="block text-[11px] text-muted-foreground">From {n.from}</span>}
          </button>
          <button type="button" aria-label="Dismiss" className="rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={() => dismiss(id)}>
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ the bell */

export function NotificationBell({ className }: { className?: string }) {
  const unread = usePlatform((s) => s.unread ?? 0)
  const ready = usePlatform((s) => s.ready && !!s.session)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NotificationItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { fail } = useToast()
  const openRef = useRef(open)
  openRef.current = open

  const load = useCallback(async (more = false) => {
    setLoading(true)
    setError('')
    try {
      const r = await platform.notifications.list({ limit: 20, cursor: more ? cursor : null })
      setItems((prev) => (more ? [...prev, ...r.items] : r.items))
      setCursor(r.nextCursor)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [cursor])

  useEffect(() => {
    if (!ready) return
    // new ones appear at the top while the panel is open
    return platform.notifications.onNotification((n) => {
      if (openRef.current) setItems((l) => (l.some((x) => x.id === n.id) ? l : [n, ...l]))
    })
  }, [ready])

  const muted = useNotificationSettings((s) => inDoNotDisturb(s.settings, new Date()))

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) void load(false) }}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" className={cn('relative', className)} data-testid="notification-bell" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} title="Notifications">
          {muted ? <BellOff /> : <Bell />}
          {unread > 0 && (
            <span data-testid="notification-badge" className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-rose-600 px-1 text-[10px] font-semibold leading-none text-white">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0" data-testid="notification-panel">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">Notifications</span>
          {muted && <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">Do not disturb</span>}
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            disabled={!unread}
            data-testid="notification-read-all"
            onClick={async () => {
              try {
                await platform.notifications.markRead('all')
                const at = new Date().toISOString()
                setItems((l) => l.map((n) => (n.readOn ? n : { ...n, readOn: at })))
              } catch (e) {
                fail(e)
              }
            }}
          >
            <CheckCheck /> Mark all read
          </Button>
        </div>
        <div className="max-h-[420px] overflow-y-auto" data-testid="notification-list">
          {error && <p className="px-3 py-4 text-sm text-destructive">{error}</p>}
          {!error && !items.length && !loading && (
            <div className="flex flex-col items-center gap-1 px-3 py-8 text-center text-sm text-muted-foreground">
              <Bell className="size-5" />
              Nothing yet. Apps and flows notify you here.
            </div>
          )}
          {items.map((n) => (
            <div key={n.id} data-testid="notification-item" data-unread={n.readOn ? undefined : 'true'} className={cn('group flex gap-2 border-b border-border px-3 py-2.5 last:border-0', !n.readOn && 'bg-primary/5')}>
              <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.readOn ? 'bg-transparent' : 'bg-primary')} />
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={async () => {
                  setItems((l) => l.map((x) => (x.id === n.id ? { ...x, readOn: x.readOn ?? new Date().toISOString() } : x)))
                  if (n.link) setOpen(false)
                  await openNotification(n)
                }}
              >
                <span className="block text-sm font-medium">{n.title}</span>
                {n.body && <span className="line-clamp-3 block text-xs text-muted-foreground">{n.body}</span>}
                <span className="mt-0.5 block text-[11px] text-muted-foreground">{[n.from ? `From ${n.from}` : null, ago(n.createdOn)].filter(Boolean).join(' · ')}</span>
              </button>
              <button
                type="button"
                aria-label="Delete notification"
                title="Delete"
                className="h-6 shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                onClick={async () => {
                  try {
                    await platform.notifications.remove(n.id)
                    setItems((l) => l.filter((x) => x.id !== n.id))
                  } catch (e) {
                    fail(e)
                  }
                }}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
          {loading && <div className="flex justify-center py-3"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>}
          {cursor && !loading && (
            <div className="p-2 text-center"><Button size="xs" variant="ghost" onClick={() => void load(true)}>Show older</Button></div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/* ------------------------------------------------------------------ connection indicator */

/** shown only while live updates are not available (the page then refreshes data every 30 seconds) */
export function LiveIndicator() {
  const st = useLiveStatus()
  const mode = usePlatform((s) => s.mode)
  if (mode !== 'server' || st.state !== 'degraded') return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} data-testid="live-status" data-state={st.state} className="flex h-7 items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 text-xs text-amber-800 dark:text-amber-200">
          <WifiOff className="size-3.5" /> Live updates paused
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        {st.reason ?? 'The live connection to the server is not available.'} Changes other people make appear within 30 seconds instead of at once.
      </TooltipContent>
    </Tooltip>
  )
}
