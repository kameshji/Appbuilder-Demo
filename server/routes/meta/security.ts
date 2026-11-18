/**
 * Roles (with CLS columns and RLS rowFilter), users (password, disable, last-admin guard) and the
 * admin-only security preview. Every change is audited (never with passwords) and invalidates the security cache.
 */
import type { AccessScope, ColumnAccess, RoleDef, RowCondition, TableDef, TablePrivilege, UserDef } from '../../../src/platform/contracts.ts'
import { HttpError } from '../../core/contracts.ts'
import type { Router, Services, UserContext } from '../../core/contracts.ts'
import { checkPasswordPolicy, hashPassword } from '../../core/password.ts'
import type { UserRecord } from '../../core/contracts.ts'
import { bodyObj, conflict, invalid, isObj, notFound, optString, reqString } from './util.ts'
import type { RoleX } from './util.ts'
import { audit, grantDefaults } from './tables-core.ts'

const SCOPES: AccessScope[] = ['none', 'own', 'all']
const ACCESS: ColumnAccess[] = ['none', 'read', 'update']
const FILTER_OPS: RowCondition['op'][] = ['eq', 'ne', 'in', 'contains', 'startsWith', 'lt', 'le', 'gt', 'ge', 'isBlank', 'notBlank']
const TOKENS = new Set(['@me', '@myEmail'])
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/* ------------------------------------------------------------------ validation */

function checkRowFilter(table: TableDef, raw: unknown): RowCondition[] {
  if (!Array.isArray(raw)) throw invalid(`Row filter of "${table.displayName}" must be a list.`, 'rowFilter')
  return raw.map((c, i) => {
    const where = `Row filter ${i + 1} of "${table.displayName}"`
    if (!isObj(c)) throw invalid(`${where} is malformed.`, 'rowFilter')
    const column = typeof c.column === 'string' ? c.column : ''
    if (!table.columns.some((x) => x.name === column)) throw invalid(`${where}: the column "${column}" does not exist in "${table.displayName}".`, 'rowFilter')
    const op = c.op as RowCondition['op']
    if (!FILTER_OPS.includes(op)) throw invalid(`${where}: unknown operator "${String(c.op)}".`, 'rowFilter')
    const out: RowCondition = { column, op }
    if (op === 'isBlank' || op === 'notBlank') return out
    const v = c.value
    const scalar = (x: unknown) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean'
    const checkTok = (x: unknown) => {
      if (typeof x === 'string' && /^@(me|myemail)$/i.test(x) && !TOKENS.has(x)) throw invalid(`${where}: use exactly "@me" or "@myEmail" for the current user.`, 'rowFilter')
    }
    if (op === 'in') {
      if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string' || typeof x === 'number')) throw invalid(`${where}: "in" needs a non-empty list of values.`, 'rowFilter')
      v.forEach(checkTok)
      out.value = v as Array<string | number>
    } else {
      if (!scalar(v) || (typeof v === 'string' && v === '' && op !== 'eq' && op !== 'ne')) throw invalid(`${where}: a value is required for "${op}".`, 'rowFilter')
      checkTok(v)
      out.value = v as string | number | boolean
    }
    return out
  })
}

