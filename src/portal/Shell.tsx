import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Boxes, Cloud, Cable, Database, FileSpreadsheet, Home, HardDrive, LayoutGrid, Moon, Search, Shapes, ShieldCheck, Sun, Table2, X } from 'lucide-react'
import { usePlatform } from '@/platform'
import { go, type Route } from '@/router'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { UserMenu } from './Auth'
import { useCaps } from './security'
import { useTheme } from './theme'

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

/** the portal's routes: the shared router's plus the Data files page (hash #datafiles, handled here) */
export type PortalRoute = Route | { page: 'datafiles' }
export const DATAFILES_HASH = '#datafiles'
export function goPortal(page: PortalRoute['page']) {
  if (page === 'datafiles') {
    if (location.hash !== DATAFILES_HASH) location.hash = DATAFILES_HASH
  } else go({ page } as Route)
}

type NavItem = { page: PortalRoute['page']; label: string; icon: typeof Home; need?: 'maker' | 'admin' }
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
  return route.page
}

/** may the signed-in user open this page? (UX only; the server enforces) */
export function pageAllowed(page: PortalRoute['page'], caps: { isAdmin: boolean; isMaker: boolean }): boolean {
  if (page === 'roles') return caps.isAdmin
  if (['tables', 'table', 'datafiles', 'solutions', 'solution', 'connections'].includes(page)) return caps.isMaker
  return true
}

export function Shell({ route, children }: { route: PortalRoute; children: ReactNode }) {
  const { q, setQ } = useContext(SearchCtx)
  const { theme, toggle } = useTheme()
  const storage = usePlatform((s) => s.storage)
  const caps = useCaps()
  const active = activeNav(route)
  const searchable = ['apps', 'tables', 'roles', 'solutions', 'connections', 'home', 'datafiles'].includes(route.page)

  useEffect(() => { setQ('') }, [route.page, setQ])

  return (
    <div data-testid="portal-root" className="flex h-full min-w-[1100px] flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
        <button type="button" onClick={() => go({ page: 'home' })} className="flex w-44 items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/40" aria-label="Appbuilder home">
          <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground shadow-xs"><Shapes className="size-4" /></span>
          <span className="text-[15px] font-semibold tracking-tight">Appbuilder</span>
        </button>
        <div className="relative mx-auto w-full max-w-lg">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            disabled={!searchable}
            placeholder="Search apps, tables, roles..."
            aria-label="Search the current list"
            data-testid="global-search"
            className="h-8 w-full rounded-md border border-transparent bg-muted pl-8 pr-8 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:bg-background focus:ring-2 focus:ring-ring/20 [&::-webkit-search-cancel-button]:hidden"
          />
          {q && (
            <button type="button" aria-label="Clear search" onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground">
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span data-testid="storage-badge" tabIndex={0} className="flex h-7 max-w-[260px] items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground">
                {storage.kind === 'mysql' ? <Database className="size-3.5 shrink-0" /> : storage.kind === 'local-folder' ? <HardDrive className="size-3.5 shrink-0" /> : <Cloud className="size-3.5 shrink-0" />}
                <span className="truncate">{storage.kind === 'browser' ? 'Browser storage' : storage.location}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {storage.kind === 'mysql' ? `Default store: ${storage.location}` : storage.kind === 'local-folder' ? `Workspace folder: ${storage.location}` : 'Demo mode: your workspace is kept in this browser. Run the local server for MySQL, sign-in and server-enforced security.'}
            </TooltipContent>
          </Tooltip>
          <UserMenu />
          <Button variant="ghost" size="icon-sm" onClick={toggle} data-testid="portal-theme-toggle" aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Main" className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-border bg-card/60 p-2.5">
          {NAV.filter((n) => !n.need || (n.need === 'admin' ? caps.isAdmin : caps.isMaker)).map((n) => (
            <button
              key={n.page}
              type="button"
              data-testid={`nav-${n.page}`}
              aria-current={active === n.page ? 'page' : undefined}
              onClick={() => goPortal(n.page)}
              className={cn(
                'flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
                active === n.page ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <n.icon className="size-4" />
              {n.label}
            </button>
          ))}
          <div className="mt-auto rounded-lg border border-border bg-background p-3 text-xs text-muted-foreground">
            {caps.server ? 'Your data lives in the default database. Data files and device-only connections stay on this machine.' : 'Everything lives in your workspace in this browser. Export a package to share it.'}
          </div>
        </nav>
        <main className="min-w-0 flex-1 overflow-auto bg-canvas">
          <div className="mx-auto w-full max-w-[1500px] px-8 py-6">{children}</div>
        </main>
      </div>
    </div>
  )
}
