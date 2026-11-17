import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { TableDef } from '../../../src/platform/contracts.ts'
import type { ConnectorEnv, RawRow } from '../../core/contracts.ts'
import {
  createFilesConnector, inspectDataFile, readDataFile, removeDataFile, replaceDataFile, storeDataFile,
} from './index.ts'
import type { FilesConnector } from './index.ts'

let dir: string
let env: ConnectorEnv
let conn: FilesConnector
const logs: string[] = []

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'files-conn-'))
  env = { workspaceDir: dir, filesDir: path.join(dir, 'files'), fetch, log: (l, m) => { logs.push(`${l}: ${m}`) } }
  conn = createFilesConnector({ id: 'conn_files', name: 'Data files', connector: 'files', status: 'connected', settings: {} } as never, env) as FilesConnector
})
afterEach(async () => {
  await conn.flush().catch(() => {})
  await fs.rm(dir, { recursive: true, force: true })
})

const buf = (s: string) => Buffer.from(s, 'utf8')

async function xlsxFixture(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const a = wb.addWorksheet('People')
  a.addRow(['Full name', 'Age', 'Joined', 'Active', 'Email', 'Score'])
  a.addRow(['Ann', 30, new Date(Date.UTC(2024, 0, 5)), true, 'ann@x.io', 1.5])
  a.addRow(['Bob', 41, new Date(Date.UTC(2023, 11, 31)), false, 'bob@x.io', 2])
  const b = wb.addWorksheet('Notes')
  b.addRow(['Topic', 'When'])
  b.addRow(['hello', new Date(Date.UTC(2024, 1, 1, 10, 30))])
  b.getColumn(1).width = 44
  wb.addWorksheet('Empty')
  return Buffer.from(await wb.xlsx.writeBuffer())
}

const CSV = 'Name,Qty,Price,Born,Seen,OK,Mail,Site,Zip,Bio\r\n' +
  'Ann,1,1.5,2020-01-02,2024-05-06T10:00:00Z,true,a@b.co,https://x.io,01234,"line1\nline2"\r\n' +
  'Bob,2,2,2021-02-03,2024-05-07T11:00:00Z,false,b@b.co,http://y.io,02345,x\r\n'

