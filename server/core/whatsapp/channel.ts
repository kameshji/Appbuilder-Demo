/**
 * The notification channel `whatsapp` (docs/dev/notifications-delivery.md, docs/dev/whatsapp.md). A person gets a
 * notification on WhatsApp only when ALL of these hold in the notification's environment:
 *
 *   - an administrator mapped notifications to a WhatsApp connection and an approved template (Admin console > WhatsApp);
 *   - the person turned WhatsApp on for that kind (Settings > Notifications; off by default for every kind);
 *   - the person's profile phone number normalises to E.164 and has a CURRENT opt-in (the send path checks it again
 *     when the message goes out).
 *
 * Otherwise the channel is simply not used and the delivery log says why. Messages are immediate (no WhatsApp digest);
 * during the person's do-not-disturb hours they wait until the hours end (a delayed job). The job sends through
 * sendMessage (send.ts) with the idempotency key `notify:<notification>:<user>`, so a retried job sends once.
 */
import type { CoreServices } from '../services.ts'
import type { ConnectionRecord, SqlDb } from '../contracts.ts'
import type { NotificationSettings } from '../../../src/platform/live-protocol.ts'
import type { DeliveryService } from '../notifications-delivery.ts'
import { inQuietHours, quietEnd } from '../notifications-delivery.ts'
import { JobError } from '../jobs.ts'
import { runInEnvironment } from '../env-context.ts'
import { OutboundError } from '../actions/outbound.ts'
import { normalizePhone } from './phone.ts'
import { hasCurrentOptIn, notificationMapping, prefsOf, type NotificationMapping } from './store.ts'
import { sendMessage } from './send.ts'

export const NOTIFY_JOB = 'whatsapp.notify'

export interface Offer { offered: boolean; reason: string; phone: string | null; optedIn: boolean; mapping: NotificationMapping | null }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** may this person be offered the WhatsApp channel in the current environment? (and why not) */
export async function offerFor(services: CoreServices, db: SqlDb, user: { id: string; phone?: string }): Promise<Offer & { connection: ConnectionRecord | null }> {
  const mapping = await notificationMapping(db)
  const none = (reason: string, phone: string | null = null, optedIn = false) => ({ offered: false, reason, phone, optedIn, mapping, connection: null })
  if (!mapping || !mapping.enabled) return none('Your administrator has not set up WhatsApp notifications in this environment.')
  const conn = await services.meta.connections.get(mapping.connectionId)
  if (!conn || conn.connector !== 'whatsapp') return none('The WhatsApp connection chosen for notifications no longer exists.')
  if (!conn.secret) return none('The WhatsApp connection chosen for notifications has no access token (for example in a copied environment).')
  if (conn.settings?.sendingEnabled === 'false') return none('Sending is turned off on the WhatsApp connection chosen for notifications.')
  let phone: string
  try {
    phone = normalizePhone(user.phone ?? '', conn.settings?.defaultCountryCode)
  } catch {
    return none('Your profile has no usable phone number. Ask your administrator to add it to your user record.')
  }
  const optedIn = await hasCurrentOptIn(db, phone)
  if (!optedIn) return { ...none('Your number has no WhatsApp opt-in yet: opt in below to be offered WhatsApp notifications.', phone, false) }
  return { offered: true, reason: 'WhatsApp notifications are available for you.', phone, optedIn, mapping, connection: conn }
}

interface NotifyPayload { userId: string; deliveryId: string; notificationId: string; kind: string; title: string; body: string; link: string | null }

