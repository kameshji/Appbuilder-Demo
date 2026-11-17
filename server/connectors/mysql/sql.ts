/**
 * Pure SQL builder for the MySQL connector (no I/O, unit-testable). Everything that reaches SQL text is either a
 * validated, backtick-quoted identifier or a literal fragment from this file; every value travels as a `?` parameter.
 *
 * Condition semantics follow server/core/condition.ts (see the notes in the README block at the bottom of this
 * header for the unavoidable differences):
 *  - blank = NULL or '' (text columns) / NULL (other columns); eq/ne with null = isBlank/notBlank
 *  - ordering ops on a blank cell are false; `ne` is TRUE for a blank cell
 *  - text compare is case-insensitive: the *literal* carries COLLATE utf8mb4_unicode_ci so the comparison does not
 *    depend on the column collation and cannot fail for linked tables with another charset
 *  - three-valued logic is neutralised under NOT (leaves are COALESCEd to 0/1) so NOT behaves like the in-memory one
 * Known differences (collation based): accent/width insensitivity and PAD SPACE of utf8mb4_unicode_ci in eq/in/ne,
 * collation ordering instead of code-unit ordering for lt/le/gt/ge on text, `contains` on date columns compares the
 * SQL text form, non-numeric text vs a numeric literal is "not equal" (the in-memory reference says "equal").
 */
import type { ColumnDef, ColumnType, TableDef } from '../../../src/platform/contracts.ts'
import type { Condition, Query, QueryValue } from '../../../src/platform/http.ts'
import { HttpError } from '../../core/contracts.ts'
import type { RawRow } from '../../core/contracts.ts'

export const COLLATION = 'utf8mb4_unicode_ci'
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
/** system tables of the platform are never reachable through a connector */
const RESERVED_PREFIX = 'ab_'

export interface Built { sql: string; params: unknown[] }

/* ------------------------------------------------------------------ identifiers */

export function quoteId(name: string): string {
  if (typeof name !== 'string' || !IDENT.test(name)) throw new HttpError(422, 'invalid', `Invalid identifier "${String(name).slice(0, 40)}"`)
  return '`' + name + '`'
}

/** Physical table name of a TableDef: def.source, else t_<lowercase name>. Platform tables (ab_*) are refused. */
export function physicalName(def: Pick<TableDef, 'name' | 'source'>): string {
  const n = def.source && def.source.trim() ? def.source : 't_' + String(def.name).toLowerCase()
  return checkSource(n)
}

export function checkSource(n: string): string {
  quoteId(n)
  if (n.toLowerCase().startsWith(RESERVED_PREFIX)) throw new HttpError(403, 'denied', 'Tables starting with "ab_" are reserved for the platform')
  return n
}

export const tableId = (def: Pick<TableDef, 'name' | 'source'>): string => quoteId(physicalName(def))

/* ------------------------------------------------------------------ column types */

