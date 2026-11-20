/**
 * Query v2 (docs/dev/query-v2.md) -> ONE PostgreSQL statement per plan (P0 package D). Pure: no I/O, unit-testable.
 *
 * The plan has been validated (src/fx/query/validate.ts) against the caller's visible columns; security arrives as a
 * v1 row-filter Condition (the caller's row scope and role row filters, server/core/security.ts) that is translated by
 * the v1 builder (sql.ts buildWhere) with v1 semantics and ANDed into the same WHERE, so the rows, the count and every
 * aggregate only ever see rows the caller may read.
 *
 * Index-friendly shape: every condition on a column compares its normalised SORT KEY K(col) (section 5 of the spec:
 * COALESCE(lower(col), '') COLLATE "C", COALESCE(num, 0), ...) and adds `col IS NOT NULL` for strictness. One btree
 * index on (K(col), N, id) therefore serves equality, ranges, prefix (LIKE on a "C" key), sorting and keyset seeks on
 * that column. N = COALESCE("createdOn", '-infinity') and id COLLATE "C" are the natural-order tie-breakers.
 *
 * Every identifier comes from table metadata through quoteId(); every value is a typed `$n` parameter.
 */
import type { ColumnDef, ColumnType, TableDef } from '../../../src/platform/contracts.ts'
import type { Condition } from '../../../src/platform/http.ts'
import type { BucketV2, CompareOpV2, ConditionV2, MeasureV2, NumExprV2, QueryPlan, SortKeyV2 } from '../../../src/platform/query.ts'
import { bucketKind } from '../../../src/platform/query.ts'
import { decodeCursor, CursorError, type DecodedCursor } from '../../../src/fx/query/cursor.ts'
import { HttpError } from '../../core/contracts.ts'
import { Params, allColumns, buildWhere, fold, kindOf, naturalTerms, quoteId, sortKeyExpr, tableId } from './sql.ts'
import type { Dialect } from './sql.ts'

