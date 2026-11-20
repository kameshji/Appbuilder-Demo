/**
 * The dashboard viewer's data step (P2-C), pure: a definition plus the viewer's choices (date range, dashboard filters,
 * the cross-filter of a clicked tile) -> ONE batch of plans; the batch's answers -> each tile's rows or error.
 *
 * Filters apply to every tile whose table has the filtered column; a cross-filter (a click on a category of a tile with
 * crossFilter) applies to the OTHER tiles on the same table. A tile whose spec cannot compile shows its message; the
 * others still load.
 */
import type { ConditionV2, QueryPlan } from '../platform/query.ts'
import type { DashboardDef } from './types.ts'
import type { CalendarSettings, DateRange } from './dates.ts'
import { compileQuery, finishQuery } from './measures.ts'

export interface CrossFilter { tileId: string; table: string; column: string; value: unknown }

export interface ViewerChoices {
  range: DateRange | null
  /** dashboard filter id -> chosen value ('' = all) */
  filters: Record<string, string>
  cross?: CrossFilter | null
  calendar: CalendarSettings
  /** the viewer's local date-time (comparisons of a running range are "to date") */
  now?: string
  /** the column names of a table, or null when the viewer cannot see the table */
  columns(table: string): string[] | null
}

export interface TileData { rows: Record<string, unknown>[]; error?: string; status?: number; filtered?: boolean; truncated?: boolean; ms?: number }

export function buildBatch(def: DashboardDef, c: ViewerChoices): { queries: { id: string; plan: QueryPlan }[]; errors: Record<string, string> } {
  const queries: { id: string; plan: QueryPlan }[] = []
  const errors: Record<string, string> = {}
  for (const t of def.tiles) {
    if (!t.query) continue
    const cols = c.columns(t.query.table)
    const has = (col: string) => !!cols && cols.some((x) => x.toLowerCase() === col.toLowerCase())
    const conds: ConditionV2[] = []
    for (const f of def.filters ?? []) {
      const v = c.filters[f.id]
      if (v && has(f.column)) conds.push({ col: f.column, op: 'eq', value: v })
    }
    const x = c.cross
    if (x && x.tileId !== t.id && x.table.toLowerCase() === t.query.table.toLowerCase() && has(x.column)) {
      conds.push(x.value === null || x.value === undefined ? { col: x.column, op: 'isNull' } : { col: x.column, op: 'eq', value: x.value as string | number | boolean })
    }
    try {
      const q = compileQuery(t.query, { range: c.range, filters: conds, calendar: c.calendar, now: c.now })
      queries.push({ id: `${t.id}:main`, plan: q.main })
      if (q.compare) queries.push({ id: `${t.id}:compare`, plan: q.compare })
      if (q.target) queries.push({ id: `${t.id}:target`, plan: q.target })
    } catch (e) {
      errors[t.id] = e instanceof Error ? e.message : String(e)
    }
  }
  return { queries, errors }
}

export interface BatchAnswer { id: string; ok: boolean; rows: Record<string, unknown>[]; error?: string; status?: number; filtered?: boolean; truncated?: boolean; ms: number }

export function assemble(def: DashboardDef, c: Pick<ViewerChoices, 'range' | 'calendar' | 'now'>, answers: BatchAnswer[], errors: Record<string, string> = {}): Record<string, TileData> {
  const by = new Map(answers.map((a) => [a.id, a]))
  const out: Record<string, TileData> = {}
  for (const t of def.tiles) {
    if (!t.query) continue
    if (errors[t.id]) { out[t.id] = { rows: [], error: errors[t.id] }; continue }
    const main = by.get(`${t.id}:main`)
    const cmp = by.get(`${t.id}:compare`)
    const tgt = by.get(`${t.id}:target`)
    const failed = [main, cmp, tgt].find((a) => a && !a.ok)
    if (!main) { out[t.id] = { rows: [], error: 'No answer for this tile.' }; continue }
    if (failed) { out[t.id] = { rows: [], error: failed.error ?? 'The query failed.', status: failed.status }; continue }
    try {
      const fin = finishQuery(t.query, { range: c.range, calendar: c.calendar, now: c.now }, main.rows, cmp?.rows, tgt?.rows)
      out[t.id] = { rows: fin.rows, filtered: !!main.filtered, truncated: !!main.truncated, ms: Math.max(main.ms, cmp?.ms ?? 0, tgt?.ms ?? 0) }
    } catch (e) {
      out[t.id] = { rows: [], error: e instanceof Error ? e.message : String(e) }
    }
  }
  return out
}
