/**
 * Solutions: CRUD, components (app, table, role, connection, file), YAML packages.
 * File components embed the file (base64); import creates new instances and offers filesAs 'database' | 'file'.
 */
import { PACKAGE_CONNECTORS, exportConnectionActions, importConnectionActions } from '../../core/actions/solution-parts.ts'
import type { ConnectorKind, RoleDef, SolutionComponentKind, SolutionDef, TableDef, TablePrivilege } from '../../../src/platform/contracts.ts'
import type { ConnectionRecord, Ctx, Router, Services } from '../../core/contracts.ts'
import { exportFlows } from '../../core/flows/alm.ts'
import { exportApprovalPolicies } from '../../core/approvals/alm.ts'
import { readDataFile } from '../../connectors/files/index.ts'
import {
  IDENT, bodyObj, clone, conflict, invalid, isObj, me, notFound, optString, reqString, toIdentifier, toYaml, uniqueIdentifier, uniqueLabel,
} from './util.ts'
import type { RoleX } from './util.ts'
import {
  PACKAGE_VERSION, addApp, appEntry, ensurePkgTables, importPkgEventsAsCopies, parsePackage, readPkgApp, readPkgTables, rollbackTables, tableEntry,
} from './packages.ts'
import { audit, plainTableDef, resolveConnection } from './tables-core.ts'
import { canReadWholeTable, deleteDataFile, registerDataFile } from './files.ts'
import { moveTable } from './tables.ts'
import { forgetApp } from './apps.ts'
import { importStable, planSolution, readSolutionPkg } from './alm.ts'
import type { SolutionImportResult, SolutionPlan } from '../../../src/platform/http.ts'
import { HttpError } from '../../core/contracts.ts'
import type { CoreServices } from '../../core/services.ts'
import { userContextFor } from '../../core/auth.ts'
import { runInEnvironment } from '../../core/env-context.ts'

const KINDS: SolutionComponentKind[] = ['app', 'table', 'role', 'connection', 'file', 'flow', 'approvalPolicy']
const MAX_FILE_BYTES = 25 * 1024 * 1024

/** P1-A: the flow options of an import (connection mapping, which new flows arrive turned on) */
function flowOpts(b: Record<string, unknown>): { connectionMap?: Record<string, string>; enableFlows?: boolean | string[] } {
  const out: { connectionMap?: Record<string, string>; enableFlows?: boolean | string[] } = {}
  if (b.connectionMap !== undefined) {
    if (!b.connectionMap || typeof b.connectionMap !== 'object' || Array.isArray(b.connectionMap) || Object.values(b.connectionMap).some((v) => typeof v !== 'string')) throw invalid('connectionMap must map source connection ids to connection ids here.', 'connectionMap')
    out.connectionMap = b.connectionMap as Record<string, string>
  }
  if (b.enableFlows === true) out.enableFlows = true
  else if (Array.isArray(b.enableFlows)) out.enableFlows = b.enableFlows.map(String)
  // P1-C: people of approval policies, email in the package -> email here
  if (b.peopleMap !== undefined) {
    if (!b.peopleMap || typeof b.peopleMap !== 'object' || Array.isArray(b.peopleMap) || Object.values(b.peopleMap).some((v) => typeof v !== 'string')) throw invalid('peopleMap must map emails in the package to emails here.', 'peopleMap')
    ;(out as { peopleMap?: Record<string, string> }).peopleMap = b.peopleMap as Record<string, string>
  }
  return out
}

async function needSolution(s: Services, id: string): Promise<SolutionDef> {
  const sol = (await s.meta.solutions.list()).find((x) => x.id === id)
  if (!sol) throw notFound('Solution not found.')
  return sol
}

