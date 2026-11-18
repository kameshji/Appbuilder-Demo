/**
 * Scale check of organisation scopes and relationship rules (P0 package F). DEVELOPER TOOL, not part of the product.
 *
 *   node scripts/bench/orgsec-bench.mjs              create a scratch database, seed, measure, drop it
 *   ROWS=200000 KEEP=1 node scripts/bench/orgsec-bench.mjs
 *
 * Creates the database appbuilder_bench_orgsec on PG_URL's server (sandbox credentials), with an environment schema and
 * three tables built by the platform's own DDL (server/connectors/postgres/sql.ts createTableSql: the owner index, the
 * lookup and natural-order indexes): Lines (100 rows, a Supervisor each), Assignments (a junction: Line, Member; 2,000
 * rows) and Production (ROWS rows, default 1,000,000, owner spread over 500 users, a Line lookup). The organisation has
 * 500 users in 50 departments (5 sites with 9 departments below each) and a manager tree 4 levels deep.
 * Each case builds the security predicate with src/platform/orgsec.ts exactly as the engine does and runs the SQL the
 * connectors run: Query v2 first page (50 rows, natural order) with the exact count, and a v1 page. Prints the median of
 * RUNS runs (after a warm-up) as a Markdown table. Drops the database unless KEEP=1.
 */
import pg from 'pg'
import { createTableSql, buildSelect } from '../../server/connectors/postgres/sql.ts'
import { buildV2 } from '../../server/connectors/postgres/query-v2.ts'
import { orgContextFor, rowPredicateFor } from '../../src/platform/orgsec.ts'

const PG_URL = process.env.PG_URL || 'postgres://abdev:abdev-sandbox-only@127.0.0.1:5433/appbuilder_test'
const ROWS = Number(process.env.ROWS || 1_000_000)
const RUNS = Number(process.env.RUNS || 5)
const DB = 'appbuilder_bench_orgsec'
const SCHEMA = 'env_bench'

