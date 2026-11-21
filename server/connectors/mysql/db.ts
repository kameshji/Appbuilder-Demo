/** SqlDb over a mysql2/promise pool (`?` placeholders). Used only by the MySQL connector (external databases). */
import net from 'node:net'
import mysql from 'mysql2/promise'
import type { Pool, PoolConnection, PoolOptions } from 'mysql2/promise'
import type { MySqlSettings, SqlDb, SqlResult } from '../../core/contracts.ts'
import { pinnedSocket, type NodeLookup } from '../../core/net-policy.ts'

/** the socket mysql2 would open itself (Net.connect(port, host), no delay, keep-alive), resolved through `lookup` */
function mysqlSocket(lookup: NodeLookup | undefined, host: string, port: number) {
  const sock = lookup ? pinnedSocket(lookup) : new net.Socket()
  sock.connect(port, host)
  // TLS to an IP address: mysql2 gives TLS no server name, so Node checks the certificate against the socket's host,
  // which net leaves unset for an address (and then checks "localhost"). Name the address, so it must be in the
  // certificate (P3-15).
  if (net.isIP(host)) (sock as unknown as { _host: string })._host = host
  sock.setNoDelay(true)
  sock.once('connect', () => sock.setKeepAlive(true, 0))
  return sock
}

/**
 * `lookup` (P3-6): every physical connection resolves the host through it (the outbound policy's guardedLookup), not the
 * system resolver; `host` stays the name for TLS and error messages. TLS (P3-15): with SSL on, mysql2 checks the
 * certificate's chain (`rejectUnauthorized`) and that it names the host typed (`verifyIdentity`; an IP address must be
 * in the certificate's IP addresses), as PostgreSQL connections do (docs/admin/connections.md).
 */
export function poolOptions(s: MySqlSettings, password: string, o: { lookup?: NodeLookup } = {}): PoolOptions {
  const lookup = o.lookup
  const tlsToAddress = !!s.ssl && net.isIP(s.host) !== 0
  return {
    ...(lookup || tlsToAddress ? { stream: () => mysqlSocket(lookup, s.host, s.port) } : {}),
    host: s.host,
    port: s.port,
    user: s.user,
    password,
    database: s.database,
    ssl: s.ssl ? { minVersion: 'TLSv1.2', rejectUnauthorized: true, verifyIdentity: true } : undefined,
    charset: 'UTF8MB4_UNICODE_CI',
    dateStrings: false,
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: false,
    connectionLimit: 10,
    namedPlaceholders: false,
    multipleStatements: false,
    waitForConnections: true,
    connectTimeout: 10000,
    enableKeepAlive: true,
  }
}

export function formatServerVersion(v: string): string {
  const m = /^(\d+\.\d+\.\d+)/.exec(v)
  const num = m ? m[1] : v
  return /mariadb/i.test(v) ? `MariaDB ${num}` : `MySQL ${num}`
}

type Runner = Pick<Pool | PoolConnection, 'query'>

function wrap(run: Runner, pool: Pool | null, conn: PoolConnection | null): SqlDb {
  let version: string | null = null
  const self: SqlDb = {
    dialect: 'mysql',
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const [rows] = await run.query(sql, params)
      return rows as unknown as T[]
    },
    async exec(sql: string, params: unknown[] = []): Promise<SqlResult> {
      const [res] = await run.query(sql, params)
      const h = res as { affectedRows?: number; insertId?: number }
      return { affectedRows: h.affectedRows ?? 0, insertId: h.insertId ? Number(h.insertId) : undefined }
    },
    async tx<T>(fn: (db: SqlDb) => Promise<T>): Promise<T> {
      if (conn || !pool) return fn(self) // already inside a transaction: join it
      const c = await pool.getConnection()
      try {
        await c.query('BEGIN')
        const out = await fn(wrap(c, null, c))
        await c.query('COMMIT')
        return out
      } catch (e) {
        try { await c.query('ROLLBACK') } catch { /* connection already gone */ }
        throw e
      } finally {
        c.release()
      }
    },
    async serverVersion(): Promise<string> {
      if (version) return version
      const [rows] = await run.query('SELECT VERSION() AS v')
      version = formatServerVersion(String((rows as { v: string }[])[0]?.v ?? ''))
      return version
    },
    async close(): Promise<void> {
      if (pool) await pool.end()
    },
  }
  return self
}

export function createSqlDb(settings: MySqlSettings, password: string, o: { lookup?: NodeLookup; connectTimeoutMs?: number } = {}): SqlDb {
  const pool = mysql.createPool({ ...poolOptions(settings, password, { lookup: o.lookup }), ...(o.connectTimeoutMs ? { connectTimeout: o.connectTimeoutMs } : {}) })
  return wrap(pool, pool, null)
}
