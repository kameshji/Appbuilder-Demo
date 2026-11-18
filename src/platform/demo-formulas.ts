/**
 * Demo mode: formula columns (ColumnDef.computed kind formula) computed in the browser with the same row-rule code the
 * server's table events use (src/fx/rowrules.ts). Rollups, validation rules and events need the server (job queue,
 * run log); the table designer says so in demo mode.
 */
import type { FxRecord, FxValue } from '@/contracts'
import type { ColumnDef, TableDef } from './contracts'
import { createEngine } from '@/fx/engine'
import { formulaColumnOrder, formulaInputs, recordScope, userRecord } from '@/fx/rowrules'

const engine = createEngine()

const asFormula = (f: string) => (f.trim().startsWith('=') ? f.trim() : `=${f.trim()}`)

/** a value of the column's kind, or blank (a formula that gives a table, record or wrong kind stores blank) */
function fit(col: ColumnDef, v: FxValue): FxValue {
  if (v === null || v === undefined) return null
  if (Array.isArray(v) || (typeof v === 'object' && !(v instanceof Date))) return null
  if (['number', 'decimal', 'currency'].includes(col.type)) return typeof v === 'number' && Number.isFinite(v) ? v : null
  if (col.type === 'boolean') return typeof v === 'boolean' ? v : null
  if (col.type === 'date' || col.type === 'datetime') return v instanceof Date ? v : null
  return typeof v === 'string' ? v : String(v)
}

/**
 * Sets the formula columns of `row` in place (dependency order). `changed`: the columns a write changed (only formulas
 * reading one of them run); null: all. `tables` resolves other tables by name (read-only).
 */
export function applyFormulaColumns(def: TableDef, row: FxRecord, changed: Set<string> | null, tables: (name: string) => FxRecord[] | undefined, user?: { id?: string; name?: string; email?: string }): void {
  const cols = def.columns.filter((c) => c.computed?.kind === 'formula')
  if (!cols.length) return
  const names = ['id', ...def.columns.map((c) => c.name)]
  const specs = cols.map((c) => ({ name: c.name, formula: (c.computed as { formula: string }).formula }))
  const { order } = formulaColumnOrder(specs, names)
  const touched = new Set(changed ?? [])
  const scope = recordScope(row, null, userRecord(user ?? null), { resolve: (n) => tables(n) })
  for (const n of order) {
    const col = cols.find((c) => c.name === n)!
    const f = asFormula((col.computed as { formula: string }).formula)
    if (changed && ![...formulaInputs(f, names)].some((x) => touched.has(x))) continue
    const r = engine.evaluate(f, scope)
    row[n] = r.ok ? fit(col, r.value) : null
    touched.add(n)
  }
}
