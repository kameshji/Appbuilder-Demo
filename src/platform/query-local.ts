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
  const lookups: Record<string, string> = {}
  for (const c of def.columns) {
    columns[c.name] = columnKind(c.type)
    if (c.type === 'lookup' && c.lookupTable) lookups[c.name] = c.lookupTable
  }
  if (!columns.id) columns.id = 'text'
  return Object.keys(lookups).length ? { columns, lookups, ...extra } : { columns, ...extra }
}

/** lookup paths (`via`, P0-N): rows and schema of the tables they read, as the caller may read them */
export interface LocalRelated { rows(table: string): Row[] | undefined; def(table: string): TableDef | undefined }

export function localQueryState(plan: QueryPlan, rows: Row[], def: TableDef, version: number, related?: LocalRelated): QueryState {
  const key = planKey(plan)
  try {
    const { page: _page, ...whole } = plan
    void _page
    const rel = related ? { rows: (t: string) => related.rows(t), schema: (t: string) => { const d = related.def(t); return d ? schemaInfoOf(d) : undefined } } : undefined
    const res = executePlan(whole, rows, schemaInfoOf(def), { inputOrder: true, ...(rel ? { related: rel } : {}) })
    return { key, plan: whole, status: 'ready', rows: res.rows, count: res.count ?? (plan.aggregate ? undefined : res.rows.length), hasMore: false, refreshing: false, loadingMore: false, version }
  } catch (e) {
    const error = new PlatformError('invalid', e instanceof Error ? e.message : String(e))
    return { key, plan, status: 'error', rows: [], hasMore: false, refreshing: false, loadingMore: false, version, error }
  }
}
