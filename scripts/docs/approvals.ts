/**
 * docs/reference/approvals.md: approval types, approver references, escalation actions, statuses and the outputs of the
 * flow step `approval`, generated from src/platform/approvals.ts (the same catalogue GET /approvals/catalog serves).
 */
import { APPROVAL_STEP_OUTPUTS, APPROVAL_TYPE_DOCS, APPROVER_REF_DOCS, DEFAULT_RESPONSES, ESCALATION_DOCS, REQUEST_STATUSES } from '../../src/platform/approvals.ts'
import { STEP_KINDS, TRIGGER_TYPES } from '../../src/platform/flows.ts'
import { GENERATED_NOTICE, cell, code, table } from './markdown'

export function buildApprovalsPage(): { text: string } {
  const out: string[] = [GENERATED_NOTICE, '', '# Approvals reference', '']
  out.push('The approval types, approver references, escalation actions and request statuses, and what the flow step `approval` gives to later steps. Concepts and examples: [the maker guide](../guide/maker/approvals.md); design: [docs/dev/approvals.md](../dev/approvals.md).', '')
  out.push('## Approval types', '', table(['Type', 'Name', 'How it works', 'Outcome'], APPROVAL_TYPE_DOCS.map((t) => [code(t.type), cell(t.title), cell(t.summary), cell(t.outcome)])), '')
  out.push('## Approver references', '', 'Approvers are written as text references (in policies, the step\'s `approvers` formula, `RequestApproval` and the API). The requester is never asked unless the policy allows self-approval; nobody left means the requester\'s manager, else the administrators (the request history says why).', '')
  out.push(table(['Reference', 'Who'], APPROVER_REF_DOCS.map((r) => [code(r.ref), cell(r.summary)])), '')
  out.push('## Answers', '', `Default: ${DEFAULT_RESPONSES.map((r) => `${code(r.label)} (${r.kind})`).join(', ')}. Every answer has a kind: ${code('approve')}, ${code('reject')}, ${code('info')} (sends the request back to the requester; it resumes when they answer) or ${code('other')} (a custom answer that ends the request with that outcome, status ${code('completed')}). ${code('requireComment')} makes a comment mandatory.`, '')
  out.push('## Escalation actions', '', table(['Action', 'What happens when the request is overdue'], ESCALATION_DOCS.map((e) => [code(e.action), cell(e.summary)])), '')
  out.push('## Request statuses', '', REQUEST_STATUSES.map((s) => code(s)).join(', '), '')
  const step = STEP_KINDS.find((k) => k.kind === 'approval')
  if (step) {
    out.push('## The flow step `approval`', '', cell(step.summary), '')
    out.push(table(['Field', 'Type', 'Required', 'What it is'], step.fields.map((f) => [code(f.name), cell(f.type), f.required ? 'yes' : '', cell(f.doc)])), '')
  }
  out.push('### Outputs (`Steps.<name>.Output`)', '', table(['Output', 'Type', 'What it is'], APPROVAL_STEP_OUTPUTS.map((o) => [code(o.name), cell(o.type), cell(o.doc)])), '')
  out.push('A step that times out (its `timeoutMinutes`) ends with status `timedOut` (use `runAfter` with `timedOut`); the request then expires.', '')
  const trig = TRIGGER_TYPES.find((t) => t.type === 'approvalDecided')
  if (trig) {
    out.push('## The trigger `approvalDecided`', '', cell(trig.summary), '')
    out.push(table(['Field', 'Type', 'What it is'], trig.fields.map((f) => [code(f.name), cell(f.type), cell(f.doc)])), '', `**Expressions see:** ${cell(trig.scope)}`, '', `**Guarantee:** ${cell(trig.guarantee)}`, '')
  }
  return { text: out.join('\n') }
}
