/**
 * MetaStore over the system tables in PostgreSQL (docs/dev/schema.md).
 *
 * Layout: schema `ab` holds the install-wide objects (settings, users, sessions, environments, licence); each environment
 * is one schema `env_<id>` holding its metadata tables (ab_roles, ab_tables, ab_apps, ab_audit, ...) and the data tables of
 * the default connection. Every statement names its tables fully qualified ("schema"."table"); the environment schema is
 * resolved at call time from env-context.ts, so one MetaStore serves every environment and nothing depends on search_path.
 * Metadata documents are jsonb, timestamps timestamptz, flags boolean, ids text.
 */
import type {
  AttachmentRecord, ConnectionRecord, EnvironmentRecord, EnvironmentRef, MetaStore, MigrationSummary, SecretBox, SqlDb, UserRecord,
} from './contracts.ts'
import type {
  AccessScope, AppMeta, ColumnAccess, ConnectionRef, DataFileDef, RoleDef, RowCondition, SolutionDef, TableDef, TablePrivilege,
} from '../../src/platform/contracts.ts'
import type { AppDef } from '../../src/contracts.ts'
import { parseJson, toDate, toIso } from './util.ts'
import { DEFAULT_ENVIRONMENT_ID, INSTALL_SCHEMA, currentEnvironment, environmentSchema } from './env-context.ts'
import { ORG_INSTALL_DDL, createOrgStore, orgEnvironmentDdl } from './org-store.ts'
import { KERNEL_TABLES, kernelDdl } from './kernel-ddl.ts'
import { NOTIFICATION_INSTALL_DDL, NOTIFICATION_TABLES } from './notifications-ddl.ts'
import { IDENTITY_INSTALL_DDL, IDENTITY_TABLES, upgradeInstallTo7Identity } from './identity/ddl.ts'
import { BACKUP_INSTALL_DDL, BACKUP_TABLES, upgradeInstallTo7Backup } from './backup/ddl.ts'
import { MODEL_TABLES, createRelationshipStore, modelEnvironmentDdl, upgradeEnvironmentTo7Model } from './model/store.ts'
import { dropSystemViews, provisionSystemTables } from './system-tables.ts'

/**
 * 1-3: the MySQL system store (no longer supported, never upgraded: there is no migration path from MySQL).
 * 4: PostgreSQL layout, schema `ab` plus one schema per environment.
 * 5: real environments: ab.environments (state, schema_version, locked, ...), ab.environment_access, ab.audit (install
 *    level), ab.users.is_install_admin / last_environment_id; every environment schema carries its own schema_version.
 * 6: P0 wave 3: organisation (ab.departments, ab.teams, ab.team_members; F), in-app notifications (ab.notifications,
 *    ab.user_settings; H), per environment ab_shares (F) and the event and job kernel (ab_outbox, ab_jobs, ab_schedules,
 *    ab_table_events, ab_event_runs; G). Rule: a package that adds or changes tables bumps this number and adds a step.
 * 7: P0 wave 4 (shared number). I: identity (ab.user_mfa, auth_tokens, trusted_devices, password_history, signin_log,
 *    mail_log, api_keys; users.kind / password_changed_on; sessions.ip / public_id / absolute_expires_on / auth_on / mfa /
 *    restricted), step upgradeInstallTo7Identity (identity/ddl.ts).
 *    J: backup catalogue (ab.backups, ab.backup_ops), step upgradeInstallTo7Backup (backup/ddl.ts).
 *    K: data model designer, per environment ab_relationships, ab_model_layouts, ab_model_drafts; environment step
 *    upgradeEnvironmentTo7Model (model/store.ts) records the existing lookups as explicit relationships.
 *    N: core data model, per environment system tables sys_* (views over ab.* and real tables), registered in ab_tables
 *    with stable ids; provisionSystemTables (system-tables.ts) runs after the steps and at every start (idempotent).
 */
export const SCHEMA_VERSION = 7

/** the database was upgraded by a newer server: this one must not touch it (downgrade guard) */
export class SchemaTooNewError extends Error {
  database: number
  server: number
  constructor(database: number, server: number) {
    super(`The database schema is version ${database}, but this Appbuilder only knows version ${server}. It was upgraded by a newer Appbuilder; run that version (or restore a backup taken before the upgrade).`)
    this.database = database
    this.server = server
  }
}

/** the database cannot hold Appbuilder's data (e.g. not UTF-8): nothing was created */
export class UnsuitableDatabaseError extends Error {}

/** RoleDef as stored: the optional maker flag (ab_roles.is_maker) travels with the role. */
export type StoredRole = RoleDef & { isMaker?: boolean }

/* ------------------------------------------------------------------ DDL */

const q = (id: string): string => `"${id}"`
const A = (t: string): string => `${q(INSTALL_SCHEMA)}.${q(t)}`

/** install-wide objects in schema ab */
export const INSTALL_DDL: string[] = [
  `CREATE SCHEMA IF NOT EXISTS ${q(INSTALL_SCHEMA)}`,
  `CREATE TABLE IF NOT EXISTS ${A('settings')} (
    k text PRIMARY KEY,
    v text NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${A('users')} (
    id text PRIMARY KEY,
    name text NOT NULL,
    email text NOT NULL,
    password_hash text NULL,
    status text NOT NULL DEFAULT 'active',
    must_change_password boolean NOT NULL DEFAULT false,
    created_on timestamptz NOT NULL,
    last_login timestamptz NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_users_email ON ${A('users')} (email)`,
  `CREATE TABLE IF NOT EXISTS ${A('sessions')} (
    id_hash text PRIMARY KEY,
    user_id text NOT NULL,
    created_on timestamptz NOT NULL,
    expires_on timestamptz NOT NULL,
    last_seen timestamptz NOT NULL,
    user_agent text NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ab_ix_sessions_user ON ${A('sessions')} (user_id)`,
  `CREATE INDEX IF NOT EXISTS ab_ix_sessions_expires ON ${A('sessions')} (expires_on)`,
  `CREATE TABLE IF NOT EXISTS ${A('environments')} (
    id text PRIMARY KEY,
    name text NOT NULL,
    schema_name text NOT NULL UNIQUE,
    type text NOT NULL DEFAULT 'production',
    built_in boolean NOT NULL DEFAULT false,
    created_on timestamptz NOT NULL
  )`,
  // version 5: users carry the install-admin flag and their last environment; environments their lifecycle
  `ALTER TABLE ${A('users')} ADD COLUMN IF NOT EXISTS is_install_admin boolean NOT NULL DEFAULT false`,
  `ALTER TABLE ${A('users')} ADD COLUMN IF NOT EXISTS last_environment_id text NULL`,
  `ALTER TABLE ${A('environments')} ADD COLUMN IF NOT EXISTS description text NULL`,
  `ALTER TABLE ${A('environments')} ADD COLUMN IF NOT EXISTS created_by text NULL`,
  `ALTER TABLE ${A('environments')} ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'ready'`,
  `ALTER TABLE ${A('environments')} ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 0`,
  `ALTER TABLE ${A('environments')} ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false`,
  `ALTER TABLE ${A('environments')} ADD COLUMN IF NOT EXISTS last_error text NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_environments_name ON ${A('environments')} (lower(name))`,
  `CREATE TABLE IF NOT EXISTS ${A('environment_access')} (
    environment_id text NOT NULL,
    user_id text NOT NULL,
    is_env_admin boolean NOT NULL DEFAULT false,
    granted_on timestamptz NOT NULL,
    granted_by text NULL,
    PRIMARY KEY (environment_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS ab_ix_environment_access_user ON ${A('environment_access')} (user_id)`,
  // install-level audit: environment lifecycle and access, install administrators, install migrations
  `CREATE TABLE IF NOT EXISTS ${A('audit')} (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at timestamptz NOT NULL,
    user_id text NULL,
    action text NOT NULL,
    environment_id text NULL,
    details jsonb NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ab_ix_install_audit_at ON ${A('audit')} (at)`,
  `CREATE INDEX IF NOT EXISTS ab_ix_install_audit_action ON ${A('audit')} (action)`,
  // placeholder for the signed licence file (docs/plan/master-plan.md section 9): one row at most
  `CREATE TABLE IF NOT EXISTS ${A('licence')} (
    id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    document jsonb NULL,
    installed_on timestamptz NULL
  )`,
  // P0-F organisation model (idempotent, runs on every start): departments, teams, user organisation fields
  ...ORG_INSTALL_DDL,
  // P0-H in-app notifications and per-user settings (idempotent)
  ...NOTIFICATION_INSTALL_DDL,
  // P0-I identity (idempotent): two-step verification, tokens, devices, sign-in and mail logs, API keys
  ...IDENTITY_INSTALL_DDL,
  // P0-J backup catalogue (idempotent)
  ...BACKUP_INSTALL_DDL,
]

