/**
 * Infer a model from spreadsheet data (pure): one table per sheet, column types from the values, candidate keys
 * (unique, non-blank, key-like name), and likely relationships, by column name (CustomerId, Customer code, Customer)
 * and by value overlap (at least 90% of a column's values are keys of another sheet). The maker confirms in a dialog.
 */
import type { ColumnDef, ColumnType } from '../platform/contracts.ts'
import type { Model } from './types.ts'
import { addTable, clone, defaultDeleteBehaviour, newRelId, tableById } from './ops.ts'
import { toIdentifier } from './names.ts'

export interface SheetData {
  name: string
  headers: string[]
  rows: string[][]
}

export interface InferredColumn {
  header: string
  name: string
  type: ColumnType
  blank: number
  distinct: number
  /** unique and never blank */
  candidateKey: boolean
}
export interface InferredTable {
  sheet: string
  displayName: string
  name: string
  rows: number
  columns: InferredColumn[]
  /** the column chosen as the key others refer to (the first candidate key with a key-like name, else the first) */
  key?: string
}
export interface InferredRelationship {
  /** sheet names */
  from: string
  fromColumn: string
  to: string
  toColumn: string
  /** 0..1 */
  confidence: number
  reason: string
}
export interface Inference { tables: InferredTable[]; relationships: InferredRelationship[] }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DMY = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$/
const ISO_DT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function inferColumnType(values: string[]): ColumnType {
  const vs = values.map((v) => v.trim()).filter((v) => v !== '')
  if (!vs.length) return 'text'
  if (vs.every((v) => /^(true|false|yes|no)$/i.test(v))) return 'boolean'
  if (vs.every((v) => /^[+-]?\d{1,15}$/.test(v)) && !vs.some((v) => /^0\d/.test(v))) return 'number'
  if (vs.every((v) => /^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(v))) return 'decimal'
  if (vs.every((v) => ISO_DATE.test(v) || DMY.test(v))) return 'date'
  if (vs.every((v) => ISO_DT.test(v))) return 'datetime'
  if (vs.every((v) => EMAIL.test(v))) return 'email'
  if (vs.every((v) => /^https?:\/\/\S+$/i.test(v))) return 'url'
  if (vs.some((v) => v.includes('\n') || v.length > 255)) return 'multiline'
  const distinct = new Set(vs)
  if (vs.length >= 20 && distinct.size <= 8 && [...distinct].every((v) => v.length <= 40)) return 'choice'
  return 'text'
}

const keyish = (h: string) => /(^id$|[ _-]?id$|code$|no$|number$|key$|^sku$)/i.test(h.trim())
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const singular = (s: string) => s.replace(/ies$/i, 'y').replace(/(ses|xes)$/i, (m) => m.slice(0, -2)).replace(/s$/i, '')

