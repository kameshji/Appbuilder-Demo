/**
 * Query v2 rows on the wire -> formula values (P0 package D). Pure; shared by the remote platform (browser) and the
 * PostgreSQL parity test. Rules (docs/dev/query-v2.md section 9): dates travel as 'YYYY-MM-DD' and become local midnight,
 * datetimes as ISO instants; row plans keep the row id as `__id` and drop `id` unless the plan selected it; aggregate
 * rows have no id.
 */
import type { FxRecord, FxValue } from '../contracts.ts'
import type { ColumnType } from './contracts.ts'
import type { QueryValue } from './http.ts'
import type { QueryPlan } from './query.ts'
import { bucketKind } from './query.ts'

function parseDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    d.setFullYear(Number(m[1]))
    return d
  }
  const t = Date.parse(s)
  if (Number.isNaN(t)) return null
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** one wire value -> formula value by column type */
export function valueFromWire(type: ColumnType | undefined, v: QueryValue | undefined): FxValue {
  if (v === null || v === undefined) return null
  switch (type) {
    case 'date': return typeof v === 'string' ? parseDay(v) : null
    case 'datetime': {
      if (typeof v !== 'string') return null
      const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v) ? `${v.replace(' ', 'T')}Z` : /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(v) ? `${v}Z` : v
      const d = new Date(iso)
      return Number.isNaN(d.getTime()) ? null : d
    }
    case 'number': case 'decimal': case 'currency': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
      return Number.isFinite(n) ? n : null
    }
    case 'boolean':
      return typeof v === 'boolean' ? v : v === 1 || v === '1' || v === 'true' ? true : v === 0 || v === '0' || v === 'false' ? false : null
    default:
      return typeof v === 'string' ? v : String(v)
  }
}

/** output column types of a plan's result (table column types; measures are numbers) */
export function resultTypes(plan: QueryPlan, tableTypes: Record<string, ColumnType>): Record<string, ColumnType> {
  if (!plan.aggregate) return tableTypes
  const out: Record<string, ColumnType> = {}
  for (const g of plan.aggregate.groupBy) out[plan.aggregate.as?.[g] ?? g] = tableTypes[g] ?? 'text'
  for (const b of plan.aggregate.buckets ?? []) out[b.name] = bucketKind(b.unit) === 'date' ? 'date' : 'number'
  for (const m of plan.aggregate.measures) out[m.name] = 'decimal'
  return out
}

/** wire rows of a plan -> formula records */
export function rowsFromWire(plan: QueryPlan, rows: Record<string, QueryValue>[], tableTypes: Record<string, ColumnType>): FxRecord[] {
  const types = resultTypes(plan, tableTypes)
  const agg = !!plan.aggregate
  const keepId = agg ? false : !plan.select || plan.select.includes('id')
  return rows.map((r) => {
    const o: FxRecord = {}
    for (const [k, v] of Object.entries(r)) {
      if (k === 'id' && !keepId) continue
      o[k] = k === 'id' ? (v === null ? null : String(v)) : valueFromWire(types[k], v)
    }
    if (!agg && r.id !== undefined && r.id !== null) o.__id = String(r.id)
    return o
  })
}
