/**
 * Phase 2 exit check 3 (P2-C): "A dashboard with at least six tiles (KPIs, trend, bar, table, OEE gauge) loads in under
 * two seconds on a 1,000,000-row table for a restricted user, showing only that user's rows." DEVELOPER TOOL.
 *
 * Needs a running server on an EMPTY sandbox database (built app: `npm run build` first), e.g.
 *   APPBUILDER_DB_HOST=127.0.0.1 APPBUILDER_DB_PORT=5433 APPBUILDER_DB_NAME=appbuilder_test_p2dash \
 *   APPBUILDER_DB_USER=abdev APPBUILDER_DB_PASSWORD=abdev-sandbox-only APPBUILDER_WORKSPACE=/tmp/ws-p2dash \
 *   APPBUILDER_SETUP_CODE_FILE=/tmp/ws-p2dash/setup-code PORT=5201 node server/main.ts
 * Run:  SETUP_CODE_FILE=/tmp/ws-p2dash/setup-code BASE=http://localhost:5201 PG_URL=postgres://...@127.0.0.1:5433/appbuilder_test_p2dash \
 *       node scripts/exit-check/p2-dashboard.mjs          (ROWS=1000000 default; BROWSER=0 skips the headless part)
 *
 * 1. Creates the minimal plant tables (ProductionLog, Downtime) through the API, a "Supervisor" role that reads OWN rows
 *    only, two supervisors, and bulk-loads ROWS production rows (10 % owned by supervisor 1, the rest by others) and
 *    ROWS / 5 downtime rows straight into PostgreSQL (generate_series), then ANALYZE.
 * 2. Creates the built-in "Production overview" dashboard (7 tiles: OEE gauge, two KPIs with comparison, a bar, a trend
 *    with comparison, a Pareto, a table) shared with the Supervisor role.
 * 3. API timing: the whole dashboard (one POST /dashboards/query) as supervisor 1, cold (the cache is dropped before each
 *    run by a write to the table) and warm (cached), median of RUNS; checks the OEE tile against SQL over that user's rows.
 * 4. Browser timing (headless Chrome): supervisor 1 opens the dashboard; time from navigation to every tile drawn;
 *    cross-filter by clicking a machine; phone width 390 px is one column; screenshots to docs/images/.
 * Prints a Markdown table (docs/admin/dashboards.md records it). Sandbox values only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const BASE = (process.env.BASE || 'http://localhost:5201').replace(/\/$/, '')
const PG_URL = process.env.PG_URL || 'postgres://abdev:abdev-sandbox-only@127.0.0.1:5433/appbuilder_test_p2dash'
const ROWS = Number(process.env.ROWS || 1_000_000)
const RUNS = Number(process.env.RUNS || 5)
const OUT = process.env.OUT || path.join(root, 'docs', 'images')
const BROWSER = process.env.BROWSER !== '0'
const ADMIN = { name: 'Test Admin', email: 'admin@example.test', password: 'Example-Only-Pass-2026' }
const SUP = { name: 'Sunita Supervisor', email: 'sup1@example.test', password: 'Example-Only-Pass-2027' }
const SUP2 = { name: 'Sam Supervisor', email: 'sup2@example.test', password: 'Example-Only-Pass-2028' }
const setupCode = process.env.SETUP_CODE ?? (process.env.SETUP_CODE_FILE && fs.existsSync(process.env.SETUP_CODE_FILE) ? fs.readFileSync(process.env.SETUP_CODE_FILE, 'utf8').split('\n')[0].trim() : '')

const { SHAPE, productionOverview } = await import(pathToFileURL(path.join(root, 'src/dashboards/manufacturing.ts')).href)
const { buildBatch, assemble } = await import(pathToFileURL(path.join(root, 'src/dashboards/viewer.ts')).href)
const { resolvePreset, DEFAULT_CALENDAR } = await import(pathToFileURL(path.join(root, 'src/dashboards/dates.ts')).href)

function client() {
  let cookie = ''
  return async function api(method, p, body) {
    const res = await fetch(BASE + '/api/v1' + p, { method, headers: { 'X-Appbuilder': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const c of res.headers.getSetCookie?.() ?? []) { const [pair] = c.split(';'); if (pair.startsWith('ab_session=')) cookie = pair }
    const data = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : await res.text()
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(data)}`)
    return data
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (cond, what) => { if (!cond) throw new Error(`CHECK FAILED: ${what}`); console.log(`ok - ${what}`) }
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }

const admin = client()
const status = await admin('GET', '/status').catch(() => ({}))
if (status.setup?.needsAdmin) await admin('POST', '/setup/admin', { setupCode, ...ADMIN })
await admin('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password })

/* ------------------------------------------------------------------ 1. tables, role, users, rows */

