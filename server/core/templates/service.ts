/**
 * Using templates (master-plan 11.3; docs/dev/templates.md): plan (dry run), install, uninstall, upgrade.
 *
 * COPY (all four kinds): the tables the binding creates go through the DATA MODEL's plan path (planModel + applyModel,
 * src/model ops: createTable, putRelationship), so every check, default privilege, audit entry and job is the table
 * designer's; then the app (app templates), its roles (administrators), the validation rules, the SAMPLE rows and the
 * installed-templates record, all in ONE unit of work (s.transaction; applyModel's own transaction becomes a savepoint).
 * UI component and screen templates come back bound; the Studio inserts them into the app being edited.
 *
 * LINKED (app and data model): a versioned solution built in memory from the template (stable ids derived from the
 * template and the install), planned and applied by the SOLUTIONS machinery (planSolution / applySolution), so an upgrade
 * is the solution upgrade-in-place plan; components changed here since delivery are listed and kept or replaced by choice.
 *
 * Rules: nothing that exists is overwritten (created tables never take a taken name: the binding refuses a clash until it
 * is resolved, by mapping or another name; mapped tables are only read and written as data); unmapped required slots
 * block the install; a pre-install backup is taken when backups exist; secrets, users and run-as-system events are
 * stripped or need an administrator's approval (safety.ts); a locked production environment refuses (use Deploy).
 */
import { createHash } from 'node:crypto'
import type { AppDef, ControlNode } from '../../../src/contracts.ts'
import type { AppMeta, RoleDef, TableDef, TablePrivilege } from '../../../src/platform/contracts.ts'
import type { PlanItem, SolutionPlan } from '../../../src/platform/http.ts'
import type { ModelOp, ModelTable, RelationshipDef } from '../../../src/model/types.ts'
import type { TableEventInput } from '../../../src/platform/events.ts'
import {
  KIND_LABEL, canonicalJson, describeContents, describeNeeds, type SlotBinding, type TemplateCreated, type TemplateDetail, type TemplateInstallRecord,
  type TemplateInstallResult, type TemplateMode, type TemplatePackage, type TemplatePlanResponse, type TemplateSummary, type TemplateUseRequest, type UninstallItem,
  type UninstallPlan, type UpgradePlan,
} from '../../../src/templates/format.ts'
import { bindApp, bindNodes, createdTable, defaultBindings, resolveBindings, type Resolution } from '../../../src/templates/bind.ts'
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
import { catalogue, findTemplate, type CatalogueEntry } from './catalogue.ts'

const hid = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 12)
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
  return {
    ...summaryOf(e), slots: e.pkg.slots, defaults: e.integrity === 'damaged' ? {} : defaultBindings(e.pkg, tables), roles: (e.pkg.payload.roles ?? []).map((r) => r.name),
    sampleRows: Object.values(e.pkg.payload.sample ?? {}).reduce((n, r) => n + r.length, 0), digest: e.digest,
  }
}

/* ------------------------------------------------------------------ the register */

interface InstallRow {
  id: string; template_id: string; template_version: string; digest: string; kind: string; mode: string; name: string; status: string
  bindings: Record<string, SlotBinding>; created: TemplateCreated; delivered: Delivered; solution_id: string | null; installed_by: string | null
  installed_on: Date | string; uninstalled_on: Date | string | null; details: { ids?: LinkedIds } | null
}
interface Delivered { apps?: Record<string, string>; tables?: Record<string, string> }
interface LinkedIds { solution: string; app?: string; tables: Record<string, string>; roles: Record<string, string>; events: Record<string, string> }

const iso = (v: Date | string | null): string | undefined => (v === null || v === undefined ? undefined : new Date(v).toISOString())

