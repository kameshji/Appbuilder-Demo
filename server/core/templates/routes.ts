/**
 * Templates catalogue API (P2 package D; docs/dev/templates.md, docs/dev/data-api.md is not changed: the routes are
 * listed here and in docs/dev/templates.md). Makers; installs, uninstalls and upgrades are design routes (a locked
 * production environment refuses them: install in a sandbox, then Deploy). Administrators where the rules say so
 * (roles, run-as-system events, deleting tables with data, upgrading in place). Every change is audited.
 *
 *   GET  /templates                                   the catalogue (newest version of each template)
 *   GET  /templates/installed                         the installed-templates register of this environment
 *   GET  /templates/:id                               one template: what it contains and needs, default bindings
 *   POST /templates/:id/plan                          dry run: binding report + the plan (same shape as a solution import)
 *   POST /templates/:id/install                       { ...plan request, confirm: token, approveSystem?, proceedWithoutBackup? }
 *   POST /templates/installed/:iid/uninstall/plan     { deleteTables? }
 *   POST /templates/installed/:iid/uninstall          { confirm, deleteTables?, confirmText?, proceedWithoutBackup? }
 *   POST /templates/installed/:iid/upgrade/plan       Linked: { choices?: { 'app:<id>' | 'table:<id>': 'keep' | 'replace' } }
 *   POST /templates/installed/:iid/upgrade            { confirm, choices?, proceedWithoutBackup? }
 */
import type { Ctx, Router, Services } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import type { SlotBinding, TemplateUseRequest } from '../../../src/templates/format.ts'
import { describeTemplate, installTemplate, listCatalogue, listInstalls, planTemplate, planUninstall, planUpgrade, uninstallTemplate, upgradeTemplate } from './service.ts'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const body = (ctx: Ctx): Record<string, unknown> => (isObj(ctx.body) ? ctx.body : {})
const bad = (m: string, field?: string) => new HttpError(422, 'invalid', m, field)

/** the use request from a body, shape-checked (the service checks the content) */
export function readUseRequest(b: Record<string, unknown>): TemplateUseRequest {
  const out: TemplateUseRequest = {}
  if (b.mode !== undefined) {
    if (b.mode !== 'copy' && b.mode !== 'linked') throw bad('mode is copy or linked.', 'mode')
    out.mode = b.mode
  }
  if (b.bindings !== undefined) {
    if (!isObj(b.bindings)) throw bad('bindings maps slots to { mode: create | map | skip, ... }.', 'bindings')
    const bindings: Record<string, SlotBinding> = {}
    for (const [k, v] of Object.entries(b.bindings).slice(0, 50)) {
      if (!isObj(v)) throw bad(`The binding of ${k.slice(0, 40)} is malformed.`, 'bindings')
      if (v.mode === 'skip') bindings[k] = { mode: 'skip' }
      else if (v.mode === 'create') bindings[k] = { mode: 'create', name: String(v.name ?? '').slice(0, 64), ...(typeof v.displayName === 'string' ? { displayName: v.displayName.slice(0, 120) } : {}) }
      else if (v.mode === 'map') {
        const columns: Record<string, string | null> = {}
        if (isObj(v.columns)) for (const [c, n] of Object.entries(v.columns).slice(0, 200)) columns[c] = typeof n === 'string' && n ? n.slice(0, 64) : null
        bindings[k] = { mode: 'map', table: String(v.table ?? '').slice(0, 80), columns }
      } else throw bad(`The binding of ${k.slice(0, 40)} needs mode create, map or skip.`, 'bindings')
    }
    out.bindings = bindings
  }
  if (b.appName !== undefined) out.appName = String(b.appName).slice(0, 100)
  if (b.sample === true) out.sample = true
  if (b.approveSystem === true) out.approveSystem = true
  if (b.proceedWithoutBackup === true) out.proceedWithoutBackup = true
  if (typeof b.confirm === 'string') out.confirm = b.confirm
  if (isObj(b.target)) {
    const t = b.target
    out.target = {
      ...(typeof t.appId === 'string' ? { appId: t.appId.slice(0, 80) } : {}), ...(typeof t.appName === 'string' ? { appName: t.appName.slice(0, 100) } : {}),
      ...(typeof t.screenName === 'string' ? { screenName: t.screenName.slice(0, 100) } : {}),
      ...(Array.isArray(t.takenNames) ? { takenNames: t.takenNames.filter((x): x is string => typeof x === 'string').slice(0, 5000) } : {}),
    }
  }
  return out
}

const choicesOf = (v: unknown): Record<string, 'keep' | 'replace'> => {
  const out: Record<string, 'keep' | 'replace'> = {}
  if (isObj(v)) for (const [k, c] of Object.entries(v).slice(0, 500)) if (c === 'keep' || c === 'replace') out[k.slice(0, 100)] = c
  return out
}

export function templateRoutes(router: Router, s: Services): void {
  router.add('GET', '/api/v1/templates', async () => ({ items: listCatalogue() }), { auth: 'maker' })
  router.add('GET', '/api/v1/templates/installed', async () => ({ items: await listInstalls(s) }), { auth: 'maker' })
  router.add('GET', '/api/v1/templates/:id', async (ctx) => describeTemplate(s, ctx.params.id), { auth: 'maker' })
  router.add('POST', '/api/v1/templates/:id/plan', async (ctx) => (await planTemplate(s, ctx, ctx.params.id, readUseRequest(body(ctx)))).response, { auth: 'maker' })
  router.add('POST', '/api/v1/templates/:id/install', async (ctx) => installTemplate(s, ctx, ctx.params.id, readUseRequest(body(ctx))), { auth: 'maker', design: true })
  router.add('POST', '/api/v1/templates/installed/:iid/uninstall/plan', async (ctx) => planUninstall(s, ctx, ctx.params.iid, body(ctx).deleteTables === true), { auth: 'maker' })
  router.add('POST', '/api/v1/templates/installed/:iid/uninstall', async (ctx) => {
    const b = body(ctx)
    return uninstallTemplate(s, ctx, ctx.params.iid, { confirm: b.confirm, deleteTables: b.deleteTables === true, confirmText: b.confirmText, proceedWithoutBackup: b.proceedWithoutBackup === true })
  }, { auth: 'maker', design: true })
  router.add('POST', '/api/v1/templates/installed/:iid/upgrade/plan', async (ctx) => planUpgrade(s, ctx, ctx.params.iid, choicesOf(body(ctx).choices)), { auth: 'maker' })
  router.add('POST', '/api/v1/templates/installed/:iid/upgrade', async (ctx) => {
    const b = body(ctx)
    return upgradeTemplate(s, ctx, ctx.params.iid, { confirm: b.confirm, choices: choicesOf(b.choices), proceedWithoutBackup: b.proceedWithoutBackup === true })
  }, { auth: 'maker', design: true })
}
