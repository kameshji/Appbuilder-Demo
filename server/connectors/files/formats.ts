/** Parsing, analysis and serialisation of csv / xlsx / json files. */
import Papa from 'papaparse'
import ExcelJS from 'exceljs'
import { randomUUID } from 'node:crypto'
import type { ColumnType } from '../../../src/platform/contracts.ts'
import { HttpError } from '../../core/contracts.ts'
import {
  SYSTEM_BY_LOWER, SYSTEM_COLUMNS, UUID_RE, inferColumn, isBlank, toIdentifier, uniqueIdentifier,
} from './cells.ts'
import type { Cell, FileKind } from './cells.ts'
import { checkZip } from '../../core/zip-guard.ts'

export const MAX_BYTES = 50 * 1024 * 1024

export const invalid = (msg: string): HttpError => new HttpError(400, 'invalid', msg)

/** the in-memory model of one sheet */
export interface Sheet {
  name: string
  /** column order = header order */
  columns: string[]
  rows: Record<string, Cell>[]
  /** csv: physical file name inside the folder */
  csvFile?: string
}

export interface RawSheet { name: string; headers: string[]; rows: Cell[][] }

export interface ColInfo { index: number; name: string; displayName: string; type: ColumnType; system: boolean }
export interface AnalyzedSheet extends RawSheet { cols: ColInfo[] }

/* ------------------------------------------------------------------ kind / names */

export function kindOf(fileName: string): FileKind {
  const base = String(fileName).replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : ''
  if (ext === 'csv' || ext === 'xlsx' || ext === 'json') return ext
  if (ext === 'xlsm' || ext === 'xlsb') throw invalid('Macro-enabled or binary Excel files are not supported; save as .xlsx')
  throw invalid(`Unsupported file type ".${ext}": use .csv, .xlsx or .json`)
}

/** sheet name for csv/json: the base file name without extension (never used as a path) */
export function sheetNameFromFile(fileName: string): string {
  const base = (String(fileName).replace(/\\/g, '/').split('/').pop() ?? '').replace(/\.[^.]*$/, '')
  const s = base.replace(/[\u0000-\u001f/\\]/g, '_').trim().slice(0, 100)
  return s || 'Sheet1'
}

const BAD_XLSX_SHEET = /[\][:*?/\\]/
export function checkSheetName(name: string, kind: FileKind): void {
  if (!name || name.trim() !== name || name.length > (kind === 'xlsx' ? 31 : 100) || /[\u0000-\u001f]/.test(name) || name.includes('/') || name.includes('\\'))
    throw invalid(`Invalid sheet name "${name}"`)
  if (kind === 'xlsx' && BAD_XLSX_SHEET.test(name)) throw invalid(`Invalid sheet name "${name}"`)
}

/* ------------------------------------------------------------------ parse */

function xlCell(v: unknown): Cell {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  if (typeof v === 'string') return v === '' ? null : v
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (Array.isArray(o.richText)) return xlCell((o.richText as { text?: string }[]).map((r) => r.text ?? '').join(''))
    if ('formula' in o || 'sharedFormula' in o) return xlCell(o.result)
    if ('hyperlink' in o) return xlCell(o.text ?? o.hyperlink)
    if ('error' in o) return null
  }
  return null
}

export async function parseXlsx(bytes: Buffer): Promise<RawSheet[]> {
  if (bytes.includes('vbaProject.bin')) throw invalid('Macro-enabled workbooks are not supported')
  // a zip bomb would be unpacked in memory by ExcelJS: refuse it from its directory first
  checkZip(bytes, 'Not a readable .xlsx file')
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer)
  } catch (e) {
    throw invalid(`Not a readable .xlsx file: ${(e as Error).message}`)
  }
  const out: RawSheet[] = []
  for (const ws of wb.worksheets) {
    const head = ws.getRow(1)
    let last = 0
    for (let c = 1; c <= ws.columnCount; c++) if (!isBlank(xlCell(head.getCell(c).value))) last = c
    if (last === 0) continue
    const headers: string[] = []
    for (let c = 1; c <= last; c++) {
      const h = xlCell(head.getCell(c).value)
      headers.push(h === null ? '' : h instanceof Date ? h.toISOString() : String(h).trim())
    }
    const rows: Cell[][] = []
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r)
      const cells: Cell[] = []
      let any = false
      for (let c = 1; c <= last; c++) {
        const v = xlCell(row.getCell(c).value)
        if (!isBlank(v)) any = true
        cells.push(v)
      }
      if (any) rows.push(cells)
    }
    out.push({ name: ws.name, headers, rows })
  }
  if (out.length === 0) throw invalid('The workbook has no sheet with a header row')
  return out
}

export function parseCsv(bytes: Buffer, name: string): RawSheet[] {
  let text = bytes.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const res = Papa.parse<string[]>(text, { header: false, skipEmptyLines: 'greedy' })
  const grid = res.data
  if (grid.length === 0 || grid[0].every((h) => String(h ?? '').trim() === '')) throw invalid('The CSV file has no header row')
  const headers = grid[0].map((h) => String(h ?? '').trim())
  while (headers.length > 0 && headers[headers.length - 1] === '') headers.pop()
  const rows: Cell[][] = []
  for (let i = 1; i < grid.length; i++) rows.push(headers.map((_, j) => (grid[i][j] === undefined || grid[i][j] === '' ? null : String(grid[i][j]))))
  return [{ name, headers, rows }]
}

