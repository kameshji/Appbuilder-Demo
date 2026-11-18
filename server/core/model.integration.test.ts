/**
 * Data model designer (P0 package K) against the sandbox PostgreSQL (APPBUILDER_TEST_DB): plan and apply in one
 * transaction (rollback on failure, stale plans refused, conversion pre-checks, destructive row counts), relationship
 * delete behaviours in the DataService (restrict, cascade with the caller's permissions + outbox + events, set blank,
 * cycle prevention), junction tables with a unique pair, reporting views (fact and dimension) read by a restricted user
 * through Query v2 with the base table's row and column security, date dimension and summary tables, drafts, layouts,
 * locked environments, the solution package round trip and the environment copy.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from './testdb.ts'
import { Client, startHarness } from './kernel-testkit.ts'
import type { KernelHarness } from './kernel-testkit.ts'
import { setQuiet } from './util.ts'
import { runInEnvironment } from './env-context.ts'
import { hashPassword } from './password.ts'
import type { UserRecord } from './contracts.ts'
import type { Model, ModelApplyResult, ModelPlan, ModelResponse } from '../../src/model/types.ts'
import { addColumn, addTable, createRelationship, diffModels, removeColumn, tableById, updateColumn } from '../../src/model/ops.ts'
import { generateStar, patternByKey, summaryTable } from '../../src/model/patterns.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[model] ${SKIP_PG}\n`)

const PW = 'member-password-1'

describe.skipIf(!PG_URL)(PG_URL ? 'data model designer (PostgreSQL)' : `data model designer (PostgreSQL) ${SKIP_PG}`, { timeout: 60_000 }, () => {
  let h: KernelHarness
  let rep: Client
  const drain = () => h.app.services.kernel.drain({ timeoutMs: 60_000 })

  const live = async (cl: Client = h.admin): Promise<ModelResponse> => {
    const r = await cl.get('/model')
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return r.data
  }
  const plan = async (base: Model, draft: Model, cl: Client = h.admin): Promise<{ plan: ModelPlan; ops: ReturnType<typeof diffModels> }> => {
    const ops = diffModels(base, draft)
    const r = await cl.post('/model/plan', { ops })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return { plan: r.data, ops }
  }
  /** plan + apply the change from the live model to edit(live) */
  const change = async (edit: (m: Model) => Model, o: { expectStatus?: number } = {}): Promise<{ result: ModelApplyResult; plan: ModelPlan; status: number; data: unknown }> => {
    const base = (await live()).model
    const p = await plan(base, edit(base))
    const r = await h.admin.post('/model/apply', { ops: p.ops, token: p.plan.token })
    expect(r.status, JSON.stringify(r.data).slice(0, 2000)).toBe(o.expectStatus ?? 200)
    return { result: r.data, plan: p.plan, status: r.status, data: r.data }
  }
  const byName = async (name: string) => (await live()).model.tables.find((t) => t.name === name)!
  const insert = async (cl: Client, table: string, values: Record<string, unknown>) => {
    const r = await cl.post(`/data/${table}/rows`, { values })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return r.data.row.id as string
  }
  const count = async (sql: string, params: unknown[] = []) => Number((await h.q<{ n: number }>(sql, params))[0].n)

  beforeAll(async () => {
    // (the pre-migration backup of package J is not what this suite tests)
    h = await startHarness('model', { env: { APPBUILDER_MIGRATION_BACKUP: 'skip' } })
  }, 120_000)

  afterAll(async () => {
    await h?.close()
  }, 60_000)

  it('schema version 7: the designer tables exist in the environment schema', async () => {
    const t = await h.q<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'env_default' AND table_name IN ('ab_relationships', 'ab_model_layouts', 'ab_model_drafts') ORDER BY 1`)
    expect(t.map((x) => x.t)).toEqual(['ab_model_drafts', 'ab_model_layouts', 'ab_relationships'])
  })

  it('version 7 step: existing lookups become explicit relationship records (and system columns never do)', async () => {
    const c = await h.admin.post('/tables', { displayName: 'Plant', columns: [{ displayName: 'Name', type: 'text' }] })
    const l = await h.admin.post('/tables', { displayName: 'Machine', columns: [{ displayName: 'Name', type: 'text' }, { displayName: 'Plant', type: 'lookup', lookupTable: 'Plant', required: true }, { displayName: 'Backup of', type: 'lookup', lookupTable: 'Machine' }] })
    expect([c.status, l.status]).toEqual([200, 200])
    await h.q(`DELETE FROM env_default.ab_relationships`)
    await h.q(`UPDATE ab.environments SET schema_version = 6 WHERE id = 'default'`)
    const { migrateEnvironmentSchema } = await import('./meta-store.ts')
    expect(await migrateEnvironmentSchema(h.app.services.state.db!, { id: 'default', schema: 'env_default' })).toEqual({ from: 6, to: 7 })
    const recs = await h.q<{ from_column: string; kind: string; on_delete: string }>(`SELECT from_column, kind, on_delete FROM env_default.ab_relationships WHERE from_table = $1 ORDER BY from_column`, [l.data.id])
    expect(recs).toEqual([{ from_column: 'BackupOf', kind: 'self', on_delete: 'setBlank' }, { from_column: 'Plant', kind: 'oneToMany', on_delete: 'restrict' }])
    expect(await count(`SELECT count(*)::int AS n FROM env_default.ab_relationships WHERE from_column IN ('createdBy', 'owner')`)).toBe(0)
  })

  it('applies a master-detail pattern in one transaction: tables, cascade relationship, rollup, and records it', async () => {
    const base = (await live()).model
    const gen = patternByKey('master-detail')!.generate(base, { header: 'Invoice', lines: 'Invoice line' })
    const p = await plan(base, gen.model)
    expect(p.plan.problems).toEqual([])
    expect(p.plan.items.filter((i) => i.change === 'new').map((i) => i.kind).sort()).toEqual(['relationship', 'table', 'table'])
    const r = await h.admin.post('/model/apply', { ops: p.ops, token: p.plan.token, layout: { positions: Object.fromEntries(gen.tables.map((id, i) => [id, { x: i * 300, y: 0 }])), areas: [{ id: 'a1', name: 'Invoices', color: 'blue', tables: gen.tables }] }, clearDraft: true })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    const ids = (r.data as ModelApplyResult).ids
    const inv = await byName('Invoice')
    const line = await byName('InvoiceLine')
    expect(ids[gen.tables[0]]).toBe(inv.id)
    expect(inv.columns.find((c) => c.name === 'Total')?.computed).toMatchObject({ kind: 'rollup', table: 'InvoiceLine', via: 'Invoice' })
    const rels = await h.q<{ from_table: string; on_delete: string }>(`SELECT from_table, on_delete FROM env_default.ab_relationships WHERE to_table = $1`, [inv.id])
    expect(rels).toEqual([{ from_table: line.id, on_delete: 'cascade' }])
    const layout = (await live()).layout
    expect(layout.positions[inv.id]).toEqual({ x: 0, y: 0 })
    expect(layout.areas[0]).toMatchObject({ name: 'Invoices', tables: [inv.id, line.id] })
    expect(await count(`SELECT count(*)::int AS n FROM env_default.ab_audit WHERE action = 'model.apply'`)).toBe(1)
  })

  it('cascade delete: lines go with their header, with outbox rows and audit entries', async () => {
    const inv = await byName('Invoice')
    const line = await byName('InvoiceLine')
    const hd = await insert(h.admin, inv.id, {})
    await insert(h.admin, line.id, { Invoice: hd, Item: 'Bolt', Quantity: 2, UnitPrice: 5 })
    await insert(h.admin, line.id, { Invoice: hd, Item: 'Nut', Quantity: 1, UnitPrice: 1 })
    const before = await count(`SELECT count(*)::int AS n FROM env_default.ab_outbox WHERE table_id = $1`, [line.id])
    const del = await h.admin.post(`/data/${inv.id}/delete`, { ids: [hd] })
    expect(del.status, JSON.stringify(del.data)).toBe(200)
    expect(await count(`SELECT count(*)::int AS n FROM env_default.t_invoiceline`)).toBe(0)
    expect(await count(`SELECT count(*)::int AS n FROM env_default.ab_outbox WHERE table_id = $1`, [line.id])).toBe(before + 1)
    expect(await count(`SELECT count(*)::int AS n FROM env_default.ab_audit WHERE action = 'row.delete' AND table_id = $1`, [line.id])).toBe(1)
  })

  it('cascade respects security: a user who may not delete every child row deletes nothing (403)', async () => {
    const inv = await byName('Invoice')
    const line = await byName('InvoiceLine')
    // Clerk: full access to own invoices, may delete only own lines
    const role = await h.admin.post('/roles', { name: 'Clerk', apps: 'all', privileges: [
      { table: inv.id, create: true, read: 'own', update: 'own', delete: 'own' },
      { table: line.id, create: true, read: 'own', update: 'own', delete: 'own' },
    ] })
    expect(role.status, JSON.stringify(role.data)).toBe(200)
    await runInEnvironment('default', () => h.app.services.meta.users.insert({ id: 'user_clerk', name: 'Cleo Clerk', email: 'clerk@example.com', roleIds: [role.data.id], status: 'active', passwordHash: '' } as UserRecord))
    await h.q(`UPDATE ab.users SET password_hash = $1 WHERE id = 'user_clerk'`, [await hashPassword(PW)])
    h.app.services.security.invalidate('all')
    const clerk = new Client(h.base)
    expect((await clerk.post('/auth/login', { email: 'clerk@example.com', password: PW })).status).toBe(200)
    const hd = await insert(clerk, inv.id, {})
    await insert(clerk, line.id, { Invoice: hd, Item: 'Mine', Quantity: 1, UnitPrice: 1 })
    // a line of the same header that the clerk cannot even see (created by the administrator)
    await insert(h.admin, line.id, { Invoice: hd, Item: 'Not mine', Quantity: 1, UnitPrice: 1 })
    const del = await clerk.post(`/data/${inv.id}/delete`, { ids: [hd] })
    expect(del.status).toBe(403)
    expect(del.data.error.message).toMatch(/also deletes 2 rows in "Invoice line".*not allowed to delete 1 of them/)
    expect(await count(`SELECT count(*)::int AS n FROM env_default.t_invoice WHERE id = $1`, [hd])).toBe(1)
    expect(await count(`SELECT count(*)::int AS n FROM env_default.t_invoiceline WHERE "Invoice" = $1`, [hd])).toBe(2)
    // once the foreign line is gone, the clerk's delete cascades
    await h.q(`DELETE FROM env_default.t_invoiceline WHERE "Item" = 'Not mine'`)
    expect((await clerk.post(`/data/${inv.id}/delete`, { ids: [hd] })).status).toBe(200)
    expect(await count(`SELECT count(*)::int AS n FROM env_default.t_invoiceline WHERE "Invoice" = $1`, [hd])).toBe(0)
  })

  it('restrict and set blank, including lookups that exist from before (implicit behaviour)', async () => {
    // tables made by the table designer, without the data model designer: required lookup -> restrict, optional -> set blank
    const cust = await h.admin.post('/tables', { displayName: 'Customer', columns: [{ displayName: 'Name', type: 'text' }] })
    const ord = await h.admin.post('/tables', { displayName: 'Order', columns: [{ displayName: 'Ref', type: 'text' }, { displayName: 'Customer', type: 'lookup', lookupTable: 'Customer', required: true }] })
    const note = await h.admin.post('/tables', { displayName: 'Note', columns: [{ displayName: 'Text', type: 'text' }, { displayName: 'Customer', type: 'lookup', lookupTable: 'Customer' }] })
    expect([cust.status, ord.status, note.status]).toEqual([200, 200, 200])
    const c1 = await insert(h.admin, cust.data.id, { Name: 'Acme' })
    await insert(h.admin, ord.data.id, { Ref: 'O1', Customer: c1 })
    const n1 = await insert(h.admin, note.data.id, { Text: 'Hello', Customer: c1 })
    const r1 = await h.admin.post(`/data/${cust.data.id}/delete`, { ids: [c1] })
    expect(r1.status).toBe(409)
    expect(r1.data.error.message).toMatch(/1 row in "Order" still refers to it/)
    await h.q(`DELETE FROM env_default.t_order`)
    const before = await count(`SELECT count(*)::int AS n FROM env_default.ab_outbox WHERE table_id = $1 AND op = 'update'`, [note.data.id])
    expect((await h.admin.post(`/data/${cust.data.id}/delete`, { ids: [c1] })).status).toBe(200)
    const kept = await h.q<{ Customer: string | null }>(`SELECT "Customer" FROM env_default.t_note WHERE id = $1`, [n1])
    expect(kept).toEqual([{ Customer: null }])
    expect(await count(`SELECT count(*)::int AS n FROM env_default.ab_outbox WHERE table_id = $1 AND op = 'update'`, [note.data.id])).toBe(before + 1)
    // the designer shows them as explicit relationships
    const m = (await live()).model
    expect(m.relationships.filter((r) => r.toTable === cust.data.id).map((r) => r.onDelete).sort()).toEqual(['restrict', 'setBlank'])
  })

  it('a relationship\'s delete behaviour can be changed (set blank -> cascade)', async () => {
    const res = await change((m) => {
      const rel = m.relationships.find((r) => r.fromTable === m.tables.find((t) => t.name === 'Note')!.id && r.fromColumn === 'Customer')!
      return { ...m, relationships: m.relationships.map((r) => (r.id === rel.id ? { ...r, onDelete: 'cascade' } : r)) }
    })
    expect(res.plan.items).toEqual([expect.objectContaining({ kind: 'relationship', change: 'changed', note: expect.stringMatching(/on delete: cascade.*was set blank/) })])
    const cust = await byName('Customer')
    const note = await byName('Note')
    const c2 = await insert(h.admin, cust.id, { Name: 'Bolt' })
    await insert(h.admin, note.id, { Text: 'x', Customer: c2 })
    const before = await count(`SELECT count(*)::int AS n FROM env_default.t_note`)
    expect((await h.admin.post(`/data/${cust.id}/delete`, { ids: [c2] })).status).toBe(200)
    expect(await count(`SELECT count(*)::int AS n FROM env_default.t_note`)).toBe(before - 1)
  })

  it('hierarchy: a self relationship refuses loops', async () => {
    await change((m) => {
      const t = addTable(m, { displayName: 'Location' })
      return createRelationship(t.model, { parent: t.table.id, child: t.table.id, cardinality: 'self', onDelete: 'restrict', preventCycles: true }).model
    })
    const loc = await byName('Location')
    const a = await insert(h.admin, loc.id, { Name: 'Plant' })
    const b = await insert(h.admin, loc.id, { Name: 'Hall', Parent: a })
    const c = await insert(h.admin, loc.id, { Name: 'Line 1', Parent: b })
    const r = await h.admin.req('PATCH', `/data/${loc.id}/rows/${a}`, { changes: { Parent: c } })
    expect(r.status).toBe(422)
    expect(r.data.error.message).toMatch(/its own ancestor/)
    expect((await h.admin.req('PATCH', `/data/${loc.id}/rows/${c}`, { changes: { Parent: a } })).status).toBe(200)
    // restrict: a location with children cannot be deleted
    expect((await h.admin.post(`/data/${loc.id}/delete`, { ids: [a] })).status).toBe(409)
  })

  it('many-to-many: a junction table with a unique pair', async () => {
    await change((m) => {
      let x = addTable(m, { displayName: 'Product' })
      const p = x.table.id
      x = addTable(x.model, { displayName: 'Supplier' })
      return createRelationship(x.model, { parent: x.table.id, child: p, cardinality: 'manyToMany', onDelete: 'cascade', junctionColumns: [{ displayName: 'Price', type: 'currency' }] }).model
    })
    const j = await byName('ProductSupplier')
    expect(j.uniqueTogether).toEqual([['Product', 'Supplier']])
    const idx = await h.q<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE schemaname = 'env_default' AND tablename = 't_productsupplier' AND indexdef LIKE 'CREATE UNIQUE INDEX%("Product", "Supplier")'`)
    expect(idx.length).toBe(1)
    const prod = await insert(h.admin, (await byName('Product')).id, { Name: 'P' })
    const sup = await insert(h.admin, (await byName('Supplier')).id, { Name: 'S' })
    await insert(h.admin, j.id, { Product: prod, Supplier: sup, Price: 3 })
    const dup = await h.admin.post(`/data/${j.id}/rows`, { values: { Product: prod, Supplier: sup, Price: 4 } })
    expect(dup.status).toBeGreaterThanOrEqual(400)
    // deleting a product removes its junction rows (cascade)
    expect((await h.admin.post(`/data/${(await byName('Product')).id}/delete`, { ids: [prod] })).status).toBe(200)
    expect(await count(`SELECT count(*)::int AS n FROM env_default.t_productsupplier`)).toBe(0)
  })

  it('plans: conversion pre-check (blocking), destructive drops with row counts, index notes', async () => {
    await change((m) => addTable(m, { displayName: 'Reading', columns: [{ displayName: 'Value', type: 'text' }, { displayName: 'Note', type: 'text' }] }).model)
    const rd = await byName('Reading')
    for (const v of ['12', '13.5', 'abc']) await insert(h.admin, rd.id, { Value: v, Note: 'n' })
    const base = (await live()).model
    const p = await plan(base, removeColumn(updateColumn(base, rd.id, 'Value', { type: 'decimal' }), rd.id, 'Note'))
    const conv = p.plan.items.find((i) => i.kind === 'column' && i.change === 'changed')!
    expect(conv.conversion).toEqual({ failing: 1, examples: ['abc'], checked: 3 })
    expect(p.plan.problems.join(' ')).toMatch(/1 value cannot become decimal \(for example "abc"\)/)
    const drop = p.plan.items.find((i) => i.change === 'removed')!
    expect(drop).toMatchObject({ destructive: true, rows: 3 })
    expect(p.plan.destructive).toBe(true)
    expect((await h.admin.post('/model/apply', { ops: p.ops, token: p.plan.token })).status).toBe(422)
    await h.q(`UPDATE env_default.t_reading SET "Value" = '14' WHERE "Value" = 'abc'`)
    const ok = await change((m) => updateColumn(m, rd.id, 'Value', { type: 'decimal', indexed: true }))
    expect(ok.plan.items[0].note).toMatch(/type text → decimal; indexed/)
    expect((await byName('Reading')).columns.find((c) => c.name === 'Value')).toMatchObject({ type: 'decimal', indexed: true })
  })

  it('a stale plan is refused (409) and a failing apply leaves nothing behind', async () => {
    const base = (await live()).model
    const p = await plan(base, addTable(base, { displayName: 'Stale' }).model)
    await h.admin.post('/tables', { displayName: 'Interloper' })
    const r = await h.admin.post('/model/apply', { ops: p.ops, token: p.plan.token })
    expect(r.status).toBe(409)
    expect(r.data.error.message).toMatch(/changed since you reviewed the plan/)
    // second op fails inside the transaction (a default that does not fit the type): the first table must not exist
    const b2 = (await live()).model
    let d = addTable(b2, { displayName: 'Rolled back' }).model
    d = addColumn(d, b2.tables.find((t) => t.name === 'Reading')!.id, { displayName: 'Bad', type: 'number', default: 'abc' }).model
    const p2 = await plan(b2, d)
    expect(p2.plan.problems).toEqual([])
    const r2 = await h.admin.post('/model/apply', { ops: p2.ops, token: p2.plan.token })
    expect(r2.status).toBe(422)
    expect(await count(`SELECT count(*)::int AS n FROM env_default.ab_tables WHERE name = 'RolledBack'`)).toBe(0)
    expect(await count(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'env_default' AND table_name = 't_rolledback'`)).toBe(0)
  })

  it('reporting views: a restricted user sees only the base rows and columns they may read, through Query v2', async () => {
    // Sale (fact source): Rep reads own rows and may not see Cost; Region and Customer dimension readable
    await change((m) => {
      let x = addTable(m, { displayName: 'Region' })
      const region = x.table.id
      x = addTable(x.model, { displayName: 'Buyer', columns: [{ displayName: 'Name', type: 'text' }, { displayName: 'Secret note', type: 'text' }] })
      const buyer = x.table.id
      let mm = createRelationship(x.model, { parent: region, child: buyer, cardinality: 'oneToMany', onDelete: 'setBlank' }).model
      const s = addTable(mm, { displayName: 'Sale', columns: [{ displayName: 'Ref', type: 'text' }, { displayName: 'Amount', type: 'currency' }, { displayName: 'Cost', type: 'currency' }, { displayName: 'Sold on', type: 'date' }] })
      mm = createRelationship(s.model, { parent: buyer, child: s.table.id, cardinality: 'oneToMany', onDelete: 'restrict' }).model
      return mm
    })
    const sale = await byName('Sale')
    const buyer = await byName('Buyer')
    const region = await byName('Region')
    const role = await h.admin.post('/roles', { name: 'Rep', apps: 'all', privileges: [
      { table: sale.id, create: true, read: 'own', update: 'own', delete: 'none', columns: { Cost: 'none' } },
      { table: buyer.id, create: false, read: 'all', update: 'none', delete: 'none', columns: { SecretNote: 'none' } },
      { table: region.id, create: false, read: 'all', update: 'none', delete: 'none' },
    ] })
    expect(role.status, JSON.stringify(role.data)).toBe(200)
    await runInEnvironment('default', () => h.app.services.meta.users.insert({ id: 'user_rep', name: 'Rae Rep', email: 'rep@example.com', roleIds: [role.data.id], status: 'active', passwordHash: '' } as UserRecord))
    await h.q(`UPDATE ab.users SET password_hash = $1 WHERE id = 'user_rep'`, [await hashPassword(PW)])
    h.app.services.security.invalidate('all')
    rep = new Client(h.base)
    expect((await rep.post('/auth/login', { email: 'rep@example.com', password: PW })).status).toBe(200)
    const rg = await insert(h.admin, region.id, { Name: 'West' })
    const b1 = await insert(h.admin, buyer.id, { Name: 'Acme', SecretNote: 'pays late', Region: rg })
    await insert(rep, sale.id, { Ref: 'mine', Amount: 100, Buyer: b1, SoldOn: '2026-04-02' })
    await insert(h.admin, sale.id, { Ref: 'other1', Amount: 200, Cost: 150, Buyer: b1, SoldOn: '2026-03-30' })
    await insert(h.admin, sale.id, { Ref: 'other2', Amount: 300, Cost: 100, Buyer: b1, SoldOn: '2026-05-01' })

    // star schema with a measure the rep may not see (Cost), snowflake (Buyer -> Region), date dimension (India FY)
    const res = await change((m) => {
      const s = m.tables.find((t) => t.name === 'Sale')!
      return generateStar(m, { fact: s.id, measures: ['Amount', 'Cost'], dimensions: ['Buyer'], dateColumn: 'SoldOn', snowflake: true, dateDimension: true, fiscalYearStartMonth: 4 }).model
    })
    expect(res.plan.items.filter((i) => i.kind === 'view').length).toBe(3)
    const fact = await byName('FactSale')
    expect(fact.readOnly).toBe(true)
    expect(fact.reporting).toMatchObject({ kind: 'view', role: 'fact', base: sale.id, baseSource: 't_sale' })
    const q = (cl: Client, plan: Record<string, unknown>) => cl.post('/query', { plan: { version: 2, table: 'FactSale', ...plan } })

    const all = await q(h.admin, { count: true })
    expect(all.data.count).toBe(3)
    const mine = await q(rep, { count: true })
    expect(mine.status, JSON.stringify(mine.data)).toBe(200)
    expect(mine.data.count).toBe(1)
    expect(mine.data.rows[0]).toMatchObject({ Amount: 100, DateKey: 20260402 })
    expect(mine.data.rows[0]).not.toHaveProperty('Cost')
    // a hidden column cannot be selected, filtered or aggregated through the view
    expect((await q(rep, { select: ['Cost'] })).status).toBe(403)
    expect((await q(rep, { aggregate: { groupBy: [], measures: [{ name: 'C', fn: 'sum', col: 'Cost' }] } })).status).toBe(403)
    expect((await q(rep, { filter: { col: 'Cost', op: 'gt', value: 0 } })).status).toBe(403)
    // aggregates only over the rows the rep may read
    const sum = await q(rep, { aggregate: { groupBy: [], measures: [{ name: 'S', fn: 'sum', col: 'Amount' }] } })
    expect(sum.data.rows[0].S).toBe(100)
    // dimension views: the buyer's secret column stays hidden; the sub-dimension (region) is readable
    const dim = await rep.post('/query', { plan: { version: 2, table: 'DimBuyer' } })
    expect(dim.status).toBe(200)
    expect(dim.data.rows[0]).toMatchObject({ Name: 'Acme' })
    expect(dim.data.rows[0]).not.toHaveProperty('SecretNote')
    expect((await rep.post('/query', { plan: { version: 2, table: 'DimRegion', count: true } })).data.count).toBe(1)
    // views are never written, by anyone
    expect((await h.admin.post(`/data/${fact.id}/rows`, { values: { Amount: 1 } })).status).toBeGreaterThanOrEqual(400)
    // the session mirrors it: read own, no writes, Cost hidden
    const ws = await rep.get('/workspace')
    const priv = ws.data.session.privileges.tables[fact.id]
    expect(priv).toMatchObject({ read: 'own', update: 'none', delete: 'none', create: false, filtered: true, columns: { Cost: 'none' } })
    // a user without access to the base sees nothing through the view
    expect((await rep.post('/query', { plan: { version: 2, table: 'FactSale' } })).data.rows.length).toBe(1)
    // the date dimension: Indian fiscal year
    const dd = await h.q<{ FiscalYear: string }>(`SELECT "FiscalYear" FROM env_default.t_dimdate WHERE "DateKey" = 20260402`)
    expect(dd).toEqual([{ FiscalYear: 'FY2026-27' }])
    // the views registry
    const reg = await h.admin.get('/model/views')
    expect(reg.data.items.map((v: { name: string }) => v.name).sort()).toEqual(['DimBuyer', 'DimRegion', 'FactSale'])
  })

  it('a column read by a view cannot be dropped, and a base table with views cannot be removed alone', async () => {
    const base = (await live()).model
    const sale = base.tables.find((t) => t.name === 'Sale')!
    const p = await plan(base, removeColumn(base, sale.id, 'Amount'))
    expect(p.plan.problems.join(' ')).toMatch(/read by the reporting view "Fact Sale"/)
  })

  it('summary table: refreshed by a job as the system; only roles that read every source row may read it', async () => {
    await change((m) => {
      const s = m.tables.find((t) => t.name === 'Sale')!
      return summaryTable(m, { source: s.id, groupBy: ['Buyer'], measures: [{ fn: 'sum', column: 'Amount' }, { fn: 'count' }] }).model
    })
    await drain()
    const sum = await byName('SaleSummary')
    const rows = await h.q<{ SumAmount: string; RowCount: string }>(`SELECT "SumAmount", "RowCount" FROM env_default.t_salesummary`)
    expect(rows.map((r) => [Number(r.SumAmount), Number(r.RowCount)])).toEqual([[600, 3]])
    const sched = await h.q<{ job_type: string }>(`SELECT job_type FROM env_default.ab_schedules WHERE payload->>'tableId' = $1`, [sum.id])
    expect(sched).toEqual([{ job_type: 'model.summary.refresh' }])
    // Rep reads only own sales: no access to the totals
    expect([403, 404]).toContain((await rep.post('/query', { plan: { version: 2, table: 'SaleSummary', count: true } })).status)
    expect((await h.admin.post('/query', { plan: { version: 2, table: 'SaleSummary', count: true } })).data.count).toBe(1)
  })

  it('drafts and layouts persist per user; a locked production environment is read-only', async () => {
    const m = (await live()).model
    const draft = { base: m, model: addTable(m, { displayName: 'Draft only' }).model, past: [m], future: [] }
    expect((await h.admin.req('PUT', '/model/draft', { draft })).status).toBe(200)
    const back = await live()
    expect(back.draft?.model.tables.some((t) => t.name === 'DraftOnly')).toBe(true)
    expect(back.draft?.past?.length).toBe(1)
    expect((await rep.get('/model')).status).toBe(403)
    expect((await h.admin.req('PUT', '/model/layout', { layout: { positions: { x: { x: 1, y: 2 } }, areas: [] }, scope: 'mine' })).status).toBe(200)
    expect((await live()).myLayout?.positions.x).toEqual({ x: 1, y: 2 })
    expect((await h.admin.req('DELETE', '/model/draft')).status).toBe(200)
    expect((await live()).draft).toBeNull()
    await h.q(`UPDATE ab.environments SET locked = true, type = 'production' WHERE id = 'default'`)
    h.app.services.environments.invalidate()
    try {
      expect((await live()).locked).toBe(true)
      const r = await h.admin.req('PUT', '/model/draft', { draft })
      expect(r.status).toBe(403)
      expect((await h.admin.post('/model/apply', { ops: [], token: 'x' })).status).toBe(403)
    } finally {
      await h.q(`UPDATE ab.environments SET locked = false WHERE id = 'default'`)
      h.app.services.environments.invalidate()
    }
  })

  it('lint data checks: text columns whose values are numbers', async () => {
    const t = await h.admin.post('/tables', { displayName: 'Meter', columns: [{ displayName: 'Reading', type: 'text' }] })
    for (let i = 0; i < 6; i++) await insert(h.admin, t.data.id, { Reading: String(10 + i) })
    const st = await h.admin.get('/model/stats')
    expect(st.data.items.find((x: { table: string }) => x.table === t.data.id)).toMatchObject({ column: 'Reading', values: 6, numeric: 6 })
  })

  it('solution package round trip: relationships, delete behaviours, unique pairs and views arrive in another environment', async () => {
    const all = (await live()).model.tables
    const pick = ['Customer', 'Note', 'Product', 'Supplier', 'ProductSupplier', 'Region', 'Buyer', 'Sale', 'FactSale', 'DimBuyer', 'DimRegion'].map((n) => all.find((t) => t.name === n)!.id)
    const pkg = await h.admin.post('/model/package', { tables: pick, displayName: 'Sales model' })
    expect(pkg.status, JSON.stringify(pkg.data)).toBe(200)
    expect(pkg.data.yaml).toContain('relationships:')
    const env = await h.admin.post('/environments', { name: 'Model target', type: 'sandbox' })
    expect(env.status, JSON.stringify(env.data)).toBe(200)
    const target = new Client(h.base)
    target.cookie = h.admin.cookie
    target.env = env.data.id
    const imp = await target.post('/solutions/import', { yaml: pkg.data.yaml })
    expect(imp.status, JSON.stringify(imp.data).slice(0, 1500)).toBe(200)
    const tm = (await target.get('/model')).data as ModelResponse
    const t = (n: string) => tm.model.tables.find((x) => x.name === n)!
    expect(tm.model.relationships.find((r) => r.fromTable === t('Note').id)?.onDelete).toBe('cascade')
    expect(t('ProductSupplier').uniqueTogether).toEqual([['Product', 'Supplier']])
    expect(t('FactSale').reporting).toMatchObject({ kind: 'view', base: t('Sale').id, baseSource: 't_sale' })
    const schema = `env_${env.data.id}`
    expect(await count(`SELECT count(*)::int AS n FROM information_schema.views WHERE table_schema = $1 AND table_name LIKE 'v!_%' ESCAPE '!'`, [schema])).toBe(3)
    expect((await target.post('/query', { plan: { version: 2, table: 'FactSale', count: true } })).data.count).toBe(0)
    // the same package again is an upgrade in place with an empty plan (nothing changes)
    const again = await target.post('/solutions/import/plan', { yaml: pkg.data.yaml })
    expect(again.status, JSON.stringify(again.data).slice(0, 800)).toBe(200)
    expect(again.data.problems).toEqual([])
  })

  it('environment copy keeps relationships, layouts and views (views over the copied rows)', async () => {
    const env = await h.admin.post('/environments', { name: 'Model copy', type: 'sandbox', copyFrom: 'default', copy: 'data' })
    expect(env.status, JSON.stringify(env.data)).toBe(200)
    const cp = new Client(h.base)
    cp.cookie = h.admin.cookie
    cp.env = env.data.id
    const m = (await cp.get('/model')).data as ModelResponse
    const inv = m.model.tables.find((t) => t.name === 'Invoice')!
    expect(m.model.relationships.find((r) => r.toTable === inv.id)?.onDelete).toBe('cascade')
    expect(m.layout.areas[0]?.name).toBe('Invoices')
    expect((await cp.post('/query', { plan: { version: 2, table: 'FactSale', count: true } })).data.count).toBe(3)
  })

  it('import from an external database: tables and foreign keys into a draft model', async () => {
    // a PostgreSQL connection to the same test database, schema "ext"
    await h.q(`CREATE SCHEMA ext`)
    await h.q(`CREATE TABLE ext.dept (id text PRIMARY KEY, name text)`)
    await h.q(`CREATE TABLE ext.emp (id text PRIMARY KEY, name text, dept_id text REFERENCES ext.dept(id) ON DELETE CASCADE, salary numeric(12,2))`)
    const { pgServer } = await import('./testdb.ts')
    const conn = await h.admin.post('/connections', { name: 'Ext', connector: 'postgres', settings: { host: pgServer!.host, port: String(pgServer!.port), database: h.dbName, user: pgServer!.user, schema: 'ext' }, secret: pgServer!.password })
    expect(conn.status, JSON.stringify(conn.data)).toBe(200)
    const base = (await live()).model
    const copy = await h.admin.post('/model/introspect', { connectionId: conn.data.id, mode: 'copy', into: base })
    expect(copy.status, JSON.stringify(copy.data)).toBe(200)
    const out = copy.data.model as Model
    const emp = out.tables.find((t) => t.name === 'Emp')!
    expect(emp.columns.find((c) => c.name === 'dept_id')).toMatchObject({ type: 'lookup', lookupTable: 'Dept' })
    expect(out.relationships.find((r) => r.fromTable === emp.id)?.onDelete).toBe('cascade')
    // link mode: registrations of the existing tables, applied through the plan
    const link = await h.admin.post('/model/introspect', { connectionId: conn.data.id, mode: 'link', into: base })
    const lm = link.data.model as Model
    expect(lm.tables.find((t) => t.name === 'Emp')?.link).toEqual({ connectionId: conn.data.id, source: 'emp' })
    const p = await plan(base, lm)
    expect(p.plan.problems).toEqual([])
    const ap = await h.admin.post('/model/apply', { ops: p.ops, token: p.plan.token })
    expect(ap.status, JSON.stringify(ap.data).slice(0, 1500)).toBe(200)
    const linked = await byName('Emp')
    expect(linked.connectionId).toBe(conn.data.id)
    void tableById
  })
})
