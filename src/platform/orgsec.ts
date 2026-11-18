/**
 * Organisation-aware row security, shared by the server (server/core/security.ts compiles the result into SQL) and the
 * demo-mode simulation (core.ts evaluates it in memory). One implementation of what a scope, a relationship rule, a
 * token and a share mean, so both modes agree; the shared test corpus (src/platform/orgsec.corpus.json) runs against
 * both evaluators and, with a database, against PostgreSQL.
 *
 * Pure: no I/O, no DOM. Explicit `.ts` imports so Node can run it directly.
 *
 * Output is the v1 Condition AST (src/platform/http.ts) plus the server-internal `semi` node. Organisation sets
 * (department members, reporting line, team members, shared row ids) are resolved here into plain `in` lists, so every
 * connector and the in-memory evaluators understand them; lookup paths and junction tables become `semi` nodes that the
 * SQL connectors translate to `col IN (SELECT key FROM table WHERE ...)` inside the one statement.
 */
import type {
  AccessScope, DepartmentDef, RoleDef, RowCompare, RowCondition, TableDef, TablePrivilege, TeamDef, UserOrgInfo,
} from './contracts.ts'
import type { Condition, QueryValue, SemiJoin } from './http.ts'

/* ------------------------------------------------------------------ organisation directory */

export interface OrgUser {
  id: string
  name: string
  email: string
  departmentId?: string
  managerId?: string
  status?: 'active' | 'disabled'
}

/** everything the engine needs to know about the organisation (install-wide, cached by the server) */
export interface OrgDirectory {
  departments: DepartmentDef[]
  users: OrgUser[]
  teams: TeamDef[]
}

export const EMPTY_DIRECTORY: OrgDirectory = { departments: [], users: [], teams: [] }

/** reporting lines and department trees are followed at most this deep (cycles are cut, never followed twice) */
export const MAX_ORG_DEPTH = 32

/** per user (and environment): the organisation sets the scopes and tokens use */
export interface OrgContext {
  userId: string
  departmentId?: string
  departmentCode?: string
  /** own department and every department below it (ids) */
  departmentTree: string[]
  /** users of the own department (ids, including the user) */
  departmentUsers: string[]
  /** users of the department tree (ids, including the user) */
  departmentTreeUsers: string[]
  managerId?: string
  /** direct reports (user ids) */
  reports: string[]
  /** everyone below the user in the reporting line (user ids) */
  reportsTree: string[]
  /** teams the user belongs to in this environment (ids) */
  teams: string[]
  /** members of those teams (user ids, including the user when in a team) */
  teammates: string[]
  /** code -> id of every team visible in this environment, and of every department */
  teamByCode: Record<string, string>
  departmentByCode: Record<string, string>
  /** department id -> subtree ids (for @departmentTree:<code>) */
  subtree(departmentId: string): string[]
}

const lc = (s: string) => s.toLowerCase()

export function teamsInEnvironment(dir: OrgDirectory, environmentId: string): TeamDef[] {
  return dir.teams.filter((t) => !t.environmentId || t.environmentId === environmentId)
}

/** department ids of a department and everything below it (cycle-safe, depth-capped) */
export function departmentSubtree(dir: OrgDirectory, rootId: string): string[] {
  const children = new Map<string, string[]>()
  for (const d of dir.departments) {
    if (!d.parentId) continue
    const l = children.get(d.parentId) ?? []
    l.push(d.id)
    children.set(d.parentId, l)
  }
  if (!dir.departments.some((d) => d.id === rootId)) return []
  const out: string[] = []
  const seen = new Set<string>()
  let level = [rootId]
  for (let depth = 0; level.length && depth <= MAX_ORG_DEPTH; depth++) {
    const next: string[] = []
    for (const id of level) {
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
      for (const c of children.get(id) ?? []) if (!seen.has(c)) next.push(c)
    }
    level = next
  }
  return out
}

