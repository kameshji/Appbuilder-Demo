/**
 * Roles (with CLS columns and RLS rowFilter), users (password, disable, last-admin guard) and the
 * admin-only security preview. Every change is audited (never with passwords) and invalidates the security cache.
 */
import type { AccessScope, ColumnAccess, RoleDef, RowCompare, RowCondition, TableDef, TablePrivilege, UserDef } from '../../../src/platform/contracts.ts'
import { ruleProblems } from '../../../src/platform/orgsec.ts'
import { DEFAULT_CONNECTION_ID } from '../../core/connections.ts'
import { HttpError } from '../../core/contracts.ts'
import type { Ctx, Router, Services, UserContext } from '../../core/contracts.ts'
import { checkPasswordPolicy, hashPassword } from '../../core/password.ts'
import type { UserRecord } from '../../core/contracts.ts'
import { bodyObj, conflict, invalid, isObj, notFound, optString, reqString } from './util.ts'
import type { RoleX } from './util.ts'
import { audit, grantDefaults } from './tables-core.ts'
import { readOrgFields, reasonText, saveOrgFields } from './org.ts'

const SCOPES: AccessScope[] = ['none', 'own', 'team', 'manager', 'managerTree', 'department', 'departmentTree', 'all']
const ACCESS: ColumnAccess[] = ['none', 'read', 'update']
const FILTER_OPS: RowCompare['op'][] = ['eq', 'ne', 'in', 'contains', 'startsWith', 'lt', 'le', 'gt', 'ge', 'isBlank', 'notBlank']
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** a rule may have at most this many nodes (all levels) */
const MAX_RULE_NODES = 200

/* ------------------------------------------------------------------ validation */

/** structural copy of one rule node (only known fields); throws 422 on malformed input */
function sanitizeRule(c: unknown, where: string, counter: { n: number }, depth = 0): RowCondition {
  if (++counter.n > MAX_RULE_NODES || depth > 6) throw invalid(`${where}: the rule is too large.`, 'rowFilter')
  if (!isObj(c)) throw invalid(`${where} is malformed.`, 'rowFilter')
  if ('any' in c) {
    if (!Array.isArray(c.any) || !c.any.length) throw invalid(`${where}: an "any of" group needs at least one condition.`, 'rowFilter')
    return { any: c.any.map((x, i) => sanitizeRule(x, `${where}.${i + 1}`, counter, depth + 1)) }
  }
  if ('exists' in c) {
    const e = c.exists
    if (!isObj(e) || typeof e.table !== 'string' || !e.table || !Array.isArray(e.where) || !e.where.length) throw invalid(`${where}: a related-rows rule needs a table and conditions.`, 'rowFilter')
    return { exists: { table: e.table, where: e.where.map((x, i) => sanitizeRule(x, `${where}.${i + 1}`, counter, depth + 1)) } }
  }
  const column = typeof c.column === 'string' ? c.column : ''
  if (!column || column.length > 200) throw invalid(`${where} needs a column.`, 'rowFilter')
  const op = c.op as RowCompare['op']
  if (!FILTER_OPS.includes(op)) throw invalid(`${where}: unknown operator "${String(c.op)}".`, 'rowFilter')
  const out: RowCompare = { column, op }
  if (op === 'isBlank' || op === 'notBlank') return out
  const v = c.value
  const scalar = (x: unknown) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean'
  if (op === 'in') {
    if (!Array.isArray(v) || v.length === 0 || v.length > 1000 || !v.every((x) => typeof x === 'string' || typeof x === 'number')) throw invalid(`${where}: "in" needs a non-empty list of values.`, 'rowFilter')
    out.value = v as Array<string | number>
  } else {
    if (!scalar(v) || (typeof v === 'string' && v === '' && op !== 'eq' && op !== 'ne')) throw invalid(`${where}: a value is required for "${op}".`, 'rowFilter')
    out.value = v as string | number | boolean
  }
  return out
}

