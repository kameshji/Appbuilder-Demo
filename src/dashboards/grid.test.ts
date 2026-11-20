/**
 * The dashboard grid's arithmetic (src/dashboards/grid.ts): clamping, collisions, push-down, compaction, pointer
 * snapping, the step buttons and the 6-column tablet layout derived from the 12-column one.
 */
import { describe, expect, it } from 'vitest'
import { productionOverview } from './manufacturing.ts'
import type { GridItem } from './grid.ts'
import {
  GRID_COLS, TABLET_COLS, TABLET_MIN_W, cellSteps, clampRect, collides, columnsFor, compact, deriveColumns, dragRect, hasOverlap, layoutModeFor,
  moveItem, place, readingOrder, resizeItem, resizeRect, snapCells, stepItem,
} from './grid.ts'

const it$ = (id: string, x: number, y: number, w: number, h: number): GridItem => ({ id, x, y, w, h })
const byId = (items: GridItem[], id: string) => items.find((i) => i.id === id)!
const rect = (i: GridItem) => [i.x, i.y, i.w, i.h]

describe('modes', () => {
  it('phone below 640, tablet below 1024, else the full grid; unmeasured is the full grid', () => {
    expect(layoutModeFor(0)).toBe('desktop')
    expect(layoutModeFor(639)).toBe('phone')
    expect(layoutModeFor(640)).toBe('tablet')
    expect(layoutModeFor(1023)).toBe('tablet')
    expect(layoutModeFor(1024)).toBe('desktop')
    expect(columnsFor('tablet')).toBe(TABLET_COLS)
    expect(columnsFor('desktop')).toBe(GRID_COLS)
  })
})

describe('clamp and collide', () => {
  it('keeps a rectangle inside the grid', () => {
    expect(clampRect({ x: 10, y: -3, w: 4, h: 0 })).toEqual({ x: 8, y: 0, w: 4, h: 1 })
    expect(clampRect({ x: 0, y: 0, w: 99, h: 99 })).toEqual({ x: 0, y: 0, w: 12, h: 12 })
    expect(clampRect({ x: 5, y: 0, w: 4, h: 2 }, 6)).toEqual({ x: 2, y: 0, w: 4, h: 2 })
    expect(clampRect({ x: NaN, y: 2.6, w: 2.4, h: 1 })).toEqual({ x: 0, y: 3, w: 2, h: 1 })
  })
  it('rectangles that only touch do not collide', () => {
    expect(collides({ x: 0, y: 0, w: 4, h: 2 }, { x: 4, y: 0, w: 4, h: 2 })).toBe(false)
    expect(collides({ x: 0, y: 0, w: 4, h: 2 }, { x: 0, y: 2, w: 4, h: 2 })).toBe(false)
    expect(collides({ x: 0, y: 0, w: 4, h: 2 }, { x: 3, y: 1, w: 4, h: 2 })).toBe(true)
    expect(hasOverlap([it$('a', 0, 0, 4, 2), it$('b', 4, 0, 4, 2)])).toBe(false)
  })
})

describe('compaction', () => {
  it('lifts every item as far as it can, keeping x, w, h', () => {
    const out = compact([it$('a', 0, 3, 4, 2), it$('b', 4, 7, 4, 2), it$('c', 0, 9, 4, 2)])
    expect(out.map(rect)).toEqual([[0, 0, 4, 2], [4, 0, 4, 2], [0, 2, 4, 2]])
  })
  it('does not pass through an item above', () => {
    const out = compact([it$('a', 0, 0, 12, 2), it$('b', 0, 5, 4, 2)])
    expect(rect(byId(out, 'b'))).toEqual([0, 2, 4, 2])
  })
  it('an already compact layout is unchanged', () => {
    const l = [it$('a', 0, 0, 6, 3), it$('b', 6, 0, 6, 3), it$('c', 0, 3, 12, 2)]
    expect(compact(l)).toEqual(l)
  })
})