/** everyone below a user in the reporting line (cycle-safe, depth-capped; never the user themself) */
export function reportsTreeOf(dir: OrgDirectory, userId: string): string[] {
  const byManager = new Map<string, string[]>()
  for (const u of dir.users) {
    if (!u.managerId) continue
    const l = byManager.get(u.managerId) ?? []
    l.push(u.id)
    byManager.set(u.managerId, l)
  }
  const out: string[] = []
  const seen = new Set<string>([userId])
  let level = byManager.get(userId) ?? []
  for (let depth = 0; level.length && depth < MAX_ORG_DEPTH; depth++) {
    const next: string[] = []
    for (const id of level) {
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
      for (const c of byManager.get(id) ?? []) if (!seen.has(c)) next.push(c)
    }
    level = next
  }
  return out
}

/** would setting `managerId` as the manager of `userId` create a cycle? */
export function managerCycle(dir: OrgDirectory, userId: string, managerId: string | undefined): boolean {
  if (!managerId) return false
  if (managerId === userId) return true
  return reportsTreeOf(dir, userId).includes(managerId)
}

/** would moving department `id` under `parentId` create a cycle? */
export function departmentCycle(dir: OrgDirectory, id: string, parentId: string | undefined): boolean {
  if (!parentId) return false
  if (parentId === id) return true
  return departmentSubtree(dir, id).includes(parentId)
}

export function orgContextFor(dir: OrgDirectory, userId: string, environmentId: string): OrgContext {
  const me = dir.users.find((u) => u.id === userId)
  const dept = me?.departmentId ? dir.departments.find((d) => d.id === me.departmentId) : undefined
  const tree = dept ? departmentSubtree(dir, dept.id) : []
  const treeSet = new Set(tree)
  const usersIn = (pred: (u: OrgUser) => boolean) => dir.users.filter(pred).map((u) => u.id)
  const departmentUsers = dept ? usersIn((u) => u.departmentId === dept.id) : []
  const departmentTreeUsers = dept ? usersIn((u) => !!u.departmentId && treeSet.has(u.departmentId)) : []
  const envTeams = teamsInEnvironment(dir, environmentId)
  const mine = envTeams.filter((t) => t.memberIds.includes(userId))
  const teammates = [...new Set(mine.flatMap((t) => t.memberIds))]
  const teamByCode: Record<string, string> = {}
  for (const t of envTeams) teamByCode[lc(t.code)] = t.id
  const departmentByCode: Record<string, string> = {}
  for (const d of dir.departments) departmentByCode[lc(d.code)] = d.id
  const managerOk = me?.managerId && me.managerId !== userId && dir.users.some((u) => u.id === me.managerId)
  return {
    userId,
    departmentId: dept?.id,
    departmentCode: dept?.code,
    departmentTree: tree,
    departmentUsers,
    departmentTreeUsers,
    managerId: managerOk ? me!.managerId : undefined,
    reports: usersIn((u) => u.managerId === userId && u.id !== userId),
    reportsTree: reportsTreeOf(dir, userId),
    teams: mine.map((t) => t.id),
    teammates,
    teamByCode,
    departmentByCode,
    subtree: (id) => departmentSubtree(dir, id),
  }
}

/** what User() shows about the organisation */
export function userOrgInfo(dir: OrgDirectory, userId: string, environmentId: string): UserOrgInfo {
  const me = dir.users.find((u) => u.id === userId)
  const dept = me?.departmentId ? dir.departments.find((d) => d.id === me.departmentId) : undefined
  const mgr = me?.managerId ? dir.users.find((u) => u.id === me.managerId) : undefined
  const out: UserOrgInfo = {
    teams: teamsInEnvironment(dir, environmentId).filter((t) => t.memberIds.includes(userId)).map((t) => ({ id: t.id, code: t.code, name: t.name })),
  }
  if (dept) out.department = { id: dept.id, code: dept.code, name: dept.name }
  if (mgr && mgr.id !== userId) out.manager = { id: mgr.id, name: mgr.name, email: mgr.email }
  return out
}

