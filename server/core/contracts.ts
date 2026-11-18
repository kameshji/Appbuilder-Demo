/**
 * SERVER CONTRACT (internal). TypeScript run directly by Node (type stripping): erasable syntax only
 * (no enums, no parameter properties, no namespaces), relative imports with explicit `.ts` extensions,
 * type-only imports with `import type`. Never import '@/...' at runtime from server code.
 * Binding; architect-owned. Read docs/internal/specs/SPEC3.md first.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  AppMeta, AttachmentRef, ColumnDef, ConnectionRef, ConnectorKind, DataFileDef, EffectivePrivileges,
  RoleDef, Session, SolutionDef, TableDef, UserDef,
} from '../../src/platform/contracts.ts'
import type { AppDef } from '../../src/contracts.ts'
import type { Condition, Query, QueryValue } from '../../src/platform/http.ts'

/* ------------------------------------------------------------------ http */

export type ApiErrorCode =
  | 'unauthenticated' | 'denied' | 'not-found' | 'conflict' | 'invalid' | 'unavailable' | 'storage'
  /** 429: too many attempts (login / password change throttle) */
  | 'rate_limited'
  /** 405: the path exists but not for this HTTP method */
  | 'method_not_allowed'
  /** 403: the signed-in user must change the password an administrator set before doing anything else */
  | 'password_change_required'

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
  /**
   * routes registered with { raw: true, streamBody: true } only: the router does not read the body; the handler
   * calls this (once) after its own checks. Rejects with 413 as soon as more than `limitBytes` arrive (never more
   * than the route's maxBodyMB) and closes the connection after the error response.
   */
  readBody?(limitBytes: number): Promise<Buffer>
  /** present when the route's auth level is not 'none' */
  user?: UserContext
  /**
   * the environment this request works in (resolveEnvironment() in env-context.ts; 'default' for now). The router runs
   * the handler inside that environment, so services.meta, the security cache and the connection cache all use it.
   */
  environmentId: string
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

/**
 * maxBodyMB: body limit of the route (JSON or raw; default 2 MB for JSON, 25 MB for raw).
 * streamBody (raw routes only): the body is not read before the handler; see Ctx.readBody.
 */
export interface RouteOptions {
  auth: AuthLevel
  raw?: boolean
  maxBodyMB?: number
  streamBody?: boolean
  /** only requests whose TCP peer is a loopback address (127.0.0.0/8, ::1) reach the handler; headers do not count */
  loopbackOnly?: boolean
  /** reachable by a user whose password must be changed first (otherwise 403 password_change_required) */
  allowPendingPasswordChange?: boolean
}

export interface Router {
  add(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', pattern: string, handler: Handler, opts: RouteOptions): void
}

/** Each route module exports one of these; server/main.ts calls them all. */
export type RouteModule = (router: Router, services: Services) => void

/* ------------------------------------------------------------------ database */

/** insertId: MySQL connector only (PostgreSQL code uses RETURNING) */
export interface SqlResult { affectedRows: number; insertId?: number }

/**
 * Thin wrapper over a connection pool. Always parameterised; identifiers via the dialect's quoteId().
 * Placeholders are the driver's: `$1, $2, ...` for 'postgres' (system store, postgres connector, connectors/postgres/db.ts),
 * `?` for 'mysql' (the MySQL connector only, connectors/mysql/db.ts).
 */
export interface SqlDb {
  readonly dialect: 'postgres' | 'mysql'
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  exec(sql: string, params?: unknown[]): Promise<SqlResult>
  /**
   * runs fn inside BEGIN/COMMIT on one pooled connection; ROLLBACK on throw. Nested calls join the outer transaction
   * (PostgreSQL: as a SAVEPOINT, so a failing inner fn rolls back only its own statements).
   */
  tx<T>(fn: (db: SqlDb) => Promise<T>): Promise<T>
  /** e.g. "PostgreSQL 16.4" / "MySQL 8.4.3" / "MariaDB 10.11.14" */
  serverVersion(): Promise<string>
  close(): Promise<void>
}

/** where a database server is (system store, postgres and mysql connections); the password travels separately */
export interface DatabaseSettings { host: string; port: number; database: string; user: string; ssl?: boolean }
/** the MySQL connector's settings (same shape) */
export type MySqlSettings = DatabaseSettings

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
  /**
   * Only when capabilities.transactions: runs fn with a connector bound to one transaction (BEGIN/COMMIT,
   * ROLLBACK when fn throws). Data statements only on MySQL; on PostgreSQL DDL is transactional too.
   */
  transaction?<T>(fn: (tx: Connector) => Promise<T>): Promise<T>
  /**
   * SQL connectors with ddl (postgres, mysql): adds the system columns a linked table lacks (with the maker's consent
   * at link time); a missing id is added and filled with UUIDv7 values.
   */
  ensureSystemColumns?(source: string): Promise<{ added: string[]; filled: number }>
  close(): Promise<void>
}

