/**
 * Geometry of the designer canvas (pure): a top-down flow. The trigger card on top, step cards below with "+" insertion
 * points between any two steps, containers as regions that hold their lanes side by side (a condition's "If yes" and "If
 * no", a switch's cases, the body of a loop or scope), an end marker. Collapsed containers are a single card. Run-after
 * settings that are not "after the previous step succeeded" are drawn as separate, labelled connectors.
 */
import type { Step } from '@/platform/flows'
import { listsOf, type Slot, TOP } from './model'

export const CARD_W = 264
export const CARD_H = 60
export const GAP = 44
export const LANE_GAP = 28
export const PAD = 16
export const LANE_HEAD = 30
export const TRIGGER_H = 64

export interface Box { x: number; y: number; w: number; h: number }
export interface CardNode extends Box { kind: 'card'; id: string; step: Step; depth: number; collapsed: boolean; inner: number }
export interface TriggerNode extends Box { kind: 'trigger' }
export interface RegionNode extends Box { kind: 'region'; id: string; step: Step; depth: number }
export interface InsertNode { kind: 'insert'; x: number; y: number; slot: Slot; index: number; /** a placeholder in an empty lane */ empty: boolean }
export interface LaneLabel { kind: 'lane'; x: number; y: number; w: number; label: string; slot: Slot; tone: 'yes' | 'no' | 'plain' }
export interface EndNode { kind: 'end'; x: number; y: number }
export interface Edge { d: string; kind: 'seq' | 'branch' | 'merge'; tone?: 'yes' | 'no' }
export interface RunAfterEdge { d: string; from: string; to: string; label: string; failed: boolean; lx: number; ly: number }

export interface Layout {
  cards: CardNode[]
  regions: RegionNode[]
  inserts: InsertNode[]
  lanes: LaneLabel[]
  edges: Edge[]
  runAfter: RunAfterEdge[]
  trigger: TriggerNode
  end: EndNode
  bounds: Box
  /** card box by step id */
  byId: Map<string, Box>
}

interface Size { w: number; h: number }

function countInner(s: Step): number {
  let n = 0
  for (const l of listsOf(s)) for (const c of l.steps) n += 1 + countInner(c)
  return n
}

