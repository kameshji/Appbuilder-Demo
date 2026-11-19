/**
 * HTTP routes of the event and job kernel (docs/dev/data-api.md "Table events, jobs and schedules").
 *
 * Makers (design routes: refused in a locked environment):
 *   GET    /tables/:id/events                 POST /tables/:id/events            PATCH/DELETE /tables/:id/events/:eventId
 *   POST   /tables/:id/events/test            { event, sample, op?, old? } -> EventTestResult (nothing is written)
 *   POST   /tables/:id/formula/check          { formula, role } -> { problems }
 *   GET    /tables/:id/event-runs             recent runs of the table's events (run log)
 * Administrators (the environment's):
 *   GET    /admin/jobs?state=&type=&limit=&offset=   GET /admin/jobs/metrics   GET /admin/jobs/:id
 *   POST   /admin/jobs/:id/retry              POST /admin/jobs/:id/cancel
 *   GET    /admin/schedules                   POST /admin/schedules   PATCH/DELETE /admin/schedules/:id
 *   POST   /admin/schedules/:id/run           GET /admin/event-runs?tableId=&status=&limit=&before=
 * "Run as system" on an event is for administrators only and audited.
 */
import { HttpError } from './contracts.ts'
import type { Ctx } from './contracts.ts'
import type { ApiRouter } from './router.ts'
import type { CoreServices } from './services.ts'
import type { EventRunStatus, JobState, TableEventInput, TableEventOperation } from '../../src/platform/events.ts'
import type { FormulaRole } from './event-fx.ts'
import { tableParam } from './data-routes.ts'
import type { ScheduleInput } from './jobs.ts'
import { errText, log } from './util.ts'

const ROLES: FormulaRole[] = ['condition', 'validation', 'formulaColumn', 'before', 'after']
const STATES: (JobState | 'active')[] = ['queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled', 'active']

function body(ctx: Ctx): Record<string, unknown> {
  const b = ctx.body
  if (b === undefined || b === null) return {}
  if (typeof b !== 'object' || Array.isArray(b)) throw new HttpError(422, 'invalid', 'Request body must be a JSON object.')
  return b as Record<string, unknown>
}

async function audit(s: CoreServices, ctx: Ctx, action: string, details: unknown, tableId?: string): Promise<void> {
  try {
    await s.meta.audit({ userId: ctx.user?.user.id ?? null, action, ...(tableId ? { tableId } : {}), details })
  } catch (e) {
    log('error', `audit write failed (${action}): ${errText(e)}`)
  }
}

function eventInput(raw: unknown): TableEventInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(422, 'invalid', 'The event must be an object.')
  const o = raw as Record<string, unknown>
  const out: TableEventInput = {}
  const str = (k: keyof TableEventInput) => {
    if (o[k] === undefined) return
    if (o[k] !== null && typeof o[k] !== 'string') throw new HttpError(422, 'invalid', `${String(k)} must be text.`, String(k))
    ;(out as Record<string, unknown>)[k] = o[k] ?? ''
  }
  for (const k of ['name', 'condition', 'actions', 'message', 'field', 'description'] as const) str(k)
  if (o.kind !== undefined) out.kind = o.kind as TableEventInput['kind']
  if (o.timing !== undefined) out.timing = o.timing as TableEventInput['timing']
  if (o.operations !== undefined) out.operations = o.operations as TableEventOperation[]
  if (o.order !== undefined) out.order = Number(o.order)
  if (o.enabled !== undefined) out.enabled = o.enabled === true
  if (o.runAs !== undefined) out.runAs = o.runAs as TableEventInput['runAs']
  // P1-D: connections attached for RunConnector (ids)
  if (o.connections !== undefined) {
    if (!Array.isArray(o.connections) || o.connections.length > 20 || o.connections.some((c) => typeof c !== 'string' || !c || c.length > 100)) throw new HttpError(422, 'invalid', 'connections must be a list of at most 20 connection ids.', 'connections')
    out.connections = [...new Set(o.connections as string[])]
  }
  return out
}

function scheduleInput(b: Record<string, unknown>): ScheduleInput {
  const out: ScheduleInput = {}
  if (b.name !== undefined) out.name = String(b.name)
  if (b.description !== undefined) out.description = b.description === null ? null : String(b.description)
  if (b.cron !== undefined) out.cron = b.cron === null ? null : String(b.cron)
  if (b.intervalSeconds !== undefined) out.intervalSeconds = b.intervalSeconds === null ? null : Number(b.intervalSeconds)
  if (b.timeZone !== undefined) out.timeZone = String(b.timeZone)
  if (b.jobType !== undefined) out.jobType = String(b.jobType)
  if (b.payload !== undefined) out.payload = b.payload
  if (b.enabled !== undefined) out.enabled = b.enabled === true
  if (b.misfire !== undefined) out.misfire = b.misfire as ScheduleInput['misfire']
  return out
}

