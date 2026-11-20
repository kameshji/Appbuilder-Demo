/**
 * Formula -> Query v2 translator (P0 package B). Pure: no I/O, no DOM.
 *
 * analyze() walks a parsed formula and finds every expression over a data-source table (a name listed in SchemaInfo).
 * Each maximal delegable expression becomes a QueryPlan; the rest of the formula is returned as a residual formula in
 * which every planned expression is replaced by a binding (__q0, __q1 ...). Evaluating the residual with the bindings
 * set to the plans' results gives exactly what the engine gives over all rows (checked by parity.test.ts).
 *
 * Delegation rule (decided, P0 spec): an expression over a table that cannot be translated is NOT evaluated on a partial
 * set of rows. It yields an error diagnostic (which sub-expression, why, a suggestion) unless the table is known to be
 * small (fully loaded and at most `clientRowLimit` rows): then it is a warning and the browser evaluates it.
 *
 * Values from outside the table (control properties, variables, User(), Today(), DateAdd(...)) are evaluated here with
 * the caller's scope and engine and embedded as literals.
 */
import type { FxEngine, FxScope, FxValue } from '../../contracts.ts'
import type { ColumnKind, CompareOpV2, ConditionV2, MeasureFn, MeasureV2, NumExprV2, QueryLiteral, QueryPlan, SchemaInfo, SortKeyV2, TableSchemaInfo } from '../../platform/query.ts'
import { freeIdentifiers, type CallNode, type IdNode, type Node } from '../ast.ts'
import { createEngine } from '../engine.ts'
import { FxError } from '../errors.ts'
import { parse } from '../parser.ts'
import { printNode } from '../print.ts'
import { expandMacros, hasSystemMacro } from '../functions/collab.ts'
import { evaluateConditionV2 } from './reference.ts'
import { describe as describeValue, hasOwn, isRecord, toBool, toNumber, toText } from '../values.ts'
import {
  and, compareColumnLiteral, compareColumns, inList, isNull, not, numericOfText, or, Refusal, textMatch, withNull, type CmpOp, type DiagCode,
} from './conditions.ts'

/* ------------------------------------------------------------------ public types */

export interface AnalyzeOptions {
  /** resolves names from outside the table (controls, variables, collections, 'User()' ...); default: none */
  scope?: FxScope
  /** engine used to evaluate outside values (its user-defined functions and named formulas apply); default: a fresh one */
  engine?: FxEngine
  /**
   * Largest row count the browser may hold and process itself: bounds FirstN/LastN results that client-side code may
   * consume, and the size under which a fully loaded table may be evaluated in the browser. Default 2000.
   */
  clientRowLimit?: number
}

export interface QueryDiagnostic {
  severity: 'error' | 'warning'
  code: DiagCode
  message: string
  /** span of the sub-expression in the formula source */
  start: number
  end: number
  /** the sub-expression's text */
  text: string
  suggestion?: string
  /** the data-source table concerned */
  table?: string
}

/**
 * What a plan's result is bound to in the residual formula:
 *  rows   -> the table of result rows;  record -> the first row or blank (plan.single);
 *  count  -> the number in response.count;  scalar -> the measure `measure` of the single aggregate row.
 */
export type ResultShape = 'rows' | 'record' | 'count' | 'scalar'

export interface PlannedQuery {
  /** binding name in the residual formula: __q0, __q1 ... */
  id: string
  plan: QueryPlan
  shape: ResultShape
  measure?: string
  /** span and text of the formula expression the plan replaces */
  start: number
  end: number
  text: string
  /** result size is known to be at most clientRowLimit rows (take, single, count, scalar) */
  bounded: boolean
}

export interface AnalyzeResult {
  /** the first (outermost-first, left to right) plan, or null */
  plan: QueryPlan | null
  plans: PlannedQuery[]
  /**
   * Client-side remainder, or null when the formula IS the first plan. `formula` starts with '=' and refers to the
   * plans by their ids; evaluate it with a scope that answers each id (see bindResult) before the caller's scope.
   */
  residual: { formula: string; bindings: string[] } | null
  diagnostics: QueryDiagnostic[]
  /** every expression over a data-source table was translated; no error and no client-evaluated table */
  fullyDelegated: boolean
  /** some table expression is left to the browser because the table is small (warnings carry code client-evaluated) */
  clientEvaluated: boolean
}

/* ------------------------------------------------------------------ internal model */

interface AggState {
  groupBy: string[]
  measures: MeasureV2[]
  sort?: SortKeyV2[]
  as?: Record<string, string>
  /** GroupBy's group-rows column, until a DropColumns / ShowColumns removes it */
  pendingGroup?: string
  /** kinds of the aggregate's output columns */
  out: Map<string, ColumnKind>
}

interface Stream {
  table: string
  schema: TableSchemaInfo
  /** row fields visible at this point of the pipeline (name -> kind) */
  cols: Map<string, ColumnKind>
  filters: ConditionV2[]
  search?: { text: string; columns: string[] }
  sort: SortKeyV2[]
  take?: { n: number; from: 'start' | 'end' }
  agg?: AggState
  select?: string[]
  shape: ResultShape
  measure?: string
  single?: boolean
  count?: boolean
}

/** a lowered expression: a residual AST node; `stream` marks an unbounded table of rows from a plan */
interface Expr { node: Node; unbounded: boolean }

type Lowered = { k: 'stream'; s: Stream; node: Node } | { k: 'expr'; e: Expr }

interface RowCtx { s: Stream; alias?: string }

const TABLE_OPS = new Set([
  'Filter', 'Search', 'Sort', 'SortByColumns', 'First', 'Last', 'FirstN', 'LastN', 'LookUp', 'CountRows', 'CountIf',
  'Sum', 'Average', 'Min', 'Max', 'Distinct', 'GroupBy', 'AddColumns', 'DropColumns', 'ShowColumns', 'IsEmpty',
])
/** functions whose later arguments run once per row of the first argument */
const ROW_SCOPED = new Set([
  'Filter', 'Search', 'LookUp', 'Sort', 'Distinct', 'AddColumns', 'CountIf', 'ForAll', 'Sum', 'Average', 'Min', 'Max',
  'Count', 'CountA', 'StdevP', 'VarP', 'Concat', 'UpdateIf', 'RemoveIf',
])
/** first argument names a table to write to (or reset), it is not a read */
// DeletedRows(Table) (recycle bin) names the table too: its rows come from the server's Deleted view, not from Table
const WRITE_TARGET = new Set(['Patch', 'Collect', 'ClearCollect', 'Remove', 'Defaults', 'Refresh', 'Clear', 'DeletedRows'])
/** functions that would process every row of their table in the browser */
const BULK_WRITE = new Set(['UpdateIf', 'RemoveIf'])
/** functions that pass an unbounded table through unchanged (or row by row) */
const PASS_THROUGH = new Set(['AddColumns', 'DropColumns', 'ShowColumns', 'RenameColumns'])

const ORDINAL_FIRST = 0
/** functions a server-side calculation may use */
const ARITH_FNS = new Set(['Abs', 'Round', 'RoundUp', 'RoundDown'])
const FLIP_CMP: Record<CmpOp, CmpOp> = { '=': '=', '<>': '<>', '<': '>', '>': '<', '<=': '>=', '>=': '<=' }
const CMP_V2: Record<CmpOp, CompareOpV2> = { '=': 'eq', '<>': 'ne', '<': 'lt', '>': 'gt', '<=': 'le', '>=': 'ge' }
const MEASURE_FNS: Record<string, MeasureFn> = { Sum: 'sum', Average: 'avg', Min: 'min', Max: 'max' }