const ws = await admin('GET', '/workspace')
const tableOf = async (name) => ws.tables.find((t) => t.name === name) ?? admin('POST', '/tables', { displayName: name, name, columns: SHAPE[name] })
const log = await tableOf('ProductionLog')
const down = await tableOf('Downtime')
let role = (ws.roles ?? []).find((r) => r.name === 'Supervisor')
if (!role) {
  role = await admin('POST', '/roles', {
    name: 'Supervisor', apps: 'all',
    privileges: [log, down].map((t) => ({ table: t.id, create: true, read: 'own', update: 'own', delete: 'none' })),
  })
}
const db = new pg.Client({ connectionString: PG_URL })
await db.connect()
const userOf = async (u) => {
  const found = (await db.query('SELECT id FROM ab.users WHERE lower(email) = lower($1)', [u.email])).rows[0]
  const rec = found ?? await admin('POST', '/users', { name: u.name, email: u.email, password: u.password, roleIds: [role.id] })
  // a password set by an administrator must be changed at the first sign-in: not for this test account
  await db.query('UPDATE ab.users SET must_change_password = false WHERE id = $1', [rec.id])
  return rec
}
const sup1 = await userOf(SUP)
const sup2 = await userOf(SUP2)
const phys = (t) => `"env_default"."${t.source}"`
const adminId = (await db.query('SELECT id FROM ab.users WHERE lower(email) = lower($1)', [ADMIN.email])).rows[0].id
const have = Number((await db.query(`SELECT count(*)::bigint AS n FROM ${phys(log)}`)).rows[0].n)
if (have < ROWS) {
  const t0 = Date.now()
  const BATCH = 50_000
  // rows over the last 400 days (so "this month", its previous month and the fiscal year all have data); 10 % owned by
  // supervisor 1, 10 % by supervisor 2, the rest by the administrator
  for (let from = have + 1; from <= ROWS; from += BATCH) {
    const to = Math.min(ROWS, from + BATCH - 1)
    // plausible plant numbers: total count = run time / ideal cycle x 70-94 %, scrap 0-6 %; each owner's rows spread over
    // every day (day = (g / 10) % 400), every machine and shift
    await db.query(`INSERT INTO ${phys(log)} ("id", "createdOn", "modifiedOn", "createdBy", "owner", "LoggedOn", "Shift", "Machine", "Good", "Scrap", "PlannedMin", "RunMin", "IdealCycleSec")
      SELECT gen_random_uuid()::text, now(), now(), o, o, now() - (d * interval '1 day') - ((g % 24) * interval '1 hour'), (ARRAY['A','B','C'])[1 + g % 3], 'Press ' || m,
             total - (total * (g % 7)) / 100, (total * (g % 7)) / 100, 450, run, ideal
      FROM (SELECT g, o, d, m, run, ideal, floor(run * 60.0 / ideal * (0.70 + (g % 25) / 100.0))::bigint AS total
        FROM (SELECT g, CASE WHEN g % 10 = 0 THEN $3 WHEN g % 10 = 1 THEN $4 ELSE $5 END AS o, (g / 10) % 400 AS d, 1 + (g / 10) % 12 AS m,
                     380 + (g::bigint * 13) % 70 AS run, 20 + ((g / 10) % 12) * 4 AS ideal
              FROM generate_series($1::int, $2::int) AS g) x) y`, [from, to, sup1.id, sup2.id, adminId])
  }
  const reasons = "ARRAY['Breakdown','Changeover','No material','No operator','Planned maintenance','Other']"
  await db.query(`INSERT INTO ${phys(down)} ("id", "createdOn", "modifiedOn", "createdBy", "owner", "StartedOn", "Machine", "Reason", "Minutes")
    SELECT gen_random_uuid()::text, now(), now(), o, o, now() - (((g / 10) % 400) * interval '1 day'), 'Press ' || (1 + (g / 10) % 12), (${reasons})[1 + (g / 10) % 6], 5 + (g::bigint * 17) % 90
    FROM (SELECT g, CASE WHEN g % 10 = 0 THEN $2 ELSE $3 END AS o FROM generate_series(1, $1::int) AS g) x`, [Math.floor(ROWS / 5), sup1.id, sup2.id])
  await db.query(`ANALYZE ${phys(log)}`)
  await db.query(`ANALYZE ${phys(down)}`)
  console.log(`loaded ${ROWS.toLocaleString('en-US')} production rows and ${Math.floor(ROWS / 5).toLocaleString('en-US')} downtime rows in ${Math.round((Date.now() - t0) / 1000)} s`)
}
const total = Number((await db.query(`SELECT count(*)::bigint AS n FROM ${phys(log)}`)).rows[0].n)
ok(total >= ROWS, `ProductionLog has ${total.toLocaleString('en-US')} rows`)

/* ------------------------------------------------------------------ 2. the dashboard */

