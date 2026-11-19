/**
 * Routing of approvals (P1 package C; docs/dev/approvals.md "Routing"): pure functions, unit-tested without a database.
 *
 *  - expandStages: a definition (type, approvers, stages, threshold rules) and the request's fields -> the stage plan
 *    (made when the request is created: conditions and rules are evaluated once, manager chains become one stage per level);
 *  - resolveStage: when a stage starts, its approver references -> people (roles, teams, departments, the reporting line),
 *    then the rules every stage follows in this order: disabled people are dropped; the requester is dropped unless the
 *    definition allows self-approval; with separation of duties, the people who approved the previous stage are dropped;
 *    nobody left -> fallback to the requester's manager, else the environment's administrators (and why is recorded);
 *    delegations active now are followed (up to 5 hops, never back to the requester or in a cycle);
 *  - stageOutcome: the answers of a stage -> approved, rejected, a custom answer, or still open.
 */
import {
  parseApproverRef, type ApprovalDefinition, type AssignmentSource, type ParsedRef, type ResponseKind, type StageMode,
} from '../../../src/platform/approvals.ts'

export interface OrgPerson {
  id: string
  name: string
  email: string
  managerId?: string | null
  departmentId?: string | null
  jobTitle?: string | null
  status?: 'active' | 'disabled'
  /** role ids in this environment */
  roleIds: string[]
}

export interface OrgData {
  people: Map<string, OrgPerson>
  roles: { id: string; name: string }[]
  teams: { id: string; code: string; name: string; memberIds: string[] }[]
  departments: { id: string; code: string; name: string }[]
  /** environment administrators (fallback approvers) */
  admins: string[]
}

export interface ActiveDelegation { id: string; fromUser: string; toUser: string; policies: string[] }

export interface StagePlan {
  name: string
  mode: StageMode
  quorum?: number
  refs: string[]
}

export interface Assignee {
  userId: string
  source: AssignmentSource
  /** when someone else was asked first (delegation): who */
  reassignedFrom?: string
  delegationId?: string
  note?: string
}

export interface RoutingNote { action: string; text: string; userId?: string }

export class RoutingError extends Error {}

const lower = (s: string) => s.trim().toLowerCase()

export function findPerson(org: OrgData, idOrEmail: string): OrgPerson | undefined {
  const v = idOrEmail.trim()
  return org.people.get(v) ?? [...org.people.values()].find((p) => lower(p.email) === lower(v))
}

/** the reporting line above a person (manager first), cycles cut, at most 32 */
export function managersOf(org: OrgData, userId: string | null): OrgPerson[] {
  const out: OrgPerson[] = []
  const seen = new Set<string>(userId ? [userId] : [])
  let cur = userId ? org.people.get(userId) : undefined
  while (cur?.managerId && out.length < 32) {
    if (seen.has(cur.managerId)) break
    seen.add(cur.managerId)
    const m = org.people.get(cur.managerId)
    if (!m) break
    out.push(m)
    cur = m
  }
  return out
}

/** the head of a department: members whose manager is outside the department (or who have none) */
export function departmentHeads(org: OrgData, departmentId: string): OrgPerson[] {
  const members = [...org.people.values()].filter((p) => p.departmentId === departmentId && p.status !== 'disabled')
  return members.filter((p) => !p.managerId || org.people.get(p.managerId)?.departmentId !== departmentId)
}

function departmentOf(org: OrgData, ref: string): { id: string } | undefined {
  return org.departments.find((d) => d.id === ref || lower(d.code) === lower(ref) || lower(d.name) === lower(ref))
}

const modeOfType = (t: ApprovalDefinition['type']): StageMode => (t === 'all' ? 'all' : t === 'quorum' ? 'quorum' : 'any')

/**
 * The stage plan of a definition. evalCondition: a formula over the request's fields -> true/false (throws when it is not
 * a valid condition). Chain references become one stage per manager level (from the requester up).
 */
