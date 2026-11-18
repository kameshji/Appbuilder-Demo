import { describe, expect, it } from 'vitest'
import type { ColumnDef, TableDef } from '../../../src/platform/contracts.ts'
import {
  buildDeletes, buildInserts, buildSelect, buildUpdate, buildWhere, createTableSql, fold, fromDb, indexName, kindOf, mapSqlType,
  physicalName, quoteId, sqlType, tableId, toDb,
} from './sql.ts'
import type { Dialect } from './sql.ts'
import { alterUsing } from './index.ts'
import { formatServerVersion, friendlyConnectionError, mapPgError } from './db.ts'

const col = (name: string, type: ColumnDef['type'], extra: Partial<ColumnDef> = {}): ColumnDef => ({ name, displayName: name, type, ...extra })
const def = (columns: ColumnDef[], extra: Partial<TableDef> = {}): TableDef => ({
  id: 'tbl_1', name: 'Orders', displayName: 'Orders', primaryColumn: 'title', columns, createdOn: '', modifiedOn: '', ...extra,
})
const D: Dialect = { schema: 'env_default', icu: true }
const NO_ICU: Dialect = { schema: 'env_default', icu: false }
const T = def([col('title', 'text'), col('qty', 'number'), col('done', 'boolean'), col('due', 'date'), col('at', 'datetime'), col('price', 'currency'), col('rate', 'decimal')])

describe('identifiers', () => {
  it('quotes valid names and rejects the rest', () => {
    expect(quoteId('abc_1')).toBe('"abc_1"')
    expect(quoteId('createdOn')).toBe('"createdOn"')
    for (const bad of ['', '1abc', 'a-b', 'a b', 'a"b', 'a;drop', 'x'.repeat(64), 'a.b']) expect(() => quoteId(bad)).toThrow()
  })
  it('derives the physical table name, always schema-qualified', () => {
    expect(physicalName({ name: 'Orders' })).toBe('t_orders')
    expect(physicalName({ name: 'Orders', source: 'legacy_orders' })).toBe('legacy_orders')
    expect(tableId(D, { name: 'Orders' })).toBe('"env_default"."t_orders"')
    expect(() => physicalName({ name: 'x', source: 'ab_users' })).toThrow(/reserved/)
    expect(() => physicalName({ name: 'x', source: 'AB_users' })).toThrow(/reserved/)
    expect(() => tableId({ schema: 'a"; drop', icu: true }, { name: 'x' })).toThrow()
  })
  it('index names are unique per schema and at most 63 characters', () => {
    expect(indexName('t_orders', 'unique', 'email')).toBe('uq_t_orders_email')
    expect(indexName('t_orders', 'index', 'owner')).toBe('ix_t_orders_owner')
    const long = indexName('t_' + 'x'.repeat(60), 'unique', 'y'.repeat(60))
    expect(long.length).toBeLessThanOrEqual(63)
    expect(long).not.toBe(indexName('t_' + 'x'.repeat(60), 'unique', 'y'.repeat(59) + 'z'))
  })
})

