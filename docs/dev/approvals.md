# Approvals (P1 package C)

Approval requests from flows, apps and the API: routing, answers, delegation, reminders, escalation, security, email
answer links, the record timeline and the `approvalDecided` flow trigger. Decision D29 in [decisions.md](../decisions.md).
Maker view: [guide/maker/approvals.md](../guide/maker/approvals.md); administrators: [admin/approvals.md](../admin/approvals.md);
approvers: [help/quick-start-approver.md](../help/quick-start-approver.md); generated reference:
[reference/approvals.md](../reference/approvals.md); HTTP API: [data-api.md](data-api.md#approvals).

| Module | What it does |
| --- | --- |
| `src/platform/approvals.ts` | Shared types (definitions, policies, requests, assignments, history, delegations, settings), approver reference parser, `definitionProblems`, answer kinds, the catalogue for the reference docs |
| `server/core/approvals/ddl.ts` | The eight tables of an environment schema (version 9 step) |
| `server/core/approvals/routing.ts` | Pure routing: stage plans, resolving references, the rules every stage follows, stage outcomes |
| `server/core/approvals/service.ts` | The service (`services.approvals`): create, answer, info, reassign, cancel, delegations, sweep (reminders, escalation, delegation start/end), notifications, email links, timeline source, the flow runtime's `ApprovalsService` |
| `server/core/approvals/routes.ts` | HTTP API |
| `server/core/approvals/alm.ts` | Policies in solution packages |
| `src/approvals/*` | Approvals page (User mode `#u-approvals`), policies and settings panel, the Approvals panel UI component, `ApprovalStepForm` (embedded by the flow designer), the API client |
| `src/fx/functions/collab.ts` | `RequestApproval`, `Approvals(record)`, `MyApprovals()` |

## Tables (per environment schema, version 9)

| Table | Key columns | Notes |
| --- | --- | --- |
| `ab_approval_policies` | `id`, `name` (unique, case-insensitive), `definition` jsonb, `solution_id` | Reusable definitions |
| `ab_approval_requests` | `id`, `title`, `details` (sanitised rich text), `fields` jsonb, `regarding_table`/`regarding_id`, `requested_by`, `type`, `policy_id`, `definition` (a copy, so later policy edits never change an open request), `status`, `outcome`, `outcome_kind`, `due_on`, `current_stage`, `source` (`flow`, `app`, `api`), `flow_id`, `flow_run_id`, `wait_id`, `step_key`, `idempotency_key` (unique), `escalate_at`, `info_from`, timestamps | One per request |
| `ab_approval_stages` | (`request_id`, `idx`), `name`, `mode` (`any`, `all`, `quorum`), `quorum`, `refs` jsonb, `status` | Planned when the request is made; people resolved when the stage starts |
| `ab_approval_assignments` | `id`, `request_id`, `stage_idx`, `user_id`, `source` (`direct`, `role`, `team`, `department`, `manager`, `delegation`, `escalation`, `fallback`, `reassigned`), `status` (`pending`, `responded`, `reassigned`, `escalated`, `skipped`, `cancelled`), `response`, `response_kind`, `comment`, `responded_on`, `reassigned_from`, `delegation_id`, `note`, `next_reminder_at`, `reminders_sent` | One per person asked |
| `ab_approval_history` | `id`, `request_id`, `at`, `seq`, `actor_id`, `actor_kind` (`user`, `system`, `flow`), `action`, `stage_idx`, `details` | Append-only |
| `ab_approval_delegations` | `id`, `from_user`, `to_user`, `starts_on`, `ends_on`, `policies` jsonb, `note`, `cancelled_on`, `started_applied`, `ended_applied` | Out of office |
| `ab_approval_links` | `id` (random 128 bits), `request_id`, `assignment_id`, `user_id`, `response`, `expires_on`, `used_on` | Email answer links |
| `ab_approval_settings` | `k`, `v` | `settings`: `viewerRoles`, `retentionDays`, `linkHours` |

The core data model shows them in the group **Approvals** as read-only projections (views): Approval requests,
Approval stages, Approval assignments, Approval history, Approval delegations, Approval policies
(`sys_approval_*`, `src/platform/system-tables.ts`). Only the service writes the tables.

## Security

One rule, in two places that must agree: the system tables' policy `approvals` (`approvalRequestRead` in
`src/platform/system-tables.ts`, compiled into every query like any row predicate) and `canSee` in the service (detail,
answers, links, panel, timeline). A request is visible to:

