/**
 * Using templates (master-plan 11.3; docs/dev/templates.md, docs/dev/solution-templates.md): plan (dry run), install,
 * uninstall, upgrade.
 *
 * COPY (all four P2 kinds): the tables the binding creates go through the DATA MODEL's plan path (planModel + applyModel,
 * src/model ops: createTable, putRelationship), so every check, default privilege, audit entry and job is the table
 * designer's; then the app (app templates), its roles (administrators), the validation rules, the SAMPLE rows and the
 * installed-templates record, all in ONE unit of work (s.transaction; applyModel's own transaction becomes a savepoint).
 * UI component and screen templates come back bound; the Studio inserts them into the app being edited.
 *
 * LINKED (app and data model) and every SOLUTION template (P3-M1, kind `solution`, Linked or Copy): a versioned solution
 * built in memory from the template (stable ids derived from the template and the install), planned and applied by the
 * SOLUTIONS machinery (planSolution / applySolution), so an upgrade is the solution upgrade-in-place plan; components
 * changed here since delivery are listed and kept or replaced by choice. A solution template Copy is the same install
 * without the solution record (no upgrades). A solution template's DEPENDENCIES (packs.ts, dependency rules below) that
 * are not here are planned and installed first, in the same transaction.
 *
 * Rules: nothing that exists is overwritten (created tables never take a taken name: the binding refuses a clash until
 * it is resolved, by mapping or another name; mapped tables are only read and written as data); unmapped required slots
 * block the install; a pre-install backup is taken when backups exist; secrets, users and run-as-system events are
 * stripped or need an administrator's approval (safety.ts); flows of a pack arrive turned off and an administrator
 * switches them on after the install; a locked production environment refuses (use Deploy).
 */
import { createHash } from 'node:crypto'
import type { AppDef, ControlNode } from '../../../src/contracts.ts'
import type { AppMeta, RoleDef, TableDef, TablePrivilege } from '../../../src/platform/contracts.ts'
import type { PlanItem, SolutionPlan } from '../../../src/platform/http.ts'
import type { ModelOp, ModelTable, RelationshipDef } from '../../../src/model/types.ts'
import type { TableEventInput } from '../../../src/platform/events.ts'
import {
  KIND_LABEL, canonicalJson, describeContents, describeNeeds, type DependencyReport, type LocalChangeKind, type SlotBinding, type TemplateCreated, type TemplateDetail,
  type TemplateInstallRecord, type TemplateInstallResult, type TemplateMode, type TemplatePackage, type TemplatePlanResponse, type TemplateSummary, type TemplateUseRequest,
  type UninstallItem, type UninstallPlan, type UpgradePlan,
} from '../../../src/templates/format.ts'
import { bindApp, bindNodes, createdTable, defaultBindings, resolveBindings, type EnvTable, type Resolution } from '../../../src/templates/bind.ts'
import { checkSafety, type SafetyResult } from '../../../src/templates/safety.ts'
import { freshAppIds } from '../../../src/templates/insert.ts'
import type { Ctx, Services, UserContext } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import type { CoreServices } from '../services.ts'
import { NO_BACKUP_MESSAGE } from '../backup.ts'
import { LOCKED_MESSAGE } from '../router.ts'
import { serverVersion } from '../auth.ts'
import { compareVersions } from '../update/release.ts'
import { currentEnvironment } from '../env-context.ts'
import { rowUid } from '../util.ts'
import { applyModel, planModel } from '../model/engine.ts'
import { applySolution, planSolution, readSolutionPkg, type PlanResult, type SolutionPkg } from '../../routes/meta/alm.ts'
import { audit, importRowsSystem, plainTableDef } from '../../routes/meta/tables-core.ts'
import { forgetApp } from '../../routes/meta/apps.ts'
import { toYaml, uniqueLabel } from '../../routes/meta/util.ts'
import { applyFlows, afterApplyFlows } from '../flows/alm.ts'
import { applyApprovalPolicies } from '../approvals/alm.ts'
import { applyPrintTemplates } from '../print/alm.ts'
import { applyDashboards } from '../dashboards/alm.ts'
import { catalogue, findTemplate, type CatalogueEntry } from './catalogue.ts'
import {
  bindPack, currentParts, currentRowHash, grantMapped, hid, loadRows, packDocParts, packIds, partHashes, removeRows, roleHash, unlinkComponents,
  type KeepParts, type LinkedIds, type PackPlan, type RefRecord,
} from './packs.ts'
import { listSequences, sequenceTable } from './sequences.ts'

const sha = (v: unknown): string => createHash('sha256').update(canonicalJson(v)).digest('hex')
const me = (ctx: Ctx): UserContext => {
  if (!ctx.user) throw new HttpError(401, 'unauthenticated', 'Please sign in.')
  return ctx.user
}
const invalid = (message: string, field?: string, extra?: Record<string, unknown>) => new HttpError(422, 'invalid', message, field, extra)
const T = (): string => `"${currentEnvironment().schema}"."ab_template_installs"`
function db(s: Services) {
  const d = (s as CoreServices).state?.db
  if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
  return d
}
/**
 * The services as the install's unit of work sees them:
 *  - without the backup (applyModel's own pre-change backup is replaced by the install's, taken first), unless kept;
 *  - security.invalidate deferred: the live hub re-checks subscriptions on a timer armed by invalidate(); armed INSIDE a
 *    unit of work, the timer inherits the transaction's async context and fires after the commit on an ended transaction,
 *    which drops the browser's environment subscription (no more metadata refreshes). services.transaction invalidates
 *    once after the commit (outside the context), so nothing is lost by deferring.
 */
const inUnit = (s: Services, o: { keepBackup?: boolean } = {}): Services => Object.create(s, {
  ...(o.keepBackup ? {} : { backup: { value: undefined, enumerable: true } }),
  // a nested unit of work is a savepoint of the install's; services.transaction would invalidate (arm the timer) in its finally
  transaction: { value: <T>(fn: () => Promise<T>): Promise<T> => { const d = (s as CoreServices).state?.db; return d ? d.tx(() => fn()) : fn() } },
  security: { value: Object.create(s.security, { invalidate: { value: () => {} } }) },
}) as Services
const withoutBackup = (s: Services): Services => inUnit(s)
const isPack = (pkg: TemplatePackage): boolean => pkg.kind === 'solution'

/* ------------------------------------------------------------------ catalogue views */

function summaryOf(e: CatalogueEntry): TemplateSummary {
  const p = e.pkg
  const tooNew = compareVersions(serverVersion(), p.minPlatformVersion ?? '0.0.0') < 0
  return {
    id: p.id, version: p.version, kind: p.kind, name: p.name, description: p.description, ...(p.publisher ? { publisher: p.publisher } : {}), tags: p.tags ?? [],
    minPlatformVersion: p.minPlatformVersion, modes: p.modes, integrity: e.integrity, ...(e.note ? { integrityNote: e.note } : {}), ...(tooNew ? { tooNew } : {}),
    contains: e.integrity === 'damaged' ? [] : describeContents(p), needs: e.integrity === 'damaged' ? [] : describeNeeds(p),
  }
}

export function listCatalogue(): TemplateSummary[] {
  const newest = new Map<string, CatalogueEntry>()
  for (const e of catalogue()) {
    const cur = newest.get(e.pkg.id)
    if (!cur || compareVersions(e.pkg.version, cur.pkg.version) > 0) newest.set(e.pkg.id, e)
  }
  return [...newest.values()].map(summaryOf).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
}

export async function describeTemplate(s: Services, id: string): Promise<TemplateDetail> {
  const e = findTemplate(id)
  if (!e) throw new HttpError(404, 'not-found', 'There is no such template in the catalogue.')
  const tables = await s.meta.tables.list()
  const installed = e.pkg.dependencies?.length ? await installedRows(s) : []
  return {
    ...summaryOf(e), slots: e.pkg.slots, defaults: e.integrity === 'damaged' ? {} : defaultBindings(e.pkg, tables), roles: (e.pkg.payload.roles ?? []).map((r) => r.name),
    sampleRows: Object.values(e.pkg.payload.sample ?? {}).reduce((n, r) => n + r.length, 0), digest: e.digest,
    ...(e.pkg.shortName ? { shortName: e.pkg.shortName } : {}),
    ...(e.pkg.dependencies?.length ? {
      dependencies: e.pkg.dependencies.map((d) => {
        const row = installed.find((r) => r.template_id === d.id)
        return { id: d.id, name: findTemplate(d.id)?.pkg.name ?? d.id, minVersion: d.minVersion, ...(row ? { installed: row.template_version } : {}) }
      }),
    } : {}),
  }
}

/* ------------------------------------------------------------------ the register */

interface DepRef { template: string; install: string; name: string; version?: string }
interface InstallRow {
  id: string; template_id: string; template_version: string; digest: string; kind: string; mode: string; name: string; status: string
  bindings: Record<string, SlotBinding>; created: TemplateCreated; delivered: Delivered; solution_id: string | null; installed_by: string | null
  installed_on: Date | string; uninstalled_on: Date | string | null; details: { ids?: LinkedIds; names?: Record<string, string> } | null
  sample_rows?: Record<string, string[]> | null; reference_rows?: Record<string, RefRecord> | null; depends_on?: DepRef[] | null
}
interface Delivered {
  apps?: Record<string, string>; tables?: Record<string, string>
  /** format 2 */
  roles?: Record<string, string>; flows?: Record<string, string>; approvalPolicies?: Record<string, string>; dashboards?: Record<string, string>
  printTemplates?: Record<string, string>; numberSequences?: Record<string, string>
}

const iso = (v: Date | string | null): string | undefined => (v === null || v === undefined ? undefined : new Date(v).toISOString())
const countRows = (m: Record<string, string[]> | null | undefined): number => Object.values(m ?? {}).reduce((n, l) => n + l.length, 0)

function toRecord(r: InstallRow, extra: { flowsOff?: { id: string; name: string }[]; usedBy?: DepRef[] } = {}): TemplateInstallRecord {
  const newest = r.mode === 'linked' && r.status === 'installed' ? findTemplate(r.template_id) : undefined
  const sample = r.status === 'installed' ? countRows(r.sample_rows) : 0
  return {
    id: r.id, templateId: r.template_id, templateVersion: r.template_version, kind: r.kind as TemplateInstallRecord['kind'], mode: r.mode as TemplateMode, name: r.name,
    status: r.status === 'uninstalled' ? 'uninstalled' : 'installed', bindings: r.bindings ?? {}, created: r.created, ...(r.solution_id ? { solutionId: r.solution_id } : {}),
    ...(r.installed_by ? { installedBy: r.installed_by } : {}), installedOn: iso(r.installed_on)!, ...(r.uninstalled_on ? { uninstalledOn: iso(r.uninstalled_on) } : {}),
    ...(newest && newest.integrity !== 'damaged' && compareVersions(newest.pkg.version, r.template_version) > 0 ? { upgradeTo: newest.pkg.version } : {}),
    canUninstall: r.status === 'installed' && (r.kind === 'app' || r.kind === 'dataModel' || r.kind === 'solution'),
    ...(sample ? { sampleRemaining: sample } : {}),
    ...(extra.flowsOff?.length ? { flowsOff: extra.flowsOff } : {}),
    ...(r.depends_on?.length ? { dependsOn: r.depends_on.map((d) => ({ template: d.template, install: d.install, name: d.name })) } : {}),
    ...(extra.usedBy?.length ? { usedBy: extra.usedBy } : {}),
  }
}

async function installedRows(s: Services): Promise<InstallRow[]> {
  return db(s).query<InstallRow>(`SELECT * FROM ${T()} WHERE status = 'installed' ORDER BY installed_on, id`)
}

/** the flows of installs that are turned off (offered to administrators: "Switch on these flows") */
async function flowsOffOf(s: Services, rows: InstallRow[]): Promise<Map<string, { id: string; name: string }[]>> {
  const ids = rows.filter((r) => r.status === 'installed').flatMap((r) => (r.created?.flows ?? []).map((f) => f.id))
  const out = new Map<string, { id: string; name: string }[]>()
  if (!ids.length) return out
  const off = await db(s).query<{ id: string; name: string }>(`SELECT id, name FROM "${currentEnvironment().schema}"."ab_flows" WHERE id = ANY($1::text[]) AND enabled = false`, [ids])
  for (const r of rows) out.set(r.id, off.filter((f) => (r.created?.flows ?? []).some((x) => x.id === f.id)).map((f) => ({ id: f.id, name: f.name })))
  return out
}

