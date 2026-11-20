/**
 * P2-C plan extensions on real PostgreSQL: count distinct, date buckets, groupOrder "key", top N with others. Every
 * plan of src/fx/query/testdata-agg.ts runs through the connector's queryV2 (the statement the endpoint runs) and must
 * give exactly the reference executor's rows, in the same order (measures to 12 significant digits). Runs under the
 * process time zone; CI also runs it with TZ=Asia/Kolkata and TZ=America/Los_Angeles. EXPLAIN checks that the "key"
 * path aggregates in one pass (no join back to the rows, no row numbering).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import type { ColumnDef, ColumnType, TableDef } from '../../../src/platform/contracts.ts'
import type { FxRecord, FxValue } from '../../../src/contracts.ts'
import type { QueryPlan, TableSchemaInfo } from '../../../src/platform/query.ts'
import type { QueryValue } from '../../../src/platform/http.ts'
import { checkPlan } from '../../../src/fx/query/validate.ts'
import { executePlan } from '../../../src/fx/query/reference.ts'
import { SCHEMA, ticketRows } from '../../../src/fx/query/testdata.ts'
import { aggregateCorpus } from '../../../src/fx/query/testdata-agg.ts'
import { rowsFromWire } from '../../../src/platform/query-wire.ts'
import type { Connector, ConnectionRecord, ConnectorEnv, RawRow } from '../../core/contracts.ts'
import { cellOut } from '../../core/values.ts'
import { createPostgresConnector } from './index.ts'
import { createPgDb } from './db.ts'
import type { PgDb } from './db.ts'
import { buildV2 } from './query-v2.ts'
import { PG_URL, SKIP_PG, pgServer } from '../../core/testdb.ts'

const suite = PG_URL ? describe : describe.skip
const cfg = pgServer ?? { host: '', port: 0, user: '', password: '', database: '' }
const schema = `tqa${randomBytes(3).toString('hex')}`
const env: ConnectorEnv = { workspaceDir: '', filesDir: '', fetch, log: () => {} }
const record: ConnectionRecord = {
  id: 'conn_qa', name: 'qa', connector: 'postgres', status: 'connected',
  settings: { host: cfg.host, port: String(cfg.port), database: cfg.database, user: cfg.user, ssl: 'false', schema }, secret: cfg.password,
}
const col = (name: string, type: ColumnType, extra: Partial<ColumnDef> = {}): ColumnDef => ({ name, displayName: name, type, ...extra })
const TICKETS: TableDef = {
  id: 'tbl_tickets', name: 'Tickets', displayName: 'Tickets', primaryColumn: 'Title', createdOn: '', modifiedOn: '', source: 'tickets', managed: true, missingSystem: ['modifiedOn', 'createdBy', 'owner'],
  columns: [col('id', 'text', { system: true }), col('createdOn', 'datetime', { system: true }), col('Title', 'text', { indexed: true }), col('Status', 'choice'), col('Code', 'text'), col('Owner', 'email'),
    col('Priority', 'decimal', { indexed: true }), col('Score', 'decimal'), col('Active', 'boolean'), col('Flag', 'boolean'), col('Due', 'date', { indexed: true }), col('Start', 'date'),
    col('Updated', 'datetime'), col('Blob', 'file')],
}
const INFO: TableSchemaInfo = SCHEMA.tables.Tickets!

function toRaw(r: FxRecord): RawRow {
  const out: RawRow = {}
  for (const c of TICKETS.columns) {
    const v = r[c.name] ?? null
    if (c.type === 'date' && v instanceof Date) out[c.name] = new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()))
    else out[c.name] = v as RawRow[string]
  }
  return out
}
function canon(v: FxValue): unknown {
  if (v instanceof Date) return { $t: v.getTime() }
  if (typeof v === 'number' && v !== 0) return Number(v.toPrecision(12))
  if (Array.isArray(v)) return v.map(canon)
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) o[k] = canon((v as FxRecord)[k]!)
    return o
  }
  return v
}

suite(PG_URL ? 'query v2 aggregate extensions on PostgreSQL (integration)' : `query v2 aggregate extensions on PostgreSQL ${SKIP_PG}`, () => {
  let c: Connector
  let raw: PgDb
  // the 40 sample rows plus 260 more from the same generator (other seeds), so groups and buckets are well filled
  const data: FxRecord[] = ticketRows()
  for (let k = 1; k <= 6; k++) {
    for (const r of ticketRows()) {
      const id = `${String(r.id)}_${k}`
      // calendar dates move by whole local days (stay local midnight across DST), instants by milliseconds
      const shift = (d: unknown, days: number) => (d instanceof Date ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + days) : d)
      const move = (d: unknown, days: number) => (d instanceof Date ? new Date(d.getTime() + days * 86_400_000) : d)
      data.push({ ...r, __id: id, id, createdOn: new Date((r.createdOn as Date).getTime() + k * 3_600_000), Due: shift(r.Due, k * 37) as FxValue, Start: shift(r.Start, -k * 53) as FxValue, Updated: move(r.Updated, k * 11.3) as FxValue })
    }
  }

  async function run(plan: QueryPlan): Promise<{ rows: FxRecord[]; count?: number }> {
    const checked = checkPlan(JSON.parse(JSON.stringify(plan)), INFO, 'Tickets').plan
    const res = await c.queryV2!(TICKETS, { plan: checked, visible: Object.keys(INFO.columns), maxUnpagedRows: 5000, maxGroups: 5000, timeoutMs: 15000 })
    const types = new Map(res.columns.map((x) => [x.name, x.type]))
    const wire: Record<string, QueryValue>[] = res.rows.map((r) => {
      const o: Record<string, QueryValue> = {}
      for (const [k, v] of Object.entries(r)) o[k] = cellOut({ name: k, displayName: k, type: types.get(k) ?? 'text' }, v)
      return o
    })
    return { rows: rowsFromWire(checked, wire, Object.fromEntries(TICKETS.columns.map((x) => [x.name, x.type]))), count: res.count }
  }

  beforeAll(async () => {
    raw = createPgDb({ host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user }, cfg.password)
    await raw.exec(`CREATE SCHEMA "${schema}"`)
    c = createPostgresConnector(record, env)
    await c.createTable(TICKETS)
    await c.insert(TICKETS, data.map(toRaw))
  })
  afterAll(async () => {
    await raw?.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await c?.close()
    await raw?.close()
  })

  it('every corpus plan gives the reference executor\'s rows, in order', async () => {
    const plans = aggregateCorpus()
    const mismatches: string[] = []
    for (const p of plans) {
      const checked = checkPlan(JSON.parse(JSON.stringify(p)), INFO, 'Tickets').plan
      const want = executePlan(checked, [...data].reverse(), INFO)
      let got: { rows: FxRecord[]; count?: number }
      try {
        got = await run(p)
      } catch (e) {
        mismatches.push(`${JSON.stringify(p)}\n  failed: ${(e as Error).message}`)
        continue
      }
      const a = JSON.stringify(canon(got.rows as FxValue))
      const b = JSON.stringify(canon(want.rows as FxValue))
      if (a !== b || (p.count && got.count !== want.count)) mismatches.push(`${JSON.stringify(p)}\n  pg:  ${a.slice(0, 600)}\n  ref: ${b.slice(0, 600)}`)
    }
    expect(mismatches.slice(0, 5).join('\n\n')).toBe('')
    expect(plans.length).toBeGreaterThan(250)
  }, 120_000)

  it('groupOrder "key" aggregates in one pass (no join back to the rows, no row numbering)', async () => {
    const plan = checkPlan({ version: 2, table: 'Tickets', aggregate: { groupBy: ['Status'], buckets: [{ name: 'M', col: 'Due', unit: 'month' }], measures: [{ name: 'N', fn: 'count' }, { name: 'D', fn: 'countDistinct', col: 'Owner' }], groupOrder: 'key', sort: [{ col: 'N', dir: 'desc' }] } }, INFO, 'Tickets').plan
    const st = buildV2({ icu: false, schema } as never, TICKETS, plan, { visible: Object.keys(INFO.columns), maxUnpagedRows: 5000, maxGroups: 5000 })
    expect(st.sql).not.toMatch(/row_number|DISTINCT ON|JOIN/)
    const first = checkPlan({ version: 2, table: 'Tickets', aggregate: { groupBy: ['Status'], measures: [{ name: 'N', fn: 'count' }] } }, INFO, 'Tickets').plan
    expect(buildV2({ icu: false, schema } as never, TICKETS, first, { visible: Object.keys(INFO.columns), maxUnpagedRows: 5000, maxGroups: 5000 }).sql).toMatch(/JOIN/)
  })
})