function toRecord(r: InstallRow): TemplateInstallRecord {
  const newest = r.mode === 'linked' && r.status === 'installed' ? findTemplate(r.template_id) : undefined
  return {
    id: r.id, templateId: r.template_id, templateVersion: r.template_version, kind: r.kind as TemplateInstallRecord['kind'], mode: r.mode as TemplateMode, name: r.name,
    status: r.status === 'uninstalled' ? 'uninstalled' : 'installed', bindings: r.bindings ?? {}, created: r.created, ...(r.solution_id ? { solutionId: r.solution_id } : {}),
    ...(r.installed_by ? { installedBy: r.installed_by } : {}), installedOn: iso(r.installed_on)!, ...(r.uninstalled_on ? { uninstalledOn: iso(r.uninstalled_on) } : {}),
    ...(newest && newest.integrity !== 'damaged' && compareVersions(newest.pkg.version, r.template_version) > 0 ? { upgradeTo: newest.pkg.version } : {}),
    canUninstall: r.status === 'installed' && (r.kind === 'app' || r.kind === 'dataModel'),
  }
}

export async function listInstalls(s: Services): Promise<TemplateInstallRecord[]> {
  const rows = await db(s).query<InstallRow>(`SELECT * FROM ${T()} ORDER BY installed_on DESC, id`)
  return rows.map(toRecord)
}

async function installRow(s: Services, id: string): Promise<InstallRow> {
  const r = (await db(s).query<InstallRow>(`SELECT * FROM ${T()} WHERE id = $1`, [id]))[0]
  if (!r) throw new HttpError(404, 'not-found', 'There is no such installed template here.')
  return r
}

/* ------------------------------------------------------------------ plan */

interface CreatedSlot { slot: string; draftId: string; def: Omit<TableDef, 'id'>; events: TableEventInput[]; lookups: { column: string; toSlot: string; onDelete?: RelationshipDef['onDelete'] }[] }

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
  /** key: the role's name in the template (Linked ids are keyed by it); name: the name it gets here */
  roles: { key: string; name: string; description?: string; isMaker?: boolean; privileges: Record<string, Omit<TablePrivilege, 'table'>> }[]
  sample: boolean
  modelOps: ModelOp[]
  modelToken: string
  linked?: { pkg: SolutionPkg; res: PlanResult; ids: LinkedIds }
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
  const n = (await db(s).query<{ n: number }>(`SELECT count(*)::int AS n FROM ${T()} WHERE template_id = $1 AND mode = 'linked'`, [pkg.id]))[0]?.n ?? 0
  const base = `${pkg.id}#${n + 1}`
  const tables: Record<string, string> = {}
  for (const sl of pkg.slots) tables[sl.id] = `tbl_tpl_${hid(`${base}:table:${sl.id}`)}`
  const roles: Record<string, string> = {}
  for (const r of pkg.payload.roles ?? []) roles[r.name] = `role_tpl_${hid(`${base}:role:${r.name}`)}`
  const events: Record<string, string> = {}
  for (const sl of pkg.slots) (sl.events ?? []).forEach((e, i) => { events[`${sl.id}:${i}`] = `evt_tpl_${hid(`${base}:event:${sl.id}:${i}:${e.name ?? ''}`)}` })
  return { solution: `tpl_${hid(`${base}:solution`)}`, ...(pkg.kind === 'app' ? { app: `app_tpl_${hid(`${base}:app`)}` } : {}), tables, roles, events }
}

/** the solution document of a Linked install (or upgrade): what applySolution installs */
function linkedDocument(pc: Omit<PlanContext, 'linked' | 'response' | 'serverChanges' | 'modelOps' | 'modelToken'>, ids: LinkedIds, tables: TableDef[], keep: { apps?: Record<string, AppDef>; tables?: Record<string, TableDef> } = {}): Record<string, unknown> {
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
  const apps = pc.app && ids.app ? [{ id: ids.app, name: pc.app.name, definition: keep.apps?.[ids.app] ?? pc.app.def }] : []
  const roles = pc.roles.map((r) => ({
    id: ids.roles[r.key], name: r.name, ...(r.description ? { description: r.description } : {}), ...(r.isMaker ? { isMaker: true } : {}),
    privileges: Object.entries(r.privileges).map(([slot, p]) => ({ table: tableIdOf(slot) ?? '', ...p })).filter((p) => p.table && pc.created.some((c) => ids.tables[c.slot] === p.table)),
    apps: ids.app ? [ids.app] : [],
  }))
  void tables
  return {
    kind: 'appbuilder/solution', packageVersion: 1,
    solution: { id: ids.solution, name: `Template_${pc.pkg.id.replace(/[^A-Za-z0-9]+/g, '_')}`.slice(0, 60), displayName: `${pc.pkg.name} (template)`, publisher: pc.pkg.publisher ?? 'Template', version: pc.pkg.version, description: `Installed from the template ${pc.pkg.name} (${pc.pkg.id}), linked: updates arrive as an upgrade plan.` },
    apps, tables: tableEntries, roles, connections: [], files: [],
  }
}

