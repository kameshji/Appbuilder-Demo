# Phase 1 (Automation) specification

Status: **DONE** (19 Nov 2026, version 0.6.0; started 18 Nov 2026). Exit check results and what is carried forward:
"Exit check results" at the end. Phase 0 closed at 0.5.0; its installer exit item was closed by a real run on a Windows
11 PC (see `p0-spec.md`).

## Exit check

1. A purchase-approval flow (request row created -> manager approval -> above a limit, second approval ->
   notify requester -> escalate after a deadline) runs for a simulated week (time-travel test) with no lost or
   duplicated step, across two server restarts.
2. A flow built in the designer by clicking only (no JSON) passes the same test.
3. Approvals can be answered from the inbox page, the bell, and an email link; delegation and escalation work.
4. A scheduled report emails a table/aggregate to a list every morning.
5. Flows, approvals and connections travel in solutions and deploy between environments with the plan screen.
6. A restricted user cannot make a flow read or write anything they could not do by hand, unless an admin
   set the flow to run as a service identity (audited).
7. Docs: maker guide for flows and approvals, admin guide, dev docs, reference for triggers and actions.

## Fixed contracts (so packages can run in parallel)

### Flow definition (stored per environment, `ab_flows`; versioned; exported in solutions)

```
Flow {
  id, name, description, enabled, version, solutionId?,
  runAs: 'owner' | 'triggeringUser' | { serviceAccount: id },   // serviceAccount: admins only, audited
  trigger: Trigger,
  steps: Step[],            // ordered; containers hold their own steps
  variables?: { name, type, initial? }[],
  settings: { concurrency: 'parallel' | 'singleton' | 'perRecord', timeoutMinutes, retentionDays, onError: 'fail' | 'continue' }
}
Trigger =
  | { type: 'table', table, on: ('create'|'update'|'delete')[], columns?: string[], condition?: Fx }
  | { type: 'schedule', cron | everyMinutes, timeZone }
  | { type: 'manual', inputs: InputDef[], from: 'app' | 'record' | 'any' }      // Flow.Run("name", {...}) from apps
  | { type: 'webhook', secretRef }                                              // signed inbound HTTP
  | { type: 'approvalDecided' | 'formSubmitted' }                                // reserved
Step = { id, name, kind, ...config, runAfter?: { step: id, when: ('succeeded'|'failed'|'skipped'|'timedOut')[] }[] }
kind =
  'condition' { if: Fx, then: Step[], else?: Step[] }
  'switch'    { on: Fx, cases: { value, steps }[], default?: Step[] }
  'forEach'   { items: Fx, as, steps, concurrency? , max }
  'until'     { condition: Fx, steps, maxIterations, timeoutMinutes }
  'scope'     { steps }                                  // try/catch via runAfter
  'setVariable' | 'compose'  { name?, value: Fx }
  'data.create' | 'data.update' | 'data.delete' | 'data.get' | 'data.list' { table, ...Fx inputs, query plan for list }
  'approval'  { see approvals }                          // suspends the run
  'delay'     { minutes | until: Fx }                    // suspends the run
  'notify'    { to: Fx (users/teams), title: Fx, body: Fx, link? , channels: ('inApp'|'email')[] }
  'email'     { to, cc?, subject, body (rich text template with Fx), attachments? }
  'action'    { connection, action, inputs: Record<string, Fx> }     // connector action
  'http'      { method, url, headers, body, auth: connection? }      // via the HTTP connector
  'callFlow'  { flow, inputs }                           // child flow
  'terminate' { status, message? }
```

Expressions are the formula language evaluated on the server (`createEngine`). Inside a flow: `Trigger` (the
record/old record/inputs), `Steps.<name>.Output`, `Variables.<name>`, `Flow` (run id, name), `User()` = the
run-as identity. Table reads must be delegable (same rule as table events).

### Execution model

Durable runs: `ab_flow_runs` (state, trigger payload, run-as, correlation) and `ab_flow_steps` (one row per
step execution: state, input, output, error, attempt, timings). The engine is a state machine driven by jobs
from the Phase 0 queue: each step executes in its own job and transaction; suspension (approval, delay,
wait) stores a wake condition; resumption is a job. At-least-once per step with idempotency keys on every
side effect; data steps and their step-row update commit together. Table triggers read the outbox (same
transaction as the data change, so no event is lost). Limits: steps per run, loop iterations, run duration,
payload size, per-flow rate; a flow that keeps failing raises a notification to its owner and admins (it is
not silently disabled).

### Connector actions

