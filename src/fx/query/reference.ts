/**
 * Reference executor for Query v2 plans: the executable form of docs/dev/query-v2.md. It runs a plan over rows held in
 * memory (formula values: Date objects for date and datetime cells) and is deliberately written from the spec, not
 * from the formula engine, so the parity test compares two independent implementations. The PostgreSQL translator
 * (package D) must give the same rows, in the same order, for every plan.
 */
import type { FxRecord, FxValue } from '../../contracts.ts'
import type { AggregateV2, ColumnKind, CompareOpV2, ConditionV2, MeasureV2, NumExprV2, QueryLiteral, QueryPlan, SortKeyV2, TableSchemaInfo } from '../../platform/query.ts'
import { bucketOutputKind as bucketKind, bucketValue } from './buckets.ts'
import { roundHalfAway } from '../functions/format.ts'
import { decodeCursor, encodeCursor, sortKeyValue, compareKeys, type KeyValue } from './cursor.ts'

export interface ReferenceResult {
  rows: FxRecord[]
  count?: number
  nextCursor?: string | null
}

export class PlanError extends Error {}

export interface ExecuteOptions {
  /**
   * the rows arrive in the source's natural order (data files and Google Sheets keep file / sheet order): use it instead
   * of (createdOn, id); cursors then seek by the position of their row id
   */
  inputOrder?: boolean
  /** lookup paths (`via`): the rows of the tables they read (only those the caller may read) */
  related?: RelatedRows
}

/** a well-formed plan whose evaluation fails, as the engine's formula would (division by zero, overflow) */
export class QueryEvaluationError extends PlanError {}

/* ------------------------------------------------------------------ numeric expressions */

/** RoundUp / RoundDown of the engine: on the shortest decimal form of the number */
function shiftRound(x: number, d: number, f: (n: number) => number): number {
  const s = String(Math.abs(x))
  if (s.includes('e')) {
    const m = Math.pow(10, d)
    return f(x * m) / m
  }
  const sign = x < 0 ? -1 : 1
  return sign * Number(f(Number(s + 'e' + d)) + 'e' + -d)
}

const finite = (x: number): number => {
  if (!Number.isFinite(x)) throw new QueryEvaluationError("That result isn't a valid number")
  return x
}