/* ------------------------------------------------------------------ analyzer */

class Analyzer {
  readonly source: string
  readonly schema: SchemaInfo
  readonly scope: FxScope
  readonly engine: FxEngine
  readonly limit: number
  plans: PlannedQuery[] = []
  diagnostics: QueryDiagnostic[] = []
  clientEvaluated = false
  /** depth of client-side row scopes (ForAll over a collection ...) around the current node */
  rowScopes = 0

  constructor(source: string, schema: SchemaInfo, opts: AnalyzeOptions) {
    this.source = source
    this.schema = schema
    this.scope = opts.scope ?? { resolve: () => undefined }
    this.engine = opts.engine ?? createEngine()
    this.limit = opts.clientRowLimit ?? 2000
  }

  text(n: { start: number; end: number }): string { return this.source.slice(n.start, n.end) }

  tableOf(name: string): TableSchemaInfo | undefined {
    return hasOwn(this.schema.tables, name) ? this.schema.tables[name] : undefined
  }

  isSmall(table: string): boolean {
    const t = this.tableOf(table)
    return !!t?.fullyLoaded && typeof t.rowCount === 'number' && t.rowCount <= this.limit
  }

  /** base table of a (possibly nested) table expression, for diagnostics */
  baseTable(n: Node): string | undefined {
    let cur: Node = n
    for (;;) {
      if (cur.t === 'as') cur = cur.expr
      else if (cur.t === 'id') return this.tableOf(cur.name) ? cur.name : undefined
      else if (cur.t === 'call' && cur.args.length > 0) cur = cur.args[ORDINAL_FIRST]!
      else if (cur.t === 'member') cur = cur.obj
      else return undefined
    }
  }

  /* -------------------------------------------------------------- generic lowering */

  lower(n: Node): Lowered {
    const done = this.pending.get(n)
    if (done) { this.pending.delete(n); return { k: 'expr', e: done } }
    if (n.t === 'id' && this.tableOf(n.name)) {
      if (this.rowScopes > 0) return this.refuseAt(n, n.name, new Refusal('per-row-query', `${n.name} is read once per row of an enclosing formula, which can't run on the server`, n, 'Read the table once outside the per-row formula, or filter the table directly'))
      return { k: 'stream', s: this.base(n.name), node: n }
    }
    if (n.t === 'call' && TABLE_OPS.has(n.name) && n.args.length > 0) {
      const src = this.lowerSource(n.args[0]!)
      if (src.k === 'stream') {
        try {
          return this.applyOp(n, src.s, src.alias)
        } catch (e) {
          return this.refuseAt(n, src.s.table, asRefusal(e, n))
        }
      }
    }
    if (n.t === 'member') {
      const o = this.lower(n.obj)
      if (o.k === 'stream') {
        const s = o.s
        if (s.shape !== 'count' && s.shape !== 'scalar' && !s.agg && s.cols.has(n.name) && !s.select) {
          s.select = [n.name]
          s.cols = new Map([[n.name, s.cols.get(n.name)!]])
        }
        const q = this.materialize(s, o.node)
        return { k: 'expr', e: { node: { ...n, obj: q.node }, unbounded: q.unbounded } }
      }
      return { k: 'expr', e: { node: { ...n, obj: o.e.node }, unbounded: o.e.unbounded } }
    }
    return { k: 'expr', e: this.lowerGeneric(n) }
  }

  /** argument 0 of a table op: a stream (with its As alias) or anything else */
  lowerSource(a: Node): { k: 'stream'; s: Stream; alias?: string } | { k: 'other' } {
    const inner = a.t === 'as' ? a.expr : a
    if (!(inner.t === 'id' && this.tableOf(inner.name)) && !(inner.t === 'call' && TABLE_OPS.has(inner.name))) return { k: 'other' }
    if (inner.t === 'call' && this.baseTable(inner) === undefined) return { k: 'other' }
    const l = this.lower(inner)
    const keep = (e: Expr): { k: 'other' } => {
      this.pending.set(a, a.t === 'as' ? { node: { ...a, expr: e.node }, unbounded: e.unbounded } : e)
      return { k: 'other' }
    }
    if (l.k !== 'stream') return keep(l.e)
    // a record / number cannot be the table of another op: the generic path finishes it in the browser
    if (l.s.shape !== 'rows') return keep(this.materialize(l.s, l.node))
    return { k: 'stream', s: l.s, alias: a.t === 'as' ? a.name : undefined }
  }

  /** already-lowered argument nodes (lowerSource lowered them while probing) */
  pending = new Map<Node, Expr>()

  lowerGeneric(n: Node): Expr {
    switch (n.t) {
      case 'num': case 'str': case 'bool': case 'id':
        return { node: n, unbounded: false }
      case 'call': return this.lowerCall(n)
      case 'member': {
        const l = this.lower(n)
        return l.k === 'expr' ? l.e : this.materialize(l.s, l.node)
      }
      case 'as': {
        const e = this.consume(n.expr, false)
        return { node: { ...n, expr: e.node }, unbounded: false }
      }
      case 'unary': case 'pct': return { node: { ...n, arg: this.consume(n.arg, false).node }, unbounded: false }
      case 'bin': return { node: { ...n, left: this.consume(n.left, false).node, right: this.consume(n.right, false).node }, unbounded: false }
      case 'chain': return { node: { ...n, items: n.items.map((x) => this.consume(x, false).node) }, unbounded: false }
      case 'rec': return { node: { ...n, fields: n.fields.map((f) => ({ ...f, value: this.consume(f.value, false).node })) }, unbounded: false }
      case 'tab': return { node: { ...n, items: n.items.map((x) => this.consume(x, false).node) }, unbounded: false }
      case 'interp': return { node: { ...n, parts: n.parts.map((p) => (typeof p === 'string' ? p : this.consume(p, false).node)) }, unbounded: false }
    }
  }

  lowerCall(n: CallNode): Expr {
    const args: Node[] = []
    let unbounded = false
    const rowScoped = ROW_SCOPED.has(n.name)
    for (let i = 0; i < n.args.length; i++) {
      const a = n.args[i]!
      if (i === 0 && (WRITE_TARGET.has(n.name) || BULK_WRITE.has(n.name)) && a.t === 'id' && this.tableOf(a.name)) {
        if (BULK_WRITE.has(n.name)) {
          const r = new Refusal('not-delegable-function', `${n.name} would change only the rows of ${a.name} loaded in the browser`, n,
            `Use ForAll over a filtered, bounded set, like ForAll(FirstN(Filter(${a.name}, ...), 500), Patch(...))`)
          this.report(r, a.name)
        }
        args.push(a)
        continue
      }
      const passArg = (PASS_THROUGH.has(n.name) && i === 0) || ((n.name === 'If' || n.name === 'Switch') && isBranchArg(n, i))
      if (i > 0 && rowScoped) this.rowScopes++
      try {
        const e = this.consume(a, passArg)
        if (passArg && e.unbounded) unbounded = true
        args.push(e.node)
      } finally {
        if (i > 0 && rowScoped) this.rowScopes--
      }
    }
    return { node: { ...n, args }, unbounded }
  }

