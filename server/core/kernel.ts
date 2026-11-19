/**
 * The event and job kernel (docs/dev/events-and-jobs.md): wires the job queue (jobs.ts), the outbox (outbox.ts) and
 * table events (table-events.ts) into the services, registers the built-in job types and schedules, and gives the
 * DataService its write-path hooks. Phase 1 (flows) registers its own job types and consumes the outbox here.
 *
 * For the realtime hub: `kernel.outbox.subscribe(fn)` delivers every committed data change (OutboxEvent: environment,
 * table, op, row ids, changed columns) right after the dispatcher's commit; `kernel.outbox.read(afterId)` (inside
 * runInEnvironment) catches up.
 */
import { HttpError } from './contracts.ts'
import type { Connector, DatabaseSettings, DataService, EnvironmentRef, MetaStore, RawRow, SqlDb, UserContext } from './contracts.ts'
import type { ColumnDef, TableDef, UserDef } from '../../src/platform/contracts.ts'
import type { TableEventDef, TableEventInput, TableEventOperation } from '../../src/platform/events.ts'
import { createJobQueue, JobError, type BuiltinSchedule, type JobQueueOptions } from './jobs.ts'
import { createOutbox, snapshot, ROW_ID_CAP } from './outbox.ts'
import {
  computedProblems, createTableEvents, EVENT_JOB, FORMULA_BACKFILL_JOB, ROLLUP_RECOMPUTE_JOB, ROLLUP_RECONCILE_JOB,
} from './table-events.ts'
import { DEFAULT_ENVIRONMENT_ID, currentEnvironment } from './env-context.ts'
import { DEFAULT_CONNECTION_ID } from './connections.ts'
import { keyIndexesSql, kindOf, quoteId } from '../connectors/postgres/sql.ts'
import { errText } from './util.ts'

export const INDEX_JOB = 'index.sync'
export const DELETE_FILES_JOB = 'attachments.delete-files'
export const SWEEP_JOB = 'attachments.sweep'
export const OUTBOX_RETENTION_JOB = 'outbox.retention'
export const AUDIT_RETENTION_JOB = 'audit.retention'
/** install-wide log retention (P0 package M): run in the Default environment only */
export const SIGNIN_LOG_RETENTION_JOB = 'identity.signin-log.retention'
export const MAIL_LOG_RETENTION_JOB = 'identity.mail-log.retention'

const days = (v: string | undefined, d: number): number => {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : d
}
export const DEFAULT_OUTBOX_DAYS = days(process.env.APPBUILDER_OUTBOX_RETENTION_DAYS, 14)
export const DEFAULT_SIGNIN_LOG_DAYS = days(process.env.APPBUILDER_SIGNIN_LOG_RETENTION_DAYS, 180)
export const DEFAULT_MAIL_LOG_DAYS = days(process.env.APPBUILDER_MAIL_LOG_RETENTION_DAYS, 90)

/** install-wide built-in schedules: created in the Default environment only */
export const INSTALL_SCHEDULES: BuiltinSchedule[] = [
  { id: 'sched_signin_log_retention', name: 'Sign-in log retention', description: 'Deletes sign-in log entries (the whole install) older than the configured number of days.', cron: '53 3 * * *', jobType: SIGNIN_LOG_RETENTION_JOB, payload: { days: DEFAULT_SIGNIN_LOG_DAYS }, enabled: true },
  { id: 'sched_mail_log_retention', name: 'Email delivery log retention', description: 'Deletes email delivery log entries (recipient, subject, status; the whole install) older than the configured number of days.', cron: '57 3 * * *', jobType: MAIL_LOG_RETENTION_JOB, payload: { days: DEFAULT_MAIL_LOG_DAYS }, enabled: true },
]

