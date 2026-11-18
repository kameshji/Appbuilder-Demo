/** Apps: CRUD, duplicate, package export / import. Reads need app access (or maker); writes need maker. */
import type { AppMeta } from '../../../src/platform/contracts.ts'
import type { Router, Services } from '../../core/contracts.ts'
import { bodyObj, clone, conflict, denied, invalid, isObj, me, notFound, optString, reqString, uniqueLabel } from './util.ts'
import type { RoleX } from './util.ts'
import { audit, requireTable } from './tables-core.ts'
import { addApp, blankApp, checkSize, ensurePkgTables, exportAppPackage, parsePackage, readPkgApp, readPkgTables, validateDef } from './packages.ts'
import { createSampleApp } from './seed.ts'

const actorName = (ctx: { user?: { user: { name: string } } }): string => ctx.user?.user.name ?? 'Unknown'

/** removes an app from role access lists and solution components */
export async function forgetApp(s: Services, id: string): Promise<void> {
  for (const role of (await s.meta.roles.list()) as RoleX[]) {
    if (Array.isArray(role.apps) && role.apps.includes(id)) await s.meta.roles.upsert({ ...role, apps: role.apps.filter((a) => a !== id) } as RoleX)
  }
  const now = s.now()
  for (const sol of await s.meta.solutions.list()) {
    if (sol.components.some((c) => c.kind === 'app' && c.id === id)) {
      await s.meta.solutions.upsert({ ...sol, components: sol.components.filter((c) => !(c.kind === 'app' && c.id === id)), modifiedOn: now })
    }
  }
  s.security.invalidate()
}

export function registerAppRoutes(router: Router, s: Services): void {
  router.add('GET', '/api/v1/apps/:id', async (ctx) => {
    const u = me(ctx)
    const a = await s.meta.apps.get(ctx.params.id)
    if (!a) throw notFound('App not found.')
    if (!u.privileges.isAdmin && !u.privileges.isMaker && !u.canRunApp(a.meta.id)) throw denied('You do not have access to this app.')
    return { meta: a.meta, definition: a.definition }
  }, { auth: 'user' })

  router.add('POST', '/api/v1/apps', async (ctx) => {
    const b = bodyObj(ctx)
    const name = reqString(b, 'name', 'An app needs a name.', 100)
    checkSize(b.width, b.height)
    const template = b.template ?? 'blank'
    if (template !== 'blank' && template !== 'sample') throw invalid('Template must be blank or sample.', 'template')
    let meta: AppMeta
    if (template === 'sample') meta = await createSampleApp(s, actorName(ctx), name)
    else {
      const unique = uniqueLabel(name, (await s.meta.apps.list()).map((a) => a.name))
      meta = await addApp(s, actorName(ctx), blankApp(unique, b.width as number, b.height as number, () => s.uid('n')), unique)
    }
    await audit(s, ctx, 'app.create', { id: meta.id, name: meta.name, template })
    return meta
  }, { auth: 'maker' })

  router.add('PUT', '/api/v1/apps/:id', async (ctx) => {
    const cur = await s.meta.apps.get(ctx.params.id)
    if (!cur) throw notFound('App not found.')
    const def = clone(validateDef(bodyObj(ctx).definition))
    const wanted = typeof def.name === 'string' && def.name.trim() ? def.name.trim().slice(0, 100) : cur.meta.name
    if ((await s.meta.apps.list()).some((a) => a.id !== cur.meta.id && a.name.toLowerCase() === wanted.toLowerCase())) {
      throw conflict(`An app named "${wanted}" already exists.`)
    }
    const name = wanted
    def.name = name
    const meta: AppMeta = {
      ...cur.meta, name,
      width: Number.isFinite(def.width) ? def.width : cur.meta.width,
      height: Number.isFinite(def.height) ? def.height : cur.meta.height,
      modifiedOn: s.now(), modifiedBy: actorName(ctx),
    }
    await s.meta.apps.upsert(meta, def)
    return meta
  }, { auth: 'maker' })

  router.add('PATCH', '/api/v1/apps/:id', async (ctx) => {
    const cur = await s.meta.apps.get(ctx.params.id)
    if (!cur) throw notFound('App not found.')
    const name = reqString(bodyObj(ctx), 'name', 'An app needs a name.', 100)
    if ((await s.meta.apps.list()).some((a) => a.id !== cur.meta.id && a.name.toLowerCase() === name.toLowerCase())) throw conflict(`An app named "${name}" already exists.`)
    const meta: AppMeta = { ...cur.meta, name, modifiedOn: s.now(), modifiedBy: actorName(ctx) }
    await s.meta.apps.upsert(meta, { ...cur.definition, name })
    return meta
  }, { auth: 'maker' })

  router.add('POST', '/api/v1/apps/:id/duplicate', async (ctx) => {
    const cur = await s.meta.apps.get(ctx.params.id)
    if (!cur) throw notFound('App not found.')
    const meta = await addApp(s, actorName(ctx), clone(cur.definition), `${cur.meta.name} (copy)`, cur.meta.description)
    await audit(s, ctx, 'app.duplicate', { from: cur.meta.id, id: meta.id })
    return meta
  }, { auth: 'maker' })

  router.add('DELETE', '/api/v1/apps/:id', async (ctx) => {
    const cur = await s.meta.apps.get(ctx.params.id)
    if (!cur) throw notFound('App not found.')
    await s.meta.apps.remove(cur.meta.id)
    await forgetApp(s, cur.meta.id)
    await audit(s, ctx, 'app.delete', { id: cur.meta.id, name: cur.meta.name })
    return { ok: true }
  }, { auth: 'maker' })

  router.add('GET', '/api/v1/apps/:id/package', async (ctx) => {
    const yaml = await exportAppPackage(s, ctx, ctx.params.id, ctx.query.get('data') === '1')
    return { yaml }
  }, { auth: 'maker' })

  router.add('POST', '/api/v1/apps/import', async (ctx) => {
    const b = bodyObj(ctx)
    const doc = parsePackage(b.yaml, 'appbuilder/app')
    const app = readPkgApp(doc.app)
    const tables = readPkgTables(doc.tables, s.now())
    await ensurePkgTables(s, tables, ctx.user?.user.id)
    const meta = await addApp(s, actorName(ctx), app.def, app.name, app.description)
    await audit(s, ctx, 'app.import', { id: meta.id, name: meta.name })
    return meta
  }, { auth: 'maker', maxBodyMB: 25 })
}

export { isObj, optString, requireTable }
