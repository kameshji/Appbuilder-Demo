/**
 * Formula comparisons -> strict ConditionV2 primitives (see src/platform/query.ts and docs/dev/query-v2.md).
 *
 * Every recipe here splits a comparison into (a) the result for a non-NULL cell of the column's kind, expressed with
 * strict primitives, and (b) the result for a NULL cell, which the formula engine decides with fixed rules
 * (Blank() = 0, Blank() = "", Blank() < any date ...). (b) is a constant computed here with the engine's own value
 * functions, then joined with an explicit `isNull` branch. Anything whose result for a non-NULL cell is not a plain
 * strict comparison (numeric-looking text, text against numbers, values that would make the formula fail) is refused.
 */
import type { FxValue } from '../../contracts.ts'
import type { ColumnKind, CompareOpV2, ConditionV2, QueryLiteral } from '../../platform/query.ts'
import { FxError } from '../errors.ts'
import { compareValues, looseEq, parseNumberText } from '../values.ts'

export type DiagCode =
  | 'parse-error'
  | 'not-delegable-function'
  | 'not-delegable-predicate'
  | 'not-delegable-expression'
  | 'unknown-column'
  | 'unsupported-column'
  | 'type-mismatch'
  | 'numeric-text'
  | 'nested-table'
  | 'per-row-query'
  | 'unbounded-consumer'
  | 'group-rows'
  | 'evaluation-error'
  | 'client-evaluated'

/** Thrown while translating; becomes a QueryDiagnostic at the enclosing data-source expression. */
export class Refusal extends Error {
  code: DiagCode
  suggestion?: string
  start: number
  end: number
  constructor(code: DiagCode, message: string, at: { start: number; end: number }, suggestion?: string) {
    super(message)
    this.code = code
    this.suggestion = suggestion
    this.start = at.start
    this.end = at.end
  }
}

export type CmpOp = '=' | '<>' | '<' | '>' | '<=' | '>='
const OPS: Record<CmpOp, CompareOpV2> = { '=': 'eq', '<>': 'ne', '<': 'lt', '>': 'gt', '<=': 'le', '>=': 'ge' }
const FLIP: Record<CmpOp, CmpOp> = { '=': '=', '<>': '<>', '<': '>', '>': '<', '<=': '>=', '>=': '<=' }

interface Span { start: number; end: number }

const TRUE: ConditionV2 = { const: true }
const FALSE: ConditionV2 = { const: false }
const isConst = (c: ConditionV2): c is { const: boolean } => 'const' in c

export function isNull(col: string): ConditionV2 { return { col, op: 'isNull' } }
export function notNull(col: string): ConditionV2 { return { not: isNull(col) } }

export function and(parts: ConditionV2[]): ConditionV2 {
  const out: ConditionV2[] = []
  for (const p of parts) {
    if (isConst(p)) { if (!p.const) return FALSE; continue }
    if ('and' in p) out.push(...p.and)
    else out.push(p)
  }
  return out.length === 0 ? TRUE : out.length === 1 ? out[0]! : { and: out }
}

export function or(parts: ConditionV2[]): ConditionV2 {
  const out: ConditionV2[] = []
  for (const p of parts) {
    if (isConst(p)) { if (p.const) return TRUE; continue }
    if ('or' in p) out.push(...p.or)
    else out.push(p)
  }
  return out.length === 0 ? FALSE : out.length === 1 ? out[0]! : { or: out }
}

export function not(c: ConditionV2): ConditionV2 {
  if (isConst(c)) return { const: !c.const }
  if ('not' in c) return c.not
  return { not: c }
}

/** `part` holds for non-NULL cells (strict primitives are false on NULL); `nullResult` is the engine's answer for NULL. */
export function withNull(col: string, part: ConditionV2, nullResult: boolean): ConditionV2 {
  if (nullResult) return or([part, isNull(col)])
  if (isConst(part)) return part.const ? notNull(col) : FALSE
  return part
}

