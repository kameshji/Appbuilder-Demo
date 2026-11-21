/**
 * MySQL / MariaDB connector for EXTERNAL databases (link a customer's tables, or create tables in a customer's MySQL).
 * The system store and the default connection are PostgreSQL (connectors/postgres). SQL generation lives in sql.ts
 * (pure), the pool in db.ts.
 */
import mysql from 'mysql2/promise'
import type { ColumnDef, ColumnType, TableDef } from '../../../src/platform/contracts.ts'
import type { Condition, Query } from '../../../src/platform/http.ts'
import { HttpError } from '../../core/contracts.ts'
import type {
  Connector, ConnectorEnv, ConnectorFactory, ConnectionRecord, MySqlSettings, RawRow, SourceColumn, SqlDb,
} from '../../core/contracts.ts'
import { createSqlDb, formatServerVersion, poolOptions } from './db.ts'
import {
  SYSTEM_COLUMNS, buildCountById, buildDeletes, buildInserts, buildSelect, buildUpdate, checkSource, columnSql, columnTypesByName,
  createTableSql, fromDb, indexName, physicalName, quoteId, sqlType, tableId, wantedIndex,
} from './sql.ts'
import { rowUid } from '../../core/util.ts'
import { hostProblem } from '../../core/net-policy.ts'

export { createSqlDb }

/* ------------------------------------------------------------------ errors */

interface DbError { code?: string; errno?: number; message?: string; sqlMessage?: string }

function scrub(msg: string, password: string): string {
  let m = msg
  if (password.length >= 3) m = m.split(password).join('***')
  return m.replace(/\s+/g, ' ').slice(0, 300)
}

/** Friendly, password-free explanation of a connection failure. */
export function friendlyConnectionError(e: unknown, s: { host: string; port: number; database: string; user: string }, password = ''): string {
  const err = (e ?? {}) as DbError
  const code = err.code ?? ''
  const at = `${s.host}:${s.port}`
  switch (code) {
    case 'ECONNREFUSED':
      return `Could not connect to ${at}: connection refused. Check that MySQL is running and that the host and port are correct.`
    case 'ENOTFOUND': case 'EAI_AGAIN':
      return `Could not find the server "${s.host}". Check the host name.`
    case 'ETIMEDOUT': case 'EHOSTUNREACH': case 'ENETUNREACH':
      return `Timed out connecting to ${at}. Check the host, the port and any firewall.`
    case 'ECONNRESET': case 'PROTOCOL_CONNECTION_LOST':
      return `The connection to ${at} was closed by the server. If the server requires SSL, turn SSL on.`
    case 'ER_ACCESS_DENIED_ERROR': case 'ER_ACCESS_DENIED_NO_PASSWORD_ERROR':
      return `Access denied for user "${s.user}": wrong user name or password.`
    case 'ER_BAD_DB_ERROR':
      return `The database "${s.database}" does not exist on ${at}. Create it first, or check the name.`
    case 'ER_DBACCESS_DENIED_ERROR':
      return `User "${s.user}" has no access to the database "${s.database}" (or it does not exist).`
    case 'ER_NOT_SUPPORTED_AUTH_MODE': case 'AUTH_SWITCH_PLUGIN_ERROR': case 'ER_PLUGIN_IS_NOT_LOADED':
      return `The server uses an authentication method this connector cannot use over an insecure connection. Turn SSL on, or switch the user to mysql_native_password.`
    case 'HANDSHAKE_SSL_ERROR': case 'HANDSHAKE_NO_SSL_SUPPORT':
      return `The SSL handshake with ${at} failed. Check that the server supports SSL, or turn SSL off.`
    case 'DEPTH_ZERO_SELF_SIGNED_CERT': case 'SELF_SIGNED_CERT_IN_CHAIN': case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'CERT_HAS_EXPIRED': case 'ERR_TLS_CERT_ALTNAME_INVALID': case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
      return `The server's SSL certificate could not be verified (${code}). Use a valid certificate, or turn SSL off for a trusted local server.`
    case 'ER_HOST_NOT_PRIVILEGED': case 'ER_HOST_IS_BLOCKED':
      return `The server does not allow connections from this machine for user "${s.user}".`
    case 'ER_CON_COUNT_ERROR':
      return 'The server has too many connections right now. Try again shortly.'
  }
  if (/auth/i.test(err.message ?? '') && /plugin|secure|switch/i.test(err.message ?? '')) {
    return 'The server uses an authentication method that needs a secure connection. Turn SSL on, or switch the user to mysql_native_password.'
  }
  return scrub(`Could not connect: ${err.sqlMessage ?? err.message ?? 'unknown error'}`, password)
}

