/**
 * Routing of approvals without a database (docs/dev/approvals.md "Routing"): every approval type and approver
 * reference, threshold rules, manager chains, self-approval, separation of duties, fallback, delegation, quorum.
 */
import { describe, expect, it } from 'vitest'
import { definitionProblems, guessKind, parseApproverRef, responsesOf } from '../../../src/platform/approvals.ts'
import { RoutingError, delegateOf, departmentHeads, expandStages, managersOf, resolveStage, stageOutcome, type OrgData, type OrgPerson } from './routing.ts'

function org(): OrgData {
  const p = (id: string, managerId: string | null, extra: Partial<OrgPerson> = {}): OrgPerson => ({ id, name: id.toUpperCase(), email: `${id}@x.io`, managerId, departmentId: 'd_ops', roleIds: [], status: 'active', ...extra })
  const people = [
    p('ceo', null, { jobTitle: 'CEO', departmentId: 'd_board' }),
    p('vp', 'ceo', { jobTitle: 'VP', roleIds: ['r_exec'] }),
    p('mgr', 'vp', { jobTitle: 'Manager' }),
    p('raj', 'mgr'),
    p('fay', 'mgr', { roleIds: ['r_fin'], departmentId: 'd_fin' }),
    p('fio', 'mgr', { roleIds: ['r_fin'], departmentId: 'd_fin' }),
    p('off', 'mgr', { status: 'disabled', roleIds: ['r_fin'] }),
    p('adm', null, { departmentId: null }),
    p('lone', null, { departmentId: null }),
  ]
  return {
    people: new Map(people.map((x) => [x.id, x])),
    roles: [{ id: 'r_fin', name: 'Finance' }, { id: 'r_exec', name: 'Executives' }],
    teams: [{ id: 't_qa', code: 'QA', name: 'Quality', memberIds: ['fay', 'raj'] }],
    departments: [{ id: 'd_ops', code: 'OPS', name: 'Operations' }, { id: 'd_fin', code: 'FIN', name: 'Finance' }, { id: 'd_board', code: 'BRD', name: 'Board' }],
    admins: ['adm'],
  }
}
const base = { delegations: [], policyKeys: [] as string[] }
const ids = (r: { assignees: { userId: string }[] }) => r.assignees.map((a) => a.userId).sort()

describe('approver references', () => {
  it('parses every form and refuses nonsense', () => {
    expect(parseApproverRef('a@b.io')).toEqual({ kind: 'user', value: 'a@b.io' })
    expect(parseApproverRef('user:usr_1')).toEqual({ kind: 'user', value: 'usr_1' })
    expect(parseApproverRef('usr_1')).toEqual({ kind: 'user', value: 'usr_1' })
    expect(parseApproverRef('role:Finance')).toEqual({ kind: 'role', value: 'Finance' })
    expect(parseApproverRef('team:QA')).toEqual({ kind: 'team', value: 'QA' })
    expect(parseApproverRef('department:FIN')).toEqual({ kind: 'department', value: 'FIN' })
    expect(parseApproverRef('department-head')).toEqual({ kind: 'departmentHead', value: null })
    expect(parseApproverRef('manager')).toEqual({ kind: 'manager', level: 1 })
    expect(parseApproverRef('manager:2')).toEqual({ kind: 'manager', level: 2 })
    expect(parseApproverRef('manager-chain:3')).toEqual({ kind: 'managerChain', levels: 3 })
    expect(parseApproverRef('manager-chain-until-title:CEO')).toMatchObject({ kind: 'managerChain', untilTitle: 'CEO' })
    expect(parseApproverRef('manager:0')).toBe(null)
    expect(parseApproverRef('bogus:thing')).toBe(null)
    expect(parseApproverRef('')).toBe(null)
  })
  it('validates definitions with field paths', () => {
    expect(definitionProblems({ type: 'single', approvers: ['a@b.io'] })).toEqual([])
    expect(definitionProblems({ type: 'quorum', approvers: ['a@b.io'] }).map((p) => p.field)).toContain('quorum')
    expect(definitionProblems({ type: 'sequential' }).map((p) => p.field)).toContain('stages')
    expect(definitionProblems({ type: 'any', approvers: ['manager-chain:2', 'a@b.io'] }).map((p) => p.message).join()).toMatch(/only approver/)
    expect(definitionProblems({ type: 'single', approvers: ['x@y.z'], escalation: { action: 'approve' } }).map((p) => p.field)).toContain('escalation')
    expect(definitionProblems({ type: 'single', approvers: ['x@y.z'], responses: [{ label: 'Reject', kind: 'reject' }] }).map((p) => p.message).join()).toMatch(/must approve/)
  })
  it('answer options: labels to kinds', () => {
    expect(responsesOf({}, ['Approve', 'Reject', 'Need more info', 'Rework']).map((r) => r.kind)).toEqual(['approve', 'reject', 'info', 'other'])
    expect(responsesOf({ requireCommentOnReject: true }).find((r) => r.kind === 'reject')?.requireComment).toBe(true)
    expect(guessKind('Sign off', 3)).toBe('approve')
  })
})

