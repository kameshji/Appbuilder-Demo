/**
 * Flows (P1 package A): the flow definition, run and step shapes, limits and the catalogue of trigger types and step
 * kinds. Shared by the server (server/core/flows/**), the Flows page (src/flows/**) and the reference generator
 * (scripts/docs/flows.ts). Pure: no React, no DOM, no Node APIs, erasable TypeScript only.
 *
 * Contract: docs/plan/p1-spec.md ("Fixed contracts"). Additive refinements made here are listed in docs/dev/flows.md
 * ("Refinements of the P1 contract").
 */

/** a formula (Fx) evaluated on the server; a leading '=' is optional */
export type Fx = string

/* ------------------------------------------------------------------ triggers */

/** restore: rows that come back from a table's recycle bin (opt-in per trigger; off by default) */
export type TableOperation = 'create' | 'update' | 'delete' | 'restore'

export type InputType = 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'choice' | 'record' | 'table'
export interface InputDef {
  name: string
  type: InputType
  required?: boolean
  description?: string
  /** choice inputs */
  choices?: string[]
  /** used when the caller leaves it out (JSON value of the type) */
  default?: unknown
}

export type Trigger =
  | {
      type: 'table'
      /** table name (or id) */
      table: string
      on: TableOperation[]
      /** update only: run only when one of these columns changed */
      columns?: string[]
      /** evaluated on the after-image (Trigger.Record) with Trigger.Old available; true starts a run */
      condition?: Fx
      /** refinement: while a run for the same record is still queued, later changes update it instead of adding runs */
      coalesce?: boolean
    }
  | { type: 'schedule'; cron?: string; everyMinutes?: number; timeZone: string }
  | { type: 'manual'; inputs: InputDef[]; from: 'app' | 'record' | 'any' }
  | { type: 'webhook'; secretRef?: string }
  /** P1-C: an approval request was decided (approved, rejected, a custom answer, expired or cancelled); policy: only requests of that policy (name or id); outcomes: only these statuses */
  | { type: 'approvalDecided'; policy?: string; statuses?: ('approved' | 'rejected' | 'completed' | 'expired' | 'cancelled')[] }
  | { type: 'formSubmitted' }

export type TriggerType = Trigger['type']

/* ------------------------------------------------------------------ steps */

export type RunAfterStatus = 'succeeded' | 'failed' | 'skipped' | 'timedOut'
export interface RunAfter { step: string; when: RunAfterStatus[] }

export interface RetryPolicy {
  type: 'none' | 'fixed' | 'exponential'
  /** attempts in all, the first one included (1..10) */
  count?: number
  /** fixed: the wait between attempts; exponential: the first wait (doubles), seconds */
  intervalSeconds?: number
  /** exponential: the longest wait, seconds */
  maxIntervalSeconds?: number
}

export interface StepBase {
  /** unique within the flow: letters, digits, _ (referenced by runAfter) */
  id: string
  /** unique within the flow, identifier-safe: expressions read Steps.<name>.Output */
  name: string
  description?: string
  runAfter?: RunAfter[]
  retry?: RetryPolicy
  /** external calls: abort after this long; waits (approval, delay, callback): the outcome becomes timedOut */
  timeoutMinutes?: number
}

export type Step = StepBase & StepConfig

export type StepConfig =
  | { kind: 'condition'; if: Fx; then: Step[]; else?: Step[] }
  | { kind: 'switch'; on: Fx; cases: { value: unknown; steps: Step[] }[]; default?: Step[] }
  | { kind: 'forEach'; items: Fx; as: string; steps: Step[]; concurrency?: number; max?: number }
  | { kind: 'until'; condition: Fx; steps: Step[]; maxIterations: number; timeoutMinutes?: number }
  | { kind: 'scope'; steps: Step[] }
  | { kind: 'setVariable'; variable: string; value: Fx }
  | { kind: 'compose'; value: Fx }
  | { kind: 'data.get'; table: string; rowId: Fx; failIfMissing?: boolean }
  | { kind: 'data.list'; table: string; filter?: Fx; sort?: { column: string; descending?: boolean }[]; top?: number; select?: string[] }
  /** owner (P3): one person or team (Fx) the new row belongs to; the run-as identity itself or its team, or anyone for an administrator's flow */
  | { kind: 'data.create'; table: string; values: Record<string, Fx>; owner?: Fx }
  | { kind: 'data.update'; table: string; rowId: Fx; values: Record<string, Fx> }
  | { kind: 'data.delete'; table: string; rowId: Fx }
  /** requester (P3): one more person (Fx) the request is on behalf of; the person who caused the run always is */
  | ({ kind: 'approval'; title: Fx; details?: Fx; approvers?: Fx; type?: 'single' | 'all' | 'any' | 'sequential' | 'quorum'; options?: string[]; regarding?: { table: string; rowId: Fx }; requester?: Fx }
      // P1-C refinements (src/platform/approvals.ts ApprovalStepConfig): policy, fields, quorum, stages, due, reminders, escalation ...
      & Omit<import('./approvals.ts').ApprovalStepConfig, 'title' | 'details' | 'approvers' | 'type' | 'options' | 'regarding' | 'timeoutMinutes'>)
  | { kind: 'delay'; minutes?: number; until?: Fx }
  /** roles, teams (P3): role and team ids (or names) whose active members are notified when the step runs; `to` is then optional */
  | { kind: 'notify'; to?: Fx; roles?: string[]; teams?: string[]; title: Fx; body: Fx; link?: Fx; channels: ('inApp' | 'email')[] }
  | { kind: 'email'; to: Fx; cc?: Fx; subject: Fx; body: Fx; attachments?: Fx; connection?: string }
  /** P2-B: a document from a print template; output: the file only (a token), stored in an attachment column of the record, or in the record's Documents */
  | { kind: 'document.generate'; template: string; record?: Fx; output?: 'file' | 'record' | 'documents'; column?: string; numberSequence?: string }
  | { kind: 'action'; connection: string; action: string; inputs: Record<string, Fx> }
  | { kind: 'http'; method: string; url: Fx; headers?: Record<string, Fx>; body?: Fx; auth?: string }
  | { kind: 'callFlow'; flow: string; inputs?: Record<string, Fx> }
  | { kind: 'terminate'; status: 'succeeded' | 'failed' | 'cancelled'; message?: Fx }
  | { kind: 'respond'; body: Fx; status?: number }
  | { kind: 'waitForCallback'; timeoutMinutes?: number }