async function componentExists(s: Services, kind: SolutionComponentKind, id: string): Promise<boolean> {
  switch (kind) {
    case 'app': return !!(await s.meta.apps.get(id))
    case 'table': return (await s.meta.tables.get(id))?.id === id
    case 'role': return !!(await s.meta.roles.get(id))
    case 'connection': return !!(await s.meta.connections.get(id))
    case 'file': return !!(await s.meta.files.get(id))
    case 'flow': return !!(await (s as unknown as { flows?: { store: { get(id: string): Promise<unknown> } } }).flows?.store.get(id))
    case 'approvalPolicy': return !!(await (s as unknown as { approvals?: { policy(id: string): Promise<{ id: string } | null> } }).approvals?.policy(id))?.id
  }
}

function fieldsOf(b: Record<string, unknown>): Partial<SolutionDef> {
  const out: Partial<SolutionDef> = {}
  if (b.displayName !== undefined) out.displayName = reqString(b, 'displayName', 'A solution needs a display name.', 200)
  if (b.publisher !== undefined) out.publisher = (optString(b, 'publisher', { max: 200 }) ?? '').trim()
  if (b.version !== undefined) {
    const v = (optString(b, 'version', { max: 32 }) ?? '').trim()
    if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(v)) throw invalid('The version must look like 1.0.0.', 'version')
    out.version = v
  }
  if (b.description !== undefined) {
    const d = (optString(b, 'description', { max: 1000 }) ?? '').trim()
    if (d) out.description = d
  }
  return out
}

