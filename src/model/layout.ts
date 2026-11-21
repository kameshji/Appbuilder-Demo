/**
 * Diagram geometry and automatic layout (pure). Cards have a fixed width and a height from their column count; the
 * auto-layout is layered (a small Sugiyama): parents in the left layers, their children to the right, the order inside
 * each layer by the barycentre of the neighbours (a few sweeps), unconnected tables in a grid below.
 */
import type { Model, ModelLayout, ModelTable } from './types.ts'
import { tableByName } from './ops.ts'

export const CARD_W = 240
export const HEADER_H = 34
export const ROW_H = 22
export const CARD_PAD = 6
export const GAP_X = 120
export const GAP_Y = 36

export interface CardOptions {
  /** show only key columns (display column, lookups, unique) */
  keysOnly?: boolean
}

/** the columns a card shows, in order: display column first, then lookups and the others; system columns hidden (except id when nothing else) */
export function cardColumns(t: ModelTable, o: CardOptions = {}) {
  const user = t.columns.filter((c) => !c.system && !['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner'].includes(c.name))
  const display = user.find((c) => c.name === t.primaryColumn)
  const rest = user.filter((c) => c !== display)
  const ordered = [...(display ? [display] : []), ...rest]
  if (!o.keysOnly) return ordered
  return ordered.filter((c) => c === display || c.type === 'lookup' || c.unique)
}

export function cardHeight(t: ModelTable, o: CardOptions = {}): number {
  return HEADER_H + Math.max(1, cardColumns(t, o).length) * ROW_H + CARD_PAD * 2
}

/** y of a column's row centre, relative to the card top (the header when the column is not shown) */
export function rowCenter(t: ModelTable, column: string, o: CardOptions = {}): number {
  const i = cardColumns(t, o).findIndex((c) => c.name === column)
  if (i < 0) return HEADER_H / 2
  return HEADER_H + CARD_PAD + i * ROW_H + ROW_H / 2
}

export interface Box { x: number; y: number; w: number; h: number }
export function boxOf(t: ModelTable, layout: ModelLayout, o: CardOptions = {}): Box {
  const p = layout.positions[t.id] ?? { x: 0, y: 0 }
  return { x: p.x, y: p.y, w: CARD_W, h: cardHeight(t, o) }
}

export function bounds(boxes: Box[], pad = 40): Box {
  if (!boxes.length) return { x: 0, y: 0, w: 800, h: 600 }
  const x0 = Math.min(...boxes.map((b) => b.x)) - pad
  const y0 = Math.min(...boxes.map((b) => b.y)) - pad
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + pad
  const y1 = Math.max(...boxes.map((b) => b.y + b.h)) + pad
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** parent ids of each table (lookup targets), self references and unknown targets left out */
export function parentsOf(m: Model): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const t of m.tables) {
    const ps: string[] = []
    for (const c of t.columns) {
      if (c.type !== 'lookup') continue
      const p = tableByName(m, c.lookupTable)
      if (p && p.id !== t.id && !ps.includes(p.id)) ps.push(p.id)
    }
    out.set(t.id, ps)
  }
  return out
}

/**
 * Layered layout of the given tables (all of the model when `ids` is absent). Deterministic for a given model.
 * Returns positions for those tables only.
 */
export function autoLayout(m: Model, o: CardOptions & { ids?: string[]; origin?: { x: number; y: number } } = {}): Record<string, { x: number; y: number }> {
  const ids = new Set(o.ids ?? m.tables.map((t) => t.id))
  const tables = m.tables.filter((t) => ids.has(t.id))
  const parents = parentsOf(m)
  const par = (id: string) => (parents.get(id) ?? []).filter((p) => ids.has(p))
  const children = new Map<string, string[]>()
  for (const t of tables) for (const p of par(t.id)) children.set(p, [...(children.get(p) ?? []), t.id])
  const connected = tables.filter((t) => par(t.id).length || children.get(t.id)?.length)
  const loose = tables.filter((t) => !connected.includes(t))

  // layers: longest path from the roots, cycles broken by the DFS order
  const layer = new Map<string, number>()
  const onStack = new Set<string>()
  const depth = (id: string): number => {
    if (layer.has(id)) return layer.get(id)!
    if (onStack.has(id)) return 0
    onStack.add(id)
    let d = 0
    for (const p of par(id)) d = Math.max(d, depth(p) + 1)
    onStack.delete(id)
    layer.set(id, d)
    return d
  }
  const byName = [...connected].sort((a, b) => a.name.localeCompare(b.name))
  for (const t of byName) depth(t.id)
  const layers: string[][] = []
  for (const t of byName) {
    const l = layer.get(t.id)!
    ;(layers[l] ??= []).push(t.id)
  }
  // order inside layers: barycentre sweeps (down then up)
  const pos = (id: string, l: number) => layers[l]?.indexOf(id) ?? -1
  const neighbours = (id: string) => [...par(id), ...(children.get(id) ?? [])]
  for (let sweep = 0; sweep < 6; sweep++) {
    const order = sweep % 2 === 0 ? layers.map((_, i) => i) : layers.map((_, i) => layers.length - 1 - i)
    for (const l of order) {
      const L = layers[l]
      if (!L) continue
      const score = new Map<string, number>()
      for (const id of L) {
        const ns = neighbours(id).map((n) => ({ n, l: layer.get(n) ?? -1 })).filter((x) => x.l !== l && x.l >= 0)
        score.set(id, ns.length ? ns.reduce((s, x) => s + pos(x.n, x.l) / Math.max(1, layers[x.l].length), 0) / ns.length : pos(id, l) / Math.max(1, L.length))
      }
      L.sort((a, b) => score.get(a)! - score.get(b)! || a.localeCompare(b))
    }
  }
  const height = (id: string) => {
    const t = m.tables.find((x) => x.id === id)!
    return cardHeight(t, o)
  }
  const ox = o.origin?.x ?? 0
  const oy = o.origin?.y ?? 0
  const out: Record<string, { x: number; y: number }> = {}
  // Array.from, not map: a cycle of lookups can leave a layer empty (a hole), and map keeps holes, which Math.max reads
  // as undefined and every y became NaN
  const colHeights = Array.from(layers, (L) => (L ?? []).reduce((s, id) => s + height(id) + GAP_Y, -GAP_Y))
  const tallest = Math.max(0, ...colHeights)
  layers.forEach((L, l) => {
    let y = oy + Math.max(0, (tallest - colHeights[l]) / 2)
    for (const id of L ?? []) {
      out[id] = { x: ox + l * (CARD_W + GAP_X), y: Math.round(y) }
      y += height(id) + GAP_Y
    }
  })
  // unconnected tables: a grid under the layered part
  const cols = Math.max(3, layers.length || 4)
  let gy = oy + (connected.length ? tallest + GAP_Y * 3 : 0)
  for (let i = 0; i < loose.length; i += cols) {
    const row = loose.slice(i, i + cols).sort((a, b) => a.name.localeCompare(b.name))
    row.forEach((t, j) => { out[t.id] = { x: ox + j * (CARD_W + GAP_X / 2), y: gy } })
    gy += Math.max(...row.map((t) => height(t.id))) + GAP_Y
  }
  return out
}