/** value of a numeric expression for one row (NULL cells read as 0) */
export function evaluateNumExpr(e: NumExprV2, row: FxRecord, schema: TableSchemaInfo): number {
  if (typeof e === 'number') {
    if (!Number.isFinite(e)) throw new PlanError('expression literals must be finite numbers')
    return e
  }
  if (typeof e !== 'object' || e === null) throw new PlanError('malformed expression')
  if ('col' in e) {
    const k = kindOf(schema, e.col)
    const v = cell(row, e.col)
    if (k === 'number') return isNullCell(v) ? 0 : (v as number)
    if (k === 'boolean') return v === true ? 1 : 0
    throw new PlanError(`expressions need number columns; ${e.col} isn't one`)
  }
  const a = e.args
  if (!Array.isArray(a)) throw new PlanError('malformed expression')
  switch (e.fn) {
    case 'add': return finite(evaluateNumExpr(a[0], row, schema) + evaluateNumExpr(a[1]!, row, schema))
    case 'sub': return finite(evaluateNumExpr(a[0], row, schema) - evaluateNumExpr(a[1]!, row, schema))
    case 'mul': return finite(evaluateNumExpr(a[0], row, schema) * evaluateNumExpr(a[1]!, row, schema))
    case 'div': {
      const x = evaluateNumExpr(a[0], row, schema)
      const y = evaluateNumExpr(a[1]!, row, schema)
      if (y === 0) throw new QueryEvaluationError("Can't divide by zero")
      return finite(x / y)
    }
    case 'neg': return 0 - evaluateNumExpr(a[0], row, schema)
    case 'abs': return Math.abs(evaluateNumExpr(a[0], row, schema))
    case 'round': case 'roundUp': case 'roundDown': {
      const d = (e as { digits: number }).digits
      if (!Number.isInteger(d)) throw new PlanError('digits must be a whole number')
      const x = evaluateNumExpr(a[0], row, schema)
      if (e.fn === 'round') return finite(roundHalfAway(x, d))
      return finite(shiftRound(x, d, e.fn === 'roundUp' ? (n) => (n < 0 ? Math.floor(n) : Math.ceil(n)) : Math.trunc))
    }
    default: throw new PlanError(`unknown expression function ${String((e as { fn?: unknown }).fn)}`)
  }
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
const day = (d: Date): string => `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function cell(row: FxRecord, col: string): FxValue {
  return Object.prototype.hasOwnProperty.call(row, col) ? row[col]! : null
}

/** a non-NULL cell and a literal -> comparable JS values, or a PlanError when the literal doesn't fit the kind */
function operands(kind: ColumnKind, v: FxValue, lit: QueryLiteral, exact: boolean): [string | number | boolean, string | number | boolean] {
  switch (kind) {
    case 'text':
      if (typeof v !== 'string' || typeof lit !== 'string') throw new PlanError('text column needs a text literal')
      return exact ? [v, lit] : [v.toLowerCase(), lit.toLowerCase()]
    case 'number':
      if (typeof v !== 'number' || typeof lit !== 'number') throw new PlanError('number column needs a number literal')
      return [v, lit]
    case 'boolean':
      if (typeof v !== 'boolean' || typeof lit !== 'boolean') throw new PlanError('boolean column needs a boolean literal')
      return [v, lit]
    case 'date':
      if (!(v instanceof Date) || typeof lit !== 'object' || !('$date' in lit)) throw new PlanError('date column needs a $date literal')
      return [day(v), lit.$date]
    case 'datetime': {
      if (!(v instanceof Date) || typeof lit !== 'object' || !('$datetime' in lit)) throw new PlanError('datetime column needs a $datetime literal')
      const t = Date.parse(lit.$datetime)
      if (Number.isNaN(t)) throw new PlanError('bad $datetime literal')
      return [v.getTime(), t]
    }
    default:
      throw new PlanError('column kind can not be compared')
  }
}

function cmp(op: CompareOpV2, a: string | number | boolean, b: string | number | boolean, kind: ColumnKind): boolean {
  if (kind === 'boolean' && op !== 'eq' && op !== 'ne') throw new PlanError('booleans only support eq / ne')
  switch (op) {
    case 'eq': return a === b
    case 'ne': return a !== b
    case 'lt': return a < b
    case 'le': return a <= b
    case 'gt': return a > b
    case 'ge': return a >= b
  }
}

function kindOf(schema: TableSchemaInfo, col: string): ColumnKind {
  const k = schema.columns[col]
  if (k === undefined) throw new PlanError(`unknown column ${col}`)
  return k
}

const isNullCell = (v: FxValue): boolean => v === null || v === undefined

/** rows and schema of the tables lookup paths (`via`) read: only rows the caller may read */
export interface RelatedRows {
  rows(table: string): FxRecord[] | undefined
  schema(table: string): TableSchemaInfo | undefined
}

export function evaluateConditionV2(c: ConditionV2, row: FxRecord, schema: TableSchemaInfo, related?: RelatedRows): boolean {
  if ('const' in c) return c.const
  if ('and' in c) return c.and.every((x) => evaluateConditionV2(x, row, schema, related))
  if ('or' in c) return c.or.some((x) => evaluateConditionV2(x, row, schema, related))
  if ('not' in c) return !evaluateConditionV2(c.not, row, schema, related)
  if ('via' in c) {
    const v = cell(row, c.via.col)
    const ts = related?.schema(c.via.table)
    const trows = related?.rows(c.via.table)
    if (!ts || !trows) throw new PlanError(`the lookup table ${c.via.table} is not available`)
    const id = v === null || v === undefined ? '' : String(v).toLowerCase()
    const target = id ? trows.find((r) => String(r.__id ?? r.id ?? '').toLowerCase() === id) : undefined
    return target ? evaluateConditionV2(c.via.where, target, ts, related) : !!c.via.orMissing
  }
  if (c.op === 'cmpExpr') return cmp(c.cmp, evaluateNumExpr(c.left, row, schema), evaluateNumExpr(c.right, row, schema), 'number')
  const kind = kindOf(schema, c.col)
  const v = cell(row, c.col)
  switch (c.op) {
    case 'isNull': return isNullCell(v)
    case 'eq': case 'ne': case 'lt': case 'le': case 'gt': case 'ge': {
      if (isNullCell(v)) return false
      const [a, b] = operands(kind, v, c.value, !!c.exact)
      return cmp(c.op, a, b, kind)
    }
    case 'in': {
      if (isNullCell(v)) return false
      return c.value.some((lit) => { const [a, b] = operands(kind, v, lit, !!c.exact); return a === b })
    }
    case 'contains': case 'startsWith': case 'endsWith': {
      if (kind !== 'text') throw new PlanError(`${c.op} needs a text column`)
      if (isNullCell(v)) return false
      if (typeof v !== 'string') throw new PlanError('text cell expected')
      const h = c.exact ? v : v.toLowerCase()
      const n = c.exact ? c.value : c.value.toLowerCase()
      return c.op === 'contains' ? h.includes(n) : c.op === 'startsWith' ? h.startsWith(n) : h.endsWith(n)
    }
    case 'cmpCol': {
      const other = cell(row, c.other)
      if (kindOf(schema, c.other) !== kind) throw new PlanError('cmpCol needs two columns of the same kind')
      if (isNullCell(v) || isNullCell(other)) return false
      if (kind === 'text' && c.cmp !== 'eq' && c.cmp !== 'ne') throw new PlanError('text columns compare with eq / ne only')
      const lit: QueryLiteral = kind === 'date' ? { $date: day(other as Date) } : kind === 'datetime' ? { $datetime: (other as Date).toISOString() } : (other as string | number | boolean)
      const [a, b] = operands(kind, v, lit, !!c.exact)
      return cmp(c.cmp, a, b, kind)
    }
  }
}

/* ------------------------------------------------------------------ ordering */

/** natural order: createdOn asc, id asc (rows without createdOn: id only) */
export function naturalCompare(a: FxRecord, b: FxRecord): number {
  const ca = cell(a, 'createdOn')
  const cb = cell(b, 'createdOn')
  const ta = ca instanceof Date ? ca.getTime() : -Infinity
  const tb = cb instanceof Date ? cb.getTime() : -Infinity
  if (ta !== tb) return ta < tb ? -1 : 1
  const ia = String(cell(a, 'id') ?? '')
  const ib = String(cell(b, 'id') ?? '')
  return ia < ib ? -1 : ia > ib ? 1 : 0
}

function keysOf(row: FxRecord, keys: SortKeyV2[], kinds: (col: string) => ColumnKind): KeyValue[] {
  return keys.map((k) => sortKeyValue(kinds(k.col), cell(row, k.col)))
}

/* ------------------------------------------------------------------ aggregate */

function groupKey(kind: ColumnKind, v: FxValue): string {
  if (isNullCell(v)) return 'null'
  switch (kind) {
    case 'text': return 's:' + (v as string).toLowerCase()
    case 'number': return 'n:' + (v as number)
    case 'boolean': return 'b:' + (v as boolean)
    default: return 'd:' + (v as Date).getTime()
  }
}

/** one group key of an aggregate: a column, or a date bucket over a column (P2-C) */
interface GroupSpec { out: string; kind: ColumnKind; value(r: FxRecord): FxValue }

function groupSpecs(a: AggregateV2, schema: TableSchemaInfo): GroupSpec[] {
  const out: GroupSpec[] = a.groupBy.map((c) => ({ out: a.as?.[c] ?? c, kind: kindOf(schema, c), value: (r: FxRecord) => cell(r, c) }))
  for (const b of a.buckets ?? []) {
    const k = kindOf(schema, b.col)
    if (k !== 'date' && k !== 'datetime') throw new PlanError(`${b.col} is not a date column`)
    if (b.unit === 'hour' && k !== 'datetime') throw new PlanError('hour buckets need a date and time column')
    out.push({ out: b.name, kind: bucketKind(b.unit), value: (r: FxRecord) => bucketValue(cell(r, b.col), k, b) })
  }
  return out
}

function measureValue(m: MeasureV2, items: FxRecord[], schema: TableSchemaInfo): FxValue {
  if (m.fn === 'count') return m.filter ? items.filter((r) => evaluateConditionV2(m.filter!, r, schema)).length : items.length
  if (m.fn === 'countDistinct') {
    if (m.col === undefined) throw new PlanError('countDistinct needs a column')
    const k = kindOf(schema, m.col)
    if (k === 'other') throw new PlanError(`${m.col} can't be counted`)
    const seen = new Set<string>()
    for (const r of items) {
      const v = cell(r, m.col)
      if (!isNullCell(v)) seen.add(groupKey(k, v))
    }
    return seen.size
  }
  let nums: number[]
  if (m.expr !== undefined) {
    if (m.col !== undefined) throw new PlanError('a measure has a column or an expression, not both')
    nums = items.map((r) => evaluateNumExpr(m.expr!, r, schema))
  } else {
    if (m.col === undefined || kindOf(schema, m.col) !== 'number') throw new PlanError(`${m.fn} needs a number column`)
    nums = items.map((r) => cell(r, m.col!)).filter((v): v is number => typeof v === 'number')
  }
  switch (m.fn) {
    case 'sum': return nums.reduce((x, y) => x + y, 0)
    case 'avg': return nums.length ? nums.reduce((x, y) => x + y, 0) / nums.length : null
    case 'min': return nums.length ? Math.min(...nums) : 0
    default: return nums.length ? Math.max(...nums) : 0
  }
}