export function registerSolutionRoutes(router: Router, s: Services): void {
  router.add('POST', '/api/v1/solutions', async (ctx) => {
    const b = bodyObj(ctx)
    const f = fieldsOf(b)
    if (!f.displayName) throw invalid('A solution needs a display name.', 'displayName')
    const sols = await s.meta.solutions.list()
    let name = optString(b, 'name')
    if (name) {
      if (!IDENT.test(name)) throw invalid(`Solution name "${name}" is not a valid identifier.`, 'name')
      if (sols.some((x) => x.name.toLowerCase() === name!.toLowerCase())) throw conflict(`A solution named "${name}" already exists.`)
    } else name = uniqueIdentifier(toIdentifier(f.displayName, 'Solution'), sols.map((x) => x.name))
    const now = s.now()
    const sol: SolutionDef = {
      id: s.uid('sol'), name, displayName: f.displayName, publisher: f.publisher || me(ctx).user.name, version: f.version ?? '1.0.0',
      ...(f.description ? { description: f.description } : {}), components: [], createdOn: now, modifiedOn: now,
    }
    await s.meta.solutions.upsert(sol)
    await audit(s, ctx, 'solution.create', { id: sol.id, name })
    return sol
  }, { auth: 'maker' })

  router.add('PATCH', '/api/v1/solutions/:id', async (ctx) => {
    const sol = await needSolution(s, ctx.params.id)
    const b = bodyObj(ctx)
    const next: SolutionDef = { ...sol, ...fieldsOf(b), id: sol.id, components: sol.components }
    if (b.description !== undefined && !(optString(b, 'description') ?? '').trim()) delete next.description
    if (b.name !== undefined) {
      const name = reqString(b, 'name', 'The solution name')
      if (!IDENT.test(name)) throw invalid(`Solution name "${name}" is not a valid identifier.`, 'name')
      if ((await s.meta.solutions.list()).some((x) => x.id !== sol.id && x.name.toLowerCase() === name.toLowerCase())) throw conflict(`A solution named "${name}" already exists.`)
      next.name = name
    }
    next.modifiedOn = s.now()
    await s.meta.solutions.upsert(next)
    return next
  }, { auth: 'maker' })

  router.add('DELETE', '/api/v1/solutions/:id', async (ctx) => {
    const sol = await needSolution(s, ctx.params.id)
    await s.meta.solutions.remove(sol.id)
    await audit(s, ctx, 'solution.delete', { id: sol.id, name: sol.name })
    return { ok: true }
  }, { auth: 'maker' })

  router.add('POST', '/api/v1/solutions/:id/components', async (ctx) => {
    const sol = await needSolution(s, ctx.params.id)
    const b = bodyObj(ctx)
    const kind = b.kind as SolutionComponentKind
    if (!KINDS.includes(kind)) throw invalid(`Unknown component kind "${String(b.kind)}".`, 'kind')
    const id = reqString(b, 'id', 'The component id')
    if (!(await componentExists(s, kind, id))) throw notFound(`The ${kind} "${id}" was not found.`)
    if (sol.components.some((c) => c.kind === kind && c.id === id)) return sol
    const next = { ...sol, components: [...sol.components, { kind, id }], modifiedOn: s.now() }
    await s.meta.solutions.upsert(next)
    return next
  }, { auth: 'maker' })

  router.add('DELETE', '/api/v1/solutions/:id/components/:kind/:cid', async (ctx) => {
    const sol = await needSolution(s, ctx.params.id)
    const components = sol.components.filter((c) => !(c.kind === ctx.params.kind && c.id === ctx.params.cid))
    if (components.length === sol.components.length) return sol
    const next = { ...sol, components, modifiedOn: s.now() }
    await s.meta.solutions.upsert(next)
    return next
  }, { auth: 'maker' })

  router.add('GET', '/api/v1/solutions/:id/package', async (ctx) => ({ yaml: await exportSolutionPackage(s, ctx, ctx.params.id, ctx.query.get('data') === '1') }), { auth: 'maker' })

  /** what importing this package here would do (nothing is changed) */
  router.add('POST', '/api/v1/solutions/import/plan', async (ctx): Promise<SolutionPlan> => {
    const b = bodyObj(ctx)
    const pkg = readSolutionPkg(b.yaml, s)
    if (!pkg || b.asCopy === true) return copyPlan(s, b.yaml)
    return (await planSolution(s, me(ctx), pkg, flowOpts(b))).plan
  }, { auth: 'maker', maxBodyMB: 40 })

  router.add('POST', '/api/v1/solutions/import', async (ctx): Promise<SolutionImportResult> => {
    const b = bodyObj(ctx)
    const filesAs = b.filesAs ?? 'database'
    if (filesAs !== 'database' && filesAs !== 'file') throw invalid('filesAs must be "database" or "file".', 'filesAs')
    const pkg = readSolutionPkg(b.yaml, s)
    // an old package (no solution id) or "import as a copy": new instances of everything, as before
    if (!pkg || b.asCopy === true) return s.transaction(() => importSolutionPackage(s, ctx, b.yaml, filesAs))
    return importStable(s, ctx, pkg, { confirm: b.confirm, filesAs, proceedWithoutBackup: b.proceedWithoutBackup === true, ...flowOpts(b) })
  }, { auth: 'maker', maxBodyMB: 40 })

  /**
   * Deploy to another environment: export from this one and import into `target` in one step (plan: true answers the
   * plan for the target only). The caller needs access to the target; an upgrade needs its administrator.
   */
  router.add('POST', '/api/v1/solutions/:id/deploy', async (ctx): Promise<SolutionPlan | SolutionImportResult> => {
    const b = bodyObj(ctx)
    const target = typeof b.target === 'string' ? b.target.trim() : ''
    if (!target) throw invalid('Choose the environment to deploy to.', 'target')
    if (target === ctx.environmentId) throw invalid('The solution is already in this environment: choose another one.', 'target')
    if (!s.environments) throw new HttpError(503, 'unavailable', 'Environments are not available here.')
    const sol = await needSolution(s, ctx.params.id)
    const yaml = await exportSolutionPackage(s, ctx, sol.id, b.includeData === true)
    const pkg = readSolutionPkg(yaml, s)!
    const core = s as CoreServices
    const rec = await s.meta.users.get(me(ctx).user.id)
    if (!rec) throw new HttpError(401, 'unauthenticated', 'Please sign in.')
    // the caller's context in the target: access checked like a request that names it
    const there = await userContextFor(core, rec, target)
    if (!there.privileges.isMaker) throw new HttpError(403, 'denied', 'You are not a maker in the target environment.')
    const tctx: Ctx = { ...ctx, user: there, environmentId: target }
    const out = await runInEnvironment(target, async () => {
      if (b.plan === true) return (await planSolution(s, there, pkg, flowOpts(b))).plan
      return importStable(s, tctx, pkg, { confirm: b.confirm, filesAs: b.filesAs === 'file' ? 'file' : 'database', proceedWithoutBackup: b.proceedWithoutBackup === true, ...flowOpts(b) })
    })
    if (b.plan !== true) {
      await core.install.audit({ userId: rec.id, action: 'solution.deploy', environmentId: target, details: { solution: sol.id, name: sol.name, version: sol.version, from: ctx.environmentId, to: target, includeData: b.includeData === true } }).catch(() => {})
    }
    return out
  }, { auth: 'maker', maxBodyMB: 1 })
}