/** Maps a driver error raised by a data/DDL statement to an HttpError. Never exposes SQL or secrets. */
export function mapDbError(e: unknown, password = ''): HttpError {
  if (e instanceof HttpError) return e
  const err = (e ?? {}) as DbError
  switch (err.code) {
    case 'ER_DUP_ENTRY': return new HttpError(409, 'conflict', 'A row with the same unique value already exists')
    case 'ER_TABLE_EXISTS_ERROR': return new HttpError(409, 'conflict', 'A table with this name already exists in the database')
    case 'ER_DUP_FIELDNAME': return new HttpError(409, 'conflict', 'A column with this name already exists')
    case 'ER_NO_SUCH_TABLE': return new HttpError(404, 'not-found', 'The table does not exist in the database')
    case 'ER_BAD_FIELD_ERROR': return new HttpError(422, 'invalid', 'A column does not exist in the database table')
    case 'ER_CANT_DROP_FIELD_OR_KEY': return new HttpError(422, 'invalid', 'The column or index does not exist')
    case 'ER_TABLEACCESS_DENIED_ERROR': case 'ER_COLUMNACCESS_DENIED_ERROR': case 'ER_DBACCESS_DENIED_ERROR':
    case 'ER_SPECIFIC_ACCESS_DENIED_ERROR': case 'ER_ACCESS_DENIED_ERROR':
      return new HttpError(403, 'denied', 'The database user is not allowed to do this')
    case 'ER_DATA_TOO_LONG': return new HttpError(422, 'invalid', 'A value is too long for its column')
    case 'ER_TRUNCATED_WRONG_VALUE': case 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD': case 'ER_WARN_DATA_OUT_OF_RANGE': case 'ER_DATA_OUT_OF_RANGE':
    case 'ER_BAD_NULL_ERROR': case 'WARN_DATA_TRUNCATED':
      return new HttpError(422, 'invalid', 'A value does not fit its column')
    case 'ER_LOCK_DEADLOCK': case 'ER_LOCK_WAIT_TIMEOUT': return new HttpError(409, 'conflict', 'The database is busy, try again')
    case 'ECONNREFUSED': case 'ENOTFOUND': case 'ETIMEDOUT': case 'ECONNRESET': case 'PROTOCOL_CONNECTION_LOST': case 'EHOSTUNREACH':
    case 'ER_CON_COUNT_ERROR': case 'POOL_CLOSED':
      return new HttpError(503, 'unavailable', 'The database is not reachable')
  }
  return new HttpError(500, 'storage', scrub(`Database error${err.code ? ` (${err.code})` : ''}`, password))
}

/* ------------------------------------------------------------------ information_schema -> ColumnType */

export function mapSqlType(c: { dataType: string; columnType: string; scale?: number | null; precision?: number | null }): ColumnType {
  const t = c.dataType.toLowerCase()
  const ct = c.columnType.toLowerCase()
  switch (t) {
    case 'tinyint': return /^tinyint\(1\)/.test(ct) ? 'boolean' : 'number'
    case 'bit': return /^bit\(1\)/.test(ct) ? 'boolean' : 'number'
    case 'smallint': case 'mediumint': case 'int': case 'integer': case 'bigint': case 'year': return 'number'
    case 'decimal': case 'numeric':
      if (Number(c.precision) === 19 && Number(c.scale) === 4) return 'currency'
      return Number(c.scale) === 0 ? 'number' : 'decimal'
    case 'float': case 'double': case 'real': return 'decimal'
    case 'date': return 'date'
    case 'datetime': case 'timestamp': return 'datetime'
    case 'tinytext': case 'text': case 'mediumtext': case 'longtext': case 'json': return 'multiline'
    case 'enum': return 'choice'
    default: return 'text' // char, varchar, set, time, binary, blob, ...
  }
}

interface ColRow { name: string; dt: string; ct: string; prec: number | null; scale: number | null; tbl?: string }

/* ------------------------------------------------------------------ connector */