describe('resolution of each reference', () => {
  const o = org()
  it('users, roles (disabled people skipped), teams, departments, heads, managers', () => {
    expect(ids(resolveStage({ name: 's', mode: 'any', refs: ['fay@x.io', 'user:fio'] }, { org: o, requesterId: 'raj', ...base }))).toEqual(['fay', 'fio'])
    const role = resolveStage({ name: 's', mode: 'any', refs: ['role:Finance'] }, { org: o, requesterId: 'raj', ...base })
    expect(ids(role)).toEqual(['fay', 'fio'])
    expect(role.notes.some((n) => n.action === 'routing.skipped')).toBe(true)
    expect(ids(resolveStage({ name: 's', mode: 'any', refs: ['team:QA'] }, { org: o, requesterId: 'mgr', ...base }))).toEqual(['fay', 'raj'])
    expect(ids(resolveStage({ name: 's', mode: 'any', refs: ['department:FIN'] }, { org: o, requesterId: 'raj', ...base }))).toEqual(['fay', 'fio'])
    // head of Operations: the member whose manager is outside it (vp, managed by the CEO of the board)
    expect(departmentHeads(o, 'd_ops').map((p) => p.id)).toEqual(['vp'])
    expect(ids(resolveStage({ name: 's', mode: 'any', refs: ['department-head'] }, { org: o, requesterId: 'raj', ...base }))).toEqual(['vp'])
    expect(ids(resolveStage({ name: 's', mode: 'any', refs: ['manager'] }, { org: o, requesterId: 'raj', ...base }))).toEqual(['mgr'])
    expect(ids(resolveStage({ name: 's', mode: 'any', refs: ['manager:2'] }, { org: o, requesterId: 'raj', ...base }))).toEqual(['vp'])
    expect(managersOf(o, 'raj').map((p) => p.id)).toEqual(['mgr', 'vp', 'ceo'])
  })
  it('unknown references are noted; nobody left falls back to the manager, then administrators', () => {
    const r = resolveStage({ name: 's', mode: 'any', refs: ['nobody@x.io'] }, { org: o, requesterId: 'raj', ...base })
    expect(ids(r)).toEqual(['mgr'])
    expect(r.assignees[0].source).toBe('fallback')
    expect(r.notes.map((n) => n.action)).toEqual(['routing.unknown', 'routing.fallback'])
    const lone = resolveStage({ name: 's', mode: 'any', refs: ['manager'] }, { org: o, requesterId: 'lone', ...base })
    expect(ids(lone)).toEqual(['adm'])
    expect(() => resolveStage({ name: 's', mode: 'any', refs: ['manager'] }, { org: { ...o, admins: ['lone'] }, requesterId: 'lone', ...base })).toThrow(RoutingError)
  })
})