/** an empty context (no directory: demo workspaces without an organisation, unit tests) */
export function emptyOrgContext(userId: string): OrgContext {
  return {
    userId, departmentTree: [], departmentUsers: [], departmentTreeUsers: [], reports: [], reportsTree: [], teams: [], teammates: [],
    teamByCode: {}, departmentByCode: {}, subtree: () => [],
  }
}

/* ------------------------------------------------------------------ tokens */

export const SCALAR_TOKENS = ['@me', '@myEmail', '@myDepartment', '@myDepartmentCode', '@myManager'] as const
export const LIST_TOKENS = ['@myDepartmentTree', '@myTeams', '@myReports', '@myReportsTree'] as const
/** tokens naming an object by stable code */
export const CODE_TOKEN = /^@(team|department|departmentTree):(.+)$/
export const THIS_TOKEN = /^@this(?:\.([A-Za-z_][A-Za-z0-9_]*))?$/

export function isToken(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('@') && (
    (SCALAR_TOKENS as readonly string[]).includes(v) || (LIST_TOKENS as readonly string[]).includes(v) || CODE_TOKEN.test(v) || THIS_TOKEN.test(v)
  )
}

/** a token that looks like one but is misspelled (validation) */
export function looksLikeToken(v: unknown): boolean {
  return typeof v === 'string' && /^@[A-Za-z]/.test(v) && !isToken(v)
}

type Resolved = { kind: 'scalar'; v: QueryValue } | { kind: 'list'; v: QueryValue[] } | { kind: 'none' }

export interface TokenUser { id: string; email: string }

export function resolveValue(v: unknown, user: TokenUser, org: OrgContext): Resolved {
  if (typeof v !== 'string' || !v.startsWith('@')) {
    if (v === undefined) return { kind: 'scalar', v: null }
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) return { kind: 'scalar', v }
    return { kind: 'scalar', v: String(v) }
  }
  const opt = (x: string | undefined): Resolved => (x ? { kind: 'scalar', v: x } : { kind: 'none' })
  switch (v) {
    case '@me': return { kind: 'scalar', v: user.id }
    case '@myEmail': return { kind: 'scalar', v: user.email }
    case '@myDepartment': return opt(org.departmentId)
    case '@myDepartmentCode': return opt(org.departmentCode)
    case '@myManager': return opt(org.managerId)
    case '@myDepartmentTree': return { kind: 'list', v: org.departmentTree }
    case '@myTeams': return { kind: 'list', v: org.teams }
    case '@myReports': return { kind: 'list', v: org.reports }
    case '@myReportsTree': return { kind: 'list', v: org.reportsTree }
  }
  const m = CODE_TOKEN.exec(v)
  if (m) {
    const code = lc(m[2])
    if (m[1] === 'team') return opt(org.teamByCode[code])
    const id = org.departmentByCode[code]
    if (m[1] === 'department') return opt(id)
    return id ? { kind: 'list', v: org.subtree(id) } : { kind: 'none' }
  }
  // any other @text is a literal value (a typo is refused when the role is saved)
  return { kind: 'scalar', v }
}

/* ------------------------------------------------------------------ predicate building */

export const SYSTEM_COLUMNS = ['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner']
const TRUE: Condition = { const: true }
const FALSE: Condition = { const: false }
/** lookup hops per path, and semi-joins nested in one rule */
export const MAX_PATH_HOPS = 2
export const MAX_RULE_DEPTH = 3

export interface PredicateEnv {
  user: TokenUser
  org: OrgContext
  /** every table of the environment (lookup paths and exists rules name them) */
  tables: TableDef[]
  /**
   * may `inner` be read inside a statement on `outer`? (same connection and a connector that compiles subqueries;
   * demo mode: always). A rule that needs a table outside it grants nothing.
   */
  sameStore(outer: TableDef, inner: TableDef): boolean
  /** row ids shared with the user (directly or through a team), by table id. `read` includes the update shares. */
  shares?: { read: Record<string, string[]>; update: Record<string, string[]> }
}

export function columnNames(table: TableDef): Set<string> {
  const missing = new Set(table.missingSystem ?? [])
  return new Set([...table.columns.map((c) => c.name), ...SYSTEM_COLUMNS].filter((n) => !missing.has(n)))
}

