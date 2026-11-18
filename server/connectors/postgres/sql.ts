/**
 * Pure SQL builder for the PostgreSQL connector (no I/O, unit-testable). Everything that reaches SQL text is a validated,
 * double-quoted identifier, a schema-qualified table name, or a literal fragment from this file; every value travels as
 * a `$n` parameter with an explicit cast.
 *
 * Condition semantics are those of server/core/condition.ts (evaluateCondition / applyQuery), decided here in JavaScript
 * wherever the reference decides on the *value* (its type, numeric-looking text, Date.parse), and in SQL only where it
 * depends on the cell:
 *  - text is compared case-insensitively on the lowercased forms, by code point (`lower(x) COLLATE "C"`). Lowercasing
 *    uses the ICU root collation when the server has it (`und-x-icu`, same mapping as JavaScript's toLowerCase,
 *    including final sigma and dotted I), otherwise the database's LC_CTYPE (C.UTF-8 lowercases ASCII only);
 *  - blank = NULL or '' for text kinds, NULL otherwise; eq/ne with null = isBlank/notBlank; ordering on blank = false;
 *    ne is TRUE for a blank cell; eq '' is never true;
 *  - a text cell against a number compares numerically when the text is numeric-looking, else "not comparable"
 *    (eq false, ne true, ordering false); a number cell against numeric-looking text likewise;
 *  - booleans: true > false; a boolean against a non-boolean (either side) is never equal and orders by the truthiness
 *    of the cell (reference rule `x === y ? 0 : x ? 1 : -1`);
 *  - dates compare by time; text values are parsed with Date.parse exactly like the reference;
 *  - contains / startsWith / endsWith compare the lowercased string form of the cell (numbers formatted like
 *    JavaScript's String(number)); no LIKE, so %, _ and \ need no escaping;
 *  - three-valued logic is neutralised under NOT (leaves are COALESCEd to false).
 * Known differences (documented in docs/dev/connectors.md): String(Date) of the reference depends on the server time
 * zone, SQL uses ISO text for contains on date columns; numeric-looking text is limited to decimal notation with at
 * most 250 characters and a two-digit exponent (JavaScript also accepts 0x.., 0o.., 0b.. and larger exponents); text
 * ordering is by code point, JavaScript sorts by UTF-16 code unit (differs only for characters above U+FFFF against
 * U+E000..U+FFFF); without ICU, non-ASCII case folding follows the database locale.
 */
import { createHash } from 'node:crypto'
import type { ColumnDef, ColumnType, TableDef } from '../../../src/platform/contracts.ts'
import type { Condition, Query, QueryValue } from '../../../src/platform/http.ts'
import { HttpError } from '../../core/contracts.ts'
import type { RawRow } from '../../core/contracts.ts'

/** identifiers: letters, digits, underscore; at most 63 characters (PostgreSQL's NAMEDATALEN - 1) */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/
/** metadata tables of the platform (in every environment schema) are never reachable through a connector */
const RESERVED_PREFIX = 'ab_'

export interface Built { sql: string; params: unknown[] }

/** where the tables are and how text is lowercased */
export interface Dialect {
  /** schema of the tables (environment schema for the default connection, settings.schema or public otherwise) */
  schema: string
  /** lowercase with the ICU root collation (pg_catalog."und-x-icu" exists) */
  icu: boolean
}

/* ------------------------------------------------------------------ identifiers */