describe('DDL', () => {
  it('maps every column type', () => {
    const m: Record<string, string> = {
      text: 'varchar(255)', email: 'varchar(255)', phone: 'varchar(255)', choice: 'varchar(255)', url: 'varchar(1024)',
      multiline: 'text', number: 'bigint', decimal: 'double precision', currency: 'numeric(19,4)', boolean: 'boolean',
      date: 'date', datetime: 'timestamptz(3)', lookup: 'text', image: 'text', file: 'text', autonumber: 'varchar(64)',
    }
    for (const [t, s] of Object.entries(m)) expect(sqlType(col('c', t as ColumnDef['type']))).toBe(s)
    expect(sqlType(col('c', 'url', { unique: true }))).toBe('varchar(768)')
    expect(sqlType(col('id', 'text', { system: true }))).toBe('text')
    expect(sqlType(col('createdOn', 'datetime', { system: true }))).toBe('timestamptz(3)')
  })
  it('creates system columns, primary key and lowercased indexes in separate statements', () => {
    const [create, ...ix] = createTableSql(D, def([col('title', 'text', { unique: true }), col('cust', 'lookup'), col('n', 'number', { unique: true }), col('notes', 'multiline', { unique: true })]))
    expect(create).toContain('CREATE TABLE "env_default"."t_orders"')
    expect(create).toContain('"id" text NOT NULL')
    expect(create).toContain('"createdOn" timestamptz(3) NULL')
    expect(create).toContain('"owner" text NULL')
    expect(create).toContain('PRIMARY KEY ("id")')
    expect(ix).toEqual([
      'CREATE INDEX IF NOT EXISTS "ix_t_orders_owner" ON "env_default"."t_orders" ((lower(("owner") COLLATE pg_catalog."und-x-icu")))',
      'CREATE UNIQUE INDEX IF NOT EXISTS "uq_t_orders_title" ON "env_default"."t_orders" ((lower(("title") COLLATE pg_catalog."und-x-icu")))',
      'CREATE INDEX IF NOT EXISTS "ix_t_orders_cust" ON "env_default"."t_orders" ((lower(("cust") COLLATE pg_catalog."und-x-icu")))',
      'CREATE UNIQUE INDEX IF NOT EXISTS "uq_t_orders_n" ON "env_default"."t_orders" ("n")',
    ])
    expect(createTableSql(NO_ICU, def([col('title', 'text', { unique: true })]))[2]).toContain('(lower("title"))')
  })
  it('rejects duplicate and invalid columns', () => {
    expect(() => createTableSql(D, def([col('a', 'text'), col('A', 'text')]))).toThrow(/Duplicate/)
    expect(() => createTableSql(D, def([col('a b', 'text')]))).toThrow()
  })
  it('type changes convert in SQL (USING)', () => {
    expect(alterUsing(col('a', 'text'), col('a', 'number'), '"a"')).toBe(`round(NULLIF(btrim("a"::text), '')::numeric)::bigint`)
    expect(alterUsing(col('a', 'boolean'), col('a', 'number'), '"a"')).toContain('CASE WHEN "a" THEN 1 ELSE 0 END')
    expect(alterUsing(col('a', 'text'), col('a', 'boolean'), '"a"')).toContain("WHEN 'yes' THEN TRUE")
    expect(alterUsing(col('a', 'datetime'), col('a', 'date'), '"a"')).toBe(`("a" AT TIME ZONE 'UTC')::date`)
    expect(alterUsing(col('a', 'decimal'), col('a', 'text'), '"a"')).toContain('::varchar(255)')
    expect(alterUsing(col('a', 'number'), col('a', 'decimal'), '"a"')).toBe('("a"::numeric)::double precision')
  })
})

describe('values', () => {
  it('toDb converts by column kind', () => {
    expect(toDb(true, col('b', 'boolean'))).toBe(true)
    expect(toDb('0', col('b', 'boolean'))).toBe(false)
    expect(toDb(new Date('2024-02-29T13:00:00Z'), col('d', 'date'))).toBe('2024-02-29')
    expect(toDb('2024-02-29T13:14:15.678Z', col('d', 'datetime'))).toBe('2024-02-29T13:14:15.678Z')
    expect(toDb('12', col('n', 'number'))).toBe(12)
    expect(() => toDb('x', col('n', 'number'))).toThrow(/not a valid/)
    expect(toDb(null, col('n', 'number'))).toBeNull()
  })
  it('fromDb: dates as UTC days, numerics as numbers, json as text', () => {
    expect((fromDb('2024-02-29', 'date') as Date).toISOString()).toBe('2024-02-29T00:00:00.000Z')
    expect(fromDb('1234.5000', 'currency')).toBe(1234.5)
    expect(fromDb('9007199254740993', 'number')).toBe(9007199254740992)
    expect(fromDb(true, 'boolean')).toBe(true)
    expect(fromDb({ a: 1 }, 'multiline')).toBe('{"a":1}')
    expect(fromDb(null, 'text')).toBeNull()
  })
  it('maps information_schema types', () => {
    expect(mapSqlType({ dataType: 'numeric', precision: 19, scale: 4 })).toBe('currency')
    expect(mapSqlType({ dataType: 'numeric', precision: 10, scale: 0 })).toBe('number')
    expect(mapSqlType({ dataType: 'numeric', precision: null, scale: null })).toBe('decimal')
    expect(mapSqlType({ dataType: 'timestamp without time zone' })).toBe('datetime')
    expect(mapSqlType({ dataType: 'USER-DEFINED' })).toBe('choice')
    expect(mapSqlType({ dataType: 'uuid' })).toBe('text')
    expect(mapSqlType({ dataType: 'jsonb' })).toBe('multiline')
  })
  it('kindOf groups the column types', () => {
    expect(['number', 'decimal', 'currency'].map((t) => kindOf(t as ColumnDef['type']))).toEqual(['num', 'num', 'num'])
    expect(kindOf('lookup')).toBe('text')
  })
})

