/**
 * Chat HTTP API (P3-A; the full contract with bodies and answers is docs/dev/chat.md). Every route: a signed-in person
 * (not an API key), any requested environment (chat lives in the chat environment, resolved here), JSON bodies.
 * Chat routes are data routes, not design routes: a locked production environment does not block them.
 *
 *   GET    /chat/me                                     who I am in chat, limits, emoji
 *   GET    /chat/conversations[?browse=1]               my conversations with unread counts (browse: open channels to join)
 *   POST   /chat/conversations                          { kind, name?, description?, isPrivate?, members?, postingPolicy? }
 *   GET    /chat/conversations/:id                      PATCH { name?, description?, postingPolicy? }
 *   POST   /chat/conversations/:id/join | /leave        POST /chat/conversations/:id/archive { archived }
 *   PATCH  /chat/conversations/:id/me                   { notifyLevel?, muted? }
 *   GET    /chat/conversations/:id/members              POST { userIds, role? }   PATCH|DELETE /members/:userId
 *   GET    /chat/conversations/:id/messages?before=&after=&limit=     POST { body, parent?, files?, cards?, clientId? }
 *   GET    /chat/conversations/:id/changes?after=       POST /read { seq }   POST /typing
 *   POST   /chat/conversations/:id/files?name=          raw body (the file) -> a draft file to name in a message
 *   GET    /chat/conversations/:id/mentionable?q=       DELETE /chat/files/:id (a draft)
 *   GET    /chat/messages/:id/replies   PATCH /chat/messages/:id { body }   DELETE /chat/messages/:id
 *   POST   /chat/messages/:id/reactions { emoji, on }   POST /chat/messages/:id/report { reason }
 *   POST   /chat/cards/resolve { messageId, index }     GET /chat/search?q=&channel=&from=&before=&page=   GET /chat/people?q=
 *   /chat/admin/*: settings, read-only people, conversations (metadata), members, archive, delete, moderation, reports,
 *   export, retention (administrators of the chat environment; moving chat: install administrators)
 */
import type { Ctx } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import type { ApiRouter } from '../router.ts'
import type { CoreServices } from '../services.ts'
import type { LiveHub } from '../live/hub.ts'
import { DEFAULT_ENVIRONMENT_ID, runInEnvironment } from '../env-context.ts'
import { INSTALL_SCHEDULES } from '../kernel.ts'
import { requireRecentAuth } from '../identity/index.ts'
import { setDigestRelevance } from '../notifications-delivery.ts'
import { CHAT_EMOJI, CHAT_LIMITS } from '../../../src/platform/chat-protocol.ts'
import { createChatService } from './service.ts'
import type { ChatCx, ChatService } from './service.ts'
import { createChatAdmin } from './admin.ts'
import type { ChatAdmin } from './admin.ts'
import { resolveCard } from './cards.ts'

export const CHAT_RETENTION_JOB = 'chat.retention'

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i