/** The engine's numericOf for text: '' and spaces are 0, "1,234.5" / "12%" / "$3" parse, anything else is not a number. */
export function numericOfText(t: string): number | undefined {
  return t.trim() === '' ? 0 : parseNumberText(t)
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
/** local calendar date of an instant, as YYYY-MM-DD (the browser holds `date` cells as local midnight) */
export function localDay(d: Date): string {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const isLocalMidnight = (d: Date): boolean => d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0
const nextDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)

function prim(col: string, op: CompareOpV2, value: QueryLiteral, exact = false): ConditionV2 {
  return exact ? { col, op, value, exact: true } : { col, op, value }
}

function datetimeLit(t: number, at: Span): QueryLiteral {
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) throw new Refusal('evaluation-error', 'That value is not a valid date', at)
  try {
    return { $datetime: d.toISOString() }
  } catch {
    throw new Refusal('evaluation-error', 'That date is out of range', at)
  }
}

/** Result for a non-NULL cell of `cell = lit` (the engine's `=`, symmetric). */
export function eqPart(col: string, kind: ColumnKind, lit: FxValue, exact: boolean, at: Span): ConditionV2 {
  if (Array.isArray(lit) || (lit !== null && typeof lit === 'object' && !(lit instanceof Date))) {
    throw new Refusal('type-mismatch', `Can't compare ${col} with a table or record`, at)
  }
  switch (kind) {
    case 'text':
      if (lit === null) return prim(col, 'eq', '')
      if (typeof lit === 'string') return prim(col, 'eq', lit, exact)
      if (lit instanceof Date) return FALSE
      throw new Refusal('type-mismatch', `${col} is text; comparing it with ${typeof lit === 'number' ? 'a number' : 'true/false'} can't run on the server`, at,
        `Compare with text, like ${col} = Text(...)`)
    case 'number':
      if (lit === null) return prim(col, 'eq', 0)
      if (typeof lit === 'number') return prim(col, 'eq', lit)
      if (typeof lit === 'string') {
        const n = numericOfText(lit)
        return n === undefined ? FALSE : prim(col, 'eq', n)
      }
      return FALSE
    case 'boolean':
      if (lit === null) return prim(col, 'eq', false)
      if (typeof lit === 'boolean') return prim(col, 'eq', lit)
      if (typeof lit === 'string') {
        const n = numericOfText(lit)
        if (n !== undefined) return n === 1 ? prim(col, 'eq', true) : n === 0 ? prim(col, 'eq', false) : FALSE
        const s = exact ? lit : lit.toLowerCase()
        return s === 'true' ? prim(col, 'eq', true) : s === 'false' ? prim(col, 'eq', false) : FALSE
      }
      return FALSE
    case 'date':
      if (lit instanceof Date && !Number.isNaN(lit.getTime())) return isLocalMidnight(lit) ? prim(col, 'eq', { $date: localDay(lit) }) : FALSE
      return FALSE
    case 'datetime':
      if (lit instanceof Date && !Number.isNaN(lit.getTime())) return prim(col, 'eq', datetimeLit(lit.getTime(), at))
      return FALSE
    default:
      throw new Refusal('unsupported-column', `${col} can't be used in a condition that runs on the server`, at)
  }
}