/** Server-side connection record (includes the decrypted secret only in memory). */
export interface ConnectionRecord extends ConnectionRef {
  secret?: string
}

export interface ConnectorEnv {
  /**
   * the environment the connector instance serves (the ConnectionManager creates one instance per environment and
   * connection). Absent outside the server (connector unit tests).
   */
  environment?: EnvironmentRef
  /**
   * the system database (PostgreSQL). The default connection (conn_default) stores its tables in the environment
   * schema of this database and uses this pool, so its statements join a unit of work (Services.transaction).
   */
  systemDb?: () => SqlDb | null
  /** absolute workspace folder */
  workspaceDir: string
  /** designated data files folder (files connector) */
  filesDir: string
  /** injectable for tests (gsheets) */
  fetch: typeof fetch
  log(level: 'info' | 'warn' | 'error', msg: string): void
}

export type ConnectorFactory = (conn: ConnectionRecord, env: ConnectorEnv) => Connector

/* ------------------------------------------------------------------ system store (PostgreSQL) */

/** an environment: its id (in requests and cache keys) and its schema in the system database (env_<slug>) */
export interface EnvironmentRef { id: string; schema: string }

export interface EnvironmentRecord extends EnvironmentRef {
  name: string
  type: 'production' | 'sandbox' | 'developer'
  builtIn: boolean
  createdOn: string
}

export interface UserRecord extends UserDef { passwordHash: string | null }

/** result of MetaStore.migrate(): the schema version before and after, and what each upgrade step did */
export interface MigrationSummary { from: number; to: number; steps: string[] }
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
 * Repositories over the system tables (docs/dev/schema.md). All methods hit PostgreSQL; callers may cache.
 * ids are generated by callers (uid()). Install-wide objects (users, sessions, settings, environments) live in schema
 * `ab`; everything else in the schema of the current environment (env-context.ts), resolved on every call.
 */
export interface MetaStore {
  db: SqlDb
  /**
   * create/upgrade schema `ab` and every registered environment schema; idempotent. Throws SchemaTooNewError when the
   * database was upgraded by a newer server (ab.settings schemaVersion above SCHEMA_VERSION); nothing is changed then.
   */
  migrate(): Promise<MigrationSummary | void>
  /**
   * fully qualified, quoted name of a system table: users / sessions / settings / environments / licence -> "ab"."x";
   * the others (ab_tables, ab_audit, ...) -> "<current environment schema>"."ab_x". For maintenance code and tests.
   */
  tableName(name: string): string
  environments: {
    list(): Promise<EnvironmentRecord[]>
    get(id: string): Promise<EnvironmentRecord | null>
  }

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
    /** sets modifiedSinceImport (rows of one of its tables were edited) */
    markModified(id: string): Promise<void>
  }
  attachments: {
    get(id: string): Promise<AttachmentRecord | null>
    many(ids: string[]): Promise<AttachmentRecord[]>
    insert(a: AttachmentRecord): Promise<void>
    remove(id: string): Promise<void>
    /** attachments of these rows (for cleanup on row delete) */
    forRows(tableId: string, rowIds: string[]): Promise<AttachmentRecord[]>
    /** ids of every attachment of a table (cleanup on table delete) */
    idsForTable(tableId: string): Promise<string[]>
    /** ids of attachments created before `cutoff` (orphan sweep), at most `limit` */
    idsCreatedBefore(cutoff: Date, limit: number): Promise<string[]>
  }
  /** next autonumber value for a column (atomic counter in ab_counters) */
  nextCounter(key: string): Promise<number>
  /** raises a counter to at least `value` (legacy import); never lowers it */
  raiseCounter(key: string, value: number): Promise<void>
  audit(entry: { userId: string | null; action: string; tableId?: string; rowId?: string; details?: unknown }): Promise<void>
  /** admin audit viewer: newest first, filtered; total counts every matching entry */
  auditPage(filter: AuditFilter): Promise<{ items: AuditRecord[]; total: number }>
  /** distinct action names present in the audit table (for the viewer's filter), sorted */
  auditActions(): Promise<string[]>
  /** facts about this installation's system database: when the first user was created (= set up), null when unknown */
  info(): Promise<{ createdOn: string | null }>
}

