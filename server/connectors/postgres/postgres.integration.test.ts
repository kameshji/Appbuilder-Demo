/**
 * Integration tests of the PostgreSQL connector against a real server. Set APPBUILDER_TEST_DB, e.g.
 *   APPBUILDER_TEST_DB=postgres://abdev:abdev-sandbox-only@127.0.0.1:5433/appbuilder_test
 * Everything happens in a fresh schema tst<hex> of the database named in the URL (the connector runs as an external
 * connection with settings.schema), dropped with CASCADE in afterAll. Besides DDL, round trips, guards and
 * transactions, the parity block holds the SQL translation to the reference semantics of server/core/condition.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import type { ColumnDef, TableDef } from '../../../src/platform/contracts.ts'
import type { Condition, Query } from '../../../src/platform/http.ts'
import { evaluateCondition, applyQuery } from '../../core/condition.ts'
import type { Connector, ConnectionRecord, ConnectorEnv, RawRow } from '../../core/contracts.ts'
import { createPostgresConnector } from './index.ts'
import { createPgDb, mapPgError } from './db.ts'
import type { PgDb } from './db.ts'
import { buildSelect, fromDb, columnTypesByName } from './sql.ts'
import { PG_URL, SKIP_PG, pgServer } from '../../core/testdb.ts'

if (!PG_URL) console.warn(`[postgres connector] ${SKIP_PG}`)
const suite = PG_URL ? describe : describe.skip

const cfg = pgServer ?? { host: '', port: 0, user: '', password: '', database: '' }
const schema = `tst${randomBytes(3).toString('hex')}`
const logs: string[] = []
const env: ConnectorEnv = { workspaceDir: '', filesDir: '', fetch, log: (l, m) => logs.push(`${l}: ${m}`) }

const record = (over: Partial<Record<string, string>> = {}, secret = cfg.password): ConnectionRecord => ({
  id: 'conn_t', name: 't', connector: 'postgres', status: 'connected',
  settings: { host: cfg.host, port: String(cfg.port), database: cfg.database, user: cfg.user, ssl: 'false', schema, ...over }, secret,
})
const col = (name: string, type: ColumnDef['type'], extra: Partial<ColumnDef> = {}): ColumnDef => ({ name, displayName: name, type, ...extra })
let seq = 0
const mkdef = (cols: ColumnDef[], name = `tbl${++seq}`): TableDef => ({
  id: `tbl_${name}`, name, displayName: name, primaryColumn: cols[0]?.name ?? 'id', columns: cols, createdOn: '', modifiedOn: '',
  source: name,
})
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ids = (rows: RawRow[]): string[] => rows.map((r) => r.id as string).sort()
const sys = (n: number): RawRow => ({ id: uuid(n), createdOn: new Date('2024-01-01T00:00:00Z'), modifiedOn: new Date('2024-01-02T00:00:00Z'), createdBy: 'u1', owner: n % 2 ? 'u1' : 'u2' })
const Q = (t: string) => `"${schema}"."${t}"`

suite(PG_URL ? 'postgres connector (integration)' : `postgres connector (integration) ${SKIP_PG}`, () => {
  let c: Connector
  let raw: PgDb

  beforeAll(async () => {
    raw = createPgDb({ host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user }, cfg.password)
    await raw.exec(`CREATE SCHEMA "${schema}"`)
    c = createPostgresConnector(record(), env)
  })
  afterAll(async () => {
    await raw?.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await c?.close()
    await raw?.close()
  })

  it('test() connects and reports the server version and schema', async () => {
    const r = await c.test()
    expect(r.ok, r.message).toBe(true)
    expect(r.message).toMatch(new RegExp(`Connected to PostgreSQL \\d+(\\.\\d+)* at .* \\(schema ${schema}\\)`))
    expect(r.message).not.toContain(cfg.password)
  })

  it('test() explains bad credentials, missing database, missing schema, refused connection', async () => {
    const bad = await createPostgresConnector(record({}, 'definitely-wrong-pw'), env).test()
    expect(bad.ok).toBe(false)
    expect(bad.message).toMatch(/wrong user name or password/)
    expect(bad.message).not.toContain('definitely-wrong-pw')
    const nodb = await createPostgresConnector(record({ database: cfg.database + '_missing_db' }), env).test()
    expect(nodb.ok).toBe(false)
    expect(nodb.message).toMatch(/does not exist/)
    const noschema = await createPostgresConnector(record({ schema: 'no_such_schema' }), env).test()
    expect(noschema.ok).toBe(false)
    expect(noschema.message).toMatch(/schema "no_such_schema" does not exist/)
    const refused = await createPostgresConnector(record({ port: '1', host: '127.0.0.1' }), env).test()
    expect(refused.ok).toBe(false)
    expect(refused.message).toMatch(/refused/)
    const incomplete = await createPostgresConnector({ ...record(), settings: {} }, env).test()
    expect(incomplete.ok).toBe(false)
  })

  describe('SqlDb', () => {
    it('serverVersion, query, exec; every pooled connection has the fixed search_path and UTC', async () => {
      expect(await raw.serverVersion()).toMatch(/^PostgreSQL \d+/)
      await raw.exec(`CREATE TABLE ${Q('sqldb')} (id serial PRIMARY KEY, v text)`)
      const r = await raw.exec(`INSERT INTO ${Q('sqldb')} (v) VALUES ($1), ($2)`, ['a', 'b'])
      expect(r.affectedRows).toBe(2)
      expect(await raw.query(`SELECT v FROM ${Q('sqldb')} WHERE v = ANY($1::text[]) ORDER BY v`, [['a', 'b']])).toEqual([{ v: 'a' }, { v: 'b' }])
      const paths = await Promise.all(Array.from({ length: 12 }, () => raw.query<{ p: string; tz: string }>("SELECT current_setting('search_path') AS p, current_setting('TimeZone') AS tz")))
      for (const [row] of paths) expect(row).toEqual({ p: 'pg_catalog,pg_temp', tz: 'UTC' })
      // an unqualified table name fails instead of resolving somewhere
      await expect(raw.query('SELECT * FROM sqldb')).rejects.toMatchObject({ code: '42P01' })
    })
    it('a session-level SET inside a transaction never reaches the next user of the pooled connection', async () => {
      // SET LOCAL ends with the transaction; even a plain SET is reset on ROLLBACK when it was made inside the transaction
      await raw.tx(async (t) => { await t.exec('SET LOCAL search_path = public') })
      await expect(raw.tx(async (t) => { await t.exec('SET search_path = public'); throw new Error('boom') })).rejects.toThrow('boom')
      const after = await Promise.all(Array.from({ length: 12 }, () => raw.query<{ p: string }>("SELECT current_setting('search_path') AS p")))
      for (const [row] of after) expect(row.p).toBe('pg_catalog,pg_temp')
    })
    it('tx commits and rolls back on one connection; nested tx is a savepoint; ambient calls join', async () => {
      const t = Q('sqldb')
      await raw.tx(async (db) => { await db.exec(`INSERT INTO ${t} (v) VALUES ('committed')`) })
      await expect(raw.tx(async (db) => {
        await db.exec(`INSERT INTO ${t} (v) VALUES ('rolled')`)
        expect((await db.query(`SELECT v FROM ${t} WHERE v = 'rolled'`)).length).toBe(1)
        throw new Error('boom')
      })).rejects.toThrow('boom')
      expect((await raw.query(`SELECT v FROM ${t} WHERE v = 'committed'`)).length).toBe(1)
      expect((await raw.query(`SELECT v FROM ${t} WHERE v = 'rolled'`)).length).toBe(0)
      // nested: the inner failure rolls back only the inner statements
      await raw.tx(async (db) => {
        await db.exec(`INSERT INTO ${t} (v) VALUES ('outer')`)
        await expect(db.tx(async (d2) => { await d2.exec(`INSERT INTO ${t} (v) VALUES ('inner')`); throw new Error('inner') })).rejects.toThrow('inner')
      })
      expect((await raw.query(`SELECT v FROM ${t} WHERE v IN ('outer', 'inner') ORDER BY v`))).toEqual([{ v: 'outer' }])
      // ambient: a pool-level call inside tx() joins it (invisible to others until COMMIT), and a caught failure
      // of such a call does not abort the transaction
      await expect(raw.tx(async () => {
        await raw.exec(`INSERT INTO ${t} (v) VALUES ('ambient')`)
        expect(raw.inTransaction()).toBe(true)
        await raw.exec(`INSERT INTO ${t} (id, v) VALUES (1, 'duplicate id')`).catch(() => {})
        expect((await raw.query(`SELECT v FROM ${t} WHERE v = 'ambient'`)).length).toBe(1)
        const outside = await createPgDb({ host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user }, cfg.password)
        try { expect((await outside.query(`SELECT v FROM ${t} WHERE v = 'ambient'`)).length).toBe(0) } finally { await outside.close() }
        throw new Error('undo')
      })).rejects.toThrow('undo')
      expect((await raw.query(`SELECT v FROM ${t} WHERE v = 'ambient'`)).length).toBe(0)
      expect(raw.inTransaction()).toBe(false)
    })
  })

  describe('DDL and round trip of every column type', () => {
    const cols: ColumnDef[] = [
      col('f_text', 'text'), col('f_multi', 'multiline'), col('f_email', 'email'), col('f_url', 'url'), col('f_phone', 'phone'),
      col('f_number', 'number'), col('f_decimal', 'decimal'), col('f_currency', 'currency'), col('f_bool', 'boolean'),
      col('f_date', 'date'), col('f_dt', 'datetime'), col('f_choice', 'choice', { choices: ['a', 'b'] }), col('f_lookup', 'lookup'),
      col('f_image', 'image'), col('f_file', 'file'), col('f_auto', 'autonumber'),
    ]
    const def = mkdef(cols, 'alltypes')
    it('creates the table with the mapped SQL types and indexes', async () => {
      await c.createTable({ ...def, columns: def.columns.map((x) => (x.name === 'f_email' ? { ...x, unique: true } : x)) })
      const info = await raw.query<{ n: string; t: string }>('SELECT attname AS n, format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped', [`${schema}.alltypes`])
      const t = Object.fromEntries(info.map((r) => [r.n, r.t]))
      expect(t).toMatchObject({
        id: 'text', createdOn: 'timestamp(3) with time zone', owner: 'text', f_text: 'character varying(255)', f_url: 'character varying(1024)',
        f_multi: 'text', f_number: 'bigint', f_decimal: 'double precision', f_currency: 'numeric(19,4)', f_bool: 'boolean', f_date: 'date',
        f_dt: 'timestamp(3) with time zone', f_lookup: 'text', f_image: 'text', f_auto: 'character varying(64)',
      })
      const idx = await raw.query<{ n: string; d: string }>('SELECT indexname AS n, indexdef AS d FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY 1', [schema, 'alltypes'])
      expect(idx.map((r) => r.n)).toEqual(['alltypes_pkey', 'ix_alltypes_f_lookup', 'ix_alltypes_owner', 'uq_alltypes_f_email'])
      expect(idx.find((r) => r.n === 'uq_alltypes_f_email')!.d).toMatch(/UNIQUE INDEX .* \(lower/)
    })
    it('round-trips every type', async () => {
      const row: RawRow = {
        ...sys(1), f_text: 'héllo ✓ 日本', f_multi: 'line1\nline2 ' + 'x'.repeat(5000), f_email: 'a@b.co', f_url: 'https://x.test/' + 'p'.repeat(500),
        f_phone: '+91 98765 43210', f_number: 9007199254740, f_decimal: 3.14159265, f_currency: 1234567.8912, f_bool: true,
        f_date: new Date('2024-02-29T00:00:00Z'), f_dt: new Date('2024-02-29T13:14:15.678Z'), f_choice: 'b', f_lookup: uuid(99),
        f_image: 'att_1', f_file: '["a","b"]', f_auto: 'INV-0001',
      }
      const nulls: RawRow = { id: uuid(2) }
      await c.insert(def, [row, nulls])
      const { rows, total } = await c.select(def, { orderBy: [{ col: 'id', dir: 'asc' }], count: true })
      expect(total).toBe(2)
      expect(rows[0]).toEqual({ ...row, f_currency: 1234567.8912 })
      expect(rows[0].f_dt).toBeInstanceOf(Date)
      expect(rows[0].f_bool).toBe(true)
      for (const k of Object.keys(rows[1])) if (k !== 'id') expect(rows[1][k], k).toBeNull()
      await c.update(def, uuid(1), { f_bool: false, f_number: -5 })
      const back = (await c.select(def, { where: { col: 'id', op: 'eq', value: uuid(1) } })).rows[0]
      expect(back.f_bool).toBe(false)
      expect(back.f_number).toBe(-5)
      // dates are calendar days whatever the client time zone
      expect((back.f_date as Date).toISOString()).toBe('2024-02-29T00:00:00.000Z')
    })
    it('enforces unique columns case-insensitively with a conflict error', async () => {
      await c.insert(def, [{ id: uuid(10), f_email: 'dup@x.co' }])
      await expect(c.insert(def, [{ id: uuid(11), f_email: 'DUP@x.co' }])).rejects.toMatchObject({ code: 'conflict' })
    })
    it('stores values literally (no injection), refuses NUL characters and bad identifiers', async () => {
      const evil = "'; DROP TABLE x; -- \\ % $1 ?"
      await c.insert(def, [{ id: uuid(12), f_text: evil }])
      const r = await c.select(def, { where: { col: 'f_text', op: 'eq', value: evil } })
      expect(r.rows.map((x) => x.f_text)).toEqual([evil])
      await expect(c.insert(def, [{ id: uuid(14), f_text: 'a\u0000b' }])).rejects.toMatchObject({ status: 422, code: 'invalid' })
      await expect(c.select(def, { where: { col: 'f_text"', op: 'eq', value: 1 } })).rejects.toThrow()
      await expect(c.insert(def, [{ id: uuid(13), bogus: 1 } as RawRow])).rejects.toThrow(/Unknown column/)
    })
    it('selects a subset with id always present, with top/skip and count', async () => {
      const r = await c.select(def, { select: ['f_text'], orderBy: [{ col: 'id', dir: 'asc' }], top: 2, skip: 1, count: true })
      expect(r.total).toBeGreaterThanOrEqual(4)
      expect(r.rows.length).toBe(2)
      expect(Object.keys(r.rows[0]).sort()).toEqual(['f_text', 'id'])
      const tail = await c.select(def, { select: ['id'], orderBy: [{ col: 'id', dir: 'asc' }], skip: 3 })
      expect(tail.rows.length).toBe((r.total as number) - 3)
    })
    it('maps the table back through describe() and listSourceTables()', async () => {
      const d = await c.describe(def.source as string)
      const t = Object.fromEntries(d.map((x) => [x.name, x.type]))
      expect(t).toMatchObject({
        id: 'multiline', createdOn: 'datetime', f_text: 'text', f_multi: 'multiline', f_number: 'number', f_decimal: 'decimal',
        f_currency: 'currency', f_bool: 'boolean', f_date: 'date', f_dt: 'datetime', f_lookup: 'multiline', f_image: 'multiline',
      })
      const all = await c.listSourceTables()
      const mine = all.find((x) => x.source === def.source)
      expect(mine).toBeTruthy()
      expect(mine?.rowCount).toBeGreaterThanOrEqual(4)
      expect(mine?.columns.length).toBe(5 + cols.length)
    })
  })

  describe('listSourceTables / describe on foreign tables', () => {
    it('reads a hand-made table and hides platform tables', async () => {
      await raw.exec(`CREATE TYPE "${schema}".kind_t AS ENUM ('a', 'b')`)
      await raw.exec(`CREATE TABLE ${Q('foreign_t')} (id varchar(40) PRIMARY KEY, qty integer, flag boolean, price numeric(10,2), born date, seen timestamp NULL, note text, kind "${schema}".kind_t, tag uuid)`)
      const d = Object.fromEntries((await c.describe('foreign_t')).map((x) => [x.name, x.type]))
      expect(d).toEqual({ id: 'text', qty: 'number', flag: 'boolean', price: 'decimal', born: 'date', seen: 'datetime', note: 'multiline', kind: 'choice', tag: 'text' })
      await expect(c.describe('nope')).rejects.toMatchObject({ code: 'not-found' })
      await expect(c.describe('ab_users')).rejects.toMatchObject({ code: 'denied' })
      await raw.exec(`CREATE TABLE ${Q('ab_zz_probe')} (id int)`)
      expect((await c.listSourceTables()).some((x) => x.source.startsWith('ab_'))).toBe(false)
    })
    it('queries a foreign table: case-insensitive id and text, timestamp without time zone read as UTC', async () => {
      const def: TableDef = { ...mkdef([col('qty', 'number'), col('note', 'multiline'), col('seen', 'datetime')], 'foreign_t'), source: 'foreign_t' }
      await raw.exec(`INSERT INTO ${Q('foreign_t')} (id, qty, note, seen) VALUES ('k1', 3, 'Hello World', '2024-05-01 10:00:00'), ('k2', 4, 'other', NULL)`)
      const r = await c.select(def, { where: { and: [{ col: 'note', op: 'contains', value: 'hello' }, { col: 'id', op: 'eq', value: 'K1' }] }, select: ['qty', 'seen'] })
      expect(r.rows).toEqual([{ qty: 3, seen: new Date('2024-05-01T10:00:00Z'), id: 'k1' }])
    })
  })

  describe('schema changes (transactional)', () => {
    it('addColumn / alterColumn / dropColumn / dropTable', async () => {
      const def = mkdef([col('name', 'text'), col('qty', 'number')], 'alter_t')
      await c.createTable(def)
      await c.insert(def, [{ id: uuid(1), name: 'a', qty: 5 }])
      const withNew = { ...def, columns: [...def.columns, col('ref', 'lookup'), col('code', 'text', { unique: true })] }
      await c.addColumn(withNew, col('ref', 'lookup'))
      await c.addColumn(withNew, col('code', 'text', { unique: true }))
      const idx = async () => (await raw.query<{ n: string }>('SELECT indexname AS n FROM pg_indexes WHERE schemaname = $1 AND tablename = $2', [schema, 'alter_t'])).map((r) => r.n).sort()
      expect(await idx()).toEqual(['alter_t_pkey', 'ix_alter_t_owner', 'ix_alter_t_ref', 'uq_alter_t_code'])
      // type change number -> decimal, rename, drop unique
      await c.alterColumn(withNew, col('qty', 'number'), col('qty', 'decimal'))
      await c.update(withNew, uuid(1), { qty: 2.5 })
      expect((await c.select(withNew, { select: ['qty'] })).rows[0].qty).toBe(2.5)
      await c.alterColumn(withNew, col('code', 'text', { unique: true }), col('code2', 'text'))
      expect(await idx()).toEqual(['alter_t_pkey', 'ix_alter_t_owner', 'ix_alter_t_ref'])
      await c.alterColumn(withNew, col('ref', 'lookup'), col('ref', 'text'))
      expect(await idx()).toEqual(['alter_t_pkey', 'ix_alter_t_owner'])
      await c.alterColumn(withNew, col('code2', 'text'), col('code2', 'text', { unique: true }))
      expect(await idx()).toEqual(['alter_t_pkey', 'ix_alter_t_owner', 'uq_alter_t_code2'])
      await c.dropColumn(withNew, 'qty')
      const cols = (await c.describe(def.source as string)).map((x) => x.name)
      expect(cols).not.toContain('qty')
      await c.dropTable(def)
      await expect(c.describe(def.source as string)).rejects.toMatchObject({ code: 'not-found' })
      await c.dropTable(def) // idempotent
    })
    it('type conversions: text <-> number / boolean / date / datetime, number -> text like JavaScript', async () => {
      const def = mkdef([col('a', 'text'), col('b', 'text'), col('c', 'text'), col('d', 'text'), col('n', 'currency'), col('f', 'boolean')], 'conv_t')
      await c.createTable(def)
      await c.insert(def, [{ id: uuid(1), a: ' 42 ', b: 'yes', c: '2024-03-01', d: '2024-03-01T10:00:00Z', n: 12.5, f: true }, { id: uuid(2) }])
      const steps: [string, ColumnDef['type'], ColumnDef['type']][] = [['a', 'text', 'number'], ['b', 'text', 'boolean'], ['c', 'text', 'date'], ['d', 'text', 'datetime'], ['n', 'currency', 'text'], ['f', 'boolean', 'text']]
      let cur = def
      for (const [name, from, to] of steps) {
        const next = { ...cur, columns: cur.columns.map((x) => (x.name === name ? { ...x, type: to } : x)) }
        await c.alterColumn(next, col(name, from), col(name, to))
        cur = next
      }
      const r = (await c.select(cur, { orderBy: [{ col: 'id', dir: 'asc' }] })).rows
      expect(r[0]).toMatchObject({ a: 42, b: true, c: new Date('2024-03-01T00:00:00Z'), d: new Date('2024-03-01T10:00:00Z'), n: '12.5', f: 'true' })
      expect(r[1]).toMatchObject({ a: null, b: null, c: null, d: null, n: null, f: null })
    })
    it('a failing step rolls the whole schema change back', async () => {
      const def = mkdef([col('a', 'text')], 'conv_fail')
      await c.createTable(def)
      await c.insert(def, [{ id: uuid(1), a: 'not a number' }])
      const next = { ...def, columns: [col('a', 'number', { unique: true })] }
      await expect(c.alterColumn(next, col('a', 'text', { unique: true }), col('a', 'number', { unique: true }))).rejects.toMatchObject({ status: 422 })
      const t = (await c.describe('conv_fail')).find((x) => x.name === 'a')
      expect(t?.type).toBe('text')
      // createTable is one transaction too: a clash leaves nothing half-made
      await expect(c.createTable({ ...def, columns: [col('a', 'text'), col('A', 'text')] })).rejects.toThrow(/Duplicate/)
    })
    it('createTable twice is a conflict; ab_ sources are refused', async () => {
      const def = mkdef([col('a', 'text')], 'twice')
      await c.createTable(def)
      await expect(c.createTable(def)).rejects.toMatchObject({ code: 'conflict' })
      await expect(c.createTable({ ...def, source: 'ab_evil' })).rejects.toMatchObject({ code: 'denied' })
      await expect(c.select({ ...def, source: 'ab_users' }, {})).rejects.toMatchObject({ code: 'denied' })
    })
    it('connector.transaction: DDL and rows commit together or not at all', async () => {
      const def = mkdef([col('a', 'text')], 'tx_t')
      await expect(c.transaction!(async (t) => {
        await t.createTable(def)
        await t.insert(def, [{ id: uuid(1), a: 'x' }])
        expect((await t.select(def, { count: true })).total).toBe(1)
        throw new Error('rollback')
      })).rejects.toThrow('rollback')
      await expect(c.describe('tx_t')).rejects.toMatchObject({ code: 'not-found' })
      await c.transaction!(async (t) => { await t.createTable(def); await t.insert(def, [{ id: uuid(1), a: 'x' }]) })
      expect((await c.select(def, { count: true })).total).toBe(1)
    })
    it('ensureSystemColumns: adds the system columns, fills id with UUIDv7 in row order, in one transaction', async () => {
      await raw.exec(`CREATE TABLE ${Q('legacy_t')} (client_no integer PRIMARY KEY, name varchar(50))`)
      await raw.exec(`INSERT INTO ${Q('legacy_t')} VALUES (1, 'A'), (2, 'B'), (3, 'C')`)
      const r = await c.ensureSystemColumns!('legacy_t')
      expect(r).toEqual({ added: ['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner'], filled: 3 })
      const rows = await raw.query<{ id: string; createdOn: Date }>(`SELECT id, "createdOn" FROM ${Q('legacy_t')} ORDER BY client_no`)
      for (const x of rows) expect(x.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(rows.map((x) => x.id)).toEqual([...rows.map((x) => x.id)].sort())
      expect(await c.ensureSystemColumns!('legacy_t')).toEqual({ added: [], filled: 0 })
    })
  })

  describe('update / delete with guard', () => {
    const def = mkdef([col('name', 'text'), col('qty', 'number')], 'guard')
    beforeAll(async () => {
      await c.createTable(def)
      await c.insert(def, [1, 2, 3, 4].map((n) => ({ ...sys(n), name: 'row' + n, qty: n })))
    })
    it('update honours the guard and returns the affected count', async () => {
      expect(await c.update(def, uuid(1), { qty: 10 }, { col: 'owner', op: 'eq', value: 'u1' })).toBe(1)
      expect(await c.update(def, uuid(2), { qty: 20 }, { col: 'owner', op: 'eq', value: 'u1' })).toBe(0) // owned by u2
      expect(await c.update(def, uuid(2), { qty: 20 }, { const: false })).toBe(0)
      expect(await c.update(def, uuid(2), { qty: 20 }, { const: true })).toBe(1)
      expect(await c.update(def, uuid(404), { qty: 1 })).toBe(0)
      expect(await c.update(def, uuid(2), { qty: 20 })).toBe(1) // same values still count as matched
      expect(await c.update(def, uuid(3), {}, { col: 'owner', op: 'eq', value: 'u1' })).toBe(1) // empty change = existence check
      expect(await c.update(def, uuid(4), {}, { col: 'owner', op: 'eq', value: 'u1' })).toBe(0)
      const r = await c.select(def, { orderBy: [{ col: 'qty', dir: 'asc' }], select: ['qty'] })
      expect(r.rows.map((x) => x.qty)).toEqual([3, 4, 10, 20])
    })
    it('a NULL guard operand denies (never allows)', async () => {
      expect(await c.update(def, uuid(3), { qty: 33 }, { col: 'qty', op: 'gt', value: 100 })).toBe(0)
      expect(await c.update(def, uuid(3), { name: 'x' }, { not: { col: 'owner', op: 'isBlank' } })).toBe(1)
    })
    it('delete honours the guard', async () => {
      expect(await c.delete(def, [uuid(1), uuid(2), uuid(3)], { col: 'owner', op: 'eq', value: 'u1' })).toBe(2) // 1 and 3
      expect(await c.delete(def, [uuid(4)], { const: false })).toBe(0)
      expect(await c.delete(def, [])).toBe(0)
      expect(await c.delete(def, [uuid(2), uuid(4), uuid(404)])).toBe(2)
      expect((await c.select(def, {})).rows.length).toBe(0)
    })
    it('inserts many rows (chunked, transactional)', async () => {
      const rows: RawRow[] = Array.from({ length: 1234 }, (_, i) => ({ id: uuid(1000 + i), name: 'bulk' + i, qty: i }))
      await c.insert(def, rows)
      expect((await c.select(def, { count: true, top: 1 })).total).toBe(1234)
      // a failing chunk rolls everything back
      const dup = Array.from({ length: 600 }, (_, i) => ({ id: i === 599 ? uuid(1000) : uuid(5000 + i), qty: 1 }))
      await expect(c.insert(def, dup)).rejects.toMatchObject({ code: 'conflict' })
      expect((await c.select(def, { count: true, top: 1 })).total).toBe(1234)
      expect(await c.delete(def, rows.map((r) => r.id as string))).toBe(1234)
    })
    it('default order is createdOn, id (insertion order)', async () => {
      const t0 = new Date('2024-06-01T00:00:00Z')
      const rows: RawRow[] = [3, 1, 2].map((n, i) => ({ id: uuid(n), createdOn: new Date(t0.getTime() + (i < 2 ? 0 : 1000)), name: `o${n}`, qty: n }))
      await c.insert(def, rows)
      const listed = { ...def, columns: [col('id', 'text', { system: true }), col('createdOn', 'datetime', { system: true }), ...def.columns] }
      expect((await c.select(listed, { select: ['name'] })).rows.map((r) => r.name)).toEqual(['o1', 'o3', 'o2'])
      await c.delete(def, rows.map((r) => r.id as string))
    })
  })

  describe('parity: SQL vs evaluateCondition', () => {
    const def = mkdef([
      col('name', 'text'), col('tn', 'text'), col('mixed', 'text'), col('num', 'number'), col('amt', 'decimal'), col('price', 'currency'),
      col('flag', 'boolean'), col('d', 'date'), col('dt', 'datetime'), col('kind', 'choice'),
    ], 'parity')
    const managed: TableDef = { ...def, managed: true }
    const T = (s: string) => new Date(s)
    const data: RawRow[] = [
      { name: 'Alpha', tn: '10', mixed: 'abc', num: 1, amt: 1.5, price: 9.99, flag: true, d: T('2024-01-15T00:00:00Z'), dt: T('2024-01-15T08:00:00.000Z'), kind: 'red' },
      { name: 'alpha beta', tn: '9', mixed: 'ABC def', num: 2, amt: 2.25, price: 10, flag: false, d: T('2024-02-20T00:00:00Z'), dt: T('2024-02-20T12:30:45.123Z'), kind: 'Green' },
      { name: 'Beta', tn: '2.5', mixed: 'def', num: 3, amt: -0.5, price: 0.5, flag: true, d: T('2024-03-01T00:00:00Z'), dt: T('2024-03-01T10:00:00.000Z'), kind: 'blue' },
      { name: 'gamma', tn: '007', mixed: '100% sure', num: 5, amt: 0, price: 100, flag: null, d: null, dt: null, kind: null },
      { name: '', tn: '', mixed: '', num: 10, amt: null, price: null, flag: false, d: T('2024-01-31T00:00:00Z'), dt: T('2024-01-31T23:59:59.999Z'), kind: '' },
      { name: null, tn: null, mixed: null, num: null, amt: null, price: null, flag: null, d: null, dt: null, kind: null },
      { name: 'a%b', tn: '-4', mixed: 'a_b', num: -4, amt: 100, price: 0, flag: true, d: T('2023-12-31T00:00:00Z'), dt: T('2023-12-31T00:00:00.000Z'), kind: 'red' },
      { name: 'a_b', tn: '3', mixed: 'a\\b', num: 0, amt: 2.25, price: 10, flag: false, d: T('2024-02-20T00:00:00Z'), dt: T('2024-02-20T12:30:45.123Z'), kind: 'RED' },
      { name: 'a!b', tn: '.5', mixed: 'a!b', num: 7, amt: 1e3, price: 1234.5678, flag: true, d: T('2025-06-30T00:00:00Z'), dt: T('2025-06-30T18:00:00.000Z'), kind: 'blue' },
      { name: 'Zed', tn: '1', mixed: 'zed', num: 3, amt: 3, price: 3, flag: true, d: T('2024-03-01T00:00:00Z'), dt: T('2024-03-01T10:00:01.000Z'), kind: 'green' },
      // PostgreSQL additions: non-ASCII case folding, numeric-looking text in more notations, tiny/huge decimals
      { name: 'Ärger', tn: ' 42 ', mixed: 'ΣΑΣ', num: 9007199254740, amt: 0.00001, price: 12.5, flag: true, d: T('1999-12-31T00:00:00Z'), dt: T('1999-12-31T23:00:00.000Z'), kind: 'Ünïcode' },
      { name: 'İstanbul', tn: '1e3', mixed: 'straße', num: -1, amt: 1e16, price: 0.0001, flag: false, d: T('2024-02-29T00:00:00Z'), dt: T('2024-02-29T00:00:00.000Z'), kind: 'ünïcode' },
      { name: 'zeta', tn: '+7', mixed: 'Infinity', num: 42, amt: 1e-7, price: 99999.9999, flag: null, d: T('2024-06-15T00:00:00Z'), dt: T('2024-06-15T06:07:08.009Z'), kind: 'zz' },
      { name: 'ZETA', tn: '1.', mixed: '0', num: 42, amt: -1e21, price: -7, flag: true, d: T('2024-06-15T00:00:00Z'), dt: T('2024-06-15T06:07:08.010Z'), kind: 'ZZ' },
    ].map((r, i) => ({ ...sys(i + 1), ...r }) as RawRow)

    const C = (col: string, op: string, value?: unknown): Condition => ({ col, op, value } as Condition)
    const conditions: [string, Condition][] = [
      ['const true', { const: true }], ['const false', { const: false }], ['and []', { and: [] }], ['or []', { or: [] }],
      ['eq text', C('name', 'eq', 'alpha')], ['eq text case', C('name', 'eq', 'ALPHA BETA')], ['eq null', C('name', 'eq', null)],
      ['ne text', C('name', 'ne', 'alpha')], ['ne null', C('name', 'ne', null)], ['eq empty string', C('name', 'eq', '')], ['ne empty string', C('name', 'ne', '')],
      ['isBlank text', C('name', 'isBlank')], ['notBlank text', C('name', 'notBlank')], ['isBlank num', C('num', 'isBlank')], ['notBlank date', C('d', 'notBlank')],
      ['isBlank bool', C('flag', 'isBlank')], ['isBlank choice', C('kind', 'isBlank')],
      ['contains', C('name', 'contains', 'ALPH')], ['contains %', C('name', 'contains', '%')], ['contains _', C('name', 'contains', '_')],
      ['contains !', C('name', 'contains', '!')], ['contains backslash', C('mixed', 'contains', '\\')], ['contains 100%', C('mixed', 'contains', '100%')],
      ['contains empty', C('name', 'contains', '')], ['contains undefined', C('name', 'contains')], ['startsWith', C('name', 'startsWith', 'a')],
      ['startsWith %', C('name', 'startsWith', 'a%')], ['endsWith', C('name', 'endsWith', 'BETA')], ['endsWith _', C('mixed', 'endsWith', '_b')],
      ['contains on number', C('num', 'contains', '1')], ['startsWith on number', C('num', 'startsWith', '1')], ['contains on bool', C('flag', 'contains', 'tru')],
      ['lt text', C('name', 'lt', 'b')], ['ge text', C('name', 'ge', 'beta')], ['gt text', C('kind', 'gt', 'green')], ['le text', C('kind', 'le', 'green')],
      ['eq num', C('num', 'eq', 3)], ['eq num as text', C('num', 'eq', '3')], ['ne num', C('num', 'ne', 3)], ['lt num', C('num', 'lt', 3)],
      ['le num', C('num', 'le', '3')], ['gt num', C('num', 'gt', 0)], ['ge num neg', C('num', 'ge', -4)], ['gt num null value', C('num', 'gt', null)],
      ['eq decimal', C('amt', 'eq', 2.25)], ['gt decimal', C('amt', 'gt', 1.5)], ['lt decimal', C('amt', 'lt', 0)], ['ge currency', C('price', 'ge', 10)],
      ['eq currency', C('price', 'eq', 9.99)], ['lt currency text', C('price', 'lt', '1')], ['eq big decimal', C('amt', 'eq', 1000)],
      ['eq bool true', C('flag', 'eq', true)], ['eq bool false', C('flag', 'eq', false)], ['ne bool true', C('flag', 'ne', true)], ['in bool', C('flag', 'in', [true])],
      ['text numbers gt', C('tn', 'gt', 5)], ['text numbers lt', C('tn', 'lt', 3)], ['text numbers ge', C('tn', 'ge', 2.5)], ['text numbers eq', C('tn', 'eq', 7)],
      ['text numbers eq text', C('tn', 'eq', '10')], ['text numbers ne', C('tn', 'ne', 10)], ['text numbers le', C('tn', 'le', 1)],
      ['mixed gt number', C('mixed', 'gt', 5)],
      ['date eq', C('d', 'eq', '2024-02-20')], ['date gt', C('d', 'gt', '2024-01-31')], ['date ge', C('d', 'ge', '2024-01-31')], ['date lt with time', C('d', 'lt', '2024-02-20T12:00:00Z')],
      ['date le with time', C('d', 'le', '2024-02-20T12:00:00Z')], ['date ne', C('d', 'ne', '2024-02-20')], ['date in', C('d', 'in', ['2024-01-15', '2025-06-30T00:00:00Z'])],
      ['datetime eq ms', C('dt', 'eq', '2024-02-20T12:30:45.123Z')], ['datetime ge', C('dt', 'ge', '2024-03-01T10:00:00Z')], ['datetime lt', C('dt', 'lt', '2024-01-31T23:59:59.999Z')],
      ['datetime gt offset', C('dt', 'gt', '2024-03-01T15:30:00+05:30')], ['datetime in', C('dt', 'in', ['2024-01-15T08:00:00Z', '2025-06-30T18:00:00.000Z'])],
      ['datetime date-only value', C('dt', 'ge', '2024-02-20')], ['datetime ne', C('dt', 'ne', '2024-02-20T12:30:45.123Z')],
      ['in text', C('name', 'in', ['alpha', 'BETA'])], ['in text with blank', C('name', 'in', ['', null, 'gamma'])], ['in choice', C('kind', 'in', ['RED', 'blue'])],
      ['in num', C('num', 'in', [1, '2', null, 10])], ['in empty', C('num', 'in', [])], ['in decimal', C('amt', 'in', [2.25, 0])], ['in text numbers', C('tn', 'in', [10, 3])],
      ['and', { and: [C('num', 'gt', 0), C('flag', 'eq', true)] }], ['or', { or: [C('name', 'eq', 'gamma'), C('num', 'lt', 0)] }],
      ['not eq', { not: C('num', 'eq', 3) }], ['not gt (blank rows)', { not: C('num', 'gt', 2) }], ['not isBlank', { not: C('name', 'isBlank') }],
      ['not not', { not: { not: C('num', 'gt', 2) } }], ['not contains', { not: C('name', 'contains', 'a') }],
      ['not and', { not: { and: [C('num', 'gt', 2), C('flag', 'eq', true)] } }], ['not or', { not: { or: [C('num', 'gt', 5), C('flag', 'eq', false)] } }],
      ['not date lt', { not: C('d', 'lt', '2024-02-01') }], ['not text lt', { not: C('name', 'lt', 'b') }], ['not const', { not: { const: false } }],
      ['nested', { and: [{ or: [C('name', 'startsWith', 'a'), C('kind', 'eq', 'GREEN')] }, { not: { and: [C('flag', 'eq', false), C('num', 'lt', 1)] } }, C('d', 'ge', '2024-01-01')] }],
      ['nested with const', { or: [{ and: [{ const: true }, C('num', 'eq', 7)] }, { and: [{ const: false }, C('num', 'eq', 1)] }] }],
      ['rls-like', { or: [{ and: [C('owner', 'eq', 'u1'), C('num', 'ge', 0)] }, C('createdBy', 'eq', 'nobody')] }],
      ['id eq', C('id', 'eq', uuid(3))], ['id in', C('id', 'in', [uuid(1), uuid(2), uuid(404)])], ['createdOn gt', C('createdOn', 'gt', '2023-12-31')],
      // PostgreSQL additions
      ['id eq uppercase', C('id', 'eq', uuid(3).toUpperCase())], ['id ne', C('id', 'ne', uuid(3))], ['id in uppercase', C('id', 'in', [uuid(1).toUpperCase(), uuid(14)])],
      ['eq non-ASCII case', C('name', 'eq', 'ärger')], ['eq dotted I', C('name', 'eq', 'İSTANBUL')], ['eq final sigma', C('mixed', 'eq', 'σας')], ['contains ß', C('mixed', 'contains', 'SS')],
      ['in non-ASCII', C('kind', 'in', ['ÜNÏCODE'])], ['gt non-ASCII order', C('name', 'gt', 'zed')], ['lt non-ASCII order', C('kind', 'lt', 'ü')],
      ['text numbers spaces', C('tn', 'eq', 42)], ['text numbers exponent', C('tn', 'eq', 1000)], ['text numbers plus', C('tn', 'ge', 7)], ['text numbers trailing dot', C('tn', 'eq', 1)],
      ['text Infinity is not a number', C('mixed', 'gt', 0)], ['text zero', C('mixed', 'eq', 0)],
      ['bool vs text value', C('flag', 'eq', 'true')], ['bool ne number', C('flag', 'ne', 1)], ['bool gt number', C('flag', 'gt', 1)], ['bool lt text', C('flag', 'lt', 'x')],
      ['bool le false', C('flag', 'le', false)], ['bool ge true', C('flag', 'ge', true)], ['bool lt true', C('flag', 'lt', true)], ['bool gt false', C('flag', 'gt', false)],
      ['num vs bool', C('num', 'eq', true)], ['num gt bool', C('num', 'gt', false)], ['num lt bool', C('num', 'lt', true)], ['text gt bool', C('name', 'gt', false)],
      ['text le bool', C('name', 'le', true)], ['date gt bool', C('d', 'gt', true)], ['in text with bool', C('name', 'in', [true, 'zed'])],
      ['num vs non-numeric text', C('num', 'eq', 'abc')], ['num ne non-numeric text', C('num', 'ne', 'abc')], ['num ge text exponent', C('num', 'ge', '1E1')],
      ['num in big', C('num', 'in', [9007199254740, 42, 2.5])], ['num lt fraction', C('num', 'lt', 2.5)], ['currency gt text', C('price', 'gt', '99.5')],
      ['contains decimal', C('amt', 'contains', '.25')], ['contains currency', C('price', 'contains', '1234.5')], ['contains currency .0', C('price', 'contains', '.0')],
      ['contains tiny decimal', C('amt', 'contains', 'e-')], ['contains huge decimal', C('amt', 'contains', '10000000000000000')], ['contains 0.00001', C('amt', 'contains', '0.00001')],
      ['endsWith number', C('num', 'endsWith', '0')], ['contains bool rue', C('flag', 'contains', 'RUE')], ['startsWith number neg', C('num', 'startsWith', '-')],
      ['date eq ms number', C('d', 'eq', Date.parse('2024-02-29T00:00:00Z'))], ['datetime lt ms number', C('dt', 'lt', Date.parse('2024-01-01T00:00:00Z'))],
      ['date before range', C('d', 'gt', '-010000-01-01T00:00:00Z')], ['datetime after range', C('dt', 'lt', '+050000-01-01T00:00:00Z')],
      ['date gt local-time text', C('d', 'gt', '2024-02-29T00:00:00')], ['date not parseable', C('d', 'eq', 'someday')],
      ['not text eq (blank rows)', { not: C('name', 'eq', 'zed') }], ['not in', { not: C('kind', 'in', ['red', 'zz']) }], ['not bool sign', { not: C('flag', 'gt', 1) }],
    ]

    beforeAll(async () => {
      await c.createTable(def)
      await c.insert(def, data)
    })
    it('covers at least 100 conditions', () => { expect(conditions.length).toBeGreaterThanOrEqual(100) })
    it.each(conditions)('%s', async (_label, cond) => {
      const expected = data.filter((r) => evaluateCondition(cond, r)).map((r) => r.id as string).sort()
      const got = ids((await c.select(def, { where: cond, select: ['id'] })).rows)
      expect(got).toEqual(expected)
      const counted = await c.select(def, { where: cond, select: ['id'], count: true, top: 1 })
      expect(counted.total).toBe(expected.length)
      // a managed table compares its (lowercase UUID) ids exactly: same answers
      expect(ids((await c.select(managed, { where: cond, select: ['id'] })).rows)).toEqual(expected)
    })
    it('without ICU (lower() of the database locale) ASCII text gives the same answers', async () => {
      const types = columnTypesByName(def)
      const ascii = (r: RawRow) => Object.values(r).every((v) => typeof v !== 'string' || [...v].every((ch) => ch.charCodeAt(0) < 128))
      const rows = data.filter(ascii)
      for (const [label, cond] of conditions) {
        if (/non-ASCII|dotted|sigma|ß/.test(label)) continue
        const plan = buildSelect({ schema, icu: false }, def, { where: { and: [cond, { col: 'id', op: 'in', value: rows.map((r) => r.id as string) }] }, select: ['id'] })
        const got = (await raw.query<Record<string, unknown>>(plan.sql, plan.params)).map((r) => fromDb(r.id, types.get('id')!) as string).sort()
        expect(got, label).toEqual(rows.filter((r) => evaluateCondition(cond, r)).map((r) => r.id as string).sort())
      }
    })
    it('orderBy / top / skip match applyQuery (blanks last)', async () => {
      type Ord = { col: string; dir: 'asc' | 'desc' }[]
      const orders: Ord[] = [
        [{ col: 'num', dir: 'asc' }], [{ col: 'num', dir: 'desc' }], [{ col: 'price', dir: 'desc' }, { col: 'id', dir: 'asc' }],
        [{ col: 'dt', dir: 'asc' }, { col: 'id', dir: 'asc' }], [{ col: 'd', dir: 'desc' }, { col: 'id', dir: 'desc' }],
        [{ col: 'name', dir: 'asc' }, { col: 'id', dir: 'asc' }], [{ col: 'kind', dir: 'desc' }, { col: 'id', dir: 'asc' }], [{ col: 'flag', dir: 'asc' }, { col: 'id', dir: 'desc' }],
        [{ col: 'mixed', dir: 'asc' }, { col: 'id', dir: 'asc' }],
      ]
      for (const orderBy of orders) {
        for (const page of [{}, { top: 4 }, { top: 3, skip: 2 }, { skip: 7 }]) {
          const q: Query = { where: { not: C('kind', 'eq', 'zzz') }, orderBy, ...page }
          const mem = applyQuery(data, q).rows.map((r) => r.id)
          const sql = (await c.select(def, { ...q, select: ['id'] })).rows.map((r) => r.id)
          // rows tied on the sort key may differ in order: compare the sort-key sequences, and the id sets per page of equal keys
          const keyOf = (id: unknown) => data.find((r) => r.id === id)![orderBy[0].col]
          expect(sql.map(keyOf), JSON.stringify([orderBy, page])).toEqual(mem.map(keyOf))
          if (orderBy.length > 1) expect(sql.map((id) => data.findIndex((r) => r.id === id)), JSON.stringify([orderBy, page])).toEqual(mem.map((id) => data.findIndex((r) => r.id === id)))
        }
      }
    })
    it('text ordering puts blanks last in both directions', async () => {
      for (const dir of ['asc', 'desc'] as const) {
        const r = (await c.select(def, { orderBy: [{ col: 'tn', dir }], select: ['tn'] })).rows.map((x) => x.tn)
        expect(r.slice(-2).sort()).toEqual(['', null].sort((a, b) => String(a).localeCompare(String(b))))
      }
    })
    it('documented differences: hex text is a number only in JavaScript; contains on dates uses ISO text', async () => {
      const hexDef = mkdef([col('t', 'text'), col('d', 'date')], 'diffs')
      await c.createTable(hexDef)
      const rows: RawRow[] = [{ id: uuid(1), t: '0x10', d: new Date('2024-01-02T00:00:00Z') }]
      await c.insert(hexDef, rows)
      const hex = C('t', 'eq', 16)
      expect(evaluateCondition(hex, rows[0])).toBe(true)
      expect((await c.select(hexDef, { where: hex })).rows.length).toBe(0)
      expect((await c.select(hexDef, { where: C('d', 'contains', '2024-01-02') })).rows.length).toBe(1)
    })
  })

  it('error mapping never exposes SQL or values', () => {
    expect(mapPgError({ code: '23505', severity: 'ERROR', message: 'duplicate key value violates unique constraint "uq_x" Key (a)=(secret)' })).toMatchObject({ status: 409, message: 'A row with the same unique value already exists' })
    expect(mapPgError({ code: '42P01', severity: 'ERROR', message: 'relation "x" does not exist' })).toMatchObject({ status: 404 })
    expect(mapPgError({ code: 'XX000', severity: 'ERROR', message: 'SELECT secret FROM x' }).message).toBe('Database error (XX000)')
    expect(logs.join('\n')).not.toContain(cfg.password)
  })
})
