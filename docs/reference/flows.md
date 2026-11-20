<!-- GENERATED FILE. Do not edit by hand: change the code (or the hand-written parts in scripts/docs/) and run `npm run docs:gen`. -->

# Flows reference: triggers and steps

What each trigger type and step kind of a flow takes, what it gives to later steps (`Steps.<name>.Output`) and how often its effect happens when a server stops in the middle. Concepts and examples: [the maker guide](../guide/maker/flows.md); design: [docs/dev/flows.md](../dev/flows.md).

Every step also takes `id`, `name`, `description`, `runAfter` (`[{ step, when: ["succeeded" | "failed" | "skipped" | "timedOut"] }]`), `retry` (`{ type: "none" | "fixed" | "exponential", count, intervalSeconds, maxIntervalSeconds }`) and `timeoutMinutes`.

## Contents

- [Triggers](#triggers)
  - [When a row is created, changed or deleted](#when-a-row-is-created-changed-or-deleted)
  - [On a schedule](#on-a-schedule)
  - [Run by a person or an app](#run-by-a-person-or-an-app)
  - [When a web request arrives](#when-a-web-request-arrives)
  - [When an approval is decided](#when-an-approval-is-decided)
  - [When a form is submitted](#when-a-form-is-submitted)
- [Steps](#steps)
  - [Condition](#condition)
  - [Switch](#switch)
  - [For each](#for-each)
  - [Do until](#do-until)
  - [Scope](#scope)
  - [Set variable](#set-variable)
  - [Compose](#compose)
  - [Get a row](#get-a-row)
  - [List rows](#list-rows)
  - [Create a row](#create-a-row)
  - [Update a row](#update-a-row)
  - [Delete a row](#delete-a-row)
  - [Start and wait for an approval](#start-and-wait-for-an-approval)
  - [Delay](#delay)
  - [Notify](#notify)
  - [Send an email](#send-an-email)
  - [Generate a document](#generate-a-document)
  - [Connector action](#connector-action)
  - [HTTP request](#http-request)
  - [Run a child flow](#run-a-child-flow)
  - [Terminate](#terminate)
  - [Respond](#respond)
  - [Wait for a callback](#wait-for-a-callback)
- [Limits](#limits)

## Triggers

### When a row is created, changed or deleted

`type: "table"`. Starts a run for each matching change of a table, read from the outbox (no change is lost).

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `table` | table name | yes | The table. |
| `on` | ("create" \| "update" \| "delete")[] | yes | Which changes. |
| `columns` | string[] |  | Updates only when one of these changed. |
| `condition` | Fx (boolean) |  | On the after-image; Trigger.Old is the row before. |
| `coalesce` | boolean |  | Later changes of a record update its queued run. |

**Expressions see:** Trigger.Record, Trigger.Old, Trigger.Operation, Trigger.ChangedColumns, Trigger.Table, Trigger.User

**Guarantee:** Exactly one run per matching change and row (the run is created in the outbox dispatcher's transaction, keyed by outbox id and row).

### On a schedule

`type: "schedule"`. Starts a run per slot of a cron expression or every N minutes, in a time zone.

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `cron` | text |  | Five fields, e.g. "30 8 * * 1-5". |
| `everyMinutes` | number |  | Or every N minutes (at least 1). |
| `timeZone` | IANA name | yes | e.g. Asia/Kolkata. |

**Expressions see:** Trigger.ScheduledTime

**Guarantee:** Exactly one run per slot (also across restarts and with two servers). Armed only while the flow is enabled.

### Run by a person or an app

`type: "manual"`. Started with "Run now", POST /flows/:id/run or RunFlow("name", {inputs}) in an app.

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `inputs` | InputDef[] | yes | Typed inputs (text, number, boolean, date, datetime, choice, record, table). |
| `from` | "app" \| "record" \| "any" | yes | Where it may be started. |

**Expressions see:** Trigger.Inputs, Trigger.User

**Guarantee:** One run per call (a client-chosen run id makes the call idempotent).

### When a web request arrives

`type: "webhook"`. Started by a signed HTTP request to the flow's webhook address (package D verifies it).

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `secretRef` | text |  | Which signing secret (managed with the webhook). |

**Expressions see:** Trigger.Body, Trigger.Query, Trigger.Headers, Trigger.ReceivedOn

**Guarantee:** One run per delivery id.

### When an approval is decided

`type: "approvalDecided"`. Starts a run when an approval request ends: approved, rejected, a custom answer, expired or cancelled (P1-C).

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `policy` | text |  | Only requests of this approval policy (name or id). |
| `statuses` | ("approved" \| "rejected" \| "completed" \| "expired" \| "cancelled")[] |  | Only these endings (default all). |

**Expressions see:** Trigger.Request (Id, Title, Status, Outcome, RequestedBy, Policy, RegardingTable, RegardingId, CompletedOn, Fields), Trigger.Responses

**Guarantee:** One run per decided request and flow (trigger key appr:<flow>:<request>).

### When a form is submitted

`type: "formSubmitted"`. Starts a run when a person submits a Form of an app and the row is saved; the run acts for that person (P3-D).

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `app` | text | yes | The app (its name or id). |
| `form` | text | yes | The name of the Form UI component in the app. |
| `on` | ("create" \| "update")[] |  | New rows and / or edited rows (default both). |

**Expressions see:** Trigger.Record (the saved row), Trigger.Operation ("create" or "update"), Trigger.Table, Trigger.App, Trigger.Screen, Trigger.Form, Trigger.User (the submitter), Trigger.SubmittedOn

**Guarantee:** One run per submit and flow, also when the submit was saved offline and sent later (trigger key form:<flow>:<submitter>:<idempotency key>). Started only from a row write the server committed for that person, never from a bare claim.

## Steps

### Condition

`kind: "condition"` (Control, container). Runs the "then" steps when the formula is true, else the "else" steps.

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `if` | Fx (boolean) | yes | The test. |
| `then` | Step[] | yes | Steps when true. |
| `else` | Step[] |  | Steps when false. |

**Output:** { Result: boolean, Branch: "then" \| "else" }

**Guarantee:** Runs inside the engine; its result is stored with the step row in one transaction (effectively once).

**Default retry:** none

```json
{"id":"big","name":"IsBig","kind":"condition","if":"Trigger.Record.Amount > 50000","then":[],"else":[]}
```

### Switch

`kind: "switch"` (Control, container). Runs the steps of the first case whose value equals the formula, else the default steps.

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `on` | Fx | yes | The value to compare. |
| `cases` | { value, steps }[] | yes | Compared in order with =. |
| `default` | Step[] |  | When no case matches. |

**Output:** { Value, Case: index or "default" }

**Guarantee:** Runs inside the engine; its result is stored with the step row in one transaction (effectively once).

**Default retry:** none

```json
{"id":"sw","name":"ByRegion","kind":"switch","on":"Trigger.Record.Region","cases":[{"value":"North","steps":[]}],"default":[]}
```

### For each

`kind: "forEach"` (Control, container). Runs its steps once per item of a table, one after another or a few at a time.

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `items` | Fx (table) | yes | The items (evaluated once, when the loop starts). |
| `as` | name | yes | The name of the current item inside the loop (also ThisItem). |
| `steps` | Step[] | yes | The loop body. |
| `concurrency` | number |  | 1 (default, in order) to 20 iterations at once. setVariable is not allowed inside a parallel loop. |
| `max` | number |  | Most items (default and cap 5000); more fail the step. |

**Output:** { Count, Succeeded, Failed }

**Guarantee:** Runs inside the engine; its result is stored with the step row in one transaction (effectively once). Each iteration is its own container; a failed iteration fails the loop after all iterations ended.

**Default retry:** none

```json
{"id":"each","name":"EachLine","kind":"forEach","items":"Steps.Lines.Output","as":"Line","steps":[]}
```

### Do until

`kind: "until"` (Control, container). Runs its steps, then repeats until the condition is true (checked after each pass).

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `condition` | Fx (boolean) | yes | Stops when true. |
| `steps` | Step[] | yes | The loop body. |
| `maxIterations` | number | yes | 1..5000; reaching it without the condition fails the step. |
| `timeoutMinutes` | number |  | Time limit of the whole loop (outcome timedOut). |

**Output:** { Iterations }

**Guarantee:** Runs inside the engine; its result is stored with the step row in one transaction (effectively once).

**Default retry:** none

```json
{"id":"poll","name":"PollUntilDone","kind":"until","condition":"Steps.Check.Output.Status = \"done\"","maxIterations":10,"steps":[]}
```

### Scope

`kind: "scope"` (Control, container). Groups steps. With runAfter on the scope (failed, timedOut) a later step becomes its "catch".

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `steps` | Step[] | yes | The grouped steps. |

**Output:** { Status }

**Guarantee:** Runs inside the engine; its result is stored with the step row in one transaction (effectively once). The scope fails when one of its steps failed or timed out and no later step inside it handled that outcome.

**Default retry:** none

```json
{"id":"try","name":"Try","kind":"scope","steps":[]}
```

### Set variable

`kind: "setVariable"` (Control). Sets a flow variable (declared in variables) to the value of a formula.

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `variable` | name | yes | A declared variable (the step's own name is its step name). |
| `value` | Fx | yes | The new value. |

**Output:** the new value

**Guarantee:** Runs inside the engine; its result is stored with the step row in one transaction (effectively once).

**Default retry:** none

```json
{"id":"sv","name":"SetTotal","kind":"setVariable","variable":"Total","value":"Variables.Total + Line.Amount"}
```

### Compose

`kind: "compose"` (Control). Calculates a value once so later steps can use it as Steps.<name>.Output.

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `value` | Fx | yes | Any value: text, number, record, table. |

**Output:** the value

**Guarantee:** Runs inside the engine; its result is stored with the step row in one transaction (effectively once).

**Default retry:** none

```json
{"id":"msg","name":"Message","kind":"compose","value":"\"Order \" & Trigger.Record.Number & \" was approved\""}
```

### Get a row

`kind: "data.get"` (Data). Reads one row by id, as the run-as identity (row and column security apply).

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `table` | table name | yes | The table. |
| `rowId` | Fx | yes | The row id, or a record read earlier (its id is used). |
| `failIfMissing` | boolean |  | Default true; false returns blank. |

**Output:** the row (record)

**Guarantee:** A read: retried freely.

**Default retry:** transient database errors: 3 attempts

```json
{"id":"cust","name":"Customer","kind":"data.get","table":"Customers","rowId":"Trigger.Record.Customer"}
```

### List rows

`kind: "data.list"` (Data). Reads rows that match a delegable filter, sorted, at most `top` rows.

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `table` | table name | yes | The table. |
| `filter` | Fx (boolean, row scope) |  | Column names refer to the rows; must be delegable. |
| `sort` | { column, descending? }[] |  | Sort order. |
| `top` | number |  | Default 100, at most 5000. |
| `select` | string[] |  | Columns to return (default all readable). |

**Output:** table of rows

**Guarantee:** A read: retried freely.

**Default retry:** transient database errors: 3 attempts

```json
{"id":"open","name":"OpenOrders","kind":"data.list","table":"Orders","filter":"Status = \"Open\" && Customer = Trigger.Record.Customer","sort":[{"column":"createdOn","descending":true}],"top":50}
```

### Create a row

`kind: "data.create"` (Data). Adds a row as the run-as identity: security, WITH CHECK, validation, table events and the outbox apply.

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `table` | table name | yes | The table. |
| `values` | { column: Fx } | yes | Column values. |
| `owner` | Fx (one person or team) |  | Who the new row belongs to (default: the run-as identity), for example Trigger.User: the person whose change started the run. Allowed: the run-as identity itself or a team of its own; a flow of an administrator: any active person, or a team on a table with team ownership. |

**Output:** the new row

**Guarantee:** Default database: the row, its outbox entry and the step result commit in one transaction (exactly once). Other connections: at least once, deduplicated by a stable row id derived from run and step.

**Default retry:** transient database errors: 3 attempts

```json
{"id":"log","name":"AddLog","kind":"data.create","table":"ApprovalLog","values":{"Order":"Trigger.Record.id","Outcome":"Steps.Approve.Output.Outcome"}}
```

### Update a row

`kind: "data.update"` (Data). Changes columns of a row as the run-as identity.

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `table` | table name | yes | The table. |
| `rowId` | Fx | yes | The row id, or a record read earlier. |
| `values` | { column: Fx } | yes | Columns to change. |

**Output:** the row after the change

**Guarantee:** Default database: change and step result in one transaction (exactly once). Other connections: at least once (setting the same values again is harmless).

**Default retry:** transient database errors: 3 attempts

```json
{"id":"upd","name":"MarkApproved","kind":"data.update","table":"PurchaseRequests","rowId":"Trigger.Record.id","values":{"Status":"\"Approved\""}}
```

### Delete a row

`kind: "data.delete"` (Data). Deletes a row as the run-as identity. A row that is already gone counts as deleted.

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `table` | table name | yes | The table. |
| `rowId` | Fx | yes | The row id, or a record read earlier. |

**Output:** { Deleted: true }

**Guarantee:** Default database: exactly once. Other connections: at least once (idempotent).

**Default retry:** transient database errors: 3 attempts

```json
{"id":"del","name":"RemoveDraft","kind":"data.delete","table":"Drafts","rowId":"Steps.Draft.Output.id"}
```

### Generate a document

`kind: "document.generate"` (Data). Makes a PDF (or Word file) from a print template as the run-as identity: for a record, or from the template's own query. Keep it as a file (attach it to an email with {fileToken: Steps.<name>.Output.FileToken}), put it in a file column of the record, or store it in the record's Documents.

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `template` | text | yes | The print template (name or id); its published version is used. |
| `record` | Fx |  | The record id (templates with a record source), e.g. Trigger.Record.id. |
| `output` | file \| record \| documents |  | file (default): only the generated file; record: into the file column `column` of the record; documents: a Documents entry about the record. |
| `column` | text |  | output record: the file column. |
| `numberSequence` | text |  | output documents: the number sequence that numbers the document. |

**Output:** { FileToken, FileName, Pages, Warnings, AttachmentId?, DocumentId? }

**Guarantee:** At least once: a retry makes the same file again under the same token (key run:step); a retry after the record was changed adds the file again.

**Default retry:** none

```json
{"id":"pdf","name":"DailyPdf","kind":"document.generate","template":"Daily production and OEE summary","output":"file"}
```

### Start and wait for an approval

`kind: "approval"` (People, waits). Asks people to approve; the run waits (costing nothing) until they answer or the timeout passes.

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `title` | Fx (text) | yes | What to decide. |
| `details` | Fx (text) |  | More text, shown to every approver. |
| `approvers` | Fx | yes | Emails, user ids, role:<name>, team:<code>, manager, manager-chain:<n>, department-head, or a table of people (optional with a policy). |
| `type` | "single" \| "any" \| "all" \| "quorum" \| "sequential" |  | Default single. |
| `options` | string[] |  | Default Approve, Reject; "Need more info" returns the request to the requester. |
| `regarding` | { table, rowId: Fx } |  | The record the approval is about. |
| `policy` | text |  | An approval policy (name or id): approvers, stages, thresholds, reminders, escalation. |
| `fields` | Record<label, Fx> |  | Fields shown to approvers (also to those who cannot open the record); threshold rules read them. |
| `requester` | Fx (one person) |  | One more person the request is on behalf of (for example Trigger.Record.owner). Always on behalf of the person whose change or button press started the run: they, the identity of the flow and this person are never asked (unless allowSelfApproval), and manager references and the fallback start from this person (else from the triggering person). |
| `quorum` | number |  | type quorum: how many must approve. |
| `stages` | { name?, approvers, mode?, quorum?, condition? }[] |  | type sequential: the stages. |
| `dueMinutes` | number |  | Due this long after the request; reminders and escalation count from it. |
| `reminders` | { afterMinutes, everyMinutes?, max? } |  | Reminders to those still to answer. |
| `escalation` | { action, afterMinutes?, to? } |  | manager, user, nextStage, approve, reject or expire after the due date. |
| `timeoutMinutes` | number |  | Outcome timedOut after this long (use runAfter timedOut to escalate in the flow). |

**Output:** { Outcome, Status, Responses, Approvers, ApprovalId, CompletedOn, Comments }

**Guarantee:** The request is made once per step execution (idempotency key run:step); the answer resumes the run once (the wait row changes state once).

**Default retry:** creating the request: transient errors, 3 attempts

```json
{"id":"mgr","name":"ManagerApproval","kind":"approval","title":"\"Purchase \" & Trigger.Record.Title","approvers":"Trigger.Record.Manager","timeoutMinutes":2880}
```

### Notify

`kind: "notify"` (People). Sends an in-app notification (the bell) and, when asked, an email to people.

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `to` | Fx |  | Email, user id, team:<id>, or a table of them (optional with roles or teams). |
| `roles` | role ids or names[] |  | Everyone who holds one of these roles when the step runs (active people only); a role with nobody in it is not an error. |
| `teams` | team ids[] |  | The members of these teams when the step runs. |
| `title` | Fx | yes | Title. |
| `body` | Fx | yes | Text. |
| `link` | Fx |  | A link inside Appbuilder (#...). |
| `channels` | ("inApp" \| "email")[] | yes | Where to send it. |

**Output:** { Delivered, Skipped }

**Guarantee:** At least once: after a crash between sending and recording, the notification may be sent twice.

**Default retry:** transient errors, 3 attempts

```json
{"id":"n","name":"TellRequester","kind":"notify","to":"Trigger.Record.createdBy","title":"\"Your request was approved\"","body":"\"\"","channels":["inApp"]}
```

### Send an email

`kind: "email"` (People). Sends an email through an email connection (the environment's mail connection when none is named).

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `to` | Fx | yes | Addresses or users. |
| `cc` | Fx |  | Copies. |
| `subject` | Fx | yes | Subject. |
| `body` | Fx | yes | Text or HTML. |
| `attachments` | Fx |  | Attachment ids. |
| `connection` | connection reference |  | Refinement: which email connection. |

**Output:** what the email action returns

**Guarantee:** At least once, with the idempotency key run:step:attempt-free (the actions service replays a stored result instead of sending again).

**Default retry:** exponential, 4 attempts, on retryable errors

```json
{"id":"mail","name":"MailRequester","kind":"email","to":"Trigger.Record.RequesterEmail","subject":"\"Approved\"","body":"\"Your purchase was approved.\""}
```

### Connector action

`kind: "action"` (Integration). Calls an action of a connection attached to the flow.

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `connection` | connection reference | yes | A connection attached to the flow. |
| `action` | action id | yes | The action. |
| `inputs` | { name: Fx } | yes | Inputs, checked against the action's schema. |

**Output:** the action's output

**Guarantee:** At least once with an idempotency key; non-idempotent actions are deduplicated by the actions service (stored result for 24 h).

**Default retry:** exponential, 4 attempts, on retryable errors

```json
{"id":"post","name":"PostToErp","kind":"action","connection":"erp","action":"createOrder","inputs":{"number":"Trigger.Record.Number"}}
```

### HTTP request

`kind: "http"` (Integration). Calls a web address through an HTTP connection (its allowed hosts and outbound policy apply).

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `method` | GET \| POST \| PUT \| PATCH \| DELETE | yes | Method. |
| `url` | Fx | yes | Address. |
| `headers` | { name: Fx } |  | Headers (Authorization is never stored in the run history). |
| `body` | Fx |  | Body (records become JSON). |
| `auth` | connection reference | yes | The HTTP connection. |

**Output:** { Status, Headers, Body }

**Guarantee:** At least once with an idempotency key (sent as Idempotency-Key for POST/PATCH).

**Default retry:** exponential, 4 attempts, on retryable errors

```json
{"id":"h","name":"CallApi","kind":"http","method":"POST","url":"\"https://api.example.com/orders\"","body":"{number: Trigger.Record.Number}","auth":"api"}
```

### Wait for a callback

`kind: "waitForCallback"` (Integration, waits). Refinement: makes a one-time callback address and waits until something posts to it.

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `timeoutMinutes` | number |  | Outcome timedOut after this long. |

**Output:** { Url (while waiting), Body, ReceivedOn }

**Guarantee:** The first POST to the address resumes the run once; later ones answer 409.

**Default retry:** none

```json
{"id":"cb","name":"WaitForSignature","kind":"waitForCallback","timeoutMinutes":10080}
```

### Delay

`kind: "delay"` (Run, waits). Waits some minutes, or until a point in time. Nothing runs (or is held in memory) while it waits.

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `minutes` | number |  | How long. |
| `until` | Fx (date and time) |  | Or until when. |

**Output:** { ResumedOn }

**Guarantee:** Resumes once (the wait row changes state once), also across restarts.

**Default retry:** none

```json
{"id":"wait","name":"WaitADay","kind":"delay","minutes":1440}
```

### Run a child flow

`kind: "callFlow"` (Run, waits). Starts another flow of the environment (manual trigger) and waits for it; its respond step is the output.

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `flow` | flow name or id | yes | The child flow. |
| `inputs` | { name: Fx } |  | Its inputs. |

**Output:** { Status, Outputs, RunId }

**Guarantee:** The child run is created once per step execution (in the step's transaction); its end resumes the parent once.

**Default retry:** none

```json
{"id":"child","name":"CreateInvoice","kind":"callFlow","flow":"Create invoice","inputs":{"Order":"Trigger.Record.id"}}
```

### Terminate

`kind: "terminate"` (Run). Ends the run now with a status and message.

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `status` | "succeeded" \| "failed" \| "cancelled" | yes | The run's status. |
| `message` | Fx |  | Why. |

**Output:** -

**Guarantee:** Runs inside the engine; its result is stored with the step row in one transaction (effectively once).

**Default retry:** none

```json
{"id":"stop","name":"Stop","kind":"terminate","status":"cancelled","message":"\"Nothing to do\""}
```

### Respond

`kind: "respond"` (Run). Refinement: the answer of the run to the caller (RunFlow with Wait, POST /flows/:id/run with wait, a parent flow's callFlow). The run continues.

| Field | Type | Required | What it is |
| --- | --- | --- | --- |
| `body` | Fx | yes | The response. |
| `status` | number |  | For webhooks: the HTTP status (default 200). |

**Output:** the body

**Guarantee:** Runs inside the engine; its result is stored with the step row in one transaction (effectively once). The first respond of a run wins.

**Default retry:** none

```json
{"id":"r","name":"Answer","kind":"respond","body":"{Total: Variables.Total}"}
```

## Limits

| Limit | Value |
| --- | --- |
| `stepsPerRun` | 5000 |
| `loopIterations` | 5000 |
| `forEachConcurrency` | 20 |
| `stepsPerFlow` | 250 |
| `nesting` | 8 |
| `triggerPayloadBytes` | 262144 |
| `stepOutputBytes` | 1048576 |
| `displayBytes` | 65536 |
| `callDepth` | 8 |
| `fanOut` | 1000 |
| `runsPerMinute` | 600 |
| `environmentRunsPerMinute` | 6000 |
| `respondWaitSeconds` | 30 |
| `runTimeoutMinutes` | 10080 |
| `runTimeoutMinutesMax` | 43200 |
| `retentionDaysDefault` | 30 |
