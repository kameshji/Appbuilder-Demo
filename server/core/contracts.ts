/**
 * SERVER CONTRACT (internal). TypeScript run directly by Node (type stripping): erasable syntax only
 * (no enums, no parameter properties, no namespaces), relative imports with explicit `.ts` extensions,
 * type-only imports with `import type`. Never import '@/...' at runtime from server code.
 * Binding; architect-owned. Read docs/SPEC3.md first.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  AppMeta, AttachmentRef, ColumnDef, ConnectionRef, ConnectorKind, DataFileDef, EffectivePrivileges,
  RoleDef, Session, SolutionDef, TableDef, UserDef,
} from '../../src/platform/contracts.ts'
import type { AppDef } from '../../src/contracts.ts'
import type { Condition, Query, QueryValue } from '../../src/platform/http.ts'

/* ------------------------------------------------------------------ http */

export type ApiErrorCode = 'unauthenticated' | 'denied' | 'not-found' | 'conflict' | 'invalid' | 'unavailable' | 'storage'

/** Throw from anywhere in a request; the router turns it into { error: { code, message, field? } }. */
export class HttpError extends Error {
  status: number
  code: ApiErrorCode
  field?: string
  constructor(status: number, code: ApiErrorCode, message: string, field?: string) {
    super(message)
    this.status = status
    this.code = code
    this.field = field
  }
}

export type AuthLevel = 'none' | 'user' | 'maker' | 'admin'

export interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  method: string
  path: string
  params: Record<string, string>
  query: URLSearchParams
  /** parsed JSON body (undefined for GET / raw routes) */
  body: unknown
  /** raw body for routes registered with { raw: true } (size-limited by the router) */
  rawBody?: Buffer
  /** present when the route's auth level is not 'none' */
  user?: UserContext
  services: Services
  /** set or clear the session cookie */
  setSessionCookie(token: string | null, expires?: Date): void
}

/** Return a plain value (sent as JSON 200) or a RawResponse. */
export interface RawResponse {
  raw: true
  status?: number
  headers?: Record<string, string>
  body: Buffer | string | NodeJS.ReadableStream
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown

export interface Router {
  add(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', pattern: string, handler: Handler, opts: { auth: AuthLevel; raw?: boolean; maxBodyMB?: number }): void
}

/** Each route module exports one of these; server/main.ts calls them all. */
export type RouteModule = (router: Router, services: Services) => void

/* ------------------------------------------------------------------ database */

export interface SqlResult { affectedRows: number; insertId?: number }

/** Thin wrapper over a mysql2/promise pool. Always parameterised (`?` placeholders); identifiers via quoteId(). */
export interface SqlDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  exec(sql: string, params?: unknown[]): Promise<SqlResult>
  /** runs fn inside BEGIN/COMMIT on one pooled connection; ROLLBACK on throw */
  tx<T>(fn: (db: SqlDb) => Promise<T>): Promise<T>
  /** e.g. "MySQL 8.4.3" / "MariaDB 10.11.14" */
  serverVersion(): Promise<string>
  close(): Promise<void>
}

export interface MySqlSettings { host: string; port: number; database: string; user: string; ssl?: boolean }

/* ------------------------------------------------------------------ connectors */

/** Values as JS types: string | number | boolean | Date | null. Keys = column names. */
export type RawRow = Record<string, string | number | boolean | Date | null>

export interface ConnectorCapabilities {
  /** can create/alter/drop tables from a TableDef */
  ddl: boolean
  write: boolean
  /** translates Condition / orderBy / top / skip into the source (otherwise the service filters in memory) */
  pushdown: boolean
  transactions: boolean
}

export interface SourceColumn { name: string; type: ColumnDef['type'] }

/**
 * One instance per connection, created by the registry and cached by the ConnectionManager.
 * Connectors know nothing about users or security: the DataService passes a fully security-augmented
 * Condition (RLS already ANDed in) and strips/validates columns (CLS) before and after.
 * Physical table name = def.source (always set by the time a connector sees a def).
 */
export interface Connector {
  readonly kind: ConnectorKind
  readonly capabilities: ConnectorCapabilities
  test(): Promise<{ ok: true; message: string } | { ok: false; message: string }>
  listSourceTables(): Promise<{ source: string; columns: SourceColumn[]; rowCount?: number }[]>
  describe(source: string): Promise<SourceColumn[]>
  createTable(def: TableDef): Promise<void>
  addColumn(def: TableDef, col: ColumnDef): Promise<void>
  /** type changes: the service has already verified existing values convert */
  alterColumn(def: TableDef, before: ColumnDef, after: ColumnDef): Promise<void>
  dropColumn(def: TableDef, name: string): Promise<void>
  dropTable(def: TableDef): Promise<void>
  /** `where` may reference only columns of def. Return typed RawRows (Date for date/datetime). */
  select(def: TableDef, q: Query): Promise<{ rows: RawRow[]; total?: number }>
  insert(def: TableDef, rows: RawRow[]): Promise<void>
  /** update rows with this id that also satisfy `guard` (RLS); returns affected count (0 = not found or not allowed) */
  update(def: TableDef, id: string, changes: RawRow, guard?: Condition): Promise<number>
  delete(def: TableDef, ids: string[], guard?: Condition): Promise<number>
  close(): Promise<void>
}

/** Server-side connection record (includes the decrypted secret only in memory). */
export interface ConnectionRecord extends ConnectionRef {
  secret?: string
}

export interface ConnectorEnv {
  /** absolute workspace folder */
  workspaceDir: string
  /** designated data files folder (files connector) */
  filesDir: string
  /** injectable for tests (gsheets) */
  fetch: typeof fetch
  log(level: 'info' | 'warn' | 'error', msg: string): void
}

export type ConnectorFactory = (conn: ConnectionRecord, env: ConnectorEnv) => Connector

/* ------------------------------------------------------------------ system store (MySQL, default connection) */

export interface UserRecord extends UserDef { passwordHash: string | null }
export interface AttachmentRecord {
  id: string
  tableId: string
  column: string
  rowId: string
  fileName: string
  mime: string
  sizeBytes: number
  sha256: string
  storageKey: string
  createdBy: string
  createdOn: string
}

/**
 * Repositories over the ab_* system tables (schema in docs/SPEC3.md section 3). All methods hit MySQL;
 * callers may cache. ids are generated by callers (uid()).
 */
export interface MetaStore {
  db: SqlDb
  /** create/upgrade the ab_* tables; idempotent */
  migrate(): Promise<void>