/** the metadata tables of one environment schema */
export function environmentDdl(schema: string): string[] {
  const E = (t: string): string => `${q(schema)}.${q(t)}`
  return [
    `CREATE SCHEMA IF NOT EXISTS ${q(schema)}`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_roles')} (
      id text PRIMARY KEY,
      name text NOT NULL,
      description text NULL,
      is_admin boolean NOT NULL DEFAULT false,
      is_maker boolean NOT NULL DEFAULT false,
      apps jsonb NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_roles_name ON ${E('ab_roles')} (lower(name))`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_user_roles')} (
      user_id text NOT NULL,
      role_id text NOT NULL,
      PRIMARY KEY (user_id, role_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_user_roles_role ON ${E('ab_user_roles')} (role_id)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_role_tables')} (
      role_id text NOT NULL,
      table_id text NOT NULL,
      can_create boolean NOT NULL DEFAULT false,
      read_scope text NOT NULL DEFAULT 'none',
      update_scope text NOT NULL DEFAULT 'none',
      delete_scope text NOT NULL DEFAULT 'none',
      columns jsonb NULL,
      row_filter jsonb NULL,
      PRIMARY KEY (role_id, table_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_role_tables_table ON ${E('ab_role_tables')} (table_id)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_tables')} (
      id text PRIMARY KEY,
      name text NOT NULL,
      connection_id text NULL,
      source text NULL,
      def jsonb NOT NULL,
      created_on timestamptz NOT NULL,
      modified_on timestamptz NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_tables_name ON ${E('ab_tables')} (lower(name))`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_apps')} (
      id text PRIMARY KEY,
      name text NOT NULL,
      description text NULL,
      width integer NOT NULL DEFAULT 1920,
      height integer NOT NULL DEFAULT 1080,
      definition jsonb NOT NULL,
      created_on timestamptz NOT NULL,
      modified_on timestamptz NOT NULL,
      modified_by text NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_apps_name ON ${E('ab_apps')} (lower(name))`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_connections')} (
      id text PRIMARY KEY,
      name text NOT NULL,
      connector text NOT NULL,
      settings jsonb NULL,
      secret_sealed text NULL,
      status text NOT NULL DEFAULT 'not-configured',
      last_error text NULL,
      is_default boolean NOT NULL DEFAULT false,
      scope text NOT NULL DEFAULT 'server',
      created_on timestamptz NOT NULL,
      modified_on timestamptz NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_connections_name ON ${E('ab_connections')} (lower(name))`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_solutions')} (
      id text PRIMARY KEY,
      name text NOT NULL,
      display_name text NOT NULL,
      publisher text NULL,
      version text NULL,
      description text NULL,
      components jsonb NULL,
      created_on timestamptz NOT NULL,
      modified_on timestamptz NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_solutions_name ON ${E('ab_solutions')} (lower(name))`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_data_files')} (
      id text PRIMARY KEY,
      connection_id text NOT NULL,
      file_name text NOT NULL,
      original_name text NULL,
      kind text NOT NULL,
      size_bytes bigint NOT NULL DEFAULT 0,
      checksum text NULL,
      storage_key text NULL,
      imported_on timestamptz NOT NULL,
      table_ids jsonb NULL,
      modified_since_import boolean NOT NULL DEFAULT false
    )`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_attachments')} (
      id text PRIMARY KEY,
      table_id text NOT NULL,
      col text NOT NULL,
      row_id text NOT NULL,
      file_name text NOT NULL,
      mime text NOT NULL,
      size_bytes bigint NOT NULL,
      sha256 text NOT NULL,
      storage_key text NOT NULL,
      created_by text NULL,
      created_on timestamptz NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_attachments_row ON ${E('ab_attachments')} (table_id, row_id)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_attachments_created ON ${E('ab_attachments')} (created_on)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_counters')} (
      k text PRIMARY KEY,
      v bigint NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_audit')} (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      at timestamptz NOT NULL,
      user_id text NULL,
      action text NOT NULL,
      table_id text NULL,
      row_id text NULL,
      details jsonb NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_audit_at ON ${E('ab_audit')} (at)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_audit_action ON ${E('ab_audit')} (action)`,
    // event and job kernel: outbox, jobs, schedules, table events, run log (kernel-ddl.ts)
    ...kernelDdl(schema),
    // P0-F record sharing (idempotent)
    ...orgEnvironmentDdl(schema),
    // P0-K data model designer: relationships, diagram layouts, drafts (idempotent)
    ...modelEnvironmentDdl(schema),
  ]
}

/** names of the metadata tables inside an environment schema (never reachable through a connector: prefix ab_) */
export const ENVIRONMENT_TABLES = [
  'ab_roles', 'ab_user_roles', 'ab_role_tables', 'ab_tables', 'ab_apps', 'ab_connections', 'ab_solutions', 'ab_data_files',
  'ab_attachments', 'ab_counters', 'ab_audit', ...KERNEL_TABLES, 'ab_shares', ...MODEL_TABLES,
]
/** names of the tables in schema ab */
export const INSTALL_TABLES = ['settings', 'users', 'sessions', 'environments', 'environment_access', 'audit', 'licence', 'departments', 'teams', 'team_members', ...NOTIFICATION_TABLES, ...IDENTITY_TABLES, ...BACKUP_TABLES]

/**
 * Creates (or completes) the metadata tables of an environment schema and registers it (state ready, schema_version
 * SCHEMA_VERSION). Idempotent; runs on the given SqlDb (call it inside a transaction). environments.ts calls it to
 * create a new environment; migrate() for the built-in Default.
 */
export async function migrateEnvironment(
  db: SqlDb,
  env: { id: string; name: string; type?: EnvironmentRecord['type']; builtIn?: boolean; description?: string; createdBy?: string; state?: EnvironmentRecord['state'] },
): Promise<string> {
  const schema = environmentSchema(env.id)
  for (const stmt of environmentDdl(schema)) await db.exec(stmt)
  await db.exec(
    `INSERT INTO ${A('environments')} (id, name, schema_name, type, built_in, created_on, description, created_by, state, schema_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
    [env.id, env.name, schema, env.type ?? 'production', !!env.builtIn, new Date(), env.description ?? null, env.createdBy ?? null, env.state ?? 'ready', SCHEMA_VERSION],
  )
  return schema
}

/**
 * Upgrade steps of one environment schema, by the version they lead to (run in order, inside the environment's own
 * transaction, after environmentDdl). Version 5 changed nothing inside environment schemas.
 */
export const ENVIRONMENT_STEPS: { to: number; describe: string; run(db: SqlDb, schema: string): Promise<void> }[] = [
  {
    // P0 wave 3: the tables come from environmentDdl (run just before the steps); the step makes sure they are all there
    // before the schema is stamped 6, so a server that does not know them (version 5) refuses this schema
    to: 6,
    describe: 'record sharing (ab_shares) and the event and job kernel (ab_outbox, ab_jobs, ab_schedules, ab_table_events, ab_event_runs)',
    async run(db, schema) {
      for (const t of ['ab_shares', ...KERNEL_TABLES]) {
        const r = await db.query<Row>('SELECT to_regclass($1) IS NOT NULL AS ok', [`"${schema}"."${t}"`])
        if (!bool(r[0]?.ok)) throw new Error(`table ${schema}.${t} is missing after the schema update`)
      }
    },
  },
  {
    // P0-K (independent of the other version 7 steps): the designer's tables, and today's lookups as explicit relationships
    to: 7,
    describe: 'data model designer (ab_relationships, ab_model_layouts, ab_model_drafts); existing lookups recorded as relationships',
    run: upgradeEnvironmentTo7Model,
  },
  {
    // P0-N (independent of the other version 7 steps): the core data model's system tables are provisioned right after
    // the steps (provisionSystemTables, also at every start); this step only checks the registrations exist
    to: 7,
    describe: 'core data model: system tables (people, collaboration, files, communication, logging, reference data)',
    async run() {
      // nothing to do before provisioning; kept so the summary lists the change
    },
  },
]

/** the outcome of migrating one environment at boot */
export interface EnvironmentMigration { id: string; from: number; to: number; ok: boolean; error?: string }

/**
 * Brings one registered environment schema to SCHEMA_VERSION in its own transaction (advisory lock per environment).
 * Throws SchemaTooNewError when it was migrated by a newer server: nothing is changed then.
 */
export async function migrateEnvironmentSchema(db: SqlDb, env: { id: string; schema: string }): Promise<{ from: number; to: number }> {
  return db.tx(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`appbuilder.migrate.${env.id}`])
    const rows = await tx.query<Record<string, unknown>>(`SELECT schema_version FROM ${A('environments')} WHERE id = $1`, [env.id])
    const from = Number(rows[0]?.schema_version) || 0
    if (from > SCHEMA_VERSION) throw new SchemaTooNewError(from, SCHEMA_VERSION)
    if (from === SCHEMA_VERSION) {
      // still complete it (idempotent): a table added by a fix keeps every environment whole
      for (const stmt of environmentDdl(env.schema)) await tx.exec(stmt)
      // P0-N core data model: system tables and their views are completed (and the views refreshed) at every start
      await provisionSystemTables(tx, env.schema, env.id)
      return { from, to: from }
    }
    // the system views read metadata tables a step may change: dropped first, created again by provisionSystemTables
    await dropSystemViews(tx, env.schema)
    for (const stmt of environmentDdl(env.schema)) await tx.exec(stmt)
    for (const step of ENVIRONMENT_STEPS) if (step.to > from && step.to <= SCHEMA_VERSION) await step.run(tx, env.schema)
    await provisionSystemTables(tx, env.schema, env.id)
    await tx.exec(`UPDATE ${A('environments')} SET schema_version = $1 WHERE id = $2`, [SCHEMA_VERSION, env.id])
    return { from, to: SCHEMA_VERSION }
  })
}