export function registerWhatsappChannel(services: CoreServices, delivery: DeliveryService): void {
  delivery.addChannel({
    id: 'whatsapp',
    async deliver({ user, item, prefs, log }) {
      if (!item.environmentId) return
      await runInEnvironment(item.environmentId, async () => {
        const db = services.state.db
        if (!db) return
        const chosen = (await prefsOf(db, user.id))[item.kind] === true
        if (!chosen) return // not chosen (the default): nothing to log, like a channel that is off
        const u = await services.meta.users.get(user.id)
        const offer = await offerFor(services, db, { id: user.id, phone: u?.phone })
        if (!offer.offered) {
          await log({ status: 'skipped', reason: `You chose WhatsApp for these notifications, but none was sent: ${offer.reason}` })
          return
        }
        const now = new Date()
        const quiet = inQuietHours({ ...prefs, quietEmail: true } as NotificationSettings, now)
        const reason = quiet ? 'You chose WhatsApp for these notifications. It arrived during your do-not-disturb hours and is sent when they end.' : 'You chose WhatsApp for these notifications.'
        const deliveryId = await log({ status: 'queued', reason })
        const payload: NotifyPayload = { userId: user.id, deliveryId, notificationId: item.id, kind: item.kind, title: item.title, body: item.body ?? '', link: item.link }
        await services.kernel.jobs.enqueue(NOTIFY_JOB, payload, { idempotencyKey: `wa-notify:${item.id}:${user.id}`, ...(quiet ? { runAt: quietEnd(prefs, now) } : {}) })
      })
    },
  })

  services.kernel.jobs.register<NotifyPayload>({
    type: NOTIFY_JOB,
    description: 'Sends one notification to a person on WhatsApp (their choice, consent and the template checked again at sending time).',
    maxAttempts: 5,
    parse(raw) {
      if (!isObj(raw) || typeof raw.userId !== 'string' || typeof raw.notificationId !== 'string' || typeof raw.deliveryId !== 'string') throw new JobError('malformed WhatsApp notification job', { retry: false })
      return raw as unknown as NotifyPayload
    },
    async handler(p, ctx) {
      const db = services.state.db!
      const finish = (status: string, reason: string) => delivery.updateLog(p.deliveryId, status, reason).catch(() => {})
      const u = await services.meta.users.get(p.userId)
      if (!u || u.status === 'disabled') { await finish('skipped', 'The account is disabled; no WhatsApp message was sent.'); return { skipped: 'user' } }
      if ((await prefsOf(db, p.userId))[p.kind] !== true) { await finish('skipped', 'WhatsApp was turned off for these notifications before the message went out.'); return { skipped: 'prefs' } }
      const offer = await offerFor(services, db, { id: u.id, phone: u.phone })
      if (!offer.offered || !offer.connection || !offer.mapping) { await finish('skipped', `No WhatsApp message was sent: ${offer.reason}`); return { skipped: 'offer' } }
      const m = offer.mapping
      const brand = await delivery.brand().catch(() => ({ installName: 'Appbuilder', publicUrl: '', logoUrl: '' }))
      const values = m.params.map((k) => {
        const v = k === 'title' ? p.title : k === 'body' ? p.body || p.title : brand.publicUrl ? `${brand.publicUrl}/${p.link && p.link.startsWith('#') ? p.link : ''}` : brand.installName
        // Meta: no new lines or tabs in template values, at most 1024 characters
        return (v || '-').replace(/[\r\n\t]+/g, ' ').replace(/ {5,}/g, '    ').slice(0, 1000)
      })
      try {
        const r = await sendMessage({
          db, connection: offer.connection, to: offer.phone, message: { kind: 'template', template: m.template, language: m.language, bodyParams: values },
          identity: null, idempotencyKey: `notify:${p.notificationId}:${p.userId}`, source: `notification:${p.kind}`, notificationId: p.notificationId,
          cache: new Map(), timeoutMs: 30_000, signal: ctx.signal,
        })
        await finish('sent', `You chose WhatsApp for these notifications. Accepted by Meta (message ${r.messageId}).`)
        return { messageId: r.messageId }
      } catch (e) {
        const err = e instanceof OutboundError ? e : null
        if (err?.retryable && ctx.job.attempts < ctx.job.maxAttempts) throw new JobError(err.message, { retry: true })
        await finish('failed', `The WhatsApp message was not sent: ${(err?.message ?? 'unexpected error').slice(0, 300)}`)
        return { failed: err?.code ?? 'internal' }
      }
    },
  })
}
