/**
 * Approvals (P1 package C; docs/dev/approvals.md): the shared types of approval policies, requests, stages,
 * assignments, history and delegations, the approver reference syntax, and the catalogue used by the reference docs, the
 * maker UI and the approval step form. Pure: shared by the server, the client and the docs generator (no React, no DOM,
 * no Node APIs, no `@/` alias).
 */

/* ------------------------------------------------------------------ definitions */

/**
 * single: one approver; any: the first of N to respond decides; all: everyone must approve (rejectOnFirst: the first
 * rejection rejects, default true); quorum: N of M must approve; sequential: stages one after another (each any, all or
 * quorum).
 */
export type ApprovalType = 'single' | 'any' | 'all' | 'quorum' | 'sequential'
export const APPROVAL_TYPES: readonly ApprovalType[] = ['single', 'any', 'all', 'quorum', 'sequential']

export type StageMode = 'any' | 'all' | 'quorum'

/**
 * An approver reference (text). Users: an email or a user id (`user:<email or id>` also works). Groups: `role:<name or
 * id>`, `team:<code or id>`, `department:<code>` (every member), `department-head` (the head of the requester's
 * department), `department-head:<code>`. Reporting line of the requester: `manager` (level 1), `manager:<n>` (the
 * manager n levels up), `manager-chain:<n>` (each level up to n, one stage per level), `manager-chain-until-title:<job
 * title>`, `manager-chain-until-role:<role>` (up to and including the first manager with that job title or role).
 * A chain reference must be the only approver of its stage; it becomes one sequential stage per level.
 */
export type ApproverRef = string

export interface ApprovalStageDef {
  name?: string
  approvers: ApproverRef[]
  /** default any */
  mode?: StageMode
  /** quorum: how many approvals the stage needs */
  quorum?: number
  /** a formula over the request's fields (e.g. `Amount > 10000`); the stage is skipped when it is false */
  condition?: string
  /** P1-E: this stage is due this long after it starts (minutes); overrides the request's due date while it is active */
  dueMinutes?: number
}

/** threshold rules ("amount thresholds"): every rule whose condition is true adds a stage after the base stages, in order */
export interface ApprovalRule {
  name?: string
  /** a formula over the request's fields, e.g. `Amount > 50000` */
  condition: string
  approvers: ApproverRef[]
  mode?: StageMode
  quorum?: number
  /** P1-E: the stage this rule adds is due this long after it starts (minutes) */
  dueMinutes?: number
}

/**
 * Answer options. approve and reject decide as the type says; info ("Need more info") sends the request back to the
 * requester and resumes when they answer; other: a custom answer that ends the request with that outcome.
 */
export type ResponseKind = 'approve' | 'reject' | 'info' | 'other'
export interface ResponseOption {
  label: string
  kind: ResponseKind
  /** a comment is required with this answer */
  requireComment?: boolean
}

export type EscalationAction = 'manager' | 'user' | 'nextStage' | 'approve' | 'reject' | 'expire'
export interface EscalationDef {
  /** minutes after the due date (default 0: at the due date) */
  afterMinutes?: number
  action: EscalationAction
  /** action user: an approver reference of one person (email, user id) */
  to?: ApproverRef
}

export interface ReminderDef {
  /** first reminder this long after a person was asked (minutes) */
  afterMinutes: number
  /** then every so often (minutes; default: no repeat) */
  everyMinutes?: number
  /** at most this many reminders per person (default 3) */
  max?: number
}

export interface ApprovalDefinition {
  type: ApprovalType
  /** single, any, all, quorum: the approvers (sequential: use stages) */
  approvers?: ApproverRef[]
  /** quorum: how many must approve */
  quorum?: number
  /** all: the first rejection rejects at once (default true); false: wait for everyone, rejected when anyone rejected */
  rejectOnFirst?: boolean
  stages?: ApprovalStageDef[]
  rules?: ApprovalRule[]
  /** default: Approve (approve), Reject (reject) */
  responses?: ResponseOption[]
  /** the requester may approve their own request (default false) */
  allowSelfApproval?: boolean
  /** the same person cannot approve two consecutive stages (default false) */
  separationOfDuties?: boolean
  /** people may approve this kind of request together with others in one go (default true) */
  allowBulk?: boolean
  /** a comment is required when rejecting (default false) */
  requireCommentOnReject?: boolean
  /** the request is due this long after it was made (minutes) */
  dueMinutes?: number
  reminders?: ReminderDef
  escalation?: EscalationDef
}

