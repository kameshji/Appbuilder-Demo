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
import { PACKAGE_CONNECTORS, importConnectionActions } from '../../core/actions/solution-parts.ts'
import { SYSTEM_TABLES } from '../../../src/platform/system-tables.ts'
import { prepareViewDef, relationshipPlanLines, restorePkgRelationships } from '../../core/model/packages.ts'
import { setRecycleDays } from '../../core/recycle.ts'
import { RECYCLABLE_SYSTEM_TABLES } from '../../../src/platform/system-tables.ts'
import { createSummary, fillDateDimension, setUniqueTogether } from '../../core/model/engine.ts'
import { isSystemColumn } from '../../../src/model/ops.ts'
import type { ReportingDef } from '../../../src/model/types.ts'
import { createHash } from 'node:crypto'
import type { AppDef } from '../../../src/contracts.ts'
import type { AccessScope, AppMeta, ColumnDef, ConnectorKind, RoleDef, SolutionDef, TableDef, TablePrivilege } from '../../../src/platform/contracts.ts'
import type { PlanColumnChange, PlanItem, SolutionImportResult, SolutionPlan } from '../../../src/platform/http.ts'
import type { ConnectionRecord, Ctx, Services, UserContext } from '../../core/contracts.ts'
import { HttpError } from '../../core/contracts.ts'
import type { CoreServices } from '../../core/services.ts'
import { removeTableAttachments } from '../../core/attachments.ts'
import { NO_BACKUP_MESSAGE } from '../../core/backup.ts'
import {
  IDENT, clone, conflict, invalid, isAttachmentType, isBlankCell, isObj, me, normalizeForConversion, toIdentifier, tryCoerce, uniqueIdentifier, uniqueLabel,
} from './util.ts'
import type { RoleX } from './util.ts'
import { parsePackage, readPkgApp, readPkgTables } from './packages.ts'
import type { PkgApp, PkgEvent, PkgTable } from './packages.ts'
import type { TableEventDef } from '../../../src/platform/events.ts'
import { audit, createPhysical, csvToRows, importRowsSystem, pickSource, resolveConnection, unregisterTable } from './tables-core.ts'
import type { TableRows } from './tables-core.ts'
import { backfill, checkLookupValues, columnValues, dropColumnFromRoles } from './tables.ts'
import { forgetApp } from './apps.ts'
import { assertAdminRemains } from './security.ts'
import { installPkgFiles, readPkgFiles } from './solutions.ts'
import { afterApplyFlows, applyFlows, planFlows, readPkgFlows, type FlowPlanOps, type PkgFlow } from '../../core/flows/alm.ts'
import { applyApprovalPolicies, planApprovalPolicies, readPkgApprovalPolicies, type ApprovalPolicyOps, type PkgApprovalPolicy } from '../../core/approvals/alm.ts'
import { applyPrintTemplates, planPrintTemplates, readPkgPrintTemplates, type PrintTemplateOps, type PkgPrintTemplate } from '../../core/print/alm.ts'
import { DASHBOARD_KIND, applyDashboards, planDashboards, readPkgDashboards, type DashboardOps, type PkgDashboard } from '../../core/dashboards/alm.ts'
import type { PkgFile } from './solutions.ts'
import { SEQUENCE_KIND, applySequences, planSequences, readPkgSequences, type PkgSequence, type SequenceOps } from '../../core/templates/sequences.ts'

/* ------------------------------------------------------------------ package */