/** the plan of an "import as a copy": everything is new */
async function copyPlan(s: Services, text: unknown): Promise<SolutionPlan> {
  const doc = parsePackage(text, 'appbuilder/solution')
  const head = isObj(doc.solution) ? doc.solution : {}
  const list = (v: unknown) => (Array.isArray(v) ? v.filter(isObj) : [])
  const env = s.environments ? await s.environments.get(s.environment().id) : null
  const items: SolutionPlan['items'] = [
    ...list(doc.tables).map((t) => ({ kind: 'table' as const, id: '', name: String((isObj(t.schema) && t.schema.displayName) || (isObj(t.schema) && t.schema.name) || 'Table'), change: 'new' as const, note: 'reused when a table of the same name exists' })),
    ...list(doc.apps).map((a) => ({ kind: 'app' as const, id: '', name: String(a.name ?? 'App'), change: 'new' as const })),
    ...list(doc.roles).map((r) => ({ kind: 'role' as const, id: '', name: String(r.name ?? 'Role'), change: 'new' as const })),
    ...list(doc.connections).map((c) => ({ kind: 'connection' as const, id: '', name: String(c.name ?? 'Connection'), change: 'new' as const })),
    ...list(doc.files).map((f) => ({ kind: 'file' as const, id: '', name: String(f.fileName ?? 'File'), change: 'new' as const })),
  ]
  return {
    mode: 'copy',
    solution: { id: '', name: String(head.name ?? ''), displayName: String(head.displayName ?? 'Solution'), version: String(head.version ?? '') },
    target: { id: s.environment().id, name: env?.name ?? 'Default', type: env?.type ?? 'production', ...(env?.locked ? { locked: true } : {}) },
    items, destructive: false, problems: [], warnings: ['Everything is imported as new copies with new identities; a later import of the same solution will not upgrade them.'],
    backup: { available: false, message: 'Nothing here is changed: everything in the package is new.' }, token: '',
  }
}

/* ------------------------------------------------------------------ export */