  /** lower a child; a stream is materialized; an unbounded table is only allowed where `passThrough` */
  consume(n: Node, passThrough: boolean): Expr {
    const l = this.lower(n)
    const e = l.k === 'stream' ? this.materialize(l.s, l.node) : l.e
    if (e.unbounded && !passThrough) {
      const t = this.baseTable(n) ?? ''
      const r = new Refusal('unbounded-consumer', `This needs every row of ${t || 'the table'}, which can't be fetched to the browser`, n,
        'Do the work in the query (Filter, CountRows, Sum ...), or limit the rows with FirstN(..., n)')
      this.report(r, t || undefined)
      return { node: e.node, unbounded: false }
    }
    return e
  }

  /* -------------------------------------------------------------- streams */

  base(table: string): Stream {
    const schema = this.tableOf(table)!
    const cols = new Map<string, ColumnKind>()
    for (const [k, v] of Object.entries(schema.columns)) cols.set(k, v)
    return { table, schema, cols, filters: [], sort: [], shape: 'rows' }
  }

  bounded(s: Stream): boolean {
    if (s.shape !== 'rows') return true
    return !!s.take && s.take.n <= this.limit && !s.agg
  }

  /** turn a stream into a plan and a binding node */
  materialize(s: Stream, src: Node): Expr {
    if (s.agg?.pendingGroup && s.shape === 'rows') {
      throw new Refusal('group-rows', `The grouped rows (${s.agg.pendingGroup}) can't be fetched from the server`, src,
        `Add the totals you need with AddColumns and remove the group column with DropColumns(..., "${s.agg.pendingGroup}")`)
    }
    const id = `__q${this.plans.length}`
    const plan: QueryPlan = { version: 2, table: s.table }
    const filter = and(s.filters)
    if (!('const' in filter && filter.const)) plan.filter = filter
    if (s.search) plan.search = s.search
    let sort = s.sort
    if (s.agg && sort.some((k) => k.via)) {
      // a sort through a lookup is for lists of rows (P3-C): over the whole table with no groups the order changes nothing
      if (s.agg.groupBy.length || s.take) {
        throw new Refusal('not-delegable-function', "Sorting by a lookup's column before grouping or totals can't run on the server", src, 'Sort the grouped result instead')
      }
      sort = []
    }
    if (sort.filter((k) => k.via).length > 3) throw new Refusal('not-delegable-function', 'A list can be sorted through at most 3 lookup columns on the server', src)
    if (sort.length) plan.sort = sort
    if (s.take) plan.take = s.take
    if (s.agg) {
      plan.aggregate = { groupBy: s.agg.groupBy, measures: s.agg.measures }
      if (s.agg.sort?.length) plan.aggregate.sort = s.agg.sort
      if (s.agg.as) plan.aggregate.as = s.agg.as
    }
    if (s.select) plan.select = s.select
    if (s.count) plan.count = true
    if (s.single) plan.single = true
    const bounded = this.bounded(s)
    this.plans.push({ id, plan, shape: s.shape, measure: s.measure, start: src.start, end: src.end, text: this.text(src), bounded })
    const node: IdNode = { t: 'id', name: id, start: src.start, end: src.end }
    return { node, unbounded: !bounded }
  }

  refuseAt(n: Node, table: string, r: Refusal): Lowered {
    this.report(r, table)
    return { k: 'expr', e: { node: n, unbounded: false } }
  }

  report(r: Refusal, table: string | undefined): void {
    const small = table !== undefined && this.isSmall(table)
    if (small) this.clientEvaluated = true
    this.diagnostics.push({
      severity: small ? 'warning' : 'error',
      code: small ? 'client-evaluated' : r.code,
      message: small ? `${r.message}. ${table} is small and fully loaded, so this runs in the browser` : r.message,
      start: r.start,
      end: r.end,
      text: this.source.slice(r.start, r.end),
      suggestion: r.suggestion,
      table,
    })
  }

  /* -------------------------------------------------------------- folding outside values */

  /** does a node read the current row (a field, ThisRecord or the As alias)? */
  rowDependent(n: Node, rc: RowCtx): boolean {
    for (const id of freeIdentifiers(n)) {
      if (rc.s.cols.has(id.name) || id.name === 'ThisRecord' || (rc.alias !== undefined && id.name === rc.alias)) return true
    }
    return false
  }

  /** evaluate a row-independent node with the caller's scope */
  fold(n: Node): FxValue {
    for (const id of freeIdentifiers(n)) {
      if (!this.tableOf(id.name)) continue
      const r = new Refusal('nested-table', `This reads another table (${id.name}) inside the query, which can't run on the server yet`, n,
        `Read the value first, e.g. Set(value, LookUp(${id.name}, ...)) in OnVisible, and use the variable here`)
      if (!this.isSmall(id.name)) throw r
      this.report(r, id.name)
    }
    const r = this.engine.evaluate('=' + printNode(n), this.scope)
    if (!r.ok) throw new Refusal('evaluation-error', r.error.message, n)
    return r.value
  }

  foldText(n: Node): string {
    const v = this.fold(n)
    try {
      return toText(v, n)
    } catch {
      throw new Refusal('evaluation-error', `Can't use ${describeValue(v)} as text`, n)
    }
  }

  /* -------------------------------------------------------------- table ops */

