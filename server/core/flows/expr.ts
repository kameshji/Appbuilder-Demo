/**
 * Expressions of flows (docs/dev/flows.md "Expressions"): Fx evaluated on the server, pure (flows change data with data
 * steps, never with Patch inside a formula). Names: Trigger, Steps.<name>.Output / .Status / .Error, Variables.<name>,
 * Flow (RunId, Name, Id, Version, Mode), User() = the run-as identity, the item of each enclosing forEach by its `as`
 * name (and ThisItem for the innermost one), the tables of the environment for delegable reads.
 *
 * Reads of tables are pushed down (Query v2 through the DataService as the run-as identity), with the limits of table
 * events: rows read, queries and a time budget per evaluation. A read that cannot be pushed down, or a table read as a
 * whole, is refused at save time and at run time.
 */
import type { DataService, UserContext } from '../contracts.ts'
import type { FxEngine, FxRecord, FxScope, FxValue } from '../../../src/contracts.ts'
import type { TableDef } from '../../../src/platform/contracts.ts'
import type { QueryPlan } from '../../../src/platform/query.ts'
import { createEngine } from '../../../src/fx/engine.ts'
import { def, type FnDef } from '../../../src/fx/functions/types.ts'
import { analyze, bindResult, residualScope } from '../../../src/fx/query/index.ts'
import { parse } from '../../../src/fx/parser.ts'
import { childrenOf, type Node } from '../../../src/fx/ast.ts'
import { isRecord } from '../../../src/fx/values.ts'
import { setRegexGuard } from '../../../src/fx/functions/text.ts'
import { setEvaluationBudget } from '../../../src/fx/evaluate.ts'

// P1-E security: formulas evaluated on the server (flows, table events, reports) refuse regular expressions with nested
// repeats (catastrophic backtracking would stall the one server process for everyone)
setRegexGuard(true)
// and one evaluation stops after 30 s of pure computation (the step's time budget for reads is the same)
setEvaluationBudget(30_000)
import { checkDeadline, schemaOf, toFx, type EvalLimits } from '../event-fx.ts'

export interface FlowClock { now(): Date }
export const realClock: FlowClock = { now: () => new Date() }

/** Now() and Today() follow the flow clock (tests move it) */
export function flowEngine(clock: FlowClock): FxEngine {
  const natives: FnDef[] = [
    def('Now', 'Now()', 'The current date and time.', 0, 0, () => clock.now()),
    def('Today', 'Today()', 'Today at midnight.', 0, 0, () => {
      const n = clock.now()
      return new Date(n.getFullYear(), n.getMonth(), n.getDate())
    }),
  ]
  return createEngine({}, natives)
}

export const src = (f: string): string => (f.trim().startsWith('=') ? f.trim() : `=${f.trim()}`)

/** names a flow expression may start with (besides tables, enums and functions) */
export const ROOT_NAMES = ['Trigger', 'Steps', 'Variables', 'Flow', 'ThisItem']

export interface ScopeData {
  trigger: FxValue
  steps: FxRecord
  variables: FxRecord
  flow: FxRecord
  user: FxRecord
  /** enclosing forEach items, outermost first */
  loops: { as: string; item: FxValue }[]
}

export function flowScope(d: ScopeData, tables?: ReadonlySet<string>): FxScope {
  return {
    resolve(name) {
      switch (name) {
        case 'Trigger': return d.trigger
        case 'Steps': return d.steps
        case 'Variables': return d.variables
        case 'Flow': return d.flow
        case 'User()': return d.user
        case 'ThisItem': return d.loops.length ? d.loops[d.loops.length - 1].item : undefined
      }
      for (let i = d.loops.length - 1; i >= 0; i--) if (d.loops[i].as === name) return d.loops[i].item
      // tables answer [] so a bare table name never reads anything (refused before evaluation)
      if (tables?.has(name)) return []
      return undefined
    },
  }
}

export interface EvalEnv {
  tables: TableDef[]
  identity: UserContext | null
  data: DataService
  limits: EvalLimits
  engine: FxEngine
}

export type EvalResult = { ok: true; value: FxValue } | { ok: false; error: string; permanent: boolean }

/** a plan that reads every row of a table */
export const wholeTable = (q: { plan: QueryPlan; shape: string; bounded: boolean }): boolean =>
  q.shape === 'rows' && !q.bounded && !q.plan.filter && !q.plan.take && !q.plan.single && !q.plan.aggregate && !q.plan.search

