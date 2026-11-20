/**
 * Delegation of table formulas to the server (P0 package D). Server mode only: demo mode, collections and small tables
 * keep the browser evaluation they always had.
 *
 * For a formula that reads data-source tables, `analyze()` (src/fx/query) splits it into Query v2 plans and a residual
 * formula. Plans run on the server through the platform's query cache; the residual runs here over their results. While
 * a plan has no result yet the property is "loading" (the evaluator keeps the previous value, so nothing flickers). A
 * table expression that cannot be translated over a table that is too big to hold in the browser is an evaluation
 * ERROR, never a result computed from part of the rows.
 *
 * An unbounded list (a gallery's or a data table's Items) is paged: the first page now, more on scroll. The array
 * carries a non-enumerable `__query` description (QueryMeta) that controls use for the exact count, `loadMore()` and
 * server-side sort / search.
 */
import type { FxDiagnostic, FxEngine, FxScope, FxValue } from '@/contracts'
import { analyze, bindResult, explain, residualScope, type AnalyzeResult, type PlannedQuery, type QueryDiagnostic } from '@/fx/query'
import { parse } from '@/fx/parser'
import { freeIdentifiers, type Node } from '@/fx/ast'
import { isSystemMacro, systemMacroTables } from '@/fx/functions/collab'
import { columnKind, type ColumnKind, type ConditionV2, type QueryPlan, type SchemaInfo, type SortKeyV2, type TableSchemaInfo } from '@/platform/query'
import { platform, type QueryState, type TableDef } from '@/platform'
import { lookupSearchCondition } from '@/controls/lookups'
import { platformMode, platformState } from './data'

/** tables at most this big run formulas the server can't run in the browser (same threshold as the platform) */
export const CLIENT_ROW_LIMIT = 2000
/** first page (and each next page) of an unbounded list */
export const DEFAULT_PAGE_SIZE = 100

/** what the Studio shows next to a table formula */
export interface DelegationInfo {
  /** server: every table read runs in the database; browser: a small table is evaluated here; error: can't run */
  where: 'server' | 'browser' | 'error'
  /** text of explain(): server part, browser part, problems */
  explain: string
  diagnostics: QueryDiagnostic[]
  plans: number
}

/** control view state that shapes the plan of an unbounded list (DataTable header sort and search box) */
export interface ListView {
  sort?: SortKeyV2
  search?: string
  /** type-ahead (Dropdown / ComboBox): match the start of the shown column first */
  searchColumns?: string[]
}

/** description of a paged result, attached to the array as `__query` */
export interface QueryMeta {
  key: string
  table: string
  /** exact number of rows of the whole result (after the user's row filters) */
  count?: number
  hasMore: boolean
  loadingMore: boolean
  refreshing: boolean
  /** capped connectors: the result covers only part of the table */
  truncated?: boolean
  /** columns of the rows and their kinds (what the server can sort and search) */
  columns: Record<string, ColumnKind>
  /** the plan of the list, before any control view (sort / search) was applied */
  plan: QueryPlan
  /** the rows ARE the plan's rows (no browser-side calculation on top): a control may re-plan them with its own view */
  pure: boolean
  /** the control view the server applied (sort by a header, search box), if any */
  view?: ListView
  loadMore(): Promise<void>
}

/** did the server apply this sort / search (else a control sorts and searches the rows it holds) */
export function viewMatches(meta: QueryMeta, sort: { col: string; dir: 'asc' | 'desc' } | null, search: string): boolean {
  const v = meta.view
  const s = v?.sort
  const sortOk = sort ? !!s && s.col === sort.col && s.dir === sort.dir : !s
  const searchOk = (v?.search ?? '').trim() === search.trim()
  return sortOk && searchOk
}

export function queryMeta(v: unknown): QueryMeta | undefined {
  if (!Array.isArray(v)) return undefined
  const m = (v as unknown as { __query?: QueryMeta }).__query
  return m && typeof m === 'object' ? m : undefined
}

