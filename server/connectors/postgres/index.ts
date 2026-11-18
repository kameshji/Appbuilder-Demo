/**
 * PostgreSQL connector. Two uses:
 *  - the default connection (conn_default, "Default database"): tables live in the environment schema of the system
 *    database and the connector uses the system pool (env.systemDb), so DDL and rows join a unit of work
 *    (Services.transaction) together with the metadata;
 *  - an external PostgreSQL database (a customer's): its own pool, tables in settings.schema (default public).
 * SQL generation lives in sql.ts (pure), the pool and error mapping in db.ts.
 */
import type { ColumnDef, TableDef } from '../../../src/platform/contracts.ts'
import type { Condition, Query } from '../../../src/platform/http.ts'
import { HttpError } from '../../core/contracts.ts'
import type {
  Connector, ConnectorEnv, ConnectorFactory, ConnectionRecord, DatabaseSettings, RawRow, SourceColumn, SqlDb,
} from '../../core/contracts.ts'
import { createPgDb, friendlyConnectionError, mapPgError, withClient, formatServerVersion } from './db.ts'
import { isPgError } from './db.ts'
import type { PgError } from './db.ts'
import {
  SYSTEM_COLUMNS, buildCountById, buildDeletes, buildInserts, buildSelect, buildUpdate, checkSource, columnSql, columnTypesByName,
  createIndexSql, createTableSql, dropIndexesSql, fromDb, indexName, jsNumberText, kindOf, mapSqlType, physicalName, quoteId,
  sqlType, tableId, wantedIndex,
} from './sql.ts'
import type { Dialect } from './sql.ts'
import { rowUid } from '../../core/util.ts'
import { DEFAULT_CONNECTION_ID } from '../../core/connections.ts'

export { createPgDb, friendlyConnectionError, mapPgError }

const SCHEMA_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/

interface PgSettings extends DatabaseSettings { schema: string; valid: boolean }

function parseSettings(conn: ConnectionRecord): PgSettings {
  const s = conn.settings ?? {}
  const port = Number(s.port || 5432)
  const schema = String(s.schema ?? '').trim() || 'public'
  return {
    host: (s.host ?? '').trim(),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 5432,
    database: (s.database ?? '').trim(),
    user: (s.user ?? '').trim(),
    ssl: String(s.ssl ?? 'false').toLowerCase() === 'true',
    schema,
    valid: !!(s.host && s.database && s.user) && SCHEMA_RE.test(schema),
  }
}

function scrub(msg: string, password: string): string {
  let m = msg
  if (password.length >= 3) m = m.split(password).join('***')
  return m.replace(/\s+/g, ' ').slice(0, 300)
}

