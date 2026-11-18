/**
 * SecurityEngine: RBAC + RLS + CLS (docs/internal/specs/SPEC3.md section 5). Pure computation over roles and tables;
 * the engine caches roles/tables per environment between requests (invalidate() after any role/user/table change).
 */
import type { MetaStore, SecurityEngine, UserContext } from './contracts.ts'
import { currentEnvironment } from './env-context.ts'
import type {
  AccessScope, ColumnAccess, EffectivePrivileges, RoleDef, RowCondition, TableDef, TablePrivilege, UserDef,
} from '../../src/platform/contracts.ts'
import type { Condition, QueryValue } from '../../src/platform/http.ts'

export const SYSTEM_COLUMN_NAMES = new Set(['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner'])
export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

const SCOPE_RANK: Record<AccessScope, number> = { none: 0, own: 1, all: 2 }
const ACCESS_RANK: Record<ColumnAccess, number> = { none: 0, read: 1, update: 2 }
const maxScope = (a: AccessScope, b: AccessScope): AccessScope => (SCOPE_RANK[b] > SCOPE_RANK[a] ? b : a)
const maxAccess = (a: ColumnAccess, b: ColumnAccess): ColumnAccess => (ACCESS_RANK[b] > ACCESS_RANK[a] ? b : a)
const isMakerRole = (r: RoleDef): boolean => !!(r as RoleDef & { isMaker?: boolean }).isMaker

const TRUE: Condition = { const: true }
const FALSE: Condition = { const: false }

function resolveToken(v: unknown, user: UserDef): QueryValue {
  if (v === '@me') return user.id
  if (v === '@myEmail') return user.email
  if (v === undefined) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) return v
  return String(v)
}

/** RowCondition list -> Condition (ANDed); null when it references a column the table does not have */
export function rowFilterCondition(filter: RowCondition[] | undefined, table: TableDef, user: UserDef): Condition | null {
  if (!filter || !filter.length) return TRUE
  const missing = new Set(table.missingSystem ?? [])
  const names = new Set([...table.columns.map((c) => c.name), ...SYSTEM_COLUMN_NAMES].filter((n) => !missing.has(n)))
  const parts: Condition[] = []
  for (const f of filter) {
    if (!f || typeof f.column !== 'string' || !names.has(f.column)) return null
    const op = f.op
    if (op === 'isBlank' || op === 'notBlank') {
      parts.push({ col: f.column, op })
      continue
    }
    if (op === 'in') {
      const list = Array.isArray(f.value) ? f.value : f.value === undefined ? [] : [f.value]
      parts.push({ col: f.column, op: 'in', value: list.map((x) => resolveToken(x, user)) })
      continue
    }
    const allowed = ['eq', 'ne', 'contains', 'startsWith', 'lt', 'le', 'gt', 'ge']
    if (!allowed.includes(op)) return null
    parts.push({ col: f.column, op, value: resolveToken(Array.isArray(f.value) ? f.value[0] : f.value, user) })
  }
  return parts.length === 1 ? parts[0] : { and: parts }
}

function simplifyAnd(a: Condition, b: Condition): Condition {
  if ('const' in a) return a.const ? b : FALSE
  if ('const' in b) return b.const ? a : FALSE
  return { and: [a, b] }
}

/**
 * Builds the per-request security context for a user from the roles and tables of one environment. Environment
 * administrator = an administrator role there; an install administrator is one in every environment.
 */
