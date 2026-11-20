/**
 * PLATFORM CONTRACT. Workspace = everything the maker owns: apps, tables,
 * security roles, users, connection references, solutions. Implemented in src/platform,
 * consumed by src/portal (home/maker portal UI), src/studio + src/runtime, and a few controls.
 * Binding. Do not change without the architect.
 */
import type { AppDef, FxRecord, FxValue } from '../contracts.ts'
import type { QueryPlan } from './query.ts'
import type { QueryOptions, QueryState } from './query-cache.ts'
import type { ComputedColumn } from './events.ts'
import type { LiveApi, LiveStatus, NotificationsApi } from './live-api.ts'

/* ------------------------------------------------------------------ storage */

/**
 * Where the demo-mode workspace lives (server mode does not use this: the server owns all data). Paths are
 * forward-slash, relative to the workspace root. In practice the demo uses the 'browser' adapter (IndexedDB);
 * the 'local-folder' kind is only a label kept for tests and in-memory adapters.
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
  /**
   * Server mode, PostgreSQL tables: keep an index on this column so filters, sorting and paging by it stay fast on large
   * tables (Query v2 key index). Lookup and unique columns are always indexed.
   */
  indexed?: boolean
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
  /** a platform column of a system table (core data model): its definition cannot be changed or removed; values follow the table's policy */
  locked?: boolean
  /** type 'file' / 'image': allow several attachments (cell = JSON array of attachment ids) */
  multiple?: boolean
  /** type 'file' / 'image': accepted MIME patterns, e.g. ["image/*", "application/pdf"]; empty = any */
  accept?: string[]
  /** type 'file' / 'image': per-file limit in MB (server default 25) */
  maxSizeMB?: number
  /**
   * server mode: the server computes and stores the value (formula column or rollup; see src/platform/events.ts). Such a
   * column is read-only for everyone; writes to it are ignored.
   */
  computed?: ComputedColumn
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
  /** connection that physically stores the rows. Default connection id: 'conn_default' (the PostgreSQL system database, environment schema). */
  connectionId?: string
  /** physical name inside the connection (database table, file sheet, Google sheet tab). Default derived from name. */
  source?: string
  /** true when the source cannot be written through this connection (e.g. a read-only file or view) */
  readOnly?: boolean
  /** set for tables that came from a data file (files connector) */
  origin?: { kind: 'file'; fileId: string; fileName: string; sheet?: string; importedOn: string }
  /**
   * server mode: true when Appbuilder created the physical table (new table, from CSV, package, move, sample). Only such
   * tables may have their source dropped. Linked tables (they existed before) are never dropped or altered by removals.
   */
  managed?: boolean
  /**
   * server mode, linked tables: system columns (createdOn, modifiedOn, createdBy, owner, id) that the source does not
   * have. Such a table is read-only and no query references these columns.
   */
  missingSystem?: string[]
  /** rows may be owned by a team (the owner column then holds a team id); docs/admin/security-model.md */
  teamOwnership?: boolean
  /** record sharing is on: owners (and roles with the share privilege) may share single rows */
  sharing?: boolean
  /**
   * Data model designer (P0-K, src/model/types.ts): a reporting view (read-only, lineage to one base table; security is the
   * base table's), a summary table refreshed by a job, or a date dimension.
   */
  reporting?: import('../model/types.ts').ReportingDef
  /** column sets that must be unique together (a composite unique index; e.g. the pair of a many-to-many junction table) */
  uniqueTogether?: string[][]
  /**
   * Core data model (P0-N, src/platform/system-tables.ts): a system table present in every environment. It cannot be
   * deleted or renamed; its platform columns are `locked`; makers may add columns when `extensible`. Security is
   * built in (`systemPolicy`), not taken from roles.
   */
  system?: boolean
  /** the group shown in the table list ("People and organisation", "Collaboration", ...) */
  systemGroup?: SystemTableGroup
  /** projection: read-only view over install or security data; table: a real table; placeholder: final shape, filled later */
  systemKind?: 'projection' | 'table' | 'placeholder'
  /** makers may add their own columns */
  extensible?: boolean
  /** built-in row security of a system table (src/platform/system-tables.ts systemPredicate) */
  systemPolicy?: SystemPolicy
  /**
   * polymorphic "regarding" link: the row is about one row of any table (table id in `table`, row id in `id`). Activities,
   * comments, mentions, follows, tag links, attachment links, documents. Visible only to users who can read that row.
   */
  regarding?: { table: string; id: string }
  /**
   * P1-C: roles granted the system table's extra privilege (Approval requests: "Approvals: view", i.e. see requests about
   * records the role's members can read). Set by the approvals settings; kept by provisioning.
   */
  systemPrivilegeRoles?: string[]
  /**
   * Recycle bin (docs/dev/recycle-bin.md): keep deleted rows for this many days (1-3650), restorable; 0 or absent = off
   * (a delete is final). Only tables of the default database. New tables start with 30; tables from before stay off.
   */
  recycleDays?: number
  /**
   * Server-owned (never taken from a client or a package): the physical table has the recycle bin columns (deletedOn,
   * deletedBy, deleteBatch) and partial indexes, so every read leaves deleted rows out. Stays set when recycleDays goes
   * back to 0 (rows already in the bin stay until their time runs out).
   */
  recycleBin?: boolean
  /**
   * P3-P, a synchronous balance (docs/dev/balances.md): this table holds the running balance of the rows of another
   * table (the movements), one row per key, kept by the platform in the same transaction as every movement under a row
   * lock, and the movement is refused when the balance would go below the floor. Both tables in the default database.
   */
  balance?: BalanceDef
}

