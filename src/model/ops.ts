/**
 * Model editing and diffing (pure). The designer edits a Model with the helpers below; diffModels(base, draft) turns the
 * edits into ModelOps; applyOps(model, ops) replays ops onto a model (rebase onto a newer live schema, pattern
 * previews, data model templates). checkOps(live, ops) lists the problems the server would refuse.
 */
import type { ColumnDef, ColumnType, TableDef } from '../platform/contracts.ts'
import type { DeleteBehaviour, Model, ModelOp, ModelTable, RelationshipDef, RelationshipKind } from './types.ts'
import { NEW_ID_PREFIX, isNewId, isSystemTable } from './types.ts'
import { IDENT, MAX_IDENT, SYSTEM_COLUMN_NAMES, shortHex, toIdentifier, uniqueIdentifier } from './names.ts'

/* ------------------------------------------------------------------ basics */

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

export function systemColumnDefs(): ColumnDef[] {
  return [
    { name: 'id', displayName: 'Id', type: 'text', system: true },
    { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true },
    { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime', system: true },
    { name: 'createdBy', displayName: 'Created by', type: 'text', system: true },
    { name: 'owner', displayName: 'Owner', type: 'text', system: true },
  ]
}

export const isSystemColumn = (c: ColumnDef): boolean => !!c.system || SYSTEM_COLUMN_NAMES.includes(c.name)
export const userColumns = (t: TableDef): ColumnDef[] => t.columns.filter((c) => !isSystemColumn(c))

export function tableById(m: Model, id: string): ModelTable | undefined {
  return m.tables.find((t) => t.id === id)
}
export function tableByName(m: Model, name: string | undefined): ModelTable | undefined {
  if (!name) return undefined
  const n = name.toLowerCase()
  return m.tables.find((t) => t.name.toLowerCase() === n) ?? m.tables.find((t) => t.id === name)
}

export const newTableId = (): string => `${NEW_ID_PREFIX}${shortHex(10)}`
export const newRelId = (): string => `rel_${shortHex(12)}`

/** default behaviour of a lookup without an explicit relationship (also what the version 7 migration records) */
export function defaultDeleteBehaviour(col: ColumnDef): DeleteBehaviour {
  return col.required ? 'restrict' : 'setBlank'
}

/* ------------------------------------------------------------------ editing helpers (return a new model) */

export function addTable(m: Model, input: { displayName: string; name?: string; columns?: Partial<ColumnDef>[]; id?: string; description?: string; reporting?: TableDef['reporting']; uniqueTogether?: string[][] }): { model: Model; table: ModelTable } {
  const next = clone(m)
  const name = input.name && IDENT.test(input.name) ? uniqueIdentifier(input.name, next.tables.map((t) => t.name)) : uniqueIdentifier(toIdentifier(input.displayName, 'Table'), next.tables.map((t) => t.name))
  const cols: ColumnDef[] = []
  const requested = input.columns?.length ? input.columns : [{ displayName: 'Name', type: 'text' as ColumnType, required: true }]
  for (const p of requested) cols.push(makeColumn(p, [...SYSTEM_COLUMN_NAMES, ...cols.map((c) => c.name)]))
  const now = new Date().toISOString()
  const table: ModelTable = {
    id: input.id ?? newTableId(), name, displayName: input.displayName.trim() || name,
    primaryColumn: (cols.find((c) => c.type === 'text' || c.type === 'autonumber') ?? cols[0])?.name ?? 'id',
    columns: [...systemColumnDefs(), ...cols], createdOn: now, modifiedOn: now,
  }
  if (input.description) table.description = input.description
  if (input.reporting) table.reporting = input.reporting
  if (input.uniqueTogether?.length) table.uniqueTogether = input.uniqueTogether
  next.tables.push(table)
  return { model: next, table }
}

/** a column from a partial definition; the identifier is derived from the display name unless given */
export function makeColumn(p: Partial<ColumnDef>, taken: string[]): ColumnDef {
  const displayName = (p.displayName ?? p.name ?? 'Column').trim() || 'Column'
  const name = p.name && IDENT.test(p.name) && p.name.length <= MAX_IDENT && !taken.some((t) => t.toLowerCase() === p.name!.toLowerCase())
    ? p.name
    : uniqueIdentifier(toIdentifier(displayName, 'Column'), taken)
  const col: ColumnDef = { ...p, name, displayName, type: p.type ?? 'text' } as ColumnDef
  for (const k of Object.keys(col) as (keyof ColumnDef)[]) if (col[k] === undefined) delete col[k]
  if (col.type === 'choice' && !col.choices) col.choices = []
  return col
}

export function removeTable(m: Model, id: string): Model {
  const next = clone(m)
  const t = tableById(next, id)
  if (!t) return next
  next.tables = next.tables.filter((x) => x.id !== id)
  // lookups (and rollups) that point at it go, and so do its relationships
  for (const other of next.tables) {
    other.columns = other.columns.filter((c) => !(c.type === 'lookup' && c.lookupTable?.toLowerCase() === t.name.toLowerCase())
      && !(c.computed?.kind === 'rollup' && (c.computed.table.toLowerCase() === t.name.toLowerCase() || c.computed.table === t.id)))
    if (other.primaryColumn && !other.columns.some((c) => c.name === other.primaryColumn)) other.primaryColumn = userColumns(other)[0]?.name ?? 'id'
  }
  next.relationships = next.relationships.filter((r) => r.fromTable !== id && r.toTable !== id)
  return next
}

export function updateTable(m: Model, id: string, patch: Partial<Pick<TableDef, 'displayName' | 'description' | 'primaryColumn' | 'uniqueTogether'>>): Model {
  const next = clone(m)
  const t = tableById(next, id)
  if (!t) return next
  if (patch.displayName !== undefined) t.displayName = patch.displayName.trim() || t.displayName
  if (patch.description !== undefined) {
    if (patch.description) t.description = patch.description
    else delete t.description
  }
  if (patch.primaryColumn !== undefined && t.columns.some((c) => c.name === patch.primaryColumn)) t.primaryColumn = patch.primaryColumn
  if (patch.uniqueTogether !== undefined) {
    if (patch.uniqueTogether.length) t.uniqueTogether = patch.uniqueTogether
    else delete t.uniqueTogether
  }
  return next
}

export function addColumn(m: Model, tableId: string, p: Partial<ColumnDef>): { model: Model; column: ColumnDef | null } {
  const next = clone(m)
  const t = tableById(next, tableId)
  if (!t) return { model: next, column: null }
  const col = makeColumn(p, t.columns.map((c) => c.name))
  t.columns.push(col)
  return { model: next, column: col }
}

export function updateColumn(m: Model, tableId: string, name: string, patch: Partial<ColumnDef>): Model {
  const next = clone(m)
  const t = tableById(next, tableId)
  const c = t?.columns.find((x) => x.name === name)
  if (!t || !c || isSystemColumn(c)) return next
  const merged = { ...c, ...patch, name: c.name } as ColumnDef
  for (const k of Object.keys(merged) as (keyof ColumnDef)[]) if (merged[k] === undefined || (merged[k] === false && (k === 'required' || k === 'unique' || k === 'indexed'))) delete merged[k]
  if (merged.type !== 'lookup') delete merged.lookupTable
  if (merged.type !== 'choice') delete merged.choices
  else if (!merged.choices) merged.choices = []
  if (merged.type !== 'autonumber') delete merged.prefix
  t.columns = t.columns.map((x) => (x.name === name ? merged : x))
  // the relationship follows its lookup column
  if (c.type === 'lookup' && (merged.type !== 'lookup' || merged.lookupTable?.toLowerCase() !== c.lookupTable?.toLowerCase())) {
    next.relationships = next.relationships.filter((r) => !(r.fromTable === tableId && r.fromColumn === name))
  }
  if (merged.type === 'lookup') {
    const rel = next.relationships.find((r) => r.fromTable === tableId && r.fromColumn === name)
    if (rel) {
      if (rel.onDelete === 'setBlank' && merged.required) rel.onDelete = 'restrict'
      rel.kind = rel.kind === 'self' ? 'self' : merged.unique ? 'oneToOne' : 'oneToMany'
    }
  }
  return next
}

export function removeColumn(m: Model, tableId: string, name: string): Model {
  const next = clone(m)
  const t = tableById(next, tableId)
  if (!t) return next
  const c = t.columns.find((x) => x.name === name)
  if (!c || isSystemColumn(c)) return next
  t.columns = t.columns.filter((x) => x.name !== name)
  if (t.primaryColumn === name) t.primaryColumn = userColumns(t)[0]?.name ?? 'id'
  if (t.uniqueTogether) {
    t.uniqueTogether = t.uniqueTogether.filter((set) => !set.includes(name))
    if (!t.uniqueTogether.length) delete t.uniqueTogether
  }
  next.relationships = next.relationships.filter((r) => !(r.fromTable === tableId && r.fromColumn === name))
  return next
}

export interface RelationshipInput {
  /** the "one" side (parent) */
  parent: string
  /** the "many" side (child); for many-to-many the other table */
  child: string
  cardinality: 'oneToMany' | 'oneToOne' | 'manyToMany' | 'self'
  onDelete: DeleteBehaviour
  required?: boolean
  /** display name of the lookup column (default: the parent's display name) */
  columnName?: string
  preventCycles?: boolean
  /** many-to-many: display name of the junction table and extra columns on it */
  junctionName?: string
  junctionColumns?: Partial<ColumnDef>[]
  /** many-to-many: behaviour of the junction rows when either side is deleted (default cascade) */
}

/** creates the lookup column(s) and the relationship record(s); returns ids of what it made */
export function createRelationship(m: Model, input: RelationshipInput): { model: Model; relationships: RelationshipDef[]; junction?: ModelTable } {
  let next = clone(m)
  const parent = tableById(next, input.parent)
  const child = tableById(next, input.child)
  if (!parent || !child) throw new Error('Both tables must exist.')
  if (input.cardinality === 'manyToMany') {
    const display = input.junctionName?.trim() || `${child.displayName} ${parent.displayName}`
    const a = toIdentifier(child.displayName, 'Left')
    let b = toIdentifier(parent.displayName, 'Right')
    if (b.toLowerCase() === a.toLowerCase()) b = `${b}2`
    const made = addTable(next, {
      displayName: display,
      columns: [
        { name: a, displayName: child.displayName, type: 'lookup', lookupTable: child.name, required: true },
        { name: b, displayName: parent.displayName, type: 'lookup', lookupTable: parent.name, required: true },
        ...(input.junctionColumns ?? []),
      ],
      uniqueTogether: [[a, b]],
    })
    next = made.model
    const j = tableById(next, made.table.id)!
    j.primaryColumn = a
    const group = `m2m_${shortHex(8)}`
    const rels: RelationshipDef[] = [
      { id: newRelId(), fromTable: j.id, fromColumn: a, toTable: child.id, kind: 'oneToMany', onDelete: 'cascade', junction: { group } },
      { id: newRelId(), fromTable: j.id, fromColumn: b, toTable: parent.id, kind: 'oneToMany', onDelete: 'cascade', junction: { group } },
    ]
    next.relationships.push(...rels)
    return { model: next, relationships: rels, junction: j }
  }
  const self = input.cardinality === 'self' || parent.id === child.id
  const display = input.columnName?.trim() || (self ? 'Parent' : parent.displayName)
  const p: Partial<ColumnDef> = { displayName: display, type: 'lookup', lookupTable: parent.name }
  if (input.required && !self) p.required = true
  if (input.cardinality === 'oneToOne') p.unique = true
  const res = addColumn(next, child.id, p)
  next = res.model
  const col = res.column!
  let onDelete = input.onDelete
  if (onDelete === 'setBlank' && p.required) onDelete = 'restrict'
  const rel: RelationshipDef = {
    id: newRelId(), fromTable: child.id, fromColumn: col.name, toTable: parent.id,
    kind: self ? 'self' : input.cardinality === 'oneToOne' ? 'oneToOne' : 'oneToMany', onDelete,
  }
  if (self && input.preventCycles !== false) rel.preventCycles = true
  next.relationships.push(rel)
  return { model: next, relationships: [rel] }
}

export function updateRelationship(m: Model, id: string, patch: Partial<Pick<RelationshipDef, 'onDelete' | 'preventCycles'>> & { required?: boolean }): Model {
  let next = clone(m)
  const rel = next.relationships.find((r) => r.id === id)
  if (!rel) return next
  if (patch.required !== undefined) {
    next = updateColumn(next, rel.fromTable, rel.fromColumn, { required: patch.required || undefined })
  }
  const r2 = next.relationships.find((r) => r.id === id)!
  if (patch.onDelete) r2.onDelete = patch.onDelete
  if (patch.preventCycles !== undefined) {
    if (patch.preventCycles) r2.preventCycles = true
    else delete r2.preventCycles
  }
  const col = tableById(next, r2.fromTable)?.columns.find((c) => c.name === r2.fromColumn)
  if (r2.onDelete === 'setBlank' && col?.required) r2.onDelete = 'restrict'
  return next
}

/** removes the relationship and its lookup column (and a junction table when it was the last side) */
export function removeRelationship(m: Model, id: string): Model {
  const rel = m.relationships.find((r) => r.id === id)
  if (!rel) return m
  if (rel.junction) {
    const sides = m.relationships.filter((r) => r.junction?.group === rel.junction!.group)
    const junction = tableById(m, rel.fromTable)
    if (junction && sides.every((s) => s.fromTable === junction.id)) return removeTable(m, junction.id)
  }
  return removeColumn(m, rel.fromTable, rel.fromColumn)
}

/**
 * Lookup columns without a relationship record get one with the default behaviour (the server records the same at
 * migration); records whose lookup column is gone are dropped.
 */
export function withImplicitRelationships(m: Model): Model {
  const next = clone(m)
  const keep: RelationshipDef[] = []
  for (const r of next.relationships) {
    const t = tableById(next, r.fromTable)
    const c = t?.columns.find((x) => x.name === r.fromColumn)
    const target = c?.type === 'lookup' && !isSystemColumn(c) ? tableByName(next, c.lookupTable) : undefined
    if (t && c && target && target.id === r.toTable) keep.push(r)
  }
  next.relationships = keep
  for (const t of next.tables) {
    for (const c of t.columns) {
      // system columns (createdBy, owner: lookups to the system User table) are not modelled relationships
      if (c.type !== 'lookup' || isSystemColumn(c) || keep.some((r) => r.fromTable === t.id && r.fromColumn === c.name)) continue
      const target = tableByName(next, c.lookupTable)
      if (!target) continue
      next.relationships.push({
        id: `rel_${t.id}_${c.name}`.slice(0, 64), fromTable: t.id, fromColumn: c.name, toTable: target.id,
        kind: target.id === t.id ? 'self' : c.unique ? 'oneToOne' : 'oneToMany', onDelete: defaultDeleteBehaviour(c),
      })
    }
  }
  return next
}

/* ------------------------------------------------------------------ diff */

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x))
const sameColumn = (a: ColumnDef, b: ColumnDef): boolean => stable(a) === stable(b)