const PKG_SCOPES: AccessScope[] = ['own', 'team', 'manager', 'managerTree', 'department', 'departmentTree', 'all']
interface PkgRole { id?: string; name: string; description?: string; privileges: TablePrivilege[]; apps: string[] | 'all'; isMaker?: boolean; isAdmin?: boolean }
interface PkgConn { id?: string; name: string; connector: ConnectorKind; settings: Record<string, string>; actions?: unknown[] }
export interface SolutionPkg {
  head: { id: string; name: string; displayName: string; publisher?: string; version: string; description?: string }
  apps: PkgApp[]
  tables: PkgTable[]
  roles: PkgRole[]
  connections: PkgConn[]
  files: PkgFile[]
  /** P1-A flows; undefined: an older package without a flows list (the solution's flows are left alone) */
  flows?: PkgFlow[]
  /** P1-C approval policies; undefined: an older package (the solution's policies are left alone) */
  approvalPolicies?: PkgApprovalPolicy[]
  /** P2-B */
  printTemplates?: PkgPrintTemplate[]
  /** P2-C; undefined: an older package (the solution's dashboards are left alone) */
  dashboards?: PkgDashboard[]
  /** P3-M1: number sequences (name and format, never the next value); undefined: the solution's are left alone */
  numberSequences?: PkgSequence[]
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
      const scope = (v: unknown): AccessScope => (PKG_SCOPES.includes(v as AccessScope) ? (v as AccessScope) : 'none')
      const out: TablePrivilege = { table: String(p.table ?? ''), create: p.create === true, read: scope(p.read), update: scope(p.update), delete: scope(p.delete) }
      // organisation scopes, relationship rules and the share privilege travel as they are: rules name tables by
      // name and departments / teams by code (tokens @department:<code>, @team:<code>), so they survive the move
      if (scope(p.share) !== 'none') out.share = scope(p.share)
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
    if (!isObj(c) || typeof c.name !== 'string' || !PACKAGE_CONNECTORS.includes(String(c.connector))) throw invalid('A connection in the package is malformed.')
    const settings: Record<string, string> = {}
    for (const [k, v] of Object.entries(isObj(c.settings) ? c.settings : {})) if (typeof v === 'string') settings[k] = v
    return { ...(typeof c.id === 'string' && ID.test(c.id) ? { id: c.id } : {}), name: c.name, connector: c.connector as ConnectorKind, settings, ...(Array.isArray(c.actions) ? { actions: c.actions } : {}) }
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
    apps, tables, roles, connections, files: readPkgFiles(doc.files), flows: readPkgFlows(doc.flows), approvalPolicies: readPkgApprovalPolicies(doc.approvalPolicies), printTemplates: readPkgPrintTemplates(doc.printTemplates), dashboards: readPkgDashboards(doc.dashboards), numberSequences: readPkgSequences(doc.numberSequences),
    // the content, not the text: two exports of the same solution differ only in exportedOn
    hash: createHash('sha256').update(JSON.stringify({ ...doc, exportedOn: null })).digest('hex'),
  }
}

/* ------------------------------------------------------------------ plan */

const COLUMN_PROPS: (keyof ColumnDef)[] = ['displayName', 'required', 'unique', 'indexed', 'default', 'choices', 'lookupTable', 'prefix', 'multiple', 'accept', 'maxSizeMB', 'computed']
/** table properties an upgrade carries (F: team ownership, sharing) */
const TABLE_PROPS = ['displayName', 'description', 'primaryColumn', 'teamOwnership', 'sharing', 'recycleDays'] as const
const EVENT_PROPS = ['name', 'kind', 'timing', 'operations', 'order', 'enabled', 'condition', 'actions', 'message', 'field', 'runAs', 'description'] as const
/** JSON with object keys sorted: definitions read back from jsonb come with their keys in another order */
const canonical = (v: unknown): string => JSON.stringify(v ?? null, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x))
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)

/**
 * Reporting settings (package K) in a comparable form: package table ids mapped to this environment's, the physical base
 * name (filled in here) left out. Undefined: the table has none.
 */
function normReporting(r: ReportingDef | undefined, map?: Map<string, string>): ReportingDef | undefined {
  if (!r) return undefined
  const m = (id: string) => map?.get(id) ?? id
  if (r.kind === 'view') {
    const { baseSource: _b, baseRecycle: _r, ...rest } = r as ReportingDef & { baseSource?: string; baseRecycle?: boolean }
    return { ...rest, base: m(r.base) } as ReportingDef
  }
  if (r.kind === 'summary') return { ...r, source: m(r.source) }
  return { ...r }
}

function columnChanges(before: TableDef, after: TableDef): PlanColumnChange[] {
  const out: PlanColumnChange[] = []
  // the platform columns of a system table (locked) are never part of an upgrade: only columns makers added
  const b = new Map(before.columns.filter((c) => !c.system && !c.locked).map((c) => [c.name, c]))
  const a = new Map(after.columns.filter((c) => !c.system && !c.locked).map((c) => [c.name, c]))
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
  changedTables: { existing: TableDef; pkg: TableDef; columns: PlanColumnChange[]; reporting?: boolean }[]
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
  /** table events per target table: created or replaced, removed */
  eventOps: { tableId: string; upsert: PkgEvent[]; remove: TableEventDef[] }[]
  existingSolution: SolutionDef | null
  canAdmin: boolean
  /** P1-A: flows to create, upgrade, remove and the connection mapping */
  flowOps?: FlowPlanOps
  /** P1-C: approval policies to create, change, remove */
  approvalOps?: ApprovalPolicyOps
  printOps?: PrintTemplateOps
  dashboardOps?: DashboardOps
  /** P3-M1 */
  sequenceOps?: SequenceOps
}

