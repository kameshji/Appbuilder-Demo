# Events and jobs (the kernel under flows)

P0 package G. The server-side kernel that Phase 1 (flows) sits on: an **outbox** of data changes, **table events** (the one
replacement for business rules and plug-ins, with validation rules, formula columns and rollups as built-in uses), a durable
**job queue** with an in-process **worker**, and **schedules**. Decision D18 in `docs/decisions.md`. Maker view:
`docs/guide/maker/data.md`; administrator view: `docs/admin/jobs.md`.

| Module | What it does |
| --- | --- |
| `server/core/kernel.ts` | Wiring: creates the queue, outbox and table events, registers the built-in job types and schedules, gives the DataService its write hooks, `notificationSink` (NotifyUser -> in-app notifications) |
| `server/core/jobs.ts` | Job queue, worker loop, LISTEN/NOTIFY, reaper, backoff, schedules and the scheduler tick, metrics |
| `server/core/cron.ts` | Cron parser and next-slot calculation with time zones (no package) |
| `server/core/outbox.ts` | Outbox write (same transaction), dispatcher, `subscribe`, `read`, retention |
| `server/core/table-events.ts` | Event definitions, the rules cache, before-phase, dispatch to after-event jobs, after-event runner, formula columns, rollups, run log, test run |
| `server/core/event-fx.ts` | Formulas on the server: allowed actions per role, save-time checks, evaluation with pushed-down reads, limits |
| `server/core/kernel-routes.ts` | HTTP API (`data-api.md`, "Table events, jobs and schedules") |
| `server/core/kernel-ddl.ts` | The five tables of every environment schema |
| `server/core/work-context.ts` | Request id, correlation id and the event chain carried through async calls |
| `src/fx/rowrules.ts` | Shared with the browser: record scope (`New`, `Old`, `ThisRecord`, `User()`), `SetField`, `Reject`, formula-column order |
| `src/platform/events.ts` | Types shared with the client (`TableEventDef`, `JobInfo`, `ScheduleInfo`, `JobMetrics`, `ComputedColumn` ...) |
| `src/portal/TableLogic.tsx`, `AdminJobs.tsx` | Table designer tabs; admin console Jobs and Events run log |

## Tables (per environment schema)

| Table | Key columns | Notes |
| --- | --- | --- |
| `ab_outbox` | `id` bigint identity, `table_id`, `op` (insert, update, delete, import, bulk), `row_id`, `row_ids` (at most 1,000), `row_count`, `changed`, `before`, `after`, `actor_id`, `correlation_id`, `request_id`, `depth`, `chain`, `truncated`, `details`, `created_on`, `dispatched_on` | One row per data change, written in the change's transaction. Partial index on undispatched rows. |
| `ab_jobs` | `id` (UUIDv7), `type`, `payload` jsonb, `state` (queued, running, succeeded, failed, dead, cancelled), `priority`, `run_at`, `attempts`, `max_attempts`, `backoff` jsonb, `locked_by`, `locked_at`, `heartbeat_at`, `idempotency_key` (unique when set), `correlation_id`, `run_as` (`system` or `user:<id>`), `created_by`, `result`, `error` jsonb, timestamps | `failed` = waiting for a retry at `run_at`; `dead` = attempts used up (dead letter). |
| `ab_schedules` | `id`, `name`, `cron` or `interval_seconds`, `time_zone`, `job_type`, `payload`, `enabled`, `misfire` (skip, run_once), `built_in`, `last_run_at`, `next_run_at`, `last_job_id` | Built-in schedules are created per environment on first worker tick; an administrator's changes stay. |
| `ab_table_events` | `id`, `table_id`, `timing`, `order_no`, `enabled`, `def` jsonb (`TableEventDef`) | Copied with an environment copy. |
| `ab_event_runs` | `id`, `at`, `event_id`, `event_name`, `table_id`, `row_id`, `timing`, `op`, `status` (ok, rejected, failed, skipped), `duration_ms`, `message`, `details`, `job_id`, `correlation_id` | The run log. Written after the unit of work ends, so a rejection that rolled the write back is still recorded. |

Formula and rollup columns are ordinary columns of the data table with `ColumnDef.computed` in `ab_tables.def`.

## Write path

Every DataService write (insert, update, delete, bulk delete, CSV import, the attachment cell writes, the rows of a solution
or package import) runs as **one unit of work** (`hooks.unit`): on the default database inside one transaction. In order:

1. Update only: `SELECT ... FOR UPDATE` on the row when the table has before-events or formula columns (read-modify-write:
   concurrent saves of one row run one after another, so a formula never sees a stale input).