/** the operations that turn `base` into `draft` (in a valid execution order) */
export function diffModels(base: Model, draft: Model): ModelOp[] {
  const ops: ModelOp[] = []
  const baseIds = new Set(base.tables.map((t) => t.id))
  const draftIds = new Set(draft.tables.map((t) => t.id))
  // relationships dropped first (their columns may go next)
  const baseRels = new Map(base.relationships.map((r) => [r.id, r]))
  const draftRels = new Map(draft.relationships.map((r) => [r.id, r]))
  for (const r of base.relationships) if (!draftRels.has(r.id)) ops.push({ op: 'dropRelationship', id: r.id })
  for (const t of draft.tables) if (!baseIds.has(t.id)) ops.push({ op: 'createTable', table: clone(t) })
  for (const t of draft.tables) {
    const b = base.tables.find((x) => x.id === t.id)
    if (!b) continue
    const patch: Extract<ModelOp, { op: 'updateTable' }>['patch'] = {}
    if (b.displayName !== t.displayName) patch.displayName = t.displayName
    if ((b.description ?? '') !== (t.description ?? '')) patch.description = t.description ?? ''
    if (b.primaryColumn !== t.primaryColumn) patch.primaryColumn = t.primaryColumn
    if (stable(b.uniqueTogether ?? []) !== stable(t.uniqueTogether ?? [])) patch.uniqueTogether = t.uniqueTogether ?? []
    for (const c of t.columns) {
      const bc = b.columns.find((x) => x.name === c.name)
      if (!bc) ops.push({ op: 'addColumn', table: t.id, column: clone(c) })
      else if (!sameColumn(bc, c)) ops.push({ op: 'updateColumn', table: t.id, name: c.name, before: clone(bc), after: clone(c) })
    }
    // the display column may name a new column: the patch goes after the column ops
    if (Object.keys(patch).length) ops.push({ op: 'updateTable', id: t.id, patch })
    for (const bc of b.columns) if (!t.columns.some((c) => c.name === bc.name)) ops.push({ op: 'dropColumn', table: t.id, name: bc.name })
  }
  for (const b of base.tables) if (!draftIds.has(b.id)) ops.push({ op: 'dropTable', id: b.id, name: b.name })
  for (const r of draft.relationships) {
    const b = baseRels.get(r.id)
    if (!b) ops.push({ op: 'putRelationship', rel: clone(r) })
    else if (stable(b) !== stable(r)) ops.push({ op: 'putRelationship', rel: clone(r), before: clone(b) })
  }
  return ops
}