/** a reusable definition (Admin and maker pages; travels in solutions as component kind `approvalPolicy`) */
export interface ApprovalPolicy {
  id: string
  name: string
  description?: string
  definition: ApprovalDefinition
  solutionId?: string | null
  createdOn?: string
  modifiedOn?: string
  modifiedBy?: string | null
}

/* ------------------------------------------------------------------ requests */

export type RequestStatus = 'pending' | 'info' | 'approved' | 'rejected' | 'completed' | 'cancelled' | 'expired'
export const REQUEST_STATUSES: readonly RequestStatus[] = ['pending', 'info', 'approved', 'rejected', 'completed', 'cancelled', 'expired']
export const OPEN_STATUSES: readonly RequestStatus[] = ['pending', 'info']
export const isOpenStatus = (s: string): boolean => s === 'pending' || s === 'info'

export type AssignmentSource = 'direct' | 'role' | 'team' | 'department' | 'manager' | 'delegation' | 'escalation' | 'fallback' | 'reassigned'
export type AssignmentStatus = 'waiting' | 'pending' | 'responded' | 'reassigned' | 'cancelled' | 'skipped' | 'escalated'

export interface ApprovalAssignmentInfo {
  id: string
  stage: number
  userId: string
  userName?: string
  source: AssignmentSource
  status: AssignmentStatus
  response?: string | null
  responseKind?: ResponseKind | null
  comment?: string | null
  respondedOn?: string | null
  reassignedFrom?: string | null
  reassignedFromName?: string | null
  /** why this person was asked (delegation, fallback, escalation) */
  note?: string | null
  createdOn: string
}

export interface ApprovalStageInfo {
  index: number
  name: string
  mode: StageMode
  quorum?: number | null
  status: 'waiting' | 'active' | 'approved' | 'rejected' | 'skipped' | 'escalated' | 'cancelled'
  startedOn?: string | null
  completedOn?: string | null
}

export interface ApprovalHistoryEntry {
  id: string
  at: string
  actorId: string | null
  actorName?: string | null
  /** user, system (escalation, expiry, routing), flow, cli */
  actorKind: 'user' | 'system' | 'flow'
  action: string
  stage?: number | null
  details: Record<string, unknown>
}

export interface ApprovalRequestInfo {
  id: string
  title: string
  /** sanitised rich text the requester (or the flow) included; always shown */
  details: string
  /** the fields the requester (or flow) declared, label -> value; always shown */
  fields: Record<string, unknown>
  regardingTable?: string | null
  regardingId?: string | null
  regardingTableName?: string | null
  requestedBy: string | null
  requestedByName?: string | null
  type: ApprovalType
  policyId?: string | null
  policyName?: string | null
  status: RequestStatus
  outcome?: string | null
  dueOn?: string | null
  currentStage: number
  source: 'flow' | 'app' | 'api'
  flowId?: string | null
  flowName?: string | null
  flowRunId?: string | null
  createdOn: string
  completedOn?: string | null
  responses: ResponseOption[]
  allowBulk: boolean
  requireCommentOnReject: boolean
  /** for the signed-in user */
  myAssignment?: { id: string; stage: number; status: AssignmentStatus } | null
  canDecide?: boolean
  canCancel?: boolean
  canReassign?: boolean
  /** the requester may answer a "Need more info" */
  canAnswerInfo?: boolean
}

export interface ApprovalDetail extends ApprovalRequestInfo {
  stages: ApprovalStageInfo[]
  assignments: ApprovalAssignmentInfo[]
  history: ApprovalHistoryEntry[]
  /**
   * The regarding record as the signed-in user may read it (row and column security applied): null when there is no
   * record or the user cannot read it (then only `details` and `fields` are shown; the record never leaks).
   */
  record: { title: string; fields: { name: string; label: string; value: unknown }[] } | null
  recordHidden: boolean
}

