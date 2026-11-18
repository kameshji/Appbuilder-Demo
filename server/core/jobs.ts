/**
 * Job queue, worker and schedules (docs/dev/events-and-jobs.md). One table per environment (ab_jobs, ab_schedules,
 * kernel-ddl.ts); one worker per server process serves every ready environment.
 *
 * Guarantees:
 *  - enqueue joins the caller's unit of work: a job enqueued inside a transaction exists only if it commits (the
 *    write path and the outbox dispatcher rely on this). An idempotency key is unique per environment: enqueueing the
 *    same key twice returns the first job.
 *  - claiming uses FOR UPDATE SKIP LOCKED, so two workers never run the same attempt. A running job has a heartbeat;
 *    when it stops for longer than the visibility timeout (a crashed or frozen worker) the reaper puts the job back
 *    (state failed, retried) or, when its attempts are used up, dead. Handlers must therefore be idempotent: delivery
 *    is at least once.
 *  - failures retry with exponential backoff and jitter up to maxAttempts, then the job is dead (dead letter). A
 *    handler that throws a permanent error (JobError with retry false, or a 4xx HttpError) goes to dead at once.
 *  - concurrency is limited globally and per job type. Wake-up: LISTEN/NOTIFY on channel ab_jobs (sent when a job is
 *    enqueued and at commit), polling as the fallback.
 *  - graceful stop: no new claims; running jobs get `graceMs` to finish, the rest are released (queued again,
 *    the attempt not counted).
 *  - every job runs inside its environment (runInEnvironment) and under an explicit identity: the system, or a user
 *    whose roles in that environment apply (run_as "user:<id>").
 *  - schedules: a scheduler tick enqueues each due slot exactly once (idempotency key "sched:<id>:<slot>" in the same
 *    transaction that advances next_run_at), also across restarts and with two workers. Misfires after downtime: skip,
 *    or run once.
 */
import os from 'node:os'
import pg from 'pg'
import { HttpError } from './contracts.ts'
import type { DatabaseSettings, EnvironmentRef, SqlDb, UserContext } from './contracts.ts'
import type {
  BackoffPolicy, JobInfo, JobMetrics, JobState, JobTypeInfo, MisfirePolicy, ScheduleInfo,
} from '../../src/platform/events.ts'
import { poolConfig } from '../connectors/postgres/db.ts'
import { currentEnvironment, runInEnvironment } from './env-context.ts'
import { currentWork, runWithWork } from './work-context.ts'
import { CronError, checkTimeZone, nextCron, parseCron } from './cron.ts'
import { errText, rowUid } from './util.ts'

/* ------------------------------------------------------------------ public types */

/** a failure the worker must not retry (retry: false) */
export class JobError extends Error {
  retry: boolean
  constructor(message: string, opts: { retry?: boolean } = {}) {
    super(message)
    this.retry = opts.retry ?? true
  }
}

export interface JobContext {
  job: JobInfo
  environmentId: string
  /** null: the system; otherwise the user the job runs as, with their roles in this environment */
  user: UserContext | null
  /** aborted when the worker stops or the job times out */
  signal: AbortSignal
  /** long jobs: prove they are alive between steps (the worker also beats every visibility/3) */
  heartbeat(): Promise<void>
  log(level: 'info' | 'warn' | 'error', msg: string): void
}

export interface JobTypeDef<P = unknown> {
  type: string
  description: string
  /** turns the stored payload into the typed one; throw JobError({retry:false}) when it is malformed */
  parse?(raw: unknown): P
  handler(payload: P, ctx: JobContext): Promise<unknown>
  /** at most this many jobs of the type run at once in this process (default 4) */
  concurrency?: number
  maxAttempts?: number
  backoff?: BackoffPolicy
  /** abort after this long (default 5 minutes) */
  timeoutMs?: number
  /** may be enqueued by a table event (EnqueueJob); default false */
  eventAllowed?: boolean
}

export interface EnqueueOptions {
  runAt?: Date
  delayMs?: number
  priority?: number
  maxAttempts?: number
  backoff?: BackoffPolicy
  idempotencyKey?: string
  correlationId?: string
  /** default system */
  runAs?: 'system' | { userId: string }
  createdBy?: string | null
}

export interface ScheduleInput {
  name?: string
  description?: string | null
  cron?: string | null
  intervalSeconds?: number | null
  timeZone?: string
  jobType?: string
  payload?: unknown
  enabled?: boolean
  misfire?: MisfirePolicy
}

export interface BuiltinSchedule {
  id: string
  name: string
  description: string
  cron?: string
  intervalSeconds?: number
  jobType: string
  payload: unknown
  enabled: boolean
  misfire?: MisfirePolicy
}

export interface JobQueueOptions {
  /** polling fallback (default 1000 ms; APPBUILDER_JOBS_POLL_MS) */
  pollMs?: number
  /** a running job without a heartbeat for this long is taken back (default 30 s; APPBUILDER_JOBS_VISIBILITY_MS) */
  visibilityMs?: number
  /** jobs at once in this process (default 8; APPBUILDER_JOBS_CONCURRENCY) */
  concurrency?: number
  /** scheduler tick per environment (default 5 s) */
  schedulerEveryMs?: number
  /** how late a slot may be before the misfire policy applies (default 60 s) */
  misfireGraceMs?: number
  workerId?: string
}

export interface JobDeps {
  db(): SqlDb | null
  /** LISTEN needs its own connection: the settings and password of the system database */
  listenSettings(): { settings: DatabaseSettings; password: string } | null
  /** the environments the worker serves (ready ones) */
  environments(): Promise<EnvironmentRef[]>
  /** run_as -> identity, inside the job's environment (throws when the user cannot be used) */
  identity(runAs: string): Promise<UserContext | null>
  log(level: 'info' | 'warn' | 'error', msg: string): void
  /** called after each dispatch-worthy wake-up (the outbox dispatcher hooks in here) */
  onTick?(env: EnvironmentRef): Promise<void>
}

