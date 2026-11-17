import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import {
  ArrowDownToLine, ArrowUpToLine, Bug, ChevronRight, Clock, Copy, Database, Eye, EyeOff, Layers, Lock, Pencil, Plus, Search, Table2, Trash2, Unlock, Variable, X,
} from 'lucide-react'
import type { ControlNode, FxRecord, FxValue } from '@/contracts'
import { controls } from '@/controls'
import { go } from '@/router'
import { usePlatform } from '@/platform'
import { evaluatorOf, recentControls, useStore } from '@/runtime/store'
import { useUi, type Pane } from '@/runtime/ui'
import { isContainerType, isOverlayType } from '@/runtime/evaluator'
import { summarize, findParent } from '@/runtime/util'
import { tableRows } from '@/runtime/data'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { clientToFrame, containerAt, containerOrigin, snapGrid } from './geo'
import { CATEGORIES } from './categories'

const RAIL: Array<{ pane: Pane; label: string; icon: typeof Layers }> = [
  { pane: 'tree', label: 'Tree view', icon: Layers },
  { pane: 'insert', label: 'Insert', icon: Plus },
  { pane: 'data', label: 'Data', icon: Database },
  { pane: 'vars', label: 'Variables', icon: Variable },
  { pane: 'debug', label: 'Debug console', icon: Bug },
]