describe('conditions', () => {
  const w = (c: Parameters<typeof buildWhere>[2], d: Dialect = D, t: TableDef = T) => buildWhere(d, t, c)
  it('text compares lowercased; ordering by code point; the value is lowercased in JavaScript', () => {
    expect(w({ col: 'title', op: 'eq', value: 'ÄBC' })).toEqual({ sql: `(${fold(D, '"title"')} = $1::text)`, params: ['äbc'] })
    expect(w({ col: 'title', op: 'lt', value: 'B' }).sql).toBe(`(("title" IS NOT NULL AND "title" <> '') AND ${fold(D, '"title"')} COLLATE "C" < $1::text)`)
    expect(w({ col: 'title', op: 'eq', value: 'x' }, NO_ICU).sql).toBe('(lower("title") = $1::text)')
  })
  it('contains / startsWith / endsWith need no LIKE escaping', () => {
    const c = w({ col: 'title', op: 'contains', value: '100%_\\' })
    expect(c.sql).toContain('strpos(')
    expect(c.params).toEqual(['100%_\\'])
    expect(w({ col: 'title', op: 'startsWith', value: 'A' }).sql).toContain('starts_with(')
    expect(w({ col: 'title', op: 'endsWith', value: 'A' }).sql).toContain('right(')
  })
  it('decides on the value in JavaScript: not comparable, booleans, numeric text, dates', () => {
    expect(w({ col: 'qty', op: 'eq', value: 'abc' }).sql).toBe('FALSE')
    expect(w({ col: 'qty', op: 'ne', value: 'abc' }).sql).toBe('TRUE')
    expect(w({ col: 'qty', op: 'eq', value: '1E1' })).toEqual({ sql: '("qty" = $1::bigint)', params: [10] })
    expect(w({ col: 'qty', op: 'lt', value: 2.5 })).toEqual({ sql: '("qty" IS NOT NULL AND "qty" < $1::numeric)', params: ['2.5'] })
    expect(w({ col: 'done', op: 'eq', value: 'true' }).sql).toBe('FALSE')
    expect(w({ col: 'done', op: 'gt', value: 1 }).sql).toBe('("done" IS NOT NULL AND "done")')
    expect(w({ col: 'qty', op: 'gt', value: false }).sql).toBe('("qty" IS NOT NULL AND ("qty" <> 0))')
    expect(w({ col: 'title', op: 'gt', value: 5 }).sql).toContain('CAST("title" AS double precision)')
    expect(w({ col: 'due', op: 'eq', value: '2024-02-20' })).toEqual({ sql: '("due" = $1::date)', params: ['2024-02-20'] })
    expect(w({ col: 'due', op: 'lt', value: '2024-02-20T12:00:00Z' }).sql).toContain(`("due"::timestamp AT TIME ZONE 'UTC') < $1::timestamptz`)
    expect(w({ col: 'at', op: 'gt', value: '+050000-01-01T00:00:00Z' }).sql).toBe('FALSE')
    expect(w({ col: 'at', op: 'lt', value: '+050000-01-01T00:00:00Z' }).sql).toBe('("at" IS NOT NULL)')
    expect(w({ col: 'title', op: 'eq', value: '' }).sql).toBe('FALSE')
  })
  it('in uses typed arrays; NOT neutralises NULL', () => {
    expect(w({ col: 'qty', op: 'in', value: [1, '2', 2.5, null] })).toEqual({ sql: '("qty" = ANY($1::bigint[]))', params: [[1, 2]] })
    expect(w({ col: 'title', op: 'in', value: ['A', 'b', '', null, 3] }).params).toEqual([['a', 'b'], [3]])
    expect(w({ col: 'done', op: 'in', value: ['true', 1] }).sql).toBe('FALSE')
    expect(w({ not: { col: 'qty', op: 'gt', value: 2 } }).sql).toBe('(NOT COALESCE(("qty" IS NOT NULL AND "qty" > $1::bigint), FALSE))')
  })
  it('managed tables compare the id column exactly (primary key lookups)', () => {
    const M = { ...T, managed: true }
    expect(w({ col: 'id', op: 'eq', value: 'ABC' }, D, M)).toEqual({ sql: '("id" = $1::text)', params: ['abc'] })
    expect(w({ col: 'id', op: 'in', value: ['A', 'b'] }, D, M)).toEqual({ sql: '("id" = ANY($1::text[]))', params: [['a', 'b']] })
    expect(w({ col: 'id', op: 'eq', value: 'ABC' }).sql).toContain('lower(')
  })
  it('rejects unknown columns', () => {
    expect(() => w({ col: 'nope', op: 'eq', value: 1 })).toThrow(/Unknown column/)
  })
})

