/**
 * Signature pad maths (docs/dev/phone.md "Signature pad"): pure, tested in phone.test.ts. The canvas component is
 * SignatureCanvas.tsx; the UI component SignaturePad and the Form's signature fields use it.
 *
 *  - Points are kept in pad units: x and y from 0 to 1 of the drawing area (so a resize or a rotation redraws the same
 *    signature), plus a time in ms.
 *  - A stroke is simplified when it ends (Ramer-Douglas-Peucker, tolerance in CSS px) and drawn smoothed: quadratic
 *    curves through the midpoints of its points.
 *  - The pad has a fixed 3:1 aspect (a signature line), letterboxed into the UI component's box.
 *  - The export is a PNG of the whole pad on white (opaque: prints and shows the same everywhere), scaled to fit
 *    EXPORT_MAX_W x EXPORT_MAX_H (1200 x 400), never upscaled more than 3x and never under EXPORT_MIN_W wide.
 *  - "Signed" needs some ink: strokes that are together at least MIN_INK_PX long (a stray tap is not a signature).
 */
export interface SigPoint { x: number; y: number; t: number }
export type Stroke = SigPoint[]

export const PAD_ASPECT = 3
export const EXPORT_MAX_W = 1200
export const EXPORT_MAX_H = 400
export const EXPORT_MIN_W = 300
export const MIN_INK_PX = 12
export const SIMPLIFY_PX = 0.6

/** the largest PAD_ASPECT:1 rectangle inside a box (centred), in px */
export function padRect(boxW: number, boxH: number, aspect = PAD_ASPECT): { x: number; y: number; w: number; h: number } {
  const bw = Math.max(0, boxW)
  const bh = Math.max(0, boxH)
  let w = bw
  let h = w / aspect
  if (h > bh) {
    h = bh
    w = h * aspect
  }
  return { x: (bw - w) / 2, y: (bh - h) / 2, w, h }
}

function segDist(p: SigPoint, a: SigPoint, b: SigPoint, sx: number, sy: number): number {
  const ax = a.x * sx, ay = a.y * sy, bx = b.x * sx, by = b.y * sy, px = p.x * sx, py = p.y * sy
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - ax, py - ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Ramer-Douglas-Peucker over a stroke in pad units; `tolerance` in px of a w x h pad. Keeps the first and last point. */
export function simplify(points: Stroke, w: number, h: number, tolerance = SIMPLIFY_PX): Stroke {
  if (points.length <= 2) return points.slice()
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: Array<[number, number]> = [[0, points.length - 1]]
  while (stack.length) {
    const [s, e] = stack.pop()!
    let max = -1
    let at = -1
    for (let i = s + 1; i < e; i++) {
      const d = segDist(points[i]!, points[s]!, points[e]!, w, h)
      if (d > max) {
        max = d
        at = i
      }
    }
    if (at > 0 && max > tolerance) {
      keep[at] = 1
      stack.push([s, at], [at, e])
    }
  }
  return points.filter((_, i) => keep[i] === 1)
}

/** drawing commands of a smoothed stroke in px: move, then quadratic curves through the midpoints (a dot for one point) */
export type PathCmd = { t: 'M'; x: number; y: number } | { t: 'Q'; cx: number; cy: number; x: number; y: number } | { t: 'L'; x: number; y: number } | { t: 'dot'; x: number; y: number }
export function strokePath(points: Stroke, w: number, h: number, ox = 0, oy = 0): PathCmd[] {
  const P = points.map((p) => ({ x: ox + p.x * w, y: oy + p.y * h }))
  if (P.length === 0) return []
  if (P.length === 1) return [{ t: 'dot', x: P[0]!.x, y: P[0]!.y }]
  if (P.length === 2) return [{ t: 'M', x: P[0]!.x, y: P[0]!.y }, { t: 'L', x: P[1]!.x, y: P[1]!.y }]
  const out: PathCmd[] = [{ t: 'M', x: P[0]!.x, y: P[0]!.y }]
  for (let i = 1; i < P.length - 1; i++) {
    const c = P[i]!
    const n = P[i + 1]!
    out.push({ t: 'Q', cx: c.x, cy: c.y, x: (c.x + n.x) / 2, y: (c.y + n.y) / 2 })
  }
  const last = P[P.length - 1]!
  out.push({ t: 'L', x: last.x, y: last.y })
  return out
}

/** total ink length in px of a w x h pad (a single-point stroke counts as 1 px) */
export function inkLength(strokes: Stroke[], w: number, h: number): number {
  let total = 0
  for (const s of strokes) {
    if (s.length === 1) total += 1
    for (let i = 1; i < s.length; i++) total += Math.hypot((s[i]!.x - s[i - 1]!.x) * w, (s[i]!.y - s[i - 1]!.y) * h)
  }
  return total
}

export const hasSignature = (strokes: Stroke[], w: number, h: number) => inkLength(strokes, w, h) >= MIN_INK_PX

/** bounding box of the ink in pad units, or null when empty */
export function strokeBounds(strokes: Stroke[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of strokes) for (const p of s) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY }
}

/** pixel size of the exported PNG for a pad of w x h CSS px (bounded; keeps the aspect) */
export function exportSize(w: number, h: number): { w: number; h: number; scale: number } {
  if (!(w > 0) || !(h > 0)) return { w: EXPORT_MIN_W, h: Math.round(EXPORT_MIN_W / PAD_ASPECT), scale: 1 }
  let scale = Math.min(EXPORT_MAX_W / w, EXPORT_MAX_H / h, 3)
  if (w * scale < EXPORT_MIN_W) scale = Math.min(EXPORT_MIN_W / w, EXPORT_MAX_W / w, EXPORT_MAX_H / h)
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)), scale }
}

/** a pointer position (client px) -> pad units, clamped to the pad */
export function toPad(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, t: number): SigPoint {
  const x = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
  const y = rect.height > 0 ? (clientY - rect.top) / rect.height : 0
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)), t }
}

/** line width in px for a pad of width w (the pen keeps its look when the pad is wider or narrower than 360 px) */
export function penWidthFor(base: number, w: number): number {
  const b = Number.isFinite(base) && base > 0 ? Math.min(base, 12) : 2.5
  return Math.max(1, b * Math.max(0.6, Math.min(2.5, w / 360)))
}
