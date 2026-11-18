/**
 * SqlDb over a node-postgres (`pg`) pool: the system store and the `postgres` connector both use it.
 *
 * - Placeholders are PostgreSQL's own (`$1`, `$2`, ...). Identifiers are always quoted and schema-qualified by the
 *   callers (meta-store.ts, sql.ts), so nothing depends on search_path.
 * - Every pooled connection starts with `search_path=pg_catalog,pg_temp` and `TimeZone=UTC` (startup options, never SET):
 *   an unqualified table name fails loudly instead of resolving to some schema, objects in `public` cannot shadow
 *   built-in functions, and no request can change what another request on the same pooled connection sees.
 * - Type parsers (per pool, never global): int8 -> number (string above 2^53), numeric -> string, date -> 'YYYY-MM-DD'
 *   text (no local-time shift), timestamp without time zone -> Date read as UTC, timestamptz -> Date, json/jsonb -> parsed.
 * - Transactions: `tx(fn)` runs fn on one client inside BEGIN/COMMIT (ROLLBACK when fn throws). While it runs, the
 *   pool-level SqlDb *joins* it for code in the same async context (AsyncLocalStorage): the MetaStore and the
 *   default connector can be called by code that does not know it runs in a unit of work (solution import, schema
 *   changes) and still land in the one transaction. Such ambient statements are each wrapped in a SAVEPOINT, so a failed
 *   statement that the caller catches does not abort the transaction (PostgreSQL would otherwise refuse every later
 *   statement). A nested tx() is a SAVEPOINT. Statements of one transaction are serialised on its client.
 */
import pg from 'pg'
import type { Pool, PoolClient, PoolConfig } from 'pg'
import { AsyncLocalStorage } from 'node:async_hooks'
import { HttpError } from '../../core/contracts.ts'
import type { DatabaseSettings, SqlDb, SqlResult } from '../../core/contracts.ts'

/** startup options of every connection (see the header) */
export const SESSION_OPTIONS = '-c search_path=pg_catalog,pg_temp -c TimeZone=UTC'

const OID = { int8: 20, date: 1082, timestamp: 1114, numeric: 1700 } as const

/** per-pool type parsers (pg.types is global; never change it) */
export const TYPE_PARSERS: NonNullable<PoolConfig['types']> = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (format === 'binary') return pg.types.getTypeParser(oid, 'binary')
    switch (oid) {
      case OID.int8: return (v: string) => { const n = Number(v); return Number.isSafeInteger(n) ? n : v }
      case OID.numeric: return (v: string) => v
      case OID.date: return (v: string) => v
      case OID.timestamp: return (v: string) => {
        const d = new Date(v.replace(' ', 'T') + 'Z')
        return Number.isNaN(d.getTime()) ? v : d
      }
      default: return pg.types.getTypeParser(oid, 'text')
    }
  }) as NonNullable<PoolConfig['types']>['getTypeParser'],
}

export function poolConfig(s: DatabaseSettings, password: string, o: { database?: string; max?: number; connectTimeoutMs?: number } = {}): PoolConfig {
  return {
    host: s.host,
    port: s.port,
    user: s.user,
    password,
    database: o.database ?? s.database,
    ssl: s.ssl ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : false,
    max: o.max ?? 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: o.connectTimeoutMs ?? 10000,
    application_name: 'appbuilder',
    options: SESSION_OPTIONS,
    types: TYPE_PARSERS,
    keepAlive: true,
  }
}

/** "PostgreSQL 16.4" from `SHOW server_version` ("16.4 (Ubuntu 16.4-1)") */
export function formatServerVersion(v: string): string {
  const m = /^(\d+(?:\.\d+)*)/.exec(v.trim())
  return `PostgreSQL ${m ? m[1] : v.trim()}`
}

/** a PostgreSQL error reported by the server (SQLSTATE in `code`) */
export interface PgError { code?: string; message?: string; severity?: string; detail?: string; constraint?: string; table?: string; column?: string }