describe('rules every stage follows', () => {
  const o = org()
  it('self-approval: the requester is dropped (routed to the manager) unless allowed', () => {
    const r = resolveStage({ name: 's', mode: 'any', refs: ['raj@x.io'] }, { org: o, requesterId: 'raj', ...base })
    expect(ids(r)).toEqual(['mgr'])
    expect(r.notes.find((n) => n.action === 'routing.self')?.text).toMatch(/may not approve/)
    expect(ids(resolveStage({ name: 's', mode: 'any', refs: ['raj@x.io'] }, { org: o, requesterId: 'raj', allowSelfApproval: true, ...base }))).toEqual(['raj'])
    // a team that includes the requester: the requester is left out, the others stay
    expect(ids(resolveStage({ name: 's', mode: 'any', refs: ['team:QA'] }, { org: o, requesterId: 'raj', ...base }))).toEqual(['fay'])
  })
  it('separation of duties: who approved the previous stage is not asked again', () => {
    const r = resolveStage({ name: 's', mode: 'any', refs: ['role:Finance'] }, { org: o, requesterId: 'raj', separationOfDuties: true, previousApprovers: new Set(['fay']), ...base })
    expect(ids(r)).toEqual(['fio'])
    const all = resolveStage({ name: 's', mode: 'any', refs: ['fay@x.io'] }, { org: o, requesterId: 'raj', separationOfDuties: true, previousApprovers: new Set(['fay']), ...base })
    expect(ids(all)).toEqual(['mgr'])
    // without the option the same person may approve twice
    expect(ids(resolveStage({ name: 's', mode: 'any', refs: ['fay@x.io'] }, { org: o, requesterId: 'raj', previousApprovers: new Set(['fay']), ...base }))).toEqual(['fay'])
  })
  it('delegation: followed (chains, policy filter), never to the requester, never in a circle', () => {
    const d = [{ id: 'd1', fromUser: 'fay', toUser: 'fio', policies: [] }, { id: 'd2', fromUser: 'fio', toUser: 'vp', policies: ['Purchase'] }]
    const r = resolveStage({ name: 's', mode: 'any', refs: ['fay@x.io'] }, { org: o, requesterId: 'raj', delegations: d, policyKeys: [] })
    expect(r.assignees).toEqual([{ userId: 'fio', source: 'delegation', reassignedFrom: 'fay', delegationId: 'd1', note: 'On behalf of FAY (delegation).' }])
    expect(delegateOf('fay', { delegations: d, policyKeys: ['purchase'], org: o, requesterId: 'raj' })).toEqual({ userId: 'vp', delegationId: 'd2' })
    expect(delegateOf('fay', { delegations: [{ id: 'x', fromUser: 'fay', toUser: 'raj', policies: [] }], policyKeys: [], org: o, requesterId: 'raj' })).toBe(null)
    expect(delegateOf('fay', { delegations: [{ id: 'a', fromUser: 'fay', toUser: 'fio', policies: [] }, { id: 'b', fromUser: 'fio', toUser: 'fay', policies: [] }], policyKeys: [], org: o, requesterId: 'raj' })).toEqual({ userId: 'fio', delegationId: 'a' })
    // two approvers delegating to the same person: asked once
    const two = resolveStage({ name: 's', mode: 'all', refs: ['fay@x.io', 'fio@x.io'] }, { org: o, requesterId: 'raj', delegations: [{ id: 'a', fromUser: 'fay', toUser: 'vp', policies: [] }, { id: 'b', fromUser: 'fio', toUser: 'vp', policies: [] }], policyKeys: [] })
    expect(ids(two)).toEqual(['vp'])
  })
})