export const DEFAULT_BACKOFF: BackoffPolicy = { kind: 'exponential', baseMs: 2000, maxMs: 10 * 60_000 }
export const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_TIMEOUT_MS = 5 * 60_000
const MAX_PAYLOAD = 256 * 1024
const MAX_RESULT = 32 * 1024
export const JOB_CHANNEL = 'ab_jobs'
export const OUTBOX_CHANNEL = 'ab_outbox'

/** delay before attempt `attempt + 1` (attempt counts from 1): exponential with full jitter in [50 %, 100 %] */
export function backoffDelay(attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF, random = Math.random): number {
  const base = Math.max(0, policy.baseMs)
  const raw = policy.kind === 'fixed' ? base : base * 2 ** Math.max(0, attempt - 1)
  const capped = Math.min(Math.max(base, policy.maxMs), raw)
  return Math.round(capped * (0.5 + random() * 0.5))
}

const envNum = (v: string | undefined, min: number): number | undefined => {
  const n = Number(v)
  return Number.isFinite(n) && n >= min ? n : undefined
}

/* ------------------------------------------------------------------ helpers */

type Row = Record<string, unknown>
const q = (id: string): string => `"${id}"`
const T = (t: string): string => `${q(currentEnvironment().schema)}.${q(t)}`
const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : v ? new Date(String(v)).toISOString() : undefined)
const str = (v: unknown): string | undefined => (v === null || v === undefined || v === '' ? undefined : String(v))
const jsonText = (v: unknown, cap: number): string => {
  let s = JSON.stringify(v === undefined ? null : v) ?? 'null'
  s = s.replace(/(?<!\\)\\u0000/g, '')
  return s.length > cap ? JSON.stringify({ truncated: true, preview: s.slice(0, Math.min(cap, 2000)) }) : s
}

export function toJobInfo(r: Row): JobInfo {
  const j: JobInfo = {
    id: String(r.id), type: String(r.type), state: String(r.state) as JobState, priority: Number(r.priority) || 0,
    runAt: iso(r.run_at) ?? '', attempts: Number(r.attempts) || 0, maxAttempts: Number(r.max_attempts) || 1,
    runAs: String(r.run_as ?? 'system'), payload: r.payload ?? null, createdOn: iso(r.created_on) ?? '',
  }
  const opt = (k: keyof JobInfo, v: unknown) => { if (v !== undefined && v !== null && v !== '') (j as unknown as Record<string, unknown>)[k] = v }
  opt('createdBy', str(r.created_by))
  opt('correlationId', str(r.correlation_id))
  opt('idempotencyKey', str(r.idempotency_key))
  opt('lockedBy', str(r.locked_by))
  opt('heartbeatAt', iso(r.heartbeat_at))
  opt('result', r.result)
  opt('error', r.error)
  opt('startedOn', iso(r.started_on))
  opt('finishedOn', iso(r.finished_on))
  return j
}

function toSchedule(r: Row): ScheduleInfo {
  const s: ScheduleInfo = {
    id: String(r.id), name: String(r.name), timeZone: String(r.time_zone ?? 'UTC'), jobType: String(r.job_type), payload: r.payload ?? {},
    enabled: r.enabled === true, misfire: r.misfire === 'skip' ? 'skip' : 'run_once', builtIn: r.built_in === true,
  }
  if (str(r.description)) s.description = String(r.description)
  if (str(r.cron)) s.cron = String(r.cron)
  if (r.interval_seconds !== null && r.interval_seconds !== undefined) s.intervalSeconds = Number(r.interval_seconds)
  if (iso(r.last_run_at)) s.lastRunAt = iso(r.last_run_at)
  if (iso(r.next_run_at)) s.nextRunAt = iso(r.next_run_at)
  if (str(r.last_job_id)) s.lastJobId = String(r.last_job_id)
  if (str(r.last_job_state)) s.lastJobState = String(r.last_job_state) as JobState
  return s
}

/** permanent = retrying cannot help: JobError(retry false), or a 4xx answer other than 408/409/429 */
export function isPermanent(e: unknown): boolean {
  if (e instanceof JobError) return !e.retry
  if (e instanceof HttpError) return e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status)
  return false
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 2000)

/* ------------------------------------------------------------------ the queue */

export type JobQueue = ReturnType<typeof createJobQueue>

interface Running {
  envId: string
  id: string
  type: string
  abort: AbortController
  done: Promise<void>
  startedAt: number
}