export function findTable(tables: TableDef[], nameOrId: string | undefined): TableDef | undefined {
  if (!nameOrId) return undefined
  return tables.find((t) => t.id === nameOrId) ?? tables.find((t) => t.name === nameOrId) ?? tables.find((t) => lc(t.name) === lc(nameOrId))
}

const and = (parts: Condition[]): Condition => {
  const list: Condition[] = []
  for (const p of parts) {
    if ('const' in p) {
      if (!p.const) return FALSE
      continue
    }
    list.push(p)
  }
  if (!list.length) return TRUE
  return list.length === 1 ? list[0] : { and: list }
}
const or = (parts: Condition[]): Condition => {
  const list: Condition[] = []
  for (const p of parts) {
    if ('const' in p) {
      if (p.const) return TRUE
      continue
    }
    list.push(p)
  }
  if (!list.length) return FALSE
  return list.length === 1 ? list[0] : { or: list }
}

const COMPARE_OPS = ['eq', 'ne', 'in', 'contains', 'startsWith', 'lt', 'le', 'gt', 'ge', 'isBlank', 'notBlank']

/** one comparison on a column of `table` (no path); null when invalid */
function leafFor(table: TableDef, column: string, c: RowCompare, env: PredicateEnv): Condition | null {
  if (!columnNames(table).has(column)) return null
  const op = c.op
  if (!COMPARE_OPS.includes(op)) return null
  if (op === 'isBlank' || op === 'notBlank') return { col: column, op }
  if (op === 'in') {
    const items = Array.isArray(c.value) ? c.value : c.value === undefined ? [] : [c.value]
    const out: QueryValue[] = []
    for (const x of items) {
      if (typeof x === 'string' && THIS_TOKEN.test(x)) return null
      const r = resolveValue(x, env.user, env.org)
      if (r.kind === 'scalar') out.push(r.v)
      else if (r.kind === 'list') out.push(...r.v)
    }
    return out.length ? { col: column, op: 'in', value: out } : FALSE
  }
  const raw = Array.isArray(c.value) ? c.value[0] : c.value
  if (typeof raw === 'string' && THIS_TOKEN.test(raw)) return null
  const r = resolveValue(raw, env.user, env.org)
  // a comparison with something the user does not have (no department, no manager, unknown code) never matches
  if (r.kind === 'none') return FALSE
  if (r.kind === 'list') {
    if (op === 'eq') return r.v.length ? { col: column, op: 'in', value: r.v } : FALSE
    if (op === 'ne') return r.v.length ? { not: { col: column, op: 'in', value: r.v } } : TRUE
    return null // ordering / text operators need one value
  }
  return { col: column, op, value: r.v }
}

/** the lookup target of a column, when it is a lookup to a table in the same store */
function lookupTarget(table: TableDef, column: string, env: PredicateEnv): TableDef | null {
  const col = table.columns.find((x) => x.name === column)
  if (!col || col.type !== 'lookup') return null
  const target = col.lookupTable === table.name || col.lookupTable === table.id ? table : findTable(env.tables, col.lookupTable)
  if (!target || (target.missingSystem ?? []).includes('id') || !env.sameStore(table, target)) return null
  return target
}

function compareFor(table: TableDef, c: RowCompare, env: PredicateEnv, depth: number): Condition | null {
  if (typeof c.column !== 'string' || !c.column) return null
  const parts = c.column.split('.')
  if (parts.length - 1 > MAX_PATH_HOPS || parts.some((p) => !p)) return null
  // walk the lookups: Section.Teacher on Attendance = Section IN (SELECT id FROM Sections WHERE Teacher = ...)
  const chain: { table: TableDef; col: string }[] = []
  let cur = table
  for (let i = 0; i < parts.length - 1; i++) {
    const target = lookupTarget(cur, parts[i], env)
    if (!target) return null
    chain.push({ table: cur, col: parts[i] })
    cur = target
  }
  if (depth + chain.length > MAX_RULE_DEPTH) return null
  let cond = leafFor(cur, parts[parts.length - 1], c, env)
  if (cond === null) return null
  for (let i = chain.length - 1; i >= 0; i--) {
    const target = i === chain.length - 1 ? cur : chain[i + 1].table
    if ('const' in cond && !cond.const) return FALSE
    cond = { semi: { col: chain[i].col, table: target, key: 'id', where: cond } }
  }
  return cond
}