/* ------------------------------------------------------------------ apply (pure) */

/** replays ops onto a model; ops that no longer fit (the target changed) are skipped and listed */
export function applyOps(m: Model, ops: ModelOp[]): { model: Model; conflicts: string[] } {
  const next = clone(m)
  const conflicts: string[] = []
  const name = (id: string) => tableById(next, id)?.displayName ?? id
  for (const o of ops) {
    switch (o.op) {
      case 'createTable': {
        if (tableById(next, o.table.id)) { conflicts.push(`Table "${o.table.displayName}" already exists.`); break }
        if (tableByName(next, o.table.name)) { conflicts.push(`A table named "${o.table.name}" already exists.`); break }
        next.tables.push(clone(o.table))
        break
      }
      case 'updateTable': {
        const t = tableById(next, o.id)
        if (!t) { conflicts.push(`Table ${o.id} no longer exists.`); break }
        if (o.patch.displayName !== undefined) t.displayName = o.patch.displayName
        if (o.patch.description !== undefined) { if (o.patch.description) t.description = o.patch.description; else delete t.description }
        if (o.patch.primaryColumn !== undefined) t.primaryColumn = o.patch.primaryColumn
        if (o.patch.uniqueTogether !== undefined) { if (o.patch.uniqueTogether.length) t.uniqueTogether = o.patch.uniqueTogether; else delete t.uniqueTogether }
        break
      }
      case 'dropTable': {
        if (!tableById(next, o.id)) { conflicts.push(`Table "${o.name}" was already removed.`); break }
        next.tables = next.tables.filter((t) => t.id !== o.id)
        next.relationships = next.relationships.filter((r) => r.fromTable !== o.id && r.toTable !== o.id)
        break
      }
      case 'addColumn': {
        const t = tableById(next, o.table)
        if (!t) { conflicts.push(`Table ${o.table} no longer exists.`); break }
        if (t.columns.some((c) => c.name.toLowerCase() === o.column.name.toLowerCase())) { conflicts.push(`${t.displayName} already has a column "${o.column.name}".`); break }
        t.columns.push(clone(o.column))
        break
      }
      case 'updateColumn': {
        const t = tableById(next, o.table)
        const i = t ? t.columns.findIndex((c) => c.name === o.name) : -1
        if (!t || i < 0) { conflicts.push(`${name(o.table)}.${o.name} no longer exists.`); break }
        if (!sameColumn(t.columns[i], o.before)) { conflicts.push(`${t.displayName}.${t.columns[i].displayName} was changed by someone else.`); break }
        t.columns[i] = clone(o.after)
        break
      }
      case 'dropColumn': {
        const t = tableById(next, o.table)
        if (!t || !t.columns.some((c) => c.name === o.name)) { conflicts.push(`${name(o.table)}.${o.name} was already removed.`); break }
        t.columns = t.columns.filter((c) => c.name !== o.name)
        break
      }
      case 'putRelationship': {
        const i = next.relationships.findIndex((r) => r.id === o.rel.id)
        if (i >= 0) next.relationships[i] = clone(o.rel)
        else next.relationships.push(clone(o.rel))
        break
      }
      case 'dropRelationship':
        next.relationships = next.relationships.filter((r) => r.id !== o.id)
        break
    }
  }
  return { model: next, conflicts }
}

