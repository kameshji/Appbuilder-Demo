/**
 * DATA API v1: the HTTP protocol between the browser and a backend.
 * Implemented now by the local Node server (server/), and next by a PHP gateway on shared hosting,
 * so keep every shape here plain JSON. Shared by client and server. Binding; architect-owned.
 *
 * Conventions
 *  - Base path /api/v1. JSON bodies (Content-Type: application/json) except uploads (raw body).
 *  - Session: HttpOnly cookie `ab_session` (SameSite=Strict, Path=/). No tokens in URLs or localStorage.
 *  - Every non-GET request must send header `X-Appbuilder: 1` (CSRF guard) and a same-origin Origin.
 *  - Errors: HTTP status + body ApiError. 401 unauthenticated, 403 denied, 404 not-found, 409 conflict,
 *    422 invalid, 503 unavailable (database not configured / unreachable), 500 storage, 429 rate_limited (login / password
 *    throttle), 405 method_not_allowed; 403 may also carry password_change_required (the account must set a new password).
 *  - Dates in JSON: ISO-8601 strings. Typed row values travel as JSON (numbers, booleans, strings, null);
 *    'date' columns as "YYYY-MM-DD", 'datetime' as full ISO. The client converts to Date for formulas.
 *  - Row objects always include `id`; the client adds `__id` itself.
 */
import type {
  AppMeta, AttachmentRef, ColumnDef, ColumnType, ConnectionRef, ConnectorKind, DataFileDef, EnvironmentDef, RoleDef,
  Session, SolutionDef, TableDef, UserDef,
} from './contracts.ts'
import type { AppDef } from '../contracts.ts'

export const API_BASE = '/api/v1'
export const CSRF_HEADER = 'X-Appbuilder'
export const SESSION_COOKIE = 'ab_session'
/**
 * Every request names the environment it works in (the id of an EnvironmentDef). The server checks it against the
 * session's access (403 when the user may not enter it, 404 when it does not exist); without it the server uses the
 * user's last environment, else Default, else the first one they may enter. GET requests may send `?env=<id>` instead
 * (attachment links in <img src>), never both with different values.
 */
export const ENVIRONMENT_HEADER = 'X-Appbuilder-Environment'
export const ENVIRONMENT_QUERY = 'env'
/** server default row cap per query; responses set `truncated` when more rows matched */
export const DEFAULT_ROW_CAP = 5000

export interface ApiError {
  error: { code: 'unauthenticated' | 'denied' | 'not-found' | 'conflict' | 'invalid' | 'unavailable' | 'storage' | 'rate_limited' | 'method_not_allowed' | 'password_change_required'; message: string; field?: string }
}

/* ------------------------------------------------------------------ query AST (also used by connectors) */

export type QueryValue = string | number | boolean | null
export type CompareOp = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'in' | 'contains' | 'startsWith' | 'endsWith' | 'isBlank' | 'notBlank'
export type Condition =
  | { and: Condition[] }
  | { or: Condition[] }
  | { not: Condition }
  | { col: string; op: CompareOp; value?: QueryValue | QueryValue[] }
  /** constant true / false (used by the security engine: e.g. no granting role => false) */
  | { const: boolean }

export interface Query {
  select?: string[]
  where?: Condition
  orderBy?: { col: string; dir: 'asc' | 'desc' }[]
  /**
   * Absent or above DEFAULT_ROW_CAP (5000): at most 5000 rows come back, with `truncated: true` when more exist.
   * 1..5000: exactly that many rows (at most), and `truncated` is false.
   */
  top?: number
  skip?: number
  count?: boolean
}

/* ------------------------------------------------------------------ endpoints (method path -> request -> response) */

/**
 * GET /api/v1/status  (no auth). Anonymous callers get state flags only; `storage` and `databaseError` (which name the
 * database host, port and name) are present only for a signed-in administrator.
 */
export interface StatusResponse {
  app: 'appbuilder'
  apiVersion: 1
  backend: 'node' | 'php'
  /**
   * needsDatabase: the setup screen may configure the database (first run). unavailable: a configured database cannot be
   * reached (the server retries in the background). incompatible: the database schema is newer than this server.
   */
  setup: { needsDatabase: boolean; needsAdmin: boolean; unavailable?: boolean; incompatible?: boolean }
  /** true when the workspace is usable (database reachable and compatible, administrator exists) */
  ok: boolean
  /** admins only: default store description for the UI, e.g. "PostgreSQL 16.4 at 127.0.0.1:5432/appbuilder" */
  storage?: { kind: 'postgres'; location: string } | null
  /** admins only */
  databaseError?: string
  /** admins only: versions for the About page and the environment details */
  server?: StatusServerInfo
  session: Session | null
}
export interface StatusServerInfo {
  /** Appbuilder version (package.json of the running server) */
  version: string
  /** Node.js version, e.g. "v22.18.0" */
  node: string
  /** database product and version, e.g. "11.8.2-MariaDB"; absent while the database is not reachable */
  database?: string
  /** system schema version this server runs (the database is at it, or the server refuses to start it) */
  schemaVersion: number
}