export const BUILTIN_SCHEDULES: BuiltinSchedule[] = [
  { id: 'sched_outbox_retention', name: 'Outbox, run log and job retention', description: 'Deletes dispatched outbox rows, event run log entries and finished jobs older than the configured number of days.', cron: '17 3 * * *', jobType: OUTBOX_RETENTION_JOB, payload: { days: DEFAULT_OUTBOX_DAYS, eventRunDays: 30, jobDays: 14 }, enabled: true },
  { id: 'sched_audit_retention', name: 'Audit log retention', description: 'Deletes audit entries of this environment older than the configured number of days. Off until an administrator enables it.', cron: '27 3 * * *', jobType: AUDIT_RETENTION_JOB, payload: { days: 730 }, enabled: false },
  { id: 'sched_attachment_sweep', name: 'Attachment orphan sweep', description: 'Removes attachment files whose row or cell no longer references them.', cron: '37 3 * * *', jobType: SWEEP_JOB, payload: { graceMinutes: 60 }, enabled: true },
  { id: 'sched_collab_sweep', name: 'Collaboration orphan sweep', description: 'Removes comments, activities, follows, tags and file links about records deleted outside Appbuilder (and about tables that are gone).', cron: '47 3 * * *', jobType: 'collab.orphan-sweep', payload: {}, enabled: true },
  { id: 'sched_rollup_reconcile', name: 'Rollup reconcile', description: 'Recomputes every rollup column from its rows, repairing anything a missed or failed update left behind.', cron: '7 * * * *', jobType: ROLLUP_RECONCILE_JOB, payload: {}, enabled: true },
  // recycle bin (docs/dev/recycle-bin.md): the job type is registered by services.ts (registerRecycleJobs)
  { id: 'sched_recycle_purge', name: 'Recycle bin purge', description: 'Deletes for good the rows whose time in a table\'s recycle bin has run out, with their attachment files.', cron: '23 * * * *', jobType: 'data.recycle-purge', payload: { batches: 50 }, enabled: true },
]

export interface KernelDeps {
  db(): SqlDb | null
  listenSettings(): { settings: DatabaseSettings; password: string } | null
  meta(): MetaStore
  data(): DataService & { internals: { connectorFor(t: TableDef): Promise<Connector>; physical(t: TableDef): TableDef } }
  forUser(user: UserDef): Promise<UserContext>
  environments(): Promise<EnvironmentRef[]>
  /** the attachment store of the current environment */
  removeFile(storageKey: string): Promise<void>
  sweepAttachments(graceMs: number): Promise<number>
  log(level: 'info' | 'warn' | 'error', msg: string): void
  options?: JobQueueOptions
}

/** the write-path hooks the DataService calls (data.ts) */
export interface WriteHooks {
  unit<T>(def: TableDef, fn: () => Promise<T>): Promise<T>
  lockRow(def: TableDef, id: string): Promise<void>
  beforeWrite(ctx: UserContext | null, def: TableDef, op: TableEventOperation, next: RawRow, old: RawRow | null, changed: Set<string> | null): Promise<RawRow>
  hasBefore(def: TableDef, op: TableEventOperation): Promise<boolean>
  outbox(ctx: UserContext | null, def: TableDef, e: { op: 'insert' | 'update' | 'delete' | 'import' | 'bulk'; rowId?: string; rowIds?: string[]; rowCount?: number; changed?: string[] | null; before?: RawRow | null; after?: RawRow | null; snapshotColumns?: string[] | 'all'; details?: unknown }): Promise<void>
  /** delete these files after the current unit of work commits (a job); false when no queue is available */
  deleteFilesAfterCommit(storageKeys: string[]): Promise<boolean>
}

export type Kernel = ReturnType<typeof createKernel>