export interface DelegatedResult {
  /** nothing for the server: evaluate the formula in the browser as usual (keep `info` / `warning` for the Studio) */
  browser?: true
  /** the plan states the value was computed from: the same stamp means the same value (identity can be kept) */
  stamp?: string
  value?: FxValue
  loading: boolean
  error?: string
  diag?: FxDiagnostic
  warning?: string
  info: DelegationInfo
}

/* ------------------------------------------------------------------ table references */

// DeletedRows(Table) (recycle bin) names the table too: its rows come from the server's Deleted view, not from Table
const WRITE_TARGET = new Set(['Patch', 'Collect', 'ClearCollect', 'Remove', 'Defaults', 'Refresh', 'Clear', 'DeletedRows'])
const parsed = new Map<string, Node | null>()

function astOf(formula: string): Node | null {
  let n = parsed.get(formula)
  if (n === undefined) {
    try {
      const p = parse(formula)
      n = p.error ? null : (p.ast ?? null)
    } catch {
      n = null
    }
    if (parsed.size > 5000) parsed.clear()
    parsed.set(formula, n)
  }
  return n
}

function tableNameSet(): Map<string, string> {
  const m = new Map<string, string>()
  for (const t of platformState()?.tables ?? []) m.set(t.name, t.name)
  return m
}

/** data-source tables a formula READS (the first argument of Patch, Collect, Remove ... is a write target, not a read) */
export function tableReads(formula: string, collections: Record<string, unknown> = {}): string[] {
  const ast = astOf(formula)
  if (!ast) return []
  const tables = tableNameSet()
  if (!tables.size) return []
  const out = new Set<string>()
  const visit = (n: Node, skipFirst: boolean): void => {
    if (n.t === 'id') {
      if (!skipFirst && tables.has(n.name) && !Object.prototype.hasOwnProperty.call(collections, n.name)) out.add(n.name)
      return
    }
    if (n.t === 'call') {
      // core data model macros read their system tables (Comments(r) is Filter(Comments, ...))
      if (isSystemMacro(n)) for (const t of systemMacroTables(n)) if (tables.has(t)) macro.add(t)
      n.args.forEach((a, i) => visit(a, i === 0 && WRITE_TARGET.has(n.name) && a.t === 'id'))
      return
    }
    for (const id of childNodes(n)) visit(id, false)
  }
  const macro = new Set<string>()
  visit(ast, false)
  // freeIdentifiers respects As aliases; intersect to drop names shadowed by an alias
  const free = new Set(freeIdentifiers(ast).map((x) => x.name))
  return [...new Set([...[...out].filter((n) => free.has(n)), ...macro])]
}

function childNodes(n: Node): Node[] {
  switch (n.t) {
    case 'member': return [n.obj]
    case 'call': return n.args
    case 'unary': case 'pct': return [n.arg]
    case 'bin': return [n.left, n.right]
    case 'chain': return n.items
    case 'rec': return n.fields.map((f) => f.value)
    case 'tab': return n.items
    case 'interp': return n.parts.filter((p): p is Node => typeof p !== 'string')
    case 'as': return [n.expr]
    default: return []
  }
}

/** top-level `a; b; c` items of an action formula, as formulas of their own */
export function chainItems(formula: string): string[] {
  const ast = astOf(formula)
  if (!ast || ast.t !== 'chain') return [formula]
  return ast.items.map((it) => '=' + formula.slice(it.start, it.end))
}

/** server mode and the formula reads a table that is not held whole in the browser */
export function needsServer(formula: string, collections: Record<string, unknown> = {}): boolean {
  if (platformMode() !== 'server') return false
  return tableReads(formula, collections).some((t) => !sizeOf(t).fullyLoaded)
}

function sizeOf(table: string): { rowCount?: number; fullyLoaded: boolean } {
  try {
    return platform.tables.sizeInfo(table)
  } catch {
    return { fullyLoaded: false }
  }
}

