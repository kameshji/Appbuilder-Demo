/**
 * Row-level security helpers shared by the demo-mode simulation (core.ts) and the remote client's
 * mirrored privilege checks. Semantics follow server/core/condition.ts: text is case-insensitive,
 * blank = null / undefined / '', ordering on a blank cell is false, Dates compare by time.
 */
import type { FxValue } from '@/contracts'
import type { RowCondition } from './contracts'

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
  if (x < y) return -1
  if (x > y) return 1
  return 0
}

/** resolve '@me' / '@myEmail' tokens */
export function resolveToken(value: RowCondition['value'], me: { id: string; email: string }): RowCondition['value'] {
  const one = (v: string | number | boolean) => (v === '@me' ? me.id : v === '@myEmail' ? me.email : v)
  if (Array.isArray(value)) return value.map((v) => one(v) as string | number)
  return value === undefined ? undefined : one(value)
}

/** does a typed row satisfy one RowCondition for this user? */
export function matchesCondition(c: RowCondition, row: Record<string, FxValue | undefined>, me: { id: string; email: string }): boolean {
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
