/**
 * HTTP API of the WhatsApp connector (besides the connection itself and its actions, which are the framework's):
 *
 *   Administrators of the environment (Admin console > WhatsApp):
 *   GET    /whatsapp/optins?status&search&limit&offset      the current opt-ins (full numbers)
 *   POST   /whatsapp/optins                                  { phone, status, source, evidence, contactTable?, contactRow? }
 *   POST   /whatsapp/optins/import                           { rows: [{ phone, status? }], evidence, status? } (source "import")
 *   GET    /whatsapp/optins/:phone/history                   every recorded change of one number
 *   GET    /whatsapp/messages?phone&status&direction&limit&before   the message log (full numbers)
 *   GET    /whatsapp/settings                                keywords, the notification mapping, the webhook addresses
 *   PUT    /whatsapp/settings                                { keywords?: { stop, start }, notifications?: { ... } | null }
 *
 *   Everyone signed in (Settings > Notifications), about themselves only:
 *   GET    /whatsapp/me                                      offered?, why not, masked number, opt-in, kinds chosen
 *   PUT    /whatsapp/me                                      { kinds: { <kind>: boolean } } (only when offered)
 *   POST   /whatsapp/me/opt-in   { consent: true }           records an opt-in for the number on their own user record
 *   POST   /whatsapp/me/opt-out                              records an opt-out
 *
 * Every change is audited (whatsapp.optin, whatsapp.optin.import, whatsapp.settings); the audit has masked numbers only.
 */
import type { ApiRouter } from '../router.ts'
import type { CoreServices } from '../services.ts'
import type { Ctx, SqlDb } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import type { ActionsServiceImpl } from '../actions/service.ts'
import { currentEnvironment } from '../env-context.ts'
import { identity } from '../identity/index.ts'
import { NOTIFICATION_KINDS } from '../../../src/platform/live-protocol.ts'
import { errText, log } from '../util.ts'
import { LANGUAGE_CODE, OPTIN_SOURCES, TEMPLATE_NAME, type OptInSource } from './defs.ts'
import { maskPhone, normalizePhone, PhoneError } from './phone.ts'
import { DEFAULT_START_KEYWORDS, DEFAULT_STOP_KEYWORDS, cleanKeywords, keywords, listMessages, listOptIns, notificationMapping, optInHistory, parseMapping, prefsOf, putSetting, recordOptIn, savePrefs } from './store.ts'
import { listTemplates } from './provider.ts'
import { offerFor } from './channel.ts'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const body = (ctx: Ctx): Record<string, unknown> => {
  if (!isObj(ctx.body)) throw new HttpError(422, 'invalid', 'The request body must be a JSON object.')
  return ctx.body
}
const db = (s: CoreServices): SqlDb => {
  const d = s.state.db
  if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
  return d
}

async function audit(s: CoreServices, ctx: Ctx, action: string, details: unknown): Promise<void> {
  try {
    await s.meta.audit({ userId: ctx.user?.user.id ?? null, action, details })
  } catch (e) {
    log('error', `audit write failed (${action}): ${errText(e)}`)
  }
}

/** the default country code of the environment's WhatsApp connections (the first one), for numbers typed without one */
async function defaultCountry(s: CoreServices): Promise<string | undefined> {
  const list = (await s.meta.connections.list()).filter((c) => c.connector === 'whatsapp')
  return list.find((c) => c.settings?.defaultCountryCode)?.settings?.defaultCountryCode
}

async function phoneOrThrow(s: CoreServices, raw: unknown): Promise<string> {
  try {
    return normalizePhone(raw, await defaultCountry(s))
  } catch (e) {
    throw new HttpError(422, 'invalid', e instanceof PhoneError ? e.message : 'The phone number is not valid.', 'phone')
  }
}

