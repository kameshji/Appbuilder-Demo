/**
 * Environments API (docs/dev/data-api.md "Environments"; src/platform/http.ts has the shapes):
 *   GET    /api/v1/environments                   signed-in user -> { items, max, canCreate, createBlocked? }
 *   POST   /api/v1/environments/:id/select        signed-in user with access -> EnvironmentDef (remembered on the user record)
 *   POST   /api/v1/environments                   install admin -> EnvironmentDef
 *   GET    /api/v1/environments/:id               install admin or its environment admin -> EnvironmentDetails (sizes)
 *   PATCH  /api/v1/environments/:id               install admin { name?, description?, type?, locked? }
 *   DELETE /api/v1/environments/:id               install admin { confirmName }
 *   GET    /api/v1/environments/:id/access        install admin or its environment admin -> { items }
 *   PUT    /api/v1/environments/:id/access/:user  same { isEnvAdmin? }
 *   DELETE /api/v1/environments/:id/access/:user  same
 *   GET    /api/v1/install/audit                  install admin -> AuditPageResponse (+ environmentId per entry)
 */
import type { EnvironmentAccessEntry, EnvironmentDetails, EnvironmentsResponse } from '../../../src/platform/http.ts'
import type { EnvironmentDef } from '../../../src/platform/contracts.ts'
import { HttpError } from '../../core/contracts.ts'
import type { Ctx, Router, Services, UserContext } from '../../core/contracts.ts'
import type { CoreServices } from '../../core/services.ts'
import { canManage, folderSize, listEnvironments, toEnvironmentDef } from '../../core/environments.ts'
import { createBlocked, createEnvironment, deleteEnvironment, grantAccess, installAudit, revokeAccess, updateEnvironment } from '../../core/environment-ops.ts'
import { bodyObj, invalid, me } from './util.ts'
import { auditQuery } from './admin.ts'

function core(s: Services): CoreServices {
  if (!s.environments) throw new HttpError(503, 'unavailable', 'Environments are not available here.')
  return s as CoreServices
}

function installAdmin(ctx: Ctx): UserContext {
  const u = me(ctx)
  if (!u.privileges.isInstallAdmin) throw new HttpError(403, 'denied', 'Only install administrators can do this.')
  return u
}

async function managerOf(s: CoreServices, ctx: Ctx, id: string): Promise<UserContext> {
  const u = me(ctx)
  if (!(await s.install.environments.get(id))) throw new HttpError(404, 'not-found', `There is no environment "${id}".`)
  if (!canManage(u.user, await s.environments.access(), id)) throw new HttpError(403, 'denied', 'Only install administrators and administrators of this environment can do this.')
  return u
}

async function defFor(s: CoreServices, u: UserContext, id: string): Promise<EnvironmentDef> {
  const e = await s.install.environments.get(id)
  if (!e) throw new HttpError(404, 'not-found', `There is no environment "${id}".`)
  return toEnvironmentDef(e, { canManage: canManage(u.user, await s.environments.access(), id), database: s.state.location ?? undefined })
}

