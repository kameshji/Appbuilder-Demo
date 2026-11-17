/**
 * Integration tests against a real MySQL/MariaDB. Set APPBUILDER_TEST_DB, e.g.
 *   APPBUILDER_TEST_DB=mysql://abdev:abdev-sandbox-only@127.0.0.1:3306/appbuilder_test
 * Tables are created with a random prefix and dropped in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import type { ColumnDef, TableDef } from '../../../src/platform/contracts.ts'
import type { Condition, Query } from '../../../src/platform/http.ts'
import { evaluateCondition, applyQuery } from '../../core/condition.ts'
import type { Connector, ConnectionRecord, ConnectorEnv, RawRow, SqlDb } from '../../core/contracts.ts'
import { createMySqlConnector, createSqlDb } from './index.ts'

const URL_ENV = process.env.APPBUILDER_TEST_DB
if (!URL_ENV) console.warn('[mysql connector] APPBUILDER_TEST_DB is not set: integration tests are SKIPPED (see the header of this file)')
const suite = URL_ENV ? describe : describe.skip

function parseUrl(u: string) {
  const x = new URL(u)
  return { host: x.hostname, port: Number(x.port || 3306), user: decodeURIComponent(x.username), password: decodeURIComponent(x.password), database: x.pathname.slice(1) }
}
const cfg = URL_ENV ? parseUrl(URL_ENV) : { host: '', port: 0, user: '', password: '', database: '' }
const prefix = `tst${randomBytes(3).toString('hex')}_`
const logs: string[] = []
const env: ConnectorEnv = { workspaceDir: '', filesDir: '', fetch, log: (l, m) => logs.push(`${l}: ${m}`) }

const record = (over: Partial<Record<string, string>> = {}, secret = cfg.password): ConnectionRecord => ({
  id: 'conn_t', name: 't', connector: 'mysql', status: 'connected',
  settings: { host: cfg.host, port: String(cfg.port), database: cfg.database, user: cfg.user, ssl: 'false', ...over }, secret,
})
const col = (name: string, type: ColumnDef['type'], extra: Partial<ColumnDef> = {}): ColumnDef => ({ name, displayName: name, type, ...extra })
let seq = 0
const mkdef = (cols: ColumnDef[], name = `tbl${++seq}`): TableDef => ({
  id: `tbl_${name}`, name, displayName: name, primaryColumn: cols[0]?.name ?? 'id', columns: cols, createdOn: '', modifiedOn: '',
  source: prefix + name,
})
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ids = (rows: RawRow[]): string[] => rows.map((r) => r.id as string).sort()
const sys = (n: number): RawRow => ({ id: uuid(n), createdOn: new Date('2024-01-01T00:00:00Z'), modifiedOn: new Date('2024-01-02T00:00:00Z'), createdBy: 'u1', owner: n % 2 ? 'u1' : 'u2' })

suite(URL_ENV ? 'mysql connector (integration)' : 'mysql connector (integration) SKIPPED: set APPBUILDER_TEST_DB', () => {
  let c: Connector
  let raw: SqlDb

  beforeAll(() => {
    c = createMySqlConnector(record(), env)
    raw = createSqlDb({ host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user }, cfg.password)
  })
  afterAll(async () => {
    const rows = await raw.query<{ n: string }>('SELECT table_name AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE ?', [prefix.replace(/_/g, '\\_') + '%'])
    for (const r of rows) await raw.exec('DROP TABLE IF EXISTS `' + r.n + '`')
    await c.close()
    await raw.close()
  })

  it('test() connects and reports the server version', async () => {
    const r = await c.test()
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/Connected to (MySQL|MariaDB) \d+\.\d+\.\d+ at /)
    expect(r.message).not.toContain(cfg.password)
  })

  it('test() explains bad credentials, missing database, refused connection', async () => {
    const bad = await createMySqlConnector(record({}, 'definitely-wrong-pw'), env).test()
    expect(bad.ok).toBe(false)
    expect(bad.message).toMatch(/wrong user name or password/)
    expect(bad.message).not.toContain('definitely-wrong-pw')
    const nodb = await createMySqlConnector(record({ database: cfg.database + '_missing_db' }), env).test()
    expect(nodb.ok).toBe(false)
    expect(nodb.message).toMatch(/does not exist|no access/)
    const refused = await createMySqlConnector(record({ port: '1', host: '127.0.0.1' }), env).test()
    expect(refused.ok).toBe(false)
    expect(refused.message).toMatch(/refused/)
    const incomplete = await createMySqlConnector({ ...record(), settings: {} }, env).test()
    expect(incomplete.ok).toBe(false)
  })

  describe('SqlDb', () => {
    it('serverVersion, query, exec', async () => {
      expect(await raw.serverVersion()).toMatch(/^(MySQL|MariaDB) \d+\.\d+\.\d+/)
      const t = prefix + 'sqldb'
      await raw.exec(`CREATE TABLE \`${t}\` (id INT AUTO_INCREMENT PRIMARY KEY, v VARCHAR(20)) ENGINE=InnoDB`)
      const r = await raw.exec(`INSERT INTO \`${t}\` (v) VALUES (?), (?)`, ['a', 'b'])
      expect(r.affectedRows).toBe(2)
      expect(r.insertId).toBeGreaterThan(0)
      expect(await raw.query(`SELECT v FROM \`${t}\` WHERE v IN (?) ORDER BY v`, [['a', 'b']])).toEqual([{ v: 'a' }, { v: 'b' }])
    })
    it('tx commits and rolls back on one connection', async () => {
      const t = prefix + 'sqldb'
      await raw.tx(async (db) => { await db.exec(`INSERT INTO \`${t}\` (v) VALUES ('committed')`) })
      await expect(raw.tx(async (db) => {
        await db.exec(`INSERT INTO \`${t}\` (v) VALUES ('rolled')`)
        expect((await db.query(`SELECT v FROM \`${t}\` WHERE v = 'rolled'`)).length).toBe(1)
        throw new Error('boom')
      })).rejects.toThrow('boom')
      expect((await raw.query(`SELECT v FROM \`${t}\` WHERE v = 'committed'`)).length).toBe(1)
      expect((await raw.query(`SELECT v FROM \`${t}\` WHERE v = 'rolled'`)).length).toBe(0)
      // nested tx joins the outer one
      await raw.tx(async (db) => { await db.tx(async (d2) => { await d2.exec(`INSERT INTO \`${t}\` (v) VALUES ('nested')`) }) })
      expect((await raw.query(`SELECT v FROM \`${t}\` WHERE v = 'nested'`)).length).toBe(1)
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
      const info = await raw.query<{ n: string; t: string }>('SELECT column_name AS n, column_type AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?', [def.source])
      const t = Object.fromEntries(info.map((r) => [r.n, r.t.toLowerCase()]))
      expect(t.id).toBe('char(36)')
      expect(t.createdOn).toBe('datetime(3)')
      expect(t.owner).toBe('varchar(64)')
      expect(t.f_text).toBe('varchar(255)')
      expect(t.f_url).toBe('varchar(1024)')
      expect(t.f_multi).toBe('mediumtext')
      expect(t.f_number).toMatch(/^bigint/)
      expect(t.f_decimal).toBe('double')
      expect(t.f_currency).toBe('decimal(19,4)')
      expect(t.f_bool).toBe('tinyint(1)')
      expect(t.f_date).toBe('date')
      expect(t.f_dt).toBe('datetime(3)')
      expect(t.f_lookup).toBe('char(36)')
      expect(t.f_image).toBe('text')
      expect(t.f_auto).toBe('varchar(64)')
      const idx = await raw.query<{ n: string; nu: number }>('SELECT DISTINCT index_name AS n, non_unique AS nu FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ?', [def.source])
      const m = Object.fromEntries(idx.map((r) => [r.n, Number(r.nu)]))
      expect(m.PRIMARY).toBe(0)
      expect(m.ix_owner).toBe(1)
      expect(m.ix_f_lookup).toBe(1)
      expect(m.uq_f_email).toBe(0)
      const ddl = await raw.query<Record<string, string>>('SHOW CREATE TABLE `' + def.source + '`')
      const text = Object.values(ddl[0])[1]
      expect(text).toMatch(/ENGINE=InnoDB/)
      expect(text).toMatch(/utf8mb4_unicode_ci/)
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
    })
    it('enforces unique columns with a conflict error', async () => {
      await c.insert(def, [{ id: uuid(10), f_email: 'dup@x.co' }])
      await expect(c.insert(def, [{ id: uuid(11), f_email: 'DUP@x.co' }])).rejects.toMatchObject({ code: 'conflict' })
    })
    it('stores values literally (no injection) and rejects bad identifiers', async () => {
      const evil = "'; DROP TABLE x; -- \\ %"
      await c.insert(def, [{ id: uuid(12), f_text: evil }])
      const r = await c.select(def, { where: { col: 'f_text', op: 'eq', value: evil } })
      expect(r.rows.map((x) => x.f_text)).toEqual([evil])
      await expect(c.select(def, { where: { col: 'f_text`', op: 'eq', value: 1 } })).rejects.toThrow()
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
        id: 'text', createdOn: 'datetime', f_text: 'text', f_multi: 'multiline', f_number: 'number', f_decimal: 'decimal',
        f_currency: 'currency', f_bool: 'boolean', f_date: 'date', f_dt: 'datetime', f_lookup: 'text', f_image: 'multiline',
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
      const t = prefix + 'foreign'
      await raw.exec(`CREATE TABLE \`${t}\` (id VARCHAR(40) PRIMARY KEY, qty INT, flag TINYINT(1), price DECIMAL(10,2), born DATE, seen TIMESTAMP NULL, note TEXT, kind ENUM('a','b')) ENGINE=InnoDB DEFAULT CHARSET=latin1`)
      const d = Object.fromEntries((await c.describe(t)).map((x) => [x.name, x.type]))
      expect(d).toEqual({ id: 'text', qty: 'number', flag: 'boolean', price: 'decimal', born: 'date', seen: 'datetime', note: 'multiline', kind: 'choice' })
      await expect(c.describe(prefix + 'nope')).rejects.toMatchObject({ code: 'not-found' })
      await expect(c.describe('ab_users')).rejects.toMatchObject({ code: 'denied' })
      await raw.exec('CREATE TABLE IF NOT EXISTS `ab_zz_probe` (id INT) ENGINE=InnoDB')
      try {
        expect((await c.listSourceTables()).some((x) => x.source.startsWith('ab_'))).toBe(false)
      } finally { await raw.exec('DROP TABLE IF EXISTS `ab_zz_probe`') }
    })
    it('queries a latin1 foreign table (collation on literals must not fail)', async () => {
      const t = prefix + 'foreign'
      const def: TableDef = { ...mkdef([col('qty', 'number'), col('note', 'multiline')], 'foreign'), source: t }
      await c.insert(def, [{ id: 'k1', qty: 3, note: 'Hello World' }, { id: 'k2', qty: 4, note: 'other' }])
      const r = await c.select(def, { where: { and: [{ col: 'note', op: 'contains', value: 'hello' }, { col: 'id', op: 'eq', value: 'K1' }] }, select: ['qty'] })
      expect(r.rows).toEqual([{ qty: 3, id: 'k1' }])
    })
  })

  describe('schema changes', () => {
    it('addColumn / alterColumn / dropColumn / dropTable', async () => {
      const def = mkdef([col('name', 'text'), col('qty', 'number')], 'alter')
      await c.createTable(def)
      await c.insert(def, [{ id: uuid(1), name: 'a', qty: 5 }])
      const withNew = { ...def, columns: [...def.columns, col('ref', 'lookup'), col('code', 'text', { unique: true })] }
      await c.addColumn(withNew, col('ref', 'lookup'))
      await c.addColumn(withNew, col('code', 'text', { unique: true }))
      const idx = async () => (await raw.query<{ n: string }>('SELECT DISTINCT index_name AS n FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ?', [def.source])).map((r) => r.n).sort()
      expect(await idx()).toEqual(['PRIMARY', 'ix_owner', 'ix_ref', 'uq_code'])
      // type change number -> decimal, rename, drop unique
      await c.alterColumn(withNew, col('qty', 'number'), col('qty', 'decimal'))
      await c.update(withNew, uuid(1), { qty: 2.5 })
      expect((await c.select(withNew, { select: ['qty'] })).rows[0].qty).toBe(2.5)
      await c.alterColumn(withNew, col('code', 'text', { unique: true }), col('code2', 'text'))
      expect(await idx()).toEqual(['PRIMARY', 'ix_owner', 'ix_ref'])
      await c.alterColumn(withNew, col('ref', 'lookup'), col('ref', 'text'))
      expect(await idx()).toEqual(['PRIMARY', 'ix_owner'])
      await c.alterColumn(withNew, col('code2', 'text'), col('code2', 'text', { unique: true }))
      expect(await idx()).toEqual(['PRIMARY', 'ix_owner', 'uq_code2'])
      await c.dropColumn(withNew, 'qty')
      const cols = (await c.describe(def.source as string)).map((x) => x.name)
      expect(cols).not.toContain('qty')
      await c.dropTable(def)
      await expect(c.describe(def.source as string)).rejects.toMatchObject({ code: 'not-found' })
      await c.dropTable(def) // idempotent
    })
    it('createTable twice is a conflict; ab_ sources are refused', async () => {
      const def = mkdef([col('a', 'text')], 'twice')
      await c.createTable(def)
      await expect(c.createTable(def)).rejects.toMatchObject({ code: 'conflict' })
      await expect(c.createTable({ ...def, source: 'ab_evil' })).rejects.toMatchObject({ code: 'denied' })
      await expect(c.select({ ...def, source: 'ab_users' }, {})).rejects.toMatchObject({ code: 'denied' })
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
  })

  describe('parity: SQL vs evaluateCondition', () => {
    const def = mkdef([
      col('name', 'text'), col('tn', 'text'), col('mixed', 'text'), col('num', 'number'), col('amt', 'decimal'), col('price', 'currency'),
      col('flag', 'boolean'), col('d', 'date'), col('dt', 'datetime'), col('kind', 'choice'),
    ], 'parity')
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
    ]

    beforeAll(async () => {
      await c.createTable(def)
      await c.insert(def, data)
    })
    it('covers at least 40 conditions', () => { expect(conditions.length).toBeGreaterThanOrEqual(40) })
    it.each(conditions)('%s', async (_label, cond) => {
      const expected = data.filter((r) => evaluateCondition(cond, r)).map((r) => r.id as string).sort()
      const got = ids((await c.select(def, { where: cond, select: ['id'] })).rows)
      expect(got).toEqual(expected)
      const counted = await c.select(def, { where: cond, select: ['id'], count: true, top: 1 })
      expect(counted.total).toBe(expected.length)
    })
    it('orderBy / top / skip match applyQuery (blanks last)', async () => {
      type Ord = { col: string; dir: 'asc' | 'desc' }[]
      const orders: Ord[] = [[{ col: 'num', dir: 'asc' }], [{ col: 'num', dir: 'desc' }], [{ col: 'price', dir: 'desc' }, { col: 'id', dir: 'asc' }], [{ col: 'dt', dir: 'asc' }, { col: 'id', dir: 'asc' }], [{ col: 'd', dir: 'desc' }, { col: 'id', dir: 'desc' }]]
      for (const orderBy of orders) {
        for (const page of [{}, { top: 4 }, { top: 3, skip: 2 }, { skip: 7 }]) {
          const q: Query = { where: { not: C('kind', 'eq', 'zzz') }, orderBy, ...page }
          const mem = applyQuery(data, q).rows.map((r) => r.id)
          const sql = (await c.select(def, { ...q, select: ['id'] })).rows.map((r) => r.id)
          // rows tied on the sort key may differ in order: compare the sort-key sequences, and the id sets per page of equal keys
          const keyOf = (id: unknown) => data.find((r) => r.id === id)![orderBy[0].col]
          expect(sql.map(keyOf), JSON.stringify([orderBy, page])).toEqual(mem.map(keyOf))
          if (orderBy.length > 1) expect(sql).toEqual(mem)
        }
      }
    })
    it('text ordering puts blanks last in both directions', async () => {
      for (const dir of ['asc', 'desc'] as const) {
        const r = (await c.select(def, { orderBy: [{ col: 'tn', dir }], select: ['tn'] })).rows.map((x) => x.tn)
        expect(r.slice(-2).sort()).toEqual(['', null].sort((a, b) => String(a).localeCompare(String(b))))
      }
    })
  })
})