const usedByOf = (rows: InstallRow[], id: string): DepRef[] => rows.filter((x) => x.status === 'installed' && (x.depends_on ?? []).some((d) => d.install === id)).map((x) => ({ template: x.template_id, install: x.id, name: x.name }))

export async function listInstalls(s: Services): Promise<TemplateInstallRecord[]> {
  const rows = await db(s).query<InstallRow>(`SELECT * FROM ${T()} ORDER BY installed_on DESC, id`)
  const off = await flowsOffOf(s, rows)
  return rows.map((r) => toRecord(r, { flowsOff: off.get(r.id), usedBy: usedByOf(rows, r.id) }))
}

async function installRow(s: Services, id: string): Promise<InstallRow> {
  const r = (await db(s).query<InstallRow>(`SELECT * FROM ${T()} WHERE id = $1`, [id]))[0]
  if (!r) throw new HttpError(404, 'not-found', 'There is no such installed template here.')
  return r
}

async function recordOf(s: Services, id: string): Promise<TemplateInstallRecord> {
  const rows = await db(s).query<InstallRow>(`SELECT * FROM ${T()} ORDER BY installed_on DESC, id`)
  const r = rows.find((x) => x.id === id)
  if (!r) throw new HttpError(404, 'not-found', 'There is no such installed template here.')
  return toRecord(r, { flowsOff: (await flowsOffOf(s, [r])).get(r.id), usedBy: usedByOf(rows, r.id) })
}

/* ------------------------------------------------------------------ plan */

interface CreatedSlot { slot: string; draftId: string; def: Omit<TableDef, 'id'>; events: TableEventInput[]; lookups: { column: string; toSlot: string; onDelete?: RelationshipDef['onDelete'] }[] }

/** a dependency of a pack as planned: already here, or installed first by this install */
interface DepPlan { report: DependencyReport; installed?: InstallRow; pc?: PlanContext }

interface PlanContext {
  entry: CatalogueEntry
  pkg: TemplatePackage
  safety: SafetyResult
  mode: TemplateMode
  resolution: Resolution
  created: CreatedSlot[]
  app?: { def: AppDef; name: string }
  nodes?: ControlNode[]
  screen?: ControlNode
  dataSources: string[]
  /** key: the role's key (format 2) or name in the template (Linked ids are keyed by it); name: the name it gets here */
  roles: { key: string; name: string; description?: string; isMaker?: boolean; privileges: Record<string, Omit<TablePrivilege, 'table'>> }[]
  sample: boolean
  modelOps: ModelOp[]
  modelToken: string
  linked?: { pkg: SolutionPkg; res: PlanResult; ids: LinkedIds }
  /** format 2 */
  pack?: PackPlan
  ids?: LinkedIds
  deps: DepPlan[]
  serverChanges: boolean
  response: TemplatePlanResponse
}

const relId = (templateId: string, slot: string, col: string, salt = '') => `rel_${hid(`${templateId}:${slot}:${col}:${salt}`)}`

async function envInfo(s: Services): Promise<SolutionPlan['target']> {
  const env = s.environments ? await s.environments.get(s.environment().id) : null
  return { id: s.environment().id, name: env?.name ?? 'Default', type: env?.type ?? 'production', ...(env?.locked ? { locked: true } : {}) }
}

/** the ids a Linked install's components get: stable per template and install (so an upgrade finds them) */
async function linkedIds(s: Services, pkg: TemplatePackage): Promise<LinkedIds> {
  // solution templates count every install (a Copy has ids too); the P2 kinds keep counting their Linked installs
  const n = (await db(s).query<{ n: number }>(`SELECT count(*)::int AS n FROM ${T()} WHERE template_id = $1${isPack(pkg) ? '' : ` AND mode = 'linked'`}`, [pkg.id]))[0]?.n ?? 0
  const base = `${pkg.id}#${n + 1}`
  if (isPack(pkg)) return packIds(pkg, base)
  const tables: Record<string, string> = {}
  for (const sl of pkg.slots) tables[sl.id] = `tbl_tpl_${hid(`${base}:table:${sl.id}`)}`
  const roles: Record<string, string> = {}
  for (const r of pkg.payload.roles ?? []) roles[r.name] = `role_tpl_${hid(`${base}:role:${r.name}`)}`
  const events: Record<string, string> = {}
  for (const sl of pkg.slots) (sl.events ?? []).forEach((e, i) => { events[`${sl.id}:${i}`] = `evt_tpl_${hid(`${base}:event:${sl.id}:${i}:${e.name ?? ''}`)}` })
  return { solution: `tpl_${hid(`${base}:solution`)}`, ...(pkg.kind === 'app' ? { app: `app_tpl_${hid(`${base}:app`)}` } : {}), tables, roles, events }
}

type DocBase = Omit<PlanContext, 'linked' | 'response' | 'serverChanges' | 'modelOps' | 'modelToken' | 'deps'>
interface DocKeep extends KeepParts { apps?: Record<string, AppDef>; tables?: Record<string, TableDef>; roles?: Record<string, RoleDef> }

/** the solution document of a Linked install (or upgrade, or a solution template's install): what applySolution installs */
function linkedDocument(pc: DocBase, ids: LinkedIds, keep: DocKeep = {}): Record<string, unknown> {
  const tableIdOf = (slot: string): string | undefined => {
    const r = pc.resolution.resolved.find((x) => x.slot.id === slot)
    if (!r) return undefined
    if (r.mode === 'create') return ids.tables[slot]
    if (r.mode === 'map') return r.tableId
    return undefined
  }
  const tableEntries = pc.created.map((c) => {
    const id = ids.tables[c.slot]
    const kept = keep.tables?.[id]
    const schema = kept ? { ...plainTableDef(kept), id } : { ...c.def, id }
    const relationships = c.lookups.map((l) => ({ id: relId(pc.pkg.id, c.slot, l.column, ids.solution), fromTable: id, fromColumn: l.column, toTable: tableIdOf(l.toSlot) ?? '', kind: 'oneToMany', onDelete: l.onDelete ?? 'restrict' })).filter((r) => r.toTable)
    const events = c.events.map((e, i) => ({ ...e, id: ids.events[`${c.slot}:${i}`] }))
    return { schema, ...(relationships.length ? { relationships } : {}), events }
  })
  const pack = pc.pack
  const apps = pack
    ? pack.apps.map((a) => ({ id: a.id, name: a.name, ...(a.description ? { description: a.description } : {}), definition: keep.apps?.[a.id] ?? a.def }))
    : pc.app && ids.app ? [{ id: ids.app, name: pc.app.name, definition: keep.apps?.[ids.app] ?? pc.app.def }] : []
  const appIds = apps.map((a) => a.id)
  const roles = pc.roles.map((r) => {
    const id = ids.roles[r.key]
    const kept = keep.roles?.[id]
    const privileges = kept
      ? kept.privileges.filter((p) => pc.created.some((c) => ids.tables[c.slot] === p.table))
      : Object.entries(r.privileges).map(([slot, p]) => ({ table: tableIdOf(slot) ?? '', ...p })).filter((p) => p.table && pc.created.some((c) => ids.tables[c.slot] === p.table))
    return {
      id, name: kept?.name ?? r.name, ...((kept ? kept.description : r.description) ? { description: kept ? kept.description : r.description } : {}), ...((kept ? (kept as RoleDef & { isMaker?: boolean }).isMaker : r.isMaker) ? { isMaker: true } : {}),
      privileges, apps: kept ? kept.apps : appIds,
    }
  })
  const roleNames = Object.fromEntries(pc.roles.map((r) => [ids.roles[r.key], r.name]))
  return {
    kind: 'appbuilder/solution', packageVersion: 1,
    solution: { id: ids.solution, name: `Template_${pc.pkg.id.replace(/[^A-Za-z0-9]+/g, '_')}`.slice(0, 60), displayName: `${pc.pkg.name} (template)`, publisher: pc.pkg.publisher ?? 'Template', version: pc.pkg.version, description: `Installed from the template ${pc.pkg.name} (${pc.pkg.id}), linked: updates arrive as an upgrade plan.` },
    apps, tables: tableEntries, roles, connections: [], files: [],
    ...(pack ? packDocParts(pack, roleNames, keep) : {}),
  }
}

/** the tables a planned dependency creates (they do not exist yet): for binding the shared slots and checking lookups */
function plannedTables(d: PlanContext): EnvTable[] {
  return d.created.map((c) => ({ id: d.ids!.tables[c.slot], name: c.def.name, displayName: c.def.displayName, columns: c.def.columns }))
}

/** where a slot of an install (or a planned install) is: table id, name and its columns (slot column id -> column name) */
function slotTableOfRow(row: InstallRow, slot: string): { id: string; name: string; columns: Record<string, string | null> } | undefined {
  const c = row.created?.tables?.find((t) => t.slot === slot)
  if (c) return { id: c.id, name: c.name, columns: {} }
  const m = row.created?.mapped?.find((t) => t.slot === slot)
  if (m) {
    const b = row.bindings?.[slot]
    return { id: m.table, name: m.name, columns: b?.mode === 'map' ? (b.columns ?? {}) : {} }
  }
  return undefined
}
function slotTableOfPlan(d: PlanContext, slot: string): { id: string; name: string; columns: Record<string, string | null> } | undefined {
  const r = d.resolution.resolved.find((x) => x.slot.id === slot)
  if (!r || r.mode === 'skip' || !r.tableName) return undefined
  return { id: r.mode === 'create' ? d.ids!.tables[slot] : r.tableId ?? '', name: r.tableName, columns: r.mode === 'map' ? Object.fromEntries(r.columns) : {} }
}

/** the dependencies of a pack: here (new enough), or planned for installing first; at most three levels */
async function planDependencies(s: Services, ctx: Ctx, pkg: TemplatePackage, depth: number, upgrading: boolean): Promise<DepPlan[]> {
  const out: DepPlan[] = []
  if (!pkg.dependencies?.length) return out
  const rows = await installedRows(s)
  for (const d of pkg.dependencies) {
    const entry = findTemplate(d.id)
    const name = entry?.pkg.name ?? d.id
    const report: DependencyReport = { id: d.id, name, minVersion: d.minVersion, action: 'missing', problems: [] }
    const row = rows.find((r) => r.template_id === d.id)
    if (row) {
      report.version = row.template_version
      report.installId = row.id
      if (compareVersions(row.template_version, d.minVersion) < 0) {
        report.problems.push(`${pkg.name} needs ${name} ${d.minVersion} or newer; ${row.template_version} is installed here: upgrade it first.`)
        out.push({ report, installed: row })
        continue
      }
      report.action = 'installed'
      out.push({ report, installed: row })
      continue
    }
    if (upgrading) { report.problems.push(`${pkg.name} now needs ${name} ${d.minVersion}, which is not installed here: install it first.`); out.push({ report }); continue }
    if (!entry || entry.integrity === 'damaged') { report.problems.push(`${pkg.name} needs the template ${d.id}, which is not in the catalogue.`); out.push({ report }); continue }
    if (compareVersions(entry.pkg.version, d.minVersion) < 0) { report.problems.push(`${pkg.name} needs ${name} ${d.minVersion} or newer; the catalogue has ${entry.pkg.version}.`); out.push({ report }); continue }
    if (depth >= 3) { report.problems.push(`The dependencies of ${pkg.name} go more than three levels deep.`); out.push({ report }); continue }
    const dpc = await planTemplate(s, ctx, d.id, { mode: entry.pkg.modes.includes('linked') ? 'linked' : 'copy' }, { depth: depth + 1 })
    report.action = 'install'
    report.version = entry.pkg.version
    report.plan = dpc.response.plan
    report.slots = dpc.response.slots
    report.problems.push(...dpc.response.plan.problems.map((p) => `${name}: ${p}`))
    out.push({ report, pc: dpc })
  }
  return out
}

interface PlanInternal { depth?: number; upgrade?: InstallRow }

