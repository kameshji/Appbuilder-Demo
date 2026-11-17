import type { FxValue } from '@/contracts'

/** number or null (blank / unparsable). */
export function numOrNull(v: FxValue | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function clampNum(n: number, min: number | null, max: number | null): number {
  let r = n
  if (min != null && r < min) r = min
  if (max != null && r > max) r = max
  return r
}

/** Round away binary-float noise to the precision of `step` (0.1 + 0.2 -> 0.3). */
export function snap(n: number, step: number): number {
  const decimals = (String(step).split('.')[1] ?? '').length
  return Number(n.toFixed(Math.min(decimals + 2, 10)))
}

export function fmtNum(n: number | null): string {
  return n == null ? '' : String(n)
}