export function LeftRail() {
  const pane = useUi((s) => s.pane)
  const errors = useStore((s) => s.debugLog.filter((l) => l.kind === 'error').length)
  return (
    <div className="flex shrink-0">
      <nav className="flex w-11 flex-col items-center gap-1 border-r border-border bg-card py-2">
        {RAIL.map(({ pane: p, label, icon: Icon }) => (
          <button
            key={p}
            type="button"
            title={label}
            data-testid={`rail-${p}`}
            onClick={() => useUi.getState().setPane(pane === p ? null : p)}
            className={cn(
              'relative grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
              pane === p && 'bg-accent text-primary',
            )}
          >
            {pane === p && <span className="absolute -left-[5px] top-1.5 h-5 w-[3px] rounded-r bg-primary" />}
            <Icon className="size-[18px]" />
            {p === 'debug' && errors > 0 && <span className="absolute right-0.5 top-0.5 size-2 rounded-full bg-destructive" />}
          </button>
        ))}
      </nav>
      {pane && (
        <div className="flex w-[264px] flex-col border-r border-border bg-card" data-testid={`pane-${pane}`}>
          <div className="flex h-9 shrink-0 items-center border-b border-border px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {RAIL.find((r) => r.pane === pane)?.label}
          </div>
          <div className="min-h-0 flex-1">
            {pane === 'tree' && <TreePane />}
            {pane === 'insert' && <InsertPane />}
            {pane === 'data' && <DataPane />}
            {pane === 'vars' && <VarsPane />}
            {pane === 'debug' && <DebugPane />}
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ tree */

type DropWhere = 'before' | 'after' | 'inside'

function TreePane() {
  const app = useStore((s) => s.app)
  const selection = useStore((s) => s.selection)
  const locked = useUi((s) => s.locked)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; node: ControlNode } | null>(null)
  const [drop, setDrop] = useState<{ id: string; where: DropWhere } | null>(null)
  const drag = useRef<{ id: string; x: number; y: number; active: boolean; pointerId: number } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)

  const toggle = (id: string) =>
    setCollapsed((c) => {
      const n = new Set(c)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const items = (n: ControlNode): MenuItem[] => {
    const st = useStore.getState()
    if (n.type === 'Screen')
      return [
        { label: 'Rename', icon: <Pencil />, onSelect: () => setEditing(n.id) },
        { label: 'Delete', icon: <Trash2 />, danger: true, disabled: app.screens.length < 2, onSelect: () => st.deleteScreen(n.id) },
      ]
    return [
      { label: 'Rename', icon: <Pencil />, onSelect: () => setEditing(n.id) },
      { label: 'Duplicate', icon: <Copy />, onSelect: () => st.duplicate([n.id]) },
      { label: 'Copy', icon: <Copy />, onSelect: () => st.copy([n.id]) },
      { label: locked.includes(n.id) ? 'Unlock' : 'Lock', icon: locked.includes(n.id) ? <Unlock /> : <Lock />, onSelect: () => useUi.getState().toggleLock(n.id) },
      { label: 'Bring to front', icon: <ArrowUpToLine />, onSelect: () => st.reorder(n.id, 'front') },
      { label: 'Send to back', icon: <ArrowDownToLine />, onSelect: () => st.reorder(n.id, 'back') },
      { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => st.remove([n.id]) },
    ]
  }

  const dropAt = (cx: number, cy: number): { id: string; where: DropWhere } | null => {
    const el = document.elementFromPoint(cx, cy)?.closest<HTMLElement>('[data-tree-id]')
    if (!el) return null
    const id = el.getAttribute('data-tree-id')!
    const d = drag.current
    if (!d || id === d.id) return null
    const st = useStore.getState()
    const ev = evaluatorOf(st)
    const target = ev.byId.get(id)?.node
    const dragged = ev.byId.get(d.id)?.node
    if (!target || !dragged) return null
    if (dragged.children.length && (function inside(n: ControlNode): boolean {
      return n.children.some((c) => c.id === id || inside(c))
    })(dragged))
      return null
    const r = el.getBoundingClientRect()
    const f = (cy - r.top) / r.height
    const container = isContainerType(target.type)
    if (target.type === 'Screen') return { id, where: 'inside' }
    if (container && f > 0.25 && f < 0.75) return { id, where: 'inside' }
    return { id, where: f < 0.5 ? 'before' : 'after' }
  }

  const finishDrop = (d: { id: string; where: DropWhere }) => {
    const st = useStore.getState()
    const dragged = drag.current?.id
    if (!dragged) return
    if (d.where === 'inside') {
      const target = evaluatorOf(st).byId.get(d.id)?.node
      if (target) st.moveNode(dragged, d.id, target.children.length)
      return
    }
    const parent = findParent(st.app, d.id)
    if (!parent) return
    const i = parent.children.findIndex((c) => c.id === d.id)
    st.moveNode(dragged, parent.id, d.where === 'before' ? i : i + 1)
  }

  const row = (n: ControlNode, depth: number) => {
    let Icon
    try {
      Icon = controls.get(n.type).icon
    } catch {
      return null
    }
    const sel = selection.includes(n.id)
    const open = !collapsed.has(n.id)
    const hidden = /^=\s*false\s*$/i.test(n.props.Visible ?? '')
    const isLocked = locked.includes(n.id)
    const overlay = isOverlayType(n.type)
    const dropHere = drop?.id === n.id ? drop.where : null
    return (
      <div key={n.id}>
        <div
          data-testid={`tree-node-${n.name}`}
          data-tree-id={n.id}
          onPointerDown={(e) => {
            if (e.button !== 0 || n.type === 'Screen' || (e.target as HTMLElement).closest('button,input')) return
            drag.current = { id: n.id, x: e.clientX, y: e.clientY, active: false, pointerId: e.pointerId }
          }}
          onPointerMove={(e) => {
            const d = drag.current
            if (!d) return
            if (!d.active) {
              if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return
              d.active = true
              setDragId(d.id)
              ;(e.currentTarget as HTMLElement).setPointerCapture(d.pointerId)
            }
            setDrop(dropAt(e.clientX, e.clientY))
          }}
          onPointerUp={(e) => {
            const d = drag.current
            drag.current = null
            setDragId(null)
            if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
            if (d?.active) {
              drag.current = d
              const target = dropAt(e.clientX, e.clientY)
              if (target) finishDrop(target)
              drag.current = null
              setDrop(null)
            }
          }}
          onClick={(e) => {
            if (dragId) return
            const st = useStore.getState()
            if (e.shiftKey && n.type !== 'Screen') st.select(sel ? selection.filter((i) => i !== n.id) : [...selection, n.id])
            else st.select([n.id])
          }}
          onDoubleClick={() => setEditing(n.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            useStore.getState().select([n.id])
            setMenu({ x: e.clientX, y: e.clientY, node: n })
          }}
          className={cn(
            'group relative flex h-7 cursor-default touch-none select-none items-center gap-1 rounded-md pr-1 text-xs',
            sel ? 'bg-primary/10 text-primary' : 'text-foreground/85 hover:bg-accent',
            dropHere === 'inside' && 'ring-2 ring-inset ring-primary',
            dragId === n.id && 'opacity-50',
          )}
          style={{ paddingLeft: 4 + depth * 14 }}
        >
          {dropHere === 'before' && <span className="pointer-events-none absolute inset-x-1 -top-px h-0.5 rounded bg-primary" />}
          {dropHere === 'after' && <span className="pointer-events-none absolute inset-x-1 -bottom-px h-0.5 rounded bg-primary" />}
          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation()
              toggle(n.id)
            }}
            className={cn('grid size-4 shrink-0 place-items-center rounded text-muted-foreground hover:bg-black/5', !n.children.length && 'invisible')}
          >
            <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
          </button>
          <Icon className={cn('size-3.5 shrink-0', sel ? 'text-primary' : 'text-muted-foreground', hidden && 'opacity-40')} />
          {editing === n.id ? (
            <RenameInput node={n} onDone={() => setEditing(null)} />
          ) : (
            <span className={cn('min-w-0 flex-1 truncate', n.type === 'Screen' && 'font-semibold', hidden && 'text-muted-foreground line-through decoration-muted-foreground/40')}>{n.name}</span>
          )}
          {overlay && <span className="shrink-0 rounded bg-muted px-1 text-[9.5px] font-medium uppercase text-muted-foreground">overlay</span>}
          {n.type !== 'Screen' && (
            <span className={cn('flex shrink-0 items-center', !(hidden || isLocked) && 'opacity-0 group-hover:opacity-100')}>
              <button
                type="button"
                title={isLocked ? 'Unlock' : 'Lock position and size'}
                data-testid={`tree-lock-${n.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  useUi.getState().toggleLock(n.id)
                }}
                className={cn('grid size-5 place-items-center rounded hover:bg-black/5', isLocked ? 'text-foreground' : 'text-muted-foreground')}
              >
                {isLocked ? <Lock className="size-3" /> : <Unlock className="size-3" />}
              </button>
              <button
                type="button"
                title={hidden ? 'Show (Visible = true)' : 'Hide (Visible = false)'}
                data-testid={`tree-visible-${n.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  useStore.getState().toggleVisible(n.id)
                }}
                className={cn('grid size-5 place-items-center rounded text-muted-foreground hover:bg-black/5')}
              >
                {hidden ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
              </button>
            </span>
          )}
        </div>
        {open && n.children.map((c) => row(c, depth + 1))}
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-1.5">{app.screens.map((s) => row(s, 0))}</div>
      <p className="px-3 pb-3 text-[11px] leading-snug text-muted-foreground">Drag rows to reorder or move into containers.</p>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items(menu.node)} onClose={() => setMenu(null)} />}
    </ScrollArea>
  )
}

function RenameInput({ node, onDone }: { node: ControlNode; onDone: () => void }) {
  const [v, setV] = useState(node.name)
  const [err, setErr] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const commit = () => {
    const e = v.trim() === node.name ? null : useStore.getState().rename(node.id, v)
    if (e) {
      setErr(e)
      useStore.getState().notify(e, 'error')
    }
    onDone()
  }
  return (
    <input
      ref={ref}
      value={v}
      title={err ?? undefined}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') onDone()
        e.stopPropagation()
      }}
      className="min-w-0 flex-1 rounded border border-primary bg-background px-1 py-0 text-xs text-foreground outline-none"
    />
  )
}