/* ------------------------------------------------------------------ checks */

/**
 * Problems that block applying `ops` to `live` (the server runs the same checks, then its own: row counts, conversions,
 * permissions). Words for makers.
 */
export function checkOps(live: Model, ops: ModelOp[]): string[] {
  const problems: string[] = []
  const { model: after, conflicts } = applyOps(live, ops)
  problems.push(...conflicts)
  const tableLabel = (id: string) => tableById(after, id)?.displayName ?? tableById(live, id)?.displayName ?? id
  for (const o of ops) {
    const touched = o.op === 'createTable' ? null : o.op === 'updateTable' || o.op === 'dropTable' ? o.id : o.op === 'putRelationship' || o.op === 'dropRelationship' ? null : o.table
    const t = touched ? tableById(live, touched) : undefined
    if (t && isSystemTable(t)) {
      const userCol = o.op === 'addColumn'
      if (!userCol) problems.push(`"${t.displayName}" is a system table: only new columns can be added to it.`)
    }
    if (t?.reporting?.kind === 'view' && o.op !== 'dropTable') problems.push(`"${t.displayName}" is a reporting view: remove it and generate it again instead of editing it.`)
    if (o.op === 'createTable') {
      if (!IDENT.test(o.table.name) || o.table.name.length > MAX_IDENT) problems.push(`"${o.table.name}" is not a valid table name.`)
      if (o.table.name.toLowerCase().startsWith('ab_')) problems.push(`Table names cannot start with "ab_" (${o.table.name}).`)
    }
  }
  // the resulting model must be consistent
  const names = new Set<string>()
  for (const t of after.tables) {
    const n = t.name.toLowerCase()
    if (names.has(n)) problems.push(`Two tables are named "${t.name}".`)
    names.add(n)
    const cn = new Set<string>()
    for (const c of t.columns) {
      const k = c.name.toLowerCase()
      if (cn.has(k)) problems.push(`${t.displayName} has two columns named "${c.name}".`)
      cn.add(k)
      if (c.type === 'lookup' && !tableByName(after, c.lookupTable)) problems.push(`${t.displayName}.${c.displayName} looks up "${c.lookupTable ?? ''}", which does not exist.`)
      if (c.computed?.kind === 'rollup' && !tableByName(after, c.computed.table)) problems.push(`${t.displayName}.${c.displayName} rolls up "${c.computed.table}", which does not exist.`)
    }
    for (const set of t.uniqueTogether ?? []) {
      for (const col of set) if (!t.columns.some((c) => c.name === col)) problems.push(`${t.displayName}: the unique pair names a missing column "${col}".`)
    }
    if (t.reporting?.kind === 'view' && !tableById(after, t.reporting.base)) problems.push(`The reporting view "${t.displayName}" reads a table that does not exist.`)
  }
  for (const r of after.relationships) {
    const from = tableById(after, r.fromTable)
    const col = from?.columns.find((c) => c.name === r.fromColumn)
    if (!from || !col || col.type !== 'lookup') { problems.push(`A relationship of ${tableLabel(r.fromTable)} has no lookup column "${r.fromColumn}".`); continue }
    const target = tableByName(after, col.lookupTable)
    if (!target || target.id !== r.toTable) problems.push(`${from.displayName}.${col.displayName}: the relationship does not match the lookup's table.`)
    if (r.onDelete === 'setBlank' && col.required) problems.push(`${from.displayName}.${col.displayName} is required, so "set blank" cannot be its delete behaviour.`)
  }
  for (const c of requiredCycles(after)) problems.push(`Required lookups form a circle (${c}): no row could ever be created first. Make one of them optional.`)
  return [...new Set(problems)]
}