function defFor(source: string, insp: { name: string; displayName: string; type: TableDef['columns'][number]['type'] }[]): TableDef {
  return {
    id: 't1', name: 'T', displayName: 'T', primaryColumn: insp[0].name, createdOn: '', modifiedOn: '', source,
    columns: [
      { name: 'id', displayName: 'Id', type: 'text', system: true },
      ...insp.map((c) => ({ name: c.name, displayName: c.displayName, type: c.type })),
      { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true },
      { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime', system: true },
      { name: 'createdBy', displayName: 'Created by', type: 'text', system: true },
      { name: 'owner', displayName: 'Owner', type: 'text', system: true },
    ],
  }
}

describe('inspect', () => {
  it('csv: sanitised names and inferred types', async () => {
    const r = await inspectDataFile(buf(CSV), 'My Data.csv')
    expect(r.kind).toBe('csv')
    expect(r.sheets).toHaveLength(1)
    expect(r.sheets[0].sheet).toBe('My Data')
    expect(r.sheets[0].rowCount).toBe(2)
    const t = Object.fromEntries(r.sheets[0].columns.map((c) => [c.name, c.type]))
    expect(t).toEqual({ Name: 'text', Qty: 'number', Price: 'decimal', Born: 'date', Seen: 'datetime', OK: 'boolean', Mail: 'email', Site: 'url', Zip: 'text', Bio: 'multiline' })
  })

  it('unique identifiers, original display names, system-name collisions', async () => {
    const r = await inspectDataFile(buf('first name,First-Name,id,created on\n1,2,5,x\n'), 'a.csv')
    const cols = r.sheets[0].columns
    expect(cols.map((c) => c.name)).toEqual(['FirstName', 'FirstName_2', 'Id_2'])
    expect(cols[0].displayName).toBe('first name')
    expect(cols[2].type).toBe('number')
  })

  it('xlsx: sheets, types; empty sheet skipped', async () => {
    const r = await inspectDataFile(await xlsxFixture(), 'book.xlsx')
    expect(r.kind).toBe('xlsx')
    expect(r.sheets.map((s) => s.sheet)).toEqual(['People', 'Notes'])
    const t = Object.fromEntries(r.sheets[0].columns.map((c) => [c.name, c.type]))
    expect(t).toEqual({ FullName: 'text', Age: 'number', Joined: 'date', Active: 'boolean', Email: 'email', Score: 'decimal' })
    expect(r.sheets[1].columns[1].type).toBe('datetime')
  })

  it('json: array and object of arrays', async () => {
    const a = await inspectDataFile(buf(JSON.stringify([{ a: 1, b: 'x', c: true }, { a: 2, b: 'y', c: false, d: null }])), 'rows.json')
    expect(a.sheets[0].sheet).toBe('rows')
    expect(a.sheets[0].columns.map((c) => `${c.name}:${c.type}`)).toEqual(['A:number', 'B:text', 'C:boolean', 'D:text'])
    const o = await inspectDataFile(buf(JSON.stringify({ one: [{ x: 1 }], two: [{ y: 'a@b.co' }] })), 'any.json')
    expect(o.sheets.map((s) => s.sheet)).toEqual(['one', 'two'])
    expect(o.sheets[1].columns[0].type).toBe('email')
  })

  it('rejects bad input', async () => {
    await expect(inspectDataFile(buf('x'), 'a.txt')).rejects.toThrow(/Unsupported/)
    await expect(inspectDataFile(buf('x'), 'a.xlsm')).rejects.toThrow(/Macro/)
    await expect(inspectDataFile(buf('{"a":1}'), 'a.json')).rejects.toThrow(/array/)
    await expect(inspectDataFile(buf('[1,2]'), 'a.json')).rejects.toThrow(/array of objects/)
    await expect(inspectDataFile(buf('[]'), 'a.json')).rejects.toThrow()
    await expect(inspectDataFile(buf(''), 'a.csv')).rejects.toThrow()
    await expect(inspectDataFile(Buffer.alloc(50 * 1024 * 1024 + 1), 'a.csv')).rejects.toThrow(/50 MB/)
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('S')
    await expect(inspectDataFile(Buffer.from(await wb.xlsx.writeBuffer()), 'a.xlsx')).rejects.toThrow(/header/)
    await expect(inspectDataFile(buf('not a zip'), 'a.xlsx')).rejects.toThrow(/readable/)
  })
})

describe('store + CRUD', () => {
  it('storeDataFile adds ids and system columns (csv)', async () => {
    const res = await storeDataFile(env, 'f1', buf(CSV), 'My Data.csv')
    expect(res.storageKey).toBe('files/f1/data.csv')
    expect(res.sizeBytes).toBeGreaterThan(10)
    expect(res.checksum).toMatch(/^[0-9a-f]{64}$/)
    const tables = await conn.listSourceTables()
    expect(tables).toHaveLength(1)
    expect(tables[0].source).toBe('f1/My Data')
    expect(tables[0].rowCount).toBe(2)
    expect(tables[0].columns.map((c) => c.name)).toEqual(['id', 'Name', 'Qty', 'Price', 'Born', 'Seen', 'OK', 'Mail', 'Site', 'Zip', 'Bio', 'createdOn', 'modifiedOn', 'createdBy', 'owner'])
    const insp = await inspectDataFile(buf(CSV), 'My Data.csv')
    const rows = (await conn.select(defFor('f1/My Data', insp.sheets[0].columns), {})).rows
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/)
    expect(rows[0].Born).toEqual(new Date(Date.UTC(2020, 0, 2)))
    expect(rows[0].Bio).toBe('line1\nline2')
    expect(rows[1].OK).toBe(false)
    expect(await conn.test()).toMatchObject({ ok: true })
    await expect(storeDataFile(env, 'f1', buf(CSV), 'x.csv')).rejects.toThrow(/already exists/)
  })

  async function roundTrip(kind: 'csv' | 'xlsx' | 'json') {
    let bytes: Buffer, name: string
    if (kind === 'csv') { bytes = buf('Name,Qty,Born,Seen,OK,Note\nAnn,1,2020-01-02,2024-05-06T10:00:00Z,true,hi\n'); name = 'rt.csv' }
    else if (kind === 'json') { bytes = buf(JSON.stringify([{ Name: 'Ann', Qty: 1, Born: '2020-01-02', Seen: '2024-05-06T10:00:00Z', OK: true, Note: 'hi' }])); name = 'rt.json' }
    else {
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('rt')
      ws.addRow(['Name', 'Qty', 'Born', 'Seen', 'OK', 'Note'])
      ws.addRow(['Ann', 1, new Date(Date.UTC(2020, 0, 2)), new Date(Date.UTC(2024, 4, 6, 10)), true, 'hi'])
      bytes = Buffer.from(await wb.xlsx.writeBuffer()); name = 'rt.xlsx'
    }
    await storeDataFile(env, 'rt', bytes, name)
    const insp = await inspectDataFile(bytes, name)
    const sheet = insp.sheets[0].sheet
    const def = defFor(`rt/${sheet}`, insp.sheets[0].columns)
    expect(insp.sheets[0].columns.map((c) => c.type)).toEqual(['text', 'number', 'date', 'datetime', 'boolean', 'text'])
    const tricky = 'He said "hi", ok;\nsecond line, ünï©ödé 日本語 😀'
    const row: RawRow = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', Name: tricky, Qty: 7, Born: new Date(Date.UTC(1999, 11, 31)),
      Seen: new Date('2025-03-04T05:06:07.000Z'), OK: false, Note: null, createdOn: new Date('2025-01-01T00:00:00Z'), modifiedOn: null, createdBy: 'u1', owner: 'u1',
    }
    await conn.insert(def, [row])
    await conn.flush()
    // fresh connector instance + cache drop: read back from disk
    const bytesAfter = await readDataFile(env, 'rt')
    const again = await inspectDataFile(bytesAfter, name)
    expect(again.sheets[0].rowCount).toBe(2)
    const env2 = { ...env, filesDir: path.join(dir, 'files', '.', '') }
    const conn2 = createFilesConnector({} as never, { ...env2, filesDir: env.filesDir + '/' }) as FilesConnector
    let got = (await conn2.select(def, { orderBy: [{ col: 'Qty', dir: 'desc' }] })).rows
    expect(got).toHaveLength(2)
    expect(got[0]).toMatchObject({ id: row.id, Name: tricky, Qty: 7, OK: false, Note: null, createdBy: 'u1' })
    expect(got[0].Born).toEqual(row.Born)
    expect((got[0].Seen as Date).toISOString()).toBe('2025-03-04T05:06:07.000Z')
    expect(got[1]).toMatchObject({ Name: 'Ann', Qty: 1, OK: true })

    // update with guard, delete
    expect(await conn.update(def, row.id as string, { Qty: 8, Note: 'later' }, { col: 'createdBy', op: 'eq', value: 'nobody' })).toBe(0)
    expect(await conn.update(def, row.id as string, { Qty: 8, Note: 'later' }, { col: 'createdBy', op: 'eq', value: 'u1' })).toBe(1)
    expect(await conn.update(def, 'missing', { Qty: 1 })).toBe(0)
    await conn.flush()
    got = (await conn.select(def, { where: { col: 'Qty', op: 'ge', value: 8 }, count: true })).rows
    expect(got).toHaveLength(1)
    expect(got[0].Note).toBe('later')
    const sel = await conn.select(def, { select: ['Name'], top: 1, count: true })
    expect(sel.total).toBe(2)
    expect(Object.keys(sel.rows[0]).sort()).toEqual(['Name', 'id'])
    expect(await conn.delete(def, [row.id as string, 'nope'])).toBe(1)
    await conn.flush()
    const final = await inspectDataFile(await readDataFile(env, 'rt'), name)
    expect(final.sheets[0].rowCount).toBe(1)
    // duplicate id rejected
    await conn.insert(def, [{ id: 'dup', Name: 'a' }])
    await expect(conn.insert(def, [{ id: 'dup', Name: 'b' }])).rejects.toThrow(/already exists/)
    // all rows deleted then reload still works
    const all = (await conn.select(def, {})).rows.map((r) => r.id as string)
    await conn.delete(def, all)
    await conn.flush()
    expect((await createFilesConnector({} as never, env).select(def, {})).rows).toHaveLength(0)
    expect(logs.filter((l) => l.startsWith('error'))).toEqual([])
  }

  it('CRUD round-trip csv', () => roundTrip('csv'))
  it('CRUD round-trip json', () => roundTrip('json'))
  it('CRUD round-trip xlsx', () => roundTrip('xlsx'))

  it('xlsx writes real dates and preserves other sheets', async () => {
    const bytes = await xlsxFixture()
    await storeDataFile(env, 'x1', bytes, 'book.xlsx')
    const insp = await inspectDataFile(bytes, 'book.xlsx')
    const def = defFor('x1/People', insp.sheets[0].columns)
    const before = await readDataFile(env, 'x1')
    await conn.insert(def, [{ FullName: 'Cy', Age: 5, Joined: new Date(Date.UTC(2022, 5, 6)), Active: true, Email: 'c@x.io', Score: 3 }])
    await conn.flush()
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await readDataFile(env, 'x1') as unknown as ArrayBuffer)
    expect(wb.worksheets.map((w) => w.name)).toEqual(['People', 'Notes', 'Empty'])
    const ws = wb.getWorksheet('People')!
    expect(ws.rowCount).toBe(4)
    const joined = ws.getRow(4).getCell(4).value
    expect(joined).toBeInstanceOf(Date)
    expect((joined as Date).toISOString().slice(0, 10)).toBe('2022-06-06')
    const notes = wb.getWorksheet('Notes')!
    expect(notes.getRow(2).getCell(2).value).toBe('hello')
    expect(notes.getRow(2).getCell(3).value).toBeInstanceOf(Date)
    expect(notes.getColumn(1).width).toBe(44)
    expect((await readDataFile(env, 'x1')).equals(before)).toBe(false)
  })

  it('csv/json/xlsx createTable, addColumn, alterColumn, dropColumn, dropTable', async () => {
    await storeDataFile(env, 'd1', await xlsxFixture(), 'book.xlsx')
    const insp = await inspectDataFile(await xlsxFixture(), 'book.xlsx')
    const people = defFor('d1/People', insp.sheets[0].columns)
    const extra = defFor('d1/Extra', [{ name: 'Label', displayName: 'Label', type: 'text' }])
    await conn.createTable(extra)
    await expect(conn.createTable(extra)).rejects.toThrow(/already exists/)
    await conn.insert(extra, [{ Label: 'a' }])
    await conn.addColumn(people, { name: 'City', displayName: 'City', type: 'text' })
    await conn.alterColumn(people, { name: 'Age', displayName: 'Age', type: 'number' }, { name: 'Years', displayName: 'Years', type: 'text' })
    await conn.dropColumn(people, 'Score')
    await conn.flush()
    const c2 = createFilesConnector({} as never, env)
    const tables = await c2.listSourceTables()
    expect(tables.map((t) => t.source)).toEqual(['d1/People', 'd1/Notes', 'd1/Extra'])
    const cols = tables[0].columns.map((c) => c.name)
    expect(cols).toContain('City')
    expect(cols).toContain('Years')
    expect(cols).not.toContain('Age')
    expect(cols).not.toContain('Score')
    await conn.dropTable(extra)
    await conn.flush()
    expect((await createFilesConnector({} as never, env).listSourceTables()).map((t) => t.source)).toEqual(['d1/People', 'd1/Notes'])
    await expect(conn.dropColumn(people, 'id')).rejects.toThrow(/System/)

    // csv: new csv beside the main one
    await storeDataFile(env, 'c1', buf('A,B\n1,2\n'), 'main.csv')
    const second = defFor('c1/Second', [{ name: 'Z', displayName: 'Z', type: 'number' }])
    await conn.createTable(second)
    await conn.insert(second, [{ Z: 9 }])
    await conn.flush()
    const files = (await fs.readdir(path.join(env.filesDir, 'c1'))).sort()
    expect(files).toEqual(['Second.csv', 'data.csv', 'meta.json'])
    expect((await createFilesConnector({} as never, env).select(second, {})).rows[0].Z).toBe(9)
    await conn.dropTable(second)
    await conn.flush()
    expect((await fs.readdir(path.join(env.filesDir, 'c1'))).sort()).toEqual(['data.csv', 'meta.json'])
    // json: second sheet converts array -> object shape
    await storeDataFile(env, 'j1', buf('[{"a":1}]'), 'only.json')
    await conn.createTable(defFor('j1/Other', [{ name: 'Q', displayName: 'Q', type: 'text' }]))
    await conn.flush()
    const parsed = JSON.parse(await fs.readFile(path.join(env.filesDir, 'j1', 'data.json'), 'utf8'))
    expect(Object.keys(parsed)).toEqual(['only', 'Other'])
    // a table in a file that does not exist
    await expect(conn.createTable(defFor('nofile/S', [{ name: 'Q', displayName: 'Q', type: 'text' }]))).rejects.toThrow(/not found/)
  })
})

