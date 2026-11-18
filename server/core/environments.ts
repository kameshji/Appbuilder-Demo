/**
 * Environments (docs/admin/environments.md, docs/dev/architecture.md "Environments"): the registry in ab.environments,
 * who may enter which (ab.environment_access; install administrators enter all), how a request finds its environment
 * (resolveFor), the per-environment workspace folders, and the EnvironmentDef the client sees.
 * Creating, copying and deleting environments: environment-ops.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { EnvironmentDef, UserDef } from '../../src/platform/contracts.ts'
import { HttpError } from './contracts.ts'
import type {
  EnvironmentAccessRecord, EnvironmentDirs, EnvironmentManager, EnvironmentRecord, InstallStore, Services, UserContext,
} from './contracts.ts'
import { DEFAULT_ENVIRONMENT_ID, ENV_ID } from './env-context.ts'
import { SCHEMA_VERSION } from './meta-store.ts'
import { errText } from './util.ts'

export { DEFAULT_ENVIRONMENT_ID }
export const DEFAULT_MAX_ENVIRONMENTS = 5
const CACHE_MS = 2000

/** APPBUILDER_MAX_ENVIRONMENTS (1-50), default 5 */
export function maxEnvironments(env: NodeJS.ProcessEnv): number {
  const n = Number(env.APPBUILDER_MAX_ENVIRONMENTS)
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : DEFAULT_MAX_ENVIRONMENTS
}

/** workspace/env/<id>/{files,attachments} */
export function environmentDirs(workspaceDir: string, id: string): EnvironmentDirs {
  if (!ENV_ID.test(id)) throw new HttpError(422, 'invalid', 'Invalid environment id.')
  const root = path.join(workspaceDir, 'env', id)
  return { root, files: path.join(root, 'files'), attachments: path.join(root, 'attachments') }
}

/** a user with no environment to enter (403 carries this flag: routes marked noEnvironment still answer) */
export class NoEnvironmentError extends HttpError {
  noEnvironment = true
  constructor() {
    super(403, 'denied', 'You have not been given access to any environment yet. Ask an administrator to add you to one.')
  }
}

export function createEnvironmentManager(deps: {
  install: () => InstallStore | null
  workspaceDir: string
  max: number
}): EnvironmentManager & { access(): Promise<EnvironmentAccessRecord[]> } {
  let cache: { at: number; envs: EnvironmentRecord[]; access: EnvironmentAccessRecord[] } | null = null
  let loading: Promise<{ envs: EnvironmentRecord[]; access: EnvironmentAccessRecord[] }> | null = null
  let generation = 0

  async function load(): Promise<{ envs: EnvironmentRecord[]; access: EnvironmentAccessRecord[] }> {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache
    if (loading) return loading
    const install = deps.install()
    if (!install) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    const gen = generation
    const p = Promise.all([install.environments.list(), install.access.list()])
      .then(([envs, access]) => {
        if (gen === generation) cache = { at: Date.now(), envs, access }
        return { envs, access }
      })
      .finally(() => {
        if (loading === p) loading = null
      })
    loading = p
    return p
  }

  const mayEnter = (user: UserDef, access: EnvironmentAccessRecord[], id: string): boolean =>
    !!user.isInstallAdmin || access.some((a) => a.environmentId === id && a.userId === user.id)

  return {
    async list() {
      return (await load()).envs
    },
    async get(id) {
      return (await load()).envs.find((e) => e.id === id) ?? null
    },
    async access() {
      return (await load()).access
    },
    async accessible(user) {
      const { envs, access } = await load()
      return envs.filter((e) => mayEnter(user, access, e.id))
    },
    async resolveFor(user, requested) {
      const { envs, access } = await load()
      if (requested) {
        const e = envs.find((x) => x.id === requested)
        if (!e) throw new HttpError(404, 'not-found', `There is no environment "${requested}".`)
        if (!mayEnter(user, access, e.id)) throw new HttpError(403, 'denied', `You do not have access to the environment "${e.name}". Ask an administrator.`)
        if (e.state !== 'ready') {
          throw new HttpError(503, 'unavailable', e.state === 'failed'
            ? `The environment "${e.name}" is not available: ${e.lastError ?? 'it failed'}`
            : e.state === 'restoring'
              ? `The environment "${e.name}" is being restored from a backup. Nothing can be read or changed there until it is done; try again in a few minutes.`
              : `The environment "${e.name}" is being ${e.state === 'creating' ? 'created' : 'deleted'}. Try again in a moment.`)
        }
        return e
      }
      const usable = envs.filter((e) => e.state === 'ready' && mayEnter(user, access, e.id))
      const pick = usable.find((e) => e.id === user.lastEnvironmentId) ?? usable.find((e) => e.id === DEFAULT_ENVIRONMENT_ID) ?? usable[0]
      if (!pick) throw new NoEnvironmentError()
      return pick
    },
    async isLocked(id) {
      const e = (await load()).envs.find((x) => x.id === id)
      return !!e && e.locked && e.type === 'production'
    },
    dirs: (id) => environmentDirs(deps.workspaceDir, id),
    invalidate() {
      generation++
      cache = null
      loading = null
    },
    max: () => deps.max,
  }
}

