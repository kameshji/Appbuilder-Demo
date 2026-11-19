/**
 * Table events (docs/dev/events-and-jobs.md): validation rules, before-events and after-events of a table, and the two
 * built-in uses of the same mechanism, formula columns and rollup columns. The single replacement for business rules
 * and plug-ins.
 *
 *  - definitions: ab_table_events (per environment), cached per environment with the table definitions;
 *  - before (beforeWrite, called by the DataService inside the write's transaction): phase 1 the table's before-events
 *    in order (SetField / Reject, read-only lookups as the caller or the system), phase 2 the formula columns whose
 *    inputs changed (dependency order), phase 3 the validation rules in order. A rejection is a 422 bound to a field;
 *    the time budget covers all phases of one row;
 *  - after (dispatch, called by the outbox dispatcher inside its transaction): every committed change becomes one job
 *    per matching after-event (idempotency key event + outbox row + row id; at least once) and, for the rollups that
 *    read the changed table, a recompute job for the parent rows concerned;
 *  - recursion guard: changes made by an after-event carry the event chain; an event is not run again for a row it
 *    already changed on that chain, and nothing runs deeper than maxDepth;
 *  - every run that does something, every rejection and every failure goes to the run log (ab_event_runs), written
 *    after the transaction ends so a rejection that rolled the write back is still recorded.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { HttpError } from './contracts.ts'
import type { DataService, MetaStore, RawRow, SqlDb, UserContext } from './contracts.ts'
import type { ColumnDef, TableDef, UserDef } from '../../src/platform/contracts.ts'
import type { QueryValue } from '../../src/platform/http.ts'
import type { FxRecord, FxValue } from '../../src/contracts.ts'
import type {
  ComputedColumn, EventRunEntry, EventRunStatus, EventTestResult, FormulaProblem, RollupFn, TableEventDef, TableEventInput,
  TableEventOperation, TableEventTiming,
} from '../../src/platform/events.ts'
import { formulaColumnOrder, formulaInputs, userRecord } from '../../src/fx/rowrules.ts'
import { checkFormula, eventEngine, evaluateFormula, fromFx, newLimits, recordOf, type EvalLimits, type FormulaRole, BudgetError } from './event-fx.ts'
import { coerceIn } from './values.ts'
import { currentEnvironment } from './env-context.ts'
import { currentWork, runWithWork } from './work-context.ts'
import type { JobQueue } from './jobs.ts'
import { JobError } from './jobs.ts'
import type { Outbox, OutboxEvent, OutboxEntry } from './outbox.ts'
import { snapshot } from './outbox.ts'
import { DEFAULT_CONNECTION_ID } from './connections.ts'
import { hasRecycleBin, liveRowsSql, physicalName, quoteId } from '../connectors/postgres/sql.ts'
import { errText, rowUid } from './util.ts'

/* ------------------------------------------------------------------ settings */

const envMs = (v: string | undefined, d: number): number => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 10 ? n : d
}
/** time budget of all before-phases of one row (APPBUILDER_EVENT_BUDGET_MS, default 2 s; read on every write) */
export const beforeBudgetMs = (): number => envMs(process.env.APPBUILDER_EVENT_BUDGET_MS, 2000)
/** time budget of one after-event run (APPBUILDER_AFTER_EVENT_BUDGET_MS, default 30 s) */
export const afterBudgetMs = (): number => envMs(process.env.APPBUILDER_AFTER_EVENT_BUDGET_MS, 30_000)
export const MAX_EVENT_DEPTH = Math.max(1, Math.min(32, Number(process.env.APPBUILDER_EVENT_MAX_DEPTH) || 8))
export const MAX_ROWS_READ = 5000
export const MAX_EVENTS_PER_TABLE = 50
/** an import or bulk delete runs after-events for at most this many rows (the rest are logged as skipped) */
export const AFTER_FANOUT_CAP = 1000
export const EVENT_JOB = 'table-event.after'
export const ROLLUP_RECOMPUTE_JOB = 'rollup.recompute'
export const ROLLUP_RECONCILE_JOB = 'rollup.reconcile'
export const FORMULA_BACKFILL_JOB = 'formula.backfill'

const ROLLUP_FNS: RollupFn[] = ['count', 'sum', 'min', 'max']
const FORMULA_TYPES = ['text', 'number', 'decimal', 'currency', 'boolean', 'date', 'datetime']
const NUMERIC = ['number', 'decimal', 'currency']

/* ------------------------------------------------------------------ types */

type FormulaSpec = Extract<ComputedColumn, { kind: 'formula' }>
type RollupSpec = Extract<ComputedColumn, { kind: 'rollup' }>

interface TableRules {
  before: TableEventDef[]
  validations: TableEventDef[]
  after: TableEventDef[]
  formulas: { col: ColumnDef; formula: string; inputs: Set<string> }[]
  rollupCols: ColumnDef[]
  /** rollups of other tables that read this table */
  childRollups: { parent: TableDef; col: ColumnDef; spec: RollupSpec }[]
}

interface EnvRules {
  tables: TableDef[]
  byId: Map<string, TableDef>
  byName: Map<string, TableDef>
  events: TableEventDef[]
  perTable: Map<string, TableRules>
}

interface RunLogEntry {
  eventId: string | null
  eventName: string
  tableId: string
  rowId: string | null
  timing: TableEventTiming
  op: TableEventOperation
  status: EventRunStatus
  durationMs: number
  message?: string
  details?: unknown
  jobId?: string
}

export interface NotificationSink {
  /** placeholder until notifications arrive: the default records the request in the run log only */
  send(n: { environmentId: string; to: string; message: string; tableId: string; rowId: string | null; eventId: string; idempotencyKey: string }): Promise<void>
}
export interface ConnectorActionSink {
  /** placeholder until action connectors arrive: the default records the call in the run log only */
  invoke(c: { environmentId: string; connection: string; action: string; input: unknown; runAs: UserContext | null; idempotencyKey: string; /** P1-D */ attached?: string[]; eventId?: string; correlationId?: string }): Promise<unknown>
}

export interface EventsDeps {
  db(): SqlDb | null
  meta(): MetaStore
  data(): DataService & { internals: { connectorFor(t: TableDef): Promise<import('./contracts.ts').Connector>; physical(t: TableDef): TableDef } }
  forUser(user: UserDef): Promise<UserContext>
  jobs: JobQueue
  outbox: Outbox
  log(level: 'info' | 'warn' | 'error', msg: string): void
}

/* ------------------------------------------------------------------ helpers */

type Row = Record<string, unknown>
const q = (id: string): string => `"${id}"`
const T = (t: string): string => `${q(currentEnvironment().schema)}.${q(t)}`
const invalid = (message: string, field?: string) => new HttpError(422, 'invalid', message, field)
const isDefaultTable = (t: TableDef): boolean => (t.connectionId ?? DEFAULT_CONNECTION_ID) === DEFAULT_CONNECTION_ID
const truthy = (v: FxValue): boolean => v === true
const OPS_OF: Record<string, TableEventOperation> = { insert: 'create', update: 'update', delete: 'delete' }

/** "schema"."table" of a default-connection table */
function sqlTable(def: TableDef): string {
  return `${q(currentEnvironment().schema)}.${quoteId(physicalName(def))}`
}

