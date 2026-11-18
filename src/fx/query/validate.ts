/**
 * Structural validation of a Query v2 plan against a table schema (P0 package D). Shared by the server (every
 * POST /api/v1/query body goes through it before any SQL is built) and the reference executor's callers. Throws
 * PlanError with a message a maker can read; the server answers 422.
 *
 * It also collects every column the plan reads (filter, search, sort, grouping, measures, select), which is what
 * column-level security checks: a hidden column may not be selected, filtered, sorted, searched, grouped or aggregated.
 */
import type {
  AggregateV2, ColumnKind, CompareOpV2, ConditionV2, MeasureV2, NumExprV2, QueryLiteral, QueryPlan, SortKeyV2, TableSchemaInfo,
} from '../../platform/query.ts'
import { PlanError } from './reference.ts'

const MAX_NODES = 2000
const MAX_DEPTH = 32
const MAX_IN = 1000
const MAX_SORT = 20
const MAX_GROUP = 10
const MAX_MEASURES = 50
const MAX_SEARCH_COLUMNS = 50
const MAX_TEXT = 4000
const CMP = new Set<CompareOpV2>(['eq', 'ne', 'lt', 'le', 'gt', 'ge'])
const MEASURE = new Set(['sum', 'avg', 'min', 'max', 'count'])
const EXPR2 = new Set(['add', 'sub', 'mul', 'div'])
const EXPR1 = new Set(['neg', 'abs'])
const ROUND = new Set(['round', 'roundUp', 'roundDown'])
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const bad = (msg: string): never => { throw new PlanError(msg) }

export interface CheckedPlan {
  plan: QueryPlan
  /** columns of the table the plan reads (for column-level security) */
  columns: Set<string>
}

class Checker {
  nodes = 0
  readonly cols = new Set<string>()
  readonly schema: TableSchemaInfo
  readonly table: string
  constructor(schema: TableSchemaInfo, table: string) {
    this.schema = schema
    this.table = table
  }

  kind(col: unknown, what: string): ColumnKind {
    if (typeof col !== 'string' || !col) bad(`${what}: a column name is required`)
    const k = Object.prototype.hasOwnProperty.call(this.schema.columns, col as string) ? this.schema.columns[col as string] : undefined
    if (k === undefined) bad(`Column "${String(col).slice(0, 64)}" does not exist in "${this.table}"`)
    this.cols.add(col as string)
    return k!
  }

  literal(kind: ColumnKind, v: unknown, col: string): QueryLiteral {
    switch (kind) {
      case 'text': if (typeof v === 'string' && v.length <= MAX_TEXT) return v; break
      case 'number': if (typeof v === 'number' && Number.isFinite(v)) return v; break
      case 'boolean': if (typeof v === 'boolean') return v; break
      case 'date':
        if (isObj(v) && typeof v.$date === 'string' && DATE_RE.test(v.$date) && !Number.isNaN(Date.parse(v.$date + 'T00:00:00Z'))) return { $date: v.$date }
        break
      case 'datetime':
        if (isObj(v) && typeof v.$datetime === 'string' && v.$datetime.length <= 40 && !Number.isNaN(Date.parse(v.$datetime))) return { $datetime: v.$datetime }
        break
      default: break
    }
    return bad(`The value compared with ${col} does not fit a ${kind} column`)
  }

