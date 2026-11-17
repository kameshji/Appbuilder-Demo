/**
 * Typed cell values: coercion in, CSV text out, and small shared helpers (ids, names, YAML).
 * Pure functions, no DOM, no React.
 */
import * as yaml from 'js-yaml'
import type { FxRecord, FxValue } from '@/contracts'
import { PlatformError } from './contracts'
import type { ColumnDef, ColumnType } from './contracts'

/* ------------------------------------------------------------------ ids and names */

function hex(bytes: number): string {
  let out = ''
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c?.getRandomValues) {
    const a = new Uint8Array(bytes)
    c.getRandomValues(a)
    for (const b of a) out += b.toString(16).padStart(2, '0')
  } else {
    for (let i = 0; i < bytes; i++) out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  }
  return out
}

/** RFC 4122 v4 uuid (randomUUID is unavailable on plain http origins other than localhost). */
export function uuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  const h = hex(16).split('')
  h[12] = '4'
  h[16] = '89ab'[parseInt(h[16], 16) % 4]
  const s = h.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

/** short unique id with a readable prefix: app_1a2b3c4d */
export const shortId = (prefix: string) => `${prefix}_${hex(4)}`

export const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** "Sales orders (2024)" -> "SalesOrders2024"; never empty, never starts with a digit. */
export function toIdentifier(display: string, fallback = 'Item'): string {
  const parts = display
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  let s = parts.map((p) => p[0].toUpperCase() + p.slice(1)).join('')
  if (!s) s = fallback
  if (/^[0-9]/.test(s)) s = '_' + s
  return s
}

/** first free `base`, `base_2`, `base_3`... (case-insensitive) */
export function uniqueIdentifier(base: string, taken: Iterable<string>): string {
  const used = new Set<string>()
  for (const t of taken) used.add(t.toLowerCase())
  if (!used.has(base.toLowerCase())) return base
  let i = 2
  while (used.has(`${base}_${i}`.toLowerCase())) i++
  return `${base}_${i}`
}

/** first free "Base", "Base (2)", "Base (3)"... (case-insensitive) */
export function uniqueLabel(base: string, taken: Iterable<string>): string {
  const used = new Set<string>()
  for (const t of taken) used.add(t.toLowerCase())
  if (!used.has(base.toLowerCase())) return base
  let i = 2
  while (used.has(`${base} (${i})`.toLowerCase())) i++
  return `${base} (${i})`
}

/* ------------------------------------------------------------------ yaml */

export function toYaml(value: unknown): string {
  return yaml.dump(value, { lineWidth: -1, noRefs: true, sortKeys: false })
}

export function fromYaml(text: string): unknown {
  try {
    return yaml.load(text)
  } catch (e) {
    throw new PlatformError('invalid', `Not valid YAML: ${(e as Error).message.split('\n')[0]}`)
  }
}

/* ------------------------------------------------------------------ system columns */

export const SYSTEM_COLUMNS: ColumnDef[] = [
  { name: 'id', displayName: 'Id', type: 'text', system: true },
  { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true },
  { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime', system: true },
  { name: 'createdBy', displayName: 'Created by', type: 'text', system: true },
  { name: 'owner', displayName: 'Owner', type: 'text', system: true },
]
export const SYSTEM_NAMES = new Set(SYSTEM_COLUMNS.map((c) => c.name))

/* ------------------------------------------------------------------ dates */

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** date-only values are calendar days in LOCAL time, serialised YYYY-MM-DD */
export function formatDate(d: Date): string {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/

function parseDateText(s: string): Date | null {
  const m = ISO_DATE.exec(s)
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    // reject 2024-02-31 style overflow
    return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null
  }
  const t = Date.parse(s)
  if (Number.isNaN(t)) return null
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function parseDateTimeText(s: string): Date | null {
  if (ISO_DATE.test(s)) return parseDateText(s)
  if (!ISO_DATETIME.test(s) && !/^[A-Za-z]{3}/.test(s) && !/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(s)) return null
  const t = Date.parse(s.includes(' ') && !s.includes('T') && ISO_DATETIME.test(s) ? s.replace(' ', 'T') : s)
  return Number.isNaN(t) ? null : new Date(t)
}

/* ------------------------------------------------------------------ coercion */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const URL_LIKE = /^([a-z][a-z0-9+.-]*:\/\/|www\.|mailto:|tel:|data:)\S+$/i
const PHONE = /^[+()\-.\s\d]{3,32}(\s*(x|ext\.?)\s*\d{1,6})?$/i

function bad(col: ColumnDef, msg: string): never {
  throw new PlatformError('invalid', `${col.displayName}: ${msg}`)
}

export function isBlankValue(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
}

function toNumber(col: ColumnDef, v: FxValue): number {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) bad(col, 'must be a finite number')
    return v
  }
  if (typeof v === 'boolean') bad(col, 'must be a number')
  if (typeof v === 'string') {
    const t = v.trim().replace(/,/g, '')
    if (t === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) bad(col, `"${v}" is not a number`)
    return Number(t)
  }
  return bad(col, 'must be a number')
}

/**
 * Coerce an incoming value to the column's runtime type. Blank -> null. Throws PlatformError
 * ('invalid') with a maker-readable message. Choice/lookup membership and required/unique are
 * checked by the caller (they need table context); this handles the type only.
 */