export async function planTemplate(s: Services, ctx: Ctx, id: string, req: TemplateUseRequest): Promise<PlanContext> {
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
  const mode: TemplateMode = req.mode === 'linked' ? 'linked' : 'copy'
  if (mode === 'linked' && !pkg.modes.includes('linked')) problems.push(`${KIND_LABEL[pkg.kind]} templates are used as copies: Linked is not available for this template.`)
  const target = await envInfo(s)
  if (target.locked) problems.push(`${LOCKED_MESSAGE} Install the template in a sandbox and deploy it here.`)
  const tables = await s.meta.tables.list()
  const resolution = resolveBindings(pkg, req.bindings, tables)
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
  // problems of binding a formula only count when the binding itself is complete (otherwise they repeat the slot problems)
  if (!resolution.problems.length) problems.push(...bindProblems.map((p) => `Binding: ${p}`))
  const dataSources = resolution.resolved.filter((r) => r.mode !== 'skip' && r.tableName).map((r) => r.tableName!)

  // tables the binding creates
  // a fixed time in the planned definitions: the plan's token must not change between the plan and the install (the
  // table routes and applySolution stamp the real times)
  const now = '2000-01-01T00:00:00.000Z'
  const created: CreatedSlot[] = []
  for (const r of resolution.resolved) {
    if (r.mode !== 'create') continue
    const c = createdTable(r, resolution, now)
    if (!resolution.problems.length) problems.push(...c.problems)
    created.push({ slot: r.slot.id, draftId: `new_tpl_${r.slot.id.toLowerCase()}`, def: c.def, events: c.events, lookups: c.lookups })
  }
  // rule 8: events that run as the system, on tables this install creates
  const systemItems = pkg.slots.filter((sl) => created.some((c) => c.slot === sl.id)).flatMap((sl) => (sl.events ?? []).filter((e) => e.runAs === 'system').map((e) => `${sl.label}: ${e.name ?? 'event'}`))
  if (systemItems.length && !user.privileges.isAdmin) problems.push(`The template has table events that run as the system (${systemItems.join(', ')}): only an administrator of this environment can install it.`)
  else if (systemItems.length) warnings.push(`The table events ${systemItems.join(', ')} run as the system (they ignore row and column security): approve them explicitly below.`)

  // roles (administrators only; never the administrator flag)
  const roles: PlanContext['roles'] = []
  if ((pkg.payload.roles ?? []).length && !user.privileges.isAdmin) warnings.push('The roles of the template are skipped: only administrators can create roles. An administrator can give people access to the new app later.')
  if (user.privileges.isAdmin) {
    const existing = (await s.meta.roles.list()).map((r) => r.name)
    for (const r of pkg.payload.roles ?? []) {
      const name = uniqueLabel(r.name.slice(0, 100), [...existing, ...roles.map((x) => x.name)])
      const privileges: PlanContext['roles'][number]['privileges'] = {}
      for (const [slot, p] of Object.entries(r.tables ?? {})) privileges[slot] = { create: p.create === true, read: p.read ?? 'none', update: p.update ?? 'none', delete: p.delete ?? 'none' }
      roles.push({ key: r.name, name, ...(r.description ? { description: r.description } : {}), ...(r.isMaker ? { isMaker: true } : {}), privileges })
      if (name !== r.name) warnings.push(`A role named "${r.name}" exists here: the template's role is created as "${name}".`)
    }
  }

  // sample rows: only into tables this install creates, and only when it creates all of them
  const sampleRows = Object.values(pkg.payload.sample ?? {}).reduce((n, r) => n + r.length, 0)
  let sample = req.sample === true && sampleRows > 0
  if (sample && created.length !== pkg.slots.length) {
    sample = false
    warnings.push('SAMPLE rows are only added when the template creates every one of its tables (they are never written into your own tables).')
  }

  const base = { entry, pkg, safety, mode, resolution, created, app, nodes, screen, dataSources, roles, sample }
  let modelOps: ModelOp[] = []
  let modelToken = ''
  let linked: PlanContext['linked']
  let planMode: SolutionPlan['mode'] = 'install'

  if (mode === 'copy') {
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
  } else {
    const ids = await linkedIds(s, pkg)
    if ((await db(s).query(`SELECT 1 FROM ${T()} WHERE template_id = $1 AND mode = 'linked' AND status = 'installed'`, [pkg.id])).length) problems.push('This template is already installed here as Linked: upgrade it from the installed list, or install it as a copy.')
    if (!problems.length) {
      const doc = linkedDocument(base, ids, tables)
      const solPkg = readSolutionPkg(toYaml(doc), s)!
      const res = await planSolution(s, user, solPkg)
      problems.push(...res.plan.problems)
      warnings.push(...res.plan.warnings)
      items.push(...res.plan.items)
      planMode = res.plan.mode
      linked = { pkg: solPkg, res, ids }
      if (res.plan.mode === 'upgrade') problems.push('Something with the ids of this template already exists here; install it as a copy instead.')
    }
  }
  // mapped tables are used as they are
  for (const r of resolution.resolved) if (r.mode === 'map' && r.tableId) items.push({ kind: 'table', id: r.tableId, name: r.displayName ?? r.tableName ?? '', change: 'unchanged', note: 'your table, used as it is: its columns and rows do not change' })
  // UI components and screens go into the app being edited
  if (pkg.kind === 'component' || pkg.kind === 'screen') {
    const count = (ns: ControlNode[]): number => ns.reduce((n, c) => n + 1 + count(c.children ?? []), 0)
    const what = pkg.kind === 'component' ? `adds ${count(nodes ?? [])} UI components to the screen ${req.target?.screenName ?? '(the current screen)'}` : `adds the screen "${screen?.name ?? ''}" (${count(screen?.children ?? [])} UI components)`
    items.push({ kind: 'app', id: req.target?.appId ?? '', name: req.target?.appName ?? 'The app you are editing', change: 'changed', note: `${what}; names already used in the app get a number; nothing in the app is replaced or removed (Undo takes it out again)` })
  }
  const serverChanges = created.length > 0 || !!app || roles.length > 0
  if (created.length) warnings.push('Your existing roles get the usual access to the new tables (makers full, viewers read, others none); nothing they already have changes.')
  const backupOn = !!s.backup?.available()
  const backup = !serverChanges
    ? { available: backupOn, message: 'Nothing on the server changes: the UI components go into the app you are editing.' }
    : backupOn ? { available: true, message: 'A backup of this environment is taken before the install.' } : { available: false, message: NO_BACKUP_MESSAGE }

  const token = createHash('sha256').update(canonicalJson({
    env: target.id, digest: entry.digest, mode, bindings: resolution.resolved.map((r) => [r.slot.id, r.mode, r.tableId ?? r.tableName, [...r.columns.entries()]]),
    app: app?.name ?? null, sample, target: req.target ?? null, model: modelToken, linked: linked?.res.plan.token ?? null, roles: roles.map((r) => r.name), problems,
  })).digest('hex').slice(0, 32)
  const plan: SolutionPlan = {
    mode: planMode,
    solution: { id: pkg.id, name: pkg.id, displayName: `${pkg.name} (${KIND_LABEL[pkg.kind]} template${mode === 'linked' ? ', linked' : ', copy'})`, version: pkg.version },
    target, items, destructive: false, problems: [...new Set(problems)], warnings: [...new Set(warnings)], backup, token,
    ...(systemItems.length ? { systemEvents: systemItems } : {}),
  }
  const bindings: Record<string, SlotBinding> = {}
  for (const r of resolution.resolved) {
    bindings[r.slot.id] = r.mode === 'skip' ? { mode: 'skip' } : r.mode === 'create' ? { mode: 'create', name: r.tableName ?? '', ...(r.displayName ? { displayName: r.displayName } : {}) } : { mode: 'map', table: r.tableId ?? '', columns: Object.fromEntries(r.columns) }
  }
  const response: TemplatePlanResponse = { plan, slots: resolution.slots, bindings, mode, ...(appNameInfo ? { appName: appNameInfo } : {}), stripped: safety.stripped, systemItems }
  return { ...base, modelOps, modelToken, ...(linked ? { linked } : {}), serverChanges, response }
}

