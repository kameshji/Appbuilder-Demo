/**
 * The chat service (P3 package A; docs/dev/chat.md). The only writer of the four communication system tables
 * (Channels, Channel members, Messages, Message reactions) and of ab_chat_reports / ab_chat_exports; the generic data API
 * refuses writes to them for everyone (policy `chat`, src/platform/system-tables.ts).
 *
 * Rules every function here keeps:
 *  - chat lives in ONE environment (settings.ts `environmentId`); a chat user is an active person with access to it
 *    (install administrators have access everywhere); API keys and service accounts are refused;
 *  - who may read a conversation is decided by the same rule as the row predicate (chatRead): a member, or an open
 *    channel (kind channel, not private, not archived). A conversation the reader may not read answers exactly like one
 *    that does not exist (404 "Conversation not found.");
 *  - every change of a conversation takes the next value of its change counter (Channels.LastSeq) inside its
 *    transaction, under the channel's row lock (writers of one channel are serialised), and is pushed after the commit
 *    with prev = seq - 1 (counters are contiguous per channel; the client detects every gap);
 *  - mentions are taken from the sanitised body only; a mention of someone who cannot read the conversation is refused;
 *  - message text is never logged, never audited and never put in a card, an export of the environment, a search result
 *    for someone else or a notification of someone who cannot read it.
 */
import type { IncomingMessage } from 'node:http'
import { HttpError } from '../contracts.ts'
import type { AttachmentRecord, Ctx, SqlDb, UserContext } from '../contracts.ts'
import type { CoreServices } from '../services.ts'
import type { LiveHub } from '../live/hub.ts'
import { emitTableChange } from '../live/changes.ts'
import { userContextFor } from '../auth.ts'
import { environmentSchema, runInEnvironment } from '../env-context.ts'
import { errText, isUuid, log, rowUid, uid } from '../util.ts'
import { SYS } from '../../../src/platform/system-tables.ts'
import { LIVE_CLIENT_HEADER } from '../../../src/platform/live-protocol.ts'
import { CHAT_CHANGES_PAGE, CHAT_LIMITS, chatLink } from '../../../src/platform/chat-protocol.ts'
import type {
  ChatCardRef, ChatChanges, ChatConversation, ChatFile, ChatKind, ChatMemberRole, ChatMemberView, ChatMessageView, ChatNotifyLevel, ChatPushMessage,
} from '../../../src/platform/chat-protocol.ts'
import { checkEmoji, mentionIdsJson, messageIdFor, parseBody, parseCards, parseJsonList, preview, searchQuery } from './format.ts'
import type { ParsedBody } from './format.ts'
import { loadChatSettings } from './settings.ts'
import type { ChatSettings } from './settings.ts'

/* ------------------------------------------------------------------ types */

export interface ChatEnv { id: string; schema: string }

/** one person's chat context (in the chat environment) */
export interface ChatCx {
  env: ChatEnv
  user: UserContext
  id: string
  name: string
  /** administrator of the chat environment (environment or install administrator) */
  isAdmin: boolean
  isInstallAdmin: boolean
  isMaker: boolean
  /** an administrator made this person read-only in chat */
  readOnly: boolean
  settings: ChatSettings
  /** the live connection of the request (X-Appbuilder-Live), for `self` on pushes */
  origin?: string
}

type Row = Record<string, unknown>

/** a conversation row plus the reader's membership */
interface Conv {
  ch: Row
  mem: { id: string; role: ChatMemberRole; lastReadSeq: number; notifyLevel: ChatNotifyLevel; muted: boolean; joinedOn: string | null } | null
  readable: boolean
}

const q = (id: string): string => `"${id.replace(/"/g, '""')}"`
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const num = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v))
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null)
const notFound = () => new HttpError(404, 'not-found', 'Conversation not found.')
const messageNotFound = () => new HttpError(404, 'not-found', 'Message not found.')
const invalid = (message: string, field?: string) => new HttpError(422, 'invalid', message, field)
const denied = (message: string) => new HttpError(403, 'denied', message)

export const READ_ONLY_MESSAGE = 'An administrator made you read-only in chat: you can read conversations but not post.'
export const INSTALL_READ_ONLY_MESSAGE = 'This install is read-only: chat can be read and searched, but nothing can be sent or changed.'
/** attachments uploaded for a message not sent yet: row id of the draft (per conversation) */
export const draftRowId = (channelId: string): string => `draft-${channelId}`
/** DirectKey prefix of each person's conversation with the system sender "Approvals" (package E) */
export const SYSTEM_KEY_APPROVALS = 'system:approvals:'

/** in-memory sliding window per key */
class Window {
  private hits = new Map<string, number[]>()
  allow(key: string, max: number, windowMs: number, now = Date.now()): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs)
    if (list.length >= max) {
      this.hits.set(key, list)
      return false
    }
    list.push(now)
    this.hits.set(key, list)
    if (this.hits.size > 20_000) for (const k of [...this.hits.keys()].slice(0, 10_000)) this.hits.delete(k)
    return true
  }
}

export interface ChatServiceOptions {
  /** process environment (APPBUILDER_READ_ONLY=1: the install is read-only, hosting-spec.md) */
  env?: NodeJS.ProcessEnv
}

export type ChatService = ReturnType<typeof createChatService>

