/**
 * MetaStore over the ab_* system tables (docs/internal/specs/SPEC3.md section 3). Portable SQL: MySQL 5.7+, 8.x, MariaDB 10.4+
 * (no JSON type, no CHECK, VALUES() in ON DUPLICATE KEY, utf8mb4_unicode_ci, DATETIME(3) in UTC, InnoDB).
 */
import type {
  AttachmentRecord, ConnectionRecord, MetaStore, MigrationSummary, SecretBox, SqlDb, UserRecord,
} from './contracts.ts'
import type {
  AccessScope, AppMeta, ColumnAccess, ConnectionRef, DataFileDef, RoleDef, RowCondition, SolutionDef, TableDef, TablePrivilege,
} from '../../src/platform/contracts.ts'
import type { AppDef } from '../../src/contracts.ts'
import { parseJson, toDate, toIso } from './util.ts'

/**
 * 1: initial schema; 2: ab_users.email normalised to trimmed lowercase; 3: ab_users.must_change_password (an administrator
 * set the password, the user must change it at the next sign-in)
 */
export const SCHEMA_VERSION = 3

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

/** MySQL 5.7 has no ADD COLUMN IF NOT EXISTS: look the column up in information_schema first */
async function hasColumn(db: SqlDb, table: string, column: string): Promise<boolean> {
  const rows = await db.query<Record<string, unknown>>(
    'SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
    [table, column],
  )
  return Number(rows[0]?.n) > 0
}

const SYSTEM_COLUMN_LIST = ['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner']

/**
 * v3: provenance of existing tables. A table the audit log records as linked (action table.link) stays unmanaged
 * (Appbuilder never drops it or its columns); if its definition lacks system columns it becomes read-only with
 * missingSystem (before, such a table was writable but every query failed). Every other table (created by Appbuilder,
 * no file origin) is marked managed. A linked table whose audit entry is gone is treated as created by Appbuilder.
 */
export async function markTableProvenance(db: SqlDb): Promise<{ managed: number; linked: number; readOnly: number }> {
  const linked = new Set(
    (await db.query<{ table_id: string }>("SELECT DISTINCT table_id FROM ab_audit WHERE action = 'table.link' AND table_id IS NOT NULL")).map((r) => String(r.table_id)),
  )
  const out = { managed: 0, linked: 0, readOnly: 0 }
  for (const r of await db.query<{ id: string; def: string }>('SELECT id, def FROM ab_tables')) {
    const def = parseJson<TableDef | null>(r.def, null)
    if (!def || typeof def !== 'object' || def.managed !== undefined || def.origin?.kind === 'file') continue
    if (linked.has(String(r.id))) {
      out.linked++
      const names = new Set((def.columns ?? []).map((c) => c.name))
      const missing = SYSTEM_COLUMN_LIST.filter((n) => !names.has(n))
      if (!missing.length) continue
      def.missingSystem = missing
      def.readOnly = true
      out.readOnly++
    } else {
      def.managed = true
      out.managed++
    }
    await db.exec('UPDATE ab_tables SET def = ? WHERE id = ?', [JSON.stringify(def), r.id])
  }
  return out
}

/** v3: ab_users.must_change_password TINYINT NOT NULL DEFAULT 0 (existing users: 0) */
export async function addMustChangePassword(db: SqlDb): Promise<boolean> {
  if (await hasColumn(db, 'ab_users', 'must_change_password')) return false
  await db.exec('ALTER TABLE ab_users ADD COLUMN must_change_password TINYINT NOT NULL DEFAULT 0')
  return true
}

/** RoleDef as stored: the optional maker flag (ab_roles.is_maker) travels with the role. */
export type StoredRole = RoleDef & { isMaker?: boolean }

/**
 * v2: every ab_users.email is stored trimmed and lowercase. A CHECK constraint is not portable (MySQL 5.7 parses and
 * ignores CHECK), so the rule is enforced by the MetaStore write path (users.insert / users.update lowercase) and this
 * migration fixes older rows. ux_ab_users_email (utf8mb4_unicode_ci, case-insensitive) already prevents two rows that
 * differ only in case; a row whose trimmed form collides with another row is left as it is (and logged by the caller).
 */
