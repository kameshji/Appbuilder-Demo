/**
 * Notification delivery by channel (P1 package D; docs/dev/notifications-delivery.md). `services.notifications.notify`
 * stays the single entry point: flows, table events (NotifyUser), approvals, mentions, tasks and backups all call it.
 * This module decides, per recipient and kind:
 *
 *   in-app   stored and pushed (unless the user or a locked administrator default switched it off)
 *   email    off | immediate | digest (hourly, or daily at a chosen time, in the user's time zone)
 *   WhatsApp placeholder (P2), never delivered
 *
 * Rules, in order: administrator default per kind, optionally locked (users cannot change a locked kind; for example
 * approvals always by email); otherwise the user's choice; otherwise the default. Email needs the SMTP relay; suppressed
 * addresses get nothing. Immediate emails respect do-not-disturb hours ("quiet hours", in the user's time zone; the
 * email waits until they end) and a per-recipient rate limit (default 20 an hour; the rest join the next digest).
 * Every decision is written to ab.notification_deliveries with a reason the user can read ("why did I get this").
 * Emails carry a deep link (public base URL + the notification's #link) and a signed one-click link that mutes email for
 * that kind without signing in (List-Unsubscribe and List-Unsubscribe-Post headers too).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { CoreServices } from './services.ts'
import type { ApiRouter } from './router.ts'
import type { Ctx, SqlDb } from './contracts.ts'
import { HttpError } from './contracts.ts'
import type { NotificationDelivery } from './notifications.ts'
import type { EmailMode, NotificationItem, NotificationSettings } from '../../src/platform/live-protocol.ts'
import { NOTIFICATION_KINDS, parseNotificationSettings } from '../../src/platform/live-protocol.ts'
import { identity } from './identity/index.ts'
import { suppressedAmong } from './actions/suppressions.ts'
import { loadSecretKey } from './secrets.ts'
import { nextCron, parseCron, checkTimeZone } from './cron.ts'
import { DEFAULT_ENVIRONMENT_ID } from './env-context.ts'
import { INSTALL_SCHEDULES } from './kernel.ts'
import { errText, log, rowUid } from './util.ts'

export const DIGEST_JOB = 'notifications.digest'
export const DELIVERY_RETENTION_JOB = 'notifications.delivery-retention'
const POLICY_KEY = 'notifications.policy'
const DIGEST_STATE_KEY = 'notifications.digest_state'
export const DEFAULT_PER_RECIPIENT_PER_HOUR = 20

export interface KindPolicy { inApp?: boolean; email?: EmailMode; lock?: boolean }
export interface DeliveryPolicy {
  kinds: Record<string, KindPolicy>
  /** an https address of a small logo shown at the top of notification emails */
  logoUrl: string
  /** immediate emails per recipient and hour; more go to the next digest */
  perRecipientPerHour: number
}

