/**
 * Formulas of table events on the server (docs/dev/events-and-jobs.md "The event action language").
 *
 * Evaluation: the formula is analysed with the Query v2 translator (src/fx/query) against every table of the
 * environment, with the event's record already in scope, so reads of other tables (LookUp, Filter, CountRows, Sum ...)
 * become plans that run through DataService.queryV2 as the event's identity (the caller's roles, or the system). What
 * cannot be pushed down is an error, never a partial read. The rest of the formula is evaluated by an engine instance
 * with the event natives (SetField, Reject, NotifyUser, RunConnector, EnqueueJob) and a host that only records intents:
 * nothing is written while the formula runs; the caller applies the intents afterwards.
 *
 * Limits: a time budget (checked between steps; a single synchronous evaluation cannot be pre-empted, the engine's own
 * limits bound it), at most `maxRows` rows read and `maxQueries` queries per evaluation.
 */
import { HttpError } from './contracts.ts'
import type { DataService, UserContext } from './contracts.ts'
import type { FxEngine, FxHost, FxRecord, FxScope, FxValue } from '../../src/contracts.ts'
import type { ColumnDef, TableDef } from '../../src/platform/contracts.ts'
import type { SchemaInfo } from '../../src/platform/query.ts'
import { columnKind } from '../../src/platform/query.ts'
import type { FormulaProblem } from '../../src/platform/events.ts'
import { createEngine } from '../../src/fx/engine.ts'
import { analyze, bindResult, residualScope } from '../../src/fx/query/index.ts'
import { parse } from '../../src/fx/parser.ts'
import { childrenOf, type Node } from '../../src/fx/ast.ts'
import { def, type FnDef } from '../../src/fx/functions/types.ts'
import { isRecord } from '../../src/fx/values.ts'
import { REJECT, SET_FIELD, recordScope } from '../../src/fx/rowrules.ts'

/* ------------------------------------------------------------------ roles and allowed functions */

/** where a formula is used: decides which actions it may contain */
export type FormulaRole = 'condition' | 'validation' | 'formulaColumn' | 'before' | 'after'

/** the actions (behaviour functions) each role may use; everything pure is allowed everywhere */
export const ALLOWED_ACTIONS: Record<FormulaRole, string[]> = {
  condition: [],
  validation: [],
  formulaColumn: [],
  before: ['Set', 'SetField', 'Reject', 'Trace', 'Concurrent', 'NextNumber'],
  after: ['Set', 'Patch', 'Collect', 'Remove', 'NotifyUser', 'RunConnector', 'EnqueueJob', 'Trace', 'Concurrent', 'NextNumber'],
}

const WHY: Record<string, string> = {
  Navigate: 'changes the screen of an app', Back: 'changes the screen of an app',
  Notify: 'shows a message inside an app; in an after-event use NotifyUser(user, message)',
  Reset: 'works on controls of an app', SubmitForm: 'works on controls of an app', ResetForm: 'works on controls of an app',
  NewForm: 'works on controls of an app', EditForm: 'works on controls of an app', ViewForm: 'works on controls of an app',
  Select: 'works on controls of an app', SetFocus: 'works on controls of an app',
  Launch: "works in the user's browser", Copy: "works in the user's browser", Download: "works in the user's browser", Exit: "works in the user's browser",
  Refresh: 'reloads data inside an app (table events always read current data)',
  UpdateContext: 'sets screen variables, which exist only in apps (use Set)',
  Clear: 'would change every row of a table', ClearCollect: 'would change every row of a table',
  RemoveIf: 'reads every row of a table; Remove the rows you looked up instead', UpdateIf: 'reads every row of a table; Patch the rows you looked up instead',
}

function disallowedMessage(name: string, role: FormulaRole): string {
  if (role === 'condition' || role === 'validation' || role === 'formulaColumn') {
    const what = role === 'formulaColumn' ? 'A formula column' : role === 'validation' ? 'A validation rule' : 'A condition'
    return `${what} only calculates a value: ${name} is an action and cannot be used here.`
  }
  if (WHY[name]) return `${name} cannot be used in a table event: it ${WHY[name]}. Table events run on the server.`
  if (role === 'before' && ['Patch', 'Collect', 'Remove', 'NotifyUser', 'RunConnector', 'EnqueueJob'].includes(name)) {
    return `${name} cannot be used in an event that runs before the write: it may only change this record (SetField) or refuse the write (Reject). Use an event that runs after the write.`
  }
  if (role === 'after' && (name === 'SetField' || name === 'Reject')) {
    return `${name} works only in events that run before the write; this event runs after the change was saved.`
  }
  return `${name} cannot be used in a table event.`
}