export const SYSTEM_COLUMNS: ColumnDef[] = [
  { name: 'id', displayName: 'Id', type: 'text', system: true },
  { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true },
  { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime', system: true },
  { name: 'createdBy', displayName: 'Created by', type: 'text', system: true },
  { name: 'owner', displayName: 'Owner', type: 'text', system: true },
]
const SYSTEM_SQL: Record<string, string> = {
  id: 'CHAR(36)',
  createdOn: 'DATETIME(3)',
  modifiedOn: 'DATETIME(3)',
  createdBy: 'VARCHAR(64)',
  owner: 'VARCHAR(64)',
}
export const isSystemName = (n: string): boolean => n in SYSTEM_SQL

type Kind = 'text' | 'num' | 'bool' | 'date' | 'datetime'
export function kindOf(t: ColumnType): Kind {
  switch (t) {
    case 'number': case 'decimal': case 'currency': return 'num'
    case 'boolean': return 'bool'
    case 'date': return 'date'
    case 'datetime': return 'datetime'
    default: return 'text'
  }
}

/** Column types that are stored in TEXT/MEDIUMTEXT (cannot carry a UNIQUE or plain index). */
const BLOB_TEXT: ColumnType[] = ['multiline', 'image', 'file']

export function sqlType(col: ColumnDef): string {
  if (col.system && SYSTEM_SQL[col.name]) return SYSTEM_SQL[col.name]
  switch (col.type) {
    case 'text': case 'email': case 'phone': case 'choice': return 'VARCHAR(255)'
    // 1024 chars * 4 bytes exceeds the 3072-byte index limit, so a unique url column is shortened to 768
    case 'url': return col.unique ? 'VARCHAR(768)' : 'VARCHAR(1024)'
    case 'multiline': return 'MEDIUMTEXT'
    case 'number': return 'BIGINT'
    case 'decimal': return 'DOUBLE'
    case 'currency': return 'DECIMAL(19,4)'
    case 'boolean': return 'TINYINT(1)'
    case 'date': return 'DATE'
    case 'datetime': return 'DATETIME(3)'
    case 'lookup': return 'CHAR(36)'
    case 'image': case 'file': return 'TEXT'
    case 'autonumber': return 'VARCHAR(64)'
    default: throw new HttpError(422, 'invalid', `Unsupported column type "${String(col.type)}"`)
  }
}

export const columnSql = (col: ColumnDef): string => `${quoteId(col.name)} ${sqlType(col)} ${col.system && col.name === 'id' ? 'NOT NULL' : 'NULL'}`

/** Wanted secondary index of a column: 'unique', 'index' or null. */
export function wantedIndex(col: ColumnDef): 'unique' | 'index' | null {
  if (col.system) return col.name === 'owner' ? 'index' : null
  if (BLOB_TEXT.includes(col.type)) return null
  if (col.unique) return 'unique'
  if (col.type === 'lookup') return 'index'
  return null
}

export const indexName = (kind: 'unique' | 'index', col: string): string => `${kind === 'unique' ? 'uq' : 'ix'}_${col}`.slice(0, 64)

/** Columns of the physical table: system columns first, then the user columns (a def that already lists them wins). */
export function allColumns(def: TableDef): ColumnDef[] {
  const byName = new Map(def.columns.map((c) => [c.name, c]))
  const out: ColumnDef[] = SYSTEM_COLUMNS.map((s) => {
    const given = byName.get(s.name)
    return { ...s, ...(given ?? {}), name: s.name, system: true, type: s.type }
  })
  for (const c of def.columns) if (!isSystemName(c.name)) out.push(c)
  return out
}

export function createTableSql(def: TableDef): string {
  const cols = allColumns(def)
  const lines: string[] = []
  const seen = new Set<string>()
  for (const c of cols) {
    if (seen.has(c.name.toLowerCase())) throw new HttpError(422, 'invalid', `Duplicate column "${c.name}"`)
    seen.add(c.name.toLowerCase())
    lines.push(columnSql(c))
  }
  lines.push('PRIMARY KEY (`id`)')
  for (const c of cols) {
    const w = wantedIndex(c)
    if (w) lines.push(`${w === 'unique' ? 'UNIQUE KEY' : 'KEY'} ${quoteId(indexName(w, c.name))} (${quoteId(c.name)})`)
  }
  return `CREATE TABLE ${tableId(def)} (\n  ${lines.join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=${COLLATION}`
}

/* ------------------------------------------------------------------ value conversion */

const p2 = (n: number, w = 2): string => String(n).padStart(w, '0')
export function fmtDate(d: Date): string {
  return `${p2(d.getUTCFullYear(), 4)}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`
}
export function fmtDateTime(d: Date): string {
  return `${fmtDate(d)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}.${p2(d.getUTCMilliseconds(), 3)}`
}

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v)
  if (typeof v === 'string' && v.trim() !== '') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : new Date(t)
  }
  return null
}
function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isNaN(n) ? null : n }
  return null
}
function toBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  if (v === 1 || v === 0) return v === 1
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (s === 'true' || s === '1') return true
    if (s === 'false' || s === '0') return false
  }
  return null
}

