/**
 * SecurityEngine: RBAC + RLS + CLS (docs/internal/specs/SPEC3.md section 5). Pure computation over roles and tables;
 * the engine caches roles/tables per environment between requests (invalidate() after any role/user/table change).
 */
import type { MetaStore, SecurityEngine, UserContext } from './contracts.ts'
import { currentEnvironment } from './env-context.ts'
import type {
  AccessScope, ColumnAccess, EffectivePrivileges, RoleDef, RowCondition, TableDef, TablePrivilege, UserDef, UserOrgInfo,
} from '../../src/platform/contracts.ts'
import { ORG_SCOPES } from '../../src/platform/contracts.ts'
import type { Condition } from '../../src/platform/http.ts'
import {
  EMPTY_DIRECTORY, emptyOrgContext, filterFor, orgContextFor, predicateReasons, rowPredicateFor, userOrgInfo,
} from '../../src/platform/orgsec.ts'
import type { OrgContext, OrgDirectory, PredicateEnv, SecOp } from '../../src/platform/orgsec.ts'
import { DEFAULT_CONNECTION_ID } from './connections.ts'

export const SYSTEM_COLUMN_NAMES = new Set(['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner'])
export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

/** breadth order used for the reported (maximum) scope; the predicate itself is exact per role */
const SCOPE_RANK: Record<AccessScope, number> = { none: 0, own: 1, manager: 2, managerTree: 3, team: 4, department: 5, departmentTree: 6, all: 7 }
const ACCESS_RANK: Record<ColumnAccess, number> = { none: 0, read: 1, update: 2 }
const maxScope = (a: AccessScope, b: AccessScope): AccessScope => (SCOPE_RANK[b] > SCOPE_RANK[a] ? b : a)
const maxAccess = (a: ColumnAccess, b: ColumnAccess): ColumnAccess => (ACCESS_RANK[b] > ACCESS_RANK[a] ? b : a)
const isMakerRole = (r: RoleDef): boolean => !!(r as RoleDef & { isMaker?: boolean }).isMaker
const isOrgScope = (s: AccessScope | undefined): boolean => !!s && (ORG_SCOPES as readonly string[]).includes(s)

/** organisation, shares and store topology for one user's context (the engine fills it; tests pass what they need) */
export interface SecurityExtras {
  org?: OrgContext
  orgInfo?: UserOrgInfo
  shares?: PredicateEnv['shares']
  /** may a rule on `outer` read `inner` in the same statement? default: same connection id */
  sameStore?: PredicateEnv['sameStore']
}

const sameConnection = (a: TableDef, b: TableDef): boolean => (a.connectionId || DEFAULT_CONNECTION_ID) === (b.connectionId || DEFAULT_CONNECTION_ID)

/**
 * RowCondition list -> Condition (ANDed); null when it references a column the table does not have. Kept for callers
 * that have no organisation context (tokens of the organisation then resolve to "no value").
 */
export function rowFilterCondition(filter: RowCondition[] | undefined, table: TableDef, user: UserDef, tables: TableDef[] = [table]): Condition | null {
  return filterFor(table, filter, { user, org: emptyOrgContext(user.id), tables, sameStore: sameConnection })
}

/**
 * Builds the per-request security context for a user from the roles and tables of one environment. Environment
 * administrator = an administrator role there; an install administrator is one in every environment.
 */