export function expandStages(def: ApprovalDefinition, o: { requesterId: string | null; org: OrgData; evalCondition(formula: string): boolean }): { stages: StagePlan[]; notes: RoutingNote[] } {
  const notes: RoutingNote[] = []
  const base: (StagePlan & { condition?: string })[] = []
  if (def.type === 'sequential') {
    ;(def.stages ?? []).forEach((s, i) => base.push({ name: s.name?.trim() || `Stage ${i + 1}`, mode: s.mode ?? 'any', ...(s.quorum ? { quorum: s.quorum } : {}), refs: [...s.approvers], ...(s.condition ? { condition: s.condition } : {}) }))
  } else if (def.approvers?.length) {
    base.push({ name: 'Approval', mode: modeOfType(def.type), ...(def.type === 'quorum' && def.quorum ? { quorum: def.quorum } : {}), refs: [...def.approvers] })
  }
  const planned: StagePlan[] = []
  for (const s of base) {
    if (s.condition && !o.evalCondition(s.condition)) {
      notes.push({ action: 'stage.skipped', text: `Stage "${s.name}" is not needed: ${s.condition} is false.` })
      continue
    }
    planned.push({ name: s.name, mode: s.mode, ...(s.quorum ? { quorum: s.quorum } : {}), refs: s.refs })
  }
  ;(def.rules ?? []).forEach((r, i) => {
    if (!o.evalCondition(r.condition)) return
    const name = r.name?.trim() || `Rule ${i + 1}`
    notes.push({ action: 'rule.matched', text: `Rule "${name}" applies: ${r.condition}.` })
    planned.push({ name, mode: r.mode ?? 'any', ...(r.quorum ? { quorum: r.quorum } : {}), refs: [...r.approvers] })
  })
  // manager chains: one stage per level
  const stages: StagePlan[] = []
  for (const s of planned) {
    const only = s.refs.length === 1 ? parseApproverRef(s.refs[0]) : null
    if (only?.kind !== 'managerChain') {
      stages.push(s)
      continue
    }
    const chain = managersOf(o.org, o.requesterId)
    const picked: OrgPerson[] = []
    for (const m of chain) {
      if (picked.length >= only.levels) break
      picked.push(m)
      const hitTitle = only.untilTitle && m.jobTitle && lower(m.jobTitle) === lower(only.untilTitle)
      const hitRole = only.untilRole && m.roleIds.some((rid) => { const r = o.org.roles.find((x) => x.id === rid); return rid === only.untilRole || (r && lower(r.name) === lower(only.untilRole!)) })
      if (hitTitle || hitRole) break
    }
    if (!picked.length) {
      notes.push({ action: 'routing.fallback', text: `${s.name}: the requester has no manager on record.` })
      stages.push({ name: s.name, mode: 'any', refs: [] })
      continue
    }
    picked.forEach((m, i) => stages.push({ name: picked.length === 1 ? s.name : `${s.name} (level ${i + 1})`, mode: 'any', refs: [`user:${m.id}`] }))
  }
  if (!stages.length) throw new RoutingError('Nobody to ask: no approvers, no stage and no rule applies.')
  return { stages, notes }
}

