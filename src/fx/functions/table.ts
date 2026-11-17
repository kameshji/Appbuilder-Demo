import type { FxRecord, FxValue } from '@/contracts'
import { compareValues, hasOwn, isRecord, setField, toRows, toText, valueKey } from '../values'
import { def, MANY, type CallCtx, type FnDef } from './types'

function orderArg(c: CallCtx, i: number): boolean {
  const o = c.text(i).trim().toLowerCase()
  if (o === 'ascending' || o === 'asc') return true
  if (o === 'descending' || o === 'desc') return false
  return c.fail(i, 'Sort order must be Ascending or Descending')
}

function isOrderText(v: FxValue): boolean {
  if (typeof v !== 'string') return false
  const o = v.trim().toLowerCase()
  return o === 'ascending' || o === 'descending' || o === 'asc' || o === 'desc'
}

function colName(c: CallCtx, i: number): string {
  return c.text(i)
}

function dropId(names: string[]): string[] {
  return names.filter((n) => n !== '__id')
}

export const tableFns: FnDef[] = [
  def('Filter', 'Filter(table, condition [, condition2, ...])', 'Rows of the table where every condition is true.', 2, MANY, (c) => {
    const { rows, as } = c.rows(0, 'Filter')
    return rows.filter((r) => {
      for (let i = 1; i < c.argc; i++) if (!c.rowBool(i, r, as)) return false
      return true
    })
  }),
  def('Search', 'Search(table, text, "column1" [, "column2", ...])', 'Rows where any listed column contains the text (ignores case). Blank text keeps every row.', 3, MANY, (c) => {
    const { rows } = c.rows(0, 'Search')
    const needle = c.text(1).toLowerCase()
    const cols: string[] = []
    for (let i = 2; i < c.argc; i++) cols.push(colName(c, i))
    if (needle === '') return rows
    return rows.filter((r) =>
      cols.some((k) => {
        const v = hasOwn(r, k) ? r[k]! : null
        if (v === null || typeof v === 'object') return false
        return toText(v, c.node).toLowerCase().includes(needle)
      }),
    )
  }),
  def('LookUp', 'LookUp(table, condition [, result])', 'The first row where the condition is true (or the result formula for that row). Blank when nothing matches.', 2, 3, (c) => {
    const { rows, as } = c.rows(0, 'LookUp')
    for (const r of rows) {
      if (c.rowBool(1, r, as)) return c.argc > 2 ? c.row(2, r, as) : r
    }
    return null
  }),
  def('Sort', 'Sort(table, formula [, SortOrder])', 'Sorts rows by the value of a formula.', 2, 3, (c) => {
    const { rows, as } = c.rows(0, 'Sort')
    const asc = c.argc > 2 ? orderArg(c, 2) : true
    const keyed = rows.map((r) => ({ r, k: c.row(1, r, as) }))
    keyed.sort((a, b) => compareValues(a.k, b.k, c.argNode(1)) * (asc ? 1 : -1))
    return keyed.map((x) => x.r)
  }),
  def('SortByColumns', 'SortByColumns(table, "column" [, SortOrder, "column2", ...])', 'Sorts rows by one or more columns.', 2, MANY, (c) => {
    const { rows } = c.rows(0, 'SortByColumns')
    const keys: { col: string; asc: boolean }[] = []
    let i = 1
    while (i < c.argc) {
      const col = colName(c, i)
      i++
      let asc = true
      if (i < c.argc) {
        const v = c.value(i)
        if (isOrderText(v)) { asc = orderArg(c, i); i++ }
      }
      keys.push({ col, asc })
    }
    const get = (r: FxRecord, k: string): FxValue => (hasOwn(r, k) ? r[k]! : null)
    return [...rows].sort((a, b) => {
      for (const { col, asc } of keys) {
        const d = compareValues(get(a, col), get(b, col), c.node)
        if (d !== 0) return d * (asc ? 1 : -1)
      }
      return 0
    })
  }),
  def('First', 'First(table)', 'The first row, or blank for an empty table.', 1, 1, (c) => c.rows(0, 'First').rows[0] ?? null),
  def('Last', 'Last(table)', 'The last row, or blank for an empty table.', 1, 1, (c) => {
    const { rows } = c.rows(0, 'Last')
    return rows.length ? rows[rows.length - 1]! : null
  }),
  def('FirstN', 'FirstN(table [, count])', 'The first rows of a table (default 1).', 1, 2, (c) => {
    const { rows } = c.rows(0, 'FirstN')
    const n = c.argc > 1 ? Math.max(0, Math.trunc(c.num(1))) : 1
    return rows.slice(0, n)
  }),
  def('LastN', 'LastN(table [, count])', 'The last rows of a table (default 1).', 1, 2, (c) => {
    const { rows } = c.rows(0, 'LastN')
    const n = c.argc > 1 ? Math.max(0, Math.trunc(c.num(1))) : 1
    return n === 0 ? [] : rows.slice(-n)
  }),
  def('Index', 'Index(table, position)', 'The row at a position. The first row is 1.', 2, 2, (c) => {
    const { rows } = c.rows(0, 'Index')
    const n = Math.trunc(c.num(1))
    if (n < 1 || n > rows.length) return c.fail(1, `Row ${n} doesn't exist: the table has ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`)
    return rows[n - 1]!
  }),
  def('Distinct', 'Distinct(table, formula)', 'A one-column table (Value) of the different results of a formula.', 2, 2, (c) => {
    const { rows, as } = c.rows(0, 'Distinct')
    const seen = new Set<string>()
    const out: FxValue[] = []
    for (const r of rows) {
      const v = c.row(1, r, as)
      const k = valueKey(v)
      if (!seen.has(k)) { seen.add(k); out.push(v) }
    }
    return toRows(out)
  }),
  def('AddColumns', 'AddColumns(table, "name", formula [, "name2", formula2, ...])', 'Adds calculated columns to every row.', 3, MANY, (c) => {
    if (c.argc % 2 === 0) return c.fail(null, 'AddColumns needs a name and a formula for each new column')
    const { rows, as } = c.rows(0, 'AddColumns')
    const names: string[] = []
    for (let i = 1; i < c.argc; i += 2) names.push(colName(c, i))
    return rows.map((r) => {
      const out: FxRecord = { ...r }
      for (let i = 1; i < c.argc; i += 2) setField(out, names[(i - 1) / 2]!, c.row(i + 1, r, as))
      return out
    })
  }),
  def('DropColumns', 'DropColumns(table, "column" [, "column2", ...])', 'Removes columns from every row.', 2, MANY, (c) => {
    const { rows } = c.rows(0, 'DropColumns')
    const names: string[] = []
    for (let i = 1; i < c.argc; i++) names.push(colName(c, i))
    const drop = new Set(dropId(names))
    return rows.map((r) => {
      const out: FxRecord = {}
      for (const k of Object.keys(r)) if (!drop.has(k)) out[k] = r[k]!
      return out
    })
  }),
  def('ShowColumns', 'ShowColumns(table, "column" [, "column2", ...])', 'Keeps only the listed columns.', 2, MANY, (c) => {
    const { rows } = c.rows(0, 'ShowColumns')
    const names: string[] = []
    for (let i = 1; i < c.argc; i++) names.push(colName(c, i))
    return rows.map((r) => {
      const out: FxRecord = {}
      for (const k of names) if (hasOwn(r, k)) out[k] = r[k]!
      if (hasOwn(r, '__id')) out.__id = r.__id!
      return out
    })
  }),
  def('CountRows', 'CountRows(table)', 'Number of rows in a table.', 1, 1, (c) => c.rows(0, 'CountRows').rows.length),
  def('CountIf', 'CountIf(table, condition)', 'Number of rows where the condition is true.', 2, 2, (c) => {
    const { rows, as } = c.rows(0, 'CountIf')
    let n = 0
    for (const r of rows) if (c.rowBool(1, r, as)) n++
    return n
  }),
  def('ForAll', 'ForAll(table, formula)', 'Evaluates a formula for every row and returns the results as a table.', 2, 2, (c) => {
    const { rows, as } = c.rows(0, 'ForAll')
    const out: FxValue[] = rows.map((r) => c.row(1, r, as))
    return toRows(out)
  }),
  def('Sequence', 'Sequence(count [, start [, step]])', 'A table of numbers (Value): 1, 2, 3...', 1, 3, (c) => {
    const n = Math.trunc(c.num(0))
    if (n > 100000) return c.fail(0, 'Sequence is limited to 100,000 rows')
    const start = c.argc > 1 ? c.num(1) : 1
    const step = c.argc > 2 ? c.num(2) : 1
    const out: FxRecord[] = []
    for (let i = 0; i < n; i++) out.push({ Value: start + i * step })
    return out
  }),
  def('Table', 'Table(record1 [, record2, ...])', 'Builds a table from records.', 0, MANY, (c) => {
    const out: FxRecord[] = []
    for (let i = 0; i < c.argc; i++) {
      const v = c.value(i)
      if (v === null) continue
      if (Array.isArray(v)) out.push(...toRows(v))
      else if (isRecord(v)) out.push(v)
      else out.push({ Value: v })
    }
    return out
  }),
  def('Defaults', 'Defaults(collection)', 'An empty record, used with Patch to create a new row.', 1, 1, (c) => {
    if (c.argNode(0).t !== 'id') c.value(0)
    return {}
  }),
]