/** TableDef.balance: "column = sum of movements.quantity per key", never below the floor (docs/dev/balances.md) */
export interface BalanceDef {
  /** the movements table (name or id) whose rows move the balance */
  movements: string
  /** the movements column with the signed quantity (number, decimal or currency) */
  quantity: string
  /** this table's column holding the running balance (number, decimal or currency); kept by the platform */
  column: string
  /** 1 to 4 key columns: `column` of this table = `from` of the movements table (same type) */
  keys: { column: string; from: string }[]
  /** the lowest allowed balance (default 0); null: no floor (the balance may go negative) */
  floor?: number | null
  /** optional column of this table with a per-key minimum (blank: the floor) */
  minColumn?: string
  /** what the balance is called in the refusal ("Stock"; default the table's display name) */
  label?: string
  /** the refusal, with {label} {keys} {floor} {available} {requested} and {<key column>} parts (default: plain English) */
  message?: string
}

export type SystemTableGroup = 'people' | 'collaboration' | 'files' | 'communication' | 'logging' | 'reference' | 'approvals'
/**
 * directory: Users/Departments/Teams (directory rule); own: own rows (owner = me); adminOrOwn: admins all, others own rows;
 * admin: administrators only; reference: everyone reads, administrators write; regarding: rows about a record the user can
 * read; shared: everyone reads and creates, owners and administrators change (tags); members: channel members only;
 * parent: follows the read rule of the row a lookup column points at (document versions, channel messages); approvals: the
 * approval rule (requester, the people asked, delegates, administrators, "Approvals: view" readers of the record; P1-C);
 * chat: channel membership decides reads for everyone, administrators included, and nobody writes through the data API
 * (the four communication tables; P3-A, docs/dev/chat.md).
 */
export type SystemPolicy = 'directory' | 'own' | 'adminOrOwn' | 'admin' | 'reference' | 'shared' | 'regarding' | 'members' | 'parent' | 'approvals' | 'chat'

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

/**
 * Which rows a privilege covers. none < own < (organisation scopes) < all. Organisation scopes (server and demo mode,
 * src/platform/orgsec.ts) compare the row's `owner` with sets derived from the organisation model:
 *  - team: rows owned by the user, by a member of one of the user's teams, or by one of those teams;
 *  - manager: rows owned by the user or a direct report; managerTree: the user or anyone below them in the reporting line;
 *  - department: rows owned by a user of the user's department; departmentTree: that department and every one below it.
 */
export type AccessScope = 'none' | 'own' | 'team' | 'manager' | 'managerTree' | 'department' | 'departmentTree' | 'all'
/** the organisation scopes (owner compared with an organisation-derived set) */
export const ORG_SCOPES = ['team', 'manager', 'managerTree', 'department', 'departmentTree'] as const

/** Column-level security for one column within one role: none = hidden, read = visible but not writable, update = full. */
export type ColumnAccess = 'none' | 'read' | 'update'