/** out of the box: approvals by email right away (not locked); everything else in the app only */
export function defaultPolicy(): DeliveryPolicy {
  return { kinds: { approval: { email: 'immediate' } }, logoUrl: '', perRecipientPerHour: DEFAULT_PER_RECIPIENT_PER_HOUR }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/

export function parsePolicy(raw: unknown): DeliveryPolicy {
  const o = isObj(raw) ? raw : {}
  const base = defaultPolicy()
  const kinds: Record<string, KindPolicy> = isObj(o.kinds) ? {} : base.kinds
  if (isObj(o.kinds)) {
    for (const [k, v] of Object.entries(o.kinds)) {
      if (!KIND_RE.test(k) || !isObj(v)) continue
      const p: KindPolicy = {}
      if (typeof v.inApp === 'boolean') p.inApp = v.inApp
      if (v.email === 'off' || v.email === 'immediate' || v.email === 'digest') p.email = v.email
      if (v.lock === true) p.lock = true
      kinds[k] = p
    }
  }
  let logoUrl = typeof o.logoUrl === 'string' ? o.logoUrl.trim() : ''
  if (logoUrl) {
    try {
      const u = new URL(logoUrl)
      if (u.protocol !== 'https:') logoUrl = ''
    } catch {
      logoUrl = ''
    }
  }
  const per = Number(o.perRecipientPerHour)
  return { kinds, logoUrl: logoUrl.slice(0, 500), perRecipientPerHour: Number.isInteger(per) && per >= 1 && per <= 1000 ? per : base.perRecipientPerHour }
}

export interface Effective { inApp: boolean; inAppReason: string; email: EmailMode; emailReason: string; locked: boolean }

const label = (kind: string) => NOTIFICATION_KINDS.find((k) => k.kind === kind)?.label ?? kind

/** the channels of one kind for one user, with the reasons shown in the delivery log */
export function effectiveChannels(policy: DeliveryPolicy, prefs: NotificationSettings, kind: string): Effective {
  const p = policy.kinds[kind] ?? {}
  const what = `"${label(kind)}"`
  if (p.lock) {
    const inApp = p.inApp ?? true
    const email = p.email ?? 'off'
    return {
      inApp, email, locked: true,
      inAppReason: `Your administrator set ${what} notifications to ${inApp ? 'show' : 'not show'} in the app for everyone.`,
      emailReason: `Your administrator set ${what} notifications to ${email === 'off' ? 'no email' : email === 'digest' ? 'email in a digest' : 'email right away'} for everyone.`,
    }
  }
  const userInApp = prefs.kinds[kind]
  const inApp = userInApp ?? p.inApp ?? true
  const userEmail = prefs.email?.[kind]
  const email = userEmail ?? p.email ?? 'off'
  return {
    inApp, email, locked: false,
    inAppReason: userInApp !== undefined ? `You chose to ${inApp ? 'see' : 'not see'} ${what} notifications in the app.` : p.inApp !== undefined ? `Your administrator's default for ${what} is ${inApp ? 'in the app' : 'not in the app'}.` : `${what} notifications show in the app by default.`,
    emailReason: userEmail !== undefined ? `You chose ${email === 'off' ? 'no email' : email === 'digest' ? 'a digest email' : 'an email right away'} for ${what} notifications.` : p.email !== undefined ? `Your administrator's default for ${what} is ${email === 'off' ? 'no email' : email === 'digest' ? 'a digest email' : 'an email right away'}.` : `${what} notifications are not emailed by default.`,
  }
}

/* ------------------------------------------------------------------ time zones, quiet hours, digests */

const fmt = new Map<string, Intl.DateTimeFormat>()
function localHM(now: Date, tz: string): number {
  let f = fmt.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: 'numeric', minute: 'numeric' })
    fmt.set(tz, f)
  }
  const p: Record<string, string> = {}
  for (const x of f.formatToParts(now)) p[x.type] = x.value
  return (Number(p.hour) % 24) * 60 + Number(p.minute)
}

export function zoneOf(prefs: NotificationSettings): string {
  const tz = prefs.timeZone || 'UTC'
  try {
    return checkTimeZone(tz)
  } catch {
    return 'UTC'
  }
}

/** inside the do-not-disturb hours (in the user's time zone), when they apply to email */
export function inQuietHours(prefs: NotificationSettings, now: Date): boolean {
  if (!prefs.dnd || prefs.quietEmail === false) return false
  const m = localHM(now, zoneOf(prefs))
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
  const a = toMin(prefs.dnd.start)
  const b = toMin(prefs.dnd.end)
  if (a === b) return false
  return a < b ? m >= a && m < b : m >= a || m < b
}

/** when the current quiet hours end (the next local end time) */
export function quietEnd(prefs: NotificationSettings, now: Date): Date {
  const [h, m] = (prefs.dnd?.end ?? '07:00').split(':').map(Number)
  return nextCron(parseCron(`${m} ${h} * * *`), now, zoneOf(prefs)) ?? new Date(now.getTime() + 3600_000)
}

const digestCron = (prefs: NotificationSettings): string => {
  const d = prefs.digest ?? { frequency: 'daily', time: '08:00' }
  if (d.frequency === 'hourly') return '0 * * * *'
  const [h, m] = d.time.split(':').map(Number)
  return `${m} ${h} * * *`
}

/** the latest digest slot at or before `now` (hourly: the hour; daily: today's or yesterday's time) */
export function latestDigestSlot(prefs: NotificationSettings, now: Date): Date {
  const spec = parseCron(digestCron(prefs))
  const tz = zoneOf(prefs)
  let t = nextCron(spec, new Date(now.getTime() - 27 * 3600_000), tz)
  let last = t
  while (t && t.getTime() <= now.getTime()) {
    last = t
    t = nextCron(spec, t, tz)
  }
  return last ?? now
}

/** the next digest slot after `now` */
export function nextDigestSlot(prefs: NotificationSettings, now: Date): Date {
  return nextCron(parseCron(digestCron(prefs)), now, zoneOf(prefs)) ?? new Date(now.getTime() + 86400_000)
}

