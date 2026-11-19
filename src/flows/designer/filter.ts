/**
 * The visual filter builder of List rows (and "find a row" of Get a row): rules on columns joined by "and" / "or", with
 * one level of groups, compiled to the step's `filter` formula (row scope: column names refer to the rows) and parsed
 * back when the formula has that shape (otherwise the field opens in the formula editor, "advanced"). Pure.
 */
import { parse } from '@/fx/parser'
import type { Node } from '@/fx/ast'

export type FilterOp = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'contains' | 'startsWith' | 'blank' | 'notBlank'
export interface FilterRule { column: string; op: FilterOp; value: string }
export interface FilterGroup { join: 'and' | 'or'; rules: (FilterRule | FilterGroup)[] }

export const OPS: { op: FilterOp; label: string; types?: string[]; noValue?: boolean }[] = [
  { op: 'eq', label: 'is' },
  { op: 'ne', label: 'is not' },
  { op: 'lt', label: 'is less than', types: ['number', 'date'] },
  { op: 'le', label: 'is at most', types: ['number', 'date'] },
  { op: 'gt', label: 'is more than', types: ['number', 'date'] },
  { op: 'ge', label: 'is at least', types: ['number', 'date'] },
  { op: 'contains', label: 'contains', types: ['text'] },
  { op: 'startsWith', label: 'starts with', types: ['text'] },
  { op: 'blank', label: 'is blank', noValue: true },
  { op: 'notBlank', label: 'is not blank', noValue: true },
]