export function buildUserContext(user: UserDef, allRoles: RoleDef[], tables: TableDef[], expiresOn?: Date, environmentId: string = currentEnvironment().id): UserContext {
  const roles = allRoles.filter((r) => user.roleIds.includes(r.id))
  const isInstallAdmin = !!user.isInstallAdmin
  const isAdmin = isInstallAdmin || roles.some((r) => r.isAdmin)
  const isMaker = isAdmin || roles.some(isMakerRole)

  const privFor = (r: RoleDef, table: TableDef): TablePrivilege | undefined => r.privileges.find((p) => p.table === table.id)

  function scopeOf(table: TableDef, op: 'read' | 'update' | 'delete'): AccessScope {
    if (isAdmin) return 'all'
    let s: AccessScope = 'none'
    for (const r of roles) {
      const p = privFor(r, table)
      if (p) s = maxScope(s, p[op] ?? 'none')
    }
    return s
  }

  function canCreate(table: TableDef): boolean {
    if (isAdmin) return true
    return roles.some((r) => !!privFor(r, table)?.create)
  }

  /**
   * read/update/delete: OR over granting roles of (scope AND rowFilter).
   * create (WITH CHECK for new rows): OR over roles with create of their rowFilter; no owner term, because a new row
   * is always owned by its creator.
   */
  function rowPredicate(table: TableDef, op: 'read' | 'update' | 'delete' | 'create'): Condition {
    if (isAdmin) return TRUE
    const terms: Condition[] = []
    for (const r of roles) {
      const p = privFor(r, table)
      const s: AccessScope = op === 'create' ? (p?.create ? 'all' : 'none') : (p?.[op] ?? 'none')
      if (!p || s === 'none') continue
      const filter = rowFilterCondition(p.rowFilter, table, user)
      if (filter === null) continue // filter on a missing column: this role grants nothing
      if (s === 'own' && (table.missingSystem ?? []).includes('owner')) continue // no owner column: no row is anyone's own
      const base: Condition = s === 'all' ? TRUE : { col: 'owner', op: 'eq', value: user.id }
      const term = simplifyAnd(base, filter)
      if ('const' in term && term.const) return TRUE
      if ('const' in term) continue
      terms.push(term)
    }
    if (!terms.length) return FALSE
    return terms.length === 1 ? terms[0] : { or: terms }
  }

  /** roles whose read scope on the table is not none (CLS is the union over these) */
  function grantingRoles(table: TableDef): { role: RoleDef; priv: TablePrivilege }[] {
    const out: { role: RoleDef; priv: TablePrivilege }[] = []
    for (const r of roles) {
      const p = privFor(r, table)
      if (p && p.read !== 'none') out.push({ role: r, priv: p })
    }
    if (out.length) return out
    // no read grant: a create-only role still decides which columns may be written
    for (const r of roles) {
      const p = privFor(r, table)
      if (p && (p.create || p.update !== 'none')) out.push({ role: r, priv: p })
    }
    return out
  }

  function columnAccess(table: TableDef, column: string): ColumnAccess {
    if (column === 'id') return 'read'
    const isSystem = SYSTEM_COLUMN_NAMES.has(column) || !!table.columns.find((c) => c.name === column)?.system
    if (isAdmin) return isSystem ? 'read' : 'update'
    let access: ColumnAccess = 'none'
    for (const { priv } of grantingRoles(table)) {
      access = maxAccess(access, priv.columns?.[column] ?? 'update')
      if (access === 'update') break
    }
    if (isSystem && access === 'update') return 'read'
    return access
  }

  function visibleDef(table: TableDef): TableDef {
    if (isAdmin) return table
    const columns = table.columns.filter((c) => columnAccess(table, c.name) !== 'none')
    const out: TableDef = { ...table, columns }
    if (!columns.some((c) => c.name === table.primaryColumn)) out.primaryColumn = columns.find((c) => !c.system)?.name ?? 'id'
    return out
  }

  let appsAllowed: string[] | 'all' = []
  if (isAdmin || roles.some((r) => r.apps === 'all')) appsAllowed = 'all'
  else appsAllowed = [...new Set(roles.flatMap((r) => (Array.isArray(r.apps) ? r.apps : [])))]

  const privileges: EffectivePrivileges = { isAdmin, isMaker, tables: {}, apps: appsAllowed }
  if (isInstallAdmin) privileges.isInstallAdmin = true
  for (const t of tables) {
    const columns: Record<string, ColumnAccess> = {}
    for (const c of t.columns) {
      const a = columnAccess(t, c.name)
      if (a !== 'update') columns[c.name] = a
    }
    const filtered = !isAdmin && roles.some((r) => {
      const p = privFor(r, t)
      return !!p && p.read !== 'none' && !!p.rowFilter?.length
    })
    privileges.tables[t.id] = {
      create: canCreate(t),
      read: scopeOf(t, 'read'),
      update: scopeOf(t, 'update'),
      delete: scopeOf(t, 'delete'),
      columns,
      filtered,
    }
  }

  const expires = expiresOn ?? new Date(Date.now() + SESSION_LIFETIME_MS)
  return {
    environmentId,
    user,
    roles,
    privileges,
    rowPredicate,
    canCreate,
    columnAccess,
    visibleDef,
    canRunApp: (appId: string) => appsAllowed === 'all' || appsAllowed.includes(appId),
    session: () => ({ user, privileges, expiresOn: expires.toISOString(), environmentId }),
  }
}

/** true when the user may read anything from the table or create in it (decides /workspace visibility) */
export function hasAnyTableAccess(ctx: UserContext, table: TableDef): boolean {
  const p = ctx.privileges.tables[table.id]
  if (ctx.privileges.isAdmin) return true
  return !!p && (p.read !== 'none' || p.create || p.update !== 'none' || p.delete !== 'none')
}

/**
 * Engine with a short-lived cache of roles and tables. forUser(user, expiresOn?) accepts an optional session
 * expiry (the router passes it so session() reports the real expiry).
 */
export function createSecurityEngine(getMeta: () => MetaStore, ttlMs = 5000): SecurityEngine & {
  forUser(user: UserDef, expiresOn?: Date): Promise<UserContext>
} {
  /** per environment id (roles and tables are environment objects) */
  interface Slot { cache: { roles: RoleDef[]; tables: TableDef[]; at: number } | null; loading: Promise<{ roles: RoleDef[]; tables: TableDef[] }> | null; generation: number }
  const slots = new Map<string, Slot>()
  const slot = (id: string): Slot => {
    let s = slots.get(id)
    if (!s) slots.set(id, (s = { cache: null, loading: null, generation: 0 }))
    return s
  }

  async function load(): Promise<{ roles: RoleDef[]; tables: TableDef[] }> {
    const s = slot(currentEnvironment().id)
    if (s.cache && Date.now() - s.cache.at < ttlMs) return s.cache
    if (s.loading) return s.loading
    const gen = s.generation
    const meta = getMeta()
    const p = Promise.all([meta.roles.list(), meta.tables.list()])
      .then(([roles, tables]) => {
        if (gen === s.generation) s.cache = { roles, tables, at: Date.now() }
        return { roles, tables }
      })
      .finally(() => {
        if (s.loading === p) s.loading = null
      })
    s.loading = p
    return p
  }

  return {
    async forUser(user: UserDef, expiresOn?: Date) {
      const { roles, tables } = await load()
      return buildUserContext(user, roles, tables, expiresOn, currentEnvironment().id)
    },
    invalidate(scope?: 'all' | { environment: string }) {
      if (scope && scope !== 'all') {
        slots.delete(scope.environment)
        return
      }
      const list = scope === 'all' ? [...slots.values()] : [slot(currentEnvironment().id)]
      for (const s of list) {
        s.generation++
        s.cache = null
        s.loading = null
      }
    },
  }
}
