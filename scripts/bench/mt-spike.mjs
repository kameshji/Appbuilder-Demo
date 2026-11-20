/**
 * Multi-tenancy spike (docs/plan/multi-tenancy-spec.md, "Measurements"). DEVELOPER TOOL, not part of the product.
 * It measures the two unknowns of the multi-tenancy phase on a sandbox PostgreSQL: the tenant data layout and what more
 * than one server process needs. Every database it creates is named ab_mt_* and is dropped by `drop`.
 *
 *   node scripts/bench/mt-spike.mjs layout-create  DB=ab_mt_layout TO=500 CONC=8 TABLES=8
 *        environment schemas through the product's own path (MetaStore.migrate(), migrateEnvironment +
 *        migrateEnvironmentSchema: environmentDdl, the upgrade steps, provisionSystemTables) plus TABLES maker tables each
 *        (createTableSql, the table designer's DDL). Incremental: run again with a larger TO.
 *   node scripts/bench/mt-spike.mjs layout-measure DB=ab_mt_layout
 *        catalogue size, cold connection + first query, backend memory after touching N schemas, a one-statement
 *        migration across all schemas, pg_dump of one schema and of everything, the job worker's per-environment tick.
 *   node scripts/bench/mt-spike.mjs shared  DB=ab_mt_shared TENANTS=1000 ROWS=1000
 *        the same queries on schema-per-tenant tables, on one shared table with tenant_id (enforced predicate) and with
 *        row-level security.
 *   node scripts/bench/mt-spike.mjs dbs N=20        database per tenant: CREATE DATABASE from a template, size, connections.
 *   node scripts/bench/mt-spike.mjs notify          LISTEN/NOTIFY latency, throughput, payload limit, reconnect, commit cost.
 *   node scripts/bench/mt-spike.mjs fair DB=ab_mt_jobs   job-claim fairness: FIFO versus a fair claim, N workers.
 *   node scripts/bench/mt-spike.mjs server DB=ab_mt_server PORT=5291   one product server: memory idle and after use.
 *   node scripts/bench/mt-spike.mjs fleet K=10 IDLE=60 [POLL=10000]   K installs (ports 5290+), one database and
 *        workspace each: start-up time, idle CPU of Node and PostgreSQL, memory, connections, disk per empty install.
 *   node scripts/bench/mt-spike.mjs roles           can one install's database role connect to another's database?
 *   node scripts/bench/mt-spike.mjs drop            drops every ab_mt_* database (prints sizes first).
 *
 * Connection: PG_HOST (127.0.0.1), PG_PORT (5435), PG_USER/PG_PASSWORD (abdev, owner of the databases), PG_SUPER/
 * PG_SUPER_PASSWORD (postgres; for memory views, roles and pg_terminate_backend). PG_BIN: folder of pg_dump.
 * Results are printed and written as JSON to OUT (default .sandbox/mt/<part>.json).
 * Numbers from a developer PC with fsync off are comparisons, not capacity figures.
 */
import pg from 'pg'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const E = process.env
const HOST = E.PG_HOST || '127.0.0.1'
const PORT = Number(E.PG_PORT || 5435)
if (PORT === 5433) { console.error('Refusing port 5433 (not a sandbox).'); process.exit(2) }
const USER = E.PG_USER || 'abdev'
const PASSWORD = E.PG_PASSWORD || 'abdev-sandbox-only'
const SUPER = E.PG_SUPER || 'postgres'
const SUPER_PASSWORD = E.PG_SUPER_PASSWORD || 'postgres-sandbox-only'
const PG_BIN = E.PG_BIN || path.join(root, '.sandbox/pg/pgsql/bin')
const part = process.argv[2]
const arg = (k, d) => (E[k] !== undefined && E[k] !== '' ? E[k] : d)
const OUT = arg('OUT', path.join(root, '.sandbox/mt', `${part}.json`))
const DBNAME = arg('DB', `ab_mt_${part === 'layout-create' || part === 'layout-measure' ? 'layout' : part}`)
if (!['drop', 'notify', 'dbs', 'fleet', 'roles'].includes(part) && !/^ab_mt_[a-z0-9_]+$/.test(DBNAME)) { console.error('DB must be named ab_mt_*'); process.exit(2) }

const imp = (p) => import(pathToFileURL(path.join(root, p)).href)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => performance.now()
const t0 = now()
const log = (m) => console.log(`[${((now() - t0) / 1000).toFixed(1)} s] ${m}`)
const result = { part, at: new Date().toISOString(), host: os.hostname() ? 'dev-pc' : '', cpus: os.cpus().length, cpu: os.cpus()[0]?.model, ramGB: Math.round(os.totalmem() / 2 ** 30), node: process.version, caveat: 'developer PC shared with other work, sandbox PostgreSQL 16 with fsync off: comparisons, not capacity figures' }
const save = () => { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)) }
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN }
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN }
const r1 = (x) => Math.round(x * 10) / 10

const cfg = (database, superuser = false) => ({ host: HOST, port: PORT, user: superuser ? SUPER : USER, password: superuser ? SUPER_PASSWORD : PASSWORD, database, options: '-c search_path=pg_catalog,pg_temp -c TimeZone=UTC -c jit=off', application_name: 'ab_mt_spike' })
async function client(database, superuser = false) { const c = new pg.Client(cfg(database, superuser)); await c.connect(); return c }
async function maint(sql, params = []) { const c = await client('postgres', true); try { return (await c.query(sql, params)).rows } finally { await c.end() } }
async function ensureDb(name) {
  const have = await maint('SELECT 1 FROM pg_database WHERE datname = $1', [name])
  if (!have.length) await maint(`CREATE DATABASE "${name}" OWNER "${USER}" ENCODING 'UTF8' TEMPLATE template0`)
}

/* ------------------------------------------------------------------ layout: create environments the product's way */

async function productModules() {
  const { createPgDb } = await imp('server/connectors/postgres/db.ts')
  const meta = await imp('server/core/meta-store.ts')
  const { createSecretBox } = await imp('server/core/secrets.ts')
  const { createTableSql } = await imp('server/connectors/postgres/sql.ts')
  return { createPgDb, ...meta, createSecretBox, createTableSql }
}

/** a typical maker table: 10 columns, a lookup, two indexed columns, a unique one */
function makerTable(i, prev) {
  const iso = new Date().toISOString()
  const cols = [
    { name: 'Title', displayName: 'Title', type: 'text', required: true },
    { name: 'Status', displayName: 'Status', type: 'choice', choices: ['Open', 'Done'], indexed: true },
    { name: 'Qty', displayName: 'Qty', type: 'number' },
    { name: 'Amount', displayName: 'Amount', type: 'currency' },
    { name: 'Due', displayName: 'Due', type: 'date', indexed: true },
    { name: 'Done', displayName: 'Done', type: 'boolean' },
    { name: 'Note', displayName: 'Note', type: 'multiline' },
    { name: 'Email', displayName: 'Email', type: 'email' },
    { name: 'Code', displayName: 'Code', type: 'text', unique: true },
  ]
  if (prev) cols.push({ name: 'Parent', displayName: 'Parent', type: 'lookup', lookupTable: prev })
  return { id: `tbl_m${i}`, name: `Maker${i}`, displayName: `Maker ${i}`, primaryColumn: 'Title', columns: cols, createdOn: iso, modifiedOn: iso, managed: true }
}