  expr(e: unknown, depth: number): NumExprV2 {
    if (++this.nodes > MAX_NODES || depth > MAX_DEPTH) bad('The query is too large')
    if (typeof e === 'number') {
      if (!Number.isFinite(e)) bad('Numbers in a calculation must be finite')
      return e
    }
    if (!isObj(e)) return bad('Malformed calculation')
    if ('col' in e) {
      const k = this.kind(e.col, 'calculation')
      if (k !== 'number' && k !== 'boolean') bad(`Calculations need number columns; ${String(e.col)} isn't one`)
      return { col: e.col as string }
    }
    const fn = e.fn
    const args = e.args
    if (typeof fn !== 'string' || !Array.isArray(args)) return bad('Malformed calculation')
    if (EXPR2.has(fn)) {
      if (args.length !== 2) bad(`${fn} takes two operands`)
      return { fn: fn as 'add', args: [this.expr(args[0], depth + 1), this.expr(args[1], depth + 1)] }
    }
    if (args.length !== 1) bad(`${fn} takes one operand`)
    if (EXPR1.has(fn)) return { fn: fn as 'neg', args: [this.expr(args[0], depth + 1)] }
    if (ROUND.has(fn)) {
      const d = e.digits
      if (typeof d !== 'number' || !Number.isInteger(d) || Math.abs(d) > 100) bad('digits must be a whole number between -100 and 100')
      return { fn: fn as 'round', args: [this.expr(args[0], depth + 1)], digits: d as number }
    }
    return bad(`Unknown calculation "${fn.slice(0, 20)}"`)
  }

  cond(c: unknown, depth: number): ConditionV2 {
    if (++this.nodes > MAX_NODES || depth > MAX_DEPTH) bad('The condition is too large')
    if (!isObj(c)) return bad('A condition must be an object')
    if ('const' in c) {
      if (typeof c.const !== 'boolean') bad('const must be true or false')
      return { const: c.const as boolean }
    }
    if ('and' in c || 'or' in c) {
      const list = c.and ?? c.or
      if (!Array.isArray(list)) bad('and / or take a list of conditions')
      const items = (list as unknown[]).map((x) => this.cond(x, depth + 1))
      return 'and' in c ? { and: items } : { or: items }
    }
    if ('not' in c) return { not: this.cond(c.not, depth + 1) }
    const op = c.op
    if (op === 'cmpExpr') {
      if (typeof c.cmp !== 'string' || !CMP.has(c.cmp as CompareOpV2)) bad('cmpExpr needs cmp: eq, ne, lt, le, gt or ge')
      return { op: 'cmpExpr', cmp: c.cmp as CompareOpV2, left: this.expr(c.left, depth + 1), right: this.expr(c.right, depth + 1) }
    }
    const col = c.col as string
    const kind = this.kind(col, 'condition')
    const exact = c.exact === true ? { exact: true as const } : {}
    if (c.exact !== undefined && c.exact !== true) bad('exact must be true when present')
    if (op === 'isNull') return { col, op: 'isNull' }
    if (kind === 'other') bad(`${col} can't be used in a condition`)
    if (c.exact === true && kind !== 'text') bad('exact applies to text columns only')
    if (typeof op === 'string' && CMP.has(op as CompareOpV2)) {
      if (kind === 'boolean' && op !== 'eq' && op !== 'ne') bad(`${col} is true/false: only eq and ne compare it`)
      return { col, op: op as CompareOpV2, value: this.literal(kind, c.value, col), ...exact }
    }
    switch (op) {
      case 'in': {
        if (!Array.isArray(c.value) || c.value.length > MAX_IN) bad(`in takes a list of at most ${MAX_IN} values`)
        return { col, op: 'in', value: (c.value as unknown[]).map((v) => this.literal(kind, v, col)), ...exact }
      }
      case 'contains': case 'startsWith': case 'endsWith':
        if (kind !== 'text') bad(`${op} needs a text column; ${col} isn't one`)
        if (typeof c.value !== 'string' || c.value.length > MAX_TEXT) bad(`${op} needs a text value`)
        return { col, op, value: c.value as string, ...exact }
      case 'cmpCol': {
        const other = c.other as string
        const ok = this.kind(other, 'cmpCol')
        if (ok !== kind) bad(`${col} and ${String(other)} are different kinds of column`)
        if (typeof c.cmp !== 'string' || !CMP.has(c.cmp as CompareOpV2)) bad('cmpCol needs cmp: eq, ne, lt, le, gt or ge')
        if ((kind === 'text' || kind === 'boolean') && c.cmp !== 'eq' && c.cmp !== 'ne') bad(`${kind} columns compare with eq / ne only`)
        return { col, op: 'cmpCol', cmp: c.cmp as CompareOpV2, other, ...exact }
      }
      default:
        return bad(`Unknown operator "${String(op).slice(0, 20)}"`)
    }
  }

