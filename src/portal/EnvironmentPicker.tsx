/**
 * Environment picker in the top bar (where Power Platform shows it): the current environment with its type, a list
 * to switch (with a search box when there are more than 6) and, for administrators, a link to manage them.
 * Driven by platform.environments; today the list holds the one built-in "Default" environment.
 */
import { useMemo, useState } from 'react'
import { Check, ChevronDown, Layers, Search, Settings2 } from 'lucide-react'
import { ENVIRONMENT_TYPE_LABEL, platform, usePlatform, type EnvironmentDef } from '@/platform'
import { go } from '@/router'
import { cn } from '@/lib/utils'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useToast } from './kit'
import { useCaps } from './security'

export const SEARCH_FROM = 7

export function TypeBadge({ type, className }: { type: EnvironmentDef['type']; className?: string }) {
  return (
    <span
      data-testid="env-type"
      className={cn(
        'inline-flex h-4 items-center rounded px-1 text-[10px] font-semibold uppercase tracking-wide',
        type === 'production' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : type === 'sandbox' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
        className,
      )}
    >
      {ENVIRONMENT_TYPE_LABEL[type]}
    </span>
  )
}

export function EnvironmentPicker() {
  const list = usePlatform((s) => s.environments)
  const currentId = usePlatform((s) => s.environmentId)
  const caps = useCaps()
  const { fail } = useToast()
  const [q, setQ] = useState('')
  const current = list.find((e) => e.id === currentId) ?? null
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase()
    return n ? list.filter((e) => e.name.toLowerCase().includes(n) || ENVIRONMENT_TYPE_LABEL[e.type].toLowerCase().includes(n)) : list
  }, [list, q])
  if (!current) return null

  return (
    <DropdownMenu onOpenChange={(o) => { if (!o) setQ('') }}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="env-picker"
          aria-label={`Environment: ${current.name} (${ENVIRONMENT_TYPE_LABEL[current.type]})`}
          title="Environment"
          className="flex h-7 max-w-[240px] shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <Layers className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium" data-testid="env-current">{current.name}</span>
          <span className="text-muted-foreground" aria-hidden>·</span>
          <TypeBadge type={current.type} />
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72" data-testid="env-menu">
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
        {shown.map((e) => (
          <DropdownMenuItem
            key={e.id}
            data-testid={`env-item-${e.id}`}
            onSelect={() => { platform.environments.select(e.id).catch(fail) }}
          >
            <Layers className="text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5"><span className="truncate text-sm">{e.name}</span><TypeBadge type={e.type} /></div>
              {e.builtIn && <div className="text-[11px] text-muted-foreground">Built-in environment of this install</div>}
            </div>
            {e.id === currentId && <Check className="text-primary" />}
          </DropdownMenuItem>
        ))}
        {shown.length === 0 && <div className="px-2 py-3 text-xs text-muted-foreground">No environment matches "{q}".</div>}
        <div className="px-2 pb-1 pt-1.5 text-[11px] leading-snug text-muted-foreground">Separate Dev, Test and Prod environments arrive with P0 Kernel.</div>
        {caps.isAdmin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => go({ page: 'admin', id: 'environments' })} data-testid="env-manage"><Settings2 /> Manage environments</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
