/**
 * HTTP API of approvals (P1 package C; docs/dev/data-api.md "Approvals"). Every route needs a session; what a user sees
 * follows the approval rule (approvals/service.ts canSee); a request someone may not see answers 404 like a missing one.
 *
 *   GET    /approvals?view=toApprove|sentByMe|involved|all&status=open|decided|<status>&q=&policy=&regarding=&before=&limit=
 *   POST   /approvals                         { id?, policy? | approvers, type?, options?, title, details?, fields?, regarding?{table,rowId}, dueMinutes? }
 *   GET    /approvals/:id                     detail (record summary as the viewer may read it, stages, people, history)
 *   POST   /approvals/:id/respond             { response, comment? }
 *   POST   /approvals/respond-many            { ids, response, comment? }   (bulk; policies may forbid it)
 *   POST   /approvals/:id/info                { comment }  the requester answers "Need more info"
 *   POST   /approvals/:id/cancel              { reason? }  the requester (withdraw) or an administrator
 *   POST   /approvals/:id/reassign            { to, assignmentId?, comment? }  the person asked or an administrator
 *   GET    /approvals/record/:table/:row      requests about a record (the Approvals panel UI component)
 *   POST   /approvals/links/inspect           { token }  what an email link would answer (nothing changes)
 *   POST   /approvals/links/use               { token, comment? }  answer through an email link (single use, CSRF, session)
 *   GET    /approvals/delegations?all=1       POST /approvals/delegations { toUser, fromUser?, startsOn?, endsOn?, policies?, note? }
 *   DELETE /approvals/delegations/:id
 *   GET    /approvals/policies                POST /approvals/policies { name, description?, definition }   (makers)
 *   PUT    /approvals/policies/:id            DELETE /approvals/policies/:id
 *   GET    /approvals/settings                PUT /approvals/settings { viewerRoles?, retentionDays?, linkHours? }  (administrators)
 *   GET    /approvals/catalog                 types, approver references, escalation actions, step outputs
 */
import { HttpError } from '../contracts.ts'
import type { Ctx, UserContext } from '../contracts.ts'
import type { ApiRouter } from '../router.ts'
import type { CoreServices } from '../services.ts'
import { APPROVAL_STEP_OUTPUTS, APPROVAL_TYPE_DOCS, APPROVER_REF_DOCS, ESCALATION_DOCS, REQUEST_STATUSES } from '../../../src/platform/approvals.ts'
import type { Approvals } from './service.ts'

function body(ctx: Ctx): Record<string, unknown> {
  const b = ctx.body
  if (b === undefined || b === null) return {}
  if (typeof b !== 'object' || Array.isArray(b)) throw new HttpError(422, 'invalid', 'The body must be a JSON object.')
  return b as Record<string, unknown>
}
const me = (ctx: Ctx): UserContext => ctx.user!
const s = (v: unknown): string => (typeof v === 'string' ? v : '')