export async function planTemplate(s: Services, ctx: Ctx, id: string, req: TemplateUseRequest, internal: PlanInternal = {}): Promise<PlanContext> {
  const user = me(ctx)
  const entry = findTemplate(id)
  if (!entry) throw new HttpError(404, 'not-found', 'There is no such template in the catalogue.')
  const problems: string[] = []
  const warnings: string[] = []
  const items: PlanItem[] = []
  if (entry.integrity === 'damaged') problems.push(`This template cannot be used: ${entry.note ?? 'it is damaged'}`)
  if (compareVersions(serverVersion(), entry.pkg.minPlatformVersion ?? '0.0.0') < 0) problems.push(`This template needs Appbuilder ${entry.pkg.minPlatformVersion} or newer (this is ${serverVersion()}).`)
  const safety = checkSafety(entry.pkg)
  const pkg = safety.pkg
  warnings.push(...safety.stripped)
  const pack = isPack(pkg)
  const mode: TemplateMode = req.mode === 'linked' ? 'linked' : 'copy'
  if (mode === 'linked' && !pkg.modes.includes('linked')) problems.push(`${KIND_LABEL[pkg.kind]} templates are used as copies: Linked is not available for this template.`)
  if (pack && !user.privileges.isAdmin) problems.push('Only an administrator of this environment can install a solution template (it creates roles, flows and approval policies).')
  const target = await envInfo(s)
  if (target.locked) problems.push(`${LOCKED_MESSAGE} Install the template in a sandbox and deploy it here.`)
  const tables = await s.meta.tables.list()

  // format 2: the packs this one needs, and the shared slots bound to their tables
  const deps = pack && !problems.length ? await planDependencies(s, ctx, pkg, internal.depth ?? 0, !!internal.upgrade) : []
  for (const d of deps) problems.push(...d.report.problems)
  const virtual = deps.flatMap((d) => (d.pc ? plannedTables(d.pc) : []))
  const shared: Record<string, SlotBinding> = {}
  const sharedInfo: Record<string, NonNullable<TemplatePlanResponse['slots'][number]['shared']>> = {}
  for (const sl of pkg.slots) {
    if (!sl.from) continue
    const d = deps.find((x) => x.report.id === sl.from!.template)
    const where = d?.installed ? slotTableOfRow(d.installed, sl.from.slot) : d?.pc ? slotTableOfPlan(d.pc, sl.from.slot) : undefined
    if (!where) {
      if (d && !d.report.problems.length) problems.push(`${sl.label}: ${d.report.name} has no table for its slot ${sl.from.slot}.`)
      shared[sl.id] = { mode: 'skip' }
      continue
    }
    shared[sl.id] = { mode: 'map', table: where.id, columns: Object.fromEntries(sl.columns.map((c) => [c.id, where.columns[c.id] ?? c.id])) }
    sharedInfo[sl.id] = { template: d!.report.id, templateName: d!.report.name, slot: sl.from.slot, table: where.name, planned: !d!.installed }
  }
  const resolution = resolveBindings(pkg, { ...(req.bindings ?? {}), ...shared }, [...tables, ...virtual])
  for (const r of resolution.slots) if (sharedInfo[r.slot]) r.shared = sharedInfo[r.slot]
  problems.push(...resolution.problems)
  warnings.push(...resolution.warnings)

  // the payload, bound
  let app: PlanContext['app']
  let nodes: ControlNode[] | undefined
  let screen: ControlNode | undefined
  let appNameInfo: TemplatePlanResponse['appName']
  const bindProblems: string[] = []
  if (pkg.kind === 'component') {
    const b = bindNodes(pkg.payload.controls ?? [], resolution.tokens)
    nodes = b.value
    bindProblems.push(...b.problems)
  } else if (pkg.kind === 'screen') {
    const b = bindNodes([pkg.payload.screen!], resolution.tokens)
    screen = b.value[0]
    bindProblems.push(...b.problems)
  } else if (pkg.kind === 'app') {
    const b = bindApp(pkg.payload.app!, resolution.tokens)
    bindProblems.push(...b.problems)
    const name = (req.appName ?? pkg.payload.app!.name ?? pkg.name).trim().slice(0, 100) || pkg.name
    const apps = await s.meta.apps.list()
    const clash = apps.some((a) => a.name.toLowerCase() === name.toLowerCase())
    appNameInfo = { value: name, ...(clash ? { clash: true, suggestion: uniqueLabel(name, apps.map((a) => a.name)) } : {}) }
    if (clash) problems.push(`An app named "${name}" already exists here: give the new app another name (for example "${appNameInfo.suggestion}").`)
    app = { def: { ...b.value, name }, name }
  }
  const dataSources = resolution.resolved.filter((r) => r.mode !== 'skip' && r.tableName).map((r) => r.tableName!)

  // tables the binding creates
  // a fixed time in the planned definitions: the plan's token must not change between the plan and the install (the
  // table routes and applySolution stamp the real times)
  const now = '2000-01-01T00:00:00.000Z'
  const created: CreatedSlot[] = []
  const ids = pack ? (internal.upgrade ? packIds(pkg, internal.upgrade.details?.ids?.base ?? `${pkg.id}#upgrade`, internal.upgrade.details?.ids) : await linkedIds(s, pkg)) : undefined
  // format 2: the component tokens (number sequences resolved, names chosen) and every component bound
  let packPlan: PackPlan | undefined
  if (pack && ids) {
    const columnOf = (slot: string, col: string): string | null => resolution.resolved.find((r) => r.slot.id === slot)?.columns.get(col) ?? null
    packPlan = await bindPack(s, pkg, resolution, ids, { ...(internal.upgrade?.details?.names ? { names: internal.upgrade.details.names } : {}), columnOf })
    bindProblems.push(...packPlan.problems)
    warnings.push(...packPlan.warnings)
  }
  const tokens = packPlan?.tokens ?? resolution.tokens
  const tokenResolution: Resolution = { ...resolution, tokens }
  for (const r of resolution.resolved) {
    if (r.mode !== 'create') continue
    const c = createdTable(r, tokenResolution, now)
    bindProblems.push(...c.problems)
    created.push({ slot: r.slot.id, draftId: `new_tpl_${r.slot.id.toLowerCase()}`, def: c.def, events: c.events, lookups: c.lookups })
  }
  // problems of binding a formula only count when the binding itself is complete (otherwise they repeat the slot problems)
  if (!resolution.problems.length) problems.push(...bindProblems.map((p) => `Binding: ${p}`))
  // rule 8: events that run as the system, on tables this install creates (its dependencies' too)
  const systemItems = [
    ...deps.flatMap((d) => d.pc?.response.systemItems ?? []),
    ...pkg.slots.filter((sl) => created.some((c) => c.slot === sl.id)).flatMap((sl) => (sl.events ?? []).filter((e) => e.runAs === 'system').map((e) => `${sl.label}: ${e.name ?? 'event'}`)),
  ]
  if (systemItems.length && !user.privileges.isAdmin) problems.push(`The template has table events that run as the system (${systemItems.join(', ')}): only an administrator of this environment can install it.`)
  else if (systemItems.length) warnings.push(`The table events ${systemItems.join(', ')} run as the system (they ignore row and column security): approve them explicitly below.`)

  // roles (administrators only; never the administrator flag)
  const roles: PlanContext['roles'] = []
  if ((pkg.payload.roles ?? []).length && !user.privileges.isAdmin) warnings.push('The roles of the template are skipped: only administrators can create roles. An administrator can give people access to the new app later.')
  if (user.privileges.isAdmin) {
    const all = await s.meta.roles.list()
    const own = new Set(Object.values(ids?.roles ?? {}))
    const existing = all.filter((r) => !own.has(r.id)).map((r) => r.name)
    for (const r of pkg.payload.roles ?? []) {
      const key = r.key ?? r.name
      const mine = ids ? all.find((x) => x.id === ids.roles[key]) : undefined
      const name = mine?.name ?? uniqueLabel(r.name.slice(0, 100), [...existing, ...roles.map((x) => x.name)])
      const privileges: PlanContext['roles'][number]['privileges'] = {}
      for (const [slot, p] of Object.entries(r.tables ?? {})) {
        const rule = packPlan?.roleRules[key]?.[slot]
        privileges[slot] = {
          create: p.create === true, read: p.read ?? 'none', update: p.update ?? 'none', delete: p.delete ?? 'none',
          ...(p.share && p.share !== 'none' ? { share: p.share } : {}), ...(rule?.columns ? { columns: rule.columns } : {}), ...(rule?.rowFilter ? { rowFilter: rule.rowFilter as TablePrivilege['rowFilter'] } : {}),
        }
      }
      roles.push({ key, name, ...(r.description ? { description: r.description } : {}), ...(r.isMaker ? { isMaker: true } : {}), privileges })
      if (name !== r.name && !mine) warnings.push(`A role named "${r.name}" exists here: the template's role is created as "${name}".`)
    }
  }

  // sample rows: only into tables this install creates (P2 kinds: only when it creates all of them)
  const sampleRows = Object.values(pkg.payload.sample ?? {}).reduce((n, r) => n + r.length, 0)
  let sample = req.sample === true && sampleRows > 0
  if (sample && !pack && created.length !== pkg.slots.length) {
    sample = false
    warnings.push('SAMPLE rows are only added when the template creates every one of its tables (they are never written into your own tables).')
  }
  if (sample && pack && created.length !== pkg.slots.filter((x) => !x.from).length) warnings.push('SAMPLE rows go only into the tables this template creates (never into your own or shared tables); rows for the other tables are left out.')

  const base = { entry, pkg, safety, mode, resolution: tokenResolution, created, app, nodes, screen, dataSources, roles, sample, ...(packPlan ? { pack: packPlan } : {}), ...(ids ? { ids } : {}) }
  let modelOps: ModelOp[] = []
  let modelToken = ''
  let linked: PlanContext['linked']
  let planMode: SolutionPlan['mode'] = 'install'

  if (mode === 'copy' && !pack) {
    // the data model's plan path: createTable + putRelationship ops
    const draftOf = (slot: string): string | undefined => {
      const r = resolution.resolved.find((x) => x.slot.id === slot)
      if (r?.mode === 'create') return created.find((c) => c.slot === slot)?.draftId
      if (r?.mode === 'map') return r.tableId
      return undefined
    }
    for (const c of created) modelOps.push({ op: 'createTable', table: { ...c.def, id: c.draftId } as ModelTable })
    for (const c of created) {
      for (const l of c.lookups) {
        const to = draftOf(l.toSlot)
        if (!to) continue
        const col = c.def.columns.find((x) => x.name === l.column)
        modelOps.push({ op: 'putRelationship', rel: { id: relId(pkg.id, c.slot, l.column), fromTable: c.draftId, fromColumn: l.column, toTable: to, kind: 'oneToMany', onDelete: l.onDelete ?? (col?.required ? 'restrict' : 'setBlank') } })
      }
    }
    if (modelOps.length && !problems.length) {
      const mp = await planModel(s, user, modelOps)
      problems.push(...mp.plan.problems)
      warnings.push(...mp.plan.warnings)
      modelToken = mp.plan.token
      for (const it of mp.plan.items) {
        if (it.kind === 'relationship') { warnings.push(`New relationship ${it.name} (${it.note ?? ''}).`); continue }
        const c = created.find((x) => x.def.displayName === it.table)
        items.push({ kind: 'table', id: '', name: c && c.def.name !== it.table ? `${it.table} (${c.def.name})` : it.table, change: 'new', note: [it.note, sample && c ? `with ${pkg.payload.sample?.[c.slot]?.length ?? 0} SAMPLE rows` : ''].filter(Boolean).join('; ') })
      }
    } else for (const c of created) items.push({ kind: 'table', id: '', name: c.def.displayName, change: 'new', note: `${c.def.columns.filter((x) => !x.system).length} columns` })
    for (const c of created) for (const e of c.events) items.push({ kind: 'event', id: '', name: `${c.def.displayName}: ${e.name ?? ''}`, change: 'new', ...(e.runAs === 'system' ? { note: 'runs as the system: ignores row and column security' } : { note: e.kind === 'validation' ? 'validation rule' : 'table event' }) })
    if (app) items.push({ kind: 'app', id: '', name: app.name, change: 'new', note: `${app.def.screens.length} screen${app.def.screens.length === 1 ? '' : 's'}; data: ${dataSources.join(', ') || 'none'}` })
    for (const r of roles) items.push({ kind: 'role', id: '', name: r.name, change: 'new', note: `access to ${Object.keys(r.privileges).map((sl) => resolution.resolved.find((x) => x.slot.id === sl)?.tableName).filter(Boolean).join(', ')} and the new app` })
  } else if (!internal.upgrade) {
    const lids = ids ?? await linkedIds(s, pkg)
    if (mode === 'linked' && (await db(s).query(`SELECT 1 FROM ${T()} WHERE template_id = $1 AND mode = 'linked' AND status = 'installed'`, [pkg.id])).length) problems.push('This template is already installed here as Linked: upgrade it from the installed list, or install it as a copy.')
    if (!problems.length) {
      const doc = linkedDocument(base, lids)
      let solPkg: SolutionPkg | null = null
      try {
        solPkg = readSolutionPkg(toYaml(doc), s)!
      } catch (e) {
        problems.push(`The template does not fit this environment: ${(e as Error).message}`)
      }
      if (solPkg) {
        const res = await planSolution(s, user, solPkg, { expectTables: virtual.map((t) => t.name) })
        // tables a dependency creates first are not "missing"
        res.plan.warnings = res.plan.warnings.filter((w) => !virtual.some((t) => w.includes(` ${t.name}, which`) || w.includes(` ${t.name} which`)))
        problems.push(...res.plan.problems)
        warnings.push(...res.plan.warnings)
        items.push(...res.plan.items)
        planMode = res.plan.mode
        linked = { pkg: solPkg, res, ids: lids }
        if (res.plan.mode === 'upgrade') problems.push('Something with the ids of this template already exists here; install it as a copy instead.')
      }
    }
  }
  // format 2: what the plan items do not say by themselves
  if (packPlan) {
    for (const it of items) {
      if (it.kind === 'flow' && it.change === 'new') it.note = 'arrives turned off: an administrator switches it on after the install (it runs as the administrator who installs it)'
      if (it.kind === 'table' && it.change === 'new') {
        const c = created.find((x) => linked?.ids.tables[x.slot] === it.id)
        const ref = c ? pkg.payload.reference?.[c.slot]?.length ?? 0 : 0
        const smp = c && sample ? pkg.payload.sample?.[c.slot]?.length ?? 0 : 0
        const words = [ref ? `${ref} reference rows` : '', smp ? `${smp} SAMPLE rows (removable)` : ''].filter(Boolean)
        if (words.length) it.note = [it.note, `with ${words.join(' and ')}`].filter(Boolean).join('; ')
      }
    }
    for (const q of packPlan.sequences) if (q.action === 'reuse') items.push({ kind: 'numberSequence' as PlanItem['kind'], id: q.id, name: q.name, change: 'unchanged', note: q.note })
    if (mode === 'copy') warnings.push('A copy is not linked to the template: it gets no upgrades. Choose Linked to receive new versions as an upgrade plan.')
  }
  // mapped tables are used as they are
  for (const r of resolution.resolved) {
    if (r.mode !== 'map' || !r.tableId) continue
    const sh = sharedInfo[r.slot.id]
    items.push({ kind: 'table', id: r.tableId, name: r.displayName ?? r.tableName ?? '', change: 'unchanged', note: sh ? `shared with ${sh.templateName}${sh.planned ? ' (installed first)' : ''}: used as it is` : 'your table, used as it is: its columns and rows do not change' })
  }
  // UI components and screens go into the app being edited
  if (pkg.kind === 'component' || pkg.kind === 'screen') {
    const count = (ns: ControlNode[]): number => ns.reduce((n, c) => n + 1 + count(c.children ?? []), 0)
    const what = pkg.kind === 'component' ? `adds ${count(nodes ?? [])} UI components to the screen ${req.target?.screenName ?? '(the current screen)'}` : `adds the screen "${screen?.name ?? ''}" (${count(screen?.children ?? [])} UI components)`
    items.push({ kind: 'app', id: req.target?.appId ?? '', name: req.target?.appName ?? 'The app you are editing', change: 'changed', note: `${what}; names already used in the app get a number; nothing in the app is replaced or removed (Undo takes it out again)` })
  }
  const serverChanges = created.length > 0 || !!app || roles.length > 0 || pack || deps.some((d) => !!d.pc)
  if (created.length) warnings.push('Your existing roles get the usual access to the new tables (makers full, viewers read, others none); nothing they already have changes.')
  const backupOn = !!s.backup?.available()
  const backup = !serverChanges
    ? { available: backupOn, message: 'Nothing on the server changes: the UI components go into the app you are editing.' }
    : backupOn ? { available: true, message: 'A backup of this environment is taken before the install.' } : { available: false, message: NO_BACKUP_MESSAGE }

  const token = createHash('sha256').update(canonicalJson({
    env: target.id, digest: entry.digest, mode, bindings: resolution.resolved.map((r) => [r.slot.id, r.mode, r.tableId ?? r.tableName, [...r.columns.entries()]]),
    app: app?.name ?? null, sample, target: req.target ?? null, model: modelToken, linked: linked?.res.plan.token ?? null, roles: roles.map((r) => r.name), problems,
    deps: deps.map((d) => [d.report.id, d.report.action, d.installed?.id ?? null, d.pc?.response.plan.token ?? null]), seq: packPlan?.sequences.map((q) => [q.key, q.id, q.name, q.action]) ?? null,
  })).digest('hex').slice(0, 32)
  const plan: SolutionPlan = {
    mode: planMode,
    solution: { id: pkg.id, name: pkg.id, displayName: `${pkg.name} (${KIND_LABEL[pkg.kind]} template${mode === 'linked' ? ', linked' : ', copy'})`, version: pkg.version },
    target, items, destructive: false, problems: [...new Set(problems)], warnings: [...new Set(warnings)], backup, token,
    ...(systemItems.length ? { systemEvents: systemItems } : {}),
  }
  const bindings: Record<string, SlotBinding> = {}
  for (const r of resolution.resolved) {
    if (sharedInfo[r.slot.id]) continue
    bindings[r.slot.id] = r.mode === 'skip' ? { mode: 'skip' } : r.mode === 'create' ? { mode: 'create', name: r.tableName ?? '', ...(r.displayName ? { displayName: r.displayName } : {}) } : { mode: 'map', table: r.tableId ?? '', columns: Object.fromEntries(r.columns) }
  }
  const response: TemplatePlanResponse = {
    plan, slots: resolution.slots, bindings, mode, ...(appNameInfo ? { appName: appNameInfo } : {}), stripped: safety.stripped, systemItems,
    ...(deps.length ? { dependencies: deps.map((d) => d.report) } : {}),
    ...(packPlan?.sequences.length ? { sequences: packPlan.sequences.map((q) => ({ key: q.key, name: q.name, action: q.action, ...(q.note ? { note: q.note } : {}) })) } : {}),
  }
  return { ...base, modelOps, modelToken, ...(linked ? { linked } : {}), deps, serverChanges, response }
}

