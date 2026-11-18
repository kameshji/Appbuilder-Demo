/**
 * Query v2 on real PostgreSQL (P0 package D): the translator's whole corpus end to end, and EXPLAIN checks that the
 * statements use the platform's indexes. Set APPBUILDER_TEST_DB (see server/core/testdb.ts).
 *
 * Parity: the sample tables of src/fx/query/testdata.ts are loaded into a fresh schema; every formula the translator
 * fully delegates is executed plan by plan through the connector's queryV2 (the same statement the endpoint runs),
 * the wire rows are converted as the browser converts them (rowsFromWire), the residual formula finishes in the
 * engine, and the value must equal the engine's own value over all rows. Measures are compared with a relative tolerance
 * of 1e-9 (floating-point sums, docs/dev/query-v2.md section 6). Every rows plan is also paged by 7 and must
 * concatenate to the unpaged result.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import type { ColumnDef, ColumnType, TableDef } from '../../../src/platform/contracts.ts'
import type { FxRecord, FxResult, FxValue } from '../../../src/contracts.ts'
import type { QueryPlan, TableSchemaInfo } from '../../../src/platform/query.ts'
import type { QueryValue } from '../../../src/platform/http.ts'
import { createEngine } from '../../../src/fx/engine.ts'
import { analyze, bindResult, residualScope, type AnalyzeResult } from '../../../src/fx/query/index.ts'
import { checkPlan } from '../../../src/fx/query/validate.ts'
import { corpus, customerRows, sampleScope, SCHEMA, ticketRows } from '../../../src/fx/query/testdata.ts'
import { exprCorpus } from '../../../src/fx/query/testdata-expr.ts'
import { rowsFromWire } from '../../../src/platform/query-wire.ts'
import type { Connector, ConnectionRecord, ConnectorEnv, RawRow } from '../../core/contracts.ts'
import { cellOut } from '../../core/values.ts'
import { createPostgresConnector } from './index.ts'
import { createPgDb } from './db.ts'
import type { PgDb } from './db.ts'
import { buildV2 } from './query-v2.ts'
import { PG_URL, SKIP_PG, pgServer } from '../../core/testdb.ts'

if (!PG_URL) console.warn(`[query v2 integration] ${SKIP_PG}`)
const suite = PG_URL ? describe : describe.skip

const cfg = pgServer ?? { host: '', port: 0, user: '', password: '', database: '' }
const schema = `tq2${randomBytes(3).toString('hex')}`
const env: ConnectorEnv = { workspaceDir: '', filesDir: '', fetch, log: () => {} }
const record: ConnectionRecord = {
  id: 'conn_q2', name: 'q2', connector: 'postgres', status: 'connected',
  settings: { host: cfg.host, port: String(cfg.port), database: cfg.database, user: cfg.user, ssl: 'false', schema }, secret: cfg.password,
}

const col = (name: string, type: ColumnType, extra: Partial<ColumnDef> = {}): ColumnDef => ({ name, displayName: name, type, ...extra })
const SYS: ColumnDef[] = [col('id', 'text', { system: true }), col('createdOn', 'datetime', { system: true })]

/** the sample tables as TableDefs (formula kinds of testdata.ts -> column types) */
const TICKETS: TableDef = {
  id: 'tbl_tickets', name: 'Tickets', displayName: 'Tickets', primaryColumn: 'Title', createdOn: '', modifiedOn: '', source: 'tickets', managed: true, missingSystem: ['modifiedOn', 'createdBy', 'owner'],
  columns: [...SYS, col('Title', 'text', { indexed: true }), col('Status', 'choice'), col('Code', 'text'), col('Owner', 'email'), col('Priority', 'decimal', { indexed: true }),
    col('Score', 'decimal'), col('Active', 'boolean'), col('Flag', 'boolean'), col('Due', 'date', { indexed: true }), col('Start', 'date'), col('Updated', 'datetime'),
    col('Blob', 'file')],
}
const CUSTOMERS: TableDef = {
  id: 'tbl_customers', name: 'Customers', displayName: 'Customers', primaryColumn: 'Name', createdOn: '', modifiedOn: '', source: 'customers', managed: true, missingSystem: ['modifiedOn', 'createdBy', 'owner'],
  columns: [...SYS, col('Name', 'text'), col('Email', 'email'), col('Tier', 'number')],
}
const DEFS: Record<string, TableDef> = { Tickets: TICKETS, Customers: CUSTOMERS }
const typesOf = (def: TableDef): Record<string, ColumnType> => Object.fromEntries(def.columns.map((c) => [c.name, c.type]))