function existsFor(outer: TableDef, e: { table: string; where: RowCondition[] }, env: PredicateEnv, depth: number): Condition | null {
  if (!e || typeof e !== 'object' || !Array.isArray(e.where)) return null
  const target = findTable(env.tables, e.table)
  if (!target || !env.sameStore(outer, target)) return null
  if (depth + 1 > MAX_RULE_DEPTH) return null
  let link: { outerCol: string; innerCol: string } | null = null
  const rest: RowCondition[] = []
  for (const w of e.where) {
    const isCorr = w && typeof w === 'object' && 'column' in w && typeof w.value === 'string' && THIS_TOKEN.test(w.value)
    if (!isCorr) {
      rest.push(w)
      continue
    }
    const cw = w as RowCompare
    if (link || cw.op !== 'eq' || cw.column.includes('.')) return null // exactly one plain equality correlates
    const outerCol = THIS_TOKEN.exec(cw.value as string)![1] ?? 'id'
    if (!columnNames(outer).has(outerCol) || !columnNames(target).has(cw.column)) return null
    link = { outerCol, innerCol: cw.column }
  }
  if (!link) return null
  const where = filterFor(target, rest, env, depth + 1)
  if (where === null) return null
  if ('const' in where && !where.const) return FALSE
  return { semi: { col: link.outerCol, table: target, key: link.innerCol, where } }
}

function ruleFor(table: TableDef, c: RowCondition, env: PredicateEnv, depth: number): Condition | null {
  if (!c || typeof c !== 'object') return null
  if ('exists' in c) return existsFor(table, c.exists, env, depth)
  if ('any' in c) {
    if (!Array.isArray(c.any) || !c.any.length) return null
    const parts: Condition[] = []
    for (const x of c.any) {
      const p = ruleFor(table, x, env, depth)
      if (p === null) return null
      parts.push(p)
    }
    return or(parts)
  }
  if ('column' in c) return compareFor(table, c, env, depth)
  return null
}

/** a privilege's rowFilter as one Condition (ANDed); null when invalid for this table (the role then grants nothing) */
export function filterFor(table: TableDef, filter: RowCondition[] | undefined, env: PredicateEnv, depth = 0): Condition | null {
  if (!filter || !filter.length) return TRUE
  const parts: Condition[] = []
  for (const f of filter) {
    const p = ruleFor(table, f, env, depth)
    if (p === null) return null
    parts.push(p)
  }
  return and(parts)
}

const ownerIn = (ids: string[]): Condition => {
  const list = [...new Set(ids)]
  if (!list.length) return FALSE
  return list.length === 1 ? { col: 'owner', op: 'eq', value: list[0] } : { col: 'owner', op: 'in', value: list }
}

/** the rows a scope covers (owner-based); null when the table has no owner column (grants nothing) */
export function scopeFor(scope: AccessScope, table: TableDef, env: PredicateEnv): Condition | null {
  if (scope === 'none') return FALSE
  if (scope === 'all') return TRUE
  if ((table.missingSystem ?? []).includes('owner')) return null
  const me = env.user.id
  const o = env.org
  switch (scope) {
    case 'own': return { col: 'owner', op: 'eq', value: me }
    case 'team': return ownerIn([me, ...o.teammates, ...o.teams])
    case 'manager': return ownerIn([me, ...o.reports])
    case 'managerTree': return ownerIn([me, ...o.reportsTree])
    case 'department': return ownerIn(o.departmentId ? [me, ...o.departmentUsers] : [me])
    case 'departmentTree': return ownerIn(o.departmentId ? [me, ...o.departmentTreeUsers] : [me])
  }
  return null
}