  users: {
    list(): Promise<UserRecord[]>
    get(id: string): Promise<UserRecord | null>
    byEmail(email: string): Promise<UserRecord | null>
    count(): Promise<number>
    insert(u: UserRecord): Promise<void>
    update(id: string, patch: Partial<UserRecord>): Promise<void>
    remove(id: string): Promise<void>
  }
  sessions: {
    insert(s: { idHash: string; userId: string; expiresOn: Date; userAgent: string }): Promise<void>
    get(idHash: string): Promise<{ userId: string; expiresOn: Date } | null>
    touch(idHash: string, expiresOn: Date): Promise<void>
    remove(idHash: string): Promise<void>
    removeForUser(userId: string): Promise<void>
    purgeExpired(): Promise<number>
  }
  roles: {
    list(): Promise<RoleDef[]>
    get(id: string): Promise<RoleDef | null>
    upsert(r: RoleDef): Promise<void>
    remove(id: string): Promise<void>
  }
  tables: {
    list(): Promise<TableDef[]>
    get(idOrName: string): Promise<TableDef | null>
    upsert(t: TableDef): Promise<void>
    remove(id: string): Promise<void>
  }
  apps: {
    list(): Promise<AppMeta[]>
    get(id: string): Promise<{ meta: AppMeta; definition: AppDef } | null>
    upsert(meta: AppMeta, definition: AppDef): Promise<void>
    remove(id: string): Promise<void>
  }
  connections: {
    list(): Promise<ConnectionRecord[]>
    get(id: string): Promise<ConnectionRecord | null>
    /** secret is encrypted by the store with the SecretBox */
    upsert(c: ConnectionRecord): Promise<void>
    remove(id: string): Promise<void>
  }
  solutions: {
    list(): Promise<SolutionDef[]>
    upsert(s: SolutionDef): Promise<void>
    remove(id: string): Promise<void>
  }
  files: {
    list(): Promise<DataFileDef[]>
    get(id: string): Promise<DataFileDef | null>
    upsert(f: DataFileDef & { storageKey: string; originalName: string }): Promise<void>
    remove(id: string): Promise<void>
  }
  attachments: {
    get(id: string): Promise<AttachmentRecord | null>
    many(ids: string[]): Promise<AttachmentRecord[]>
    insert(a: AttachmentRecord): Promise<void>
    remove(id: string): Promise<void>
    /** attachments of these rows (for cleanup on row delete) */
    forRows(tableId: string, rowIds: string[]): Promise<AttachmentRecord[]>
  }
  /** next autonumber value for a column (transactional counter in ab_counters) */
  nextCounter(key: string): Promise<number>
  audit(entry: { userId: string | null; action: string; tableId?: string; rowId?: string; details?: unknown }): Promise<void>
}

/* ------------------------------------------------------------------ security */

export interface UserContext {
  user: UserDef
  roles: RoleDef[]
  privileges: EffectivePrivileges
  /** RLS predicate for op on a table (OR over granting roles of scope AND rowFilter); {const:false} when none */
  rowPredicate(table: TableDef, op: 'read' | 'update' | 'delete'): Condition
  canCreate(table: TableDef): boolean
  /** CLS: effective access for a column (system columns: 'read' unless hidden by a role) */
  columnAccess(table: TableDef, column: string): 'none' | 'read' | 'update'
  /** the TableDef with CLS 'none' columns removed (what the client may see) */
  visibleDef(table: TableDef): TableDef
  canRunApp(appId: string): boolean
  session(): Session
}

export interface SecurityEngine {
  /** loads roles once per request (cache invalidated by invalidate()) */
  forUser(user: UserDef): Promise<UserContext>
  /** call after any role/user/table change */
  invalidate(): void
}

/* ------------------------------------------------------------------ data service */

/** `ctx` null = system (migration, packages import, seeding): no RBAC/RLS/CLS, still validated. */
export interface DataService {
  query(ctx: UserContext | null, table: TableDef, q: Query): Promise<{ rows: Record<string, QueryValue>[]; total?: number; truncated: boolean }>
  insert(ctx: UserContext | null, table: TableDef, values: Record<string, QueryValue>): Promise<Record<string, QueryValue>>
  update(ctx: UserContext | null, table: TableDef, id: string, changes: Record<string, QueryValue>): Promise<Record<string, QueryValue>>
  delete(ctx: UserContext | null, table: TableDef, ids: string[]): Promise<number>
  importCsv(ctx: UserContext | null, table: TableDef, csv: string, mode: 'append' | 'replace'): Promise<number>
  exportCsv(ctx: UserContext | null, table: TableDef): Promise<string>
}

export interface ConnectionManager {
  /** cached connector for a connection id (re-created when the record changes) */
  get(connectionId: string): Promise<Connector>
  /** the default (mysql) connection id */
  defaultId(): Promise<string>
  /** drop cached instance (after settings/secret change) */
  reset(connectionId: string): Promise<void>
  register(kind: ConnectorKind, factory: ConnectorFactory): void
}

export interface AttachmentStore {
  /** writes bytes, returns storage key; never trusts the client file name for the path */
  put(bytes: Buffer): Promise<{ storageKey: string; sha256: string; sizeBytes: number }>
  open(storageKey: string): NodeJS.ReadableStream
  remove(storageKey: string): Promise<void>
  toRef(a: AttachmentRecord): AttachmentRef
}

export interface SecretBox {
  encrypt(plain: string): string
  decrypt(sealed: string): string
}

export interface ServerConfig {
  workspaceDir: string
  filesDir: string
  attachmentsDir: string
  host: string
  port: number
  /** absolute dist folder for static serving (production) */
  distDir: string
}

/**
 * Services container. `meta`/`data` throw HttpError(503,'unavailable') while the database is not configured
 * (setup.needsDatabase); check `ready()` first where it matters.
 */
export interface Services {
  config: ServerConfig
  secrets: SecretBox
  ready(): boolean
  meta: MetaStore
  security: SecurityEngine
  data: DataService
  connections: ConnectionManager
  attachments: AttachmentStore
  env: ConnectorEnv
  /** small helpers */
  uid(prefix?: string): string
  now(): string
}
