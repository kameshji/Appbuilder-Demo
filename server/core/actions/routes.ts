/**
 * HTTP API of connector actions (docs/dev/data-api.md "Connector actions"):
 *
 *   GET    /actions/kinds                                   action-capable kinds and their built-in actions (makers)
 *   GET    /actions/connections                             connections the caller may use (flow and event designers)
 *   GET    /connections/:id/actions                         actions of a connection ("use")
 *   GET    /connections/:id/actions/:action                 one action with its schemas ("use")
 *   POST   /connections/:id/actions/:action/test            run it now with { inputs } as yourself ("use"; audited in Activity)
 *   PUT    /connections/:id/custom-actions/:action          create or change a custom action ("manage")
 *   DELETE /connections/:id/custom-actions/:action          ("manage")
 *   POST   /connections/:id/custom-actions/openapi          { text, apply?, replace?, only? } preview or import ("manage")
 *   GET    /connections/:id/access                          "use" / "manage" grants (administrators and managers)
 *   PUT    /connections/:id/access                          { grants } (administrators)
 *   GET    /connections/:id/activity?limit&before           calls (managers: all; users with "use": their own)
 *   GET    /connections/:id/state                           circuit breaker, calls in flight, limits ("use")
 *   POST   /connections/:id/state/reset                     close the breaker ("manage")
 *   GET    /admin/mail-suppressions?search&offset&limit     install administrators
 *   POST   /admin/mail-suppressions                         { address, note? }
 *   DELETE /admin/mail-suppressions/:address
 */
import type { ApiRouter } from '../router.ts'
import type { CoreServices } from '../services.ts'
import type { Ctx, UserContext } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import type { ActionsServiceImpl } from './service.ts'
import { connectionLimits } from './service.ts'
import { checkCustomAction, parseSecret } from './http.ts'
import { OpenApiError, importOpenApi } from './openapi.ts'
import { inferSchema } from './schema.ts'
import { addSuppression, listSuppressions, removeSuppression } from './suppressions.ts'
import { currentEnvironment } from '../env-context.ts'
import { errText, log } from '../util.ts'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const body = (ctx: Ctx): Record<string, unknown> => {
  if (!isObj(ctx.body)) throw new HttpError(422, 'invalid', 'The request body must be a JSON object.')
  return ctx.body
}

async function audit(s: CoreServices, ctx: Ctx, action: string, details: unknown): Promise<void> {
  try {
    await s.meta.audit({ userId: ctx.user?.user.id ?? null, action, details })
  } catch (e) {
    log('error', `audit write failed (${action}): ${errText(e)}`)
  }
}