describe('replace / reload / safety', () => {
  it('replace by id keeps system values; without ids replaces rows', async () => {
    await storeDataFile(env, 'r1', buf('Name,Qty\nAnn,1\nBob,2\n'), 'p.csv')
    const insp = await inspectDataFile(buf('Name,Qty\nAnn,1\n'), 'p.csv')
    const def = defFor('r1/p', insp.sheets[0].columns)
    const first = (await conn.select(def, { orderBy: [{ col: 'Name', dir: 'asc' }] })).rows
    await conn.update(def, first[0].id as string, { createdBy: 'maker' })
    const downloaded = await readDataFile(env, 'r1')
    // edit the download: change Bob, drop Ann, add Cy (no id)
    const text = downloaded.toString('utf8').split('\r\n')
    const bob = text.find((l) => l.includes('Bob'))!.replace(',2,', ',20,')
    const edited = [text[0], bob, text.find((l) => l.includes('Ann'))!, ',Cy,3,,,,'].join('\r\n')
    const r = await replaceDataFile(env, 'r1', buf(edited), 'whatever.csv')
    expect(r.storageKey).toBe('files/r1/data.csv')
    const rows = (await conn.select(def, { orderBy: [{ col: 'Name', dir: 'asc' }] })).rows
    expect(rows.map((x) => [x.Name, x.Qty])).toEqual([['Ann', 1], ['Bob', 20], ['Cy', 3]])
    expect(rows[0].id).toBe(first[0].id)
    expect(rows[0].createdBy).toBe('maker')
    expect(rows[2].id).toMatch(/^[0-9a-f-]{36}$/)
    // plain replace without ids
    await replaceDataFile(env, 'r1', buf('Name,Qty\nZed,9\n'), 'new.csv')
    const after = (await conn.select(def, {})).rows
    expect(after.map((x) => x.Name)).toEqual(['Zed'])
    await expect(replaceDataFile(env, 'r1', buf('[{"a":1}]'), 'a.json')).rejects.toThrow(/\.csv/)
    await expect(replaceDataFile(env, 'missing', buf('A\n1\n'), 'a.csv')).rejects.toThrow(/not found/)
  })

  it('re-reads when the file changes on disk', async () => {
    await storeDataFile(env, 'm1', buf('Name\nAnn\n'), 'm.csv')
    const insp = await inspectDataFile(buf('Name\nAnn\n'), 'm.csv')
    const def = defFor('m1/m', insp.sheets[0].columns)
    expect((await conn.select(def, {})).rows).toHaveLength(1)
    const file = path.join(env.filesDir, 'm1', 'data.csv')
    await fs.writeFile(file, 'id,Name\r\nx1,Ann\r\nx2,Bob\r\nx3,Cy\r\n')
    const future = new Date(Date.now() + 5000)
    await fs.utimes(file, future, future)
    expect((await conn.select(def, {})).rows.map((r) => r.Name)).toEqual(['Ann', 'Bob', 'Cy'])
    // legacy rows without ids get ids
    await fs.writeFile(file, 'Name\r\nOnly\r\n')
    const f2 = new Date(Date.now() + 9000)
    await fs.utimes(file, f2, f2)
    const rows = (await conn.select(def, {})).rows
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('rejects path traversal and bad ids', async () => {
    const bad = ['../x', 'a/b', '', 'a.b', '..', 'x'.repeat(65), 'a\\b']
    for (const id of bad) {
      await expect(storeDataFile(env, id, buf('A\n1\n'), 'a.csv')).rejects.toThrow(/Invalid file id/)
      await expect(readDataFile(env, id)).rejects.toThrow(/Invalid file id/)
      await expect(removeDataFile(env, id)).rejects.toThrow(/Invalid file id/)
    }
    const def = defFor('../evil/S', [{ name: 'A', displayName: 'A', type: 'text' }])
    await expect(conn.select(def, {})).rejects.toThrow()
    await expect(conn.describe('..%2f/x')).rejects.toThrow()
    await expect(conn.describe('nofolder')).rejects.toThrow(/Invalid file source/)
    // the client name never ends up in a path
    await storeDataFile(env, 'safe', buf('A\n1\n'), '../../../evil.csv')
    expect(await fs.readdir(env.filesDir)).toEqual(['safe'])
    expect((await fs.readdir(path.join(env.filesDir, 'safe'))).sort()).toEqual(['data.csv', 'meta.json'])
  })

  it('removeDataFile deletes the folder', async () => {
    await storeDataFile(env, 'del', buf('A\n1\n'), 'a.csv')
    await conn.describe('del/a')
    await removeDataFile(env, 'del')
    await expect(conn.describe('del/a')).rejects.toThrow(/not found/)
    await expect(fs.stat(path.join(env.filesDir, 'del'))).rejects.toThrow()
  })

  it('persistence is debounced; flush writes immediately', async () => {
    await storeDataFile(env, 'p1', buf('Name\nAnn\n'), 'p.csv')
    const insp = await inspectDataFile(buf('Name\nAnn\n'), 'p.csv')
    const def = defFor('p1/p', insp.sheets[0].columns)
    const file = path.join(env.filesDir, 'p1', 'data.csv')
    await conn.select(def, {})
    await conn.insert(def, [{ Name: 'Bob' }])
    await conn.insert(def, [{ Name: 'Cy' }])
    expect(await fs.readFile(file, 'utf8')).not.toContain('Bob')
    await new Promise((r) => setTimeout(r, 120))
    expect(await fs.readFile(file, 'utf8')).not.toContain('Bob')
    await new Promise((r) => setTimeout(r, 400))
    const txt = await fs.readFile(file, 'utf8')
    expect(txt).toContain('Bob')
    expect(txt).toContain('Cy')
    await conn.insert(def, [{ Name: 'Di' }])
    await conn.flush()
    expect(await fs.readFile(file, 'utf8')).toContain('Di')
    // no leftover temp files
    expect((await fs.readdir(path.join(env.filesDir, 'p1'))).filter((f) => f.endsWith('.tmp'))).toEqual([])
    // download includes pending edits
    await conn.insert(def, [{ Name: 'Ed' }])
    expect((await readDataFile(env, 'p1')).toString('utf8')).toContain('Ed')
  })
})
