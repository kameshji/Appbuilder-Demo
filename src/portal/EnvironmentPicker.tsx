/**
 * Environment picker in the top bar (where Power Platform shows it): the current environment's name and a type badge
 * that is always visible (production in red, sandbox amber, developer blue; a lock when production is locked), a list
 * to switch (with a search box from 7 environments) and, for administrators, a link to manage them.
 * Switching reloads the workspace of the other environment (src/platform/remote.ts select()); open app tabs belong to
 * an environment (workspace.ts keys them by it), and pages that show one environment's objects go back to the start.
 */
import { useMemo, useState } from 'react'
import { Check, ChevronDown, Layers, Lock, Search, Settings2, TriangleAlert } from 'lucide-react'
import { ENVIRONMENT_TYPE_LABEL, platform, usePlatform, type EnvironmentDef } from '@/platform'
import { go, parseRoute, type Route } from '@/router'
import { useStore } from '@/runtime/store'
import { cn } from '@/lib/utils'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useToast } from './kit'
import { useCaps } from './security'

export const SEARCH_FROM = 7

/** the colours of an environment type, used by the badge and the stripe under the top bar */
export const ENV_TYPE_STYLE: Record<EnvironmentDef['type'], { badge: string; stripe: string }> = {
  production: { badge: 'bg-rose-600 text-white dark:bg-rose-500', stripe: 'bg-rose-600 dark:bg-rose-500' },
  sandbox: { badge: 'bg-amber-400/90 text-amber-950 dark:bg-amber-400 dark:text-amber-950', stripe: 'bg-amber-400' },
  developer: { badge: 'bg-sky-500/15 text-sky-700 ring-1 ring-inset ring-sky-500/40 dark:text-sky-300', stripe: 'bg-sky-500' },
}

export function TypeBadge({ type, locked, className }: { type: EnvironmentDef['type']; locked?: boolean; className?: string }) {
  return (
    <span
      data-testid="env-type"
      data-type={type}
      className={cn('inline-flex h-4 shrink-0 items-center gap-0.5 rounded px-1 text-[10px] font-semibold uppercase tracking-wide', ENV_TYPE_STYLE[type].badge, className)}
    >
      {locked && <Lock className="size-2.5" aria-label="locked" />}
      {ENVIRONMENT_TYPE_LABEL[type]}
    </span>
  )
}

/** a thin line in the environment's colour under the top bar: production is never mistaken for a sandbox */
export function EnvironmentStripe() {
  const list = usePlatform((s) => s.environments)
  const currentId = usePlatform((s) => s.environmentId)
  const current = list.find((e) => e.id === currentId)
  if (!current || list.length < 2) return null
  return <div aria-hidden data-testid="env-stripe" data-type={current.type} className={cn('h-[3px] w-full shrink-0', ENV_TYPE_STYLE[current.type].stripe)} />
}

/** the current environment, read-only (the Studio shows it in its own bar) */
export function EnvironmentBadge({ className }: { className?: string }) {
  const list = usePlatform((s) => s.environments)
  const currentId = usePlatform((s) => s.environmentId)
  const current = list.find((e) => e.id === currentId)
  if (!current) return null
  return (
    <span data-testid="env-badge" title={`Environment: ${current.name} (${ENVIRONMENT_TYPE_LABEL[current.type]}${current.locked ? ', locked' : ''})`} className={cn('flex max-w-[200px] shrink-0 items-center gap-1.5 text-xs', className)}>
      <Layers className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate font-medium">{current.name}</span>
      <TypeBadge type={current.type} locked={current.locked} />
    </span>
  )
}

/** routes that show one environment's objects: after a switch they would point at nothing */
function envSpecific(r: Route): boolean {
  return r.page === 'studio' || r.page === 'table' || r.page === 'solution' || (r.page === 'u' && 'id' in r && !!r.id) || r.page === 'run'
}

/**
 * Switches to another environment. An app open in the Studio with changes not yet saved is saved first (the Studio
 * autosaves; this waits for it), after asking.
 */
