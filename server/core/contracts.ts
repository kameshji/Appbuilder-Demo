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
import type { QueryPlan, QueryV2Response } from '../../src/platform/query.ts'
import type { TableEventDef, TableEventInput } from '../../src/platform/events.ts'
import type { NotificationItem, NotificationSettings } from '../../src/platform/live-protocol.ts'

/* ------------------------------------------------------------------ http */

export type ApiErrorCode =
  | 'unauthenticated' | 'denied' | 'not-found' | 'conflict' | 'invalid' | 'unavailable' | 'storage'
  /** 429: too many attempts (login / password change throttle) */
  | 'rate_limited'
  /** 405: the path exists but not for this HTTP method */
  | 'method_not_allowed'
  /** 403: the signed-in user must change the password an administrator set before doing anything else */
  | 'password_change_required'
  /** package I: 401 the password was right, the second step is needed (POST /auth/login/verify); 403 the action needs a
   *  fresh proof of identity (POST /auth/reauth); 403 two-step verification must be set up before anything else */
  | 'mfa_required' | 'reauth_required' | 'mfa_enrolment_required'

/** Throw from anywhere in a request; the router turns it into { error: { code, message, field? } }. */
export class HttpError extends Error {
  status: number
  code: ApiErrorCode
  field?: string
  /** extra JSON members of the error body, next to `error` (e.g. `current` on a 409 version conflict) */
  extra?: Record<string, unknown>
  constructor(status: number, code: ApiErrorCode, message: string, field?: string, extra?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.field = field
    if (extra) this.extra = extra
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
   * the environment this request works in: the X-Appbuilder-Environment header (or ?env= on GET) checked against the
   * session's access, else the user's last environment (environments.ts resolveFor). The router runs the handler inside
   * it, so services.meta, the security cache, the connection cache and the workspace folders all use it.
   */
  environmentId: string
  /** the environment the request asked for (validated format), null when it named none */
  requestedEnvironment?: string | null
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
  /**
   * changes the design of the environment (apps, tables, columns, roles, solutions, data files): refused with 403 in a
   * locked environment. The router sets it for the routes in DESIGN_ROUTES (router.ts); a route may set it too.
   */
  design?: boolean
  /** usable by a signed-in user who has no environment to enter (own session, password, environment list) */
  noEnvironment?: boolean
  /** package I: reachable by a session that must set up two-step verification first (otherwise 403 mfa_enrolment_required) */
  allowPendingMfaEnrolment?: boolean
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
  /** SQL connectors (data model designer import): the source's foreign keys, single-column ones */
  foreignKeys?(): Promise<{ table: string; column: string; refTable: string; refColumn: string; onDelete?: string }[]>
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
  /**
   * Query v2 pushdown (PostgreSQL): runs a validated plan as one statement with the caller's row filter ANDed in.
   * Connectors without it are served by the DataService fallback (reference executor over a capped read).
   */
  queryV2?(def: TableDef, input: QueryV2Input): Promise<QueryV2Raw>
  close(): Promise<void>
}

/** what the DataService hands a connector for a Query v2 plan (already validated and security-checked) */
export interface QueryV2Input {
  plan: QueryPlan
  /** the caller's row filter (v1 Condition); undefined = every row */
  rowFilter?: Condition
  /** lookup paths of the plan: the tables they read, with the caller's row filter on each (core data model, P0-N) */
  related?: Record<string, { def: TableDef; rowFilter?: Condition }>
  /** columns returned when the plan has no select */
  visible: string[]
  maxUnpagedRows: number
  maxGroups: number
  timeoutMs: number
}

/** typed result rows (Date for date/datetime) plus the type of every output column */
export interface QueryV2Raw {
  rows: RawRow[]
  columns: { name: string; type: ColumnDef['type'] }[]
  count?: number
  nextCursor?: string | null
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

export type EnvironmentType = 'production' | 'sandbox' | 'developer'
export type EnvironmentState = 'ready' | 'creating' | 'deleting' | 'failed' | 'restoring'
/** a row of ab.environments */
export interface EnvironmentRecord extends EnvironmentRef {
  name: string
  type: EnvironmentType
  builtIn: boolean
  createdOn: string
  description?: string
  createdBy?: string
  state: EnvironmentState
  /** the SCHEMA_VERSION its schema was last migrated to (0: never) */
  schemaVersion: number
  locked: boolean
  /** why state is failed */
  lastError?: string
}

/** a row of ab.environment_access: the user may enter the environment */
export interface EnvironmentAccessRecord {
  environmentId: string
  userId: string
  /** holds an administrator role there (kept in step with ab_user_roles by the MetaStore) */
  isEnvAdmin: boolean
  grantedOn: string
  grantedBy?: string
}

/**
 * Install-wide registry in schema `ab` (install-store.ts): environments, who may enter them, the install-level audit.
 * Never depends on the current environment.
 */
export interface InstallStore {
  environments: {
    list(): Promise<EnvironmentRecord[]>
    get(id: string): Promise<EnvironmentRecord | null>
    insert(e: Omit<EnvironmentRecord, 'createdOn' | 'schemaVersion'> & { createdOn?: string; schemaVersion?: number }): Promise<void>
    update(id: string, patch: Partial<Pick<EnvironmentRecord, 'name' | 'description' | 'type' | 'state' | 'locked' | 'lastError' | 'schemaVersion'>>): Promise<void>
    /** the registry row, its access rows, and users' last-environment pointers (not the schema) */
    remove(id: string): Promise<void>
  }
  access: {
    list(): Promise<EnvironmentAccessRecord[]>
    forEnvironment(id: string): Promise<EnvironmentAccessRecord[]>
    grant(environmentId: string, userId: string, by: string | null): Promise<void>
    revoke(environmentId: string, userId: string): Promise<void>
  }
  /** install admins that are active */
  activeInstallAdmins(): Promise<number>
  audit(entry: { userId: string | null; action: string; environmentId?: string | null; details?: unknown }): Promise<void>
  auditPage(filter: AuditFilter & { environmentId?: string }): Promise<{ items: (AuditRecord & { environmentId: string | null })[]; total: number }>
  auditActions(): Promise<string[]>
  /** table count, row estimate and size of the data in one environment schema */
  schemaSizes(schema: string): Promise<{ tables: number; rowEstimate: number; databaseBytes: number }>
}

export interface UserRecord extends UserDef { passwordHash: string | null }

/** one row of ab.sessions as the server reads it (the token itself is never stored, only its SHA-256) */
export interface SessionRecord {
  userId: string
  expiresOn: Date
  createdOn?: Date
  lastSeen?: Date
  /** package I: the session's end however active it is (null: none) */
  absoluteExpiresOn?: Date | null
  /** package I: last proof of identity (sign-in or re-authentication) */
  authOn?: Date | null
  /** package I: the id shown in session lists (never the hash) */
  publicId?: string | null
  /** package I: 'mfa_enrol' = may only set up two-step verification */
  restricted?: string | null
  mfa?: boolean
  ip?: string | null
  userAgent?: string | null
}

/** result of MetaStore.migrate(): the schema version before and after, and what each upgrade step did */
export interface MigrationSummary {
  from: number
  to: number
  steps: string[]
  /** per environment schema (each in its own transaction; a failing one is marked failed and the others go on) */
  environments?: { id: string; from: number; to: number; ok: boolean; error?: string }[]
}
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
  /** environment setting "Directory visibility" (P0 package M; ab.settings `directory.visibility`); absent in older fakes */
  directoryVisibility?: {
    get(environmentId: string): Promise<import('../../src/platform/orgsec.ts').DirectoryVisibility>
    set(environmentId: string, mode: import('../../src/platform/orgsec.ts').DirectoryVisibility): Promise<void>
  }
  /** organisation (departments, teams, user organisation fields) and record shares; absent in older fakes */
  org?: import('./org-store.ts').OrgStore
  /** data model designer (package K): relationships, diagram layouts, drafts; absent in older fakes */
  relationships?: import('./model/store.ts').RelationshipStore
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
    /** ip, publicId, absoluteExpiresOn, mfa, restricted: package I (identity) */
    insert(s: { idHash: string; userId: string; expiresOn: Date; userAgent: string; ip?: string | null; publicId?: string; absoluteExpiresOn?: Date | null; mfa?: boolean; restricted?: string | null }): Promise<void>
    get(idHash: string): Promise<SessionRecord | null>
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
  /** the environment these privileges belong to */
  environmentId: string
  user: UserDef
  roles: RoleDef[]
  privileges: EffectivePrivileges
  /**
   * RLS predicate for op on a table (OR over granting roles of scope AND rowFilter); {const:false} when none.
   * 'create': OR over the roles granting create of their rowFilter (the WITH CHECK a new row must satisfy).
   */
  rowPredicate(table: TableDef, op: 'read' | 'update' | 'delete' | 'create' | 'share'): Condition
  /** the parts of a predicate (per role, shares, ownership) for the "who can see this row?" explainer */
  reasons?(table: TableDef, op: 'read' | 'update' | 'delete' | 'create' | 'share'): import('../../src/platform/orgsec.ts').PredicateReason[]
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
  /** call after any role/user/table change: drops the cache of the current environment (all: every environment; or a named one) */
  invalidate(scope?: 'all' | { environment: string }): void
  /** organisation changed (departments, teams, managers): drops the cached directory and shares (P0-F) */
  invalidateOrg?(): void
  /** a share was added or removed */
  invalidateShares?(): void
  /** the cached organisation directory */
  directory?(): Promise<import('../../src/platform/orgsec.ts').OrgDirectory>
}

/* ------------------------------------------------------------------ data service */

/** `ctx` null = system (migration, packages import, seeding): no RBAC/RLS/CLS, still validated. */
export interface DataService {
  query(ctx: UserContext | null, table: TableDef, q: Query): Promise<{ rows: Record<string, QueryValue>[]; total?: number; truncated: boolean }>
  /** Query v2 (POST /api/v1/query): RBAC, row filters and column security applied inside the one statement */
  queryV2(ctx: UserContext | null, table: TableDef, plan: unknown): Promise<QueryV2Response>
  insert(ctx: UserContext | null, table: TableDef, values: Record<string, QueryValue>): Promise<Record<string, QueryValue>>
  /**
   * opts.ifModifiedOn (optimistic concurrency): the row's modifiedOn the caller last saw (ISO time); when the row changed
   * since, 409 conflict (field 'modifiedOn', body member `current` = the row as the caller may see it, `changedBy`).
   */
  update(ctx: UserContext | null, table: TableDef, id: string, changes: Record<string, QueryValue>, opts?: { ifModifiedOn?: string }): Promise<Record<string, QueryValue>>
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
  /** environments: registry, access, lifecycle (environments.ts); absent in the metadata test harness */
  environments?: EnvironmentManager
  /** pre-upgrade snapshots (backup.ts; package J implements it) */
  backup?: BackupService
  /**
   * unit of work: everything fn does on the system database (MetaStore writes, and DDL and rows through the default
   * connection) commits together or not at all (transactional DDL). Other connectors (files, Google Sheets, external
   * databases) are not covered; callers keep their compensating undo for those. Security caches are dropped afterwards.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>
  /** in-app notifications (notifications.ts; package H). Absent in the metadata test harness. */
  notifications?: NotificationService
  /** event and job kernel (server/core/kernel.ts; package G). Absent in the metadata test harness. */
  kernel?: KernelServices
  /** small helpers */
  uid(prefix?: string): string
  now(): string
}

/* ------------------------------------------------------------------ event and job kernel */

/**
 * What the metadata routes need from the event and job kernel (server/core/kernel.ts, docs/dev/events-and-jobs.md).
 * Everything joins the caller's unit of work: jobs enqueued here exist only if the route's transaction commits.
 */
export interface KernelServices {
  /** refuse a computed column (formula / rollup) that cannot work: 422 with field "computed" */
  checkColumn(def: TableDef, col: ColumnDef): Promise<void>
  /** a column was added (before null), changed, or removed (after null): backfills, reconciles as jobs */
  columnChanged(def: TableDef, before: ColumnDef | null, after: ColumnDef | null): Promise<void>
  /** build the indexes of an `indexed` change in the background (true = queued: skip the inline DDL) */
  indexInBackground(def: TableDef, col: ColumnDef): Promise<boolean>
  /** delete attachment files after the current unit of work commits (false: no queue, delete them yourself) */
  deleteFilesAfterCommit(storageKeys: string[]): Promise<boolean>
  /** a table was deleted: its events go */
  tableRemoved(tableId: string): Promise<void>
  /** drop cached event rules (tables or events changed) */
  invalidate(): void
  /** solutions: the events and validation rules of a table */
  listEvents(tableId: string): Promise<TableEventDef[]>
  /**
   * solutions: create (with the package's id when free) or replace an event of a table; formulas are checked against this
   * environment (422). The caller decides who may import events that run as the system.
   */
  putEvent(table: TableDef, event: TableEventInput & { id?: string }, by: string | null): Promise<TableEventDef>
  removeEvent(id: string): Promise<void>
}

/* ------------------------------------------------------------------ environments */

/** paths of one environment's workspace folder: workspace/env/<id>/{files,attachments} */
export interface EnvironmentDirs { root: string; files: string; attachments: string }

export interface EnvironmentManager {
  /** registry rows (short cache) */
  list(): Promise<EnvironmentRecord[]>
  get(id: string): Promise<EnvironmentRecord | null>
  /** environments the user may enter (install admins: all) */
  accessible(user: UserDef): Promise<EnvironmentRecord[]>
  /**
   * the environment a request of this user works in: `requested` when given (404 unknown, 403 no access, 503 not
   * ready), else the user's last one, else Default, else the first they may enter. 403 when there is none.
   */
  resolveFor(user: UserDef, requested: string | null): Promise<EnvironmentRecord>
  /** locked production environment: design changes are refused */
  isLocked(id: string): Promise<boolean>
  dirs(id: string): EnvironmentDirs
  /** drop cached registry / access rows (after a change) */
  invalidate(): void
  /** the configured limit (APPBUILDER_MAX_ENVIRONMENTS, default 5) */
  max(): number
}

/**
 * result of a snapshot (backup/service.ts): taken, or not taken because automatic backups are off (failed absent), or
 * because the backup failed (failed true: the caller refuses to go on unless the administrator chose to proceed)
 */
export interface SnapshotResult { taken: boolean; message: string; id?: string; failed?: boolean }
export interface BackupService {
  /** can snapshot() take a backup now? */
  available(): boolean
  /** called before an in-place solution upgrade (and other destructive environment operations) */
  snapshot(env: EnvironmentRef, reason: string, o?: { trigger?: 'pre-upgrade' | 'pre-delete' | 'pre-restore'; by?: string | null }): Promise<SnapshotResult>
}

/* ------------------------------------------------------------------ notifications (package H) */

export interface NotifyTarget {
  userIds?: string[]
  /** members of these teams (needs the organisation model's team resolver: setTeamResolver) */
  teamIds?: string[]
}

export interface NotifyInput {
  /** short lowercase word: app, system, flow, approval, ... (users switch kinds on and off) */
  kind: string
  title: string
  body?: string
  /** a deep link inside Appbuilder (#...), never an external address */
  link?: string | null
  /** the environment the notification is about (null: install-wide) */
  environmentId?: string | null
  /** app:<id>, flow:<id>, user:<id>, system */
  source: string
  /** the person who sent it (shown as "from") */
  from?: { id: string; name: string }
}

/**
 * The server-side notification service (server/core/notifications.ts). Flows, approvals and table events (package G)
 * call notify(); it stores one row per recipient in ab.notifications (skipping disabled accounts and kinds the recipient
 * switched off) and pushes it over the realtime hub. No permission checks here: callers decide who may notify whom.
 */
export interface NotificationService {
  notify(target: NotifyTarget, input: NotifyInput): Promise<{ delivered: string[]; skipped: string[] }>
  list(userId: string, o?: { limit?: number; cursor?: string | null; unreadOnly?: boolean }): Promise<{ items: NotificationItem[]; nextCursor: string | null; unread: number }>
  unreadCount(userId: string): Promise<number>
  /** returns the new unread count */
  markRead(userId: string, ids: string[] | 'all'): Promise<number>
  remove(userId: string, id: string): Promise<number>
  settings(userId: string): Promise<NotificationSettings>
  saveSettings(userId: string, value: unknown): Promise<NotificationSettings>
  /** the organisation model (package F) registers how team ids become user ids in an environment */
  setTeamResolver(fn: (env: string, teamIds: string[]) => Promise<string[]>): void
}
