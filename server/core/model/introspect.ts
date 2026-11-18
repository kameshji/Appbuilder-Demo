/**
 * Import a model from an existing database connection (PostgreSQL, MySQL/MariaDB): its tables, columns and
 * single-column foreign keys, as new draft tables.
 *  - link: the tables stay where they are and are registered (POST /connections/:id/link at apply). A foreign key
 *    becomes a lookup only when it points at the parent's `id` column (lookups hold row ids).
 *  - copy: new tables in the default database with the same columns; every foreign key becomes a lookup. Structure
 *    only: rows are copied afterwards (table page > Move, or a CSV import).
 */
import type { ColumnDef, ColumnType } from '../../../src/platform/contracts.ts'
import type { DeleteBehaviour, Model } from '../../../src/model/types.ts'
import { addTable, clone, defaultDeleteBehaviour, newRelId, tableById } from '../../../src/model/ops.ts'
import { IDENT, SYSTEM_COLUMN_NAMES, toIdentifier } from '../../../src/model/names.ts'
import type { Services } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import { resolveConnection } from '../../routes/meta/tables-core.ts'

const fkDelete = (v: string | undefined): DeleteBehaviour | undefined =>
  v === 'cascade' ? 'cascade' : v === 'set null' ? 'setBlank' : v === 'restrict' || v === 'no action' ? 'restrict' : undefined

export interface IntrospectResult {
  model: Model
  /** new draft table ids */
  tables: string[]
  warnings: string[]
  /** sources found (all, including skipped) */
  found: number
}

export async function introspect(s: Services, connectionId: string, mode: 'link' | 'copy', into: Model, only?: string[]): Promise<IntrospectResult> {
  const { record, connector } = await resolveConnection(s, connectionId)
  if (record.connector !== 'postgres' && record.connector !== 'mysql') throw new HttpError(422, 'invalid', 'Only PostgreSQL and MySQL/MariaDB connections can be read into a model.')
  let sources: Awaited<ReturnType<typeof connector.listSourceTables>>
  let fks: Awaited<ReturnType<NonNullable<typeof connector.foreignKeys>>> = []
  try {
    sources = await connector.listSourceTables()
    fks = connector.foreignKeys ? await connector.foreignKeys() : []
  } catch (e) {
    throw new HttpError(422, 'invalid', `Could not read the tables of "${record.name}": ${(e as Error).message}`)
  }
  const warnings: string[] = []
  let model = clone(into)
  const registered = await s.meta.tables.list()
  const linked = new Set(registered.filter((t) => t.connectionId === record.id && t.source).map((t) => t.source!.toLowerCase()))
  const made = new Map<string, string>()
  const wanted = only?.length ? new Set(only.map((x) => x.toLowerCase())) : null
  for (const src of sources) {
    if (wanted && !wanted.has(src.source.toLowerCase())) continue
    if (mode === 'link' && linked.has(src.source.toLowerCase())) { warnings.push(`${src.source} is already linked: skipped.`); continue }
    const cols: Partial<ColumnDef>[] = []
    for (const c of src.columns) {
      if (SYSTEM_COLUMN_NAMES.includes(c.name)) continue
      if (!IDENT.test(c.name)) { warnings.push(`${src.source}.${c.name}: the name cannot be used by Appbuilder; skipped.`); continue }
      cols.push({ name: c.name, displayName: c.name, type: (c.type === 'lookup' ? 'text' : c.type) as ColumnType, ...(c.type === 'choice' ? { choices: [] } : {}) })
    }
    const display = toIdentifier(src.source, 'Table')
    const res = addTable(model, { displayName: src.source, name: display, columns: cols.length ? cols : [{ displayName: 'Name', type: 'text' }] })
    model = res.model
    const t = tableById(model, res.table.id)!
    if (mode === 'link') t.link = { connectionId: record.id, source: src.source }
    made.set(src.source.toLowerCase(), t.id)
  }
  for (const fk of fks) {
    const childId = made.get(fk.table.toLowerCase())
    const parentId = made.get(fk.refTable.toLowerCase()) ?? registered.find((t) => t.connectionId === record.id && t.source?.toLowerCase() === fk.refTable.toLowerCase())?.id
    if (!childId || !parentId) continue
    const child = tableById(model, childId)!
    const parent = tableById(model, parentId) ?? registered.find((t) => t.id === parentId)!
    const col = child.columns.find((c) => c.name === fk.column)
    if (!col) continue
    if (mode === 'link' && fk.refColumn !== 'id') {
      warnings.push(`${fk.table}.${fk.column} refers to ${fk.refTable}.${fk.refColumn}: not a lookup (lookups hold the parent's id).`)
      continue
    }
    col.type = 'lookup'
    col.lookupTable = parent.name
    delete col.choices
    const onDelete = fkDelete(fk.onDelete) ?? defaultDeleteBehaviour(col)
    model.relationships.push({ id: newRelId(), fromTable: childId, fromColumn: col.name, toTable: parent.id, kind: parent.id === childId ? 'self' : 'oneToMany', onDelete: onDelete === 'setBlank' && col.required ? 'restrict' : onDelete })
  }
  return { model, tables: [...made.values()], warnings, found: sources.length }
}
