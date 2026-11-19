/**
 * The approvals service (P1 package C; docs/dev/approvals.md): requests from flows (ApprovalsService of the flow
 * runtime), apps (RequestApproval) and the API; routing (routing.ts); answers, "need more info", reassignment,
 * delegation, reminders, escalation, cancellation and expiry; the security rule; notifications with signed email answer
 * links; the record timeline; the approvalDecided flow trigger.
 *
 * State machine and guarantees:
 *  - every change of a request happens in ONE transaction with the request row locked (SELECT ... FOR UPDATE): its
 *    assignments, stages and history rows, the flow's resume job and the notification jobs commit together. A decision is
 *    made once (the row lock and the status check), and the waiting flow step is resumed once (resumeWait enqueues
 *    `flow.resume` keyed by the wait, in this transaction);
 *  - decisions are immutable: an answered assignment never changes again, a decided request never reopens (a correction
 *    is a new request);
 *  - notifications go out from jobs after the commit (`approval.notify`, `approval.decided`), each keyed so a retry does
 *    not send twice to the same person for the same event;
 *  - time (due dates, reminders, escalation, delegation start and end) follows the flow clock, so time-travel tests move
 *    both; the sweep runs on every worker round (at most every 2 s per environment) and from tests (`tick()`).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { HttpError } from '../contracts.ts'
import type { SqlDb, UserContext } from '../contracts.ts'
import type { CoreServices } from '../services.ts'
import type { TableDef, UserDef } from '../../../src/platform/contracts.ts'
import type { FxValue } from '../../../src/contracts.ts'
import { currentEnvironment, runInEnvironment } from '../env-context.ts'
import { errText, log } from '../util.ts'
import { loadSecretKey } from '../secrets.ts'
import { evaluate } from '../../../src/fx/index.ts'
import { SYS, sanitizeRichText } from '../../../src/platform/system-tables.ts'
import {
  DEFAULT_APPROVAL_SETTINGS, definitionProblems, isOpenStatus, responsesOf,
  type ApprovalDefinition, type ApprovalDetail, type ApprovalHistoryEntry, type ApprovalPolicy, type ApprovalRequestInfo, type ApprovalSettings,
  type ApprovalAssignmentInfo, type ApprovalStageInfo, type AssignmentStatus, type DelegationInfo, type RequestStatus, type ResponseKind, type ResponseOption,
} from '../../../src/platform/approvals.ts'
import type { ApprovalOutcome, ApprovalRequest as FlowApprovalRequest, ApprovalsService } from '../flows/contracts.ts'
import {
  RoutingError, delegateOf, expandStages, findPerson, managersOf, resolveStage, stageOutcome, type ActiveDelegation, type OrgData, type OrgPerson, type StagePlan,
} from './routing.ts'

type Row = Record<string, unknown>

export const APPROVAL_NOTIFY_JOB = 'approval.notify'
export const APPROVAL_DECIDED_JOB = 'approval.decided'
export const APPROVAL_RETENTION_JOB = 'approval.retention'

const q = (id: string): string => `"${id.replace(/"/g, '""')}"`
const T = (t: string): string => `${q(currentEnvironment().schema)}.${q(t)}`
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const iso = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : (v instanceof Date ? v : new Date(String(v))).toISOString())
const json = <T>(v: unknown, d: T): T => {
  if (v === null || v === undefined) return d
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T } catch { return d }
  }
  return v as T
}
const invalid = (m: string, field?: string) => new HttpError(422, 'invalid', m, field)
const notFound = () => new HttpError(404, 'not-found', 'There is no such approval request (or you may not see it).')

/** what createRequest needs (from flows, apps and the API) */
export interface CreateInput {
  /** client-chosen id (apps: RequestApproval returns it at once); also the idempotency key when given */
  id?: string
  idempotencyKey?: string
  title: string
  details?: string
  fields?: Record<string, unknown>
  regarding?: { tableId: string; rowId: string } | null
  requestedBy: string | null
  definition: ApprovalDefinition
  policyId?: string | null
  source: 'flow' | 'app' | 'api'
  flow?: { flowId: string; flowName: string; runId: string; waitId: string; stepKey: string }
  dueOn?: Date | null
}

export type Actor = { id: string | null; kind: 'user' | 'system' | 'flow' }
const SYSTEM: Actor = { id: null, kind: 'system' }

export type Approvals = ReturnType<typeof createApprovals>