/**
 * Row-level security rule (structured, never SQL text): a small AST of three node kinds. All entries of a privilege's
 * `rowFilter` are ANDed. See docs/admin/security-model.md and src/platform/orgsec.ts for the semantics.
 *
 *  - compare: `column` is a column of the table, or a path through lookup columns ("Section.Teacher", at most two
 *    hops: "Enrolment.Section.Teacher" inside an exists). A path condition holds when the referenced row exists and
 *    matches. `value` may be a literal or a token (resolved per request for the current user):
 *      @me, @myEmail, @myDepartment (department id), @myDepartmentCode, @myManager (user id),
 *      @myDepartmentTree, @myTeams, @myReports, @myReportsTree (lists: `eq` means "is one of", `ne` "is none of"),
 *      @team:<code>, @department:<code> (ids of a named team / department; stable across installs),
 *      @departmentTree:<code> (list), and inside an exists: @this (the outer row's id), @this.<Column>.
 *    A comparison with a token the user has no value for (no department, no manager) never matches.
 *  - exists: some row of `table` matches every condition of `where` (a junction table, e.g. Enrolment where
 *    Student = @this and Section.Teacher = @me). Exactly one condition must correlate with the outer row (@this...).
 *  - any: at least one of the conditions holds (OR group).
 */
export type RowCondition = RowCompare | RowExists | RowAny
export interface RowCompare {
  column: string
  op: 'eq' | 'ne' | 'in' | 'contains' | 'startsWith' | 'lt' | 'le' | 'gt' | 'ge' | 'isBlank' | 'notBlank'
  value?: string | number | boolean | Array<string | number>
}
export interface RowExists { exists: { table: string; where: RowCondition[] } }
export interface RowAny { any: RowCondition[] }
export const isRowExists = (c: RowCondition): c is RowExists => !!c && typeof c === 'object' && 'exists' in c
export const isRowAny = (c: RowCondition): c is RowAny => !!c && typeof c === 'object' && 'any' in c
export const isRowCompare = (c: RowCondition): c is RowCompare => !!c && typeof c === 'object' && 'column' in c

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
  /**
   * Record sharing: which rows this role may share with other users and teams (the row's owner may always share
   * it when the table has sharing on). Absent = none. The same rowFilter applies.
   */
  share?: AccessScope
}
export interface RoleDef {
  id: string
  name: string
  description?: string
  /** full access to everything; cannot be deleted when it is the last admin role */
  isAdmin?: boolean
  /** may create and edit apps, tables and connections (ab_roles.is_maker) */
  isMaker?: boolean
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
  /** server mode: an administrator set the password; the user must change it before doing anything else */
  mustChangePassword?: boolean
  lastLogin?: string
  /**
   * server mode: install administrator (ab.users.is_install_admin). Manages environments, user accounts and the install;
   * enters every environment and is an environment administrator in each. See docs/admin/users-and-roles.md.
   */
  isInstallAdmin?: boolean
  /** server mode: the environment the user last switched to (remembered on the user record) */
  lastEnvironmentId?: string
  /** organisation (install-wide, docs/admin/organisation.md): department id */
  departmentId?: string
  /** user id of the direct manager */
  managerId?: string
  jobTitle?: string
  phone?: string
  employeeCode?: string
  /** resolved organisation facts for User() (computed, read-only; present on the session user) */
  org?: UserOrgInfo
  /** server mode (package I): a service account (API keys only, never signs in); people have no kind */
  kind?: 'service'
  /** server mode: when the password was last set */
  passwordChangedOn?: string
  /** session user only (package I): two-step verification is set up */
  mfaEnabled?: boolean
  /** session user only: policy requires two-step verification; enrolBy = the end of the grace period (ISO) */
  mfaRequired?: { enrolBy: string | null }
  /** session user only: the grace period is over; the session may only set up two-step verification */
  mfaEnrolmentRequired?: boolean
}

/** what User() exposes about the organisation (computed from the directory) */
export interface UserOrgInfo {
  department?: { id: string; code: string; name: string }
  manager?: { id: string; name: string; email: string }
  teams: { id: string; code: string; name: string }[]
}

/** A department (install-wide tree; schema ab.departments). `code` is stable and used by rules and solutions. */
export interface DepartmentDef {
  id: string
  code: string
  name: string
  parentId?: string
  description?: string
}

/**
 * A team (install-wide; schema ab.teams): a named group of users that can own rows and receive shares. A team with an
 * `environmentId` only counts in that environment; without one it counts in every environment.
 */
export interface TeamDef {
  id: string
  code: string
  name: string
  description?: string
  environmentId?: string
  memberIds: string[]
}

