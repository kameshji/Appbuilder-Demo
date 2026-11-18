/**
 * Organisation (docs/admin/organisation.md): departments, teams, the organisation fields of users, CSV import of users,
 * the directory for pickers; record sharing (docs/admin/security-model.md); the "who can see this row?" explainer.
 *
 *   GET    /api/v1/org                         directory: departments, teams, users (admins: all fields; others: id, name, email)
 *   POST   /api/v1/departments                 { code, name, parentId?, description? }        install administrators
 *   PATCH  /api/v1/departments/:id             { code?, name?, parentId?, description? }      (no cycles)
 *   DELETE /api/v1/departments/:id             (refused while it has child departments)
 *   POST   /api/v1/teams                       { code, name, description?, environmentId?, memberIds? }
 *   PATCH  /api/v1/teams/:id   DELETE /api/v1/teams/:id
 *   POST   /api/v1/users/import                { csv, commit? } -> preview, or the created users with one-time passwords
 *   GET    /api/v1/shares?row=&table=          shares of one row (anyone who can read it)
 *   POST   /api/v1/shares                      { row, table?, principal, access }  share (owner or share privilege)
 *   POST   /api/v1/shares/remove               { row, table?, principal }
 *   GET    /api/v1/security/explain?table=&row=[&user=]   who can read / update / delete a row and why (administrators)
 */
import { randomBytes } from 'node:crypto'
import Papa from 'papaparse'
import type { DepartmentDef, RoleDef, ShareDef, TableDef, TeamDef, UserDef } from '../../../src/platform/contracts.ts'
import type { OrgDirectory, PredicateReason } from '../../../src/platform/orgsec.ts'
import { DIRECTORY_VISIBILITY, departmentCycle, managerCycle, teamsInEnvironment } from '../../../src/platform/orgsec.ts'
import type { DirectoryVisibility } from '../../../src/platform/orgsec.ts'
import { SYS } from '../../../src/platform/system-tables.ts'
import type { Condition, QueryValue } from '../../../src/platform/http.ts'
import { HttpError } from '../../core/contracts.ts'
import type { Ctx, RawRow, Router, Services, UserContext, UserRecord } from '../../core/contracts.ts'
import type { OrgStore } from '../../core/org-store.ts'
import { and, evaluateWithSemi } from '../../core/condition.ts'
import type { DataInternals } from '../../core/data.ts'
import { hashPassword } from '../../core/password.ts'
import { currentEnvironment } from '../../core/env-context.ts'
import { bodyObj, conflict, invalid, isObj, notFound, optString, reqString } from './util.ts'
import { audit } from './tables-core.ts'

const CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_IMPORT_ROWS = 5000

function store(s: Services): OrgStore {
  const o = s.meta.org
  if (!o) throw new HttpError(503, 'unavailable', 'The organisation store is not available.')
  return o
}

function requireInstallAdmin(ctx: Ctx, what: string): void {
  if (!ctx.user?.privileges.isInstallAdmin) throw new HttpError(403, 'denied', `Only install administrators can ${what}.`)
}

function orgChanged(s: Services): void {
  s.security.invalidateOrg?.()
  s.security.invalidate('all')
}

async function directory(s: Services): Promise<OrgDirectory> {
  return store(s).directory()
}

function code(b: Record<string, unknown>, label: string): string {
  const c = reqString(b, 'code', `The ${label} code`, 64)
  if (!CODE.test(c)) throw invalid(`The ${label} code may use letters, digits, ".", "_" and "-" (at most 64, starting with a letter or digit).`, 'code')
  return c
}

/* ------------------------------------------------------------------ user organisation fields (shared with security.ts) */

export interface OrgFieldsPatch { departmentId?: string | null; managerId?: string | null; jobTitle?: string | null; phone?: string | null; employeeCode?: string | null }