/* ------------------------------------------------------------------ install */

async function takeBackup(s: Services, ctx: Ctx, reason: string, proceed: boolean): Promise<{ taken: boolean; message: string } | undefined> {
  if (!s.backup?.available()) return { taken: false, message: NO_BACKUP_MESSAGE }
  const b = await s.backup.snapshot(s.environment(), reason, { trigger: 'pre-upgrade', by: me(ctx).user.id })
  if (b.failed && !proceed) throw new HttpError(409, 'conflict', `${b.message} Nothing was changed. Install without a backup, or cancel.`, 'backup')
  return { taken: !!b.taken, message: b.message }
}

/** SAMPLE rows: fresh row ids (row ids are unique across tables), lookups follow; returns how many rows went in */
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

async function insertRecord(s: Services, rec: { id: string; pc: PlanContext; name: string; created: TemplateCreated; delivered: Delivered; solutionId?: string; userId: string; details?: unknown }): Promise<void> {
  await db(s).exec(
    `INSERT INTO ${T()} (id, template_id, template_version, digest, kind, mode, name, status, bindings, created, delivered, solution_id, installed_by, installed_on, modified_on, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'installed', $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, now(), now(), $13::jsonb)`,
    [rec.id, rec.pc.pkg.id, rec.pc.pkg.version, rec.pc.entry.digest, rec.pc.pkg.kind, rec.pc.mode, rec.name, JSON.stringify(rec.pc.response.bindings), JSON.stringify(rec.created), JSON.stringify(rec.delivered), rec.solutionId ?? null, rec.userId, rec.details === undefined ? null : JSON.stringify(rec.details)],
  )
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
  const created: TemplateCreated = { apps: [], tables: [], roles: [], flows: [], events: [], mapped: [], sampleRows: 0, ...(req.target && (pc.pkg.kind === 'component' || pc.pkg.kind === 'screen') ? { target: { ...(req.target.appId ? { appId: req.target.appId } : {}), ...(req.target.appName ? { appName: req.target.appName } : {}), ...(req.target.screenName ? { screenName: req.target.screenName } : {}) } } : {}) }
  for (const r of pc.resolution.resolved) if (r.mode === 'map' && r.tableId) created.mapped.push({ slot: r.slot.id, table: r.tableId, name: r.tableName ?? '' })
  const delivered: Delivered = { apps: {}, tables: {} }
  const label = pc.app?.name ?? pc.pkg.name
  let appId: string | undefined

  await s.transaction(async () => {
    const tableOf = new Map<string, TableDef>()
    if (pc.mode === 'copy') {
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
    } else {
      // Linked: the solutions machinery (install of a solution with stable ids)
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
        if (role) created.roles.push({ id: role.id, name: role.name })
      }
    }
    // 5. SAMPLE rows (only into tables this install created)
    if (pc.sample) created.sampleRows = await loadSample(inUnit(s), pc.pkg, (slot) => tableOf.get(slot), user.user.id)
    // 6. the register and the audit log
    await insertRecord(s, { id: installId, pc, name: label, created, delivered, ...(pc.linked ? { solutionId: pc.linked.ids.solution } : {}), userId: user.user.id, ...(pc.linked ? { details: { ids: pc.linked.ids } } : {}) })
    await audit(s, ctx, 'template.install', {
      install: installId, template: pc.pkg.id, version: pc.pkg.version, kind: pc.pkg.kind, mode: pc.mode, digest: pc.entry.digest,
      bindings: pc.response.bindings, created: { apps: created.apps.map((a) => a.id), tables: created.tables.map((t) => t.id), roles: created.roles.map((r) => r.id), events: created.events.length, sampleRows: created.sampleRows },
      ...(pc.response.stripped.length ? { stripped: pc.response.stripped } : {}), ...(pc.response.systemItems.length ? { approvedSystem: pc.response.systemItems } : {}),
      ...(backup ? { backup: backup.taken ? 'taken' : 'none' } : {}),
    })
  })
  s.security.invalidate()
  const rec = toRecord(await installRow(s, installId))
  return {
    install: rec, ...(pc.nodes ? { controls: pc.nodes } : {}), ...(pc.screen ? { screen: pc.screen } : {}), dataSources: pc.dataSources, ...(appId ? { appId } : {}),
    ...(backup ? { backup } : {}), warnings: plan.warnings,
  }
}

