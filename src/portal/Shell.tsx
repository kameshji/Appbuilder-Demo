import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Boxes, Check, ChevronDown, Cloud, Cable, Home, HardDrive, LayoutGrid, Moon, Search, Shapes, ShieldCheck, Sun, Table2, UserRound, X } from 'lucide-react'
import { platform, usePlatform } from '@/platform'
import { go, type Route } from '@/router'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useToast } from './kit'

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

/* ------------------------------------------------------------------ theme (same key and behaviour as the Studio) */

const THEME_KEY = 'appbuilder-theme'
function readTheme(): 'light' | 'dark' {
  try {
    const t = localStorage.getItem(THEME_KEY)
    if (t === 'dark' || t === 'light') return t
  } catch {
    /* ignore */
  }
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}
function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(readTheme)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      /* ignore */
    }
  }
  return { theme, toggle }
}

/* ------------------------------------------------------------------ shell */

const NAV = [
  { page: 'home', label: 'Home', icon: Home },
  { page: 'apps', label: 'Apps', icon: LayoutGrid },
  { page: 'tables', label: 'Tables', icon: Table2 },
  { page: 'roles', label: 'Security roles', icon: ShieldCheck },
  { page: 'solutions', label: 'Solutions', icon: Boxes },
  { page: 'connections', label: 'Connections', icon: Cable },
] as const

function activeNav(route: Route): string {
  if (route.page === 'table') return 'tables'
  if (route.page === 'solution') return 'solutions'
  return route.page
}

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const { q, setQ } = useContext(SearchCtx)
  const { theme, toggle } = useTheme()
  const storage = usePlatform((s) => s.storage)
  const users = usePlatform((s) => s.users)
  const currentUserId = usePlatform((s) => s.currentUserId)
  const { fail } = useToast()
  const user = users.find((u) => u.id === currentUserId)
  const active = activeNav(route)
  const searchable = ['apps', 'tables', 'roles', 'solutions', 'connections', 'home'].includes(route.page)

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
                {storage.kind === 'local-folder' ? <HardDrive className="size-3.5 shrink-0" /> : <Cloud className="size-3.5 shrink-0" />}
                <span className="truncate">{storage.kind === 'local-folder' ? storage.location : 'Browser storage'}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {storage.kind === 'local-folder' ? `Workspace folder: ${storage.location}` : 'Your workspace is kept in this browser. Run the local server to use real files.'}
            </TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="xs" className="h-7 gap-1.5" data-testid="user-switcher" aria-label="Run as user">
                <UserRound />
                <span className="max-w-32 truncate">{user?.name ?? 'No user'}</span>
                <ChevronDown className="opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
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
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon-sm" onClick={toggle} data-testid="portal-theme-toggle" aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Main" className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-border bg-card/60 p-2.5">
          {NAV.map((n) => (
            <button
              key={n.page}
              type="button"
              data-testid={`nav-${n.page}`}
              aria-current={active === n.page ? 'page' : undefined}
              onClick={() => go({ page: n.page })}
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
            Everything lives in your workspace on this machine. Export a package to share it.
          </div>
        </nav>
        <main className="min-w-0 flex-1 overflow-auto bg-canvas">
          <div className="mx-auto w-full max-w-[1500px] px-8 py-6">{children}</div>
        </main>
      </div>
    </div>
  )
}
