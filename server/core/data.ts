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
import { and, applyQuery, conditionColumns, evaluateWithSemi } from './condition.ts'
import { attachmentIds, cellOut, coerceIn, csvExportText, defaultIn, isBlank } from './values.ts'
import { SYSTEM_COLUMN_NAMES } from './security.ts'
import { errText, isUuid, rowUid } from './util.ts'
import { DEFAULT_CONNECTION_ID } from './connections.ts'
import type { FxRecord } from '../../src/contracts.ts'
import type { ColumnKind, QueryPlan, QueryV2Response, TableSchemaInfo } from '../../src/platform/query.ts'
import {
  QUERY_FALLBACK_ROW_CAP, QUERY_MAX_GROUPS, QUERY_MAX_UNPAGED_ROWS, QUERY_TIMEOUT_MS, bucketKind, columnKind,
} from '../../src/platform/query.ts'
import { checkPlan } from '../../src/fx/query/validate.ts'
import { lastWriterOf, noteLocalWrite } from './live/changes.ts'
import type { TableChangeOp } from './live/changes.ts'
import { currentEnvironment } from './env-context.ts'
import { currentWork } from './work-context.ts'
import { executePlan, PlanError } from '../../src/fx/query/reference.ts'
import type { WriteHooks } from './kernel.ts'
import { CursorError } from '../../src/fx/query/cursor.ts'
import type { SystemDataHooks } from './collab.ts'
import { nextNumberDefault } from '../../src/platform/system-tables.ts'
import { childRelationships, MAX_CASCADE_DEPTH, selfCycleColumns } from './model/delete-rules.ts'
import type { RowScope } from './contracts.ts'
import { createRecycle, deleteSourceOf, newBatch } from './recycle.ts'
import type { BatchCtx, BatchInfo, DeleteSource, Effect, RecycleStore, RestoreResult } from './recycle.ts'
import type { Balances, Ledger } from './balances/engine.ts'
import { maintainedColumns } from './balances/engine.ts'

type JsonRow = Record<string, QueryValue>
type Cell = RawRow[string]

