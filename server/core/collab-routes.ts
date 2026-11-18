/**
 * Core data model routes (P0 package N; docs/dev/data-api.md "Core data model"). Every signed-in user; security is the
 * engine's (the regarding rule and the record's own read predicate), never decided here.
 *
 *   GET  /collab/timeline?table=&row=&cursor=&limit=     one record's feed (404 when the caller cannot read the record)
 *   GET  /collab/mentionable?table=&row=&q=              people who may be @mentioned there (they can read the record)
 *   POST /collab/follow   { table?, row, on }            follow / unfollow a record
 *   POST /collab/tags     { table?, row, tag, on }       put a tag on a record (the tag is created when new) / take it off
 *   GET  /collab/my-tasks?status=open|all&limit=         tasks assigned to me or my teams, and my own unassigned ones
 *   GET  /collab/mentions?limit=                         where I was mentioned (newest first)
 * The rows themselves (comments, activities, documents ...) are written through the normal data API.
 */
import { HttpError } from './contracts.ts'
import type { Ctx, UserContext } from './contracts.ts'
import type { ApiRouter } from './router.ts'
import type { CoreServices } from './services.ts'
import type { Condition } from '../../src/platform/http.ts'
import { REGARDING, SYS } from '../../src/platform/system-tables.ts'

function body(ctx: Ctx): Record<string, unknown> {
  const b = ctx.body
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(422, 'invalid', 'Request body must be a JSON object.')
  return b as Record<string, unknown>
}
const text = (v: unknown, what: string, max = 200): string => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(422, 'invalid', `${what} is needed.`)
  return v.trim().slice(0, max)
}

