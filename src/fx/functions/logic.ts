import type { FxValue } from '@/contracts'
import { FxError } from '../errors'
import { looseEq } from '../values'
import { def, MANY, type FnDef } from './types'

export const logicFns: FnDef[] = [
  def('If', 'If(condition, then [, condition2, then2, ...] [, else])', 'Returns the result for the first condition that is true. Blank when nothing matches and no else is given.', 2, MANY, (c) => {
    let i = 0
    for (; i + 1 < c.argc; i += 2) {
      if (c.bool(i)) return c.value(i + 1)
    }
    return i < c.argc ? c.value(i) : null
  }),
  def('Switch', 'Switch(value, match1, result1 [, match2, result2, ...] [, default])', 'Compares a value with each match in turn and returns the matching result.', 3, MANY, (c) => {
    const v = c.value(0)
    let i = 1
    for (; i + 1 < c.argc; i += 2) {
      if (looseEq(v, c.value(i))) return c.value(i + 1)
    }
    return i < c.argc ? c.value(i) : null
  }),
  def('And', 'And(a, b, ...)', 'True when every argument is true.', 1, MANY, (c) => {
    for (let i = 0; i < c.argc; i++) if (!c.bool(i)) return false
    return true
  }),
  def('Or', 'Or(a, b, ...)', 'True when at least one argument is true.', 1, MANY, (c) => {
    for (let i = 0; i < c.argc; i++) if (c.bool(i)) return true
    return false
  }),
  def('Not', 'Not(value)', 'Flips true and false.', 1, 1, (c) => !c.bool(0)),
  def('IsBlank', 'IsBlank(value)', 'True when the value is blank or empty text.', 1, 1, (c) => {
    const v = c.value(0)
    return v === null || v === ''
  }),
  def('IsEmpty', 'IsEmpty(table)', 'True when a table has no rows.', 1, 1, (c) => {
    const v = c.value(0)
    if (v === null) return true
    if (Array.isArray(v)) return v.length === 0
    return c.fail(0, 'IsEmpty needs a table as its first argument')
  }),
  def('Blank', 'Blank()', 'An empty value.', 0, 0, () => null),
  def('Coalesce', 'Coalesce(a, b, ...)', 'Returns the first argument that is not blank.', 1, MANY, (c) => {
    for (let i = 0; i < c.argc; i++) {
      const v = c.value(i)
      if (v !== null && v !== '') return v
    }
    return null
  }),
  def('IfError', 'IfError(value, fallback)', 'Returns the value, or the fallback when the value is an error.', 2, 2, (c) => {
    try {
      return c.value(0)
    } catch (e) {
      if (!(e instanceof FxError) || e.fatal) throw e
    }
    return c.value(1)
  }),
  def('With', 'With(record, formula)', 'Evaluates a formula with the fields of a record available by name.', 2, 2, (c) => {
    const r = c.value(0)
    if (r === null || typeof r !== 'object' || Array.isArray(r) || r instanceof Date) {
      return c.fail(0, 'With needs a record as its first argument, like With({a: 1}, a + 1)')
    }
    return c.row(1, r as Record<string, FxValue>)
  }),
]