export function buildUserContext(user: UserDef, allRoles: RoleDef[], tables: TableDef[], expiresOn?: Date, environmentId: string = currentEnvironment().id, extras: SecurityExtras = {}): UserContext {
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

  const env: PredicateEnv = {
    user,
    org: extras.org ?? emptyOrgContext(user.id),
    tables,
    sameStore: extras.sameStore ?? sameConnection,
    shares: extras.shares,
  }

  /**
   * read/update/delete: OR over granting roles of (scope AND rowFilter), plus rows shared with the user (read,
   * update). create (WITH CHECK for new rows): OR over roles with create of their rowFilter; no owner term, because a
   * new row is always owned by its creator. share: roles with the share privilege, plus the user's own rows.
   * The rules live in src/platform/orgsec.ts (shared with demo mode).
   */
  function rowPredicate(table: TableDef, op: SecOp): Condition {
    return rowPredicateFor(roles, table, op, env, isAdmin)
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
    // the client cannot mirror row filters, relationship rules, organisation scopes or shares: the server decides
    const filtered = !isAdmin && (roles.some((r) => {
      const p = privFor(r, t)
      return !!p && p.read !== 'none' && (!!p.rowFilter?.length || isOrgScope(p.read) || isOrgScope(p.update) || isOrgScope(p.delete))
    }) || (!!t.sharing && !!extras.shares?.read[t.id]?.length))
    privileges.tables[t.id] = {
      create: canCreate(t),
      read: scopeOf(t, 'read'),
      update: scopeOf(t, 'update'),
      delete: scopeOf(t, 'delete'),
      columns,
      filtered,
    }
    const share = isAdmin ? (t.sharing ? 'all' : 'none') : roles.reduce<AccessScope>((acc, r) => maxScope(acc, privFor(r, t)?.share ?? 'none'), 'none')
    if (share !== 'none') privileges.tables[t.id].share = share
  }

  const expires = expiresOn ?? new Date(Date.now() + SESSION_LIFETIME_MS)
  const sessionUser: UserDef = extras.orgInfo ? { ...user, org: extras.orgInfo } : user
  return {
    environmentId,
    user: sessionUser,
    roles,
    privileges,
    rowPredicate,
    reasons: (table, op) => predicateReasons(roles, table, op, env, isAdmin),
    canCreate,
    columnAccess,
    visibleDef,
    canRunApp: (appId: string) => appsAllowed === 'all' || appsAllowed.includes(appId),
    session: () => ({ user: sessionUser, privileges, expiresOn: expires.toISOString(), environmentId }),
  }
}

/** true when the user may read anything from the table or create in it (decides /workspace visibility) */
export function hasAnyTableAccess(ctx: UserContext, table: TableDef): boolean {
  const p = ctx.privileges.tables[table.id]
  if (ctx.privileges.isAdmin) return true
  return !!p && (p.read !== 'none' || p.create || p.update !== 'none' || p.delete !== 'none')
}

/**
 * Engine with short-lived caches (ttlMs, default 5 s): roles, tables and connection kinds per environment; the
 * organisation directory (install-wide); the rows shared with each user per environment. forUser(user, expiresOn?)
 * accepts an optional session expiry (the router passes it so session() reports the real expiry).
 * invalidate() drops the current environment's roles/tables and its shares; invalidate('all') also the organisation;
 * invalidateOrg() / invalidateShares() drop just those (organisation and share routes call them).
 */
