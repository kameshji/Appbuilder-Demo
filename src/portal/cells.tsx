/** Typed value helpers and the cell editor shared by the data grid and the "Add row" dialog. */
import { useEffect, useState } from 'react'
import type { ColumnDef, ColumnType } from '@/platform'
import type { QueryPlan } from '@/platform/query'
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
      // server mode: the target table may be large and only the labels on screen are loaded: search it on the server
      if (platform.getState().mode === 'server' && col.lookupTable && platform.tables.get(col.lookupTable)) {
        return <LookupSearch id={id} cls={cls} col={col} value={value} label={value ? m?.get(value) : undefined} onChange={onChange} autoFocus={autoFocus} onKeyDown={onKeyDown} onBlur={onBlur} />
      }
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

const TEXTISH: ColumnType[] = ['text', 'multiline', 'email', 'url', 'phone', 'choice', 'autonumber']

/** the server query of the lookup type-ahead: 20 rows of the target, by its display column (contains, case-insensitive) */
export function lookupSearchPlan(target: { name: string; primaryColumn: string; columns: ColumnDef[] }, text: string): QueryPlan {
  const primary = target.columns.find((c) => c.name === target.primaryColumn)
  const needle = text.trim()
  const byText = !!primary && TEXTISH.includes(primary.type)
  return {
    version: 2, table: target.name, select: [target.primaryColumn], page: { size: 20 },
    ...(byText ? { sort: [{ col: target.primaryColumn, dir: 'asc' as const }] } : {}),
    ...(needle && byText ? { filter: { col: target.primaryColumn, op: 'contains' as const, value: needle } } : {}),
  }
}

/**
 * Lookup editor with type-ahead (server mode): the target table is searched on the server by its display column
 * (Query v2, delegated, 20 at a time), so a table of a million rows works like a small one. Enter or a click picks the
 * highlighted row; Backspace on an empty box clears the value.
 */
function LookupSearch({ col, value, label, onChange, autoFocus, onKeyDown, onBlur, id, cls }: {
  col: ColumnDef; value: string; label?: string; onChange(v: string): void; autoFocus?: boolean
  onKeyDown?(e: React.KeyboardEvent): void; onBlur?(): void; id?: string; cls: string
}) {
  const target = platform.tables.get(col.lookupTable!)!
  const [text, setText] = useState('')
  const [items, setItems] = useState<{ id: string; label: string }[]>([])
  const [hi, setHi] = useState(0)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      const plan = lookupSearchPlan(target, text)
      platform.tables.query(plan).then((st) => {
        if (!alive) return
        if (st.status === 'error') { setError(st.error?.message ?? 'The search failed.'); return }
        setError('')
        setItems(st.rows.map((r) => ({ id: String(r.__id ?? r.id), label: r[target.primaryColumn] === null || r[target.primaryColumn] === undefined ? '(blank)' : String(r[target.primaryColumn]) })))
        setHi(0)
      }).catch((e: unknown) => { if (alive) setError((e as Error).message) })
    }, 200)
    return () => { alive = false; clearTimeout(t) }
  }, [text, target])
  return (
    <div className="relative" data-testid="lookup-search">
      <input
        id={id} autoFocus={autoFocus} className={cls} value={text} placeholder={label ?? (value ? value : `Search ${target.displayName}`)}
        aria-label={col.displayName} role="combobox" aria-expanded={items.length > 0} aria-autocomplete="list"
        onChange={(e) => setText(e.target.value)} onBlur={onBlur}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(items.length - 1, h + 1)); return }
          if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); return }
          if (e.key === 'Enter' && items[hi] && text) { e.preventDefault(); e.stopPropagation(); onChange(items[hi]!.id); return }
          if (e.key === 'Backspace' && !text && value) { e.preventDefault(); onChange(''); return }
          onKeyDown?.(e)
        }}
      />
      {(items.length > 0 || error) && (
        <ul role="listbox" className="absolute left-0 top-full z-50 mt-0.5 max-h-60 min-w-full overflow-auto rounded-md border border-border bg-popover py-1 text-sm shadow-md" data-testid="lookup-results">
          {error && <li className="px-2 py-1 text-xs text-destructive">{error}</li>}
          {items.map((it, i) => (
            <li key={it.id} role="option" aria-selected={i === hi}
              className={cn('cursor-pointer truncate px-2 py-1', i === hi && 'bg-accent text-accent-foreground', it.id === value && 'font-medium')}
              onMouseDown={(e) => { e.preventDefault(); onChange(it.id) }} onMouseEnter={() => setHi(i)}>{it.label}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