export type StepKind = StepConfig['kind']

export interface VariableDef { name: string; type: 'text' | 'number' | 'boolean' | 'date' | 'record' | 'table' | 'any'; initial?: unknown }

export interface FlowSettings {
  concurrency: 'parallel' | 'singleton' | 'perRecord'
  timeoutMinutes: number
  retentionDays: number
  onError: 'fail' | 'continue'
  /** refinement: table triggers fire for changes this flow made itself (default false: they do not) */
  triggerOnOwnChanges?: boolean
  /** refinement: at most this many runs start per minute (more wait for the next minute; nothing is dropped) */
  maxRunsPerMinute?: number
}

export type RunAs = 'owner' | 'triggeringUser' | { serviceAccount: string }

/** what the JSON editor and the designer edit (ab_flows.definition plus the name, description and runAs) */
export interface FlowDefinition {
  trigger: Trigger
  steps: Step[]
  variables?: VariableDef[]
  settings: FlowSettings
}

export interface FlowConnectionRef {
  /** the name steps use (`connection: "<ref>"`) */
  ref: string
  connectionId: string
  connectionName?: string
  connector?: string
  grantedBy?: string
  grantedOn?: string
}

export interface FlowDef extends FlowDefinition {
  id: string
  name: string
  description?: string
  enabled: boolean
  version: number
  solutionId?: string
  runAs: RunAs
  ownerId: string
  ownerName?: string
  connections: FlowConnectionRef[]
  /** set when the flow cannot run (its owner was disabled ...): runs fail until a maker fixes it */
  suspended?: string
  createdOn: string
  modifiedOn: string
  modifiedBy?: string
}

export interface FlowHealth {
  runs7d: number
  succeeded7d: number
  failed7d: number
  /** 0..1, null without finished runs */
  successRate: number | null
  lastRunOn: string | null
  lastStatus: RunStatus | null
  avgDurationMs: number | null
}

export interface FlowListItem extends Omit<FlowDef, 'steps' | 'variables'> { stepCount: number; health: FlowHealth; canEdit: boolean; canRun: boolean }

export interface FlowVersionInfo { version: number; savedBy: string | null; savedByName?: string; savedOn: string; note?: string }

/* ------------------------------------------------------------------ runs */

export type RunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'timedOut'
export type StepStatus = 'running' | 'waiting' | 'succeeded' | 'failed' | 'skipped' | 'timedOut' | 'cancelled'
export const TERMINAL_RUN: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled', 'timedOut']
export const TERMINAL_STEP: readonly StepStatus[] = ['succeeded', 'failed', 'skipped', 'timedOut', 'cancelled']

export interface FlowRunInfo {
  id: string
  flowId: string
  flowName: string
  flowVersion: number
  status: RunStatus
  mode: 'normal' | 'test'
  /** test runs: data and side-effect steps were simulated (dryRun) */
  dryRun?: boolean
  triggerKind: TriggerType | 'callFlow' | 'resubmit'
  /** a short text: "Orders r_12 updated", "manual by Asha" */
  triggerSummary?: string
  runAs: string
  runAsName?: string
  triggeredBy?: string
  correlationId: string
  createdOn: string
  startedOn?: string
  finishedOn?: string
  durationMs?: number
  error?: { message: string; step?: string }
  response?: unknown
  parentRunId?: string
  resubmittedFrom?: string
  regarding?: { tableId: string; rowId: string }
}