/* ------------------------------------------------------------------ insert */

function InsertPane() {
  const [q, setQ] = useState('')
  const [recent, setRecent] = useState<string[]>(() => recentControls())
  useEffect(() => useStore.subscribe((s, p) => s.app !== p.app && setRecent(recentControls())), [])
  const all = controls.list()
  const list = all.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()) || c.type.toLowerCase().includes(q.toLowerCase()))
  const recentDefs = q ? [] : recent.map((t) => all.find((c) => c.type === t)).filter((c): c is (typeof all)[number] => !!c)
  return (
    <div className="flex h-full flex-col">
      <div className="relative p-2">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search controls" className="h-8 pl-7 text-xs" data-testid="insert-search" />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 px-2 pb-3">
          {recentDefs.length > 0 && (
            <section>
              <h4 className="mb-1 flex items-center gap-1 px-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                <Clock className="size-3" /> Recent
              </h4>
              <div className="grid grid-cols-2 gap-1.5">
                {recentDefs.map((c) => (
                  <InsertItem key={'r' + c.type} type={c.type} label={c.label} Icon={c.icon} />
                ))}
              </div>
            </section>
          )}
          {CATEGORIES.map((cat) => {
            const items = list.filter((c) => c.category === cat)
            if (!items.length) return null
            return (
              <section key={cat}>
                <h4 className="mb-1 px-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{cat}</h4>
                <div className="grid grid-cols-2 gap-1.5">
                  {items.map((c) => (
                    <InsertItem key={c.type} type={c.type} label={c.label} Icon={c.icon} />
                  ))}
                </div>
              </section>
            )
          })}
          {list.length === 0 && <p className="px-1 text-xs text-muted-foreground">No control matches "{q}".</p>}
        </div>
      </ScrollArea>
      <div className="border-t border-border px-3 py-2 text-[11px] leading-snug text-muted-foreground">Click to insert, or drag onto the canvas. Dialogs and sheets go to the screen root.</div>
    </div>
  )
}

