/**
 * Relationship delete behaviours in the browser workspace (demo mode, P0 package M): the same rules as the server
 * (server/core/data.ts onParentDelete, server/core/model/delete-rules.ts), planned in memory before anything changes, so
 * a refused delete leaves every table as it was.
 *
 *  - restrict: refused while any child row (readable or not) points at a row being deleted;
 *  - cascade: the child rows are deleted too, with the same user's permissions (all or nothing), at most 8 levels;
 *  - set blank: the lookup of the child rows is cleared (a system write).
 * A lookup without a relationship record behaves as the designer's default: required -> restrict, optional -> set blank.
 * Read-only tables and system columns (createdBy, owner) are never touched.
 */
import type { ColumnDef, TableDef } from './contracts'
import { PlatformError } from './contracts'

export type DeleteBehaviourName = 'restrict' | 'cascade' | 'setBlank'
export interface RelationshipRecord { fromTable: string; fromColumn: string; toTable: string; onDelete: DeleteBehaviourName }

export const MAX_CASCADE_DEPTH = 8
const SYSTEM = new Set(['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner'])

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
export interface DeleteTable { def: TableDef; rows: Row[] }
export interface DeletePlan {
  /** table name -> ids to delete (the starting table included) */
  deletes: Map<string, Set<string>>
  /** child rows whose lookup is cleared */
  blanks: { table: string; id: string; column: string }[]
}

function childLinks(parent: TableDef, tables: DeleteTable[], records: RelationshipRecord[]): { child: DeleteTable; column: ColumnDef; onDelete: DeleteBehaviourName }[] {
  const name = parent.name.toLowerCase()
  const out: { child: DeleteTable; column: ColumnDef; onDelete: DeleteBehaviourName }[] = []
  for (const t of tables) {
    if (t.def.readOnly || t.def.reporting?.kind === 'view') continue
    for (const c of t.def.columns) {
      if (c.type !== 'lookup' || c.system || SYSTEM.has(c.name) || c.lookupTable?.toLowerCase() !== name) continue
      const r = records.find((x) => x.fromTable === t.def.id && x.fromColumn === c.name)
      let onDelete: DeleteBehaviourName = r?.onDelete ?? (c.required ? 'restrict' : 'setBlank')
      if (onDelete === 'setBlank' && c.required) onDelete = 'restrict'
      out.push({ child: t, column: c, onDelete })
    }
  }
  return out
}

/**
 * What deleting `ids` of `start` does. Throws PlatformError 'conflict' (restrict, too deep) or 'denied' (a cascaded row
 * the user may not delete), before anything is changed.
 */
export function planDelete(start: DeleteTable, ids: string[], tables: DeleteTable[], records: RelationshipRecord[], canDelete: (t: DeleteTable, row: Row) => boolean): DeletePlan {
  const plan: DeletePlan = { deletes: new Map(), blanks: [] }
  const seen = new Set<string>()
  const visit = (t: DeleteTable, targets: string[], depth: number) => {
    const set = plan.deletes.get(t.def.name) ?? new Set<string>()
    plan.deletes.set(t.def.name, set)
    for (const id of targets) { set.add(id); seen.add(`${t.def.id}:${id}`) }
    for (const link of childLinks(t.def, tables, records)) {
      const kill = new Set(targets)
      const rows = link.child.rows.filter((r) => kill.has(String(r[link.column.name] ?? '')) && !seen.has(`${link.child.def.id}:${String(r.id)}`))
      if (!rows.length) continue
      const what = `${rows.length} row${rows.length === 1 ? '' : 's'} in "${link.child.def.displayName || link.child.def.name}"`
      const col = link.column.displayName || link.column.name
      if (link.onDelete === 'restrict') {
        throw new PlatformError('conflict', `This cannot be deleted: ${what} still ${rows.length === 1 ? 'refers' : 'refer'} to it (${col}). Delete or change ${rows.length === 1 ? 'that row' : 'those rows'} first.`)
      }
      if (link.onDelete === 'cascade') {
        if (depth + 1 > MAX_CASCADE_DEPTH) throw new PlatformError('conflict', `Deleting this would cascade through more than ${MAX_CASCADE_DEPTH} levels of related tables. Delete the deepest rows first.`)
        const refused = rows.filter((r) => !canDelete(link.child, r)).length
        if (refused) throw new PlatformError('denied', `Deleting this also deletes ${what} (${col}), and you are not allowed to delete ${refused === rows.length ? (rows.length === 1 ? 'it' : 'them') : `${refused} of them`}. Nothing was deleted.`)
        visit(link.child, rows.map((r) => String(r.id)), depth + 1)
        continue
      }
      for (const r of rows) plan.blanks.push({ table: link.child.def.name, id: String(r.id), column: link.column.name })
    }
  }
  visit(start, ids, 0)
  // a row that is deleted is not also blanked
  plan.blanks = plan.blanks.filter((b) => !plan.deletes.get(b.table)?.has(b.id))
  return plan
}