export interface AuditFilter {
  /** exact action, or a prefix ending in "." (e.g. "auth.") */
  action?: string
  userId?: string
  /** ISO timestamps, inclusive from, exclusive to */
  from?: string
  to?: string
  /** 0-based offset and page size (callers cap it) */
  offset: number
  limit: number
}
export interface AuditRecord {
  id: number
  at: string
  userId: string | null
  action: string
  tableId: string | null
  rowId: string | null
  /** parsed JSON details, null when none */
  details: unknown
}

/* ------------------------------------------------------------------ security */

export interface UserContext {
  user: UserDef
  roles: RoleDef[]
  privileges: EffectivePrivileges
  /**
   * RLS predicate for op on a table (OR over granting roles of scope AND rowFilter); {const:false} when none.
   * 'create': OR over the roles granting create of their rowFilter (the WITH CHECK a new row must satisfy).
   */
  rowPredicate(table: TableDef, op: 'read' | 'update' | 'delete' | 'create'): Condition
  canCreate(table: TableDef): boolean
  /** CLS: effective access for a column (system columns: 'read' unless hidden by a role) */
  columnAccess(table: TableDef, column: string): 'none' | 'read' | 'update'
  /** the TableDef with CLS 'none' columns removed (what the client may see) */
  visibleDef(table: TableDef): TableDef
  canRunApp(appId: string): boolean
  session(): Session
}

export interface SecurityEngine {
  /** loads roles once per request (cache keyed by environment id, invalidated by invalidate()) */
  forUser(user: UserDef): Promise<UserContext>
  /** call after any role/user/table change: drops the cache of the current environment (all: every environment) */
  invalidate(scope?: 'all'): void
}

/* ------------------------------------------------------------------ data service */

/** `ctx` null = system (migration, packages import, seeding): no RBAC/RLS/CLS, still validated. */
export interface DataService {
  query(ctx: UserContext | null, table: TableDef, q: Query): Promise<{ rows: Record<string, QueryValue>[]; total?: number; truncated: boolean }>
  insert(ctx: UserContext | null, table: TableDef, values: Record<string, QueryValue>): Promise<Record<string, QueryValue>>
  update(ctx: UserContext | null, table: TableDef, id: string, changes: Record<string, QueryValue>): Promise<Record<string, QueryValue>>
  delete(ctx: UserContext | null, table: TableDef, ids: string[]): Promise<number>
  /** opts.actorId (system context only): imported rows get createdBy = owner = that user */
  importCsv(ctx: UserContext | null, table: TableDef, csv: string, mode: 'append' | 'replace', opts?: { actorId?: string }): Promise<number>
  exportCsv(ctx: UserContext | null, table: TableDef): Promise<string>
}

export interface ConnectionManager {
  /**
   * cached connector for a connection id in the current environment (re-created when the record changes); the cache is
   * keyed by environment id and connection id
   */
  get(connectionId: string): Promise<Connector>
  /** the default (postgres) connection id of the current environment */
  defaultId(): Promise<string>
  /** drop the cached instance in the current environment (after settings/secret change) */
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
  /**
   * host names the Host / Origin headers may name (DNS-rebinding guard): localhost, 127.0.0.1, ::1, the listening
   * host unless it is a wildcard, and APPBUILDER_ALLOWED_HOSTS. A header is never proof that a request is local.
   */
  allowedHosts?: string[]
  /** APPBUILDER_SECURE_COOKIE=1: always mark ab_session Secure */
  secureCookie?: boolean
  /** APPBUILDER_TRUST_PROXY=1: trust X-Forwarded-Proto (Secure cookie when it is https) */
  trustProxy?: boolean
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
  /** the environment of the current request (env-context.ts): id and schema */
  environment(): EnvironmentRef
  /**
   * unit of work: everything fn does on the system database (MetaStore writes, and DDL and rows through the default
   * connection) commits together or not at all (transactional DDL). Other connectors (files, Google Sheets, external
   * databases) are not covered; callers keep their compensating undo for those. Security caches are dropped afterwards.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>
  /** small helpers */
  uid(prefix?: string): string
  now(): string
}
