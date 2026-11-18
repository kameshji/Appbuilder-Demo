/** Shared security helpers for the portal: plain-language descriptions of RLS/CLS, effective access of the signed-in user, password strength. */
import { usePlatform, type AccessScope, type ColumnAccess, type ColumnDef, type RoleDef, type RowCompare, type RowCondition, type TableDef, type TablePrivilege } from '@/platform'
import { isRowAny, isRowExists } from '@/platform/contracts'

/* ------------------------------------------------------------------ roles */

/** RoleDef as the server returns it: the Maker flag is part of the role (ab_roles.is_maker) though not in the shared contract yet. */
export type RoleWithMaker = RoleDef & { isMaker?: boolean }
export const isMakerRole = (r: RoleDef) => !!(r as RoleWithMaker).isMaker

export const emptyPrivilege = (table: string): TablePrivilege => ({ table, create: false, read: 'none', update: 'none', delete: 'none' })

/* ------------------------------------------------------------------ row filter language */

export const OPS: { value: RowCompare['op']; label: string; needsValue: boolean }[] = [
  { value: 'eq', label: 'is', needsValue: true },
  { value: 'ne', label: 'is not', needsValue: true },
  { value: 'in', label: 'is one of', needsValue: true },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'startsWith', label: 'starts with', needsValue: true },
  { value: 'lt', label: 'is less than', needsValue: true },
  { value: 'le', label: 'is at most', needsValue: true },
  { value: 'gt', label: 'is greater than', needsValue: true },
  { value: 'ge', label: 'is at least', needsValue: true },
  { value: 'isBlank', label: 'is empty', needsValue: false },
  { value: 'notBlank', label: 'is not empty', needsValue: false },
]
export const opInfo = (op: RowCompare['op']) => OPS.find((o) => o.value === op) ?? OPS[0]
export const TOKEN_ME = '@me'
export const TOKEN_EMAIL = '@myEmail'
/** operators that accept the user tokens */
export const TOKEN_OPS: RowCompare['op'][] = ['eq', 'ne', 'contains', 'startsWith']

/** value tokens a rule may compare with, in plain language (the rule builder offers these) */
export const TOKENS: { value: string; label: string; list?: boolean }[] = [
  { value: '@me', label: 'the current user' },
  { value: '@myEmail', label: "the current user's email" },
  { value: '@myDepartment', label: "the current user's department" },
  { value: '@myDepartmentCode', label: "the current user's department code" },
  { value: '@myDepartmentTree', label: "the current user's department or one below it", list: true },
  { value: '@myTeams', label: "one of the current user's teams", list: true },
  { value: '@myManager', label: "the current user's manager" },
  { value: '@myReports', label: "one of the current user's direct reports", list: true },
  { value: '@myReportsTree', label: "anyone in the current user's reporting line", list: true },
]
export const tokenLabel = (v: string): string | undefined => {
  const t = TOKENS.find((x) => x.value === v)
  if (t) return t.label
  if (v === '@this') return 'this row'
  if (v.startsWith('@this.')) return `this row's ${v.slice(6)}`
  const m = /^@(team|department|departmentTree):(.+)$/.exec(v)
  if (m) return m[1] === 'team' ? `team ${m[2]}` : m[1] === 'department' ? `department ${m[2]}` : `department ${m[2]} or one below it`
  return undefined
}

function valueText(v: RowCompare['value']): string {
  if (typeof v === 'string' && tokenLabel(v)) return tokenLabel(v)!
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' && tokenLabel(x)) || String(x)).join(', ')
  if (v === undefined || v === null) return ''
  return String(v)
}

/** "Region" -> its display name; "Section.Teacher" -> "Section > Teacher" */
function pathName(column: string, columns: ColumnDef[], tables: TableDef[]): string {
  const parts = column.split('.')
  let cols = columns
  const names: string[] = []
  for (const p of parts) {
    const col = cols.find((x) => x.name === p)
    names.push(col?.displayName ?? p)
    const target = col?.lookupTable ? tables.find((t) => t.name === col.lookupTable || t.id === col.lookupTable) : undefined
    cols = target?.columns ?? []
  }
  return names.join(' > ')
}