function aggregate(rows: FxRecord[], a: AggregateV2, schema: TableSchemaInfo): FxRecord[] {
  const specs = groupSpecs(a, schema)
  const byKey = a.groupOrder === 'key'
  const groups = new Map<string, { items: FxRecord[]; vals: FxValue[] }>()
  if (specs.length === 0) groups.set('', { items: rows, vals: [] })
  else {
    for (const r of rows) {
      const vals = specs.map((g) => g.value(r))
      const key = vals.map((v, i) => groupKey(specs[i]!.kind, v)).join('|')
      let g = groups.get(key)
      if (!g) { g = { items: [], vals }; groups.set(key, g) }
      else if (byKey) {
        // 'key' order: a text group's value is its smallest spelling (code point order)
        vals.forEach((v, i) => { if (specs[i]!.kind === 'text' && typeof v === 'string' && typeof g!.vals[i] === 'string' && v < (g!.vals[i] as string)) g!.vals[i] = v })
      }
      g.items.push(r)
    }
  }
  let list: { o: FxRecord; items: FxRecord[]; key: string }[] = []
  for (const [key, g] of groups) {
    const o: FxRecord = {}
    specs.forEach((sp, i) => { o[sp.out] = g.vals[i]! })
    for (const m of a.measures) o[m.name] = measureValue(m, g.items, schema)
    list.push({ o, items: g.items, key })
  }
  const outKind = (col: string): ColumnKind => {
    const g = specs.find((x) => x.out === col)
    if (g !== undefined) return g.kind
    if (a.measures.some((m) => m.name === col)) return 'number'
    throw new PlanError(`unknown aggregate column ${col}`)
  }
  const sortKeys: SortKeyV2[] = [...(a.sort ?? [])]
  if (sortKeys.length || byKey) {
    const dirs = sortKeys.map((s) => s.dir)
    const keyed = list.map((x, i) => ({ x, i, k: keysOf(x.o, sortKeys, outKind), g: byKey ? specs.map((sp) => sortKeyValue(sp.kind, x.o[sp.out] ?? null)) : [] }))
    keyed.sort((p, q) => {
      const d = compareKeys(p.k, q.k, dirs)
      if (d !== 0) return d
      if (byKey) {
        // then every group key ascending; a NULL group before the group whose normalised key it ties with ('' / 0 / false)
        for (let j = 0; j < specs.length; j++) {
          const e = compareKeys([p.g[j]!], [q.g[j]!], ['asc'])
          if (e !== 0) return e
          const pn = isNullCell(p.x.o[specs[j]!.out]) ? 0 : 1
          const qn = isNullCell(q.x.o[specs[j]!.out]) ? 0 : 1
          if (pn !== qn) return pn - qn
        }
      }
      return p.i - q.i
    })
    list = keyed.map((y) => y.x)
  }
  if (a.top) {
    const n = Math.max(0, Math.trunc(a.top.n))
    const kept = list.slice(0, n)
    const rest = list.slice(n)
    const out = kept.map((x) => x.o)
    if (a.top.others !== undefined && rest.length) {
      if (specs.length !== 1 || specs[0]!.kind !== 'text' || a.buckets?.length) throw new PlanError('top with others needs exactly one text group column')
      const items = rest.flatMap((x) => x.items)
      const o: FxRecord = { [specs[0]!.out]: a.top.others }
      for (const m of a.measures) o[m.name] = measureValue(m, items, schema)
      out.push(o)
    }
    return out
  }
  return list.map((x) => x.o)
}