export interface DelegationInfo {
  id: string
  fromUser: string
  fromName?: string
  toUser: string
  toName?: string
  startsOn: string
  endsOn?: string | null
  /** policy ids or names this delegation covers; empty: every approval */
  policies: string[]
  note?: string | null
  active: boolean
  createdOn: string
  createdBy?: string | null
  cancelledOn?: string | null
}

export interface ApprovalSettings {
  /** roles granted "Approvals: view": they see requests about records they can read */
  viewerRoles: string[]
  /** days the decided requests are kept (0: forever) */
  retentionDays: number
  /** email Approve / Reject links stay valid this many hours */
  linkHours: number
}
export const DEFAULT_APPROVAL_SETTINGS: ApprovalSettings = { viewerRoles: [], retentionDays: 0, linkHours: 72 }

export const DEFAULT_RESPONSES: ResponseOption[] = [{ label: 'Approve', kind: 'approve' }, { label: 'Reject', kind: 'reject' }]

/** the answer options of a definition, or of the plain labels a flow gives (Approve, Reject, Need more info ...) */
export function responsesOf(def: Pick<ApprovalDefinition, 'responses' | 'requireCommentOnReject'>, labels?: string[]): ResponseOption[] {
  let list: ResponseOption[]
  if (def.responses?.length) list = def.responses.map((r) => ({ ...r }))
  else if (labels?.length) list = labels.map((l, i) => ({ label: l, kind: guessKind(l, i) }))
  else list = DEFAULT_RESPONSES.map((r) => ({ ...r }))
  if (def.requireCommentOnReject) for (const r of list) if (r.kind === 'reject') r.requireComment = true
  return list
}

/** a plain label's kind: approve-like, reject-like, more-info-like, else the first approves, the second rejects, others are custom */
export function guessKind(label: string, index: number): ResponseKind {
  const l = label.trim().toLowerCase()
  if (/^(approve|approved|accept|yes|ok|agree|sign|sign off|sign-off)\b/.test(l)) return 'approve'
  if (/^(reject|rejected|decline|deny|no|refuse)\b/.test(l)) return 'reject'
  if (/(more info|information|clarif|question)/.test(l)) return 'info'
  return index === 0 ? 'approve' : index === 1 ? 'reject' : 'other'
}

/* ------------------------------------------------------------------ approver references */

export type ParsedRef =
  | { kind: 'user'; value: string }
  | { kind: 'role'; value: string }
  | { kind: 'team'; value: string }
  | { kind: 'department'; value: string }
  | { kind: 'departmentHead'; value: string | null }
  | { kind: 'manager'; level: number }
  | { kind: 'managerChain'; levels: number; untilTitle?: string; untilRole?: string }

export function parseApproverRef(raw: string): ParsedRef | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const m = /^([a-z-]+):(.*)$/i.exec(s)
  const head = (m?.[1] ?? s).toLowerCase()
  const rest = (m?.[2] ?? '').trim()
  switch (head) {
    case 'user': return rest ? { kind: 'user', value: rest } : null
    case 'role': return rest ? { kind: 'role', value: rest } : null
    case 'team': return rest ? { kind: 'team', value: rest } : null
    case 'department': return rest ? { kind: 'department', value: rest } : null
    case 'department-head': return { kind: 'departmentHead', value: rest || null }
    case 'manager': {
      if (!m) return { kind: 'manager', level: 1 }
      const n = Number(rest)
      return Number.isInteger(n) && n >= 1 && n <= 10 ? { kind: 'manager', level: n } : null
    }
    case 'manager-chain': {
      const n = Number(rest || 1)
      return Number.isInteger(n) && n >= 1 && n <= 10 ? { kind: 'managerChain', levels: n } : null
    }
    case 'manager-chain-until-title': return rest ? { kind: 'managerChain', levels: 10, untilTitle: rest } : null
    case 'manager-chain-until-role': return rest ? { kind: 'managerChain', levels: 10, untilRole: rest } : null
  }
  // a bare value: an email or a user id
  if (m && !s.includes('@')) return null
  return { kind: 'user', value: s }
}

