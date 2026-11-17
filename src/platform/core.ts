/**
 * The platform core: createPlatform(storage) returns a PlatformApi. No React, no DOM; the browser
 * singleton (index.ts) and the unit tests both use this factory.
 *
 * SECURITY NOTE: role security here is a single-machine SIMULATION. It decides what the *current
 * user* (chosen in the portal) may see and change inside apps, but everything lives in files the
 * person at the keyboard can open, so it is NOT a server-side security boundary.
 */
import type { AppDef, FxRecord, FxValue } from '@/contracts'
import { PlatformError } from './contracts'
import type {
  AccessScope, AppMeta, AttachmentRef, ColumnAccess, ColumnDef, ColumnType, ConnectionRef, ConnectorKind, DataFileDef, DataOp,
  EffectivePrivileges, PlatformApi, RoleDef, Row, Session, SolutionComponentKind, SolutionDef, StorageAdapter, TableDef,
  TablePrivilege, UserDef, WorkspaceState,
} from './contracts'
import Papa from 'papaparse'
import { matchesCondition } from './rowfilter'
import { csvToRows, parseCsvText, rowsToCsv } from './csv'
import { Persister } from './persister'
import { MemoryStorage } from './storage'
import {
  CONTACT_STATUSES, ORDER_STATUSES, SEED_CONTACTS, SEED_ORDERS, blankApp, contactsSampleApp,
} from './samples'
import {
  IDENT, SYSTEM_COLUMNS, SYSTEM_NAMES, coerceValue, defaultValue, fromYaml, inferType, isBlankValue,
  serializeValue, shortId, toIdentifier, toYaml, uniqueIdentifier, uniqueKey, uniqueLabel, uuid,
} from './values'

export type StorageSource = StorageAdapter | (() => Promise<StorageAdapter>)

export interface PlatformOptions {
  now?: () => Date
  /** CSV/workspace write debounce, ms (default 300) */
  debounceMs?: number
  /** a debounced write is forced after this long, ms (default 3000) */
  maxWaitMs?: number
  /** called when a background write fails (default: console.warn) */
  onStorageError?: (e: unknown) => void
}

const COLUMN_TYPES: ColumnType[] = [
  'text', 'multiline', 'email', 'url', 'phone', 'number', 'decimal', 'currency',
  'boolean', 'date', 'datetime', 'choice', 'lookup', 'image', 'autonumber', 'file',
]
const CONNECTORS: ConnectorKind[] = ['local-csv', 'rest', 'postgres', 'mysql', 'sqlserver', 'supabase', 'firebase', 'excel', 'files', 'gsheets', 'php-gateway']
const KINDS: SolutionComponentKind[] = ['app', 'table', 'role', 'connection', 'file']
const NEEDS_SERVER = 'This needs the local server.'
const colRank: Record<ColumnAccess, number> = { none: 0, read: 1, update: 2 }

