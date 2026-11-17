/**
 * Google Sheets connector (SPEC3 7.3). No Google packages: JWT bearer flow with node:crypto, Sheets API v4 through
 * the injected env.fetch. One tab = one table, row 1 = column names. Rows are located by the `id` column.
 *
 * Writes use valueInputOption=RAW, so nothing a user types can become a formula. Dates and datetimes are written
 * as ISO text (YYYY-MM-DD / full ISO) and read back from either ISO text or serial numbers.
 */
import { createSign, randomUUID } from 'node:crypto'
import type { ColumnDef, TableDef } from '../../../src/platform/contracts.ts'
import type { Condition, Query } from '../../../src/platform/http.ts'
import type {
  Connector, ConnectorCapabilities, ConnectorEnv, ConnectorFactory, ConnectionRecord, RawRow, SourceColumn,
} from '../../core/contracts.ts'
import { applyQuery, evaluateCondition } from '../../core/condition.ts'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
const API = 'https://sheets.googleapis.com/v4/spreadsheets'
const CACHE_MS = 15_000
const INFER_ROWS = 200
const MAX_ATTEMPTS = 4
const BASE_DELAY_MS = 500
const MAX_RETRY_AFTER_MS = 30_000

type Cell = string | number | boolean | null | undefined
type Json = Record<string, any>

/* ------------------------------------------------------------------ pure helpers */

/** Accepts a full Google Sheets URL or a raw spreadsheet id. */
export function parseSpreadsheetId(input: string | undefined | null): string {
  const s = (input ?? '').trim()
  if (!s) throw new Error('No spreadsheet id or URL was given.')
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(s)
  if (m) return m[1]
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s
  throw new Error('Could not find a spreadsheet id. Paste the sheet URL (https://docs.google.com/spreadsheets/d/<id>/edit) or the id itself.')
}

export interface ServiceAccountKey { client_email: string; private_key: string }

/** Parses the service-account JSON key. Error messages never contain any part of the key text. */
export function parseServiceAccountKey(text: string | undefined | null): ServiceAccountKey {
  if (!text || !text.trim()) throw new Error('No service-account key is configured for this connection. Paste the JSON key file contents.')
  let obj: unknown
  try { obj = JSON.parse(text) } catch { throw new Error('The service-account key is not valid JSON. Paste the whole contents of the downloaded .json key file.') }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('The service-account key must be a JSON object.')
  const o = obj as Record<string, unknown>
  if (typeof o.client_email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(o.client_email)) throw new Error('The service-account key has no valid "client_email" field.')
  if (typeof o.private_key !== 'string' || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(o.private_key)) throw new Error('The service-account key has no valid "private_key" field.')
  return { client_email: o.client_email, private_key: o.private_key }
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

/** Signed RS256 JWT for the OAuth 2.0 JWT bearer flow. `nowSec` is injectable for tests. */
export function buildJwtAssertion(key: ServiceAccountKey, nowSec: number = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }))
  const input = `${head}.${claims}`
  let sig: Buffer
  try {
    const signer = createSign('RSA-SHA256')
    signer.update(input)
    sig = signer.sign(key.private_key)
  } catch {
    throw new Error('The private key in the service-account key could not be used to sign (it is malformed or not an RSA key).')
  }
  return `${input}.${b64url(sig)}`
}

const GOOGLE_EPOCH = Date.UTC(1899, 11, 30)
export const serialToDate = (n: number): Date => new Date(GOOGLE_EPOCH + Math.round(n * 86_400_000))

function colLetter(i: number): string {
  let n = i + 1, s = ''
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) }
  return s
}
const quoteTab = (t: string): string => `'${t.replace(/'/g, "''")}'`
const isBlank = (v: Cell): boolean => v === null || v === undefined || v === ''
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/

function sanitizeName(h: string, idx: number): string {
  if (h.toLowerCase() === 'id') return 'id'
  let n = h.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  if (!n) n = `col_${idx + 1}`
  if (/^[0-9]/.test(n)) n = `_${n}`
  return n.slice(0, 64)
}