const SYSTEM_DEFS: ColumnDef[] = [
  { name: 'id', displayName: 'Id', type: 'text', system: true },
  { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true },
  { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime', system: true },
  { name: 'createdBy', displayName: 'Created by', type: 'lookup', lookupTable: 'Users', system: true },
  { name: 'owner', displayName: 'Owner', type: 'lookup', lookupTable: 'Users', system: true },
]

const OPS = new Set(['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'in', 'contains', 'startsWith', 'endsWith', 'isBlank', 'notBlank'])
const MAX_CONDITION_NODES = 2000
const EXPORT_CAP = 1_000_000
/** bulk deletes: at most this many row ids are written into one audit entry (the count is always complete) */
export const AUDIT_ID_CAP = 1000

export interface DataDeps {
  meta: () => MetaStore
  connections: ConnectionManager
  attachments: AttachmentStore
  log(level: 'info' | 'warn' | 'error', msg: string): void
  /**
   * write-path hooks of the event and job kernel (kernel.ts): units of work, row locks, table events / formula columns /
   * validation rules, outbox rows, post-commit file deletion. Absent (null) in the metadata test harness.
   */
  hooks?: () => WriteHooks | null
  /** core data model (collab.ts): system-table write hooks, polymorphic cascade, NextNumber column defaults */
  system?: () => SystemDataHooks | null
  /** recycle bin (recycle.ts): the batch store of the system database; absent / null: every delete is final */
  recycle?: () => RecycleStore | null
  /** synchronous balances (balances/engine.ts, P3-P): absent / null without the database */
  balances?: () => Balances | null
}

/** extra helpers for the attachment routes (same module boundary as the service) */
export interface DataInternals {
  physical(table: TableDef): TableDef
  connectorFor(table: TableDef): Promise<Connector>
  /** opts.rows: 'all' also finds a row in the recycle bin (attachment sweep: its files stay until the purge) */
  findRow(table: TableDef, id: string, guard?: Condition, opts?: { rows?: RowScope }): Promise<RawRow | null>
  rowOut(ctx: UserContext | null, table: TableDef, raw: RawRow): JsonRow
  /** guarded single-cell write (sets modifiedOn); returns affected rows */
  writeCells(ctx: UserContext | null, table: TableDef, rowId: string, changes: RawRow): Promise<number>
  removeAttachments(records: AttachmentRecord[]): Promise<void>
  markFileModified(table: TableDef): Promise<void>
}

/**
 * all columns of a def including the system ones (even when the stored def omits them), except the system columns a
 * linked source does not have (def.missingSystem): those are never queried or written.
 */
export function allColumns(def: TableDef): ColumnDef[] {
  const missing = new Set(def.missingSystem ?? [])
  const out = def.columns.filter((c) => !(missing.has(c.name) && SYSTEM_COLUMN_NAMES.has(c.name)))
  for (const s of SYSTEM_DEFS) if (!missing.has(s.name) && !out.some((c) => c.name === s.name)) out.push(s)
  return out
}

/** does the physical table have this system column? */
export const hasSystemColumn = (def: TableDef, name: string): boolean => !(def.missingSystem ?? []).includes(name)

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

/** a delete operation down the relationship tree: depth, rows already seen, and the recycle bin batch (when it keeps rows) */
interface Cascade { depth: number; seen: Set<string>; batch?: BatchCtx | null }

const pad4 = (n: number) => String(n).padStart(4, '0')
const isConstFalse = (c: Condition | undefined): boolean => !!c && 'const' in c && !c.const
const isConstTrue = (c: Condition | undefined): boolean => !c || ('const' in c && c.const)
/** unique-check key (text compares case-insensitively, like the connectors) */
const uniqueKey = (v: Cell): string => (v instanceof Date ? `d:${v.getTime()}` : typeof v === 'string' ? `s:${v.trim().toLowerCase()}` : `v:${String(v)}`)
const ID_CHUNK = 500

/** the recycle bin's part of the DataService (server-side callers: routes, formula host, jobs) */
export interface RecycleApi {
  deleteRows(ctx: UserContext | null, table: TableDef, ids: string[], opts?: { source?: DeleteSource }): Promise<{ deleted: number; batch: BatchInfo | null }>
  restore(ctx: UserContext | null, table: TableDef, input: { batch?: string; rowId?: string }): Promise<RestoreResult>
  recycle: import('./recycle.ts').Recycle
}

/** P2-B: claims a generated file token (gen_...) for an attachment cell; returns the new attachment id (print/files.ts) */
type GeneratedClaimer = (ctx: UserContext, def: TableDef, col: ColumnDef, rowId: string, token: string) => Promise<string>
let generatedClaimer: GeneratedClaimer | null = null
export const GENERATED_TOKEN_RE = /^gen_[A-Za-z0-9]{24}$/
export function setGeneratedFileClaimer(fn: GeneratedClaimer | null): void { generatedClaimer = fn }

export function createDataService(deps: DataDeps): DataService & RecycleApi & { internals: DataInternals } {
  const meta = () => deps.meta()

  function physical(table: TableDef): TableDef {
    return table.source ? table : { ...table, source: 't_' + table.name.toLowerCase() }
  }

  async function connectorFor(table: TableDef): Promise<Connector> {
    return deps.connections.get(table.connectionId || DEFAULT_CONNECTION_ID)
  }

  async function runSelect(connector: Connector, def: TableDef, q: Query, rows?: RowScope): Promise<{ rows: RawRow[]; total?: number }> {
    if (connector.capabilities.pushdown) return rows && rows !== 'live' ? connector.select(def, q, { rows }) : connector.select(def, q)
    const all = await connector.select(def, {})
    return applyQuery(all.rows, q)
  }

  async function findRow(table: TableDef, id: string, guard?: Condition, conn?: Connector, rows?: RowScope): Promise<RawRow | null> {
    const def = physical(table)
    const connector = conn ?? (await connectorFor(def))
    const where = guard && !('const' in guard && guard.const) ? and({ col: 'id', op: 'eq', value: id }, guard) : { col: 'id', op: 'eq' as const, value: id }
    if (guard && 'const' in guard && !guard.const) return null
    const res = await runSelect(connector, def, { where, top: 2 }, rows)
    return res.rows.find((r) => String(r.id) === id) ?? null
  }

  /* ---------------------------------------------------------------- recycle bin (recycle.ts) */

  /** does a delete of this table keep the rows (recycle bin on, default database with the batch store)? */
  async function keepsDeleted(def: TableDef): Promise<Connector | null> {
    if (def.recycleBin !== true || !((def.recycleDays ?? 0) > 0) || !deps.recycle?.()) return null
    const c = await connectorFor(def)
    return c.capabilities.recycle && c.recycle ? c : null
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
      await meta().files.markModified(table.origin.fileId)
    } catch (e) {
      deps.log('warn', `could not flag data file ${table.origin.fileId} as modified: ${errText(e)}`)
    }
  }

  async function removeAttachments(records: AttachmentRecord[]): Promise<void> {
    const gone: AttachmentRecord[] = []
    for (const a of records) {
      try {
        await meta().attachments.remove(a.id)
        gone.push(a)
      } catch (e) {
        deps.log('warn', `attachment cleanup failed for ${a.id}: ${errText(e)}`)
      }
    }
    if (!gone.length) return
    // the files go after the unit of work commits (a job): a rolled-back change still finds its files
    const hooks = deps.hooks?.()
    if (hooks) {
      try {
        if (await hooks.deleteFilesAfterCommit(gone.map((a) => a.storageKey))) return
      } catch (e) {
        deps.log('warn', `could not queue the deletion of ${gone.length} attachment file(s): ${errText(e)}`)
        throw e
      }
    }
    for (const a of gone) await deps.attachments.remove(a.storageKey).catch((e) => deps.log('warn', `attachment file cleanup failed for ${a.id}: ${errText(e)}`))
  }

  /** the kernel's unit of work around a write (transaction on the default database), or just fn */
  function unit<T>(table: TableDef, fn: () => Promise<T>): Promise<T> {
    const h = deps.hooks?.()
    return h ? h.unit(physical(table), fn) : fn()
  }

  /* ---------------------------------------------------------------- synchronous balances (balances/engine.ts) */

  /** the balances this table's rows move (it is their movements table), or [] */
  async function ledgersOf(def: TableDef): Promise<Ledger[]> {
    const b = deps.balances?.()
    return b ? b.sources(def) : []
  }

  /** applies the difference of the movement rows before / after a change to their balances (same unit of work) */
  async function moveBalances(ledgers: Ledger[], before: RawRow[], after: RawRow[]): Promise<void> {
    const b = deps.balances?.()
    if (!b || !ledgers.length || (!before.length && !after.length)) return
    for (const c of await b.apply(ledgers, before, after)) {
      changed(null, c.table, c.op, [c.rowId], [c.column])
      await deps.hooks?.()?.outbox(null, c.table, { op: c.op, rowId: c.rowId, changed: [c.column], before: c.before, after: c.after })
    }
  }

  /** a balance table's rows are kept by the platform: users never add, import or delete them */
  function refuseBalanceWrite(ctx: UserContext | null, def: TableDef): void {
    if (ctx && def.balance) throw new HttpError(403, 'denied', `The rows of "${def.displayName || def.name}" are kept by the platform from the movements in ${def.balance.movements}: record a movement instead.`)
  }

  async function audit(ctx: UserContext | null, action: string, table: TableDef, rowId?: string, details?: unknown) {
    try {
      await meta().audit({ userId: ctx?.user.id ?? null, action, tableId: table.id, rowId, details })
    } catch (e) {
      // never fails the request, but always visible on the console
      deps.log('error', `audit write failed (${action}): ${errText(e)}`)
    }
  }

  /**
   * realtime (live/changes.ts): the pushes come from the committed outbox rows; here we only note who wrote which rows
   * and from which live connection (the request id links them to the outbox row)
   */
  function changed(ctx: UserContext | null, def: TableDef, op: TableChangeOp, rowIds: string[], _columns: string[]) {
    void _columns
    noteLocalWrite(currentEnvironment().id, def.id, op, rowIds, ctx ? { id: ctx.user.id, name: ctx.user.name } : null, currentWork().requestId)
  }

  /** row ids for the audit log: the list (at most AUDIT_ID_CAP) and the total count */
  function auditIds(ids: string[]): { count: number; ids: string[]; idsTruncated?: true } {
    return ids.length > AUDIT_ID_CAP ? { count: ids.length, ids: ids.slice(0, AUDIT_ID_CAP), idsTruncated: true } : { count: ids.length, ids }
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
    let select = q.select?.length ? [...new Set([...q.select, ...(hasSystemColumn(def, 'id') ? ['id'] : [])])] : undefined
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

  /** true when a row matches `where`, ignoring the rows in `ignore` (rows about to be replaced) */
  async function exists(def: TableDef, where: Condition, conn?: Connector, ignore?: Set<string>): Promise<boolean> {
    const connector = conn ?? (await connectorFor(def))
    const top = 1 + (ignore?.size ?? 0)
    const res = await runSelect(connector, def, { where, top, select: ['id'] })
    return ignore?.size ? res.rows.some((r) => !ignore.has(String(r.id))) : res.rows.length > 0
  }

  /**
   * The owner a user may give a row of a team-ownership table: themself or a team of theirs in this environment;
   * administrators: any user or team. The update guard and WITH CHECK still apply to the row as changed.
   */
  async function assignableOwner(ctx: UserContext, v: unknown): Promise<string> {
    const id = String(v).trim()
    if (id === ctx.user.id || (ctx.user.org?.teams ?? []).some((t) => t.id === id)) return id
    if (ctx.privileges.isAdmin) {
      const env = currentEnvironment().id
      const teams = (await meta().org?.teams.list()) ?? []
      if (teams.some((t) => t.id === id && (!t.environmentId || t.environmentId === env))) return id
      if (await meta().users.get(id)) return id
      throw new HttpError(422, 'invalid', `There is no user or team with the id "${id.slice(0, 64)}".`, 'owner')
    }
    throw new HttpError(403, 'denied', 'You can give a row only to yourself or to a team you belong to.', 'owner')
  }

  /**
   * WITH CHECK of a security predicate on a row in memory. Relationship rules (semi nodes, src/platform/orgsec.ts) are
   * answered by the connector: is there a row of the rule's table with that key that matches the rule?
   */
  async function rowMatches(def: TableDef, pred: Condition, row: RawRow): Promise<boolean> {
    void def
    return evaluateWithSemi(pred, row, (sj, value) => exists(physical(sj.table), and({ col: sj.key, op: 'eq', value: value instanceof Date ? value.toISOString() : String(value) }, sj.where)))
  }

  async function checkUnique(def: TableDef, col: ColumnDef, v: Cell, exceptId?: string, conn?: Connector, ignore?: Set<string>) {
    if (!col.unique || v === null || v === '') return
    const value: QueryValue = v instanceof Date ? v.toISOString() : v
    const where: Condition = exceptId ? and({ col: col.name, op: 'eq', value }, { col: 'id', op: 'ne', value: exceptId }) : { col: col.name, op: 'eq', value }
    if (await exists(def, where, conn, ignore)) throw duplicate(col, value)
  }

  function duplicate(col: ColumnDef, value: QueryValue): HttpError {
    return new HttpError(409, 'conflict', `${col.displayName || col.name}: "${String(value).slice(0, 60)}" already exists (values must be unique).`, col.name)
  }

  async function checkLookup(def: TableDef, col: ColumnDef, v: Cell, conn?: Connector, ctx?: UserContext | null) {
    if (col.type !== 'lookup' || v === null || v === '') return
    const self = col.lookupTable === def.name || col.lookupTable === def.id
    const target = self ? def : col.lookupTable ? await meta().tables.get(col.lookupTable) : null
    if (!target) throw new HttpError(422, 'invalid', `${col.displayName || col.name}: the lookup table "${col.lookupTable ?? ''}" does not exist.`, col.name)
    // a user may only point at rows they can read (no probing for, or linking to, rows they cannot see): an unreadable
    // row answers exactly like a missing one
    const readable = ctx ? ctx.rowPredicate(target, 'read') : undefined
    if (readable && 'const' in readable && !readable.const) throw new HttpError(422, 'invalid', `${col.displayName || col.name}: no row with id "${String(v).slice(0, 64)}" in "${target.displayName || target.name}".`, col.name)
    const byId: Condition = { col: 'id', op: 'eq', value: String(v) }
    if (!(await exists(physical(target), readable && !isConstTrue(readable) ? and(byId, readable) : byId, self ? conn : undefined))) {
      throw new HttpError(422, 'invalid', `${col.displayName || col.name}: no row with id "${String(v).slice(0, 64)}" in "${target.displayName || target.name}".`, col.name)
    }
  }

  async function checkAttachments(def: TableDef, col: ColumnDef, v0: Cell, rowId: string, previous: string[], ctx?: UserContext | null): Promise<Cell> {
    if (col.type !== 'file' && col.type !== 'image') return v0
    let v = v0
    // P2-B: a generated file (GeneratePdf, print templates) given as its token becomes an attachment of this cell
    if (generatedClaimer && ctx && attachmentIds(v).some((x) => GENERATED_TOKEN_RE.test(x))) {
      const mapped: string[] = []
      for (const x of attachmentIds(v)) mapped.push(GENERATED_TOKEN_RE.test(x) ? await generatedClaimer(ctx, def, col, rowId, x) : x)
      v = col.multiple ? JSON.stringify(mapped) : (mapped[0] ?? null)
    }
    const ids = attachmentIds(v).filter((x) => !previous.includes(x))
    if (!ids.length) return v
    const recs = await meta().attachments.many(ids)
    for (const id of ids) {
      const a = recs.find((r) => r.id === id)
      if (!a || a.tableId !== def.id || a.column !== col.name || a.rowId !== rowId) {
        throw new HttpError(422, 'invalid', `${col.displayName || col.name}: "${id.slice(0, 64)}" is not an attachment of this row and column (upload files through /api/v1/attachments).`, col.name)
      }
    }
    return v
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
      if (col.computed) continue // formula and rollup columns: the server calculates them, values sent are ignored
      if (col.type === 'autonumber' && !(opts.preserve && !ctx)) continue // server-assigned
      if (ctx && def.balance && maintainedColumns(def).has(col.name)) continue // a balance: kept by the platform
      writableColumn(ctx, def, col)
      raw[col.name] = coerceIn(col, v)
    }
    return { raw, id }
  }

  /** state shared by the rows of one import (duplicates inside the batch) */
  interface Batch { ids: Set<string>; unique: Map<string, Set<string>> }
  interface BuildOpts extends InsertOpts {
    /** connector to check against (the import's) */
    conn?: Connector
    /** ids of rows that are replaced by this batch: ignored by the id and unique checks */
    replacing?: Set<string>
    batch?: Batch
    /** system imports on behalf of a user: createdBy and owner become this user id */
    actorId?: string
  }

  function cannotCreate(def: TableDef): HttpError {
    return new HttpError(403, 'denied', `You are not allowed to add rows to "${def.displayName || def.name}".`)
  }

  /**
   * The complete row to insert (defaults, system fields, autonumbers) after every check: create permission including the
   * WITH CHECK of the roles' row filters, required, unique, lookups, attachments. Writes nothing (except autonumber
   * counters, which may leave gaps when a later check fails).
   */
  async function buildRow(ctx: UserContext | null, def: TableDef, values: Record<string, unknown>, opts: BuildOpts): Promise<RawRow> {
    const { raw: given, id: wantedId } = prepareInsert(ctx, def, values, opts)
    const now = new Date()
    let id = wantedId
    if (id) {
      const taken = opts.batch?.ids.has(id) || (await exists(def, { col: 'id', op: 'eq', value: id }, opts.conn, opts.replacing))
      if (taken) {
        if (ctx) throw new HttpError(409, 'conflict', 'A row with this id already exists.', 'id')
        id = undefined
      }
    }
    id ??= rowUid(now.getTime())
    opts.batch?.ids.add(id)
    const raw: RawRow = { id }
    for (const col of def.columns) {
      if (isSystem(col)) continue
      if (col.name in given) raw[col.name] = given[col.name]
      else raw[col.name] = defaultIn(col, now)
    }
    raw.createdOn = (given.createdOn as Date | undefined) ?? now
    raw.modifiedOn = (given.modifiedOn as Date | undefined) ?? now
    const actor = ctx ? ctx.user.id : opts.actorId
    raw.createdBy = actor ?? ((given.createdBy as string | undefined) ?? (given.owner as string | undefined) ?? null)
    raw.owner = actor ?? ((given.owner as string | undefined) ?? (given.createdBy as string | undefined) ?? null)
    // team-owned rows (docs/admin/security-model.md): the creator may hand the new row to a team they belong to
    if (ctx && def.teamOwnership && !isBlank(values.owner as Cell)) raw.owner = await assignableOwner(ctx, values.owner)
    for (const name of def.missingSystem ?? []) if (name !== 'id') delete raw[name]
    // core data model (collab.ts): the regarding link is resolved and checked, rich text sanitised, mentions extracted
    const sys = deps.system?.()
    if (sys && def.system) Object.assign(raw, await sys.beforeWrite(ctx, def, 'create', raw, null, null))
    // table events, formula columns and validation rules (kernel.ts): they may set columns or refuse the row; the
    // permission and value checks below see the row as the events left it
    const hooks = deps.hooks?.()
    if (hooks) Object.assign(raw, await hooks.beforeWrite(ctx, def, 'create', raw, null, null))
    // RLS WITH CHECK: the new row must match the row filter of a role that grants create (admins: always)
    if (ctx && !(await rowMatches(def, ctx.rowPredicate(def, 'create'), raw))) {
      throw new HttpError(403, 'denied', `You are not allowed to add this row to "${def.displayName || def.name}": it does not match the rows your role may create.`)
    }
    for (const col of def.columns) {
      if (col.type !== 'autonumber' || isSystem(col)) continue
      if (raw[col.name] === null || raw[col.name] === undefined || raw[col.name] === '') {
        raw[col.name] = `${col.prefix ?? ''}${pad4(await meta().nextCounter(`${def.id}:${col.name}`))}`
      }
    }
    // column default =NextNumber("name"): the number is drawn in this write's transaction (gap-free)
    if (sys) {
      for (const col of def.columns) {
        const seq = nextNumberDefault(col.default)
        if (seq && !isSystem(col) && (!(col.name in given) || isBlank(given[col.name]))) raw[col.name] = await sys.nextNumber(seq)
      }
    }
    for (const col of def.columns) {
      if (isSystem(col)) continue
      if (col.required && isBlank(raw[col.name])) throw new HttpError(422, 'invalid', `${col.displayName || col.name} is required.`, col.name)
    }
    for (const col of def.columns) {
      if (isSystem(col)) continue
      const v = raw[col.name]
      if (opts.batch && col.unique && v !== null && v !== '') {
        const seen = opts.batch.unique.get(col.name) ?? new Set<string>()
        opts.batch.unique.set(col.name, seen)
        if (seen.has(uniqueKey(v))) throw duplicate(col, v instanceof Date ? v.toISOString() : v)
        seen.add(uniqueKey(v))
      }
      await checkUnique(def, col, v, undefined, opts.conn, opts.replacing)
      await checkLookup(def, col, v, opts.conn, ctx)
      if (col.type === 'lookup' && v !== null && v !== '' && String(v) === id && col.lookupTable?.toLowerCase() === def.name.toLowerCase()) {
        throw new HttpError(422, 'invalid', `${col.displayName || col.name}: a row cannot be its own parent.`, col.name)
      }
      if (ctx && (col.type === 'file' || col.type === 'image')) raw[col.name] = await checkAttachments(def, col, v, id, [], ctx)
    }
    return raw
  }

  async function writableConnector(def: TableDef): Promise<Connector> {
    const connector = await connectorFor(def)
    if (!connector.capabilities.write) throw new HttpError(403, 'denied', `"${def.displayName || def.name}" cannot be written through its connection.`)
    return connector
  }

  async function insertOne(ctx: UserContext | null, table: TableDef, values: Record<string, unknown>, opts: InsertOpts): Promise<JsonRow> {
    const def = physical(table)
    checkWritableTable(def)
    if (ctx && !ctx.canCreate(def)) throw cannotCreate(def)
    refuseBalanceWrite(ctx, def)
    const connector = await writableConnector(def)
    const raw = await buildRow(ctx, def, values, { ...opts, conn: connector })
    await connector.insert(def, [raw])
    await moveBalances(await ledgersOf(def), [], [raw])
    await deps.system?.()?.afterWrite(ctx, def, 'create', raw, null)
    await markFileModified(def)
    await audit(ctx, 'row.insert', def, String(raw.id))
    changed(ctx, def, 'insert', [String(raw.id)], Object.keys(raw))
    await deps.hooks?.()?.outbox(ctx, def, { op: 'insert', rowId: String(raw.id), changed: Object.keys(raw), after: raw })
    return rowOut(ctx, def, raw)
  }

  /* ---------------------------------------------------------------- update */

  /** 409 for a stale save: the row as the caller may see it now, and who changed it last (when known) */
  function versionConflict(ctx: UserContext | null, def: TableDef, id: string, now: RawRow): HttpError {
    const by = lastWriterOf(currentEnvironment().id, def.id, id)
    const who = by && by.id !== ctx?.user.id ? by.name : null
    return new HttpError(409, 'conflict', `${who ? `${who} changed` : 'Someone else changed'} this record after you opened it. Reload it, or save again to keep your version.`, 'modifiedOn', {
      current: rowOut(ctx, def, now),
      ...(who ? { changedBy: { id: by!.id, name: who } } : {}),
    })
  }

  async function update(ctx: UserContext | null, table: TableDef, id: string, changesIn: Record<string, QueryValue>, opts: { ifModifiedOn?: string } = {}): Promise<JsonRow> {
    const def = physical(table)
    checkWritableTable(def)
    const changes = asObject(changesIn, 'changes')
    if (typeof id !== 'string' || !id || id.length > 64) throw new HttpError(404, 'not-found', 'Row not found.')
    const hooks = deps.hooks?.()
    // read-modify-write of formula columns and before-events: concurrent saves of one row run one after another
    if (hooks) await hooks.lockRow(def, id)
    // a movement of a balance: locked and read before the change (its old quantity and key leave the balance)
    const ledgers = await ledgersOf(def)
    const balBefore = ledgers.length ? await deps.balances!()!.lock(def, ledgers, [id]) : []
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
      if (col.name === 'owner' && ctx && def.teamOwnership && !isBlank(v)) {
        raw.owner = await assignableOwner(ctx, v)
        continue
      }
      if (isSystem(col)) continue // never writable by clients: ignored
      if (col.computed) continue // calculated by the server: ignored
      if (col.type === 'autonumber' && ctx) continue
      if (ctx && def.balance && maintainedColumns(def).has(col.name)) continue // a balance: kept by the platform
      writableColumn(ctx, def, col)
      raw[col.name] = coerceIn(col, v)
    }
    // core data model: regarding links stay, comments only by their author, completion stamps (collab.ts)
    const sys = def.system ? deps.system?.() : null
    if (sys) Object.assign(raw, await sys.beforeWrite(ctx, def, 'update', { ...existing, ...raw }, existing, new Set(Object.keys(raw))))
    // permission before the (I/O heavy) validation, so a denied user learns nothing about other rows
    const guard = ctx ? ctx.rowPredicate(def, 'update') : undefined
    if (guard && 'const' in guard && !guard.const) {
      throw (await readable()) ? new HttpError(403, 'denied', 'You are not allowed to change this row.') : new HttpError(404, 'not-found', 'Row not found.')
    }
    if (ctx && guard && !('const' in guard) && !(await findRow(def, id, guard))) {
      throw (await readable()) ? new HttpError(403, 'denied', 'You are not allowed to change this row.') : new HttpError(404, 'not-found', 'Row not found.')
    }
    // table events, formula columns and validation rules (kernel.ts): they may set more columns or refuse the change
    if (hooks) {
      const set = await hooks.beforeWrite(ctx, def, 'update', { ...existing, ...raw }, existing, new Set(Object.keys(raw)))
      for (const [k, v] of Object.entries(set)) raw[k] = v
    }
    // RLS WITH CHECK: the changed row must still match the update predicate (it may leave the read filter: it then
    // simply disappears for this user)
    if (ctx && guard && !isConstTrue(guard) && !(await rowMatches(def, guard, { ...existing, ...raw }))) {
      throw new HttpError(403, 'denied', 'You are not allowed to make this change: the row would no longer match the rows your role may change.')
    }
    const removed: string[] = []
    for (const [name, v] of Object.entries(raw)) {
      const col = findColumn(def, name)!
      if (col.required && isBlank(v)) throw new HttpError(422, 'invalid', `${col.displayName || col.name} is required.`, col.name)
      await checkUnique(def, col, v, id)
      await checkLookup(def, col, v, undefined, ctx)
      if (col.type === 'lookup') await checkNoCycle(def, col, v, id)
      if (col.type === 'file' || col.type === 'image') {
        const before = attachmentIds(existing[col.name])
        const v2 = ctx ? await checkAttachments(def, col, v, id, before, ctx) : v
        if (v2 !== v) raw[name] = v2
        const after = new Set(attachmentIds(v2))
        for (const b of before) if (!after.has(b)) removed.push(b)
      }
    }
    // optimistic concurrency: the caller saw the row at ifModifiedOn; a newer save by anyone answers 409 (after the
    // permission checks above, so a 409 never reveals a row the caller may not change)
    let versionGuard: Condition | undefined
    if (opts.ifModifiedOn !== undefined && hasSystemColumn(def, 'modifiedOn')) {
      const want = typeof opts.ifModifiedOn === 'string' ? Date.parse(opts.ifModifiedOn) : NaN
      if (!Number.isFinite(want)) throw new HttpError(422, 'invalid', 'ifModifiedOn must be an ISO date and time.', 'ifModifiedOn')
      const have = existing.modifiedOn instanceof Date ? existing.modifiedOn : existing.modifiedOn ? new Date(String(existing.modifiedOn)) : null
      if (!have || have.getTime() !== want) throw versionConflict(ctx, def, id, existing)
      // a millisecond window: values the database wrote itself (now()) carry microseconds the wire format drops
      versionGuard = and({ col: 'modifiedOn', op: 'ge', value: have.toISOString() }, { col: 'modifiedOn', op: 'lt', value: new Date(have.getTime() + 1).toISOString() })
    }
    if (hasSystemColumn(def, 'modifiedOn')) raw.modifiedOn = new Date()
    const connector = await writableConnector(def)
    const rowGuard = guard && !('const' in guard) ? guard : undefined
    const n = await connector.update(def, id, raw, versionGuard ? (rowGuard ? and(rowGuard, versionGuard) : versionGuard) : rowGuard)
    if (n === 0) {
      // the version check passed a moment ago: someone saved in between
      if (versionGuard) {
        const now = await findRow(def, id)
        if (now) throw versionConflict(ctx, def, id, now)
      }
      throw (await readable()) ? new HttpError(403, 'denied', 'You are not allowed to change this row.') : new HttpError(404, 'not-found', 'Row not found.')
    }
    if (ledgers.length) await moveBalances(ledgers, balBefore, await deps.balances!()!.read(def, ledgers, [id]))
    if (removed.length) {
      const recs = (await meta().attachments.many(removed)).filter((a) => a.tableId === def.id && a.rowId === id)
      await removeAttachments(recs)
    }
    if (sys) await sys.afterWrite(ctx, def, 'update', { ...existing, ...raw }, existing)
    await markFileModified(def)
    await audit(ctx, 'row.update', def, id, { columns: Object.keys(raw).filter((k) => k !== 'modifiedOn') })
    changed(ctx, def, 'update', [id], Object.keys(raw))
    if (hooks) await hooks.outbox(ctx, def, { op: 'update', rowId: id, changed: Object.keys(raw).filter((k) => k !== 'modifiedOn'), before: existing, after: { ...existing, ...raw } })
    const after = (await findRow(def, id)) ?? { ...existing, ...raw }
    return rowOut(ctx, def, after)
  }

  /* ---------------------------------------------------------------- delete */

  /* ---------------------------------------------------------------- relationships (package K, docs/dev/data-model.md) */

  /**
   * ids of the live rows of `child` whose `column` points at one of `parents` (every row: integrity ignores security),
   * with the parent each points at (the recycle bin keeps it for set blank)
   */
  async function childIds(conn: Connector, child: TableDef, column: string, parents: string[], linkOf?: Map<string, string>): Promise<string[]> {
    const out: string[] = []
    for (let i = 0; i < parents.length; i += ID_CHUNK) {
      const res = await runSelect(conn, child, { where: { col: column, op: 'in', value: parents.slice(i, i + ID_CHUNK) }, select: linkOf ? ['id', column] : ['id'] })
      for (const r of res.rows) {
        out.push(String(r.id))
        if (linkOf) linkOf.set(String(r.id), String(r[column] ?? ''))
      }
    }
    return [...new Set(out)]
  }

  /**
   * The delete behaviour of every relationship whose parent is `def`, before the parent rows go:
   *  - restrict: 409 while any child row (readable or not) points at a parent being deleted;
   *  - cascade: the child rows are deleted with the caller's permissions (all or nothing: 403 when one of them may not be
   *    deleted by the caller, even an unreadable one), their own events, outbox rows and behaviours, depth at most 8;
   *  - setBlank: the lookup of the child rows is cleared as a system write (events and outbox rows as any update).
   * Rows of the same table that are being deleted together are not counted as children.
   */
  async function onParentDelete(ctx: UserContext | null, def: TableDef, targets: string[], cascade: Cascade): Promise<void> {
    const store = meta().relationships
    const rels = await childRelationships(def, () => meta().tables.list(), store ? (id) => store.toTable(id) : null)
    if (!rels.length) return
    const deleting = new Set(targets)
    for (const t of targets) cascade.seen.add(`${def.id}:${t}`)
    for (const r of rels) {
      const child = physical(r.child)
      const conn = await connectorFor(child)
      const linkOf = cascade.batch ? new Map<string, string>() : undefined
      let ids = await childIds(conn, child, r.column.name, targets, linkOf)
      if (child.id === def.id) ids = ids.filter((x) => !deleting.has(x))
      ids = ids.filter((x) => !cascade.seen.has(`${child.id}:${x}`))
      if (!ids.length) continue
      const what = `${ids.length} row${ids.length === 1 ? '' : 's'} in "${child.displayName || child.name}"`
      if (r.onDelete === 'restrict') {
        throw new HttpError(409, 'conflict', `This cannot be deleted: ${what} still ${ids.length === 1 ? 'refers' : 'refer'} to it (${r.column.displayName || r.column.name}). Delete or change ${ids.length === 1 ? 'that row' : 'those rows'} first.`, r.column.name, { relationship: { table: child.id, column: r.column.name, rows: ids.length, onDelete: 'restrict' } })
      }
      if (r.onDelete === 'cascade') {
        if (cascade.depth + 1 > MAX_CASCADE_DEPTH) throw new HttpError(409, 'conflict', `Deleting this would cascade through more than ${MAX_CASCADE_DEPTH} levels of related tables. Delete the deepest rows first.`)
        if (ctx) {
          const allowed = new Set(await matchingIds(conn, child, ids, ctx.rowPredicate(child, 'delete')))
          const refused = ids.filter((x) => !allowed.has(x)).length
          if (refused) throw new HttpError(403, 'denied', `Deleting this also deletes ${what} (${r.column.displayName || r.column.name}), and you are not allowed to delete ${refused === ids.length ? (ids.length === 1 ? 'it' : 'them') : `${refused} of them`}. Nothing was deleted.`)
        }
        await del(ctx, child, ids, { depth: cascade.depth + 1, seen: cascade.seen, batch: cascade.batch })
        continue
      }
      // set blank: a system write, the child rows stay without their parent (the recycle bin keeps the old value)
      for (const id of ids) {
        await update(null, child, id, { [r.column.name]: null })
        cascade.batch?.effects.push({ kind: 'setBlank', tableId: child.id, rowId: id, column: r.column.name, old: linkOf?.get(id) ?? null })
      }
    }
  }

  /** a self relationship with cycle prevention: the new parent's ancestors must not include the row itself */
  async function checkNoCycle(def: TableDef, col: ColumnDef, v: Cell, id: string): Promise<void> {
    if (v === null || v === '' || col.lookupTable?.toLowerCase() !== def.name.toLowerCase()) return
    const store = meta().relationships
    if (!store) return
    const guarded = await selfCycleColumns(def, () => store.list())
    if (!guarded.has(col.name)) return
    let cur: string | null = String(v)
    for (let i = 0; cur && i < 1000; i++) {
      if (cur === id) throw new HttpError(422, 'invalid', `${col.displayName || col.name}: this would make the row its own ancestor (a loop in the hierarchy).`, col.name)
      const row = await findRow(def, cur)
      const next = row?.[col.name]
      cur = next === null || next === undefined || next === '' ? null : String(next)
    }
  }

  /** ids (of `ids`) that match `where`; queried in chunks */
  async function matchingIds(connector: Connector, def: TableDef, ids: string[], where: Condition | undefined): Promise<string[]> {
    if (isConstFalse(where)) return []
    const out: string[] = []
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const inIds: Condition = { col: 'id', op: 'in', value: ids.slice(i, i + ID_CHUNK) }
      const res = await runSelect(connector, def, { where: isConstTrue(where) ? inIds : and(inIds, where), select: ['id'] })
      for (const r of res.rows) out.push(String(r.id))
    }
    return out
  }

  /**
   * All or nothing: the permission of EVERY target row is checked before anything is deleted (403 and no change when
   * one readable row may not be deleted), then the rows go in one connector call (PostgreSQL and MySQL: one transaction).
   */
  async function del(ctx: UserContext | null, table: TableDef, idsIn: string[], cascade: Cascade = { depth: 0, seen: new Set() }, source?: DeleteSource): Promise<number> {
    const def = physical(table)
    checkWritableTable(def)
    if (!Array.isArray(idsIn) || !idsIn.every((x) => typeof x === 'string')) throw new HttpError(422, 'invalid', 'ids must be a list of row ids.')
    const ids = [...new Set(idsIn.filter((x) => x && x.length <= 64))]
    if (!ids.length) return 0
    refuseBalanceWrite(ctx, def)
    const connector = await writableConnector(def)
    // recycle bin: the first table of the delete decides (its setting on: one batch for the whole operation; its
    // setting off: every row goes for good, as before). Cascaded tables keep their rows when they have a bin too.
    const binConn = await keepsDeleted(def)
    if (cascade.depth === 0 && binConn) cascade.batch = newBatch(def, ctx, source ?? deleteSourceOf(ctx))
    const soft = !!cascade.batch && !!binConn
    let guard: Condition | undefined
    let targets: string[]
    if (ctx) {
      const delPred = ctx.rowPredicate(def, 'delete')
      const readable = await matchingIds(connector, def, ids, ctx.rowPredicate(def, 'read'))
      targets = await matchingIds(connector, def, ids, delPred)
      const allowed = new Set(targets)
      const denied = readable.filter((x) => !allowed.has(x))
      if (denied.length) {
        const what = ids.length === 1 ? 'this row' : denied.length === 1 ? 'one of these rows' : `${denied.length} of these rows`
        throw new HttpError(403, 'denied', `You are not allowed to delete ${what}${ids.length > 1 ? ' (nothing was deleted)' : ''}.`)
      }
      if (!('const' in delPred)) guard = delPred
    } else {
      targets = await matchingIds(connector, def, ids, undefined)
    }
    // movements of a balance: locked before the delete; the rows that are gone afterwards leave the balance
    const ledgers = targets.length ? await ledgersOf(def) : []
    const balBefore = ledgers.length ? await deps.balances!()!.lock(def, ledgers, targets) : []
    // before-delete events (they may Reject); single deletes keep the whole row for the outbox and the after-events
    const hooks = deps.hooks?.()
    const keep: RawRow[] = []
    if (hooks && targets.length && (targets.length === 1 || (await hooks.hasBefore(def, 'delete')))) {
      const runEvents = await hooks.hasBefore(def, 'delete')
      for (let i = 0; i < targets.length; i += ID_CHUNK) {
        const chunk = (await runSelect(connector, def, { where: { col: 'id', op: 'in', value: targets.slice(i, i + ID_CHUNK) } })).rows
        for (const row of chunk) {
          if (runEvents) await hooks.beforeWrite(ctx, def, 'delete', row, row, null)
          if (targets.length === 1) keep.push(row)
        }
      }
    }
    // relationships (package K): restrict, cascade or set blank the child rows first (same unit of work)
    if (targets.length) await onParentDelete(ctx, def, targets, cascade)
    const batch = cascade.batch
    let total: number
    if (soft && batch) {
      // recycle bin: the rows stay, stamped with the batch; their attachments stay until the purge; shares and
      // collaboration rows are kept in the batch (restored with the rows)
      const gone = targets.length ? await binConn!.recycle!.softDelete(def, targets, { id: batch.id, by: batch.by, at: batch.at }, guard) : []
      total = gone.length
      if (cascade.depth === 0) batch.rootIds.push(...gone)
      for (const id of gone) batch.effects.push({ kind: 'row', tableId: def.id, rowId: id })
      if (gone.length && def.sharing) for (const sh of await deps.recycle!()!.takeShares(def.id, gone)) batch.effects.push({ kind: 'share', tableId: def.id, rowId: sh.rowId, old: sh.row })
      if (gone.length) await deps.system?.()?.afterDelete(def, gone, (e) => batch.effects.push(e))
    } else {
      total = targets.length ? await connector.delete(def, targets, guard) : 0
      // a cascade from a table with a recycle bin into one without: these rows cannot come back (restore says so)
      if (batch && total) for (const id of targets) batch.effects.push({ kind: 'final', tableId: def.id, rowId: id })
      if (targets.length) await removeAttachments(await meta().attachments.forRows(def.id, targets))
      if (targets.length && def.sharing) await meta().org?.shares.removeForRows(def.id, targets).catch((e) => deps.log('warn', `share cleanup failed: ${errText(e)}`))
      // polymorphic integrity: comments, activities, follows, tags, mentions and file links about these rows go too
      if (targets.length) await deps.system?.()?.afterDelete(def, targets)
    }
    if (total === 0 && ids.length === 1) throw new HttpError(404, 'not-found', 'Row not found.')
    if (ledgers.length && total > 0) {
      const left = new Set((await deps.balances!()!.read(def, ledgers, targets)).map((r) => String(r.id)))
      await moveBalances(ledgers, balBefore.filter((r) => !left.has(String(r.id))), [])
    }
    if (total > 0) {
      await markFileModified(def)
      const b = batch && soft ? { batch: batch.id } : {}
      await audit(ctx, 'row.delete', def, ids.length === 1 ? ids[0] : undefined, ids.length > 1 ? { ...auditIds(targets), deleted: total, ...b } : batch && soft ? b : undefined)
      changed(ctx, def, 'delete', targets, [])
      if (hooks) {
        if (targets.length === 1) await hooks.outbox(ctx, def, { op: 'delete', rowId: targets[0], before: keep[0] ?? { id: targets[0] }, snapshotColumns: 'all', ...(batch && soft ? { details: { batch: batch.id } } : {}) })
        else await hooks.outbox(ctx, def, { op: 'bulk', rowIds: targets, rowCount: total, details: { action: 'delete', ...b } })
      }
    }
    // the root of the operation writes the batch (after everything the delete did is known)
    if (cascade.depth === 0 && batch && batch.effects.some((e) => e.kind === 'row')) await deps.recycle!()!.save(batch)
    return total
  }

  /* ---------------------------------------------------------------- csv */

  async function importCsv(ctx: UserContext | null, table: TableDef, csv: string, mode: 'append' | 'replace', io: { actorId?: string } = {}): Promise<number> {
    const def = physical(table)
    checkWritableTable(def)
    if (typeof csv !== 'string') throw new HttpError(422, 'invalid', 'csv must be text.', 'csv')
    if (mode !== 'append' && mode !== 'replace') throw new HttpError(422, 'invalid', "mode must be 'append' or 'replace'.", 'mode')
    if (ctx && !ctx.canCreate(def)) throw cannotCreate(def)
    refuseBalanceWrite(ctx, def)
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
    // every row is built and checked before anything is written (nothing changes when one row is refused)
    const connector = await writableConnector(def)
    let targets: string[] = []
    let guard: Condition | undefined
    if (mode === 'replace') {
      // replace = delete the rows this caller may delete, then insert; rows outside the delete permission stay
      const pred = ctx ? ctx.rowPredicate(def, 'delete') : undefined
      if (!isConstFalse(pred)) {
        targets = (await runSelect(connector, def, { where: isConstTrue(pred) ? undefined : pred, select: ['id'] })).rows.map((r) => String(r.id))
        if (pred && !('const' in pred)) guard = pred
      }
    }
    const hooks = deps.hooks?.()
    if (hooks && targets.length && (await hooks.hasBefore(def, 'delete'))) {
      for (let i = 0; i < targets.length; i += ID_CHUNK) {
        for (const row of (await runSelect(connector, def, { where: { col: 'id', op: 'in', value: targets.slice(i, i + ID_CHUNK) } })).rows) {
          try {
            await hooks.beforeWrite(ctx, def, 'delete', row, row, null)
          } catch (e) {
            if (e instanceof HttpError) throw new HttpError(e.status, e.code, `Replacing the rows: ${e.message} (nothing was imported)`, e.field)
            throw e
          }
        }
      }
    }
    const replacing = new Set(targets)
    const batch: Batch = { ids: new Set(), unique: new Map() }
    const rows: RawRow[] = []
    for (let i = 0; i < records.length; i++) {
      try {
        rows.push(await buildRow(ctx, def, records[i], { preserve: true, conn: connector, replacing, batch, actorId: io.actorId }))
      } catch (e) {
        if (e instanceof HttpError) throw new HttpError(e.status, e.code, `Row ${i + 1}: ${e.message} (nothing was imported)`, e.field)
        throw e
      }
    }
    // SQL connectors: delete + inserts in one transaction. Connectors without transactions (files, Google Sheets): the delete
    // and the insert are separate writes (see docs/dev/connectors.md).
    // recycle bin: the replaced rows go to the bin as one batch (source import); their unique values are free at once
    const binConn = targets.length ? await keepsDeleted(def) : null
    const bin = binConn ? newBatch(def, ctx, 'import') : null
    const write = async (c: Connector) => {
      if (targets.length && bin) {
        const gone = await binConn!.recycle!.softDelete(def, targets, { id: bin.id, by: bin.by, at: bin.at }, guard)
        bin.rootIds.push(...gone)
        for (const id of gone) bin.effects.push({ kind: 'row', tableId: def.id, rowId: id })
      } else if (targets.length) await c.delete(def, targets, guard)
      if (rows.length) await c.insert(def, rows)
    }
    // movements of a balance: the replaced rows are locked first; one balance step for the whole import
    const ledgers = await ledgersOf(def)
    const balBefore = ledgers.length && targets.length ? await deps.balances!()!.lock(def, ledgers, targets) : []
    if (connector.capabilities.transactions && connector.transaction) await connector.transaction(write)
    else await write(connector)
    if (ledgers.length) {
      const left = new Set(targets.length ? (await deps.balances!()!.read(def, ledgers, targets)).map((r) => String(r.id)) : [])
      await moveBalances(ledgers, balBefore.filter((r) => !left.has(String(r.id))), rows)
    }
    if (targets.length && bin) {
      const gone = bin.rootIds
      if (gone.length && def.sharing) for (const sh of await deps.recycle!()!.takeShares(def.id, gone)) bin.effects.push({ kind: 'share', tableId: def.id, rowId: sh.rowId, old: sh.row })
      if (gone.length) await deps.system?.()?.afterDelete(def, gone, (e) => bin.effects.push(e))
      if (gone.length) await deps.recycle!()!.save(bin)
      await audit(ctx, 'row.delete', def, undefined, { ...auditIds(gone), import: true, batch: bin.id })
    } else if (targets.length) {
      await removeAttachments(await meta().attachments.forRows(def.id, targets))
      await deps.system?.()?.afterDelete(def, targets)
      await audit(ctx, 'row.delete', def, undefined, { ...auditIds(targets), import: true })
    }
    if (targets.length || rows.length) await markFileModified(def)
    const n = rows.length
    await audit(ctx, 'table.import', def, undefined, { mode, rows: n })
    if (targets.length || n) changed(ctx, def, 'import', [...targets, ...rows.map((r) => String(r.id))], [...new Set([...mapping.values()].map((c) => c.name))])
    if (hooks && targets.length) await hooks.outbox(ctx, def, { op: 'bulk', rowIds: targets, rowCount: targets.length, details: { action: 'delete', import: true, ...(bin ? { batch: bin.id } : {}) } })
    if (hooks && n) await hooks.outbox(ctx, def, { op: 'import', rowIds: rows.map((r) => String(r.id)), rowCount: n, changed: [...new Set([...mapping.values()].map((c) => c.name))], details: { mode } })
    return n
  }

  async function exportCsv(ctx: UserContext | null, table: TableDef): Promise<string> {
    const def = physical(table)
    const res = await doQuery(ctx, def, {}, EXPORT_CAP)
    const cols = visibleColumns(ctx, def).map((c) => c.name)
    // spreadsheet formula injection: text cells starting with = + - @ tab CR get a leading ' (numbers stay numbers)
    const data = res.rows.map((r) => cols.map((c) => csvExportText(r[c] ?? null)))
    return Papa.unparse({ fields: cols, data }, { newline: '\r\n' })
  }

  async function writeCells(ctx: UserContext | null, table: TableDef, rowId: string, changes: RawRow): Promise<number> {
    const def = physical(table)
    checkWritableTable(def)
    const guard = ctx ? ctx.rowPredicate(def, 'update') : undefined
    if (guard && 'const' in guard && !guard.const) return 0
    const connector = await connectorFor(def)
    if (guard && !isConstTrue(guard)) {
      const before = await findRow(def, rowId, guard, connector)
      if (!before) return 0
      if (!(await rowMatches(def, guard, { ...before, ...changes }))) {
        throw new HttpError(403, 'denied', 'You are not allowed to make this change: the row would no longer match the rows your role may change.')
      }
    }
    const n = await connector.update(def, rowId, hasSystemColumn(def, 'modifiedOn') ? { ...changes, modifiedOn: new Date() } : changes, guard && !('const' in guard) ? guard : undefined)
    if (n > 0) {
      await markFileModified(def)
      changed(ctx, def, 'update', [rowId], Object.keys(changes))
      await deps.hooks?.()?.outbox(ctx, def, { op: 'update', rowId, changed: Object.keys(changes), after: { id: rowId, ...changes } })
    }
    return n
  }

  /* ---------------------------------------------------------------- query v2 */

  const queryTimeoutMs = (() => {
    const n = Number(process.env.APPBUILDER_QUERY_TIMEOUT_MS)
    return Number.isFinite(n) && n >= 100 ? n : QUERY_TIMEOUT_MS
  })()

  /** every column of the physical table by formula kind (the plan is validated against all, CLS is checked after) */
  function schemaOf(def: TableDef): TableSchemaInfo {
    const columns: Record<string, ColumnKind> = {}
    const lookups: Record<string, string> = {}
    for (const c of allColumns(def)) {
      columns[c.name] = columnKind(c.type)
      if (c.type === 'lookup' && c.lookupTable) lookups[c.name] = c.lookupTable
    }
    return Object.keys(lookups).length ? { columns, lookups } : { columns }
  }

  const pad2 = (n: number, w = 2) => String(n).padStart(w, '0')
  /** a connector cell -> the formula value the reference executor expects (date cells at local midnight) */
  function fxCell(col: ColumnDef, v: Cell): FxRecord[string] {
    if (v === null || v === undefined) return null
    if (col.type === 'date' && v instanceof Date) return new Date(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate())
    return v as FxRecord[string]
  }
  function fxOut(type: ColumnDef['type'], v: unknown): QueryValue {
    if (v === null || v === undefined) return null
    if (type === 'date' && v instanceof Date) return `${pad2(v.getFullYear(), 4)}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`
    return cellOut({ name: '', displayName: '', type }, v)
  }

  /**
   * Fallback for connectors without SQL pushdown (MySQL external connections, data files, Google Sheets): read at most
   * QUERY_FALLBACK_ROW_CAP rows the caller may see (row filter pushed down where the connector can), run the plan with
   * the reference executor, flag `truncated` when the read hit the cap.
   */
  async function fallbackV2(connector: Connector, def: TableDef, plan: QueryPlan, rowFilter: Condition | undefined, visible: string[]): Promise<QueryV2Response> {
    const cols = allColumns(def)
    const read = await runSelect(connector, def, { where: rowFilter, top: QUERY_FALLBACK_ROW_CAP + 1 })
    const truncated = read.rows.length > QUERY_FALLBACK_ROW_CAP
    const rows: FxRecord[] = read.rows.slice(0, QUERY_FALLBACK_ROW_CAP).map((r) => {
      const o: FxRecord = {}
      for (const c of cols) o[c.name] = fxCell(c, r[c.name])
      return o
    })
    const schema = schemaOf(def)
    const agg = !!plan.aggregate
    const run = agg ? plan : { ...plan, select: undefined }
    let res
    try {
      res = executePlan(run, rows, schema, { inputOrder: !connector.capabilities.pushdown })
    } catch (e) {
      if (e instanceof PlanError || e instanceof CursorError) throw new HttpError(422, 'invalid', e.message)
      throw e
    }
    const out: QueryV2Response = { rows: [] }
    if (agg) {
      const a = plan.aggregate!
      const types = new Map<string, ColumnDef['type']>()
      for (const g of a.groupBy) types.set(a.as?.[g] ?? g, cols.find((c) => c.name === g)?.type ?? 'text')
      for (const b of a.buckets ?? []) types.set(b.name, bucketKind(b.unit) === 'date' ? 'date' : 'number')
      for (const m of a.measures) types.set(m.name, m.fn === 'count' || m.fn === 'countDistinct' ? 'number' : 'decimal')
      if (res.rows.length > QUERY_MAX_GROUPS) throw new HttpError(422, 'invalid', `This grouping produces more than ${QUERY_MAX_GROUPS.toLocaleString('en-US')} groups. Filter the rows first, or group by fewer distinct values.`)
      out.rows = res.rows.map((r) => {
        const o: Record<string, QueryValue> = {}
        for (const [k, v] of Object.entries(r)) o[k] = fxOut(types.get(k) ?? 'text', v)
        return o
      })
    } else {
      const names = [...new Set([...(plan.select ?? visible), ...(hasSystemColumn(def, 'id') ? ['id'] : [])])]
      const byName = new Map(cols.map((c) => [c.name, c]))
      if (!plan.page && !plan.single && res.rows.length > QUERY_MAX_UNPAGED_ROWS) {
        throw new HttpError(422, 'invalid', `This query returns more than ${QUERY_MAX_UNPAGED_ROWS.toLocaleString('en-US')} rows. Ask for it page by page (page: { size }), or filter it further.`)
      }
      out.rows = res.rows.map((r) => {
        const o: Record<string, QueryValue> = {}
        for (const n of names) o[n] = fxOut(byName.get(n)?.type ?? 'text', r[n] ?? null)
        return o
      })
    }
    if (res.count !== undefined) out.count = res.count
    if (plan.page) out.nextCursor = res.nextCursor ?? null
    if (truncated) out.truncated = true
    return out
  }

  async function queryV2(ctx: UserContext | null, table: TableDef, input: unknown, opts: { timeoutMs?: number } = {}): Promise<QueryV2Response> {
    const def = physical(table)
    let plan: QueryPlan
    let referenced: Set<string>
    let via: Map<string, Set<string>>
    // lookup paths (createdBy.FullName = "Asha"): only through a lookup column of this table to that table
    const all = await meta().tables.list()
    const targetOf = (name: string) => all.find((t) => t.name.toLowerCase() === name.toLowerCase() || t.id === name)
    const relatedDefs = new Map<string, TableDef>()
    try {
      const own = schemaOf(def)
      const checked = checkPlan(input, own, def.displayName || def.name, {
        related: (tname, col) => {
          if (own.lookups?.[col]?.toLowerCase() !== tname.toLowerCase()) return undefined
          const t = targetOf(tname)
          if (!t) return undefined
          relatedDefs.set(tname, physical(t))
          return schemaOf(physical(t))
        },
      })
      plan = checked.plan
      referenced = checked.columns
      via = checked.via
    } catch (e) {
      if (e instanceof PlanError) throw new HttpError(422, 'invalid', e.message)
      throw e
    }
    let related: Record<string, { def: TableDef; rowFilter?: Condition }> | undefined
    // P3-C: a sort through a lookup reads the target's column as the caller. A hidden column is refused in plain words
    // (sorting by it would order the rows by values the caller may not see); unreadable ROWS sort as blank (query-v2.md 5b)
    const lookupSorts = (plan.sort ?? []).filter((k) => k.via)
    for (const k of lookupSorts) {
      const t = relatedDefs.get(k.via!.table)!
      const shown = allColumns(def).find((c) => c.name === k.col)?.displayName || k.col
      if (ctx && ctx.columnAccess(t, k.via!.col) === 'none') {
        throw new HttpError(403, 'denied', `This list can't be sorted by ${shown}: you do not have access to the column "${t.displayName || t.name}.${k.via!.col}" it would be sorted by.`, k.col)
      }
      if ((t.connectionId || DEFAULT_CONNECTION_ID) !== (def.connectionId || DEFAULT_CONNECTION_ID)) {
        throw new HttpError(422, 'invalid', `This list can't be sorted by ${shown}: ${t.displayName || t.name} is stored in another connection, so the database can't sort by its names.`, k.col)
      }
    }
    for (const [tname, cols] of via) {
      const t = relatedDefs.get(tname)!
      if ((t.connectionId || DEFAULT_CONNECTION_ID) !== (def.connectionId || DEFAULT_CONNECTION_ID)) throw new HttpError(422, 'invalid', `${tname} is stored in another connection, so a condition through it cannot run in the database.`)
      if (ctx) {
        for (const name of cols) if (name !== 'id' && ctx.columnAccess(t, name) === 'none') throw new HttpError(403, 'denied', `You do not have access to the column "${tname}.${name}".`, name)
      }
      const pred = ctx ? ctx.rowPredicate(t, 'read') : undefined
      ;(related ??= {})[tname] = { def: t, ...(pred && !('const' in pred && pred.const) ? { rowFilter: pred } : {}) }
    }
    // column-level security: a hidden column may not be selected, filtered, sorted, searched, grouped or aggregated
    if (ctx) {
      for (const name of referenced) {
        if (name !== 'id' && ctx.columnAccess(def, name) === 'none') throw new HttpError(403, 'denied', `You do not have access to the column "${name}".`, name)
      }
    }
    const visible = visibleColumns(ctx, def).map((c) => c.name)
    let rowFilter: Condition | undefined
    if (ctx) {
      const pred = ctx.rowPredicate(def, 'read')
      if (!('const' in pred && pred.const)) rowFilter = pred
    }
    const connector = await connectorFor(def)
    if (!connector.queryV2) {
      // MySQL connections, data files and Google Sheets run plans over at most 5,000 rows (fallbackV2): a sort by a
      // lookup's names is refused there rather than computed over part of the rows or part of the targets
      if (lookupSorts.length) {
        const shown = allColumns(def).find((c) => c.name === lookupSorts[0]!.col)?.displayName || lookupSorts[0]!.col
        throw new HttpError(422, 'invalid', `This list can't be sorted by ${shown}: sorting by a lookup's names needs a table in a PostgreSQL database, and ${def.displayName || def.name} is stored in a connection that can't run that query.`, lookupSorts[0]!.col)
      }
      if (related) throw new HttpError(422, 'invalid', 'Conditions through a lookup column (Lookup.Column) need a table in a database connection.')
      return fallbackV2(connector, def, plan, rowFilter, visible)
    }
    const raw = await connector.queryV2(def, { plan, rowFilter, ...(related ? { related } : {}), visible, maxUnpagedRows: QUERY_MAX_UNPAGED_ROWS, maxGroups: QUERY_MAX_GROUPS, timeoutMs: opts.timeoutMs !== undefined ? Math.max(500, Math.min(queryTimeoutMs, opts.timeoutMs)) : queryTimeoutMs })
    const types = new Map(raw.columns.map((c) => [c.name, c.type]))
    const out: QueryV2Response = {
      rows: raw.rows.map((r) => {
        const o: Record<string, QueryValue> = {}
        for (const [k, v] of Object.entries(r)) o[k] = cellOut({ name: k, displayName: k, type: types.get(k) ?? 'text' }, v)
        return o
      }),
    }
    if (raw.count !== undefined) out.count = raw.count
    if (plan.page) out.nextCursor = raw.nextCursor ?? null
    return out
  }

  /* ---------------------------------------------------------------- recycle bin: restore, purge, Deleted view */

  const recycle = createRecycle({
    meta,
    get store() {
      const st = deps.recycle?.()
      if (!st) throw new HttpError(503, 'unavailable', 'The recycle bin needs the database.')
      return st
    },
    physical, connectorFor, unit,
    rowOut: (ctx, t, r) => rowOut(ctx, t, r),
    updateAsSystem: async (t, id, changes) => { await update(null, t, id, changes) },
    audit, removeAttachments, log: deps.log,
    outbox: async (ctx, t, e) => {
      // a restore brings movements of a balance back: their quantities count again (refused below the floor)
      if ((e.details as { action?: string } | undefined)?.action === 'restore' && e.rowIds.length) {
        const ledgers = await ledgersOf(physical(t))
        if (ledgers.length) await moveBalances(ledgers, [], await deps.balances!()!.read(physical(t), ledgers, e.rowIds))
      }
      await deps.hooks?.()?.outbox(ctx, t, e)
    },
    changed: (ctx, t, ids) => changed(ctx, t, 'insert', ids, []),
  })

  /** delete with the recycle bin's answer: how many rows, and the batch that can undo it (null: the delete was final) */
  async function deleteRows(ctx: UserContext | null, table: TableDef, ids: string[], opts: { source?: DeleteSource } = {}): Promise<{ deleted: number; batch: BatchInfo | null }> {
    const cascade: Cascade = { depth: 0, seen: new Set() }
    const deleted = await unit(table, () => del(ctx, table, ids, cascade, opts.source))
    const b = cascade.batch
    if (!b || !b.effects.some((e: Effect) => e.kind === 'row')) return { deleted, batch: null }
    const rows = b.effects.filter((e: Effect) => e.kind === 'row').length
    return {
      deleted,
      batch: {
        id: b.id, tableId: b.tableId, tableName: table.displayName || table.name, rows, rootIds: b.rootIds.slice(0, 1000), deletedBy: b.by, deletedByName: ctx?.user.name ?? null,
        deletedOn: b.at.toISOString(), expiresOn: b.expiresOn.toISOString(), daysLeft: b.keepDays, source: b.source, state: 'deleted', finalRows: b.effects.filter((e: Effect) => e.kind === 'final').length,
      },
    }
  }

  return {
    query: (ctx, table, q) => doQuery(ctx, table, q, DEFAULT_ROW_CAP),
    queryV2,
    deleteRows,
    restore: (ctx: UserContext | null, table: TableDef, input: { batch?: string; rowId?: string }): Promise<RestoreResult> => recycle.restore(ctx, table, input),
    recycle,
    // writes run as one unit of work each (kernel.ts): the change, its outbox row and the jobs it causes commit together
    insert: (ctx, table, values) => unit(table, () => insertOne(ctx, table, asObject(values, 'values'), { preserve: true })),
    update: (ctx, table, id, changes, opts) => unit(table, () => update(ctx, table, id, changes, opts)),
    delete: (ctx, table, ids) => unit(table, () => del(ctx, table, ids)),
    importCsv: (ctx, table, csv, mode, opts) => unit(table, () => importCsv(ctx, table, csv, mode, opts)),
    exportCsv,
    internals: {
      physical, connectorFor, findRow: (t, id, guard, opts) => findRow(t, id, guard, undefined, opts?.rows), rowOut: (ctx, t, r) => rowOut(ctx, physical(t), r),
      writeCells: (ctx, t, rowId, changes) => unit(t, () => writeCells(ctx, t, rowId, changes)),
      removeAttachments, markFileModified,
    },
  }
}