/** cycles of required lookups between different tables, as "A → B → A" */
export function requiredCycles(m: Model): string[] {
  const edges = new Map<string, string[]>()
  for (const t of m.tables) {
    for (const c of t.columns) {
      if (c.type !== 'lookup' || !c.required) continue
      const target = tableByName(m, c.lookupTable)
      if (!target || target.id === t.id) continue
      edges.set(t.id, [...(edges.get(t.id) ?? []), target.id])
    }
  }
  const out: string[] = []
  const seen = new Set<string>()
  const state = new Map<string, 1 | 2>()
  const stack: string[] = []
  const visit = (id: string): void => {
    state.set(id, 1)
    stack.push(id)
    for (const n of edges.get(id) ?? []) {
      if (state.get(n) === 1) {
        const cycle = stack.slice(stack.indexOf(n)).concat(n)
        const key = [...cycle.slice(0, -1)].sort().join(',')
        if (!seen.has(key)) {
          seen.add(key)
          out.push(cycle.map((x) => tableById(m, x)?.displayName ?? x).join(' → '))
        }
      } else if (!state.has(n)) visit(n)
    }
    stack.pop()
    state.set(id, 2)
  }
  for (const id of edges.keys()) if (!state.has(id)) visit(id)
  return out
}

/** a short line per op, for logs and the audit entry */
export function describeOp(m: Model, o: ModelOp): string {
  const t = (id: string) => tableById(m, id)?.displayName ?? id
  switch (o.op) {
    case 'createTable': return `create table ${o.table.displayName}`
    case 'updateTable': return `change table ${t(o.id)}`
    case 'dropTable': return `remove table ${o.name}`
    case 'addColumn': return `add ${t(o.table)}.${o.column.displayName}`
    case 'updateColumn': return `change ${t(o.table)}.${o.after.displayName}`
    case 'dropColumn': return `remove ${t(o.table)}.${o.name}`
    case 'putRelationship': return `${o.before ? 'change' : 'add'} relationship ${t(o.rel.fromTable)}.${o.rel.fromColumn} → ${t(o.rel.toTable)}`
    case 'dropRelationship': return `remove relationship ${o.id}`
  }
}

/** ids of new tables in ops (they get real ids when applied) */
export const newTablesOf = (ops: ModelOp[]): string[] => ops.flatMap((o) => (o.op === 'createTable' && isNewId(o.table.id) ? [o.table.id] : []))

export type { RelationshipKind }
