/**
 * Approvals in chat and on the record timeline (P3 package E; spec default 29 and the P1 carried-forward items
 * "approval cards in chat" and "timeline events for each answer"). A separate module on purpose: it changes nothing in
 * the approvals service (requests, routing, answers, self-approval, separation of duties stay there); it only READS the
 * approval tables and calls the service's own `canSee` / `detail`. Registered once by the chat module
 * (server/core/chat/routes.ts: registerApprovalChat).
 *
 * 1. Approval cards. Each pending assignment of the current stage of an open request gets ONE card in its person's
 *    direct conversation with the system sender "Approvals" (chat service: approvalsConversation, postSystemCard), when
 *    the person may use chat and has not switched approval notifications in the app off (Settings > Notifications >
 *    Approvals). The card is a reference `{ kind: 'approval', env, request, assignment, state }`: never values. It is
 *    resolved per reader through `detail()` as that reader (the inbox's own rule: someone who may not see the request
 *    gets "not available"; the record only as the reader may read it). Its buttons call the SAME route as the inbox
 *    (POST /approvals/:id/respond), so comment-required answers, delegation, self-approval prevention, separation of
 *    duties and immutable decisions are the service's checks, unchanged. A sweep on the worker round (at most every
 *    second per environment) posts new cards (a delegation, reassignment or escalation makes a new assignment, hence a
 *    new card for the new person) and marks a card 'done' when its assignment is no longer waiting (answered here or
 *    in the inbox, by email link, decided by others, cancelled, reassigned): an edit push, so every open copy resolves
 *    again (the card "updates live when decided elsewhere"). The card's message id is derived from (environment,
 *    assignment), so a card is posted once even across restarts and two workers.
 * 2. Timeline events per answer: every answer (approve, reject, a custom answer, "need more information" and the
 *    requester's information) from the request's history, as `approval.answered` events with who, what, when and the
 *    comment, for viewers who may see the request (canSee), on the record the request is about.
 */
import type { CoreServices } from '../services.ts'
import type { UserContext } from '../contracts.ts'
import type { TableDef } from '../../../src/platform/contracts.ts'
import type { ChatCardRef, ChatCardView } from '../../../src/platform/chat-protocol.ts'
import { currentEnvironment, runInEnvironment } from '../env-context.ts'
import { errText, log } from '../util.ts'
import { HttpError } from '../contracts.ts'
import type { ChatService } from '../chat/service.ts'
import { setApprovalCardResolver } from '../chat/cards.ts'
import { messageIdFor } from '../chat/format.ts'
import { richTextToPlain } from '../../../src/platform/system-tables.ts'

type Row = Record<string, unknown>
type ApprovalCard = Extract<ChatCardRef, { kind: 'approval' }>

const q = (id: string): string => `"${id.replace(/"/g, '""')}"`
const T = (t: string): string => `${q(currentEnvironment().schema)}.${q(t)}`
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const iso = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : (v instanceof Date ? v : new Date(String(v))).toISOString())
const json = <X>(v: unknown, d: X): X => {
  if (v === null || v === undefined) return d
  if (typeof v === 'string') {
    try { return JSON.parse(v) as X } catch { return d }
  }
  return v as X
}

/** the stable id of the chat message carrying one assignment's card */
export const approvalCardMessageId = (env: string, assignmentId: string): string => messageIdFor('system:approvals', env, assignmentId)

/** the history actions that are answers (shown on the record timeline, one event each) */
export const ANSWER_ACTIONS = ['responded', 'info.requested', 'info.answered'] as const