/** "Region is West", "Owner is the current user", "Section > Teacher is the current user" */
export function describeCondition(c: RowCondition, columns: ColumnDef[], tables: TableDef[] = []): string {
  if (isRowAny(c)) return `(${c.any.map((x) => describeCondition(x, columns, tables)).join(' OR ')})`
  if (isRowExists(c)) {
    const t = tables.find((x) => x.name === c.exists.table || x.id === c.exists.table)
    return `a ${t?.displayName ?? c.exists.table} row exists where ${c.exists.where.map((x) => describeCondition(x, t?.columns ?? [], tables)).join(' AND ')}`
  }
  const name = pathName(c.column, columns, tables)
  const info = opInfo(c.op)
  if (!info.needsValue) return `${name} ${info.label}`
  const raw = valueText(c.value)
  const shown = typeof c.value === 'string' && c.value.startsWith('@') ? raw : c.op === 'in' ? `[${raw}]` : `"${raw}"`
  return `${name} ${info.label} ${shown}`
}

export function describeFilter(conds: RowCondition[] | undefined, columns: ColumnDef[], tables: TableDef[] = []): string {
  return (conds ?? []).map((c) => describeCondition(c, columns, tables)).join(' AND ')
}

export const SCOPE_ROWS: Record<AccessScope, string> = {
  none: '', all: '', own: 'the current user owns them',
  team: 'the current user, a member of one of their teams, or one of those teams owns them',
  manager: 'the current user or one of their direct reports owns them',
  managerTree: 'the current user or someone in their reporting line owns them',
  department: "someone in the current user's department owns them",
  departmentTree: "someone in the current user's department, or a department below it, owns them",
}

/** "all rows", "rows where Owner is the current user AND Region is "West"" */
export function describeRows(scope: AccessScope, conds: RowCondition[] | undefined, columns: ColumnDef[], tables: TableDef[] = []): string {
  if (scope === 'none') return 'no rows'
  const parts: string[] = []
  if (SCOPE_ROWS[scope]) parts.push(SCOPE_ROWS[scope])
  const f = describeFilter(conds, columns, tables)
  if (f) parts.push(f)
  return parts.length ? `rows where ${parts.join(' AND ')}` : 'all rows'
}

export const SCOPE_WORD: Record<AccessScope, string> = {
  none: 'No access', own: 'Own rows', team: 'Team', manager: 'Direct reports', managerTree: 'Reporting line',
  department: 'Department', departmentTree: 'Department tree', all: 'All rows',
}

/** the scopes a role editor offers, with plain-language descriptions */
export const SCOPE_OPTIONS: { value: AccessScope; label: string; title: string }[] = [
  { value: 'none', label: 'None', title: 'No access' },
  { value: 'own', label: 'Own', title: 'Rows the user owns' },
  { value: 'team', label: 'Team', title: 'Rows owned by the user, by anyone in one of their teams, or by those teams' },
  { value: 'manager', label: 'Direct reports', title: 'Rows owned by the user or by someone who reports to them directly' },
  { value: 'managerTree', label: 'Reporting line', title: 'Rows owned by the user or by anyone below them in the reporting line' },
  { value: 'department', label: 'Department', title: "Rows owned by anyone in the user's department" },
  { value: 'departmentTree', label: 'Department tree', title: "Rows owned by anyone in the user's department or a department below it" },
  { value: 'all', label: 'All', title: 'All rows' },
]

/* ------------------------------------------------------------------ column access */

export const COLUMN_ACCESS: { value: ColumnAccess; label: string; title: string }[] = [
  { value: 'none', label: 'None', title: 'Hidden: the column is removed for this role' },
  { value: 'read', label: 'Read', title: 'Visible but cannot be changed' },
  { value: 'update', label: 'Update', title: 'Visible and editable' },
]