/* ------------------------------------------------------------------ natives and engine */

export interface ServerEventHost extends FxHost {
  setField?(column: string, value: FxValue): void
  reject?(message: string, field?: string): void
  notifyUser?(to: string, message: string): void
  runConnector?(connection: string, action: string, input: FxValue): void
  enqueueJob?(type: string, payload: FxValue, delaySeconds: number): void
}
const hostOf = (h: FxHost | undefined): ServerEventHost | undefined => h as ServerEventHost | undefined

const NOTIFY_USER: FnDef = def('NotifyUser', 'NotifyUser(user, message)', 'Table events that run after a write: sends a notification to a user (email or user id).', 2, 2, (c) => {
  const h = hostOf(c.host)
  if (!h?.notifyUser) return c.fail(null, 'NotifyUser works only in table events that run after the write.', true)
  const to = c.value(0)
  h.notifyUser(isRecord(to) ? String(to.Email ?? to.Id ?? '') : c.text(0), c.text(1))
  return null
}, 'behaviour')

const RUN_CONNECTOR: FnDef = def('RunConnector', 'RunConnector(connection, action [, inputs])', 'Table events that run after a write: calls an action of a connection (recorded until connector actions arrive).', 2, 3, (c) => {
  const h = hostOf(c.host)
  if (!h?.runConnector) return c.fail(null, 'RunConnector works only in table events that run after the write.', true)
  h.runConnector(c.text(0), c.text(1), c.argc > 2 ? c.value(2) : null)
  return null
}, 'behaviour')

const ENQUEUE_JOB: FnDef = def('EnqueueJob', 'EnqueueJob(type [, payload [, delaySeconds]])', 'Table events that run after a write: puts a background job in the queue.', 1, 3, (c) => {
  const h = hostOf(c.host)
  if (!h?.enqueueJob) return c.fail(null, 'EnqueueJob works only in table events that run after the write.', true)
  h.enqueueJob(c.text(0), c.argc > 1 ? c.value(1) : null, c.argc > 2 ? c.num(2) : 0)
  return null
}, 'behaviour')

export const EVENT_NATIVES: FnDef[] = [SET_FIELD, REJECT, NOTIFY_USER, RUN_CONNECTOR, ENQUEUE_JOB]

/**
 * NextNumber in table events (core data model, P0-N): the numbers a formula names are drawn before it runs, in the
 * write's transaction (gap-free on rollback). Set by the collaboration service (collab.ts) at start.
 */
let nextNumberProvider: ((name: string) => Promise<string>) | null = null
export function setNextNumberProvider(fn: ((name: string) => Promise<string>) | null): void {
  nextNumberProvider = fn
}
/** NextNumber("name") calls with a literal name, in source order */
function nextNumberCalls(n: Node, out: string[] = []): string[] {
  if (n.t === 'call' && n.name === 'NextNumber' && n.args.length === 1 && n.args[0]!.t === 'str') out.push((n.args[0] as { value: string }).value)
  for (const c of childrenOf(n)) nextNumberCalls(c, out)
  return out
}

/** a fresh engine with the event natives (one per evaluation context: never shared across environments) */
export function eventEngine(): FxEngine {
  return createEngine({}, EVENT_NATIVES)
}

/* ------------------------------------------------------------------ values */

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** a stored cell -> the formula value (date columns at local midnight, like the client) */
export function toFx(col: ColumnDef | undefined, v: unknown): FxValue {
  if (v === null || v === undefined) return null
  if (col?.type === 'date') {
    if (v instanceof Date) return new Date(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate())
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v))
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
  }
  if (col?.type === 'datetime') {
    if (v instanceof Date) return v
    const d = new Date(String(v))
    return Number.isNaN(d.getTime()) ? null : d
  }
  if (col && ['number', 'decimal', 'currency'].includes(col.type) && typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return v as FxValue
}