- environment administrators;
- the requester (`owner` of the view);
- everyone asked, now or before (an assignment with `user_id` or `reassigned_from` = me): approvers, their delegates, the
  person who delegated, the people replaced by an escalation or a reassignment;
- holders of the privilege **Approvals: view** (roles in the approval settings, stored as `systemPrivilegeRoles` on the
  table definition of `sys_approval_requests` so the security engine reads it) for requests about a record they can read
  (the regarding rule of the core data model).

Stages, assignments and history follow their request (semi-join on `Request`); delegations are visible to their two
people. Only a pending assignment of the current stage lets a person answer (delegates hold their own assignment).
Comments and files about a request (`regardingTable = sys_approval_requests`) follow the request through the regarding
rule (approval requests were added to the one-level "collaboration about collaboration" list).

**What an approver sees of the record.** The detail reads the regarding record **as the viewer** (row and column
security; never as the system). Someone who cannot read it sees only what the request carries: title, details and the
declared fields (`fields` of the flow step or `RequestApproval`), with a notice; `record` is null and `recordHidden`
true. The flow maker decides what to declare; the record itself never leaks.

Leak tests (`approvals.integration.test.ts`, "LEAK"): a person not involved gets 404 for the request, empty lists, zero
rows and count 0 through the data API on all four request tables, nothing in comments about the request, 404 for the
record panel and the record timeline; a holder of "Approvals: view" who cannot read the record sees nothing; an approver
who cannot read the record sees the details and fields only (the record's secret column is not in the answer).

## Routing

`expandStages` (when the request is made): single, any, all and quorum make one stage; sequential takes the stages,
skipping those whose `condition` (a formula over the fields) is false; every threshold rule whose condition holds adds a
stage; a manager-chain reference becomes one stage per level (from the requester up, until the level count, or the first
manager with the job title or role). `resolveStage` (when a stage starts) turns references into people, then applies in
order: disabled people are dropped; the requester is dropped unless `allowSelfApproval`; with `separationOfDuties` the
people who approved the previous stage are dropped; nobody left falls back to the requester's manager, else the
environment's administrators (each dropped person and the fallback are written to the history with the reason);
delegations active now are followed (up to 5 hops, not back to the requester, no cycles; policy filter); duplicates are
asked once; a quorum never exceeds the people asked. `stageOutcome`: `any` the first answer; `all` everyone (the first
rejection rejects unless `rejectOnFirst: false`); `quorum` N approvals, rejected as soon as N cannot be reached; a custom
answer (kind `other`) ends the request with that answer (status `completed`). "Need more info" (kind `info`) sets the
request to `info`; the requester's answer sets it back to `pending` and the same people answer.

## Lifecycle and guarantees

Every change runs in one transaction with the request row locked (`SELECT ... FOR UPDATE`): the assignments, stages,
history, the flow's resume job (`services.flows.resumeWait`, keyed `resume:<wait>`) and the notification jobs commit
together, so a decision is taken once and resumes its flow once. Decisions are immutable (an answered assignment never
changes; a decided request never reopens; a correction is a new request). Notifications go out from jobs after the
commit: `approval.notify` (asked, reminder, escalated, info, info answered; keyed per assignment and event) and
`approval.decided` (requester, people no longer needed, `approvalDecided` flows; keyed per request).

The sweep (`tick`, on every worker round, at most every 2 s per environment; tests call `tick(true)`) applies
delegations that started or ended, sends due reminders, and escalates overdue requests. Time is the flow clock
(`services.flows.engine.clock`), so `setClock` moves both. Escalation (once per request, after `due + afterMinutes`):
`manager` (each person still to answer gets their manager in their place), `user`, `nextStage` (re-armed for the next
stage), `approve` / `reject` (actor `system`, `automatic: true` in the history), `expire`. Delegations are honoured at
assignment time, at escalation, and retroactively when one starts (pending assignments move to the delegate, source
`delegation`); when it ends or is cancelled, what is still pending because of it goes back. Cancel: the requester
(withdraw), an administrator, or the flow (run cancelled: `cancelled`; step timed out: `expired`). Reassign: the person
asked or an administrator (audited `approval.reassign`).

Audit (environment): `approval.request`, `approval.approved|rejected|completed|cancelled|expired` (with the regarding
record, so they show in the record's audit), `approval.reassign`, `approval.delegation.create|cancel`,
`approval.policy.create|update|delete`, `approval.settings`.

## Flows

`createApprovals` registers the real service with `services.flows.setApprovals`. The engine calls `request()` inside the
step's transaction (the rows commit with the step) with the idempotency key `<run>:<step path>`; the step's own fields
are passed additively (`policy`, `fields`, `definition` with quorum, stages, dueMinutes, reminders, escalation,
allowSelfApproval, separationOfDuties, requireCommentOnReject; `typeGiven` / `optionsGiven` so a policy's type and answers
apply when the step names none). Without `dueMinutes`, the step's timeout is the due date. The step output: `Outcome`,
`Status`, `Responses` (Approver, Name, Response, Comment, Time, Stage, UserId), `Approvers` (Approver, Name, Stage,
Source, Status), `ApprovalId`, `CompletedOn`, `Comments`. A run cancelled or a step timed out calls `cancel()`.
The `approvalDecided` trigger (`policy`, `statuses` filters; trigger key `appr:<flow>:<request>`; `Trigger.Request`,
`Trigger.Responses`) starts from the decided job. The stub of the flow suite stays for its unit tests.

**Exit check 1 with the real service** (`approvals-exit.integration.test.ts`): the purchase flow over a simulated week,
two server restarts (one with decisions' resume jobs still queued), a reminder, an escalation to the manager's manager
who has delegated (so the deputy is asked), a delegation that starts mid-way and moves a waiting second approval
retroactively, a rejection with a required comment; every run succeeds, six requests, six waits resumed once, six
`flow.resume` jobs, each data change once, each step once.

## Apps

`RequestApproval(policyOrApprovers, record, title [, details [, fields]])` (behaviour; the id is chosen in the browser,
so the call returns at once and a retry finds the same request; the call waits for pending writes of the app first, so a
record just created with `Patch` exists). `Approvals(record)` and `MyApprovals()` are macros over the system tables
(they delegate like `Filter`). The **Approvals panel** UI component shows a record's requests with answer buttons.
The record timeline gets "asked for approval" and "was approved / rejected" events from a timeline source the collab
module calls (`collab.addTimelineSource`), only for viewers who may see the request.

## Email links

The `asked`, `reminder` and `escalated` notifications carry personal answer buttons (`NotifyInput.emailActions`, rendered
by the delivery module in immediate emails; digests keep only the "Open" link). Each button is
`<public URL>/#u-approvals?link=<token>`; the token is `base64url({e: environment, l: link id}).HMAC` with a key derived
from the install's secret key (`appbuilder.approval-link.v1`); the link row binds one person, one assignment, one answer
and an expiry (settings `linkHours`, default 72). Safety:

- the token sits in the URL **fragment**: a mail scanner that fetches the link gets the app page and nothing reaches the
  server; there is no GET route that acts;
- the page shows a **confirmation** (`POST /approvals/links/inspect`, read-only) and answers only with
  `POST /approvals/links/use`, which needs a session (not signed in: the sign-in screen first, the fragment survives) and
  the CSRF header;
- the signed-in person must be the link's person; the link is single use (marked used in the answer's transaction), it
  dies when the assignment is no longer pending (decided, reassigned, delegated), and when it expires; a restore
  invalidates every unused link.

## ALM, environments, backups

Policies are solution components (`approvalPolicy`); people travel as `user:<email>`; the plan lists every email with
the person found in the target or flagged (a warning; `peopleMap` on the import maps emails). Requests never travel.
Environment copy: policies and settings, no requests or delegations. Restore: open requests stay open; the restore
cancels waiting flow runs (D27), so `wait_id` is cleared; every person still asked gets one reminder a minute after the
restore (the notification jobs were cancelled with the queue), escalations already overdue move an hour ahead, and unused
email links stop working (`backup/service.ts` fixups). Retention: `approval.retention` (02:41 daily) deletes decided
requests older than `retentionDays` (0: forever).

## Tests

`routing.test.ts` (every reference, type, rule, outcome), `approvals.integration.test.ts` (lifecycle of every type, info,
custom answers, reassign, cancel, delegation, reminders and escalation with the clock, LEAK, email links, bulk, the app
API, `approvalDecided`, ALM export), `approvals-exit.integration.test.ts` (exit check 1), and the headless run
`scripts/docs-shots/approvals.mjs` (three people and a deputy, a phone at 360 px, the email link through sign-in).

## Not done

Answering by replying to the email; approvals in chat cards; a visual editor for stages and rules (JSON under
"Advanced"); per-stage due dates (one due date per request; `nextStage` re-arms); timeline events for each answer (only
"requested" and "decided"); department heads are inferred from reporting lines (no explicit head field).