/** formula kinds of every table, size facts for the ones this formula reads */
export function schemaFor(reads: string[]): SchemaInfo {
  const tables: Record<string, TableSchemaInfo> = {}
  for (const t of platformState()?.tables ?? []) {
    const columns: Record<string, ColumnKind> = { id: 'text' }
    const lookups: Record<string, string> = {}
    for (const c of t.columns) {
      columns[c.name] = columnKind(c.type)
      // lookup paths (createdBy.FullName = ...) translate when the target table is known
      if (c.type === 'lookup' && c.lookupTable) lookups[c.name] = c.lookupTable
    }
    tables[t.name] = Object.keys(lookups).length ? { columns, lookups } : { columns }
  }
  for (const name of reads) {
    const s = sizeOf(name)
    if (tables[name]) Object.assign(tables[name]!, { fullyLoaded: s.fullyLoaded, rowCount: s.rowCount })
  }
  return { tables }
}

/* ------------------------------------------------------------------ evaluation */

function diagText(d: QueryDiagnostic, schema: SchemaInfo): string {
  const t = d.table ? schema.tables[d.table] : undefined
  const size = t?.rowCount !== undefined ? ` (${d.table} has ${t.rowCount.toLocaleString('en-US')} rows: too many to work through in the browser)` : ''
  return `Can't run on the server: ${d.message}${size}.${d.suggestion ? ` ${d.suggestion}.` : ''}`.replace(/\.\.$/, '.')
}

function info(r: AnalyzeResult, where: DelegationInfo['where']): DelegationInfo {
  return { where, explain: explain(r), diagnostics: r.diagnostics, plans: r.plans.length }
}

/**
 * Lookup columns of a table and the target each may be searched in by label (src/controls/lookups.ts). A lookup whose
 * target is unknown, not readable or has a hidden or non-text primary column maps to null: it is left out of a search
 * rather than matched by its id.
 */
function lookupTargets(table: string): Map<string, TableDef | null> {
  const out = new Map<string, TableDef | null>()
  const st = platformState()
  const def = st?.tables.find((t) => t.name === table)
  if (!def) return out
  const priv = st?.session?.privileges
  for (const c of def.columns) {
    if (c.type !== 'lookup') continue
    const target = c.lookupTable ? st!.tables.find((t) => t.name === c.lookupTable || t.id === c.lookupTable) : undefined
    const tp = target ? priv?.tables[target.id] : undefined
    const hidden = !!target && !!priv && !priv.isAdmin && (!tp || tp.read === 'none' || tp.columns[target.primaryColumn] === 'none')
    // a lookup path into another store is refused by the server: such a column is left out of the search
    const sameStore = !!target && (target.connectionId ?? 'conn_default') === (def.connectionId ?? 'conn_default')
    out.set(c.name, target && !hidden && sameStore ? target : null)
  }
  return out
}

/**
 * shape the plan of the list by the control's view (sort by a header, search box). Lookup columns (lookups.ts): never
 * sorted on the server (that would order by the row id; the DataTable does not offer it), searched by the target
 * row's label through a lookup path (`via`), not by id.
 */
function withView(plan: QueryPlan, view: ListView | undefined, kinds: Record<string, ColumnKind>): QueryPlan {
  if (!view) return plan
  let p = plan
  const visible = plan.select ? plan.select : Object.keys(kinds)
  const lookups = lookupTargets(plan.table)
  if (view.sort && visible.includes(view.sort.col) && kinds[view.sort.col] && kinds[view.sort.col] !== 'other' && !lookups.has(view.sort.col)) {
    p = { ...p, sort: [view.sort, ...(p.sort ?? []).filter((k) => k.col !== view.sort!.col)] }
  }
  const text = view.search?.trim()
  if (text) {
    const cols = (view.searchColumns?.length ? view.searchColumns : visible).filter((c) => kinds[c] === 'text' && !['id', 'createdBy', 'owner'].includes(c))
    const parts: ConditionV2[] = []
    for (const c of cols) {
      if (!lookups.has(c)) { parts.push({ col: c, op: 'contains', value: text.toLowerCase() }); continue }
      const target = lookups.get(c)
      const via = target ? lookupSearchCondition(c, target, text.toLowerCase()) : null
      if (via) parts.push(via)
    }
    const cond: ConditionV2 = parts.length ? { or: parts } : { const: false }
    p = { ...p, filter: p.filter ? { and: [p.filter, cond] } : cond }
  }
  return p
}