/** prefix of ab.environments.last_error when a boot migration failed (the next successful one clears it) */
export const MIGRATION_FAILED = 'Migration failed:'

/**
 * 4 -> 5 inside the install transaction: today's administrators become install administrators, and everybody keeps
 * entering the environments they had roles in (every user: Default, the only environment of a version 4 install).
 */
async function upgradeInstallTo5(tx: SqlDb): Promise<string[]> {
  const D = (t: string): string => `${q(environmentSchema(DEFAULT_ENVIRONMENT_ID))}.${q(t)}`
  const admins = await tx.query<Record<string, unknown>>(
    `UPDATE ${A('users')} SET is_install_admin = true WHERE id IN (
       SELECT ur.user_id FROM ${D('ab_user_roles')} ur JOIN ${D('ab_roles')} r ON r.id = ur.role_id WHERE r.is_admin) RETURNING id`,
  )
  const now = new Date()
  const granted = await tx.query<Record<string, unknown>>(
    `INSERT INTO ${A('environment_access')} (environment_id, user_id, is_env_admin, granted_on, granted_by)
     SELECT $1, u.id, EXISTS (SELECT 1 FROM ${D('ab_user_roles')} ur JOIN ${D('ab_roles')} r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.is_admin), $2, NULL
     FROM ${A('users')} u ON CONFLICT DO NOTHING RETURNING user_id`,
    [DEFAULT_ENVIRONMENT_ID, now],
  )
  // other registered environments (none in a normal version 4 install): whoever holds a role there may enter
  for (const r of await tx.query<Record<string, unknown>>(`SELECT id, schema_name FROM ${A('environments')} WHERE id <> $1`, [DEFAULT_ENVIRONMENT_ID])) {
    const S = (t: string): string => `${q(String(r.schema_name))}.${q(t)}`
    const exists = await tx.query<Record<string, unknown>>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`${q(String(r.schema_name))}.ab_user_roles`])
    if (!exists[0]?.ok) continue
    await tx.exec(
      `INSERT INTO ${A('environment_access')} (environment_id, user_id, is_env_admin, granted_on)
       SELECT $1, ur.user_id, bool_or(ro.is_admin), $2 FROM ${S('ab_user_roles')} ur JOIN ${S('ab_roles')} ro ON ro.id = ur.role_id GROUP BY ur.user_id
       ON CONFLICT DO NOTHING`,
      [String(r.id), now],
    )
  }
  await tx.exec(`UPDATE ${A('environments')} SET schema_version = 4 WHERE schema_version = 0 AND state = 'ready'`)
  return [
    `version 5: ${admins.length} administrator(s) became install administrators; ${granted.length} user(s) keep access to Default`,
  ]
}

/** a row of ab.environments */
export function toEnvironment(r: Record<string, unknown>): EnvironmentRecord {
  const type = r.type === 'sandbox' || r.type === 'developer' ? r.type : 'production'
  const state = r.state === 'creating' || r.state === 'deleting' || r.state === 'failed' ? r.state : 'ready'
  const out: EnvironmentRecord = {
    id: str(r.id), name: str(r.name), schema: str(r.schema_name), type, builtIn: bool(r.built_in), createdOn: toIso(r.created_on),
    state, schemaVersion: Number(r.schema_version) || 0, locked: bool(r.locked),
  }
  const d = optStr(r.description)
  if (d) out.description = d
  const by = optStr(r.created_by)
  if (by) out.createdBy = by
  const err = optStr(r.last_error)
  if (err) out.lastError = err
  return out
}

/* ------------------------------------------------------------------ helpers */

