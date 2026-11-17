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
  def('GroupBy', 'GroupBy(table, "column" [, "column2", ...], "GroupName")', 'Groups rows that share the same values in the listed columns. Each result row has those columns plus GroupName: a table of the rows in the group.', 3, MANY, (c) => {
    const { rows } = c.rows(0, 'GroupBy')
    const cols: string[] = []
    for (let i = 1; i < c.argc - 1; i++) cols.push(colName(c, i))
    const groupName = colName(c, c.argc - 1)
    if (cols.includes(groupName)) return c.fail(c.argc - 1, 'The group name must be different from the grouping columns')
    const get = (r: FxRecord, k: string): FxValue => (hasOwn(r, k) ? r[k]! : null)
    const groups = new Map<string, { head: FxRecord; items: FxRecord[] }>()
    for (const r of rows) {
      const key = cols.map((k) => valueKey(get(r, k))).join('|')
      let g = groups.get(key)
      if (!g) {
        const head: FxRecord = {}
        for (const k of cols) setField(head, k, get(r, k))
        g = { head, items: [] }
        groups.set(key, g)
      }
      g.items.push(r)
    }
    return [...groups.values()].map((g) => {
      const out: FxRecord = { ...g.head }
      setField(out, groupName, g.items)
      return out
    })
  }),
  def('Ungroup', 'Ungroup(table, "GroupName")', 'Flattens the groups made by GroupBy back into one table of rows.', 2, 2, (c) => {
    const { rows } = c.rows(0, 'Ungroup')
    const name = colName(c, 1)
    const out: FxRecord[] = []
    for (const r of rows) {
      const g = hasOwn(r, name) ? r[name]! : undefined
      if (g === undefined) return c.fail(1, `The table has no column called ${name}`)
      if (g === null) continue
      if (!Array.isArray(g)) return c.fail(1, `${name} isn't a table, so it can't be ungrouped`)
      const outer: FxRecord = {}
      for (const k of Object.keys(r)) if (k !== name && k !== '__id') outer[k] = r[k]!
      for (const inner of toRows(g)) out.push({ ...outer, ...inner })
    }
    return out
  }),
  def('Shuffle', 'Shuffle(table)', 'The rows in random order.', 1, 1, (c) => {
    const out = [...c.rows(0, 'Shuffle').rows]
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const t = out[i]!
      out[i] = out[j]!
      out[j] = t
    }
    return out
  }),
  def('RenameColumns', 'RenameColumns(table, "old", "new" [, "old2", "new2", ...])', 'Renames columns.', 3, MANY, (c) => {
    if (c.argc % 2 === 0) return c.fail(null, 'RenameColumns needs an old and a new name for each column')
    const { rows } = c.rows(0, 'RenameColumns')
    const map = new Map<string, string>()
    for (let i = 1; i < c.argc; i += 2) {
      const from = colName(c, i)
      if (rows.length > 0 && !rows.some((r) => hasOwn(r, from))) return c.fail(i, `The table has no column called ${from}`)
      map.set(from, colName(c, i + 1))
    }
    return rows.map((r) => {
      const out: FxRecord = {}
      for (const k of Object.keys(r)) setField(out, map.get(k) ?? k, r[k]!)
      return out
    })
  }),
  def('Choices', 'Choices(table, "column") or Choices(Table.Column)', 'A one-column table (Value) of the different values in a column, without blanks.', 1, 2, (c) => {
    let v = c.value(0)
    if (typeof v === 'string') {
      const cur = c.currentRows(v)
      if (cur === undefined) return c.fail(0, `Name isn't recognised: ${v}`)
      v = cur
    }
    const rows = v === null ? [] : Array.isArray(v) ? toRows(v) : c.fail(0, 'Choices needs a table as its first argument')
    let col: string | undefined
    if (c.argc > 1) col = colName(c, 1)
    const seen = new Set<string>()
    const out: FxRecord[] = []
    for (const r of rows) {
      let k = col
      if (k === undefined) {
        const keys = Object.keys(r).filter((x) => x !== '__id')
        if (keys.length !== 1) return c.fail(0, 'This table has several columns. Say which one to use, like Choices(Contacts, "City")')
        k = keys[0]!
      }
      const x = hasOwn(r, k) ? r[k]! : null
      if (x === null || x === '') continue
      const key = valueKey(x)
      if (!seen.has(key)) { seen.add(key); out.push({ Value: x }) }
    }
    return out
  }),
]
