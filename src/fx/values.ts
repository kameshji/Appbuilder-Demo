import type { FxRecord, FxValue } from '@/contracts'
import { fail, type Span } from './errors'

export const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

export function isRecord(v: unknown): v is FxRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)
}
export function isTable(v: unknown): v is FxValue[] { return Array.isArray(v) }

/** Table elements as records: records stay as they are, anything else becomes { Value: x }. */
export function toRows(arr: FxValue[]): FxRecord[] {
  return arr.map((x) => (isRecord(x) ? x : { Value: x }))
}

export function describe(v: FxValue): string {
  if (v === null) return 'a blank value'
  if (typeof v === 'number') return 'a number'
  if (typeof v === 'boolean') return 'a true/false value'
  if (typeof v === 'string') return v.length > 24 ? `the text "${v.slice(0, 21)}..."` : `the text "${v}"`
  if (v instanceof Date) return 'a date'
  if (Array.isArray(v)) return 'a table'
  return 'a record'
}

export function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n)
  return String(parseFloat(n.toPrecision(15)))
}

export function pad(n: number, w = 2): string { return String(n).padStart(w, '0') }

export function fmtDateDefault(d: Date): string {
  if (Number.isNaN(d.getTime())) return ''
  const date = `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) return date
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i

/** Parse user-ish number text ("1,234.5", "12%", "$3"). undefined when not a number. */
export function parseNumberText(raw: string): number | undefined {
  let s = raw.trim()
  if (s === '') return undefined
  let pct = false
  if (s.endsWith('%')) { pct = true; s = s.slice(0, -1).trim() }
  if (s.startsWith('$')) s = s.slice(1)
  s = s.replace(/,/g, '')
  if (!NUM_RE.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n)) return undefined
  return pct ? n / 100 : n
}

export function toNumber(v: FxValue, at: Span): number {
  if (v === null) return 0
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    if (v.trim() === '') return 0
    const n = parseNumberText(v)
    if (n === undefined) fail(at, `Can't turn ${describe(v)} into a number`)
    return n
  }
  if (v instanceof Date) return v.getTime()
  return fail(at, `Can't use ${describe(v)} as a number`)
}

export function toText(v: FxValue, at: Span): string {
  if (v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return fmtNum(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (v instanceof Date) return fmtDateDefault(v)
  return fail(at, `Can't use ${describe(v)} as text`)
}

export function toBool(v: FxValue, at: Span): boolean {
  if (v === null) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const l = v.trim().toLowerCase()
    if (l === 'true') return true
    if (l === 'false' || l === '') return false
    return fail(at, `Can't turn ${describe(v)} into true/false`)
  }
  return fail(at, `Can't use ${describe(v)} as true/false`)
}

function numericOf(v: FxValue): number | undefined {
  if (v === null) return 0
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') return v.trim() === '' ? 0 : parseNumberText(v)
  return undefined
}

function deepEq(a: FxValue, b: FxValue, exact: boolean): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => looseEq(x, b[i]!, exact))
  }
  if (isRecord(a) && isRecord(b)) {
    if (typeof a.__id === 'string' && typeof b.__id === 'string') return a.__id === b.__id
    const ka = Object.keys(a).filter((k) => k !== '__id')
    const kb = Object.keys(b).filter((k) => k !== '__id')
    if (ka.length !== kb.length) return false
    return ka.every((k) => hasOwn(b, k) && looseEq(a[k]!, b[k]!, exact))
  }
  return false
}

/** The `=` operator. exact = case-sensitive text. */
export function looseEq(a: FxValue, b: FxValue, exact = false): boolean {
  if (a === null || b === null) {
    const o = a === null ? b : a
    return o === null || o === '' || o === 0 || o === false
  }
  if (typeof a === 'string' && typeof b === 'string') return exact ? a === b : a.toLowerCase() === b.toLowerCase()
  if (typeof a === 'number' && typeof b === 'number') return a === b
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (typeof a === 'object' && typeof b === 'object' && !(a instanceof Date) && !(b instanceof Date)) return deepEq(a, b, exact)
  // mixed scalar types
  if (typeof a === 'string' || typeof b === 'string') {
    const na = numericOf(a)
    const nb = numericOf(b)
    if (na !== undefined && nb !== undefined) return na === nb
    const sa = typeof a === 'string' ? a : typeof a === 'boolean' ? String(a) : typeof a === 'number' ? fmtNum(a) : null
    const sb = typeof b === 'string' ? b : typeof b === 'boolean' ? String(b) : typeof b === 'number' ? fmtNum(b) : null
    if (sa === null || sb === null) return false
    return exact ? sa === sb : sa.toLowerCase() === sb.toLowerCase()
  }
  return false
}

/** Ordering for < > <= >= and Sort. Blank sorts first. */
export function compareValues(a: FxValue, b: FxValue, at: Span): number {
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : a === null ? -Infinity : toDateNumber(a, at)
    const tb = b instanceof Date ? b.getTime() : b === null ? -Infinity : toDateNumber(b, at)
    return ta < tb ? -1 : ta > tb ? 1 : 0
  }
  if (isTable(a) || isRecord(a) || isTable(b) || isRecord(b)) {
    fail(at, `Can't compare ${describe(isTable(a) || isRecord(a) ? a : b)}`)
  }
  if (typeof a === 'string' || typeof b === 'string') {
    const na = numericOf(a)
    const nb = numericOf(b)
    if (na !== undefined && nb !== undefined) return na < nb ? -1 : na > nb ? 1 : 0
    const sa = toText(a, at).toLowerCase()
    const sb = toText(b, at).toLowerCase()
    return sa < sb ? -1 : sa > sb ? 1 : 0
  }
  const na = toNumber(a, at)
  const nb = toNumber(b, at)
  return na < nb ? -1 : na > nb ? 1 : 0
}

function toDateNumber(v: FxValue, at: Span): number {
  if (typeof v === 'string') {
    const t = Date.parse(v)
    if (!Number.isNaN(t)) return t
  }
  return toNumber(v, at)
}

/** Stable key used for Distinct. */
export function valueKey(v: FxValue): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return 's:' + v.toLowerCase()
  if (typeof v === 'number') return 'n:' + v
  if (typeof v === 'boolean') return 'b:' + v
  if (v instanceof Date) return 'd:' + v.getTime()
  if (Array.isArray(v)) return '[' + v.map(valueKey).join(',') + ']'
  return '{' + Object.keys(v).filter((k) => k !== '__id').sort().map((k) => k + '=' + valueKey(v[k]!)).join(',') + '}'
}

/** Copy of a record without the hidden __id. */
export function withoutId(r: FxRecord): FxRecord {
  if (!hasOwn(r, '__id')) return r
  const c: FxRecord = {}
  for (const k of Object.keys(r)) if (k !== '__id') c[k] = r[k]!
  return c
}

export function setField(rec: FxRecord, key: string, value: FxValue): void {
  if (key === '__proto__') return
  rec[key] = value
}