async function layoutCreate() {
  const TO = Number(arg('TO', 100))
  const CONC = Number(arg('CONC', 8))
  const TABLES = Number(arg('TABLES', 8))
  await ensureDb(DBNAME)
  const m = await productModules()
  const settings = { host: HOST, port: PORT, database: DBNAME, user: USER, ssl: false }
  const db = m.createPgDb(settings, PASSWORD, { max: CONC + 2 })
  const box = m.createSecretBox(Buffer.alloc(32, 7))
  const store = m.createMetaStore(db, box)
  let ta = now()
  const sum = await store.migrate()
  log(`MetaStore.migrate(): ${Math.round(now() - ta)} ms (${sum.steps.length} steps)`)
  const have = new Set((await db.query(`SELECT id FROM "ab"."environments"`)).map((r) => r.id))
  const ids = []
  for (let i = 1; i <= TO; i++) { const id = `t${String(i).padStart(5, '0')}`; if (!have.has(id)) ids.push(id) }
  log(`creating ${ids.length} environment schemas (have ${have.size}), ${TABLES} maker tables each, ${CONC} at once`)
  const times = []
  const tableTimes = []
  let next = 0
  let done = 0
  const tStart = now()
  async function one(id) {
    const a = now()
    await db.tx((tx) => m.migrateEnvironment(tx, { id, name: `Tenant ${id}`, type: 'production', state: 'ready' }))
    await m.migrateEnvironmentSchema(db, { id, schema: `env_${id}` })
    const b = now()
    if (TABLES) {
      await db.tx(async (tx) => {
        const d = { schema: `env_${id}`, icu: false }
        for (let i = 1; i <= TABLES; i++) for (const s of m.createTableSql(d, makerTable(i, i > 1 ? `Maker${i - 1}` : null))) await tx.exec(s)
      })
    }
    times.push(b - a)
    tableTimes.push(now() - b)
  }
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (next < ids.length) {
      const id = ids[next++]
      await one(id)
      if (++done % 250 === 0) log(`  ${done}/${ids.length} (${Math.round((now() - tStart) / done)} ms per environment wall, ${CONC} at once)`)
    }
  }))
  const total = (await db.query(`SELECT count(*)::int AS n FROM "ab"."environments"`))[0].n
  const r = { total, created: ids.length, wallMs: Math.round(now() - tStart), envMedianMs: r1(median(times)), envP95Ms: r1(pct(times, 0.95)), makerTablesMedianMs: r1(median(tableTimes)), conc: CONC, tablesPerEnv: TABLES }
  log(`created ${ids.length}: environment (metadata + system tables) median ${r.envMedianMs} ms, p95 ${r.envP95Ms} ms; ${TABLES} maker tables median ${r.makerTablesMedianMs} ms; wall ${r.wallMs} ms`)
  await db.close()
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { runs: [] }
  result.runs = [...(prev.runs ?? []), r]
  save()
}

/* ------------------------------------------------------------------ layout: measure */