const serverWording = (m: string): string => m.replace(/ to the browser/g, ' for a flow').replace(/the browser/g, 'a flow')

export function rowsToFx(t: TableDef, rows: Record<string, unknown>[]): FxRecord[] {
  const cols = new Map(t.columns.map((c) => [c.name, c]))
  return rows.map((r) => {
    const rec: FxRecord = {}
    for (const [k, v] of Object.entries(r)) rec[k] = toFx(cols.get(k) ?? (k === 'createdOn' || k === 'modifiedOn' ? { name: k, displayName: k, type: 'datetime' } : undefined), v)
    if (r.id !== undefined && r.id !== null) rec.__id = String(r.id)
    return rec
  })
}

/** runs a Query v2 plan as the identity, counting it against the limits */
export async function runPlan(env: EvalEnv, t: TableDef, plan: QueryPlan): Promise<{ rows: FxRecord[]; count?: number }> {
  checkDeadline(env.limits, 'The expression')
  if (++env.limits.queries > env.limits.maxQueries) throw Object.assign(new Error(`The step reads tables more than ${env.limits.maxQueries} times; simplify it.`), { permanent: true })
  const res = await env.data.queryV2(env.identity, t, plan)
  const rows = rowsToFx(t, res.rows)
  env.limits.rowsRead += rows.length
  if (env.limits.rowsRead > env.limits.maxRows) throw Object.assign(new Error(`The step read more than ${env.limits.maxRows} rows; read fewer (a narrower filter, top).`), { permanent: true })
  return { rows, count: res.count }
}

/** evaluate a flow expression: pushed-down reads as the identity, then the pure remainder */
export async function evaluate(formula: string, scope: FxScope, env: EvalEnv): Promise<EvalResult> {
  const s = src(formula)
  if (s === '=') return { ok: true, value: null }
  const byName = new Map(env.tables.map((t) => [t.name, t]))
  const a = analyze(s, schemaOf(env.tables), { scope, engine: env.engine, clientRowLimit: 5000 })
  const err = a.diagnostics.find((d) => d.severity === 'error')
  if (err) return { ok: false, error: serverWording(err.message), permanent: true }
  const bindings: Record<string, FxValue> = {}
  try {
    for (const q of a.plans) {
      if (wholeTable(q)) return { ok: false, error: `${q.plan.table} is read as a whole here, which a flow cannot do. Read the rows you need with LookUp, Filter (with FirstN), CountRows or a List rows step.`, permanent: true }
      const t = byName.get(q.plan.table)
      if (!t) return { ok: false, error: `Table ${q.plan.table} was not found.`, permanent: true }
      bindings[q.id] = bindResult(q, await runPlan(env, t, q.plan))
    }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    const status = (e as { status?: number }).status
    return { ok: false, error: m, permanent: (e as { permanent?: boolean }).permanent === true || (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) }
  }
  if (!a.residual && a.plans.length === 1) return { ok: true, value: bindings[a.plans[0].id] ?? null }
  const r = env.engine.evaluate(a.residual?.formula ?? s, residualScope(bindings, scope))
  try {
    checkDeadline(env.limits, 'The expression')
  } catch (e) {
    return { ok: false, error: (e as Error).message, permanent: true }
  }
  if (!r.ok) return { ok: false, error: r.error.message, permanent: true }
  return { ok: true, value: r.value }
}

/* ------------------------------------------------------------------ static checks */

export interface Problem { message: string; start?: number; end?: number }

/** values of the sample scope whose fields are not known (outputs of compose, http bodies ...): members are not checked */
export const OPEN = new WeakSet<object>()
export function open<T extends object>(v: T): T {
  OPEN.add(v)
  return v
}

/** the value of a member chain over the sample scope, or undefined when it cannot be followed statically */
function chainValue(n: Node, scope: FxScope): { value: FxValue; path: string } | undefined {
  if (n.t === 'id') {
    const v = scope.resolve(n.name)
    return v === undefined ? undefined : { value: v, path: n.name }
  }
  if (n.t === 'member') {
    const base = chainValue(n.obj, scope)
    if (!base || !isRecord(base.value)) return undefined
    const rec = base.value as FxRecord
    return { value: (rec[n.name] ?? null) as FxValue, path: `${base.path}.${n.name}` }
  }
  if (n.t === 'call' && n.name === 'User' && n.args.length === 0) {
    const v = scope.resolve('User()')
    return v === undefined ? undefined : { value: v, path: 'User()' }
  }
  return undefined
}