const BIN: Partial<Record<FilterOp, string>> = { eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>=' }
const isGroup = (r: FilterRule | FilterGroup): r is FilterGroup => 'rules' in r
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const col = (c: string) => (IDENT.test(c) ? c : `'${c.replace(/'/g, "''")}'`)

/** a value formula as an operand: parenthesised unless it is a single term */
function operand(v: string): string {
  const t = v.trim().replace(/^=/, '')
  if (!t) return 'Blank()'
  const p = parse(`=${t}`)
  if (!p.ast) return `(${t})`
  return p.ast.t === 'bin' || p.ast.t === 'chain' || p.ast.t === 'unary' ? `(${t})` : t
}

function ruleFx(r: FilterRule): string {
  switch (r.op) {
    case 'blank': return `IsBlank(${col(r.column)})`
    case 'notBlank': return `!IsBlank(${col(r.column)})`
    case 'contains': return `${operand(r.value)} in ${col(r.column)}`
    case 'startsWith': return `StartsWith(${col(r.column)}, ${operand(r.value)})`
    default: return `${col(r.column)} ${BIN[r.op]} ${operand(r.value)}`
  }
}

/** the filter formula ('' when there are no complete rules) */
export function compileFilter(g: FilterGroup, nested = false): string {
  const parts = g.rules
    .map((r) => (isGroup(r) ? compileFilter(r, true) : r.column ? ruleFx(r) : ''))
    .filter(Boolean)
  if (!parts.length) return ''
  const s = parts.join(g.join === 'and' ? ' && ' : ' || ')
  return nested && parts.length > 1 ? `(${s})` : s
}

const textOf = (src: string, n: Node): string => src.slice(n.start, n.end)

/** a builder for a formula, or null when the formula has another shape (edit it as a formula) */
export function parseFilter(fx: string | undefined, columns: string[]): FilterGroup | null {
  const t = (fx ?? '').trim().replace(/^=/, '')
  if (!t) return { join: 'and', rules: [] }
  const src = `=${t}`
  const p = parse(src)
  if (!p.ast) return null
  const cols = new Set(columns)
  const colName = (n: Node): string | null => (n.t === 'id' && cols.has(n.name) ? n.name : null)
  const rule = (n: Node): FilterRule | null => {
    if (n.t === 'bin') {
      const op = (Object.entries(BIN).find(([, v]) => v === n.op)?.[0] ?? null) as FilterOp | null
      if (op) {
        const c = colName(n.left)
        if (c) return { column: c, op, value: textOf(src, n.right) }
        return null
      }
      if (n.op === 'in') {
        const c = colName(n.right)
        if (c) return { column: c, op: 'contains', value: textOf(src, n.left) }
      }
      return null
    }
    if (n.t === 'call' && n.name === 'IsBlank' && n.args.length === 1 && colName(n.args[0])) return { column: colName(n.args[0])!, op: 'blank', value: '' }
    if (n.t === 'unary' && n.op === '!' && n.arg.t === 'call' && n.arg.name === 'IsBlank' && n.arg.args.length === 1 && colName(n.arg.args[0])) return { column: colName(n.arg.args[0])!, op: 'notBlank', value: '' }
    if (n.t === 'call' && n.name === 'StartsWith' && n.args.length === 2 && colName(n.args[0])) return { column: colName(n.args[0])!, op: 'startsWith', value: textOf(src, n.args[1]) }
    return null
  }
  const strip = (v: string) => v.replace(/^\((.*)\)$/s, (m, inner) => {
    const q = parse(`=${inner}`)
    return q.ast ? inner : m
  })
  const flatten = (n: Node, op: '&&' | '||'): Node[] => (n.t === 'bin' && n.op === op ? [...flatten(n.left, op), ...flatten(n.right, op)] : [n])
  // parenthesised sub-expressions arrive as their inner node (the parser drops the parentheses)
  const group = (n: Node, depth: number): FilterGroup | null => {
    const join = n.t === 'bin' && n.op === '||' ? 'or' : 'and'
    const items = flatten(n, join === 'and' ? '&&' : '||')
    const rules: (FilterRule | FilterGroup)[] = []
    for (const it of items) {
      const r = rule(it)
      if (r) { rules.push({ ...r, value: strip(r.value) }); continue }
      if (depth === 0 && it.t === 'bin' && (it.op === '&&' || it.op === '||') && (it.op === '&&') !== (join === 'and')) {
        const g = group(it, 1)
        if (!g) return null
        rules.push(g)
        continue
      }
      return null
    }
    return { join, rules }
  }
  return group(p.ast, 0)
}

/** Get a row "by condition": rowId = LookUp(<table>, <filter>) */
export function lookupFx(table: string, g: FilterGroup): string {
  const f = compileFilter(g)
  return f ? `LookUp(${col(table)}, ${f})` : ''
}

/** the filter inside LookUp(<table>, <filter>) (null: rowId has another shape) */
export function parseLookup(fx: string | undefined, table: string, columns: string[]): FilterGroup | null {
  const t = (fx ?? '').trim().replace(/^=/, '')
  const src = `=${t}`
  const p = parse(src)
  if (!p.ast || p.ast.t !== 'call' || p.ast.name !== 'LookUp' || p.ast.args.length !== 2) return null
  const a0 = p.ast.args[0]
  if (a0.t !== 'id' || a0.name.toLowerCase() !== table.toLowerCase()) return null
  return parseFilter(textOf(src, p.ast.args[1]), columns)
}

/* ------------------------------------------------------------------ conditions (condition step, do until, table trigger) */

/**
 * A condition builder: like the filter, but the left side of each rule is any value (Trigger.Record.Amount,
 * Steps.Mgr.Output.Outcome), not a column. Compiles to the formula; parses back the same shape (else: formula).
 */
export function compileCondition(g: FilterGroup, nested = false): string {
  const parts = g.rules.map((r) => {
    if (isGroup(r)) return compileCondition(r, true)
    if (!r.column.trim()) return ''
    const left = operand(r.column)
    switch (r.op) {
      case 'blank': return `IsBlank(${left})`
      case 'notBlank': return `!IsBlank(${left})`
      case 'contains': return `${operand(r.value)} in ${left}`
      case 'startsWith': return `StartsWith(${left}, ${operand(r.value)})`
      default: return `${left} ${BIN[r.op]} ${operand(r.value)}`
    }
  }).filter(Boolean)
  if (!parts.length) return ''
  const s = parts.join(g.join === 'and' ? ' && ' : ' || ')
  return nested && parts.length > 1 ? `(${s})` : s
}

const isLiteral = (n: Node): boolean => n.t === 'num' || n.t === 'str' || n.t === 'bool'

export function parseCondition(fx: string | undefined): FilterGroup | null {
  const t = (fx ?? '').trim().replace(/^=/, '')
  if (!t) return { join: 'and', rules: [] }
  const src = `=${t}`
  const p = parse(src)
  if (!p.ast) return null
  const rule = (n: Node): FilterRule | null => {
    if (n.t === 'bin') {
      const op = (Object.entries(BIN).find(([, v]) => v === n.op)?.[0] ?? null) as FilterOp | null
      if (op && !isLiteral(n.left)) return { column: textOf(src, n.left), op, value: textOf(src, n.right) }
      if (n.op === 'in' && !isLiteral(n.right)) return { column: textOf(src, n.right), op: 'contains', value: textOf(src, n.left) }
      return null
    }
    if (n.t === 'call' && n.name === 'IsBlank' && n.args.length === 1) return { column: textOf(src, n.args[0]), op: 'blank', value: '' }
    if (n.t === 'unary' && n.op === '!' && n.arg.t === 'call' && n.arg.name === 'IsBlank' && n.arg.args.length === 1) return { column: textOf(src, n.arg.args[0]), op: 'notBlank', value: '' }
    if (n.t === 'call' && n.name === 'StartsWith' && n.args.length === 2) return { column: textOf(src, n.args[0]), op: 'startsWith', value: textOf(src, n.args[1]) }
    return null
  }
  const flatten = (n: Node, op: '&&' | '||'): Node[] => (n.t === 'bin' && n.op === op ? [...flatten(n.left, op), ...flatten(n.right, op)] : [n])
  const group = (n: Node, depth: number): FilterGroup | null => {
    const join = n.t === 'bin' && n.op === '||' ? 'or' : 'and'
    const rules: (FilterRule | FilterGroup)[] = []
    for (const it of flatten(n, join === 'and' ? '&&' : '||')) {
      const r = rule(it)
      if (r) { rules.push(r); continue }
      if (depth === 0 && it.t === 'bin' && (it.op === '&&' || it.op === '||')) {
        const g = group(it, 1)
        if (!g) return null
        rules.push(g)
        continue
      }
      return null
    }
    return { join, rules }
  }
  return group(p.ast, 0)
}
