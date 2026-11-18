/**
 * Parity: for a generated corpus of formulas, the formula engine over all rows must give exactly what the translated
 * plans give when run by the reference executor, with the residual formula finishing the job in the "browser".
 * Formulas the translator refuses must come back with an error diagnostic (never a plan).
 */
import { describe, expect, it } from 'vitest'
import type { FxRecord, FxResult, FxValue } from '../../contracts.ts'
import { createEngine } from '../engine.ts'
import { analyze, bindResult, executePlan, residualScope, type AnalyzeResult } from './index.ts'
import { corpus, customerRows, sampleScope, SCHEMA, ticketRows } from './testdata.ts'

/** canonical form for deep comparison: dates by instant, record keys sorted */
function canon(v: FxValue): unknown {
  if (v instanceof Date) return { $t: v.getTime() }
  if (Array.isArray(v)) return v.map(canon)
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) o[k] = canon((v as FxRecord)[k]!)
    return o
  }
  return v
}

const tables: Record<string, FxRecord[]> = { Tickets: ticketRows(), Customers: customerRows() }
const scope = sampleScope(tables)
const engine = createEngine()

function runPlans(r: AnalyzeResult): FxResult {
  const values: Record<string, FxValue> = {}
  for (const q of r.plans) {
    const t = SCHEMA.tables[q.plan.table]!
    // the executor gets the rows in reverse to prove it applies the natural order itself
    values[q.id] = bindResult(q, executePlan(JSON.parse(JSON.stringify(q.plan)), [...tables[q.plan.table]!].reverse(), t))
  }
  if (!r.residual) return { ok: true, value: values[r.plans[0]!.id]! }
  return engine.evaluate(r.residual.formula, residualScope(values, scope))
}

describe('Query v2 parity with the formula engine', () => {
  const formulas = corpus()
  const results = formulas.map((f) => ({ f, want: engine.evaluate(f, scope), r: analyze(f, SCHEMA, { scope, engine }) }))

  it('the corpus is large and deterministic', () => {
    expect(formulas.length).toBeGreaterThanOrEqual(600)
    expect(corpus()).toEqual(formulas)
  })

  it('every translated formula gives exactly the engine result', () => {
    const mismatches: string[] = []
    let translated = 0
    for (const { f, want, r } of results) {
      if (!r.fullyDelegated) continue
      translated++
      let got: FxResult
      try {
        got = runPlans(r)
      } catch (e) {
        mismatches.push(`${f}\n  executor threw: ${e instanceof Error ? e.message : String(e)}\n  plans: ${JSON.stringify(r.plans.map((q) => q.plan))}`)
        continue
      }
      const a = want.ok ? canon(want.value) : 'error'
      const b = got.ok ? canon(got.value) : 'error'
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        mismatches.push(`${f}\n  engine: ${JSON.stringify(a)}\n  plan:   ${JSON.stringify(b)}\n  plans: ${JSON.stringify(r.plans.map((q) => q.plan))}\n  residual: ${r.residual?.formula}`)
      }
    }
    expect(mismatches.slice(0, 5).join('\n\n')).toBe('')
    expect(translated).toBeGreaterThanOrEqual(250)
  })

  it('a refused formula has an error diagnostic and no plan', () => {
    for (const { f, r } of results) {
      if (r.fullyDelegated) continue
      expect(r.plan, f).toBeNull()
      expect(r.diagnostics.some((d) => d.severity === 'error'), f).toBe(true)
      for (const d of r.diagnostics) {
        expect(d.message.length, f).toBeGreaterThan(0)
        expect(d.end, f).toBeGreaterThanOrEqual(d.start)
        expect(f.slice(d.start, d.end), f).toBe(d.text)
      }
    }
  })

  it('translates the common shapes and refuses the rest (summary)', () => {
    const translated = results.filter((x) => x.r.fullyDelegated).length
    const codes: Record<string, number> = {}
    for (const { r } of results) for (const d of r.diagnostics) codes[d.code] = (codes[d.code] ?? 0) + 1
    // the summary is printed for the report; the codes prove each refusal path is exercised
    console.log(`parity corpus: ${results.length} formulas, ${translated} fully delegated, ${results.length - translated} refused`, codes)
    for (const c of ['not-delegable-expression', 'numeric-text', 'type-mismatch', 'unbounded-consumer', 'nested-table', 'not-delegable-predicate', 'per-row-query', 'group-rows']) {
      expect(codes[c] ?? 0, c).toBeGreaterThan(0)
    }
  })

  it('pages of every translated row plan concatenate to the full result', () => {
    let checked = 0
    for (const { r } of results) {
      if (!r.fullyDelegated) continue
      for (const q of r.plans) {
        if (q.shape !== 'rows' || q.plan.aggregate) continue
        const t = SCHEMA.tables[q.plan.table]!
        const all = executePlan(q.plan, tables[q.plan.table]!, t).rows
        const got: FxRecord[] = []
        let cursor: string | undefined
        for (let i = 0; i < 50; i++) {
          const page = executePlan({ ...q.plan, page: { size: 7, cursor } }, tables[q.plan.table]!, t)
          got.push(...page.rows)
          if (!page.nextCursor) break
          cursor = page.nextCursor
        }
        expect(canon(got)).toEqual(canon(all))
        checked++
      }
    }
    expect(checked).toBeGreaterThan(50)
  })
})
