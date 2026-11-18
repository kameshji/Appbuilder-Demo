/**
 * Which relationships act when rows of a table are deleted (DataService, data.ts), and which self lookups refuse loops.
 * A lookup column always has a behaviour: its relationship record (ab_relationships) or, when it has none yet (a lookup
 * added outside the designer and not synced), the default: required -> restrict, optional -> set blank.
 */
import type { ColumnDef, TableDef } from '../../../src/platform/contracts.ts'
import type { DeleteBehaviour, RelationshipDef } from '../../../src/model/types.ts'
import { defaultDeleteBehaviour } from '../../../src/model/ops.ts'

const SYSTEM = new Set(['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner'])

/** cascades deeper than this are refused (409) */
export const MAX_CASCADE_DEPTH = 8

export interface ChildRelationship {
  child: TableDef
  column: ColumnDef
  onDelete: DeleteBehaviour
}

/**
 * relationships whose parent is `def`, with their child table and lookup column. Read-only tables (reporting views,
 * read-only links) never hold data the platform may change, so they are skipped.
 */
export async function childRelationships(def: TableDef, tables: () => Promise<TableDef[]>, records: ((tableId: string) => Promise<RelationshipDef[]>) | null): Promise<ChildRelationship[]> {
  const all = await tables()
  const parentName = def.name.toLowerCase()
  const lookups: { child: TableDef; column: ColumnDef }[] = []
  for (const t of all) {
    if (t.readOnly || t.reporting?.kind === 'view') continue
    // system columns (createdBy, owner) keep their values: the people they name are not deleted through tables
    for (const c of t.columns) if (c.type === 'lookup' && !c.system && !SYSTEM.has(c.name) && c.lookupTable?.toLowerCase() === parentName) lookups.push({ child: t, column: c })
  }
  if (!lookups.length) return []
  const recs = records ? await records(def.id) : []
  return lookups.map(({ child, column }) => {
    const r = recs.find((x) => x.fromTable === child.id && x.fromColumn === column.name)
    let onDelete = r?.onDelete ?? defaultDeleteBehaviour(column)
    // a required lookup can never be cleared
    if (onDelete === 'setBlank' && column.required) onDelete = 'restrict'
    return { child, column, onDelete }
  })
}

/** names of the self-lookup columns of `def` whose relationship prevents cycles */
export async function selfCycleColumns(def: TableDef, list: () => Promise<RelationshipDef[]>): Promise<Set<string>> {
  const out = new Set<string>()
  for (const r of await list()) if (r.fromTable === def.id && r.toTable === def.id && r.preventCycles) out.add(r.fromColumn)
  return out
}