type Row = Record<string, unknown>

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const optStr = (v: unknown): string | undefined => (v === null || v === undefined || v === '' ? undefined : String(v))
const bool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 't' || v === 'true'
const SCOPE_VALUES: AccessScope[] = ['own', 'team', 'manager', 'managerTree', 'department', 'departmentTree', 'all']
const scope = (v: unknown): AccessScope => (SCOPE_VALUES.includes(v as AccessScope) ? (v as AccessScope) : 'none')
/** a jsonb parameter: always JSON text (pg would send a JS array as a PostgreSQL array) */
const json = (v: unknown): string => JSON.stringify(v ?? null)
/** a jsonb column value (pg parses it already; text from an older driver path is parsed here) */
function doc<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback
  if (typeof v === 'string') return parseJson<T>(v, fallback)
  return v as T
}
/** $1, $2, ... starting after `offset` */
const ph = (n: number, offset = 0): string => Array.from({ length: n }, (_, i) => `$${i + offset + 1}`).join(', ')

export interface MetaStoreOptions {
  /** the environment a call works in (default: currentEnvironment() of env-context.ts) */
  environment?: () => EnvironmentRef
}

export function createMetaStore(db: SqlDb, secrets: SecretBox, opts: MetaStoreOptions = {}): MetaStore {
  const envOf = opts.environment ?? currentEnvironment
  /** qualified table of the current environment */
  const E = (t: string): string => `${q(envOf().schema)}.${q(t)}`

  /* ---------------------------------------------------------------- users */
  async function userRoles(ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>()
    if (!ids.length) return out
    const rows = await db.query<Row>(`SELECT user_id, role_id FROM ${E('ab_user_roles')} WHERE user_id IN (${ph(ids.length)}) ORDER BY role_id`, ids)
    for (const r of rows) {
      const list = out.get(str(r.user_id)) ?? []
      list.push(str(r.role_id))
      out.set(str(r.user_id), list)
    }
    return out
  }
  function toUser(r: Row, roles: Map<string, string[]>): UserRecord {
    const id = str(r.id)
    const lastLogin = r.last_login ? toIso(r.last_login) : undefined
    const hash = r.password_hash === null || r.password_hash === undefined ? null : str(r.password_hash)
    return {
      id,
      name: str(r.name),
      email: str(r.email),
      roleIds: roles.get(id) ?? [],
      status: r.status === 'disabled' ? 'disabled' : 'active',
      hasPassword: !!hash,
      ...(bool(r.must_change_password) ? { mustChangePassword: true } : {}),
      ...(lastLogin ? { lastLogin } : {}),
      ...(bool(r.is_install_admin) ? { isInstallAdmin: true } : {}),
      ...(optStr(r.last_environment_id) ? { lastEnvironmentId: str(r.last_environment_id) } : {}),
      ...(optStr(r.department_id) ? { departmentId: str(r.department_id) } : {}),
      ...(optStr(r.manager_id) ? { managerId: str(r.manager_id) } : {}),
      ...(optStr(r.job_title) ? { jobTitle: str(r.job_title) } : {}),
      ...(optStr(r.phone) ? { phone: str(r.phone) } : {}),
      ...(optStr(r.employee_code) ? { employeeCode: str(r.employee_code) } : {}),
      ...(r.kind === 'service' ? { kind: 'service' as const } : {}),
      ...(r.password_changed_on ? { passwordChangedOn: toIso(r.password_changed_on) } : {}),
      passwordHash: hash,
    }
  }
  async function usersWhere(where: string, params: unknown[]): Promise<UserRecord[]> {
    const rows = await db.query<Row>(`SELECT id, name, email, password_hash, status, must_change_password, created_on, last_login, is_install_admin, last_environment_id, department_id, manager_id, job_title, phone, employee_code, kind, password_changed_on FROM ${A('users')} ${where}`, params)
    const roles = await userRoles(rows.map((r) => str(r.id)))
    return rows.map((r) => toUser(r, roles))
  }
  /**
   * roles of a user in the current environment. Holding a role there means being allowed in: an access row is added
   * (never removed here; revoking access is environments.ts). The access row's is_env_admin follows the roles.
   */
  async function setUserRoles(tx: SqlDb, userId: string, roleIds: string[]): Promise<void> {
    await tx.exec(`DELETE FROM ${E('ab_user_roles')} WHERE user_id = $1`, [userId])
    for (const rid of [...new Set(roleIds)]) await tx.exec(`INSERT INTO ${E('ab_user_roles')} (user_id, role_id) VALUES ($1, $2)`, [userId, rid])
    if (roleIds.length) {
      await tx.exec(
        `INSERT INTO ${A('environment_access')} (environment_id, user_id, is_env_admin, granted_on) VALUES ($1, $2, false, $3) ON CONFLICT DO NOTHING`,
        [envOf().id, userId, new Date()],
      )
    }
    await syncEnvAdmins(tx)
  }
  /** ab.environment_access.is_env_admin = holds an administrator role in the current environment (one statement) */
  async function syncEnvAdmins(tx: SqlDb): Promise<void> {
    await tx.exec(
      `UPDATE ${A('environment_access')} a SET is_env_admin = EXISTS (
         SELECT 1 FROM ${E('ab_user_roles')} ur JOIN ${E('ab_roles')} r ON r.id = ur.role_id WHERE ur.user_id = a.user_id AND r.is_admin)
       WHERE a.environment_id = $1`,
      [envOf().id],
    )
  }
  async function environmentSchemas(d: SqlDb): Promise<string[]> {
    return (await d.query<Row>(`SELECT schema_name FROM ${A('environments')} ORDER BY id`)).map((r) => str(r.schema_name))
  }

  /* ---------------------------------------------------------------- roles */
  async function rolesWhere(where: string, params: unknown[]): Promise<StoredRole[]> {
    const rows = await db.query<Row>(`SELECT id, name, description, is_admin, is_maker, apps FROM ${E('ab_roles')} ${where} ORDER BY lower(name) COLLATE "C", id`, params)
    if (!rows.length) return []
    const ids = rows.map((r) => str(r.id))
    const privs = await db.query<Row>(
      `SELECT role_id, table_id, can_create, read_scope, update_scope, delete_scope, columns, row_filter, share_scope FROM ${E('ab_role_tables')} WHERE role_id IN (${ph(ids.length)}) ORDER BY table_id`,
      ids,
    )
    const byRole = new Map<string, TablePrivilege[]>()
    for (const p of privs) {
      const list = byRole.get(str(p.role_id)) ?? []
      const priv: TablePrivilege = {
        table: str(p.table_id),
        create: bool(p.can_create),
        read: scope(p.read_scope),
        update: scope(p.update_scope),
        delete: scope(p.delete_scope),
      }
      const columns = doc<Record<string, ColumnAccess> | null>(p.columns, null)
      if (columns && typeof columns === 'object' && !Array.isArray(columns) && Object.keys(columns).length) priv.columns = columns
      const rowFilter = doc<RowCondition[] | null>(p.row_filter, null)
      if (Array.isArray(rowFilter) && rowFilter.length) priv.rowFilter = rowFilter
      if (scope(p.share_scope) !== 'none') priv.share = scope(p.share_scope)
      list.push(priv)
      byRole.set(str(p.role_id), list)
    }
    return rows.map((r) => {
      const apps = doc<string[] | 'all'>(r.apps, 'all')
      const role: StoredRole = {
        id: str(r.id),
        name: str(r.name),
        privileges: byRole.get(str(r.id)) ?? [],
        apps: apps === 'all' || Array.isArray(apps) ? apps : 'all',
      }
      const description = optStr(r.description)
      if (description) role.description = description
      if (bool(r.is_admin)) role.isAdmin = true
      if (bool(r.is_maker)) role.isMaker = true
      return role
    })
  }

  /* ---------------------------------------------------------------- tables */
  function toTable(r: Row): TableDef {
    const def = doc<TableDef>(r.def, {} as TableDef)
    def.id = str(r.id)
    def.name = str(r.name)
    if (r.connection_id) def.connectionId = str(r.connection_id)
    if (r.source) def.source = str(r.source)
    if (!Array.isArray(def.columns)) def.columns = []
    return def
  }

  /* ---------------------------------------------------------------- connections */
  function toConnection(r: Row): ConnectionRecord {
    const sealed = r.secret_sealed === null || r.secret_sealed === undefined || r.secret_sealed === '' ? null : str(r.secret_sealed)
    let secret: string | undefined
    if (sealed) {
      try {
        secret = secrets.decrypt(sealed)
      } catch {
        secret = undefined // key changed: the connection needs its secret again
      }
    }
    const status = r.status === 'connected' || r.status === 'error' ? r.status : 'not-configured'
    const c: ConnectionRecord = {
      id: str(r.id),
      name: str(r.name),
      connector: str(r.connector) as ConnectionRef['connector'],
      status,
      settings: doc<Record<string, string>>(r.settings, {}),
      hasSecret: !!sealed,
      isDefault: bool(r.is_default),
      scope: r.scope === 'device' ? 'device' : 'server',
    }
    const lastError = optStr(r.last_error)
    if (lastError) c.lastError = lastError
    if (secret !== undefined) c.secret = secret
    return c
  }

  /* ---------------------------------------------------------------- files */
  function toFile(r: Row): DataFileDef & { storageKey: string; originalName: string } {
    const kind = r.kind === 'xlsx' || r.kind === 'json' ? r.kind : 'csv'
    return {
      id: str(r.id),
      connectionId: str(r.connection_id),
      fileName: str(r.file_name),
      kind,
      sizeBytes: Number(r.size_bytes) || 0,
      checksum: str(r.checksum),
      importedOn: toIso(r.imported_on),
      tableIds: doc<string[]>(r.table_ids, []),
      modifiedSinceImport: bool(r.modified_since_import),
      storageKey: str(r.storage_key),
      originalName: str(r.original_name),
    }
  }

  function toAttachment(r: Row): AttachmentRecord {
    return {
      id: str(r.id),
      tableId: str(r.table_id),
      column: str(r.col),
      rowId: str(r.row_id),
      fileName: str(r.file_name),
      mime: str(r.mime),
      sizeBytes: Number(r.size_bytes) || 0,
      sha256: str(r.sha256),
      storageKey: str(r.storage_key),
      createdBy: str(r.created_by),
      createdOn: toIso(r.created_on),
    }
  }


  async function storedVersion(): Promise<number> {
    const exists = await db.query<Row>(`SELECT to_regclass('ab.settings') IS NOT NULL AS ok`)
    if (!bool(exists[0]?.ok)) return 0
    const rows = await db.query<Row>(`SELECT v FROM ${A('settings')} WHERE k = 'schemaVersion'`)
    return rows.length ? Number(rows[0].v) || 0 : 0
  }

  const store: MetaStore = {
    db,
    org: createOrgStore(db, () => envOf().schema),
    relationships: createRelationshipStore(db, () => envOf().schema),

    tableName(name) {
      return INSTALL_TABLES.includes(name) ? A(name) : E(name)
    },

    async migrate(): Promise<MigrationSummary> {
      // downgrade guard first: a newer server's schema is never touched (not even CREATE ... IF NOT EXISTS)
      const current = await storedVersion()
      if (current > SCHEMA_VERSION) throw new SchemaTooNewError(current, SCHEMA_VERSION)
      if (current > 0 && current < 4) throw new UnsuitableDatabaseError(`This database holds an Appbuilder schema of version ${current}, which is not supported on PostgreSQL. Use an empty database.`)
      const enc = await db.query<Row>('SHOW server_encoding')
      if (str(enc[0]?.server_encoding).toUpperCase() !== 'UTF8') {
        throw new UnsuitableDatabaseError(`The database uses the ${str(enc[0]?.server_encoding)} encoding; Appbuilder needs UTF8. Create the database with ENCODING 'UTF8'.`)
      }
      const steps: string[] = []
      // phase 1: schema ab, in one transaction (one migration at a time per database: two servers starting together)
      await db.tx(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('appbuilder.migrate'))")
        // P0-N: the system views read tables of schema ab; an upgrade step may change those (the views come back with
        // each environment's migration below)
        if (current > 0 && current < SCHEMA_VERSION) await dropSystemViews(tx)
        for (const stmt of INSTALL_DDL) await tx.exec(stmt)
        const hasDefault = (await tx.query<Row>(`SELECT 1 FROM ${A('environments')} WHERE id = $1`, [DEFAULT_ENVIRONMENT_ID])).length > 0
        if (!hasDefault) await migrateEnvironment(tx, { id: DEFAULT_ENVIRONMENT_ID, name: 'Default', type: 'production', builtIn: true })
        if (current === 4) steps.push(...(await upgradeInstallTo5(tx)))
        // 6: organisation (F) and notifications (H) in schema ab; their tables come from INSTALL_DDL above
        if (current >= 4 && current < 6) steps.push('version 6: organisation (departments, teams, team members) and in-app notifications; environments get record sharing and the event and job kernel')
        // 7 (package I, independent of the other version 7 steps): identity tables in schema ab
        if (current < 7) { const d = await upgradeInstallTo7Identity(tx); if (current >= 4) steps.push(d) }
        // 7 (package J, independent): the backup catalogue in schema ab
        if (current < 7) { const d = await upgradeInstallTo7Backup(tx); if (current >= 4) steps.push(d) }
        // an operation that was running when the server stopped cannot be resumed: the environment is marked failed
        const stuck = await tx.query<Row>(`UPDATE ${A('environments')} SET state = 'failed', last_error = CASE state WHEN 'creating' THEN 'Creating it was interrupted (the server stopped). Delete it and create it again.' ELSE 'Deleting it was interrupted (the server stopped). Delete it again.' END WHERE state IN ('creating', 'deleting') RETURNING id`)
        for (const r of stuck) steps.push(`environment ${str(r.id)}: interrupted operation, marked failed`)
        if (current < SCHEMA_VERSION) {
          await tx.exec(`INSERT INTO ${A('settings')} (k, v) VALUES ('schemaVersion', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [String(SCHEMA_VERSION)])
        }
      })
      if (current === 0) steps.push(`created schema ab and environment schema ${environmentSchema(DEFAULT_ENVIRONMENT_ID)} (schema version ${SCHEMA_VERSION})`)
      // phase 2: every environment schema in its own transaction; one that fails is marked failed, the others go on
      const environments: EnvironmentMigration[] = []
      const regs = await db.query<Row>(`SELECT id, schema_name, state, schema_version, last_error FROM ${A('environments')} ORDER BY built_in DESC, id`)
      for (const r of regs) {
        const id = str(r.id)
        const state = str(r.state)
        const version = Number(r.schema_version) || 0
        // a failed creation never finished: there is nothing to migrate (it can only be deleted)
        if (state === 'failed' && version === 0) continue
        try {
          const res = await migrateEnvironmentSchema(db, { id, schema: str(r.schema_name) })
          environments.push({ id, from: res.from, to: res.to, ok: true })
          if (res.from !== res.to) steps.push(`environment ${id}: schema version ${res.from} -> ${res.to}`)
          if (state === 'failed' && str(r.last_error).startsWith(MIGRATION_FAILED)) {
            await db.exec(`UPDATE ${A('environments')} SET state = 'ready', last_error = NULL WHERE id = $1`, [id])
          }
        } catch (e) {
          const why = e instanceof SchemaTooNewError
            ? `${MIGRATION_FAILED} it was upgraded by a newer Appbuilder (schema version ${e.database}, this server knows ${e.server}); it is not touched.`
            : `${MIGRATION_FAILED} ${e instanceof Error ? e.message : String(e)}`.slice(0, 1000)
          environments.push({ id, from: version, to: version, ok: false, error: why })
          steps.push(`environment ${id}: migration failed`)
          await db.exec(`UPDATE ${A('environments')} SET state = 'failed', last_error = $2 WHERE id = $1`, [id, why]).catch(() => {})
        }
      }
      return { from: current, to: SCHEMA_VERSION, steps, environments }
    },

    environments: {
      async list() {
        return (await db.query<Row>(`SELECT * FROM ${A('environments')} ORDER BY built_in DESC, lower(name) COLLATE "C", id`)).map(toEnvironment)
      },
      async get(id) {
        const rows = await db.query<Row>(`SELECT * FROM ${A('environments')} WHERE id = $1`, [id])
        return rows.length ? toEnvironment(rows[0]) : null
      },
    },

    users: {
      list: () => usersWhere('ORDER BY lower(name) COLLATE "C", id', []),
      async get(id) {
        return (await usersWhere('WHERE id = $1', [id]))[0] ?? null
      },
      async byEmail(email) {
        return (await usersWhere('WHERE email = $1', [email.trim().toLowerCase()]))[0] ?? null
      },
      async count() {
        const rows = await db.query<Row>(`SELECT count(*)::int AS n FROM ${A('users')}`)
        return Number(rows[0]?.n) || 0
      },
      async insert(u) {
        await db.tx(async (tx) => {
          await tx.exec(
            `INSERT INTO ${A('users')} (id, name, email, password_hash, status, must_change_password, created_on, last_login, is_install_admin, kind, password_changed_on) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [u.id, u.name, u.email.trim().toLowerCase(), u.passwordHash ?? null, u.status ?? 'active', !!u.mustChangePassword, new Date(), toDate(u.lastLogin), !!u.isInstallAdmin, u.kind === 'service' ? 'service' : 'person', u.passwordHash ? new Date() : null],
          )
          await setUserRoles(tx, u.id, u.roleIds ?? [])
        })
      },
      async update(id, patch) {
        await db.tx(async (tx) => {
          const sets: string[] = []
          const params: unknown[] = []
          const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`) }
          if (patch.name !== undefined) set('name', patch.name)
          if (patch.email !== undefined) set('email', patch.email.trim().toLowerCase())
          if (patch.passwordHash !== undefined) { set('password_hash', patch.passwordHash); set('password_changed_on', patch.passwordHash ? new Date() : null) }
          if (patch.status !== undefined) set('status', patch.status)
          if (patch.mustChangePassword !== undefined) set('must_change_password', !!patch.mustChangePassword)
          if (patch.lastLogin !== undefined) set('last_login', toDate(patch.lastLogin))
          if (patch.isInstallAdmin !== undefined) set('is_install_admin', !!patch.isInstallAdmin)
          if (patch.lastEnvironmentId !== undefined) set('last_environment_id', patch.lastEnvironmentId || null)
          if (sets.length) await tx.exec(`UPDATE ${A('users')} SET ${sets.join(', ')} WHERE id = $${params.length + 1}`, [...params, id])
          if (patch.roleIds !== undefined) await setUserRoles(tx, id, patch.roleIds)
        })
      },
      async remove(id) {
        await db.tx(async (tx) => {
          // users are install-wide: their role assignments go in every environment
          for (const schema of await environmentSchemas(tx)) await tx.exec(`DELETE FROM ${q(schema)}.${q('ab_user_roles')} WHERE user_id = $1`, [id])
          await tx.exec(`DELETE FROM ${A('environment_access')} WHERE user_id = $1`, [id])
          await tx.exec(`DELETE FROM ${A('sessions')} WHERE user_id = $1`, [id])
          await tx.exec(`DELETE FROM ${A('users')} WHERE id = $1`, [id])
        })
      },
    },

    sessions: {
      async insert(s) {
        const now = new Date()
        await db.exec(
          `INSERT INTO ${A('sessions')} (id_hash, user_id, created_on, expires_on, last_seen, user_agent, ip, public_id, absolute_expires_on, auth_on, mfa, restricted)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [s.idHash, s.userId, now, s.expiresOn, now, (s.userAgent ?? '').slice(0, 255), s.ip ?? null, s.publicId ?? null, s.absoluteExpiresOn ?? null, now, !!s.mfa, s.restricted ?? null],
        )
      },
      async get(idHash) {
        const rows = await db.query<Row>(`SELECT user_id, expires_on, created_on, last_seen, absolute_expires_on, auth_on, public_id, restricted, mfa, ip, user_agent FROM ${A('sessions')} WHERE id_hash = $1`, [idHash])
        if (!rows.length) return null
        const r = rows[0]
        const d = (v: unknown) => (v === null || v === undefined ? null : new Date(toIso(v)))
        return {
          userId: str(r.user_id), expiresOn: new Date(toIso(r.expires_on)), createdOn: d(r.created_on) ?? undefined, lastSeen: d(r.last_seen) ?? undefined,
          absoluteExpiresOn: d(r.absolute_expires_on), authOn: d(r.auth_on), publicId: r.public_id === null ? null : str(r.public_id),
          restricted: r.restricted === null ? null : str(r.restricted), mfa: bool(r.mfa), ip: r.ip === null ? null : str(r.ip), userAgent: r.user_agent === null ? null : str(r.user_agent),
        }
      },
      async touch(idHash, expiresOn) {
        await db.exec(`UPDATE ${A('sessions')} SET expires_on = $1, last_seen = $2 WHERE id_hash = $3`, [expiresOn, new Date(), idHash])
      },
      async remove(idHash) {
        await db.exec(`DELETE FROM ${A('sessions')} WHERE id_hash = $1`, [idHash])
      },
      async removeForUser(userId) {
        await db.exec(`DELETE FROM ${A('sessions')} WHERE user_id = $1`, [userId])
      },
      async purgeExpired() {
        const r = await db.exec(`DELETE FROM ${A('sessions')} WHERE expires_on < $1`, [new Date()])
        return r.affectedRows
      },
    },

    roles: {
      list: () => rolesWhere('', []),
      async get(id) {
        return (await rolesWhere('WHERE id = $1', [id]))[0] ?? null
      },
      async upsert(role) {
        const r = role as StoredRole
        await db.tx(async (tx) => {
          await tx.exec(
            `INSERT INTO ${E('ab_roles')} (id, name, description, is_admin, is_maker, apps) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
             ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, is_admin = EXCLUDED.is_admin,
             is_maker = EXCLUDED.is_maker, apps = EXCLUDED.apps`,
            [r.id, r.name, r.description ?? null, !!r.isAdmin, !!r.isMaker, json(r.apps ?? 'all')],
          )
          await tx.exec(`DELETE FROM ${E('ab_role_tables')} WHERE role_id = $1`, [r.id])
          const seen = new Set<string>()
          for (const p of r.privileges ?? []) {
            if (seen.has(p.table)) continue
            seen.add(p.table)
            await tx.exec(
              `INSERT INTO ${E('ab_role_tables')} (role_id, table_id, can_create, read_scope, update_scope, delete_scope, columns, row_filter, share_scope)
               VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)`,
              [
                r.id, p.table, !!p.create, scope(p.read), scope(p.update), scope(p.delete),
                p.columns && Object.keys(p.columns).length ? json(p.columns) : null,
                p.rowFilter && p.rowFilter.length ? json(p.rowFilter) : null,
                p.share && p.share !== 'none' ? scope(p.share) : null,
              ],
            )
          }
          await syncEnvAdmins(tx)
        })
      },
      async remove(id) {
        await db.tx(async (tx) => {
          await tx.exec(`DELETE FROM ${E('ab_role_tables')} WHERE role_id = $1`, [id])
          await tx.exec(`DELETE FROM ${E('ab_user_roles')} WHERE role_id = $1`, [id])
          await tx.exec(`DELETE FROM ${E('ab_roles')} WHERE id = $1`, [id])
          await syncEnvAdmins(tx)
        })
      },
    },

    tables: {
      async list() {
        return (await db.query<Row>(`SELECT id, name, connection_id, source, def FROM ${E('ab_tables')} ORDER BY lower(name) COLLATE "C", id`)).map(toTable)
      },
      async get(idOrName) {
        const rows = await db.query<Row>(
          `SELECT id, name, connection_id, source, def FROM ${E('ab_tables')} WHERE id = $1 OR lower(name) = lower($1) ORDER BY (id = $1) DESC LIMIT 1`,
          [idOrName],
        )
        return rows.length ? toTable(rows[0]) : null
      },
      async upsert(t) {
        await db.exec(
          `INSERT INTO ${E('ab_tables')} (id, name, connection_id, source, def, created_on, modified_on) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, connection_id = EXCLUDED.connection_id, source = EXCLUDED.source,
           def = EXCLUDED.def, modified_on = EXCLUDED.modified_on`,
          [t.id, t.name, t.connectionId ?? null, t.source ?? null, JSON.stringify(t), toDate(t.createdOn) ?? new Date(), toDate(t.modifiedOn) ?? new Date()],
        )
      },
      async remove(id) {
        await db.tx(async (tx) => {
          await tx.exec(`DELETE FROM ${E('ab_role_tables')} WHERE table_id = $1`, [id])
          await tx.exec(`DELETE FROM ${E('ab_tables')} WHERE id = $1`, [id])
        })
      },
    },

    apps: {
      async list() {
        const rows = await db.query<Row>(`SELECT id, name, description, width, height, created_on, modified_on, modified_by FROM ${E('ab_apps')} ORDER BY lower(name) COLLATE "C", id`)
        return rows.map(toAppMeta)
      },
      async get(id) {
        const rows = await db.query<Row>(`SELECT id, name, description, width, height, created_on, modified_on, modified_by, definition FROM ${E('ab_apps')} WHERE id = $1`, [id])
        if (!rows.length) return null
        return { meta: toAppMeta(rows[0]), definition: doc<AppDef>(rows[0].definition, {} as AppDef) }
      },
      async upsert(meta, definition) {
        await db.exec(
          `INSERT INTO ${E('ab_apps')} (id, name, description, width, height, definition, created_on, modified_on, modified_by)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, width = EXCLUDED.width,
           height = EXCLUDED.height, definition = EXCLUDED.definition, modified_on = EXCLUDED.modified_on, modified_by = EXCLUDED.modified_by`,
          [
            meta.id, meta.name, meta.description ?? null, Math.round(meta.width) || 1920, Math.round(meta.height) || 1080,
            JSON.stringify(definition), toDate(meta.createdOn) ?? new Date(), toDate(meta.modifiedOn) ?? new Date(), meta.modifiedBy || null,
          ],
        )
      },
      async remove(id) {
        await db.exec(`DELETE FROM ${E('ab_apps')} WHERE id = $1`, [id])
      },
    },

    connections: {
      async list() {
        return (await db.query<Row>(`SELECT * FROM ${E('ab_connections')} ORDER BY lower(name) COLLATE "C", id`)).map(toConnection)
      },
      async get(id) {
        const rows = await db.query<Row>(`SELECT * FROM ${E('ab_connections')} WHERE id = $1`, [id])
        return rows.length ? toConnection(rows[0]) : null
      },
      async upsert(c) {
        // secret: undefined = keep the stored one, '' = clear, text = seal and store
        await db.tx(async (tx) => {
          const existing = await tx.query<Row>(`SELECT secret_sealed, created_on FROM ${E('ab_connections')} WHERE id = $1`, [c.id])
          let sealed: string | null = existing.length ? (existing[0].secret_sealed as string | null) ?? null : null
          if (c.secret !== undefined) sealed = c.secret === '' ? null : secrets.encrypt(c.secret)
          if (c.isDefault) await tx.exec(`UPDATE ${E('ab_connections')} SET is_default = false WHERE id <> $1`, [c.id])
          const now = new Date()
          await tx.exec(
            `INSERT INTO ${E('ab_connections')} (id, name, connector, settings, secret_sealed, status, last_error, is_default, scope, created_on, modified_on)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, connector = EXCLUDED.connector, settings = EXCLUDED.settings,
             secret_sealed = EXCLUDED.secret_sealed, status = EXCLUDED.status, last_error = EXCLUDED.last_error,
             is_default = EXCLUDED.is_default, scope = EXCLUDED.scope, modified_on = EXCLUDED.modified_on`,
            [
              c.id, c.name, c.connector, json(c.settings ?? {}), sealed, c.status ?? 'not-configured', c.lastError ?? null,
              !!c.isDefault, c.scope === 'device' ? 'device' : 'server', existing.length ? existing[0].created_on : now, now,
            ],
          )
        })
      },
      async remove(id) {
        await db.exec(`DELETE FROM ${E('ab_connections')} WHERE id = $1`, [id])
      },
    },

    solutions: {
      async list() {
        const rows = await db.query<Row>(`SELECT * FROM ${E('ab_solutions')} ORDER BY lower(display_name) COLLATE "C", id`)
        return rows.map((r): SolutionDef => {
          const s: SolutionDef = {
            id: str(r.id),
            name: str(r.name),
            displayName: str(r.display_name),
            publisher: str(r.publisher),
            version: str(r.version),
            components: doc<SolutionDef['components']>(r.components, []),
            createdOn: toIso(r.created_on),
            modifiedOn: toIso(r.modified_on),
          }
          const d = optStr(r.description)
          if (d) s.description = d
          return s
        })
      },
      async upsert(s) {
        await db.exec(
          `INSERT INTO ${E('ab_solutions')} (id, name, display_name, publisher, version, description, components, created_on, modified_on)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, display_name = EXCLUDED.display_name, publisher = EXCLUDED.publisher,
           version = EXCLUDED.version, description = EXCLUDED.description, components = EXCLUDED.components, modified_on = EXCLUDED.modified_on`,
          [
            s.id, s.name, s.displayName, s.publisher ?? '', s.version ?? '', s.description ?? null, json(s.components ?? []),
            toDate(s.createdOn) ?? new Date(), toDate(s.modifiedOn) ?? new Date(),
          ],
        )
      },
      async remove(id) {
        await db.exec(`DELETE FROM ${E('ab_solutions')} WHERE id = $1`, [id])
      },
    },

    files: {
      async list() {
        return (await db.query<Row>(`SELECT * FROM ${E('ab_data_files')} ORDER BY lower(file_name) COLLATE "C", id`)).map(toFile)
      },
      async get(id) {
        const rows = await db.query<Row>(`SELECT * FROM ${E('ab_data_files')} WHERE id = $1`, [id])
        return rows.length ? toFile(rows[0]) : null
      },
      async upsert(f) {
        await db.exec(
          `INSERT INTO ${E('ab_data_files')} (id, connection_id, file_name, original_name, kind, size_bytes, checksum, storage_key, imported_on, table_ids, modified_since_import)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
           ON CONFLICT (id) DO UPDATE SET connection_id = EXCLUDED.connection_id, file_name = EXCLUDED.file_name, original_name = EXCLUDED.original_name,
           kind = EXCLUDED.kind, size_bytes = EXCLUDED.size_bytes, checksum = EXCLUDED.checksum, storage_key = EXCLUDED.storage_key,
           imported_on = EXCLUDED.imported_on, table_ids = EXCLUDED.table_ids, modified_since_import = EXCLUDED.modified_since_import`,
          [
            f.id, f.connectionId, f.fileName, f.originalName ?? f.fileName, f.kind, f.sizeBytes ?? 0, f.checksum ?? '', f.storageKey ?? '',
            toDate(f.importedOn) ?? new Date(), json(f.tableIds ?? []), !!f.modifiedSinceImport,
          ],
        )
      },
      async remove(id) {
        await db.exec(`DELETE FROM ${E('ab_data_files')} WHERE id = $1`, [id])
      },
      async markModified(id) {
        await db.exec(`UPDATE ${E('ab_data_files')} SET modified_since_import = true WHERE id = $1 AND NOT modified_since_import`, [id])
      },
    },

    attachments: {
      async get(id) {
        const rows = await db.query<Row>(`SELECT * FROM ${E('ab_attachments')} WHERE id = $1`, [id])
        return rows.length ? toAttachment(rows[0]) : null
      },
      async many(ids) {
        const list = [...new Set(ids.filter((x) => typeof x === 'string' && x))].slice(0, 5000)
        if (!list.length) return []
        return (await db.query<Row>(`SELECT * FROM ${E('ab_attachments')} WHERE id = ANY($1::text[])`, [list])).map(toAttachment)
      },
      async insert(a) {
        await db.exec(
          `INSERT INTO ${E('ab_attachments')} (id, table_id, col, row_id, file_name, mime, size_bytes, sha256, storage_key, created_by, created_on)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [a.id, a.tableId, a.column, a.rowId, a.fileName, a.mime, a.sizeBytes, a.sha256, a.storageKey, a.createdBy || null, toDate(a.createdOn) ?? new Date()],
        )
      },
      async remove(id) {
        await db.exec(`DELETE FROM ${E('ab_attachments')} WHERE id = $1`, [id])
      },
      async forRows(tableId, rowIds) {
        const out: AttachmentRecord[] = []
        for (let i = 0; i < rowIds.length; i += 1000) {
          const chunk = rowIds.slice(i, i + 1000)
          if (!chunk.length) continue
          const rows = await db.query<Row>(`SELECT * FROM ${E('ab_attachments')} WHERE table_id = $1 AND row_id = ANY($2::text[])`, [tableId, chunk])
          out.push(...rows.map(toAttachment))
        }
        return out
      },
      async idsForTable(tableId) {
        return (await db.query<Row>(`SELECT id FROM ${E('ab_attachments')} WHERE table_id = $1 ORDER BY id`, [tableId])).map((r) => str(r.id))
      },
      async idsCreatedBefore(cutoff, limit) {
        const n = Math.max(1, Math.min(100000, Math.floor(limit)))
        return (await db.query<Row>(`SELECT id FROM ${E('ab_attachments')} WHERE created_on < $1 ORDER BY table_id, id LIMIT $2`, [cutoff, n])).map((r) => str(r.id))
      },
    },

    async nextCounter(key) {
      const rows = await db.query<Row>(
        `INSERT INTO ${E('ab_counters')} AS c (k, v) VALUES ($1, 1) ON CONFLICT (k) DO UPDATE SET v = c.v + 1 RETURNING v`,
        [key],
      )
      return Number(rows[0]?.v) || 1
    },

    async raiseCounter(key, value) {
      await db.exec(
        `INSERT INTO ${E('ab_counters')} AS c (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = GREATEST(c.v, EXCLUDED.v)`,
        [key, Math.max(0, Math.floor(value))],
      )
    },

    async audit(entry) {
      let details: string | null = null
      if (entry.details !== undefined) {
        try {
          details = JSON.stringify(entry.details) ?? null
        } catch {
          details = null
        }
        // jsonb cannot hold NUL characters
        if (details) details = details.replace(/(?<!\\)\\u0000/g, '')
        // truncated text is no longer valid JSON: keep it as a JSON string then
        if (details && details.length > 60000) details = JSON.stringify(details.slice(0, 60000))
      }
      await db.exec(
        `INSERT INTO ${E('ab_audit')} (at, user_id, action, table_id, row_id, details) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [new Date(), entry.userId ?? null, entry.action.slice(0, 64), entry.tableId ?? null, entry.rowId ? String(entry.rowId).slice(0, 64) : null, details],
      )
    },

    async auditPage(f) {
      const where: string[] = []
      const params: unknown[] = []
      const add = (sql: (p: string) => string, v: unknown) => { params.push(v); where.push(sql(`$${params.length}`)) }
      if (f.action) {
        if (f.action.endsWith('.')) add((p) => `starts_with(action, ${p})`, f.action)
        else add((p) => `action = ${p}`, f.action)
      }
      if (f.userId) add((p) => `user_id = ${p}`, f.userId)
      const from = toDate(f.from)
      if (from) add((p) => `at >= ${p}`, from)
      const to = toDate(f.to)
      if (to) add((p) => `at < ${p}`, to)
      const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const total = Number((await db.query<Row>(`SELECT count(*)::int AS n FROM ${E('ab_audit')} ${w}`, params))[0]?.n) || 0
      const limit = Math.max(1, Math.min(500, Math.floor(f.limit)))
      const offset = Math.max(0, Math.floor(f.offset))
      const rows = await db.query<Row>(
        `SELECT id, at, user_id, action, table_id, row_id, details FROM ${E('ab_audit')} ${w} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      )
      return {
        total,
        items: rows.map((r) => ({
          id: Number(r.id),
          at: toIso(r.at),
          userId: optStr(r.user_id) ?? null,
          action: str(r.action),
          tableId: optStr(r.table_id) ?? null,
          rowId: optStr(r.row_id) ?? null,
          details: r.details === null || r.details === undefined ? null : doc<unknown>(r.details, null),
        })),
      }
    },

    async auditActions() {
      return (await db.query<Row>(`SELECT action FROM ${E('ab_audit')} GROUP BY action ORDER BY action COLLATE "C"`)).map((r) => str(r.action))
    },

    async info() {
      const rows = await db.query<Row>(`SELECT min(created_on) AS c FROM ${A('users')}`)
      return { createdOn: rows[0]?.c ? toIso(rows[0].c) : null }
    },
  }
  return store
}

function toAppMeta(r: Row): AppMeta {
  const m: AppMeta = {
    id: str(r.id),
    name: str(r.name),
    width: Number(r.width) || 1920,
    height: Number(r.height) || 1080,
    createdOn: toIso(r.created_on),
    modifiedOn: toIso(r.modified_on),
    modifiedBy: str(r.modified_by),
  }
  const d = optStr(r.description)
  if (d) m.description = d
  return m
}