/** JS value -> SQL parameter for a column of this type. Throws HttpError(invalid) for unconvertible values. */
export function toDb(v: unknown, col: Pick<ColumnDef, 'name' | 'type'>): unknown {
  if (v === null || v === undefined) return null
  const bad = (): never => { throw new HttpError(422, 'invalid', `Value for "${col.name}" is not a valid ${col.type}`, col.name) }
  switch (kindOf(col.type)) {
    case 'num': { const n = toNumber(v); return n === null ? bad() : n }
    case 'bool': { const b = toBool(v); return b === null ? bad() : (b ? 1 : 0) }
    case 'date': { const d = toDate(v); return d === null ? bad() : fmtDate(d) }
    case 'datetime': { const d = toDate(v); return d === null ? bad() : fmtDateTime(d) }
    default:
      if (typeof v === 'string') return v
      if (v instanceof Date) return v.toISOString()
      return String(v)
  }
}

/** Driver value -> JS RawRow value. */
export function fromDb(v: unknown, type: ColumnType): RawRow[string] {
  if (v === null || v === undefined) return null
  switch (kindOf(type)) {
    case 'num': return typeof v === 'number' ? v : Number(v)
    case 'bool':
      if (Buffer.isBuffer(v)) return v.length > 0 && v[v.length - 1] !== 0
      if (typeof v === 'string') return v !== '0' && v !== ''
      return Number(v) !== 0
    case 'date': case 'datetime': {
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
      const d = toDate(typeof v === 'string' && !/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v.replace(' ', 'T') + 'Z' : v)
      return d
    }
    default:
      if (typeof v === 'string') return v
      if (Buffer.isBuffer(v)) return v.toString('utf8')
      if (v instanceof Date) return v.toISOString()
      return String(v)
  }
}

/* ------------------------------------------------------------------ condition -> SQL */

class Cols {
  private map = new Map<string, ColumnDef>()
  constructor(def: TableDef) { for (const c of allColumns(def)) this.map.set(c.name, c) }
  get(name: string): ColumnDef {
    const c = this.map.get(name)
    if (!c) throw new HttpError(422, 'invalid', `Unknown column "${String(name).slice(0, 64)}"`, String(name).slice(0, 64))
    return c
  }
  all(): ColumnDef[] { return [...this.map.values()] }
}

/** a text column holding a number-like string, evaluated to a number (NULL otherwise); no strict-mode errors */
const NUMERIC_TEXT = "'^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$'"
const numText = (q: string): string => `CASE WHEN ${q} REGEXP ${NUMERIC_TEXT} THEN ${q} + 0 END`
const textBlank = (q: string): string => `(${q} IS NULL OR CHAR_LENGTH(${q}) = 0)`
const textNonBlank = (q: string): string => `(${q} IS NOT NULL AND CHAR_LENGTH(${q}) > 0)`
const lit = (p: unknown[], v: unknown): string => { p.push(v); return '?' }
const strLit = (p: unknown[], s: string): string => { p.push(s); return `? COLLATE ${COLLATION}` }

export function escapeLike(s: string): string {
  return s.replace(/[!%_]/g, (m) => '!' + m)
}

const CMP: Record<string, string> = { lt: '<', le: '<=', gt: '>', ge: '>=' }