  sortKeys(v: unknown, kinds: (col: string) => ColumnKind | undefined, what: string): SortKeyV2[] {
    if (!Array.isArray(v) || v.length > MAX_SORT) return bad(`${what} takes a list of at most ${MAX_SORT} keys`)
    return v.map((k) => {
      if (!isObj(k) || typeof k.col !== 'string' || (k.dir !== 'asc' && k.dir !== 'desc')) bad(`${what}: each key is { col, dir: "asc" | "desc" }`)
      const kind = kinds(k.col as string)
      if (kind === undefined) bad(`Column "${String(k.col).slice(0, 64)}" does not exist in "${this.table}"`)
      if (kind === 'other') bad(`Sorting by ${String(k.col)} isn't possible`)
      return { col: k.col as string, dir: k.dir as 'asc' | 'desc' }
    })
  }

  aggregate(a: unknown): { agg: AggregateV2; out: Map<string, ColumnKind> } {
    if (!isObj(a)) return bad('aggregate must be an object')
    if (!Array.isArray(a.groupBy) || a.groupBy.length > MAX_GROUP) bad(`aggregate.groupBy takes at most ${MAX_GROUP} columns`)
    if (!Array.isArray(a.measures) || a.measures.length > MAX_MEASURES) bad(`aggregate.measures takes at most ${MAX_MEASURES} measures`)
    const out = new Map<string, ColumnKind>()
    const as: Record<string, string> = {}
    if (a.as !== undefined) {
      if (!isObj(a.as)) bad('aggregate.as must map group columns to names')
      for (const [k, v] of Object.entries(a.as as Record<string, unknown>)) {
        if (typeof v !== 'string' || !v || v.length > 64) bad('aggregate.as names must be text')
        as[k] = v as string
      }
    }
    const groupBy = (a.groupBy as unknown[]).map((g) => {
      const kind = this.kind(g, 'groupBy')
      if (kind === 'other') bad(`Can't group by ${String(g)}`)
      const name = as[g as string] ?? (g as string)
      if (out.has(name)) bad(`Duplicate output column ${name}`)
      out.set(name, kind)
      return g as string
    })
    for (const k of Object.keys(as)) if (!groupBy.includes(k)) bad(`aggregate.as names ${k}, which is not grouped`)
    const measures: MeasureV2[] = (a.measures as unknown[]).map((m) => {
      if (!isObj(m) || typeof m.name !== 'string' || !m.name || m.name.length > 64) return bad('Each measure needs a name')
      if (typeof m.fn !== 'string' || !MEASURE.has(m.fn)) bad(`Unknown measure function "${String(m.fn).slice(0, 20)}"`)
      if (out.has(m.name)) bad(`Duplicate output column ${m.name}`)
      out.set(m.name, 'number')
      const r: MeasureV2 = { name: m.name, fn: m.fn as MeasureV2['fn'] }
      if (m.fn === 'count') {
        if (m.col !== undefined || m.expr !== undefined) bad('count takes no column')
      } else if (m.expr !== undefined) {
        if (m.col !== undefined) bad('A measure takes a column or a calculation, not both')
        r.expr = this.expr(m.expr, 1)
      } else {
        const kind = this.kind(m.col, m.fn as string)
        if (kind !== 'number') bad(`${String(m.fn)} needs a number column; ${String(m.col)} isn't one`)
        r.col = m.col as string
      }
      if (m.filter !== undefined) {
        if (m.fn !== 'count') bad('Only count measures take a filter')
        r.filter = this.cond(m.filter, 1)
      }
      return r
    })
    const agg: AggregateV2 = { groupBy, measures }
    if (Object.keys(as).length) agg.as = as
    if (a.sort !== undefined) agg.sort = this.sortKeys(a.sort, (c) => out.get(c), 'aggregate.sort')
    return { agg, out }
  }
}

/** largest page size (QUERY_MAX_PAGE_SIZE of src/platform/query.ts; src/fx imports only types from outside) */
const MAX_PAGE_SIZE = 500