export function coerceValue(col: ColumnDef, raw: FxValue | undefined): FxValue {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'string' && raw.trim() === '' && col.type !== 'multiline') return null
  switch (col.type) {
    case 'text':
    case 'multiline':
    case 'image':
    case 'file':
    case 'autonumber': {
      if (raw instanceof Date) return raw.toISOString()
      if (typeof raw === 'object') return bad(col, 'must be text')
      if (typeof raw === 'string' && raw === '') return null
      return String(raw)
    }
    case 'email': {
      const s = String(raw).trim()
      if (!EMAIL.test(s)) bad(col, `"${s}" is not a valid email address`)
      return s
    }
    case 'url': {
      const s = String(raw).trim()
      if (!URL_LIKE.test(s)) bad(col, `"${s}" is not a valid URL`)
      return s
    }
    case 'phone': {
      const s = String(raw).trim()
      if (!PHONE.test(s)) bad(col, `"${s}" is not a valid phone number`)
      return s
    }
    case 'number': {
      const n = toNumber(col, raw)
      if (!Number.isInteger(n)) bad(col, `${n} is not a whole number`)
      return n
    }
    case 'decimal':
      return toNumber(col, raw)
    case 'currency':
      return Math.round(toNumber(col, raw) * 100) / 100
    case 'boolean': {
      if (typeof raw === 'boolean') return raw
      if (typeof raw === 'number') {
        if (raw === 1) return true
        if (raw === 0) return false
      }
      if (typeof raw === 'string') {
        const t = raw.trim().toLowerCase()
        if (t === 'true' || t === '1' || t === 'yes' || t === 'y') return true
        if (t === 'false' || t === '0' || t === 'no' || t === 'n') return false
      }
      return bad(col, 'must be true or false')
    }
    case 'date': {
      let d: Date | null = null
      if (raw instanceof Date) d = Number.isNaN(raw.getTime()) ? null : new Date(raw.getFullYear(), raw.getMonth(), raw.getDate())
      else if (typeof raw === 'string') d = parseDateText(raw.trim())
      if (!d) bad(col, `${String(raw)} is not a valid date (use YYYY-MM-DD)`)
      return d
    }
    case 'datetime': {
      let d: Date | null = null
      if (raw instanceof Date) d = Number.isNaN(raw.getTime()) ? null : new Date(raw.getTime())
      else if (typeof raw === 'string') d = parseDateTimeText(raw.trim())
      if (!d) bad(col, `${String(raw)} is not a valid date and time`)
      return d
    }
    case 'choice': {
      const s = String(raw).trim()
      if (col.choices && col.choices.length) {
        const hit = col.choices.find((c) => c === s) ?? col.choices.find((c) => c.toLowerCase() === s.toLowerCase())
        if (hit === undefined) bad(col, `"${s}" is not one of: ${col.choices.join(', ')}`)
        return hit
      }
      return s
    }
    case 'lookup': {
      // formulas often pass the whole record; the cell stores the target row id
      if (typeof raw === 'object' && !Array.isArray(raw) && !(raw instanceof Date)) {
        const rec = raw as FxRecord
        const id = rec.__id ?? rec.id
        return typeof id === 'string' && id ? id : null
      }
      return String(raw)
    }
  }
}

/** Lenient variant for reading hand-edited CSV files: never throws, unparsable -> null. */
export function coerceLoose(col: ColumnDef, raw: string): FxValue {
  try {
    return coerceValue(col, raw)
  } catch {
    if (col.type === 'choice') return raw.trim() || null
    if (col.type === 'email' || col.type === 'url' || col.type === 'phone') return raw.trim() || null
    return null
  }
}

/** CSV text of a typed value. */
export function serializeValue(col: ColumnDef, v: FxValue | undefined): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return ''
    return col.type === 'date' ? formatDate(v) : v.toISOString()
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  if (typeof v === 'string') return v
  return ''
}

/** default value of a column as typed value (literal text; date/datetime also accept today/now). */
export function defaultValue(col: ColumnDef, now: Date): FxValue {
  if (col.type === 'autonumber') return null
  if (col.default === undefined || col.default === '') return null
  if ((col.type === 'date' || col.type === 'datetime') && /^(today|now)$/i.test(col.default.trim())) {
    return col.type === 'date' ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : new Date(now.getTime())
  }
  return coerceLoose(col, col.default)
}

/** value comparison key for the `unique` rule (text is compared case-insensitively) */
export function uniqueKey(v: FxValue): string {
  if (v instanceof Date) return String(v.getTime())
  return String(v).trim().toLowerCase()
}

/* ------------------------------------------------------------------ type inference (CSV import) */

export function inferType(values: string[]): ColumnType {
  const vs = values.map((v) => v.trim()).filter((v) => v !== '')
  if (vs.length === 0) return 'text'
  if (vs.every((v) => /^(true|false)$/i.test(v))) return 'boolean'
  if (vs.every((v) => /^[+-]?\d{1,15}$/.test(v))) return 'number'
  if (vs.every((v) => /^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(v))) return 'decimal'
  if (vs.every((v) => parseDateTextStrict(v))) return 'date'
  if (vs.every((v) => ISO_DATETIME.test(v) && !Number.isNaN(Date.parse(v)))) return 'datetime'
  if (vs.every((v) => EMAIL.test(v))) return 'email'
  if (vs.every((v) => /^https?:\/\/\S+$/i.test(v))) return 'url'
  if (values.some((v) => v.includes('\n'))) return 'multiline'
  return 'text'
}

function parseDateTextStrict(s: string): boolean {
  return ISO_DATE.test(s) && parseDateText(s) !== null
}