/** validates the organisation fields of a user body (undefined = not given); throws 422 for unknown ids and cycles */
export async function readOrgFields(s: Services, b: Record<string, unknown>, userId: string | null): Promise<OrgFieldsPatch> {
  const out: OrgFieldsPatch = {}
  const has = (k: string) => b[k] !== undefined
  if (!['departmentId', 'managerId', 'jobTitle', 'phone', 'employeeCode'].some(has)) return out
  const dir = await directory(s)
  if (has('departmentId')) {
    const v = b.departmentId === null || b.departmentId === '' ? null : String(b.departmentId)
    if (v && !dir.departments.some((d) => d.id === v)) throw notFound(`Department "${v}" was not found.`)
    out.departmentId = v
  }
  if (has('managerId')) {
    const v = b.managerId === null || b.managerId === '' ? null : String(b.managerId)
    if (v && !dir.users.some((u) => u.id === v)) throw notFound(`User "${v}" (manager) was not found.`)
    if (v && userId && managerCycle(dir, userId, v)) throw invalid('That manager reports (directly or indirectly) to this user: the reporting line would go round in a circle.', 'managerId')
    out.managerId = v
  }
  for (const k of ['jobTitle', 'phone', 'employeeCode'] as const) {
    if (!has(k)) continue
    const v = b[k] === null ? null : optString(b, k, { max: 200 })
    out[k] = v ? v.trim() || null : null
  }
  return out
}

export async function saveOrgFields(s: Services, userId: string, f: OrgFieldsPatch): Promise<boolean> {
  if (!Object.keys(f).length || !s.meta.org) return false
  await s.meta.org.setUserOrg(userId, f)
  orgChanged(s)
  return true
}

/* ------------------------------------------------------------------ CSV import of users */

export interface UserImportRow {
  line: number
  action: 'create' | 'update' | 'error'
  name: string
  email: string
  department?: string
  manager?: string
  jobTitle?: string
  phone?: string
  employeeCode?: string
  roles?: string[]
  errors: string[]
}

const HEADER: Record<string, string> = {
  name: 'name', fullname: 'name', 'full name': 'name',
  email: 'email', 'e-mail': 'email', mail: 'email',
  department: 'department', dept: 'department', departmentcode: 'department', 'department code': 'department',
  manager: 'manager', manageremail: 'manager', 'manager email': 'manager',
  jobtitle: 'jobTitle', 'job title': 'jobTitle', title: 'jobTitle',
  phone: 'phone', mobile: 'phone',
  employeecode: 'employeeCode', 'employee code': 'employeeCode', employeeid: 'employeeCode', 'employee id': 'employeeCode',
  roles: 'roles', role: 'roles',
  status: 'status',
}

/** temporary password: 16 characters, letters and digits (shown once) */
function temporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = randomBytes(16)
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}