export interface PlanResult { plan: SolutionPlan; ops: Ops }

/** maps a package role's privileges and apps onto the target ids (tables and apps not in the package are dropped) */
function mapRole(r: PkgRole, ops: Ops): { privileges: TablePrivilege[]; apps: string[] | 'all' } {
  const privileges = r.privileges.filter((p) => ops.tableMap.has(p.table)).map((p) => ({ ...clone(p), table: ops.tableMap.get(p.table)! }))
  const apps = r.apps === 'all' ? 'all' as const : r.apps.map((a) => ops.appMap.get(a)).filter((a): a is string => !!a)
  return { privileges, apps }
}

/** computes the plan in the current environment (nothing is changed) */
export interface FlowImportOptions {
  connectionMap?: Record<string, string>; enableFlows?: boolean | string[]; peopleMap?: Record<string, string>
  /** P3-M1: names of tables that exist by the time this package is applied (a dependency installed first, in the same transaction) */
  expectTables?: string[]
}

export async function planSolution(s: Services, user: UserContext, pkg: SolutionPkg, flowOpts: FlowImportOptions = {}): Promise<PlanResult> {
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
    newRoles: [], changedRoles: [], removedRoles: [], connMap: new Map(), newConns: [], newFiles: [], eventOps: [], existingSolution, canAdmin,
  }
  let matched = !!existingSolution

  // tables
  const takenTableIds = new Set(tables.map((t) => t.id))
  for (const p of pkg.tables) {
    const byId = p.def.id ? tables.find((t) => t.id === p.def.id) : undefined
    if (byId) {
      matched = true
      ops.tableMap.set(p.def.id, byId.id)
      const view = byId.reporting?.kind === 'view'
      const columns = columnChanges(byId, p.def)
      const props: string[] = byId.system ? [] : TABLE_PROPS.filter((k) => !same(byId[k], p.def[k]))
      // unique pairs (package K) travel with the schema; reporting settings are compared once every table is mapped
      if (!byId.system && !view && !same(byId.uniqueTogether, p.def.uniqueTogether)) props.push('uniqueTogether')
      if (!byId.system && (byId.reporting?.kind ?? null) !== (p.def.reporting?.kind ?? null)) {
        problems.push(`Table "${byId.displayName}" is ${byId.reporting ? `a ${byId.reporting.kind} table` : 'a plain table'} here and ${p.def.reporting ? `a ${p.def.reporting.kind} table` : 'a plain table'} in the package; changing what kind of table it is is not part of an upgrade.`)
      }
      const nameChanged = !byId.system && byId.name !== p.def.name
      if (nameChanged) problems.push(`Table "${byId.displayName}" is called ${byId.name} here and ${p.def.name} in the package; renaming tables is not part of an upgrade.`)
      if (!columns.length && !props.length) {
        items.push({ kind: 'table', id: byId.id, name: byId.displayName, change: 'unchanged' })
        continue
      }
      if ((columns.length || props.includes('uniqueTogether')) && (byId.connectionId ?? '') !== 'conn_default') problems.push(`Table "${byId.displayName}" is not in the default database here, so its columns cannot be changed by an upgrade.`)
      // reporting tables (views, summaries, date dimensions) are read-only for apps, not for an upgrade
      if (columns.length && byId.readOnly && !byId.reporting) problems.push(`Table "${byId.displayName}" is linked read-only here.`)
      for (const c of columns) {
        if (c.change !== 'type') continue
        if (isAttachmentType(c.from as ColumnDef['type']) !== isAttachmentType(c.to as ColumnDef['type'])) problems.push(`${byId.displayName}.${c.name}: attachment columns cannot change to or from another type.`)
      }
      const destructive = columns.some((c) => c.destructive)
      const notes: string[] = []
      if (columns.some((c) => c.change === 'removed')) notes.push(`drops ${columns.filter((c) => c.change === 'removed').map((c) => c.name).join(', ')}: their values are lost`)
      if (columns.some((c) => c.change === 'type') && !view) notes.push('converts values; the upgrade stops (and changes nothing) if one does not convert')
      if (view && columns.length) notes.push('the reporting view is re-created from its new columns')
      if (props.includes('uniqueTogether')) notes.push('unique pairs change: the upgrade stops (and changes nothing) if existing rows repeat a pair')
      if (props.length) notes.push(`changes ${props.join(', ')}`)
      items.push({ kind: 'table', id: byId.id, name: p.def.displayName, change: 'changed', columns, ...(destructive ? { destructive } : {}), ...(notes.length ? { note: notes.join('; ') } : {}) })
      ops.changedTables.push({ existing: byId, pkg: p.def, columns })
      continue
    }
    if (p.def.system) {
      problems.push(`The system table "${p.def.displayName}" is missing here; upgrade this environment first.`)
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
  // reporting settings (views, summaries, date dimensions): compared with package ids mapped to this environment's
  for (const p of pkg.tables) {
    const target = ops.tableMap.get(p.def.id)
    const byId = target && p.def.id === target ? tables.find((t) => t.id === target) : undefined
    if (!byId || byId.system || (byId.reporting?.kind ?? null) !== (p.def.reporting?.kind ?? null)) continue
    if (same(normReporting(byId.reporting), normReporting(p.def.reporting, ops.tableMap))) continue
    const what = byId.reporting?.kind === 'date' ? 'the date range or fiscal year changes: the days are filled again'
      : byId.reporting?.kind === 'summary' ? 'the summary settings change: its schedule is updated and it is refreshed'
        : 'the reporting view is re-created from its new definition'
    const changed = ops.changedTables.find((c) => c.existing.id === byId.id)
    const item = items.find((i) => i.kind === 'table' && i.id === byId.id)!
    if (changed) {
      changed.reporting = true
      item.note = item.note ? `${item.note}; ${what}` : what
    } else {
      ops.changedTables.push({ existing: byId, pkg: p.def, columns: [], reporting: true })
      Object.assign(item, { change: 'changed', name: p.def.displayName, note: what })
    }
  }
  const pkgTableIds = new Set(pkg.tables.map((t) => ops.tableMap.get(t.def.id)))
  for (const c of old.filter((x) => x.kind === 'table')) {
    if (pkgTableIds.has(c.id)) continue
    const t = tables.find((x) => x.id === c.id)
    if (!t || t.origin?.kind === 'file' || t.system) continue
    ops.removedTables.push(t)
    items.push({ kind: 'table', id: t.id, name: t.displayName, change: 'removed', destructive: true, note: (t.connectionId === 'conn_default' && t.managed) ? 'the table and all its rows are deleted' : 'the table is removed from the platform (its source is left alone)' })
  }
  // lookups must resolve once the upgrade is done
  const finalNames = new Set([...tables.filter((t) => !ops.removedTables.includes(t)).map((t) => t.name.toLowerCase()), ...ops.newTables.map((t) => t.def.name.toLowerCase())])
  // the core data model's tables (Users, Teams ...) are in every environment
  for (const n of SYSTEM_TABLES.map((t) => t.name.toLowerCase())) finalNames.add(n)
  for (const n of flowOpts.expectTables ?? []) finalNames.add(n.toLowerCase())
  for (const p of pkg.tables) for (const c of p.def.columns) if (c.type === 'lookup' && c.lookupTable && !c.system && !finalNames.has(c.lookupTable.toLowerCase())) problems.push(`${p.def.displayName}.${c.displayName} looks up "${c.lookupTable}", which is neither here nor in the package.`)

  // table events and validation rules of the solution's tables (package G): matched by id within the table
  const systemEvents: string[] = []
  for (const p of pkg.tables) {
    const target = ops.tableMap.get(p.def.id)
    if (!target) continue
    const isNew = ops.newTables.some((t) => t.def.id === target)
    if (!isNew && !(p.def.id && tables.some((t) => t.id === p.def.id))) continue // a table of another identity is used as it is
    if (p.events === undefined && isNew) continue
    const existing = isNew || !s.kernel ? [] : await s.kernel.listEvents(target)
    const op: Ops['eventOps'][number] = { tableId: target, upsert: [], remove: [] }
    const label = (n: string) => `${p.def.displayName}: ${n}`
    for (const e of p.events ?? []) {
      const cur = e.id ? existing.find((x) => x.id === e.id) : undefined
      const changed = !cur || EVENT_PROPS.some((k) => !same(cur[k], e[k]))
      const system = e.runAs === 'system'
      items.push({
        kind: 'event', id: cur?.id ?? e.id ?? '', name: label(e.name ?? ''), change: !cur ? 'new' : changed ? 'changed' : 'unchanged',
        ...(system ? { note: 'runs as the system: ignores row and column security' } : {}),
      })
      if (!changed) continue
      op.upsert.push(e)
      if (system && e.enabled !== false) systemEvents.push(label(e.name ?? ''))
    }
    // a package without an events list (older exports) leaves the events here alone
    if (p.events !== undefined) {
      for (const x of existing) {
        if ((p.events ?? []).some((e) => e.id === x.id)) continue
        op.remove.push(x)
        items.push({ kind: 'event', id: x.id, name: label(x.name), change: 'removed', note: x.kind === 'validation' ? 'the validation rule is deleted' : 'the event is deleted' })
      }
    }
    if (op.upsert.length || op.remove.length) ops.eventOps.push(op)
  }
  if (systemEvents.length) {
    if (!canAdmin) problems.push(`The table events ${systemEvents.join(', ')} run as the system: only an administrator of this environment can import them.`)
    else warnings.push(`The table events ${systemEvents.join(', ')} run as the system (they ignore row and column security): confirm them explicitly.`)
  }

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

  // flows (P1-A): definitions, connection references mapped to this environment, service-account run-as
  const fp = await planFlows(s, user, pkg.flows, old.filter((x) => x.kind === 'flow').map((x) => x.id), flowOpts)
  items.push(...fp.items)
  problems.push(...fp.problems)
  warnings.push(...fp.warnings)
  if (fp.matched) matched = true
  ops.flowOps = fp.ops
  // approval policies (P1-C): people by email, flagged when they have no account here
  const ap = await planApprovalPolicies(s, user, pkg.approvalPolicies, old.filter((x) => x.kind === 'approvalPolicy').map((x) => x.id), { peopleMap: flowOpts.peopleMap })
  items.push(...ap.items)
  problems.push(...ap.problems)
  warnings.push(...ap.warnings)
  if (ap.matched) matched = true
  ops.approvalOps = ap.ops
  // print templates (P2-B)
  const pp = await planPrintTemplates(s, user, pkg.printTemplates, old.filter((x) => x.kind === 'printTemplate').map((x) => x.id))
  items.push(...pp.items)
  problems.push(...pp.problems)
  warnings.push(...pp.warnings)
  if (pp.matched) matched = true
  ops.printOps = pp.ops
  // dashboards (P2-C): viewer roles by id, then name; tables of the tiles checked against this environment and the package
  const dp = await planDashboards(s, user, pkg.dashboards, old.filter((x) => (x.kind as string) === DASHBOARD_KIND).map((x) => x.id), pkg.roles, pkg.tables.flatMap((t) => [t.def.id, t.def.name].filter(Boolean)))
  items.push(...dp.items)
  problems.push(...dp.problems)
  warnings.push(...dp.warnings)
  if (dp.matched) matched = true
  ops.dashboardOps = dp.ops
  // number sequences (P3-M1)
  const sp = await planSequences(s, user, pkg.numberSequences, old.filter((x) => (x.kind as string) === SEQUENCE_KIND).map((x) => x.id))
  items.push(...sp.items)
  problems.push(...sp.problems)
  warnings.push(...sp.warnings)
  if (sp.matched) matched = true
  ops.sequenceOps = sp.ops

  const planMode: SolutionPlan['mode'] = matched ? 'upgrade' : 'install'
  if (planMode === 'upgrade' && !canAdmin) problems.push('Upgrading a solution in place changes existing apps, tables and roles: only administrators of this environment can do it.')
  const env = s.environments ? await s.environments.get(s.environment().id) : null
  const backup = s.backup
  const plan: SolutionPlan = {
    mode: planMode,
    solution: { id: pkg.head.id, name: pkg.head.name, displayName: pkg.head.displayName, version: pkg.head.version, ...(existingSolution ? { fromVersion: existingSolution.version } : {}) },
    target: { id: s.environment().id, name: env?.name ?? 'Default', type: env?.type ?? 'production', ...(env?.locked ? { locked: true } : {}) },
    items, destructive: items.some((i) => i.destructive), problems, warnings: [...new Set([...warnings, ...(await relationshipPlanLines(s, pkg.tables, ops.tableMap))])],
    backup: planMode === 'upgrade'
      ? (backup?.available() ? { available: true, message: 'A backup of this environment is taken before anything changes.' } : { available: false, message: NO_BACKUP_MESSAGE })
      : { available: !!backup?.available(), message: 'Nothing here is changed: everything in the package is new.' },
    token: '',
    ...(systemEvents.length ? { systemEvents } : {}),
    ...(fp.serviceFlows.length ? { serviceFlows: fp.serviceFlows } : {}),
    ...(fp.connections.length ? { flowConnections: fp.connections } : {}),
    ...(ap.people.length ? { approvalPeople: ap.people } : {}),
  }
  // ids generated for new components (package entries without one) differ between two plans: not part of the token
  const fingerprint = items.map((i) => ({ ...i, id: i.change === 'new' ? '' : i.id }))
  plan.token = createHash('sha256').update(JSON.stringify({ env: plan.target.id, pkg: pkg.hash, mode: plan.mode, items: fingerprint, problems, flows: fp.connections.map((c) => [c.from, c.to]), enable: flowOpts.enableFlows ?? null, people: ap.people.map((p) => [p.email, p.to]) })).digest('hex').slice(0, 32)
  return { plan, ops }
}

function mergeApps(existing: string[] | 'all', fromPkg: string[], pkgAppIds: Set<string>): string[] | 'all' {
  if (existing === 'all') return 'all'
  return [...new Set([...existing.filter((a) => !pkgAppIds.has(a)), ...fromPkg])].sort()
}

/* ------------------------------------------------------------------ apply */

/** a changed reporting view: dropped before the base tables change (a view pins the columns it reads), re-created after */
async function recreateView(s: Services, existing: TableDef, pkg: TableDef, map: Map<string, string>): Promise<TableDef> {
  const def: TableDef = {
    ...clone(existing),
    displayName: pkg.displayName,
    columns: [...existing.columns.filter(isSystemColumn), ...clone(pkg.columns).filter((c) => !isSystemColumn(c))],
    reporting: clone(pkg.reporting!),
    modifiedOn: s.now(),
  }
  if (pkg.description) def.description = pkg.description
  else delete def.description
  if (def.columns.some((c) => c.name === pkg.primaryColumn)) def.primaryColumn = pkg.primaryColumn
  await prepareViewDef(s, def, map)
  const { connector } = await resolveConnection(s, existing.connectionId)
  await connector.createTable(def)
  await s.meta.tables.upsert(def)
  return def
}

async function changeTable(s: Services, existing: TableDef, pkg: TableDef, columns: PlanColumnChange[], map: Map<string, string>): Promise<TableDef> {
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
  for (const k of ['teamOwnership', 'sharing'] as const) {
    if (pkg[k]) cur[k] = true
    else delete cur[k]
  }
  cur.modifiedOn = s.now()
  await s.meta.tables.upsert(cur)
  // recycle bin setting (travels in solutions): turning it on adds the columns and partial indexes here
  if ((pkg.recycleDays ?? 0) !== (cur.recycleDays ?? 0)) cur = await setRecycleDays(s, cur, pkg.recycleDays ?? 0, RECYCLABLE_SYSTEM_TABLES)
  // unique pairs: old indexes dropped, new ones built (a repeated pair stops the upgrade)
  if (!same(existing.uniqueTogether, pkg.uniqueTogether)) {
    try {
      await setUniqueTogether(s, cur.id, pkg.uniqueTogether ?? [])
    } catch (e) {
      if ((e as { code?: string }).code === '23505' || /duplicate|unique/i.test((e as Error).message)) throw invalid(`${existing.displayName}: the unique pairs cannot change, existing rows repeat a pair (${(pkg.uniqueTogether ?? []).map((x) => x.join(' + ')).join(', ')}).`)
      throw e
    }
    cur = (await s.meta.tables.get(cur.id)) ?? cur
  }
  // reporting settings (package K): a date dimension is filled again, a summary gets its new schedule and a refresh
  const r = pkg.reporting
  if (r && !same(normReporting(existing.reporting), normReporting(r, map))) {
    if (r.kind === 'date') await fillDateDimension(s, null, cur.id, r)
    if (r.kind === 'summary') await createSummary(s, null, cur.id, { ...r, source: map.get(r.source) ?? r.source })
    cur = (await s.meta.tables.get(cur.id)) ?? cur
  } else if (r?.kind === 'summary' && columns.length) {
    // new measure columns: refreshed now rather than at the next slot
    await createSummary(s, null, cur.id, { ...r, source: map.get(r.source) ?? r.source })
  }
  // formula columns are recomputed, rollups reconciled by jobs that commit with the upgrade
  for (const c of columns) {
    const before = existing.columns.find((x) => x.name === c.name) ?? null
    const after = cur.columns.find((x) => x.name === c.name) ?? null
    if (before?.computed || after?.computed) await s.kernel?.columnChanged(cur, before, after)
    if (after && !!before?.indexed !== !!after.indexed) await s.kernel?.indexInBackground(cur, after)
  }
  return cur
}

/**
 * Applies a plan computed by planSolution in the current environment, inside one transaction (s.transaction):
 * PostgreSQL DDL is transactional, so a failure anywhere leaves the environment exactly as it was.
 */
export async function applySolution(s: Services, ctx: Ctx, pkg: SolutionPkg, res: PlanResult, filesAs: 'database' | 'file', opts: { proceedWithoutBackup?: boolean } = {}): Promise<SolutionImportResult> {
  const { plan, ops } = res
  const u = me(ctx)
  let backup: { taken: boolean; message: string; id?: string; failed?: boolean } | undefined
  if (plan.mode === 'upgrade') {
    backup = s.backup ? await s.backup.snapshot(s.environment(), `before upgrading solution ${pkg.head.displayName} to ${pkg.head.version}`, { trigger: 'pre-upgrade', by: u.user.id }) : { taken: false, message: NO_BACKUP_MESSAGE }
    // the backup failed (not: switched off): nothing changes unless the administrator chose to go on without it (package J)
    if (backup.failed && !opts.proceedWithoutBackup) {
      throw new HttpError(409, 'conflict', `${backup.message} Nothing was changed. Upgrade without a backup, or cancel.`, 'backup')
    }
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
        // reporting settings name tables by package id (package K)
        if (def.reporting?.kind === 'view') await prepareViewDef(s, def, ops.tableMap)
        if (def.reporting?.kind === 'summary') def.reporting = { ...def.reporting, source: ops.tableMap.get(def.reporting.source) ?? def.reporting.source }
        await createPhysical(s, record!, connector!, def)
        if (p.csv && !def.reporting) rows.push({ def, rows: csvToRows(def, p.csv) })
      }
      // formula columns of the new tables are computed for their rows (the event rules learn the new tables)
      s.kernel?.invalidate()
      if (rows.length) await importRowsSystem(s, rows, u.user.id)
      for (const p of ops.newTables) for (const col of p.def.columns) if (col.computed) await s.kernel?.columnChanged(p.def, null, col)
      // date dimensions are filled, summary tables get their schedule and a first refresh (as when the designer applies)
      for (const p of ops.newTables) {
        const r = p.def.reporting
        if (r?.kind === 'date') await fillDateDimension(s, null, p.def.id, r)
        if (r?.kind === 'summary') await createSummary(s, null, p.def.id, { ...r, source: ops.tableMap.get(r.source) ?? r.source })
      }
      // changed reporting views go first (they pin the base columns they read) and come back after the base tables
      const views = ops.changedTables.filter((c) => c.existing.reporting?.kind === 'view')
      for (const v of views) {
        const { connector: vc } = await resolveConnection(s, v.existing.connectionId)
        await vc.dropTable(v.existing)
      }
      for (const c of ops.changedTables) if (c.existing.reporting?.kind !== 'view') await changeTable(s, c.existing, c.pkg, c.columns, ops.tableMap)
      for (const v of views) await recreateView(s, v.existing, v.pkg, ops.tableMap)
      // relationships and their delete behaviours (package K)
      await restorePkgRelationships(s, pkg.tables, ops.tableMap)
      // table events and validation rules (checked against this environment; run-as-system ones were confirmed)
      if (s.kernel && ops.eventOps.length) {
        s.kernel.invalidate()
        for (const eo of ops.eventOps) {
          const t = await s.meta.tables.get(eo.tableId)
          if (!t) continue
          for (const x of eo.remove) await s.kernel.removeEvent(x.id)
          for (const e of eo.upsert) {
            const saved = await s.kernel.putEvent(t, e, u.user.id)
            if (saved.runAs === 'system') await audit(s, ctx, 'event.run_as_system', { event: saved.id, name: saved.name, via: 'solution', solution: pkg.head.id }, t.id)
          }
        }
      }
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
            // P1-D: the package's custom actions (design, never secrets) are created or replaced
            await importConnectionActions(s, hit, c.actions, ctx.user?.user.id ?? null)
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
          await importConnectionActions(s, id, c.actions, ctx.user?.user.id ?? null)
        }
      }

      // flows (P1-A), after tables and roles: validated against this environment, references and run grants mapped
      if (ops.flowOps) {
        const roleMap = new Map<string, string>()
        for (const n of ops.newRoles) if (n.role.id) roleMap.set(n.role.id, n.id)
        for (const c of ops.changedRoles) if (c.role.id) roleMap.set(c.role.id, c.existing.id)
        await applyFlows(s, u, ops.flowOps, pkg.head.id, roleMap)
      }
      if (pkg.flows) for (const f of pkg.flows) components.push({ kind: 'flow', id: f.id })
      else for (const c of ops.existingSolution?.components ?? []) if (c.kind === 'flow') components.push(c)
      // approval policies (P1-C)
      if (ops.approvalOps) await applyApprovalPolicies(s, u.user.id, ops.approvalOps, pkg.head.id)
      if (pkg.approvalPolicies) for (const p of pkg.approvalPolicies) components.push({ kind: 'approvalPolicy', id: p.id })
      else for (const c of ops.existingSolution?.components ?? []) if (c.kind === 'approvalPolicy') components.push(c)
      // print templates (P2-B)
      if (ops.printOps) await applyPrintTemplates(s, u.user.id, ops.printOps, pkg.head.id)
      if (pkg.printTemplates) for (const p of pkg.printTemplates) components.push({ kind: 'printTemplate', id: p.id })
      else for (const c of ops.existingSolution?.components ?? []) if (c.kind === 'printTemplate') components.push(c)
      // dashboards (P2-C), after roles: viewer roles the import created or matched are mapped
      if (ops.dashboardOps) {
        const roleMap = new Map<string, string>()
        for (const n of ops.newRoles) if (n.role.id) roleMap.set(n.role.id, n.id)
        for (const c of ops.changedRoles) if (c.role.id) roleMap.set(c.role.id, c.existing.id)
        await applyDashboards(s, u.user.id, ops.dashboardOps, roleMap)
      }
      if (pkg.dashboards) for (const p of pkg.dashboards) components.push({ kind: DASHBOARD_KIND as SolutionDef['components'][number]['kind'], id: p.id })
      else for (const c of ops.existingSolution?.components ?? []) if ((c.kind as string) === DASHBOARD_KIND) components.push(c)
      // number sequences (P3-M1): created or their format updated, never their next value; one the package no longer has stays a component
      if (ops.sequenceOps) await applySequences(s, u.user.id, ops.sequenceOps)
      if (pkg.numberSequences) {
        for (const p of pkg.numberSequences) components.push({ kind: SEQUENCE_KIND as SolutionDef['components'][number]['kind'], id: p.id })
        for (const c of ops.existingSolution?.components ?? []) if ((c.kind as string) === SEQUENCE_KIND && !pkg.numberSequences.some((p) => p.id === c.id)) components.push(c)
      } else for (const c of ops.existingSolution?.components ?? []) if ((c.kind as string) === SEQUENCE_KIND) components.push(c)

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
  if (ops.flowOps?.remove.length) await afterApplyFlows(s, ops.flowOps.remove, u.user.id).catch(() => {})
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
export async function importStable(s: Services, ctx: Ctx, pkg: SolutionPkg, o: { confirm?: unknown; filesAs: 'database' | 'file'; proceedWithoutBackup?: boolean } & FlowImportOptions): Promise<SolutionImportResult> {
  const res = await planSolution(s, me(ctx), pkg, { connectionMap: o.connectionMap, enableFlows: o.enableFlows, peopleMap: o.peopleMap })
  if (res.plan.problems.length) throw invalid(`The solution cannot be imported here: ${res.plan.problems.join(' ')}`)
  // an upgrade, and any import with events that run as the system, needs the administrator's explicit confirmation
  if ((res.plan.mode === 'upgrade' || res.plan.systemEvents?.length || res.plan.serviceFlows?.length) && o.confirm !== res.plan.token) {
    if (res.plan.mode !== 'upgrade' && o.confirm === undefined) {
      if (!res.plan.systemEvents?.length) throw conflict(`"${pkg.head.displayName}" has flows that run as a service account (${res.plan.serviceFlows!.join(', ')}): review the plan and confirm it.`)
      throw conflict(`"${pkg.head.displayName}" has table events that run as the system (${res.plan.systemEvents!.join(', ')}): review the plan and confirm it.`)
    }
    throw conflict(o.confirm === undefined
      ? `"${pkg.head.displayName}" already exists in this environment: review the upgrade plan and confirm it.`
      : 'This environment or the package changed since the plan was made. Review the new plan and confirm it again.')
  }
  return applySolution(s, ctx, pkg, res, o.filesAs, { proceedWithoutBackup: o.proceedWithoutBackup })
}