  applyOp(n: CallNode, s: Stream, alias: string | undefined): Lowered {
    const rc: RowCtx = { s, alias }
    const out = (st: Stream): Lowered => ({ k: 'stream', s: st, node: n })
    const boundary = (why: string): Lowered => {
      // the op can't be appended to the plan: a bounded result may be finished in the browser
      if (this.bounded(s)) {
        const q = this.materialize(s, n.args[0]!.t === 'as' ? (n.args[0] as { expr: Node }).expr : n.args[0]!)
        const rest = this.withFirstArg(n, q.node)
        return { k: 'expr', e: rest }
      }
      throw new Refusal('not-delegable-function', why, n)
    }
    const plain = !s.take && !s.agg
    switch (n.name) {
      case 'Filter': {
        if (!plain) return boundary(`Filter after ${s.agg ? 'grouping' : 'FirstN/LastN'} can't run on the server`)
        for (let i = 1; i < n.args.length; i++) s.filters.push(this.cond(n.args[i]!, rc))
        return out(s)
      }
      case 'CountIf': {
        if (!plain) return boundary(`CountIf after ${s.agg ? 'grouping' : 'FirstN/LastN'} can't run on the server`)
        if (n.args.length !== 2) throw new Refusal('not-delegable-function', 'CountIf needs a table and a condition', n)
        s.filters.push(this.cond(n.args[1]!, rc))
        s.shape = 'count'
        s.count = true
        return out(s)
      }
      case 'Search': {
        if (!plain) return boundary(`Search after ${s.agg ? 'grouping' : 'FirstN/LastN'} can't run on the server`)
        if (n.args.length < 3) throw new Refusal('not-delegable-function', 'Search needs a table, a text and at least one column', n)
        const needle = this.foldText(n.args[1]!).toLowerCase()
        const cols: string[] = []
        for (let i = 2; i < n.args.length; i++) {
          const c = this.foldText(n.args[i]!)
          const kind = s.cols.get(c)
          if (kind === undefined) {
            // the engine reads a missing column as blank, which never matches: drop it
            continue
          }
          if (kind !== 'text') throw new Refusal('unsupported-column', `Search on the server only looks in text columns; ${c} isn't text`, n.args[i]!, `Leave ${c} out, or Filter on it`)
          cols.push(c)
        }
        if (needle === '') return out(s)
        if (cols.length === 0) { s.filters.push({ const: false }); return out(s) }
        const cond = or(cols.map((c) => textMatch(c, 'text', 'contains', needle, false, n)))
        if (!s.search) s.search = { text: needle, columns: cols }
        else s.filters.push(cond)
        return out(s)
      }
      case 'Sort': case 'SortByColumns': {
        if (s.take) return boundary(`${n.name} after FirstN/LastN can't run on the server`)
        const keys = n.name === 'Sort' ? [this.sortKey(n, rc)] : this.sortByColumnsKeys(n, s)
        const live = keys.filter((k): k is SortKeyV2 => k !== null)
        if (s.agg) {
          for (const k of live) {
            const kind = s.agg.out.get(k.col)
            if (kind === undefined || k.col === s.agg.pendingGroup) throw new Refusal('not-delegable-function', `Can't sort the groups by ${k.col}`, n)
            sortable(k.col, kind, n)
          }
          s.agg.sort = [...live, ...(s.agg.sort ?? [])]
        } else {
          s.sort = [...live, ...s.sort]
        }
        return out(s)
      }
      case 'FirstN': case 'LastN': {
        if (s.agg) return boundary(`${n.name} after grouping can't run on the server`)
        const from = n.name === 'FirstN' ? 'start' : 'end'
        const count = n.args.length > 1 ? Math.max(0, Math.trunc(this.foldNumber(n.args[1]!))) : 1
        if (s.take) {
          if (s.take.from !== from) return boundary(`${n.name} after ${from === 'start' ? 'LastN' : 'FirstN'} can't run on the server`)
          s.take = { n: Math.min(s.take.n, count), from }
        } else s.take = { n: count, from }
        return out(s)
      }
      case 'First': case 'Last': {
        if (n.args.length !== 1) throw new Refusal('not-delegable-function', `${n.name} takes one table`, n)
        if (s.agg) return boundary(`${n.name} after grouping can't run on the server`)
        const from = n.name === 'First' ? 'start' : 'end'
        if (s.take && s.take.from !== from && s.take.n > 0) return boundary(`${n.name} after ${from === 'start' ? 'LastN' : 'FirstN'} can't run on the server`)
        s.take = { n: Math.min(s.take?.n ?? 1, 1), from }
        s.single = true
        s.shape = 'record'
        return out(s)
      }
      case 'LookUp': {
        if (!plain) return boundary(`LookUp after ${s.agg ? 'grouping' : 'FirstN/LastN'} can't run on the server`)
        if (n.args.length < 2) throw new Refusal('not-delegable-function', 'LookUp needs a table and a condition', n)
        s.filters.push(this.cond(n.args[1]!, rc))
        s.take = { n: 1, from: 'start' }
        if (n.args.length === 2) {
          s.single = true
          s.shape = 'record'
          return out(s)
        }
        // the result formula runs in the browser over the 0..1 row: LookUp(__q As alias, true, result)
        const q = this.materialize(s, n)
        const first: Node = alias !== undefined ? { t: 'as', expr: q.node, name: alias, nameStart: 0, nameEnd: 0, start: 0, end: 0 } : q.node
        const resultArg = n.args[2]!
        this.rowScopes++
        let res: Expr
        try { res = this.consume(resultArg, false) } finally { this.rowScopes-- }
        return { k: 'expr', e: { node: { ...n, args: [first, { t: 'bool', value: true, start: 0, end: 0 }, res.node] }, unbounded: false } }
      }
      case 'IsEmpty': {
        if (n.args.length !== 1) throw new Refusal('not-delegable-function', 'IsEmpty takes one table', n)
        if (s.agg) {
          s.shape = 'count'
          s.count = true
          const q = this.materialize(s, n.args[0]!)
          return { k: 'expr', e: { node: { t: 'bin', op: '=', left: q.node, right: { t: 'num', value: 0, start: 0, end: 0 }, start: n.start, end: n.end }, unbounded: false } }
        }
        s.take = { n: Math.min(s.take?.n ?? 1, 1), from: s.take?.from ?? 'start' }
        const q = this.materialize(s, n.args[0]!)
        return { k: 'expr', e: { node: { ...n, args: [q.node] }, unbounded: false } }
      }
      case 'CountRows': {
        if (n.args.length !== 1) throw new Refusal('not-delegable-function', 'CountRows takes one table', n)
        s.shape = 'count'
        s.count = true
        return out(s)
      }
      case 'Sum': case 'Average': case 'Min': case 'Max': {
        if (s.agg) return boundary(`${n.name} over grouped rows can't run on the server`)
        if (n.args.length !== 2) throw new Refusal('not-delegable-function', `${n.name} on the server needs a table and a number column`, n, `${n.name}(table, Column)`)
        const col = this.columnRef(n.args[1]!, rc)
        let m: MeasureV2
        if (col === null) {
          // a calculation per row: Sum(Orders, Qty * Price)
          m = { name: 'Value', fn: MEASURE_FNS[n.name]!, expr: this.numExpr(n.args[1]!, rc) }
        } else {
          if (s.cols.get(col) !== 'number') throw new Refusal('unsupported-column', `${n.name} on the server needs a number column; ${col} isn't one`, n.args[1]!)
          m = { name: 'Value', fn: MEASURE_FNS[n.name]!, col }
        }
        s.agg = { groupBy: [], measures: [m], out: new Map([['Value', 'number']]) }
        s.shape = 'scalar'
        s.measure = 'Value'
        return out(s)
      }
      case 'Distinct': {
        if (s.agg) return boundary("Distinct over grouped rows can't run on the server")
        if (n.args.length !== 2) throw new Refusal('not-delegable-function', 'Distinct needs a table and a column', n)
        const col = this.columnRef(n.args[1]!, rc)
        if (col === null) throw new Refusal('not-delegable-expression', 'Distinct on the server works on a column, not a calculation', n.args[1]!)
        const kind = s.cols.get(col)!
        if (kind === 'other') throw new Refusal('unsupported-column', `Distinct can't group by ${col} on the server`, n.args[1]!)
        s.agg = { groupBy: [col], measures: [], as: col === 'Value' ? undefined : { [col]: 'Value' }, out: new Map([['Value', kind]]) }
        return out(s)
      }
      case 'GroupBy': {
        if (s.agg) return boundary("GroupBy over grouped rows can't run on the server")
        if (n.args.length < 3) throw new Refusal('not-delegable-function', 'GroupBy needs a table, columns and a group name', n)
        const cols: string[] = []
        for (let i = 1; i < n.args.length - 1; i++) {
          const c = this.foldText(n.args[i]!)
          const kind = s.cols.get(c)
          if (kind === undefined) throw new Refusal('unknown-column', `${s.table} has no column ${c} at this point`, n.args[i]!)
          if (kind === 'other') throw new Refusal('unsupported-column', `Can't group by ${c} on the server`, n.args[i]!)
          cols.push(c)
        }
        const g = this.foldText(n.args[n.args.length - 1]!)
        if (cols.includes(g)) throw new Refusal('evaluation-error', 'The group name must be different from the grouping columns', n)
        const outCols = new Map<string, ColumnKind>()
        for (const c of cols) outCols.set(c, s.cols.get(c)!)
        s.agg = { groupBy: cols, measures: [], pendingGroup: g, out: outCols }
        return out(s)
      }
      case 'AddColumns': {
        if (s.agg?.pendingGroup) return this.addMeasures(n, s)
        return { k: 'expr', e: this.clientMap(n, s) }
      }
      case 'ShowColumns': case 'DropColumns': {
        const names: string[] = []
        for (let i = 1; i < n.args.length; i++) names.push(this.foldText(n.args[i]!))
        if (s.agg) {
          const agg = s.agg
          const pending = agg.pendingGroup
          const show = n.name === 'ShowColumns'
          const kept = show ? names.filter((x) => agg.out.has(x)) : [...agg.out.keys()].filter((x) => !names.includes(x))
          if (pending !== undefined && (show ? !names.includes(pending) : names.includes(pending))) agg.pendingGroup = undefined
          const next = new Map<string, ColumnKind>()
          for (const k of kept) next.set(k, agg.out.get(k)!)
          agg.out = next
          s.select = kept
          return out(s)
        }
        const keep = n.name === 'ShowColumns' ? names.filter((x) => s.cols.has(x)) : [...s.cols.keys()].filter((x) => !names.includes(x))
        const next = new Map<string, ColumnKind>()
        for (const k of keep) next.set(k, s.cols.get(k)!)
        s.cols = next
        s.select = keep
        return out(s)
      }
    }
    throw new Refusal('not-delegable-function', `${n.name} can't run on the server`, n)
  }

