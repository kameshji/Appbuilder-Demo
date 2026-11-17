/**
 * PLATFORM CONTRACT. Workspace = everything the maker owns on this machine: apps, tables (CSV),
 * security roles, users, connection references, solutions. Implemented in src/platform,
 * consumed by src/portal (home/maker portal UI), src/studio + src/runtime, and a few controls.
 * Binding. Do not change without the architect.
 */
import type { AppDef, FxRecord, FxValue } from '@/contracts'

/* ------------------------------------------------------------------ storage */

/**
 * Where the workspace lives. Paths are forward-slash, relative to the workspace root.
 *  - 'local-folder': the Node server in /server reads/writes real files in ./workspace
 *     (tables are real .csv files a human can open in Excel). Used with `npm run dev` / `npm start`.
 *  - 'browser': IndexedDB (fallback when the local server is not reachable, e.g. the hosted demo).
 * Workspace layout:
 *   workspace.yaml                 users, roles, connections, solutions, current user
 *   apps/<appId>.app.yaml          AppMeta + AppDef
 *   tables/<name>.schema.yaml      TableDef
 *   tables/<name>.csv              rows (header = column names; RFC 4180)
 */
export interface StorageAdapter {
  kind: 'local-folder' | 'browser'
  /** human-readable location, e.g. absolute folder path or "Browser storage" */
  location: string
  readText(path: string): Promise<string | null>
  writeText(path: string, text: string): Promise<void>
  remove(path: string): Promise<void>
  /** file names (not paths) directly inside dir; [] when dir is missing */
  list(dir: string): Promise<string[]>
}

/* ------------------------------------------------------------------ tables */

export type ColumnType =
  | 'text' | 'multiline' | 'email' | 'url' | 'phone'
  | 'number' | 'decimal' | 'currency'
  | 'boolean' | 'date' | 'datetime'
  | 'choice' | 'lookup' | 'image' | 'autonumber'

export interface ColumnDef {
  /** identifier-safe, used in formulas and as the CSV header */
  name: string
  displayName: string
  type: ColumnType
  required?: boolean
  unique?: boolean
  /** literal default as text ("0", "true", "Open") */
  default?: string
  /** type 'choice' */
  choices?: string[]
  /** type 'lookup': target table name; the cell stores the target row id */
  lookupTable?: string
  /** type 'autonumber': e.g. "INV-" -> INV-0001 */
  prefix?: string
  /** system columns cannot be edited or removed: id, createdOn, modifiedOn, createdBy, owner */
  system?: boolean
}

export interface TableDef {
  id: string
  /** identifier-safe, unique, used in formulas (Filter(Orders, ...)) and as the file name */
  name: string
  displayName: string
  description?: string
  /** column shown for a row in lookups and titles */
  primaryColumn: string
  columns: ColumnDef[]
  createdOn: string
  modifiedOn: string
}

/**
 * A row as formulas see it. Typed values: number/decimal/currency -> number, boolean -> boolean,
 * date/datetime -> Date, everything else -> string; empty cell -> null (blank).
 * Always carries '__id' (same value as 'id').
 */
export type Row = FxRecord

/* ------------------------------------------------------------------ apps */

export interface AppMeta {
  id: string
  name: string
  description?: string
  width: number
  height: number
  createdOn: string
  modifiedOn: string
  modifiedBy: string
}

/* ------------------------------------------------------------------ security */

export type AccessScope = 'none' | 'own' | 'all'
export interface TablePrivilege {
  /** table id */
  table: string
  create: boolean
  read: AccessScope
  update: AccessScope
  delete: AccessScope
}
export interface RoleDef {
  id: string
  name: string
  description?: string
  /** full access to everything; cannot be deleted when it is the last admin role */
  isAdmin?: boolean
  privileges: TablePrivilege[]
  /** app ids the role may run, or 'all' */
  apps: string[] | 'all'
}
export interface UserDef {
  id: string
  name: string
  email: string
  roleIds: string[]
}
export type DataOp = 'create' | 'read' | 'update' | 'delete'

/* ------------------------------------------------------------------ connections, solutions */

export type ConnectorKind = 'local-csv' | 'rest' | 'postgres' | 'mysql' | 'sqlserver' | 'supabase' | 'firebase' | 'excel'
export interface ConnectionRef {
  id: string
  name: string
  connector: ConnectorKind
  /** only 'local-csv' is functional in this phase; others are placeholders */
  status: 'connected' | 'not-configured'
  settings: Record<string, string>
}

export type SolutionComponentKind = 'app' | 'table' | 'role' | 'connection'
export interface SolutionDef {
  id: string
  /** identifier-safe */
  name: string
  displayName: string
  publisher: string
  version: string
  description?: string
  components: { kind: SolutionComponentKind; id: string }[]
  createdOn: string
  modifiedOn: string
}

/* ------------------------------------------------------------------ state + api */

export interface WorkspaceState {
  ready: boolean
  storage: { kind: StorageAdapter['kind']; location: string }
  apps: AppMeta[]
  tables: TableDef[]
  roles: RoleDef[]
  users: UserDef[]
  currentUserId: string
  connections: ConnectionRef[]
  solutions: SolutionDef[]
  /** bumps whenever any table's rows change (for re-render / re-evaluation) */
  dataVersion: number
}

