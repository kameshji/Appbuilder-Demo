/**
 * The step picker: searchable, grouped (Control, Data, Approvals, Notifications, Connectors, Advanced), recently used
 * first, plain-language descriptions. Connectors list the connections the maker may use with their actions: picking one
 * attaches the connection to the flow (a connection reference) and adds the action step. Connections the maker may not
 * use are shown with the reason.
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, Lock, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { usePlatform } from '@/platform'
import { GROUPS, KINDS, kindInfo, noteRecent, recentKinds, type PickerGroup } from './palette'
import { useDesignerData } from './context'
import { useDesigner } from './store'
import { addStep } from './actions'
import { toIdentifier, type Slot } from './model'

const ACTION_KINDS = new Set(['http', 'email'])

/** a free connection reference name for a connection (the connection's name as an identifier) */
export function refFor(connections: Record<string, string>, connectionId: string, name: string): string {
  const existing = Object.entries(connections).find(([, id]) => id === connectionId)
  if (existing) return existing[0]
  const base = toIdentifier(name).toLowerCase().slice(0, 40) || 'conn'
  if (!connections[base]) return base
  for (let i = 2; ; i++) if (!connections[`${base}${i}`]) return `${base}${i}`
}

export function StepPicker({ open, slot, index, onClose }: { open: boolean; slot: Slot | null; index: number; onClose(): void }) {
  const data = useDesignerData()
  const allConns = usePlatform((s) => s.connections)
  const [q, setQ] = useState('')
  const [group, setGroup] = useState<PickerGroup | 'Recent' | 'All'>('All')
  const [openConn, setOpenConn] = useState<string | null>(null)
  useEffect(() => { if (open) { setQ(''); setGroup('All'); setOpenConn(null) } }, [open])
  const approvalsOff = data.catalog && data.catalog.approvals === false
  const kinds = useMemo(() => {
    const known = new Set((data.catalog?.steps ?? []).map((k) => k.kind as string))
    const list = Object.entries(KINDS).filter(([k]) => !data.catalog || known.has(k))
    const s = q.trim().toLowerCase()
    return list.filter(([k, v]) => !s || `${v.title} ${v.blurb} ${k} ${v.group}`.toLowerCase().includes(s))
  }, [q, data.catalog])
  const recent = recentKinds()
  const actionConns = useMemo(() => allConns.filter((c) => ACTION_KINDS.has(c.connector)), [allConns])
  const usable = new Map((data.usable ?? []).map((c) => [c.id, c]))
  useEffect(() => { if (openConn) data.loadActions(openConn) }, [openConn, data])

  const pick = (kind: string, title: string, extra: Record<string, unknown> = {}) => {
    if (!slot) return
    noteRecent(kind)
    addStep(slot, index, kind, title, extra)
    onClose()
  }
  const pickAction = (connId: string, connName: string, actionId: string, title: string, kind: string) => {
    if (!slot) return
    const st = useDesigner.getState()
    const ref = refFor(st.connections, connId, connName)
    st.edit((x) => (x.connections[ref] === connId ? x : { ...x, connections: { ...x.connections, [ref]: connId } }))
    noteRecent(`action:${connId}:${actionId}`)
    if (kind === 'http' && actionId === 'request') addStep(slot, index, 'http', 'CallApi', { auth: ref })
    else if (kind === 'email' && actionId === 'send') addStep(slot, index, 'email', 'SendEmail', { connection: ref })
    else addStep(slot, index, 'action', title, { connection: ref, action: actionId, inputs: {} })
    onClose()
  }

  const showGroups: (PickerGroup | 'Recent')[] = group === 'All' ? ['Recent', ...GROUPS] : [group]
  const s = q.trim().toLowerCase()
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="p-0 sm:max-w-3xl" data-testid="step-picker">
        <DialogHeader className="border-b border-border p-4 pb-3">
          <DialogTitle>Add a step</DialogTitle>
          <DialogDescription>Pick what the flow does next. Search, or browse by group.</DialogDescription>
          <div className="relative mt-2">
            <Search className="absolute left-2 top-2 size-4 text-muted-foreground" />
            <input autoFocus className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-2 text-sm" placeholder="Search steps and connector actions" value={q} onChange={(e) => setQ(e.target.value)} data-testid="picker-search" aria-label="Search steps" />
          </div>
        </DialogHeader>
        <div className="flex max-h-[60vh] min-h-[320px]">
          <nav className="w-40 shrink-0 border-r border-border p-2 text-sm" aria-label="Step groups">
            {(['All', 'Recent', ...GROUPS] as const).map((g) => (
              <button key={g} type="button" className={cn('block w-full rounded px-2 py-1 text-left', group === g ? 'bg-accent font-medium' : 'hover:bg-accent/50')} onClick={() => setGroup(g)} data-testid={`picker-group-${g}`}>{g}</button>
            ))}
          </nav>
          <div className="min-w-0 flex-1 overflow-auto p-3" data-no-canvas-wheel>
            {showGroups.map((g) => {
              if (g === 'Recent') {
                const items = recent.filter((k) => !k.startsWith('action:') && KINDS[k] && (!s || `${KINDS[k].title} ${KINDS[k].blurb}`.toLowerCase().includes(s)))
                if (!items.length) return null
                return (
                  <section key={g} className="mb-3">
                    <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Recently used</h3>
                    <div className="grid grid-cols-2 gap-1.5">{items.map((k) => <KindButton key={k} kind={k} onPick={() => pick(k, KINDS[k].short)} off={k === 'approval' && !!approvalsOff} />)}</div>
                  </section>
                )
              }
              const items = kinds.filter(([, v]) => v.group === g)
              const conns = g === 'Connectors' ? actionConns.filter((c) => !s || c.name.toLowerCase().includes(s) || (data.actions[c.id] ?? []).some((a) => a.title.toLowerCase().includes(s))) : []
              if (!items.length && !conns.length) return null
              return (
                <section key={g} className="mb-3" data-testid={`picker-section-${g}`}>
                  <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{g}</h3>
                  <div className="grid grid-cols-2 gap-1.5">
                    {items.map(([k, v]) => <KindButton key={k} kind={k} onPick={() => pick(k, v.short)} off={k === 'approval' && !!approvalsOff} />)}
                  </div>
                  {g === 'Connectors' && conns.length > 0 && (
                    <div className="mt-2 grid gap-1">
                      <div className="text-[11px] text-muted-foreground">Connections</div>
                      {conns.map((c) => {
                        const u = usable.get(c.id)
                        const acts = data.actions[c.id]
                        return (
                          <div key={c.id} className="rounded-md border border-border" data-testid={`picker-conn-${c.name}`}>
                            <button type="button" disabled={!u} className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm disabled:opacity-60" onClick={() => setOpenConn(openConn === c.id ? null : c.id)} title={u ? undefined : `You need "use" access to ${c.name} to attach it to a flow; ask an administrator.`}>
                              {u ? <ChevronRight className={cn('size-4 transition-transform', openConn === c.id && 'rotate-90')} /> : <Lock className="size-4" />}
                              <span className="font-medium">{c.name}</span><span className="text-xs text-muted-foreground">{c.connector}</span>
                              {!u && <span className="ml-auto text-[11px] text-muted-foreground">needs "use" access: ask an administrator</span>}
                            </button>
                            {openConn === c.id && u && (
                              <div className="grid gap-0.5 border-t border-border p-1">
                                {acts === undefined || (acts.length === 0 && data.actions[c.id] === undefined) ? <span className="p-1 text-xs text-muted-foreground">Loading actions...</span> : !acts.length ? <span className="p-1 text-xs text-muted-foreground">No actions.</span> : acts.filter((a) => !s || `${a.title} ${a.description}`.toLowerCase().includes(s)).map((a) => (
                                  <button key={a.id} type="button" className="rounded px-2 py-1 text-left hover:bg-accent" data-testid={`picker-action-${a.id}`} onClick={() => pickAction(c.id, c.name, a.id, a.title, c.connector)}>
                                    <div className="text-sm font-medium">{a.title}</div>
                                    <div className="line-clamp-2 text-[11px] text-muted-foreground">{a.description}</div>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </section>
              )
            })}
            {!kinds.length && <p className="p-4 text-sm text-muted-foreground">No step matches "{q}".</p>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function KindButton({ kind, onPick, off }: { kind: string; onPick(): void; off?: boolean }) {
  const v = kindInfo(kind)
  const Icon = v.icon
  return (
    <button type="button" className="flex items-start gap-2 rounded-md border border-border p-2 text-left hover:border-primary hover:bg-accent/40" onClick={onPick} data-testid={`pick-${kind}`}>
      <span className={cn('flex size-7 shrink-0 items-center justify-center rounded', v.tone)}><Icon className="size-4" /></span>
      <span className="min-w-0">
        <span className="flex items-center gap-1 text-sm font-medium">{v.title}{off && <span className="rounded bg-amber-500/15 px-1 text-[10px] font-medium text-amber-700 dark:text-amber-300" title="Approvals are not available on this server yet: runs fail at this step until they are.">needs approvals</span>}</span>
        <span className="line-clamp-2 text-[11px] text-muted-foreground">{v.blurb}</span>
      </span>
    </button>
  )
}