function toDate(v: Cell, type: 'date' | 'datetime'): Date | null {
  if (isBlank(v)) return null
  if (typeof v === 'number') return serialToDate(v)
  if (typeof v === 'string') {
    const s = v.trim()
    if (ISO_DATE.test(s)) return new Date(`${s}T00:00:00.000Z`)
    if (ISO_DATETIME.test(s)) {
      const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(s)
      const t = Date.parse(hasZone ? s.replace(' ', 'T') : `${s.replace(' ', 'T')}Z`)
      return Number.isNaN(t) ? null : new Date(t)
    }
    const n = Number(s)
    if (s !== '' && !Number.isNaN(n)) return serialToDate(n)
  }
  return null
}

function fromCell(v: Cell, type: ColumnDef['type']): RawRow[string] {
  if (isBlank(v)) return null
  switch (type) {
    case 'number': case 'decimal': case 'currency': {
      if (typeof v === 'number') return v
      const n = Number(String(v).replace(/,/g, ''))
      return String(v).trim() === '' || Number.isNaN(n) ? null : n
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v
      const s = String(v).trim().toLowerCase()
      if (s === 'true' || s === '1' || s === 'yes') return true
      if (s === 'false' || s === '0' || s === 'no') return false
      return null
    }
    case 'date': case 'datetime': return toDate(v, type)
    default: return typeof v === 'string' ? v : String(v === true ? 'TRUE' : v === false ? 'FALSE' : v)
  }
}

function toCellValue(v: RawRow[string] | undefined, type: ColumnDef['type'] | undefined): string | number | boolean {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return ''
    const iso = v.toISOString()
    return type === 'date' ? iso.slice(0, 10) : iso
  }
  if (typeof v === 'string' && type === 'date' && ISO_DATETIME.test(v)) return v.slice(0, 10)
  return v
}

/** Infers a column type from up to INFER_ROWS values. `fmt` is the Sheets number-format type of the first data row. */
function inferType(values: Cell[], fmt?: string): ColumnDef['type'] {
  const v = values.filter((x) => !isBlank(x))
  if (!v.length) return 'text'
  if (v.every((x) => typeof x === 'boolean')) return 'boolean'
  if (v.every((x) => typeof x === 'number')) {
    if (fmt === 'DATE') return 'date'
    if (fmt === 'DATE_TIME') return 'datetime'
    return v.every((x) => Number.isInteger(x)) ? 'number' : 'decimal'
  }
  if (v.every((x) => typeof x === 'string')) {
    const s = v as string[]
    if (s.every((x) => ISO_DATE.test(x.trim()))) return 'date'
    if (s.every((x) => ISO_DATETIME.test(x.trim()))) return 'datetime'
    if (s.every((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.trim()))) return 'email'
    if (s.every((x) => /^https?:\/\/\S+$/i.test(x.trim()))) return 'url'
    if (s.some((x) => x.length > 255 || x.includes('\n'))) return 'multiline'
  }
  return 'text'
}

/* ------------------------------------------------------------------ errors and write queue */

class SheetsError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status; this.name = 'SheetsError' }
}

const queues = new Map<string, Promise<unknown>>()
function serialise<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(key, next.then(() => undefined, () => undefined))
  return next
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function retryDelay(res: Response | null, attempt: number): number {
  const ra = res?.headers.get('retry-after')
  if (ra) {
    const secs = Number(ra)
    if (!Number.isNaN(secs)) return Math.min(Math.max(0, secs * 1000), MAX_RETRY_AFTER_MS)
    const t = Date.parse(ra)
    if (!Number.isNaN(t)) return Math.min(Math.max(0, t - Date.now()), MAX_RETRY_AFTER_MS)
  }
  return BASE_DELAY_MS * 2 ** (attempt - 1)
}

/* ------------------------------------------------------------------ connector */

interface TabData { sheetId: number; title: string; rowCount: number; columnCount: number }
interface Loaded {
  tab: TabData
  /** trimmed header cells (strings) */
  header: string[]
  /** non-empty data rows with their 1-based sheet row numbers */
  rows: { rowNumber: number; cells: Cell[] }[]
}