function checkRowFilter(table: TableDef, raw: unknown, tables: TableDef[], sqlConnections: Set<string>): RowCondition[] {
  if (!Array.isArray(raw)) throw invalid(`Row filter of "${table.displayName}" must be a list.`, 'rowFilter')
  const counter = { n: 0 }
  const list = raw.map((c, i) => sanitizeRule(c, `Row filter ${i + 1} of "${table.displayName}"`, counter))
  const conn = (t: TableDef) => t.connectionId || DEFAULT_CONNECTION_ID
  const problems = ruleProblems(table, list, tables, (a, b) => conn(a) === conn(b) && sqlConnections.has(conn(a)))
  if (problems.length) throw invalid(`Row filter of "${table.displayName}": ${problems[0]}`, 'rowFilter')
  return list
}

function checkPrivileges(tables: TableDef[], raw: unknown, sqlConnections: Set<string> = new Set([DEFAULT_CONNECTION_ID])): TablePrivilege[] {
  if (!Array.isArray(raw)) throw invalid('"privileges" must be a list.', 'privileges')
  const byId = new Map(tables.map((t) => [t.id, t]))
  const seen = new Set<string>()
  return raw.map((p) => {
    if (!isObj(p) || typeof p.table !== 'string') throw invalid('A privilege entry is malformed.', 'privileges')
    const t = byId.get(p.table)
    if (!t) throw notFound(`Table "${p.table}" was not found.`)
    if (seen.has(t.id)) throw invalid(`Table "${t.displayName}" appears twice in the privileges.`, 'privileges')
    seen.add(t.id)
    for (const op of ['read', 'update', 'delete'] as const) {
      if (!SCOPES.includes(p[op] as AccessScope)) throw invalid(`"${op}" on "${t.displayName}" must be one of ${SCOPES.join(', ')}.`, 'privileges')
    }
    if (p.share !== undefined && p.share !== null && !SCOPES.includes(p.share as AccessScope)) throw invalid(`"share" on "${t.displayName}" must be one of ${SCOPES.join(', ')}.`, 'privileges')
    const out: TablePrivilege = { table: t.id, create: p.create === true, read: p.read as AccessScope, update: p.update as AccessScope, delete: p.delete as AccessScope }
    if (p.share && p.share !== 'none') out.share = p.share as AccessScope
    if (p.columns !== undefined && p.columns !== null) {
      if (!isObj(p.columns)) throw invalid(`Column access of "${t.displayName}" must be an object.`, 'columns')
      const cols: Record<string, ColumnAccess> = {}
      for (const [name, acc] of Object.entries(p.columns)) {
        if (!t.columns.some((c) => c.name === name)) throw invalid(`Column access: "${name}" is not a column of "${t.displayName}".`, 'columns')
        if (!ACCESS.includes(acc as ColumnAccess)) throw invalid(`Column access of "${name}" must be none, read or update.`, 'columns')
        if (name === 'id' && acc === 'none') throw invalid('The Id column cannot be hidden.', 'columns')
        if (acc !== 'update') cols[name] = acc as ColumnAccess
      }
      if (Object.keys(cols).length) out.columns = cols
    }
    if (p.rowFilter !== undefined && p.rowFilter !== null) {
      const rf = checkRowFilter(t, p.rowFilter, tables, sqlConnections)
      if (rf.length) out.rowFilter = rf
    }
    return out
  })
}

/** connections whose tables may be joined by relationship rules (SQL connectors) */
export async function sqlConnectionIds(s: Services): Promise<Set<string>> {
  const out = new Set<string>([DEFAULT_CONNECTION_ID])
  for (const c of await s.meta.connections.list().catch(() => [])) if (c.connector === 'postgres' || c.connector === 'mysql') out.add(c.id)
  return out
}

async function checkApps(s: Services, raw: unknown): Promise<string[] | 'all'> {
  if (raw === 'all') return 'all'
  if (!Array.isArray(raw)) throw invalid('"apps" must be "all" or a list of app ids.', 'apps')
  const known = new Set((await s.meta.apps.list()).map((a) => a.id))
  for (const a of raw) if (typeof a !== 'string' || !known.has(a)) throw notFound(`App "${String(a)}" was not found.`)
  return [...new Set(raw as string[])]
}

