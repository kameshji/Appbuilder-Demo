/**
 * Client calls of the WhatsApp connector (P2 package E; server/core/whatsapp/routes.ts). Administrators: opt-ins, the
 * message log, keywords and the notification mapping. Everyone: their own WhatsApp notification choice and consent.
 */
import { idCall } from './identityApi'

export interface OptIn { phone: string; status: 'opted_in' | 'opted_out'; source: string; evidence: string; recordedBy: string | null; recordedOn: string; contactTable: string | null; contactRow: string | null }
export interface WaMessage {
  id: string; connectionId: string; direction: 'out' | 'in'; phone: string; kind: string; template: string | null; language: string | null; status: string
  history: { status: string; at: string; error?: string }[]; providerId: string | null; idempotencyKey: string | null; source: string | null
  notificationId: string | null; errorCode: string | null; error: string | null; createdOn: string
}
export interface NotificationMapping { enabled: boolean; connectionId: string; template: string; language: string; params: ('title' | 'body' | 'link')[] }
export interface WaSettings {
  keywords: { stop: string[]; start: string[] }
  defaults: { stop: string[]; start: string[] }
  notifications: NotificationMapping | null
  webhooks: { connectionId: string; name: string; url: string; hasAppSecret: boolean; hasVerifyToken: boolean; sendingEnabled: boolean; defaultCountryCode: string }[]
}
export interface WaMe { offered: boolean; reason: string; phone: string | null; optedIn: boolean; canOptIn: boolean; kinds: Record<string, boolean>; available: { kind: string; label: string }[] }

const enc = encodeURIComponent

export const whatsappApi = {
  optins: (o: { status?: string; search?: string } = {}) => idCall<{ items: OptIn[]; total: number }>('GET', `/whatsapp/optins?limit=200${o.status ? `&status=${enc(o.status)}` : ''}${o.search ? `&search=${enc(o.search)}` : ''}`),
  record: (b: { phone: string; status: 'opted_in' | 'opted_out'; source: string; evidence: string }) => idCall<{ optIn: OptIn }>('POST', '/whatsapp/optins', b),
  history: (phone: string) => idCall<{ items: (OptIn & { id: string })[] }>('GET', `/whatsapp/optins/${enc(phone)}/history`),
  messages: (o: { phone?: string; status?: string } = {}) => idCall<{ items: WaMessage[] }>('GET', `/whatsapp/messages?limit=200${o.phone ? `&phone=${enc(o.phone)}` : ''}${o.status ? `&status=${enc(o.status)}` : ''}`),
  settings: () => idCall<WaSettings>('GET', '/whatsapp/settings'),
  saveSettings: (b: { keywords?: { stop: string[]; start: string[] }; notifications?: NotificationMapping | null }) => idCall<Pick<WaSettings, 'keywords' | 'notifications'>>('PUT', '/whatsapp/settings', b),
  me: () => idCall<WaMe>('GET', '/whatsapp/me'),
  saveMe: (kinds: Record<string, boolean>) => idCall<WaMe>('PUT', '/whatsapp/me', { kinds }),
  optInMe: () => idCall<WaMe>('POST', '/whatsapp/me/opt-in', { consent: true }),
  optOutMe: () => idCall<WaMe>('POST', '/whatsapp/me/opt-out', {}),
}