`services.actions`: `list(connectionKind)`, `describe(action)` (JSON Schema for inputs/outputs),
`run(env, connectionId, actionId, inputs, identity, idempotencyKey)`. Connections are used by a flow only
after a maker with rights on that connection attached it to the flow (connection references in solutions).
Outbound network policy from Phase 0 (`net-policy.ts`) applies to every action.

## Work packages

| # | Package | Wave |
|---|---|---|
| A | Flow runtime: definitions store, validation, triggers (table, schedule, manual, webhook), state machine, all step kinds except approval UI, run history API, limits, Flow.Run from apps, solution/ALM, tests incl. time travel and restart | 1 |
| D | Connector actions framework + HTTP connector, email action, webhook inbound, notification delivery by email (per-user channel preferences, digest), scheduled reports (table/aggregate as HTML+CSV email) | 1 |
| B | Flow designer (visual, click-only), expression editor with server check, test run with sample trigger, run history viewer with per-step inputs/outputs, templates of common flows | 2 |
| C | Approvals: definition (single, sequential, parallel all/any, by role/manager/team), inbox page, bell and email answer links, delegation, reminders, escalation, comments, audit; `approval` step; record timeline integration | 2 |
| E | Phase close: docs sweep, security re-check of flows (privilege escalation, SSRF, injection, loops), exit check | 3 |

## Package E: gaps closed at the phase close