/** Result for a non-NULL cell of `cell OP lit` for an ordering operator (cell on the left). */
function ordPart(col: string, kind: ColumnKind, op: CompareOpV2, lit: FxValue, at: Span): ConditionV2 {
  if (Array.isArray(lit) || (lit !== null && typeof lit === 'object' && !(lit instanceof Date))) {
    throw new Refusal('type-mismatch', `Can't compare ${col} with a table or record`, at)
  }
  if (kind === 'date' || kind === 'datetime') {
    if (lit === null) return op === 'gt' || op === 'ge' ? TRUE : FALSE
    let t: number
    if (lit instanceof Date) t = lit.getTime()
    else if (typeof lit === 'number') t = lit
    else if (typeof lit === 'boolean') t = lit ? 1 : 0
    else {
      const p = Date.parse(lit)
      const n = Number.isNaN(p) ? numericOfText(lit) : p
      if (n === undefined) throw new Refusal('evaluation-error', `Can't turn the text "${lit}" into a date`, at)
      t = n
    }
    if (!Number.isFinite(t)) throw new Refusal('evaluation-error', 'That value is not a valid date', at)
    if (kind === 'datetime') return prim(col, op, datetimeLit(t, at))
    // calendar date c held as local midnight m(c): m(c) < t  <=>  c < ceil(t);  m(c) <= t  <=>  c <= floor(t)
    const d = new Date(t)
    if (Number.isNaN(d.getTime())) throw new Refusal('evaluation-error', 'That value is not a valid date', at)
    const floor = new Date(d.getFullYear(), d.getMonth(), d.getDate())
    const ceil = floor.getTime() === t ? floor : nextDay(floor)
    switch (op) {
      case 'lt': return prim(col, 'lt', { $date: localDay(ceil) })
      case 'le': return prim(col, 'le', { $date: localDay(floor) })
      case 'gt': return prim(col, 'gt', { $date: localDay(floor) })
      default: return prim(col, 'ge', { $date: localDay(ceil) })
    }
  }
  if (lit instanceof Date) throw new Refusal('type-mismatch', `${col} isn't a date; comparing it with a date can't run on the server`, at)
  switch (kind) {
    case 'text':
      if (typeof lit === 'string' && numericOfText(lit) === undefined) return prim(col, op, lit)
      throw new Refusal('numeric-text', `Ordering text against ${typeof lit === 'string' ? (lit.trim() === '' ? 'empty text' : 'number-like text') : 'a number or blank'} compares numbers in some rows and text in others, so it can't run on the server`, at,
        lit === null || lit === '' ? `Use !IsBlank(${col}) to test for a value` : `Store the value in a number column, or compare with = instead`)
    case 'number':
      if (lit === null) return prim(col, op, 0)
      if (typeof lit === 'number') return prim(col, op, lit)
      if (typeof lit === 'boolean') return prim(col, op, lit ? 1 : 0)
      {
        const n = numericOfText(lit)
        if (n === undefined) throw new Refusal('type-mismatch', `${col} is a number; comparing it with the text "${lit}" can't run on the server`, at, 'Compare with a number, like Value(...)')
        return prim(col, op, n)
      }
    case 'boolean':
      throw new Refusal('type-mismatch', `Ordering true/false values (${col}) can't run on the server`, at, `Use ${col} = true or ${col} = false`)
    default:
      throw new Refusal('unsupported-column', `${col} can't be used in a condition that runs on the server`, at)
  }
}

function negateNonNull(part: ConditionV2, col: string): ConditionV2 {
  if (isConst(part)) return { const: !part.const }
  if ('op' in part && part.op === 'eq') return { ...part, op: 'ne' }
  return and([not(part), notNull(col)])
}

/** The engine's answer for a NULL cell: evaluates the operator itself; a failure means the formula would fail. */
function nullAnswer(op: CmpOp, lit: FxValue, litOnLeft: boolean, exact: boolean, at: Span): boolean {
  const a = litOnLeft ? lit : null
  const b = litOnLeft ? null : lit
  if (op === '=') return looseEq(a, b, exact)
  if (op === '<>') return !looseEq(a, b, exact)
  try {
    const r = compareValues(a, b, at)
    return op === '<' ? r < 0 : op === '>' ? r > 0 : op === '<=' ? r <= 0 : r >= 0
  } catch (e) {
    if (e instanceof FxError) throw new Refusal('evaluation-error', e.message, at)
    throw e
  }
}

/** `col OP lit` (or `lit OP col` when litOnLeft) with the engine's semantics, as a two-valued ConditionV2. */
export function compareColumnLiteral(col: string, kind: ColumnKind, op: CmpOp, lit: FxValue, litOnLeft: boolean, at: Span, exact = false, onlyNonNull = false): ConditionV2 {
  if (kind === 'other') throw new Refusal('unsupported-column', `${col} can't be used in a condition that runs on the server`, at)
  const nullRes = onlyNonNull ? false : nullAnswer(op, lit, litOnLeft, exact, at)
  const cellOp = litOnLeft ? FLIP[op] : op
  let part: ConditionV2
  if (cellOp === '=') part = eqPart(col, kind, lit, exact, at)
  else if (cellOp === '<>') part = negateNonNull(eqPart(col, kind, lit, exact, at), col)
  else part = ordPart(col, kind, OPS[cellOp], lit, at)
  return withNull(col, part, nullRes)
}