/** positions for tables that have none yet (to the right of what is placed), keeping the others */
export function placeMissing(m: Model, layout: ModelLayout, o: CardOptions = {}): ModelLayout {
  const missing = m.tables.filter((t) => !layout.positions[t.id]).map((t) => t.id)
  if (!missing.length) return layout
  const placed = m.tables.filter((t) => layout.positions[t.id]).map((t) => boxOf(t, layout, o))
  const origin = placed.length ? { x: Math.max(...placed.map((b) => b.x + b.w)) + GAP_X, y: Math.min(...placed.map((b) => b.y)) } : { x: 0, y: 0 }
  return { ...layout, positions: { ...layout.positions, ...autoLayout(m, { ...o, ids: missing, origin }) } }
}

/** the box around an area's tables */
export function areaBox(m: Model, layout: ModelLayout, tableIds: string[], o: CardOptions = {}): Box | null {
  const boxes = m.tables.filter((t) => tableIds.includes(t.id) && layout.positions[t.id]).map((t) => boxOf(t, layout, o))
  if (!boxes.length) return null
  const b = bounds(boxes, 18)
  return { ...b, y: b.y - 16, h: b.h + 16 }
}

/**
 * The path of a relationship line from a child's lookup row to the parent's header, as SVG path data with the end
 * points and the side each end leaves from (for the crow's-foot marks).
 */
export function relationshipPath(child: Box, childRowY: number, parent: Box, self: boolean): { d: string; from: { x: number; y: number; dir: 1 | -1 }; to: { x: number; y: number; dir: 1 | -1 } } {
  const cy = child.y + childRowY
  const py = parent.y + HEADER_H / 2
  if (self) {
    const x = child.x + child.w
    const from = { x, y: cy, dir: 1 as const }
    const to = { x, y: py, dir: 1 as const }
    return { d: `M ${x} ${cy} C ${x + 70} ${cy}, ${x + 70} ${py}, ${x} ${py}`, from, to }
  }
  const childLeftOfParent = child.x + child.w / 2 < parent.x + parent.w / 2
  const fx = childLeftOfParent ? child.x + child.w : child.x
  const tx = childLeftOfParent ? parent.x : parent.x + parent.w
  const fdir = childLeftOfParent ? 1 : -1
  const tdir = childLeftOfParent ? -1 : 1
  const bend = Math.max(40, Math.abs(tx - fx) / 2)
  const d = `M ${fx} ${cy} C ${fx + fdir * bend} ${cy}, ${tx + tdir * bend} ${py}, ${tx} ${py}`
  return { d, from: { x: fx, y: cy, dir: fdir }, to: { x: tx, y: py, dir: tdir } }
}

/**
 * Auto-layout that keeps areas apart: each area's tables are laid out as one block (layered inside), blocks are stacked
 * top to bottom in area order, then the tables in no area. Relationships between blocks are not used for placement.
 */
export function autoLayoutByArea(m: Model, layout: ModelLayout, o: CardOptions & { ids?: string[] } = {}): Record<string, { x: number; y: number }> {
  const ids = new Set(o.ids ?? m.tables.map((t) => t.id))
  const seen = new Set<string>()
  const blocks: string[][] = []
  for (const a of layout.areas) {
    const members = a.tables.filter((t) => ids.has(t) && !seen.has(t) && m.tables.some((x) => x.id === t))
    members.forEach((t) => seen.add(t))
    if (members.length) blocks.push(members)
  }
  const rest = [...ids].filter((t) => !seen.has(t))
  if (rest.length) blocks.push(rest)
  const out: Record<string, { x: number; y: number }> = {}
  let y = 0
  for (const b of blocks) {
    const pos = autoLayout(m, { ...o, ids: b, origin: { x: 0, y } })
    Object.assign(out, pos)
    const bottom = Math.max(...b.map((id) => (pos[id]?.y ?? y) + cardHeight(m.tables.find((t) => t.id === id)!, o)))
    y = bottom + GAP_Y * 3
  }
  return out
}