/** at least one active user must keep an administrator role */
export function assertAdminRemains(users: UserDef[], roles: RoleDef[]): void {
  const admin = new Set(roles.filter((r) => r.isAdmin).map((r) => r.id))
  if (!users.some((u) => u.status !== 'disabled' && u.roleIds.some((id) => admin.has(id)))) {
    throw conflict('At least one active user must keep an administrator role.')
  }
}

/**
 * User accounts are install-wide: creating, deleting, renaming, disabling them, setting their password and the
 * install-administrator flag need an install administrator. Roles are per environment: assigning them needs an
 * administrator of the current environment (the route's auth level).
 */
function requireInstallAdmin(ctx: Ctx, what: string): void {
  if (!ctx.user?.privileges.isInstallAdmin) throw new HttpError(403, 'denied', `Only install administrators can ${what}. Environment administrators assign roles.`)
}

/** at least one active install administrator must remain (users after the change) */
export function assertInstallAdminRemains(users: UserDef[]): void {
  if (!users.some((u) => u.isInstallAdmin && u.status !== 'disabled')) throw conflict('At least one active user must remain an install administrator.')
}

async function installAuditOf(s: Services, ctx: Ctx, action: string, details: unknown): Promise<void> {
  const install = (s as Services & { install?: { audit(e: { userId: string | null; action: string; environmentId?: string | null; details?: unknown }): Promise<void> } }).install
  if (!s.environments || !install) return
  try {
    await install.audit({ userId: ctx.user?.user.id ?? null, action, environmentId: null, details })
  } catch {
    /* the environment audit has the change too */
  }
}

/** field-by-field before/after of a role for the audit log (privileges per table; only what changed) */
export function roleDiff(before: RoleX | null, after: RoleX | null): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {}
  const b = (before ?? {}) as Partial<RoleX>
  const a = (after ?? {}) as Partial<RoleX>
  for (const k of ['name', 'description', 'isAdmin', 'isMaker', 'apps'] as const) {
    const x = k === 'isAdmin' || k === 'isMaker' ? !!b[k] : (b[k] ?? null)
    const y = k === 'isAdmin' || k === 'isMaker' ? !!a[k] : (a[k] ?? null)
    if (JSON.stringify(x) !== JSON.stringify(y)) out[k] = { before: x, after: y }
  }
  const pb = new Map((b.privileges ?? []).map((p) => [p.table, p]))
  const pa = new Map((a.privileges ?? []).map((p) => [p.table, p]))
  for (const t of new Set([...pb.keys(), ...pa.keys()])) {
    const x = pb.get(t) ?? null
    const y = pa.get(t) ?? null
    if (JSON.stringify(x) !== JSON.stringify(y)) out[`privileges.${t}`] = { before: x, after: y }
  }
  return out
}

/** before/after of the audited user fields (never the password hash) */
function userDiff(before: UserRecord, after: UserRecord): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {}
  for (const k of ['name', 'email', 'status', 'roleIds', 'isInstallAdmin'] as const) {
    const x = k === 'status' ? (before.status ?? 'active') : k === 'isInstallAdmin' ? !!before[k] : before[k]
    const y = k === 'status' ? (after.status ?? 'active') : k === 'isInstallAdmin' ? !!after[k] : after[k]
    if (JSON.stringify(x) !== JSON.stringify(y)) out[k] = { before: x, after: y }
  }
  return out
}

const publicUser = (u: UserRecord): UserDef => {
  const { passwordHash, ...rest } = u
  return { ...rest, status: u.status ?? 'active', hasPassword: !!passwordHash }
}

/* ------------------------------------------------------------------ routes */

