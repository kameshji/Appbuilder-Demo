/**
 * In-app notifications (P0 package H; email and WhatsApp come later): a per-user store in schema `ab` (install-wide,
 * environment id nullable), per-user settings, the notify() service other packages call (flows, approvals, table events),
 * delivery over the realtime hub (`user:<id>`), and the HTTP API:
 *   GET    /notifications?limit&cursor&unread=1   list, newest first (keyset paging)
 *   GET    /notifications/unread-count
 *   POST   /notifications/:id/read        POST /notifications/read-all        DELETE /notifications/:id
 *   GET    /notifications/settings        PUT /notifications/settings
 *   POST   /notifications/send            SendNotification(user, title, body, link) from apps (rate-limited)
 *
 * Tables: notifications-ddl.ts (part of the install schema `ab`).
 */
import { HttpError } from './contracts.ts'
import type { NotificationService, NotifyInput, NotifyTarget, SqlDb } from './contracts.ts'
import type { NotificationItem, NotificationSettings, UserEvent } from '../../src/platform/live-protocol.ts'
import { defaultNotificationSettings, parseNotificationSettings } from '../../src/platform/live-protocol.ts'
import type { ApiRouter } from './router.ts'
import type { CoreServices } from './services.ts'
import { toUserDef } from './auth.ts'
import { errText, log } from './util.ts'

export const NOTIFICATION_TITLE_MAX = 200
export const NOTIFICATION_BODY_MAX = 2000
export const NOTIFICATION_LINK_MAX = 500
/** notifications kept per user (older ones are removed when new ones arrive) */
export const NOTIFICATIONS_PER_USER = 500
/** SendNotification from apps: per sender */
export const SEND_PER_MINUTE = 30
export const SEND_PER_HOUR = 300
/** recipients of one notify() call */
export const NOTIFY_MAX_RECIPIENTS = 1000

const A = (t: string) => `"ab"."${t}"`

/** a deep link inside Appbuilder: a hash route, or empty. Never another site or a script URL. */
export function checkLink(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string') throw new HttpError(422, 'invalid', 'link must be text.', 'link')
  const s = v.trim()
  if (s.length > NOTIFICATION_LINK_MAX) throw new HttpError(422, 'invalid', 'link is too long.', 'link')
  if (!/^#[A-Za-z0-9/_\-.~?=&%:+,]*$/.test(s)) throw new HttpError(422, 'invalid', 'link must be a link inside Appbuilder, such as #u-<app id> (copy it from the address bar, starting with #).', 'link')
  return s
}

function checkText(v: unknown, field: string, max: number, required: boolean): string {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(422, 'invalid', `${field} is required.`, field)
    return ''
  }
  if (typeof v !== 'string') throw new HttpError(422, 'invalid', `${field} must be text.`, field)
  const s = v.trim()
  if (required && !s) throw new HttpError(422, 'invalid', `${field} is required.`, field)
  if (s.length > max) throw new HttpError(422, 'invalid', `${field} is too long (at most ${max} characters).`, field)
  return s
}

interface Row {
  id: string
  user_id: string
  environment_id: string | null
  kind: string
  title: string
  body: string
  link: string | null
  source: string
  sender_name: string | null
  created_on: Date
  read_on: Date | null
}

const toItem = (r: Row): NotificationItem => ({
  id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, environmentId: r.environment_id, createdOn: new Date(r.created_on).toISOString(),
  readOn: r.read_on ? new Date(r.read_on).toISOString() : null, source: r.source, ...(r.sender_name ? { from: r.sender_name } : {}),
})

/** sliding-window counter per key (in memory) */
class RateLimiter {
  private hits = new Map<string, number[]>()
  allow(key: string, limits: { windowMs: number; max: number }[], now = Date.now()): boolean {
    const longest = Math.max(...limits.map((l) => l.windowMs))
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < longest)
    for (const l of limits) if (list.filter((t) => now - t < l.windowMs).length >= l.max) {
      this.hits.set(key, list)
      return false
    }
    list.push(now)
    this.hits.set(key, list)
    if (this.hits.size > 10000) for (const k of [...this.hits.keys()].slice(0, 5000)) this.hits.delete(k)
    return true
  }
}

