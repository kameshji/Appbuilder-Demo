/**
 * The Manufacturing pack (P3 package M2; docs/guide/maker/manufacturing-pack.md), pure checks that the generic pack
 * tests do not make:
 *  - its dashboards are built on src/dashboards/manufacturing.ts: the Production overview tiles and the presets it uses
 *    are the built-in ones, rebound to the pack's tokens (so existing presets keep working on the pack's tables);
 *  - the OEE tile on the pack's SAMPLE rows equals a hand computation (and the preset over the same rows);
 *  - the inspection report is the built-in print template rebound (its extra lines are listed here);
 *  - the 1.1.0 fixture is a valid pack whose formulas bind;
 *  - who sees what: the scopes of each role on the main tables (the maker page's table).
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
import { PRESETS, productionOverview } from '../../../../src/dashboards/manufacturing.ts'
import { builtinDoc } from '../../print/builtins.ts'
import { manufacturing, manufacturingNext } from './manufacturing-next.ts'

const pkg = manufacturing()
/** tokens -> the plain names the pack creates (no clash): what an install without prefixes binds */
const plain = new Map<string, string | null>()
for (const [t, v] of declaredTokens(pkg)) plain.set(t, v.component ? `${v.component}_${v.key}` : (v.column ?? v.slot))
const unbind = <T>(v: T): T => { const b = bindJson(v, plain); expect(b.problems).toEqual([]); return b.value }
type Any = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const dash = (key: string) => pkg.payload.dashboards!.find((d) => d.key === key)!.def as Any

describe('manufacturing pack', () => {
  it('is a valid pack; the 1.1.0 fixture too', () => {
    for (const p of [pkg, manufacturingNext()] as TemplatePackage[]) {
      expect(validateTemplate(p)).toEqual([])
      expect(checkTemplateFormulas(p)).toEqual([])
      expect(checkSafety(p).stripped).toEqual([])
    }
    expect(manufacturingNext().version).toBe('1.1.0')
  })

  it('the Plant overview carries the built-in Production overview tiles and presets, rebound', () => {
    const builtIn = productionOverview().tiles
    const mine = unbind(dash('PlantOverview').tiles) as Any[]
    for (const t of builtIn) expect(mine.find((x) => x.id === t.id), t.id).toEqual(t)
    const all = unbind(pkg.payload.dashboards!.map((d) => d.def)) as Any[]
    const queries = all.flatMap((d) => d.tiles.map((t: Any) => t.query))
    for (const key of ['oee', 'mttr', 'fpy', 'scheduleAdherence']) {
      const preset = PRESETS.find((p) => p.key === key)!.query
      expect(queries.some((q) => JSON.stringify(q) === JSON.stringify(preset)), key).toBe(true)
    }
  })

  it('OEE over the SAMPLE rows equals the hand computation and the built-in preset', () => {
    const rows = pkg.payload.sample!.ProductionLog as Any[]
    expect(rows.length).toBeGreaterThan(20)
    const info: TableSchemaInfo = { columns: { id: 'text', createdOn: 'datetime', LoggedOn: 'datetime', Shift: 'text', Machine: 'text', Good: 'number', Scrap: 'number', PlannedMin: 'number', RunMin: 'number', IdealCycleSec: 'number' } }
    const facts: FxRecord[] = rows.map((r, i) => ({ id: `r${i}`, createdOn: new Date(i), ...r, LoggedOn: new Date(String(r.LoggedOn)) }) as FxRecord)
    const run = (spec: QuerySpec) => {
      const ctx = { range: null }
      const c = compileQuery(spec, ctx)
      return finishQuery(spec, ctx, executePlan(checkPlan(JSON.parse(JSON.stringify(c.main)), info, c.main.table).plan, facts, info).rows).rows
    }
    const tile = (unbind(dash('PlantOverview').tiles) as Any[]).find((t) => t.id === 'oee')!
    const [mine] = run(tile.query as QuerySpec)
    const [preset] = run({ ...PRESETS[0]!.query, table: 'ProductionLog' })
    const sum = (f: (r: Any) => number) => rows.reduce((a, r) => a + f(r), 0)
    const planned = sum((r) => r.PlannedMin), runMin = sum((r) => r.RunMin), good = sum((r) => r.Good), total = sum((r) => r.Good + r.Scrap)
    const ideal = sum((r) => (r.IdealCycleSec * (r.Good + r.Scrap)) / 60)
    const oee = (runMin / planned) * (ideal / runMin) * (good / total)
    expect(mine!.OEE).toBeCloseTo(oee, 12)
    expect(preset!.OEE).toBeCloseTo(oee, 12)
    expect(oee).toBeGreaterThan(0.4)
    expect(oee).toBeLessThan(1)
  })

  it('the inspection report is the built-in one, rebound to the pack (plus stage, measured value and signature)', () => {
    const doc = unbind(pkg.payload.printTemplates!.find((p) => p.key === 'Inspection')!.doc) as Any
    const base = builtinDoc('inspection-report') as unknown as Any
    const kv = doc.body.find((b: Any) => b.id === 'kv')
    expect(kv.items.slice(-2).map((i: Any) => i.value)).toEqual(['Stage', 'Measured'])
    kv.items = kv.items.slice(0, -2)
    doc.body = doc.body.filter((b: Any) => b.id !== 'isig')
    expect(doc).toEqual(base)
  })

  it('who sees what (the maker page\'s table)', () => {
    const scope = (role: string, slot: string) => pkg.payload.roles!.find((r) => r.key === role)!.tables[slot]
    expect(scope('Operator', 'ProductionLog')).toMatchObject({ create: true, read: 'own', update: 'own' })
    expect(scope('Operator', 'Inspections')).toBeUndefined()
    expect(scope('Operator', 'MaintenanceRequests')!.columns).toEqual({ Cost: 'none', CostApproval: 'none' })
    expect(scope('Supervisor', 'ProductionLog')).toMatchObject({ read: 'team', update: 'team' })
    expect(scope('Quality', 'NCRs')).toMatchObject({ create: true, read: 'all', update: 'all' })
    expect(scope('Maintenance', 'MaintenanceRequests')).toMatchObject({ read: 'all', update: 'all' })
    expect(scope('PlantManager', 'ProductionLog')).toMatchObject({ read: 'all' })
    for (const r of pkg.payload.roles!) expect((r as Any).isAdmin, r.key).toBeUndefined()
  })
})