/** problems of a definition (empty: fine). Formula conditions are checked by the caller (server: the formula engine). */
export function definitionProblems(d: unknown): { field: string; message: string }[] {
  const out: { field: string; message: string }[] = []
  const err = (field: string, message: string) => out.push({ field, message })
  if (!d || typeof d !== 'object' || Array.isArray(d)) return [{ field: 'definition', message: 'The definition must be an object.' }]
  const def = d as ApprovalDefinition
  if (!APPROVAL_TYPES.includes(def.type)) err('type', `type must be one of ${APPROVAL_TYPES.join(', ')}.`)
  const checkRefs = (field: string, refs: unknown, allowChainAlone = true) => {
    if (!Array.isArray(refs)) return err(field, 'approvers must be a list of references.')
    for (const r of refs) {
      const p = typeof r === 'string' ? parseApproverRef(r) : null
      if (!p) err(field, `"${String(r)}" is not an approver reference (an email, user id, role:, team:, department:, department-head, manager, manager:<n>, manager-chain:<n> ...).`)
      else if (p.kind === 'managerChain' && (refs.length > 1 || !allowChainAlone)) err(field, 'A manager chain must be the only approver of its stage.')
    }
  }
  const checkMode = (field: string, mode: unknown, quorum: unknown, n: number | null) => {
    if (mode !== undefined && mode !== 'any' && mode !== 'all' && mode !== 'quorum') err(field, 'mode must be any, all or quorum.')
    if (mode === 'quorum' && (!Number.isInteger(quorum) || Number(quorum) < 1 || (n !== null && Number(quorum) > n && n > 0))) err(field, 'quorum must be a whole number from 1 to the number of approvers.')
  }
  if (def.type === 'sequential') {
    if (!Array.isArray(def.stages) || !def.stages.length) {
      if (!def.rules?.length) err('stages', 'A sequential approval needs at least one stage.')
    } else {
      if (def.stages.length > 20) err('stages', 'At most 20 stages.')
      def.stages.forEach((s, i) => {
        if (!s || typeof s !== 'object') return err(`stages.${i}`, 'A stage must be an object.')
        checkRefs(`stages.${i}.approvers`, s.approvers)
        if (Array.isArray(s.approvers) && !s.approvers.length) err(`stages.${i}.approvers`, 'A stage needs approvers.')
        checkMode(`stages.${i}.mode`, s.mode, s.quorum, Array.isArray(s.approvers) ? s.approvers.length : null)
        if (s.condition !== undefined && typeof s.condition !== 'string') err(`stages.${i}.condition`, 'condition must be a formula.')
        if (s.dueMinutes !== undefined && (!Number.isFinite(s.dueMinutes) || s.dueMinutes < 1 || s.dueMinutes > 366 * 24 * 60)) err(`stages.${i}.dueMinutes`, 'dueMinutes must be from 1 minute to a year.')
      })
    }
  } else if (def.type) {
    if (!Array.isArray(def.approvers) || !def.approvers.length) {
      if (!def.rules?.length) err('approvers', 'Name at least one approver.')
    } else checkRefs('approvers', def.approvers)
    if (def.type === 'single' && Array.isArray(def.approvers) && def.approvers.length > 1 && def.approvers.every((a) => parseApproverRef(a)?.kind === 'user')) err('approvers', 'A single approval has one approver (use "any" or "all" for several).')
    if (def.type === 'quorum' && (!Number.isInteger(def.quorum) || Number(def.quorum) < 1)) err('quorum', 'quorum must be a whole number of at least 1.')
  }
  if (def.rules !== undefined) {
    if (!Array.isArray(def.rules)) err('rules', 'rules must be a list.')
    else def.rules.forEach((r, i) => {
      if (!r || typeof r.condition !== 'string' || !r.condition.trim()) err(`rules.${i}.condition`, 'A rule needs a condition (a formula such as Amount > 50000).')
      checkRefs(`rules.${i}.approvers`, r?.approvers)
      if (Array.isArray(r?.approvers) && !r.approvers.length) err(`rules.${i}.approvers`, 'A rule needs approvers.')
      checkMode(`rules.${i}.mode`, r?.mode, r?.quorum, Array.isArray(r?.approvers) ? r.approvers.length : null)
      if (r?.dueMinutes !== undefined && (!Number.isFinite(r.dueMinutes) || r.dueMinutes < 1 || r.dueMinutes > 366 * 24 * 60)) err(`rules.${i}.dueMinutes`, 'dueMinutes must be from 1 minute to a year.')
    })
  }
  if (def.responses !== undefined) {
    if (!Array.isArray(def.responses) || !def.responses.length) err('responses', 'responses must list at least one answer.')
    else {
      const labels = new Set<string>()
      def.responses.forEach((r, i) => {
        if (!r || typeof r.label !== 'string' || !r.label.trim() || r.label.length > 60) err(`responses.${i}.label`, 'Each answer needs a label (at most 60 characters).')
        else if (labels.has(r.label.trim().toLowerCase())) err(`responses.${i}.label`, `"${r.label}" is listed twice.`)
        else labels.add(r.label.trim().toLowerCase())
        if (!['approve', 'reject', 'info', 'other'].includes(String(r?.kind))) err(`responses.${i}.kind`, 'kind must be approve, reject, info or other.')
      })
      if (!def.responses.some((r) => r?.kind === 'approve')) err('responses', 'At least one answer must approve.')
    }
  }
  if (def.dueMinutes !== undefined && (!Number.isFinite(def.dueMinutes) || def.dueMinutes < 1 || def.dueMinutes > 366 * 24 * 60)) err('dueMinutes', 'dueMinutes must be from 1 minute to a year.')
  if (def.reminders !== undefined) {
    const r = def.reminders
    if (!r || !(Number(r.afterMinutes) >= 1)) err('reminders.afterMinutes', 'The first reminder needs afterMinutes (at least 1).')
    if (r?.everyMinutes !== undefined && !(Number(r.everyMinutes) >= 5)) err('reminders.everyMinutes', 'everyMinutes must be at least 5.')
    if (r?.max !== undefined && !(Number.isInteger(r.max) && r.max >= 1 && r.max <= 20)) err('reminders.max', 'max must be from 1 to 20.')
  }
  if (def.escalation !== undefined) {
    const e = def.escalation
    if (!e || !['manager', 'user', 'nextStage', 'approve', 'reject', 'expire'].includes(String(e.action))) err('escalation.action', 'action must be manager, user, nextStage, approve, reject or expire.')
    if (e?.action === 'user' && (!e.to || parseApproverRef(e.to)?.kind !== 'user')) err('escalation.to', 'Escalating to a user needs the user (an email or user id).')
    if (e?.afterMinutes !== undefined && !(Number(e.afterMinutes) >= 0)) err('escalation.afterMinutes', 'afterMinutes must be 0 or more.')
    if (def.dueMinutes === undefined && !(def.stages ?? []).some((x) => x?.dueMinutes) && !(def.rules ?? []).some((x) => x?.dueMinutes)) err('escalation', 'Escalation needs a due date (dueMinutes, or a stage\'s due date), or the flow step\'s due date.')
  }
  return out
}

