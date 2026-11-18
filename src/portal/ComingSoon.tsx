import { ArrowLeft, CalendarClock, MessagesSquare, PackageOpen } from 'lucide-react'
import { go } from '@/router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { PHASES, moduleByKey, type ShellMode } from './modules'
import { useChatDock } from '@/chat/dock'
import { Empty } from './kit'

/** the small "Soon" badge of a planned module */
export function SoonBadge({ className }: { className?: string }) {
  return (
    <Badge variant="secondary" className={cn('h-4 rounded px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground', className)} data-testid="soon-badge">
      Soon
    </Badge>
  )
}

/** `#soon-<key>`: placeholder page of a planned module, driven by src/portal/modules.ts */
export function ComingSoon({ moduleKey, mode }: { moduleKey: string; mode: ShellMode }) {
  const m = moduleByKey(moduleKey)
  if (!m) {
    return (
      <Empty
        icon={PackageOpen}
        title="Unknown module"
        description={`There is no planned module called "${moduleKey}".`}
        action={<Button variant="outline" onClick={() => go(mode === 'user' ? { page: 'u' } : { page: 'home' })}><ArrowLeft /> Back</Button>}
      />
    )
  }
  const Icon = m.icon
  return (
    <div data-testid={`page-soon-${m.key}`} className="mx-auto max-w-2xl pt-10">
      <div className="rounded-2xl border border-border bg-card p-8 shadow-xs">
        <div className="flex items-start gap-4">
          <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary">
            <Icon className="size-7" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">{m.label}</h1>
              <SoonBadge />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{m.tagline}</p>
          </div>
        </div>
        <ul className="mt-6 space-y-2.5 text-sm leading-relaxed">
          {m.details.map((d) => (
            <li key={d} className="flex gap-2.5">
              <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />
              <span>{d}</span>
            </li>
          ))}
        </ul>
        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-5">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs font-medium" data-testid="soon-phase">
            <CalendarClock className="size-3.5 text-muted-foreground" /> Planned: {PHASES[m.phase]}
          </span>
          <span className="text-xs text-muted-foreground">This module is not built yet. The page is a placeholder so you can see where it will live.</span>
          {m.action === 'chat' && (
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => useChatDock.getState().show()}>
              <MessagesSquare /> Open the chat panel
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