function attachMeta(arr: FxValue[], st: QueryState, kinds: Record<string, ColumnKind>, basePlan: QueryPlan, pure: boolean, view?: ListView): FxValue[] {
  const meta: QueryMeta = {
    key: st.key, table: st.plan.table, count: st.count, hasMore: st.hasMore, loadingMore: st.loadingMore, refreshing: st.refreshing,
    truncated: st.truncated, columns: kinds, plan: basePlan, pure, view, loadMore: () => platform.tables.loadMore(st.key),
  }
  Object.defineProperty(arr, '__query', { value: meta, enumerable: false, configurable: true })
  return arr
}

/**
 * Evaluate a (non-action) formula that reads tables, in server mode. Returns null when the browser should evaluate it
 * the usual way (no table read, demo mode, or only small fully loaded tables without anything for the server).
 */
export function evaluateDelegated(o: {
  formula: string
  scope: FxScope
  engine: FxEngine
  collections: Record<string, unknown>
  /** records a dependency of the property being computed */
  record(dep: string): void
  /** cache owner (the property key): a newer plan of the same property cancels the old request */
  owner: string
  view?: ListView
  pageSize?: number
}): DelegatedResult | null {
  if (platformMode() !== 'server') return null
  const reads = tableReads(o.formula, o.collections)
  if (!reads.length) return null
  for (const t of reads) o.record('ts:' + t)
  const schema = schemaFor(reads)
  const r = analyze(o.formula, schema, { scope: o.scope, engine: o.engine, clientRowLimit: CLIENT_ROW_LIMIT })
  const errors = r.diagnostics.filter((d) => d.severity === 'error')
  if (errors.length) {
    // the table may still turn out small (its size is being counted): wait rather than show an error that goes away
    if (errors.some((d) => d.table && schema.tables[d.table]?.rowCount === undefined && d.code !== 'parse-error')) {
      return { loading: true, info: info(r, 'server') }
    }
    const d = errors[0]!
    return { loading: false, error: diagText(d, schema), diag: { message: diagText(d, schema), start: d.start, end: d.end }, info: info(r, 'error') }
  }
  const warning = r.diagnostics.find((d) => d.severity === 'warning')
  const warn = warning ? `Runs in the browser: ${warning.message}. Fine while the table stays small; ${warning.suggestion ?? 'make it delegable before the table grows'}.` : undefined
  if (!r.plans.length) return { browser: true, loading: false, info: info(r, 'browser'), warning: warn }
  const values: Record<string, FxValue> = {}
  let loading = false
  let error: string | undefined
  let paged: { q: PlannedQuery; st: QueryState; kinds: Record<string, ColumnKind> } | null = null
  const stamps: string[] = []
  const unbounded = r.plans.filter((q) => q.shape === 'rows' && !q.bounded)
  r.plans.forEach((q, i) => {
    const t = schema.tables[q.plan.table]
    const kinds: Record<string, ColumnKind> = {}
    for (const [k, v] of Object.entries(t?.columns ?? {})) if (!q.plan.select || q.plan.select.includes(k)) kinds[k] = v
    const isList = unbounded.length === 1 && unbounded[0] === q
    const plan = isList ? withView(q.plan, o.view, kinds) : q.plan
    const st = platform.tables.queryState(plan, { owner: `${o.owner}#${i}`, pageSize: isList ? (o.pageSize ?? DEFAULT_PAGE_SIZE) : undefined })
    o.record('q:' + st.key)
    stamps.push(`${st.key}@${st.version}`)
    if (st.status === 'loading') { loading = true; return }
    if (st.status === 'error') { error ??= st.error?.message ?? 'The query failed'; return }
    const res = { rows: isList ? st.rows.slice() : st.rows, count: st.count }
    values[q.id] = bindResult(q, res)
    if (isList) paged = { q, st, kinds }
  })
  const where: DelegationInfo['where'] = r.clientEvaluated ? 'browser' : 'server'
  if (error) return { loading: false, error, info: info(r, where), warning: warn }
  if (loading) return { loading: true, info: info(r, where), warning: warn }
  let value: FxValue
  if (!r.residual) value = values[r.plans[0]!.id]!
  else {
    const res = o.engine.evaluate(r.residual.formula, residualScope(values, o.scope))
    if (!res.ok) return { loading: false, error: res.error.message, info: info(r, where), warning: warn }
    value = res.value
  }
  const p = paged as { q: PlannedQuery; st: QueryState; kinds: Record<string, ColumnKind> } | null
  if (p && Array.isArray(value)) {
    const pure = value === values[p.q.id]
    const arr = pure ? value : value.slice()
    value = attachMeta(arr, p.st, p.kinds, p.q.plan, pure && !o.view, o.view)
  }
  // the same plan states give the same value only when nothing else (a residual formula) shapes it
  return { value, loading: false, info: info(r, where), warning: warn, stamp: r.residual ? undefined : stamps.join('|') }
}

