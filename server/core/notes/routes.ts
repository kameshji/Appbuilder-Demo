/**
 * Notes routes (P3 package N; docs/dev/notes.md). Every signed-in user; what a person sees is decided by the security
 * engine (every read goes through the DataService as the caller), never here. Notes are written through the normal data
 * API (Activities with Type Note, `ifModifiedOn` for the version check) and shared through ActivityShares.
 *
 *   GET  /notes?view=all|mine|shared|records|pinned&q=&limit=   summaries (title, snippet, who, when; never the body)
 *   GET  /notes/:id                                             one note, what the caller may do, its shares, pinned
 *   POST /notes/:id/cards                                       the record cards of its body, resolved for the caller
 *   PUT  /notes/:id/pin        { on }                           pin or unpin (per person)
 *   POST /notes/:id/readers    { userIds }                      which of these people can open it (the mention's share offer)
 * A note the caller may not read answers 404 "Note not found." everywhere, exactly like a missing one.
 */
import { HttpError } from '../contracts.ts'
import type { Ctx, UserContext } from '../contracts.ts'
import type { ApiRouter } from '../router.ts'
import type { CoreServices } from '../services.ts'
import type { Condition } from '../../../src/platform/http.ts'
import { REGARDING, SYS } from '../../../src/platform/system-tables.ts'
import type { ChatCardView } from '../../../src/platform/chat-protocol.ts'
import { noteRecordRefs, noteToPlain } from '../../../src/notes/sanitize.ts'
import { matchesAll, searchTerms, snippet } from '../../../src/notes/logic.ts'
import { currentEnvironment } from '../env-context.ts'
import { resolveCardRef } from '../chat/cards.ts'
import { createNotes } from './service.ts'

export const NOTES_LIST_MAX = 200
/** record cards resolved per request */
export const NOTE_CARDS_MAX = 30

const notFound = () => new HttpError(404, 'not-found', 'Note not found.')
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const iso = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString())
function body(ctx: Ctx): Record<string, unknown> {
  const b = ctx.body
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(422, 'invalid', 'Request body must be a JSON object.')
  return b as Record<string, unknown>
}