2. Coercion and permission checks as before. Values sent for computed columns are ignored like system columns.
3. **Before phase** (`beforeWrite`): before-events in `order`, then formula columns whose inputs changed (all on create),
   rollup columns start at 0 (count, sum) or blank (min, max) on create, then validation rules in `order`. The columns they
   set join the change; the row-level-security WITH CHECK, required, unique and lookup checks run after them.
4. The write, the audit entry, the **outbox row** (last statement: it takes the per-table advisory lock, see Ordering).
5. Attachment records removed by the change are deleted in the unit; their **files** are deleted by an
   `attachments.delete-files` job that only becomes visible when the unit commits (a rolled-back table delete keeps its
   files; the job also skips any key still referenced).
6. Commit. Then the run log entries of the unit are written.

Tables on other connections (external PostgreSQL/MySQL, files, Google Sheets) get the same events and outbox rows, but not
in the same transaction as their data: the outbox row is written after the connector's write; a crash in between loses that
one event. Rollups need both tables on the default database.

## Guarantees

| Area | Guarantee | How | Test |
| --- | --- | --- | --- |
| Outbox atomicity | A committed change always has its outbox row; a rolled-back one never | Same transaction (default database) | `events.integration.test.ts` |
| Outbox ordering | Per table, outbox ids are in commit order | `pg_advisory_xact_lock(hashtext('ab.outbox:<schema>:<table>'))` taken just before the insert, held to commit; ids of one table are allocated while holding it. Other tables are not blocked | `jobs.integration.test.ts` |
| Dispatch | Every committed outbox row is dispatched once; jobs it creates exist exactly when it is marked dispatched | `FOR UPDATE SKIP LOCKED` claim, enqueue and mark in one transaction; idempotency keys | both suites |
| Before-events | Run inside the write, in order; can set fields or refuse with a message bound to a field; time budget 2 s per row (`APPBUILDER_EVENT_BUDGET_MS`), at most 5,000 rows read and 50 queries per evaluation | `table-events.ts` | `jobs.integration.test.ts` |
| After-events | At least once, after commit; one job per event and row, idempotency key `evt:<event>:<outbox id>:<row>`; their writes run in one transaction and are idempotent (Collect inserts a stable row id per job attempt); a failure never rolls back the original change; retried with backoff, then dead | `table-events.ts`, jobs | both |
| Recursion | An after-event is not run again on a row it changed earlier on the same chain (loop guard); nothing runs deeper than 8 levels (`APPBUILDER_EVENT_MAX_DEPTH`); both are logged as skipped | `chain` and `depth` travel in job payloads, the work context and outbox rows | `jobs.integration.test.ts` |
| Errors | Never swallowed: rejections and failures of every phase go to the run log; a before-event failure refuses the write (422); a formula column that cannot be computed stores blank and logs the failure | | |
| Jobs | One attempt runs once (SKIP LOCKED); a running job without heartbeat for 30 s (`APPBUILDER_JOBS_VISIBILITY_MS`) is taken back (crash recovery); exponential backoff with jitter; dead letter after `maxAttempts`; permanent errors (JobError retry false, 4xx) die at once | `jobs.ts` | `jobs.integration.test.ts` |
| Schedules | Each slot enqueued exactly once, also across restarts and with two workers | key `sched:<id>:<slot ISO>` inserted in the same transaction that advances `next_run_at` | `jobs.integration.test.ts` |
| Isolation | Queues, schedules, outboxes and run logs are per environment; jobs run inside their environment and identity | `runInEnvironment`, `run_as` | `jobs.integration.test.ts` |

## Formula columns and rollups under concurrency

- **Formula columns** are computed in the before phase from the row as it will be stored. An update locks the row first, so
  two concurrent updates of Qty and Price serialise and the second computes from the first's committed values. When the
  formula changes, a `formula.backfill` job recomputes every row in batches of 200, each batch locking its rows.
- **Rollups** are recomputed from scratch, never incremented: a child change dispatches a `rollup.recompute` job for the
  parent ids in the snapshot (old and new lookup value). The job locks the parent rows (`FOR UPDATE`, id order), runs
  `UPDATE parent SET col = (SELECT agg FROM child WHERE via = parent.id) ... WHERE col IS DISTINCT FROM ...`, writes
  outbox rows for the changed parents and recomputes their formula columns that read the rollup. Because a job runs only
  after its change committed and the parent lock serialises the recomputes, the last recompute always sees every committed
  child row. Imports and bulk deletes reconcile the whole column. The `rollup.reconcile` schedule (hourly) repairs drift
  from writes made outside the platform.
