import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import type { TableDef, ColumnDef } from '../../../src/platform/contracts.ts'
import type { ConnectorEnv, ConnectionRecord } from '../../core/contracts.ts'
import {
  createGSheetsConnector, ensureIdColumn, parseSpreadsheetId, parseServiceAccountKey, buildJwtAssertion, serialToDate,
} from './index.ts'

/* ------------------------------------------------------------------ fake Google */

type Cell = string | number | boolean
interface FakeTab { sheetId: number; title: string; rowCount: number; columnCount: number; values: Cell[][]; formats: Record<number, string> }

import type { GSheetsConnector } from './index.ts'
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string
const EMAIL = 'svc@proj-1.iam.gserviceaccount.com'
const SID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
const KEY_JSON = JSON.stringify({ type: 'service_account', client_email: EMAIL, private_key: PRIVATE_PEM })

const colNum = (s: string): number => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1

class FakeGoogle {
  title = 'Test Book'
  tabs: FakeTab[] = []
  nextId = 1
  tokenCalls = 0
  apiCalls: { method: string; url: string; body: any }[] = []
  tokenTtl = 3600
  shareWith: string | null = EMAIL // email that has access; null = nobody
  failures: { status: number; retryAfter?: string; times: number }[] = []
  seenAssertion: { claims: any; valid: boolean } | null = null

  addTab(title: string, values: Cell[][], formats: Record<number, string> = {}): FakeTab {
    const t: FakeTab = { sheetId: this.nextId++, title, rowCount: Math.max(1000, values.length), columnCount: Math.max(26, ...values.map((r) => r.length)), values, formats }
    this.tabs.push(t)
    return t
  }
  tab(title: string): FakeTab { return this.tabs.find((t) => t.title === title)! }

