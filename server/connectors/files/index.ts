/**
 * Files connector (SPEC3 7.2): csv / xlsx / json data files copied into workspace/files/<fileId>/data.<ext>.
 * One connector instance serves one 'files' connection; table source = "<fileId>/<sheet>".
 * Sheets are held in memory (re-read when the file's mtime/size changes) and persisted debounced (300 ms),
 * serialised per file, with an atomic tmp+rename replace.
 */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import ExcelJS from 'exceljs'
import type { ColumnDef, ColumnType, TableDef } from '../../../src/platform/contracts.ts'
import type { Condition, Query } from '../../../src/platform/http.ts'
import { HttpError } from '../../core/contracts.ts'
import type { Connector, ConnectorEnv, ConnectorFactory, RawRow, SourceColumn } from '../../core/contracts.ts'
import { applyQuery, evaluateCondition } from '../../core/condition.ts'
import { SYSTEM_COLUMNS, inferColumn, toStored, toTyped } from './cells.ts'
import type { Cell, FileKind } from './cells.ts'
import {
  analyze, buildSheet, checkSheetName, csvText, ensureIds, invalid, jsonText, parseCsv, parseJson, parseXlsx,
  sheetFromGrid, writeXlsxSheet,
} from './formats.ts'
import type { RawSheet, Sheet } from './formats.ts'

export const FILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const DEBOUNCE_MS = 300

export interface InspectedSheet { sheet: string; columns: { name: string; displayName: string; type: ColumnType }[]; rowCount: number }
export interface InspectResult { kind: FileKind; sheets: InspectedSheet[] }
export interface StoredFile { storageKey: string; checksum: string; sizeBytes: number; kind: FileKind; sheets: InspectedSheet[] }
export interface FilesConnector extends Connector { flush(): Promise<void> }

const notFound = (msg: string): HttpError => new HttpError(404, 'not-found', msg)

/* ------------------------------------------------------------------ in-memory file model */

interface Stamp { mtimeMs: number; size: number }
interface Loaded {
  id: string
  kind: FileKind
  dir: string
  shape: 'array' | 'object'
  sheets: Map<string, Sheet>
  stamps: Map<string, Stamp>
  dirty: boolean
  dirtySheets: Set<string>
  /** removed sheet name -> its csv file (if any) */
  removed: Map<string, string | undefined>
  timer?: ReturnType<typeof setTimeout>
  chain: Promise<void>
}

interface Meta { kind?: string; shape?: string; sheets?: Record<string, { file?: string; columns?: string[] }> }

const CSV_NAME_RE = /^[A-Za-z0-9_-]{1,80}\.csv$/

