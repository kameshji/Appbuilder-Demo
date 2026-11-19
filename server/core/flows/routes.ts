/**
 * HTTP API of flows (docs/dev/data-api.md "Flows"). Makers create and edit their own flows; administrators all of them.
 *
 *   GET    /flows                         list with status and health        POST /flows            create
 *   GET    /flows/catalog                 step kinds, trigger types, limits  POST /flows/validate   { flow, connections? } -> { problems }
 *   GET    /flows/:id                     definition                         PUT  /flows/:id        save a new version
 *   DELETE /flows/:id                     (active runs are cancelled)
 *   POST   /flows/:id/enable | /disable   GET  /flows/:id/versions           GET /flows/:id/versions/:v
 *   POST   /flows/:id/versions/:v/restore
 *   POST   /flows/:id/run                 { inputs, runId?, wait?, timeoutSeconds?, source? }  (manual trigger; run permission)
 *   POST   /flows/run                     { flow: name or id, ... } (RunFlow() in apps)
 *   POST   /flows/:id/test                { trigger?, inputs?, dryRun = true, definition?, approvalOutcome? }
 *   GET    /flows/:id/permissions         PUT /flows/:id/permissions { roleIds }   (who may run it)
 *   GET    /flows/:id/draft               PUT /flows/:id/draft { flow, connections, baseVersion }   DELETE /flows/:id/draft
 *                                        (the designer's unpublished draft; saving a version clears it unless keepDraft)
 *   POST   /flows/schedule-preview        { cron? | everyMinutes?, timeZone } -> { next: ISO[5], description } (designer)
 *   GET    /flows/runs?flowId=&status=&mode=&before=&limit=
 *   GET    /flows/runs/:runId             detail (owner, administrators); summary for the person who started it
 *   POST   /flows/runs/:runId/cancel      POST /flows/runs/:runId/resubmit { from: 'start' | 'failed' }
 * Administrators:
 *   GET/PUT /flows/settings               { paused } (kill switch)    GET/PUT /flows/permissions/all { roleIds }
 * Other systems:
 *   POST   /flows/callback/:env/:run/:key/:token   (waitForCallback; the token is the authority)
 */
import { HttpError } from '../contracts.ts'
import type { Ctx, UserContext } from '../contracts.ts'
import type { ApiRouter } from '../router.ts'
import type { CoreServices } from '../services.ts'
import { DEFAULT_SETTINGS, type FlowDef, type FlowRunDetail, type FlowStepRun, type FlowWaitInfo, type RunAs, type RunStatus, type ValidationProblem } from '../../../src/platform/flows.ts'
import { errText, log } from '../util.ts'
import { runInEnvironment } from '../env-context.ts'
import { T, docOf, type FlowDoc } from './store.ts'
import { isRunTerminal, toRunInfo } from './engine.ts'
import { fromStored, fxToJson } from './values.ts'
import { CronError, checkTimeZone, describeCron, nextCron, parseCron } from '../cron.ts'

type Row = Record<string, unknown>

function body(ctx: Ctx): Record<string, unknown> {
  const b = ctx.body
  if (b === undefined || b === null) return {}
  if (typeof b !== 'object' || Array.isArray(b)) throw new HttpError(422, 'invalid', 'Request body must be a JSON object.')
  return b as Record<string, unknown>
}

async function audit(s: CoreServices, ctx: Ctx | null, action: string, details: unknown): Promise<void> {
  try {
    await s.meta.audit({ userId: ctx?.user?.user.id ?? null, action, details })
  } catch (e) {
    log('error', `audit write failed (${action}): ${errText(e)}`)
  }
}

const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : v ? new Date(String(v)).toISOString() : undefined)
const parseJ = <X>(v: unknown, d: X): X => (v === null || v === undefined ? d : v as X)

/** the editable document from a request body (missing members come from the current flow) */
function docFrom(b: Record<string, unknown>, cur: FlowDef | null): FlowDoc {
  const src = (b.flow && typeof b.flow === 'object' ? b.flow : b) as Record<string, unknown>
  const pick = <K extends keyof FlowDoc>(k: K): FlowDoc[K] => (src[k] !== undefined ? src[k] as FlowDoc[K] : cur ? docOf(cur)[k] : undefined as never)
  const settings = { ...DEFAULT_SETTINGS, ...(cur?.settings ?? {}), ...((src.settings && typeof src.settings === 'object') ? src.settings as object : {}) }
  const doc: FlowDoc = {
    name: typeof src.name === 'string' ? src.name.trim() : (cur?.name ?? ''),
    runAs: (src.runAs ?? cur?.runAs ?? 'owner') as RunAs,
    trigger: pick('trigger'), steps: pick('steps') ?? [], settings,
  }
  const description = src.description !== undefined ? src.description : cur?.description
  if (typeof description === 'string' && description) doc.description = description
  const variables = pick('variables')
  if (variables !== undefined) doc.variables = variables
  return doc
}