  json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.origin === 'https://oauth2.googleapis.com') return this.token(init)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    this.apiCalls.push({ method, url: url.pathname + url.search, body })
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization
    if (auth !== 'Bearer fake-token') return this.json(401, { error: { message: 'bad token' } })
    const f = this.failures[0]
    if (f && f.times > 0) {
      f.times--
      if (f.times === 0) this.failures.shift()
      return this.json(f.status, { error: { message: 'transient' } }, f.retryAfter !== undefined ? { 'retry-after': f.retryAfter } : {})
    }
    if (this.shareWith !== EMAIL) return this.json(403, { error: { message: 'The caller does not have permission' } })
    return this.api(method, url, body)
  }

  token(init?: RequestInit): Response {
    this.tokenCalls++
    const form = new URLSearchParams(String(init?.body))
    if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') return this.json(400, { error: 'unsupported_grant_type' })
    const [h, c, s] = (form.get('assertion') ?? '').split('.')
    const v = createVerify('RSA-SHA256')
    v.update(`${h}.${c}`)
    const valid = v.verify(PUBLIC_PEM, Buffer.from(s, 'base64url'))
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString())
    const header = JSON.parse(Buffer.from(h, 'base64url').toString())
    this.seenAssertion = { claims, valid: valid && header.alg === 'RS256' }
    if (!valid) return this.json(400, { error: 'invalid_grant', error_description: 'Invalid signature' })
    return this.json(200, { access_token: 'fake-token', token_type: 'Bearer', expires_in: this.tokenTtl })
  }

  parseRange(r: string): { tab: FakeTab; c1?: number; r1?: number; c2?: number; r2?: number } {
    const m = /^(?:'((?:[^']|'')+)'|([^!]+))(?:!(.+))?$/.exec(r)!
    const title = (m[1] ?? m[2]).replace(/''/g, "'")
    const tab = this.tab(title)
    if (!tab) throw new Error(`no tab ${title}`)
    if (!m[3]) return { tab }
    const a = /^([A-Z]+)?(\d+)?(?::([A-Z]+)?(\d+)?)?$/.exec(m[3])!
    return {
      tab,
      c1: a[1] ? colNum(a[1]) : undefined, r1: a[2] ? Number(a[2]) : undefined,
      c2: a[3] ? colNum(a[3]) : a[1] && a[4] ? colNum(a[1]) : undefined, r2: a[4] ? Number(a[4]) : undefined,
    }
  }

  api(method: string, url: URL, body: any): Response {
    const path = decodeURIComponent(url.pathname).replace(`/v4/spreadsheets/${SID}`, '')
    if (path === '' && method === 'GET') {
      if (url.searchParams.get('includeGridData')) {
        return this.json(200, {
          sheets: this.tabs.map((t) => ({
            properties: { title: t.title },
            data: [{ rowData: [{ values: (t.values[1] ?? []).map((_, i) => ({ effectiveFormat: { numberFormat: { type: t.formats[i] ?? 'NUMBER' } } })) }] }],
          })),
        })
      }
      return this.json(200, {
        properties: { title: this.title },
        sheets: this.tabs.map((t) => ({ properties: { sheetId: t.sheetId, title: t.title, gridProperties: { rowCount: t.rowCount, columnCount: t.columnCount } } })),
      })
    }
    if (path.startsWith('/values/') && path.endsWith(':append') && method === 'POST') {
      const { tab } = this.parseRange(path.slice('/values/'.length, -':append'.length))
      if (url.searchParams.get('valueInputOption') !== 'RAW') return this.json(400, { error: { message: 'need RAW' } })
      let last = tab.values.length
      while (last > 0 && tab.values[last - 1].every((c) => c === '')) last--
      tab.values.length = last
      for (const row of body.values as Cell[][]) tab.values.push(row)
      return this.json(200, { updates: { updatedRows: body.values.length } })
    }
    if (path.startsWith('/values/') && method === 'GET') {
      const { tab } = this.parseRange(path.slice('/values/'.length))
      if (url.searchParams.get('valueRenderOption') !== 'UNFORMATTED_VALUE' || url.searchParams.get('dateTimeRenderOption') !== 'SERIAL_NUMBER') return this.json(400, { error: { message: 'render options' } })
      const rows = tab.values.map((r) => { const x = [...r]; while (x.length && x[x.length - 1] === '') x.pop(); return x })
      while (rows.length && rows[rows.length - 1].length === 0) rows.pop()
      return this.json(200, { range: tab.title, majorDimension: 'ROWS', values: rows })
    }
    if (path.startsWith('/values/') && method === 'PUT') {
      const p = this.parseRange(path.slice('/values/'.length))
      this.put(p.tab, p.c1 ?? 0, p.r1 ?? 1, body.values)
      return this.json(200, {})
    }
    if (path === '/values:batchUpdate' && method === 'POST') {
      for (const d of body.data) { const p = this.parseRange(d.range); this.put(p.tab, p.c1 ?? 0, p.r1 ?? 1, d.values) }
      return this.json(200, {})
    }
    if (path === ':batchUpdate' && method === 'POST') {
      for (const rq of body.requests) this.request(rq)
      return this.json(200, { replies: [] })
    }
    return this.json(404, { error: { message: `fake: no route ${method} ${path}` } })
  }

  put(tab: FakeTab, c: number, r: number, values: Cell[][]): void {
    values.forEach((row, ri) => {
      while (tab.values.length < r + ri) tab.values.push([])
      const line = tab.values[r - 1 + ri]
      row.forEach((v, ci) => {
        if (c + ci >= tab.columnCount) throw new Error('exceeds grid limits')
        while (line.length <= c + ci) line.push('')
        line[c + ci] = v
      })
    })
  }

  request(rq: any): void {
    if (rq.addSheet) {
      const p = rq.addSheet.properties
      this.addTab(p.title, [])
      this.tab(p.title).columnCount = p.gridProperties?.columnCount ?? 26
    } else if (rq.deleteSheet) {
      this.tabs = this.tabs.filter((t) => t.sheetId !== rq.deleteSheet.sheetId)
    } else if (rq.appendDimension) {
      const t = this.tabs.find((x) => x.sheetId === rq.appendDimension.sheetId)!
      if (rq.appendDimension.dimension === 'COLUMNS') t.columnCount += rq.appendDimension.length
    } else if (rq.deleteDimension) {
      const { sheetId, dimension, startIndex, endIndex } = rq.deleteDimension.range
      const t = this.tabs.find((x) => x.sheetId === sheetId)!
      if (dimension === 'ROWS') t.values.splice(startIndex, endIndex - startIndex)
      else { for (const row of t.values) row.splice(startIndex, endIndex - startIndex); t.columnCount -= endIndex - startIndex }
    } else throw new Error(`fake: unsupported request ${Object.keys(rq)[0]}`)
  }
}