export function whatsappRoutes(router: ApiRouter, s: CoreServices, actions: ActionsServiceImpl): void {
  /* ---------------------------------------------------------------- administrators */

  router.add('GET', '/whatsapp/optins', async (ctx) => {
    const r = await listOptIns(db(s), { status: ctx.query.get('status') ?? undefined, search: ctx.query.get('search') ?? undefined, limit: Number(ctx.query.get('limit') ?? 100) || 100, offset: Number(ctx.query.get('offset') ?? 0) || 0 })
    return r
  }, { auth: 'admin' })

  router.add('POST', '/whatsapp/optins', async (ctx) => {
    const b = body(ctx)
    const phone = await phoneOrThrow(s, b.phone)
    const source = (typeof b.source === 'string' ? b.source : 'administrator') as OptInSource
    if (!(OPTIN_SOURCES as readonly string[]).includes(source)) throw new HttpError(422, 'invalid', `The source is one of: ${OPTIN_SOURCES.join(', ')}.`, 'source')
    const o = await recordOptIn(db(s), {
      phone, status: b.status as 'opted_in', source, evidence: String(b.evidence ?? ''), by: ctx.user!.user.id,
      contactTable: typeof b.contactTable === 'string' ? b.contactTable : null, contactRow: typeof b.contactRow === 'string' ? b.contactRow : null,
    })
    await audit(s, ctx, 'whatsapp.optin', { phone: maskPhone(phone), status: o.status, source })
    return { optIn: o }
  }, { auth: 'admin' })

  router.add('POST', '/whatsapp/optins/import', async (ctx) => {
    const b = body(ctx)
    const rows = Array.isArray(b.rows) ? b.rows : []
    if (!rows.length || rows.length > 5000) throw new HttpError(422, 'invalid', 'Send 1 to 5000 rows: [{ "phone": "...", "status": "opted_in" }].', 'rows')
    const evidence = String(b.evidence ?? '').trim()
    if (evidence.length < 10) throw new HttpError(422, 'invalid', 'Describe where the consents in this import come from (at least 10 characters).', 'evidence')
    const cc = await defaultCountry(s)
    const problems: { row: number; message: string }[] = []
    const ok: { phone: string; status: 'opted_in' | 'opted_out'; evidence: string }[] = []
    rows.forEach((r, i) => {
      const o: Record<string, unknown> = isObj(r) ? r : { phone: r }
      const status = o.status === undefined ? (b.status === 'opted_out' ? 'opted_out' : 'opted_in') : o.status
      if (status !== 'opted_in' && status !== 'opted_out') return problems.push({ row: i + 1, message: 'The status is opted_in or opted_out.' })
      try {
        ok.push({ phone: normalizePhone(o.phone, cc), status: status as 'opted_in' | 'opted_out', evidence: typeof o.evidence === 'string' && o.evidence.trim().length >= 10 ? `${evidence} / ${o.evidence.trim()}` : evidence })
      } catch (e) {
        problems.push({ row: i + 1, message: e instanceof PhoneError ? e.message : 'The phone number is not valid.' })
      }
    })
    if (problems.length) return { imported: 0, problems: problems.slice(0, 100) }
    for (const r of ok) await recordOptIn(db(s), { phone: r.phone, status: r.status, source: 'import', evidence: r.evidence, by: ctx.user!.user.id })
    await audit(s, ctx, 'whatsapp.optin.import', { rows: ok.length, optedIn: ok.filter((r) => r.status === 'opted_in').length })
    return { imported: ok.length, problems: [] }
  }, { auth: 'admin', maxBodyMB: 2 })

  router.add('GET', '/whatsapp/optins/:phone/history', async (ctx) => {
    const phone = await phoneOrThrow(s, ctx.params.phone)
    return { phone, items: await optInHistory(db(s), phone) }
  }, { auth: 'admin' })

  router.add('GET', '/whatsapp/messages', async (ctx) => {
    const p = ctx.query.get('phone')
    const items = await listMessages(db(s), { phone: p ? await phoneOrThrow(s, p) : undefined, status: ctx.query.get('status') ?? undefined, direction: ctx.query.get('direction') ?? undefined, limit: Number(ctx.query.get('limit') ?? 100) || 100, before: ctx.query.get('before') ?? undefined })
    return { items }
  }, { auth: 'admin' })

  const webhookInfo = async () => {
    const base = await identity(s).mail.brand().then((b) => b.publicUrl).catch(() => '')
    const env = currentEnvironment().id
    return (await s.meta.connections.list()).filter((c) => c.connector === 'whatsapp').map((c) => ({
      connectionId: c.id, name: c.name, url: `${base}/api/v1/whatsapp/webhook/${encodeURIComponent(env)}/${encodeURIComponent(c.id)}`,
      hasAppSecret: false, hasVerifyToken: false, sendingEnabled: c.settings?.sendingEnabled !== 'false', defaultCountryCode: c.settings?.defaultCountryCode ?? '',
    }))
  }

  router.add('GET', '/whatsapp/settings', async () => {
    const hooks = await webhookInfo()
    for (const h of hooks) {
      const rec = await s.meta.connections.get(h.connectionId)
      try {
        const sec = rec?.secret ? JSON.parse(rec.secret) as Record<string, unknown> : {}
        h.hasAppSecret = typeof sec.appSecret === 'string' && !!sec.appSecret
        h.hasVerifyToken = typeof sec.verifyToken === 'string' && !!sec.verifyToken
      } catch { /* not JSON: nothing set */ }
    }
    return { keywords: await keywords(db(s)), defaults: { stop: DEFAULT_STOP_KEYWORDS, start: DEFAULT_START_KEYWORDS }, notifications: await notificationMapping(db(s)), webhooks: hooks, kinds: NOTIFICATION_KINDS }
  }, { auth: 'admin' })

  router.add('PUT', '/whatsapp/settings', async (ctx) => {
    const b = body(ctx)
    const d = db(s)
    if (b.keywords !== undefined) {
      if (!isObj(b.keywords)) throw new HttpError(422, 'invalid', 'keywords is { stop: [...], start: [...] }.', 'keywords')
      const stop = cleanKeywords(b.keywords.stop, DEFAULT_STOP_KEYWORDS)
      const start = cleanKeywords(b.keywords.start, DEFAULT_START_KEYWORDS)
      if (!stop.length) throw new HttpError(422, 'invalid', 'Keep at least one stop keyword: people must be able to opt out by writing to you.', 'keywords.stop')
      const both = stop.filter((k) => start.includes(k))
      if (both.length) throw new HttpError(422, 'invalid', `A keyword cannot both stop and start: ${both.join(', ')}.`, 'keywords')
      await putSetting(d, 'keywords', { stop, start })
    }
    if (b.notifications !== undefined) {
      if (b.notifications === null) await putSetting(d, 'notifications', null)
      else {
        const m = parseMapping(b.notifications)
        if (!m) throw new HttpError(422, 'invalid', 'notifications is { connectionId, template, language, params, enabled }.', 'notifications')
        if (!new RegExp(TEMPLATE_NAME).test(m.template)) throw new HttpError(422, 'invalid', 'The template name has lowercase letters, digits and _ only.', 'notifications.template')
        if (!new RegExp(LANGUAGE_CODE).test(m.language)) throw new HttpError(422, 'invalid', 'The language code looks like en, en_US or hi.', 'notifications.language')
        if (!m.params.length) throw new HttpError(422, 'invalid', 'Choose what fills the template\'s values: title, body and/or link.', 'notifications.params')
        const conn = await s.meta.connections.get(m.connectionId)
        if (!conn || conn.connector !== 'whatsapp') throw new HttpError(422, 'invalid', 'Choose a WhatsApp connection of this environment.', 'notifications.connectionId')
        // the template must be approved in that language, with as many body values as chosen (read from Meta now)
        let list: Awaited<ReturnType<typeof listTemplates>>
        try {
          list = await listTemplates({ connection: conn, cache: actions.cacheOf(currentEnvironment().id, conn.id), timeoutMs: 15_000 })
        } catch (e) {
          throw new HttpError(422, 'invalid', `The templates could not be read from Meta: ${(e as Error).message}`, 'notifications.template')
        }
        const t = list.find((x) => x.name === m.template && x.language === m.language)
        if (!t) throw new HttpError(422, 'invalid', `There is no template "${m.template}" in language ${m.language} in this WhatsApp Business account.`, 'notifications.template')
        if (t.status !== 'APPROVED') throw new HttpError(422, 'invalid', `The template "${m.template}" is ${t.status.toLowerCase() || 'not approved'}: only approved templates can be used.`, 'notifications.template')
        if (t.bodyParams !== m.params.length) throw new HttpError(422, 'invalid', `The template "${m.template}" has ${t.bodyParams} body value(s); you chose ${m.params.length} (${m.params.join(', ')}).`, 'notifications.params')
        await putSetting(d, 'notifications', m)
      }
    }
    await audit(s, ctx, 'whatsapp.settings', { keywords: b.keywords !== undefined, notifications: b.notifications === undefined ? undefined : b.notifications === null ? 'removed' : 'set' })
    return { keywords: await keywords(d), notifications: await notificationMapping(d) }
  }, { auth: 'admin' })

  /* ---------------------------------------------------------------- the person themself */

  const me = async (ctx: Ctx) => {
    const u = await s.meta.users.get(ctx.user!.user.id)
    const d = db(s)
    const offer = await offerFor(s, d, { id: ctx.user!.user.id, phone: u?.phone })
    return {
      offered: offer.offered, reason: offer.reason, phone: offer.phone ? maskPhone(offer.phone) : null, optedIn: offer.optedIn,
      canOptIn: !!offer.phone && !offer.optedIn && !!offer.mapping?.enabled,
      kinds: await prefsOf(d, ctx.user!.user.id), available: NOTIFICATION_KINDS.filter((k) => k.kind !== 'health').map((k) => ({ kind: k.kind, label: k.label })),
    }
  }

  router.add('GET', '/whatsapp/me', me, { auth: 'user' })

  router.add('PUT', '/whatsapp/me', async (ctx) => {
    const b = body(ctx)
    if (!isObj(b.kinds)) throw new HttpError(422, 'invalid', 'kinds is { <kind>: true | false }.', 'kinds')
    const cur = await me(ctx)
    const kinds: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(b.kinds)) if (/^[a-z][a-z0-9_-]{0,31}$/.test(k) && typeof v === 'boolean') kinds[k] = v
    if (Object.values(kinds).some(Boolean) && !cur.offered) throw new HttpError(409, 'conflict', `WhatsApp notifications are not available for you: ${cur.reason}`)
    await savePrefs(db(s), ctx.user!.user.id, kinds)
    return me(ctx)
  }, { auth: 'user' })

  router.add('POST', '/whatsapp/me/opt-in', async (ctx) => {
    const b = body(ctx)
    if (b.consent !== true) throw new HttpError(422, 'invalid', 'Confirm that you agree to get notifications on WhatsApp.', 'consent')
    const u = await s.meta.users.get(ctx.user!.user.id)
    const d = db(s)
    const offer = await offerFor(s, d, { id: ctx.user!.user.id, phone: u?.phone })
    if (!offer.phone) throw new HttpError(409, 'conflict', offer.reason)
    if (!offer.mapping?.enabled) throw new HttpError(409, 'conflict', offer.reason)
    await recordOptIn(d, {
      phone: offer.phone, status: 'opted_in', source: 'form', by: ctx.user!.user.id, contactTable: 'users', contactRow: ctx.user!.user.id,
      evidence: `${ctx.user!.user.name} (${ctx.user!.user.email}) opted in their own number in Settings > Notifications, agreeing to: "Send my Appbuilder notifications to this number on WhatsApp. I can stop them at any time by writing STOP."`,
    })
    await audit(s, ctx, 'whatsapp.optin', { phone: maskPhone(offer.phone), status: 'opted_in', source: 'form', self: true })
    return me(ctx)
  }, { auth: 'user' })

  router.add('POST', '/whatsapp/me/opt-out', async (ctx) => {
    const u = await s.meta.users.get(ctx.user!.user.id)
    const d = db(s)
    // opting out always works when the profile has a number (also without a notification mapping)
    let phone: string
    try {
      phone = normalizePhone(u?.phone ?? '', await defaultCountry(s))
    } catch {
      throw new HttpError(409, 'conflict', 'Your profile has no usable phone number.')
    }
    const offer = { phone }
    await recordOptIn(d, { phone: offer.phone, status: 'opted_out', source: 'form', by: ctx.user!.user.id, contactTable: 'users', contactRow: ctx.user!.user.id, evidence: `${ctx.user!.user.name} opted out their own number in Settings > Notifications.` })
    await savePrefs(d, ctx.user!.user.id, {})
    await audit(s, ctx, 'whatsapp.optin', { phone: maskPhone(offer.phone), status: 'opted_out', source: 'form', self: true })
    return me(ctx)
  }, { auth: 'user' })
}
