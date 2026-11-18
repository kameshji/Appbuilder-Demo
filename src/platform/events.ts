/**
 * TABLE EVENTS, JOBS AND SCHEDULES: shapes shared by the browser (table designer, admin console) and the server
 * (server/core/table-events.ts, jobs.ts, kernel-routes.ts). Types only, plain JSON; see docs/dev/events-and-jobs.md.
 */
import type { QueryValue } from './http.ts'

/* ------------------------------------------------------------------ table events */

export type TableEventTiming = 'before' | 'after'
export type TableEventOperation = 'create' | 'update' | 'delete'
/** validation: condition + message + field (a before-event that only rejects); event: condition + action formula */
export type TableEventKind = 'validation' | 'event'

/**
 * One table event (server logic). Stored per environment in ab_table_events.
 *  - validation: before create/update; `condition` must be true for the row, else the write is refused with `message`
 *    bound to `field`.
 *  - event, timing before: runs inside the write's transaction; `actions` may SetField(...) and Reject(...), and read
 *    other tables (LookUp, Filter, CountRows ... pushed down to the database).
 *  - event, timing after: runs once the write has committed, through the job queue (at least once); `actions` may
 *    Patch / Collect / Remove rows, NotifyUser, RunConnector, EnqueueJob.
 */
export interface TableEventDef {
  id: string
  tableId: string
  name: string
  kind: TableEventKind
  timing: TableEventTiming
  operations: TableEventOperation[]
  /** run order among the table's events of the same timing (lower first) */
  order: number
  enabled: boolean
  /** validation: must be true; event: the event runs only when true (blank = always) */
  condition?: string
  /** event: the action formula (several actions separated by ;) */
  actions?: string
  /** validation: the message shown when the condition is false */
  message?: string
  /** validation: the column the message belongs to (shown on that form field) */
  field?: string
  /** whose permissions reads and writes use: the user who made the change (default), or the system (administrators only) */
  runAs: 'caller' | 'system'
  description?: string
  createdOn: string
  modifiedOn: string
  modifiedBy?: string
}

/** fields a maker sends to create or change an event (the server fills ids, times and defaults) */
export type TableEventInput = Partial<Omit<TableEventDef, 'id' | 'tableId' | 'createdOn' | 'modifiedOn' | 'modifiedBy'>>

export type EventRunStatus = 'ok' | 'rejected' | 'failed' | 'skipped'

/** one entry of the events run log (ab_event_runs) */
export interface EventRunEntry {
  id: number
  at: string
  eventId: string | null
  eventName: string
  tableId: string
  rowId: string | null
  timing: TableEventTiming
  op: TableEventOperation
  status: EventRunStatus
  durationMs: number
  message?: string
  /** field values set (before) or writes made (after) */
  details?: unknown
  jobId?: string
  correlationId?: string
}

/** a formula problem reported by the server's check (save time) */
export interface FormulaProblem {
  message: string
  start: number
  end: number
}

/** POST /tables/:id/events/test: what the event would do to a sample row (nothing is written) */
export interface EventTestResult {
  /** the condition was false: the event would not run */
  skipped?: boolean
  rejected?: { message: string; field?: string }
  /** before-events: field values the event sets */
  changes: Record<string, QueryValue>
  /** after-events: the writes it would make (not made) */
  writes: { op: 'patch' | 'collect' | 'remove'; table: string; values?: Record<string, QueryValue>; rowId?: string }[]
  notifications: { to: string; message: string }[]
  jobs: { type: string; payload: unknown }[]
  traces: string[]
  error?: string
  durationMs: number
  rowsRead: number
}

/* ------------------------------------------------------------------ computed columns */

export type RollupFn = 'count' | 'sum' | 'min' | 'max'

/**
 * A column whose value the server computes and stores (ColumnDef.computed). Read-only in forms and grids.
 *  - formula: evaluated on every write that changes one of its inputs (New, ThisRecord and bare column names), stored;
 *    a backfill job recomputes every row when the formula changes.
 *  - rollup: count / sum / min / max of the rows of `table` whose lookup column `via` points at this row; maintained
 *    after each change of those rows (job queue) and by a periodic reconcile job. Both tables on the default database.
 */
export type ComputedColumn =
  | { kind: 'formula'; formula: string }
  | { kind: 'rollup'; table: string; via: string; fn: RollupFn; column?: string }

/* ------------------------------------------------------------------ jobs and schedules */

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'cancelled'

export interface BackoffPolicy {
  kind: 'exponential' | 'fixed'
  /** first delay (ms) */
  baseMs: number
  /** longest delay (ms) */
  maxMs: number
}

/** one row of ab_jobs, as the admin console sees it */
export interface JobInfo {
  id: string
  type: string
  state: JobState
  priority: number
  runAt: string
  attempts: number
  maxAttempts: number
  /** "system" or "user:<id>" */
  runAs: string
  createdBy?: string
  correlationId?: string
  idempotencyKey?: string
  lockedBy?: string
  heartbeatAt?: string
  payload: unknown
  result?: unknown
  error?: { message: string; at?: string; attempt?: number }
  createdOn: string
  startedOn?: string
  finishedOn?: string
}

export type MisfirePolicy = 'skip' | 'run_once'

export interface ScheduleInfo {
  id: string
  name: string
  description?: string
  /** 5-field cron ("0 2 * * *") or @daily / @hourly ...; or intervalSeconds */
  cron?: string
  intervalSeconds?: number
  timeZone: string
  jobType: string
  payload: unknown
  enabled: boolean
  misfire: MisfirePolicy
  builtIn: boolean
  lastRunAt?: string
  nextRunAt?: string
  lastJobId?: string
  lastJobState?: JobState
}

export interface JobTypeInfo { type: string; description: string; concurrency: number; maxAttempts: number; schedule?: 'custom' | 'install' }

/** GET /admin/jobs/metrics */
export interface JobMetrics {
  /** jobs per state */
  states: Record<JobState, number>
  /** queued + failed (waiting for a retry) jobs per type */
  depthByType: Record<string, number>
  /** age (seconds) of the oldest job that is due and waiting; 0 when none */
  oldestQueuedSeconds: number
  /** failed attempts and dead jobs in the last 24 hours */
  failures24h: number
  dead: number
  /** succeeded in the last hour */
  succeededLastHour: number
  running: { id: string; type: string; startedOn?: string; lockedBy?: string }[]
  /** this server's worker */
  worker: { id: string; running: number; concurrency: number; listening: boolean; pollMs: number }
  /** outbox rows waiting to be dispatched, and the oldest one's age (seconds) */
  outbox: { pending: number; oldestSeconds: number }
  types: JobTypeInfo[]
}