async function catalogue(c) {
  const kinds = (await c.query(`SELECT relkind, count(*)::int AS n FROM pg_class GROUP BY relkind ORDER BY 1`)).rows
  const sizes = (await c.query(`SELECT c.relname, pg_total_relation_size(c.oid) AS b FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'pg_catalog' AND c.relkind = 'r' ORDER BY 2 DESC LIMIT 6`)).rows
  const cat = (await c.query(`SELECT sum(pg_total_relation_size(c.oid))::bigint AS b FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'pg_catalog'`)).rows[0].b
  const attrs = (await c.query(`SELECT count(*)::int AS n FROM pg_attribute`)).rows[0].n
  const schemas = (await c.query(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE 'env\\_%'`)).rows[0].n
  const dbSize = (await c.query(`SELECT pg_database_size(current_database())::bigint AS b`)).rows[0].b
  return { schemas, pgClass: Object.fromEntries(kinds.map((k) => [k.relkind, k.n])), pgClassRows: kinds.reduce((a, k) => a + k.n, 0), pgAttributeRows: attrs, catalogueMB: r1(Number(cat) / 2 ** 20), databaseMB: r1(Number(dbSize) / 2 ** 20), biggest: sizes.map((s) => `${s.relname} ${r1(Number(s.b) / 2 ** 20)} MB`) }
}

async function perEnvironmentShape(c, schema) {
  const rows = (await c.query(
    `SELECT c.relkind, CASE WHEN c.relname LIKE 'ab\\_%' THEN 'metadata' WHEN c.relname LIKE 'sys\\_%' THEN 'system' ELSE 'other' END AS grp, count(*)::int AS n
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 GROUP BY 1, 2 ORDER BY 2, 1`, [schema])).rows
  const total = rows.reduce((a, r) => a + r.n, 0)
  const tables = (await c.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1`, [schema])).rows[0].n
  const views = (await c.query(`SELECT count(*)::int AS n FROM pg_views WHERE schemaname = $1`, [schema])).rows[0].n
  const seq = (await c.query(`SELECT count(*)::int AS n FROM pg_sequences WHERE schemaname = $1`, [schema])).rows[0].n
  const idx = (await c.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = $1`, [schema])).rows[0].n
  const metaTables = (await c.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'ab\\_%'`, [schema])).rows[0].n
  const sysTables = (await c.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'sys\\_%'`, [schema])).rows[0].n
  const attrs = (await c.query(`SELECT count(*)::int AS n FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1`, [schema])).rows[0].n
  return { schema, pgClassRows: total, tables, metadataTables: metaTables, systemTables: sysTables, makerTables: tables - metaTables - sysTables, views, indexes: idx, sequences: seq, pgAttributeRows: attrs, byGroup: rows }
}

function pgDump(args) {
  return new Promise((resolve) => {
    const a = now()
    const p = spawn(path.join(PG_BIN, process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump'), args, { env: { ...E, PGPASSWORD: PASSWORD }, stdio: ['ignore', 'pipe', 'pipe'] })
    let bytes = 0
    let err = ''
    p.stdout.on('data', (d) => { bytes += d.length })
    p.stderr.on('data', (d) => { err += d })
    p.on('exit', (code) => resolve({ code, ms: Math.round(now() - a), MB: r1(bytes / 2 ** 20), error: err.trim().split('\n').slice(-2).join(' ').slice(0, 300) }))
  })
}

async function layoutMeasure() {
  const c = await client(DBNAME)
  const schemas = (await c.query(`SELECT schema_name AS s FROM "ab"."environments" ORDER BY id`)).rows.map((r) => r.s)
  const N = schemas.length
  log(`${N} environment schemas`)
  result.N = N
  result.catalogue = await catalogue(c)
  result.oneEnvironment = await perEnvironmentShape(c, schemas[Math.min(1, N - 1)])
  result.defaultEnvironment = await perEnvironmentShape(c, 'env_default')
  log(`catalogue: ${JSON.stringify(result.catalogue)}`)
  log(`one environment: ${JSON.stringify(result.oneEnvironment)}`)

  // cold connection + first query on a random schema: connect, then read its ab_tables and a maker table
  const cold = []
  for (let i = 0; i < 20; i++) {
    const s = schemas[Math.floor(Math.random() * N)]
    const a = now()
    const k = await client(DBNAME)
    const b = now()
    await k.query(`SELECT id, name FROM "${s}"."ab_tables" LIMIT 5`)
    const cq = now()
    await k.query(`SELECT count(*) FROM "${s}"."t_maker1"`).catch(() => null)
    const d = now()
    cold.push({ connect: b - a, first: cq - b, second: d - cq })
    await k.end()
  }
  result.coldConnection = { connectMs: r1(median(cold.map((x) => x.connect))), firstQueryMs: r1(median(cold.map((x) => x.first))), firstQueryP95Ms: r1(pct(cold.map((x) => x.first), 0.95)), secondTableMs: r1(median(cold.map((x) => x.second))) }
  log(`cold connection: ${JSON.stringify(result.coldConnection)}`)

  // backend memory after touching K schemas (the catalogue caches of one pooled connection)
  const sup = await client(DBNAME, true)
  const mem = async () => Number((await sup.query(`SELECT sum(total_bytes)::bigint AS b FROM pg_backend_memory_contexts`)).rows[0].b)
  const cache = async () => Number((await sup.query(`SELECT coalesce(sum(total_bytes),0)::bigint AS b FROM pg_backend_memory_contexts WHERE name = 'CacheMemoryContext' OR parent = 'CacheMemoryContext'`)).rows[0].b)
  const memRows = [{ schemas: 0, backendMB: r1((await mem()) / 2 ** 20), cacheMB: r1((await cache()) / 2 ** 20) }]
  const steps = [10, 100, 500, 1000, 2000, 5000].filter((k) => k <= N)
  let touched = 0
  const touchTimes = []
  for (const k of steps) {
    const a = now()
    for (; touched < k; touched++) {
      const s = schemas[touched]
      // what a request does in an environment: roles, tables, a data page
      await sup.query(`SELECT * FROM "${s}"."ab_roles"`)
      await sup.query(`SELECT * FROM "${s}"."ab_tables"`)
      await sup.query(`SELECT * FROM "${s}"."t_maker1" ORDER BY "createdOn" LIMIT 50`).catch(() => null)
    }
    touchTimes.push({ k, msPerSchema: r1((now() - a) / Math.max(1, k - (memRows.at(-1).schemas))) })
    memRows.push({ schemas: k, backendMB: r1((await mem()) / 2 ** 20), cacheMB: r1((await cache()) / 2 ** 20) })
    log(`  backend after ${k} schemas: ${JSON.stringify(memRows.at(-1))}`)
  }
  result.backendMemory = memRows
  result.touch = touchTimes

  // the job worker's tick: per environment, the claim's GROUP BY plus the reaper and scheduler queries (empty queues)
  const k2 = await client(DBNAME)
  const a2 = now()
  for (const s of schemas) {
    await k2.query(`SELECT type, count(*)::int AS n FROM "${s}"."ab_jobs" WHERE state IN ('queued', 'failed') AND run_at <= now() GROUP BY type`)
    await k2.query(`SELECT id FROM "${s}"."ab_jobs" WHERE state = 'running' AND heartbeat_at < now() - interval '30 seconds' LIMIT 50`)
    await k2.query(`SELECT id FROM "${s}"."ab_schedules" WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= now() LIMIT 50`)
    await k2.query(`SELECT id FROM "${s}"."ab_outbox" WHERE dispatched_on IS NULL ORDER BY id LIMIT 100`)
  }
  result.workerTick = { schemas: N, msPerTick: Math.round(now() - a2), msPerSchema: r1((now() - a2) / N), note: 'four statements per environment per tick, empty queues, one connection; the product ticks every 1 s (poll) and on every NOTIFY' }
  log(`worker tick over every environment: ${JSON.stringify(result.workerTick)}`)
  await k2.end()

  // one-statement migration across all schemas (the ENVIRONMENT_STEPS pattern: one transaction per environment)
  const k3 = await client(DBNAME)
  const a3 = now()
  let fails = 0
  for (const s of schemas) {
    try {
      await k3.query('BEGIN')
      await k3.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`appbuilder.migrate.${s}`])
      await k3.query(`ALTER TABLE "${s}"."ab_apps" ADD COLUMN IF NOT EXISTS mt_spike_col text NULL`)
      await k3.query(`UPDATE "ab"."environments" SET schema_version = schema_version WHERE schema_name = $1`, [s])
      await k3.query('COMMIT')
    } catch { fails++; await k3.query('ROLLBACK').catch(() => {}) }
  }
  result.migrationAll = { schemas: N, totalMs: Math.round(now() - a3), msPerSchema: r1((now() - a3) / N), failures: fails }
  log(`one-statement migration over every schema: ${JSON.stringify(result.migrationAll)}`)
  // the same with the product's full environment pass (environmentDdl + provisionSystemTables) on a sample: what a server
  // start costs today per environment (migrateEnvironmentSchema at the current version)
  const m = await productModules()
  const db = m.createPgDb({ host: HOST, port: PORT, database: DBNAME, user: USER, ssl: false }, PASSWORD, { max: 4 })
  const sample = schemas.slice(0, Math.min(50, N))
  const a4 = now()
  for (const s of sample) await m.migrateEnvironmentSchema(db, { id: s.slice(4), schema: s })
  result.bootPassPerEnvironment = { sample: sample.length, msPerSchema: r1((now() - a4) / sample.length), projectedAllSeconds: Math.round(((now() - a4) / sample.length) * N / 1000), note: 'today every server start runs migrateEnvironmentSchema for every environment, serially' }
  log(`boot pass per environment: ${JSON.stringify(result.bootPassPerEnvironment)}`)
  await db.close()
  await k3.query(`SELECT 1`)
  await k3.end()

  // autovacuum / analyze state
  const av = (await sup.query(`SELECT count(*)::int AS tables, count(*) FILTER (WHERE last_autoanalyze IS NULL AND last_analyze IS NULL)::int AS never_analyzed, count(*) FILTER (WHERE last_autovacuum IS NOT NULL)::int AS autovacuumed FROM pg_stat_user_tables`)).rows[0]
  const workers = (await sup.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE backend_type = 'autovacuum worker'`)).rows[0].n
  const settings = (await sup.query(`SELECT name, setting FROM pg_settings WHERE name IN ('autovacuum_naptime','autovacuum_max_workers','max_locks_per_transaction','max_connections','shared_buffers')`)).rows
  result.autovacuum = { ...av, workersNow: workers, settings: Object.fromEntries(settings.map((s) => [s.name, s.setting])) }
  log(`autovacuum: ${JSON.stringify(result.autovacuum)}`)

  // pg_dump: one schema, and the whole database (pg_dump locks every table it dumps in one transaction)
  const base = ['-h', HOST, '-p', String(PORT), '-U', USER, '-d', DBNAME, '-Fc', '-Z', '0']
  result.pgDumpOne = await pgDump([...base, '-n', schemas[Math.min(1, N - 1)]])
  log(`pg_dump one schema: ${JSON.stringify(result.pgDumpOne)}`)
  result.pgDumpOneOfMany = { ...result.pgDumpOne, note: 'pg_dump reads the whole catalogue even for one schema' }
  if (arg('DUMP_ALL', '1') === '1') {
    result.pgDumpAll = await pgDump(base)
    log(`pg_dump everything: ${JSON.stringify(result.pgDumpAll)}`)
  }
  await sup.end()
  await c.end()
  save()
}

/* ------------------------------------------------------------------ shared table with tenant_id versus schema per tenant */