export function approvalRoutes(router: ApiRouter, services: CoreServices, a: () => Approvals): void {
  router.add('GET', '/approvals/catalog', async () => ({ types: APPROVAL_TYPE_DOCS, approvers: APPROVER_REF_DOCS, escalation: ESCALATION_DOCS, outputs: APPROVAL_STEP_OUTPUTS, statuses: REQUEST_STATUSES }), { auth: 'user' })

  router.add('GET', '/approvals', async (ctx) => {
    const v = ctx.query.get('view') ?? 'toApprove'
    if (!['toApprove', 'sentByMe', 'involved', 'all'].includes(v)) throw new HttpError(422, 'invalid', 'view must be toApprove, sentByMe, involved or all.', 'view')
    return a().list(me(ctx), {
      view: v as 'toApprove', status: ctx.query.get('status') ?? undefined, q: ctx.query.get('q') ?? undefined, policy: ctx.query.get('policy') ?? undefined,
      regarding: ctx.query.get('regarding') ?? undefined, before: ctx.query.get('before') ?? undefined, limit: Number(ctx.query.get('limit')) || undefined,
    })
  }, { auth: 'user' })

  router.add('POST', '/approvals', async (ctx) => {
    const b = body(ctx)
    const r = await a().requestFromUser(me(ctx), b, b.source === 'app' ? 'app' : 'api')
    return { id: r.id, created: r.created }
  }, { auth: 'user' })

  // literal segments first (the router prefers them over :id anyway)
  router.add('POST', '/approvals/respond-many', async (ctx) => {
    const b = body(ctx)
    const ids = Array.isArray(b.ids) ? b.ids.map(String).slice(0, 200) : []
    if (!ids.length) throw new HttpError(422, 'invalid', 'ids must list the requests to answer.', 'ids')
    const results: { id: string; ok: boolean; status?: string; error?: string }[] = []
    for (const id of ids) {
      try {
        const r = await a().respond(me(ctx), id, s(b.response), s(b.comment) || null, { bulk: true })
        results.push({ id, ok: true, status: r.status })
      } catch (e) {
        results.push({ id, ok: false, error: e instanceof HttpError ? e.message : 'Failed.' })
      }
    }
    return { results }
  }, { auth: 'user' })

  router.add('POST', '/approvals/links/inspect', async (ctx) => {
    const i = await a().inspectLink(me(ctx), body(ctx).token)
    if (!i.ok) return { ok: false, code: i.code, reason: i.reason, ...(i.environmentId ? { environmentId: i.environmentId } : {}) }
    return { ok: true, response: i.option.label, kind: i.option.kind, requireComment: !!i.option.requireComment || i.option.kind === 'info', request: await a().detail(me(ctx), String(i.request.id)) }
  }, { auth: 'user' })
  router.add('POST', '/approvals/links/use', async (ctx) => {
    const b = body(ctx)
    return a().useLink(me(ctx), b.token, s(b.comment) || null)
  }, { auth: 'user' })

  router.add('GET', '/approvals/delegations', async (ctx) => ({ items: await a().listDelegations(me(ctx), { all: ctx.query.get('all') === '1' }) }), { auth: 'user' })
  router.add('POST', '/approvals/delegations', async (ctx) => ({ delegation: await a().createDelegation(me(ctx), body(ctx)) }), { auth: 'user' })
  router.add('DELETE', '/approvals/delegations/:id', async (ctx) => {
    await a().cancelDelegation(me(ctx), ctx.params.id)
    return { ok: true }
  }, { auth: 'user' })

  router.add('GET', '/approvals/policies', async () => ({ items: await a().listPolicies() }), { auth: 'user' })
  router.add('POST', '/approvals/policies', async (ctx) => ({ policy: await a().savePolicy(me(ctx), null, body(ctx)) }), { auth: 'maker' })
  router.add('PUT', '/approvals/policies/:id', async (ctx) => ({ policy: await a().savePolicy(me(ctx), ctx.params.id, body(ctx)) }), { auth: 'maker' })
  router.add('DELETE', '/approvals/policies/:id', async (ctx) => {
    await a().deletePolicy(me(ctx), ctx.params.id)
    return { ok: true }
  }, { auth: 'maker' })

  router.add('GET', '/approvals/settings', async () => ({ settings: await a().settings() }), { auth: 'admin' })
  router.add('PUT', '/approvals/settings', async (ctx) => ({ settings: await a().saveSettings(me(ctx), body(ctx)) }), { auth: 'admin' })

  router.add('GET', '/approvals/record/:table/:row', async (ctx) => ({ items: await a().forRecord(me(ctx), ctx.params.table, ctx.params.row.length === 36 ? ctx.params.row.toLowerCase() : ctx.params.row) }), { auth: 'user' })

  router.add('GET', '/approvals/:id', async (ctx) => ({ request: await a().detail(me(ctx), ctx.params.id) }), { auth: 'user' })
  router.add('POST', '/approvals/:id/respond', async (ctx) => {
    const b = body(ctx)
    return a().respond(me(ctx), ctx.params.id, s(b.response), s(b.comment) || null)
  }, { auth: 'user' })
  router.add('POST', '/approvals/:id/info', async (ctx) => {
    await a().answerInfo(me(ctx), ctx.params.id, s(body(ctx).comment))
    return { ok: true }
  }, { auth: 'user' })
  router.add('POST', '/approvals/:id/cancel', async (ctx) => {
    await a().cancel(me(ctx), ctx.params.id, s(body(ctx).reason))
    return { ok: true }
  }, { auth: 'user' })
  router.add('POST', '/approvals/:id/reassign', async (ctx) => {
    const b = body(ctx)
    await a().reassign(me(ctx), ctx.params.id, { to: s(b.to), ...(b.assignmentId ? { assignmentId: s(b.assignmentId) } : {}), ...(b.comment ? { comment: s(b.comment) } : {}) })
    return { ok: true }
  }, { auth: 'user' })
  void services
}
