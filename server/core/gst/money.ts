/**
 * Decimal arithmetic for the ledger and GST package (docs/plan/gst-spec-draft.md G5.4). Never binary floating point:
 * amounts are integer paise (a safe integer), quantities, unit prices and rates are scaled BigInts while they are
 * multiplied. Rounding is HALF AWAY FROM ZERO to the paisa (0.005 -> 0.01, -0.005 -> -0.01).
 *
 * Scales (G5.4): money 2 decimals, quantities 3, unit prices 4, rates and percentages 3.
 * The one place to change if the accountant corrects the rounding rule.
 */
export const MONEY_SCALE = 2
export const QTY_SCALE = 3
export const PRICE_SCALE = 4
export const RATE_SCALE = 3

/** integer paise */
export type Paise = number

export class DecimalError extends Error {}

const P10 = (n: number): bigint => 10n ** BigInt(n)

/**
 * A decimal written as text (or a finite number without an exponent) -> the integer `value x 10^scale`.
 * More decimals than `scale` are refused (never silently rounded): the caller decides what to do with them.
 */
export function parseDecimal(v: unknown, scale: number, what = 'value'): bigint {
  let s: string
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new DecimalError(`${what} is not a number.`)
    s = String(v)
  } else if (typeof v === 'bigint') s = v.toString()
  else if (typeof v === 'string') s = v.trim().replace(/,/g, '')
  else throw new DecimalError(`${what} is missing.`)
  const m = /^([+-])?(\d{1,15})(?:\.(\d+))?$/.exec(s)
  if (!m) throw new DecimalError(`${what} must be a plain decimal number (got "${s.slice(0, 30)}").`)
  const frac = (m[3] ?? '').replace(/0+$/, '')
  if (frac.length > scale) throw new DecimalError(`${what} has more than ${scale} decimals.`)
  const n = BigInt(m[2]) * P10(scale) + BigInt((frac + '0'.repeat(scale)).slice(0, scale) || '0')
  return m[1] === '-' ? -n : n
}

/** n / d rounded half away from zero (d > 0) */
export function divRound(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new DecimalError('division by zero or a negative divisor')
  const neg = n < 0n
  const a = neg ? -n : n
  const q = (a * 2n + d) / (d * 2n)
  return neg ? -q : q
}

const toPaise = (n: bigint): Paise => {
  const x = Number(n)
  if (!Number.isSafeInteger(x)) throw new DecimalError('The amount is too large.')
  return x
}

/** money text -> paise ("1250.00" -> 125000) */
export const paise = (v: unknown, what = 'amount'): Paise => toPaise(parseDecimal(v, MONEY_SCALE, what))

/** paise -> "1250.00" (no grouping; for CSV and the API) */
export function rupees(p: Paise | bigint): string {
  const n = BigInt(p)
  const a = n < 0n ? -n : n
  return `${n < 0n ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`
}

/** paise -> "1,00,000.00" (Indian digit grouping, for documents) */
export function rupeesIN(p: Paise | bigint): string {
  const [int, frac] = rupees(p).replace('-', '').split('.')
  const head = int.length > 3 ? int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' : ''
  return `${BigInt(p) < 0n ? '-' : ''}${head}${int.slice(-3)}.${frac}`
}

/** a decimal written as text ("1250.00", "-12500.5") with the integer part grouped the Indian way ("1,250.00"); other text is returned as it is */
export function groupIN(v: string): string {
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(v.trim())
  if (!m) return v
  const int = m[2]
  const head = int.length > 3 ? int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' : ''
  return `${m[1]}${head}${int.slice(-3)}${m[3] ?? ''}`
}

/** scaled decimal -> text with `scale` decimals, trailing zeros trimmed to at least `min` */
export function decimalText(n: bigint, scale: number, min = 0): string {
  const a = n < 0n ? -n : n
  let frac = (a % P10(scale)).toString().padStart(scale, '0').replace(/0+$/, '')
  if (frac.length < min) frac = frac.padEnd(min, '0')
  return `${n < 0n ? '-' : ''}${a / P10(scale)}${frac ? `.${frac}` : ''}`
}

/** G5.5: round2(quantity x unit price); both scaled (QTY_SCALE, PRICE_SCALE) */
export const lineGross = (qty: bigint, price: bigint): Paise => toPaise(divRound(qty * price, P10(QTY_SCALE + PRICE_SCALE - MONEY_SCALE)))

/** round2(amount x percent / 100); percent scaled by RATE_SCALE (discounts G5.5, tax components G5.6) */
export const percentOf = (amount: Paise, percent: bigint): Paise => toPaise(divRound(BigInt(amount) * percent, 100n * P10(RATE_SCALE)))

/** G4.16: round2(inclusive / (1 + total rate / 100)) */
export const exclusiveOf = (inclusive: Paise, totalRate: bigint): Paise =>
  toPaise(divRound(BigInt(inclusive) * 100n * P10(RATE_SCALE), 100n * P10(RATE_SCALE) + totalRate))

/** G5.7 / G5.1: the nearest whole rupee, fifty paise or more up (for a negative total: away from zero) */
export const roundToRupee = (p: Paise): Paise => toPaise(divRound(BigInt(p), 100n) * 100n)

/**
 * Spread `total` over `weights` in proportion, each share rounded to the paisa, the rounding remainder put on the
 * share with the largest weight (the first one of equal weights). G4.13 (document discount), G4.15 (charges).
 */
export function apportion(total: Paise, weights: Paise[]): Paise[] {
  const sum = weights.reduce((a, b) => a + BigInt(b), 0n)
  if (!weights.length || sum <= 0n) return weights.map(() => 0)
  const out = weights.map((w) => toPaise(divRound(BigInt(total) * BigInt(w), sum)))
  const rest = total - out.reduce((a, b) => a + b, 0)
  if (rest !== 0) {
    let big = 0
    for (let i = 1; i < weights.length; i++) if (weights[i] > weights[big]) big = i
    out[big] += rest
  }
  return out
}