const admin = new pg.Client({ connectionString: PG_URL })
await admin.connect()
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`)
await admin.query(`CREATE DATABASE ${DB} ENCODING 'UTF8' TEMPLATE template0`)
const url = new URL(PG_URL)
url.pathname = '/' + DB
const db = new pg.Client({ connectionString: url.toString() })
await db.connect()
const icu = (await db.query("SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_collation WHERE collname = 'und-x-icu') AS ok")).rows[0].ok
const d = { schema: SCHEMA, icu }
await db.query(`CREATE SCHEMA ${SCHEMA}`)

const now = new Date().toISOString()
const sys = [
  { name: 'id', displayName: 'Id', type: 'text', system: true },
  { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true },
  { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime', system: true },
  { name: 'createdBy', displayName: 'Created by', type: 'text', system: true },
  { name: 'owner', displayName: 'Owner', type: 'text', system: true },
]
const table = (id, name, cols, extra = {}) => ({ id, name, displayName: name, primaryColumn: cols[0].name, createdOn: now, modifiedOn: now, managed: true, connectionId: 'conn_default', source: `t_${name.toLowerCase()}`, columns: [...sys, ...cols], ...extra })
const Lines = table('tb_lines', 'Lines', [{ name: 'Name', displayName: 'Name', type: 'text' }, { name: 'Supervisor', displayName: 'Supervisor', type: 'text', indexed: true }])
const Assign = table('tb_assign', 'Assignments', [{ name: 'Line', displayName: 'Line', type: 'lookup', lookupTable: 'Lines' }, { name: 'Member', displayName: 'Member', type: 'text', indexed: true }])
const Prod = table('tb_prod', 'Production', [{ name: 'Batch', displayName: 'Batch', type: 'text' }, { name: 'Line', displayName: 'Line', type: 'lookup', lookupTable: 'Lines' }, { name: 'Qty', displayName: 'Qty', type: 'number' }], { sharing: true })
const tables = [Lines, Assign, Prod]

/* organisation: 50 departments (5 sites x 9 below), 500 users, managers 4 levels */
const departments = []
for (let s = 0; s < 5; s++) {
  departments.push({ id: `d${s}`, code: `SITE${s}`, name: `Site ${s}` })
  for (let k = 0; k < 9; k++) departments.push({ id: `d${s}_${k}`, code: `S${s}D${k}`, name: `Site ${s} dept ${k}`, parentId: `d${s}` })
}
const users = []
for (let i = 0; i < 500; i++) {
  const dept = departments[i % 50]
  // manager tree: u0..u4 top (one per site), u5..u49 report to their site head, the rest to u5..u49
  const managerId = i < 5 ? undefined : i < 50 ? `u${i % 5}` : `u${5 + (i % 45)}`
  users.push({ id: `u${i}`, name: `User ${i}`, email: `u${i}@bench.test`, departmentId: dept.id, managerId })
}
const teams = Array.from({ length: 25 }, (_, t) => ({ id: `t${t}`, code: `T${t}`, name: `Team ${t}`, memberIds: users.filter((_, i) => i % 25 === t).map((u) => u.id) }))
const dir = { departments, users, teams }

console.error(`seeding ${ROWS.toLocaleString('en-US')} rows ...`)
const t0 = Date.now()
for (const t of tables) for (const stmt of createTableSql(d, t)) await db.query(stmt)
const L = `${SCHEMA}.t_lines`, AS = `${SCHEMA}.t_assignments`, P = `${SCHEMA}.t_production`
await db.query(`INSERT INTO ${L} (id, "createdOn", "modifiedOn", owner, "Name", "Supervisor")
  SELECT lpad(g::text, 8, '0') || '-0000-7000-8000-000000000000', now(), now(), 'u0', 'Line ' || g, 'u' || (5 + g % 45) FROM generate_series(0, 99) g`)
await db.query(`INSERT INTO ${AS} (id, "createdOn", "modifiedOn", owner, "Line", "Member")
  SELECT gen_random_uuid()::text, now(), now(), 'u0', lpad((g % 100)::text, 8, '0') || '-0000-7000-8000-000000000000', 'u' || (g % 500) FROM generate_series(0, 1999) g`)
for (let from = 0; from < ROWS; from += 100_000) {
  const to = Math.min(ROWS, from + 100_000) - 1
  await db.query(`INSERT INTO ${P} (id, "createdOn", "modifiedOn", owner, "Batch", "Line", "Qty")
    SELECT gen_random_uuid()::text, now() - (g || ' seconds')::interval, now(), 'u' || (g % 500), 'B' || g, lpad((g % 100)::text, 8, '0') || '-0000-7000-8000-000000000000', g % 1000
    FROM generate_series($1::int, $2::int) g`, [from, to])
}
// 1,000 rows shared with u300
const shared = (await db.query(`SELECT id FROM ${P} WHERE owner <> 'u300' LIMIT 1000`)).rows.map((r) => r.id)
await db.query(`ANALYZE`)
console.error(`seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s`)

const role = (priv) => ({ id: 'r', name: 'Bench', apps: 'all', privileges: [{ table: Prod.id, create: false, read: 'none', update: 'none', delete: 'none', ...priv }] })
const envFor = (userId, shares) => ({ user: { id: userId, email: `${userId}@bench.test` }, org: orgContextFor(dir, userId, 'default'), tables, sameStore: () => true, ...(shares ? { shares } : {}) })

const cases = [
  ['all rows (no predicate)', 'u7', { read: 'all' }],
  ['own', 'u7', { read: 'own' }],
  ['team (20 members)', 'u7', { read: 'team' }],
  ['manager (direct reports, ~10)', 'u7', { read: 'manager' }],
  ['managerTree (site head, ~100)', 'u2', { read: 'managerTree' }],
  ['department (10 users)', 'u7', { read: 'department' }],
  ['departmentTree (site, 100 users)', 'u10', { read: 'departmentTree' }],
  ['rule Line.Supervisor = @me (2-3 lines)', 'u7', { read: 'all', rowFilter: [{ column: 'Line.Supervisor', op: 'eq', value: '@me' }] }],
  ['rule exists(Assignments: Line = this.Line, Member = @me)', 'u7', { read: 'all', rowFilter: [{ exists: { table: 'Assignments', where: [{ column: 'Line', op: 'eq', value: '@this.Line' }, { column: 'Member', op: 'eq', value: '@me' }] } }] }],
  ['own + 1,000 shared rows', 'u300', { read: 'own' }, { read: { [Prod.id]: shared }, update: {} }],
  ['departmentTree AND rule (site, not own lines)', 'u10', { read: 'departmentTree', rowFilter: [{ column: 'Line.Supervisor', op: 'ne', value: '@me' }] }],
]

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
async function time(sql, params) {
  await db.query(sql, params)
  const ms = []
  let rows = 0
  for (let i = 0; i < RUNS; i++) {
    const s = performance.now()
    const r = await db.query(sql, params)
    ms.push(performance.now() - s)
    rows = r.rows.length
  }
  return { ms: median(ms), rows }
}

const out = ['| Case | Rows visible | v2 first page + exact count (ms) | v1 page of 50 (ms) |', '| --- | ---: | ---: | ---: |']
for (const [name, user, priv, shares] of cases) {
  const pred = rowPredicateFor([role(priv)], Prod, 'read', envFor(user, shares), false)
  const rowFilter = 'const' in pred && pred.const ? undefined : pred
  const v2 = buildV2(d, Prod, { version: 2, table: 'Production', select: ['id', 'Batch', 'Qty'], count: true, page: { size: 50 } }, { rowFilter, visible: ['id', 'Batch', 'Qty'], maxUnpagedRows: 5000, maxGroups: 10000 })
  const v1 = buildSelect(d, Prod, { where: rowFilter, select: ['id', 'Batch'], top: 50 })
  const a = await time(v2.sql, v2.params)
  const b = await time(v1.sql, v1.params)
  const count = Number((await db.query(v1.sql.replace(/^SELECT .*? FROM/, 'SELECT count(*) AS n FROM').replace(/ ORDER BY .*$/, ''), v1.params)).rows[0].n)
  out.push(`| ${name} | ${count.toLocaleString('en-US')} | ${a.ms.toFixed(1)} | ${b.ms.toFixed(1)} |`)
  console.error(out[out.length - 1])
}
console.log(`\nPostgreSQL, ${ROWS.toLocaleString('en-US')} rows, 500 users, 50 departments, median of ${RUNS} runs\n`)
console.log(out.join('\n'))
await db.end()
if (process.env.KEEP !== '1') await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`)
await admin.end()