async function shared() {
  const TENANTS = Number(arg('TENANTS', 1000))
  const ROWS = Number(arg('ROWS', 1000))
  const RUNS = Number(arg('RUNS', 300))
  await ensureDb(DBNAME)
  const sup = await client(DBNAME, true)
  await sup.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ab_mt_app') THEN CREATE ROLE ab_mt_app LOGIN PASSWORD 'ab-mt-sandbox-only'; END IF; END $$`)
  const c = await client(DBNAME)
  const built = (await c.query(`SELECT to_regclass('shared.t_orders') IS NOT NULL AS ok`)).rows[0].ok
  if (!built) {
    log(`building: ${TENANTS} schemas with t_orders of ${ROWS} rows, and shared.t_orders with ${TENANTS * ROWS} rows`)
    const cols = `"id" text NOT NULL, "createdOn" timestamptz(3), "modifiedOn" timestamptz(3), "createdBy" text, "owner" text, "Title" text, "Status" text, "Qty" double precision, "Amount" numeric(19,4)`
    await c.query(`CREATE SCHEMA shared`)
    await c.query(`CREATE TABLE shared.t_orders (tenant_id text NOT NULL, ${cols}, PRIMARY KEY (tenant_id, "id"))`)
    const gen = (t) => `SELECT md5('${t}' || g)::text, now() - (g || ' minutes')::interval, now(), 'u' || (g % 20), 'u' || (g % 20), 'Order ' || g, CASE WHEN g % 3 = 0 THEN 'Open' ELSE 'Done' END, g % 50, (g % 1000) * 1.5 FROM generate_series(1, ${ROWS}) g`
    for (let t = 1; t <= TENANTS; t++) {
      const s = `s_t${String(t).padStart(5, '0')}`
      await c.query(`CREATE SCHEMA ${s}`)
      await c.query(`CREATE TABLE ${s}.t_orders (${cols}, PRIMARY KEY ("id"))`)
      await c.query(`INSERT INTO ${s}.t_orders ${gen(s)}`)
      await c.query(`CREATE INDEX ix_${s}_created ON ${s}.t_orders ("createdOn", "id")`)
      await c.query(`CREATE INDEX ix_${s}_status ON ${s}.t_orders ("Status")`)
      await c.query(`CREATE INDEX ix_${s}_owner ON ${s}.t_orders ("owner")`)
      await c.query(`INSERT INTO shared.t_orders SELECT '${s}', * FROM (${gen(s)}) x`)
      if (t % 200 === 0) log(`  ${t}/${TENANTS}`)
    }
    await c.query(`CREATE INDEX ix_shared_created ON shared.t_orders (tenant_id, "createdOn", "id")`)
    await c.query(`CREATE INDEX ix_shared_status ON shared.t_orders (tenant_id, "Status")`)
    await c.query(`CREATE INDEX ix_shared_owner ON shared.t_orders (tenant_id, "owner")`)
    await c.query(`ANALYZE`)
    await c.query(`ALTER TABLE shared.t_orders ENABLE ROW LEVEL SECURITY`)
    await c.query(`CREATE POLICY tenant ON shared.t_orders USING (tenant_id = current_setting('ab.tenant', true))`)
    await c.query(`GRANT USAGE ON SCHEMA shared TO ab_mt_app`)
    await c.query(`GRANT SELECT ON shared.t_orders TO ab_mt_app`)
  }
  const rls = new pg.Client({ ...cfg(DBNAME), user: 'ab_mt_app', password: 'ab-mt-sandbox-only' })
  await rls.connect()
  const tenants = Array.from({ length: TENANTS }, (_, i) => `s_t${String(i + 1).padStart(5, '0')}`)
  const pick = () => tenants[Math.floor(Math.random() * TENANTS)]
  const QUERIES = {
    page: (from, where) => `SELECT * FROM ${from} WHERE ${where} AND "owner" = 'u3' ORDER BY "createdOn", "id" LIMIT 50`,
    count: (from, where) => `SELECT count(*) FROM ${from} WHERE ${where} AND "Status" = 'Open'`,
    aggregate: (from, where) => `SELECT "Status", sum("Amount"), count(*) FROM ${from} WHERE ${where} GROUP BY "Status"`,
    point: (from, where) => `SELECT * FROM ${from} WHERE ${where} AND "id" = md5('x' || 1)`,
  }
  const out = {}
  for (const [name, q] of Object.entries(QUERIES)) {
    const res = { schema: [], predicate: [], rls: [] }
    for (let i = 0; i < RUNS; i++) {
      const t = pick()
      let a = now(); await c.query(q(`${t}.t_orders`, 'TRUE')); res.schema.push(now() - a)
      a = now(); await c.query(q('shared.t_orders', 'tenant_id = $1'), [t]); res.predicate.push(now() - a)
      a = now()
      await rls.query('BEGIN'); await rls.query(`SELECT set_config('ab.tenant', $1, true)`, [t]); await rls.query(q('shared.t_orders', 'TRUE')); await rls.query('COMMIT')
      res.rls.push(now() - a)
    }
    out[name] = Object.fromEntries(Object.entries(res).map(([k, v]) => [k, { medianMs: r1(median(v.slice(20))), p95Ms: r1(pct(v.slice(20), 0.95)) }]))
    log(`${name}: ${JSON.stringify(out[name])}`)
  }
  // isolation check of RLS without the setting: nothing is visible (fail closed)
  const leak = (await rls.query(`SELECT count(*)::int AS n FROM shared.t_orders`)).rows[0].n
  const sizes = (await c.query(`SELECT pg_total_relation_size('shared.t_orders')::bigint AS shared, (SELECT sum(pg_total_relation_size(c.oid)) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname LIKE 's\\_t%' AND c.relkind IN ('r'))::bigint AS per_schema`)).rows[0]
  result.shared = { tenants: TENANTS, rowsPerTenant: ROWS, runs: RUNS, queries: out, rlsWithoutSettingRows: leak, sizesMB: { shared: r1(Number(sizes.shared) / 2 ** 20), perSchemaTotal: r1(Number(sizes.per_schema) / 2 ** 20) }, note: 'RLS timing includes BEGIN/set_config/COMMIT round trips (3 extra), which is what a pooled connection needs' }
  await rls.end(); await c.end(); await sup.end()
  save()
}

/* ------------------------------------------------------------------ database per tenant */

