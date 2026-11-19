/**
 * Pure helpers of the visual approval definition editor (P1-E): approver references <-> what the picker shows, field
 * conditions (rules on the request's fields joined by and/or) <-> formulas, moving list items. No React.
 */
import { compileFilter, parseFilter, type FilterGroup, type FilterRule } from '@/flows/designer/filter'
import { parseApproverRef } from '@/platform/approvals'

export interface ApproverDirectory {
  people: { id: string; name: string; email: string }[]
  roles: { id: string; name: string }[]
  teams: { id: string; code: string; name: string }[]
  departments: { id: string; code: string; name: string }[]
}

export type PickKind = 'person' | 'role' | 'team' | 'department' | 'departmentHead' | 'manager' | 'managerChain' | 'chainTitle' | 'chainRole'
export const PICK_KINDS: { kind: PickKind; label: string; hint: string }[] = [
  { kind: 'person', label: 'A person', hint: 'Named person (travels between environments by email).' },
  { kind: 'role', label: 'Everyone with a role', hint: 'Every member of the role in this environment.' },
  { kind: 'team', label: 'A team', hint: 'Every member of the team.' },
  { kind: 'department', label: 'A department', hint: 'Every member of the department.' },
  { kind: 'departmentHead', label: 'Department head', hint: 'The head of the requester\'s department, or of a named one.' },
  { kind: 'manager', label: 'The requester\'s manager', hint: 'Level 1 is the direct manager; 2 is their manager, and so on.' },
  { kind: 'managerChain', label: 'Manager chain (levels)', hint: 'Each manager up the line, one stage per level. Must be the only approver of its stage.' },
  { kind: 'chainTitle', label: 'Manager chain until a job title', hint: 'Up the line until (and including) the first manager with that job title, e.g. CEO.' },
  { kind: 'chainRole', label: 'Manager chain until a role', hint: 'Up the line until (and including) the first manager with that role.' },
]

/** the reference for a pick (null when the value is missing) */
export function refFor(kind: PickKind, value: string): string | null {
  const v = value.trim()
  switch (kind) {
    case 'person': return v || null
    case 'role': return v ? `role:${v}` : null
    case 'team': return v ? `team:${v}` : null
    case 'department': return v ? `department:${v}` : null
    case 'departmentHead': return v ? `department-head:${v}` : 'department-head'
    case 'manager': return !v || v === '1' ? 'manager' : /^[1-9]$/.test(v) ? `manager:${v}` : null
    case 'managerChain': return /^[1-9]$/.test(v || '2') ? `manager-chain:${v || '2'}` : null
    case 'chainTitle': return v ? `manager-chain-until-title:${v}` : null
    case 'chainRole': return v ? `manager-chain-until-role:${v}` : null
  }
}

/** a reference in words, with the directory's names */
export function refLabel(ref: string, dir: ApproverDirectory): string {
  const p = parseApproverRef(ref)
  const r = ref.trim()
  if (!p) return `${r} (not valid)`
  const low = (s: string) => s.toLowerCase()
  if (p.kind === 'user') {
    const v = p.value.replace(/^user:/, '')
    const u = dir.people.find((x) => low(x.email) === low(v) || x.id === v)
    return u ? `${u.name} (${u.email})` : v
  }
  const after = r.slice(r.indexOf(':') + 1)
  if (r.startsWith('role:')) return `Role ${dir.roles.find((x) => x.id === after || low(x.name) === low(after))?.name ?? after}`
  if (r.startsWith('team:')) { const t = dir.teams.find((x) => x.id === after || low(x.code) === low(after)); return `Team ${t ? t.name : after}` }
  if (r.startsWith('department:')) { const d = dir.departments.find((x) => low(x.code) === low(after)); return `Department ${d ? d.name : after}` }
  if (r === 'department-head') return 'Head of the requester\'s department'
  if (r.startsWith('department-head:')) { const d = dir.departments.find((x) => low(x.code) === low(after)); return `Head of ${d ? d.name : after}` }
  if (r === 'manager') return 'The requester\'s manager'
  if (/^manager:\d+$/.test(r)) return `The manager ${after} levels up`
  if (r.startsWith('manager-chain-until-title:')) return `Manager chain until "${after}"`
  if (r.startsWith('manager-chain-until-role:')) return `Manager chain until role ${dir.roles.find((x) => x.id === after || low(x.name) === low(after))?.name ?? after}`
  if (r.startsWith('manager-chain:')) return `Manager chain, ${after} level${after === '1' ? '' : 's'}`
  return r
}

