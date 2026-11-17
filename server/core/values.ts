/**
 * Typed values at the HTTP boundary. JSON (QueryValue) <-> RawRow (Date for date/datetime).
 * Date-only values are calendar days carried as UTC-midnight Dates; JSON 'YYYY-MM-DD'.
 */
import { HttpError } from './contracts.ts'
import type { RawRow } from './contracts.ts'
import type { ColumnDef } from '../../src/platform/contracts.ts'
import type { QueryValue } from '../../src/platform/http.ts'

type Cell = RawRow[string]

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** calendar day of a Date: all connectors carry 'date' cells as UTC-midnight Dates */
export function dateToYmd(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const URL_LIKE = /^([a-z][a-z0-9+.-]*:\/\/|www\.|mailto:|tel:)\S+$/i
const PHONE = /^[+()\-.\s\d]{3,32}(\s*(x|ext\.?)\s*\d{1,6})?$/i

function parseYmd(s: string): Date | null {
  const m = ISO_DATE.exec(s)
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? d : null
}

function bad(col: ColumnDef, msg: string): never {
  throw new HttpError(422, 'invalid', `${col.displayName || col.name}: ${msg}`, col.name)
}

export const isBlank = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '')

function toNumber(col: ColumnDef, v: unknown): number {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) bad(col, 'must be a finite number')
    return v
  }
  if (typeof v === 'string') {
    const t = v.trim().replace(/,/g, '')
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) bad(col, `"${v.slice(0, 40)}" is not a number`)
    return Number(t)
  }
  return bad(col, 'must be a number')
}

/** attachment cell text -> ids */
export function attachmentIds(v: unknown): string[] {
  if (v === null || v === undefined || v === '') return []
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x !== '')
  const s = String(v).trim()
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s) as unknown
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string' && x !== '') : []
    } catch {
      return []
    }
  }
  return s ? [s] : []
}

/** JSON value from a client (or CSV text) -> typed raw cell. Blank -> null. Throws 422 field-specific. */
export function coerceIn(col: ColumnDef, raw: unknown): Cell {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'string' && raw.trim() === '' && col.type !== 'multiline') return null
  if (typeof raw === 'object' && !Array.isArray(raw)) bad(col, 'must be a plain value')
  switch (col.type) {
    case 'text':
    case 'multiline':
    case 'autonumber': {
      if (Array.isArray(raw)) bad(col, 'must be text')
      const s = String(raw)
      if (s.length > (col.type === 'multiline' ? 16_000_000 : 255)) bad(col, 'is too long')
      return s === '' ? null : s
    }
    case 'email': {
      const s = String(raw).trim()
      if (!EMAIL.test(s) || s.length > 255) bad(col, `"${s.slice(0, 60)}" is not a valid email address`)
      return s
    }
    case 'url': {
      const s = String(raw).trim()
      if (!URL_LIKE.test(s) || s.length > 1024) bad(col, `"${s.slice(0, 60)}" is not a valid URL`)
      return s
    }
    case 'phone': {
      const s = String(raw).trim()
      if (!PHONE.test(s)) bad(col, `"${s.slice(0, 40)}" is not a valid phone number`)
      return s
    }
    case 'number': {
      const n = toNumber(col, raw)
      if (!Number.isInteger(n)) bad(col, `${n} is not a whole number`)
      if (!Number.isSafeInteger(n)) bad(col, 'is too large')
      return n
    }
    case 'decimal':
      return toNumber(col, raw)
    case 'currency':
      return Math.round(toNumber(col, raw) * 10000) / 10000
    case 'boolean': {
      if (typeof raw === 'boolean') return raw
      if (raw === 1 || raw === 0) return raw === 1
      if (typeof raw === 'string') {
        const t = raw.trim().toLowerCase()
        if (['true', '1', 'yes', 'y'].includes(t)) return true
        if (['false', '0', 'no', 'n'].includes(t)) return false
      }
      return bad(col, 'must be true or false')
    }
    case 'date': {
      if (typeof raw !== 'string') bad(col, 'must be a date (YYYY-MM-DD)')
      const s = raw.trim()
      let d = parseYmd(s)
      if (!d && ISO_DATETIME.test(s)) {
        const t = new Date(s)
        if (!Number.isNaN(t.getTime())) d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()))
      }
      if (!d) bad(col, `${s.slice(0, 40)} is not a valid date (use YYYY-MM-DD)`)
      return d
    }
    case 'datetime': {
      if (typeof raw !== 'string') bad(col, 'must be an ISO date and time')
      const s = raw.trim()
      const ymd = parseYmd(s)
      if (ymd) return ymd
      if (!ISO_DATETIME.test(s)) bad(col, `${s.slice(0, 40)} is not a valid date and time`)
      const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s.replace(' ', 'T') : s.replace(' ', 'T') + 'Z')
      if (Number.isNaN(d.getTime())) bad(col, `${s.slice(0, 40)} is not a valid date and time`)
      return d
    }
    case 'choice': {
      const s = String(raw).trim()
      if (col.choices && col.choices.length) {
        const hit = col.choices.find((c) => c === s) ?? col.choices.find((c) => c.toLowerCase() === s.toLowerCase())
        if (hit === undefined) bad(col, `"${s.slice(0, 60)}" is not one of: ${col.choices.join(', ')}`)
        return hit
      }
      return s
    }
    case 'lookup': {
      const s = String(raw).trim()
      if (s.length > 64) bad(col, 'is not a row id')
      return s
    }
    case 'image':
    case 'file': {
      const ids = attachmentIds(raw)
      if (!ids.length) return null
      if (!col.multiple && ids.length > 1) bad(col, 'takes a single attachment')
      return col.multiple ? JSON.stringify(ids) : ids[0]
    }
    default:
      return String(raw)
  }
}

/** default value of a column (literal text; date/datetime accept today/now) */
export function defaultIn(col: ColumnDef, now: Date): Cell {
  if (col.type === 'autonumber' || col.default === undefined || col.default === '') return null
  const d = col.default.trim()
  if (col.type === 'date' && /^(today|now)$/i.test(d)) return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  if (col.type === 'datetime' && /^(today|now)$/i.test(d)) return new Date(now.getTime())
  try {
    return coerceIn(col, col.default)
  } catch {
    return null
  }
}

/** raw cell from a connector -> JSON value for the client */
export function cellOut(col: ColumnDef | undefined, v: unknown): QueryValue {
  if (v === null || v === undefined) return null
  const type = col?.type ?? 'text'
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    return type === 'date' ? dateToYmd(v) : v.toISOString()
  }
  switch (type) {
    case 'number':
    case 'decimal':
    case 'currency': {
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) ? n : null
    }
    case 'boolean':
      if (typeof v === 'boolean') return v
      if (typeof v === 'number') return v !== 0
      if (typeof v === 'string') return ['true', '1', 'yes'].includes(v.toLowerCase())
      return null
    case 'date':
      if (typeof v === 'string') return v.length >= 10 ? v.slice(0, 10) : v
      return String(v)
    case 'datetime':
      if (typeof v === 'string') {
        const d = new Date(/^\d{4}-\d{2}-\d{2} /.test(v) ? v.replace(' ', 'T') + 'Z' : v)
        return Number.isNaN(d.getTime()) ? v : d.toISOString()
      }
      return String(v)
    default:
      if (Buffer.isBuffer(v)) return v.toString('utf8')
      return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? (typeof v === 'string' ? v : String(v)) : String(v)
  }
}

/** a JSON value as CSV text */
export function csvText(v: QueryValue): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}