function parseSettings(conn: ConnectionRecord): MySqlSettings & { valid: boolean } {
  const s = conn.settings ?? {}
  const port = Number(s.port || 3306)
  return {
    host: (s.host ?? '').trim(),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 3306,
    database: (s.database ?? '').trim(),
    user: (s.user ?? '').trim(),
    ssl: String(s.ssl ?? 'false').toLowerCase() === 'true',
    valid: !!(s.host && s.database && s.user) && !hostProblem(String(s.host)),
  }
}

export const createMySqlConnector: ConnectorFactory = (conn: ConnectionRecord, env: ConnectorEnv): Connector => {
  const settings = parseSettings(conn)
  const password = conn.secret ?? ''
  let db: SqlDb | null = null

  const getDb = (): SqlDb => {
    if (!settings.valid) throw new HttpError(503, 'unavailable', 'The MySQL connection is not configured (host, database and user are required)')
    // env.dbLookup (P3-6): the pool connects to addresses the outbound policy checked, never to a second DNS answer
    if (!db) db = createSqlDb(settings, password, { lookup: env.dbLookup })
    return db
  }
  /** run a DB action, mapping driver errors (logged without SQL or secrets); `bound` = inside a transaction */
  async function run<T>(fn: (d: SqlDb) => Promise<T>, bound?: SqlDb): Promise<T> {
    try {
      return await fn(bound ?? getDb())
    } catch (e) {
      const mapped = mapDbError(e, password)
      if (!(e instanceof HttpError)) env.log(mapped.status >= 500 ? 'error' : 'warn', `mysql: ${(e as DbError).code ?? 'error'}: ${scrub((e as DbError).sqlMessage ?? (e as DbError).message ?? '', password)}`)
      throw mapped
    }
  }

  async function columnRows(d: SqlDb, source?: string): Promise<ColRow[]> {
    const sql = `SELECT table_name AS tbl, column_name AS name, data_type AS dt, column_type AS ct, numeric_precision AS prec, numeric_scale AS scale
      FROM information_schema.columns WHERE table_schema = DATABASE()${source ? ' AND table_name = ?' : ''}
      ORDER BY table_name, ordinal_position`
    return d.query<ColRow>(sql, source ? [source] : [])
  }
  const toSource = (r: ColRow): SourceColumn => ({ name: r.name, type: mapSqlType({ dataType: r.dt, columnType: r.ct, precision: r.prec, scale: r.scale }) })

  /** make the secondary indexes of a column match what the def wants (only ix_/uq_ indexes created by us) */
  async function syncIndexes(d: SqlDb, def: TableDef, col: ColumnDef): Promise<void> {
    const want = wantedIndex(col)
    const existing = await d.query<{ name: string; nu: number }>(
      `SELECT DISTINCT index_name AS name, non_unique AS nu FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? AND seq_in_index = 1
         AND (index_name LIKE 'uq\\_%' OR index_name LIKE 'ix\\_%')`,
      [physicalName(def), col.name])
    let have = false
    for (const ix of existing) {
      const kind = Number(ix.nu) === 0 ? 'unique' : 'index'
      if (kind === want && !have) { have = true; continue }
      await d.exec(`ALTER TABLE ${tableId(def)} DROP INDEX ${quoteId(ix.name)}`)
    }
    if (want && !have) {
      await d.exec(`ALTER TABLE ${tableId(def)} ADD ${want === 'unique' ? 'UNIQUE KEY' : 'KEY'} ${quoteId(indexName(want, col.name))} (${quoteId(col.name)})`)
    }
  }

  /** data statements over the pool, or bound to one transaction connection */
  function dataOps(bound: SqlDb | undefined): Pick<Connector, 'select' | 'insert' | 'update' | 'delete'> {
    return {
      async select(def: TableDef, q: Query) {
        const plan = buildSelect(def, q)
        const types = columnTypesByName(def)
        return run(async (d) => {
          const raw = await d.query<Record<string, unknown>>(plan.sql, plan.params)
          const rows: RawRow[] = raw.map((r) => {
            const out: RawRow = {}
            for (const c of plan.columns) out[c.name] = fromDb(r[c.name], types.get(c.name) ?? c.type)
            return out
          })
          let total: number | undefined
          if (plan.countSql) total = Number((await d.query<{ n: number }>(plan.countSql, plan.countParams))[0]?.n ?? 0)
          return { rows, total }
        }, bound)
      },

      async insert(def: TableDef, rows: RawRow[]) {
        const stmts = buildInserts(def, rows)
        if (!stmts.length) return
        await run(async (d) => {
          if (stmts.length === 1) { await d.exec(stmts[0].sql, stmts[0].params); return }
          await d.tx(async (t) => { for (const s of stmts) await t.exec(s.sql, s.params) })
        }, bound)
      },

      async update(def: TableDef, id: string, changes: RawRow, guard?: Condition) {
        const stmt = buildUpdate(def, id, changes, guard)
        return run(async (d) => {
          if (!stmt) {
            const c = buildCountById(def, id, guard)
            return Number((await d.query<{ n: number }>(c.sql, c.params))[0]?.n ?? 0)
          }
          return (await d.exec(stmt.sql, stmt.params)).affectedRows
        }, bound)
      },

      async delete(def: TableDef, ids: string[], guard?: Condition) {
        const stmts = buildDeletes(def, ids, guard)
        if (!stmts.length) return 0
        return run(async (d) => {
          if (stmts.length === 1) return (await d.exec(stmts[0].sql, stmts[0].params)).affectedRows
          // several chunks: all or nothing
          return d.tx(async (t) => {
            let n = 0
            for (const s of stmts) n += (await t.exec(s.sql, s.params)).affectedRows
            return n
          })
        }, bound)
      },
    }
  }

  const connector: Connector = {
    kind: 'mysql',
    capabilities: { ddl: true, write: true, pushdown: true, transactions: true },

    async test() {
      if (!settings.valid) return { ok: false, message: 'Host, database and user are required.' }
      let c: Awaited<ReturnType<typeof mysql.createConnection>> | null = null
      try {
        const o = poolOptions(settings, password, { lookup: env.dbLookup })
        c = await mysql.createConnection({
          ...(o.stream ? { stream: o.stream } : {}),
          host: o.host, port: o.port, user: o.user, password: o.password, database: o.database, ssl: o.ssl, charset: o.charset,
          timezone: 'Z', connectTimeout: 8000,
        })
        const [rows] = await c.query('SELECT VERSION() AS v')
        const v = formatServerVersion(String((rows as { v: string }[])[0]?.v ?? ''))
        return { ok: true as const, message: `Connected to ${v} at ${settings.host}:${settings.port}/${settings.database}` }
      } catch (e) {
        return { ok: false as const, message: friendlyConnectionError(e, settings, password) }
      } finally {
        if (c) { try { await c.end() } catch { c.destroy() } }
      }
    },

    async listSourceTables() {
      return run(async (d) => {
        const tables = await d.query<{ name: string; est: number | null }>(
          `SELECT table_name AS name, table_rows AS est FROM information_schema.tables
           WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND table_name NOT LIKE 'ab\\_%' ORDER BY table_name`)
        const cols = await columnRows(d)
        const byTable = new Map<string, SourceColumn[]>()
        for (const r of cols) {
          const list = byTable.get(r.tbl as string) ?? []
          list.push(toSource(r))
          byTable.set(r.tbl as string, list)
        }
        const exact = tables.length <= 50
        const out: { source: string; columns: SourceColumn[]; rowCount?: number }[] = []
        for (const t of tables) {
          let rowCount = t.est === null || t.est === undefined ? undefined : Number(t.est)
          if (exact) {
            try { rowCount = Number((await d.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${quoteId(t.name)}`))[0].n) } catch { /* keep the estimate */ }
          }
          out.push({ source: t.name, columns: byTable.get(t.name) ?? [], rowCount })
        }
        return out
      })
    },

    async foreignKeys() {
      return run(async (d) => {
        // single-column foreign keys between tables of this database (data model designer import)
        const rows = await d.query<{ tbl: string; col: string; ref: string; refcol: string; del: string; n: number }>(
          `SELECT k.TABLE_NAME AS tbl, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_NAME AS ref, k.REFERENCED_COLUMN_NAME AS refcol, r.DELETE_RULE AS del,
                  (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE k2 WHERE k2.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND k2.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND k2.TABLE_NAME = k.TABLE_NAME) AS n
             FROM information_schema.KEY_COLUMN_USAGE k
             JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
            WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL AND k.REFERENCED_TABLE_SCHEMA = DATABASE()
            ORDER BY k.TABLE_NAME, k.COLUMN_NAME`)
        return rows.filter((r) => Number(r.n) === 1).map((r) => ({ table: String(r.tbl), column: String(r.col), refTable: String(r.ref), refColumn: String(r.refcol), onDelete: String(r.del ?? 'NO ACTION').toLowerCase() }))
      })
    },

    async describe(source) {
      checkSource(source)
      return run(async (d) => {
        const rows = await columnRows(d, source)
        if (!rows.length) throw new HttpError(404, 'not-found', `Table "${source}" does not exist in the database`)
        return rows.map(toSource)
      })
    },

    async createTable(def) {
      const sql = createTableSql(def)
      await run((d) => d.exec(sql))
    },

    async addColumn(def, col) {
      const t = tableId(def)
      await run(async (d) => {
        await d.exec(`ALTER TABLE ${t} ADD COLUMN ${columnSql(col)}`)
        await syncIndexes(d, def, col)
      })
    },

    async alterColumn(def, before, after) {
      const t = tableId(def)
      await run(async (d) => {
        const spec = `${quoteId(after.name)} ${sqlType(after)} NULL`
        await d.exec(before.name !== after.name
          ? `ALTER TABLE ${t} CHANGE COLUMN ${quoteId(before.name)} ${spec}`
          : `ALTER TABLE ${t} MODIFY COLUMN ${spec}`)
        await syncIndexes(d, def, after)
      })
    },

    async dropColumn(def, name) {
      const t = tableId(def)
      await run((d) => d.exec(`ALTER TABLE ${t} DROP COLUMN ${quoteId(name)}`))
    },

    async dropTable(def) {
      const t = tableId(def)
      await run((d) => d.exec(`DROP TABLE IF EXISTS ${t}`))
    },

    /**
     * Consent given at link time: ALTER TABLE ... ADD COLUMN for every missing system column. A missing id is added as
     * CHAR(36) NULL, filled row by row with UUIDv7 values (UPDATE ... WHERE id IS NULL LIMIT 1, portable to MySQL 5.7 and
     * MariaDB), then made NOT NULL with a unique key. createdOn / modifiedOn of existing rows become the current UTC time.
     */
    async ensureSystemColumns(source: string) {
      checkSource(source)
      const def: TableDef = { id: '', name: source, displayName: source, primaryColumn: 'id', columns: [], createdOn: '', modifiedOn: '', source }
      const t = tableId(def)
      return run(async (d) => {
        const present = new Set((await columnRows(d, source)).map((r) => String(r.name)))
        if (!present.size) throw new HttpError(404, 'not-found', `Table "${source}" does not exist in the database`)
        const added: string[] = []
        let filled = 0
        if (!present.has('id')) {
          await d.exec(`ALTER TABLE ${t} ADD COLUMN \`id\` CHAR(36) NULL`)
          added.push('id')
          for (;;) {
            const r = await d.exec(`UPDATE ${t} SET \`id\` = ? WHERE \`id\` IS NULL LIMIT 1`, [rowUid()])
            if (!r.affectedRows) break
            filled++
          }
          await d.exec(`ALTER TABLE ${t} MODIFY COLUMN \`id\` CHAR(36) NOT NULL`)
          await d.exec(`ALTER TABLE ${t} ADD UNIQUE KEY ${quoteId(indexName('unique', 'id'))} (\`id\`)`)
        }
        for (const col of SYSTEM_COLUMNS) {
          if (col.name === 'id' || present.has(col.name)) continue
          await d.exec(`ALTER TABLE ${t} ADD COLUMN ${columnSql(col)}`)
          await syncIndexes(d, def, col)
          if (col.name === 'createdOn' || col.name === 'modifiedOn') await d.exec(`UPDATE ${t} SET ${quoteId(col.name)} = UTC_TIMESTAMP(3) WHERE ${quoteId(col.name)} IS NULL`)
          added.push(col.name)
        }
        return { added, filled }
      })
    },

    ...dataOps(undefined),

    async transaction<T>(fn: (tx: Connector) => Promise<T>): Promise<T> {
      return run((d) => d.tx((t) => {
        // same connector, data statements on the transaction's connection; nested transactions join it
        const txc: Connector = { ...connector, ...dataOps(t), close: async () => {} }
        txc.transaction = <U>(inner: (tx: Connector) => Promise<U>) => inner(txc)
        return fn(txc)
      }))
    },

    async close() {
      const d = db
      db = null
      if (d) await d.close()
    },
  }
  return connector
}
