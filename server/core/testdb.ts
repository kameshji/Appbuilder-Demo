/**
 * Test helpers for the integration suites (not used at run time).
 *
 *   APPBUILDER_TEST_DB=postgres://abdev:abdev-sandbox-only@127.0.0.1:5433/appbuilder_test     (system store, default connector)
 *   APPBUILDER_TEST_MYSQL=mysql://abdev:abdev-sandbox-only@127.0.0.1:3306/appbuilder_test     (MySQL connector only)
 *
 * The PostgreSQL account needs CREATEDB (each suite creates and drops its own database appbuilder_test_<suite>_<hex>)
 * and must be able to connect to the database named in the URL, which is used as the maintenance database.
 */
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

/** drops a test database even while pooled connections are still open (WITH FORCE, PostgreSQL 13+) */
export async function dropDatabase(name: string): Promise<void> {
  if (!pgServer) return
  await withPg((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`))
}

/** one query against a test database, e.g. to inspect "env_default"."ab_audit" */
export async function pgQuery<T = Record<string, unknown>>(database: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return withPg(async (c) => (await c.query(sql, params)).rows as T[], database)
}
