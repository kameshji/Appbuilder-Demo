import type { FxHost, FxRecord, FxScope, FxValue } from '@/contracts'
import type { CallNode, Node } from '../ast'

/** State that lives for one evaluate() call, so later steps of `a; b` see earlier writes. */
export interface Session {
  scope: FxScope
  host: FxHost | undefined
  vars: Map<string, FxValue>
  colls: Map<string, FxRecord[]>
}

export interface CallCtx {
  readonly node: CallNode
  readonly argc: number
  readonly host: FxHost | undefined
  readonly session: Session
  argNode(i: number): Node
  /** evaluate argument i in the current scope */
  value(i: number): FxValue
  /** evaluate argument i, unwrapping `Expr As Name` */
  withAs(i: number): { value: FxValue; as?: string }
  /** evaluate argument i lazily for one row (row fields, ThisRecord and `as` in scope) */
  row(i: number, record: FxRecord, as?: string): FxValue
  /** like row() but coerced to true/false */
  rowBool(i: number, record: FxRecord, as?: string): boolean
  text(i: number): string
  num(i: number): number
  bool(i: number): boolean
  /** argument i must be a table (blank counts as empty) */
  rows(i: number, fname: string): { rows: FxRecord[]; as?: string }
  /** bare identifier -> its name, otherwise the evaluated text */
  nameOf(i: number): string
  fail(i: number | null, message: string, fatal?: boolean): never
  /** current rows of a collection, including writes made earlier in this evaluation */
  currentRows(coll: string): FxRecord[] | undefined
}

export interface FnDef {
  name: string
  signature: string
  summary: string
  kind: 'pure' | 'behaviour'
  min: number
  max: number
  run(c: CallCtx): FxValue
}

export function def(
  name: string,
  signature: string,
  summary: string,
  min: number,
  max: number,
  run: (c: CallCtx) => FxValue,
  kind: 'pure' | 'behaviour' = 'pure',
): FnDef {
  return { name, signature, summary, kind, min, max, run }
}

export const MANY = Infinity