function leaf(c: { col: string; op: string; value?: QueryValue | QueryValue[] }, cols: Cols, p: unknown[]): string {
  const col = cols.get(c.col)
  const q = quoteId(col.name)
  const kind = kindOf(col.type)
  const op = c.op
  const isBlankSql = kind === 'text' ? textBlank(q) : `${q} IS NULL`
  const notBlankSql = kind === 'text' ? textNonBlank(q) : `${q} IS NOT NULL`
  if (op === 'isBlank') return `(${isBlankSql})`
  if (op === 'notBlank') return `(${notBlankSql})`
  const v = c.value
  const nullish = v === null || v === undefined
  if (op === 'eq' && nullish) return `(${isBlankSql})`
  if (op === 'ne' && nullish) return `(${notBlankSql})`

  if (op === 'contains' || op === 'startsWith' || op === 'endsWith') {
    const s = escapeLike(String(nullish || Array.isArray(v) ? '' : v))
    const pat = op === 'contains' ? `%${s}%` : op === 'startsWith' ? `${s}%` : `%${s}`
    let subject = q
    if (kind === 'bool') subject = `CASE WHEN ${q} <> 0 THEN 'true' ELSE 'false' END`
    else if (kind !== 'text') subject = `CAST(${q} AS CHAR)`
    return `(${notBlankSql} AND ${subject} LIKE (${strLit(p, pat)}) ESCAPE '!')`
  }

  if (op === 'in') {
    if (!Array.isArray(v)) return '(1 = 0)'
    return inList(q, kind, v, p)
  }
  if (!(op === 'eq' || op === 'ne' || op in CMP)) return '(1 = 0)'
  if (Array.isArray(v)) return '(1 = 0)'
  const scalar = v as QueryValue
  const cmpSql = op === 'eq' ? '=' : op === 'ne' ? '<>' : CMP[op]
  const result = (expr: string | null): string => {
    // expr === null: value cannot match anything (eq/ordering false, ne true)
    if (expr === null) return op === 'ne' ? '(1 = 1)' : '(1 = 0)'
    return expr
  }
  switch (kind) {
    case 'num': {
      const n = toNumber(scalar)
      if (n === null) return result(null)
      return op === 'ne' ? `(${q} IS NULL OR ${q} <> ${lit(p, n)})` : `(${q} ${cmpSql} ${lit(p, n)})`
    }
    case 'bool': {
      const b = toBool(scalar)
      if (b === null) return result(null)
      if (op === 'eq') return b ? `(${q} <> 0)` : `(${q} = 0)`
      if (op === 'ne') return b ? `(${q} IS NULL OR ${q} = 0)` : `(${q} IS NULL OR ${q} <> 0)`
      return `(${q} IS NOT NULL AND (${q} <> 0) ${cmpSql} ${lit(p, b ? 1 : 0)})`
    }
    case 'date': case 'datetime': {
      const d = toDate(scalar)
      if (d === null) return result(null)
      let left = q
      let right: string
      if (kind === 'date' && d.getTime() % 86400000 === 0) right = lit(p, fmtDate(d))
      else if (kind === 'date') { left = `CAST(${q} AS DATETIME(3))`; right = `CAST(${lit(p, fmtDateTime(d))} AS DATETIME(3))` }
      else right = lit(p, fmtDateTime(d))
      return op === 'ne' ? `(${q} IS NULL OR ${left} <> ${right})` : `(${left} ${cmpSql} ${right})`
    }
    default: { // text
      if (typeof scalar === 'number') {
        if (!Number.isFinite(scalar)) return result(null)
        const nt = numText(q)
        if (op === 'ne') return `(${textBlank(q)} OR COALESCE(${nt} <> ${lit(p, scalar)}, 1))`
        return `(${nt} ${cmpSql} ${lit(p, scalar)})`
      }
      const s = typeof scalar === 'string' ? scalar : String(scalar)
      if (op === 'eq' && s === '') return '(1 = 0)' // reference: a blank cell never equals ''
      if (op === 'ne' && s === '') return '(1 = 1)'
      if (op === 'ne') return `(${q} IS NULL OR ${q} <> ${strLit(p, s)})`
      if (op === 'eq') return `(${q} = ${strLit(p, s)})`
      return `(${textNonBlank(q)} AND ${q} ${cmpSql} ${strLit(p, s)})`
    }
  }
}

