import { useEffect, useMemo } from 'react'
import { AppWindow, ChevronDown, Clock, ExternalLink, LayoutGrid, MonitorPlay, PanelTop, Play, Smartphone, Tablet, X } from 'lucide-react'
import { usePlatform, type AppMeta } from '@/platform'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { RunApp } from '@/runtime/RunApp'
import { deviceOf } from '@/runtime/sizes'
import { go } from '@/router'
import { Empty, PageHeader, fmtRelative, useToast } from './kit'
import { matches, useSearch } from './Shell'
import { canRun, closeAppTab, openAppTab, openAppWindow, useWorkspace } from './workspace'

/* ------------------------------------------------------------------ helpers */

export function DeviceIcon({ app, className }: { app: Pick<AppMeta, 'width' | 'height'>; className?: string }) {
  const d = deviceOf(app.width, app.height)
  const Icon = d === 'Phone' ? Smartphone : d === 'Tablet' ? Tablet : AppWindow
  return <Icon className={className} aria-hidden />
}

/** the apps the signed-in user may run (role app access), reactive to sign-in and role changes */
export function useRunnableApps(): AppMeta[] {
  const apps = usePlatform((s) => s.apps)
  const session = usePlatform((s) => s.session)
  const roles = usePlatform((s) => s.roles)
  const current = usePlatform((s) => s.currentUserId)
  return useMemo(() => apps.filter((a) => canRun(a.id)), [apps, session, roles, current]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** open in a new window, falling back to a tab (with a hint) when the browser blocks pop-ups */
export function useOpenInWindow() {
  const { toast } = useToast()
  return (id: string) => {
    if (!openAppWindow(id)) {
      openAppTab(id)
      toast('The browser blocked the new window, so the app opened as a tab. Allow pop-ups for this site to use new windows.', 'info')
    }
  }
}

/** Dev mode "Run": open as a tab (User mode) or in a new window */
export function RunChoice({ app, size = 'xs', variant = 'ghost' }: { app: AppMeta; size?: 'xs' | 'sm'; variant?: 'ghost' | 'outline' }) {
  const inWindow = useOpenInWindow()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size={size} variant={variant} data-testid={`run-choice-${app.id}`} onClick={(e) => e.stopPropagation()}>
          <MonitorPlay /> Run <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem data-testid={`run-tab-${app.id}`} onSelect={() => openAppTab(app.id)}><PanelTop /> Open in a tab</DropdownMenuItem>
        <DropdownMenuItem data-testid={`run-window-${app.id}`} onSelect={() => inWindow(app.id)}><ExternalLink /> Open in new window</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/* ------------------------------------------------------------------ launcher */

function AppTile({ app }: { app: AppMeta }) {
  const inWindow = useOpenInWindow()
  const device = deviceOf(app.width, app.height)
  const portrait = app.height > app.width
  return (
    <div data-testid={`launcher-app-${app.id}`} className="group relative flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xs transition-all hover:border-primary/40 hover:shadow-md">
      <button
        type="button"
        onClick={() => openAppTab(app.id)}
        aria-label={`Open ${app.name}`}
        data-testid={`launcher-open-${app.id}`}
        className="relative grid h-28 place-items-center bg-gradient-to-br from-accent/70 to-muted outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
      >
        <div
          className={cn('flex items-start gap-1 rounded-md border border-border bg-background p-1.5 shadow-sm', portrait ? 'h-20 flex-col' : 'h-16')}
          style={{ aspectRatio: String(Math.max(1, app.width) / Math.max(1, app.height)) }}
          aria-hidden
        >
          {portrait ? (
            <>
              <div className="h-1.5 w-full rounded-sm bg-primary/40" />
              <div className="h-1.5 w-2/3 rounded-sm bg-muted-foreground/25" />
              <div className="h-1.5 w-3/4 rounded-sm bg-muted-foreground/25" />
              <div className="h-1.5 w-1/2 rounded-sm bg-muted-foreground/25" />
            </>
          ) : (
            <>
              <div className="h-full w-1/4 rounded-sm bg-primary/25" />
              <div className="flex h-full flex-1 flex-col gap-1">
                <div className="h-1.5 w-2/3 rounded-sm bg-muted-foreground/30" />
                <div className="h-full rounded-sm bg-muted" />
              </div>
            </>
          )}
        </div>
        <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-md bg-background/80 px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground backdrop-blur">
          <DeviceIcon app={app} className="size-3" /> {device}
        </span>
      </button>
      <div className="flex items-center gap-1 p-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{app.name}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{app.description || `Updated ${fmtRelative(app.modifiedOn)}`}</div>
        </div>
        <Button size="xs" onClick={() => openAppTab(app.id)}><Play className="fill-current" /> Open</Button>
        <Button size="icon-sm" variant="ghost" title="Open in new window" aria-label={`Open ${app.name} in new window`} data-testid={`launcher-window-${app.id}`} onClick={() => inWindow(app.id)}>
          <ExternalLink />
        </Button>
      </div>
    </div>
  )
}

/** `#u`: My apps */
export function MyApps() {
  const apps = useRunnableApps()
  const recentIds = useWorkspace((s) => s.recent)
  const q = useSearch()
  const list = apps.filter((a) => matches(q, a.name, a.description)).sort((a, b) => a.name.localeCompare(b.name))
  const recent = recentIds.map((id) => apps.find((a) => a.id === id)).filter((a): a is AppMeta => !!a).slice(0, 4)
  return (
    <div data-testid="page-my-apps">
      <PageHeader icon={LayoutGrid} title="My apps" subtitle={`${apps.length} ${apps.length === 1 ? 'app' : 'apps'} you can use`} />
      {apps.length === 0 ? (
        <Empty icon={LayoutGrid} title="No apps for you yet" description="Apps appear here when an administrator adds them to one of your security roles." />
      ) : (
        <>
          {!q.trim() && recent.length > 0 && (
            <section aria-label="Recently opened" className="mb-7">
              <h2 className="mb-2.5 flex items-center gap-1.5 text-sm font-semibold"><Clock className="size-3.5 text-muted-foreground" /> Recently opened</h2>
              <div className="flex flex-wrap gap-2" data-testid="recent-opened">
                {recent.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => openAppTab(a.id)}
                    data-testid={`recent-app-${a.id}`}
                    className="flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-medium shadow-xs outline-none transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    <DeviceIcon app={a} className="size-4 text-primary" />
                    <span className="max-w-48 truncate">{a.name}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
          <section aria-label="All apps">
            {!q.trim() && recent.length > 0 && <h2 className="mb-2.5 text-sm font-semibold">All apps</h2>}
            {list.length === 0 ? (
              <Empty icon={LayoutGrid} title="No matching apps" description={`Nothing matches "${q}".`} />
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4" data-testid="launcher-grid">
                {list.map((a) => <AppTile key={a.id} app={a} />)}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ tabs */

/** keep the tab list consistent with the route and the workspace: the routed app is open, gone apps are dropped */
export function useTabSync(activeId: string | null) {
  const apps = usePlatform((s) => s.apps)
  const tabs = useWorkspace((s) => s.tabs)
  useEffect(() => {
    if (activeId && apps.some((a) => a.id === activeId) && !tabs.includes(activeId)) useWorkspace.getState().openTab(activeId)
  }, [activeId, apps, tabs])
  useEffect(() => {
    const ids = new Set(apps.map((a) => a.id))
    useWorkspace.getState().prune((id) => ids.has(id))
  }, [apps])
}

/** the strip under the top bar: the launcher (fixed first tab) and one tab per open app */
export function TabStrip({ activeId }: { activeId: string | null }) {
  const tabs = useWorkspace((s) => s.tabs)
  const apps = usePlatform((s) => s.apps)
  const inWindow = useOpenInWindow()
  return (
    <div role="tablist" aria-label="Open apps" data-testid="tab-strip" className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b border-border bg-muted/50 px-2 pt-1.5">
      <button
        type="button"
        role="tab"
        aria-selected={activeId === null}
        data-testid="tab-launcher"
        onClick={() => go({ page: 'u' })}
        className={cn(
          'flex h-full shrink-0 items-center gap-1.5 rounded-t-lg border border-b-0 px-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          activeId === null ? 'border-border bg-background text-foreground' : 'border-transparent text-muted-foreground hover:bg-background/60 hover:text-foreground',
        )}
      >
        <LayoutGrid className="size-3.5" /> My apps
      </button>
      {tabs.map((id) => {
        const app = apps.find((a) => a.id === id)
        const active = id === activeId
        const name = app?.name ?? 'App'
        return (
          <div
            key={id}
            role="tab"
            tabIndex={0}
            aria-selected={active}
            data-testid={`app-tab-${id}`}
            title={name}
            onClick={() => go({ page: 'u', id })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                go({ page: 'u', id })
              } else if (e.key === 'Delete') closeAppTab(id, activeId)
            }}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault() // no autoscroll on middle-click
            }}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                closeAppTab(id, activeId)
              }
            }}
            className={cn(
              'group flex h-full min-w-0 max-w-56 shrink-0 cursor-default items-center gap-1.5 rounded-t-lg border border-b-0 pl-3 pr-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
              active ? 'border-border bg-background text-foreground' : 'border-transparent text-muted-foreground hover:bg-background/60 hover:text-foreground',
            )}
          >
            {app ? <DeviceIcon app={app} className="size-3.5 shrink-0" /> : <AppWindow className="size-3.5 shrink-0" />}
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <button
              type="button"
              title="Open in new window"
              aria-label={`Open ${name} in new window`}
              data-testid={`app-tab-window-${id}`}
              onClick={(e) => {
                e.stopPropagation()
                inWindow(id)
              }}
              className={cn('grid size-5 shrink-0 place-items-center rounded hover:bg-muted hover:text-foreground', active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}
            >
              <ExternalLink className="size-3" />
            </button>
            <button
              type="button"
              title="Close tab (middle-click)"
              aria-label={`Close ${name}`}
              data-testid={`app-tab-close-${id}`}
              onClick={(e) => {
                e.stopPropagation()
                closeAppTab(id, activeId)
              }}
              className="grid size-5 shrink-0 place-items-center rounded hover:bg-muted hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

/**
 * One mounted RunApp per open tab, each with its own app store. Inactive tabs are hidden (not unmounted), so every
 * app keeps its state while you switch tabs, modes or open the Studio.
 */
export function AppTabPanes({ activeId }: { activeId: string | null }) {
  const tabs = useWorkspace((s) => s.tabs)
  return (
    <>
      {tabs.map((id) => (
        <div key={id} role="tabpanel" data-testid={`tab-pane-${id}`} aria-hidden={id !== activeId} className={cn('absolute inset-0', id === activeId ? 'block' : 'hidden')}>
          <RunApp appId={id} embedded onBack={() => go({ page: 'u' })} />
        </div>
      ))}
    </>
  )
}
