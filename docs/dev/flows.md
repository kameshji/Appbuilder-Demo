# Flows: the runtime (P1 package A)

Flows automate work: when a row changes, on a schedule, at a button press in an app or on a web request, a flow runs a
list of steps (conditions, loops, data changes, approvals, messages, HTTP calls, connector actions, child flows). This page
is the design of the runtime: tables, the execution model, guarantees per step kind, security, limits and the interfaces
of the packages around it. Contract: `docs/plan/p1-spec.md` ("Fixed contracts"); decision D27 in `docs/decisions.md`. Phase close (package E): notification
idempotency, run again from a step, child-flow permissions, the server formula guards, Admin console > Flows.
Maker view: [guide/maker/flows.md](../guide/maker/flows.md); administrators: [admin/flows.md](../admin/flows.md);
reference of every trigger and step kind: [reference/flows.md](../reference/flows.md) (generated); HTTP API:
[data-api.md](data-api.md#flows).

| Module | What it does |
| --- | --- |
| `src/platform/flows.ts` | Shared types (definition, runs, steps, problems), limits, the catalogue of trigger types and step kinds (reference docs, designer palette, `GET /flows/catalog`) |
| `server/core/flows/ddl.ts` | The nine tables of an environment schema; the version 8 step that turns the `Flow runs` placeholder into a view |
| `server/core/flows/store.ts` | Definitions, versions, connection references, run grants, environment settings (kill switch), health |
| `server/core/flows/validate.ts` | Save-time validation with step id and field per problem |
| `server/core/flows/expr.ts` | Expressions: scope, evaluation with pushed-down reads, save-time checks |
| `server/core/flows/engine.ts` | The state machine: runs, containers, steps, waits, retries, cancellation, resubmit, sweeper, failure alerts |
| `server/core/flows/index.ts` | The service (`services.flows`): job types, the four triggers, manual runs, webhooks, retention |
| `server/core/flows/routes.ts` | HTTP API |
| `server/core/flows/alm.ts` | Flows in solution packages: export, plan, apply |
| `server/core/flows/contracts.ts` | Interfaces for approvals (package C) and the webhook route (package D) |
| `src/flows/**` | The Flows page (list, run history, run detail, permissions) and the visual designer (`src/flows/designer/**`, package B, see "Designer" below) |
| `src/flows/templates/*.json` | The "New flow" gallery's templates (validated by `server/core/flows/templates.test.ts`) |

## Tables (per environment schema, version 8)

| Table | Key columns | Notes |
| --- | --- | --- |
| `ab_flows` | `id`, `name` (unique, case-insensitive), `definition` jsonb (`trigger`, `steps`, `variables`, `settings`), `enabled`, `version`, `owner_id`, `run_as` jsonb, `solution_id`, `suspended` (why it cannot run), `created_*`, `modified_*` | The current version |
| `ab_flow_versions` | (`flow_id`, `version`), `doc` (name, description, runAs and the definition), `saved_by`, `saved_on`, `note` | Every save; restore = a new version with an old document |
| `ab_flow_runs` | `id`, `flow_id`, `flow_name`, `flow_version`, `owner_id`, `state`, `mode` (`normal`, `test`), `dry_run`, `trigger_kind`, `trigger_key` (unique), `trigger` (payload, stored form), `run_as`, `run_as_kind`, `triggered_by`, `correlation_id`, `chain`, `depth`, `call_depth`, `parent_run_id`, `parent_wait_id`, `resubmitted_from`, `concurrency_key`, `seq`, `variables`, `response`, `error`, `step_count`, `regarding_*`, `deadline_at`, `doc` (test runs of a draft), `options`, timestamps | Partial indexes for active runs, deadlines, concurrency keys |
| `ab_flow_steps` | (`run_id`, `step_key`), `step_id`, `scope`, `name`, `kind` (or `iteration`), `state`, `attempt`, `input` (display form), `output` (stored form, at most 1 MB), `error`, `data` (container state: branch, items, next index), `job_id`, `simulated`, `truncated`, `started_on`, `finished_on`, `ord` | One row per step execution; the primary key makes a second execution of the same step impossible |
| `ab_flow_waits` | `id`, (`run_id`, `step_key`) unique, `kind` (`delay`, `approval`, `callFlow`, `callback`), `state` (`waiting`, `resumed`, `timedOut`, `cancelled`, `early`), `wake_at`, `timeout_at`, `approval_id`, `child_run_id`, `outcome` | A suspended step; the sweeper resumes due ones |
| `ab_flow_connections` | (`flow_id`, `ref`), `connection_id`, `granted_by`, `granted_on` | Connection references a flow may use |
| `ab_flow_run_grants` | (`flow_id`, `role_id`), `granted_by`, `granted_on` | Who may run a flow by hand; `flow_id = '*'`: every flow |
| `ab_flow_settings` | `k`, `v` | `paused` (kill switch), `environmentRunsPerMinute`, `callbackKey` |
| `ab_flow_alerts` | `flow_id`, `last_notified_on`, `pending`, `last_error` | Failure notifications: the first at once, then a daily digest |

`Flow runs` (`sys_flow_runs`, the core data model's logging group) is now a **view** over `ab_flow_runs` (normal runs):
owner = the flow's owner (policy `adminOrOwn`), `createdBy` = who triggered it, `regardingTable`/`regardingId` = the record
of a table trigger (so a record's timeline query can show its runs). The version 8 step drops the empty placeholder table
of version 7 (one with rows is kept as `sys_flow_runs_placeholder_v7`).

## Execution

A run is a tree of **containers**, each named by a path: `''` (the top), `/check.then`, `/check.else`, `/route.case2`,
`/try` (a scope), `/each#3` (iteration 3 of a loop), nested as `/each#3/inner.else`. A step execution is the container path
plus `/<step id>`: `/each#3/inner.else/notify`.

One **`flow.advance`** job advances one container of one run by one step:

1. load the run (stop if it ended; re-enqueue in a minute when the kill switch is on);
2. read the step rows of the container; for each step in order: a terminal row is skipped over; a waiting row ends the
   job; a running container row is "kicked" (its children's advance is enqueued again, idempotently); a running leaf row is
   executed again (a crash or a retry); a step without a row has its `runAfter` checked: not met means a `skipped` row,
   met means it is executed and the job ends;
3. when every step is terminal the container is complete: its outcome is written to the container step's row (or the
   iteration row; or the run ends, for the top) and the parent container advances.

Siblings run in order (a step's `runAfter` may only name earlier siblings, so there are no cycles); parallelism comes from
`forEach` with `concurrency > 1` (iterations are separate containers, each with its own advance jobs). Every advance job is
enqueued with an idempotency key `adv:<run>:<container>:<transition>`, in the same transaction as the step result that
causes it, so a transition enqueues exactly one next job.

**runAfter.** Default: the previous sibling `succeeded` (with `settings.onError = "continue"`: any outcome except
cancelled); the first step of a container runs when the container starts. Explicit: every entry must hold (`when` lists
the accepted outcomes of that step: `succeeded`, `failed`, `skipped`, `timedOut`).

The collaboration cleanup that removes or detaches rows "regarding" a deleted record never touches projections, so the
`Flow runs` view keeps the id of the record a run was about (`server/core/collab.ts`; test in `flows.integration.test.ts`).

**Outcome of a container** (a scope's try/catch): `failed` when one of its steps failed or timed out and no later sibling
ran *because of* that outcome (a `runAfter` naming that step with that status, and not skipped); otherwise `succeeded`. So
`Try` (a scope) followed by `Catch` with `runAfter: [{ step: "Try", when: ["failed", "timedOut"] }]` handles the failure:
the run succeeds. The run's status is the outcome of the top container, unless a Terminate step ended it.

**Loops.** `forEach` evaluates its items once, stores them (at most 1 MB, at most `max` items, cap 5,000) on its row and
starts iterations up to its concurrency; each iteration row (kind `iteration`) holds its item; when an iteration ends the
loop starts the next one. The loop fails when an iteration failed (after all iterations ended). `until` runs one iteration
at a time and checks its condition after each (with the iteration's steps in scope); reaching `maxIterations` fails it.

**Waits.** delay (`wake_at`), approval (`approval_id`, optional `timeout_at`), callFlow (`child_run_id`; the child's end
resumes the parent), waitForCallback (a callback address with an HMAC token). The step row is `waiting` and a wait row is
written in the step's transaction; the run's state becomes `waiting` (it uses no memory and no job). The **sweeper** (on
every worker round, at most every 500 ms per environment) turns due waits (`wake_at` or `timeout_at` passed, by the flow
clock) and runs past their deadline into `flow.resume` / `flow.timeout` jobs, keyed `resume:<wait>` / `timeout:<run>`.
A resume changes the wait's state once (`SELECT ... FOR UPDATE`, state must be `waiting`), writes the step's result and
enqueues the container's advance, in one transaction.

**Retries** (per step, `retry`): `none`, `fixed` or `exponential` with `count` attempts in all. Default: data steps and
approval requests 3 attempts on transient errors; http, action, email 4, notify 3; the rest none. Error classes: permanent
(4xx other than 408/429, validation, formula errors, constraint violations, `ActionError.retryable = false`) fail the step
at once; transient (network, 5xx, 408/429, deadlocks and serialisation failures, `retryable = true`) wait and try again
(the step row stays `running` with `attempt` + 1 and a `retryAt`; a new advance job is enqueued for that time).

**Timeouts.** A step's `timeoutMinutes` aborts an external call or turns a wait into `timedOut`; `until.timeoutMinutes`
bounds the loop; `settings.timeoutMinutes` bounds the run (`deadline_at`; outcome `timedOut`, waits cancelled).

**Cancellation** (`POST /flows/runs/:id/cancel`): the run's state becomes `cancelled` in one transaction with its waits
(approvals are cancelled through package C's `cancel`, child runs are cancelled); a running step finishes, but every later
job sees the ended run and stops: cancellation takes effect between steps.

**Resubmit.** From the start: a new run with the same trigger payload. From the failed step: a new run that copies the rows
of the steps that succeeded (containers that failed are copied as running so they continue, failed loop iterations run
again, variables are rebuilt from the setVariable steps that succeeded) and runs the rest. **From a chosen step**
(`{ from: 'step', step: <id> }`, P1-E) of any finished run: allowed for a **top-level** step that ran (has a finished row)
when every top-level step before it finished (`resubmitFromStepCheck`); those steps are copied as they ended, their
outputs are reused as stored (not read again), variables are rebuilt from their setVariable rows, and the chosen step and
everything after it run again (with their side effects: the designer asks first). Steps inside a condition, switch, loop or
scope are refused with the reason: the state of a half-run container cannot be rebuilt reliably (run again from the
container, or from the failed step). Outputs are always stored whole (a step whose output is over 1 MB fails), so
"earlier outputs still stored" holds for every finished run until retention deletes it. Only the flow's current owner or an
administrator resubmits.

**Restart safety.** Nothing lives only in memory: a run's state is its rows. A worker that dies loses its jobs' heartbeat;
the reaper puts them back after 30 s and the advance runs again from the database. `flows-durability.integration.test.ts`
crashes the worker at ten points (inside a data step's transaction, after its commit, after an external call was claimed,
after it was made, while suspending and resuming, while entering a container) and checks that every run ends once, data
steps wrote exactly once and external calls happened at most twice with the same idempotency key. The exit-check test runs
the purchase approval flow over a simulated week with two server restarts.

**Time travel.** `services.flows.setClock({ now })` replaces the flow clock: `Now()`/`Today()` in flow formulas, delays,
step and run timeouts and the sweeper follow it (job scheduling itself keeps the database clock). Tests move it forward
and call `services.flows.sweep()`.

## Guarantees per step kind

| Step kind | Delivery | How |
| --- | --- | --- |
| compose, setVariable, condition, switch, scope, forEach, until, terminate, respond | effectively once | the decision and its row commit together; a repeated job finds the row terminal |
| data.get, data.list | reads, any number of times | as the run-as identity, through Query v2 |
| data.create, data.update, data.delete on the default database | **exactly once** | the change, its outbox row, the step row and the next advance commit in one transaction |
| data.* on other connections (external databases, files, sheets) | at least once, deduplicated | create uses a stable row id from run and step (a retry finds the row); update and delete are idempotent |
| http, action, email | at least once with the idempotency key `<run>:<step path>` | the step row is committed as running before the call; the result commits after it. A crash between the call and the commit repeats the call with the same key: the actions service replays a stored result for non-idempotent actions (24 h); http POST/PATCH send it as `Idempotency-Key` |
| notify | effectively once per recipient | the key `<run>:<step path>` is passed to `notifications.notify` (`NotifyInput.idempotencyKey`): each recipient's notification id is derived from key and user, the in-app row is written first (`ON CONFLICT DO NOTHING`) and the email is skipped when the delivery log already has it. Left: a crash between handing an email to the mail queue and logging it can repeat that email |
| approval | the request once per step execution (key `<run>:<step path>`, made inside the step's transaction); the answer resumes once | wait row state changes once |
| delay, waitForCallback | resumes once | wait row state changes once; a callback that arrives before the step waits is kept (`early`) |
| callFlow | the child run is created once (trigger key `call:<run>:<step path>`, in the step's transaction); its end resumes the parent once | |

## Triggers

| Trigger | How a run starts | Exactly once |
| --- | --- | --- |
| table | the outbox dispatcher calls the flows consumer inside its claiming transaction (`kernel.addDispatcher`): for each committed change of the table, each matching enabled flow, each row (at most 1,000 of a bulk change) | trigger key `tbl:<flow>:<outbox id>:<row>` |
| schedule | an `ab_schedules` row `flow_<flowId>` (job `flow.schedule`) exists exactly while the flow is enabled; each slot is enqueued once by the kernel's scheduler | trigger key `sched:<flow>:<slot>` |
| manual | `POST /flows/:id/run`, `POST /flows/run` (by name), `RunFlow()` in apps | a client-chosen `runId` (trigger key `manual:<runId>`) makes the call idempotent |
| webhook | package D's verified route calls `services.flows.triggerWebhook(env, flowId, payload)` | trigger key `hook:<flow>:<deliveryId>` |

**Table triggers in detail.** `on` filters operations, `columns` filters updates (one of them changed), `condition` is
evaluated on the **after-image** of that change (the row as stored now, with the columns the change wrote as it wrote
them, so later changes of other columns are seen but this change's values are its own) with `Trigger.Old` (the row before,
from the outbox snapshot); reads in the condition run as the run-as identity, budget 1 s, 5 queries. A condition that fails
records a failed run (never silently dropped). Deleted rows: the delete snapshot (every column). Restored rows (recycle bin): operation `restore`, only for triggers whose `on` lists it (off by default), `Trigger.Old` blank. **Coalescing**
(`coalesce: true`): while a run of the same record is still queued (not started), a later change replaces its trigger
payload instead of adding a run.

**Concurrency** (`settings.concurrency`): `parallel`; `singleton` (one run of the flow at a time, the others wait in order);
`perRecord` (one run per record at a time, in outbox order: changes of one record are processed in the order they were
committed). Waiting runs are started by the run that ends (`startNext`, under an advisory lock per key). Per-record order
holds per dispatcher; with several servers dispatching one environment at once the order of two changes of one record in
different dispatch batches is not guaranteed.

**Loop protection.** A flow's data steps run in a work context with the run's correlation id, depth + 1 and the chain entry
`flow:<flowId>:<rowId>`; the outbox row of the change carries them (and table events after it keep them). A table trigger
then does **not** start a run for a change made by the same flow (any record), unless `settings.triggerOnOwnChanges` is
true; then it fires again for the same record at most 3 times on one chain (`OWN_CHANGE_CAP`). Independently, a change
made 8 levels deep (`FLOW_MAX_DEPTH`, the table-event chain depth) starts no runs. Child flows nest at most 8 deep.

## Expressions

Fx, pure (`Patch`, `Notify` ... are refused at save time: flows change data with data steps). Names: `Trigger` (per trigger
type: `Record`, `Old`, `Operation`, `ChangedColumns`, `Table`, `User`; `ScheduledTime`; `Inputs`, `User`; `Body`, `Query`,
`Headers`, `ReceivedOn`, `DeliveryId`), `Steps.<name>.Output` / `.Status` / `.Error` / `.StartedOn` / `.FinishedOn` /
`.Attempt`, `Variables.<name>`, `Flow` (`RunId`, `Name`, `Id`, `Version`, `Mode`, `Callback.<waitForCallback step name>`),
`User()` (the run-as identity), the item of each enclosing `forEach` by its `as` name and `ThisItem` (the innermost), and
the tables of the environment for delegable reads (`LookUp`, `Filter` with `FirstN`, `CountRows`, `Sum` ...). Steps visible
to a step: earlier siblings and the steps inside them (not inside loops), and those of enclosing containers; inside a loop
iteration, the steps of that iteration. Reads run through Query v2 as the run-as identity with the table-event limits
(5,000 rows, 50 queries, 30 s per step); a table named on its own is refused (it would read every row).

Values are stored with dates tagged (`{"$d": "<ISO>"}`) so a date stays a date; API answers show plain JSON.

## Validation (save time)

`POST /flows/validate` and every save return `ValidationProblem { step, field, message, severity, start?, end? }`:
`step` is the step id (`''` the flow, `trigger` the trigger), `field` the step field (`if`, `values.Amount`, `runAfter`,
`inputs.X`, `settings.concurrency` ...). Checked: the schema of the trigger and of every step kind; ids and names unique
and identifier-safe; nesting (8) and size (250 steps); expressions with the server engine in the scope the step runs in
(syntax, function arguments, actions refused, unknown names, unknown fields of known records such as
`Trigger.Record.Nope` or `Steps.Missing.Output`, reads that cannot be pushed down, whole-table reads), with
`Steps.<name>.Output` typed from the step kind where known (a data step's row of its table, approval outcomes ...);
references to tables, columns (and computed columns refused as targets), flows (a callFlow target needs a manual trigger;
its inputs), connections (attached under that reference; the connector kind fits) and actions (the actions service lists
them; required inputs); `runAfter` (only earlier siblings: no cycles; steps after a Terminate that can never run are
warned about); callFlow recursion through other flows (A -> B -> A); `setVariable` inside a parallel loop; limits. Errors
refuse the save (422 with `problems`); warnings are returned with the saved flow.

## Identity and security

* **runAs**: `owner` (default), `triggeringUser` (the person whose change, call or button started it; schedules and web
  requests have none: refused at save), or `{ serviceAccount: <user id of a service account> }` (administrators only; set,
  changed and imported with explicit confirmation; audited `flow.run_as_service`). Every data step goes through the
  DataService as that identity: row and column security, WITH CHECK, validation rules, events and the outbox apply. A
  change made by the system (no person) does not start a `triggeringUser` flow (a failed run explains why).
* **Saving**: makers save their own flows, administrators any; a flow that runs as a service account can only be changed by
  an administrator. Changing `runAs` or the owner needs `confirmRunAs: true` (409 otherwise) and is audited
  (`flow.run_as_changed`, `flow.owner_changed`). Attaching a connection (a new or changed reference) needs the right to
  use it: administrators always, others `services.actions.assertCanUse` (package D's grants); audited
  `flow.connection_granted`. Data rights are not checked at save time (they are enforced at run time).
* **Child flows** (P1-E): saving a flow with a `callFlow` step needs the right to run the target, for the person saving and for
  the flow's owner; at run time the run-as identity must be allowed to run the target (owner, administrators, granted
  roles), else the step fails ("may not run"). Without this a maker's flow could start an administrator's or a service
  account's flow (security review P1, finding 2).
* **Formulas on the server** (P1-E): `setRegexGuard` refuses regular expressions with nested repeats, `setEvaluationBudget`
  stops one evaluation after 30 s or about 50 MB of text / 3 million rows built (`src/fx/evaluate.ts`).
* **Running by hand**: the owner, administrators, and roles granted on the flow or on every flow (`ab_flow_run_grants`).
  A flow that runs as its owner runs with the owner's rights for whoever the owner lets run it; that is the owner's
  decision. The person who started a run sees its status, not its steps and data.
* **Owner disabled**: the next run fails, the flow gets `suspended` (it stays suspended until a maker saves it or turns it
  on again), administrators get a notification, audited `flow.suspended`. Turning a flow on needs an active owner.
* **Locked production environments**: definitions change only by solution import (`design` routes: create, save, delete,
  restore, permissions); administrators may still turn a flow off or on. The kill switch works everywhere.
* **Limits** (`FLOW_LIMITS`): steps per run 5,000, loop items 5,000, forEach concurrency 20, steps per flow 250, nesting 8,
  trigger payload 256 KB, step output 1 MB, displayed input/output 64 KB, callFlow depth 8, fan-out of a bulk change 1,000,
  runs per minute per flow (`settings.maxRunsPerMinute`, at most 600) and per environment (`environmentRunsPerMinute`,
  default 6,000): beyond them runs start a minute later (nothing is dropped); a run timeout of at most 30 days.
* **Secrets**: inputs are stored redacted (`Authorization`, `Cookie`, API keys, passwords, tokens, signatures) and capped;
  connection secrets never reach a flow (the actions service uses them). Outputs are kept for later steps.

## Observability

Run list and detail (`GET /flows/runs`, `/flows/runs/:id`), live: every state change emits a `table:sys_flow_runs` change on
the realtime hub (the client refetches through the secured API). Health per flow over 7 days (runs, success rate, last run,
average duration) in `GET /flows`. Failure notifications: the first failure of a flow notifies its owner at once; later
failures within a day are counted and sent as a daily digest (job `flow.digest`, 07:05 UTC) to the owner and the
environment's administrators; a failing flow is never switched off. Audit actions: `flow.create`, `flow.update`,
`flow.delete`, `flow.enable`, `flow.disable`, `flow.restore`, `flow.run_as_changed`, `flow.run_as_service`,
`flow.owner_changed`, `flow.connection_granted`, `flow.permissions`, `flow.run`, `flow.test`, `flow.run.cancel`,
`flow.run.resubmit`, `flow.suspended`, `flows.paused`, `flows.resumed`, `flows.settings`. Retention: job `flow.retention`
(02:23 UTC daily) deletes finished runs older than the flow's `settings.retentionDays` (default 30) with their steps and
waits.

## ALM

A solution component of kind `flow` exports the flow's current version, enabled, runAs, its connection references (with
the source connection's id, name and kind) and the roles that may run it. The import plan lists flows as new, changed or
removed (by id); **new flows arrive turned off** unless the request names them in `enableFlows` (or `true`); flows that run
as a service account are listed in `plan.serviceFlows` (administrators only; the import then always needs `confirm` = the
plan's token); every source connection must map to a connection of the target: `plan.flowConnections[]` shows the mapping
(same id, else same name and kind, else `to: null` and a problem), changed with `connectionMap: { <source id>: <target id> }`
on the plan, import and deploy requests (the token covers the mapping). Apply validates every flow against the target
inside the import's transaction (a problem rolls the whole import back), writes a new version, maps references and run
grants, and arms schedules of enabled flows only. A removed flow is deleted and its active runs cancelled after the commit.

**Environment copy**: definitions, versions, references and run grants are copied, the flows **off**, no schedule armed,
no runs. **Backup and restore**: runs are part of the environment backup; a restored environment's queued, running and
waiting runs are **cancelled** with a note ("restored from a backup taken while this run was in progress") and their waits
closed: the jobs that drove them are cancelled by the restore anyway, and approvals, callbacks and the outside world may
have moved on since the backup, so resuming them could act twice or on stale answers. Resubmit them if needed.

## Interfaces for the other packages

* **Approvals (package C)**: implement `ApprovalsService` (`server/core/flows/contracts.ts`) and call
  `services.flows.setApprovals(impl)` at start. `request(env, ApprovalRequest, identity) -> { id }` is called inside the
  step's transaction (C's rows commit with it) with `idempotencyKey = <run>:<step path>` and the `waitId`; `cancel?(env, id,
  'cancelled' | 'timedOut')` when the run is cancelled or the step timed out. When decided, call
  `services.flows.resumeWait(env, waitId, { kind: 'approval', outcome, responses?, comments?, completedOn? })`: idempotent,
  `{ resumed: false }` when the step no longer waits. The step's output: `{ Outcome, Responses, ApprovalId, CompletedOn,
  Comments }`.
* **Connector actions (package D)**: the http, action and email steps call `services.actions.run(env, connectionId,
  actionId, inputs, identity, { idempotencyKey, correlationId, source: 'flow:<id>', timeoutMs })`; http uses action
  `request` with `{ method, url, headers, body }` and reads `{ status, headers, body }`; email uses action `send` with
  `{ to, cc?, subject, body, attachments? }` on the named email connection or, without one, the environment's only (or
  default) connection of kind `email`. The notify step passes `channels` and an `idempotencyKey` along to
  `notifications.notify` (as extra members) for D's email delivery. Webhooks: D's route calls
  `services.flows.triggerWebhook(env, flowId, payload)`, `webhookFlow(env, flowId)` and `canManage(user, flowId)`.
* **Designer (package B)**: the API above, `GET /flows/catalog` (step kinds with fields, outputs, examples; trigger types;
  limits; whether approvals are available), `POST /flows/validate` and the draft routes; `src/flows/designer/FlowDesigner.tsx`
  replaced the JSON editor with the same props (`flowId`, `initial`, `readOnly`, `onSaved`, `onCancel`, `onTested`); `RunViews.tsx`
  and the list are kept (see "Designer" below).

## Refinements of the P1 contract

Additive, recorded here: step kinds `respond { body, status? }` and `waitForCallback { timeoutMinutes? }`; data steps
name the row `rowId` (the step's own `id` is its id) and approval `regarding.rowId`; `setVariable` names its variable
`variable` (the step's `name` is its step name); data.list takes `filter`, `sort`, `top`, `select`; table triggers take
`coalesce`; settings take `triggerOnOwnChanges` and `maxRunsPerMinute`; the email step may name a `connection`; the http
step needs its `auth` connection (it holds the allowed hosts: package D's HTTP connector refuses calls without one);
`RunFlow(flow, inputs [, { Wait, Timeout, Result }])` is the app function (the formula language has no dotted function
names, so `Flow.Run` is not offered).

## Throughput (sandbox)

PostgreSQL 16, one process, job concurrency 8, `flows-durability.integration.test.ts` "throughput": 2,000 runs of a 6-step
flow (compose, setVariable, condition, data.create, compose, respond) queued at once: **about 19-21 runs/s, 115-123
steps/s**. Latency per step (from the previous step's end to this one's end): p50 about 50 ms, p95 60-90 s; the tail is the
burst itself: the first step of 2,000 runs queues behind everything (advances of started runs are claimed before new
starts, priority 2 over 1, so runs that started finish quickly). One step is one job with its own transaction; that is the
price of the guarantees above.

## Designer (P1 package B)

Decision D28 in `docs/decisions.md`; maker view: [guide/maker/flows.md](../guide/maker/flows.md). Exit check 2:
`scripts/exit-check/p1-designer.mjs` (a flow built by clicking only, then the exit-check-1 test on it).

| Module (`src/flows/designer/`) | What it does |
| --- | --- |
| `model.ts` | The canvas model, pure: slots, find/walk, edits (insert, remove, move with run-after repair and visibility notes, duplicate, copy/paste with re-ids and rewritten references), rename of steps / variables / loop items with reference updates, `toTree`/`fromTree`, visible steps (the runtime's rule) |
| `refs.ts` | Which fields of each step kind are formulas (`FX_FIELDS`), mapping them, reference rewrites through the formula parser (`Steps.<name>`, `Variables.<name>`) |
| `layout.ts` | Geometry: cards, container regions with lanes side by side, insertion points, edges, run-after connectors |
| `dynamic.ts` | Dynamic content: typed tokens from the trigger (columns, lookups one hop through `LookUp`, `Old`, inputs, a webhook body sample), visible steps (by kind, table, action output schema, HTTP sample), variables, loop items, Flow, `User()` |
| `filter.ts`, `literal.ts` | The filter / condition builders (rules <-> formula) and plain values <-> formulas (text with `{token}` is an interpolated string `$"..."`) |
| `diff.ts`, `overlay.ts` | Version diff by step id; a run's step rows mapped onto the canvas (one loop iteration at a time) |
| `templateKit.ts` | Templates: parameters, `instantiate`, guesses |
| `store.ts`, `actions.ts`, `context.tsx` | zustand store (definition, connection references, undo/redo with merged typing, selection, problems, draft state, the run shown), commands, the data the panels read (catalogue, tables, flows, usable connections and their actions) |
| `FlowDesigner.tsx`, `Canvas.tsx`, `StepPicker.tsx`, `StepPanel.tsx`, `TriggerPanel.tsx`, `SettingsPanel.tsx`, `FxField.tsx`, `fields.tsx`, `TestDialog.tsx`, `Versions.tsx`, `Gallery.tsx`, `approvalAdapter.tsx` | The UI |

**The definition is the model.** The designer edits the version document itself (`FlowDoc`), never a translated copy:
every edit is a function `(doc) -> doc` that copies only the path it changes, so fields the designer does not know (a
newer runtime's options, package C's approval settings) travel through untouched. Step lists are addressed by a **slot**
`{ parent: <container step id> | '', list: 'steps' | 'then' | 'else' | 'case:<i>' | 'default' }`. The canvas tree
(`toTree`: nodes with the step minus its child lists, lanes with their slots) is derived for drawing and converts back
losslessly (`fromTree`); `designer.test.ts` round-trips every step kind with unknown fields at every level. Step kinds the
designer does not know are drawn as cards and edited as JSON.

**Canvas.** Own HTML cards and SVG lines in one transformed layer (no canvas library; the data model designer's pan, zoom
and minimap): HTML for the cards and "+" buttons (focus, keyboard, screen readers), SVG for connectors. `layoutFlow`
measures bottom-up and places top-down; a container is a region with its lanes side by side, a collapsed one a single
card. Moving a step drops it on the nearest insertion point; `moveSteps` refuses a container into itself, drops run-after
entries that would no longer name an earlier sibling and notes references the step can no longer see (the validator
then shows them as problems). Undo/redo keeps 100 snapshots of the (structurally shared) definition; typing in one field
within a second is one undo step.

**Draft and publish.** `ab_flows.draft` (jsonb: `{ doc, connections, baseVersion }`), `draft_by`, `draft_on` are added by
`ADD COLUMN IF NOT EXISTS` in the environment DDL (idempotent, no schema version step); environment copies carry them
along. `GET|PUT|DELETE /flows/:id/draft` (editors only; the draft is not validated; a new or changed connection reference
needs "use" access when the draft is saved, so the maker learns at once). `PUT /flows/:id` (publish) clears it in the same
transaction unless `keepDraft`. The runtime, solutions and exports never read the draft. The designer saves the draft 0.8 s
after the last change and validates (`POST /flows/validate`) 0.5 s after it; problems carry step id and field and are shown
next to the field and in the list; Publish and turning on are refused while there are errors.

**Soft lock.** The Studio's lock on the live hub with the scope `studio:<flowId>` (flow ids never collide with app ids):
first editor edits, others are read-only and may take over; read-only too in a locked production environment.

**Expressions.** Plain values compile to formulas (`literal.ts`); the formula editor reuses the Studio's suggestions
approach (functions, members of `Trigger`/`Steps`/`Variables` from the dynamic content tokens, `fx.signatureAt`), a
client-side syntax check (`fx.check`) and the server's check through `/flows/validate`, so messages are the server
engine's (the Studio's wording). A formula that reads a table shows "Runs on server", or "Can't run" when the server reports
a read it cannot push down.

**Test and overlay.** `POST /flows/:id/test` with the canvas's definition (`definition`) and a sample trigger (a recent
run's stored trigger, a row read through Query v2, or a form), dry run by default. The run is loaded with
`GET /flows/runs/:id` and refreshed on `table:sys_flow_runs` hub messages (and every 2.5 s while active); `overlayOf` maps
step rows (`/each#2/inner`) to step ids, one loop iteration at a time. "Run again from this step" is the runtime's resubmit
from the failed step.

**Approvals.** The approval step's form is package C's `ApprovalStepForm` (`src/approvals/`; P1-E: approvers, stages,
threshold rules, answers and the escalation target are edited visually with `src/approvals/DefinitionEditor.tsx`), found with
`import.meta.glob` by `approvalAdapter.tsx`, so the designer builds without it (a placeholder edits the core fields).
`GET /flows/catalog` says whether an approvals service is registered (`approvals`); without one the picker and the
gallery mark approval steps "needs approvals".

**Templates.** `src/flows/templates/*.json`: `{ id, title, description, category, needs?, params, flow }` with `{{param}}`
placeholders (tables, columns of given types, numbers, texts, time zones, connections). `templates.test.ts` fills each
one and runs the server validator; `designer.integration.test.ts` creates them through the API.

**Performance** (sandbox, headless Chrome, `p1-designer.mjs` part D): a 180-step flow (60 containers) opens and draws in
about 0.26 s; opening a step's panel about 50 ms; adding a step about 0.3 s; undo about 60 ms; arrow-key navigation about
30 ms per step.

## Not done yet

The trigger `formSubmitted` (reserved); per-record ordering across several dispatching servers. Designer: no real-time
co-editing (a soft lock instead); "run again from this step" runs from the failed step anywhere, or from a completed
**top-level** step (not from inside a container); the visual diff is an outline, not a second canvas; marquee selection is
not there (Ctrl/Shift + click instead).