function body(ctx: Ctx): Record<string, unknown> {
  const b = ctx.body
  if (b === undefined || b === null) return {}
  if (typeof b !== 'object' || Array.isArray(b)) throw new HttpError(422, 'invalid', 'Request body must be a JSON object.')
  return b as Record<string, unknown>
}
const qnum = (ctx: Ctx, k: string): number | null => {
  const v = ctx.query.get(k)
  if (v === null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new HttpError(422, 'invalid', `${k} must be a number.`, k)
  return Math.trunc(n)
}

export interface ChatModule { chat: ChatService; admin: ChatAdmin }

/**
 * Registers chat: the routes, the live hub's access check for chat topics, the digest relevance check and the
 * nightly retention job (install schedule `sched_chat_retention`, 02:17; install administrators can change it).
 */
export function chatRoutes(router: ApiRouter, s: CoreServices, live: LiveHub | null, o: { env?: NodeJS.ProcessEnv } = {}): ChatModule {
  const chat = createChatService(s, live, { env: o.env })
  const admin = createChatAdmin(s, chat)
  live?.setChatAccess({ canRead: (userId, channelId) => chat.canRead(userId, channelId) })
  setDigestRelevance('chat', (userId, item) => chat.digestRelevance(userId, item))

  const opts = { auth: 'user' as const, noEnvironment: true }
  /** runs a handler as the person, inside the chat environment */
  const run = <T>(fn: (cx: ChatCx, ctx: Ctx) => Promise<T>) => async (ctx: Ctx): Promise<T> => {
    const cx = await chat.resolve(ctx)
    return runInEnvironment(cx.env.id, () => fn(cx, ctx))
  }
  const add = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, fn: (cx: ChatCx, ctx: Ctx) => Promise<unknown>) => router.add(method, path, run(fn), opts)

  add('GET', '/chat/me', async (cx) => ({
    id: cx.id, name: cx.name, environmentId: cx.env.id, isAdmin: cx.isAdmin, readOnly: cx.readOnly || chat.installReadOnly(),
    readOnlyReason: chat.installReadOnly() ? 'install' : cx.readOnly ? 'chat' : null,
    canCreateChannels: cx.settings.createChannels === 'everyone' || cx.isMaker || cx.isAdmin, limits: CHAT_LIMITS, emoji: CHAT_EMOJI,
  }))

  /* conversations */
  add('GET', '/chat/conversations', async (cx, ctx) => ({ items: await chat.listConversations(cx, { browse: ctx.query.get('browse') === '1' }) }))
  add('POST', '/chat/conversations', async (cx, ctx) => chat.createConversation(cx, body(ctx)))
  add('GET', '/chat/conversations/:id', async (cx, ctx) => chat.getConversation(cx, ctx.params.id))
  add('PATCH', '/chat/conversations/:id', async (cx, ctx) => chat.updateConversation(cx, ctx.params.id, body(ctx)))
  add('POST', '/chat/conversations/:id/join', async (cx, ctx) => chat.join(cx, ctx.params.id))
  add('POST', '/chat/conversations/:id/leave', async (cx, ctx) => chat.leave(cx, ctx.params.id))
  add('POST', '/chat/conversations/:id/archive', async (cx, ctx) => {
    await chat.setArchived(cx, ctx.params.id, body(ctx).archived !== false)
    return chat.getConversation(cx, ctx.params.id)
  })
  add('PATCH', '/chat/conversations/:id/me', async (cx, ctx) => chat.setMine(cx, ctx.params.id, body(ctx)))
  add('GET', '/chat/conversations/:id/members', async (cx, ctx) => ({ items: await chat.listMembers(cx, ctx.params.id) }))
  add('POST', '/chat/conversations/:id/members', async (cx, ctx) => ({ items: await chat.addMembers(cx, ctx.params.id, body(ctx)) }))
  add('PATCH', '/chat/conversations/:id/members/:userId', async (cx, ctx) => ({ items: await chat.setRole(cx, ctx.params.id, ctx.params.userId, body(ctx).role) }))
  add('DELETE', '/chat/conversations/:id/members/:userId', async (cx, ctx) => chat.removeMember(cx, cx.env, ctx.params.id, ctx.params.userId))

  /* messages */
  add('GET', '/chat/conversations/:id/messages', async (cx, ctx) => chat.history(cx, ctx.params.id, { before: qnum(ctx, 'before'), after: qnum(ctx, 'after'), limit: qnum(ctx, 'limit') ?? undefined }))
  add('POST', '/chat/conversations/:id/messages', async (cx, ctx) => chat.send(cx, ctx.params.id, body(ctx)))
  add('GET', '/chat/conversations/:id/changes', async (cx, ctx) => chat.changes(cx, ctx.params.id, qnum(ctx, 'after') ?? 0))
  add('POST', '/chat/conversations/:id/read', async (cx, ctx) => chat.markRead(cx, ctx.params.id, body(ctx).seq))
  add('POST', '/chat/conversations/:id/typing', async (cx, ctx) => chat.typingNow(cx, ctx.params.id))
  add('GET', '/chat/conversations/:id/mentionable', async (cx, ctx) => ({ users: await chat.mentionable(cx, ctx.params.id, (ctx.query.get('q') ?? '').slice(0, 100)) }))
  add('GET', '/chat/messages/:id/replies', async (cx, ctx) => chat.replies(cx, ctx.params.id, { after: qnum(ctx, 'after'), limit: qnum(ctx, 'limit') ?? undefined }))
  add('PATCH', '/chat/messages/:id', async (cx, ctx) => ({ message: await chat.edit(cx, ctx.params.id, body(ctx)) }))
  add('DELETE', '/chat/messages/:id', async (cx, ctx) => {
    await chat.removeMessage(cx, cx.env, ctx.params.id)
    return { deleted: true }
  })
  add('POST', '/chat/messages/:id/reactions', async (cx, ctx) => ({ message: await chat.react(cx, ctx.params.id, body(ctx)) }))
  add('POST', '/chat/messages/:id/report', async (cx, ctx) => chat.report(cx, ctx.params.id, body(ctx)))
  add('POST', '/chat/cards/resolve', async (cx, ctx) => resolveCard(s, chat, cx, body(ctx)))
  add('GET', '/chat/search', async (cx, ctx) => chat.search(cx, { q: ctx.query.get('q'), channel: ctx.query.get('channel'), from: ctx.query.get('from'), before: ctx.query.get('before'), page: qnum(ctx, 'page') ?? 0 }))
  add('GET', '/chat/people', async (cx, ctx) => ({ users: await chat.peopleSearch(cx, (ctx.query.get('q') ?? '').slice(0, 100)) }))
  add('DELETE', '/chat/files/:id', async (cx, ctx) => chat.discardDraft(cx, ctx.params.id))

  /* files: the upload is refused before it is read when it says it is larger than the limit */
  router.add('POST', '/chat/conversations/:id/files', run(async (cx, ctx) => {
    const declared = Number(ctx.req.headers['content-length'] ?? 0)
    if (declared > CHAT_LIMITS.maxFileBytes) throw new HttpError(413, 'invalid', `The file is larger than ${CHAT_LIMITS.maxFileBytes / 1024 / 1024} MB.`, 'file')
    const type = String(ctx.req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    const mime = MIME_RE.test(type) ? type : 'application/octet-stream'
    // permission before the body is read
    await chat.getConversation(cx, ctx.params.id)
    const bytes = ctx.readBody ? await ctx.readBody(CHAT_LIMITS.maxFileBytes).catch((e: unknown) => {
      if (e instanceof HttpError && e.status === 413) e.message = `The file is larger than ${CHAT_LIMITS.maxFileBytes / 1024 / 1024} MB.`
      throw e
    }) : (ctx.rawBody ?? Buffer.alloc(0))
    return chat.upload(cx, ctx.params.id, { name: ctx.query.get('name'), mime, bytes })
  }), { ...opts, raw: true, streamBody: true, maxBodyMB: CHAT_LIMITS.maxFileBytes / 1024 / 1024 })

  /* administrators */
  add('GET', '/chat/admin/settings', async (cx) => admin.settingsView(cx))
  add('PUT', '/chat/admin/settings', async (cx, ctx) => admin.saveSettings(cx, body(ctx)))
  add('POST', '/chat/admin/readonly', async (cx, ctx) => admin.setReadOnly(cx, body(ctx)))
  add('GET', '/chat/admin/channels', async (cx, ctx) => admin.channels(cx, { q: ctx.query.get('q'), kind: ctx.query.get('kind'), offset: qnum(ctx, 'offset') ?? 0 }))
  add('GET', '/chat/admin/channels/:id/members', async (cx, ctx) => ({ items: await admin.channelMembers(cx, ctx.params.id) }))
  add('POST', '/chat/admin/channels/:id/archive', async (cx, ctx) => admin.archive(cx, ctx.params.id, body(ctx).archived !== false))
  add('DELETE', '/chat/admin/channels/:id/members/:userId', async (cx, ctx) => admin.removeMember(cx, ctx.params.id, ctx.params.userId))
  add('DELETE', '/chat/admin/channels/:id', async (cx, ctx) => admin.deleteChannel(cx, ctx.params.id, body(ctx)))
  add('POST', '/chat/admin/messages/:id/moderate', async (cx, ctx) => admin.moderate(cx, ctx.params.id, body(ctx)))
  add('GET', '/chat/admin/reports', async (cx, ctx) => admin.reports(cx, ctx.query.get('state')))
  add('POST', '/chat/admin/reports/:id', async (cx, ctx) => admin.handleReport(cx, ctx.params.id, body(ctx)))
  add('POST', '/chat/admin/channels/:id/export', async (cx, ctx) => {
    if (!cx.isAdmin) throw new HttpError(403, 'denied', 'Only administrators of the chat environment can do this.')
    requireRecentAuth(ctx)
    return admin.createExport(cx, ctx.params.id, body(ctx))
  })
  add('GET', '/chat/admin/exports', async (cx) => admin.listExports(cx))
  add('GET', '/chat/admin/exports/:id/download', async (cx, ctx) => admin.download(cx, ctx.params.id, ctx.query.get('token')))
  add('POST', '/chat/admin/retention/run', async (cx) => {
    if (!cx.isAdmin) throw new HttpError(403, 'denied', 'Only administrators of the chat environment can do this.')
    const r = await admin.runRetention()
    await s.meta.audit({ userId: cx.id, action: 'chat.retention.run', details: r }).catch(() => undefined)
    return r
  })

  /* the nightly retention job (install-wide; runs in Default, works on the chat environment) */
  s.kernel.jobs.register({
    type: CHAT_RETENTION_JOB,
    schedule: 'install',
    description: 'Removes chat messages older than the retention period an administrator set per conversation kind, with their files (the whole install; nothing is removed while no period is set).',
    concurrency: 1,
    maxAttempts: 2,
    timeoutMs: 30 * 60_000,
    async handler(_p, jctx) {
      if (jctx.environmentId !== DEFAULT_ENVIRONMENT_ID) return { skipped: 'install-wide: runs in Default' }
      return admin.runRetention()
    },
  })
  if (!INSTALL_SCHEDULES.some((x) => x.id === 'sched_chat_retention')) {
    INSTALL_SCHEDULES.push({ id: 'sched_chat_retention', name: 'Chat retention', description: 'Every night: removes chat messages older than the retention periods set in Admin console > Chat (none by default).', cron: '17 2 * * *', jobType: CHAT_RETENTION_JOB, payload: {}, enabled: true })
  }
  return { chat, admin }
}
