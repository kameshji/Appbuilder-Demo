/**
 * Environment lifecycle (docs/admin/environments.md): create (empty, with the sample, or copied from another
 * environment: schema only or schema + data, copied inside the database), rename / describe / change type / lock,
 * delete (drops the schema and the workspace folder), and access grants. Every operation is written to the
 * install-level audit (ab.audit). Callers check who may do what (routes/meta/environments.ts).
 */
import fs from 'node:fs'
import { HttpError } from './contracts.ts'
import type { EnvironmentRecord, EnvironmentType, SnapshotResult, SqlDb, UserContext } from './contracts.ts'
import type { EnvironmentCreateRequest } from '../../src/platform/http.ts'
import type { CoreServices } from './services.ts'
import { DEFAULT_ENVIRONMENT_ID, ENV_ID, environmentSchema, runInEnvironment } from './env-context.ts'
import { SCHEMA_VERSION, environmentDdl } from './meta-store.ts'
import { DEFAULT_CONNECTION_ID, FILES_CONNECTION_ID } from './connections.ts'
import { ROLE_ADMIN, ensureBuiltinRoles } from './auth.ts'
import { flushFiles, forgetFilesFolder } from '../connectors/files/index.ts'
import { seedSample } from '../routes/meta/seed.ts'
import { copySystemData, provisionSystemTables } from './system-tables.ts'
import { assertAdminRemains } from '../routes/meta/security.ts'
import { errText, log } from './util.ts'

const q = (id: string): string => `"${id.replace(/"/g, '""')}"`
const TYPES: EnvironmentType[] = ['production', 'sandbox', 'developer']
export const MAX_NAME = 60

const invalid = (m: string, field?: string) => new HttpError(422, 'invalid', m, field)
const conflict = (m: string) => new HttpError(409, 'conflict', m)

export async function installAudit(s: CoreServices, actor: string | null, action: string, environmentId: string | null, details?: unknown): Promise<void> {
  try {
    await s.install.audit({ userId: actor, action, environmentId, details })
  } catch (e) {
    log('error', `install audit write failed (${action}): ${errText(e)}`)
  }
}

/** "Sales test (2)" -> "sales_test_2"; starts with a letter, at most 40 characters */
export function slugFor(name: string): string {
  let s = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!/^[a-z]/.test(s)) s = `e_${s}`
  s = s.slice(0, 36).replace(/_+$/, '')
  return ENV_ID.test(s) ? s : 'env'
}

function checkName(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw invalid('An environment needs a name.', 'name')
  const name = raw.trim().replace(/\s+/g, ' ')
  if (name.length > MAX_NAME) throw invalid(`The name is too long (at most ${MAX_NAME} characters).`, 'name')
  return name
}
function checkType(raw: unknown): EnvironmentType {
  if (!TYPES.includes(raw as EnvironmentType)) throw invalid('The type must be production, sandbox or developer.', 'type')
  return raw as EnvironmentType
}
function checkDescription(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'string') throw invalid('The description must be text.', 'description')
  if (raw.length > 500) throw invalid('The description is too long (at most 500 characters).', 'description')
  return raw.trim() || undefined
}

async function schemaExists(db: SqlDb, schema: string): Promise<boolean> {
  return (await db.query('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1', [schema])).length > 0
}

/** why creating is not possible right now (null when it is) */
export async function createBlocked(s: CoreServices, user: UserContext): Promise<string | null> {
  if (!user.privileges.isInstallAdmin) return 'Only install administrators can create environments.'
  const n = (await s.environments.list()).length
  if (n >= s.environments.max()) return `This install has ${n} environments, the most it allows (${s.environments.max()}). Delete one first, or raise APPBUILDER_MAX_ENVIRONMENTS.`
  return null
}

/* ------------------------------------------------------------------ create */