/** connections from a request: { ref: connectionId } or [{ ref, connectionId }] */
function connectionsFrom(v: unknown, cur: FlowDef | null): { ref: string; connectionId: string }[] {
  if (v === undefined) return (cur?.connections ?? []).map((c) => ({ ref: c.ref, connectionId: c.connectionId }))
  const out: { ref: string; connectionId: string }[] = []
  if (Array.isArray(v)) for (const x of v) {
    if (!x || typeof x !== 'object' || typeof (x as Row).ref !== 'string' || typeof (x as Row).connectionId !== 'string') throw new HttpError(422, 'invalid', 'connections must be a list of { ref, connectionId }.', 'connections')
    out.push({ ref: String((x as Row).ref), connectionId: String((x as Row).connectionId) })
  }
  else if (v && typeof v === 'object') for (const [ref, id] of Object.entries(v)) {
    if (typeof id !== 'string') throw new HttpError(422, 'invalid', 'connections must map a reference name to a connection id.', 'connections')
    out.push({ ref, connectionId: id })
  }
  else throw new HttpError(422, 'invalid', 'connections must map a reference name to a connection id.', 'connections')
  for (const c of out) if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(c.ref)) throw new HttpError(422, 'invalid', `"${c.ref}" is not a valid connection reference name.`, 'connections')
  if (new Set(out.map((c) => c.ref)).size !== out.length) throw new HttpError(422, 'invalid', 'A connection reference name is used twice.', 'connections')
  return out
}

const sameRunAs = (a: RunAs | undefined, b: RunAs | undefined): boolean => JSON.stringify(a ?? 'owner') === JSON.stringify(b ?? 'owner')
const isService = (r: RunAs | undefined): r is { serviceAccount: string } => !!r && typeof r === 'object'

