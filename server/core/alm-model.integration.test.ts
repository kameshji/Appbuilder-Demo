/**
 * Solution upgrade in place and environment copies carry the data model (P0 package M, gap 2a): unique pairs, reporting
 * views, date dimensions, summary tables (settings and refresh schedules) and relationship changes on tables that
 * already exist in the target. Runs against the sandbox PostgreSQL (APPBUILDER_TEST_DB).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { PG_URL, SKIP_PG } from './testdb.ts'
import { Client, startHarness } from './kernel-testkit.ts'
import type { KernelHarness } from './kernel-testkit.ts'
import { setQuiet } from './util.ts'
import type { Model, ModelResponse } from '../../src/model/types.ts'
import { addTable, createRelationship, diffModels } from '../../src/model/ops.ts'
import { addDateDimension, summaryTable, viewTable } from '../../src/model/patterns.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[alm-model] ${SKIP_PG}\n`)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pkg = any

describe.skipIf(!PG_URL)(PG_URL ? 'solution upgrade and copy carry the data model (PostgreSQL)' : `solution upgrade and copy carry the data model ${SKIP_PG}`, { timeout: 120_000 }, () => {
  let h: KernelHarness
  let target: Client
  let targetSchema = ''
  const drain = () => h.app.services.kernel.drain({ timeoutMs: 60_000 })
  const count = async (sql: string, params: unknown[] = []) => Number((await h.q<{ n: number }>(sql, params))[0].n)
  const live = async (cl: Client): Promise<Model> => ((await cl.get('/model')).data as ModelResponse).model
  const tbl = (m: Model, name: string) => m.tables.find((t) => t.name === name)!

  beforeAll(async () => {
    h = await startHarness('almmodel', { env: { APPBUILDER_MIGRATION_BACKUP: 'skip' } })
    // the source model: Customer <- Order (restrict), a date dimension, a summary of Order, a view of Order
    const base = await live(h.admin)
    let x = addTable(base, { displayName: 'Customer', columns: [{ displayName: 'Name', type: 'text' }] })
    const cust = x.table.id
    x = addTable(x.model, { displayName: 'Order', columns: [{ displayName: 'Code', type: 'text' }, { displayName: 'Line', type: 'number' }, { displayName: 'Amount', type: 'number' }] })
    const order = x.table.id
    let m = createRelationship(x.model, { parent: cust, child: order, cardinality: 'oneToMany', onDelete: 'restrict' }).model
    m = addDateDimension(m, { from: '2026-01-01', to: '2026-01-31', fiscalYearStartMonth: 4 }).model
    m = summaryTable(m, { source: order, groupBy: ['Customer'], measures: [{ fn: 'sum', column: 'Amount' }], cron: '15 * * * *', displayName: 'Order totals' }).model
    m = viewTable(m, 'Order view', { kind: 'view', role: 'fact', base: order, columns: [{ name: 'Code', displayName: 'Code', type: 'text', source: 'Code' }, { name: 'Amount', displayName: 'Amount', type: 'number', source: 'Amount' }] }).model
    const ops = diffModels(base, m)
    const p = await h.admin.post('/model/plan', { ops })
    expect(p.status, JSON.stringify(p.data).slice(0, 800)).toBe(200)
    const a = await h.admin.post('/model/apply', { ops, token: p.data.token })
    expect(a.status, JSON.stringify(a.data).slice(0, 1500)).toBe(200)
    await drain()
  }, 180_000)

  afterAll(async () => {
    await h?.close()
  }, 60_000)

  const exportPkg = async (): Promise<Pkg> => {
    const all = await live(h.admin)
    const ids = ['Customer', 'Order', 'DimDate', 'OrderTotals', 'OrderView'].map((n) => tbl(all, n).id)
    const r = await h.admin.post('/model/package', { tables: ids, displayName: 'Orders model' })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return yaml.load(r.data.yaml)
  }
  const entry = (pkg: Pkg, name: string) => pkg.tables.find((t: Pkg) => t.schema.name === name)

  it('install: the date dimension is filled and the summary table gets its schedule in the target environment', async () => {
    const env = await h.admin.post('/environments', { name: 'ALM target', type: 'sandbox' })
    expect(env.status, JSON.stringify(env.data)).toBe(200)
    target = new Client(h.base)
    target.cookie = h.admin.cookie
    target.env = env.data.id
    targetSchema = `env_${env.data.id}`
    const pkg = await exportPkg()
    const imp = await target.post('/solutions/import', { yaml: yaml.dump(pkg) })
    expect(imp.status, JSON.stringify(imp.data).slice(0, 1500)).toBe(200)
    const m = await live(target)
    expect(await count(`SELECT count(*)::int AS n FROM ${targetSchema}.${tbl(m, 'DimDate').source}`)).toBe(31)
    const sched = await h.q<{ cron: string }>(`SELECT cron FROM ${targetSchema}.ab_schedules WHERE job_type = 'model.summary.refresh' AND payload->>'tableId' = $1`, [tbl(m, 'OrderTotals').id])
    expect(sched).toEqual([{ cron: '15 * * * *' }])
    // the same package again: nothing to change
    const again = await target.post('/solutions/import/plan', { yaml: yaml.dump(pkg) })
    expect(again.data.problems).toEqual([])
    expect(again.data.items.filter((i: { change: string }) => i.change !== 'unchanged'), JSON.stringify(again.data.items)).toEqual([])
  })

  it('upgrade in place: unique pairs, date range, summary measures and cron, view columns and relationship behaviour', async () => {
    const pkg = await exportPkg()
    pkg.solution.version = '2.0.0'
    const order = entry(pkg, 'Order')
    order.schema.uniqueTogether = [['Code', 'Line']]
    for (const r of order.relationships ?? []) if (r.fromColumn === 'Customer') r.onDelete = 'cascade'
    entry(pkg, 'DimDate').schema.reporting.to = '2026-02-28'
    const totals = entry(pkg, 'OrderTotals').schema
    totals.reporting.cron = '45 2 * * *'
    totals.reporting.measures.push({ name: 'RowCount', fn: 'count' })
    totals.columns.push({ name: 'RowCount', displayName: 'Row count', type: 'number' })
    const view = entry(pkg, 'OrderView').schema
    view.reporting.columns.push({ name: 'Line', displayName: 'Line', type: 'number', source: 'Line' })
    view.columns.push({ name: 'Line', displayName: 'Line', type: 'number' })
    const text = yaml.dump(pkg)

    // rows in the target first: two orders of one customer (distinct pairs)
    const m0 = await live(target)
    const c = await target.post(`/data/${tbl(m0, 'Customer').id}/rows`, { values: { Name: 'Acme' } })
    expect(c.status, JSON.stringify(c.data)).toBe(200)
    for (const [code, line, amount] of [['A', 1, 10], ['A', 2, 20]] as const) {
      const r = await target.post(`/data/${tbl(m0, 'Order').id}/rows`, { values: { Code: code, Line: line, Amount: amount, Customer: c.data.row.id } })
      expect(r.status, JSON.stringify(r.data)).toBe(200)
    }

    const plan = await target.post('/solutions/import/plan', { yaml: text })
    expect(plan.status, JSON.stringify(plan.data).slice(0, 1500)).toBe(200)
    expect(plan.data.mode).toBe('upgrade')
    expect(plan.data.problems).toEqual([])
    const changed = plan.data.items.filter((i: { change: string }) => i.change === 'changed').map((i: { name: string }) => i.name).sort()
    expect(changed).toEqual(['Date', 'Order', 'Order totals', 'Order view'])
    expect(plan.data.warnings.join(' ')).toMatch(/Delete behaviour changes: Order\.Customer: restrict → cascade/)
    const imp = await target.post('/solutions/import', { yaml: text, confirm: plan.data.token })
    expect(imp.status, JSON.stringify(imp.data).slice(0, 2000)).toBe(200)
    await drain()

    const m = await live(target)
    expect(tbl(m, 'Order').uniqueTogether).toEqual([['Code', 'Line']])
    expect(await count(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexdef ILIKE '%UNIQUE%"Code"%"Line"%'`, [targetSchema, tbl(m, 'Order').source])).toBe(1)
    expect(m.relationships.find((r) => r.fromTable === tbl(m, 'Order').id && r.fromColumn === 'Customer')?.onDelete).toBe('cascade')
    expect(await count(`SELECT count(*)::int AS n FROM ${targetSchema}.${tbl(m, 'DimDate').source}`)).toBe(59)
    const sched = await h.q<{ cron: string }>(`SELECT cron FROM ${targetSchema}.ab_schedules WHERE job_type = 'model.summary.refresh' AND payload->>'tableId' = $1`, [tbl(m, 'OrderTotals').id])
    expect(sched).toEqual([{ cron: '45 2 * * *' }])
    const totalsRows = await h.q<{ SumAmount: string; RowCount: string }>(`SELECT "SumAmount", "RowCount" FROM ${targetSchema}.${tbl(m, 'OrderTotals').source}`)
    expect(totalsRows.map((r) => [Number(r.SumAmount), Number(r.RowCount)])).toEqual([[30, 2]])
    const viewCols = await h.q<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`, [targetSchema, tbl(m, 'OrderView').source])
    expect(viewCols.map((x) => x.column_name)).toContain('Line')
    const q = await target.post('/query', { plan: { version: 2, table: 'OrderView', select: ['Code', 'Line'], sort: [{ col: 'Line', dir: 'asc' }] } })
    expect(q.status, JSON.stringify(q.data)).toBe(200)
    expect(q.data.rows.map((r: { Line: number }) => r.Line)).toEqual([1, 2])

    // a pair that existing rows repeat (both orders: Code A, customer Acme) stops the upgrade; nothing changes
    const bad = yaml.load(text) as Pkg
    bad.solution.version = '3.0.0'
    entry(bad, 'Order').schema.uniqueTogether = [['Code', 'Customer']]
    entry(bad, 'DimDate').schema.reporting.to = '2026-03-31'
    const badText = yaml.dump(bad)
    const p3 = await target.post('/solutions/import/plan', { yaml: badText })
    const r3 = await target.post('/solutions/import', { yaml: badText, confirm: p3.data.token })
    expect(r3.status).toBe(422)
    expect(r3.data.error.message, JSON.stringify(r3.data)).toMatch(/repeat a pair/)
    expect(await count(`SELECT count(*)::int AS n FROM ${targetSchema}.${tbl(m, 'DimDate').source}`)).toBe(59)
    expect((await live(target)).tables.find((t) => t.name === 'Order')!.uniqueTogether).toEqual([['Code', 'Line']])
    expect(await count(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexdef ILIKE '%UNIQUE%"Code"%"Line"%'`, [targetSchema, tbl(m, 'Order').source])).toBe(1)
  })

  it('environment copy (schema only): summary schedules travel, the date dimension is filled, summaries refresh', async () => {
    const env = await h.admin.post('/environments', { name: 'ALM copy', type: 'sandbox', copyFrom: target.env, copy: 'schema' })
    expect(env.status, JSON.stringify(env.data)).toBe(200)
    const schema = `env_${env.data.id}`
    const cp = new Client(h.base)
    cp.cookie = h.admin.cookie
    cp.env = env.data.id
    const m = await live(cp)
    expect(await count(`SELECT count(*)::int AS n FROM ${schema}.${tbl(m, 'DimDate').source}`)).toBe(59)
    const sched = await h.q<{ cron: string; due: boolean }>(`SELECT cron, next_run_at <= now() AS due FROM ${schema}.ab_schedules WHERE job_type = 'model.summary.refresh' AND payload->>'tableId' = $1`, [tbl(m, 'OrderTotals').id])
    expect(sched).toEqual([{ cron: '45 2 * * *', due: true }])
    // a copy with data keeps the rows and the schedule (not due at once)
    const env2 = await h.admin.post('/environments', { name: 'ALM data copy', type: 'sandbox', copyFrom: target.env, copy: 'data' })
    expect(env2.status, JSON.stringify(env2.data)).toBe(200)
    const s2 = `env_${env2.data.id}`
    expect(await count(`SELECT count(*)::int AS n FROM ${s2}.ab_schedules WHERE job_type = 'model.summary.refresh'`)).toBe(1)
    expect(await count(`SELECT count(*)::int AS n FROM ${s2}.${tbl(m, 'DimDate').source}`)).toBe(59)
  })
})