/**
 * A list that came from elsewhere (a named formula, a variable) shown by a control with its own view (header sort,
 * search box): re-plan it with that view when its rows are a plain query result. Returns null when there is nothing to do.
 */
export function deriveList(value: FxValue, view: ListView | undefined, owner: string, record: (dep: string) => void, pageSize = DEFAULT_PAGE_SIZE): DelegatedResult | null {
  const meta = queryMeta(value)
  if (!meta || !meta.pure || !view) return null
  const plan = withView(meta.plan, view, meta.columns)
  const st = platform.tables.queryState(plan, { owner: `${owner}#view`, pageSize })
  record('q:' + st.key)
  const inf: DelegationInfo = { where: 'server', explain: 'Sorted / searched on the server by the UI component', diagnostics: [], plans: 1 }
  if (st.status === 'loading') return { loading: true, info: inf }
  if (st.status === 'error') return { loading: false, error: st.error?.message ?? 'The query failed', info: inf }
  return { loading: false, value: attachMeta(st.rows.slice(), st, meta.columns, meta.plan, true, view), info: inf, stamp: `view|${st.key}@${st.version}` }
}

/**
 * Prefetch and bind the table reads of one action formula (no chain), in server mode: resolves with the formula to
 * evaluate and the scope to evaluate it in, or rejects with the reason it can't run.
 */
export async function prepareAction(formula: string, scope: FxScope, engine: FxEngine, collections: Record<string, unknown>): Promise<{ formula: string; scope: FxScope }> {
  const reads = tableReads(formula, collections)
  if (!reads.length || platformMode() !== 'server') return { formula, scope }
  // sizes decide whether a formula the server can't run may run here
  await Promise.all(reads.map((t) => platform.tables.ensureLoaded([t]).catch(() => {})))
  const schema = schemaFor(reads)
  const r = analyze(formula, schema, { scope, engine, clientRowLimit: CLIENT_ROW_LIMIT })
  const err = r.diagnostics.find((d) => d.severity === 'error')
  if (err) throw new Error(diagText(err, schema))
  if (!r.plans.length) return { formula, scope }
  const values: Record<string, FxValue> = {}
  await Promise.all(r.plans.map(async (q) => {
    const st = await platform.tables.query(q.plan)
    values[q.id] = bindResult(q, { rows: st.rows, count: st.count })
  }))
  if (!r.residual) return { formula: `=${r.plans[0]!.id}`, scope: residualScope(values, scope) }
  return { formula: r.residual.formula, scope: residualScope(values, scope) }
}
