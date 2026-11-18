/**
 * The diagram (SVG, no third-party canvas library): table cards with their columns, type icons and badges,
 * relationship lines with crow's-foot ends, areas behind the cards, pan (drag the background, scroll), zoom (Ctrl or
 * Cmd + scroll, the buttons), a minimap, drag a card by its header to move it, drag from a card's connector dot to
 * another card (or the same one) to start a relationship. Double-click a column to rename it in place.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Minus, Plus, Maximize, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Model, ModelLayout, ModelTable, RelationshipDef } from '@/model/types'
import { isSystemTable } from '@/model/types'
import { CARD_PAD, CARD_W, HEADER_H, ROW_H, areaBox, bounds, boxOf, cardColumns, relationshipPath, rowCenter, type Box } from '@/model/layout'
import { AREA_FILL, columnBadges } from '@/model/svg'
import { tableById } from '@/model/ops'
import { TYPE_INFO, FallbackIcon } from '../columnTypes'
import type { Selection } from './store'

export interface CanvasProps {
  model: Model
  layout: ModelLayout
  visible: Set<string>
  dimmed: Set<string>
  selection: Selection
  keysOnly: boolean
  readOnly: boolean
  focus: { id: string; at: number } | null
  /** live table ids (the others exist only in the draft) */
  liveIds: Set<string>
  /** table ids changed in the draft */
  changedIds: Set<string>
  onSelect(s: Selection): void
  onMove(id: string, x: number, y: number, done: boolean): void
  onConnect(from: string, to: string): void
  onRenameColumn(table: string, column: string, displayName: string): void
  onAddColumn(table: string): void
  onOpenTable(id: string): void
}

interface View { tx: number; ty: number; k: number }
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function Ends({ x, y, dir, many, optional }: { x: number; y: number; dir: 1 | -1; many: boolean; optional: boolean }) {
  const a = x + dir * 14
  const c = x + dir * (many ? 21 : 15)
  return (
    <g className="stroke-muted-foreground" strokeWidth={1.4} fill="none">
      {many ? <path d={`M ${a} ${y} L ${x} ${y - 7} M ${a} ${y} L ${x} ${y} M ${a} ${y} L ${x} ${y + 7}`} /> : <path d={`M ${x + dir * 8} ${y - 7} L ${x + dir * 8} ${y + 7}`} />}
      {optional ? <circle cx={c} cy={y} r={4} className="fill-background" /> : <path d={`M ${c} ${y - 7} L ${c} ${y + 7}`} />}
    </g>
  )
}

