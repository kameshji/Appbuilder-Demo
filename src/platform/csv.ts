/**
 * Typed CSV round trip (RFC 4180 via papaparse).
 * Header row = column names; dates ISO-8601 (date: YYYY-MM-DD, datetime: UTC ISO); booleans true/false;
 * blank cell = null.
 */
import Papa from 'papaparse'
import type { FxRecord } from '@/contracts'
import type { ColumnDef, Row } from './contracts'
import { coerceLoose, serializeValue } from './values'

/** Rows -> CSV text (CRLF line endings by default, quoted where needed). */
export function rowsToCsv(columns: ColumnDef[], rows: Row[], newline: '\r\n' | '\n' = '\r\n'): string {
  const fields = columns.map((c) => c.name)
  const data = rows.map((r) => columns.map((c) => serializeValue(c, r[c.name])))
  return Papa.unparse({ fields, data }, { newline, quotes: false, skipEmptyLines: false })
}

export interface ParsedCsv {
  headers: string[]
  /** one record per data row, keyed by header, all cell texts */
  records: Record<string, string>[]
}

/** CSV text -> header + raw cell text records. Tolerates a BOM, CRLF/LF and blank lines. */
export function parseCsvText(text: string): ParsedCsv {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const res = Papa.parse<string[]>(clean, { header: false, skipEmptyLines: 'greedy' })
  const grid = res.data
  if (grid.length === 0) return { headers: [], records: [] }
  const headers = grid[0].map((h) => String(h ?? '').trim())
  const records: Record<string, string>[] = []
  for (let i = 1; i < grid.length; i++) {
    const rec: Record<string, string> = {}
    headers.forEach((h, j) => {
      if (h !== '' && !(h in rec)) rec[h] = grid[i][j] ?? ''
    })
    records.push(rec)
  }
  return { headers, records }
}

/**
 * Stored CSV (our own files, possibly hand-edited) -> typed rows. Lenient: bad cells become null.
 * `__id` is set to the row id; rows without an id get one from `newId`.
 */
export function csvToRows(columns: ColumnDef[], text: string, newId: () => string, now: Date): Row[] {
  const { records } = parseCsvText(text)
  const rows: Row[] = []
  for (const rec of records) {
    const row: FxRecord = {}
    for (const c of columns) {
      const cell = rec[c.name]
      row[c.name] = cell === undefined ? null : coerceLoose(c, cell)
    }
    if (typeof row.id !== 'string' || !row.id) row.id = newId()
    if (!(row.createdOn instanceof Date)) row.createdOn = now
    if (!(row.modifiedOn instanceof Date)) row.modifiedOn = row.createdOn
    row.__id = row.id
    rows.push(row)
  }
  return rows
}