  /** the call with its first argument replaced, remaining arguments lowered client-side over the bounded rows */
  withFirstArg(n: CallNode, first: Node): Expr {
    const a0 = n.args[0]!
    const head: Node = a0.t === 'as' ? { ...a0, expr: first } : first
    const args: Node[] = [head]
    this.rowScopes++
    try {
      for (let i = 1; i < n.args.length; i++) args.push(this.consume(n.args[i]!, false).node)
    } finally {
      this.rowScopes--
    }
    return { node: { ...n, args }, unbounded: false }
  }

  /** AddColumns over plain rows: the plan returns the rows, the browser adds the columns row by row */
  clientMap(n: CallNode, s: Stream): Expr {
    if (s.shape !== 'rows' || s.agg) throw new Refusal('not-delegable-function', "AddColumns here can't run on the server", n)
    const a0 = n.args[0]!
    const q = this.materialize(s, a0.t === 'as' ? a0.expr : a0)
    const r = this.withFirstArg(n, q.node)
    return { node: r.node, unbounded: q.unbounded }
  }

  addMeasures(n: CallNode, s: Stream): Lowered {
    const agg = s.agg!
    const g = agg.pendingGroup!
    if (n.args.length % 2 === 0) throw new Refusal('evaluation-error', 'AddColumns needs a name and a formula for each new column', n)
    for (let i = 1; i < n.args.length; i += 2) {
      const name = this.foldText(n.args[i]!)
      const e = n.args[i + 1]!
      const m = this.measure(e, g, s, name)
      agg.measures = agg.measures.filter((x) => x.name !== name)
      agg.measures.push(m)
      agg.out.set(name, 'number')
    }
    return { k: 'stream', s, node: n }
  }

  measure(e: Node, g: string, s: Stream, name: string): MeasureV2 {
    const why = new Refusal('group-rows', `Only Sum, Average, Min, Max, CountRows and CountIf over ${g} can be added to grouped rows on the server`, e,
      `Like AddColumns(GroupBy(...), "Total", Sum(${g}, Price))`)
    if (e.t !== 'call' || e.args.length === 0) throw why
    const a0 = e.args[0]!
    if (a0.t !== 'id' || a0.name !== g) throw why
    const rc: RowCtx = { s }
    if (e.name === 'CountRows' && e.args.length === 1) return { name, fn: 'count' }
    if (e.name === 'CountIf' && e.args.length === 2) return { name, fn: 'count', filter: this.cond(e.args[1]!, rc) }
    const fn = MEASURE_FNS[e.name]
    if (fn && e.args.length === 2) {
      const col = this.columnRef(e.args[1]!, rc)
      if (col === null) return { name, fn, expr: this.numExpr(e.args[1]!, rc) }
      if (s.cols.get(col) !== 'number') throw new Refusal('not-delegable-expression', `${e.name} over ${g} on the server needs a number column`, e.args[1]!)
      return { name, fn, col }
    }
    throw why
  }

  foldNumber(n: Node): number {
    const v = this.fold(n)
    try {
      return toNumber(v, n)
    } catch {
      throw new Refusal('evaluation-error', `Can't use ${describeValue(v)} as a number`, n)
    }
  }

  sortKey(n: CallNode, rc: RowCtx): SortKeyV2 | null {
    if (n.args.length < 2) throw new Refusal('not-delegable-function', 'Sort needs a table and a column', n)
    const a = n.args[1]!
    let col: string | null
    let kind: ColumnKind | undefined
    if (rc.s.agg) {
      col = a.t === 'id' && rc.s.agg.out.has(a.name) ? a.name : null
      if (col === null && !this.rowDependentAgg(a, rc.s)) return null
      if (col === null) throw new Refusal('not-delegable-expression', 'Sorting groups on the server works on an output column, not a calculation', a)
      kind = rc.s.agg.out.get(col)
    } else {
      // P3-C: Sort(Orders, Customer.Name): by a column of the row the lookup points at, read as the caller
      const lp = this.lookupPath(a, rc)
      if (lp) {
        sortable(`${lp.table}.${lp.field}`, lp.kind, a)
        const asc = n.args.length > 2 ? orderOf(this.foldText(n.args[2]!), n.args[2]!) : true
        return { col: lp.col, dir: asc ? 'asc' : 'desc', via: { table: lp.table, col: lp.field } }
      }
      col = this.columnRef(a, rc)
      if (col === null) {
        if (!this.rowDependent(a, rc)) { this.fold(a); return null }
        throw new Refusal('not-delegable-expression', 'Sorting on the server works on a column, not a calculation', a, 'Sort by a column, or use SortByColumns')
      }
      kind = rc.s.cols.get(col)
    }
    sortable(col, kind!, a)
    const asc = n.args.length > 2 ? orderOf(this.foldText(n.args[2]!), n.args[2]!) : true
    return { col, dir: asc ? 'asc' : 'desc' }
  }

  rowDependentAgg(a: Node, s: Stream): boolean {
    return freeIdentifiers(a).some((id) => s.agg!.out.has(id.name) || id.name === 'ThisRecord')
  }

  sortByColumnsKeys(n: CallNode, s: Stream): (SortKeyV2 | null)[] {
    const keys: (SortKeyV2 | null)[] = []
    const have = s.agg ? s.agg.out : s.cols
    let i = 1
    while (i < n.args.length) {
      const col = this.foldText(n.args[i]!)
      i++
      let asc = true
      if (i < n.args.length) {
        const v = this.fold(n.args[i]!)
        if (isOrderText(v)) { asc = orderOf(v as string, n.args[i]!); i++ }
      }
      const kind = have.get(col)
      if (kind === undefined) { keys.push(null); continue } // the engine reads a missing column as blank: no effect
      sortable(col, kind, n)
      keys.push({ col, dir: asc ? 'asc' : 'desc' })
    }
    return keys
  }

  /* -------------------------------------------------------------- conditions */