/* ------------------------------------------------------------------ uninstall */

interface UninstallContext { row: InstallRow; plan: UninstallPlan; dropOps: ModelOp[]; dropToken: string; apps: string[]; roles: string[]; flows: string[] }

async function uninstallContext(s: Services, ctx: Ctx, id: string, deleteTables: boolean): Promise<UninstallContext> {
  const user = me(ctx)
  const row = await installRow(s, id)
  const rec = toRecord(row)
  const items: UninstallItem[] = []
  const problems: string[] = []
  const warnings: string[] = []
  if (row.status !== 'installed') problems.push('This template was uninstalled already.')
  if (row.kind !== 'app' && row.kind !== 'dataModel') problems.push('UI component and screen templates became part of your app: remove them in the Studio (or with Undo).')
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
  if (roles.length && !user.privileges.isAdmin) problems.push('The template created roles: only an administrator can uninstall it.')
  const flows: string[] = []
  const fl = (s as unknown as { flows?: { store: { get(id: string): Promise<{ name?: string } | null> } } }).flows
  for (const f of c.flows ?? []) {
    if (!(await fl?.store.get(f.id))) continue
    flows.push(f.id)
    items.push({ kind: 'flow', id: f.id, name: f.name, action: 'removed', note: 'the flow is deleted (its run history stays)' })
  }
  const all = await s.meta.tables.list()
  const createdIds = new Set((c.tables ?? []).map((t) => t.id))
  const appsAll = await s.meta.apps.list()
  const tablesWithData: UninstallPlan['tablesWithData'] = []
  const drop: TableDef[] = []
  for (const t of c.tables ?? []) {
    const def = all.find((x) => x.id === t.id)
    if (!def) continue
    let rows = 0
    try {
      const conn = await s.connections.get(def.connectionId ?? 'conn_default')
      const r = await conn.select(def, { select: ['id'], count: true, top: 1 })
      rows = r.total ?? r.rows.length
    } catch { rows = 0 }
    const referrers = all.filter((x) => !createdIds.has(x.id) && (x.columns.some((col) => col.type === 'lookup' && col.lookupTable?.toLowerCase() === def.name.toLowerCase()) || (x.reporting?.kind === 'view' && x.reporting.base === def.id) || (x.reporting?.kind === 'summary' && x.reporting.source === def.id)))
    const users = []
    for (const a of appsAll) {
      if (apps.includes(a.id)) continue
      const full = await s.meta.apps.get(a.id)
      if ((full?.definition.dataSources ?? []).some((n) => n.toLowerCase() === def.name.toLowerCase())) users.push(a.name)
    }
    if (referrers.length || users.length) {
      items.push({ kind: 'table', id: def.id, name: def.displayName, action: 'kept', rows, note: `kept: ${[referrers.length ? `the tables ${referrers.map((x) => x.displayName).join(', ')} point at it` : '', users.length ? `the apps ${users.join(', ')} use it` : ''].filter(Boolean).join('; ')}` })
      continue
    }
    if (rows > 0) tablesWithData.push({ id: def.id, name: def.displayName, rows })
    if (rows > 0 && !deleteTables) {
      items.push({ kind: 'table', id: def.id, name: def.displayName, action: 'kept', rows, note: `kept with its ${rows} row${rows === 1 ? '' : 's'} (an administrator can tick "Delete tables with data")` })
      continue
    }
    items.push({ kind: 'table', id: def.id, name: def.displayName, action: 'removed', rows, ...(rows > 0 ? { destructive: true } : {}), note: rows > 0 ? `the table and its ${rows} row${rows === 1 ? '' : 's'} are deleted` : 'empty: the table is deleted' })
    drop.push(def)
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
    row, apps, roles, flows, dropOps, dropToken,
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
    for (const a of uc.apps) { await s.meta.apps.remove(a); await forgetApp(inUnit(s), a) }
    if (uc.flows.length) await applyFlows(inUnit(s), user, { upsert: [], remove: uc.flows, mapping: new Map() }, uc.row.solution_id ?? '', new Map())
    for (const r of uc.roles) await s.meta.roles.remove(r)
    if (uc.dropOps.length) await applyModel(withoutBackup(s), ctx, uc.dropOps, uc.dropToken)
    if (uc.row.solution_id && (await s.meta.solutions.list()).some((x) => x.id === uc.row.solution_id)) await s.meta.solutions.remove(uc.row.solution_id)
    await db(s).exec(`UPDATE ${T()} SET status = 'uninstalled', uninstalled_by = $2, uninstalled_on = now(), modified_on = now(), details = coalesce(details, '{}'::jsonb) || $3::jsonb WHERE id = $1`, [id, user.user.id, JSON.stringify({ uninstall: uc.plan.items.map((i) => ({ kind: i.kind, id: i.id, action: i.action })) })])
    await audit(s, ctx, 'template.uninstall', { install: id, template: uc.row.template_id, items: uc.plan.items.map((i) => ({ kind: i.kind, id: i.id, action: i.action, ...(i.rows ? { rows: i.rows } : {}) })), deleteTables: b.deleteTables === true, backup: backup?.taken ? 'taken' : 'none' })
  })
  if (uc.flows.length) await afterApplyFlows(s, uc.flows, user.user.id).catch(() => {})
  s.security.invalidate()
  return { ...uc.plan, install: toRecord(await installRow(s, id)) }
}