export function isPgError(e: unknown): e is PgError {
  return e instanceof pg.DatabaseError || (!!e && typeof e === 'object' && typeof (e as PgError).severity === 'string' && /^[0-9A-Z]{5}$/.test(String((e as PgError).code)))
}

/* ------------------------------------------------------------------ transactions */

/** serialises the statements of one transaction on its client */
class Lock {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.tail.then(fn)
    this.tail = r.then(() => undefined, () => undefined)
    return r
  }
}

interface TxState {
  pool: Pool
  client: PoolClient
  lock: Lock
  seq: { n: number }
  /** the SqlDb bound to this transaction (explicit statements, no savepoint) */
  bound: SqlDb
}

const ambient = new AsyncLocalStorage<TxState>()

function result(r: pg.QueryResult): SqlResult {
  return { affectedRows: r.rowCount ?? 0 }
}

function boundDb(st: Omit<TxState, 'bound'>, version: () => Promise<string>): SqlDb {
  const run = (sql: string, params: unknown[]) => st.lock.run(() => st.client.query(sql, params))
  const self: SqlDb = {
    dialect: 'postgres',
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      return (await run(sql, params)).rows as T[]
    },
    async exec(sql: string, params: unknown[] = []): Promise<SqlResult> {
      return result(await run(sql, params))
    },
    tx: <T>(fn: (db: SqlDb) => Promise<T>) => savepoint(full, fn),
    serverVersion: version,
    async close() { /* the pool owns the client */ },
  }
  const full: TxState = { ...st, bound: self }
  return self
}

/** nested transaction: a SAVEPOINT on the same client */
async function savepoint<T>(st: TxState, fn: (db: SqlDb) => Promise<T>): Promise<T> {
  const name = `ab_sp_${++st.seq.n}`
  await st.lock.run(() => st.client.query(`SAVEPOINT ${name}`))
  try {
    const out = await fn(st.bound)
    await st.lock.run(() => st.client.query(`RELEASE SAVEPOINT ${name}`))
    return out
  } catch (e) {
    try { await st.lock.run(() => st.client.query(`ROLLBACK TO SAVEPOINT ${name}`)) } catch { /* connection gone: the outer ROLLBACK reports it */ }
    throw e
  }
}

/** an ambient statement (pool-level call inside a unit of work): savepoint-wrapped so a caught failure is harmless */
async function ambientStatement(st: TxState, sql: string, params: unknown[]): Promise<pg.QueryResult> {
  return st.lock.run(async () => {
    const name = `ab_sp_${++st.seq.n}`
    await st.client.query(`SAVEPOINT ${name}`)
    try {
      const r = await st.client.query(sql, params)
      await st.client.query(`RELEASE SAVEPOINT ${name}`)
      return r
    } catch (e) {
      try { await st.client.query(`ROLLBACK TO SAVEPOINT ${name}`) } catch { /* reported by the outer transaction */ }
      throw e
    }
  })
}

/** the transaction the current async context runs in on this pool, if any */
function joined(pool: Pool): TxState | undefined {
  const st = ambient.getStore()
  return st && st.pool === pool ? st : undefined
}

/* ------------------------------------------------------------------ pool */

export interface PgDb extends SqlDb {
  /** true while the current async context runs inside tx() on this pool */
  inTransaction(): boolean
  /** the raw pool (tests, maintenance) */
  readonly pool: Pool
}

