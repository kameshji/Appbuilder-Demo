/**
 * The flow runtime service (P1 package A; docs/dev/flows.md): definitions (store.ts), validation (validate.ts), the
 * engine (engine.ts) and the four triggers:
 *  - table: a consumer of the outbox inside the dispatcher's transaction (kernel.addDispatcher): one run per matching
 *    change and row (trigger key tbl:<flow>:<outbox id>:<row>), condition on the after-image, loop protection;
 *  - schedule: an ab_schedules row per enabled flow (id flow_<flowId>, job flow.schedule); each slot runs once
 *    (trigger key sched:<flow>:<slot>);
 *  - manual: runManual (POST /flows/:id/run, RunFlow() in apps) with the run permission of roles;
 *  - webhook: triggerWebhook (called by package D's verified webhook route);
 *  - approvalDecided: triggerApprovalDecided (called by the approvals module);
 *  - formSubmitted (P3-D): triggerFormSubmitted, called by the flow routes' mutation listener after the server COMMITTED a
 *    row write that carried a Form's identity (docs/dev/flows.md "The formSubmitted trigger").
 */
import { HttpError } from '../contracts.ts'
import type { Connector, DataService, MetaStore, NotificationService, SqlDb, UserContext } from '../contracts.ts'
import type { TableDef, UserDef } from '../../../src/platform/contracts.ts'
import type { AppDef, ControlNode, FxRecord } from '../../../src/contracts.ts'
import {
  DEFAULT_SETTINGS, FLOW_LIMITS, STEP_KINDS, TRIGGER_TYPES, type FlowDef, type FlowListItem, type RunAs, type ValidationProblem,
} from '../../../src/platform/flows.ts'
import type { ActionsService, VerifiedWebhookPayload } from '../actions/contracts.ts'
import type { Kernel } from '../kernel.ts'
import type { OutboxEvent } from '../outbox.ts'
import { JobError } from '../jobs.ts'
import { nextCron, parseCron } from '../cron.ts'
import { currentEnvironment, runInEnvironment } from '../env-context.ts'
import { currentWork, newWorkId } from '../work-context.ts'
import { newLimits } from '../event-fx.ts'
import { errText } from '../util.ts'
import { createFlowStore, docOf, T, type FlowDoc } from './store.ts'
import { ADVANCE_JOB, RESUME_JOB, TIMEOUT_JOB, createFlowEngine, isRunTerminal, toRunInfo } from './engine.ts'
import { evaluate, flowScope } from './expr.ts'
import { callsOf, formOfTrigger, validateFlow, type AppForms } from './validate.ts'
import { jsonToFx } from './values.ts'
import type { ApprovalsService, FlowsService, WaitOutcome } from './contracts.ts'

export const SCHEDULE_JOB = 'flow.schedule'
export const RETENTION_JOB = 'flow.retention'
export const DIGEST_JOB = 'flow.digest'
/** a table trigger fires again on a record this flow changed at most this many times on one chain (triggerOnOwnChanges) */
export const OWN_CHANGE_CAP = 3
export const FLOW_MAX_DEPTH = 8

type Row = Record<string, unknown>

export interface FlowsDeps {
  db(): SqlDb | null
  meta(): MetaStore
  data(): DataService & { internals: { connectorFor(t: TableDef): Promise<Connector>; physical(t: TableDef): TableDef; writeCells(ctx: UserContext | null, t: TableDef, rowId: string, changes: Record<string, unknown>): Promise<number> } }
  forUser(user: UserDef): Promise<UserContext>
  kernel: Kernel
  notifications(): NotificationService | undefined
  actions(): ActionsService | undefined
  /** P2-B print templates (the step document.generate) */
  print?(): import('../print/service.ts').PrintService | undefined
  log(level: 'info' | 'warn' | 'error', msg: string): void
}

export type Flows = ReturnType<typeof createFlows>

