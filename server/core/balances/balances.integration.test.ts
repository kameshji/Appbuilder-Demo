/**
 * Synchronous balances (docs/dev/balances.md) against the sandbox PostgreSQL (APPBUILDER_TEST_DB): the balance follows
 * every movement in the same transaction (insert, update, delete, recycle bin delete and restore, CSV import), is
 * refused below its floor with a plain message, never goes below zero under 20 parallel issues of the last 10 units, a
 * failed unit leaves it unchanged, users cannot write it, it is read through Query v2 with row and column security, and
 * after a randomised sequence it equals the sum of the live movements.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { Client, startHarness } from '../kernel-testkit.ts'
import type { KernelHarness } from '../kernel-testkit.ts'
import { setQuiet } from '../util.ts'
import { runInEnvironment } from '../env-context.ts'
import { hashPassword } from '../password.ts'
import type { UserRecord } from '../contracts.ts'
import { createBalances } from './engine.ts'
import { planBody } from '../testquery.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[balances] ${SKIP_PG}\n`)

const PW = 'member-password-1'

describe.skipIf(!PG_URL)(PG_URL ? 'synchronous balances (PostgreSQL)' : `synchronous balances (PostgreSQL) ${SKIP_PG}`, { timeout: 180_000 }, () => {
  let h: KernelHarness
  const T: Record<string, string> = {}
  const id: Record<string, string> = {}
  const ok = <D>(r: { status: number; data: D }, status = 200): D => {
    expect(r.status, JSON.stringify(r.data).slice(0, 1500)).toBe(status)
    return r.data
  }
  const table = async (displayName: string, columns: unknown[]) => ok(await h.admin.post('/tables', { displayName, columns })) as { id: string; name: string }
  const insert = async (cl: Client, t: string, values: Record<string, unknown>) => (ok(await cl.post(`/data/${t}/rows`, { values })) as { row: { id: string } }).row.id
  const move = (cl: Client, item: string, loc: string, qty: number, kind = 'Issue') => cl.post(`/data/${T.mv}/rows`, { values: { Item: id[item], Location: id[loc], Quantity: qty, Kind: kind } })
  /** the balance of a key straight from SQL (null: no balance row) */
  const bal = async (item: string, loc: string): Promise<number | null> => {
    const r = await h.q<{ q: string | null }>(`SELECT "OnHand"::text AS q FROM env_default.t_stockbalances WHERE "Item" = $1 AND "Location" = $2`, [id[item], id[loc]])
    return r.length ? Number(r[0].q) : null
  }
  /** the sum of the live movements of a key */
  const sum = async (item: string, loc: string): Promise<number> => Number((await h.q<{ s: string }>(`SELECT COALESCE(sum("Quantity"), 0)::text AS s FROM env_default.t_stockmovements WHERE "Item" = $1 AND "Location" = $2 AND "deletedOn" IS NULL`, [id[item], id[loc]]))[0].s)
  const member = async (uid: string, email: string, privileges: unknown[]): Promise<Client> => {
    const role = ok(await h.admin.post('/roles', { name: `Role ${uid}`, apps: 'all', privileges })) as { id: string }
    await runInEnvironment('default', () => h.app.services.meta.users.insert({ id: uid, name: `User ${uid}`, email, roleIds: [role.id], status: 'active', passwordHash: '' } as UserRecord))
    await h.q(`UPDATE ab.users SET password_hash = $1 WHERE id = $2`, [await hashPassword(PW), uid])
    h.app.services.security.invalidate('all')
    const c = new Client(h.base)
    ok(await c.post('/auth/login', { email, password: PW }))
    return c
  }

  beforeAll(async () => {
    h = await startHarness('balances', { env: { APPBUILDER_MIGRATION_BACKUP: 'skip' } })
    T.item = (await table('Items', [{ displayName: 'Name', type: 'text', required: true }])).id
    T.loc = (await table('Locations', [{ displayName: 'Name', type: 'text', required: true }])).id
    T.mv = (await table('StockMovements', [
      { displayName: 'Item', type: 'lookup', lookupTable: 'Items', required: true },
      { displayName: 'Location', type: 'lookup', lookupTable: 'Locations', required: true },
      { displayName: 'Quantity', type: 'decimal', required: true },
      { displayName: 'Kind', type: 'text' },
    ])).id
    T.bal = (await table('StockBalances', [
      { displayName: 'Item', type: 'lookup', lookupTable: 'Items' },
      { displayName: 'Location', type: 'lookup', lookupTable: 'Locations' },
      { displayName: 'OnHand', type: 'decimal' },
      { displayName: 'MinQty', type: 'decimal' },
      { displayName: 'Note', type: 'text' },
    ])).id
    // the declaration (packs carry it in the slot's create.balance; here straight into the table definition)
    await h.q(`UPDATE env_default.ab_tables SET def = jsonb_set(def, '{balance}', $2::jsonb) WHERE id = $1`, [T.bal, JSON.stringify({ movements: 'StockMovements', quantity: 'Quantity', column: 'OnHand', keys: [{ column: 'Item', from: 'Item' }, { column: 'Location', from: 'Location' }], minColumn: 'MinQty', label: 'Stock' })])
    for (const n of ['Bolt', 'Nut', 'Washer']) id[n] = await insert(h.admin, T.item, { Name: n })
    for (const n of ['Main store', 'Line side']) id[n] = await insert(h.admin, T.loc, { Name: n })
  }, 180_000)

  afterAll(async () => {
    await h?.close()
  }, 60_000)

  it('a receipt creates the balance row in the same transaction; an issue beyond it is refused in plain words', async () => {
    ok(await move(h.admin, 'Bolt', 'Main store', 10, 'Receipt'))
    expect(await bal('Bolt', 'Main store')).toBe(10)
    ok(await move(h.admin, 'Bolt', 'Main store', -7))
    expect(await bal('Bolt', 'Main store')).toBe(3)
    const r = ok(await move(h.admin, 'Bolt', 'Main store', -5), 422) as { error: { message: string; field: string } }
    expect(r.error.message).toBe('Stock of Bolt at Main store would go below zero: available 3, requested 5.')
    expect(r.error.field).toBe('Quantity')
    expect(await bal('Bolt', 'Main store')).toBe(3)
    expect(await sum('Bolt', 'Main store')).toBe(3)
    // an issue from a key with no stock at all
    const none = ok(await move(h.admin, 'Nut', 'Line side', -1), 422) as { error: { message: string } }
    expect(none.error.message).toBe('Stock of Nut at Line side would go below zero: available 0, requested 1.')
    expect(await bal('Nut', 'Line side')).toBeNull()
  })

  it('20 parallel issues of the last 10 units: exactly 10 succeed and the balance never goes below zero', async () => {
    ok(await move(h.admin, 'Washer', 'Main store', 10, 'Receipt'))
    const results = await Promise.all(Array.from({ length: 20 }, () => move(h.admin, 'Washer', 'Main store', -1)))
    const statuses = results.map((r) => r.status).sort()
    expect(statuses.filter((s) => s === 200)).toHaveLength(10)
    expect(statuses.filter((s) => s === 422)).toHaveLength(10)
    for (const r of results.filter((x) => x.status === 422)) expect((r.data as { error: { message: string } }).error.message).toMatch(/^Stock of Washer at Main store would go below zero: available 0, requested 1\.$/)
    expect(await bal('Washer', 'Main store')).toBe(0)
    expect(await sum('Washer', 'Main store')).toBe(0)
    const issued = await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.t_stockmovements WHERE "Item" = $1 AND "Quantity" < 0`, [id.Washer])
    expect(issued[0].n).toBe(10)
  })

  it('updates and deletes of movements move the balance; a transfer between keys; delete and restore from the recycle bin', async () => {
    ok(await move(h.admin, 'Nut', 'Main store', 20, 'Receipt'))
    const issue = (ok(await move(h.admin, 'Nut', 'Main store', -5)) as { row: { id: string } }).row.id
    expect(await bal('Nut', 'Main store')).toBe(15)
    // a bigger issue: the difference is checked
    ok(await h.admin.patch(`/data/${T.mv}/rows/${issue}`, { changes: { Quantity: -12 } }))
    expect(await bal('Nut', 'Main store')).toBe(8)
    const tooBig = ok(await h.admin.patch(`/data/${T.mv}/rows/${issue}`, { changes: { Quantity: -30 } }), 422) as { error: { message: string } }
    expect(tooBig.error.message).toBe('Stock of Nut at Main store would go below zero: available 8, requested 18.')
    expect(await bal('Nut', 'Main store')).toBe(8)
    // moving the receipt to another location: the old key loses it (refused: the issue would leave it negative)
    const receipt = (await h.q<{ id: string }>(`SELECT id FROM env_default.t_stockmovements WHERE "Item" = $1 AND "Quantity" = 20`, [id.Nut]))[0].id
    ok(await h.admin.patch(`/data/${T.mv}/rows/${receipt}`, { changes: { Location: id['Line side'] } }), 422)
    // a transfer: an issue here and a receipt there, in one import (one transaction)
    ok(await h.admin.post(`/data/${T.mv}/import`, { mode: 'append', csv: `Item,Location,Quantity,Kind\r\n${id.Nut},${id['Main store']},-3,Transfer\r\n${id.Nut},${id['Line side']},3,Transfer\r\n` }))
    expect([await bal('Nut', 'Main store'), await bal('Nut', 'Line side')]).toEqual([5, 3])
    // delete the issue (recycle bin): the 12 come back; restore: they go again
    const del = ok(await h.admin.post(`/data/${T.mv}/delete`, { ids: [issue] })) as { batch: { id: string } }
    expect(await bal('Nut', 'Main store')).toBe(17)
    ok(await h.admin.post(`/data/${T.mv}/restore`, { batch: del.batch.id }))
    expect(await bal('Nut', 'Main store')).toBe(5)
    // a restore that would overdraw is refused and changes nothing
    const del2 = ok(await h.admin.post(`/data/${T.mv}/delete`, { ids: [issue] })) as { batch: { id: string } }
    expect(await bal('Nut', 'Main store')).toBe(17)
    ok(await move(h.admin, 'Nut', 'Main store', -10))
    const refused = ok(await h.admin.post(`/data/${T.mv}/restore`, { batch: del2.batch.id }), 422) as { error: { message: string } }
    expect(refused.error.message).toBe('Stock of Nut at Main store would go below zero: available 7, requested 12.')
    expect(await bal('Nut', 'Main store')).toBe(7)
    const live = await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.t_stockmovements WHERE id = $1 AND "deletedOn" IS NULL`, [issue])
    expect(live[0].n).toBe(0)
    // a delete of a receipt that the issues already used is refused
    const r2 = (ok(await move(h.admin, 'Nut', 'Line side', 4, 'Receipt')) as { row: { id: string } }).row.id
    ok(await move(h.admin, 'Nut', 'Line side', -6))
    expect(await bal('Nut', 'Line side')).toBe(1)
    const cannot = ok(await h.admin.post(`/data/${T.mv}/delete`, { ids: [r2] }), 422) as { error: { message: string } }
    expect(cannot.error.message).toBe('Stock of Nut at Line side would go below zero: available 1, requested 4.')
    // a bulk delete of several movements at once
    const a = (ok(await move(h.admin, 'Bolt', 'Line side', 6, 'Receipt')) as { row: { id: string } }).row.id
    const b = (ok(await move(h.admin, 'Bolt', 'Line side', -2)) as { row: { id: string } }).row.id
    ok(await h.admin.post(`/data/${T.mv}/delete`, { ids: [a, b] }))
    expect(await bal('Bolt', 'Line side')).toBe(0)
    for (const [i, l] of [['Nut', 'Main store'], ['Nut', 'Line side'], ['Bolt', 'Line side']]) expect(await bal(i, l)).toBe(await sum(i, l))
  })

  it('a failed unit of work leaves the balance unchanged (an import refused on its last key moves nothing)', async () => {
    const before = [await bal('Bolt', 'Main store'), await bal('Washer', 'Line side')]
    const count = (await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.t_stockmovements`))[0].n
    const r = ok(await h.admin.post(`/data/${T.mv}/import`, { mode: 'append', csv: `Item,Location,Quantity\r\n${id.Bolt},${id['Main store']},50\r\n${id.Washer},${id['Line side']},-1\r\n` }), 422) as { error: { message: string } }
    expect(r.error.message).toMatch(/^Stock of Washer at Line side would go below zero/)
    expect([await bal('Bolt', 'Main store'), await bal('Washer', 'Line side')]).toEqual(before)
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.t_stockmovements`))[0].n).toBe(count)
  })

  it('a per-key minimum; the balance rows are kept by the platform (users cannot add, change or delete them)', async () => {
    const row = (await h.q<{ id: string }>(`SELECT id FROM env_default.t_stockbalances WHERE "Item" = $1 AND "Location" = $2`, [id.Bolt, id['Main store']]))[0].id
    ok(await h.admin.patch(`/data/${T.bal}/rows/${row}`, { changes: { MinQty: 2, OnHand: 999, Note: 'safety stock' } }))
    expect(await bal('Bolt', 'Main store')).toBe(3)
    const r = ok(await move(h.admin, 'Bolt', 'Main store', -2), 422) as { error: { message: string } }
    expect(r.error.message).toBe('Stock of Bolt at Main store would go below 2: available 3, requested 2.')
    ok(await move(h.admin, 'Bolt', 'Main store', -1))
    ok(await h.admin.post(`/data/${T.bal}/rows`, { values: { Item: id.Bolt, Location: id['Line side'], OnHand: 5 } }), 403)
    ok(await h.admin.post(`/data/${T.bal}/delete`, { ids: [row] }), 403)
    ok(await h.admin.post(`/data/${T.bal}/import`, { mode: 'append', csv: 'OnHand\r\n4\r\n' }), 403)
  })

  it('the balance is read through Query v2 as the viewer, with row and column security', async () => {
    const viewer = await member('user_bal_viewer', 'bal-viewer@example.com', [
      { table: T.bal, create: false, read: 'all', update: 'none', delete: 'none', columns: { MinQty: 'none' }, rowFilter: [{ column: 'Location', op: 'eq', value: id['Main store'] }] },
    ])
    const res = ok(await viewer.post('/query', planBody('StockBalances', { select: ['Item', 'OnHand'] }))) as { rows: { Item: string; OnHand: number }[] }
    expect(res.rows.length).toBeGreaterThan(0)
    const mains = (await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.t_stockbalances WHERE "Location" = $1`, [id['Main store']]))[0].n
    expect(res.rows).toHaveLength(mains)
    ok(await viewer.post('/query', planBody('StockBalances', { select: ['MinQty'] })), 403)
    // a movement writer without read on the balance still gets the plain refusal (it names the available quantity)
    const clerk = await member('user_bal_clerk', 'bal-clerk@example.com', [
      { table: T.mv, create: true, read: 'own', update: 'own', delete: 'none' }, { table: T.item, create: false, read: 'all', update: 'none', delete: 'none' }, { table: T.loc, create: false, read: 'all', update: 'none', delete: 'none' },
    ])
    const r = ok(await move(clerk, 'Washer', 'Main store', -1), 422) as { error: { message: string } }
    expect(r.error.message).toBe('Stock of Washer at Main store would go below zero: available 0, requested 1.')
  })

  it('after a randomised sequence of movements every balance equals the sum of its live movements and none is negative', async () => {
    let seed = 7
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
    const items = ['Bolt', 'Nut', 'Washer']
    const locs = ['Main store', 'Line side']
    const mine: string[] = []
    const batches: string[] = []
    for (let i = 0; i < 150; i++) {
      const op = rnd(10)
      const it0 = items[rnd(3)], lo = locs[rnd(2)]
      if (op < 4 || !mine.length) {
        const r = await move(h.admin, it0, lo, rnd(8) + 1, 'Receipt')
        if (r.status === 200) mine.push((r.data as { row: { id: string } }).row.id)
      } else if (op < 7) {
        const r = await move(h.admin, it0, lo, -(rnd(6) + 1))
        expect([200, 422]).toContain(r.status)
        if (r.status === 200) mine.push((r.data as { row: { id: string } }).row.id)
      } else if (op < 8) {
        const target = mine[rnd(mine.length)]
        const r = await h.admin.patch(`/data/${T.mv}/rows/${target}`, { changes: { Quantity: rnd(2) ? rnd(5) + 1 : -(rnd(3) + 1), Location: id[locs[rnd(2)]] } })
        expect([200, 404, 422]).toContain(r.status)
      } else if (op < 9) {
        const target = mine.splice(rnd(mine.length), 1)[0]
        const r = await h.admin.post(`/data/${T.mv}/delete`, { ids: [target] })
        expect([200, 404, 422]).toContain(r.status)
        if (r.status === 200) batches.push((r.data as { batch: { id: string } }).batch.id)
        else mine.push(target)
      } else if (batches.length) {
        const r = await h.admin.post(`/data/${T.mv}/restore`, { batch: batches.splice(rnd(batches.length), 1)[0] })
        expect([200, 409, 422]).toContain(r.status)
      }
    }
    const neg = await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_default.t_stockbalances WHERE "OnHand" < 0`)
    expect(neg[0].n).toBe(0)
    for (const i of items) for (const l of locs) expect(await bal(i, l) ?? 0).toBe(await sum(i, l))
    // the reconcile finds nothing to repair; after a write outside the platform it repairs it
    const eng = createBalances({ db: () => h.app.services.state.db })
    const bdef = (await runInEnvironment('default', () => h.app.services.meta.tables.get(T.bal)))!
    expect(await runInEnvironment('default', () => eng.reconcile(bdef))).toBe(0)
    await h.q(`UPDATE env_default.t_stockbalances SET "OnHand" = "OnHand" + 1000 WHERE "Item" = $1 AND "Location" = $2`, [id.Bolt, id['Main store']])
    await h.q(`DELETE FROM env_default.t_stockbalances WHERE "Item" = $1 AND "Location" = $2`, [id.Nut, id['Line side']])
    expect(await runInEnvironment('default', () => eng.reconcile(bdef))).toBeGreaterThanOrEqual(1)
    for (const i of items) for (const l of locs) expect(await bal(i, l) ?? 0).toBe(await sum(i, l))
  })
})
