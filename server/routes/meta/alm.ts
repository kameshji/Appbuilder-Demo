/**
 * Solutions between environments (ALM; docs/guide/maker/solutions.md, docs/admin/upgrades.md).
 *
 * A solution package carries stable ids: the solution's own id (header `id`) and the ids of its apps, tables, roles,
 * connections. Importing it into an environment matches every component by id:
 *   - nothing matches: INSTALL, the components are created with the package's ids (so the next import upgrades them);
 *   - the solution or any component exists: UPGRADE IN PLACE, after a plan the administrator reviewed (planSolution)
 *     and confirmed by its token; one transaction (schema changes included), with a pre-upgrade backup.snapshot() first.
 * Old packages without a solution id, and `asCopy`, keep the old behaviour: new instances (solutions.ts).
 */
import { createHash } from 'node:crypto'
import type { AppDef } from '../../../src/contracts.ts'
import type { AppMeta, ColumnDef, ConnectorKind, RoleDef, SolutionDef, TableDef, TablePrivilege } from '../../../src/platform/contracts.ts'
import type { PlanColumnChange, PlanItem, SolutionImportResult, SolutionPlan } from '../../../src/platform/http.ts'
import type { ConnectionRecord, Ctx, Services, UserContext } from '../../core/contracts.ts'
import type { CoreServices } from '../../core/services.ts'
import { removeTableAttachments } from '../../core/attachments.ts'
import { NO_BACKUP_MESSAGE } from '../../core/backup.ts'
import {
  IDENT, clone, conflict, invalid, isAttachmentType, isBlankCell, isObj, me, normalizeForConversion, toIdentifier, tryCoerce, uniqueIdentifier, uniqueLabel,
} from './util.ts'
import type { RoleX } from './util.ts'
import { parsePackage, readPkgApp, readPkgTables } from './packages.ts'
import type { PkgApp, PkgTable } from './packages.ts'
import { audit, createPhysical, csvToRows, importRowsSystem, pickSource, resolveConnection, unregisterTable } from './tables-core.ts'
import type { TableRows } from './tables-core.ts'
import { backfill, checkLookupValues, columnValues, dropColumnFromRoles } from './tables.ts'
import { forgetApp } from './apps.ts'
import { assertAdminRemains } from './security.ts'
import { installPkgFiles, readPkgFiles } from './solutions.ts'
import type { PkgFile } from './solutions.ts'

/* ------------------------------------------------------------------ package */

interface PkgRole { id?: string; name: string; description?: string; privileges: TablePrivilege[]; apps: string[] | 'all'; isMaker?: boolean; isAdmin?: boolean }
interface PkgConn { id?: string; name: string; connector: ConnectorKind; settings: Record<string, string> }
export interface SolutionPkg {
  head: { id: string; name: string; displayName: string; publisher?: string; version: string; description?: string }
  apps: PkgApp[]
  tables: PkgTable[]
  roles: PkgRole[]
  connections: PkgConn[]
  files: PkgFile[]
  /** sha256 of the package content (without exportedOn) */
  hash: string
}

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/