export function inferSheets(sheets: SheetData[]): Inference {
  const tables: InferredTable[] = []
  const takenNames: string[] = []
  for (const s of sheets) {
    const headers = s.headers.map((h, i) => h.trim() || `Column ${i + 1}`)
    const cols: InferredColumn[] = []
    const usedNames: string[] = ['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner']
    headers.forEach((h, i) => {
      const values = s.rows.map((r) => (r[i] ?? '').toString())
      const nonBlank = values.map((v) => v.trim()).filter(Boolean)
      let name = toIdentifier(h, 'Column')
      for (let k = 2; usedNames.some((u) => u.toLowerCase() === name.toLowerCase()); k++) name = `${toIdentifier(h, 'Column')}${k}`
      usedNames.push(name)
      const distinct = new Set(nonBlank.map((v) => v.toLowerCase())).size
      cols.push({
        header: h, name, type: inferColumnType(values), blank: values.length - nonBlank.length, distinct,
        candidateKey: nonBlank.length > 0 && nonBlank.length === values.length && distinct === values.length,
      })
    })
    let name = toIdentifier(s.name, 'Sheet')
    for (let k = 2; takenNames.some((u) => u.toLowerCase() === name.toLowerCase()); k++) name = `${toIdentifier(s.name, 'Sheet')}${k}`
    takenNames.push(name)
    const keys = cols.filter((c) => c.candidateKey)
    const key = (keys.find((c) => keyish(c.header)) ?? keys[0])?.header
    tables.push({ sheet: s.name, displayName: s.name.trim() || name, name, rows: s.rows.length, columns: cols, key })
  }
  // relationships
  const rels: InferredRelationship[] = []
  const keyValues = new Map<string, Set<string>>()
  sheets.forEach((s, i) => {
    const t = tables[i]
    if (!t.key) return
    const idx = s.headers.map((h, j) => h.trim() || `Column ${j + 1}`).indexOf(t.key)
    keyValues.set(t.sheet, new Set(s.rows.map((r) => (r[idx] ?? '').toString().trim().toLowerCase()).filter(Boolean)))
  })
  sheets.forEach((s, i) => {
    const t = tables[i]
    t.columns.forEach((c, ci) => {
      if (c.header === t.key) return
      const values = s.rows.map((r) => (r[ci] ?? '').toString().trim().toLowerCase()).filter(Boolean)
      let best: InferredRelationship | null = null
      for (const other of tables) {
        if (other === t || !other.key) continue
        const keys = keyValues.get(other.sheet)!
        const hn = norm(c.header)
        const on = norm(singular(other.displayName))
        const nameMatch = hn === on || hn === on + 'id' || hn === on + 'code' || hn === on + 'no' || hn === norm(other.key) || hn.endsWith(on + 'id') || hn.endsWith(on)
        const overlap = values.length ? values.filter((v) => keys.has(v)).length / values.length : 0
        let confidence = 0
        const why: string[] = []
        if (nameMatch) { confidence += 0.5; why.push(`the name "${c.header}" matches ${other.displayName}`) }
        if (values.length >= 1 && overlap >= 0.9) { confidence += 0.5 * overlap; why.push(`${Math.round(overlap * 100)}% of its values are ${other.displayName} ${other.key} values`) }
        else if (nameMatch && values.length && overlap < 0.5) confidence -= 0.3
        if (confidence >= 0.45 && (!best || confidence > best.confidence)) {
          best = { from: t.sheet, fromColumn: c.header, to: other.sheet, toColumn: other.key!, confidence: Math.min(1, Math.round(confidence * 100) / 100), reason: why.join('; ') }
        }
      }
      if (best) rels.push(best)
    })
  })
  return { tables, relationships: rels }
}

/**
 * The confirmed inference as new draft tables: key columns become unique, related columns lookups to the other
 * table (the lookup's values are mapped from keys to row ids when the data is imported).
 */
export function inferenceToModel(inf: Inference, accepted: InferredRelationship[], into: Model = { tables: [], relationships: [] }): { model: Model; ids: Record<string, string> } {
  let model = clone(into)
  const ids: Record<string, string> = {}
  const nameOf: Record<string, string> = {}
  for (const t of inf.tables) {
    const cols: Partial<ColumnDef>[] = t.columns.map((c) => {
      const col: Partial<ColumnDef> = { name: c.name, displayName: c.header, type: c.type }
      if (c.header === t.key) { col.unique = true; col.required = true }
      if (c.type === 'choice') col.choices = []
      return col
    })
    const res = addTable(model, { displayName: t.displayName, name: t.name, columns: cols })
    model = res.model
    ids[t.sheet] = res.table.id
    nameOf[t.sheet] = res.table.name
    const made = tableById(model, res.table.id)!
    const display = t.columns.find((c) => c.type === 'text' && c.header !== t.key && /name|title|description/i.test(c.header)) ?? t.columns.find((c) => c.header === t.key)
    if (display) made.primaryColumn = made.columns.find((c) => c.displayName === display.header)?.name ?? made.primaryColumn
  }
  for (const r of accepted) {
    const child = tableById(model, ids[r.from])
    const parent = tableById(model, ids[r.to])
    if (!child || !parent) continue
    const col = child.columns.find((c) => c.displayName === r.fromColumn)
    if (!col) continue
    col.type = 'lookup'
    col.lookupTable = parent.name
    delete col.choices
    delete col.unique
    model.relationships.push({ id: newRelId(), fromTable: child.id, fromColumn: col.name, toTable: parent.id, kind: parent.id === child.id ? 'self' : 'oneToMany', onDelete: defaultDeleteBehaviour(col) })
  }
  return { model, ids }
}