export async function createEnvironment(s: CoreServices, actor: UserContext, b: Partial<EnvironmentCreateRequest>): Promise<EnvironmentRecord> {
  const blocked = await createBlocked(s, actor)
  if (blocked) throw actor.privileges.isInstallAdmin ? conflict(blocked) : new HttpError(403, 'denied', blocked)
  const name = checkName(b.name)
  const type = checkType(b.type ?? 'sandbox')
  const description = checkDescription(b.description)
  const all = await s.install.environments.list()
  if (all.some((e) => e.name.toLowerCase() === name.toLowerCase())) throw conflict(`An environment named "${name}" already exists.`)
  let source: EnvironmentRecord | null = null
  const copy = b.copy === 'data' ? 'data' : 'schema'
  if (b.copy !== undefined && b.copy !== 'schema' && b.copy !== 'data') throw invalid('copy must be "schema" or "data".', 'copy')
  if (b.copyFrom !== undefined && b.copyFrom !== null && b.copyFrom !== '') {
    if (typeof b.copyFrom !== 'string') throw invalid('copyFrom must be an environment id.', 'copyFrom')
    source = all.find((e) => e.id === b.copyFrom) ?? null
    if (!source) throw new HttpError(404, 'not-found', `There is no environment "${b.copyFrom}" to copy.`)
    if (source.state !== 'ready') throw conflict(`"${source.name}" cannot be copied while it is ${source.state}.`)
  }
  // id: a slug of the name, unique in the registry and as a schema
  const db = s.state.db!
  const base = slugFor(name)
  let id = base
  for (let i = 2; all.some((e) => e.id === id) || (await schemaExists(db, environmentSchema(id))); i++) id = `${base.slice(0, 36)}_${i}`
  const schema = environmentSchema(id)
  const rec = { id, schema, name, type, builtIn: false, state: 'creating' as const, locked: false, createdBy: actor.user.id, ...(description ? { description } : {}) }
  await s.install.environments.insert(rec)
  s.environments.invalidate()
  const dirs = s.environments.dirs(id)
  const started = Date.now()
  try {
    await s.transaction(() => runInEnvironment(id, async () => {
      for (const stmt of environmentDdl(schema)) await db.exec(stmt)
      if (source) await copyContent(s, source, { id, schema }, copy)
      // P0-N core data model: system tables (views, real tables, reference data); a copy with data takes their rows along
      await provisionSystemTables(db, schema, id)
      if (source && copy === 'data') await copySystemData(db, source.schema, schema)
      await ensureBuiltinRoles(s)
      await s.ensureBuiltinConnections()
      // the creator administers it (an Administrator role there also records the access)
      const me = await s.meta.users.get(actor.user.id)
      await s.meta.users.update(actor.user.id, { roleIds: [...new Set([...(me?.roleIds ?? []), ROLE_ADMIN])] })
      if (!source && b.sampleData) await seedSample(s, actor.user.id)
      await s.install.environments.update(id, { state: 'ready', schemaVersion: SCHEMA_VERSION, lastError: '' })
    }))
  } catch (e) {
    const why = e instanceof HttpError ? e.message : errText(e)
    log('error', `creating environment ${id} failed: ${why}`)
    await fs.promises.rm(dirs.root, { recursive: true, force: true }).catch(() => {})
    await db.exec(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`).catch(() => {})
    await s.install.environments.update(id, { state: 'failed', lastError: `Creating it failed: ${why}`.slice(0, 1000) }).catch(() => {})
    s.environments.invalidate()
    await installAudit(s, actor.user.id, 'environment.create_failed', id, { id, name, error: why })
    throw e instanceof HttpError ? e : new HttpError(500, 'storage', `The environment could not be created: ${why}`)
  } finally {
    s.security.invalidate({ environment: id })
    s.environments.invalidate()
  }
  await installAudit(s, actor.user.id, 'environment.create', id, {
    id, name, type, schema, ...(source ? { copyFrom: source.id, copy } : {}), sampleData: !source && !!b.sampleData, ms: Date.now() - started,
  })
  return (await s.install.environments.get(id))!
}

/** metadata tables copied by every copy; the data-only ones follow */
const COPY_META = ['ab_roles', 'ab_role_tables', 'ab_tables', 'ab_apps', 'ab_solutions', 'ab_connections', 'ab_table_events', 'ab_relationships', 'ab_model_layouts']
const COPY_DATA_META = ['ab_data_files', 'ab_attachments', 'ab_counters', 'ab_shares']

async function columnsOf(db: SqlDb, schema: string, table: string): Promise<string[]> {
  const rows = await db.query<{ column_name: string }>(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position', [schema, table],
  )
  return rows.map((r) => r.column_name)
}

async function copyRows(db: SqlDb, from: string, to: string, table: string): Promise<void> {
  const target = new Set(await columnsOf(db, to, table))
  const cols = (await columnsOf(db, from, table)).filter((c) => target.has(c))
  if (!cols.length) return
  const list = cols.map(q).join(', ')
  await db.exec(`INSERT INTO ${q(to)}.${q(table)} (${list}) SELECT ${list} FROM ${q(from)}.${q(table)}`)
}

/**
 * Copies one environment into a new, empty one (inside the creating transaction, in the database). Users' role
 * assignments, the audit log and sessions are not copied. Connections to other systems lose their secrets.
 * schema: tables (empty), apps, roles, solutions, connections; data: also rows, counters, attachments, data files.
 */
async function copyContent(s: CoreServices, src: EnvironmentRecord, dst: { id: string; schema: string }, mode: 'schema' | 'data'): Promise<void> {
  const db = s.state.db!
  for (const t of COPY_META) await copyRows(db, src.schema, dst.schema, t)
  const D = (t: string) => `${q(dst.schema)}.${q(t)}`
  // a copy never reaches another system with the original's credentials
  await db.exec(`UPDATE ${D('ab_connections')} SET secret_sealed = NULL, status = 'not-configured', last_error = NULL WHERE id NOT IN ($1, $2)`, [DEFAULT_CONNECTION_ID, FILES_CONNECTION_ID])
  if (mode === 'data') {
    for (const t of COPY_DATA_META) await copyRows(db, src.schema, dst.schema, t)
  } else {
    // data files are data: their tables go too, with everything that names them
    const fileTables = (await db.query<{ id: string }>(`SELECT id FROM ${D('ab_tables')} WHERE connection_id = $1`, [FILES_CONNECTION_ID])).map((r) => r.id)
    if (fileTables.length) {
      await db.exec(`DELETE FROM ${D('ab_role_tables')} WHERE table_id = ANY($1::text[])`, [fileTables])
      await db.exec(`DELETE FROM ${D('ab_tables')} WHERE id = ANY($1::text[])`, [fileTables])
    }
    const drop = new Set(fileTables)
    for (const r of await db.query<{ id: string; components: unknown }>(`SELECT id, components FROM ${D('ab_solutions')}`)) {
      const list = (Array.isArray(r.components) ? r.components : []) as { kind: string; id: string }[]
      const kept = list.filter((c) => c.kind !== 'file' && !(c.kind === 'table' && drop.has(c.id)))
      if (kept.length !== list.length) await db.exec(`UPDATE ${D('ab_solutions')} SET components = $1::jsonb WHERE id = $2`, [JSON.stringify(kept), r.id])
    }
  }
  // physical tables of the default connection: created in the new schema from their definitions (same index names
  // as any table the platform creates), rows copied with INSERT ... SELECT
  const defs = await runInEnvironment(dst.id, () => s.meta.tables.list())
  const connector = await runInEnvironment(dst.id, () => s.connections.get(DEFAULT_CONNECTION_ID))
  // reporting views (package K) after the tables they read; they hold no rows of their own
  defs.sort((a, b) => Number(a.reporting?.kind === 'view') - Number(b.reporting?.kind === 'view'))
  for (const def of defs) {
    if (def.connectionId !== DEFAULT_CONNECTION_ID || !def.source) continue
    // system tables are provisioned by provisionSystemTables (views and tables of the core data model)
    if (def.system) continue
    const exists = await db.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`${q(src.schema)}.${q(def.source)}`])
    if (!(exists[0] as { ok?: boolean })?.ok) continue
    await runInEnvironment(dst.id, () => connector.createTable(def))
    if (mode === 'data' && def.reporting?.kind !== 'view') {
      await copyRows(db, src.schema, dst.schema, def.source)
      // planner statistics for the copied rows (also what the admin console's row estimate reads)
      await db.exec(`ANALYZE ${q(dst.schema)}.${q(def.source)}`)
    }
  }
  if (mode === 'data') {
    const from = s.environments.dirs(src.id)
    const to = s.environments.dirs(dst.id)
    // pending writes of the source's data files reach its folder before the folder is copied
    await runInEnvironment(src.id, () => flushFiles(s.env)).catch((e) => log('warn', `flushing the data files of ${src.id} failed: ${errText(e)}`))
    for (const [a, b] of [[from.attachments, to.attachments], [from.files, to.files]]) {
      if (fs.existsSync(a)) await fs.promises.cp(a, b, { recursive: true, force: false, errorOnExist: false })
    }
  }
}

/* ------------------------------------------------------------------ update */

export async function updateEnvironment(
  s: CoreServices, actor: UserContext, id: string, b: { name?: unknown; description?: unknown; type?: unknown; locked?: unknown },
): Promise<EnvironmentRecord> {
  const e = await s.install.environments.get(id)
  if (!e) throw new HttpError(404, 'not-found', `There is no environment "${id}".`)
  const all = await s.install.environments.list()
  const patch: Parameters<typeof s.install.environments.update>[1] = {}
  const changes: Record<string, { before: unknown; after: unknown }> = {}
  if (b.name !== undefined) {
    const name = checkName(b.name)
    if (all.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) throw conflict(`An environment named "${name}" already exists.`)
    if (name !== e.name) { patch.name = name; changes.name = { before: e.name, after: name } }
  }
  if (b.description !== undefined) {
    const d = checkDescription(b.description) ?? ''
    if (d !== (e.description ?? '')) { patch.description = d; changes.description = { before: e.description ?? '', after: d } }
  }
  let type = e.type
  if (b.type !== undefined) {
    type = checkType(b.type)
    if (type !== e.type) {
      if (e.type === 'production' && !all.some((x) => x.id !== id && x.type === 'production')) {
        throw conflict(`"${e.name}" is the only production environment; make another one production first.`)
      }
      patch.type = type
      changes.type = { before: e.type, after: type }
      if (type !== 'production' && e.locked) { patch.locked = false; changes.locked = { before: true, after: false } }
    }
  }
  if (b.locked !== undefined) {
    if (typeof b.locked !== 'boolean') throw invalid('locked must be true or false.', 'locked')
    if (b.locked && type !== 'production') throw invalid('Only production environments can be locked.', 'locked')
    if (b.locked !== e.locked && changes.locked === undefined) { patch.locked = b.locked; changes.locked = { before: e.locked, after: b.locked } }
  }
  if (!Object.keys(patch).length) return e
  if (e.state === 'creating' || e.state === 'deleting' || e.state === 'restoring') throw conflict(`"${e.name}" is being ${e.state === 'creating' ? 'created' : e.state === 'restoring' ? 'restored' : 'deleted'}.`)
  await s.install.environments.update(id, patch)
  s.environments.invalidate()
  const action = changes.locked && Object.keys(changes).length === 1 ? (patch.locked ? 'environment.lock' : 'environment.unlock') : 'environment.update'
  await installAudit(s, actor.user.id, action, id, { id, name: patch.name ?? e.name, changes })
  return (await s.install.environments.get(id))!
}

/* ------------------------------------------------------------------ delete */

export async function deleteEnvironment(s: CoreServices, actor: UserContext, id: string, confirmName: unknown, opts: { proceedWithoutBackup?: boolean } = {}): Promise<{ backup?: SnapshotResult }> {
  const e = await s.install.environments.get(id)
  if (!e) throw new HttpError(404, 'not-found', `There is no environment "${id}".`)
  if (e.builtIn || e.id === DEFAULT_ENVIRONMENT_ID) throw conflict('The Default environment cannot be deleted.')
  if (typeof confirmName !== 'string' || confirmName.trim() !== e.name) throw invalid(`Type the name of the environment ("${e.name}") to confirm.`, 'confirmName')
  const all = await s.install.environments.list()
  if (e.type === 'production' && !all.some((x) => x.id !== id && x.type === 'production')) throw conflict(`"${e.name}" is the last production environment and cannot be deleted.`)
  if (e.state === 'creating' || e.state === 'deleting' || e.state === 'restoring') throw conflict(`"${e.name}" is being ${e.state === 'creating' ? 'created' : e.state === 'restoring' ? 'restored' : 'deleted'}.`)
  if (id === actor.environmentId) {
    // the request itself works in it; the client switches away first
    throw conflict('Switch to another environment before deleting this one.')
  }
  // a backup of it first (package J): it can be restored as a new environment later
  let backup: SnapshotResult | undefined
  if (e.state === 'ready' && s.backup) {
    backup = await s.backup.snapshot({ id: e.id, schema: e.schema }, `before deleting environment ${e.name}`, { trigger: 'pre-delete', by: actor.user.id })
    if (backup.failed && !opts.proceedWithoutBackup) {
      throw new HttpError(409, 'conflict', `${backup.message} Nothing was deleted. Delete it without a backup, or cancel.`, 'backup')
    }
  }
  await s.install.environments.update(id, { state: 'deleting' })
  s.environments.invalidate()
  const dirs = s.environments.dirs(id)
  const db = s.state.db!
  try {
    await s.connections.closeEnvironment(id)
    await forgetFilesFolder(dirs.files)
    await db.tx(async (tx) => {
      await tx.exec(`DROP SCHEMA IF EXISTS ${q(e.schema)} CASCADE`)
    })
    await s.install.environments.remove(id)
  } catch (err) {
    const why = errText(err)
    await s.install.environments.update(id, { state: 'failed', lastError: `Deleting it failed: ${why}`.slice(0, 1000) }).catch(() => {})
    s.environments.invalidate()
    await installAudit(s, actor.user.id, 'environment.delete_failed', id, { id, name: e.name, error: why })
    throw new HttpError(500, 'storage', `The environment could not be deleted: ${why}`)
  }
  s.security.invalidate({ environment: id })
  s.environments.invalidate()
  let folder = 'removed'
  try {
    await fs.promises.rm(dirs.root, { recursive: true, force: true })
  } catch (err) {
    folder = `left on disk: ${errText(err)}`
    log('warn', `environment ${id}: its folder ${dirs.root} could not be removed: ${errText(err)}`)
  }
  await installAudit(s, actor.user.id, 'environment.delete', id, { id, name: e.name, type: e.type, schema: e.schema, folder, ...(backup ? { backup: backup.taken ? backup.id : backup.failed ? 'failed' : 'off' } : {}) })
  return backup ? { backup } : {}
}

/* ------------------------------------------------------------------ access */

/**
 * Lets a user into an environment (idempotent). isEnvAdmin true gives them the Administrator role there; false takes
 * every administrator role there away (other roles stay). Runs in the target environment.
 */
export async function grantAccess(s: CoreServices, actor: UserContext, envId: string, userId: string, isEnvAdmin: boolean | undefined): Promise<void> {
  const e = await s.install.environments.get(envId)
  if (!e || e.state !== 'ready') throw new HttpError(e ? 409 : 404, e ? 'conflict' : 'not-found', e ? `"${e.name}" is not ready.` : `There is no environment "${envId}".`)
  const user = await s.meta.users.get(userId)
  if (!user) throw new HttpError(404, 'not-found', 'User not found.')
  await runInEnvironment(envId, async () => {
    await s.transaction(async () => {
      await s.install.access.grant(envId, userId, actor.user.id)
      if (isEnvAdmin !== undefined) {
        const roles = await s.meta.roles.list()
        const admins = new Set(roles.filter((r) => r.isAdmin).map((r) => r.id))
        const cur = (await s.meta.users.get(userId))?.roleIds ?? []
        let next = isEnvAdmin ? [...new Set([...cur, roles.some((r) => r.id === ROLE_ADMIN) ? ROLE_ADMIN : [...admins][0]].filter(Boolean))] : cur.filter((r) => !admins.has(r))
        if (isEnvAdmin && !next.some((r) => admins.has(r))) {
          await ensureBuiltinRoles(s)
          next = [...new Set([...cur, ROLE_ADMIN])]
        }
        if (!isEnvAdmin) {
          const users = (await s.meta.users.list()).map((u) => (u.id === userId ? { ...u, roleIds: next } : u))
          assertAdminRemains(users, roles)
        }
        if (JSON.stringify(next) !== JSON.stringify(cur)) await s.meta.users.update(userId, { roleIds: next })
      }
    })
    s.security.invalidate()
  })
  s.environments.invalidate()
  await installAudit(s, actor.user.id, 'environment.access_grant', envId, { environment: envId, user: userId, email: user.email, ...(isEnvAdmin !== undefined ? { isEnvAdmin } : {}) })
}

/** takes a user out of an environment: the access row and every role they held there */
export async function revokeAccess(s: CoreServices, actor: UserContext, envId: string, userId: string): Promise<void> {
  const e = await s.install.environments.get(envId)
  if (!e) throw new HttpError(404, 'not-found', `There is no environment "${envId}".`)
  const user = await s.meta.users.get(userId)
  if (!user) throw new HttpError(404, 'not-found', 'User not found.')
  if (e.state === 'ready') {
    await runInEnvironment(envId, async () => {
      await s.transaction(async () => {
        const roles = await s.meta.roles.list()
        const users = (await s.meta.users.list()).map((u) => (u.id === userId ? { ...u, roleIds: [] } : u))
        assertAdminRemains(users, roles)
        await s.meta.users.update(userId, { roleIds: [] })
        await s.install.access.revoke(envId, userId)
      })
      s.security.invalidate()
    })
  } else {
    await s.install.access.revoke(envId, userId)
  }
  s.environments.invalidate()
  await installAudit(s, actor.user.id, 'environment.access_revoke', envId, { environment: envId, user: userId, email: user.email })
}