export type SecOp = 'read' | 'update' | 'delete' | 'create' | 'share'

/** the scope a privilege grants for an operation */
export function scopeOfPriv(p: TablePrivilege | undefined, op: SecOp): AccessScope {
  if (!p) return 'none'
  if (op === 'create') return p.create ? 'all' : 'none'
  if (op === 'share') return p.share ?? 'none'
  return p[op] ?? 'none'
}

/** one role's term for an operation: scope AND rowFilter; null = the role grants nothing */
export function roleTerm(p: TablePrivilege | undefined, op: SecOp, table: TableDef, env: PredicateEnv): Condition | null {
  const s = scopeOfPriv(p, op)
  if (!p || s === 'none') return null
  const filter = filterFor(table, p.rowFilter, env)
  if (filter === null) return null
  const base = scopeFor(s, table, env)
  if (base === null) return null
  const term = and([base, filter])
  if ('const' in term && !term.const) return null
  return term
}

/** shared-row term for read / update, when sharing is on and the user holds that privilege in some role */
export function shareTerm(roles: RoleDef[], table: TableDef, op: SecOp, env: PredicateEnv): Condition | null {
  if (!table.sharing || !env.shares || (op !== 'read' && op !== 'update')) return null
  const has = roles.some((r) => scopeOfPriv(r.privileges.find((p) => p.table === table.id), op) !== 'none')
  if (!has) return null
  const ids = (op === 'read' ? env.shares.read : env.shares.update)[table.id] ?? []
  if (!ids.length) return null
  return { col: 'id', op: 'in', value: [...new Set(ids)] }
}

/**
 * The row predicate of a user for one table and operation: OR over the roles of (scope AND rowFilter), plus the rows
 * shared with the user (read, update), plus for `share` the user's own rows. Admins: TRUE (share: TRUE when the table
 * has sharing on).
 */
export function rowPredicateFor(roles: RoleDef[], table: TableDef, op: SecOp, env: PredicateEnv, isAdmin: boolean): Condition {
  if (op === 'share' && !table.sharing) return FALSE
  if (isAdmin) return TRUE
  const terms: Condition[] = []
  for (const r of roles) {
    const p = r.privileges.find((x) => x.table === table.id)
    if (op === 'create') {
      if (!p?.create) continue
      const f = filterFor(table, p.rowFilter, env)
      if (f === null) continue
      terms.push(f)
      continue
    }
    const t = roleTerm(p, op, table, env)
    if (t) terms.push(t)
  }
  const shared = shareTerm(roles, table, op, env)
  if (shared) terms.push(shared)
  if (op === 'share' && !(table.missingSystem ?? []).includes('owner') && roles.some((r) => scopeOfPriv(r.privileges.find((p) => p.table === table.id), 'read') !== 'none')) {
    terms.push({ col: 'owner', op: 'eq', value: env.user.id })
  }
  return or(terms)
}

/** the reasons (per role, share, ownership) that make up a predicate, for the "who can see this row?" explainer */
export interface PredicateReason {
  kind: 'admin' | 'role' | 'share' | 'owner'
  roleId?: string
  roleName?: string
  scope?: AccessScope
  /** the role carries a row filter / relationship rule */
  filtered?: boolean
  term: Condition
}

export function predicateReasons(roles: RoleDef[], table: TableDef, op: SecOp, env: PredicateEnv, isAdmin: boolean): PredicateReason[] {
  if (op === 'share' && !table.sharing) return []
  if (isAdmin) return [{ kind: 'admin', term: TRUE }]
  const out: PredicateReason[] = []
  for (const r of roles) {
    const p = r.privileges.find((x) => x.table === table.id)
    const t = op === 'create' ? (p?.create ? filterFor(table, p.rowFilter, env) : null) : roleTerm(p, op, table, env)
    if (t) out.push({ kind: 'role', roleId: r.id, roleName: r.name, scope: scopeOfPriv(p, op), filtered: !!p?.rowFilter?.length, term: t })
  }
  const shared = shareTerm(roles, table, op, env)
  if (shared) out.push({ kind: 'share', term: shared })
  if (op === 'share' && roles.some((r) => scopeOfPriv(r.privileges.find((p) => p.table === table.id), 'read') !== 'none')) {
    out.push({ kind: 'owner', term: { col: 'owner', op: 'eq', value: env.user.id } })
  }
  return out
}

