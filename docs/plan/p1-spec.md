# Phase 1 (Automation) specification

Status: IN PROGRESS (started 18 Nov 2026). Phase 0 closed at 0.5.0; its one open exit item is the first real
run of the Windows installer on a Windows PC (see `p0-spec.md`).

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