export async function exportSolutionPackage(s: Services, ctx: Ctx, id: string, includeData: boolean): Promise<string> {
  const u = me(ctx)
  const sol = await needSolution(s, id)
  const allTables = await s.meta.tables.list()
  const ofKind = (k: SolutionComponentKind) => sol.components.filter((c) => c.kind === k).map((c) => c.id)
  const files = []
  for (const fid of ofKind('file')) {
    const f = await s.meta.files.get(fid)
    if (f) files.push(f)
  }
  const fileIds = new Set(files.map((f) => f.id))
  const fileTables = allTables.filter((t) => t.origin?.kind === 'file' && fileIds.has(t.origin.fileId))
  const tableDefs = ofKind('table').map((tid) => allTables.find((t) => t.id === tid)).filter((t): t is TableDef => !!t && !fileIds.has(t.origin?.fileId ?? ''))
  const allIncluded = new Set([...tableDefs, ...fileTables].map((t) => t.id))
  const appIds = ofKind('app')
  const appSet = new Set(appIds)
  const roles: RoleDef[] = []
  for (const rid of ofKind('role')) {
    const r = await s.meta.roles.get(rid)
    if (!r) continue
    const c = clone(r) as RoleX
    c.privileges = c.privileges.filter((p) => allIncluded.has(p.table))
    if (Array.isArray(c.apps)) c.apps = c.apps.filter((a) => appSet.has(a))
    roles.push(c)
  }
  const connections = []
  for (const cid of ofKind('connection')) {
    const c = await s.meta.connections.get(cid)
    if (c && c.connector !== 'files') connections.push({ id: c.id, name: c.name, connector: c.connector, settings: { ...c.settings }, ...(await exportConnectionActions(s, c)) })
  }
  const fileEntries = []
  for (const f of files) {
    const mine = fileTables.filter((t) => t.origin?.fileId === f.id)
    if (!mine.every((t) => canReadWholeTable(u, t))) throw invalid(`Exporting "${f.fileName}" needs full read access to all of its tables.`)
    const bytes = await readDataFile(s.env, f.id)
    fileEntries.push({
      id: f.id, fileName: f.fileName, kind: f.kind, base64: bytes.toString('base64'),
      tables: mine.map((t) => ({ id: t.id, name: t.name, displayName: t.displayName, ...(t.description ? { description: t.description } : {}), sheet: t.origin?.sheet, primaryColumn: t.primaryColumn })),
    })
  }
  const apps = []
  for (const aid of appIds) apps.push(await appEntry(s, aid))
  const tables = []
  for (const t of tableDefs) tables.push(await tableEntry(s, u, t, includeData))
  return toYaml({
    kind: 'appbuilder/solution', packageVersion: PACKAGE_VERSION, exportedOn: s.now(),
    // the solution's id makes a later import of a newer version an in-place upgrade (alm.ts)
    solution: { id: sol.id, name: sol.name, displayName: sol.displayName, publisher: sol.publisher, version: sol.version, ...(sol.description ? { description: sol.description } : {}) },
    apps, tables, roles, connections, files: fileEntries,
    // P1-A: flows with their connection references and run permissions
    flows: await exportFlows(s, ofKind('flow')),
    // P1-C: approval policies (people by email; requests never travel)
    approvalPolicies: await exportApprovalPolicies(s, ofKind('approvalPolicy')),
  })
}

/* ------------------------------------------------------------------ import */

export interface PkgFile { oldId: string; fileName: string; bytes: Buffer; tables: { id: string; name?: string; displayName?: string; description?: string; sheet?: string; primaryColumn?: string }[] }

export function readPkgFiles(v: unknown): PkgFile[] {
  if (v === undefined) return []
  if (!Array.isArray(v)) throw invalid('The package "files" must be a list.')
  return v.map((e) => {
    if (!isObj(e) || typeof e.fileName !== 'string' || typeof e.base64 !== 'string') throw invalid('A file entry in the package is malformed.')
    const bytes = Buffer.from(e.base64, 'base64')
    if (!bytes.length) throw invalid(`The file "${e.fileName}" in the package is empty.`)
    if (bytes.length > MAX_FILE_BYTES) throw invalid(`The file "${e.fileName}" in the package is too large.`)
    const tables = (Array.isArray(e.tables) ? e.tables : []).filter(isObj).map((t) => ({
      id: String(t.id ?? ''), ...(typeof t.name === 'string' ? { name: t.name } : {}), ...(typeof t.displayName === 'string' ? { displayName: t.displayName } : {}),
      ...(typeof t.description === 'string' ? { description: t.description } : {}), ...(typeof t.sheet === 'string' ? { sheet: t.sheet } : {}),
      ...(typeof t.primaryColumn === 'string' ? { primaryColumn: t.primaryColumn } : {}),
    }))
    return { oldId: String(e.id ?? ''), fileName: e.fileName.split(/[\\/]/).pop()!, bytes, tables }
  })
}

