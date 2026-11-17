import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { ArrowDownToLine, ArrowUpToLine, ChevronRight, Copy, Database, Layers, Pencil, Plus, Search, Trash2, Variable } from 'lucide-react'
import type { ControlNode, FxRecord, FxValue } from '@/contracts'
import { controls } from '@/controls'
import { useStore } from '@/runtime/store'
import { useUi, type Pane } from '@/runtime/ui'
import { summarize } from '@/runtime/util'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { clientToFrame, containerAt, containerOrigin, snapGrid } from './geo'

const RAIL: Array<{ pane: Pane; label: string; icon: typeof Layers }> = [
  { pane: 'tree', label: 'Tree view', icon: Layers },
  { pane: 'insert', label: 'Insert', icon: Plus },
  { pane: 'data', label: 'Data', icon: Database },
  { pane: 'vars', label: 'Variables', icon: Variable },
]

export function LeftRail() {
  const pane = useUi((s) => s.pane)
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
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ tree */

function TreePane() {
  const app = useStore((s) => s.app)
  const selection = useStore((s) => s.selection)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; node: ControlNode } | null>(null)

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
      { label: 'Bring to front', icon: <ArrowUpToLine />, onSelect: () => st.reorder(n.id, 'front') },
      { label: 'Send to back', icon: <ArrowDownToLine />, onSelect: () => st.reorder(n.id, 'back') },
      { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => st.remove([n.id]) },
    ]
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
    return (
      <div key={n.id}>
        <div
          data-testid={`tree-node-${n.name}`}
          onClick={(e) => {
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
            'group flex h-7 cursor-default items-center gap-1 rounded-md pr-2 text-xs',
            sel ? 'bg-primary/10 text-primary' : 'text-foreground/85 hover:bg-accent',
          )}
          style={{ paddingLeft: 4 + depth * 14 }}
        >
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
          <Icon className={cn('size-3.5 shrink-0', sel ? 'text-primary' : 'text-muted-foreground')} />
          {editing === n.id ? (
            <RenameInput node={n} onDone={() => setEditing(null)} />
          ) : (
            <span className={cn('truncate', n.type === 'Screen' && 'font-semibold')}>{n.name}</span>
          )}
        </div>
        {open && n.children.map((c) => row(c, depth + 1))}
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-1.5">{app.screens.map((s) => row(s, 0))}</div>
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
  const list = controls.list().filter((c) => c.label.toLowerCase().includes(q.toLowerCase()) || c.type.toLowerCase().includes(q.toLowerCase()))
  const cats = ['Layout', 'Display', 'Input', 'Data'] as const
  return (
    <div className="flex h-full flex-col">
      <div className="relative p-2">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search controls" className="h-8 pl-7 text-xs" data-testid="insert-search" />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 px-2 pb-3">
          {cats.map((cat) => {
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
        </div>
      </ScrollArea>
      <div className="border-t border-border px-3 py-2 text-[11px] leading-snug text-muted-foreground">Click to insert, or drag onto the canvas.</div>
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

/* ------------------------------------------------------------------ data + variables */

const cell = (v: FxValue | undefined) => (v === null || v === undefined ? '' : typeof v === 'object' && !(v instanceof Date) ? summarize(v, 40) : v instanceof Date ? v.toLocaleString() : String(v))

function DataPane() {
  const collections = useStore((s) => s.runtime.collections)
  const names = Object.keys(collections)
  const [active, setActive] = useState<string | null>(null)
  const cur = active && collections[active] ? active : (names[0] ?? null)
  const rows: FxRecord[] = cur ? collections[cur].slice(0, 20) : []
  const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r)))).filter((k) => !k.startsWith('__'))
  return (
    <div className="flex h-full flex-col">
      <div className="space-y-1 border-b border-border p-2">
        {names.length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">No collections yet. Use Collect or ClearCollect.</p>}
        {names.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setActive(n)}
            className={cn('flex h-7 w-full items-center justify-between rounded-md px-2 text-xs', n === cur ? 'bg-primary/10 text-primary' : 'hover:bg-accent')}
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
          <div className="overflow-x-auto p-2">
            <table className="w-full border-collapse text-[11px]">
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
                {rows.map((r, i) => (
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
            {collections[cur].length > 20 && <p className="px-1 pt-2 text-[11px] text-muted-foreground">Showing 20 of {collections[cur].length} rows</p>}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}

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
  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-2">
        <VarGroup title="Global variables" data={vars} />
        <VarGroup title="Context variables" data={context} />
        <p className="px-1 text-[11px] leading-snug text-muted-foreground">Created with Set() and UpdateContext() while the app runs in Preview.</p>
      </div>
    </ScrollArea>
  )
}