const fail = (code: PlatformError['code'], message: string): never => {
  throw new PlatformError(code, message)
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const clone = <T>(v: T): T => structuredClone(v)
const rank: Record<AccessScope, number> = { none: 0, own: 1, all: 2 }

interface TableRt {
  def: TableDef
  rows: Row[]
  /** highest autonumber issued per column (so deleting the last row does not reuse its number in a session) */
  counters: Map<string, number>
}

interface Ctx {
  userId: string
  now: Date
}

export function createPlatform(source: StorageSource, options: PlatformOptions = {}): PlatformApi {
  const nowFn = options.now ?? (() => new Date())
  let storage: StorageAdapter | null = typeof source === 'function' ? null : source
  const persister = new Persister(options.debounceMs ?? 300, options.maxWaitMs ?? 3000, (e) => {
    if (options.onStorageError) options.onStorageError(e)
    else console.warn('[platform] background write failed:', e)
  })

  let state: WorkspaceState = {
    ready: false,
    mode: 'demo',
    setup: { needsDatabase: false, needsAdmin: false },
    session: null,
    storage: { kind: storage?.kind ?? 'browser', location: storage?.location ?? 'Loading…' },
    apps: [], tables: [], roles: [], users: [], currentUserId: '', connections: [], solutions: [], dataFiles: [],
    dataVersion: 0, loading: [], truncated: [],
  }
  /** attachments (demo mode): metadata + data URL, mirrored in storage under attachments/<id>.json */
  const attachmentStore = new Map<string, AttachmentRef & { dataUrl: string }>()
  const listeners = new Set<() => void>()
  const tablesRt = new Map<string, TableRt>() // by table id
  const appDefs = new Map<string, AppDef>() // by app id
  let initPromise: Promise<void> | null = null

  /* ------------------------------------------------------------------ state plumbing */

  const emit = () => {
    for (const l of [...listeners]) {
      try {
        l()
      } catch (e) {
        console.error('[platform] listener failed', e)
      }
    }
  }
  const setState = (patch: Partial<WorkspaceState>, bumpData = false) => {
    state = { ...state, ...patch, dataVersion: bumpData ? state.dataVersion + 1 : state.dataVersion }
    // the run-as user, roles or tables changed: recompute what that user sees (CLS) and their effective privileges
    if (patch.users || patch.roles || patch.tables || patch.currentUserId !== undefined) {
      if (!patch.tables) state = { ...state, tables: visibleTables() }
      state = { ...state, session: computeSession() }
    }
    emit()
  }
  const st = (): StorageAdapter => storage ?? fail('storage', 'The workspace is not initialised yet.')

  const sortTables = (ts: TableDef[]) => [...ts].sort((a, b) => a.displayName.localeCompare(b.displayName))
  const sortApps = (as: AppMeta[]) => [...as].sort((a, b) => b.modifiedOn.localeCompare(a.modifiedOn) || a.name.localeCompare(b.name))
  const syncTables = (bumpData = true) => setState({ tables: visibleTables() }, bumpData)
  const iso = () => nowFn().toISOString()
  const ctx = (): Ctx => ({ userId: state.currentUserId, now: nowFn() })
  const userName = () => state.users.find((u) => u.id === state.currentUserId)?.name ?? 'Unknown'

  /* ------------------------------------------------------------------ persistence */

  const wsKey = 'workspace'
  const writeWorkspace: () => Promise<void> = async () => {
    await st().writeText(
      'workspace.yaml',
      toYaml({
        formatVersion: 1,
        currentUserId: state.currentUserId,
        users: state.users,
        roles: state.roles,
        connections: state.connections,
        solutions: state.solutions,
        dataFiles: state.dataFiles,
      }),
    )
  }
  const saveWorkspace = () => persister.now(wsKey, writeWorkspace)
  const saveWorkspaceLater = () => persister.schedule(wsKey, writeWorkspace)
  /** a write through an app to a table that came from a data file marks that file as modified since import */
  function markFileModified(def: TableDef) {
    const fileId = def.origin?.fileId
    if (!fileId) return
    const f = state.dataFiles.find((x) => x.id === fileId)
    if (!f || f.modifiedSinceImport) return
    state = { ...state, dataFiles: state.dataFiles.map((x) => (x.id === fileId ? { ...x, modifiedSinceImport: true } : x)) }
    saveWorkspaceLater()
  }

  const findTableByName = (name: string): TableRt | undefined => {
    for (const t of tablesRt.values()) if (t.def.name === name) return t
    return undefined
  }
  const tableKey = (name: string) => `tbl:${name}`
  const tableWriter = (name: string): (() => Promise<void>) => async () => {
    const t = findTableByName(name)
    if (t) {
      await st().writeText(`tables/${name}.schema.yaml`, toYaml(t.def))
      await st().writeText(`tables/${name}.csv`, rowsToCsv(t.def.columns, t.rows))
    } else {
      await st().remove(`tables/${name}.schema.yaml`)
      await st().remove(`tables/${name}.csv`)
    }
  }
  const saveTable = (name: string) => persister.now(tableKey(name), tableWriter(name))
  const saveTableLater = (name: string) => persister.schedule(tableKey(name), tableWriter(name))

  const appKey = (id: string) => `app:${id}`
  const appWriter = (id: string): (() => Promise<void>) => async () => {
    const meta = state.apps.find((a) => a.id === id)
    const def = appDefs.get(id)
    if (meta && def) await st().writeText(`apps/${id}.app.yaml`, toYaml({ formatVersion: 1, meta, definition: def }))
    else await st().remove(`apps/${id}.app.yaml`)
  }
  const saveApp = (id: string) => persister.now(appKey(id), appWriter(id))

  /* ------------------------------------------------------------------ lookups */

  const findTable = (nameOrId: string): TableRt | undefined => {
    const byId = tablesRt.get(nameOrId)
    if (byId) return byId
    const exact = findTableByName(nameOrId)
    if (exact) return exact
    const low = nameOrId.toLowerCase()
    for (const t of tablesRt.values()) if (t.def.name.toLowerCase() === low) return t
    return undefined
  }
  const needTable = (nameOrId: string): TableRt => findTable(nameOrId) ?? fail('not-found', `Table "${nameOrId}" was not found.`)
  const tableNames = () => [...tablesRt.values()].map((t) => t.def.name)

  /* ------------------------------------------------------------------ security (single-machine simulation) */

  const currentUser = (): UserDef => state.users.find((u) => u.id === state.currentUserId) ?? state.users[0]
  const rolesOf = (u: UserDef): RoleDef[] => state.roles.filter((r) => u.roleIds.includes(r.id))

  interface Grant {
    create: boolean
    read: AccessScope
    update: AccessScope
    delete: AccessScope
    /** effective CLS: only columns that are not 'update' */
    columns: Record<string, ColumnAccess>
    /** a granting role carries a rowFilter */
    filtered: boolean
  }
  const NO_GRANT = (): Grant => ({ create: false, read: 'none', update: 'none', delete: 'none', columns: {}, filtered: false })

  /** broadest privilege across the user's roles (RBAC), with the union CLS; admin = everything */
  function grantFor(u: UserDef | undefined, def: TableDef): Grant {
    if (!u) return NO_GRANT()
    const rs = rolesOf(u)
    if (rs.some((r) => r.isAdmin)) return { create: true, read: 'all', update: 'all', delete: 'all', columns: {}, filtered: false }
    const out = NO_GRANT()
    const readers: (TablePrivilege | undefined)[] = []
    for (const r of rs) {
      const p = r.privileges.find((x) => x.table === def.id)
      if (!p) continue
      if (p.create) out.create = true
      for (const op of ['read', 'update', 'delete'] as const) if (rank[p[op]] > rank[out[op]]) out[op] = p[op]
      if (p.read !== 'none') {
        readers.push(p)
        if (p.rowFilter && p.rowFilter.length) out.filtered = true
      }
    }
    if (readers.length) {
      for (const col of def.columns) {
        let best: ColumnAccess = 'none'
        for (const p of readers) {
          const a: ColumnAccess = p?.columns?.[col.name] ?? 'update'
          if (colRank[a] > colRank[best]) best = a
        }
        if (best !== 'update') out.columns[col.name] = best
      }
    }
    return out
  }
  const privilege = (def: TableDef): Grant => grantFor(currentUser(), def)
  const isAdminNow = () => {
    const u = currentUser()
    return !!u && rolesOf(u).some((r) => r.isAdmin)
  }

  /**
   * Row-level check for the current user: OR over roles that grant `op` of
   * (scope all ? true : owner == me) AND every rowFilter condition. A filter on a column the table no
   * longer has makes that role grant nothing (server semantics).
   */
  function rowTester(def: TableDef, op: 'read' | 'update' | 'delete'): (row: Row) => boolean {
    const u = currentUser()
    if (!u) return () => false
    const rs = rolesOf(u)
    if (rs.some((r) => r.isAdmin)) return () => true
    const me = { id: u.id, email: u.email }
    const colNames = new Set(def.columns.map((c) => c.name))
    const grants: { scope: AccessScope; filter: NonNullable<TablePrivilege['rowFilter']> }[] = []
    for (const r of rs) {
      const p = r.privileges.find((x) => x.table === def.id)
      if (!p || p[op] === 'none') continue
      const filter = p.rowFilter ?? []
      if (filter.some((c) => !colNames.has(c.column))) continue
      grants.push({ scope: p[op], filter })
    }
    return (row) =>
      grants.some((g) => (g.scope === 'all' || row.owner === me.id) && g.filter.every((c) => matchesCondition(c, row, me)))
  }

  function can(tableName: string, op: DataOp, row?: Row): boolean {
    const t = findTable(tableName)
    if (!t) return false
    const p = privilege(t.def)
    if (op === 'create') return p.create
    if (p[op] === 'none') return false
    if (!row) return true
    return rowTester(t.def, op)(row)
  }

  const deny = (op: DataOp, t: TableRt): never =>
    fail('denied', `${currentUser()?.name ?? 'This user'} is not allowed to ${op} rows in "${t.def.displayName}".`)

  const hiddenColumns = (g: Grant): string[] => Object.keys(g.columns).filter((k) => g.columns[k] === 'none')
  function stripColumns(row: Row, hidden: string[]): Row {
    if (!hidden.length) return row
    const out: Row = { ...row }
    for (const h of hidden) delete out[h]
    return out
  }
  /** a column the current user may not write (CLS read/none) -> denied */
  function assertWritable(rt: TableRt, g: Grant, keys: Iterable<string>) {
    for (const k of keys) {
      const col = rt.def.columns.find((c) => c.name === k)
      if (!col || col.system || col.type === 'autonumber') continue
      const a = g.columns[k] ?? 'update'
      if (a !== 'update') fail('denied', `${col.displayName} is ${a === 'read' ? 'read-only' : 'not available'} for ${currentUser()?.name ?? 'this user'}.`)
    }
  }
  const writtenKeys = (def: TableDef, values: FxRecord): string[] => {
    const out: string[] = []
    for (const k of Object.keys(values)) {
      if (k === '__id') continue
      const c = findColumn(def, k)
      if (c) out.push(c.name)
    }
    return out
  }

  /** the TableDef as the current user sees it: CLS 'none' columns removed (admins see everything) */
  function visibleDef(def: TableDef): TableDef {
    const hidden = hiddenColumns(privilege(def))
    if (!hidden.length) return def
    const columns = def.columns.filter((c) => !hidden.includes(c.name))
    const primaryColumn = columns.some((c) => c.name === def.primaryColumn) ? def.primaryColumn : (columns.find((c) => !c.system)?.name ?? 'id')
    return { ...def, columns, primaryColumn }
  }
  function visibleTables(): TableDef[] {
    return sortTables([...tablesRt.values()].map((t) => visibleDef(t.def)))
  }

  function computeSession(): Session | null {
    const user = currentUser()
    if (!user) return null
    const rs = rolesOf(user)
    const isAdmin = rs.some((r) => r.isAdmin)
    const tables: EffectivePrivileges['tables'] = {}
    for (const rt of tablesRt.values()) {
      const g = grantFor(user, rt.def)
      tables[rt.def.id] = { create: g.create, read: g.read, update: g.update, delete: g.delete, columns: g.columns, filtered: g.filtered }
    }
    const allTables = [...tablesRt.values()]
    const fullEverywhere = allTables.length > 0 && allTables.every((rt) => {
      const g = tables[rt.def.id]
      return g.create && g.read === 'all' && g.update === 'all' && g.delete === 'all'
    })
    const apps: EffectivePrivileges['apps'] = isAdmin || rs.some((r) => r.apps === 'all') ? 'all' : [...new Set(rs.flatMap((r) => (Array.isArray(r.apps) ? r.apps : [])))]
    const privileges: EffectivePrivileges = {
      isAdmin, isMaker: isAdmin || rs.some((r) => r.isMaker === true || r.name.toLowerCase() === 'maker') || fullEverywhere, tables, apps,
    }
    return { user, privileges, expiresOn: new Date(nowFn().getTime() + 365 * 86_400_000).toISOString() }
  }

  /** after a role/user change there must still be a user with an admin role */
  function assertAdminRemains(users: UserDef[], roles: RoleDef[]) {
    const adminRoleIds = new Set(roles.filter((r) => r.isAdmin).map((r) => r.id))
    if (!users.some((u) => u.roleIds.some((id) => adminRoleIds.has(id)))) {
      fail('conflict', 'At least one user must keep an administrator role.')
    }
  }

  /* ------------------------------------------------------------------ row engine */

  const findColumn = (def: TableDef, name: string): ColumnDef | undefined =>
    def.columns.find((c) => c.name === name) ?? def.columns.find((c) => c.name.toLowerCase() === name.toLowerCase())

  const pad = (n: number) => String(n).padStart(4, '0')

  function autonumberMax(def: TableDef, col: ColumnDef, rows: Row[]): number {
    const prefix = col.prefix ?? ''
    let max = 0
    for (const r of rows) {
      const v = r[col.name]
      if (typeof v !== 'string' || !v.startsWith(prefix)) continue
      const n = Number(v.slice(prefix.length))
      if (Number.isFinite(n) && n > max) max = n
    }
    void def
    return max
  }
  function nextAutonumber(def: TableDef, col: ColumnDef, rows: Row[], counters: Map<string, number>): string {
    const n = Math.max(counters.get(col.name) ?? 0, autonumberMax(def, col, rows)) + 1
    counters.set(col.name, n)
    return `${col.prefix ?? ''}${pad(n)}`
  }

  function lookupRowsFor(def: TableDef, col: ColumnDef, selfRows: Row[]): Row[] | null {
    if (!col.lookupTable) return null
    if (col.lookupTable === def.name) return selfRows
    return findTable(col.lookupTable)?.rows ?? null
  }

  function checkUnique(col: ColumnDef, value: FxValue, rows: Row[], exceptId?: string) {
    if (!col.unique || value === null) return
    const key = uniqueKey(value)
    for (const r of rows) {
      if (r.id === exceptId) continue
      const other = r[col.name]
      if (other !== null && other !== undefined && uniqueKey(other) === key) {
        fail('invalid', `${col.displayName}: "${String(value instanceof Date ? serializeValue(col, value) : value)}" already exists (values must be unique).`)
      }
    }
  }

  function checkLookup(def: TableDef, col: ColumnDef, value: FxValue, selfRows: Row[]) {
    if (col.type !== 'lookup' || value === null) return
    const target = lookupRowsFor(def, col, selfRows)
    if (!target) fail('invalid', `${col.displayName}: the lookup table "${col.lookupTable ?? ''}" does not exist.`)
    if (!target!.some((r) => r.id === value)) fail('invalid', `${col.displayName}: no row with id "${String(value)}" in "${col.lookupTable}".`)
  }

  function resolveKeys(def: TableDef, values: FxRecord): Map<string, FxValue> {
    const given = new Map<string, FxValue>()
    for (const [k, v] of Object.entries(values)) {
      if (k === '__id') continue
      const col = findColumn(def, k)
      if (!col) fail('invalid', `Column "${k}" does not exist in "${def.displayName}".`)
      given.set(col!.name, v)
    }
    return given
  }

  /**
   * Build a new row (does not store it). `rows` = rows the new one must be consistent with
   * (uniqueness, self lookups). `preserve` keeps id/createdOn/modifiedOn/createdBy/owner and
   * autonumber values from `values` (CSV round trip, packages).
   */
  function buildRow(
    def: TableDef, rows: Row[], counters: Map<string, number>, values: FxRecord, c: Ctx,
    opts: { preserve?: boolean; checkLookups?: boolean } = {},
  ): Row {
    const given = resolveKeys(def, values)
    const row: FxRecord = {}
    for (const col of def.columns) {
      if (col.system) {
        let v: FxValue = null
        if (opts.preserve && given.has(col.name)) {
          try {
            v = coerceValue(col, given.get(col.name))
          } catch {
            v = null
          }
        }
        if (col.name === 'id') {
          const id = typeof v === 'string' && v && !rows.some((r) => r.id === v) ? v : uuid()
          row.id = id
        } else if (col.name === 'createdOn' || col.name === 'modifiedOn') row[col.name] = v instanceof Date ? v : c.now
        else row[col.name] = typeof v === 'string' && v ? v : c.userId
        continue
      }
      if (col.type === 'autonumber') {
        const keep = opts.preserve ? coerceValue(col, given.get(col.name)) : null
        if (typeof keep === 'string' && keep) {
          row[col.name] = keep
          counters.set(col.name, Math.max(counters.get(col.name) ?? 0, Number(keep.slice((col.prefix ?? '').length)) || 0))
        } else row[col.name] = nextAutonumber(def, col, rows, counters)
        continue
      }
      const v = given.has(col.name) ? coerceValue(col, given.get(col.name)) : defaultValue(col, c.now)
      if (col.required && isBlankValue(v)) fail('invalid', `${col.displayName} is required.`)
      checkUnique(col, v, rows)
      if (opts.checkLookups !== false) checkLookup(def, col, v, rows)
      row[col.name] = v
    }
    row.__id = row.id
    return row
  }

  function applyChanges(def: TableDef, rows: Row[], existing: Row, changes: FxRecord, c: Ctx): Row {
    const given = resolveKeys(def, changes)
    const next: FxRecord = { ...existing }
    let changed = false
    for (const [name, raw] of given) {
      const col = findColumn(def, name)!
      if (col.system || col.type === 'autonumber') continue // read-only: ignored silently
      const v = coerceValue(col, raw)
      if (col.required && isBlankValue(v)) fail('invalid', `${col.displayName} is required.`)
      checkUnique(col, v, rows, existing.id as string)
      checkLookup(def, col, v, rows)
      const before = existing[name]
      const same =
        before instanceof Date && v instanceof Date ? before.getTime() === v.getTime() : before === v || (before == null && v == null)
      if (!same) changed = true
      next[name] = v
    }
    if (!changed) return existing
    next.modifiedOn = c.now
    return next
  }

  /* ------------------------------------------------------------------ table definitions */

  function sanitizeTableDef(raw: unknown, fallbackId?: string): TableDef {
    if (!isObj(raw)) return fail('invalid', 'A table schema is malformed.')
    const name = typeof raw.name === 'string' ? raw.name : ''
    if (!IDENT.test(name)) fail('invalid', `Table name "${name}" is not a valid identifier.`)
    const now = iso()
    const userCols: ColumnDef[] = []
    const seen = new Set<string>(SYSTEM_NAMES)
    for (const rc of Array.isArray(raw.columns) ? raw.columns : []) {
      if (!isObj(rc) || typeof rc.name !== 'string' || !IDENT.test(rc.name) || seen.has(rc.name)) continue
      seen.add(rc.name)
      const type = COLUMN_TYPES.includes(rc.type as ColumnType) ? (rc.type as ColumnType) : 'text'
      const col: ColumnDef = { name: rc.name, displayName: typeof rc.displayName === 'string' && rc.displayName ? rc.displayName : rc.name, type }
      if (rc.required === true) col.required = true
      if (rc.unique === true) col.unique = true
      if (typeof rc.default === 'string' || typeof rc.default === 'number' || typeof rc.default === 'boolean') col.default = String(rc.default)
      if (type === 'choice') col.choices = Array.isArray(rc.choices) ? rc.choices.map(String) : []
      if (type === 'lookup' && typeof rc.lookupTable === 'string') col.lookupTable = rc.lookupTable
      if (type === 'autonumber') col.prefix = typeof rc.prefix === 'string' ? rc.prefix : ''
      if (type === 'file' || type === 'image') {
        if (rc.multiple === true) col.multiple = true
        if (Array.isArray(rc.accept)) col.accept = rc.accept.map(String)
        if (typeof rc.maxSizeMB === 'number') col.maxSizeMB = rc.maxSizeMB
      }
      userCols.push(col)
    }
    const columns = [...SYSTEM_COLUMNS.map((c) => ({ ...c })), ...userCols]
    const primary = typeof raw.primaryColumn === 'string' && columns.some((c) => c.name === raw.primaryColumn) ? raw.primaryColumn : (userCols[0]?.name ?? 'id')
    const def: TableDef = {
      id: typeof raw.id === 'string' && raw.id ? raw.id : (fallbackId ?? shortId('tbl')),
      name,
      displayName: typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : name,
      primaryColumn: primary,
      columns,
      createdOn: typeof raw.createdOn === 'string' ? raw.createdOn : now,
      modifiedOn: typeof raw.modifiedOn === 'string' ? raw.modifiedOn : now,
    }
    if (typeof raw.description === 'string' && raw.description) def.description = raw.description
    if (typeof raw.connectionId === 'string' && raw.connectionId) def.connectionId = raw.connectionId
    if (typeof raw.source === 'string' && raw.source) def.source = raw.source
    if (raw.readOnly === true) def.readOnly = true
    if (isObj(raw.origin) && raw.origin.kind === 'file' && typeof raw.origin.fileId === 'string') def.origin = raw.origin as unknown as NonNullable<TableDef['origin']>
    return def
  }

  function buildColumn(p: Partial<ColumnDef>, existing: ColumnDef[], selfName?: string): ColumnDef {
    const displayName = (p.displayName ?? p.name ?? '').toString().trim()
    if (!displayName) fail('invalid', 'A column needs a display name.')
    const type: ColumnType = p.type ?? 'text'
    if (!COLUMN_TYPES.includes(type)) fail('invalid', `Unknown column type "${String(type)}".`)
    let name: string
    if (p.name !== undefined && p.name !== '') {
      if (!IDENT.test(p.name)) fail('invalid', `Column name "${p.name}" is not a valid identifier (letters, digits, underscore).`)
      if (existing.some((c) => c.name.toLowerCase() === p.name!.toLowerCase())) fail('conflict', `A column named "${p.name}" already exists.`)
      name = p.name
    } else name = uniqueIdentifier(toIdentifier(displayName, 'Column'), existing.map((c) => c.name))
    const col: ColumnDef = { name, displayName, type }
    if (p.required) col.required = true
    if (p.unique) col.unique = true
    if (p.default !== undefined && p.default !== '') col.default = String(p.default)
    if (type === 'choice') col.choices = [...new Set((p.choices ?? []).map((s) => String(s).trim()).filter(Boolean))]
    if (type === 'lookup') {
      const target = p.lookupTable ? (findTable(p.lookupTable)?.def.name ?? (p.lookupTable === selfName ? selfName : undefined)) : undefined
      if (!target) fail('invalid', 'A lookup column needs an existing target table.')
      col.lookupTable = target
    }
    if (type === 'autonumber') col.prefix = p.prefix ?? ''
    if (type === 'file' || type === 'image') {
      if (p.multiple) col.multiple = true
      if (p.accept && p.accept.length) col.accept = [...p.accept]
      if (p.maxSizeMB !== undefined) col.maxSizeMB = p.maxSizeMB
    }
    if (col.default !== undefined && type !== 'lookup') {
      try {
        const d = defaultValue(col, nowFn())
        if (d === null && !/^(today|now)$/i.test(col.default.trim())) fail('invalid', `${displayName}: the default "${col.default}" does not fit the column type.`)
      } catch (e) {
        if (e instanceof PlatformError) throw e
      }
    }
    return col
  }

  /** privileges for a new table so existing roles keep working: maker-like roles get full, viewer-like get read */
  function defaultPrivilegeFor(role: RoleDef, tableId: string): TablePrivilege {
    const ps = role.privileges
    const full = ps.length > 0 && ps.every((p) => p.create && p.read === 'all' && p.update === 'all' && p.delete === 'all')
    const readOnly = ps.length > 0 && ps.every((p) => !p.create && p.read === 'all' && p.update === 'none' && p.delete === 'none')
    if (full) return { table: tableId, create: true, read: 'all', update: 'all', delete: 'all' }
    if (readOnly) return { table: tableId, create: false, read: 'all', update: 'none', delete: 'none' }
    return { table: tableId, create: false, read: 'none', update: 'none', delete: 'none' }
  }

  function registerTable(def: TableDef, rows: Row[]): TableRt {
    const rt: TableRt = { def, rows, counters: new Map() }
    for (const col of def.columns) if (col.type === 'autonumber') rt.counters.set(col.name, autonumberMax(def, col, rows))
    tablesRt.set(def.id, rt)
    return rt
  }

  /** create a table (schema + optional pre-built rows) and update roles, persist */
  async function addTable(def: TableDef, rows: Row[], opts: { grantRoles?: boolean } = {}): Promise<TableDef> {
    registerTable(def, rows)
    let rolesChanged = false
    if (opts.grantRoles !== false) {
      const roles = state.roles.map((r) => (r.isAdmin ? r : { ...r, privileges: [...r.privileges, defaultPrivilegeFor(r, def.id)] }))
      rolesChanged = roles.some((r, i) => r !== state.roles[i])
      if (rolesChanged) state = { ...state, roles }
    }
    syncTables()
    await saveTable(def.name)
    if (rolesChanged) await saveWorkspace()
    return def
  }

  /* ------------------------------------------------------------------ app helpers */

  function checkSize(width: number, height: number) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 200 || height < 200 || width > 16000 || height > 16000) {
      fail('invalid', 'Width and height must be numbers between 200 and 16000.')
    }
    if (width < height) fail('invalid', 'Apps are landscape only: width must be at least the height.')
  }

  function validateDef(def: unknown): AppDef {
    if (!isObj(def) || !Array.isArray(def.screens)) return fail('invalid', 'The app definition is malformed (no screens).')
    return def as unknown as AppDef
  }

  async function addApp(def: AppDef, name: string, description?: string): Promise<AppMeta> {
    const id = shortId('app')
    const now = iso()
    const meta: AppMeta = {
      id, name, width: def.width, height: def.height, createdOn: now, modifiedOn: now, modifiedBy: userName(),
    }
    if (description) meta.description = description
    def.name = name
    appDefs.set(id, def)
    setState({ apps: sortApps([...state.apps, meta]) })
    await saveApp(id)
    return meta
  }

  function seedContactsRows(def: TableDef, c: Ctx): Row[] {
    const counters = new Map<string, number>()
    const rows: Row[] = []
    for (const r of SEED_CONTACTS) rows.push(buildRow(def, rows, counters, r as unknown as FxRecord, c))
    return rows
  }

  const contactsDef = (): TableDef => {
    const now = iso()
    return {
      id: 'tbl_contacts', name: 'Contacts', displayName: 'Contacts', description: 'People and companies you work with.',
      primaryColumn: 'Name',
      columns: [
        ...SYSTEM_COLUMNS.map((c) => ({ ...c })),
        { name: 'Name', displayName: 'Name', type: 'text', required: true },
        { name: 'Company', displayName: 'Company', type: 'text' },
        { name: 'City', displayName: 'City', type: 'text' },
        { name: 'Email', displayName: 'Email', type: 'email' },
        { name: 'Active', displayName: 'Active', type: 'boolean', default: 'true' },
        { name: 'Status', displayName: 'Status', type: 'choice', choices: [...CONTACT_STATUSES], default: 'Lead' },
      ],
      createdOn: now, modifiedOn: now,
    }
  }
  const ordersDef = (contactsTable = 'Contacts'): TableDef => {
    const now = iso()
    return {
      id: 'tbl_orders', name: 'Orders', displayName: 'Orders', description: 'Customer orders.',
      primaryColumn: 'OrderNo',
      columns: [
        ...SYSTEM_COLUMNS.map((c) => ({ ...c })),
        { name: 'OrderNo', displayName: 'Order no', type: 'autonumber', prefix: 'ORD-' },
        { name: 'Customer', displayName: 'Customer', type: 'lookup', lookupTable: contactsTable, required: true },
        { name: 'Amount', displayName: 'Amount', type: 'currency', default: '0' },
        { name: 'OrderDate', displayName: 'Order date', type: 'date', default: 'today' },
        { name: 'Status', displayName: 'Status', type: 'choice', choices: [...ORDER_STATUSES], default: 'New' },
      ],
      createdOn: now, modifiedOn: now,
    }
  }

  /* ------------------------------------------------------------------ init / load / seed */

  const fullPrivileges = (): TablePrivilege[] =>
    [...tablesRt.values()].map((t) => ({ table: t.def.id, create: true, read: 'all', update: 'all', delete: 'all' }))
  const readPrivileges = (): TablePrivilege[] =>
    [...tablesRt.values()].map((t) => ({ table: t.def.id, create: false, read: 'all', update: 'none', delete: 'none' }))

  async function seed() {
    const now = iso()
    const c: Ctx = { userId: 'user_admin', now: nowFn() }
    const cd = contactsDef()
    const contacts = registerTable(cd, seedContactsRows(cd, c))
    const od = ordersDef()
    const orders = registerTable(od, [])
    const counters = orders.counters
    const orderRows: Row[] = []
    for (const o of SEED_ORDERS) {
      orderRows.push(
        buildRow(od, orderRows, counters, {
          Customer: contacts.rows[o.customer].id, Amount: o.amount, OrderDate: o.date, Status: o.status,
        }, c),
      )
    }
    orders.rows = orderRows

    const roles: RoleDef[] = [
      { id: 'role_admin', name: 'Administrator', description: 'Full access to everything.', isAdmin: true, privileges: [], apps: 'all' },
      { id: 'role_maker', name: 'Maker', isMaker: true, description: 'Builds apps and edits all data.', privileges: fullPrivileges(), apps: 'all' },
      { id: 'role_viewer', name: 'Viewer', description: 'Can run apps and read all data.', privileges: readPrivileges(), apps: 'all' },
    ]
    const users: UserDef[] = [
      { id: 'user_admin', name: 'Admin', email: 'admin@appbuilder.local', roleIds: ['role_admin'] },
      { id: 'user_sam', name: 'Sam Maker', email: 'sam@appbuilder.local', roleIds: ['role_maker'] },
      { id: 'user_vera', name: 'Vera Viewer', email: 'vera@appbuilder.local', roleIds: ['role_viewer'] },
    ]
    const connections: ConnectionRef[] = [
      { id: 'conn_local_csv', name: 'Local CSV', connector: 'local-csv', status: 'connected', settings: { folder: 'tables' } },
    ]
    state = { ...state, roles, users, currentUserId: 'user_admin', connections }

    const appName = 'Contacts app'
    const appDef = contactsSampleApp(appName, 1920, 1080)
    const appMeta: AppMeta = {
      id: 'app_contacts', name: appName, description: 'A contacts list with search, details and an add form.',
      width: 1920, height: 1080, createdOn: now, modifiedOn: now, modifiedBy: 'Admin',
    }
    appDefs.set(appMeta.id, appDef)

    const solution: SolutionDef = {
      id: 'sol_default', name: 'Default', displayName: 'Default', publisher: 'Appbuilder', version: '1.0.0',
      description: 'Everything in this workspace.',
      components: [
        { kind: 'app', id: appMeta.id },
        { kind: 'table', id: cd.id }, { kind: 'table', id: od.id },
        ...roles.map((r) => ({ kind: 'role' as const, id: r.id })),
        { kind: 'connection', id: connections[0].id },
      ],
      createdOn: now, modifiedOn: now,
    }
    state = { ...state, apps: [appMeta], solutions: [solution] }
    syncTables(false)
    await Promise.all([saveTable('Contacts'), saveTable('Orders'), saveApp(appMeta.id), saveWorkspace()])
  }

  async function loadExisting(wsText: string | null, tableFiles: string[], appFiles: string[]) {
    let ws: Record<string, unknown> = {}
    if (wsText !== null) {
      try {
        const parsed = fromYaml(wsText)
        if (isObj(parsed)) ws = parsed
      } catch {
        // keep the unreadable file as a backup instead of overwriting it
        try {
          await st().writeText(`workspace.yaml.corrupt-${Date.now()}.bak`, wsText)
        } catch { /* ignore */ }
        console.warn('[platform] workspace.yaml could not be parsed; started with default users and roles (backup written).')
      }
    }
    // tables
    for (const f of tableFiles) {
      const name = f.slice(0, -'.schema.yaml'.length)
      try {
        const schemaText = await st().readText(`tables/${f}`)
        if (schemaText === null) continue
        const raw = fromYaml(schemaText)
        const def = sanitizeTableDef(isObj(raw) ? { ...raw, name: isObj(raw) && typeof raw.name === 'string' ? raw.name : name } : raw)
        if (def.name !== name) def.name = name
        const csv = await st().readText(`tables/${name}.csv`)
        const rows = csv ? csvToRows(def.columns, csv, uuid, nowFn()) : []
        registerTable(def, rows)
      } catch (e) {
        console.warn(`[platform] skipped table file ${f}:`, e)
      }
    }
    // apps
    const metas: AppMeta[] = []
    for (const f of appFiles) {
      const id = f.slice(0, -'.app.yaml'.length)
      try {
        const text = await st().readText(`apps/${f}`)
        if (text === null) continue
        const doc = fromYaml(text)
        if (!isObj(doc) || !isObj(doc.meta)) continue
        const def = validateDef(doc.definition)
        const m = doc.meta as Record<string, unknown>
        const now = iso()
        metas.push({
          id,
          name: typeof m.name === 'string' && m.name ? m.name : def.name || id,
          ...(typeof m.description === 'string' && m.description ? { description: m.description } : {}),
          width: typeof m.width === 'number' ? m.width : def.width,
          height: typeof m.height === 'number' ? m.height : def.height,
          createdOn: typeof m.createdOn === 'string' ? m.createdOn : now,
          modifiedOn: typeof m.modifiedOn === 'string' ? m.modifiedOn : now,
          modifiedBy: typeof m.modifiedBy === 'string' ? m.modifiedBy : 'Unknown',
        })
        appDefs.set(id, def)
      } catch (e) {
        console.warn(`[platform] skipped app file ${f}:`, e)
      }
    }
    const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v.filter(isObj) as unknown as T[]) : [])
    let roles = arr<RoleDef>(ws.roles).map((r) => ({
      ...r,
      privileges: arr<TablePrivilege>(r.privileges),
      apps: r.apps === 'all' ? ('all' as const) : Array.isArray(r.apps) ? r.apps.map(String) : [],
    }))
    let users = arr<UserDef>(ws.users).map((u) => ({ ...u, roleIds: Array.isArray(u.roleIds) ? u.roleIds.map(String) : [] }))
    let repaired = false
    if (!roles.some((r) => r.isAdmin)) {
      roles = [{ id: 'role_admin', name: 'Administrator', description: 'Full access to everything.', isAdmin: true, privileges: [], apps: 'all' }, ...roles]
      repaired = true
    }
    if (users.length === 0) {
      users = [{ id: 'user_admin', name: 'Admin', email: 'admin@appbuilder.local', roleIds: [roles.find((r) => r.isAdmin)!.id] }]
      repaired = true
    }
    let currentUserId = typeof ws.currentUserId === 'string' ? ws.currentUserId : ''
    if (!users.some((u) => u.id === currentUserId)) currentUserId = users[0].id
    state = {
      ...state, roles, users, currentUserId,
      connections: arr<ConnectionRef>(ws.connections),
      solutions: arr<SolutionDef>(ws.solutions),
      dataFiles: arr<DataFileDef>(ws.dataFiles).map((f) => ({ ...f, tableIds: Array.isArray(f.tableIds) ? f.tableIds.map(String) : [] })),
      apps: sortApps(metas),
    }
    syncTables(false)
    if (repaired || wsText === null) await saveWorkspace()
  }

  async function loadAll() {
    tablesRt.clear()
    appDefs.clear()
    state = { ...state, apps: [], tables: [], roles: [], users: [], connections: [], solutions: [], dataFiles: [], currentUserId: '' }
    attachmentStore.clear()
    const wsText = await st().readText('workspace.yaml')
    const tableFiles = (await st().list('tables')).filter((f) => f.endsWith('.schema.yaml'))
    const appFiles = (await st().list('apps')).filter((f) => f.endsWith('.app.yaml'))
    if (wsText === null && tableFiles.length === 0 && appFiles.length === 0) await seed()
    else await loadExisting(wsText, tableFiles, appFiles)
    try {
      for (const f of (await st().list('attachments')).filter((x) => x.endsWith('.json'))) {
        const text = await st().readText(`attachments/${f}`)
        if (!text) continue
        const a = JSON.parse(text) as AttachmentRef & { dataUrl: string }
        if (a && typeof a.id === 'string' && typeof a.dataUrl === 'string') attachmentStore.set(a.id, a)
      }
    } catch (e) {
      console.warn('[platform] attachments could not be loaded:', e)
    }
  }

  function init(): Promise<void> {
    if (!initPromise) {
      initPromise = (async () => {
        if (!storage) {
          try {
            storage = await (source as () => Promise<StorageAdapter>)()
          } catch {
            storage = new MemoryStorage('browser', 'Browser storage (temporary, this tab only)')
          }
        }
        try {
          await loadAll()
        } catch (e) {
          console.warn('[platform] storage failed during load, using temporary in-memory storage:', e)
          storage = new MemoryStorage('browser', 'Browser storage (temporary: the workspace could not be read)')
          await loadAll()
        }
        setState({ ready: true, storage: { kind: storage.kind, location: storage.location } }, true)
      })()
    }
    return initPromise
  }

  /* ------------------------------------------------------------------ packages */

  const PACKAGE_VERSION = 1

  function formulasOf(def: AppDef): string[] {
    const out: string[] = Object.values(def.appProps ?? {})
    const walkNodes = (nodes: AppDef['screens']) => {
      for (const n of nodes) {
        for (const f of Object.values(n.props ?? {})) if (typeof f === 'string') out.push(f)
        walkNodes(n.children ?? [])
      }
    }
    walkNodes(def.screens)
    return out.filter((f): f is string => typeof f === 'string')
  }

  /** tables an app uses: dataSources + names mentioned in formulas (outside strings), + lookup targets */
  function tablesUsedBy(def: AppDef): TableRt[] {
    const names = new Set<string>()
    for (const s of def.dataSources ?? []) if (findTable(s)) names.add(findTable(s)!.def.name)
    const known = new Set(tableNames())
    for (const f of formulasOf(def)) {
      const bare = f.replace(/"(?:[^"]|"")*"/g, '""')
      for (const m of bare.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) if (known.has(m[0])) names.add(m[0])
    }
    const queue = [...names]
    while (queue.length) {
      const t = findTableByName(queue.pop()!)
      if (!t) continue
      for (const c of t.def.columns) {
        if (c.type === 'lookup' && c.lookupTable && known.has(c.lookupTable) && !names.has(c.lookupTable)) {
          names.add(c.lookupTable)
          queue.push(c.lookupTable)
        }
      }
    }
    return [...names].map((n) => findTableByName(n)!).filter(Boolean)
  }

  const tableEntry = (rt: TableRt, includeData: boolean) => ({
    schema: clone(rt.def),
    ...(includeData ? { csv: rowsToCsv(rt.def.columns, rt.rows, '\n') } : {}),
  })

  const appEntry = (id: string) => {
    const meta = state.apps.find((a) => a.id === id) ?? fail('not-found', 'App not found.')
    const def = appDefs.get(id) ?? fail('not-found', 'App not found.')
    return { id, name: meta!.name, ...(meta!.description ? { description: meta!.description } : {}), definition: clone(def!) }
  }

  function parsePackage(text: string, kind: 'appbuilder/app' | 'appbuilder/solution'): Record<string, unknown> {
    if (typeof text !== 'string' || !text.trim()) fail('invalid', 'The package is empty.')
    const doc = fromYaml(text)
    if (!isObj(doc)) return fail('invalid', 'This is not an Appbuilder package.')
    if (doc.kind !== kind) {
      const other = kind === 'appbuilder/app' ? 'solution' : 'app'
      if (doc.kind === 'appbuilder/app' || doc.kind === 'appbuilder/solution') fail('invalid', `This is a ${other} package, not a ${kind.split('/')[1]} package.`)
      fail('invalid', `This is not an Appbuilder ${kind.split('/')[1]} package (kind: ${String(doc.kind ?? 'missing')}).`)
    }
    if (doc.packageVersion !== PACKAGE_VERSION) fail('invalid', `Unsupported package version ${String(doc.packageVersion)} (expected ${PACKAGE_VERSION}).`)
    return doc
  }

  interface PkgTable { def: TableDef; csv?: string }
  function readPkgTables(v: unknown): PkgTable[] {
    if (v === undefined) return []
    if (!Array.isArray(v)) return fail('invalid', 'The package "tables" must be a list.')
    return v.map((e) => {
      if (!isObj(e) || !isObj(e.schema)) return fail('invalid', 'A table entry in the package has no schema.')
      return { def: sanitizeTableDef(e.schema), ...(typeof e.csv === 'string' ? { csv: e.csv } : {}) }
    })
  }
  interface PkgApp { oldId?: string; name: string; description?: string; def: AppDef }
  function readPkgApp(e: unknown): PkgApp {
    if (!isObj(e)) return fail('invalid', 'An app entry in the package is malformed.')
    const def = validateDef(e.definition)
    const name = typeof e.name === 'string' && e.name.trim() ? e.name.trim() : def.name || 'Imported app'
    return {
      ...(typeof e.id === 'string' ? { oldId: e.id } : {}), name,
      ...(typeof e.description === 'string' && e.description ? { description: e.description } : {}), def: clone(def),
    }
  }

  /** reuse tables that exist by name, create the rest; returns old table id -> local table id */
  async function ensurePkgTables(list: PkgTable[]): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    const created: { rt: TableRt; csv?: string }[] = []
    for (const p of list) {
      const existing = findTable(p.def.name)
      if (existing) {
        map.set(p.def.id, existing.def.id)
        continue
      }
      const id = shortId('tbl')
      map.set(p.def.id, id)
      const def: TableDef = { ...p.def, id, createdOn: iso(), modifiedOn: iso() }
      created.push({ rt: registerTable(def, []), ...(p.csv !== undefined ? { csv: p.csv } : {}) })
    }
    // rows after all schemas exist (lookups may point at sibling tables). Ids are preserved so lookups stay valid.
    for (const { rt, csv } of created) {
      if (csv) rt.rows = importRows(rt, csv, 'replace', { preserve: true, checkLookups: false }).rows
    }
    if (created.length) {
      const roles = state.roles.map((r) =>
        r.isAdmin ? r : { ...r, privileges: [...r.privileges, ...created.map(({ rt }) => defaultPrivilegeFor(r, rt.def.id))] },
      )
      state = { ...state, roles }
      syncTables()
      await Promise.all([...created.map(({ rt }) => saveTable(rt.def.name)), saveWorkspace()])
    }
    return map
  }

  /* ------------------------------------------------------------------ CSV import */

  /** validate + build the rows of a CSV import without touching the table; throws on the first bad row */
  function importRows(
    rt: TableRt, csvText: string, mode: 'append' | 'replace', opts: { preserve?: boolean; checkLookups?: boolean } = {},
  ): { rows: Row[]; added: number; counters: Map<string, number> } {
    const { headers, records } = parseCsvText(csvText)
    const def = rt.def
    const headerToCol = new Map<string, ColumnDef>()
    for (const h of headers) {
      const col =
        def.columns.find((c) => c.name === h) ??
        def.columns.find((c) => c.name.toLowerCase() === h.toLowerCase()) ??
        def.columns.find((c) => c.displayName.toLowerCase() === h.toLowerCase())
      if (col && !headerToCol.has(h) && ![...headerToCol.values()].includes(col)) headerToCol.set(h, col)
    }
    const working: Row[] = mode === 'replace' ? [] : rt.rows.slice()
    const counters = new Map(mode === 'replace' ? [] : rt.counters)
    const c = ctx()
    let added = 0
    records.forEach((rec, i) => {
      const values: FxRecord = {}
      for (const [h, col] of headerToCol) {
        const cell = rec[h]
        if (cell !== undefined && cell !== '') values[col.name] = cell
      }
      try {
        const row = buildRow(def, working, counters, values, c, { preserve: opts.preserve ?? true, checkLookups: opts.checkLookups })
        working.push(row)
        added++
      } catch (e) {
        if (e instanceof PlatformError) throw new PlatformError(e.code, `Row ${i + 2}: ${e.message}`)
        throw e
      }
    })
    return { rows: working, added, counters }
  }

  /* ------------------------------------------------------------------ the API */

  /** create a table from CSV text (inferred columns). `extra` merges into the new TableDef (origin, connectionId). */
  async function createTableFromCsv(displayName: string, csvText: string, extra: Partial<TableDef> = {}): Promise<TableDef> {
    const name = displayName.trim()
    if (!name) fail('invalid', 'A table needs a display name.')
    const { headers, records } = parseCsvText(csvText)
    const usable = headers.map((h, i) => ({ h, i })).filter((x) => x.h !== '')
    if (usable.length === 0) fail('invalid', 'The CSV has no header row.')
    const tname = uniqueIdentifier(toIdentifier(name, 'Table'), tableNames())
    const cols: ColumnDef[] = []
    const header2col = new Map<string, ColumnDef>()
    for (const { h } of usable) {
      if (header2col.has(h)) continue
      const type = inferType(records.map((r) => r[h] ?? ''))
      const col: ColumnDef = { name: uniqueIdentifier(toIdentifier(h, 'Column'), [...SYSTEM_COLUMNS, ...cols].map((c) => c.name)), displayName: h, type }
      cols.push(col)
      header2col.set(h, col)
    }
    const now = iso()
    const first = cols.find((c) => c.type === 'text') ?? cols[0]
    const def: TableDef = {
      id: shortId('tbl'), name: tname, displayName: name, primaryColumn: first.name,
      columns: [...SYSTEM_COLUMNS.map((c) => ({ ...c })), ...cols], createdOn: now, modifiedOn: now,
    }
    const rt: TableRt = { def, rows: [], counters: new Map() }
    const rows: Row[] = []
    const c = ctx()
    records.forEach((rec, i) => {
      const values: FxRecord = {}
      for (const [h, col] of header2col) if ((rec[h] ?? '') !== '') values[col.name] = rec[h]
      try {
        rows.push(buildRow(def, rows, rt.counters, values, c, { checkLookups: false }))
      } catch (e) {
        if (e instanceof PlatformError) throw new PlatformError(e.code, `Row ${i + 2}: ${e.message}`)
        throw e
      }
    })
    Object.assign(def, extra)
    return addTable(def, rows)
  }

  async function updateTableDef(id: string, patch: Partial<Pick<TableDef, 'displayName' | 'description' | 'primaryColumn'>>): Promise<void> {
    const rt = needTable(id)
    const def = { ...rt.def }
    if (patch.displayName !== undefined) {
      if (!patch.displayName.trim()) fail('invalid', 'The display name cannot be empty.')
      def.displayName = patch.displayName.trim()
    }
    if (patch.description !== undefined) {
      if (patch.description) def.description = patch.description
      else delete def.description
    }
    if (patch.primaryColumn !== undefined) {
      if (!def.columns.some((c) => c.name === patch.primaryColumn)) fail('invalid', `Column "${patch.primaryColumn}" does not exist.`)
      def.primaryColumn = patch.primaryColumn
    }
    def.modifiedOn = iso()
    rt.def = def
    syncTables()
    await saveTable(def.name)
  }

  function updateRow(tableName: string, id: string, changes: FxRecord, opts?: { secure?: boolean }): Row {
    const rt = needTable(tableName)
    const existing = rt.rows.find((r) => r.id === id) ?? fail('not-found', `No row with id "${id}" in "${rt.def.displayName}".`)
    const secure = opts?.secure !== false
    const g = privilege(rt.def)
    if (secure) {
      if (g.update === 'none' || !rowTester(rt.def, 'update')(existing!)) deny('update', rt)
      assertWritable(rt, g, writtenKeys(rt.def, changes))
    }
    const next = applyChanges(rt.def, rt.rows, existing!, changes, ctx())
    if (next === existing) return secure ? stripColumns(existing!, hiddenColumns(g)) : existing!
    rt.rows = rt.rows.map((r) => (r === existing ? next : r))
    markFileModified(rt.def)
    setState({}, true)
    saveTableLater(rt.def.name)
    return secure ? stripColumns(next, hiddenColumns(g)) : next
  }

  /**
   * NOTE: src/platform/contracts.ts declares `tables.update` twice (table definition patch, and row
   * update). Both are implemented behind one function and dispatched on the argument shape:
   *   update(tableId, patch)                       -> Promise<void>   (patch is an object)
   *   update(tableName, rowId, changes, opts?)     -> Row             (second argument is a string)
   */
  const tablesUpdate = ((a: string, b: unknown, c?: FxRecord, d?: { secure?: boolean }) =>
    typeof b === 'string' ? updateRow(a, b, c ?? {}, d) : updateTableDef(a, (b ?? {}) as Parameters<typeof updateTableDef>[1])) as PlatformApi['tables']['update']

  const tablesApi: PlatformApi['tables'] = {
    update: tablesUpdate,
    async create(input) {
      const displayName = (input.displayName ?? '').trim()
      if (!displayName) fail('invalid', 'A table needs a display name.')
      let name: string
      if (input.name) {
        if (!IDENT.test(input.name)) fail('invalid', `Table name "${input.name}" is not a valid identifier.`)
        if (findTable(input.name)) fail('conflict', `A table named "${input.name}" already exists.`)
        name = input.name
      } else name = uniqueIdentifier(toIdentifier(displayName, 'Table'), tableNames())
      const userCols: ColumnDef[] = []
      const requested = input.columns && input.columns.length ? input.columns : [{ displayName: 'Name', type: 'text' as ColumnType }]
      for (const p of requested) userCols.push(buildColumn(p, [...SYSTEM_COLUMNS, ...userCols], name))
      const now = iso()
      const def: TableDef = {
        id: shortId('tbl'), name, displayName, primaryColumn: userCols[0].name,
        columns: [...SYSTEM_COLUMNS.map((c) => ({ ...c })), ...userCols], createdOn: now, modifiedOn: now,
      }
      if (input.description) def.description = input.description
      return addTable(def, [])
    },

    async remove(id) {
      const rt = needTable(id)
      const { id: tid, name } = rt.def
      tablesRt.delete(tid)
      const roles = state.roles.map((r) => (r.privileges.some((p) => p.table === tid) ? { ...r, privileges: r.privileges.filter((p) => p.table !== tid) } : r))
      const solutions = state.solutions.map((s) =>
        s.components.some((c) => c.kind === 'table' && c.id === tid) ? { ...s, components: s.components.filter((c) => !(c.kind === 'table' && c.id === tid)), modifiedOn: iso() } : s,
      )
      state = { ...state, roles, solutions }
      syncTables()
      await Promise.all([saveTable(name), saveWorkspace()])
    },

    async addColumn(tableId, col) {
      const rt = needTable(tableId)
      const built = buildColumn(col, rt.def.columns, rt.def.name)
      const c = ctx()
      const counters = rt.counters
      const rows = rt.rows.map((r) => {
        const v = built.type === 'autonumber' ? nextAutonumber(rt.def, built, rt.rows, counters) : defaultValue(built, c.now)
        return { ...r, [built.name]: v }
      })
      // autonumber for existing rows must be sequential: recompute using the growing set
      if (built.type === 'autonumber') {
        counters.set(built.name, 0)
        rows.forEach((r, i) => {
          r[built.name] = `${built.prefix ?? ''}${pad(i + 1)}`
        })
        counters.set(built.name, rows.length)
      }
      rt.rows = rows
      rt.def = { ...rt.def, columns: [...rt.def.columns, built], modifiedOn: iso() }
      syncTables()
      await saveTable(rt.def.name)
      return built
    },

    async updateColumn(tableId, name, patch) {
      const rt = needTable(tableId)
      const idx = rt.def.columns.findIndex((c) => c.name === name)
      if (idx < 0) fail('not-found', `Column "${name}" was not found.`)
      const old = rt.def.columns[idx]
      if (old.system) fail('invalid', `"${old.displayName}" is a system column and cannot be changed.`)
      if (patch.name !== undefined && patch.name !== old.name) fail('invalid', 'Columns can only be renamed through their display name.')
      if (patch.system !== undefined && patch.system !== old.system) fail('invalid', 'The system flag cannot be changed.')
      const merged: ColumnDef = { ...old }
      const p = patch as Partial<ColumnDef>
      if (p.displayName !== undefined) {
        if (!p.displayName.trim()) fail('invalid', 'The display name cannot be empty.')
        merged.displayName = p.displayName.trim()
      }
      if (p.type !== undefined) {
        if (!COLUMN_TYPES.includes(p.type)) fail('invalid', `Unknown column type "${String(p.type)}".`)
        merged.type = p.type
      }
      for (const k of ['required', 'unique'] as const) {
        if (k in p) {
          if (p[k]) merged[k] = true
          else delete merged[k]
        }
      }
      if ('default' in p) {
        if (p.default === undefined || p.default === '') delete merged.default
        else merged.default = String(p.default)
      }
      if ('choices' in p) merged.choices = [...new Set((p.choices ?? []).map((s) => String(s).trim()).filter(Boolean))]
      if ('lookupTable' in p) {
        const target = p.lookupTable ? findTable(p.lookupTable)?.def.name ?? (p.lookupTable === rt.def.name ? rt.def.name : undefined) : undefined
        if (merged.type === 'lookup' && !target) fail('invalid', 'A lookup column needs an existing target table.')
        if (target) merged.lookupTable = target
        else delete merged.lookupTable
      }
      if ('prefix' in p) merged.prefix = p.prefix ?? ''
      for (const k of ['multiple'] as const) {
        if (k in p) {
          if (p[k]) merged[k] = true
          else delete merged[k]
        }
      }
      if ('accept' in p) {
        if (p.accept && p.accept.length) merged.accept = [...p.accept]
        else delete merged.accept
      }
      if ('maxSizeMB' in p) {
        if (p.maxSizeMB !== undefined) merged.maxSizeMB = p.maxSizeMB
        else delete merged.maxSizeMB
      }
      if (merged.type !== 'file' && merged.type !== 'image') {
        delete merged.multiple
        delete merged.accept
        delete merged.maxSizeMB
      }
      // drop fields that do not belong to the (possibly new) type
      if (merged.type !== 'choice') delete merged.choices
      else merged.choices ??= []
      if (merged.type !== 'lookup') delete merged.lookupTable
      else if (!merged.lookupTable) fail('invalid', 'A lookup column needs an existing target table.')
      if (merged.type !== 'autonumber') delete merged.prefix
      else merged.prefix ??= ''

      let rows = rt.rows
      if (merged.type !== old.type || merged.type === 'choice' || merged.type === 'autonumber') {
        const counters = new Map<string, number>()
        rows = rt.rows.map((r, i) => {
          try {
            if (merged.type === 'autonumber') {
              const cur = r[merged.name]
              if (merged.type === old.type && typeof cur === 'string' && cur) return r
              return { ...r, [merged.name]: nextAutonumber(rt.def, merged, [], counters) }
            }
            if (merged.type === old.type && merged.type === 'choice') return r
            const cell = r[merged.name]
            return { ...r, [merged.name]: coerceValue(merged, cell as FxValue) }
          } catch (e) {
            if (e instanceof PlatformError) throw new PlatformError('invalid', `Cannot change the type: row ${i + 1} — ${e.message}`)
            throw e
          }
        })
        if (merged.type === 'autonumber') rt.counters.set(merged.name, Math.max(rt.counters.get(merged.name) ?? 0, counters.get(merged.name) ?? 0))
      }
      const columns = [...rt.def.columns]
      columns[idx] = merged
      rt.rows = rows
      rt.def = { ...rt.def, columns, modifiedOn: iso() }
      syncTables()
      await saveTable(rt.def.name)
    },

    async removeColumn(tableId, name) {
      const rt = needTable(tableId)
      const col = rt.def.columns.find((c) => c.name === name)
      if (!col) return fail('not-found', `Column "${name}" was not found.`)
      if (col.system) fail('invalid', `"${col.displayName}" is a system column and cannot be removed.`)
      const columns = rt.def.columns.filter((c) => c.name !== name)
      const primary = rt.def.primaryColumn === name ? (columns.find((c) => !c.system)?.name ?? 'id') : rt.def.primaryColumn
      rt.rows = rt.rows.map((r) => {
        const { [name]: _drop, ...rest } = r
        void _drop
        return rest as Row
      })
      rt.counters.delete(name)
      rt.def = { ...rt.def, columns, primaryColumn: primary, modifiedOn: iso() }
      syncTables()
      await saveTable(rt.def.name)
    },

    get(nameOrId) {
      const rt = findTable(nameOrId)
      return rt ? visibleDef(rt.def) : undefined
    },

    rows(tableName, opts) {
      const rt = needTable(tableName)
      if (opts?.secure === false) return rt.rows.slice()
      const g = privilege(rt.def)
      if (g.read === 'none') return []
      const hidden = hiddenColumns(g)
      const everything = isAdminNow() || (g.read === 'all' && !g.filtered)
      let out = everything ? rt.rows.slice() : rt.rows.filter(rowTester(rt.def, 'read'))
      if (hidden.length) out = out.map((r) => stripColumns(r, hidden))
      return out
    },

    insert(tableName, values, opts) {
      const rt = needTable(tableName)
      const secure = opts?.secure !== false
      const g = privilege(rt.def)
      if (secure) {
        if (!g.create) deny('create', rt)
        assertWritable(rt, g, writtenKeys(rt.def, values))
      }
      const row = buildRow(rt.def, rt.rows, rt.counters, values, ctx())
      rt.rows = [...rt.rows, row]
      markFileModified(rt.def)
      setState({}, true)
      saveTableLater(rt.def.name)
      return secure ? stripColumns(row, hiddenColumns(g)) : row
    },

    delete(tableName, ids, opts) {
      const rt = needTable(tableName)
      const kill = new Set(ids)
      const victims = rt.rows.filter((r) => kill.has(r.id as string))
      if (victims.length === 0) return
      if (opts?.secure !== false) {
        const test = rowTester(rt.def, 'delete')
        if (victims.some((r) => !test(r))) deny('delete', rt)
      }
      rt.rows = rt.rows.filter((r) => !kill.has(r.id as string))
      markFileModified(rt.def)
      setState({}, true)
      saveTableLater(rt.def.name)
    },

    async reload(tableName) {
      const rt = needTable(tableName)
      await persister.flush()
      const csv = await st().readText(`tables/${rt.def.name}.csv`)
      rt.rows = csv ? csvToRows(rt.def.columns, csv, uuid, nowFn()) : []
      for (const col of rt.def.columns) if (col.type === 'autonumber') rt.counters.set(col.name, autonumberMax(rt.def, col, rt.rows))
      setState({}, true)
    },

    exportCsv(tableName) {
      const rt = needTable(tableName)
      return rowsToCsv(rt.def.columns, rt.rows)
    },

    async importCsv(tableName, csvText, mode) {
      const rt = needTable(tableName)
      // The portal's data grid is the maker's raw view (secure:false), so imports are not role-filtered.
      const res = importRows(rt, csvText, mode)
      rt.rows = res.rows
      rt.counters = res.counters
      for (const col of rt.def.columns) if (col.type === 'autonumber') rt.counters.set(col.name, Math.max(rt.counters.get(col.name) ?? 0, autonumberMax(rt.def, col, rt.rows)))
      markFileModified(rt.def)
      setState({}, true)
      await saveTable(rt.def.name)
      return res.added
    },

    createFromCsv(displayName, csvText) {
      return createTableFromCsv(displayName, csvText)
    },

    async ensureLoaded() {
      /* demo mode holds every table in memory */
    },
    async listSourceTables() {
      return []
    },
    async linkSourceTable() {
      return fail('unavailable', NEEDS_SERVER)
    },
    async moveToConnection() {
      return fail('unavailable', NEEDS_SERVER)
    },

    flush() {
      return persister.flush()
    },
  }

  const appsApi: PlatformApi['apps'] = {
    async create(input) {
      const name = (input.name ?? '').trim()
      if (!name) fail('invalid', 'An app needs a name.')
      checkSize(input.width, input.height)
      const unique = uniqueLabel(name, state.apps.map((a) => a.name))
      let def: AppDef
      if (input.template === 'sample') {
        if (!findTable('Contacts')) {
          const cd = contactsDef()
          cd.id = shortId('tbl')
          await addTable(cd, seedContactsRows(cd, ctx()))
        }
        def = contactsSampleApp(unique, input.width, input.height)
      } else def = blankApp(unique, input.width, input.height)
      return addApp(def, unique, input.template === 'sample' ? 'A contacts list with search, details and an add form.' : undefined)
    },

    async load(id) {
      const def = appDefs.get(id)
      return def ? clone(def) : null
    },

    async save(id, def) {
      const meta = state.apps.find((a) => a.id === id) ?? fail('not-found', `App "${id}" was not found.`)
      const valid = validateDef(def)
      const copy = clone(valid)
      const name = typeof copy.name === 'string' && copy.name.trim() ? copy.name.trim() : meta!.name
      copy.name = name
      appDefs.set(id, copy)
      const next: AppMeta = {
        ...meta!, name,
        width: Number.isFinite(copy.width) ? copy.width : meta!.width,
        height: Number.isFinite(copy.height) ? copy.height : meta!.height,
        modifiedOn: iso(), modifiedBy: userName(),
      }
      setState({ apps: sortApps(state.apps.map((a) => (a.id === id ? next : a))) })
      await saveApp(id)
    },

    async rename(id, name) {
      const meta = state.apps.find((a) => a.id === id) ?? fail('not-found', `App "${id}" was not found.`)
      const n = (name ?? '').trim()
      if (!n) fail('invalid', 'An app needs a name.')
      if (state.apps.some((a) => a.id !== id && a.name.toLowerCase() === n.toLowerCase())) fail('conflict', `An app named "${n}" already exists.`)
      const def = appDefs.get(id)
      if (def) def.name = n
      setState({ apps: sortApps(state.apps.map((a) => (a.id === id ? { ...meta!, name: n, modifiedOn: iso(), modifiedBy: userName() } : a))) })
      await saveApp(id)
    },

    async duplicate(id) {
      const meta = state.apps.find((a) => a.id === id) ?? fail('not-found', `App "${id}" was not found.`)
      const def = clone(appDefs.get(id) ?? fail('not-found', `App "${id}" was not found.`))
      const name = uniqueLabel(`${meta!.name} (copy)`, state.apps.map((a) => a.name))
      return addApp(def, name, meta!.description)
    },

    async remove(id) {
      if (!state.apps.some((a) => a.id === id)) fail('not-found', `App "${id}" was not found.`)
      appDefs.delete(id)
      const roles = state.roles.map((r) => (Array.isArray(r.apps) && r.apps.includes(id) ? { ...r, apps: r.apps.filter((a) => a !== id) } : r))
      const solutions = state.solutions.map((s) =>
        s.components.some((c) => c.kind === 'app' && c.id === id) ? { ...s, components: s.components.filter((c) => !(c.kind === 'app' && c.id === id)), modifiedOn: iso() } : s,
      )
      setState({ apps: state.apps.filter((a) => a.id !== id), roles, solutions })
      await Promise.all([saveApp(id), saveWorkspace()])
    },

    async exportPackage(id, opts) {
      const entry = appEntry(id)
      const tables = tablesUsedBy(entry.definition).map((rt) => tableEntry(rt, opts?.includeData === true))
      return toYaml({ kind: 'appbuilder/app', packageVersion: PACKAGE_VERSION, exportedOn: iso(), app: entry, tables })
    },

    async importPackage(yamlText) {
      const doc = parsePackage(yamlText, 'appbuilder/app')
      const app = readPkgApp(doc.app)
      const tables = readPkgTables(doc.tables)
      await ensurePkgTables(tables)
      const name = uniqueLabel(app.name, state.apps.map((a) => a.name))
      return addApp(app.def, name, app.description)
    },
  }

  const securityApi: PlatformApi['security'] = {
    currentUser,
    setCurrentUser(userId) {
      if (!state.users.some((u) => u.id === userId)) fail('not-found', `User "${userId}" was not found.`)
      setState({ currentUserId: userId }, true) // row visibility depends on the user
      saveWorkspaceLater()
    },
    async setPassword() {
      return fail('unavailable', 'Passwords need the local server.')
    },
    can,
    canRunApp(appId) {
      const u = currentUser()
      if (!u) return false
      return rolesOf(u).some((r) => r.isAdmin || r.apps === 'all' || r.apps.includes(appId))
    },
    async createRole(input) {
      const name = (input.name ?? '').trim()
      if (!name) fail('invalid', 'A role needs a name.')
      if (state.roles.some((r) => r.name.toLowerCase() === name.toLowerCase())) fail('conflict', `A role named "${name}" already exists.`)
      const role: RoleDef = {
        id: shortId('role'), name, ...(input.description ? { description: input.description } : {}),
        privileges: [...tablesRt.values()].map((t) => ({ table: t.def.id, create: false, read: 'none' as const, update: 'none' as const, delete: 'none' as const })),
        apps: [],
      }
      setState({ roles: [...state.roles, role] })
      await saveWorkspace()
      return role
    },
    async updateRole(id, patch) {
      const role = state.roles.find((r) => r.id === id) ?? fail('not-found', `Role "${id}" was not found.`)
      const next: RoleDef = { ...role!, ...patch, id }
      if (typeof next.name !== 'string' || !next.name.trim()) fail('invalid', 'A role needs a name.')
      next.name = next.name.trim()
      if (state.roles.some((r) => r.id !== id && r.name.toLowerCase() === next.name.toLowerCase())) fail('conflict', `A role named "${next.name}" already exists.`)
      if (!next.isAdmin) delete next.isAdmin
      if (!next.isMaker) delete next.isMaker
      const roles = state.roles.map((r) => (r.id === id ? next : r))
      assertAdminRemains(state.users, roles)
      setState({ roles }, true)
      await saveWorkspace()
    },
    async removeRole(id) {
      const role = state.roles.find((r) => r.id === id) ?? fail('not-found', `Role "${id}" was not found.`)
      const roles = state.roles.filter((r) => r.id !== id)
      const users = state.users.map((u) => (u.roleIds.includes(id) ? { ...u, roleIds: u.roleIds.filter((r) => r !== id) } : u))
      if (role.isAdmin) {
        if (!roles.some((r) => r.isAdmin)) fail('conflict', 'The last administrator role cannot be deleted.')
        assertAdminRemains(users, roles)
      }
      const solutions = state.solutions.map((s) =>
        s.components.some((c) => c.kind === 'role' && c.id === id) ? { ...s, components: s.components.filter((c) => !(c.kind === 'role' && c.id === id)), modifiedOn: iso() } : s,
      )
      setState({ roles, users, solutions }, true)
      await saveWorkspace()
    },
    async createUser(input) {
      const name = (input.name ?? '').trim()
      if (!name) fail('invalid', 'A user needs a name.')
      const email = (input.email ?? '').trim()
      if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) fail('invalid', `"${email}" is not a valid email address.`)
      if (email && state.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) fail('conflict', `A user with the email ${email} already exists.`)
      const roleIds = input.roleIds ?? (state.roles.find((r) => r.name === 'Viewer') ? [state.roles.find((r) => r.name === 'Viewer')!.id] : [])
      for (const r of roleIds) if (!state.roles.some((x) => x.id === r)) fail('not-found', `Role "${r}" was not found.`)
      const user: UserDef = { id: shortId('user'), name, email, roleIds: [...roleIds] }
      setState({ users: [...state.users, user] })
      await saveWorkspace()
      return user
    },
    async updateUser(id, patch) {
      const user = state.users.find((u) => u.id === id) ?? fail('not-found', `User "${id}" was not found.`)
      const next: UserDef = { ...user!, ...patch, id }
      if (typeof next.name !== 'string' || !next.name.trim()) fail('invalid', 'A user needs a name.')
      next.name = next.name.trim()
      next.email = (next.email ?? '').trim()
      if (next.email && !/^[^\s@]+@[^\s@]+$/.test(next.email)) fail('invalid', `"${next.email}" is not a valid email address.`)
      if (next.email && state.users.some((u) => u.id !== id && u.email.toLowerCase() === next.email.toLowerCase())) fail('conflict', `A user with the email ${next.email} already exists.`)
      for (const r of next.roleIds) if (!state.roles.some((x) => x.id === r)) fail('not-found', `Role "${r}" was not found.`)
      const users = state.users.map((u) => (u.id === id ? next : u))
      assertAdminRemains(users, state.roles)
      setState({ users }, id === state.currentUserId)
      await saveWorkspace()
    },
    async removeUser(id) {
      if (!state.users.some((u) => u.id === id)) fail('not-found', `User "${id}" was not found.`)
      const users = state.users.filter((u) => u.id !== id)
      assertAdminRemains(users, state.roles)
      let currentUserId = state.currentUserId
      if (currentUserId === id) {
        const adminRoles = new Set(state.roles.filter((r) => r.isAdmin).map((r) => r.id))
        currentUserId = (users.find((u) => u.roleIds.some((r) => adminRoles.has(r))) ?? users[0]).id
      }
      setState({ users, currentUserId }, currentUserId !== state.currentUserId)
      await saveWorkspace()
    },
  }

  const connectionsApi: PlatformApi['connections'] = {
    async create(input) {
      const name = (input.name ?? '').trim()
      if (!name) fail('invalid', 'A connection needs a name.')
      if (!CONNECTORS.includes(input.connector)) fail('invalid', `Unknown connector "${String(input.connector)}".`)
      if (state.connections.some((c) => c.name.toLowerCase() === name.toLowerCase())) fail('conflict', `A connection named "${name}" already exists.`)
      const conn: ConnectionRef = {
        id: shortId('conn'), name, connector: input.connector,
        status: input.connector === 'local-csv' ? 'connected' : 'not-configured', settings: { ...(input.settings ?? {}) },
      }
      setState({ connections: [...state.connections, conn] })
      await saveWorkspace()
      return conn
    },
    async update(id, patch) {
      const conn = state.connections.find((c) => c.id === id) ?? fail('not-found', `Connection "${id}" was not found.`)
      const next: ConnectionRef = { ...conn!, ...patch, id }
      if (!next.name.trim()) fail('invalid', 'A connection needs a name.')
      if (!CONNECTORS.includes(next.connector)) fail('invalid', `Unknown connector "${String(next.connector)}".`)
      if (state.connections.some((c) => c.id !== id && c.name.toLowerCase() === next.name.trim().toLowerCase())) fail('conflict', `A connection named "${next.name}" already exists.`)
      next.name = next.name.trim()
      // only the local CSV connector is functional in this phase
      if (next.connector !== 'local-csv') next.status = 'not-configured'
      setState({ connections: state.connections.map((c) => (c.id === id ? next : c)) })
      await saveWorkspace()
    },
    async test(id) {
      if (!state.connections.some((c) => c.id === id)) fail('not-found', `Connection "${id}" was not found.`)
      return { ok: false, message: 'Available with the local server' }
    },
    async setDefault() {
      return fail('unavailable', NEEDS_SERVER)
    },
    async remove(id) {
      if (!state.connections.some((c) => c.id === id)) fail('not-found', `Connection "${id}" was not found.`)
      const solutions = state.solutions.map((s) =>
        s.components.some((c) => c.kind === 'connection' && c.id === id) ? { ...s, components: s.components.filter((c) => !(c.kind === 'connection' && c.id === id)), modifiedOn: iso() } : s,
      )
      setState({ connections: state.connections.filter((c) => c.id !== id), solutions })
      await saveWorkspace()
    },
  }

  const componentExists = (kind: SolutionComponentKind, id: string) =>
    kind === 'app' ? state.apps.some((a) => a.id === id)
      : kind === 'table' ? tablesRt.has(id)
        : kind === 'role' ? state.roles.some((r) => r.id === id)
          : kind === 'file' ? state.dataFiles.some((f) => f.id === id)
          : state.connections.some((c) => c.id === id)

  const solutionsApi: PlatformApi['solutions'] = {
    async create(input) {
      const displayName = (input.displayName ?? '').trim()
      if (!displayName) fail('invalid', 'A solution needs a display name.')
      const now = iso()
      const sol: SolutionDef = {
        id: shortId('sol'),
        name: uniqueIdentifier(toIdentifier(displayName, 'Solution'), state.solutions.map((s) => s.name)),
        displayName, publisher: input.publisher?.trim() || userName(), version: input.version?.trim() || '1.0.0',
        ...(input.description ? { description: input.description } : {}),
        components: [], createdOn: now, modifiedOn: now,
      }
      setState({ solutions: [...state.solutions, sol] })
      await saveWorkspace()
      return sol
    },
    async update(id, patch) {
      const sol = state.solutions.find((s) => s.id === id) ?? fail('not-found', `Solution "${id}" was not found.`)
      const next: SolutionDef = { ...sol!, ...patch, id, components: sol!.components }
      if (!next.displayName.trim()) fail('invalid', 'A solution needs a display name.')
      if (!IDENT.test(next.name)) fail('invalid', `Solution name "${next.name}" is not a valid identifier.`)
      if (state.solutions.some((s) => s.id !== id && s.name.toLowerCase() === next.name.toLowerCase())) fail('conflict', `A solution named "${next.name}" already exists.`)
      next.modifiedOn = iso()
      setState({ solutions: state.solutions.map((s) => (s.id === id ? next : s)) })
      await saveWorkspace()
    },
    async remove(id) {
      if (!state.solutions.some((s) => s.id === id)) fail('not-found', `Solution "${id}" was not found.`)
      setState({ solutions: state.solutions.filter((s) => s.id !== id) })
      await saveWorkspace()
    },
    async addComponent(id, kind, componentId) {
      const sol = state.solutions.find((s) => s.id === id) ?? fail('not-found', `Solution "${id}" was not found.`)
      if (!KINDS.includes(kind)) fail('invalid', `Unknown component kind "${String(kind)}".`)
      if (!componentExists(kind, componentId)) fail('not-found', `The ${kind} "${componentId}" was not found.`)
      if (sol!.components.some((c) => c.kind === kind && c.id === componentId)) return
      const next = { ...sol!, components: [...sol!.components, { kind, id: componentId }], modifiedOn: iso() }
      setState({ solutions: state.solutions.map((s) => (s.id === id ? next : s)) })
      await saveWorkspace()
    },
    async removeComponent(id, kind, componentId) {
      const sol = state.solutions.find((s) => s.id === id) ?? fail('not-found', `Solution "${id}" was not found.`)
      const components = sol!.components.filter((c) => !(c.kind === kind && c.id === componentId))
      if (components.length === sol!.components.length) return
      setState({ solutions: state.solutions.map((s) => (s.id === id ? { ...sol!, components, modifiedOn: iso() } : s)) })
      await saveWorkspace()
    },

    async exportPackage(id, opts) {
      const sol = state.solutions.find((s) => s.id === id) ?? fail('not-found', `Solution "${id}" was not found.`)
      const ofKind = (k: SolutionComponentKind) => sol!.components.filter((c) => c.kind === k && componentExists(k, c.id)).map((c) => c.id)
      const tableRts = ofKind('table').map((tid) => tablesRt.get(tid)!)
      const tableIds = new Set(tableRts.map((t) => t.def.id))
      const appIds = ofKind('app')
      const appIdSet = new Set(appIds)
      const roles = ofKind('role').map((rid) => {
        const r = clone(state.roles.find((x) => x.id === rid)!)
        r.privileges = r.privileges.filter((p) => tableIds.has(p.table))
        if (Array.isArray(r.apps)) r.apps = r.apps.filter((a) => appIdSet.has(a))
        return r
      })
      const connections = ofKind('connection').map((cid) => clone(state.connections.find((c) => c.id === cid)!))
      return toYaml({
        kind: 'appbuilder/solution',
        packageVersion: PACKAGE_VERSION,
        exportedOn: iso(),
        solution: {
          name: sol!.name, displayName: sol!.displayName, publisher: sol!.publisher, version: sol!.version,
          ...(sol!.description ? { description: sol!.description } : {}),
        },
        apps: appIds.map(appEntry),
        tables: tableRts.map((rt) => tableEntry(rt, opts?.includeData === true)),
        roles,
        connections,
      })
    },

    async importPackage(yamlText) {
      const doc = parsePackage(yamlText, 'appbuilder/solution')
      if (!isObj(doc.solution) || typeof doc.solution.displayName !== 'string') fail('invalid', 'The package has no solution header.')
      const head = doc.solution as Record<string, unknown>
      const listOf = (v: unknown, what: string): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : fail('invalid', `The package "${what}" must be a list.`))
      // validate everything before creating anything
      const apps = listOf(doc.apps, 'apps').map(readPkgApp)
      const tables = readPkgTables(doc.tables)
      const roleDocs = listOf(doc.roles, 'roles').map((r) => {
        if (!isObj(r) || typeof r.name !== 'string' || !r.name.trim()) return fail('invalid', 'A role in the package is malformed.')
        return r as unknown as RoleDef
      })
      const connDocs = listOf(doc.connections, 'connections').map((c) => {
        if (!isObj(c) || typeof c.name !== 'string' || !CONNECTORS.includes(c.connector as ConnectorKind)) return fail('invalid', 'A connection in the package is malformed.')
        return c as unknown as ConnectionRef
      })

      const tableMap = await ensurePkgTables(tables)
      const appMap = new Map<string, string>()
      const components: SolutionDef['components'] = []
      for (const t of tables) components.push({ kind: 'table', id: tableMap.get(t.def.id)! })
      for (const a of apps) {
        const meta = await addApp(a.def, uniqueLabel(a.name, state.apps.map((x) => x.name)), a.description)
        if (a.oldId) appMap.set(a.oldId, meta.id)
        components.push({ kind: 'app', id: meta.id })
      }
      const newRoles: RoleDef[] = []
      for (const r of roleDocs) {
        const privileges = (Array.isArray(r.privileges) ? r.privileges : [])
          .filter((p) => isObj(p) && tableMap.has(p.table))
          .map((p) => ({ table: tableMap.get(p.table)!, create: p.create === true, read: p.read ?? 'none', update: p.update ?? 'none', delete: p.delete ?? 'none' }) as TablePrivilege)
        const role: RoleDef = {
          id: shortId('role'),
          name: uniqueLabel(r.name.trim(), [...state.roles, ...newRoles].map((x) => x.name)),
          ...(typeof r.description === 'string' && r.description ? { description: r.description } : {}),
          ...(r.isAdmin ? { isAdmin: true } : {}),
          privileges,
          apps: r.apps === 'all' ? 'all' : (Array.isArray(r.apps) ? r.apps : []).map((a) => appMap.get(a)).filter((a): a is string => !!a),
        }
        newRoles.push(role)
        components.push({ kind: 'role', id: role.id })
      }
      const newConns: ConnectionRef[] = []
      for (const c of connDocs) {
        const conn: ConnectionRef = {
          id: shortId('conn'), name: uniqueLabel(c.name.trim(), [...state.connections, ...newConns].map((x) => x.name)),
          connector: c.connector, status: c.connector === 'local-csv' ? 'connected' : 'not-configured', settings: isObj(c.settings) ? { ...(c.settings as Record<string, string>) } : {},
        }
        newConns.push(conn)
        components.push({ kind: 'connection', id: conn.id })
      }
      const now = iso()
      const displayName = uniqueLabel(String(head.displayName).trim() || 'Imported solution', state.solutions.map((s) => s.displayName))
      const sol: SolutionDef = {
        id: shortId('sol'),
        name: uniqueIdentifier(toIdentifier(typeof head.name === 'string' && head.name ? head.name : displayName, 'Solution'), state.solutions.map((s) => s.name)),
        displayName,
        publisher: typeof head.publisher === 'string' && head.publisher ? head.publisher : userName(),
        version: typeof head.version === 'string' && head.version ? head.version : '1.0.0',
        ...(typeof head.description === 'string' && head.description ? { description: head.description } : {}),
        components, createdOn: now, modifiedOn: now,
      }
      setState({ roles: [...state.roles, ...newRoles], connections: [...state.connections, ...newConns], solutions: [...state.solutions, sol] }, newRoles.length > 0)
      await saveWorkspace()
      return sol
    },
  }

  const authApi: PlatformApi['auth'] = {
    async login() {
      return state.session ?? fail('unavailable', 'Sign-in needs the local server.')
    },
    async logout() {
      /* demo mode: the run-as user stays */
    },
    async changePassword() {
      /* no passwords in demo mode */
    },
    async setupDatabase() {
      return fail('unavailable', 'Sign-in needs the local server')
    },
    async setupAdmin() {
      return fail('unavailable', 'Sign-in needs the local server')
    },
  }

  /* ------------------------------------------------------------------ attachments (data URLs in storage) */

  const DEFAULT_MAX_MB = 25
  const mimeMatches = (mime: string, accept: string[]) =>
    accept.length === 0 || accept.some((a) => (a.endsWith('/*') ? mime.startsWith(a.slice(0, -1)) : a.toLowerCase() === mime.toLowerCase()))

  async function toDataUrl(file: Blob, mime: string): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return `data:${mime};base64,${btoa(bin)}`
  }
  const refOf = (a: AttachmentRef & { dataUrl: string }): AttachmentRef => ({ id: a.id, fileName: a.fileName, mime: a.mime, sizeBytes: a.sizeBytes, url: a.dataUrl })

  const attachmentsApi: PlatformApi['attachments'] = {
    async upload(tableName, column, rowId, file) {
      const rt = needTable(tableName)
      const col = findColumn(rt.def, column)
      if (!col || (col.type !== 'file' && col.type !== 'image')) fail('invalid', `"${column}" is not a file or image column.`)
      const row = rt.rows.find((r) => r.id === rowId) ?? fail('not-found', `No row with id "${rowId}" in "${rt.def.displayName}".`)
      const g = privilege(rt.def)
      if (g.update === 'none' || !rowTester(rt.def, 'update')(row!)) deny('update', rt)
      assertWritable(rt, g, [col!.name])
      const mime = file.type || 'application/octet-stream'
      const limitMB = col!.maxSizeMB ?? DEFAULT_MAX_MB
      if (file.size > limitMB * 1024 * 1024) fail('invalid', `${file.name} is larger than ${limitMB} MB.`)
      if (!mimeMatches(mime, col!.accept ?? [])) fail('invalid', `${file.name} (${mime}) is not an accepted file type for ${col!.displayName}.`)
      const id = `att_${uuid().replace(/-/g, '')}`
      const dataUrl = await toDataUrl(file, mime)
      const rec = { id, fileName: file.name, mime, sizeBytes: file.size, url: dataUrl, dataUrl }
      attachmentStore.set(id, rec)
      await st().writeText(`attachments/${id}.json`, JSON.stringify({ ...rec, tableId: rt.def.id, column: col!.name, rowId }))
      // link it to the cell (single: the id; multiple: appended to the JSON array of ids)
      const cur = rt.rows.find((r) => r.id === rowId)?.[col!.name]
      let value: string = id
      if (col!.multiple) {
        let ids: string[] = []
        if (typeof cur === 'string' && cur) {
          try {
            const parsed: unknown = JSON.parse(cur)
            ids = Array.isArray(parsed) ? parsed.map(String) : [cur]
          } catch {
            ids = [cur]
          }
        }
        value = JSON.stringify([...ids, id])
      }
      rt.rows = rt.rows.map((r) => (r.id === rowId ? { ...r, [col!.name]: value } : r))
      markFileModified(rt.def)
      setState({}, true)
      saveTableLater(rt.def.name)
      return refOf(rec)
    },
    async resolve(ids) {
      return ids.map((id) => attachmentStore.get(id)).filter((a): a is AttachmentRef & { dataUrl: string } => !!a).map(refOf)
    },
    url(id) {
      return attachmentStore.get(id)?.dataUrl ?? ''
    },
    async remove(id) {
      if (!attachmentStore.delete(id)) fail('not-found', 'Attachment not found.')
      await st().remove(`attachments/${id}.json`)
    },
  }

  /* ------------------------------------------------------------------ data files (parsed client-side) */

  const FILES_CONNECTION = 'conn_files'
  interface ParsedFileTable { name: string; csv: string }

  function parseDataFile(name: string, text: string, kind: 'csv' | 'json', displayName?: string): ParsedFileTable[] {
    const base = (displayName ?? name.replace(/\.[^.]+$/, '')).trim() || 'Data'
    if (kind === 'csv') return [{ name: base, csv: text }]
    let doc: unknown
    try {
      doc = JSON.parse(text)
    } catch (e) {
      return fail('invalid', `${name} is not valid JSON: ${(e as Error).message}`)
    }
    const flat = (arr: unknown[]) =>
      Papa.unparse(arr.map((o) => {
        if (!isObj(o)) return { value: o as unknown }
        return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v]))
      }) as object[], { newline: '\n' })
    if (Array.isArray(doc)) return [{ name: base, csv: flat(doc) }]
    if (isObj(doc)) {
      const out = Object.entries(doc).filter(([, v]) => Array.isArray(v)).map(([k, v]) => ({ name: k, csv: flat(v as unknown[]) }))
      if (out.length) return out
    }
    return fail('invalid', 'A JSON data file must hold an array of objects (or an object whose values are arrays).')
  }

  async function checksumOf(text: string): Promise<string> {
    try {
      const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle
      if (subtle) {
        const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text))
        return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
      }
    } catch { /* fall through */ }
    let h = 2166136261
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
    return (h >>> 0).toString(16).padStart(8, '0')
  }

  async function readDataFile(file: File, displayName?: string): Promise<{ kind: 'csv' | 'json'; text: string; tables: ParsedFileTable[] }> {
    const ext = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1]?.toLowerCase()
    if (ext === 'xlsx' || ext === 'xls') return fail('unavailable', 'Excel files need the local server')
    if (ext !== 'csv' && ext !== 'json') return fail('invalid', 'Only .csv, .xlsx and .json data files are supported.')
    const text = await file.text()
    return { kind: ext, text, tables: parseDataFile(file.name, text, ext, displayName) }
  }

  async function ensureFilesConnection() {
    if (state.connections.some((c) => c.id === FILES_CONNECTION)) return
    const conn: ConnectionRef = { id: FILES_CONNECTION, name: 'Data files', connector: 'files', status: 'connected', settings: {}, scope: 'device' }
    setState({ connections: [...state.connections, conn] })
    await saveWorkspace()
  }

  const filesApi: PlatformApi['files'] = {
    async add(file, opts) {
      const parsed = await readDataFile(file, opts?.displayName)
      await ensureFilesConnection()
      const fileId = shortId('file')
      const importedOn = iso()
      const tableIds: string[] = []
      for (const t of parsed.tables) {
        const def = await createTableFromCsv(t.name, t.csv, {
          connectionId: FILES_CONNECTION,
          origin: { kind: 'file', fileId, fileName: file.name, ...(parsed.tables.length > 1 ? { sheet: t.name } : {}), importedOn },
        })
        tableIds.push(def.id)
      }
      const def: DataFileDef = {
        id: fileId, connectionId: FILES_CONNECTION, fileName: file.name, kind: parsed.kind, sizeBytes: file.size,
        checksum: await checksumOf(parsed.text), importedOn, tableIds, modifiedSinceImport: false,
      }
      setState({ dataFiles: [...state.dataFiles, def] })
      await saveWorkspace()
      return def
    },

    async replace(fileId, file) {
      const old = state.dataFiles.find((f) => f.id === fileId) ?? fail('not-found', 'Data file not found.')
      const parsed = await readDataFile(file)
      if (parsed.kind !== old!.kind) fail('invalid', `The replacement must be a .${old!.kind} file.`)
      const importedOn = iso()
      const tableIds: string[] = []
      for (const t of parsed.tables) {
        const existing = old!.tableIds
          .map((id) => tablesRt.get(id))
          .find((rt) => rt && (rt.def.origin?.sheet ?? rt.def.displayName) === t.name) ?? (parsed.tables.length === 1 ? old!.tableIds.map((id) => tablesRt.get(id)).find(Boolean) : undefined)
        if (existing) {
          const res = importRows(existing, t.csv, 'replace', { preserve: true, checkLookups: false })
          existing.rows = res.rows
          existing.counters = res.counters
          existing.def = { ...existing.def, ...(existing.def.origin ? { origin: { ...existing.def.origin, fileName: file.name, importedOn } } : {}), modifiedOn: importedOn }
          await saveTable(existing.def.name)
          tableIds.push(existing.def.id)
        } else {
          const def = await createTableFromCsv(t.name, t.csv, {
            connectionId: FILES_CONNECTION,
            origin: { kind: 'file', fileId, fileName: file.name, ...(parsed.tables.length > 1 ? { sheet: t.name } : {}), importedOn },
          })
          tableIds.push(def.id)
        }
      }
      const next: DataFileDef = { ...old!, fileName: file.name, sizeBytes: file.size, checksum: await checksumOf(parsed.text), importedOn, tableIds, modifiedSinceImport: false }
      syncTables()
      setState({ dataFiles: state.dataFiles.map((f) => (f.id === fileId ? next : f)) })
      await saveWorkspace()
      return next
    },

    async download(fileId) {
      const f = state.dataFiles.find((x) => x.id === fileId) ?? fail('not-found', 'Data file not found.')
      const rts = f!.tableIds.map((id) => tablesRt.get(id)).filter((t): t is TableRt => !!t)
      if (f!.kind === 'csv') {
        const rt = rts[0] ?? fail('not-found', 'The table of this file no longer exists.')
        return new Blob([rowsToCsv(rt!.def.columns, rt!.rows)], { type: 'text/csv' })
      }
      const plain = (rt: TableRt) => rt.rows.map((r) => Object.fromEntries(rt.def.columns.filter((c) => !c.system).map((c) => [c.name, r[c.name] instanceof Date ? serializeValue(c, r[c.name]) : r[c.name]])))
      const doc = rts.length === 1 && !rts[0].def.origin?.sheet ? plain(rts[0]) : Object.fromEntries(rts.map((rt) => [rt.def.origin?.sheet ?? rt.def.name, plain(rt)]))
      return new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
    },

    async remove(fileId, opts) {
      const f = state.dataFiles.find((x) => x.id === fileId) ?? fail('not-found', 'Data file not found.')
      for (const id of f!.tableIds) {
        const rt = tablesRt.get(id)
        if (!rt) continue
        if (opts?.dropTables) await tablesApi.remove(id)
        else {
          const { origin: _o, ...rest } = rt.def
          void _o
          rt.def = { ...rest }
          syncTables()
          await saveTable(rt.def.name)
        }
      }
      const solutions = state.solutions.map((s2) =>
        s2.components.some((c) => c.kind === 'file' && c.id === fileId) ? { ...s2, components: s2.components.filter((c) => !(c.kind === 'file' && c.id === fileId)), modifiedOn: iso() } : s2,
      )
      setState({ dataFiles: state.dataFiles.filter((x) => x.id !== fileId), solutions })
      await saveWorkspace()
    },
  }

  return {
    init,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    apps: appsApi,
    tables: tablesApi,
    security: securityApi,
    connections: connectionsApi,
    solutions: solutionsApi,
    auth: authApi,
    attachments: attachmentsApi,
    files: filesApi,
    onDataError: () => () => {},
  }
}