/* ------------------------------------------------------------------ install */

async function takeBackup(s: Services, ctx: Ctx, reason: string, proceed: boolean): Promise<{ taken: boolean; message: string } | undefined> {
  if (!s.backup?.available()) return { taken: false, message: NO_BACKUP_MESSAGE }
  const b = await s.backup.snapshot(s.environment(), reason, { trigger: 'pre-upgrade', by: me(ctx).user.id })
  if (b.failed && !proceed) throw new HttpError(409, 'conflict', `${b.message} Nothing was changed. Install without a backup, or cancel.`, 'backup')
  return { taken: !!b.taken, message: b.message }
}

/** SAMPLE rows of the P2 kinds: fresh row ids (row ids are unique across tables), lookups follow; returns how many rows went in */
async function loadSample(s: Services, pkg: TemplatePackage, tableOf: (slot: string) => TableDef | undefined, userId: string): Promise<number> {
  const idMap = new Map<string, string>()
  for (const rows of Object.values(pkg.payload.sample ?? {})) for (const r of rows) if (typeof r._id === 'string') idMap.set(r._id, rowUid())
  const items: { def: TableDef; rows: Record<string, string | number | boolean | null>[] }[] = []
  for (const sl of pkg.slots) {
    const def = tableOf(sl.id)
    const rows = pkg.payload.sample?.[sl.id] ?? []
    if (!def || !rows.length) continue
    items.push({
      def,
      rows: rows.map((r) => {
        const out: Record<string, string | number | boolean | null> = {}
        if (typeof r._id === 'string') out.id = idMap.get(r._id)!
        for (const c of sl.columns) {
          if (!(c.id in r)) continue
          const v = r[c.id]
          out[c.id] = c.lookupSlot && typeof v === 'string' ? (idMap.get(v) ?? null) : v
        }
        return out
      }),
    })
  }
  return items.length ? importRowsSystem(s, items, userId) : 0
}

const appHash = (def: AppDef): string => sha(def)
const tableHash = (t: TableDef): string => sha({ displayName: t.displayName, primaryColumn: t.primaryColumn, columns: t.columns.filter((c) => !c.system).map((c) => ({ n: c.name, t: c.type, r: !!c.required, u: !!c.unique, ch: c.choices ?? null, l: c.lookupTable ?? null, d: c.default ?? null, f: c.computed ?? null })) })

async function insertRecord(s: Services, rec: { id: string; pc: PlanContext; name: string; created: TemplateCreated; delivered: Delivered; solutionId?: string; userId: string; details?: unknown; sampleRows?: Record<string, string[]>; referenceRows?: Record<string, RefRecord>; dependsOn?: DepRef[] }): Promise<void> {
  await db(s).exec(
    `INSERT INTO ${T()} (id, template_id, template_version, digest, kind, mode, name, status, bindings, created, delivered, solution_id, installed_by, installed_on, modified_on, details, sample_rows, reference_rows, depends_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'installed', $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, now(), now(), $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb)`,
    [rec.id, rec.pc.pkg.id, rec.pc.pkg.version, rec.pc.entry.digest, rec.pc.pkg.kind, rec.pc.mode, rec.name, JSON.stringify(rec.pc.response.bindings), JSON.stringify(rec.created), JSON.stringify(rec.delivered), rec.solutionId ?? null, rec.userId, rec.details === undefined ? null : JSON.stringify(rec.details),
      JSON.stringify(rec.sampleRows ?? {}), JSON.stringify(rec.referenceRows ?? {}), JSON.stringify(rec.dependsOn ?? [])],
  )
}

/** a pack's tables as created or mapped here, by slot */
function packTableOf(pc: PlanContext, tableOf: Map<string, TableDef>) {
  return (slot: string): string | undefined => tableOf.get(slot)?.id ?? pc.resolution.resolved.find((x) => x.slot.id === slot && x.mode === 'map')?.tableId
}

/** hashes of every component of a pack as it is here now (delivered at install and after an upgrade) */
async function packDelivered(s: Services, ids: LinkedIds, roleTables: Set<string>): Promise<Delivered> {
  const h = partHashes(await currentParts(s, ids))
  const roles: Record<string, string> = {}
  for (const rid of Object.values(ids.roles)) {
    const r = await s.meta.roles.get(rid)
    if (r) roles[rid] = roleHash(r as RoleDef & { isMaker?: boolean }, roleTables)
  }
  return { roles, ...h }
}

