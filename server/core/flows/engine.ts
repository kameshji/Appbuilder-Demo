/**
 * The flow engine (docs/dev/flows.md "Execution"): a state machine driven by jobs of the Phase 0 queue.
 *
 * A run is a tree of containers (the top level, each branch of a condition or switch, a scope, each iteration of a
 * loop), named by a path: '' (top), '/check.then', '/each#3', '/each#3/inner.else' ... One `flow.advance` job advances
 * one container of one run by exactly one step: it reads the step rows of that container, skips the steps whose
 * runAfter cannot be met, executes the next step, and in the same transaction as the step's result enqueues the next
 * advance. Every decision is made again from the database, so a crash anywhere is repaired by running the job again
 * (the reaper gives a job of a dead worker back to the queue):
 *
 *  - internal steps (compose, setVariable, condition ...) and data steps on the default database: the step row, its
 *    data change (with the outbox entry) and the next advance commit in ONE transaction: effectively exactly once;
 *  - external steps (http, action, email, notify): the step row is committed as running first, then the call is made
 *    with the idempotency key `<runId>:<stepKey>` (the same for every attempt), then the result commits with the next
 *    advance: at least once, deduplicated where the receiver honours the key;
 *  - suspending steps (delay, approval, callFlow, waitForCallback) write a wait row (ab_flow_waits) in the step's
 *    transaction; the sweeper (worker tick) or the outside (approval decided, callback, child run finished) resumes it
 *    with a `flow.resume` job; the wait row changes state once, so a run resumes once.
 *
 * Containers: entering one writes its row (running) and enqueues its children's advance; when the last step of a
 * container is terminal, its outcome (failed when a step failed or timed out and no later sibling handled that
 * outcome with runAfter) is written to the container's row, and the parent advances. Loop iterations get rows of kind
 * 'iteration' (with the item), so iterations that finished are never run again.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { HttpError } from '../contracts.ts'
import type { Connector, DataService, MetaStore, NotificationService, SqlDb, UserContext } from '../contracts.ts'
import type { QueryValue } from '../../../src/platform/http.ts'
import type { FxRecord, FxValue } from '../../../src/contracts.ts'
import type { TableDef, UserDef } from '../../../src/platform/contracts.ts'
import type { QueryPlan } from '../../../src/platform/query.ts'
import type { ActionResult, ActionsService } from '../actions/contracts.ts'
import {
  FLOW_LIMITS, TERMINAL_RUN, TERMINAL_STEP, childLists, isContainer, type FlowRunInfo, type RetryPolicy, type RunStatus, type Step, type StepStatus,
} from '../../../src/platform/flows.ts'
import { SYS } from '../../../src/platform/system-tables.ts'
import { JobError, type JobQueue } from '../jobs.ts'
import { currentEnvironment } from '../env-context.ts'
import { runWithWork, newWorkId } from '../work-context.ts'
import { fromFx, newLimits, recordOf, toFx } from '../event-fx.ts'
import { stableUuid } from '../table-events.ts'
import { emitTableChange } from '../live/changes.ts'
import { errText } from '../util.ts'
import { analyze } from '../../../src/fx/query/index.ts'
import { schemaOf } from '../event-fx.ts'
import { isRecord } from '../../../src/fx/values.ts'
import { evaluate, flowEngine, flowScope, rowsToFx, runPlan, type EvalEnv, type FlowClock } from './expr.ts'
import { forDisplay, fromStored, fxToJson, jsonToFx, sizeOf, toStored } from './values.ts'
import type { FlowDoc, FlowStore } from './store.ts'
import { T } from './store.ts'
import type { ApprovalsService, WaitOutcome } from './contracts.ts'

type Row = Record<string, unknown>

export const ADVANCE_JOB = 'flow.advance'
export const RESUME_JOB = 'flow.resume'
export const TIMEOUT_JOB = 'flow.timeout'

const DATA_KINDS = new Set(['data.get', 'data.list', 'data.create', 'data.update', 'data.delete'])
const WRITE_KINDS = new Set(['data.create', 'data.update', 'data.delete'])
const EXTERNAL_KINDS = new Set(['http', 'action', 'email', 'notify'])
const SUSPEND_KINDS = new Set(['delay', 'approval', 'callFlow', 'waitForCallback'])

export interface EngineDeps {
  db(): SqlDb | null
  meta(): MetaStore
  data(): DataService & { internals: { connectorFor(t: TableDef): Promise<Connector>; physical(t: TableDef): TableDef } }
  forUser(user: UserDef): Promise<UserContext>
  jobs: JobQueue
  store: FlowStore
  notifications(): NotificationService | undefined
  actions(): ActionsService | undefined
  approvals(): ApprovalsService | null
  log(level: 'info' | 'warn' | 'error', msg: string): void
}

/** a run as the engine reads it */
export interface RunRow {
  id: string
  flowId: string
  flowName: string
  flowVersion: number
  ownerId: string | null
  state: RunStatus
  mode: 'normal' | 'test'
  dryRun: boolean
  triggerKind: string
  trigger: unknown
  runAs: string | null
  runAsKind: string
  triggeredBy: string | null
  correlationId: string
  chain: string[]
  depth: number
  callDepth: number
  parentRunId: string | null
  parentWaitId: string | null
  concurrencyKey: string | null
  variables: Record<string, unknown>
  responded: boolean
  stepCount: number
  doc: FlowDoc | null
  options: { approvalOutcome?: string }
}

interface StepRow {
  runId: string
  key: string
  stepId: string
  scope: string
  name: string
  kind: string
  state: StepStatus
  attempt: number
  output: unknown
  error: { message: string; code?: string; permanent?: boolean } | null
  data: Record<string, unknown> | null
  jobId: string | null
  startedOn: Date
  finishedOn: Date | null
}

/**
 * Tests only: a crash at a point of the step lifecycle. The hook may throw FaultCrash, which no step handler catches: the
 * job fails as if its worker died there (inside a transaction: rolled back), and the queue runs it again.
 */
export class FaultCrash extends Error {}
let faultHook: ((point: string, info: { runId: string; key: string; kind: string }) => void) | null = null
export function setFaultHook(fn: typeof faultHook): void {
  faultHook = fn
}
const fault = (point: string, info: { runId: string; key: string; kind: string }): void => { if (faultHook) faultHook(point, info) }

/** the transaction must end without effect (another job owns the step, the run ended) */
class Yield extends Error {}

/** an error and whether retrying can help */
export class StepError extends Error {
  permanent: boolean
  code?: string
  constructor(message: string, permanent: boolean, code?: string) {
    super(message)
    this.permanent = permanent
    if (code) this.code = code
  }
}

const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : v ? new Date(String(v)).toISOString() : undefined)
/** jsonb columns arrive parsed (pg); a jsonb text is a JS string */
const parseJ = <X>(v: unknown, d: X): X => (v === null || v === undefined ? d : v as X)

function toRun(r: Row): RunRow {
  return {
    id: String(r.id), flowId: String(r.flow_id), flowName: String(r.flow_name), flowVersion: Number(r.flow_version), ownerId: r.owner_id ? String(r.owner_id) : null,
    state: String(r.state) as RunStatus, mode: r.mode === 'test' ? 'test' : 'normal', dryRun: r.dry_run === true, triggerKind: String(r.trigger_kind),
    trigger: parseJ<unknown>(r.trigger, null), runAs: r.run_as ? String(r.run_as) : null, runAsKind: String(r.run_as_kind), triggeredBy: r.triggered_by ? String(r.triggered_by) : null,
    correlationId: String(r.correlation_id), chain: parseJ<string[]>(r.chain, []), depth: Number(r.depth) || 0, callDepth: Number(r.call_depth) || 0,
    parentRunId: r.parent_run_id ? String(r.parent_run_id) : null, parentWaitId: r.parent_wait_id ? String(r.parent_wait_id) : null,
    concurrencyKey: r.concurrency_key ? String(r.concurrency_key) : null, variables: parseJ<Record<string, unknown>>(r.variables, {}),
    responded: r.responded === true, stepCount: Number(r.step_count) || 0, doc: parseJ<FlowDoc | null>(r.doc, null), options: parseJ<RunRow['options']>(r.options, {}),
  }
}

function toStep(r: Row): StepRow {
  return {
    runId: String(r.run_id), key: String(r.step_key), stepId: String(r.step_id), scope: String(r.scope), name: String(r.name), kind: String(r.kind),
    state: String(r.state) as StepStatus, attempt: Number(r.attempt) || 1, output: parseJ<unknown>(r.output, null), error: parseJ(r.error, null),
    data: parseJ<Record<string, unknown> | null>(r.data, null), jobId: r.job_id ? String(r.job_id) : null,
    startedOn: r.started_on instanceof Date ? r.started_on : new Date(String(r.started_on)), finishedOn: r.finished_on ? new Date(String(r.finished_on)) : null,
  }
}

const isTerminal = (s: string): boolean => (TERMINAL_STEP as readonly string[]).includes(s)
export const isRunTerminal = (s: string): boolean => (TERMINAL_RUN as readonly string[]).includes(s)

/** the container a scope path names */
interface Container { list: Step[]; owner: Step | null; ownerKey: string | null; parentScope: string; suffix: string; index: number | null }