export async function normaliseUserEmails(db: SqlDb): Promise<{ changed: number; skipped: string[] }> {
  const rows = await db.query<{ id: string; email: string }>('SELECT id, email FROM ab_users')
  let changed = 0
  const skipped: string[] = []
  for (const r of rows) {
    const email = String(r.email)
    const norm = email.trim().toLowerCase()
    if (norm === email) continue
    try {
      await db.exec('UPDATE ab_users SET email = ? WHERE id = ?', [norm, r.id])
      changed++
    } catch (e) {
      if ((e as { code?: string }).code !== 'ER_DUP_ENTRY') throw e
      skipped.push(String(r.id))
    }
  }
  return { changed, skipped }
}

const TAIL = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'

export const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS ab_meta (
    k VARCHAR(64) NOT NULL PRIMARY KEY,
    v TEXT NULL
  ) ${TAIL}`,
  `CREATE TABLE IF NOT EXISTS ab_users (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(191) NOT NULL,
    password_hash VARCHAR(255) NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    must_change_password TINYINT NOT NULL DEFAULT 0,
    created_on DATETIME(3) NOT NULL,
    last_login DATETIME(3) NULL,
    UNIQUE KEY ux_ab_users_email (email)
  ) ${TAIL}`,
  `CREATE TABLE IF NOT EXISTS ab_sessions (
    id_hash CHAR(64) NOT NULL PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    created_on DATETIME(3) NOT NULL,
    expires_on DATETIME(3) NOT NULL,
    last_seen DATETIME(3) NOT NULL,
    user_agent VARCHAR(255) NULL,
    KEY ix_ab_sessions_user (user_id),
    KEY ix_ab_sessions_expires (expires_on)
  ) ${TAIL}`,
  `CREATE TABLE IF NOT EXISTS ab_roles (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    name VARCHAR(191) NOT NULL,
    description TEXT NULL,
    is_admin TINYINT NOT NULL DEFAULT 0,
    is_maker TINYINT NOT NULL DEFAULT 0,
    apps LONGTEXT NULL,
    UNIQUE KEY ux_ab_roles_name (name)
  ) ${TAIL}`,
  `CREATE TABLE IF NOT EXISTS ab_user_roles (
    user_id VARCHAR(64) NOT NULL,
    role_id VARCHAR(64) NOT NULL,
    PRIMARY KEY (user_id, role_id),
    KEY ix_ab_user_roles_role (role_id)
  ) ${TAIL}`,
  `CREATE TABLE IF NOT EXISTS ab_role_tables (
    role_id VARCHAR(64) NOT NULL,
    table_id VARCHAR(64) NOT NULL,
    can_create TINYINT NOT NULL DEFAULT 0,
    read_scope VARCHAR(8) NOT NULL DEFAULT 'none',
    update_scope VARCHAR(8) NOT NULL DEFAULT 'none',
    delete_scope VARCHAR(8) NOT NULL DEFAULT 'none',
    columns LONGTEXT NULL,
    row_filter LONGTEXT NULL,
    PRIMARY KEY (role_id, table_id),
    KEY ix_ab_role_tables_table (table_id)
  ) ${TAIL}`,
  `CREATE TABLE IF NOT EXISTS ab_tables (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    name VARCHAR(191) NOT NULL,
    connection_id VARCHAR(64) NULL,
    source VARCHAR(255) NULL,
    def LONGTEXT NOT NULL,
    created_on DATETIME(3) NOT NULL,
    modified_on DATETIME(3) NOT NULL,
    UNIQUE KEY ux_ab_tables_name (name)
  ) ${TAIL}`,
  `CREATE TABLE IF NOT EXISTS ab_apps (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    name VARCHAR(191) NOT NULL,
    description TEXT NULL,
    width INT NOT NULL DEFAULT 1920,
    height INT NOT NULL DEFAULT 1080,
    definition LONGTEXT NOT NULL,
    created_on DATETIME(3) NOT NULL,
    modified_on DATETIME(3) NOT NULL,
    modified_by VARCHAR(64) NULL,
    UNIQUE KEY ux_ab_apps_name (name)
  ) ${TAIL}`,
  `CREATE TABLE IF NOT EXISTS ab_connections (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    name VARCHAR(191) NOT NULL,
    connector VARCHAR(32) NOT NULL,
    settings LONGTEXT NULL,
    secret_sealed TEXT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'not-configured',
    last_error TEXT NULL,
    is_default TINYINT NOT NULL DEFAULT 0,
    scope VARCHAR(8) NOT NULL DEFAULT 'server',
    created_on DATETIME(3) NOT NULL,
    modified_on DATETIME(3) NOT NULL,
    UNIQUE KEY ux_ab_connections_name (name)
  ) ${TAIL}`,
  `CREATE TABLE IF NOT EXISTS ab_solutions (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    name VARCHAR(191) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    publisher VARCHAR(255) NULL,
    version VARCHAR(64) NULL,
    description TEXT NULL,
    components LONGTEXT NULL,
    created_on DATETIME(3) NOT NULL,
    modified_on DATETIME(3) NOT NULL,
    UNIQUE KEY ux_ab_solutions_name (name)
  ) ${TAIL}`,
  `CREATE TABLE IF NOT EXISTS ab_data_files (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    connection_id VARCHAR(64) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    original_name VARCHAR(255) NULL,
    kind VARCHAR(8) NOT NULL,
    size_bytes BIGINT NOT NULL DEFAULT 0,
    checksum VARCHAR(128) NULL,
    storage_key VARCHAR(255) NULL,
    imported_on DATETIME(3) NOT NULL,
    table_ids LONGTEXT NULL,
    modified_since_import TINYINT NOT NULL DEFAULT 0
  ) ${TAIL}`,
  `CREATE TABLE IF NOT EXISTS ab_attachments (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    table_id VARCHAR(64) NOT NULL,
    col VARCHAR(64) NOT NULL,
    row_id CHAR(36) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    mime VARCHAR(127) NOT NULL,
    size_bytes BIGINT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    storage_key VARCHAR(128) NOT NULL,
    created_by VARCHAR(64) NULL,
    created_on DATETIME(3) NOT NULL,
    KEY ix_ab_attachments_row (table_id, row_id)
  ) ${TAIL}`,
  `CREATE TABLE IF NOT EXISTS ab_counters (
    k VARCHAR(191) NOT NULL PRIMARY KEY,
    v BIGINT NOT NULL
  ) ${TAIL}`,
  `CREATE TABLE IF NOT EXISTS ab_audit (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    at DATETIME(3) NOT NULL,
    user_id VARCHAR(64) NULL,
    action VARCHAR(64) NOT NULL,
    table_id VARCHAR(64) NULL,
    row_id VARCHAR(64) NULL,
    details LONGTEXT NULL,
    KEY ix_ab_audit_at (at)
  ) ${TAIL}`,
]

type Row = Record<string, unknown>

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const optStr = (v: unknown): string | undefined => (v === null || v === undefined || v === '' ? undefined : String(v))
const bool = (v: unknown): boolean => v === 1 || v === true || v === '1' || (typeof v === 'object' && v !== null && Buffer.isBuffer(v) && v[0] === 1)
const scope = (v: unknown): AccessScope => (v === 'own' || v === 'all' ? v : 'none')
const json = (v: unknown): string => JSON.stringify(v ?? null)

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ')
}

export function createMetaStore(db: SqlDb, secrets: SecretBox): MetaStore {
  /* ---------------------------------------------------------------- users */
  async function userRoles(ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>()
    if (!ids.length) return out
    const rows = await db.query<Row>(`SELECT user_id, role_id FROM ab_user_roles WHERE user_id IN (${placeholders(ids.length)}) ORDER BY role_id`, ids)
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
      passwordHash: hash,
    }
  }
  async function usersWhere(where: string, params: unknown[]): Promise<UserRecord[]> {
    const rows = await db.query<Row>(`SELECT id, name, email, password_hash, status, must_change_password, created_on, last_login FROM ab_users ${where}`, params)
    const roles = await userRoles(rows.map((r) => str(r.id)))
    return rows.map((r) => toUser(r, roles))
  }
  async function setUserRoles(tx: SqlDb, userId: string, roleIds: string[]): Promise<void> {
    await tx.exec('DELETE FROM ab_user_roles WHERE user_id = ?', [userId])
    for (const rid of [...new Set(roleIds)]) await tx.exec('INSERT INTO ab_user_roles (user_id, role_id) VALUES (?, ?)', [userId, rid])
  }

  /* ---------------------------------------------------------------- roles */
  async function rolesWhere(where: string, params: unknown[]): Promise<StoredRole[]> {
    const rows = await db.query<Row>(`SELECT id, name, description, is_admin, is_maker, apps FROM ab_roles ${where} ORDER BY name`, params)
    if (!rows.length) return []
    const ids = rows.map((r) => str(r.id))
    const privs = await db.query<Row>(
      `SELECT role_id, table_id, can_create, read_scope, update_scope, delete_scope, columns, row_filter FROM ab_role_tables WHERE role_id IN (${placeholders(ids.length)}) ORDER BY table_id`,
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
      const columns = parseJson<Record<string, ColumnAccess> | null>(p.columns, null)
      if (columns && typeof columns === 'object' && Object.keys(columns).length) priv.columns = columns
      const rowFilter = parseJson<RowCondition[] | null>(p.row_filter, null)
      if (Array.isArray(rowFilter) && rowFilter.length) priv.rowFilter = rowFilter
      list.push(priv)
      byRole.set(str(p.role_id), list)
    }
    return rows.map((r) => {
      const apps = parseJson<string[] | 'all'>(r.apps, 'all')
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
    const def = parseJson<TableDef>(r.def, {} as TableDef)
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
      settings: parseJson<Record<string, string>>(r.settings, {}),
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
      tableIds: parseJson<string[]>(r.table_ids, []),
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

  const store: MetaStore = {
    db,

    async migrate(): Promise<MigrationSummary> {
      // downgrade guard first: a newer server's schema is never touched (not even CREATE TABLE IF NOT EXISTS)
      let current = 0
      try {
        const rows = await db.query<Row>("SELECT v FROM ab_meta WHERE k = 'schemaVersion'")
        current = rows.length ? Number(rows[0].v) || 0 : 0
      } catch (e) {
        if ((e as { code?: string }).code !== 'ER_NO_SUCH_TABLE') throw e
      }
      if (current > SCHEMA_VERSION) throw new SchemaTooNewError(current, SCHEMA_VERSION)
      for (const stmt of DDL) await db.exec(stmt)
      const steps: string[] = []
      if (current === 0) steps.push(`created the system tables (schema version ${SCHEMA_VERSION})`)
      else if (current < SCHEMA_VERSION) {
        // upgrades, ordered by version
        if (current < 2) {
          const r = await normaliseUserEmails(db)
          steps.push(`v2: lowercased ${r.changed} user email(s)${r.skipped.length ? `, ${r.skipped.length} left as they were (duplicates)` : ''}`)
        }
        if (current < 3) {
          steps.push(`v3: ${(await addMustChangePassword(db)) ? 'added' : 'kept'} ab_users.must_change_password`)
          const t = await markTableProvenance(db)
          steps.push(`v3: tables marked created-by-Appbuilder: ${t.managed}, linked: ${t.linked} (${t.readOnly} made read-only: system columns missing)`)
        }
      } else await addMustChangePassword(db) // same version, defensive (a column dropped by hand)
      if (current < SCHEMA_VERSION) {
        await db.exec('INSERT INTO ab_meta (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', ['schemaVersion', String(SCHEMA_VERSION)])
      }
      return { from: current, to: SCHEMA_VERSION, steps }
    },

    users: {
      list: () => usersWhere('ORDER BY name', []),
      async get(id) {
        return (await usersWhere('WHERE id = ?', [id]))[0] ?? null
      },
      async byEmail(email) {
        return (await usersWhere('WHERE email = ?', [email.trim().toLowerCase()]))[0] ?? null
      },
      async count() {
        const rows = await db.query<Row>('SELECT COUNT(*) AS n FROM ab_users')
        return Number(rows[0]?.n) || 0
      },
      async insert(u) {
        await db.tx(async (tx) => {
          await tx.exec(
            'INSERT INTO ab_users (id, name, email, password_hash, status, must_change_password, created_on, last_login) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [u.id, u.name, u.email.trim().toLowerCase(), u.passwordHash ?? null, u.status ?? 'active', u.mustChangePassword ? 1 : 0, new Date(), toDate(u.lastLogin)],
          )
          await setUserRoles(tx, u.id, u.roleIds ?? [])
        })
      },
      async update(id, patch) {
        await db.tx(async (tx) => {
          const sets: string[] = []
          const params: unknown[] = []
          if (patch.name !== undefined) (sets.push('name = ?'), params.push(patch.name))
          if (patch.email !== undefined) (sets.push('email = ?'), params.push(patch.email.trim().toLowerCase()))
          if (patch.passwordHash !== undefined) (sets.push('password_hash = ?'), params.push(patch.passwordHash))
          if (patch.status !== undefined) (sets.push('status = ?'), params.push(patch.status))
          if (patch.mustChangePassword !== undefined) (sets.push('must_change_password = ?'), params.push(patch.mustChangePassword ? 1 : 0))
          if (patch.lastLogin !== undefined) (sets.push('last_login = ?'), params.push(toDate(patch.lastLogin)))
          if (sets.length) await tx.exec(`UPDATE ab_users SET ${sets.join(', ')} WHERE id = ?`, [...params, id])
          if (patch.roleIds !== undefined) await setUserRoles(tx, id, patch.roleIds)
        })
      },
      async remove(id) {
        await db.tx(async (tx) => {
          await tx.exec('DELETE FROM ab_user_roles WHERE user_id = ?', [id])
          await tx.exec('DELETE FROM ab_sessions WHERE user_id = ?', [id])
          await tx.exec('DELETE FROM ab_users WHERE id = ?', [id])
        })
      },
    },

    sessions: {
      async insert(s) {
        const now = new Date()
        await db.exec(
          'INSERT INTO ab_sessions (id_hash, user_id, created_on, expires_on, last_seen, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
          [s.idHash, s.userId, now, s.expiresOn, now, (s.userAgent ?? '').slice(0, 255)],
        )
      },
      async get(idHash) {
        const rows = await db.query<Row>('SELECT user_id, expires_on FROM ab_sessions WHERE id_hash = ?', [idHash])
        if (!rows.length) return null
        const expiresOn = new Date(toIso(rows[0].expires_on))
        return { userId: str(rows[0].user_id), expiresOn }
      },
      async touch(idHash, expiresOn) {
        await db.exec('UPDATE ab_sessions SET expires_on = ?, last_seen = ? WHERE id_hash = ?', [expiresOn, new Date(), idHash])
      },
      async remove(idHash) {
        await db.exec('DELETE FROM ab_sessions WHERE id_hash = ?', [idHash])
      },
      async removeForUser(userId) {
        await db.exec('DELETE FROM ab_sessions WHERE user_id = ?', [userId])
      },
      async purgeExpired() {
        const r = await db.exec('DELETE FROM ab_sessions WHERE expires_on < ?', [new Date()])
        return r.affectedRows
      },
    },

    roles: {
      list: () => rolesWhere('', []),
      async get(id) {
        return (await rolesWhere('WHERE id = ?', [id]))[0] ?? null
      },
      async upsert(role) {
        const r = role as StoredRole
        await db.tx(async (tx) => {
          await tx.exec(
            `INSERT INTO ab_roles (id, name, description, is_admin, is_maker, apps) VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), is_admin = VALUES(is_admin),
             is_maker = VALUES(is_maker), apps = VALUES(apps)`,
            [r.id, r.name, r.description ?? null, r.isAdmin ? 1 : 0, r.isMaker ? 1 : 0, json(r.apps ?? 'all')],
          )
          await tx.exec('DELETE FROM ab_role_tables WHERE role_id = ?', [r.id])
          const seen = new Set<string>()
          for (const p of r.privileges ?? []) {
            if (seen.has(p.table)) continue
            seen.add(p.table)
            await tx.exec(
              `INSERT INTO ab_role_tables (role_id, table_id, can_create, read_scope, update_scope, delete_scope, columns, row_filter)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                r.id, p.table, p.create ? 1 : 0, scope(p.read), scope(p.update), scope(p.delete),
                p.columns && Object.keys(p.columns).length ? json(p.columns) : null,
                p.rowFilter && p.rowFilter.length ? json(p.rowFilter) : null,
              ],
            )
          }
        })
      },
      async remove(id) {
        await db.tx(async (tx) => {
          await tx.exec('DELETE FROM ab_role_tables WHERE role_id = ?', [id])
          await tx.exec('DELETE FROM ab_user_roles WHERE role_id = ?', [id])
          await tx.exec('DELETE FROM ab_roles WHERE id = ?', [id])
        })
      },
    },

    tables: {
      async list() {
        return (await db.query<Row>('SELECT id, name, connection_id, source, def FROM ab_tables ORDER BY name')).map(toTable)
      },
      async get(idOrName) {
        const rows = await db.query<Row>('SELECT id, name, connection_id, source, def FROM ab_tables WHERE id = ? OR name = ? ORDER BY (id = ?) DESC LIMIT 1', [idOrName, idOrName, idOrName])
        return rows.length ? toTable(rows[0]) : null
      },
      async upsert(t) {
        await db.exec(
          `INSERT INTO ab_tables (id, name, connection_id, source, def, created_on, modified_on) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE name = VALUES(name), connection_id = VALUES(connection_id), source = VALUES(source),
           def = VALUES(def), modified_on = VALUES(modified_on)`,
          [t.id, t.name, t.connectionId ?? null, t.source ?? null, JSON.stringify(t), toDate(t.createdOn) ?? new Date(), toDate(t.modifiedOn) ?? new Date()],
        )
      },
      async remove(id) {
        await db.tx(async (tx) => {
          await tx.exec('DELETE FROM ab_role_tables WHERE table_id = ?', [id])
          await tx.exec('DELETE FROM ab_tables WHERE id = ?', [id])
        })
      },
    },

    apps: {
      async list() {
        const rows = await db.query<Row>('SELECT id, name, description, width, height, created_on, modified_on, modified_by FROM ab_apps ORDER BY name')
        return rows.map(toAppMeta)
      },
      async get(id) {
        const rows = await db.query<Row>('SELECT id, name, description, width, height, created_on, modified_on, modified_by, definition FROM ab_apps WHERE id = ?', [id])
        if (!rows.length) return null
        return { meta: toAppMeta(rows[0]), definition: parseJson<AppDef>(rows[0].definition, {} as AppDef) }
      },
      async upsert(meta, definition) {
        await db.exec(
          `INSERT INTO ab_apps (id, name, description, width, height, definition, created_on, modified_on, modified_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), width = VALUES(width),
           height = VALUES(height), definition = VALUES(definition), modified_on = VALUES(modified_on), modified_by = VALUES(modified_by)`,
          [
            meta.id, meta.name, meta.description ?? null, Math.round(meta.width) || 1920, Math.round(meta.height) || 1080,
            JSON.stringify(definition), toDate(meta.createdOn) ?? new Date(), toDate(meta.modifiedOn) ?? new Date(), meta.modifiedBy || null,
          ],
        )
      },
      async remove(id) {
        await db.exec('DELETE FROM ab_apps WHERE id = ?', [id])
      },
    },

    connections: {
      async list() {
        return (await db.query<Row>('SELECT * FROM ab_connections ORDER BY name')).map(toConnection)
      },
      async get(id) {
        const rows = await db.query<Row>('SELECT * FROM ab_connections WHERE id = ?', [id])
        return rows.length ? toConnection(rows[0]) : null
      },
      async upsert(c) {
        // secret: undefined = keep the stored one, '' = clear, text = seal and store
        await db.tx(async (tx) => {
          const existing = await tx.query<Row>('SELECT secret_sealed, created_on FROM ab_connections WHERE id = ?', [c.id])
          let sealed: string | null = existing.length ? (existing[0].secret_sealed as string | null) ?? null : null
          if (c.secret !== undefined) sealed = c.secret === '' ? null : secrets.encrypt(c.secret)
          if (c.isDefault) await tx.exec('UPDATE ab_connections SET is_default = 0 WHERE id <> ?', [c.id])
          const now = new Date()
          await tx.exec(
            `INSERT INTO ab_connections (id, name, connector, settings, secret_sealed, status, last_error, is_default, scope, created_on, modified_on)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), connector = VALUES(connector), settings = VALUES(settings),
             secret_sealed = VALUES(secret_sealed), status = VALUES(status), last_error = VALUES(last_error),
             is_default = VALUES(is_default), scope = VALUES(scope), modified_on = VALUES(modified_on)`,
            [
              c.id, c.name, c.connector, json(c.settings ?? {}), sealed, c.status ?? 'not-configured', c.lastError ?? null,
              c.isDefault ? 1 : 0, c.scope === 'device' ? 'device' : 'server', existing.length ? existing[0].created_on : now, now,
            ],
          )
        })
      },
      async remove(id) {
        await db.exec('DELETE FROM ab_connections WHERE id = ?', [id])
      },
    },

    solutions: {
      async list() {
        const rows = await db.query<Row>('SELECT * FROM ab_solutions ORDER BY display_name')
        return rows.map((r): SolutionDef => {
          const s: SolutionDef = {
            id: str(r.id),
            name: str(r.name),
            displayName: str(r.display_name),
            publisher: str(r.publisher),
            version: str(r.version),
            components: parseJson<SolutionDef['components']>(r.components, []),
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
          `INSERT INTO ab_solutions (id, name, display_name, publisher, version, description, components, created_on, modified_on)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE name = VALUES(name), display_name = VALUES(display_name), publisher = VALUES(publisher),
           version = VALUES(version), description = VALUES(description), components = VALUES(components), modified_on = VALUES(modified_on)`,
          [
            s.id, s.name, s.displayName, s.publisher ?? '', s.version ?? '', s.description ?? null, json(s.components ?? []),
            toDate(s.createdOn) ?? new Date(), toDate(s.modifiedOn) ?? new Date(),
          ],
        )
      },
      async remove(id) {
        await db.exec('DELETE FROM ab_solutions WHERE id = ?', [id])
      },
    },

    files: {
      async list() {
        return (await db.query<Row>('SELECT * FROM ab_data_files ORDER BY file_name')).map(toFile)
      },
      async get(id) {
        const rows = await db.query<Row>('SELECT * FROM ab_data_files WHERE id = ?', [id])
        return rows.length ? toFile(rows[0]) : null
      },
      async upsert(f) {
        await db.exec(
          `INSERT INTO ab_data_files (id, connection_id, file_name, original_name, kind, size_bytes, checksum, storage_key, imported_on, table_ids, modified_since_import)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE connection_id = VALUES(connection_id), file_name = VALUES(file_name), original_name = VALUES(original_name),
           kind = VALUES(kind), size_bytes = VALUES(size_bytes), checksum = VALUES(checksum), storage_key = VALUES(storage_key),
           imported_on = VALUES(imported_on), table_ids = VALUES(table_ids), modified_since_import = VALUES(modified_since_import)`,
          [
            f.id, f.connectionId, f.fileName, f.originalName ?? f.fileName, f.kind, f.sizeBytes ?? 0, f.checksum ?? '', f.storageKey ?? '',
            toDate(f.importedOn) ?? new Date(), json(f.tableIds ?? []), f.modifiedSinceImport ? 1 : 0,
          ],
        )
      },
      async remove(id) {
        await db.exec('DELETE FROM ab_data_files WHERE id = ?', [id])
      },
    },

    attachments: {
      async get(id) {
        const rows = await db.query<Row>('SELECT * FROM ab_attachments WHERE id = ?', [id])
        return rows.length ? toAttachment(rows[0]) : null
      },
      async many(ids) {
        const list = [...new Set(ids.filter((x) => typeof x === 'string' && x))].slice(0, 1000)
        if (!list.length) return []
        return (await db.query<Row>(`SELECT * FROM ab_attachments WHERE id IN (${placeholders(list.length)})`, list)).map(toAttachment)
      },
      async insert(a) {
        await db.exec(
          `INSERT INTO ab_attachments (id, table_id, col, row_id, file_name, mime, size_bytes, sha256, storage_key, created_by, created_on)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [a.id, a.tableId, a.column, a.rowId, a.fileName, a.mime, a.sizeBytes, a.sha256, a.storageKey, a.createdBy || null, toDate(a.createdOn) ?? new Date()],
        )
      },
      async remove(id) {
        await db.exec('DELETE FROM ab_attachments WHERE id = ?', [id])
      },
      async forRows(tableId, rowIds) {
        const out: AttachmentRecord[] = []
        for (let i = 0; i < rowIds.length; i += 500) {
          const chunk = rowIds.slice(i, i + 500)
          if (!chunk.length) continue
          const rows = await db.query<Row>(`SELECT * FROM ab_attachments WHERE table_id = ? AND row_id IN (${placeholders(chunk.length)})`, [tableId, ...chunk])
          out.push(...rows.map(toAttachment))
        }
        return out
      },
    },

    async nextCounter(key) {
      return db.tx(async (tx) => {
        await tx.exec('INSERT INTO ab_counters (k, v) VALUES (?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE v = LAST_INSERT_ID(v + 1)', [key])
        const rows = await tx.query<Row>('SELECT LAST_INSERT_ID() AS v')
        return Number(rows[0]?.v) || 1
      })
    },

    async audit(entry) {
      let details: string | null = null
      if (entry.details !== undefined) {
        try {
          details = JSON.stringify(entry.details)
        } catch {
          details = null
        }
        if (details && details.length > 60000) details = details.slice(0, 60000)
      }
      await db.exec(
        'INSERT INTO ab_audit (at, user_id, action, table_id, row_id, details) VALUES (?, ?, ?, ?, ?, ?)',
        [new Date(), entry.userId ?? null, entry.action.slice(0, 64), entry.tableId ?? null, entry.rowId ? String(entry.rowId).slice(0, 64) : null, details],
      )
    },

    async auditPage(f) {
      const where: string[] = []
      const params: unknown[] = []
      if (f.action) {
        if (f.action.endsWith('.')) {
          where.push('action LIKE ?')
          params.push(`${f.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
        } else {
          where.push('action = ?')
          params.push(f.action)
        }
      }
      if (f.userId) {
        where.push('user_id = ?')
        params.push(f.userId)
      }
      const from = toDate(f.from)
      if (from) {
        where.push('at >= ?')
        params.push(from)
      }
      const to = toDate(f.to)
      if (to) {
        where.push('at < ?')
        params.push(to)
      }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const total = Number((await db.query<Row>(`SELECT COUNT(*) AS n FROM ab_audit ${w}`, params))[0]?.n) || 0
      const limit = Math.max(1, Math.min(500, Math.floor(f.limit)))
      const offset = Math.max(0, Math.floor(f.offset))
      // LIMIT/OFFSET are validated integers (placeholders there are not portable across MySQL versions)
      const rows = await db.query<Row>(`SELECT id, at, user_id, action, table_id, row_id, details FROM ab_audit ${w} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`, params)
      return {
        total,
        items: rows.map((r) => ({
          id: Number(r.id),
          at: toIso(r.at),
          userId: optStr(r.user_id) ?? null,
          action: str(r.action),
          tableId: optStr(r.table_id) ?? null,
          rowId: optStr(r.row_id) ?? null,
          details: r.details === null || r.details === undefined ? null : parseJson<unknown>(r.details, str(r.details)),
        })),
      }
    },

    async auditActions() {
      return (await db.query<Row>('SELECT DISTINCT action FROM ab_audit ORDER BY action')).map((r) => str(r.action))
    },

    async info() {
      const rows = await db.query<Row>('SELECT MIN(created_on) AS c FROM ab_users')
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