export function layoutFlow(steps: Step[], collapsed: Set<string>): Layout {
  const sizes = new Map<string, Size>()
  const laneSizes = new Map<string, Size>()
  const laneKey = (slot: Slot) => `${slot.parent}|${slot.list}`

  const measureLane = (slot: Slot, items: Step[]): Size => {
    let w = CARD_W
    let h = GAP
    for (const s of items) {
      const z = measure(s)
      w = Math.max(w, z.w)
      h += z.h + GAP
    }
    if (!items.length) h = GAP + 36
    const z = { w, h }
    laneSizes.set(laneKey(slot), z)
    return z
  }
  const measure = (s: Step): Size => {
    const lists = listsOf(s)
    let z: Size
    if (!lists.length || collapsed.has(s.id)) z = { w: CARD_W, h: CARD_H }
    else {
      const ls = lists.map((l) => measureLane({ parent: s.id, list: l.key }, l.steps))
      const lanesW = ls.reduce((a, b) => a + b.w, 0) + LANE_GAP * (ls.length - 1)
      const w = Math.max(CARD_W, lanesW) + PAD * 2
      const h = PAD + CARD_H + 18 + LANE_HEAD + Math.max(...ls.map((x) => x.h)) + PAD
      z = { w, h }
    }
    sizes.set(s.id, z)
    return z
  }
  const root = measureLane(TOP, steps)

  const L: Layout = { cards: [], regions: [], inserts: [], lanes: [], edges: [], runAfter: [], trigger: { kind: 'trigger', x: 0, y: 0, w: CARD_W, h: TRIGGER_H }, end: { kind: 'end', x: 0, y: 0 }, bounds: { x: 0, y: 0, w: 0, h: 0 }, byId: new Map() }
  const line = (x1: number, y1: number, x2: number, y2: number, kind: Edge['kind'] = 'seq', tone?: Edge['tone']) => L.edges.push({ d: `M ${x1} ${y1} L ${x2} ${y2}`, kind, ...(tone ? { tone } : {}) })

  /** places a lane centred on cx from y; returns the y where it ends (bottom of the last gap) */
  const placeLane = (slot: Slot, items: Step[], cx: number, y: number, depth: number): number => {
    let cy = y
    if (!items.length) {
      L.inserts.push({ kind: 'insert', x: cx, y: cy + GAP / 2 + 10, slot, index: 0, empty: true })
      line(cx, cy, cx, cy + GAP + 36)
      return cy + GAP + 36
    }
    items.forEach((s, i) => {
      L.inserts.push({ kind: 'insert', x: cx, y: cy + GAP / 2, slot, index: i, empty: false })
      line(cx, cy, cx, cy + GAP)
      cy += GAP
      cy = placeStep(s, cx, cy, depth)
    })
    L.inserts.push({ kind: 'insert', x: cx, y: cy + GAP / 2, slot, index: items.length, empty: false })
    line(cx, cy, cx, cy + GAP)
    return cy + GAP
  }

  /** places a step with its top at y; returns its bottom */
  const placeStep = (s: Step, cx: number, y: number, depth: number): number => {
    const z = sizes.get(s.id)!
    const lists = listsOf(s)
    const isCollapsed = collapsed.has(s.id)
    if (!lists.length || isCollapsed) {
      const card: CardNode = { kind: 'card', id: s.id, step: s, depth, collapsed: isCollapsed && lists.length > 0, inner: countInner(s), x: cx - CARD_W / 2, y, w: CARD_W, h: CARD_H }
      L.cards.push(card)
      L.byId.set(s.id, card)
      return y + CARD_H
    }
    L.regions.push({ kind: 'region', id: s.id, step: s, depth, x: cx - z.w / 2, y, w: z.w, h: z.h })
    const card: CardNode = { kind: 'card', id: s.id, step: s, depth, collapsed: false, inner: countInner(s), x: cx - CARD_W / 2, y: y + PAD, w: CARD_W, h: CARD_H }
    L.cards.push(card)
    L.byId.set(s.id, card)
    const ls = lists.map((l) => ({ l, z: laneSizes.get(laneKey({ parent: s.id, list: l.key }))! }))
    const total = ls.reduce((a, b) => a + b.z.w, 0) + LANE_GAP * (ls.length - 1)
    let lx = cx - total / 2
    const top = y + PAD + CARD_H + 18
    const bottom = y + z.h - PAD
    const fork = y + PAD + CARD_H
    for (const { l, z: lz } of ls) {
      const lcx = lx + lz.w / 2
      const tone: LaneLabel['tone'] = l.key === 'then' ? 'yes' : l.key === 'else' ? 'no' : 'plain'
      L.lanes.push({ kind: 'lane', x: lx, y: top, w: lz.w, label: l.label, slot: { parent: s.id, list: l.key }, tone })
      // fork from the card, down to the lane, and the lane's end down to the region's bottom (merge)
      L.edges.push({ d: `M ${cx} ${fork} L ${cx} ${fork + 9} L ${lcx} ${fork + 9} L ${lcx} ${top + LANE_HEAD}`, kind: 'branch', ...(tone !== 'plain' ? { tone } : {}) })
      const end = placeLane({ parent: s.id, list: l.key }, l.steps, lcx, top + LANE_HEAD, depth + 1)
      L.edges.push({ d: `M ${lcx} ${end} L ${lcx} ${bottom - 6} L ${cx} ${bottom - 6} L ${cx} ${bottom}`, kind: 'merge' })
      lx += lz.w + LANE_GAP
    }
    return y + z.h
  }

  const cx = Math.max(root.w, CARD_W) / 2 + 40
  L.trigger = { kind: 'trigger', x: cx - CARD_W / 2, y: 20, w: CARD_W, h: TRIGGER_H }
  const endY = placeLane(TOP, steps, cx, 20 + TRIGGER_H, 0)
  L.end = { kind: 'end', x: cx, y: endY + 12 }

  // run after: one connector per entry that is not "the previous sibling succeeded"
  const visit = (list: Step[]) => {
    list.forEach((s, i) => {
      for (const r of s.runAfter ?? []) {
        const prev = list[i - 1]
        const plain = prev && r.step === prev.id && r.when.length === 1 && r.when[0] === 'succeeded'
        if (plain) continue
        const a = L.byId.get(r.step)
        const b = L.byId.get(s.id)
        if (!a || !b) continue
        const x1 = a.x + a.w
        const y1 = a.y + a.h / 2
        const x2 = b.x + b.w
        const y2 = b.y + b.h / 2
        const bend = Math.max(x1, x2) + 46 + (i % 3) * 10
        const label = r.when.map((w) => (w === 'timedOut' ? 'timed out' : w)).join(', ')
        L.runAfter.push({ d: `M ${x1} ${y1} C ${bend} ${y1}, ${bend} ${y2}, ${x2 + 6} ${y2}`, from: r.step, to: s.id, label, failed: r.when.some((w) => w !== 'succeeded'), lx: bend - 8, ly: (y1 + y2) / 2 })
      }
      for (const l of listsOf(s)) if (!collapsed.has(s.id)) visit(l.steps)
    })
  }
  visit(steps)

  const w = Math.max(root.w, CARD_W) + 80 + 120
  L.bounds = { x: 0, y: 0, w, h: endY + 60 }
  return L
}
