/**
 * Per-record discussions in chat (P3 package E; spec default 5: a record's discussion IS its Comments, shown on the
 * record timeline and in chat's "Discussions" list; no channel of kind `record`).
 *
 *   GET  /chat/discussions?limit=     records I follow or was mentioned on, in the REQUEST's environment (Follows,
 *                                     Comments and Mentions are per environment), newest comment first, with my unread
 *                                     count (comments by others after my Follows.LastReadOn) and the link that opens
 *                                     the record in the app it was discussed in
 *   POST /chat/discussions/read       { table?, row }: I read this record's discussion now (Follows.LastReadOn)
 *
 * Everything is read through the DataService AS THE PERSON: the regarding rule of Comments, Mentions and Follows (a
 * record the person cannot read hides its comments, mentions and follows) and the record's own row predicate for the
 * label. A person who loses read access to the record loses the discussion here exactly as on the timeline.
 */
import { HttpError } from '../contracts.ts'
import type { Ctx, UserContext } from '../contracts.ts'
import type { ApiRouter } from '../router.ts'
import type { CoreServices } from '../services.ts'
import { REGARDING, SYS, richTextToPlain } from '../../../src/platform/system-tables.ts'

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null)

export interface DiscussionItem {
  table: string
  row: string
  tableName: string
  label: string
  following: boolean
  mentioned: boolean
  lastCommentOn: string | null
  lastText: string
  lastBy: string | null
  /** comments by others after my last read (following) or after my newest unread mention */
  unread: number
  /** where the record is opened (the app it was discussed in), or null */
  link: string | null
}