  /** a reference to a column of the current row: Name, ThisRecord.Name, alias.Name */
  columnRef(n: Node, rc: RowCtx): string | null {
    if (n.t === 'id') return rc.s.cols.has(n.name) ? n.name : null
    if (n.t === 'member' && n.obj.t === 'id') {
      const o = n.obj.name
      if (rc.s.cols.has(o)) return null
      if (o === 'ThisRecord' || (rc.alias !== undefined && o === rc.alias)) {
        if (rc.s.cols.has(n.name)) return n.name
        throw new Refusal('unknown-column', `${rc.s.table} has no column ${n.name} at this point`, n)
      }
    }
    return null
  }

  cond(n: Node, rc: RowCtx): ConditionV2 {
    if (!this.rowDependent(n, rc)) {
      const v = this.fold(n)
      try {
        return { const: toBool(v, n) }
      } catch {
        throw new Refusal('evaluation-error', `Can't use ${describeValue(v)} as true/false`, n)
      }
    }
    const col = this.columnRef(n, rc)
    if (col !== null) {
      const kind = rc.s.cols.get(col)!
      if (kind === 'boolean') return { col, op: 'eq', value: true }
      if (kind === 'number') return { col, op: 'ne', value: 0 }
      throw new Refusal('type-mismatch', `${col} isn't true/false, so it can't be used as a condition on the server`, n, `Compare it, like ${col} = "..."`)
    }
    // a calculation used as a condition: true when it is not 0
    if (this.isArith(n)) return { op: 'cmpExpr', cmp: 'ne', left: this.numExpr(n, rc), right: 0 }
    switch (n.t) {
      case 'unary':
        if (n.op === '!') return not(this.cond(n.arg, rc))
        break
      case 'bin':
        switch (n.op) {
          case '&&': return and([this.cond(n.left, rc), this.cond(n.right, rc)])
          case '||': return or([this.cond(n.left, rc), this.cond(n.right, rc)])
          case '=': case '<>': case '<': case '>': case '<=': case '>=': return this.comparison(n.op, n.left, n.right, rc, n)
          case 'in': case 'exactin': return this.inOp(n.left, n.right, n.op === 'exactin', rc, n)
          default: break
        }
        break
      case 'call':
        switch (n.name) {
          case 'And': return and(n.args.map((a) => this.cond(a, rc)))
          case 'Or': return or(n.args.map((a) => this.cond(a, rc)))
          case 'Not': if (n.args.length === 1) return not(this.cond(n.args[0]!, rc)); break
          case 'IsBlank': {
            if (n.args.length !== 1) break
            const c = this.columnRef(n.args[0]!, rc)
            if (c === null) break
            const kind = rc.s.cols.get(c)!
            if (kind === 'other') throw new Refusal('unsupported-column', `${c} can't be tested on the server`, n)
            return kind === 'text' ? or([isNull(c), { col: c, op: 'eq', value: '' }]) : isNull(c)
          }
          case 'StartsWith': case 'EndsWith': {
            if (n.args.length !== 2) break
            const c = this.columnRef(n.args[0]!, rc)
            if (c === null || this.rowDependent(n.args[1]!, rc)) break
            const needle = this.foldText(n.args[1]!).toLowerCase()
            const kind = rc.s.cols.get(c)!
            const m = textMatch(c, kind, n.name === 'StartsWith' ? 'startsWith' : 'endsWith', needle, false, n)
            return or([m, needle === '' ? isNull(c) : { const: false }])
          }
          default: break
        }
        break
      default: break
    }
    throw new Refusal('not-delegable-predicate', `This condition can't run on the server`, n,
      'Use comparisons of a column with a value (=, <>, <, >, in, StartsWith, IsBlank) combined with And / Or / Not')
  }

  /** `Lookup.Field` / `ThisRecord.Lookup.Field`: a lookup column of the row and a column of the table it points at */
  lookupPath(n: Node, rc: RowCtx): { col: string; table: string; field: string; kind: ColumnKind; schema: TableSchemaInfo } | null {
    if (n.t !== 'member') return null
    const col = n.obj.t === 'id' ? (rc.s.cols.has(n.obj.name) ? n.obj.name : null) : this.columnRef(n.obj, rc)
    if (col === null) return null
    const table = rc.s.schema.lookups?.[col]
    const schema = table ? this.tableOf(table) : undefined
    if (!table || !schema) return null
    const kind = schema.columns[n.name]
    if (kind === undefined) throw new Refusal('unknown-column', `${table} has no column ${n.name}`, n)
    return { col, table, field: n.name, kind, schema }
  }

  /** a comparison through a lookup: the referenced row matches (or, when blank matches, is missing) */
  viaCompare(lp: { col: string; table: string; field: string; kind: ColumnKind; schema: TableSchemaInfo }, op: CmpOp, v: FxValue, flipped: boolean, at: Node): ConditionV2 {
    if (lp.kind === 'other') throw new Refusal('unsupported-column', `${lp.table}.${lp.field} can't be compared on the server`, at)
    const where = compareColumnLiteral(lp.field, lp.kind, op, v, flipped, at)
    // the engine reads the field of a blank or unreadable lookup as blank: does the comparison hold for blank?
    const orMissing = evaluateConditionV2(where, {}, lp.schema)
    return { via: { col: lp.col, table: lp.table, where, ...(orMissing ? { orMissing: true as const } : {}) } }
  }

  comparison(op: CmpOp, l: Node, r: Node, rc: RowCtx, at: Node): ConditionV2 {
    const lp = this.lookupPath(l, rc)
    if (lp && !this.rowDependent(r, rc)) return this.viaCompare(lp, op, this.scalar(r), false, at)
    const rp = this.lookupPath(r, rc)
    if (rp && !this.rowDependent(l, rc)) return this.viaCompare(rp, op, this.scalar(l), true, at)
    const lc = this.columnRef(l, rc)
    const rcol = this.columnRef(r, rc)
    if (lc !== null && rcol !== null) {
      const lk = rc.s.cols.get(lc)!
      const rk = rc.s.cols.get(rcol)!
      if (lk !== rk) throw new Refusal('type-mismatch', `${lc} and ${rcol} are different kinds of column, so comparing them can't run on the server`, at)
      return compareColumns(lc, rcol, lk, op, at)
    }
    if (lc !== null && !this.rowDependent(r, rc)) return compareColumnLiteral(lc, rc.s.cols.get(lc)!, op, this.scalar(r), false, at)
    if (rcol !== null && !this.rowDependent(l, rc)) return compareColumnLiteral(rcol, rc.s.cols.get(rcol)!, op, this.scalar(l), true, at)
    const ly = this.yearOf(l, rc)
    if (ly && !this.rowDependent(r, rc)) return this.yearCompare(ly, op, this.scalar(r), at)
    const ry = this.yearOf(r, rc)
    if (ry && !this.rowDependent(l, rc)) return this.yearCompare(ry, FLIP_CMP[op], this.scalar(l), at)
    if (!ly && !ry && (this.isArith(l) || this.isArith(r))) return this.exprCompare(op, l, r, rc)
    const calc = lc === null ? l : r
    throw new Refusal('not-delegable-expression', `Calculations on a column (${this.text(calc)}) can't run on the server`, calc,
      'Compare the column itself with a value, moving the calculation to the other side (Due < DateAdd(Today(), -7, "Days"))')
  }

  scalar(n: Node): FxValue {
    const v = this.fold(n)
    if (Array.isArray(v) || isRecord(v)) throw new Refusal('type-mismatch', `Can't compare a column with ${describeValue(v)}`, n)
    return v
  }