/** a stable UUID from text (idempotent inserts of after-events: the same job attempt inserts the same row id) */
export function stableUuid(text: string): string {
  const h = createHash('sha256').update(text).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

function cleanText(v: unknown, max: number): string | undefined {
  if (v === undefined || v === null) return undefined
  const s = String(v).trim()
  return s ? s.slice(0, max) : undefined
}

/* ------------------------------------------------------------------ computed column checks (also used by the table routes) */

export function computedProblems(def: TableDef, col: ColumnDef, tables: TableDef[]): string | null {
  const c = col.computed
  if (!c) return null
  if (col.required || col.unique || col.default !== undefined) return `${col.displayName} is calculated: it cannot be required, unique or have a default value.`
  if (c.kind === 'formula') {
    if (!FORMULA_TYPES.includes(col.type)) return `A formula column must be text, a number, currency, yes/no, a date or a date and time (not ${col.type}).`
    if (typeof c.formula !== 'string' || !c.formula.trim()) return 'A formula column needs a formula.'
    const problems = checkFormula(c.formula, 'formulaColumn', tables, def)
    if (problems.length) return `${col.displayName}: ${problems[0].message}`
    const cols = def.columns.filter((x) => x.computed?.kind === 'formula').map((x) => ({ name: x.name, formula: (x.computed as FormulaSpec).formula }))
    if (!cols.some((x) => x.name === col.name)) cols.push({ name: col.name, formula: c.formula })
    const order = formulaColumnOrder(cols, def.columns.map((x) => x.name))
    if (order.cycle) return `The formula columns ${order.cycle.join(' -> ')} depend on each other in a circle.`
    return null
  }
  if (c.kind === 'rollup') {
    if (!isDefaultTable(def)) return 'Rollup columns need the table to be stored in the default database.'
    const child = tables.find((t) => t.name.toLowerCase() === String(c.table).toLowerCase() || t.id === c.table)
    if (!child) return `There is no table "${c.table}" to roll up.`
    if (!isDefaultTable(child)) return `"${child.displayName}" is not stored in the default database; rollups read it with SQL.`
    const via = child.columns.find((x) => x.name === c.via)
    if (!via || via.type !== 'lookup' || !via.lookupTable || (via.lookupTable.toLowerCase() !== def.name.toLowerCase() && via.lookupTable !== def.id)) {
      return `"${c.via}" must be a lookup column of "${child.displayName}" that points at "${def.displayName}".`
    }
    if (!ROLLUP_FNS.includes(c.fn)) return 'A rollup is a count, sum, min or max.'
    if (c.fn === 'count') {
      if (!NUMERIC.includes(col.type)) return 'A count rollup must be a number column.'
      return null
    }
    const src = child.columns.find((x) => x.name === c.column)
    if (!src) return `Choose the column of "${child.displayName}" to ${c.fn}.`
    if (c.fn === 'sum' && !NUMERIC.includes(src.type)) return `Only numbers can be summed ("${src.displayName}" is ${src.type}).`
    if (!NUMERIC.includes(src.type) && src.type !== 'date' && src.type !== 'datetime') return `min and max work on numbers and dates ("${src.displayName}" is ${src.type}).`
    const want = NUMERIC.includes(src.type) ? NUMERIC : [src.type]
    if (!want.includes(col.type)) return `The rollup column must have the type of "${src.displayName}" (${src.type}).`
    return null
  }
  return 'Unknown kind of calculated column.'
}

/** the shape of ColumnDef.computed from a request (types and lengths only; computedProblems checks the meaning) */
export function normalizeComputed(raw: unknown): ComputedColumn | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('computed must be an object.', 'computed')
  const o = raw as Record<string, unknown>
  if (o.kind === 'formula') {
    if (typeof o.formula !== 'string' || !o.formula.trim() || o.formula.length > 8000) throw invalid('A formula column needs a formula (at most 8,000 characters).', 'computed')
    return { kind: 'formula', formula: o.formula.trim() }
  }
  if (o.kind === 'rollup') {
    const fn = String(o.fn ?? '') as RollupFn
    if (!ROLLUP_FNS.includes(fn)) throw invalid('A rollup is a count, sum, min or max.', 'computed')
    const out: RollupSpec = { kind: 'rollup', table: String(o.table ?? '').slice(0, 64), via: String(o.via ?? '').slice(0, 64), fn }
    if (fn !== 'count') out.column = String(o.column ?? '').slice(0, 64)
    return out
  }
  throw invalid('computed.kind must be "formula" or "rollup".', 'computed')
}

/* ------------------------------------------------------------------ event definitions */

function toEventDef(r: Row): TableEventDef {
  const d = (r.def ?? {}) as TableEventDef
  return { ...d, id: String(r.id), tableId: String(r.table_id), timing: String(r.timing) as TableEventTiming, order: Number(r.order_no) || 0, enabled: r.enabled === true }
}

/** validate and complete an event definition (formulas checked against the server engine) */
export function normalizeEvent(input: TableEventInput, base: TableEventDef | null, table: TableDef, tables: TableDef[]): { def: Omit<TableEventDef, 'id' | 'tableId' | 'createdOn' | 'modifiedOn'>; problems: (FormulaProblem & { field: string })[] } {
  const kind = input.kind ?? base?.kind ?? 'event'
  if (kind !== 'validation' && kind !== 'event') throw invalid('kind must be "validation" or "event".', 'kind')
  const name = cleanText(input.name ?? base?.name, 200)
  if (!name) throw invalid(kind === 'validation' ? 'A validation rule needs a name.' : 'An event needs a name.', 'name')
  const timing: TableEventTiming = kind === 'validation' ? 'before' : (input.timing ?? base?.timing ?? 'before')
  if (timing !== 'before' && timing !== 'after') throw invalid('timing must be "before" or "after".', 'timing')
  const opsIn = input.operations ?? base?.operations ?? (kind === 'validation' ? ['create', 'update'] : ['create', 'update'])
  if (!Array.isArray(opsIn) || !opsIn.length || !opsIn.every((o) => o === 'create' || o === 'update' || o === 'delete' || o === 'restore')) throw invalid('operations must list create, update, delete and/or restore.', 'operations')
  const operations = [...new Set(opsIn)] as TableEventOperation[]
  // restore (recycle bin): rows come back as they were, nothing to check or refuse before; after-events only
  if (operations.includes('restore') && (kind !== 'event' || timing !== 'after')) throw invalid('Restore (rows coming back from the recycle bin) can only start an after-event.', 'operations')
  if (kind === 'validation' && operations.includes('delete')) throw invalid('Validation rules check the record being saved; use an event with Reject to refuse deletes.', 'operations')
  const order = Number(input.order ?? base?.order ?? 100)
  if (!Number.isInteger(order) || order < -100000 || order > 100000) throw invalid('order must be a whole number.', 'order')
  const runAs = input.runAs ?? base?.runAs ?? 'caller'
  if (runAs !== 'caller' && runAs !== 'system') throw invalid('runAs must be "caller" or "system".', 'runAs')
  // P1-D: connections attached for RunConnector (after-events only; external calls never run inside the write)
  const connections = [...new Set(input.connections ?? base?.connections ?? [])].filter((c) => typeof c === 'string' && c).slice(0, 20)
  const condition = cleanText(input.condition !== undefined ? input.condition : base?.condition, 8000)
  const actions = cleanText(input.actions !== undefined ? input.actions : base?.actions, 16000)
  const message = cleanText(input.message !== undefined ? input.message : base?.message, 500)
  let field = cleanText(input.field !== undefined ? input.field : base?.field, 64)
  const description = cleanText(input.description !== undefined ? input.description : base?.description, 1000)
  const enabled = input.enabled ?? base?.enabled ?? true
  const problems: (FormulaProblem & { field: string })[] = []
  if (kind === 'validation') {
    if (!condition) throw invalid('A validation rule needs a condition: the formula that must be true for the record.', 'condition')
    if (!message) throw invalid('A validation rule needs the message people see when the condition is false.', 'message')
    if (field && !table.columns.some((c) => c.name === field)) throw invalid(`There is no column "${field}" in ${table.displayName}.`, 'field')
    for (const p of checkFormula(condition, 'validation', tables, table)) problems.push({ ...p, field: 'condition' })
  } else {
    field = undefined
    if (!actions) throw invalid('An event needs actions: the formula it runs.', 'actions')
    if (condition) for (const p of checkFormula(condition, 'condition', tables, table)) problems.push({ ...p, field: 'condition' })
    for (const p of checkFormula(actions, timing, tables, table)) problems.push({ ...p, field: 'actions' })
  }
  const def: Omit<TableEventDef, 'id' | 'tableId' | 'createdOn' | 'modifiedOn'> = { name, kind, timing, operations, order, enabled: enabled !== false, runAs }
  if (connections.length) {
    if (kind !== 'event' || timing !== 'after') throw invalid('Connections can only be attached to events that run after the write (external calls never run inside a save).', 'connections')
    def.connections = connections
  }
  if (condition) def.condition = condition
  if (kind === 'event' && actions) def.actions = actions
  if (kind === 'validation') {
    def.message = message
    if (field) def.field = field
  }
  if (description) def.description = description
  return { def, problems }
}

