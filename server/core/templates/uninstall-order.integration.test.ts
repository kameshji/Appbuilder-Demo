/**
 * Uninstall with "Delete tables with data" when a pack table has a rollup over its own child lines (the child looks the
 * parent up, the parent rolls the child up: each points at the other). The data model drops the computed columns and
 * lookups between the tables that go before the tables, in one transaction (server/core/model/engine.ts).
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/templates/uninstall-order
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { startHarness, type KernelHarness } from '../kernel-testkit.ts'
import { setQuiet } from '../util.ts'
import { registerTestTemplates } from './catalogue.ts'
import { erpLiteWithRollup } from './testdata/erp-lite-next.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[uninstall order integration] ${SKIP_PG}\n`)
const S = 'env_default'
type Any = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(!PG_URL)(PG_URL ? 'uninstall order with rollups (PostgreSQL)' : `uninstall order ${SKIP_PG}`, { timeout: 300_000 }, () => {
  let h: KernelHarness
  let unregister: () => void
  beforeAll(async () => {
    unregister = registerTestTemplates([erpLiteWithRollup()])
    h = await startHarness('tplord')
  }, 120_000)
  afterAll(async () => {
    unregister?.()
    await h?.close()
  }, 60_000)

  it('a pack whose parent rolls up its own lines uninstalls with "Delete tables", rows included', async () => {
    const A = h.admin
    const tablesBefore = (await h.q<Any>(`SELECT id FROM ${S}.ab_tables`)).map((r) => r.id).sort()
    const p = await A.post('/templates/test.erp-lite-rollup/plan', { mode: 'linked', sample: true })
    expect(p.status, JSON.stringify(p.data).slice(0, 500)).toBe(200)
    expect(p.data.plan.problems).toEqual([])
    const r = await A.post('/templates/test.erp-lite-rollup/install', { mode: 'linked', bindings: p.data.bindings, sample: true, confirm: p.data.plan.token, ...(p.data.plan.systemEvents?.length ? { approveSystem: true } : {}) })
    expect(r.status, JSON.stringify(r.data).slice(0, 800)).toBe(200)
    const rec = r.data.install
    // the rollups exist and compute over the SAMPLE lines
    const orders = (await h.q<Any>(`SELECT id, source, def FROM ${S}.ab_tables WHERE def->>'name' ILIKE '%SalesOrders' OR def->>'name' ILIKE 'SalesOrder%'`)).find((t) => t.def.columns.some((c: Any) => c.name === 'TotalQty')) as Any
    expect(orders, 'the sales orders table with its rollups').toBeTruthy()
    const lines = await h.q<Any>(`SELECT id, def FROM ${S}.ab_tables`)
    const child = lines.find((t) => t.def.columns.some((c: Any) => c.type === 'lookup' && c.lookupTable?.toLowerCase() === orders.def.name.toLowerCase() && c.name === 'Order')) as Any
    expect(child, 'the sales order lines table').toBeTruthy()
    const counted = await h.q<Any>(`SELECT "LineCount" AS n FROM ${S}."${orders.source}"`)
    expect(counted.length).toBeGreaterThan(0)
    // uninstall everything this install brought (dependencies after it), deleting tables with their rows
    const all = (await A.get('/templates/installed')).data.items.filter((x: Any) => x.status === 'installed')
    const order = [rec, ...all.filter((x: Any) => x.id !== rec.id && (rec.dependsOn ?? []).some((d: Any) => d.install === x.id))]
    for (const x of order) {
      const u = await A.post(`/templates/installed/${x.id}/uninstall/plan`, { deleteTables: true })
      expect(u.data.problems, `${x.templateId}: ${JSON.stringify(u.data.problems)}`).toEqual([])
      if (x.id === rec.id) {
        expect(u.data.items.find((i: Any) => i.kind === 'table' && i.id === orders.id)?.action).toBe('removed')
        expect(u.data.items.find((i: Any) => i.kind === 'table' && i.id === child.id)?.action).toBe('removed')
      }
      const done = await A.post(`/templates/installed/${x.id}/uninstall`, { confirm: u.data.token, deleteTables: true, confirmText: u.data.confirmText })
      expect(done.status, JSON.stringify(done.data).slice(0, 500)).toBe(200)
    }
    expect((await h.q<Any>(`SELECT id FROM ${S}.ab_tables`)).map((x) => x.id).sort()).toEqual(tablesBefore)
    expect((await h.q(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`, [S, orders.source])).length).toBe(0)
  })

  it('the data model drops a parent and its rolled-up lines in one change', async () => {
    const A = h.admin
    const mk = async (name: string, columns: Any[]) => (await A.post('/tables', { displayName: name, name, columns })).data
    const head = await mk('OrdHead', [{ displayName: 'Ref', name: 'Ref', type: 'text' }])
    const line = await mk('OrdLine', [{ displayName: 'Qty', name: 'Qty', type: 'decimal' }, { displayName: 'Head', name: 'Head', type: 'lookup', lookupTable: 'OrdHead' }])
    expect((await A.post(`/tables/${head.id}/columns`, { displayName: 'Total', name: 'Total', type: 'decimal', computed: { kind: 'rollup', table: 'OrdLine', via: 'Head', fn: 'sum', column: 'Qty' } })).status).toBe(200)
    const ops = [{ op: 'dropTable', id: head.id, name: 'OrdHead' }, { op: 'dropTable', id: line.id, name: 'OrdLine' }]
    const plan = await A.post('/model/plan', { ops })
    expect(plan.status, JSON.stringify(plan.data).slice(0, 400)).toBe(200)
    expect(plan.data.problems).toEqual([])
    const ok = await A.post('/model/apply', { ops, token: plan.data.token })
    expect(ok.status, JSON.stringify(ok.data).slice(0, 400)).toBe(200)
    expect((await h.q(`SELECT 1 FROM ${S}.ab_tables WHERE id = ANY($1::text[])`, [[head.id, line.id]])).length).toBe(0)
  })
})
