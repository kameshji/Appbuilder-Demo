import { describe, expect, it } from 'vitest'
import type { ColumnDef, TableDef } from '../../../src/platform/contracts.ts'
import {
  buildDeletes, buildInserts, buildSelect, buildUpdate, buildWhere, createTableSql, escapeLike, fmtDateTime, fromDb, kindOf,
  physicalName, quoteId, sqlType, toDb,
} from './sql.ts'
import { friendlyConnectionError, mapDbError, mapSqlType } from './index.ts'

const col = (name: string, type: ColumnDef['type'], extra: Partial<ColumnDef> = {}): ColumnDef => ({ name, displayName: name, type, ...extra })
const def = (columns: ColumnDef[], extra: Partial<TableDef> = {}): TableDef => ({
  id: 'tbl_1', name: 'Orders', displayName: 'Orders', primaryColumn: 'title', columns, createdOn: '', modifiedOn: '', ...extra,
})
const D = def([col('title', 'text'), col('qty', 'number'), col('done', 'boolean'), col('due', 'date'), col('at', 'datetime'), col('price', 'currency')])

describe('identifiers', () => {
  it('quotes valid names and rejects the rest', () => {
    expect(quoteId('abc_1')).toBe('`abc_1`')
    for (const bad of ['', '1abc', 'a-b', 'a b', 'a`b', 'a;drop', 'x'.repeat(65), 'a.b']) expect(() => quoteId(bad)).toThrow()
  })
  it('derives the physical table name', () => {
    expect(physicalName({ name: 'Orders' })).toBe('t_orders')
    expect(physicalName({ name: 'Orders', source: 'legacy_orders' })).toBe('legacy_orders')
    expect(() => physicalName({ name: 'x', source: 'ab_users' })).toThrow(/reserved/)
    expect(() => physicalName({ name: 'x', source: 'AB_users' })).toThrow(/reserved/)
    expect(() => physicalName({ name: 'x', source: 'a;b' })).toThrow()
  })
})