export async function importSolutionPackage(s: Services, ctx: Ctx, text: unknown, filesAs: 'database' | 'file'): Promise<SolutionDef & { warnings?: string[] }> {
  const u = me(ctx)
  const doc = parsePackage(text, 'appbuilder/solution')
  if (!isObj(doc.solution) || typeof doc.solution.displayName !== 'string') throw invalid('The package has no solution header.')
  const head = doc.solution
  const listOf = (v: unknown, what: string): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : (() => { throw invalid(`The package "${what}" must be a list.`) })())
  // validate everything before creating anything
  const apps = listOf(doc.apps, 'apps').map(readPkgApp)
  const tables = readPkgTables(doc.tables, s.now())
  const files = readPkgFiles(doc.files)
  const roleDocs = listOf(doc.roles, 'roles').map((r) => {
    if (!isObj(r) || typeof r.name !== 'string' || !r.name.trim()) throw invalid('A role in the package is malformed.')
    return r as unknown as RoleX
  })
  const connDocs = listOf(doc.connections, 'connections').map((c) => {
    if (!isObj(c) || typeof c.name !== 'string' || !PACKAGE_CONNECTORS.includes(String(c.connector))) throw invalid('A connection in the package is malformed.')
    return c as unknown as { name: string; connector: ConnectorKind; settings?: Record<string, string>; actions?: unknown[] }
  })
  const warnings: string[] = []
  const isAdmin = u.privileges.isAdmin
  const undo: (() => Promise<void>)[] = []
  try {
    const { map: tableMap, created } = await ensurePkgTables(s, tables, ctx.user?.user.id)
    if (created.length) undo.push(async () => { const { connector } = await resolveConnection(s); await rollbackTables(s, connector, created) })
    await importPkgEventsAsCopies(s, tables, tableMap, created, ctx.user?.user.id ?? null, warnings)
    const components: SolutionDef['components'] = []
    for (const t of tables) components.push({ kind: 'table', id: tableMap.get(t.def.id)! })

    await installPkgFiles(s, files, filesAs, tableMap, components, undo)

    const appMap = new Map<string, string>()
    for (const a of apps) {
      const meta = await addApp(s, u.user.name, a.def, a.name, a.description)
      undo.push(async () => { await s.meta.apps.remove(meta.id); await forgetApp(s, meta.id) })
      if (a.oldId) appMap.set(a.oldId, meta.id)
      components.push({ kind: 'app', id: meta.id })
    }

    if (roleDocs.length && !isAdmin) warnings.push('Roles in the package were skipped: only administrators can create roles.')
    if (connDocs.length && !isAdmin) warnings.push('Connections in the package were skipped: only administrators can create connections.')
    if (isAdmin) {
      const existingRoles = (await s.meta.roles.list()) as RoleX[]
      const newRoles: RoleX[] = []
      for (const r of roleDocs) {
        const privileges = (Array.isArray(r.privileges) ? r.privileges : [])
          .filter((p) => isObj(p) && tableMap.has(p.table))
          .map((p) => {
            const out: TablePrivilege = { table: tableMap.get(p.table)!, create: p.create === true, read: p.read ?? 'none', update: p.update ?? 'none', delete: p.delete ?? 'none' }
            if (isObj(p.columns)) out.columns = { ...p.columns }
            if (Array.isArray(p.rowFilter)) out.rowFilter = clone(p.rowFilter)
            if (p.share && p.share !== 'none') out.share = p.share
            return out
          })
        const role: RoleX = {
          id: s.uid('role'), name: uniqueLabel(r.name.trim().slice(0, 100), [...existingRoles, ...newRoles].map((x) => x.name)),
          ...(typeof r.description === 'string' && r.description ? { description: r.description } : {}),
          privileges,
          apps: r.apps === 'all' ? 'all' : (Array.isArray(r.apps) ? r.apps : []).map((a) => appMap.get(a)).filter((a): a is string => !!a),
          ...(r.isMaker ? { isMaker: true } : {}),
        }
        if (r.isAdmin) warnings.push(`The administrator flag of role "${r.name}" was not imported.`)
        await s.meta.roles.upsert(role)
        undo.push(async () => { await s.meta.roles.remove(role.id) })
        newRoles.push(role)
        components.push({ kind: 'role', id: role.id })
      }
      const existingConns = await s.meta.connections.list()
      const newConns: ConnectionRecord[] = []
      for (const c of connDocs) {
        const settings: Record<string, string> = {}
        for (const [k, v] of Object.entries(isObj(c.settings) ? c.settings : {})) if (typeof v === 'string') settings[k] = v
        const rec: ConnectionRecord = {
          id: s.uid('conn'), name: uniqueLabel(c.name.trim().slice(0, 100), [...existingConns, ...newConns].map((x) => x.name)),
          connector: c.connector, status: 'not-configured', settings, isDefault: false, scope: 'server',
        }
        await s.meta.connections.upsert(rec)
        undo.push(async () => { await s.meta.connections.remove(rec.id) })
        warnings.push(...(await importConnectionActions(s, rec.id, c.actions, ctx.user?.user.id ?? null)))
        newConns.push(rec)
        components.push({ kind: 'connection', id: rec.id })
      }
      if (newConns.length) warnings.push('Imported connections have no passwords or keys yet: edit them and enter the secrets.')
    }

    const sols = await s.meta.solutions.list()
    const now = s.now()
    const displayName = uniqueLabel(String(head.displayName).trim().slice(0, 200) || 'Imported solution', sols.map((x) => x.displayName))
    const sol: SolutionDef = {
      id: s.uid('sol'),
      name: uniqueIdentifier(toIdentifier(typeof head.name === 'string' && head.name ? head.name : displayName, 'Solution'), sols.map((x) => x.name)),
      displayName,
      publisher: typeof head.publisher === 'string' && head.publisher ? head.publisher : u.user.name,
      version: typeof head.version === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(head.version) ? head.version : '1.0.0',
      ...(typeof head.description === 'string' && head.description ? { description: head.description } : {}),
      components, createdOn: now, modifiedOn: now,
    }
    await s.meta.solutions.upsert(sol)
    s.security.invalidate()
    await audit(s, ctx, 'solution.import', { id: sol.id, name: sol.name, filesAs })
    return warnings.length ? { ...sol, warnings } : sol
  } catch (e) {
    for (const f of undo.reverse()) await f().catch(() => {})
    throw e
  }
}