export function createApprovals(services: CoreServices) {
  const db = (): SqlDb => {
    const d = services.state.db
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }
  const now = (): Date => {
    try {
      return services.flows.engine.clock.now()
    } catch {
      return new Date()
    }
  }
  const envId = () => currentEnvironment().id
  const newId = (p: string) => `${p}_${randomBytes(10).toString('hex')}`

  /* ---------------------------------------------------------------- settings */

  async function settings(): Promise<ApprovalSettings> {
    const r = await db().query<Row>(`SELECT v FROM ${T('ab_approval_settings')} WHERE k = 'settings'`)
    const v = json<Partial<ApprovalSettings>>(r[0]?.v, {})
    return {
      viewerRoles: Array.isArray(v.viewerRoles) ? v.viewerRoles.map(String) : DEFAULT_APPROVAL_SETTINGS.viewerRoles,
      retentionDays: Number.isInteger(v.retentionDays) && Number(v.retentionDays) >= 0 ? Number(v.retentionDays) : DEFAULT_APPROVAL_SETTINGS.retentionDays,
      linkHours: Number(v.linkHours) >= 1 && Number(v.linkHours) <= 24 * 30 ? Number(v.linkHours) : DEFAULT_APPROVAL_SETTINGS.linkHours,
    }
  }

  async function saveSettings(ctx: UserContext, raw: unknown): Promise<ApprovalSettings> {
    if (!ctx.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only administrators can change the approval settings.')
    const o = (raw ?? {}) as Partial<ApprovalSettings>
    const cur = await settings()
    const roles = await services.meta.roles.list()
    const next: ApprovalSettings = { ...cur }
    if (o.viewerRoles !== undefined) {
      if (!Array.isArray(o.viewerRoles)) throw invalid('viewerRoles must be a list of role ids.', 'viewerRoles')
      for (const r of o.viewerRoles) if (!roles.some((x) => x.id === r)) throw invalid(`There is no role ${String(r)}.`, 'viewerRoles')
      next.viewerRoles = [...new Set(o.viewerRoles.map(String))]
    }
    if (o.retentionDays !== undefined) {
      if (!Number.isInteger(o.retentionDays) || o.retentionDays < 0 || o.retentionDays > 36500) throw invalid('retentionDays must be a whole number of days (0: keep forever).', 'retentionDays')
      next.retentionDays = o.retentionDays
    }
    if (o.linkHours !== undefined) {
      if (!(Number(o.linkHours) >= 1 && Number(o.linkHours) <= 720)) throw invalid('linkHours must be from 1 to 720.', 'linkHours')
      next.linkHours = Number(o.linkHours)
    }
    await db().tx(async () => {
      await db().exec(`INSERT INTO ${T('ab_approval_settings')} (k, v, modified_by, modified_on) VALUES ('settings', $1::jsonb, $2, now()) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, modified_by = EXCLUDED.modified_by, modified_on = now()`, [JSON.stringify(next), ctx.user.id])
      // the privilege "Approvals: view" lives on the system table's definition (the security engine reads it)
      const t = await services.meta.tables.get(SYS.approvalRequests)
      if (t) await services.meta.tables.upsert({ ...t, systemPrivilegeRoles: next.viewerRoles })
      await services.meta.audit({ userId: ctx.user.id, action: 'approval.settings', details: next })
    })
    services.security.invalidate()
    return next
  }

  /* ---------------------------------------------------------------- the organisation */

  let orgCache: { env: string; at: number; org: OrgData } | null = null
  async function loadOrg(): Promise<OrgData> {
    const env = envId()
    if (orgCache && orgCache.env === env && Date.now() - orgCache.at < 2000) return orgCache.org
    const users = await db().query<Row>(
      `SELECT u.id, u.name, u.email, u.status, u.manager_id, u.department_id, u.job_title, u.is_install_admin,
              COALESCE(a.is_env_admin, false) AS env_admin
         FROM "ab"."users" u LEFT JOIN "ab"."environment_access" a ON a.user_id = u.id AND a.environment_id = $1
        WHERE u.is_install_admin OR a.user_id IS NOT NULL`, [env],
    )
    const ur = await db().query<Row>(`SELECT user_id, role_id FROM ${T('ab_user_roles')}`)
    const rolesOf = new Map<string, string[]>()
    for (const r of ur) rolesOf.set(str(r.user_id), [...(rolesOf.get(str(r.user_id)) ?? []), str(r.role_id)])
    const roles = await services.meta.roles.list()
    const adminRoles = new Set(roles.filter((r) => r.isAdmin).map((r) => r.id))
    const people = new Map<string, OrgPerson>()
    const admins: string[] = []
    for (const u of users) {
      const id = str(u.id)
      const p: OrgPerson = {
        id, name: str(u.name), email: str(u.email), managerId: u.manager_id ? str(u.manager_id) : null, departmentId: u.department_id ? str(u.department_id) : null,
        jobTitle: u.job_title ? str(u.job_title) : null, status: str(u.status) === 'disabled' ? 'disabled' : 'active', roleIds: rolesOf.get(id) ?? [],
      }
      people.set(id, p)
      if (p.status === 'active' && (u.is_install_admin === true || u.env_admin === true || p.roleIds.some((r) => adminRoles.has(r)))) admins.push(id)
    }
    const teams = (await db().query<Row>(
      `SELECT t.id, t.code, t.name, COALESCE(array_agg(m.user_id) FILTER (WHERE m.user_id IS NOT NULL), '{}') AS members
         FROM "ab"."teams" t LEFT JOIN "ab"."team_members" m ON m.team_id = t.id
        WHERE t.environment_id IS NULL OR t.environment_id = $1 GROUP BY t.id, t.code, t.name`, [env],
    )).map((t) => ({ id: str(t.id), code: str(t.code), name: str(t.name), memberIds: (t.members as string[]) ?? [] }))
    const departments = (await db().query<Row>(`SELECT id, code, name FROM "ab"."departments"`)).map((d) => ({ id: str(d.id), code: str(d.code), name: str(d.name) }))
    const org: OrgData = { people, roles: roles.map((r) => ({ id: r.id, name: r.name })), teams, departments, admins }
    orgCache = { env, at: Date.now(), org }
    return org
  }
  const invalidateOrg = () => { orgCache = null }

  async function activeDelegations(at: Date): Promise<ActiveDelegation[]> {
    const rows = await db().query<Row>(`SELECT id, from_user, to_user, policies FROM ${T('ab_approval_delegations')} WHERE cancelled_on IS NULL AND starts_on <= $1 AND (ends_on IS NULL OR ends_on > $1)`, [at])
    return rows.map((r) => ({ id: str(r.id), fromUser: str(r.from_user), toUser: str(r.to_user), policies: json<string[]>(r.policies, []) }))
  }

  /* ---------------------------------------------------------------- policies */

  const toPolicy = (r: Row): ApprovalPolicy => ({
    id: str(r.id), name: str(r.name), ...(r.description ? { description: str(r.description) } : {}), definition: json<ApprovalDefinition>(r.definition, { type: 'single' }),
    solutionId: r.solution_id ? str(r.solution_id) : null, createdOn: iso(r.created_on) ?? undefined, modifiedOn: iso(r.modified_on) ?? undefined, modifiedBy: r.modified_by ? str(r.modified_by) : null,
  })
  async function listPolicies(): Promise<ApprovalPolicy[]> {
    return (await db().query<Row>(`SELECT * FROM ${T('ab_approval_policies')} ORDER BY lower(name)`)).map(toPolicy)
  }
  async function policy(idOrName: string): Promise<ApprovalPolicy | null> {
    const r = await db().query<Row>(`SELECT * FROM ${T('ab_approval_policies')} WHERE id = $1 OR lower(name) = lower($1) LIMIT 1`, [idOrName])
    return r[0] ? toPolicy(r[0]) : null
  }
  function checkDefinition(def: unknown): ApprovalDefinition {
    const problems = definitionProblems(def)
    if (problems.length) throw invalid(problems.map((p) => `${p.field}: ${p.message}`).join(' '), problems[0].field)
    const d = def as ApprovalDefinition
    for (const [i, s] of (d.stages ?? []).entries()) if (s.condition) checkCondition(s.condition, `stages.${i}.condition`)
    for (const [i, r] of (d.rules ?? []).entries()) checkCondition(r.condition, `rules.${i}.condition`)
    return d
  }
  function checkCondition(f: string, field: string): void {
    // a syntax check with blank fields (a missing field is blank; a wrong function or operator is an error)
    const r = evaluate(f.trim().startsWith('=') ? f.trim() : `=${f.trim()}`, { resolve: () => null })
    if (!r.ok && /syntax|parse|unknown function|expected/i.test(r.error.message)) throw invalid(`${field}: ${r.error.message}`, field)
  }
  async function savePolicy(ctx: UserContext, id: string | null, raw: unknown): Promise<ApprovalPolicy> {
    if (!ctx.privileges.isMaker) throw new HttpError(403, 'denied', 'Only makers and administrators can change approval policies.')
    const o = (raw ?? {}) as Partial<ApprovalPolicy>
    const name = str(o.name).trim()
    if (!name || name.length > 100) throw invalid('A policy needs a name (at most 100 characters).', 'name')
    const def = checkDefinition(o.definition)
    const at = new Date()
    return db().tx(async () => {
      const dup = await db().query<Row>(`SELECT id FROM ${T('ab_approval_policies')} WHERE lower(name) = lower($1) AND id <> $2`, [name, id ?? ''])
      if (dup.length) throw new HttpError(409, 'conflict', `There is already a policy "${name}".`, 'name')
      if (id) {
        const r = await db().query<Row>(`UPDATE ${T('ab_approval_policies')} SET name = $2, description = $3, definition = $4::jsonb, modified_by = $5, modified_on = $6 WHERE id = $1 RETURNING *`, [id, name, o.description ?? null, JSON.stringify(def), ctx.user.id, at])
        if (!r.length) throw new HttpError(404, 'not-found', 'There is no such policy.')
        await services.meta.audit({ userId: ctx.user.id, action: 'approval.policy.update', details: { id, name } })
        return toPolicy(r[0])
      }
      const pid = newId('apol')
      const r = await db().query<Row>(`INSERT INTO ${T('ab_approval_policies')} (id, name, description, definition, created_by, created_on, modified_by, modified_on) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $5, $6) RETURNING *`, [pid, name, o.description ?? null, JSON.stringify(def), ctx.user.id, at])
      await services.meta.audit({ userId: ctx.user.id, action: 'approval.policy.create', details: { id: pid, name } })
      return toPolicy(r[0])
    })
  }
  async function deletePolicy(ctx: UserContext, id: string): Promise<void> {
    if (!ctx.privileges.isMaker) throw new HttpError(403, 'denied', 'Only makers and administrators can delete approval policies.')
    const n = await db().exec(`DELETE FROM ${T('ab_approval_policies')} WHERE id = $1`, [id])
    if (!n.affectedRows) throw new HttpError(404, 'not-found', 'There is no such policy.')
    await services.meta.audit({ userId: ctx.user.id, action: 'approval.policy.delete', details: { id } })
  }

  /**
   * The definition of a request: the policy's (when named) with the caller's own approvers, type, answers and settings
   * on top. A sequential type with approvers and no stages asks them one after another.
   */
  async function definitionFor(o: { policy?: string | null; approvers?: string[]; type?: ApprovalDefinition['type']; options?: string[]; extra?: Partial<ApprovalDefinition> }): Promise<{ def: ApprovalDefinition; policy: ApprovalPolicy | null }> {
    const pol = o.policy ? await policy(o.policy) : null
    if (o.policy && !pol) throw invalid(`There is no approval policy "${o.policy}".`, 'policy')
    const base: ApprovalDefinition = pol ? structuredClone(pol.definition) : { type: o.type ?? 'single' }
    if (o.type && (!pol || o.type !== base.type)) base.type = o.type
    if (o.approvers?.length) {
      base.approvers = o.approvers
      if (base.type === 'sequential' && !(o.extra?.stages?.length)) base.stages = o.approvers.map((a, i) => ({ name: `Stage ${i + 1}`, approvers: [a] }))
      if (base.type === 'single' && o.approvers.length > 1) base.type = 'any'
    }
    if (o.options?.length) base.responses = responsesOf({}, o.options)
    for (const [k, v] of Object.entries(o.extra ?? {})) if (v !== undefined) (base as unknown as Record<string, unknown>)[k] = v
    return { def: checkDefinition(base), policy: pol }
  }

  /* ---------------------------------------------------------------- rows -> objects */

  const responsesOfRow = (r: Row): ResponseOption[] => responsesOf(json<ApprovalDefinition>(r.definition, { type: 'single' }))
  const defOf = (r: Row): ApprovalDefinition => json<ApprovalDefinition>(r.definition, { type: 'single' })

  async function hist(requestId: string, actor: Actor, action: string, stage: number | null, details: Record<string, unknown> = {}): Promise<void> {
    await db().exec(
      `INSERT INTO ${T('ab_approval_history')} (id, request_id, at, actor_id, actor_kind, action, stage_idx, details) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [newId('ahst'), requestId, now(), actor.id, actor.kind, action, stage, JSON.stringify(details)],
    )
  }

  async function lockRequest(id: string): Promise<Row | null> {
    return (await db().query<Row>(`SELECT * FROM ${T('ab_approval_requests')} WHERE id = $1 FOR UPDATE`, [id]))[0] ?? null
  }

  /* ---------------------------------------------------------------- security */

  /** may this user see the request? (the same rule as the system tables' approvals policy) */
  async function canSee(ctx: UserContext, r: Row): Promise<boolean> {
    if (ctx.privileges.isAdmin) return true
    const me = ctx.user.id
    if (str(r.requested_by) === me) return true
    const a = await db().query<Row>(`SELECT 1 FROM ${T('ab_approval_assignments')} WHERE request_id = $1 AND (user_id = $2 OR reassigned_from = $2) LIMIT 1`, [str(r.id), me])
    if (a.length) return true
    if (!r.regarding_table || !r.regarding_id) return false
    const st = await settings()
    if (!ctx.roles.some((x) => st.viewerRoles.includes(x.id))) return false
    return !!(await readRecord(ctx, str(r.regarding_table), str(r.regarding_id)))
  }

  /** the regarding record as this user may read it (row and column security), or null; never read as the system */
  async function readRecord(ctx: UserContext, tableId: string, rowId: string): Promise<{ table: TableDef; row: Row } | null> {
    const table = await services.meta.tables.get(tableId)
    if (!table) return null
    const t = services.data.internals.physical(table)
    const pred = ctx.rowPredicate(t, 'read')
    if ('const' in pred && !pred.const) return null
    const row = await services.data.internals.findRow(t, rowId, 'const' in pred ? undefined : pred)
    return row ? { table: ctx.visibleDef(t), row: row as Row } : null
  }

  /* ---------------------------------------------------------------- creating */

  function evalCondition(fields: Record<string, unknown>) {
    const byLower = new Map(Object.entries(fields).map(([k, v]) => [k.toLowerCase(), v]))
    return (formula: string): boolean => {
      const src = formula.trim().startsWith('=') ? formula.trim() : `=${formula.trim()}`
      const r = evaluate(src, {
        resolve: (name: string) => {
          if (!byLower.has(name.toLowerCase())) return undefined
          const v = byLower.get(name.toLowerCase())
          if (v === null || v === undefined) return null
          if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v)
          return v as FxValue
        },
      })
      if (!r.ok) throw new RoutingError(`The condition ${formula} cannot be evaluated: ${r.error.message}`)
      return r.value === true
    }
  }

  async function createRequest(input: CreateInput, actor: Actor): Promise<{ id: string; created: boolean }> {
    const title = str(input.title).trim().slice(0, 300)
    if (!title) throw invalid('An approval request needs a title.', 'title')
    const id = input.id ?? newId('appr')
    if (!/^appr_[A-Za-z0-9_-]{6,60}$/.test(id)) throw invalid('The request id must look like appr_<letters and digits>.', 'id')
    const key = input.idempotencyKey ?? (input.id ? `id:${input.id}` : null)
    return db().tx(async () => {
      if (key) {
        // one request per key: a repeated call (flow step retry, app retry) gets the same request
        await db().query('SELECT pg_advisory_xact_lock(hashtext($1))', [`approval:${envId()}:${key}`])
        const ex = await db().query<Row>(`SELECT id, requested_by FROM ${T('ab_approval_requests')} WHERE idempotency_key = $1 OR id = $2`, [key, id])
        if (ex.length) {
          if (input.source !== 'flow' && str(ex[0].requested_by) !== str(input.requestedBy)) throw new HttpError(409, 'conflict', 'This request id is taken.')
          return { id: str(ex[0].id), created: false }
        }
      }
      const at = now()
      const def = input.definition
      const fields = input.fields ?? {}
      const org = await loadOrg()
      let plan: { stages: StagePlan[]; notes: { action: string; text: string }[] }
      try {
        plan = expandStages(def, { requesterId: input.requestedBy, org, evalCondition: evalCondition(fields) })
      } catch (e) {
        if (e instanceof RoutingError) throw invalid(e.message, 'approvers')
        throw e
      }
      const due = def.dueMinutes ? new Date(at.getTime() + def.dueMinutes * 60_000) : input.dueOn ?? null
      const escalateAt = def.escalation && due ? new Date(due.getTime() + (def.escalation.afterMinutes ?? 0) * 60_000) : null
      await db().exec(
        `INSERT INTO ${T('ab_approval_requests')} (id, title, details, fields, regarding_table, regarding_id, requested_by, type, policy_id, definition, status, due_on, current_stage,
           source, flow_id, flow_name, flow_run_id, wait_id, step_key, idempotency_key, escalate_at, created_on, modified_on)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10::jsonb, 'pending', $11, 0, $12, $13, $14, $15, $16, $17, $18, $19, $20, $20)`,
        [id, title, sanitizeRichText(str(input.details).slice(0, 20000)), JSON.stringify(fields), input.regarding?.tableId ?? null, input.regarding?.rowId ?? null, input.requestedBy,
          def.type, input.policyId ?? null, JSON.stringify(def), due, input.source, input.flow?.flowId ?? null, input.flow?.flowName ?? null, input.flow?.runId ?? null,
          input.flow?.waitId ?? null, input.flow?.stepKey ?? null, key, escalateAt, at],
      )
      for (const [i, s] of plan.stages.entries()) {
        await db().exec(`INSERT INTO ${T('ab_approval_stages')} (request_id, idx, name, mode, quorum, refs, status, due_minutes) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'waiting', $7)`, [id, i, s.name, s.mode, s.quorum ?? null, JSON.stringify(s.refs), s.dueMinutes ?? null])
      }
      await hist(id, actor, 'requested', null, { title, source: input.source, stages: plan.stages.map((s) => s.name), ...(input.flow ? { flow: input.flow.flowName, run: input.flow.runId } : {}) })
      for (const n of plan.notes) await hist(id, SYSTEM, n.action, null, { text: n.text })
      const r = (await lockRequest(id))!
      await activateStage(r, 0, new Set())
      if (input.regarding) await services.meta.audit({ userId: input.requestedBy, action: 'approval.request', tableId: input.regarding.tableId, rowId: input.regarding.rowId, details: { id, title } })
      else await services.meta.audit({ userId: input.requestedBy, action: 'approval.request', details: { id, title } })
      return { id, created: true }
    })
  }

  /** starts stage idx (resolving its people now): assignments, notifications; nobody to ask -> the request expires */
  async function activateStage(r: Row, idx: number, previousApprovers: Set<string>): Promise<void> {
    const id = str(r.id)
    const def = defOf(r)
    const st = (await db().query<Row>(`SELECT * FROM ${T('ab_approval_stages')} WHERE request_id = $1 AND idx = $2`, [id, idx]))[0]
    if (!st) return
    const at = now()
    const org = await loadOrg()
    const pol = r.policy_id ? await db().query<Row>(`SELECT id, name FROM ${T('ab_approval_policies')} WHERE id = $1`, [str(r.policy_id)]) : []
    let res: ReturnType<typeof resolveStage>
    try {
      res = resolveStage({ name: str(st.name), mode: str(st.mode) as StagePlan['mode'], quorum: st.quorum === null ? undefined : Number(st.quorum), refs: json<string[]>(st.refs, []) }, {
        org, requesterId: r.requested_by ? str(r.requested_by) : null, allowSelfApproval: !!def.allowSelfApproval, separationOfDuties: !!def.separationOfDuties,
        previousApprovers, delegations: await activeDelegations(at), policyKeys: pol.length ? [str(pol[0].id), str(pol[0].name)] : [],
      })
    } catch (e) {
      if (!(e instanceof RoutingError)) throw e
      await hist(id, SYSTEM, 'routing.failed', idx, { text: e.message })
      await finalize(r, 'expired', 'Expired', null, SYSTEM, { reason: e.message })
      return
    }
    for (const n of res.notes) await hist(id, SYSTEM, n.action, idx, { text: n.text, ...(n.userId ? { user: n.userId } : {}) })
    const remindAt = def.reminders ? new Date(at.getTime() + def.reminders.afterMinutes * 60_000) : null
    const created: string[] = []
    for (const a of res.assignees) {
      const aid = newId('aasg')
      await db().exec(
        `INSERT INTO ${T('ab_approval_assignments')} (id, request_id, stage_idx, user_id, source, status, reassigned_from, delegation_id, note, next_reminder_at, created_on) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10)`,
        [aid, id, idx, a.userId, a.source, a.reassignedFrom ?? null, a.delegationId ?? null, a.note ?? null, remindAt, at],
      )
      await hist(id, SYSTEM, 'asked', idx, { user: a.userId, source: a.source, ...(a.reassignedFrom ? { onBehalfOf: a.reassignedFrom } : {}) })
      created.push(aid)
    }
    // quorum: never more than there are people
    const quorum = st.quorum === null ? null : Math.min(Number(st.quorum), res.assignees.length)
    await db().exec(`UPDATE ${T('ab_approval_stages')} SET status = 'active', started_on = $3, quorum = $4 WHERE request_id = $1 AND idx = $2`, [id, idx, at, quorum])
    await db().exec(`UPDATE ${T('ab_approval_requests')} SET current_stage = $2, modified_on = $3 WHERE id = $1`, [id, idx, at])
    // P1-E: a stage with its own due date: the request is due then while this stage is active (escalation re-armed)
    if (st.due_minutes !== null && st.due_minutes !== undefined && Number(st.due_minutes) > 0) {
      const due = new Date(at.getTime() + Number(st.due_minutes) * 60_000)
      const escAt = def.escalation ? new Date(due.getTime() + (def.escalation.afterMinutes ?? 0) * 60_000) : null
      await db().exec(`UPDATE ${T('ab_approval_requests')} SET due_on = $2, escalate_at = $3 WHERE id = $1`, [id, due, escAt])
    }
    if (idx > 0) await hist(id, SYSTEM, 'stage.started', idx, { name: str(st.name) })
    for (const aid of created) await services.kernel.jobs.enqueue(APPROVAL_NOTIFY_JOB, { requestId: id, assignmentId: aid, kind: 'asked' }, { idempotencyKey: `asked:${aid}`, priority: 1 })
  }

  /* ---------------------------------------------------------------- deciding */

  const assignmentRows = async (requestId: string): Promise<Row[]> =>
    db().query<Row>(`SELECT * FROM ${T('ab_approval_assignments')} WHERE request_id = $1 ORDER BY stage_idx, created_on, id`, [requestId])

  /** the outcome of the current stage after an answer: advance, decide, or wait */
  async function evaluateStage(r: Row, actor: Actor): Promise<void> {
    const id = str(r.id)
    const idx = Number(r.current_stage)
    const def = defOf(r)
    const st = (await db().query<Row>(`SELECT * FROM ${T('ab_approval_stages')} WHERE request_id = $1 AND idx = $2`, [id, idx]))[0]
    if (!st) return
    const all = (await assignmentRows(id)).filter((a) => Number(a.stage_idx) === idx && (a.status === 'pending' || a.status === 'responded'))
    const res = stageOutcome(str(st.mode) as StagePlan['mode'], st.quorum === null ? null : Number(st.quorum), def.rejectOnFirst !== false,
      all.map((a) => ({ responded: a.status === 'responded', kind: (a.response_kind as ResponseKind) ?? null, label: a.response ? str(a.response) : null, at: iso(a.responded_on) })))
    if (!res) return
    const at = now()
    await db().exec(`UPDATE ${T('ab_approval_assignments')} SET status = 'skipped' WHERE request_id = $1 AND stage_idx = $2 AND status = 'pending'`, [id, idx])
    if (res.status === 'approved') {
      await db().exec(`UPDATE ${T('ab_approval_stages')} SET status = 'approved', completed_on = $3 WHERE request_id = $1 AND idx = $2`, [id, idx, at])
      const count = Number((await db().query<Row>(`SELECT count(*)::int AS n FROM ${T('ab_approval_stages')} WHERE request_id = $1`, [id]))[0]?.n ?? 0)
      if (idx + 1 < count) {
        await hist(id, SYSTEM, 'stage.approved', idx, { name: str(st.name) })
        const approvedBy = new Set(all.filter((a) => a.response_kind === 'approve').map((a) => str(a.user_id)))
        await activateStage((await lockRequest(id))!, idx + 1, approvedBy)
        return
      }
      await finalize(r, 'approved', res.label, 'approve', actor)
    } else if (res.status === 'rejected') {
      await db().exec(`UPDATE ${T('ab_approval_stages')} SET status = 'rejected', completed_on = $3 WHERE request_id = $1 AND idx = $2`, [id, idx, at])
      await finalize(r, 'rejected', res.label, 'reject', actor)
    } else {
      await db().exec(`UPDATE ${T('ab_approval_stages')} SET status = 'approved', completed_on = $3 WHERE request_id = $1 AND idx = $2`, [id, idx, at])
      await finalize(r, 'completed', res.label, 'other', actor)
    }
  }

  /** the outcome the waiting flow step gets */
  async function outcomeOf(id: string): Promise<ApprovalOutcome & { status: string }> {
    const r = (await db().query<Row>(`SELECT * FROM ${T('ab_approval_requests')} WHERE id = $1`, [id]))[0]
    const org = await loadOrg()
    const asg = await assignmentRows(id)
    const person = (uid: string) => org.people.get(uid)
    const responded = asg.filter((a) => a.status === 'responded').sort((a, b) => String(iso(a.responded_on)).localeCompare(String(iso(b.responded_on))))
    return {
      outcome: str(r?.outcome), status: str(r?.status), completedOn: iso(r?.completed_on) ?? now().toISOString(),
      responses: responded.map((a) => ({
        userId: str(a.user_id), email: person(str(a.user_id))?.email ?? str(a.user_id), name: person(str(a.user_id))?.name ?? '', response: str(a.response),
        ...(a.comment ? { comment: str(a.comment) } : {}), at: iso(a.responded_on)!, stage: Number(a.stage_idx) + 1,
      })),
      comments: responded.filter((a) => a.comment).map((a) => `${person(str(a.user_id))?.name ?? str(a.user_id)}: ${str(a.comment)}`).join('\n'),
      approvers: asg.map((a) => ({ Approver: person(str(a.user_id))?.email ?? str(a.user_id), Name: person(str(a.user_id))?.name ?? '', Stage: Number(a.stage_idx) + 1, Source: str(a.source), Status: str(a.status) })),
    }
  }

  /**
   * Ends a request: status, outcome; open assignments and stages closed; history; the waiting flow step resumed (unless
   * the flow itself ended it); the decided job (notifications, approvalDecided flows). Inside the caller's transaction.
   */
  async function finalize(r: Row, status: RequestStatus, outcome: string, kind: ResponseKind | null, actor: Actor, o: { reason?: string; fromFlow?: boolean } = {}): Promise<void> {
    const id = str(r.id)
    const at = now()
    await db().exec(`UPDATE ${T('ab_approval_requests')} SET status = $2, outcome = $3, outcome_kind = $4, completed_on = $5, modified_on = $5, escalate_at = NULL, info_from = NULL WHERE id = $1`, [id, status, outcome, kind, at])
    await db().exec(`UPDATE ${T('ab_approval_assignments')} SET status = 'cancelled', next_reminder_at = NULL WHERE request_id = $1 AND status IN ('pending', 'waiting')`, [id])
    await db().exec(`UPDATE ${T('ab_approval_stages')} SET status = CASE WHEN status = 'active' AND $2 IN ('cancelled', 'expired') THEN $2 WHEN status IN ('active', 'waiting') THEN 'skipped' ELSE status END, completed_on = COALESCE(completed_on, $3) WHERE request_id = $1`, [id, status === 'cancelled' ? 'cancelled' : status === 'expired' ? 'escalated' : 'skipped', at])
    await hist(id, actor, status === 'cancelled' ? 'cancelled' : status === 'expired' ? 'expired' : 'decided', Number(r.current_stage), { status, outcome, ...(o.reason ? { reason: o.reason } : {}), ...(actor.kind === 'system' && (status === 'approved' || status === 'rejected') ? { automatic: true } : {}) })
    if (r.wait_id && !o.fromFlow) {
      const out = await outcomeOf(id)
      await services.flows.resumeWait(envId(), str(r.wait_id), { kind: 'approval', ...out })
    }
    await services.kernel.jobs.enqueue(APPROVAL_DECIDED_JOB, { requestId: id }, { idempotencyKey: `decided:${id}`, priority: 1 })
    if (r.regarding_table && r.regarding_id) await services.meta.audit({ userId: actor.id, action: `approval.${status}`, tableId: str(r.regarding_table), rowId: str(r.regarding_id), details: { id, outcome } })
    else await services.meta.audit({ userId: actor.id, action: `approval.${status}`, details: { id, outcome } })
  }

  async function respond(ctx: UserContext, requestId: string, label: string, comment: string | null, o: { linkId?: string; bulk?: boolean } = {}): Promise<{ status: RequestStatus; outcome: string | null }> {
    const text = str(comment).trim().slice(0, 4000)
    const res = await db().tx(async () => {
      const r = await lockRequest(requestId)
      if (!r || !(await canSee(ctx, r))) throw notFound()
      const def = defOf(r)
      if (o.bulk && def.allowBulk === false) throw invalid(`"${str(r.title)}" must be answered on its own (its policy does not allow answering several at once).`)
      const mine = (await assignmentRows(requestId)).filter((a) => str(a.user_id) === ctx.user.id)
      const pending = mine.find((a) => a.status === 'pending' && Number(a.stage_idx) === Number(r.current_stage))
      if (str(r.status) === 'info') throw new HttpError(409, 'conflict', 'This request waits for more information from the requester; you can answer when they replied.')
      if (!isOpenStatus(str(r.status))) throw new HttpError(409, 'conflict', `This request was already ${str(r.status)} (${str(r.outcome) || str(r.status)}). Decisions cannot be changed: ask for a new request to correct it.`)
      if (!pending) {
        if (mine.some((a) => a.status === 'responded')) throw new HttpError(409, 'conflict', 'You already answered this request. Answers cannot be changed.')
        throw new HttpError(403, 'denied', 'You are not asked to decide this request (it may have been reassigned or delegated).')
      }
      const opt = responsesOfRow(r).find((x) => x.label.toLowerCase() === str(label).trim().toLowerCase())
      if (!opt) throw invalid(`"${label}" is not an answer of this request (${responsesOfRow(r).map((x) => x.label).join(', ')}).`, 'response')
      if (opt.requireComment && !text) throw invalid(`A comment is required with "${opt.label}".`, 'comment')
      if (opt.kind === 'info' && !text) throw invalid('Say what information you need.', 'comment')
      const at = now()
      if (o.linkId) await db().exec(`UPDATE ${T('ab_approval_links')} SET used_on = $2 WHERE id = $1`, [o.linkId, at])
      const actor: Actor = { id: ctx.user.id, kind: 'user' }
      if (opt.kind === 'info') {
        await db().exec(`UPDATE ${T('ab_approval_requests')} SET status = 'info', info_from = $2, modified_on = $3 WHERE id = $1`, [requestId, str(pending.id), at])
        await hist(requestId, actor, 'info.requested', Number(r.current_stage), { response: opt.label, comment: text, ...(o.linkId ? { via: 'email' } : {}) })
        await services.kernel.jobs.enqueue(APPROVAL_NOTIFY_JOB, { requestId, kind: 'info', by: ctx.user.id, comment: text }, { idempotencyKey: `info:${requestId}:${at.getTime()}`, priority: 1 })
        return { status: 'info' as RequestStatus, outcome: null }
      }
      await db().exec(`UPDATE ${T('ab_approval_assignments')} SET status = 'responded', response = $2, response_kind = $3, comment = $4, responded_on = $5, next_reminder_at = NULL WHERE id = $1`, [str(pending.id), opt.label, opt.kind, text || null, at])
      await hist(requestId, actor, 'responded', Number(r.current_stage), { response: opt.label, ...(text ? { comment: text } : {}), ...(o.linkId ? { via: 'email' } : {}), ...(o.bulk ? { bulk: true } : {}) })
      await evaluateStage(r, actor)
      const after = (await db().query<Row>(`SELECT status, outcome FROM ${T('ab_approval_requests')} WHERE id = $1`, [requestId]))[0]
      return { status: str(after.status) as RequestStatus, outcome: after.outcome ? str(after.outcome) : null }
    })
    return res
  }

  async function answerInfo(ctx: UserContext, requestId: string, comment: string): Promise<void> {
    const text = str(comment).trim().slice(0, 4000)
    if (!text) throw invalid('Write the information that was asked for.', 'comment')
    await db().tx(async () => {
      const r = await lockRequest(requestId)
      if (!r || !(await canSee(ctx, r))) throw notFound()
      if (str(r.status) !== 'info') throw new HttpError(409, 'conflict', 'Nobody asked for more information on this request.')
      if (str(r.requested_by) !== ctx.user.id && !ctx.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only the requester answers a request for more information.')
      const at = now()
      const asker = r.info_from ? (await db().query<Row>(`SELECT user_id FROM ${T('ab_approval_assignments')} WHERE id = $1`, [str(r.info_from)]))[0] : null
      await db().exec(`UPDATE ${T('ab_approval_requests')} SET status = 'pending', info_from = NULL, modified_on = $2 WHERE id = $1`, [requestId, at])
      await hist(requestId, { id: ctx.user.id, kind: 'user' }, 'info.answered', Number(r.current_stage), { comment: text })
      if (asker) await services.kernel.jobs.enqueue(APPROVAL_NOTIFY_JOB, { requestId, kind: 'infoAnswered', to: str(asker.user_id), comment: text }, { idempotencyKey: `infoans:${requestId}:${at.getTime()}`, priority: 1 })
    })
  }

  /** cancel (withdraw) a request: the requester, an administrator, or the flow (cancel / timeout of its step) */
  async function cancel(ctx: UserContext | null, requestId: string, reason: string, o: { fromFlow?: 'cancelled' | 'timedOut' } = {}): Promise<void> {
    await db().tx(async () => {
      const r = await lockRequest(requestId)
      if (!r) {
        if (o.fromFlow) return
        throw notFound()
      }
      if (ctx && !(await canSee(ctx, r))) throw notFound()
      if (ctx && str(r.requested_by) !== ctx.user.id && !ctx.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only the requester or an administrator can cancel a request.')
      if (!isOpenStatus(str(r.status))) {
        if (o.fromFlow) return
        throw new HttpError(409, 'conflict', `This request was already ${str(r.status)}.`)
      }
      const actor: Actor = ctx ? { id: ctx.user.id, kind: 'user' } : o.fromFlow ? { id: null, kind: 'flow' } : SYSTEM
      if (o.fromFlow === 'timedOut') await finalize(r, 'expired', 'Expired', null, actor, { reason: reason || 'The flow step timed out.', fromFlow: true })
      else await finalize(r, 'cancelled', 'Cancelled', null, actor, { reason: reason || (ctx && str(r.requested_by) === ctx.user.id ? 'Withdrawn by the requester.' : 'Cancelled.'), fromFlow: !!o.fromFlow })
    })
  }

  /** hand a pending assignment to someone else: its holder or an administrator (audited) */
  async function reassign(ctx: UserContext, requestId: string, o: { assignmentId?: string; to: string; comment?: string }): Promise<void> {
    await db().tx(async () => {
      const r = await lockRequest(requestId)
      if (!r || !(await canSee(ctx, r))) throw notFound()
      if (!isOpenStatus(str(r.status))) throw new HttpError(409, 'conflict', `This request was already ${str(r.status)}.`)
      const asg = await assignmentRows(requestId)
      const cur = asg.find((a) => a.status === 'pending' && Number(a.stage_idx) === Number(r.current_stage) && (o.assignmentId ? str(a.id) === o.assignmentId : str(a.user_id) === ctx.user.id))
      if (!cur) throw new HttpError(o.assignmentId ? 404 : 403, o.assignmentId ? 'not-found' : 'denied', o.assignmentId ? 'There is no such open assignment.' : 'You have nothing to reassign on this request.')
      if (str(cur.user_id) !== ctx.user.id && !ctx.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only the person asked or an administrator can reassign.')
      const org = await loadOrg()
      const to = findPerson(org, str(o.to))
      if (!to || to.status === 'disabled') throw invalid(`There is nobody active "${str(o.to)}" in this environment.`, 'to')
      const def = defOf(r)
      if (to.id === str(r.requested_by) && !def.allowSelfApproval) throw invalid(`${to.name} made the request and may not approve it.`, 'to')
      if (asg.some((a) => a.status === 'pending' && Number(a.stage_idx) === Number(r.current_stage) && str(a.user_id) === to.id)) throw invalid(`${to.name} is already asked.`, 'to')
      const at = now()
      const by = org.people.get(ctx.user.id)?.name ?? ctx.user.name
      await db().exec(`UPDATE ${T('ab_approval_assignments')} SET status = 'reassigned', next_reminder_at = NULL WHERE id = $1`, [str(cur.id)])
      const aid = newId('aasg')
      const remindAt = def.reminders ? new Date(at.getTime() + def.reminders.afterMinutes * 60_000) : null
      await db().exec(
        `INSERT INTO ${T('ab_approval_assignments')} (id, request_id, stage_idx, user_id, source, status, reassigned_from, note, next_reminder_at, created_on) VALUES ($1, $2, $3, $4, 'reassigned', 'pending', $5, $6, $7, $8)`,
        [aid, requestId, Number(r.current_stage), to.id, str(cur.user_id), `Reassigned by ${by}${o.comment ? `: ${str(o.comment).slice(0, 500)}` : ''}`, remindAt, at],
      )
      await hist(requestId, { id: ctx.user.id, kind: 'user' }, 'reassigned', Number(r.current_stage), { from: str(cur.user_id), to: to.id, ...(o.comment ? { comment: str(o.comment).slice(0, 500) } : {}), byAdmin: str(cur.user_id) !== ctx.user.id })
      await services.meta.audit({ userId: ctx.user.id, action: 'approval.reassign', details: { id: requestId, from: str(cur.user_id), to: to.id } })
      await services.kernel.jobs.enqueue(APPROVAL_NOTIFY_JOB, { requestId, assignmentId: aid, kind: 'asked' }, { idempotencyKey: `asked:${aid}`, priority: 1 })
    })
  }

  /* ---------------------------------------------------------------- delegations */

  const toDelegation = (r: Row, names: Map<string, string>, at: Date): DelegationInfo => ({
    id: str(r.id), fromUser: str(r.from_user), fromName: names.get(str(r.from_user)), toUser: str(r.to_user), toName: names.get(str(r.to_user)),
    startsOn: iso(r.starts_on)!, endsOn: iso(r.ends_on), policies: json<string[]>(r.policies, []), note: r.note ? str(r.note) : null,
    active: !r.cancelled_on && new Date(str(iso(r.starts_on))).getTime() <= at.getTime() && (!r.ends_on || new Date(str(iso(r.ends_on))).getTime() > at.getTime()),
    createdOn: iso(r.created_on)!, createdBy: r.created_by ? str(r.created_by) : null, cancelledOn: iso(r.cancelled_on),
  })

  async function listDelegations(ctx: UserContext, o: { all?: boolean } = {}): Promise<DelegationInfo[]> {
    const all = o.all && ctx.privileges.isAdmin
    const rows = await db().query<Row>(`SELECT * FROM ${T('ab_approval_delegations')} ${all ? '' : 'WHERE from_user = $1 OR to_user = $1'} ORDER BY created_on DESC LIMIT 500`, all ? [] : [ctx.user.id])
    const org = await loadOrg()
    const names = new Map([...org.people.values()].map((p) => [p.id, p.name]))
    return rows.map((r) => toDelegation(r, names, now()))
  }

  async function createDelegation(ctx: UserContext, raw: unknown): Promise<DelegationInfo> {
    const o = (raw ?? {}) as { fromUser?: string; toUser?: string; startsOn?: string; endsOn?: string | null; policies?: string[]; note?: string }
    const org = await loadOrg()
    const from = o.fromUser ? findPerson(org, o.fromUser) : org.people.get(ctx.user.id)
    if (!from) throw invalid('There is no such person.', 'fromUser')
    if (from.id !== ctx.user.id && !ctx.privileges.isAdmin) throw new HttpError(403, 'denied', 'You can only delegate your own approvals (administrators can delegate for others).')
    const to = o.toUser ? findPerson(org, o.toUser) : undefined
    if (!to || to.status === 'disabled') throw invalid('Choose an active person in this environment to delegate to.', 'toUser')
    if (to.id === from.id) throw invalid('You cannot delegate to yourself.', 'toUser')
    const at = now()
    const starts = o.startsOn ? new Date(o.startsOn) : at
    const ends = o.endsOn ? new Date(o.endsOn) : null
    if (Number.isNaN(starts.getTime())) throw invalid('startsOn is not a date and time.', 'startsOn')
    if (ends && (Number.isNaN(ends.getTime()) || ends.getTime() <= starts.getTime())) throw invalid('endsOn must be after startsOn.', 'endsOn')
    const policies = Array.isArray(o.policies) ? o.policies.map(String).filter(Boolean).slice(0, 50) : []
    const id = newId('adlg')
    await db().tx(async () => {
      await db().exec(
        `INSERT INTO ${T('ab_approval_delegations')} (id, from_user, to_user, starts_on, ends_on, policies, note, created_by, created_on) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
        [id, from.id, to.id, starts, ends, JSON.stringify(policies), o.note ? str(o.note).slice(0, 300) : null, ctx.user.id, at],
      )
      await services.meta.audit({ userId: ctx.user.id, action: 'approval.delegation.create', details: { id, from: from.id, to: to.id, startsOn: starts.toISOString(), endsOn: ends?.toISOString() ?? null, policies } })
    })
    await applyDelegations()
    const r = (await db().query<Row>(`SELECT * FROM ${T('ab_approval_delegations')} WHERE id = $1`, [id]))[0]
    return toDelegation(r, new Map([[from.id, from.name], [to.id, to.name]]), now())
  }

  async function cancelDelegation(ctx: UserContext, id: string): Promise<void> {
    await db().tx(async () => {
      const r = (await db().query<Row>(`SELECT * FROM ${T('ab_approval_delegations')} WHERE id = $1 FOR UPDATE`, [id]))[0]
      if (!r || (str(r.from_user) !== ctx.user.id && !ctx.privileges.isAdmin)) throw new HttpError(404, 'not-found', 'There is no such delegation.')
      if (r.cancelled_on) return
      await db().exec(`UPDATE ${T('ab_approval_delegations')} SET cancelled_on = $2 WHERE id = $1`, [id, now()])
      await services.meta.audit({ userId: ctx.user.id, action: 'approval.delegation.cancel', details: { id } })
    })
    await applyDelegations()
  }

  /**
   * Delegations that started: the pending assignments of the person (in open requests of the policies it covers) go to
   * the delegate (retroactively). Delegations that ended or were cancelled: what is still pending with the delegate
   * because of it goes back. Each delegation is applied once at its start and once at its end.
   */
  async function applyDelegations(): Promise<number> {
    let changed = 0
    const at = now()
    const starting = await db().query<Row>(`SELECT id FROM ${T('ab_approval_delegations')} WHERE NOT started_applied AND cancelled_on IS NULL AND starts_on <= $1 AND (ends_on IS NULL OR ends_on > $1)`, [at])
    for (const d0 of starting) {
      await db().tx(async () => {
        const d = (await db().query<Row>(`SELECT * FROM ${T('ab_approval_delegations')} WHERE id = $1 AND NOT started_applied FOR UPDATE SKIP LOCKED`, [str(d0.id)]))[0]
        if (!d) return
        const policies = json<string[]>(d.policies, []).map((p) => p.toLowerCase())
        const open = await db().query<Row>(
          `SELECT a.id AS aid, r.id AS rid, p.name AS pname FROM ${T('ab_approval_assignments')} a JOIN ${T('ab_approval_requests')} r ON r.id = a.request_id
             LEFT JOIN ${T('ab_approval_policies')} p ON p.id = r.policy_id
            WHERE a.user_id = $1 AND a.status = 'pending' AND r.status IN ('pending', 'info') AND a.stage_idx = r.current_stage`, [str(d.from_user)])
        for (const o of open) {
          if (policies.length && !policies.includes(str(o.pname).toLowerCase()) && !policies.includes(str(o.rid).toLowerCase())) continue
          const r = await lockRequest(str(o.rid))
          if (!r || !isOpenStatus(str(r.status))) continue
          if (str(d.to_user) === str(r.requested_by) && !defOf(r).allowSelfApproval) {
            await hist(str(r.id), SYSTEM, 'delegation.skipped', Number(r.current_stage), { text: 'The delegate made this request; it stays with the person asked.', delegation: str(d.id) })
            continue
          }
          if (await moveAssignment(r, str(o.aid), str(d.to_user), 'delegation', str(d.id), 'delegated')) changed++
        }
        await db().exec(`UPDATE ${T('ab_approval_delegations')} SET started_applied = true WHERE id = $1`, [str(d.id)])
      })
    }
    const ending = await db().query<Row>(`SELECT id FROM ${T('ab_approval_delegations')} WHERE NOT ended_applied AND (cancelled_on IS NOT NULL OR (ends_on IS NOT NULL AND ends_on <= $1))`, [at])
    for (const d0 of ending) {
      await db().tx(async () => {
        const d = (await db().query<Row>(`SELECT * FROM ${T('ab_approval_delegations')} WHERE id = $1 AND NOT ended_applied FOR UPDATE SKIP LOCKED`, [str(d0.id)]))[0]
        if (!d) return
        if (d.started_applied) {
          const open = await db().query<Row>(
            `SELECT a.id AS aid, r.id AS rid FROM ${T('ab_approval_assignments')} a JOIN ${T('ab_approval_requests')} r ON r.id = a.request_id
              WHERE a.delegation_id = $1 AND a.status = 'pending' AND r.status IN ('pending', 'info') AND a.stage_idx = r.current_stage`, [str(d.id)])
          for (const o of open) {
            const r = await lockRequest(str(o.rid))
            if (r && isOpenStatus(str(r.status)) && (await moveAssignment(r, str(o.aid), str(d.from_user), 'reassigned', null, 'delegation.ended'))) changed++
          }
        }
        await db().exec(`UPDATE ${T('ab_approval_delegations')} SET ended_applied = true, started_applied = true WHERE id = $1`, [str(d.id)])
      })
    }
    return changed
  }

  /** moves a pending assignment to another person (inside a transaction with the request locked) */
  async function moveAssignment(r: Row, assignmentId: string, toUser: string, source: string, delegationId: string | null, action: string): Promise<boolean> {
    const a = (await db().query<Row>(`SELECT * FROM ${T('ab_approval_assignments')} WHERE id = $1 FOR UPDATE`, [assignmentId]))[0]
    if (!a || a.status !== 'pending') return false
    const at = now()
    const def = defOf(r)
    await db().exec(`UPDATE ${T('ab_approval_assignments')} SET status = 'reassigned', next_reminder_at = NULL WHERE id = $1`, [assignmentId])
    const dup = await db().query<Row>(`SELECT id FROM ${T('ab_approval_assignments')} WHERE request_id = $1 AND stage_idx = $2 AND user_id = $3 AND status = 'pending'`, [str(r.id), Number(a.stage_idx), toUser])
    const org = await loadOrg()
    const fromName = org.people.get(str(a.user_id))?.name ?? str(a.user_id)
    await hist(str(r.id), SYSTEM, action, Number(a.stage_idx), { from: str(a.user_id), to: toUser, ...(delegationId ? { delegation: delegationId } : {}) })
    if (dup.length) return true
    const aid = newId('aasg')
    const remindAt = def.reminders ? new Date(at.getTime() + def.reminders.afterMinutes * 60_000) : null
    await db().exec(
      `INSERT INTO ${T('ab_approval_assignments')} (id, request_id, stage_idx, user_id, source, status, reassigned_from, delegation_id, note, next_reminder_at, created_on) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10)`,
      [aid, str(r.id), Number(a.stage_idx), toUser, source, str(a.user_id), delegationId, action === 'delegated' ? `On behalf of ${fromName} (delegation).` : action === 'delegation.ended' ? 'The delegation ended: back to the person first asked.' : null, remindAt, at],
    )
    await services.kernel.jobs.enqueue(APPROVAL_NOTIFY_JOB, { requestId: str(r.id), assignmentId: aid, kind: 'asked' }, { idempotencyKey: `asked:${aid}`, priority: 1 })
    return true
  }

  /* ---------------------------------------------------------------- reminders and escalation */

  async function sendReminders(): Promise<number> {
    const at = now()
    const due = await db().query<Row>(
      `SELECT a.id FROM ${T('ab_approval_assignments')} a JOIN ${T('ab_approval_requests')} r ON r.id = a.request_id
        WHERE a.status = 'pending' AND a.next_reminder_at IS NOT NULL AND a.next_reminder_at <= $1 AND r.status = 'pending' LIMIT 200`, [at])
    let n = 0
    for (const x of due) {
      await db().tx(async () => {
        const a = (await db().query<Row>(`SELECT * FROM ${T('ab_approval_assignments')} WHERE id = $1 AND status = 'pending' AND next_reminder_at <= $2 FOR UPDATE SKIP LOCKED`, [str(x.id), at]))[0]
        if (!a) return
        const r = (await db().query<Row>(`SELECT * FROM ${T('ab_approval_requests')} WHERE id = $1`, [str(a.request_id)]))[0]
        const rem = defOf(r).reminders
        const sent = Number(a.reminders_sent) + 1
        const max = rem?.max ?? 3
        const next = rem?.everyMinutes && sent < max ? new Date(at.getTime() + rem.everyMinutes * 60_000) : null
        await db().exec(`UPDATE ${T('ab_approval_assignments')} SET reminders_sent = $2, next_reminder_at = $3 WHERE id = $1`, [str(a.id), sent, next])
        await hist(str(r.id), SYSTEM, 'reminded', Number(a.stage_idx), { user: str(a.user_id), n: sent })
        await services.kernel.jobs.enqueue(APPROVAL_NOTIFY_JOB, { requestId: str(r.id), assignmentId: str(a.id), kind: 'reminder' }, { idempotencyKey: `remind:${str(a.id)}:${sent}`, priority: 1 })
        n++
      })
    }
    return n
  }

  async function escalateDue(): Promise<number> {
    const at = now()
    const due = await db().query<Row>(`SELECT id FROM ${T('ab_approval_requests')} WHERE status = 'pending' AND escalate_at IS NOT NULL AND escalate_at <= $1 LIMIT 100`, [at])
    let n = 0
    for (const x of due) {
      await db().tx(async () => {
        const r = (await db().query<Row>(`SELECT * FROM ${T('ab_approval_requests')} WHERE id = $1 AND status = 'pending' AND escalate_at <= $2 FOR UPDATE SKIP LOCKED`, [str(x.id), at]))[0]
        if (!r) return
        await escalate(r)
        n++
      })
    }
    return n
  }

  /** the escalation of an overdue request (system actor; automatic decisions are recorded as such) */
  async function escalate(r: Row): Promise<void> {
    const id = str(r.id)
    const def = defOf(r)
    const e = def.escalation
    const idx = Number(r.current_stage)
    const at = now()
    await db().exec(`UPDATE ${T('ab_approval_requests')} SET escalate_at = NULL, escalated_on = $2, modified_on = $2 WHERE id = $1`, [id, at])
    if (!e) return
    await hist(id, SYSTEM, 'escalated', idx, { action: e.action, ...(e.to ? { to: e.to } : {}) })
    const responses = responsesOfRow(r)
    const org = await loadOrg()
    const pending = (await assignmentRows(id)).filter((a) => a.status === 'pending' && Number(a.stage_idx) === idx)
    const pol = r.policy_id ? await db().query<Row>(`SELECT id, name FROM ${T('ab_approval_policies')} WHERE id = $1`, [str(r.policy_id)]) : []
    const delegations = await activeDelegations(at)
    const addFor = async (old: Row | null, target: string, note0: string) => {
      if (old) await db().exec(`UPDATE ${T('ab_approval_assignments')} SET status = 'escalated', next_reminder_at = NULL WHERE id = $1`, [str(old.id)])
      // a delegation of the escalation target is honoured too
      const dl = delegateOf(target, { delegations, policyKeys: pol.length ? [str(pol[0].id), str(pol[0].name)] : [], org, requesterId: r.requested_by ? str(r.requested_by) : null, allowSelfApproval: !!def.allowSelfApproval })
      const toUser = dl?.userId ?? target
      const note = dl ? `${note0} On behalf of ${org.people.get(target)?.name ?? target} (delegation).` : note0
      const exists = await db().query<Row>(`SELECT id FROM ${T('ab_approval_assignments')} WHERE request_id = $1 AND stage_idx = $2 AND user_id = $3 AND status IN ('pending', 'responded')`, [id, idx, toUser])
      if (exists.length) return
      const aid = newId('aasg')
      await db().exec(
        `INSERT INTO ${T('ab_approval_assignments')} (id, request_id, stage_idx, user_id, source, status, reassigned_from, delegation_id, note, created_on) VALUES ($1, $2, $3, $4, 'escalation', 'pending', $5, $6, $7, $8)`,
        [aid, id, idx, toUser, old ? str(old.user_id) : null, dl?.delegationId ?? null, note, at],
      )
      await hist(id, SYSTEM, 'asked', idx, { user: toUser, source: 'escalation', ...(old ? { instead: str(old.user_id) } : {}) })
      await services.kernel.jobs.enqueue(APPROVAL_NOTIFY_JOB, { requestId: id, assignmentId: aid, kind: 'escalated' }, { idempotencyKey: `asked:${aid}`, priority: 1 })
    }
    switch (e.action) {
      case 'manager': {
        for (const a of pending) {
          const m = managersOf(org, str(a.user_id)).find((p) => p.status !== 'disabled' && (def.allowSelfApproval || p.id !== str(r.requested_by)))
          if (m) await addFor(a, m.id, `Overdue: escalated to the manager of ${org.people.get(str(a.user_id))?.name ?? str(a.user_id)}.`)
          else await hist(id, SYSTEM, 'escalation.skipped', idx, { text: `${org.people.get(str(a.user_id))?.name ?? str(a.user_id)} has no manager on record; they stay asked.` })
        }
        break
      }
      case 'user': {
        const to = e.to ? findPerson(org, e.to) : undefined
        if (!to || to.status === 'disabled') {
          await hist(id, SYSTEM, 'escalation.skipped', idx, { text: `There is nobody active "${e.to ?? ''}" to escalate to.` })
          break
        }
        for (const [i, a] of pending.entries()) {
          if (i === 0) await addFor(a, to.id, 'Overdue: escalated.')
          else await db().exec(`UPDATE ${T('ab_approval_assignments')} SET status = 'escalated', next_reminder_at = NULL WHERE id = $1`, [str(a.id)])
        }
        if (!pending.length) await addFor(null, to.id, 'Overdue: escalated.')
        break
      }
      case 'nextStage': {
        await db().exec(`UPDATE ${T('ab_approval_assignments')} SET status = 'escalated', next_reminder_at = NULL WHERE request_id = $1 AND stage_idx = $2 AND status = 'pending'`, [id, idx])
        await db().exec(`UPDATE ${T('ab_approval_stages')} SET status = 'escalated', completed_on = $3 WHERE request_id = $1 AND idx = $2`, [id, idx, at])
        const count = Number((await db().query<Row>(`SELECT count(*)::int AS n FROM ${T('ab_approval_stages')} WHERE request_id = $1`, [id]))[0]?.n ?? 0)
        if (idx + 1 < count) {
          if (def.dueMinutes) await db().exec(`UPDATE ${T('ab_approval_requests')} SET due_on = $2, escalate_at = $3 WHERE id = $1`, [id, new Date(at.getTime() + def.dueMinutes * 60_000), new Date(at.getTime() + (def.dueMinutes + (e.afterMinutes ?? 0)) * 60_000)])
          await activateStage((await lockRequest(id))!, idx + 1, new Set())
        } else await finalize((await lockRequest(id))!, 'expired', 'Expired', null, SYSTEM, { reason: 'Overdue in the last stage (escalation: next stage).' })
        break
      }
      case 'approve':
        await finalize((await lockRequest(id))!, 'approved', responses.find((x) => x.kind === 'approve')?.label ?? 'Approve', 'approve', SYSTEM, { reason: 'Approved automatically: overdue (escalation).' })
        break
      case 'reject':
        await finalize((await lockRequest(id))!, 'rejected', responses.find((x) => x.kind === 'reject')?.label ?? 'Reject', 'reject', SYSTEM, { reason: 'Rejected automatically: overdue (escalation).' })
        break
      case 'expire':
        await finalize((await lockRequest(id))!, 'expired', 'Expired', null, SYSTEM, { reason: 'Overdue (escalation: expire).' })
        break
    }
    if (r.requested_by) await services.kernel.jobs.enqueue(APPROVAL_NOTIFY_JOB, { requestId: id, kind: 'escalatedRequester' }, { idempotencyKey: `escreq:${id}:${at.getTime()}`, priority: 1 })
  }

  /** one pass: delegations, reminders, escalations (worker rounds; tests call it after moving the clock) */
  let lastTick = new Map<string, number>()
  async function tick(force = false): Promise<{ delegations: number; reminders: number; escalations: number }> {
    const env = envId()
    if (!force && Date.now() - (lastTick.get(env) ?? 0) < 2000) return { delegations: 0, reminders: 0, escalations: 0 }
    lastTick.set(env, Date.now())
    const delegations = await applyDelegations()
    const reminders = await sendReminders()
    const escalations = await escalateDue()
    return { delegations, reminders, escalations }
  }

  /* ---------------------------------------------------------------- email links */

  let keyCache: Buffer | null = null
  const linkKey = (): Buffer => (keyCache ??= createHmac('sha256', loadSecretKey(services.config.workspaceDir)).update('appbuilder.approval-link.v1').digest())
  function signLink(payload: { e: string; l: string }): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    return `${body}.${createHmac('sha256', linkKey()).update(body).digest('base64url')}`
  }
  function verifyLink(token: unknown): { e: string; l: string } | null {
    if (typeof token !== 'string' || token.length > 400) return null
    const [body, mac] = token.split('.')
    if (!body || !mac) return null
    const want = Buffer.from(createHmac('sha256', linkKey()).update(body).digest('base64url'))
    const got = Buffer.from(mac)
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null
    try {
      const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { e?: unknown; l?: unknown }
      return typeof v.e === 'string' && typeof v.l === 'string' ? { e: v.e, l: v.l } : null
    } catch {
      return null
    }
  }

  /** one link per answer for one assignment: single use, expiring, bound to the person */
  async function makeLinks(requestId: string, assignmentId: string, userId: string, responses: ResponseOption[]): Promise<{ label: string; token: string }[]> {
    const st = await settings()
    const at = now()
    const out: { label: string; token: string }[] = []
    for (const r of responses) {
      const id = randomBytes(16).toString('hex')
      await db().exec(`INSERT INTO ${T('ab_approval_links')} (id, request_id, assignment_id, user_id, response, expires_on, created_on) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, requestId, assignmentId, userId, r.label, new Date(at.getTime() + st.linkHours * 3600_000), at])
      out.push({ label: r.label, token: signLink({ e: envId(), l: id }) })
    }
    return out
  }

  /** checks a link for the signed-in user: what it would answer, or why it cannot */
  async function inspectLink(ctx: UserContext, token: unknown): Promise<{ ok: true; link: Row; request: Row; option: ResponseOption } | { ok: false; reason: string; code: 'invalid' | 'used' | 'expired' | 'other-user' | 'decided' | 'environment'; environmentId?: string }> {
    const p = verifyLink(token)
    if (!p) return { ok: false, code: 'invalid', reason: 'This link is not valid (it may have been cut off in the email).' }
    if (p.e !== ctx.environmentId) return { ok: false, code: 'environment', reason: 'This link belongs to another environment.', environmentId: p.e }
    const link = (await db().query<Row>(`SELECT * FROM ${T('ab_approval_links')} WHERE id = $1`, [p.l]))[0]
    if (!link) return { ok: false, code: 'invalid', reason: 'This link is not valid any more.' }
    if (str(link.user_id) !== ctx.user.id) return { ok: false, code: 'other-user', reason: 'This link was sent to someone else. Sign in as the person it was sent to.' }
    if (link.used_on) return { ok: false, code: 'used', reason: 'This link was already used. Each link answers once.' }
    if (new Date(str(iso(link.expires_on))).getTime() < now().getTime()) return { ok: false, code: 'expired', reason: 'This link has expired. Open the request in Approvals to answer it.' }
    const r = (await db().query<Row>(`SELECT * FROM ${T('ab_approval_requests')} WHERE id = $1`, [str(link.request_id)]))[0]
    const a = (await db().query<Row>(`SELECT * FROM ${T('ab_approval_assignments')} WHERE id = $1`, [str(link.assignment_id)]))[0]
    if (!r || !a) return { ok: false, code: 'invalid', reason: 'This request no longer exists.' }
    if (!isOpenStatus(str(r.status))) return { ok: false, code: 'decided', reason: `This request was already ${str(r.status)}.` }
    if (a.status !== 'pending') return { ok: false, code: 'decided', reason: a.status === 'responded' ? 'You already answered this request.' : 'You are no longer asked to decide this request (it was reassigned, delegated or decided).' }
    const option = responsesOfRow(r).find((x) => x.label === str(link.response))
    if (!option) return { ok: false, code: 'invalid', reason: 'This answer is no longer offered.' }
    return { ok: true, link, request: r, option }
  }

  async function useLink(ctx: UserContext, token: unknown, comment: string | null): Promise<{ status: RequestStatus; outcome: string | null; requestId: string }> {
    const i = await inspectLink(ctx, token)
    if (!i.ok) throw new HttpError(i.code === 'other-user' ? 403 : i.code === 'invalid' ? 404 : 409, i.code === 'other-user' ? 'denied' : i.code === 'invalid' ? 'not-found' : 'conflict', i.reason)
    // single use: the link row is locked and marked used in the same transaction as the answer
    return db().tx(async () => {
      const l = (await db().query<Row>(`SELECT used_on FROM ${T('ab_approval_links')} WHERE id = $1 FOR UPDATE`, [str(i.link.id)]))[0]
      if (!l || l.used_on) throw new HttpError(409, 'conflict', 'This link was already used. Each link answers once.')
      const res = await respond(ctx, str(i.request.id), i.option.label, comment, { linkId: str(i.link.id) })
      return { ...res, requestId: str(i.request.id) }
    })
  }

  /* ---------------------------------------------------------------- notifications (jobs) */

  async function notifyJob(p: { requestId: string; assignmentId?: string; kind: string; by?: string; to?: string; comment?: string }): Promise<unknown> {
    const r = (await db().query<Row>(`SELECT * FROM ${T('ab_approval_requests')} WHERE id = $1`, [p.requestId]))[0]
    const notifications = services.notifications
    if (!r || !notifications) return { skipped: 'no request or no notifications' }
    const org = await loadOrg()
    const link = `#u-approvals?id=${encodeURIComponent(str(r.id))}`
    const requester = r.requested_by ? org.people.get(str(r.requested_by)) : undefined
    const send = async (userId: string, title: string, body: string, actions?: { label: string; url: string }[]) => {
      await notifications.notify({ userIds: [userId] }, {
        kind: 'approval', title: title.slice(0, 200), body: body.slice(0, 2000), link, environmentId: envId(), source: `approval:${str(r.id)}`,
        ...(requester ? { from: { id: requester.id, name: requester.name } } : {}), ...(actions?.length ? { emailActions: actions } : {}),
      })
    }
    const fieldsText = Object.entries(json<Record<string, unknown>>(r.fields, {})).map(([k, v]) => `${k}: ${v === null ? '' : String(v)}`).join('\n')
    const bodyOf = () => [requester ? `Requested by ${requester.name}.` : '', r.due_on ? `Due ${new Date(str(iso(r.due_on))).toUTCString().replace(/:00 GMT$/, ' UTC')}.` : '', fieldsText].filter(Boolean).join('\n')
    if (p.kind === 'asked' || p.kind === 'reminder' || p.kind === 'escalated') {
      const a = (await db().query<Row>(`SELECT * FROM ${T('ab_approval_assignments')} WHERE id = $1`, [p.assignmentId]))[0]
      if (!a || a.status !== 'pending' || !isOpenStatus(str(r.status))) return { skipped: 'not pending' }
      let actions: { label: string; url: string }[] = []
      try {
        const { identity } = await import('../identity/index.ts')
        const b = await identity(services).mail.brand()
        if (b.publicUrl) actions = (await makeLinks(str(r.id), str(a.id), str(a.user_id), responsesOfRow(r))).map((x) => ({ label: x.label, url: `${b.publicUrl}/#u-approvals?link=${x.token}` }))
      } catch (e) {
        log('warn', `approval links: ${errText(e)}`)
      }
      const prefix = p.kind === 'reminder' ? 'Reminder: approval needed: ' : p.kind === 'escalated' ? 'Overdue approval needs you: ' : 'Approval needed: '
      await send(str(a.user_id), `${prefix}${str(r.title)}`, [a.note ? str(a.note) : '', bodyOf()].filter(Boolean).join('\n'), actions)
      return { sent: 1 }
    }
    if (p.kind === 'info' && r.requested_by) {
      const by = p.by ? org.people.get(p.by)?.name ?? '' : ''
      await send(str(r.requested_by), `More information needed: ${str(r.title)}`, `${by} asks: ${p.comment ?? ''}`)
      return { sent: 1 }
    }
    if (p.kind === 'infoAnswered' && p.to) {
      await send(p.to, `Information added: ${str(r.title)}`, `${requester?.name ?? 'The requester'} answered: ${p.comment ?? ''}`)
      return { sent: 1 }
    }
    if (p.kind === 'escalatedRequester' && r.requested_by && isOpenStatus(str(r.status))) {
      await send(str(r.requested_by), `Your approval request is overdue: ${str(r.title)}`, 'It was escalated.')
      return { sent: 1 }
    }
    return { skipped: p.kind }
  }

  /** after a request ended: tell the requester and the people still asked; start approvalDecided flows */
  async function decidedJob(p: { requestId: string }): Promise<unknown> {
    const r = (await db().query<Row>(`SELECT * FROM ${T('ab_approval_requests')} WHERE id = $1`, [p.requestId]))[0]
    if (!r) return { skipped: 'gone' }
    const status = str(r.status)
    const org = await loadOrg()
    const asg = await assignmentRows(p.requestId)
    const notifications = services.notifications
    const link = `#u-approvals?id=${encodeURIComponent(str(r.id))}`
    if (notifications && r.requested_by) {
      const word = status === 'approved' ? 'approved' : status === 'rejected' ? 'rejected' : status === 'completed' ? `answered "${str(r.outcome)}"` : status
      const last = asg.filter((a) => a.status === 'responded').sort((a, b) => String(iso(b.responded_on)).localeCompare(String(iso(a.responded_on))))[0]
      const body = last ? `${org.people.get(str(last.user_id))?.name ?? ''}: ${str(last.response)}${last.comment ? ` - ${str(last.comment)}` : ''}` : ''
      await notifications.notify({ userIds: [str(r.requested_by)] }, { kind: 'approval', title: `Your request was ${word}: ${str(r.title)}`.slice(0, 200), body, link, environmentId: envId(), source: `approval:${str(r.id)}` }).catch((e) => log('warn', `approval decided notification: ${errText(e)}`))
    }
    // people whose answer is no longer needed
    const told = new Set<string>()
    if (notifications) {
      for (const a of asg) {
        if (a.status !== 'cancelled' && a.status !== 'skipped') continue
        const u = str(a.user_id)
        if (told.has(u) || u === str(r.requested_by)) continue
        told.add(u)
        await notifications.notify({ userIds: [u] }, { kind: 'approval', title: `No answer needed any more: ${str(r.title)}`.slice(0, 200), body: `The request was ${status}.`, link, environmentId: envId(), source: `approval:${str(r.id)}` }).catch(() => {})
      }
    }
    const out = await outcomeOf(p.requestId)
    const pol = r.policy_id ? (await db().query<Row>(`SELECT name FROM ${T('ab_approval_policies')} WHERE id = $1`, [str(r.policy_id)]))[0] : null
    const requester = r.requested_by ? org.people.get(str(r.requested_by)) : undefined
    const t = await services.flows.triggerApprovalDecided(envId(), {
      requestId: str(r.id), status, policyId: r.policy_id ? str(r.policy_id) : null, policyName: pol ? str(pol.name) : null,
      request: {
        Id: str(r.id), Title: str(r.title), Status: status, Outcome: str(r.outcome), RequestedBy: str(r.requested_by), RequestedByEmail: requester?.email ?? '', Policy: pol ? str(pol.name) : '',
        RegardingTable: str(r.regarding_table), RegardingId: str(r.regarding_id), CompletedOn: iso(r.completed_on), Fields: json<Record<string, unknown>>(r.fields, {}),
      },
      responses: (out.responses ?? []).map((x) => ({ Approver: x.email ?? x.userId, Name: x.name ?? '', Response: x.response, Comment: x.comment ?? '', Time: x.at, Stage: x.stage ?? 1, UserId: x.userId })),
    })
    return { flows: t.runIds.length }
  }

  /* ---------------------------------------------------------------- reading */

  async function info(ctx: UserContext, r: Row, org: OrgData, asg?: Row[], polNames?: Map<string, string>, tableNames?: Map<string, string>): Promise<ApprovalRequestInfo> {
    const id = str(r.id)
    const def = defOf(r)
    const list = asg ?? (await assignmentRows(id))
    const mine = list.find((a) => str(a.user_id) === ctx.user.id && a.status === 'pending' && Number(a.stage_idx) === Number(r.current_stage))
    const open = isOpenStatus(str(r.status))
    return {
      id, title: str(r.title), details: str(r.details), fields: json<Record<string, unknown>>(r.fields, {}),
      regardingTable: r.regarding_table ? str(r.regarding_table) : null, regardingId: r.regarding_id ? str(r.regarding_id) : null,
      regardingTableName: r.regarding_table ? tableNames?.get(str(r.regarding_table)) ?? null : null,
      requestedBy: r.requested_by ? str(r.requested_by) : null, requestedByName: r.requested_by ? org.people.get(str(r.requested_by))?.name ?? null : null,
      type: str(r.type) as ApprovalRequestInfo['type'], policyId: r.policy_id ? str(r.policy_id) : null, policyName: r.policy_id ? polNames?.get(str(r.policy_id)) ?? null : null,
      status: str(r.status) as RequestStatus, outcome: r.outcome ? str(r.outcome) : null, dueOn: iso(r.due_on), currentStage: Number(r.current_stage),
      source: str(r.source) as ApprovalRequestInfo['source'], flowId: r.flow_id ? str(r.flow_id) : null, flowName: r.flow_name ? str(r.flow_name) : null,
      flowRunId: r.flow_run_id ? str(r.flow_run_id) : null, createdOn: iso(r.created_on)!, completedOn: iso(r.completed_on),
      responses: responsesOfRow(r), allowBulk: def.allowBulk !== false, requireCommentOnReject: !!def.requireCommentOnReject,
      myAssignment: mine ? { id: str(mine.id), stage: Number(mine.stage_idx), status: str(mine.status) as AssignmentStatus } : null,
      canDecide: !!mine && str(r.status) === 'pending',
      canCancel: open && (str(r.requested_by) === ctx.user.id || ctx.privileges.isAdmin),
      canReassign: open && (!!mine || ctx.privileges.isAdmin),
      canAnswerInfo: str(r.status) === 'info' && (str(r.requested_by) === ctx.user.id || ctx.privileges.isAdmin),
    }
  }

  async function lookups(): Promise<{ polNames: Map<string, string>; tableNames: Map<string, string> }> {
    const polNames = new Map((await db().query<Row>(`SELECT id, name FROM ${T('ab_approval_policies')}`)).map((p) => [str(p.id), str(p.name)]))
    const tableNames = new Map((await services.meta.tables.list()).map((t) => [t.id, t.displayName ?? t.name]))
    return { polNames, tableNames }
  }

  async function list(ctx: UserContext, o: { view: 'toApprove' | 'sentByMe' | 'all' | 'involved'; status?: string; q?: string; policy?: string; before?: string; limit?: number; regarding?: string }): Promise<{ items: ApprovalRequestInfo[]; nextBefore: string | null }> {
    const limit = Math.max(1, Math.min(200, Math.trunc(o.limit ?? 50) || 50))
    const params: unknown[] = []
    const where: string[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }
    if (o.view === 'toApprove') where.push(`EXISTS (SELECT 1 FROM ${T('ab_approval_assignments')} a WHERE a.request_id = r.id AND a.user_id = ${p(ctx.user.id)} AND a.status = 'pending' AND a.stage_idx = r.current_stage) AND r.status IN ('pending', 'info')`)
    else if (o.view === 'sentByMe') where.push(`r.requested_by = ${p(ctx.user.id)}`)
    else if (o.view === 'involved') where.push(`(r.requested_by = ${p(ctx.user.id)} OR EXISTS (SELECT 1 FROM ${T('ab_approval_assignments')} a WHERE a.request_id = r.id AND (a.user_id = $${params.length} OR a.reassigned_from = $${params.length})))`)
    else if (!ctx.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only administrators see every approval request.')
    if (o.status === 'open') where.push(`r.status IN ('pending', 'info')`)
    else if (o.status === 'decided') where.push(`r.status NOT IN ('pending', 'info')`)
    else if (o.status) where.push(`r.status = ${p(o.status)}`)
    if (o.q) where.push(`r.title ILIKE ${p(`%${o.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)}`)
    if (o.policy) where.push(`r.policy_id = ${p(o.policy)}`)
    if (o.regarding) where.push(`r.regarding_id = ${p(o.regarding)}`)
    if (o.before) {
      const [at, bid] = o.before.split('|')
      if (!at || !bid || Number.isNaN(new Date(at).getTime())) throw invalid('before is not a valid cursor.', 'before')
      where.push(`(r.created_on, r.id) < (${p(new Date(at))}, ${p(bid)})`)
    }
    const rows = await db().query<Row>(`SELECT r.* FROM ${T('ab_approval_requests')} r ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.created_on DESC, r.id DESC LIMIT ${limit + 1}`, params)
    const page = rows.slice(0, limit)
    const org = await loadOrg()
    const { polNames, tableNames } = await lookups()
    const asg = page.length ? await db().query<Row>(`SELECT * FROM ${T('ab_approval_assignments')} WHERE request_id = ANY($1::text[])`, [page.map((r) => str(r.id))]) : []
    const by = new Map<string, Row[]>()
    for (const a of asg) by.set(str(a.request_id), [...(by.get(str(a.request_id)) ?? []), a])
    const items: ApprovalRequestInfo[] = []
    for (const r of page) items.push(await info(ctx, r, org, by.get(str(r.id)) ?? [], polNames, tableNames))
    const last = page[page.length - 1]
    return { items, nextBefore: rows.length > limit && last ? `${iso(last.created_on)}|${str(last.id)}` : null }
  }

  /** requests about one record the user may see (the Approvals panel UI component) */
  async function forRecord(ctx: UserContext, tableId: string, rowId: string): Promise<ApprovalRequestInfo[]> {
    if (!(await readRecord(ctx, tableId, rowId))) throw new HttpError(404, 'not-found', 'Record not found.')
    const rows = await db().query<Row>(`SELECT * FROM ${T('ab_approval_requests')} WHERE regarding_id = $1 ORDER BY created_on DESC LIMIT 100`, [rowId])
    const org = await loadOrg()
    const { polNames, tableNames } = await lookups()
    const out: ApprovalRequestInfo[] = []
    for (const r of rows) if (await canSee(ctx, r)) out.push(await info(ctx, r, org, undefined, polNames, tableNames))
    return out
  }

  async function detail(ctx: UserContext, id: string): Promise<ApprovalDetail> {
    const r = (await db().query<Row>(`SELECT * FROM ${T('ab_approval_requests')} WHERE id = $1`, [id]))[0]
    if (!r || !(await canSee(ctx, r))) throw notFound()
    const org = await loadOrg()
    const { polNames, tableNames } = await lookups()
    const asg = await assignmentRows(id)
    const base = await info(ctx, r, org, asg, polNames, tableNames)
    const name = (uid: unknown) => (uid ? org.people.get(str(uid))?.name ?? null : null)
    const stages: ApprovalStageInfo[] = (await db().query<Row>(`SELECT * FROM ${T('ab_approval_stages')} WHERE request_id = $1 ORDER BY idx`, [id])).map((s) => ({
      index: Number(s.idx), name: str(s.name), mode: str(s.mode) as ApprovalStageInfo['mode'], quorum: s.quorum === null ? null : Number(s.quorum), status: str(s.status) as ApprovalStageInfo['status'],
      startedOn: iso(s.started_on), completedOn: iso(s.completed_on),
    }))
    const assignments: ApprovalAssignmentInfo[] = asg.map((a) => ({
      id: str(a.id), stage: Number(a.stage_idx), userId: str(a.user_id), userName: name(a.user_id) ?? undefined, source: str(a.source) as ApprovalAssignmentInfo['source'],
      status: str(a.status) as AssignmentStatus, response: a.response ? str(a.response) : null, responseKind: (a.response_kind as ResponseKind) ?? null, comment: a.comment ? str(a.comment) : null,
      respondedOn: iso(a.responded_on), reassignedFrom: a.reassigned_from ? str(a.reassigned_from) : null, reassignedFromName: name(a.reassigned_from), note: a.note ? str(a.note) : null, createdOn: iso(a.created_on)!,
    }))
    const history: ApprovalHistoryEntry[] = (await db().query<Row>(`SELECT * FROM ${T('ab_approval_history')} WHERE request_id = $1 ORDER BY at, seq`, [id])).map((h) => {
      const d = json<Record<string, unknown>>(h.details, {})
      for (const k of ['user', 'from', 'to', 'onBehalfOf', 'instead']) if (typeof d[k] === 'string' && org.people.has(d[k] as string)) d[`${k}Name`] = org.people.get(d[k] as string)!.name
      return { id: str(h.id), at: iso(h.at)!, actorId: h.actor_id ? str(h.actor_id) : null, actorName: name(h.actor_id), actorKind: str(h.actor_kind) as ApprovalHistoryEntry['actorKind'], action: str(h.action), stage: h.stage_idx === null ? null : Number(h.stage_idx), details: d }
    })
    // the record, as THIS user may read it; otherwise only what the requester declared (details, fields)
    let record: ApprovalDetail['record'] = null
    if (r.regarding_table && r.regarding_id) {
      const rec = await readRecord(ctx, str(r.regarding_table), str(r.regarding_id))
      if (rec) {
        const cols = rec.table.columns.filter((c) => !c.system && !['file', 'files', 'image', 'attachment'].includes(String(c.type))).slice(0, 12)
        record = { title: str(rec.row[rec.table.primaryColumn]), fields: cols.map((c) => ({ name: c.name, label: c.displayName ?? c.name, value: rec.row[c.name] instanceof Date ? (rec.row[c.name] as Date).toISOString() : rec.row[c.name] ?? null })) }
      }
    }
    return { ...base, stages, assignments, history, record, recordHidden: !!r.regarding_id && !record }
  }

  /** the timeline of a record: approval requests about it (requested, decided), for those who may see them */
  async function timelineItems(ctx: UserContext, table: TableDef, rowId: string, before: { at: string; id: string } | null, limit: number) {
    const rows = await db().query<Row>(
      `SELECT * FROM ${T('ab_approval_requests')} WHERE regarding_id = $1 ${before ? 'AND created_on < $3' : ''} ORDER BY created_on DESC LIMIT $2`,
      before ? [rowId, limit, new Date(before.at)] : [rowId, limit],
    )
    const out: { kind: 'event'; id: string; at: string; by: string | null; data: Record<string, unknown> }[] = []
    for (const r of rows) {
      if (str(r.regarding_table) !== table.id || !(await canSee(ctx, r))) continue
      out.push({ kind: 'event', id: `p${str(r.id)}:r`, at: iso(r.created_on)!, by: r.requested_by ? str(r.requested_by) : null, data: { action: 'approval.requested', approvalId: str(r.id), title: str(r.title), status: str(r.status) } })
      if (r.completed_on) out.push({ kind: 'event', id: `p${str(r.id)}:d`, at: iso(r.completed_on)!, by: null, data: { action: 'approval.decided', approvalId: str(r.id), title: str(r.title), status: str(r.status), outcome: str(r.outcome) } })
    }
    return before ? out.filter((i) => i.at < before.at || (i.at === before.at && i.id < before.id)) : out
  }

  /* ---------------------------------------------------------------- the flow runtime's ApprovalsService */

  const flowService: ApprovalsService = {
    async request(env, req: FlowApprovalRequest, identity) {
      return runInEnvironment(env, async () => {
        const extra = (req.definition ?? {}) as Partial<ApprovalDefinition>
        const { def, policy: pol } = await definitionFor({
          policy: req.policy ?? null, approvers: req.approvers, ...(req.typeGiven === false && req.policy ? {} : { type: req.type as ApprovalDefinition['type'] }),
          ...(req.optionsGiven === false ? {} : { options: req.options }), extra,
        })
        const r = await createRequest({
          idempotencyKey: req.idempotencyKey, title: req.title, details: req.details, fields: req.fields, regarding: req.regarding ?? null,
          requestedBy: req.requestedBy ?? identity?.user.id ?? null, definition: def, policyId: pol?.id ?? null, source: 'flow',
          flow: { flowId: req.flowId, flowName: req.flowName, runId: req.runId, waitId: req.waitId, stepKey: req.stepKey }, dueOn: req.dueOn ? new Date(req.dueOn) : null,
        }, { id: null, kind: 'flow' })
        return { id: r.id }
      })
    },
    async cancel(env, approvalId, reason) {
      await runInEnvironment(env, () => cancel(null, approvalId, reason === 'timedOut' ? 'The flow step timed out.' : 'The flow run was cancelled.', { fromFlow: reason }))
    },
  }

  /** from apps (RequestApproval) and the API: the requester is the signed-in user */
  async function requestFromUser(ctx: UserContext, raw: unknown, source: 'app' | 'api'): Promise<{ id: string; created: boolean }> {
    const o = (raw ?? {}) as { id?: string; policy?: string; approvers?: string[] | string; type?: ApprovalDefinition['type']; options?: string[]; title?: string; details?: string; fields?: Record<string, unknown>; regarding?: { table?: string; rowId?: string }; dueMinutes?: number }
    const approvers = typeof o.approvers === 'string' ? o.approvers.split(/[;,\n]/).map((x) => x.trim()).filter(Boolean) : Array.isArray(o.approvers) ? o.approvers.map(String) : []
    if (!o.policy && !approvers.length) throw invalid('Name a policy or the approvers.', 'approvers')
    let regarding: { tableId: string; rowId: string } | null = null
    if (o.regarding?.rowId) {
      const rowId = o.regarding.rowId.length === 36 ? o.regarding.rowId.toLowerCase() : o.regarding.rowId
      let tableId = o.regarding.table ?? ''
      if (!tableId) tableId = (await services.collab.findTableOfRow(rowId))?.id ?? ''
      const t = tableId ? await services.meta.tables.get(tableId) : null
      if (!t || !(await readRecord(ctx, t.id, rowId))) throw invalid(`There is no record with the id "${rowId.slice(0, 64)}" that you can see.`, 'regarding')
      regarding = { tableId: t.id, rowId }
    }
    const fields: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(o.fields ?? {})) if (k.trim() && k.length <= 60 && (v === null || ['string', 'number', 'boolean'].includes(typeof v))) fields[k] = v
    const { def, policy: pol } = await definitionFor({ policy: o.policy ?? null, approvers, ...(o.type ? { type: o.type } : {}), ...(o.options?.length ? { options: o.options } : {}), extra: o.dueMinutes ? { dueMinutes: o.dueMinutes } : {} })
    return createRequest({ ...(o.id ? { id: o.id } : {}), title: str(o.title), details: o.details, fields, regarding, requestedBy: ctx.user.id, definition: def, policyId: pol?.id ?? null, source }, { id: ctx.user.id, kind: 'user' })
  }

  /* ---------------------------------------------------------------- retention, restore */

  async function retention(): Promise<number> {
    const st = await settings()
    if (!st.retentionDays) return 0
    const cut = new Date(Date.now() - st.retentionDays * 86400_000)
    const ids = (await db().query<Row>(`SELECT id FROM ${T('ab_approval_requests')} WHERE status NOT IN ('pending', 'info') AND completed_on < $1 LIMIT 5000`, [cut])).map((r) => str(r.id))
    if (!ids.length) return 0
    await db().tx(async () => {
      for (const t of ['ab_approval_history', 'ab_approval_assignments', 'ab_approval_stages', 'ab_approval_links']) await db().exec(`DELETE FROM ${T(t)} WHERE request_id = ANY($1::text[])`, [ids])
      await db().exec(`DELETE FROM ${T('ab_approval_requests')} WHERE id = ANY($1::text[])`, [ids])
    })
    return ids.length
  }

  /* ---------------------------------------------------------------- registration */

  services.kernel.jobs.register<{ requestId: string; assignmentId?: string; kind: string; by?: string; to?: string; comment?: string }>({
    type: APPROVAL_NOTIFY_JOB, description: 'Sends the notifications and emails of an approval request (asked, reminder, escalation, more information).', concurrency: 4, maxAttempts: 5,
    parse: (raw) => {
      const o = (raw ?? {}) as Record<string, unknown>
      if (typeof o.requestId !== 'string' || typeof o.kind !== 'string') throw new Error('requestId and kind are needed')
      return o as { requestId: string; kind: string }
    },
    handler: (p) => notifyJob(p),
  })
  services.kernel.jobs.register<{ requestId: string }>({
    type: APPROVAL_DECIDED_JOB, description: 'After an approval request ended: tells the requester and the people still asked; starts approvalDecided flows.', concurrency: 2, maxAttempts: 8,
    parse: (raw) => {
      const o = (raw ?? {}) as Record<string, unknown>
      if (typeof o.requestId !== 'string') throw new Error('requestId is needed')
      return { requestId: o.requestId }
    },
    handler: (p) => decidedJob(p),
  })
  services.kernel.jobs.register<Record<string, never>>({
    type: APPROVAL_RETENTION_JOB, description: 'Deletes decided approval requests older than the retention of the approval settings (0: kept forever).', concurrency: 1, schedule: 'custom',
    handler: async () => ({ deleted: await retention() }),
  })
  const builtins = new Set<string>()
  services.kernel.addTickHook(async (env) => {
    if (!builtins.has(env.id)) {
      await services.kernel.jobs.schedules.ensureBuiltins([
        { id: 'sched_approval_retention', name: 'Approval retention', description: 'Deletes decided approval requests older than the retention in the approval settings.', cron: '41 2 * * *', jobType: APPROVAL_RETENTION_JOB, payload: {}, enabled: true },
      ])
      builtins.add(env.id)
    }
    await tick().catch((e) => log('warn', `approvals sweep (${env.id}): ${errText(e)}`))
  })
  services.collab.addTimelineSource((ctx, table, rowId, before, limit) => timelineItems(ctx, table, rowId, before, limit))
  services.flows.setApprovals(flowService)

  return {
    flowService, settings, saveSettings, listPolicies, policy, savePolicy, deletePolicy, definitionFor, createRequest, requestFromUser, respond, answerInfo, cancel, reassign,
    listDelegations, createDelegation, cancelDelegation, applyDelegations, tick, list, forRecord, detail, inspectLink, useLink, canSee, invalidateOrg, retention,
    /** tests: the email links of an assignment (made by the notify job) */
    signLink, makeLinks, outcomeOf,
    forUserId: async (userId: string): Promise<UserContext> => {
      const u = await services.meta.users.get(userId)
      if (!u) throw new HttpError(404, 'not-found', 'There is no such user.')
      return services.security.forUser(u as UserDef)
    },
  }
}
