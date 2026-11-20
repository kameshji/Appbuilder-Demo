/**
 * P1 package D wiring (called once from app.ts): services.actions with the HTTP, Email (and P2-E WhatsApp) providers, their routes,
 * inbound webhooks, RunConnector of table after-events, notification delivery (email channel, digests, unsubscribe)
 * and scheduled reports.
 */
import type { ApiRouter } from '../router.ts'
import type { CoreServices } from '../services.ts'
import type { FxValue } from '../../../src/contracts.ts'
import { JobError } from '../jobs.ts'
import { createActionsService, type ActionsServiceImpl } from './service.ts'
import { createHttpProvider } from './http.ts'
import { createEmailProvider } from './email.ts'
import { actionRoutes } from './routes.ts'
import { createWebhookService, webhookRoutes, type WebhookService } from './webhooks.ts'
import { createDelivery, deliveryRoutes, registerDeliveryJobs, type DeliveryService } from '../notifications-delivery.ts'
import { createReports, reportRoutes, type Reports } from '../reports.ts'
import type { createNotificationService } from '../notifications.ts'
import { wireWhatsapp } from '../whatsapp/index.ts'

/** a formula value -> plain JSON for action inputs (dates as ISO text, internal fields dropped) */
export function fxToJson(v: FxValue, depth = 0): unknown {
  if (depth > 30) return null
  if (v instanceof Date) return v.toISOString()
  if (Array.isArray(v)) return v.map((x) => fxToJson(x, depth + 1))
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) if (!k.startsWith('__')) o[k] = fxToJson(x, depth + 1)
    return o
  }
  return v
}

export interface ActionsWiring {
  actions: ActionsServiceImpl
  webhooks: WebhookService
  delivery: DeliveryService
  reports: Reports
}

export function wireActions(router: ApiRouter, services: CoreServices, notifications: ReturnType<typeof createNotificationService>): ActionsWiring {
  const actions = createActionsService(services)
  actions.register(createHttpProvider())
  actions.register(createEmailProvider())
  services.actions = actions
  actionRoutes(router, services, actions)

  const webhooks = createWebhookService(services)
  webhookRoutes(router, services, webhooks)

  // RunConnector(connection, action, inputs) in table after-events: through services.actions as the event's identity;
  // the connection must be attached to the event (by a maker who holds "use"); named by id or by name
  services.kernel.events.setConnectorActionSink({
    async invoke(c) {
      const all = await services.meta.connections.list()
      const want = c.connection.trim()
      const rec = all.find((x) => x.id === want) ?? all.find((x) => x.name.toLowerCase() === want.toLowerCase())
      if (!rec) throw new JobError(`RunConnector: there is no connection "${want.slice(0, 80)}".`, { retry: false })
      if (!(c.attached ?? []).includes(rec.id)) throw new JobError(`RunConnector: the connection "${rec.name}" is not attached to this event. A maker with "use" access attaches it in the event's Connections list.`, { retry: false })
      const r = await actions.run(c.environmentId, rec.id, c.action, fxToJson((c.input ?? {}) as FxValue) ?? {}, c.runAs, { idempotencyKey: c.idempotencyKey, source: c.eventId ? `event:${c.eventId}` : 'event', correlationId: c.correlationId })
      if (!r.ok) throw new JobError(`RunConnector ${rec.name}.${c.action}: ${r.error.message}`, { retry: r.error.retryable })
      return r.output
    },
  })

  const delivery = createDelivery(services)
  notifications.setDelivery(delivery)
  registerDeliveryJobs(services, delivery)
  // P2-E: the WhatsApp connector (provider, inbound webhook, opt-ins, message log, notification channel)
  wireWhatsapp(router, services, actions, delivery)
  const reports = createReports(services, delivery)
  deliveryRoutes(router, services, delivery, { reportUnsubscribe: () => reports.unsubscribe })
  reportRoutes(router, services, reports)
  return { actions, webhooks, delivery, reports }
}
