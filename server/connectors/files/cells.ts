/**
 * Cell values, identifier sanitising and type inference for the files connector. Pure functions.
 * Dates: 'date' columns are UTC-midnight Date objects, 'datetime' columns are UTC instants.
 */
import type { ColumnType } from '../../../src/platform/contracts.ts'
import type { RawRow } from '../../core/contracts.ts'

/** What the in-memory sheets hold (the storage representation of the file kind). */
export type Cell = string | number | boolean | Date | null
export type FileKind = 'csv' | 'xlsx' | 'json'

export const SYSTEM_COLUMNS: { name: string; displayName: string; type: ColumnType }[] = [
  { name: 'id', displayName: 'Id', type: 'text' },
  { name: 'createdOn', displayName: 'Created on', type: 'datetime' },
  { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime' },
  { name: 'createdBy', displayName: 'Created by', type: 'text' },
  { name: 'owner', displayName: 'Owner', type: 'text' },
]
export const SYSTEM_BY_LOWER = new Map(SYSTEM_COLUMNS.map((c) => [c.name.toLowerCase(), c]))

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i
const INT_RE = /^[+-]?(0|[1-9]\d{0,14})$/
const DEC_RE = /^[+-]?((0|[1-9]\d{0,14})\.\d+|\.\d+|(0|[1-9]\d{0,14})(\.\d*)?[eE][+-]?\d+)$/

export const isBlank = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '')

/* ------------------------------------------------------------------ identifiers */

/** "Sales orders (2024)" -> "SalesOrders2024"; '' when nothing usable */
export function toIdentifier(display: string): string {
  const parts = display.normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean)
  let s = parts.map((p) => p[0].toUpperCase() + p.slice(1)).join('')
  if (s && /^[0-9]/.test(s)) s = '_' + s
  return s
}

export function uniqueIdentifier(base: string, taken: Set<string>): string {
  if (!taken.has(base.toLowerCase())) return base
  let i = 2
  while (taken.has(`${base}_${i}`.toLowerCase())) i++
  return `${base}_${i}`
}

/* ------------------------------------------------------------------ dates */

export function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}
export const isUtcMidnight = (d: Date): boolean => d.getTime() % 86400000 === 0
export function ymd(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

function validYmd(s: string): Date | null {
  const m = ISO_DATE.exec(s)
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? d : null
}

function parseDateTime(s: string): Date | null {
  const t = s.trim()
  const day = validYmd(t)
  if (day) return day
  if (!ISO_DATETIME.test(t)) return null
  let u = t.replace(' ', 'T')
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(u)) u += 'Z'
  const ms = Date.parse(u)
  return Number.isNaN(ms) ? null : new Date(ms)
}

/* ------------------------------------------------------------------ typed <-> stored */

const NUMERIC = new Set<ColumnType>(['number', 'decimal', 'currency'])

/** stored cell -> typed RawRow value for a column type */
export function toTyped(v: Cell | undefined, type: ColumnType): RawRow[string] {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' && v.trim() === '') return null
  if (type === 'date' || type === 'datetime') {
    let d: Date | null = null
    if (v instanceof Date) d = v
    else if (typeof v === 'string') d = parseDateTime(v)
    if (!d || Number.isNaN(d.getTime())) return null
    return type === 'date' ? utcDay(d) : new Date(d.getTime())
  }
  if (NUMERIC.has(type)) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    if (typeof v === 'string') {
      const t = v.trim().replace(/,/g, '')
      return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) ? Number(t) : null
    }
    return null
  }
  if (type === 'boolean') {
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : null
    if (typeof v === 'string') {
      const t = v.trim().toLowerCase()
      if (t === 'true' || t === '1' || t === 'yes' || t === 'y') return true
      if (t === 'false' || t === '0' || t === 'no' || t === 'n') return false
    }
    return null
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  return typeof v === 'string' ? v : String(v)
}

/** typed (or loosely typed) value -> storage representation for the file kind */
export function toStored(kind: FileKind, type: ColumnType, v: unknown): Cell {
  if (v === null || v === undefined) return null
  const t = toTyped(v as Cell, type)
  if (t === null) return null
  if (t instanceof Date) {
    if (kind === 'xlsx') return type === 'date' ? utcDay(t) : t
    return type === 'date' ? ymd(t) : t.toISOString()
  }
  if (kind === 'csv') return typeof t === 'string' ? t : String(t)
  return t
}

/* ------------------------------------------------------------------ inference */

export function inferString(values: string[]): ColumnType {
  const vs = values.map((v) => v.trim()).filter((v) => v !== '')
  if (vs.length === 0) return 'text'
  if (vs.every((v) => /^(true|false)$/i.test(v))) return 'boolean'
  if (vs.every((v) => INT_RE.test(v))) return 'number'
  if (vs.every((v) => INT_RE.test(v) || DEC_RE.test(v))) return 'decimal'
  if (vs.every((v) => validYmd(v) !== null)) return 'date'
  if (vs.every((v) => ISO_DATETIME.test(v) && parseDateTime(v) !== null)) return 'datetime'
  if (vs.every((v) => EMAIL.test(v))) return 'email'
  if (vs.every((v) => /^https?:\/\/\S+$/i.test(v))) return 'url'
  if (values.some((v) => v.includes('\n'))) return 'multiline'
  return 'text'
}

export function inferColumn(cells: Cell[]): ColumnType {
  const nb = cells.filter((c) => !isBlank(c)) as Exclude<Cell, null>[]
  if (nb.length === 0) return 'text'
  if (nb.every((c) => typeof c === 'boolean')) return 'boolean'
  if (nb.every((c) => typeof c === 'number')) return nb.every((c) => Number.isInteger(c) && Math.abs(c as number) <= 999999999999999) ? 'number' : 'decimal'
  if (nb.every((c) => c instanceof Date)) return nb.every((c) => isUtcMidnight(c as Date)) ? 'date' : 'datetime'
  if (nb.every((c) => typeof c === 'string')) return inferString(nb as string[])
  return 'text'
}
