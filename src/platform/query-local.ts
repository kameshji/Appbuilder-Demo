/**
 * Query v2 over rows held in memory (P0 package D): demo mode answers platform.tables.query / queryState with the
 * reference executor, so the portal grid and the controls use one code path in both modes. Array order is the table's
 * natural order in demo mode (rows are kept in insertion order).
 */
import type { ColumnKind, QueryPlan, TableSchemaInfo } from './query.ts'
import { columnKind } from './query.ts'
import type { Row, TableDef } from './contracts.ts'
import { PlatformError } from './contracts.ts'
import type { QueryState } from './query-cache.ts'
import { planKey } from './query-cache.ts'
import { executePlan } from '../fx/query/reference.ts'

export function schemaInfoOf(def: TableDef, extra?: Partial<TableSchemaInfo>): TableSchemaInfo {
  const columns: Record<string, ColumnKind> = {}
  for (const c of def.columns) columns[c.name] = columnKind(c.type)
  if (!columns.id) columns.id = 'text'
  return { columns, ...extra }
}

export function localQueryState(plan: QueryPlan, rows: Row[], def: TableDef, version: number): QueryState {
  const key = planKey(plan)
  try {
    const { page: _page, ...whole } = plan
    void _page
    const res = executePlan(whole, rows, schemaInfoOf(def), { inputOrder: true })
    return { key, plan: whole, status: 'ready', rows: res.rows, count: res.count ?? (plan.aggregate ? undefined : res.rows.length), hasMore: false, refreshing: false, loadingMore: false, version }
  } catch (e) {
    const error = new PlatformError('invalid', e instanceof Error ? e.message : String(e))
    return { key, plan, status: 'error', rows: [], hasMore: false, refreshing: false, loadingMore: false, version, error }
  }
}