/** member accesses on closed sample records whose field does not exist (Trigger.Record.Nope, Steps.Missing.Output) */
function memberProblems(root: Node, scope: FxScope, roots: ReadonlySet<string>): Problem[] {
  const out: Problem[] = []
  const visit = (n: Node): void => {
    if (n.t === 'member') {
      // only chains that start at a flow name
      let r: Node = n
      while (r.t === 'member') r = r.obj
      if ((r.t === 'id' && roots.has(r.name)) || (r.t === 'call' && r.name === 'User')) {
        const base = chainValue(n.obj, scope)
        if (base && isRecord(base.value) && !OPEN.has(base.value as object) && !Object.prototype.hasOwnProperty.call(base.value, n.name)) {
          const known = Object.keys(base.value as object).filter((k) => k !== '__id')
          const what = base.path === 'Steps' ? `There is no step "${n.name}" before this one${known.length ? ` (steps you can use here: ${known.slice(0, 12).join(', ')})` : ''}.`
            : base.path === 'Variables' ? `There is no variable "${n.name}"; declare it in the flow's variables.`
              : `${base.path} has no field "${n.name}"${known.length ? ` (fields: ${known.slice(0, 15).join(', ')})` : ''}.`
          out.push({ message: what, start: n.nameStart, end: n.nameEnd })
          return
        }
      }
    }
    for (const c of childrenOf(n)) visit(c)
  }
  visit(root)
  return out
}

/**
 * Save-time problems of an expression in a scope of sample values: syntax and function arguments, actions (flows are
 * pure), unknown names and fields, reads that cannot be pushed down, tables read as a whole.
 */
export function checkExpression(formula: string, scope: FxScope, tables: TableDef[], engine: FxEngine, extraRoots: string[] = []): Problem[] {
  const s = src(formula)
  if (s === '=') return [{ message: 'The formula is empty.', start: 0, end: 0 }]
  const syntax = engine.check(s)
  if (syntax.length) return syntax.map((d) => ({ message: d.message, start: d.start, end: d.end }))
  const p = parse(s)
  if (!p.ast) return []
  const out: Problem[] = []
  const behaviour = new Set(engine.functions().filter((f) => f.kind === 'behaviour').map((f) => f.name))
  const visit = (n: Node): void => {
    if (n.t === 'call' && behaviour.has(n.name)) {
      out.push({ message: `${n.name} is an action: flow formulas only calculate values. Change data with a data step (Create, Update, Delete a row), notify people with a Notify step.`, start: n.nameStart, end: n.nameEnd })
    }
    for (const c of childrenOf(n)) visit(c)
  }
  visit(p.ast)
  if (out.length) return out
  const roots = new Set([...ROOT_NAMES, ...extraRoots])
  out.push(...memberProblems(p.ast, scope, roots))
  if (out.length) return out
  const a = analyze(s, schemaOf(tables), { scope, engine, clientRowLimit: 5000 })
  for (const d of a.diagnostics) if (d.severity === 'error') out.push({ message: serverWording(d.message) + (d.suggestion ? ` ${d.suggestion}` : ''), start: d.start, end: d.end })
  if (out.length) return out
  for (const q of a.plans) if (wholeTable(q)) out.push({ message: `${q.plan.table} is read as a whole here, which a flow cannot do. Read the rows you need with LookUp, Filter (with FirstN), CountRows or a List rows step.`, start: q.start, end: q.end })
  if (out.length) return out
  // unknown names: evaluate the pure remainder over the sample scope with the reads answered by blanks
  const bindings: Record<string, FxValue> = {}
  for (const q of a.plans) bindings[q.id] = q.shape === 'rows' ? [] : q.shape === 'count' ? 0 : null
  const r = engine.evaluate(a.residual?.formula ?? (a.plans.length === 1 ? '=0' : s), residualScope(bindings, scope))
  if (!r.ok && /isn't recognised|is not recognised|not recognized/i.test(r.error.message)) out.push({ message: r.error.message, start: r.error.start, end: r.error.end })
  return out
}