export function notesRoutes(router: ApiRouter, s: CoreServices): void {
  const notes = createNotes(s)
  notes.register()
  const names = new Map<string, string>()
  const nameOf = async (id: string): Promise<string | null> => {
    if (!id) return null
    if (!names.has(id)) names.set(id, (await s.meta.users.get(id))?.name ?? '')
    if (names.size > 2000) names.clear()
    return names.get(id) || null
  }

  /** the share rows the caller may read that are for them or one of their teams */
  async function sharedWithMe(user: UserContext): Promise<Map<string, 'read' | 'edit'>> {
    const shares = (await s.meta.tables.list()).find((t) => t.id === SYS.activityShares)
    if (!shares) return new Map()
    const teams = (user.user.org?.teams ?? []).map((t) => t.id)
    const who: Condition[] = [{ and: [{ col: 'PrincipalType', op: 'eq', value: 'user' }, { col: 'Principal', op: 'eq', value: user.user.id }] }]
    if (teams.length) who.push({ and: [{ col: 'PrincipalType', op: 'eq', value: 'team' }, { col: 'Principal', op: 'in', value: teams }] })
    const res = await s.data.query(user, shares, { where: { or: who }, select: ['Activity', 'Access'], top: 5000 })
    const out = new Map<string, 'read' | 'edit'>()
    for (const r of res.rows) {
      const a = str(r.Activity)
      if (out.get(a) !== 'edit') out.set(a, str(r.Access) === 'edit' ? 'edit' : 'read')
    }
    return out
  }

  router.add('GET', '/notes', async (ctx) => {
    const user = ctx.user!
    const me = user.user.id
    const view = ctx.query.get('view') || 'all'
    if (!['all', 'mine', 'shared', 'records', 'pinned'].includes(view)) throw new HttpError(422, 'invalid', 'view is one of all, mine, shared, records, pinned.', 'view')
    const search = (ctx.query.get('q') ?? '').trim().slice(0, 200)
    const limit = Math.max(1, Math.min(NOTES_LIST_MAX, Math.trunc(Number(ctx.query.get('limit') ?? 100)) || 100))
    const acts = await notes.table(SYS.activities)
    const conds: Condition[] = [{ col: 'Type', op: 'eq', value: 'Note' }]
    const shared = await sharedWithMe(user)
    const pinned = await notes.pins(me)
    if (view === 'mine') conds.push({ col: 'owner', op: 'eq', value: me })
    if (view === 'records') conds.push({ col: REGARDING.id, op: 'notBlank' })
    if (view === 'shared' || view === 'pinned') {
      const ids = [...(view === 'shared' ? shared.keys() : pinned)].slice(0, 1000)
      if (!ids.length) return { items: [], view }
      conds.push({ col: 'id', op: 'in', value: ids })
      if (view === 'shared') conds.push({ col: 'owner', op: 'ne', value: me })
    }
    // Query v2 search on the title and the body; the words are checked again on the plain text (not the markup)
    for (const term of searchTerms(search)) conds.push({ or: [{ col: 'Subject', op: 'contains', value: term }, { col: 'Body', op: 'contains', value: term }] })
    const res = await s.data.query(user, acts, {
      where: { and: conds }, select: ['Subject', 'Body', 'owner', 'createdBy', 'createdOn', 'modifiedOn', REGARDING.table, REGARDING.id, 'Files'],
      orderBy: [{ col: 'modifiedOn', dir: 'desc' }], top: search ? Math.min(1000, limit * 5) : limit,
    })
    const rows = res.rows.map((r) => ({ r, text: noteToPlain(str(r.Body)) })).filter((x) => !search || matchesAll(str(x.r.Subject), x.text, search)).slice(0, limit)
    const labels = await s.collab.regardingLabels(user, rows.map(({ r }) => ({ table: str(r[REGARDING.table]), id: str(r[REGARDING.id]) })))
    const items = []
    for (const { r, text } of rows) {
      const id = str(r.id)
      const l = labels.get(`${str(r[REGARDING.table])}:${str(r[REGARDING.id])}`)
      let files = 0
      try { files = r.Files ? (JSON.parse(String(r.Files)) as unknown[]).length : 0 } catch { files = r.Files ? 1 : 0 }
      items.push({
        id, title: str(r.Subject), snippet: snippet(text, search, 160), createdOn: iso(r.createdOn), modifiedOn: iso(r.modifiedOn),
        owner: str(r.owner) || null, ownerName: await nameOf(str(r.owner)), mine: str(r.owner) === me, pinned: pinned.has(id),
        sharedWithMe: shared.get(id) ?? null, files,
        ...(l ? { regarding: { table: l.table, id: str(r[REGARDING.id]), label: l.label, tableName: l.tableName } } : str(r[REGARDING.id]) ? { regarding: { table: str(r[REGARDING.table]), id: str(r[REGARDING.id]), label: null, tableName: null } } : {}),
      })
    }
    return { items, view }
  }, { auth: 'user' })

  router.add('GET', '/notes/:id', async (ctx) => {
    const user = ctx.user!
    const row = await notes.readNote(user, ctx.params.id)
    if (!row) throw notFound()
    const id = str(row.id)
    const shares = (await s.meta.tables.list()).find((t) => t.id === SYS.activityShares)
    const shareRows = shares ? (await s.data.query(user, shares, { where: { col: 'Activity', op: 'eq', value: id }, select: ['PrincipalType', 'Principal', 'Access'], top: 500 })).rows : []
    const teams = shareRows.some((r) => r.PrincipalType === 'team') ? (await s.meta.tables.list()).find((t) => t.id === SYS.teams) : undefined
    const teamNames = new Map<string, string>()
    if (teams) {
      const ids = shareRows.filter((r) => r.PrincipalType === 'team').map((r) => str(r.Principal))
      const tr = await s.data.query(user, teams, { where: { col: 'id', op: 'in', value: ids }, top: 500 })
      for (const t of tr.rows) teamNames.set(str(t.id), str(t.Name ?? t[teams.primaryColumn] ?? t.id))
    }
    const reg = str(row[REGARDING.id]) ? (await s.collab.regardingLabels(user, [{ table: str(row[REGARDING.table]), id: str(row[REGARDING.id]) }])).get(`${str(row[REGARDING.table])}:${str(row[REGARDING.id])}`) : undefined
    const me = user.user.id
    return {
      note: {
        id, Subject: str(row.Subject), Body: str(row.Body), Files: row.Files ?? null, owner: str(row.owner) || null, createdBy: str(row.createdBy) || null,
        createdOn: iso(row.createdOn), modifiedOn: iso(row.modifiedOn), [REGARDING.table]: str(row[REGARDING.table]) || null, [REGARDING.id]: str(row[REGARDING.id]) || null,
      },
      version: iso(row.modifiedOn),
      ownerName: await nameOf(str(row.owner)),
      canEdit: await notes.canUpdate(user, id),
      isOwner: str(row.owner) === me || user.privileges.isAdmin,
      pinned: (await notes.pins(me)).has(id),
      regarding: str(row[REGARDING.id]) ? { table: reg?.table ?? str(row[REGARDING.table]), id: str(row[REGARDING.id]), label: reg?.label ?? null, tableName: reg?.tableName ?? null } : null,
      shares: await Promise.all(shareRows.map(async (r) => ({
        id: str(r.id), PrincipalType: str(r.PrincipalType), Principal: str(r.Principal), Access: str(r.Access),
        name: r.PrincipalType === 'team' ? teamNames.get(str(r.Principal)) ?? null : await nameOf(str(r.Principal)),
      }))),
    }
  }, { auth: 'user' })

  router.add('POST', '/notes/:id/cards', async (ctx) => {
    const user = ctx.user!
    const row = await notes.readNote(user, ctx.params.id)
    if (!row) throw notFound()
    const refs = noteRecordRefs(str(row.Body)).slice(0, NOTE_CARDS_MAX)
    const env = currentEnvironment().id
    const cards: Record<string, ChatCardView> = {}
    for (const ref of refs) {
      const [table, rowId] = ref.split(':')
      // the same per-reader resolution as chat cards: the reader's own access to the record decides
      cards[ref] = await resolveCardRef(s, user.user.id, { kind: 'record', env, table, row: rowId, fields: [] })
    }
    return { cards }
  }, { auth: 'user' })

  router.add('PUT', '/notes/:id/pin', async (ctx) => {
    const user = ctx.user!
    const b = body(ctx)
    const row = await notes.readNote(user, ctx.params.id)
    if (!row) throw notFound()
    await notes.setPin(user.user.id, str(row.id), b.on !== false)
    return { pinned: b.on !== false }
  }, { auth: 'user' })

  router.add('POST', '/notes/:id/readers', async (ctx) => {
    const user = ctx.user!
    const b = body(ctx)
    const row = await notes.readNote(user, ctx.params.id)
    if (!row) throw notFound()
    const ids = Array.isArray(b.userIds) ? b.userIds.filter((x): x is string => typeof x === 'string' && x.length <= 64).slice(0, 50) : []
    const { ok, refused } = await s.collab.readersOf(await notes.table(SYS.activities), str(row.id), ids)
    return { readers: ok.map((u) => u.id), notReaders: refused.map((u) => u.id) }
  }, { auth: 'user' })
}