/** One record share (per environment, ab_shares): the row is shared with a user or a team for read or read+update. */
export interface ShareDef {
  tableId: string
  rowId: string
  principalType: 'user' | 'team'
  principalId: string
  access: 'read' | 'update'
  sharedBy?: string
  sharedOn?: string
  /** display name of the principal (filled by list calls) */
  principalName?: string
}

/**
 * What the signed-in user may do, computed by the server (authoritative) and mirrored in the client
 * for UX only (disable buttons, pre-validate). Keyed by table id.
 */
export interface EffectivePrivileges {
  /** administrator of the current environment (an Administrator role there, or install administrator) */
  isAdmin: boolean
  /** install administrator (environments, user accounts, install audit); absent in demo mode */
  isInstallAdmin?: boolean
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
    /** share privilege (absent = none); sharing must also be on for the table */
    share?: AccessScope
  }>
  apps: string[] | 'all'
}

/**
 * An environment: one workspace (tables, apps, roles, connections, solutions, files, attachments, audit) on this install,
 * stored in its own database schema env_<id> and workspace folder workspace/env/<id>/. Users are install-wide; what
 * they may do is per environment (docs/admin/environments.md).
 */
export type EnvironmentType = 'production' | 'sandbox' | 'developer'
/** ready: usable. creating / deleting: an operation is running. failed: creation, deletion or its migration failed */
export type EnvironmentState = 'ready' | 'creating' | 'deleting' | 'failed' | 'restoring'
export interface EnvironmentDef {
  /** slug, also the schema suffix (env_<id>); never changes */
  id: string
  name: string
  type: EnvironmentType
  /** the install's own environment ("Default"); cannot be deleted */
  builtIn: boolean
  /** when it was created (Default: when the install was set up); absent when unknown */
  createdOn?: string
  description?: string
  /** server mode: absent means ready */
  state?: EnvironmentState
  /** production only: apps, tables and roles change only by solution import (server-enforced) */
  locked?: boolean
  /** the signed-in user may manage it (install administrator, or environment administrator of it) */
  canManage?: boolean
  /** install administrators and its environment administrators only */
  details?: {
    database: string
    schemaVersion?: number
    schema?: string
    createdBy?: string
    /** why state is failed */
    error?: string
  }
}

export interface Session {
  user: UserDef
  privileges: EffectivePrivileges
  expiresOn: string
  /** server mode: the environment this session's privileges belong to */
  environmentId?: string
}
export type DataOp = 'create' | 'read' | 'update' | 'delete'

/* ------------------------------------------------------------------ connections, solutions */

/**
 * Functional connectors: 'postgres' (the default database, and external PostgreSQL databases), 'mysql' (external
 * MySQL/MariaDB databases), 'files' (CSV / Excel .xlsx / JSON data files copied into the workspace's designated files
 * folder; device-only), 'gsheets' (Google Sheets via a service account). 'php-gateway' is a later phase. Others are
 * placeholders.
 * 'local-csv' is the legacy demo-mode connector.
 */
export type ConnectorKind =
  | 'postgres' | 'mysql' | 'files' | 'gsheets' | 'php-gateway'
  | 'local-csv' | 'rest' | 'sqlserver' | 'supabase' | 'firebase' | 'excel'
  /** P1: action connectors (no tables): generic HTTP / REST APIs and email through the install's relay */
  | 'http' | 'email'
  /** P2-E: Meta WhatsApp Business Cloud API (actions only; server/core/whatsapp) */
  | 'whatsapp'
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

export type SolutionComponentKind = 'app' | 'table' | 'role' | 'connection' | 'file' | 'flow' | 'approvalPolicy' | 'printTemplate' | 'dashboard'
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
  /** 'server' = the local Node server (PostgreSQL, real login, server-enforced security); 'demo' = browser-only simulation */
  mode: 'server' | 'demo'
  /** server mode first-run state. Both false once the workspace is usable. */
  setup: {
    needsDatabase: boolean
    needsAdmin: boolean
    /** the configured database cannot be reached right now (the server keeps retrying) */
    unavailable?: boolean
    /** the database was upgraded by a newer Appbuilder; this server refuses to use it */
    incompatible?: boolean
    /** while setup is needed: where the setup code is (console window, or the setup-code file of a service) and the server's OS */
    codeIn?: 'console' | 'file'
    platform?: 'windows' | 'linux' | 'macos'
  }
  /** null when signed out (server mode). Demo mode: always the run-as user. */
  session: Session | null
  storage: { kind: StorageAdapter['kind'] | 'postgres'; location: string }
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
  /** environments the user can open and the selected one (every request carries it, X-Appbuilder-Environment) */
  environments: EnvironmentDef[]
  environmentId: string
  /** unread in-app notifications of the signed-in user (package H; absent before they are known) */
  unread?: number
  /** realtime connection state (package H): 'open' pushes arrive, 'degraded' periodic refetch, 'off' signed out */
  live?: LiveStatus
  /** organisation (install-wide): departments and teams. Server mode: full for administrators, names for others */
  departments: DepartmentDef[]
  teams: TeamDef[]
}