export async function planUserImport(s: Services, csv: string): Promise<{ rows: UserImportRow[]; ok: boolean; unknownColumns: string[] }> {
  if (typeof csv !== 'string' || !csv.trim()) throw invalid('The CSV is empty.', 'csv')
  const parsed = Papa.parse<Record<string, string>>(csv.replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy' })
  const fields = parsed.meta.fields ?? []
  const map = new Map<string, string>()
  const unknownColumns: string[] = []
  for (const f of fields) {
    const k = HEADER[f.trim().toLowerCase()]
    if (k) map.set(f, k)
    else if (/password/i.test(f)) unknownColumns.push(`${f} (passwords are never imported)`)
    else unknownColumns.push(f)
  }
  if (![...map.values()].includes('email') || ![...map.values()].includes('name')) throw invalid('The CSV needs at least the columns "name" and "email".', 'csv')
  if (parsed.data.length > MAX_IMPORT_ROWS) throw invalid(`At most ${MAX_IMPORT_ROWS} users per import.`, 'csv')
  const dir = await directory(s)
  const users = await s.meta.users.list()
  const roles = await s.meta.roles.list()
  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]))
  const seen = new Set<string>()
  const rows: UserImportRow[] = parsed.data.map((rec, i) => {
    const get = (k: string) => {
      for (const [h, key] of map) if (key === k) return String(rec[h] ?? '').trim()
      return ''
    }
    const r: UserImportRow = { line: i + 2, action: 'create', name: get('name'), email: get('email').toLowerCase(), errors: [] }
    for (const k of ['department', 'manager', 'jobTitle', 'phone', 'employeeCode'] as const) {
      const v = get(k)
      if (v) r[k] = k === 'manager' ? v.toLowerCase() : v
    }
    const rl = get('roles')
    if (rl) r.roles = rl.split(/[;|]/).map((x) => x.trim()).filter(Boolean)
    if (!r.name) r.errors.push('name is missing')
    if (r.name.length > 100) r.errors.push('name is longer than 100 characters')
    if (!EMAIL.test(r.email)) r.errors.push(`"${r.email}" is not a valid email address`)
    if (seen.has(r.email)) r.errors.push('this email appears twice in the file')
    seen.add(r.email)
    if (byEmail.has(r.email)) r.action = 'update'
    if (r.department) {
      const d = dir.departments.find((x) => x.code.toLowerCase() === r.department!.toLowerCase()) ?? dir.departments.find((x) => x.name.toLowerCase() === r.department!.toLowerCase())
      if (!d) r.errors.push(`department "${r.department}" does not exist (use its code)`)
    }
    for (const name of r.roles ?? []) if (!roles.some((x) => x.name.toLowerCase() === name.toLowerCase())) r.errors.push(`role "${name}" does not exist in this environment`)
    const st = get('status').toLowerCase()
    if (st && st !== 'active' && st !== 'disabled') r.errors.push('status must be active or disabled')
    return r
  })
  // managers: existing users or people in the same file; then no cycles in the resulting reporting line
  const fileEmails = new Set(rows.map((r) => r.email))
  for (const r of rows) {
    if (r.manager && !byEmail.has(r.manager) && !fileEmails.has(r.manager)) r.errors.push(`manager "${r.manager}" is neither a user nor in this file`)
    if (r.manager && r.manager === r.email) r.errors.push('a user cannot be their own manager')
  }
  const idOf = (email: string) => byEmail.get(email)?.id ?? `new:${email}`
  const future: OrgDirectory = { departments: dir.departments, teams: dir.teams, users: dir.users.map((u) => ({ ...u })) }
  for (const r of rows) {
    if (r.errors.length) continue
    const id = idOf(r.email)
    let u = future.users.find((x) => x.id === id)
    if (!u) future.users.push((u = { id, name: r.name, email: r.email }))
    if (r.manager) u.managerId = idOf(r.manager)
  }
  for (const r of rows) {
    if (r.errors.length || !r.manager) continue
    const me = idOf(r.email)
    // a cycle exists when my manager appears below me
    const below = new Set<string>()
    const walk = (id: string, depth: number) => {
      if (depth > 64) return
      for (const x of future.users) if (x.managerId === id && !below.has(x.id)) { below.add(x.id); walk(x.id, depth + 1) }
    }
    walk(me, 0)
    if (below.has(idOf(r.manager)) || idOf(r.manager) === me) r.errors.push('the reporting line would go round in a circle')
  }
  for (const r of rows) if (r.errors.length) r.action = 'error'
  return { rows, ok: rows.length > 0 && rows.every((r) => !r.errors.length), unknownColumns }
}

/* ------------------------------------------------------------------ shares */

interface Principal { type: 'user' | 'team'; id: string; name: string }

async function resolvePrincipal(s: Services, raw: unknown): Promise<Principal> {
  const dir = await directory(s)
  const env = currentEnvironment().id
  const teams = teamsInEnvironment(dir, env)
  let type: string | undefined
  let key = ''
  if (isObj(raw)) {
    type = typeof raw.type === 'string' ? raw.type : undefined
    key = String(raw.id ?? raw.email ?? raw.code ?? '').trim()
  } else if (typeof raw === 'string') key = raw.trim()
  if (!key) throw invalid('Say whom to share with (a user or a team).', 'principal')
  const k = key.toLowerCase()
  if (type !== 'team') {
    const u = dir.users.find((x) => x.id === key || x.email.toLowerCase() === k)
    if (u) {
      if (u.status === 'disabled') throw invalid(`${u.name} is disabled.`, 'principal')
      return { type: 'user', id: u.id, name: u.name }
    }
  }
  if (type !== 'user') {
    const t = teams.find((x) => x.id === key || x.code.toLowerCase() === k || x.name.toLowerCase() === k)
    if (t) return { type: 'team', id: t.id, name: t.name }
  }
  throw notFound(`There is no ${type ?? 'user or team'} "${key.slice(0, 80)}" here.`)
}

