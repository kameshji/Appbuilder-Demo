# Power Automate

Research date: 18 November 2026. Sources are Microsoft Learn pages retrieved on that date. Opinions are labelled *inference*; unconfirmed claims are labelled *unverified*.

Appbuilder's next big piece is a flow engine. This file explains how Power Automate cloud flows work underneath, then proposes an engine that fits one Node process and MySQL.

## 1. Architecture: cloud flows are Logic Apps workflows

Microsoft positions Power Automate and Azure Logic Apps as two designer-first workflow platforms with similar designers and overlapping connectors: Power Automate for citizen developers under Microsoft 365/Power Platform licences, Logic Apps for professional integrators under Azure billing ([Azure integration services comparison](https://learn.microsoft.com/azure/azure-functions/functions-compare-logic-apps-ms-flow-webjobs), [migration comparison table](https://learn.microsoft.com/azure/logic-apps/power-automate-migration#compare-capability-details)). The shared engine shows through in several places:

- Duplicate action executions are explained by "the at-least-once design of Azure Logic Apps", and Microsoft tells makers to design flows to be idempotent ([trigger troubleshooting](https://learn.microsoft.com/troubleshoot/power-platform/power-automate/flow-run-issues/triggers-troubleshoot#trigger-fires-for-old-events)).
- The `workflow()` expression returns metadata whose tags include `logicAppName` and `environmentName` ([error handling guidance](https://learn.microsoft.com/power-automate/guidance/coding-guidelines/error-handling)).
- Retry policies, run-after, scopes and `result()` are documented once for Logic Apps and referenced from Power Automate ([limits](https://learn.microsoft.com/power-automate/limits-and-config#request-limits), [Logic Apps error handling](https://learn.microsoft.com/azure/logic-apps/error-exception-handling#manage-the-run-after-behavior)).

The comparison table also says what Power Automate lacks relative to Logic Apps Standard: limited versioning, basic monitoring (Application Insights by custom injection), "small to medium scale", limited regional options for continuity ([comparison](https://learn.microsoft.com/azure/logic-apps/power-automate-migration#compare-capability-details)).

### The pieces

| Concept | Meaning |
|---|---|
| Flow definition | JSON document (Workflow Definition Language): one trigger, a graph of actions linked by `runAfter`, parameters |
| Trigger | The first step: polling, push (webhook), schedule (recurrence), manual/instant (button, Power Apps, Copilot), or HTTP request |
| Action | A connector operation or a built-in (Compose, Condition, Switch, Apply to each, Do until, Scope, Initialize/Set variable, Parse JSON, Filter array, Delay, Terminate, HTTP, Response) |
| Connection | A stored, authenticated credential for one connector, owned by a user (see `connectors.md`) |
| Run | One execution: inputs and outputs of every step are recorded and shown in run history |

### Triggers: polling vs webhook

From [Optimize triggers](https://learn.microsoft.com/power-automate/guidance/coding-guidelines/optimize-power-automate-triggers#types-of-triggers) and the [custom polling trigger](https://learn.microsoft.com/connectors/custom-connectors/create-polling-trigger#learn-how-a-polling-trigger-acquires-new-data) pattern:

| | Polling | Webhook (push) |
|---|---|---|
| Mechanism | Engine calls the connector on an interval; connector returns `202 Accepted` + `Retry-After` + a `Location` header carrying opaque **trigger state** (for example a timestamp) when nothing is new, or `200` + items + new state when there is | Engine calls the service's **subscribe** endpoint with a callback URL when the flow is saved/enabled; the service POSTs to it on each event; **unsubscribe** on disable/delete ([Logic Apps trigger patterns](https://learn.microsoft.com/azure/logic-apps/logic-apps-create-api-app#trigger-patterns)) |
| Flow turned off then on | Resumes from the stored state and **processes everything missed** (possibly a flood) | Only events after re-enable are processed; events in between are **lost** |
| Reset | Copy the flow and delete the original to reset state | n/a |

Microsoft-managed polling triggers use only interval and frequency, not "at these hours" scheduling ([Logic Apps connectors](https://learn.microsoft.com/azure/connectors/introduction#triggers)). **Trigger conditions** (expressions on the trigger) filter events before a run starts and are the main way to save actions.

### Flow types

| Type | Trigger | Example |
|---|---|---|
| Automated | An event in a connector (row added, email arrived, file created) | Notify QC when an inspection fails |
| Instant | Manual: button, Power Apps, Copilot agent, Teams message action, another flow | Generate a PDF from an app |
| Scheduled | Recurrence (min 60 s, max 500 days) | Nightly overdue-invoice reminder |
| Desktop flow | RPA on a Windows machine, triggered from a cloud flow | Type data into a legacy Windows app |
| (Agent flows) | Copilot Studio-hosted flows billed in Copilot credits | See `copilot-studio.md` |

## 2. Limits that shape the design

From [Limits of automated, scheduled and instant flows](https://learn.microsoft.com/power-automate/limits-and-config):

| Limit | Value |
|---|---|
| Run duration (including waiting approvals) | 30 days; pending steps then time out |
| Run history retention | 30 days |
| Recurrence interval | 60 s to 500 days |
| Concurrency control on trigger | Off by default (unlimited parallel runs); when on 1-100 (default 25), with 10 + parallelism waiting runs; **turning it on cannot be undone** without deleting and re-adding the trigger |
| Apply to each | 5,000 items (Low profile) / 100,000; parallelism 1 (default) to 50; nested loops always sequential ([parallel execution](https://learn.microsoft.com/power-automate/guidance/coding-guidelines/implement-parallel-execution#control-concurrency)) |
| Do until | 60 iterations default, 5,000 max |
| Outbound sync request timeout | 120 s; async up to 30 days |
| Inbound request (HTTP/Power Apps trigger) | must respond within 120 s |
| Message size | 100 MB; 1 GB with chunking |
| Expression length | 131,072 characters |
| Default retry policy | Medium/High profile: up to 12 retries, exponential from ~7 s to ~1 h; Low: 2 retries; configurable up to 90 attempts, 5 s to 1 day |
| Auto-suspension | Flows failing continuously for 14 days are turned off; flows not triggered in 90 days may be turned off (except premium owners); consistently throttled flows turned off after 14 days |
| Flows per user (My flows) | 600 |
| Custom connectors | 50 per user, 500 requests/min per connection, premium licence required |
| Action burst | 100,000 actions per 5 minutes ([understand limits](https://learn.microsoft.com/power-automate/guidance/coding-guidelines/understand-limits#api-throughput-limits-on-connectors)) |

**Request (action) limits**: every trigger and action execution — including Compose, Initialize variable, retries, pagination and every loop iteration — counts as one Power Platform request. A Power Automate Premium user gets 40,000 per 24 hours across their flows; a flow with a Process licence gets 250,000 per 24 hours, stackable up to 10 licences, or shared across up to 25 flows in a *flow group*; child flows don't inherit their parent's Process capacity ([request limits](https://learn.microsoft.com/power-platform/admin/api-request-limits-allocations#request-limits-in-power-automate), [licensing FAQ](https://learn.microsoft.com/power-platform/admin/power-automate-licensing/faqs#action-limits-and-capacity-questions)). Performance profiles (Low, Medium, High, Unlimited Extended) are tied to licence types and change retry and loop limits ([performance profiles](https://learn.microsoft.com/power-automate/limits-and-config)). Connectors have their own throttles on top (SharePoint: 600 calls/min per connection), surfacing as HTTP 429.

*Inference*: a business user is expected to understand action accounting, performance profiles, licence stacking and flow groups to keep a flow running. That is the clearest single example of complexity that a small org should not have to carry.

## 3. Expressions (Workflow Definition Language)

Inputs are JSON; dynamic values are expressions inside `@{...}` or `@...`: `triggerBody()?['Title']`, `outputs('Get_row')?['body/statecode']`, `body('Parse_JSON')`, `items('Apply_to_each')`, `variables('x')`, `utcNow()`, `addDays()`, `formatDateTime()`, `concat()`, `if()`, `equals()`, `coalesce()`, `json()`, `string()`, `base64()`, `result('Scope')`, `actions('Scope')?['status']`, `workflow()`. The `?` operator is null-safe navigation ([scope status example](https://learn.microsoft.com/azure/logic-apps/logic-apps-control-flow-run-steps-group-scopes#add-a-condition-to-check-scope-status)).

*Inference*: WDL is a second formula language next to Power Fx, with different syntax (`equals(a,b)` vs `a = b`), different null semantics and different function names. Makers who learn Power Fx in apps must learn WDL in flows. Microsoft is adding Power Fx in some flow contexts, but WDL remains the native language (*unverified* how far Power Fx in cloud flows has gone; not on a fetched page).

## 4. Control flow and error handling

- **Run after**: each action lists predecessor actions and the statuses that allow it to run: Succeeded (default), Failed, Skipped, TimedOut. An unhandled failure marks the action Failed and successors Skipped; the run's status is derived from the terminal status of every branch ([Logic Apps error handling](https://learn.microsoft.com/azure/logic-apps/error-exception-handling#manage-the-run-after-behavior)).
- **Scopes** group actions; a scope gets an aggregate status, so a "Catch" scope configured to run after "Try" has failed implements try/catch; `result('Try')` returns the top-level action results inside the scope (not nested ones) so the catch can filter failed actions and log them ([scopes](https://learn.microsoft.com/azure/logic-apps/error-exception-handling#evaluate-actions-with-scopes-and-their-results), [Power Automate guidance](https://learn.microsoft.com/power-automate/guidance/coding-guidelines/error-handling#group-actions-into-scopes-for-error-handling)).
- **Retry policy** per action: none, fixed, exponential (recommended).
- **Timeout** per action as ISO 8601 duration; webhooks and approvals should always have one ([error reference](https://learn.microsoft.com/power-automate/error-reference#timeout-and-throttling-errors)).
- **Terminate** ends the run with a status.
- Long processes beyond 30 days: Microsoft recommends a "relay" — end the run and start a new one with state stored in Dataverse.

## 5. Child flows

`Run a Child Flow` calls another flow in the **same solution**. The child uses a Manually trigger (with typed inputs) or Power Apps trigger, and ends with **Respond to a Power App or flow** returning outputs. Non-Dataverse connections in the child must be **embedded** ("run only users" set to use the child's own connections). The older pattern (HTTP request trigger + URL) broke when solutions were moved between environments ([create child flows](https://learn.microsoft.com/power-automate/create-child-flows#create-the-child-flow-in-a-solution), [release note](https://learn.microsoft.com/power-platform/released-versions/flow-portal/20191007#call-child-flows)). Child flows depend internally on the HTTP connector, so DLP policies blocking HTTP can break them ([connector classification](https://learn.microsoft.com/power-platform/admin/dlp-connector-classification)).

## 6. Approvals

- Actions: **Start and wait for an approval** (create records, notify, block until complete, outputs available) vs **Create an approval** + **Wait for an approval** (non-blocking create, then wait; the create step outputs an adaptive card that can be posted to Teams) ([approval actions](https://learn.microsoft.com/troubleshoot/power-platform/power-automate/approvals/differences-between-flow-approval-actions)).
- Types: Approve/Reject – everyone must approve (completes on all approve or one reject), Approve/Reject – first to respond, Custom responses – wait for all, Custom responses – wait for one ([everyone must approve](https://learn.microsoft.com/power-automate/all-assigned-must-approve#create-the-flow)). Sequential and parallel patterns are built from multiple approval steps.
- **Storage**: approvals are Dataverse records (approval, approval request, approval response tables such as `msdyn_flow_approvalresponse`, owned by user/team) in the environment; assigning to a user outside the environment auto-grants the *Approvals User* role ([approval response table](https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/msdyn_flow_approvalresponse), [get started](https://learn.microsoft.com/power-automate/get-started-approvals#assign-approvals-to-any-user-in-your-tenant)). The first approval in a tenant can trigger creation of a Dataverse database in the default environment ([create database](https://learn.microsoft.com/power-automate/desktop-flows/create-database#create-a-dataverse-database-in-teams)). The Teams Approvals app stores templates in Dataverse and template responses in Microsoft Forms ([Teams approvals admin](https://learn.microsoft.com/microsoftteams/approval-admin#storage-with-microsoft-dataverse)).
- **Delivery**: actionable Outlook email (max five custom response buttons), Teams adaptive card, Power Automate action center, mobile app push ([custom responses](https://learn.microsoft.com/power-automate/create-approval-response-options#use-approval-responses)). "Everyone must approve" with custom responses can fail for many approvers because of a results-field size limit.
- Approvals still count against the 30-day run limit; set an expiry and a timeout branch.

## 7. Desktop flows (RPA), briefly

Power Automate for desktop records and runs UI automation on Windows. A cloud flow triggers it on a registered **machine** or machine group; the machine's `UIFlowService` connects outbound over HTTPS to Azure Relay (no inbound ports) ([desktop architecture](https://learn.microsoft.com/power-automate/desktop-flows/pad-architecture)). **Attended** runs need a premium per-user licence with attended RPA; **unattended** runs need Process capacity, create an RDP session with no user signed in, keep the screen locked, and can't run elevated ([unattended](https://learn.microsoft.com/power-automate/desktop-flows/run-unattended-desktop-flows), [manage machines](https://learn.microsoft.com/power-automate/desktop-flows/manage-machines#update-running-environment-for-your-machine)). Microsoft-hosted machines run on Windows 365 ([hosted RPA](https://learn.microsoft.com/power-automate/desktop-flows/hosted-rpa-overview)). Desktop flow runs don't consume Power Platform requests.

## 8. Process mining, briefly

Process mining analyses event logs (case id, activity, timestamp) into process maps, variants, statistics, root-cause analysis and conformance comparison; the full desktop app needs Power Automate Premium ([process mining desktop](https://learn.microsoft.com/power-automate/minit/minit-desktop-application-overview)). *Inference*: for a 30-person manufacturer, a "time between stages" report over our audit log is the useful 5% of this.

## How to replicate on our stack (single Node server + MySQL)

### Design principles

1. **One formula language**: flow expressions are our Fx (D3), not a second language. `Trigger.Row.Status = "Rejected"`, `Steps.GetCustomer.Email`, `DateAdd(Now(), 3, TimeUnit.Days)`. This requires Fx evaluation on the server (see `dataverse.md`).
2. **Durable by default**: every run and step state lives in MySQL, so a server restart resumes runs. No in-memory-only queues.
3. **Push triggers from our own data**: `DataService` already sees every insert/update/delete; table triggers are in-process events committed with the write (outbox), not polling.
4. **No action metering**. The customer owns the CPU.
5. **At-least-once with idempotency keys**, stated honestly in the docs.

### Tables

```sql
ab_flows(id, env_id, name, description, definition LONGTEXT /* JSON */, version, enabled, owner_id,
         run_as ENUM('owner','trigger_user','service'), concurrency INT NULL, created_on, modified_on)
ab_flow_versions(flow_id, version, definition, saved_by, saved_on)
ab_flow_triggers(flow_id, kind ENUM('table','schedule','manual','webhook','poll','email'), config JSON,
                 state TEXT /* poll cursor */, next_fire_at DATETIME(3), webhook_secret_hash)
ab_flow_outbox(id BIGINT AUTO_INCREMENT, table_id, row_id, event, old_values, new_values, user_id, at,
               processed TINYINT)            -- written in the same transaction as the data change
ab_flow_runs(id, flow_id, flow_version, status ENUM('queued','running','waiting','succeeded','failed','cancelled','timed_out'),
             trigger_payload JSON, started_on, ended_on, wake_at DATETIME(3) NULL, lease_owner, lease_until,
             error TEXT, correlation_id)
ab_flow_steps(run_id, step_id, attempt, status, inputs JSON, outputs JSON, error TEXT, started_on, ended_on)
ab_approvals(id, run_id, step_id, title, details, type ENUM('first','all','sequence'), status, created_by, created_on, due_on, outcome)
ab_approval_assignees(approval_id, user_id, seq, response, comment, responded_on, token_hash)
```

### Engine

- **Worker loop** inside the Node process (a `FlowEngine` service started in `services.boot()`): every 500 ms claim due runs with `UPDATE ab_flow_runs SET lease_owner=?, lease_until=NOW()+30s WHERE status IN ('queued','waiting') AND (wake_at IS NULL OR wake_at<=NOW()) AND (lease_until IS NULL OR lease_until<NOW()) ORDER BY id LIMIT 10` then select by `lease_owner`. This claim-by-update works on MySQL 5.7 and MariaDB 10.4 (D7); `SKIP LOCKED` would need MySQL 8 / MariaDB 10.6.
- **Executor** interprets the definition: steps are an ordered list with nested blocks (`if`, `switch`, `forEach` with `parallelism`, `until`, `scope` with `catch` and `finally`), plus `runAfter` overrides on any step. Each step result is persisted before moving on, so a crash resumes at the next unfinished step (steps must be idempotent or guarded by an idempotency key passed to connectors).
- **Waiting** (delay, approval, wait-for-webhook): set `status='waiting'`, `wake_at`, release the lease. Nothing occupies memory while waiting. No 30-day cap; a per-flow optional timeout instead.
- **Retries**: per step `{ attempts: 4, backoff: 'exponential', initialMs: 2000, maxMs: 600000 }`, default retry only on network errors and 429/5xx.
- **Concurrency**: per-flow `concurrency` limit enforced at claim time (count running runs of that flow). Changeable any time.
- **Table triggers**: `DataService` writes to `ab_flow_outbox` in the write transaction; the engine turns outbox rows into runs for matching enabled flows (condition evaluated in Fx with `Trigger.Row`, `Trigger.Old`, `Trigger.User`). Missed events are never lost because the outbox is durable; disabling a flow offers "skip backlog" or "process backlog" explicitly, avoiding Microsoft's polling-vs-webhook asymmetry.
- **Schedule triggers**: cron expression with time zone (default Asia/Kolkata for the pilot), `next_fire_at` computed after each fire; misfires after downtime run once, not N times.
- **Webhook triggers**: `POST /api/v1/hooks/:flowId/:secret` (secret hashed in `ab_flow_triggers`), optional HMAC verification; returns 202 immediately, or waits up to 30 s for a `Respond` step for request/response flows (our Power Apps "instant flow" equivalent).
- **Poll triggers** for external connectors (Google Sheets, IMAP mailbox, REST): stored cursor in `state`, interval >= 1 min.
- **Manual triggers**: from apps via Fx `RunFlow("Name", {inputs})` returning outputs; from the portal with a form generated from declared inputs.
- **Child flows**: `callFlow` step by flow name within the same environment; solution export carries both.
- **Run as**: owner's privileges (default), triggering user's privileges, or a service account role. All data steps go through `DataService` so RBAC/RLS/CLS apply — flows can't bypass security unless run as an admin role.

### Built-in steps (first release)

Data: get row, list rows (with our query JSON), create, update, upsert (on alternate key), delete, run SQL report (read-only, admin-only). Logic: set variable, compose (Fx), if, switch, for each, until, scope/catch, terminate, delay, delay until. People: send email (SMTP), send chat message (planned team chat), create approval / wait, notify in-app. Documents: render template to PDF/DOCX/XLSX (document library), read Excel/CSV. Integration: HTTP request, call child flow, respond, WhatsApp/SMS via a provider connector (premium for us = still bundled). AI: call LLM prompt (see `copilot-studio.md`).

### Approvals

- `ab_approvals` + assignees as above; types first-to-respond, everyone, sequential. Outcome options default Approve/Reject, custom allowed (no five-button limit in our UI; email shows up to five buttons and a link for more).
- Delivery: in-app approvals inbox in the portal (and later the chat), email with one-time signed links (`token_hash`, expiring, single use, requires sign-in for sensitive tables), optional WhatsApp template with link. Delegation (out-of-office forward) and reminders as built-in options.
- Each response is audited; the approval record links to the business row (`table_id`, `row_id`) so an app can show "pending approval by X".

### Run history and monitoring

- Run list per flow with status, duration, trigger summary; run detail showing each step's inputs/outputs (secrets redacted, large payloads truncated to 64 KB with a download link). Retention setting (default 30 days, failed runs 90 days), nightly purge.
- Health page lists failing flows; flows are **never silently auto-disabled** — instead the owner and admin get an in-app and email alert after N consecutive failures, and an admin can pause.
- Resubmit a failed run from the failed step or from the start (Microsoft has resubmit from start only — *unverified* for current state; not on a fetched page).

### APIs

`GET/POST/PUT /api/v1/flows`, `POST /flows/:id/enable|disable`, `POST /flows/:id/run` (manual), `GET /flows/:id/runs`, `GET /runs/:id`, `POST /runs/:id/cancel|resubmit`, `GET /approvals?mine=1`, `POST /approvals/:id/respond`, `POST /hooks/:flowId/:secret`.

### Designer

A vertical step list (like the modern Power Automate designer) in React, with the Fx formula bar reused for every expression, a "dynamic values" picker that inserts `Steps.X.Y`, inline test run with sample trigger data, and the run history opening the same view with results overlaid.

## Where we can be better for a 20-50 person org

| Microsoft pain point | Evidence | Better design |
|---|---|---|
| Action metering, performance profiles, licence stacking, flow groups, child flows not inheriting capacity | [Request limits](https://learn.microsoft.com/power-platform/admin/api-request-limits-allocations#request-limits-in-power-automate), [licensing FAQ](https://learn.microsoft.com/power-platform/admin/power-automate-licensing/faqs#action-limits-and-capacity-questions) | No metering. A simple health page shows runs per day and slow steps. |
| Flows auto-disabled after 14 days of failures or 90 days without triggers | [Retention limits](https://learn.microsoft.com/power-automate/limits-and-config#my-flows-limit) | Alerts, never silent disabling. |
| Polling triggers flood after re-enable; webhook triggers lose events; reset by copying the flow | [Trigger types](https://learn.microsoft.com/power-automate/guidance/coding-guidelines/optimize-power-automate-triggers#types-of-triggers) | Durable outbox for our tables; explicit "process or skip backlog" choice. |
| Duplicate executions by design (at-least-once) without platform help | [Troubleshooting](https://learn.microsoft.com/troubleshoot/power-platform/power-automate/flow-run-issues/triggers-troubleshoot#trigger-fires-for-old-events) | Same guarantee, but idempotency keys built into data steps (upsert on run id + step id). |
| 30-day run cap; relay pattern for long processes | [Error reference](https://learn.microsoft.com/power-automate/error-reference#timeout-and-throttling-errors) | Waiting runs cost nothing; no cap. |
| Trigger concurrency can't be turned off once on | [Concurrency limits](https://learn.microsoft.com/power-automate/limits-and-config#concurrency,-looping,-and-debatching-limits) | Editable setting. |
| A second expression language (WDL) next to Power Fx | [Scope status example](https://learn.microsoft.com/azure/logic-apps/logic-apps-control-flow-run-steps-group-scopes#add-a-condition-to-check-scope-status) | Fx everywhere. |
| Child flows require solutions, embedded connections, and the HTTP connector not blocked | [Child flows](https://learn.microsoft.com/power-automate/create-child-flows#create-the-child-flow-in-a-solution), [DLP note](https://learn.microsoft.com/power-platform/admin/dlp-connector-classification) | Call any flow in the environment by name. |
| Approvals need Dataverse; first use silently creates a database; responses split between Dataverse and Forms for Teams templates | [Create database](https://learn.microsoft.com/power-automate/desktop-flows/create-database#create-a-dataverse-database-in-teams), [Teams approvals](https://learn.microsoft.com/microsoftteams/approval-admin#storage-with-microsoft-dataverse) | Approvals are plain tables in our DB, linked to the business row. |
| Run history only 30 days | [Duration limits](https://learn.microsoft.com/power-automate/limits-and-config#my-flows-limit) | Configurable retention. |

**Not worth replicating**: desktop flows/RPA (a Windows RPA runtime is a product in itself; for Tally integration a small local agent with a proper API is better), process mining (do a stage-duration report instead), performance profiles, action quotas, "flow groups", per-flow licensing, the polling `202 + Location` protocol for our own tables, 1,400 connectors (pick 15 that matter in India: email, WhatsApp Business, SMS/DLT, Google, Tally agent, Razorpay, GST/e-invoice, HTTP).

**Worth copying**: trigger conditions, run-after + scope try/catch semantics, retry policies with exponential backoff, typed manual-trigger inputs and `Respond` outputs, approval types, the run-history view with per-step inputs/outputs, the "Start and wait" vs "Create + Wait" split.

## Sources

- [Choose the right integration and automation services in Azure](https://learn.microsoft.com/azure/azure-functions/functions-compare-logic-apps-ms-flow-webjobs)
- [Power Automate migration to Azure Logic Apps (Standard)](https://learn.microsoft.com/azure/logic-apps/power-automate-migration)
- [What is Azure Logic Apps?](https://learn.microsoft.com/azure/logic-apps/logic-apps-overview)
- [Connectors in Azure Logic Apps (triggers)](https://learn.microsoft.com/azure/connectors/introduction)
- [Logic Apps custom API trigger patterns](https://learn.microsoft.com/azure/logic-apps/logic-apps-create-api-app)
- [Handle workflow errors and exceptions in Azure Logic Apps](https://learn.microsoft.com/azure/logic-apps/error-exception-handling)
- [Group actions into scopes](https://learn.microsoft.com/azure/logic-apps/logic-apps-control-flow-run-steps-group-scopes)
- [Limits of automated, scheduled, and instant flows](https://learn.microsoft.com/power-automate/limits-and-config)
- [Understand platform limits and avoid throttling](https://learn.microsoft.com/power-automate/guidance/coding-guidelines/understand-limits)
- [Optimize Power Automate triggers](https://learn.microsoft.com/power-automate/guidance/coding-guidelines/optimize-power-automate-triggers)
- [Troubleshoot trigger problems](https://learn.microsoft.com/troubleshoot/power-platform/power-automate/flow-run-issues/triggers-troubleshoot)
- [Use a custom polling trigger](https://learn.microsoft.com/connectors/custom-connectors/create-polling-trigger)
- [Implement parallel execution](https://learn.microsoft.com/power-automate/guidance/coding-guidelines/implement-parallel-execution)
- [Employ robust error handling](https://learn.microsoft.com/power-automate/guidance/coding-guidelines/error-handling)
- [Cloud flow error code reference](https://learn.microsoft.com/power-automate/error-reference)
- [Requests limits and allocations](https://learn.microsoft.com/power-platform/admin/api-request-limits-allocations)
- [Power Automate licensing FAQ](https://learn.microsoft.com/power-platform/admin/power-automate-licensing/faqs)
- [Create child flows](https://learn.microsoft.com/power-automate/create-child-flows)
- [Release 20191007: Call child flows](https://learn.microsoft.com/power-platform/released-versions/flow-portal/20191007)
- [Connector classification (HTTP and child flows)](https://learn.microsoft.com/power-platform/admin/dlp-connector-classification)
- [Differences between flow approval actions](https://learn.microsoft.com/troubleshoot/power-platform/power-automate/approvals/differences-between-flow-approval-actions)
- [Get started with approvals](https://learn.microsoft.com/power-automate/get-started-approvals)
- [Everyone must approve](https://learn.microsoft.com/power-automate/all-assigned-must-approve)
- [Custom approval responses](https://learn.microsoft.com/power-automate/create-approval-response-options)
- [Approval Response table reference](https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/msdyn_flow_approvalresponse)
- [Manage the Approvals app in Teams](https://learn.microsoft.com/microsoftteams/approval-admin)
- [Create a Dataverse database (via Teams approvals)](https://learn.microsoft.com/power-automate/desktop-flows/create-database)
- [Power Automate for desktop architecture](https://learn.microsoft.com/power-automate/desktop-flows/pad-architecture)
- [Run unattended desktop flows](https://learn.microsoft.com/power-automate/desktop-flows/run-unattended-desktop-flows)
- [Manage machines](https://learn.microsoft.com/power-automate/desktop-flows/manage-machines)
- [Hosted RPA](https://learn.microsoft.com/power-automate/desktop-flows/hosted-rpa-overview)
- [Process Mining desktop app overview](https://learn.microsoft.com/power-automate/minit/minit-desktop-application-overview)