/* ------------------------------------------------------------------ upgrade (Linked) */

interface UpgradeContext { row: InstallRow; pc: PlanContext; up: UpgradePlan; solPkg: SolutionPkg; res: PlanResult; newer: CatalogueEntry }

async function upgradeContext(s: Services, ctx: Ctx, id: string, choices: Record<string, 'keep' | 'replace'>): Promise<UpgradeContext> {
  const user = me(ctx)
  const row = await installRow(s, id)
  if (row.mode !== 'linked' || row.status !== 'installed') throw invalid('Only an installed Linked template can be upgraded.')
  const newer = findTemplate(row.template_id)
  if (!newer || newer.integrity === 'damaged') throw invalid('The catalogue has no usable version of this template.')
  const ids = row.details?.ids
  if (!ids) throw invalid('This install has no record of its components; it cannot be upgraded.')
  // the bindings of the install, against the new version (new slots get their defaults)
  const pc = await planTemplate(s, ctx, row.template_id, { mode: 'copy', bindings: row.bindings, ...(row.kind === 'app' ? { appName: row.created.apps[0]?.name } : {}) })
  // the plan above saw the install's own tables and app as clashes; the upgrade replaces exactly those
  const ownTables = new Set(Object.values(ids.tables))
  const keepTables: Record<string, TableDef> = {}
  const keepApps: Record<string, AppDef> = {}
  const localChanges: UpgradePlan['localChanges'] = []
  for (const [tid, hash] of Object.entries(row.delivered?.tables ?? {})) {
    const cur = await s.meta.tables.get(tid)
    if (!cur || tableHash(cur) === hash) continue
    const choice = choices[`table:${tid}`] === 'replace' ? 'replace' : 'keep'
    localChanges.push({ key: `table:${tid}`, kind: 'table', name: cur.displayName, choice })
    if (choice === 'keep') keepTables[tid] = cur
  }
  for (const [aid, hash] of Object.entries(row.delivered?.apps ?? {})) {
    const cur = await s.meta.apps.get(aid)
    if (!cur || appHash(cur.definition) === hash) continue
    const choice = choices[`app:${aid}`] === 'replace' ? 'replace' : 'keep'
    localChanges.push({ key: `app:${aid}`, kind: 'app', name: cur.meta.name, choice })
    if (choice === 'keep') keepApps[aid] = cur.definition
  }
  // the new version's document with the install's ids (slots it created keep their names)
  const created = pc.created.map((c) => {
    const tid = ids.tables[c.slot]
    const existing = tid ? (row.created.tables.find((t) => t.id === tid)) : undefined
    return existing ? { ...c, def: { ...c.def, name: existing.name } } : c
  })
  const resolution: Resolution = {
    ...pc.resolution,
    problems: pc.resolution.problems.filter((p) => !/already exists here/.test(p)),
    resolved: pc.resolution.resolved.map((r) => {
      const tid = ids.tables[r.slot.id]
      const mine = tid && ownTables.has(tid) ? row.created.tables.find((t) => t.id === tid) : undefined
      return mine && r.mode === 'create' ? { ...r, tableName: mine.name } : r
    }),
  }
  const appName = row.created.apps[0]?.name ?? pc.app?.name ?? row.name
  const base = { ...pc, created, resolution, ...(pc.app ? { app: { def: { ...pc.app.def, name: appName }, name: appName } } : {}) }
  const doc = linkedDocument(base, ids, await s.meta.tables.list(), { tables: keepTables, apps: keepApps })
  const solPkg = readSolutionPkg(toYaml(doc), s)!
  const res = await planSolution(s, user, solPkg)
  const problems = [...res.plan.problems]
  if (compareVersions(newer.pkg.version, row.template_version) <= 0) problems.unshift(`The installed version ${row.template_version} is the newest in the catalogue.`)
  const target = await envInfo(s)
  if (target.locked) problems.push(`${LOCKED_MESSAGE}`)
  const plan: SolutionPlan = { ...res.plan, solution: { ...res.plan.solution, displayName: `${newer.pkg.name} (template, linked)`, version: newer.pkg.version, fromVersion: row.template_version }, problems: [...new Set(problems)] }
  return { row, pc, newer, solPkg, res, up: { plan, from: row.template_version, to: newer.pkg.version, localChanges } }
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
    const delivered: Delivered = { apps: {}, tables: {} }
    const ids = uc.row.details!.ids!
    for (const tid of Object.values(ids.tables)) {
      const def = await s.meta.tables.get(tid)
      // a component kept local stays "changed" against what the template delivers now
      const keptLocal = uc.up.localChanges.some((l) => l.key === `table:${tid}` && l.choice === 'keep')
      if (def) delivered.tables![tid] = keptLocal ? (uc.row.delivered?.tables?.[tid] ?? '') : tableHash(def)
    }
    if (ids.app) {
      const a = await s.meta.apps.get(ids.app)
      const keptLocal = uc.up.localChanges.some((l) => l.key === `app:${ids.app}` && l.choice === 'keep')
      if (a) delivered.apps![ids.app] = keptLocal ? (uc.row.delivered?.apps?.[ids.app] ?? '') : appHash(a.definition)
    }
    await db(s).exec(`UPDATE ${T()} SET template_version = $2, digest = $3, delivered = $4::jsonb, modified_on = now() WHERE id = $1`, [id, uc.newer.pkg.version, uc.newer.digest, JSON.stringify(delivered)])
    await audit(s, ctx, 'template.upgrade', { install: id, template: uc.row.template_id, from: uc.up.from, to: uc.up.to, localChanges: uc.up.localChanges, by: user.user.id })
  })
  s.security.invalidate()
  return uc.up
}