const list = await admin('GET', '/dashboards')
const dash = list.items.find((d) => d.name === 'Production overview') ?? await admin('POST', '/dashboards', { def: productionOverview(), roles: [role.id] })
ok(dash.def.tiles.length >= 6, `dashboard "${dash.name}" has ${dash.def.tiles.length} tiles (gauge, KPIs, bar, trend, Pareto, table)`)

/* ------------------------------------------------------------------ 3. API timing as the restricted user */

const sup = client()
await sup('POST', '/auth/login', { email: SUP.email, password: SUP.password })
const settings = (await sup('GET', '/dashboards/settings')).settings
const calendar = { ...DEFAULT_CALENDAR, ...settings }
const { localNow } = await import(pathToFileURL(path.join(root, 'src/dashboards/dates.ts')).href)
const choices = { range: resolvePreset(dash.def.range, new Date(), calendar), now: localNow(new Date(), calendar.timeZone), filters: {}, calendar, columns: (t) => (t === 'ProductionLog' ? SHAPE.ProductionLog : t === 'Downtime' ? SHAPE.Downtime : []).map((c) => c.name) }
const batch = buildBatch(dash.def, choices)
ok(!Object.keys(batch.errors).length, `${batch.queries.length} plans in one batch (${dash.def.tiles.length} tiles)`)
const cold = []
const warm = []
let last
for (let i = 0; i < RUNS + 1; i++) {
  // a write to each table drops the cached results (change feed); wait for the outbox dispatch
  await sup('POST', '/data/ProductionLog/rows', { values: { LoggedOn: new Date(Date.now() - 400 * 86400000).toISOString(), Shift: 'A', Machine: 'Press 1', Good: 0, Scrap: 0, PlannedMin: 0, RunMin: 0, IdealCycleSec: 20 } })
  await sup('POST', '/data/Downtime/rows', { values: { StartedOn: new Date(Date.now() - 400 * 86400000).toISOString(), Machine: 'Press 1', Reason: 'Other', Minutes: 0 } })
  await sleep(1500)
  let t0 = performance.now()
  const r = await sup('POST', '/dashboards/query', { queries: batch.queries })
  const ms = performance.now() - t0
  ok(r.results.every((x) => x.ok), `run ${i}: every tile answered (${r.results.filter((x) => x.cached).length} from cache)`)
  if (i > 0) cold.push(ms)
  t0 = performance.now()
  const w = await sup('POST', '/dashboards/query', { queries: batch.queries })
  if (i > 0) warm.push(performance.now() - t0)
  ok(w.results.every((x) => x.cached), 'repeat within the cache time is served from the cache')
  last = r
}
const tiles = assemble(dash.def, choices, last.results.map((x) => ({ ...x, rows: x.rows ?? [] })), {})
// the OEE tile against SQL over supervisor 1's rows only
const from = new Date(Date.parse(choices.range.from + ':00+05:30')).toISOString()
const to = new Date(Date.parse(choices.range.to + ':00+05:30')).toISOString()
const s = (await db.query(`SELECT sum("PlannedMin")::float8 p, sum("RunMin")::float8 r, sum("IdealCycleSec" * ("Good" + "Scrap") / 60.0)::float8 i, sum("Good")::float8 g, sum("Good" + "Scrap")::float8 t, count(*)::int n
  FROM ${phys(log)} WHERE "owner" = $1 AND "LoggedOn" >= $2 AND "LoggedOn" < $3`, [sup1.id, from, to])).rows[0]
const oee = tiles.oee.rows[0]
const want = (s.r / s.p) * (s.i / s.r) * (s.g / s.t)
ok(Math.abs(oee.OEE - want) < 1e-9, `OEE tile ${(oee.OEE * 100).toFixed(2)} % equals SQL over the supervisor's own ${s.n.toLocaleString('en-US')} rows this month`)
const allRows = (await db.query(`SELECT sum("Good")::float8 g FROM ${phys(log)} WHERE "LoggedOn" >= $1 AND "LoggedOn" < $2`, [from, to])).rows[0].g
ok(tiles.good.rows[0].Good === s.g && s.g < allRows, `Good quantity KPI shows only the supervisor's rows (${s.g} of ${allRows})`)
ok(last.results.every((x) => x.filtered), 'every tile says it is based on the rows the user can see')

/* ------------------------------------------------------------------ 4. browser */

