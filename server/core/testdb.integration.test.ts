/**
 * The test kit's close path (flaky 60 s afterAll hangs): DROP DATABASE waits for a checkpoint and for locks on the
 * database, which under a full parallel run can take longer than a suite's afterAll limit. dropDatabase waits a bounded
 * time and lets a slow drop finish in the background (it never keeps the process alive). Here the drop is held by a lock
 * on purpose: a transaction that commented on the database holds a lock DROP DATABASE must wait for.
 */
import { describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG, createDatabase, dropDatabase, testDatabaseName, withPg } from './testdb.ts'

describe.skipIf(!PG_URL)(PG_URL ? 'test kit: dropping a test database (PostgreSQL)' : `test kit drop ${SKIP_PG}`, () => {
  it('returns within its bound while the drop is blocked, and the drop completes once it is free', async () => {
    const name = testDatabaseName('dropbound')
    await createDatabase(name)
    let release: () => void = () => {}
    const held = new Promise<void>((r) => { release = r })
    let locked: () => void = () => {}
    const isLocked = new Promise<void>((r) => { locked = r })
    const holder = withPg(async (c) => {
      await c.query('BEGIN')
      await c.query(`COMMENT ON DATABASE "${name}" IS 'held by a test'`)
      locked()
      await held
      await c.query('COMMIT')
    })
    await isLocked
    const t0 = Date.now()
    await dropDatabase(name, { waitMs: 2000 })
    const took = Date.now() - t0
    expect(took).toBeLessThan(8000)
    expect(took).toBeGreaterThanOrEqual(1900)
    const exists = async () => (await withPg((c) => c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]))).rowCount
    expect(await exists()).toBe(1)
    release()
    await holder
    for (let i = 0; i < 40 && (await exists()); i++) await new Promise((r) => setTimeout(r, 250))
    expect(await exists()).toBe(0)
  }, 30_000)

  it('a quick drop is simply awaited', async () => {
    const name = testDatabaseName('dropquick')
    await createDatabase(name)
    await dropDatabase(name)
    expect((await withPg((c) => c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]))).rowCount).toBe(0)
  }, 30_000)
})