/* ------------------------------------------------------------------ evaluation (in memory) */

export type LeafCondition = Extract<Condition, { col: string }>

export interface SyncEvaluator {
  leaf(c: LeafCondition, row: Record<string, unknown>): boolean
  /** does a row of s.table with s.key equal to `value` match s.where? */
  semi(s: SemiJoin, value: unknown): boolean
}
export interface AsyncEvaluator {
  leaf(c: LeafCondition, row: Record<string, unknown>): boolean
  semi(s: SemiJoin, value: unknown): Promise<boolean>
}

const blank = (v: unknown) => v === null || v === undefined || v === ''

export function evaluateSync(c: Condition | undefined, row: Record<string, unknown>, ev: SyncEvaluator): boolean {
  if (!c) return true
  if ('const' in c) return c.const
  if ('and' in c) return c.and.every((x) => evaluateSync(x, row, ev))
  if ('or' in c) return c.or.some((x) => evaluateSync(x, row, ev))
  if ('not' in c) return !evaluateSync(c.not, row, ev)
  if ('semi' in c) {
    const v = row[c.semi.col]
    return !blank(v) && ev.semi(c.semi, v)
  }
  return ev.leaf(c, row)
}

export async function evaluateAsync(c: Condition | undefined, row: Record<string, unknown>, ev: AsyncEvaluator): Promise<boolean> {
  if (!c) return true
  if ('const' in c) return c.const
  if ('and' in c) {
    for (const x of c.and) if (!(await evaluateAsync(x, row, ev))) return false
    return true
  }
  if ('or' in c) {
    for (const x of c.or) if (await evaluateAsync(x, row, ev)) return true
    return false
  }
  if ('not' in c) return !(await evaluateAsync(c.not, row, ev))
  if ('semi' in c) {
    const v = row[c.semi.col]
    return !blank(v) && ev.semi(c.semi, v)
  }
  return ev.leaf(c, row)
}

/** does the condition need the database (relationship rules)? */
export function hasSemi(c: Condition | undefined): boolean {
  if (!c || 'const' in c || 'col' in c) return false
  if ('semi' in c) return true
  if ('and' in c) return c.and.some(hasSemi)
  if ('or' in c) return c.or.some(hasSemi)
  return hasSemi(c.not)
}

/** an in-memory semi-join over rows held by the caller (demo mode, tests): key compared case-insensitively as text */
export function memorySemi(rowsOf: (t: TableDef) => Record<string, unknown>[], leaf: SyncEvaluator['leaf']): SyncEvaluator['semi'] {
  const ev: SyncEvaluator = {
    leaf,
    semi(s, value) {
      const want = String(value).toLowerCase()
      return rowsOf(s.table).some((r) => {
        const k = r[s.key]
        return !blank(k) && String(k).toLowerCase() === want && evaluateSync(s.where, r, ev)
      })
    },
  }
  return ev.semi
}

/* ------------------------------------------------------------------ validation (role editor and the API) */

/**
 * Problems of a rowFilter for one table (empty when valid): unknown columns, paths that do not follow lookups or leave
 * the table's connection, misspelled tokens, list tokens with ordering operators, exists without one correlation.
 */