/* ------------------------------------------------------------------ the service */

export type TableEvents = ReturnType<typeof createTableEvents>

interface UnitState { runLog: RunLogEntry[] }

export function createTableEvents(deps: EventsDeps) {
  const unitStore = new AsyncLocalStorage<UnitState>()
  const cache = new Map<string, { gen: number; rules: Promise<EnvRules> }>()
  let generation = 0
  let notifications: NotificationSink = {
    async send(n) { deps.log('info', `NotifyUser (no notification module yet): to ${n.to}: ${n.message.slice(0, 200)}`) },
  }
  let connectorActions: ConnectorActionSink = {
    async invoke(c) { deps.log('info', `RunConnector (no action connectors yet): ${c.connection}.${c.action}`); return null },
  }

  const db = (): SqlDb => {
    const d = deps.db()
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }

  /* ---------------------------------------------------------------- rules cache */

  function invalidate(): void {
    generation++
    cache.clear()
  }

  async function loadRules(): Promise<EnvRules> {
    const tables = await deps.meta().tables.list()
    const events = (await db().query<Row>(`SELECT id, table_id, timing, order_no, enabled, def FROM ${T('ab_table_events')} ORDER BY table_id, order_no, id`)).map(toEventDef)
    const byId = new Map(tables.map((t) => [t.id, t]))
    const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]))
    const perTable = new Map<string, TableRules>()
    const rulesOf = (id: string): TableRules => {
      let r = perTable.get(id)
      if (!r) perTable.set(id, (r = { before: [], validations: [], after: [], formulas: [], rollupCols: [], childRollups: [] }))
      return r
    }
    for (const e of events) {
      if (!e.enabled || !byId.has(e.tableId)) continue
      const r = rulesOf(e.tableId)
      if (e.kind === 'validation') r.validations.push(e)
      else if (e.timing === 'before') r.before.push(e)
      else r.after.push(e)
    }
    for (const t of tables) {
      const names = ['id', ...t.columns.map((c) => c.name)]
      const fcols = t.columns.filter((c) => c.computed?.kind === 'formula')
      if (fcols.length) {
        const specs = fcols.map((c) => ({ name: c.name, formula: (c.computed as FormulaSpec).formula }))
        const { order } = formulaColumnOrder(specs, names)
        const r = rulesOf(t.id)
        for (const n of order) {
          const col = fcols.find((c) => c.name === n)!
          const formula = (col.computed as FormulaSpec).formula
          r.formulas.push({ col, formula, inputs: formulaInputs(formula.startsWith('=') ? formula : `=${formula}`, names) })
        }
      }
      for (const c of t.columns) {
        if (c.computed?.kind !== 'rollup') continue
        rulesOf(t.id).rollupCols.push(c)
        const child = byName.get(String(c.computed.table).toLowerCase()) ?? byId.get(c.computed.table)
        if (child) rulesOf(child.id).childRollups.push({ parent: t, col: c, spec: c.computed })
      }
    }
    return { tables, byId, byName, events, perTable }
  }

  /** the rules of the current environment (cached until a table, role or event changes) */
  async function rules(): Promise<EnvRules> {
    const envId = currentEnvironment().id
    const hit = cache.get(envId)
    if (hit && hit.gen === generation) return hit.rules
    const gen = generation
    const p = loadRules()
    cache.set(envId, { gen, rules: p })
    p.catch(() => { if (cache.get(envId)?.rules === p) cache.delete(envId) })
    return p
  }

  const EMPTY: TableRules = { before: [], validations: [], after: [], formulas: [], rollupCols: [], childRollups: [] }
  async function tableRules(def: TableDef): Promise<TableRules> {
    return (await rules()).perTable.get(def.id) ?? EMPTY
  }

  /* ---------------------------------------------------------------- run log */

  function logRun(e: RunLogEntry): void {
    const st = unitStore.getStore()
    if (st) st.runLog.push(e)
    else void flushRunLog([e])
  }

  async function flushRunLog(entries: RunLogEntry[]): Promise<void> {
    if (!entries.length || !deps.db()) return
    const w = currentWork()
    const at = new Date()
    const values: string[] = []
    const params: unknown[] = []
    for (const e of entries.slice(0, 500)) {
      const b = params.length
      values.push(`(${Array.from({ length: 13 }, (_, i) => `$${b + i + 1}`).join(', ')})`)
      params.push(at, e.eventId, e.eventName.slice(0, 200), e.tableId, e.rowId, e.timing, e.op, e.status, Math.max(0, Math.round(e.durationMs)),
        e.message ? e.message.slice(0, 2000) : null, e.details === undefined ? null : ((d) => (d.length > 60000 ? '{"truncated":true}' : d))(JSON.stringify(e.details) ?? 'null'), e.jobId ?? w.jobId ?? null, w.correlationId ?? null)
    }
    try {
      await db().exec(
        `INSERT INTO ${T('ab_event_runs')} (at, event_id, event_name, table_id, row_id, timing, op, status, duration_ms, message, details, job_id, correlation_id)
         VALUES ${values.join(', ')}`,
        params,
      )
    } catch (err) {
      deps.log('error', `event run log write failed: ${errText(err)}`)
    }
  }

  /**
   * Runs a write of `def` as one unit of work: on the default database inside a transaction (the change, its outbox
   * row and the jobs it enqueues commit together); elsewhere without one. Nested units join the outer one. The run
   * log is written when the unit ends, committed or not.
   */
  async function unit<T>(def: TableDef, fn: () => Promise<T>): Promise<T> {
    if (unitStore.getStore()) return fn()
    const st: UnitState = { runLog: [] }
    const d = deps.db()
    try {
      return await unitStore.run(st, () => (d && isDefaultTable(def) ? d.tx(() => fn()) : fn()))
    } finally {
      if (st.runLog.length) await flushRunLog(st.runLog)
    }
  }

  /** row lock for read-modify-write (formula columns, before-events): concurrent updates of a row run one after another */
  async function lockRow(def: TableDef, id: string): Promise<void> {
    if (!isDefaultTable(def) || !deps.db()) return
    const r = await tableRules(def)
    if (!r.before.length && !r.formulas.length) return
    await db().query(`SELECT 1 FROM ${sqlTable(def)} WHERE "id" = $1 FOR UPDATE`, [id])
  }

  /* ---------------------------------------------------------------- before */

  const actorRecord = (ctx: UserContext | null): FxRecord => userRecord(ctx ? { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email } : null)

  function setOf(def: TableDef, rules: TableRules, sets: Map<string, FxValue>, evName: string, allowComputed: Set<string>): RawRow {
    const out: RawRow = {}
    for (const [name, v] of sets) {
      const col = def.columns.find((c) => c.name === name) ?? def.columns.find((c) => c.name.toLowerCase() === name.toLowerCase())
      if (!col) throw invalid(`${evName}: SetField names "${name}", which is not a column of ${def.displayName}.`)
      if (col.system || ['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner'].includes(col.name)) throw invalid(`${evName}: ${col.displayName} is a system column and cannot be set.`)
      if (col.computed && !allowComputed.has(col.name)) throw invalid(`${evName}: ${col.displayName} is calculated and cannot be set.`)
      if (col.type === 'file' || col.type === 'image') throw invalid(`${evName}: attachments cannot be set by an event.`)
      try {
        out[col.name] = coerceIn(col, fromFx(col, v))
      } catch (e) {
        throw e instanceof HttpError ? invalid(`${evName}: ${e.message}`, col.name) : e
      }
    }
    void rules
    return out
  }

  /**
   * Before a write (inside its transaction): returns the columns the events and formula columns set (coerced), or
   * throws a 422 (rejection, failure, time budget). `next` is the record as it will be stored, `old` as it was.
   * `changed`: the columns the write changes (update), null for create / delete.
   */
  async function beforeWrite(ctx: UserContext | null, def: TableDef, op: TableEventOperation, next: RawRow, old: RawRow | null, changed: Set<string> | null): Promise<RawRow> {
    const r = await tableRules(def)
    const evs = r.before.filter((e) => e.operations.includes(op))
    const vals = op === 'delete' ? [] : r.validations.filter((e) => e.operations.includes(op))
    const formulas = op === 'delete' ? [] : r.formulas
    const rollupInit = op === 'create' ? r.rollupCols : []
    if (!evs.length && !vals.length && !formulas.length && !rollupInit.length) return {}
    const { tables } = await rules()
    const limits = newLimits(beforeBudgetMs(), MAX_ROWS_READ)
    const record = recordOf(def, next)
    const oldRec = old ? recordOf(def, old) : null
    const user = actorRecord(ctx)
    const rowId = next.id === undefined || next.id === null ? null : String(next.id)
    const data = deps.data()
    const engine = eventEngine()
    const sets = new Map<string, FxValue>()
    const changedNow = new Set<string>(changed ?? [])
    const base = { tableId: def.id, rowId, timing: 'before' as const, op }
    const run = async (formula: string, role: FormulaRole, readAs: UserContext | null) =>
      evaluateFormula({ formula, role, record, old: oldRec, user, tables, readAs, data, limits, engine })
    const fail = (e: unknown, ev: { id: string | null; name: string }, t0: number, field?: string): never => {
      const msg = e instanceof Error ? e.message : String(e)
      logRun({ ...base, eventId: ev.id, eventName: ev.name, status: 'failed', durationMs: Date.now() - t0, message: msg })
      if (e instanceof BudgetError) throw invalid(`The table events of ${def.displayName} took longer than ${beforeBudgetMs() / 1000} s; the change was not saved.`)
      throw invalid(`${ev.name}: ${msg}`, field)
    }
    // phase 1: before-events
    for (const ev of evs) {
      const t0 = Date.now()
      const readAs = ev.runAs === 'system' ? null : ctx
      try {
        if (ev.condition) {
          const c = await run(ev.condition, 'condition', readAs)
          if (!c.ok) fail(new Error(`condition: ${c.error}`), ev, t0)
          if (!truthy(c.value)) continue
        }
        const o = await run(ev.actions ?? '', 'before', readAs)
        if (o.rejected) {
          logRun({ ...base, eventId: ev.id, eventName: ev.name, status: 'rejected', durationMs: Date.now() - t0, message: o.rejected.message, details: o.rejected.field ? { field: o.rejected.field } : undefined })
          throw invalid(o.rejected.message, o.rejected.field ? (def.columns.find((c) => c.name.toLowerCase() === o.rejected!.field!.toLowerCase())?.name ?? o.rejected.field) : undefined)
        }
        if (!o.ok) fail(new Error(o.error ?? 'failed'), ev, t0)
        if (op === 'delete' && o.sets.size) fail(new Error('SetField has no effect when a row is deleted.'), ev, t0)
        for (const [k, v] of o.sets) {
          sets.set(k, v)
          changedNow.add(k)
        }
        logRun({ ...base, eventId: ev.id, eventName: ev.name, status: 'ok', durationMs: Date.now() - t0, details: o.sets.size || o.traces.length ? { set: Object.fromEntries([...o.sets].map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])), ...(o.traces.length ? { traces: o.traces } : {}) } : undefined })
      } catch (e) {
        if (e instanceof HttpError) throw e
        fail(e, ev, t0)
      }
    }
    const computedSet = new Set<string>()
    // phase 2: formula columns whose inputs changed (all of them on create)
    for (const f of formulas) {
      if (op !== 'create' && ![...f.inputs].some((n) => changedNow.has(n))) continue
      const t0 = Date.now()
      let value: FxValue = null
      try {
        const o = await run(f.formula, 'formulaColumn', null)
        if (o.ok) value = o.value
        else logRun({ ...base, eventId: null, eventName: `Formula column ${f.col.displayName}`, status: 'failed', durationMs: Date.now() - t0, message: `${o.error ?? 'failed'} (stored blank)` })
      } catch (e) {
        if (e instanceof BudgetError) fail(e, { id: null, name: `Formula column ${f.col.displayName}` }, t0)
        logRun({ ...base, eventId: null, eventName: `Formula column ${f.col.displayName}`, status: 'failed', durationMs: Date.now() - t0, message: `${errText(e)} (stored blank)` })
      }
      if (Array.isArray(value) || (value !== null && typeof value === 'object' && !(value instanceof Date))) {
        logRun({ ...base, eventId: null, eventName: `Formula column ${f.col.displayName}`, status: 'failed', durationMs: Date.now() - t0, message: 'The formula gives a table or a record; a column holds one value (stored blank).' })
        value = null
      }
      record[f.col.name] = value
      sets.set(f.col.name, value)
      computedSet.add(f.col.name)
      changedNow.add(f.col.name)
    }
    for (const c of rollupInit) {
      const spec = c.computed as RollupSpec
      sets.set(c.name, spec.fn === 'count' || spec.fn === 'sum' ? 0 : null)
      computedSet.add(c.name)
    }
    // phase 3: validation rules
    for (const v of vals) {
      const t0 = Date.now()
      let o
      try {
        o = await run(v.condition ?? '', 'validation', v.runAs === 'system' ? null : ctx)
      } catch (e) {
        fail(e, v, t0)
      }
      if (!o!.ok) fail(new Error(`the rule could not be checked: ${o!.error}`), v, t0)
      if (!truthy(o!.value)) {
        const field = v.field ? (def.columns.find((c) => c.name === v.field)?.name ?? v.field) : undefined
        logRun({ ...base, eventId: v.id, eventName: v.name, status: 'rejected', durationMs: Date.now() - t0, message: v.message, details: field ? { field } : undefined })
        throw invalid(v.message ?? 'This record does not pass a validation rule.', field)
      }
    }
    return setOf(def, r, sets, 'A table event', computedSet)
  }

  /* ---------------------------------------------------------------- outbox (write side) */

  async function recordChange(ctx: UserContext | null, def: TableDef, e: Omit<OutboxEntry, 'tableId' | 'actorId'> & { truncated?: boolean }): Promise<void> {
    const { truncated, ...rest } = e
    await deps.outbox.write({ ...rest, tableId: def.id, actorId: ctx?.user.id ?? null }, truncated)
  }

  /* ---------------------------------------------------------------- dispatch (after) */

  /** inside the dispatcher's transaction: committed changes -> after-event jobs and rollup jobs */
  async function dispatch(events: OutboxEvent[]): Promise<void> {
    const all = await rules()
    for (const ev of events) {
      const r = all.perTable.get(ev.tableId)
      if (!r) continue
      try {
        await dispatchOne(ev, r, all)
      } catch (e) {
        deps.log('error', `outbox ${ev.id}: dispatch failed: ${errText(e)}`)
        logRun({ eventId: null, eventName: 'Dispatcher', tableId: ev.tableId, rowId: ev.rowId, timing: 'after', op: OPS_OF[ev.op] ?? 'update', status: 'failed', durationMs: 0, message: errText(e) })
      }
    }
  }

  function rowsOf(ev: OutboxEvent): { op: TableEventOperation; rowId: string }[] {
    if (ev.op === 'insert' || ev.op === 'update' || ev.op === 'delete') return ev.rowId ? [{ op: OPS_OF[ev.op], rowId: ev.rowId }] : []
    const ids = ev.rowIds ?? []
    const action = (ev.details as { action?: string } | null)?.action
    const op: TableEventOperation = ev.op === 'import' ? 'create' : action === 'update' ? 'update' : action === 'restore' ? 'restore' : 'delete'
    return ids.map((rowId) => ({ op, rowId }))
  }

  async function dispatchOne(ev: OutboxEvent, r: TableRules, all: EnvRules): Promise<void> {
    // after-events
    if (r.after.length) {
      const rows = rowsOf(ev)
      for (const e of r.after) {
        const targets = rows.filter((x) => e.operations.includes(x.op))
        if (!targets.length) continue
        if (ev.depth >= MAX_EVENT_DEPTH) {
          logRun({ eventId: e.id, eventName: e.name, tableId: ev.tableId, rowId: targets[0].rowId, timing: 'after', op: targets[0].op, status: 'skipped', durationMs: 0, message: `Not run: the change was made ${ev.depth} events deep (limit ${MAX_EVENT_DEPTH}); events that trigger each other stop here.` })
          continue
        }
        if (ev.op === 'import' && ev.rowCount > (ev.rowIds?.length ?? 0)) {
          logRun({ eventId: e.id, eventName: e.name, tableId: ev.tableId, rowId: null, timing: 'after', op: 'create', status: 'skipped', durationMs: 0, message: `The import added ${ev.rowCount} rows; the event runs for the first ${ev.rowIds?.length ?? 0}.` })
        }
        for (const t of targets.slice(0, AFTER_FANOUT_CAP)) {
          const link = `${e.id}:${t.rowId}`
          if (ev.chain.includes(link)) {
            logRun({ eventId: e.id, eventName: e.name, tableId: ev.tableId, rowId: t.rowId, timing: 'after', op: t.op, status: 'skipped', durationMs: 0, message: 'Not run again: this event already changed this row earlier on the same chain (loop guard).' })
            continue
          }
          const runAs = e.runAs === 'system' || !ev.actorId ? 'system' as const : { userId: ev.actorId }
          await deps.jobs.enqueue(EVENT_JOB, {
            eventId: e.id, outboxId: ev.id, tableId: ev.tableId, rowId: t.rowId, op: t.op,
            before: ev.rowId === t.rowId ? ev.before : null, after: ev.rowId === t.rowId ? ev.after : null, changed: ev.changed,
            actorId: ev.actorId, depth: ev.depth + 1, chain: [...ev.chain, link].slice(-32),
          }, { idempotencyKey: `evt:${e.id}:${ev.id}:${t.rowId}`, runAs, correlationId: ev.correlationId ?? undefined })
        }
      }
    }
    // rollups that read this table
    for (const ru of r.childRollups) {
      if (ev.depth >= MAX_EVENT_DEPTH + 4) continue
      const key = `${ev.id}:${ru.parent.id}:${ru.col.name}`
      if (ev.op === 'bulk' || ev.op === 'import' || ev.truncated) {
        await deps.jobs.enqueue(ROLLUP_RECONCILE_JOB, { tableId: ru.parent.id, column: ru.col.name }, { idempotencyKey: `rollupall:${key}`, correlationId: ev.correlationId ?? undefined })
        continue
      }
      const ids = new Set<string>()
      for (const snap of [ev.before, ev.after]) {
        const v = snap?.[ru.spec.via]
        if (typeof v === 'string' && v) ids.add(v)
      }
      // an update that changed neither the link nor the rolled-up column does not move the total
      if (ev.op === 'update' && ev.changed && !ev.changed.includes(ru.spec.via) && !(ru.spec.column && ev.changed.includes(ru.spec.column))) continue
      if (!ids.size) continue
      await deps.jobs.enqueue(ROLLUP_RECOMPUTE_JOB, { tableId: ru.parent.id, column: ru.col.name, ids: [...ids], depth: ev.depth + 1 }, { idempotencyKey: `rollup:${key}`, correlationId: ev.correlationId ?? undefined })
    }
    void all
  }

  /* ---------------------------------------------------------------- after-event job */

  interface AfterPayload {
    eventId: string; outboxId: number; tableId: string; rowId: string; op: TableEventOperation
    before: Record<string, unknown> | null; after: Record<string, unknown> | null; changed: string[] | null
    actorId: string | null; depth: number; chain: string[]
  }

  async function runAfterEvent(p: AfterPayload, job: { id: string; attempts: number }, identity: UserContext | null): Promise<unknown> {
    const all = await rules()
    const evRow = (await db().query<Row>(`SELECT id, table_id, timing, order_no, enabled, def FROM ${T('ab_table_events')} WHERE id = $1`, [p.eventId]))[0]
    const ev = evRow ? toEventDef(evRow) : null
    if (!ev || !ev.enabled) return { skipped: 'The event was deleted or disabled before it ran.' }
    const def = all.byId.get(p.tableId)
    if (!def) return { skipped: 'The table no longer exists.' }
    const t0 = Date.now()
    const base = { eventId: ev.id, eventName: ev.name, tableId: def.id, rowId: p.rowId, timing: 'after' as const, op: p.op, jobId: job.id }
    const data = deps.data()
    // the row as it is now (after-events see current data); a deleted row: its last snapshot
    let current: RawRow | null = null
    if (p.op !== 'delete') current = await data.internals.connectorFor(def).then((c) => c.select(data.internals.physical(def), { where: { col: 'id', op: 'eq', value: p.rowId }, top: 1 })).then((r) => r.rows[0] ?? null)
    if (!current && p.op !== 'delete') {
      logRun({ ...base, status: 'skipped', durationMs: Date.now() - t0, message: 'The row was deleted before the event ran.' })
      return { skipped: 'row deleted' }
    }
    const recordRaw = (current ?? p.before ?? { id: p.rowId }) as Record<string, unknown>
    const record = recordOf(def, recordRaw)
    const oldRec = p.op === 'create' || p.op === 'restore' ? null : recordOf(def, { ...recordRaw, ...(p.before ?? {}) })
    const actor = p.actorId ? await deps.meta().users.get(p.actorId) : null
    const user = userRecord(actor ? { id: actor.id, name: actor.name, email: actor.email } : null)
    const limits: EvalLimits = newLimits(afterBudgetMs(), MAX_ROWS_READ)
    const engine = eventEngine()
    const run = (formula: string, role: FormulaRole) => evaluateFormula({ formula, role, record, old: oldRec, user, tables: all.tables, readAs: identity, data, limits, engine })
    try {
      if (ev.condition) {
        const c = await run(ev.condition, 'condition')
        if (!c.ok) throw new JobError(`condition: ${c.error}`, { retry: false })
        if (!truthy(c.value)) return { skipped: 'condition false' }
      }
      const o = await run(ev.actions ?? '', 'after')
      if (!o.ok) throw new JobError(o.error ?? 'failed', { retry: false })
      const writes = await applyIntents(o, def, all, identity, job.id)
      for (const [i, n] of o.notifications.entries()) {
        await notifications.send({ environmentId: currentEnvironment().id, to: n.to, message: n.message, tableId: def.id, rowId: p.rowId, eventId: ev.id, idempotencyKey: `${job.id}:n${i}` })
      }
      for (const [i, c] of o.connectorCalls.entries()) {
        await connectorActions.invoke({ environmentId: currentEnvironment().id, connection: c.connection, action: c.action, input: c.input, runAs: identity, idempotencyKey: `${job.id}:c${i}`, attached: ev.connections ?? [], eventId: ev.id })
      }
      for (const [i, j] of o.jobs.entries()) {
        const jt = deps.jobs.typeDef(j.type)
        if (!jt || !jt.eventAllowed) throw new JobError(`EnqueueJob: "${j.type}" is not a job type events may start.`, { retry: false })
        await deps.jobs.enqueue(j.type, j.payload, { delayMs: Math.max(0, j.delaySeconds) * 1000, idempotencyKey: `${job.id}:j${i}`, runAs: identity ? { userId: identity.user.id } : 'system' })
      }
      const details = { writes, ...(o.notifications.length ? { notifications: o.notifications } : {}), ...(o.connectorCalls.length ? { connectorCalls: o.connectorCalls.map((c) => ({ connection: c.connection, action: c.action })) } : {}), ...(o.jobs.length ? { jobs: o.jobs.map((j) => j.type) } : {}), ...(o.traces.length ? { traces: o.traces } : {}) }
      logRun({ ...base, status: 'ok', durationMs: Date.now() - t0, details })
      return details
    } catch (e) {
      logRun({ ...base, status: 'failed', durationMs: Date.now() - t0, message: `${e instanceof Error ? e.message : String(e)}${job.attempts > 1 ? ` (attempt ${job.attempts})` : ''}` })
      if (e instanceof BudgetError) throw new JobError(e.message, { retry: false })
      throw e
    }
  }

  /** writes of an after-event, all in one transaction, through the DataService as the event's identity; idempotent */
  async function applyIntents(o: Awaited<ReturnType<typeof evaluateFormula>>, def: TableDef, all: EnvRules, identity: UserContext | null, jobId: string): Promise<unknown[]> {
    if (!o.intents.length) return []
    const data = deps.data()
    const done: unknown[] = []
    const write = async () => {
      for (const [i, it] of o.intents.entries()) {
        const t = all.byName.get(it.table.toLowerCase())
        if (!t) throw new JobError(`Table ${it.table} was not found.`, { retry: false })
        const cols = new Map(t.columns.map((c) => [c.name, c]))
        const values: Record<string, QueryValue> = {}
        for (const [k, v] of Object.entries(it.values ?? {})) {
          if (k === '__id' || k === 'id' || k === 'createdOn' || k === 'modifiedOn' || k === 'createdBy' || k === 'owner') continue
          const col = cols.get(k)
          if (!col) throw new JobError(`${it.op === 'patch' ? 'Patch' : 'Collect'}: ${t.displayName} has no column "${k}".`, { retry: false })
          if (col.computed) continue
          values[k] = fromFx(col, v as FxValue)
        }
        if (it.op === 'collect') {
          const id = stableUuid(`${jobId}:${i}`)
          const exists = await data.internals.connectorFor(t).then((c) => c.select(data.internals.physical(t), { where: { col: 'id', op: 'eq', value: id }, top: 1, select: ['id'] }))
          if (exists.rows.length) { done.push({ op: 'collect', table: t.name, rowId: id, already: true }); continue }
          const row = await data.insert(identity, t, { ...values, id })
          done.push({ op: 'collect', table: t.name, rowId: row.id })
        } else if (it.op === 'patch') {
          await data.update(identity, t, it.rowId!, values)
          done.push({ op: 'patch', table: t.name, rowId: it.rowId, columns: Object.keys(values) })
        } else {
          try {
            await data.delete(identity, t, [it.rowId!])
          } catch (e) {
            if (!(e instanceof HttpError && e.status === 404)) throw e
          }
          done.push({ op: 'remove', table: t.name, rowId: it.rowId })
        }
      }
    }
    // one unit of work: all writes or none (a retry starts from a clean state)
    await unit(def, write)
    return done
  }

  /* ---------------------------------------------------------------- system recompute (rollups, backfill) */

  /**
   * Recomputes formula columns of rows (all of them when `changed` is null, else those reading a changed column) and
   * stores what differs, as the system, in the current unit of work; writes outbox rows for the changed rows.
   */
  async function recomputeFormulas(def: TableDef, ids: string[], changed: Set<string> | null, only?: string): Promise<number> {
    const r = await tableRules(def)
    const fs = r.formulas.filter((f) => (!only || f.col.name === only || !changed) && (!changed || [...f.inputs].some((n) => changed.has(n))))
    if (!fs.length || !ids.length) return 0
    const { tables } = await rules()
    const data = deps.data()
    const connector = await data.internals.connectorFor(def)
    const phys = data.internals.physical(def)
    const res = await connector.select(phys, { where: { col: 'id', op: 'in', value: ids } })
    const engine = eventEngine()
    let n = 0
    const changedRows: string[] = []
    for (const raw of res.rows) {
      const record = recordOf(def, raw)
      const limits = newLimits(afterBudgetMs(), MAX_ROWS_READ)
      const upd: RawRow = {}
      const touched = new Set(changed ?? [])
      for (const f of r.formulas) {
        const wanted = fs.includes(f) || (changed !== null && [...f.inputs].some((x) => touched.has(x)))
        if (!wanted) continue
        const o = await evaluateFormula({ formula: f.formula, role: 'formulaColumn', record, old: null, user: userRecord(null), tables, readAs: null, data, limits, engine })
        let value: FxValue = o.ok ? o.value : null
        if (!o.ok) logRun({ eventId: null, eventName: `Formula column ${f.col.displayName}`, tableId: def.id, rowId: String(raw.id), timing: 'before', op: 'update', status: 'failed', durationMs: 0, message: `${o.error} (stored blank)` })
        if (Array.isArray(value) || (value !== null && typeof value === 'object' && !(value instanceof Date))) value = null
        record[f.col.name] = value
        touched.add(f.col.name)
        let cell: RawRow[string] = null
        try { cell = coerceIn(f.col, fromFx(f.col, value)) } catch { cell = null }
        const before = raw[f.col.name]
        const same = before instanceof Date && cell instanceof Date ? before.getTime() === cell.getTime() : (before ?? null) === (cell ?? null) || (typeof before === 'number' && typeof cell === 'number' && Math.abs(before - cell) < 1e-9)
        if (!same) upd[f.col.name] = cell
      }
      if (Object.keys(upd).length) {
        await connector.update(phys, String(raw.id), upd)
        changedRows.push(String(raw.id))
        if (changedRows.length <= 50) {
          await recordChange(null, def, { op: 'update', rowId: String(raw.id), changed: Object.keys(upd), before: snapshot(def, raw, Object.keys(upd)).value, after: snapshot(def, { ...raw, ...upd }, Object.keys(upd)).value })
        }
        n++
      }
    }
    if (changedRows.length > 50) await recordChange(null, def, { op: 'bulk', rowIds: changedRows.slice(50), rowCount: changedRows.length - 50, changed: fs.map((f) => f.col.name), details: { action: 'update', reason: 'formula' } })
    return n
  }

  /**
   * Rollup values of parent rows (ids; all rows when null), in batches: lock the parents, aggregate the children,
   * store what differs, recompute the parent's formula columns that read the rollup, write outbox rows. Serialised
   * per parent row by the row lock, so concurrent recomputes never store a stale total.
   */
  async function recomputeRollup(parentId: string, column: string, ids: string[] | null): Promise<number> {
    const all = await rules()
    const parent = all.byId.get(parentId)
    if (!parent) return 0
    const col = parent.columns.find((c) => c.name === column)
    if (!col || col.computed?.kind !== 'rollup') return 0
    const spec = col.computed
    const child = all.byName.get(spec.table.toLowerCase()) ?? all.byId.get(spec.table)
    if (!child || !isDefaultTable(parent) || !isDefaultTable(child)) return 0
    const P = sqlTable(parent)
    const C = sqlTable(child)
    const via = quoteId(spec.via)
    const target = quoteId(col.name)
    const agg = spec.fn === 'count' ? 'count(*)' : `${spec.fn}(c.${quoteId(spec.column!)})`
    // recycle bin: deleted child rows do not count (they count again when restored: the restore's outbox reconciles)
    const liveC = hasRecycleBin(child) ? ` AND ${liveRowsSql(child, 'c')}` : ''
    const valueSql = spec.fn === 'count' || spec.fn === 'sum' ? `COALESCE((SELECT ${agg} FROM ${C} c WHERE c.${via} = p2."id"${liveC}), 0)` : `(SELECT ${agg} FROM ${C} c WHERE c.${via} = p2."id"${liveC})`
    let total = 0
    const batch = async (list: string[]) => {
      await unit(parent, async () => {
        await db().query(`SELECT 1 FROM ${P} WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR UPDATE`, [list])
        const changed = await db().query<Row>(
          `UPDATE ${P} p SET ${target} = v.val FROM (SELECT p2."id", ${valueSql} AS val FROM ${P} p2 WHERE p2."id" = ANY($1::text[])) v
           WHERE p."id" = v."id" AND p.${target} IS DISTINCT FROM v.val RETURNING p."id"`, [list])
        const changedIds = changed.map((r) => String(r.id))
        total += changedIds.length
        if (!changedIds.length) return
        if (changedIds.length <= 50) {
          const rows = await (await deps.data().internals.connectorFor(parent)).select(deps.data().internals.physical(parent), { where: { col: 'id', op: 'in', value: changedIds }, select: ['id', col.name, ...parent.columns.filter((c) => c.type === 'lookup').map((c) => c.name)] })
          for (const row of rows.rows) await recordChange(null, parent, { op: 'update', rowId: String(row.id), changed: [col.name], after: snapshot(parent, row, [col.name]).value })
        } else {
          await recordChange(null, parent, { op: 'bulk', rowIds: changedIds, rowCount: changedIds.length, changed: [col.name], details: { action: 'update', reason: 'rollup' } })
        }
        await recomputeFormulas(parent, changedIds, new Set([col.name]))
      })
    }
    if (ids) {
      const uniq = [...new Set(ids)].sort()
      for (let i = 0; i < uniq.length; i += 500) await batch(uniq.slice(i, i + 500))
      return total
    }
    let last = ''
    for (;;) {
      const page = (await db().query<Row>(`SELECT "id" FROM ${P} WHERE "id" > $1 ORDER BY "id" LIMIT 500`, [last])).map((r) => String(r.id))
      if (!page.length) break
      await batch(page)
      last = page[page.length - 1]
      if (page.length < 500) break
    }
    return total
  }

  /** every rollup column of the environment (or of one table / column), all rows */
  async function reconcileRollups(tableId?: string, column?: string): Promise<{ columns: number; changed: number }> {
    const all = await rules()
    let columns = 0
    let changed = 0
    for (const t of all.tables) {
      if (tableId && t.id !== tableId) continue
      for (const c of t.columns) {
        if (c.computed?.kind !== 'rollup' || (column && c.name !== column)) continue
        columns++
        changed += await recomputeRollup(t.id, c.name, null)
      }
    }
    return { columns, changed }
  }

  /** recompute one formula column (or all of a table's) on every row, in batches, rows locked per batch */
  async function backfillFormulas(tableId: string, column?: string, signal?: AbortSignal): Promise<number> {
    const all = await rules()
    const def = all.byId.get(tableId)
    if (!def) return 0
    const r = all.perTable.get(def.id)
    if (!r?.formulas.length) return 0
    const connector = await deps.data().internals.connectorFor(def)
    const phys = deps.data().internals.physical(def)
    let last = ''
    let n = 0
    for (;;) {
      if (signal?.aborted) throw new Error('stopped')
      const page = (await connector.select(phys, { select: ['id'], where: { col: 'id', op: 'gt', value: last }, orderBy: [{ col: 'id', dir: 'asc' }], top: 200 })).rows.map((x) => String(x.id))
      if (!page.length) break
      await unit(def, async () => {
        if (isDefaultTable(def)) await db().query(`SELECT 1 FROM ${sqlTable(def)} WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR UPDATE`, [page])
        n += await recomputeFormulas(def, page, null, column)
      })
      last = page[page.length - 1]
      if (page.length < 200) break
    }
    return n
  }

  /* ---------------------------------------------------------------- definitions API */

  async function list(tableId?: string): Promise<TableEventDef[]> {
    const rows = tableId
      ? await db().query<Row>(`SELECT * FROM ${T('ab_table_events')} WHERE table_id = $1 ORDER BY timing DESC, order_no, id`, [tableId])
      : await db().query<Row>(`SELECT * FROM ${T('ab_table_events')} ORDER BY table_id, timing DESC, order_no, id`)
    return rows.map(toEventDef)
  }

  async function get(id: string): Promise<TableEventDef | null> {
    const rows = await db().query<Row>(`SELECT * FROM ${T('ab_table_events')} WHERE id = $1`, [id])
    return rows.length ? toEventDef(rows[0]) : null
  }

  /** create (id null) or change an event; formulas checked; runAs system only for administrators (the route checks) */
  async function save(table: TableDef, id: string | null, input: TableEventInput, by: string | null, o: { createWithId?: string } = {}): Promise<{ event: TableEventDef; problems: (FormulaProblem & { field: string })[] }> {
    const base = id ? await get(id) : null
    if (id && (!base || base.tableId !== table.id)) throw new HttpError(404, 'not-found', 'Event not found.')
    // tables created in this unit of work (solution import) must be known to the formula checks
    if (o.createWithId !== undefined) invalidate()
    const { tables } = await rules()
    const { def, problems } = normalizeEvent(input, base, table, tables)
    if (problems.length) {
      const p = problems[0]
      throw new HttpError(422, 'invalid', `${p.field === 'condition' ? (def.kind === 'validation' ? 'Rule' : 'Condition') : 'Actions'}: ${p.message}`, p.field, { problems })
    }
    if (!base) {
      const n = Number((await db().query<Row>(`SELECT count(*)::int AS n FROM ${T('ab_table_events')} WHERE table_id = $1`, [table.id]))[0]?.n ?? 0)
      if (n >= MAX_EVENTS_PER_TABLE) throw invalid(`A table can have at most ${MAX_EVENTS_PER_TABLE} events and validation rules.`)
    }
    const now = new Date().toISOString()
    const fresh = o.createWithId && /^[A-Za-z0-9_-]{1,64}$/.test(o.createWithId) && !(await get(o.createWithId)) ? o.createWithId : null
    const event: TableEventDef = { ...def, id: base?.id ?? fresh ?? `evt_${rowUid().replace(/-/g, '').slice(-16)}`, tableId: table.id, createdOn: base?.createdOn ?? now, modifiedOn: now, ...(by ? { modifiedBy: by } : {}) }
    await db().exec(
      `INSERT INTO ${T('ab_table_events')} (id, table_id, timing, order_no, enabled, def, created_on, modified_on) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       ON CONFLICT (id) DO UPDATE SET timing = EXCLUDED.timing, order_no = EXCLUDED.order_no, enabled = EXCLUDED.enabled, def = EXCLUDED.def, modified_on = EXCLUDED.modified_on`,
      [event.id, table.id, event.timing, event.order, event.enabled, JSON.stringify(event), event.createdOn, now],
    )
    invalidate()
    return { event, problems: [] }
  }

  async function remove(id: string): Promise<TableEventDef> {
    const e = await get(id)
    if (!e) throw new HttpError(404, 'not-found', 'Event not found.')
    await db().exec(`DELETE FROM ${T('ab_table_events')} WHERE id = $1`, [id])
    invalidate()
    return e
  }

  /** events of a table that is being deleted */
  async function removeForTable(tableId: string): Promise<void> {
    await db().exec(`DELETE FROM ${T('ab_table_events')} WHERE table_id = $1`, [tableId])
    invalidate()
  }

  async function runLog(f: { tableId?: string; eventId?: string; status?: EventRunStatus; limit?: number; before?: number }): Promise<EventRunEntry[]> {
    const where: string[] = []
    const params: unknown[] = []
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)) }
    if (f.tableId) add('table_id = ?', f.tableId)
    if (f.eventId) add('event_id = ?', f.eventId)
    if (f.status) add('status = ?', f.status)
    if (f.before) add('id < ?', f.before)
    const limit = Math.max(1, Math.min(500, Math.trunc(f.limit ?? 100)))
    const rows = await db().query<Row>(`SELECT * FROM ${T('ab_event_runs')} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`, params)
    return rows.map((r) => {
      const e: EventRunEntry = {
        id: Number(r.id), at: (r.at as Date).toISOString(), eventId: r.event_id ? String(r.event_id) : null, eventName: String(r.event_name), tableId: String(r.table_id),
        rowId: r.row_id ? String(r.row_id) : null, timing: String(r.timing) as TableEventTiming, op: String(r.op) as TableEventOperation,
        status: String(r.status) as EventRunStatus, durationMs: Number(r.duration_ms) || 0,
      }
      if (r.message) e.message = String(r.message)
      if (r.details !== null && r.details !== undefined) e.details = typeof r.details === 'string' ? (() => { try { return JSON.parse(r.details as string) } catch { return r.details } })() : r.details
      if (r.job_id) e.jobId = String(r.job_id)
      if (r.correlation_id) e.correlationId = String(r.correlation_id)
      return e
    })
  }

  async function purgeRuns(days: number): Promise<number> {
    return (await db().exec(`DELETE FROM ${T('ab_event_runs')} WHERE at < now() - make_interval(days => $1)`, [Math.max(1, Math.trunc(days))])).affectedRows
  }

  /* ---------------------------------------------------------------- test run (nothing is written) */

  async function testRun(table: TableDef, input: TableEventInput, sample: Record<string, unknown>, opts: { op?: TableEventOperation; old?: Record<string, unknown> | null; ctx: UserContext | null }): Promise<EventTestResult> {
    const { tables } = await rules()
    const { def } = normalizeEvent({ ...input, name: input.name || 'Test' }, null, table, tables)
    const t0 = Date.now()
    const limits = newLimits(def.timing === 'after' ? afterBudgetMs() : beforeBudgetMs(), MAX_ROWS_READ)
    const coerced: RawRow = {}
    for (const c of table.columns) {
      if (!(c.name in sample)) continue
      try { coerced[c.name] = coerceIn(c, sample[c.name]) } catch (e) { throw e instanceof HttpError ? invalid(`Sample: ${e.message}`, c.name) : e }
    }
    if (typeof sample.id === 'string') coerced.id = sample.id
    const record = recordOf(table, coerced)
    const old = opts.old ? recordOf(table, opts.old as RawRow) : null
    const readAs = def.runAs === 'system' ? null : opts.ctx
    const engine = eventEngine()
    const base = { formula: '', record, old, user: actorRecord(opts.ctx), tables, readAs, data: deps.data(), limits, engine }
    const result: EventTestResult = { changes: {}, writes: [], notifications: [], jobs: [], traces: [], durationMs: 0, rowsRead: 0 }
    const finish = () => ({ ...result, durationMs: Date.now() - t0, rowsRead: limits.rowsRead })
    try {
      if (def.kind === 'validation') {
        const o = await evaluateFormula({ ...base, formula: def.condition ?? '', role: 'validation' })
        if (!o.ok) return { ...finish(), error: o.error }
        if (!truthy(o.value)) result.rejected = { message: def.message ?? '', ...(def.field ? { field: def.field } : {}) }
        return finish()
      }
      if (def.condition) {
        const c = await evaluateFormula({ ...base, formula: def.condition, role: 'condition' })
        if (!c.ok) return { ...finish(), error: `Condition: ${c.error}` }
        if (!truthy(c.value)) return { ...finish(), skipped: true }
      }
      const o = await evaluateFormula({ ...base, formula: def.actions ?? '', role: def.timing })
      result.traces = o.traces
      if (o.rejected) return { ...finish(), rejected: o.rejected }
      if (!o.ok) return { ...finish(), error: o.error }
      const plain = (v: FxValue): QueryValue => (v instanceof Date ? v.toISOString() : v === null || typeof v !== 'object' ? (v as QueryValue) : JSON.stringify(v))
      for (const [k, v] of o.sets) result.changes[k] = plain(v)
      result.writes = o.intents.map((it) => ({ op: it.op, table: it.table, ...(it.rowId ? { rowId: it.rowId } : {}), ...(it.values ? { values: Object.fromEntries(Object.entries(it.values).filter(([k]) => k !== '__id').map(([k, v]) => [k, plain(v as FxValue)])) } : {}) }))
      result.notifications = o.notifications
      result.jobs = o.jobs.map((j) => ({ type: j.type, payload: j.payload }))
      return finish()
    } catch (e) {
      return { ...finish(), error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** check one formula for a role (the designer's formula editors) */
  async function check(table: TableDef, formula: string, role: FormulaRole): Promise<FormulaProblem[]> {
    const { tables } = await rules()
    return checkFormula(formula, role, tables, table)
  }

  return {
    invalidate,
    rules,
    tableRules,
    unit,
    lockRow,
    beforeWrite,
    recordChange,
    dispatch,
    runAfterEvent,
    recomputeRollup,
    reconcileRollups,
    backfillFormulas,
    list,
    get,
    save,
    remove,
    removeForTable,
    runLog,
    purgeRuns,
    testRun,
    check,
    logRun,
    setNotificationSink(s: NotificationSink) { notifications = s },
    setConnectorActionSink(s: ConnectorActionSink) { connectorActions = s },
    /** true while the current async context is inside a write unit */
    inUnit: () => !!unitStore.getStore(),
    /** runs fn with the event chain of an after-event job (writes carry it into the outbox) */
    withChain<T>(depth: number, chain: string[], fn: () => Promise<T>): Promise<T> {
      return runWithWork({ depth, chain }, fn)
    },
  }
}