  /* -------------------------------------------------------------- computed numbers (P0 package D) */

  /** + - * / unary minus, %, Abs, Round, RoundUp, RoundDown: the forms numExpr may translate */
  isArith(n: Node): boolean {
    switch (n.t) {
      case 'bin': return n.op === '+' || n.op === '-' || n.op === '*' || n.op === '/'
      case 'unary': return n.op === '-'
      case 'pct': return true
      case 'call': return ARITH_FNS.has(n.name)
      default: return false
    }
  }

  /** a row-independent part of a calculation, as the engine's toNumber would read it */
  foldArith(n: Node): number {
    const v = this.fold(n)
    if (v instanceof Date) throw new Refusal('not-delegable-expression', "Date arithmetic with a column can't run on the server", n, 'Compare the date column with a date computed outside, like Due < DateAdd(Today(), 7, "Days")')
    if (Array.isArray(v) || isRecord(v)) throw new Refusal('type-mismatch', `Can't calculate with ${describeValue(v)}`, n)
    let x: number
    try {
      x = toNumber(v, n)
    } catch {
      throw new Refusal('evaluation-error', `Can't use ${describeValue(v)} as a number`, n)
    }
    if (!Number.isFinite(x)) throw new Refusal('evaluation-error', "That result isn't a valid number", n)
    return x
  }

  /**
   * A calculation over the current row -> NumExprV2. Blank number cells read as 0, as in the engine. Division only by a
   * value from outside the row that is not 0 (dividing by a column could hit 0 in rows the engine never evaluates, so
   * the failure would differ).
   */
  numExpr(n: Node, rc: RowCtx): NumExprV2 {
    if (!this.rowDependent(n, rc)) return this.foldArith(n)
    const col = this.columnRef(n, rc)
    if (col !== null) {
      const kind = rc.s.cols.get(col)!
      if (kind === 'number' || kind === 'boolean') return { col }
      throw new Refusal('type-mismatch', `${col} isn't a number, so it can't be used in a calculation on the server`, n, 'Calculate with number columns only')
    }
    const unsupported = (): never => {
      throw new Refusal('not-delegable-expression', `This calculation on a column (${this.text(n)}) can't run on the server`, n,
        'On the server, calculations may use + - * /, Abs, Round, RoundUp and RoundDown on number columns; move other calculations outside the table expression or store the value in a column')
    }
    switch (n.t) {
      case 'unary':
        if (n.op === '-') return { fn: 'sub', args: [0, this.numExpr(n.arg, rc)] }
        return unsupported()
      case 'pct': return { fn: 'div', args: [this.numExpr(n.arg, rc), 100] }
      case 'bin': {
        if (n.op === '/') {
          if (this.rowDependent(n.right, rc)) {
            throw new Refusal('not-delegable-expression', `Dividing by a column (${this.text(n.right)}) can't run on the server`, n.right,
              'Divide by a value from outside the table, or compare by multiplying instead (Price > 2 * Cost rather than Price / Cost > 2)')
          }
          const d = this.foldArith(n.right)
          if (d === 0) throw new Refusal('evaluation-error', "Can't divide by zero", n.right)
          return { fn: 'div', args: [this.numExpr(n.left, rc), d] }
        }
        const fn = n.op === '+' ? 'add' : n.op === '-' ? 'sub' : n.op === '*' ? 'mul' : null
        if (!fn) return unsupported()
        return { fn, args: [this.numExpr(n.left, rc), this.numExpr(n.right, rc)] }
      }
      case 'call': {
        if (n.name === 'Abs' && n.args.length === 1) return { fn: 'abs', args: [this.numExpr(n.args[0]!, rc)] }
        if ((n.name === 'Round' || n.name === 'RoundUp' || n.name === 'RoundDown') && (n.args.length === 1 || n.args.length === 2)) {
          let digits = 0
          if (n.args.length === 2) {
            if (this.rowDependent(n.args[1]!, rc)) throw new Refusal('not-delegable-expression', `The number of digits of ${n.name} must come from outside the table to run on the server`, n.args[1]!)
            digits = Math.trunc(this.foldArith(n.args[1]!))
            if (Math.abs(digits) > 100) throw new Refusal('not-delegable-expression', `${n.name} with ${digits} digits can't run on the server`, n.args[1]!)
          }
          const fn = n.name === 'Round' ? 'round' : n.name === 'RoundUp' ? 'roundUp' : 'roundDown'
          return { fn, args: [this.numExpr(n.args[0]!, rc)], digits }
        }
        return unsupported()
      }
      default: return unsupported()
    }
  }