/** validate `input` as a plan over `schema` (the caller's visible columns); throws PlanError */
export function checkPlan(input: unknown, schema: TableSchemaInfo, tableName: string, opts: { maxPageSize?: number } = {}): CheckedPlan {
  const maxPage = opts.maxPageSize ?? MAX_PAGE_SIZE
  if (!isObj(input)) bad('The plan must be an object')
  const p = input as Record<string, unknown>
  if (p.version !== 2) bad('Only version 2 plans are supported')
  if (typeof p.table !== 'string' || !p.table) bad('The plan needs a table')
  const ch = new Checker(schema, tableName)
  const plan: QueryPlan = { version: 2, table: p.table as string }
  if (p.filter !== undefined) plan.filter = ch.cond(p.filter, 0)
  if (p.search !== undefined) {
    const s = p.search
    if (!isObj(s) || typeof s.text !== 'string' || s.text.length > MAX_TEXT || !Array.isArray(s.columns) || s.columns.length > MAX_SEARCH_COLUMNS) {
      bad('search is { text, columns: [text columns] }')
    }
    const cols = ((s as { columns: unknown[] }).columns).map((c) => {
      const k = ch.kind(c, 'search')
      if (k !== 'text') bad(`Search looks in text columns; ${String(c)} isn't one`)
      return c as string
    })
    plan.search = { text: (s as { text: string }).text, columns: cols }
  }
  if (p.sort !== undefined) plan.sort = ch.sortKeys(p.sort, (c) => (Object.prototype.hasOwnProperty.call(schema.columns, c) ? (ch.cols.add(c), schema.columns[c]) : undefined), 'sort')
  if (p.take !== undefined) {
    const t = p.take
    if (!isObj(t) || typeof t.n !== 'number' || !Number.isInteger(t.n) || t.n < 0 || t.n > 1e9 || (t.from !== 'start' && t.from !== 'end')) bad('take is { n: whole number >= 0, from: "start" | "end" }')
    plan.take = { n: (t as { n: number }).n, from: (t as { from: 'start' | 'end' }).from }
  }
  let out: Map<string, ColumnKind> | null = null
  if (p.aggregate !== undefined) {
    const r = ch.aggregate(p.aggregate)
    plan.aggregate = r.agg
    out = r.out
  }
  if (p.select !== undefined) {
    if (!Array.isArray(p.select) || p.select.length > 500 || !p.select.every((x) => typeof x === 'string')) bad('select is a list of column names')
    const sel = p.select as string[]
    for (const c of sel) {
      if (out) { if (!out.has(c)) bad(`The grouped result has no column ${c.slice(0, 64)}`) } else ch.kind(c, 'select')
    }
    plan.select = [...sel]
  }
  for (const f of ['count', 'single'] as const) {
    if (p[f] === undefined) continue
    if (typeof p[f] !== 'boolean') bad(`${f} must be true or false`)
    if (p[f]) plan[f] = true
  }
  if (p.page !== undefined) {
    const pg = p.page as Record<string, unknown>
    if (!isObj(pg) || typeof pg.size !== 'number' || !Number.isInteger(pg.size) || pg.size < 0) bad('page is { size, cursor? }')
    if ((pg as { size: number }).size > maxPage) bad(`A page holds at most ${maxPage} rows`)
    if (pg.cursor !== undefined && (typeof pg.cursor !== 'string' || pg.cursor.length > 8192)) bad('page.cursor must be text')
    if (plan.aggregate) bad('Grouped results are not paged')
    plan.page = { size: (pg as { size: number }).size }
    if (typeof pg.cursor === 'string' && pg.cursor) plan.page.cursor = pg.cursor
  }
  return { plan, columns: ch.cols }
}

/** kinds of the output columns of an aggregate plan (group columns under their output names, measures are numbers) */
export function aggregateOutputKinds(a: AggregateV2, schema: TableSchemaInfo): Map<string, ColumnKind> {
  const out = new Map<string, ColumnKind>()
  for (const g of a.groupBy) out.set(a.as?.[g] ?? g, schema.columns[g] ?? 'other')
  for (const m of a.measures) out.set(m.name, 'number')
  return out
}