/** one install inside the caller's unit of work (no backup: the caller took it) */
async function installCore(s: Services, ctx: Ctx, pc: PlanContext, installId: string, dependsOn: DepRef[], backupWord?: string): Promise<{ created: TemplateCreated; appId?: string }> {
  const user = me(ctx)
  const created: TemplateCreated = { apps: [], tables: [], roles: [], flows: [], events: [], mapped: [], sampleRows: 0 }
  for (const r of pc.resolution.resolved) if (r.mode === 'map' && r.tableId) created.mapped.push({ slot: r.slot.id, table: r.tableId, name: r.tableName ?? '' })
  const delivered: Delivered = { apps: {}, tables: {} }
  const label = pc.app?.name ?? pc.pkg.name
  let appId: string | undefined
  const tableOf = new Map<string, TableDef>()
  let sampleRows: Record<string, string[]> = {}
  let referenceRows: Record<string, RefRecord> = {}
  if (pc.mode === 'copy' && !pc.pack) {
    // 1. the tables, through the data model's plan path (one savepoint inside this unit of work)
    let ids: Record<string, string> = {}
    if (pc.modelOps.length) ids = (await applyModel(withoutBackup(s), ctx, pc.modelOps, pc.modelToken)).ids
    for (const c of pc.created) {
      const def = await s.meta.tables.get(ids[c.draftId] ?? '')
      if (!def) throw new Error(`internal: the table ${c.def.name} was not created`)
      tableOf.set(c.slot, def)
      created.tables.push({ id: def.id, name: def.name, slot: c.slot })
    }
    // 2. validation rules and events of the new tables
    for (const c of pc.created) {
      const def = tableOf.get(c.slot)!
      for (const e of c.events) {
        if (!s.kernel) break
        const saved = await s.kernel.putEvent(def, e, user.user.id)
        created.events.push({ id: saved.id, table: def.id, name: saved.name })
        if (saved.runAs === 'system') await audit(s, ctx, 'event.run_as_system', { event: saved.id, name: saved.name, via: 'template', template: pc.pkg.id }, def.id)
      }
    }
    // 3. the app (fresh node ids: two copies of a template never share them)
    if (pc.app) {
      const now = s.now()
      const def = freshAppIds(pc.app.def, () => `n${rowUid().replace(/[^A-Za-z0-9]/g, '').slice(-12)}`)
      appId = s.uid('app')
      const meta: AppMeta = { id: appId, name: pc.app.name, width: def.width, height: def.height, createdOn: now, modifiedOn: now, modifiedBy: user.user.name, description: `From the template ${pc.pkg.name}.` }
      await s.meta.apps.upsert(meta, def)
      created.apps.push({ id: appId, name: pc.app.name })
    }
    // 4. roles: default none for every other table, the template's on its slots
    if (pc.roles.length) {
      const all = await s.meta.tables.list()
      const tableIdOf = (slot: string) => tableOf.get(slot)?.id ?? pc.resolution.resolved.find((x) => x.slot.id === slot)?.tableId
      for (const r of pc.roles) {
        const mine: TablePrivilege[] = Object.entries(r.privileges).map(([slot, p]) => ({ table: tableIdOf(slot) ?? '', ...p })).filter((p) => p.table)
        const role: RoleDef & { isMaker?: boolean } = {
          id: s.uid('role'), name: r.name, ...(r.description ? { description: r.description } : {}), ...(r.isMaker ? { isMaker: true } : {}),
          privileges: [...all.filter((t) => !mine.some((p) => p.table === t.id)).map((t) => ({ table: t.id, create: false, read: 'none' as const, update: 'none' as const, delete: 'none' as const })), ...mine],
          apps: appId ? [appId] : [],
        }
        await s.meta.roles.upsert(role)
        created.roles.push({ id: role.id, name: role.name })
      }
    }
    if (pc.sample) created.sampleRows = await loadSample(inUnit(s), pc.pkg, (slot) => tableOf.get(slot), user.user.id)
  } else {
    // Linked (and every solution template): the solutions machinery (install of a solution with stable ids)
    const l = pc.linked!
    await applySolution(inUnit(s), ctx, l.pkg, l.res, 'database')
    for (const c of pc.created) {
      const def = await s.meta.tables.get(l.ids.tables[c.slot])
      if (!def) throw new Error(`internal: the table ${c.def.name} was not created`)
      tableOf.set(c.slot, def)
      created.tables.push({ id: def.id, name: def.name, slot: c.slot })
      delivered.tables![def.id] = tableHash(def)
      for (const [i, e] of c.events.entries()) created.events.push({ id: l.ids.events[`${c.slot}:${i}`], table: def.id, name: e.name ?? '' })
    }
    if (l.ids.app && pc.app) {
      const a = await s.meta.apps.get(l.ids.app)
      if (a) { appId = l.ids.app; created.apps.push({ id: l.ids.app, name: a.meta.name }); delivered.apps![l.ids.app] = appHash(a.definition) }
    }
    for (const r of pc.roles) {
      const role = await s.meta.roles.get(l.ids.roles[r.key] ?? '')
      if (role) created.roles.push({ id: role.id, name: role.name, ...(pc.pack ? { key: r.key } : {}) })
    }
    if (pc.pack) {
      const pack = pc.pack
      const tid = packTableOf(pc, tableOf)
      // the pack's roles on the tables it maps (shared slots, your own tables): its own roles only
      await grantMapped(inUnit(s), pc.roles.map((r) => ({ id: l.ids.roles[r.key], privileges: r.privileges })), tid, new Set(created.tables.map((t) => t.id)))
      for (const a of pack.apps) {
        const cur = await s.meta.apps.get(a.id)
        if (!cur) continue
        created.apps.push({ id: a.id, name: cur.meta.name, key: a.key, ...(a.phone ? { phone: true } : {}) })
        delivered.apps![a.id] = appHash(cur.definition)
      }
      appId = pack.apps[0]?.id
      created.flows = pack.flows.map((f) => ({ id: f.id, name: f.name, key: f.key }))
      created.approvalPolicies = pack.policies.map((a) => ({ id: a.id, name: a.name, key: a.key }))
      created.dashboards = pack.dashboards.map((d) => ({ id: d.id, name: d.name, key: d.key }))
      created.printTemplates = pack.prints.map((d) => ({ id: d.id, name: d.name, key: d.key }))
      created.sequences = pack.sequences.map((q) => ({ id: q.id, name: q.name, key: q.key, ...(q.action === 'reuse' ? { reused: true } : {}) }))
      // reference rows (always) and SAMPLE rows (when chosen): into the tables this install created; recorded by id
      const ref = await loadRows(inUnit(s), pc.pkg, pc.pkg.payload.reference ?? {}, (slot) => tableOf.get(slot), user.user.id, importRowsSystem)
      created.referenceRows = ref.count
      for (const [k, hash] of ref.hashes) {
        const [slot, local] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)]
        referenceRows[k] = { table: tableOf.get(slot)!.id, id: ref.ids.get(local)!, hash }
      }
      if (pc.sample) {
        const smp = await loadRows(inUnit(s), pc.pkg, pc.pkg.payload.sample ?? {}, (slot) => tableOf.get(slot), user.user.id, importRowsSystem, ref.ids)
        created.sampleRows = smp.count
        sampleRows = smp.byTable
      }
      const roleTables = new Set([...created.tables.map((t) => t.id), ...created.mapped.map((m) => m.table)])
      Object.assign(delivered, await packDelivered(s, l.ids, roleTables))
      // a Copy is not a versioned solution: its solution record goes, its components stay
      if (pc.mode === 'copy') {
        await s.meta.solutions.remove(l.ids.solution)
        await unlinkComponents(s, l.ids.solution)
      }
    } else if (pc.sample) created.sampleRows = await loadSample(inUnit(s), pc.pkg, (slot) => tableOf.get(slot), user.user.id)
  }
  const names: Record<string, string> = {}
  for (const a of created.apps) names[`app:${a.id}`] = a.name
  for (const f of created.flows) names[`flow:${f.id}`] = f.name
  for (const a of created.approvalPolicies ?? []) names[`approvalPolicy:${a.id}`] = a.name
  for (const d of created.dashboards ?? []) names[`dashboard:${d.id}`] = d.name
  for (const d of created.printTemplates ?? []) names[`printTemplate:${d.id}`] = d.name
  const linkedSolution = pc.linked && !(pc.pack && pc.mode === 'copy') ? pc.linked.ids.solution : undefined
  await insertRecord(s, {
    id: installId, pc, name: label, created, delivered, ...(linkedSolution ? { solutionId: linkedSolution } : {}), userId: user.user.id,
    ...(pc.linked ? { details: { ids: pc.linked.ids, ...(pc.pack ? { names } : {}) } } : {}), sampleRows, referenceRows, dependsOn,
  })
  await audit(s, ctx, 'template.install', {
    install: installId, template: pc.pkg.id, version: pc.pkg.version, kind: pc.pkg.kind, mode: pc.mode, digest: pc.entry.digest,
    bindings: pc.response.bindings, created: { apps: created.apps.map((a) => a.id), tables: created.tables.map((t) => t.id), roles: created.roles.map((r) => r.id), events: created.events.length, sampleRows: created.sampleRows, ...(pc.pack ? { flows: created.flows.map((f) => f.id), approvalPolicies: (created.approvalPolicies ?? []).map((a) => a.id), dashboards: (created.dashboards ?? []).map((d) => d.id), printTemplates: (created.printTemplates ?? []).map((d) => d.id), sequences: (created.sequences ?? []).map((q) => q.id), referenceRows: created.referenceRows ?? 0 } : {}) },
    ...(pc.response.stripped.length ? { stripped: pc.response.stripped } : {}), ...(pc.response.systemItems.length ? { approvedSystem: pc.response.systemItems } : {}),
    ...(dependsOn.length ? { dependsOn: dependsOn.map((d) => d.install) } : {}), ...(backupWord ? { backup: backupWord } : {}),
  })
  return { created, ...(appId ? { appId } : {}) }
}

export async function installTemplate(s: Services, ctx: Ctx, id: string, req: TemplateUseRequest): Promise<TemplateInstallResult> {
  const user = me(ctx)
  const pc = await planTemplate(s, ctx, id, req)
  const { plan } = pc.response
  if (plan.problems.length) throw invalid(`The template cannot be installed here: ${plan.problems[0]}`, undefined, { plan: pc.response })
  if (req.confirm !== plan.token) throw new HttpError(409, 'conflict', req.confirm === undefined ? 'Review the plan and confirm it.' : 'This environment changed since the plan was made. Review the new plan and confirm it again.', undefined, { plan: pc.response })
  if (pc.response.systemItems.length && !(user.privileges.isAdmin && req.approveSystem === true)) {
    throw new HttpError(409, 'conflict', `The template has table events that run as the system (${pc.response.systemItems.join(', ')}): an administrator must approve them.`, 'approveSystem', { plan: pc.response })
  }
  const backup = pc.serverChanges ? await takeBackup(s, ctx, `before installing the template ${pc.pkg.name} ${pc.pkg.version}`, req.proceedWithoutBackup === true) : undefined
  const installId = s.uid('tpli')
  let out: { created: TemplateCreated; appId?: string } = { created: { apps: [], tables: [], roles: [], flows: [], events: [], mapped: [], sampleRows: 0 } }
  await s.transaction(async () => {
    // format 2: the dependencies that are not here first (each its own install, in this unit of work)
    const dependsOn: DepRef[] = []
    for (const d of pc.deps) {
      if (d.installed) { dependsOn.push({ template: d.report.id, install: d.installed.id, name: d.installed.name, version: d.installed.template_version }); continue }
      if (!d.pc) continue
      const did = s.uid('tpli')
      await installCore(s, ctx, d.pc, did, [], backup ? (backup.taken ? 'taken' : 'none') : undefined)
      dependsOn.push({ template: d.report.id, install: did, name: d.pc.pkg.name, version: d.pc.pkg.version })
    }
    out = await installCore(s, ctx, pc, installId, dependsOn, backup ? (backup.taken ? 'taken' : 'none') : undefined)
    if (req.target && (pc.pkg.kind === 'component' || pc.pkg.kind === 'screen')) {
      const target = { ...(req.target.appId ? { appId: req.target.appId } : {}), ...(req.target.appName ? { appName: req.target.appName } : {}), ...(req.target.screenName ? { screenName: req.target.screenName } : {}) }
      await db(s).exec(`UPDATE ${T()} SET created = created || $2::jsonb WHERE id = $1`, [installId, JSON.stringify({ target })])
    }
  })
  s.security.invalidate()
  const rec = await recordOf(s, installId)
  return {
    install: rec, ...(pc.nodes ? { controls: pc.nodes } : {}), ...(pc.screen ? { screen: pc.screen } : {}), dataSources: pc.dataSources, ...(out.appId ? { appId: out.appId } : {}),
    ...(backup ? { backup } : {}), warnings: plan.warnings,
  }
}

/* ------------------------------------------------------------------ after an install: flows, sample data */