export async function switchEnvironment(id: string, current: Route | null, ask: (q: string) => boolean = (q) => window.confirm(q)): Promise<boolean> {
  const st = useStore.getState()
  if (current?.page === 'studio' && (st.saveState === 'unsaved' || st.saveState === 'saving')) {
    if (!ask('The app in the Studio has changes that are not saved yet. Save them and switch environments?')) return false
    if (st.appId) await platform.apps.save(st.appId, JSON.parse(JSON.stringify(st.app)))
  }
  await platform.environments.select(id)
  if (current && envSpecific(current)) go(current.page === 'u' ? { page: 'u' } : { page: 'home' })
  return true
}

function routeNow(): Route | null {
  try {
    return parseRoute(location.hash)
  } catch {
    return null
  }
}

export function EnvironmentPicker() {
  const list = usePlatform((s) => s.environments)
  const currentId = usePlatform((s) => s.environmentId)
  const server = usePlatform((s) => s.mode) === 'server'
  const caps = useCaps()
  const { fail } = useToast()
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const current = list.find((e) => e.id === currentId) ?? null
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase()
    return n ? list.filter((e) => e.name.toLowerCase().includes(n) || ENVIRONMENT_TYPE_LABEL[e.type].toLowerCase().includes(n)) : list
  }, [list, q])
  if (!current) return null

  const pick = (e: EnvironmentDef) => {
    if (e.id === currentId || busy) return
    setBusy(true)
    switchEnvironment(e.id, routeNow()).catch(fail).finally(() => setBusy(false))
  }

  return (
    <DropdownMenu onOpenChange={(o) => { if (!o) setQ('') }}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="env-picker"
          data-env={current.id}
          aria-label={`Environment: ${current.name} (${ENVIRONMENT_TYPE_LABEL[current.type]}${current.locked ? ', locked' : ''})`}
          title="Environment"
          className={cn(
            'flex h-7 max-w-[260px] shrink-0 items-center gap-1.5 rounded-md border bg-background px-2 text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40',
            current.type === 'production' && list.length > 1 ? 'border-rose-500/50' : 'border-border',
          )}
        >
          <Layers className={cn('size-3.5 shrink-0 text-muted-foreground', busy && 'animate-pulse')} />
          <span className="truncate font-medium" data-testid="env-current">{current.name}</span>
          <TypeBadge type={current.type} locked={current.locked} />
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80" data-testid="env-menu">
        <DropdownMenuLabel className="text-[10.5px] uppercase tracking-wider text-muted-foreground">Environments</DropdownMenuLabel>
        {list.length >= SEARCH_FROM && (
          <div className="relative px-1 pb-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-[60%] text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Search environments"
              aria-label="Search environments"
              data-testid="env-search"
              className="h-7 w-full rounded-md border border-border bg-background pl-7 pr-2 text-xs outline-none focus:border-ring"
            />
          </div>
        )}
        {shown.map((e) => {
          const unusable = !!e.state && e.state !== 'ready'
          return (
            <DropdownMenuItem key={e.id} data-testid={`env-item-${e.id}`} disabled={unusable} onSelect={() => pick(e)}>
              {unusable ? <TriangleAlert className="text-destructive" /> : <Layers className="text-muted-foreground" />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5"><span className="truncate text-sm">{e.name}</span><TypeBadge type={e.type} locked={e.locked} /></div>
                {unusable
                  ? <div className="text-[11px] text-destructive">{e.state === 'failed' ? 'Not available (see Admin console)' : e.state === 'creating' ? 'Being created' : 'Being deleted'}</div>
                  : e.description ? <div className="truncate text-[11px] text-muted-foreground">{e.description}</div>
                  : e.builtIn ? <div className="text-[11px] text-muted-foreground">Built-in environment of this install</div> : null}
              </div>
              {e.id === currentId && <Check className="text-primary" />}
            </DropdownMenuItem>
          )
        })}
        {shown.length === 0 && <div className="px-2 py-3 text-xs text-muted-foreground">No environment matches "{q}".</div>}
        {!server && <div className="px-2 pb-1 pt-1.5 text-[11px] leading-snug text-muted-foreground">Demo mode has one environment. Run the local server to create Sandbox and Developer environments.</div>}
        {caps.isAdmin && server && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => go({ page: 'admin', id: 'environments' })} data-testid="env-manage"><Settings2 /> Manage environments</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
