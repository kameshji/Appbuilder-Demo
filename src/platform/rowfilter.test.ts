import { describe, expect, it } from 'vitest'
import { matchesCondition } from './rowfilter'
import type { RowCondition } from './contracts'

const me = { id: 'u1', email: 'a@b.c' }
const m = (op: RowCondition['op'], value: RowCondition['value'], cell: unknown) =>
  matchesCondition({ column: 'X', op, value } as RowCondition, { X: cell as never }, me)

describe('rowfilter: values of different types are not comparable (same as server/core/condition.ts)', () => {
  it('number cell vs non-numeric text', () => {
    expect(m('eq', 'abc', 5)).toBe(false)
    expect(m('ne', 'abc', 5)).toBe(true)
    for (const op of ['lt', 'le', 'gt', 'ge'] as const) expect(m(op, 'abc', 5)).toBe(false)
  })
  it('non-numeric text cell vs number', () => {
    expect(m('eq', 5, 'abc')).toBe(false)
    expect(m('ne', 5, 'abc')).toBe(true)
    for (const op of ['lt', 'le', 'gt', 'ge'] as const) expect(m(op, 5, 'abc')).toBe(false)
    expect(m('in', [5, 6], 'abc')).toBe(false)
  })
  it('numeric text still coerces', () => {
    expect(m('eq', '5', 5)).toBe(true)
    expect(m('gt', 3, '5')).toBe(true)
  })
  it('same-type comparisons are unchanged', () => {
    expect(m('eq', 'ABC', 'abc')).toBe(true)
    expect(m('lt', 'b', 'a')).toBe(true)
    expect(m('gt', 'a', 'b')).toBe(true)
    expect(m('ge', 5, 5)).toBe(true)
  })
})