function jsonCell(v: unknown): Cell {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  return JSON.stringify(v)
}

function jsonSheet(name: string, arr: unknown[], allowEmpty = false): RawSheet {
  const headers: string[] = []
  const seen = new Set<string>()
  for (const o of arr) {
    if (o === null || typeof o !== 'object' || Array.isArray(o)) throw invalid('JSON must be an array of objects (or an object whose values are arrays of objects)')
    for (const k of Object.keys(o)) if (!seen.has(k)) { seen.add(k); headers.push(k) }
  }
  if (headers.length === 0 && !allowEmpty) throw invalid(`JSON sheet "${name}" has no object keys to use as columns`)
  const rows = arr.map((o) => headers.map((h) => jsonCell((o as Record<string, unknown>)[h])))
  return { name, headers, rows }
}

export function parseJson(bytes: Buffer, name: string, allowEmpty = false): { sheets: RawSheet[]; shape: 'array' | 'object' } {
  let data: unknown
  try {
    data = JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''))
  } catch (e) {
    throw invalid(`Not valid JSON: ${(e as Error).message}`)
  }
  if (Array.isArray(data)) return { sheets: [jsonSheet(name, data, allowEmpty)], shape: 'array' }
  if (data !== null && typeof data === 'object') {
    const sheets: RawSheet[] = []
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (!Array.isArray(v)) throw invalid('JSON must be an array of objects (or an object whose values are arrays of objects)')
      checkSheetName(k, 'json')
      sheets.push(jsonSheet(k, v, allowEmpty))
    }
    if (sheets.length === 0 && !allowEmpty) throw invalid('JSON object has no sheets')
    return { sheets, shape: 'object' }
  }
  throw invalid('JSON must be an array of objects (or an object whose values are arrays of objects)')
}

/* ------------------------------------------------------------------ analyze */

export interface Analyzed { kind: FileKind; shape: 'array' | 'object'; sheets: AnalyzedSheet[] }

export function analyzeSheet(raw: RawSheet): AnalyzedSheet {
  const taken = new Set<string>(SYSTEM_COLUMNS.map((c) => c.name.toLowerCase()))
  const cols: ColInfo[] = []
  const usedSystem = new Set<string>()
  raw.headers.forEach((h, index) => {
    const column = raw.rows.map((r) => r[index] ?? null)
    const base = toIdentifier(h) || `Column${index + 1}`
    const sys = SYSTEM_BY_LOWER.get(base.toLowerCase())
    if (sys && !usedSystem.has(sys.name)) {
      const idOk = sys.name !== 'id' || column.every((c) => isBlank(c) || (typeof c === 'string' && UUID_RE.test(c.trim())))
      if (idOk) {
        usedSystem.add(sys.name)
        cols.push({ index, name: sys.name, displayName: sys.displayName, type: sys.type, system: true })
        return
      }
    }
    const name = uniqueIdentifier(base, taken)
    taken.add(name.toLowerCase())
    cols.push({ index, name, displayName: h || name, type: inferColumn(column), system: false })
  })
  return { ...raw, cols }
}

export async function analyze(bytes: Buffer, fileName: string): Promise<Analyzed> {
  if (!Buffer.isBuffer(bytes)) throw invalid('File content must be a Buffer')
  if (bytes.length > MAX_BYTES) throw invalid('File is larger than 50 MB')
  if (bytes.length === 0) throw invalid('File is empty')
  const kind = kindOf(fileName)
  const sheetName = sheetNameFromFile(fileName)
  let shape: 'array' | 'object' = 'array'
  let raws: RawSheet[]
  if (kind === 'xlsx') raws = await parseXlsx(bytes)
  else if (kind === 'csv') raws = parseCsv(bytes, sheetName)
  else {
    const j = parseJson(bytes, sheetName)
    raws = j.sheets
    shape = j.shape
  }
  return { kind, shape, sheets: raws.map(analyzeSheet) }
}

/* ------------------------------------------------------------------ copy model */

/**
 * Build the model of the stored copy for one analysed sheet: id + user columns + createdOn, modifiedOn,
 * createdBy, owner. `old` (replace): rows are matched by id; system values of matched rows are kept.
 */
