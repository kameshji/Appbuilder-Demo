/**
 * Row rules: the part of table events that only needs the record being written (shared by the server's table events
 * and the demo platform, which runs validation rules and formula columns in the browser). No I/O.
 *
 *  - the record scope: New and ThisRecord (the record as it will be stored), Old (as it was; blank on create), User(),
 *    and every column of the record by its bare name (a table of the same name wins: use ThisRecord.Name then);
 *  - SetField and Reject, the two actions of a before-event (natives for createEngine);
 *  - formula columns: dependency order, cycle detection, which inputs a formula reads.
 */
import type { FxHost, FxRecord, FxScope, FxValue } from '../contracts.ts'
import { childrenOf, freeIdentifiers, type Node } from './ast.ts'
import { def, type FnDef } from './functions/types.ts'
import { parse } from './parser.ts'
import { hasOwn, isRecord } from './values.ts'

/** what SetField and Reject call on the host the caller passes to evaluate() */
export interface RowRuleHost extends FxHost {
  setField?(column: string, value: FxValue): void
  reject?(message: string, field?: string): void
}

const hostOf = (h: FxHost | undefined): RowRuleHost | undefined => h as RowRuleHost | undefined

export const SET_FIELD: FnDef = def(
  'SetField', 'SetField({Column: value, ...})',
  'Table events that run before a write: sets columns of the record being written (later actions see the new values).', 1, 2,
  (c) => {
    const h = hostOf(c.host)
    if (!h?.setField) return c.fail(null, 'SetField works only in a table event that runs before the write.', true)
    if (c.argc === 2) {
      h.setField(c.text(0), c.value(1))
      return null
    }
    const rec = c.value(0)
    if (!isRecord(rec)) return c.fail(0, 'SetField needs a record of columns and values, like SetField({LineTotal: Qty * Price})')
    for (const k of Object.keys(rec)) if (k !== '__id') h.setField(k, rec[k]!)
    return null
  },
  'behaviour',
)

export const REJECT: FnDef = def(
  'Reject', 'Reject(message [, Column])',
  'Table events that run before a write: refuses the write with a message, shown on the form field of Column when given.', 1, 2,
  (c) => {
    const h = hostOf(c.host)
    if (!h?.reject) return c.fail(null, 'Reject works only in a table event that runs before the write.', true)
    const message = c.text(0).trim() || 'This change is not allowed.'
    const field = c.argc > 1 ? c.nameOf(1) : undefined
    h.reject(message, field || undefined)
    return c.fail(null, message, true)
  },
  'behaviour',
)

export const ROW_RULE_FUNCTIONS: FnDef[] = [SET_FIELD, REJECT]

/** User() as formulas see it */
export interface RuleUser { id?: string; name?: string; email?: string }

export function userRecord(u: RuleUser | null | undefined): FxRecord {
  return { FullName: u?.name ?? '', Email: u?.email ?? '', Image: '', Id: u?.id ?? '' }
}

/**
 * The scope of a row rule: New / ThisRecord / Old / User(), the record's columns by bare name, then `outer` (tables,
 * query bindings ...). `record` is read live: SetField changes it and later reads see the change.
 */
export function recordScope(record: FxRecord, old: FxRecord | null, user: FxRecord, outer?: FxScope, names?: { tables?: ReadonlySet<string> }): FxScope {
  return {
    resolve(name) {
      if (name === 'New' || name === 'ThisRecord') return record
      if (name === 'Old') return old ?? null
      if (name === 'User()') return user
      if (outer) {
        const v = outer.resolve(name)
        if (v !== undefined) return v
      }
      if (names?.tables?.has(name)) return undefined
      if (hasOwn(record, name)) return record[name] ?? null
      return undefined
    },
  }
}

/** which columns of the record a formula reads: bare names and New.X / ThisRecord.X / Old.X (over-approximated) */
export function formulaInputs(formula: string, columns: readonly string[]): Set<string> {
  const out = new Set<string>()
  const p = parse(formula.trim().startsWith('=') ? formula.trim() : `=${formula.trim()}`)
  if (!p.ast) return out
  const cols = new Set(columns)
  for (const id of freeIdentifiers(p.ast)) if (cols.has(id.name)) out.add(id.name)
  const visit = (n: Node): void => {
    if (n.t === 'member' && n.obj.t === 'id' && (n.obj.name === 'New' || n.obj.name === 'ThisRecord' || n.obj.name === 'Old') && cols.has(n.name)) out.add(n.name)
    for (const c of childrenOf(n)) visit(c)
  }
  visit(p.ast)
  return out
}

/**
 * Formula columns in the order they must be computed (a column after the formula columns it reads). `cycle` names the
 * columns of a circular dependency (then `order` is partial).
 */
export function formulaColumnOrder(cols: readonly { name: string; formula: string }[], allColumns: readonly string[]): { order: string[]; cycle?: string[] } {
  const formulaNames = new Set(cols.map((c) => c.name))
  const deps = new Map(cols.map((c) => [c.name, [...formulaInputs(c.formula, allColumns)].filter((n) => formulaNames.has(n) && n !== c.name)]))
  for (const c of cols) if (formulaInputs(c.formula, allColumns).has(c.name)) return { order: [], cycle: [c.name] }
  const order: string[] = []
  const state = new Map<string, 1 | 2>()
  let cycle: string[] | undefined
  const visit = (n: string, path: string[]): void => {
    if (cycle) return
    const s = state.get(n)
    if (s === 2) return
    if (s === 1) {
      cycle = [...path.slice(path.indexOf(n)), n]
      return
    }
    state.set(n, 1)
    for (const d of deps.get(n) ?? []) visit(d, [...path, n])
    state.set(n, 2)
    order.push(n)
  }
  for (const c of cols) visit(c.name, [])
  return cycle ? { order, cycle } : { order }
}