/* ------------------------------------------------------------------ the plan */

/**
 * Execute a plan over all rows of its table (any order: the executor applies the natural order itself).
 * Throws PlanError for a malformed plan (wrong literal kind, unknown column ...).
 */
export function executePlan(plan: QueryPlan, allRows: FxRecord[], schema: TableSchemaInfo, opts: ExecuteOptions = {}): ReferenceResult {
  if (plan.version !== 2) throw new PlanError('not a v2 plan')
  // natural position of every row: (createdOn, id), or the input order for sources that keep file / sheet order
  const position = new Map<FxRecord, number>()
  const idPosition = new Map<string, number>()
  let rows: FxRecord[]
  if (opts.inputOrder) {
    rows = [...allRows]
    rows.forEach((r, i) => { position.set(r, i); idPosition.set(String(cell(r, 'id') ?? ''), i) })
  } else rows = [...allRows].sort(naturalCompare)
  if (plan.filter) rows = rows.filter((r) => evaluateConditionV2(plan.filter!, r, schema, opts.related))
  if (plan.search && plan.search.text !== '') {
    const needle = plan.search.text.toLowerCase()
    for (const c of plan.search.columns) if (kindOf(schema, c) !== 'text') throw new PlanError('search needs text columns')
    rows = rows.filter((r) => plan.search!.columns.some((c) => { const v = cell(r, c); return typeof v === 'string' && v.toLowerCase().includes(needle) }))
  }
  const sortKeys = plan.sort ?? []
  if (sortKeys.length) {
    const kinds = (col: string): ColumnKind => kindOf(schema, col)
    const dirs = sortKeys.map((k) => k.dir)
    const keyed = rows.map((r, i) => ({ r, i, k: keysOf(r, sortKeys, kinds) }))
    // ties keep natural order (the input is in natural order; i breaks ties ascending for every direction)
    keyed.sort((x, y) => compareKeys(x.k, y.k, dirs) || x.i - y.i)
    rows = keyed.map((x) => x.r)
  }
  if (plan.take) {
    const n = Math.max(0, Math.trunc(plan.take.n))
    rows = plan.take.from === 'start' ? rows.slice(0, n) : n === 0 ? [] : rows.slice(-n)
  }
  let out: FxRecord[]
  const agg = !!plan.aggregate
  if (plan.aggregate) out = aggregate(rows, plan.aggregate, schema)
  else out = rows
  if (plan.select) {
    const keep = plan.select
    out = out.map((r) => {
      const o: FxRecord = {}
      for (const k of keep) if (Object.prototype.hasOwnProperty.call(r, k)) o[k] = r[k]!
      if (!agg && Object.prototype.hasOwnProperty.call(r, '__id')) o.__id = r.__id!
      return o
    })
  }
  const result: ReferenceResult = { rows: out }
  if (plan.count) result.count = out.length
  if (plan.single) result.rows = out.slice(0, 1)
  if (plan.page) {
    if (agg) throw new PlanError('paging is only for row plans')
    let start = 0
    if (plan.page.cursor) {
      const cur = decodeCursor(plan, plan.page.cursor)
      const kinds = (col: string): ColumnKind => kindOf(schema, col)
      const dirs = [...sortKeys.map((k) => k.dir)]
      // keyset seek over the full order (sort keys, then createdOn asc, id asc); `rows` are the un-selected rows
      start = rows.findIndex((r) => {
        const d = compareKeys(keysOf(r, sortKeys, kinds), cur.keys, dirs)
        if (d !== 0) return d > 0
        if (opts.inputOrder) return (position.get(r) ?? -1) > (idPosition.get(cur.id) ?? -1)
        return naturalCompare(r, { createdOn: cur.createdOn === null ? null : new Date(cur.createdOn), id: cur.id }) > 0
      })
      if (start < 0) start = rows.length
    }
    const size = Math.max(0, Math.trunc(plan.page.size))
    result.rows = out.slice(start, start + size)
    const last = rows[start + size - 1]
    result.nextCursor = size > 0 && start + size < rows.length && last ? encodeCursor(plan, last, schema) : null
  }
  return result
}
