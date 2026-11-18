/**
 * Organisation scopes, relationship rules, tokens and sharing (src/platform/orgsec.ts): the shared corpus
 * (testdata/orgsec-corpus.json) through the demo-mode evaluator (rowfilter.ts matchesLeaf + memorySemi, what core.ts
 * uses) and through the server's in-memory evaluator (server/core/condition.ts evaluateWithSemi, used for WITH CHECK),
 * plus unit tests of the organisation sets. The same corpus runs against PostgreSQL in
 * server/core/orgsec.integration.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { corpus, directory, envFor, labelOf, roleFor, tableByName, typedRows, ENV_ID } from './testdata/orgsec-corpus.ts'
import {
  departmentCycle, departmentSubtree, evaluateSync, managerCycle, memorySemi, orgContextFor, reportsTreeOf, rowPredicateFor, ruleProblems,
  userOrgInfo, MAX_ORG_DEPTH,
} from './orgsec.ts'
import type { OrgDirectory } from './orgsec.ts'
import { matchesLeaf } from './rowfilter.ts'
import { evaluateCondition, evaluateWithSemi } from '../../server/core/condition.ts'
import type { RawRow } from '../../server/core/contracts.ts'
import type { TableDef } from './contracts.ts'
import { userRecord } from './contracts.ts'

const rowsOf = (t: TableDef) => typedRows(t.name)

describe('orgsec corpus: demo-mode evaluator', () => {
  for (const c of corpus.cases) {
    it(c.name, () => {
      const t = tableByName(c.table)
      const pred = rowPredicateFor([roleFor(c)], t, c.op, envFor(c.user), false)
      const ev = { leaf: matchesLeaf, semi: memorySemi(rowsOf, matchesLeaf) }
      const got = typedRows(c.table).filter((r) => evaluateSync(pred, r, ev)).map((r) => labelOf(t, r))
      expect(got.sort()).toEqual([...c.expect].sort())
    })
  }
})

describe('orgsec corpus: server in-memory evaluator (WITH CHECK path)', () => {
  for (const c of corpus.cases) {
    it(c.name, async () => {
      const t = tableByName(c.table)
      const pred = rowPredicateFor([roleFor(c)], t, c.op, envFor(c.user), false)
      const semi = async (s: { table: TableDef; key: string; where: Parameters<typeof evaluateCondition>[0] }, value: unknown): Promise<boolean> => {
        for (const r of rowsOf(s.table)) {
          const k = r[s.key]
          if (k === null || k === undefined || String(k).toLowerCase() !== String(value).toLowerCase()) continue
          if (await evaluateWithSemi(s.where, r as RawRow, semi)) return true
        }
        return false
      }
      const got: string[] = []
      for (const r of typedRows(c.table)) if (await evaluateWithSemi(pred, r as RawRow, semi)) got.push(labelOf(t, r))
      expect(got.sort()).toEqual([...c.expect].sort())
    })
  }
})

describe('organisation sets', () => {
  it('department subtree and reporting line are cycle-safe and depth-capped', () => {
    expect(departmentSubtree(directory, 'd_plant').sort()).toEqual(['d_line1', 'd_line2', 'd_pack', 'd_plant'])
    expect(reportsTreeOf(directory, 'u_cyc_a')).toEqual(['u_cyc_b'])
    const cyclic: OrgDirectory = { ...directory, departments: [{ id: 'x', code: 'X', name: 'X', parentId: 'y' }, { id: 'y', code: 'Y', name: 'Y', parentId: 'x' }] }
    expect(departmentSubtree(cyclic, 'x').sort()).toEqual(['x', 'y'])
    // a chain deeper than the cap stops at MAX_ORG_DEPTH levels
    const users = Array.from({ length: MAX_ORG_DEPTH + 10 }, (_, i) => ({ id: `c${i}`, name: `c${i}`, email: `c${i}@x`, ...(i ? { managerId: `c${i - 1}` } : {}) }))
    expect(reportsTreeOf({ departments: [], teams: [], users }, 'c0')).toHaveLength(MAX_ORG_DEPTH)
  })

  it('cycle checks for manager and department changes', () => {
    expect(managerCycle(directory, 'u_plant', 'u_op1')).toBe(true)
    expect(managerCycle(directory, 'u_op1', 'u_op1')).toBe(true)
    expect(managerCycle(directory, 'u_op1', 'u_sup2')).toBe(false)
    expect(departmentCycle(directory, 'd_plant', 'd_pack')).toBe(true)
    expect(departmentCycle(directory, 'd_pack', 'd_line1')).toBe(false)
  })

  it('moved department: the tree follows the new parent', () => {
    const moved: OrgDirectory = { ...directory, departments: directory.departments.map((d) => (d.id === 'd_pack' ? { ...d, parentId: 'd_line1' } : d)) }
    expect(orgContextFor(moved, 'u_sup1', ENV_ID).departmentTreeUsers.sort()).toEqual(['u_op1', 'u_pack', 'u_sup1'])
    expect(orgContextFor(moved, 'u_sup2', ENV_ID).departmentTreeUsers.sort()).toEqual(['u_op2', 'u_sup2'])
  })

  it('removed team member: loses the team scope', () => {
    const removed: OrgDirectory = { ...directory, teams: directory.teams.map((t) => (t.id === 't_qa' ? { ...t, memberIds: ['u_op2'] } : t)) }
    const ctx = orgContextFor(removed, 'u_op1', ENV_ID)
    expect(ctx.teams).toEqual([])
    expect(ctx.teammates).toEqual([])
  })

  it('teams of another environment do not count', () => {
    expect(orgContextFor(directory, 'u_plant', ENV_ID).teams).toEqual([])
    expect(orgContextFor(directory, 'u_plant', 'other').teams).toEqual(['t_other_env'])
  })

  it('User() gains Department, DepartmentCode, Manager, JobTitle and Teams', () => {
    const info = userOrgInfo(directory, 'u_op1', ENV_ID)
    const rec = userRecord({ id: 'u_op1', name: 'Operator One', email: 'op1@x.io', roleIds: [], jobTitle: 'Operator', org: info }, [])
    expect(rec.Department).toBe('Line 1')
    expect(rec.DepartmentCode).toBe('LINE1')
    expect(rec.Manager).toEqual({ FullName: 'Supervisor One', Email: 'sup1@x.io', Id: 'u_sup1' })
    expect(rec.JobTitle).toBe('Operator')
    expect(rec.Teams).toEqual([{ Name: 'Quality', Code: 'QA', Id: 't_qa' }])
    const none = userRecord({ id: 'x', name: 'X', email: 'x@x', roleIds: [] }, [])
    expect(none.Department).toBe(null)
    expect(none.Teams).toEqual([])
  })
})

describe('rule validation', () => {
  const prod = tableByName('Production')
  it('accepts paths, exists and tokens; refuses typos, bad paths, missing correlation', () => {
    expect(ruleProblems(prod, [{ column: 'Line.Supervisor', op: 'eq', value: '@me' }], corpus.tables)).toEqual([])
    expect(ruleProblems(tableByName('Students'), [{ exists: { table: 'Enrolments', where: [{ column: 'Student', op: 'eq', value: '@this' }, { column: 'Section.Teacher', op: 'eq', value: '@me' }] } }], corpus.tables)).toEqual([])
    expect(ruleProblems(prod, [{ column: 'owner', op: 'eq', value: '@ME' }], corpus.tables)[0]).toContain('not a known token')
    expect(ruleProblems(prod, [{ column: 'Batch.X', op: 'eq', value: 'x' }], corpus.tables)).toHaveLength(1)
    expect(ruleProblems(prod, [{ column: 'Line.Supervisor.X.Y', op: 'eq', value: 'x' }], corpus.tables)[0]).toContain('at most 2')
    expect(ruleProblems(tableByName('Students'), [{ exists: { table: 'Enrolments', where: [{ column: 'Section.Teacher', op: 'eq', value: '@me' }] } }], corpus.tables)[0]).toContain('exactly once')
    expect(ruleProblems(prod, [{ column: 'owner', op: 'eq', value: '@this' }], corpus.tables)[0]).toContain('related-rows')
    // tables of another connection cannot be joined
    expect(ruleProblems(prod, [{ column: 'Line.Supervisor', op: 'eq', value: '@me' }], corpus.tables, () => false).length).toBe(1)
    // list tokens only with is / is not
    expect(ruleProblems(prod, [{ column: 'owner', op: 'lt', value: '@myTeams' }], corpus.tables)).toHaveLength(1)
  })

  it('compiles a path to a semi-join on the lookup target (no SQL text in the rule)', () => {
    const pred = rowPredicateFor([roleFor(corpus.cases.find((c) => c.name.startsWith('lookup path: Line'))!)], prod, 'read', envFor('u_sup2'), false)
    const semi = JSON.stringify(pred).includes('"semi"')
    expect(semi).toBe(true)
    // evaluateCondition (no database) fails closed on a semi-join
    expect(evaluateCondition(pred, { Line: 'x' } as RawRow)).toBe(false)
  })
})
