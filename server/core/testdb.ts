/**
 * Test helpers for the integration suites (not used at run time).
 *
 *   APPBUILDER_TEST_DB=postgres://abdev:abdev-sandbox-only@127.0.0.1:5433/appbuilder_test     (system store, default connector)
 *   APPBUILDER_TEST_MYSQL=mysql://abdev:abdev-sandbox-only@127.0.0.1:3306/appbuilder_test     (MySQL connector only)
 *
 * The PostgreSQL account needs CREATEDB (each suite creates and drops its own database appbuilder_test_<suite>_<hex>)
 * and must be able to connect to the database named in the URL, which is used as the maintenance database.
 */
import fs from 'node:fs'
import pg from 'pg'
import { randomBytes } from 'node:crypto'
import { poolConfig } from '../connectors/postgres/db.ts'

export const PG_URL = process.env.APPBUILDER_TEST_DB || ''
export const MYSQL_URL = process.env.APPBUILDER_TEST_MYSQL || ''

if (PG_URL && !/^postgres(ql)?:\/\//i.test(PG_URL)) {
  throw new Error('APPBUILDER_TEST_DB must be a postgres:// URL (the MySQL connector tests use APPBUILDER_TEST_MYSQL).')
}

export interface PgTestServer { host: string; port: number; user: string; password: string; database: string }

export const pgServer: PgTestServer | null = PG_URL
  ? (() => {
      const u = new URL(PG_URL)
      return { host: u.hostname, port: Number(u.port) || 5432, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1) || 'postgres' }
    })()
  : null

export const SKIP_PG = 'skipped: set APPBUILDER_TEST_DB=postgres://user:pass@host:port/appbuilder_test to run the PostgreSQL integration tests'

/** a fresh database name for one suite (lowercase: PostgreSQL folds unquoted names) */
export const testDatabaseName = (suite: string): string => `appbuilder_test_${suite}_${randomBytes(4).toString('hex')}`

/** runs fn on one connection to a database of the test server (default: the maintenance database from the URL) */
export async function withPg<T>(fn: (c: pg.Client) => Promise<T>, database?: string): Promise<T> {
  if (!pgServer) throw new Error(SKIP_PG)
  const c = new pg.Client(poolConfig({ ...pgServer, ssl: false }, pgServer.password, { database: database ?? pgServer.database }))
  c.on('error', () => {})
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end().catch(() => {})
  }
}

export async function createDatabase(name: string): Promise<void> {
  await withPg((c) => c.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0`))
}

/** how long a suite's close waits for its database to be dropped (APPBUILDER_TEST_DROP_WAIT_MS) */
const DROP_WAIT_MS = Number(process.env.APPBUILDER_TEST_DROP_WAIT_MS) || 15_000

/**
 * drops a test database even while pooled connections are still open (WITH FORCE, PostgreSQL 13+).
 *
 * The flaky 60 s afterAll hangs: DROP DATABASE forces a checkpoint and waits for locks on the database; with many suites
 * writing in parallel one DROP took 10 to 22 s on the sandbox server (measured, .sandbox/B2/close-trace-*.txt) and more
 * under a full run, so the suite's afterAll ran out of time although every test had passed. The drop now runs on a
 * connection that does not keep the process alive and is awaited for `waitMs` at most; a slower drop finishes on the
 * server by itself (PostgreSQL completes a DROP whose client went away), and the suite closes.
 */
export async function dropDatabase(name: string, o: { waitMs?: number } = {}): Promise<void> {
  if (!pgServer) return
  const waitMs = o.waitMs ?? DROP_WAIT_MS
  const trace = process.env.APPBUILDER_TEST_CLOSE_TRACE
  const note = (s: string) => { if (trace) fs.appendFileSync(trace, `  drop ${name} ${s}\n`) }
  const work = dropWithRetries(name, note)
  let timer: NodeJS.Timeout | null = null
  const late = new Promise<'late'>((r) => { timer = setTimeout(() => r('late'), waitMs); timer.unref() })
  const out = await Promise.race([work.then(() => 'done' as const), late])
  if (timer) clearTimeout(timer)
  if (out === 'late') {
    note(`still running after ${waitMs}ms: left to finish in the background`)
    work.catch((e) => console.warn(`test database ${name}: ${String(e)}`))
  }
}

async function dropWithRetries(name: string, note: (s: string) => void): Promise<void> {
  // A non-superuser role (as in CI) may not terminate a backend it does not own, e.g. an autovacuum worker that is
  // busy in the database at that moment ("permission denied to terminate process"). Retry briefly; a leftover test
  // database must not fail a suite whose tests all passed.
  for (let attempt = 0; attempt < 5; attempt++) {
    const t0 = Date.now()
    try {
      await withPg(async (c) => {
        // the socket must not keep a finished test process alive while the server works on the drop
        ;(c as unknown as { connection?: { stream?: { unref?(): void } } }).connection?.stream?.unref?.()
        await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      })
      note(`attempt ${attempt} ok ${Date.now() - t0}ms`)
      return
    } catch (err) {
      const code = (err as { code?: string }).code
      note(`attempt ${attempt} ${code} ${(err as Error).message} ${Date.now() - t0}ms`)
      if (code !== '42501' && code !== '55006') throw err
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)).unref())
    }
  }
  console.warn(`test database ${name} could not be dropped (still in use by a backend this role may not terminate)`)
}

/** one query against a test database, e.g. to inspect "env_default"."ab_audit" */
export async function pgQuery<T = Record<string, unknown>>(database: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return withPg(async (c) => (await c.query(sql, params)).rows as T[], database)
}