export function createChatService(s: CoreServices, live: LiveHub | null, opts: ChatServiceOptions = {}) {
  const procEnv = opts.env ?? process.env
  const sends = new Window()
  const typing = new Map<string, number>()

  const db = (): SqlDb => {
    const d = s.state.db
    if (!d || !s.ready()) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }
  const installReadOnly = (): boolean => procEnv.APPBUILDER_READ_ONLY === '1'

  async function chatEnv(): Promise<{ env: ChatEnv; settings: ChatSettings }> {
    const settings = await loadChatSettings(db())
    return { env: { id: settings.environmentId, schema: environmentSchema(settings.environmentId) }, settings }
  }
  const T = (env: ChatEnv, t: string): string => `${q(env.schema)}.${q(t)}`

  /* -------------------------------------------------------------- people */

  let nameCache: { at: number; map: Map<string, { name: string; status: string; kind?: string; installAdmin: boolean }> } | null = null
  async function people(): Promise<Map<string, { name: string; status: string; kind?: string; installAdmin: boolean }>> {
    if (nameCache && Date.now() - nameCache.at < 10_000) return nameCache.map
    const map = new Map<string, { name: string; status: string; kind?: string; installAdmin: boolean }>()
    for (const u of await s.meta.users.list()) map.set(u.id, { name: u.name, status: u.status ?? 'active', kind: (u as { kind?: string }).kind, installAdmin: !!u.isInstallAdmin })
    nameCache = { at: Date.now(), map }
    return map
  }
  const forgetPeople = () => { nameCache = null }
  async function nameOf(id: string): Promise<string> {
    return (await people()).get(id)?.name ?? 'Someone'
  }

  /** the people who may use chat: active, not service accounts, with access to the chat environment (install admins always) */
  async function chatUsers(env: ChatEnv, needed: string[] = []): Promise<Set<string>> {
    let all = await people()
    // someone created after the cache was filled
    if (needed.some((id) => !all.has(id))) {
      forgetPeople()
      all = await people()
    }
    const access = new Set((await s.install.access.forEnvironment(env.id)).map((r) => r.userId))
    const out = new Set<string>()
    for (const [id, u] of all) if (u.status !== 'disabled' && u.kind !== 'service' && (u.installAdmin || access.has(id))) out.add(id)
    return out
  }

  /* -------------------------------------------------------------- contexts */

  /** a person's chat context, or null when they may not use chat (no access, disabled, a service account) */
  async function cxForUser(userId: string): Promise<ChatCx | null> {
    const { env, settings } = await chatEnv()
    const rec = await s.meta.users.get(userId)
    if (!rec || rec.status === 'disabled' || (rec as { kind?: string }).kind === 'service') return null
    let user: UserContext
    try {
      user = await userContextFor(s, rec, env.id)
    } catch {
      return null
    }
    if (user.environmentId !== env.id) return null
    return {
      env, user, id: rec.id, name: rec.name, isAdmin: user.privileges.isAdmin, isInstallAdmin: !!user.privileges.isInstallAdmin, isMaker: user.privileges.isMaker,
      readOnly: settings.readOnly.includes(rec.id), settings,
    }
  }

  /** the request's chat context (403 for API keys, service accounts and people without access to the chat environment) */
  async function resolve(ctx: Ctx): Promise<ChatCx> {
    if (/^Bearer\s/i.test(String(ctx.req.headers.authorization ?? ''))) throw denied('Chat is for people: API keys cannot use it.')
    const me = ctx.user?.user
    if (!me) throw new HttpError(401, 'unauthenticated', 'Please sign in.')
    const cx = await cxForUser(me.id)
    if (!cx) throw denied('You do not have access to chat. Chat lives in one environment of this install; an administrator gives access to it.')
    cx.origin = liveOrigin(ctx.req)
    return cx
  }

  function liveOrigin(req: IncomingMessage): string | undefined {
    const h = req.headers[LIVE_CLIENT_HEADER.toLowerCase()]
    const v = (Array.isArray(h) ? h[0] : h) || undefined
    return v && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : undefined
  }

  function writable(cx: ChatCx): void {
    if (installReadOnly()) throw new HttpError(403, 'denied', INSTALL_READ_ONLY_MESSAGE)
    if (cx.readOnly) throw denied(READ_ONLY_MESSAGE)
  }

  /* -------------------------------------------------------------- conversations: reading */

  const MEMBER_COLS = `m.id AS "_mid", m."MemberRole" AS "_role", m."LastReadSeq" AS "_lastRead", m."NotifyLevel" AS "_notify", m."Muted" AS "_muted", m."JoinedOn" AS "_joined"`

  function toConv(r: Row): Conv {
    const mem = r._mid ? {
      id: str(r._mid), role: (r._role === 'owner' ? 'owner' : 'member') as ChatMemberRole, lastReadSeq: num(r._lastRead),
      notifyLevel: (['all', 'mentions', 'none'].includes(str(r._notify)) ? str(r._notify) : 'mentions') as ChatNotifyLevel, muted: r._muted === true, joinedOn: iso(r._joined),
    } : null
    const open = r.Kind === 'channel' && r.IsPrivate === false && !r.ArchivedOn
    return { ch: r, mem, readable: !!mem || open }
  }

  /** the conversation and the reader's membership; lock: FOR UPDATE of the channel row (writers) */
  async function conv(dbx: SqlDb, cx: ChatCx, channelId: string, o: { lock?: boolean } = {}): Promise<Conv> {
    if (!isUuid(channelId)) throw notFound()
    const rows = await dbx.query<Row>(
      `SELECT c.*, ${MEMBER_COLS} FROM ${T(cx.env, SYS.channels)} c LEFT JOIN ${T(cx.env, SYS.channelMembers)} m ON m."Channel" = c.id AND m."User" = $2 WHERE c.id = $1${o.lock ? ' FOR UPDATE OF c' : ''}`,
      [channelId.toLowerCase(), cx.id],
    )
    const r = rows[0]
    if (!r) throw notFound()
    const c = toConv(r)
    if (!c.readable) throw notFound()
    return c
  }

  async function membersOf(dbx: SqlDb, env: ChatEnv, channelId: string): Promise<{ user: string; role: ChatMemberRole; notifyLevel: ChatNotifyLevel; muted: boolean; joinedOn: string | null }[]> {
    const rows = await dbx.query<Row>(`SELECT "User", "MemberRole", "NotifyLevel", "Muted", "JoinedOn" FROM ${T(env, SYS.channelMembers)} WHERE "Channel" = $1 ORDER BY "JoinedOn", id`, [channelId])
    return rows.map((r) => ({ user: str(r.User), role: r.MemberRole === 'owner' ? 'owner' : 'member', notifyLevel: (['all', 'mentions', 'none'].includes(str(r.NotifyLevel)) ? str(r.NotifyLevel) : 'mentions') as ChatNotifyLevel, muted: r.Muted === true, joinedOn: iso(r.JoinedOn) }))
  }

  /** a conversation from Appbuilder itself (the "Approvals" sender): nobody posts in it */
  const systemKindOf = (ch: Row): 'approvals' | null => (str(ch.DirectKey).startsWith(SYSTEM_KEY_APPROVALS) ? 'approvals' : null)

  function canPost(cx: ChatCx, c: Conv): boolean {
    if (!c.mem || c.ch.ArchivedOn || cx.readOnly || installReadOnly()) return false
    if (systemKindOf(c.ch)) return false
    return c.ch.PostingPolicy !== 'owners' || c.mem.role === 'owner'
  }

  async function view(dbx: SqlDb, cx: ChatCx, c: Conv, extra: { unread?: number; mentions?: number; memberCount?: number; members?: { id: string; name: string }[] } = {}): Promise<ChatConversation> {
    const kind = (['channel', 'direct', 'group'].includes(str(c.ch.Kind)) ? str(c.ch.Kind) : 'channel') as ChatKind
    let members = extra.members
    let memberCount = extra.memberCount
    if (kind !== 'channel' && !members) {
      const list = await membersOf(dbx, cx.env, str(c.ch.id))
      const map = await people()
      members = list.map((m) => ({ id: m.user, name: map.get(m.user)?.name ?? 'Someone' }))
      memberCount = list.length
    }
    if (memberCount === undefined) memberCount = Number((await dbx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${T(cx.env, SYS.channelMembers)} WHERE "Channel" = $1`, [c.ch.id]))[0]?.n ?? 0)
    const others = (members ?? []).filter((m) => m.id !== cx.id).map((m) => m.name)
    const sys = systemKindOf(c.ch)
    const name = sys ? 'Approvals' : kind === 'channel' ? str(c.ch.Name) : kind === 'group' && str(c.ch.Name) && str(c.ch.Name) !== 'group' ? str(c.ch.Name) : others.join(', ') || cx.name
    return {
      id: str(c.ch.id), kind, name, description: str(c.ch.Description), isPrivate: c.ch.IsPrivate !== false, archived: !!c.ch.ArchivedOn,
      postingPolicy: c.ch.PostingPolicy === 'owners' ? 'owners' : 'everyone', lastSeq: num(c.ch.LastSeq), purgedSeq: num(c.ch.PurgedSeq), lastMessageOn: iso(c.ch.LastMessageOn),
      memberCount, ...(kind !== 'channel' ? { members } : {}),
      me: c.mem ? { role: c.mem.role, lastReadSeq: c.mem.lastReadSeq, notifyLevel: c.mem.notifyLevel, muted: c.mem.muted, joinedOn: c.mem.joinedOn } : null,
      unread: extra.unread ?? 0, mentions: extra.mentions ?? 0, canPost: canPost(cx, c),
      ...(sys ? { system: sys } : {}),
    }
  }

  /** unread messages and mentions of the reader in one conversation */
  async function unreadOf(dbx: SqlDb, cx: ChatCx, channelId: string, lastRead: number): Promise<{ unread: number; mentions: number }> {
    const r = await dbx.query<{ u: number; m: number }>(
      `SELECT count(*)::int AS u, count(*) FILTER (WHERE "MentionIds" LIKE $3 OR "MentionIds" LIKE '%"channel"%')::int AS m
         FROM ${T(cx.env, SYS.messages)} WHERE "Channel" = $1 AND "Seq" > $2 AND "Kind" = 'message' AND "DeletedOn" IS NULL AND "createdBy" IS DISTINCT FROM $4`,
      [channelId, lastRead, `%"${cx.id}"%`, cx.id],
    )
    return { unread: Number(r[0]?.u ?? 0), mentions: Number(r[0]?.m ?? 0) }
  }

  async function listConversations(cx: ChatCx, o: { browse?: boolean } = {}): Promise<ChatConversation[]> {
    const d = db()
    if (o.browse) {
      // open channels the reader has not joined (by name)
      const rows = await d.query<Row>(
        `SELECT c.*, (SELECT count(*)::int FROM ${T(cx.env, SYS.channelMembers)} x WHERE x."Channel" = c.id) AS "_members"
           FROM ${T(cx.env, SYS.channels)} c
          WHERE c."Kind" = 'channel' AND c."IsPrivate" = false AND c."ArchivedOn" IS NULL
            AND NOT EXISTS (SELECT 1 FROM ${T(cx.env, SYS.channelMembers)} m WHERE m."Channel" = c.id AND m."User" = $1)
          ORDER BY lower(c."Name"), c.id LIMIT 500`, [cx.id])
      return Promise.all(rows.map((r) => view(d, cx, toConv(r), { memberCount: num(r._members) })))
    }
    const rows = await d.query<Row>(
      `SELECT c.*, ${MEMBER_COLS},
              (SELECT count(*)::int FROM ${T(cx.env, SYS.channelMembers)} x WHERE x."Channel" = c.id) AS "_members",
              (SELECT count(*)::int FROM ${T(cx.env, SYS.messages)} y WHERE y."Channel" = c.id AND y."Seq" > COALESCE(m."LastReadSeq", 0) AND y."Kind" = 'message' AND y."DeletedOn" IS NULL AND y."createdBy" IS DISTINCT FROM $1) AS "_unread",
              (SELECT count(*)::int FROM ${T(cx.env, SYS.messages)} y WHERE y."Channel" = c.id AND y."Seq" > COALESCE(m."LastReadSeq", 0) AND y."Kind" = 'message' AND y."DeletedOn" IS NULL AND y."createdBy" IS DISTINCT FROM $1
                 AND (y."MentionIds" LIKE $2 OR y."MentionIds" LIKE '%"channel"%')) AS "_mentions"
         FROM ${T(cx.env, SYS.channelMembers)} m JOIN ${T(cx.env, SYS.channels)} c ON c.id = m."Channel"
        WHERE m."User" = $1
        ORDER BY c."LastMessageOn" DESC NULLS LAST, c."createdOn" DESC LIMIT 2000`, [cx.id, `%"${cx.id}"%`])
    // direct and group conversations: their people, in one query
    const small = rows.filter((r) => r.Kind !== 'channel').map((r) => str(r.id))
    const byChannel = new Map<string, { id: string; name: string }[]>()
    if (small.length) {
      const map = await people()
      for (const m of await d.query<Row>(`SELECT "Channel", "User" FROM ${T(cx.env, SYS.channelMembers)} WHERE "Channel" = ANY($1::text[]) ORDER BY "JoinedOn", id`, [small])) {
        const list = byChannel.get(str(m.Channel)) ?? []
        list.push({ id: str(m.User), name: map.get(str(m.User))?.name ?? 'Someone' })
        byChannel.set(str(m.Channel), list)
      }
    }
    return Promise.all(rows.map((r) => view(d, cx, toConv(r), { unread: num(r._unread), mentions: num(r._mentions), memberCount: num(r._members), members: r.Kind !== 'channel' ? byChannel.get(str(r.id)) ?? [] : undefined })))
  }

  async function getConversation(cx: ChatCx, channelId: string): Promise<ChatConversation> {
    const d = db()
    const c = await conv(d, cx, channelId)
    return view(d, cx, c, c.mem ? await unreadOf(d, cx, str(c.ch.id), c.mem.lastReadSeq) : {})
  }

  async function listMembers(cx: ChatCx, channelId: string): Promise<ChatMemberView[]> {
    const d = db()
    const c = await conv(d, cx, channelId)
    const map = await people()
    return (await membersOf(d, cx.env, str(c.ch.id))).map((m) => ({ id: m.user, name: map.get(m.user)?.name ?? 'Someone', role: m.role, joinedOn: m.joinedOn }))
  }

  /* -------------------------------------------------------------- messages: views */

  async function messageViews(dbx: SqlDb, env: ChatEnv, rows: Row[]): Promise<ChatMessageView[]> {
    if (!rows.length) return []
    const ids = rows.map((r) => str(r.id))
    const reactions = new Map<string, { emoji: string; users: string[] }[]>()
    for (const r of await dbx.query<Row>(
      `SELECT "Message", "Emoji", array_agg("owner" ORDER BY "createdOn", id) AS users FROM ${T(env, SYS.messageReactions)} WHERE "Message" = ANY($1::text[]) GROUP BY "Message", "Emoji" ORDER BY min("createdOn")`, [ids],
    )) {
      const list = reactions.get(str(r.Message)) ?? []
      list.push({ emoji: str(r.Emoji), users: (r.users as string[]) ?? [] })
      reactions.set(str(r.Message), list)
    }
    const fileIds = [...new Set(rows.flatMap((r) => parseJsonList(r.Files).filter((x): x is string => typeof x === 'string')))]
    const files = new Map<string, ChatFile>()
    if (fileIds.length) {
      for (const a of await dbx.query<Row>(`SELECT id, file_name, mime, size_bytes FROM ${T(env, 'ab_attachments')} WHERE id = ANY($1::text[]) AND table_id = $2`, [fileIds, SYS.messages])) {
        files.set(str(a.id), { id: str(a.id), name: str(a.file_name), mime: str(a.mime), size: num(a.size_bytes), url: `/api/v1/attachments/${str(a.id)}?env=${env.id}` })
      }
    }
    const map = await people()
    return rows.map((r) => {
      const kind = r.Kind === 'system' ? 'system' : 'message'
      const deleted = !!r.DeletedOn
      const mentionIds = parseJsonList(r.MentionIds).filter((x): x is string => typeof x === 'string')
      let cards: ChatCardRef[] = []
      let event: ChatMessageView['event']
      const rawCards = (() => {
        try { return r.Cards ? JSON.parse(str(r.Cards)) : null } catch { return null }
      })()
      if (kind === 'system') event = rawCards && typeof rawCards === 'object' && !Array.isArray(rawCards) ? (rawCards as { event?: ChatMessageView['event'] }).event : undefined
      else if (Array.isArray(rawCards) && !deleted) cards = rawCards as ChatCardRef[]
      const sender = r.createdBy && kind === 'message' ? { id: str(r.createdBy), name: map.get(str(r.createdBy))?.name ?? 'Someone' } : null
      return {
        id: str(r.id), channelId: str(r.Channel), seq: num(r.Seq), changeSeq: num(r.ChangeSeq), kind, parentId: r.ParentMessage ? str(r.ParentMessage) : null,
        body: deleted ? '' : str(r.Body), text: deleted ? '' : str(r.BodyText), sender, createdOn: iso(r.createdOn) ?? '', editedOn: iso(r.EditedOn), deleted,
        moderated: deleted && !!r.DeletedBy && str(r.DeletedBy) !== str(r.createdBy),
        mentions: deleted ? [] : mentionIds.filter((x) => x !== 'channel'), mentionsChannel: !deleted && mentionIds.includes('channel'),
        files: deleted ? [] : parseJsonList(r.Files).map((id) => files.get(str(id))).filter((f): f is ChatFile => !!f),
        cards, reactions: deleted ? [] : reactions.get(str(r.id)) ?? [], replyCount: num(r.ReplyCount), lastReplyOn: iso(r.LastReplyOn),
        ...(event ? { event } : {}),
      }
    })
  }

  async function oneView(dbx: SqlDb, env: ChatEnv, id: string): Promise<ChatMessageView | undefined> {
    const rows = await dbx.query<Row>(`SELECT * FROM ${T(env, SYS.messages)} WHERE id = $1`, [id])
    return (await messageViews(dbx, env, rows))[0]
  }

  /** history of a conversation (top-level messages), 50 per page, always from the server */
  async function history(cx: ChatCx, channelId: string, o: { before?: number | null; after?: number | null; around?: number | null; limit?: number }): Promise<{ messages: ChatMessageView[]; more: boolean; newer?: boolean; lastSeq: number; purgedSeq: number }> {
    const d = db()
    const c = await conv(d, cx, channelId)
    const limit = Math.max(1, Math.min(CHAT_LIMITS.pageSize * 2, Math.trunc(o.limit ?? CHAT_LIMITS.pageSize) || CHAT_LIMITS.pageSize))
    if (o.around !== undefined && o.around !== null) {
      // a deep link to an old message: one page around it (the message and older ones, then newer ones), so the client
      // never pages back through the whole conversation; `more`: older ones exist, `newer`: newer ones exist
      const half = Math.max(1, Math.floor(limit / 2))
      const older = await d.query<Row>(`SELECT * FROM ${T(cx.env, SYS.messages)} WHERE "Channel" = $1 AND "ParentMessage" IS NULL AND "Seq" <= $2 ORDER BY "Seq" DESC LIMIT $3`, [c.ch.id, o.around, half + 1])
      const later = await d.query<Row>(`SELECT * FROM ${T(cx.env, SYS.messages)} WHERE "Channel" = $1 AND "ParentMessage" IS NULL AND "Seq" > $2 ORDER BY "Seq" ASC LIMIT $3`, [c.ch.id, o.around, limit - half + 1])
      const rows = [...older.slice(0, half).reverse(), ...later.slice(0, limit - half)]
      return { messages: await messageViews(d, cx.env, rows), more: older.length > half, newer: later.length > limit - half, lastSeq: num(c.ch.LastSeq), purgedSeq: num(c.ch.PurgedSeq) }
    }
    let rows: Row[]
    if (o.after !== undefined && o.after !== null) {
      rows = await d.query<Row>(`SELECT * FROM ${T(cx.env, SYS.messages)} WHERE "Channel" = $1 AND "ParentMessage" IS NULL AND "Seq" > $2 ORDER BY "Seq" ASC LIMIT $3`, [c.ch.id, o.after, limit + 1])
    } else {
      rows = await d.query<Row>(
        `SELECT * FROM ${T(cx.env, SYS.messages)} WHERE "Channel" = $1 AND "ParentMessage" IS NULL${o.before !== undefined && o.before !== null ? ' AND "Seq" < $3' : ''} ORDER BY "Seq" DESC LIMIT $2`,
        o.before !== undefined && o.before !== null ? [c.ch.id, limit + 1, o.before] : [c.ch.id, limit + 1],
      )
    }
    const more = rows.length > limit
    rows = rows.slice(0, limit)
    if (o.after === undefined || o.after === null) rows.reverse()
    return { messages: await messageViews(d, cx.env, rows), more, lastSeq: num(c.ch.LastSeq), purgedSeq: num(c.ch.PurgedSeq) }
  }

  async function messageRow(dbx: SqlDb, env: ChatEnv, id: string, lock = false): Promise<Row> {
    if (!isUuid(id)) throw messageNotFound()
    const r = (await dbx.query<Row>(`SELECT * FROM ${T(env, SYS.messages)} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id.toLowerCase()]))[0]
    if (!r) throw messageNotFound()
    return r
  }

  /** a message the reader may read (its conversation's rule), else 404 "Message not found." */
  async function readableMessage(dbx: SqlDb, cx: ChatCx, id: string): Promise<{ msg: Row; c: Conv }> {
    const msg = await messageRow(dbx, cx.env, id)
    try {
      return { msg, c: await conv(dbx, cx, str(msg.Channel)) }
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) throw messageNotFound()
      throw e
    }
  }

  async function replies(cx: ChatCx, messageId: string, o: { after?: number | null; limit?: number }): Promise<{ root: ChatMessageView; messages: ChatMessageView[]; more: boolean }> {
    const d = db()
    const { msg } = await readableMessage(d, cx, messageId)
    if (msg.ParentMessage) throw invalid('Replies belong to the first message of a thread.', 'message')
    const limit = Math.max(1, Math.min(200, Math.trunc(o.limit ?? 100) || 100))
    const rows = await d.query<Row>(`SELECT * FROM ${T(cx.env, SYS.messages)} WHERE "ParentMessage" = $1 AND "Seq" > $2 ORDER BY "Seq" ASC LIMIT $3`, [msg.id, o.after ?? 0, limit + 1])
    const [root] = await messageViews(d, cx.env, [msg])
    return { root, messages: await messageViews(d, cx.env, rows.slice(0, limit)), more: rows.length > limit }
  }

  /** every change after a seq (gap recovery, reconnect, a new server epoch) */
  async function changes(cx: ChatCx, channelId: string, after: number): Promise<ChatChanges> {
    const d = db()
    const c = await conv(d, cx, channelId)
    const purged = num(c.ch.PurgedSeq)
    const reset = after < purged
    const got = reset ? [] : await d.query<Row>(`SELECT * FROM ${T(cx.env, SYS.messages)} WHERE "Channel" = $1 AND "ChangeSeq" > $2 ORDER BY "ChangeSeq" ASC, "Seq" ASC LIMIT ${CHAT_CHANGES_PAGE + 1}`, [c.ch.id, after])
    const more = got.length > CHAT_CHANGES_PAGE
    const rows = got.slice(0, CHAT_CHANGES_PAGE)
    const messages = await messageViews(d, cx.env, rows)
    const memberChange = messages.some((m) => m.kind === 'system' && m.event?.type === 'members')
    const out: ChatChanges = {
      channelId: str(c.ch.id), lastSeq: num(c.ch.LastSeq), purgedSeq: purged, reset, messages,
      conversation: await view(d, cx, c, c.mem ? await unreadOf(d, cx, str(c.ch.id), c.mem.lastReadSeq) : {}),
      ...(more ? { more: true } : {}),
    }
    if (memberChange || reset) out.members = await listMembers(cx, channelId)
    return out
  }

  /* -------------------------------------------------------------- writing: the change counter, system messages, pushes */

  /** the next change counter value of a locked channel (inside the writer's transaction) */
  async function nextSeq(tx: SqlDb, env: ChatEnv, channelId: string, o: { messageOn?: boolean } = {}): Promise<number> {
    const r = await tx.query<{ s: string | number }>(
      `UPDATE ${T(env, SYS.channels)} SET "LastSeq" = COALESCE("LastSeq", 0) + 1, "modifiedOn" = now()${o.messageOn ? ', "LastMessageOn" = now()' : ''} WHERE id = $1 RETURNING "LastSeq" AS s`, [channelId],
    )
    if (!r[0]) throw notFound()
    return Number(r[0].s)
  }

  async function insertMessage(tx: SqlDb, env: ChatEnv, m: { id: string; channel: string; seq: number; by: string | null; kind: 'message' | 'system'; body: string; text: string; parent?: string | null; cards?: string | null; files?: string | null; mentions?: string | null }): Promise<void> {
    await tx.exec(
      `INSERT INTO ${T(env, SYS.messages)} ("id", "createdOn", "modifiedOn", "createdBy", "owner", "Channel", "Body", "ParentMessage", "Seq", "ChangeSeq", "Kind", "BodyText", "Cards", "Files", "MentionIds", "ReplyCount")
       VALUES ($1, now(), now(), $2, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11, 0)`,
      [m.id, m.by, m.channel, m.body, m.parent ?? null, m.seq, m.kind, m.text, m.cards ?? null, m.files ?? null, m.mentions ?? null],
    )
  }

  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  /** a system message (members, channel, export): sender empty, not editable; returns its id */
  async function systemMessage(tx: SqlDb, env: ChatEnv, channelId: string, seq: number, text: string, event: NonNullable<ChatMessageView['event']>): Promise<string> {
    const id = rowUid()
    await insertMessage(tx, env, { id, channel: channelId, seq, by: null, kind: 'system', body: `<p>${esc(text)}</p>`, text, cards: JSON.stringify({ event }) })
    return id
  }

  /** after the commit: the push to the conversation's subscribers, and the change note for caches (dashboards) */
  async function publish(env: ChatEnv, channelId: string, seq: number, op: ChatPushMessage['op'], messageId: string | null, origin?: string): Promise<void> {
    try {
      const message = messageId ? await oneView(db(), env, messageId) : undefined
      live?.publishChat(channelId, { channelId, seq, prev: seq - 1, op, ...(message ? { message } : {}), at: new Date().toISOString() }, origin)
    } catch (e) {
      log('warn', `chat: push failed: ${errText(e)}`)
    }
    touched(env, op === 'members' ? 'members' : op === 'reaction' ? 'reaction' : 'message')
  }

  /** generic caches over the chat tables (the dashboard batch cache) drop their entries; table topics on them are refused */
  function touched(env: ChatEnv, what: 'members' | 'message' | 'reaction' | 'channel'): void {
    const list = what === 'members' || what === 'channel' ? [SYS.channels, SYS.channelMembers, SYS.messages, SYS.messageReactions] : what === 'reaction' ? [SYS.messageReactions, SYS.messages] : [SYS.messages]
    for (const t of list) emitTableChange(env.id, t, { op: 'update', rowIds: [], changedColumns: [], actor: null })
  }

  async function pushUnreadTo(env: ChatEnv, channelId: string, lastSeq: number, userIds: string[]): Promise<void> {
    if (!live) return
    for (const u of userIds) live.pushUser(u, { event: 'chat.unread', channelId, lastSeq })
    void env
  }

  function pushChannels(userIds: string[], channelId: string, change: 'added' | 'removed' | 'updated'): void {
    if (!live) return
    for (const u of userIds) live.pushUser(u, { event: 'chat.channels', channelId, change })
  }

  /* -------------------------------------------------------------- conversations: writing */

  async function namesList(ids: string[]): Promise<string> {
    const map = await people()
    const names = ids.map((i) => map.get(i)?.name ?? 'Someone')
    return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  }

  async function checkPeople(env: ChatEnv, ids: unknown, field = 'members'): Promise<string[]> {
    if (ids === undefined || ids === null) return []
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) throw invalid('members is a list of user ids.', field)
    const list = [...new Set(ids as string[])]
    if (list.length > CHAT_LIMITS.maxChannelMembers) throw invalid(`At most ${CHAT_LIMITS.maxChannelMembers} members.`, field)
    const users = await chatUsers(env, list)
    const bad = list.filter((x) => !users.has(x))
    if (bad.length) throw invalid(`${bad.length === 1 ? 'One person' : `${bad.length} people`} cannot use chat (no access to its environment, disabled, or not a person).`, field)
    return list
  }

  async function addMemberRows(tx: SqlDb, env: ChatEnv, channelId: string, by: string, ids: string[], role: ChatMemberRole, notifyLevel: ChatNotifyLevel, lastReadSeq = 0): Promise<string[]> {
    const added: string[] = []
    for (const u of ids) {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO ${T(env, SYS.channelMembers)} ("id", "createdOn", "modifiedOn", "createdBy", "owner", "Channel", "User", "MemberRole", "Muted", "LastReadSeq", "NotifyLevel", "JoinedOn")
         VALUES ($1, now(), now(), $2, $3, $4, $3, $5, false, $6, $7, now()) ON CONFLICT DO NOTHING RETURNING id`,
        [rowUid(), by, u, channelId, role, lastReadSeq, notifyLevel],
      )
      if (r.length) added.push(u)
    }
    return added
  }

  async function createConversation(cx: ChatCx, b: Record<string, unknown>): Promise<ChatConversation> {
    writable(cx)
    const kind = b.kind === 'direct' || b.kind === 'group' ? b.kind : b.kind === undefined || b.kind === 'channel' ? 'channel' : null
    if (!kind) throw invalid('kind is channel, direct or group.', 'kind')
    const others = (await checkPeople(cx.env, b.members)).filter((x) => x !== cx.id)
    const d = db()
    if (kind === 'direct') {
      if (others.length !== 1) throw invalid('A direct conversation is with exactly one other person.', 'members')
      const key = [cx.id, others[0]].sort().join(':')
      const id = await d.tx(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`chat.direct.${cx.env.id}.${key}`])
        const found = await tx.query<{ id: string }>(`SELECT id FROM ${T(cx.env, SYS.channels)} WHERE "DirectKey" = $1`, [key])
        if (found[0]) return { id: found[0].id, created: false }
        const nid = rowUid()
        await tx.exec(
          `INSERT INTO ${T(cx.env, SYS.channels)} ("id", "createdOn", "modifiedOn", "createdBy", "owner", "Name", "Description", "Kind", "IsPrivate", "DirectKey", "LastSeq", "PurgedSeq", "PostingPolicy")
           VALUES ($1, now(), now(), $2, $2, 'direct', '', 'direct', true, $3, 0, 0, 'everyone')`, [nid, cx.id, key],
        )
        await addMemberRows(tx, cx.env, nid, cx.id, [cx.id, others[0]], 'member', 'all')
        return { id: nid, created: true }
      })
      if (id.created) pushChannels([cx.id, others[0]], id.id, 'added')
      return getConversation(cx, id.id)
    }
    if (kind === 'channel' && cx.settings.createChannels === 'makers' && !cx.isMaker && !cx.isAdmin) throw denied('Only makers and administrators may create channels here (Admin console > Chat).')
    if (kind === 'group' && (others.length < 2 || others.length + 1 > CHAT_LIMITS.maxGroupMembers)) throw invalid(`A group conversation has 3 to ${CHAT_LIMITS.maxGroupMembers} people (you included).`, 'members')
    const name = typeof b.name === 'string' ? b.name.trim().replace(/[\u0000-\u001f]/g, '').slice(0, 80) : ''
    if (kind === 'channel' && !name) throw invalid('A channel needs a name.', 'name')
    const description = typeof b.description === 'string' ? b.description.trim().slice(0, 1000) : ''
    const isPrivate = kind === 'channel' ? b.isPrivate !== false : true
    const posting = b.postingPolicy === 'owners' && kind === 'channel' ? 'owners' : 'everyone'
    const nid = rowUid()
    let seq = 0
    await d.tx(async (tx) => {
      if (kind === 'channel') {
        const clash = await tx.query(`SELECT 1 FROM ${T(cx.env, SYS.channels)} WHERE "Kind" = 'channel' AND lower("Name") = lower($1) AND "ArchivedOn" IS NULL LIMIT 1`, [name])
        if (clash.length) throw new HttpError(409, 'conflict', `A channel named "${name}" already exists.`, 'name')
      }
      await tx.exec(
        `INSERT INTO ${T(cx.env, SYS.channels)} ("id", "createdOn", "modifiedOn", "createdBy", "owner", "Name", "Description", "Kind", "IsPrivate", "LastSeq", "PurgedSeq", "PostingPolicy")
         VALUES ($1, now(), now(), $2, $2, $3, $4, $5, $6, 0, 0, $7)`, [nid, cx.id, kind === 'channel' ? name : name || 'group', description, kind, isPrivate, posting],
      )
      await addMemberRows(tx, cx.env, nid, cx.id, [cx.id], kind === 'channel' ? 'owner' : 'member', kind === 'channel' ? 'mentions' : 'all')
      if (others.length) await addMemberRows(tx, cx.env, nid, cx.id, others, 'member', kind === 'channel' ? 'mentions' : 'all')
      seq = await nextSeq(tx, cx.env, nid)
      const what = kind === 'channel' ? `${cx.name} created this channel` : `${cx.name} started this conversation`
      await systemMessage(tx, cx.env, nid, seq, others.length ? `${what} with ${await namesList(others)}` : what, { type: 'channel', change: 'created', by: cx.id })
    })
    pushChannels([cx.id, ...others], nid, 'added')
    touched(cx.env, 'channel')
    return getConversation(cx, nid)
  }

  /** owners of a channel (and any member of a group) may change it; direct conversations have nothing to change */
  async function updateConversation(cx: ChatCx, channelId: string, b: Record<string, unknown>): Promise<ChatConversation> {
    writable(cx)
    const d = db()
    let seq = 0
    let sysId = ''
    const c0 = await conv(d, cx, channelId)
    const kind = str(c0.ch.Kind)
    if (kind === 'direct') throw invalid('A direct conversation has no name or settings to change.')
    if (!c0.mem || (kind === 'channel' && c0.mem.role !== 'owner')) throw denied('Only the owners of the channel can change it.')
    const changesList: string[] = []
    await d.tx(async (tx) => {
      const c = await conv(tx, cx, channelId, { lock: true })
      const set: string[] = []
      const params: unknown[] = [c.ch.id]
      if (typeof b.name === 'string') {
        const name = b.name.trim().replace(/[\u0000-\u001f]/g, '').slice(0, 80)
        if (kind === 'channel' && !name) throw invalid('A channel needs a name.', 'name')
        if (name !== str(c.ch.Name)) {
          if (kind === 'channel') {
            const clash = await tx.query(`SELECT 1 FROM ${T(cx.env, SYS.channels)} WHERE "Kind" = 'channel' AND lower("Name") = lower($1) AND id <> $2 AND "ArchivedOn" IS NULL LIMIT 1`, [name, c.ch.id])
            if (clash.length) throw new HttpError(409, 'conflict', `A channel named "${name}" already exists.`, 'name')
          }
          params.push(name || 'group')
          set.push(`"Name" = $${params.length}`)
          changesList.push(`renamed it to "${name}"`)
        }
      }
      if (typeof b.description === 'string' && b.description.trim().slice(0, 1000) !== str(c.ch.Description)) {
        params.push(b.description.trim().slice(0, 1000))
        set.push(`"Description" = $${params.length}`)
        changesList.push('changed the description')
      }
      if ((b.postingPolicy === 'owners' || b.postingPolicy === 'everyone') && kind === 'channel' && b.postingPolicy !== (c.ch.PostingPolicy ?? 'everyone')) {
        params.push(b.postingPolicy)
        set.push(`"PostingPolicy" = $${params.length}`)
        changesList.push(b.postingPolicy === 'owners' ? 'let only owners post' : 'let everyone post')
      }
      if (!set.length) return
      await tx.exec(`UPDATE ${T(cx.env, SYS.channels)} SET ${set.join(', ')} WHERE id = $1`, params)
      seq = await nextSeq(tx, cx.env, str(c.ch.id))
      sysId = await systemMessage(tx, cx.env, str(c.ch.id), seq, `${cx.name} ${changesList.join(', ')}`, { type: 'channel', change: 'updated', by: cx.id })
    })
    if (seq) {
      await publish(cx.env, str(c0.ch.id), seq, 'channel', sysId, cx.origin)
      pushChannels((await membersOf(d, cx.env, str(c0.ch.id))).map((m) => m.user), str(c0.ch.id), 'updated')
    }
    return getConversation(cx, channelId)
  }

  /** archive or unarchive (owners; administrators through the admin route); archived: read-only, open channels hidden from non-members */
  async function setArchived(cx: ChatCx, channelId: string, archived: boolean, o: { asAdmin?: boolean } = {}): Promise<{ seq: number }> {
    if (!o.asAdmin) writable(cx)
    const d = db()
    let seq = 0
    let sysId = ''
    const channel = await d.tx(async (tx) => {
      const c = o.asAdmin ? await adminConv(tx, cx.env, channelId, true) : await conv(tx, cx, channelId, { lock: true })
      if (!o.asAdmin && (!c.mem || (str(c.ch.Kind) === 'channel' && c.mem.role !== 'owner'))) throw denied('Only the owners of the channel can archive it.')
      if (str(c.ch.Kind) === 'direct') throw invalid('A direct conversation cannot be archived.')
      if (!!c.ch.ArchivedOn === archived) return c
      await tx.exec(`UPDATE ${T(cx.env, SYS.channels)} SET "ArchivedOn" = ${archived ? 'now()' : 'NULL'} WHERE id = $1`, [c.ch.id])
      seq = await nextSeq(tx, cx.env, str(c.ch.id))
      const who = o.asAdmin ? 'An administrator' : cx.name
      sysId = await systemMessage(tx, cx.env, str(c.ch.id), seq, `${who} ${archived ? 'archived' : 'unarchived'} this conversation`, { type: 'channel', change: archived ? 'archived' : 'unarchived', ...(o.asAdmin ? { byAdmin: true } : { by: cx.id }) })
      return c
    })
    if (seq) {
      await publish(cx.env, str(channel.ch.id), seq, 'channel', sysId, cx.origin)
      // an archived open channel is no longer readable by non-members: their subscriptions are checked again
      live?.chatAccessChanged(str(channel.ch.id))
      pushChannels((await membersOf(d, cx.env, str(channel.ch.id))).map((m) => m.user), str(channel.ch.id), 'updated')
    }
    return { seq }
  }

  async function join(cx: ChatCx, channelId: string): Promise<ChatConversation> {
    writable(cx)
    const d = db()
    let seq = 0
    let sysId = ''
    await d.tx(async (tx) => {
      const c = await conv(tx, cx, channelId, { lock: true })
      if (c.mem) return
      // conv() let a non-member through only for an open channel (not private, not archived)
      const n = Number((await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${T(cx.env, SYS.channelMembers)} WHERE "Channel" = $1`, [c.ch.id]))[0]?.n ?? 0)
      if (n >= CHAT_LIMITS.maxChannelMembers) throw invalid(`The channel is full (${CHAT_LIMITS.maxChannelMembers} members).`)
      seq = await nextSeq(tx, cx.env, str(c.ch.id))
      await addMemberRows(tx, cx.env, str(c.ch.id), cx.id, [cx.id], 'member', 'mentions', seq)
      sysId = await systemMessage(tx, cx.env, str(c.ch.id), seq, `${cx.name} joined`, { type: 'members', added: [cx.id], by: cx.id })
    })
    if (seq) {
      await publish(cx.env, channelId.toLowerCase(), seq, 'members', sysId, cx.origin)
      pushChannels([cx.id], channelId.toLowerCase(), 'added')
    }
    return getConversation(cx, channelId)
  }

  /** members leave; the last owner leaving hands ownership to the longest-standing member */
  async function leave(cx: ChatCx, channelId: string): Promise<{ left: boolean }> {
    const d = db()
    let seq = 0
    let sysId = ''
    const id = channelId.toLowerCase()
    await d.tx(async (tx) => {
      const c = await conv(tx, cx, channelId, { lock: true })
      if (!c.mem) return
      if (str(c.ch.Kind) === 'direct') throw invalid('A direct conversation cannot be left.')
      await tx.exec(`DELETE FROM ${T(cx.env, SYS.channelMembers)} WHERE id = $1`, [c.mem.id])
      let text = `${cx.name} left`
      const event: NonNullable<ChatMessageView['event']> = { type: 'members', removed: [cx.id], by: cx.id }
      if (c.mem.role === 'owner') {
        const owners = await tx.query(`SELECT 1 FROM ${T(cx.env, SYS.channelMembers)} WHERE "Channel" = $1 AND "MemberRole" = 'owner' LIMIT 1`, [c.ch.id])
        if (!owners.length) {
          const next = await tx.query<{ id: string; User: string }>(`SELECT id, "User" FROM ${T(cx.env, SYS.channelMembers)} WHERE "Channel" = $1 ORDER BY "JoinedOn", id LIMIT 1`, [c.ch.id])
          if (next[0]) {
            await tx.exec(`UPDATE ${T(cx.env, SYS.channelMembers)} SET "MemberRole" = 'owner' WHERE id = $1`, [next[0].id])
            text += `; ${await nameOf(next[0].User)} is now an owner`
            event.owner = next[0].User
          }
        }
      }
      seq = await nextSeq(tx, cx.env, str(c.ch.id))
      sysId = await systemMessage(tx, cx.env, str(c.ch.id), seq, text, event)
    })
    if (!seq) return { left: false }
    await publish(cx.env, id, seq, 'members', sysId, cx.origin)
    live?.chatAccessChanged(id, [cx.id])
    pushChannels([cx.id], id, 'removed')
    return { left: true }
  }

  /** private channels: owners add; open channels and groups: any member adds; direct: nobody */
  async function addMembers(cx: ChatCx, channelId: string, b: Record<string, unknown>): Promise<ChatMemberView[]> {
    writable(cx)
    const ids = await checkPeople(cx.env, b.userIds, 'userIds')
    if (!ids.length) throw invalid('Say who to add: userIds.', 'userIds')
    const role: ChatMemberRole = b.role === 'owner' ? 'owner' : 'member'
    const d = db()
    let seq = 0
    let sysId = ''
    let added: string[] = []
    await d.tx(async (tx) => {
      const c = await conv(tx, cx, channelId, { lock: true })
      const kind = str(c.ch.Kind)
      if (!c.mem) throw denied('Join the channel first.')
      if (c.ch.ArchivedOn) throw denied('The conversation is archived.')
      if (kind === 'direct') throw invalid('A direct conversation is between two people. Start a group conversation instead.')
      const owner = c.mem.role === 'owner'
      if (kind === 'channel' && c.ch.IsPrivate !== false && !owner) throw denied('Only the owners of a private channel can add people.')
      if (role === 'owner' && !owner) throw denied('Only owners can make someone an owner.')
      const n = Number((await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${T(cx.env, SYS.channelMembers)} WHERE "Channel" = $1`, [c.ch.id]))[0]?.n ?? 0)
      const max = kind === 'group' ? CHAT_LIMITS.maxGroupMembers : CHAT_LIMITS.maxChannelMembers
      if (n + ids.length > max) throw invalid(`At most ${max} people in this ${kind === 'group' ? 'group conversation' : 'channel'}.`, 'userIds')
      added = await addMemberRows(tx, cx.env, str(c.ch.id), cx.id, ids, role, kind === 'group' ? 'all' : 'mentions')
      if (!added.length) return
      seq = await nextSeq(tx, cx.env, str(c.ch.id))
      sysId = await systemMessage(tx, cx.env, str(c.ch.id), seq, `${cx.name} added ${await namesList(added)}`, { type: 'members', added, by: cx.id })
    })
    if (seq) {
      await publish(cx.env, channelId.toLowerCase(), seq, 'members', sysId, cx.origin)
      pushChannels(added, channelId.toLowerCase(), 'added')
    }
    return listMembers(cx, channelId)
  }

  /** owners remove members (not in direct conversations); the removed person stops receiving the conversation at once */
  async function removeMember(cx: ChatCx | null, env: ChatEnv, channelId: string, userId: string, o: { asAdmin?: { id: string } } = {}): Promise<{ removed: boolean }> {
    if (cx && !o.asAdmin) writable(cx)
    const d = db()
    let seq = 0
    let sysId = ''
    const id = channelId.toLowerCase()
    await d.tx(async (tx) => {
      const c = o.asAdmin ? await adminConv(tx, env, channelId, true) : await conv(tx, cx!, channelId, { lock: true })
      if (str(c.ch.Kind) === 'direct') throw invalid('Nobody can be removed from a direct conversation.')
      if (!o.asAdmin) {
        if (!c.mem || (str(c.ch.Kind) === 'channel' && c.mem.role !== 'owner')) throw denied('Only the owners of the channel can remove people.')
        if (userId === cx!.id) throw invalid('To leave, use leave.')
      }
      const r = await tx.query<{ id: string }>(`DELETE FROM ${T(env, SYS.channelMembers)} WHERE "Channel" = $1 AND "User" = $2 RETURNING id`, [c.ch.id, userId])
      if (!r.length) return
      seq = await nextSeq(tx, env, str(c.ch.id))
      const who = o.asAdmin ? 'An administrator' : cx!.name
      sysId = await systemMessage(tx, env, str(c.ch.id), seq, `${who} removed ${await nameOf(userId)}`, { type: 'members', removed: [userId], ...(o.asAdmin ? { byAdmin: true } : { by: cx!.id }) })
    })
    if (!seq) return { removed: false }
    await publish(env, id, seq, 'members', sysId, cx?.origin)
    live?.chatAccessChanged(id, [userId])
    pushChannels([userId], id, 'removed')
    return { removed: true }
  }

  async function setRole(cx: ChatCx, channelId: string, userId: string, role: unknown): Promise<ChatMemberView[]> {
    writable(cx)
    if (role !== 'owner' && role !== 'member') throw invalid('role is owner or member.', 'role')
    const d = db()
    let seq = 0
    let sysId = ''
    await d.tx(async (tx) => {
      const c = await conv(tx, cx, channelId, { lock: true })
      if (str(c.ch.Kind) !== 'channel') throw invalid('Only channels have owners.')
      if (!c.mem || c.mem.role !== 'owner') throw denied('Only owners can change roles.')
      const r = await tx.query<{ id: string }>(`UPDATE ${T(cx.env, SYS.channelMembers)} SET "MemberRole" = $3 WHERE "Channel" = $1 AND "User" = $2 AND "MemberRole" IS DISTINCT FROM $3 RETURNING id`, [c.ch.id, userId, role])
      if (!r.length) return
      if (role === 'member') {
        const owners = await tx.query(`SELECT 1 FROM ${T(cx.env, SYS.channelMembers)} WHERE "Channel" = $1 AND "MemberRole" = 'owner' LIMIT 1`, [c.ch.id])
        if (!owners.length) throw invalid('A channel keeps at least one owner.')
      }
      seq = await nextSeq(tx, cx.env, str(c.ch.id))
      sysId = await systemMessage(tx, cx.env, str(c.ch.id), seq, `${cx.name} made ${await nameOf(userId)} ${role === 'owner' ? 'an owner' : 'a member'}`, { type: 'members', role, user: userId, by: cx.id })
    })
    if (seq) await publish(cx.env, channelId.toLowerCase(), seq, 'members', sysId, cx.origin)
    return listMembers(cx, channelId)
  }

  /** my own settings in a conversation: notify level, mute (not a change of the conversation: no seq) */
  async function setMine(cx: ChatCx, channelId: string, b: Record<string, unknown>): Promise<ChatConversation> {
    const d = db()
    const c = await conv(d, cx, channelId)
    if (!c.mem) throw denied('Join the channel first.')
    const set: string[] = []
    const params: unknown[] = [c.mem.id]
    if (b.notifyLevel !== undefined) {
      if (!['all', 'mentions', 'none'].includes(String(b.notifyLevel))) throw invalid('notifyLevel is all, mentions or none.', 'notifyLevel')
      params.push(b.notifyLevel)
      set.push(`"NotifyLevel" = $${params.length}`)
    }
    if (b.muted !== undefined) {
      params.push(b.muted === true)
      set.push(`"Muted" = $${params.length}`)
    }
    if (set.length) await d.exec(`UPDATE ${T(cx.env, SYS.channelMembers)} SET ${set.join(', ')}, "modifiedOn" = now() WHERE id = $1`, params)
    return getConversation(cx, channelId)
  }

  /* -------------------------------------------------------------- messages: writing */

  /** who may be mentioned here: members (private channels, direct, group); every chat user (open channels) */
  async function checkMentions(tx: SqlDb, cx: ChatCx, c: Conv, p: ParsedBody, memberCount: number): Promise<void> {
    if (p.mentionsChannel && memberCount > CHAT_LIMITS.channelMentionMembers && c.mem?.role !== 'owner' && !cx.isAdmin) {
      throw invalid(`@channel notifies everyone; in channels above ${CHAT_LIMITS.channelMentionMembers} members only owners and administrators may use it.`, 'body')
    }
    if (!p.mentions.length) return
    const open = str(c.ch.Kind) === 'channel' && c.ch.IsPrivate === false
    let readers: Set<string>
    if (open) readers = await chatUsers(cx.env, p.mentions)
    else readers = new Set((await tx.query<{ User: string }>(`SELECT "User" FROM ${T(cx.env, SYS.channelMembers)} WHERE "Channel" = $1 AND "User" = ANY($2::text[])`, [c.ch.id, p.mentions])).map((r) => r.User))
    const outside = p.mentions.filter((u) => !readers.has(u))
    if (outside.length) {
      throw invalid(`${outside.length === 1 ? `${await nameOf(outside[0])} is` : `${await namesList(outside)} are`} not in this conversation and cannot read it, so they cannot be mentioned. Add them first.`, 'body')
    }
  }

  async function insertMentions(tx: SqlDb, env: ChatEnv, messageId: string, by: string, users: string[]): Promise<void> {
    for (const u of users) {
      await tx.exec(
        `INSERT INTO ${T(env, SYS.mentions)} ("id", "createdOn", "modifiedOn", "createdBy", "owner", "MentionedUser", "regardingTable", "regardingId", "IsRead", "Message")
         VALUES ($1, now(), now(), $2, $3, $3, $4, $5::text, false, $5::text)`, [rowUid(), by, u, SYS.messages, messageId],
      )
    }
  }

  async function send(cx: ChatCx, channelId: string, b: Record<string, unknown>): Promise<{ message: ChatMessageView; duplicate: boolean }> {
    writable(cx)
    const p = parseBody(b.body)
    const cards = parseCards(b.cards)
    const fileIds = b.files === undefined || b.files === null ? [] : Array.isArray(b.files) && b.files.every((x) => typeof x === 'string') ? [...new Set(b.files as string[])] : null
    if (!fileIds) throw invalid('files is a list of attachment ids (upload them first).', 'files')
    if (fileIds.length > CHAT_LIMITS.maxFiles) throw invalid(`At most ${CHAT_LIMITS.maxFiles} files per message.`, 'files')
    if (!p.text.trim() && !fileIds.length && !cards.length) throw invalid('The message is empty.', 'body')
    const clientId = typeof b.clientId === 'string' && /^[A-Za-z0-9_.:-]{8,80}$/.test(b.clientId) ? b.clientId : null
    const parentId = typeof b.parent === 'string' && b.parent ? b.parent.toLowerCase() : null
    if (parentId && !isUuid(parentId)) throw invalid('parent is not a message of this conversation.', 'parent')
    const d = db()
    const cid = channelId.toLowerCase()
    const id = clientId ? messageIdFor(cx.id, cid, clientId) : rowUid()
    // a retried send (same clientId) finds the first one: answered without a second message or a rate-limit hit
    if (clientId) {
      const prev = await d.query<Row>(`SELECT * FROM ${T(cx.env, SYS.messages)} WHERE id = $1`, [id])
      if (prev[0]) {
        await conv(d, cx, cid)
        return { message: (await messageViews(d, cx.env, prev))[0], duplicate: true }
      }
    }
    if (!sends.allow(cx.id, CHAT_LIMITS.sendsPerMinute, 60_000)) throw new HttpError(429, 'rate_limited', `You are sending messages too fast (at most ${CHAT_LIMITS.sendsPerMinute} a minute). Wait a moment.`)
    let seq = 0
    let duplicate = false
    let members: { user: string; role: ChatMemberRole; notifyLevel: ChatNotifyLevel; muted: boolean }[] = []
    let conversation: Conv | null = null
    await d.tx(async (tx) => {
      const c = await conv(tx, cx, cid, { lock: true })
      conversation = c
      if (clientId && (await tx.query(`SELECT 1 FROM ${T(cx.env, SYS.messages)} WHERE id = $1`, [id])).length) {
        duplicate = true
        return
      }
      if (!c.mem) throw denied('Join the channel first.')
      if (systemKindOf(c.ch)) throw denied('Nobody posts in this conversation: Appbuilder sends its cards here. Answer an approval with the buttons of its card.')
      if (c.ch.ArchivedOn) throw denied('The conversation is archived: nothing can be posted.')
      if (c.ch.PostingPolicy === 'owners' && c.mem.role !== 'owner') throw denied('Only the owners of this channel can post in it.')
      if (parentId) {
        const parent = (await tx.query<Row>(`SELECT id, "ParentMessage", "Kind", "DeletedOn" FROM ${T(cx.env, SYS.messages)} WHERE id = $1 AND "Channel" = $2`, [parentId, cid]))[0]
        if (!parent || parent.Kind === 'system') throw invalid('parent is not a message of this conversation.', 'parent')
        if (parent.ParentMessage) throw invalid('Reply to the first message of the thread (threads have one level).', 'parent')
      }
      members = await membersOf(tx, cx.env, cid)
      await checkMentions(tx, cx, c, p, members.length)
      // files: uploaded for this conversation by the sender within the hour, not used by another message yet
      if (fileIds.length) {
        const claimed = await tx.query<{ id: string }>(
          `UPDATE ${T(cx.env, 'ab_attachments')} SET row_id = $1 WHERE id = ANY($2::text[]) AND table_id = $3 AND col = 'Files' AND row_id = $4 AND created_by = $5 AND created_on > $6 RETURNING id`,
          [id, fileIds, SYS.messages, draftRowId(cid), cx.id, new Date(Date.now() - CHAT_LIMITS.fileClaimMs)],
        )
        if (claimed.length !== fileIds.length) throw invalid('A file of this message was not uploaded by you to this conversation within the last hour (or was sent already). Upload it again.', 'files')
      }
      seq = await nextSeq(tx, cx.env, cid, { messageOn: !parentId })
      await insertMessage(tx, cx.env, {
        id, channel: cid, seq, by: cx.id, kind: 'message', body: p.body, text: p.text, parent: parentId,
        cards: cards.length ? JSON.stringify(cards) : null, files: fileIds.length ? JSON.stringify(fileIds) : null, mentions: mentionIdsJson(p),
      })
      if (parentId) await tx.exec(`UPDATE ${T(cx.env, SYS.messages)} SET "ReplyCount" = COALESCE("ReplyCount", 0) + 1, "LastReplyOn" = now(), "ChangeSeq" = $2 WHERE id = $1`, [parentId, seq])
      await insertMentions(tx, cx.env, id, cx.id, p.mentions)
      // my own message is read by me
      await tx.exec(`UPDATE ${T(cx.env, SYS.channelMembers)} SET "LastReadSeq" = GREATEST(COALESCE("LastReadSeq", 0), $2), "LastReadOn" = now() WHERE id = $1`, [c.mem.id, seq])
    })
    const message = (await oneView(d, cx.env, id))!
    if (duplicate) return { message, duplicate: true }
    await publish(cx.env, cid, seq, 'message', id, cx.origin)
    await pushUnreadTo(cx.env, cid, seq, members.map((m) => m.user).filter((u) => u !== cx.id))
    await notifyMessage(cx, conversation!, message, p, members, p.mentions).catch((e) => log('warn', `chat: notifications failed: ${errText(e)}`))
    return { message, duplicate: false }
  }

  async function edit(cx: ChatCx, messageId: string, b: Record<string, unknown>): Promise<ChatMessageView> {
    writable(cx)
    const p = parseBody(b.body)
    const d = db()
    const msg0 = await messageRow(d, cx.env, messageId)
    const cid = str(msg0.Channel)
    let seq = 0
    let added: string[] = []
    let conversation: Conv | null = null
    let members: { user: string; role: ChatMemberRole; notifyLevel: ChatNotifyLevel; muted: boolean }[] = []
    await d.tx(async (tx) => {
      let c: Conv
      try {
        c = await conv(tx, cx, cid, { lock: true })
      } catch (e) {
        throw e instanceof HttpError && e.status === 404 ? messageNotFound() : e
      }
      conversation = c
      const msg = await messageRow(tx, cx.env, messageId, true)
      if (str(msg.createdBy) !== cx.id || msg.Kind === 'system') throw denied('You can only edit your own messages.')
      if (msg.DeletedOn) throw invalid('The message was deleted.')
      if (c.ch.ArchivedOn) throw denied('The conversation is archived: nothing can be changed.')
      if (!c.mem) throw denied('You are no longer in this conversation.')
      const files = parseJsonList(msg.Files)
      const cards = parseJsonList(msg.Cards)
      if (!p.text.trim() && !files.length && !cards.length) throw invalid('The message is empty (delete it instead).', 'body')
      members = await membersOf(tx, cx.env, cid)
      await checkMentions(tx, cx, c, p, members.length)
      const before = new Set(parseJsonList(msg.MentionIds).map(String))
      added = p.mentions.filter((u) => !before.has(u))
      const removed = [...before].filter((u) => u !== 'channel' && !p.mentions.includes(u))
      seq = await nextSeq(tx, cx.env, cid)
      await tx.exec(`UPDATE ${T(cx.env, SYS.messages)} SET "Body" = $2, "BodyText" = $3, "MentionIds" = $4, "EditedOn" = now(), "modifiedOn" = now(), "ChangeSeq" = $5 WHERE id = $1`, [msg.id, p.body, p.text, mentionIdsJson(p), seq])
      if (removed.length) await tx.exec(`DELETE FROM ${T(cx.env, SYS.mentions)} WHERE "regardingTable" = $1 AND "regardingId" = $2 AND "MentionedUser" = ANY($3::text[])`, [SYS.messages, msg.id, removed])
      await insertMentions(tx, cx.env, str(msg.id), cx.id, added)
    })
    await publish(cx.env, cid, seq, 'edit', messageId.toLowerCase(), cx.origin)
    const message = (await oneView(d, cx.env, messageId.toLowerCase()))!
    // only people newly mentioned are told (the idempotency key keeps one notification per message and person)
    if (added.length || (p.mentionsChannel && !parseJsonList(msg0.MentionIds).includes('channel'))) {
      await notifyMessage(cx, conversation!, message, p, members, added, { onlyMentions: true }).catch((e) => log('warn', `chat: notifications failed: ${errText(e)}`))
    }
    return message
  }

  /**
   * deletes a message: the sender (own), or an administrator (moderation). The body, text, cards, files, mentions and
   * reactions are removed; a "message deleted" line stays in the history (DeletedOn, DeletedBy).
   */
  async function removeMessage(cx: ChatCx | null, env: ChatEnv, messageId: string, o: { asAdmin?: { id: string } } = {}): Promise<{ channelId: string; seq: number }> {
    if (cx && !o.asAdmin) writable(cx)
    const d = db()
    const msg0 = await messageRow(d, env, messageId)
    const cid = str(msg0.Channel)
    let seq = 0
    let files: AttachmentRecord[] = []
    await d.tx(async (tx) => {
      if (o.asAdmin) await adminConv(tx, env, cid, true)
      else {
        try {
          await conv(tx, cx!, cid, { lock: true })
        } catch (e) {
          throw e instanceof HttpError && e.status === 404 ? messageNotFound() : e
        }
      }
      const msg = await messageRow(tx, env, messageId, true)
      if (!o.asAdmin && (str(msg.createdBy) !== cx!.id || msg.Kind === 'system')) throw denied('You can only delete your own messages.')
      // P3 review, P3-11: a system line (members changed, "An administrator exported this conversation") is the
      // conversation's own record; moderation removes people's messages, never these (an export could not be hidden)
      if (o.asAdmin && msg.Kind === 'system') throw invalid('This is a line Appbuilder wrote into the conversation (members, archive, export): it cannot be removed.')
      if (msg.DeletedOn) return
      const ids = parseJsonList(msg.Files).map(String)
      if (ids.length) files = (await s.meta.attachments.many(ids)).filter((a) => a.tableId === SYS.messages && a.rowId === str(msg.id))
      seq = await nextSeq(tx, env, cid)
      await tx.exec(
        `UPDATE ${T(env, SYS.messages)} SET "Body" = '', "BodyText" = '', "Cards" = NULL, "Files" = NULL, "MentionIds" = NULL, "DeletedOn" = now(), "DeletedBy" = $2, "modifiedOn" = now(), "ChangeSeq" = $3 WHERE id = $1`,
        [msg.id, o.asAdmin ? o.asAdmin.id : cx!.id, seq],
      )
      await tx.exec(`DELETE FROM ${T(env, SYS.messageReactions)} WHERE "Message" = $1`, [msg.id])
      await tx.exec(`DELETE FROM ${T(env, SYS.mentions)} WHERE "regardingTable" = $1 AND "regardingId" = $2`, [SYS.messages, msg.id])
    })
    if (!seq) return { channelId: cid, seq: 0 }
    if (files.length) await runInEnvironment(env.id, () => s.data.internals.removeAttachments(files)).catch((e) => log('warn', `chat: removing files failed: ${errText(e)}`))
    await publish(env, cid, seq, 'delete', messageId.toLowerCase(), cx?.origin)
    return { channelId: cid, seq }
  }

  async function react(cx: ChatCx, messageId: string, b: Record<string, unknown>): Promise<ChatMessageView> {
    writable(cx)
    const emoji = checkEmoji(b.emoji)
    const on = b.on !== false
    const d = db()
    const msg0 = await messageRow(d, cx.env, messageId)
    const cid = str(msg0.Channel)
    let seq = 0
    await d.tx(async (tx) => {
      let c: Conv
      try {
        c = await conv(tx, cx, cid, { lock: true })
      } catch (e) {
        throw e instanceof HttpError && e.status === 404 ? messageNotFound() : e
      }
      if (!c.mem) throw denied('Join the channel first.')
      if (c.ch.ArchivedOn) throw denied('The conversation is archived.')
      const msg = await messageRow(tx, cx.env, messageId, true)
      if (msg.DeletedOn || msg.Kind === 'system' || !msg.createdBy) throw invalid('This message cannot take reactions.')
      const changed = on
        ? (await tx.query(`INSERT INTO ${T(cx.env, SYS.messageReactions)} ("id", "createdOn", "modifiedOn", "createdBy", "owner", "Message", "Emoji") VALUES ($1, now(), now(), $2, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id`, [rowUid(), cx.id, msg.id, emoji])).length
        : (await tx.query(`DELETE FROM ${T(cx.env, SYS.messageReactions)} WHERE "Message" = $1 AND "owner" = $2 AND "Emoji" = $3 RETURNING id`, [msg.id, cx.id, emoji])).length
      if (!changed) return
      seq = await nextSeq(tx, cx.env, cid)
      await tx.exec(`UPDATE ${T(cx.env, SYS.messages)} SET "ChangeSeq" = $2 WHERE id = $1`, [msg.id, seq])
    })
    if (seq) await publish(cx.env, cid, seq, 'reaction', messageId.toLowerCase(), cx.origin)
    return (await oneView(d, cx.env, messageId.toLowerCase()))!
  }

  /** read marker: everything up to seq is read (unread counts, chat mentions, chat notifications of this conversation) */
  async function markRead(cx: ChatCx, channelId: string, seqIn: unknown): Promise<{ lastReadSeq: number; unread: number; mentions: number }> {
    const d = db()
    const c = await conv(d, cx, channelId)
    if (!c.mem) return { lastReadSeq: 0, unread: 0, mentions: 0 }
    const want = Number(seqIn)
    const upTo = Math.min(Number.isFinite(want) && want >= 0 ? Math.trunc(want) : num(c.ch.LastSeq), num(c.ch.LastSeq))
    const r = await d.query<{ s: string | number }>(
      `UPDATE ${T(cx.env, SYS.channelMembers)} SET "LastReadSeq" = GREATEST(COALESCE("LastReadSeq", 0), $2), "LastReadOn" = now() WHERE id = $1 RETURNING "LastReadSeq" AS s`, [c.mem.id, upTo],
    )
    const last = Number(r[0]?.s ?? upTo)
    await d.exec(
      `UPDATE ${T(cx.env, SYS.mentions)} SET "IsRead" = true, "ReadOn" = now() WHERE "MentionedUser" = $1 AND "regardingTable" = $2 AND "IsRead" IS NOT TRUE
         AND "regardingId" IN (SELECT id FROM ${T(cx.env, SYS.messages)} WHERE "Channel" = $3 AND "Seq" <= $4)`, [cx.id, SYS.messages, c.ch.id, last],
    )
    const n = await d.exec(
      `UPDATE "ab"."notifications" SET read_on = now() WHERE user_id = $1 AND kind = 'chat' AND read_on IS NULL AND link LIKE $2 AND COALESCE(NULLIF(substring(link from '&m=([0-9]+)$'), ''), '0')::bigint <= $3`,
      [cx.id, `#chat?c=${str(c.ch.id)}&m=%`, last],
    )
    if (n.affectedRows) await s.notifications?.markRead(cx.id, []).catch(() => 0)
    const u = await unreadOf(d, cx, str(c.ch.id), last)
    live?.pushUser(cx.id, { event: 'chat.unread', channelId: str(c.ch.id), lastSeq: num(c.ch.LastSeq), lastReadSeq: last, unread: u.unread, mentions: u.mentions })
    return { lastReadSeq: last, ...u }
  }

  async function typingNow(cx: ChatCx, channelId: string): Promise<{ ok: true }> {
    const key = `${cx.id}:${channelId}`
    const last = typing.get(key) ?? 0
    if (Date.now() - last < CHAT_LIMITS.typingIntervalMs) return { ok: true }
    const c = await conv(db(), cx, channelId)
    if (!canPost(cx, c)) return { ok: true }
    typing.set(key, Date.now())
    if (typing.size > 20_000) for (const k of [...typing.keys()].slice(0, 10_000)) typing.delete(k)
    live?.publishTyping(str(c.ch.id), { id: cx.id, name: cx.name })
    return { ok: true }
  }

  /* -------------------------------------------------------------- files */

  /** a file for a message not sent yet: stored with the draft row id of the conversation; it must be named in a message within the hour */
  async function upload(cx: ChatCx, channelId: string, o: { name: string | null; mime: string; bytes: Buffer }): Promise<ChatFile> {
    writable(cx)
    const d = db()
    const c = await conv(d, cx, channelId)
    if (!canPost(cx, c)) throw denied(c.mem ? 'You cannot post in this conversation.' : 'Join the channel first.')
    if (o.bytes.length > CHAT_LIMITS.maxFileBytes) throw new HttpError(413, 'invalid', `The file is larger than ${CHAT_LIMITS.maxFileBytes / 1024 / 1024} MB.`, 'file')
    if (!o.bytes.length) throw invalid('The file is empty.', 'file')
    const fileName = ((o.name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop() ?? '').trim().slice(0, 255) || 'file'
    return runInEnvironment(cx.env.id, async () => {
      const stored = await s.attachments.put(o.bytes)
      const rec: AttachmentRecord = {
        id: uid('att'), tableId: SYS.messages, column: 'Files', rowId: draftRowId(str(c.ch.id)), fileName, mime: o.mime, sizeBytes: stored.sizeBytes, sha256: stored.sha256,
        storageKey: stored.storageKey, createdBy: cx.id, createdOn: s.now(),
      }
      try {
        await s.meta.attachments.insert(rec)
      } catch (e) {
        await s.attachments.remove(stored.storageKey).catch(() => {})
        throw e
      }
      return { id: rec.id, name: fileName, mime: o.mime, size: stored.sizeBytes, url: '' }
    })
  }

  /** a draft file the sender no longer wants (once sent, files go with their message) */
  async function discardDraft(cx: ChatCx, attachmentId: string): Promise<{ ok: true }> {
    const d = db()
    const r = await d.query<Row>(`SELECT id FROM ${T(cx.env, 'ab_attachments')} WHERE id = $1 AND table_id = $2 AND row_id LIKE 'draft-%' AND created_by = $3`, [attachmentId, SYS.messages, cx.id])
    if (!r.length) throw new HttpError(404, 'not-found', 'Attachment not found.')
    await runInEnvironment(cx.env.id, async () => s.data.internals.removeAttachments(await s.meta.attachments.many([attachmentId])))
    return { ok: true }
  }

  /* -------------------------------------------------------------- search */

  /**
   * Search in the reader's conversations only: the set of conversations the reader may read is computed first (member,
   * or an open channel); ranking and paging run on messages of that set and never see other rows. Deleted and system
   * messages are not found. File names are searched the same way. Card contents are never searched.
   */
  async function search(cx: ChatCx, o: { q: string | null; channel?: string | null; from?: string | null; before?: string | null; page?: number }): Promise<{ items: { message: ChatMessageView; conversation: { id: string; kind: string; name: string } }[]; more: boolean }> {
    const tsq = searchQuery(o.q)
    if (!tsq) return { items: [], more: false }
    const d = db()
    const readable = await d.query<{ id: string }>(
      `SELECT c.id FROM ${T(cx.env, SYS.channels)} c
        WHERE EXISTS (SELECT 1 FROM ${T(cx.env, SYS.channelMembers)} m WHERE m."Channel" = c.id AND m."User" = $1)
           OR (c."Kind" = 'channel' AND c."IsPrivate" = false AND c."ArchivedOn" IS NULL)`, [cx.id])
    let ids = readable.map((r) => r.id)
    if (o.channel) ids = ids.filter((x) => x === o.channel!.toLowerCase())
    if (!ids.length) return { items: [], more: false }
    const params: unknown[] = [ids, tsq, SYS.messages]
    const where: string[] = []
    if (o.from && isUuid(o.from)) {
      params.push(o.from)
      where.push(`m."createdBy" = $${params.length}`)
    }
    if (o.before) {
      const t = new Date(o.before)
      if (!Number.isNaN(t.getTime())) {
        params.push(t)
        where.push(`m."createdOn" < $${params.length}`)
      }
    }
    const page = Math.max(0, Math.min(50, Math.trunc(o.page ?? 0) || 0))
    const size = CHAT_LIMITS.searchPageSize
    const rows = await d.query<Row>(
      `SELECT m.*, ts_rank(to_tsvector('simple', COALESCE(m."BodyText", '')), q) AS "_rank"
         FROM ${T(cx.env, SYS.messages)} m, to_tsquery('simple', $2) q
        WHERE m."Channel" = ANY($1::text[]) AND m."DeletedOn" IS NULL AND m."Kind" = 'message'${where.length ? ` AND ${where.join(' AND ')}` : ''}
          AND (to_tsvector('simple', COALESCE(m."BodyText", '')) @@ q
               OR m.id IN (SELECT a.row_id FROM ${T(cx.env, 'ab_attachments')} a WHERE a.table_id = $3 AND a.col = 'Files' AND to_tsvector('simple', regexp_replace(a.file_name, '[^[:alnum:]]+', ' ', 'g')) @@ q))
        ORDER BY "_rank" DESC, m."createdOn" DESC, m.id DESC LIMIT ${size + 1} OFFSET ${page * size}`,
      params,
    )
    const more = rows.length > size
    const list = rows.slice(0, size)
    const views = await messageViews(d, cx.env, list)
    const chIds = [...new Set(list.map((r) => str(r.Channel)))]
    const chRows = chIds.length ? await d.query<Row>(`SELECT c.*, ${MEMBER_COLS} FROM ${T(cx.env, SYS.channels)} c LEFT JOIN ${T(cx.env, SYS.channelMembers)} m ON m."Channel" = c.id AND m."User" = $2 WHERE c.id = ANY($1::text[])`, [chIds, cx.id]) : []
    const convs = new Map<string, ChatConversation>()
    for (const r of chRows) convs.set(str(r.id), await view(d, cx, toConv(r)))
    return {
      items: views.map((m) => {
        const c = convs.get(m.channelId)
        return { message: m, conversation: { id: m.channelId, kind: c?.kind ?? 'channel', name: c?.name ?? '' } }
      }),
      more,
    }
  }

  /* -------------------------------------------------------------- people pickers */

  /** people who may be mentioned in a conversation: its members (private, direct, group) or every chat user (open channel) */
  async function mentionable(cx: ChatCx, channelId: string, text: string): Promise<{ id: string; name: string }[]> {
    const d = db()
    const c = await conv(d, cx, channelId)
    const open = str(c.ch.Kind) === 'channel' && c.ch.IsPrivate === false
    const ids = open ? [...(await visiblePeople(cx))] : (await membersOf(d, cx.env, str(c.ch.id))).map((m) => m.user)
    const map = await people()
    const t = text.trim().toLowerCase()
    return ids.map((id) => ({ id, name: map.get(id)?.name ?? '' })).filter((p) => p.name && (!t || p.name.toLowerCase().includes(t))).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 20)
  }

  /** chat users the reader may see in the directory (the environment's directory visibility applies) */
  async function visiblePeople(cx: ChatCx): Promise<Set<string>> {
    const users = await chatUsers(cx.env)
    return runInEnvironment(cx.env.id, async () => {
      const t = await s.meta.tables.get(SYS.users)
      if (!t) return users
      const res = await s.data.query(cx.user, t, { select: ['FullName'], top: 5000 })
      return new Set(res.rows.map((r) => str(r.id)).filter((id) => users.has(id)))
    })
  }

  async function peopleSearch(cx: ChatCx, text: string): Promise<{ id: string; name: string }[]> {
    const ids = await visiblePeople(cx)
    const map = await people()
    const t = text.trim().toLowerCase()
    return [...ids].filter((id) => id !== cx.id).map((id) => ({ id, name: map.get(id)?.name ?? '' })).filter((p) => p.name && (!t || p.name.toLowerCase().includes(t))).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 30)
  }

  /* -------------------------------------------------------------- reports (members tell administrators) */

  async function report(cx: ChatCx, messageId: string, b: Record<string, unknown>): Promise<{ reported: true }> {
    const d = db()
    const { msg } = await readableMessage(d, cx, messageId)
    if (msg.Kind === 'system' || msg.DeletedOn || !msg.createdBy) throw invalid('This message cannot be reported.')
    const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 1000) : ''
    if (!reason) throw invalid('Say why you report the message.', 'reason')
    await d.exec(
      `INSERT INTO ${T(cx.env, 'ab_chat_reports')} (id, message_id, channel_id, reporter_id, reason, state, created_on) VALUES ($1, $2, $3, $4, $5, 'open', now()) ON CONFLICT DO NOTHING`,
      [uid('crp'), msg.id, msg.Channel, cx.id, reason],
    )
    // the administrators of the chat environment are told that a report waits (never what the message says)
    const admins = await chatAdmins(cx.env)
    if (admins.length) {
      await s.notifications?.notify({ userIds: admins }, { kind: 'system', title: 'A chat message was reported', body: 'Open Admin console > Chat > Reports to handle it.', link: '#admin/chat', environmentId: cx.env.id, source: 'system' }).catch(() => undefined)
    }
    return { reported: true }
  }

  /** environment administrators of the chat environment and install administrators */
  async function chatAdmins(env: ChatEnv): Promise<string[]> {
    const out: string[] = []
    const users = await chatUsers(env)
    const roles = await runInEnvironment(env.id, () => s.meta.roles.list())
    const adminRoles = new Set(roles.filter((r) => r.isAdmin).map((r) => r.id))
    const map = await people()
    for (const id of users) {
      if (map.get(id)?.installAdmin) {
        out.push(id)
        continue
      }
      const rec = await runInEnvironment(env.id, () => s.meta.users.get(id))
      if (rec?.roleIds?.some((r) => adminRoles.has(r))) out.push(id)
    }
    return out
  }

  /* -------------------------------------------------------------- notifications */

  async function notifyMessage(
    cx: ChatCx, c: Conv, message: ChatMessageView, p: ParsedBody, members: { user: string; notifyLevel: ChatNotifyLevel; muted: boolean }[], mentioned: string[], o: { onlyMentions?: boolean } = {},
  ): Promise<void> {
    const notifications = s.notifications
    if (!notifications) return
    const kind = str(c.ch.Kind)
    const label = kind === 'channel' ? `#${str(c.ch.Name)}` : kind === 'group' ? 'a group conversation' : 'a direct message'
    const mentionedSet = new Set(mentioned)
    const targets = new Map<string, 'mention' | 'channel' | 'direct' | 'message'>()
    for (const m of members) {
      if (m.user === cx.id || m.muted || m.notifyLevel === 'none') continue
      if (mentionedSet.has(m.user)) targets.set(m.user, 'mention')
      else if (p.mentionsChannel) targets.set(m.user, 'channel')
      else if (o.onlyMentions) continue
      else if (kind !== 'channel' && m.notifyLevel === 'all') targets.set(m.user, 'direct')
      else if (m.notifyLevel === 'all') targets.set(m.user, 'message')
    }
    // people mentioned in an open channel who are not members (they can read it): told about the mention
    const memberSet = new Set(members.map((m) => m.user))
    for (const u of mentioned) if (!memberSet.has(u) && u !== cx.id) targets.set(u, 'mention')
    const what = message.text ? preview(message.text) : message.files.length ? `${message.files.length === 1 ? 'A file' : `${message.files.length} files`}` : message.cards.length ? 'Shared an item. Open it in Appbuilder.' : ''
    for (const [userId, why] of targets) {
      const title = why === 'mention' ? `${cx.name} mentioned you in ${label}` : why === 'channel' ? `${cx.name} mentioned everyone in ${label}` : why === 'direct' ? (kind === 'direct' ? `${cx.name} sent you a message` : `${cx.name} in ${label}`) : `${cx.name} in ${label}`
      await notifications.notify({ userIds: [userId] }, {
        kind: 'chat', title: title.slice(0, 200), body: what, link: chatLink(message.channelId, message.seq), environmentId: cx.env.id,
        source: `user:${cx.id}`, from: { id: cx.id, name: cx.name }, idempotencyKey: `chat:${message.id}:${userId}`,
      }).catch((e) => log('warn', `chat: a notification failed: ${errText(e)}`))
    }
  }

  /** digest relevance (notifications-delivery.ts): a chat item read before the digest, or no longer readable, is dropped */
  async function digestRelevance(userId: string, item: { link: string | null }): Promise<string | null> {
    const m = /^#chat\?c=([0-9a-f-]{36})&m=(\d+)$/.exec(item.link ?? '')
    if (!m) return null
    const cx = await cxForUser(userId)
    if (!cx) return 'You can no longer use chat.'
    const r = await db().query<Row>(
      `SELECT c."Kind", c."IsPrivate", c."ArchivedOn", mm."LastReadSeq", (SELECT msg."DeletedOn" FROM ${T(cx.env, SYS.messages)} msg WHERE msg."Channel" = c.id AND msg."Seq" = $3) AS "_deleted",
              (SELECT 1 FROM ${T(cx.env, SYS.messages)} msg WHERE msg."Channel" = c.id AND msg."Seq" = $3) AS "_exists"
         FROM ${T(cx.env, SYS.channels)} c LEFT JOIN ${T(cx.env, SYS.channelMembers)} mm ON mm."Channel" = c.id AND mm."User" = $2 WHERE c.id = $1`, [m[1], userId, Number(m[2])],
    )
    const row = r[0]
    const open = row && row.Kind === 'channel' && row.IsPrivate === false && !row.ArchivedOn
    if (!row || (row.LastReadSeq === null && !open)) return 'You can no longer read this conversation.'
    if (!row._exists || row._deleted) return 'The message was deleted before the digest.'
    if (num(row.LastReadSeq) >= Number(m[2])) return 'Read before the digest.'
    return null
  }

  /* -------------------------------------------------------------- the live hub's access check */

  async function canRead(userId: string, channelId: string): Promise<{ lastSeq: number } | null> {
    if (!isUuid(channelId)) return null
    const cx = await cxForUser(userId)
    if (!cx) return null
    try {
      const c = await conv(db(), cx, channelId)
      return { lastSeq: num(c.ch.LastSeq) }
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null
      throw e
    }
  }

  /* -------------------------------------------------------------- Appbuilder's own conversations (approval cards, package E) */

  /** the person's direct conversation with the system sender "Approvals" (made on first use; one per person) */
  async function approvalsConversation(env: ChatEnv, userId: string): Promise<{ id: string; created: boolean }> {
    const key = `${SYSTEM_KEY_APPROVALS}${userId}`
    const r = await db().tx(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`chat.direct.${env.id}.${key}`])
      const found = await tx.query<{ id: string }>(`SELECT id FROM ${T(env, SYS.channels)} WHERE "DirectKey" = $1`, [key])
      if (found[0]) return { id: found[0].id, created: false }
      const nid = rowUid()
      await tx.exec(
        `INSERT INTO ${T(env, SYS.channels)} ("id", "createdOn", "modifiedOn", "createdBy", "owner", "Name", "Description", "Kind", "IsPrivate", "DirectKey", "LastSeq", "PurgedSeq", "PostingPolicy")
         VALUES ($1, now(), now(), $2, $2, 'Approvals', 'Approval requests waiting for you, with their answer buttons.', 'direct', true, $3, 0, 0, 'owners')`, [nid, userId, key],
      )
      await addMemberRows(tx, env, nid, userId, [userId], 'member', 'all')
      return { id: nid, created: true }
    })
    if (r.created) pushChannels([userId], r.id, 'added')
    return r
  }

  /**
   * posts a card from Appbuilder (no sender) into one of its conversations, once per id (a retry or a second sweep finds
   * the first). Card references only, never values; the text is the notification-safe title.
   */
  async function postSystemCard(env: ChatEnv, channelId: string, o: { id: string; text: string; card: ChatCardRef }): Promise<{ posted: boolean; seq: number }> {
    const d = db()
    let seq = 0
    let posted = false
    await d.tx(async (tx) => {
      const ch = (await tx.query<Row>(`SELECT id FROM ${T(env, SYS.channels)} WHERE id = $1 FOR UPDATE`, [channelId]))[0]
      if (!ch) throw notFound()
      if ((await tx.query(`SELECT 1 FROM ${T(env, SYS.messages)} WHERE id = $1`, [o.id])).length) return
      seq = await nextSeq(tx, env, channelId, { messageOn: true })
      await insertMessage(tx, env, { id: o.id, channel: channelId, seq, by: null, kind: 'message', body: `<p>${esc(o.text)}</p>`, text: o.text, cards: JSON.stringify([o.card]) })
      posted = true
    })
    if (!posted) return { posted: false, seq: 0 }
    await publish(env, channelId, seq, 'message', o.id)
    const members = (await membersOf(d, env, channelId)).map((m) => m.user)
    await pushUnreadTo(env, channelId, seq, members)
    return { posted: true, seq }
  }

  /** a system card's reference changed (an approval card answered or decided): a new change seq, pushed as an edit */
  async function updateSystemCard(env: ChatEnv, messageId: string, card: ChatCardRef): Promise<boolean> {
    const d = db()
    const msg0 = (await d.query<Row>(`SELECT id, "Channel", "createdBy" FROM ${T(env, SYS.messages)} WHERE id = $1`, [messageId]))[0]
    if (!msg0 || msg0.createdBy) return false
    const cid = str(msg0.Channel)
    let seq = 0
    await d.tx(async (tx) => {
      await tx.query(`SELECT id FROM ${T(env, SYS.channels)} WHERE id = $1 FOR UPDATE`, [cid])
      const msg = (await tx.query<Row>(`SELECT id, "Cards", "DeletedOn" FROM ${T(env, SYS.messages)} WHERE id = $1 FOR UPDATE`, [messageId]))[0]
      if (!msg || msg.DeletedOn) return
      const next = JSON.stringify([card])
      if (str(msg.Cards) === next) return
      seq = await nextSeq(tx, env, cid)
      await tx.exec(`UPDATE ${T(env, SYS.messages)} SET "Cards" = $2, "modifiedOn" = now(), "ChangeSeq" = $3 WHERE id = $1`, [messageId, next, seq])
    })
    if (!seq) return false
    await publish(env, cid, seq, 'edit', messageId)
    return true
  }

  /** system cards still pending (approval cards waiting for an answer), for the sweep after a restart */
  async function pendingSystemCards(env: ChatEnv): Promise<{ id: string; card: ChatCardRef }[]> {
    const rows = await db().query<Row>(
      `SELECT m.id, m."Cards" FROM ${T(env, SYS.messages)} m JOIN ${T(env, SYS.channels)} c ON c.id = m."Channel"
        WHERE c."DirectKey" LIKE $1 AND m."createdBy" IS NULL AND m."Kind" = 'message' AND m."DeletedOn" IS NULL AND m."Cards" LIKE '%"state":"pending"%'`,
      [`${SYSTEM_KEY_APPROVALS}%`],
    )
    const out: { id: string; card: ChatCardRef }[] = []
    for (const r of rows) {
      const c = parseJsonList((() => { try { return JSON.parse(str(r.Cards)) } catch { return [] } })())[0] as ChatCardRef | undefined
      if (c && c.kind === 'approval') out.push({ id: str(r.id), card: c })
    }
    return out
  }

  /** which of these message ids exist (the sweep posts a card once) */
  async function existingMessages(env: ChatEnv, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set()
    return new Set((await db().query<{ id: string }>(`SELECT id FROM ${T(env, SYS.messages)} WHERE id = ANY($1::text[])`, [ids])).map((r) => r.id))
  }

  /* -------------------------------------------------------------- chat mentions for the Mentions page (package E) */

  /** where I was mentioned in chat (messages I can still read), newest first, with the link that opens the message */
  async function myMentions(cx: ChatCx, limit = 50): Promise<{ id: string; IsRead: boolean; createdOn: string; Body: string; Link: string; byName: string | null; conversation: string; regardingTable: string; regardingId: string }[]> {
    const d = db()
    const rows = await d.query<Row>(
      `SELECT mn.id, mn."IsRead", mn."createdOn", m.id AS "_mid", m."BodyText", m."Channel", m."Seq", m."createdBy", c."Kind", c."Name", c."IsPrivate", c."ArchivedOn",
              EXISTS (SELECT 1 FROM ${T(cx.env, SYS.channelMembers)} x WHERE x."Channel" = c.id AND x."User" = $1) AS "_member"
         FROM ${T(cx.env, SYS.mentions)} mn JOIN ${T(cx.env, SYS.messages)} m ON m.id = mn."regardingId" JOIN ${T(cx.env, SYS.channels)} c ON c.id = m."Channel"
        WHERE mn."MentionedUser" = $1 AND mn."regardingTable" = $2 AND m."DeletedOn" IS NULL
        ORDER BY mn."createdOn" DESC, mn.id DESC LIMIT $3`, [cx.id, SYS.messages, Math.max(1, Math.min(200, limit))],
    )
    const map = await people()
    return rows
      // the conversation's read rule, once more (a member, or an open channel)
      .filter((r) => r._member === true || (r.Kind === 'channel' && r.IsPrivate === false && !r.ArchivedOn))
      .map((r) => ({
        id: str(r.id), IsRead: r.IsRead === true, createdOn: iso(r.createdOn) ?? '', Body: preview(str(r.BodyText), 280), Link: chatLink(str(r.Channel), num(r.Seq)),
        byName: r.createdBy ? map.get(str(r.createdBy))?.name ?? null : null, conversation: r.Kind === 'channel' ? `#${str(r.Name)}` : r.Kind === 'group' ? 'a group conversation' : 'a direct message',
        regardingTable: SYS.messages, regardingId: str(r._mid),
      }))
  }

  async function markMentionRead(cx: ChatCx, mentionId: string): Promise<{ ok: true }> {
    await db().exec(`UPDATE ${T(cx.env, SYS.mentions)} SET "IsRead" = true, "ReadOn" = now() WHERE id = $1 AND "MentionedUser" = $2 AND "regardingTable" = $3`, [mentionId, cx.id, SYS.messages])
    return { ok: true }
  }

  /* -------------------------------------------------------------- administrators: metadata, never messages */

  /** a conversation for an administrator action (any conversation; never its messages) */
  async function adminConv(dbx: SqlDb, env: ChatEnv, channelId: string, lock = false): Promise<Conv> {
    if (!isUuid(channelId)) throw notFound()
    const r = (await dbx.query<Row>(`SELECT c.* FROM ${T(env, SYS.channels)} c WHERE c.id = $1${lock ? ' FOR UPDATE' : ''}`, [channelId.toLowerCase()]))[0]
    if (!r) throw notFound()
    return { ch: r, mem: null, readable: false }
  }

  return {
    // contexts and access
    resolve, cxForUser, canRead, chatEnv, chatUsers, forgetPeople, installReadOnly, writable,
    // conversations
    listConversations, getConversation, createConversation, updateConversation, setArchived, join, leave, listMembers, addMembers, removeMember, setRole, setMine,
    // messages
    history, replies, changes, send, edit, removeMessage, react, markRead, typingNow, upload, discardDraft, search, mentionable, peopleSearch, report,
    // internals for admin.ts, cards.ts, export.ts, the digest
    adminConv, membersOf, messageViews, nextSeq, systemMessage, publish, touched, pushChannels, people, nameOf, digestRelevance, readableMessage, chatAdmins, T,
    // Appbuilder's own conversations and the Mentions page (package E)
    approvalsConversation, postSystemCard, updateSystemCard, pendingSystemCards, existingMessages, myMentions, markMentionRead,
    accessChanged: (channelId: string, userIds?: string[]) => live?.chatAccessChanged(channelId, userIds),
  }
}