  /** one side of a comparison with a calculation: a calculation, a number column, or an outside value */
  exprSide(n: Node, op: CmpOp, rc: RowCtx): NumExprV2 | { const: boolean } {
    if (this.isArith(n) && this.rowDependent(n, rc)) return this.numExpr(n, rc)
    const col = this.columnRef(n, rc)
    if (col !== null) {
      // a blank number cell compares like 0 with a number (= and ordering alike)
      if (rc.s.cols.get(col) === 'number') return { col }
      throw new Refusal('type-mismatch', `${col} isn't a number, so comparing it with a calculation can't run on the server`, n)
    }
    if (this.rowDependent(n, rc)) {
      throw new Refusal('not-delegable-expression', `This calculation on a column (${this.text(n)}) can't run on the server`, n,
        'On the server, calculations may use + - * /, Abs, Round, RoundUp and RoundDown on number columns')
    }
    const v = this.fold(n)
    if (v === null) return 0
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Refusal('evaluation-error', "That result isn't a valid number", n)
      return v
    }
    if (typeof v === 'boolean') {
      // the engine: a number never equals true/false; in ordering a boolean reads as 0 / 1
      if (op === '=') return { const: false }
      if (op === '<>') return { const: true }
      return v ? 1 : 0
    }
    if (typeof v === 'string') {
      const x = numericOfText(v)
      if (x === undefined || !Number.isFinite(x)) throw new Refusal('type-mismatch', `Comparing a calculation with the text "${v.slice(0, 30)}" can't run on the server`, n, 'Compare with a number')
      return x
    }
    throw new Refusal('type-mismatch', `Can't compare a calculation with ${describeValue(v)} on the server`, n)
  }

  exprCompare(op: CmpOp, l: Node, r: Node, rc: RowCtx): ConditionV2 {
    const a = this.exprSide(l, op, rc)
    const b = this.exprSide(r, op, rc)
    if (typeof a === 'object' && 'const' in a) return a
    if (typeof b === 'object' && 'const' in b) return b
    return { op: 'cmpExpr', cmp: CMP_V2[op], left: a, right: b }
  }

  /** Year(DateColumn) */
  yearOf(n: Node, rc: RowCtx): { col: string; kind: 'date' | 'datetime' } | null {
    if (n.t !== 'call' || n.name !== 'Year' || n.args.length !== 1) return null
    const col = this.columnRef(n.args[0]!, rc)
    if (col === null) return null
    const kind = rc.s.cols.get(col)
    return kind === 'date' || kind === 'datetime' ? { col, kind } : null
  }

  /**
   * Year(col) <op> n as a range on the column (local calendar years, like the engine's Year()). A blank cell has no year:
   * the engine compares blank with n as 0 with n.
   */
  yearCompare(y: { col: string; kind: 'date' | 'datetime' }, op: CmpOp, v: FxValue, at: Node): ConditionV2 {
    let n: number
    if (v === null) n = 0
    else if (typeof v === 'number') n = v
    else if (typeof v === 'string' && numericOfText(v) !== undefined) n = numericOfText(v)!
    else throw new Refusal('type-mismatch', `Can't compare a year with ${describeValue(v)} on the server`, at, 'Compare Year(...) with a number')
    if (!Number.isFinite(n)) throw new Refusal('evaluation-error', "That result isn't a valid number", at)
    const lit = (Y: number): QueryLiteral => {
      if (y.kind === 'date') return { $date: `${String(Y).padStart(4, '0')}-01-01` }
      const d = new Date(2000, 0, 1)
      d.setFullYear(Y, 0, 1)
      return { $datetime: d.toISOString() }
    }
    const nn: ConditionV2 = { not: isNull(y.col) }
    /** year < Y, for non-blank cells */
    const before = (Y: number): ConditionV2 => (Y <= 1 ? { const: false } : Y > 9999 ? nn : { col: y.col, op: 'lt', value: lit(Y) })
    const from = (Y: number): ConditionV2 => (Y <= 1 ? nn : Y > 9999 ? { const: false } : { col: y.col, op: 'ge', value: lit(Y) })
    let part: ConditionV2
    switch (op) {
      case '=': part = Number.isInteger(n) ? and([from(n), before(n + 1)]) : { const: false }; break
      case '<>': part = Number.isInteger(n) ? or([before(n), from(n + 1)]) : nn; break
      case '<': part = before(Math.ceil(n)); break
      case '<=': part = before(Math.floor(n) + 1); break
      case '>': part = from(Math.floor(n) + 1); break
      case '>=': part = from(Math.ceil(n)); break
    }
    const blank = op === '=' ? n === 0 : op === '<>' ? n !== 0 : op === '<' ? 0 < n : op === '<=' ? 0 <= n : op === '>' ? 0 > n : 0 >= n
    return withNull(y.col, part, blank)
  }

  inOp(l: Node, r: Node, exact: boolean, rc: RowCtx, at: Node): ConditionV2 {
    const lc = this.columnRef(l, rc)
    const rcol = this.columnRef(r, rc)
    if (rcol !== null && lc === null && !this.rowDependent(l, rc)) {
      // "text" in Column: substring test; a blank cell reads as ''
      const v = this.fold(l)
      if (Array.isArray(v) || isRecord(v)) throw new Refusal('not-delegable-predicate', "Looking for a table or record inside a column can't run on the server", at)
      const needle = toText(v, l)
      const kind = rc.s.cols.get(rcol)!
      const m = textMatch(rcol, kind, 'contains', exact ? needle : needle.toLowerCase(), exact, at)
      return or([m, needle === '' ? isNull(rcol) : { const: false }])
    }
    if (lc !== null && rcol === null && !this.rowDependent(r, rc)) {
      const hay = this.fold(r)
      if (!Array.isArray(hay)) {
        throw new Refusal('not-delegable-predicate', `Looking for ${lc} inside a text can't run on the server`, at, `Use ${lc} in ["a", "b"] for a list, or StartsWith`)
      }
      const items: FxValue[] = []
      for (const row of hay) {
        if (isRecord(row)) {
          if (hasOwn(row, 'Value')) { items.push(row.Value!); continue }
          const keys = Object.keys(row).filter((k) => k !== '__id')
          if (keys.length === 1) items.push(row[keys[0]!]!)
          continue
        }
        items.push(row)
      }
      if (items.some((x) => Array.isArray(x) || isRecord(x))) throw new Refusal('type-mismatch', `Can't compare ${lc} with tables or records`, at)
      return inList(lc, rc.s.cols.get(lc)!, items, exact, at)
    }
    throw new Refusal('not-delegable-predicate', "This use of 'in' can't run on the server", at, 'Use "text" in Column, or Column in ["a", "b"] with values from outside the table')
  }
}

function asRefusal(e: unknown, at: { start: number; end: number }): Refusal {
  if (e instanceof Refusal) return e
  if (e instanceof FxError) return new Refusal('evaluation-error', e.message, at)
  throw e
}

function isBranchArg(n: CallNode, i: number): boolean {
  if (n.name === 'If') return i % 2 === 1 || (n.args.length % 2 === 1 && i === n.args.length - 1)
  // Switch(value, match1, result1, ..., default)
  if (i === 0) return false
  return i % 2 === 0 || (n.args.length % 2 === 0 && i === n.args.length - 1)
}

function sortable(col: string, kind: ColumnKind, at: { start: number; end: number }): void {
  if (kind === 'other') throw new Refusal('unsupported-column', `Sorting by ${col} can't run on the server`, at)
}

function isOrderText(v: FxValue): boolean {
  if (typeof v !== 'string') return false
  const o = v.trim().toLowerCase()
  return o === 'ascending' || o === 'descending' || o === 'asc' || o === 'desc'
}

function orderOf(text: string, at: { start: number; end: number }): boolean {
  const o = text.trim().toLowerCase()
  if (o === 'ascending' || o === 'asc') return true
  if (o === 'descending' || o === 'desc') return false
  throw new Refusal('evaluation-error', 'Sort order must be Ascending or Descending', at)
}

/* ------------------------------------------------------------------ entry points */

/**
 * Translate a formula over data-source tables. Never throws: syntax errors and untranslatable parts come back as
 * diagnostics. `formula` is the stored text with its leading '='.
 */
export function analyze(formula: string, schema: SchemaInfo, options: AnalyzeOptions = {}): AnalyzeResult {
  const p = parse(formula)
  if (p.error) {
    return {
      plan: null, plans: [], residual: null, fullyDelegated: false, clientEvaluated: false,
      diagnostics: [{ severity: 'error', code: 'parse-error', message: p.error.message, start: p.error.start, end: p.error.end, text: formula.slice(p.error.start, p.error.end) }],
    }
  }
  if (!p.ast) return { plan: null, plans: [], residual: null, diagnostics: [], fullyDelegated: true, clientEvaluated: false }
  const a = new Analyzer(formula, schema, options)
  // core data model macros (Comments(r), MyTasks(), Setting(k) ...) become the Filter / LookUp they stand for
  const ast = hasSystemMacro(p.ast) ? expandMacros(p.ast, (t) => !!schema.tables[t]) : p.ast
  let root: Node
  try {
    const l = a.lower(ast)
    root = l.k === 'stream' ? a.materialize(l.s, l.node).node : l.e.node
  } catch (e) {
    a.report(asRefusal(e, ast), a.baseTable(ast))
    root = ast
  }
  const hasError = a.diagnostics.some((d) => d.severity === 'error')
  // plans made while probing an expression that was then left to the browser are not used
  const used = new Set(freeIdentifiers(root).map((x) => x.name))
  a.plans = a.plans.filter((q) => used.has(q.id))
  const residual = root.t === 'id' && a.plans.length > 0 && root.name === a.plans[0]!.id && a.plans.length === 1
    ? null
    : a.plans.length > 0 ? { formula: '=' + printNode(root), bindings: a.plans.map((q) => q.id) } : null
  return {
    plan: hasError ? null : (a.plans[0]?.plan ?? null),
    plans: hasError ? [] : a.plans,
    residual: hasError ? null : residual,
    diagnostics: a.diagnostics,
    fullyDelegated: !hasError && !a.clientEvaluated,
    clientEvaluated: a.clientEvaluated,
  }
}