export function createPgDb(settings: DatabaseSettings, password: string, o: { max?: number; onError?: (e: Error) => void } = {}): PgDb {
  const pool = new pg.Pool(poolConfig(settings, password, { max: o.max }))
  // an idle client that loses its connection emits 'error' on the pool: without a listener the process would exit
  pool.on('error', (e) => o.onError?.(e))
  let version: string | null = null
  let closed = false

  const serverVersion = async (): Promise<string> => {
    if (version) return version
    const r = await pool.query('SHOW server_version')
    version = formatServerVersion(String((r.rows[0] as { server_version?: string })?.server_version ?? ''))
    return version
  }

  async function runQuery(sql: string, params: unknown[]): Promise<pg.QueryResult> {
    const st = joined(pool)
    if (st) return ambientStatement(st, sql, params)
    if (closed) throw Object.assign(new Error('The database pool is closed'), { code: 'POOL_CLOSED' })
    return pool.query(sql, params)
  }

  const self: PgDb = {
    dialect: 'postgres',
    pool,
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      return (await runQuery(sql, params)).rows as T[]
    },
    async exec(sql: string, params: unknown[] = []): Promise<SqlResult> {
      return result(await runQuery(sql, params))
    },
    async tx<T>(fn: (db: SqlDb) => Promise<T>): Promise<T> {
      const outer = joined(pool)
      if (outer) return savepoint(outer, fn)
      if (closed) throw Object.assign(new Error('The database pool is closed'), { code: 'POOL_CLOSED' })
      const client = await pool.connect()
      const base = { pool, client, lock: new Lock(), seq: { n: 0 } }
      const bound = boundDb(base, serverVersion)
      const st: TxState = { ...base, bound }
      let broken = false
      try {
        await client.query('BEGIN')
        const out = await ambient.run(st, () => fn(bound))
        await st.lock.run(() => client.query('COMMIT'))
        return out
      } catch (e) {
        try {
          await st.lock.run(() => client.query('ROLLBACK'))
        } catch {
          broken = true // connection gone: do not return it to the pool
        }
        throw e
      } finally {
        client.release(broken)
      }
    },
    inTransaction: () => !!joined(pool),
    serverVersion,
    async close() {
      if (closed) return
      closed = true
      await pool.end()
    },
  }
  return self
}

/** one short-lived connection (setup checks, CREATE DATABASE): never pooled */
export async function withClient<T>(settings: DatabaseSettings, password: string, database: string, fn: (c: pg.Client) => Promise<T>, connectTimeoutMs = 10000): Promise<T> {
  const cfg = poolConfig(settings, password, { database, connectTimeoutMs })
  const c = new pg.Client({ ...cfg })
  c.on('error', () => { /* reported by the failing query */ })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end().catch(() => {})
  }
}

/* ------------------------------------------------------------------ errors */

function scrub(msg: string, password: string): string {
  let m = msg
  if (password.length >= 3) m = m.split(password).join('***')
  return m.replace(/\s+/g, ' ').slice(0, 300)
}

