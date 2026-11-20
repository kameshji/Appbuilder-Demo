/** Scales for the chart geometry (P2-C). Pure. */

/** "nice" tick step for a span and a wanted number of ticks (1, 2, 2.5, 5 x 10^k) */
export function niceStep(span: number, count: number): number {
  if (!(span > 0) || !(count > 0)) return 1
  const raw = span / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const r = raw / mag
  const f = r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10
  return f * mag
}

export interface LinearScale {
  domain: [number, number]
  range: [number, number]
  ticks: number[]
  (v: number): number
  invert(px: number): number
}

/** a linear scale over [lo, hi] extended to nice ticks; includes 0 when `zero` */
export function linear(values: number[], range: [number, number], o: { zero?: boolean; count?: number; min?: number; max?: number } = {}): LinearScale {
  const finite = values.filter((v) => Number.isFinite(v))
  let lo = o.min ?? (finite.length ? Math.min(...finite) : 0)
  let hi = o.max ?? (finite.length ? Math.max(...finite) : 1)
  if (o.zero !== false) {
    if (o.min === undefined) lo = Math.min(0, lo)
    if (o.max === undefined) hi = Math.max(0, hi)
  }
  if (lo === hi) {
    if (lo === 0) hi = 1
    else if (lo > 0) { lo = o.min ?? 0; hi = hi * 1.2 || 1 }
    else { hi = o.max ?? 0; lo = lo * 1.2 }
  }
  const count = o.count ?? 5
  const step = niceStep(hi - lo, count)
  const nlo = o.min ?? Math.floor(lo / step + 1e-9) * step
  const nhi = o.max ?? Math.ceil(hi / step - 1e-9) * step
  const ticks: number[] = []
  for (let t = Math.ceil(nlo / step - 1e-9) * step; t <= nhi + step * 1e-6; t += step) ticks.push(Number(t.toPrecision(12)))
  const [r0, r1] = range
  const span = nhi - nlo || 1
  const f = ((v: number) => r0 + ((v - nlo) / span) * (r1 - r0)) as LinearScale
  f.domain = [nlo, nhi]
  f.range = range
  f.ticks = ticks
  f.invert = (px: number) => nlo + ((px - r0) / (r1 - r0 || 1)) * span
  return f
}

export interface BandScale {
  (i: number): number
  bandwidth: number
  step: number
  count: number
}

/** n bands over [r0, r1] with inner padding (fraction of the step) and outer padding */
export function band(n: number, range: [number, number], padding = 0.2, outer = 0.1): BandScale {
  const [r0, r1] = range
  const total = r1 - r0
  const step = n > 0 ? total / Math.max(1, n - padding + outer * 2) : total
  const bw = step * (1 - padding)
  const start = r0 + step * outer
  const f = ((i: number) => start + i * step) as BandScale
  f.bandwidth = Math.max(0, bw)
  f.step = step
  f.count = n
  return f
}

/** approximate text width in px (no DOM: average glyph width of a UI sans font) */
export function textWidth(s: string, size: number): number {
  let w = 0
  for (const ch of s) w += /[ilI.,:;'|!]/.test(ch) ? 0.3 : /[mwMW@%]/.test(ch) ? 0.85 : /[A-Z0-9₹$]/.test(ch) ? 0.62 : 0.53
  return w * size
}

/** shorten a label to fit `max` px */
export function fitText(s: string, size: number, max: number): string {
  if (textWidth(s, size) <= max) return s
  let out = s
  while (out.length > 1 && textWidth(out + '…', size) > max) out = out.slice(0, -1)
  return out.length ? out + '…' : ''
}