function internals(s: Services): DataInternals {
  const i = (s.data as unknown as { internals?: DataInternals }).internals
  if (!i) throw new HttpError(503, 'unavailable', 'Data access is not available.')
  return i
}

/** the table and the row (raw) a share request is about; the caller must be able to read it (else 404) */
async function sharedRow(s: Services, user: UserContext, rowId: unknown, tableRef: unknown): Promise<{ table: TableDef; row: RawRow }> {
  if (typeof rowId !== 'string' || !rowId || rowId.length > 64) throw invalid('row (a row id) is required.', 'row')
  const tables = await s.meta.tables.list()
  const candidates = typeof tableRef === 'string' && tableRef
    ? tables.filter((t) => t.id === tableRef || t.name.toLowerCase() === tableRef.toLowerCase())
    : tables.filter((t) => t.sharing)
  for (const t of candidates) {
    const pred = user.rowPredicate(t, 'read')
    if ('const' in pred && !pred.const) continue
    const row = await internals(s).findRow(t, rowId, pred)
    if (row) return { table: t, row }
  }
  throw notFound('Row not found.')
}

async function canDo(s: Services, user: UserContext, table: TableDef, rowId: string, op: 'share' | 'update'): Promise<boolean> {
  const pred = user.rowPredicate(table, op)
  if ('const' in pred) return pred.const
  return (await internals(s).findRow(table, rowId, pred)) !== null
}

async function sharesOut(s: Services, table: TableDef, rowId: string): Promise<ShareDef[]> {
  const dir = await directory(s)
  return (await store(s).shares.forRow(table.id, rowId)).map((x) => ({
    ...x,
    principalName: x.principalType === 'user' ? (dir.users.find((u) => u.id === x.principalId)?.name ?? x.principalId) : (dir.teams.find((t) => t.id === x.principalId)?.name ?? x.principalId),
  }))
}

/* ------------------------------------------------------------------ explainer */

export interface ExplainUser {
  userId: string
  name: string
  email: string
  read: string[]
  update: string[]
  delete: string[]
}

const SCOPE_TEXT: Record<string, string> = {
  own: 'own rows', team: "their team's rows", manager: 'rows of their direct reports', managerTree: 'rows of their reporting line',
  department: 'rows of their department', departmentTree: 'rows of their department and the ones below it', all: 'all rows',
}

/** one line per reason; perRow: about one row ("its row rule matches"), else about the table ("limited by") */
export function reasonText(r: PredicateReason, perRow = true): string {
  if (r.kind === 'admin') return 'Administrator'
  if (r.kind === 'share') return perRow ? 'The row is shared with them (or one of their teams)' : 'Rows shared with them (or one of their teams)'
  if (r.kind === 'owner') return 'They own the row'
  return `Role "${r.roleName}": ${SCOPE_TEXT[r.scope ?? 'all'] ?? r.scope}${r.filtered ? (perRow ? ', and its row rule matches' : ', limited by its row rules') : ''}`
}

async function explainRow(s: Services, table: TableDef, rowId: string, only?: string): Promise<{ row: Record<string, QueryValue>; users: ExplainUser[] }> {
  const raw = await internals(s).findRow(table, rowId)
  if (!raw) throw notFound('Row not found.')
  const all = await s.meta.users.list()
  const env = s.environments
  const cache = new Map<string, Promise<boolean>>()
  const semi = (sj: { table: TableDef; key: string; where: Condition }, value: unknown): Promise<boolean> => {
    const key = `${sj.table.id}\u0000${sj.key}\u0000${String(value)}\u0000${JSON.stringify(sj.where)}`
    let hit = cache.get(key)
    if (!hit) {
      hit = (async () => {
        const t = internals(s).physical(sj.table)
        const conn = await internals(s).connectorFor(t)
        const res = await conn.select(t, { where: and({ col: sj.key, op: 'eq', value: String(value) }, sj.where), top: 1, select: ['id'] })
        return res.rows.length > 0
      })()
      cache.set(key, hit)
    }
    return hit
  }
  const users: ExplainUser[] = []
  for (const rec of all) {
    if (only && rec.id !== only) continue
    if (rec.status === 'disabled') continue
    const def: UserDef = { ...rec } as UserDef
    delete (def as Partial<UserRecord>).passwordHash
    if (env && !rec.isInstallAdmin && !rec.roleIds.length) continue
    const uc = await s.security.forUser(def)
    const entry: ExplainUser = { userId: rec.id, name: rec.name, email: rec.email, read: [], update: [], delete: [] }
    for (const op of ['read', 'update', 'delete'] as const) {
      for (const r of uc.reasons?.(table, op) ?? []) {
        if (await evaluateWithSemi(r.term, raw, semi)) entry[op].push(reasonText(r))
      }
    }
    if (entry.read.length || entry.update.length || entry.delete.length || only) users.push(entry)
  }
  return { row: internals(s).rowOut(null, table, raw), users }
}

