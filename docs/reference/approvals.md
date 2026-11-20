<!-- GENERATED FILE. Do not edit by hand: change the code (or the hand-written parts in scripts/docs/) and run `npm run docs:gen`. -->

# Approvals reference

The approval types, approver references, escalation actions and request statuses, and what the flow step `approval` gives to later steps. Concepts and examples: [the maker guide](../guide/maker/approvals.md); design: [docs/dev/approvals.md](../dev/approvals.md).

## Approval types

| Type | Name | How it works | Outcome |
| --- | --- | --- | --- |
| `single` | Single approver | One person decides. | Their answer. |
| `any` | First to respond | Several people are asked; the first answer decides. | The first answer; the others are told it was decided. |
| `all` | Everyone must approve | Everyone asked must approve. With rejectOnFirst (default) the first rejection rejects at once. | Approve when everyone approved; otherwise the rejecting answer. |
| `quorum` | Quorum (N of M) | quorum of the approvers must approve. | Approve once quorum approvals arrived; Reject as soon as the quorum can no longer be reached. |
| `sequential` | Sequential stages | Stages one after another; each stage is any, all or quorum, and may have a condition. A rejection in a stage ends the request. | Approve when the last stage approved; otherwise the rejecting answer. |

## Approver references

Approvers are written as text references (in policies, the step's `approvers` formula, `RequestApproval` and the API). The requester is never asked unless the policy allows self-approval; nobody left means the requester's manager, else the administrators (the request history says why).

| Reference | Who |
| --- | --- |
| `asha@example.com, usr_123, user:<email or id>` | One person. |
| `role:<name or id>` | Everyone with the role in this environment. |
| `team:<code or id>` | Every member of the team. |
| `department:<code>` | Every member of the department. |
| `department-head, department-head:<code>` | The head of the requester's (or the named) department: the member whose manager is outside the department. |
| `manager, manager:<n>` | The requester's manager, or the manager n levels up. |
| `manager-chain:<n>` | Each manager up to n levels, one stage per level (only approver of its stage). |
| `manager-chain-until-title:<title>, manager-chain-until-role:<role>` | Up the reporting line until (and including) the first manager with that job title or role. |

## Answers

Default: `Approve` (approve), `Reject` (reject). Every answer has a kind: `approve`, `reject`, `info` (sends the request back to the requester; it resumes when they answer) or `other` (a custom answer that ends the request with that outcome, status `completed`). `requireComment` makes a comment mandatory.

## Escalation actions

| Action | What happens when the request is overdue |
| --- | --- |
| `manager` | Each person still to answer gets their manager added in their place (recorded as escalation). |
| `user` | A named person is asked in place of those still to answer. |
| `nextStage` | The current stage is skipped; the next stage starts (the last stage: the request expires). |
| `approve` | The system approves (recorded as an automatic decision). |
| `reject` | The system rejects (recorded as an automatic decision). |
| `expire` | The request expires; the flow step gets the outcome "Expired". |

## Request statuses

`pending`, `info`, `approved`, `rejected`, `completed`, `cancelled`, `expired`

## The flow step `approval`

Asks people to approve; the run waits (costing nothing) until they answer or the timeout passes.

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

### Outputs (`Steps.<name>.Output`)

| Output | Type | What it is |
| --- | --- | --- |
| `Outcome` | text | The deciding answer ("Approve", "Reject", a custom answer, "Expired", "Cancelled"). |
| `Status` | text | approved, rejected, completed (a custom answer), expired or cancelled. |
| `Responses` | table | One row per answer: Approver (email), Name, Response, Comment, Time (Stage too). |
| `Approvers` | table | Everyone who was asked: Approver (email), Name, Stage, Source (direct, role, manager, delegation ...), Status. |
| `ApprovalId` | text | The approval request (open it at #u-approvals?id=...). |
| `CompletedOn` | datetime | When it was decided. |
| `Comments` | text | The comments of the answers, one per line ("Name: comment"). |

A step that times out (its `timeoutMinutes`) ends with status `timedOut` (use `runAfter` with `timedOut`); the request then expires.

## The trigger `approvalDecided`

Starts a run when an approval request ends: approved, rejected, a custom answer, expired or cancelled (P1-C).

| Field | Type | What it is |
| --- | --- | --- |
| `policy` | text | Only requests of this approval policy (name or id). |
| `statuses` | ("approved" \| "rejected" \| "completed" \| "expired" \| "cancelled")[] | Only these endings (default all). |

**Expressions see:** Trigger.Request (Id, Title, Status, Outcome, RequestedBy, Policy, RegardingTable, RegardingId, CompletedOn, Fields), Trigger.Responses

**Guarantee:** One run per decided request and flow (trigger key appr:<flow>:<request>).