export function buildSheet(a: AnalyzedSheet, kind: FileKind, now: Date, name: string, old?: Sheet): Sheet {
  const user = a.cols.filter((c) => !c.system)
  const sys = new Map(a.cols.filter((c) => c.system).map((c) => [c.name, c]))
  const columns = ['id', ...user.map((c) => c.name), 'createdOn', 'modifiedOn', 'createdBy', 'owner']
  const nowCell: Cell = kind === 'xlsx' ? now : now.toISOString()
  const oldById = new Map<string, Record<string, Cell>>()
  if (old) for (const r of old.rows) if (typeof r.id === 'string') oldById.set(r.id, r)
  const seen = new Set<string>()
  const rows = a.rows.map((cells) => {
    const rec: Record<string, Cell> = {}
    for (const c of user) rec[c.name] = cells[c.index] ?? null
    const idCell = sys.has('id') ? cells[sys.get('id')!.index] : null
    let id = typeof idCell === 'string' ? idCell.trim() : ''
    if (!id || seen.has(id)) id = randomUUID()
    seen.add(id)
    rec.id = id
    for (const s of ['createdOn', 'modifiedOn', 'createdBy', 'owner']) {
      const ci = sys.get(s)
      rec[s] = ci ? (cells[ci.index] ?? null) : null
    }
    const prev = oldById.get(id)
    if (prev) {
      for (const s of ['createdOn', 'createdBy', 'owner']) if (isBlank(rec[s])) rec[s] = prev[s] ?? null
      const same = user.every((c) => cellKey(rec[c.name]) === cellKey(prev[c.name]))
      if (isBlank(rec.createdOn)) rec.createdOn = nowCell
      rec.modifiedOn = same && !isBlank(prev.modifiedOn) ? prev.modifiedOn : nowCell
    } else {
      if (isBlank(rec.createdOn)) rec.createdOn = nowCell
      if (isBlank(rec.modifiedOn)) rec.modifiedOn = rec.createdOn
    }
    return rec
  })
  return { name, columns, rows }
}

export function cellKey(v: Cell | undefined): string {
  if (v === null || v === undefined || v === '') return ''
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

/* ------------------------------------------------------------------ load stored copies */

export function sheetFromGrid(name: string, headers: string[], grid: Cell[][]): Sheet {
  const columns = headers.slice()
  const rows = grid.map((cells) => {
    const rec: Record<string, Cell> = {}
    columns.forEach((h, i) => { rec[h] = cells[i] ?? null })
    return rec
  })
  return { name, columns, rows }
}

/** make sure `id` exists and every row has one; returns true when something changed */
export function ensureIds(s: Sheet): boolean {
  let changed = false
  if (!s.columns.includes('id')) { s.columns.unshift('id'); changed = true }
  const seen = new Set<string>()
  for (const r of s.rows) {
    let id = typeof r.id === 'string' ? r.id.trim() : r.id === null || r.id === undefined ? '' : String(r.id)
    if (!id || seen.has(id)) { id = randomUUID(); changed = true }
    if (r.id !== id) { r.id = id; changed = true }
    seen.add(id)
  }
  return changed
}

/* ------------------------------------------------------------------ serialise */

export function csvText(s: Sheet): string {
  const data = s.rows.map((r) => s.columns.map((c) => {
    const v = r[c]
    if (v === null || v === undefined) return ''
    if (v instanceof Date) return v.toISOString()
    return String(v)
  }))
  return Papa.unparse({ fields: s.columns, data }, { newline: '\r\n', quotes: false, skipEmptyLines: false })
}

function jsonRows(s: Sheet): Record<string, unknown>[] {
  return s.rows.map((r) => Object.fromEntries(s.columns.map((c) => {
    const v = r[c]
    return [c, v === undefined ? null : v instanceof Date ? v.toISOString() : v]
  })))
}

export function jsonText(sheets: Sheet[], shape: 'array' | 'object'): string {
  if (shape === 'array' && sheets.length === 1) return JSON.stringify(jsonRows(sheets[0]), null, 2) + '\n'
  return JSON.stringify(Object.fromEntries(sheets.map((s) => [s.name, jsonRows(s)])), null, 2) + '\n'
}

/** overwrite a worksheet's used range with the sheet model (row 1 = header) */
export function writeXlsxSheet(ws: ExcelJS.Worksheet, s: Sheet): void {
  const oldRows = ws.rowCount
  const oldCols = ws.columnCount
  const cols = s.columns
  const hr = ws.getRow(1)
  cols.forEach((c, i) => { hr.getCell(i + 1).value = c })
  for (let c = cols.length + 1; c <= oldCols; c++) hr.getCell(c).value = null
  s.rows.forEach((rec, ri) => {
    const row = ws.getRow(ri + 2)
    cols.forEach((c, i) => {
      const v = rec[c] ?? null
      const cell = row.getCell(i + 1)
      cell.value = v
      const fmt = cell.style?.numFmt
      if (v instanceof Date) cell.style = { ...cell.style, numFmt: v.getTime() % 86400000 === 0 ? 'yyyy-mm-dd' : 'yyyy-mm-dd hh:mm:ss' }
      else if (fmt && fmt !== 'General' && /[ymdhs]/i.test(fmt.replace(/\[[^\]]*\]|"[^"]*"/g, ''))) cell.style = { ...cell.style, numFmt: 'General' }
    })
    for (let c = cols.length + 1; c <= oldCols; c++) row.getCell(c).value = null
  })
  const used = s.rows.length + 1
  if (oldRows > used) ws.spliceRows(used + 1, oldRows - used)
}