const CMP_SQL: Record<CompareOpV2, string> = { eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>=' }
const T = 'TRUE'
const F = 'FALSE'

export interface V2Options {
  /** the caller's row filter (v1 semantics); undefined = every row (system / administrators) */
  rowFilter?: Condition
  /** lookup paths (`via` conditions): the tables they read and the caller's row filter on each (same schema) */
  related?: Record<string, { def: TableDef; rowFilter?: Condition }>
  /** columns returned when the plan has no select (the caller's visible columns) */
  visible: string[]
  maxUnpagedRows: number
  maxGroups: number
}

/** a column of the result: name in the result row, type for value conversion */
export interface V2OutColumn { name: string; type: ColumnType }

export interface V2Statement {
  sql: string
  params: unknown[]
  kind: 'rows' | 'aggregate' | 'count'
  columns: V2OutColumn[]
  /** rows: the page size asked for (the statement fetches one more row to see whether there is a next page) */
  pageSize?: number
  /** rows without page: the statement fetches one more row than allowed to detect an oversized result */
  unpagedLimit?: number
  /** the statement also returns the exact count in column __count */
  withCount: boolean
  /** the result carries the hidden cursor columns __c0.., __cn, __ci */
  cursorKeys: number
}

const bad = (msg: string): never => { throw new HttpError(422, 'invalid', msg) }

class Cols {
  private map = new Map<string, ColumnDef>()
  constructor(def: TableDef) { for (const c of allColumns(def)) this.map.set(c.name, c) }
  get(name: string): ColumnDef {
    const c = this.map.get(name)
    if (!c) return bad(`Column "${String(name).slice(0, 64)}" does not exist`)
    return c
  }
  has(name: string): boolean { return this.map.has(name) }
}

export class V2Builder {
  readonly d: Dialect
  readonly def: TableDef
  readonly cols: Cols
  readonly p: Params
  readonly hasCreatedOn: boolean
  readonly hasId: boolean
  related: V2Options['related'] = {}

  constructor(d: Dialect, def: TableDef, p?: Params) {
    this.d = d
    this.def = def
    this.p = p ?? new Params()
    this.cols = new Cols(def)
    const missing = new Set(def.missingSystem ?? [])
    this.hasCreatedOn = !missing.has('createdOn') && this.cols.has('createdOn')
    this.hasId = !missing.has('id')
  }

  q(name: string): string { return quoteId(this.cols.get(name).name) }

  /* -------------------------------------------------------------- sort keys and literals */

  /** the normalised sort key of a column (spec section 5); `ref` overrides the column reference (aliases) */
  key(col: ColumnDef, ref?: string): string {
    return sortKeyExpr(this.d, col.type, ref ?? quoteId(col.name))
  }

  /** natural-order tie-breakers */
  natural(prefix = ''): string[] {
    return naturalTerms(this.def, prefix)
  }

  /** a number literal for a number column of this SQL type; null when it can never equal a cell (non-integer vs bigint) */
  numParam(col: ColumnDef, n: number): string {
    if (col.type === 'number') return this.p.add(n, 'bigint')
    if (col.type === 'currency') return this.p.add(String(n), 'numeric')
    return this.p.add(n, 'double precision')
  }

  lit(col: ColumnDef, v: unknown, exact: boolean): string {
    switch (kindOf(col.type)) {
      case 'text': return this.p.add(exact ? String(v) : String(v).toLowerCase(), 'text')
      case 'num': return this.numParam(col, v as number)
      case 'bool': return this.p.add(v === true ? 1 : 0, 'int')
      case 'date': return this.p.add((v as { $date: string }).$date, 'date')
      case 'datetime': return this.p.add(new Date(Date.parse((v as { $datetime: string }).$datetime)).toISOString(), 'timestamptz')
    }
  }

  /* -------------------------------------------------------------- conditions */

  compare(col: ColumnDef, op: CompareOpV2, v: unknown, exact: boolean): string {
    const q = quoteId(col.name)
    const k = kindOf(col.type)
    if (k === 'text' && exact) return `(${q} IS NOT NULL AND ${q} COLLATE "C" ${CMP_SQL[op]} ${this.p.add(String(v), 'text')})`
    if (k === 'num' && col.type === 'number' && !Number.isInteger(v as number)) {
      // an integer column against a fraction: rewrite to an integer bound (keeps the bigint index usable)
      const n = v as number
      switch (op) {
        case 'eq': return F
        case 'ne': return `(${q} IS NOT NULL)`
        case 'lt': case 'le': return `(${q} IS NOT NULL AND ${this.key(col)} <= ${this.p.add(Math.floor(n), 'bigint')})`
        case 'gt': case 'ge': return `(${q} IS NOT NULL AND ${this.key(col)} >= ${this.p.add(Math.ceil(n), 'bigint')})`
      }
    }
    if (k === 'num' && col.type === 'number' && !Number.isSafeInteger(v as number)) {
      return `(${q} IS NOT NULL AND ${this.key(col)} ${CMP_SQL[op]} ${this.p.add(String(v), 'numeric')})`
    }
    return `(${q} IS NOT NULL AND ${this.key(col)} ${CMP_SQL[op]} ${this.lit(col, v, false)})`
  }

  inList(col: ColumnDef, values: unknown[], exact: boolean): string {
    const q = quoteId(col.name)
    if (!values.length) return F
    switch (kindOf(col.type)) {
      case 'text': {
        const list = [...new Set(values.map((v) => (exact ? String(v) : String(v).toLowerCase())))]
        return exact ? `(${q} IS NOT NULL AND ${q} COLLATE "C" = ANY(${this.p.add(list, 'text[]')}))` : `(${q} IS NOT NULL AND ${this.key(col)} = ANY(${this.p.add(list, 'text[]')}))`
      }
      case 'num': {
        const nums = [...new Set(values as number[])]
        if (col.type === 'number') {
          const ints = nums.filter((n) => Number.isSafeInteger(n))
          return ints.length ? `(${q} IS NOT NULL AND ${this.key(col)} = ANY(${this.p.add(ints, 'bigint[]')}))` : F
        }
        if (col.type === 'currency') return `(${q} IS NOT NULL AND ${this.key(col)} = ANY(${this.p.add(nums.map(String), 'numeric[]')}))`
        return `(${q} IS NOT NULL AND ${this.key(col)} = ANY(${this.p.add(nums, 'double precision[]')}))`
      }
      case 'bool': return `(${q} IS NOT NULL AND ${this.key(col)} = ANY(${this.p.add([...new Set(values.map((v) => (v === true ? 1 : 0)))], 'int[]')}))`
      case 'date': return `(${q} IS NOT NULL AND ${this.key(col)} = ANY(${this.p.add([...new Set(values.map((v) => (v as { $date: string }).$date))], 'date[]')}))`
      case 'datetime': return `(${q} IS NOT NULL AND ${this.key(col)} = ANY(${this.p.add([...new Set(values.map((v) => new Date(Date.parse((v as { $datetime: string }).$datetime)).toISOString()))], 'timestamptz[]')}))`
    }
  }

  textTest(col: ColumnDef, op: 'contains' | 'startsWith' | 'endsWith', value: string, exact: boolean): string {
    const q = quoteId(col.name)
    const s = exact ? `${q} COLLATE "C"` : this.key(col)
    const v = exact ? value : value.toLowerCase()
    // LIKE '%...%' on the "C" key: a plain substring test (the pattern escapes \ % _), and a trigram index can serve it
    if (op === 'contains') return `(${q} IS NOT NULL AND ${s} LIKE ${this.p.add('%' + likeEscape(v) + '%', 'text')} ESCAPE '\\')`
    if (op === 'startsWith') {
      // LIKE on a "C" collated key can use the btree index on K(col); the pattern escapes \ % _
      const pattern = likeEscape(v) + '%'
      return `(${q} IS NOT NULL AND ${s} LIKE ${this.p.add(pattern, 'text')} ESCAPE '\\')`
    }
    const r = this.p.add(v, 'text')
    return `(${q} IS NOT NULL AND right(${s}, char_length(${r})) = ${r})`
  }

  /** a strict ConditionV2 -> a two-valued SQL boolean (never NULL, so NOT is safe) */
  cond(c: ConditionV2): string {
    if ('const' in c) return c.const ? T : F
    if ('and' in c) return c.and.length ? '(' + c.and.map((x) => this.cond(x)).join(' AND ') + ')' : T
    if ('or' in c) return c.or.length ? '(' + c.or.map((x) => this.cond(x)).join(' OR ') + ')' : F
    if ('not' in c) return `(NOT ${this.cond(c.not)})`
    if ('via' in c) return this.via(c.via)
    if (c.op === 'cmpExpr') return `(${this.expr(c.left)} ${CMP_SQL[c.cmp]} ${this.expr(c.right)})`
    const col = this.cols.get(c.col)
    const exact = 'exact' in c && c.exact === true
    switch (c.op) {
      case 'isNull': return `(${quoteId(col.name)} IS NULL)`
      case 'in': return this.inList(col, c.value, exact)
      case 'contains': case 'startsWith': case 'endsWith': return this.textTest(col, c.op, c.value, exact)
      case 'cmpCol': {
        const other = this.cols.get(c.other)
        const a = quoteId(col.name)
        const b = quoteId(other.name)
        const both = `${a} IS NOT NULL AND ${b} IS NOT NULL`
        if (exact) return `(${both} AND ${a} COLLATE "C" ${CMP_SQL[c.cmp]} ${b} COLLATE "C")`
        return `(${both} AND ${this.key(col)} ${CMP_SQL[c.cmp]} ${this.key(other)})`
      }
      default: return this.compare(col, c.op, c.value, exact)
    }
  }

  /**
   * Lookup path: `col IN (SELECT id FROM target WHERE <where> AND <caller's row filter on target>)`, one uncorrelated
   * sub-select over the target's primary key; with orMissing also the rows whose lookup is blank or points at a row
   * that is missing or unreadable.
   */
  via(v: { col: string; table: string; where: ConditionV2; orMissing?: true }): string {
    const rel = this.related?.[v.table]
    if (!rel) return bad(`The lookup table ${v.table.slice(0, 64)} cannot be read in this query`)
    const col = this.cols.get(v.col)
    const sub = new V2Builder(this.d, rel.def, this.p)
    const t = tableId(this.d, rel.def)
    // the target's row filter and its live rows (recycle bin): one buildWhere, like the statement's own table
    const rw = buildWhere(this.d, rel.def, rel.rowFilter && !('const' in rel.rowFilter && rel.rowFilter.const) ? rel.rowFilter : undefined, this.p).sql
    const rf = rw === T ? T : `(${rw})`
    const q = quoteId(col.name)
    const hit = `(${q} IS NOT NULL AND ${q} IN (SELECT "id" FROM ${t} WHERE "id" IS NOT NULL AND ${sub.cond(v.where)} AND ${rf}))`
    if (!v.orMissing) return hit
    return `(${hit} OR ${q} IS NULL OR ${q} NOT IN (SELECT "id" FROM ${t} WHERE "id" IS NOT NULL AND ${rf}))`
  }

  /* -------------------------------------------------------------- numeric expressions (float8, like the engine) */

  expr(e: NumExprV2): string {
    if (typeof e === 'number') return this.p.add(e, 'double precision')
    if ('col' in e) {
      const col = this.cols.get(e.col)
      const q = quoteId(col.name)
      return kindOf(col.type) === 'bool' ? `COALESCE(${q}::int, 0)::double precision` : `COALESCE(${q}::double precision, 0::double precision)`
    }
    switch (e.fn) {
      case 'add': return `(${this.expr(e.args[0])} + ${this.expr(e.args[1])})`
      case 'sub': return `(${this.expr(e.args[0])} - ${this.expr(e.args[1])})`
      case 'mul': return `(${this.expr(e.args[0])} * ${this.expr(e.args[1])})`
      case 'div': return `(${this.expr(e.args[0])} / ${this.expr(e.args[1])})`
      case 'neg': return `(0::double precision - ${this.expr(e.args[0])})`
      case 'abs': return `abs(${this.expr(e.args[0])})`
      default: return this.round(e.fn, this.expr(e.args[0]), e.digits)
    }
  }

  /**
   * The engine rounds the shortest decimal form of the double (String(x)) unless that form is exponential (|x| >= 1e21
   * or 0 < |x| < 1e-6), where it scales by 10^digits in floating point. PostgreSQL's float8 output is the same shortest
   * form, so x::text::numeric is the exact decimal the engine rounds.
   */
  round(fn: 'round' | 'roundUp' | 'roundDown', x: string, digits: number): string {
    const d = this.p.add(digits, 'int')
    const ax = `abs(${x})`
    const sign = `(CASE WHEN ${x} < 0 THEN -1::double precision ELSE 1::double precision END)`
    const expo = `(${ax} >= 1e21::double precision OR (${x} <> 0 AND ${ax} < 1e-6::double precision))`
    const m = `power(10::double precision, ${d}::double precision)`
    const dec = `(${ax})::text::numeric`
    const pm = `power(10::numeric, ${d})`
    let viaExp: string
    let viaDec: string
    if (fn === 'round') {
      viaExp = `(${sign} * floor(${ax} * ${m} + 0.5::double precision) / ${m})`
      viaDec = `(${sign} * (round(${dec}, ${d}))::double precision)`
    } else if (fn === 'roundUp') {
      viaExp = `((CASE WHEN ${x} < 0 THEN floor(${x} * ${m}) ELSE ceil(${x} * ${m}) END) / ${m})`
      viaDec = `(${sign} * (ceil(${dec} * ${pm}) / ${pm})::double precision)`
    } else {
      viaExp = `(trunc(${x} * ${m}) / ${m})`
      viaDec = `(${sign} * (trunc(${dec}, ${d}))::double precision)`
    }
    return `(CASE WHEN ${x} = 0 THEN 0::double precision WHEN ${expo} THEN ${viaExp} ELSE ${viaDec} END)`
  }

  /* -------------------------------------------------------------- where, order, seek */

  where(plan: QueryPlan, rowFilter: Condition | undefined): string {
    const parts: string[] = []
    // v1 semantics for row filters, parameters continue in the same list. The parts are ANDed at the top of the WHERE,
    // where NULL already excludes the row: no COALESCE around it, so the owner, lookup and id indexes stay usable.
    // Always through buildWhere, also without a row filter: it adds the live-row predicate of the recycle bin
    const w = buildWhere(this.d, this.def, rowFilter && !('const' in rowFilter && rowFilter.const) ? rowFilter : undefined, this.p)
    if (w.sql !== T) parts.push(`(${w.sql})`)
    if (plan.filter) parts.push(this.cond(plan.filter))
    if (plan.search && plan.search.text !== '' && plan.search.columns.length) {
      const needle = this.p.add('%' + likeEscape(plan.search.text.toLowerCase()) + '%', 'text')
      parts.push('(' + plan.search.columns.map((c) => {
        const col = this.cols.get(c)
        return `(${quoteId(col.name)} IS NOT NULL AND ${this.key(col)} LIKE ${needle} ESCAPE '\\')`
      }).join(' OR ') + ')')
    } else if (plan.search && plan.search.text !== '' && !plan.search.columns.length) parts.push(F)
    return parts.length ? parts.join(' AND ') : T
  }

  /** ORDER BY terms of the stream (sort keys, then natural order ascending); `reverse` flips every term (take from end) */
  orderTerms(sort: SortKeyV2[], reverse: boolean, ref?: (i: number) => string, nat?: string[]): string[] {
    const flip = (dir: 'asc' | 'desc') => ((dir === 'asc') !== reverse ? 'ASC' : 'DESC')
    const out = sort.map((k, i) => `${ref ? ref(i) : this.key(this.cols.get(k.col))} ${flip(k.dir)}`)
    for (const n of nat ?? this.natural()) out.push(`${n} ${flip('asc')}`)
    return out
  }

  /** cursor key literal of a sort column (normalised as in cursor.ts) */
  cursorParam(col: ColumnDef, v: unknown): string {
    const wrong = (): never => bad('The page cursor does not match this query; start from the first page')
    switch (kindOf(col.type)) {
      case 'text': return typeof v === 'string' ? this.p.add(v, 'text') : wrong()
      case 'num': {
        if (typeof v !== 'number' || !Number.isFinite(v)) return wrong()
        if (col.type === 'number' && !Number.isSafeInteger(v)) return this.p.add(String(v), 'numeric')
        return this.numParam(col, v)
      }
      case 'bool': return v === 0 || v === 1 ? this.p.add(v, 'int') : wrong()
      case 'date':
        if (v === null) return `'-infinity'::date`
        return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? this.p.add(v, 'date') : wrong()
      case 'datetime':
        if (v === null) return `'-infinity'::timestamptz`
        return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 8.64e15 ? this.p.add(new Date(v).toISOString(), 'timestamptz') : wrong()
    }
  }

  /** rows strictly after the cursor in the total order (keys, then createdOn asc, id asc) */
  seek(sort: SortKeyV2[], cur: DecodedCursor, ref: (i: number) => string, nat: string[]): string {
    if (!this.hasId) bad('This table has no id column, so it cannot be paged with a cursor')
    const terms: { expr: string; val: string; dir: 'asc' | 'desc' }[] = sort.map((k, i) => ({ expr: ref(i), val: this.cursorParam(this.cols.get(k.col), cur.keys[i] ?? null), dir: k.dir }))
    if (this.hasCreatedOn) {
      let c = `'-infinity'::timestamptz`
      if (cur.createdOn !== null) {
        const t = Date.parse(cur.createdOn)
        if (Number.isNaN(t)) bad('The page cursor is not valid; start from the first page')
        c = this.p.add(new Date(t).toISOString(), 'timestamptz')
      }
      terms.push({ expr: nat[0]!, val: c, dir: 'asc' })
    }
    terms.push({ expr: nat[nat.length - 1]!, val: this.p.add(cur.id, 'text'), dir: 'asc' })
    if (terms.every((t) => t.dir === 'asc')) {
      return `((${terms.map((t) => t.expr).join(', ')}) > (${terms.map((t) => t.val).join(', ')}))`
    }
    const ors: string[] = []
    for (let i = 0; i < terms.length; i++) {
      const eqs = terms.slice(0, i).map((t) => `${t.expr} = ${t.val}`)
      const t = terms[i]!
      eqs.push(`${t.expr} ${t.dir === 'asc' ? '>' : '<'} ${t.val}`)
      ors.push('(' + eqs.join(' AND ') + ')')
    }
    // the leading key's bound, redundant but index-usable (the OR form alone is only a filter): the scan starts at the cursor
    const lead = terms[0]!
    return `(${lead.expr} ${lead.dir === 'asc' ? '>=' : '<='} ${lead.val} AND (${ors.join(' OR ')}))`
  }

  /** the hidden cursor columns of a row (normalised keys, createdOn ISO, id) */
  cursorColumns(sort: SortKeyV2[], ref: (i: number) => string, prefix: string): string[] {
    const out = sort.map((k, i) => {
      const col = this.cols.get(k.col)
      const e = ref(i)
      switch (kindOf(col.type)) {
        case 'date': return `(CASE WHEN ${e} = '-infinity'::date THEN NULL ELSE to_char(${e}, 'YYYY-MM-DD') END) AS "__c${i}"`
        case 'datetime': return `(CASE WHEN ${e} = '-infinity'::timestamptz THEN NULL ELSE (round(extract(epoch FROM ${e}) * 1000))::double precision END) AS "__c${i}"`
        case 'num': return `(${e})::double precision AS "__c${i}"`
        default: return `${e} AS "__c${i}"`
      }
    })
    out.push(this.hasCreatedOn ? `to_char(${prefix}"createdOn" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "__cn"` : `NULL::text AS "__cn"`)
    out.push(this.hasId ? `${prefix}"id" AS "__ci"` : `NULL::text AS "__ci"`)
    return out
  }

  /* -------------------------------------------------------------- statements */

  build(plan: QueryPlan, o: V2Options): V2Statement {
    if (plan.aggregate) return this.aggregate(plan, o)
    return this.rows(plan, o)
  }

  outColumns(plan: QueryPlan, o: V2Options): ColumnDef[] {
    const names = plan.select ? [...plan.select] : [...o.visible]
    if (this.hasId && !names.includes('id')) names.push('id')
    return [...new Set(names)].map((n) => this.cols.get(n))
  }

  rows(plan: QueryPlan, o: V2Options): V2Statement {
    const t = tableId(this.d, this.def)
    const sort = plan.sort ?? []
    const W = this.where(plan, o.rowFilter)
    const out = this.outColumns(plan, o)
    const columns: V2OutColumn[] = out.map((c) => ({ name: c.name, type: c.type }))
    const page = plan.page
    // count only: no rows at all
    if (page && page.size === 0) {
      const inner = plan.take ? `(SELECT 1 FROM ${t} WHERE ${W} LIMIT ${plan.take.n}) AS x` : `${t} WHERE ${W}`
      const sql = `SELECT count(*)::bigint AS "__count" FROM ${inner}`
      return { sql, params: this.p.list, kind: 'count', columns, withCount: true, cursorKeys: 0 }
    }
    // the stream: base table, or the taken subset (keys are exposed as aliases __k<i>, __n, __i)
    let from: string
    let ref: (i: number) => string
    let nat: string[]
    let colRef: (c: ColumnDef) => string
    if (plan.take) {
      const keys = sort.map((k, i) => `${this.key(this.cols.get(k.col))} AS "__k${i}"`)
      const natSel = this.natural().map((n, i) => `${n} AS "${i === 0 && this.hasCreatedOn ? '__n' : '__i'}"`)
      const needed = new Set([...out.map((c) => c.name), ...(this.hasCreatedOn ? ['createdOn'] : []), ...(this.hasId ? ['id'] : [])])
      const sel = [...[...needed].map((n) => quoteId(this.cols.get(n).name)), ...keys, ...natSel].join(', ')
      const order = this.orderTerms(sort, plan.take.from === 'end').join(', ')
      from = `(SELECT ${sel} FROM ${t} WHERE ${W} ORDER BY ${order} LIMIT ${plan.take.n}) AS s`
      ref = (i) => `s."__k${i}"`
      nat = this.natural().map((_, i) => (i === 0 && this.hasCreatedOn ? 's."__n"' : 's."__i"'))
      colRef = (c) => `s.${quoteId(c.name)}`
    } else {
      from = `${t}`
      ref = (i) => this.key(this.cols.get(sort[i]!.col))
      nat = this.natural()
      colRef = (c) => quoteId(c.name)
    }
    const conds: string[] = plan.take ? [] : [W]
    if (page?.cursor) {
      let cur: DecodedCursor
      try {
        cur = decodeCursor(plan, page.cursor)
      } catch (e) {
        if (e instanceof CursorError) bad(`The page cursor is not valid for this query (${e.message}); start from the first page`)
        throw e
      }
      conds.push(this.seek(sort, cur!, ref, nat))
    }
    const order = this.orderTerms(sort, false, ref, nat).join(', ')
    let limit: number
    let pageSize: number | undefined
    let unpagedLimit: number | undefined
    if (page) { pageSize = page.size; limit = page.size + 1 } else if (plan.single) limit = 1
    else { unpagedLimit = o.maxUnpagedRows; limit = o.maxUnpagedRows + 1 }
    const prefix = plan.take ? 's.' : ''
    const cursorCols = page ? this.cursorColumns(sort, ref, prefix) : []
    const select = ['1 AS "__row"', ...out.map((c) => `${colRef(c)} AS ${quoteId(c.name)}`), ...cursorCols].join(', ')
    let sql = `SELECT ${select} FROM ${from}${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ${limit}`
    const withCount = !!plan.count
    if (withCount && !plan.take && !page?.cursor && scanOnly(plan)) {
      // the filter needs a full scan anyway (search, contains, calculations): count in the same pass
      sql = `SELECT ${select}, count(*) OVER () AS "__count" FROM ${from} WHERE ${conds.join(' AND ')} ORDER BY ${order} LIMIT ${limit}`
    } else if (withCount) {
      const countFrom = plan.take ? `(SELECT 1 FROM ${t} WHERE ${W} LIMIT ${plan.take.n}) AS x` : `${t} WHERE ${W}`
      sql = `SELECT c."__count", p.* FROM (SELECT count(*)::bigint AS "__count" FROM ${countFrom}) AS c LEFT JOIN LATERAL (${sql}) AS p ON TRUE`
    }
    return { sql, params: this.p.list, kind: 'rows', columns, pageSize, unpagedLimit, withCount, cursorKeys: page ? sort.length : 0 }
  }

  measureSql(m: MeasureV2, ref: (c: ColumnDef) => string): string {
    if (m.fn === 'count') return m.filter ? `(count(*) FILTER (WHERE ${this.cond(m.filter)}))::int` : 'count(*)::int'
    if (m.fn === 'countDistinct') {
      const c = this.cols.get(m.col!)
      return `(count(DISTINCT ${kindOf(c.type) === 'text' ? fold(this.d, ref(c)) : ref(c)}))::int`
    }
    const v = m.expr !== undefined ? this.expr(m.expr) : ref(this.cols.get(m.col!))
    switch (m.fn) {
      case 'sum': return `(COALESCE(sum(${v}), 0))::double precision`
      case 'avg': return `(avg(${v}))::double precision`
      case 'min': return `(COALESCE(min(${v}), 0))::double precision`
      default: return `(COALESCE(max(${v}), 0))::double precision`
    }
  }

  /**
   * P2-C date bucket of a date / datetime column (docs/dev/query-v2.md 6b): the bucket's first calendar day as a SQL
   * date, or the weekday (1 Monday .. 7 Sunday) / hour as an int. Datetime columns take their calendar date in the
   * bucket's time zone. Every number is validated (checkPlan) before it is written into the statement.
   */
  bucketSql(b: BucketV2, ref?: string): string {
    const col = this.cols.get(b.col)
    const q = ref ?? quoteId(col.name)
    const local = kindOf(col.type) === 'datetime' ? `(${q} AT TIME ZONE ${this.p.add(b.timeZone ?? 'UTC', 'text')})` : null
    const d = local ? `(${local})::date` : `${q}`
    const fy = Math.trunc(b.fiscalYearStart ?? 4)
    if (!Number.isInteger(fy) || fy < 1 || fy > 12) bad('fiscalYearStart is a month, 1 to 12')
    const shift = `make_interval(months => ${fy - 1})`
    switch (b.unit) {
      case 'day': return d
      case 'week': return b.weekStart === 7 ? `(${d} - extract(dow FROM ${d})::int)` : `(${d} - (extract(isodow FROM ${d})::int - 1))`
      case 'month': return `(date_trunc('month', ${d}))::date`
      case 'quarter': return `(date_trunc('quarter', ${d}))::date`
      case 'year': return `(date_trunc('year', ${d}))::date`
      case 'fiscalYear': return `(date_trunc('year', ${d} - ${shift}) + ${shift})::date`
      case 'fiscalQuarter': return `(date_trunc('quarter', ${d} - ${shift}) + ${shift})::date`
      case 'weekday': return `(extract(isodow FROM ${d}))::int`
      case 'hour': return local ? `(extract(hour FROM ${local}))::int` : bad('Hour buckets need a date and time column')
    }
  }

  /** a pseudo column for a bucket output (sort keys and value conversion) */
  bucketCol(b: BucketV2): ColumnDef {
    return { name: b.name, displayName: b.name, type: bucketKind(b.unit) === 'date' ? 'date' : 'number' }
  }

  /**
   * P2-C groupOrder 'key': ONE pass `GROUP BY` the group keys (text folded, buckets computed) with the measures; text
   * group values are min(col COLLATE "C") (the smallest spelling); the order is aggregate.sort, then every group key
   * ascending (normalised, a NULL group first among ties). No first-row lookup, so no join back to the rows. `top`
   * keeps the first n groups; `top.others` adds one row with the measures over every other row (NOT EXISTS against the
   * kept keys, NULL-safe), only when there is such a row.
   */
  aggregateByKey(plan: QueryPlan, o: V2Options, W: string): V2Statement {
    const a = plan.aggregate!
    const t = tableId(this.d, this.def)
    const sort = plan.sort ?? []
    const qc = (c: ColumnDef) => quoteId(c.name)
    // the rows the measures run over: the table (no alias: row filters' correlated semi-joins name it), or the taken subset
    const srcFrom = plan.take ? `(SELECT * FROM ${t} WHERE ${W} ORDER BY ${this.orderTerms(sort, plan.take.from === 'end').join(', ')} LIMIT ${plan.take.n}) AS s` : `${t}`
    const srcWhere = plan.take ? 'TRUE' : W
    interface G { out: string; key: string; value: string; col: ColumnDef; text: boolean }
    const groups: G[] = []
    for (const g of a.groupBy) {
      const c = this.cols.get(g)
      const text = kindOf(c.type) === 'text'
      groups.push({ out: a.as?.[c.name] ?? c.name, key: text ? fold(this.d, qc(c)) : qc(c), value: text ? `min(${qc(c)} COLLATE "C")` : '', col: c, text })
    }
    for (const b of a.buckets ?? []) groups.push({ out: b.name, key: this.bucketSql(b), value: '', col: this.bucketCol(b), text: false })
    const measures = a.measures.map((m, i) => `${this.measureSql(m, qc)} AS "__m${i}"`)
    const inner = [
      ...groups.map((g, i) => `${g.key} AS "__g${i}"`),
      ...groups.flatMap((g, i) => (g.text ? [`${g.value} AS "__v${i}"`] : [])),
      ...(measures.length ? measures : [groups.length ? '1 AS "__one"' : 'count(*) AS "__one"']),
    ]
    const gsql = `SELECT ${inner.join(', ')} FROM ${srcFrom} WHERE ${srcWhere}${groups.length ? ` GROUP BY ${groups.map((_, i) => i + 1).join(', ')}` : ''}`
    const columns: V2OutColumn[] = []
    const outSel: string[] = []
    groups.forEach((g, i) => {
      outSel.push(`${g.text ? `"__v${i}"` : `"__g${i}"`} AS ${quoteId(g.out)}`)
      columns.push({ name: g.out, type: g.col.type })
    })
    a.measures.forEach((m, i) => {
      outSel.push(`"__m${i}" AS ${quoteId(m.name)}`)
      columns.push({ name: m.name, type: m.fn === 'count' || m.fn === 'countDistinct' ? 'number' : 'decimal' })
    })
    const outKey = (name: string): string => {
      const gi = groups.findIndex((g) => g.out === name)
      if (gi >= 0) return this.key(groups[gi]!.col, groups[gi]!.text ? `"__v${gi}"` : `"__g${gi}"`)
      return `COALESCE("__m${a.measures.findIndex((m) => m.name === name)}", 0)`
    }
    const order = [
      ...(a.sort ?? []).map((k) => `${outKey(k.col)} ${k.dir === 'asc' ? 'ASC' : 'DESC'}`),
      ...groups.flatMap((g, i) => [`${this.key(g.col, g.text ? `"__v${i}"` : `"__g${i}"`)} ASC`, `("__g${i}" IS NOT NULL) ASC`]),
    ]
    const orderSql = order.length ? ` ORDER BY ${order.join(', ')}` : ''
    const limit = a.top ? Math.min(a.top.n, o.maxGroups + 1) : o.maxGroups + 1
    if (!a.top || a.top.others === undefined) {
      const sql = `WITH "__g" AS (${gsql}) SELECT ${outSel.join(', ')} FROM "__g"${orderSql} LIMIT ${limit}`
      return { sql, params: this.p.list, kind: 'aggregate', columns: this.selectOut(plan, columns), withCount: false, cursorKeys: 0, unpagedLimit: o.maxGroups }
    }
    // top n + others: the kept groups in order, then one row over every other input row
    const g0 = groups[0]!
    const label = this.p.add(a.top.others, 'text')
    const keyOnRow = g0.key
    const othersMeasures = a.measures.map((m) => this.measureSql(m, qc))
    const othersSel = [`${label} AS ${quoteId(g0.out)}`, ...othersMeasures.map((x, i) => `${x} AS ${quoteId(a.measures[i]!.name)}`), '1 AS "__o"', '0::bigint AS "__r"']
    const keptSel = [...outSel, '0 AS "__o"', `row_number() OVER (${orderSql.trim()}) AS "__r"`]
    const sql = `WITH "__g" AS (${gsql}), "__k" AS (SELECT * FROM "__g"${orderSql} LIMIT ${limit})
      SELECT ${[quoteId(g0.out), ...a.measures.map((m) => quoteId(m.name))].join(', ')} FROM (
        SELECT ${keptSel.join(', ')} FROM "__k"
        UNION ALL
        SELECT ${othersSel.join(', ')} FROM ${srcFrom} WHERE ${srcWhere} AND NOT EXISTS (SELECT 1 FROM "__k" WHERE "__k"."__g0" IS NOT DISTINCT FROM ${keyOnRow}) HAVING count(*) > 0
      ) AS "__x" ORDER BY "__o", "__r"`
    return { sql, params: this.p.list, kind: 'aggregate', columns: this.selectOut(plan, columns), withCount: false, cursorKeys: 0, unpagedLimit: o.maxGroups + 1 }
  }

  aggregate(plan: QueryPlan, o: V2Options): V2Statement {
    const a = plan.aggregate!
    const t = tableId(this.d, this.def)
    const sort = plan.sort ?? []
    const W = this.where(plan, o.rowFilter)
    const qc = (c: ColumnDef) => quoteId(c.name)
    // the rows the measures run over: the table, or the taken subset
    let src = `${t} WHERE ${W}`
    if (plan.take) src = `(SELECT * FROM ${t} WHERE ${W} ORDER BY ${this.orderTerms(sort, plan.take.from === 'end').join(', ')} LIMIT ${plan.take.n}) AS s`
    const columns: V2OutColumn[] = []
    if (a.groupOrder === 'key') return this.aggregateByKey(plan, o, W)
    const buckets = a.buckets ?? []
    if (a.groupBy.length && !buckets.length && !plan.take && !sort.length && this.hasCreatedOn && this.hasId) return this.aggregateNatural(plan, o, W, columns)
    const measures = a.measures.map((m) => `${this.measureSql(m, qc)} AS ${quoteId(m.name)}`)
    if (!a.groupBy.length && !buckets.length) {
      for (const m of a.measures) columns.push({ name: m.name, type: m.fn === 'count' || m.fn === 'countDistinct' ? 'number' : 'decimal' })
      const sql = `SELECT ${measures.length ? measures.join(', ') : '1 AS "__one"'} FROM ${src}`
      return { sql, params: this.p.list, kind: 'aggregate', columns: this.selectOut(plan, columns), withCount: false, cursorKeys: 0 }
    }
    // number the stream (filter -> sort -> take) so each group knows its first row: output value and group order
    const order = this.orderTerms(sort, false).join(', ')
    const groupCols = a.groupBy.map((g) => this.cols.get(g))
    const need = new Set<string>(a.groupBy)
    const rnOrder = plan.take ? this.orderTerms(sort, false, (i) => this.key(this.cols.get(sort[i]!.col), `s.${qc(this.cols.get(sort[i]!.col))}`), this.natural('s.')).join(', ') : order
    const numbered = plan.take
      ? `SELECT s.*, row_number() OVER (ORDER BY ${rnOrder}) AS "__rn" FROM ${src}`
      : `SELECT *, row_number() OVER (ORDER BY ${order}) AS "__rn" FROM ${t} WHERE ${W}`
    void need
    const gkeys = groupCols.map((c, i) => `${kindOf(c.type) === 'text' ? fold(this.d, qc(c)) : qc(c)} AS "__g${i}"`)
    buckets.forEach((b, i) => gkeys.push(`${this.bucketSql(b)} AS "__b${i}"`))
    const gsql = `SELECT ${[...gkeys, 'min("__rn") AS "__first"', ...measures].join(', ')} FROM s GROUP BY ${gkeys.map((_, i) => i + 1).join(', ')}`
    const outSel: string[] = []
    groupCols.forEach((c) => {
      const name = a.as?.[c.name] ?? c.name
      outSel.push(`f.${qc(c)} AS ${quoteId(name)}`)
      columns.push({ name, type: c.type })
    })
    buckets.forEach((b, i) => {
      outSel.push(`g."__b${i}" AS ${quoteId(b.name)}`)
      columns.push({ name: b.name, type: this.bucketCol(b).type })
    })
    for (const m of a.measures) {
      outSel.push(`g.${quoteId(m.name)}`)
      columns.push({ name: m.name, type: m.fn === 'count' || m.fn === 'countDistinct' ? 'number' : 'decimal' })
    }
    const outKind = (name: string): string => {
      const gi = groupCols.findIndex((c) => (a.as?.[c.name] ?? c.name) === name)
      if (gi >= 0) return this.key(groupCols[gi]!, `f.${qc(groupCols[gi]!)}`)
      const bi = buckets.findIndex((b) => b.name === name)
      if (bi >= 0) return this.key(this.bucketCol(buckets[bi]!), `g."__b${bi}"`)
      return `COALESCE(g.${quoteId(name)}, 0)`
    }
    const aggOrder = [...(a.sort ?? []).map((k) => `${outKind(k.col)} ${k.dir === 'asc' ? 'ASC' : 'DESC'}`), 'g."__first" ASC'].join(', ')
    const sql = `WITH s AS (${numbered}), g AS (${gsql}) SELECT ${outSel.join(', ')} FROM g JOIN s AS f ON f."__rn" = g."__first" ORDER BY ${aggOrder} LIMIT ${o.maxGroups + 1}`
    return { sql, params: this.p.list, kind: 'aggregate', columns: this.selectOut(plan, columns), withCount: false, cursorKeys: 0, unpagedLimit: o.maxGroups }
  }

  /**
   * Groups over the table in natural order (no sort, no take), without numbering every row: one pass groups and finds
   * each group's first createdOn; a hash join back finds the rows with that createdOn, of which the lowest id is the
   * group's first row (its original-case values and the group order).
   */
  aggregateNatural(plan: QueryPlan, o: V2Options, W: string, columns: V2OutColumn[]): V2Statement {
    const a = plan.aggregate!
    const t = tableId(this.d, this.def)
    const qc = (c: ColumnDef) => quoteId(c.name)
    const groupCols = a.groupBy.map((g) => this.cols.get(g))
    // no alias for the table: a row filter's correlated semi-joins (the core data model's "regarding" rule) name the
    // outer row by the table's qualified name, which an alias would hide (PostgreSQL 42P01)
    const x = `${t}.`
    const [N, I] = this.natural(x)
    const zero = (c: ColumnDef): string => {
      switch (kindOf(c.type)) {
        case 'text': return "''"
        case 'num': return '0'
        case 'bool': return 'FALSE'
        case 'date': return "'-infinity'::date"
        case 'datetime': return "'-infinity'::timestamptz"
      }
    }
    const gkey = (c: ColumnDef, ref: string) => (kindOf(c.type) === 'text' ? fold(this.d, ref) : ref)
    const gsel = groupCols.map((c, i) => `${gkey(c, `${x}${qc(c)}`)} AS "__g${i}"`)
    const msel = a.measures.map((m, i) => `${this.measureSql(m, (c) => `${x}${qc(c)}`)} AS "__m${i}"`)
    const g = `SELECT ${[...gsel, `min(${N}) AS "__fn"`, ...msel].join(', ')} FROM ${t} WHERE ${W} GROUP BY ${groupCols.map((_, i) => i + 1).join(', ')}`
    const join = groupCols.map((c, i) => `(${x}${qc(c)} IS NULL) = (g."__g${i}" IS NULL) AND COALESCE(${gkey(c, `${x}${qc(c)}`)}, ${zero(c)}) = COALESCE(g."__g${i}", ${zero(c)})`)
    const f = `SELECT DISTINCT ON (${groupCols.map((_, i) => `g."__g${i}"`).join(', ')}) g.*, ${groupCols.map((c, i) => `${x}${qc(c)} AS "__v${i}"`).join(', ')}, ${I} AS "__fid"
      FROM g JOIN ${t} ON ${join.join(' AND ')} AND ${N} = g."__fn" WHERE ${W}
      ORDER BY ${groupCols.map((_, i) => `g."__g${i}"`).join(', ')}, ${I}`
    const outSel: string[] = []
    groupCols.forEach((c, i) => {
      const name = a.as?.[c.name] ?? c.name
      outSel.push(`f."__v${i}" AS ${quoteId(name)}`)
      columns.push({ name, type: c.type })
    })
    a.measures.forEach((m, i) => {
      outSel.push(`f."__m${i}" AS ${quoteId(m.name)}`)
      columns.push({ name: m.name, type: m.fn === 'count' || m.fn === 'countDistinct' ? 'number' : 'decimal' })
    })
    const outKind = (name: string): string => {
      const gi = groupCols.findIndex((c) => (a.as?.[c.name] ?? c.name) === name)
      if (gi >= 0) return this.key(groupCols[gi]!, `f."__v${gi}"`)
      return `COALESCE(f."__m${a.measures.findIndex((m) => m.name === name)}", 0)`
    }
    const order = [...(a.sort ?? []).map((k) => `${outKind(k.col)} ${k.dir === 'asc' ? 'ASC' : 'DESC'}`), 'f."__fn" ASC', 'f."__fid" ASC'].join(', ')
    const sql = `WITH g AS (${g}), f AS (${f}) SELECT ${outSel.join(', ')} FROM f ORDER BY ${order} LIMIT ${o.maxGroups + 1}`
    return { sql, params: this.p.list, kind: 'aggregate', columns: this.selectOut(plan, columns), withCount: false, cursorKeys: 0, unpagedLimit: o.maxGroups }
  }

  selectOut(plan: QueryPlan, cols: V2OutColumn[]): V2OutColumn[] {
    if (!plan.select) return cols
    return cols.filter((c) => plan.select!.includes(c.name))
  }
}

/** a LIKE pattern matching `v` literally */
const likeEscape = (v: string): string => v.replace(/[\\%_]/g, (m) => '\\' + m)

/** the plan's filter can't use an index (substring tests, calculations, case-sensitive text): it scans every row */
function scanOnly(plan: QueryPlan): boolean {
  if (plan.search && plan.search.text !== '') return true
  const visit = (c: ConditionV2): boolean => {
    if ('const' in c) return false
    if ('and' in c) return c.and.some(visit)
    if ('or' in c) return c.or.some(visit)
    if ('not' in c) return visit(c.not)
    if ('via' in c) return false
    return c.op === 'contains' || c.op === 'endsWith' || c.op === 'cmpExpr' || ('exact' in c && c.exact === true)
  }
  return !!plan.filter && visit(plan.filter)
}

/** build the statement for a validated plan */
export function buildV2(d: Dialect, def: TableDef, plan: QueryPlan, o: V2Options): V2Statement {
  const b = new V2Builder(d, def)
  b.related = o.related ?? {}
  return b.build(plan, o)
}

