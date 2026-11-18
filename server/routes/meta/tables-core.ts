/**
 * Table plumbing shared by the tables, files, packages, connections, seed and migration modules:
 * connection resolution, physical source names, default privileges, registering and unregistering tables,
 * row import/export through the DataService (system context).
 */
import type { ColumnDef, ConnectionRef, TableDef, TablePrivilege } from '../../../src/platform/contracts.ts'
import { DEFAULT_ROW_CAP } from '../../../src/platform/http.ts'
import type { QueryValue } from '../../../src/platform/http.ts'
import { HttpError } from '../../core/contracts.ts'
import type { Connector, ConnectionRecord, Ctx, Services, UserContext } from '../../core/contracts.ts'
import { clone, conflict, csvCellToJson, invalid, isObj, notFound, parseCsvText } from './util.ts'
import { errText, log } from '../../core/util.ts'
import type { RoleX } from './util.ts'

export const FILES_CONNECTION_ID = 'conn_files'

/* ------------------------------------------------------------------ lookups */

export async function requireTable(s: Services, idOrName: string): Promise<TableDef> {
  const t = await s.meta.tables.get(idOrName)
  if (!t) throw notFound(`Table "${idOrName}" was not found.`)
  return t
}

export function resolver(tables: TableDef[]): (name: string) => string | undefined {
  const byLower = new Map(tables.map((t) => [t.name.toLowerCase(), t.name]))
  return (name) => byLower.get(name.toLowerCase())
}

export function toRef(rec: ConnectionRecord): ConnectionRef {
  const { secret, ...rest } = rec
  const ref: ConnectionRef = { ...rest, settings: { ...(rest.settings ?? {}) } }
  ref.hasSecret = typeof secret === 'string' && secret !== '' ? true : (rec.hasSecret ?? false)
  return ref
}

/** the files connection exists once per workspace; created on demand when the core did not create it */
export async function ensureFilesConnection(s: Services): Promise<ConnectionRecord> {
  const have = await s.meta.connections.get(FILES_CONNECTION_ID)
  if (have) return have
  const rec: ConnectionRecord = {
    id: FILES_CONNECTION_ID, name: 'Data files', connector: 'files', status: 'connected', settings: {},
    isDefault: false, scope: 'device',
  }
  await s.meta.connections.upsert(rec)
  return rec
}

export async function resolveConnection(s: Services, connectionId?: string): Promise<{ record: ConnectionRecord; connector: Connector }> {
  const id = connectionId || (await s.connections.defaultId())
  if (id === FILES_CONNECTION_ID) await ensureFilesConnection(s)
  const record = await s.meta.connections.get(id)
  if (!record) throw notFound(`Connection "${id}" was not found.`)
  let connector: Connector
  try {
    connector = await s.connections.get(id)
  } catch (e) {
    throw new HttpError(503, 'unavailable', `The connection "${record.name}" is not available: ${(e as Error).message}`)
  }
  return { record, connector }
}

/* ------------------------------------------------------------------ physical names */

export function defaultSource(kind: string, name: string): string {
  if (kind === 'mysql') return `t_${name.toLowerCase()}`.slice(0, 64)
  return name
}

/** a physical name not used by any registered table on the connection or present in the source */
export async function pickSource(s: Services, record: ConnectionRecord, connector: Connector, name: string): Promise<string> {
  const taken = new Set<string>()
  for (const t of await s.meta.tables.list()) if (t.connectionId === record.id && t.source) taken.add(t.source.toLowerCase())
  try {
    for (const t of await connector.listSourceTables()) taken.add(t.source.toLowerCase())
  } catch {
    /* an unreachable source fails later with a clearer message */
  }
  const base = defaultSource(record.connector, name)
  let cand = base
  let i = 2
  while (taken.has(cand.toLowerCase())) {
    const suffix = `_${i++}`
    cand = base.slice(0, 64 - suffix.length) + suffix
  }
  return cand
}

/* ------------------------------------------------------------------ privileges */

const READ_ONLY = (p: TablePrivilege) => !p.create && p.read === 'all' && p.update === 'none' && p.delete === 'none'
const FULL = (p: TablePrivilege) => p.create && p.read === 'all' && p.update === 'all' && p.delete === 'all'

