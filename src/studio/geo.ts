import type { Geom } from '@/runtime/evaluator'
import type { Guide, Rect } from '@/runtime/ui'

export const GRID = 8
export const MIN_SIZE = 8
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export const snapGrid = (v: number) => Math.round(v / GRID) * GRID

/* ------------------------------------------------------------------ DOM helpers */

export function frameEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="screen-frame"]')
}

export function clientToFrame(cx: number, cy: number, zoom: number): { x: number; y: number } | null {
  const f = frameEl()
  if (!f) return null
  const r = f.getBoundingClientRect()
  return { x: (cx - r.left) / zoom, y: (cy - r.top) / zoom }
}

/** content origin (frame design coordinates) of an element's containing block */
export function originOfOffsetParent(el: HTMLElement | null, zoom: number): { x: number; y: number } {
  const f = frameEl()
  const op = el?.offsetParent as HTMLElement | null
  if (!f || !op || op === f) return { x: 0, y: 0 }
  const fr = f.getBoundingClientRect()
  const r = op.getBoundingClientRect()
  return { x: (r.left - fr.left) / zoom + op.clientLeft, y: (r.top - fr.top) / zoom + op.clientTop }
}

export function containerOrigin(id: string, zoom: number): { x: number; y: number } {
  const f = frameEl()
  if (!f) return { x: 0, y: 0 }
  let el = f.querySelector<HTMLElement>(`[data-row-origin="${id}"]`)
  if (!el) el = f.querySelector<HTMLElement>(`[data-node-id="${id}"]`)
  if (!el || el === f) return { x: 0, y: 0 }
  const fr = f.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  return { x: (r.left - fr.left) / zoom + el.clientLeft, y: (r.top - fr.top) / zoom + el.clientTop }
}

/** topmost container (Screen/Container/Gallery) under the pointer that is not excluded */
export function containerAt(cx: number, cy: number, exclude: (id: string) => boolean): string | null {
  const f = frameEl()
  if (!f) return null
  for (const el of document.elementsFromPoint(cx, cy)) {
    if (!f.contains(el)) continue
    const c = (el as HTMLElement).closest<HTMLElement>('[data-container="1"]')
    if (!c) continue
    const id = c.getAttribute('data-node-id')
    if (id && !exclude(id)) return id
  }
  return null
}

/* ------------------------------------------------------------------ snapping */

export interface Target { pos: number; a: number; b: number }
export interface Targets { xs: Target[]; ys: Target[] }

export function buildTargets(siblings: Geom[], pw: number, ph: number): Targets {
  const xs: Target[] = [
    { pos: 0, a: NaN, b: NaN },
    { pos: pw / 2, a: NaN, b: NaN },
    { pos: pw, a: NaN, b: NaN },
  ]
  const ys: Target[] = [
    { pos: 0, a: NaN, b: NaN },
    { pos: ph / 2, a: NaN, b: NaN },
    { pos: ph, a: NaN, b: NaN },
  ]
  for (const s of siblings) {
    for (const p of [s.x, s.x + s.w / 2, s.x + s.w]) xs.push({ pos: p, a: s.y, b: s.y + s.h })
    for (const p of [s.y, s.y + s.h / 2, s.y + s.h]) ys.push({ pos: p, a: s.x, b: s.x + s.w })
  }
  return { xs, ys }
}

function bestDelta(cands: number[], targets: Target[], thr: number): number | null {
  let best: number | null = null
  for (const c of cands) {
    for (const t of targets) {
      const d = t.pos - c
      if (Math.abs(d) <= thr && (best === null || Math.abs(d) < Math.abs(best))) best = d
    }
  }
  return best
}