/** the people a reference names (with the source recorded on the assignment) */
export function resolveRef(ref: ParsedRef, org: OrgData, requesterId: string | null): { people: OrgPerson[]; source: AssignmentSource; note?: string } {
  switch (ref.kind) {
    case 'user': {
      const p = findPerson(org, ref.value)
      return p ? { people: [p], source: 'direct' } : { people: [], source: 'direct', note: `There is nobody "${ref.value}" in this environment.` }
    }
    case 'role': {
      const r = org.roles.find((x) => x.id === ref.value || lower(x.name) === lower(ref.value))
      if (!r) return { people: [], source: 'role', note: `There is no role "${ref.value}".` }
      return { people: [...org.people.values()].filter((p) => p.roleIds.includes(r.id)), source: 'role' }
    }
    case 'team': {
      const t = org.teams.find((x) => x.id === ref.value || lower(x.code) === lower(ref.value) || lower(x.name) === lower(ref.value))
      if (!t) return { people: [], source: 'team', note: `There is no team "${ref.value}".` }
      return { people: t.memberIds.map((id) => org.people.get(id)).filter((p): p is OrgPerson => !!p), source: 'team' }
    }
    case 'department': {
      const d = departmentOf(org, ref.value)
      if (!d) return { people: [], source: 'department', note: `There is no department "${ref.value}".` }
      return { people: [...org.people.values()].filter((p) => p.departmentId === d.id), source: 'department' }
    }
    case 'departmentHead': {
      const dId = ref.value ? departmentOf(org, ref.value)?.id : (requesterId ? org.people.get(requesterId)?.departmentId ?? undefined : undefined)
      if (!dId) return { people: [], source: 'department', note: ref.value ? `There is no department "${ref.value}".` : 'The requester has no department on record.' }
      return { people: departmentHeads(org, dId), source: 'department' }
    }
    case 'manager': {
      const chain = managersOf(org, requesterId)
      const m = chain[ref.level - 1]
      return m ? { people: [m], source: 'manager' } : { people: [], source: 'manager', note: ref.level === 1 ? 'The requester has no manager on record.' : `The requester has no manager ${ref.level} levels up.` }
    }
    case 'managerChain': {
      // expandStages turns chains into one stage per level; here (a chain mixed into a stage) the first level is used
      const m = managersOf(org, requesterId)[0]
      return m ? { people: [m], source: 'manager' } : { people: [], source: 'manager', note: 'The requester has no manager on record.' }
    }
  }
}

export interface ResolveOptions {
  org: OrgData
  requesterId: string | null
  allowSelfApproval?: boolean
  /** people who approved the previous stage (separation of duties) */
  previousApprovers?: Set<string>
  separationOfDuties?: boolean
  /** delegations active now */
  delegations: ActiveDelegation[]
  /** the policy of the request (id and name), for delegations limited to some policies */
  policyKeys: string[]
}

/** the delegate of a person now (following delegations up to 5 hops), or null */
export function delegateOf(userId: string, o: Pick<ResolveOptions, 'delegations' | 'policyKeys' | 'org' | 'requesterId' | 'allowSelfApproval'>): { userId: string; delegationId: string } | null {
  let cur = userId
  let found: { userId: string; delegationId: string } | null = null
  const seen = new Set([userId])
  for (let hop = 0; hop < 5; hop++) {
    const d = o.delegations.find((x) => x.fromUser === cur && (!x.policies.length || x.policies.some((p) => o.policyKeys.some((k) => lower(k) === lower(p)))))
    if (!d || seen.has(d.toUser)) break
    const to = o.org.people.get(d.toUser)
    if (!to || to.status === 'disabled') break
    if (!o.allowSelfApproval && d.toUser === o.requesterId) break
    seen.add(d.toUser)
    found = { userId: d.toUser, delegationId: d.id }
    cur = d.toUser
  }
  return found
}