/** parses and validates the whole package; null when it is an old package without a solution id */
export function readSolutionPkg(text: unknown, s: Services): SolutionPkg | null {
  const doc = parsePackage(text, 'appbuilder/solution')
  if (!isObj(doc.solution) || typeof doc.solution.displayName !== 'string') throw invalid('The package has no solution header.')
  const head = doc.solution
  if (typeof head.id !== 'string' || !head.id) return null
  if (head.id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(head.id)) throw invalid('The solution id in the package is malformed.')
  const listOf = (v: unknown, what: string): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : (() => { throw invalid(`The package "${what}" must be a list.`) })())
  const ID = /^[A-Za-z0-9_-]{1,64}$/
  const apps = listOf(doc.apps, 'apps').map(readPkgApp)
  for (const a of apps) if (a.oldId !== undefined && !ID.test(a.oldId)) throw invalid('An app id in the package is malformed.')
  const tables = readPkgTables(doc.tables, s.now())
  for (const t of tables) if (t.def.id && !ID.test(t.def.id)) throw invalid('A table id in the package is malformed.')
  const roles: PkgRole[] = listOf(doc.roles, 'roles').map((r) => {
    if (!isObj(r) || typeof r.name !== 'string' || !r.name.trim()) throw invalid('A role in the package is malformed.')
    if (r.id !== undefined && (typeof r.id !== 'string' || !ID.test(r.id))) throw invalid('A role id in the package is malformed.')
    const privileges = (Array.isArray(r.privileges) ? r.privileges : []).filter(isObj).map((p) => {
      const scope = (v: unknown) => (v === 'own' || v === 'all' ? v : 'none')
      const out: TablePrivilege = { table: String(p.table ?? ''), create: p.create === true, read: scope(p.read), update: scope(p.update), delete: scope(p.delete) }
      if (isObj(p.columns)) out.columns = { ...(p.columns as Record<string, 'none' | 'read' | 'update'>) }
      if (Array.isArray(p.rowFilter)) out.rowFilter = clone(p.rowFilter)
      return out
    })
    return {
      ...(typeof r.id === 'string' ? { id: r.id } : {}), name: r.name.trim().slice(0, 100),
      ...(typeof r.description === 'string' && r.description ? { description: r.description } : {}),
      privileges, apps: r.apps === 'all' ? 'all' : (Array.isArray(r.apps) ? r.apps.map(String) : []),
      ...(r.isMaker ? { isMaker: true } : {}), ...(r.isAdmin ? { isAdmin: true } : {}),
    }
  })
  const connections: PkgConn[] = listOf(doc.connections, 'connections').map((c) => {
    if (!isObj(c) || typeof c.name !== 'string' || !['postgres', 'mysql', 'gsheets'].includes(String(c.connector))) throw invalid('A connection in the package is malformed.')
    const settings: Record<string, string> = {}
    for (const [k, v] of Object.entries(isObj(c.settings) ? c.settings : {})) if (typeof v === 'string') settings[k] = v
    return { ...(typeof c.id === 'string' && ID.test(c.id) ? { id: c.id } : {}), name: c.name, connector: c.connector as ConnectorKind, settings }
  })
  return {
    head: {
      id: head.id,
      name: typeof head.name === 'string' && IDENT.test(head.name) ? head.name : toIdentifier(String(head.displayName), 'Solution'),
      displayName: String(head.displayName).trim().slice(0, 200) || 'Imported solution',
      ...(typeof head.publisher === 'string' && head.publisher ? { publisher: head.publisher } : {}),
      version: typeof head.version === 'string' && VERSION_RE.test(head.version) ? head.version : '1.0.0',
      ...(typeof head.description === 'string' && head.description ? { description: head.description } : {}),
    },
    apps, tables, roles, connections, files: readPkgFiles(doc.files),
    // the content, not the text: two exports of the same solution differ only in exportedOn
    hash: createHash('sha256').update(JSON.stringify({ ...doc, exportedOn: null })).digest('hex'),
  }
}

/* ------------------------------------------------------------------ plan */

const COLUMN_PROPS: (keyof ColumnDef)[] = ['displayName', 'required', 'unique', 'default', 'choices', 'lookupTable', 'prefix', 'multiple', 'accept', 'maxSizeMB']
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function columnChanges(before: TableDef, after: TableDef): PlanColumnChange[] {
  const out: PlanColumnChange[] = []
  const b = new Map(before.columns.filter((c) => !c.system).map((c) => [c.name, c]))
  const a = new Map(after.columns.filter((c) => !c.system).map((c) => [c.name, c]))
  for (const [name, col] of b) if (!a.has(name)) out.push({ name, change: 'removed', from: col.type, destructive: true })
  for (const [name, col] of a) {
    const old = b.get(name)
    if (!old) out.push({ name, change: 'added', to: col.type })
    else if (old.type !== col.type) out.push({ name, change: 'type', from: old.type, to: col.type })
    else if (COLUMN_PROPS.some((k) => !same(old[k], col[k]))) out.push({ name, change: 'changed' })
  }
  return out
}

/** internal: what applying the plan does, per component */
interface Ops {
  /** package table id -> target table id */
  tableMap: Map<string, string>
  newTables: PkgTable[]
  changedTables: { existing: TableDef; pkg: TableDef; columns: PlanColumnChange[] }[]
  removedTables: TableDef[]
  appMap: Map<string, string>
  newApps: { app: PkgApp; id: string; name: string }[]
  changedApps: { app: PkgApp; existing: AppMeta }[]
  removedApps: string[]
  newRoles: { role: PkgRole; id: string; name: string }[]
  changedRoles: { role: PkgRole; existing: RoleX }[]
  removedRoles: RoleX[]
  connMap: Map<string, string>
  newConns: PkgConn[]
  newFiles: PkgFile[]
  existingSolution: SolutionDef | null
  canAdmin: boolean
}

export interface PlanResult { plan: SolutionPlan; ops: Ops }

