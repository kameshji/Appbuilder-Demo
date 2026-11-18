/**
 * Self-service profile and the admin audit viewer (environments: environments.ts).
 *   PATCH /api/v1/auth/profile   { name }  any signed-in user, own display name only -> UserDef
 *   GET   /api/v1/audit                  administrators of the current environment -> AuditPageResponse (that environment's
 *                                        audit log; newest first, page size 1-200, default 50)
 */
import type { UserDef } from '../../../src/platform/contracts.ts'
import type { AuditPageResponse } from '../../../src/platform/http.ts'
import type { Ctx, Router, Services } from '../../core/contracts.ts'
import { bodyObj, invalid, me, notFound, reqString } from './util.ts'
import { audit } from './tables-core.ts'

export const AUDIT_PAGE_SIZE = 50
export const AUDIT_MAX_PAGE_SIZE = 200

/** "2026-11-18" or a full ISO timestamp; anything else is refused */
function isoParam(v: string | null, field: string): string | undefined {
  if (v === null || v === '') return undefined
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00.000Z` : v)
  if (v.length > 40 || Number.isNaN(d.getTime())) throw invalid(`"${field}" must be a date such as 2026-11-18.`, field)
  return d.toISOString()
}

function intParam(v: string | null, field: string, def: number, min: number, max: number): number {
  if (v === null || v === '') return def
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(`"${field}" must be a whole number from ${min} to ${max}.`, field)
  return n
}

/** the filters of an audit page request (shared by GET /audit and GET /install/audit) */
export function auditQuery(ctx: Ctx): { action?: string; userId?: string; from?: string; to?: string; page: number; pageSize: number } {
  const q = ctx.query
  const action = (q.get('action') ?? '').trim()
  if (action.length > 64 || (action && !/^[a-z0-9_.]+$/i.test(action))) throw invalid('"action" must be an action name such as auth.login, or a prefix such as auth.', 'action')
  const userId = (q.get('user') ?? '').trim()
  if (userId.length > 64) throw invalid('"user" is not a user id.', 'user')
  return {
    action: action || undefined, userId: userId || undefined, from: isoParam(q.get('from'), 'from'), to: isoParam(q.get('to'), 'to'),
    page: intParam(q.get('page'), 'page', 1, 1, 1_000_000), pageSize: intParam(q.get('pageSize'), 'pageSize', AUDIT_PAGE_SIZE, 1, AUDIT_MAX_PAGE_SIZE),
  }
}

export function registerAdminRoutes(router: Router, s: Services): void {
  router.add('PATCH', '/api/v1/auth/profile', async (ctx): Promise<UserDef> => {
    const b = bodyObj(ctx)
    const other = Object.keys(b).filter((k) => k !== 'name')
    if (other.length) throw invalid(`Only your display name can be changed here (not ${other.map((k) => `"${k}"`).join(', ')}). Ask an administrator for anything else.`, other[0])
    const name = reqString(b, 'name', 'Your name', 100)
    const self = me(ctx).user
    const rec = await s.meta.users.get(self.id)
    if (!rec) throw notFound('User not found.')
    if (rec.name !== name) {
      await s.meta.users.update(rec.id, { name })
      s.security.invalidate()
      await audit(s, ctx, 'user.profile', { id: rec.id, email: rec.email, changes: { name: { before: rec.name, after: name } } })
    }
    const { passwordHash, ...rest } = { ...rec, name }
    return { ...rest, status: rec.status ?? 'active', hasPassword: !!passwordHash }
  }, { auth: 'user' })

  router.add('GET', '/api/v1/audit', async (ctx): Promise<AuditPageResponse> => {
    const { action, userId, from, to, page, pageSize } = auditQuery(ctx)
    const [{ items, total }, actions, users] = await Promise.all([
      s.meta.auditPage({ action, userId, from, to, offset: (page - 1) * pageSize, limit: pageSize }),
      s.meta.auditActions(),
      s.meta.users.list(),
    ])
    const byId = new Map(users.map((u) => [u.id, u]))
    return {
      items: items.map((e) => {
        const u = e.userId ? byId.get(e.userId) : undefined
        return { ...e, ...(u ? { userName: u.name, userEmail: u.email } : {}) }
      }),
      total, page, pageSize, actions,
    }
  }, { auth: 'admin' })
}