/** a formula value -> what DataService coercion accepts (dates of 'date' columns as local YYYY-MM-DD) */
export function fromFx(col: ColumnDef | undefined, v: FxValue): string | number | boolean | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) {
    if (col?.type === 'date') return `${pad(v.getFullYear(), 4)}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
    return v.toISOString()
  }
  if (typeof v === 'object') {
    // a record of a lookup target: its id
    if (isRecord(v) && col?.type === 'lookup') return String(v.id ?? v.__id ?? '') || null
    throw new HttpError(422, 'invalid', `${col?.displayName ?? col?.name ?? 'A column'} cannot hold a table or a record.`, col?.name)
  }
  return v
}

export function recordOf(def: TableDef, raw: Record<string, unknown> | null): FxRecord {
  const out: FxRecord = {}
  if (!raw) return out
  for (const c of def.columns) out[c.name] = toFx(c, raw[c.name])
  for (const k of ['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner']) if (k in raw && !(k in out)) out[k] = toFx(k === 'createdOn' || k === 'modifiedOn' ? { name: k, displayName: k, type: 'datetime' } : undefined, raw[k])
  if (raw.id !== undefined && raw.id !== null) out.__id = String(raw.id)
  return out
}

/** a blank record of a table (save-time checks) */
export function blankRecord(def: TableDef): FxRecord {
  const out: FxRecord = { id: null }
  for (const c of def.columns) out[c.name] = null
  return out
}

export function schemaOf(tables: TableDef[]): SchemaInfo {
  const out: SchemaInfo = { tables: {} }
  for (const t of tables) {
    const columns: Record<string, ReturnType<typeof columnKind>> = { id: 'text', createdOn: 'datetime', modifiedOn: 'datetime', createdBy: 'text', owner: 'text' }
    const lookups: Record<string, string> = {}
    for (const c of t.columns) {
      columns[c.name] = columnKind(c.type)
      if (c.type === 'lookup' && c.lookupTable) lookups[c.name] = c.lookupTable
    }
    out.tables[t.name] = Object.keys(lookups).length ? { columns, lookups } : { columns }
  }
  return out
}

/* ------------------------------------------------------------------ static checks */

const WRITE_FNS = new Set(['Patch', 'Collect', 'Remove'])
/** FirstN(Filter(...), n) up to this many rows counts as a bounded read (tables are never fetched whole) */
const MAX_FIRSTN = 5000

/**
 * Save-time problems of a formula for a role: syntax, unknown functions and argument counts, actions the role may not
 * use, table reads that cannot be pushed down, tables named where they are not a write target.
 */
export function checkFormula(formula: string, role: FormulaRole, tables: TableDef[], self: TableDef | null, engine = eventEngine()): FormulaProblem[] {
  const src = formula.trim().startsWith('=') ? formula.trim() : `=${formula.trim()}`
  if (src === '=') return role === 'condition' ? [] : [{ message: 'The formula is empty.', start: 0, end: 0 }]
  const out: FormulaProblem[] = engine.check(src).map((d) => ({ message: d.message, start: d.start, end: d.end }))
  if (out.length) return out
  const p = parse(src)
  if (!p.ast) return out
  const allowed = new Set(ALLOWED_ACTIONS[role])
  const behaviour = new Set(engine.functions().filter((f) => f.kind === 'behaviour').map((f) => f.name))
  const visit = (n: Node): void => {
    if (n.t === 'call' && behaviour.has(n.name) && !allowed.has(n.name)) out.push({ message: disallowedMessage(n.name, role), start: n.nameStart, end: n.nameEnd })
    for (const c of childrenOf(n)) visit(c)
  }
  visit(p.ast)
  if (out.length) return out
  const tableNames = new Set(tables.map((t) => t.name))
  const scope = recordScope(self ? blankRecord(self) : {}, self ? blankRecord(self) : null, { FullName: '', Email: '', Image: '', Id: '' }, undefined, { tables: tableNames })
  const a = analyze(src, schemaOf(tables), { scope, engine, clientRowLimit: MAX_FIRSTN })
  for (const d of a.diagnostics) {
    if (d.severity !== 'error') continue
    out.push({ message: serverWording(d.message) + (d.suggestion ? ` ${d.suggestion}` : ''), start: d.start, end: d.end })
  }
  if (out.length) return out
  const residual = a.residual?.formula ?? (a.plans.length ? null : src)
  if (residual) out.push(...tableReferences(residual, tableNames, role === 'after'))
  return out
}

/** the translator speaks of "the browser"; on the server the remedy is the same, the place is not */
function serverWording(m: string): string {
  return m.replace(/ to the browser/g, ' for a table event').replace(/the browser/g, 'a table event')
}

/** a table may be named only as the target of Patch / Collect / Remove (after-events); any other bare use is a full read */
function tableReferences(formula: string, tables: ReadonlySet<string>, writes: boolean): FormulaProblem[] {
  const p = parse(formula)
  if (!p.ast) return []
  const out: FormulaProblem[] = []
  const visit = (n: Node, target: boolean): void => {
    if (n.t === 'id' && tables.has(n.name) && !target) {
      out.push({ message: `${n.name} is read as a whole here, which a table event cannot do. Read the rows you need with LookUp, Filter (with FirstN), CountRows or Sum.`, start: n.start, end: n.end })
      return
    }
    if (n.t === 'call' && WRITE_FNS.has(n.name)) {
      n.args.forEach((a, i) => visit(a, i === 0 && writes && a.t === 'id'))
      return
    }
    for (const c of childrenOf(n)) visit(c, false)
  }
  visit(p.ast, false)
  return out
}

/* ------------------------------------------------------------------ evaluation */

export interface EvalLimits {
  /** Date.now() deadline */
  deadline: number
  maxRows: number
  maxQueries: number
  rowsRead: number
  queries: number
}

export function newLimits(budgetMs: number, maxRows = 5000, maxQueries = 50): EvalLimits {
  return { deadline: Date.now() + budgetMs, maxRows, maxQueries, rowsRead: 0, queries: 0 }
}

export class BudgetError extends HttpError {
  constructor(message: string) {
    super(422, 'invalid', message)
  }
}

export function checkDeadline(l: EvalLimits, what: string): void {
  if (Date.now() > l.deadline) throw new BudgetError(`${what} took longer than its time budget and was stopped.`)
}

export interface Intent {
  op: 'patch' | 'collect' | 'remove'
  table: string
  rowId?: string
  values?: FxRecord
}

export interface EvalOutcome {
  ok: boolean
  value: FxValue
  error?: string
  rejected?: { message: string; field?: string }
  /** SetField calls in order (column -> value) */
  sets: Map<string, FxValue>
  intents: Intent[]
  notifications: { to: string; message: string }[]
  connectorCalls: { connection: string; action: string; input: FxValue }[]
  jobs: { type: string; payload: FxValue; delaySeconds: number }[]
  traces: string[]
}

export interface EvalInput {
  formula: string
  role: FormulaRole
  /** the record being written (SetField changes it in place) */
  record: FxRecord
  old: FxRecord | null
  user: FxRecord
  tables: TableDef[]
  /** whose permissions table reads use (null: the system) */
  readAs: UserContext | null
  data: DataService
  limits: EvalLimits
  engine?: FxEngine
}

/** analyse, run the reads, evaluate; never writes */
export async function evaluateFormula(i: EvalInput): Promise<EvalOutcome> {
  const src = i.formula.trim().startsWith('=') ? i.formula.trim() : `=${i.formula.trim()}`
  const out: EvalOutcome = { ok: true, value: null, sets: new Map(), intents: [], notifications: [], connectorCalls: [], jobs: [], traces: [] }
  if (src === '=') return out
  const engine = i.engine ?? eventEngine()
  const byName = new Map(i.tables.map((t) => [t.name, t]))
  const tableNames = new Set(byName.keys())
  // tables answer [] so Patch / Collect / Remove can name them; reading one as a whole is refused before evaluation
  const tablesScope: FxScope = { resolve: (n) => (tableNames.has(n) ? [] : undefined) }
  const scope0 = recordScope(i.record, i.old, i.user, undefined, { tables: tableNames })
  checkDeadline(i.limits, 'The event')
  const a = analyze(src, schemaOf(i.tables), { scope: scope0, engine, clientRowLimit: MAX_FIRSTN })
  const err = a.diagnostics.find((d) => d.severity === 'error')
  if (err) return { ...out, ok: false, error: serverWording(err.message) }
  const bindings: Record<string, FxValue> = {}
  for (const qp of a.plans) {
    checkDeadline(i.limits, 'The event')
    if (++i.limits.queries > i.limits.maxQueries) return { ...out, ok: false, error: `The event reads tables more than ${i.limits.maxQueries} times; simplify it.` }
    const t = byName.get(qp.plan.table)
    if (!t) return { ...out, ok: false, error: `Table ${qp.plan.table} was not found.` }
    const res = await i.data.queryV2(i.readAs, t, qp.plan)
    const cols = new Map(t.columns.map((c) => [c.name, c]))
    const rows = res.rows.map((r) => {
      const rec: FxRecord = {}
      for (const [k, v] of Object.entries(r)) rec[k] = toFx(cols.get(k) ?? (k === 'createdOn' || k === 'modifiedOn' ? { name: k, displayName: k, type: 'datetime' } : undefined), v)
      if (r.id !== undefined && r.id !== null) rec.__id = String(r.id)
      return rec
    })
    i.limits.rowsRead += rows.length
    if (i.limits.rowsRead > i.limits.maxRows) return { ...out, ok: false, error: `The event read more than ${i.limits.maxRows} rows; read fewer (FirstN, a narrower Filter).` }
    bindings[qp.id] = bindResult(qp, { rows, count: res.count })
  }
  checkDeadline(i.limits, 'The event')
  if (!a.residual && a.plans.length === 1) return { ...out, value: bindings[a.plans[0].id] ?? null }
  const formula = a.residual?.formula ?? src
  const refs = tableReferences(formula, tableNames, i.role === 'after')
  if (refs.length) return { ...out, ok: false, error: refs[0].message }
  const scope = recordScope(i.record, i.old, i.user, residualScope(bindings, tablesScope), { tables: tableNames })
  const allowed = new Set(ALLOWED_ACTIONS[i.role])
  const refuse = (name: string): never => {
    throw new Error(disallowedMessage(name, i.role))
  }
  const host: ServerEventHost = {
    setVar: () => {},
    updateContext: () => refuse('UpdateContext'),
    collect(coll, items, clearFirst) {
      if (clearFirst) refuse('ClearCollect')
      if (!allowed.has('Collect')) refuse('Collect')
      if (!byName.has(coll)) throw new Error(`Collect needs a table of this environment; "${coll}" is not one.`)
      for (const it of items) out.intents.push({ op: 'collect', table: coll, values: it })
    },
    clear: () => refuse('Clear'),
    remove(coll, records) {
      if (!allowed.has('Remove')) refuse('Remove')
      if (!byName.has(coll)) throw new Error(`Remove needs a table of this environment; "${coll}" is not one.`)
      for (const r of records) {
        const id = r.__id ?? r.id
        if (typeof id !== 'string' || !id) throw new Error('Remove needs rows read from the table (with LookUp or Filter).')
        out.intents.push({ op: 'remove', table: coll, rowId: id })
      }
    },
    patch(coll, base, changes) {
      if (!allowed.has('Patch')) refuse('Patch')
      if (!byName.has(coll)) throw new Error(`Patch needs a table of this environment; "${coll}" is not one.`)
      const id = base.__id ?? base.id
      if (typeof id === 'string' && id) out.intents.push({ op: 'patch', table: coll, rowId: id, values: changes })
      else out.intents.push({ op: 'collect', table: coll, values: { ...base, ...changes } })
      return { ...base, ...changes }
    },
    navigate: () => refuse('Navigate'),
    back: () => refuse('Back'),
    notify: () => refuse('Notify'),
    reset: () => refuse('Reset'),
    form: (action) => refuse(action === 'submit' ? 'SubmitForm' : action === 'reset' ? 'ResetForm' : action === 'new' ? 'NewForm' : action === 'edit' ? 'EditForm' : 'ViewForm'),
    select: () => refuse('Select'),
    setFocus: () => refuse('SetFocus'),
    launch: () => refuse('Launch'),
    copy: () => refuse('Copy'),
    trace: (m) => { if (out.traces.length < 100) out.traces.push(String(m).slice(0, 1000)) },
    exit: () => refuse('Exit'),
    refresh: () => refuse('Refresh'),
  }
  if (allowed.has('SetField')) {
    host.setField = (column, value) => {
      const t = i.record
      out.sets.set(column, value)
      t[column] = value
    }
  }
  if (allowed.has('Reject')) host.reject = (message, field) => { out.rejected = { message, ...(field ? { field } : {}) } }
  if (allowed.has('NotifyUser')) host.notifyUser = (to, message) => { out.notifications.push({ to, message }) }
  if (allowed.has('RunConnector')) host.runConnector = (connection, action, input) => { out.connectorCalls.push({ connection, action, input }) }
  if (allowed.has('EnqueueJob')) host.enqueueJob = (type, payload, delaySeconds) => { out.jobs.push({ type, payload, delaySeconds }) }
  if (allowed.has('NextNumber')) {
    // the sequences a formula draws from are allocated now (inside the write's transaction), one per call written
    const p = parse(formula)
    const names = p.ast ? nextNumberCalls(p.ast) : []
    const drawn = new Map<string, string[]>()
    if (names.length && !nextNumberProvider) return { ...out, ok: false, error: 'NextNumber is not available here.' }
    for (const n of names) (drawn.get(n) ?? drawn.set(n, []).get(n)!).push(await nextNumberProvider!(n))
    host.collab = (action, args) => {
      if (action !== 'nextNumber') return refuse(action)
      const v = drawn.get(String(args.name ?? ''))?.shift()
      if (v === undefined) throw new Error('NextNumber needs the sequence name as text written in the formula, like NextNumber("Invoices").')
      return v
    }
  }
  const pure = allowed.size === 0
  const r = engine.evaluate(formula, scope, pure ? undefined : host)
  checkDeadline(i.limits, 'The event')
  if (out.rejected) return { ...out, ok: false }
  if (!r.ok) return { ...out, ok: false, error: r.error.message }
  return { ...out, value: r.value }
}