export interface FlowStepRun {
  /** path of the step execution: /<id>, /<loop>#<i>/<id>, /<cond>.then/<id> ... */
  key: string
  stepId: string
  name: string
  kind: StepKind | 'iteration'
  scope: string
  status: StepStatus
  attempt: number
  input?: unknown
  output?: unknown
  error?: { message: string; code?: string; permanent?: boolean }
  startedOn: string
  finishedOn?: string
  durationMs?: number
  /** inputs/outputs larger than the display cap were cut */
  truncated?: boolean
  simulated?: boolean
}

export interface FlowRunDetail extends FlowRunInfo { trigger: unknown; variables: Record<string, unknown>; steps: FlowStepRun[]; waits: FlowWaitInfo[] }

export interface FlowWaitInfo { id: string; stepKey: string; kind: 'delay' | 'approval' | 'callFlow' | 'callback'; state: 'waiting' | 'resumed' | 'cancelled' | 'timedOut'; wakeAt?: string; timeoutAt?: string; approvalId?: string; childRunId?: string; createdOn: string }

export interface ValidationProblem {
  /** step id ('' for the flow, 'trigger' for the trigger) */
  step: string
  /** the field of the step or flow: "if", "values.Amount", "runAfter", "trigger.condition" */
  field: string
  message: string
  severity: 'error' | 'warning'
  start?: number
  end?: number
}

/* ------------------------------------------------------------------ limits */

export const FLOW_LIMITS = {
  /** step executions of one run (loop iterations count every step inside) */
  stepsPerRun: 5000,
  /** items of one forEach / iterations of one until */
  loopIterations: 5000,
  /** parallel iterations of a forEach */
  forEachConcurrency: 20,
  /** steps in one definition (all levels) */
  stepsPerFlow: 250,
  /** nesting of containers */
  nesting: 8,
  /** the trigger payload of a run, bytes */
  triggerPayloadBytes: 256 * 1024,
  /** one step's output, bytes (larger: the step fails) */
  stepOutputBytes: 1024 * 1024,
  /** what the run detail shows of one input or output, bytes */
  displayBytes: 64 * 1024,
  /** callFlow depth */
  callDepth: 8,
  /** a table trigger: rows of one bulk change that start runs */
  fanOut: 1000,
  /** default and maximum runs per minute of one flow */
  runsPerMinute: 600,
  /** runs per minute of the whole environment */
  environmentRunsPerMinute: 6000,
  /** "Wait" of RunFlow and POST /flows/:id/run: at most */
  respondWaitSeconds: 30,
  /** a run of the flow (settings.timeoutMinutes): default and maximum (30 days) */
  runTimeoutMinutes: 7 * 24 * 60,
  runTimeoutMinutesMax: 30 * 24 * 60,
  retentionDaysDefault: 30,
} as const

export const DEFAULT_SETTINGS: FlowSettings = { concurrency: 'parallel', timeoutMinutes: FLOW_LIMITS.runTimeoutMinutes, retentionDays: FLOW_LIMITS.retentionDaysDefault, onError: 'fail' }

/* ------------------------------------------------------------------ catalogue (reference docs, designer palette) */

export interface FieldDoc { name: string; type: string; required?: boolean; doc: string }

export interface StepKindDoc {
  kind: StepKind
  group: 'Control' | 'Data' | 'People' | 'Integration' | 'Run'
  title: string
  summary: string
  fields: FieldDoc[]
  output: string
  /** delivery guarantee (docs/dev/flows.md) */
  guarantee: string
  container?: boolean
  suspends?: boolean
  /** default retry when the step has none */
  defaultRetry: string
  example: Record<string, unknown>
}

const ALWAYS = 'Runs inside the engine; its result is stored with the step row in one transaction (effectively once).'