describe('stage plans', () => {
  const o = org()
  const cond = (fields: Record<string, number>) => (f: string) => {
    const m = /^(\w+)\s*>\s*(\d+)$/.exec(f.trim())
    if (!m) throw new Error('bad')
    return (fields[m[1]] ?? 0) > Number(m[2])
  }
  it('single/any/all/quorum: one stage; sequential: its stages; conditions skip stages', () => {
    expect(expandStages({ type: 'single', approvers: ['a@x.io'] }, { requesterId: 'raj', org: o, evalCondition: cond({}) }).stages).toEqual([{ name: 'Approval', mode: 'any', refs: ['a@x.io'] }])
    expect(expandStages({ type: 'all', approvers: ['a@x.io'] }, { requesterId: 'raj', org: o, evalCondition: cond({}) }).stages[0].mode).toBe('all')
    expect(expandStages({ type: 'quorum', quorum: 2, approvers: ['a', 'b', 'c'] }, { requesterId: 'raj', org: o, evalCondition: cond({}) }).stages[0]).toMatchObject({ mode: 'quorum', quorum: 2 })
    const seq = expandStages({ type: 'sequential', stages: [{ approvers: ['manager'] }, { name: 'CFO', approvers: ['role:Finance'], condition: 'Amount > 1000' }] }, { requesterId: 'raj', org: o, evalCondition: cond({ Amount: 500 }) })
    expect(seq.stages.map((s) => s.name)).toEqual(['Stage 1'])
    expect(seq.notes[0].action).toBe('stage.skipped')
  })
  it('amount thresholds add stages in order; manager chains become one stage per level', () => {
    const def = { type: 'single' as const, approvers: ['manager'], rules: [{ condition: 'Amount > 1000', approvers: ['role:Finance'] }, { name: 'Board', condition: 'Amount > 50000', approvers: ['manager-chain-until-title:CEO'] }] }
    expect(expandStages(def, { requesterId: 'raj', org: o, evalCondition: cond({ Amount: 500 }) }).stages.map((s) => s.name)).toEqual(['Approval'])
    expect(expandStages(def, { requesterId: 'raj', org: o, evalCondition: cond({ Amount: 5000 }) }).stages.map((s) => s.name)).toEqual(['Approval', 'Rule 1'])
    const big = expandStages(def, { requesterId: 'raj', org: o, evalCondition: cond({ Amount: 90000 }) }).stages
    expect(big.map((s) => `${s.name}=${s.refs.join()}`)).toEqual(['Approval=manager', 'Rule 1=role:Finance', 'Board (level 1)=user:mgr', 'Board (level 2)=user:vp', 'Board (level 3)=user:ceo'])
    const two = expandStages({ type: 'single', approvers: ['manager-chain:2'] }, { requesterId: 'raj', org: o, evalCondition: cond({}) }).stages
    expect(two.map((s) => s.refs[0])).toEqual(['user:mgr', 'user:vp'])
    const role = expandStages({ type: 'single', approvers: ['manager-chain-until-role:Executives'] }, { requesterId: 'raj', org: o, evalCondition: cond({}) }).stages
    expect(role.map((s) => s.refs[0])).toEqual(['user:mgr', 'user:vp'])
    expect(() => expandStages({ type: 'single', rules: [{ condition: 'Amount > 5', approvers: ['x@y.z'] }] }, { requesterId: 'raj', org: o, evalCondition: cond({ Amount: 1 }) })).toThrow(RoutingError)
  })
})

describe('stage outcomes', () => {
  const ans = (...xs: (['approve' | 'reject' | 'other', string] | null)[]) => xs.map((x, i) => (x ? { responded: true, kind: x[0], label: x[1], at: `2030-01-01T00:00:0${i}Z` } : { responded: false }))
  it('any: the first answer decides', () => {
    expect(stageOutcome('any', null, true, ans(null, null))).toBe(null)
    expect(stageOutcome('any', null, true, ans(null, ['reject', 'Reject']))).toEqual({ status: 'rejected', label: 'Reject' })
  })
  it('all: everyone; reject on first or after everyone answered', () => {
    expect(stageOutcome('all', null, true, ans(['approve', 'Approve'], null))).toBe(null)
    expect(stageOutcome('all', null, true, ans(['approve', 'Approve'], ['approve', 'Approve']))).toEqual({ status: 'approved', label: 'Approve' })
    expect(stageOutcome('all', null, true, ans(['reject', 'Reject'], null))).toEqual({ status: 'rejected', label: 'Reject' })
    expect(stageOutcome('all', null, false, ans(['reject', 'Reject'], null))).toBe(null)
    expect(stageOutcome('all', null, false, ans(['reject', 'Reject'], ['approve', 'Approve']))).toEqual({ status: 'rejected', label: 'Reject' })
  })
  it('quorum: N of M; rejected as soon as N cannot be reached', () => {
    expect(stageOutcome('quorum', 2, true, ans(['approve', 'A'], null, null))).toBe(null)
    expect(stageOutcome('quorum', 2, true, ans(['approve', 'A'], ['reject', 'R'], ['approve', 'A']))).toEqual({ status: 'approved', label: 'A' })
    expect(stageOutcome('quorum', 2, true, ans(['reject', 'R'], ['reject', 'R'], null))).toEqual({ status: 'rejected', label: 'R' })
    expect(stageOutcome('quorum', 5, true, ans(['approve', 'A'], ['approve', 'A']))).toEqual({ status: 'approved', label: 'A' })
  })
  it('a custom answer ends the stage with that answer', () => {
    expect(stageOutcome('all', null, true, ans(['approve', 'A'], ['other', 'Rework']))).toEqual({ status: 'other', label: 'Rework' })
  })
})