async function statOf(p: string): Promise<Stamp | null> {
  try {
    const s = await fs.stat(p)
    return { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return null
  }
}

async function atomicWrite(file: string, data: Buffer | string): Promise<void> {
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await fs.writeFile(tmp, data)
    await fs.rename(tmp, file)
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

function parseSource(source: string): { fileId: string; sheet: string } {
  const i = typeof source === 'string' ? source.indexOf('/') : -1
  if (i < 1) throw invalid(`Invalid file source "${String(source)}" (expected "<fileId>/<sheet>")`)
  const fileId = source.slice(0, i)
  const sheet = source.slice(i + 1)
  if (!FILE_ID_RE.test(fileId)) throw invalid('Invalid file id')
  if (!sheet) throw invalid('Missing sheet name in file source')
  return { fileId, sheet }
}

function checkId(fileId: string): string {
  if (typeof fileId !== 'string' || !FILE_ID_RE.test(fileId)) throw invalid('Invalid file id')
  return fileId
}

class FileStore {
  root: string
  log: ConnectorEnv['log']
  files = new Map<string, Loaded>()
  loading = new Map<string, Promise<Loaded>>()

  constructor(env: ConnectorEnv) {
    this.root = path.resolve(env.filesDir)
    this.log = env.log
  }

  dirOf(fileId: string): string {
    const dir = path.join(this.root, checkId(fileId))
    if (path.dirname(dir) !== this.root) throw invalid('Invalid file id')
    return dir
  }

  async readMeta(dir: string): Promise<Meta> {
    try {
      return JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8')) as Meta
    } catch {
      return {}
    }
  }

  async detectKind(dir: string): Promise<FileKind | null> {
    for (const k of ['xlsx', 'json', 'csv'] as const) if (await statOf(path.join(dir, `data.${k}`))) return k
    return null
  }

  async get(fileId: string): Promise<Loaded> {
    checkId(fileId)
    const cur = this.files.get(fileId)
    if (cur) {
      if (cur.dirty || !(await this.stale(cur))) return cur
      this.files.delete(fileId)
    }
    let p = this.loading.get(fileId)
    if (!p) {
      p = this.load(fileId).finally(() => this.loading.delete(fileId))
      this.loading.set(fileId, p)
    }
    const f = await p
    this.files.set(fileId, f)
    return f
  }

  async stale(f: Loaded): Promise<boolean> {
    for (const [name, st] of f.stamps) {
      const now = await statOf(path.join(f.dir, name))
      if (!now || now.mtimeMs !== st.mtimeMs || now.size !== st.size) return true
    }
    return false
  }

  async load(fileId: string): Promise<Loaded> {
    const dir = this.dirOf(fileId)
    const kind = await this.detectKind(dir)
    if (!kind) throw notFound(`Data file "${fileId}" not found`)
    const meta = await this.readMeta(dir)
    const f: Loaded = {
      id: fileId, kind, dir, shape: 'array', sheets: new Map(), stamps: new Map(), dirty: false,
      dirtySheets: new Set(), removed: new Map(), chain: Promise.resolve(),
    }
    const stampOf = async (name: string) => { const s = await statOf(path.join(dir, name)); if (s) f.stamps.set(name, s) }
    const fix = (r: RawSheet): Sheet => sheetFromGrid(r.name, r.headers.map((h, i) => h || `Column${i + 1}`), r.rows)
    if (kind === 'xlsx') {
      const bytes = await fs.readFile(path.join(dir, 'data.xlsx'))
      await stampOf('data.xlsx')
      for (const r of await parseXlsx(bytes)) f.sheets.set(r.name, fix(r))
    } else if (kind === 'json') {
      const bytes = await fs.readFile(path.join(dir, 'data.json'))
      await stampOf('data.json')
      const j = parseJson(bytes, 'data', true)
      f.shape = j.shape
      const names = Object.keys(meta.sheets ?? {})
      j.sheets.forEach((r, i) => {
        const name = j.shape === 'array' ? (names[0] ?? 'data') : r.name
        if (r.headers.length === 0) r.headers = meta.sheets?.[name]?.columns?.slice() ?? ['id']
        f.sheets.set(name, fix({ ...r, name }))
      })
    } else {
      const entries = Object.entries(meta.sheets ?? {}).filter(([, v]) => v.file && CSV_NAME_RE.test(v.file))
      if (entries.length === 0) entries.push(['data', { file: 'data.csv' }])
      for (const [name, v] of entries) {
        const file = v.file as string
        let bytes: Buffer
        try {
          bytes = await fs.readFile(path.join(dir, file))
        } catch {
          continue
        }
        await stampOf(file)
        const s = bytes.toString('utf8').trim() === ''
          ? { name, columns: ['id'], rows: [] as Record<string, Cell>[] }
          : fix(parseCsv(bytes, name)[0])
        s.csvFile = file
        f.sheets.set(name, s)
      }
    }
    for (const s of f.sheets.values()) if (ensureIds(s)) this.markDirty(f, s.name)
    return f
  }

  sheetOf(f: Loaded, name: string): Sheet {
    const s = f.sheets.get(name)
    if (!s) throw notFound(`Sheet "${name}" not found in data file "${f.id}"`)
    return s
  }

  markDirty(f: Loaded, sheet: string): void {
    f.dirty = true
    f.dirtySheets.add(sheet)
    if (f.timer) clearTimeout(f.timer)
    f.timer = setTimeout(() => {
      f.timer = undefined
      this.persistQueued(f).catch((e) => this.log('error', `files: could not save ${f.id}: ${(e as Error).message}`))
    }, DEBOUNCE_MS)
    f.timer.unref?.()
  }

  persistQueued(f: Loaded): Promise<void> {
    const p = f.chain.then(() => this.persist(f))
    f.chain = p.catch(() => {})
    return p
  }

  async persist(f: Loaded): Promise<void> {
    if (!f.dirty) return
    const dirty = new Set(f.dirtySheets)
    const removed = new Map(f.removed)
    f.dirty = false
    f.dirtySheets.clear()
    f.removed.clear()
    try {
      await fs.mkdir(f.dir, { recursive: true })
      const snap = (s: Sheet): Sheet => ({ ...s, columns: s.columns.slice(), rows: s.rows.slice() })
      const written: string[] = []
      if (f.kind === 'csv') {
        for (const name of dirty) {
          const s = f.sheets.get(name)
          if (!s?.csvFile) continue
          await atomicWrite(path.join(f.dir, s.csvFile), csvText(snap(s)))
          written.push(s.csvFile)
        }
        for (const file of removed.values()) if (file) await fs.rm(path.join(f.dir, file), { force: true })
      } else if (f.kind === 'json') {
        await atomicWrite(path.join(f.dir, 'data.json'), jsonText([...f.sheets.values()].map(snap), f.shape))
        written.push('data.json')
      } else {
        const file = path.join(f.dir, 'data.xlsx')
        const wb = new ExcelJS.Workbook()
        await wb.xlsx.load(await fs.readFile(file) as unknown as ArrayBuffer)
        for (const name of removed.keys()) {
          const ws = wb.getWorksheet(name)
          if (ws) wb.removeWorksheet(ws.id)
        }
        for (const name of dirty) {
          const s = f.sheets.get(name)
          if (!s) continue
          writeXlsxSheet(wb.getWorksheet(name) ?? wb.addWorksheet(name), snap(s))
        }
        await atomicWrite(file, Buffer.from(await wb.xlsx.writeBuffer()))
        written.push('data.xlsx')
      }
      if (f.kind !== 'xlsx') await this.writeMeta(f)
      for (const name of written) { const s = await statOf(path.join(f.dir, name)); if (s) f.stamps.set(name, s) }
      for (const [, file] of removed) if (file) f.stamps.delete(file)
    } catch (e) {
      f.dirty = true
      for (const n of dirty) f.dirtySheets.add(n)
      for (const [k, v] of removed) f.removed.set(k, v)
      throw e
    }
  }

  async writeMeta(f: Loaded): Promise<void> {
    const sheets: NonNullable<Meta['sheets']> = {}
    for (const s of f.sheets.values()) sheets[s.name] = f.kind === 'csv' ? { file: s.csvFile } : { columns: s.columns.slice() }
    await atomicWrite(path.join(f.dir, 'meta.json'), JSON.stringify({ kind: f.kind, shape: f.shape, sheets }, null, 2))
  }

  /** persist everything pending now; rejects with the first save error */
  async flush(fileId?: string): Promise<void> {
    const targets = fileId ? [this.files.get(fileId)].filter((x): x is Loaded => !!x) : [...this.files.values()]
    let err: unknown
    for (const f of targets) {
      if (f.timer) { clearTimeout(f.timer); f.timer = undefined }
      try {
        await this.persistQueued(f)
      } catch (e) {
        err ??= e
      }
    }
    if (err) throw err
  }

  async evict(fileId: string): Promise<void> {
    const f = this.files.get(fileId)
    if (!f) return
    if (f.timer) clearTimeout(f.timer)
    await f.chain
    f.dirty = false
    this.files.delete(fileId)
  }
}

const stores = new Map<string, FileStore>()
function storeFor(env: ConnectorEnv): FileStore {
  const key = path.resolve(env.filesDir)
  let s = stores.get(key)
  if (!s) { s = new FileStore(env); stores.set(key, s) }
  return s
}

/** persist every pending write of the files folder of `env` (for the core on shutdown) */
export async function flushFiles(env: ConnectorEnv): Promise<void> {
  await storeFor(env).flush()
}

/** persist pending writes of every files folder in use (one per environment), on shutdown */
export async function flushAllFiles(): Promise<void> {
  let err: unknown = null
  for (const s of stores.values()) {
    try {
      await s.flush()
    } catch (e) {
      err ??= e
    }
  }
  if (err) throw err
}

/**
 * forget the files folder (an environment was deleted): pending writes are dropped and loaded files evicted, so
 * nothing is written back into the removed folder
 */
export async function forgetFilesFolder(dir: string): Promise<void> {
  const key = path.resolve(dir)
  const s = stores.get(key)
  if (!s) return
  stores.delete(key)
  for (const id of [...s.files.keys()]) await s.evict(id).catch(() => {})
}

/* ------------------------------------------------------------------ module API (metadata routes) */

function summarise(a: Awaited<ReturnType<typeof analyze>>): InspectedSheet[] {
  return a.sheets.map((s) => ({
    sheet: s.name,
    columns: s.cols.filter((c) => !c.system).map((c) => ({ name: c.name, displayName: c.displayName, type: c.type })),
    rowCount: s.rows.length,
  }))
}

export async function inspectDataFile(bytes: Buffer, fileName: string): Promise<InspectResult> {
  const a = await analyze(bytes, fileName)
  return { kind: a.kind, sheets: summarise(a) }
}

/** write a complete copy (all sheets) into dir as data.<ext> (+ meta.json for csv/json) */
async function writeCopy(dir: string, kind: FileKind, shape: 'array' | 'object', sheets: Sheet[], original: Buffer, keep?: Sheet[]): Promise<Buffer> {
  await fs.mkdir(dir, { recursive: true })
  if (kind === 'xlsx') {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(original as unknown as ArrayBuffer)
    const names = new Set(sheets.map((s) => s.name))
    for (const ws of [...wb.worksheets]) if (names.has(ws.name) === false && ws.rowCount > 0 && ws.getRow(1).actualCellCount > 0) wb.removeWorksheet(ws.id)
    for (const s of sheets) writeXlsxSheet(wb.getWorksheet(s.name) ?? wb.addWorksheet(s.name), s)
    const out = Buffer.from(await wb.xlsx.writeBuffer())
    await atomicWrite(path.join(dir, 'data.xlsx'), out)
    return out
  }
  if (kind === 'json') {
    const out = Buffer.from(jsonText(sheets, shape))
    await atomicWrite(path.join(dir, 'data.json'), out)
    const meta: NonNullable<Meta['sheets']> = {}
    for (const s of sheets) meta[s.name] = { columns: s.columns }
    await atomicWrite(path.join(dir, 'meta.json'), JSON.stringify({ kind, shape, sheets: meta }, null, 2))
    return out
  }
  const main = sheets[0]
  main.csvFile = 'data.csv'
  const out = Buffer.from(csvText(main))
  await atomicWrite(path.join(dir, 'data.csv'), out)
  const meta: NonNullable<Meta['sheets']> = {}
  for (const s of [main, ...(keep ?? [])]) meta[s.name] = { file: s.csvFile }
  await atomicWrite(path.join(dir, 'meta.json'), JSON.stringify({ kind, shape, sheets: meta }, null, 2))
  return out
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

export async function storeDataFile(env: ConnectorEnv, fileId: string, bytes: Buffer, fileName: string): Promise<StoredFile> {
  const store = storeFor(env)
  const dir = store.dirOf(fileId)
  const a = await analyze(bytes, fileName)
  if (await store.detectKind(dir)) throw new HttpError(409, 'conflict', `Data file "${fileId}" already exists`)
  const now = new Date()
  const sheets = a.sheets.map((s) => buildSheet(s, a.kind, now, s.name))
  const out = await writeCopy(dir, a.kind, a.shape, sheets, bytes)
  return { storageKey: `files/${fileId}/data.${a.kind}`, checksum: sha256(out), sizeBytes: out.length, kind: a.kind, sheets: summarise(a) }
}

/**
 * Replace the copy with a newer version of the file. Same kind required. Rows are matched by id when the new
 * file has an id column (system values of matched rows are kept, modifiedOn changes only when values changed);
 * otherwise rows are simply replaced. csv/json: the new sheet takes the place of the existing main sheet and keeps its name.
 */
export async function replaceDataFile(env: ConnectorEnv, fileId: string, bytes: Buffer, fileName: string): Promise<StoredFile> {
  const store = storeFor(env)
  const dir = store.dirOf(fileId)
  const a = await analyze(bytes, fileName)
  await store.flush(fileId).catch(() => {})
  const cur = await store.get(fileId)
  if (cur.kind !== a.kind) throw invalid(`The replacement must be a .${cur.kind} file`)
  const now = new Date()
  let sheets: Sheet[]
  let keep: Sheet[] | undefined
  let summaryNames: string[] | undefined
  if (a.kind === 'xlsx') {
    sheets = a.sheets.map((s) => buildSheet(s, a.kind, now, s.name, cur.sheets.get(s.name)))
  } else {
    const main = [...cur.sheets.values()].find((s) => s.csvFile === 'data.csv') ?? [...cur.sheets.values()][0]
    if (a.kind === 'csv') {
      sheets = [buildSheet(a.sheets[0], a.kind, now, main.name, main)]
      keep = [...cur.sheets.values()].filter((s) => s !== main)
    } else if (a.shape === 'array' && cur.shape === 'array') {
      sheets = [buildSheet(a.sheets[0], a.kind, now, main.name, main)]
    } else {
      sheets = a.sheets.map((s) => buildSheet(s, a.kind, now, s.name, cur.sheets.get(s.name)))
    }
    summaryNames = sheets.map((s) => s.name)
  }
  const shape = a.kind === 'json' ? (a.shape === 'array' && cur.shape === 'array' ? 'array' : a.shape) : 'array'
  await store.evict(fileId)
  const out = await writeCopy(dir, a.kind, shape, sheets, bytes, keep)
  const summary = summarise(a)
  if (summaryNames) summary.forEach((s, i) => { s.sheet = summaryNames![i] ?? s.sheet })
  return { storageKey: `files/${fileId}/data.${a.kind}`, checksum: sha256(out), sizeBytes: out.length, kind: a.kind, sheets: summary }
}

/** the current copy (including pending edits) for download */
export async function readDataFile(env: ConnectorEnv, fileId: string): Promise<Buffer> {
  const store = storeFor(env)
  const dir = store.dirOf(fileId)
  await store.flush(fileId)
  const kind = await store.detectKind(dir)
  if (!kind) throw notFound(`Data file "${fileId}" not found`)
  return fs.readFile(path.join(dir, `data.${kind}`))
}

export async function removeDataFile(env: ConnectorEnv, fileId: string): Promise<void> {
  const store = storeFor(env)
  const dir = store.dirOf(fileId)
  await store.evict(fileId)
  await fs.rm(dir, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ the connector */

function typedRow(def: TableDef, rec: Record<string, Cell>): RawRow {
  const out: RawRow = {}
  for (const c of def.columns) out[c.name] = toTyped(rec[c.name], c.type)
  return out
}

function sysType(name: string): ColumnType | undefined {
  return SYSTEM_COLUMNS.find((c) => c.name === name)?.type
}

export const createFilesConnector: ConnectorFactory = (_conn, env): FilesConnector => {
  const store = storeFor(env)

  async function resolve(def: TableDef): Promise<{ f: Loaded; s: Sheet }> {
    if (!def.source) throw invalid(`Table "${def.name}" has no file source`)
    const { fileId, sheet } = parseSource(def.source)
    const f = await store.get(fileId)
    return { f, s: store.sheetOf(f, sheet) }
  }

  const colOf = (def: TableDef, name: string): ColumnDef => {
    const c = def.columns.find((x) => x.name === name)
    if (!c) throw invalid(`Unknown column "${name}" in table "${def.name}"`)
    return c
  }

  function ensureColumn(s: Sheet, name: string): void {
    if (!s.columns.includes(name)) s.columns.push(name)
  }

  function describeSheet(s: Sheet): SourceColumn[] {
    return s.columns.map((name) => ({ name, type: sysType(name) ?? inferColumn(s.rows.map((r) => r[name] ?? null)) }))
  }

  const connector: FilesConnector = {
    kind: 'files',
    capabilities: { ddl: true, write: true, pushdown: false, transactions: false },

    async test() {
      try {
        await fs.mkdir(store.root, { recursive: true })
        const probe = path.join(store.root, `.probe-${randomUUID().slice(0, 8)}`)
        await fs.writeFile(probe, 'ok')
        await fs.rm(probe, { force: true })
        return { ok: true as const, message: 'Data files folder is writable' }
      } catch (e) {
        return { ok: false as const, message: `Data files folder is not writable: ${(e as Error).message}` }
      }
    },

    async listSourceTables() {
      let names: string[] = []
      try {
        const ents = await fs.readdir(store.root, { withFileTypes: true })
        names = ents.filter((e) => e.isDirectory() && FILE_ID_RE.test(e.name)).map((e) => e.name).sort()
      } catch {
        return []
      }
      const out: { source: string; columns: SourceColumn[]; rowCount?: number }[] = []
      for (const id of names) {
        try {
          const f = await store.get(id)
          for (const s of f.sheets.values()) out.push({ source: `${id}/${s.name}`, columns: describeSheet(s), rowCount: s.rows.length })
        } catch (e) {
          if (!(e instanceof HttpError && e.status === 404)) env.log('warn', `files: skipping ${id}: ${(e as Error).message}`)
        }
      }
      return out
    },

    async describe(source) {
      const { fileId, sheet } = parseSource(source)
      const f = await store.get(fileId)
      return describeSheet(store.sheetOf(f, sheet))
    },

    async createTable(def) {
      if (!def.source) throw invalid('A files table needs a source "<fileId>/<sheet>"')
      const { fileId, sheet } = parseSource(def.source)
      const f = await store.get(fileId)
      checkSheetName(sheet, f.kind)
      if (f.sheets.has(sheet) || [...f.sheets.keys()].some((k) => k.toLowerCase() === sheet.toLowerCase())) throw new HttpError(409, 'conflict', `Sheet "${sheet}" already exists`)
      const columns = def.columns.map((c) => c.name)
      if (!columns.includes('id')) columns.unshift('id')
      const s: Sheet = { name: sheet, columns, rows: [] }
      if (f.kind === 'csv') {
        const used = new Set([...f.sheets.values()].map((x) => (x.csvFile ?? '').toLowerCase()))
        const base = sheet.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'sheet'
        let file = `${base}.csv`
        for (let i = 2; used.has(file.toLowerCase()) || file === 'data.csv'; i++) file = `${base}_${i}.csv`
        s.csvFile = file
      }
      f.sheets.set(sheet, s)
      if (f.kind === 'json') f.shape = 'object'
      store.markDirty(f, sheet)
    },

    async addColumn(def, col) {
      const { s, f } = await resolve(def)
      if (s.columns.includes(col.name)) return
      s.columns.push(col.name)
      for (const r of s.rows) r[col.name] = null
      store.markDirty(f, s.name)
    },

    async alterColumn(def, before, after) {
      const { s, f } = await resolve(def)
      if (!s.columns.includes(before.name)) throw invalid(`Unknown column "${before.name}"`)
      if (before.name !== after.name) {
        if (s.columns.includes(after.name)) throw invalid(`Column "${after.name}" already exists`)
        s.columns = s.columns.map((c) => (c === before.name ? after.name : c))
        for (const r of s.rows) { r[after.name] = r[before.name] ?? null; delete r[before.name] }
      }
      if (before.type !== after.type) {
        for (const r of s.rows) r[after.name] = toStored(f.kind, after.type, toTyped(r[after.name], before.type))
      }
      store.markDirty(f, s.name)
    },

    async dropColumn(def, name) {
      const { s, f } = await resolve(def)
      if (SYSTEM_COLUMNS.some((c) => c.name === name)) throw invalid(`System column "${name}" cannot be removed`)
      if (!s.columns.includes(name)) return
      s.columns = s.columns.filter((c) => c !== name)
      for (const r of s.rows) delete r[name]
      store.markDirty(f, s.name)
    },

    async dropTable(def) {
      const { s, f } = await resolve(def)
      if (f.sheets.size <= 1) throw invalid('A data file must keep at least one sheet; remove the file instead')
      f.sheets.delete(s.name)
      f.removed.set(s.name, s.csvFile)
      f.dirtySheets.delete(s.name)
      store.markDirty(f, s.name)
    },

    async select(def, q: Query) {
      const { s } = await resolve(def)
      const rows = s.rows.map((r) => typedRow(def, r))
      return applyQuery(rows, q)
    },

    async insert(def, rows) {
      const { s, f } = await resolve(def)
      const ids = new Set(s.rows.map((r) => r.id as string))
      const built: Record<string, Cell>[] = []
      for (const row of rows) {
        const rec: Record<string, Cell> = {}
        for (const [k, v] of Object.entries(row)) rec[k] = toStored(f.kind, colOf(def, k).type, v)
        const id = typeof rec.id === 'string' && rec.id ? rec.id : randomUUID()
        if (ids.has(id)) throw new HttpError(409, 'conflict', `A row with id "${id}" already exists`)
        ids.add(id)
        rec.id = id
        built.push(rec)
      }
      for (const rec of built) {
        for (const k of Object.keys(rec)) ensureColumn(s, k)
        for (const c of s.columns) if (!(c in rec)) rec[c] = null
        s.rows.push(rec)
      }
      if (built.length) store.markDirty(f, s.name)
    },

    async update(def, id, changes: RawRow, guard?: Condition) {
      const { s, f } = await resolve(def)
      const rec = s.rows.find((r) => r.id === id)
      if (!rec) return 0
      if (guard && !evaluateCondition(guard, typedRow(def, rec))) return 0
      const next: Record<string, Cell> = {}
      for (const [k, v] of Object.entries(changes)) {
        if (k === 'id') continue
        next[k] = toStored(f.kind, colOf(def, k).type, v)
      }
      for (const [k, v] of Object.entries(next)) { ensureColumn(s, k); rec[k] = v }
      store.markDirty(f, s.name)
      return 1
    },

    async delete(def, ids, guard?: Condition) {
      const { s, f } = await resolve(def)
      const want = new Set(ids)
      let n = 0
      s.rows = s.rows.filter((r) => {
        if (!want.has(r.id as string)) return true
        if (guard && !evaluateCondition(guard, typedRow(def, r))) return true
        n++
        return false
      })
      if (n) store.markDirty(f, s.name)
      return n
    },

    async close() {
      await store.flush()
    },

    async flush() {
      await store.flush()
    },
  }
  return connector
}
