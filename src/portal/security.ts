/** Shared security helpers for the portal: plain-language descriptions of RLS/CLS, effective access of the signed-in user, password strength. */
import { usePlatform, type AccessScope, type ColumnAccess, type ColumnDef, type RoleDef, type RowCondition, type TableDef, type TablePrivilege } from '@/platform'

/* ------------------------------------------------------------------ roles */

/** RoleDef as the server returns it: the Maker flag is part of the role (ab_roles.is_maker) though not in the shared contract yet. */
export type RoleWithMaker = RoleDef & { isMaker?: boolean }
export const isMakerRole = (r: RoleDef) => !!(r as RoleWithMaker).isMaker

export const emptyPrivilege = (table: string): TablePrivilege => ({ table, create: false, read: 'none', update: 'none', delete: 'none' })

/* ------------------------------------------------------------------ row filter language */

export const OPS: { value: RowCondition['op']; label: string; needsValue: boolean }[] = [
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
export const opInfo = (op: RowCondition['op']) => OPS.find((o) => o.value === op) ?? OPS[0]
export const TOKEN_ME = '@me'
export const TOKEN_EMAIL = '@myEmail'
/** operators that accept the "Current user" tokens */
export const TOKEN_OPS: RowCondition['op'][] = ['eq', 'ne', 'contains', 'startsWith']

function valueText(v: RowCondition['value']): string {
  if (v === TOKEN_ME) return 'the current user'
  if (v === TOKEN_EMAIL) return "the current user's email"
  if (Array.isArray(v)) return v.map((x) => String(x)).join(', ')
  if (v === undefined || v === null) return ''
  return String(v)
}

/** "Region is West", "Owner is the current user" */
export function describeCondition(c: RowCondition, columns: ColumnDef[]): string {
  const col = columns.find((x) => x.name === c.column)
  const name = col?.displayName ?? c.column
  const info = opInfo(c.op)
  if (!info.needsValue) return `${name} ${info.label}`
  const raw = valueText(c.value)
  const shown = typeof c.value === 'string' && c.value.startsWith('@') ? raw : c.op === 'in' ? `[${raw}]` : `"${raw}"`
  return `${name} ${info.label} ${shown}`
}

export function describeFilter(conds: RowCondition[] | undefined, columns: ColumnDef[]): string {
  return (conds ?? []).map((c) => describeCondition(c, columns)).join(' AND ')
}

/** "all rows", "rows where Owner is the current user AND Region is "West"" */
export function describeRows(scope: AccessScope, conds: RowCondition[] | undefined, columns: ColumnDef[]): string {
  if (scope === 'none') return 'no rows'
  const parts: string[] = []
  if (scope === 'own') parts.push('Owner is the current user')
  const f = describeFilter(conds, columns)
  if (f) parts.push(f)
  return parts.length ? `rows where ${parts.join(' AND ')}` : 'all rows'
}

export const SCOPE_WORD: Record<AccessScope, string> = { none: 'No access', own: 'Own rows', all: 'All rows' }

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
export function useCaps(): { server: boolean; isAdmin: boolean; isMaker: boolean } {
  const session = usePlatform((s) => s.session)
  const mode = usePlatform((s) => s.mode)
  if (mode !== 'server') return { server: false, isAdmin: true, isMaker: true }
  return { server: true, isAdmin: !!session?.privileges.isAdmin, isMaker: !!session?.privileges.isAdmin || !!session?.privileges.isMaker }
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