export type { QueryOptions, QueryState } from './query-cache.ts'

/**
 * Hosting (H-C): every write of a read-only install is refused with HTTP 503 and one of these codes; the message names
 * the reason (and the operator's note). Reads, sign-in and exports go on.
 */
export type ReadOnlyErrorCode = 'install_read_only' | 'licence_read_only'
export const READ_ONLY_ERROR_CODES: readonly ReadOnlyErrorCode[] = ['install_read_only', 'licence_read_only']

export class PlatformError extends Error {
  /** rate_limited = 429 (login / password throttle), method_not_allowed = 405, password_change_required = 403 (the account must set a new password first) */
  code: 'not-found' | 'denied' | 'invalid' | 'conflict' | 'storage' | 'unauthenticated' | 'unavailable' | 'rate_limited' | 'method_not_allowed' | 'password_change_required'
    /** package I: sign-in needs the second step; the action needs a fresh password or code; two-step verification must be set up first */
    | 'mfa_required' | 'reauth_required' | 'mfa_enrolment_required'
    /** hosting (H-C): 503, the install is read-only (suspended, payment, maintenance) or its licence could not be verified */
    | ReadOnlyErrorCode
  /** the server's request id of the failed call (X-Request-Id): shown as "Reference: ..." so support can find it in the log */
  requestId?: string
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
    create(input: { displayName: string; name?: string; description?: string; columns?: Partial<ColumnDef>[]; connectionId?: string }): Promise<TableDef>
    update(id: string, patch: Partial<Pick<TableDef, 'displayName' | 'description' | 'primaryColumn' | 'teamOwnership' | 'sharing' | 'recycleDays'>>): Promise<void>
    /** dropSource (server mode, default false): also drop the physical table; only for tables Appbuilder created (`managed`) */
    remove(id: string, opts?: { dropSource?: boolean }): Promise<void>
    addColumn(tableId: string, col: Partial<ColumnDef> & { displayName: string; type: ColumnType }): Promise<ColumnDef>
    updateColumn(tableId: string, name: string, patch: Partial<ColumnDef>): Promise<void>
    removeColumn(tableId: string, name: string): Promise<void>
    /** by name or id; undefined when missing */
    get(nameOrId: string): TableDef | undefined