/** USING expression of ALTER COLUMN ... TYPE for a type change (the service has verified the values convert) */
export function alterUsing(before: ColumnDef, after: ColumnDef, q: string): string {
  const from = kindOf(before.type)
  const to = kindOf(after.type)
  const target = sqlType(after)
  const text = `NULLIF(btrim(${q}::text), '')`
  const boolText = `(CASE lower(btrim(${q}::text)) WHEN 'true' THEN TRUE WHEN 't' THEN TRUE WHEN '1' THEN TRUE WHEN 'yes' THEN TRUE WHEN 'y' THEN TRUE `
    + `WHEN 'false' THEN FALSE WHEN 'f' THEN FALSE WHEN '0' THEN FALSE WHEN 'no' THEN FALSE WHEN 'n' THEN FALSE END)`
  switch (to) {
    case 'num': {
      const src = from === 'text' ? `${text}::numeric` : from === 'bool' ? `(CASE WHEN ${q} THEN 1 ELSE 0 END)::numeric` : from === 'num' ? `${q}::numeric` : 'NULL::numeric'
      if (after.type === 'number') return `round(${src})::bigint`
      if (after.type === 'decimal') return `(${src})::double precision`
      return `(${src})::numeric(19,4)`
    }
    case 'bool':
      if (from === 'bool') return q
      if (from === 'num') return `(${q} <> 0)`
      return boolText
    case 'date':
      if (from === 'date') return q
      if (from === 'datetime') return `(${q} AT TIME ZONE 'UTC')::date`
      return `(${text}::timestamptz AT TIME ZONE 'UTC')::date`
    case 'datetime':
      if (from === 'datetime') return `${q}::timestamptz(3)`
      if (from === 'date') return `(${q}::timestamp AT TIME ZONE 'UTC')::timestamptz(3)`
      return `${text}::timestamptz(3)`
    default: {
      let s: string
      if (from === 'num') s = jsNumberText(`${q}::double precision`)
      else if (from === 'bool') s = `(CASE WHEN ${q} THEN 'true' WHEN NOT ${q} THEN 'false' END)`
      else if (from === 'date') s = `to_char(${q}, 'YYYY-MM-DD')`
      else if (from === 'datetime') s = `to_char(${q} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
      else s = `${q}::text`
      return `(${s})::${target}`
    }
  }
}

interface ColRow { tbl: string; name: string; dt: string; udt: string; prec: number | null; scale: number | null }

export const createPostgresConnector: ConnectorFactory = (conn: ConnectionRecord, env: ConnectorEnv): Connector => {
  const settings = parseSettings(conn)
  const password = conn.secret ?? ''
  // the default connection: the system database, the environment's schema, the system pool
  const system = conn.id === DEFAULT_CONNECTION_ID && !!env.systemDb && !!env.environment
  const schema = system ? env.environment!.schema : settings.schema
  let own: SqlDb | null = null
  let icu: Promise<boolean> | null = null

  const getDb = (): SqlDb => {
    if (system) {
      const d = env.systemDb!()
      if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
      return d
    }
    if (!settings.valid) throw new HttpError(503, 'unavailable', 'The PostgreSQL connection is not configured (host, database and user are required; the schema must be a plain identifier)')
    if (!own) own = createPgDb(settings, password, { onError: (e) => env.log('warn', `postgres pool: ${scrub(e.message, password)}`) })
    return own
  }
  async function dialect(d: SqlDb): Promise<Dialect> {
    if (!icu) {
      icu = d.query<{ ok: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_collation WHERE collname = 'und-x-icu') AS ok")
        .then((r) => !!r[0]?.ok)
        .catch((e) => { icu = null; throw e })
    }
    return { schema, icu: await icu }
  }
  /** run a DB action, mapping driver errors (logged without SQL or secrets); `bound` = inside a transaction */
  async function run<T>(fn: (d: SqlDb, dl: Dialect) => Promise<T>, bound?: SqlDb): Promise<T> {
    try {
      const d = bound ?? getDb()
      return await fn(d, await dialect(d))
    } catch (e) {
      const mapped = mapPgError(e, password)
      if (!(e instanceof HttpError)) env.log(mapped.status >= 500 ? 'error' : 'warn', `postgres: ${(e as PgError).code ?? 'error'}: ${scrub((e as PgError).message ?? '', password)}`)
      throw mapped
    }
  }

  async function columnRows(d: SqlDb, source?: string): Promise<ColRow[]> {
    const sql = `SELECT table_name AS tbl, column_name AS name, data_type AS dt, udt_name AS udt, numeric_precision AS prec, numeric_scale AS scale
      FROM information_schema.columns WHERE table_schema = $1${source ? ' AND table_name = $2' : ''}
      ORDER BY table_name, ordinal_position`
    return d.query<ColRow>(sql, source ? [schema, source] : [schema])
  }
  const toSource = (r: ColRow): SourceColumn => ({ name: r.name, type: mapSqlType({ dataType: r.dt, udtName: r.udt, precision: r.prec, scale: r.scale }) })

  /** make the secondary indexes of a column match what the def wants (only our uq_/ix_ index names are touched) */
  async function syncIndexes(d: SqlDb, dl: Dialect, def: TableDef, col: ColumnDef): Promise<void> {
    const want = wantedIndex(col)
    const table = physicalName(def)
    for (const k of ['unique', 'index'] as const) {
      if (k !== want) await d.exec(`DROP INDEX IF EXISTS ${quoteId(dl.schema)}.${quoteId(indexName(table, k, col.name))}`)
    }
    if (want) await d.exec(createIndexSql(dl, def, col, want))
  }

  /** data statements over the pool, or bound to one transaction connection */
  function dataOps(bound: SqlDb | undefined): Pick<Connector, 'select' | 'insert' | 'update' | 'delete'> {
    return {
      async select(def: TableDef, q: Query) {
        const types = columnTypesByName(def)
        return run(async (d, dl) => {
          const plan = buildSelect(dl, def, q)
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
        await run(async (d, dl) => {
          const stmts = buildInserts(dl, def, rows)
          if (!stmts.length) return
          if (stmts.length === 1) { await d.exec(stmts[0].sql, stmts[0].params); return }
          await d.tx(async (t) => { for (const s of stmts) await t.exec(s.sql, s.params) })
        }, bound)
      },

      async update(def: TableDef, id: string, changes: RawRow, guard?: Condition) {
        return run(async (d, dl) => {
          const stmt = buildUpdate(dl, def, id, changes, guard)
          if (!stmt) {
            const c = buildCountById(dl, def, id, guard)
            return Number((await d.query<{ n: number }>(c.sql, c.params))[0]?.n ?? 0)
          }
          return (await d.exec(stmt.sql, stmt.params)).affectedRows
        }, bound)
      },

      async delete(def: TableDef, ids: string[], guard?: Condition) {
        return run(async (d, dl) => {
          const stmts = buildDeletes(dl, def, ids, guard)
          if (!stmts.length) return 0
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

  /** DDL: several statements, always in one transaction (PostgreSQL DDL is transactional) */
  function ddl(fn: (t: SqlDb, dl: Dialect) => Promise<void>, bound?: SqlDb): Promise<void> {
    return run((d, dl) => d.tx((t) => fn(t, dl)), bound)
  }

  function ddlOps(bound: SqlDb | undefined): Pick<Connector, 'createTable' | 'addColumn' | 'alterColumn' | 'dropColumn' | 'dropTable' | 'ensureSystemColumns'> {
    return {
      async createTable(def) {
        await ddl(async (t, dl) => {
          for (const s of createTableSql(dl, def)) await t.exec(s)
        }, bound)
      },

      async addColumn(def, col) {
        await ddl(async (t, dl) => {
          await t.exec(`ALTER TABLE ${tableId(dl, def)} ADD COLUMN ${columnSql(col)}`)
          await syncIndexes(t, dl, def, col)
        }, bound)
      },

      async alterColumn(def, before, after) {
        await ddl(async (t, dl) => {
          const tbl = tableId(dl, def)
          // our indexes of the column go first: an expression index (lower(col)) cannot survive a type change
          for (const s of dropIndexesSql(dl, def, before.name)) await t.exec(s)
          if (before.name !== after.name) await t.exec(`ALTER TABLE ${tbl} RENAME COLUMN ${quoteId(before.name)} TO ${quoteId(after.name)}`)
          const q = quoteId(after.name)
          if (sqlType(before) !== sqlType(after)) {
            await t.exec(`ALTER TABLE ${tbl} ALTER COLUMN ${q} TYPE ${sqlType(after)} USING ${alterUsing(before, after, q)}`)
          }
          await syncIndexes(t, dl, def, after)
        }, bound)
      },

      async dropColumn(def, name) {
        await ddl(async (t, dl) => {
          await t.exec(`ALTER TABLE ${tableId(dl, def)} DROP COLUMN ${quoteId(name)}`)
        }, bound)
      },

      async dropTable(def) {
        await ddl(async (t, dl) => {
          await t.exec(`DROP TABLE IF EXISTS ${tableId(dl, def)}`)
        }, bound)
      },

      /**
       * Consent given at link time: ADD COLUMN for every missing system column. A missing id is added as text NULL, filled
       * with UUIDv7 values in physical row order, then made NOT NULL with a unique index. createdOn / modifiedOn of
       * existing rows become the current time. One transaction: a failure leaves the table as it was.
       */
      async ensureSystemColumns(source: string) {
        checkSource(source)
        const def: TableDef = { id: '', name: source, displayName: source, primaryColumn: 'id', columns: [], createdOn: '', modifiedOn: '', source }
        let out = { added: [] as string[], filled: 0 }
        await ddl(async (t, dl) => {
          const tbl = tableId(dl, def)
          const present = new Set((await columnRows(t, source)).map((r) => String(r.name)))
          if (!present.size) throw new HttpError(404, 'not-found', `Table "${source}" does not exist in the database`)
          const added: string[] = []
          let filled = 0
          if (!present.has('id')) {
            await t.exec(`ALTER TABLE ${tbl} ADD COLUMN "id" text NULL`)
            added.push('id')
            const ctids = (await t.query<{ c: string }>(`SELECT ctid::text AS c FROM ${tbl} ORDER BY ctid`)).map((r) => r.c)
            for (let i = 0; i < ctids.length; i += 5000) {
              const chunk = ctids.slice(i, i + 5000)
              const ids = chunk.map(() => rowUid())
              const r = await t.exec(
                `UPDATE ${tbl} AS x SET "id" = v.id FROM (SELECT unnest($1::text[])::tid AS c, unnest($2::text[]) AS id) AS v WHERE x.ctid = v.c`,
                [chunk, ids],
              )
              filled += r.affectedRows
            }
            await t.exec(`ALTER TABLE ${tbl} ALTER COLUMN "id" SET NOT NULL`)
            await t.exec(`CREATE UNIQUE INDEX ${quoteId(indexName(source, 'unique', 'id'))} ON ${tbl} ("id")`)
          }
          for (const col of SYSTEM_COLUMNS) {
            if (col.name === 'id' || present.has(col.name)) continue
            await t.exec(`ALTER TABLE ${tbl} ADD COLUMN ${columnSql(col)}`)
            await syncIndexes(t, dl, def, col)
            if (col.name === 'createdOn' || col.name === 'modifiedOn') await t.exec(`UPDATE ${tbl} SET ${quoteId(col.name)} = date_trunc('milliseconds', now()) WHERE ${quoteId(col.name)} IS NULL`)
            added.push(col.name)
          }
          out = { added, filled }
        })
        return out
      },
    }
  }

  const connector: Connector = {
    kind: 'postgres',
    capabilities: { ddl: true, write: true, pushdown: true, transactions: true },

    async test() {
      if (system) {
        try {
          const d = getDb()
          const v = await d.serverVersion()
          return { ok: true as const, message: `Connected to ${v} (system database, schema ${schema})` }
        } catch (e) {
          return { ok: false as const, message: e instanceof HttpError ? e.message : 'The system database is not reachable.' }
        }
      }
      if (!settings.valid) return { ok: false, message: 'Host, database and user are required (and the schema must be a plain identifier).' }
      try {
        return await withClient(settings, password, settings.database, async (c) => {
          const v = formatServerVersion(String((await c.query('SHOW server_version')).rows[0]?.server_version ?? ''))
          const has = await c.query('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1', [schema])
          if (!has.rowCount) return { ok: false as const, message: `Connected to ${v}, but the schema "${schema}" does not exist in "${settings.database}".` }
          return { ok: true as const, message: `Connected to ${v} at ${settings.host}:${settings.port}/${settings.database} (schema ${schema})` }
        }, 8000)
      } catch (e) {
        return { ok: false as const, message: friendlyConnectionError(e, settings, password) }
      }
    },

    async listSourceTables() {
      return run(async (d) => {
        const tables = await d.query<{ name: string; est: number | null }>(
          `SELECT t.table_name AS name, c.reltuples::bigint AS est
           FROM information_schema.tables t
           LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = t.table_schema
           LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = t.table_name
           WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE' AND t.table_name NOT LIKE 'ab\\_%'
           ORDER BY t.table_name`, [schema])
        const cols = await columnRows(d)
        const byTable = new Map<string, SourceColumn[]>()
        for (const r of cols) {
          const list = byTable.get(r.tbl) ?? []
          list.push(toSource(r))
          byTable.set(r.tbl, list)
        }
        const exact = tables.length <= 50
        const out: { source: string; columns: SourceColumn[]; rowCount?: number }[] = []
        for (const t of tables) {
          if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(t.name)) continue // names Appbuilder cannot address
          let rowCount = t.est === null || t.est === undefined || Number(t.est) < 0 ? undefined : Number(t.est)
          if (exact) {
            try { rowCount = Number((await d.query<{ n: number }>(`SELECT count(*)::bigint AS n FROM ${quoteId(schema)}.${quoteId(t.name)}`))[0].n) } catch { /* keep the estimate */ }
          }
          out.push({ source: t.name, columns: byTable.get(t.name) ?? [], rowCount })
        }
        return out
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

    ...ddlOps(undefined),
    ...dataOps(undefined),

    async transaction<T>(fn: (tx: Connector) => Promise<T>): Promise<T> {
      try {
        return await getDb().tx((t) => {
          // same connector, statements on the transaction's connection; nested transactions are savepoints
          const txc: Connector = { ...connector, ...dataOps(t), ...ddlOps(t), close: async () => {} }
          txc.transaction = <U>(inner: (tx: Connector) => Promise<U>) => t.tx(() => inner(txc))
          return fn(txc)
        })
      } catch (e) {
        throw isPgError(e) ? mapPgError(e, password) : e
      }
    },

    async close() {
      const d = own
      own = null
      if (d) await d.close()
    },
  }
  return connector
}