export function createSecurityEngine(getMeta: () => MetaStore, ttlMs = 5000): SecurityEngine & {
  forUser(user: UserDef, expiresOn?: Date): Promise<UserContext>
  invalidateOrg(): void
  invalidateShares(environment?: string): void
  directory(): Promise<OrgDirectory>
} {
  interface Loaded { roles: RoleDef[]; tables: TableDef[]; sqlConnections: Set<string> }
  /** per environment id (roles and tables are environment objects) */
  interface Slot { cache: (Loaded & { at: number }) | null; loading: Promise<Loaded> | null; generation: number }
  const slots = new Map<string, Slot>()
  const slot = (id: string): Slot => {
    let s = slots.get(id)
    if (!s) slots.set(id, (s = { cache: null, loading: null, generation: 0 }))
    return s
  }

  async function load(): Promise<Loaded> {
    const s = slot(currentEnvironment().id)
    if (s.cache && Date.now() - s.cache.at < ttlMs) return s.cache
    if (s.loading) return s.loading
    const gen = s.generation
    const meta = getMeta()
    // one statement after the other: inside a unit of work the db may be a single transaction connection
    const p = (async () => {
      const roles = await meta.roles.list()
      const tables = await meta.tables.list()
      const connections = await Promise.resolve().then(() => meta.connections?.list() ?? []).catch(() => [])
      return [roles, tables, connections] as const
    })()
      .then(([roles, tables, connections]) => {
        const sqlConnections = new Set<string>([DEFAULT_CONNECTION_ID])
        for (const c of connections) if (c.connector === 'postgres' || c.connector === 'mysql') sqlConnections.add(c.id)
        const loaded = { roles, tables, sqlConnections }
        if (gen === s.generation) s.cache = { ...loaded, at: Date.now() }
        return loaded
      })
      .finally(() => {
        if (s.loading === p) s.loading = null
      })
    s.loading = p
    return p
  }

  /* organisation directory: install-wide */
  let org: { dir: OrgDirectory; at: number } | null = null
  let orgLoading: Promise<OrgDirectory> | null = null
  let orgGeneration = 0
  async function directory(): Promise<OrgDirectory> {
    if (org && Date.now() - org.at < ttlMs) return org.dir
    if (orgLoading) return orgLoading
    const store = getMeta().org
    if (!store) return EMPTY_DIRECTORY
    const gen = orgGeneration
    const p = store.directory()
      .then((dir) => {
        if (gen === orgGeneration) org = { dir, at: Date.now() }
        return dir
      })
      .finally(() => {
        if (orgLoading === p) orgLoading = null
      })
    orgLoading = p
    return p
  }

  /* shares: per environment and user (principals = the user and their teams there) */
  const shareCache = new Map<string, { value: PredicateEnv['shares']; at: number; generation: number }>()
  let shareGeneration = 0
  async function sharesFor(userId: string, teams: string[], tables: TableDef[]): Promise<PredicateEnv['shares']> {
    if (!tables.some((t) => t.sharing)) return undefined
    const store = getMeta().org
    if (!store) return undefined
    const key = `${currentEnvironment().id}\u0000${userId}`
    const hit = shareCache.get(key)
    if (hit && hit.generation === shareGeneration && Date.now() - hit.at < ttlMs) return hit.value
    const gen = shareGeneration
    const list = await store.shares.forPrincipals([userId, ...teams])
    const read: Record<string, string[]> = {}
    const update: Record<string, string[]> = {}
    for (const sh of list) {
      ;(read[sh.tableId] ??= []).push(sh.rowId)
      if (sh.access === 'update') (update[sh.tableId] ??= []).push(sh.rowId)
    }
    const value = { read, update }
    if (gen === shareGeneration) shareCache.set(key, { value, at: Date.now(), generation: gen })
    return value
  }

  return {
    async forUser(user: UserDef, expiresOn?: Date) {
      const envId = currentEnvironment().id
      const { roles, tables, sqlConnections } = await load()
      const dir = await directory()
      const orgCtx = orgContextFor(dir, user.id, envId)
      const shares = await sharesFor(user.id, orgCtx.teams, tables)
      const sameStore = (a: TableDef, b: TableDef) => sameConnection(a, b) && sqlConnections.has(a.connectionId || DEFAULT_CONNECTION_ID)
      return buildUserContext(user, roles, tables, expiresOn, envId, { org: orgCtx, orgInfo: userOrgInfo(dir, user.id, envId), shares, sameStore })
    },
    invalidate(scope?: 'all' | { environment: string }) {
      shareGeneration++
      if (scope && scope !== 'all') {
        slots.delete(scope.environment)
        return
      }
      if (scope === 'all') {
        orgGeneration++
        org = null
        orgLoading = null
      }
      const list = scope === 'all' ? [...slots.values()] : [slot(currentEnvironment().id)]
      for (const s of list) {
        s.generation++
        s.cache = null
        s.loading = null
      }
    },
    invalidateOrg() {
      orgGeneration++
      org = null
      orgLoading = null
      shareGeneration++
    },
    invalidateShares() {
      shareGeneration++
      shareCache.clear()
    },
    directory,
  }
}