/**
 * Data files of a package: each becomes a new data file (new ids), kept as a file or moved into the default database
 * (filesAs). Old table ids are mapped to the new ones in tableMap; undo steps go to `undo` (files live on disk).
 */
export async function installPkgFiles(
  s: Services, files: PkgFile[], filesAs: 'database' | 'file', tableMap: Map<string, string>, components: SolutionDef['components'], undo: (() => Promise<void>)[],
): Promise<void>  {
  for (const f of files) {
    const hints: Record<string, { name?: string; displayName?: string; description?: string; primaryColumn?: string }> = {}
    for (const t of f.tables) if (t.sheet) hints[t.sheet] = { name: t.name, displayName: t.displayName, description: t.description, primaryColumn: t.primaryColumn }
    let reg = await registerDataFile(s, f.fileName, f.bytes, { hints })
    undo.push(async () => { const cur = await s.meta.files.get(reg.file.id); if (cur) await deleteDataFile(s, cur, true) })
    for (const t of reg.tables) {
      const old = f.tables.find((x) => x.sheet === t.origin?.sheet)
      if (old) tableMap.set(old.id, t.id)
    }
    if (filesAs === 'file') {
      components.push({ kind: 'file', id: reg.file.id })
    } else {
      const { record, connector } = await resolveConnection(s)
      const moved: TableDef[] = []
      try {
        for (const t of reg.tables) {
          const m = await moveTable(s, t, record, connector)
          moved.push(m)
          components.push({ kind: 'table', id: m.id })
        }
      } catch (e) {
        for (const m of moved) {
          await connector.dropTable(m).catch(() => {})
          await s.meta.tables.remove(m.id).catch(() => {})
        }
        throw e
      }
      // the temporary file is no longer needed (its tables now live in the database)
      const cur = await s.meta.files.get(reg.file.id)
      if (cur) await deleteDataFile(s, cur, true).catch(() => {})
      reg = { ...reg, tables: moved }
      undo.push(async () => { for (const m of moved) await connector.dropTable(m).catch(() => {}); for (const m of moved) await s.meta.tables.remove(m.id).catch(() => {}) })
    }
  }

}

export { plainTableDef }