/** "Switch on these flows" (rule 8: an administrator turns on what a pack brought, explicitly; audited) */
export async function enableInstallFlows(s: Services, ctx: Ctx, id: string, b: { enable?: unknown }): Promise<TemplateInstallRecord> {
  const user = me(ctx)
  if (!user.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only an administrator of this environment can switch on the flows a template brought.')
  const row = await installRow(s, id)
  if (row.status !== 'installed') throw invalid('This template was uninstalled.')
  const want = Array.isArray(b.enable) ? b.enable.map(String) : []
  const mine = new Set((row.created?.flows ?? []).map((f) => f.id))
  const bad = want.filter((f) => !mine.has(f))
  if (bad.length || !want.length) throw invalid(bad.length ? 'Only the flows this install brought can be switched on here.' : 'Choose the flows to switch on.', 'enable')
  const fl = (s as unknown as { flows?: { store: { get(id: string): Promise<(Record<string, unknown> & { id: string; name: string; ownerId: string; connections: { ref: string; connectionId: string; connector?: string }[] }) | null>; setEnabled(id: string, on: boolean, by: string): Promise<void> }; validate(doc: unknown, id: string | null, conns: unknown[]): Promise<{ severity: string; message: string }[]>; syncSchedule(f: unknown): Promise<void>; invalidate(): void } }).flows
  if (!fl) throw new HttpError(503, 'unavailable', 'Flows are not available on this server.')
  const done: string[] = []
  await s.transaction(async () => {
    for (const fid of want) {
      const f = await fl.store.get(fid)
      if (!f) continue
      const doc = { name: f.name, ...(f.description ? { description: f.description } : {}), runAs: f.runAs, trigger: f.trigger, steps: f.steps, ...(f.variables ? { variables: f.variables } : {}), settings: f.settings }
      const problems = (await fl.validate(doc, f.id, f.connections.map((c) => ({ ref: c.ref, connectionId: c.connectionId, connector: c.connector ?? '' })))).filter((p) => p.severity === 'error')
      if (problems.length) throw invalid(`The flow "${f.name}" cannot be turned on: ${problems[0].message}`)
      await fl.store.setEnabled(fid, true, user.user.id)
      await fl.syncSchedule({ ...f, enabled: true, suspended: undefined })
      await audit(s, ctx, 'flow.enable', { flow: fid, name: f.name, via: 'template', install: id })
      done.push(fid)
    }
    await audit(s, ctx, 'template.flows.enable', { install: id, template: row.template_id, flows: done })
  })
  fl.invalidate()
  return recordOf(s, id)
}

/** "Remove sample data": deletes exactly the SAMPLE rows this install added that are still here (rows people added stay) */
export async function removeSampleData(s: Services, ctx: Ctx, id: string): Promise<{ install: TemplateInstallRecord; removed: number; kept: { table: string; id: string; reason: string }[] }> {
  const row = await installRow(s, id)
  if (row.status !== 'installed') throw invalid('This template was uninstalled.')
  if ((await envInfo(s)).locked) throw new HttpError(403, 'denied', LOCKED_MESSAGE)
  const byTable = row.sample_rows ?? {}
  if (!countRows(byTable)) throw invalid('This install has no SAMPLE rows left.')
  const order = (row.created?.tables ?? []).map((t) => t.id)
  let res: { removed: number; kept: { table: string; id: string; reason: string }[] } = { removed: 0, kept: [] }
  await s.transaction(async () => {
    res = await removeRows(inUnit(s), byTable, order)
    // rows still used by other rows are remembered; the rest are gone
    const left: Record<string, string[]> = {}
    for (const k of res.kept) {
      const t = Object.keys(byTable).find((tid) => byTable[tid].includes(k.id))
      if (t) (left[t] ??= []).push(k.id)
    }
    await db(s).exec(`UPDATE ${T()} SET sample_rows = $2::jsonb, modified_on = now() WHERE id = $1`, [id, JSON.stringify(left)])
    await audit(s, ctx, 'template.sample.remove', { install: id, template: row.template_id, removed: res.removed, kept: res.kept.length })
  })
  return { install: await recordOf(s, id), ...res }
}

/* ------------------------------------------------------------------ uninstall */

interface UninstallContext {
  row: InstallRow; plan: UninstallPlan; dropOps: ModelOp[]; dropToken: string; apps: string[]; roles: string[]; flows: string[]
  policies: string[]; dashboards: string[]; prints: string[]; sequences: string[]
}

export async function uninstallContext(s: Services, ctx: Ctx, id: string, deleteTables: boolean): Promise<UninstallContext> {
  const user = me(ctx)
  const row = await installRow(s, id)
  const all0 = await db(s).query<InstallRow>(`SELECT * FROM ${T()}`)
  const rec = toRecord(row, { usedBy: usedByOf(all0, id) })
  const items: UninstallItem[] = []
  const problems: string[] = []
  const warnings: string[] = []
  if (row.status !== 'installed') problems.push('This template was uninstalled already.')
  if (row.kind !== 'app' && row.kind !== 'dataModel' && row.kind !== 'solution') problems.push('UI component and screen templates became part of your app: remove them in the Studio (or with Undo).')
  // dependencies respected: a pack another installed pack depends on stays
  const usedBy = usedByOf(all0, id)
  if (usedBy.length) problems.push(`${usedBy.map((u) => u.name).join(', ')} ${usedBy.length === 1 ? 'needs' : 'need'} this template: uninstall ${usedBy.length === 1 ? 'it' : 'them'} first.`)
  const target = await envInfo(s)
  if (target.locked) problems.push(LOCKED_MESSAGE)
  const c = row.created ?? ({} as TemplateCreated)
  const apps: string[] = []
  for (const a of c.apps ?? []) {
    const cur = await s.meta.apps.get(a.id)
    if (!cur) continue
    apps.push(a.id)
    items.push({ kind: 'app', id: a.id, name: cur.meta.name, action: 'removed', note: 'the app is deleted (its definition; the data stays in its tables)' })
  }
  const roles: string[] = []
  for (const r of c.roles ?? []) {
    const cur = await s.meta.roles.get(r.id)
    if (!cur) continue
    roles.push(r.id)
    items.push({ kind: 'role', id: r.id, name: cur.name, action: 'removed', note: 'the role is deleted; people who hold it lose it' })
  }
  if ((roles.length || row.kind === 'solution') && !user.privileges.isAdmin) problems.push(row.kind === 'solution' ? 'Only an administrator can uninstall a solution template.' : 'The template created roles: only an administrator can uninstall it.')
  const flows: string[] = []
  const fl = (s as unknown as { flows?: { store: { get(id: string): Promise<{ name?: string } | null> } } }).flows
  for (const f of c.flows ?? []) {
    if (!(await fl?.store.get(f.id))) continue
    flows.push(f.id)
    items.push({ kind: 'flow', id: f.id, name: f.name, action: 'removed', note: 'the flow is deleted (its active runs are cancelled; the run history stays)' })
  }
  // format 2: approval policies, dashboards, print templates, number sequences
  const exists = async (table: string, cid: string) => (await db(s).query(`SELECT 1 FROM "${currentEnvironment().schema}"."${table}" WHERE id = $1`, [cid])).length > 0
  const policies: string[] = []
  for (const a of c.approvalPolicies ?? []) if (await exists('ab_approval_policies', a.id)) { policies.push(a.id); items.push({ kind: 'approvalPolicy', id: a.id, name: a.name, action: 'removed', note: 'open requests keep their copy of the definition' }) }
  const dashboards: string[] = []
  for (const d of c.dashboards ?? []) if (await exists('ab_dashboards', d.id)) { dashboards.push(d.id); items.push({ kind: 'dashboard', id: d.id, name: d.name, action: 'removed', note: 'the dashboard is deleted with its view tokens and email snapshots' }) }
  const prints: string[] = []
  for (const d of c.printTemplates ?? []) if (await exists('ab_print_templates', d.id)) { prints.push(d.id); items.push({ kind: 'printTemplate', id: d.id, name: d.name, action: 'removed', note: 'documents already generated stay where they were stored' }) }
  const sequences: string[] = []
  if (c.sequences?.length) {
    const rows = await listSequences(s)
    for (const q of c.sequences) {
      const cur = rows.find((r) => r.id === q.id)
      if (!cur) continue
      if (q.reused) { items.push({ kind: 'numberSequence', id: q.id, name: cur.name, action: 'kept', note: 'it was here before the template: never removed' }); continue }
      if (cur.nextValue > 1) { items.push({ kind: 'numberSequence', id: q.id, name: cur.name, action: 'kept', note: `kept: it numbered ${cur.nextValue - 1} document${cur.nextValue === 2 ? '' : 's'} (their numbers stay unique)` }); continue }
      sequences.push(q.id)
      items.push({ kind: 'numberSequence', id: q.id, name: cur.name, action: 'removed', note: 'never used: it is deleted' })
    }
  }
  const all = await s.meta.tables.list()
  const createdIds = new Set((c.tables ?? []).map((t) => t.id))
  const appsAll = await s.meta.apps.list()
  const tablesWithData: UninstallPlan['tablesWithData'] = []
  const drop: TableDef[] = []
  // a table points at another when it looks it up, or is a reporting view or summary of it
  const pointsAt = (x: TableDef, def: TableDef): boolean => x.id !== def.id && (x.columns.some((col) => col.type === 'lookup' && col.lookupTable?.toLowerCase() === def.name.toLowerCase()) || (x.reporting?.kind === 'view' && x.reporting.base === def.id) || (x.reporting?.kind === 'summary' && x.reporting.source === def.id))
  const decided: { def: TableDef; rows: number; keep: string | null; withData: boolean }[] = []
  for (const t of c.tables ?? []) {
    const def = all.find((x) => x.id === t.id)
    if (!def) continue
    let rows = 0
    try {
      const conn = await s.connections.get(def.connectionId ?? 'conn_default')
      const r = await conn.select(def, { select: ['id'], count: true, top: 1 })
      rows = r.total ?? r.rows.length
    } catch { rows = 0 }
    const referrers = all.filter((x) => !createdIds.has(x.id) && pointsAt(x, def))
    const users = []
    for (const a of appsAll) {
      if (apps.includes(a.id)) continue
      const full = await s.meta.apps.get(a.id)
      if ((full?.definition.dataSources ?? []).some((n) => n.toLowerCase() === def.name.toLowerCase())) users.push(a.name)
    }
    if (referrers.length || users.length) decided.push({ def, rows, withData: false, keep: `kept: ${[referrers.length ? `the tables ${referrers.map((x) => x.displayName).join(', ')} point at it` : '', users.length ? `the apps ${users.join(', ')} use it` : ''].filter(Boolean).join('; ')}` })
    else decided.push({ def, rows, withData: rows > 0, keep: rows > 0 && !deleteTables ? `kept with its ${rows} row${rows === 1 ? '' : 's'} (an administrator can tick "Delete tables with data")` : null })
  }
  // a table of the template that would go (it is empty, say after "Remove sample data") but that a KEPT table of the
  // template looks up stays too: dropping it would break the kept table (the data model refuses that). Repeated until
  // nothing changes, so a chain of lookups is followed.
  for (let changed = true; changed;) {
    changed = false
    for (const d of decided) {
      if (d.keep) continue
      const by = decided.filter((k) => k.keep && pointsAt(k.def, d.def))
      if (!by.length) continue
      d.keep = `kept: the table${by.length === 1 ? '' : 's'} ${by.map((k) => k.def.displayName).join(', ')}, kept, ${by.length === 1 ? 'looks' : 'look'} it up${d.rows ? '' : ' (it is empty)'}`
      d.withData = false
      changed = true
    }
  }
  for (const d of decided) {
    const { def, rows } = d
    if (d.withData) tablesWithData.push({ id: def.id, name: def.displayName, rows })
    if (d.keep) {
      items.push({ kind: 'table', id: def.id, name: def.displayName, action: 'kept', rows, note: d.keep })
      continue
    }
    items.push({ kind: 'table', id: def.id, name: def.displayName, action: 'removed', rows, ...(rows > 0 ? { destructive: true } : {}), note: rows > 0 ? `the table and its ${rows} row${rows === 1 ? '' : 's'} are deleted` : 'empty: the table is deleted' })
    drop.push(def)
  }
  for (const m of c.mapped ?? []) {
    const def = all.find((x) => x.id === m.table)
    if (def) items.push({ kind: 'table', id: def.id, name: def.displayName, action: 'kept', note: 'not created by this template (yours, or shared with another): never touched' })
  }
  if (deleteTables && tablesWithData.length && !user.privileges.isAdmin) problems.push('Only an administrator can delete tables with data.')
  if (row.solution_id && (await s.meta.solutions.list()).some((x) => x.id === row.solution_id)) items.push({ kind: 'solution', id: row.solution_id, name: `${row.name} (template)`, action: 'removed', note: 'the linked solution record goes; nothing else in it is touched except what is listed here' })
  // tables that go: through the data model's plan path (views and lookups are handled there)
  const dropOps: ModelOp[] = drop.map((t) => ({ op: 'dropTable', id: t.id, name: t.name }))
  let dropToken = ''
  if (dropOps.length && !problems.length) {
    const mp = await planModel(s, user, dropOps)
    problems.push(...mp.plan.problems)
    dropToken = mp.plan.token
  }
  const backupOn = !!s.backup?.available()
  const token = createHash('sha256').update(canonicalJson({ id, items, problems, dropToken, env: target.id })).digest('hex').slice(0, 32)
  return {
    row, apps, roles, flows, policies, dashboards, prints, sequences, dropOps, dropToken,
    plan: {
      install: rec, items, problems, warnings, tablesWithData, confirmText: row.name,
      backup: backupOn ? { available: true, message: 'A backup of this environment is taken before anything is removed.' } : { available: false, message: NO_BACKUP_MESSAGE }, token,
    },
  }
}

export async function planUninstall(s: Services, ctx: Ctx, id: string, deleteTables: boolean): Promise<UninstallPlan> {
  return (await uninstallContext(s, ctx, id, deleteTables)).plan
}

export async function uninstallTemplate(s: Services, ctx: Ctx, id: string, b: { confirm?: unknown; deleteTables?: boolean; confirmText?: unknown; proceedWithoutBackup?: boolean }): Promise<UninstallPlan> {
  const user = me(ctx)
  const uc = await uninstallContext(s, ctx, id, b.deleteTables === true)
  if (uc.plan.problems.length) throw invalid(`The template cannot be uninstalled: ${uc.plan.problems[0]}`, undefined, { plan: uc.plan })
  if (b.confirm !== uc.plan.token) throw new HttpError(409, 'conflict', 'Something changed since the plan was made. Review it again.', undefined, { plan: uc.plan })
  const losing = uc.plan.items.some((i) => i.kind === 'table' && i.action === 'removed' && (i.rows ?? 0) > 0)
  if (losing && b.confirmText !== uc.plan.confirmText) throw invalid(`Type "${uc.plan.confirmText}" to confirm that the tables and their rows are deleted.`, 'confirmText')
  const backup = await takeBackup(s, ctx, `before uninstalling the template ${uc.row.name}`, b.proceedWithoutBackup === true)
  await s.transaction(async () => {
    const u = inUnit(s)
    for (const a of uc.apps) { await s.meta.apps.remove(a); await forgetApp(u, a) }
    if (uc.flows.length) await applyFlows(u, user, { upsert: [], remove: uc.flows, mapping: new Map() }, uc.row.solution_id ?? '', new Map())
    if (uc.policies.length) await applyApprovalPolicies(u, user.user.id, { upsert: [], remove: uc.policies, peopleMap: new Map() }, uc.row.solution_id ?? '')
    if (uc.dashboards.length) await applyDashboards(u, user.user.id, { upsert: [], remove: uc.dashboards }, new Map())
    if (uc.prints.length) await applyPrintTemplates(u, user.user.id, { upsert: [], remove: uc.prints }, uc.row.solution_id ?? '')
    if (uc.sequences.length) await s.data.delete(null, await sequenceTable(s), uc.sequences)
    for (const r of uc.roles) await s.meta.roles.remove(r)
    if (uc.dropOps.length) await applyModel(withoutBackup(s), ctx, uc.dropOps, uc.dropToken)
    if (uc.row.solution_id && (await s.meta.solutions.list()).some((x) => x.id === uc.row.solution_id)) await s.meta.solutions.remove(uc.row.solution_id)
    await db(s).exec(`UPDATE ${T()} SET status = 'uninstalled', uninstalled_by = $2, uninstalled_on = now(), modified_on = now(), details = coalesce(details, '{}'::jsonb) || $3::jsonb WHERE id = $1`, [id, user.user.id, JSON.stringify({ uninstall: uc.plan.items.map((i) => ({ kind: i.kind, id: i.id, action: i.action })) })])
    await audit(s, ctx, 'template.uninstall', { install: id, template: uc.row.template_id, items: uc.plan.items.map((i) => ({ kind: i.kind, id: i.id, action: i.action, ...(i.rows ? { rows: i.rows } : {}) })), deleteTables: b.deleteTables === true, backup: backup?.taken ? 'taken' : 'none' })
  })
  if (uc.flows.length) await afterApplyFlows(s, uc.flows, user.user.id).catch(() => {})
  s.security.invalidate()
  return { ...uc.plan, install: await recordOf(s, id) }
}

/* ------------------------------------------------------------------ upgrade (Linked) */

interface UpgradeContext { row: InstallRow; pc: PlanContext; up: UpgradePlan; solPkg: SolutionPkg; res: PlanResult; newer: CatalogueEntry; keptLocal: Set<string>; refPlan: RefPlan[] }
/** a reference row of the new version: added, updated (unchanged here since delivered), kept (changed here), or gone here */
interface RefPlan { key: string; slot: string; local: string; action: 'add' | 'update' | 'keep' | 'gone' | 'same'; id?: string; table?: string }

/** a pack table across versions: never a column dropped (kept: "no longer used"); keep: the settings here win, replace: the new version's */
function mergeTable(cur: TableDef, next: Omit<TableDef, 'id'>, choice: 'keep' | 'replace', delivered: Set<string>, noLonger: string[]): TableDef {
  const base = plainTableDef(cur)
  const nextCols = next.columns.filter((c) => !c.system)
  const cols = base.columns.filter((c) => c.system)
  for (const c of nextCols) {
    const here = base.columns.find((x) => x.name === c.name)
    cols.push(here && choice === 'keep' ? here : c)
  }
  for (const c of base.columns.filter((x) => !x.system && !nextCols.some((n) => n.name === x.name))) {
    cols.push(c)
    if (delivered.has(c.name)) noLonger.push(`${cur.displayName}.${c.displayName}: no longer used by the template (kept with its values)`)
  }
  const props = choice === 'keep' ? { displayName: base.displayName, primaryColumn: base.primaryColumn, description: base.description } : { displayName: next.displayName, primaryColumn: next.primaryColumn, description: next.description }
  const out: TableDef = { ...base, ...props, columns: cols }
  if (!out.description) delete out.description
  if (next.uniqueTogether && choice === 'replace') out.uniqueTogether = next.uniqueTogether
  return out
}

async function upgradeContext(s: Services, ctx: Ctx, id: string, choices: Record<string, 'keep' | 'replace'>): Promise<UpgradeContext> {
  const user = me(ctx)
  const row = await installRow(s, id)
  if (row.mode !== 'linked' || row.status !== 'installed') throw invalid('Only an installed Linked template can be upgraded.')
  const newer = findTemplate(row.template_id)
  if (!newer || newer.integrity === 'damaged') throw invalid('The catalogue has no usable version of this template.')
  const ids = row.details?.ids
  if (!ids) throw invalid('This install has no record of its components; it cannot be upgraded.')
  const pack = newer.pkg.kind === 'solution'
  // the bindings of the install, against the new version (new slots get their defaults)
  const pc = await planTemplate(s, ctx, row.template_id, { mode: pack ? 'linked' : 'copy', bindings: row.bindings, ...(row.kind === 'app' ? { appName: row.created.apps[0]?.name } : {}) }, pack ? { upgrade: row } : {})
  const pids = pc.ids ?? ids
  // the plan above saw the install's own tables and app as clashes; the upgrade replaces exactly those
  const ownTables = new Set(Object.values(pids.tables))
  const keepTables: Record<string, TableDef> = {}
  const keepApps: Record<string, AppDef> = {}
  const keep: DocKeep = { tables: keepTables, apps: keepApps }
  const localChanges: UpgradePlan['localChanges'] = []
  const keptLocal = new Set<string>()
  const noLonger: string[] = []
  const pick = (key: string): 'keep' | 'replace' => (choices[key] === 'replace' ? 'replace' : 'keep')
  const note = (key: string, kind: LocalChangeKind, name: string) => {
    const choice = pick(key)
    localChanges.push({ key, kind, name, choice })
    if (choice === 'keep') keptLocal.add(key)
    return choice
  }
  for (const [tid, hash] of Object.entries(row.delivered?.tables ?? {})) {
    const cur = await s.meta.tables.get(tid)
    if (!cur || tableHash(cur) === hash) continue
    if (note(`table:${tid}`, 'table', cur.displayName) === 'keep') keepTables[tid] = cur
  }
  for (const [aid, hash] of Object.entries(row.delivered?.apps ?? {})) {
    const cur = await s.meta.apps.get(aid)
    if (!cur || appHash(cur.definition) === hash) continue
    if (note(`app:${aid}`, 'app', cur.meta.name) === 'keep') keepApps[aid] = cur.definition
  }
  let refPlan: RefPlan[] = []
  if (pack) {
    // format 2: every component kind compared with what was delivered
    const cur = await currentParts(s, pids)
    const now = partHashes(cur)
    const kinds: [keyof typeof now, LocalChangeKind, keyof KeepParts][] = [['flows', 'flow', 'flows'], ['approvalPolicies', 'approvalPolicy', 'policies'], ['dashboards', 'dashboard', 'dashboards'], ['printTemplates', 'printTemplate', 'prints'], ['numberSequences', 'numberSequence', 'sequences']]
    for (const [dk, lk, kk] of kinds) {
      for (const [cid, hash] of Object.entries(row.delivered?.[dk] ?? {})) {
        const h = now[dk][cid]
        if (!h || h === hash) continue
        const v = cur[kk][cid] as { name?: string }
        if (note(`${lk}:${cid}`, lk, String(v?.name ?? cid)) === 'keep') (keep[kk] ??= {})[cid] = v
      }
    }
    const roleTables = new Set([...row.created.tables.map((t) => t.id), ...row.created.mapped.map((m) => m.table)])
    for (const [rid, hash] of Object.entries(row.delivered?.roles ?? {})) {
      const r = await s.meta.roles.get(rid)
      if (!r || roleHash(r as RoleDef & { isMaker?: boolean }, roleTables) === hash) continue
      if (note(`role:${rid}`, 'role', r.name) === 'keep') (keep.roles ??= {})[rid] = r
    }
    // tables: never a column dropped; the slots the new version no longer has keep their tables as they are
    for (const c of pc.created) {
      const tid = pids.tables[c.slot]
      const curT = tid ? await s.meta.tables.get(tid) : null
      if (!curT || curT.id !== tid) continue
      const deliveredCols = new Set(curT.columns.filter((x) => !x.system).map((x) => x.name))
      keepTables[tid] = mergeTable(curT, c.def, keptLocal.has(`table:${tid}`) ? 'keep' : 'replace', deliveredCols, noLonger)
    }
    for (const t of row.created.tables) {
      if (pc.created.some((c) => pids.tables[c.slot] === t.id)) continue
      if (await s.meta.tables.get(t.id)) noLonger.push(`${t.name}: no longer part of the template (the table and its rows are kept)`)
    }
    // reference rows: new ones added; unchanged ones updated; ones changed here kept (or replaced by choice); deleted ones stay deleted
    const refs = row.reference_rows ?? {}
    for (const sl of newer.pkg.slots) {
      const def = pc.created.find((c) => c.slot === sl.id) ? await s.meta.tables.get(pids.tables[sl.id]) : null
      for (const r of newer.pkg.payload.reference?.[sl.id] ?? []) {
        const key = `${sl.id}:${String(r._id)}`
        const rec = refs[key]
        if (!rec) { refPlan.push({ key, slot: sl.id, local: String(r._id), action: 'add' }); continue }
        const here = def ? await currentRowHash(s, def, rec.id, sl.columns.map((c) => c.id)) : null
        if (here === null) { refPlan.push({ key, slot: sl.id, local: String(r._id), action: 'gone', id: rec.id, table: rec.table }); continue }
        if (here === rec.hash) { refPlan.push({ key, slot: sl.id, local: String(r._id), action: 'update', id: rec.id, table: rec.table }); continue }
        const choice = note(`referenceRow:${key}`, 'referenceRow', `${sl.label}: ${String(r[sl.create?.primaryColumn ?? ''] ?? r._id)}`)
        refPlan.push({ key, slot: sl.id, local: String(r._id), action: choice === 'keep' ? 'keep' : 'update', id: rec.id, table: rec.table })
      }
    }
    refPlan = refPlan.filter((x) => x.action !== 'same')
  }
  // the new version's document with the install's ids (slots it created keep their names)
  const created = pc.created.map((c) => {
    const tid = pids.tables[c.slot]
    const existing = tid ? (row.created.tables.find((t) => t.id === tid)) : undefined
    return existing ? { ...c, def: { ...c.def, name: existing.name } } : c
  })
  // slots the new version no longer has: their tables stay in the solution as they are (data is never dropped by an upgrade)
  const gone: CreatedSlot[] = []
  if (pack) for (const t of row.created.tables) {
    if (created.some((c) => pids.tables[c.slot] === t.id)) continue
    const def = await s.meta.tables.get(t.id)
    if (!def) continue
    keepTables[t.id] = def
    gone.push({ slot: t.slot, draftId: t.id, def: plainTableDef(def), events: [], lookups: [] })
  }
  const resolution: Resolution = {
    ...pc.resolution,
    problems: pc.resolution.problems.filter((p) => !/already exists here/.test(p)),
    resolved: pc.resolution.resolved.map((r) => {
      const tid = pids.tables[r.slot.id]
      const mine = tid && ownTables.has(tid) ? row.created.tables.find((t) => t.id === tid) : undefined
      return mine && r.mode === 'create' ? { ...r, tableName: mine.name } : r
    }),
  }
  const appName = row.created.apps[0]?.name ?? pc.app?.name ?? row.name
  const base = { ...pc, created: [...created, ...gone], resolution, ...(pc.app ? { app: { def: { ...pc.app.def, name: appName }, name: appName } } : {}) }
  const goneIds: LinkedIds = { ...pids, tables: { ...pids.tables, ...Object.fromEntries(gone.map((g) => [g.slot, g.draftId])) } }
  const doc = linkedDocument(base, goneIds, keep)
  const solPkg = readSolutionPkg(toYaml(doc), s)!
  const res = await planSolution(s, user, solPkg, { expectTables: [] })
  const problems = [...res.plan.problems, ...(pack ? pc.response.plan.problems.filter((p) => !/already exists here|already installed here as Linked/.test(p)) : [])]
  if (compareVersions(newer.pkg.version, row.template_version) <= 0) problems.unshift(`The installed version ${row.template_version} is the newest in the catalogue.`)
  const target = await envInfo(s)
  if (target.locked) problems.push(`${LOCKED_MESSAGE}`)
  const items = [...res.plan.items]
  if (pack) {
    // components kept local are listed as such; reference rows the upgrade adds or updates
    for (const it of items) if (keptLocal.has(`${it.kind}:${it.id}`) && it.change === 'unchanged') it.note = 'changed here since the template delivered it: your version is kept'
    const adds = refPlan.filter((r) => r.action === 'add').length
    const upd = refPlan.filter((r) => r.action === 'update').length
    if (adds || upd) items.push({ kind: 'table', id: '', name: 'Reference rows', change: 'changed', note: [adds ? `${adds} new` : '', upd ? `${upd} updated (unchanged here since delivered)` : ''].filter(Boolean).join(', ') })
  }
  const token = createHash('sha256').update(canonicalJson({ t: res.plan.token, ref: refPlan.map((r) => [r.key, r.action]), keep: [...keptLocal].sort() })).digest('hex').slice(0, 32)
  const plan: SolutionPlan = { ...res.plan, items, token, solution: { ...res.plan.solution, displayName: `${newer.pkg.name} (template, linked)`, version: newer.pkg.version, fromVersion: row.template_version }, problems: [...new Set(problems)], warnings: [...new Set([...res.plan.warnings, ...noLonger])] }
  return { row, pc, newer, solPkg, res, keptLocal, refPlan, up: { plan, from: row.template_version, to: newer.pkg.version, localChanges, ...(noLonger.length ? { noLongerUsed: noLonger } : {}) } }
}

export async function planUpgrade(s: Services, ctx: Ctx, id: string, choices: Record<string, 'keep' | 'replace'>): Promise<UpgradePlan> {
  return (await upgradeContext(s, ctx, id, choices)).up
}

export async function upgradeTemplate(s: Services, ctx: Ctx, id: string, b: { confirm?: unknown; choices?: Record<string, 'keep' | 'replace'>; proceedWithoutBackup?: boolean }): Promise<UpgradePlan> {
  const user = me(ctx)
  const uc = await upgradeContext(s, ctx, id, b.choices ?? {})
  if (uc.up.plan.problems.length) throw invalid(`The template cannot be upgraded: ${uc.up.plan.problems[0]}`, undefined, { plan: uc.up })
  if (b.confirm !== uc.up.plan.token) throw new HttpError(409, 'conflict', 'Something changed since the plan was made. Review it again.', undefined, { plan: uc.up })
  await s.transaction(async () => {
    await applySolution(inUnit(s, { keepBackup: true }), ctx, uc.solPkg, uc.res, 'database', { proceedWithoutBackup: b.proceedWithoutBackup === true })
    const ids = uc.pc.ids ?? uc.row.details!.ids!
    const kept = (key: string) => uc.keptLocal.has(key)
    const delivered: Delivered = { apps: {}, tables: {} }
    for (const tid of Object.values(ids.tables)) {
      const def = await s.meta.tables.get(tid)
      // a component kept local stays "changed" against what the template delivers now
      if (def && def.id === tid) delivered.tables![tid] = kept(`table:${tid}`) ? (uc.row.delivered?.tables?.[tid] ?? '') : tableHash(def)
    }
    if (ids.app) {
      const a = await s.meta.apps.get(ids.app)
      if (a) delivered.apps![ids.app] = kept(`app:${ids.app}`) ? (uc.row.delivered?.apps?.[ids.app] ?? '') : appHash(a.definition)
    }
    let created = uc.row.created
    let referenceRows = uc.row.reference_rows ?? {}
    if (uc.pc.pack) {
      const pc = uc.pc
      const pack = pc.pack!
      for (const aid of Object.values(ids.apps ?? {})) {
        const a = await s.meta.apps.get(aid)
        if (a) delivered.apps![aid] = kept(`app:${aid}`) ? (uc.row.delivered?.apps?.[aid] ?? '') : appHash(a.definition)
      }
      const tableOf = new Map<string, TableDef>()
      for (const [slot, tid] of Object.entries(ids.tables)) { const d = await s.meta.tables.get(tid); if (d && d.id === tid) tableOf.set(slot, d) }
      await grantMapped(inUnit(s), pc.roles.filter((r) => !kept(`role:${ids.roles[r.key]}`)).map((r) => ({ id: ids.roles[r.key], privileges: r.privileges })), packTableOf(pc, tableOf), new Set([...tableOf.values()].map((t) => t.id)))
      // reference rows
      const add: Record<string, NonNullable<TemplatePackage['payload']['reference']>[string]> = {}
      const known = new Map<string, string>(Object.entries(referenceRows).map(([k, r]) => [k.slice(k.indexOf(':') + 1), r.id]))
      for (const r of uc.refPlan) {
        const src = pc.pkg.payload.reference?.[r.slot]?.find((x) => String(x._id) === r.local)
        if (!src) continue
        if (r.action === 'add') (add[r.slot] ??= []).push(src)
        if (r.action === 'update' && r.id && tableOf.get(r.slot)) {
          const sl = pc.pkg.slots.find((x) => x.id === r.slot)!
          const values: Record<string, string | number | boolean | null> = {}
          for (const c of sl.columns) if (c.id in src) values[c.id] = c.lookupSlot && typeof src[c.id] === 'string' ? (known.get(String(src[c.id])) ?? null) : src[c.id]
          await s.data.update(null, tableOf.get(r.slot)!, r.id, values)
        }
      }
      const loaded = await loadRows(inUnit(s), pc.pkg, add, (slot) => tableOf.get(slot), user.user.id, importRowsSystem, known)
      referenceRows = { ...referenceRows }
      for (const [k, hash] of loaded.hashes) { const slot = k.slice(0, k.indexOf(':')); referenceRows[k] = { table: tableOf.get(slot)!.id, id: loaded.ids.get(k.slice(k.indexOf(':') + 1))!, hash } }
      for (const r of uc.refPlan.filter((x) => x.action === 'update' && x.id)) {
        const sl = pc.pkg.slots.find((x) => x.id === r.slot)!
        const h = await currentRowHash(s, tableOf.get(r.slot)!, r.id!, sl.columns.map((c) => c.id))
        if (h) referenceRows[r.key] = { table: r.table!, id: r.id!, hash: h }
      }
      // every component as delivered now (kept ones keep their old hash, so they are listed again next time)
      const roleTables = new Set([...tableOf.values()].map((t) => t.id).concat(uc.row.created.mapped.map((m) => m.table)))
      const now = await packDelivered(s, ids, roleTables)
      for (const k of ['roles', 'flows', 'approvalPolicies', 'dashboards', 'printTemplates', 'numberSequences'] as const) {
        const lk = ({ roles: 'role', flows: 'flow', approvalPolicies: 'approvalPolicy', dashboards: 'dashboard', printTemplates: 'printTemplate', numberSequences: 'numberSequence' } as const)[k]
        delivered[k] = Object.fromEntries(Object.entries(now[k] ?? {}).map(([cid, h]) => [cid, kept(`${lk}:${cid}`) ? (uc.row.delivered?.[k]?.[cid] ?? '') : h]))
      }
      created = {
        ...uc.row.created,
        tables: [...uc.row.created.tables, ...pc.created.filter((c) => !uc.row.created.tables.some((t) => t.id === ids.tables[c.slot])).map((c) => ({ id: ids.tables[c.slot], name: tableOf.get(c.slot)?.name ?? c.def.name, slot: c.slot }))],
        apps: pack.apps.map((a) => ({ id: a.id, name: uc.row.created.apps.find((x) => x.id === a.id)?.name ?? a.name, key: a.key, ...(a.phone ? { phone: true } : {}) })),
        flows: pack.flows.map((f) => ({ id: f.id, name: f.name, key: f.key })),
        approvalPolicies: pack.policies.map((a) => ({ id: a.id, name: a.name, key: a.key })),
        dashboards: pack.dashboards.map((d) => ({ id: d.id, name: d.name, key: d.key })),
        printTemplates: pack.prints.map((d) => ({ id: d.id, name: d.name, key: d.key })),
        sequences: [...pack.sequences.map((q) => ({ id: q.id, name: q.name, key: q.key, ...(q.action === 'reuse' ? { reused: true } : {}) })), ...(uc.row.created.sequences ?? []).filter((q) => !pack.sequences.some((x) => x.id === q.id))],
        referenceRows: Object.keys(referenceRows).length,
      }
    }
    const names: Record<string, string> = { ...(uc.row.details?.names ?? {}) }
    for (const a of created.apps) names[`app:${a.id}`] = a.name
    for (const f of created.flows) names[`flow:${f.id}`] = f.name
    for (const a of created.approvalPolicies ?? []) names[`approvalPolicy:${a.id}`] = a.name
    for (const d of created.dashboards ?? []) names[`dashboard:${d.id}`] = d.name
    for (const d of created.printTemplates ?? []) names[`printTemplate:${d.id}`] = d.name
    await db(s).exec(`UPDATE ${T()} SET template_version = $2, digest = $3, delivered = $4::jsonb, created = $5::jsonb, reference_rows = $6::jsonb, details = coalesce(details, '{}'::jsonb) || $7::jsonb, modified_on = now() WHERE id = $1`,
      [id, uc.newer.pkg.version, uc.newer.digest, JSON.stringify(delivered), JSON.stringify(created), JSON.stringify(referenceRows), JSON.stringify({ ids, ...(uc.pc.pack ? { names } : {}) })])
    await audit(s, ctx, 'template.upgrade', { install: id, template: uc.row.template_id, from: uc.up.from, to: uc.up.to, localChanges: uc.up.localChanges, by: user.user.id, ...(uc.refPlan.length ? { referenceRows: uc.refPlan.map((r) => [r.key, r.action]) } : {}) })
  })
  s.security.invalidate()
  return uc.up
}