export interface NotificationServiceDeps {
  services: CoreServices
  /** pushes to a user's live sockets (the hub); optional */
  push?: (userId: string, ev: UserEvent) => void
}

export function createNotificationService(deps: NotificationServiceDeps): NotificationService & {
  setPush(fn: (userId: string, ev: UserEvent) => void): void
  setSettingsListener(fn: (userId: string, s: NotificationSettings) => void): void
} {
  const s = deps.services
  let push = deps.push
  let onSettings: ((userId: string, st: NotificationSettings) => void) | null = null
  let teamResolver: ((env: string, teamIds: string[]) => Promise<string[]>) | null = null

  // the tables are part of the install schema (notifications-ddl.ts, created by MetaStore.migrate on every start)
  const db = async (): Promise<SqlDb> => {
    const d = s.state.db
    if (!d || !s.ready()) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }

  async function unreadCount(userId: string): Promise<number> {
    const d = await db()
    const r = await d.query<{ n: string | number }>(`SELECT count(*) AS n FROM ${A('notifications')} WHERE user_id = $1 AND read_on IS NULL`, [userId])
    return Number(r[0]?.n ?? 0)
  }

  async function settings(userId: string): Promise<NotificationSettings> {
    const d = await db()
    const r = await d.query<{ value: unknown }>(`SELECT value FROM ${A('user_settings')} WHERE user_id = $1 AND key = 'notifications'`, [userId])
    return r.length ? parseNotificationSettings(r[0].value) : defaultNotificationSettings()
  }

  async function notify(target: NotifyTarget, input: NotifyInput): Promise<{ delivered: string[]; skipped: string[] }> {
    const kind = checkText(input.kind, 'kind', 32, true)
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(kind)) throw new HttpError(422, 'invalid', 'kind must be a short lowercase word.', 'kind')
    const title = checkText(input.title, 'title', NOTIFICATION_TITLE_MAX, true)
    const body = checkText(input.body, 'body', NOTIFICATION_BODY_MAX, false)
    const link = checkLink(input.link)
    const source = checkText(input.source, 'source', 200, true)
    let ids = [...new Set((target.userIds ?? []).filter((x) => typeof x === 'string' && x))]
    if (target.teamIds?.length) {
      if (!teamResolver) throw new HttpError(422, 'invalid', 'Notifying teams needs the organisation model (teams are not available yet).')
      if (!input.environmentId) throw new HttpError(422, 'invalid', 'Notifying a team needs the environment the team belongs to.')
      ids = [...new Set([...ids, ...(await teamResolver(input.environmentId, target.teamIds))])]
    }
    if (ids.length > NOTIFY_MAX_RECIPIENTS) throw new HttpError(422, 'invalid', `At most ${NOTIFY_MAX_RECIPIENTS} recipients per notification.`)
    const d = await db()
    const delivered: string[] = []
    const skipped: string[] = []
    const now = new Date()
    for (const userId of ids) {
      const u = await s.meta.users.get(userId)
      if (!u || u.status === 'disabled') {
        skipped.push(userId)
        continue
      }
      // a kind the user switched off is not stored for them at all
      const prefs = await settings(userId)
      if (prefs.kinds[kind] === false) {
        skipped.push(userId)
        continue
      }
      const item: NotificationItem = {
        id: s.uid('ntf'), kind, title, body, link, environmentId: input.environmentId ?? null, createdOn: now.toISOString(), readOn: null, source,
        ...(input.from?.name ? { from: input.from.name } : {}),
      }
      await d.exec(
        `INSERT INTO ${A('notifications')} (id, user_id, environment_id, kind, title, body, link, source, sender_id, sender_name, created_on) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [item.id, userId, item.environmentId, kind, title, body, link, source, input.from?.id ?? null, input.from?.name ?? null, now],
      )
      delivered.push(userId)
      // keep the newest NOTIFICATIONS_PER_USER
      await d.exec(
        `DELETE FROM ${A('notifications')} WHERE user_id = $1 AND id IN (SELECT id FROM ${A('notifications')} WHERE user_id = $1 ORDER BY created_on DESC, id DESC OFFSET $2)`,
        [userId, NOTIFICATIONS_PER_USER],
      ).catch((e) => log('warn', `notification trim failed: ${errText(e)}`))
      if (push) {
        try {
          push(userId, { event: 'notification', notification: item, unread: await unreadCount(userId) })
        } catch (e) {
          log('warn', `notification push failed: ${errText(e)}`)
        }
      }
    }
    return { delivered, skipped }
  }

  async function list(userId: string, o: { limit?: number; cursor?: string | null; unreadOnly?: boolean } = {}) {
    const d = await db()
    const limit = Math.max(1, Math.min(100, Math.trunc(o.limit ?? 30)))
    const params: unknown[] = [userId]
    let where = 'user_id = $1'
    if (o.unreadOnly) where += ' AND read_on IS NULL'
    if (o.cursor) {
      const m = /^(\d{1,16})\.([A-Za-z0-9_-]{1,80})$/.exec(o.cursor)
      if (!m) throw new HttpError(422, 'invalid', 'Invalid cursor.', 'cursor')
      params.push(new Date(Number(m[1])), m[2])
      where += ` AND (created_on, id) < ($2, $3)`
    }
    params.push(limit + 1)
    const rows = await d.query<Row>(`SELECT * FROM ${A('notifications')} WHERE ${where} ORDER BY created_on DESC, id DESC LIMIT $${params.length}`, params)
    const more = rows.length > limit
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    return {
      items: page.map(toItem),
      nextCursor: more && last ? `${new Date(last.created_on).getTime()}.${last.id}` : null,
      unread: await unreadCount(userId),
    }
  }

  async function changed(userId: string): Promise<number> {
    const n = await unreadCount(userId)
    push?.(userId, { event: 'unread', unread: n })
    return n
  }

  return {
    notify,
    list,
    unreadCount,
    async markRead(userId, ids) {
      const d = await db()
      if (ids === 'all') await d.exec(`UPDATE ${A('notifications')} SET read_on = $2 WHERE user_id = $1 AND read_on IS NULL`, [userId, new Date()])
      else if (ids.length) await d.exec(`UPDATE ${A('notifications')} SET read_on = $2 WHERE user_id = $1 AND read_on IS NULL AND id = ANY($3)`, [userId, new Date(), ids])
      return changed(userId)
    },
    async remove(userId, id) {
      const d = await db()
      const r = await d.exec(`DELETE FROM ${A('notifications')} WHERE user_id = $1 AND id = $2`, [userId, id])
      if (!r.affectedRows) throw new HttpError(404, 'not-found', 'Notification not found.')
      return changed(userId)
    },
    settings,
    async saveSettings(userId, raw) {
      const d = await db()
      const next = parseNotificationSettings(raw)
      await d.exec(
        `INSERT INTO ${A('user_settings')} (user_id, key, value, modified_on) VALUES ($1, 'notifications', $2, $3)
         ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, modified_on = EXCLUDED.modified_on`,
        [userId, JSON.stringify(next), new Date()],
      )
      onSettings?.(userId, next)
      return next
    },
    setTeamResolver(fn) {
      teamResolver = fn
    },
    setPush(fn) {
      push = fn
    },
    setSettingsListener(fn) {
      onSettings = fn
    },
  }
}

/* ------------------------------------------------------------------ routes */

export function notificationRoutes(router: ApiRouter, services: CoreServices, svc: NotificationService): void {
  const limiter = new RateLimiter()
  const me = (ctx: { user?: { user: { id: string } } }) => ctx.user!.user.id
  const obj = (b: unknown): Record<string, unknown> => {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(422, 'invalid', 'Request body must be a JSON object.')
    return b as Record<string, unknown>
  }

  // the list, counts and settings are the user's own and install-wide: usable without an environment
  router.add('GET', '/notifications', (ctx) => svc.list(me(ctx), {
    limit: ctx.query.get('limit') ? Number(ctx.query.get('limit')) : undefined,
    cursor: ctx.query.get('cursor'),
    unreadOnly: ctx.query.get('unread') === '1',
  }), { auth: 'user', noEnvironment: true })

  router.add('GET', '/notifications/unread-count', async (ctx) => ({ unread: await svc.unreadCount(me(ctx)) }), { auth: 'user', noEnvironment: true })

  router.add('POST', '/notifications/read-all', async (ctx) => ({ unread: await svc.markRead(me(ctx), 'all') }), { auth: 'user', noEnvironment: true })

  router.add('POST', '/notifications/:id/read', async (ctx) => ({ unread: await svc.markRead(me(ctx), [ctx.params.id]) }), { auth: 'user', noEnvironment: true })

  router.add('DELETE', '/notifications/:id', async (ctx) => ({ unread: await svc.remove(me(ctx), ctx.params.id) }), { auth: 'user', noEnvironment: true })

  router.add('GET', '/notifications/settings', (ctx) => svc.settings(me(ctx)), { auth: 'user', noEnvironment: true })

  router.add('PUT', '/notifications/settings', (ctx) => svc.saveSettings(me(ctx), obj(ctx.body)), { auth: 'user', noEnvironment: true })

  /**
   * SendNotification(user, title, body, link) from an app: any signed-in user may notify a user who may enter the same
   * environment (by user id or email); a user outside it answers 404 like an unknown one. Rate-limited per sender.
   * Optional `app`: the sending app's id (must be one the sender may run), recorded as the source.
   */
  router.add('POST', '/notifications/send', async (ctx) => {
    const b = obj(ctx.body)
    const sender = ctx.user!
    const to = typeof b.to === 'string' ? b.to.trim() : ''
    if (!to || to.length > 191) throw new HttpError(422, 'invalid', 'to must be a user id or an email address.', 'to')
    const title = checkText(b.title, 'title', NOTIFICATION_TITLE_MAX, true)
    const body = checkText(b.body, 'body', NOTIFICATION_BODY_MAX, false)
    const link = checkLink(b.link)
    let source = `user:${sender.user.id}`
    if (b.app !== undefined && b.app !== null && b.app !== '') {
      if (typeof b.app !== 'string' || !sender.canRunApp(b.app)) throw new HttpError(422, 'invalid', 'app must be an app you can run.', 'app')
      source = `app:${b.app}`
    }
    if (!limiter.allow(sender.user.id, [{ windowMs: 60_000, max: SEND_PER_MINUTE }, { windowMs: 3_600_000, max: SEND_PER_HOUR }])) {
      throw new HttpError(429, 'rate_limited', `Too many notifications: at most ${SEND_PER_MINUTE} a minute and ${SEND_PER_HOUR} an hour.`)
    }
    const target = to.includes('@') ? await services.meta.users.byEmail(to.toLowerCase()) : await services.meta.users.get(to)
    const env = ctx.environmentId
    const inEnv = target && target.status !== 'disabled'
      ? (await services.environments.accessible(toUserDef(target))).some((e) => e.id === env)
      : false
    if (!target || !inEnv) throw new HttpError(404, 'not-found', `There is no user "${to.slice(0, 80)}" in this environment.`, 'to')
    await svc.notify({ userIds: [target.id] }, { kind: 'app', title, body, link, environmentId: env, source, from: { id: sender.user.id, name: sender.user.name } })
    return { ok: true }
  }, { auth: 'user' })
}