/** Maker roles get full access, Viewer-like roles read, all others none (phase-2 rule). */
export function defaultPrivilegeFor(role: RoleX, tableId: string, readOnlyTable: boolean): TablePrivilege {
  const ps = role.privileges
  let kind: 'full' | 'read' | 'none' = 'none'
  if (role.isMaker || (ps.length > 0 && ps.every(FULL))) kind = 'full'
  else if (role.name.toLowerCase() === 'viewer' || (ps.length > 0 && ps.every(READ_ONLY))) kind = 'read'
  if (kind === 'full' && !readOnlyTable) return { table: tableId, create: true, read: 'all', update: 'all', delete: 'all' }
  if (kind === 'none') return { table: tableId, create: false, read: 'none', update: 'none', delete: 'none' }
  return { table: tableId, create: false, read: 'all', update: 'none', delete: 'none' }
}

export async function grantDefaults(s: Services, tables: TableDef[]): Promise<void> {
  for (const role of (await s.meta.roles.list()) as RoleX[]) {
    if (role.isAdmin) continue
    const next = [...role.privileges]
    let changed = false
    for (const t of tables) {
      if (next.some((p) => p.table === t.id)) continue
      next.push(defaultPrivilegeFor(role, t.id, t.readOnly === true))
      changed = true
    }
    if (changed) await s.meta.roles.upsert({ ...role, privileges: next } as RoleX)
  }
  s.security.invalidate()
}

/* ------------------------------------------------------------------ registering */

/** creates the physical table, stores the definition and grants default privileges; rolls back the DDL on failure */
/**
 * Did Appbuilder create this table's physical source (so it may drop it, and remove its columns)? Linked tables existed
 * before and belong to someone else: Appbuilder only unregisters them. File tables live in Appbuilder's own copy.
 */
export const isPlatformManaged = (def: TableDef): boolean => def.managed === true || def.origin?.kind === 'file'

export async function createPhysical(s: Services, record: ConnectionRecord, connector: Connector, def: TableDef): Promise<void> {
  if (!connector.capabilities.ddl) throw invalid(`The connection "${record.name}" cannot create tables.`)
  def.managed = true
  try {
    await connector.createTable(def)
  } catch (e) {
    throw friendly(e, `Could not create the table in "${record.name}"`)
  }
  try {
    await s.meta.tables.upsert(def)
    await grantDefaults(s, [def])
  } catch (e) {
    await connector.dropTable(def).catch(() => {})
    await s.meta.tables.remove(def.id).catch(() => {})
    throw e
  }
}

/** HttpErrors pass through; anything else becomes a 422 with the (already user-safe) connector message */
export function friendly(e: unknown, prefix: string): Error {
  if (e && typeof e === 'object' && 'status' in e && 'code' in e) return e as unknown as Error
  const msg = e instanceof Error ? e.message : String(e)
  return invalid(`${prefix}: ${msg}`)
}

/** removes a table's registration: role privileges, solution components, data file link. Does not touch the source. */
export async function unregisterTable(s: Services, def: TableDef): Promise<void> {
  for (const role of (await s.meta.roles.list()) as RoleX[]) {
    if (role.privileges.some((p) => p.table === def.id)) {
      await s.meta.roles.upsert({ ...role, privileges: role.privileges.filter((p) => p.table !== def.id) } as RoleX)
    }
  }
  const now = s.now()
  for (const sol of await s.meta.solutions.list()) {
    if (sol.components.some((c) => c.kind === 'table' && c.id === def.id)) {
      await s.meta.solutions.upsert({ ...sol, components: sol.components.filter((c) => !(c.kind === 'table' && c.id === def.id)), modifiedOn: now })
    }
  }
  if (def.origin?.kind === 'file') {
    const f = await s.meta.files.get(def.origin.fileId)
    if (f && f.tableIds.includes(def.id)) {
      const full = f as typeof f & { storageKey: string; originalName: string }
      await s.meta.files.upsert({ ...full, tableIds: f.tableIds.filter((x) => x !== def.id) })
    }
  }
  await s.meta.tables.remove(def.id)
  s.security.invalidate()
}

export async function lookupReferrers(s: Services, def: TableDef): Promise<TableDef[]> {
  return (await s.meta.tables.list()).filter(
    (t) => t.id !== def.id && t.columns.some((c) => c.type === 'lookup' && c.lookupTable?.toLowerCase() === def.name.toLowerCase()),
  )
}

/* ------------------------------------------------------------------ rows (system context) */

/** every row the context may read, paged */
export async function queryAll(s: Services, ctx: UserContext | null, def: TableDef): Promise<Record<string, QueryValue>[]> {
  const out: Record<string, QueryValue>[] = []
  const ordered = (!ctx || ctx.columnAccess(def, 'createdOn') !== 'none') && !(def.missingSystem ?? []).includes('createdOn')
  let skip = 0
  for (;;) {
    const r = await s.data.query(ctx, def, { top: DEFAULT_ROW_CAP, skip, ...(ordered ? { orderBy: [{ col: 'createdOn', dir: 'asc' as const }] } : {}) })
    out.push(...r.rows)
    if (r.rows.length < DEFAULT_ROW_CAP) break
    skip += r.rows.length
  }
  return out
}