export const STEP_KINDS: readonly StepKindDoc[] = [
  {
    kind: 'condition', group: 'Control', title: 'Condition', summary: 'Runs the "then" steps when the formula is true, else the "else" steps.',
    fields: [{ name: 'if', type: 'Fx (boolean)', required: true, doc: 'The test.' }, { name: 'then', type: 'Step[]', required: true, doc: 'Steps when true.' }, { name: 'else', type: 'Step[]', doc: 'Steps when false.' }],
    output: '{ Result: boolean, Branch: "then" | "else" }', guarantee: ALWAYS, container: true, defaultRetry: 'none',
    example: { id: 'big', name: 'IsBig', kind: 'condition', if: 'Trigger.Record.Amount > 50000', then: [], else: [] },
  },
  {
    kind: 'switch', group: 'Control', title: 'Switch', summary: 'Runs the steps of the first case whose value equals the formula, else the default steps.',
    fields: [{ name: 'on', type: 'Fx', required: true, doc: 'The value to compare.' }, { name: 'cases', type: '{ value, steps }[]', required: true, doc: 'Compared in order with =.' }, { name: 'default', type: 'Step[]', doc: 'When no case matches.' }],
    output: '{ Value, Case: index or "default" }', guarantee: ALWAYS, container: true, defaultRetry: 'none',
    example: { id: 'sw', name: 'ByRegion', kind: 'switch', on: 'Trigger.Record.Region', cases: [{ value: 'North', steps: [] }], default: [] },
  },
  {
    kind: 'forEach', group: 'Control', title: 'For each', summary: 'Runs its steps once per item of a table, one after another or a few at a time.',
    fields: [{ name: 'items', type: 'Fx (table)', required: true, doc: 'The items (evaluated once, when the loop starts).' }, { name: 'as', type: 'name', required: true, doc: 'The name of the current item inside the loop (also ThisItem).' }, { name: 'steps', type: 'Step[]', required: true, doc: 'The loop body.' }, { name: 'concurrency', type: 'number', doc: '1 (default, in order) to 20 iterations at once. setVariable is not allowed inside a parallel loop.' }, { name: 'max', type: 'number', doc: 'Most items (default and cap 5000); more fail the step.' }],
    output: '{ Count, Succeeded, Failed }', guarantee: ALWAYS + ' Each iteration is its own container; a failed iteration fails the loop after all iterations ended.', container: true, defaultRetry: 'none',
    example: { id: 'each', name: 'EachLine', kind: 'forEach', items: 'Steps.Lines.Output', as: 'Line', steps: [] },
  },
  {
    kind: 'until', group: 'Control', title: 'Do until', summary: 'Runs its steps, then repeats until the condition is true (checked after each pass).',
    fields: [{ name: 'condition', type: 'Fx (boolean)', required: true, doc: 'Stops when true.' }, { name: 'steps', type: 'Step[]', required: true, doc: 'The loop body.' }, { name: 'maxIterations', type: 'number', required: true, doc: '1..5000; reaching it without the condition fails the step.' }, { name: 'timeoutMinutes', type: 'number', doc: 'Time limit of the whole loop (outcome timedOut).' }],
    output: '{ Iterations }', guarantee: ALWAYS, container: true, defaultRetry: 'none',
    example: { id: 'poll', name: 'PollUntilDone', kind: 'until', condition: 'Steps.Check.Output.Status = "done"', maxIterations: 10, steps: [] },
  },
  {
    kind: 'scope', group: 'Control', title: 'Scope', summary: 'Groups steps. With runAfter on the scope (failed, timedOut) a later step becomes its "catch".',
    fields: [{ name: 'steps', type: 'Step[]', required: true, doc: 'The grouped steps.' }],
    output: '{ Status }', guarantee: ALWAYS + ' The scope fails when one of its steps failed or timed out and no later step inside it handled that outcome.', container: true, defaultRetry: 'none',
    example: { id: 'try', name: 'Try', kind: 'scope', steps: [] },
  },
  {
    kind: 'setVariable', group: 'Control', title: 'Set variable', summary: 'Sets a flow variable (declared in variables) to the value of a formula.',
    fields: [{ name: 'variable', type: 'name', required: true, doc: 'A declared variable (the step\'s own name is its step name).' }, { name: 'value', type: 'Fx', required: true, doc: 'The new value.' }],
    output: 'the new value', guarantee: ALWAYS, defaultRetry: 'none',
    example: { id: 'sv', name: 'SetTotal', kind: 'setVariable', variable: 'Total', value: 'Variables.Total + Line.Amount' },
  },
  {
    kind: 'compose', group: 'Control', title: 'Compose', summary: 'Calculates a value once so later steps can use it as Steps.<name>.Output.',
    fields: [{ name: 'value', type: 'Fx', required: true, doc: 'Any value: text, number, record, table.' }],
    output: 'the value', guarantee: ALWAYS, defaultRetry: 'none',
    example: { id: 'msg', name: 'Message', kind: 'compose', value: '"Order " & Trigger.Record.Number & " was approved"' },
  },
  {
    kind: 'data.get', group: 'Data', title: 'Get a row', summary: 'Reads one row by id, as the run-as identity (row and column security apply).',
    fields: [{ name: 'table', type: 'table name', required: true, doc: 'The table.' }, { name: 'rowId', type: 'Fx', required: true, doc: 'The row id, or a record read earlier (its id is used).' }, { name: 'failIfMissing', type: 'boolean', doc: 'Default true; false returns blank.' }],
    output: 'the row (record)', guarantee: 'A read: retried freely.', defaultRetry: 'transient database errors: 3 attempts',
    example: { id: 'cust', name: 'Customer', kind: 'data.get', table: 'Customers', rowId: 'Trigger.Record.Customer' },
  },
  {
    kind: 'data.list', group: 'Data', title: 'List rows', summary: 'Reads rows that match a delegable filter, sorted, at most `top` rows.',
    fields: [{ name: 'table', type: 'table name', required: true, doc: 'The table.' }, { name: 'filter', type: 'Fx (boolean, row scope)', doc: 'Column names refer to the rows; must be delegable.' }, { name: 'sort', type: '{ column, descending? }[]', doc: 'Sort order.' }, { name: 'top', type: 'number', doc: 'Default 100, at most 5000.' }, { name: 'select', type: 'string[]', doc: 'Columns to return (default all readable).' }],
    output: 'table of rows', guarantee: 'A read: retried freely.', defaultRetry: 'transient database errors: 3 attempts',
    example: { id: 'open', name: 'OpenOrders', kind: 'data.list', table: 'Orders', filter: 'Status = "Open" && Customer = Trigger.Record.Customer', sort: [{ column: 'createdOn', descending: true }], top: 50 },
  },
  {
    kind: 'data.create', group: 'Data', title: 'Create a row', summary: 'Adds a row as the run-as identity: security, WITH CHECK, validation, table events and the outbox apply.',
    fields: [{ name: 'table', type: 'table name', required: true, doc: 'The table.' }, { name: 'values', type: '{ column: Fx }', required: true, doc: 'Column values.' }, { name: 'owner', type: 'Fx (one person or team)', doc: 'Who the new row belongs to (default: the run-as identity), for example Trigger.User: the person whose change started the run. Allowed: the run-as identity itself or a team of its own; a flow of an administrator: any active person, or a team on a table with team ownership.' }],
    output: 'the new row', guarantee: 'Default database: the row, its outbox entry and the step result commit in one transaction (exactly once). Other connections: at least once, deduplicated by a stable row id derived from run and step.', defaultRetry: 'transient database errors: 3 attempts',
    example: { id: 'log', name: 'AddLog', kind: 'data.create', table: 'ApprovalLog', values: { Order: 'Trigger.Record.id', Outcome: 'Steps.Approve.Output.Outcome' } },
  },
  {
    kind: 'data.update', group: 'Data', title: 'Update a row', summary: 'Changes columns of a row as the run-as identity.',
    fields: [{ name: 'table', type: 'table name', required: true, doc: 'The table.' }, { name: 'rowId', type: 'Fx', required: true, doc: 'The row id, or a record read earlier.' }, { name: 'values', type: '{ column: Fx }', required: true, doc: 'Columns to change.' }],
    output: 'the row after the change', guarantee: 'Default database: change and step result in one transaction (exactly once). Other connections: at least once (setting the same values again is harmless).', defaultRetry: 'transient database errors: 3 attempts',
    example: { id: 'upd', name: 'MarkApproved', kind: 'data.update', table: 'PurchaseRequests', rowId: 'Trigger.Record.id', values: { Status: '"Approved"' } },
  },
  {
    kind: 'data.delete', group: 'Data', title: 'Delete a row', summary: 'Deletes a row as the run-as identity. A row that is already gone counts as deleted.',
    fields: [{ name: 'table', type: 'table name', required: true, doc: 'The table.' }, { name: 'rowId', type: 'Fx', required: true, doc: 'The row id, or a record read earlier.' }],
    output: '{ Deleted: true }', guarantee: 'Default database: exactly once. Other connections: at least once (idempotent).', defaultRetry: 'transient database errors: 3 attempts',
    example: { id: 'del', name: 'RemoveDraft', kind: 'data.delete', table: 'Drafts', rowId: 'Steps.Draft.Output.id' },
  },
  {
    kind: 'approval', group: 'People', title: 'Start and wait for an approval', summary: 'Asks people to approve; the run waits (costing nothing) until they answer or the timeout passes.',
    fields: [{ name: 'title', type: 'Fx (text)', required: true, doc: 'What to decide.' }, { name: 'details', type: 'Fx (text)', doc: 'More text, shown to every approver.' }, { name: 'approvers', type: 'Fx', required: true, doc: 'Emails, user ids, role:<name>, team:<code>, manager, manager-chain:<n>, department-head, or a table of people (optional with a policy).' }, { name: 'type', type: '"single" | "any" | "all" | "quorum" | "sequential"', doc: 'Default single.' }, { name: 'options', type: 'string[]', doc: 'Default Approve, Reject; "Need more info" returns the request to the requester.' }, { name: 'regarding', type: '{ table, rowId: Fx }', doc: 'The record the approval is about.' }, { name: 'policy', type: 'text', doc: 'An approval policy (name or id): approvers, stages, thresholds, reminders, escalation.' }, { name: 'fields', type: 'Record<label, Fx>', doc: 'Fields shown to approvers (also to those who cannot open the record); threshold rules read them.' }, { name: 'requester', type: 'Fx (one person)', doc: 'One more person the request is on behalf of (for example Trigger.Record.owner). Always on behalf of the person whose change or button press started the run: they, the identity of the flow and this person are never asked (unless allowSelfApproval), and manager references and the fallback start from this person (else from the triggering person).' }, { name: 'quorum', type: 'number', doc: 'type quorum: how many must approve.' }, { name: 'stages', type: '{ name?, approvers, mode?, quorum?, condition? }[]', doc: 'type sequential: the stages.' }, { name: 'dueMinutes', type: 'number', doc: 'Due this long after the request; reminders and escalation count from it.' }, { name: 'reminders', type: '{ afterMinutes, everyMinutes?, max? }', doc: 'Reminders to those still to answer.' }, { name: 'escalation', type: '{ action, afterMinutes?, to? }', doc: 'manager, user, nextStage, approve, reject or expire after the due date.' }, { name: 'timeoutMinutes', type: 'number', doc: 'Outcome timedOut after this long (use runAfter timedOut to escalate in the flow).' }],
    output: '{ Outcome, Status, Responses, Approvers, ApprovalId, CompletedOn, Comments }', guarantee: 'The request is made once per step execution (idempotency key run:step); the answer resumes the run once (the wait row changes state once).', suspends: true, defaultRetry: 'creating the request: transient errors, 3 attempts',
    example: { id: 'mgr', name: 'ManagerApproval', kind: 'approval', title: '"Purchase " & Trigger.Record.Title', approvers: 'Trigger.Record.Manager', timeoutMinutes: 2880 },
  },
  {
    kind: 'delay', group: 'Run', title: 'Delay', summary: 'Waits some minutes, or until a point in time. Nothing runs (or is held in memory) while it waits.',
    fields: [{ name: 'minutes', type: 'number', doc: 'How long.' }, { name: 'until', type: 'Fx (date and time)', doc: 'Or until when.' }],
    output: '{ ResumedOn }', guarantee: 'Resumes once (the wait row changes state once), also across restarts.', suspends: true, defaultRetry: 'none',
    example: { id: 'wait', name: 'WaitADay', kind: 'delay', minutes: 1440 },
  },
  {
    kind: 'notify', group: 'People', title: 'Notify', summary: 'Sends an in-app notification (the bell) and, when asked, an email to people.',
    fields: [{ name: 'to', type: 'Fx', doc: 'Email, user id, team:<id>, or a table of them (optional with roles or teams).' }, { name: 'roles', type: 'role ids or names[]', doc: 'Everyone who holds one of these roles when the step runs (active people only); a role with nobody in it is not an error.' }, { name: 'teams', type: 'team ids[]', doc: 'The members of these teams when the step runs.' }, { name: 'title', type: 'Fx', required: true, doc: 'Title.' }, { name: 'body', type: 'Fx', required: true, doc: 'Text.' }, { name: 'link', type: 'Fx', doc: 'A link inside Appbuilder (#...).' }, { name: 'channels', type: '("inApp" | "email")[]', required: true, doc: 'Where to send it.' }],
    output: '{ Delivered, Skipped }', guarantee: 'At least once: after a crash between sending and recording, the notification may be sent twice.', defaultRetry: 'transient errors, 3 attempts',
    example: { id: 'n', name: 'TellRequester', kind: 'notify', to: 'Trigger.Record.createdBy', title: '"Your request was approved"', body: '""', channels: ['inApp'] },
  },
  {
    kind: 'email', group: 'People', title: 'Send an email', summary: 'Sends an email through an email connection (the environment\'s mail connection when none is named).',
    fields: [{ name: 'to', type: 'Fx', required: true, doc: 'Addresses or users.' }, { name: 'cc', type: 'Fx', doc: 'Copies.' }, { name: 'subject', type: 'Fx', required: true, doc: 'Subject.' }, { name: 'body', type: 'Fx', required: true, doc: 'Text or HTML.' }, { name: 'attachments', type: 'Fx', doc: 'Attachment ids.' }, { name: 'connection', type: 'connection reference', doc: 'Refinement: which email connection.' }],
    output: 'what the email action returns', guarantee: 'At least once, with the idempotency key run:step:attempt-free (the actions service replays a stored result instead of sending again).', defaultRetry: 'exponential, 4 attempts, on retryable errors',
    example: { id: 'mail', name: 'MailRequester', kind: 'email', to: 'Trigger.Record.RequesterEmail', subject: '"Approved"', body: '"Your purchase was approved."' },
  },
  {
    kind: 'document.generate', group: 'Data', title: 'Generate a document', summary: 'Makes a PDF (or Word file) from a print template as the run-as identity: for a record, or from the template\'s own query. Keep it as a file (attach it to an email with {fileToken: Steps.<name>.Output.FileToken}), put it in a file column of the record, or store it in the record\'s Documents.',
    fields: [{ name: 'template', type: 'text', required: true, doc: 'The print template (name or id); its published version is used.' }, { name: 'record', type: 'Fx', doc: 'The record id (templates with a record source), e.g. Trigger.Record.id.' }, { name: 'output', type: 'file | record | documents', doc: 'file (default): only the generated file; record: into the file column `column` of the record; documents: a Documents entry about the record.' }, { name: 'column', type: 'text', doc: 'output record: the file column.' }, { name: 'numberSequence', type: 'text', doc: 'output documents: the number sequence that numbers the document.' }],
    output: '{ FileToken, FileName, Pages, Warnings, AttachmentId?, DocumentId? }', guarantee: 'At least once: a retry makes the same file again under the same token (key run:step); a retry after the record was changed adds the file again.', defaultRetry: 'none',
    example: { id: 'pdf', name: 'DailyPdf', kind: 'document.generate', template: 'Daily production and OEE summary', output: 'file' },
  },
  {
    kind: 'action', group: 'Integration', title: 'Connector action', summary: 'Calls an action of a connection attached to the flow.',
    fields: [{ name: 'connection', type: 'connection reference', required: true, doc: 'A connection attached to the flow.' }, { name: 'action', type: 'action id', required: true, doc: 'The action.' }, { name: 'inputs', type: '{ name: Fx }', required: true, doc: 'Inputs, checked against the action\'s schema.' }],
    output: 'the action\'s output', guarantee: 'At least once with an idempotency key; non-idempotent actions are deduplicated by the actions service (stored result for 24 h).', defaultRetry: 'exponential, 4 attempts, on retryable errors',
    example: { id: 'post', name: 'PostToErp', kind: 'action', connection: 'erp', action: 'createOrder', inputs: { number: 'Trigger.Record.Number' } },
  },
  {
    kind: 'http', group: 'Integration', title: 'HTTP request', summary: 'Calls a web address through an HTTP connection (its allowed hosts and outbound policy apply).',
    fields: [{ name: 'method', type: 'GET | POST | PUT | PATCH | DELETE', required: true, doc: 'Method.' }, { name: 'url', type: 'Fx', required: true, doc: 'Address.' }, { name: 'headers', type: '{ name: Fx }', doc: 'Headers (Authorization is never stored in the run history).' }, { name: 'body', type: 'Fx', doc: 'Body (records become JSON).' }, { name: 'auth', type: 'connection reference', required: true, doc: 'The HTTP connection.' }],
    output: '{ Status, Headers, Body }', guarantee: 'At least once with an idempotency key (sent as Idempotency-Key for POST/PATCH).', defaultRetry: 'exponential, 4 attempts, on retryable errors',
    example: { id: 'h', name: 'CallApi', kind: 'http', method: 'POST', url: '"https://api.example.com/orders"', body: '{number: Trigger.Record.Number}', auth: 'api' },
  },
  {
    kind: 'callFlow', group: 'Run', title: 'Run a child flow', summary: 'Starts another flow of the environment (manual trigger) and waits for it; its respond step is the output.',
    fields: [{ name: 'flow', type: 'flow name or id', required: true, doc: 'The child flow.' }, { name: 'inputs', type: '{ name: Fx }', doc: 'Its inputs.' }],
    output: '{ Status, Outputs, RunId }', guarantee: 'The child run is created once per step execution (in the step\'s transaction); its end resumes the parent once.', suspends: true, defaultRetry: 'none',
    example: { id: 'child', name: 'CreateInvoice', kind: 'callFlow', flow: 'Create invoice', inputs: { Order: 'Trigger.Record.id' } },
  },
  {
    kind: 'terminate', group: 'Run', title: 'Terminate', summary: 'Ends the run now with a status and message.',
    fields: [{ name: 'status', type: '"succeeded" | "failed" | "cancelled"', required: true, doc: 'The run\'s status.' }, { name: 'message', type: 'Fx', doc: 'Why.' }],
    output: '-', guarantee: ALWAYS, defaultRetry: 'none',
    example: { id: 'stop', name: 'Stop', kind: 'terminate', status: 'cancelled', message: '"Nothing to do"' },
  },
  {
    kind: 'respond', group: 'Run', title: 'Respond', summary: 'Refinement: the answer of the run to the caller (RunFlow with Wait, POST /flows/:id/run with wait, a parent flow\'s callFlow). The run continues.',
    fields: [{ name: 'body', type: 'Fx', required: true, doc: 'The response.' }, { name: 'status', type: 'number', doc: 'For webhooks: the HTTP status (default 200).' }],
    output: 'the body', guarantee: ALWAYS + ' The first respond of a run wins.', defaultRetry: 'none',
    example: { id: 'r', name: 'Answer', kind: 'respond', body: '{Total: Variables.Total}' },
  },
  {
    kind: 'waitForCallback', group: 'Integration', title: 'Wait for a callback', summary: 'Refinement: makes a one-time callback address and waits until something posts to it.',
    fields: [{ name: 'timeoutMinutes', type: 'number', doc: 'Outcome timedOut after this long.' }],
    output: '{ Url (while waiting), Body, ReceivedOn }', guarantee: 'The first POST to the address resumes the run once; later ones answer 409.', suspends: true, defaultRetry: 'none',
    example: { id: 'cb', name: 'WaitForSignature', kind: 'waitForCallback', timeoutMinutes: 10080 },
  },
]