/* ------------------------------------------------------------------ catalogue (reference docs, maker UI) */

export const APPROVAL_TYPE_DOCS: { type: ApprovalType; title: string; summary: string; outcome: string }[] = [
  { type: 'single', title: 'Single approver', summary: 'One person decides.', outcome: 'Their answer.' },
  { type: 'any', title: 'First to respond', summary: 'Several people are asked; the first answer decides.', outcome: 'The first answer; the others are told it was decided.' },
  { type: 'all', title: 'Everyone must approve', summary: 'Everyone asked must approve. With rejectOnFirst (default) the first rejection rejects at once.', outcome: 'Approve when everyone approved; otherwise the rejecting answer.' },
  { type: 'quorum', title: 'Quorum (N of M)', summary: 'quorum of the approvers must approve.', outcome: 'Approve once quorum approvals arrived; Reject as soon as the quorum can no longer be reached.' },
  { type: 'sequential', title: 'Sequential stages', summary: 'Stages one after another; each stage is any, all or quorum, and may have a condition. A rejection in a stage ends the request.', outcome: 'Approve when the last stage approved; otherwise the rejecting answer.' },
]

export const APPROVER_REF_DOCS: { ref: string; summary: string }[] = [
  { ref: 'asha@example.com, usr_123, user:<email or id>', summary: 'One person.' },
  { ref: 'role:<name or id>', summary: 'Everyone with the role in this environment.' },
  { ref: 'team:<code or id>', summary: 'Every member of the team.' },
  { ref: 'department:<code>', summary: 'Every member of the department.' },
  { ref: 'department-head, department-head:<code>', summary: 'The head of the requester\'s (or the named) department: the member whose manager is outside the department.' },
  { ref: 'manager, manager:<n>', summary: 'The requester\'s manager, or the manager n levels up.' },
  { ref: 'manager-chain:<n>', summary: 'Each manager up to n levels, one stage per level (only approver of its stage).' },
  { ref: 'manager-chain-until-title:<title>, manager-chain-until-role:<role>', summary: 'Up the reporting line until (and including) the first manager with that job title or role.' },
]