/* ------------------------------------------------------------------ routes */

export function registerOrgRoutes(router: Router, s: Services): void {
  /* directory */
  router.add('GET', '/api/v1/org', async (ctx) => {
    const dir = await directory(s)
    const admin = !!ctx.user?.privileges.isAdmin
    const envId = currentEnvironment().id
    if (admin) return { departments: dir.departments, teams: dir.teams, users: dir.users }
    // everyone else: what a share picker needs (active people and the teams of this environment). The people are the
    // rows of the Users system table this user may read: people with access to this environment, narrowed by the
    // environment's directory visibility (P0 package M), never the whole install
    const usersTable = (await s.meta.tables.list()).find((t) => t.id === SYS.users)
    const visible = usersTable && ctx.user ? (await s.data.query(ctx.user, usersTable, { select: ['FullName', 'Email'], top: 5000 })).rows : []
    return {
      departments: dir.departments.map((d) => ({ id: d.id, code: d.code, name: d.name, ...(d.parentId ? { parentId: d.parentId } : {}) })),
      teams: teamsInEnvironment(dir, envId).map((t) => ({ id: t.id, code: t.code, name: t.name, memberIds: [] })),
      users: visible.map((u) => ({ id: String(u.id), name: String(u.FullName ?? ''), email: String(u.Email ?? '') })),
    }
  }, { auth: 'user' })

  /* directory visibility of the current environment (environment administrators) */
  router.add('GET', '/api/v1/environment/directory', async () => ({ visibility: (await s.meta.directoryVisibility?.get(currentEnvironment().id)) ?? 'everyone' }), { auth: 'admin' })
  router.add('PUT', '/api/v1/environment/directory', async (ctx) => {
    const b = bodyObj(ctx)
    const v = b.visibility as DirectoryVisibility
    if (!DIRECTORY_VISIBILITY.includes(v)) throw invalid(`visibility must be one of ${DIRECTORY_VISIBILITY.join(', ')}.`, 'visibility')
    if (!s.meta.directoryVisibility) throw new HttpError(503, 'unavailable', 'Directory visibility needs the server database.')
    const envId = currentEnvironment().id
    const before = await s.meta.directoryVisibility.get(envId)
    await s.meta.directoryVisibility.set(envId, v)
    s.security.invalidate({ environment: envId })
    await audit(s, ctx, 'environment.directory_visibility', { before, after: v })
    return { visibility: v }
  }, { auth: 'admin' })

  /* departments */
  router.add('POST', '/api/v1/departments', async (ctx) => {
    requireInstallAdmin(ctx, 'change departments')
    const b = bodyObj(ctx)
    const dir = await directory(s)
    const d: DepartmentDef = { id: s.uid('dept'), code: code(b, 'department'), name: reqString(b, 'name', 'The department name', 200) }
    if (dir.departments.some((x) => x.code.toLowerCase() === d.code.toLowerCase())) throw conflict(`A department with the code "${d.code}" already exists.`)
    if (b.parentId) {
      if (!dir.departments.some((x) => x.id === b.parentId)) throw notFound('The parent department was not found.')
      d.parentId = String(b.parentId)
    }
    const desc = optString(b, 'description', { max: 1000 })
    if (desc) d.description = desc
    await store(s).departments.insert(d)
    orgChanged(s)
    await audit(s, ctx, 'org.department_create', { id: d.id, code: d.code, name: d.name, parentId: d.parentId ?? null })
    return d
  }, { auth: 'user' })

  router.add('PATCH', '/api/v1/departments/:id', async (ctx) => {
    requireInstallAdmin(ctx, 'change departments')
    const b = bodyObj(ctx)
    const dir = await directory(s)
    const d = dir.departments.find((x) => x.id === ctx.params.id)
    if (!d) throw notFound('Department not found.')
    const patch: Partial<DepartmentDef> = {}
    if (b.code !== undefined) {
      patch.code = code(b, 'department')
      if (dir.departments.some((x) => x.id !== d.id && x.code.toLowerCase() === patch.code!.toLowerCase())) throw conflict(`A department with the code "${patch.code}" already exists.`)
    }
    if (b.name !== undefined) patch.name = reqString(b, 'name', 'The department name', 200)
    if (b.description !== undefined) patch.description = optString(b, 'description', { max: 1000 }) || undefined
    if (b.parentId !== undefined) {
      const parent = b.parentId === null || b.parentId === '' ? undefined : String(b.parentId)
      if (parent && !dir.departments.some((x) => x.id === parent)) throw notFound('The parent department was not found.')
      if (departmentCycle(dir, d.id, parent)) throw invalid('A department cannot be moved below itself or one of its own sub-departments.', 'parentId')
      patch.parentId = parent
    }
    await store(s).departments.update(d.id, patch)
    orgChanged(s)
    await audit(s, ctx, 'org.department_update', { id: d.id, changes: patch })
    return { ...d, ...patch }
  }, { auth: 'user' })

  router.add('DELETE', '/api/v1/departments/:id', async (ctx) => {
    requireInstallAdmin(ctx, 'change departments')
    const dir = await directory(s)
    const d = dir.departments.find((x) => x.id === ctx.params.id)
    if (!d) throw notFound('Department not found.')
    if (dir.departments.some((x) => x.parentId === d.id)) throw conflict(`"${d.name}" has sub-departments. Move or delete them first.`)
    await store(s).departments.remove(d.id)
    orgChanged(s)
    await audit(s, ctx, 'org.department_delete', { id: d.id, code: d.code, name: d.name, users: dir.users.filter((u) => u.departmentId === d.id).length })
    return { ok: true }
  }, { auth: 'user' })

  /* teams: install administrators; environment administrators for the teams of their own environment */
  const teamGuard = (ctx: Ctx, environmentId: string | undefined) => {
    if (ctx.user?.privileges.isInstallAdmin) return
    if (ctx.user?.privileges.isAdmin && environmentId === currentEnvironment().id) return
    throw new HttpError(403, 'denied', environmentId ? 'Only administrators of that environment can change its teams.' : 'Only install administrators can change teams that count in every environment.')
  }
  const readMembers = (b: Record<string, unknown>, dir: OrgDirectory): string[] | undefined => {
    if (b.memberIds === undefined) return undefined
    if (!Array.isArray(b.memberIds) || !b.memberIds.every((x) => typeof x === 'string')) throw invalid('memberIds must be a list of user ids.', 'memberIds')
    for (const id of b.memberIds as string[]) if (!dir.users.some((u) => u.id === id)) throw notFound(`User "${id}" was not found.`)
    return [...new Set(b.memberIds as string[])]
  }
  router.add('POST', '/api/v1/teams', async (ctx) => {
    const b = bodyObj(ctx)
    const envId = b.environmentId === undefined || b.environmentId === null || b.environmentId === '' ? undefined : String(b.environmentId)
    teamGuard(ctx, envId)
    const dir = await directory(s)
    const t: TeamDef = { id: s.uid('team'), code: code(b, 'team'), name: reqString(b, 'name', 'The team name', 200), memberIds: readMembers(b, dir) ?? [] }
    if (dir.teams.some((x) => x.code.toLowerCase() === t.code.toLowerCase())) throw conflict(`A team with the code "${t.code}" already exists.`)
    if (envId) {
      if (s.environments && !(await s.environments.get(envId))) throw notFound(`Environment "${envId}" was not found.`)
      t.environmentId = envId
    }
    const desc = optString(b, 'description', { max: 1000 })
    if (desc) t.description = desc
    await store(s).teams.insert(t)
    orgChanged(s)
    await audit(s, ctx, 'org.team_create', { id: t.id, code: t.code, name: t.name, environmentId: t.environmentId ?? null, members: t.memberIds.length })
    return t
  }, { auth: 'user' })

  router.add('PATCH', '/api/v1/teams/:id', async (ctx) => {
    const b = bodyObj(ctx)
    const dir = await directory(s)
    const t = dir.teams.find((x) => x.id === ctx.params.id)
    if (!t) throw notFound('Team not found.')
    teamGuard(ctx, t.environmentId)
    const patch: Partial<TeamDef> = {}
    if (b.code !== undefined) {
      patch.code = code(b, 'team')
      if (dir.teams.some((x) => x.id !== t.id && x.code.toLowerCase() === patch.code!.toLowerCase())) throw conflict(`A team with the code "${patch.code}" already exists.`)
    }
    if (b.name !== undefined) patch.name = reqString(b, 'name', 'The team name', 200)
    if (b.description !== undefined) patch.description = optString(b, 'description', { max: 1000 }) || undefined
    if (b.environmentId !== undefined) {
      const envId = b.environmentId === null || b.environmentId === '' ? undefined : String(b.environmentId)
      teamGuard(ctx, envId)
      patch.environmentId = envId
    }
    const members = readMembers(b, dir)
    if (members) patch.memberIds = members
    await store(s).teams.update(t.id, patch)
    orgChanged(s)
    const removed = members ? t.memberIds.filter((m) => !members.includes(m)) : []
    const added = members ? members.filter((m) => !t.memberIds.includes(m)) : []
    await audit(s, ctx, 'org.team_update', { id: t.id, changes: { ...patch, memberIds: undefined }, added, removed })
    return { ...t, ...patch }
  }, { auth: 'user' })

  router.add('DELETE', '/api/v1/teams/:id', async (ctx) => {
    const dir = await directory(s)
    const t = dir.teams.find((x) => x.id === ctx.params.id)
    if (!t) throw notFound('Team not found.')
    teamGuard(ctx, t.environmentId)
    await store(s).teams.remove(t.id)
    orgChanged(s)
    s.security.invalidateShares?.()
    await audit(s, ctx, 'org.team_delete', { id: t.id, code: t.code, name: t.name })
    return { ok: true }
  }, { auth: 'user' })

  /* CSV import of users */
  router.add('POST', '/api/v1/users/import', async (ctx) => {
    requireInstallAdmin(ctx, 'import user accounts')
    const b = bodyObj(ctx)
    const plan = await planUserImport(s, b.csv as string)
    if (b.commit !== true) return { preview: plan.rows, ok: plan.ok, unknownColumns: plan.unknownColumns }
    if (!plan.ok) throw invalid('The file has errors; nothing was imported. Fix them and check the preview again.', 'csv')
    const created: { email: string; name: string; temporaryPassword: string }[] = []
    let updated = 0
    await s.transaction(async () => {
      const dir = await directory(s)
      const roles = await s.meta.roles.list()
      const ids = new Map((await s.meta.users.list()).map((u) => [u.email.toLowerCase(), u.id]))
      const roleIds = (names: string[] | undefined): string[] | undefined => names?.map((n) => roles.find((r: RoleDef) => r.name.toLowerCase() === n.toLowerCase())!.id)
      // first every account (so managers inside the file exist), then the organisation fields
      for (const r of plan.rows) {
        if (r.action === 'create') {
          const pw = temporaryPassword()
          const rec: UserRecord = { id: s.uid('user'), name: r.name, email: r.email, roleIds: roleIds(r.roles) ?? [], status: 'active', passwordHash: await hashPassword(pw), mustChangePassword: true }
          await s.meta.users.insert(rec)
          ids.set(r.email, rec.id)
          created.push({ email: r.email, name: r.name, temporaryPassword: pw })
        } else {
          const id = ids.get(r.email)!
          await s.meta.users.update(id, { name: r.name, ...(r.roles ? { roleIds: roleIds(r.roles) } : {}) })
          updated++
        }
      }
      for (const r of plan.rows) {
        const dept = r.department ? (dir.departments.find((x) => x.code.toLowerCase() === r.department!.toLowerCase()) ?? dir.departments.find((x) => x.name.toLowerCase() === r.department!.toLowerCase())) : undefined
        await store(s).setUserOrg(ids.get(r.email)!, {
          ...(r.department !== undefined ? { departmentId: dept?.id ?? null } : {}),
          ...(r.manager !== undefined ? { managerId: ids.get(r.manager) ?? null } : {}),
          ...(r.jobTitle !== undefined ? { jobTitle: r.jobTitle } : {}),
          ...(r.phone !== undefined ? { phone: r.phone } : {}),
          ...(r.employeeCode !== undefined ? { employeeCode: r.employeeCode } : {}),
        })
      }
    })
    orgChanged(s)
    s.environments?.invalidate()
    await audit(s, ctx, 'user.import', { created: created.map((c) => c.email), updated })
    // the temporary passwords are in this answer only (never stored in clear, never logged)
    return { created, updated }
  }, { auth: 'admin' })

  /* shares */
  router.add('GET', '/api/v1/shares', async (ctx) => {
    const user = ctx.user!
    const { table, row } = await sharedRow(s, user, ctx.query.get('row'), ctx.query.get('table') ?? undefined)
    const id = String(row.id)
    const canShare = !!table.sharing && await canDo(s, user, table, id, 'share')
    return {
      table: table.id, row: id, sharing: !!table.sharing, canShare,
      canShareUpdate: canShare && await canDo(s, user, table, id, 'update'),
      shares: table.sharing ? await sharesOut(s, table, id) : [],
    }
  }, { auth: 'user' })

  router.add('POST', '/api/v1/shares', async (ctx) => {
    const user = ctx.user!
    const b = bodyObj(ctx)
    const { table, row } = await sharedRow(s, user, b.row, b.table)
    const id = String(row.id)
    if (!table.sharing) throw new HttpError(403, 'denied', `Sharing is off for "${table.displayName}".`)
    if (!(await canDo(s, user, table, id, 'share'))) throw new HttpError(403, 'denied', 'You are not allowed to share this row.')
    const access = b.access === undefined ? 'read' : String(b.access).toLowerCase()
    if (access !== 'read' && access !== 'update') throw invalid('access must be "read" or "update".', 'access')
    if (access === 'update' && !(await canDo(s, user, table, id, 'update'))) throw new HttpError(403, 'denied', 'You can only share for reading: you may not change this row yourself.')
    const p = await resolvePrincipal(s, b.principal)
    if (p.type === 'user' && p.id === user.user.id) throw invalid('You already have access to this row.', 'principal')
    await store(s).shares.put({ tableId: table.id, rowId: id, principalType: p.type, principalId: p.id, access, sharedBy: user.user.id })
    s.security.invalidateShares?.()
    await audit(s, ctx, 'row.share', { principalType: p.type, principalId: p.id, access }, table.id)
    return { shares: await sharesOut(s, table, id) }
  }, { auth: 'user' })

  router.add('POST', '/api/v1/shares/remove', async (ctx) => {
    const user = ctx.user!
    const b = bodyObj(ctx)
    const { table, row } = await sharedRow(s, user, b.row, b.table)
    const id = String(row.id)
    const p = await resolvePrincipal(s, b.principal)
    // whoever may share the row may take shares back; anyone may give up a share made to themself
    const self = p.type === 'user' && p.id === user.user.id
    if (!self && !(table.sharing && await canDo(s, user, table, id, 'share'))) throw new HttpError(403, 'denied', 'You are not allowed to change the sharing of this row.')
    const n = await store(s).shares.remove(table.id, id, p.type, p.id)
    s.security.invalidateShares?.()
    if (n) await audit(s, ctx, 'row.unshare', { principalType: p.type, principalId: p.id }, table.id)
    return { removed: n, shares: await sharesOut(s, table, id).catch(() => []) }
  }, { auth: 'user' })

  /* explainer */
  router.add('GET', '/api/v1/security/explain', async (ctx) => {
    const tid = ctx.query.get('table')
    const rid = ctx.query.get('row')
    if (!tid || !rid) throw invalid('Choose a table and a row.', 'row')
    const table = await s.meta.tables.get(tid)
    if (!table) throw notFound('Table not found.')
    return explainRow(s, table, rid, ctx.query.get('user') ?? undefined)
  }, { auth: 'admin' })
}

export { explainRow }
