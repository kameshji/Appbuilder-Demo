/**
 * PLATFORM CONTRACT. Workspace = everything the maker owns on this machine: apps, tables (CSV),
 * security roles, users, connection references, solutions. Implemented in src/platform,
 * consumed by src/portal (home/maker portal UI), src/studio + src/runtime, and a few controls.
 * Binding. Do not change without the architect.
 */
import type { AppDef, FxRecord, FxValue } from '../contracts.ts'

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
  /** attachment: the cell holds an attachment id (or a JSON array of ids when `multiple`); files live in the attachment store */
  | 'file'

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
  /** type 'file' / 'image': allow several attachments (cell = JSON array of attachment ids) */
  multiple?: boolean
  /** type 'file' / 'image': accepted MIME patterns, e.g. ["image/*", "application/pdf"]; empty = any */
  accept?: string[]
  /** type 'file' / 'image': per-file limit in MB (server default 25) */
  maxSizeMB?: number
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
  /** connection that physically stores the rows. Default connection id: 'conn_default' (on-device MySQL). */
  connectionId?: string
  /** physical name inside the connection (MySQL table, file sheet, Google sheet tab). Default derived from name. */
  source?: string
  /** true when the source cannot be written through this connection (e.g. a read-only file or view) */
  readOnly?: boolean
  /** set for tables that came from a data file (files connector) */
  origin?: { kind: 'file'; fileId: string; fileName: string; sheet?: string; importedOn: string }
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

/** Column-level security for one column within one role: none = hidden, read = visible but not writable, update = full. */
export type ColumnAccess = 'none' | 'read' | 'update'

/**
 * Row-level security condition (structured, never SQL text). Value tokens resolved on the server:
 * '@me' = current user id, '@myEmail' = current user's email. All conditions of one privilege are ANDed.
 */
export interface RowCondition {
  column: string
  op: 'eq' | 'ne' | 'in' | 'contains' | 'startsWith' | 'lt' | 'le' | 'gt' | 'ge' | 'isBlank' | 'notBlank'
  value?: string | number | boolean | Array<string | number>
}

export interface TablePrivilege {
  /** table id */
  table: string
  create: boolean
  read: AccessScope
  update: AccessScope
  delete: AccessScope
  /** CLS: per column name. Missing column = 'update' (full). Ignored for admin roles. */
  columns?: Record<string, ColumnAccess>
  /** RLS: extra conditions a row must meet for this role's read/update/delete scope to apply. */
  rowFilter?: RowCondition[]
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
  /** server mode: disabled users cannot sign in. Default 'active'. */
  status?: 'active' | 'disabled'
  /** server mode: whether a password is set (the hash never leaves the server) */
  hasPassword?: boolean
  lastLogin?: string
}

/**
 * What the signed-in user may do, computed by the server (authoritative) and mirrored in the client
 * for UX only (disable buttons, pre-validate). Keyed by table id.
 */
export interface EffectivePrivileges {
  isAdmin: boolean
  /** may create/edit apps, tables, connections (Maker or Admin) */
  isMaker: boolean
  tables: Record<string, {
    create: boolean
    read: AccessScope
    update: AccessScope
    delete: AccessScope
    /** effective CLS after the union over roles; columns missing here are 'update' */
    columns: Record<string, ColumnAccess>
    /** true when at least one granting role carries a rowFilter (the client cannot fully mirror RLS) */
    filtered: boolean
  }>
  apps: string[] | 'all'
}

export interface Session {
  user: UserDef
  privileges: EffectivePrivileges
  expiresOn: string
}
export type DataOp = 'create' | 'read' | 'update' | 'delete'

/* ------------------------------------------------------------------ connections, solutions */

/**
 * Functional connectors: 'mysql' (on-device or remote MySQL/MariaDB), 'files' (CSV / Excel .xlsx / JSON data
 * files copied into the workspace's designated files folder; device-only), 'gsheets' (Google Sheets via a
 * service account). 'php-gateway' is the next phase (hosted MySQL behind a PHP API). Others are placeholders.
 * 'local-csv' is the legacy demo-mode connector.
 */
export type ConnectorKind =
  | 'mysql' | 'files' | 'gsheets' | 'php-gateway'
  | 'local-csv' | 'rest' | 'postgres' | 'sqlserver' | 'supabase' | 'firebase' | 'excel'
export interface ConnectionRef {
  id: string
  name: string
  connector: ConnectorKind
  status: 'connected' | 'error' | 'not-configured'
  /** non-secret settings (host, port, database, user, spreadsheetId, ...). Secrets are never sent to the client. */
  settings: Record<string, string>
  /** a secret (password, service-account key) is stored server-side, encrypted */
  hasSecret?: boolean
  /** the workspace's default store for new tables (exactly one) */
  isDefault?: boolean
  /** 'device' = only meaningful on this machine (files connector); excluded from hosting unless packaged in a solution */
  scope?: 'device' | 'server'
  lastError?: string
}

/** A data file managed by the files connector (a copy lives in the designated files folder; the original is never touched). */
export interface DataFileDef {
  id: string
  connectionId: string
  fileName: string
  kind: 'csv' | 'xlsx' | 'json'
  sizeBytes: number
  checksum: string
  importedOn: string
  /** tables created from this file (one per sheet for xlsx) */
  tableIds: string[]
  /** rows changed through apps since the last import/replace */
  modifiedSinceImport: boolean
}

/** Reference to a stored attachment (what a 'file'/'image' cell resolves to on the client). */
export interface AttachmentRef {
  id: string
  fileName: string
  mime: string
  sizeBytes: number
  /** same-origin URL that streams the file after a server-side permission check */
  url: string
}

