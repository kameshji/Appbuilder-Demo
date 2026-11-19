import { describe, expect, it } from 'vitest'
import { compileFieldCondition, formulaOfRefs, move, parseFieldCondition, refFor, refLabel, refsOfFormula, valueFx } from './definitionKit'
import { definitionProblems, parseApproverRef } from '@/platform/approvals'

const dir = {
  people: [{ id: 'u1', name: 'Asha Rao', email: 'asha@example.com' }],
  roles: [{ id: 'role_fin', name: 'Finance' }],
  teams: [{ id: 't1', code: 'QA', name: 'Quality' }],
  departments: [{ id: 'd1', code: 'FIN', name: 'Finance dept' }],
}

describe('approval definition editor kit', () => {
  it('every pick makes a valid approver reference, shown in words', () => {
    const picks: [Parameters<typeof refFor>[0], string, string, string][] = [
      ['person', 'asha@example.com', 'asha@example.com', 'Asha Rao (asha@example.com)'],
      ['role', 'Finance', 'role:Finance', 'Role Finance'],
      ['team', 'QA', 'team:QA', 'Team Quality'],
      ['department', 'FIN', 'department:FIN', 'Department Finance dept'],
      ['departmentHead', '', 'department-head', "Head of the requester's department"],
      ['departmentHead', 'FIN', 'department-head:FIN', 'Head of Finance dept'],
      ['manager', '1', 'manager', "The requester's manager"],
      ['manager', '2', 'manager:2', 'The manager 2 levels up'],
      ['managerChain', '3', 'manager-chain:3', 'Manager chain, 3 levels'],
      ['chainTitle', 'CEO', 'manager-chain-until-title:CEO', 'Manager chain until "CEO"'],
      ['chainRole', 'Finance', 'manager-chain-until-role:Finance', 'Manager chain until role Finance'],
    ]
    for (const [k, v, ref, label] of picks) {
      expect(refFor(k, v)).toBe(ref)
      expect(parseApproverRef(ref), ref).not.toBeNull()
      expect(refLabel(ref, dir)).toBe(label)
    }
    expect(refFor('role', '')).toBeNull()
  })
  it('the step approvers formula: a literal of references round-trips; anything else stays a formula', () => {
    expect(formulaOfRefs(['manager', 'role:Finance'])).toBe('"manager; role:Finance"')
    expect(refsOfFormula('"manager; role:Finance"')).toEqual(['manager', 'role:Finance'])
    expect(refsOfFormula('Trigger.Record.Manager')).toBeNull()
    expect(refsOfFormula('')).toEqual([])
  })
  it('field conditions compile to formulas and parse back; other shapes stay formulas', () => {
    const c = { join: 'and' as const, rules: [{ field: 'Amount', op: 'gt' as const, value: '50000' }, { field: 'Cost centre', op: 'eq' as const, value: 'FIN "A"' }] }
    const fx = compileFieldCondition(c)
    expect(fx).toBe(`Amount > 50000 && 'Cost centre' = "FIN ""A"""`)
    expect(parseFieldCondition(fx, ['Amount'])).toEqual(c)
    expect(parseFieldCondition('Amount > 10000 || IsBlank(Note)', [])).toEqual({ join: 'or', rules: [{ field: 'Amount', op: 'gt', value: '10000' }, { field: 'Note', op: 'blank', value: '' }] })
    expect(parseFieldCondition('Len(Note) > 3', [])).toBeNull()
    expect(valueFx('true')).toBe('true')
    expect(valueFx('x')).toBe('"x"')
  })
  it('the maker guide examples are expressible without JSON and valid', () => {
    // Purchase: sequential Manager then Finance (> 10000), rule > 500000 -> chain until CEO, due 48 h, escalate to the manager
    const purchase = {
      type: 'sequential' as const, dueMinutes: 48 * 60, escalation: { action: 'manager' as const },
      stages: [{ name: 'Manager', approvers: [refFor('manager', '1')!] }, { name: 'Finance', approvers: [refFor('role', 'Finance')!], condition: compileFieldCondition({ join: 'and', rules: [{ field: 'Amount', op: 'gt', value: '10000' }] }) }],
      rules: [{ name: 'Board', condition: compileFieldCondition({ join: 'and', rules: [{ field: 'Amount', op: 'gt', value: '500000' }] }), approvers: [refFor('chainTitle', 'CEO')!] }],
    }
    const leave = { type: 'single' as const, approvers: ['manager'], responses: [{ label: 'Approve', kind: 'approve' as const }, { label: 'Reject', kind: 'reject' as const, requireComment: true }] }
    const signOff = { type: 'all' as const, approvers: ['team:QA', 'department-head'], responses: [{ label: 'Sign off', kind: 'approve' as const }, { label: 'Send back', kind: 'reject' as const, requireComment: true }] }
    const ncr = { type: 'single' as const, approvers: ['role:Quality'], responses: [{ label: 'Use as is', kind: 'approve' as const }, { label: 'Scrap', kind: 'reject' as const, requireComment: true }, { label: 'Rework', kind: 'other' as const }, { label: 'Need more info', kind: 'info' as const }] }
    const staged = { type: 'sequential' as const, escalation: { action: 'nextStage' as const }, stages: [{ approvers: ['manager'], dueMinutes: 60 }] }
    for (const d of [purchase, leave, signOff, ncr, staged]) expect(definitionProblems(d)).toEqual([])
    expect(move([1, 2, 3], 2, 0)).toEqual([3, 1, 2])
  })
})