/* ------------------------------------------------------------------ approvers in a flow step (a formula) */

/**
 * The flow step's approvers are a formula. A text literal of references ("manager; role:Finance") is shown in the
 * picker; anything else (Trigger.Record.Manager, a table of people) stays a formula.
 */
export function refsOfFormula(fx: string | undefined): string[] | null {
  const t = (fx ?? '').trim().replace(/^=/, '')
  if (!t) return []
  const m = /^"((?:[^"]|"")*)"$/.exec(t)
  if (!m) return null
  const refs = m[1].replace(/""/g, '"').split(/[;,\n]/).map((x) => x.trim()).filter(Boolean)
  return refs.every((r) => parseApproverRef(r)) ? refs : null
}
export const formulaOfRefs = (refs: string[]): string => (refs.length ? `"${refs.join('; ').replace(/"/g, '""')}"` : '')

/* ------------------------------------------------------------------ field conditions */

export type CondOp = FilterRule['op']
export const COND_OPS: { op: CondOp; label: string; noValue?: boolean }[] = [
  { op: 'gt', label: 'is more than' }, { op: 'ge', label: 'is at least' }, { op: 'lt', label: 'is less than' }, { op: 'le', label: 'is at most' },
  { op: 'eq', label: 'is' }, { op: 'ne', label: 'is not' }, { op: 'contains', label: 'contains' }, { op: 'blank', label: 'is blank', noValue: true }, { op: 'notBlank', label: 'is not blank', noValue: true },
]
export interface FieldRule { field: string; op: CondOp; value: string }
export interface FieldCondition { join: 'and' | 'or'; rules: FieldRule[] }

/** a value the maker typed as a formula operand: numbers and true/false as they are, everything else as text */
export function valueFx(v: string): string {
  const t = v.trim()
  if (/^-?\d+(\.\d+)?$/.test(t) || t === 'true' || t === 'false') return t
  if (/^".*"$/s.test(t)) return t
  return `"${t.replace(/"/g, '""')}"`
}
const valueText = (fx: string): string => {
  const t = fx.trim()
  const m = /^"((?:[^"]|"")*)"$/s.exec(t)
  return m ? m[1].replace(/""/g, '"') : t
}

export function compileFieldCondition(c: FieldCondition): string {
  const g: FilterGroup = { join: c.join, rules: c.rules.filter((r) => r.field.trim()).map((r) => ({ column: r.field.trim(), op: r.op, value: COND_OPS.find((o) => o.op === r.op)?.noValue ? '' : valueFx(r.value) })) }
  return compileFilter(g)
}

/** null: the formula has another shape (edit it as a formula) */
export function parseFieldCondition(fx: string | undefined, fields: string[]): FieldCondition | null {
  const t = (fx ?? '').trim()
  // field names that are not offered still parse (a condition written by hand with another field)
  const names = new Set(fields)
  for (const m of t.matchAll(/'((?:[^']|'')+)'|\b([A-Za-z_][A-Za-z0-9_]*)\b/g)) names.add((m[1] ?? m[2]).replace(/''/g, "'"))
  const g = parseFilter(t, [...names].filter((n) => !['true', 'false', 'IsBlank', 'StartsWith', 'in'].includes(n)))
  if (!g) return null
  const rules: FieldRule[] = []
  for (const r of g.rules) {
    if ('rules' in r) return null
    if (r.op === 'startsWith') return null
    rules.push({ field: r.column, op: r.op, value: valueText(r.value) })
  }
  return { join: g.join, rules }
}

export function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list
  const next = [...list]
  const [x] = next.splice(from, 1)
  next.splice(to, 0, x)
  return next
}