function InsertItem({ type, label, Icon }: { type: string; label: string; Icon: React.ComponentType<{ className?: string }> }) {
  const drag = useRef<{ x: number; y: number; active: boolean } | null>(null)
  const justDragged = useRef(false)

  const targetAt = (cx: number, cy: number): { id: string | null; overCanvas: boolean } => {
    const over = document.elementFromPoint(cx, cy)
    const overCanvas = !!over?.closest('[data-canvas-viewport]') && !over?.closest('[data-chrome]')
    if (!overCanvas) return { id: null, overCanvas }
    return { id: containerAt(cx, cy, () => false), overCanvas }
  }

  const onDown = (e: RPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    drag.current = { x: e.clientX, y: e.clientY, active: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onMove = (e: RPointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    if (!d) return
    if (!d.active && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.active = true
    if (!d.active) return
    const st = useStore.getState()
    const { id } = targetAt(e.clientX, e.clientY)
    const isScreen = id ? st.app.screens.some((s) => s.id === id) : true
    useUi.setState({ insertGhost: { type, x: e.clientX, y: e.clientY }, dropTargetId: id && !isScreen ? id : null })
  }
  const onUp = (e: RPointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (!d?.active) return
    justDragged.current = true
    setTimeout(() => (justDragged.current = false), 50)
    useUi.setState({ insertGhost: null, dropTargetId: null })
    const { id, overCanvas } = targetAt(e.clientX, e.clientY)
    if (!overCanvas) return
    const st = useStore.getState()
    const ui = useUi.getState()
    const parentId = id ?? st.currentScreenId
    const pt = clientToFrame(e.clientX, e.clientY, ui.zoom)
    if (!pt) return
    const origin = containerOrigin(parentId, ui.zoom)
    let size = { width: 120, height: 40 }
    try {
      size = controls.get(type).defaultSize
    } catch {
      /* ignore */
    }
    const x = Math.max(0, snapGrid(pt.x - origin.x - size.width / 2))
    const y = Math.max(0, snapGrid(pt.y - origin.y - size.height / 2))
    st.insert(type, { parentId, x, y })
  }

  return (
    <button
      type="button"
      data-testid={`insert-item-${type}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => {
        drag.current = null
        useUi.setState({ insertGhost: null, dropTargetId: null })
      }}
      onClick={() => {
        if (justDragged.current) return
        useStore.getState().insert(type)
      }}
      className="flex h-9 touch-none select-none items-center gap-2 rounded-md border border-border bg-background px-2 text-left text-xs font-medium transition-colors hover:border-primary/50 hover:bg-accent active:bg-accent"
    >
      <Icon className="size-4 shrink-0 text-primary" />
      <span className="truncate">{label}</span>
    </button>
  )
}

/* ------------------------------------------------------------------ data */

const NO_SOURCES: string[] = []
const cell = (v: FxValue | undefined) => (v === null || v === undefined ? '' : typeof v === 'object' && !(v instanceof Date) ? summarize(v, 40) : v instanceof Date ? v.toLocaleString() : String(v))

function RowsPreview({ rows }: { rows: FxRecord[] }) {
  const shown = rows.slice(0, 20)
  const cols = Array.from(new Set(shown.flatMap((r) => Object.keys(r)))).filter((k) => !k.startsWith('__'))
  return (
    <div className="overflow-x-auto p-2">
      <table className="w-full border-collapse text-[11px]" data-testid="data-preview">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} className="sticky top-0 whitespace-nowrap border-b border-border bg-card px-1.5 py-1 text-left font-semibold text-muted-foreground">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i} className="odd:bg-muted/40">
              {cols.map((c) => (
                <td key={c} className="max-w-[120px] truncate whitespace-nowrap px-1.5 py-1">
                  {cell(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 20 && <p className="px-1 pt-2 text-[11px] text-muted-foreground">Showing 20 of {rows.length} rows</p>}
      {rows.length === 0 && <p className="px-1 py-2 text-[11px] text-muted-foreground">No rows</p>}
    </div>
  )
}

function DataPane() {
  const sources = useStore((s) => s.app.dataSources) ?? NO_SOURCES
  const collections = useStore((s) => s.runtime.collections)
  const tables = usePlatform((s) => s.tables)
  usePlatform((s) => s.dataVersion)
  const [active, setActive] = useState<{ kind: 'table' | 'collection'; name: string } | null>(null)
  const [pick, setPick] = useState(false)
  const collNames = Object.keys(collections)
  const cur = active ?? (sources[0] ? { kind: 'table' as const, name: sources[0] } : collNames[0] ? { kind: 'collection' as const, name: collNames[0] } : null)
  const rows: FxRecord[] = !cur ? [] : cur.kind === 'table' ? tableRows(cur.name) : (collections[cur.name] ?? [])
  const available = tables.filter((t) => !sources.includes(t.name))
  return (
    <div className="flex h-full flex-col">
      <div className="space-y-1 border-b border-border p-2">
        <div className="flex items-center justify-between px-1">
          <h4 className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Tables</h4>
          <Popover open={pick} onOpenChange={setPick}>
            <PopoverTrigger asChild>
              <Button size="xs" variant="ghost" className="h-6 px-1.5" data-testid="add-data">
                <Plus /> Add data
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-1">
              {available.length === 0 && <p className="p-2 text-xs text-muted-foreground">Every table is already added.</p>}
              {available.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  data-testid={`add-data-${t.name}`}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                  onClick={() => {
                    useStore.getState().addDataSource(t.name)
                    setActive({ kind: 'table', name: t.name })
                    setPick(false)
                  }}
                >
                  <Table2 className="size-3.5 text-primary" />
                  <span className="font-medium">{t.displayName}</span>
                  <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">{t.name}</span>
                </button>
              ))}
              <div className="mt-1 border-t border-border pt-1">
                <button type="button" className="w-full rounded px-2 py-1.5 text-left text-xs text-primary hover:bg-accent" onClick={() => go({ page: 'tables' })}>
                  Create a table…
                </button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
        {sources.length === 0 && <p className="px-1 py-1 text-xs text-muted-foreground">No tables yet. Add one, or just use a table name in a formula.</p>}
        {sources.map((n) => {
          const exists = tables.some((t) => t.name === n)
          return (
            <div key={n} className={cn('group flex h-7 items-center rounded-md px-2 text-xs', cur?.kind === 'table' && cur.name === n ? 'bg-primary/10 text-primary' : 'hover:bg-accent')}>
              <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 font-medium" onClick={() => setActive({ kind: 'table', name: n })} data-testid={`data-source-${n}`}>
                <Table2 className="size-3.5" />
                <span className={cn('truncate', !exists && 'text-destructive line-through')}>{n}</span>
              </button>
              <span className="rounded bg-muted px-1.5 text-[10.5px] text-muted-foreground">{exists ? tableRows(n).length : 'missing'}</span>
              <button type="button" title="Remove from app" className="ml-1 hidden size-5 place-items-center rounded text-muted-foreground hover:bg-black/5 group-hover:grid" onClick={() => useStore.getState().removeDataSource(n)}>
                <X className="size-3" />
              </button>
            </div>
          )
        })}
        <h4 className="px-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Collections</h4>
        {collNames.length === 0 && <p className="px-1 py-1 text-xs text-muted-foreground">None. Use Collect or ClearCollect.</p>}
        {collNames.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setActive({ kind: 'collection', name: n })}
            className={cn('flex h-7 w-full items-center justify-between rounded-md px-2 text-xs', cur?.kind === 'collection' && cur.name === n ? 'bg-primary/10 text-primary' : 'hover:bg-accent')}
          >
            <span className="flex items-center gap-1.5 font-medium">
              <Database className="size-3.5" />
              {n}
            </span>
            <span className="rounded bg-muted px-1.5 text-[10.5px] text-muted-foreground">{collections[n].length}</span>
          </button>
        ))}
      </div>
      {cur && (
        <ScrollArea className="min-h-0 flex-1">
          <RowsPreview rows={rows} />
        </ScrollArea>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ variables + debug */

function VarGroup({ title, data }: { title: string; data: Record<string, FxValue> }) {
  return (
    <section>
      <h4 className="mb-1 px-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h4>
      {Object.keys(data).length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">None</p>
      ) : (
        Object.entries(data).map(([k, v]) => (
          <div key={k} className="rounded-md px-1.5 py-1 hover:bg-accent/60">
            <div className="font-mono text-xs font-medium">{k}</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">{summarize(v, 100)}</div>
          </div>
        ))
      )}
    </section>
  )
}

function VarsPane() {
  const vars = useStore((s) => s.runtime.vars)
  const context = useStore((s) => s.runtime.context)
  const screens = useStore((s) => s.app.screens)
  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-2">
        <VarGroup title="Global variables" data={vars} />
        {screens.map((s) => (
          <VarGroup key={s.id} title={`Context · ${s.name}`} data={context[s.id] ?? {}} />
        ))}
        <p className="px-1 text-[11px] leading-snug text-muted-foreground">Set() creates global variables; UpdateContext() creates variables for the current screen.</p>
      </div>
    </ScrollArea>
  )
}

function DebugPane() {
  const log = useStore((s) => s.debugLog)
  return (
    <div className="flex h-full flex-col" data-testid="debug-console">
      <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
        <span className="text-[11px] text-muted-foreground">Trace() output and runtime errors from Preview and the run window</span>
        <Button size="xs" variant="ghost" className="h-6 px-1.5" onClick={() => useStore.getState().clearLog()}>
          Clear
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-0.5 p-1.5 font-mono text-[11px]">
          {log.length === 0 && <p className="p-1 font-sans text-xs text-muted-foreground">Nothing logged yet.</p>}
          {log
            .slice()
            .reverse()
            .map((l) => (
              <div key={l.id} data-testid="debug-entry" className={cn('rounded px-1.5 py-1 hover:bg-accent/60', l.kind === 'error' && 'text-destructive')}>
                <span className="text-muted-foreground">{new Date(l.at).toLocaleTimeString()} </span>
                {l.message}
                {l.data && <div className="truncate text-muted-foreground">{l.data}</div>}
              </div>
            ))}
        </div>
      </ScrollArea>
    </div>
  )
}
