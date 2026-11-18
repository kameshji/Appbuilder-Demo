/**
 * Shared Condition helpers (architect-owned). Used by in-memory connectors (files, gsheets) and by the
 * DataService. Semantics are the reference that the SQL translators (postgres, mysql) must match:
 *  - text comparisons are case-insensitive (like MySQL's utf8mb4_*_ci collations; the postgres translator lowercases);
 *  - blank = null, undefined or '' ; isBlank/notBlank test that; eq/ne with value null mean isBlank/notBlank;
 *  - ordering ops (lt/le/gt/ge) on a blank cell are false; Dates compare by time; numbers numerically;
 *  - 'in' takes an array; 'contains' / 'startsWith' / 'endsWith' are text, case-insensitive.
 */
import type { Condition, QueryValue, SemiJoin } from '../../src/platform/http.ts'
import { evaluateAsync } from '../../src/platform/orgsec.ts'
import type { RawRow } from './contracts.ts'

type Cell = RawRow[string] | undefined

const isBlank = (v: Cell): boolean => v === null || v === undefined || v === ''

function norm(v: Cell | QueryValue): string | number | boolean | null {
  if (v === undefined || v === null) return null
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string') return v.toLowerCase()
  return v
}

function cmp(a: Cell, b: QueryValue): number | null {
  if (isBlank(a) || b === null) return null
  let x: string | number | boolean | null = norm(a)
  let y: string | number | boolean | null = norm(b)
  // Dates against ISO text: compare as time
  if (a instanceof Date && typeof b === 'string') {
    const t = Date.parse(b)
    if (!Number.isNaN(t)) y = t
  }
  if (typeof x === 'number' && typeof y === 'string' && y.trim() !== '' && !Number.isNaN(Number(y))) y = Number(y)
  if (typeof x === 'string' && typeof y === 'number' && x.trim() !== '' && !Number.isNaN(Number(x))) x = Number(x)
  if (x === null || y === null) return null
  if (typeof x === 'boolean' || typeof y === 'boolean') return x === y ? 0 : x ? 1 : -1
  // a number against non-numeric text is not comparable: eq false, ne true, ordering false (matches the SQL translation)
  if (typeof x !== typeof y) return null
  if (x < y) return -1
  if (x > y) return 1
  return 0
}

export function evaluateCondition(c: Condition | undefined, row: RawRow): boolean {
  if (!c) return true
  if ('const' in c) return c.const
  if ('and' in c) return c.and.every((x) => evaluateCondition(x, row))
  if ('or' in c) return c.or.some((x) => evaluateCondition(x, row))
  if ('not' in c) return !evaluateCondition(c.not, row)
  // a relationship rule needs the database: in memory it never matches (fail closed); see evaluateWithSemi
  if ('semi' in c) return false
  const v = row[c.col]
  switch (c.op) {
    case 'isBlank': return isBlank(v)
    case 'notBlank': return !isBlank(v)
    case 'eq': return c.value === null || c.value === undefined ? isBlank(v) : cmp(v, c.value as QueryValue) === 0
    case 'ne': return c.value === null || c.value === undefined ? !isBlank(v) : cmp(v, c.value as QueryValue) !== 0
    case 'lt': { const r = cmp(v, c.value as QueryValue); return r !== null && r < 0 }
    case 'le': { const r = cmp(v, c.value as QueryValue); return r !== null && r <= 0 }
    case 'gt': { const r = cmp(v, c.value as QueryValue); return r !== null && r > 0 }
    case 'ge': { const r = cmp(v, c.value as QueryValue); return r !== null && r >= 0 }
    case 'in': return Array.isArray(c.value) && c.value.some((x) => cmp(v, x) === 0)
    case 'contains': return !isBlank(v) && String(v).toLowerCase().includes(String(c.value ?? '').toLowerCase())
    case 'startsWith': return !isBlank(v) && String(v).toLowerCase().startsWith(String(c.value ?? '').toLowerCase())
    case 'endsWith': return !isBlank(v) && String(v).toLowerCase().endsWith(String(c.value ?? '').toLowerCase())
    default: return false
  }
}

/** Every column name a condition references (for CLS validation). */
export function conditionColumns(c: Condition | undefined, out: Set<string> = new Set()): Set<string> {
  if (!c || 'const' in c) return out
  if ('and' in c) c.and.forEach((x) => conditionColumns(x, out))
  else if ('or' in c) c.or.forEach((x) => conditionColumns(x, out))
  else if ('not' in c) conditionColumns(c.not, out)
  else if ('semi' in c) out.add(c.semi.col)
  else out.add(c.col)
  return out
}

export const and = (...cs: (Condition | undefined)[]): Condition => {
  const list = cs.filter((x): x is Condition => !!x)
  return list.length === 1 ? list[0] : { and: list }
}

/** In-memory application of a whole Query (filter, sort, skip/top, select) for non-pushdown connectors. */
export function applyQuery(rows: RawRow[], q: { where?: Condition; orderBy?: { col: string; dir: 'asc' | 'desc' }[]; skip?: number; top?: number; select?: string[]; count?: boolean }): { rows: RawRow[]; total?: number } {
  let out = q.where ? rows.filter((r) => evaluateCondition(q.where, r)) : rows.slice()
  const total = q.count ? out.length : undefined
  if (q.orderBy?.length) {
    const order = q.orderBy
    out.sort((a, b) => {
      for (const o of order) {
        const av = a[o.col], bv = b[o.col]
        if (isBlank(av) && isBlank(bv)) continue
        if (isBlank(av)) return 1 // blanks last
        if (isBlank(bv)) return -1
        const r = cmp(av, (bv instanceof Date ? bv.toISOString() : bv) as QueryValue) ?? 0
        if (r !== 0) return o.dir === 'desc' ? -r : r
      }
      return 0
    })
  }
  const skip = Math.max(0, q.skip ?? 0)
  if (skip || q.top !== undefined) out = out.slice(skip, q.top === undefined ? undefined : skip + q.top)
  if (q.select?.length) {
    const keep = new Set([...q.select, 'id'])
    out = out.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keep.has(k))) as RawRow)
  }
  return { rows: out, total }
}

/**
 * evaluateCondition for security predicates with relationship rules: `semi` nodes are answered by `semi(s, value)`
 * (the DataService asks the connector: does a row of s.table with s.key = value match s.where?).
 */
export async function evaluateWithSemi(c: Condition | undefined, row: RawRow, semi: (s: SemiJoin, value: unknown) => Promise<boolean>): Promise<boolean> {
  return evaluateAsync(c, row as Record<string, unknown>, { leaf: (l, r) => evaluateCondition(l, r as RawRow), semi })
}
