/**
 * Row-level security helpers shared by the demo-mode simulation (core.ts) and the remote client's
 * mirrored privilege checks. Semantics follow server/core/condition.ts: text is case-insensitive,
 * blank = null / undefined / '', ordering on a blank cell is false, Dates compare by time, values of different
 * types after coercion are not comparable (eq false, ne true, ordering false).
 */
import type { FxValue } from '@/contracts'
import type { RowCompare } from './contracts'
import type { LeafCondition } from './orgsec'

const isBlank = (v: unknown): boolean => v === null || v === undefined || v === ''

type Prim = string | number | boolean

function norm(v: unknown): Prim | null {
  if (v === undefined || v === null) return null
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string') return v.toLowerCase()
  if (typeof v === 'number' || typeof v === 'boolean') return v
  return String(v).toLowerCase()
}

function cmp(a: unknown, b: Prim | null | undefined): number | null {
  if (isBlank(a) || b === null || b === undefined) return null
  let x = norm(a)
  let y = norm(b)
  if (a instanceof Date && typeof b === 'string') {
    const t = Date.parse(b)
    if (!Number.isNaN(t)) y = t
  }
  if (typeof x === 'number' && typeof y === 'string' && y.trim() !== '' && !Number.isNaN(Number(y))) y = Number(y)
  if (typeof x === 'string' && typeof y === 'number' && x.trim() !== '' && !Number.isNaN(Number(x))) x = Number(x)
  if (x === null || y === null) return null
  if (typeof x === 'boolean' || typeof y === 'boolean') return x === y ? 0 : x ? 1 : -1
  // a number against non-numeric text is not comparable: eq false, ne true, ordering false (same as the server)
  if (typeof x !== typeof y) return null
  if (x < y) return -1
  if (x > y) return 1
  return 0
}

/** resolve '@me' / '@myEmail' tokens */
export function resolveToken(value: RowCompare['value'], me: { id: string; email: string }): RowCompare['value'] {
  const one = (v: string | number | boolean) => (v === '@me' ? me.id : v === '@myEmail' ? me.email : v)
  if (Array.isArray(value)) return value.map((v) => one(v) as string | number)
  return value === undefined ? undefined : one(value)
}

/** does a typed row satisfy one RowCondition for this user? */
export function matchesCondition(c: RowCompare, row: Record<string, FxValue | undefined>, me: { id: string; email: string }): boolean {
  const v = row[c.column]
  const value = resolveToken(c.value, me)
  const scalar = (Array.isArray(value) ? undefined : value) as Prim | undefined
  switch (c.op) {
    case 'isBlank': return isBlank(v)
    case 'notBlank': return !isBlank(v)
    case 'eq': return scalar === undefined ? isBlank(v) : cmp(v, scalar) === 0
    case 'ne': return scalar === undefined ? !isBlank(v) : cmp(v, scalar) !== 0
    case 'lt': { const r = cmp(v, scalar); return r !== null && r < 0 }
    case 'le': { const r = cmp(v, scalar); return r !== null && r <= 0 }
    case 'gt': { const r = cmp(v, scalar); return r !== null && r > 0 }
    case 'ge': { const r = cmp(v, scalar); return r !== null && r >= 0 }
    case 'in': return Array.isArray(value) && value.some((x) => cmp(v, x) === 0)
    case 'contains': return !isBlank(v) && String(v).toLowerCase().includes(String(scalar ?? '').toLowerCase())
    case 'startsWith': return !isBlank(v) && String(v).toLowerCase().startsWith(String(scalar ?? '').toLowerCase())
    default: return false
  }
}

/**
 * One leaf of the security Condition AST (src/platform/http.ts) on a typed row: the in-memory twin of the server's
 * evaluateCondition (server/core/condition.ts) used by demo mode for the predicates of src/platform/orgsec.ts.
 */
export function matchesLeaf(c: LeafCondition, row: Record<string, unknown>): boolean {
  const v = row[c.col]
  const value = c.value
  const scalar = (Array.isArray(value) ? undefined : value) as Prim | null | undefined
  switch (c.op) {
    case 'isBlank': return isBlank(v)
    case 'notBlank': return !isBlank(v)
    case 'eq': return scalar === undefined || scalar === null ? isBlank(v) : cmp(v, scalar) === 0
    case 'ne': return scalar === undefined || scalar === null ? !isBlank(v) : cmp(v, scalar) !== 0
    case 'lt': { const r = cmp(v, scalar); return r !== null && r < 0 }
    case 'le': { const r = cmp(v, scalar); return r !== null && r <= 0 }
    case 'gt': { const r = cmp(v, scalar); return r !== null && r > 0 }
    case 'ge': { const r = cmp(v, scalar); return r !== null && r >= 0 }
    case 'in': return Array.isArray(value) && value.some((x) => x !== null && cmp(v, x) === 0)
    case 'contains': return !isBlank(v) && String(v).toLowerCase().includes(String(scalar ?? '').toLowerCase())
    case 'startsWith': return !isBlank(v) && String(v).toLowerCase().startsWith(String(scalar ?? '').toLowerCase())
    case 'endsWith': return !isBlank(v) && String(v).toLowerCase().endsWith(String(scalar ?? '').toLowerCase())
    default: return false
  }
}
