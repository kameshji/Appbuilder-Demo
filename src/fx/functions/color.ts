import { NAMED_COLORS } from '../enums'
import { def, type CallCtx, type FnDef } from './types'

type Rgba = [number, number, number, number]

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))
const fmt = (c: Rgba): string => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3]})`

function parseColor(text: string): Rgba | null {
  const s = text.trim()
  const named = Object.keys(NAMED_COLORS).find((k) => k.toLowerCase() === s.toLowerCase())
  if (named) return [...NAMED_COLORS[named]!] as Rgba
  let m = /^#([0-9a-f]{3,8})$/i.exec(s)
  if (m) {
    let h = m[1]!
    if (h.length === 3 || h.length === 4) h = h.split('').map((x) => x + x).join('')
    if (h.length === 6 || h.length === 8) {
      const a = h.length === 8 ? Math.round((parseInt(h.slice(6, 8), 16) / 255) * 1000) / 1000 : 1
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a]
    }
    return null
  }
  m = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i.exec(s)
  if (m) {
    const aRaw = m[4]
    const a = aRaw === undefined ? 1 : aRaw.endsWith('%') ? parseFloat(aRaw) / 100 : parseFloat(aRaw)
    return [clamp(Math.round(+m[1]!), 0, 255), clamp(Math.round(+m[2]!), 0, 255), clamp(Math.round(+m[3]!), 0, 255), clamp(a, 0, 1)]
  }
  return null
}

function colorArg(c: CallCtx, i: number): Rgba {
  const s = c.text(i)
  const col = parseColor(s)
  if (!col) return c.fail(i, `Can't read the colour "${s}"`)
  return col
}

export const colorFns: FnDef[] = [
  def('RGBA', 'RGBA(red, green, blue, alpha)', 'Builds a colour. Red, green and blue go from 0 to 255, alpha from 0 to 1.', 4, 4, (c) =>
    fmt([clamp(Math.round(c.num(0)), 0, 255), clamp(Math.round(c.num(1)), 0, 255), clamp(Math.round(c.num(2)), 0, 255), clamp(Math.round(c.num(3) * 1000) / 1000, 0, 1)])),
  def('ColorValue', 'ColorValue(text)', 'Turns a colour name or "#rrggbb" text into a colour.', 1, 1, (c) => fmt(colorArg(c, 0))),
  def('ColorFade', 'ColorFade(color, amount)', 'Lightens (positive, up to 1) or darkens (negative, down to -1) a colour.', 2, 2, (c) => {
    const col = colorArg(c, 0)
    const p = clamp(c.num(1), -1, 1)
    const mix = (x: number): number => Math.round(p >= 0 ? x + (255 - x) * p : x * (1 + p))
    return fmt([mix(col[0]), mix(col[1]), mix(col[2]), col[3]])
  }),
]
