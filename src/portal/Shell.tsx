import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  Boxes, Cloud, Cable, Database, FileSpreadsheet, Hammer, Home, HardDrive, LayoutGrid, Menu, Moon, Search, Shapes, ShieldCheck, Sun, Table2, X,
} from 'lucide-react'
import { usePlatform } from '@/platform'
import { go, type Route } from '@/router'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ChatButton } from '@/chat/ChatDock'
import { openChat } from '@/chat/open'
import { ProfileAvatar, SettingsEntry } from './Profile'
import { EnvironmentPicker, EnvironmentStripe } from './EnvironmentPicker'
import { RestoreNotice } from './RestoreNotice'
import { ReadOnlyBanner } from './ReadOnlyBanner'
import { useCaps } from './security'
import { useTheme } from './theme'
import { modulesFor, moduleRoute, type ModuleEntry, type ShellMode } from './modules'
import { SoonBadge } from './ComingSoon'
import { AppTabPanes, TabStrip } from './UserMode'
import { LiveIndicator, NotificationBell } from './Notifications'

/* ------------------------------------------------------------------ search context */

const SearchCtx = createContext<{ q: string; setQ(q: string): void }>({ q: '', setQ: () => undefined })
export const useSearch = () => useContext(SearchCtx).q
export function SearchProvider({ children }: { children: ReactNode }) {
  const [q, setQ] = useState('')
  return <SearchCtx.Provider value={{ q, setQ }}>{children}</SearchCtx.Provider>
}
export const matches = (q: string, ...fields: (string | undefined)[]) => {
  const n = q.trim().toLowerCase()
  return !n || fields.some((f) => f?.toLowerCase().includes(n))
}

/* ------------------------------------------------------------------ shell */

/** the portal's routes (the shared router's) */
export type PortalRoute = Route
export const DATAFILES_HASH = '#datafiles'
export function goPortal(page: 'home' | 'apps' | 'tables' | 'roles' | 'solutions' | 'connections' | 'datafiles') {
  go({ page })
}

type NavItem = { page: 'home' | 'apps' | 'tables' | 'roles' | 'solutions' | 'connections' | 'datafiles'; label: string; icon: typeof Home; need?: 'maker' | 'admin' }
const NAV: NavItem[] = [
  { page: 'home', label: 'Home', icon: Home },
  { page: 'apps', label: 'Apps', icon: LayoutGrid },
  { page: 'tables', label: 'Tables', icon: Table2, need: 'maker' },
  { page: 'datafiles', label: 'Data files', icon: FileSpreadsheet, need: 'maker' },
  { page: 'roles', label: 'Security roles', icon: ShieldCheck, need: 'admin' },
  { page: 'solutions', label: 'Solutions', icon: Boxes, need: 'maker' },
  { page: 'connections', label: 'Connections', icon: Cable, need: 'maker' },
]

function activeNav(route: PortalRoute): string {
  if (route.page === 'table') return 'tables'
  if (route.page === 'solution') return 'solutions'
  if (route.page === 'flow') return 'flows'
  if (route.page === 'printtemplate') return 'printtemplates'
  if (route.page === 'soon') return `soon-${route.id}`
  // built-in User mode pages light up their menu entry (#u-approvals -> Approvals); app tabs keep "My apps"
  if (route.page === 'u') return 'id' in route ? ({ approvals: 'approvals', tasks: 'tasks', mentions: 'mentions', reports: 'myreports', dashboards: 'dashboards' } as Record<string, string>)[route.id] ?? 'u' : 'u'
  if (route.page === 'admin') return 'admin'
  return route.page
}

/** may the signed-in user open this page? (UX only; the server enforces) */
export function pageAllowed(page: PortalRoute['page'], caps: { isAdmin: boolean; isMaker: boolean }): boolean {
  if (page === 'roles' || page === 'admin') return caps.isAdmin
  if (['tables', 'table', 'datafiles', 'solutions', 'solution', 'connections', 'datamodel', 'flows', 'flow', 'printtemplates', 'printtemplate', 'templates'].includes(page)) return caps.isMaker
  return true
}

/** pages that belong to Dev mode (the maker portal) */
export const DEV_PAGES: ReadonlySet<PortalRoute['page']> = new Set(['home', 'apps', 'tables', 'table', 'datafiles', 'roles', 'solutions', 'solution', 'connections', 'studio', 'admin', 'datamodel', 'reports', 'flows', 'flow', 'printtemplates', 'printtemplate', 'templates'])