function guidesFor(axis: 'x' | 'y', cands: number[], delta: number, targets: Target[], boxA: number, boxB: number, origin: number, originOther: number): Guide[] {
  const out: Guide[] = []
  const seen = new Set<string>()
  for (const c of cands) {
    for (const t of targets) {
      if (Math.abs(t.pos - (c + delta)) > 0.5) continue
      const a = Number.isNaN(t.a) ? boxA : Math.min(boxA, t.a)
      const b = Number.isNaN(t.b) ? boxB : Math.max(boxB, t.b)
      const key = `${t.pos}|${a}|${b}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ axis, pos: t.pos + origin, from: a + originOther, to: b + originOther })
    }
  }
  return out
}

export interface SnapOpts { targets: Targets; thr: number; free: boolean; origin: { x: number; y: number } }

/** Snap a box being moved. Returns the adjusted box and the guides to draw (frame coordinates). */
export function snapMove(box: Rect, o: SnapOpts): { box: Rect; guides: Guide[] } {
  if (o.free) return { box, guides: [] }
  const cx = [box.x, box.x + box.w / 2, box.x + box.w]
  const cy = [box.y, box.y + box.h / 2, box.y + box.h]
  const sx = bestDelta(cx, o.targets.xs, o.thr)
  const sy = bestDelta(cy, o.targets.ys, o.thr)
  const dx = sx ?? snapGrid(box.x) - box.x
  const dy = sy ?? snapGrid(box.y) - box.y
  const nb = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h }
  const guides: Guide[] = []
  if (sx !== null) guides.push(...guidesFor('x', cx, sx, o.targets.xs, nb.y, nb.y + nb.h, o.origin.x, o.origin.y))
  if (sy !== null) guides.push(...guidesFor('y', cy, sy, o.targets.ys, nb.x, nb.x + nb.w, o.origin.y, o.origin.x))
  return { box: nb, guides }
}

export function snapResize(start: Rect, handle: Handle, dx: number, dy: number, o: SnapOpts, keepAspect: boolean): { box: Rect; guides: Guide[] } {
  let left = start.x
  let right = start.x + start.w
  let top = start.y
  let bottom = start.y + start.h
  if (handle.includes('e')) right += dx
  if (handle.includes('w')) left += dx
  if (handle.includes('s')) bottom += dy
  if (handle.includes('n')) top += dy
  const guides: Guide[] = []
  if (!o.free) {
    const snapEdge = (v: number, targets: Target[]): number => {
      const d = bestDelta([v], targets, o.thr)
      return d !== null ? v + d : snapGrid(v)
    }
    if (handle.includes('e')) right = snapEdge(right, o.targets.xs)
    if (handle.includes('w')) left = snapEdge(left, o.targets.xs)
    if (handle.includes('s')) bottom = snapEdge(bottom, o.targets.ys)
    if (handle.includes('n')) top = snapEdge(top, o.targets.ys)
  }
  if (right - left < MIN_SIZE) {
    if (handle.includes('w')) left = right - MIN_SIZE
    else right = left + MIN_SIZE
  }
  if (bottom - top < MIN_SIZE) {
    if (handle.includes('n')) top = bottom - MIN_SIZE
    else bottom = top + MIN_SIZE
  }
  if (keepAspect && handle.length === 2 && start.h > 0) {
    const ratio = start.w / start.h
    let w = right - left
    let h = bottom - top
    if (w / ratio > h) h = w / ratio
    else w = h * ratio
    if (handle.includes('w')) left = right - w
    else right = left + w
    if (handle.includes('n')) top = bottom - h
    else bottom = top + h
  }
  const box = { x: left, y: top, w: right - left, h: bottom - top }
  if (!o.free) {
    const edgesX: number[] = []
    const edgesY: number[] = []
    if (handle.includes('e')) edgesX.push(right)
    if (handle.includes('w')) edgesX.push(left)
    if (handle.includes('s')) edgesY.push(bottom)
    if (handle.includes('n')) edgesY.push(top)
    guides.push(...guidesFor('x', edgesX, 0, o.targets.xs, box.y, box.y + box.h, o.origin.x, o.origin.y))
    guides.push(...guidesFor('y', edgesY, 0, o.targets.ys, box.x, box.x + box.w, o.origin.y, o.origin.x))
  }
  return { box, guides }
}

export const HANDLES: Array<{ h: Handle; cx: number; cy: number; cursor: string }> = [
  { h: 'nw', cx: 0, cy: 0, cursor: 'nwse-resize' },
  { h: 'n', cx: 0.5, cy: 0, cursor: 'ns-resize' },
  { h: 'ne', cx: 1, cy: 0, cursor: 'nesw-resize' },
  { h: 'e', cx: 1, cy: 0.5, cursor: 'ew-resize' },
  { h: 'se', cx: 1, cy: 1, cursor: 'nwse-resize' },
  { h: 's', cx: 0.5, cy: 1, cursor: 'ns-resize' },
  { h: 'sw', cx: 0, cy: 1, cursor: 'nesw-resize' },
  { h: 'w', cx: 0, cy: 0.5, cursor: 'ew-resize' },
]