const SEG = /^([A-Za-z_][A-Za-z0-9_]*)(\.then|\.else|\.default|\.case\d+|#\d+)?$/

export function resolveContainer(doc: FlowDoc, scope: string): Container | null {
  if (scope === '') return { list: doc.steps, owner: null, ownerKey: null, parentScope: '', suffix: '', index: null }
  const segs = scope.split('/').slice(1)
  let list = doc.steps
  let path = ''
  let owner: Step | null = null
  let ownerKey: string | null = null
  let parentScope = ''
  let suffix = ''
  let index: number | null = null
  for (const seg of segs) {
    const m = SEG.exec(seg)
    if (!m) return null
    const step = list.find((s) => s.id === m[1])
    if (!step || !isContainer(step.kind)) return null
    parentScope = path
    ownerKey = `${path}/${step.id}`
    owner = step
    suffix = m[2] ?? ''
    index = suffix.startsWith('#') ? Number(suffix.slice(1)) : null
    const lists = childLists(step)
    const l = suffix.startsWith('#') ? lists[0] : lists.find((x) => x.suffix === suffix)
    if (!l) return null
    list = l.steps
    path = `${path}/${seg}`
  }
  return { list, owner, ownerKey, parentScope, suffix, index }
}

/** iteration paths on a scope path ('/a#1/b.then/c#2/d' -> ['/a#1', '/a#1/b.then/c#2']) */
export function iterationPaths(scope: string): string[] {
  const out: string[] = []
  const segs = scope.split('/').slice(1)
  let p = ''
  for (const s of segs) {
    p = `${p}/${s}`
    if (/#\d+$/.test(s)) out.push(p)
  }
  return out
}

/** a row of an iteration-free scope or of my own iterations is visible to a step in `scope` */
function visibleTo(rowScope: string, mine: string[]): boolean {
  for (const ip of iterationPaths(rowScope)) if (!mine.includes(ip)) return false
  return true
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/** default retry: data steps retry transient database errors, external calls retry retryable errors */
function retryPolicy(s: Step): Required<RetryPolicy> {
  const r = s.retry
  if (r) return { type: r.type, count: r.type === 'none' ? 1 : Math.max(1, Math.min(10, r.count ?? 4)), intervalSeconds: Math.max(1, r.intervalSeconds ?? 5), maxIntervalSeconds: Math.max(1, r.maxIntervalSeconds ?? 3600) }
  if (DATA_KINDS.has(s.kind) || s.kind === 'approval') return { type: 'exponential', count: 3, intervalSeconds: 2, maxIntervalSeconds: 60 }
  if (EXTERNAL_KINDS.has(s.kind)) return { type: 'exponential', count: s.kind === 'notify' ? 3 : 4, intervalSeconds: 5, maxIntervalSeconds: 600 }
  return { type: 'none', count: 1, intervalSeconds: 1, maxIntervalSeconds: 1 }
}

export function retryDelayMs(p: Required<RetryPolicy>, attempt: number): number {
  if (p.type === 'fixed') return p.intervalSeconds * 1000
  return Math.min(p.maxIntervalSeconds, p.intervalSeconds * 2 ** Math.max(0, attempt - 1)) * 1000
}

/** permanent (retrying cannot help) or transient */
export function classify(e: unknown): StepError {
  if (e instanceof StepError) return e
  if (e instanceof JobError) return new StepError(e.message, !e.retry)
  const msg = errText(e)
  const code = (e as { code?: string }).code
  if (e instanceof HttpError) return new StepError(e.message, e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status), e.code)
  if (typeof code === 'string' && /^(40001|40P01|55P03|57P0[1-3]|08...)$/.test(code)) return new StepError(msg, false, code)
  if ((e as { permanent?: boolean }).permanent === true) return new StepError(msg, true)
  if (typeof code === 'string' && /^(22|23|42)/.test(code)) return new StepError(msg, true, code)
  return new StepError(msg, false)
}

export type FlowEngine = ReturnType<typeof createFlowEngine>

export function createFlowEngine(deps: EngineDeps) {
  let clock: FlowClock = { now: () => new Date() }
  let engine = flowEngine(clock)
  const docCache = new Map<string, FlowDoc>()
  const db = (): SqlDb => {
    const d = deps.db()
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }
  const env = () => currentEnvironment()

  /* ---------------------------------------------------------------- helpers */

  const live = (runIds: string[]) => {
    try {
      emitTableChange(env().id, SYS.flowRuns, { op: 'update', rowIds: runIds, changedColumns: ['Status'], actor: null })
    } catch {
      /* never fails a step */
    }
  }

  async function loadRun(id: string, lock = false): Promise<RunRow | null> {
    const rows = await db().query<Row>(`SELECT * FROM ${T('ab_flow_runs')} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])
    return rows.length ? toRun(rows[0]) : null
  }

  async function docFor(run: RunRow): Promise<FlowDoc> {
    if (run.doc) return run.doc
    const k = `${env().id}:${run.flowId}:${run.flowVersion}`
    const c = docCache.get(k)
    if (c) return c
    const d = await deps.store.versionDoc(run.flowId, run.flowVersion)
    if (!d) throw new StepError(`Version ${run.flowVersion} of the flow is missing.`, true)
    if (docCache.size > 500) docCache.clear()
    docCache.set(k, d)
    return d
  }

  async function tables(): Promise<TableDef[]> {
    return deps.meta().tables.list()
  }
  const tableNamed = (all: TableDef[], name: string): TableDef => {
    const n = String(name).toLowerCase()
    const t = all.find((x) => x.name.toLowerCase() === n || x.id === name)
    if (!t) throw new StepError(`Table ${name} was not found.`, true)
    return t
  }

  /** the run-as identity (null never: flows do not run as the system) */
  const identityCache = new Map<string, { at: number; ctx: UserContext }>()
  async function identity(run: RunRow): Promise<UserContext> {
    if (!run.runAs) throw new StepError('This run has no identity to run as.', true)
    const k = `${env().id}:${run.runAs}`
    const c = identityCache.get(k)
    if (c && Date.now() - c.at < 5000) return c.ctx
    const u = await deps.meta().users.get(run.runAs)
    if (!u) throw new StepError('The user this flow runs as no longer exists.', true, 'identity')
    if (u.status === 'disabled') throw new StepError(`The user this flow runs as (${u.email}) is disabled.`, true, 'identity')
    const ctx = await deps.forUser(u)
    if (identityCache.size > 1000) identityCache.clear()
    identityCache.set(k, { at: Date.now(), ctx })
    return ctx
  }

  async function enqueueAdvance(runId: string, scope: string, key: string, o: { delayMs?: number; runAt?: Date } = {}): Promise<void> {
    await deps.jobs.enqueue(ADVANCE_JOB, { runId, scope }, { idempotencyKey: `adv:${runId}:${scope}:${key}`.slice(0, 255), ...(o.delayMs ? { delayMs: o.delayMs } : {}), ...(o.runAt ? { runAt: o.runAt } : {}), priority: key === 'start' ? 1 : 2 })
  }

  async function scopeRows(runId: string, scope: string): Promise<Map<string, StepRow>> {
    const rows = await db().query<Row>(`SELECT * FROM ${T('ab_flow_steps')} WHERE run_id = $1 AND scope = $2 AND kind <> 'iteration'`, [runId, scope])
    return new Map(rows.map((r) => [String(r.step_key), toStep(r)]))
  }

  /** Steps, loop items and Flow of the scope a step runs in */
  async function scopeData(run: RunRow, scope: string, doc: FlowDoc): Promise<{ steps: FxRecord; loops: { as: string; item: FxValue }[]; callbacks: FxRecord }> {
    const its = iterationPaths(scope)
    const rows = await db().query<Row>(
      `SELECT run_id, step_key, step_id, scope, name, kind, state, attempt, output, error, CASE WHEN kind = 'iteration' THEN data END AS data, job_id, started_on, finished_on
         FROM ${T('ab_flow_steps')} WHERE run_id = $1 AND ((kind <> 'iteration' AND (strpos(scope, '#') = 0 OR scope LIKE ANY($2::text[]))) OR step_key = ANY($3::text[]))
        ORDER BY ord`,
      [run.id, its.map((p) => `${escapeLike(p)}%`), its],
    )
    const steps: FxRecord = {}
    const items = new Map<string, FxValue>()
    for (const r of rows.map(toStep)) {
      if (r.kind === 'iteration') {
        items.set(r.key, fromStored(r.data?.item))
        continue
      }
      if (!visibleTo(r.scope, its)) continue
      steps[r.name] = {
        Output: fromStored(r.output), Status: r.state, Error: r.error?.message ?? null,
        StartedOn: r.startedOn, FinishedOn: r.finishedOn, Attempt: r.attempt,
      }
    }
    const loops: { as: string; item: FxValue }[] = []
    for (const ip of its) {
      const c = resolveContainer(doc, ip)
      if (c?.owner?.kind === 'forEach') loops.push({ as: c.owner.as, item: items.get(ip) ?? null })
    }
    // callback addresses of the waitForCallback steps of this container (an earlier step sends them)
    const callbacks: FxRecord = {}
    const here = resolveContainer(doc, scope)
    for (const s of here?.list ?? []) if (s.kind === 'waitForCallback') callbacks[s.name] = await callbackUrl(run.id, `${scope}/${s.id}`)
    return { steps, loops, callbacks }
  }

  async function userRecordOf(run: RunRow): Promise<FxRecord> {
    const u = run.runAs ? await deps.meta().users.get(run.runAs) : null
    return { FullName: u?.name ?? '', Email: u?.email ?? '', Image: '', Id: u?.id ?? '' }
  }

  interface StepCtx {
    run: RunRow
    doc: FlowDoc
    scope: string
    key: string
    step: Step
    tables: TableDef[]
    ident: UserContext
    ev: EvalEnv
    fxScope: ReturnType<typeof flowScope>
  }

  async function stepCtx(run: RunRow, doc: FlowDoc, scope: string, step: Step): Promise<StepCtx> {
    const all = await tables()
    const ident = await identity(run)
    const sd = await scopeData(run, scope, doc)
    const variables: FxRecord = {}
    for (const [k, v] of Object.entries(run.variables)) variables[k] = fromStored(v)
    const trigger = fromStored(run.trigger)
    const fxScope = flowScope({
      trigger, steps: sd.steps, variables,
      flow: { RunId: run.id, Name: run.flowName, Id: run.flowId, Version: run.flowVersion, Mode: run.mode, Callback: sd.callbacks },
      user: await userRecordOf(run), loops: sd.loops,
    }, new Set(all.map((t) => t.name)))
    return { run, doc, scope, key: `${scope}/${step.id}`, step, tables: all, ident, ev: { tables: all, identity: ident, data: deps.data(), limits: newLimits(30_000, 5000, 50), engine }, fxScope }
  }

  async function fx(c: StepCtx, formula: unknown, field: string): Promise<FxValue> {
    if (formula === undefined || formula === null) return null
    if (typeof formula === 'number' || typeof formula === 'boolean') return formula
    const r = await evaluate(String(formula), c.fxScope, c.ev)
    if (!r.ok) throw new StepError(`${field}: ${r.error}`, r.permanent)
    return r.value
  }

  const rowIdOf = (v: FxValue): string => {
    if (isRecord(v)) return String((v as FxRecord).__id ?? (v as FxRecord).id ?? '')
    return v === null || v === undefined ? '' : String(v)
  }

  /* ---------------------------------------------------------------- callbacks (waitForCallback) */

  async function callbackKey(): Promise<Buffer> {
    let k = await deps.store.rawSetting('callbackKey')
    if (typeof k !== 'string') {
      await deps.store.setSetting('callbackKey', randomBytes(32).toString('base64'), null)
      k = await deps.store.rawSetting('callbackKey')
    }
    return Buffer.from(String(k), 'base64')
  }
  async function callbackToken(runId: string, key: string): Promise<string> {
    return createHmac('sha256', await callbackKey()).update(`${env().id}:${runId}:${key}`).digest('base64url').slice(0, 32)
  }
  async function callbackUrl(runId: string, key: string): Promise<string> {
    const k = Buffer.from(key).toString('base64url')
    return `/api/v1/flows/callback/${env().id}/${runId}/${k}/${await callbackToken(runId, key)}`
  }
  async function verifyCallback(runId: string, keyB64: string, token: string): Promise<string | null> {
    const key = Buffer.from(keyB64, 'base64url').toString('utf8')
    const want = Buffer.from(await callbackToken(runId, key))
    const got = Buffer.from(token)
    return want.length === got.length && timingSafeEqual(want, got) ? key : null
  }

  /* ---------------------------------------------------------------- runs: creation and start */

  interface NewRun {
    flowId: string
    flowName: string
    flowVersion: number
    ownerId: string | null
    mode?: 'normal' | 'test'
    dryRun?: boolean
    triggerKind: string
    triggerKey?: string | null
    triggerSummary?: string
    trigger: unknown
    runAs: string | null
    runAsKind: string
    triggeredBy?: string | null
    correlationId?: string
    chain?: string[]
    depth?: number
    callDepth?: number
    parentRunId?: string | null
    parentWaitId?: string | null
    resubmittedFrom?: string | null
    concurrencyKey?: string | null
    seq?: number
    variables: Record<string, unknown>
    timeoutMinutes: number
    regarding?: { tableId: string; rowId: string } | null
    doc?: FlowDoc | null
    options?: RunRow['options']
    id?: string
    /** start even beyond the per-flow rate (tests) */
    maxRunsPerMinute?: number
    /** coalesce: while a queued run of this record exists, update its trigger instead */
    coalesceKey?: string
    /** record a run that could not start (trigger condition failed, no identity): stored as failed with this message */
    failed?: string
  }

  /**
   * Creates a run in the caller's transaction and starts it (or queues it behind the runs holding its concurrency key).
   * Returns null when the trigger key exists already (the same event twice) or when the change was coalesced.
   */
  async function createRun(n: NewRun): Promise<{ id: string; created: boolean }> {
    const d = db()
    const id = n.id ?? `run_${randomBytes(9).toString('base64url')}`
    const payload = toStoredSafe(n.trigger, FLOW_LIMITS.triggerPayloadBytes, 'The trigger payload')
    if (n.coalesceKey) {
      // a queued (not started) run of the same record takes the newer payload
      const c = await d.query<Row>(
        `UPDATE ${T('ab_flow_runs')} SET trigger = $2::jsonb, trigger_summary = $3 WHERE id = (
           SELECT id FROM ${T('ab_flow_runs')} WHERE concurrency_key = $1 AND state = 'queued' AND started_on IS NULL ORDER BY seq DESC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id`,
        [n.coalesceKey, JSON.stringify(payload), n.triggerSummary ?? null],
      )
      if (c.length) return { id: String(c[0].id), created: false }
    }
    const now = clock.now()
    const deadline = new Date(now.getTime() + Math.max(1, n.timeoutMinutes) * 60_000)
    const rows = await d.query<Row>(
      `INSERT INTO ${T('ab_flow_runs')} (id, flow_id, flow_name, flow_version, owner_id, state, mode, dry_run, trigger_kind, trigger_key, trigger_summary, trigger, run_as, run_as_kind,
         triggered_by, correlation_id, chain, depth, call_depth, parent_run_id, parent_wait_id, resubmitted_from, concurrency_key, seq, variables, regarding_table, regarding_id,
         deadline_at, created_on, doc, options)
       VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16::jsonb, $17, $18, $19, $20, $21, $22, $23, $24::jsonb, $25, $26, $27, $28, $29::jsonb, $30::jsonb)
       ON CONFLICT (trigger_key) WHERE trigger_key IS NOT NULL DO NOTHING RETURNING id`,
      [id, n.flowId, n.flowName, n.flowVersion, n.ownerId, n.mode ?? 'normal', !!n.dryRun, n.triggerKind, n.triggerKey ?? null, n.triggerSummary?.slice(0, 300) ?? null,
        JSON.stringify(payload), n.runAs, n.runAsKind, n.triggeredBy ?? null, n.correlationId ?? newWorkId(), JSON.stringify((n.chain ?? []).slice(-32)), n.depth ?? 0, n.callDepth ?? 0,
        n.parentRunId ?? null, n.parentWaitId ?? null, n.resubmittedFrom ?? null, n.concurrencyKey ?? null, n.seq ?? Date.now(), JSON.stringify(n.variables),
        n.regarding?.tableId ?? null, n.regarding?.rowId ?? null, deadline, now, n.doc ? JSON.stringify(n.doc) : null, JSON.stringify(n.options ?? {})],
    )
    if (!rows.length) {
      const ex = n.triggerKey ? await d.query<Row>(`SELECT id FROM ${T('ab_flow_runs')} WHERE trigger_key = $1`, [n.triggerKey]) : []
      return { id: String(ex[0]?.id ?? ''), created: false }
    }
    if (n.failed) {
      await d.exec(`UPDATE ${T('ab_flow_runs')} SET state = 'failed', error = $2::jsonb, started_on = now(), finished_on = now(), concurrency_key = NULL WHERE id = $1`, [id, JSON.stringify({ message: n.failed })])
      return { id, created: true }
    }
    await startOrQueue(id, n.concurrencyKey ?? null, n.flowId, n.maxRunsPerMinute)
    return { id, created: true }
  }

  function toStoredSafe(v: unknown, cap: number, what: string): unknown {
    const j = toStored(v as FxValue)
    if (sizeOf(j) > cap) throw new HttpError(422, 'invalid', `${what} is larger than ${Math.round(cap / 1024)} KB.`)
    return j
  }

  /** start now (enqueue the top-level advance), later (rate limit), or wait behind the runs of the concurrency key */
  async function startOrQueue(id: string, key: string | null, flowId: string, perMinute?: number): Promise<void> {
    if (key) {
      await db().query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ab.flowkey:${env().schema}:${key}`])
      const busy = await db().query<Row>(`SELECT 1 FROM ${T('ab_flow_runs')} WHERE concurrency_key = $1 AND id <> $2 AND (state IN ('running', 'waiting') OR (state = 'queued' AND started_on IS NOT NULL)) LIMIT 1`, [key, id])
      const older = await db().query<Row>(`SELECT 1 FROM ${T('ab_flow_runs')} r WHERE r.concurrency_key = $1 AND r.id <> $2 AND r.state = 'queued' AND r.seq < (SELECT seq FROM ${T('ab_flow_runs')} WHERE id = $2) LIMIT 1`, [key, id])
      if (busy.length || older.length) return
    }
    await markStarting(id, flowId, perMinute)
  }

  /** enqueue the first advance; the per-flow and per-environment rates delay it to the next minute (nothing is dropped) */
  async function markStarting(id: string, flowId: string, perMinute?: number): Promise<void> {
    const limit = perMinute ?? FLOW_LIMITS.runsPerMinute
    const st = await deps.store.settings()
    const recent = await db().query<Row>(
      `SELECT count(*) FILTER (WHERE flow_id = $1)::int AS f, count(*)::int AS e FROM ${T('ab_flow_runs')} WHERE started_on > now() - interval '1 minute'`, [flowId],
    )
    const over = Number(recent[0]?.f) >= limit || Number(recent[0]?.e) >= st.environmentRunsPerMinute
    await db().exec(`UPDATE ${T('ab_flow_runs')} SET started_on = COALESCE(started_on, now()) WHERE id = $1`, [id])
    await enqueueAdvance(id, '', 'start', over ? { delayMs: 60_000 } : {})
  }

  /** the next queued run of a concurrency key (after a run ended) */
  async function startNext(key: string | null): Promise<void> {
    if (!key) return
    await db().query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ab.flowkey:${env().schema}:${key}`])
    const busy = await db().query<Row>(`SELECT 1 FROM ${T('ab_flow_runs')} WHERE concurrency_key = $1 AND (state IN ('running', 'waiting') OR (state = 'queued' AND started_on IS NOT NULL)) LIMIT 1`, [key])
    if (busy.length) return
    const next = await db().query<Row>(`SELECT id, flow_id FROM ${T('ab_flow_runs')} WHERE concurrency_key = $1 AND state = 'queued' ORDER BY seq, created_on LIMIT 1`, [key])
    if (next.length) await markStarting(String(next[0].id), String(next[0].flow_id))
  }

  /* ---------------------------------------------------------------- the advance job */

  async function advance(p: { runId: string; scope: string }, job: { id: string; attempts: number }): Promise<unknown> {
    const run = await loadRun(p.runId)
    if (!run || isRunTerminal(run.state)) return { skipped: 'run ended' }
    const settings = await deps.store.settings()
    if (settings.paused) {
      // kill switch: try again in a minute (a new job: this one ends)
      await enqueueAdvance(run.id, p.scope, `paused:${Math.floor(Date.now() / 60_000)}`, { delayMs: 60_000 })
      return { paused: true }
    }
    if (run.state === 'queued') {
      if (p.scope !== '') return { skipped: 'not started' }
      const started = await start(run)
      if (!started) return { skipped: 'could not start' }
      run.state = 'running'
    }
    const doc = await docFor(run)
    const c = resolveContainer(doc, p.scope)
    if (!c) {
      await failRun(run.id, `The step path ${p.scope} is not in version ${run.flowVersion} of the flow.`)
      return { failed: 'bad scope' }
    }
    const rows = await scopeRows(run.id, p.scope)
    const onError = doc.settings?.onError ?? 'fail'
    for (const [i, step] of c.list.entries()) {
      const key = `${p.scope}/${step.id}`
      const row = rows.get(key)
      if (row && isTerminal(row.state)) continue
      if (row?.state === 'waiting') return { waiting: key }
      if (row && isContainer(step.kind)) return kickContainer(run, doc, p.scope, step, row)
      if (row) return executeLeaf(run, doc, p.scope, step, row, job)
      const ok = runAfterMet(step, i, c.list, rows, onError)
      if (!ok) {
        const r = await insertSkipped(run.id, p.scope, step)
        if (r) rows.set(key, r)
        continue
      }
      if (isContainer(step.kind)) return enterContainer(run, doc, p.scope, step, job)
      return executeLeaf(run, doc, p.scope, step, null, job)
    }
    return completeContainer(run, doc, p.scope, c, rows)
  }

  /** queued -> running: the identity is checked first (a disabled owner suspends the flow) */
  async function start(run: RunRow): Promise<boolean> {
    try {
      await identity(run)
    } catch (e) {
      const m = errText(e)
      if ((e as StepError).code === 'identity' && run.runAsKind === 'owner') await suspendFlow(run.flowId, m)
      await failRun(run.id, m)
      return false
    }
    return db().tx(async () => {
      const r = await loadRun(run.id, true)
      if (!r || r.state !== 'queued') return r?.state === 'running'
      await db().exec(`UPDATE ${T('ab_flow_runs')} SET state = 'running', started_on = COALESCE(started_on, now()) WHERE id = $1`, [run.id])
      live([run.id])
      return true
    })
  }

  async function suspendFlow(flowId: string, why: string): Promise<void> {
    const changed = await deps.store.setSuspended(flowId, why)
    if (!changed) return
    const admins = await adminIds()
    const f = await deps.store.get(flowId)
    await deps.notifications()?.notify({ userIds: admins }, {
      kind: 'flow', title: `Flow "${f?.name ?? flowId}" is suspended`, body: `${why} Its runs fail until a maker changes the owner or the run-as identity.`,
      link: `#flows`, environmentId: env().id, source: `flow:${flowId}`,
    }).catch((e) => deps.log('warn', `flow ${flowId}: suspension notification: ${errText(e)}`))
    await deps.meta().audit({ userId: null, action: 'flow.suspended', details: { flow: flowId, name: f?.name, reason: why } }).catch(() => {})
  }

  async function adminIds(): Promise<string[]> {
    const roles = await deps.meta().roles.list()
    const adminRoles = new Set(roles.filter((r) => r.isAdmin).map((r) => r.id))
    return (await deps.meta().users.list()).filter((u) => u.status !== 'disabled' && (u.isInstallAdmin || u.roleIds.some((r) => adminRoles.has(r)))).map((u) => u.id)
  }

  /** runAfter of a step at position i (siblings run in order, so its references are terminal) */
  function runAfterMet(step: Step, i: number, list: Step[], rows: Map<string, StepRow>, onError: 'fail' | 'continue'): boolean {
    const scopeOf = (id: string) => [...rows.values()].find((r) => r.stepId === id)
    if (step.runAfter?.length) {
      return step.runAfter.every((ra) => {
        const r = scopeOf(ra.step)
        return !!r && (ra.when as string[]).includes(r.state)
      })
    }
    if (i === 0) return true
    const prev = scopeOf(list[i - 1].id)
    if (!prev) return false
    if (prev.state === 'succeeded') return true
    return onError === 'continue' && prev.state !== 'cancelled'
  }

  async function insertSkipped(runId: string, scope: string, step: Step): Promise<StepRow | null> {
    const rows = await db().query<Row>(
      `INSERT INTO ${T('ab_flow_steps')} (run_id, step_key, step_id, scope, name, kind, state, attempt, started_on, finished_on) VALUES ($1, $2, $3, $4, $5, $6, 'skipped', 0, now(), now())
       ON CONFLICT (run_id, step_key) DO NOTHING RETURNING *`,
      [runId, `${scope}/${step.id}`, step.id, scope, step.name, step.kind],
    )
    return rows.length ? toStep(rows[0]) : null
  }

  /** the step row must be ours: a row of another job that still runs means that job is executing the step */
  async function ownRow(row: StepRow | null, jobId: string): Promise<boolean> {
    if (!row || !row.jobId || row.jobId === jobId) return true
    const j = await db().query<Row>(`SELECT state FROM ${T('ab_jobs')} WHERE id = $1`, [row.jobId])
    return !j.length || j[0].state !== 'running'
  }

  /** count a step against the run's limit (inside the step's transaction) */
  async function countStep(run: RunRow): Promise<void> {
    const r = await db().query<Row>(`UPDATE ${T('ab_flow_runs')} SET step_count = step_count + 1 WHERE id = $1 RETURNING step_count`, [run.id])
    if (Number(r[0]?.step_count) > FLOW_LIMITS.stepsPerRun) throw new StepError(`The run executed more than ${FLOW_LIMITS.stepsPerRun} steps (loops count every step inside).`, true, 'limit')
  }

  /** inside a transaction: the run must still be running (it was not cancelled or ended meanwhile) */
  async function lockActive(runId: string): Promise<RunRow> {
    const r = await loadRun(runId, true)
    if (!r || isRunTerminal(r.state)) throw new Yield('run ended')
    return r
  }

  /* ---------------------------------------------------------------- leaf steps */

  async function executeLeaf(run: RunRow, doc: FlowDoc, scope: string, step: Step, row: StepRow | null, job: { id: string; attempts: number }): Promise<unknown> {
    const key = `${scope}/${step.id}`
    if (!(await ownRow(row, job.id))) return { yielded: key }
    // a retry that is not due yet (the job came early): wait for its own job
    const retryAt = row?.data?.retryAt ? new Date(String(row.data.retryAt)) : null
    if (retryAt && retryAt.getTime() > Date.now() + 500) return { waitingForRetry: key }
    const attempt = row ? row.attempt : 1
    const work = { correlationId: run.correlationId, depth: run.depth + 1, chain: run.chain, jobId: job.id }
    try {
      if (EXTERNAL_KINDS.has(step.kind)) {
        // record the attempt before the call (at least once, with the key run:step)
        await db().tx(async () => {
          await lockActive(run.id)
          if (!row) {
            const ins = await db().query<Row>(
              `INSERT INTO ${T('ab_flow_steps')} (run_id, step_key, step_id, scope, name, kind, state, attempt, job_id, started_on) VALUES ($1, $2, $3, $4, $5, $6, 'running', 1, $7, now())
               ON CONFLICT (run_id, step_key) DO NOTHING RETURNING 1`,
              [run.id, key, step.id, scope, step.name, step.kind, job.id],
            )
            if (!ins.length) throw new Yield('claimed elsewhere')
            await countStep(run)
          } else await db().exec(`UPDATE ${T('ab_flow_steps')} SET job_id = $3 WHERE run_id = $1 AND step_key = $2`, [run.id, key, job.id])
        })
        fault('external:after-claim', { runId: run.id, key, kind: step.kind })
        const c = await stepCtx(run, doc, scope, step)
        const res = await runWithWork(work, () => external(c, attempt))
        fault('external:after-call', { runId: run.id, key, kind: step.kind })
        await db().tx(async () => {
          await lockActive(run.id)
          await finishStep(run.id, key, 'succeeded', res.output, null, res.input)
          if (run.dryRun) await db().exec(`UPDATE ${T('ab_flow_steps')} SET simulated = true WHERE run_id = $1 AND step_key = $2`, [run.id, key])
          await enqueueAdvance(run.id, scope, `${step.id}:done`)
        })
        live([run.id])
        return { step: key, state: 'succeeded' }
      }
      if (SUSPEND_KINDS.has(step.kind)) return await suspend(run, doc, scope, step, row, job)
      // internal and data steps: the effect, the step row and the next advance in one transaction
      const t0 = new Date()
      const c = await stepCtx(run, doc, scope, step)
      const outcome = await db().tx(async () => {
        const r = await lockActive(run.id)
        const cur = (await db().query<Row>(`SELECT * FROM ${T('ab_flow_steps')} WHERE run_id = $1 AND step_key = $2`, [run.id, key])).map(toStep)[0]
        if (cur && isTerminal(cur.state)) throw new Yield('done elsewhere')
        if (!cur) await countStep(r)
        c.run = r
        const res = await runWithWork(work, () => internal(c))
        if (res.terminate) {
          await upsertStep(run.id, scope, step, 'succeeded', res.output, res.input, job.id, attempt, false, null, t0)
          return { terminate: res.terminate }
        }
        await upsertStep(run.id, scope, step, 'succeeded', res.output, res.input, job.id, attempt, res.simulated, null, t0)
        await enqueueAdvance(run.id, scope, `${step.id}:done`)
        fault('step:before-commit', { runId: run.id, key, kind: step.kind })
        return {}
      })
      fault('step:after-commit', { runId: run.id, key, kind: step.kind })
      if (outcome.terminate) {
        await finishRun(run.id, outcome.terminate.status, outcome.terminate.message ? { message: outcome.terminate.message, step: step.id } : null)
        return { terminated: outcome.terminate.status }
      }
      live([run.id])
      return { step: key, state: 'succeeded' }
    } catch (e) {
      if (e instanceof Yield) return { yielded: e.message }
      if (e instanceof FaultCrash) throw e
      return stepFailed(run, scope, step, attempt, classify(e), job)
    }
  }

  async function stepFailed(run: RunRow, scope: string, step: Step, attempt: number, err: StepError, job: { id: string }): Promise<unknown> {
    const key = `${scope}/${step.id}`
    const policy = retryPolicy(step)
    try {
      await db().tx(async () => {
        await lockActive(run.id)
        if (!err.permanent && attempt < policy.count) {
          const delay = retryDelayMs(policy, attempt)
          const at = new Date(Date.now() + delay)
          await db().exec(
            `INSERT INTO ${T('ab_flow_steps')} (run_id, step_key, step_id, scope, name, kind, state, attempt, error, data, job_id, started_on) VALUES ($1, $2, $3, $4, $5, $6, 'running', $7, $8::jsonb, $9::jsonb, $10, now())
             ON CONFLICT (run_id, step_key) DO UPDATE SET attempt = EXCLUDED.attempt, error = EXCLUDED.error, data = COALESCE(${T('ab_flow_steps')}.data, '{}'::jsonb) || EXCLUDED.data, job_id = NULL`,
            [run.id, key, step.id, scope, step.name, step.kind, attempt + 1, JSON.stringify({ message: err.message, ...(err.code ? { code: err.code } : {}) }), JSON.stringify({ retryAt: at.toISOString() }), job.id],
          )
          await enqueueAdvance(run.id, scope, `${step.id}:retry:${attempt}`, { runAt: at })
          return
        }
        await upsertStep(run.id, scope, step, 'failed', null, undefined, job.id, attempt, false, { message: err.message, ...(err.code ? { code: err.code } : {}), permanent: err.permanent })
        await enqueueAdvance(run.id, scope, `${step.id}:failed`)
      })
    } catch (e) {
      if (e instanceof Yield) return { yielded: e.message }
      throw e
    }
    live([run.id])
    return { step: key, state: err.permanent || attempt >= policy.count ? 'failed' : 'retry', error: err.message }
  }

  async function upsertStep(runId: string, scope: string, step: Step, state: StepStatus, output: unknown, input: unknown, jobId: string | null, attempt: number, simulated = false, error: unknown = null, startedAt: Date | null = null): Promise<void> {
    const out = output === undefined ? null : output
    if (sizeOf(out) > FLOW_LIMITS.stepOutputBytes) throw new StepError(`The step's output is larger than ${FLOW_LIMITS.stepOutputBytes / 1024} KB; select fewer columns or rows.`, true, 'limit')
    const disp = input === undefined ? null : forDisplay(input)
    await db().exec(
      `INSERT INTO ${T('ab_flow_steps')} (run_id, step_key, step_id, scope, name, kind, state, attempt, input, output, error, job_id, simulated, truncated, started_on, finished_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14, COALESCE($15::timestamptz, now()), now())
       ON CONFLICT (run_id, step_key) DO UPDATE SET state = EXCLUDED.state, attempt = EXCLUDED.attempt, input = COALESCE(EXCLUDED.input, ${T('ab_flow_steps')}.input),
         output = EXCLUDED.output, error = EXCLUDED.error, job_id = EXCLUDED.job_id, simulated = EXCLUDED.simulated, truncated = EXCLUDED.truncated, finished_on = now()`,
      [runId, `${scope}/${step.id}`, step.id, scope, step.name, step.kind, state, attempt, disp ? JSON.stringify(disp.value) : null, JSON.stringify(out), error ? JSON.stringify(error) : null, jobId, simulated, !!disp?.truncated, startedAt],
    )
  }

  async function finishStep(runId: string, key: string, state: StepStatus, output: unknown, error: unknown, input?: unknown): Promise<void> {
    const out = output === undefined ? null : output
    if (sizeOf(out) > FLOW_LIMITS.stepOutputBytes) throw new StepError(`The step's output is larger than ${FLOW_LIMITS.stepOutputBytes / 1024} KB.`, true, 'limit')
    const disp = input === undefined ? null : forDisplay(input)
    await db().exec(
      `UPDATE ${T('ab_flow_steps')} SET state = $3, output = $4::jsonb, error = $5::jsonb, finished_on = now(), input = COALESCE($6::jsonb, input), truncated = truncated OR $7 WHERE run_id = $1 AND step_key = $2`,
      [runId, key, state, JSON.stringify(out), error ? JSON.stringify(error) : null, disp ? JSON.stringify(disp.value) : null, !!disp?.truncated],
    )
  }

  /** internal and data steps: run inside the step's transaction */
  async function internal(c: StepCtx): Promise<{ output: unknown; input?: unknown; simulated?: boolean; terminate?: { status: RunStatus; message?: string } }> {
    const s = c.step
    switch (s.kind) {
      case 'compose': return { output: toStored(await fx(c, s.value, 'value')) }
      case 'setVariable': {
        const v = await fx(c, s.value, 'value')
        await db().exec(`UPDATE ${T('ab_flow_runs')} SET variables = COALESCE(variables, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb) WHERE id = $1`, [c.run.id, s.variable, JSON.stringify(toStored(v))])
        return { output: toStored(v), input: { variable: s.variable } }
      }
      case 'terminate': {
        const m = s.message ? await fx(c, s.message, 'message') : null
        return { output: null, terminate: { status: s.status, ...(m !== null ? { message: String(fxToJson(m)) } : {}) }, input: { status: s.status } }
      }
      case 'respond': {
        const b = await fx(c, s.body, 'body')
        const stored = toStored(b)
        if (sizeOf(stored) > FLOW_LIMITS.stepOutputBytes) throw new StepError('The response is larger than 1 MB.', true, 'limit')
        await db().exec(`UPDATE ${T('ab_flow_runs')} SET response = $2::jsonb, responded = true WHERE id = $1 AND NOT responded`, [c.run.id, JSON.stringify({ body: stored, status: s.status ?? 200 })])
        return { output: stored }
      }
      case 'data.get': case 'data.list': case 'data.create': case 'data.update': case 'data.delete':
        return dataStep(c)
      default:
        throw new StepError(`The step kind ${s.kind} cannot run here.`, true)
    }
  }

  async function dataStep(c: StepCtx): Promise<{ output: unknown; input?: unknown; simulated?: boolean }> {
    const s = c.step as Extract<Step, { kind: 'data.get' | 'data.list' | 'data.create' | 'data.update' | 'data.delete' }>
    const t = tableNamed(c.tables, s.table)
    const data = deps.data()
    const cols = new Map(t.columns.map((x) => [x.name, x]))
    const values = async (): Promise<Record<string, QueryValue>> => {
      const out: Record<string, QueryValue> = {}
      for (const [k, f] of Object.entries((s as { values?: Record<string, unknown> }).values ?? {})) {
        const col = cols.get(k)
        if (!col) throw new StepError(`${t.displayName} has no column "${k}".`, true)
        out[k] = fromFx(col, await fx(c, f, `values.${k}`)) as QueryValue
      }
      return out
    }
    const asRecord = (raw: Record<string, unknown> | null): unknown => (raw ? toStored({ ...recordOf(t, raw), ...(raw.id ? { __id: String(raw.id) } : {}) }) : null)
    switch (s.kind) {
      case 'data.get': {
        const id = rowIdOf(await fx(c, s.rowId, 'rowId'))
        if (!id) throw new StepError('rowId is blank.', true)
        const r = await runPlan(c.ev, t, { version: 2, table: t.name, filter: { col: 'id', op: 'eq', value: id }, single: true } as QueryPlan)
        const rec = r.rows[0] ?? null
        if (!rec && s.failIfMissing !== false) throw new StepError(`${t.displayName}: there is no row ${id}, or ${c.ident.user.name} may not read it.`, true, 'not-found')
        return { output: toStored(rec), input: { table: t.name, rowId: id } }
      }
      case 'data.list': {
        const top = Math.max(1, Math.min(5000, s.top ?? 100))
        let plan: QueryPlan = { version: 2, table: t.name }
        if (s.filter) {
          const a = analyze(`=Filter(${t.name}, ${String(s.filter).replace(/^\s*=/, '')})`, schemaOf(c.tables), { scope: c.fxScope, engine, clientRowLimit: 5000 })
          const err = a.diagnostics.find((d) => d.severity === 'error')
          if (err || a.plans.length !== 1 || a.residual) throw new StepError(`filter: ${err?.message ?? 'the filter cannot be read in the database (it must be delegable).'}`, true)
          plan = { ...a.plans[0].plan }
        }
        if (s.sort?.length) plan.sort = s.sort.map((x) => ({ col: x.column, dir: x.descending ? 'desc' as const : 'asc' as const }))
        plan.take = { n: top, from: 'start' }
        if (s.select?.length) plan.select = s.select
        const r = await runPlan(c.ev, t, plan)
        return { output: toStored(r.rows), input: { table: t.name, filter: plan.filter ?? null, top } }
      }
      case 'data.create': {
        const v = await values()
        const id = stableUuid(`${c.run.id}:${c.key}`)
        if (c.run.dryRun) return { output: toStored({ ...recordOf(t, v as Record<string, unknown>), id, __id: id }), input: { table: t.name, values: v }, simulated: true }
        // a retry of a write that reached another connection (no shared transaction): the row is there already
        const conn = await data.internals.connectorFor(t)
        const exists = await conn.select(data.internals.physical(t), { where: { col: 'id', op: 'eq', value: id }, top: 1, select: ['id'] })
        if (exists.rows.length) {
          const cur = await runPlan(c.ev, t, { version: 2, table: t.name, filter: { col: 'id', op: 'eq', value: id }, single: true } as QueryPlan)
          return { output: toStored(cur.rows[0] ?? { id }), input: { table: t.name, values: v } }
        }
        const created = await runWithWork({ chain: [...c.run.chain, `flow:${c.run.flowId}:${id}`].slice(-32) }, () => data.insert(c.ident, t, { ...v, id }))
        return { output: asRecord(created as Record<string, unknown>), input: { table: t.name, values: v } }
      }
      case 'data.update': {
        const id = rowIdOf(await fx(c, s.rowId, 'rowId'))
        if (!id) throw new StepError('rowId is blank.', true)
        const v = await values()
        if (c.run.dryRun) {
          const cur = await runPlan(c.ev, t, { version: 2, table: t.name, filter: { col: 'id', op: 'eq', value: id }, single: true } as QueryPlan)
          return { output: toStored({ ...(cur.rows[0] ?? { id }), ...recordOf(t, v as Record<string, unknown>), id }), input: { table: t.name, rowId: id, values: v }, simulated: true }
        }
        const updated = await runWithWork({ chain: [...c.run.chain, `flow:${c.run.flowId}:${id}`].slice(-32) }, () => data.update(c.ident, t, id, v))
        return { output: asRecord(updated as Record<string, unknown>), input: { table: t.name, rowId: id, values: v } }
      }
      case 'data.delete': {
        const id = rowIdOf(await fx(c, s.rowId, 'rowId'))
        if (!id) throw new StepError('rowId is blank.', true)
        if (c.run.dryRun) return { output: { Deleted: true }, input: { table: t.name, rowId: id }, simulated: true }
        try {
          await runWithWork({ chain: [...c.run.chain, `flow:${c.run.flowId}:${id}`].slice(-32) }, () => data.delete(c.ident, t, [id]))
        } catch (e) {
          // already gone (a retry, or someone else): deleted is deleted
          if (!(e instanceof HttpError && e.status === 404)) throw e
        }
        return { output: { Deleted: true }, input: { table: t.name, rowId: id } }
      }
    }
  }

  /** principals of `to` / `approvers`: user ids, emails, team:<id> */
  function principals(v: FxValue): string[] {
    const out: string[] = []
    const add = (x: FxValue): void => {
      if (x === null || x === undefined) return
      if (Array.isArray(x)) { for (const y of x) add(y); return }
      if (isRecord(x)) {
        const r = x as FxRecord
        const val = r.Email ?? r.Id ?? r.Value ?? r.__id ?? r.id ?? null
        if (val !== null) add(val)
        return
      }
      for (const part of String(x).split(/[;,]/)) if (part.trim()) out.push(part.trim())
    }
    add(v)
    return [...new Set(out)]
  }

  async function userIdsOf(list: string[]): Promise<{ userIds: string[]; teamIds: string[]; unknown: string[] }> {
    const userIds: string[] = []
    const teamIds: string[] = []
    const unknown: string[] = []
    for (const p of list) {
      if (/^team:/i.test(p)) { teamIds.push(p.slice(5)); continue }
      const u = p.includes('@') ? await deps.meta().users.byEmail(p) : await deps.meta().users.get(p)
      if (u) userIds.push(u.id)
      else unknown.push(p)
    }
    return { userIds, teamIds, unknown }
  }

  async function connectionFor(c: StepCtx, ref: string | undefined, kind: string): Promise<string> {
    if (ref) {
      const conns = await deps.store.connections(c.run.flowId)
      const hit = conns.find((x) => x.ref === ref)
      if (!hit) throw new StepError(`The flow has no connection "${ref}" (attach one under that name).`, true, 'connection')
      return hit.connectionId
    }
    const list = (await deps.meta().connections.list()).filter((x) => x.connector === kind)
    const pick = list.length === 1 ? list[0] : list.find((x) => x.isDefault)
    if (!pick) throw new StepError(list.length ? `There are several ${kind} connections: name one in the step.` : `There is no ${kind} connection in this environment.`, true, 'connection')
    return pick.id
  }

  function actionError(r: Extract<ActionResult, { ok: false }>): StepError {
    return new StepError(r.error.message, !r.error.retryable, r.error.code)
  }

  /** dry runs: side effects are reported, not made */
  const simulatedActions = { run: async (_env: string, _conn: string, action: string, inputs: unknown, ..._rest: unknown[]): Promise<ActionResult> => ({ ok: true, output: action === 'request' ? { status: 200, headers: {}, body: { simulated: true } } : { simulated: true, inputs } }) }

  /** external steps: outside any transaction, with the idempotency key run:step */
  async function external(c: StepCtx, attempt: number): Promise<{ output: unknown; input: unknown }> {
    const s = c.step
    const idem = `${c.run.id}:${c.key}`
    const timeoutMs = s.timeoutMinutes ? Math.round(s.timeoutMinutes * 60_000) : undefined
    const opts = { idempotencyKey: idem, correlationId: c.run.correlationId, source: `flow:${c.run.flowId}`, ...(timeoutMs ? { timeoutMs } : {}) }
    void attempt
    switch (s.kind) {
      case 'notify': {
        const who = principals(await fx(c, s.to, 'to'))
        const title = String(fxToJson(await fx(c, s.title, 'title')) ?? '').slice(0, 200)
        const body = s.body ? String(fxToJson(await fx(c, s.body, 'body')) ?? '') : ''
        const link = s.link ? String(fxToJson(await fx(c, s.link, 'link')) ?? '') : ''
        if (link && !link.startsWith('#')) throw new StepError('link must be a link inside Appbuilder that starts with #.', true)
        const ids = await userIdsOf(who)
        const input = { to: who, title, body, link, channels: s.channels }
        if (!ids.userIds.length && !ids.teamIds.length) throw new StepError(`Nobody to notify: ${who.join(', ') || 'blank'} matched no user or team.`, true)
        if (c.run.dryRun) return { output: { Delivered: [], Skipped: [], Simulated: true }, input }
        const svc = deps.notifications()
        if (!svc) throw new StepError('Notifications are not available on this server.', false)
        const res = await svc.notify({ userIds: ids.userIds, teamIds: ids.teamIds }, {
          kind: 'flow', title, ...(body ? { body: body.slice(0, 4000) } : {}), link: link || null, environmentId: env().id, source: `flow:${c.run.flowId}`,
          ...({ channels: s.channels, idempotencyKey: idem } as object),
        })
        return { output: { Delivered: res.delivered, Skipped: [...res.skipped, ...ids.unknown] }, input }
      }
      case 'email': {
        const svc = c.run.dryRun ? simulatedActions : deps.actions()
        if (!svc) throw new StepError('Sending email from flows is not available on this server yet.', false, 'unavailable')
        const conn = await connectionFor(c, s.connection, 'email')
        const list = async (f: unknown, field: string) => principals(await fx(c, f, field))
        const inputs = {
          to: await list(s.to, 'to'), ...(s.cc ? { cc: await list(s.cc, 'cc') } : {}), subject: String(fxToJson(await fx(c, s.subject, 'subject')) ?? ''),
          body: String(fxToJson(await fx(c, s.body, 'body')) ?? ''), ...(s.attachments ? { attachments: fxToJson(await fx(c, s.attachments, 'attachments')) } : {}),
        }
        const r = await svc.run(env().id, conn, 'send', inputs, c.ident, opts)
        if (!r.ok) throw actionError(r)
        return { output: toStored(jsonToFx(r.output)), input: inputs }
      }
      case 'action': {
        const svc = c.run.dryRun ? simulatedActions : deps.actions()
        if (!svc) throw new StepError('Connector actions are not available on this server yet.', false, 'unavailable')
        const conn = await connectionFor(c, s.connection, '')
        const inputs: Record<string, unknown> = {}
        for (const [k, f] of Object.entries(s.inputs ?? {})) inputs[k] = fxToJson(await fx(c, f, `inputs.${k}`))
        const r = await svc.run(env().id, conn, s.action, inputs, c.ident, opts)
        if (!r.ok) throw actionError(r)
        return { output: toStored(jsonToFx(r.output)), input: { connection: s.connection, action: s.action, inputs } }
      }
      case 'http': {
        const svc = c.run.dryRun ? simulatedActions : deps.actions()
        if (!svc) throw new StepError('HTTP requests from flows are not available on this server yet.', false, 'unavailable')
        const conn = await connectionFor(c, s.auth, 'http')
        const headers: Record<string, string> = {}
        for (const [k, f] of Object.entries(s.headers ?? {})) headers[k] = String(fxToJson(await fx(c, f, `headers.${k}`)) ?? '')
        const method = String(s.method).toUpperCase()
        if ((method === 'POST' || method === 'PATCH') && !Object.keys(headers).some((h) => h.toLowerCase() === 'idempotency-key')) headers['Idempotency-Key'] = createHash('sha256').update(idem).digest('hex').slice(0, 32)
        const inputs = { method, url: String(fxToJson(await fx(c, s.url, 'url')) ?? ''), headers, ...(s.body !== undefined ? { body: fxToJson(await fx(c, s.body, 'body')) } : {}) }
        const r = await svc.run(env().id, conn, 'request', inputs, c.ident, opts)
        if (!r.ok) throw actionError(r)
        const o = (r.output ?? {}) as { status?: number; headers?: unknown; body?: unknown }
        const output = { Status: o.status ?? 0, Headers: jsonToFx(o.headers ?? {}), Body: jsonToFx(o.body ?? null) }
        return { output: toStored(output as FxValue), input: inputs }
      }
      default:
        throw new StepError(`The step kind ${s.kind} cannot run here.`, true)
    }
  }

  /* ---------------------------------------------------------------- suspending steps */

  async function suspend(run: RunRow, doc: FlowDoc, scope: string, step: Step, row: StepRow | null, job: { id: string }): Promise<unknown> {
    const key = `${scope}/${step.id}`
    if (row?.state === 'waiting') return { waiting: key }
    const c = await stepCtx(run, doc, scope, step)
    const now = clock.now()
    const timeoutAt = step.timeoutMinutes ? new Date(now.getTime() + step.timeoutMinutes * 60_000) : null
    const waitId = `wait_${stableUuid(`${run.id}:${key}`).replace(/-/g, '').slice(0, 24)}`
    // a dry run does not wait: delays pass, approvals answer the simulated outcome, child flows run as dry runs
    if (run.dryRun && step.kind !== 'callFlow') {
      const output = step.kind === 'approval'
        ? { Outcome: run.options.approvalOutcome ?? (step.options?.[0] ?? 'Approve'), Responses: [], ApprovalId: 'simulated', CompletedOn: { $d: now.toISOString() }, Comments: '' }
        : step.kind === 'delay' ? { ResumedOn: { $d: now.toISOString() } } : { Body: null, ReceivedOn: { $d: now.toISOString() } }
      await db().tx(async () => {
        await lockActive(run.id)
        await countStep(run)
        await upsertStep(run.id, scope, step, 'succeeded', output, { kind: step.kind }, job.id, 1, true)
        await enqueueAdvance(run.id, scope, `${step.id}:done`)
      })
      live([run.id])
      return { simulated: key }
    }
    let wakeAt: Date | null = null
    let input: Record<string, unknown> = {}
    let approvalReq: Parameters<ApprovalsService['request']>[1] | null = null
    let child: { flowId: string; inputs: Record<string, unknown> } | null = null
    try {
      if (step.kind === 'delay') {
        if (step.minutes !== undefined) wakeAt = new Date(now.getTime() + Number(step.minutes) * 60_000)
        else {
          const u = await fx(c, step.until, 'until')
          const d = u instanceof Date ? u : new Date(String(u))
          if (Number.isNaN(d.getTime())) throw new StepError('until is not a date and time.', true)
          wakeAt = d
        }
        input = { wakeAt: wakeAt.toISOString() }
      } else if (step.kind === 'approval') {
        const svc = deps.approvals()
        if (!svc) throw new StepError('Approvals are not available on this server yet.', false, 'unavailable')
        const title = String(fxToJson(await fx(c, step.title, 'title')) ?? '')
        const details = step.details ? String(fxToJson(await fx(c, step.details, 'details')) ?? '') : undefined
        const approvers = step.approvers !== undefined && step.approvers !== '' ? principals(await fx(c, step.approvers, 'approvers')) : []
        // P1-C: a policy may name the approvers instead of the step
        if (!approvers.length && !step.policy) throw new StepError('Nobody to ask: approvers is blank.', true)
        let regarding: { tableId: string; rowId: string } | undefined
        if (step.regarding) regarding = { tableId: tableNamed(c.tables, step.regarding.table).id, rowId: rowIdOf(await fx(c, step.regarding.rowId, 'regarding.rowId')) }
        // P1-C: fields shown to approvers (and read by a policy's threshold rules)
        let fields: Record<string, unknown> | undefined
        if (step.fields && Object.keys(step.fields).length) {
          fields = {}
          for (const [k, f] of Object.entries(step.fields)) fields[k] = fxToJson(await fx(c, f, `fields.${k}`))
        }
        const definition: Record<string, unknown> = {}
        for (const k of ['quorum', 'stages', 'dueMinutes', 'reminders', 'escalation', 'allowSelfApproval', 'separationOfDuties', 'requireCommentOnReject'] as const) if (step[k] !== undefined) definition[k] = step[k]
        approvalReq = {
          environmentId: env().id, runId: run.id, flowId: run.flowId, flowName: run.flowName, stepKey: key, stepName: step.name, waitId, title, ...(details ? { details } : {}),
          approvers, type: step.type ?? 'single', options: step.options?.length ? step.options : ['Approve', 'Reject'], ...(regarding ? { regarding } : {}),
          requestedBy: run.runAs, ...(timeoutAt ? { dueOn: timeoutAt.toISOString() } : {}), idempotencyKey: `${run.id}:${key}`,
          ...(step.policy ? { policy: step.policy } : {}), ...(fields ? { fields } : {}), ...(Object.keys(definition).length ? { definition } : {}),
          ...(step.type === undefined ? { typeGiven: false } : {}), ...(step.options?.length ? {} : { optionsGiven: false }),
        }
        input = { title, approvers, type: approvalReq.type, options: approvalReq.options, ...(regarding ? { regarding } : {}), ...(step.policy ? { policy: step.policy } : {}), ...(fields ? { fields } : {}) }
      } else if (step.kind === 'callFlow') {
        const target = await deps.store.resolve(step.flow)
        if (!target) throw new StepError(`There is no flow "${step.flow}".`, true)
        if (target.trigger?.type !== 'manual') throw new StepError(`"${target.name}" cannot be called (it has no manual trigger).`, true)
        if (!target.enabled && run.mode === 'normal') throw new StepError(`"${target.name}" is turned off.`, true)
        if (run.callDepth + 1 > FLOW_LIMITS.callDepth) throw new StepError(`Child flows are nested more than ${FLOW_LIMITS.callDepth} deep.`, true, 'limit')
        const inputs: Record<string, unknown> = {}
        for (const [k, f] of Object.entries(step.inputs ?? {})) inputs[k] = await fx(c, f, `inputs.${k}`)
        child = { flowId: target.id, inputs }
        input = { flow: target.name, inputs: fxToJson(inputs as FxRecord) }
      } else if (step.kind === 'waitForCallback') {
        input = { url: await callbackUrl(run.id, key) }
      }
    } catch (e) {
      return stepFailed(run, scope, step, row?.attempt ?? 1, classify(e), job)
    }
    let resumeNow: { outcome: WaitOutcome } | null = null
    try {
      await db().tx(async () => {
        const r = await lockActive(run.id)
        const cur = (await db().query<Row>(`SELECT state FROM ${T('ab_flow_steps')} WHERE run_id = $1 AND step_key = $2`, [run.id, key]))[0]
        if (cur && String(cur.state) !== 'running') throw new Yield('done elsewhere')
        if (!cur) await countStep(r)
        // a callback can arrive before the step waits: it was kept as an early wait row
        const early = (await db().query<Row>(`SELECT id, outcome FROM ${T('ab_flow_waits')} WHERE run_id = $1 AND step_key = $2`, [run.id, key]))[0]
        if (early && step.kind !== 'waitForCallback') throw new Yield('wait exists')
        await db().exec(
          `INSERT INTO ${T('ab_flow_steps')} (run_id, step_key, step_id, scope, name, kind, state, attempt, input, output, job_id, started_on) VALUES ($1, $2, $3, $4, $5, $6, 'waiting', $7, $8::jsonb, $9::jsonb, $10, now())
           ON CONFLICT (run_id, step_key) DO UPDATE SET state = 'waiting', input = EXCLUDED.input, output = EXCLUDED.output, job_id = EXCLUDED.job_id`,
          [run.id, key, step.id, scope, step.name, step.kind, row?.attempt ?? 1, JSON.stringify(forDisplay(input).value), step.kind === 'waitForCallback' ? JSON.stringify({ Url: input.url }) : null, job.id],
        )
        let approvalId: string | null = null
        if (approvalReq) approvalId = (await deps.approvals()!.request(env().id, approvalReq, c.ident)).id
        let childId: string | null = null
        if (child) {
          const target = (await deps.store.get(child.flowId))!
          const ch = await createRun({
            flowId: target.id, flowName: target.name, flowVersion: target.version, ownerId: target.ownerId, mode: run.mode, dryRun: run.dryRun, triggerKind: 'callFlow',
            triggerKey: `call:${run.id}:${key}`, triggerSummary: `called by ${run.flowName}`,
            trigger: { Inputs: await manualInputs(target.trigger, child.inputs), User: await userRecordOf(run) },
            runAs: target.runAs === 'triggeringUser' ? run.runAs : await runAsFor(target, run.runAs), runAsKind: typeof target.runAs === 'object' ? 'serviceAccount' : target.runAs,
            triggeredBy: run.runAs, correlationId: run.correlationId, chain: run.chain, depth: run.depth, callDepth: run.callDepth + 1, parentRunId: run.id, parentWaitId: waitId,
            variables: initialVariables(target.variables), timeoutMinutes: target.settings.timeoutMinutes, concurrencyKey: target.settings.concurrency === 'singleton' ? target.id : null,
            options: run.options,
          })
          childId = ch.id
        }
        if (early) {
          resumeNow = { outcome: parseJ<WaitOutcome>(early.outcome, { kind: 'callback', body: null }) }
          await db().exec(`UPDATE ${T('ab_flow_waits')} SET kind = 'callback', state = 'waiting', timeout_at = $2 WHERE id = $1`, [String(early.id), timeoutAt])
        } else {
          await db().exec(
            `INSERT INTO ${T('ab_flow_waits')} (id, run_id, step_key, kind, state, wake_at, timeout_at, approval_id, child_run_id, created_on) VALUES ($1, $2, $3, $4, 'waiting', $5, $6, $7, $8, $9)`,
            [waitId, run.id, key, step.kind === 'waitForCallback' ? 'callback' : step.kind, wakeAt, timeoutAt, approvalId, childId, now],
          )
        }
        await db().exec(`UPDATE ${T('ab_flow_runs')} SET state = 'waiting' WHERE id = $1 AND state = 'running'`, [run.id])
        fault('suspend:before-commit', { runId: run.id, key, kind: step.kind })
        if (resumeNow) await deps.jobs.enqueue(RESUME_JOB, { waitId: String(early!.id), outcome: (resumeNow as { outcome: WaitOutcome }).outcome, reason: 'external' }, { idempotencyKey: `resume:${String(early!.id)}` })
      })
    } catch (e) {
      if (e instanceof Yield) return { yielded: e.message }
      if (e instanceof FaultCrash) throw e
      return stepFailed(run, scope, step, row?.attempt ?? 1, classify(e), job)
    }
    fault('suspend:after-commit', { runId: run.id, key, kind: step.kind })
    live([run.id])
    return { waiting: key }
  }

  /* ---------------------------------------------------------------- resuming */

  /** inside the flow.resume job: the wait changes state once; the step gets its outcome; the container advances */
  async function resume(p: { waitId: string; outcome?: WaitOutcome; reason: 'wake' | 'timeout' | 'external' | 'child' }): Promise<unknown> {
    let runId = ''
    const res = await db().tx(async () => {
      const w = (await db().query<Row>(`SELECT * FROM ${T('ab_flow_waits')} WHERE id = $1 FOR UPDATE`, [p.waitId]))[0]
      if (!w || String(w.state) !== 'waiting') return { skipped: 'not waiting' }
      runId = String(w.run_id)
      const run = await loadRun(runId, true)
      if (!run || isRunTerminal(run.state)) {
        await db().exec(`UPDATE ${T('ab_flow_waits')} SET state = 'cancelled', resolved_on = now() WHERE id = $1`, [p.waitId])
        return { skipped: 'run ended' }
      }
      const key = String(w.step_key)
      const kind = String(w.kind)
      const now = clock.now()
      let state: StepStatus = 'succeeded'
      let output: unknown = null
      let error: unknown = null
      if (p.reason === 'timeout') {
        state = 'timedOut'
        error = { message: `No answer before the step's timeout.` }
        if (kind === 'approval' && w.approval_id) await deps.approvals()?.cancel?.(env().id, String(w.approval_id), 'timedOut').catch((e) => deps.log('warn', `approval ${String(w.approval_id)}: cancel after timeout: ${errText(e)}`))
        if (kind === 'callFlow' && w.child_run_id) await cancelRunTx(String(w.child_run_id), 'The parent step timed out.')
      } else if (kind === 'delay') output = { ResumedOn: { $d: now.toISOString() } }
      else if (kind === 'approval') {
        const o = (p.outcome ?? { kind: 'approval', outcome: '' }) as Extract<WaitOutcome, { kind: 'approval' }>
        // P1-C: Responses as a table of Approver (email), Name, Response, Comment, Time, Stage; Status and Approvers
        const responses = (o.responses ?? []).map((x) => ({
          Approver: x.email ?? x.userId, Name: x.name ?? '', Response: x.response, Comment: x.comment ?? '', Time: x.at ? new Date(x.at) : null, Stage: x.stage ?? 1, UserId: x.userId,
        }))
        output = toStored({
          Outcome: o.outcome, Status: o.status ?? '', Responses: responses as unknown as FxValue, Approvers: jsonToFx(o.approvers ?? []), ApprovalId: w.approval_id ? String(w.approval_id) : '',
          CompletedOn: o.completedOn ? new Date(o.completedOn) : now, Comments: o.comments ?? '',
        } as FxRecord)
      } else if (kind === 'callback') {
        const o = (p.outcome ?? { kind: 'callback', body: null }) as Extract<WaitOutcome, { kind: 'callback' }>
        output = toStored({ Body: jsonToFx(o.body), ReceivedOn: now } as FxRecord)
      } else if (kind === 'callFlow') {
        const o = p.outcome as unknown as { status: RunStatus; outputs: unknown; runId: string; error?: string }
        if (o?.status === 'succeeded') output = { Status: 'succeeded', Outputs: o.outputs ?? null, RunId: o.runId }
        else {
          state = 'failed'
          error = { message: `The child flow ${o?.status ?? 'ended'}${o?.error ? `: ${o.error}` : ''}.` }
          output = { Status: o?.status ?? 'failed', Outputs: o?.outputs ?? null, RunId: o?.runId ?? '' }
        }
      }
      await db().exec(`UPDATE ${T('ab_flow_waits')} SET state = $2, outcome = $3::jsonb, resolved_on = now() WHERE id = $1`, [p.waitId, p.reason === 'timeout' ? 'timedOut' : 'resumed', JSON.stringify(p.outcome ?? null)])
      await finishStep(runId, key, state, output, error)
      await db().exec(`UPDATE ${T('ab_flow_runs')} SET state = 'running' WHERE id = $1 AND state = 'waiting'`, [runId])
      const scope = key.slice(0, key.lastIndexOf('/'))
      await enqueueAdvance(runId, scope, `${key.slice(key.lastIndexOf('/') + 1)}:resumed`)
      fault('resume:before-commit', { runId, key, kind })
      return { resumed: key, state }
    })
    if (runId) fault('resume:after-commit', { runId, key: '', kind: '' })
    if (runId) live([runId])
    return res
  }

  /** from outside (approvals, callbacks): enqueue the resume; false when the wait is not waiting */
  async function resumeWait(waitId: string, outcome: WaitOutcome): Promise<{ resumed: boolean }> {
    const w = (await db().query<Row>(`SELECT state FROM ${T('ab_flow_waits')} WHERE id = $1`, [waitId]))[0]
    if (!w || String(w.state) !== 'waiting') return { resumed: false }
    const j = await deps.jobs.enqueue(RESUME_JOB, { waitId, outcome, reason: 'external' }, { idempotencyKey: `resume:${waitId}` })
    return { resumed: j.created }
  }

  /** a POST to a callback address: resume the waiting step, or keep the body until the step waits */
  async function callback(runId: string, keyB64: string, token: string, body: unknown, contentType?: string): Promise<'resumed' | 'kept' | 'gone'> {
    const key = await verifyCallback(runId, keyB64, token)
    if (!key) throw new HttpError(404, 'not-found', 'This callback address is not valid.')
    const outcome: WaitOutcome = { kind: 'callback', body, ...(contentType ? { contentType } : {}) }
    return db().tx(async () => {
      const run = await loadRun(runId, true)
      if (!run || isRunTerminal(run.state)) return 'gone' as const
      const w = (await db().query<Row>(`SELECT id, state, kind FROM ${T('ab_flow_waits')} WHERE run_id = $1 AND step_key = $2 FOR UPDATE`, [runId, key]))[0]
      if (!w) {
        // the step has not started waiting yet: keep the body; the step resumes at once when it gets there
        await db().exec(`INSERT INTO ${T('ab_flow_waits')} (id, run_id, step_key, kind, state, outcome, created_on) VALUES ($1, $2, $3, 'callback', 'early', $4::jsonb, now()) ON CONFLICT DO NOTHING`, [`wait_${stableUuid(`${runId}:${key}`).replace(/-/g, '').slice(0, 24)}`, runId, key, JSON.stringify(outcome)])
        return 'kept' as const
      }
      if (String(w.state) !== 'waiting' || String(w.kind) !== 'callback') return 'gone' as const
      const j = await deps.jobs.enqueue(RESUME_JOB, { waitId: String(w.id), outcome, reason: 'external' }, { idempotencyKey: `resume:${String(w.id)}` })
      return j.created ? 'resumed' as const : 'gone' as const
    })
  }

  /* ---------------------------------------------------------------- containers */

  async function enterContainer(run: RunRow, doc: FlowDoc, scope: string, step: Step, job: { id: string; attempts: number }): Promise<unknown> {
    const key = `${scope}/${step.id}`
    let c: StepCtx
    try {
      c = await stepCtx(run, doc, scope, step)
    } catch (e) {
      return stepFailed(run, scope, step, 1, classify(e), job)
    }
    let data: Record<string, unknown> = {}
    let child: string | null = null
    let empty: { output: unknown } | null = null
    let input: unknown
    try {
      switch (step.kind) {
        case 'condition': {
          const v = await fx(c, step.if, 'if')
          const branch = v === true ? 'then' : 'else'
          data = { branch }
          input = { result: v === true }
          const list = branch === 'then' ? step.then : step.else ?? []
          if (!list?.length) empty = { output: { Result: v === true, Branch: branch } }
          else child = `${key}.${branch}`
          break
        }
        case 'switch': {
          const v = await fx(c, step.on, 'on')
          const json = JSON.stringify(fxToJson(v))
          const idx = (step.cases ?? []).findIndex((k) => JSON.stringify(k.value ?? null) === json || (typeof k.value === 'string' && typeof v === 'string' && k.value.toLowerCase() === v.toLowerCase()))
          data = { case: idx < 0 ? 'default' : idx, value: toStored(v) }
          input = { value: fxToJson(v) }
          const list = idx < 0 ? step.default ?? [] : step.cases[idx].steps
          if (!list?.length) empty = { output: { Value: toStored(v), Case: idx < 0 ? 'default' : idx } }
          else child = `${key}${idx < 0 ? '.default' : `.case${idx}`}`
          break
        }
        case 'scope':
          if (!step.steps?.length) empty = { output: { Status: 'succeeded' } }
          else child = key
          break
        case 'forEach': {
          const v = await fx(c, step.items, 'items')
          const items = v === null ? [] : Array.isArray(v) ? v : [v]
          const max = Math.min(step.max ?? FLOW_LIMITS.loopIterations, FLOW_LIMITS.loopIterations)
          if (items.length > max) throw new StepError(`items has ${items.length} entries; the loop allows ${max} (max).`, true, 'limit')
          const stored = items.map((x) => toStored(x))
          if (sizeOf(stored) > FLOW_LIMITS.stepOutputBytes) throw new StepError('The items are larger than 1 MB; loop over ids and read each row inside the loop.', true, 'limit')
          data = { items: stored, total: items.length, nextIndex: 0, concurrency: Math.max(1, Math.min(FLOW_LIMITS.forEachConcurrency, step.concurrency ?? 1)) }
          input = { count: items.length, concurrency: data.concurrency }
          if (!items.length || !step.steps?.length) empty = { output: { Count: items.length, Succeeded: items.length, Failed: 0 } }
          break
        }
        case 'until':
          data = { iteration: 0, ...(step.timeoutMinutes ? { deadline: new Date(clock.now().getTime() + step.timeoutMinutes * 60_000).toISOString() } : {}) }
          input = { maxIterations: step.maxIterations }
          if (!step.steps?.length) throw new StepError('A Do until needs steps.', true)
          break
      }
    } catch (e) {
      return stepFailed(run, scope, step, 1, classify(e), job)
    }
    try {
      await db().tx(async () => {
        const r = await lockActive(run.id)
        const ins = await db().query<Row>(
          `INSERT INTO ${T('ab_flow_steps')} (run_id, step_key, step_id, scope, name, kind, state, attempt, input, output, data, job_id, started_on, finished_on)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8::jsonb, $9::jsonb, $10::jsonb, $11, now(), $12) ON CONFLICT (run_id, step_key) DO NOTHING RETURNING 1`,
          [run.id, key, step.id, scope, step.name, step.kind, empty ? 'succeeded' : 'running', JSON.stringify(input ?? null), JSON.stringify(empty?.output ?? null), JSON.stringify(data), job.id, empty ? new Date() : null],
        )
        if (!ins.length) throw new Yield('entered elsewhere')
        await countStep(r)
        if (empty) await enqueueAdvance(run.id, scope, `${step.id}:done`)
        else if (child) await enqueueAdvance(run.id, child, 'enter')
        else await progressLoop(r, doc, key, step)
        fault('enter:before-commit', { runId: run.id, key, kind: step.kind })
      })
      fault('enter:after-commit', { runId: run.id, key, kind: step.kind })
    } catch (e) {
      if (e instanceof Yield) return { yielded: e.message }
      if (e instanceof FaultCrash) throw e
      return stepFailed(run, scope, step, 1, classify(e), job)
    }
    live([run.id])
    return { entered: key }
  }

  /** a container step in progress was found by its parent's advance: make sure its children go on (idempotent) */
  async function kickContainer(run: RunRow, doc: FlowDoc, scope: string, step: Step, row: StepRow): Promise<unknown> {
    const key = `${scope}/${step.id}`
    if (step.kind === 'forEach' || step.kind === 'until') {
      await db().tx(async () => {
        const r = await lockActive(run.id)
        await progressLoop(r, doc, key, step)
      }).catch((e) => { if (!(e instanceof Yield)) throw e })
      return { progressed: key }
    }
    const d = row.data ?? {}
    const child = step.kind === 'condition' ? `${key}.${String(d.branch ?? 'else')}` : step.kind === 'switch' ? `${key}${d.case === 'default' ? '.default' : `.case${String(d.case)}`}` : key
    const n = await db().query<Row>(`SELECT count(*)::int AS n FROM ${T('ab_flow_steps')} WHERE run_id = $1 AND scope = $2`, [run.id, child])
    await enqueueAdvance(run.id, child, `kick:${Number(n[0]?.n) || 0}`)
    return { kicked: child }
  }

  /** start iterations up to the concurrency, or finish the loop; inside a transaction holding the run lock */
  async function progressLoop(run: RunRow, doc: FlowDoc, key: string, step: Step): Promise<void> {
    const scope = key.slice(0, key.lastIndexOf('/'))
    const loopRow = (await db().query<Row>(`SELECT * FROM ${T('ab_flow_steps')} WHERE run_id = $1 AND step_key = $2 FOR UPDATE`, [run.id, key])).map(toStep)[0]
    if (!loopRow || isTerminal(loopRow.state)) return
    const its = (await db().query<Row>(`SELECT step_key, state FROM ${T('ab_flow_steps')} WHERE run_id = $1 AND scope = $2 AND kind = 'iteration'`, [run.id, key]))
    const done = new Map<number, string>()
    const started = new Set<number>()
    for (const r of its) {
      const i = Number(String(r.step_key).slice(key.length + 1))
      started.add(i)
      if (isTerminal(String(r.state))) done.set(i, String(r.state))
    }
    const d = { ...(loopRow.data ?? {}) }
    const launch = async (i: number, item: unknown): Promise<void> => {
      await db().exec(
        `INSERT INTO ${T('ab_flow_steps')} (run_id, step_key, step_id, scope, name, kind, state, attempt, data, started_on) VALUES ($1, $2, $3, $4, $5, 'iteration', 'running', 1, $6::jsonb, now())
         ON CONFLICT (run_id, step_key) DO NOTHING`,
        [run.id, `${key}#${i}`, step.id, key, `${step.name}[${i}]`, JSON.stringify({ item: item ?? null })],
      )
      await enqueueAdvance(run.id, `${key}#${i}`, 'enter')
    }
    const finish = async (state: StepStatus, output: unknown, error?: unknown): Promise<void> => {
      await db().exec(`UPDATE ${T('ab_flow_steps')} SET state = $3, output = $4::jsonb, error = $5::jsonb, data = $6::jsonb, finished_on = now() WHERE run_id = $1 AND step_key = $2`,
        [run.id, key, state, JSON.stringify(output), error ? JSON.stringify(error) : null, JSON.stringify(step.kind === 'forEach' && state === 'succeeded' ? { ...d, items: undefined, total: d.total } : d)])
      await enqueueAdvance(run.id, scope, `${step.id}:${state}`)
    }
    if (step.kind === 'forEach') {
      const total = Number(d.total) || 0
      const items = (d.items as unknown[]) ?? []
      const conc = Number(d.concurrency) || 1
      let next = Number(d.nextIndex) || 0
      let inFlight = [...started].filter((i) => !done.has(i)).length
      while (next < total && inFlight < conc) {
        if (!started.has(next)) {
          await launch(next, items[next])
          inFlight++
        }
        next++
      }
      if (next !== d.nextIndex) {
        d.nextIndex = next
        await db().exec(`UPDATE ${T('ab_flow_steps')} SET data = jsonb_set(data, '{nextIndex}', to_jsonb($3::int)) WHERE run_id = $1 AND step_key = $2`, [run.id, key, next])
      }
      if (done.size >= total) {
        const failed = [...done.values()].filter((s) => s !== 'succeeded').length
        await finish(failed ? 'failed' : 'succeeded', { Count: total, Succeeded: total - failed, Failed: failed }, failed ? { message: `${failed} of ${total} iterations failed.` } : null)
      }
      return
    }
    // until: one iteration at a time; the condition is checked after each
    const i = Number(d.iteration) || 0
    if (!started.has(i)) {
      await launch(i, null)
      return
    }
    if (!done.has(i)) return
    const st = done.get(i)
    if (st !== 'succeeded') return finish('failed', { Iterations: i + 1 }, { message: `Iteration ${i + 1} failed.` })
    if (d.deadline && new Date(String(d.deadline)).getTime() <= clock.now().getTime()) return finish('timedOut', { Iterations: i + 1 }, { message: 'The loop ran longer than its timeout.' })
    const sc = await stepCtx(run, doc, `${key}#${i}`, step)
    const v = await fx(sc, (step as Extract<Step, { kind: 'until' }>).condition, 'condition')
    if (v === true) return finish('succeeded', { Iterations: i + 1 })
    const max = (step as Extract<Step, { kind: 'until' }>).maxIterations
    if (i + 1 >= max) return finish('failed', { Iterations: i + 1 }, { message: `The condition was still false after ${max} iterations (maxIterations).` })
    d.iteration = i + 1
    await db().exec(`UPDATE ${T('ab_flow_steps')} SET data = $3::jsonb WHERE run_id = $1 AND step_key = $2`, [run.id, key, JSON.stringify(d)])
    await launch(i + 1, null)
  }

  /** the outcome of a finished list: failed when a step failed or timed out and no later sibling handled it */
  function outcomeOf(list: Step[], rows: Map<string, StepRow>, scope: string): { state: StepStatus; error?: string } {
    const byId = (id: string) => rows.get(`${scope}/${id}`)
    for (const [i, s] of list.entries()) {
      const r = byId(s.id)
      if (!r || (r.state !== 'failed' && r.state !== 'timedOut')) continue
      const handled = list.slice(i + 1).some((x) => {
        const xr = byId(x.id)
        return xr && xr.state !== 'skipped' && (x.runAfter ?? []).some((ra) => ra.step === s.id && (ra.when as string[]).includes(r.state))
      })
      if (!handled) return { state: 'failed', error: `${s.name}: ${r.error?.message ?? r.state}` }
    }
    return { state: 'succeeded' }
  }

  async function completeContainer(run: RunRow, doc: FlowDoc, scope: string, c: Container, rows: Map<string, StepRow>): Promise<unknown> {
    const o = outcomeOf(c.list, rows, scope)
    if (scope === '') {
      await finishRun(run.id, o.state === 'succeeded' ? 'succeeded' : 'failed', o.error ? { message: o.error } : null)
      return { finished: o.state }
    }
    try {
      await db().tx(async () => {
        const r = await lockActive(run.id)
        if (c.index !== null) {
          // an iteration: its row, then the loop goes on
          await db().exec(`UPDATE ${T('ab_flow_steps')} SET state = $3, error = $4::jsonb, finished_on = now() WHERE run_id = $1 AND step_key = $2 AND state = 'running'`,
            [run.id, scope, o.state, o.error ? JSON.stringify({ message: o.error }) : null])
          await progressLoop(r, doc, c.ownerKey!, c.owner!)
          return
        }
        const k = c.ownerKey!
        const cur = (await db().query<Row>(`SELECT state, data FROM ${T('ab_flow_steps')} WHERE run_id = $1 AND step_key = $2 FOR UPDATE`, [run.id, k])).map((x) => x)[0]
        if (!cur || isTerminal(String(cur.state))) return
        const d = parseJ<Record<string, unknown>>(cur.data, {})
        const out = c.owner!.kind === 'condition' ? { Result: d.branch === 'then', Branch: d.branch } : c.owner!.kind === 'switch' ? { Value: d.value ?? null, Case: d.case } : { Status: o.state }
        await db().exec(`UPDATE ${T('ab_flow_steps')} SET state = $3, output = $4::jsonb, error = $5::jsonb, finished_on = now() WHERE run_id = $1 AND step_key = $2`,
          [run.id, k, o.state, JSON.stringify(out), o.error ? JSON.stringify({ message: o.error }) : null])
        await enqueueAdvance(run.id, c.parentScope, `${c.owner!.id}:${o.state}`)
      })
    } catch (e) {
      if (e instanceof Yield) return { yielded: e.message }
      throw e
    }
    live([run.id])
    return { completed: scope, state: o.state }
  }

  /* ---------------------------------------------------------------- the end of a run */

  async function failRun(runId: string, message: string): Promise<void> {
    await finishRun(runId, 'failed', { message })
  }

  /** inside a transaction (or alone): terminal state, waits closed, the parent resumed, the next queued run started */
  async function finishRun(runId: string, status: RunStatus, error: { message: string; step?: string } | null): Promise<boolean> {
    let notify: (() => Promise<void>) | null = null
    const done = await db().tx(async () => {
      const run = await loadRun(runId, true)
      if (!run || isRunTerminal(run.state)) return false
      await db().exec(`UPDATE ${T('ab_flow_runs')} SET state = $2, error = $3::jsonb, finished_on = now(), started_on = COALESCE(started_on, now()) WHERE id = $1`, [runId, status, error ? JSON.stringify(error) : null])
      await closeWaits(runId, status === 'cancelled' ? 'cancelled' : 'cancelled')
      if (run.parentWaitId) {
        const resp = (await db().query<Row>(`SELECT response FROM ${T('ab_flow_runs')} WHERE id = $1`, [runId]))[0]
        const outputs = parseJ<{ body?: unknown } | null>(resp?.response, null)?.body ?? null
        await deps.jobs.enqueue(RESUME_JOB, { waitId: run.parentWaitId, outcome: { status, outputs, runId, ...(error ? { error: error.message } : {}) }, reason: 'child' }, { idempotencyKey: `resume:${run.parentWaitId}` })
      }
      await startNext(run.concurrencyKey)
      if ((status === 'failed' || status === 'timedOut') && run.mode === 'normal') notify = await recordFailure(run, error?.message ?? status)
      return true
    })
    if (done) live([runId])
    if (notify) await (notify as () => Promise<void>)().catch((e) => deps.log('warn', `flow failure notification: ${errText(e)}`))
    return done
  }

  /** waits of a run are closed (approvals cancelled, child runs cancelled) */
  async function closeWaits(runId: string, state: 'cancelled'): Promise<void> {
    const ws = await db().query<Row>(`UPDATE ${T('ab_flow_waits')} SET state = $2, resolved_on = now() WHERE run_id = $1 AND state IN ('waiting', 'early') RETURNING id, kind, approval_id, child_run_id`, [runId, state])
    for (const w of ws) {
      if (w.approval_id) await deps.approvals()?.cancel?.(env().id, String(w.approval_id), 'cancelled').catch((e) => deps.log('warn', `approval ${String(w.approval_id)}: cancel: ${errText(e)}`))
      if (w.child_run_id) await cancelRunTx(String(w.child_run_id), 'The parent run ended.')
    }
    await db().exec(`UPDATE ${T('ab_flow_steps')} SET state = 'cancelled', finished_on = now() WHERE run_id = $1 AND state IN ('running', 'waiting')`, [runId])
  }

  /** first failure of a flow: the owner hears at once; later ones go into the daily digest (owner and administrators) */
  async function recordFailure(run: RunRow, message: string): Promise<(() => Promise<void>) | null> {
    const r = await db().query<Row>(
      `INSERT INTO ${T('ab_flow_alerts')} (flow_id, last_notified_on, pending, last_error, last_failure_on) VALUES ($1, now(), 0, $2, now())
       ON CONFLICT (flow_id) DO UPDATE SET
         pending = CASE WHEN ${T('ab_flow_alerts')}.last_notified_on IS NULL OR ${T('ab_flow_alerts')}.last_notified_on < now() - interval '24 hours' THEN 0 ELSE ${T('ab_flow_alerts')}.pending + 1 END,
         last_notified_on = CASE WHEN ${T('ab_flow_alerts')}.last_notified_on IS NULL OR ${T('ab_flow_alerts')}.last_notified_on < now() - interval '24 hours' THEN now() ELSE ${T('ab_flow_alerts')}.last_notified_on END,
         last_error = EXCLUDED.last_error, last_failure_on = now()
       RETURNING pending`, [run.flowId, message.slice(0, 1000)],
    )
    if (Number(r[0]?.pending) !== 0 || !run.ownerId) return null
    const envId = env().id
    const owner = run.ownerId
    return async () => {
      await deps.notifications()?.notify({ userIds: [owner] }, {
        kind: 'flow', title: `Flow "${run.flowName}" failed`, body: `${message.slice(0, 500)}\nLater failures within a day are collected in a daily summary.`,
        link: `#flows`, environmentId: envId, source: `flow:${run.flowId}`,
      })
    }
  }

  /** the daily digest of failures after the first one */
  async function digest(): Promise<{ sent: number }> {
    const rows = await db().query<Row>(`SELECT a.flow_id, a.pending, a.last_error, f.name, f.owner_id FROM ${T('ab_flow_alerts')} a JOIN ${T('ab_flows')} f ON f.id = a.flow_id WHERE a.pending > 0`)
    if (!rows.length) return { sent: 0 }
    const admins = await adminIds()
    for (const r of rows) {
      await deps.notifications()?.notify({ userIds: [...new Set([String(r.owner_id), ...admins])] }, {
        kind: 'flow', title: `Flow "${String(r.name)}" failed ${Number(r.pending)} more time(s) in the last day`, body: `Last error: ${String(r.last_error ?? '').slice(0, 500)}`,
        link: '#flows', environmentId: env().id, source: `flow:${String(r.flow_id)}`,
      }).catch((e) => deps.log('warn', `flow digest: ${errText(e)}`))
      await db().exec(`UPDATE ${T('ab_flow_alerts')} SET pending = 0, last_notified_on = now() WHERE flow_id = $1`, [String(r.flow_id)])
    }
    return { sent: rows.length }
  }

  /** cancel inside the current transaction (children of a cancelled run, a timed-out callFlow) */
  async function cancelRunTx(runId: string, why: string): Promise<boolean> {
    return finishRun(runId, 'cancelled', { message: why })
  }

  async function cancelRun(runId: string, by: string | null): Promise<boolean> {
    const ok = await finishRun(runId, 'cancelled', { message: by ? 'Cancelled by a person.' : 'Cancelled.' })
    if (ok) {
      const kids = await db().query<Row>(`SELECT id FROM ${T('ab_flow_runs')} WHERE parent_run_id = $1 AND state IN ('queued', 'running', 'waiting')`, [runId])
      for (const k of kids) await cancelRun(String(k.id), by)
    }
    return ok
  }

  async function timeout(runId: string): Promise<unknown> {
    const run = await loadRun(runId)
    if (!run || isRunTerminal(run.state)) return { skipped: 'ended' }
    const doc = await docFor(run)
    await finishRun(runId, 'timedOut', { message: `The run took longer than ${doc.settings?.timeoutMinutes ?? '?'} minutes (settings.timeoutMinutes).` })
    return { timedOut: runId }
  }

  /* ---------------------------------------------------------------- sweeper (worker tick) */

  const lastSweep = new Map<string, number>()
  /** due waits and run deadlines -> resume / timeout jobs (keys make it safe to run often and on many servers) */
  async function sweep(force = false): Promise<number> {
    const envId = env().id
    if (!force && Date.now() - (lastSweep.get(envId) ?? 0) < 500) return 0
    lastSweep.set(envId, Date.now())
    const now = clock.now()
    let n = 0
    const due = await db().query<Row>(
      `SELECT id, CASE WHEN wake_at IS NOT NULL AND wake_at <= $1 THEN 'wake' ELSE 'timeout' END AS reason FROM ${T('ab_flow_waits')}
        WHERE state = 'waiting' AND ((wake_at IS NOT NULL AND wake_at <= $1) OR (timeout_at IS NOT NULL AND timeout_at <= $1)) ORDER BY id LIMIT 200`, [now],
    )
    for (const w of due) {
      const j = await deps.jobs.enqueue(RESUME_JOB, { waitId: String(w.id), reason: String(w.reason) }, { idempotencyKey: `resume:${String(w.id)}` })
      if (j.created) n++
    }
    const late = await db().query<Row>(`SELECT id FROM ${T('ab_flow_runs')} WHERE state IN ('queued', 'running', 'waiting') AND deadline_at <= $1 LIMIT 200`, [now])
    for (const r of late) {
      const j = await deps.jobs.enqueue(TIMEOUT_JOB, { runId: String(r.id) }, { idempotencyKey: `timeout:${String(r.id)}` })
      if (j.created) n++
    }
    return n
  }

  /* ---------------------------------------------------------------- resubmit */

  /** a new run with the same trigger: from the start, or keeping the steps that succeeded (the failed ones run again) */
  async function resubmit(runId: string, from: 'start' | 'failed', by: string | null): Promise<{ id: string }> {
    const old = await loadRun(runId)
    if (!old) throw new HttpError(404, 'not-found', 'Run not found.')
    if (!isRunTerminal(old.state)) throw new HttpError(409, 'conflict', 'The run has not ended yet; cancel it first.')
    if (from === 'failed' && old.state === 'succeeded') throw new HttpError(409, 'conflict', 'The run succeeded: there is no failed step to run again.')
    const doc = await docFor(old)
    const flow = await deps.store.get(old.flowId)
    if (!flow) throw new HttpError(404, 'not-found', 'The flow no longer exists.')
    return db().tx(async () => {
      const id = `run_${randomBytes(9).toString('base64url')}`
      let variables: Record<string, unknown> = initialVariables(doc.variables)
      if (from === 'failed') {
        // keep what succeeded; containers that failed run again from their first step that did not succeed
        const rows = (await db().query<Row>(`SELECT * FROM ${T('ab_flow_steps')} WHERE run_id = $1 ORDER BY ord`, [runId])).map(toStep)
        const failedContainers = new Set(rows.filter((r) => isContainer(r.kind) && r.state !== 'succeeded' && r.state !== 'skipped').map((r) => r.key))
        for (const r of rows) {
          let state: string | null = null
          if (r.state === 'succeeded') state = 'succeeded'
          else if (failedContainers.has(r.key) || r.kind === 'iteration') state = 'running'
          if (!state) continue
          // an iteration that failed runs again: its row goes; a loop starts again from the first unfinished iteration
          if (r.kind === 'iteration' && state === 'running') continue
          const data = r.kind === 'forEach' && state === 'running' ? { ...(r.data ?? {}), nextIndex: 0 } : r.data
          await db().exec(
            `INSERT INTO ${T('ab_flow_steps')} (run_id, step_key, step_id, scope, name, kind, state, attempt, input, output, error, data, simulated, truncated, started_on, finished_on)
             SELECT $2, step_key, step_id, scope, name, kind, $4, attempt, input, output, CASE WHEN $4 = 'running' THEN NULL ELSE error END, $5::jsonb, simulated, truncated, started_on, CASE WHEN $4 = 'running' THEN NULL ELSE finished_on END
               FROM ${T('ab_flow_steps')} WHERE run_id = $1 AND step_key = $3`,
            [runId, id, r.key, state, JSON.stringify(data)],
          )
        }
        // variables: as the steps that succeeded left them (setVariable outputs in the order they ran)
        for (const r of rows) if (r.kind === 'setVariable' && r.state === 'succeeded') {
          const s = findStep(doc.steps, r.stepId)
          if (s?.kind === 'setVariable') variables = { ...variables, [s.variable]: r.output }
        }
      }
      const res = await createRun({
        id, flowId: old.flowId, flowName: flow.name, flowVersion: old.flowVersion, ownerId: flow.ownerId, mode: old.mode, dryRun: old.dryRun, triggerKind: old.triggerKind,
        triggerSummary: `resubmitted (${from === 'start' ? 'from the start' : 'from the failed step'})`, trigger: fromStored(old.trigger), runAs: old.runAs, runAsKind: old.runAsKind,
        triggeredBy: by, chain: old.chain, depth: old.depth, callDepth: old.callDepth, resubmittedFrom: old.id, concurrencyKey: old.concurrencyKey, variables,
        timeoutMinutes: doc.settings?.timeoutMinutes ?? FLOW_LIMITS.runTimeoutMinutes, doc: old.doc, options: old.options,
      })
      return { id: res.id }
    })
  }

  /* ---------------------------------------------------------------- helpers for triggers */

  async function runAsFor(f: { runAs: unknown; ownerId: string }, triggeringUser: string | null): Promise<string | null> {
    const ra = f.runAs as FlowDoc['runAs']
    if (ra === 'owner') return f.ownerId
    if (ra === 'triggeringUser') return triggeringUser
    if (ra && typeof ra === 'object' && 'serviceAccount' in ra) return ra.serviceAccount
    return f.ownerId
  }

  /** manual inputs -> the Trigger.Inputs record (defaults, types, required) */
  async function manualInputs(trigger: FlowDoc['trigger'], given: Record<string, unknown>): Promise<FxRecord> {
    if (trigger?.type !== 'manual') return {}
    const out: FxRecord = {}
    for (const d of trigger.inputs ?? []) {
      let v = given[d.name]
      if ((v === undefined || v === null || v === '') && d.default !== undefined) v = d.default
      if (v === undefined || v === null || v === '') {
        if (d.required) throw new HttpError(422, 'invalid', `The input "${d.name}" is required.`, `inputs.${d.name}`)
        out[d.name] = null
        continue
      }
      const bad = (): never => { throw new HttpError(422, 'invalid', `The input "${d.name}" must be ${d.type === 'datetime' ? 'a date and time' : `a ${d.type}`}.`, `inputs.${d.name}`) }
      switch (d.type) {
        case 'number': { const n = typeof v === 'number' ? v : Number(v); if (!Number.isFinite(n)) bad(); out[d.name] = n; break }
        case 'boolean': out[d.name] = v === true || v === 'true' ? true : v === false || v === 'false' ? false : bad(); break
        case 'date': case 'datetime': { const dt = v instanceof Date ? v : new Date(String(v)); if (Number.isNaN(dt.getTime())) bad(); out[d.name] = dt; break }
        case 'choice': if (!(d.choices ?? []).includes(String(v))) throw new HttpError(422, 'invalid', `The input "${d.name}" must be one of ${(d.choices ?? []).join(', ')}.`, `inputs.${d.name}`); out[d.name] = String(v); break
        case 'record': if (!isRecord(v as FxValue) && (typeof v !== 'object' || Array.isArray(v))) bad(); out[d.name] = isRecord(v as FxValue) ? (v as FxValue) : jsonToFx(v); break
        case 'table': if (!Array.isArray(v)) bad(); out[d.name] = jsonToFx(v); break
        default: out[d.name] = typeof v === 'string' ? v : isRecord(v as FxValue) || v instanceof Date ? (v as FxValue) : String(v)
      }
    }
    return out
  }

  function initialVariables(vars: FlowDoc['variables']): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const v of vars ?? []) out[v.name] = toStored(v.initial === undefined ? (v.type === 'number' ? 0 : v.type === 'boolean' ? false : v.type === 'table' ? [] : v.type === 'text' ? '' : null) : jsonToFx(v.initial))
    return out
  }

  /** a table row as a trigger record (dates as dates) */
  const recordFor = (t: TableDef, raw: Record<string, unknown> | null): FxRecord | null => (raw ? { ...recordOf(t, raw), ...(raw.id ? { __id: String(raw.id), id: String(raw.id) } : {}) } : null)

  return {
    get clock() { return clock },
    setClock(c: FlowClock) {
      clock = c
      engine = flowEngine(c)
    },
    engine: () => engine,
    createRun, advance, resume, resumeWait, callback, sweep, timeout, digest, finishRun, cancelRun, resubmit, startNext,
    runAsFor, manualInputs, initialVariables, recordFor, toFx, rowsToFx, callbackUrl,
    invalidate: () => { docCache.clear(); identityCache.clear() },
    /** tests: whether a step ran in a transaction with its effect */
    kinds: { DATA_KINDS, WRITE_KINDS, EXTERNAL_KINDS, SUSPEND_KINDS },
  }
}