export function registerSecurityRoutes(router: Router, s: Services): void {
  /* roles */
  router.add('POST', '/api/v1/roles', async (ctx) => {
    const b = bodyObj(ctx)
    const name = reqString(b, 'name', 'A role needs a name.', 100)
    const roles = (await s.meta.roles.list()) as RoleX[]
    if (roles.some((r) => r.name.toLowerCase() === name.toLowerCase())) throw conflict(`A role named "${name}" already exists.`)
    const tables = await s.meta.tables.list()
    const isAdmin = b.isAdmin === true
    const given = b.privileges === undefined || isAdmin ? [] : checkPrivileges(tables, b.privileges, await sqlConnectionIds(s))
    const givenIds = new Set(given.map((p) => p.table))
    const privileges = isAdmin ? [] : [
      ...given,
      ...tables.filter((t) => !givenIds.has(t.id)).map((t) => ({ table: t.id, create: false, read: 'none' as const, update: 'none' as const, delete: 'none' as const })),
    ]
    const role: RoleX = {
      id: s.uid('role'), name, privileges, apps: b.apps === undefined ? [] : await checkApps(s, b.apps),
    }
    const description = optString(b, 'description', { max: 500 })
    if (description) role.description = description
    if (isAdmin) role.isAdmin = true
    if (b.isMaker === true) role.isMaker = true
    await s.meta.roles.upsert(role)
    s.security.invalidate()
    await audit(s, ctx, 'role.create', { id: role.id, name, isAdmin, isMaker: !!role.isMaker, changes: roleDiff(null, role) })
    return role
  }, { auth: 'admin' })

  router.add('PATCH', '/api/v1/roles/:id', async (ctx) => {
    const role = (await s.meta.roles.get(ctx.params.id)) as RoleX | null
    if (!role) throw notFound('Role not found.')
    const b = bodyObj(ctx)
    const next: RoleX = { ...role }
    if (b.name !== undefined) {
      const name = reqString(b, 'name', 'A role needs a name.', 100)
      if ((await s.meta.roles.list()).some((r) => r.id !== role.id && r.name.toLowerCase() === name.toLowerCase())) throw conflict(`A role named "${name}" already exists.`)
      next.name = name
    }
    if (b.description !== undefined) {
      const d = optString(b, 'description', { max: 500 })
      if (d) next.description = d
      else delete next.description
    }
    if (b.isAdmin !== undefined) {
      if (b.isAdmin) next.isAdmin = true
      else delete next.isAdmin
    }
    if (b.isMaker !== undefined) {
      if (b.isMaker) next.isMaker = true
      else delete next.isMaker
    }
    if (b.privileges !== undefined) next.privileges = checkPrivileges(await s.meta.tables.list(), b.privileges, await sqlConnectionIds(s))
    if (next.isAdmin) next.privileges = []
    if (b.apps !== undefined) next.apps = await checkApps(s, b.apps)
    const roles = ((await s.meta.roles.list()) as RoleX[]).map((r) => (r.id === role.id ? next : r))
    assertAdminRemains(await s.meta.users.list(), roles)
    await s.meta.roles.upsert(next)
    s.security.invalidate()
    await audit(s, ctx, 'role.update', { id: role.id, name: next.name, isAdmin: !!next.isAdmin, isMaker: !!next.isMaker, privilegesChanged: b.privileges !== undefined, changes: roleDiff(role, next) })
    return next
  }, { auth: 'admin' })

  router.add('DELETE', '/api/v1/roles/:id', async (ctx) => {
    const role = await s.meta.roles.get(ctx.params.id)
    if (!role) throw notFound('Role not found.')
    const roles = (await s.meta.roles.list()).filter((r) => r.id !== role.id)
    const users = (await s.meta.users.list()).map((u) => (u.roleIds.includes(role.id) ? { ...u, roleIds: u.roleIds.filter((x) => x !== role.id) } : u))
    if (role.isAdmin) assertAdminRemains(users, roles)
    for (const u of await s.meta.users.list()) if (u.roleIds.includes(role.id)) await s.meta.users.update(u.id, { roleIds: u.roleIds.filter((x) => x !== role.id) })
    const now = s.now()
    for (const sol of await s.meta.solutions.list()) {
      if (sol.components.some((c) => c.kind === 'role' && c.id === role.id)) {
        await s.meta.solutions.upsert({ ...sol, components: sol.components.filter((c) => !(c.kind === 'role' && c.id === role.id)), modifiedOn: now })
      }
    }
    await s.meta.roles.remove(role.id)
    s.security.invalidate()
    await audit(s, ctx, 'role.delete', { id: role.id, name: role.name, changes: roleDiff(role as RoleX, null) })
    return { ok: true }
  }, { auth: 'admin' })

  /* users */
  const readUserBody = async (b: Record<string, unknown>, existing?: UserRecord) => {
    const out: { name?: string; email?: string; roleIds?: string[]; status?: 'active' | 'disabled'; isInstallAdmin?: boolean } = {}
    if (!existing || b.name !== undefined) out.name = reqString(b, 'name', 'A user needs a name.', 100)
    if (!existing || b.email !== undefined) {
      const email = reqString(b, 'email', 'A user needs an email address.', 190).toLowerCase()
      if (!EMAIL.test(email)) throw invalid(`"${email}" is not a valid email address.`, 'email')
      const other = await s.meta.users.byEmail(email)
      if (other && other.id !== existing?.id) throw conflict(`A user with the email ${email} already exists.`)
      out.email = email
    }
    if (b.roleIds !== undefined || !existing) {
      const ids = b.roleIds === undefined ? [] : b.roleIds
      if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) throw invalid('"roleIds" must be a list of role ids.', 'roleIds')
      const known = new Set((await s.meta.roles.list()).map((r) => r.id))
      for (const r of ids as string[]) if (!known.has(r)) throw notFound(`Role "${r}" was not found.`)
      out.roleIds = [...new Set(ids as string[])]
    }
    if (b.status !== undefined) {
      if (b.status !== 'active' && b.status !== 'disabled') throw invalid('Status must be active or disabled.', 'status')
      out.status = b.status
    }
    if (b.isInstallAdmin !== undefined) {
      if (typeof b.isInstallAdmin !== 'boolean') throw invalid('isInstallAdmin must be true or false.', 'isInstallAdmin')
      out.isInstallAdmin = b.isInstallAdmin
    }
    return out
  }
  const touched = () => {
    s.security.invalidate()
    s.environments?.invalidate()
  }

  router.add('POST', '/api/v1/users', async (ctx) => {
    requireInstallAdmin(ctx, 'create user accounts')
    const b = bodyObj(ctx)
    const f = await readUserBody(b)
    // roles are those of the current environment: a new user with roles may enter it (MetaStore adds the access)
    const rec: UserRecord = {
      id: s.uid('user'), name: f.name!, email: f.email!, roleIds: f.roleIds ?? [], status: f.status ?? 'active', passwordHash: null,
      ...(f.isInstallAdmin ? { isInstallAdmin: true } : {}),
    }
    if (b.password !== undefined) {
      rec.passwordHash = await hashPassword(checkPasswordPolicy(b.password, rec.email))
      // a password chosen by an administrator is temporary: the user must replace it at the first sign-in
      rec.mustChangePassword = true
    }
    const org = await readOrgFields(s, b, null)
    if (Object.keys(org).length) requireInstallAdmin(ctx, 'change the organisation of users')
    await s.meta.users.insert(rec)
    await saveOrgFields(s, rec.id, org)
    touched()
    await audit(s, ctx, 'user.create', { id: rec.id, email: rec.email, name: rec.name, roleIds: rec.roleIds, status: rec.status, passwordSet: !!rec.passwordHash })
    await installAuditOf(s, ctx, 'install.user_create', { id: rec.id, email: rec.email, environment: ctx.environmentId, isInstallAdmin: !!rec.isInstallAdmin })
    return publicUser(rec)
  }, { auth: 'admin' })

  router.add('PATCH', '/api/v1/users/:id', async (ctx) => {
    const user = await s.meta.users.get(ctx.params.id)
    if (!user) throw notFound('User not found.')
    const body = bodyObj(ctx)
    const f = await readUserBody(body, user)
    const org = await readOrgFields(s, body, user.id)
    if (Object.keys(org).length) requireInstallAdmin(ctx, 'change the organisation of users')
    const next: UserRecord = { ...user, ...f }
    const self = ctx.user?.user.id === user.id
    const account = (['name', 'email', 'status', 'isInstallAdmin'] as const).some((k) => f[k] !== undefined && (k === 'isInstallAdmin' ? !!f[k] !== !!user[k] : f[k] !== (k === 'status' ? (user.status ?? 'active') : user[k])))
    if (account) requireInstallAdmin(ctx, 'change user accounts')
    if (self && next.status === 'disabled') throw conflict('You cannot disable your own account.')
    if (self && user.isInstallAdmin && f.isInstallAdmin === false) throw conflict('You cannot remove your own install administrator flag; ask another install administrator.')
    const roles = await s.meta.roles.list()
    const users = (await s.meta.users.list()).map((u) => (u.id === user.id ? next : u))
    assertAdminRemains(users, roles)
    if (s.environments && (user.isInstallAdmin || f.isInstallAdmin)) assertInstallAdminRemains(users)
    await s.meta.users.update(user.id, f)
    await saveOrgFields(s, user.id, org)
    if (next.status === 'disabled' && user.status !== 'disabled') await s.meta.sessions.removeForUser(user.id)
    touched()
    const changes = userDiff(user, next)
    for (const [k, v] of Object.entries(org)) {
      const before = (user as unknown as Record<string, unknown>)[k] ?? null
      if (before !== v) changes[k] = { before, after: v }
    }
    await audit(s, ctx, 'user.update', { id: user.id, email: next.email, roleIds: next.roleIds, status: next.status, changes })
    if (changes.status) await audit(s, ctx, next.status === 'disabled' ? 'user.disable' : 'user.enable', { id: user.id, email: next.email })
    if (changes.roleIds) await audit(s, ctx, 'user.roles', { id: user.id, email: next.email, before: changes.roleIds.before, after: changes.roleIds.after })
    if (changes.isInstallAdmin) await installAuditOf(s, ctx, next.isInstallAdmin ? 'install.admin_grant' : 'install.admin_revoke', { id: user.id, email: next.email })
    if (changes.status) await installAuditOf(s, ctx, next.status === 'disabled' ? 'install.user_disable' : 'install.user_enable', { id: user.id, email: next.email })
    return publicUser({ ...next, ...Object.fromEntries(Object.entries(org).map(([k, v]) => [k, v ?? undefined])) })
  }, { auth: 'admin' })

  router.add('DELETE', '/api/v1/users/:id', async (ctx) => {
    const user = await s.meta.users.get(ctx.params.id)
    if (!user) throw notFound('User not found.')
    requireInstallAdmin(ctx, 'delete user accounts')
    if (ctx.user?.user.id === user.id) throw conflict('You cannot delete your own account.')
    const rest = (await s.meta.users.list()).filter((u) => u.id !== user.id)
    assertAdminRemains(rest, await s.meta.roles.list())
    if (s.environments && user.isInstallAdmin) assertInstallAdminRemains(rest)
    await s.meta.sessions.removeForUser(user.id)
    await s.meta.users.remove(user.id)
    // reports lose their manager, team memberships and shares to the user go (every environment)
    await s.meta.org?.userRemoved(user.id)
    s.security.invalidateOrg?.()
    s.security.invalidate('all')
    s.environments?.invalidate()
    await audit(s, ctx, 'user.delete', { id: user.id, email: user.email, roleIds: user.roleIds, status: user.status ?? 'active' })
    await installAuditOf(s, ctx, 'install.user_delete', { id: user.id, email: user.email })
    return { ok: true }
  }, { auth: 'admin' })

  router.add('POST', '/api/v1/users/:id/password', async (ctx) => {
    const user = await s.meta.users.get(ctx.params.id)
    if (!user) throw notFound('User not found.')
    const self = ctx.user?.user.id === user.id
    if (!self) requireInstallAdmin(ctx, "set other people's passwords")
    const password = checkPasswordPolicy(bodyObj(ctx).password, user.email)
    // set by an administrator for someone else: temporary, the user must change it at the next sign-in
    await s.meta.users.update(user.id, { passwordHash: await hashPassword(password), mustChangePassword: !self })
    if (!self) await s.meta.sessions.removeForUser(user.id)
    await audit(s, ctx, 'user.password', { id: user.id, email: user.email, reset: !self, mustChangePassword: !self })
    return { ok: true }
  }, { auth: 'admin' })

  /* security preview: what a user would see, per table, computed with the real engine */
  router.add('GET', '/api/v1/security/preview', async (ctx) => {
    const id = ctx.query.get('user')
    if (!id) throw invalid('Choose a user to preview.', 'user')
    const rec = await s.meta.users.get(id)
    if (!rec) throw notFound('User not found.')
    const user = publicUser(rec)
    const uc: UserContext = await s.security.forUser(user)
    const tables: SecurityPreviewTable[] = []
    for (const t of await s.meta.tables.list()) {
      const eff = uc.privileges.tables[t.id]
      const visible = uc.visibleDef(t)
      const visibleNames = new Set(visible.columns.map((c) => c.name))
      const entry: SecurityPreviewTable = {
        table: t.id, name: t.name, displayName: t.displayName,
        create: uc.canCreate(t), read: eff?.read ?? (uc.privileges.isAdmin ? 'all' : 'none'),
        update: eff?.update ?? (uc.privileges.isAdmin ? 'all' : 'none'), delete: eff?.delete ?? (uc.privileges.isAdmin ? 'all' : 'none'),
        filtered: eff?.filtered ?? false,
        hiddenColumns: t.columns.filter((c) => !visibleNames.has(c.name)).map((c) => c.name),
        readOnlyColumns: visible.columns.filter((c) => !c.system && uc.columnAccess(t, c.name) === 'read').map((c) => c.name),
        rowCount: 0, truncated: false,
        why: (uc.reasons?.(t, 'read') ?? []).map((r) => reasonText(r, false)),
      }
      if (entry.read !== 'none') {
        try {
          const r = await s.data.query(uc, t, { select: ['id'], count: true, top: 1 })
          entry.rowCount = r.total ?? r.rows.length
          entry.truncated = r.total === undefined && r.truncated
        } catch (e) {
          entry.rowCount = null
          entry.error = e instanceof HttpError ? e.message : 'The rows could not be counted.'
        }
      }
      tables.push(entry)
    }
    const items = tables.map((t) => ({ tableId: t.table, visibleRows: t.rowCount, hiddenColumns: t.hiddenColumns, readOnlyColumns: t.readOnlyColumns, why: t.why }))
    return { user, isAdmin: uc.privileges.isAdmin, isMaker: uc.privileges.isMaker, status: user.status ?? 'active', items, tables }
  }, { auth: 'admin' })
}

/** GET /api/v1/security/preview?user= -> { user, isAdmin, isMaker, status, items: [{ tableId, visibleRows, hiddenColumns, readOnlyColumns }], tables: SecurityPreviewTable[] (richer) } */
export interface SecurityPreviewTable {
  table: string
  name: string
  displayName: string
  create: boolean
  read: AccessScope
  update: AccessScope
  delete: AccessScope
  /** a role grants this table only through a row filter (the count already reflects it) */
  filtered: boolean
  hiddenColumns: string[]
  readOnlyColumns: string[]
  /** rows the user can read; null when counting failed (see error) */
  rowCount: number | null
  truncated: boolean
  error?: string
  /** why rows are readable: one line per granting role (scope, rule), shares */
  why: string[]
}

export { grantDefaults }
