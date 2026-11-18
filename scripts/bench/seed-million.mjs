/**
 * Scale check of Query v2 (P0 package D). DEVELOPER TOOL, not part of the product.
 *
 *   node scripts/bench/seed-million.mjs            seed (if needed) and measure
 *   ROWS=200000 node scripts/bench/seed-million.mjs
 *
 * 1. Signs in to a running server (BASE, default http://127.0.0.1:5196; EMAIL / PASSWORD of an administrator) and creates
 *    the table "BigOrders" through the API (so the platform creates its indexes: natural order, and the columns marked
 *    `indexed`), unless it exists.
 * 2. Bulk-loads ROWS (default 1,000,000) rows into its physical table with server-side batched INSERT ... SELECT from
 *    generate_series (50,000 rows per statement), straight into PostgreSQL (PG_URL, the sandbox database the server
 *    uses), then ANALYZE.
 * 3. Measures POST /api/v1/query over HTTP (median of RUNS runs after a warm-up): first page, filtered page on an indexed
 *    and on a non-indexed column, search, a sorted page at a deep cursor, an exact count, a grouped aggregate. Prints a
 *    Markdown table (docs/dev/query-v2.md records it).
 * Sandbox values only.
 */
import pg from 'pg'

const BASE = (process.env.BASE || 'http://127.0.0.1:5196').replace(/\/$/, '')
const EMAIL = process.env.EMAIL || 'admin@example.test'
const PASSWORD = process.env.PASSWORD || 'Example-Only-Pass-2026'
const PG_URL = process.env.PG_URL || 'postgres://abdev:abdev-sandbox-only@127.0.0.1:5433/appbuilder_test_d1'
const ROWS = Number(process.env.ROWS || 1_000_000)
const RUNS = Number(process.env.RUNS || 5)
const TABLE = process.env.TABLE || 'BigOrders'