const allowedEntry = (m: ModuleEntry, caps: { isAdmin: boolean; isMaker: boolean }) => !m.need || (m.need === 'admin' ? caps.isAdmin : caps.isMaker)

function NavButton({ active, onClick, icon: Icon, label, testId, soon, dense }: { active: boolean; onClick(): void; icon: typeof Home; label: string; testId: string; soon?: boolean; dense?: boolean }) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'flex shrink-0 items-center gap-2.5 rounded-md px-2.5 text-left text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
        dense ? 'h-8' : 'h-9',
        active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {soon && <SoonBadge />}
    </button>
  )
}

function ModuleNav({ mode, active, caps }: { mode: ShellMode; active: string; caps: { isAdmin: boolean; isMaker: boolean } }) {
  const entries = modulesFor(mode).filter((m) => allowedEntry(m, caps))
  // live modules sit with the other pages; planned ones under "Coming soon"
  const live = entries.filter((m) => m.status === 'live')
  const soon = entries.filter((m) => m.status !== 'live')
  return (
    <>
      {live.map((m) => (
        <NavButton key={m.key} testId={`nav-${m.key}`} active={active === m.key} icon={m.icon} label={m.label} onClick={() => (m.action === 'chat' ? openChat() : go(moduleRoute(m)))} />
      ))}
      {mode === 'dev' && soon.length > 0 && <div className="mb-0.5 mt-3 px-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/80">Coming soon</div>}
      {soon.map((m) => (
        <NavButton
          key={m.key}
          dense={mode === 'dev'}
          testId={`nav-soon-${m.key}`}
          active={active === `soon-${m.key}`}
          icon={m.icon}
          label={m.label}
          soon={m.status === 'soon'}
          onClick={() => (m.action === 'chat' ? openChat() : go(moduleRoute(m)))}
        />
      ))}
    </>
  )
}

/** Dev mode / User mode switch for makers and admins */
function ModeSwitch({ mode, onChange }: { mode: ShellMode; onChange(m: ShellMode): void }) {
  const opt = (m: ShellMode, label: string, Icon: typeof Home, title: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === m}
      data-testid={`mode-${m}`}
      title={title}
      onClick={() => onChange(m)}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
        mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon className="size-3.5" /> {label}
    </button>
  )
  return (
    <div role="radiogroup" aria-label="Mode" data-testid="mode-switch" className="inline-flex shrink-0 rounded-md bg-muted p-0.5">
      {opt('dev', 'Dev mode', Hammer, 'Build: apps, tables, security and the Studio')}
      {opt('user', 'User mode', LayoutGrid, 'Use: open your apps as tabs')}
    </div>
  )
}

export interface ShellProps {
  route: PortalRoute
  mode: ShellMode
  /** makers and admins may switch modes */
  canSwitch: boolean
  onModeChange(m: ShellMode): void
  /** User mode: the app tab shown (null: the launcher tab) */
  activeTab: string | null
  /** the Studio is open in front: the shell stays mounted (app tabs keep their state) but is hidden */
  hidden?: boolean
  children: ReactNode
}