/**
 * POST /api/v1/setup/database and /setup/admin: only from this computer (loopback TCP peer) and only with the one-time
 * setup code the server prints to its console (`setupCode` in the body or the X-Appbuilder-Setup-Code header).
 * /setup/database: first run only (before an administrator exists), afterwards an administrator's session.
 */
export const SETUP_CODE_HEADER = 'X-Appbuilder-Setup-Code'
export interface SetupDatabaseRequest { host: string; port: number; database: string; user: string; password: string; createDatabase?: boolean; ssl?: boolean | 'true'; setupCode?: string }
/** POST /api/v1/setup/admin  (only while there are no users) -> sets the session cookie */
export interface SetupAdminRequest { name: string; email: string; password: string; setupCode?: string }

/** POST /api/v1/auth/login -> Session (+ cookie). POST /api/v1/auth/logout -> {ok:true}. GET /api/v1/auth/session -> Session | 401 */
export interface LoginRequest { email: string; password: string }
/** POST /api/v1/auth/password */
export interface ChangePasswordRequest { current: string; next: string }
/**
 * PATCH /api/v1/auth/profile -> UserDef. Self-service, any signed-in user: only the display name of the caller's own
 * account. Any other field is refused (email, roles and status stay with an administrator).
 */
export interface ProfileRequest { name: string }

/**
 * Environments (docs/dev/data-api.md, docs/admin/environments.md)
 *   GET    /api/v1/environments                    any signed-in user -> { items, max, canCreate }  (only the ones they may enter)
 *   POST   /api/v1/environments/:id/select         any signed-in user with access -> EnvironmentDef  (remembered on the user)
 *   POST   /api/v1/environments                    install admin  EnvironmentCreateRequest -> EnvironmentDef
 *   GET    /api/v1/environments/:id                install admin or its environment admin -> EnvironmentDetails
 *   PATCH  /api/v1/environments/:id                install admin  { name?, description?, type?, locked? } -> EnvironmentDef
 *   DELETE /api/v1/environments/:id                install admin  { confirmName } -> { ok }  (not Default, not the last production)
 *   GET    /api/v1/environments/:id/access         install admin or its environment admin -> { items: EnvironmentAccessEntry[] }
 *   PUT    /api/v1/environments/:id/access/:user   same  { isEnvAdmin? } -> EnvironmentAccessEntry
 *   DELETE /api/v1/environments/:id/access/:user   same -> { ok }  (also removes the user's roles there)
 *   GET    /api/v1/install/audit                   install admin -> AuditPageResponse (install-level audit: environments, install admins)
 */
export interface EnvironmentsResponse {
  items: EnvironmentDef[]
  /** the install's limit (APPBUILDER_MAX_ENVIRONMENTS, default 5) */
  max?: number
  /** the caller may create one now (install admin, below the limit, not demo) */
  canCreate?: boolean
  /** why canCreate is false, in words */
  createBlocked?: string
}
export interface EnvironmentCreateRequest {
  name: string
  type: EnvironmentDef['type']
  description?: string
  /** seed the sample tables and app (ignored with copyFrom) */
  sampleData?: boolean
  /** id of an environment to copy */
  copyFrom?: string
  /** schema: tables, apps, roles, solutions, connections without secrets; data: also rows, attachments, data files */
  copy?: 'schema' | 'data'
}
export interface EnvironmentSizes { tables: number; rowEstimate: number; databaseBytes: number; attachmentBytes: number; attachments: number; files: number }
export interface EnvironmentDetails extends EnvironmentDef {
  sizes?: EnvironmentSizes
  /** users who may enter it */
  accessCount?: number
}
export interface EnvironmentAccessEntry { userId: string; name: string; email: string; isEnvAdmin: boolean; isInstallAdmin?: boolean; grantedOn?: string; grantedBy?: string; status?: 'active' | 'disabled' }

/**
 * GET /api/v1/audit (administrators) -> one page of the audit log, newest first.
 * Query: action (exact, or a prefix ending in "."), user (user id), from / to (ISO date or timestamp; from inclusive,
 * to exclusive), page (1-based, default 1), pageSize (1-200, default 50). `actions`: every action name in the log.
 */
