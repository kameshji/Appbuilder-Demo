/**
 * Table events, formula columns, rollups and the outbox on PostgreSQL (docs/dev/events-and-jobs.md):
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/events
 * The worker is not started: the tests drive dispatch and jobs with services.kernel.drain().
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from './testdb.ts'
import { setQuiet } from './util.ts'
import { runInEnvironment } from './env-context.ts'
import { startHarness, type KernelHarness } from './kernel-testkit.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[server/core events integration] ${SKIP_PG}\n`)

describe.skipIf(!PG_URL)('table events (PostgreSQL)', () => {
  let h: KernelHarness
  const A = () => h.admin
  const drain = () => h.app.services.kernel.drain({ timeoutMs: 60_000 })
  const outbox = (table: string) => h.q<{ id: number; op: string; row_id: string; changed: string[]; before: Record<string, unknown>; after: Record<string, unknown>; actor_id: string; correlation_id: string; request_id: string }>(
    'SELECT o.* FROM env_default.ab_outbox o JOIN env_default.ab_tables t ON t.id = o.table_id WHERE t.name = $1 ORDER BY o.id', [table])
  let ordersId = ''
  let linesId = ''

  beforeAll(async () => {
    h = await startHarness('events')
    const orders = await A().post('/tables', { displayName: 'Sales orders', name: 'SalesOrders', columns: [{ displayName: 'Ref', type: 'text' }, { displayName: 'Status', type: 'text' }, { displayName: 'Note', type: 'text' }] })
    expect(orders.status, JSON.stringify(orders.data)).toBe(200)
    ordersId = orders.data.id
    const lines = await A().post('/tables', { displayName: 'Order lines', name: 'Lines', columns: [{ displayName: 'Item', type: 'text' }, { displayName: 'Qty', type: 'number' }, { displayName: 'Price', type: 'decimal' }, { displayName: 'Order', name: 'Order', type: 'lookup', lookupTable: 'SalesOrders' }] })
    expect(lines.status, JSON.stringify(lines.data)).toBe(200)
    linesId = lines.data.id
  }, 120000)

  afterAll(async () => { await h?.close() }, 60000)

  it('every write has its outbox row, in the same transaction; a rolled-back write has none', async () => {
    const r = await A().post('/data/SalesOrders/rows', { values: { Ref: 'O-1', Status: 'Open' } })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    const id = r.data.row.id
    expect((await A().patch(`/data/SalesOrders/rows/${id}`, { changes: { Status: 'Paid' } })).status).toBe(200)
    const rows = await outbox('SalesOrders')
    expect(rows.map((x) => x.op)).toEqual(['insert', 'update'])
    expect(rows[1]).toMatchObject({ row_id: id, changed: ['Status'], before: { id, Status: 'Open' }, after: { id, Status: 'Paid' } })
    expect(rows[1].actor_id).toBeTruthy()
    expect(rows[1].request_id).toBeTruthy()
    // a failure after the outbox row was written rolls everything back
    const k = h.app.services.kernel
    const real = k.hooks.outbox
    k.hooks.outbox = async (...a) => { await real(...a); throw new Error('boom after the outbox write') }
    try {
      const f = await A().patch(`/data/SalesOrders/rows/${id}`, { changes: { Status: 'Lost' } })
      expect(f.status).toBe(500)
    } finally {
      k.hooks.outbox = real
    }
    expect((await outbox('SalesOrders')).length).toBe(2)
    expect((await h.q<{ s: string }>(`SELECT "Status" AS s FROM env_default.t_salesorders WHERE id = $1`, [id]))[0].s).toBe('Paid')
  }, 60000)

  it('validation rules refuse a write with a message bound to the field', async () => {
    const v = await A().post(`/tables/${linesId}/events`, { kind: 'validation', name: 'Positive quantity', condition: 'Qty > 0', message: 'Quantity must be more than 0', field: 'Qty' })
    expect(v.status, JSON.stringify(v.data)).toBe(200)
    const bad = await A().post('/data/Lines/rows', { values: { Item: 'Bolt', Qty: 0, Price: 2 } })
    expect(bad.status).toBe(422)
    expect(bad.data.error).toMatchObject({ message: 'Quantity must be more than 0', field: 'Qty' })
    const before = (await outbox('Lines')).length
    expect(before).toBe(0)
    const ok = await A().post('/data/Lines/rows', { values: { Item: 'Bolt', Qty: 3, Price: 2 } })
    expect(ok.status, JSON.stringify(ok.data)).toBe(200)
    const runs = (await A().get(`/tables/${linesId}/event-runs`)).data.items
    expect(runs.some((x: any) => x.status === 'rejected' && x.eventName === 'Positive quantity')).toBe(true)
  }, 60000)

  it('formula columns are computed on write, read-only, recomputed when inputs change, backfilled when the formula changes', async () => {
    const c = await A().post(`/tables/${linesId}/columns`, { displayName: 'Line total', name: 'LineTotal', type: 'decimal', computed: { kind: 'formula', formula: 'Qty * Price' } })
    expect(c.status, JSON.stringify(c.data)).toBe(200)
    await drain() // backfill of the existing row
    const all = (await A().post('/data/Lines/query', {})).data.rows
    expect(all.map((r: any) => r.LineTotal)).toEqual([6])
    const r = await A().post('/data/Lines/rows', { values: { Item: 'Nut', Qty: 4, Price: 2.5, LineTotal: 999 } })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    expect(r.data.row.LineTotal).toBe(10)
    const u = await A().patch(`/data/Lines/rows/${r.data.row.id}`, { changes: { Qty: 5 } })
    expect(u.data.row.LineTotal).toBe(12.5)
    // the formula changes: every row is recomputed by a job
    const p = await A().patch(`/tables/${linesId}/columns/LineTotal`, { computed: { kind: 'formula', formula: 'Qty * Price * 2' } })
    expect(p.status, JSON.stringify(p.data)).toBe(200)
    await drain()
    const after = (await A().post('/data/Lines/query', { orderBy: [{ col: 'Item', dir: 'asc' }] })).data.rows
    expect(after.map((x: any) => [x.Item, x.LineTotal])).toEqual([['Bolt', 12], ['Nut', 25]])
    // bad formulas are refused at save time
    const cyc = await A().post(`/tables/${linesId}/columns`, { displayName: 'A', name: 'A1', type: 'number', computed: { kind: 'formula', formula: 'A1 + 1' } })
    expect(cyc.status).toBe(422)
    const nav = await A().post(`/tables/${linesId}/columns`, { displayName: 'B', name: 'B1', type: 'number', computed: { kind: 'formula', formula: 'Navigate(Screen1)' } })
    expect(nav.status).toBe(422)
    expect(nav.data.error.message).toMatch(/only calculates a value/)
  }, 120000)

  it('rollups follow child changes (after commit, through jobs) and the reconcile job repairs drift', async () => {
    const o = (await A().post('/data/SalesOrders/rows', { values: { Ref: 'O-2' } })).data.row.id
    const t = await A().post(`/tables/${ordersId}/columns`, { displayName: 'Total', name: 'Total', type: 'decimal', computed: { kind: 'rollup', table: 'Lines', via: 'Order', fn: 'sum', column: 'LineTotal' } })
    expect(t.status, JSON.stringify(t.data)).toBe(200)
    const n = await A().post(`/tables/${ordersId}/columns`, { displayName: 'Line count', name: 'LineCount', type: 'number', computed: { kind: 'rollup', table: 'Lines', via: 'Order', fn: 'count' } })
    expect(n.status, JSON.stringify(n.data)).toBe(200)
    const l1 = (await A().post('/data/Lines/rows', { values: { Item: 'A', Qty: 1, Price: 10, Order: o } })).data.row.id
    await A().post('/data/Lines/rows', { values: { Item: 'B', Qty: 2, Price: 10, Order: o } })
    await drain()
    const get = async () => (await A().post('/data/SalesOrders/query', { where: { col: 'id', op: 'eq', value: o } })).data.rows[0]
    expect(await get()).toMatchObject({ Total: 60, LineCount: 2 })
    await A().patch(`/data/Lines/rows/${l1}`, { changes: { Qty: 3 } })
    await drain()
    expect(await get()).toMatchObject({ Total: 100, LineCount: 2 })
    await A().post('/data/Lines/delete', { ids: [l1] })
    await drain()
    expect(await get()).toMatchObject({ Total: 40, LineCount: 1 })
    // drift (a write behind the platform's back) is repaired by the reconcile job
    await h.q(`UPDATE env_default.t_salesorders SET "Total" = 1 WHERE id = $1`, [o])
    await runInEnvironment('default', () => h.app.services.kernel.jobs.enqueue('rollup.reconcile', {}))
    await drain()
    expect(await get()).toMatchObject({ Total: 40 })
    // writes to a rollup column are ignored
    await A().patch(`/data/SalesOrders/rows/${o}`, { changes: { Total: 5 } })
    expect(await get()).toMatchObject({ Total: 40 })
  }, 120000)

  it('before-events set fields and reject; after-events write through the job queue and log their runs', async () => {
    const b = await A().post(`/tables/${ordersId}/events`, { name: 'Uppercase ref', timing: 'before', operations: ['create', 'update'], actions: 'SetField({Ref: Upper(New.Ref)}); If(New.Status = "Blocked", Reject("Blocked orders cannot be saved", Status))' })
    expect(b.status, JSON.stringify(b.data)).toBe(200)
    const r = await A().post('/data/SalesOrders/rows', { values: { Ref: 'abc', Status: 'Open' } })
    expect(r.data.row.Ref).toBe('ABC')
    const rej = await A().post('/data/SalesOrders/rows', { values: { Ref: 'x', Status: 'Blocked' } })
    expect(rej.status).toBe(422)
    expect(rej.data.error).toMatchObject({ message: 'Blocked orders cannot be saved', field: 'Status' })
    const a = await A().post(`/tables/${ordersId}/events`, { name: 'Note the line', timing: 'after', operations: ['create'], condition: 'New.Status = "Open"', actions: 'Collect(Lines, {Item: "Auto for " & New.Ref, Qty: 1, Price: 1, Order: New.id}); Patch(SalesOrders, LookUp(SalesOrders, id = New.id), {Note: "auto"})' })
    expect(a.status, JSON.stringify(a.data)).toBe(200)
    const o = (await A().post('/data/SalesOrders/rows', { values: { Ref: 'evt', Status: 'Open' } })).data.row.id
    await drain()
    const lines = (await A().post('/data/Lines/query', { where: { col: 'Order', op: 'eq', value: o } })).data.rows
    expect(lines.map((x: any) => x.Item)).toEqual(['Auto for EVT'])
    const order = (await A().post('/data/SalesOrders/query', { where: { col: 'id', op: 'eq', value: o } })).data.rows[0]
    expect(order).toMatchObject({ Note: 'auto', LineCount: 1, Total: 2 })
    const runs = (await A().get(`/tables/${ordersId}/event-runs`)).data.items
    expect(runs.some((x: any) => x.eventName === 'Note the line' && x.status === 'ok')).toBe(true)
    // save-time checks
    const nav = await A().post(`/tables/${ordersId}/events`, { name: 'x', timing: 'after', actions: 'Navigate(Screen1)' })
    expect(nav.status).toBe(422)
    expect(nav.data.error.message).toMatch(/changes the screen/)
    const beforePatch = await A().post(`/tables/${ordersId}/events`, { name: 'y', timing: 'before', actions: 'Patch(Lines, Defaults(Lines), {Item: "x"})' })
    expect(beforePatch.status).toBe(422)
    expect(beforePatch.data.error.message).toMatch(/before the write/)
    const whole = await A().post(`/tables/${ordersId}/events`, { name: 'z', timing: 'after', actions: 'ForAll(Lines, Patch(Lines, ThisRecord, {Qty: 1}))' })
    expect(whole.status).toBe(422)
    const bounded = await A().post(`/tables/${ordersId}/events`, { name: 'bounded', timing: 'after', enabled: false, actions: 'ForAll(FirstN(Filter(Lines, Order = New.id), 100), Patch(Lines, ThisRecord, {Qty: 1}))' })
    expect(bounded.status, JSON.stringify(bounded.data)).toBe(200)
  }, 120000)

  it('the test run shows the changes or the rejection without writing', async () => {
    const t = await A().post(`/tables/${ordersId}/events/test`, { event: { name: 't', timing: 'before', actions: 'SetField({Note: "Order " & New.Ref})' }, sample: { Ref: 'Q1' } })
    expect(t.status, JSON.stringify(t.data)).toBe(200)
    expect(t.data).toMatchObject({ changes: { Note: 'Order Q1' } })
    const v = await A().post(`/tables/${linesId}/events/test`, { event: { kind: 'validation', name: 'v', condition: 'Qty > 0', message: 'No', field: 'Qty' }, sample: { Qty: 0 } })
    expect(v.data.rejected).toEqual({ message: 'No', field: 'Qty' })
  }, 60000)
})
