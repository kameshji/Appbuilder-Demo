/**
 * The ERP-lite pack end to end against the sandbox PostgreSQL (docs/guide/maker/erp-lite-pack.md, exit check 12): the
 * stock balance is installed as a synchronous balance; a purchase request is approved by a manager on behalf of its
 * requester, becomes a purchase order (approved above the limit), is received in two partial goods receipts and the
 * stock follows; a sales order is delivered in part, a delivery beyond the stock is refused in plain words, the
 * delivery is invoiced without tax; transfers, counts, the reorder alert; 20 parallel issues of the last 10 units; the
 * roles' row and column security; the shared tables of the common business model; the upgrade to 1.1.0.
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/templates/erp-lite
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { startHarness, type KernelHarness } from '../kernel-testkit.ts'
import { setQuiet } from '../util.ts'
import { runInEnvironment } from '../env-context.ts'
import { registerTestTemplates } from './catalogue.ts'
import { erpLiteNext } from './testdata/erp-lite-next.ts'
import type { UserContext } from '../contracts.ts'
import { HttpError } from '../contracts.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[erp-lite pack integration] ${SKIP_PG}\n`)
const S = 'env_default'
type Any = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(!PG_URL)(PG_URL ? 'the ERP-lite pack (PostgreSQL)' : `erp-lite pack ${SKIP_PG}`, { timeout: 300_000 }, () => {
  let h: KernelHarness
  let erp: Any
  const who: Record<string, string> = {}
  const ids: Record<string, string> = {}
  const inEnv = <T>(fn: () => Promise<T>) => runInEnvironment('default', fn)
  const drain = async () => {
    for (let i = 0; i < 10; i++) {
      await h.app.services.kernel.drain({ timeoutMs: 60_000 })
      const t = await inEnv(() => h.app.services.approvals!.tick(true))
      const n = await inEnv(() => h.app.services.flows.sweep(true))
      if (!n && !t.delegations && !t.reminders && !t.escalations) break
    }
    await h.app.services.kernel.drain({ timeoutMs: 60_000 })
  }
  const ctxOf = async (email: string): Promise<UserContext> => inEnv(async () => h.app.services.security.forUser((await h.app.services.meta.users.byEmail(email))!))
  const tableDef = async (name: string) => inEnv(async () => (await h.app.services.meta.tables.list()).find((x) => x.name === name)!)
  const insert = async (email: string, table: string, values: Any) => inEnv(async () => h.app.services.data.insert(await ctxOf(email), await tableDef(table), values) as Promise<Any>)
  const update = async (email: string, table: string, id: string, values: Any) => inEnv(async () => h.app.services.data.update(await ctxOf(email), await tableDef(table), id, values) as Promise<Any>)
  const rows = async (table: string, where = 'TRUE', params: unknown[] = []) => h.q<Any>(`SELECT * FROM ${S}."${(await tableDef(table)).source}" WHERE ${where}`, params)
  const onHand = async (item: string, loc: string) => Number((await rows('StockBalances', `"Item" = $1 AND "Location" = $2`, [ids[item], ids[loc]]))[0]?.OnHand ?? 0)
  const refusal = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError)
      return (e as HttpError).message
    }
    throw new Error('the write was not refused')
  }
  const requestAbout = async (rowId: string) => (await h.q<Any>(`SELECT * FROM ${S}.ab_approval_requests WHERE regarding_id = $1 ORDER BY created_on DESC`, [rowId]))[0]
  const pending = async (requestId: string) => (await h.q<Any>(`SELECT u.email FROM ${S}.ab_approval_assignments a JOIN ab.users u ON u.id = a.user_id WHERE a.request_id = $1 AND a.status = 'pending' ORDER BY u.email`, [requestId])).map((x) => x.email)
  const respond = async (email: string, id: string, outcome: string) => inEnv(async () => h.app.services.approvals!.respond(await ctxOf(email), id, outcome, null))
  const notified = async (email: string, re: RegExp) => (await h.q<Any>(`SELECT n.title FROM ab.notifications n JOIN ab.users u ON u.id = n.user_id WHERE lower(u.email) = lower($1)`, [email])).filter((n) => re.test(n.title))
  const v2 = async (email: string, table: string, plan: Any) => inEnv(async () => (h.app.services.data as Any).queryV2(await ctxOf(email), await tableDef(table), { version: 2, table, ...plan }))

  beforeAll(async () => {
    h = await startHarness('tplerp')
    const A = h.admin
    const p = await A.post('/templates/builtin.erp-lite/plan', { mode: 'linked', sample: true })
    expect(p.data.plan?.problems, JSON.stringify(p.data).slice(0, 400)).toEqual([])
    const r = await A.post('/templates/builtin.erp-lite/install', { mode: 'linked', bindings: p.data.bindings, sample: true, confirm: p.data.plan.token, ...(p.data.plan.systemEvents?.length ? { approveSystem: true } : {}) })
    expect(r.status, JSON.stringify(r.data).slice(0, 600)).toBe(200)
    erp = r.data.install
    await drain()
    expect((await A.post(`/templates/installed/${erp.id}/flows`, { enable: erp.created.flows.map((f: Any) => f.id) })).status).toBe(200)
    const role = (key: string) => erp.created.roles.find((x: Any) => x.key === key).id
    const mk = async (k: string, name: string, email: string, roleKey: string, extra: Any = {}) => {
      const u = await A.post('/users', { name, email, password: 'some-password-1', roleIds: [role(roleKey)], ...extra })
      expect(u.status, JSON.stringify(u.data)).toBe(200)
      who[k] = u.data.id
    }
    await mk('mgr', 'Mala Manager', 'mala@example.com', 'Manager')
    await mk('req', 'Ravi Requester', 'ravi@example.com', 'Requester', { managerId: who.mgr })
    await mk('pur', 'Priya Purchase', 'priya@example.com', 'Purchase')
    await mk('st', 'Sunil Stores', 'sunil@example.com', 'Stores')
    await mk('s1', 'Sara Sales', 'sara@example.com', 'Sales')
    await mk('s2', 'Sam Sales', 'sam@example.com', 'Sales')
    // masters in the shared tables (the common business model), as an administrator
    const admin = 'ada@example.com'
    ids.bolt = (await insert(admin, 'Products', { Code: 'BOLT-M10', Name: 'Hex bolt M10', Kind: 'Goods', HsnSac: '7318', StandardPrice: 12 })).id
    ids.nut = (await insert(admin, 'Products', { Code: 'NUT-M10', Name: 'Hex nut M10', Kind: 'Goods', StandardPrice: 4 })).id
    ids.pin = (await insert(admin, 'Products', { Code: 'PIN-6', Name: 'Dowel pin 6', Kind: 'Goods', StandardPrice: 3 })).id
    ids.supplier = (await insert(admin, 'Accounts', { Name: 'Example Fasteners (fictional)', Type: 'Supplier' })).id
    ids.customer = (await insert(admin, 'Accounts', { Name: 'Example Motors (fictional)', Type: 'Customer' })).id
    ids.pl = (await insert(admin, 'PriceLists', { Name: 'Trade 2026', IsDefault: true })).id
    await insert(admin, 'PriceListItems', { PriceList: ids.pl, Product: ids.bolt, UnitPrice: 20 })
    ids.main = (await rows('Locations', `"Code" = 'SAMPLE-MAIN'`))[0].id
    ids.line = (await rows('Locations', `"Code" = 'SAMPLE-LINE'`))[0].id
  }, 300_000)

  afterAll(async () => { await h?.close() }, 60_000)

  it('installs the stock balance as a synchronous balance on the shared Products and its own Locations', async () => {
    const sb = await tableDef('StockBalances')
    expect(sb.balance).toMatchObject({ movements: 'StockMovements', quantity: 'Quantity', column: 'OnHand', keys: [{ column: 'Item', from: 'Item' }, { column: 'Location', from: 'Location' }], floor: 0 })
    expect(sb.uniqueTogether).toEqual([['Item', 'Location']])
    // the common business model's tables are used, not copied
    const names = (await inEnv(() => h.app.services.meta.tables.list())).map((t) => t.name)
    expect(names.filter((n) => /Products$/.test(n))).toEqual(['Products'])
    expect(names).not.toContain('ErpProducts')
  })

  it('a purchase request is approved by the manager on behalf of its requester and becomes a purchase order, approved above the limit', async () => {
    const pr = await insert('ravi@example.com', 'PurchaseRequests', { Title: 'Bolts for the line', NeededBy: '2026-12-01', PreferredSupplier: ids.supplier, Justification: 'Monthly use' })
    expect([pr.owner, pr.Requester], JSON.stringify(who)).toEqual([who.req, who.req])
    expect(pr.Number).toMatch(/^PR\/\d{4}-\d{2}\/0001$/)
    await insert('ravi@example.com', 'PurchaseRequestLines', { Request: pr.id, Item: ids.bolt, Qty: 100, Unit: 'Nos', Rate: 700 })
    await update('ravi@example.com', 'PurchaseRequests', pr.id, { Status: 'Submitted' })
    await drain()
    const req = await requestAbout(pr.id)
    // the flow asks on behalf of the person who raised the request: they are never asked and cannot approve it
    expect(req.definition.onBehalfOf).toContain(who.req)
    expect(await pending(req.id)).toEqual(['mala@example.com'])
    await expect(respond('ravi@example.com', req.id, 'Approve')).rejects.toThrow()
    expect(await respond('mala@example.com', req.id, 'Approve')).toMatchObject({ status: 'approved' })
    await drain()
    expect((await rows('PurchaseRequests', 'id = $1', [pr.id]))[0].Status).toBe('Ordered')
    const po = (await rows('PurchaseOrders', `"Request" = $1`, [pr.id]))[0]
    expect(po).toMatchObject({ Supplier: ids.supplier, Status: 'Draft' })
    const lines = await rows('PurchaseOrderLines', `"Order" = $1`, [po.id])
    expect(lines.map((l) => [l.Item, Number(l.Quantity), Number(l.Rate)])).toEqual([[ids.bolt, 100, 700]])
    ids.po = po.id
    ids.pol = lines[0].id
    // 70,000 is above the 50,000 limit: the manager approves
    await update('priya@example.com', 'PurchaseOrders', po.id, { Status: 'Awaiting approval' })
    await drain()
    const oreq = await requestAbout(po.id)
    expect(await pending(oreq.id)).toEqual(['mala@example.com'])
    await respond('mala@example.com', oreq.id, 'Approve')
    await drain()
    expect((await rows('PurchaseOrders', 'id = $1', [po.id]))[0]).toMatchObject({ Status: 'Approved', Approval: 'Approved' })
  })

  it('two partial goods receipts: the stock follows each line and the order becomes Partly received, then Received', async () => {
    const g1 = await insert('sunil@example.com', 'GoodsReceipts', { PurchaseOrder: ids.po, Location: ids.main, SupplierDocument: 'DC-1' })
    expect(g1.Supplier).toBe(ids.supplier)
    await insert('sunil@example.com', 'StockMovements', { Kind: 'Receipt', GoodsReceipt: g1.id, PurchaseOrderLine: ids.pol, Item: ids.bolt, Location: ids.main, Quantity: 60 })
    expect(await onHand('bolt', 'main')).toBe(60)
    await drain()
    expect((await rows('PurchaseOrders', 'id = $1', [ids.po]))[0].Status).toBe('Partly received')
    expect(Number((await rows('PurchaseOrderLines', 'id = $1', [ids.pol]))[0].Received)).toBe(60)
    const g2 = await insert('sunil@example.com', 'GoodsReceipts', { PurchaseOrder: ids.po, Location: ids.main, SupplierDocument: 'DC-2' })
    expect(await refusal(insert('sunil@example.com', 'StockMovements', { Kind: 'Receipt', GoodsReceipt: g2.id, PurchaseOrderLine: ids.pol, Item: ids.bolt, Location: ids.main, Quantity: 41 }))).toBe('This is more than is still to be received on the order line.')
    await insert('sunil@example.com', 'StockMovements', { Kind: 'Receipt', GoodsReceipt: g2.id, PurchaseOrderLine: ids.pol, Item: ids.bolt, Location: ids.main, Quantity: 40 })
    expect(await onHand('bolt', 'main')).toBe(100)
    await drain()
    expect((await rows('PurchaseOrders', 'id = $1', [ids.po]))[0].Status).toBe('Received')
    // the GRN prints
    const pt = erp.created.printTemplates.find((x: Any) => x.key === 'GoodsReceipt')
    expect((await h.admin.post('/print/generate', { template: pt.id, recordId: g2.id })).status).toBe(200)
  })

  it('a sales order delivered in part; a delivery beyond the stock is refused in plain words; the delivery is invoiced without tax', async () => {
    const so = await insert('sara@example.com', 'SalesOrders', { Customer: ids.customer, PriceList: ids.pl, Status: 'Confirmed' })
    const line = await insert('sara@example.com', 'SalesOrderLines', { Order: so.id, PriceList: ids.pl, Item: ids.bolt, Quantity: 500 })
    expect(Number(line.UnitPrice)).toBe(20)
    const dl = await insert('sunil@example.com', 'Deliveries', { SalesOrder: so.id, Location: ids.main, VehicleNo: 'XX 00 X 0000' })
    expect(dl.Customer).toBe(ids.customer)
    expect(dl.Number).toMatch(/^DC\//)
    await insert('sunil@example.com', 'StockMovements', { Kind: 'Issue', Delivery: dl.id, SalesOrderLine: line.id, Item: ids.bolt, Location: ids.main, Quantity: 30 })
    expect(await onHand('bolt', 'main')).toBe(70)
    expect(await refusal(insert('sunil@example.com', 'StockMovements', { Kind: 'Issue', Delivery: dl.id, SalesOrderLine: line.id, Item: ids.bolt, Location: ids.main, Quantity: 120 }))).toBe('Stock of Hex bolt M10 at SAMPLE-MAIN would go below zero: available 70, requested 120.')
    expect(await onHand('bolt', 'main')).toBe(70)
    await drain()
    expect((await rows('SalesOrders', 'id = $1', [so.id]))[0].Status).toBe('Partly delivered')
    await update('sunil@example.com', 'Deliveries', dl.id, { Status: 'Dispatched' })
    await drain()
    expect((await notified('sara@example.com', /^Dispatched: DC\//)).length).toBe(1)
    await update('sunil@example.com', 'Deliveries', dl.id, { Status: 'Delivered' })
    await drain()
    const inv = (await rows('CommercialInvoices', `"Delivery" = $1`, [dl.id]))[0]
    expect(inv).toMatchObject({ Customer: ids.customer, Status: 'Draft' })
    const il = await rows('CommercialInvoiceLines', `"Invoice" = $1`, [inv.id])
    expect(il.map((x) => [Number(x.Quantity), Number(x.UnitPrice), Number(x.Amount), x.Description])).toEqual([[30, 20, 600, 'Hex bolt M10']])
    // no tax anywhere: no column of the invoice tables names a tax, and the print says it is not a tax invoice
    for (const t of ['CommercialInvoices', 'CommercialInvoiceLines']) expect((await tableDef(t)).columns.map((c) => c.name).filter((n) => /tax|gst|cgst|sgst|igst/i.test(n))).toEqual([])
    const pt = erp.created.printTemplates.find((x: Any) => x.key === 'Invoice')
    const doc = JSON.stringify((await h.q<Any>(`SELECT * FROM ${S}.ab_print_templates WHERE id = $1`, [pt.id]))[0])
    expect(doc).toContain('NOT A TAX INVOICE')
    expect((await h.admin.post('/print/generate', { template: pt.id, recordId: inv.id })).status).toBe(200)
    const ch = erp.created.printTemplates.find((x: Any) => x.key === 'Challan')
    expect((await h.admin.post('/print/generate', { template: ch.id, recordId: dl.id })).status).toBe(200)
  })

  it('transfers, counts and the reorder alert', async () => {
    await insert('sunil@example.com', 'StockMovements', { Kind: 'Transfer out', Item: ids.bolt, Location: ids.main, ToLocation: ids.line, Quantity: 10 })
    expect(await onHand('bolt', 'main')).toBe(60)
    await drain()
    expect(await onHand('bolt', 'line')).toBe(10)
    const count = await insert('sunil@example.com', 'StockMovements', { Kind: 'Count', Item: ids.bolt, Location: ids.main, Counted: 57 })
    expect(Number(count.Quantity)).toBe(-3)
    expect(await onHand('bolt', 'main')).toBe(57)
    const bal = (await rows('StockBalances', `"Item" = $1 AND "Location" = $2`, [ids.bolt, ids.main]))[0]
    await update('sunil@example.com', 'StockBalances', bal.id, { ReorderLevel: 50, OnHand: 9999 })
    expect(await onHand('bolt', 'main')).toBe(57)
    await insert('sunil@example.com', 'StockMovements', { Kind: 'Issue', Item: ids.bolt, Location: ids.main, Quantity: 10 })
    await drain()
    expect((await notified('priya@example.com', /^Reorder: Hex bolt M10 at SAMPLE-MAIN/)).length).toBe(1)
    const below = await v2('sunil@example.com', 'StockBalances', { filter: { col: 'OnHand', op: 'cmpCol', cmp: 'lt', other: 'ReorderLevel' }, select: ['Item', 'OnHand'] })
    expect(below.rows.map((x: Any) => x.Item)).toEqual([ids.bolt])
  })

  it('20 parallel issues of the last 10 units: exactly 10 succeed and the stock never goes below zero', async () => {
    await insert('sunil@example.com', 'StockMovements', { Kind: 'Receipt', Item: ids.pin, Location: ids.main, Quantity: 10 })
    const res = await Promise.allSettled(Array.from({ length: 20 }, () => insert('sunil@example.com', 'StockMovements', { Kind: 'Issue', Item: ids.pin, Location: ids.main, Quantity: 1 })))
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(10)
    for (const r of res.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) expect(String((r.reason as Error).message)).toBe('Stock of Dowel pin 6 at SAMPLE-MAIN would go below zero: available 0, requested 1.')
    expect(await onHand('pin', 'main')).toBe(0)
    const neg = await h.q<Any>(`SELECT count(*)::int AS n FROM ${S}."${(await tableDef('StockBalances')).source}" WHERE "OnHand" < 0`)
    expect(neg[0].n).toBe(0)
  })

  it('roles: a sales person sees only their own orders; the stores do not see purchase rates; nobody writes the balance directly', async () => {
    await insert('sam@example.com', 'SalesOrders', { Customer: ids.customer, Status: 'Draft' })
    const sara = await v2('sara@example.com', 'SalesOrders', { select: ['Number', 'owner'] })
    expect(sara.rows.length).toBeGreaterThan(0)
    expect(sara.rows.every((x: Any) => x.owner === who.s1)).toBe(true)
    const sam = await v2('sam@example.com', 'SalesOrders', { select: ['Number', 'owner'] })
    expect(sam.rows.every((x: Any) => x.owner === who.s2)).toBe(true)
    await expect(v2('sunil@example.com', 'PurchaseOrderLines', { select: ['Rate'] })).rejects.toThrow(/do not have access/)
    expect((await v2('sunil@example.com', 'PurchaseOrderLines', { select: ['Quantity', 'Received'] })).rows.length).toBe(1)
    expect(await refusal(insert('ada@example.com', 'StockBalances', { Item: ids.nut, Location: ids.main, OnHand: 5 }))).toMatch(/kept by the platform/)
    expect(await refusal(insert('ravi@example.com', 'PurchaseOrders', { Supplier: ids.supplier }))).toMatch(/not allowed/)
  })

  it('upgrades to 1.1.0: a new column and reference row, the changed app kept or replaced, the stock untouched', async () => {
    const before = await h.q<Any>(`SELECT id, "OnHand"::text AS q FROM ${S}."${(await tableDef('StockBalances')).source}" ORDER BY id`)
    const unreg = registerTestTemplates([erpLiteNext()])
    try {
      const up = await h.admin.post(`/templates/installed/${erp.id}/upgrade/plan`, {})
      expect(up.data.plan?.problems, JSON.stringify(up.data).slice(0, 500)).toEqual([])
      const done = await h.admin.post(`/templates/installed/${erp.id}/upgrade`, { confirm: up.data.plan.token, proceedWithoutBackup: true })
      expect(done.status, JSON.stringify(done.data).slice(0, 500)).toBe(200)
    } finally {
      unreg()
    }
    expect((await tableDef('Locations')).columns.map((c) => c.name)).toContain('Address')
    expect((await rows('MovementReasons', `"Name" LIKE 'Sample sent%'`)).length).toBe(1)
    expect((await tableDef('StockBalances')).balance).toMatchObject({ movements: 'StockMovements' })
    expect(await h.q<Any>(`SELECT id, "OnHand"::text AS q FROM ${S}."${(await tableDef('StockBalances')).source}" ORDER BY id`)).toEqual(before)
  })
})