export function ModelCanvas(p: CanvasProps) {
  const host = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [view, setView] = useState<View>({ tx: 40, ty: 40, k: 1 })
  const viewRef = useRef(view)
  viewRef.current = view
  const drag = useRef<null | { kind: 'pan'; sx: number; sy: number; tx: number; ty: number } | { kind: 'move'; id: string; dx: number; dy: number; moved: boolean } | { kind: 'connect'; from: string }>(null)
  const [ghost, setGhost] = useState<null | { from: string; x: number; y: number; over: string | null }>(null)
  const [editing, setEditing] = useState<null | { table: string; column: string; value: string }>(null)
  const fitted = useRef(false)

  useLayoutEffect(() => {
    const el = host.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const tables = useMemo(() => p.model.tables.filter((t) => p.visible.has(t.id) && p.layout.positions[t.id]), [p.model, p.visible, p.layout])
  const boxes = useMemo(() => new Map(tables.map((t) => [t.id, boxOf(t, p.layout, { keysOnly: p.keysOnly })])), [tables, p.layout, p.keysOnly])
  const world = useMemo(() => bounds([...boxes.values()], 60), [boxes])

  const fit = useCallback(() => {
    const b = world
    const k = Math.min(1.25, Math.max(0.15, Math.min(size.w / b.w, size.h / b.h)))
    setView({ k, tx: (size.w - b.w * k) / 2 - b.x * k, ty: (size.h - b.h * k) / 2 - b.y * k })
  }, [world, size])
  useEffect(() => {
    if (!fitted.current && tables.length && size.w > 100) {
      fitted.current = true
      fit()
    }
  }, [tables.length, size.w, fit])
  useEffect(() => {
    if (!p.focus) return
    const b = boxes.get(p.focus.id)
    if (!b) return
    const k = Math.max(viewRef.current.k, 0.8)
    setView({ k, tx: size.w / 2 - (b.x + b.w / 2) * k, ty: size.h / 2 - (b.y + b.h / 2) * k })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.focus?.at])

  const toWorld = (cx: number, cy: number) => {
    const r = host.current!.getBoundingClientRect()
    const v = viewRef.current
    return { x: (cx - r.left - v.tx) / v.k, y: (cy - r.top - v.ty) / v.k }
  }
  const zoomAt = (factor: number, cx?: number, cy?: number) => {
    const r = host.current!.getBoundingClientRect()
    const px = cx === undefined ? r.width / 2 : cx - r.left
    const py = cy === undefined ? r.height / 2 : cy - r.top
    setView((v) => {
      const k = Math.min(2.5, Math.max(0.1, v.k * factor))
      return { k, tx: px - ((px - v.tx) / v.k) * k, ty: py - ((py - v.ty) / v.k) * k }
    })
  }
  const tableAt = (x: number, y: number): string | null => {
    for (const [id, b] of boxes) if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return id
    return null
  }

  useEffect(() => {
    const el = host.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY)
      else setView((v) => ({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY }))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const target = e.target as Element
    const conn = target.closest('[data-connect]')
    const card = target.closest('[data-card]')
    const rel = target.closest('[data-rel]')
    const w = toWorld(e.clientX, e.clientY)
    if (conn && !p.readOnly) {
      const from = conn.getAttribute('data-connect')!
      drag.current = { kind: 'connect', from }
      setGhost({ from, x: w.x, y: w.y, over: null })
    } else if (card) {
      const id = card.getAttribute('data-card')!
      p.onSelect({ kind: 'table', id })
      const b = boxes.get(id)
      if (b && !p.readOnly && target.closest('[data-header]')) drag.current = { kind: 'move', id, dx: w.x - b.x, dy: w.y - b.y, moved: false }
    } else if (rel) {
      p.onSelect({ kind: 'relationship', id: rel.getAttribute('data-rel')! })
    } else {
      p.onSelect(null)
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty }
    }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    if (d.kind === 'pan') setView((v) => ({ ...v, tx: d.tx + e.clientX - d.sx, ty: d.ty + e.clientY - d.sy }))
    else if (d.kind === 'move') {
      const w = toWorld(e.clientX, e.clientY)
      d.moved = true
      p.onMove(d.id, Math.round((w.x - d.dx) / 4) * 4, Math.round((w.y - d.dy) / 4) * 4, false)
    } else {
      const w = toWorld(e.clientX, e.clientY)
      setGhost({ from: d.from, x: w.x, y: w.y, over: tableAt(w.x, w.y) })
    }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (d?.kind === 'move' && d.moved) {
      const b = boxes.get(d.id)
      if (b) p.onMove(d.id, b.x, b.y, true)
    }
    if (d?.kind === 'connect') {
      const w = toWorld(e.clientX, e.clientY)
      const over = tableAt(w.x, w.y)
      setGhost(null)
      if (over) p.onConnect(d.from, over)
    }
  }

  const rels = p.model.relationships.filter((r) => p.visible.has(r.fromTable) && p.visible.has(r.toTable))
  const selRel = p.selection?.kind === 'relationship' ? p.selection.id : null
  const selTable = p.selection?.kind === 'table' ? p.selection.id : null

  const line = (r: RelationshipDef) => {
    const child = tableById(p.model, r.fromTable)
    const parent = tableById(p.model, r.toTable)
    const cb = child && boxes.get(child.id)
    const pb = parent && boxes.get(parent.id)
    if (!child || !parent || !cb || !pb) return null
    const col = child.columns.find((c) => c.name === r.fromColumn)
    const path = relationshipPath(cb, rowCenter(child, r.fromColumn, { keysOnly: p.keysOnly }), pb, r.kind === 'self')
    const optional = !col?.required
    const sel = selRel === r.id || selTable === child.id || selTable === parent.id
    const dim = p.dimmed.has(child.id) && p.dimmed.has(parent.id)
    return (
      <g key={r.id} data-rel={r.id} data-testid={`rel-${child.name}-${r.fromColumn}`} className={cn('cursor-pointer', dim && 'opacity-25')}>
        <path d={path.d} fill="none" stroke="transparent" strokeWidth={12} />
        <path d={path.d} fill="none" className={sel ? 'stroke-primary' : 'stroke-muted-foreground/70'} strokeWidth={sel ? 2.2 : 1.4} strokeDasharray={optional ? '5 3' : undefined} />
        <Ends x={path.from.x} y={path.from.y} dir={path.from.dir} many={r.kind !== 'oneToOne'} optional={optional} />
        <Ends x={path.to.x} y={path.to.y} dir={path.to.dir} many={false} optional={optional && r.kind === 'self'} />
        {sel && (
          <text x={(path.from.x + path.to.x) / 2} y={(path.from.y + path.to.y) / 2 - 6} textAnchor="middle" className="fill-primary text-[10px] font-medium">
            {r.onDelete === 'setBlank' ? 'set blank' : r.onDelete}{r.junction ? ' · m:n' : ''}
          </text>
        )}
      </g>
    )
  }

  const card = (t: ModelTable) => {
    const b = boxes.get(t.id)!
    const sys = isSystemTable(t)
    const view = t.reporting?.kind === 'view'
    const isNew = !p.liveIds.has(t.id)
    const changed = p.changedIds.has(t.id)
    const sel = selTable === t.id
    const cols = cardColumns(t, { keysOnly: p.keysOnly })
    const tag = sys ? 'system' : view ? `${t.reporting?.kind === 'view' ? t.reporting.role : ''} view` : t.reporting?.kind === 'summary' ? 'summary' : t.reporting?.kind === 'date' ? 'dates' : isNew ? 'new' : changed ? 'changed' : ''
    return (
      <g key={t.id} data-card={t.id} data-table={t.name} data-testid={`card-${t.name}`} className={cn(p.dimmed.has(t.id) && 'opacity-30')} onDoubleClick={(e) => {
        const row = (e.target as Element).closest('[data-col]')
        if (row && !p.readOnly && !sys && !view) {
          const c = t.columns.find((x) => x.name === row.getAttribute('data-col'))
          if (c) setEditing({ table: t.id, column: c.name, value: c.displayName })
        } else if ((e.target as Element).closest('[data-header]')) p.onOpenTable(t.id)
      }}>
        <rect x={b.x} y={b.y} width={CARD_W} height={b.h} rx={8} className={cn(sys ? 'fill-muted' : 'fill-card', sel ? 'stroke-primary' : isNew ? 'stroke-emerald-500' : changed ? 'stroke-sky-500' : 'stroke-border')} strokeWidth={sel ? 2 : isNew || changed ? 1.6 : 1} strokeDasharray={isNew ? '6 3' : undefined} />
        <g data-header="1" className={cn(!p.readOnly && 'cursor-move')}>
          <path d={`M ${b.x} ${b.y + 8} a 8 8 0 0 1 8 -8 h ${CARD_W - 16} a 8 8 0 0 1 8 8 v ${HEADER_H - 8} h ${-CARD_W} z`} className={view ? 'fill-cyan-500/15' : t.reporting ? 'fill-amber-500/15' : 'fill-muted'} />
          <text x={b.x + 12} y={b.y + 21} className="fill-foreground text-[13px] font-semibold">{clip(t.displayName, 24)}</text>
          {tag && <text x={b.x + CARD_W - (sys || view ? 28 : p.readOnly ? 12 : 18)} y={b.y + 21} textAnchor="end" className={cn('text-[10px]', isNew ? 'fill-emerald-600' : changed ? 'fill-sky-600' : 'fill-muted-foreground')}>{tag}</text>}
        </g>
        {(sys || view) && <Lock x={b.x + CARD_W - 20} y={b.y + 11} width={11} height={11} className="text-muted-foreground" />}
        {cols.map((c, i) => {
          const y = b.y + HEADER_H + CARD_PAD + i * ROW_H
          const Icon = TYPE_INFO[c.type]?.icon ?? FallbackIcon
          const badges = columnBadges(t, c).filter((x) => x !== 'D')
          return (
            <g key={c.name} data-col={c.name} data-testid={`col-${t.name}-${c.name}`}>
              <rect x={b.x + 2} y={y} width={CARD_W - 4} height={ROW_H} className="fill-transparent hover:fill-accent/60" />
              <Icon x={b.x + 10} y={y + 5} width={12} height={12} className="text-muted-foreground" />
              <text x={b.x + 30} y={y + 15} className={cn('fill-foreground text-[12px]', c.name === t.primaryColumn && 'font-semibold')}>{clip(c.displayName, 20)}</text>
              {badges.length > 0 && <text x={b.x + CARD_W - 10} y={y + 15} textAnchor="end" className="fill-muted-foreground text-[9px] font-medium tracking-wide">{badges.join(' ')}</text>}
            </g>
          )
        })}
        {!cols.length && <text x={b.x + 12} y={b.y + HEADER_H + CARD_PAD + 15} className="fill-muted-foreground text-[11px] italic">{p.keysOnly ? 'no key columns' : 'no columns'}</text>}
        {!p.readOnly && !sys && !view && (
          <g data-connect={t.id} data-testid={`connect-${t.name}`} className="cursor-crosshair">
            <circle cx={b.x + CARD_W} cy={b.y + HEADER_H / 2} r={9} className="fill-transparent" />
            <circle cx={b.x + CARD_W} cy={b.y + HEADER_H / 2} r={5} className={cn('fill-background stroke-primary', sel ? 'opacity-100' : 'opacity-60')} strokeWidth={1.6} />
          </g>
        )}
        {sel && !p.readOnly && !sys && !view && (
          <g data-add-col={t.id} className="cursor-pointer" onPointerDown={(e) => { e.stopPropagation(); p.onAddColumn(t.id) }}>
            <rect x={b.x + CARD_W / 2 - 40} y={b.y + b.h - 2} width={80} height={18} rx={9} className="fill-primary" />
            <text x={b.x + CARD_W / 2} y={b.y + b.h + 11} textAnchor="middle" className="fill-primary-foreground text-[10px] font-medium">+ column</text>
          </g>
        )}
      </g>
    )
  }

  const editBox = (() => {
    if (!editing) return null
    const t = tableById(p.model, editing.table)
    const b = t && boxes.get(t.id)
    if (!t || !b) return null
    const y = rowCenter(t, editing.column, { keysOnly: p.keysOnly })
    return { left: (b.x + 26) * view.k + view.tx, top: (b.y + y - ROW_H / 2) * view.k + view.ty, width: (CARD_W - 36) * view.k, height: ROW_H * view.k }
  })()

  const mini = (() => {
    const b = world
    const W = 180
    const H = Math.max(60, Math.min(140, (W * b.h) / Math.max(1, b.w)))
    const s = Math.min(W / b.w, H / b.h)
    const vx = (-view.tx / view.k - b.x) * s
    const vy = (-view.ty / view.k - b.y) * s
    return { W, H, s, b, vx, vy, vw: (size.w / view.k) * s, vh: (size.h / view.k) * s }
  })()
  const miniDrag = useRef(false)
  const miniGo = (e: React.PointerEvent) => {
    const r = (e.currentTarget as Element).getBoundingClientRect()
    const wx = (e.clientX - r.left) / mini.s + mini.b.x
    const wy = (e.clientY - r.top) / mini.s + mini.b.y
    setView((v) => ({ ...v, tx: size.w / 2 - wx * v.k, ty: size.h / 2 - wy * v.k }))
  }

  return (
    <div ref={host} className="relative h-full w-full touch-none select-none overflow-hidden bg-canvas" data-testid="model-canvas" data-zoom={view.k.toFixed(2)}>
      <svg width={size.w} height={size.h} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} className="block font-sans" data-testid="model-svg">
        <defs>
          <pattern id="model-dots" width={24} height={24} patternUnits="userSpaceOnUse" patternTransform={`translate(${view.tx},${view.ty}) scale(${view.k})`}>
            <circle cx={1} cy={1} r={1} className="fill-muted-foreground/25" />
          </pattern>
        </defs>
        <rect width={size.w} height={size.h} fill="url(#model-dots)" />
        <g transform={`translate(${view.tx},${view.ty}) scale(${view.k})`}>
          {p.layout.areas.map((a) => {
            const box = areaBox(p.model, p.layout, a.tables.filter((x) => p.visible.has(x)), { keysOnly: p.keysOnly })
            if (!box) return null
            const [fill, ink] = AREA_FILL[a.color] ?? AREA_FILL.slate
            return (
              <g key={a.id} data-testid={`area-${a.name}`}>
                <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={12} fill={fill} fillOpacity={0.35} stroke={fill} />
                <text x={box.x + 12} y={box.y + 14} fill={ink} className="text-[11px] font-semibold">{a.name}</text>
              </g>
            )
          })}
          {rels.map(line)}
          {tables.map(card)}
          {ghost && (() => {
            const b = boxes.get(ghost.from)
            if (!b) return null
            const over = ghost.over ? boxes.get(ghost.over) : null
            return (
              <g pointerEvents="none">
                <path d={`M ${b.x + CARD_W} ${b.y + HEADER_H / 2} L ${ghost.x} ${ghost.y}`} className="stroke-primary" strokeWidth={2} strokeDasharray="6 4" fill="none" />
                {over && <rect x={over.x - 3} y={over.y - 3} width={over.w + 6} height={over.h + 6} rx={10} fill="none" className="stroke-primary" strokeWidth={2} />}
              </g>
            )
          })()}
        </g>
      </svg>

      {editing && editBox && (
        <input
          autoFocus
          aria-label="Column display name"
          data-testid="inline-column-name"
          className="absolute rounded border border-primary bg-background px-1 text-[12px] shadow outline-none"
          style={{ left: editBox.left, top: editBox.top, width: editBox.width, height: editBox.height, fontSize: Math.max(10, 12 * view.k) }}
          value={editing.value}
          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
          onBlur={() => { if (editing.value.trim()) p.onRenameColumn(editing.table, editing.column, editing.value.trim()); setEditing(null) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') setEditing(null)
          }}
        />
      )}

      <div className="absolute bottom-3 left-3 flex flex-col gap-1 rounded-md border bg-card p-1 shadow-sm">
        <button type="button" aria-label="Zoom in" className="rounded p-1 hover:bg-accent" onClick={() => zoomAt(1.2)}><Plus className="size-4" /></button>
        <button type="button" aria-label="Zoom out" className="rounded p-1 hover:bg-accent" onClick={() => zoomAt(1 / 1.2)}><Minus className="size-4" /></button>
        <button type="button" aria-label="Fit to view" data-testid="model-fit" className="rounded p-1 hover:bg-accent" onClick={fit}><Maximize className="size-4" /></button>
      </div>

      {tables.length > 0 && (
        <svg
          width={mini.W} height={mini.H} className="absolute bottom-3 right-3 cursor-pointer rounded-md border bg-card/90 shadow-sm" data-testid="model-minimap"
          onPointerDown={(e) => { miniDrag.current = true; (e.currentTarget as Element).setPointerCapture(e.pointerId); miniGo(e) }}
          onPointerMove={(e) => { if (miniDrag.current) miniGo(e) }}
          onPointerUp={() => { miniDrag.current = false }}
        >
          {tables.map((t) => {
            const b: Box = boxes.get(t.id)!
            return <rect key={t.id} x={(b.x - mini.b.x) * mini.s} y={(b.y - mini.b.y) * mini.s} width={Math.max(2, b.w * mini.s)} height={Math.max(2, b.h * mini.s)} className={cn(selTable === t.id ? 'fill-primary' : 'fill-muted-foreground/40')} />
          })}
          <rect x={mini.vx} y={mini.vy} width={mini.vw} height={mini.vh} fill="none" className="stroke-primary" strokeWidth={1.5} />
        </svg>
      )}
    </div>
  )
}
