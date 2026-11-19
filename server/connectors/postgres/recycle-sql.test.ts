/**
 * Recycle bin, pure SQL (docs/dev/recycle-bin.md): the live-row predicate is added in ONE place (buildWhere, and the
 * semi-joins it builds), so every statement of the connector carries it: v1 selects and counts, updates, deletes, Query
 * v2 rows, counts, aggregates, taken subsets and lookup paths, security semi-joins, reporting views, summary refreshes,
 * rollups. A guard over the server's source makes sure nobody adds raw SQL against data tables without it.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { TableDef } from '../../../src/platform/contracts.ts'
import {
  buildCountById, buildDeletes, buildPurge, buildRestore, buildSelect, buildSoftDeletes, buildUpdate, buildWhere, createIndexSql, createTableSql, createViewSql,
  dropIndexesSql, enableRecycleSql, keyIndexesSql, liveRowsSql, naturalIndexSql, uniqueTogetherSql,
} from './sql.ts'
import { buildV2 } from './query-v2.ts'
import { summaryRefreshSql } from '../../core/model/summary.ts'

const d = { schema: 'env_x', icu: false }
const base = (o: Partial<TableDef> = {}): TableDef => ({
  id: 'tbl_o', name: 'Orders', displayName: 'Orders', primaryColumn: 'Ref', createdOn: '', modifiedOn: '', managed: true, source: 't_orders',
  columns: [
    { name: 'Ref', displayName: 'Ref', type: 'text', unique: true },
    { name: 'Name', displayName: 'Name', type: 'text', indexed: true },
    { name: 'Cust', displayName: 'Cust', type: 'lookup', lookupTable: 'Cust' },
    { name: 'Amount', displayName: 'Amount', type: 'number' },
  ],
  ...o,
})
const bin = base({ recycleBin: true, recycleDays: 30 })
const plain = base()
const cust: TableDef = { id: 'tbl_c', name: 'Cust', displayName: 'Cust', primaryColumn: 'Name', createdOn: '', modifiedOn: '', managed: true, source: 't_cust', recycleBin: true, columns: [{ name: 'Name', displayName: 'Name', type: 'text' }] }
const LIVE = '"deletedOn" IS NULL'
const count = (sql: string, needle: string) => sql.split(needle).length - 1

describe('recycle bin: the single enforcement point', () => {
  it('liveRowsSql: only tables with the bin, qualified when asked, three scopes', () => {
    expect(liveRowsSql(plain)).toBe('TRUE')
    expect(liveRowsSql(bin)).toBe(LIVE)
    expect(liveRowsSql(bin, 'c')).toBe('c."deletedOn" IS NULL')
    expect(liveRowsSql(bin, undefined, 'deleted')).toBe('"deletedOn" IS NOT NULL')
    expect(liveRowsSql(bin, undefined, 'all')).toBe('TRUE')
  })

  it('buildWhere puts the predicate in front of every condition (also none and const true); tables without a bin unchanged', () => {
    expect(buildWhere(d, bin, undefined).sql).toBe(`(${LIVE})`)
    expect(buildWhere(d, bin, { const: true }).sql).toBe(`(${LIVE})`)
    expect(buildWhere(d, bin, { col: 'Amount', op: 'gt', value: 1 }).sql.startsWith(`(${LIVE} AND `)).toBe(true)
    expect(buildWhere(d, bin, { col: 'Amount', op: 'gt', value: 1 }, undefined, 'deleted').sql.startsWith('("deletedOn" IS NOT NULL AND ')).toBe(true)
    expect(buildWhere(d, plain, undefined).sql).toBe('TRUE')
    expect(buildWhere(d, plain, { col: 'Amount', op: 'gt', value: 1 }).sql).not.toContain('deletedOn')
  })

  it('every v1 statement carries it: select, count, update, delete, count by id; the bin statements choose their scope', () => {
    const sel = buildSelect(d, bin, { where: { col: 'Ref', op: 'eq', value: 'a' }, count: true })
    expect(sel.sql).toContain(LIVE)
    expect(sel.countSql).toContain(LIVE)
    expect(buildSelect(d, bin, {}, 'deleted').sql).toContain('"deletedOn" IS NOT NULL')
    expect(buildUpdate(d, bin, 'r1', { Amount: 1 })!.sql).toContain(LIVE)
    expect(buildCountById(d, bin, 'r1').sql).toContain(LIVE)
    expect(buildDeletes(d, bin, ['r1'])[0].sql).toContain(LIVE)
    const soft = buildSoftDeletes(d, bin, ['r1'], { id: 'del_1', by: 'u1', at: new Date(0) }, { col: 'owner', op: 'eq', value: 'u1' })[0].sql
    expect(soft).toMatch(/^UPDATE "env_x"."t_orders" SET "deletedOn" = \$2::timestamptz, "deletedBy" = \$3::text, "deleteBatch" = \$4::text WHERE "id" = ANY\(\$1::text\[\]\) AND \("deletedOn" IS NULL AND /)
    expect(soft).toMatch(/RETURNING "id"$/)
    expect(buildRestore(d, bin, 'del_1').sql).toContain('"deleteBatch" = $1::text AND "deletedOn" IS NOT NULL')
    expect(buildPurge(d, bin, 'del_1', 100).sql).toContain('"deletedOn" IS NOT NULL LIMIT 100')
  })

  it('security semi-joins (relationship rules, the regarding rule) see live rows of the rule table only', () => {
    const semi = buildWhere(d, plain, { semi: { col: 'Cust', table: cust, key: 'id', where: { col: 'Name', op: 'eq', value: 'x' } } }).sql
    expect(semi).toContain(`"env_x"."t_cust"."deletedOn" IS NULL`)
    const corr = buildWhere(d, plain, { semi: { col: 'Cust', table: cust, key: 'id', where: { const: true }, correlated: true } }).sql
    expect(corr).toMatch(/EXISTS \(SELECT 1 FROM "env_x"."t_cust" AS "__s\d+_\d+" WHERE .* AND "__s\d+_\d+"."deletedOn" IS NULL AND/)
  })

  it('Query v2: rows, count, aggregates (natural and sorted), taken subsets and lookup paths all carry it', () => {
    const o = { visible: ['id', 'Ref', 'Amount'], maxUnpagedRows: 5000, maxGroups: 5000 }
    const plans: Record<string, unknown>[] = [
      { page: { size: 50 } },
      { page: { size: 0 }, count: true },
      { count: true, page: { size: 10 } },
      { search: { text: 'a', columns: ['Ref'] }, count: true },
      { aggregate: { groupBy: [], measures: [{ name: 'S', fn: 'sum', col: 'Amount' }] } },
      { aggregate: { groupBy: ['Cust'], measures: [{ name: 'N', fn: 'count' }] } },
      { sort: [{ col: 'Amount', dir: 'desc' }], aggregate: { groupBy: ['Cust'], measures: [{ name: 'N', fn: 'count' }] } },
      { take: { n: 5, from: 'start' }, sort: [{ col: 'Amount', dir: 'asc' }] },
      { filter: { via: { col: 'Cust', table: 'Cust', where: { col: 'Name', op: 'eq', value: 'x' }, orMissing: true } } },
    ]
    for (const p of plans) {
      const st = buildV2(d, bin, { version: 2, table: 'Orders', ...p } as never, { ...o, related: { Cust: { def: cust } } })
      expect(st.sql, JSON.stringify(p)).toContain(LIVE)
      expect(buildV2(d, plain, { version: 2, table: 'Orders', ...p } as never, { ...o, related: { Cust: { def: { ...cust, recycleBin: false } } } }).sql, JSON.stringify(p)).not.toContain('deletedOn')
    }
    // the lookup path: the target's live rows in both sub-selects (hit and missing)
    const via = buildV2(d, plain, { version: 2, table: 'Orders', filter: { via: { col: 'Cust', table: 'Cust', where: { col: 'Name', op: 'eq', value: 'x' }, orMissing: true } } } as never, { ...o, related: { Cust: { def: cust } } }).sql
    expect(count(via, LIVE)).toBe(2)
  })

  it('reporting views and summary refreshes leave deleted base rows out', () => {
    const view: TableDef = { ...plain, id: 'v', name: 'FactOrders', source: 'v_factorders', reporting: { kind: 'view', role: 'fact', base: 'tbl_o', baseSource: 't_orders', baseRecycle: true, columns: [{ name: 'Amount', displayName: 'Amount', type: 'number', source: 'Amount' }] } }
    expect(createViewSql(d, view)[0]).toMatch(/FROM "env_x"."t_orders" AS b WHERE b."deletedOn" IS NULL$/)
    expect(createViewSql(d, { ...view, reporting: { ...(view.reporting as object), baseRecycle: false } as never })[0]).not.toContain('deletedOn')
    const sum: TableDef = { ...plain, id: 's', name: 'Sum', source: 't_sum', columns: [{ name: 'Cust', displayName: 'Cust', type: 'lookup' }, { name: 'N', displayName: 'N', type: 'number' }], reporting: { kind: 'summary', source: 'tbl_o', groupBy: ['Cust'], measures: [{ name: 'N', fn: 'count' }], cron: '0 * * * *' } }
    expect(summaryRefreshSql('env_x', sum, bin)[2]).toContain('FROM "env_x"."t_orders" AS s WHERE s."deletedOn" IS NULL GROUP BY')
    expect(summaryRefreshSql('env_x', sum, plain)[2]).not.toContain('deletedOn')
  })
})

describe('recycle bin: indexes', () => {
  it('unique, lookup, owner, unique pairs, key and natural-order indexes hold live rows only; the bin has its own indexes; expression statistics', () => {
    const ref = bin.columns[0]
    expect(createIndexSql(d, bin, ref, 'unique')).toMatch(/\) WHERE "deletedOn" IS NULL$/)
    expect(createIndexSql(d, bin, bin.columns[2], 'index')).toMatch(/\) WHERE "deletedOn" IS NULL$/)
    expect(createIndexSql(d, plain, bin.columns[2], 'index')).not.toContain('deletedOn')
    // the lowercased lookup / owner value keeps statistics (v1 compares it), like the unique column's
    expect(keyIndexesSql(d, bin, { name: 'owner', displayName: 'Owner', type: 'text', system: true }).create).toEqual([expect.stringContaining('"stf_t_orders_owner" ON (lower("owner"))')])
    expect(createIndexSql(d, plain, ref, 'unique')).not.toContain('deletedOn')
    expect(naturalIndexSql(d, bin)).toMatch(/WHERE "deletedOn" IS NULL$/)
    expect(uniqueTogetherSql(d, { ...bin, uniqueTogether: [['Ref', 'Cust']] })[0]).toMatch(/WHERE "deletedOn" IS NULL$/)
    const keys = keyIndexesSql(d, bin, bin.columns[1])
    expect(keys.create.filter((s) => s.startsWith('CREATE INDEX')).every((s) => s.endsWith('WHERE "deletedOn" IS NULL'))).toBe(true)
    expect(keys.create.some((s) => s.startsWith('CREATE STATISTICS IF NOT EXISTS "env_x"."stk_t_orders_Name"'))).toBe(true)
    expect(keyIndexesSql(d, bin, ref).create.some((s) => s.includes('"stf_t_orders_Ref"'))).toBe(true)
    expect(keyIndexesSql(d, plain, bin.columns[1]).create.some((s) => s.includes('STATISTICS'))).toBe(false)
    expect(dropIndexesSql(d, bin, 'Name')).toContain('DROP STATISTICS IF EXISTS "env_x"."stk_t_orders_Name"')
    const create = createTableSql(d, bin)
    expect(create[0]).toContain('"deletedOn" timestamptz(3) NULL')
    expect(create[0]).toContain('"deleteBatch" text NULL')
    expect(create.some((s) => s.includes('"ix_t_orders_deletedOn"') && s.endsWith('WHERE "deletedOn" IS NOT NULL'))).toBe(true)
    expect(createTableSql(d, plain)[0]).not.toContain('deletedOn')
  })

  it('turning the bin on: columns, every live-row index rebuilt partial under the same name, then ANALYZE', () => {
    const sql = enableRecycleSql(d, { ...bin, uniqueTogether: [['Ref', 'Cust']] })
    expect(sql.slice(0, 3)).toEqual([
      'ALTER TABLE "env_x"."t_orders" ADD COLUMN IF NOT EXISTS "deletedOn" timestamptz(3) NULL',
      'ALTER TABLE "env_x"."t_orders" ADD COLUMN IF NOT EXISTS "deletedBy" text NULL',
      'ALTER TABLE "env_x"."t_orders" ADD COLUMN IF NOT EXISTS "deleteBatch" text NULL',
    ])
    for (const name of ['uq_t_orders_Ref', 'ix_t_orders_Cust', 'ix_t_orders_owner', 'kx_t_orders_Ref', 'kx_t_orders_Name', 'kd_t_orders_Name', 'kx_t_orders_Cust', 'ix_t_orders_natural', 'uq_t_orders_pair_Ref_Cust']) {
      const at = sql.indexOf(`DROP INDEX IF EXISTS "env_x"."${name}"`)
      expect(at, name).toBeGreaterThan(0)
      expect(sql[at + 1], name).toContain(`"${name}"`)
      expect(sql[at + 1], name).toMatch(/WHERE "deletedOn" IS NULL$/)
    }
    expect(sql[sql.length - 1]).toBe('ANALYZE "env_x"."t_orders"')
  })
})

describe('recycle bin: no raw SQL against data tables without the predicate', () => {
  /**
   * Files that build SQL against data tables themselves (not through the connector), each reviewed: it either calls
   * liveRowsSql or has a reason why every row (also deleted ones) is right. A new file that does the same fails this
   * test until it is added here.
   */
  const REVIEWED: Record<string, string> = {
    'server/connectors/postgres/sql.ts': 'the builder itself (buildWhere, semi-joins, views)',
    'server/connectors/postgres/index.ts': 'the connector: statements from sql.ts; the bin statistics read deleted rows on purpose',
    'server/connectors/mysql/sql.ts': 'MySQL tables have no recycle bin',
    'server/core/table-events.ts': 'rollups (liveRowsSql on the child); row locks by id need every row',
    'server/core/model/summary.ts': 'summary refresh (liveRowsSql on the source)',
    'server/core/collab.ts': 'timeline (liveRowsSql); regarding probe and orphan sweep treat a deleted record as existing',
    'server/core/export-data.ts': 'export environment data (liveRowsSql unless the administrator includes deleted rows)',
    'server/core/backup/service.ts': 'backups and table restores copy every row (the bin included, as documented)',
    'server/core/environment-ops.ts': 'environment copy (liveRowsSql: deleted rows are not copied)',
    'server/core/system-tables.ts': 'system data copy (live rows only when the table has the columns)',
    'server/core/recycle.ts': 'the recycle bin itself',
    'server/core/diagnostics/usage.ts': 'metadata tables only (jobs)',
  }
  const root = path.resolve(import.meta.dirname, '../../..')
  const files: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p)
    }
  }
  walk(path.join(root, 'server'))
  const RAW = /(FROM|JOIN|UPDATE|INTO) \$\{(?:[^}]*(\.source|sqlTable|tableId\(|physicalName|quoteId\(def|qi\(cur\.source|S\(target|q\(table\)|q\(from\)|qi\(target\)|q\(to\))[^}]*|T|S|C|P)\}/

  it('every server file with raw SQL against a data table is reviewed', () => {
    const hits = files.filter((f) => RAW.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f).split(path.sep).join('/'))
    expect(hits.length).toBeGreaterThanOrEqual(10)
    const unknown = hits.filter((f) => !(f in REVIEWED))
    expect(unknown, 'raw SQL against data tables: use liveRowsSql (server/connectors/postgres/sql.ts) or review the file here').toEqual([])
  })

  it('the reviewed files that filter call liveRowsSql', () => {
    for (const f of ['server/core/table-events.ts', 'server/core/model/summary.ts', 'server/core/collab.ts', 'server/core/export-data.ts', 'server/core/environment-ops.ts', 'server/core/system-tables.ts']) {
      expect(fs.readFileSync(path.join(root, f), 'utf8'), f).toContain('liveRowsSql(')
    }
  })
})