let cookie = ''
async function api(method, path, body) {
  const headers = { 'X-Appbuilder': '1' }
  if (cookie) headers.Cookie = cookie
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(BASE + '/api/v1' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';')
    if (pair.startsWith('ab_session=')) cookie = pair
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`)
  return data
}

await api('POST', '/auth/login', { email: EMAIL, password: PASSWORD })
const ws = await api('GET', '/workspace')
let def = ws.tables.find((t) => t.name === TABLE)
if (!def) {
  def = await api('POST', '/tables', {
    displayName: TABLE, name: TABLE,
    columns: [
      { displayName: 'Title', name: 'Title', type: 'text', required: true, indexed: true },
      { displayName: 'City', name: 'City', type: 'text', indexed: true },
      { displayName: 'Status', name: 'Status', type: 'choice', choices: ['Open', 'Won', 'Lost', 'Hold'], indexed: true },
      { displayName: 'Amount', name: 'Amount', type: 'currency', indexed: true },
      { displayName: 'Qty', name: 'Qty', type: 'number' },
      { displayName: 'Due', name: 'Due', type: 'date', indexed: true },
      { displayName: 'Active', name: 'Active', type: 'boolean' },
      { displayName: 'Note', name: 'Note', type: 'text' },
    ],
  })
  console.log(`created table ${TABLE} (${def.id}, ${def.source})`)
}

const db = new pg.Client({ connectionString: PG_URL })
await db.connect()
const phys = `"env_default"."${def.source}"`
const have = Number((await db.query(`SELECT count(*)::bigint AS n FROM ${phys}`)).rows[0].n)
if (have < ROWS) {
  const t0 = Date.now()
  const BATCH = 50_000
  for (let from = have + 1; from <= ROWS; from += BATCH) {
    const to = Math.min(ROWS, from + BATCH - 1)
    await db.query(`INSERT INTO ${phys} ("id", "createdOn", "modifiedOn", "createdBy", "owner", "Title", "City", "Status", "Amount", "Qty", "Due", "Active", "Note")
      SELECT gen_random_uuid()::text, timestamptz '2025-01-01' + (g * interval '1 second'), timestamptz '2025-01-01' + (g * interval '1 second'), NULL, NULL,
             'Order ' || g, (ARRAY['Pune','Austin','Berlin','Lagos','Osaka','Lima','Oslo','Cairo','Perth','Quito'])[1 + g % 10] || CASE WHEN g % 1000 = 0 THEN ' North' ELSE '' END,
             (ARRAY['Open','Won','Lost','Hold'])[1 + (g / 7) % 4], round(((g::bigint * 7919) % 100000) / 100.0, 2), g % 50, date '2020-01-01' + (g % 2500), g % 3 = 0,
             'note ' || md5(g::text)
      FROM generate_series($1::int, $2::int) AS g`, [from, to])
    process.stdout.write(`\rloaded ${to.toLocaleString('en-US')} rows`)
  }
  console.log(`\nbulk load: ${(Date.now() - t0) / 1000} s`)
  await db.query(`ANALYZE ${phys}`)
}
const total = Number((await db.query(`SELECT count(*)::bigint AS n FROM ${phys}`)).rows[0].n)
// a cursor deep in the Amount-descending order: the row at 90% of the table
const deep = (await db.query(`SELECT "Amount"::float8 AS a, to_char("createdOn" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS c, "id" AS i
  FROM ${phys} ORDER BY COALESCE("Amount", 0) DESC, COALESCE("createdOn", '-infinity'::timestamptz), "id" COLLATE "C" OFFSET $1 LIMIT 1`, [Math.floor(total * 0.9)])).rows[0]
await db.end()
const deepCursor = 'c2.' + Buffer.from(JSON.stringify({ s: 'Amount:desc', k: [deep.a], c: deep.c, i: deep.i })).toString('base64url')

const cases = [
  ['First page (100 rows, natural order) + exact count', { count: true, page: { size: 100 } }],
  ['Filtered page, indexed column (City = "Pune North", 0.1%)', { filter: { col: 'City', op: 'eq', value: 'pune north' }, page: { size: 100 } }],
  ['Filtered page, indexed column (Status = "Won", 25%) + count', { filter: { col: 'Status', op: 'eq', value: 'won' }, count: true, page: { size: 100 } }],
  ['Filtered page, non-indexed column (Qty = 7, 2%)', { filter: { col: 'Qty', op: 'eq', value: 7 }, page: { size: 100 } }],
  ['Filtered page, non-indexed text (Note contains "abc")', { filter: { col: 'Note', op: 'contains', value: 'abc' }, page: { size: 100 } }],
  ['Search "order 4242" in Title, City (indexed: trigram) + count', { search: { text: 'order 4242', columns: ['Title', 'City'] }, count: true, page: { size: 100 } }],
  ['Search "abc12" in Note (not indexed) + count', { search: { text: 'abc12', columns: ['Note'] }, count: true, page: { size: 100 } }],
  ['Sorted page (Amount desc), first page', { sort: [{ col: 'Amount', dir: 'desc' }], page: { size: 100 } }],
  ['Sorted page (Amount desc), deep cursor (90%)', { sort: [{ col: 'Amount', dir: 'desc' }], page: { size: 100, cursor: deepCursor } }],
  ['Exact count, whole table', { count: true, page: { size: 0 } }],
  ['Exact count, Due in 2024 (indexed range)', { filter: { and: [{ col: 'Due', op: 'ge', value: { $date: '2024-01-01' } }, { col: 'Due', op: 'lt', value: { $date: '2025-01-01' } }] }, count: true, page: { size: 0 } }],
  ['Grouped aggregate: by City, count + sum(Amount)', { aggregate: { groupBy: ['City'], measures: [{ name: 'N', fn: 'count' }, { name: 'Total', fn: 'sum', col: 'Amount' }] } }],
  ['Grouped aggregate: by Status, sum(Amount * Qty)', { aggregate: { groupBy: ['Status'], measures: [{ name: 'Revenue', fn: 'sum', expr: { fn: 'mul', args: [{ col: 'Amount' }, { col: 'Qty' }] } }] } }],
  ['Sum over the whole table (no groups)', { aggregate: { groupBy: [], measures: [{ name: 'S', fn: 'sum', col: 'Amount' }] } }],
]

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
console.log(`\n${TABLE}: ${total.toLocaleString('en-US')} rows; median of ${RUNS} runs over HTTP (after one warm-up)\n`)
console.log('| Query | Rows back | Median ms | Max ms |')
console.log('| --- | ---: | ---: | ---: |')
for (const [label, extra] of cases) {
  const plan = { version: 2, table: TABLE, ...extra }
  let last
  await api('POST', '/query', { plan })
  const times = []
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now()
    last = await api('POST', '/query', { plan })
    times.push(performance.now() - t0)
  }
  const back = `${last.rows.length}${last.count !== undefined ? ` (count ${last.count.toLocaleString('en-US')})` : ''}`
  console.log(`| ${label} | ${back} | ${median(times).toFixed(0)} | ${Math.max(...times).toFixed(0)} |`)
}