/* ------------------------------------------------------------------ fixtures */

const col = (name: string, type: ColumnDef['type'], extra: Partial<ColumnDef> = {}): ColumnDef => ({ name, displayName: name, type, ...extra })
const defOf = (source: string, columns: ColumnDef[]): TableDef => ({
  id: `t_${source}`, name: source.replace(/\W/g, '_'), displayName: source, primaryColumn: 'name', columns,
  createdOn: '', modifiedOn: '', source, connectionId: 'conn_g',
})
const peopleDef = defOf('People', [col('id', 'text', { system: true }), col('name', 'text'), col('age', 'number'), col('born', 'date'), col('active', 'boolean')])

let g: FakeGoogle
function make(opts: { secret?: string; settings?: Record<string, string> } = {}) {
  const env: ConnectorEnv = { workspaceDir: '/tmp', filesDir: '/tmp', fetch: g.fetch as typeof fetch, log: () => {} }
  const conn: ConnectionRecord = {
    id: 'conn_g', name: 'Sheets', connector: 'gsheets', status: 'connected',
    settings: opts.settings ?? { spreadsheetId: SID }, secret: opts.secret ?? KEY_JSON,
  }
  return createGSheetsConnector(conn, env) as GSheetsConnector
}

beforeEach(() => {
  g = new FakeGoogle()
  g.addTab('People', [
    ['id', 'name', 'age', 'born', 'active'],
    ['a1', 'Ann', 30, 36526, true], // 2000-01-01
    ['a2', 'Bob', 41, 25569.5, false], // 1970-01-01T12:00Z
    ['', '', '', '', ''],
  ], { 3: 'DATE' })
})
afterEach(() => { vi.useRealTimers() })

/* ------------------------------------------------------------------ tests */

describe('helpers', () => {
  it('extracts the spreadsheet id from URLs and raw ids', () => {
    expect(parseSpreadsheetId(`https://docs.google.com/spreadsheets/d/${SID}/edit#gid=0`)).toBe(SID)
    expect(parseSpreadsheetId(`  ${SID} `)).toBe(SID)
    expect(() => parseSpreadsheetId('not a sheet')).toThrow(/spreadsheet id/)
    expect(() => parseSpreadsheetId('')).toThrow()
  })

  it('validates the service-account key without echoing it', () => {
    expect(parseServiceAccountKey(KEY_JSON).client_email).toBe(EMAIL)
    for (const bad of ['', 'nope {PRIVATE-MARKER', '[]', JSON.stringify({ client_email: EMAIL }), JSON.stringify({ client_email: 'x', private_key: 'PRIVATE-MARKER' })]) {
      try { parseServiceAccountKey(bad); throw new Error('should fail') } catch (e) {
        expect((e as Error).message).not.toContain('PRIVATE-MARKER')
        expect((e as Error).message).not.toBe('should fail')
      }
    }
  })

  it('converts Google serial numbers (epoch 1899-12-30, UTC)', () => {
    expect(serialToDate(36526).toISOString()).toBe('2000-01-01T00:00:00.000Z')
    expect(serialToDate(25569.5).toISOString()).toBe('1970-01-01T12:00:00.000Z')
  })

  it('signs a JWT that verifies with the public key', () => {
    const jwt = buildJwtAssertion({ client_email: EMAIL, private_key: PRIVATE_PEM }, 1_000_000)
    const [h, c, s] = jwt.split('.')
    const v = createVerify('RSA-SHA256'); v.update(`${h}.${c}`)
    expect(v.verify(PUBLIC_PEM, Buffer.from(s, 'base64url'))).toBe(true)
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toMatchObject({ iss: EMAIL, exp: 1_003_600, aud: 'https://oauth2.googleapis.com/token' })
  })
})