function checkPrivileges(tables: TableDef[], raw: unknown): TablePrivilege[] {
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
      if (!SCOPES.includes(p[op] as AccessScope)) throw invalid(`"${op}" on "${t.displayName}" must be none, own or all.`, 'privileges')
    }
    const out: TablePrivilege = { table: t.id, create: p.create === true, read: p.read as AccessScope, update: p.update as AccessScope, delete: p.delete as AccessScope }
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
      const rf = checkRowFilter(t, p.rowFilter)
      if (rf.length) out.rowFilter = rf
    }
    return out
  })
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
  for (const k of ['name', 'email', 'status', 'roleIds'] as const) {
    const x = k === 'status' ? (before.status ?? 'active') : before[k]
    const y = k === 'status' ? (after.status ?? 'active') : after[k]
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
    const given = b.privileges === undefined || isAdmin ? [] : checkPrivileges(tables, b.privileges)
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
    if (b.privileges !== undefined) next.privileges = checkPrivileges(await s.meta.tables.list(), b.privileges)
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
    const out: { name?: string; email?: string; roleIds?: string[]; status?: 'active' | 'disabled' } = {}
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
    return out
  }

  router.add('POST', '/api/v1/users', async (ctx) => {
    const b = bodyObj(ctx)
    const f = await readUserBody(b)
    const rec: UserRecord = {
      id: s.uid('user'), name: f.name!, email: f.email!, roleIds: f.roleIds ?? [], status: f.status ?? 'active', passwordHash: null,
    }
    if (b.password !== undefined) {
      rec.passwordHash = await hashPassword(checkPasswordPolicy(b.password, rec.email))
      // a password chosen by an administrator is temporary: the user must replace it at the first sign-in
      rec.mustChangePassword = true
    }
    await s.meta.users.insert(rec)
    s.security.invalidate()
    await audit(s, ctx, 'user.create', { id: rec.id, email: rec.email, name: rec.name, roleIds: rec.roleIds, status: rec.status, passwordSet: !!rec.passwordHash })
    return publicUser(rec)
  }, { auth: 'admin' })

  router.add('PATCH', '/api/v1/users/:id', async (ctx) => {
    const user = await s.meta.users.get(ctx.params.id)
    if (!user) throw notFound('User not found.')
    const f = await readUserBody(bodyObj(ctx), user)
    const next: UserRecord = { ...user, ...f }
    const self = ctx.user?.user.id === user.id
    if (self && next.status === 'disabled') throw conflict('You cannot disable your own account.')
    const roles = await s.meta.roles.list()
    const users = (await s.meta.users.list()).map((u) => (u.id === user.id ? next : u))
    assertAdminRemains(users, roles)
    await s.meta.users.update(user.id, f)
    if (next.status === 'disabled' && user.status !== 'disabled') await s.meta.sessions.removeForUser(user.id)
    s.security.invalidate()
    const changes = userDiff(user, next)
    await audit(s, ctx, 'user.update', { id: user.id, email: next.email, roleIds: next.roleIds, status: next.status, changes })
    if (changes.status) await audit(s, ctx, next.status === 'disabled' ? 'user.disable' : 'user.enable', { id: user.id, email: next.email })
    if (changes.roleIds) await audit(s, ctx, 'user.roles', { id: user.id, email: next.email, before: changes.roleIds.before, after: changes.roleIds.after })
    return publicUser(next)
  }, { auth: 'admin' })

  router.add('DELETE', '/api/v1/users/:id', async (ctx) => {
    const user = await s.meta.users.get(ctx.params.id)
    if (!user) throw notFound('User not found.')
    if (ctx.user?.user.id === user.id) throw conflict('You cannot delete your own account.')
    assertAdminRemains((await s.meta.users.list()).filter((u) => u.id !== user.id), await s.meta.roles.list())
    await s.meta.sessions.removeForUser(user.id)
    await s.meta.users.remove(user.id)
    s.security.invalidate()
    await audit(s, ctx, 'user.delete', { id: user.id, email: user.email, roleIds: user.roleIds, status: user.status ?? 'active' })
    return { ok: true }
  }, { auth: 'admin' })

  router.add('POST', '/api/v1/users/:id/password', async (ctx) => {
    const user = await s.meta.users.get(ctx.params.id)
    if (!user) throw notFound('User not found.')
    const password = checkPasswordPolicy(bodyObj(ctx).password, user.email)
    const self = ctx.user?.user.id === user.id
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
    const items = tables.map((t) => ({ tableId: t.table, visibleRows: t.rowCount, hiddenColumns: t.hiddenColumns, readOnlyColumns: t.readOnlyColumns }))
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
}

export { grantDefaults }
