/**
 * Test helper (P3-C): the body of POST /api/v1/query for the reads that tests and scripts used to send to the removed
 * Data API v1 query route (POST /data/:table/query). Test code only.
 *
 * `where` takes the v1 shape for plain comparisons of text, number and boolean columns (eq, ne, lt, le, gt, ge, in,
 * contains, startsWith, endsWith, isBlank; and / or / not). They become STRICT Query v2 primitives (docs/dev/query-v2.md
 * section 4): a NULL cell never matches, text ignores case as in v1. `orderBy` and `select` are the v2 sort and select;
 * `top` becomes `take` (top 0 with count: a count-only page); `count` asks for the exact count (`data.count`, not v1's
 * `data.total`). Rows come in natural order (createdOn, id) without `orderBy`, as v1 rows did.
 */
import type { ConditionV2, QueryLiteral, QueryPlan } from '../../src/platform/query.ts'

export type SimpleCond =
  | { and: SimpleCond[] }
  | { or: SimpleCond[] }
  | { not: SimpleCond }
  | { col: string; op: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'contains' | 'startsWith' | 'endsWith' | 'isBlank' | 'in'; value?: unknown }

export interface SimpleQuery {
  where?: SimpleCond
  orderBy?: { col: string; dir: 'asc' | 'desc' }[]
  select?: string[]
  top?: number
  count?: boolean
}

export function toV2(c: SimpleCond): ConditionV2 {
  if ('and' in c) return { and: c.and.map(toV2) }
  if ('or' in c) return { or: c.or.map(toV2) }
  if ('not' in c) return { not: toV2(c.not) }
  if (c.op === 'isBlank') return { col: c.col, op: 'isNull' }
  if (c.op === 'in') return { col: c.col, op: 'in', value: (c.value as QueryLiteral[]) ?? [] }
  if (c.op === 'contains' || c.op === 'startsWith' || c.op === 'endsWith') return { col: c.col, op: c.op, value: String(c.value ?? '') }
  return { col: c.col, op: c.op, value: c.value as QueryLiteral }
}

/** `{ plan }` for POST /api/v1/query */
export function planBody(table: string, q: SimpleQuery = {}): { plan: QueryPlan } {
  const plan: QueryPlan = { version: 2, table }
  if (q.where) plan.filter = toV2(q.where)
  if (q.orderBy?.length) plan.sort = q.orderBy.map((o) => ({ col: o.col, dir: o.dir }))
  if (q.select?.length) plan.select = [...q.select]
  if (q.count) plan.count = true
  if (q.top === 0 && q.count) plan.page = { size: 0 }
  else if (q.top !== undefined) plan.take = { n: q.top, from: 'start' }
  return { plan }
}