export function createJobQueue(deps: JobDeps, options: JobQueueOptions = {}) {
  const env = process.env
  const pollMs = options.pollMs ?? envNum(env.APPBUILDER_JOBS_POLL_MS, 20) ?? 1000
  const visibilityMs = options.visibilityMs ?? envNum(env.APPBUILDER_JOBS_VISIBILITY_MS, 500) ?? 30_000
  const concurrency = options.concurrency ?? envNum(env.APPBUILDER_JOBS_CONCURRENCY, 1) ?? 8
  const schedulerEveryMs = options.schedulerEveryMs ?? 5000
  const misfireGraceMs = options.misfireGraceMs ?? 60_000
  const workerId = options.workerId ?? `${os.hostname()}:${process.pid}:${rowUid().slice(-6)}`

  const types = new Map<string, JobTypeDef<unknown>>()
  const running = new Map<string, Running>()
  const lastReap = new Map<string, number>()
  const lastSchedule = new Map<string, number>()
  let started = false
  let stopping = false
  let timer: NodeJS.Timeout | null = null
  let beat: NodeJS.Timeout | null = null
  let ticking: Promise<void> | null = null
  let again = false
  let listener: pg.Client | null = null
  let listening = false
  let listenRetry: NodeJS.Timeout | null = null

  const db = (): SqlDb => {
    const d = deps.db()
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }

  /* ---------------------------------------------------------------- registry */

  function register<P>(def: JobTypeDef<P>): void {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(def.type)) throw new Error(`bad job type name ${def.type}`)
    types.set(def.type, def as JobTypeDef<unknown>)
  }
  const typeInfo = (): JobTypeInfo[] => [...types.values()].map((t) => ({ type: t.type, description: t.description, concurrency: t.concurrency ?? 4, maxAttempts: t.maxAttempts ?? DEFAULT_MAX_ATTEMPTS }))

  /* ---------------------------------------------------------------- enqueue */

  /** in the current environment; joins the caller's transaction (the job exists only if it commits) */
  async function enqueue(type: string, payload: unknown, o: EnqueueOptions = {}): Promise<{ id: string; created: boolean }> {
    const def = types.get(type)
    if (!def) throw new HttpError(422, 'invalid', `There is no job type "${String(type).slice(0, 64)}".`)
    if (def.parse) def.parse(payload)
    const body = JSON.stringify(payload ?? {})
    if (body.length > MAX_PAYLOAD) throw new HttpError(422, 'invalid', `The job payload is larger than ${MAX_PAYLOAD / 1024} KB.`)
    const key = o.idempotencyKey ? String(o.idempotencyKey).slice(0, 255) : null
    const runAt = o.runAt ?? new Date(Date.now() + Math.max(0, o.delayMs ?? 0))
    const runAs = !o.runAs || o.runAs === 'system' ? 'system' : `user:${o.runAs.userId}`
    const work = currentWork()
    const now = new Date()
    const id = rowUid()
    const d = db()
    const rows = await d.query<Row>(
      `INSERT INTO ${T('ab_jobs')} (id, type, payload, state, priority, run_at, attempts, max_attempts, backoff, idempotency_key, correlation_id, run_as, created_by, created_on, modified_on)
       VALUES ($1, $2, $3::jsonb, 'queued', $4, $5, 0, $6, $7::jsonb, $8, $9, $10, $11, $12, $12)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`,
      [id, type, body, Math.trunc(o.priority ?? 0), runAt, Math.max(1, Math.trunc(o.maxAttempts ?? def.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)),
        JSON.stringify(o.backoff ?? def.backoff ?? DEFAULT_BACKOFF), key, o.correlationId ?? work.correlationId ?? null, runAs, o.createdBy ?? null, now],
    )
    if (!rows.length) {
      const existing = await d.query<Row>(`SELECT id FROM ${T('ab_jobs')} WHERE idempotency_key = $1`, [key])
      return { id: String(existing[0]?.id ?? ''), created: false }
    }
    await d.query('SELECT pg_notify($1, $2)', [JOB_CHANNEL, currentEnvironment().id])
    return { id, created: true }
  }

  /* ---------------------------------------------------------------- worker */

  function wake(): void {
    if (!started || stopping) return
    if (ticking) {
      again = true
      return
    }
    if (timer) clearTimeout(timer)
    timer = null
    ticking = tick().catch((e) => deps.log('warn', `job worker: ${errText(e)}`)).finally(() => {
      ticking = null
      if (stopping) return
      if (again) {
        again = false
        setImmediate(wake)
      } else schedule()
    })
  }
  function schedule(): void {
    if (!started || stopping || timer) return
    timer = setTimeout(() => {
      timer = null
      wake()
    }, pollMs)
    timer.unref()
  }

  /** one round over every environment: reap lost jobs, run the scheduler, claim and start due jobs */
  async function tick(): Promise<void> {
    if (!deps.db() || stopping) return
    // the database may have been configured after the worker started (setup screen): LISTEN then
    if (started && !listener && !listenRetry) void listen()
    for (const e of await deps.environments()) {
      if (stopping) return
      try {
        await runInEnvironment(e.id, () => tickEnvironment(e))
      } catch (err) {
        deps.log('warn', `job worker, environment ${e.id}: ${errText(err)}`)
      }
    }
  }

  async function tickEnvironment(e: EnvironmentRef): Promise<void> {
    const now = Date.now()
    if (now - (lastReap.get(e.id) ?? 0) >= Math.max(250, visibilityMs / 2)) {
      lastReap.set(e.id, now)
      await reap()
    }
    if (now - (lastSchedule.get(e.id) ?? 0) >= schedulerEveryMs) {
      lastSchedule.set(e.id, now)
      await schedulerTick()
    }
    if (deps.onTick) await deps.onTick(e)
    await claim(e)
  }

  const runningOf = (type: string): number => [...running.values()].filter((r) => r.type === type).length

  async function claim(e: EnvironmentRef): Promise<number> {
    let free = concurrency - running.size
    if (free <= 0 || stopping) return 0
    const d = db()
    const due = await d.query<Row>(`SELECT type, count(*)::int AS n FROM ${T('ab_jobs')} WHERE state IN ('queued', 'failed') AND run_at <= now() GROUP BY type`)
    let n = 0
    for (const r of due) {
      const def = types.get(String(r.type))
      if (!def) continue
      const room = Math.min(free, (def.concurrency ?? 4) - runningOf(def.type), Number(r.n))
      if (room <= 0) continue
      const claimed = await d.query<Row>(
        `UPDATE ${T('ab_jobs')} SET state = 'running', locked_by = $3, locked_at = now(), heartbeat_at = now(), attempts = attempts + 1,
           started_on = now(), modified_on = now()
         WHERE id IN (SELECT id FROM ${T('ab_jobs')} WHERE state IN ('queued', 'failed') AND run_at <= now() AND type = $1
                      ORDER BY priority DESC, run_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
         RETURNING *`,
        [def.type, room, workerId],
      )
      for (const row of claimed) start(e, def, row)
      free -= claimed.length
      n += claimed.length
      if (free <= 0) break
    }
    return n
  }

  function start(e: EnvironmentRef, def: JobTypeDef<unknown>, row: Row): void {
    const abort = new AbortController()
    const id = String(row.id)
    const key = `${e.id}:${id}`
    const entry: Running = { envId: e.id, id, type: def.type, abort, startedAt: Date.now(), done: Promise.resolve() }
    running.set(key, entry)
    entry.done = runInEnvironment(e.id, () => execute(e, def, row, abort))
      .catch((err) => deps.log('error', `job ${id} (${def.type}): ${errText(err)}`))
      .finally(() => {
        running.delete(key)
        wake()
      })
  }

  async function execute(e: EnvironmentRef, def: JobTypeDef<unknown>, row: Row, abort: AbortController): Promise<void> {
    const job = toJobInfo(row)
    const pl = (row.payload ?? {}) as { depth?: unknown; chain?: unknown }
    const work = { correlationId: job.correlationId, jobId: job.id, depth: Number(pl.depth) || 0, chain: Array.isArray(pl.chain) ? pl.chain.map(String).slice(-32) : [] }
    let timeout: NodeJS.Timeout | null = null
    try {
      const out = await runWithWork(work, async () => {
        let payload: unknown = row.payload
        if (def.parse) {
          try {
            payload = def.parse(row.payload)
          } catch (err) {
            throw err instanceof JobError ? err : new JobError(`The payload is not valid: ${errorMessage(err)}`, { retry: false })
          }
        }
        let user: UserContext | null
        try {
          user = await deps.identity(job.runAs)
        } catch (err) {
          throw new JobError(errorMessage(err), { retry: false })
        }
        const ctx: JobContext = {
          job, environmentId: e.id, user, signal: abort.signal,
          heartbeat: async () => { await db().exec(`UPDATE ${T('ab_jobs')} SET heartbeat_at = now() WHERE id = $1 AND locked_by = $2 AND state = 'running'`, [job.id, workerId]) },
          log: (l, m) => deps.log(l, `job ${job.id} (${job.type}): ${m}`),
        }
        const aborted = new Promise<never>((_, reject) => {
          abort.signal.addEventListener('abort', () => reject(abort.signal.reason instanceof Error ? abort.signal.reason : new Error('The job was stopped.')), { once: true })
        })
        timeout = setTimeout(() => abort.abort(new Error(`The job took longer than ${Math.round((def.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} s and was stopped.`)), def.timeoutMs ?? DEFAULT_TIMEOUT_MS)
        timeout.unref()
        return Promise.race([def.handler(payload, ctx), aborted])
      })
      await db().exec(
        `UPDATE ${T('ab_jobs')} SET state = 'succeeded', result = $3::jsonb, error = NULL, finished_on = now(), locked_by = NULL, modified_on = now()
         WHERE id = $1 AND locked_by = $2 AND state = 'running'`,
        [job.id, workerId, jsonText(out ?? null, MAX_RESULT)],
      )
    } catch (err) {
      // a stopping worker releases its jobs itself (stop()); a cancelled one was marked by cancel()
      if (abort.signal.aborted && (stopping || (abort.signal.reason as { cancelled?: boolean } | undefined)?.cancelled)) return
      const permanent = isPermanent(err)
      const dead = permanent || job.attempts >= job.maxAttempts
      const delay = backoffDelay(job.attempts, (row.backoff as BackoffPolicy | null) ?? DEFAULT_BACKOFF)
      const error = { message: errorMessage(err), at: new Date().toISOString(), attempt: job.attempts, ...(permanent ? { permanent: true } : {}) }
      await db().exec(
        `UPDATE ${T('ab_jobs')} SET state = $3, error = $4::jsonb, run_at = CASE WHEN $3 = 'failed' THEN now() + make_interval(secs => $5) ELSE run_at END,
           finished_on = CASE WHEN $3 = 'dead' THEN now() ELSE NULL END, locked_by = NULL, modified_on = now()
         WHERE id = $1 AND locked_by = $2 AND state = 'running'`,
        [job.id, workerId, dead ? 'dead' : 'failed', JSON.stringify(error), delay / 1000],
      ).catch((e2) => deps.log('error', `job ${job.id}: could not record its failure: ${errText(e2)}`))
      deps.log(dead ? 'error' : 'warn', `job ${job.id} (${job.type}) attempt ${job.attempts}/${job.maxAttempts} failed${dead ? ' (dead)' : ''}: ${error.message}`)
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  /** running jobs whose heartbeat stopped (a crashed or frozen worker) go back to the queue, or to dead */
  async function reap(): Promise<number> {
    const mine = [...running.values()].filter((r) => r.envId === currentEnvironment().id).map((r) => r.id)
    const rows = await db().query<Row>(
      `UPDATE ${T('ab_jobs')} SET
         state = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'failed' END,
         finished_on = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
         run_at = now(), locked_by = NULL, modified_on = now(),
         error = jsonb_build_object('message', 'The worker running this job stopped responding (no heartbeat for ' || $1::text || ' s).',
                                    'at', now(), 'attempt', attempts, 'lostWorker', locked_by)
       WHERE state = 'running' AND heartbeat_at < now() - make_interval(secs => $2) AND NOT (locked_by = $3 AND id = ANY($4::text[]))
       RETURNING id`,
      [String(Math.round(visibilityMs / 1000)), visibilityMs / 1000, workerId, mine],
    )
    if (rows.length) deps.log('warn', `job worker: ${rows.length} job(s) lost their worker and were put back (environment ${currentEnvironment().id})`)
    return rows.length
  }

  async function heartbeatAll(): Promise<void> {
    const byEnv = new Map<string, string[]>()
    for (const r of running.values()) byEnv.set(r.envId, [...(byEnv.get(r.envId) ?? []), r.id])
    for (const [envId, ids] of byEnv) {
      await runInEnvironment(envId, () => db().exec(`UPDATE ${T('ab_jobs')} SET heartbeat_at = now() WHERE locked_by = $1 AND state = 'running' AND id = ANY($2::text[])`, [workerId, ids]))
        .catch((e) => deps.log('warn', `job heartbeat: ${errText(e)}`))
    }
  }

  /* ---------------------------------------------------------------- LISTEN / NOTIFY */

  async function listen(): Promise<void> {
    const cfg = deps.listenSettings()
    if (!cfg || stopping || listener) return
    const c = new pg.Client(poolConfig(cfg.settings, cfg.password))
    c.on('error', (e) => {
      deps.log('warn', `job worker: lost the LISTEN connection (${e.message}); polling every ${pollMs} ms until it is back`)
      drop()
    })
    c.on('end', () => drop())
    c.on('notification', () => wake())
    const drop = () => {
      if (listener !== c) return
      listener = null
      listening = false
      c.end().catch(() => {})
      if (!stopping && !listenRetry) {
        listenRetry = setTimeout(() => { listenRetry = null; void listen() }, 5000)
        listenRetry.unref()
      }
    }
    try {
      listener = c
      await c.connect()
      await c.query(`LISTEN ${JOB_CHANNEL}`)
      await c.query(`LISTEN ${OUTBOX_CHANNEL}`)
      listening = true
    } catch (e) {
      deps.log('warn', `job worker: LISTEN not available (${errText(e)}); polling every ${pollMs} ms`)
      drop()
    }
  }

  function startWorker(): void {
    if (started) return
    started = true
    stopping = false
    void listen()
    beat = setInterval(() => void heartbeatAll(), Math.max(200, Math.floor(visibilityMs / 3)))
    beat.unref()
    wake()
  }

  /** stop claiming; give running jobs graceMs to finish; release the rest (queued again, attempt not counted) */
  async function stop(graceMs = 10_000): Promise<void> {
    if (!started) return
    stopping = true
    if (timer) clearTimeout(timer)
    if (beat) clearInterval(beat)
    if (listenRetry) clearTimeout(listenRetry)
    timer = beat = listenRetry = null
    if (ticking) await ticking.catch(() => {})
    const all = [...running.values()]
    if (all.length) {
      let t: NodeJS.Timeout | null = null
      await Promise.race([Promise.all(all.map((r) => r.done)), new Promise<void>((r) => { t = setTimeout(r, graceMs) })])
      if (t) clearTimeout(t)
    }
    const left = [...running.values()]
    for (const r of left) r.abort.abort(new Error('The server is stopping.'))
    const byEnv = new Map<string, string[]>()
    for (const r of left) byEnv.set(r.envId, [...(byEnv.get(r.envId) ?? []), r.id])
    for (const [envId, ids] of byEnv) {
      await runInEnvironment(envId, () => db().exec(
        `UPDATE ${T('ab_jobs')} SET state = 'queued', locked_by = NULL, attempts = GREATEST(attempts - 1, 0), run_at = now(), modified_on = now()
         WHERE locked_by = $1 AND state = 'running' AND id = ANY($2::text[])`, [workerId, ids],
      )).catch((e) => deps.log('warn', `job worker: could not release jobs: ${errText(e)}`))
    }
    if (left.length) deps.log('info', `job worker: released ${left.length} running job(s) for the next start`)
    const l = listener
    listener = null
    listening = false
    if (l) await l.end().catch(() => {})
    started = false
    // stopped, not dead: drain() (tests, maintenance) and a later start() still work
    stopping = false
  }

  /** tests and "run now": rounds until nothing is due or running (at most `maxRounds`) */
  async function drain(o: { maxRounds?: number; timeoutMs?: number } = {}): Promise<void> {
    const end = Date.now() + (o.timeoutMs ?? 30_000)
    for (let i = 0; i < (o.maxRounds ?? 10_000) && Date.now() < end; i++) {
      await tick()
      if (running.size) await Promise.race([Promise.all([...running.values()].map((r) => r.done)), new Promise((r) => setTimeout(r, 20))])
      if (!running.size) {
        let due = 0
        for (const e of await deps.environments()) {
          // jobs waiting for a retry within a few seconds count too (their backoff is short), and jobs this worker has
          // claimed but not started yet (the background loop's claim can commit before its start() runs)
          due += await runInEnvironment(e.id, async () => Number((await db().query<Row>(`SELECT count(*)::int AS n FROM ${T('ab_jobs')} WHERE ((state IN ('queued', 'failed') AND run_at <= now() + interval '5 seconds') OR (state = 'running' AND locked_by = $2)) AND type = ANY($1::text[])`, [[...types.keys()], workerId]))[0]?.n ?? 0))
          if (deps.onTick) due += await runInEnvironment(e.id, async () => Number((await db().query<Row>(`SELECT count(*)::int AS n FROM ${T('ab_outbox')} WHERE dispatched_on IS NULL`))[0]?.n ?? 0))
        }
        if (!due) return
        await new Promise((r) => setTimeout(r, 10))
      }
    }
  }

  /* ---------------------------------------------------------------- admin */

  async function get(id: string): Promise<JobInfo | null> {
    const rows = await db().query<Row>(`SELECT * FROM ${T('ab_jobs')} WHERE id = $1`, [id])
    return rows.length ? toJobInfo(rows[0]) : null
  }

  async function list(f: { state?: JobState | 'active'; type?: string; limit?: number; offset?: number } = {}): Promise<{ items: JobInfo[]; total: number }> {
    const where: string[] = []
    const params: unknown[] = []
    if (f.state === 'active') where.push(`state IN ('queued', 'running', 'failed')`)
    else if (f.state) { params.push(f.state); where.push(`state = $${params.length}`) }
    if (f.type) { params.push(f.type); where.push(`type = $${params.length}`) }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = Number((await db().query<Row>(`SELECT count(*)::int AS n FROM ${T('ab_jobs')} ${w}`, params))[0]?.n ?? 0)
    const limit = Math.max(1, Math.min(500, Math.trunc(f.limit ?? 50)))
    const offset = Math.max(0, Math.trunc(f.offset ?? 0))
    const rows = await db().query<Row>(`SELECT * FROM ${T('ab_jobs')} ${w} ORDER BY created_on DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, params)
    return { items: rows.map(toJobInfo), total }
  }

  /** failed / dead / cancelled -> queued now, attempts start again */
  async function retry(id: string): Promise<JobInfo> {
    const rows = await db().query<Row>(
      `UPDATE ${T('ab_jobs')} SET state = 'queued', run_at = now(), attempts = 0, finished_on = NULL, locked_by = NULL, modified_on = now()
       WHERE id = $1 AND state IN ('failed', 'dead', 'cancelled') RETURNING *`, [id],
    )
    if (!rows.length) {
      const j = await get(id)
      if (!j) throw new HttpError(404, 'not-found', 'Job not found.')
      throw new HttpError(409, 'conflict', `A ${j.state} job cannot be retried.`)
    }
    await db().query('SELECT pg_notify($1, $2)', [JOB_CHANNEL, currentEnvironment().id])
    return toJobInfo(rows[0])
  }

  /** queued / failed -> cancelled; a job running in this process is stopped and cancelled */
  async function cancel(id: string): Promise<JobInfo> {
    const r = running.get(`${currentEnvironment().id}:${id}`)
    if (r) r.abort.abort(Object.assign(new Error('Cancelled by an administrator.'), { cancelled: true }))
    const rows = await db().query<Row>(
      `UPDATE ${T('ab_jobs')} SET state = 'cancelled', finished_on = now(), locked_by = NULL, modified_on = now(),
         error = COALESCE(error, '{}'::jsonb) || jsonb_build_object('message', 'Cancelled by an administrator.', 'at', now())
       WHERE id = $1 AND (state IN ('queued', 'failed') OR (state = 'running' AND locked_by = $2)) RETURNING *`, [id, workerId],
    )
    if (!rows.length) {
      const j = await get(id)
      if (!j) throw new HttpError(404, 'not-found', 'Job not found.')
      throw new HttpError(409, 'conflict', j.state === 'running' ? 'The job is running on another worker; it cannot be cancelled now.' : `A ${j.state} job cannot be cancelled.`)
    }
    return toJobInfo(rows[0])
  }

  async function metrics(): Promise<JobMetrics> {
    const d = db()
    const states: Record<JobState, number> = { queued: 0, running: 0, succeeded: 0, failed: 0, dead: 0, cancelled: 0 }
    for (const r of await d.query<Row>(`SELECT state, count(*)::int AS n FROM ${T('ab_jobs')} GROUP BY state`)) states[String(r.state) as JobState] = Number(r.n)
    const depthByType: Record<string, number> = {}
    for (const r of await d.query<Row>(`SELECT type, count(*)::int AS n FROM ${T('ab_jobs')} WHERE state IN ('queued', 'failed') GROUP BY type ORDER BY type`)) depthByType[String(r.type)] = Number(r.n)
    const one = async (sql: string): Promise<number> => Number((await d.query<Row>(sql))[0]?.n ?? 0)
    const oldest = await one(`SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(run_at)), 0)::float8 AS n FROM ${T('ab_jobs')} WHERE state IN ('queued', 'failed') AND run_at <= now()`)
    const failures24h = await one(`SELECT count(*)::int AS n FROM ${T('ab_jobs')} WHERE error IS NOT NULL AND state IN ('failed', 'dead') AND modified_on > now() - interval '24 hours'`)
    const succeededLastHour = await one(`SELECT count(*)::int AS n FROM ${T('ab_jobs')} WHERE state = 'succeeded' AND finished_on > now() - interval '1 hour'`)
    const runningRows = await d.query<Row>(`SELECT id, type, started_on, locked_by FROM ${T('ab_jobs')} WHERE state = 'running' ORDER BY started_on LIMIT 50`)
    const pending = await one(`SELECT count(*)::int AS n FROM ${T('ab_outbox')} WHERE dispatched_on IS NULL`)
    const oldestOutbox = await one(`SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(created_on)), 0)::float8 AS n FROM ${T('ab_outbox')} WHERE dispatched_on IS NULL`)
    return {
      states, depthByType, oldestQueuedSeconds: Math.max(0, Math.round(oldest)), failures24h, dead: states.dead, succeededLastHour,
      running: runningRows.map((r) => ({ id: String(r.id), type: String(r.type), startedOn: iso(r.started_on), lockedBy: str(r.locked_by) })),
      worker: { id: workerId, running: running.size, concurrency, listening, pollMs },
      outbox: { pending, oldestSeconds: Math.max(0, Math.round(oldestOutbox)) },
      types: typeInfo(),
    }
  }

  /** finished jobs older than `days` (succeeded, cancelled, dead) */
  async function purge(days: number): Promise<number> {
    const r = await db().exec(`DELETE FROM ${T('ab_jobs')} WHERE state IN ('succeeded', 'cancelled', 'dead') AND finished_on < now() - make_interval(days => $1)`, [Math.max(1, Math.trunc(days))])
    return r.affectedRows
  }

  /* ---------------------------------------------------------------- schedules */

  function nextSlot(s: { cron?: string | null; intervalSeconds?: number | null; timeZone: string }, after: Date): Date | null {
    if (s.cron) return nextCron(parseCron(s.cron), after, s.timeZone)
    if (s.intervalSeconds && s.intervalSeconds > 0) return new Date(after.getTime() + s.intervalSeconds * 1000)
    return null
  }

  function checkSchedule(s: ScheduleInput & { jobType: string }): void {
    const bad = (m: string, f?: string): never => { throw new HttpError(422, 'invalid', m, f) }
    if (!types.has(s.jobType)) bad(`There is no job type "${s.jobType}".`, 'jobType')
    const hasCron = !!s.cron && String(s.cron).trim() !== ''
    const hasInterval = s.intervalSeconds !== null && s.intervalSeconds !== undefined
    if (hasCron === hasInterval) bad('A schedule needs either a cron expression or an interval.', 'cron')
    if (hasCron) {
      try { parseCron(String(s.cron)) } catch (e) { bad(e instanceof CronError ? e.message : 'The cron expression is not valid.', 'cron') }
    }
    if (hasInterval && (!Number.isInteger(s.intervalSeconds) || Number(s.intervalSeconds) < 60 || Number(s.intervalSeconds) > 366 * 86400)) bad('The interval must be a whole number of seconds between 60 and one year.', 'intervalSeconds')
    try { checkTimeZone(s.timeZone ?? 'UTC') } catch (e) { bad((e as Error).message, 'timeZone') }
    if (s.misfire && s.misfire !== 'skip' && s.misfire !== 'run_once') bad('misfire must be "skip" or "run_once".', 'misfire')
    const def = types.get(s.jobType)!
    if (def.parse) {
      try { def.parse(s.payload ?? {}) } catch (e) { bad(`The payload does not fit the job type: ${errorMessage(e)}`, 'payload') }
    }
  }

  const SCHEDULE_COLS = `s.*, (SELECT j.state FROM ${'{jobs}'} j WHERE j.id = s.last_job_id) AS last_job_state`
  const schedSelect = () => SCHEDULE_COLS.replace('{jobs}', T('ab_jobs'))

  const schedules = {
    async list(): Promise<ScheduleInfo[]> {
      return (await db().query<Row>(`SELECT ${schedSelect()} FROM ${T('ab_schedules')} s ORDER BY s.built_in DESC, lower(s.name), s.id`)).map(toSchedule)
    },
    async get(id: string): Promise<ScheduleInfo | null> {
      const rows = await db().query<Row>(`SELECT ${schedSelect()} FROM ${T('ab_schedules')} s WHERE s.id = $1`, [id])
      return rows.length ? toSchedule(rows[0]) : null
    },
    async create(input: ScheduleInput, by: string | null): Promise<ScheduleInfo> {
      const s = {
        name: String(input.name ?? '').trim().slice(0, 200), description: input.description ?? null, cron: input.cron?.trim() || null,
        intervalSeconds: input.intervalSeconds ?? null, timeZone: input.timeZone || 'UTC', jobType: String(input.jobType ?? ''),
        payload: input.payload ?? {}, enabled: input.enabled !== false, misfire: input.misfire ?? 'run_once',
      }
      if (!s.name) throw new HttpError(422, 'invalid', 'A schedule needs a name.', 'name')
      checkSchedule(s)
      const id = `sch_${rowUid().replace(/-/g, '').slice(-16)}`
      const now = new Date()
      await db().exec(
        `INSERT INTO ${T('ab_schedules')} (id, name, description, cron, interval_seconds, time_zone, job_type, payload, enabled, misfire, built_in, next_run_at, created_by, created_on, modified_on)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, false, $11, $12, $13, $13)`,
        [id, s.name, s.description, s.cron, s.intervalSeconds, s.timeZone, s.jobType, JSON.stringify(s.payload), s.enabled, s.misfire, s.enabled ? nextSlot(s, now) : null, by, now],
      )
      return (await schedules.get(id))!
    },
    async update(id: string, patch: ScheduleInput): Promise<ScheduleInfo> {
      const cur = await schedules.get(id)
      if (!cur) throw new HttpError(404, 'not-found', 'Schedule not found.')
      if (cur.builtIn && (patch.jobType !== undefined && patch.jobType !== cur.jobType)) throw new HttpError(422, 'invalid', 'The job of a built-in schedule cannot be changed.', 'jobType')
      const next = {
        name: patch.name !== undefined ? String(patch.name).trim().slice(0, 200) : cur.name,
        description: patch.description !== undefined ? patch.description : (cur.description ?? null),
        cron: patch.cron !== undefined ? (patch.cron?.trim() || null) : (cur.cron ?? null),
        intervalSeconds: patch.intervalSeconds !== undefined ? patch.intervalSeconds : (cur.intervalSeconds ?? null),
        timeZone: patch.timeZone ?? cur.timeZone, jobType: patch.jobType ?? cur.jobType,
        payload: patch.payload !== undefined ? patch.payload : cur.payload, enabled: patch.enabled ?? cur.enabled, misfire: patch.misfire ?? cur.misfire,
      }
      if (patch.cron && patch.intervalSeconds === undefined) next.intervalSeconds = null
      if (patch.intervalSeconds && patch.cron === undefined) next.cron = null
      if (!next.name) throw new HttpError(422, 'invalid', 'A schedule needs a name.', 'name')
      checkSchedule(next)
      const timingChanged = next.cron !== (cur.cron ?? null) || next.intervalSeconds !== (cur.intervalSeconds ?? null) || next.timeZone !== cur.timeZone || (next.enabled && !cur.enabled)
      const nextRun = !next.enabled ? null : timingChanged || !cur.nextRunAt ? nextSlot(next, new Date()) : new Date(cur.nextRunAt)
      await db().exec(
        `UPDATE ${T('ab_schedules')} SET name = $2, description = $3, cron = $4, interval_seconds = $5, time_zone = $6, job_type = $7, payload = $8::jsonb,
           enabled = $9, misfire = $10, next_run_at = $11, modified_on = now() WHERE id = $1`,
        [id, next.name, next.description, next.cron, next.intervalSeconds, next.timeZone, next.jobType, JSON.stringify(next.payload), next.enabled, next.misfire, nextRun],
      )
      return (await schedules.get(id))!
    },
    async remove(id: string): Promise<void> {
      const cur = await schedules.get(id)
      if (!cur) throw new HttpError(404, 'not-found', 'Schedule not found.')
      if (cur.builtIn) throw new HttpError(422, 'invalid', 'A built-in schedule cannot be deleted; disable it instead.')
      await db().exec(`DELETE FROM ${T('ab_schedules')} WHERE id = $1`, [id])
    },
    /** enqueue the schedule's job now (outside its timetable) */
    async runNow(id: string, by: string | null): Promise<{ id: string }> {
      const cur = await schedules.get(id)
      if (!cur) throw new HttpError(404, 'not-found', 'Schedule not found.')
      const job = await enqueue(cur.jobType, cur.payload, { createdBy: by, idempotencyKey: `sched:${id}:manual:${rowUid()}` })
      await db().exec(`UPDATE ${T('ab_schedules')} SET last_job_id = $2 WHERE id = $1`, [id, job.id])
      return { id: job.id }
    },
    /** creates the built-in schedules of the current environment that are missing (an administrator's changes stay) */
    async ensureBuiltins(list: BuiltinSchedule[]): Promise<void> {
      const now = new Date()
      for (const b of list) {
        if (!types.has(b.jobType)) continue
        const next = b.enabled ? nextSlot({ cron: b.cron, intervalSeconds: b.intervalSeconds, timeZone: 'UTC' }, now) : null
        await db().exec(
          `INSERT INTO ${T('ab_schedules')} (id, name, description, cron, interval_seconds, time_zone, job_type, payload, enabled, misfire, built_in, next_run_at, created_on, modified_on)
           VALUES ($1, $2, $3, $4, $5, 'UTC', $6, $7::jsonb, $8, $9, true, $10, $11, $11) ON CONFLICT (id) DO NOTHING`,
          [b.id, b.name, b.description, b.cron ?? null, b.intervalSeconds ?? null, b.jobType, JSON.stringify(b.payload ?? {}), b.enabled, b.misfire ?? 'run_once', next, now],
        )
      }
    },
  }

  /**
   * Due schedules of the current environment: each due slot becomes one job (key sched:<id>:<slot ISO>) and next_run_at
   * moves on, in one transaction. A slot later than misfireGraceMs follows the misfire policy: skip (no job) or
   * run_once (one job for the missed slots); either way the next slot is the first one after now.
   */
  async function schedulerTick(now = new Date()): Promise<number> {
    let n = 0
    await db().tx(async (t) => {
      const due = await t.query<Row>(`SELECT * FROM ${T('ab_schedules')} WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= $1 ORDER BY next_run_at LIMIT 50 FOR UPDATE SKIP LOCKED`, [now])
      for (const r of due) {
        const s = toSchedule(r)
        const slot = new Date(s.nextRunAt!)
        const late = now.getTime() - slot.getTime() > misfireGraceMs
        let next: Date | null
        try {
          next = late ? nextSlot(s, now) : nextSlot(s, slot)
          if (!late && s.intervalSeconds && next && next.getTime() <= now.getTime()) next = nextSlot(s, now)
        } catch (e) {
          deps.log('warn', `schedule ${s.id}: ${errText(e)}; disabled`)
          await t.exec(`UPDATE ${T('ab_schedules')} SET enabled = false, modified_on = now() WHERE id = $1`, [s.id])
          continue
        }
        let jobId: string | null = null
        if (!late || s.misfire === 'run_once') {
          if (!types.has(s.jobType)) {
            deps.log('warn', `schedule ${s.id}: no handler for job type ${s.jobType}; slot skipped`)
          } else {
            const job = await enqueue(s.jobType, s.payload, { idempotencyKey: `sched:${s.id}:${slot.toISOString()}`, correlationId: `sched:${s.id}` })
            jobId = job.id
            if (job.created) n++
          }
        } else deps.log('info', `schedule ${s.name}: missed slot ${slot.toISOString()} skipped (misfire policy skip)`)
        await t.exec(
          `UPDATE ${T('ab_schedules')} SET next_run_at = $2, last_run_at = CASE WHEN $3::text IS NULL THEN last_run_at ELSE $4 END, last_job_id = COALESCE($3, last_job_id) WHERE id = $1`,
          [s.id, next, jobId, slot],
        )
      }
    })
    return n
  }

  return {
    workerId,
    register,
    types: typeInfo,
    hasType: (t: string) => types.has(t),
    typeDef: (t: string) => types.get(t),
    enqueue,
    get,
    list,
    retry,
    cancel,
    metrics,
    purge,
    schedules,
    schedulerTick,
    reap,
    start: startWorker,
    stop,
    wake,
    tick,
    drain,
    isRunning: () => started && !stopping,
    runningCount: () => running.size,
  }
}