describe('moving', () => {
  const l = [it$('a', 0, 0, 4, 2), it$('b', 4, 0, 4, 2), it$('c', 8, 0, 4, 2), it$('d', 0, 2, 12, 2)]
  it('moves to the wanted cell and pushes the item it lands on down (the moved one wins)', () => {
    const out = moveItem(l, 'a', { x: 4, y: 0 }, GRID_COLS, false)
    expect(rect(byId(out, 'a'))).toEqual([4, 0, 4, 2])
    expect(byId(out, 'b').y).toBe(2) // pushed below a
    expect(byId(out, 'd').y).toBeGreaterThanOrEqual(4) // and d below b (cascade)
    expect(hasOverlap(out)).toBe(false)
  })
  it('clamps to the grid', () => {
    const out = moveItem(l, 'c', { x: 20, y: -4 }, GRID_COLS, false)
    expect(rect(byId(out, 'c'))).toEqual([8, 0, 4, 2])
    expect(moveItem(l, 'c', { x: 1, y: 0 }, GRID_COLS, false).find((i) => i.id === 'c')!.x).toBe(1)
  })
  it('compaction closes the gap left behind', () => {
    const out = moveItem(l, 'd', { x: 0, y: 8 }, GRID_COLS, true)
    expect(rect(byId(out, 'd'))).toEqual([0, 2, 12, 2]) // dropped far below, floats up under a, b, c
    expect(hasOverlap(out)).toBe(false)
  })
  it('an unknown id changes nothing; the other items keep x, w, h', () => {
    expect(moveItem(l, 'zz', { x: 1, y: 1 })).toBe(l)
    const out = moveItem(l, 'a', { x: 8, y: 0 })
    for (const id of ['b', 'c', 'd']) expect([byId(out, id).x, byId(out, id).w, byId(out, id).h]).toEqual([byId(l, id).x, byId(l, id).w, byId(l, id).h])
  })
  it('never leaves an overlap, whatever is dropped where (every cell)', () => {
    for (let x = 0; x < 12; x++) for (let y = 0; y < 6; y++) for (const id of ['a', 'b', 'c', 'd']) {
      expect(hasOverlap(moveItem(l, id, { x, y })), `${id} -> ${x},${y}`).toBe(false)
      expect(hasOverlap(moveItem(l, id, { x, y }, GRID_COLS, false)), `${id} -> ${x},${y} (no compaction)`).toBe(false)
    }
  })
})

describe('resizing', () => {
  const l = [it$('a', 0, 0, 4, 2), it$('b', 4, 0, 4, 2), it$('c', 0, 2, 8, 2)]
  it('growing pushes neighbours down', () => {
    const out = resizeItem(l, 'a', { w: 8, h: 3 }, GRID_COLS, false)
    expect(rect(byId(out, 'a'))).toEqual([0, 0, 8, 3])
    expect(byId(out, 'b').y).toBe(3)
    expect(hasOverlap(out)).toBe(false)
  })
  it('growing stops at the right edge (the left edge stays), at least 1 x 1, at most 12 rows', () => {
    expect(rect(byId(resizeItem(l, 'b', { w: 50, h: 50 }, GRID_COLS, false), 'b'))).toEqual([4, 0, 8, 12])
    expect(rect(byId(resizeItem(l, 'a', { w: -3, h: 0 }), 'a'))).toEqual([0, 0, 1, 1])
  })
  it('shrinking then compacting pulls the items below up', () => {
    const out = resizeItem([it$('a', 0, 0, 4, 3), it$('c', 0, 3, 4, 2)], 'a', { w: 4, h: 1 })
    expect(byId(out, 'c').y).toBe(1)
  })
})

describe('step buttons', () => {
  const l = [it$('a', 0, 0, 4, 2), it$('b', 4, 0, 4, 2)]
  it('move and resize by one, never overlapping, never compacting', () => {
    expect(rect(byId(stepItem(l, 'a', { dx: 1 }), 'a'))).toEqual([1, 0, 4, 2])
    const right = stepItem(l, 'a', { dx: 4 })
    expect(rect(byId(right, 'a'))).toEqual([4, 0, 4, 2])
    expect(byId(right, 'b').y).toBe(2)
    expect(rect(byId(stepItem(l, 'b', { dx: 9, dw: 9 }), 'b'))).toEqual([0, 0, 12, 2])
    expect(byId(stepItem([it$('a', 0, 0, 4, 2), it$('z', 0, 6, 4, 2)], 'a', { dy: 1 }), 'z').y).toBe(6) // z is not pulled up
    expect(stepItem(l, 'a', { dw: -9 }).find((i) => i.id === 'a')!.w).toBe(1)
  })
})