/**
 * Is a digest due? Yes when the latest slot is after the last digest sent and at least one waiting item is older than
 * that slot (an item that arrived after today's slot waits for the next one), and not inside quiet hours.
 */
export function digestDue(prefs: NotificationSettings, lastSent: Date | null, oldestItem: Date | null, now: Date): boolean {
  if (!oldestItem) return false
  if (inQuietHours(prefs, now)) return false
  const slot = latestDigestSlot(prefs, now)
  if (slot.getTime() > now.getTime()) return false
  if (lastSent && lastSent.getTime() >= slot.getTime()) return false
  return oldestItem.getTime() <= slot.getTime()
}

/* ------------------------------------------------------------------ signed links */

export function signingKey(services: CoreServices): Buffer {
  return createHmac('sha256', loadSecretKey(services.config.workspaceDir)).update('appbuilder.unsubscribe.v1').digest()
}

/** { u: user id, k: kind } or { u, r: report id, e: environment } -> token */
export function signToken(key: Buffer, payload: Record<string, string>): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const mac = createHmac('sha256', key).update(body).digest('base64url')
  return `${body}.${mac}`
}

export function verifyToken(key: Buffer, token: string): Record<string, string> | null {
  if (typeof token !== 'string' || token.length > 600) return null
  const [body, mac] = token.split('.')
  if (!body || !mac) return null
  const want = Buffer.from(createHmac('sha256', key).update(body).digest('base64url'))
  const got = Buffer.from(mac)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    return isObj(v) ? (v as Record<string, string>) : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ email rendering */

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export interface Brand { installName: string; publicUrl: string; logoUrl: string }

/** "<public url>/#link"; empty without a public URL */
export function deepLink(brand: Brand, link: string | null): string {
  if (!brand.publicUrl) return ''
  return `${brand.publicUrl}/${link && link.startsWith('#') ? link : ''}`
}

export function emailFrame(brand: Brand, heading: string, inner: string, footer: string): string {
  const logo = brand.logoUrl ? `<img src="${esc(brand.logoUrl)}" alt="" style="max-height:32px;max-width:160px;display:block;margin-bottom:8px">` : ''
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:24px">
${logo}<div style="font-weight:700;font-size:15px;margin-bottom:16px;color:#4f46e5">${esc(brand.installName)}</div>
<h1 style="font-size:18px;margin:0 0 14px">${esc(heading)}</h1>
${inner}
</div>
<p style="max-width:640px;margin:14px auto 0;font-size:11px;line-height:1.5;color:#94a3b8;text-align:center">${footer}</p>
</body></html>`
}

function itemHtml(brand: Brand, n: { title: string; body: string; link: string | null; from?: string; createdOn?: string; actions?: { label: string; url: string }[] }): string {
  const href = deepLink(brand, n.link)
  // P1-C: answer buttons (each opens a confirmation page in the app; nothing is decided by opening a link)
  const actions = (n.actions ?? []).map((a, i) => `<a href="${esc(a.url)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 18px;border-radius:8px;background:${i === 0 ? '#16a34a' : i === 1 ? '#dc2626' : '#475569'};color:#ffffff;text-decoration:none;font-weight:600;font-size:14px">${esc(a.label)}</a>`).join('')
  return `<div style="margin:0 0 14px;padding:0 0 12px;border-bottom:1px solid #f1f5f9">
<div style="font-weight:600">${esc(n.title)}</div>
${n.body ? `<div style="margin-top:4px;white-space:pre-wrap;line-height:1.5">${esc(n.body)}</div>` : ''}
${n.from ? `<div style="margin-top:4px;font-size:12px;color:#64748b">From ${esc(n.from)}</div>` : ''}
${actions ? `<div style="margin-top:12px">${actions}</div><div style="font-size:11px;color:#94a3b8">Each button opens a page where you confirm (sign in first if asked); each link works once.</div>` : ''}
${href ? `<div style="margin-top:8px"><a href="${esc(href)}" style="display:inline-block;padding:7px 14px;border-radius:8px;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:600;font-size:13px">Open in ${esc(brand.installName)}</a></div>` : ''}
</div>`
}

/* ------------------------------------------------------------------ the service */

export interface DeliveryLogEntry { id: string; at: string; userId: string; notificationId: string | null; environmentId: string | null; kind: string; title: string; channel: string; status: string; reason: string; mailId: string | null }

export interface DeliveryService extends NotificationDelivery {
  policy(): Promise<DeliveryPolicy>
  savePolicy(raw: unknown): Promise<DeliveryPolicy>
  brand(): Promise<Brand>
  log(o: { userId?: string; limit: number; before?: string }): Promise<DeliveryLogEntry[]>
  /** runs one digest pass (the job; tests call it with a time) */
  runDigests(now?: Date): Promise<{ users: number; emails: number }>
  unsubscribeUrl(payload: Record<string, string>): Promise<string>
  key(): Buffer
}

export function createDelivery(services: CoreServices): DeliveryService {
  const db = (): SqlDb => {
    const d = services.state.db
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }
  let keyCache: Buffer | null = null
  const key = () => (keyCache ??= signingKey(services))
  let policyCache: { at: number; p: DeliveryPolicy } | null = null

  async function policy(): Promise<DeliveryPolicy> {
    if (policyCache && Date.now() - policyCache.at < 5000) return policyCache.p
    const rows = await db().query<{ v: string | null }>(`SELECT v FROM "ab"."settings" WHERE k = $1`, [POLICY_KEY])
    let p = defaultPolicy()
    if (rows[0]?.v) {
      try {
        p = parsePolicy(JSON.parse(rows[0].v))
      } catch {
        /* default */
      }
    }
    policyCache = { at: Date.now(), p }
    return p
  }

  async function brand(): Promise<Brand> {
    const b = await identity(services).mail.brand()
    return { ...b, logoUrl: (await policy()).logoUrl }
  }

  async function logDelivery(e: Omit<DeliveryLogEntry, 'id' | 'at'>): Promise<string> {
    const id = `dlv_${rowUid().replace(/-/g, '').slice(-20)}`
    await db().exec(
      `INSERT INTO "ab"."notification_deliveries" (id, at, user_id, notification_id, environment_id, kind, title, channel, status, reason, mail_id) VALUES ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, e.userId, e.notificationId, e.environmentId, e.kind, e.title.slice(0, 200), e.channel, e.status, e.reason.slice(0, 500), e.mailId],
    )
    return id
  }

  async function unsubscribeUrl(payload: Record<string, string>): Promise<string> {
    const b = await identity(services).mail.brand()
    return `${b.publicUrl}/api/v1/notifications/unsubscribe?t=${signToken(key(), payload)}`
  }

  async function sendEmail(user: { id: string; email: string; name: string }, items: (NotificationItem | { id?: string; kind: string; title: string; body: string; link: string | null; from?: string; createdOn?: string })[], o: { digest: boolean; kindForFooter: string; reason: string }): Promise<string> {
    const b = await brand()
    const mail = identity(services).mail
    const unsub = await unsubscribeUrl({ u: user.id, k: o.kindForFooter })
    const kinds = [...new Set(items.map((i) => label(i.kind)))]
    const heading = o.digest ? `${items.length} notification${items.length === 1 ? '' : 's'} for you` : items[0].title
    const subject = o.digest ? `${b.installName}: ${items.length} notification${items.length === 1 ? '' : 's'} (${kinds.slice(0, 3).join(', ')})` : `${b.installName}: ${items[0].title}`
    const why = `Why you got this: ${o.reason} `
    const footer = `${esc(why)}${b.publicUrl ? `<a href="${esc(unsub)}" style="color:#64748b">Stop emails about ${esc(o.digest ? 'these kinds' : `"${label(o.kindForFooter)}"`)}</a> (no sign-in needed) or change your choices in Settings &gt; Notifications.` : 'Change your choices in Settings > Notifications.'}`
    const html = emailFrame(b, heading, items.map((i) => itemHtml(b, i)).join('\n'), footer)
    const text = [
      heading, '',
      ...items.flatMap((i) => [i.title, ...(i.body ? [i.body] : []), ...(((i as { actions?: { label: string; url: string }[] }).actions ?? []).map((a) => `${a.label}: ${a.url}`)), ...(deepLink(b, i.link) ? [`Open: ${deepLink(b, i.link)}`] : []), '']),
      '--', why.trim(), ...(b.publicUrl ? [`Stop these emails: ${unsub}`] : []), 'Settings > Notifications changes what you get.',
    ].join('\n')
    const headers: Record<string, string> = b.publicUrl ? { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {}
    const r = await mail.send({ to: user.email, subject: subject.replace(/[\r\n]+/g, ' ').slice(0, 300), text, html, headers, template: o.digest ? 'notification_digest' : 'notification', userId: user.id })
    return r.id
  }

  const svc: DeliveryService = {
    policy,
    brand,
    key,
    unsubscribeUrl,
    async savePolicy(raw) {
      const p = parsePolicy(raw)
      await db().exec(`INSERT INTO "ab"."settings" (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [POLICY_KEY, JSON.stringify(p)])
      policyCache = null
      return p
    },
    async plan(_user, kind, prefs) {
      const e = effectiveChannels(await policy(), prefs, kind)
      return { inApp: e.inApp, inAppReason: e.inAppReason, email: e.email, emailReason: e.emailReason }
    },
    async deliver(user, item, plan, prefs) {
      const base = { userId: user.id, notificationId: item.id, environmentId: item.environmentId, kind: item.kind, title: item.title, mailId: null }
      await logDelivery({ ...base, channel: 'in_app', status: plan.inApp ? 'delivered' : 'skipped', reason: plan.inAppReason || 'In the app.' })
      if (plan.email === 'off') return
      const mail = identity(services).mail
      if (!(await mail.configured())) {
        await logDelivery({ ...base, channel: 'email', status: 'skipped', reason: `${plan.emailReason} Email is not set up on this server, so none was sent.` })
        return
      }
      if (!user.email || (await suppressedAmong(db(), [user.email])).size) {
        await logDelivery({ ...base, channel: 'email', status: 'skipped', reason: `${plan.emailReason} Your address is on the suppression list, so no email was sent.` })
        return
      }
      const now = new Date()
      const queueDigest = async (reason: string, holdUntil: Date | null) => {
        const did = await logDelivery({ ...base, channel: 'email', status: 'digest', reason })
        await db().exec(
          `INSERT INTO "ab"."notification_digest" (id, user_id, kind, title, body, link, environment_id, created_on, reason, hold_until, delivery_id) VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9, $10)`,
          [`dgi_${rowUid().replace(/-/g, '').slice(-20)}`, user.id, item.kind, item.title, item.body, item.link, item.environmentId, reason.slice(0, 500), holdUntil, did],
        )
      }
      if (plan.email === 'digest') {
        const d = prefs.digest ?? { frequency: 'daily', time: '08:00' }
        await queueDigest(`${plan.emailReason} It goes out in your ${d.frequency === 'hourly' ? 'hourly digest' : `daily digest at ${d.time}`}.`, null)
        return
      }
      if (inQuietHours(prefs, now)) {
        const end = quietEnd(prefs, now)
        await queueDigest(`${plan.emailReason} It arrived during your do-not-disturb hours and is sent when they end.`, end)
        return
      }
      const p = await policy()
      const recent = await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM "ab"."notification_deliveries" WHERE user_id = $1 AND channel = 'email' AND status = 'queued' AND at > now() - interval '1 hour'`, [user.id])
      if (Number(recent[0]?.n ?? 0) >= p.perRecipientPerHour) {
        const nextHour = new Date(Math.ceil((now.getTime() + 1) / 3600_000) * 3600_000)
        await queueDigest(`${plan.emailReason} More than ${p.perRecipientPerHour} emails reached you within an hour, so this one is collected and sent at the next full hour.`, nextHour)
        return
      }
      try {
        const mailId = await sendEmail(user, [item], { digest: false, kindForFooter: item.kind, reason: plan.emailReason })
        await logDelivery({ ...base, channel: 'email', status: 'queued', reason: plan.emailReason, mailId })
      } catch (e) {
        await logDelivery({ ...base, channel: 'email', status: 'failed', reason: `${plan.emailReason} Sending failed: ${errText(e).slice(0, 200)}` })
      }
    },
    async log(o) {
      const params: unknown[] = [Math.max(1, Math.min(200, o.limit))]
      const where: string[] = []
      if (o.userId) {
        params.push(o.userId)
        where.push(`user_id = $${params.length}`)
      }
      if (o.before) {
        params.push(new Date(o.before))
        where.push(`at < $${params.length}`)
      }
      const rows = await db().query<Record<string, unknown>>(`SELECT * FROM "ab"."notification_deliveries" ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT $1`, params)
      return rows.map((r) => ({
        id: String(r.id), at: new Date(r.at as string).toISOString(), userId: String(r.user_id), notificationId: r.notification_id ? String(r.notification_id) : null,
        environmentId: r.environment_id ? String(r.environment_id) : null, kind: String(r.kind), title: String(r.title), channel: String(r.channel), status: String(r.status), reason: String(r.reason), mailId: r.mail_id ? String(r.mail_id) : null,
      }))
    },
    async runDigests(now = new Date()) {
      const users = await db().query<{ user_id: string; oldest: Date; held: Date | null }>(
        `SELECT user_id, min(created_on) FILTER (WHERE hold_until IS NULL) AS oldest, min(hold_until) AS held FROM "ab"."notification_digest" GROUP BY user_id LIMIT 500`,
      )
      let emails = 0
      for (const r of users) {
        try {
          const u = await services.meta.users.get(r.user_id)
          if (!u || u.status === 'disabled') {
            await db().exec(`DELETE FROM "ab"."notification_digest" WHERE user_id = $1`, [r.user_id])
            continue
          }
          const prefs = await services.notifications!.settings(u.id)
          const st = await db().query<{ value: { lastSent?: string } }>(`SELECT value FROM "ab"."user_settings" WHERE user_id = $1 AND key = $2`, [u.id, DIGEST_STATE_KEY])
          const lastSent = st[0]?.value?.lastSent ? new Date(st[0].value.lastSent) : null
          const digestNow = digestDue(prefs, lastSent, r.oldest ? new Date(r.oldest) : null, now)
          const heldNow = r.held && new Date(r.held).getTime() <= now.getTime() && !inQuietHours(prefs, now)
          if (!digestNow && !heldNow) continue
          const items = await db().query<Record<string, unknown>>(
            `SELECT * FROM "ab"."notification_digest" WHERE user_id = $1 AND (${digestNow ? 'true OR ' : ''}hold_until <= $2) ORDER BY created_on LIMIT 200`, [u.id, now],
          )
          if (!items.length) continue
          const list = items.map((i) => ({ kind: String(i.kind), title: String(i.title), body: String(i.body ?? ''), link: i.link ? String(i.link) : null }))
          const kinds = [...new Set(list.map((i) => i.kind))]
          if (!(await identity(services).mail.configured())) break
          const reason = digestNow ? `You chose a ${prefs.digest?.frequency === 'hourly' ? 'hourly' : 'daily'} digest for ${kinds.map((k) => `"${label(k)}"`).join(', ')} notifications (or they waited for your quiet hours to end).` : 'These notifications waited for your do-not-disturb hours to end (or for the hourly email limit).'
          const mailId = await sendEmail({ id: u.id, email: u.email, name: u.name }, list, { digest: true, kindForFooter: kinds.length === 1 ? kinds[0] : '*', reason })
          await db().exec(`DELETE FROM "ab"."notification_digest" WHERE id = ANY($1::text[])`, [items.map((i) => String(i.id))])
          const deliveryIds = items.map((i) => i.delivery_id).filter((x): x is string => typeof x === 'string')
          if (deliveryIds.length) await db().exec(`UPDATE "ab"."notification_deliveries" SET status = 'sent', mail_id = $2 WHERE id = ANY($1::text[])`, [deliveryIds, mailId])
          if (digestNow) {
            await db().exec(
              `INSERT INTO "ab"."user_settings" (user_id, key, value, modified_on) VALUES ($1, $2, $3, now()) ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, modified_on = EXCLUDED.modified_on`,
              [u.id, DIGEST_STATE_KEY, JSON.stringify({ lastSent: now.toISOString() })],
            )
          }
          emails++
        } catch (e) {
          log('warn', `digest for ${r.user_id} failed: ${errText(e)}`)
        }
      }
      return { users: users.length, emails }
    },
  }
  return svc
}

