/**
 * The transaction wrapper under concurrency (db.ts): Promise.all branches inside one unit of work, sibling savepoints,
 * statements that outlive their transaction. APPBUILDER_TEST_DB=postgres://... npx vitest run server/connectors/postgres/tx
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, createDatabase, dropDatabase, pgServer, testDatabaseName } from '../../core/testdb.ts'
import { TransactionEndedError, createPgDb } from './db.ts'
import type { PgDb } from './db.ts'

describe.skipIf(!PG_URL)('transactions under concurrency (PostgreSQL)', () => {
  const name = testDatabaseName('tx_conc')
  let db: PgDb
  const warnings: string[] = []
  const onWarning = (w: Error) => warnings.push(w.message)

  beforeAll(async () => {
    await createDatabase(name)
    db = createPgDb({ ...pgServer!, database: name, ssl: false }, pgServer!.password, { max: 3 })
    await db.exec('CREATE TABLE public.t (id int PRIMARY KEY, v text)')
    process.on('warning', onWarning)
  }, 30000)
  afterAll(async () => {
    process.off('warning', onWarning)
    await db?.close()
    await dropDatabase(name)
  }, 30000)

  it('Promise.all of statements and sibling savepoints in one transaction: no overlap, a failing sibling undoes only itself', async () => {
    await db.tx(async () => {
      await Promise.all([
        ...Array.from({ length: 20 }, (_, i) => db.exec('INSERT INTO public.t (id, v) VALUES ($1, $2)', [i, 'plain'])),
        db.tx(async (t) => { await t.exec('INSERT INTO public.t (id, v) VALUES (100, $1)', ['sp ok']) }),
        db.tx(async (t) => {
          await t.exec('INSERT INTO public.t (id, v) VALUES (101, $1)', ['sp bad'])
          throw new Error('undo me')
        }).catch(() => 'caught'),
        ...Array.from({ length: 20 }, (_, i) => db.query('SELECT count(*)::int AS n FROM public.t WHERE id = $1', [i])),
        // a failing ambient statement is harmless (its own savepoint)
        db.exec('INSERT INTO public.t (id, v) VALUES (0, $1)', ['duplicate']).catch(() => 'dup'),
      ])
    })
    const rows = await db.query<{ id: number; v: string }>('SELECT id, v FROM public.t ORDER BY id')
    expect(rows.length).toBe(21)
    expect(rows.find((r) => r.id === 100)?.v).toBe('sp ok')
    expect(rows.some((r) => r.id === 101)).toBe(false)
    expect(warnings.filter((w) => /already executing/.test(w))).toEqual([])
  }, 30000)

  it('a statement that outlives its transaction is refused and never reaches the (re-used) connection', async () => {
    let late: Promise<unknown> | null = null
    let lateError: unknown = null
    await expect(db.tx(async () => {
      await db.exec('INSERT INTO public.t (id, v) VALUES (200, $1)', ['x'])
      setTimeout(() => { late = db.exec('INSERT INTO public.t (id, v) VALUES (201, $1)', ['late']).catch((e) => { lateError = e }) }, 0)
      throw new Error('fail the unit')
    })).rejects.toThrow('fail the unit')
    await new Promise((r) => setTimeout(r, 20))
    await late
    expect(lateError).toBeInstanceOf(TransactionEndedError)
    // stragglers that were queued before the end still finish inside it (then everything rolls back)
    await expect(db.tx(async () => {
      void db.exec('INSERT INTO public.t (id, v) VALUES (202, $1)', ['straggler'])
      throw new Error('end now')
    })).rejects.toThrow('end now')
    // the pool's connections are healthy: many transactions in parallel
    await Promise.all(Array.from({ length: 12 }, (_, i) => db.tx(async (t) => { await t.exec('INSERT INTO public.t (id, v) VALUES ($1, $2)', [300 + i, 'p']) })))
    const ids = (await db.query<{ id: number }>('SELECT id FROM public.t WHERE id >= 200 ORDER BY id')).map((r) => r.id)
    expect(ids).toEqual(Array.from({ length: 12 }, (_, i) => 300 + i))
    expect(warnings.filter((w) => /already executing/.test(w))).toEqual([])
  }, 30000)
})