export interface AuditEntry {
  id: number
  at: string
  userId: string | null
  /** name and email of the acting user when the account still exists */
  userName?: string
  userEmail?: string
  action: string
  tableId: string | null
  rowId: string | null
  details: unknown
  /** install-level audit (GET /install/audit): the environment the action was about */
  environmentId?: string | null
}
export interface AuditPageResponse { items: AuditEntry[]; total: number; page: number; pageSize: number; actions: string[] }

/**
 * GET /api/v1/workspace -> everything the signed-in user may see.
 * Tables: hidden columns (CLS 'none') are removed from each TableDef.
 * roles/users: full lists for admins; for others only their own user and roles.
 */
export interface WorkspaceResponse {
  apps: AppMeta[]
  tables: TableDef[]
  roles: RoleDef[]
  users: UserDef[]
  connections: ConnectionRef[]
  solutions: SolutionDef[]
  dataFiles: DataFileDef[]
  session: Session
  storage: { kind: 'postgres'; location: string }
  /** the environments (same as GET /api/v1/environments); absent from servers older than 0.5 */
  environments?: EnvironmentDef[]
}

/* apps (makers write; any user with app access reads)
 *   GET    /api/v1/apps/:id                 -> { meta: AppMeta; definition: AppDef }
 *   POST   /api/v1/apps                     { name, width, height, template? } -> AppMeta
 *   PUT    /api/v1/apps/:id                 { definition: AppDef } -> AppMeta
 *   PATCH  /api/v1/apps/:id                 { name } -> AppMeta
 *   POST   /api/v1/apps/:id/duplicate       -> AppMeta
 *   DELETE /api/v1/apps/:id                 -> { ok: true }
 *   GET    /api/v1/apps/:id/package?data=1  -> { yaml: string }
 *   POST   /api/v1/apps/import              { yaml } -> AppMeta
 */
export interface AppGetResponse { meta: AppMeta; definition: AppDef }
export interface AppCreateRequest { name: string; width: number; height: number; template?: 'blank' | 'sample' }

/* tables (makers)
 *   POST   /api/v1/tables                         { displayName, name?, description?, columns?, connectionId? } -> TableDef
 *   PATCH  /api/v1/tables/:id                     { displayName?, description?, primaryColumn? } -> TableDef
 *   DELETE /api/v1/tables/:id?dropSource=1        -> { ok: true }   (dropSource: also drop the physical table; only for tables the
 *                                                 platform created (not linked ones), never the default)
 *   POST   /api/v1/tables/:id/assign-owner        { userId? } -> { updated: number }   (admin: rows without owner get one)
 *   POST   /api/v1/tables/:id/columns             ColumnInput -> TableDef
 *   PATCH  /api/v1/tables/:id/columns/:name       Partial<ColumnDef> -> TableDef
 *   DELETE /api/v1/tables/:id/columns/:name       -> TableDef
 *   POST   /api/v1/tables/:id/move                { connectionId } -> TableDef
 *   GET    /api/v1/tables/:id/csv                 -> text/csv (rows the user may read, visible columns)
 */
export type ColumnInput = Partial<ColumnDef> & { displayName: string; type: ColumnType }
export interface TableCreateRequest { displayName: string; name?: string; description?: string; columns?: Partial<ColumnDef>[]; connectionId?: string }

/* data (security enforced: RBAC + RLS + CLS)
 *   POST   /api/v1/data/:table/query              Query -> QueryResponse
 *   POST   /api/v1/data/:table/rows               { values } -> { row }        (client may supply values.id, a UUID)
 *   PATCH  /api/v1/data/:table/rows/:id           { changes } -> { row }
 *   POST   /api/v1/data/:table/delete             { ids } -> { deleted: number }
 *   POST   /api/v1/data/:table/import             { csv, mode: 'append'|'replace' } -> { imported: number }
 *   POST   /api/v1/tables/from-csv                { displayName, csv } -> TableDef
 */
export interface QueryResponse { rows: Record<string, QueryValue>[]; total?: number; truncated: boolean }
export interface InsertRequest { values: Record<string, QueryValue> }
export interface UpdateRequest { changes: Record<string, QueryValue> }
export interface RowResponse { row: Record<string, QueryValue> }
export interface DeleteRequest { ids: string[] }

/* attachments
 *   POST   /api/v1/attachments?table=&column=&rowId=&name=   raw body, Content-Type = file MIME -> AttachmentRef
 *   POST   /api/v1/attachments/resolve                       { ids } -> { items: AttachmentRef[] }
 *   GET    /api/v1/attachments/:id                           -> file bytes (Content-Disposition inline; nosniff)
 *   DELETE /api/v1/attachments/:id                           -> { ok: true }
 */
