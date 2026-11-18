/**
 * Shared helpers of the metadata API: friendly errors, identifiers, column and table definition validation,
 * value coercion (used for type-change checks), CSV and YAML helpers. Ported from the phase-2 browser
 * implementation (src/platform/values.ts, core.ts) so the server never imports browser modules.
 */
import { normalizeComputed } from '../../core/table-events.ts'
import * as yaml from 'js-yaml'
import Papa from 'papaparse'
import type { ColumnDef, ColumnType, RoleDef, TableDef } from '../../../src/platform/contracts.ts'
import { HttpError } from '../../core/contracts.ts'
import type { Ctx, UserContext } from '../../core/contracts.ts'
import { convertCell, defaultIn } from '../../core/values.ts'

/* ------------------------------------------------------------------ errors */

export const invalid = (message: string, field?: string): HttpError => new HttpError(422, 'invalid', message, field)
export const conflict = (message: string): HttpError => new HttpError(409, 'conflict', message)
export const notFound = (message: string): HttpError => new HttpError(404, 'not-found', message)
export const denied = (message: string): HttpError => new HttpError(403, 'denied', message)

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
export const clone = <T>(v: T): T => structuredClone(v)

/** RoleDef (isMaker maps to ab_roles.is_maker) */
export type RoleX = RoleDef

export function bodyObj(ctx: Ctx): Record<string, unknown> {
  if (!isObj(ctx.body)) throw invalid('The request body must be a JSON object.')
  return ctx.body
}

export function me(ctx: Ctx): UserContext {
  if (!ctx.user) throw new HttpError(401, 'unauthenticated', 'Please sign in.')
  return ctx.user
}