export const ESCALATION_DOCS: { action: EscalationAction; summary: string }[] = [
  { action: 'manager', summary: 'Each person still to answer gets their manager added in their place (recorded as escalation).' },
  { action: 'user', summary: 'A named person is asked in place of those still to answer.' },
  { action: 'nextStage', summary: 'The current stage is skipped; the next stage starts (the last stage: the request expires).' },
  { action: 'approve', summary: 'The system approves (recorded as an automatic decision).' },
  { action: 'reject', summary: 'The system rejects (recorded as an automatic decision).' },
  { action: 'expire', summary: 'The request expires; the flow step gets the outcome "Expired".' },
]

/** the output of the flow step `approval` (Steps.<name>.Output) */
export const APPROVAL_STEP_OUTPUTS: { name: string; type: string; doc: string }[] = [
  { name: 'Outcome', type: 'text', doc: 'The deciding answer ("Approve", "Reject", a custom answer, "Expired", "Cancelled").' },
  { name: 'Status', type: 'text', doc: 'approved, rejected, completed (a custom answer), expired or cancelled.' },
  { name: 'Responses', type: 'table', doc: 'One row per answer: Approver (email), Name, Response, Comment, Time (Stage too).' },
  { name: 'Approvers', type: 'table', doc: 'Everyone who was asked: Approver (email), Name, Stage, Source (direct, role, manager, delegation ...), Status.' },
  { name: 'ApprovalId', type: 'text', doc: 'The approval request (open it at #u-approvals?id=...).' },
  { name: 'CompletedOn', type: 'datetime', doc: 'When it was decided.' },
  { name: 'Comments', type: 'text', doc: 'The comments of the answers, one per line ("Name: comment").' },
]

/** the approval step's own fields beyond the P1 contract (refinements; docs/dev/approvals.md) */
export interface ApprovalStepConfig {
  title: string
  details?: string
  /** approvers (formula): emails, user ids, role:/team:/manager references, a table of people; optional with a policy */
  approvers?: string
  type?: ApprovalType
  options?: string[]
  regarding?: { table: string; rowId: string }
  /** a policy (name or id) to use; the step's own fields override its approvers, type and options when given */
  policy?: string
  /** fields shown to approvers (label -> formula); threshold rules read them (e.g. Amount) */
  fields?: Record<string, string>
  quorum?: number
  stages?: ApprovalStageDef[]
  /** P1-E: threshold rules on the step itself (read the fields below) */
  rules?: ApprovalRule[]
  /** P1-E: answers with their kinds (approve, reject, info, other) and required comments; overrides options */
  responses?: ResponseOption[]
  dueMinutes?: number
  reminders?: ReminderDef
  escalation?: EscalationDef
  allowSelfApproval?: boolean
  separationOfDuties?: boolean
  requireCommentOnReject?: boolean
  timeoutMinutes?: number
}