/* ------------------------------------------------------------------ jobs and routes */

export function registerDeliveryJobs(services: CoreServices, d: DeliveryService): void {
  services.kernel.jobs.register({
    type: DIGEST_JOB,
    schedule: 'install',
    description: 'Sends notification digests that are due and emails held back by quiet hours (the whole install).',
    concurrency: 1,
    maxAttempts: 2,
    async handler(_p, ctx) {
      if (ctx.environmentId !== DEFAULT_ENVIRONMENT_ID) return { skipped: 'install-wide: runs in Default' }
      return d.runDigests()
    },
  })
  services.kernel.jobs.register<{ days: number }>({
    type: DELIVERY_RETENTION_JOB,
    schedule: 'install',
    description: 'Deletes notification delivery log entries older than the configured number of days (the whole install).',
    parse(raw) {
      const n = Number(isObj(raw) ? raw.days : 90)
      return { days: Number.isInteger(n) && n >= 7 && n <= 3650 ? n : 90 }
    },
    async handler(p, ctx) {
      if (ctx.environmentId !== DEFAULT_ENVIRONMENT_ID) return { skipped: true }
      const r = await services.state.db!.exec(`DELETE FROM "ab"."notification_deliveries" WHERE at < $1`, [new Date(Date.now() - p.days * 86400_000)])
      return { deleted: r.affectedRows }
    },
  })
  if (!INSTALL_SCHEDULES.some((s) => s.id === 'sched_notification_digest')) {
    INSTALL_SCHEDULES.push(
      { id: 'sched_notification_digest', name: 'Notification digests', description: 'Every 5 minutes: sends the digest emails that are due and emails held back by quiet hours.', intervalSeconds: 300, jobType: DIGEST_JOB, payload: {}, enabled: true, misfire: 'run_once' },
      { id: 'sched_notification_delivery_retention', name: 'Notification delivery log retention', description: 'Deletes notification delivery log entries (the whole install) older than the configured number of days.', cron: '43 4 * * *', jobType: DELIVERY_RETENTION_JOB, payload: { days: 90 }, enabled: true },
    )
  }
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

function page(title: string, inner: string): { raw: true; status: number; headers: Record<string, string>; body: string } {
  return {
    raw: true, status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f8fafc;color:#0f172a;padding:40px 16px"><div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px">${inner}</div></body></html>`,
  }
}

/** report unsubscribes are handled by the reports module (it registers here) */
export type ReportUnsubscribe = (env: string, reportId: string, userId: string) => Promise<{ name: string } | null>

export function deliveryRoutes(router: ApiRouter, services: CoreServices, d: DeliveryService, o: { reportUnsubscribe?: () => ReportUnsubscribe | null } = {}): void {
  const me = (ctx: Ctx) => ctx.user!.user.id
  const installAdmin = (ctx: Ctx) => {
    if (!ctx.user?.user.isInstallAdmin) throw new HttpError(403, 'denied', 'Only install administrators can change notification defaults.')
  }

  /** the caller's channels per kind, with locks and reasons (Settings > Notifications) */
  router.add('GET', '/notifications/channels', async (ctx) => {
    const prefs = await services.notifications!.settings(me(ctx))
    const p = await d.policy()
    const kinds = [...NOTIFICATION_KINDS.map((k) => k.kind), ...Object.keys(p.kinds).filter((k) => !NOTIFICATION_KINDS.some((x) => x.kind === k))]
    return {
      emailAvailable: await identity(services).mail.configured(),
      email: ctx.user!.user.email,
      kinds: kinds.map((k) => {
        const e = effectiveChannels(p, prefs, k)
        const meta = NOTIFICATION_KINDS.find((x) => x.kind === k)
        return { kind: k, label: meta?.label ?? k, description: meta?.description ?? '', inApp: e.inApp, email: e.email, locked: e.locked, inAppReason: e.inAppReason, emailReason: e.emailReason, whatsapp: 'unavailable' }
      }),
      digest: prefs.digest ?? { frequency: 'daily', time: '08:00' },
      timeZone: prefs.timeZone ?? 'UTC',
      quietEmail: prefs.quietEmail !== false,
    }
  }, { auth: 'user', noEnvironment: true })

  router.add('GET', '/notifications/deliveries', async (ctx) => ({ items: await d.log({ userId: me(ctx), limit: Number(ctx.query.get('limit') ?? 50) || 50, before: ctx.query.get('before') ?? undefined }) }), { auth: 'user', noEnvironment: true })

  router.add('GET', '/admin/notifications/deliveries', async (ctx) => {
    installAdmin(ctx)
    return { items: await d.log({ userId: ctx.query.get('userId') || undefined, limit: Number(ctx.query.get('limit') ?? 100) || 100, before: ctx.query.get('before') ?? undefined }) }
  }, { auth: 'admin', noEnvironment: true })

  router.add('GET', '/admin/notifications/policy', async (ctx) => {
    installAdmin(ctx)
    return { ...(await d.policy()), kindsKnown: NOTIFICATION_KINDS }
  }, { auth: 'admin', noEnvironment: true })

  router.add('PUT', '/admin/notifications/policy', async (ctx) => {
    installAdmin(ctx)
    const p = await d.savePolicy(ctx.body)
    try {
      await services.install.audit({ userId: me(ctx), action: 'notifications.policy', details: p })
    } catch (e) {
      log('error', `audit write failed (notifications.policy): ${errText(e)}`)
    }
    return p
  }, { auth: 'admin', noEnvironment: true })

  /* ---------------------------------------------------------------- unsubscribe without signing in */

  const describe = async (t: Record<string, string>): Promise<{ what: string; ok: boolean; locked?: boolean }> => {
    const u = await services.meta.users.get(t.u)
    if (!u) return { what: '', ok: false }
    if (t.r && t.e) return { what: 'this scheduled report', ok: true }
    if (t.k === '*') return { what: 'notification emails', ok: true }
    const p = await d.policy()
    const locked = !!p.kinds[t.k]?.lock && (p.kinds[t.k]?.email ?? 'off') !== 'off'
    return { what: `emails about "${label(t.k)}" notifications`, ok: true, locked }
  }

  router.add('GET', '/notifications/unsubscribe', async (ctx) => {
    const t = verifyToken(d.key(), ctx.query.get('t') ?? '')
    const info = t ? await describe(t) : null
    if (!t || !info?.ok) return page('Link not valid', '<h1 style="font-size:18px">This link is not valid</h1><p>It may have been changed or the account no longer exists. Sign in and change your choices in Settings &gt; Notifications.</p>')
    if (info.locked) return page('Required by your administrator', `<h1 style="font-size:18px">These emails are required</h1><p>Your administrator requires ${esc(info.what)} for everyone. Ask them if you think this is wrong.</p>`)
    return page('Stop emails', `<h1 style="font-size:18px">Stop ${esc(info.what)}?</h1><p>You will not get ${esc(info.what)} any more. You can switch them on again in Settings &gt; Notifications.</p>
<form method="post" action=""><input type="hidden" name="t" value="${esc(ctx.query.get('t') ?? '')}"><button type="submit" style="padding:9px 16px;border-radius:8px;border:0;background:#4f46e5;color:#fff;font-weight:600;cursor:pointer">Stop these emails</button></form>`)
  }, { auth: 'none' })

  // one-click (RFC 8058: List-Unsubscribe=One-Click from the mail client) and the form above
  router.add('POST', '/notifications/unsubscribe', async (ctx) => {
    const raw = (ctx.rawBody ?? Buffer.alloc(0)).toString('utf8').slice(0, 4000)
    const form = new URLSearchParams(raw)
    const token = ctx.query.get('t') ?? form.get('t') ?? ''
    const t = verifyToken(d.key(), token)
    const info = t ? await describe(t) : null
    if (!t || !info?.ok) return { ...page('Link not valid', '<h1 style="font-size:18px">This link is not valid</h1>'), status: 400 }
    if (info.locked) return page('Required by your administrator', `<h1 style="font-size:18px">These emails are required</h1><p>Your administrator requires ${esc(info.what)} for everyone.</p>`)
    if (t.r && t.e) {
      const fn = o.reportUnsubscribe?.()
      const r = fn ? await fn(t.e, t.r, t.u) : null
      if (!r) return { ...page('Report not found', '<h1 style="font-size:18px">This report no longer exists</h1>'), status: 404 }
      await services.install.audit({ userId: t.u, action: 'report.unsubscribe', details: { environment: t.e, report: t.r } }).catch(() => {})
      return page('Unsubscribed', `<h1 style="font-size:18px">Done</h1><p>You will not get the report "${esc(r.name)}" any more.</p>`)
    }
    const svc = services.notifications!
    const cur = await svc.settings(t.u)
    const p = await d.policy()
    const kinds = t.k === '*' ? [...new Set([...NOTIFICATION_KINDS.map((k) => k.kind), ...Object.keys(p.kinds)])].filter((k) => !p.kinds[k]?.lock) : [t.k]
    const next = parseNotificationSettings({ ...cur, email: { ...(cur.email ?? {}), ...Object.fromEntries(kinds.map((k) => [k, 'off'])) } })
    await svc.saveSettings(t.u, next)
    await services.install.audit({ userId: t.u, action: 'notifications.unsubscribe', details: { kinds } }).catch(() => {})
    return page('Unsubscribed', `<h1 style="font-size:18px">Done</h1><p>You will not get ${esc(info.what)} any more. You can switch them on again in Settings &gt; Notifications.</p>`)
  }, { auth: 'none', raw: true, maxBodyMB: 0.01, csrfExempt: true })

}