    /**
     * Synchronous reads from the in-memory cache (demo mode loads every table at init; server mode loads each
     * table lazily on first use and returns [] until it has arrived).
     * `secure: true` (default) applies the current user's read scope; false = raw (portal admin grid).
     * Server mode ignores `secure`: the server always enforces the user's privileges.
     */
    rows(tableName: string, opts?: { secure?: boolean }): Row[]
    /**
     * Synchronous writes to the cache + async persist (demo: workspace storage; server: the API). Throw PlatformError('denied') when the
     * current user's role does not allow it (unless secure:false), PlatformError('invalid') on
     * required/unique/type violations. Values are coerced to the column types.
     */
    insert(tableName: string, values: FxRecord, opts?: { secure?: boolean }): Row
    /**
     * opts.ifVersion (server mode; package H): the row's modifiedOn the caller started from. The server refuses a stale
     * save with 409 (DataErrorEvent error code 'conflict', field 'modifiedOn'): someone else saved the row in between.
     */
    update(tableName: string, id: string, changes: FxRecord, opts?: { secure?: boolean; ifVersion?: Date | string | null }): Row
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
    /**
     * Query v2 (docs/dev/query-v2.md): run a plan and wait for the answer. Server mode: POST /api/v1/query through the
     * client query cache (de-duplicated, cached by plan, invalidated by writes to the table). Demo mode: the reference
     * executor over the in-memory rows the current user may read. Rejects with the server's PlatformError.
     */
    query(plan: QueryPlan, opts?: QueryOptions): Promise<QueryState>
    /**
     * The cached state of a plan, synchronously; starts or refreshes the fetch when needed (subscribe with onQueryChange).
     * `pageSize` pages an unbounded rows plan (first page now, loadMore() for the next); `owner` names who wants it, so a
     * request nobody wants any more is cancelled.
     */
    queryState(plan: QueryPlan, opts?: QueryOptions): QueryState
    /** paged plans: fetch the next page of the entry with this key */
    loadMore(key: string): Promise<void>
    /** an owner no longer reads its plan (control unmounted) */
    releaseQuery(owner: string): void
    /** fires with the cache keys whose state changed */
    onQueryChange(listener: (keys: string[]) => void): () => void
    /** the rows of a table changed elsewhere (table-changed message): cached queries of it refetch */
    invalidateQueries(tableName: string): void
    /**
     * What the client knows about a table's size: server mode counts the rows the user may read (a cached count query)
     * and says whether every row is held in memory (small tables). Demo mode: always fully loaded.
     */
    sizeInfo(tableName: string): { rowCount?: number; fullyLoaded: boolean }
    /** list tables available inside a connection that are not yet registered (existing database tables, sheets, file sheets) */
    listSourceTables(connectionId: string): Promise<{ source: string; columns: { name: string; type: ColumnType }[]; rowCount?: number }[]>
    /** register an existing source table as a workspace table (columns inferred; system columns added where the source allows) */
    /** ensureIdColumn: consent to add the missing system columns (id, createdOn, modifiedOn, createdBy, owner); without it such a table links read-only */
    linkSourceTable(connectionId: string, source: string, input?: { displayName?: string; name?: string; ensureIdColumn?: boolean; readOnly?: boolean }): Promise<TableDef>
    /** copy a table into another connection (e.g. a file table into the default database), keeping its name so formulas keep working */
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
    /** server mode (package I): finish a sign-in that returned a session another way (second step, invitation, enrolment) */
    completeSignIn?(session: Session): Promise<Session>
    logout(): Promise<void>
    changePassword(current: string, next: string): Promise<void>
    /** self-service: change the signed-in user's own display name (nothing else). Demo mode: the run-as user. */
    updateProfile(input: { name: string }): Promise<UserDef>
    /** first-run: the database connection for the default store (server tests it, creates the system tables) */
    /** setupCode: the one-time code the server prints to its console (first run) */
    setupDatabase(input: { host: string; port: number; database: string; user: string; password: string; createDatabase?: boolean; ssl?: boolean; setupCode?: string }): Promise<void>
    /** first-run: create the first administrator and sign in */
    setupAdmin(input: { name: string; email: string; password: string; setupCode?: string }): Promise<Session>
  }

  /**
   * Environments (both backends). Server mode: the environments the user was granted (install administrators: all);
   * select() remembers the choice on the user record (and in this browser) and reloads the workspace of that
   * environment. Demo mode: one built-in "Default" environment. Managing environments: src/portal/environmentApi.ts.
   */
  environments: {
    /** fetch the list again (server: GET /api/v1/environments) */
    list(): Promise<EnvironmentDef[]>
    /** the selected environment (null before init or while signed out) */
    current(): EnvironmentDef | null
    /** switch to an environment by id (reloads the workspace); PlatformError('not-found') for an unknown id */
    select(id: string): Promise<EnvironmentDef>
  }

  /** subscribe to rolled-back writes (server mode). Returns unsubscribe. */
  onDataError(listener: (e: DataErrorEvent) => void): () => void

  /** realtime (package H, docs/dev/live.md): topics, presence, Studio locks. Demo mode: between tabs of this browser. */
  live: LiveApi
  /** in-app notifications of the signed-in user (package H) */
  notifications: NotificationsApi
  /** core data model (P0-N): timelines, comments, activities, follows, tags, tasks, mentions (src/platform/collab-api.ts) */
  collab?: import('./collab-api.ts').CollabApi
  /** recycle bin (docs/dev/recycle-bin.md): Undo after a delete, the Deleted view, restore, purge (src/platform/recycle-api.ts) */
  recycle?: import('./recycle-api.ts').RecycleApi

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

  /**
   * Organisation (docs/admin/organisation.md) and record sharing. Server mode: /api/v1/org, /departments, /teams,
   * /users/import, /shares, /security/explain. Demo mode: the same rules over the browser workspace.
   */
  org: {
    /** reload departments and teams into the state */
    refresh(): Promise<void>
    createDepartment(input: Omit<DepartmentDef, 'id'>): Promise<DepartmentDef>
    updateDepartment(id: string, patch: Partial<Omit<DepartmentDef, 'id'>>): Promise<void>
    removeDepartment(id: string): Promise<void>
    createTeam(input: Omit<TeamDef, 'id'>): Promise<TeamDef>
    updateTeam(id: string, patch: Partial<Omit<TeamDef, 'id'>>): Promise<void>
    removeTeam(id: string): Promise<void>
    /** people and teams for pickers (any signed-in user) */
    directory(): Promise<OrgDirectoryInfo>
    /** CSV of users: preview (commit false) or import all-or-nothing (commit true; new users get one-time passwords) */
    importUsers(csv: string, commit: boolean): Promise<UserImportResult>
    /** shares of one row (table optional: found among the tables with sharing on) */
    shares(rowId: string, table?: string): Promise<SharesInfo>
    /** principal: a user id or email, or a team id or code; access read (default) or update */
    share(rowId: string, principal: string, access?: 'read' | 'update', table?: string): Promise<SharesInfo>
    unshare(rowId: string, principal: string, table?: string): Promise<SharesInfo>
    /** administrators: who can read, update, delete the row and why */
    explain(table: string, rowId: string, userId?: string): Promise<ExplainResult>
  }

  connections: {
    /** secret: password (postgres, mysql) or service-account key JSON text (gsheets); stored encrypted on the server */
    create(input: { name: string; connector: ConnectorKind; settings?: Record<string, string>; secret?: string }): Promise<ConnectionRef>
    update(id: string, patch: Partial<Omit<ConnectionRef, 'id' | 'hasSecret'>> & { secret?: string }): Promise<void>
    remove(id: string): Promise<void>
    test(id: string): Promise<{ ok: boolean; message: string }>
    /** make this connection the default store for new tables (postgres only) */
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
    /**
     * `filesAs` (server mode only; demo mode has no data files): what file components become, 'database' tables
     * (default) or 'file' data files.
     */
    /**
     * server mode: a package whose solution or components (same ids) exist here is an in-place upgrade and needs
     * `confirm` = the token of the reviewed plan (src/portal/environmentApi.ts planImport); asCopy: new instances
     */
    importPackage(yamlText: string, opts?: { filesAs?: 'database' | 'file'; confirm?: string; asCopy?: boolean; proceedWithoutBackup?: boolean; connectionMap?: Record<string, string>; peopleMap?: Record<string, string>; enableFlows?: boolean | string[] }): Promise<SolutionDef & { warnings?: string[] }>
  }
}