export interface AttachmentResolveResponse { items: AttachmentRef[] }

/* files connector (device only)
 *   POST   /api/v1/files?name=&displayName=        raw body -> DataFileDef  (creates tables, one per sheet)
 *   POST   /api/v1/files/:id/replace?name=          raw body -> DataFileDef
 *   GET    /api/v1/files/:id/download               -> file bytes (current contents incl. edits)
 *   DELETE /api/v1/files/:id?dropTables=1           -> { ok: true }
 */

/* connections (admins manage them; makers may only test, list source tables and link; there is no GET /connections: they arrive in the workspace payload)
 *   POST   /api/v1/connections                       { name, connector, settings?, secret? } -> ConnectionRef
 *   PATCH  /api/v1/connections/:id                   { name?, settings?, secret?, status? } -> ConnectionRef
 *   DELETE /api/v1/connections/:id                   -> { ok: true }    (refused while tables use it, or for the default)
 *   POST   /api/v1/connections/:id/test              -> { ok, message }
 *   POST   /api/v1/connections/:id/default           -> ConnectionRef
 *   GET    /api/v1/connections/:id/source-tables     -> { items: SourceTableInfo[] }
 *   POST   /api/v1/connections/:id/link              { source, displayName?, name?, readOnly?, ensureIdColumn? } -> TableDef
 *          (409 when the source is already linked; ensureIdColumn = consent to add the missing system columns)
 *   PATCH  on the default connection (conn_default) is refused with 400: it is managed by setup / server.json / env
 */
export interface ConnectionCreateRequest { name: string; connector: ConnectorKind; settings?: Record<string, string>; secret?: string }
export interface SourceTableInfo { source: string; columns: { name: string; type: ColumnType }[]; rowCount?: number }

/* security (admins)
 *   POST/PATCH/DELETE /api/v1/roles[/:id]              RoleDef fields -> RoleDef
 *   POST/PATCH/DELETE /api/v1/users[/:id]              { name, email, roleIds, status? } -> UserDef
 *   POST   /api/v1/users/:id/password                  { password } -> { ok: true }
 *
 * solutions (makers)
 *   POST/PATCH/DELETE /api/v1/solutions[/:id]
 *   POST   /api/v1/solutions/:id/components            { kind, id } ; DELETE /api/v1/solutions/:id/components/:kind/:cid
 *   GET    /api/v1/solutions/:id/package?data=1        -> { yaml }   (file components embed their file, base64)
 *   POST   /api/v1/solutions/import/plan               { yaml } -> SolutionPlan   (nothing is changed)
 *   POST   /api/v1/solutions/import                    { yaml, filesAs?, confirm?: SolutionPlan['token'], asCopy? } -> SolutionImportResult
 *          A package whose solution (same id) or components (same ids) already exist in this environment is an UPGRADE in
 *          place: it needs `confirm` = the token of the plan the admin reviewed (409 with the plan otherwise, or when the
 *          environment changed since). asCopy: the old behaviour, new ids for everything.
 *   POST   /api/v1/solutions/:id/deploy                { target, plan?: true, confirm?, includeData? } -> SolutionPlan | SolutionImportResult
 *          exports from the current environment and imports into `target` (an environment id) in one step
 */
export type PlanChange = 'new' | 'changed' | 'unchanged' | 'removed'
export interface PlanColumnChange { name: string; change: 'added' | 'removed' | 'type' | 'changed'; from?: string; to?: string; destructive?: boolean }
export interface PlanItem {
  kind: 'app' | 'table' | 'role' | 'connection' | 'file'
  id: string
  name: string
  change: PlanChange
  /** dropping a table or column (data loss), or a type change that may not convert */
  destructive?: boolean
  /** words for the admin: what will happen */
  note?: string
  columns?: PlanColumnChange[]
}
export interface SolutionPlan {
  mode: 'install' | 'upgrade' | 'copy'
  solution: { id: string; name: string; displayName: string; version: string; fromVersion?: string }
  target: { id: string; name: string; type: EnvironmentDef['type']; locked?: boolean }
  items: PlanItem[]
  destructive: boolean
  /** blocking problems: the import is refused while there are any */
  problems: string[]
  warnings: string[]
  /** pre-upgrade snapshot: whether one will be taken (package J); otherwise a visible "no backup taken" warning */
  backup: { available: boolean; message: string }
  /** pass back as `confirm` to apply exactly this plan */
  token: string
}
export type SolutionImportResult = SolutionDef & { warnings?: string[]; plan?: SolutionPlan; backup?: { taken: boolean; message: string } }