async function dbs() {
  const N = Number(arg('N', 20))
  // a template that holds one environment schema built by the product
  const tpl = 'ab_mt_tpl'
  await ensureDb(tpl)
  const m = await productModules()
  const tdb = m.createPgDb({ host: HOST, port: PORT, database: tpl, user: USER, ssl: false }, PASSWORD, { max: 2 })
  await m.createMetaStore(tdb, m.createSecretBox(Buffer.alloc(32, 7))).migrate()
  await tdb.close()
  const times = []
  for (let i = 1; i <= N; i++) {
    const name = `ab_mt_db${String(i).padStart(4, '0')}`
    await maint(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    const a = now()
    await maint(`CREATE DATABASE "${name}" OWNER "${USER}" TEMPLATE "${tpl}"`)
    times.push(now() - a)
  }
  const size = (await maint(`SELECT pg_database_size('ab_mt_db0001')::bigint AS b, pg_database_size('${tpl}')::bigint AS t`))[0]
  // one connection per tenant database: what it costs to open and use
  const conns = []
  const a = now()
  for (let i = 1; i <= N; i++) { const k = new pg.Client(cfg(`ab_mt_db${String(i).padStart(4, '0')}`)); await k.connect(); await k.query('SELECT count(*) FROM "env_default"."ab_tables"'); conns.push(k) }
  const openMs = (now() - a) / N
  const maxConn = Number((await maint(`SHOW max_connections`))[0].max_connections)
  for (const k of conns) await k.end()
  result.dbs = { created: N, createMedianMs: r1(median(times)), createP95Ms: r1(pct(times, 0.95)), sizeMBEach: r1(Number(size.b) / 2 ** 20), templateMB: r1(Number(size.t) / 2 ** 20), openAndFirstQueryMs: r1(openMs), maxConnections: maxConn, note: 'every database needs its own connections: a pool cannot be shared across databases' }
  log(JSON.stringify(result.dbs))
  save()
}

/* ------------------------------------------------------------------ LISTEN / NOTIFY */

async function notify() {
  await ensureDb('ab_mt_notify')
  const out = { latency: [], payload: {}, reconnect: {}, commitCost: {} }
  for (const L of [1, 4, 8]) {
    for (const rate of [200, 2000]) {
      const listeners = []
      const lat = []
      let got = 0
      for (let i = 0; i < L; i++) {
        const k = await client('ab_mt_notify')
        await k.query('LISTEN ab_mt')
        k.on('notification', (n) => { got++; const at = Number(n.payload.split('|')[0]); lat.push(now() - at) })
        listeners.push(k)
      }
      const sender = await client('ab_mt_notify')
      const seconds = 3
      const total = rate * seconds
      const a = now()
      // paced sends: one NOTIFY per statement (autocommit), like a commit carrying one notification
      let sent = 0
      while (sent < total) {
        const target = Math.floor(((now() - a) / 1000) * rate)
        const batch = []
        while (sent < Math.min(target, total)) { batch.push(sender.query(`SELECT pg_notify('ab_mt', $1)`, [`${now()}|env:t${sent % 1000}|table:x|seq:${sent}`])); sent++ }
        await Promise.all(batch)
        if (sent < total) await sleep(2)
      }
      const sendMs = now() - a
      for (let i = 0; i < 100 && got < total * L; i++) await sleep(20)
      out.latency.push({ listeners: L, targetPerSecond: rate, achievedPerSecond: Math.round(total / (sendMs / 1000)), delivered: got, expected: total * L, p50Ms: r1(pct(lat, 0.5)), p95Ms: r1(pct(lat, 0.95)), p99Ms: r1(pct(lat, 0.99)) })
      log(`notify ${JSON.stringify(out.latency.at(-1))}`)
      for (const k of listeners) await k.end()
      await sender.end()
    }
  }
  // payload limit (8000 bytes by default)
  const s = await client('ab_mt_notify')
  for (const n of [7999, 8000, 9000]) {
    try { await s.query(`SELECT pg_notify('ab_mt', $1)`, ['x'.repeat(n)]); out.payload[n] = 'ok' } catch (e) { out.payload[n] = e.message }
  }
  log(`payload: ${JSON.stringify(out.payload)}`)
  // reconnect: notifications sent while a listener is disconnected are lost (no durability)
  const sup = await client('ab_mt_notify', true)
  const k = await client('ab_mt_notify')
  await k.query('LISTEN ab_mt')
  let seen = 0
  k.on('notification', () => { seen++ })
  k.on('error', () => {})
  const pid = (await k.query('SELECT pg_backend_pid() AS p')).rows[0].p
  await sup.query('SELECT pg_terminate_backend($1)', [pid])
  for (let i = 0; i < 100; i++) await s.query(`SELECT pg_notify('ab_mt', 'gap')`)
  const k2 = await client('ab_mt_notify')
  await k2.query('LISTEN ab_mt')
  let seen2 = 0
  k2.on('notification', () => { seen2++ })
  await sleep(300)
  out.reconnect = { sentWhileDown: 100, receivedByOldListener: seen, receivedByNewListener: seen2, note: 'NOTIFY is not durable: a reconnecting process must catch up from a table (the outbox id), as the live client already does with seq/resync' }
  log(`reconnect: ${JSON.stringify(out.reconnect)}`)
  await k2.end(); await sup.end()
  // commit cost: N parallel writers, transactions with and without a NOTIFY (PostgreSQL serialises commits that notify)
  await s.query(`CREATE TABLE IF NOT EXISTS public.w (id bigserial PRIMARY KEY, v text)`)
  for (const W of [1, 8, 16]) {
    for (const withNotify of [false, true]) {
      const ws = await Promise.all(Array.from({ length: W }, () => client('ab_mt_notify')))
      const per = 300
      const a = now()
      await Promise.all(ws.map(async (w) => {
        for (let i = 0; i < per; i++) {
          await w.query('BEGIN')
          await w.query(`INSERT INTO public.w (v) VALUES ('x')`)
          if (withNotify) await w.query(`SELECT pg_notify('ab_mt', 'tenant:x')`)
          await w.query('COMMIT')
        }
      }))
      const tps = Math.round((W * per) / ((now() - a) / 1000))
      out.commitCost[`${W} writers${withNotify ? ' + NOTIFY' : ''}`] = tps
      for (const w of ws) await w.end()
    }
  }
  log(`commits per second: ${JSON.stringify(out.commitCost)}`)
  await s.end()
  result.notify = out
  save()
}

/* ------------------------------------------------------------------ job fairness */

async function fair() {
  await ensureDb(DBNAME)
  const c = await client(DBNAME)
  await c.query(`DROP TABLE IF EXISTS public.jobs`)
  await c.query(`CREATE TABLE public.jobs (id bigserial PRIMARY KEY, tenant_id text NOT NULL, state text NOT NULL DEFAULT 'queued', priority int NOT NULL DEFAULT 0, run_at timestamptz NOT NULL DEFAULT now(), locked_by text, started_on timestamptz, finished_on timestamptz, created_on timestamptz NOT NULL DEFAULT clock_timestamp())`)
  await c.query(`CREATE INDEX jobs_ready ON public.jobs (tenant_id, priority DESC, run_at, id) WHERE state = 'queued'`)
  await c.query(`CREATE INDEX jobs_fifo ON public.jobs (priority DESC, run_at, id) WHERE state = 'queued'`)
  await c.query(`CREATE INDEX jobs_running ON public.jobs (tenant_id) WHERE state = 'running'`)
  const WORKERS = Number(arg('WORKERS', 8))
  const BIG = Number(arg('BIG', 10000))
  const SMALL_TENANTS = Number(arg('SMALL', 200))
  const SMALL_JOBS = Number(arg('SMALLJOBS', 5))
  const JOB_MS = Number(arg('JOBMS', 5))
  const BATCH = Number(arg('BATCH', 4))
  const CAP = Number(arg('CAP', 2))
  const claims = {
    // today's shape, one shared table: oldest first
    fifo: `UPDATE public.jobs SET state = 'running', locked_by = $1, started_on = clock_timestamp()
           WHERE id IN (SELECT id FROM public.jobs WHERE state = 'queued' AND run_at <= now() ORDER BY priority DESC, run_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
           RETURNING id, tenant_id`,
    // fair: walk the distinct tenants that have ready jobs (loose index scan), skip tenants already at their running cap,
    // take the oldest ready job of each, oldest tenant-head first, then lock with SKIP LOCKED
    fair: `WITH RECURSIVE t AS (
             (SELECT tenant_id FROM public.jobs WHERE state = 'queued' AND run_at <= now() ORDER BY tenant_id LIMIT 1)
             UNION ALL
             SELECT (SELECT j.tenant_id FROM public.jobs j WHERE j.state = 'queued' AND j.run_at <= now() AND j.tenant_id > t.tenant_id ORDER BY j.tenant_id LIMIT 1)
             FROM t WHERE t.tenant_id IS NOT NULL
           ), heads AS (
             SELECT h.id, h.run_at FROM t
             CROSS JOIN LATERAL (SELECT j.id, j.run_at FROM public.jobs j WHERE j.tenant_id = t.tenant_id AND j.state = 'queued' AND j.run_at <= now()
                                 ORDER BY j.priority DESC, j.run_at, j.id LIMIT 1) h
             WHERE t.tenant_id IS NOT NULL
               AND (SELECT count(*) FROM public.jobs r WHERE r.tenant_id = t.tenant_id AND r.state = 'running') < $3
             ORDER BY h.run_at, h.id LIMIT $2
           )
           UPDATE public.jobs SET state = 'running', locked_by = $1, started_on = clock_timestamp()
           WHERE id IN (SELECT id FROM public.jobs WHERE id IN (SELECT id FROM heads) AND state = 'queued' FOR UPDATE SKIP LOCKED)
           RETURNING id, tenant_id`,
  }
  const out = {}
  for (const mode of ['fifo', 'fair']) {
    await c.query(`TRUNCATE public.jobs RESTART IDENTITY`)
    // the big tenant enqueues first (a bulk run), then the small tenants
    await c.query(`INSERT INTO public.jobs (tenant_id, created_on) SELECT 'big', clock_timestamp() FROM generate_series(1, ${BIG})`)
    await c.query(`INSERT INTO public.jobs (tenant_id, created_on) SELECT 'small' || lpad((g % ${SMALL_TENANTS})::text, 4, '0'), clock_timestamp() FROM generate_series(1, ${SMALL_TENANTS * SMALL_JOBS}) g`)
    await c.query('ANALYZE public.jobs')
    const ws = await Promise.all(Array.from({ length: WORKERS }, () => client(DBNAME)))
    const claimMs = []
    const a = now()
    let smallDoneAt = null
    const isSmallLeft = async () => (await c.query(`SELECT count(*)::int AS n FROM public.jobs WHERE tenant_id <> 'big' AND state <> 'done'`)).rows[0].n
    const deadline = a + Number(arg('LIMITMS', 120000))
    await Promise.all(ws.map(async (w, i) => {
      while (now() < deadline) {
        const b = now()
        const got = (await w.query(claims[mode], mode === 'fair' ? [`w${i}`, BATCH, CAP] : [`w${i}`, BATCH])).rows
        claimMs.push(now() - b)
        if (!got.length) {
          if ((await w.query(`SELECT count(*)::int AS n FROM public.jobs WHERE state IN ('queued','running')`)).rows[0].n === 0) return
          await sleep(5)
          continue
        }
        await sleep(JOB_MS * got.length) // the job's work
        await w.query(`UPDATE public.jobs SET state = 'done', finished_on = clock_timestamp() WHERE id = ANY($1)`, [got.map((g) => g.id)])
        if (smallDoneAt === null && got.some((g) => g.tenant_id !== 'big') && (await isSmallLeft()) === 0) smallDoneAt = now()
      }
    }))
    const waits = (await c.query(`SELECT tenant_id <> 'big' AS small, extract(epoch FROM (started_on - created_on)) * 1000 AS w FROM public.jobs WHERE started_on IS NOT NULL`)).rows
    const sw = waits.filter((x) => x.small).map((x) => Number(x.w))
    const bw = waits.filter((x) => !x.small).map((x) => Number(x.w))
    out[mode] = { workers: WORKERS, bigJobs: BIG, smallTenants: SMALL_TENANTS, smallJobsEach: SMALL_JOBS, jobMs: JOB_MS, batch: BATCH, capPerTenant: mode === 'fair' ? CAP : null, smallStarted: sw.length, smallWaitP50Ms: Math.round(pct(sw, 0.5)), smallWaitP95Ms: Math.round(pct(sw, 0.95)), smallWaitMaxMs: Math.round(Math.max(...sw)), allSmallDoneMs: smallDoneAt ? Math.round(smallDoneAt - a) : null, bigStarted: bw.length, claimMedianMs: r1(median(claimMs)), claimP95Ms: r1(pct(claimMs, 0.95)), wallMs: Math.round(now() - a) }
    log(`${mode}: ${JSON.stringify(out[mode])}`)
    for (const w of ws) await w.end()
  }
  // the fair claim's cost with many tenants having ready jobs
  await c.query(`TRUNCATE public.jobs RESTART IDENTITY`)
  await c.query(`INSERT INTO public.jobs (tenant_id) SELECT 't' || lpad((g % 2000)::text, 5, '0') FROM generate_series(1, 20000) g`)
  await c.query(`INSERT INTO public.jobs (tenant_id) SELECT 'big' FROM generate_series(1, 50000)`)
  await c.query('ANALYZE public.jobs')
  const cm = []
  for (let i = 0; i < 30; i++) {
    const b = now()
    await c.query('BEGIN')
    await c.query(claims.fair, ['probe', 8, CAP])
    await c.query('ROLLBACK')
    cm.push(now() - b)
  }
  out.fairClaimCost = { readyTenants: 2001, queued: 70000, medianMs: r1(median(cm)), p95Ms: r1(pct(cm, 0.95)), note: 'the loose index scan visits every tenant with ready jobs; at more than a few thousand ready tenants a tenant-head table (one row per tenant with ready work) is cheaper' }
  log(`fair claim cost: ${JSON.stringify(out.fairClaimCost)}`)
  await c.end()
  result.fair = out
  save()
}

/* ------------------------------------------------------------------ one product server: memory and connections */

function rssOf(pid) {
  try {
    if (process.platform === 'win32') {
      const o = execFileSync('powershell.exe', ['-NoProfile', '-Command', `$p = Get-Process -Id ${pid}; "$($p.WorkingSet64) $($p.PrivateMemorySize64)"`], { encoding: 'utf8' }).trim().split(/\s+/)
      return { workingSetMB: r1(Number(o[0]) / 2 ** 20), privateMB: r1(Number(o[1]) / 2 ** 20) }
    }
    const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
    return { workingSetMB: r1(Number(/VmRSS:\s+(\d+)/.exec(s)[1]) / 1024) }
  } catch (e) { return { error: e.message } }
}

async function server() {
  const port = Number(arg('PORT', 5291))
  if (port < 5290 || port > 5299) { console.error('PORT must be 5290-5299'); process.exit(2) }
  await maint(`DROP DATABASE IF EXISTS "${DBNAME}" WITH (FORCE)`)
  await maint(`CREATE DATABASE "${DBNAME}" OWNER "${USER}" ENCODING 'UTF8' TEMPLATE template0`)
  const ws = path.join(root, '.sandbox/mt/ws-server')
  fs.rmSync(ws, { recursive: true, force: true })
  let out = ''
  const child = spawn(process.execPath, ['server/main.ts'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...E, APPBUILDER_DB_HOST: HOST, APPBUILDER_DB_PORT: String(PORT), APPBUILDER_DB_NAME: DBNAME, APPBUILDER_DB_USER: USER, APPBUILDER_DB_PASSWORD: PASSWORD, APPBUILDER_WORKSPACE: ws, PORT: String(port), APPBUILDER_HOST: '127.0.0.1', APPBUILDER_MIGRATION_BACKUP: 'skip' },
  })
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  try {
    for (let i = 0; i < 240 && !/is running at/.test(out); i++) { if (child.exitCode !== null) throw new Error(out); await sleep(250) }
    if (!/is running at/.test(out)) throw new Error(`did not start:\n${out}`)
    await sleep(3000)
    const BASE = `http://127.0.0.1:${port}`
    const jar = new Map()
    const api = async (method, p, body, o = {}) => {
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
      const headers = { 'X-Appbuilder': '1', ...(cookie ? { Cookie: cookie } : {}), ...(o.env ? { 'X-Appbuilder-Environment': o.env } : {}) }
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      const res = await fetch(BASE + '/api/v1' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
      for (const ck of res.headers.getSetCookie()) { const [pair] = ck.split(';'); const i = pair.indexOf('='); const v = pair.slice(i + 1); if (v) jar.set(pair.slice(0, i), v); else jar.delete(pair.slice(0, i)) }
      const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text()
      return { status: res.status, data }
    }
    const conns = async () => (await maint(`SELECT count(*)::int AS n, count(*) FILTER (WHERE state = 'idle')::int AS idle FROM pg_stat_activity WHERE datname = $1`, [DBNAME]))[0]
    result.idle = { ...rssOf(child.pid), dbConnections: await conns() }
    log(`idle: ${JSON.stringify(result.idle)}`)
    const setupCode = (/SETUP CODE:\s+([A-Z0-9-]+)/.exec(out)?.[1] ?? '').replace(/-/g, '')
    const ADMIN = { name: 'Spike Admin', email: 'spike@example.test', password: 'Spike-Example-Pass-2026' }
    const s1 = await api('POST', '/setup/admin', { setupCode, ...ADMIN })
    const s2 = await api('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password })
    if (s2.status !== 200) throw new Error(`sign-in ${s1.status} ${s2.status} ${JSON.stringify(s2.data).slice(0, 200)}`)
    // typical use: tables, rows, queries, an app, a few environments
    const t = await api('POST', '/tables', { displayName: 'Orders', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Qty', type: 'number' }, { displayName: 'Status', type: 'text', indexed: true }] })
    const tid = t.data.id
    const writes = []
    for (let i = 0; i < 500; i++) writes.push(api('POST', `/data/${tid}/rows`, { values: { Title: `Order ${i}`, Qty: i % 17, Status: i % 3 ? 'Done' : 'Open' } }))
    for (let i = 0; i < writes.length; i += 25) await Promise.all(writes.slice(i, i + 25))
    const lat = []
    for (let i = 0; i < 300; i++) {
      const a = now()
      await api('POST', '/query', { plan: { version: 2, table: 'Orders', filter: { col: 'Status', op: 'eq', value: 'Open' }, count: true, page: { size: 50 } } })
      lat.push(now() - a)
    }
    for (let i = 0; i < 3; i++) await api('POST', '/environments', { name: `Spike env ${i}`, type: 'sandbox' })
    await sleep(2000)
    result.afterUse = { ...rssOf(child.pid), dbConnections: await conns(), queryMedianMs: r1(median(lat)), queryP95Ms: r1(pct(lat, 0.95)), did: '1 table, 500 row writes (25 at once), 300 Query v2 pages with exact count, 3 environments' }
    log(`after use: ${JSON.stringify(result.afterUse)}`)
    // concurrency: 50 parallel queries: does the pool of 10 queue?
    const par = []
    const a = now()
    await Promise.all(Array.from({ length: 50 }, async () => { const b = now(); await api('POST', '/query', { plan: { version: 2, table: 'Orders', count: true, page: { size: 50 } } }); par.push(now() - b) }))
    result.parallel50 = { wallMs: Math.round(now() - a), medianMs: r1(median(par)), p95Ms: r1(pct(par, 0.95)), dbConnectionsAfter: await conns(), ...rssOf(child.pid) }
    log(`50 parallel queries: ${JSON.stringify(result.parallel50)}`)
  } finally {
    child.kill('SIGTERM')
    for (let i = 0; i < 80 && child.exitCode === null; i++) await sleep(100)
    if (child.exitCode === null) child.kill('SIGKILL')
    save()
  }
}

/* ------------------------------------------------------------------ a fleet of installs: K servers, one database each */

function cpuSeconds(pids) {
  if (!pids.length) return {}
  if (process.platform !== 'win32') return Object.fromEntries(pids.map((p) => { try { const f = fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(' '); return [p, (Number(f[13]) + Number(f[14])) / 100] } catch { return [p, NaN] } }))
  const o = execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.TotalProcessorTime.TotalSeconds) $($_.WorkingSet64)" }`], { encoding: 'utf8' })
  return Object.fromEntries(o.trim().split(/\r?\n/).filter(Boolean).map((l) => { const [p, s, w] = l.trim().split(/\s+/); return [Number(p), { cpu: Number(s), ws: Number(w) }] }))
}
function postgresCpu() {
  if (process.platform !== 'win32') return NaN
  const o = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Name postgres -ErrorAction SilentlyContinue | Measure-Object -Property CPU -Sum).Sum`], { encoding: 'utf8' })
  return Number(o.trim())
}
function folderBytes(dir) {
  let b = 0
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else try { b += fs.statSync(p).size } catch { /* gone */ } } }
  try { walk(dir) } catch { /* none */ }
  return b
}

async function fleet() {
  const K = Number(arg('K', 10))
  const IDLE_S = Number(arg('IDLE', 60))
  const POLL = arg('POLL', '')
  if (K > 10) { console.error('K: at most 10 (ports 5290-5299)'); process.exit(2) }
  const insts = Array.from({ length: K }, (_, i) => ({ n: i + 1, port: 5290 + i, db: `ab_mt_f${String(i + 1).padStart(2, '0')}`, ws: path.join(root, `.sandbox/mt/fleet/i${String(i + 1).padStart(2, '0')}`) }))
  const run = { K, pollMs: POLL || 'default (1000)' }
  // baseline: PostgreSQL CPU with no instance running
  const pg0 = postgresCpu(); await sleep(IDLE_S * 1000); run.postgresIdleBaselineCpuPct = r1(((postgresCpu() - pg0) / IDLE_S) * 100)
  for (const it of insts) {
    await maint(`DROP DATABASE IF EXISTS "${it.db}" WITH (FORCE)`)
    await maint(`CREATE DATABASE "${it.db}" OWNER "${USER}" ENCODING 'UTF8' TEMPLATE template0`)
    fs.rmSync(it.ws, { recursive: true, force: true })
  }
  const starts = []
  try {
    // start one after another (start-up time of one install, alone)
    for (const it of insts) {
      it.out = ''
      const a = now()
      it.child = spawn(process.execPath, ['server/main.ts'], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...E, APPBUILDER_DB_HOST: HOST, APPBUILDER_DB_PORT: String(PORT), APPBUILDER_DB_NAME: it.db, APPBUILDER_DB_USER: USER, APPBUILDER_DB_PASSWORD: PASSWORD, APPBUILDER_WORKSPACE: it.ws, PORT: String(it.port), APPBUILDER_HOST: '127.0.0.1', APPBUILDER_MIGRATION_BACKUP: 'skip', ...(POLL ? { APPBUILDER_JOBS_POLL_MS: POLL } : {}) },
      })
      it.child.stdout.on('data', (d) => { it.out += d })
      it.child.stderr.on('data', (d) => { it.out += d })
      for (let i = 0; i < 480 && !/is running at/.test(it.out); i++) { if (it.child.exitCode !== null) throw new Error(it.out); await sleep(50) }
      const listening = now() - a
      let healthy = NaN
      for (let i = 0; i < 400; i++) { try { const r = await fetch(`http://127.0.0.1:${it.port}/api/v1/health`); if (r.ok) { healthy = now() - a; break } } catch { /* not yet */ } await sleep(50) }
      starts.push({ listening, healthy })
      // first administrator through the loopback setup route (what a provisioning tool would do on the machine)
      const code = (/SETUP CODE:\s+([A-Z0-9-]+)/.exec(it.out)?.[1] ?? '').replace(/-/g, '')
      const r = await fetch(`http://127.0.0.1:${it.port}/api/v1/setup/admin`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Appbuilder': '1' }, body: JSON.stringify({ setupCode: code, name: 'Org Admin', email: `admin${it.n}@example.test`, password: 'Fleet-Example-Pass-2026' }) })
      it.setup = r.status
    }
    run.startup = { firstStartMedianMs: Math.round(median(starts.map((s) => s.listening))), firstHealthyMedianMs: Math.round(median(starts.map((s) => s.healthy))), maxMs: Math.round(Math.max(...starts.map((s) => s.healthy))), setupStatuses: insts.map((i) => i.setup), note: 'first start on an empty database: creates schema ab and env_default' }
    log(`started ${K}: ${JSON.stringify(run.startup)}`)
    await sleep(15000)
    const pids = insts.map((i) => i.child.pid)
    const c0 = cpuSeconds(pids); const p0 = postgresCpu()
    await sleep(IDLE_S * 1000)
    const c1 = cpuSeconds(pids); const p1 = postgresCpu()
    const per = pids.map((p) => ({ cpuPct: ((c1[p].cpu - c0[p].cpu) / IDLE_S) * 100, wsMB: c1[p].ws / 2 ** 20 }))
    const conns = await maint(`SELECT datname, count(*)::int AS n FROM pg_stat_activity WHERE datname LIKE 'ab\\_mt\\_f%' GROUP BY 1`)
    const sizes = await maint(`SELECT datname, pg_database_size(datname)::bigint AS b FROM pg_database WHERE datname LIKE 'ab\\_mt\\_f%'`)
    run.idle = {
      seconds: IDLE_S,
      nodeCpuPctPerInstanceMedian: r1(median(per.map((x) => x.cpuPct))), nodeCpuPctAll: r1(per.reduce((a, x) => a + x.cpuPct, 0)),
      postgresCpuPctAll: r1(((p1 - p0) / IDLE_S) * 100), postgresBaselineCpuPct: run.postgresIdleBaselineCpuPct,
      workingSetMBMedian: r1(median(per.map((x) => x.wsMB))), workingSetMBAll: Math.round(per.reduce((a, x) => a + x.wsMB, 0)),
      dbConnectionsPerInstance: median(conns.map((x) => x.n)), dbConnectionsAll: conns.reduce((a, x) => a + x.n, 0),
      emptyDatabaseMB: r1(median(sizes.map((x) => Number(x.b))) / 2 ** 20), emptyWorkspaceKB: Math.round(median(insts.map((i) => folderBytes(i.ws))) / 1024),
      note: 'CPU in percent of ONE core; PostgreSQL CPU includes every database of the sandbox cluster',
    }
    log(`idle ${IDLE_S} s: ${JSON.stringify(run.idle)}`)
  } finally {
    for (const it of insts) if (it.child) it.child.kill('SIGTERM')
    for (const it of insts) { for (let i = 0; i < 80 && it.child && it.child.exitCode === null; i++) await sleep(100); if (it.child && it.child.exitCode === null) it.child.kill('SIGKILL') }
    const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { runs: [] }
    result.runs = [...(prev.runs ?? []), run]
    save()
  }
}

/* ------------------------------------------------------------------ database roles: can instance A's role reach B's database? */

async function roles() {
  const out = {}
  for (const n of [1, 2]) {
    await maint(`DROP DATABASE IF EXISTS "ab_mt_r${n}" WITH (FORCE)`)
    await maint(`DROP ROLE IF EXISTS "ab_mt_r${n}"`)
    await maint(`CREATE ROLE "ab_mt_r${n}" LOGIN PASSWORD 'ab-mt-r${n}-sandbox-only' NOSUPERUSER NOCREATEDB NOCREATEROLE`)
    await maint(`CREATE DATABASE "ab_mt_r${n}" OWNER "ab_mt_r${n}" ENCODING 'UTF8' TEMPLATE template0`)
  }
  const tryConnect = async (role, db) => { const k = new pg.Client({ ...cfg(db), user: role, password: `${role.replace('ab_mt_', 'ab-mt-')}-sandbox-only` }); try { await k.connect(); const r = (await k.query(`SELECT count(*)::int AS n FROM pg_namespace`)).rows[0].n; await k.end(); return `connected (sees ${r} schemas in the catalogue)` } catch (e) { return `refused: ${e.message}` } }
  out.defaultGrants = { r1ToOwnDb: await tryConnect('ab_mt_r1', 'ab_mt_r1'), r1ToOtherDb: await tryConnect('ab_mt_r1', 'ab_mt_r2'), r1ToPostgresDb: await tryConnect('ab_mt_r1', 'postgres') }
  for (const n of [1, 2]) { await maint(`REVOKE ALL ON DATABASE "ab_mt_r${n}" FROM PUBLIC`); await maint(`GRANT CONNECT, TEMPORARY ON DATABASE "ab_mt_r${n}" TO "ab_mt_r${n}"`) }
  out.afterRevoke = { r1ToOwnDb: await tryConnect('ab_mt_r1', 'ab_mt_r1'), r1ToOtherDb: await tryConnect('ab_mt_r1', 'ab_mt_r2'), r1ToPostgresDb: await tryConnect('ab_mt_r1', 'postgres') }
  // per-database connection limit
  await maint(`ALTER DATABASE "ab_mt_r1" CONNECTION LIMIT 2`)
  const ks = []
  let third = 'ok'
  for (let i = 0; i < 3; i++) { const k = new pg.Client({ ...cfg('ab_mt_r1'), user: 'ab_mt_r1', password: 'ab-mt-r1-sandbox-only' }); try { await k.connect(); ks.push(k) } catch (e) { third = e.message } }
  for (const k of ks) await k.end()
  out.connectionLimit2 = { opened: ks.length, third }
  for (const n of [1, 2]) { await maint(`DROP DATABASE IF EXISTS "ab_mt_r${n}" WITH (FORCE)`); await maint(`DROP ROLE IF EXISTS "ab_mt_r${n}"`) }
  log(JSON.stringify(out))
  result.roles = out
  save()
}

/* ------------------------------------------------------------------ drop */

async function drop() {
  const list = await maint(`SELECT datname, pg_database_size(datname)::bigint AS b FROM pg_database WHERE datname LIKE 'ab\\_mt\\_%' ORDER BY 1`)
  result.dropped = []
  for (const d of list) {
    for (let i = 0; i < 10; i++) {
      try { await maint(`DROP DATABASE IF EXISTS "${d.datname}" WITH (FORCE)`); result.dropped.push({ name: d.datname, MB: r1(Number(d.b) / 2 ** 20) }); break } catch (e) { if (i === 9) console.error(e.message); await sleep(1000) }
    }
  }
  await maint(`DROP ROLE IF EXISTS ab_mt_app`).catch(() => {})
  log(`dropped ${JSON.stringify(result.dropped)}`)
  save()
}

const parts = { 'layout-create': layoutCreate, 'layout-measure': layoutMeasure, shared, dbs, notify, fair, server, fleet, roles, drop }
if (!parts[part]) { console.error(`parts: ${Object.keys(parts).join(', ')}`); process.exit(2) }
await parts[part]()