/** maps a package role's privileges and apps onto the target ids (tables and apps not in the package are dropped) */
function mapRole(r: PkgRole, ops: Ops): { privileges: TablePrivilege[]; apps: string[] | 'all' } {
  const privileges = r.privileges.filter((p) => ops.tableMap.has(p.table)).map((p) => ({ ...clone(p), table: ops.tableMap.get(p.table)! }))
  const apps = r.apps === 'all' ? 'all' as const : r.apps.map((a) => ops.appMap.get(a)).filter((a): a is string => !!a)
  return { privileges, apps }
}

/** computes the plan in the current environment (nothing is changed) */
export async function planSolution(s: Services, user: UserContext, pkg: SolutionPkg): Promise<PlanResult> {
  const items: PlanItem[] = []
  const problems: string[] = []
  const warnings: string[] = []
  const canAdmin = user.privileges.isAdmin
  const [sols, tables, appList, roles, conns, files] = await Promise.all([
    s.meta.solutions.list(), s.meta.tables.list(), s.meta.apps.list(), s.meta.roles.list() as Promise<RoleX[]>, s.meta.connections.list(), s.meta.files.list(),
  ])
  const existingSolution = sols.find((x) => x.id === pkg.head.id) ?? null
  const old = existingSolution?.components ?? []
  const ops: Ops = {
    tableMap: new Map(), newTables: [], changedTables: [], removedTables: [], appMap: new Map(), newApps: [], changedApps: [], removedApps: [],
    newRoles: [], changedRoles: [], removedRoles: [], connMap: new Map(), newConns: [], newFiles: [], existingSolution, canAdmin,
  }
  let matched = !!existingSolution

  // tables
  const takenTableIds = new Set(tables.map((t) => t.id))
  for (const p of pkg.tables) {
    const byId = p.def.id ? tables.find((t) => t.id === p.def.id) : undefined
    if (byId) {
      matched = true
      ops.tableMap.set(p.def.id, byId.id)
      const columns = columnChanges(byId, p.def)
      const props = (['displayName', 'description', 'primaryColumn'] as const).filter((k) => !same(byId[k], p.def[k]))
      const nameChanged = byId.name !== p.def.name
      if (nameChanged) problems.push(`Table "${byId.displayName}" is called ${byId.name} here and ${p.def.name} in the package; renaming tables is not part of an upgrade.`)
      if (!columns.length && !props.length) {
        items.push({ kind: 'table', id: byId.id, name: byId.displayName, change: 'unchanged' })
        continue
      }
      if (columns.length && (byId.connectionId ?? '') !== 'conn_default') problems.push(`Table "${byId.displayName}" is not in the default database here, so its columns cannot be changed by an upgrade.`)
      if (columns.length && byId.readOnly) problems.push(`Table "${byId.displayName}" is linked read-only here.`)
      for (const c of columns) {
        if (c.change !== 'type') continue
        if (isAttachmentType(c.from as ColumnDef['type']) !== isAttachmentType(c.to as ColumnDef['type'])) problems.push(`${byId.displayName}.${c.name}: attachment columns cannot change to or from another type.`)
      }
      const destructive = columns.some((c) => c.destructive)
      const notes: string[] = []
      if (columns.some((c) => c.change === 'removed')) notes.push(`drops ${columns.filter((c) => c.change === 'removed').map((c) => c.name).join(', ')}: their values are lost`)
      if (columns.some((c) => c.change === 'type')) notes.push('converts values; the upgrade stops (and changes nothing) if one does not convert')
      if (props.length) notes.push(`changes ${props.join(', ')}`)
      items.push({ kind: 'table', id: byId.id, name: p.def.displayName, change: 'changed', columns, ...(destructive ? { destructive } : {}), ...(notes.length ? { note: notes.join('; ') } : {}) })
      ops.changedTables.push({ existing: byId, pkg: p.def, columns })
      continue
    }
    const byName = tables.find((t) => t.name.toLowerCase() === p.def.name.toLowerCase())
    if (byName) {
      // a table of the same name but another identity: used as it is (never changed), like older imports did
      ops.tableMap.set(p.def.id, byName.id)
      items.push({ kind: 'table', id: byName.id, name: byName.displayName, change: 'unchanged', note: 'a table with this name already exists here (another identity): it is used as it is' })
      continue
    }
    const id = p.def.id && !takenTableIds.has(p.def.id) ? p.def.id : s.uid('tbl')
    ops.tableMap.set(p.def.id || id, id)
    ops.newTables.push({ ...p, def: { ...p.def, id } })
    items.push({ kind: 'table', id, name: p.def.displayName, change: 'new', ...(p.csv ? { note: 'created with the rows in the package' } : {}) })
  }
  const pkgTableIds = new Set(pkg.tables.map((t) => ops.tableMap.get(t.def.id)))
  for (const c of old.filter((x) => x.kind === 'table')) {
    if (pkgTableIds.has(c.id)) continue
    const t = tables.find((x) => x.id === c.id)
    if (!t || t.origin?.kind === 'file') continue
    ops.removedTables.push(t)
    items.push({ kind: 'table', id: t.id, name: t.displayName, change: 'removed', destructive: true, note: (t.connectionId === 'conn_default' && t.managed) ? 'the table and all its rows are deleted' : 'the table is removed from the platform (its source is left alone)' })
  }
  // lookups must resolve once the upgrade is done
  const finalNames = new Set([...tables.filter((t) => !ops.removedTables.includes(t)).map((t) => t.name.toLowerCase()), ...ops.newTables.map((t) => t.def.name.toLowerCase())])
  for (const p of pkg.tables) for (const c of p.def.columns) if (c.type === 'lookup' && c.lookupTable && !finalNames.has(c.lookupTable.toLowerCase())) problems.push(`${p.def.displayName}.${c.displayName} looks up "${c.lookupTable}", which is neither here nor in the package.`)

  // apps
  const appNames = appList.map((a) => a.name)
  for (const a of pkg.apps) {
    const existing = a.oldId ? appList.find((x) => x.id === a.oldId) : undefined
    if (existing) {
      matched = true
      ops.appMap.set(a.oldId!, existing.id)
      const cur = await s.meta.apps.get(existing.id)
      const def = { ...clone(a.def), name: a.name }
      const changed = existing.name !== a.name || (existing.description ?? '') !== (a.description ?? '') || !same(cur?.definition, def)
      if (changed) ops.changedApps.push({ app: a, existing })
      items.push({ kind: 'app', id: existing.id, name: a.name, change: changed ? 'changed' : 'unchanged', ...(changed && existing.name !== a.name ? { note: `renamed from "${existing.name}"` } : {}) })
      continue
    }
    const id = a.oldId && !appList.some((x) => x.id === a.oldId) ? a.oldId : s.uid('app')
    const name = uniqueLabel(a.name, [...appNames, ...ops.newApps.map((n) => n.name)])
    if (a.oldId) ops.appMap.set(a.oldId, id)
    ops.newApps.push({ app: a, id, name })
    items.push({ kind: 'app', id, name, change: 'new', ...(name !== a.name ? { note: `an app named "${a.name}" exists: this one is called "${name}"` } : {}) })
  }
  const pkgAppIds = new Set([...ops.appMap.values()])
  for (const c of old.filter((x) => x.kind === 'app')) {
    if (pkgAppIds.has(c.id)) continue
    const a = appList.find((x) => x.id === c.id)
    if (!a) continue
    ops.removedApps.push(a.id)
    items.push({ kind: 'app', id: a.id, name: a.name, change: 'removed', note: 'the app is deleted' })
  }

  // roles (administrators only; never the administrator flag)
  if (pkg.roles.length && !canAdmin) warnings.push('Roles in the package are skipped: only administrators of this environment can create or change roles.')
  const roleNames = roles.map((r) => r.name)
  for (const r of pkg.roles) {
    if (r.isAdmin) warnings.push(`The administrator flag of role "${r.name}" is not imported.`)
    const existing = r.id ? roles.find((x) => x.id === r.id) : undefined
    if (existing) {
      // roles alone do not make an import an upgrade: the built-in ones have the same ids everywhere
      if (!canAdmin) continue
      const m = mapRole(r, ops)
      const keepOther = existing.privileges.filter((p) => !pkgTableIds.has(p.table) && !ops.newTables.some((t) => t.def.id === p.table))
      const nextPriv = existing.isAdmin ? [] : [...keepOther, ...m.privileges].sort((x, y) => x.table.localeCompare(y.table))
      const changed = existing.name !== r.name || (existing.description ?? '') !== (r.description ?? '') || !!existing.isMaker !== !!r.isMaker
        || !same([...existing.privileges].sort((x, y) => x.table.localeCompare(y.table)), nextPriv) || (!existing.isAdmin && !same(existing.apps, m.apps === 'all' ? 'all' : mergeApps(existing.apps, m.apps, pkgAppIds)))
      if (changed) ops.changedRoles.push({ role: r, existing })
      items.push({ kind: 'role', id: existing.id, name: r.name, change: changed ? 'changed' : 'unchanged', ...(changed ? { note: 'people who hold it keep it; its privileges on the solution tables are replaced' } : {}) })
      continue
    }
    if (!canAdmin) continue
    const id = r.id && !roles.some((x) => x.id === r.id) ? r.id : s.uid('role')
    const name = uniqueLabel(r.name, [...roleNames, ...ops.newRoles.map((n) => n.name)])
    ops.newRoles.push({ role: r, id, name })
    items.push({ kind: 'role', id, name, change: 'new' })
  }
  const pkgRoleIds = new Set(pkg.roles.map((r) => r.id).filter(Boolean))
  if (canAdmin) {
    for (const c of old.filter((x) => x.kind === 'role')) {
      if (pkgRoleIds.has(c.id)) continue
      const r = roles.find((x) => x.id === c.id)
      if (!r) continue
      ops.removedRoles.push(r)
      items.push({ kind: 'role', id: r.id, name: r.name, change: 'removed', note: 'the role is deleted; people who hold it lose it' })
    }
    if (ops.removedRoles.some((r) => r.isAdmin)) {
      try {
        const left = roles.filter((r) => !ops.removedRoles.includes(r))
        assertAdminRemains((await s.meta.users.list()).map((u) => ({ ...u, roleIds: u.roleIds.filter((x) => left.some((r) => r.id === x)) })), left)
      } catch (e) {
        problems.push((e as Error).message)
      }
    }
  }

  // connections: matched by id or name and never changed (their settings belong to the environment)
  if (pkg.connections.length && !canAdmin) warnings.push('Connections in the package are skipped: only administrators can create connections.')
  for (const c of pkg.connections) {
    const hit = (c.id ? conns.find((x) => x.id === c.id) : undefined) ?? conns.find((x) => x.name.toLowerCase() === c.name.toLowerCase() && x.connector === c.connector)
    if (hit) {
      if (c.id) ops.connMap.set(c.id, hit.id)
      items.push({ kind: 'connection', id: hit.id, name: hit.name, change: 'unchanged', note: 'kept as it is here (settings and secrets belong to this environment)' })
      continue
    }
    if (!canAdmin) continue
    ops.newConns.push(c)
    items.push({ kind: 'connection', id: c.id ?? '', name: c.name, change: 'new', note: 'created without a password or key' })
  }
  if (ops.newConns.length) warnings.push('New connections have no passwords or keys yet: edit them and enter the secrets.')

  // data files: new ones are added; existing ones are data and are left alone
  for (const f of pkg.files) {
    if (f.oldId && files.some((x) => x.id === f.oldId)) {
      items.push({ kind: 'file', id: f.oldId, name: f.fileName, change: 'unchanged', note: 'data files are data: an upgrade leaves the file here alone' })
      continue
    }
    ops.newFiles.push(f)
    items.push({ kind: 'file', id: f.oldId, name: f.fileName, change: 'new' })
  }

  const planMode: SolutionPlan['mode'] = matched ? 'upgrade' : 'install'
  if (planMode === 'upgrade' && !canAdmin) problems.push('Upgrading a solution in place changes existing apps, tables and roles: only administrators of this environment can do it.')
  const env = s.environments ? await s.environments.get(s.environment().id) : null
  const backup = s.backup
  const plan: SolutionPlan = {
    mode: planMode,
    solution: { id: pkg.head.id, name: pkg.head.name, displayName: pkg.head.displayName, version: pkg.head.version, ...(existingSolution ? { fromVersion: existingSolution.version } : {}) },
    target: { id: s.environment().id, name: env?.name ?? 'Default', type: env?.type ?? 'production', ...(env?.locked ? { locked: true } : {}) },
    items, destructive: items.some((i) => i.destructive), problems, warnings: [...new Set(warnings)],
    backup: planMode === 'upgrade'
      ? (backup?.available() ? { available: true, message: 'A backup of this environment is taken before anything changes.' } : { available: false, message: NO_BACKUP_MESSAGE })
      : { available: !!backup?.available(), message: 'Nothing here is changed: everything in the package is new.' },
    token: '',
  }
  // ids generated for new components (package entries without one) differ between two plans: not part of the token
  const fingerprint = items.map((i) => ({ ...i, id: i.change === 'new' ? '' : i.id }))
  plan.token = createHash('sha256').update(JSON.stringify({ env: plan.target.id, pkg: pkg.hash, mode: plan.mode, items: fingerprint, problems })).digest('hex').slice(0, 32)
  return { plan, ops }
}