export function collabRoutes(router: ApiRouter, s: CoreServices): void {
  const table = async (id: string) => {
    const t = await s.meta.tables.get(id)
    if (!t) throw new HttpError(404, 'not-found', `Table "${id}" does not exist.`)
    return t
  }
  /** the regarding row of a body: the collab service resolves the table from the row id when it is not given */
  const regarding = async (ctx: Ctx, b: Record<string, unknown>) => {
    const values: Record<string, string> = { [REGARDING.id]: text(b.row, 'The record (row)', 64) }
    if (typeof b.table === 'string' && b.table) values[REGARDING.table] = b.table
    return s.collab.checkRegarding(ctx.user!, values as never, true)
  }

  router.add('GET', '/collab/timeline', async (ctx) => {
    const t = ctx.query.get('table') ?? ''
    const row = ctx.query.get('row') ?? ''
    if (!row) throw new HttpError(422, 'invalid', 'row is needed.')
    let tableRef = t
    if (!tableRef) tableRef = (await s.collab.findTableOfRow(row))?.id ?? ''
    if (!tableRef) throw new HttpError(404, 'not-found', 'Record not found.')
    return s.collab.timeline(ctx.user!, tableRef, row, { cursor: ctx.query.get('cursor'), limit: Number(ctx.query.get('limit') ?? 30) })
  }, { auth: 'user' })

  router.add('GET', '/collab/mentionable', async (ctx) => {
    const row = ctx.query.get('row') ?? ''
    const t = ctx.query.get('table') || (await s.collab.findTableOfRow(row))?.id || ''
    return { users: await s.collab.mentionable(ctx.user!, t, row, (ctx.query.get('q') ?? '').slice(0, 100)) }
  }, { auth: 'user' })

  router.add('POST', '/collab/follow', async (ctx) => {
    const b = body(ctx)
    const reg = await regarding(ctx, b)
    const follows = await table(SYS.follows)
    const mine = await s.data.query(ctx.user!, follows, { where: { and: [{ col: REGARDING.id, op: 'eq', value: String(reg[REGARDING.id]) }, { col: 'owner', op: 'eq', value: ctx.user!.user.id }] }, select: ['id'] })
    if (b.on === false) {
      if (mine.rows.length) await s.data.delete(ctx.user!, follows, mine.rows.map((r) => String(r.id)))
      return { following: false }
    }
    if (!mine.rows.length) await s.data.insert(ctx.user!, follows, { [REGARDING.table]: String(reg[REGARDING.table]), [REGARDING.id]: String(reg[REGARDING.id]) })
    return { following: true }
  }, { auth: 'user' })

  router.add('POST', '/collab/tags', async (ctx) => {
    const b = body(ctx)
    const reg = await regarding(ctx, b)
    const name = text(b.tag, 'The tag', 100)
    const tags = await table(SYS.tags)
    const links = await table(SYS.tagLinks)
    const found = await s.data.query(ctx.user!, tags, { where: { col: 'Name', op: 'eq', value: name }, select: ['Name'], top: 1 })
    let tagId = found.rows[0] ? String(found.rows[0].id) : ''
    const linked = tagId ? await s.data.query(ctx.user!, links, { where: { and: [{ col: 'Tag', op: 'eq', value: tagId }, { col: REGARDING.id, op: 'eq', value: String(reg[REGARDING.id]) }] }, select: ['id'] }) : { rows: [] }
    if (b.on === false) {
      if (linked.rows.length) await s.data.delete(ctx.user!, links, linked.rows.map((r) => String(r.id)))
      return { tagged: false }
    }
    if (!tagId) tagId = String((await s.data.insert(ctx.user!, tags, { Name: name })).id)
    if (!linked.rows.length) await s.data.insert(ctx.user!, links, { Tag: tagId, [REGARDING.table]: String(reg[REGARDING.table]), [REGARDING.id]: String(reg[REGARDING.id]) })
    return { tagged: true, tag: { id: tagId, name } }
  }, { auth: 'user' })

  router.add('GET', '/collab/my-tasks', async (ctx) => {
    const user = ctx.user!
    const acts = await table(SYS.activities)
    const all = ctx.query.get('status') === 'all'
    const limit = Math.max(1, Math.min(500, Number(ctx.query.get('limit') ?? 200) || 200))
    const teams = (user.user.org?.teams ?? []).map((t) => t.id)
    const mine: Condition[] = [{ col: 'AssignedTo', op: 'eq', value: user.user.id }]
    if (teams.length) mine.push({ col: 'AssignedTeam', op: 'in', value: teams })
    mine.push({ and: [{ col: 'AssignedTo', op: 'isBlank' }, { col: 'AssignedTeam', op: 'isBlank' }, { col: 'owner', op: 'eq', value: user.user.id }] })
    const where: Condition = { and: [{ col: 'Type', op: 'eq', value: 'Task' }, { or: mine }, ...(all ? [] : [{ col: 'Status', op: 'in', value: ['Open', 'In progress'] } as Condition])] }
    const res = await s.data.query(user, acts, { where, orderBy: [{ col: 'DueOn', dir: 'asc' }], top: limit })
    return { items: await withLabels(user, res.rows) }
  }, { auth: 'user' })

  router.add('GET', '/collab/mentions', async (ctx) => {
    const user = ctx.user!
    const mentions = await table(SYS.mentions)
    const limit = Math.max(1, Math.min(200, Number(ctx.query.get('limit') ?? 50) || 50))
    const res = await s.data.query(user, mentions, { where: { col: 'MentionedUser', op: 'eq', value: user.user.id }, orderBy: [{ col: 'createdOn', dir: 'desc' }], top: limit })
    const comments = await table(SYS.comments)
    const ids = res.rows.map((r) => String(r.Comment ?? '')).filter(Boolean)
    const bodies = ids.length ? await s.data.query(user, comments, { where: { col: 'id', op: 'in', value: ids }, select: ['Body', 'Link', 'createdBy'], top: 500 }) : { rows: [] }
    const byId = new Map(bodies.rows.map((r) => [String(r.id), r]))
    const people = new Map<string, string>()
    for (const r of bodies.rows) {
      const by = String(r.createdBy ?? '')
      if (by && !people.has(by)) people.set(by, (await s.meta.users.get(by))?.name ?? '')
    }
    const items = (await withLabels(user, res.rows)).map((r) => {
      const cm = byId.get(String(r.Comment ?? ''))
      return { ...r, Body: cm?.Body ?? null, Link: cm?.Link ?? null, byName: cm ? people.get(String(cm.createdBy ?? '')) ?? null : null }
    })
    return { items }
  }, { auth: 'user' })

  /** regarding labels for rows the user can see (unreadable records stay unnamed) */
  async function withLabels(user: UserContext, list: Record<string, unknown>[]) {
    const labels = await s.collab.regardingLabels(user, list.map((r) => ({ table: String(r[REGARDING.table] ?? ''), id: String(r[REGARDING.id] ?? '') })))
    return list.map((r) => {
      const l = labels.get(`${String(r[REGARDING.table] ?? '')}:${String(r[REGARDING.id] ?? '')}`)
      return l ? { ...r, regardingLabel: l.label, regardingTableName: l.tableName } : r
    })
  }
}
