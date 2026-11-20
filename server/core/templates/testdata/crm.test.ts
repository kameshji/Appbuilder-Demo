/**
 * The CRM pack (P3 package R; docs/guide/maker/crm-pack.md), pure checks that the generic pack tests do not make:
 *  - the 1.0.0 pack and the 1.1.0 fixture are valid packs whose formulas bind and that the safety check leaves alone;
 *  - the pipeline dashboard's tiles over the SAMPLE rows equal a hand computation (open pipeline, weighted forecast,
 *    win rate, by stage, forecast by month);
 *  - quotes carry no tax: no tax column on quotes and quote lines, the print template says no tax is computed;
 *  - the discount limit of the table rule and of the approval flow agree;
 *  - who sees what: the scopes of each role (the maker page's table).
 */
import { describe, expect, it } from 'vitest'
import type { FxRecord } from '../../../../src/contracts.ts'
import type { TableSchemaInfo } from '../../../../src/platform/query.ts'
import { declaredTokens, validateTemplate, type TemplatePackage } from '../../../../src/templates/format.ts'
import { bindJson, checkTemplateFormulas } from '../../../../src/templates/bind.ts'
import { checkSafety } from '../../../../src/templates/safety.ts'
import { executePlan } from '../../../../src/fx/query/reference.ts'
import { checkPlan } from '../../../../src/fx/query/validate.ts'
import { compileQuery, finishQuery, type QuerySpec } from '../../../../src/dashboards/measures.ts'
import { crm, crmNext } from './crm-next.ts'

const pkg = crm()
/** tokens -> the plain names the pack creates (no clash): what an install without prefixes binds */
const plain = new Map<string, string | null>()
for (const [t, v] of declaredTokens(pkg)) plain.set(t, v.component ? `${v.component}_${v.key}` : (v.column ?? v.slot))
const unbind = <T>(v: T): T => { const b = bindJson(v, plain); expect(b.problems).toEqual([]); return b.value }
type Any = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const tiles = () => unbind((pkg.payload.dashboards!.find((d) => d.key === 'SalesPipeline')!.def as Any).tiles) as Any[]

describe('CRM pack', () => {
  it('is a valid pack; the 1.1.0 fixture too', () => {
    for (const p of [pkg, crmNext()] as TemplatePackage[]) {
      expect(validateTemplate(p)).toEqual([])
      expect(checkTemplateFormulas(p)).toEqual([])
      expect(checkSafety(p).stripped).toEqual([])
    }
    expect(crmNext().version).toBe('1.1.0')
  })

  it('the pipeline tiles over the SAMPLE rows equal the hand computation', () => {
    const rows = pkg.payload.sample!.Opportunities as Any[]
    expect(rows.length).toBeGreaterThan(8)
    const info: TableSchemaInfo = { columns: { id: 'text', createdOn: 'datetime', Name: 'text', Stage: 'text', Amount: 'number', Probability: 'number', WeightedAmount: 'number', CloseDate: 'date' } }
    const facts: FxRecord[] = rows.map((r, i) => ({ id: `r${i}`, createdOn: new Date(i), ...r, WeightedAmount: Math.round(r.Amount * r.Probability) / 100, CloseDate: new Date(`${r.CloseDate}T00:00:00Z`) }) as FxRecord)
    const run = (spec: QuerySpec) => {
      const ctx = { range: null }
      const c = compileQuery(spec, ctx)
      return finishQuery(spec, ctx, executePlan(checkPlan(JSON.parse(JSON.stringify(c.main)), info, c.main.table).plan, facts, info).rows).rows
    }
    const open = rows.filter((r) => r.Stage !== 'Won' && r.Stage !== 'Lost')
    const t = (id: string) => tiles().find((x) => x.id === id)!
    expect(run(t('open').query as QuerySpec)[0]!.Open).toBe(open.reduce((a, r) => a + r.Amount, 0))
    const weighted = open.reduce((a, r) => a + (r.Amount * r.Probability) / 100, 0)
    expect(run(t('weighted').query as QuerySpec)[0]!.Weighted).toBeCloseTo(weighted, 6)
    const won = rows.filter((r) => r.Stage === 'Won'), lost = rows.filter((r) => r.Stage === 'Lost')
    expect(run(t('winrate').query as QuerySpec)[0]!.WinRate).toBeCloseTo(won.length / (won.length + lost.length), 12)
    const byStage = run(t('bystage').query as QuerySpec)
    for (const s of ['Prospect', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost']) expect(byStage.find((r) => r.Stage === s)!.Value, s).toBe(rows.filter((r) => r.Stage === s).reduce((a, r) => a + r.Amount, 0))
    const months = run(t('forecast').query as QuerySpec)
    expect(months.reduce((a, r) => a + Number(r.Weighted ?? 0), 0)).toBeCloseTo(weighted, 6)
  })

  it('quotes carry no tax and say so', () => {
    for (const id of ['Quotes', 'QuoteLines']) for (const c of pkg.slots.find((s) => s.id === id)!.columns) expect(c.id.toLowerCase(), c.id).not.toMatch(/tax|gst/)
    const doc = JSON.stringify(pkg.payload.printTemplates!.find((p) => p.key === 'Quote')!.doc)
    expect(doc).toMatch(/No tax has been computed/)
  })

  it('the discount limit is 10% in the rule and in the approval flow', () => {
    const rule = (pkg.slots.find((s) => s.id === 'Quotes')!.events ?? []).find((e) => /big discount/.test(String(e.name)))!
    expect(String(rule.condition)).toContain('<= 10')
    const flow = JSON.stringify(pkg.payload.flows!.find((f) => f.key === 'QuoteApproval')!.definition)
    expect(flow).toContain('> 10')
    expect(flow).toContain('"requester":"Trigger.Record.owner"')
  })

  it('who sees what (the maker page table)', () => {
    const scope = (role: string, slot: string) => pkg.payload.roles!.find((r) => r.key === role)!.tables[slot]
    expect(scope('SalesRep', 'Leads')).toMatchObject({ create: true, read: 'own', update: 'own' })
    expect(scope('SalesRep', 'Opportunities')).toMatchObject({ read: 'own', update: 'own' })
    expect(scope('SalesRep', 'Quotes')!.columns).toMatchObject({ Approval: 'read', ApprovedDiscount: 'read' })
    expect(scope('SalesManager', 'Opportunities')).toMatchObject({ read: 'team', update: 'team' })
    expect(scope('SalesManager', 'Quotes')).toMatchObject({ read: 'team' })
    expect(scope('SalesViewer', 'Opportunities')).toEqual({ read: 'all' })
    for (const r of pkg.payload.roles!) expect((r as Any).isAdmin, r.key).toBeUndefined()
  })
})
