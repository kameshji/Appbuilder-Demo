/**
 * DataService (docs/internal/specs/SPEC3.md section 6): validation, coercion, autonumber, lookups, attachment checks,
 * RLS/CLS enforcement around the connectors, truncation cap, pushdown vs applyQuery, file-table modified flag.
 */
import Papa from 'papaparse'
import { HttpError } from './contracts.ts'
import type {
  AttachmentRecord, AttachmentStore, ConnectionManager, Connector, DataService, MetaStore, RawRow, UserContext,
} from './contracts.ts'
import type { ColumnDef, TableDef } from '../../src/platform/contracts.ts'
import type { Condition, Query, QueryValue } from '../../src/platform/http.ts'
import { DEFAULT_ROW_CAP } from '../../src/platform/http.ts'
import { and, applyQuery, conditionColumns } from './condition.ts'
import { attachmentIds, cellOut, coerceIn, csvText, defaultIn, isBlank } from './values.ts'
import { SYSTEM_COLUMN_NAMES } from './security.ts'
import { errText, isUuid, uid } from './util.ts'
import { DEFAULT_CONNECTION_ID } from './connections.ts'

type JsonRow = Record<string, QueryValue>
type Cell = RawRow[string]

const SYSTEM_DEFS: ColumnDef[] = [
  { name: 'id', displayName: 'Id', type: 'text', system: true },
  { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true },
  { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime', system: true },
  { name: 'createdBy', displayName: 'Created by', type: 'text', system: true },
  { name: 'owner', displayName: 'Owner', type: 'text', system: true },
]

const OPS = new Set(['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'in', 'contains', 'startsWith', 'endsWith', 'isBlank', 'notBlank'])
const MAX_CONDITION_NODES = 2000
const EXPORT_CAP = 1_000_000

export interface DataDeps {
  meta: () => MetaStore
  connections: ConnectionManager
  attachments: AttachmentStore
  log(level: 'info' | 'warn' | 'error', msg: string): void
}

/** extra helpers for the attachment routes (same module boundary as the service) */
export interface DataInternals {
  physical(table: TableDef): TableDef
  connectorFor(table: TableDef): Promise<Connector>
  findRow(table: TableDef, id: string, guard?: Condition): Promise<RawRow | null>
  rowOut(ctx: UserContext | null, table: TableDef, raw: RawRow): JsonRow
  /** guarded single-cell write (sets modifiedOn); returns affected rows */
  writeCells(ctx: UserContext | null, table: TableDef, rowId: string, changes: RawRow): Promise<number>
  removeAttachments(records: AttachmentRecord[]): Promise<void>
  markFileModified(table: TableDef): Promise<void>
}

/** all columns of a def including the system ones (even when the stored def omits them) */
export function allColumns(def: TableDef): ColumnDef[] {
  const out = [...def.columns]
  for (const s of SYSTEM_DEFS) if (!out.some((c) => c.name === s.name)) out.push(s)
  return out
}

function findColumn(def: TableDef, name: string): ColumnDef | undefined {
  const cols = allColumns(def)
  return cols.find((c) => c.name === name) ?? cols.find((c) => c.name.toLowerCase() === name.toLowerCase())
}

const isSystem = (c: ColumnDef): boolean => !!c.system || SYSTEM_COLUMN_NAMES.has(c.name)

function checkCondition(c: unknown, counter: { n: number }, depth = 0): void {
  const bad = (msg: string): never => {
    throw new HttpError(422, 'invalid', `Invalid query: ${msg}`)
  }
  if (++counter.n > MAX_CONDITION_NODES || depth > 32) bad('condition is too large')
  if (!c || typeof c !== 'object' || Array.isArray(c)) bad('condition must be an object')
  const o = c as Record<string, unknown>
  if ('const' in o) {
    if (typeof o.const !== 'boolean') bad('const must be boolean')
    return
  }
  if ('and' in o || 'or' in o) {
    const list = (o.and ?? o.or) as unknown
    if (!Array.isArray(list)) bad('and/or must be arrays')
    for (const x of list as unknown[]) checkCondition(x, counter, depth + 1)
    return
  }
  if ('not' in o) return checkCondition(o.not, counter, depth + 1)
  if (typeof o.col !== 'string' || !o.col) bad('col is required')
  if (typeof o.op !== 'string' || !OPS.has(o.op)) bad(`unknown operator "${String(o.op)}"`)
  const okScalar = (v: unknown) => v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v)
  if (o.op === 'in') {
    if (!Array.isArray(o.value) || !o.value.every(okScalar) || o.value.length > 1000) bad('in takes an array of values')
  } else if (!okScalar(o.value)) bad('value must be a plain value')
}

function checkQuery(q: unknown): Query {
  if (q === undefined || q === null) return {}
  if (typeof q !== 'object' || Array.isArray(q)) throw new HttpError(422, 'invalid', 'Invalid query.')
  const o = q as Query
  if (o.select !== undefined && (!Array.isArray(o.select) || !o.select.every((s) => typeof s === 'string'))) throw new HttpError(422, 'invalid', 'Invalid query: select must be a list of column names.')
  if (o.orderBy !== undefined && (!Array.isArray(o.orderBy) || !o.orderBy.every((x) => x && typeof x.col === 'string' && (x.dir === 'asc' || x.dir === 'desc')))) {
    throw new HttpError(422, 'invalid', 'Invalid query: orderBy must be [{ col, dir: asc|desc }].')
  }
  if (o.top !== undefined && (!Number.isInteger(o.top) || o.top < 0)) throw new HttpError(422, 'invalid', 'Invalid query: top must be a non-negative integer.')
  if (o.skip !== undefined && (!Number.isInteger(o.skip) || o.skip < 0)) throw new HttpError(422, 'invalid', 'Invalid query: skip must be a non-negative integer.')
  if (o.where !== undefined) checkCondition(o.where, { n: 0 })
  return o
}

const pad4 = (n: number) => String(n).padStart(4, '0')

export function createDataService(deps: DataDeps): DataService & { internals: DataInternals } {
  const meta = () => deps.meta()

  function physical(table: TableDef): TableDef {
    return table.source ? table : { ...table, source: 't_' + table.name.toLowerCase() }
  }

  async function connectorFor(table: TableDef): Promise<Connector> {
    return deps.connections.get(table.connectionId || DEFAULT_CONNECTION_ID)
  }

  async function runSelect(connector: Connector, def: TableDef, q: Query): Promise<{ rows: RawRow[]; total?: number }> {
    if (connector.capabilities.pushdown) return connector.select(def, q)
    const all = await connector.select(def, {})
    return applyQuery(all.rows, q)
  }

  async function findRow(table: TableDef, id: string, guard?: Condition): Promise<RawRow | null> {
    const def = physical(table)
    const connector = await connectorFor(def)
    const where = guard && !('const' in guard && guard.const) ? and({ col: 'id', op: 'eq', value: id }, guard) : { col: 'id', op: 'eq' as const, value: id }
    if (guard && 'const' in guard && !guard.const) return null
    const res = await runSelect(connector, def, { where, top: 2 })
    return res.rows.find((r) => String(r.id) === id) ?? null
  }

  function visibleColumns(ctx: UserContext | null, table: TableDef): ColumnDef[] {
    const cols = allColumns(table)
    if (!ctx) return cols
    return cols.filter((c) => c.name === 'id' || ctx.columnAccess(table, c.name) !== 'none')
  }

  function rowOut(ctx: UserContext | null, table: TableDef, raw: RawRow, select?: string[]): JsonRow {
    const out: JsonRow = {}
    const keep = select ? new Set([...select, 'id']) : null
    for (const c of visibleColumns(ctx, table)) {
      if (keep && !keep.has(c.name)) continue
      out[c.name] = cellOut(c, raw[c.name])
    }
    out.id = raw.id === null || raw.id === undefined ? null : String(raw.id)
    return out
  }

  async function markFileModified(table: TableDef): Promise<void> {
    if (table.origin?.kind !== 'file' || !table.origin.fileId) return
    try {
      await meta().db.exec('UPDATE ab_data_files SET modified_since_import = 1 WHERE id = ? AND modified_since_import = 0', [table.origin.fileId])
    } catch (e) {
      deps.log('warn', `could not flag data file ${table.origin.fileId} as modified: ${errText(e)}`)
    }
  }

  async function removeAttachments(records: AttachmentRecord[]): Promise<void> {
    for (const a of records) {
      try {
        await meta().attachments.remove(a.id)
        await deps.attachments.remove(a.storageKey)
      } catch (e) {
        deps.log('warn', `attachment cleanup failed for ${a.id}: ${errText(e)}`)
      }
    }
  }

  async function audit(ctx: UserContext | null, action: string, table: TableDef, rowId?: string, details?: unknown) {
    try {
      await meta().audit({ userId: ctx?.user.id ?? null, action, tableId: table.id, rowId, details })
    } catch (e) {
      deps.log('warn', `audit failed: ${errText(e)}`)
    }
  }

  /* ---------------------------------------------------------------- query */

  async function doQuery(ctx: UserContext | null, table: TableDef, input: unknown, cap: number) {
    const q = checkQuery(input)
    const def = physical(table)
    const referenced = new Set<string>([...(q.select ?? []), ...conditionColumns(q.where), ...(q.orderBy ?? []).map((o) => o.col)])
    for (const name of referenced) {
      const col = allColumns(def).find((c) => c.name === name)
      if (!col) throw new HttpError(422, 'invalid', `Column "${name}" does not exist in "${def.displayName || def.name}".`, name)
      if (ctx && name !== 'id' && ctx.columnAccess(def, name) === 'none') {
        throw new HttpError(403, 'denied', `You do not have access to the column "${name}".`, name)
      }
    }
    let where = q.where
    if (ctx) {
      const pred = ctx.rowPredicate(def, 'read')
      if ('const' in pred && !pred.const) return { rows: [] as JsonRow[], total: q.count ? 0 : undefined, truncated: false }
      if (!('const' in pred)) where = where ? and(pred, where) : pred
    }
    const requested = q.top
    const limited = requested !== undefined && requested <= cap
    const top = limited ? requested : cap + 1
    let select = q.select?.length ? [...new Set([...q.select, 'id'])] : undefined
    if (!select && ctx) {
      const visible = visibleColumns(ctx, def)
      if (visible.length < allColumns(def).length) select = visible.map((c) => c.name)
    }
    const connector = await connectorFor(def)
    const res = await runSelect(connector, def, { where, orderBy: q.orderBy, top, skip: q.skip, select, count: q.count })
    let rows = res.rows
    let truncated = false
    if (!limited && rows.length > cap) {
      rows = rows.slice(0, cap)
      truncated = true
    }
    return { rows: rows.map((r) => rowOut(ctx, def, r, q.select?.length ? q.select : undefined)), total: q.count ? res.total : undefined, truncated }
  }

  /* ---------------------------------------------------------------- validation helpers */

  async function exists(def: TableDef, where: Condition): Promise<boolean> {
    const connector = await connectorFor(def)
    const res = await runSelect(connector, def, { where, top: 1, select: ['id'] })
    return res.rows.length > 0
  }

  async function checkUnique(def: TableDef, col: ColumnDef, v: Cell, exceptId?: string) {
    if (!col.unique || v === null || v === '') return
    const value: QueryValue = v instanceof Date ? v.toISOString() : v
    const where: Condition = exceptId ? and({ col: col.name, op: 'eq', value }, { col: 'id', op: 'ne', value: exceptId }) : { col: col.name, op: 'eq', value }
    if (await exists(def, where)) {
      throw new HttpError(409, 'conflict', `${col.displayName || col.name}: "${String(value).slice(0, 60)}" already exists (values must be unique).`, col.name)
    }
  }

  async function checkLookup(def: TableDef, col: ColumnDef, v: Cell) {
    if (col.type !== 'lookup' || v === null || v === '') return
    const target = col.lookupTable === def.name || col.lookupTable === def.id ? def : col.lookupTable ? await meta().tables.get(col.lookupTable) : null
    if (!target) throw new HttpError(422, 'invalid', `${col.displayName || col.name}: the lookup table "${col.lookupTable ?? ''}" does not exist.`, col.name)
    if (!(await exists(physical(target), { col: 'id', op: 'eq', value: String(v) }))) {
      throw new HttpError(422, 'invalid', `${col.displayName || col.name}: no row with id "${String(v).slice(0, 64)}" in "${target.displayName || target.name}".`, col.name)
    }
  }

  async function checkAttachments(def: TableDef, col: ColumnDef, v: Cell, rowId: string, previous: string[]) {
    if (col.type !== 'file' && col.type !== 'image') return
    const ids = attachmentIds(v).filter((x) => !previous.includes(x))
    if (!ids.length) return
    const recs = await meta().attachments.many(ids)
    for (const id of ids) {
      const a = recs.find((r) => r.id === id)
      if (!a || a.tableId !== def.id || a.column !== col.name || a.rowId !== rowId) {
        throw new HttpError(422, 'invalid', `${col.displayName || col.name}: "${id.slice(0, 64)}" is not an attachment of this row and column (upload files through /api/v1/attachments).`, col.name)
      }
    }
  }

  function writableColumn(ctx: UserContext | null, def: TableDef, col: ColumnDef) {
    if (!ctx) return
    const access = ctx.columnAccess(def, col.name)
    if (access === 'none') throw new HttpError(403, 'denied', `You do not have access to the column "${col.name}".`, col.name)
    if (access === 'read') throw new HttpError(403, 'denied', `${col.displayName || col.name} is read-only for you.`, col.name)
  }

  function checkWritableTable(def: TableDef) {
    if (def.readOnly) throw new HttpError(403, 'denied', `"${def.displayName || def.name}" is read-only.`)
  }

  function asObject(v: unknown, what: string): Record<string, unknown> {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(422, 'invalid', `${what} must be an object.`)
    return v as Record<string, unknown>
  }

  /* ---------------------------------------------------------------- insert */

  interface InsertOpts { preserve: boolean }

  /** coerce + column checks (no I/O); returns the raw values and the requested id */
  function prepareInsert(ctx: UserContext | null, def: TableDef, values: Record<string, unknown>, opts: InsertOpts): { raw: RawRow; id?: string } {
    const raw: RawRow = {}
    let id: string | undefined
    for (const [key, v] of Object.entries(values)) {
      if (key === '__id') continue
      const col = findColumn(def, key)
      if (!col) throw new HttpError(422, 'invalid', `Column "${key}" does not exist in "${def.displayName || def.name}".`, key)
      if (col.name === 'id') {
        if (isBlank(v)) continue
        if (!isUuid(v)) throw new HttpError(422, 'invalid', 'id must be a UUID.', 'id')
        id = String(v).toLowerCase()
        continue
      }
      if (isSystem(col)) {
        if (opts.preserve && !ctx && !isBlank(v)) raw[col.name] = coerceIn(col, v)
        continue // never writable by clients: ignored
      }
      if (col.type === 'autonumber' && !(opts.preserve && !ctx)) continue // server-assigned
      writableColumn(ctx, def, col)
      raw[col.name] = coerceIn(col, v)
    }
    return { raw, id }
  }

  async function insertOne(ctx: UserContext | null, table: TableDef, values: Record<string, unknown>, opts: InsertOpts): Promise<JsonRow> {
    const def = physical(table)
    checkWritableTable(def)
    if (ctx && !ctx.canCreate(def)) throw new HttpError(403, 'denied', `You are not allowed to add rows to "${def.displayName || def.name}".`)
    const { raw: given, id: wantedId } = prepareInsert(ctx, def, values, opts)
    const now = new Date()
    let id = wantedId
    if (id && (await exists(def, { col: 'id', op: 'eq', value: id }))) {
      if (ctx) throw new HttpError(409, 'conflict', 'A row with this id already exists.', 'id')
      id = undefined
    }
    id ??= uid()
    const raw: RawRow = { id }
    for (const col of def.columns) {
      if (isSystem(col)) continue
      if (col.name in given) raw[col.name] = given[col.name]
      else raw[col.name] = defaultIn(col, now)
    }
    for (const col of def.columns) {
      if (col.type !== 'autonumber' || isSystem(col)) continue
      if (raw[col.name] === null || raw[col.name] === undefined || raw[col.name] === '') {
        raw[col.name] = `${col.prefix ?? ''}${pad4(await meta().nextCounter(`${def.id}:${col.name}`))}`
      }
    }
    for (const col of def.columns) {
      if (isSystem(col)) continue
      if (col.required && isBlank(raw[col.name])) throw new HttpError(422, 'invalid', `${col.displayName || col.name} is required.`, col.name)
    }
    for (const col of def.columns) {
      if (isSystem(col)) continue
      await checkUnique(def, col, raw[col.name])
      await checkLookup(def, col, raw[col.name])
      if (ctx) await checkAttachments(def, col, raw[col.name], id, [])
    }
    raw.createdOn = (given.createdOn as Date | undefined) ?? now
    raw.modifiedOn = (given.modifiedOn as Date | undefined) ?? now
    raw.createdBy = ctx ? ctx.user.id : ((given.createdBy as string | undefined) ?? (given.owner as string | undefined) ?? null)
    raw.owner = ctx ? ctx.user.id : ((given.owner as string | undefined) ?? (given.createdBy as string | undefined) ?? null)
    const connector = await connectorFor(def)
    if (!connector.capabilities.write) throw new HttpError(403, 'denied', `"${def.displayName || def.name}" cannot be written through its connection.`)
    await connector.insert(def, [raw])
    await markFileModified(def)
    await audit(ctx, 'row.insert', def, id)
    return rowOut(ctx, def, raw)
  }

  /* ---------------------------------------------------------------- update */

  async function update(ctx: UserContext | null, table: TableDef, id: string, changesIn: Record<string, QueryValue>): Promise<JsonRow> {
    const def = physical(table)
    checkWritableTable(def)
    const changes = asObject(changesIn, 'changes')
    if (typeof id !== 'string' || !id || id.length > 64) throw new HttpError(404, 'not-found', 'Row not found.')
    const existing = await findRow(def, id)
    const readable = async () => (ctx ? (await findRow(def, id, ctx.rowPredicate(def, 'read'))) !== null : existing !== null)
    if (!existing) throw new HttpError(404, 'not-found', 'Row not found.')
    const raw: RawRow = {}
    for (const [key, v] of Object.entries(changes)) {
      if (key === '__id') continue
      const col = findColumn(def, key)
      if (!col) throw new HttpError(422, 'invalid', `Column "${key}" does not exist in "${def.displayName || def.name}".`, key)
      if (col.name === 'id') {
        if (String(v) !== id) throw new HttpError(422, 'invalid', 'The id of a row cannot be changed.', 'id')
        continue
      }
      if (isSystem(col)) continue // never writable by clients: ignored
      if (col.type === 'autonumber' && ctx) continue
      writableColumn(ctx, def, col)
      raw[col.name] = coerceIn(col, v)
    }
    // permission before the (I/O heavy) validation, so a denied user learns nothing about other rows
    const guard = ctx ? ctx.rowPredicate(def, 'update') : undefined
    if (guard && 'const' in guard && !guard.const) {
      throw (await readable()) ? new HttpError(403, 'denied', 'You are not allowed to change this row.') : new HttpError(404, 'not-found', 'Row not found.')
    }
    if (ctx && guard && !('const' in guard) && !(await findRow(def, id, guard))) {
      throw (await readable()) ? new HttpError(403, 'denied', 'You are not allowed to change this row.') : new HttpError(404, 'not-found', 'Row not found.')
    }
    const removed: string[] = []
    for (const [name, v] of Object.entries(raw)) {
      const col = findColumn(def, name)!
      if (col.required && isBlank(v)) throw new HttpError(422, 'invalid', `${col.displayName || col.name} is required.`, col.name)
      await checkUnique(def, col, v, id)
      await checkLookup(def, col, v)
      if (col.type === 'file' || col.type === 'image') {
        const before = attachmentIds(existing[col.name])
        if (ctx) await checkAttachments(def, col, v, id, before)
        const after = new Set(attachmentIds(v))
        for (const b of before) if (!after.has(b)) removed.push(b)
      }
    }
    raw.modifiedOn = new Date()
    const connector = await connectorFor(def)
    if (!connector.capabilities.write) throw new HttpError(403, 'denied', `"${def.displayName || def.name}" cannot be written through its connection.`)
    const n = await connector.update(def, id, raw, guard && !('const' in guard) ? guard : undefined)
    if (n === 0) {
      throw (await readable()) ? new HttpError(403, 'denied', 'You are not allowed to change this row.') : new HttpError(404, 'not-found', 'Row not found.')
    }
    if (removed.length) {
      const recs = (await meta().attachments.many(removed)).filter((a) => a.tableId === def.id && a.rowId === id)
      await removeAttachments(recs)
    }
    await markFileModified(def)
    await audit(ctx, 'row.update', def, id, { columns: Object.keys(raw).filter((k) => k !== 'modifiedOn') })
    const after = (await findRow(def, id)) ?? { ...existing, ...raw }
    return rowOut(ctx, def, after)
  }

  /* ---------------------------------------------------------------- delete */

  async function del(ctx: UserContext | null, table: TableDef, idsIn: string[]): Promise<number> {
    const def = physical(table)
    checkWritableTable(def)
    if (!Array.isArray(idsIn) || !idsIn.every((x) => typeof x === 'string')) throw new HttpError(422, 'invalid', 'ids must be a list of row ids.')
    const ids = [...new Set(idsIn.filter((x) => x && x.length <= 64))]
    if (!ids.length) return 0
    const connector = await connectorFor(def)
    if (!connector.capabilities.write) throw new HttpError(403, 'denied', `"${def.displayName || def.name}" cannot be written through its connection.`)
    let total = 0
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      const inIds: Condition = { col: 'id', op: 'in', value: chunk }
      let guard: Condition | undefined
      let deletable = chunk
      if (ctx) {
        const delPred = ctx.rowPredicate(def, 'delete')
        const readPred = ctx.rowPredicate(def, 'read')
        const readableIds = 'const' in readPred && !readPred.const ? [] : (await runSelect(connector, def, { where: 'const' in readPred ? inIds : and(inIds, readPred), select: ['id'] })).rows.map((r) => String(r.id))
        deletable = 'const' in delPred && !delPred.const ? [] : (await runSelect(connector, def, { where: 'const' in delPred ? inIds : and(inIds, delPred), select: ['id'] })).rows.map((r) => String(r.id))
        const denied = readableIds.filter((x) => !deletable.includes(x))
        if (denied.length) throw new HttpError(403, 'denied', denied.length === 1 ? 'You are not allowed to delete this row.' : `You are not allowed to delete ${denied.length} of these rows.`)
        if (!('const' in delPred)) guard = delPred
      } else {
        deletable = (await runSelect(connector, def, { where: inIds, select: ['id'] })).rows.map((r) => String(r.id))
      }
      if (!deletable.length) continue
      const n = await connector.delete(def, deletable, guard)
      total += n
      const recs = await meta().attachments.forRows(def.id, deletable)
      await removeAttachments(recs)
    }
    if (total === 0 && ids.length === 1) throw new HttpError(404, 'not-found', 'Row not found.')
    if (total > 0) {
      await markFileModified(def)
      await audit(ctx, 'row.delete', def, ids.length === 1 ? ids[0] : undefined, ids.length > 1 ? { count: total } : undefined)
    }
    return total
  }

  /* ---------------------------------------------------------------- csv */

  async function importCsv(ctx: UserContext | null, table: TableDef, csv: string, mode: 'append' | 'replace'): Promise<number> {
    const def = physical(table)
    checkWritableTable(def)
    if (typeof csv !== 'string') throw new HttpError(422, 'invalid', 'csv must be text.', 'csv')
    if (mode !== 'append' && mode !== 'replace') throw new HttpError(422, 'invalid', "mode must be 'append' or 'replace'.", 'mode')
    if (ctx && !ctx.canCreate(def)) throw new HttpError(403, 'denied', `You are not allowed to add rows to "${def.displayName || def.name}".`)
    const parsed = Papa.parse<Record<string, string>>(csv.replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy' })
    const headers = parsed.meta.fields ?? []
    // header -> column (by name, then display name; case-insensitive). Unknown, system, hidden, read-only columns are ignored.
    const mapping = new Map<string, ColumnDef>()
    for (const h of headers) {
      const key = h.trim()
      const col = findColumn(def, key) ?? def.columns.find((c) => (c.displayName || '').toLowerCase() === key.toLowerCase())
      if (!col) continue
      if (col.name === 'id') {
        if (!ctx) mapping.set(h, col)
        continue
      }
      if (isSystem(col)) continue
      if (col.type === 'autonumber' && ctx) continue
      if (ctx && ctx.columnAccess(def, col.name) !== 'update') continue
      mapping.set(h, col)
    }
    const records = parsed.data.map((rec) => {
      const values: Record<string, unknown> = {}
      for (const [h, col] of mapping) values[col.name] = rec[h] ?? null
      return values
    })
    // validation pass before anything is changed
    records.forEach((values, i) => {
      try {
        prepareInsert(ctx, def, values, { preserve: true })
      } catch (e) {
        if (e instanceof HttpError) throw new HttpError(e.status, e.code, `Row ${i + 1}: ${e.message}`, e.field)
        throw e
      }
    })
    if (mode === 'replace') {
      const connector = await connectorFor(def)
      let pred: Condition | undefined
      if (ctx) pred = ctx.rowPredicate(def, 'delete')
      if (!pred || !('const' in pred) || pred.const) {
        const ids = (await runSelect(connector, def, { where: pred && !('const' in pred) ? pred : undefined, select: ['id'] })).rows.map((r) => String(r.id))
        if (ids.length) await del(ctx, def, ids)
      }
    }
    let n = 0
    for (let i = 0; i < records.length; i++) {
      try {
        await insertOne(ctx, def, records[i], { preserve: true })
      } catch (e) {
        if (e instanceof HttpError) throw new HttpError(e.status, e.code, `Row ${i + 1}: ${e.message} (${n} rows were imported before this one)`, e.field)
        throw e
      }
      n++
    }
    await audit(ctx, 'table.import', def, undefined, { mode, rows: n })
    return n
  }

  async function exportCsv(ctx: UserContext | null, table: TableDef): Promise<string> {
    const def = physical(table)
    const res = await doQuery(ctx, def, {}, EXPORT_CAP)
    const cols = visibleColumns(ctx, def).map((c) => c.name)
    const data = res.rows.map((r) => cols.map((c) => csvText(r[c] ?? null)))
    return Papa.unparse({ fields: cols, data }, { newline: '\r\n' })
  }

  async function writeCells(ctx: UserContext | null, table: TableDef, rowId: string, changes: RawRow): Promise<number> {
    const def = physical(table)
    checkWritableTable(def)
    const guard = ctx ? ctx.rowPredicate(def, 'update') : undefined
    if (guard && 'const' in guard && !guard.const) return 0
    const connector = await connectorFor(def)
    const n = await connector.update(def, rowId, { ...changes, modifiedOn: new Date() }, guard && !('const' in guard) ? guard : undefined)
    if (n > 0) await markFileModified(def)
    return n
  }

  return {
    query: (ctx, table, q) => doQuery(ctx, table, q, DEFAULT_ROW_CAP),
    insert: (ctx, table, values) => insertOne(ctx, table, asObject(values, 'values'), { preserve: true }),
    update,
    delete: del,
    importCsv,
    exportCsv,
    internals: { physical, connectorFor, findRow, rowOut: (ctx, t, r) => rowOut(ctx, physical(t), r), writeCells, removeAttachments, markFileModified },
  }
}