describe('token flow', () => {
  it('exchanges a verified JWT and caches the token until 60 s before expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const c = make()
    await c.listSourceTables()
    await c.describe('People')
    expect(g.tokenCalls).toBe(1)
    expect(g.seenAssertion!.valid).toBe(true)
    expect(g.seenAssertion!.claims.scope).toBe('https://www.googleapis.com/auth/spreadsheets')
    vi.setSystemTime(new Date('2026-01-01T00:58:00Z')) // 2 min before expiry: still cached
    await c.describe('People')
    expect(g.tokenCalls).toBe(1)
    vi.setSystemTime(new Date('2026-01-01T00:59:30Z')) // inside the 60 s window: refresh
    await c.describe('People')
    expect(g.tokenCalls).toBe(2)
  })

  it('reports bad credentials from test() without leaking the key', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const r = await make({ secret: JSON.stringify({ client_email: EMAIL, private_key: other }) }).test()
    expect(r.ok).toBe(false)
    expect(r.message).not.toContain('PRIVATE KEY')
  })
})

describe('test()', () => {
  it('connects and names the book', async () => {
    const r = await make().test()
    expect(r).toMatchObject({ ok: true })
    expect(r.message).toContain('Test Book')
  })

  it('on 403 names the service-account email to share with', async () => {
    g.shareWith = null
    const r = await make().test()
    expect(r.ok).toBe(false)
    expect(r.message).toContain(EMAIL)
    expect(r.message).toMatch(/share/i)
    expect(r.message).not.toContain('PRIVATE KEY')
  })

  it('reports invalid configuration', async () => {
    expect((await make({ secret: 'garbage' }).test()).ok).toBe(false)
    expect((await make({ settings: { spreadsheetId: '??' } }).test()).ok).toBe(false)
    expect((await make({ settings: { spreadsheetId: `https://docs.google.com/spreadsheets/d/${SID}/edit` } }).test()).ok).toBe(true)
  })
})

describe('discovery', () => {
  it('lists tabs with inferred types, row counts and id presence', async () => {
    g.addTab('Loose', [['Order No', 'Placed', 'Contact', 'Price'], ['x', '2024-05-01', 'a@b.co', 1.5], ['y', '2024-05-02', 'c@d.org', 2]])
    const tabs = await make().listSourceTables()
    expect(tabs.map((t) => t.source)).toEqual(['People', 'Loose'])
    const people = tabs[0] as any
    expect(people.hasId).toBe(true)
    expect(people.rowCount).toBe(2)
    expect(Object.fromEntries(people.columns.map((c: any) => [c.name, c.type]))).toEqual({ id: 'text', name: 'text', age: 'number', born: 'date', active: 'boolean' })
    const loose = tabs[1] as any
    expect(loose.hasId).toBe(false)
    expect(Object.fromEntries(loose.columns.map((c: any) => [c.name, c.type]))).toEqual({ Order_No: 'text', Placed: 'date', Contact: 'email', Price: 'decimal' })
  })

  it('describe throws a clear error for a missing tab', async () => {
    await expect(make().describe('Nope')).rejects.toThrow(/no tab named "Nope"/)
  })
})