export function optString(o: Record<string, unknown>, key: string, opts: { max?: number } = {}): string | undefined {
  const v = o[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw invalid(`"${key}" must be text.`, key)
  if (opts.max !== undefined && v.length > opts.max) throw invalid(`"${key}" is too long (maximum ${opts.max} characters).`, key)
  return v
}

export function reqString(o: Record<string, unknown>, key: string, label: string, max = 200): string {
  const v = optString(o, key, { max })
  const t = (v ?? '').trim()
  if (!t) throw invalid(`${label} is required.`, key)
  return t
}

/* ------------------------------------------------------------------ ids and names */

export const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
export const MAX_IDENT = 64

/** "Sales orders (2024)" -> "SalesOrders2024"; never empty, never starts with a digit. */
export function toIdentifier(display: string, fallback = 'Item'): string {
  const parts = display
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  let s = parts.map((p) => p[0].toUpperCase() + p.slice(1)).join('')
  if (!s) s = fallback
  if (/^[0-9]/.test(s)) s = '_' + s
  return s.slice(0, 48)
}

/** first free `base`, `base_2`, `base_3`... (case-insensitive) */
export function uniqueIdentifier(base: string, taken: Iterable<string>): string {
  const used = new Set<string>()
  for (const t of taken) used.add(t.toLowerCase())
  if (!used.has(base.toLowerCase())) return base
  let i = 2
  while (used.has(`${base}_${i}`.toLowerCase())) i++
  return `${base}_${i}`
}

/** first free "Base", "Base (2)", "Base (3)"... (case-insensitive) */
export function uniqueLabel(base: string, taken: Iterable<string>): string {
  const used = new Set<string>()
  for (const t of taken) used.add(t.toLowerCase())
  if (!used.has(base.toLowerCase())) return base
  let i = 2
  while (used.has(`${base} (${i})`.toLowerCase())) i++
  return `${base} (${i})`
}

/* ------------------------------------------------------------------ yaml */

export const toYaml = (value: unknown): string => yaml.dump(value, { lineWidth: -1, noRefs: true, sortKeys: false })

export function fromYaml(text: string): unknown {
  try {
    return yaml.load(text)
  } catch (e) {
    throw invalid(`Not valid YAML: ${(e as Error).message.split('\n')[0]}`)
  }
}

/* ------------------------------------------------------------------ columns */

export const SYSTEM_COLUMNS: ColumnDef[] = [
  { name: 'id', displayName: 'Id', type: 'text', system: true },
  { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true },
  { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime', system: true },
  { name: 'createdBy', displayName: 'Created by', type: 'text', system: true },
  { name: 'owner', displayName: 'Owner', type: 'text', system: true },
]
export const SYSTEM_NAMES = new Set(SYSTEM_COLUMNS.map((c) => c.name))
export const systemColumns = (): ColumnDef[] => SYSTEM_COLUMNS.map((c) => ({ ...c }))

export const COLUMN_TYPES: ColumnType[] = [
  'text', 'multiline', 'email', 'url', 'phone', 'number', 'decimal', 'currency',
  'boolean', 'date', 'datetime', 'choice', 'lookup', 'image', 'autonumber', 'file',
]
export const isAttachmentType = (t: ColumnType): boolean => t === 'file' || t === 'image'

export const MAX_COLUMNS = 200

/* ------------------------------------------------------------------ coercion (type-change checks) */
// Value rules are NOT duplicated here: type changes and defaults use server/core/values.ts (coerceIn), the same code
// every later write goes through, so a conversion the check accepts is a value a write accepts (and vice versa).

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** a calendar day as UTC (inferType only) */
function parseDateText(s: string): Date | null {
  const m = ISO_DATE.exec(s)
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? d : null
}

export type Cell = string | number | boolean | Date | null | undefined

export const isBlankCell = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '')

/**
 * Can a stored value of column `from` become a value of column `to`? Uses the write path's coercion (values.ts):
 * the value is taken as the client would read it (cellOut) and coerced like a client write (coerceIn).
 */
export function tryCoerce(to: ColumnDef, raw: Cell, from?: ColumnDef): { ok: true; value: string | number | boolean | Date | null } | { ok: false; message: string } {
  return convertCell(from, to, raw ?? null)
}

/** default value as typed value (literal text; date/datetime also accept today/now). null when it does not fit. */
export const defaultFor = (col: ColumnDef, now: Date): string | number | boolean | Date | null => defaultIn(col, now)

/** text a SQL/file column of the OLD text type can hold so that converting it to `target` is lossless */
export function normalizeForConversion(target: ColumnDef, v: string | number | boolean | Date | null): string | null {
  if (v === null) return null
  const r = convertCell(undefined, target, v)
  if (!r.ok || r.value === null) return null
  const c = r.value
  switch (target.type) {
    case 'number':
    case 'decimal':
    case 'currency': return String(c)
    case 'boolean': return c ? '1' : '0'
    case 'date': return c instanceof Date ? `${pad(c.getUTCFullYear(), 4)}-${pad(c.getUTCMonth() + 1)}-${pad(c.getUTCDate())}` : null
    case 'datetime': return c instanceof Date ? `${pad(c.getUTCFullYear(), 4)}-${pad(c.getUTCMonth() + 1)}-${pad(c.getUTCDate())} ${pad(c.getUTCHours())}:${pad(c.getUTCMinutes())}:${pad(c.getUTCSeconds())}.${pad(c.getUTCMilliseconds(), 3)}` : null
    default: return typeof c === 'string' ? c : null
  }
}

/* ------------------------------------------------------------------ column / table definitions */

export interface ColumnBuildOpts {
  /** names of the columns that already exist (system + user), for uniqueness */
  existing: ColumnDef[]
  /** name of the table being built (self lookups) */
  selfName?: string
  /** resolves a lookup target table name (any case) to its canonical name, or undefined */
  resolveTable: (name: string) => string | undefined
  now: Date
}

function normalizeAttachmentFields(col: ColumnDef, p: Partial<ColumnDef>): void {
  if (!isAttachmentType(col.type)) return
  if (p.multiple) col.multiple = true
  if (p.accept !== undefined) {
    if (!Array.isArray(p.accept)) throw invalid('"accept" must be a list of MIME patterns.', 'accept')
    const list = [...new Set(p.accept.map((s) => String(s).trim().toLowerCase()).filter(Boolean))]
    for (const a of list) if (!/^[a-z0-9!#$&^_.+-]+\/(\*|[a-z0-9!#$&^_.+-]+)$/.test(a)) throw invalid(`"${a}" is not a valid MIME pattern (for example image/* or application/pdf).`, 'accept')
    if (list.length) col.accept = list
  }
  if (p.maxSizeMB !== undefined && p.maxSizeMB !== null) {
    const n = Number(p.maxSizeMB)
    if (!Number.isFinite(n) || n <= 0 || n > 25) throw invalid('"maxSizeMB" must be a number between 0 and 25.', 'maxSizeMB')
    col.maxSizeMB = n
  }
}

export function buildColumn(p: Partial<ColumnDef>, o: ColumnBuildOpts): ColumnDef {
  const displayName = (p.displayName ?? p.name ?? '').toString().trim()
  if (!displayName) throw invalid('A column needs a display name.', 'displayName')
  if (displayName.length > 200) throw invalid('The display name is too long.', 'displayName')
  const type: ColumnType = p.type ?? 'text'
  if (!COLUMN_TYPES.includes(type)) throw invalid(`Unknown column type "${String(type)}".`, 'type')
  let name: string
  if (p.name !== undefined && p.name !== '') {
    if (!IDENT.test(p.name) || p.name.length > MAX_IDENT) throw invalid(`Column name "${p.name}" is not a valid identifier (letters, digits, underscore; at most ${MAX_IDENT}).`, 'name')
    if (o.existing.some((c) => c.name.toLowerCase() === p.name!.toLowerCase())) throw conflict(`A column named "${p.name}" already exists.`)
    name = p.name
  } else name = uniqueIdentifier(toIdentifier(displayName, 'Column'), o.existing.map((c) => c.name))
  const col: ColumnDef = { name, displayName, type }
  if (p.required) col.required = true
  if (p.unique) col.unique = true
  // a Query v2 key index (PostgreSQL); long text and attachments are never indexed
  if (p.indexed && !isAttachmentType(type) && type !== 'multiline') col.indexed = true
  if (p.default !== undefined && p.default !== null && p.default !== '') col.default = String(p.default)
  if (type === 'choice') col.choices = [...new Set((p.choices ?? []).map((s) => String(s).trim()).filter(Boolean))]
  if (type === 'lookup') {
    const target = p.lookupTable ? (p.lookupTable.toLowerCase() === (o.selfName ?? '').toLowerCase() ? o.selfName : o.resolveTable(p.lookupTable)) : undefined
    if (!target) throw invalid('A lookup column needs an existing target table.', 'lookupTable')
    col.lookupTable = target
  }
  if (type === 'autonumber') col.prefix = p.prefix ?? ''
  if (isAttachmentType(type) && col.unique) throw invalid('Attachment columns cannot be unique.', 'unique')
  normalizeAttachmentFields(col, p)
  // formula and rollup columns (docs/dev/events-and-jobs.md): the shape here, the meaning in kernel.checkColumn
  const computed = normalizeComputed(p.computed)
  if (computed) {
    if (col.required || col.unique || col.default !== undefined) throw invalid(`${displayName} is calculated: it cannot be required, unique or have a default value.`, 'computed')
    col.computed = computed
  }
  if (col.default !== undefined && type !== 'lookup') {
    if (isAttachmentType(type)) throw invalid('Attachment columns cannot have a default value.', 'default')
    const d = defaultFor(col, o.now)
    if (d === null && !/^(today|now)$/i.test(col.default.trim())) throw invalid(`${displayName}: the default "${col.default}" does not fit the column type.`, 'default')
  }
  return col
}

/** Validate a TableDef coming from a package or another untrusted source. Returns a normalized definition. */
export function sanitizeTableDef(raw: unknown, now: string): TableDef {
  if (!isObj(raw)) throw invalid('A table schema is malformed.')
  const name = typeof raw.name === 'string' ? raw.name : ''
  if (!IDENT.test(name) || name.length > MAX_IDENT) throw invalid(`Table name "${name}" is not a valid identifier.`)
  const userCols: ColumnDef[] = []
  const seen = new Set<string>([...SYSTEM_NAMES].map((s) => s.toLowerCase()))
  for (const rc of Array.isArray(raw.columns) ? raw.columns : []) {
    if (!isObj(rc) || typeof rc.name !== 'string' || !IDENT.test(rc.name) || rc.name.length > MAX_IDENT || seen.has(rc.name.toLowerCase())) continue
    seen.add(rc.name.toLowerCase())
    const type = COLUMN_TYPES.includes(rc.type as ColumnType) ? (rc.type as ColumnType) : 'text'
    const col: ColumnDef = { name: rc.name, displayName: typeof rc.displayName === 'string' && rc.displayName ? rc.displayName.slice(0, 200) : rc.name, type }
    if (rc.required === true) col.required = true
    if (rc.unique === true && !isAttachmentType(type)) col.unique = true
    if (rc.indexed === true && !isAttachmentType(type) && type !== 'multiline') col.indexed = true
    if (typeof rc.default === 'string' || typeof rc.default === 'number' || typeof rc.default === 'boolean') col.default = String(rc.default)
    if (type === 'choice') col.choices = Array.isArray(rc.choices) ? rc.choices.map(String) : []
    if (type === 'lookup' && typeof rc.lookupTable === 'string') col.lookupTable = rc.lookupTable
    if (type === 'autonumber') col.prefix = typeof rc.prefix === 'string' ? rc.prefix : ''
    if (rc.computed !== undefined && rc.computed !== null) {
      try {
        const computed = normalizeComputed(rc.computed)
        if (computed) {
          col.computed = computed
          delete col.required
          delete col.unique
          delete col.default
        }
      } catch {
        /* a malformed calculated column in a package stays a plain column */
      }
    }
    if (isAttachmentType(type)) {
      try {
        normalizeAttachmentFields(col, rc as Partial<ColumnDef>)
      } catch {
        /* ignore malformed attachment hints in a package */
      }
      if (rc.multiple === true) col.multiple = true
    }
    userCols.push(col)
  }
  const columns = [...systemColumns(), ...userCols]
  const primary = typeof raw.primaryColumn === 'string' && columns.some((c) => c.name === raw.primaryColumn) ? raw.primaryColumn : (userCols[0]?.name ?? 'id')
  const def: TableDef = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : '',
    name,
    displayName: typeof raw.displayName === 'string' && raw.displayName ? raw.displayName.slice(0, 200) : name,
    primaryColumn: primary,
    columns,
    createdOn: typeof raw.createdOn === 'string' ? raw.createdOn : now,
    modifiedOn: typeof raw.modifiedOn === 'string' ? raw.modifiedOn : now,
  }
  if (typeof raw.description === 'string' && raw.description) def.description = raw.description
  if (raw.teamOwnership === true) def.teamOwnership = true
  if (raw.sharing === true) def.sharing = true
  return def
}

/* ------------------------------------------------------------------ CSV */

export interface ParsedCsv { headers: string[]; records: Record<string, string>[] }

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

export function unparseCsv(fields: string[], data: string[][], newline: '\r\n' | '\n' = '\n'): string {
  return Papa.unparse({ fields, data }, { newline, quotes: false, skipEmptyLines: false })
}

/** guesses the column type of imported CSV text */
export function inferType(values: string[]): ColumnType {
  const vs = values.map((v) => v.trim()).filter((v) => v !== '')
  if (vs.length === 0) return 'text'
  if (vs.every((v) => /^(true|false)$/i.test(v))) return 'boolean'
  if (vs.every((v) => /^[+-]?\d{1,15}$/.test(v))) return 'number'
  if (vs.every((v) => /^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(v))) return 'decimal'
  if (vs.every((v) => ISO_DATE.test(v) && parseDateText(v) !== null)) return 'date'
  if (vs.every((v) => ISO_DATETIME.test(v) && !Number.isNaN(Date.parse(v)))) return 'datetime'
  if (vs.every((v) => EMAIL.test(v))) return 'email'
  if (vs.every((v) => /^https?:\/\/\S+$/i.test(v))) return 'url'
  if (values.some((v) => v.includes('\n'))) return 'multiline'
  return 'text'
}

/** a JSON-able row cell from CSV text, typed by the column (the DataService validates further) */
export function csvCellToJson(col: ColumnDef, text: string): string | number | boolean | null {
  if (text === '') return null
  switch (col.type) {
    case 'number':
    case 'decimal':
    case 'currency': {
      const t = text.trim().replace(/,/g, '')
      return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) ? Number(t) : text
    }
    case 'boolean': {
      const t = text.trim().toLowerCase()
      return t === 'true' ? true : t === 'false' ? false : text
    }
    default: return text
  }
}

export function jsonCellToCsv(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

/* ------------------------------------------------------------------ misc */

export const SYSTEM_TABLE_NAMES = new Set([
  'ab_meta', 'ab_users', 'ab_sessions', 'ab_roles', 'ab_user_roles', 'ab_role_tables', 'ab_tables', 'ab_apps',
  'ab_connections', 'ab_solutions', 'ab_data_files', 'ab_attachments', 'ab_counters', 'ab_audit',
])

/** removes anything that looks like the given secret from a message that may be shown to the user */
export function redact(message: string, secret?: string): string {
  let out = message
  if (secret && secret.length >= 4) out = out.split(secret).join('***')
  return out
}