/** CSV text -> JSON rows keyed by column name (headers match name or display name, case-insensitive) */
export function csvToRows(def: TableDef, csv: string): Record<string, QueryValue>[] {
  const { headers, records } = parseCsvText(csv)
  const map = new Map<string, ColumnDef>()
  for (const h of headers) {
    const col =
      def.columns.find((c) => c.name === h) ??
      def.columns.find((c) => c.name.toLowerCase() === h.toLowerCase()) ??
      def.columns.find((c) => c.displayName.toLowerCase() === h.toLowerCase())
    if (col && !map.has(h) && ![...map.values()].includes(col)) map.set(h, col)
  }
  return records.map((rec) => {
    const row: Record<string, QueryValue> = {}
    for (const [h, col] of map) {
      const v = csvCellToJson(col, rec[h] ?? '')
      if (v !== null) row[col.name] = v
    }
    return row
  })
}

export interface TableRows { def: TableDef; rows: Record<string, QueryValue>[] }

const lc = (s: string) => s.toLowerCase()

/**
 * Inserts rows into freshly created tables as system, keeping ids. Tables are processed in lookup order;
 * lookups to a table that is not populated yet (cycles, self references) are filled in afterwards.
 */
export async function importRowsSystem(s: Services, items: TableRows[], actorId?: string): Promise<number> {
  const names = new Set(items.map((i) => lc(i.def.name)))
  const remaining = [...items]
  const order: TableRows[] = []
  while (remaining.length) {
    const idx = remaining.findIndex((it) =>
      it.def.columns.every((c) => c.type !== 'lookup' || !c.lookupTable || lc(c.lookupTable) === lc(it.def.name) || !remaining.some((o) => o !== it && lc(o.def.name) === lc(c.lookupTable!))))
    order.push(...remaining.splice(idx < 0 ? 0 : idx, 1))
  }
  const populated = new Set<string>()
  const later: { def: TableDef; id: string; changes: Record<string, QueryValue> }[] = []
  let total = 0
  for (const it of order) {
    const lazy = it.def.columns.filter((c) => c.type === 'lookup' && c.lookupTable && (lc(c.lookupTable) === lc(it.def.name) || (names.has(lc(c.lookupTable)) && !populated.has(lc(c.lookupTable)))))
    for (const [i, row0] of it.rows.entries()) {
      const row = { ...row0 }
      // imported on behalf of a user: that user created and owns the rows (package values are not kept)
      if (actorId) {
        row.createdBy = actorId
        row.owner = actorId
      }
      const id = typeof row.id === 'string' ? row.id : undefined
      const changes: Record<string, QueryValue> = {}
      for (const c of lazy) {
        if (row[c.name] !== undefined && id) {
          changes[c.name] = row[c.name]
          delete row[c.name]
        }
      }
      try {
        await s.data.insert(null, it.def, row)
      } catch (e) {
        throw invalid(`Table "${it.def.displayName}", row ${i + 1}: ${e instanceof Error ? e.message : String(e)}`)
      }
      if (id && Object.keys(changes).length) later.push({ def: it.def, id, changes })
      total++
    }
    populated.add(lc(it.def.name))
  }
  for (const u of later) {
    try {
      await s.data.update(null, u.def, u.id, u.changes)
    } catch {
      /* a lookup to a row that is not part of the import stays blank */
    }
  }
  return total
}

export function plainTableDef(def: TableDef): TableDef {
  const c = clone(def)
  delete c.connectionId
  delete c.source
  delete c.readOnly
  delete c.origin
  delete c.managed
  delete c.missingSystem
  return c
}

export { conflict, isObj }
export const needCtx = (ctx: Ctx): UserContext => {
  if (!ctx.user) throw invalid('Not signed in.')
  return ctx.user
}

/** audit entry for a metadata change by the signed-in user (never put secrets or passwords in details) */
export async function audit(s: Services, ctx: Ctx | null, action: string, details?: unknown, tableId?: string): Promise<void> {
  try {
    await s.meta.audit({ userId: ctx?.user?.user.id ?? null, action, ...(tableId ? { tableId } : {}), ...(details !== undefined ? { details } : {}) })
  } catch (e) {
    // auditing must never break the operation, but a lost entry is always reported on the console
    log('error', `audit write failed (${action}): ${errText(e)}`)
  }
}