function findStep(list: Step[], id: string): Step | null {
  for (const s of list ?? []) {
    if (s.id === id) return s
    for (const l of childLists(s)) {
      const f = findStep(l.steps, id)
      if (f) return f
    }
  }
  return null
}

/** run row -> API shape */
export function toRunInfo(r: Row, names?: Map<string, string>): FlowRunInfo {
  const run: FlowRunInfo = {
    id: String(r.id), flowId: String(r.flow_id), flowName: String(r.flow_name), flowVersion: Number(r.flow_version), status: String(r.state) as RunStatus,
    mode: r.mode === 'test' ? 'test' : 'normal', triggerKind: String(r.trigger_kind) as FlowRunInfo['triggerKind'], runAs: String(r.run_as ?? ''),
    correlationId: String(r.correlation_id), createdOn: iso(r.created_on)!,
  }
  if (r.dry_run === true) run.dryRun = true
  if (r.trigger_summary) run.triggerSummary = String(r.trigger_summary)
  if (r.run_as && names?.get(String(r.run_as))) run.runAsName = names.get(String(r.run_as))
  if (r.triggered_by) run.triggeredBy = String(r.triggered_by)
  if (r.started_on) run.startedOn = iso(r.started_on)
  if (r.finished_on) run.finishedOn = iso(r.finished_on)
  if (r.started_on && r.finished_on) run.durationMs = new Date(String(r.finished_on)).getTime() - new Date(String(r.started_on)).getTime()
  const err = parseJ<{ message: string; step?: string } | null>(r.error, null)
  if (err) run.error = err
  const resp = parseJ<{ body?: unknown } | null>(r.response, null)
  if (resp) run.response = fxToJson(fromStored(resp.body))
  if (r.parent_run_id) run.parentRunId = String(r.parent_run_id)
  if (r.resubmitted_from) run.resubmittedFrom = String(r.resubmitted_from)
  if (r.regarding_table && r.regarding_id) run.regarding = { tableId: String(r.regarding_table), rowId: String(r.regarding_id) }
  return run
}

export { toFx }