- The concurrency test runs 16 parallel writers (400 inserts plus updates of quantity, price and parent, and deletes) with
  the worker running, then checks every `Amount = Qty * Price` and every parent's sum and count against SQL.

## The event action language

Formulas are Fx (one language). The record being written is `New` (also `ThisRecord`, and its columns by bare name; a table
of the same name wins: write `ThisRecord.Name` then), the stored row before the change is `Old` (blank on create), and
`User()` is the person who made the change (blank for system writes). Inside `Filter` and `LookUp` bare names and
`ThisRecord` are the searched table's rows: use `New.Column` there.

Reads of other tables are pushed down (`analyze` of `src/fx/query`): `LookUp`, `Filter`, `First`, `FirstN`, `CountRows`,
`Sum`, `Average`, `Min`, `Max` and everything else Query v2 translates. A read that cannot be translated, or a table named on
its own (outside a write target), is refused at save time. Reads use the event's identity: the caller's roles (default) or
the system (`runAs: system`, administrators only).

| Role | Allowed actions (all pure functions are allowed everywhere) |
| --- | --- |
| Condition, validation rule, formula column | none |
| Before-event | `Set`, `SetField({Col: value})` or `SetField("Col", value)`, `Reject(message [, Column])`, `Trace`, `Concurrent` |
| After-event | `Set`, `Patch`, `Collect`, `Remove` (on tables of the environment, through the DataService), `NotifyUser(userEmailOrId, message)`, `RunConnector(connection, action [, inputs])` (placeholder: recorded), `EnqueueJob(type [, payload [, delaySeconds]])` (job types marked `eventAllowed`), `Trace`, `Concurrent` |

Refused with a clear message at save time: `Navigate`, `Back`, `Notify` (use `NotifyUser`), `Reset`, the form functions,
`Select`, `SetFocus`, `Launch`, `Copy`, `Download`, `Exit`, `Refresh`, `UpdateContext`, `Clear`, `ClearCollect`, `RemoveIf`,
`UpdateIf`, and writes in a before-event. `NotifyUser` goes to the in-app notifications (package H) when present.

## Jobs

`kernel.jobs.register({ type, description, parse, handler, concurrency, maxAttempts, backoff, timeoutMs, eventAllowed })`;
`kernel.jobs.enqueue(type, payload, { runAt, delayMs, priority, idempotencyKey, correlationId, runAs, createdBy })` joins the
caller's transaction. The handler gets `{ job, environmentId, user, signal, heartbeat(), log }`. Defaults: 5 attempts,
backoff 2 s doubling to 10 min with jitter in [50 %, 100 %], timeout 5 min, 4 at once per type, 8 per process
(`APPBUILDER_JOBS_CONCURRENCY`), polling every 1 s (`APPBUILDER_JOBS_POLL_MS`) with LISTEN `ab_jobs` / `ab_outbox` waking the
worker at once. Graceful stop (`services.close()`): no new claims, 10 s for running jobs (`APPBUILDER_JOBS_STOP_GRACE_MS`),
the rest released as queued with the attempt not counted. `APPBUILDER_JOBS=off` does not start the worker.

The data model designer registers `model.summary.refresh` (payload `{ tableId }`; one schedule per summary table, see `data-model.md`).

Built-in types: `table-event.after`, `rollup.recompute`, `rollup.reconcile`, `formula.backfill`, `index.sync` (key indexes of
a column marked `indexed`, `CREATE INDEX CONCURRENTLY`, an invalid leftover is dropped first; the column PATCH route no longer
builds them inline on the default database), `attachments.delete-files`, `attachments.sweep`, `outbox.retention` (outbox 14 days,
run log 30, finished jobs 14; `APPBUILDER_OUTBOX_RETENTION_DAYS`), `audit.retention` (730 days, off by default),
`identity.signin-log.retention` (180 days) and `identity.mail-log.retention` (90 days): install-wide, their built-in
schedules exist in the Default environment only and the handlers do nothing elsewhere.

**Schedule policy** (`JobTypeDef.schedule`, P0 package M): `'custom'` lets an environment administrator create, change and
delete their own schedules of the type (`POST/PATCH/DELETE /admin/schedules`; today `model.summary.refresh`,
`rollup.reconcile`, `outbox.retention`, `attachments.sweep`, `collab.orphan-sweep`); `'install'` marks install-wide work
(`backup.run`, `backup.restore-test`, `backup.health`, `mail.send`, the two log retentions) whose schedules only install
administrators may change, run or delete (403 otherwise); no value: built-in schedules only. `GET /admin/jobs/metrics` returns
each type's `schedule` for the editor. Before this, any environment administrator could schedule any job type with any
payload (for example an install backup, or the sign-in log retention with 7 days); see `docs/internal/security-review-p0.md`.