export interface OrgDirectoryInfo {
  users: { id: string; name: string; email: string }[]
  teams: { id: string; code: string; name: string }[]
}
export interface SharesInfo {
  table: string
  row: string
  sharing: boolean
  canShare: boolean
  canShareUpdate: boolean
  shares: ShareDef[]
}
export interface ExplainResult {
  users: { userId: string; name: string; email: string; read: string[]; update: string[]; delete: string[] }[]
}
export interface UserImportRow {
  line: number
  action: 'create' | 'update' | 'error'
  name: string
  email: string
  department?: string
  manager?: string
  jobTitle?: string
  roles?: string[]
  errors: string[]
}
export type UserImportResult =
  | { preview: UserImportRow[]; ok: boolean; unknownColumns: string[] }
  | { created: { email: string; name: string; temporaryPassword: string }[]; updated: number }

/** Convenience for formulas: User() record. */
export function userRecord(u: UserDef, roles: RoleDef[]): FxRecord {
  const names: FxValue[] = roles.filter((r) => u.roleIds.includes(r.id)).map((r) => ({ Value: r.name }))
  const o = u.org
  const manager: FxValue = o?.manager ? { FullName: o.manager.name, Email: o.manager.email, Id: o.manager.id } : null
  const teams: FxValue[] = (o?.teams ?? []).map((t) => ({ Name: t.name, Code: t.code, Id: t.id }))
  return {
    FullName: u.name, Email: u.email, Id: u.id, Roles: names,
    Department: o?.department?.name ?? null, DepartmentCode: o?.department?.code ?? null,
    Manager: manager, JobTitle: u.jobTitle ?? null, Teams: teams,
  }
}