function inList(q: string, kind: Kind, v: QueryValue[], p: unknown[]): string {
  const items = v.filter((x) => x !== null && x !== undefined)
  if (kind === 'num') {
    const nums = items.map(toNumber).filter((x): x is number => x !== null)
    if (!nums.length) return '(1 = 0)'
    return `(${q} IN (${nums.map((n) => lit(p, n)).join(', ')}))`
  }
  if (kind === 'bool') {
    const bs = [...new Set(items.map(toBool).filter((x): x is boolean => x !== null))]
    if (!bs.length) return '(1 = 0)'
    return '(' + bs.map((b) => (b ? `${q} <> 0` : `${q} = 0`)).join(' OR ') + ')'
  }
  if (kind === 'date' || kind === 'datetime') {
    const ds = items.map(toDate).filter((x): x is Date => x !== null)
    if (!ds.length) return '(1 = 0)'
    if (kind === 'datetime') return `(${q} IN (${ds.map((d) => lit(p, fmtDateTime(d))).join(', ')}))`
    return '(' + ds.map((d) => (d.getTime() % 86400000 === 0
      ? `${q} = ${lit(p, fmtDate(d))}`
      : `CAST(${q} AS DATETIME(3)) = CAST(${lit(p, fmtDateTime(d))} AS DATETIME(3))`)).join(' OR ') + ')'
  }
  const strs = items.filter((x): x is string => typeof x === 'string' && x !== '')
  const nums = items.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  const parts: string[] = []
  if (strs.length) parts.push(`${q} IN (${strs.map((s) => strLit(p, s)).join(', ')})`)
  if (nums.length) {
    const nt = numText(q)
    parts.push(`${nt} IN (${nums.map((n) => lit(p, n)).join(', ')})`)
  }
  return parts.length ? `(${parts.join(' OR ')})` : '(1 = 0)'
}

function translate(c: Condition | undefined, cols: Cols, p: unknown[], negated: boolean): string {
  if (!c) return '(1 = 1)'
  if ('const' in c) return c.const ? '(1 = 1)' : '(1 = 0)'
  if ('and' in c) return c.and.length ? '(' + c.and.map((x) => translate(x, cols, p, negated)).join(' AND ') + ')' : '(1 = 1)'
  if ('or' in c) return c.or.length ? '(' + c.or.map((x) => translate(x, cols, p, negated)).join(' OR ') + ')' : '(1 = 0)'
  if ('not' in c) return `(NOT ${translate(c.not, cols, p, true)})`
  const sql = leaf(c, cols, p)
  // under NOT, NULL would stay NULL (and be filtered out); the in-memory reference treats it as false
  return negated ? `COALESCE(${sql}, 0)` : sql
}

export function buildWhere(def: TableDef, cond: Condition | undefined): Built {
  const params: unknown[] = []
  const sql = translate(cond, new Cols(def), params, false)
  return { sql, params }
}

/* ------------------------------------------------------------------ statements */

const intArg = (n: unknown, what: string): number => {
  const v = Number(n)
  if (!Number.isInteger(v) || v < 0) throw new HttpError(422, 'invalid', `Invalid ${what}`)
  return v
}

export interface SelectPlan {
  sql: string
  params: unknown[]
  countSql?: string
  countParams?: unknown[]
  /** result columns in SELECT order */
  columns: ColumnDef[]
}