export function registerApprovalChat(s: CoreServices, chat: ChatService): { sweep(envId?: string): Promise<{ posted: number; done: number }> } {
  const approvals = s.approvals
  if (!approvals) return { sweep: async () => ({ posted: 0, done: 0 }) }

  /* ---------------------------------------------------------------- the card, resolved per reader */

  setApprovalCardResolver(async (userId, ref): Promise<ChatCardView> => {
    const na: ChatCardView = { available: false, kind: 'approval' }
    return runInEnvironment(ref.env, async () => {
      let ctx: UserContext
      try {
        ctx = await approvals.forUserId(userId)
      } catch {
        return na
      }
      let d
      try {
        d = await approvals.detail(ctx, ref.request)
      } catch (e) {
        if (e instanceof HttpError && (e.status === 404 || e.status === 403)) return na
        throw e
      }
      const mine = d.assignments.filter((a) => a.userId === userId && a.status === 'responded').sort((a, b) => String(b.respondedOn).localeCompare(String(a.respondedOn)))[0]
      return {
        available: true, kind: 'approval', env: ref.env, request: d.id, title: d.title, status: d.status, outcome: d.outcome ?? null, requestedByName: d.requestedByName ?? null,
        dueOn: d.dueOn ?? null, fields: Object.entries(d.fields ?? {}).map(([name, value]) => ({ name, value })),
        record: d.record ? { tableName: d.regardingTableName ?? '', title: d.record.title } : null,
        options: d.responses.map((o) => ({ label: o.label, kind: o.kind, requireComment: !!o.requireComment || o.kind === 'info' })),
        canDecide: d.canDecide === true,
        myAnswer: mine ? { response: mine.response ?? '', comment: mine.comment ?? null, at: mine.respondedOn ?? null } : null,
      }
    })
  })

  /* ---------------------------------------------------------------- timeline events per answer */

  s.collab.addTimelineSource(async (ctx: UserContext, table: TableDef, rowId: string, before, limit) => {
    const reqs = await s.state.db!.query<Row>(`SELECT * FROM ${T('ab_approval_requests')} WHERE regarding_id = $1 AND regarding_table = $2 ORDER BY created_on DESC LIMIT 200`, [rowId, table.id])
    const visible: Row[] = []
    for (const r of reqs) if (await approvals.canSee(ctx, r)) visible.push(r)
    if (!visible.length) return []
    const params: unknown[] = [visible.map((r) => str(r.id)), [...ANSWER_ACTIONS], limit + 1]
    if (before) params.push(new Date(before.at))
    const rows = await s.state.db!.query<Row>(
      `SELECT h.*, u.name AS "_name" FROM ${T('ab_approval_history')} h LEFT JOIN "ab"."users" u ON u.id = h.actor_id
        WHERE h.request_id = ANY($1::text[]) AND h.action = ANY($2::text[])${before ? ' AND h.at <= $4' : ''} ORDER BY h.at DESC, h.seq DESC LIMIT $3`, params,
    )
    const titles = new Map(visible.map((r) => [str(r.id), str(r.title)]))
    const out = rows.map((h) => {
      const d = json<Record<string, unknown>>(h.details, {})
      return {
        kind: 'event' as const, id: `p${str(h.request_id)}:h${str(h.id)}`, at: iso(h.at)!, by: h.actor_id ? str(h.actor_id) : null,
        data: {
          action: 'approval.answered', approvalId: str(h.request_id), title: titles.get(str(h.request_id)) ?? '', what: str(h.action),
          response: str(d.response), comment: typeof d.comment === 'string' ? d.comment : '', stage: h.stage_idx === null ? null : Number(h.stage_idx) + 1,
          ...(d.via === 'email' ? { via: 'email' } : {}), ...(d.bulk ? { bulk: true } : {}),
        },
      }
    })
    return before ? out.filter((i) => i.at < before.at || (i.at === before.at && i.id < before.id)) : out
  })

  /* ---------------------------------------------------------------- the sweep: post cards, close answered ones */

  /** pending cards by message id (loaded from the chat environment once, then kept as cards are posted and closed) */
  let pending: Map<string, ApprovalCard> | null = null
  /** assignments whose person may not get a card (no chat, approvals off in the app): asked again after a while */
  const skipped = new Map<string, number>()
  const lastRun = new Map<string, number>()
  const running = new Set<string>()

  async function sweepEnv(envId: string): Promise<{ posted: number; done: number }> {
    const db = s.state.db
    if (!db) return { posted: 0, done: 0 }
    const { env: chatEnv } = await chat.chatEnv()
    if (!pending) {
      pending = new Map()
      for (const c of await chat.pendingSystemCards(chatEnv)) if (c.card.kind === 'approval') pending.set(c.id, c.card)
    }
    let posted = 0
    let done = 0
    // 1. cards whose assignment is no longer waiting for its person: 'done' (an edit push; readers resolve again)
    const mineHere = [...pending].filter(([, c]) => c.env === envId)
    if (mineHere.length) {
      const rows = await db.query<Row>(
        `SELECT a.id, a.status, a.stage_idx, r.status AS "_rs", r.current_stage FROM ${T('ab_approval_assignments')} a JOIN ${T('ab_approval_requests')} r ON r.id = a.request_id WHERE a.id = ANY($1::text[])`,
        [mineHere.map(([, c]) => c.assignment)],
      )
      const byId = new Map(rows.map((r) => [str(r.id), r]))
      for (const [mid, c] of mineHere) {
        const r = byId.get(c.assignment)
        const waiting = !!r && r.status === 'pending' && Number(r.stage_idx) === Number(r.current_stage) && (r._rs === 'pending' || r._rs === 'info')
        if (waiting) continue
        await chat.updateSystemCard(chatEnv, mid, { ...c, state: 'done' })
        pending.delete(mid)
        done++
      }
    }
    // 2. new pending assignments of the current stage: one card each
    const open = await db.query<Row>(
      `SELECT a.id, a.user_id, a.request_id, r.title FROM ${T('ab_approval_assignments')} a JOIN ${T('ab_approval_requests')} r ON r.id = a.request_id
        WHERE a.status = 'pending' AND a.stage_idx = r.current_stage AND r.status IN ('pending', 'info') ORDER BY a.created_on DESC LIMIT 500`,
    )
    if (!open.length) return { posted, done }
    const ids = open.map((a) => approvalCardMessageId(envId, str(a.id)))
    const have = await chat.existingMessages(chatEnv, ids)
    const now = Date.now()
    for (let i = 0; i < open.length; i++) {
      const a = open[i]
      const mid = ids[i]
      if (have.has(mid)) continue
      const aid = str(a.id)
      if ((skipped.get(aid) ?? 0) > now) continue
      const userId = str(a.user_id)
      const cx = await chat.cxForUser(userId)
      const prefs = s.notifications ? await s.notifications.settings(userId).catch(() => null) : null
      if (!cx || prefs?.kinds.approval === false) {
        skipped.set(aid, now + 60_000)
        continue
      }
      const conv = await chat.approvalsConversation(chatEnv, userId)
      const card: ApprovalCard = { kind: 'approval', env: envId, request: str(a.request_id), assignment: aid, state: 'pending' }
      const r = await chat.postSystemCard(chatEnv, conv.id, { id: mid, text: `Approval needed: ${richTextToPlain(str(a.title)).slice(0, 180)}`, card })
      if (r.posted) {
        posted++
        pending.set(mid, card)
      }
    }
    if (skipped.size > 5000) for (const [k, until] of skipped) if (until < now) skipped.delete(k)
    return { posted, done }
  }

  async function sweep(envId?: string): Promise<{ posted: number; done: number }> {
    const id = envId ?? currentEnvironment().id
    if (running.has(id)) return { posted: 0, done: 0 }
    running.add(id)
    try {
      return await runInEnvironment(id, () => sweepEnv(id))
    } finally {
      running.delete(id)
    }
  }

  s.kernel.addTickHook(async (env) => {
    const now = Date.now()
    if (now - (lastRun.get(env.id) ?? 0) < 1000) return
    lastRun.set(env.id, now)
    await sweep(env.id).catch((e) => log('warn', `approval cards (${env.id}): ${errText(e)}`))
  })

  return { sweep }
}
