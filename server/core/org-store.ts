/**
 * Organisation store (docs/admin/organisation.md, docs/dev/schema.md): departments, teams and their members, the
 * organisation fields of users (install-wide, schema `ab`), and record shares (per environment, `ab_shares` in the
 * environment schema). A PostgreSQL implementation over SqlDb and an in-memory one for tests and fakes.
 */
import type { DepartmentDef, ShareDef, TeamDef } from '../../src/platform/contracts.ts'
import type { OrgDirectory, OrgUser } from '../../src/platform/orgsec.ts'
import type { SqlDb } from './contracts.ts'
import { INSTALL_SCHEMA, currentEnvironment } from './env-context.ts'
import { toIso } from './util.ts'

export interface UserOrgFields {
  departmentId?: string | null
  managerId?: string | null
  jobTitle?: string | null
  phone?: string | null
  employeeCode?: string | null
}

export interface OrgStore {
  /** departments, users (id, name, email, department, manager, status) and teams with members */
  directory(): Promise<OrgDirectory>
  departments: {
    list(): Promise<DepartmentDef[]>
    insert(d: DepartmentDef): Promise<void>
    update(id: string, patch: Partial<Omit<DepartmentDef, 'id'>>): Promise<void>
    /** users of the department lose it; child departments must have been moved first (the route checks) */
    remove(id: string): Promise<void>
  }
  teams: {
    list(): Promise<TeamDef[]>
    insert(t: TeamDef): Promise<void>
    update(id: string, patch: Partial<Omit<TeamDef, 'id'>>): Promise<void>
    /** removes members and every share to the team (all environments) */
    remove(id: string): Promise<void>
  }
  /** sets the organisation fields of a user (undefined = unchanged, null = cleared) */
  setUserOrg(userId: string, f: UserOrgFields): Promise<void>
  /** a user was deleted: reports lose their manager, team memberships and shares to the user go (all environments) */
  userRemoved(userId: string): Promise<void>
  shares: {
    /** shares of the current environment whose principal is one of these ids */
    forPrincipals(ids: string[]): Promise<ShareDef[]>
    forRow(tableId: string, rowId: string): Promise<ShareDef[]>
    /** insert or change the access of one share */
    put(s: ShareDef): Promise<void>
    remove(tableId: string, rowId: string, principalType: 'user' | 'team', principalId: string): Promise<number>
    removeForRows(tableId: string, rowIds: string[]): Promise<void>
    removeForTable(tableId: string): Promise<void>
  }
}

type Row = Record<string, unknown>
const q = (id: string): string => `"${id}"`
const A = (t: string): string => `${q(INSTALL_SCHEMA)}.${q(t)}`
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const opt = (v: unknown): string | undefined => (v === null || v === undefined || v === '' ? undefined : String(v))