export function buildSelect(def: TableDef, q: Query): SelectPlan {
  const cols = new Cols(def)
  const names = q.select && q.select.length ? [...new Set([...q.select, 'id'])] : cols.all().map((c) => c.name)
  const selected = names.map((n) => cols.get(n))
  const where = buildWhere(def, q.where)
  const t = tableId(def)
  const order: string[] = []
  for (const o of q.orderBy ?? []) {
    const c = cols.get(o.col)
    const qc = quoteId(c.name)
    const dir = o.dir === 'desc' ? 'DESC' : 'ASC'
    order.push(kindOf(c.type) === 'text' ? `${textBlank(qc)} ASC` : `(${qc} IS NULL) ASC`, `${qc} ${dir}`)
  }
  const paged = q.top !== undefined || (q.skip ?? 0) > 0
  if (paged && !(q.orderBy ?? []).some((o) => o.col === 'id')) order.push('`id` ASC')
  let sql = `SELECT ${selected.map((c) => quoteId(c.name)).join(', ')} FROM ${t} WHERE ${where.sql}`
  if (order.length) sql += ` ORDER BY ${order.join(', ')}`
  if (paged) {
    const skip = intArg(q.skip ?? 0, 'skip')
    sql += q.top !== undefined ? ` LIMIT ${intArg(q.top, 'top')}` : ' LIMIT 18446744073709551615'
    if (skip) sql += ` OFFSET ${skip}`
  }
  const plan: SelectPlan = { sql, params: where.params, columns: selected }
  if (q.count) {
    plan.countSql = `SELECT COUNT(*) AS n FROM ${t} WHERE ${where.sql}`
    plan.countParams = where.params
  }
  return plan
}

const INSERT_CHUNK = 500

export function buildInserts(def: TableDef, rows: RawRow[]): Built[] {
  if (!rows.length) return []
  const cols = new Cols(def)
  const present = new Set<string>()
  for (const r of rows) for (const [k, v] of Object.entries(r)) { if (v !== undefined) { cols.get(k); present.add(k) } }
  const ordered = cols.all().filter((c) => present.has(c.name))
  if (!ordered.length) throw new HttpError(422, 'invalid', 'Nothing to insert')
  const out: Built[] = []
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const params: unknown[] = []
    const tuples = rows.slice(i, i + INSERT_CHUNK).map((r) => '(' + ordered.map((c) => {
      const v = r[c.name]
      if (v === undefined) return 'DEFAULT'
      params.push(toDb(v, c))
      return '?'
    }).join(', ') + ')')
    out.push({ sql: `INSERT INTO ${tableId(def)} (${ordered.map((c) => quoteId(c.name)).join(', ')}) VALUES ${tuples.join(', ')}`, params })
  }
  return out
}

/** UPDATE ... WHERE id = ? AND guard. Returns null when there is nothing to set (caller counts instead). */
export function buildUpdate(def: TableDef, id: string, changes: RawRow, guard?: Condition): Built | null {
  const cols = new Cols(def)
  const sets: string[] = []
  const params: unknown[] = []
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined || k === 'id') continue
    const c = cols.get(k)
    sets.push(`${quoteId(c.name)} = ?`)
    params.push(toDb(v, c))
  }
  if (!sets.length) return null
  const g = buildWhere(def, guard)
  return { sql: `UPDATE ${tableId(def)} SET ${sets.join(', ')} WHERE \`id\` = ? AND ${g.sql}`, params: [...params, id, ...g.params] }
}

export function buildCountById(def: TableDef, id: string, guard?: Condition): Built {
  const g = buildWhere(def, guard)
  return { sql: `SELECT COUNT(*) AS n FROM ${tableId(def)} WHERE \`id\` = ? AND ${g.sql}`, params: [id, ...g.params] }
}

export function buildDeletes(def: TableDef, ids: string[], guard?: Condition): Built[] {
  const out: Built[] = []
  const g = buildWhere(def, guard)
  for (let i = 0; i < ids.length; i += INSERT_CHUNK) {
    const chunk = ids.slice(i, i + INSERT_CHUNK)
    out.push({
      sql: `DELETE FROM ${tableId(def)} WHERE \`id\` IN (${chunk.map(() => '?').join(', ')}) AND ${g.sql}`,
      params: [...chunk, ...g.params],
    })
  }
  return out
}

export function columnTypesByName(def: TableDef): Map<string, ColumnType> {
  return new Map(allColumns(def).map((c) => [c.name, c.type]))
}