export interface TriggerTypeDoc { type: TriggerType; title: string; summary: string; fields: FieldDoc[]; scope: string; guarantee: string; reserved?: boolean }

export const TRIGGER_TYPES: readonly TriggerTypeDoc[] = [
  {
    type: 'table', title: 'When a row is created, changed or deleted', summary: 'Starts a run for each matching change of a table, read from the outbox (no change is lost).',
    fields: [{ name: 'table', type: 'table name', required: true, doc: 'The table.' }, { name: 'on', type: '("create" | "update" | "delete")[]', required: true, doc: 'Which changes.' }, { name: 'columns', type: 'string[]', doc: 'Updates only when one of these changed.' }, { name: 'condition', type: 'Fx (boolean)', doc: 'On the after-image; Trigger.Old is the row before.' }, { name: 'coalesce', type: 'boolean', doc: 'Later changes of a record update its queued run.' }],
    scope: 'Trigger.Record, Trigger.Old, Trigger.Operation, Trigger.ChangedColumns, Trigger.Table, Trigger.User',
    guarantee: 'Exactly one run per matching change and row (the run is created in the outbox dispatcher\'s transaction, keyed by outbox id and row).',
  },
  {
    type: 'schedule', title: 'On a schedule', summary: 'Starts a run per slot of a cron expression or every N minutes, in a time zone.',
    fields: [{ name: 'cron', type: 'text', doc: 'Five fields, e.g. "30 8 * * 1-5".' }, { name: 'everyMinutes', type: 'number', doc: 'Or every N minutes (at least 1).' }, { name: 'timeZone', type: 'IANA name', required: true, doc: 'e.g. Asia/Kolkata.' }],
    scope: 'Trigger.ScheduledTime', guarantee: 'Exactly one run per slot (also across restarts and with two servers). Armed only while the flow is enabled.',
  },
  {
    type: 'manual', title: 'Run by a person or an app', summary: 'Started with "Run now", POST /flows/:id/run or RunFlow("name", {inputs}) in an app.',
    fields: [{ name: 'inputs', type: 'InputDef[]', required: true, doc: 'Typed inputs (text, number, boolean, date, datetime, choice, record, table).' }, { name: 'from', type: '"app" | "record" | "any"', required: true, doc: 'Where it may be started.' }],
    scope: 'Trigger.Inputs, Trigger.User', guarantee: 'One run per call (a client-chosen run id makes the call idempotent).',
  },
  {
    type: 'webhook', title: 'When a web request arrives', summary: 'Started by a signed HTTP request to the flow\'s webhook address (package D verifies it).',
    fields: [{ name: 'secretRef', type: 'text', doc: 'Which signing secret (managed with the webhook).' }],
    scope: 'Trigger.Body, Trigger.Query, Trigger.Headers, Trigger.ReceivedOn', guarantee: 'One run per delivery id.',
  },
  {
    type: 'approvalDecided', title: 'When an approval is decided', summary: 'Starts a run when an approval request ends: approved, rejected, a custom answer, expired or cancelled (P1-C).',
    fields: [{ name: 'policy', type: 'text', doc: 'Only requests of this approval policy (name or id).' }, { name: 'statuses', type: '("approved" | "rejected" | "completed" | "expired" | "cancelled")[]', doc: 'Only these endings (default all).' }],
    scope: 'Trigger.Request (Id, Title, Status, Outcome, RequestedBy, Policy, RegardingTable, RegardingId, CompletedOn, Fields), Trigger.Responses', guarantee: 'One run per decided request and flow (trigger key appr:<flow>:<request>).',
  },
  { type: 'formSubmitted', title: 'When a form is submitted (reserved)', summary: 'Reserved for a later release.', fields: [], scope: '-', guarantee: '-', reserved: true },
]