function mergeApps(existing: string[] | 'all', fromPkg: string[], pkgAppIds: Set<string>): string[] | 'all' {
  if (existing === 'all') return 'all'
  return [...new Set([...existing.filter((a) => !pkgAppIds.has(a)), ...fromPkg])].sort()
}

/* ------------------------------------------------------------------ apply */

async function changeTable(s: Services, existing: TableDef, pkg: TableDef, columns: PlanColumnChange[]): Promise<TableDef> {
  let cur: TableDef = clone(existing)
  const needDdl = columns.length > 0
  const connector = needDdl ? (await resolveConnection(s, existing.connectionId)).connector : null
  if (connector && !connector.capabilities.ddl) throw invalid(`The connection of "${existing.displayName}" does not allow changing table structure.`)
  const label = (c: string) => `${existing.displayName}.${c}`
  for (const c of columns.filter((x) => x.change === 'removed')) {
    const next = { ...cur, columns: cur.columns.filter((x) => x.name !== c.name) }
    await connector!.dropColumn(cur, c.name)
    await dropColumnFromRoles(s, existing.id, c.name)
    cur = next
  }
  for (const c of columns.filter((x) => x.change === 'added')) {
    const col = clone(pkg.columns.find((x) => x.name === c.name)!)
    const next: TableDef = { ...cur, columns: [...cur.columns, col] }
    await connector!.addColumn(next, col)
    if (col.type === 'autonumber' || col.default !== undefined) await backfill(s, connector!, next, col)
    cur = next
  }
  for (const c of columns.filter((x) => x.change === 'type' || x.change === 'changed')) {
    const idx = cur.columns.findIndex((x) => x.name === c.name)
    const old = cur.columns[idx]
    const nextCol = clone(pkg.columns.find((x) => x.name === c.name)!)
    const typeChanged = old.type !== nextCol.type
    const uniqueChanged = !!old.unique !== !!nextCol.unique
    const lookupChanged = nextCol.type === 'lookup' && nextCol.lookupTable?.toLowerCase() !== old.lookupTable?.toLowerCase()
    if (typeChanged || uniqueChanged || lookupChanged) {
      const rows = await columnValues(connector!, cur, old.name)
      if (typeChanged && nextCol.type === 'autonumber' && rows.length) throw invalid(`${label(c.name)}: a column can only become an autonumber while the table is empty.`)
      if (typeChanged) {
        for (const [i, r] of rows.entries()) {
          const res = tryCoerce(nextCol, r.v as string | number | boolean | Date | null, old)
          if (!res.ok) throw invalid(`${label(c.name)}: cannot change the type: row ${i + 1}: ${res.message}`)
          if (typeof r.v === 'string' && res.value !== null && ['number', 'decimal', 'currency', 'boolean', 'date', 'datetime'].includes(nextCol.type)) {
            const n = normalizeForConversion(nextCol, r.v)
            if (n !== null && n !== r.v) await connector!.update(cur, r.id, { [old.name]: n })
          }
        }
      }
      if ((typeChanged || lookupChanged) && nextCol.type === 'lookup') await checkLookupValues(s, nextCol, rows.map((r) => r.v))
      if (nextCol.unique && (uniqueChanged || typeChanged)) {
        const seen = new Set<string>()
        for (const r of rows) {
          if (isBlankCell(r.v)) continue
          const k = r.v instanceof Date ? String(r.v.getTime()) : String(r.v).trim().toLowerCase()
          if (seen.has(k)) throw invalid(`${label(c.name)}: cannot become unique, the value "${String(r.v)}" appears more than once.`)
          seen.add(k)
        }
      }
    }
    const cols = [...cur.columns]
    cols[idx] = nextCol
    const next: TableDef = { ...cur, columns: cols }
    if (typeChanged || uniqueChanged) await connector!.alterColumn(next, old, nextCol)
    cur = next
  }
  // the order of columns follows the package; table properties too
  const order = new Map(pkg.columns.map((c, i) => [c.name, i]))
  cur.columns = [...cur.columns].sort((a, b) => (order.get(a.name) ?? -1) - (order.get(b.name) ?? -1))
  cur.displayName = pkg.displayName
  if (pkg.description) cur.description = pkg.description
  else delete cur.description
  if (cur.columns.some((c) => c.name === pkg.primaryColumn)) cur.primaryColumn = pkg.primaryColumn
  cur.modifiedOn = s.now()
  await s.meta.tables.upsert(cur)
  return cur
}