/** install DDL of the organisation (appended to INSTALL_DDL, idempotent) */
export const ORG_INSTALL_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS ${A('departments')} (
    id text PRIMARY KEY,
    code text NOT NULL,
    name text NOT NULL,
    parent_id text NULL,
    description text NULL,
    created_on timestamptz NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_departments_code ON ${A('departments')} (lower(code))`,
  `CREATE INDEX IF NOT EXISTS ab_ix_departments_parent ON ${A('departments')} (parent_id)`,
  `ALTER TABLE ${A('users')} ADD COLUMN IF NOT EXISTS department_id text NULL`,
  `ALTER TABLE ${A('users')} ADD COLUMN IF NOT EXISTS manager_id text NULL`,
  `ALTER TABLE ${A('users')} ADD COLUMN IF NOT EXISTS job_title text NULL`,
  `ALTER TABLE ${A('users')} ADD COLUMN IF NOT EXISTS phone text NULL`,
  `ALTER TABLE ${A('users')} ADD COLUMN IF NOT EXISTS employee_code text NULL`,
  `CREATE INDEX IF NOT EXISTS ab_ix_users_department ON ${A('users')} (department_id)`,
  `CREATE INDEX IF NOT EXISTS ab_ix_users_manager ON ${A('users')} (manager_id)`,
  `CREATE TABLE IF NOT EXISTS ${A('teams')} (
    id text PRIMARY KEY,
    code text NOT NULL,
    name text NOT NULL,
    description text NULL,
    environment_id text NULL,
    created_on timestamptz NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_teams_code ON ${A('teams')} (lower(code))`,
  `CREATE TABLE IF NOT EXISTS ${A('team_members')} (
    team_id text NOT NULL,
    user_id text NOT NULL,
    PRIMARY KEY (team_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS ab_ix_team_members_user ON ${A('team_members')} (user_id)`,
]

/** per-environment DDL (appended to environmentDdl, idempotent) */
export function orgEnvironmentDdl(schema: string): string[] {
  const E = (t: string): string => `${q(schema)}.${q(t)}`
  return [
    `CREATE TABLE IF NOT EXISTS ${E('ab_shares')} (
      table_id text NOT NULL,
      row_id text NOT NULL,
      principal_type text NOT NULL,
      principal_id text NOT NULL,
      access text NOT NULL,
      shared_by text NULL,
      shared_on timestamptz NOT NULL,
      PRIMARY KEY (table_id, row_id, principal_type, principal_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_shares_principal ON ${E('ab_shares')} (principal_id, table_id)`,
    // the share privilege of a role on a table (none when NULL)
    `ALTER TABLE ${E('ab_role_tables')} ADD COLUMN IF NOT EXISTS share_scope text NULL`,
  ]
}

function toShare(r: Row): ShareDef {
  const s: ShareDef = {
    tableId: str(r.table_id), rowId: str(r.row_id), principalType: r.principal_type === 'team' ? 'team' : 'user',
    principalId: str(r.principal_id), access: r.access === 'update' ? 'update' : 'read',
  }
  const by = opt(r.shared_by)
  if (by) s.sharedBy = by
  if (r.shared_on) s.sharedOn = toIso(r.shared_on)
  return s
}

export function createOrgStore(db: SqlDb, envSchema: () => string = () => currentEnvironment().schema): OrgStore {
  const E = (t: string): string => `${q(envSchema())}.${q(t)}`
  async function envSchemas(d: SqlDb): Promise<string[]> {
    const rows = await d.query<Row>(`SELECT schema_name FROM ${A('environments')}`)
    const out: string[] = []
    for (const r of rows) {
      const ok = await d.query<Row>('SELECT to_regclass($1) IS NOT NULL AS ok', [`${q(str(r.schema_name))}.ab_shares`])
      if (ok[0]?.ok === true) out.push(str(r.schema_name))
    }
    return out
  }
  const departments: OrgStore['departments'] = {
    async list() {
      const rows = await db.query<Row>(`SELECT id, code, name, parent_id, description FROM ${A('departments')} ORDER BY lower(name) COLLATE "C", id`)
      return rows.map((r) => {
        const d: DepartmentDef = { id: str(r.id), code: str(r.code), name: str(r.name) }
        if (opt(r.parent_id)) d.parentId = str(r.parent_id)
        if (opt(r.description)) d.description = str(r.description)
        return d
      })
    },
    async insert(d) {
      await db.exec(`INSERT INTO ${A('departments')} (id, code, name, parent_id, description, created_on) VALUES ($1, $2, $3, $4, $5, $6)`,
        [d.id, d.code, d.name, d.parentId ?? null, d.description ?? null, new Date()])
    },
    async update(id, p) {
      const sets: string[] = []
      const params: unknown[] = []
      const set = (c: string, v: unknown) => { params.push(v); sets.push(`${c} = $${params.length}`) }
      if (p.code !== undefined) set('code', p.code)
      if (p.name !== undefined) set('name', p.name)
      if ('parentId' in p) set('parent_id', p.parentId ?? null)
      if ('description' in p) set('description', p.description ?? null)
      if (!sets.length) return
      await db.exec(`UPDATE ${A('departments')} SET ${sets.join(', ')} WHERE id = $${params.length + 1}`, [...params, id])
    },
    async remove(id) {
      await db.tx(async (tx) => {
        await tx.exec(`UPDATE ${A('users')} SET department_id = NULL WHERE department_id = $1`, [id])
        await tx.exec(`DELETE FROM ${A('departments')} WHERE id = $1`, [id])
      })
    },
  }
  const teams: OrgStore['teams'] = {
    async list() {
      const rows = await db.query<Row>(`SELECT id, code, name, description, environment_id FROM ${A('teams')} ORDER BY lower(name) COLLATE "C", id`)
      const members = await db.query<Row>(`SELECT team_id, user_id FROM ${A('team_members')} ORDER BY user_id`)
      const by = new Map<string, string[]>()
      for (const m of members) {
        const l = by.get(str(m.team_id)) ?? []
        l.push(str(m.user_id))
        by.set(str(m.team_id), l)
      }
      return rows.map((r) => {
        const t: TeamDef = { id: str(r.id), code: str(r.code), name: str(r.name), memberIds: by.get(str(r.id)) ?? [] }
        if (opt(r.description)) t.description = str(r.description)
        if (opt(r.environment_id)) t.environmentId = str(r.environment_id)
        return t
      })
    },
    async insert(t) {
      await db.tx(async (tx) => {
        await tx.exec(`INSERT INTO ${A('teams')} (id, code, name, description, environment_id, created_on) VALUES ($1, $2, $3, $4, $5, $6)`,
          [t.id, t.code, t.name, t.description ?? null, t.environmentId ?? null, new Date()])
        for (const u of new Set(t.memberIds)) await tx.exec(`INSERT INTO ${A('team_members')} (team_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [t.id, u])
      })
    },
    async update(id, p) {
      await db.tx(async (tx) => {
        const sets: string[] = []
        const params: unknown[] = []
        const set = (c: string, v: unknown) => { params.push(v); sets.push(`${c} = $${params.length}`) }
        if (p.code !== undefined) set('code', p.code)
        if (p.name !== undefined) set('name', p.name)
        if ('description' in p) set('description', p.description ?? null)
        if ('environmentId' in p) set('environment_id', p.environmentId ?? null)
        if (sets.length) await tx.exec(`UPDATE ${A('teams')} SET ${sets.join(', ')} WHERE id = $${params.length + 1}`, [...params, id])
        if (p.memberIds) {
          await tx.exec(`DELETE FROM ${A('team_members')} WHERE team_id = $1 AND NOT (user_id = ANY($2::text[]))`, [id, p.memberIds])
          for (const u of new Set(p.memberIds)) await tx.exec(`INSERT INTO ${A('team_members')} (team_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, u])
        }
      })
    },
    async remove(id) {
      await db.tx(async (tx) => {
        await tx.exec(`DELETE FROM ${A('team_members')} WHERE team_id = $1`, [id])
        await tx.exec(`DELETE FROM ${A('teams')} WHERE id = $1`, [id])
        for (const s of await envSchemas(tx)) await tx.exec(`DELETE FROM ${q(s)}."ab_shares" WHERE principal_type = 'team' AND principal_id = $1`, [id])
      })
    },
  }
  return {
    async directory() {
      // one after the other: inside a unit of work the db is a single transaction connection
      const deps = await departments.list()
      const users = await db.query<Row>(`SELECT id, name, email, status, department_id, manager_id FROM ${A('users')}`)
      const tms = await teams.list()
      return {
        departments: deps,
        users: users.map((r) => {
          const u: OrgUser = { id: str(r.id), name: str(r.name), email: str(r.email), status: r.status === 'disabled' ? 'disabled' : 'active' }
          if (opt(r.department_id)) u.departmentId = str(r.department_id)
          if (opt(r.manager_id)) u.managerId = str(r.manager_id)
          return u
        }),
        teams: tms,
      }
    },
    departments,
    teams,
    async setUserOrg(userId, f) {
      const sets: string[] = []
      const params: unknown[] = []
      const set = (c: string, v: unknown) => { params.push(v === '' ? null : v); sets.push(`${c} = $${params.length}`) }
      if (f.departmentId !== undefined) set('department_id', f.departmentId)
      if (f.managerId !== undefined) set('manager_id', f.managerId)
      if (f.jobTitle !== undefined) set('job_title', f.jobTitle)
      if (f.phone !== undefined) set('phone', f.phone)
      if (f.employeeCode !== undefined) set('employee_code', f.employeeCode)
      if (!sets.length) return
      await db.exec(`UPDATE ${A('users')} SET ${sets.join(', ')} WHERE id = $${params.length + 1}`, [...params, userId])
    },
    async userRemoved(userId) {
      await db.tx(async (tx) => {
        await tx.exec(`UPDATE ${A('users')} SET manager_id = NULL WHERE manager_id = $1`, [userId])
        await tx.exec(`DELETE FROM ${A('team_members')} WHERE user_id = $1`, [userId])
        for (const s of await envSchemas(tx)) await tx.exec(`DELETE FROM ${q(s)}."ab_shares" WHERE principal_type = 'user' AND principal_id = $1`, [userId])
      })
    },
    shares: {
      async forPrincipals(ids) {
        if (!ids.length) return []
        return (await db.query<Row>(`SELECT * FROM ${E('ab_shares')} WHERE principal_id = ANY($1::text[])`, [ids])).map(toShare)
      },
      async forRow(tableId, rowId) {
        return (await db.query<Row>(`SELECT * FROM ${E('ab_shares')} WHERE table_id = $1 AND row_id = $2 ORDER BY shared_on, principal_id`, [tableId, rowId])).map(toShare)
      },
      async put(s) {
        await db.exec(
          `INSERT INTO ${E('ab_shares')} (table_id, row_id, principal_type, principal_id, access, shared_by, shared_on) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (table_id, row_id, principal_type, principal_id) DO UPDATE SET access = EXCLUDED.access, shared_by = EXCLUDED.shared_by, shared_on = EXCLUDED.shared_on`,
          [s.tableId, s.rowId, s.principalType, s.principalId, s.access, s.sharedBy ?? null, new Date()],
        )
      },
      async remove(tableId, rowId, type, id) {
        return (await db.exec(`DELETE FROM ${E('ab_shares')} WHERE table_id = $1 AND row_id = $2 AND principal_type = $3 AND principal_id = $4`, [tableId, rowId, type, id])).affectedRows
      },
      async removeForRows(tableId, rowIds) {
        if (!rowIds.length) return
        await db.exec(`DELETE FROM ${E('ab_shares')} WHERE table_id = $1 AND row_id = ANY($2::text[])`, [tableId, rowIds])
      },
      async removeForTable(tableId) {
        await db.exec(`DELETE FROM ${E('ab_shares')} WHERE table_id = $1`, [tableId])
      },
    },
  }
}

/* ------------------------------------------------------------------ in memory (tests, fakes) */

export function createMemoryOrgStore(init: Partial<OrgDirectory> = {}, envId: () => string = () => currentEnvironment().id): OrgStore & { dir: OrgDirectory; shareRows: (ShareDef & { env: string })[] } {
  const dir: OrgDirectory = { departments: [...(init.departments ?? [])], users: [...(init.users ?? [])], teams: [...(init.teams ?? [])] }
  const shareRows: (ShareDef & { env: string })[] = []
  const extra = new Map<string, { jobTitle?: string; phone?: string; employeeCode?: string }>()
  const clone = <T>(v: T): T => structuredClone(v)
  return {
    dir,
    shareRows,
    async directory() { return clone(dir) },
    departments: {
      async list() { return clone(dir.departments) },
      async insert(d) { dir.departments.push(clone(d)) },
      async update(id, p) {
        const d = dir.departments.find((x) => x.id === id)
        if (!d) return
        Object.assign(d, p)
        if ('parentId' in p && !p.parentId) delete d.parentId
      },
      async remove(id) {
        dir.departments = dir.departments.filter((d) => d.id !== id)
        for (const u of dir.users) if (u.departmentId === id) delete u.departmentId
      },
    },
    teams: {
      async list() { return clone(dir.teams) },
      async insert(t) { dir.teams.push(clone(t)) },
      async update(id, p) {
        const t = dir.teams.find((x) => x.id === id)
        if (t) Object.assign(t, clone(p))
      },
      async remove(id) {
        dir.teams = dir.teams.filter((t) => t.id !== id)
        for (let i = shareRows.length - 1; i >= 0; i--) if (shareRows[i].principalType === 'team' && shareRows[i].principalId === id) shareRows.splice(i, 1)
      },
    },
    async setUserOrg(userId, f) {
      let u = dir.users.find((x) => x.id === userId)
      if (!u) dir.users.push((u = { id: userId, name: userId, email: `${userId}@local` }))
      if (f.departmentId !== undefined) { if (f.departmentId) u.departmentId = f.departmentId; else delete u.departmentId }
      if (f.managerId !== undefined) { if (f.managerId) u.managerId = f.managerId; else delete u.managerId }
      const e = extra.get(userId) ?? {}
      if (f.jobTitle !== undefined) e.jobTitle = f.jobTitle ?? undefined
      if (f.phone !== undefined) e.phone = f.phone ?? undefined
      if (f.employeeCode !== undefined) e.employeeCode = f.employeeCode ?? undefined
      extra.set(userId, e)
    },
    async userRemoved(userId) {
      for (const u of dir.users) if (u.managerId === userId) delete u.managerId
      dir.users = dir.users.filter((u) => u.id !== userId)
      for (const t of dir.teams) t.memberIds = t.memberIds.filter((m) => m !== userId)
      for (let i = shareRows.length - 1; i >= 0; i--) if (shareRows[i].principalType === 'user' && shareRows[i].principalId === userId) shareRows.splice(i, 1)
    },
    shares: {
      async forPrincipals(ids) { return clone(shareRows.filter((s) => s.env === envId() && ids.includes(s.principalId))) },
      async forRow(tableId, rowId) { return clone(shareRows.filter((s) => s.env === envId() && s.tableId === tableId && s.rowId === rowId)) },
      async put(s) {
        const i = shareRows.findIndex((x) => x.env === envId() && x.tableId === s.tableId && x.rowId === s.rowId && x.principalType === s.principalType && x.principalId === s.principalId)
        const row = { ...clone(s), env: envId(), sharedOn: new Date().toISOString() }
        if (i >= 0) shareRows[i] = row
        else shareRows.push(row)
      },
      async remove(tableId, rowId, type, id) {
        const before = shareRows.length
        for (let i = shareRows.length - 1; i >= 0; i--) {
          const s = shareRows[i]
          if (s.env === envId() && s.tableId === tableId && s.rowId === rowId && s.principalType === type && s.principalId === id) shareRows.splice(i, 1)
        }
        return before - shareRows.length
      },
      async removeForRows(tableId, rowIds) {
        for (let i = shareRows.length - 1; i >= 0; i--) if (shareRows[i].env === envId() && shareRows[i].tableId === tableId && rowIds.includes(shareRows[i].rowId)) shareRows.splice(i, 1)
      },
      async removeForTable(tableId) {
        for (let i = shareRows.length - 1; i >= 0; i--) if (shareRows[i].env === envId() && shareRows[i].tableId === tableId) shareRows.splice(i, 1)
      },
    },
  }
}
