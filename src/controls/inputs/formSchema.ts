import type { FxRecord, FxValue } from '@/contracts'
import type { ColumnDef, TableDef } from '@/platform/contracts'
import { isRecord, toText } from '../util'
import { dateKey, startOfDay, toDate } from './shared'

/** What a form field holds while editing. */
export type FieldVal = string | boolean | Date | null
export type FormValues = Record<string, FieldVal>
export type FormModeName = 'Edit' | 'New' | 'View'

export function parseFormMode(v: FxValue | undefined): FormModeName {
  const s = toText(v).trim().toLowerCase()
  if (s === 'new') return 'New'
  if (s === 'view') return 'View'
  return 'Edit'
}

export const isNumberType = (t: ColumnDef['type']) => t === 'number' || t === 'decimal' || t === 'currency'
export const isDateType = (t: ColumnDef['type']) => t === 'date' || t === 'datetime'

/** Columns to show: the `Fields` list (case-insensitive name or display name), else every non-system column. */
export function visibleColumns(table: TableDef, fieldsProp: string, mode: FormModeName): ColumnDef[] {
  const wanted = fieldsProp.split(',').map((s) => s.trim()).filter((s) => s !== '')
  let cols: ColumnDef[]
  if (wanted.length === 0) {
    cols = table.columns.filter((c) => !c.system)
  } else {
    cols = []
    for (const w of wanted) {
      const lw = w.toLowerCase()
      const c = table.columns.find((x) => x.name.toLowerCase() === lw) ?? table.columns.find((x) => x.displayName.toLowerCase() === lw)
      if (c && !cols.includes(c)) cols.push(c)
    }
  }
  // Auto-numbers are assigned by the platform: never editable, only meaningful once the row exists.
  return mode === 'New' ? cols.filter((c) => c.type !== 'autonumber') : cols
}

function literalDefault(col: ColumnDef): FieldVal {
  const d = col.default
  switch (col.type) {
    case 'boolean':
      return (d ?? '').trim().toLowerCase() === 'true'
    case 'date':
    case 'datetime': {
      if (d == null || d.trim() === '') return null
      if (d.trim().toLowerCase() === 'today' || d.trim().toLowerCase() === 'now') return col.type === 'date' ? startOfDay(new Date()) : new Date()
      return toDate(d)
    }
    default:
      return d ?? ''
  }
}

function fromRowValue(col: ColumnDef, v: FxValue | undefined): FieldVal {
  switch (col.type) {
    case 'boolean':
      return v === true || (typeof v === 'string' && v.toLowerCase() === 'true')
    case 'date':
    case 'datetime': {
      const d = toDate(v)
      return d && col.type === 'date' ? startOfDay(d) : d
    }
    default:
      if (v == null) return ''
      if (isRecord(v)) return ''
      return toText(v)
  }
}

/** Initial field values for a (re)load. */
export function initialValues(cols: ColumnDef[], mode: FormModeName, item: FxRecord | null): FormValues {
  const out: FormValues = {}
  for (const c of cols) {
    out[c.name] = mode === 'New' || !item ? literalDefault(c) : fromRowValue(c, item[c.name])
  }
  return out
}

/** Typed value the platform expects for this column; null = blank. */
export function toFxValue(col: ColumnDef, v: FieldVal | undefined): FxValue {
  if (col.type === 'boolean') return v === true
  if (isDateType(col.type)) return v instanceof Date ? v : null
  const s = typeof v === 'string' ? v : ''
  if (isNumberType(col.type)) {
    if (s.trim() === '') return null
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  return s.trim() === '' ? null : s
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const PHONE = /^\+?[\d\s().-]{5,}$/

export interface LookupOption { id: string; label: string }

/** Validation message for a field, or null when fine. */
export function validateField(col: ColumnDef, v: FieldVal | undefined, lookups: Record<string, LookupOption[]>): string | null {
  const name = col.displayName || col.name
  if (col.type === 'autonumber') return null
  const blank =
    col.type === 'boolean' ? false : isDateType(col.type) ? !(v instanceof Date) : typeof v !== 'string' || v.trim() === ''
  if (blank) return col.required ? `${name} is required` : null
  const s = typeof v === 'string' ? v.trim() : ''
  switch (col.type) {
    case 'email':
      return EMAIL.test(s) ? null : 'Enter a valid email address'
    case 'url':
      try {
        const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`)
        return u.hostname.includes('.') || u.hostname === 'localhost' ? null : 'Enter a valid URL'
      } catch {
        return 'Enter a valid URL'
      }
    case 'phone':
      return PHONE.test(s) ? null : 'Enter a valid phone number'
    case 'number':
      return /^-?\d+$/.test(s) ? null : 'Enter a whole number'
    case 'decimal':
    case 'currency':
      return Number.isFinite(Number(s)) ? null : 'Enter a number'
    case 'choice':
      return (col.choices ?? []).includes(s) ? null : 'Pick one of the listed choices'
    case 'lookup':
      return (lookups[col.name] ?? []).some((o) => o.id === s) ? null : 'Pick an existing record'
    default:
      return null
  }
}

export function serializeValues(v: FormValues): string {
  const parts: string[] = []
  for (const k of Object.keys(v).sort()) {
    const x = v[k]
    parts.push(k + '=' + (x instanceof Date ? 'D' + x.getTime() : typeof x === 'boolean' ? (x ? 'T' : 'F') : x == null ? '' : 'S' + x))
  }
  return parts.join('\u0001')
}

export function itemKey(item: FxRecord | null): string {
  if (!item) return ''
  const parts: string[] = []
  for (const k of Object.keys(item).sort()) {
    const x = item[k]
    parts.push(k + '=' + (x instanceof Date ? dateKey(x) + x.getTime() : isRecord(x) || Array.isArray(x) ? JSON.stringify(x) : String(x)))
  }
  return parts.join('\u0001')
}