export function ruleProblems(table: TableDef, filter: RowCondition[], tables: TableDef[], sameStore: PredicateEnv['sameStore'] = () => true): string[] {
  const problems: string[] = []
  const env: PredicateEnv = {
    user: { id: 'u', email: 'u@x' },
    org: { ...emptyOrgContext('u'), departmentId: 'd', departmentCode: 'D', managerId: 'm', departmentTree: ['d'], teams: ['t'] },
    tables, sameStore,
  }
  const visit = (t: TableDef, list: RowCondition[], where: string, inExists: boolean) => {
    list.forEach((c, i) => {
      const at = `${where} ${i + 1}`
      if (!c || typeof c !== 'object') { problems.push(`${at} is malformed.`); return }
      if ('any' in c) {
        if (!Array.isArray(c.any) || !c.any.length) problems.push(`${at}: an "any of" group needs at least one condition.`)
        else visit(t, c.any, `${at}.`, inExists)
        return
      }
      if ('exists' in c) {
        const target = findTable(tables, c.exists?.table)
        if (!target) { problems.push(`${at}: the table "${String(c.exists?.table ?? '')}" does not exist.`); return }
        if (!sameStore(t, target)) { problems.push(`${at}: "${target.displayName}" is in another connection; rules can only use tables of the same connection.`); return }
        const corr = (c.exists.where ?? []).filter((w) => w && 'column' in w && typeof w.value === 'string' && THIS_TOKEN.test(w.value))
        if (corr.length !== 1) problems.push(`${at}: say exactly once how a row of "${target.displayName}" belongs to this row (a condition "is this row").`)
        visit(target, (c.exists.where ?? []).filter((w) => !corr.includes(w)), `${at}.`, true)
        for (const w of corr) {
          const cw = w as RowCompare
          const outerCol = THIS_TOKEN.exec(String(cw.value))![1] ?? 'id'
          if (!columnNames(target).has(cw.column)) problems.push(`${at}: "${cw.column}" is not a column of "${target.displayName}".`)
          if (!columnNames(t).has(outerCol)) problems.push(`${at}: "${outerCol}" is not a column of "${t.displayName}".`)
          if (cw.op !== 'eq') problems.push(`${at}: the link to this row must use "is".`)
        }
        return
      }
      if (!('column' in c) || typeof c.column !== 'string') { problems.push(`${at} needs a column.`); return }
      const vals = Array.isArray(c.value) ? c.value : [c.value]
      for (const v of vals) {
        if (looksLikeToken(v)) problems.push(`${at}: "${String(v)}" is not a known token (tokens are case-sensitive: use exactly ${[...SCALAR_TOKENS, ...LIST_TOKENS].join(', ')}, @team:<code>, @department:<code>).`)
        if (typeof v === 'string' && THIS_TOKEN.test(v) && !inExists) problems.push(`${at}: "this row" can only be used inside a related-rows rule.`)
      }
      if (compareFor(t, c, env, 0) === null) {
        const parts = c.column.split('.')
        if (parts.length - 1 > MAX_PATH_HOPS) problems.push(`${at}: a path can follow at most ${MAX_PATH_HOPS} lookups.`)
        else if (parts.length === 1 && !columnNames(t).has(c.column)) problems.push(`${at}: the column "${c.column}" does not exist in "${t.displayName}".`)
        else problems.push(`${at}: "${c.column}" is not a column (or a path through lookup columns) of "${t.displayName}", or the operator does not fit its value.`)
      }
    })
  }
  visit(table, filter, 'Condition', false)
  return problems
}

/** every table a rule reads (for solution packaging: rules travel with the tables they name) */
export function ruleTables(table: TableDef, filter: RowCondition[] | undefined, tables: TableDef[]): string[] {
  const out = new Set<string>()
  const visit = (t: TableDef, list: RowCondition[]) => {
    for (const c of list ?? []) {
      if (!c || typeof c !== 'object') continue
      if ('any' in c) visit(t, c.any)
      else if ('exists' in c) {
        const target = findTable(tables, c.exists.table)
        if (target) { out.add(target.id); visit(target, c.exists.where) }
      } else if ('column' in c && typeof c.column === 'string') {
        let cur: TableDef | undefined = t
        for (const p of c.column.split('.').slice(0, -1)) {
          const col: TableDef['columns'][number] | undefined = cur?.columns.find((x) => x.name === p)
          cur = col?.lookupTable ? findTable(tables, col.lookupTable) : undefined
          if (cur) out.add(cur.id)
        }
      }
    }
  }
  visit(table, filter ?? [])
  return [...out]
}