export function quoteId(name: string): string {
  if (typeof name !== 'string' || !IDENT.test(name)) throw new HttpError(422, 'invalid', `Invalid identifier "${String(name).slice(0, 40)}"`)
  return '"' + name + '"'
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

export const tableId = (d: Dialect, def: Pick<TableDef, 'name' | 'source'>): string => `${quoteId(d.schema)}.${quoteId(physicalName(def))}`

/** an index name, unique inside the schema (PostgreSQL index names are per schema, not per table) */
export function indexName(table: string, kind: 'unique' | 'index' | 'key' | 'keydesc' | 'trgm', col: string): string {
  const base = `${kind === 'unique' ? 'uq' : kind === 'key' ? 'kx' : kind === 'keydesc' ? 'kd' : kind === 'trgm' ? 'tg' : 'ix'}_${table}_${col}`
  if (base.length <= 63) return base
  const h = createHash('sha1').update(`${table}\u0000${col}`).digest('hex').slice(0, 10)
  return `${base.slice(0, 52)}_${h}`
}

/* ------------------------------------------------------------------ column types */

export const SYSTEM_COLUMNS: ColumnDef[] = [
  { name: 'id', displayName: 'Id', type: 'text', system: true },
  { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true },
  { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime', system: true },
  { name: 'createdBy', displayName: 'Created by', type: 'text', system: true },
  { name: 'owner', displayName: 'Owner', type: 'text', system: true },
]
const SYSTEM_SQL: Record<string, string> = {
  id: 'text',
  createdOn: 'timestamptz(3)',
  modifiedOn: 'timestamptz(3)',
  createdBy: 'text',
  owner: 'text',
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

/** column types without a secondary index (long text, attachment lists) */
const NO_INDEX: ColumnType[] = ['multiline', 'image', 'file']

export function sqlType(col: ColumnDef): string {
  if (col.system && SYSTEM_SQL[col.name]) return SYSTEM_SQL[col.name]
  switch (col.type) {
    case 'text': case 'email': case 'phone': case 'choice': return 'varchar(255)'
    // btree entries are limited to about 2700 bytes: a unique url stays at 768 characters as on MySQL
    case 'url': return col.unique ? 'varchar(768)' : 'varchar(1024)'
    case 'multiline': return 'text'
    case 'number': return 'bigint'
    case 'decimal': return 'double precision'
    case 'currency': return 'numeric(19,4)'
    case 'boolean': return 'boolean'
    case 'date': return 'date'
    case 'datetime': return 'timestamptz(3)'
    case 'lookup': return 'text'
    case 'image': case 'file': return 'text'
    case 'autonumber': return 'varchar(64)'
    default: throw new HttpError(422, 'invalid', `Unsupported column type "${String(col.type)}"`)
  }
}

export const columnSql = (col: ColumnDef): string => `${quoteId(col.name)} ${sqlType(col)} ${col.system && col.name === 'id' ? 'NOT NULL' : 'NULL'}`

/** Wanted secondary index of a column: 'unique', 'index' or null. */
export function wantedIndex(col: ColumnDef): 'unique' | 'index' | null {
  if (col.system) return col.name === 'owner' ? 'index' : null
  if (NO_INDEX.includes(col.type)) return null
  if (col.unique) return 'unique'
  if (col.type === 'lookup') return 'index'
  return null
}

/** lowercase a text expression (see the header) */
export function fold(d: Dialect, expr: string): string {
  return d.icu ? `lower((${expr}) COLLATE pg_catalog."und-x-icu")` : `lower(${expr})`
}

/**
 * Query v2: the normalised sort key of a column (docs/dev/query-v2.md section 5). v2 conditions compare this same
 * expression (plus `col IS NOT NULL`), so one index on (key, natural order) serves filters, sorts and keyset seeks.
 */
export function sortKeyExpr(d: Dialect, type: ColumnType, q: string): string {
  switch (kindOf(type)) {
    case 'text': return `COALESCE(${fold(d, q)}, '') COLLATE "C"`
    case 'num': return `COALESCE(${q}, 0)`
    case 'bool': return `COALESCE(${q}::int, 0)`
    case 'date': return `COALESCE(${q}, '-infinity'::date)`
    case 'datetime': return `COALESCE(${q}, '-infinity'::timestamptz)`
  }
}

/** Query v2 natural order tie-breakers: createdOn (NULL first) then id (code point order) */
export function naturalTerms(def: Pick<TableDef, 'missingSystem'>, prefix = ''): string[] {
  const missing = new Set(def.missingSystem ?? [])
  const out: string[] = []
  if (!missing.has('createdOn')) out.push(`COALESCE(${prefix}"createdOn", '-infinity'::timestamptz)`)
  if (!missing.has('id')) out.push(`${prefix}"id" COLLATE "C"`)
  return out
}

/** the natural-order index of a table (unsorted pages and every tie-break) */
export function naturalIndexSql(d: Dialect, def: Pick<TableDef, 'name' | 'source' | 'missingSystem'>, concurrently = false): string | null {
  const nat = naturalTerms(def)
  if (!nat.length) return null
  return `CREATE INDEX ${concurrently ? 'CONCURRENTLY ' : ''}IF NOT EXISTS ${quoteId(indexName(physicalName(def), 'index', 'natural'))} ON ${tableId(d, def)} (${nat.join(', ')})`
}

/**
 * Query v2 key index of a column: (sort key, createdOn, id). Created by default for lookup and unique columns and for
 * columns a maker marks `indexed`.
 */
export function wantsKeyIndex(col: ColumnDef): boolean {
  if (col.system || NO_INDEX.includes(col.type)) return false
  return col.type === 'lookup' || !!col.unique || !!col.indexed
}

export function keyIndexSql(d: Dialect, def: Pick<TableDef, 'name' | 'source' | 'missingSystem'>, col: ColumnDef, desc = false): string {
  const key = sortKeyExpr(d, col.type, quoteId(col.name)) + (desc ? ' DESC' : '')
  return `CREATE INDEX IF NOT EXISTS ${quoteId(indexName(physicalName(def), desc ? 'keydesc' : 'key', col.name))} ON ${tableId(d, def)} (${[key, ...naturalTerms(def)].join(', ')})`
}

/**
 * Key indexes a column wants: (key, natural) for filters, ascending sorts and seeks; for columns marked `indexed` also
 * (key DESC, natural), because a descending sort still breaks ties by natural order ASCENDING, which a backward scan of
 * the first index cannot give.
 */
export function keyIndexesSql(d: Dialect, def: Pick<TableDef, 'name' | 'source' | 'missingSystem'>, col: ColumnDef, trgmSchema?: string | null): { create: string[]; drop: string[] } {
  const table = physicalName(def)
  const dropOf = (k: 'key' | 'keydesc' | 'trgm') => `DROP INDEX IF EXISTS ${quoteId(d.schema)}.${quoteId(indexName(table, k, col.name))}`
  if (!wantsKeyIndex(col)) return { create: [], drop: [dropOf('key'), dropOf('keydesc'), dropOf('trgm')] }
  if (!col.indexed) return { create: [keyIndexSql(d, def, col)], drop: [dropOf('keydesc'), dropOf('trgm')] }
  const create = [keyIndexSql(d, def, col), keyIndexSql(d, def, col, true)]
  const drop: string[] = []
  // text columns marked indexed: a trigram index makes "contains" and Search fast (needs the pg_trgm extension)
  if (kindOf(col.type) === 'text' && trgmSchema) create.push(trigramIndexSql(d, def, col, trgmSchema))
  else drop.push(dropOf('trgm'))
  return { create, drop }
}

/** GIN trigram index on a text column's key (pg_trgm installed in `trgmSchema`) */
export function trigramIndexSql(d: Dialect, def: Pick<TableDef, 'name' | 'source' | 'missingSystem'>, col: ColumnDef, trgmSchema: string): string {
  return `CREATE INDEX IF NOT EXISTS ${quoteId(indexName(physicalName(def), 'trgm', col.name))} ON ${tableId(d, def)} USING gin ((${sortKeyExpr(d, col.type, quoteId(col.name))}) ${quoteId(trgmSchema)}.gin_trgm_ops)`
}

/**
 * CREATE INDEX for a column. Text kinds are indexed on their lowercased form, which is what conditions compare
 * (case-insensitive uniqueness like MySQL's _ci collations; lookups and owner filters use the index).
 */
export function createIndexSql(d: Dialect, def: Pick<TableDef, 'name' | 'source'>, col: ColumnDef, kind: 'unique' | 'index'): string {
  const table = physicalName(def)
  const target = kindOf(col.type) === 'text' ? `(${fold(d, quoteId(col.name))})` : quoteId(col.name)
  return `CREATE ${kind === 'unique' ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quoteId(indexName(table, kind, col.name))} ON ${tableId(d, def)} (${target})`
}

/** DROP INDEX for both possible index names of a column (before a type change or rename) */
export function dropIndexesSql(d: Dialect, def: Pick<TableDef, 'name' | 'source'>, colName: string): string[] {
  const table = physicalName(def)
  return (['unique', 'index', 'key', 'keydesc', 'trgm'] as const).map((k) => `DROP INDEX IF EXISTS ${quoteId(d.schema)}.${quoteId(indexName(table, k, colName))}`)
}

/** Columns of the physical table: system columns first, then the user columns (a def that already lists them wins). */
export function allColumns(def: TableDef): ColumnDef[] {
  const byName = new Map(def.columns.map((c) => [c.name, c]))
  // a linked table may lack system columns (def.missingSystem): they are never named in SQL
  const missing = new Set(def.missingSystem ?? [])
  const out: ColumnDef[] = SYSTEM_COLUMNS.filter((s) => !missing.has(s.name)).map((s) => {
    const given = byName.get(s.name)
    return { ...s, ...(given ?? {}), name: s.name, system: true, type: s.type }
  })
  for (const c of def.columns) if (!isSystemName(c.name)) out.push(c)
  return out
}

/** CREATE TABLE plus its indexes (run them in one transaction); `trgmSchema`: where pg_trgm is installed, if it is */
export function createTableSql(d: Dialect, def: TableDef, trgmSchema?: string | null): string[] {
  const cols = allColumns(def)
  const lines: string[] = []
  const seen = new Set<string>()
  for (const c of cols) {
    if (seen.has(c.name.toLowerCase())) throw new HttpError(422, 'invalid', `Duplicate column "${c.name}"`)
    seen.add(c.name.toLowerCase())
    lines.push(columnSql(c))
  }
  lines.push('PRIMARY KEY ("id")')
  const out = [`CREATE TABLE ${tableId(d, def)} (\n  ${lines.join(',\n  ')}\n)`]
  for (const c of cols) {
    const w = wantedIndex(c)
    if (w) out.push(createIndexSql(d, def, c, w))
    out.push(...keyIndexesSql(d, def, c, trgmSchema).create)
  }
  const nat = naturalIndexSql(d, def)
  if (nat) out.push(nat)
  out.push(...uniqueTogetherSql(d, def))
  return out
}

/* ------------------------------------------------------------------ data model designer (package K) */

/** composite unique indexes of TableDef.uniqueTogether (e.g. the pair of a many-to-many junction table) */
export function uniqueTogetherSql(d: Dialect, def: TableDef): string[] {
  const cols = allColumns(def)
  return (def.uniqueTogether ?? []).filter((set) => set.length > 1).map((set) => {
    const parts = set.map((name) => {
      const c = cols.find((x) => x.name === name)
      if (!c) throw new HttpError(422, 'invalid', `The unique pair names a missing column "${name}".`)
      return kindOf(c.type) === 'text' && c.type !== 'lookup' ? `(${fold(d, quoteId(c.name))})` : quoteId(c.name)
    })
    return `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteId(uniqueTogetherIndexName(def, set))} ON ${tableId(d, def)} (${parts.join(', ')})`
  })
}
export const uniqueTogetherIndexName = (def: Pick<TableDef, 'name' | 'source'>, set: string[]): string => indexName(physicalName(def), 'unique', `pair_${set.join('_')}`)

const VIEW_EXPR: Record<string, (col: string) => string> = {
  value: (c) => c,
  dateKey: (c) => `(to_char(${c}, 'YYYYMMDD'))::bigint`,
  year: (c) => `(EXTRACT(YEAR FROM ${c}))::bigint`,
  month: (c) => `(EXTRACT(MONTH FROM ${c}))::bigint`,
  quarter: (c) => `(EXTRACT(QUARTER FROM ${c}))::bigint`,
}

/**
 * CREATE VIEW of a reporting view (TableDef.reporting kind 'view'): generated from the lineage only (base source,
 * column mapping, a fixed set of expressions), never from SQL text. The base table's system columns pass through, so
 * the view's `id` is the base row's id (security applies the base table's row predicate to it).
 */
export function createViewSql(d: Dialect, def: TableDef): string[] {
  const r = def.reporting
  if (r?.kind !== 'view' || !r.baseSource) throw new HttpError(422, 'invalid', `"${def.displayName}" is not a reporting view with a source.`)
  const base = tableId(d, { name: r.baseSource, source: r.baseSource })
  const sel = ['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner'].map((c) => `b.${quoteId(c)}`)
  const seen = new Set(['id', 'createdon', 'modifiedon', 'createdby', 'owner'])
  for (const c of r.columns) {
    if (seen.has(c.name.toLowerCase())) throw new HttpError(422, 'invalid', `Duplicate view column "${c.name}"`)
    seen.add(c.name.toLowerCase())
    const fn = VIEW_EXPR[c.expr ?? 'value']
    if (!fn) throw new HttpError(422, 'invalid', `Unknown view expression "${String(c.expr)}"`)
    sel.push(`${fn(`b.${quoteId(c.source)}`)} AS ${quoteId(c.name)}`)
  }
  return [`CREATE VIEW ${tableId(d, def)} AS SELECT ${sel.join(', ')} FROM ${base} AS b`]
}
export const dropViewSql = (d: Dialect, def: TableDef): string => `DROP VIEW IF EXISTS ${tableId(d, def)}`

/* ------------------------------------------------------------------ value conversion */

const p2 = (n: number, w = 2): string => String(n).padStart(w, '0')
export function fmtDate(d: Date): string {
  return `${p2(d.getUTCFullYear(), 4)}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`
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
    if (s === 't' || s === 'true' || s === '1') return true
    if (s === 'f' || s === 'false' || s === '0') return false
  }
  return null
}

/** JS value -> SQL parameter for a column of this type. Throws HttpError(invalid) for unconvertible values. */
export function toDb(v: unknown, col: Pick<ColumnDef, 'name' | 'type'>): unknown {
  if (v === null || v === undefined) return null
  const bad = (): never => { throw new HttpError(422, 'invalid', `Value for "${col.name}" is not a valid ${col.type}`, col.name) }
  switch (kindOf(col.type)) {
    case 'num': { const n = toNumber(v); return n === null ? bad() : n }
    case 'bool': { const b = toBool(v); return b === null ? bad() : b }
    case 'date': { const d = toDate(v); return d === null ? bad() : fmtDate(d) }
    case 'datetime': { const d = toDate(v); return d === null ? bad() : d.toISOString() }
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
    case 'num': { const n = typeof v === 'number' ? v : Number(v); return Number.isNaN(n) ? null : n }
    case 'bool':
      if (typeof v === 'boolean') return v
      if (typeof v === 'string') return toBool(v) ?? (v !== '' && v !== '0')
      return Number(v) !== 0
    case 'date': {
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()))
      const m = /^(\d{4,})-(\d{2})-(\d{2})/.exec(String(v))
      if (!m) return toDate(v)
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
      d.setUTCFullYear(Number(m[1]))
      return d
    }
    case 'datetime': {
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
      const s = String(v)
      return toDate(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00Z' : s)
    }
    default:
      if (typeof v === 'string') return v
      if (Buffer.isBuffer(v)) return v.toString('utf8')
      if (v instanceof Date) return v.toISOString()
      if (typeof v === 'object') return JSON.stringify(v)
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

/** parameter list with typed placeholders */
export class Params {
  list: unknown[] = []
  add(v: unknown, cast: string): string {
    this.list.push(v)
    return `$${this.list.length}::${cast}`
  }
}

/**
 * Numeric-looking text (the reference: `x.trim() !== '' && !isNaN(Number(x))`), limited to decimal notation, at most
 * 250 characters and a two-digit exponent so the cast can never fail or overflow. NULL otherwise.
 */
const NUMERIC_RE = "'^[ \\t\\n\\r\\f\\v]*[+-]?([0-9]+[.]?[0-9]*([eE][+-]?[0-9]{1,2})?|[.][0-9]+([eE][+-]?[0-9]{1,2})?)[ \\t\\n\\r\\f\\v]*$'"
export const numText = (q: string): string => `(CASE WHEN char_length(${q}) <= 250 AND ${q} ~ ${NUMERIC_RE} THEN CAST(${q} AS double precision) END)`

/** the reference's numeric-looking test on a (lowercased) value */
const numericLooking = (s: string): boolean => s.trim() !== '' && !Number.isNaN(Number(s))

/**
 * JavaScript's String(number) of a double expression: PostgreSQL prints the shortest round-trip digits too, but switches
 * to exponent notation at other magnitudes (1e-05, 1e+16). In JavaScript's plain range the digits go through numeric to
 * get plain notation; outside it the exponent loses its leading zeros (1e-07 -> 1e-7).
 */
export function jsNumberText(x: string): string {
  return `(CASE WHEN abs(${x}) >= 1e21 OR (${x} <> 0 AND abs(${x}) < 1e-6) THEN regexp_replace(CAST(${x} AS text), 'e([+-])0*([0-9])', 'e\\1\\2') `
    + `ELSE CAST(CAST(CAST(${x} AS text) AS numeric) AS text) END)`
}

const textBlank = (q: string): string => `(${q} IS NULL OR ${q} = '')`
const textNonBlank = (q: string): string => `(${q} IS NOT NULL AND ${q} <> '')`

const CMP: Record<string, string> = { lt: '<', le: '<=', gt: '>', ge: '>=' }
type Op = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge'

/** SQL boolean constants */
const T = 'TRUE'
const F = 'FALSE'

/** pg date range we write as ISO text (the reference accepts any JS date) */
const inSqlRange = (d: Date): boolean => d.getUTCFullYear() >= 1 && d.getUTCFullYear() <= 9999

interface LeafCtx {
  d: Dialect
  p: Params
  managed: boolean
  /** the statement's table as SQL (correlated semi-joins name the outer row through it) */
  outer?: string
  /** columns compared exactly (no case folding): the platform-written regarding link of the core data model */
  exact?: Set<string>
}

/** the regarding columns (core data model) hold table ids and row ids the platform writes: compared as stored */
const exactCols = (def: TableDef): Set<string> | undefined => (def.regarding ? new Set([def.regarding.table, def.regarding.id]) : undefined)

/**
 * The comparison of a non-blank cell with one value, per the reference cmp():
 *  - never: not comparable (eq false, ne true, ordering false)
 *  - sign: the result is the sign of the cell's truthiness (boolean against non-boolean)
 *  - cmp: left <op> right; `left` may be NULL for a cell that is not comparable (numeric text)
 *  - before/after: the value is outside the SQL range, below or above every cell
 */
type Plan =
  | { t: 'never' }
  | { t: 'sign'; truthy: string }
  | { t: 'cmp'; left: string; right: string; nullable?: boolean }
  | { t: 'before' } | { t: 'after' }

function truthyOf(col: ColumnDef, q: string): string {
  switch (kindOf(col.type)) {
    case 'bool': return q
    case 'num': return `(${q} <> 0)`
    case 'date': return `(${q} <> DATE '1970-01-01')`
    case 'datetime': return `(${q} <> TIMESTAMPTZ '1970-01-01 00:00:00+00')`
    default: return T // a non-blank string is truthy
  }
}

function numberRight(col: ColumnDef, n: number, ctx: LeafCtx): string {
  if (col.type === 'decimal') return ctx.p.add(n, 'double precision')
  if (col.type === 'number' && Number.isSafeInteger(n)) return ctx.p.add(n, 'bigint')
  return ctx.p.add(String(n), 'numeric')
}

function planFor(col: ColumnDef, q: string, v: QueryValue, ctx: LeafCtx): Plan {
  const kind = kindOf(col.type)
  if (v === null || v === undefined) return { t: 'never' }
  if (typeof v === 'boolean') {
    if (kind === 'bool') return { t: 'cmp', left: q, right: ctx.p.add(v, 'boolean') }
    return { t: 'sign', truthy: truthyOf(col, q) }
  }
  if (kind === 'bool') return { t: 'sign', truthy: q }
  if (kind === 'num') {
    let n: number | null = null
    if (typeof v === 'number') n = Number.isFinite(v) ? v : null
    else { const s = String(v).toLowerCase(); if (numericLooking(s)) n = Number(s) }
    if (n === null || !Number.isFinite(n)) return { t: 'never' }
    return { t: 'cmp', left: q, right: numberRight(col, n, ctx) }
  }
  if (kind === 'date' || kind === 'datetime') {
    let ms: number | null = null
    if (typeof v === 'number') ms = v
    else {
      const t = Date.parse(String(v))
      if (!Number.isNaN(t)) ms = t
      else { const s = String(v).toLowerCase(); if (numericLooking(s)) ms = Number(s) }
    }
    if (ms === null || !Number.isFinite(ms)) return { t: 'never' }
    const d = new Date(ms)
    if (Number.isNaN(d.getTime())) return ms < 0 ? { t: 'before' } : { t: 'after' }
    if (!inSqlRange(d)) return d.getUTCFullYear() < 1 ? { t: 'before' } : { t: 'after' }
    if (kind === 'date') {
      if (ms % 86400000 === 0) return { t: 'cmp', left: q, right: ctx.p.add(fmtDate(d), 'date') }
      return { t: 'cmp', left: `(${q}::timestamp AT TIME ZONE 'UTC')`, right: ctx.p.add(d.toISOString(), 'timestamptz') }
    }
    return { t: 'cmp', left: q, right: ctx.p.add(d.toISOString(), 'timestamptz') }
  }
  // text
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { t: 'never' }
    return { t: 'cmp', left: numText(q), right: ctx.p.add(v, 'double precision'), nullable: true }
  }
  return { t: 'cmp', left: fold(ctx.d, q), right: ctx.p.add(String(v).toLowerCase(), 'text') }
}

/** the reference eq/ne/lt/le/gt/ge for one value, as SQL; blankSql/notBlankSql test the cell */
function compare(op: Op, plan: Plan, isBlankSql: string, notBlankSql: string, textOrder: boolean): string {
  switch (plan.t) {
    case 'never': return op === 'ne' ? T : F
    case 'before': // value below every cell: cell > value
      return op === 'ne' ? T : op === 'gt' || op === 'ge' ? `(${notBlankSql})` : F
    case 'after':
      return op === 'ne' ? T : op === 'lt' || op === 'le' ? `(${notBlankSql})` : F
    case 'sign':
      if (op === 'eq') return F
      if (op === 'ne') return T
      return op === 'gt' || op === 'ge' ? `(${notBlankSql} AND ${plan.truthy})` : `(${notBlankSql} AND NOT ${plan.truthy})`
    case 'cmp': {
      const left = textOrder && op !== 'eq' && op !== 'ne' ? `${plan.left} COLLATE "C"` : plan.left
      if (op === 'eq') return `(${left} = ${plan.right})`
      if (op === 'ne') return `(${isBlankSql} OR ${plan.nullable ? `COALESCE(${left} <> ${plan.right}, TRUE)` : `${left} <> ${plan.right}`})`
      return `(${notBlankSql} AND ${left} ${CMP[op]} ${plan.right})`
    }
  }
}

/** the string form of a cell for contains / startsWith / endsWith (lowercased where it can have capitals) */
function stringForm(col: ColumnDef, q: string, d: Dialect): string {
  switch (kindOf(col.type)) {
    case 'text': return fold(d, q)
    case 'num': return jsNumberText(`CAST(${q} AS double precision)`)
    case 'bool': return `(CASE WHEN ${q} THEN 'true' ELSE 'false' END)`
    case 'date': return `to_char(${q}, 'YYYY-MM-DD')`
    case 'datetime': return `to_char(${q} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
  }
}

function leaf(c: { col: string; op: string; value?: QueryValue | QueryValue[] }, cols: Cols, ctx: LeafCtx): string {
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
    if (Array.isArray(v)) return F
    const needle = ctx.p.add(String(v ?? '').toLowerCase(), 'text')
    const s = stringForm(col, q, ctx.d)
    const test = op === 'contains' ? `strpos(${s}, ${needle}) > 0` : op === 'startsWith' ? `starts_with(${s}, ${needle})` : `right(${s}, char_length(${needle})) = ${needle}`
    return `(${notBlankSql} AND ${test})`
  }

  // the managed id column holds lowercase UUIDs: compare exactly (uses the primary key)
  const fastId = (ctx.managed && col.name === 'id') || !!ctx.exact?.has(col.name)

  if (op === 'in') {
    if (!Array.isArray(v)) return F
    return inList(col, q, v, ctx, fastId)
  }
  if (!(op === 'eq' || op === 'ne' || op in CMP)) return F
  if (Array.isArray(v)) return F
  const scalar = v as QueryValue
  if (fastId && typeof scalar === 'string' && (op === 'eq' || op === 'ne')) {
    const r = ctx.p.add(ctx.exact?.has(col.name) ? scalar : scalar.toLowerCase(), 'text')
    return op === 'eq' ? `(${q} = ${r})` : `(${q} IS NULL OR ${q} <> ${r})`
  }
  if (kind === 'text' && typeof scalar === 'string' && scalar === '') {
    // the reference: a blank cell never equals '', any non-blank text is greater than ''
    if (op === 'eq') return F
    if (op === 'ne') return T
  }
  return compare(op as Op, planFor(col, q, scalar, ctx), isBlankSql, notBlankSql, kind === 'text' && typeof scalar === 'string')
}

/** `in`: true when some element compares equal (the reference's some(cmp === 0)) */
function inList(col: ColumnDef, q: string, v: QueryValue[], ctx: LeafCtx, fastId: boolean): string {
  const kind = kindOf(col.type)
  const items = v.filter((x) => x !== null && x !== undefined)
  const parts: string[] = []
  if (kind === 'bool') {
    const bs = [...new Set(items.filter((x): x is boolean => typeof x === 'boolean'))]
    if (bs.length) parts.push(`${q} = ANY(${ctx.p.add(bs, 'boolean[]')})`)
  } else if (kind === 'num') {
    const nums: number[] = []
    for (const x of items) {
      if (typeof x === 'number' && Number.isFinite(x)) nums.push(x)
      else if (typeof x === 'string' && numericLooking(x.toLowerCase())) nums.push(Number(x.toLowerCase()))
    }
    const list = [...new Set(nums.filter((n) => Number.isFinite(n)))]
    if (list.length) {
      if (col.type === 'decimal') parts.push(`${q} = ANY(${ctx.p.add(list, 'double precision[]')})`)
      else if (col.type === 'number') {
        const ints = list.filter((n) => Number.isSafeInteger(n))
        if (ints.length) parts.push(`${q} = ANY(${ctx.p.add(ints, 'bigint[]')})`)
      } else parts.push(`${q} = ANY(${ctx.p.add(list.map(String), 'numeric[]')})`)
    }
  } else if (kind === 'date' || kind === 'datetime') {
    const ds: Date[] = []
    for (const x of items) {
      if (typeof x === 'boolean') continue
      let ms: number | null = null
      if (typeof x === 'number') ms = x
      else {
        const t = Date.parse(x)
        if (!Number.isNaN(t)) ms = t
        else if (numericLooking(x.toLowerCase())) ms = Number(x.toLowerCase())
      }
      if (ms === null || !Number.isFinite(ms)) continue
      const d = new Date(ms)
      if (!Number.isNaN(d.getTime()) && inSqlRange(d)) ds.push(d)
    }
    if (kind === 'date') {
      // a date cell is always midnight UTC: other instants can never be equal
      const days = [...new Set(ds.filter((d) => d.getTime() % 86400000 === 0).map(fmtDate))]
      if (days.length) parts.push(`${q} = ANY(${ctx.p.add(days, 'date[]')})`)
    } else if (ds.length) parts.push(`${q} = ANY(${ctx.p.add([...new Set(ds.map((d) => d.toISOString()))], 'timestamptz[]')})`)
  } else {
    const strs = [...new Set(items.filter((x): x is string => typeof x === 'string' && x !== '').map((s) => s.toLowerCase()))]
    const nums = [...new Set(items.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)))]
    if (strs.length) parts.push(fastId ? `${q} = ANY(${ctx.p.add(strs, 'text[]')})` : `${fold(ctx.d, q)} = ANY(${ctx.p.add(strs, 'text[]')})`)
    if (nums.length) parts.push(`${numText(q)} = ANY(${ctx.p.add(nums, 'double precision[]')})`)
  }
  return parts.length ? `(${parts.join(' OR ')})` : F
}

function translate(c: Condition | undefined, cols: Cols, ctx: LeafCtx, negated: boolean): string {
  if (!c) return T
  if ('const' in c) return c.const ? T : F
  if ('and' in c) return c.and.length ? '(' + c.and.map((x) => translate(x, cols, ctx, negated)).join(' AND ') + ')' : T
  if ('or' in c) return c.or.length ? '(' + c.or.map((x) => translate(x, cols, ctx, negated)).join(' OR ') + ')' : F
  if ('not' in c) return `(NOT ${translate(c.not, cols, ctx, true)})`
  if ('semi' in c) {
    const sql = semiJoin(c.semi, cols, ctx)
    return negated ? `COALESCE(${sql}, FALSE)` : sql
  }
  const sql = leaf(c, cols, ctx)
  // under NOT, NULL would stay NULL (and be filtered out); the in-memory reference treats it as false
  return negated ? `COALESCE(${sql}, FALSE)` : sql
}

/**
 * Relationship rule (security engine only): `col IN (SELECT key FROM target WHERE ...)` in the same statement, same
 * schema (the engine only builds it for tables of the same connection). Both sides are compared the way the indexes
 * are built: text kinds lowercased (the lookup index is on the folded value), the managed id column as stored.
 * PostgreSQL plans it as a (hashed) semi-join; the inner WHERE uses the target's own indexes.
 */
function semiJoin(s: { col: string; table: TableDef; key: string; where: Condition; correlated?: boolean }, cols: Cols, ctx: LeafCtx): string {
  const outer = cols.get(s.col)
  const target = s.table
  const tcols = new Cols(target)
  const inner = tcols.get(s.key)
  const expr = (col: ColumnDef, managed: boolean, q: string, asText: boolean): string => {
    if (managed && col.name === 'id') return q
    if (col === outer && ctx.exact?.has(col.name)) return q
    if (kindOf(col.type) === 'text') return fold(ctx.d, q)
    return asText ? `lower(CAST(${q} AS text))` : q
  }
  const mixed = kindOf(outer.type) !== kindOf(inner.type)
  const left = expr(outer, ctx.managed, quoteId(outer.name), mixed)
  const right = expr(inner, target.managed === true, quoteId(inner.name), mixed)
  if (s.correlated && ctx.outer) {
    // EXISTS with a primary-key probe per outer row (core data model "regarding" rule): the inner table gets an alias, so
    // the outer table's qualified name refers to the outer row; the inner WHERE's unqualified columns are the inner row's
    const alias = `"__s${ctx.p.list.length}_${++aliasSeq % 100000}"`
    const outerRef = expr(outer, ctx.managed, `${ctx.outer}.${quoteId(outer.name)}`, mixed)
    const innerRef = expr(inner, target.managed === true, `${alias}.${quoteId(inner.name)}`, mixed)
    const w = translate(s.where, tcols, { d: ctx.d, p: ctx.p, managed: target.managed === true, outer: alias, exact: exactCols(target) }, false)
    return `EXISTS (SELECT 1 FROM ${tableId(ctx.d, target)} AS ${alias} WHERE ${innerRef} = ${outerRef} AND ${w})`
  }
  const where = translate(s.where, tcols, { d: ctx.d, p: ctx.p, managed: target.managed === true, outer: tableId(ctx.d, target), exact: exactCols(target) }, false)
  return `(${left} IN (SELECT ${right} FROM ${tableId(ctx.d, target)} WHERE ${right} IS NOT NULL AND ${where}))`
}
let aliasSeq = 0

/** WHERE fragment; parameters continue after `offset` existing ones */
export function buildWhere(d: Dialect, def: TableDef, cond: Condition | undefined, params: Params = new Params()): Built {
  const sql = translate(cond, new Cols(def), { d, p: params, managed: def.managed === true, outer: tableId(d, def), exact: exactCols(def) }, false)
  return { sql, params: params.list }
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

export function buildSelect(d: Dialect, def: TableDef, q: Query): SelectPlan {
  const cols = new Cols(def)
  const hasId = !(def.missingSystem ?? []).includes('id')
  const names = q.select && q.select.length ? [...new Set([...q.select, ...(hasId ? ['id'] : [])])] : cols.all().map((c) => c.name)
  const selected = names.map((n) => cols.get(n))
  const where = buildWhere(d, def, q.where)
  const t = tableId(d, def)
  const order: string[] = []
  for (const o of q.orderBy ?? []) {
    const c = cols.get(o.col)
    const qc = quoteId(c.name)
    const dir = o.dir === 'desc' ? 'DESC' : 'ASC'
    // blanks (NULL and '') are equal to each other: the next key (or the id tie-breaker) orders them, like applyQuery
    if (kindOf(c.type) === 'text') order.push(`${textBlank(qc)} ASC`, `NULLIF(${fold(d, qc)}, '') COLLATE "C" ${dir}`)
    else order.push(`(${qc} IS NULL) ASC`, `${qc} ${dir}`)
  }
  const paged = q.top !== undefined || (q.skip ?? 0) > 0
  // deterministic insertion order: with no sort, and as the tie-breaker of an explicit sort (stable like the in-memory
  // applyQuery). Row ids are UUIDv7 (time-ordered, server/core/util.ts rowUid), so id breaks createdOn ties.
  // Only columns the def lists (a linked table may lack the system columns); paging always needs the id tie-breaker.
  if (!(q.orderBy ?? []).some((o) => o.col === 'id')) {
    const listed = new Set(def.columns.map((c) => c.name))
    const missing = new Set(def.missingSystem ?? [])
    if (listed.has('createdOn') && !missing.has('createdOn')) order.push('"createdOn" ASC')
    if (hasId && (listed.has('id') || paged)) order.push('"id" ASC')
  }
  let sql = `SELECT ${selected.map((c) => quoteId(c.name)).join(', ')} FROM ${t} WHERE ${where.sql}`
  if (order.length) sql += ` ORDER BY ${order.join(', ')}`
  if (paged) {
    if (q.top !== undefined) sql += ` LIMIT ${intArg(q.top, 'top')}`
    const skip = intArg(q.skip ?? 0, 'skip')
    if (skip) sql += ` OFFSET ${skip}`
  }
  const plan: SelectPlan = { sql, params: where.params, columns: selected }
  if (q.count) {
    plan.countSql = `SELECT count(*)::bigint AS n FROM ${t} WHERE ${where.sql}`
    plan.countParams = where.params
  }
  return plan
}

/** PostgreSQL allows 65535 parameters per statement */
const MAX_PARAMS = 60000
const MAX_ROWS_PER_INSERT = 500

export function buildInserts(d: Dialect, def: TableDef, rows: RawRow[]): Built[] {
  if (!rows.length) return []
  const cols = new Cols(def)
  const present = new Set<string>()
  for (const r of rows) for (const [k, v] of Object.entries(r)) { if (v !== undefined) { cols.get(k); present.add(k) } }
  const ordered = cols.all().filter((c) => present.has(c.name))
  if (!ordered.length) throw new HttpError(422, 'invalid', 'Nothing to insert')
  const perChunk = Math.max(1, Math.min(MAX_ROWS_PER_INSERT, Math.floor(MAX_PARAMS / ordered.length)))
  const out: Built[] = []
  for (let i = 0; i < rows.length; i += perChunk) {
    const params: unknown[] = []
    const tuples = rows.slice(i, i + perChunk).map((r) => '(' + ordered.map((c) => {
      const v = r[c.name]
      if (v === undefined) return 'DEFAULT'
      params.push(toDb(v, c))
      return `$${params.length}`
    }).join(', ') + ')')
    out.push({ sql: `INSERT INTO ${tableId(d, def)} (${ordered.map((c) => quoteId(c.name)).join(', ')}) VALUES ${tuples.join(', ')}`, params })
  }
  return out
}

/** UPDATE ... WHERE id = $n AND guard. Returns null when there is nothing to set (caller counts instead). */
export function buildUpdate(d: Dialect, def: TableDef, id: string, changes: RawRow, guard?: Condition): Built | null {
  const cols = new Cols(def)
  const p = new Params()
  const sets: string[] = []
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined || k === 'id') continue
    const c = cols.get(k)
    p.list.push(toDb(v, c))
    sets.push(`${quoteId(c.name)} = $${p.list.length}`)
  }
  if (!sets.length) return null
  const idRef = p.add(id, 'text')
  const g = buildWhere(d, def, guard, p)
  return { sql: `UPDATE ${tableId(d, def)} SET ${sets.join(', ')} WHERE "id" = ${idRef} AND ${g.sql}`, params: p.list }
}

export function buildCountById(d: Dialect, def: TableDef, id: string, guard?: Condition): Built {
  const p = new Params()
  const idRef = p.add(id, 'text')
  const g = buildWhere(d, def, guard, p)
  return { sql: `SELECT count(*)::bigint AS n FROM ${tableId(d, def)} WHERE "id" = ${idRef} AND ${g.sql}`, params: p.list }
}

const DELETE_CHUNK = 5000

export function buildDeletes(d: Dialect, def: TableDef, ids: string[], guard?: Condition): Built[] {
  const out: Built[] = []
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    const p = new Params()
    const idsRef = p.add(ids.slice(i, i + DELETE_CHUNK), 'text[]')
    const g = buildWhere(d, def, guard, p)
    out.push({ sql: `DELETE FROM ${tableId(d, def)} WHERE "id" = ANY(${idsRef}) AND ${g.sql}`, params: p.list })
  }
  return out
}

export function columnTypesByName(def: TableDef): Map<string, ColumnType> {
  return new Map(allColumns(def).map((c) => [c.name, c.type]))
}

/* ------------------------------------------------------------------ information_schema -> ColumnType */

export function mapSqlType(c: { dataType: string; udtName?: string; scale?: number | null; precision?: number | null }): ColumnType {
  const t = c.dataType.toLowerCase()
  switch (t) {
    case 'boolean': return 'boolean'
    case 'smallint': case 'integer': case 'bigint': return 'number'
    case 'numeric': case 'decimal':
      if (Number(c.precision) === 19 && Number(c.scale) === 4) return 'currency'
      return c.scale !== null && c.scale !== undefined && Number(c.scale) === 0 ? 'number' : 'decimal'
    case 'real': case 'double precision': case 'money': return 'decimal'
    case 'date': return 'date'
    case 'timestamp with time zone': case 'timestamp without time zone': return 'datetime'
    case 'text': case 'json': case 'jsonb': case 'xml': return 'multiline'
    case 'user-defined': return 'choice' // enums (and other user types: shown as text values)
    default: return 'text' // character varying, character, uuid, time, interval, arrays, bytea, ...
  }
}
