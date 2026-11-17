/** Typed value helpers and the cell editor shared by the data grid and the "Add row" dialog. */
import type { ColumnDef, ColumnType } from '@/platform'
import { platform } from '@/platform'
import type { FxValue } from '@/contracts'
import { cn } from '@/lib/utils'

const NUMERIC: ColumnType[] = ['number', 'decimal', 'currency', 'autonumber']
export const isNumeric = (t: ColumnType) => NUMERIC.includes(t)

const pad = (n: number) => String(n).padStart(2, '0')

/** typed cell value -> text for an <input> */
export function valueToDraft(col: ColumnDef, v: FxValue | undefined): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return ''
    if (col.type === 'date') return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}T${pad(v.getHours())}:${pad(v.getMinutes())}`
  }
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** input text -> value to hand to the platform (which coerces and validates) */
export function draftToValue(col: ColumnDef, draft: string): FxValue {
  const t = draft.trim()
  if (col.type === 'boolean') return draft === 'true'
  if (t === '') return null
  if (isNumeric(col.type)) {
    const n = Number(t)
    if (!Number.isFinite(n)) throw new Error(`"${t}" is not a number (${col.displayName})`)
    return n
  }
  if (col.type === 'datetime') {
    const d = new Date(t)
    return Number.isNaN(d.getTime()) ? t : d.toISOString()
  }
  return col.type === 'multiline' ? draft : t
}

export interface LookupMap { [colName: string]: Map<string, string> }

export function buildLookups(columns: ColumnDef[]): LookupMap {
  const out: LookupMap = {}
  for (const c of columns) {
    if (c.type !== 'lookup' || !c.lookupTable) continue
    const target = platform.tables.get(c.lookupTable)
    const m = new Map<string, string>()
    if (target) {
      for (const r of platform.tables.rows(target.name, { secure: false })) {
        const label = r[target.primaryColumn]
        m.set(String(r.__id ?? r.id), label === null || label === undefined ? '(blank)' : String(label))
      }
    }
    out[c.name] = m
  }
  return out
}

/** plain text for display, filtering and sorting */
export function displayText(col: ColumnDef, v: FxValue | undefined, lookups: LookupMap): string {
  if (v === null || v === undefined) return ''
  switch (col.type) {
    case 'boolean': return v ? 'Yes' : 'No'
    case 'date': return v instanceof Date ? v.toLocaleDateString() : String(v)
    case 'datetime': return v instanceof Date ? v.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : String(v)
    case 'currency': return typeof v === 'number' ? v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v)
    case 'lookup': return lookups[col.name]?.get(String(v)) ?? String(v)
    case 'file':
    case 'image': {
      const raw = String(v)
      if (raw.startsWith('[')) { try { const n = (JSON.parse(raw) as unknown[]).length; return `${n} ${n === 1 ? 'file' : 'files'}` } catch { /* plain text */ } }
      return /^(https?:|data:|blob:|\/)/i.test(raw) ? raw : '1 file'
    }
    default: return typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
}

export function compareValues(col: ColumnDef, a: FxValue | undefined, b: FxValue | undefined, lookups: LookupMap): number {
  const ea = a === null || a === undefined || a === ''
  const eb = b === null || b === undefined || b === ''
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  return displayText(col, a, lookups).localeCompare(displayText(col, b, lookups), undefined, { numeric: true, sensitivity: 'base' })
}

const fieldCls = 'h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30'

/** Editor for one value, by column type. `dense` = used inside a grid cell. */
export function CellEditor({
  col, value, onChange, lookups, dense, autoFocus, onKeyDown, onBlur, id,
}: {
  col: ColumnDef
  value: string
  onChange(v: string): void
  lookups: LookupMap
  dense?: boolean
  autoFocus?: boolean
  onKeyDown?(e: React.KeyboardEvent): void
  onBlur?(): void
  id?: string
}) {
  const cls = cn(fieldCls, dense && 'h-7 rounded-sm border-ring')
  switch (col.type) {
    case 'boolean':
      return (
        <select id={id} autoFocus={autoFocus} className={cls} value={value === 'true' ? 'true' : 'false'} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} onBlur={onBlur} aria-label={col.displayName}>
          <option value="false">No</option>
          <option value="true">Yes</option>
        </select>
      )
    case 'choice':
      return (
        <select id={id} autoFocus={autoFocus} className={cls} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} onBlur={onBlur} aria-label={col.displayName}>
          <option value="">(blank)</option>
          {(col.choices ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
          {value && !(col.choices ?? []).includes(value) && <option value={value}>{value}</option>}
        </select>
      )
    case 'lookup': {
      const m = lookups[col.name]
      return (
        <select id={id} autoFocus={autoFocus} className={cls} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} onBlur={onBlur} aria-label={col.displayName}>
          <option value="">(blank)</option>
          {m && [...m.entries()].map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          {value && !m?.has(value) && <option value={value}>{value}</option>}
        </select>
      )
    }
    case 'file':
    case 'image':
      return <span className="px-2 text-xs text-muted-foreground">{displayText(col, value, lookups) || 'Attach files after the row is saved.'}</span>
    case 'multiline':
      return dense ? (
        <input id={id} autoFocus={autoFocus} className={cls} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} onBlur={onBlur} aria-label={col.displayName} />
      ) : (
        <textarea id={id} className={cn(fieldCls, 'h-20 py-1.5')} value={value} onChange={(e) => onChange(e.target.value)} aria-label={col.displayName} />
      )
    default: {
      const type = col.type === 'date' ? 'date' : col.type === 'datetime' ? 'datetime-local' : isNumeric(col.type) ? 'number' : col.type === 'email' ? 'email' : col.type === 'url' ? 'url' : col.type === 'phone' ? 'tel' : 'text'
      return (
        <input
          id={id}
          autoFocus={autoFocus}
          type={type}
          step={col.type === 'number' || col.type === 'autonumber' ? 1 : isNumeric(col.type) ? 'any' : undefined}
          className={cls}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          aria-label={col.displayName}
        />
      )
    }
  }
}
