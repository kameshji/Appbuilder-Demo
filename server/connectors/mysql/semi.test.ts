/** MySQL translation of the security engine's semi-join (relationship rules, P0 package F). */
import { describe, expect, it } from 'vitest'
import { buildWhere } from './sql.ts'
import type { TableDef } from '../../../src/platform/contracts.ts'

const def = (name: string, cols: TableDef['columns']): TableDef => ({ id: name, name, displayName: name, primaryColumn: 'id', createdOn: '', modifiedOn: '', source: `t_${name.toLowerCase()}`, columns: cols })
const lines = def('Lines', [{ name: 'Supervisor', displayName: 'Supervisor', type: 'text' }])
const prod = def('Production', [{ name: 'Line', displayName: 'Line', type: 'lookup', lookupTable: 'Lines' }])

describe('mysql semi-join', () => {
  it('compiles to IN over a derived table (usable by UPDATE / DELETE on the same table), values as parameters', () => {
    const w = buildWhere(prod, { and: [{ col: 'owner', op: 'eq', value: 'u1' }, { semi: { col: 'Line', table: lines, key: 'id', where: { col: 'Supervisor', op: 'eq', value: "x' OR 1=1 --" } } }] })
    expect(w.sql).toContain('`Line` IN (SELECT k FROM (SELECT `id` AS k FROM `t_lines` WHERE `id` IS NOT NULL AND')
    expect(w.sql).not.toContain('OR 1=1')
    expect(w.params).toContain("x' OR 1=1 --")
  })
  it('a self-referencing rule names the same table in the derived table', () => {
    const emp = def('Employees', [{ name: 'Manager', displayName: 'Manager', type: 'lookup', lookupTable: 'Employees' }, { name: 'Dept', displayName: 'Dept', type: 'text' }])
    const w = buildWhere(emp, { semi: { col: 'Manager', table: emp, key: 'id', where: { col: 'Dept', op: 'eq', value: 'QA' } } })
    expect(w.sql).toMatch(/FROM `t_employees` WHERE/)
  })
})