/**
 * Applies a plan computed by planSolution in the current environment, inside one transaction (s.transaction):
 * PostgreSQL DDL is transactional, so a failure anywhere leaves the environment exactly as it was.
 */
export async function applySolution(s: Services, ctx: Ctx, pkg: SolutionPkg, res: PlanResult, filesAs: 'database' | 'file'): Promise<SolutionImportResult> {
  const { plan, ops } = res
  const u = me(ctx)
  let backup: { taken: boolean; message: string } | undefined
  if (plan.mode === 'upgrade') {
    backup = s.backup ? await s.backup.snapshot(s.environment(), `upgrade of solution ${pkg.head.displayName} to ${pkg.head.version}`) : { taken: false, message: NO_BACKUP_MESSAGE }
  }
  const removedTables: TableDef[] = []
  const undo: (() => Promise<void>)[] = []
  let result: SolutionDef
  try {
    result = await s.transaction(async () => {
      const components: SolutionDef['components'] = []
      const { record, connector } = ops.newTables.length ? await resolveConnection(s) : { record: null as ConnectionRecord | null, connector: null }
      const rows: TableRows[] = []
      for (const p of ops.newTables) {
        const now = s.now()
        const def: TableDef = { ...clone(p.def), createdOn: now, modifiedOn: now, connectionId: record!.id }
        def.source = await pickSource(s, record!, connector!, def.name)
        await createPhysical(s, record!, connector!, def)
        if (p.csv) rows.push({ def, rows: csvToRows(def, p.csv) })
      }
      if (rows.length) await importRowsSystem(s, rows, u.user.id)
      for (const c of ops.changedTables) await changeTable(s, c.existing, c.pkg, c.columns)
      for (const t of pkg.tables) components.push({ kind: 'table', id: ops.tableMap.get(t.def.id)! })
      for (const t of ops.removedTables) {
        if (t.connectionId === 'conn_default' && t.managed) {
          const { connector: c } = await resolveConnection(s, t.connectionId)
          await c.dropTable(t)
        }
        await unregisterTable(s, t)
        removedTables.push(t)
      }

      if (ops.newFiles.length) await installPkgFiles(s, ops.newFiles, filesAs, ops.tableMap, components, undo)

      const now = s.now()
      for (const n of ops.newApps) {
        const def: AppDef = { ...clone(n.app.def), name: n.name }
        const meta: AppMeta = { id: n.id, name: n.name, width: def.width, height: def.height, createdOn: now, modifiedOn: now, modifiedBy: u.user.name, ...(n.app.description ? { description: n.app.description } : {}) }
        await s.meta.apps.upsert(meta, def)
      }
      for (const c of ops.changedApps) {
        const def: AppDef = { ...clone(c.app.def), name: c.app.name }
        const meta: AppMeta = { ...c.existing, name: c.app.name, width: def.width, height: def.height, modifiedOn: now, modifiedBy: u.user.name }
        if (c.app.description) meta.description = c.app.description
        else delete meta.description
        await s.meta.apps.upsert(meta, def)
      }
      for (const id of ops.removedApps) {
        await s.meta.apps.remove(id)
        await forgetApp(s, id)
      }
      for (const a of pkg.apps) {
        const id = a.oldId ? ops.appMap.get(a.oldId) : undefined
        if (id) components.push({ kind: 'app', id })
      }
      for (const n of ops.newApps) if (!n.app.oldId) components.push({ kind: 'app', id: n.id })

      if (ops.canAdmin) {
        const pkgAppIds = new Set([...ops.appMap.values()])
        const pkgTableIds = new Set([...ops.tableMap.values()])
        for (const n of ops.newRoles) {
          const m = mapRole(n.role, ops)
          // default privileges for the tables of this environment, then the package's for the solution tables
          const tables = await s.meta.tables.list()
          const privileges = [
            ...tables.filter((t) => !m.privileges.some((p) => p.table === t.id)).map((t) => ({ table: t.id, create: false, read: 'none' as const, update: 'none' as const, delete: 'none' as const })),
            ...m.privileges,
          ]
          const role: RoleX = { id: n.id, name: n.name, privileges, apps: m.apps, ...(n.role.description ? { description: n.role.description } : {}), ...(n.role.isMaker ? { isMaker: true } : {}) }
          await s.meta.roles.upsert(role)
        }
        for (const c of ops.changedRoles) {
          const m = mapRole(c.role, ops)
          const next: RoleX = { ...c.existing, name: c.role.name }
          if (c.role.description) next.description = c.role.description
          else delete next.description
          if (c.role.isMaker) next.isMaker = true
          else delete (next as RoleX & { isMaker?: boolean }).isMaker
          if (!c.existing.isAdmin) {
            next.privileges = [...c.existing.privileges.filter((p) => !pkgTableIds.has(p.table)), ...m.privileges]
            next.apps = m.apps === 'all' ? 'all' : mergeApps(c.existing.apps, m.apps, pkgAppIds)
          }
          await s.meta.roles.upsert(next as RoleDef)
        }
        for (const r of ops.removedRoles) await s.meta.roles.remove(r.id)
        for (const r of pkg.roles) {
          const id = (r.id ? (ops.changedRoles.find((c) => c.existing.id === r.id)?.existing.id ?? (await s.meta.roles.get(r.id))?.id) : undefined) ?? ops.newRoles.find((n) => n.role === r)?.id
          if (id) components.push({ kind: 'role', id })
        }
        const existingConns = await s.meta.connections.list()
        for (const c of pkg.connections) {
          const hit = c.id ? ops.connMap.get(c.id) : undefined
          if (hit) {
            components.push({ kind: 'connection', id: hit })
            continue
          }
          if (!ops.newConns.includes(c)) continue
          const id = c.id && !existingConns.some((x) => x.id === c.id) ? c.id : s.uid('conn')
          const rec: ConnectionRecord = {
            id, name: uniqueLabel(c.name.trim().slice(0, 100), existingConns.map((x) => x.name)), connector: c.connector, status: 'not-configured',
            settings: c.settings, isDefault: false, scope: 'server',
          }
          await s.meta.connections.upsert(rec)
          existingConns.push(rec)
          components.push({ kind: 'connection', id })
        }
      }

      const sols = await s.meta.solutions.list()
      const prev = ops.existingSolution
      const sol: SolutionDef = {
        id: pkg.head.id,
        name: prev?.name ?? uniqueIdentifier(pkg.head.name, sols.map((x) => x.name)),
        displayName: prev ? pkg.head.displayName : uniqueLabel(pkg.head.displayName, sols.map((x) => x.displayName)),
        publisher: pkg.head.publisher ?? prev?.publisher ?? u.user.name,
        version: pkg.head.version,
        ...(pkg.head.description ? { description: pkg.head.description } : {}),
        components: dedupe(components), createdOn: prev?.createdOn ?? now, modifiedOn: now,
      }
      await s.meta.solutions.upsert(sol)
      s.security.invalidate()
      const summary = { new: plan.items.filter((i) => i.change === 'new').length, changed: plan.items.filter((i) => i.change === 'changed').length, removed: plan.items.filter((i) => i.change === 'removed').length }
      await audit(s, ctx, plan.mode === 'upgrade' ? 'solution.upgrade' : 'solution.install', {
        id: sol.id, name: sol.name, version: sol.version, ...(plan.solution.fromVersion ? { fromVersion: plan.solution.fromVersion } : {}), ...summary,
        destructive: plan.destructive, items: plan.items.filter((i) => i.change !== 'unchanged').map((i) => ({ kind: i.kind, id: i.id, change: i.change, ...(i.destructive ? { destructive: true } : {}) })),
        ...(backup ? { backup: backup.taken ? 'taken' : 'none' } : {}),
      })
      return sol
    })
  } catch (e) {
    for (const f of undo.reverse()) await f().catch(() => {})
    s.security.invalidate()
    throw e
  }
  // attachment files are not in the database: removed after the commit
  for (const t of removedTables) {
    if ('internals' in s.data) await removeTableAttachments(s as CoreServices, t.id).catch(() => 0)
  }
  s.security.invalidate()
  const warnings = [...plan.warnings, ...(backup && !backup.taken ? [backup.message] : [])]
  return { ...result, ...(warnings.length ? { warnings } : {}), plan, ...(backup ? { backup } : {}) }
}

function dedupe(list: SolutionDef['components']): SolutionDef['components'] {
  const seen = new Set<string>()
  return list.filter((c) => {
    const k = `${c.kind}:${c.id}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * The import route for a package with stable ids: plans in the current environment; an upgrade needs `confirm` equal
 * to the plan's token (409 otherwise: the client shows the plan first); problems refuse it (422).
 */
export async function importStable(s: Services, ctx: Ctx, pkg: SolutionPkg, o: { confirm?: unknown; filesAs: 'database' | 'file' }): Promise<SolutionImportResult> {
  const res = await planSolution(s, me(ctx), pkg)
  if (res.plan.problems.length) throw invalid(`The solution cannot be imported here: ${res.plan.problems.join(' ')}`)
  if (res.plan.mode === 'upgrade' && o.confirm !== res.plan.token) {
    throw conflict(o.confirm === undefined
      ? `"${pkg.head.displayName}" already exists in this environment: review the upgrade plan and confirm it.`
      : 'This environment or the package changed since the plan was made. Review the new plan and confirm it again.')
  }
  return applySolution(s, ctx, pkg, res, o.filesAs)
}