/** who is asked in a stage (see the file comment for the rules and their order) */
export function resolveStage(stage: StagePlan, o: ResolveOptions): { assignees: Assignee[]; notes: RoutingNote[] } {
  const notes: RoutingNote[] = []
  const byId = new Map<string, Assignee>()
  for (const raw of stage.refs) {
    const ref = parseApproverRef(raw)
    if (!ref) {
      notes.push({ action: 'routing.unknown', text: `"${raw}" is not an approver reference.` })
      continue
    }
    const r = resolveRef(ref, o.org, o.requesterId)
    if (r.note) notes.push({ action: 'routing.unknown', text: r.note })
    for (const p of r.people) if (!byId.has(p.id)) byId.set(p.id, { userId: p.id, source: r.source })
  }
  for (const [id, a] of [...byId]) {
    const p = o.org.people.get(id)
    if (!p || p.status === 'disabled') {
      byId.delete(id)
      notes.push({ action: 'routing.skipped', userId: id, text: `${p?.name ?? id} is disabled and is not asked.` })
      continue
    }
    if (!o.allowSelfApproval && id === o.requesterId) {
      byId.delete(id)
      notes.push({ action: 'routing.self', userId: id, text: `${p.name} made the request and may not approve it (self-approval is not allowed).` })
      continue
    }
    if (o.separationOfDuties && o.previousApprovers?.has(id)) {
      byId.delete(id)
      notes.push({ action: 'routing.separation', userId: id, text: `${p.name} approved the previous stage and may not approve this one too (separation of duties).` })
      continue
    }
    void a
  }
  if (!byId.size) {
    const blocked = (id: string) => (!o.allowSelfApproval && id === o.requesterId) || (o.separationOfDuties && o.previousApprovers?.has(id)) || o.org.people.get(id)?.status === 'disabled'
    const mgr = managersOf(o.org, o.requesterId).find((m) => !blocked(m.id))
    if (mgr) {
      byId.set(mgr.id, { userId: mgr.id, source: 'fallback', note: 'Nobody else could be asked: the requester\'s manager decides.' })
      notes.push({ action: 'routing.fallback', userId: mgr.id, text: `Nobody else could be asked; ${mgr.name}, the requester's manager, decides.` })
    } else {
      const admins = o.org.admins.filter((id) => o.org.people.has(id) && !blocked(id))
      for (const id of admins) byId.set(id, { userId: id, source: 'fallback', note: 'Nobody else could be asked: an administrator decides.' })
      if (admins.length) notes.push({ action: 'routing.fallback', text: `Nobody else could be asked and the requester has no manager; the administrators decide (${admins.map((id) => o.org.people.get(id)!.name).join(', ')}).` })
    }
  }
  if (!byId.size) throw new RoutingError('Nobody can be asked to approve this request (no approver, no manager, no administrator other than the requester).')
  // delegations active now
  const out = new Map<string, Assignee>()
  for (const a of byId.values()) {
    const d = delegateOf(a.userId, o)
    if (d) {
      const from = o.org.people.get(a.userId)!
      const to = o.org.people.get(d.userId)!
      notes.push({ action: 'delegated', userId: d.userId, text: `${from.name} delegated approvals to ${to.name}.` })
      if (!out.has(d.userId)) out.set(d.userId, { userId: d.userId, source: 'delegation', reassignedFrom: a.userId, delegationId: d.delegationId, note: `On behalf of ${from.name} (delegation).` })
    } else if (!out.has(a.userId)) out.set(a.userId, a)
  }
  return { assignees: [...out.values()], notes }
}

export type StageResult = { status: 'approved' | 'rejected' | 'other'; label: string } | null

/**
 * The outcome of a stage from its answers. answers: every assignment of the stage that is still counted (pending or
 * responded; reassigned and cancelled ones are left out). A custom answer (kind other) ends the stage with that answer.
 */
export function stageOutcome(mode: StageMode, quorum: number | null | undefined, rejectOnFirst: boolean, answers: { responded: boolean; kind?: ResponseKind | null; label?: string | null; at?: string | null }[]): StageResult {
  const responded = answers.filter((a) => a.responded).sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
  const other = responded.find((a) => a.kind === 'other')
  if (other) return { status: 'other', label: other.label ?? '' }
  const approvals = responded.filter((a) => a.kind === 'approve')
  const rejections = responded.filter((a) => a.kind === 'reject')
  const n = answers.length
  if (mode === 'any') {
    const first = responded.find((a) => a.kind === 'approve' || a.kind === 'reject')
    if (!first) return null
    return { status: first.kind === 'approve' ? 'approved' : 'rejected', label: first.label ?? '' }
  }
  if (mode === 'all') {
    if (rejections.length && (rejectOnFirst || responded.length === n)) return { status: 'rejected', label: rejections[0].label ?? '' }
    if (approvals.length === n && n > 0) return { status: 'approved', label: approvals[approvals.length - 1].label ?? '' }
    return null
  }
  const q = Math.max(1, Math.min(n, Number(quorum) || 1))
  if (approvals.length >= q) return { status: 'approved', label: approvals[q - 1].label ?? '' }
  if (rejections.length > n - q) return { status: 'rejected', label: rejections[rejections.length - 1].label ?? '' }
  return null
}