export const CONTAINER_KINDS: readonly StepKind[] = ['condition', 'switch', 'forEach', 'until', 'scope']
export const isContainer = (k: string): boolean => (CONTAINER_KINDS as readonly string[]).includes(k)

/** the child step lists of a step (containers), with the suffix of their container path */
export function childLists(s: Step): { suffix: string; steps: Step[] }[] {
  switch (s.kind) {
    case 'condition': return [{ suffix: '.then', steps: s.then ?? [] }, { suffix: '.else', steps: s.else ?? [] }]
    case 'switch': return [...(s.cases ?? []).map((c, i) => ({ suffix: `.case${i}`, steps: c.steps ?? [] })), { suffix: '.default', steps: s.default ?? [] }]
    case 'forEach': case 'until': return [{ suffix: '#', steps: s.steps ?? [] }]
    case 'scope': return [{ suffix: '', steps: s.steps ?? [] }]
    default: return []
  }
}

/** every step of a definition, depth first, with its parent step id ('' at the top) */
export function allSteps(steps: Step[], parent = '', out: { step: Step; parent: string; depth: number }[] = [], depth = 0): { step: Step; parent: string; depth: number }[] {
  for (const s of steps ?? []) {
    out.push({ step: s, parent, depth })
    for (const l of childLists(s)) allSteps(l.steps, s.id, out, depth + 1)
  }
  return out
}
