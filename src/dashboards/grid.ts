/**
 * The dashboard grid's arithmetic (P2-C), pure: no React, DOM or packages; shared-code rules. The React side is
 * src/portal/dashboards/DashboardsPage.tsx (pointer events, step buttons); docs/dev/dashboards.md ("Layout").
 *
 * A layout is a list of items with a rectangle on a grid of `cols` columns and rows of a fixed height (x, y, w, h in
 * cells). The stored layout always has 12 columns. Narrower screens get a layout DERIVED from it (`deriveColumns`):
 * tablets 6 columns, phones one column in reading order; nothing is stored for them.
 *
 *  - `moveItem` / `resizeItem`: put one item at a wanted place (clamped to the grid), push the items it lands on down
 *    (the item being moved always wins), then optionally compact (every item rises as far as it can);
 *  - `stepItem`: the same for the step buttons (relative change, never compacts, never leaves an overlap);
 *  - `dragRect` / `resizeRect`: pointer distance in pixels -> the wanted rectangle, snapped to whole cells.
 */

export interface Rect { x: number; y: number; w: number; h: number }
export interface GridItem extends Rect { id: string }

export const GRID_COLS = 12
export const TABLET_COLS = 6
/** below this width of the grid area the layout is one column; below TABLET_MAX it has TABLET_COLS columns */
export const PHONE_MAX = 640
export const TABLET_MAX = 1024
/** the smallest tile on a tablet grid, in columns of the tablet grid (a 1-column chart is unreadable) */
export const TABLET_MIN_W = 2
export const MAX_ROW = 500
export const MAX_H = 12

export type LayoutMode = 'phone' | 'tablet' | 'desktop'

/** the layout for the width of the grid area in px (0 = not measured yet: the full grid) */
export function layoutModeFor(width: number): LayoutMode {
  if (!(width > 0)) return 'desktop'
  return width < PHONE_MAX ? 'phone' : width < TABLET_MAX ? 'tablet' : 'desktop'
}
export const columnsFor = (mode: LayoutMode): number => (mode === 'tablet' ? TABLET_COLS : GRID_COLS)

const int = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number.isFinite(v) ? v : lo)))

/** a rectangle inside the grid: at least 1 x 1, at most `cols` wide and MAX_H high, not past the right edge, not above row 0 */
export function clampRect(r: Rect, cols = GRID_COLS): Rect {
  const w = int(r.w, 1, cols)
  const h = int(r.h, 1, MAX_H)
  return { x: int(r.x, 0, cols - w), y: int(r.y, 0, MAX_ROW), w, h }
}

export const collides = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** true when two items overlap (a valid layout has none) */
export function hasOverlap(items: GridItem[]): boolean {
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (collides(items[i]!, items[j]!)) return true
  return false
}

/** reading order: top to bottom, then left to right (the phone layout, and the order items are placed in) */
export const readingOrder = <T extends Rect>(items: T[]): T[] => [...items].sort((a, b) => a.y - b.y || a.x - b.x)

/** lowest row at which `r` (its x, w, h) fits among `placed`, starting at row `from` */
function firstFreeRow(r: Rect, placed: Rect[], from: number): number {
  let y = from
  for (;;) {
    const probe = { ...r, y }
    const hit = placed.find((p) => collides(probe, p))
    if (!hit) return y
    y = hit.y + hit.h
  }
}

/**
 * Every item rises as far as it can without overlapping the ones above it (vertical compaction, in reading order).
 * Keeps the order of the list; an item's x, w and h never change.
 */
export function compact<T extends GridItem>(items: T[]): T[] {
  const placed: Rect[] = []
  const out = new Map<string, T>()
  for (const it of readingOrder(items)) {
    const y = firstFreeRow(it, placed, 0)
    const n = { ...it, y }
    placed.push(n)
    out.set(it.id, n)
  }
  return items.map((i) => out.get(i.id)!)
}

/**
 * Puts `id` at `want` (clamped), pushes every item it would overlap down below it (cascading), and compacts when asked.
 * The other items keep their x, w and h. Unknown id: the items unchanged.
 */