export interface GSheetsConnector extends Connector {
  /** Adds an `id` column at the end (when missing) and fills blank ids with UUIDs. Call after the user consented. */
  ensureIdColumn(source: string): Promise<{ added: boolean; filled: number }>
}

class GSheets implements GSheetsConnector {
  readonly kind = 'gsheets' as const
  readonly capabilities: ConnectorCapabilities = { ddl: true, write: true, pushdown: false, transactions: false }
  private conn: ConnectionRecord
  private env: ConnectorEnv
  private key: ServiceAccountKey | null = null
  private sid: string | null = null
  private token: { value: string; expiresAt: number } | null = null
  private tokenInflight: Promise<string> | null = null
  private valuesCache = new Map<string, { at: number; data: { values: Cell[][] } }>()
  private metaCache: { at: number; title: string; tabs: TabData[] } | null = null

  constructor(conn: ConnectionRecord, env: ConnectorEnv) { this.conn = conn; this.env = env }

  /* ---- config */
  private getKey(): ServiceAccountKey { return (this.key ??= parseServiceAccountKey(this.conn.secret)) }
  private getSid(): string { return (this.sid ??= parseSpreadsheetId(this.conn.settings?.spreadsheetId)) }

  /* ---- transport */
  private async send(url: string, init: RequestInit): Promise<Response> {
    let last: Response | null = null
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response
      try {
        res = await this.env.fetch(url, init)
      } catch (e) {
        if (attempt >= MAX_ATTEMPTS) throw new Error(`Could not reach Google: ${e instanceof Error ? e.message : 'network error'}`)
        await sleep(retryDelay(null, attempt))
        continue
      }
      last = res
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < MAX_ATTEMPTS) {
        this.env.log('warn', `gsheets: HTTP ${res.status}, retry ${attempt}/${MAX_ATTEMPTS - 1}`)
        await sleep(retryDelay(res, attempt))
        continue
      }
      return res
    }
    return last as Response
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value
    this.tokenInflight ??= this.fetchToken().finally(() => { this.tokenInflight = null })
    return this.tokenInflight
  }

  private async fetchToken(): Promise<string> {
    const key = this.getKey()
    const assertion = buildJwtAssertion(key)
    const res = await this.send(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    })
    const body = await res.json().catch(() => ({})) as Json
    if (!res.ok || typeof body.access_token !== 'string') {
      const why = typeof body.error_description === 'string' ? body.error_description : typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
      throw new Error(`Google rejected the service-account credentials (${why}). Check that the key is current and the Google Sheets API is enabled for its project.`)
    }
    const ttl = typeof body.expires_in === 'number' ? body.expires_in : 3600
    this.token = { value: body.access_token, expiresAt: Date.now() + ttl * 1000 }
    return body.access_token
  }

  private shareHint(): string {
    let email = 'the service account'
    try { email = this.getKey().client_email } catch { /* reported elsewhere */ }
    return `Share the spreadsheet with ${email} (Editor access) and make sure the Google Sheets API is enabled for the key's project.`
  }

  /** `path` is appended to /spreadsheets/{id} (e.g. '', '/values/...', ':batchUpdate'). */
  private async call(method: string, path: string, opts: { query?: [string, string][]; body?: unknown } = {}): Promise<Json> {
    const q = opts.query?.length ? `?${new URLSearchParams(opts.query).toString()}` : ''
    const url = `${API}/${this.getSid()}${path}${q}`
    let res: Response | null = null
    for (let pass = 0; pass < 2; pass++) {
      const token = await this.getToken()
      res = await this.send(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      })
      if (res.status === 401 && pass === 0) { this.token = null; continue }
      break
    }
    const r = res as Response
    const text = await r.text()
    let data: Json = {}
    try { data = text ? JSON.parse(text) : {} } catch { /* non-JSON body */ }
    if (!r.ok) {
      const msg = typeof data?.error?.message === 'string' ? data.error.message : `HTTP ${r.status}`
      const hint = r.status === 403 || r.status === 404 ? ` ${this.shareHint()}` : ''
      throw new SheetsError(r.status, `Google Sheets API error ${r.status}: ${msg}.${hint}`)
    }
    return data
  }

  /* ---- metadata and values (cached) */
  private invalidate(): void { this.valuesCache.clear(); this.metaCache = null }

  private async meta(fresh = false): Promise<{ title: string; tabs: TabData[] }> {
    if (!fresh && this.metaCache && Date.now() - this.metaCache.at < CACHE_MS) return this.metaCache
    const d = await this.call('GET', '', { query: [['fields', 'properties.title,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))']] })
    const tabs: TabData[] = (d.sheets ?? []).map((s: Json) => ({
      sheetId: s.properties.sheetId ?? 0,
      title: String(s.properties.title),
      rowCount: s.properties.gridProperties?.rowCount ?? 1000,
      columnCount: s.properties.gridProperties?.columnCount ?? 26,
    }))
    this.metaCache = { at: Date.now(), title: String(d.properties?.title ?? ''), tabs }
    return this.metaCache
  }

  private async findTab(source: string, fresh = false): Promise<TabData> {
    const { tabs } = await this.meta(fresh)
    const t = tabs.find((x) => x.title === source) ?? tabs.find((x) => x.title.toLowerCase() === source.toLowerCase())
    if (!t) throw new Error(`The spreadsheet has no tab named "${source}".`)
    return t
  }

  private async load(source: string, fresh = false): Promise<Loaded> {
    const tab = await this.findTab(source, fresh)
    let entry = this.valuesCache.get(tab.title)
    if (fresh || !entry || Date.now() - entry.at >= CACHE_MS) {
      const d = await this.call('GET', `/values/${encodeURIComponent(quoteTab(tab.title))}`, {
        query: [['valueRenderOption', 'UNFORMATTED_VALUE'], ['dateTimeRenderOption', 'SERIAL_NUMBER']],
      })
      entry = { at: Date.now(), data: { values: (d.values ?? []) as Cell[][] } }
      this.valuesCache.set(tab.title, entry)
    }
    const all = entry.data.values
    const header = (all[0] ?? []).map((c) => (isBlank(c) ? '' : String(c).trim()))
    while (header.length && header[header.length - 1] === '') header.pop()
    const rows: Loaded['rows'] = []
    for (let i = 1; i < all.length; i++) {
      const cells = all[i] ?? []
      if (cells.some((c) => !isBlank(c))) rows.push({ rowNumber: i + 1, cells })
    }
    return { tab, header, rows }
  }

  /** column name -> header index for a TableDef (exact, case-insensitive, display name, sanitised header) */
  private columnIndex(header: string[], def: TableDef): Map<string, number> {
    const out = new Map<string, number>()
    for (const c of def.columns) {
      let i = header.findIndex((h) => h === c.name)
      if (i < 0) i = header.findIndex((h) => h.toLowerCase() === c.name.toLowerCase())
      if (i < 0) i = header.findIndex((h) => h !== '' && h === c.displayName)
      if (i < 0) i = header.findIndex((h, k) => h !== '' && sanitizeName(h, k) === c.name)
      if (i >= 0) out.set(c.name, i)
    }
    return out
  }

  private typedRow(cells: Cell[], def: TableDef, idx: Map<string, number>): RawRow {
    const row: RawRow = {}
    for (const c of def.columns) {
      const i = idx.get(c.name)
      row[c.name] = i === undefined ? null : fromCell(cells[i], c.type)
    }
    return row
  }

  private src(def: TableDef): string { return def.source || def.name }

  /* ---- Connector: discovery */
  async test() {
    let key: ServiceAccountKey
    try { key = this.getKey(); this.getSid() } catch (e) { return { ok: false as const, message: e instanceof Error ? e.message : 'Invalid configuration.' } }
    try {
      await this.getToken()
    } catch (e) {
      return { ok: false as const, message: e instanceof Error ? e.message : 'Could not sign in to Google.' }
    }
    try {
      const m = await this.meta(true)
      return { ok: true as const, message: `Connected to "${m.title}" (${m.tabs.length} tab${m.tabs.length === 1 ? '' : 's'}) as ${key.client_email}.` }
    } catch (e) {
      if (e instanceof SheetsError && (e.status === 403 || e.status === 404)) {
        return { ok: false as const, message: `Google denied access to the spreadsheet (HTTP ${e.status}). Share it with ${key.client_email} (Editor access), and make sure the Google Sheets API is enabled for the key's project.` }
      }
      return { ok: false as const, message: e instanceof Error ? e.message : 'Could not reach the spreadsheet.' }
    }
  }

  /** number-format types of the first data row, per tab title (best effort) */
  private async formats(titles: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>()
    if (!titles.length) return out
    try {
      const d = await this.call('GET', '', {
        query: [
          ['includeGridData', 'true'],
          ...titles.map((t): [string, string] => ['ranges', `${quoteTab(t)}!2:2`]),
          ['fields', 'sheets(properties(title),data(rowData(values(effectiveFormat(numberFormat(type))))))'],
        ],
      })
      for (const s of d.sheets ?? []) {
        const vals: Json[] = s.data?.[0]?.rowData?.[0]?.values ?? []
        out.set(String(s.properties?.title), vals.map((v) => String(v?.effectiveFormat?.numberFormat?.type ?? '')))
      }
    } catch { /* formats are an optimisation for date detection only */ }
    return out
  }

  private columnsOf(l: Loaded, fmts: string[] | undefined): SourceColumn[] {
    const used = new Set<string>()
    const cols: SourceColumn[] = []
    l.header.forEach((h, i) => {
      if (h === '') return
      let name = sanitizeName(h, i)
      let n = 2
      while (used.has(name)) name = `${sanitizeName(h, i)}_${n++}`
      used.add(name)
      const sample = l.rows.slice(0, INFER_ROWS).map((r) => r.cells[i])
      cols.push({ name, type: name === 'id' ? 'text' : inferType(sample, fmts?.[i]) })
    })
    return cols
  }

  async listSourceTables() {
    const { tabs } = await this.meta(true)
    const fmts = await this.formats(tabs.map((t) => t.title))
    const out: { source: string; columns: SourceColumn[]; rowCount?: number; hasId: boolean }[] = []
    for (const t of tabs) {
      const l = await this.load(t.title, true)
      const columns = this.columnsOf(l, fmts.get(t.title))
      out.push({ source: t.title, columns, rowCount: l.rows.length, hasId: columns.some((c) => c.name === 'id') })
    }
    return out
  }

  async describe(source: string): Promise<SourceColumn[]> {
    const l = await this.load(source)
    const fmts = await this.formats([l.tab.title])
    return this.columnsOf(l, fmts.get(l.tab.title))
  }

  /* ---- Connector: reads */
  async select(def: TableDef, q: Query) {
    const l = await this.load(this.src(def))
    const idx = this.columnIndex(l.header, def)
    const rows = l.rows.map((r) => this.typedRow(r.cells, def, idx))
    return applyQuery(rows, q)
  }

  /* ---- writes (serialised per spreadsheet; always against fresh values) */
  private write<T>(fn: () => Promise<T>): Promise<T> {
    return serialise(this.getSid(), async () => {
      try { return await fn() } finally { this.invalidate() }
    })
  }

  private async batchUpdate(requests: Json[]): Promise<Json> {
    return this.call('POST', ':batchUpdate', { body: { requests } })
  }

  private async ensureGridColumns(tab: TabData, needed: number): Promise<void> {
    if (needed > tab.columnCount) {
      await this.batchUpdate([{ appendDimension: { sheetId: tab.sheetId, dimension: 'COLUMNS', length: needed - tab.columnCount } }])
      tab.columnCount = needed
    }
  }

  private async putRange(range: string, values: (string | number | boolean)[][]): Promise<void> {
    await this.call('PUT', `/values/${encodeURIComponent(range)}`, { query: [['valueInputOption', 'RAW']], body: { range, majorDimension: 'ROWS', values } })
  }

  async createTable(def: TableDef): Promise<void> {
    const title = this.src(def)
    return this.write(async () => {
      const { tabs } = await this.meta(true)
      if (tabs.some((t) => t.title.toLowerCase() === title.toLowerCase())) throw new Error(`The spreadsheet already has a tab named "${title}".`)
      await this.batchUpdate([{ addSheet: { properties: { title, gridProperties: { rowCount: 1000, columnCount: Math.max(26, def.columns.length) } } } }])
      const names = def.columns.map((c) => c.name)
      await this.putRange(`${quoteTab(title)}!A1:${colLetter(Math.max(0, names.length - 1))}1`, [names])
    })
  }

  async addColumn(def: TableDef, col: ColumnDef): Promise<void> {
    return this.write(async () => {
      const l = await this.load(this.src(def), true)
      if (this.columnIndex(l.header, { ...def, columns: [col] }).has(col.name)) return
      const at = l.header.length
      await this.ensureGridColumns(l.tab, at + 1)
      await this.putRange(`${quoteTab(l.tab.title)}!${colLetter(at)}1`, [[col.name]])
    })
  }

  async alterColumn(def: TableDef, before: ColumnDef, after: ColumnDef): Promise<void> {
    // Cells hold plain values; the type lives in the TableDef. Only a rename touches the sheet.
    if (before.name === after.name) return
    return this.write(async () => {
      const l = await this.load(this.src(def), true)
      const i = this.columnIndex(l.header, { ...def, columns: [before] }).get(before.name)
      if (i === undefined) return
      await this.putRange(`${quoteTab(l.tab.title)}!${colLetter(i)}1`, [[after.name]])
    })
  }

  async dropColumn(def: TableDef, name: string): Promise<void> {
    return this.write(async () => {
      const l = await this.load(this.src(def), true)
      const probe: ColumnDef = def.columns.find((c) => c.name === name) ?? { name, displayName: name, type: 'text' }
      const i = this.columnIndex(l.header, { ...def, columns: [probe] }).get(name)
      if (i === undefined) return
      await this.batchUpdate([{ deleteDimension: { range: { sheetId: l.tab.sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 } } }])
    })
  }

  async dropTable(def: TableDef): Promise<void> {
    return this.write(async () => {
      const tab = await this.findTab(this.src(def), true)
      await this.batchUpdate([{ deleteSheet: { sheetId: tab.sheetId } }])
    })
  }

  async insert(def: TableDef, rows: RawRow[]): Promise<void> {
    if (!rows.length) return
    return this.write(async () => {
      const l = await this.load(this.src(def), true)
      if (!l.header.length) throw new Error(`Tab "${l.tab.title}" has no header row, so rows cannot be added.`)
      const idx = this.columnIndex(l.header, def)
      const types = new Map(def.columns.map((c) => [c.name, c.type]))
      const idCol = idx.get('id')
      const values = rows.map((r) => {
        const line: (string | number | boolean)[] = new Array(l.header.length).fill('')
        for (const [name, i] of idx) line[i] = toCellValue(r[name], types.get(name))
        if (idCol !== undefined && line[idCol] === '') line[idCol] = randomUUID()
        return line
      })
      await this.call('POST', `/values/${encodeURIComponent(`${quoteTab(l.tab.title)}!A1`)}:append`, {
        query: [['valueInputOption', 'RAW'], ['insertDataOption', 'INSERT_ROWS']],
        body: { majorDimension: 'ROWS', values },
      })
    })
  }

  private matchRows(l: Loaded, def: TableDef, idx: Map<string, number>, ids: string[], guard: Condition | undefined, firstOnly: boolean) {
    const idCol = idx.get('id')
    if (idCol === undefined) throw new Error(`Tab "${l.tab.title}" has no id column, so rows cannot be located. Add an id column to the tab (the link step offers to do this).`)
    const wanted = new Set(ids)
    const found = new Set<string>()
    const hits: { rowNumber: number; cells: Cell[]; typed: RawRow }[] = []
    for (const r of l.rows) {
      const id = r.cells[idCol]
      if (isBlank(id)) continue
      const key = String(id)
      if (!wanted.has(key) || (firstOnly && found.has(key))) continue
      const typed = this.typedRow(r.cells, def, idx)
      if (guard && !evaluateCondition(guard, typed)) continue
      found.add(key)
      hits.push({ ...r, typed })
    }
    return hits
  }

  async update(def: TableDef, id: string, changes: RawRow, guard?: Condition): Promise<number> {
    return this.write(async () => {
      const l = await this.load(this.src(def), true)
      const idx = this.columnIndex(l.header, def)
      const hit = this.matchRows(l, def, idx, [id], guard, true)[0]
      if (!hit) return 0
      const types = new Map(def.columns.map((c) => [c.name, c.type]))
      const data: { range: string; values: (string | number | boolean)[][] }[] = []
      for (const [name, value] of Object.entries(changes)) {
        const i = idx.get(name)
        if (i === undefined || name === 'id') continue
        data.push({ range: `${quoteTab(l.tab.title)}!${colLetter(i)}${hit.rowNumber}`, values: [[toCellValue(value, types.get(name))]] })
      }
      if (data.length) {
        await this.call('POST', '/values:batchUpdate', { body: { valueInputOption: 'RAW', data } })
      }
      return 1
    })
  }

  async delete(def: TableDef, ids: string[], guard?: Condition): Promise<number> {
    if (!ids.length) return 0
    return this.write(async () => {
      const l = await this.load(this.src(def), true)
      const idx = this.columnIndex(l.header, def)
      const hits = this.matchRows(l, def, idx, ids, guard, false).sort((a, b) => b.rowNumber - a.rowNumber)
      if (!hits.length) return 0
      await this.batchUpdate(hits.map((h) => ({
        deleteDimension: { range: { sheetId: l.tab.sheetId, dimension: 'ROWS', startIndex: h.rowNumber - 1, endIndex: h.rowNumber } },
      })))
      return hits.length
    })
  }

  async ensureIdColumn(source: string): Promise<{ added: boolean; filled: number }> {
    return this.write(async () => {
      const l = await this.load(source, true)
      if (!l.header.length) throw new Error(`Tab "${l.tab.title}" has no header row.`)
      let col = l.header.findIndex((h) => h.toLowerCase() === 'id')
      let added = false
      if (col < 0) {
        col = l.header.length
        await this.ensureGridColumns(l.tab, col + 1)
        await this.putRange(`${quoteTab(l.tab.title)}!${colLetter(col)}1`, [['id']])
        added = true
      }
      const missing = l.rows.filter((r) => isBlank(r.cells[col]))
      if (missing.length) {
        const last = l.rows[l.rows.length - 1].rowNumber
        const byRow = new Map(l.rows.map((r) => [r.rowNumber, r.cells[col]]))
        const fill = new Set(missing.map((r) => r.rowNumber))
        const column: (string | number | boolean)[][] = []
        for (let n = 2; n <= last; n++) {
          const cur = byRow.get(n)
          column.push([fill.has(n) ? randomUUID() : isBlank(cur) ? '' : (cur as string | number | boolean)])
        }
        const L = colLetter(col)
        await this.putRange(`${quoteTab(l.tab.title)}!${L}2:${L}${last}`, column)
      }
      return { added, filled: missing.length }
    })
  }

  async close(): Promise<void> {
    this.invalidate()
    this.token = null
  }
}

export const createGSheetsConnector: ConnectorFactory = (conn, env) => new GSheets(conn, env)

/** Helper for the link flow: works on any Connector, throws when it is not a Google Sheets connector. */
export function ensureIdColumn(connector: Connector, source: string): Promise<{ added: boolean; filled: number }> {
  const c = connector as Partial<GSheetsConnector>
  if (typeof c.ensureIdColumn !== 'function') throw new Error('ensureIdColumn is only available on Google Sheets connections.')
  return c.ensureIdColumn(source)
}