describe('statements', () => {
  it('select: default order createdOn, id; blanks last; limit/offset; count', () => {
    const t = def([col('id', 'text', { system: true }), col('createdOn', 'datetime', { system: true }), col('title', 'text')])
    const p = buildSelect(D, t, { where: { col: 'title', op: 'eq', value: 'x' }, orderBy: [{ col: 'title', dir: 'desc' }], top: 10, skip: 20, count: true })
    expect(p.sql).toContain(`ORDER BY ("title" IS NULL OR "title" = '') ASC, NULLIF(${fold(D, '"title"')}, '') COLLATE "C" DESC, "createdOn" ASC, "id" ASC LIMIT 10 OFFSET 20`)
    expect(p.countSql).toBe(`SELECT count(*)::bigint AS n FROM "env_default"."t_orders" WHERE (${fold(D, '"title"')} = $1::text)`)
    expect(buildSelect(D, t, {}).sql).toMatch(/ORDER BY "createdOn" ASC, "id" ASC$/)
    expect(() => buildSelect(D, t, { top: -1 })).toThrow()
  })
  it('inserts in chunks that stay below the parameter limit', () => {
    const many = def(Array.from({ length: 200 }, (_, i) => col(`c${i}`, 'text')))
    const rows = Array.from({ length: 1000 }, () => Object.fromEntries(many.columns.map((c) => [c.name, 'x'])))
    const stmts = buildInserts(D, many, rows)
    for (const s of stmts) expect(s.params.length).toBeLessThanOrEqual(60000)
    expect(stmts.reduce((n, s) => n + s.params.length, 0)).toBe(200 * 1000)
    expect(buildInserts(D, T, [{ id: 'a', title: 'x' }, { id: 'b' }])[0].sql).toBe('INSERT INTO "env_default"."t_orders" ("id", "title") VALUES ($1, $2), ($3, DEFAULT)')
  })
  it('update and delete carry the guard after the id', () => {
    const u = buildUpdate(D, T, 'r1', { qty: 3 }, { col: 'owner', op: 'eq', value: 'U1' })!
    expect(u.sql).toBe(`UPDATE "env_default"."t_orders" SET "qty" = $1 WHERE "id" = $2::text AND (${fold(D, '"owner"')} = $3::text)`)
    expect(u.params).toEqual([3, 'r1', 'u1'])
    expect(buildUpdate(D, T, 'r1', {})).toBeNull()
    const d = buildDeletes(D, T, ['a', 'b'], { const: true })
    expect(d).toEqual([{ sql: 'DELETE FROM "env_default"."t_orders" WHERE "id" = ANY($1::text[]) AND TRUE', params: [['a', 'b']] }])
  })
})

describe('errors', () => {
  const s = { host: 'db', port: 5432, database: 'appbuilder', user: 'appbuilder' }
  it('explains connection failures without the password', () => {
    expect(friendlyConnectionError({ code: '28P01', message: 'password authentication failed for user "appbuilder"' }, s, 'pw123')).toMatch(/wrong user name or password/)
    expect(friendlyConnectionError({ code: '3D000' }, s)).toMatch(/database "appbuilder" does not exist/)
    expect(friendlyConnectionError({ code: 'ECONNREFUSED' }, s)).toMatch(/connection refused.*5432/)
    expect(friendlyConnectionError({ code: '28000', message: 'no pg_hba.conf entry for host "1.2.3.4", user "x", database "y", no encryption' }, s)).toMatch(/without SSL.*pg_hba\.conf/)
    expect(friendlyConnectionError({ message: 'The server does not support SSL connections' }, s)).toMatch(/does not support SSL/)
    expect(friendlyConnectionError({ message: 'oops pw123 here' }, s, 'pw123')).not.toContain('pw123')
  })
  it('maps SQLSTATE codes to API errors', () => {
    expect(mapPgError({ code: '23505' })).toMatchObject({ status: 409, code: 'conflict' })
    expect(mapPgError({ code: '42501' })).toMatchObject({ status: 403, code: 'denied' })
    expect(mapPgError({ code: '22001' })).toMatchObject({ status: 422 })
    expect(mapPgError({ code: '22021', message: 'invalid byte sequence for encoding "UTF8": 0x00' }).message).toMatch(/NUL/)
    expect(mapPgError({ code: '08006' })).toMatchObject({ status: 503 })
    expect(mapPgError({ code: '40P01' })).toMatchObject({ status: 409 })
  })
  it('formats the server version', () => {
    expect(formatServerVersion('16.4 (Ubuntu 16.4-1.pgdg24.04+1)')).toBe('PostgreSQL 16.4')
    expect(formatServerVersion('17.2')).toBe('PostgreSQL 17.2')
  })
})
