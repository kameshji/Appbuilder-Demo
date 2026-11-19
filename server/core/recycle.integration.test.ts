/**
 * Recycle bin (docs/dev/recycle-bin.md) against the sandbox PostgreSQL (APPBUILDER_TEST_DB): soft delete in batches,
 * every read path leaves deleted rows out, restore undoes exactly one batch (cascade, set blank, collaboration rows,
 * shares), unique values free at once and checked on restore, security of the bin, events and flows on restore,
 * rollups, purge, concurrency, schema 9 -> 10 without a behaviour change, index use (EXPLAIN).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from './testdb.ts'
import { Client, startHarness } from './kernel-testkit.ts'
import type { KernelHarness } from './kernel-testkit.ts'
import { setQuiet } from './util.ts'
import { runInEnvironment } from './env-context.ts'
import { hashPassword } from './password.ts'
import type { UserRecord } from './contracts.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[recycle] ${SKIP_PG}\n`)

const PW = 'member-password-1'

describe.skipIf(!PG_URL)(PG_URL ? 'recycle bin (PostgreSQL)' : `recycle bin (PostgreSQL) ${SKIP_PG}`, { timeout: 120_000 }, () => {
  let h: KernelHarness
  let product = ''
  const drain = () => h.app.services.kernel.drain({ timeoutMs: 60_000 })
  const ok = <T>(r: { status: number; data: T }, status = 200): T => {
    expect(r.status, JSON.stringify(r.data).slice(0, 1500)).toBe(status)
    return r.data
  }
  const table = async (displayName: string, columns: unknown[], extra: Record<string, unknown> = {}) => ok(await h.admin.post('/tables', { displayName, columns, ...extra })) as { id: string; name: string; recycleDays?: number; recycleBin?: boolean }
  const insert = async (cl: Client, t: string, values: Record<string, unknown>) => (ok(await cl.post(`/data/${t}/rows`, { values })) as { row: { id: string } }).row.id
  const rows = async (cl: Client, t: string, q: Record<string, unknown> = {}) => (ok(await cl.post(`/data/${t}/query`, q)) as { rows: Record<string, unknown>[]; total?: number }).rows
  const v2 = async (cl: Client, plan: Record<string, unknown>) => ok(await cl.post('/query', { plan })) as { rows: Record<string, unknown>[]; count?: number }
  const relate = async (child: string, column: string, parent: string, onDelete: 'restrict' | 'cascade' | 'setBlank') => {
    await h.q(`INSERT INTO env_default.ab_relationships (id, from_table, from_column, to_table, kind, on_delete, created_on, modified_on) VALUES ($1, $2, $3, $4, 'oneToMany', $5, now(), now())
      ON CONFLICT (from_table, from_column) DO UPDATE SET on_delete = EXCLUDED.on_delete`, [`rel_${child}_${column}`, child, column, parent, onDelete])
  }
  const member = async (id: string, email: string, privileges: unknown[]): Promise<Client> => {
    const role = ok(await h.admin.post('/roles', { name: `Role ${id}`, apps: 'all', privileges })) as { id: string }
    await runInEnvironment('default', () => h.app.services.meta.users.insert({ id, name: `User ${id}`, email, roleIds: [role.id], status: 'active', passwordHash: '' } as UserRecord))
    await h.q(`UPDATE ab.users SET password_hash = $1 WHERE id = $2`, [await hashPassword(PW), id])
    h.app.services.security.invalidate('all')
    const c = new Client(h.base)
    ok(await c.post('/auth/login', { email, password: PW }))
    return c
  }

  beforeAll(async () => {
    h = await startHarness('recycle', { env: { APPBUILDER_MIGRATION_BACKUP: 'skip' } })
  }, 120_000)

  afterAll(async () => {
    await h?.close()
  }, 60_000)

  it('schema 10: the batch tables exist; a new table keeps deleted rows for 30 days, with the columns and partial indexes', async () => {
    const t = await h.q<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'env_default' AND table_name IN ('ab_delete_batches', 'ab_delete_effects') ORDER BY 1`)
    expect(t.map((x) => x.t)).toEqual(['ab_delete_batches', 'ab_delete_effects'])
    const p = await table('Product', [{ displayName: 'Code', type: 'text', unique: true }, { displayName: 'Name', type: 'text', indexed: true }])
    product = p.id
    expect([p.recycleDays, p.recycleBin]).toEqual([30, true])
    const cols = (await h.q<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'env_default' AND table_name = 't_product' ORDER BY ordinal_position`)).map((r) => r.c)
    expect(cols).toEqual(expect.arrayContaining(['deletedOn', 'deletedBy', 'deleteBatch']))
    const idx = await h.q<{ indexname: string; indexdef: string }>(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'env_default' AND tablename = 't_product'`)
    const def = (name: string) => idx.find((i) => i.indexname === name)?.indexdef ?? ''
    expect(def('uq_t_product_Code')).toMatch(/WHERE \("deletedOn" IS NULL\)/)
    expect(def('kx_t_product_Name')).toMatch(/WHERE \("deletedOn" IS NULL\)/)
    expect(def('ix_t_product_natural')).toMatch(/WHERE \("deletedOn" IS NULL\)/)
    expect(def('ix_t_product_deletedOn')).toMatch(/WHERE \("deletedOn" IS NOT NULL\)/)
    // the API never shows the recycle bin columns
    const r = await rows(h.admin, p.id)
    expect(r).toEqual([])
    await insert(h.admin, p.id, { Code: 'P-1', Name: 'Bolt' })
    expect(Object.keys((await rows(h.admin, p.id))[0])).not.toContain('deletedOn')
    expect(ok(await h.admin.post(`/data/${p.id}/query`, { select: ['deletedOn'] }), 422)).toBeTruthy()
  })

  it('delete: the row disappears at once, comes back with the batch; the unique value is free meanwhile and checked on restore', async () => {
    const p = { id: product }
    const id = (await rows(h.admin, p.id, { where: { col: 'Code', op: 'eq', value: 'P-1' } }))[0].id as string
    const del = ok(await h.admin.post(`/data/${p.id}/delete`, { ids: [id] })) as { deleted: number; batch: { id: string; rows: number; daysLeft: number } }
    expect(del.deleted).toBe(1)
    expect(del.batch).toMatchObject({ rows: 1, daysLeft: 30 })
    expect(await rows(h.admin, p.id)).toEqual([])
    // the row stays in the table, stamped
    const raw = await h.q<{ deletedBy: string; deleteBatch: string }>(`SELECT "deletedBy", "deleteBatch" FROM env_default.t_product WHERE id = $1`, [id])
    expect(raw[0]).toEqual({ deletedBy: expect.any(String), deleteBatch: del.batch.id })
    // the Deleted view
    const list = ok(await h.admin.get(`/data/${p.id}/deleted`)) as { rows: { id: string; Code: string; __deleted: { batch: string; daysLeft: number; byName: string } }[]; total: number }
    expect(list.total).toBe(1)
    expect(list.rows[0]).toMatchObject({ id, Code: 'P-1', __deleted: { batch: del.batch.id, daysLeft: 30, byName: 'Ada' } })
    // the unique value is free: a new P-1, then the restore is refused, naming the row that uses it
    const again = await insert(h.admin, p.id, { Code: 'p-1', Name: 'New bolt' })
    const refused = ok(await h.admin.post(`/data/${p.id}/restore`, { batch: del.batch.id }), 409) as { error: { message: string } }
    expect(refused.error.message).toMatch(/Code "p-1" is used by "p-1" \(id [0-9a-f-]+\) now/)
    expect(refused.error.message).toContain(again)
    ok(await h.admin.post(`/data/${p.id}/delete`, { ids: [again] }))
    const back = ok(await h.admin.post(`/data/${p.id}/restore`, { batch: del.batch.id })) as { restored: number; warnings: string[] }
    expect(back).toMatchObject({ restored: 1, warnings: [] })
    expect((await rows(h.admin, p.id)).map((r) => r.Code)).toEqual(['P-1'])
    // restored once: a second restore says so
    expect((ok(await h.admin.post(`/data/${p.id}/restore`, { batch: del.batch.id }), 409) as { error: { message: string } }).error.message).toMatch(/already been restored/)
    const audit = await h.q<{ action: string; details: { batch?: string } }>(`SELECT action, details FROM env_default.ab_audit WHERE table_id = $1 AND action IN ('row.delete', 'row.restore') ORDER BY id`, [p.id])
    expect(audit.map((a) => a.action)).toEqual(['row.delete', 'row.delete', 'row.restore'])
    expect(audit[0].details.batch).toBe(del.batch.id)
  })

  /* ------------------------------------------------------------------ a parent with children: every read path */

  const ids: Record<string, string> = {}
  const T: Record<string, string> = {}
  const upload = async (cl: Client, t: string, column: string, rowId: string, name: string, data: string) => {
    const res = await fetch(`${h.base}/api/v1/attachments?table=${t}&column=${column}&rowId=${rowId}&name=${name}`, { method: 'POST', headers: { 'X-Appbuilder': '1', Cookie: cl.cookie, 'Content-Type': 'text/plain' }, body: Buffer.from(data) })
    expect(res.status).toBe(200)
    return ((await res.json()) as { id: string }).id
  }

  it('setup: customers, orders (cascade), lines (cascade), notes (set blank), rollups, sharing, collaboration rows, a file', async () => {
    T.cust = (await table('Cust', [{ displayName: 'Name', type: 'text' }, { displayName: 'Code', type: 'text', unique: true }, { displayName: 'Doc', type: 'file' }])).id
    ok(await h.admin.patch(`/tables/${T.cust}`, { sharing: true }))
    T.ord = (await table('Ord', [{ displayName: 'Ref', type: 'text' }, { displayName: 'Cust', type: 'lookup', lookupTable: 'Cust', required: true }, { displayName: 'Amount', type: 'number' }])).id
    T.line = (await table('Line', [{ displayName: 'Ord', type: 'lookup', lookupTable: 'Ord', required: true }, { displayName: 'Qty', type: 'number' }])).id
    T.note = (await table('Note', [{ displayName: 'Text', type: 'text' }, { displayName: 'Cust', type: 'lookup', lookupTable: 'Cust' }])).id
    await relate(T.ord, 'Cust', T.cust, 'cascade')
    await relate(T.line, 'Ord', T.ord, 'cascade')
    ok(await h.admin.post(`/tables/${T.cust}/columns`, { displayName: 'Orders', name: 'OrdCount', type: 'number', computed: { kind: 'rollup', table: 'Ord', via: 'Cust', fn: 'count' } }))
    ok(await h.admin.post(`/tables/${T.cust}/columns`, { displayName: 'Order total', name: 'OrdSum', type: 'decimal', computed: { kind: 'rollup', table: 'Ord', via: 'Cust', fn: 'sum', column: 'Amount' } }))
    ids.c1 = await insert(h.admin, T.cust, { Name: 'Contoso', Code: 'C1' })
    ids.c2 = await insert(h.admin, T.cust, { Name: 'Fabrikam', Code: 'C2' })
    ids.o1 = await insert(h.admin, T.ord, { Ref: 'O1', Cust: ids.c1, Amount: 100 })
    ids.o2 = await insert(h.admin, T.ord, { Ref: 'O2', Cust: ids.c1, Amount: 50 })
    ids.o3 = await insert(h.admin, T.ord, { Ref: 'O3', Cust: ids.c2, Amount: 7 })
    for (const o of [ids.o1, ids.o1, ids.o2, ids.o2]) await insert(h.admin, T.line, { Ord: o, Qty: 1 })
    ids.l3 = await insert(h.admin, T.line, { Ord: ids.o3, Qty: 3 })
    ids.n1 = await insert(h.admin, T.note, { Text: 'call back', Cust: ids.c1 })
    ids.file = await upload(h.admin, T.cust, 'Doc', ids.c1, 'contract.txt', 'signed')
    // collaboration: a comment, a follow, a tag; a share with a member
    ids.comment = (ok(await h.admin.post('/data/Comments/rows', { values: { Body: 'Key account', regardingId: ids.c1 } })) as { row: { id: string } }).row.id
    ok(await h.admin.post('/collab/follow', { row: ids.c1, table: T.cust, on: true }))
    ok(await h.admin.post('/collab/tags', { row: ids.c1, table: T.cust, tag: 'VIP' }))
    const viewer = await member('user_viewer', 'viewer@example.com', [{ table: T.cust, create: false, read: 'own', update: 'none', delete: 'none' }])
    void viewer
    ok(await h.admin.post('/shares', { row: ids.c1, table: T.cust, principal: 'viewer@example.com', access: 'read' }))
    await drain()
    const c = (await rows(h.admin, T.cust, { where: { col: 'id', op: 'eq', value: ids.c1 } }))[0]
    expect([c.OrdCount, c.OrdSum]).toEqual([2, 150])
  })

  it('deleting the customer: one batch with the cascade, the set-blank value, collaboration rows and the share; the file stays', async () => {
    const before = await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.sys_comments`)
    const del = ok(await h.admin.post(`/data/${T.cust}/delete`, { ids: [ids.c1] })) as { deleted: number; batch: { id: string; rows: number } }
    ids.batch = del.batch.id
    expect(del.batch.rows).toBe(7) // the customer, 2 orders, 4 lines
    const eff = await h.q<{ kind: string; n: number }>(`SELECT kind, count(*)::int AS n FROM env_default.ab_delete_effects WHERE batch_id = $1 GROUP BY kind ORDER BY kind`, [ids.batch])
    expect(Object.fromEntries(eff.map((e) => [e.kind, e.n]))).toMatchObject({ row: 7, setBlank: 1, share: 1 })
    // collaboration rows about the record: comment, follow, tag link, attachment link
    expect(eff.find((e) => e.kind === 'collab')!.n).toBeGreaterThanOrEqual(3)
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.sys_comments`))[0].n).toBe(before[0].n - 1)
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.ab_shares WHERE row_id = $1`, [ids.c1]))[0].n).toBe(0)
    // the note lost its link; the file and its record stay until the purge
    expect((await rows(h.admin, T.note))[0].Cust).toBeNull()
    expect(await h.app.services.meta.attachments.get(ids.file)).not.toBeNull()
    await drain()
  })

  it('every read path leaves the deleted rows out', async () => {
    const A = h.admin
    // v1: rows, count, lookup display (rows by id), filters
    expect((await rows(A, T.cust)).map((r) => r.Code)).toEqual(['C2'])
    expect((ok(await A.post(`/data/${T.cust}/query`, { count: true, top: 0 })) as { total: number }).total).toBe(1)
    expect(await rows(A, T.ord, { where: { col: 'id', op: 'in', value: [ids.o1, ids.o2, ids.o3] } })).toHaveLength(1)
    expect(await rows(A, T.line, { where: { col: 'Ord', op: 'eq', value: ids.o1 } })).toEqual([])
    // Query v2: rows, count, aggregates, grouped aggregates, search, single
    expect((await v2(A, { version: 2, table: 'Cust', count: true })).count).toBe(1)
    expect((await v2(A, { version: 2, table: 'Ord', aggregate: { groupBy: [], measures: [{ name: 'Total', fn: 'sum', col: 'Amount' }, { name: 'N', fn: 'count' }] } })).rows).toEqual([{ Total: 7, N: 1 }])
    expect((await v2(A, { version: 2, table: 'Line', aggregate: { groupBy: ['Ord'], measures: [{ name: 'N', fn: 'count' }] } })).rows).toEqual([{ Ord: ids.o3, N: 1 }])
    expect((await v2(A, { version: 2, table: 'Cust', search: { text: 'contoso', columns: ['Name'] }, count: true })).count).toBe(0)
    expect((await v2(A, { version: 2, table: 'Cust', page: { size: 10 } })).rows.map((r) => r.Code)).toEqual(['C2'])
    // a lookup path (via) to a deleted row finds nothing; with orMissing the row counts as missing (legacy pointer)
    await h.q(`UPDATE env_default.t_note SET "Cust" = $1 WHERE id = $2`, [ids.c1, ids.n1])
    expect((await v2(A, { version: 2, table: 'Note', filter: { via: { col: 'Cust', table: 'Cust', where: { col: 'Code', op: 'eq', value: 'C1' } } }, count: true })).count).toBe(0)
    expect((await v2(A, { version: 2, table: 'Note', filter: { via: { col: 'Cust', table: 'Cust', where: { col: 'Code', op: 'eq', value: 'nobody' }, orMissing: true } }, count: true })).count).toBe(1)
    await h.q(`UPDATE env_default.t_note SET "Cust" = NULL WHERE id = $1`, [ids.n1])
    // CSV export
    const csv = ok(await A.get(`/tables/${T.cust}/csv`)) as string
    expect(csv).toContain('Fabrikam')
    expect(csv).not.toContain('Contoso')
    // rollups exclude deleted children (an order of the live customer deleted alone: the count drops, then comes back)
    const d3 = ok(await A.post(`/data/${T.ord}/delete`, { ids: [ids.o3] })) as { batch: { id: string } }
    await drain()
    expect((await rows(A, T.cust))[0]).toMatchObject({ OrdCount: 0, OrdSum: 0 })
    ok(await A.post(`/data/${T.ord}/restore`, { batch: d3.batch.id }))
    await drain()
    expect((await rows(A, T.cust))[0]).toMatchObject({ OrdCount: 1, OrdSum: 7 })
    expect(await rows(A, T.line, { where: { col: 'Ord', op: 'eq', value: ids.o3 } })).toHaveLength(1)
    // formulas that read other tables (event test run: CountRows over the table)
    const t = ok(await A.post(`/tables/${T.note}/events/test`, { event: { kind: 'event', timing: 'before', name: 'probe', operations: ['create'], actions: 'SetField(Text, Text(CountRows(Cust)) & "/" & Text(CountRows(Filter(Ord, Amount > 0))))' }, sample: {}, op: 'create' })) as { sets?: Record<string, unknown> }
    expect(JSON.stringify(t)).toContain('1/1')
    // the timeline of the deleted record: not found
    expect((await A.get(`/collab/timeline?table=${T.cust}&row=${ids.c1}`)).status).toBe(404)
    // a lookup to a deleted row is refused like a missing one
    expect((await A.post(`/data/${T.ord}/rows`, { values: { Ref: 'X', Cust: ids.c1 } })).status).toBe(422)
    // the attachment of a deleted row cannot be downloaded
    expect((await A.get(`/attachments/${ids.file}`)).status).toBe(404)
  })

  it('the Deleted view lists the cascaded rows too, with the batch; restore undoes exactly the batch', async () => {
    const A = h.admin
    const lines = ok(await A.get(`/data/${T.line}/deleted`)) as { rows: { __deleted: { batch: string; cascaded: boolean; rootTableName: string } }[] }
    expect(lines.rows).toHaveLength(4)
    expect(lines.rows[0].__deleted).toMatchObject({ batch: ids.batch, cascaded: true, rootTableName: 'Cust' })
    // one order alone cannot come back while its customer is in the bin
    const single = ok(await A.post(`/data/${T.ord}/restore`, { rowId: ids.o1 }), 409) as { error: { message: string } }
    expect(single.error.message).toMatch(/deleted together with it\. Restore the whole batch/)
    const res = ok(await A.post(`/data/${T.cust}/restore`, { batch: ids.batch })) as { restored: number; warnings: string[] }
    expect(res).toMatchObject({ restored: 7, warnings: [] })
    await drain()
    expect((await rows(A, T.cust)).map((r) => r.Code).sort()).toEqual(['C1', 'C2'])
    expect((await rows(A, T.line)).length).toBe(5)
    expect((await rows(A, T.note))[0].Cust).toBe(ids.c1)
    const c = (await rows(A, T.cust, { where: { col: 'id', op: 'eq', value: ids.c1 } }))[0]
    expect([c.OrdCount, c.OrdSum]).toEqual([2, 150])
    // collaboration rows and the share are back
    const tl = ok(await A.get(`/collab/timeline?table=${T.cust}&row=${ids.c1}`)) as { items: { kind: string; id: string }[]; following: boolean; tags: { name: string }[] }
    expect(tl.items.some((i) => i.kind === 'comment' && i.id === ids.comment)).toBe(true)
    expect(tl.following).toBe(true)
    expect(tl.tags.map((t) => t.name)).toEqual(['VIP'])
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.ab_shares WHERE row_id = $1`, [ids.c1]))[0].n).toBe(1)
    expect((await h.q<{ state: string }>(`SELECT state FROM env_default.ab_delete_batches WHERE id = $1`, [ids.batch]))[0].state).toBe('restored')
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.ab_delete_effects WHERE batch_id = $1`, [ids.batch]))[0].n).toBe(0)
    // a value set since wins over the set-blank undo (reported)
    const d = ok(await A.post(`/data/${T.cust}/delete`, { ids: [ids.c1] })) as { batch: { id: string } }
    const other = await insert(A, T.cust, { Name: 'Other', Code: 'C9' })
    ok(await A.patch(`/data/${T.note}/rows/${ids.n1}`, { changes: { Cust: other } }))
    const r2 = ok(await A.post(`/data/${T.cust}/restore`, { batch: d.batch.id })) as { warnings: string[] }
    expect(r2.warnings.join(' ')).toMatch(/has another Cust since; that value was kept/)
    expect((await rows(A, T.note))[0].Cust).toBe(other)
  })

  /* ------------------------------------------------------------------ security */

  it('security: a restricted user sees and restores only rows they could delete and can see; administrators all', async () => {
    const A = h.admin
    T.task = (await table('Job', [{ displayName: 'Title', type: 'text' }])).id
    const rep = await member('user_rep', 'rep@example.com', [{ table: T.task, create: true, read: 'own', update: 'own', delete: 'own' }])
    const mine = await insert(rep, T.task, { Title: 'mine' })
    const theirs = await insert(A, T.task, { Title: 'theirs' })
    const dm = ok(await rep.post(`/data/${T.task}/delete`, { ids: [mine] })) as { batch: { id: string } }
    const dt = ok(await A.post(`/data/${T.task}/delete`, { ids: [theirs] })) as { batch: { id: string } }
    const seen = ok(await rep.get(`/data/${T.task}/deleted`)) as { rows: { Title: string }[] }
    expect(seen.rows.map((r) => r.Title)).toEqual(['mine'])
    expect((ok(await A.get(`/data/${T.task}/deleted`)) as { rows: unknown[] }).rows).toHaveLength(2)
    // someone else's batch: answered like a missing one; the row id too
    expect((await rep.post(`/data/${T.task}/restore`, { batch: dt.batch.id })).status).toBe(404)
    expect((await rep.post(`/data/${T.task}/restore`, { rowId: theirs })).status).toBe(404)
    // only administrators delete for good or empty the bin
    expect((await rep.post(`/data/${T.task}/purge`, { batch: dm.batch.id })).status).toBe(403)
    expect((await rep.post(`/data/${T.task}/purge`, { all: true, confirm: 'Job' })).status).toBe(403)
    // stats (sizes) are for makers and administrators
    expect(ok(await rep.get(`/data/${T.task}/recycle`))).toEqual({ enabled: true, keepDays: 30 })
    expect(ok(await A.get(`/data/${T.task}/recycle`))).toMatchObject({ enabled: true, keepDays: 30, deletedRows: 2, batches: 2, bytes: expect.any(Number) })
    ok(await rep.post(`/data/${T.task}/restore`, { batch: dm.batch.id }))
    expect((await rows(rep, T.task)).map((r) => r.Title)).toEqual(['mine'])
    ok(await A.post(`/data/${T.task}/restore`, { rowId: theirs }))
    expect((await rows(A, T.task))).toHaveLength(2)
  })

  it('one row back: the row and the rows its delete took along, without the rest of the batch', async () => {
    const A = h.admin
    const before = (await rows(A, T.line)).length
    const extra = await insert(A, T.cust, { Name: 'Extra', Code: 'C7' })
    const eo = await insert(A, T.ord, { Ref: 'E1', Cust: extra, Amount: 3 })
    await insert(A, T.line, { Ord: eo, Qty: 1 })
    const d = ok(await A.post(`/data/${T.cust}/delete`, { ids: [ids.c2, extra] })) as { batch: { id: string; rows: number } }
    expect(d.batch.rows).toBe(6) // 2 customers, 2 orders, 2 lines
    const r = ok(await A.post(`/data/${T.cust}/restore`, { rowId: extra })) as { restored: number }
    expect(r.restored).toBe(3)
    expect((await rows(A, T.cust)).map((x) => x.Code)).toContain('C7')
    expect((await rows(A, T.cust)).some((x) => x.id === ids.c2)).toBe(false)
    expect((await h.q<{ state: string; row_count: number }>(`SELECT state, row_count FROM env_default.ab_delete_batches WHERE id = $1`, [d.batch.id]))[0]).toEqual({ state: 'partial', row_count: 3 })
    ok(await A.post(`/data/${T.cust}/restore`, { batch: d.batch.id }))
    expect((await rows(A, T.line)).length).toBe(before + 1)
  })

  /* ------------------------------------------------------------------ events, flows, outbox */

  it('events and flows: delete as before; restore is its own operation, off unless an event or trigger lists it', async () => {
    const A = h.admin
    T.ev = (await table('EvRow', [{ displayName: 'Name', type: 'text' }])).id
    T.log = (await table('EvLog', [{ displayName: 'Msg', type: 'text' }])).id
    ok(await A.post(`/tables/${T.ev}/events`, { kind: 'event', timing: 'after', name: 'on restore', operations: ['restore'], actions: 'Collect(EvLog, {Msg: "restored " & ThisRecord.Name})' }))
    ok(await A.post(`/tables/${T.ev}/events`, { kind: 'event', timing: 'after', name: 'on delete', operations: ['delete'], actions: 'Collect(EvLog, {Msg: "deleted " & ThisRecord.Name})' }))
    // restore cannot start a before-event
    expect((await A.post(`/tables/${T.ev}/events`, { kind: 'event', timing: 'before', name: 'bad', operations: ['restore'], actions: 'Reject("no")' })).status).toBe(422)
    const settings = { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' }
    const fr = ok(await A.post('/flows', { settings, enabled: true, name: 'On restore', trigger: { type: 'table', table: 'EvRow', on: ['restore'] }, steps: [{ id: 'c', name: 'C', kind: 'compose', value: 'Trigger.Operation & " " & Trigger.Record.Name' }] })) as { flow: { id: string } }
    const fd = ok(await A.post('/flows', { settings, enabled: true, name: 'On delete', trigger: { type: 'table', table: 'EvRow', on: ['delete'] }, steps: [{ id: 'c', name: 'C', kind: 'compose', value: '"x"' }] })) as { flow: { id: string } }
    const a = await insert(A, T.ev, { Name: 'Asha' })
    const d = ok(await A.post(`/data/${T.ev}/delete`, { ids: [a] })) as { batch: { id: string } }
    const flowDrain = async () => {
      for (let i = 0; i < 6; i++) {
        await drain()
        const n = await runInEnvironment('default', () => h.app.services.flows.sweep(true))
        if (!n) break
      }
    }
    await flowDrain()
    ok(await A.post(`/data/${T.ev}/restore`, { batch: d.batch.id }))
    await flowDrain()
    expect((await rows(A, T.log)).map((r) => r.Msg).sort()).toEqual(['deleted Asha', 'restored Asha'])
    const runs = async (id: string) => h.q<{ trigger_summary: string }>('SELECT trigger_summary FROM env_default.ab_flow_runs WHERE flow_id = $1', [id])
    expect((await runs(fr.flow.id)).map((r) => r.trigger_summary)).toEqual([expect.stringMatching(/restored by Ada/)])
    expect(await runs(fd.flow.id)).toHaveLength(1)
    // the outbox: a delete row with the batch, a bulk row 'restore' with the batch
    const ob = await h.q<{ op: string; details: { action?: string; batch?: string } | null }>(`SELECT op, details FROM env_default.ab_outbox WHERE table_id = $1 ORDER BY id`, [T.ev])
    expect(ob.map((o) => [o.op, o.details?.action ?? null, o.details?.batch ?? null])).toEqual([['insert', null, null], ['delete', null, d.batch.id], ['bulk', 'restore', d.batch.id]])
  })

  /* ------------------------------------------------------------------ cascade into a table without a bin, setting off */

  it('a table with the setting off deletes for good as before; a cascade into it is reported on restore', async () => {
    const A = h.admin
    T.plain = (await table('Plain', [{ displayName: 'Name', type: 'text' }], { recycleDays: 0 })).id
    const tp = (await h.q<{ def: { recycleBin?: boolean; recycleDays?: number } }>(`SELECT def FROM env_default.ab_tables WHERE id = $1`, [T.plain]))[0].def
    expect(tp.recycleBin).toBeUndefined()
    const cols = (await h.q<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'env_default' AND table_name = 't_plain'`)).map((r) => r.c)
    expect(cols).not.toContain('deletedOn')
    const x = await insert(A, T.plain, { Name: 'x' })
    const del = ok(await A.post(`/data/${T.plain}/delete`, { ids: [x] })) as { deleted: number }
    expect(del).toEqual({ deleted: 1 })
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.t_plain`))[0].n).toBe(0)
    // a parent with a bin, a child table without: the child rows go for good; restore says so (administrators only)
    T.kid = (await table('Kid', [{ displayName: 'Name', type: 'text' }, { displayName: 'Parent', type: 'lookup', lookupTable: 'Job', required: true }], { recycleDays: 0 })).id
    await relate(T.kid, 'Parent', T.task, 'cascade')
    const p = await insert(A, T.task, { Title: 'parent' })
    await insert(A, T.kid, { Name: 'k1', Parent: p })
    const d = ok(await A.post(`/data/${T.task}/delete`, { ids: [p] })) as { batch: { id: string; finalRows: number } }
    expect(d.batch.finalRows).toBe(1)
    const rep = new Client(h.base)
    ok(await rep.post('/auth/login', { email: 'rep@example.com', password: PW }))
    const r = ok(await A.post(`/data/${T.task}/restore`, { batch: d.batch.id })) as { warnings: string[] }
    expect(r.warnings.join(' ')).toMatch(/1 row\(s\) in Kid were deleted for good/)
    // turning the setting off: future deletes are final, rows already in the bin stay restorable
    const y = await insert(A, T.task, { Title: 'y' })
    const dy = ok(await A.post(`/data/${T.task}/delete`, { ids: [y] })) as { batch: { id: string } }
    const off = ok(await A.patch(`/tables/${T.task}`, { recycleDays: 0 })) as { recycleDays?: number; recycleBin?: boolean }
    expect([off.recycleDays, off.recycleBin]).toEqual([undefined, true])
    const z = await insert(A, T.task, { Title: 'z' })
    expect((ok(await A.post(`/data/${T.task}/delete`, { ids: [z] })) as { batch?: unknown }).batch).toBeUndefined()
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.t_job WHERE id = $1`, [z]))[0].n).toBe(0)
    ok(await A.post(`/data/${T.task}/restore`, { batch: dy.batch.id }))
    ok(await A.patch(`/tables/${T.task}`, { recycleDays: 7 }))
    // external connections and reporting tables cannot have a bin
    expect((await A.patch(`/tables/${T.plain}`, { recycleDays: 5000 })).status).toBe(422)
  })

  it('turning the bin on for an existing table: columns and partial indexes; unique pairs become partial', async () => {
    const A = h.admin
    const t = (await table('Pair', [{ displayName: 'A', type: 'text' }, { displayName: 'B', type: 'text' }, { displayName: 'Code', type: 'text', unique: true }], { recycleDays: 0 }))
    await h.q(`UPDATE env_default.ab_tables SET def = jsonb_set(def, '{uniqueTogether}', '[["A","B"]]'::jsonb) WHERE id = $1`, [t.id])
    await h.q(`CREATE UNIQUE INDEX "uq_t_pair_pair_A_B" ON env_default.t_pair (lower(("A") COLLATE pg_catalog."und-x-icu"), lower(("B") COLLATE pg_catalog."und-x-icu"))`).catch(async () => h.q(`CREATE UNIQUE INDEX "uq_t_pair_pair_A_B" ON env_default.t_pair (lower("A"), lower("B"))`))
    h.app.services.security.invalidate('all')
    const r1 = await insert(A, t.id, { A: 'x', B: 'y', Code: 'K' })
    ok(await A.patch(`/tables/${t.id}`, { recycleDays: 14 }))
    const idx = await h.q<{ indexname: string; indexdef: string }>(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'env_default' AND tablename = 't_pair'`)
    for (const n of ['uq_t_pair_Code', 'uq_t_pair_pair_A_B', 'kx_t_pair_Code', 'ix_t_pair_natural']) expect(idx.find((i) => i.indexname === n)?.indexdef ?? n).toMatch(/WHERE \("deletedOn" IS NULL\)/)
    const d = ok(await A.post(`/data/${t.id}/delete`, { ids: [r1] })) as { batch: { id: string; daysLeft: number } }
    expect(d.batch.daysLeft).toBe(14)
    // the same key and pair again: allowed (the deleted row does not block it)
    await insert(A, t.id, { A: 'X', B: 'Y', Code: 'k' })
    const no = ok(await A.post(`/data/${t.id}/restore`, { batch: d.batch.id }), 409) as { error: { message: string } }
    expect(no.error.message).toMatch(/Code "k" is used by/)
    expect((await h.q<{ state: string }>(`SELECT state FROM env_default.ab_delete_batches WHERE id = $1`, [d.batch.id]))[0].state).toBe('deleted')
  })

  /* ------------------------------------------------------------------ import replace, comments with a bin */

  it('import (replace) puts the replaced rows in the bin as one batch; Comments can keep deleted rows too', async () => {
    const A = h.admin
    const t = (await table('Imp', [{ displayName: 'Code', type: 'text', unique: true }]))
    await insert(A, t.id, { Code: 'A' })
    await insert(A, t.id, { Code: 'B' })
    ok(await A.post(`/data/${t.id}/import`, { csv: 'Code\nA\nC\n', mode: 'replace' }))
    expect((await rows(A, t.id)).map((r) => r.Code).sort()).toEqual(['A', 'C'])
    const del = ok(await A.get(`/data/${t.id}/deleted`)) as { rows: { Code: string; __deleted: { source: string; batchRows: number } }[] }
    expect(del.rows.map((r) => [r.Code, r.__deleted.source, r.__deleted.batchRows]).sort()).toEqual([['A', 'import', 2], ['B', 'import', 2]])
    // Comments (a system table) with a bin: a deleted comment leaves the timeline, its mentions go with it and come back
    const comments = (await h.q<{ id: string }>(`SELECT id FROM env_default.ab_tables WHERE id = 'sys_comments'`))[0].id
    const on = ok(await A.patch(`/tables/${comments}`, { recycleDays: 10 })) as { recycleBin?: boolean }
    expect(on.recycleBin).toBe(true)
    expect((await A.patch(`/tables/${comments}`, { displayName: 'X', recycleDays: 10 })).status).toBe(403)
    expect((await A.patch(`/tables/sys_mentions`, { recycleDays: 10 })).status).toBe(422)
    const c = (ok(await A.post('/data/Comments/rows', { values: { Body: 'temporary', regardingId: ids.c2 } })) as { row: { id: string } }).row.id
    const d = ok(await A.post('/data/Comments/delete', { ids: [c] })) as { batch: { id: string } }
    const tl = ok(await A.get(`/collab/timeline?table=${T.cust}&row=${ids.c2}`)) as { items: { id: string }[] }
    expect(tl.items.some((i) => i.id === c)).toBe(false)
    ok(await A.post('/data/Comments/restore', { batch: d.batch.id }))
    const tl2 = ok(await A.get(`/collab/timeline?table=${T.cust}&row=${ids.c2}`)) as { items: { id: string }[] }
    expect(tl2.items.some((i) => i.id === c)).toBe(true)
  })

  /* ------------------------------------------------------------------ purge */

  it('purge: expired batches go for good with their attachment files; administrators empty a table with a typed confirmation', async () => {
    const A = h.admin
    const d = ok(await A.post(`/data/${T.cust}/delete`, { ids: [ids.c1] })) as { batch: { id: string } }
    await h.q(`UPDATE env_default.ab_delete_batches SET expires_on = now() - interval '1 minute' WHERE id = $1`, [d.batch.id])
    const res = await runInEnvironment('default', () => h.app.services.data.recycle.purgeExpired())
    expect(res).toEqual({ batches: 1, rows: 7 })
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.t_cust WHERE id = $1`, [ids.c1]))[0].n).toBe(0)
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.t_line`))[0].n).toBe(2) // the live lines only
    expect(await h.app.services.meta.attachments.get(ids.file)).toBeNull()
    expect((await h.q<{ state: string }>(`SELECT state FROM env_default.ab_delete_batches WHERE id = $1`, [d.batch.id]))[0].state).toBe('purged')
    expect((ok(await A.post(`/data/${T.cust}/restore`, { batch: d.batch.id }), 409) as { error: { message: string } }).error.message).toMatch(/deleted for good/)
    const audit = await h.q<{ details: { batch: string; reason: string } }>(`SELECT details FROM env_default.ab_audit WHERE action = 'row.purge' ORDER BY id DESC LIMIT 1`)
    expect(audit[0].details).toMatchObject({ batch: d.batch.id, reason: 'expired' })
    // Empty now
    const a = await insert(A, T.cust, { Name: 'Tmp', Code: 'T1' })
    ok(await A.post(`/data/${T.cust}/delete`, { ids: [a] }))
    expect((await A.post(`/data/${T.cust}/purge`, { all: true, confirm: 'nope' })).status).toBe(422)
    expect(ok(await A.post(`/data/${T.cust}/purge`, { all: true, confirm: 'Cust' }))).toEqual({ batches: 1, rows: 1 })
    expect((ok(await A.get(`/data/${T.cust}/deleted`)) as { rows: unknown[] }).rows).toEqual([])
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.ab_audit WHERE action = 'table.recycle.empty'`))[0].n).toBe(1)
  })

  /* ------------------------------------------------------------------ concurrency */

  it('concurrency: overlapping deletes delete each row once; two restores of one batch restore it once', async () => {
    const A = h.admin
    const t = (await table('Conc', [{ displayName: 'N', type: 'number' }]))
    const idsC: string[] = []
    for (let i = 0; i < 20; i++) idsC.push(await insert(A, t.id, { N: i }))
    const rep2 = await member('user_rep2', 'rep2@example.com', [{ table: t.id, create: true, read: 'all', update: 'all', delete: 'all' }])
    const [r1, r2] = await Promise.all([A.post(`/data/${t.id}/delete`, { ids: idsC.slice(0, 15) }), rep2.post(`/data/${t.id}/delete`, { ids: idsC.slice(5, 20) })])
    expect([r1.status, r2.status]).toEqual([200, 200])
    expect(r1.data.deleted + r2.data.deleted).toBe(20)
    const per = await h.q<{ id: string; n: number }>(`SELECT row_id AS id, count(*)::int AS n FROM env_default.ab_delete_effects WHERE table_id = $1 AND kind = 'row' GROUP BY row_id`, [t.id])
    expect(per).toHaveLength(20)
    expect(per.every((p) => p.n === 1)).toBe(true)
    const [x1, x2] = await Promise.all([A.post(`/data/${t.id}/restore`, { batch: r1.data.batch.id }), rep2.post(`/data/${t.id}/restore`, { batch: r1.data.batch.id })])
    expect([x1.status, x2.status].sort()).toEqual([200, 409])
    ok(await rep2.post(`/data/${t.id}/restore`, { batch: r2.data.batch.id }))
    expect(await rows(A, t.id)).toHaveLength(20)
  })

  /* ------------------------------------------------------------------ index use (EXPLAIN) */

  it('EXPLAIN: with a bin the same indexes serve point lookups, unique keys, sorted and natural-order pages', async () => {
    const A = h.admin
    const mk = async (name: string, days: number) => (await table(name, [{ displayName: 'Code', type: 'text', unique: true }, { displayName: 'Name', type: 'text', indexed: true }], { recycleDays: days })).id
    const bin = await mk('BenchBin', 30)
    const plain = await mk('BenchPlain', 0)
    for (const src of ['t_benchbin', 't_benchplain']) {
      await h.q(`INSERT INTO env_default.${src} (id, "createdOn", "modifiedOn", "Code", "Name") SELECT md5(g::text), now() - (g || ' seconds')::interval, now(), 'K-' || g, 'Name ' || (g % 997) FROM generate_series(1, 30000) g`)
      // 10 % of the rows in the bin (the partial indexes no longer hold them)
      if (src === 't_benchbin') await h.q(`UPDATE env_default.t_benchbin SET "deletedOn" = now(), "deleteBatch" = 'del_x' WHERE (abs(hashtext(id)) % 10) = 0`)
      await h.q(`ANALYZE env_default.${src}`)
    }
    void A
    const { buildSelect } = await import('../connectors/postgres/sql.ts')
    const { buildV2 } = await import('../connectors/postgres/query-v2.ts')
    const icu = (await h.q<{ ok: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_collation WHERE collname = 'und-x-icu') AS ok`))[0].ok
    const d = { schema: 'env_default', icu }
    const defOf = async (id: string) => runInEnvironment('default', async () => (await h.app.services.meta.tables.get(id))!)
    const explain = async (sql: string, params: unknown[]) => (await h.q<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params)).map((r) => r['QUERY PLAN']).join('\n')
    const indexOf = (plan: string) => /(?:using|Bitmap Index Scan on) "?(\w+)"?/i.exec(plan)?.[1]?.replace(/^(uq|kx|kd|ix)_t_bench(bin|plain)_/, '$1_').replace(/^t_bench(bin|plain)_pkey$/, 'pkey') ?? 'seq'
    const cases = async (id: string) => {
      const def = await defOf(id)
      const out: string[] = []
      const v1 = buildSelect(d, def, { where: { col: 'Code', op: 'eq', value: 'K-123' } })
      out.push(indexOf(await explain(v1.sql, v1.params)))
      const byId = buildSelect(d, def, { where: { col: 'id', op: 'eq', value: 'abc' } })
      out.push(indexOf(await explain(byId.sql, byId.params)))
      const o = { visible: ['id', 'Code', 'Name'], maxUnpagedRows: 5000, maxGroups: 5000 }
      const sorted = buildV2(d, def, { version: 2, table: def.name, sort: [{ col: 'Name', dir: 'asc' }], page: { size: 50 } } as never, o)
      out.push(indexOf(await explain(sorted.sql, sorted.params)))
      const nat = buildV2(d, def, { version: 2, table: def.name, page: { size: 50 } } as never, o)
      out.push(indexOf(await explain(nat.sql, nat.params)))
      const eq = buildV2(d, def, { version: 2, table: def.name, filter: { col: 'Code', op: 'eq', value: 'K-77' } } as never, o)
      const pe = await explain(eq.sql, eq.params)
      out.push(indexOf(pe))
      // the planner's estimate stays right (expression statistics stand in for the partial index's)
      out.push(Number(/rows=(\d+)/.exec(pe)?.[1] ?? -1) <= 2 ? 'estimate ok' : `estimate ${/rows=(\d+)/.exec(pe)?.[1]}`)
      return out
    }
    const withBin = await cases(bin)
    const without = await cases(plain)
    expect(withBin).toEqual(without)
    expect(withBin[0]).toBe('uq_Code')
    expect(withBin[1]).toMatch(/pkey/)
    expect(withBin[2]).toBe('kx_Name')
    expect(withBin[3]).toBe('ix_natural')
    expect(withBin[5]).toBe('estimate ok')
  })

  /* ------------------------------------------------------------------ upgrade from schema 9 */

  it('schema 9 -> 10: the batch tables appear, existing tables keep final deletes (nothing changes for them)', async () => {
    const A = h.admin
    const old = (await table('Legacy', [{ displayName: 'Name', type: 'text' }]))
    // a table as version 9 left it: no setting, no columns
    await h.q(`ALTER TABLE env_default.t_legacy DROP COLUMN "deletedOn", DROP COLUMN "deletedBy", DROP COLUMN "deleteBatch"`)
    await h.q(`UPDATE env_default.ab_tables SET def = def - 'recycleDays' - 'recycleBin' WHERE id = $1`, [old.id])
    await h.q(`DROP TABLE env_default.ab_delete_effects, env_default.ab_delete_batches`)
    await h.q(`UPDATE ab.environments SET schema_version = 9 WHERE id = 'default'`)
    const { migrateEnvironmentSchema, SCHEMA_VERSION } = await import('./meta-store.ts')
    expect(SCHEMA_VERSION).toBe(10)
    expect(await migrateEnvironmentSchema(h.app.services.state.db!, { id: 'default', schema: 'env_default' })).toEqual({ from: 9, to: 10 })
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'env_default' AND table_name IN ('ab_delete_batches', 'ab_delete_effects')`))[0].n).toBe(2)
    const def = (await h.q<{ def: Record<string, unknown> }>(`SELECT def FROM env_default.ab_tables WHERE id = $1`, [old.id]))[0].def
    expect([def.recycleDays, def.recycleBin]).toEqual([undefined, undefined])
    h.app.services.security.invalidate('all')
    const r = await insert(A, old.id, { Name: 'keep?' })
    expect(ok(await A.post(`/data/${old.id}/delete`, { ids: [r] }))).toEqual({ deleted: 1 })
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.t_legacy`))[0].n).toBe(0)
    expect((ok(await A.get(`/data/${old.id}/recycle`)) as { enabled: boolean }).enabled).toBe(false)
  })
})