export function Shell({ route, mode, canSwitch, onModeChange, activeTab, hidden, children }: ShellProps) {
  const { q, setQ } = useContext(SearchCtx)
  const { theme, toggle } = useTheme()
  const storage = usePlatform((s) => s.storage)
  const caps = useCaps()
  const active = activeNav(route)
  const user = mode === 'user'
  const appTab = user && activeTab !== null
  const searchable = !appTab && !hidden && ['apps', 'tables', 'roles', 'solutions', 'connections', 'home', 'datafiles', 'u', 'admin'].includes(route.page)

  useEffect(() => { setQ('') }, [route.page, setQ])
  // phone width (below md): the menu is a drawer behind a button, the header keeps the essentials (P1-C: approvers
  // answer from their phones); from md up nothing changes
  const [navOpen, setNavOpen] = useState(false)
  useEffect(() => { setNavOpen(false) }, [route])

  return (
    <div data-testid="portal-root" data-mode={mode} hidden={hidden} className={cn('flex h-full flex-col overflow-hidden bg-background text-foreground md:min-w-[900px]', hidden && 'hidden')}>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-2 md:gap-3 md:px-4">
        {!appTab && (
          <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Menu" aria-expanded={navOpen} onClick={() => setNavOpen((v) => !v)} data-testid="nav-toggle">
            <Menu />
          </Button>
        )}
        <button type="button" onClick={() => go(user ? { page: 'u' } : { page: 'home' })} title="Appbuilder home" className="flex shrink-0 items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/40" aria-label="Appbuilder home">
          <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground shadow-xs"><Shapes className="size-4" /></span>
          <span className="hidden text-[15px] font-semibold tracking-tight sm:inline">Appbuilder</span>
        </button>
        {canSwitch && <div className="hidden md:block"><ModeSwitch mode={mode} onChange={onModeChange} /></div>}
        <div className="relative mx-auto hidden w-full max-w-lg md:block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            disabled={!searchable}
            placeholder={user ? 'Search your apps...' : 'Search apps, tables, roles...'}
            aria-label="Search the current list"
            data-testid="global-search"
            className="h-8 w-full rounded-md border border-transparent bg-muted pl-8 pr-8 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:bg-background focus:ring-2 focus:ring-ring/20 disabled:opacity-60 [&::-webkit-search-cancel-button]:hidden"
          />
          {q && (
            <button type="button" aria-label="Clear search" onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground">
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!user && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span data-testid="storage-badge" tabIndex={0} className="flex h-7 max-w-[220px] items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground">
                  {storage.kind === 'postgres' ? <Database className="size-3.5 shrink-0" /> : storage.kind === 'local-folder' ? <HardDrive className="size-3.5 shrink-0" /> : <Cloud className="size-3.5 shrink-0" />}
                  <span className="truncate">{storage.kind === 'browser' ? 'Browser storage' : storage.location}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {storage.kind === 'postgres' ? `Default store: ${storage.location}` : storage.kind === 'local-folder' ? `Workspace folder: ${storage.location}` : 'Demo mode: your workspace is kept in this browser. Run the local server for PostgreSQL, sign-in and server-enforced security.'}
              </TooltipContent>
            </Tooltip>
          )}
          <Button variant="ghost" size="icon-sm" className="hidden md:inline-flex" onClick={toggle} data-testid="portal-theme-toggle" aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} title={theme === 'dark' ? 'Light theme' : 'Dark theme'}>
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
          <LiveIndicator />
          {/* Power Platform order: notifications, chat, environment, account (last) */}
          <NotificationBell />
          <div className="hidden items-center gap-2 md:flex"><ChatButton /><EnvironmentPicker /></div>
          <ProfileAvatar />
        </div>
      </header>
      <EnvironmentStripe />
      <RestoreNotice />
      <ReadOnlyBanner />
      {user && <TabStrip activeId={activeTab} />}
      <div className="flex min-h-0 flex-1">
        {!appTab && (
          <nav aria-label="Main" data-testid={user ? 'user-nav' : 'dev-nav'} className={cn('w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-card/60 p-2.5 md:flex', navOpen ? 'fixed top-12 bottom-0 left-0 z-40 flex bg-card shadow-lg md:static md:bg-card/60 md:shadow-none' : 'hidden')}>
            {canSwitch && <div className="mb-2 md:hidden"><ModeSwitch mode={mode} onChange={onModeChange} /></div>}
            {user ? (
              <>
                <NavButton testId="nav-my-apps" active={active === 'u'} icon={LayoutGrid} label="My apps" onClick={() => go({ page: 'u' })} />
                <ModuleNav mode="user" active={active} caps={caps} />
              </>
            ) : (
              <>
                {NAV.filter((n) => !n.need || (n.need === 'admin' ? caps.isAdmin : caps.isMaker)).map((n) => (
                  <NavButton key={n.page} testId={`nav-${n.page}`} active={active === n.page} icon={n.icon} label={n.label} onClick={() => goPortal(n.page)} />
                ))}
                <ModuleNav mode="dev" active={active} caps={caps} />
              </>
            )}
            <div className="mt-auto flex min-w-0 shrink-0 flex-col gap-2 pt-3">
              {!user && (
                <div className="rounded-lg border border-border bg-background p-3 text-xs text-muted-foreground">
                  {caps.server ? 'Your data lives in the default database of this environment. Data files and device-only connections stay on this machine.' : 'Everything lives in your workspace in this browser. Export a package to share it.'}
                </div>
              )}
              <div className="border-t border-border pt-2"><SettingsEntry /></div>
            </div>
          </nav>
        )}
        <main className="relative min-w-0 flex-1 bg-canvas">
          <div className={cn('absolute inset-0 overflow-auto', appTab && 'hidden')}>
            {/* full-bleed pages (the data model designer's canvas) fill the area themselves */}
            <div className={route.page === 'datamodel' ? 'h-full w-full' : 'mx-auto w-full max-w-[1500px] px-2 py-3 md:px-8 md:py-6'}>{children}</div>
          </div>
          <AppTabPanes activeId={user ? activeTab : null} />
        </main>
      </div>
    </div>
  )
}
