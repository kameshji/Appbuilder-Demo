import type { FxRecord, FxScope, FxValue } from '../../contracts.ts'
import type { ConditionV2, NumExprV2, QueryLiteral, QueryPlan } from '../../platform/query.ts'
import type { AnalyzeResult, PlannedQuery } from './translate.ts'

function lit(v: QueryLiteral): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'object') return '$date' in v ? `date ${v.$date}` : `time ${v.$datetime}`
  return String(v)
}

const OPS: Record<string, string> = { eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>=' }

const EXPR_OPS: Record<string, string> = { add: '+', sub: '-', mul: '*', div: '/' }
const ROUND_NAMES: Record<string, string> = { round: 'Round', roundUp: 'RoundUp', roundDown: 'RoundDown' }

/** a numeric expression as formula-like text */
export function describeExpr(e: NumExprV2): string {
  if (typeof e === 'number') return String(e)
  if ('col' in e) return e.col
  switch (e.fn) {
    case 'add': case 'sub': case 'mul': case 'div': return `(${describeExpr(e.args[0])} ${EXPR_OPS[e.fn]} ${describeExpr(e.args[1])})`
    case 'neg': return `-${describeExpr(e.args[0])}`
    case 'abs': return `Abs(${describeExpr(e.args[0])})`
    default: return `${ROUND_NAMES[e.fn]}(${describeExpr(e.args[0])}, ${e.digits})`
  }
}

/** a condition as readable text (for the Studio and logs) */
export function describeCondition(c: ConditionV2): string {
  if ('const' in c) return c.const ? 'every row' : 'no row'
  if ('and' in c) return c.and.map((x) => ('or' in x ? `(${describeCondition(x)})` : describeCondition(x))).join(' and ')
  if ('or' in c) return c.or.map((x) => ('and' in x ? `(${describeCondition(x)})` : describeCondition(x))).join(' or ')
  if ('not' in c) return `not (${describeCondition(c.not)})`
  if ('via' in c) return `${c.via.col} (${c.via.table}) where ${describeCondition(c.via.where)}${c.via.orMissing ? ' or blank' : ''}`
  if (c.op === 'cmpExpr') return `${describeExpr(c.left)} ${OPS[c.cmp]} ${describeExpr(c.right)}`
  const cs = 'exact' in c && c.exact ? ' (case-sensitive)' : ''
  switch (c.op) {
    case 'isNull': return `${c.col} is blank`
    case 'in': return `${c.col} is one of ${c.value.map(lit).join(', ')}${cs}`
    case 'contains': return `${c.col} contains ${JSON.stringify(c.value)}${cs}`
    case 'startsWith': return `${c.col} starts with ${JSON.stringify(c.value)}${cs}`
    case 'endsWith': return `${c.col} ends with ${JSON.stringify(c.value)}${cs}`
    case 'cmpCol': return `${c.col} ${OPS[c.cmp]} ${c.other}`
    default: return `${c.col} ${OPS[c.op]} ${lit(c.value)}${cs}`
  }
}

/** one plan as readable text, one step per line */
export function describePlan(p: QueryPlan): string[] {
  const out = [`read ${p.table}`]
  if (p.filter) out.push(`  where ${describeCondition(p.filter)}`)
  if (p.search) out.push(`  where ${p.search.columns.join(' or ')} contains ${JSON.stringify(p.search.text)}`)
  if (p.sort?.length) out.push(`  sort by ${p.sort.map((k) => `${k.col} ${k.dir === 'asc' ? 'ascending' : 'descending'}`).join(', ')}`)
  if (p.take) out.push(`  keep the ${p.take.from === 'start' ? 'first' : 'last'} ${p.take.n} row${p.take.n === 1 ? '' : 's'}`)
  if (p.aggregate) {
    const a = p.aggregate
    const ms = a.measures.map((m) => `${m.name} = ${m.fn}${m.col ? `(${m.col})` : m.expr !== undefined ? `(${describeExpr(m.expr)})` : ''}${m.filter ? ` where ${describeCondition(m.filter)}` : ''}`)
    out.push(`  ${a.groupBy.length ? `group by ${a.groupBy.join(', ')}` : 'over all rows'}${ms.length ? `: ${ms.join(', ')}` : ''}`)
    if (a.sort?.length) out.push(`  sort groups by ${a.sort.map((k) => `${k.col} ${k.dir === 'asc' ? 'ascending' : 'descending'}`).join(', ')}`)
  }
  if (p.select) out.push(`  columns ${p.select.join(', ')}`)
  if (p.count) out.push('  count the rows')
  if (p.single) out.push('  first row only')
  return out
}

/** text for the Studio: what runs on the server, what runs in the browser, and what can't run */
export function explain(r: AnalyzeResult): string {
  const lines: string[] = []
  if (r.plans.length === 0 && r.diagnostics.length === 0) lines.push('No data-source table is read: the formula runs in the browser.')
  for (const q of r.plans) {
    lines.push(`${q.id} (server): ${q.text}`)
    for (const l of describePlan(q.plan)) lines.push('  ' + l)
  }
  if (r.residual) lines.push(`Browser: ${r.residual.formula}`)
  for (const d of r.diagnostics) {
    lines.push(`${d.severity === 'error' ? 'Error' : 'Warning'}: ${d.message} [${d.text}]${d.suggestion ? `. ${d.suggestion}` : ''}`)
  }
  if (r.fullyDelegated && r.plans.length > 0) lines.push('Fully delegated.')
  return lines.join('\n')
}

/** a plan's result as the formula value its binding stands for */
export function bindResult(q: PlannedQuery, res: { rows: FxRecord[]; count?: number }): FxValue {
  switch (q.shape) {
    case 'rows': return res.rows
    case 'record': return res.rows[0] ?? null
    case 'count': return res.count ?? res.rows.length
    case 'scalar': return res.rows[0]?.[q.measure ?? 'Value'] ?? null
  }
}

/** a scope that answers the bindings first, then the caller's scope (for evaluating the residual formula) */
export function residualScope(values: Record<string, FxValue>, scope: FxScope): FxScope {
  return { resolve: (n) => (Object.prototype.hasOwnProperty.call(values, n) ? values[n] : scope.resolve(n)) }
}