| Gap | Done | Where |
| --- | --- | --- |
| a. Dynamic content lists the approval outputs `Status`, `Approvers`, `Comments` and the `approvalDecided` trigger fields | yes | `src/flows/designer/dynamic.ts`; every offered token passes the server validator (`templates.test.ts`) |
| b. `RunFlow` waits for the app's pending writes (like `RequestApproval`) | yes | `src/runtime/data.ts`; `src/runtime/runflow.test.ts` |
| c. Visual editor for approval stages and threshold rules (no JSON for the maker guide's cases); per-stage due dates | yes | `src/approvals/DefinitionEditor.tsx`, `definitionKit.ts` (+ test), `PoliciesPanel.tsx`, `ApprovalStepForm.tsx`; `ab_approval_stages.due_minutes`; `approvals.integration.test.ts` "per-stage due dates", "a flow step built in the visual editor" |
| d. Connection and people mapping on the plan screen (Deploy and Import), blocked until mapped | yes | `src/portal/SolutionPlan.tsx` (`usePlanMappings`), `dialogs.tsx`, `environmentApi.ts`; exit check 5 drives it in a browser |
| e. Idempotency key for the in-app `notify` step | yes | `NotifyInput.idempotencyKey`; `flows-durability.integration.test.ts` "notify after a crash" |
| f. Run again from any completed step | yes, for top-level steps (safe option); steps inside containers are refused with the reason in the UI | `resubmitFromStepCheck` (engine), Canvas menu; `flows.integration.test.ts` "resubmit from a chosen completed step" |
| g. SMTP XOAUTH2 for Microsoft 365 / Google Workspace, no new dependency; provider settings documented | yes | `server/core/identity/oauth-token.ts`, `smtp.ts`, `mail.ts`, Admin console > Email; `smtp.test.ts`; `docs/admin/installation.md` "Email with Microsoft 365 or Google Workspace" |
| h. Health email (daily + immediate) and an external heartbeat | yes | `server/core/diagnostics/health-alerts.ts`, Admin console > Server logs; `ops.integration.test.ts` "health alerts" |
| i. Kill switch and per-flow on/off in the Admin console | yes (it was only on the Flows page) | Admin console > Flows (`src/portal/AdminFlows.tsx`); exit check "i" |

Security re-check: `docs/internal/security-review-p1.md` (10 findings, 9 fixes in code plus one caught before release),
including the **recycle bin** built at the end of the phase (decision D31, `docs/dev/recycle-bin.md`): tables of the default
database keep deleted rows for N days (new tables 30), restorable by Undo, the Deleted view, `DeletedRows` and `Restore`.

## Exit check results (package E, 19 Nov 2026)

`node scripts/exit-check/p1.mjs` against a server started on an empty database (PostgreSQL 16, sandbox), 91 s:

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Purchase approval flow over a simulated week, two restarts, no lost or duplicated step | PASS | `approvals-exit.integration.test.ts` (real approvals service: reminder, escalation to a delegating manager's deputy, a delegation starting mid-way, a rejection with a required comment; six requests, six waits resumed once, every data change once) and `flows-durability` "exit check 1"; the flow clock can only be moved in-process, so the script runs these tests (2 passed, 10 s) |
| 2 | The same flow built in the designer by clicking only | PASS | `scripts/exit-check/p1-designer.mjs`: 36 checks (built by clicks, compared with the exit-check-1 flow, the week with restarts, the 150-step performance part) |
| 3 | Approvals from the inbox page, the bell and an email link; delegation and escalation | PASS | headless browser per person, fake SMTP relay: inbox approve; bell notification deep link and approve; email Approve link opens the confirmation page (nothing decided before), confirm; a delegation (the deputy answers on her page); due in 1 h, the clock moved 2 h, the manager's manager asked and answers |
| 4 | A scheduled report emails a table/aggregate every morning | PASS | daily 07:00 (Asia/Kolkata) schedule; run now: the administrator gets the HTML table and the CSV with both rows; a recipient who may read only her own rows gets only hers (HTML and CSV) |
| 5 | Flows, approvals and connections travel in solutions and deploy with the plan screen | PASS | a solution with a table, two flows (one with an HTTP connection reference) and an approval policy naming a person without an account in the target; Deploy dialog: blocked until mapped, target connection chosen, the person mapped; in the target: flows arrived off, the reference points at the target's connection, the policy names the mapped person |
| 6 | A restricted user's flow reads and writes only what they could by hand; service-account run-as audited | PASS | a maker restricted to own rows: their flow saw 1 row, writing a log it cannot write and changing an administrator's row failed, nothing written; making it a service flow: 403 for the maker, 409 without confirmation for the administrator, audited `flow.run_as_service` |
| 7 | Docs: maker guide for flows and approvals, admin guide, dev docs, reference for triggers and actions | PASS | 21 required pages present; `scripts/docs-links.test.ts` and `scripts/naming.test.ts` pass |
| i | (gap i) Admin console > Flows shows the kill switch and pauses all flows | PASS | state running -> paused (API `paused: true`) -> running; every flow listed with its state |
| r | The recycle bin: a deleted row leaves queries; its owner sees and restores it, nobody else | PASS | a new table keeps deleted rows 30 days; after a delete, queries return nothing; a user restricted to own rows sees only her deleted row in the Deleted view, gets 404 restoring the administrator's batch and 403 on Empty now, and Undo brings her row back |

The checks ran on the complete working tree at the phase close, the recycle bin included (schema version 10), so the
result describes Phase 1 as shipped. The full test suite ran twice on PostgreSQL 16 and MariaDB: 1852 passed, 4 skipped,
both runs.

**Phase 0 regression** (`node scripts/exit-check/p0.mjs`, same day, with the recycle bin's live-row predicate, 142 s):
every automated check passes again. 1,000,000 rows: first page + exact count 42 ms (0.5.0: 71), indexed filter 10 ms (8),
indexed filter + count of 250,000 183 ms (206), non-indexed filter 9 ms (8), sorted page 10 ms (7), search + count 29 ms
(26), exact count 47 ms (70), grouped aggregate 327 ms (387), whole-table sum 91 ms (99), 20 pages by cursor 11 ms each
(8), all far under their limits; 29 browser checks; the not-delegable formula error; the restore drill (21.3 s); identity
end to end; a second environment. Checks 1 (CI) and 5 (Windows installer) report their evidence elsewhere, as at 0.5.0.

## What moved, and what is carried forward to Phase 2

Moved during Phase 1: the recycle bin for deleted rows (designed in package C's time, built at the close), health alerts by email and an external heartbeat (planned as "not supported yet" in operations),
SMTP OAuth 2.0 for Microsoft 365 and Google Workspace, the admin recovery CLI and request references (package C).

Carried forward (open items, none blocks the exit check):

- Approvals: answering by replying to the email, approval cards in chat (P3), per-stage escalation actions (one escalation
  per policy, re-armed per stage), timeline events for each answer, an explicit department head field.
- Flows: the `formSubmitted` trigger (reserved); per-record ordering across several dispatching servers; real-time
  co-editing in the designer (soft lock today); a canvas diff of versions (an outline today); marquee selection; "run again
  from here" inside containers; the import plan does not validate flows against the target (the import does, and rolls
  back).
- Email: Google service accounts (JWT grant) and certificate credentials for Microsoft apps; sending through the Graph or
  Gmail APIs.
- Security residuals (`docs/internal/security-review-p1.md`): super-linear regular expressions other than nested repeats;
  one native call cannot be interrupted by the evaluation budget; slow webhook bodies until the request timeout; makers
  read every flow definition and change every policy; an outside review before the pilot grows.
- Phase 0 residuals still open: DNS rebinding for database connections, unsigned backup archives, download tickets in URLs.
- Windows: HTTPS options, the updater and rollback, uninstall and the offline bundle not yet exercised on Windows.
- Screenshots of the designer's approval step form and of Settings > Notifications with "Server health" were not retaken.
