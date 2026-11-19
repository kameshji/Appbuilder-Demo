/**
 * Interfaces between the flow runtime (P1 package A) and the packages around it. Additive changes only.
 *
 *  - Approvals (package C) implements ApprovalsService and sets it with `services.flows.setApprovals(impl)`. The flow
 *    runtime calls request() when an approval step starts (inside the step's transaction: C's rows commit with the
 *    step) and cancel() when the run is cancelled or the step times out. When the approval is decided, C calls
 *    `services.flows.resumeWait(env, waitId, outcome)` (idempotent: the first call wins, later ones answer
 *    { resumed: false }).
 *  - Connector actions and webhooks (package D): `services.actions` (server/core/actions/contracts.ts) runs the action,
 *    http and email steps; D's webhook route calls `services.flows.triggerWebhook(env, flowId, payload)`
 *    (FlowWebhookTarget of D's contracts).
 *  - The designer (package B) uses the HTTP API of docs/dev/data-api.md ("Flows") and the shared types in
 *    src/platform/flows.ts; `POST /flows/validate` returns the problems with step id and field.
 */
import type { UserContext } from '../contracts.ts'
import type { FlowWebhookTarget, VerifiedWebhookPayload } from '../actions/contracts.ts'

export interface ApprovalRequest {
  environmentId: string
  runId: string
  flowId: string
  flowName: string
  /** the step execution (path) that waits */
  stepKey: string
  stepName: string
  /** pass it back to resumeWait */
  waitId: string
  title: string
  details?: string
  /** user ids, emails or `team:<id or code>`; resolved by C */
  approvers: string[]
  type: 'single' | 'all' | 'any' | 'sequential'
  /** answer options; default ['Approve', 'Reject'] */
  options: string[]
  regarding?: { tableId: string; rowId: string }
  /** the run-as identity (who asks) */
  requestedBy: string | null
  /** when the step times out (ISO), if it has a timeout */
  dueOn?: string
  /** `<runId>:<stepKey>`: the same request twice must give the same approval */
  idempotencyKey: string
  /** a test run with dry run: C may simulate (the runtime does not call request() in dry runs) */
  dryRun?: boolean
}

export interface ApprovalOutcome {
  /** the chosen option ("Approve", "Reject" ...) */
  outcome: string
  responses?: { userId: string; name?: string; response: string; comment?: string; at: string }[]
  comments?: string
  completedOn?: string
}

export interface ApprovalsService {
  request(env: string, req: ApprovalRequest, identity: UserContext | null): Promise<{ id: string }>
  /** the run was cancelled or the step timed out: close the request (no more answers) */
  cancel?(env: string, approvalId: string, reason: 'cancelled' | 'timedOut'): Promise<void>
}

/** what the outcome of a wait can be when something outside resumes it */
export type WaitOutcome =
  | ({ kind: 'approval' } & ApprovalOutcome)
  | { kind: 'callback'; body: unknown; contentType?: string }

/** services.flows: what other server modules may call */
export interface FlowsService extends FlowWebhookTarget {
  triggerWebhook(env: string, flowId: string, payload: VerifiedWebhookPayload): Promise<{ runId?: string }>
  /** resume a suspended step (approval decided, callback received); false when it is not waiting any more */
  resumeWait(env: string, waitId: string, outcome: WaitOutcome): Promise<{ resumed: boolean }>
  setApprovals(impl: ApprovalsService | null): void
}