export function place<T extends GridItem>(items: T[], id: string, want: Rect, cols = GRID_COLS, doCompact = true): T[] {
  const me = items.find((i) => i.id === id)
  if (!me) return items
  const moved = { ...me, ...clampRect(want, cols) }
  const placed: Rect[] = [moved]
  const out = new Map<string, T>([[id, moved]])
  for (const it of readingOrder(items.filter((i) => i.id !== id))) {
    const r = clampRect(it, cols)
    const y = firstFreeRow(r, placed, r.y)
    const n = { ...it, ...r, y }
    placed.push(n)
    out.set(it.id, n)
  }
  const result = items.map((i) => out.get(i.id)!)
  return doCompact ? compact(result) : result
}

export const moveItem = <T extends GridItem>(items: T[], id: string, to: { x: number; y: number }, cols = GRID_COLS, doCompact = true): T[] => {
  const me = items.find((i) => i.id === id)
  return me ? place(items, id, { ...me, ...to }, cols, doCompact) : items
}
export const resizeItem = <T extends GridItem>(items: T[], id: string, size: { w: number; h: number }, cols = GRID_COLS, doCompact = true): T[] => {
  const me = items.find((i) => i.id === id)
  // growing stops at the right edge; the left edge stays where it is
  return me ? place(items, id, { ...me, w: Math.min(size.w, Math.max(1, cols - me.x)), h: size.h }, cols, doCompact) : items
}

/** the step buttons: a relative change of position and size; neighbours are pushed down, nothing is compacted */
export function stepItem<T extends GridItem>(items: T[], id: string, d: { dx?: number; dy?: number; dw?: number; dh?: number }, cols = GRID_COLS): T[] {
  const me = items.find((i) => i.id === id)
  if (!me) return items
  return place(items, id, { x: me.x + (d.dx ?? 0), y: me.y + (d.dy ?? 0), w: me.w + (d.dw ?? 0), h: me.h + (d.dh ?? 0) }, cols, false)
}

/* ------------------------------------------------------------------ pointer -> cells */

/** pixel size of one column step (column + gap) and one row step */
export function cellSteps(gridWidth: number, cols: number, gap: number, rowPx: number): { col: number; row: number } {
  const colPx = (gridWidth - gap * (cols - 1)) / cols
  return { col: Math.max(1, colPx + gap), row: Math.max(1, rowPx + gap) }
}

/** pixels moved -> whole cells (the nearest) */
export const snapCells = (px: number, step: number): number => Math.round(px / Math.max(1, step))

/** where a tile grabbed at `base` lands after the pointer moved (dx, dy) px */
export function dragRect(base: Rect, dx: number, dy: number, steps: { col: number; row: number }, cols = GRID_COLS): Rect {
  return clampRect({ ...base, x: base.x + snapCells(dx, steps.col), y: base.y + snapCells(dy, steps.row) }, cols)
}
/** the size of a tile whose bottom-right handle moved (dx, dy) px */
export function resizeRect(base: Rect, dx: number, dy: number, steps: { col: number; row: number }, cols = GRID_COLS): Rect {
  return clampRect({ ...base, w: Math.min(Math.max(1, cols - base.x), base.w + snapCells(dx, steps.col)), h: base.h + snapCells(dy, steps.row) }, cols)
}

/* ------------------------------------------------------------------ narrower layouts */

/**
 * The layout of the 12-column grid on `cols` columns (6 for tablets), derived and never stored: the left and right edges
 * scale (rounded; at least TABLET_MIN_W wide so nothing becomes unreadably narrow), heights stay, then the items are
 * placed in reading order, an item that would overlap goes below the one it hits, and everything is compacted. Order is
 * kept: what was left of or above something stays so. With cols = 12 the items are returned unchanged.
 */
export function deriveColumns<T extends GridItem>(items: T[], cols: number): T[] {
  if (cols >= GRID_COLS) return items
  const k = cols / GRID_COLS
  const minW = Math.min(cols, TABLET_MIN_W)
  const placed: Rect[] = []
  const out = new Map<string, T>()
  for (const it of readingOrder(items)) {
    // scale the left and right edges (so neighbours that touched still touch), then enforce the minimum width
    const left = Math.round(it.x * k)
    const w = Math.min(cols, Math.max(minW, Math.round((it.x + it.w) * k) - left))
    const x = Math.min(cols - w, Math.max(0, left))
    const r = { x, y: it.y, w, h: it.h }
    const n = { ...it, ...r, y: firstFreeRow(r, placed, r.y) }
    placed.push(n)
    out.set(it.id, n)
  }
  return compact(items.map((i) => out.get(i.id)!))
}