describe('DDL', () => {
  it('maps every column type', () => {
    const m: Record<string, string> = {
      text: 'VARCHAR(255)', email: 'VARCHAR(255)', phone: 'VARCHAR(255)', choice: 'VARCHAR(255)', url: 'VARCHAR(1024)',
      multiline: 'MEDIUMTEXT', number: 'BIGINT', decimal: 'DOUBLE', currency: 'DECIMAL(19,4)', boolean: 'TINYINT(1)',
      date: 'DATE', datetime: 'DATETIME(3)', lookup: 'CHAR(36)', image: 'TEXT', file: 'TEXT', autonumber: 'VARCHAR(64)',
    }
    for (const [t, s] of Object.entries(m)) expect(sqlType(col('c', t as ColumnDef['type']))).toBe(s)
    expect(sqlType(col('c', 'url', { unique: true }))).toBe('VARCHAR(768)')
  })
  it('creates system columns, primary key, indexes and charset', () => {
    const sql = createTableSql(def([col('title', 'text', { unique: true }), col('cust', 'lookup'), col('notes', 'multiline', { unique: true })]))
    expect(sql).toContain('CREATE TABLE `t_orders`')
    expect(sql).toContain('`id` CHAR(36) NOT NULL')
    expect(sql).toContain('`createdOn` DATETIME(3) NULL')
    expect(sql).toContain('`owner` VARCHAR(64) NULL')
    expect(sql).toContain('PRIMARY KEY (`id`)')
    expect(sql).toContain('KEY `ix_owner` (`owner`)')
    expect(sql).toContain('KEY `ix_cust` (`cust`)')
    expect(sql).toContain('UNIQUE KEY `uq_title` (`title`)')
    expect(sql).not.toContain('uq_notes')
    expect(sql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci')
  })
  it('does not duplicate system columns already present in the def', () => {
    const sql = createTableSql(def([col('id', 'text', { system: true }), col('owner', 'text', { system: true }), col('title', 'text')]))
    expect(sql.match(/`id` CHAR/g)?.length).toBe(1)
    expect(sql.match(/`owner` VARCHAR/g)?.length).toBe(1)
  })
  it('rejects duplicate and invalid columns', () => {
    expect(() => createTableSql(def([col('a', 'text'), col('A', 'text')]))).toThrow(/Duplicate/)
    expect(() => createTableSql(def([col('a b', 'text')]))).toThrow()
  })
  it('maps SQL types back', () => {
    const t = (dataType: string, columnType: string, precision: number | null = null, scale: number | null = null) => mapSqlType({ dataType, columnType, precision, scale })
    expect(t('tinyint', 'tinyint(1)')).toBe('boolean')
    expect(t('tinyint', 'tinyint(4)')).toBe('number')
    expect(t('bigint', 'bigint(20)')).toBe('number')
    expect(t('int', 'int(11)')).toBe('number')
    expect(t('decimal', 'decimal(19,4)', 19, 4)).toBe('currency')
    expect(t('decimal', 'decimal(10,2)', 10, 2)).toBe('decimal')
    expect(t('decimal', 'decimal(10,0)', 10, 0)).toBe('number')
    expect(t('double', 'double')).toBe('decimal')
    expect(t('date', 'date')).toBe('date')
    expect(t('datetime', 'datetime(3)')).toBe('datetime')
    expect(t('timestamp', 'timestamp')).toBe('datetime')
    expect(t('mediumtext', 'mediumtext')).toBe('multiline')
    expect(t('varchar', 'varchar(255)')).toBe('text')
    expect(t('enum', "enum('a','b')")).toBe('choice')
    expect(t('char', 'char(36)')).toBe('text')
  })
})

describe('value conversion', () => {
  it('converts to SQL parameters', () => {
    const d = new Date('2024-03-05T10:20:30.456Z')
    expect(toDb(d, col('c', 'datetime'))).toBe('2024-03-05 10:20:30.456')
    expect(toDb(d, col('c', 'date'))).toBe('2024-03-05')
    expect(toDb('2024-03-05', col('c', 'date'))).toBe('2024-03-05')
    expect(toDb('2024-03-05T23:30:00-05:00', col('c', 'datetime'))).toBe('2024-03-06 04:30:00.000')
    expect(toDb(true, col('c', 'boolean'))).toBe(1)
    expect(toDb(false, col('c', 'boolean'))).toBe(0)
    expect(toDb('12.5', col('c', 'currency'))).toBe(12.5)
    expect(toDb(null, col('c', 'number'))).toBeNull()
    expect(toDb(5, col('c', 'text'))).toBe('5')
    expect(() => toDb('abc', col('c', 'number'))).toThrow()
    expect(() => toDb('nope', col('c', 'date'))).toThrow()
  })
  it('converts from driver values', () => {
    expect(fromDb(1, 'boolean')).toBe(true)
    expect(fromDb(0, 'boolean')).toBe(false)
    expect(fromDb('12.3400', 'currency')).toBe(12.34)
    expect(fromDb('9007199254740993', 'number')).toBe(9007199254740992)
    expect(fromDb(new Date('2024-01-01T00:00:00Z'), 'date')).toEqual(new Date('2024-01-01T00:00:00Z'))
    expect(fromDb(new Date('invalid'), 'datetime')).toBeNull()
    expect(fromDb(Buffer.from('hi'), 'text')).toBe('hi')
    expect(fromDb(null, 'text')).toBeNull()
    expect(kindOf('autonumber')).toBe('text')
    expect(fmtDateTime(new Date(0))).toBe('1970-01-01 00:00:00.000')
  })
})

describe('condition -> SQL', () => {
  it('never interpolates values', () => {
    const evil = "x' OR 1=1; DROP TABLE t_orders; --"
    const { sql, params } = buildWhere(D, { col: 'title', op: 'eq', value: evil })
    expect(sql).not.toContain('DROP')
    expect(sql).not.toContain(evil)
    expect(params).toEqual([evil])
    const c = buildWhere(D, { col: 'title', op: 'contains', value: evil })
    expect(c.sql).not.toContain('DROP')
  })
  it('rejects unknown columns and identifiers', () => {
    expect(() => buildWhere(D, { col: 'nope', op: 'eq', value: 1 })).toThrow(/Unknown column/)
    expect(() => buildWhere(D, { col: 'x`; DROP', op: 'eq', value: 1 })).toThrow()
  })
  it('blank semantics differ by column kind', () => {
    expect(buildWhere(D, { col: 'title', op: 'isBlank' }).sql).toBe('((`title` IS NULL OR CHAR_LENGTH(`title`) = 0))')
    expect(buildWhere(D, { col: 'qty', op: 'isBlank' }).sql).toBe('(`qty` IS NULL)')
    expect(buildWhere(D, { col: 'title', op: 'eq', value: null }).sql).toBe(buildWhere(D, { col: 'title', op: 'isBlank' }).sql)
    expect(buildWhere(D, { col: 'qty', op: 'ne', value: null }).sql).toBe('(`qty` IS NOT NULL)')
    expect(buildWhere(D, { col: 'title', op: 'notBlank' }).sql).toContain('IS NOT NULL AND CHAR_LENGTH')
  })
  it('text compares use the collation on the literal', () => {
    const w = buildWhere(D, { col: 'title', op: 'eq', value: 'Abc' })
    expect(w.sql).toBe('(`title` = ? COLLATE utf8mb4_unicode_ci)')
    expect(w.params).toEqual(['Abc'])
    expect(buildWhere(D, { col: 'title', op: 'ne', value: 'a' }).sql).toContain('`title` IS NULL OR')
    expect(buildWhere(D, { col: 'title', op: 'lt', value: 'm' }).sql).toContain('CHAR_LENGTH(`title`) > 0')
  })
  it('escapes LIKE wildcards', () => {
    expect(escapeLike('50%_off!')).toBe('50!%!_off!!')
    const w = buildWhere(D, { col: 'title', op: 'contains', value: '100%_\\' })
    expect(w.params).toEqual(['%100!%!_\\%'])
    expect(w.sql).toContain("ESCAPE '!'")
    expect(buildWhere(D, { col: 'title', op: 'startsWith', value: 'a' }).params).toEqual(['a%'])
    expect(buildWhere(D, { col: 'title', op: 'endsWith', value: 'a' }).params).toEqual(['%a'])
  })
  it('numbers, booleans and dates', () => {
    expect(buildWhere(D, { col: 'qty', op: 'ge', value: '3' })).toEqual({ sql: '(`qty` >= ?)', params: [3] })
    expect(buildWhere(D, { col: 'qty', op: 'eq', value: 'abc' }).sql).toBe('(1 = 0)')
    expect(buildWhere(D, { col: 'qty', op: 'ne', value: 'abc' }).sql).toBe('(1 = 1)')
    expect(buildWhere(D, { col: 'qty', op: 'ne', value: 3 }).sql).toBe('(`qty` IS NULL OR `qty` <> ?)')
    expect(buildWhere(D, { col: 'done', op: 'eq', value: true }).sql).toBe('(`done` <> 0)')
    expect(buildWhere(D, { col: 'done', op: 'ne', value: true }).sql).toBe('(`done` IS NULL OR `done` = 0)')
    expect(buildWhere(D, { col: 'due', op: 'eq', value: '2024-01-15' })).toEqual({ sql: '(`due` = ?)', params: ['2024-01-15'] })
    expect(buildWhere(D, { col: 'due', op: 'lt', value: '2024-01-15T12:00:00Z' }).sql).toContain('CAST(`due` AS DATETIME(3))')
    expect(buildWhere(D, { col: 'at', op: 'gt', value: '2024-01-15T12:00:00.5Z' }).params).toEqual(['2024-01-15 12:00:00.500'])
    expect(buildWhere(D, { col: 'at', op: 'gt', value: 'garbage' }).sql).toBe('(1 = 0)')
  })
  it('text column compared with a number goes through a guarded numeric cast', () => {
    const w = buildWhere(D, { col: 'title', op: 'gt', value: 5 })
    expect(w.sql).toContain('CASE WHEN `title` REGEXP')
    expect(w.params).toEqual([5])
  })
  it('in lists', () => {
    expect(buildWhere(D, { col: 'qty', op: 'in', value: [1, '2', null, 'x'] })).toEqual({ sql: '(`qty` IN (?, ?))', params: [1, 2] })
    expect(buildWhere(D, { col: 'qty', op: 'in', value: [] }).sql).toBe('(1 = 0)')
    expect(buildWhere(D, { col: 'qty', op: 'in', value: 5 as never }).sql).toBe('(1 = 0)')
    expect(buildWhere(D, { col: 'title', op: 'in', value: ['a', 'B', ''] }).params).toEqual(['a', 'B'])
  })
  it('const / and / or / not', () => {
    expect(buildWhere(D, undefined).sql).toBe('(1 = 1)')
    expect(buildWhere(D, { const: false }).sql).toBe('(1 = 0)')
    expect(buildWhere(D, { and: [] }).sql).toBe('(1 = 1)')
    expect(buildWhere(D, { or: [] }).sql).toBe('(1 = 0)')
    const n = buildWhere(D, { not: { col: 'qty', op: 'gt', value: 1 } })
    expect(n.sql).toBe('(NOT COALESCE((`qty` > ?), 0))')
    const nested = buildWhere(D, { and: [{ col: 'qty', op: 'gt', value: 1 }, { or: [{ col: 'done', op: 'eq', value: true }, { const: false }] }] })
    expect(nested.sql).toBe('((`qty` > ?) AND ((`done` <> 0) OR (1 = 0)))')
  })
  it('unknown operators match nothing', () => {
    expect(buildWhere(D, { col: 'qty', op: 'bogus' as never, value: 1 }).sql).toBe('(1 = 0)')
  })
})

describe('statements', () => {
  it('select always includes id and counts separately', () => {
    const p = buildSelect(D, { select: ['title'], where: { col: 'qty', op: 'gt', value: 1 }, orderBy: [{ col: 'qty', dir: 'desc' }], top: 10, skip: 20, count: true })
    expect(p.sql).toBe('SELECT `title`, `id` FROM `t_orders` WHERE (`qty` > ?) ORDER BY (`qty` IS NULL) ASC, `qty` DESC, `id` ASC LIMIT 10 OFFSET 20')
    expect(p.countSql).toBe('SELECT COUNT(*) AS n FROM `t_orders` WHERE (`qty` > ?)')
    expect(p.columns.map((c) => c.name)).toEqual(['title', 'id'])
  })
  it('skip without top uses the maximum limit; no select lists all columns', () => {
    const p = buildSelect(D, { skip: 5 })
    expect(p.sql).toContain('LIMIT 18446744073709551615 OFFSET 5')
    expect(p.columns.map((c) => c.name)).toEqual(['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner', 'title', 'qty', 'done', 'due', 'at', 'price'])
    expect(buildSelect(D, {}).sql).not.toContain('LIMIT')
  })
  it('rejects bad paging and unknown select/order columns', () => {
    expect(() => buildSelect(D, { top: -1 })).toThrow()
    expect(() => buildSelect(D, { top: 1.5 })).toThrow()
    expect(() => buildSelect(D, { select: ['zzz'] })).toThrow()
    expect(() => buildSelect(D, { orderBy: [{ col: 'a;b', dir: 'asc' }] })).toThrow()
  })
  it('multi-row insert uses DEFAULT for missing keys and chunks at 500', () => {
    const [one] = buildInserts(D, [{ id: 'a', title: 'x' }, { id: 'b', qty: 2 }])
    expect(one.sql).toBe('INSERT INTO `t_orders` (`id`, `title`, `qty`) VALUES (?, ?, DEFAULT), (?, DEFAULT, ?)')
    expect(one.params).toEqual(['a', 'x', 'b', 2])
    const many = buildInserts(D, Array.from({ length: 1200 }, (_, i) => ({ id: String(i) })))
    expect(many.length).toBe(3)
    expect(buildInserts(D, [])).toEqual([])
    expect(() => buildInserts(D, [{ id: 'a', nope: 1 }])).toThrow(/Unknown column/)
  })
  it('update carries id and guard; empty change set returns null', () => {
    const u = buildUpdate(D, 'r1', { title: 'n', id: 'ignored', qty: undefined as never }, { col: 'title', op: 'eq', value: 'x' })!
    expect(u.sql).toBe('UPDATE `t_orders` SET `title` = ? WHERE `id` = ? AND (`title` = ? COLLATE utf8mb4_unicode_ci)')
    expect(u.params).toEqual(['n', 'r1', 'x'])
    expect(buildUpdate(D, 'r1', {})).toBeNull()
  })
  it('delete chunks ids and applies the guard', () => {
    const [d] = buildDeletes(D, ['a', 'b'], { const: false })
    expect(d.sql).toBe('DELETE FROM `t_orders` WHERE `id` IN (?, ?) AND (1 = 0)')
    expect(buildDeletes(D, [])).toEqual([])
    expect(buildDeletes(D, Array.from({ length: 501 }, (_, i) => String(i))).length).toBe(2)
  })
  it('refuses the platform tables', () => {
    const sys = def([col('a', 'text')], { source: 'ab_users' })
    expect(() => buildSelect(sys, {})).toThrow(/reserved/)
    expect(() => createTableSql(sys)).toThrow(/reserved/)
  })
})

describe('errors', () => {
  const s = { host: 'db.example', port: 3306, database: 'app', user: 'bob' }
  it('gives friendly connection messages without the password', () => {
    expect(friendlyConnectionError({ code: 'ECONNREFUSED' }, s, 'hunter2')).toMatch(/refused/)
    expect(friendlyConnectionError({ code: 'ER_ACCESS_DENIED_ERROR' }, s, 'hunter2')).toMatch(/wrong user name or password/)
    expect(friendlyConnectionError({ code: 'ER_BAD_DB_ERROR' }, s)).toMatch(/does not exist/)
    expect(friendlyConnectionError({ code: 'AUTH_SWITCH_PLUGIN_ERROR', message: 'x' }, s)).toMatch(/authentication method/)
    expect(friendlyConnectionError({ code: 'ENOTFOUND' }, s)).toMatch(/db\.example/)
    const m = friendlyConnectionError({ message: 'weird failure using hunter2 as key' }, s, 'hunter2')
    expect(m).not.toContain('hunter2')
  })
  it('maps statement errors', () => {
    expect(mapDbError({ code: 'ER_DUP_ENTRY' }).status).toBe(409)
    expect(mapDbError({ code: 'ER_NO_SUCH_TABLE' }).code).toBe('not-found')
    expect(mapDbError({ code: 'ECONNREFUSED' }).code).toBe('unavailable')
    const e = mapDbError({ code: 'ER_PARSE_ERROR', sqlMessage: "near 'SELECT secret'" })
    expect(e.status).toBe(500)
    expect(e.message).not.toContain('secret')
  })
})