let browserMs = []
let phoneOk = false
let crossOk = false
if (BROWSER) {
  const PUPPETEER_CORE = process.env.PUPPETEER_CORE || '/tmp/pgcheck/node_modules/puppeteer-core'
  const { default: puppeteer } = await import(pathToFileURL(path.join(PUPPETEER_CORE, 'lib/puppeteer/puppeteer-core.js')).href)
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 1000 })
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
    // a first visit may reload once (service worker of the installable app): wait, and load again if needed
    if (!(await page.waitForSelector('input[type=email]', { timeout: 15000 }).catch(() => null))) {
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('input[type=email]')
    }
    await page.type('input[type=email]', SUP.email)
    await page.type('input[type=password]', SUP.password)
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 20000 })
    const allReady = () => {
      const t = [...document.querySelectorAll('[data-testid^="tile-"][data-state]')]
      return t.length >= 6 && t.every((x) => x.getAttribute('data-state') === 'ready') && !!document.querySelector('[data-testid="tile-oee-viz-svg"]')
    }
    // cold: nothing of the app is open while the table changes (no live refresh can warm the cache), then a full page
    // load of the dashboard address: app start, session, definition, one batch, drawing
    for (let i = 0; i < RUNS + 1; i++) {
      await page.goto('about:blank')
      await sup('POST', '/data/ProductionLog/rows', { values: { LoggedOn: new Date(Date.now() - 400 * 86400000).toISOString(), Shift: 'A', Machine: 'Press 1', Good: 0, Scrap: 0, PlannedMin: 0, RunMin: 0, IdealCycleSec: 20 } })
      await sup('POST', '/data/Downtime/rows', { values: { StartedOn: new Date(Date.now() - 400 * 86400000).toISOString(), Machine: 'Press 1', Reason: 'Other', Minutes: 0 } })
      await sleep(1500)
      const t0 = Date.now()
      await page.goto(`${BASE}/#u-dashboards?d=${dash.id}`, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(allReady, { timeout: 30000, polling: 20 })
      if (i > 0) browserMs.push(Date.now() - t0)
    }
    ok(await page.$('[data-testid="tile-oee-filtered"]'), 'the note "Based on the rows you can see" is shown')
    fs.mkdirSync(OUT, { recursive: true })
    await page.screenshot({ path: path.join(OUT, 'p2-dashboard-production-overview.png') })
    // cross-filter: click the first machine in the table tile
    const before = await page.$eval('[data-testid="tile-good-viz-svg"]', (e) => e.getAttribute('aria-label'))
    await page.click('[data-testid="tile-machines-table"] tbody tr')
    await page.waitForSelector('[data-testid="dashboard-crossfilter"]')
    await page.waitForFunction((b) => document.querySelector('[data-testid="tile-good-viz-svg"]')?.getAttribute('aria-label') !== b, { timeout: 15000 }, before)
    crossOk = true
    ok(true, 'clicking a machine in the table filters the other tiles (chip shown, KPI changed)')
    await page.click('[data-testid="dashboard-crossfilter"]')
    // keyboard: focus the trend and move with the arrow keys
    await page.$eval('[data-testid="tile-trend-viz-svg"]', (e) => e.focus())
    await page.keyboard.press('ArrowRight')
    await page.waitForSelector('[data-testid="tile-trend-viz-tooltip"]')
    ok(true, 'arrow keys move through the trend points with a tooltip')
    await page.click('[data-testid="tile-pareto-tableview"]')
    await page.waitForSelector('[data-testid="tile-pareto-viz-table"] tbody tr')
    ok(true, 'the Pareto tile shows its data as a table')
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    await page.waitForFunction(() => document.querySelector('[data-testid="dashboard-grid"]')?.getAttribute('data-layout') === 'phone', { timeout: 10000 })
    phoneOk = true
    ok(true, 'at 390 px the grid is one column')
    await page.screenshot({ path: path.join(OUT, 'p2-dashboard-phone.png'), fullPage: false })
  } finally {
    await browser.close()
  }
}
await db.end()

const row = (label, xs) => `| ${label} | ${xs.length ? Math.round(median(xs)) : '-'} | ${xs.length ? Math.round(Math.max(...xs)) : '-'} |`
console.log(`\nExit check 3 (${total.toLocaleString('en-US')} production rows, restricted user with ${s.n.toLocaleString('en-US')} own rows this month, ${dash.def.tiles.length} tiles, ${batch.queries.length} plans)\n`)
console.log('| Measure | Median ms | Max ms |')
console.log('| --- | ---: | ---: |')
console.log(row('Batch endpoint, cold (cache dropped by a write)', cold))
console.log(row('Batch endpoint, cached', warm))
if (BROWSER) console.log(row('Browser: full page load of the dashboard address until every tile is drawn (cold cache)', browserMs))
const pass = median(cold) < 2000 && (!BROWSER || median(browserMs) < 2000)
console.log(`\n${pass ? 'PASS' : 'FAIL'}: under 2 s${BROWSER ? `; cross-filter ${crossOk ? 'ok' : 'FAILED'}; phone layout ${phoneOk ? 'ok' : 'FAILED'}` : ''}`)
process.exit(pass ? 0 : 1)