export function createFlows(deps: FlowsDeps) {
  const store = createFlowStore({ db: deps.db, meta: deps.meta })
  let approvals: ApprovalsService | null = null
  const engine = createFlowEngine({
    db: deps.db, meta: deps.meta, data: deps.data, forUser: deps.forUser, jobs: deps.kernel.jobs, store,
    notifications: deps.notifications, actions: deps.actions, approvals: () => approvals, print: deps.print, log: deps.log,
  })
  const jobs = deps.kernel.jobs
  const db = (): SqlDb => {
    const d = deps.db()
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }

  /* ---------------------------------------------------------------- job types */

  const obj = (raw: unknown): Record<string, unknown> => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new JobError('The payload must be an object.', { retry: false })
    return raw as Record<string, unknown>
  }
  const str = (o: Record<string, unknown>, k: string): string => {
    if (typeof o[k] !== 'string') throw new JobError(`The payload needs "${k}".`, { retry: false })
    return o[k] as string
  }

  jobs.register<{ runId: string; scope: string }>({
    type: ADVANCE_JOB, description: 'Runs the next step of a flow run (one container of the run).', concurrency: 8, maxAttempts: 10, timeoutMs: 15 * 60_000,
    backoff: { kind: 'exponential', baseMs: 1000, maxMs: 60_000 },
    parse: (raw) => { const o = obj(raw); return { runId: str(o, 'runId'), scope: str(o, 'scope') } },
    handler: (p, ctx) => engine.advance(p, { id: ctx.job.id, attempts: ctx.job.attempts }),
  })
  jobs.register<{ waitId: string; outcome?: WaitOutcome; reason: 'wake' | 'timeout' | 'external' | 'child' }>({
    type: RESUME_JOB, description: 'Resumes a flow step that waited (delay, approval, child flow, callback).', concurrency: 4, maxAttempts: 10,
    backoff: { kind: 'exponential', baseMs: 1000, maxMs: 60_000 },
    parse: (raw) => { const o = obj(raw); return { waitId: str(o, 'waitId'), reason: (o.reason as 'wake') ?? 'external', ...(o.outcome !== undefined ? { outcome: o.outcome as WaitOutcome } : {}) } },
    handler: (p) => engine.resume(p),
  })
  jobs.register<{ runId: string }>({
    type: TIMEOUT_JOB, description: 'Ends a flow run that ran longer than its timeout.', concurrency: 2,
    parse: (raw) => ({ runId: str(obj(raw), 'runId') }),
    handler: (p) => engine.timeout(p.runId),
  })
  jobs.register<{ flowId: string }>({
    type: SCHEDULE_JOB, description: 'Starts a run of a flow with a schedule trigger (one per slot).', concurrency: 2,
    parse: (raw) => ({ flowId: str(obj(raw), 'flowId') }),
    handler: async (p, ctx) => {
      const key = ctx.job.idempotencyKey ?? ''
      const m = /^sched:[^:]+:(.+)$/.exec(key)
      const slot = m && !m[1].startsWith('manual:') ? new Date(m[1]) : new Date()
      return startScheduled(p.flowId, Number.isNaN(slot.getTime()) ? new Date() : slot, m?.[1]?.startsWith('manual:') ? m[1] : null)
    },
  })
  jobs.register<Record<string, never>>({
    type: RETENTION_JOB, description: 'Deletes flow runs older than their flow\'s retention (settings.retentionDays).', concurrency: 1, schedule: 'custom', timeoutMs: 60 * 60_000,
    handler: async () => ({ deleted: await retention() }),
  })
  jobs.register<Record<string, never>>({
    type: DIGEST_JOB, description: 'Sends the daily summary of flow failures (after the first failure of a day).', concurrency: 1,
    handler: async () => engine.digest(),
  })

  /* ---------------------------------------------------------------- worker tick and dispatcher */

  const builtinsDone = new Set<string>()
  deps.kernel.addTickHook(async (env) => {
    if (!builtinsDone.has(env.id)) {
      await jobs.schedules.ensureBuiltins([
        { id: 'sched_flow_retention', name: 'Flow run retention', description: 'Deletes flow runs (with their steps) older than the retention of their flow.', cron: '23 2 * * *', jobType: RETENTION_JOB, payload: {}, enabled: true },
        { id: 'sched_flow_digest', name: 'Flow failure digest', description: 'Tells flow owners and administrators how often their flows failed after the first failure of the day.', cron: '5 7 * * *', jobType: DIGEST_JOB, payload: {}, enabled: true },
      ])
      builtinsDone.add(env.id)
    }
    await engine.sweep()
  })

  /** P3-D: the enabled flows with a formSubmitted trigger, and the Forms of the apps (cached 5 s per environment; cleared on every flow save) */
  const formCache = new Map<string, { at: number; flows: FlowDef[]; apps: AppForms[] | null }>()
  interface Rule { flow: FlowDef; table: TableDef }
  const rulesCache = new Map<string, { at: number; byTable: Map<string, Rule[]> }>()
  async function rules(): Promise<Map<string, Rule[]>> {
    const envId = currentEnvironment().id
    const c = rulesCache.get(envId)
    if (c && Date.now() - c.at < 5000) return c.byTable
    const tables = await deps.meta().tables.list()
    const rows = await db().query<Row>(`SELECT * FROM ${T('ab_flows')} WHERE enabled AND suspended IS NULL AND definition->'trigger'->>'type' = 'table'`)
    const byTable = new Map<string, Rule[]>()
    for (const r of rows) {
      const f = (await import('./store.ts')).toFlowDef(r)
      if (f.trigger?.type !== 'table') continue
      const tt = f.trigger.table
      const tn = tt.toLowerCase()
      const t = tables.find((x) => x.name.toLowerCase() === tn || x.id === tt)
      if (!t) continue
      byTable.set(t.id, [...(byTable.get(t.id) ?? []), { flow: f, table: t }])
    }
    rulesCache.set(envId, { at: Date.now(), byTable })
    return byTable
  }
  const invalidate = (): void => {
    rulesCache.clear()
    formCache.clear()
    engine.invalidate()
  }

  const OPS: Record<string, 'create' | 'update' | 'delete'> = { insert: 'create', update: 'update', delete: 'delete' }

  deps.kernel.addDispatcher(async (events: OutboxEvent[]) => {
    let byTable: Map<string, Rule[]>
    try {
      byTable = await rules()
    } catch (e) {
      deps.log('error', `flows: table triggers not loaded: ${errText(e)}`)
      return
    }
    if (!byTable.size) return
    const rowCache = new Map<string, Record<string, unknown> | null>()
    for (const ev of events) {
      const list = byTable.get(ev.tableId)
      if (!list) continue
      for (const rule of list) {
        try {
          await db().tx(() => dispatchOne(ev, rule, rowCache))
        } catch (e) {
          deps.log('error', `flow ${rule.flow.id}: outbox ${ev.id} not turned into a run: ${errText(e)}`)
        }
      }
    }
  })

  function rowsOf(ev: OutboxEvent): { op: 'create' | 'update' | 'delete' | 'restore'; rowId: string }[] {
    if (OPS[ev.op]) return ev.rowId ? [{ op: OPS[ev.op], rowId: ev.rowId }] : []
    const action = (ev.details as { action?: string } | null)?.action
    // restore: rows back from the recycle bin (only triggers that list 'restore' start; off by default)
    const op = ev.op === 'import' ? 'create' as const : action === 'update' ? 'update' as const : action === 'restore' ? 'restore' as const : 'delete' as const
    return (ev.rowIds ?? []).map((rowId) => ({ op, rowId }))
  }

  /** one outbox event, one flow: the runs it starts (inside the dispatcher's transaction, in a savepoint) */
  async function dispatchOne(ev: OutboxEvent, rule: Rule, rowCache: Map<string, Record<string, unknown> | null>): Promise<void> {
    const f = rule.flow
    const trig = f.trigger as Extract<FlowDef['trigger'], { type: 'table' }>
    const targets = rowsOf(ev).filter((x) => trig.on.includes(x.op)).slice(0, FLOW_LIMITS.fanOut)
    if (!targets.length) return
    // updates: only when a listed column changed
    if (trig.columns?.length && targets[0].op === 'update' && ev.changed && !ev.changed.some((c) => trig.columns!.includes(c))) return
    // loop protection (docs/dev/flows.md "Loop protection")
    const mine = ev.chain.filter((x) => x.startsWith(`flow:${f.id}:`))
    if (!f.settings.triggerOnOwnChanges && mine.length) return
    if (ev.depth >= FLOW_MAX_DEPTH) {
      deps.log('info', `flow ${f.name}: change of ${rule.table.name} ${ev.rowId ?? ''} made ${ev.depth} levels deep; not started (limit ${FLOW_MAX_DEPTH})`)
      return
    }
    const data = deps.data()
    for (const t of targets) {
      if (f.settings.triggerOnOwnChanges && mine.filter((x) => x === `flow:${f.id}:${t.rowId}`).length >= OWN_CHANGE_CAP) continue
      const key = `tbl:${f.id}:${ev.id}:${t.rowId}`
      let raw: Record<string, unknown> | null = null
      if (t.op !== 'delete') {
        const ck = `${ev.tableId}:${t.rowId}`
        if (!rowCache.has(ck)) {
          const conn = await data.internals.connectorFor(rule.table)
          rowCache.set(ck, (await conn.select(data.internals.physical(rule.table), { where: { col: 'id', op: 'eq', value: t.rowId }, top: 1 })).rows[0] as Record<string, unknown> ?? null)
        }
        raw = rowCache.get(ck) ?? null
        // deleted since: the change is still delivered with the snapshot it has
        if (!raw) raw = { id: t.rowId }
        // the after-image of THIS change: the row as it is, with the columns this change wrote as it wrote them
        if (ev.rowId === t.rowId && ev.after) raw = { ...raw, ...ev.after, id: t.rowId }
      } else raw = ev.rowId === t.rowId ? { ...(ev.before ?? {}), id: t.rowId } : { id: t.rowId }
      const record = engine.recordFor(rule.table, raw)!
      const old = t.op === 'create' || t.op === 'restore' ? null : engine.recordFor(rule.table, { ...raw, ...(ev.rowId === t.rowId ? ev.before ?? {} : {}) })
      const actor = ev.actorId ? await deps.meta().users.get(ev.actorId) : null
      const user = { FullName: actor?.name ?? '', Email: actor?.email ?? '', Image: '', Id: actor?.id ?? '' }
      const trigger: FxRecord = { Record: record, Old: old, Operation: t.op, ChangedColumns: (ev.changed ?? []).map((c) => ({ Value: c })), Table: rule.table.name, User: user }
      const runAs = await engine.runAsFor(f, ev.actorId)
      const base = {
        flowId: f.id, flowName: f.name, flowVersion: f.version, ownerId: f.ownerId, triggerKind: 'table', triggerKey: key,
        triggerSummary: `${rule.table.displayName} ${t.rowId} ${t.op === 'create' ? 'created' : t.op === 'update' ? 'changed' : t.op === 'restore' ? 'restored' : 'deleted'}${actor ? ` by ${actor.name}` : ''}`,
        trigger, runAs, runAsKind: typeof f.runAs === 'object' ? 'serviceAccount' : f.runAs, triggeredBy: ev.actorId, correlationId: ev.correlationId ?? newWorkId(),
        chain: ev.chain, depth: ev.depth, seq: ev.id, variables: engine.initialVariables(f.variables), timeoutMinutes: f.settings.timeoutMinutes,
        regarding: { tableId: rule.table.id, rowId: t.rowId }, ...(f.settings.maxRunsPerMinute ? { maxRunsPerMinute: f.settings.maxRunsPerMinute } : {}),
        concurrencyKey: f.settings.concurrency === 'perRecord' ? `${f.id}:${t.rowId}` : f.settings.concurrency === 'singleton' ? f.id : null,
      }
      if (!runAs) {
        await engine.createRun({ ...base, failed: 'The change was made by the system (no person), and this flow runs as the triggering user: it did not run.' })
        continue
      }
      if (trig.condition) {
        let ok: boolean
        try {
          const ident = await identityFor(runAs)
          const tables = await deps.meta().tables.list()
          const r = await evaluate(trig.condition, flowScope({ trigger, steps: {}, variables: {}, flow: { Id: f.id, Name: f.name, Version: f.version, RunId: '', Mode: 'normal' }, user: { FullName: '', Email: '', Image: '', Id: runAs }, loops: [] }, new Set(tables.map((x) => x.name))),
            { tables, identity: ident, data, limits: newLimits(1000, 1000, 5), engine: engine.engine() })
          if (!r.ok) throw new Error(r.error)
          ok = r.value === true
        } catch (e) {
          await engine.createRun({ ...base, failed: `The trigger condition could not be evaluated: ${errText(e)}` })
          continue
        }
        if (!ok) continue
      }
      await engine.createRun({ ...base, ...(trig.coalesce ? { coalesceKey: base.concurrencyKey ?? `${f.id}:${t.rowId}` } : {}) })
    }
  }

  async function identityFor(userId: string): Promise<UserContext> {
    const u = await deps.meta().users.get(userId)
    if (!u) throw new Error('The user this flow runs as no longer exists.')
    if (u.status === 'disabled') throw new Error(`The user this flow runs as (${u.email}) is disabled.`)
    return deps.forUser(u)
  }

  /* ---------------------------------------------------------------- schedule trigger */

  /** the ab_schedules row of a flow: present and enabled exactly while the flow is enabled with a schedule trigger */
  async function syncSchedule(f: FlowDef): Promise<void> {
    const id = `flow_${f.id}`.slice(0, 64)
    const t = f.trigger
    if (!f.enabled || t?.type !== 'schedule' || f.suspended) {
      await db().exec(`DELETE FROM ${T('ab_schedules')} WHERE id = $1`, [id])
      return
    }
    const cron = t.cron?.trim() || null
    const interval = cron ? null : Math.max(60, Math.round(Number(t.everyMinutes) * 60))
    const now = new Date()
    const next = cron ? nextCron(parseCron(cron), now, t.timeZone || 'UTC') : new Date(now.getTime() + interval! * 1000)
    await db().exec(
      `INSERT INTO ${T('ab_schedules')} (id, name, description, cron, interval_seconds, time_zone, job_type, payload, enabled, misfire, built_in, next_run_at, created_by, created_on, modified_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, true, 'run_once', false, $9, $10, now(), now())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, cron = EXCLUDED.cron, interval_seconds = EXCLUDED.interval_seconds, time_zone = EXCLUDED.time_zone,
         payload = EXCLUDED.payload, enabled = true,
         next_run_at = CASE WHEN ${T('ab_schedules')}.cron IS DISTINCT FROM EXCLUDED.cron OR ${T('ab_schedules')}.interval_seconds IS DISTINCT FROM EXCLUDED.interval_seconds
           OR ${T('ab_schedules')}.time_zone IS DISTINCT FROM EXCLUDED.time_zone OR NOT ${T('ab_schedules')}.enabled OR ${T('ab_schedules')}.next_run_at IS NULL THEN EXCLUDED.next_run_at ELSE ${T('ab_schedules')}.next_run_at END,
         modified_on = now()`,
      [id, `Flow: ${f.name}`.slice(0, 200), `Starts a run of the flow "${f.name}" (managed by the flow; change it in the flow).`, cron, interval, t.timeZone || 'UTC', SCHEDULE_JOB, JSON.stringify({ flowId: f.id }), next, f.ownerId],
    )
  }

  async function startScheduled(flowId: string, slot: Date, manualKey: string | null): Promise<unknown> {
    const f = await store.get(flowId)
    if (!f || !f.enabled || f.trigger?.type !== 'schedule') return { skipped: 'The flow is off or no longer has a schedule.' }
    const runAs = await engine.runAsFor(f, null)
    const r = await db().tx(() => engine.createRun({
      flowId: f.id, flowName: f.name, flowVersion: f.version, ownerId: f.ownerId, triggerKind: 'schedule', triggerKey: manualKey ? `sched:${f.id}:${manualKey}` : `sched:${f.id}:${slot.toISOString()}`,
      triggerSummary: `schedule ${slot.toISOString().slice(0, 16).replace('T', ' ')} UTC`, trigger: { ScheduledTime: slot }, runAs, runAsKind: typeof f.runAs === 'object' ? 'serviceAccount' : f.runAs,
      variables: engine.initialVariables(f.variables), timeoutMinutes: f.settings.timeoutMinutes, concurrencyKey: f.settings.concurrency === 'singleton' ? f.id : null,
      ...(f.settings.maxRunsPerMinute ? { maxRunsPerMinute: f.settings.maxRunsPerMinute } : {}),
    }))
    return { runId: r.id, created: r.created }
  }

  /* ---------------------------------------------------------------- manual trigger */

  /** may this user run the flow by hand (owner, administrators, roles granted on the flow or on every flow)? */
  async function canRun(ctx: UserContext, f: FlowDef): Promise<boolean> {
    if (ctx.privileges.isAdmin || f.ownerId === ctx.user.id) return true
    const g = await store.grantedFlows(ctx.roles.map((r) => r.id))
    return g.has(f.id) || g.has('*')
  }
  const canEdit = (ctx: UserContext, f: FlowDef): boolean => ctx.privileges.isAdmin || (ctx.privileges.isMaker && f.ownerId === ctx.user.id)

  async function runManual(ctx: UserContext, f: FlowDef, inputs: Record<string, unknown>, o: { runId?: string; source?: 'app' | 'record' | 'portal' | 'api'; test?: boolean; dryRun?: boolean; doc?: FlowDoc; approvalOutcome?: string; trigger?: unknown } = {}): Promise<{ id: string; created: boolean }> {
    const doc = o.doc ?? docOf(f)
    if (!o.test) {
      if (doc.trigger?.type !== 'manual') throw new HttpError(422, 'invalid', `"${f.name}" is not started by hand: its trigger is ${doc.trigger?.type ?? 'missing'}.`)
      if (!f.enabled) throw new HttpError(409, 'conflict', `"${f.name}" is turned off.`)
      if (f.suspended) throw new HttpError(409, 'conflict', `"${f.name}" is suspended: ${f.suspended}`)
      if (!(await canRun(ctx, f))) throw new HttpError(403, 'denied', `You may not run "${f.name}".`)
      const from = doc.trigger.from
      if ((o.source === 'app' || o.source === 'record') && from !== 'any' && from !== o.source && !(from === 'app' && o.source === 'record')) throw new HttpError(403, 'denied', `"${f.name}" cannot be started from ${o.source === 'app' ? 'an app' : 'a record'}.`)
    }
    const st = await store.settings()
    if (st.paused) throw new HttpError(409, 'conflict', 'Flows are paused in this environment (an administrator turned on the kill switch).')
    if (o.runId !== undefined && !/^run_[A-Za-z0-9_-]{8,40}$/.test(o.runId)) throw new HttpError(422, 'invalid', 'runId must look like run_<8 to 40 letters or digits>.', 'runId')
    const runAs = doc.runAs === 'triggeringUser' ? ctx.user.id : await engine.runAsFor({ runAs: doc.runAs, ownerId: f.ownerId }, ctx.user.id)
    let trigger: unknown
    if (o.trigger !== undefined) trigger = jsonToFx(o.trigger)
    else trigger = doc.trigger?.type === 'manual'
      ? { Inputs: await engine.manualInputs(doc.trigger, inputs), User: { FullName: ctx.user.name, Email: ctx.user.email, Image: '', Id: ctx.user.id } }
      : sampleTrigger(doc)
    const w = currentWork()
    return db().tx(() => engine.createRun({
      ...(o.runId ? { id: o.runId } : {}), flowId: f.id, flowName: f.name, flowVersion: f.version, ownerId: f.ownerId, mode: o.test ? 'test' : 'normal', dryRun: !!o.dryRun,
      triggerKind: o.test ? doc.trigger?.type ?? 'manual' : 'manual', triggerKey: o.runId ? `manual:${o.runId}` : null,
      triggerSummary: `${o.test ? `test run${o.dryRun ? ' (simulated)' : ''}` : 'run'} by ${ctx.user.name}${o.source && o.source !== 'portal' ? ` from ${o.source === 'api' ? 'the API' : `an ${o.source}`}` : ''}`,
      trigger, runAs, runAsKind: typeof doc.runAs === 'object' ? 'serviceAccount' : doc.runAs, triggeredBy: ctx.user.id, correlationId: w.correlationId ?? newWorkId(),
      variables: engine.initialVariables(doc.variables), timeoutMinutes: doc.settings?.timeoutMinutes ?? FLOW_LIMITS.runTimeoutMinutes,
      concurrencyKey: doc.settings?.concurrency === 'singleton' ? f.id : null, ...(o.doc ? { doc: o.doc } : {}),
      ...(o.approvalOutcome ? { options: { approvalOutcome: o.approvalOutcome } } : {}),
    }))
  }

  function sampleTrigger(doc: FlowDoc): unknown {
    switch (doc.trigger?.type) {
      case 'schedule': return { ScheduledTime: new Date() }
      case 'webhook': return { Body: null, Query: {}, Headers: {}, ReceivedOn: new Date(), DeliveryId: 'test' }
      default: return {}
    }
  }

  /** waits (polls) for the run's respond step, its end, or the timeout */
  async function waitForResponse(runId: string, timeoutSeconds: number): Promise<{ status: string; response?: unknown; error?: unknown }> {
    const end = Date.now() + Math.max(0, Math.min(FLOW_LIMITS.respondWaitSeconds, timeoutSeconds)) * 1000
    for (;;) {
      const r = (await db().query<Row>(`SELECT * FROM ${T('ab_flow_runs')} WHERE id = $1`, [runId]))[0]
      if (!r) throw new HttpError(404, 'not-found', 'Run not found.')
      if (r.responded === true || isRunTerminal(String(r.state)) || Date.now() >= end) {
        const info = toRunInfo(r)
        return { status: info.status, ...(info.response !== undefined ? { response: info.response } : {}), ...(info.error ? { error: info.error } : {}) }
      }
      await new Promise((res) => setTimeout(res, 100))
    }
  }

  /* ---------------------------------------------------------------- webhook trigger (package D calls it) */

  async function triggerWebhook(env: string, flowId: string, payload: VerifiedWebhookPayload): Promise<{ runId?: string }> {
    return runInEnvironment(env, async () => {
      const f = await store.get(flowId)
      if (!f || f.trigger?.type !== 'webhook') throw new HttpError(404, 'not-found', 'There is no flow with a webhook trigger here.')
      if (!f.enabled) throw new HttpError(409, 'conflict', 'The flow is turned off.')
      if (f.suspended) throw new HttpError(409, 'conflict', 'The flow is suspended.')
      const runAs = await engine.runAsFor(f, null)
      const r = await db().tx(() => engine.createRun({
        flowId: f.id, flowName: f.name, flowVersion: f.version, ownerId: f.ownerId, triggerKind: 'webhook', triggerKey: `hook:${f.id}:${payload.deliveryId}`.slice(0, 300),
        triggerSummary: `web request ${payload.verifiedBy === 'hmac-sha256' ? '(signed)' : ''}`.trim(),
        trigger: { Body: jsonToFx(payload.body), Query: jsonToFx(payload.query ?? {}), Headers: jsonToFx(payload.headers ?? {}), ReceivedOn: new Date(payload.receivedOn), DeliveryId: payload.deliveryId, ContentType: payload.contentType },
        runAs, runAsKind: typeof f.runAs === 'object' ? 'serviceAccount' : f.runAs, variables: engine.initialVariables(f.variables), timeoutMinutes: f.settings.timeoutMinutes,
        concurrencyKey: f.settings.concurrency === 'singleton' ? f.id : null, ...(f.settings.maxRunsPerMinute ? { maxRunsPerMinute: f.settings.maxRunsPerMinute } : {}),
      }))
      return { runId: r.id }
    })
  }

  /* ---------------------------------------------------------------- approvalDecided trigger (P1-C calls it) */

  /**
   * An approval request ended: one run per enabled flow with an approvalDecided trigger that matches (policy, statuses).
   * Idempotent: trigger key appr:<flow>:<request>. Called by the approvals module's decided job (after the decision
   * committed), in the request's environment.
   */
  async function triggerApprovalDecided(env: string, p: { requestId: string; status: string; policyId?: string | null; policyName?: string | null; request: Record<string, unknown>; responses: unknown[] }): Promise<{ runIds: string[] }> {
    return runInEnvironment(env, async () => {
      const rows = await db().query<Row>(`SELECT id FROM ${T('ab_flows')} WHERE enabled AND suspended IS NULL AND definition->'trigger'->>'type' = 'approvalDecided'`)
      const runIds: string[] = []
      if (!rows.length) return { runIds }
      if ((await store.settings()).paused) return { runIds }
      for (const r of rows) {
        const f = await store.get(String(r.id))
        if (!f || f.trigger?.type !== 'approvalDecided') continue
        const t = f.trigger
        if (t.policy && ![p.policyId, p.policyName].some((x) => x && x.toLowerCase() === t.policy!.toLowerCase())) continue
        if (t.statuses?.length && !t.statuses.includes(p.status as never)) continue
        const runAs = await engine.runAsFor(f, null)
        const created = await db().tx(() => engine.createRun({
          flowId: f.id, flowName: f.name, flowVersion: f.version, ownerId: f.ownerId, triggerKind: 'approvalDecided', triggerKey: `appr:${f.id}:${p.requestId}`,
          triggerSummary: `approval ${p.status}: ${String(p.request.Title ?? '')}`.slice(0, 200), trigger: { Request: jsonToFx(p.request), Responses: jsonToFx(p.responses) },
          runAs, runAsKind: typeof f.runAs === 'object' ? 'serviceAccount' : f.runAs, variables: engine.initialVariables(f.variables), timeoutMinutes: f.settings.timeoutMinutes,
          concurrencyKey: f.settings.concurrency === 'singleton' ? f.id : null, ...(f.settings.maxRunsPerMinute ? { maxRunsPerMinute: f.settings.maxRunsPerMinute } : {}),
        }))
        runIds.push(created.id)
      }
      return { runIds }
    })
  }

  async function webhookFlow(env: string, flowId: string): Promise<{ id: string; name: string; enabled: boolean; ownerId?: string } | null> {
    return runInEnvironment(env, async () => {
      const f = await store.get(flowId)
      if (!f || f.trigger?.type !== 'webhook') return null
      return { id: f.id, name: f.name, enabled: f.enabled && !f.suspended, ownerId: f.ownerId }
    })
  }

  /* ---------------------------------------------------------------- formSubmitted trigger (P3-D) */

  const LITERAL = /^\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/
  /** the Form UI components of an app: name, screen name and the table a plain `="Table"` DataSource names (null: computed) */
  function formsOf(def: AppDef): AppForms['forms'] {
    const out: AppForms['forms'] = []
    const walk = (n: ControlNode, screen: string): void => {
      if (n.type === 'Form') out.push({ name: n.name, screen, table: LITERAL.exec(String(n.props?.DataSource ?? ''))?.[1]?.replace(/\\(.)/g, '$1') ?? null })
      for (const c of n.children ?? []) walk(c, screen)
    }
    for (const sc of def.screens ?? []) walk(sc, sc.name)
    return out
  }
  async function appForms(): Promise<AppForms[]> {
    const out: AppForms[] = []
    for (const a of await deps.meta().apps.list()) {
      const full = await deps.meta().apps.get(a.id)
      if (full) out.push({ id: a.id, name: a.name, dataSources: full.definition.dataSources ?? [], forms: formsOf(full.definition) })
    }
    return out
  }
  async function formFlowList(): Promise<{ flows: FlowDef[]; apps: AppForms[] | null }> {
    const envId = currentEnvironment().id
    const c = formCache.get(envId)
    if (c && Date.now() - c.at < 5000) return c
    const rows = await db().query<Row>(`SELECT id FROM ${T('ab_flows')} WHERE enabled AND suspended IS NULL AND definition->'trigger'->>'type' = 'formSubmitted'`)
    const flows: FlowDef[] = []
    for (const r of rows) {
      const f = await store.get(String(r.id))
      if (f?.trigger?.type === 'formSubmitted') flows.push(f)
    }
    const next = { at: Date.now(), flows, apps: null as AppForms[] | null }
    formCache.set(envId, next)
    return next
  }

  /**
   * The server committed a row write that CLAIMS to be the submit of Form `claim.form` of app `claim.app` (the body's `form`,
   * sent by the running app and, for writes saved offline, by the outbox's replay). The claim starts nothing by itself; a
   * flow starts only when ALL of these hold, each checked here, none taken from the client:
   *  - the write exists: this is called from the flow routes' after-commit listener, only for a 2xx POST / PATCH of one row;
   *  - the claiming person may run that app (role access), and the app has a Form of that exact name;
   *  - the Form's table is the table that was written (its DataSource, when it is the plain name of a table, else any table
   *    in the app's data sources);
   *  - the flow's trigger names that app and that form, and the operation (create / update) is one it lists.
   * The data of the run is the row as committed (read from the database), never anything the client sent; the run acts
   * for the submitter (run as owner / triggering user / service account as the flow says), under the flow's own limits.
   * Exactly once: trigger key form:<flow>:<submitter>:<Idempotency-Key>, so the replay of a queued submit (or a retry after a
   * lost answer) finds the run it already made; a write without a key gets a fresh key (nothing retries it).
   */
  async function triggerFormSubmitted(env: string, who: UserContext, claim: { app: unknown; form: unknown }, write: { op: 'create' | 'update'; table: TableDef; rowId: string; key: string | null }): Promise<{ runIds: string[] }> {
    return runInEnvironment(env, async () => {
      const runIds: string[] = []
      if (typeof claim.app !== 'string' || typeof claim.form !== 'string' || !claim.app || !claim.form || claim.app.length > 120 || claim.form.length > 120) return { runIds }
      const cached = await formFlowList()
      if (!cached.flows.length) return { runIds }
      if ((await store.settings()).paused) return { runIds }
      const apps = (cached.apps ??= await appForms())
      const app = apps.find((a) => a.id === claim.app)
      if (!app || !who.canRunApp(app.id)) return { runIds }
      const form = app.forms.find((f) => f.name === claim.form)
      if (!form) return { runIds }
      const wrote = write.table.name.toLowerCase()
      if (form.table ? form.table.toLowerCase() !== wrote && form.table !== write.table.id : !app.dataSources.some((d) => d.toLowerCase() === wrote || d === write.table.id)) return { runIds }
      const mine = cached.flows.filter((f) => {
        const t = f.trigger as Extract<FlowDef['trigger'], { type: 'formSubmitted' }>
        const m = formOfTrigger([app], t)
        return !!m && m.form.name === form.name && (t.on ?? ['create', 'update']).includes(write.op)
      })
      if (!mine.length) return { runIds }
      // the row as committed (a Form saves one row); gone since: nothing to hand over
      const data = deps.data()
      const conn = await data.internals.connectorFor(write.table)
      const raw = (await conn.select(data.internals.physical(write.table), { where: { col: 'id', op: 'eq', value: write.rowId }, top: 1 })).rows[0] as Record<string, unknown> | undefined
      if (!raw) return { runIds }
      const record = engine.recordFor(write.table, raw)!
      const at = new Date()
      const submit = write.key ?? `once-${newWorkId()}`
      for (const f of mine) {
        const runAs = await engine.runAsFor(f, who.user.id)
        const trigger: FxRecord = {
          Record: record, Operation: write.op, Table: write.table.name, App: app.name, Screen: form.screen, Form: form.name, SubmittedOn: at,
          User: { FullName: who.user.name, Email: who.user.email, Image: '', Id: who.user.id },
        }
        const created = await db().tx(() => engine.createRun({
          flowId: f.id, flowName: f.name, flowVersion: f.version, ownerId: f.ownerId, triggerKind: 'formSubmitted', triggerKey: `form:${f.id}:${who.user.id}:${submit}`.slice(0, 300),
          triggerSummary: `${app.name}: ${form.name} ${write.op === 'create' ? 'submitted' : 'saved'} by ${who.user.name}`.slice(0, 200), trigger, runAs, runAsKind: typeof f.runAs === 'object' ? 'serviceAccount' : f.runAs,
          triggeredBy: who.user.id, correlationId: newWorkId(), variables: engine.initialVariables(f.variables), timeoutMinutes: f.settings.timeoutMinutes,
          regarding: { tableId: write.table.id, rowId: write.rowId }, concurrencyKey: f.settings.concurrency === 'singleton' ? f.id : null,
          ...(f.settings.maxRunsPerMinute ? { maxRunsPerMinute: f.settings.maxRunsPerMinute } : {}),
          ...(runAs ? {} : { failed: 'This flow runs as the triggering user but no person is known: it did not run.' }),
        }))
        if (created.created) runIds.push(created.id)
      }
      return { runIds }
    })
  }

  /* ---------------------------------------------------------------- definitions */

  /** validation in the current environment; conns: the flow's connection references (ref, connection id, connector kind) */
  async function validate(doc: Partial<FlowDoc>, selfId: string | null, conns: { ref: string; connectionId: string; connector?: string }[]): Promise<ValidationProblem[]> {
    const all = await store.list()
    const actions = deps.actions()
    const ids = new Map(conns.map((c) => [c.ref, c.connectionId]))
    const apps = doc.trigger?.type === 'formSubmitted' ? await appForms() : undefined
    return validateFlow(doc as never, {
      ...(apps ? { apps } : {}),
      tables: await deps.meta().tables.list(),
      flows: all.filter((f) => f.id !== selfId).map((f) => ({ id: f.id, name: f.name, trigger: f.trigger, calls: resolveCalls(all, callsOf(f.steps)) })),
      selfId, selfName: String(doc.name ?? 'this flow'), connections: new Map(conns.map((c) => [c.ref, c.connector ?? ''])), engine: engine.engine(),
      roles: (await deps.meta().roles.list()).map((r) => ({ id: r.id, name: r.name })),
      ...(actions ? {
        actionsOf: async (ref: string) => {
          const id = ids.get(ref)
          return id ? (await actions.list(id)).map((a) => ({ id: a.id, inputs: a.inputs as { required?: string[] } })) : null
        },
      } : {}),
    })
  }
  const resolveCalls = (all: FlowDef[], calls: string[]): string[] => calls.map((c) => all.find((f) => f.id === c || f.name.toLowerCase() === c.toLowerCase())?.id ?? c)

  /** a connection reference may be attached by administrators and by people the actions service lets use the connection */
  async function assertCanAttach(ctx: UserContext, connectionId: string): Promise<void> {
    const c = await deps.meta().connections.get(connectionId)
    if (!c) throw new HttpError(422, 'invalid', `There is no connection ${connectionId}.`, 'connections')
    if (ctx.privileges.isAdmin) return
    const a = deps.actions()
    if (!a) throw new HttpError(403, 'denied', `Only administrators can attach connections to flows on this server ("${c.name}").`, 'connections')
    await a.assertCanUse(ctx, connectionId)
  }

  async function listItems(ctx: UserContext): Promise<FlowListItem[]> {
    const all = await store.list()
    const health = await store.health()
    const g = await store.grantedFlows(ctx.roles.map((r) => r.id))
    const users = new Map((await deps.meta().users.list()).map((u) => [u.id, u.name]))
    return all.map((f) => {
      const { steps, variables, ...rest } = f
      void variables
      return {
        ...rest, ownerName: users.get(f.ownerId), stepCount: countSteps(steps),
        health: health.get(f.id) ?? { runs7d: 0, succeeded7d: 0, failed7d: 0, successRate: null, lastRunOn: null, lastStatus: null, avgDurationMs: null },
        canEdit: canEdit(ctx, f), canRun: f.trigger?.type === 'manual' && (ctx.privileges.isAdmin || f.ownerId === ctx.user.id || g.has(f.id) || g.has('*')),
      }
    })
  }
  const countSteps = (steps: FlowDef['steps']): number => {
    let n = 0
    const v = (l: FlowDef['steps']) => { for (const s of l ?? []) { n++; for (const c of (STEP_KINDS.find((k) => k.kind === s.kind)?.container ? Object.values(s).filter(Array.isArray) : [])) v(c as FlowDef['steps']) } }
    v(steps)
    return n
  }

  /* ---------------------------------------------------------------- retention */

  async function retention(): Promise<number> {
    let total = 0
    for (let i = 0; i < 100; i++) {
      const ids = (await db().query<Row>(
        `SELECT r.id FROM ${T('ab_flow_runs')} r LEFT JOIN ${T('ab_flows')} f ON f.id = r.flow_id
          WHERE r.finished_on IS NOT NULL AND r.finished_on < now() - make_interval(days => COALESCE((f.definition->'settings'->>'retentionDays')::int, $1))
          LIMIT 1000`, [DEFAULT_SETTINGS.retentionDays],
      )).map((r) => String(r.id))
      if (!ids.length) break
      await db().tx(async () => {
        await db().exec(`DELETE FROM ${T('ab_flow_steps')} WHERE run_id = ANY($1::text[])`, [ids])
        await db().exec(`DELETE FROM ${T('ab_flow_waits')} WHERE run_id = ANY($1::text[])`, [ids])
        await db().exec(`DELETE FROM ${T('ab_flow_runs')} WHERE id = ANY($1::text[])`, [ids])
      })
      total += ids.length
    }
    return total
  }

  const service: FlowsService & Record<string, unknown> = {
    triggerWebhook,
    webhookFlow,
    async canManage(user: UserContext, flowId: string) {
      const f = await store.get(flowId)
      return !!f && canEdit(user, f)
    },
    async resumeWait(env: string, waitId: string, outcome: WaitOutcome) {
      return runInEnvironment(env, () => engine.resumeWait(waitId, outcome))
    },
    setApprovals(impl: ApprovalsService | null) {
      approvals = impl
    },
  }

  return {
    ...service,
    store, engine, invalidate, validate, syncSchedule, runManual, waitForResponse, canRun, canEdit, assertCanAttach, listItems, retention, triggerApprovalDecided, triggerFormSubmitted,
    catalog: () => ({ steps: STEP_KINDS, triggers: TRIGGER_TYPES, limits: FLOW_LIMITS }),
    /** tests: the flow clock (Now(), delays, timeouts, deadlines) */
    setClock: engine.setClock,
    sweep: (force = true) => engine.sweep(force),
    approvals: () => approvals,
    RunAsKind: (r: RunAs) => (typeof r === 'object' ? 'serviceAccount' : r),
  }
}