export type SolutionComponentKind = 'app' | 'table' | 'role' | 'connection' | 'file'
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
  /** 'server' = the local Node server (MySQL, real login, server-enforced security); 'demo' = browser-only simulation */
  mode: 'server' | 'demo'
  /** server mode first-run state. Both false once the workspace is usable. */
  setup: { needsDatabase: boolean; needsAdmin: boolean }
  /** null when signed out (server mode). Demo mode: always the run-as user. */
  session: Session | null
  storage: { kind: StorageAdapter['kind'] | 'mysql'; location: string }
  apps: AppMeta[]
  tables: TableDef[]
  roles: RoleDef[]
  users: UserDef[]
  currentUserId: string
  connections: ConnectionRef[]
  solutions: SolutionDef[]
  dataFiles: DataFileDef[]
  /** bumps whenever any table's rows change (for re-render / re-evaluation) */
  dataVersion: number
  /** tables whose rows are currently loading from the server (names) */
  loading: string[]
  /** tables whose query hit the row cap (names); the UI warns that data is truncated */
  truncated: string[]
}

export class PlatformError extends Error {
  code: 'not-found' | 'denied' | 'invalid' | 'conflict' | 'storage' | 'unauthenticated' | 'unavailable'
  constructor(code: PlatformError['code'], message: string) {
    super(message)
    this.code = code
  }
}

/** Reported for every server-side write failure after an optimistic local change was rolled back. */
export interface DataErrorEvent {
  table: string
  op: 'create' | 'update' | 'delete'
  rowIds: string[]
  error: PlatformError
}

export interface PlatformApi {
  /** load the workspace (idempotent). Server mode: loads metadata + the session; demo mode seeds a sample workspace on first run. */
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
    /** resolves when all pending writes are persisted; rejects with the first PlatformError among them */
    flush(): Promise<void>
    /**
     * Make sure the rows of these tables are loaded into the cache (server mode loads lazily, on first use).
     * rows() of an unloaded table returns [] and schedules a load; subscribe() fires when it arrives.
     */
    ensureLoaded(tableNames: string[]): Promise<void>
    /** list tables available inside a connection that are not yet registered (existing MySQL tables, sheets, file sheets) */
    listSourceTables(connectionId: string): Promise<{ source: string; columns: { name: string; type: ColumnType }[]; rowCount?: number }[]>
    /** register an existing source table as a workspace table (columns inferred; system columns added where the source allows) */
    linkSourceTable(connectionId: string, source: string, input?: { displayName?: string; name?: string }): Promise<TableDef>
    /** copy a table into another connection (e.g. a file table into MySQL), keeping its name so formulas keep working */
    moveToConnection(tableId: string, connectionId: string): Promise<TableDef>
  }

  /**
   * Server mode authentication. In demo mode login/logout are no-ops and currentUser() is the run-as user.
   * Writes in server mode are optimistic: insert/update/delete change the cache synchronously after client-side
   * pre-validation (schema + mirrored privileges); the server is authoritative. On rejection the change is rolled
   * back and onDataError listeners are told.
   */
  auth: {
    login(email: string, password: string): Promise<Session>
    logout(): Promise<void>
    changePassword(current: string, next: string): Promise<void>
    /** first-run: the database connection for the default store (server tests it, creates the system tables) */
    setupDatabase(input: { host: string; port: number; database: string; user: string; password: string; createDatabase?: boolean }): Promise<void>
    /** first-run: create the first administrator and sign in */
    setupAdmin(input: { name: string; email: string; password: string }): Promise<Session>
  }

  /** subscribe to rolled-back writes (server mode). Returns unsubscribe. */
  onDataError(listener: (e: DataErrorEvent) => void): () => void

  attachments: {
    /** upload a file for a 'file'/'image' column of a row (the row must exist; uploading needs update access to that column) */
    upload(tableName: string, column: string, rowId: string, file: File): Promise<AttachmentRef>
    /** resolve attachment ids (from cells) to refs; unknown or forbidden ids are omitted */
    resolve(ids: string[]): Promise<AttachmentRef[]>
    /** synchronous URL for an id (no metadata); same-origin, permission-checked when fetched */
    url(id: string): string
    remove(id: string): Promise<void>
  }

  files: {
    /** copy a data file (csv / xlsx / json) into the designated folder and create one table per sheet */
    add(file: File, opts?: { displayName?: string }): Promise<DataFileDef>
    /** replace the stored copy with a newer version of the file (rows edited since import are overwritten) */
    replace(fileId: string, file: File): Promise<DataFileDef>
    /** current contents (including edits made through apps) as a file the user can save */
    download(fileId: string): Promise<Blob>
    remove(fileId: string, opts?: { dropTables?: boolean }): Promise<void>
  }

  security: {
    currentUser(): UserDef
    /** demo mode only (run-as); server mode throws PlatformError('denied') */
    setCurrentUser(userId: string): void
    /** server mode, admin: set or reset a user's password (the admin types it; it is never shown again) */
    setPassword(userId: string, password: string): Promise<void>
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
    /** secret: password (mysql) or service-account key JSON text (gsheets); stored encrypted on the server */
    create(input: { name: string; connector: ConnectorKind; settings?: Record<string, string>; secret?: string }): Promise<ConnectionRef>
    update(id: string, patch: Partial<Omit<ConnectionRef, 'id' | 'hasSecret'>> & { secret?: string }): Promise<void>
    remove(id: string): Promise<void>
    test(id: string): Promise<{ ok: boolean; message: string }>
    /** make this connection the default store for new tables (mysql only) */
    setDefault(id: string): Promise<void>
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