/** `col in [a, b, ...]`: the cell equals one of the values (engine `=` per item). */
export function inList(col: string, kind: ColumnKind, items: FxValue[], exact: boolean, at: Span): ConditionV2 {
  if (kind === 'other') throw new Refusal('unsupported-column', `${col} can't be used in a condition that runs on the server`, at)
  let nullRes = false
  const values: QueryLiteral[] = []
  for (const it of items) {
    if (looseEq(null, it, exact)) nullRes = true
    const p = eqPart(col, kind, it, exact, at)
    if (isConst(p)) {
      if (p.const) return nullRes || items.some((x) => looseEq(null, x, exact)) ? TRUE : notNull(col)
      continue
    }
    if ('op' in p && p.op === 'eq') {
      const v = (p as { value: QueryLiteral }).value
      if (!values.some((x) => JSON.stringify(x) === JSON.stringify(v))) values.push(v)
    }
  }
  const part: ConditionV2 = values.length === 0 ? FALSE : values.length === 1 ? prim(col, 'eq', values[0]!, exact && kind === 'text')
    : exact && kind === 'text' ? { col, op: 'in', value: values, exact: true } : { col, op: 'in', value: values }
  return withNull(col, part, nullRes)
}

/** contains / startsWith / endsWith on a text column; the engine reads a NULL cell as '' */
export function textMatch(col: string, kind: ColumnKind, op: 'contains' | 'startsWith' | 'endsWith', needle: string, exact: boolean, at: Span): ConditionV2 {
  if (kind !== 'text') throw new Refusal('unsupported-column', `${col} isn't a text column, so this text test can't run on the server`, at)
  if (needle === '') return TRUE
  return exact ? { col, op, value: needle, exact: true } : { col, op, value: needle }
}

/** `a OP b` for two columns of the same kind. */
export function compareColumns(a: string, b: string, kind: ColumnKind, op: CmpOp, at: Span): ConditionV2 {
  if (kind === 'other') throw new Refusal('unsupported-column', `${a} can't be used in a condition that runs on the server`, at)
  const ordering = op !== '=' && op !== '<>'
  if (ordering && (kind === 'text' || kind === 'boolean')) {
    throw new Refusal(kind === 'text' ? 'numeric-text' : 'type-mismatch', `Ordering two ${kind === 'text' ? 'text' : 'true/false'} columns can't run on the server`, at)
  }
  const both: ConditionV2 = { col: a, op: 'cmpCol', cmp: OPS[op], other: b }
  if (kind === 'date' || kind === 'datetime') {
    // NULL counts as before every date: NULL = d false; NULL < d true; d < NULL false; NULL = NULL true
    const aNullBSet = op === '<>' || op === '<' || op === '<=' ? notNull(b) : FALSE
    const bNullASet = op === '<>' || op === '>' || op === '>=' ? notNull(a) : FALSE
    const bothNull = op === '=' || op === '<=' || op === '>='
    return or([both, and([isNull(a), aNullBSet]), and([isNull(b), bNullASet]), bothNull ? and([isNull(a), isNull(b)]) : FALSE])
  }
  const zero: FxValue = kind === 'number' ? 0 : kind === 'boolean' ? false : ''
  // NULL behaves as the kind's zero value against a non-NULL cell (Blank() = 0, Blank() = "", Blank() = false)
  // (the both-NULL case is its own branch, so these only need to hold for a non-NULL other column)
  const bPart = (): ConditionV2 => compareColumnLiteral(b, kind, op, zero, true, at, false, true)
  const aPart = (): ConditionV2 => compareColumnLiteral(a, kind, op, zero, false, at, false, true)
  const bothNull = op === '=' || op === '<=' || op === '>='
  return or([both, and([isNull(a), bPart()]), and([isNull(b), aPart()]), bothNull ? and([isNull(a), isNull(b)]) : FALSE])
}