Throughput (sandbox, PostgreSQL 16, one process, concurrency 8, no-op handler): 10,000 jobs processed in 10.4-13.0 s,
**770-960 jobs/s**; enqueueing them took 0.1 s (`jobs.integration.test.ts`, "load").

## For the realtime hub and flows

```ts
const off = services.kernel.outbox.subscribe((e: OutboxEvent) => {
  // e.environmentId, e.tableId, e.op, e.rowId / e.rowIds, e.changed, e.actorId, e.correlationId, e.id
})
// catch-up after a gap (inside runInEnvironment(env, ...)): committed and dispatched rows after an id
await services.kernel.outbox.read(lastId, 500, tableId?)
```

Delivered right after the dispatcher's transaction commits (milliseconds after the write, through NOTIFY), in id order per
environment. Listeners must be fast (queue work). Flows will register their job types and consume the same outbox.

## Solutions and environment copies

Events and validation rules travel inside each table entry of a package (`events: [...]`, ids kept; computed columns are
part of the table schema). Install and upgrade plans list them as items of kind `event` (new, changed, removed,
unchanged); a package without an `events` key (older exports) leaves the target's events alone. Events that run as the
system and are new or changed are listed in `plan.systemEvents`: only an environment administrator can import them, the
import then always needs `confirm` = the plan's token (also for an install; the dialog asks for an explicit tick), and each
one is audited `event.run_as_system`. Formulas are checked against the target at apply time (a problem rolls the whole
import back). Changed formula columns are backfilled and rollups reconciled by jobs that commit with the upgrade. An
import "as a copy" (and app packages) creates the events of the new tables with new ids; run-as-system ones arrive
disabled with a warning. Environment copies copy `ab_table_events`. Tests: `events-alm.integration.test.ts`.

## Threat model

| Threat | Mitigation |
| --- | --- |
| An event used to bypass row or column security | Reads go through `DataService.queryV2` and writes through the DataService with the event's identity: the caller's roles by default. `runAs: system` can only be set, changed or deleted by an environment administrator and is audited (`event.run_as_system`); the designer shows it in red. |
| A maker escalates through after-event jobs | Jobs carry `run_as` = the user who made the change (or system only for system events); the identity is resolved again when the job runs (a disabled user's jobs fail). |
| A formula that never ends or reads too much | Time budget per row (2 s) and per after-event (30 s), 5,000 rows and 50 queries per evaluation, Query v2's statement timeout, the engine's own limits (`Sequence` and recursion). A single synchronous evaluation cannot be pre-empted mid-way; the budget is checked between steps and the engine's caps bound one step. |
| Events that trigger each other forever | Loop guard per event and row, depth cap 8, both logged. Rollup cascades also stop past the cap; the reconcile job repairs what is left. |
| A table read as a whole (partial results) | Refused at save time and at run time; only pushed-down plans run. |
| UI functions on the server | Refused at save time with an explanation; the server host refuses them at run time too. |
| Job payload tampering | Only server code enqueues; payloads are parsed by the type's `parse` (malformed = dead, not retried); `EnqueueJob` only for types marked `eventAllowed`. |
| Files deleted for a change that did not happen | File deletion is a job inside the unit of work; it also re-checks that no attachment record uses the key. |
| Lost or duplicated scheduled work | Unique slot keys; misfire policy; the reaper takes back jobs of crashed workers. A summary refresh locks its table (`LOCK TABLE ... SHARE ROW EXCLUSIVE`) so two refreshes at once cannot both insert their groups. |
| An environment administrator schedules install-wide work | Custom schedules only for job types marked `schedule: 'custom'`; schedules of `schedule: 'install'` types need an install administrator. |
| Denial of service through the queue | Per-type and global concurrency, priorities (maintenance jobs low), payload cap 256 KB, result cap 32 KB, retention. |
| Secrets in logs | Run log and job errors hold messages, never SQL parameters or connection secrets; snapshots are capped and hold attachment ids only. |

## Not done yet (Phase 1 and later)

Flow designer and definitions; real connector actions (`RunConnector` records the call); email or WhatsApp delivery of
`NotifyUser`; validation rules, events and
rollups in demo mode (formula columns work there); a schedule editor for custom schedules in the UI (API only); events on
attachment uploads beyond the cell change; sharing changes in the outbox.