export function kernelRoutes(router: ApiRouter, s: CoreServices): void {
  const k = () => s.kernel

  /* ---------------------------------------------------------------- table events (makers) */

  router.add('GET', '/tables/:id/events', async (ctx) => {
    const t = await tableParam(s, ctx.params.id)
    return { items: await k().events.list(t.id) }
  }, { auth: 'maker' })

  const save = async (ctx: Ctx, id: string | null) => {
    const t = await tableParam(s, ctx.params.id)
    const b = body(ctx)
    const input = eventInput(b.event ?? b)
    const before = id ? await k().events.get(id) : null
    if (id && (!before || before.tableId !== t.id)) throw new HttpError(404, 'not-found', 'Event not found.')
    const isAdmin = ctx.user!.privileges.isAdmin
    // running as the system bypasses row and column security: administrators only, and audited
    if (!isAdmin && (input.runAs === 'system' || (before?.runAs === 'system'))) {
      throw new HttpError(403, 'denied', before?.runAs === 'system' ? 'This event runs as the system; only an administrator can change it.' : 'Only an administrator can make an event run as the system.', 'runAs')
    }
    // P1-D: attaching a connection needs "use" on it (removing one does not)
    if (input.connections?.length) {
      const had = new Set(before?.connections ?? [])
      for (const c of input.connections) if (!had.has(c)) {
        if (!s.actions) throw new HttpError(503, 'unavailable', 'Connector actions are not available on this server.')
        await s.actions.assertCanUse(ctx.user!, c)
      }
    }
    const { event } = await s.transaction(() => k().events.save(t, id, input, ctx.user!.user.id))
    await audit(s, ctx, id ? 'event.update' : 'event.create', { event: event.id, name: event.name, kind: event.kind, timing: event.timing, runAs: event.runAs, enabled: event.enabled }, t.id)
    if (event.runAs === 'system' && before?.runAs !== 'system') await audit(s, ctx, 'event.run_as_system', { event: event.id, name: event.name }, t.id)
    return { event }
  }

  router.add('POST', '/tables/:id/events', (ctx) => save(ctx, null), { auth: 'maker', design: true })
  router.add('PATCH', '/tables/:id/events/:eventId', (ctx) => save(ctx, ctx.params.eventId), { auth: 'maker', design: true })

  router.add('DELETE', '/tables/:id/events/:eventId', async (ctx) => {
    const t = await tableParam(s, ctx.params.id)
    const e = await k().events.get(ctx.params.eventId)
    if (!e || e.tableId !== t.id) throw new HttpError(404, 'not-found', 'Event not found.')
    if (e.runAs === 'system' && !ctx.user!.privileges.isAdmin) throw new HttpError(403, 'denied', 'This event runs as the system; only an administrator can delete it.')
    await k().events.remove(e.id)
    await audit(s, ctx, 'event.delete', { event: e.id, name: e.name }, t.id)
    return { ok: true }
  }, { auth: 'maker', design: true })

  router.add('POST', '/tables/:id/events/test', async (ctx) => {
    const t = await tableParam(s, ctx.params.id)
    const b = body(ctx)
    const input = eventInput(b.event)
    if (input.runAs === 'system' && !ctx.user!.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only an administrator can test an event that runs as the system.', 'runAs')
    const sample = b.sample && typeof b.sample === 'object' && !Array.isArray(b.sample) ? (b.sample as Record<string, unknown>) : {}
    const old = b.old && typeof b.old === 'object' && !Array.isArray(b.old) ? (b.old as Record<string, unknown>) : null
    const op = b.op === 'update' || b.op === 'delete' ? b.op : 'create'
    return k().events.testRun(t, input, sample, { op, old, ctx: ctx.user! })
  }, { auth: 'maker' })

  router.add('POST', '/tables/:id/formula/check', async (ctx) => {
    const t = await tableParam(s, ctx.params.id)
    const b = body(ctx)
    if (typeof b.formula !== 'string') throw new HttpError(422, 'invalid', 'formula must be text.', 'formula')
    const role = (ROLES.includes(b.role as FormulaRole) ? b.role : 'condition') as FormulaRole
    return { problems: await k().events.check(t, b.formula, role) }
  }, { auth: 'maker' })

  router.add('GET', '/tables/:id/event-runs', async (ctx) => {
    const t = await tableParam(s, ctx.params.id)
    const status = ctx.query.get('status') as EventRunStatus | null
    return { items: await k().events.runLog({ tableId: t.id, status: status ?? undefined, eventId: ctx.query.get('eventId') ?? undefined, limit: Number(ctx.query.get('limit')) || 50, before: Number(ctx.query.get('before')) || undefined }) }
  }, { auth: 'maker' })

  /* ---------------------------------------------------------------- jobs (administrators) */

  router.add('GET', '/admin/jobs', async (ctx) => {
    const state = ctx.query.get('state') as JobState | 'active' | null
    if (state && !STATES.includes(state)) throw new HttpError(422, 'invalid', 'Unknown job state.', 'state')
    return k().jobs.list({ state: state ?? undefined, type: ctx.query.get('type') || undefined, limit: Number(ctx.query.get('limit')) || 50, offset: Number(ctx.query.get('offset')) || 0 })
  }, { auth: 'admin' })

  router.add('GET', '/admin/jobs/metrics', async () => k().jobs.metrics(), { auth: 'admin' })

  router.add('GET', '/admin/jobs/:id', async (ctx) => {
    const j = await k().jobs.get(ctx.params.id)
    if (!j) throw new HttpError(404, 'not-found', 'Job not found.')
    return j
  }, { auth: 'admin' })

  router.add('POST', '/admin/jobs/:id/retry', async (ctx) => {
    const j = await k().jobs.retry(ctx.params.id)
    await audit(s, ctx, 'job.retry', { job: j.id, type: j.type })
    k().jobs.wake()
    return j
  }, { auth: 'admin' })

  router.add('POST', '/admin/jobs/:id/cancel', async (ctx) => {
    const j = await k().jobs.cancel(ctx.params.id)
    await audit(s, ctx, 'job.cancel', { job: j.id, type: j.type })
    return j
  }, { auth: 'admin' })

  /* ---------------------------------------------------------------- schedules (administrators) */

  router.add('GET', '/admin/schedules', async () => ({ items: await k().jobs.schedules.list() }), { auth: 'admin' })

  /**
   * Who may touch a schedule (P0 package M): custom schedules only for job types marked schedule 'custom'; schedules of
   * install-wide job types (backups, mail, install log retention) only install administrators may change or run.
   */
  const policyOf = (jobType: string) => k().jobs.typeDef(jobType)?.schedule
  const guard = async (ctx: Parameters<Parameters<typeof router.add>[2]>[0], id: string, next?: ScheduleInput): Promise<void> => {
    const cur = await k().jobs.schedules.get(id)
    if (!cur) throw new HttpError(404, 'not-found', 'Schedule not found.')
    const install = policyOf(cur.jobType) === 'install' || (next?.jobType !== undefined && policyOf(next.jobType) === 'install')
    if (install && !ctx.user!.privileges.isInstallAdmin) throw new HttpError(403, 'denied', 'This schedule runs install-wide maintenance: only install administrators can change or run it.')
    if (next?.jobType !== undefined && next.jobType !== cur.jobType && policyOf(next.jobType) !== 'custom') throw new HttpError(422, 'invalid', `Schedules of "${next.jobType}" cannot be made here.`, 'jobType')
  }

  router.add('POST', '/admin/schedules', async (ctx) => {
    const input = scheduleInput(body(ctx))
    if (!input.jobType || policyOf(input.jobType) !== 'custom') throw new HttpError(422, 'invalid', `Schedules of "${input.jobType ?? ''}" cannot be made here: choose one of ${k().jobs.types().filter((t) => t.schedule === 'custom').map((t) => t.type).join(', ')}.`, 'jobType')
    const sc = await k().jobs.schedules.create(input, ctx.user!.user.id)
    await audit(s, ctx, 'schedule.create', { schedule: sc.id, name: sc.name, jobType: sc.jobType })
    return sc
  }, { auth: 'admin' })

  router.add('PATCH', '/admin/schedules/:id', async (ctx) => {
    const input = scheduleInput(body(ctx))
    await guard(ctx, ctx.params.id, input)
    const sc = await k().jobs.schedules.update(ctx.params.id, input)
    await audit(s, ctx, 'schedule.update', { schedule: sc.id, name: sc.name, enabled: sc.enabled, cron: sc.cron, intervalSeconds: sc.intervalSeconds, payload: sc.payload })
    return sc
  }, { auth: 'admin' })

  router.add('DELETE', '/admin/schedules/:id', async (ctx) => {
    await guard(ctx, ctx.params.id)
    await k().jobs.schedules.remove(ctx.params.id)
    await audit(s, ctx, 'schedule.delete', { schedule: ctx.params.id })
    return { ok: true }
  }, { auth: 'admin' })

  router.add('POST', '/admin/schedules/:id/run', async (ctx) => {
    await guard(ctx, ctx.params.id)
    const r = await k().jobs.schedules.runNow(ctx.params.id, ctx.user!.user.id)
    await audit(s, ctx, 'schedule.run', { schedule: ctx.params.id, job: r.id })
    k().jobs.wake()
    return r
  }, { auth: 'admin' })

  router.add('GET', '/admin/event-runs', async (ctx) => {
    const status = ctx.query.get('status') as EventRunStatus | null
    return { items: await k().events.runLog({ tableId: ctx.query.get('tableId') || undefined, status: status ?? undefined, limit: Number(ctx.query.get('limit')) || 100, before: Number(ctx.query.get('before')) || undefined }) }
  }, { auth: 'admin' })
}