/** Friendly, password-free explanation of a connection failure (setup screen, connection test). */
export function friendlyConnectionError(e: unknown, s: { host: string; port: number; database: string; user: string }, password = ''): string {
  const err = (e ?? {}) as PgError & { code?: string; errno?: number }
  const code = String(err.code ?? '')
  const msg = String(err.message ?? '')
  const at = `${s.host}:${s.port}`
  switch (code) {
    case 'ECONNREFUSED':
      return `Could not connect to ${at}: connection refused. Check that PostgreSQL is running and that the host and port are correct (PostgreSQL listens on 5432 by default).`
    case 'ENOTFOUND': case 'EAI_AGAIN':
      return `Could not find the server "${s.host}". Check the host name.`
    case 'ETIMEDOUT': case 'EHOSTUNREACH': case 'ENETUNREACH':
      return `Timed out connecting to ${at}. Check the host, the port and any firewall.`
    case 'ECONNRESET':
      return `The connection to ${at} was closed by the server. If the server requires SSL, turn SSL on.`
    case '28P01':
      return `Access denied for user "${s.user}": wrong user name or password.`
    case '28000':
      if (/no pg_hba\.conf entry/i.test(msg)) {
        return `The server does not accept connections from this computer for user "${s.user}" and database "${s.database}"${/no encryption/i.test(msg) ? ' without SSL' : ''}. Add a line for it to pg_hba.conf (or turn SSL on), then reload PostgreSQL.`
      }
      return `Access denied for user "${s.user}": the role does not exist or may not sign in.`
    case '3D000':
      return `The database "${s.database}" does not exist on ${at}. Create it first (scripts/setup-postgres), or tick "Create the database if it does not exist".`
    case '42501':
      return `User "${s.user}" is not allowed to connect to the database "${s.database}" (missing CONNECT privilege).`
    case '53300':
      return 'The server has too many connections right now. Try again shortly.'
    case '57P03':
      return `PostgreSQL at ${at} is starting up or shutting down. Try again in a moment.`
    case 'DEPTH_ZERO_SELF_SIGNED_CERT': case 'SELF_SIGNED_CERT_IN_CHAIN': case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'CERT_HAS_EXPIRED': case 'ERR_TLS_CERT_ALTNAME_INVALID': case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
      return `The server's SSL certificate could not be verified (${code}). Use a valid certificate, or turn SSL off for a trusted local server.`
  }
  if (/does not support SSL/i.test(msg)) return `The server at ${at} does not support SSL. Turn SSL off, or enable SSL in postgresql.conf.`
  if (/password must be a string|SASL|SCRAM/i.test(msg)) return `Access denied for user "${s.user}": the server requires a password.`
  if (/timeout/i.test(msg)) return `Timed out connecting to ${at}. Check the host, the port and any firewall.`
  if (/Connection terminated/i.test(msg)) return `The connection to ${at} was closed by the server. If the server requires SSL, turn SSL on.`
  return scrub(`Could not connect: ${msg || 'unknown error'}`, password)
}

/** SQLSTATE classes and codes -> HttpError. Never exposes SQL, values or secrets. */
export function mapPgError(e: unknown, password = ''): HttpError {
  if (e instanceof HttpError) return e
  const err = (e ?? {}) as PgError & { code?: string }
  const code = String(err.code ?? '')
  switch (code) {
    case '23505': return new HttpError(409, 'conflict', 'A row with the same unique value already exists')
    case '42P07': return new HttpError(409, 'conflict', 'A table with this name already exists in the database')
    case '42701': return new HttpError(409, 'conflict', 'A column with this name already exists')
    case '42P01': return new HttpError(404, 'not-found', 'The table does not exist in the database')
    case '3F000': return new HttpError(404, 'not-found', 'The schema does not exist in the database')
    case '42703': return new HttpError(422, 'invalid', 'A column does not exist in the database table')
    case '42704': return new HttpError(422, 'invalid', 'The column or index does not exist')
    case '42501': return new HttpError(403, 'denied', 'The database user is not allowed to do this')
    case '22001': return new HttpError(422, 'invalid', 'A value is too long for its column')
    case '22021': case '22P05': case '22P02': case '22003': case '22007': case '22008': case '23502': case '22004': case '22023':
      return new HttpError(422, 'invalid', /0x00|\\u0000/.test(String(err.message)) ? 'A value contains a NUL character, which the database cannot store' : 'A value does not fit its column')
    case '42804': return new HttpError(422, 'invalid', 'The values of this column cannot be converted to the new type')
    case '40P01': case '40001': case '55P03': case '57014': return new HttpError(409, 'conflict', 'The database is busy, try again')
    case 'ECONNREFUSED': case 'ENOTFOUND': case 'ETIMEDOUT': case 'ECONNRESET': case 'EHOSTUNREACH': case 'POOL_CLOSED':
    case '53300': case '57P01': case '57P02': case '57P03':
      return new HttpError(503, 'unavailable', 'The database is not reachable')
  }
  if (code.startsWith('08')) return new HttpError(503, 'unavailable', 'The database is not reachable')
  if (/Connection terminated|timeout exceeded when trying to connect/i.test(String(err.message ?? ''))) return new HttpError(503, 'unavailable', 'The database is not reachable')
  return new HttpError(500, 'storage', scrub(`Database error${code ? ` (${code})` : ''}`, password))
}