export function createKernel(deps: KernelDeps) {
  const jobs = createJobQueue({
    db: deps.db,
    listenSettings: deps.listenSettings,
    environments: deps.environments,
    identity: async (runAs) => {
      if (!runAs || runAs === 'system') return null
      const id = runAs.startsWith('user:') ? runAs.slice(5) : runAs
      const u = await deps.meta().users.get(id)
      if (!u) throw new Error('The user this job runs as no longer exists.')
      if (u.status === 'disabled') throw new Error(`The user this job runs as (${u.email}) is disabled.`)
      return deps.forUser(u)
    },
    log: deps.log,
    onTick: async (env) => {
      await ensureBuiltins(env)
      await outbox.dispatch(async (events) => {
        await events_.dispatch(events)
        // other consumers of the outbox (flows, P1): inside the same claiming transaction; they must not throw
        for (const d of dispatchers) await d(events)
      }).catch((e) => deps.log('warn', `outbox dispatch (${env.id}): ${errText(e)}`))
      for (const h of tickHooks) await h(env).catch((e) => deps.log('warn', `worker tick hook (${env.id}): ${errText(e)}`))
    },
  }, deps.options)
  const dispatchers: ((events: import('./outbox.ts').OutboxEvent[]) => Promise<void>)[] = []
  const tickHooks: ((env: EnvironmentRef) => Promise<void>)[] = []
  const outbox = createOutbox({ db: deps.db, log: deps.log })
  const events_ = createTableEvents({ db: deps.db, meta: deps.meta, data: deps.data, forUser: deps.forUser, jobs, outbox, log: deps.log })

  const builtinsDone = new Set<string>()
  async function ensureBuiltins(env: EnvironmentRef): Promise<void> {
    if (builtinsDone.has(env.id)) return
    await jobs.schedules.ensureBuiltins(env.id === DEFAULT_ENVIRONMENT_ID ? [...BUILTIN_SCHEDULES, ...INSTALL_SCHEDULES] : BUILTIN_SCHEDULES)
    builtinsDone.add(env.id)
  }

  const db = (): SqlDb => {
    const d = deps.db()
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }

  /* ---------------------------------------------------------------- built-in job types */

  const obj = (raw: unknown): Record<string, unknown> => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new JobError('The payload must be an object.', { retry: false })
    return raw as Record<string, unknown>
  }
  const reqStr = (o: Record<string, unknown>, k: string): string => {
    if (typeof o[k] !== 'string' || !o[k]) throw new JobError(`The payload needs "${k}".`, { retry: false })
    return o[k] as string
  }
  const numIn = (v: unknown, d: number, min: number, max: number): number => {
    const n = Number(v ?? d)
    if (!Number.isFinite(n) || n < min || n > max) throw new JobError(`A number between ${min} and ${max} is needed.`, { retry: false })
    return Math.trunc(n)
  }

  jobs.register<{ eventId: string; tableId: string; rowId: string; op: TableEventOperation; depth: number; chain: string[] } & Record<string, unknown>>({
    type: EVENT_JOB,
    description: 'Runs an after-event of a table for one changed row.',
    concurrency: 4,
    maxAttempts: 5,
    parse: (raw) => {
      const o = obj(raw)
      reqStr(o, 'eventId'); reqStr(o, 'tableId'); reqStr(o, 'rowId')
      return o as never
    },
    handler: (p, ctx) => events_.runAfterEvent(p as never, { id: ctx.job.id, attempts: ctx.job.attempts }, ctx.user),
  })

  jobs.register<{ tableId: string; column: string; ids: string[] }>({
    type: ROLLUP_RECOMPUTE_JOB,
    description: 'Recomputes rollup columns of the parent rows a change touched.',
    concurrency: 4,
    maxAttempts: 8,
    backoff: { kind: 'exponential', baseMs: 500, maxMs: 60_000 },
    parse: (raw) => {
      const o = obj(raw)
      if (!Array.isArray(o.ids) || !o.ids.every((x) => typeof x === 'string')) throw new JobError('ids must be a list of row ids.', { retry: false })
      return { tableId: reqStr(o, 'tableId'), column: reqStr(o, 'column'), ids: o.ids as string[] }
    },
    handler: async (p) => ({ changed: await events_.recomputeRollup(p.tableId, p.column, p.ids) }),
  })

  jobs.register<{ tableId?: string; column?: string }>({
    type: ROLLUP_RECONCILE_JOB,
    schedule: 'custom',
    description: 'Recomputes rollup columns from all their rows (all rollups, or one table / column).',
    concurrency: 1,
    timeoutMs: 60 * 60_000,
    parse: (raw) => {
      const o = obj(raw ?? {})
      return { tableId: typeof o.tableId === 'string' ? o.tableId : undefined, column: typeof o.column === 'string' ? o.column : undefined }
    },
    handler: async (p) => events_.reconcileRollups(p.tableId, p.column),
  })

  jobs.register<{ tableId: string; column?: string }>({
    type: FORMULA_BACKFILL_JOB,
    description: 'Recomputes a formula column on every row after its formula changed.',
    concurrency: 1,
    timeoutMs: 60 * 60_000,
    parse: (raw) => {
      const o = obj(raw)
      return { tableId: reqStr(o, 'tableId'), column: typeof o.column === 'string' ? o.column : undefined }
    },
    handler: async (p, ctx) => ({ changed: await events_.backfillFormulas(p.tableId, p.column, ctx.signal) }),
  })

  jobs.register<{ tableId: string; column: string }>({
    type: INDEX_JOB,
    description: 'Builds (or drops) the indexes of a column marked indexed, without blocking writes (CREATE INDEX CONCURRENTLY).',
    concurrency: 1,
    maxAttempts: 3,
    timeoutMs: 2 * 60 * 60_000,
    parse: (raw) => {
      const o = obj(raw)
      return { tableId: reqStr(o, 'tableId'), column: reqStr(o, 'column') }
    },
    handler: async (p) => syncIndex(p.tableId, p.column),
  })

  jobs.register<{ storageKeys: string[] }>({
    type: DELETE_FILES_JOB,
    description: 'Deletes attachment files once the change that removed them has committed.',
    concurrency: 2,
    parse: (raw) => {
      const o = obj(raw)
      if (!Array.isArray(o.storageKeys) || !o.storageKeys.every((k) => typeof k === 'string' && /^[0-9a-f]{32}$/.test(k))) throw new JobError('storageKeys must be a list of attachment keys.', { retry: false })
      return { storageKeys: o.storageKeys as string[] }
    },
    handler: async (p) => {
      const keys = [...new Set(p.storageKeys)]
      // a key still referenced by an attachment record (the change was undone, or another record) is kept
      const used = new Set((await db().query<{ k: string }>(`SELECT storage_key AS k FROM ${q(currentEnvironment().schema)}."ab_attachments" WHERE storage_key = ANY($1::text[])`, [keys])).map((r) => r.k))
      let removed = 0
      for (const k of keys) {
        if (used.has(k)) continue
        await deps.removeFile(k)
        removed++
      }
      return { removed, kept: used.size }
    },
  })

  jobs.register<{ graceMinutes: number }>({
    type: SWEEP_JOB,
    schedule: 'custom',
    description: 'Removes attachments whose table, row or cell no longer references them.',
    concurrency: 1,
    timeoutMs: 60 * 60_000,
    parse: (raw) => ({ graceMinutes: numIn(obj(raw ?? {}).graceMinutes, 60, 5, 7 * 24 * 60) }),
    handler: async (p) => ({ removed: await deps.sweepAttachments(p.graceMinutes * 60_000) }),
  })

  jobs.register<{ days: number; eventRunDays: number; jobDays: number }>({
    type: OUTBOX_RETENTION_JOB,
    schedule: 'custom',
    description: 'Deletes old outbox rows, event run log entries and finished jobs.',
    concurrency: 1,
    parse: (raw) => {
      const o = obj(raw ?? {})
      return { days: numIn(o.days, DEFAULT_OUTBOX_DAYS, 1, 3650), eventRunDays: numIn(o.eventRunDays, 30, 1, 3650), jobDays: numIn(o.jobDays, 14, 1, 3650) }
    },
    handler: async (p) => ({ outbox: await outbox.purge(p.days), eventRuns: await events_.purgeRuns(p.eventRunDays), jobs: await jobs.purge(p.jobDays) }),
  })

  jobs.register<{ days: number }>({
    type: AUDIT_RETENTION_JOB,
    description: 'Deletes audit entries of this environment older than the configured number of days.',
    concurrency: 1,
    parse: (raw) => ({ days: numIn(obj(raw ?? {}).days, 730, 30, 36500) }),
    handler: async (p) => ({ deleted: (await db().exec(`DELETE FROM ${q(currentEnvironment().schema)}."ab_audit" WHERE at < now() - make_interval(days => $1)`, [p.days])).affectedRows }),
  })

  // install-wide logs in schema ab (packages I): only from the Default environment, whose schedules install
  // administrators own; the tables may be missing in an old or partial install
  for (const [type, table, column, def, what] of [
    [SIGNIN_LOG_RETENTION_JOB, 'signin_log', 'at', 180, 'sign-in log entries'],
    [MAIL_LOG_RETENTION_JOB, 'mail_log', 'created_on', 90, 'email delivery log entries'],
  ] as const) {
    jobs.register<{ days: number }>({
      type,
      description: `Deletes ${what} of the whole install older than the configured number of days.`,
      concurrency: 1,
      schedule: 'install',
      parse: (raw) => ({ days: numIn(obj(raw ?? {}).days, def, 7, 3650) }),
      handler: async (p) => {
        if (currentEnvironment().id !== DEFAULT_ENVIRONMENT_ID) return { skipped: 'Runs in the Default environment only.' }
        const ok = (await db().query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [`ab.${table}`]))[0]?.ok
        if (!ok) return { skipped: `ab.${table} does not exist.` }
        return { deleted: (await db().exec(`DELETE FROM "ab".${q(table)} WHERE ${q(column)} < now() - make_interval(days => $1)`, [p.days])).affectedRows }
      },
    })
  }

  const q = (s: string) => `"${s}"`

  /** the key / trigram indexes a column wants, built CONCURRENTLY (an invalid leftover of a failed build is dropped first) */
  async function syncIndex(tableId: string, column: string): Promise<unknown> {
    const def = await deps.meta().tables.get(tableId)
    const col = def?.columns.find((c) => c.name === column)
    if (!def || !col) return { skipped: 'The table or column no longer exists.' }
    if ((def.connectionId ?? DEFAULT_CONNECTION_ID) !== DEFAULT_CONNECTION_ID) return { skipped: 'Only tables in the default database get background indexes.' }
    const d = db()
    const schema = currentEnvironment().schema
    const icu = !!(await d.query<{ ok: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_collation WHERE collname = 'und-x-icu') AS ok"))[0]?.ok
    const trgm = (await d.query<{ s: string }>("SELECT n.nspname AS s FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm'"))[0]?.s ?? null
    const { create, drop } = keyIndexesSql({ schema, icu }, def, col, col.indexed && kindOf(col.type) === 'text' ? trgm : null)
    const done: string[] = []
    for (const s of drop) {
      await d.exec(s.replace(/^DROP INDEX IF EXISTS/, 'DROP INDEX CONCURRENTLY IF EXISTS'))
    }
    for (const s of create) {
      const name = /INDEX (?:IF NOT EXISTS )?"([^"]+)"/.exec(s)?.[1]
      if (name) {
        const st = await d.query<{ valid: boolean }>(
          `SELECT i.indisvalid AS valid FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`,
          [schema, name],
        )
        if (st.length && st[0].valid) continue
        if (st.length) await d.exec(`DROP INDEX CONCURRENTLY IF EXISTS ${quoteId(schema)}.${quoteId(name)}`)
        done.push(name)
      }
      await d.exec(s.replace(/^CREATE (UNIQUE )?INDEX /, 'CREATE $1INDEX CONCURRENTLY '))
    }
    return { created: done, dropped: drop.length }
  }

  /* ---------------------------------------------------------------- hooks */

  const hooks: WriteHooks = {
    unit: (def, fn) => (deps.db() ? events_.unit(def, fn) : fn()),
    lockRow: (def, id) => (deps.db() ? events_.lockRow(def, id) : Promise.resolve()),
    beforeWrite: (ctx, def, op, next, old, changed) => (deps.db() ? events_.beforeWrite(ctx, def, op, next, old, changed) : Promise.resolve({})),
    async hasBefore(def, op) {
      if (!deps.db()) return false
      const r = await events_.tableRules(def)
      return r.before.some((e) => e.operations.includes(op)) || (op !== 'delete' && (r.validations.length > 0 || r.formulas.length > 0 || (op === 'create' && r.rollupCols.length > 0)))
    },
    async outbox(ctx, def, e) {
      if (!deps.db()) return
      const cols = e.snapshotColumns ?? e.changed ?? []
      let truncated = false
      const snap = (raw: RawRow | null | undefined) => {
        if (!raw) return null
        const s = snapshot(def, raw, cols)
        if (s.truncated) truncated = true
        return s.value
      }
      await events_.recordChange(ctx, def, {
        op: e.op, rowId: e.rowId ?? null, rowIds: e.rowIds, rowCount: e.rowCount ?? (e.rowIds ? e.rowIds.length : 1), changed: e.changed ?? null,
        before: snap(e.before), after: snap(e.after), details: e.details, truncated: truncated || (!!e.rowIds && e.rowIds.length > ROW_ID_CAP),
      })
    },
    async deleteFilesAfterCommit(keys) {
      if (!deps.db() || !keys.length) return !!deps.db()
      for (let i = 0; i < keys.length; i += 500) await jobs.enqueue(DELETE_FILES_JOB, { storageKeys: keys.slice(i, i + 500) }, { priority: -1 })
      return true
    },
  }

  /** Services.kernel (contracts.ts KernelServices): what the table routes need */
  const routeApi = {
    /** refuse a computed column that cannot work (bad formula, cycle, wrong rollup target) */
    async checkColumn(def: TableDef, col: ColumnDef): Promise<void> {
      if (!col.computed) return
      const tables = await deps.meta().tables.list()
      const withCol: TableDef = { ...def, columns: [...def.columns.filter((c) => c.name !== col.name), col] }
      const msg = computedProblems(withCol, col, tables.map((t) => (t.id === def.id ? withCol : t)))
      if (msg) throw new HttpError(422, 'invalid', msg, 'computed')
    },
    /** a column was added, changed or removed (same unit of work): backfills, reconciles and index builds as jobs */
    async columnChanged(def: TableDef, before: ColumnDef | null, after: ColumnDef | null): Promise<void> {
      events_.invalidate()
      if (!deps.db()) return
      if (after?.computed?.kind === 'formula' && (before?.computed?.kind !== 'formula' || before.computed.formula !== after.computed.formula || before.type !== after.type)) {
        await jobs.enqueue(FORMULA_BACKFILL_JOB, { tableId: def.id, column: after.name }, { priority: 5 })
      }
      if (after?.computed?.kind === 'rollup' && JSON.stringify(before?.computed) !== JSON.stringify(after.computed)) {
        await jobs.enqueue(ROLLUP_RECONCILE_JOB, { tableId: def.id, column: after.name }, { priority: 5 })
      }
      // a formula column that reads a changed column is recomputed when that column changes type or disappears
      if (before && !after) {
        const dependents = def.columns.filter((c) => c.computed?.kind === 'formula' && c.computed.formula.includes(before.name))
        if (dependents.length) await jobs.enqueue(FORMULA_BACKFILL_JOB, { tableId: def.id }, { priority: 5 })
      }
    },
    /** an `indexed` change on a default-database table: built in the background (true = queued, skip the inline DDL) */
    async indexInBackground(def: TableDef, col: ColumnDef): Promise<boolean> {
      if (!deps.db() || (def.connectionId ?? DEFAULT_CONNECTION_ID) !== DEFAULT_CONNECTION_ID) return false
      await jobs.enqueue(INDEX_JOB, { tableId: def.id, column: col.name }, { priority: 5 })
      return true
    },
    deleteFilesAfterCommit: hooks.deleteFilesAfterCommit,
    async tableRemoved(tableId: string): Promise<void> {
      if (deps.db()) await events_.removeForTable(tableId)
    },
    invalidate: () => events_.invalidate(),
    listEvents: (tableId: string) => events_.list(tableId),
    async putEvent(table: TableDef, ev: TableEventInput & { id?: string }, by: string | null): Promise<TableEventDef> {
      const { id, ...input } = ev
      const existing = id ? await events_.get(id) : null
      if (existing && existing.tableId === table.id) return (await events_.save(table, existing.id, input, by)).event
      return (await events_.save(table, null, input, by, { createWithId: id ?? '' })).event
    },
    async removeEvent(id: string): Promise<void> {
      await events_.remove(id)
    },
  }

  return {
    ...routeApi,
    jobs,
    outbox,
    events: events_,
    hooks,
    ensureBuiltins,
    /**
     * P1 (flows): a consumer of committed outbox rows that runs inside the dispatcher's claiming transaction, after the
     * table events (jobs it enqueues exist exactly when the rows are marked dispatched). It must catch its own errors.
     */
    addDispatcher(fn: (events: import('./outbox.ts').OutboxEvent[]) => Promise<void>): void {
      dispatchers.push(fn)
    },
    /** P1 (flows): work on every worker round per environment (due waits); errors are logged */
    addTickHook(fn: (env: EnvironmentRef) => Promise<void>): void {
      tickHooks.push(fn)
    },
    /** start the worker (and the outbox dispatcher it drives) */
    start(): void {
      if (process.env.APPBUILDER_JOBS === 'off') return
      jobs.start()
    },
    stop: (graceMs?: number) => jobs.stop(graceMs),
    /** tests: process everything that is due (outbox dispatch, jobs, follow-up jobs) */
    drain: (o?: { timeoutMs?: number }) => jobs.drain(o),
  }
}

/**
 * NotifyUser of table events -> the in-app notifications (package H's NotificationService) when the server has them;
 * otherwise the request is only logged. `to` is a user's email or id; one notification per event run and recipient
 * (the idempotency key travels as the source).
 */
export function notificationSink(s: { notifications?: import('./contracts.ts').NotificationService; readonly meta: MetaStore }): import('./table-events.ts').NotificationSink {
  return {
    async send(n) {
      const svc = s.notifications
      if (!svc) return
      const to = n.to.trim()
      const u = to.includes('@') ? await s.meta.users.byEmail(to) : await s.meta.users.get(to)
      if (!u) throw new JobError(`NotifyUser: there is no user "${to.slice(0, 80)}".`, { retry: false })
      await svc.notify({ userIds: [u.id] }, { kind: 'event', title: n.message.slice(0, 200), body: n.message.length > 200 ? n.message.slice(0, 2000) : undefined, environmentId: n.environmentId, source: `table:${n.tableId}`, link: null })
    },
  }
}