export async function listDiscussions(s: CoreServices, user: UserContext, limit = 30): Promise<DiscussionItem[]> {
  const t = async (id: string) => {
    const d = await s.meta.tables.get(id)
    if (!d) throw new HttpError(404, 'not-found', 'The collaboration tables are not available.')
    return d
  }
  const me = user.user.id
  const [follows, mentions, comments] = [await t(SYS.follows), await t(SYS.mentions), await t(SYS.comments)]
  const fl = await s.data.query(user, follows, { where: { col: 'owner', op: 'eq', value: me }, select: [REGARDING.table, REGARDING.id, 'LastReadOn', 'createdOn'], orderBy: [{ col: 'createdOn', dir: 'desc' }], top: 200 })
  const mn = await s.data.query(user, mentions, {
    where: { and: [{ col: 'MentionedUser', op: 'eq', value: me }, { col: 'Comment', op: 'notBlank' }] },
    select: [REGARDING.table, REGARDING.id, 'IsRead', 'Comment', 'createdOn'], orderBy: [{ col: 'createdOn', dir: 'desc' }], top: 200,
  })
  const items = new Map<string, { table: string; row: string; following: boolean; mentioned: boolean; since: number | null; unreadMentions: string[] }>()
  const key = (tb: string, id: string) => `${tb}\u0001${id}`
  for (const r of fl.rows) {
    const tb = str(r[REGARDING.table])
    const id = str(r[REGARDING.id])
    if (!tb || !id || tb === SYS.messages) continue
    const since = r.LastReadOn ? new Date(str(r.LastReadOn)).getTime() : new Date(str(r.createdOn)).getTime()
    items.set(key(tb, id), { table: tb, row: id, following: true, mentioned: false, since: Number.isFinite(since) ? since : null, unreadMentions: [] })
  }
  for (const r of mn.rows) {
    const tb = str(r[REGARDING.table])
    const id = str(r[REGARDING.id])
    if (!tb || !id || tb === SYS.messages) continue
    const cur = items.get(key(tb, id))
    const unreadMentions = r.IsRead === true ? [] : [str(r.Comment)]
    if (cur) {
      cur.mentioned = true
      cur.unreadMentions.push(...unreadMentions)
    } else items.set(key(tb, id), { table: tb, row: id, following: false, mentioned: true, since: null, unreadMentions })
  }
  if (!items.size) return []
  // the records' labels as this person may read them: an unreadable record has none and is left out
  const labels = await s.collab.regardingLabels(user, [...items.values()].map((i) => ({ table: i.table, id: i.row })))
  const readable = [...items.values()].filter((i) => labels.has(`${i.table}:${i.row}`)).slice(0, 100)
  if (!readable.length) return []
  const cm = await s.data.query(user, comments, {
    where: { col: REGARDING.id, op: 'in', value: readable.map((i) => i.row) },
    select: ['id', REGARDING.table, REGARDING.id, 'Body', 'Link', 'createdBy', 'createdOn'], orderBy: [{ col: 'createdOn', dir: 'desc' }], top: 2000,
  })
  const names = new Map<string, string>()
  const nameOf = async (id: string) => {
    if (!id) return null
    if (!names.has(id)) names.set(id, (await s.meta.users.get(id))?.name ?? '')
    return names.get(id) || null
  }
  const out: DiscussionItem[] = []
  for (const i of readable) {
    const list = cm.rows.filter((r) => str(r[REGARDING.id]) === i.row && str(r[REGARDING.table]) === i.table)
    const last = list[0]
    const l = labels.get(`${i.table}:${i.row}`)!
    // not following: unread from the first comment that mentions me and that I have not read
    let since = i.since
    if (since === null) {
      const times = list.filter((r) => i.unreadMentions.includes(str(r.id))).map((r) => new Date(str(r.createdOn)).getTime())
      since = times.length ? Math.min(...times) - 1 : null
    }
    const unread = since === null ? 0 : list.filter((r) => str(r.createdBy) !== me && new Date(str(r.createdOn)).getTime() > since!).length
    const link = list.map((r) => str(r.Link)).find((x) => x.startsWith('#')) ?? null
    out.push({
      table: i.table, row: i.row, tableName: l.tableName, label: l.label, following: i.following, mentioned: i.mentioned,
      lastCommentOn: last ? iso(last.createdOn) : null, lastText: last ? richTextToPlain(str(last.Body)).slice(0, 200) : '', lastBy: last ? await nameOf(str(last.createdBy)) : null,
      unread, link,
    })
  }
  out.sort((a, b) => String(b.lastCommentOn ?? '').localeCompare(String(a.lastCommentOn ?? '')))
  return out.slice(0, Math.max(1, Math.min(100, limit)))
}

/** I read the discussion of this record now: my Follows row's LastReadOn (the regarding rule applies to the update too) */
export async function readDiscussion(s: CoreServices, user: UserContext, b: Record<string, unknown>): Promise<{ ok: true; following: boolean }> {
  const row = typeof b.row === 'string' ? b.row.trim().slice(0, 64) : ''
  if (!row) throw new HttpError(422, 'invalid', 'row is needed.', 'row')
  const follows = await s.meta.tables.get(SYS.follows)
  if (!follows) return { ok: true, following: false }
  const mine = await s.data.query(user, follows, { where: { and: [{ col: REGARDING.id, op: 'eq', value: row }, { col: 'owner', op: 'eq', value: user.user.id }] }, select: ['id'], top: 1 })
  if (!mine.rows[0]) return { ok: true, following: false }
  await s.data.update(user, follows, str(mine.rows[0].id), { LastReadOn: new Date().toISOString() })
  return { ok: true, following: true }
}

export function discussionRoutes(router: ApiRouter, s: CoreServices): void {
  router.add('GET', '/chat/discussions', async (ctx: Ctx) => {
    const limit = Number(ctx.query.get('limit') ?? 30)
    return { items: await listDiscussions(s, ctx.user!, Number.isFinite(limit) ? limit : 30) }
  }, { auth: 'user' })
  router.add('POST', '/chat/discussions/read', async (ctx: Ctx) => {
    const b = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? (ctx.body as Record<string, unknown>) : {}
    return readDiscussion(s, ctx.user!, b)
  }, { auth: 'user' })
}
