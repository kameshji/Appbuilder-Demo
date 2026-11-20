/**
 * P2 package E wiring (called once from actions/wiring.ts): the WhatsApp action provider, the inbound webhook, the admin
 * and self-service routes, the notification channel and the retention job. Design: docs/dev/whatsapp.md.
 */
import type { ApiRouter } from '../router.ts'
import type { CoreServices } from '../services.ts'
import type { ActionsServiceImpl } from '../actions/service.ts'
import type { DeliveryService } from '../notifications-delivery.ts'
import { BUILTIN_SCHEDULES } from '../kernel.ts'
import { JobError } from '../jobs.ts'
import { createWhatsappProvider } from './provider.ts'
import { whatsappWebhookRoutes } from './webhook.ts'
import { whatsappRoutes } from './routes.ts'
import { registerWhatsappChannel } from './channel.ts'
import { T } from './store.ts'

export const WHATSAPP_RETENTION_JOB = 'whatsapp.retention'

export function wireWhatsapp(router: ApiRouter, services: CoreServices, actions: ActionsServiceImpl, delivery: DeliveryService): void {
  actions.register(createWhatsappProvider())
  whatsappWebhookRoutes(router, services)
  whatsappRoutes(router, services, actions)
  registerWhatsappChannel(services, delivery)

  // the message log is kept like the connector activity (90 days by default); opt-ins and their history are never deleted
  services.kernel.jobs.register<{ days: number }>({
    type: WHATSAPP_RETENTION_JOB,
    schedule: 'custom',
    description: 'Deletes WhatsApp message log entries older than the configured number of days, old webhook replay marks and 24-hour window marks. Opt-ins and their history are kept.',
    parse(raw) {
      const d = Number(raw && typeof raw === 'object' ? (raw as { days?: unknown }).days : 90)
      if (!Number.isInteger(d) || d < 7 || d > 3650) throw new JobError('days must be a whole number between 7 and 3650', { retry: false })
      return { days: d }
    },
    async handler(p) {
      const db = services.state.db!
      const a = await db.exec(`DELETE FROM ${T('ab_whatsapp_messages')} WHERE created_on < $1`, [new Date(Date.now() - p.days * 86400_000)])
      const b = await db.exec(`DELETE FROM ${T('ab_whatsapp_hook_seen')} WHERE seen_on < now() - interval '8 days'`)
      const c = await db.exec(`DELETE FROM ${T('ab_whatsapp_windows')} WHERE last_inbound_on < now() - interval '30 days'`)
      return { messages: a.affectedRows, replayMarks: b.affectedRows, windows: c.affectedRows }
    },
  })
  if (!BUILTIN_SCHEDULES.some((b) => b.id === 'sched_whatsapp_retention')) {
    BUILTIN_SCHEDULES.push({ id: 'sched_whatsapp_retention', name: 'WhatsApp message log retention', description: 'Deletes WhatsApp message log entries older than the configured number of days (default 90). Opt-ins are kept.', cron: '33 4 * * *', jobType: WHATSAPP_RETENTION_JOB, payload: { days: 90 }, enabled: true })
  }
}