export function actionRoutes(router: ApiRouter, s: CoreServices, svc: ActionsServiceImpl): void {
  const conn = async (id: string) => {
    const rec = await s.meta.connections.get(id)
    if (!rec) throw new HttpError(404, 'not-found', 'Connection not found.')
    return rec
  }
  const needUse = async (u: UserContext, id: string) => {
    const rec = await conn(id)
    await svc.assertCanUse(u, id)
    return rec
  }
  const needManage = async (u: UserContext, id: string) => {
    const rec = await conn(id)
    if (!(await svc.canManage(u, id))) throw new HttpError(403, 'denied', `Only administrators and people with "manage" access to "${rec.name}" can do this.`)
    return rec
  }
  const needHttp = (rec: { connector: string; name: string }) => {
    if (rec.connector !== 'http') throw new HttpError(422, 'invalid', `"${rec.name}" is not an HTTP connection; custom actions belong to HTTP connections.`)
  }

  router.add('GET', '/actions/kinds', () => ({ items: svc.kinds() }), { auth: 'maker' })

  router.add('GET', '/actions/connections', async (ctx) => {
    const u = ctx.user!
    const kinds = new Set(svc.kinds().map((k) => k.kind))
    const out = []
    for (const c of await s.meta.connections.list()) {
      if (!kinds.has(c.connector)) continue
      if (!(await svc.canUse(u, c.id))) continue
      out.push({ id: c.id, name: c.name, connector: c.connector, status: c.status, canManage: await svc.canManage(u, c.id) })
    }
    return { items: out }
  }, { auth: 'user' })

  router.add('GET', '/connections/:id/actions', async (ctx) => {
    await needUse(ctx.user!, ctx.params.id)
    return { items: await svc.list(ctx.params.id) }
  }, { auth: 'user' })

  router.add('GET', '/connections/:id/actions/:action', async (ctx) => {
    await needUse(ctx.user!, ctx.params.id)
    return svc.describe(ctx.params.id, ctx.params.action)
  }, { auth: 'user' })

  router.add('POST', '/connections/:id/actions/:action/test', async (ctx) => {
    const u = ctx.user!
    await needUse(u, ctx.params.id)
    const b = body(ctx)
    const r = await svc.run(currentEnvironment().id, ctx.params.id, ctx.params.action, b.inputs ?? {}, u, { source: 'test', ...(typeof b.idempotencyKey === 'string' ? { idempotencyKey: b.idempotencyKey } : {}) })
    return r
  }, { auth: 'user' })

  router.add('PUT', '/connections/:id/custom-actions/:action', async (ctx) => {
    const u = ctx.user!
    const rec = await needManage(u, ctx.params.id)
    needHttp(rec)
    const b = body(ctx)
    const { def, problems } = checkCustomAction({ ...b, id: b.id ?? ctx.params.action })
    if (problems.length) throw new HttpError(422, 'invalid', problems.slice(0, 5).join(' '))
    if (def.id.toLowerCase() !== ctx.params.action.toLowerCase()) {
      // a rename: the old id goes away
      const clash = await svc.custom.get(rec.id, def.id)
      if (clash) throw new HttpError(409, 'conflict', `An action "${def.id}" already exists.`)
      await svc.custom.remove(rec.id, ctx.params.action)
    }
    if (def.http.sample !== undefined && (!def.outputs || !Object.keys(def.outputs).length)) {
      def.outputs = inferSchema(def.http.outputPath ? (def.http.outputPath.split('.').reduce<unknown>((v, k) => (isObj(v) ? v[k] : Array.isArray(v) && /^\d+$/.test(k) ? v[Number(k)] : undefined), def.http.sample)) : def.http.sample)
    }
    const saved = await svc.custom.put(rec.id, def, u.user.id)
    await audit(s, ctx, 'connection.action.save', { connection: rec.id, action: def.id, method: def.http.method, path: def.http.path })
    return saved.def
  }, { auth: 'user', pass: 'full' })

  router.add('DELETE', '/connections/:id/custom-actions/:action', async (ctx) => {
    const rec = await needManage(ctx.user!, ctx.params.id)
    if (!(await svc.custom.remove(rec.id, ctx.params.action))) throw new HttpError(404, 'not-found', 'Action not found.')
    await audit(s, ctx, 'connection.action.delete', { connection: rec.id, action: ctx.params.action })
    return { ok: true }
  }, { auth: 'user', pass: 'full' })

  router.add('POST', '/connections/:id/custom-actions/openapi', async (ctx) => {
    const u = ctx.user!
    const rec = await needManage(u, ctx.params.id)
    needHttp(rec)
    const b = body(ctx)
    if (typeof b.text !== 'string' || !b.text.trim()) throw new HttpError(422, 'invalid', 'Paste or upload an OpenAPI 3 document (JSON or YAML).', 'text')
    let r
    try {
      r = importOpenApi(b.text, { source: rec.settings?.baseUrl })
    } catch (e) {
      if (e instanceof OpenApiError) throw new HttpError(422, 'invalid', e.message, 'text')
      throw e
    }
    const only = Array.isArray(b.only) ? new Set((b.only as unknown[]).map((x) => String(x).toLowerCase())) : null
    const chosen = only ? r.actions.filter((a) => only.has(a.id.toLowerCase())) : r.actions
    const existing = new Set((await svc.custom.list(rec.id)).map((c) => c.def.id.toLowerCase()))
    const preview = {
      title: r.title, version: r.version, baseUrl: r.baseUrl, auth: r.auth, warnings: r.warnings,
      actions: r.actions.map((a) => ({ id: a.id, title: a.title, method: a.http.method, path: a.http.path, sideEffect: a.sideEffect, exists: existing.has(a.id.toLowerCase()) })),
    }
    if (b.apply !== true) return { ...preview, applied: false }
    if (b.replace === true) for (const c of await svc.custom.list(rec.id)) await svc.custom.remove(rec.id, c.def.id)
    for (const a of chosen) await svc.custom.put(rec.id, a, u.user.id)
    await audit(s, ctx, 'connection.action.import', { connection: rec.id, title: r.title, count: chosen.length, replace: b.replace === true })
    return { ...preview, applied: true, imported: chosen.length }
  }, { auth: 'user', pass: 'full', maxBodyMB: 3 })

  router.add('GET', '/connections/:id/access', async (ctx) => {
    await needManage(ctx.user!, ctx.params.id)
    return { items: await svc.access.list(ctx.params.id) }
  }, { auth: 'user' })

  router.add('PUT', '/connections/:id/access', async (ctx) => {
    const rec = await conn(ctx.params.id)
    const b = body(ctx)
    if (!Array.isArray(b.grants)) throw new HttpError(422, 'invalid', '"grants" must be a list.', 'grants')
    const roles = new Set((await s.meta.roles.list()).map((r) => r.id))
    const grants: { principalKind: 'role' | 'user'; principalId: string; level: 'use' | 'manage' }[] = []
    for (const g of b.grants.slice(0, 500)) {
      if (!isObj(g) || (g.principalKind !== 'role' && g.principalKind !== 'user') || typeof g.principalId !== 'string' || (g.level !== 'use' && g.level !== 'manage')) {
        throw new HttpError(422, 'invalid', 'Each grant has principalKind (role or user), principalId and level (use or manage).', 'grants')
      }
      if (g.principalKind === 'role' && !roles.has(g.principalId)) throw new HttpError(422, 'invalid', `There is no role "${g.principalId}".`, 'grants')
      if (g.principalKind === 'user' && !(await s.meta.users.get(g.principalId))) throw new HttpError(422, 'invalid', `There is no user "${g.principalId}".`, 'grants')
      grants.push({ principalKind: g.principalKind, principalId: g.principalId, level: g.level })
    }
    await svc.access.set(rec.id, grants, ctx.user!.user.id)
    await audit(s, ctx, 'connection.access', { connection: rec.id, name: rec.name, grants })
    return { items: await svc.access.list(rec.id) }
  }, { auth: 'admin' })

  router.add('GET', '/connections/:id/activity', async (ctx) => {
    const u = ctx.user!
    const rec = await needUse(u, ctx.params.id)
    const manage = await svc.canManage(u, rec.id)
    const before = ctx.query.get('before') ?? undefined
    if (before && Number.isNaN(Date.parse(before))) throw new HttpError(422, 'invalid', 'before must be a time.', 'before')
    return { items: await svc.activity(rec.id, { limit: Number(ctx.query.get('limit') ?? 50) || 50, before, ...(manage ? {} : { userId: u.user.id }) }), all: manage }
  }, { auth: 'user' })

  router.add('GET', '/connections/:id/state', async (ctx) => {
    const rec = await needUse(ctx.user!, ctx.params.id)
    const st = svc.state(currentEnvironment().id, rec.id)
    const lim = connectionLimits(svc, rec)
    const sec = parseSecret(rec)
    return {
      ...st, ...(lim ? { perMinute: lim.perMinute, maxConcurrent: lim.maxConcurrent, maxTimeoutMs: lim.maxTimeoutMs } : {}),
      // which secret parts are set (never their values)
      secretParts: Object.entries(sec).filter(([, v]) => v !== undefined && v !== '' && !(isObj(v) && !Object.keys(v).length)).map(([k, v]) => (k === 'headers' && isObj(v) ? Object.keys(v).map((h) => `header:${h}`) : [k])).flat(),
    }
  }, { auth: 'user' })

  router.add('POST', '/connections/:id/state/reset', async (ctx) => {
    const rec = await needManage(ctx.user!, ctx.params.id)
    svc.resetCircuit(currentEnvironment().id, rec.id)
    await audit(s, ctx, 'connection.circuit_reset', { connection: rec.id })
    return svc.state(currentEnvironment().id, rec.id)
  }, { auth: 'user' })

  /* ---------------------------------------------------------------- suppression list (install administrators) */

  const installAdmin = (ctx: Ctx) => {
    if (!ctx.user?.user.isInstallAdmin) throw new HttpError(403, 'denied', 'Only install administrators can change the mail suppression list.')
  }
  const db = () => {
    const d = s.state.db
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }
  router.add('GET', '/admin/mail-suppressions', async (ctx) => {
    installAdmin(ctx)
    return listSuppressions(db(), { search: ctx.query.get('search') ?? undefined, limit: Number(ctx.query.get('limit') ?? 100) || 100, offset: Number(ctx.query.get('offset') ?? 0) || 0 })
  }, { auth: 'admin', noEnvironment: true })
  router.add('POST', '/admin/mail-suppressions', async (ctx) => {
    installAdmin(ctx)
    const b = body(ctx)
    await addSuppression(db(), String(b.address ?? ''), 'manual', ctx.user!.user.id, typeof b.note === 'string' ? b.note : undefined)
    await audit(s, ctx, 'mail.suppression.add', { address: String(b.address ?? '').toLowerCase() })
    return { ok: true }
  }, { auth: 'admin', noEnvironment: true })
  router.add('DELETE', '/admin/mail-suppressions/:address', async (ctx) => {
    installAdmin(ctx)
    if (!(await removeSuppression(db(), ctx.params.address))) throw new HttpError(404, 'not-found', 'That address is not on the list.')
    await audit(s, ctx, 'mail.suppression.remove', { address: ctx.params.address.toLowerCase() })
    return { ok: true }
  }, { auth: 'admin', noEnvironment: true })
}