export function registerEnvironmentRoutes(router: Router, services: Services): void {
  router.add('GET', '/api/v1/environments', async (ctx): Promise<EnvironmentsResponse> => {
    const items = await listEnvironments(services, me(ctx))
    if (!services.environments) return { items }
    const s = core(services)
    const blocked = await createBlocked(s, me(ctx))
    return { items, max: s.environments.max(), canCreate: !blocked, ...(blocked ? { createBlocked: blocked } : {}) }
  }, { auth: 'user', noEnvironment: true })

  router.add('POST', '/api/v1/environments/:id/select', async (ctx): Promise<EnvironmentDef> => {
    const s = core(services)
    const u = me(ctx)
    const target = await s.environments.resolveFor(u.user, ctx.params.id)
    if (u.user.lastEnvironmentId !== target.id) await s.meta.users.update(u.user.id, { lastEnvironmentId: target.id })
    return defFor(s, u, target.id)
  }, { auth: 'user', noEnvironment: true })

  router.add('POST', '/api/v1/environments', async (ctx): Promise<EnvironmentDef> => {
    const s = core(services)
    const u = installAdmin(ctx)
    const rec = await createEnvironment(s, u, bodyObj(ctx))
    return defFor(s, u, rec.id)
  }, { auth: 'user', maxBodyMB: 1 })

  router.add('GET', '/api/v1/environments/:id', async (ctx): Promise<EnvironmentDetails> => {
    const s = core(services)
    const u = await managerOf(s, ctx, ctx.params.id)
    const e = (await s.install.environments.get(ctx.params.id))!
    const def: EnvironmentDetails = await defFor(s, u, e.id)
    const access = (await s.environments.access()).filter((a) => a.environmentId === e.id)
    def.accessCount = access.length
    if (e.state === 'ready' || e.state === 'failed') {
      const dirs = s.environments.dirs(e.id)
      const [db, att, files] = await Promise.all([s.install.schemaSizes(e.schema), folderSize(dirs.attachments), folderSize(dirs.files)])
      def.sizes = { tables: db.tables, rowEstimate: db.rowEstimate, databaseBytes: db.databaseBytes, attachmentBytes: att.bytes, attachments: att.files, files: files.files }
    }
    return def
  }, { auth: 'user', noEnvironment: true })

  router.add('PATCH', '/api/v1/environments/:id', async (ctx): Promise<EnvironmentDef> => {
    const s = core(services)
    const u = installAdmin(ctx)
    const b = bodyObj(ctx)
    const other = Object.keys(b).filter((k) => !['name', 'description', 'type', 'locked'].includes(k))
    if (other.length) throw invalid(`"${other[0]}" cannot be changed here.`, other[0])
    await updateEnvironment(s, u, ctx.params.id, b)
    return defFor(s, u, ctx.params.id)
  }, { auth: 'user' })

  router.add('DELETE', '/api/v1/environments/:id', async (ctx) => {
    const s = core(services)
    const u = installAdmin(ctx)
    const b = ctx.body === undefined ? {} : bodyObj(ctx)
    await deleteEnvironment(s, u, ctx.params.id, b.confirmName ?? ctx.query.get('confirmName'))
    return { ok: true }
  }, { auth: 'user' })

  router.add('GET', '/api/v1/environments/:id/access', async (ctx): Promise<{ items: EnvironmentAccessEntry[] }> => {
    const s = core(services)
    await managerOf(s, ctx, ctx.params.id)
    const rows = await s.install.access.forEnvironment(ctx.params.id)
    const users = new Map((await s.meta.users.list()).map((x) => [x.id, x]))
    const items: EnvironmentAccessEntry[] = []
    for (const a of rows) {
      const x = users.get(a.userId)
      if (!x) continue
      items.push({ userId: x.id, name: x.name, email: x.email, isEnvAdmin: a.isEnvAdmin, grantedOn: a.grantedOn, status: x.status ?? 'active', ...(x.isInstallAdmin ? { isInstallAdmin: true } : {}), ...(a.grantedBy ? { grantedBy: a.grantedBy } : {}) })
    }
    // install administrators enter every environment even without a row
    for (const x of users.values()) {
      if (x.isInstallAdmin && !rows.some((a) => a.userId === x.id)) items.push({ userId: x.id, name: x.name, email: x.email, isEnvAdmin: true, isInstallAdmin: true, status: x.status ?? 'active' })
    }
    items.sort((p, q) => p.name.localeCompare(q.name) || p.userId.localeCompare(q.userId))
    return { items }
  }, { auth: 'user', noEnvironment: true })

  router.add('PUT', '/api/v1/environments/:id/access/:user', async (ctx) => {
    const s = core(services)
    const u = await managerOf(s, ctx, ctx.params.id)
    const b = ctx.body === undefined ? {} : bodyObj(ctx)
    if (b.isEnvAdmin !== undefined && typeof b.isEnvAdmin !== 'boolean') throw invalid('isEnvAdmin must be true or false.', 'isEnvAdmin')
    await grantAccess(s, u, ctx.params.id, ctx.params.user, b.isEnvAdmin as boolean | undefined)
    return { ok: true }
  }, { auth: 'user', noEnvironment: true })

  router.add('DELETE', '/api/v1/environments/:id/access/:user', async (ctx) => {
    const s = core(services)
    const u = await managerOf(s, ctx, ctx.params.id)
    await revokeAccess(s, u, ctx.params.id, ctx.params.user)
    return { ok: true }
  }, { auth: 'user', noEnvironment: true })

  router.add('GET', '/api/v1/install/audit', async (ctx) => {
    const s = core(services)
    installAdmin(ctx)
    const f = auditQuery(ctx)
    const env = (ctx.query.get('environment') ?? '').trim()
    if (env.length > 40) throw invalid('"environment" is not an environment id.', 'environment')
    const [{ items, total }, actions, users] = await Promise.all([
      s.install.auditPage({ action: f.action, userId: f.userId, from: f.from, to: f.to, offset: (f.page - 1) * f.pageSize, limit: f.pageSize, ...(env ? { environmentId: env } : {}) }),
      s.install.auditActions(),
      s.meta.users.list(),
    ])
    const byId = new Map(users.map((x) => [x.id, x]))
    return {
      items: items.map((e) => {
        const x = e.userId ? byId.get(e.userId) : undefined
        return { ...e, ...(x ? { userName: x.name, userEmail: x.email } : {}) }
      }),
      total, page: f.page, pageSize: f.pageSize, actions,
    }
  }, { auth: 'user', noEnvironment: true })
}

export { installAudit }