describe('pointer to cells', () => {
  const steps = cellSteps(1092, 12, 12, 80) // 12 columns of 80 px and 11 gaps of 12 px
  it('step sizes', () => {
    expect(steps).toEqual({ col: 92, row: 92 })
    expect(cellSteps(0, 12, 12, 80).col).toBe(1)
  })
  it('snaps to the nearest cell', () => {
    expect(snapCells(45, 92)).toBe(0)
    expect(snapCells(47, 92)).toBe(1)
    expect(snapCells(-100, 92)).toBe(-1)
    expect(snapCells(10, 0)).toBe(10)
  })
  it('drag and resize rectangles are clamped', () => {
    const base = { x: 2, y: 1, w: 4, h: 2 }
    expect(dragRect(base, 184, 92, steps)).toEqual({ x: 4, y: 2, w: 4, h: 2 })
    expect(dragRect(base, -999, -999, steps)).toEqual({ x: 0, y: 0, w: 4, h: 2 })
    expect(dragRect(base, 9999, 0, steps)).toEqual({ x: 8, y: 1, w: 4, h: 2 })
    expect(resizeRect(base, 92 * 2, 92, steps)).toEqual({ x: 2, y: 1, w: 6, h: 3 })
    expect(resizeRect(base, -9999, -9999, steps)).toEqual({ x: 2, y: 1, w: 1, h: 1 })
    expect(resizeRect(base, 9999, 0, steps)).toEqual({ x: 2, y: 1, w: 10, h: 2 })
  })
})

describe('the tablet layout', () => {
  it('twelve columns are returned as they are', () => {
    const l = [it$('a', 0, 0, 4, 2)]
    expect(deriveColumns(l, 12)).toBe(l)
  })
  it('halves widths and positions, keeps heights and order', () => {
    const l = [it$('a', 0, 0, 4, 2), it$('b', 4, 0, 4, 2), it$('c', 8, 0, 4, 2), it$('d', 0, 2, 12, 3)]
    const out = deriveColumns(l, 6)
    expect(out.map(rect)).toEqual([[0, 0, 2, 2], [2, 0, 2, 2], [4, 0, 2, 2], [0, 2, 6, 3]])
  })
  it('a narrow tile is widened to the minimum; what no longer fits goes below, nothing overlaps', () => {
    const l = [it$('a', 0, 0, 1, 2), it$('b', 1, 0, 1, 2), it$('c', 2, 0, 1, 2), it$('d', 3, 0, 1, 2), it$('e', 4, 0, 8, 2)]
    const out = deriveColumns(l, 6)
    for (const i of out) expect(i.w).toBeGreaterThanOrEqual(TABLET_MIN_W)
    expect(hasOverlap(out)).toBe(false)
    expect(out.every((i) => i.x >= 0 && i.x + i.w <= 6)).toBe(true)
  })
  it('odd widths and positions stay inside six columns without overlapping (every x and w)', () => {
    for (let w = 1; w <= 12; w++) for (let x = 0; x + w <= 12; x++) {
      const out = deriveColumns([it$('a', x, 0, w, 2), it$('b', Math.min(11, x + w) % 12, 1, 3, 3), it$('c', 0, 4, w, 1)], 6)
      expect(hasOverlap(out), `x ${x} w ${w}`).toBe(false)
      expect(out.every((i) => i.w >= TABLET_MIN_W && i.x >= 0 && i.x + i.w <= 6)).toBe(true)
    }
  })
  it('the production overview template: six columns, no overlap, no tile under the minimum', () => {
    const items = productionOverview().tiles.map((t) => ({ id: t.id, ...t.layout }))
    const out = deriveColumns(items, 6)
    expect(out).toHaveLength(items.length)
    expect(hasOverlap(out)).toBe(false)
    for (const i of out) { expect(i.w).toBeGreaterThanOrEqual(TABLET_MIN_W); expect(i.x + i.w).toBeLessThanOrEqual(6) }
    // reading order is kept: a tile that started above another still starts above or level with it
    const rows = (l: GridItem[]) => readingOrder(l).map((i) => i.id)
    expect(rows(out).slice(0, 2)).toEqual(rows(items).slice(0, 2))
  })
  it('place() on the derived layout keeps it overlap-free', () => {
    const out = place(deriveColumns([it$('a', 0, 0, 6, 2), it$('b', 6, 0, 6, 2)], 6), 'b', { x: 0, y: 0, w: 3, h: 2 }, 6)
    expect(hasOverlap(out)).toBe(false)
  })
})