/** formula rows (local-midnight dates) -> connector rows (UTC-midnight dates, as the server holds them) */
function toRaw(def: TableDef, r: FxRecord): RawRow {
  const out: RawRow = {}
  for (const c of def.columns) {
    const v = r[c.name] ?? null
    if (c.type === 'date' && v instanceof Date) out[c.name] = new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()))
    else out[c.name] = v as RawRow[string]
  }
  return out
}

/** canonical form; numbers rounded to 12 significant digits (relative tolerance for floating-point sums) */
function canon(v: FxValue, loose: boolean): unknown {
  if (v instanceof Date) return { $t: v.getTime() }
  if (typeof v === 'number' && loose && v !== 0) return Number(v.toPrecision(12))
  if (Array.isArray(v)) return v.map((x) => canon(x, loose))
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) o[k] = canon((v as FxRecord)[k]!, loose)
    return o
  }
  return v
}

suite(PG_URL ? 'query v2 on PostgreSQL (integration)' : `query v2 on PostgreSQL (integration) ${SKIP_PG}`, () => {
  let c: Connector
  let raw: PgDb
  const tables: Record<string, FxRecord[]> = { Tickets: ticketRows(), Customers: customerRows() }
  const scope = sampleScope(tables)
  const engine = createEngine()

  async function run(plan: QueryPlan): Promise<{ rows: FxRecord[]; count?: number; nextCursor?: string | null }> {
    const def = DEFS[plan.table]!
    const info: TableSchemaInfo = SCHEMA.tables[plan.table]!
    const checked = checkPlan(JSON.parse(JSON.stringify(plan)), info, def.displayName).plan
    const res = await c.queryV2!(def, { plan: checked, visible: Object.keys(info.columns), maxUnpagedRows: 5000, maxGroups: 5000, timeoutMs: 15000 })
    const types = new Map(res.columns.map((x) => [x.name, x.type]))
    // the DataService's JSON conversion, then the browser's
    const wire: Record<string, QueryValue>[] = res.rows.map((r) => {
      const o: Record<string, QueryValue> = {}
      for (const [k, v] of Object.entries(r)) o[k] = cellOut({ name: k, displayName: k, type: types.get(k) ?? 'text' }, v)
      return o
    })
    return { rows: rowsFromWire(checked, wire, typesOf(def)), count: res.count, nextCursor: res.nextCursor }
  }

  async function runPlans(r: AnalyzeResult): Promise<FxResult> {
    const values: Record<string, FxValue> = {}
    for (const q of r.plans) values[q.id] = bindResult(q, await run(q.plan))
    if (!r.residual) return { ok: true, value: values[r.plans[0]!.id]! }
    return engine.evaluate(r.residual.formula, residualScope(values, scope))
  }

  beforeAll(async () => {
    raw = createPgDb({ host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user }, cfg.password)
    await raw.exec(`CREATE SCHEMA "${schema}"`)
    c = createPostgresConnector(record, env)
    for (const [name, def] of Object.entries(DEFS)) {
      await c.createTable(def)
      await c.insert(def, tables[name]!.map((r) => toRaw(def, r)))
    }
  })
  afterAll(async () => {
    await raw?.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await c?.close()
    await raw?.close()
  })

  for (const [label, make] of [['translator corpus', () => corpus()], ['computed-expression corpus', () => exprCorpus()]] as const) {
    it(`${label}: every delegated formula gives the engine's value on PostgreSQL, and pages concatenate`, async () => {
      const formulas = make()
      const mismatches: string[] = []
      let delegated = 0
      let paged = 0
      for (const f of formulas) {
        const r = analyze(f, SCHEMA, { scope, engine })
        if (!r.fullyDelegated) continue
        delegated++
        const want = engine.evaluate(f, scope)
        let got: FxResult
        try {
          got = await runPlans(r)
        } catch (e) {
          got = { ok: false, error: { message: e instanceof Error ? e.message : String(e), start: 0, end: 0 } } as FxResult
        }
        const loose = r.plans.some((q) => !!q.plan.aggregate)
        const a = want.ok ? canon(want.value, loose) : 'error'
        const b = got.ok ? canon(got.value, loose) : 'error'
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          mismatches.push(`${f}\n  engine: ${JSON.stringify(a).slice(0, 400)}\n  pg:     ${JSON.stringify(b).slice(0, 400)}${got.ok ? '' : ` (${(got as { error: { message: string } }).error.message})`}\n  plans: ${JSON.stringify(r.plans.map((q) => q.plan)).slice(0, 600)}`)
          continue
        }
        for (const q of r.plans) {
          if (q.shape !== 'rows' || q.plan.aggregate) continue
          const all = (await run(q.plan)).rows
          const got2: FxRecord[] = []
          let cursor: string | undefined
          for (let i = 0; i < 50; i++) {
            const page = await run({ ...q.plan, page: { size: 7, cursor } })
            got2.push(...page.rows)
            if (!page.nextCursor) break
            cursor = page.nextCursor
          }
          if (JSON.stringify(canon(got2, false)) !== JSON.stringify(canon(all, false))) mismatches.push(`${f}\n  pages differ from the full result`)
          paged++
        }
      }
      console.log(`[query v2 pg parity] ${label}: ${formulas.length} formulas, ${delegated} delegated and executed on PostgreSQL, ${paged} row plans paged, ${mismatches.length} mismatches`)
      expect(mismatches.slice(0, 5).join('\n\n')).toBe('')
      expect(delegated).toBeGreaterThan(label === 'translator corpus' ? 400 : 120)
    }, 120_000)
  }

  it('count-only pages, exact count with pages, single rows and empty results', async () => {
    const plan: QueryPlan = { version: 2, table: 'Tickets', filter: { col: 'Priority', op: 'gt', value: 1 }, count: true }
    const n = tables.Tickets!.filter((r) => typeof r.Priority === 'number' && r.Priority > 1).length
    const only = await run({ ...plan, page: { size: 0 } })
    expect(only.rows).toEqual([])
    expect(only.count).toBe(n)
    expect(only.nextCursor).toBeNull()
    const p1 = await run({ ...plan, page: { size: 3 } })
    expect(p1.rows.length).toBe(Math.min(3, n))
    expect(p1.count).toBe(n)
    const none = await run({ ...plan, filter: { const: false }, page: { size: 5 } })
    expect(none.rows).toEqual([])
    expect(none.count).toBe(0)
    expect(none.nextCursor).toBeNull()
    const sum = await run({ version: 2, table: 'Tickets', filter: { const: false }, aggregate: { groupBy: [], measures: [{ name: 'S', fn: 'sum', col: 'Priority' }, { name: 'A', fn: 'avg', col: 'Priority' }] } })
    expect(sum.rows).toEqual([{ S: 0, A: null }])
  })

  it('a cursor for another sort, or a forged one, is refused with 422', async () => {
    const p = await run({ version: 2, table: 'Tickets', sort: [{ col: 'Title', dir: 'asc' }], page: { size: 5 } })
    expect(p.nextCursor).toBeTruthy()
    await expect(run({ version: 2, table: 'Tickets', sort: [{ col: 'Priority', dir: 'asc' }], page: { size: 5, cursor: p.nextCursor! } })).rejects.toMatchObject({ status: 422 })
    await expect(run({ version: 2, table: 'Tickets', page: { size: 5, cursor: 'c2.bm90LWpzb24' } })).rejects.toMatchObject({ status: 422 })
    const forged = 'c2.' + Buffer.from(JSON.stringify({ s: 'Title:asc', k: [5], c: null, i: 'x' })).toString('base64url')
    await expect(run({ version: 2, table: 'Tickets', sort: [{ col: 'Title', dir: 'asc' }], page: { size: 5, cursor: forged } })).rejects.toMatchObject({ status: 422 })
  })

  it('division by zero and overflow fail the query like the formula fails', async () => {
    await expect(run({ version: 2, table: 'Tickets', filter: { op: 'cmpExpr', cmp: 'gt', left: { fn: 'div', args: [{ col: 'Priority' }, 0] }, right: 1 } }))
      .rejects.toMatchObject({ status: 422, message: "Can't divide by zero" })
    await expect(run({ version: 2, table: 'Tickets', filter: { op: 'cmpExpr', cmp: 'gt', left: { fn: 'mul', args: [1e308, 1e308] }, right: 1 } }))
      .rejects.toMatchObject({ status: 422 })
  })

  describe('documented deviations (docs/dev/query-v2.md section 13), pinned', () => {
    it('a text column holding numbers sorts as text (the engine compares two number-like texts as numbers)', async () => {
      const got = (await run({ version: 2, table: 'Tickets', sort: [{ col: 'Code', dir: 'asc' }], select: ['Code'] })).rows.map((r) => r.Code)
      const want = [...tables.Tickets!].sort((a, b) => {
        const x = String(a.Code ?? '').toLowerCase(), y = String(b.Code ?? '').toLowerCase()
        return x < y ? -1 : x > y ? 1 : (a.createdOn as Date).getTime() - (b.createdOn as Date).getTime() || String(a.id).localeCompare(String(b.id))
      }).map((r) => r.Code)
      expect(got).toEqual(want) // code point order: "10" before "9"
      expect(got.indexOf('10')).toBeLessThan(got.indexOf('9'))
    })
    it('PostgreSQL reports float underflow as an error where JavaScript gives 0', async () => {
      const plan: QueryPlan = { version: 2, table: 'Tickets', filter: { op: 'cmpExpr', cmp: 'eq', left: { fn: 'mul', args: [1e-200, 1e-200] }, right: 0 }, count: true, page: { size: 0 } }
      expect(1e-200 * 1e-200).toBe(0)
      await expect(run(plan)).rejects.toMatchObject({ status: 422 })
    })
    it('sums of decimals may differ from the engine in the last digits (summation order); parity compares 12 significant digits', async () => {
      const plan: QueryPlan = { version: 2, table: 'Tickets', aggregate: { groupBy: [], measures: [{ name: 'S', fn: 'sum', col: 'Priority' }] } }
      const pg = (await run(plan)).rows[0]!.S as number
      const js = tables.Tickets!.reduce((a, r) => a + (typeof r.Priority === 'number' ? r.Priority : 0), 0)
      expect(Math.abs(pg - js) / Math.abs(js)).toBeLessThan(1e-12)
    })
  })

  it('too many unpaged rows or groups is a clear 422', async () => {
    const big: TableDef = { ...CUSTOMERS, id: 'tbl_big', name: 'Big', displayName: 'Big', source: 'big' }
    await c.createTable(big)
    await raw.exec(`INSERT INTO "${schema}"."big" ("id", "createdOn", "Name", "Tier") SELECT 'b' || g, now(), 'n' || (g % 6000), g FROM generate_series(1, 6001) g`)
    const info: TableSchemaInfo = SCHEMA.tables.Customers!
    const q = (plan: QueryPlan) => c.queryV2!(big, { plan, visible: Object.keys(info.columns), maxUnpagedRows: 5000, maxGroups: 5000, timeoutMs: 15000 })
    await expect(q({ version: 2, table: 'Big' })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/more than 5,000 rows/) })
    await expect(q({ version: 2, table: 'Big', aggregate: { groupBy: ['Name'], measures: [{ name: 'N', fn: 'count' }] } })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/more than 5,000 groups/) })
    expect((await q({ version: 2, table: 'Big', page: { size: 500 } })).rows.length).toBe(500)
  })

  describe('EXPLAIN: filters and sorts on indexed columns use the indexes', () => {
    const IDX: TableDef = {
      id: 'tbl_idx', name: 'Idx', displayName: 'Idx', primaryColumn: 'Name', createdOn: '', modifiedOn: '', source: 'idx', managed: true,
      columns: [...SYS, col('Name', 'text', { indexed: true }), col('Code', 'text', { unique: true }), col('Customer', 'lookup', { lookupTable: 'Customers' }),
        col('Amount', 'decimal', { indexed: true }), col('Qty', 'number'), col('Due', 'date', { indexed: true }), col('Note', 'text')],
    }
    const IDX_INFO: TableSchemaInfo = { columns: { id: 'text', createdOn: 'datetime', Name: 'text', Code: 'text', Customer: 'text', Amount: 'number', Qty: 'number', Due: 'date', Note: 'text' } }

    beforeAll(async () => {
      await c.createTable(IDX)
      await raw.exec(`INSERT INTO "${schema}"."idx" ("id", "createdOn", "Name", "Code", "Customer", "Amount", "Qty", "Due", "Note")
        SELECT lpad(g::text, 8, '0'), timestamptz '2026-01-01' + (g || ' seconds')::interval, 'Name ' || (g % 5000), 'C' || g, 'cust' || (g % 300), (g % 1000) * 1.5, g % 50,
               date '2020-01-01' + (g % 2000), 'note ' || g
        FROM generate_series(1, 30000) g`)
      await raw.exec(`ANALYZE "${schema}"."idx"`)
    })

    /** `noSeq`: the table is small (30,000 rows), so prove the index CAN serve the query by ruling out the scan */
    async function explain(plan: QueryPlan, noSeq = false): Promise<string> {
      const checked = checkPlan(plan, IDX_INFO, 'Idx').plan
      const st = buildV2({ schema, icu: true }, IDX, checked, { visible: Object.keys(IDX_INFO.columns), maxUnpagedRows: 5000, maxGroups: 5000 })
      const rows = await raw.tx(async (t) => {
        if (noSeq) await t.exec('SET LOCAL enable_seqscan = off')
        return t.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${st.sql}`, st.params)
      })
      return JSON.stringify(rows[0]!['QUERY PLAN'])
    }
    /** the plan reads this index (a key index kx_ also counts as used through its descending twin kd_) */
    const usesIndex = (p: string, name: string) => {
      const ok = p.includes(`"Index Name":"${name}"`) || (name.startsWith('kx_') && p.includes(`"Index Name":"kd_${name.slice(3)}"`))
      if (!ok && process.env.DEBUG_EXPLAIN) console.log(name, p)
      return ok
    }

    it('equality, ranges and prefixes on an indexed text column', async () => {
      expect(usesIndex(await explain({ version: 2, table: 'Idx', filter: { col: 'Name', op: 'eq', value: 'name 42' }, page: { size: 50 } }), 'kx_idx_Name')).toBe(true)
      expect(usesIndex(await explain({ version: 2, table: 'Idx', filter: { col: 'Name', op: 'startsWith', value: 'name 4999' }, page: { size: 50 } }), 'kx_idx_Name')).toBe(true)
      expect(usesIndex(await explain({ version: 2, table: 'Idx', filter: { col: 'Name', op: 'in', value: ['name 1', 'name 2'] }, page: { size: 50 } }), 'kx_idx_Name')).toBe(true)
    })
    it('substring search on an indexed text column uses its trigram index (pg_trgm)', async () => {
      expect(usesIndex(await explain({ version: 2, table: 'Idx', search: { text: 'name 4242', columns: ['Name'] }, count: true, page: { size: 50 } }, true), 'tg_idx_Name')).toBe(true)
      expect(usesIndex(await explain({ version: 2, table: 'Idx', filter: { col: 'Name', op: 'contains', value: 'me 424' }, page: { size: 50 } }, true), 'tg_idx_Name')).toBe(true)
    })
    it('lookup and unique columns are indexed by default', async () => {
      expect(usesIndex(await explain({ version: 2, table: 'Idx', filter: { col: 'Customer', op: 'eq', value: 'cust7' }, page: { size: 50 } }), 'kx_idx_Customer')).toBe(true)
      expect(usesIndex(await explain({ version: 2, table: 'Idx', filter: { col: 'Code', op: 'eq', value: 'c77' }, single: true }), 'kx_idx_Code')).toBe(true)
    })
    it('number and date ranges, sorted pages and deep cursors', async () => {
      expect(usesIndex(await explain({ version: 2, table: 'Idx', filter: { col: 'Amount', op: 'ge', value: 1490 }, page: { size: 50 } }), 'kx_idx_Amount')).toBe(true)
      expect(usesIndex(await explain({ version: 2, table: 'Idx', filter: { and: [{ col: 'Due', op: 'ge', value: { $date: '2025-01-01' } }, { col: 'Due', op: 'lt', value: { $date: '2025-01-03' } }] }, page: { size: 50 } }), 'kx_idx_Due')).toBe(true)
      const sorted: QueryPlan = { version: 2, table: 'Idx', sort: [{ col: 'Amount', dir: 'asc' }], page: { size: 50 } }
      expect(usesIndex(await explain(sorted), 'kx_idx_Amount')).toBe(true)
      // a descending sort (ties still ascending) reads the descending twin index of an indexed column, also at a deep cursor
      const desc: QueryPlan = { version: 2, table: 'Idx', sort: [{ col: 'Name', dir: 'desc' }], page: { size: 50 } }
      expect(await explain(desc)).toMatch(/"Index Name":"kd_idx_Name"/)
      const deepDesc = 'c2.' + Buffer.from(JSON.stringify({ s: 'Name:desc', k: ['name 2'], c: '2026-01-01T03:00:00.000Z', i: '00010000' })).toString('base64url')
      expect(await explain({ ...desc, page: { size: 50, cursor: deepDesc } })).toMatch(/"Index Name":"kd_idx_Name".*"Index Cond"/)
      const cursor = 'c2.' + Buffer.from(JSON.stringify({ s: 'Amount:asc', k: [700], c: '2026-01-01T03:00:00.000Z', i: '00010000' })).toString('base64url')
      expect(usesIndex(await explain({ ...sorted, page: { size: 50, cursor } }), 'kx_idx_Amount')).toBe(true)
    })
    it('unsorted pages and their cursors use the natural-order index', async () => {
      expect(usesIndex(await explain({ version: 2, table: 'Idx', page: { size: 50 } }), 'ix_idx_natural')).toBe(true)
      const cursor = 'c2.' + Buffer.from(JSON.stringify({ s: '', k: [], c: '2026-01-01T05:00:00.000Z', i: '00018000' })).toString('base64url')
      expect(usesIndex(await explain({ version: 2, table: 'Idx', page: { size: 50, cursor } }), 'ix_idx_natural')).toBe(true)
    })
    it('a filter on a column without an index scans; marking the column indexed creates (and unmarking drops) its key index', async () => {
      const plan: QueryPlan = { version: 2, table: 'Idx', filter: { col: 'Note', op: 'eq', value: 'note 5' }, page: { size: 50 } }
      expect(await explain(plan)).not.toMatch(/k[xd]_idx_Note/)
      const note = IDX.columns.find((x) => x.name === 'Note')!
      await c.alterColumn(IDX, note, { ...note, indexed: true })
      await raw.exec(`ANALYZE "${schema}"."idx"`)
      expect(usesIndex(await explain(plan), 'kx_idx_Note')).toBe(true)
      await c.alterColumn(IDX, { ...note, indexed: true }, note)
      expect(await explain(plan)).not.toMatch(/k[xd]_idx_Note/)
      const idx = await raw.query<{ indexname: string }>('SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY 1', [schema, 'idx'])
      expect(idx.map((r) => r.indexname)).toEqual(['idx_pkey', 'ix_idx_Customer', 'ix_idx_natural', 'ix_idx_owner', 'kd_idx_Amount', 'kd_idx_Due', 'kd_idx_Name', 'kx_idx_Amount', 'kx_idx_Code', 'kx_idx_Customer', 'kx_idx_Due', 'kx_idx_Name', 'tg_idx_Name', 'uq_idx_Code'].sort())
    })
  })
})
