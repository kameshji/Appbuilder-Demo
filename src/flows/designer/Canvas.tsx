/**
 * The designer canvas (own HTML + SVG, no third-party canvas library; the pan/zoom/minimap ideas of the data model
 * designer): trigger card on top, step cards joined by lines, containers as regions with their lanes side by side
 * (collapsible), "+" insertion points between any two steps and inside containers, run-after connectors with their
 * statuses, drag to move steps (drop on an insertion point), multi-select (Ctrl/Shift+click), the run overlay
 * (status, duration, attempts; a pager per loop). Keyboard: arrows move the focus, Enter opens a step, Delete,
 * Ctrl+Z/Y, Ctrl+C/V/D, Ctrl+F searches, Escape clears the selection.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ChevronLeft, Maximize, Minus, MoreHorizontal, Plus, StickyNote, TriangleAlert, Flag, CornerDownRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { Step } from '@/platform/flows'
import { layoutFlow, CARD_W, type InsertNode } from './layout'
import { listsOf, order, findStep, type Slot } from './model'
import { selectedIds, useDesigner } from './store'
import { kindInfo, TRIGGER_ICON, FALLBACK_ICON } from './palette'
import { copySelected, deleteSelected, duplicateSelected, move, paste } from './actions'
import { fmtDuration, loopIterations, overlayOf, type StepOverlay } from './overlay'

interface View { tx: number; ty: number; k: number }

const STATUS_TONE: Record<string, string> = {
  succeeded: 'border-emerald-500 ring-emerald-500/30', failed: 'border-red-500 ring-red-500/30', timedOut: 'border-red-500 ring-red-500/30',
  running: 'border-sky-500 ring-sky-500/30', waiting: 'border-amber-500 ring-amber-500/30', skipped: 'border-dashed border-muted-foreground/50', cancelled: 'border-muted-foreground',
}
const STATUS_CHIP: Record<string, string> = {
  succeeded: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300', failed: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300', timedOut: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  running: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300', waiting: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300', skipped: 'bg-muted text-muted-foreground', cancelled: 'bg-muted text-muted-foreground',
}

/** a one-line summary under a step's title */
export function stepSummary(s: Step): string {
  const a = s as Step & Record<string, unknown>
  const clip = (x: unknown, n = 38) => { const t = String(x ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }
  switch (s.kind) {
    case 'data.get': case 'data.list': case 'data.create': case 'data.update': case 'data.delete': return a.table ? `${kindInfo(s.kind).title} · ${a.table}` : kindInfo(s.kind).title
    case 'condition': return a.if ? `If ${clip(a.if)}` : 'Condition'
    case 'switch': return a.on ? `Switch on ${clip(a.on)}` : 'Switch'
    case 'forEach': return a.items ? `For each ${a.as ?? 'item'} in ${clip(a.items, 26)}` : 'For each'
    case 'until': return a.condition ? `Until ${clip(a.condition)}` : 'Do until'
    case 'delay': return a.minutes !== undefined ? `Wait ${a.minutes} min` : a.until ? `Wait until ${clip(a.until, 28)}` : 'Delay'
    case 'approval': return a.approvers ? `Ask ${clip(a.approvers, 30)}` : a.policy ? `Policy ${clip(a.policy, 28)}` : 'Approval'
    case 'notify': return a.to ? `To ${clip(a.to, 34)}` : 'Notify'
    case 'email': return a.to ? `To ${clip(a.to, 34)}` : 'Send an email'
    case 'http': return `${a.method ?? 'GET'} ${clip(a.url, 30)}`
    case 'action': return a.action ? `${a.connection}: ${a.action}` : 'Connector action'
    case 'callFlow': return a.flow ? `Run ${clip(a.flow)}` : 'Run a child flow'
    case 'terminate': return `End as ${a.status ?? 'succeeded'}`
    default: return kindInfo(s.kind).title
  }
}

export interface CanvasProps {
  onOpenPicker(slot: Slot, index: number): void
  triggerTitle: string
  triggerSummary: string
  triggerType: string
  /** run the shown (ended) run again: from the failed step, or from a chosen top-level step */
  onResubmit?(stepId: string, from: 'failed' | 'step'): void
  /** counts of problems per step id */
  problemCount: Map<string, number>
}

export function Canvas(p: CanvasProps) {
  const doc = useDesigner((s) => s.doc)
  const collapsed = useDesigner((s) => s.collapsed)
  const selection = useDesigner((s) => s.selection)
  const focus = useDesigner((s) => s.focus)
  const readOnly = useDesigner((s) => s.readOnly)
  const run = useDesigner((s) => s.run)
  const iteration = useDesigner((s) => s.iteration)
  const search = useDesigner((s) => s.search)
  const L = useMemo(() => layoutFlow(doc.steps, collapsed), [doc.steps, collapsed])
  const overlay = useMemo(() => overlayOf(run, iteration), [run, iteration])
  const iters = useMemo(() => loopIterations(run), [run])
  const sel = useMemo(() => new Set(selectedIds(selection)), [selection])
  const hits = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return null
    const out = new Set<string>()
    for (const c of L.cards) if (`${c.step.name} ${c.step.description ?? ''} ${kindInfo(c.step.kind).title} ${stepSummary(c.step)}`.toLowerCase().includes(q)) out.add(c.id)
    return out
  }, [search, L])

  const host = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 900, h: 600 })
  const [view, setView] = useState<View>({ tx: 0, ty: 0, k: 1 })
  const viewRef = useRef(view)
  viewRef.current = view
  const fitted = useRef(false)
  useLayoutEffect(() => {
    const el = host.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  const fit = useCallback(() => {
    const b = L.bounds
    const k = Math.min(1, Math.max(0.2, Math.min(size.w / (b.w + 40), size.h / (b.h + 40))))
    setView({ k, tx: (size.w - b.w * k) / 2, ty: Math.max(10, (size.h - b.h * k) / 2) })
  }, [L.bounds, size])
  useEffect(() => {
    if (!fitted.current && size.w > 100) {
      fitted.current = true
      // start at full size on top when the flow is long; fit when it fits
      const b = L.bounds
      if (b.h * 1 < size.h && b.w < size.w) setView({ k: 1, tx: (size.w - b.w) / 2, ty: 10 })
      else setView({ k: Math.max(0.6, Math.min(1, size.w / (b.w + 40))), tx: Math.max(0, (size.w - b.w * Math.min(1, size.w / (b.w + 40))) / 2), ty: 10 })
    }
  }, [size, L.bounds])
  const zoomAt = (factor: number, cx?: number, cy?: number) => {
    const r = host.current!.getBoundingClientRect()
    const px = cx === undefined ? r.width / 2 : cx - r.left
    const py = cy === undefined ? r.height / 2 : cy - r.top
    setView((v) => {
      const k = Math.min(2, Math.max(0.15, v.k * factor))
      return { k, tx: px - ((px - v.tx) / v.k) * k, ty: py - ((py - v.ty) / v.k) * k }
    })
  }
  useEffect(() => {
    const el = host.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element).closest('[data-no-canvas-wheel]')) return
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY)
      else setView((v) => ({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY }))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  /** scroll a step into view */
  const reveal = useCallback((id: string) => {
    const b = id === 'trigger' ? L.trigger : L.byId.get(id)
    if (!b) return
    const v = viewRef.current
    const x = b.x * v.k + v.tx
    const y = b.y * v.k + v.ty
    if (x < 20 || y < 20 || x + b.w * v.k > size.w - 20 || y + b.h * v.k > size.h - 20) setView({ ...v, tx: size.w / 2 - (b.x + b.w / 2) * v.k, ty: size.h / 2 - (b.y + b.h / 2) * v.k })
  }, [L, size])
  useEffect(() => { if (focus) reveal(focus) }, [focus, reveal])
  useEffect(() => {
    if (hits && hits.size) { const first = order(doc, collapsed).find((id) => hits.has(id)); if (first) reveal(first) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hits])

  /* ---------------------------------------------------------------- pointer: pan, drag a step */
  const drag = useRef<null | { kind: 'pan'; sx: number; sy: number; tx: number; ty: number; moved: boolean } | { kind: 'step'; id: string; sx: number; sy: number; started: boolean }>(null)
  const [ghost, setGhost] = useState<null | { x: number; y: number; ids: string[]; over: InsertNode | null }>(null)
  const toWorld = (cx: number, cy: number) => {
    const r = host.current!.getBoundingClientRect()
    const v = viewRef.current
    return { x: (cx - r.left - v.tx) / v.k, y: (cy - r.top - v.ty) / v.k }
  }
  const nearestInsert = (x: number, y: number, ids: string[]): InsertNode | null => {
    let best: InsertNode | null = null
    let bd = 60 * 60
    for (const i of L.inserts) {
      if (i.slot.parent && ids.some((id) => i.slot.parent === id || findStep(doc.steps, i.slot.parent)?.ancestors.includes(id))) continue
      const d = (i.x - x) ** 2 + (i.y - y) ** 2
      if (d < bd) { bd = d; best = i }
    }
    return best
  }
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const t = e.target as Element
    if (t.closest('[data-no-drag]')) return
    const card = t.closest('[data-step]')
    if (card && !readOnly) drag.current = { kind: 'step', id: card.getAttribute('data-step')!, sx: e.clientX, sy: e.clientY, started: false }
    else if (!card && !t.closest('button')) drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty, moved: false }
    else return
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    if (d.kind === 'pan') {
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true
      setView((v) => ({ ...v, tx: d.tx + e.clientX - d.sx, ty: d.ty + e.clientY - d.sy }))
      return
    }
    if (!d.started && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 6) return
    d.started = true
    const ids = sel.has(d.id) ? [...sel] : [d.id]
    const w = toWorld(e.clientX, e.clientY)
    setGhost({ x: w.x, y: w.y, ids, over: nearestInsert(w.x, w.y, ids) })
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (d?.kind === 'pan' && !d.moved) useDesigner.getState().set({ selection: null })
    if (d?.kind === 'step' && d.started && ghost) {
      const over = ghost.over
      setGhost(null)
      if (over) {
        const r = move(ghost.ids, over.slot, over.index)
        if (!r.ok) useDesigner.getState().set({ notes: r.notes })
      }
    } else if (d?.kind === 'step') {
      // a click
      const id = d.id
      const st = useDesigner.getState()
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        const cur = selectedIds(st.selection)
        st.set({ selection: { kind: 'steps', ids: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] }, focus: id })
      } else st.set({ selection: { kind: 'steps', ids: [id] }, focus: id })
      setGhost(null)
    }
  }

  /* ---------------------------------------------------------------- keyboard */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const st = useDesigner.getState()
    const mod = e.ctrlKey || e.metaKey
    const ids = ['trigger', ...order(st.doc, st.collapsed)]
    const cur = st.focus ?? selectedIds(st.selection)[0] ?? 'trigger'
    const i = Math.max(0, ids.indexOf(cur))
    const go = (id: string | undefined) => { if (id) { e.preventDefault(); st.set({ focus: id }) } }
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); st.undo(); return }
    if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); st.redo(); return }
    if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); const n = copySelected(); if (n) st.set({ notes: [`Copied ${n} step${n === 1 ? '' : 's'}. Paste with Ctrl+V, here or in another flow.`] }); return }
    if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); if (!st.readOnly) paste(); return }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); if (!st.readOnly) duplicateSelected(); return }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); st.set({ selection: { kind: 'steps', ids: order(st.doc) } }); return }
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); document.querySelector<HTMLInputElement>('[data-testid="flow-search"]')?.focus(); return }
    switch (e.key) {
      case 'ArrowDown': return go(ids[i + 1])
      case 'ArrowUp': return go(ids[i - 1])
      case 'ArrowLeft': {
        const f = cur !== 'trigger' ? findStep(st.doc.steps, cur) : null
        if (f?.slot.parent) return go(f.slot.parent)
        if (f && listsOf(f.step).length && !st.collapsed.has(cur)) { e.preventDefault(); st.toggleCollapsed(cur, true) }
        return
      }
      case 'ArrowRight': {
        const f = cur !== 'trigger' ? findStep(st.doc.steps, cur) : null
        if (f && listsOf(f.step).length) {
          if (st.collapsed.has(cur)) { e.preventDefault(); st.toggleCollapsed(cur, false); return }
          // the first step of the next non-empty lane
          const first = listsOf(f.step).find((l) => l.steps.length)?.steps[0]
          return go(first?.id)
        }
        return
      }
      case 'Enter': case ' ': {
        e.preventDefault()
        if (cur === 'trigger') st.set({ selection: { kind: 'trigger' } })
        else st.set({ selection: { kind: 'steps', ids: [cur] } })
        return
      }
      case 'Delete': case 'Backspace': {
        if (st.readOnly) return
        e.preventDefault()
        if (!selectedIds(st.selection).length && cur !== 'trigger') st.set({ selection: { kind: 'steps', ids: [cur] } })
        deleteSelected()
        return
      }
      case 'Escape': st.set({ selection: null, picker: null }); return
      case 'Insert': case '+': {
        if (st.readOnly) return
        e.preventDefault()
        const f = cur !== 'trigger' ? findStep(st.doc.steps, cur) : null
        p.onOpenPicker(f ? f.slot : { parent: '', list: 'steps' }, f ? f.index + 1 : 0)
        return
      }
    }
  }

  /* ---------------------------------------------------------------- minimap */
  const mini = (() => {
    const b = L.bounds
    const W = 150
    const H = Math.max(60, Math.min(160, (W * b.h) / Math.max(1, b.w)))
    const s = Math.min(W / b.w, H / b.h)
    return { W, H, s, vx: (-view.tx / view.k) * s, vy: (-view.ty / view.k) * s, vw: (size.w / view.k) * s, vh: (size.h / view.k) * s }
  })()
  const miniDrag = useRef(false)
  const miniGo = (e: React.PointerEvent) => {
    const r = (e.currentTarget as Element).getBoundingClientRect()
    const wx = (e.clientX - r.left) / mini.s
    const wy = (e.clientY - r.top) / mini.s
    setView((v) => ({ ...v, tx: size.w / 2 - wx * v.k, ty: size.h / 2 - wy * v.k }))
  }

  const TriggerIcon = TRIGGER_ICON[p.triggerType] ?? FALLBACK_ICON
  const trigSel = selection?.kind === 'trigger'
  const runTrigger = run ? true : false
  return (
    <div
      ref={host} tabIndex={0} role="application" aria-label="Flow canvas. Arrow keys move between steps, Enter opens one."
      className="relative h-full w-full touch-none select-none overflow-hidden bg-canvas outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      data-testid="flow-canvas" data-zoom={view.k.toFixed(2)} data-steps={L.cards.length}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onKeyDown={onKeyDown}
    >
      <svg width={size.w} height={size.h} className="pointer-events-none absolute inset-0">
        <defs>
          <pattern id="flow-dots" width={24} height={24} patternUnits="userSpaceOnUse" patternTransform={`translate(${view.tx},${view.ty}) scale(${view.k})`}>
            <circle cx={1} cy={1} r={1} className="fill-muted-foreground/25" />
          </pattern>
        </defs>
        <rect width={size.w} height={size.h} fill="url(#flow-dots)" />
      </svg>
      <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.k})`, width: L.bounds.w, height: L.bounds.h }}>
        {/* regions behind everything */}
        {L.regions.map((r) => (
          <div key={r.id} data-testid={`region-${r.step.name}`} className={cn('absolute rounded-xl border bg-card/40', r.step.kind === 'condition' ? 'border-violet-500/30' : r.step.kind === 'scope' ? 'border-slate-400/40 border-dashed' : 'border-border')} style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />
        ))}
        {L.lanes.map((l) => (
          <div key={`${l.slot.parent}:${l.slot.list}`} className="absolute flex justify-center" style={{ left: l.x, top: l.y, width: l.w }}>
            <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', l.tone === 'yes' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : l.tone === 'no' ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300' : 'bg-muted text-muted-foreground')} data-testid={`lane-${l.slot.parent}-${l.slot.list}`}>{l.label}</span>
          </div>
        ))}
        <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={L.bounds.w} height={L.bounds.h}>
          <defs>
            <marker id="ra-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 8 4 L 0 8 z" className="fill-amber-500" /></marker>
          </defs>
          {L.edges.map((e, i) => <path key={i} d={e.d} fill="none" strokeWidth={1.5} className={e.tone === 'yes' ? 'stroke-emerald-500/70' : e.tone === 'no' ? 'stroke-rose-500/70' : 'stroke-muted-foreground/50'} />)}
          {L.runAfter.map((e, i) => (
            <g key={`ra${i}`} data-testid={`runafter-${e.from}-${e.to}`}>
              <path d={e.d} fill="none" strokeWidth={1.8} strokeDasharray="6 4" className={e.failed ? 'stroke-amber-500' : 'stroke-sky-500'} markerEnd="url(#ra-arrow)" />
              <text x={e.lx} y={e.ly} textAnchor="end" className={cn('text-[10px] font-semibold', e.failed ? 'fill-amber-600' : 'fill-sky-600')}>{e.label}</text>
            </g>
          ))}
        </svg>
        {/* the trigger */}
        <button type="button" data-testid="trigger-card" data-focused={focus === 'trigger' || undefined}
          className={cn('absolute flex items-center gap-3 rounded-lg border-2 bg-card px-3 text-left shadow-sm transition-shadow hover:shadow-md', trigSel ? 'border-primary ring-2 ring-primary/30' : 'border-primary/40', focus === 'trigger' && 'outline outline-2 outline-offset-2 outline-primary/60', runTrigger && 'border-emerald-500')}
          style={{ left: L.trigger.x, top: L.trigger.y, width: L.trigger.w, height: L.trigger.h }}
          onClick={() => useDesigner.getState().set({ selection: { kind: 'trigger' }, focus: 'trigger' })}>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"><TriggerIcon className="size-5" /></span>
          <span className="min-w-0">
            <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Trigger</span>
            <span className="block truncate text-sm font-semibold">{p.triggerTitle}</span>
            <span className="block truncate text-[11px] text-muted-foreground">{p.triggerSummary}</span>
          </span>
          {(p.problemCount.get('trigger') ?? 0) > 0 && <TriangleAlert className="ml-auto size-4 shrink-0 text-destructive" />}
        </button>
        {L.cards.map((c) => <Card key={c.id} c={c} selected={sel.has(c.id)} focused={focus === c.id} dim={!!hits && !hits.has(c.id)} hit={!!hits?.has(c.id)} ov={overlay.get(c.id)} problems={p.problemCount.get(c.id) ?? 0} iters={iters[c.id]} iteration={iteration[c.id]} readOnly={readOnly} onResubmit={p.onResubmit} />)}
        {!readOnly && L.inserts.map((i) => {
          const over = ghost?.over === i
          return (
            <button key={`${i.slot.parent}:${i.slot.list}:${i.index}`} type="button" data-no-drag data-testid={`insert-${i.slot.parent || 'top'}-${i.slot.list}-${i.index}`} aria-label={`Add a step here`}
              title="Add a step"
              className={cn('absolute flex items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition hover:border-primary hover:bg-primary hover:text-primary-foreground',
                i.empty ? 'h-7 -translate-x-1/2 -translate-y-1/2 gap-1 px-2 text-[11px]' : 'size-5 -translate-x-1/2 -translate-y-1/2 opacity-70 hover:opacity-100', over && 'scale-125 border-primary bg-primary text-primary-foreground opacity-100')}
              style={{ left: i.x, top: i.y }}
              onClick={() => p.onOpenPicker(i.slot, i.index)}>
              <Plus className="size-3" />{i.empty && 'Add a step'}
            </button>
          )
        })}
        <div className="absolute flex -translate-x-1/2 items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-[10px] text-muted-foreground" style={{ left: L.end.x, top: L.end.y }}><Flag className="size-3" />End</div>
        {ghost && (
          <div className="pointer-events-none absolute rounded-lg border-2 border-primary bg-card/90 px-3 py-2 text-xs font-medium shadow-lg" style={{ left: ghost.x - 60, top: ghost.y - 16, width: 180 }}>
            Move {ghost.ids.length === 1 ? findStep(doc.steps, ghost.ids[0])?.step.name : `${ghost.ids.length} steps`}
          </div>
        )}
      </div>

      <div className="absolute bottom-3 left-3 flex flex-col gap-1 rounded-md border bg-card p-1 shadow-sm" data-no-drag>
        <button type="button" aria-label="Zoom in" className="rounded p-1 hover:bg-accent" onClick={() => zoomAt(1.2)}><Plus className="size-4" /></button>
        <button type="button" aria-label="Zoom out" className="rounded p-1 hover:bg-accent" onClick={() => zoomAt(1 / 1.2)}><Minus className="size-4" /></button>
        <button type="button" aria-label="Fit to view" data-testid="flow-fit" className="rounded p-1 hover:bg-accent" onClick={fit}><Maximize className="size-4" /></button>
      </div>
      <svg width={mini.W} height={mini.H} className="absolute bottom-3 right-3 cursor-pointer rounded-md border bg-card/90 shadow-sm" data-testid="flow-minimap" data-no-drag
        onPointerDown={(e) => { e.stopPropagation(); miniDrag.current = true; (e.currentTarget as Element).setPointerCapture(e.pointerId); miniGo(e) }}
        onPointerMove={(e) => { if (miniDrag.current) miniGo(e) }} onPointerUp={() => { miniDrag.current = false }}>
        {L.regions.map((r) => <rect key={r.id} x={r.x * mini.s} y={r.y * mini.s} width={r.w * mini.s} height={r.h * mini.s} className="fill-none stroke-border" />)}
        <rect x={L.trigger.x * mini.s} y={L.trigger.y * mini.s} width={L.trigger.w * mini.s} height={Math.max(2, L.trigger.h * mini.s)} className="fill-primary/60" />
        {L.cards.map((c) => {
          const o = overlay.get(c.id)
          return <rect key={c.id} x={c.x * mini.s} y={c.y * mini.s} width={Math.max(2, c.w * mini.s)} height={Math.max(2, c.h * mini.s)} className={cn(sel.has(c.id) ? 'fill-primary' : o?.status === 'failed' ? 'fill-red-500' : o?.status === 'succeeded' ? 'fill-emerald-500/70' : o?.status === 'waiting' ? 'fill-amber-500' : 'fill-muted-foreground/40')} />
        })}
        <rect x={mini.vx} y={mini.vy} width={mini.vw} height={mini.vh} fill="none" className="stroke-primary" strokeWidth={1.5} />
      </svg>
    </div>
  )
}

function Card({ c, selected, focused, dim, hit, ov, problems, iters, iteration, readOnly, onResubmit }: {
  c: ReturnType<typeof layoutFlow>['cards'][number]; selected: boolean; focused: boolean; dim: boolean; hit: boolean; ov?: StepOverlay; problems: number
  iters?: number[]; iteration?: number; readOnly: boolean; onResubmit?(id: string, from: 'failed' | 'step'): void
}) {
  const s = c.step
  const info = kindInfo(s.kind)
  const Icon = info.icon
  const isContainer = listsOf(s).length > 0
  const st = useDesigner.getState
  const ra = s.runAfter?.length ? s.runAfter.map((r) => r.when.map((w) => (w === 'timedOut' ? 'timed out' : w)).join('/')).join('; ') : ''
  const iterIdx = iters ? (iteration !== undefined ? iters.indexOf(iteration) : iters.length - 1) : -1
  return (
    <div
      data-step={c.id} data-testid={`step-${s.name}`} data-kind={s.kind} data-status={ov?.status} data-selected={selected || undefined} data-focused={focused || undefined}
      role="button" aria-label={`${s.name}: ${info.title}${ov ? `, ${ov.status}` : ''}`} aria-pressed={selected}
      className={cn('absolute flex items-center gap-2.5 rounded-lg border bg-card px-2.5 shadow-sm transition-shadow hover:shadow-md',
        !readOnly && 'cursor-grab active:cursor-grabbing',
        ov ? cn('border-2 ring-2', STATUS_TONE[ov.status]) : 'border-border',
        selected && 'border-primary ring-2 ring-primary/30', focused && 'outline outline-2 outline-offset-2 outline-primary/60', dim && 'opacity-35', hit && 'ring-2 ring-amber-400')}
      style={{ left: c.x, top: c.y, width: CARD_W, height: c.h }}
      onDoubleClick={() => { if (isContainer) st().toggleCollapsed(c.id) }}
    >
      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-md', info.tone)}><Icon className="size-4" /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1">
          <span className="truncate text-[13px] font-semibold" data-testid="step-name">{s.name}</span>
          {s.description && <StickyNote className="size-3 shrink-0 text-amber-500" aria-label="Has a note" />}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">{ov ? <OverlayLine ov={ov} /> : stepSummary(s)}</span>
        {ra && !ov && <span className="flex items-center gap-0.5 truncate text-[10px] text-amber-700 dark:text-amber-400" data-testid="runafter-badge"><CornerDownRight className="size-3" />after {ra}</span>}
      </span>
      {problems > 0 && <span className="flex items-center gap-0.5 rounded bg-destructive/10 px-1 text-[10px] font-semibold text-destructive" data-testid="step-problems" title={`${problems} problem${problems === 1 ? '' : 's'}`}><TriangleAlert className="size-3" />{problems}</span>}
      {iters && iters.length > 1 && (
        <span className="flex items-center rounded border bg-background text-[10px]" data-no-drag data-testid="iteration-pager">
          <button type="button" className="px-0.5 disabled:opacity-30" disabled={iterIdx <= 0} aria-label="Previous iteration" onClick={(e) => { e.stopPropagation(); st().set({ iteration: { ...st().iteration, [c.id]: iters[iterIdx - 1] } }) }}><ChevronLeft className="size-3" /></button>
          <span className="px-0.5 tabular-nums">{iterIdx + 1}/{iters.length}</span>
          <button type="button" className="px-0.5 disabled:opacity-30" disabled={iterIdx >= iters.length - 1} aria-label="Next iteration" onClick={(e) => { e.stopPropagation(); st().set({ iteration: { ...st().iteration, [c.id]: iters[iterIdx + 1] } }) }}><ChevronRight className="size-3" /></button>
        </span>
      )}
      {isContainer && (
        <button type="button" data-no-drag className="rounded p-0.5 text-muted-foreground hover:bg-accent" aria-label={c.collapsed ? 'Expand' : 'Collapse'} data-testid="collapse-toggle" onClick={(e) => { e.stopPropagation(); st().toggleCollapsed(c.id) }}>
          {c.collapsed ? <span className="flex items-center text-[10px]"><ChevronRight className="size-3.5" />{c.inner}</span> : <ChevronDown className="size-3.5" />}
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" data-no-drag className="rounded p-0.5 text-muted-foreground hover:bg-accent" aria-label={`Menu of ${s.name}`} data-testid="step-menu" onPointerDown={(e) => e.stopPropagation()}><MoreHorizontal className="size-4" /></button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => st().set({ selection: { kind: 'steps', ids: [c.id] } })}>Open</DropdownMenuItem>
          {!readOnly && <>
            <DropdownMenuItem data-testid="menu-rename" onSelect={() => st().set({ dialog: { kind: 'rename', id: c.id } })}>Rename</DropdownMenuItem>
            <DropdownMenuItem data-testid="menu-runafter" onSelect={() => st().set({ dialog: { kind: 'runAfter', id: c.id } })}>Run after…</DropdownMenuItem>
            <DropdownMenuItem data-testid="menu-note" onSelect={() => st().set({ dialog: { kind: 'note', id: c.id } })}>{s.description ? 'Edit note' : 'Add a note'}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => { st().set({ selection: { kind: 'steps', ids: [c.id] } }); duplicateSelected() }}>Duplicate <span className="ml-auto text-[10px] text-muted-foreground">Ctrl+D</span></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { st().set({ selection: { kind: 'steps', ids: [c.id] } }); copySelected() }}>Copy <span className="ml-auto text-[10px] text-muted-foreground">Ctrl+C</span></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { st().set({ selection: { kind: 'steps', ids: [c.id] } }); paste() }}>Paste after</DropdownMenuItem>
          </>}
          {isContainer && <DropdownMenuItem onSelect={() => st().toggleCollapsed(c.id)}>{c.collapsed ? 'Expand' : 'Collapse'}</DropdownMenuItem>}
          {ov && onResubmit && (ov.status === 'failed' || ov.status === 'timedOut') && <DropdownMenuItem data-testid="menu-resubmit" onSelect={() => onResubmit(c.id, 'failed')}>Run again from this step</DropdownMenuItem>}
          {ov && onResubmit && (ov.status === 'succeeded' || ov.status === 'skipped') && (c.depth === 0
            ? <DropdownMenuItem data-testid="menu-resubmit-step" onSelect={() => onResubmit(c.id, 'step')}>Run again from this step…</DropdownMenuItem>
            : <DropdownMenuItem disabled data-testid="menu-resubmit-nested" title="The state of a half-run condition, loop or scope cannot be rebuilt safely. Run again from the top-level step that holds this one.">Run again from here: only top-level steps</DropdownMenuItem>)}
          {!readOnly && <>
            <DropdownMenuSeparator />
            <DropdownMenuItem data-testid="menu-delete" className="text-destructive" onSelect={() => { st().set({ selection: { kind: 'steps', ids: [c.id] } }); deleteSelected() }}>Delete <span className="ml-auto text-[10px] text-muted-foreground">Del</span></DropdownMenuItem>
          </>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function OverlayLine({ ov }: { ov: StepOverlay }) {
  return (
    <span className="flex items-center gap-1" data-testid="step-overlay">
      <span className={cn('rounded-full px-1.5 text-[10px] font-medium', STATUS_CHIP[ov.status] ?? 'bg-muted')}>{ov.status}</span>
      {ov.durationMs !== undefined && <span>{fmtDuration(ov.durationMs)}</span>}
      {ov.attempt > 1 && <span>· attempt {ov.attempt}</span>}
      {ov.simulated && <span className="text-amber-700 dark:text-amber-400">· simulated</span>}
    </span>
  )
}