/** what the client sees of an environment; details for install admins and that environment's admins */
export function toEnvironmentDef(e: EnvironmentRecord, opts: { canManage: boolean; database?: string }): EnvironmentDef {
  const out: EnvironmentDef = { id: e.id, name: e.name, type: e.type, builtIn: e.builtIn }
  if (e.createdOn) out.createdOn = e.createdOn
  if (e.description) out.description = e.description
  if (e.state !== 'ready') out.state = e.state
  if (e.locked && e.type === 'production') out.locked = true
  if (opts.canManage) {
    out.canManage = true
    out.details = { database: opts.database || 'System database', schemaVersion: e.schemaVersion || SCHEMA_VERSION, schema: e.schema }
    if (e.createdBy) out.details.createdBy = e.createdBy
    if (e.lastError) out.details.error = e.lastError
  }
  return out
}

/** may this user manage the environment (rename, access): install admin, or an environment admin there */
export function canManage(user: UserDef, access: EnvironmentAccessRecord[], id: string): boolean {
  return !!user.isInstallAdmin || access.some((a) => a.environmentId === id && a.userId === user.id && a.isEnvAdmin)
}

/** the environments the user may enter, as the client sees them (GET /environments, GET /workspace) */
export async function listEnvironments(services: Services, user: UserContext): Promise<EnvironmentDef[]> {
  const location = (services as Services & { state?: { location?: string | null } }).state?.location ?? undefined
  const mgr = services.environments
  if (!mgr) {
    // the metadata test harness: one built-in environment, the way version 4 answered
    const out: EnvironmentDef = { id: DEFAULT_ENVIRONMENT_ID, name: 'Default', type: 'production', builtIn: true }
    if (user.privileges.isAdmin) out.details = { database: location || 'System database', schemaVersion: SCHEMA_VERSION }
    return [out]
  }
  const [list, access] = await Promise.all([mgr.accessible(user.user), (mgr as ReturnType<typeof createEnvironmentManager>).access()])
  let createdOn: string | null = null
  try {
    createdOn = (await services.meta.info()).createdOn
  } catch {
    createdOn = null
  }
  return list.map((e) => {
    const def = toEnvironmentDef(e, { canManage: canManage(user.user, access, e.id), database: location })
    // Default existed before the registry recorded dates: it was set up when the first account was created
    if (e.builtIn && createdOn) def.createdOn = createdOn
    return def
  })
}

/* ------------------------------------------------------------------ workspace folders */

/** moves the entries of `from` into `to` (creating it); an entry already in `to` is kept and the old one left */
function moveInto(from: string, to: string): number {
  if (!fs.existsSync(from)) return 0
  fs.mkdirSync(to, { recursive: true })
  let moved = 0
  for (const name of fs.readdirSync(from)) {
    const target = path.join(to, name)
    if (fs.existsSync(target)) continue
    fs.renameSync(path.join(from, name), target)
    moved++
  }
  try {
    if (fs.readdirSync(from).length === 0) fs.rmdirSync(from)
  } catch {
    /* left for the administrator */
  }
  return moved
}

/**
 * Version 5 layout: data files and attachments of the (only) environment of an older install move from
 * workspace/files and workspace/attachments into workspace/env/default/. Idempotent; never overwrites.
 */
export function moveLegacyWorkspace(legacy: { filesDir: string; attachmentsDir: string }, defaultDirs: EnvironmentDirs, log: (level: 'info' | 'warn', msg: string) => void): void {
  for (const [from, to, what] of [[legacy.filesDir, defaultDirs.files, 'data files'], [legacy.attachmentsDir, defaultDirs.attachments, 'attachments']] as const) {
    if (path.resolve(from) === path.resolve(to)) continue
    try {
      const n = moveInto(from, to)
      if (n) log('info', `moved ${n} ${what} entr${n === 1 ? 'y' : 'ies'} from ${from} into the Default environment folder ${to}`)
    } catch (e) {
      log('warn', `could not move the ${what} folder ${from} into ${to}: ${errText(e)}`)
    }
  }
}

/** bytes and number of files below a folder (attachments, data files); 0 when it does not exist */
export async function folderSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  async function walk(d: string): Promise<void> {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile()) {
        try {
          bytes += (await fs.promises.stat(p)).size
          files++
        } catch {
          /* removed meanwhile */
        }
      }
    }
  }
  await walk(dir)
  return { bytes, files }
}