describe('read', () => {
  it('returns typed rows, serial numbers as Dates, empty rows ignored', async () => {
    const { rows } = await make().select(peopleDef, {})
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ id: 'a1', name: 'Ann', age: 30, born: new Date('2000-01-01T00:00:00Z'), active: true })
    expect((rows[1].born as Date).toISOString()).toBe('1970-01-01T12:00:00.000Z')
  })

  it('applies the query in memory', async () => {
    const r = await make().select(peopleDef, { where: { col: 'age', op: 'gt', value: 35 }, count: true })
    expect(r.rows.map((x) => x.id)).toEqual(['a2'])
    expect(r.total).toBe(1)
  })

  it('caches values for 15 s and drops the cache on writes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const c = make()
    const reads = () => g.apiCalls.filter((x) => x.method === 'GET' && x.url.includes('/values/')).length
    await c.select(peopleDef, {})
    await c.select(peopleDef, {})
    expect(reads()).toBe(1)
    vi.setSystemTime(new Date('2026-01-01T00:00:16Z'))
    await c.select(peopleDef, {})
    expect(reads()).toBe(2)
    await c.update(peopleDef, 'a1', { age: 31 })
    const before = reads()
    await c.select(peopleDef, {})
    expect(reads()).toBe(before + 1) // update did its own fresh read, then cache was invalidated
  })

  it('matches headers by display name', async () => {
    g.addTab('Names', [['Full Name'], ['Zed']])
    const def = defOf('Names', [col('full', 'text', { displayName: 'Full Name' })])
    expect((await make().select(def, {})).rows).toEqual([{ full: 'Zed' }])
  })
})

describe('writes', () => {
  it('inserts rows with RAW values and generates missing ids', async () => {
    const c = make()
    await c.insert(peopleDef, [
      { id: 'a3', name: '=HYPERLINK("x")', age: 5, born: new Date('2010-02-03T00:00:00Z'), active: false },
      { name: 'NoId', age: null, born: null, active: null },
    ])
    const v = g.tab('People').values
    expect(v[3]).toEqual(['a3', '=HYPERLINK("x")', 5, '2010-02-03', false])
    expect(v[4][0]).toMatch(/^[0-9a-f-]{36}$/)
    const append = g.apiCalls.find((x) => x.url.includes(':append'))!
    expect(append.url).toContain('valueInputOption=RAW')
    const { rows } = await c.select(peopleDef, {})
    expect(rows).toHaveLength(4)
    expect((rows[2].born as Date).toISOString()).toBe('2010-02-03T00:00:00.000Z')
  })

  it('updates a row located by id, only the changed cells, honouring the guard', async () => {
    const c = make()
    expect(await c.update(peopleDef, 'a2', { age: 42, name: 'Bobby' })).toBe(1)
    expect(g.tab('People').values[2]).toEqual(['a2', 'Bobby', 42, 25569.5, false])
    expect(await c.update(peopleDef, 'zzz', { age: 1 })).toBe(0)
    expect(await c.update(peopleDef, 'a1', { age: 99 }, { col: 'name', op: 'eq', value: 'Nobody' })).toBe(0)
    expect(g.tab('People').values[1][2]).toBe(30)
    expect(await c.update(peopleDef, 'a1', { born: new Date('2001-02-03T00:00:00Z') }, { col: 'name', op: 'eq', value: 'ann' })).toBe(1)
    expect(g.tab('People').values[1][3]).toBe('2001-02-03')
    const { rows } = await c.select(peopleDef, { where: { col: 'id', op: 'eq', value: 'a1' } })
    expect((rows[0].born as Date).toISOString()).toBe('2001-02-03T00:00:00.000Z')
  })

  it('deletes by id in descending row order', async () => {
    g.tab('People').values.splice(3, 0, ['a3', 'Cy', 1, 1, true], ['a4', 'Di', 2, 2, true])
    const c = make()
    expect(await c.delete(peopleDef, ['a1', 'a3', 'missing'])).toBe(2)
    const dels = g.apiCalls.filter((x) => x.url.endsWith(':batchUpdate') && x.body?.requests?.[0]?.deleteDimension)[0].body.requests
    expect(dels.map((r: any) => r.deleteDimension.range.startIndex)).toEqual([3, 1])
    expect(g.tab('People').values.map((r) => r[0])).toEqual(['id', 'a2', 'a4', ''].slice(0, g.tab('People').values.length))
    expect(g.tab('People').values.some((r) => r[0] === 'a1' || r[0] === 'a3')).toBe(false)
    expect(await c.delete(peopleDef, ['a2'], { col: 'name', op: 'eq', value: 'x' })).toBe(0)
  })

  it('serialises concurrent writes', async () => {
    const c = make()
    await Promise.all([1, 2, 3].map((n) => c.insert(peopleDef, [{ id: `n${n}`, name: `N${n}`, age: n, born: null, active: null }])))
    expect(g.tab('People').values.filter((r) => String(r[0]).startsWith('n'))).toHaveLength(3)
  })

  it('refuses update/delete on a tab without an id column', async () => {
    g.addTab('NoId', [['name'], ['x']])
    const def = defOf('NoId', [col('id', 'text'), col('name', 'text')])
    await expect(make().update(def, 'q', { name: 'y' })).rejects.toThrow(/no id column/)
  })
})