export function flowRoutes(router: ApiRouter, s: CoreServices): void {
  const f = () => s.flows
  const me = (ctx: Ctx): UserContext => ctx.user!

  async function need(ctx: Ctx, id: string): Promise<FlowDef> {
    const fl = await f().store.get(id)
    if (!fl) throw new HttpError(404, 'not-found', 'Flow not found.')
    void ctx
    return fl
  }
  async function needEdit(ctx: Ctx, id: string): Promise<FlowDef> {
    const fl = await need(ctx, id)
    if (!f().canEdit(me(ctx), fl)) throw new HttpError(403, 'denied', 'Only the owner of this flow or an administrator can change it.')
    if (isService(fl.runAs) && !me(ctx).privileges.isAdmin) throw new HttpError(403, 'denied', 'This flow runs as a service account; only an administrator can change it.')
    return fl
  }
  const canView = (ctx: Ctx, flowOwner: string | null): boolean => me(ctx).privileges.isAdmin || flowOwner === me(ctx).user.id

  /** connection references with their kind; new or changed ones need the saver's right to attach them */
  async function checkConnections(ctx: Ctx, wanted: { ref: string; connectionId: string }[], cur: FlowDef | null): Promise<{ ref: string; connectionId: string; connector: string }[]> {
    const out: { ref: string; connectionId: string; connector: string }[] = []
    for (const w of wanted) {
      const prev = cur?.connections.find((c) => c.ref === w.ref)
      if (!prev || prev.connectionId !== w.connectionId) await f().assertCanAttach(me(ctx), w.connectionId)
      const c = await s.meta.connections.get(w.connectionId)
      if (!c) throw new HttpError(422, 'invalid', `There is no connection ${w.connectionId}.`, 'connections')
      out.push({ ...w, connector: c.connector })
    }
    return out
  }

  async function checkRunAs(ctx: Ctx, doc: FlowDoc, cur: FlowDef | null): Promise<void> {
    const admin = me(ctx).privileges.isAdmin
    if ((isService(doc.runAs) || isService(cur?.runAs)) && !sameRunAs(doc.runAs, cur?.runAs) && !admin) {
      throw new HttpError(403, 'denied', 'Only an administrator can make a flow run as a service account, or change one that does.', 'runAs')
    }
    if (isService(doc.runAs)) {
      const u = await s.meta.users.get(doc.runAs.serviceAccount)
      if (!u || u.kind !== 'service') throw new HttpError(422, 'invalid', 'runAs.serviceAccount must be the id of a service account.', 'runAs')
      if (u.status === 'disabled') throw new HttpError(422, 'invalid', `The service account ${u.name} is disabled.`, 'runAs')
    }
  }

  async function save(ctx: Ctx, id: string | null): Promise<{ flow: FlowDef; problems: ValidationProblem[] }> {
    const b = body(ctx)
    const u = me(ctx)
    const cur = id ? await needEdit(ctx, id) : null
    const doc = docFrom(b, cur)
    await checkRunAs(ctx, doc, cur)
    let ownerId = cur?.ownerId ?? u.user.id
    let ownerChanged = false
    if (b.ownerId !== undefined && b.ownerId !== ownerId) {
      if (!u.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only an administrator can give a flow to another owner.', 'ownerId')
      const o = await s.meta.users.get(String(b.ownerId))
      if (!o || o.status === 'disabled') throw new HttpError(422, 'invalid', 'The new owner must be an active user.', 'ownerId')
      ownerId = o.id
      ownerChanged = !!cur
    }
    const runAsChanged = cur ? !sameRunAs(cur.runAs, doc.runAs) : isService(doc.runAs)
    // a change of identity is confirmed explicitly (the designer asks: "runs will act as ...")
    if ((runAsChanged || ownerChanged) && b.confirmRunAs !== true) {
      throw new HttpError(409, 'conflict', `${ownerChanged ? 'The owner changes' : 'The flow will run as another identity'}: runs then read and write with ${isService(doc.runAs) ? 'the service account\'s' : doc.runAs === 'triggeringUser' ? 'the rights of the person who triggers them' : 'the owner\'s'} rights. Confirm the change.`, 'confirmRunAs')
    }
    const conns = await checkConnections(ctx, connectionsFrom(b.connections, cur), cur)
    const problems = await f().validate(doc, cur?.id ?? null, conns)
    const errors = problems.filter((p) => p.severity === 'error')
    if (errors.length) throw new HttpError(422, 'invalid', `The flow has ${errors.length} problem${errors.length === 1 ? '' : 's'}: ${errors[0].step ? `step ${errors[0].step}, ` : ''}${errors[0].field ? `${errors[0].field}: ` : ''}${errors[0].message}`, errors[0].field || undefined, { problems })
    const enabled = b.enabled !== undefined ? b.enabled === true : (cur?.enabled ?? false)
    const flowId = cur?.id ?? s.uid('flow')
    await s.transaction(async () => {
      if (!cur) await f().store.insert({ id: flowId, doc, ownerId, enabled, by: u.user.id, ...(typeof b.note === 'string' ? { note: b.note } : {}) })
      else {
        await f().store.saveVersion(flowId, doc, u.user.id, { ...(ownerChanged ? { ownerId } : {}), ...(typeof b.note === 'string' ? { note: b.note } : {}) })
        if (b.enabled !== undefined) await f().store.setEnabled(flowId, enabled, u.user.id)
      }
      await f().store.setConnections(flowId, conns.map((c) => ({ ...c, grantedBy: u.user.id })))
      // the designer's draft is published by this save (package B)
      if (cur && b.keepDraft !== true) await f().store.setDraft(flowId, null, null)
      const saved = (await f().store.get(flowId))!
      await f().syncSchedule(saved)
    })
    f().invalidate()
    const saved = (await f().store.get(flowId))!
    await audit(s, ctx, cur ? 'flow.update' : 'flow.create', { flow: flowId, name: saved.name, version: saved.version, trigger: saved.trigger?.type, enabled: saved.enabled, runAs: saved.runAs })
    if (runAsChanged) await audit(s, ctx, 'flow.run_as_changed', { flow: flowId, name: saved.name, from: cur?.runAs ?? null, to: saved.runAs })
    if (isService(saved.runAs) && (runAsChanged || !cur)) await audit(s, ctx, 'flow.run_as_service', { flow: flowId, name: saved.name, serviceAccount: saved.runAs.serviceAccount })
    if (ownerChanged) await audit(s, ctx, 'flow.owner_changed', { flow: flowId, name: saved.name, from: cur?.ownerId, to: ownerId })
    for (const c of conns) {
      const prev = cur?.connections.find((x) => x.ref === c.ref)
      if (!prev || prev.connectionId !== c.connectionId) await audit(s, ctx, 'flow.connection_granted', { flow: flowId, ref: c.ref, connection: c.connectionId })
    }
    return { flow: saved, problems }
  }

  /* ---------------------------------------------------------------- definitions */

  router.add('GET', '/flows', async (ctx) => ({ items: await f().listItems(me(ctx)), settings: await f().store.settings() }), { auth: 'maker' })
  // approvals: whether an approvals service is registered (package C); the designer marks the approval step without one
  router.add('GET', '/flows/catalog', async () => ({ ...f().catalog(), approvals: !!f().approvals() }), { auth: 'user' })
  router.add('POST', '/flows/schedule-preview', async (ctx) => {
    const b = body(ctx)
    const tz = typeof b.timeZone === 'string' && b.timeZone ? b.timeZone : 'UTC'
    try { checkTimeZone(tz) } catch (e) { return { next: [], error: (e as Error).message } }
    const now = new Date()
    const next: string[] = []
    if (typeof b.cron === 'string' && b.cron.trim()) {
      let spec
      try { spec = parseCron(b.cron.trim()) } catch (e) { return { next: [], error: e instanceof CronError ? e.message : 'The cron expression is not valid.' } }
      let t: Date | null = now
      for (let i = 0; i < 5 && t; i++) { t = nextCron(spec, t, tz); if (t) next.push(t.toISOString()) }
      return { next, description: describeCron(b.cron.trim()) }
    }
    const every = Number(b.everyMinutes)
    if (!Number.isInteger(every) || every < 1) return { next: [], error: 'everyMinutes must be a whole number of at least 1.' }
    for (let i = 1; i <= 5; i++) next.push(new Date(now.getTime() + Math.max(60, every * 60) * 1000 * i).toISOString())
    return { next, description: `every ${every} minute${every === 1 ? '' : 's'} from when the flow is turned on` }
  }, { auth: 'maker' })
  router.add('POST', '/flows', (ctx) => save(ctx, null), { auth: 'maker', design: true, maxBodyMB: 4 })
  router.add('PUT', '/flows/:id', (ctx) => save(ctx, ctx.params.id), { auth: 'maker', design: true, maxBodyMB: 4 })
  router.add('GET', '/flows/:id', async (ctx) => {
    const fl = await need(ctx, ctx.params.id)
    return { flow: fl, canEdit: f().canEdit(me(ctx), fl), canRun: fl.trigger?.type === 'manual' && (await f().canRun(me(ctx), fl)) }
  }, { auth: 'maker' })

  router.add('POST', '/flows/validate', async (ctx) => {
    const b = body(ctx)
    const id = typeof b.id === 'string' ? b.id : null
    const cur = id ? await f().store.get(id) : null
    const doc = docFrom(b, cur)
    const conns = []
    for (const c of connectionsFrom(b.connections, cur)) {
      const rec = await s.meta.connections.get(c.connectionId)
      conns.push({ ...c, connector: rec?.connector ?? '' })
    }
    return { problems: await f().validate(doc, cur?.id ?? null, conns) }
  }, { auth: 'maker', maxBodyMB: 4 })

  router.add('DELETE', '/flows/:id', async (ctx) => {
    const fl = await needEdit(ctx, ctx.params.id)
    const active = await s.state.db!.query<Row>(`SELECT id FROM ${T('ab_flow_runs')} WHERE flow_id = $1 AND state IN ('queued', 'running', 'waiting')`, [fl.id])
    for (const r of active) await f().engine.cancelRun(String(r.id), me(ctx).user.id)
    await s.transaction(async () => {
      await f().syncSchedule({ ...fl, enabled: false })
      await f().store.remove(fl.id)
    })
    f().invalidate()
    await audit(s, ctx, 'flow.delete', { flow: fl.id, name: fl.name, cancelledRuns: active.length })
    return { ok: true, cancelledRuns: active.length }
  }, { auth: 'maker', design: true })

  const toggle = async (ctx: Ctx, enabled: boolean) => {
    const fl = await needEdit(ctx, ctx.params.id)
    // a locked environment: flows change only by solution deploy; administrators may still switch one off or on
    if (s.environments && (await s.environments.isLocked(ctx.environmentId)) && !me(ctx).privileges.isAdmin) throw new HttpError(403, 'denied', 'This environment is locked: only an administrator can turn flows on or off here.')
    if (enabled) {
      const problems = (await f().validate(docOf(fl), fl.id, fl.connections.map((c) => ({ ref: c.ref, connectionId: c.connectionId, connector: c.connector ?? '' })))).filter((p) => p.severity === 'error')
      if (problems.length) throw new HttpError(422, 'invalid', `The flow cannot be turned on: ${problems[0].message}`, problems[0].field || undefined, { problems })
      const owner = await s.meta.users.get(fl.ownerId)
      if (!owner || owner.status === 'disabled') throw new HttpError(409, 'conflict', 'The owner of this flow is disabled: an administrator must give it a new owner first.')
    }
    await s.transaction(async () => {
      await f().store.setEnabled(fl.id, enabled, me(ctx).user.id)
      await f().syncSchedule({ ...fl, enabled, suspended: enabled ? undefined : fl.suspended })
    })
    f().invalidate()
    await audit(s, ctx, enabled ? 'flow.enable' : 'flow.disable', { flow: fl.id, name: fl.name })
    return { flow: await f().store.get(fl.id) }
  }
  router.add('POST', '/flows/:id/enable', (ctx) => toggle(ctx, true), { auth: 'maker' })
  router.add('POST', '/flows/:id/disable', (ctx) => toggle(ctx, false), { auth: 'maker' })

  router.add('GET', '/flows/:id/versions', async (ctx) => {
    const fl = await need(ctx, ctx.params.id)
    return { items: await f().store.versions(fl.id), current: fl.version }
  }, { auth: 'maker' })
  router.add('GET', '/flows/:id/versions/:v', async (ctx) => {
    const fl = await need(ctx, ctx.params.id)
    const d = await f().store.versionDoc(fl.id, Number(ctx.params.v))
    if (!d) throw new HttpError(404, 'not-found', 'Version not found.')
    return { version: Number(ctx.params.v), doc: d }
  }, { auth: 'maker' })
  router.add('POST', '/flows/:id/versions/:v/restore', async (ctx) => {
    const fl = await needEdit(ctx, ctx.params.id)
    const d = await f().store.versionDoc(fl.id, Number(ctx.params.v))
    if (!d) throw new HttpError(404, 'not-found', 'Version not found.')
    ctx.body = { flow: d, note: `restored version ${ctx.params.v}`, confirmRunAs: body(ctx).confirmRunAs === true }
    const out = await save(ctx, fl.id)
    await audit(s, ctx, 'flow.restore', { flow: fl.id, name: fl.name, from: Number(ctx.params.v), version: out.flow.version })
    return out
  }, { auth: 'maker', design: true })

  /* ---------------------------------------------------------------- the designer's draft (package B) */

  router.add('GET', '/flows/:id/draft', async (ctx) => {
    const fl = await need(ctx, ctx.params.id)
    return { draft: f().canEdit(me(ctx), fl) ? await f().store.draft(fl.id) : null }
  }, { auth: 'maker' })
  router.add('PUT', '/flows/:id/draft', async (ctx) => {
    const fl = await needEdit(ctx, ctx.params.id)
    const b = body(ctx)
    if (!b.flow || typeof b.flow !== 'object' || Array.isArray(b.flow)) throw new HttpError(422, 'invalid', 'The draft needs the flow definition (flow).', 'flow')
    const doc = docFrom(b, fl)
    const conns = connectionsFrom(b.connections, fl)
    // a new or changed connection reference needs the right to use it: said now, not only at publish
    for (const c of conns) {
      const prev = fl.connections.find((x) => x.ref === c.ref)
      if (!prev || prev.connectionId !== c.connectionId) await f().assertCanAttach(me(ctx), c.connectionId)
    }
    const baseVersion = Number.isInteger(b.baseVersion) ? Number(b.baseVersion) : fl.version
    await f().store.setDraft(fl.id, { doc, connections: Object.fromEntries(conns.map((c) => [c.ref, c.connectionId])), baseVersion }, me(ctx).user.id)
    return { draft: await f().store.draft(fl.id) }
  }, { auth: 'maker', design: true, maxBodyMB: 4 })
  router.add('DELETE', '/flows/:id/draft', async (ctx) => {
    const fl = await needEdit(ctx, ctx.params.id)
    await f().store.setDraft(fl.id, null, null)
    return { ok: true }
  }, { auth: 'maker', design: true })

  /* ---------------------------------------------------------------- run permissions */

  router.add('GET', '/flows/:id/permissions', async (ctx) => {
    const fl = await need(ctx, ctx.params.id)
    return { roleIds: await f().store.grants(fl.id) }
  }, { auth: 'maker' })
  router.add('PUT', '/flows/:id/permissions', async (ctx) => {
    const fl = await needEdit(ctx, ctx.params.id)
    const ids = roleIds(body(ctx))
    const roles = await s.meta.roles.list()
    for (const r of ids) if (!roles.some((x) => x.id === r)) throw new HttpError(422, 'invalid', `There is no role ${r}.`, 'roleIds')
    await f().store.setGrants(fl.id, ids, me(ctx).user.id)
    await audit(s, ctx, 'flow.permissions', { flow: fl.id, name: fl.name, roleIds: ids })
    return { roleIds: ids }
  }, { auth: 'maker', design: true })
  router.add('GET', '/flows/permissions/all', async () => ({ roleIds: await f().store.grants('*') }), { auth: 'admin' })
  router.add('PUT', '/flows/permissions/all', async (ctx) => {
    const ids = roleIds(body(ctx))
    await f().store.setGrants('*', ids, me(ctx).user.id)
    await audit(s, ctx, 'flow.permissions', { flow: '*', roleIds: ids })
    return { roleIds: ids }
  }, { auth: 'admin', design: true })
  const roleIds = (b: Record<string, unknown>): string[] => {
    if (!Array.isArray(b.roleIds) || !b.roleIds.every((x) => typeof x === 'string')) throw new HttpError(422, 'invalid', 'roleIds must be a list of role ids.', 'roleIds')
    return b.roleIds as string[]
  }

  /* ---------------------------------------------------------------- settings (kill switch) */

  router.add('GET', '/flows/settings', async () => f().store.settings(), { auth: 'maker' })
  router.add('PUT', '/flows/settings', async (ctx) => {
    const b = body(ctx)
    if (b.paused !== undefined) {
      if (typeof b.paused !== 'boolean') throw new HttpError(422, 'invalid', 'paused must be true or false.', 'paused')
      await f().store.setSetting('paused', b.paused, me(ctx).user.id)
      await audit(s, ctx, b.paused ? 'flows.paused' : 'flows.resumed', {})
    }
    if (b.environmentRunsPerMinute !== undefined) {
      const n = Number(b.environmentRunsPerMinute)
      if (!Number.isInteger(n) || n < 1 || n > 100_000) throw new HttpError(422, 'invalid', 'environmentRunsPerMinute must be from 1 to 100000.', 'environmentRunsPerMinute')
      await f().store.setSetting('environmentRunsPerMinute', n, me(ctx).user.id)
      await audit(s, ctx, 'flows.settings', { environmentRunsPerMinute: n })
    }
    return f().store.settings()
  }, { auth: 'admin' })

  /* ---------------------------------------------------------------- running */

  const runHandler = async (ctx: Ctx, fl: FlowDef) => {
    const b = body(ctx)
    const inputs = (b.inputs && typeof b.inputs === 'object' && !Array.isArray(b.inputs) ? b.inputs : {}) as Record<string, unknown>
    const source = (['app', 'record', 'portal', 'api'] as const).find((x) => x === b.source) ?? 'api'
    const r = await f().runManual(me(ctx), fl, inputs, { ...(typeof b.runId === 'string' ? { runId: b.runId } : {}), source })
    if (r.created) await audit(s, ctx, 'flow.run', { flow: fl.id, name: fl.name, run: r.id, source })
    if (b.wait === true) {
      const w = await f().waitForResponse(r.id, Number(b.timeoutSeconds) || 10)
      return { runId: r.id, ...w }
    }
    return { runId: r.id, status: 'queued' as RunStatus }
  }
  router.add('POST', '/flows/:id/run', async (ctx) => runHandler(ctx, await need(ctx, ctx.params.id)), { auth: 'user' })
  router.add('POST', '/flows/run', async (ctx) => {
    const b = body(ctx)
    if (typeof b.flow !== 'string' || !b.flow) throw new HttpError(422, 'invalid', 'Name the flow to run.', 'flow')
    const fl = await f().store.resolve(b.flow)
    if (!fl) throw new HttpError(404, 'not-found', `There is no flow "${b.flow}".`)
    return runHandler(ctx, fl)
  }, { auth: 'user' })

  router.add('POST', '/flows/:id/test', async (ctx) => {
    const fl = await needEdit(ctx, ctx.params.id)
    const b = body(ctx)
    const dryRun = b.dryRun !== false
    let doc: FlowDoc | undefined
    if (b.definition !== undefined) {
      doc = docFrom({ flow: b.definition }, fl)
      await checkRunAs(ctx, doc, fl)
      if (!sameRunAs(doc.runAs, fl.runAs)) throw new HttpError(422, 'invalid', 'A test run uses the saved run-as identity; save the change first.', 'runAs')
      const problems = (await f().validate(doc, fl.id, fl.connections.map((c) => ({ ref: c.ref, connectionId: c.connectionId, connector: c.connector ?? '' })))).filter((p) => p.severity === 'error')
      if (problems.length) throw new HttpError(422, 'invalid', `The flow has problems: ${problems[0].message}`, problems[0].field || undefined, { problems })
    }
    const inputs = (b.inputs && typeof b.inputs === 'object' ? b.inputs : {}) as Record<string, unknown>
    const r = await f().runManual(me(ctx), fl, inputs, { test: true, dryRun, ...(doc ? { doc } : {}), ...(b.trigger !== undefined ? { trigger: b.trigger } : {}), ...(typeof b.approvalOutcome === 'string' ? { approvalOutcome: b.approvalOutcome } : {}), source: 'portal' })
    await audit(s, ctx, 'flow.test', { flow: fl.id, name: fl.name, run: r.id, dryRun })
    return { runId: r.id, dryRun }
  }, { auth: 'maker' })

  /* ---------------------------------------------------------------- run history */

  router.add('GET', '/flows/runs', async (ctx) => {
    const u = me(ctx)
    const where: string[] = []
    const params: unknown[] = []
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)) }
    const flowId = ctx.query.get('flowId')
    if (flowId) add('r.flow_id = ?', flowId)
    const status = ctx.query.get('status')
    if (status) add('r.state = ANY(string_to_array(?, \',\'))', status)
    const mode = ctx.query.get('mode')
    if (mode === 'test' || mode === 'normal') add('r.mode = ?', mode)
    const trig = ctx.query.get('trigger')
    if (trig) add('r.trigger_kind = ?', trig)
    const before = ctx.query.get('before')
    if (before) add('r.created_on < ?', new Date(before))
    const after = ctx.query.get('after')
    if (after) add('r.created_on >= ?', new Date(after))
    const regarding = ctx.query.get('regarding')
    if (regarding) add('r.regarding_id = ?', regarding)
    // who sees what: administrators every run; others the runs of their flows and the runs they started
    if (!u.privileges.isAdmin) { params.push(u.user.id); where.push(`(r.owner_id = $${params.length} OR r.triggered_by = $${params.length})`) }
    const limit = Math.max(1, Math.min(500, Number(ctx.query.get('limit')) || 50))
    const rows = await s.state.db!.query<Row>(`SELECT r.* FROM ${T('ab_flow_runs')} r ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.created_on DESC, r.id DESC LIMIT ${limit}`, params)
    const names = new Map((await s.meta.users.list()).map((x) => [x.id, x.name]))
    return { items: rows.map((r) => toRunInfo(r, names)), nextBefore: rows.length === limit ? iso(rows[rows.length - 1].created_on) : null }
  }, { auth: 'user' })

  router.add('GET', '/flows/runs/:runId', async (ctx) => {
    const r = (await s.state.db!.query<Row>(`SELECT * FROM ${T('ab_flow_runs')} WHERE id = $1`, [ctx.params.runId]))[0]
    if (!r) throw new HttpError(404, 'not-found', 'Run not found.')
    const owner = r.owner_id ? String(r.owner_id) : null
    const names = new Map((await s.meta.users.list()).map((x) => [x.id, x.name]))
    const info = toRunInfo(r, names)
    if (!canView(ctx, owner)) {
      // the person who started it sees how it went, not the data it read
      if (String(r.triggered_by ?? '') !== me(ctx).user.id) throw new HttpError(404, 'not-found', 'Run not found.')
      return { run: info, summaryOnly: true }
    }
    const steps = (await s.state.db!.query<Row>(`SELECT * FROM ${T('ab_flow_steps')} WHERE run_id = $1 ORDER BY ord`, [info.id])).map(toStepRun)
    const waits = (await s.state.db!.query<Row>(`SELECT * FROM ${T('ab_flow_waits')} WHERE run_id = $1 ORDER BY created_on`, [info.id])).map((w): FlowWaitInfo => ({
      id: String(w.id), stepKey: String(w.step_key), kind: String(w.kind) as FlowWaitInfo['kind'], state: String(w.state) as FlowWaitInfo['state'],
      ...(w.wake_at ? { wakeAt: iso(w.wake_at) } : {}), ...(w.timeout_at ? { timeoutAt: iso(w.timeout_at) } : {}), ...(w.approval_id ? { approvalId: String(w.approval_id) } : {}),
      ...(w.child_run_id ? { childRunId: String(w.child_run_id) } : {}), createdOn: iso(w.created_on)!,
    }))
    const detail: FlowRunDetail = {
      ...info, trigger: display(fxToJson(fromStored(parseJ(r.trigger, null)))), variables: Object.fromEntries(Object.entries(parseJ<Record<string, unknown>>(r.variables, {})).map(([k, v]) => [k, fxToJson(fromStored(v))])),
      steps, waits,
    }
    return { run: detail }
  }, { auth: 'user' })

  const runFor = async (ctx: Ctx): Promise<Row> => {
    const r = (await s.state.db!.query<Row>(`SELECT * FROM ${T('ab_flow_runs')} WHERE id = $1`, [ctx.params.runId]))[0]
    if (!r) throw new HttpError(404, 'not-found', 'Run not found.')
    if (!canView(ctx, r.owner_id ? String(r.owner_id) : null)) throw new HttpError(404, 'not-found', 'Run not found.')
    return r
  }
  router.add('POST', '/flows/runs/:runId/cancel', async (ctx) => {
    const r = await runFor(ctx)
    if (isRunTerminal(String(r.state))) throw new HttpError(409, 'conflict', `The run already ended (${String(r.state)}).`)
    await f().engine.cancelRun(String(r.id), me(ctx).user.id)
    await audit(s, ctx, 'flow.run.cancel', { flow: String(r.flow_id), run: String(r.id) })
    return { ok: true }
  }, { auth: 'maker' })
  router.add('POST', '/flows/runs/:runId/resubmit', async (ctx) => {
    const r = await runFor(ctx)
    const from = body(ctx).from === 'failed' ? 'failed' : 'start'
    const out = await f().engine.resubmit(String(r.id), from, me(ctx).user.id)
    await audit(s, ctx, 'flow.run.resubmit', { flow: String(r.flow_id), run: String(r.id), newRun: out.id, from })
    return { runId: out.id }
  }, { auth: 'maker' })

  /* ---------------------------------------------------------------- callbacks of other systems */

  router.add('POST', '/flows/callback/:env/:run/:key/:token', async (ctx) => {
    const env = ctx.params.env
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(env) || !s.environments || !(await s.environments.get(env))) throw new HttpError(404, 'not-found', 'This callback address is not valid.')
    const raw = ctx.rawBody ?? Buffer.alloc(0)
    const type = String(ctx.req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    let parsed: unknown = raw.toString('utf8')
    if (type === 'application/json' && raw.length) {
      try { parsed = JSON.parse(raw.toString('utf8')) } catch { throw new HttpError(422, 'invalid', 'The body is not valid JSON.') }
    }
    const out = await runInEnvironment(env, () => f().engine.callback(ctx.params.run, ctx.params.key, ctx.params.token, parsed, type || undefined))
    if (out === 'gone') throw new HttpError(409, 'conflict', 'This callback was already used, or the run ended.')
    return { raw: true as const, status: 202, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ ok: true, state: out }) }
  }, { auth: 'none', raw: true, maxBodyMB: 1, csrfExempt: true })
}

function display(v: unknown): unknown {
  const s = JSON.stringify(v ?? null)
  return s.length > 64 * 1024 ? { truncated: true, size: s.length, preview: s.slice(0, 4000) } : v
}

function toStepRun(r: Row): FlowStepRun {
  const out: FlowStepRun = {
    key: String(r.step_key), stepId: String(r.step_id), name: String(r.name), kind: String(r.kind) as FlowStepRun['kind'], scope: String(r.scope),
    status: String(r.state) as FlowStepRun['status'], attempt: Number(r.attempt) || 0, startedOn: iso(r.started_on)!,
  }
  const input = parseJ<unknown>(r.input, null)
  if (input !== null) out.input = input
  const output = parseJ<unknown>(r.output, null)
  if (output !== null) out.output = display(fxToJson(fromStored(output)))
  const err = parseJ<FlowStepRun['error'] | null>(r.error, null)
  if (err) out.error = err
  if (r.finished_on) {
    out.finishedOn = iso(r.finished_on)
    out.durationMs = new Date(String(r.finished_on)).getTime() - new Date(String(r.started_on)).getTime()
  }
  if (r.truncated === true) out.truncated = true
  if (r.simulated === true) out.simulated = true
  return out
}
