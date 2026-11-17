import type { FxValue } from '@/contracts'
import { toNumber, toRows } from '../values'
import { roundHalfAway } from './format'
import { def, type CallCtx, type FnDef } from './types'

function digits(c: CallCtx): number {
  return c.argc > 1 ? Math.trunc(c.num(1)) : 0
}

function shift(x: number, d: number, f: (n: number) => number): number {
  const s = String(Math.abs(x))
  if (s.includes('e')) {
    const m = Math.pow(10, d)
    return f(x * m) / m
  }
  const sign = x < 0 ? -1 : 1
  return sign * Number(f(Number(s + 'e' + d)) + 'e' + -d)
}

function numbersOf(c: CallCtx): number[] {
  return valuesOf(c, (v, at) => (v === null ? undefined : toNumber(v, c.argNode(at)))).filter((x): x is number => x !== undefined)
}

/** Values of the arguments (or of a table column / formula), blank skipped. `conv` may return undefined to skip. */
function valuesOf<T>(c: CallCtx, conv: (v: FxValue, argIndex: number) => T | undefined): (T | undefined)[] {
  const first = c.withAs(0)
  const out: (T | undefined)[] = []
  const push = (v: FxValue, at: number): void => {
    out.push(conv(v, at))
  }
  if (Array.isArray(first.value)) {
    const rows = toRows(first.value)
    if (c.argc >= 2) {
      for (const r of rows) push(c.row(1, r, first.as), 1)
    } else {
      for (const r of rows) {
        const keys = Object.keys(r).filter((k) => k !== '__id')
        const k = Object.prototype.hasOwnProperty.call(r, 'Value') ? 'Value' : keys.length === 1 ? keys[0]! : undefined
        if (k === undefined) return c.fail(0, 'This table has several columns. Say which one to use, like Sum(table, Price)')
        push(r[k]!, 0)
      }
    }
    return out
  }
  push(first.value, 0)
  for (let i = 1; i < c.argc; i++) push(c.value(i), i)
  return out
}

function fin(c: CallCtx, x: number): number {
  if (!Number.isFinite(x)) return c.fail(null, "That result isn't a valid number")
  return x
}

function variance(n: number[]): number {
  const m = n.reduce((a, b) => a + b, 0) / n.length
  return n.reduce((a, b) => a + (b - m) * (b - m), 0) / n.length
}