describe('ensureIdColumn', () => {
  it('adds the id column at the end (growing the grid) and fills blanks', async () => {
    const t = g.addTab('Wide', [Array.from({ length: 26 }, (_, i) => `c${i}`), ...Array.from({ length: 3 }, (_, r) => Array.from({ length: 26 }, (_, i) => `v${r}${i}`)), [], ['gap']])
    t.values[4] = new Array(26).fill('')
    t.values[4][0] = 'after-gap'
    t.values[4][1] = ''
    const c = make()
    const res = await ensureIdColumn(c, 'Wide')
    expect(res).toEqual({ added: true, filled: 5 })
    expect(t.columnCount).toBe(27)
    expect(t.values[0][26]).toBe('id')
    const ids = [1, 2, 3, 4, 5].map((r) => t.values[r][26])
    expect(new Set(ids).size).toBe(5)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/)
    const second = await ensureIdColumn(c, 'Wide')
    expect(second).toEqual({ added: false, filled: 0 })
  })

  it('keeps existing ids and only fills blanks', async () => {
    g.addTab('Half', [['name', 'id'], ['a', 'keep'], ['b', ''], ['c', 'keep2']])
    const res = await make().ensureIdColumn('Half')
    expect(res).toEqual({ added: false, filled: 1 })
    const v = g.tab('Half').values
    expect(v[1][1]).toBe('keep')
    expect(v[3][1]).toBe('keep2')
    expect(v[2][1]).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('then lets rows be updated by id', async () => {
    g.addTab('Plain', [['name', 'qty'], ['a', 1], ['b', 2]])
    const c = make()
    await c.ensureIdColumn('Plain')
    const def = defOf('Plain', [col('id', 'text'), col('name', 'text'), col('qty', 'number')])
    const { rows } = await c.select(def, {})
    expect(await c.update(def, String(rows[1].id), { qty: 20 })).toBe(1)
    expect(g.tab('Plain').values[2][1]).toBe(20)
  })

  it('rejects connectors that are not Google Sheets', () => {
    expect(() => ensureIdColumn({} as any, 'x')).toThrow(/only available/)
  })
})

describe('DDL', () => {
  it('createTable adds a tab with the header row', async () => {
    const def = defOf('Orders', [col('id', 'text'), col('total', 'currency'), col('placed', 'datetime')])
    const c = make()
    await c.createTable(def)
    expect(g.tab('Orders').values).toEqual([['id', 'total', 'placed']])
    await expect(c.createTable(def)).rejects.toThrow(/already has a tab/)
    await c.insert(def, [{ id: 'o1', total: 9.5, placed: new Date('2024-01-02T03:04:05Z') }])
    expect(g.tab('Orders').values[1]).toEqual(['o1', 9.5, '2024-01-02T03:04:05.000Z'])
  })

  it('addColumn appends a header (growing the grid when full) and is idempotent', async () => {
    const t = g.tab('People')
    t.columnCount = 5
    const c = make()
    await c.addColumn(peopleDef, col('email', 'email'))
    expect(t.columnCount).toBe(6)
    expect(t.values[0]).toEqual(['id', 'name', 'age', 'born', 'active', 'email'])
    await c.addColumn(peopleDef, col('email', 'email'))
    expect(t.values[0]).toHaveLength(6)
  })

  it('dropColumn removes the column via deleteDimension COLUMNS', async () => {
    await make().dropColumn(peopleDef, 'age')
    expect(g.tab('People').values[0]).toEqual(['id', 'name', 'born', 'active'])
    expect(g.tab('People').values[1]).toEqual(['a1', 'Ann', 36526, true])
    const req = g.apiCalls.map((x) => x.body?.requests?.[0]?.deleteDimension).find(Boolean)
    expect(req.range).toMatchObject({ dimension: 'COLUMNS', startIndex: 2, endIndex: 3 })
  })

  it('alterColumn renames the header; type-only changes touch nothing', async () => {
    const c = make()
    await c.alterColumn(peopleDef, col('age', 'number'), col('age', 'decimal'))
    expect(g.apiCalls.filter((x) => x.method !== 'GET')).toHaveLength(0)
    await c.alterColumn(peopleDef, col('age', 'number'), col('years', 'number'))
    expect(g.tab('People').values[0][2]).toBe('years')
  })

  it('dropTable deletes the tab', async () => {
    g.addTab('Other', [['a']])
    await make().dropTable(defOf('Other', [col('a', 'text')]))
    expect(g.tabs.map((t) => t.title)).toEqual(['People'])
  })

  it('quotes tab names with apostrophes and spaces', async () => {
    g.addTab("Bob's Sheet", [['id', 'name'], ['1', 'x']])
    const def = defOf("Bob's Sheet", [col('id', 'text'), col('name', 'text')])
    expect((await make().select(def, {})).rows).toEqual([{ id: '1', name: 'x' }])
  })
})

describe('retries and errors', () => {
  it('retries 429 honouring Retry-After', async () => {
    g.failures.push({ status: 429, retryAfter: '0', times: 2 })
    const c = make()
    const { rows } = await c.select(peopleDef, {})
    expect(rows).toHaveLength(2)
    // 2 failed + success for the meta call, then values call
    expect(g.apiCalls.length).toBe(4)
  })

  it('uses exponential backoff (500 ms base) without Retry-After', async () => {
    g.failures.push({ status: 503, times: 1 })
    const t0 = Date.now()
    await make().listSourceTables()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450)
  })

  it('gives up after 4 attempts with a clean message', async () => {
    g.failures.push({ status: 500, retryAfter: '0', times: 10 })
    await expect(make().select(peopleDef, {})).rejects.toThrow(/Google Sheets API error 500/)
    expect(g.apiCalls).toHaveLength(4)
  })

  it('does not retry a 400', async () => {
    g.failures.push({ status: 400, times: 5 })
    await expect(make().select(peopleDef, {})).rejects.toThrow(/error 400/)
    expect(g.apiCalls).toHaveLength(1)
  })

  it('403 errors from data calls name the email to share with', async () => {
    g.shareWith = null
    await expect(make().select(peopleDef, {})).rejects.toThrow(new RegExp(EMAIL.replace(/\./g, '\\.')))
  })

  it('never leaks key material in thrown errors', async () => {
    const body = PRIVATE_PEM.split('\n').filter((l) => l && !l.startsWith('-----'))[2]
    const failures: string[] = []
    const attempt = async (fn: () => Promise<unknown>) => { try { await fn() } catch (e) { failures.push((e as Error).message) } }
    g.shareWith = null
    const c = make()
    await attempt(() => c.select(peopleDef, {}))
    await attempt(() => c.insert(peopleDef, [{ id: 'x' }]))
    await attempt(() => make({ secret: PRIVATE_PEM }).select(peopleDef, {}))
    await attempt(() => make({ secret: JSON.stringify({ client_email: EMAIL, private_key: '-----BEGIN PRIVATE KEY-----\n' + body + '\n-----END PRIVATE KEY-----' }) }).select(peopleDef, {}))
    const t = await make({ secret: JSON.stringify({ client_email: EMAIL, private_key: '-----BEGIN PRIVATE KEY-----\n' + body + '\n-----END PRIVATE KEY-----' }) }).test()
    failures.push(t.message)
    expect(failures.length).toBeGreaterThanOrEqual(5)
    for (const m of failures) { expect(m).not.toContain(body); expect(m).not.toContain('BEGIN PRIVATE KEY') }
  })
})