export class PlatformError extends Error {
  code: 'not-found' | 'denied' | 'invalid' | 'conflict' | 'storage'
  constructor(code: PlatformError['code'], message: string) {
    super(message)
    this.code = code
  }
}

export interface PlatformApi {
  /** load the workspace (idempotent). Seeds a sample workspace on first run. */
  init(): Promise<void>
  getState(): WorkspaceState
  /** fires after every state change */
  subscribe(listener: () => void): () => void

  apps: {
    /** creates an app with one empty screen. template 'sample' = the Contacts sample app. */
    create(input: { name: string; width: number; height: number; template?: 'blank' | 'sample' }): Promise<AppMeta>
    load(id: string): Promise<AppDef | null>
    /** persists the definition (debounce is the caller's job) and updates modifiedOn */
    save(id: string, def: AppDef): Promise<void>
    rename(id: string, name: string): Promise<void>
    duplicate(id: string): Promise<AppMeta>
    remove(id: string): Promise<void>
    /**
     * Portable package: YAML text with the app definition plus the schemas of the tables it uses
     * (and optionally their rows). Importing always creates a NEW app instance (new id, unique name);
     * missing tables are created, existing tables with the same name are reused.
     */
    exportPackage(id: string, opts?: { includeData?: boolean }): Promise<string>
    importPackage(yamlText: string): Promise<AppMeta>
  }

  tables: {
    create(input: { displayName: string; name?: string; description?: string; columns?: Partial<ColumnDef>[] }): Promise<TableDef>
    update(id: string, patch: Partial<Pick<TableDef, 'displayName' | 'description' | 'primaryColumn'>>): Promise<void>
    remove(id: string): Promise<void>
    addColumn(tableId: string, col: Partial<ColumnDef> & { displayName: string; type: ColumnType }): Promise<ColumnDef>
    updateColumn(tableId: string, name: string, patch: Partial<ColumnDef>): Promise<void>
    removeColumn(tableId: string, name: string): Promise<void>
    /** by name or id; undefined when missing */
    get(nameOrId: string): TableDef | undefined

    /**
     * Synchronous reads from the in-memory cache (all tables are loaded at init).
     * `secure: true` (default) applies the current user's read scope; false = raw (portal admin grid).
     */
    rows(tableName: string, opts?: { secure?: boolean }): Row[]
    /**
     * Synchronous writes to the cache + async persist to CSV. Throw PlatformError('denied') when the
     * current user's role does not allow it (unless secure:false), PlatformError('invalid') on
     * required/unique/type violations. Values are coerced to the column types.
     */
    insert(tableName: string, values: FxRecord, opts?: { secure?: boolean }): Row
    update(tableName: string, id: string, changes: FxRecord, opts?: { secure?: boolean }): Row
    delete(tableName: string, ids: string[], opts?: { secure?: boolean }): void
    /** re-read the CSV from storage */
    reload(tableName: string): Promise<void>
    /** CSV text of the whole table (header + rows) */
    exportCsv(tableName: string): string
    /** mode 'append' adds rows; 'replace' clears first. Unknown columns are ignored; returns rows imported. */
    importCsv(tableName: string, csvText: string, mode: 'append' | 'replace'): Promise<number>
    /** create a new table from a CSV file: infer column names and types */
    createFromCsv(displayName: string, csvText: string): Promise<TableDef>
    /** resolves when all pending CSV writes are flushed */
    flush(): Promise<void>
  }

  security: {
    currentUser(): UserDef
    setCurrentUser(userId: string): void
    /** may the current user perform op on this table (and on this row, when given)? */
    can(tableName: string, op: DataOp, row?: Row): boolean
    canRunApp(appId: string): boolean
    createRole(input: { name: string; description?: string }): Promise<RoleDef>
    updateRole(id: string, patch: Partial<Omit<RoleDef, 'id'>>): Promise<void>
    removeRole(id: string): Promise<void>
    createUser(input: { name: string; email: string; roleIds?: string[] }): Promise<UserDef>
    updateUser(id: string, patch: Partial<Omit<UserDef, 'id'>>): Promise<void>
    removeUser(id: string): Promise<void>
  }

  connections: {
    create(input: { name: string; connector: ConnectorKind; settings?: Record<string, string> }): Promise<ConnectionRef>
    update(id: string, patch: Partial<Omit<ConnectionRef, 'id'>>): Promise<void>
    remove(id: string): Promise<void>
  }

  solutions: {
    create(input: { displayName: string; publisher?: string; version?: string; description?: string }): Promise<SolutionDef>
    update(id: string, patch: Partial<Omit<SolutionDef, 'id' | 'components'>>): Promise<void>
    remove(id: string): Promise<void>
    addComponent(id: string, kind: SolutionComponentKind, componentId: string): Promise<void>
    removeComponent(id: string, kind: SolutionComponentKind, componentId: string): Promise<void>
    /** YAML package with every component (apps, table schemas [+ rows], roles, connection refs) */
    exportPackage(id: string, opts?: { includeData?: boolean }): Promise<string>
    /** creates new instances of everything inside and a new solution; returns it */
    importPackage(yamlText: string): Promise<SolutionDef>
  }
}

/** Convenience for formulas: User() record. */
export function userRecord(u: UserDef, roles: RoleDef[]): FxRecord {
  const names: FxValue[] = roles.filter((r) => u.roleIds.includes(r.id)).map((r) => ({ Value: r.name }))
  return { FullName: u.name, Email: u.email, Id: u.id, Roles: names }
}
