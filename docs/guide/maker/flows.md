# Flows

A **flow** does work for you when something happens: a row is added or changed, a time comes round, someone presses a
button in an app, or another system sends a web request. It runs **steps**: check a condition, change data, ask someone to
approve, wait, send a message, call another system, run another flow. Flows run on the server, so they keep going when
nobody has an app open, and every run is recorded with what each step got and gave back.

Flows need the Appbuilder server; demo mode (everything in your browser) has none. Open them in **Dev mode > Flows**.
Today a flow is written as a JSON definition on that page; a visual designer replaces the editor later, and everything
below stays the same. Every trigger and step kind with its fields: [reference/flows.md](../../reference/flows.md).

## Parts of a flow

| Part | What it is |
| --- | --- |
| Name, description | Unique in the environment |
| Trigger | When a run starts (one per flow) |
| Steps | What a run does, in order; some steps hold steps of their own (condition, switch, for each, do until, scope) |
| Variables | Values steps can change while the run goes on (`Variables.Total`) |
| Run as | Whose rights the steps use: the owner (default), the person who triggered the run, or a service account (an administrator decides) |
| Connections | The connections the steps may use, under a short name (`"erp": <connection>`) |
| Settings | Concurrency, time limit, how long runs are kept, what a failure does |

A flow is **off** until you turn it on. Saving makes a new **version**; you can look at old versions and restore one.

## Triggers

* **When a row is created, changed or deleted** (`table`): pick the table and the operations; for changes, optionally the
  columns that matter; optionally a **condition** such as `Trigger.Record.Amount > 50000 && Trigger.Old.Status <> "Submitted"`.
  Every matching change starts one run: none is lost and none is started twice.
* **On a schedule** (`schedule`): a cron expression like `30 8 * * 1-5` (08:30 on weekdays) or every N minutes, in a time
  zone such as `Asia/Kolkata`. One run per slot.
* **Run by a person or an app** (`manual`): with typed inputs (text, number, yes/no, date, choice, record, table). Start it
  with **Run now** on the Flows page, or from an app with `RunFlow("Quote", {Qty: 2})`. With
  `RunFlow("Quote", {Qty: 2}, {Wait: true, Result: "Answer"})` the flow's **Respond** step puts its answer in the global
  variable `Answer` (wait at most 30 seconds).
* **When a web request arrives** (`webhook`): another system posts to the flow's web address (set up under the flow's
  webhooks, see [webhooks](webhooks.md)).

## Steps

| Kind | Use it to |
| --- | --- |
| Condition, Switch | Take one path or another |
| For each, Do until | Repeat steps for each item, or until something is true |
| Scope | Group steps; with "run after failed" on a later step it becomes try/catch |
| Set variable, Compose | Keep a value for later steps |
| Get a row, List rows, Create, Update, Delete a row | Read and change data (with the run-as identity's rights) |
| Approval | Ask people and wait for their answer (as long as it takes; with a time limit if you want) |
| Delay | Wait some minutes or until a time |
| Notify, Send an email | Tell people |
| HTTP request, Connector action | Call another system through a connection |
| Run a child flow | Reuse a flow; its Respond step is the answer |
| Terminate, Respond | End the run now; answer the caller |
| Wait for a callback | Wait until another system posts to a one-time address |

## Formulas in flows

Fields of steps are formulas, the same language as in apps. A formula sees:

* `Trigger`: what started the run. Table trigger: `Trigger.Record` (the row after the change), `Trigger.Old` (before),
  `Trigger.Operation`, `Trigger.ChangedColumns`, `Trigger.User`. Schedule: `Trigger.ScheduledTime`. Manual:
  `Trigger.Inputs.<input>`. Web request: `Trigger.Body`, `Trigger.Query`, `Trigger.Headers`.
* `Steps.<StepName>.Output` (and `.Status`, `.Error`): what an earlier step gave back.
* `Variables.<Name>`, `Flow.RunId`, `Flow.Name`, `User()` (whose rights the run uses).
* Inside a **For each**, the current item by the name you gave it (`as`), and `ThisItem`.
* Tables, for reads the database can answer: `LookUp(Customers, id = Trigger.Record.Customer)`,
  `CountRows(Filter(Orders, Status = "Open"))`. A whole table on its own is refused (it would read every row).

Examples:

```
"Order " & Trigger.Record.Ref & " needs approval"                      // Compose
Trigger.Record.Amount > 50000 && Steps.Manager.Output.Outcome = "Approve" // Condition
Filter(Orders, Customer = Trigger.Record.Customer && Status = "Open")     // List rows filter: Status = "Open" && ...
DateAdd(Now(), 2, "days")                                                 // Delay until
{Total: Variables.Total, Lines: CountRows(Steps.Lines.Output)}            // Respond
```

Formulas only calculate: to change data use a data step, to tell people a Notify step. The editor checks every formula
when you save and names the step and the field of each problem ("step Log, values.Amount: Orders has no column Amount").

## Run after, errors and retries

By default a step runs when the step before it succeeded. **Run after** changes that: a step can run after another step
failed, was skipped or timed out. Put the risky steps in a **Scope** named `Try` and add a step after it with run after
`Try` = failed or timed out: it runs only when something in `Try` went wrong, and the run then counts as succeeded.

Steps that call other systems try again on their own when the failure looks temporary (a dropped connection, a busy
server): 4 attempts with growing waits; data steps 3 attempts on temporary database errors. Change it per step
(`retry: { type: "fixed", count: 5, intervalSeconds: 30 }`, or `none`). A failure that cannot get better (no permission, a
missing row, a bad formula) fails at once.

`settings.onError: "continue"` lets later steps run after a failure without run-after settings; the run still shows as
failed.

## Run history

The **Runs** tab of a flow lists its runs, newest first, live: status, what started it, how long it took, the error. Open a
run to see each step with its status, attempts, inputs and outputs (passwords, tokens and Authorization headers are never
shown or stored), and what it waits for. From there you can **cancel** a run that is running or waiting, **run it again**
from the start, or **from the failed step** (the steps that succeeded are not repeated). People who started a run without
owning the flow see its status, not its data.

**Test run**: with a sample trigger (a manual flow: its inputs; a table flow: `{"Record": {...}, "Operation": "create"}`)
the editor runs the flow as written; data changes, messages, HTTP calls and approvals are **simulated** and reported,
reads are real. Test runs are marked and do not count in the flow's health.

The list shows each flow's health over the last 7 days: success rate, last run, average duration. When a flow fails you get
a notification; further failures that day come as one summary the next morning. A failing flow is never switched off on
its own.

## Good to know

* **Who the flow acts as.** A flow that runs as its owner uses the owner's rights, also when someone else starts it (only
  people whose role you allow under **Who may run it**). A flow that runs as the triggering user can do only what that
  person could do by hand. Changing it asks you to confirm.
* **A flow does not trigger itself.** Changes a flow makes do not start that flow again (unless its settings say
  `triggerOnOwnChanges: true`, then at most 3 times per record), so a flow that updates the row it was triggered by does not
  loop.
* **One at a time.** `concurrency: "perRecord"` runs one run per record at a time, in the order of the changes;
  `"singleton"` one run of the flow at a time. With `coalesce: true` on a table trigger, changes that arrive while a run of
  the record is still waiting to start are folded into it.
* **Waiting costs nothing.** An approval can wait a week; the server can restart in between.
* **Solutions.** Add flows to a solution like apps and tables. In another environment they arrive turned off, and the import
  asks which connection there replaces each connection the flows use ([solutions](solutions.md)).