/** CLS applies to non-system columns only */
export const securedColumns = (t: TableDef) => t.columns.filter((c) => !c.system)

/* ------------------------------------------------------------------ the signed-in user's access (UX mirror only) */

export interface MyAccess {
  /** server mode with a session: privileges are enforced and mirrored; false = demo mode, everything is allowed in the portal */
  enforced: boolean
  isAdmin: boolean
  isMaker: boolean
  create: boolean
  read: AccessScope
  update: AccessScope
  delete: AccessScope
  /** column names that cannot be edited */
  readOnlyColumns: Set<string>
  readOnlyTable: boolean
}

export function useMyAccess(table: TableDef | undefined): MyAccess {
  const session = usePlatform((s) => s.session)
  const mode = usePlatform((s) => s.mode)
  const open: MyAccess = { enforced: false, isAdmin: true, isMaker: true, create: true, read: 'all', update: 'all', delete: 'all', readOnlyColumns: new Set(), readOnlyTable: !!table?.readOnly }
  if (mode !== 'server' || !session) return open
  const p = session.privileges
  if (p.isAdmin) return { ...open, enforced: true, isAdmin: true, isMaker: true }
  const t = table ? p.tables[table.id] : undefined
  const ro = new Set<string>()
  if (t) for (const [c, a] of Object.entries(t.columns)) if (a === 'read') ro.add(c)
  return {
    enforced: true,
    isAdmin: false,
    isMaker: p.isMaker,
    create: !!t?.create && !table?.readOnly,
    read: t?.read ?? 'none',
    update: table?.readOnly ? 'none' : t?.update ?? 'none',
    delete: table?.readOnly ? 'none' : t?.delete ?? 'none',
    readOnlyColumns: ro,
    readOnlyTable: !!table?.readOnly,
  }
}

/** capabilities of the signed-in user for portal navigation */
/**
 * isAdmin: administrator of the current environment; isInstallAdmin: install administrator (environments, user
 * accounts, install audit). Demo mode: the person at the keyboard is everything.
 */
export function useCaps(): { server: boolean; isAdmin: boolean; isMaker: boolean; isInstallAdmin: boolean } {
  const session = usePlatform((s) => s.session)
  const mode = usePlatform((s) => s.mode)
  if (mode !== 'server') return { server: false, isAdmin: true, isMaker: true, isInstallAdmin: true }
  return {
    server: true, isAdmin: !!session?.privileges.isAdmin, isMaker: !!session?.privileges.isAdmin || !!session?.privileges.isMaker,
    isInstallAdmin: !!session?.privileges.isInstallAdmin,
  }
}

/* ------------------------------------------------------------------ passwords */

export const MIN_PASSWORD = 10

export interface Strength { score: 0 | 1 | 2 | 3 | 4; label: string; ok: boolean; hint: string }

export function passwordStrength(pw: string, email?: string): Strength {
  if (!pw) return { score: 0, label: '', ok: false, hint: `At least ${MIN_PASSWORD} characters. A few unrelated words work well.` }
  if (pw.length < MIN_PASSWORD) return { score: 1, label: 'Too short', ok: false, hint: `Use at least ${MIN_PASSWORD} characters (${MIN_PASSWORD - pw.length} more).` }
  if (email && pw.toLowerCase() === email.trim().toLowerCase()) return { score: 1, label: 'Same as email', ok: false, hint: 'The password must not be your email address.' }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length
  const distinct = new Set(pw).size
  let points = 0
  if (pw.length >= 12) points++
  if (pw.length >= 16) points++
  if (classes >= 3) points++
  if (distinct >= 8) points++
  if (/^(.)\1+$/.test(pw) || distinct < 4) points = 0
  const score = (points >= 4 ? 4 : points >= 3 ? 3 : points >= 1 ? 2 : 1) as Strength['score']
  const label = ['', 'Weak', 'Fair', 'Good', 'Strong'][score]
  return { score, label, ok: true, hint: score >= 3 ? 'Looks good.' : 'Longer is stronger. Add words, digits or symbols.' }
}