export const mathFns: FnDef[] = [
  def('Round', 'Round(number [, digits])', 'Rounds to the nearest value (halves round away from zero).', 1, 2, (c) => roundHalfAway(c.num(0), digits(c))),
  def('RoundUp', 'RoundUp(number [, digits])', 'Rounds away from zero.', 1, 2, (c) => shift(c.num(0), digits(c), (n) => (n < 0 ? Math.floor(n) : Math.ceil(n)))),
  def('RoundDown', 'RoundDown(number [, digits])', 'Rounds toward zero.', 1, 2, (c) => shift(c.num(0), digits(c), Math.trunc)),
  def('Int', 'Int(number)', 'Rounds down to the nearest whole number.', 1, 1, (c) => Math.floor(c.num(0))),
  def('Abs', 'Abs(number)', 'Removes the minus sign.', 1, 1, (c) => Math.abs(c.num(0))),
  def('Mod', 'Mod(number, divisor)', 'Remainder after dividing. Takes the sign of the divisor.', 2, 2, (c) => {
    const a = c.num(0)
    const b = c.num(1)
    if (b === 0) return c.fail(1, "Can't divide by zero")
    return a - b * Math.floor(a / b)
  }),
  def('Sqrt', 'Sqrt(number)', 'Square root.', 1, 1, (c) => {
    const n = c.num(0)
    if (n < 0) return c.fail(0, "Can't take the square root of a negative number")
    return Math.sqrt(n)
  }),
  def('Power', 'Power(base, exponent)', 'Raises a number to a power.', 2, 2, (c) => {
    const r = Math.pow(c.num(0), c.num(1))
    if (!Number.isFinite(r)) return c.fail(null, "That result isn't a valid number")
    return r
  }),
  def('Min', 'Min(a, b, ...) or Min(table, formula)', 'Smallest value.', 1, Infinity, (c) => {
    const n = numbersOf(c)
    return n.length ? Math.min(...n) : 0
  }),
  def('Max', 'Max(a, b, ...) or Max(table, formula)', 'Largest value.', 1, Infinity, (c) => {
    const n = numbersOf(c)
    return n.length ? Math.max(...n) : 0
  }),
  def('Sum', 'Sum(a, b, ...) or Sum(table, formula)', 'Adds values together.', 1, Infinity, (c) => numbersOf(c).reduce((a, b) => a + b, 0)),
  def('Average', 'Average(a, b, ...) or Average(table, formula)', 'Mean of the values. Blank when there are none.', 1, Infinity, (c) => {
    const n = numbersOf(c)
    return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null
  }),
  def('Count', 'Count(table [, formula]) or Count(a, b, ...)', 'Number of numeric values (blank and text are skipped).', 1, Infinity, (c) =>
    valuesOf(c, (v) => (typeof v === 'number' ? v : undefined)).filter((x) => x !== undefined).length),
  def('CountA', 'CountA(table [, formula]) or CountA(a, b, ...)', 'Number of values that are not blank.', 1, Infinity, (c) =>
    valuesOf(c, (v) => (v === null || v === '' ? undefined : true)).filter((x) => x !== undefined).length),
  def('StdevP', 'StdevP(table [, formula]) or StdevP(a, b, ...)', 'Population standard deviation. Blank when there are no values.', 1, Infinity, (c) => {
    const n = numbersOf(c)
    return n.length ? Math.sqrt(variance(n)) : null
  }),
  def('VarP', 'VarP(table [, formula]) or VarP(a, b, ...)', 'Population variance. Blank when there are no values.', 1, Infinity, (c) => {
    const n = numbersOf(c)
    return n.length ? variance(n) : null
  }),
  def('Exp', 'Exp(number)', 'e raised to a power.', 1, 1, (c) => fin(c, Math.exp(c.num(0)))),
  def('Ln', 'Ln(number)', 'Natural logarithm.', 1, 1, (c) => {
    const n = c.num(0)
    if (n <= 0) return c.fail(0, "Can't take the logarithm of zero or a negative number")
    return Math.log(n)
  }),
  def('Log', 'Log(number [, base])', 'Logarithm of a number. Base defaults to 10.', 1, 2, (c) => {
    const n = c.num(0)
    const b = c.argc > 1 ? c.num(1) : 10
    if (n <= 0) return c.fail(0, "Can't take the logarithm of zero or a negative number")
    if (b <= 0 || b === 1) return c.fail(1, 'The base must be above zero and not 1')
    return Math.log(n) / Math.log(b)
  }),
  def('Pi', 'Pi()', 'The number pi.', 0, 0, () => Math.PI),
  def('Sin', 'Sin(radians)', 'Sine of an angle in radians.', 1, 1, (c) => Math.sin(c.num(0))),
  def('Cos', 'Cos(radians)', 'Cosine of an angle in radians.', 1, 1, (c) => Math.cos(c.num(0))),
  def('Tan', 'Tan(radians)', 'Tangent of an angle in radians.', 1, 1, (c) => fin(c, Math.tan(c.num(0)))),
  def('Degrees', 'Degrees(radians)', 'Converts radians to degrees.', 1, 1, (c) => (c.num(0) * 180) / Math.PI),
  def('Radians', 'Radians(degrees)', 'Converts degrees to radians.', 1, 1, (c) => (c.num(0) * Math.PI) / 180),
  def('Trunc', 'Trunc(number [, digits])', 'Removes the decimals (or keeps the given number of digits) without rounding.', 1, 2, (c) => shift(c.num(0), digits(c), Math.trunc)),
  def('Rand', 'Rand()', 'A random number from 0 up to (not including) 1.', 0, 0, () => Math.random()),
  def('RandBetween', 'RandBetween(low, high)', 'A random whole number between low and high, inclusive.', 2, 2, (c) => {
    const lo = Math.ceil(Math.min(c.num(0), c.num(1)))
    const hi = Math.floor(Math.max(c.num(0), c.num(1)))
    return lo + Math.floor(Math.random() * (hi - lo + 1))
  }),
]
