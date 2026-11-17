import type { FxValue } from '@/contracts'
import { FxError } from '../errors'
import { isRecord, looseEq, parseNumberText, toBool, toText } from '../values'
import { def, MANY, type CallCtx, type FnDef } from './types'

/** Evaluates argument i; non-fatal engine errors become `failed`. Fatal ones (unknown names...) still propagate. */
function trap(c: CallCtx, i: number): { failed: boolean; value: FxValue } {
  try {
    return { failed: false, value: c.value(i) }
  } catch (e) {
    if (e instanceof FxError && !e.fatal) return { failed: true, value: null }
    throw e
  }
}

function hostValue(c: CallCtx, key: string): FxValue | undefined {
  try {
    return c.session.scope.resolve(key)
  } catch (e) {
    return c.fail(null, e instanceof Error && e.message ? e.message : `Couldn't read ${key}`, true)
  }
}

function newGuid(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  if (g.crypto?.randomUUID) return g.crypto.randomUUID()
  const h = (n: number): string => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `${h(8)}-${h(4)}-4${h(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${h(3)}-${h(12)}`
}

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
  def('IfError', 'IfError(value, fallback [, value2, fallback2, ...] [, default])', 'Returns the value, or the fallback when the value is an error. With more pairs, the first value that fails gives its fallback; the optional last argument is used when nothing failed. FirstError.Message is available in fallbacks.', 2, MANY, (c) => {
    const pairs = Math.floor(c.argc / 2)
    let last: FxValue = null
    for (let p = 0; p < pairs; p++) {
      try {
        last = c.value(p * 2)
      } catch (e) {
        if (!(e instanceof FxError) || e.fatal) throw e
        return c.fields(p * 2 + 1, { FirstError: { Message: e.message, Kind: 'Custom' } })
      }
    }
    return c.argc % 2 === 1 ? c.value(c.argc - 1) : last
  }),
  def('IsError', 'IsError(value)', 'True when calculating the value gives an error.', 1, 1, (c) => trap(c, 0).failed),
  def('IsBlankOrError', 'IsBlankOrError(value)', 'True when the value is blank, empty text or an error.', 1, 1, (c) => {
    const t = trap(c, 0)
    return t.failed || t.value === null || t.value === ''
  }),
  def('Error', 'Error(text)', 'Raises an error with a message. Use it with IfError or IsError.', 1, 1, (c) => {
    const v = c.value(0)
    let msg = ''
    if (isRecord(v)) msg = typeof v.Message === 'string' ? v.Message : ''
    else msg = toText(v, c.argNode(0))
    return c.fail(null, msg === '' ? 'An error occurred' : msg)
  }),
  def('IsNumeric', 'IsNumeric(value)', 'True for a number, or for text that can be read as a number.', 1, 1, (c) => {
    const v = c.value(0)
    if (typeof v === 'number') return Number.isFinite(v)
    if (typeof v === 'string') return parseNumberText(v) !== undefined
    return false
  }),
  def('Boolean', 'Boolean(value)', 'Turns text such as "true" or a number into true/false. Blank stays blank.', 1, 1, (c) => {
    const v = c.value(0)
    return v === null ? null : toBool(v, c.argNode(0))
  }),
  def('Language', 'Language()', 'The language of the user, such as "en-US".', 0, 0, () => 'en-US'),
  def('GUID', 'GUID([text])', 'A new random unique id, or the GUID that the text spells.', 0, 1, (c) => {
    if (c.argc === 1) {
      const t = c.text(0).trim().replace(/^\{|\}$/g, '').toLowerCase()
      if (!/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/.test(t)) return c.fail(0, `Can't turn "${t}" into a GUID`)
      const h = t.replace(/-/g, '')
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
    }
    return newGuid()
  }),
  def('User', 'User()', 'The signed-in user: a record with FullName, Email and Image.', 0, 0, (c) => {
    const v = hostValue(c, 'User()')
    return v === undefined || v === null ? { FullName: '', Email: '', Image: '' } : v
  }),
  def('Param', 'Param(name)', 'A value passed to the app in the address, such as the id in #run-app?id=5. Blank when missing.', 1, 1, (c) => {
    const v = hostValue(c, 'Param:' + c.text(0))
    return v === undefined ? null : v
  }),
  def('With', 'With(record, formula)', 'Evaluates a formula with the fields of a record available by name.', 2, 2, (c) => {
    const r = c.value(0)
    if (r === null || typeof r !== 'object' || Array.isArray(r) || r instanceof Date) {
      return c.fail(0, 'With needs a record as its first argument, like With({a: 1}, a + 1)')
    }
    return c.row(1, r as Record<string, FxValue>)
  }),
]
