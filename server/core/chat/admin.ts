/**
 * Chat administration (P3-A; docs/admin/chat.md): settings, conversation metadata, moderation, reports, read-only people,
 * the audited and announced export of one conversation, and retention.
 *
 * What administrators can and cannot see: channel names, kinds, members, counts and dates of every conversation; the text
 * of a message a member REPORTED to them (the reporter chose to show it); a conversation they EXPORT with a typed reason
 * (audited `chat.export`, and a system message tells its members). Never message text through generic queries, the
 * environment data export or a backup's table browser. Audit entries keep who, when, which conversation and which
 * message id, never message text.
 */
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { HttpError } from '../contracts.ts'
import type { AttachmentRecord, RawResponse } from '../contracts.ts'
import type { CoreServices } from '../services.ts'
import { runInEnvironment, environmentSchema } from '../env-context.ts'
import { errText, log, uid } from '../util.ts'
import { SYS } from '../../../src/platform/system-tables.ts'
import type { ChatKind } from '../../../src/platform/chat-protocol.ts'
import { ZipStream } from '../export-data.ts'
import { CHAT_SYSTEM_TABLES } from './ddl.ts'
import { chatMessageCount, checkChatSettingsChange, loadChatSettings, saveChatSettings } from './settings.ts'
import type { ChatSettings } from './settings.ts'
import type { ChatCx, ChatEnv, ChatService } from './service.ts'
import { parseJsonList } from './format.ts'

type Row = Record<string, unknown>
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const num = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v))
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null)
const invalid = (message: string, field?: string) => new HttpError(422, 'invalid', message, field)

export const EXPORT_TTL_MS = 60 * 60 * 1000

export function createChatAdmin(s: CoreServices, chat: ChatService) {
  const db = () => {
    const d = s.state.db
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }
  const T = chat.T

  function admin(cx: ChatCx): void {
    if (!cx.isAdmin) throw new HttpError(403, 'denied', 'Only administrators of the chat environment can do this.')
  }

  /** every administrator action is audited in the chat environment: who, when, what (never message text) */
  async function audit(cx: ChatCx, action: string, details: Record<string, unknown>, rowId?: string): Promise<void> {
    try {
      await runInEnvironment(cx.env.id, () => s.meta.audit({ userId: cx.id, action, tableId: rowId ? SYS.channels : undefined, rowId, details }))
    } catch (e) {
      log('error', `audit write failed (${action}): ${errText(e)}`)
    }
  }

  /* -------------------------------------------------------------- settings */

  async function settingsView(cx: ChatCx): Promise<Record<string, unknown>> {
    admin(cx)
    const st = await loadChatSettings(db())
    const map = await chat.people()
    return {
      environmentId: st.environmentId, createChannels: st.createChannels, retention: st.retention,
      readOnly: st.readOnly.map((id) => ({ id, name: map.get(id)?.name ?? 'Someone' })),
      canChangeEnvironment: cx.isInstallAdmin, messages: await chatMessageCount(db(), cx.env.schema),
    }
  }

  async function saveSettings(cx: ChatCx, b: Record<string, unknown>): Promise<Record<string, unknown>> {
    admin(cx)
    const cur = await loadChatSettings(db())
    const next: ChatSettings = checkChatSettingsChange(cur, b)
    if (b.environmentId !== undefined && b.environmentId !== cur.environmentId) {
      if (!cx.isInstallAdmin) throw new HttpError(403, 'denied', 'Only install administrators can move chat to another environment.')
      const target = typeof b.environmentId === 'string' ? await s.install.environments.get(b.environmentId).catch(() => null) : null
      if (!target || target.state !== 'ready') throw invalid('There is no ready environment with that id.', 'environmentId')
      if ((await chatMessageCount(db(), cx.env.schema)) > 0) throw new HttpError(409, 'conflict', 'Chat already holds messages: the chat environment can only be changed while chat is empty (moving history is not built).', 'environmentId')
      next.environmentId = target.id
    }
    await saveChatSettings(db(), next)
    await audit(cx, 'chat.settings', {
      ...(next.environmentId !== cur.environmentId ? { environment: { before: cur.environmentId, after: next.environmentId } } : {}),
      ...(next.createChannels !== cur.createChannels ? { createChannels: { before: cur.createChannels, after: next.createChannels } } : {}),
      ...(JSON.stringify(next.retention) !== JSON.stringify(cur.retention) ? { retention: { before: cur.retention, after: next.retention } } : {}),
    })
    if (next.environmentId !== cur.environmentId) {
      // the new chat environment's administrators see the change too
      await runInEnvironment(next.environmentId, () => s.meta.audit({ userId: cx.id, action: 'chat.settings', details: { environment: { before: cur.environmentId, after: next.environmentId } } })).catch(() => undefined)
    }
    return settingsView({ ...cx, settings: next })
  }

  async function setReadOnly(cx: ChatCx, b: Record<string, unknown>): Promise<{ readOnly: boolean }> {
    admin(cx)
    const userId = typeof b.userId === 'string' ? b.userId : ''
    if (!(await chat.chatUsers(cx.env, [userId])).has(userId)) throw invalid('That person does not use chat.', 'userId')
    if (userId === cx.id) throw invalid('You cannot make yourself read-only.', 'userId')
    const on = b.readOnly !== false
    const cur = await loadChatSettings(db())
    const set = new Set(cur.readOnly)
    if (on) set.add(userId)
    else set.delete(userId)
    await saveChatSettings(db(), { ...cur, readOnly: [...set] })
    await audit(cx, 'chat.readonly', { user: userId, readOnly: on })
    return { readOnly: on }
  }

  /* -------------------------------------------------------------- conversations (metadata only) */

  async function channels(cx: ChatCx, o: { q?: string | null; kind?: string | null; offset?: number }): Promise<{ items: Record<string, unknown>[]; more: boolean }> {
    admin(cx)
    const params: unknown[] = []
    const where: string[] = []
    if (o.kind && ['channel', 'direct', 'group'].includes(o.kind)) {
      params.push(o.kind)
      where.push(`c."Kind" = $${params.length}`)
    }
    if (o.q) {
      params.push(`%${o.q.toLowerCase().replace(/[%_\\]/g, (m) => `\\${m}`)}%`)
      where.push(`lower(c."Name") LIKE $${params.length}`)
    }
    const offset = Math.max(0, Math.min(1_000_000, Math.trunc(o.offset ?? 0) || 0))
    const rows = await db().query<Row>(
      `SELECT c.id, c."Kind", c."Name", c."Description", c."IsPrivate", c."ArchivedOn", c."LastMessageOn", c."createdOn", c."createdBy",
              (SELECT count(*)::int FROM ${T(cx.env, SYS.channelMembers)} m WHERE m."Channel" = c.id) AS members,
              (SELECT count(*)::int FROM ${T(cx.env, SYS.messages)} x WHERE x."Channel" = c.id AND x."Kind" = 'message') AS messages,
              (SELECT count(*)::int FROM ${T(cx.env, 'ab_chat_reports')} r WHERE r.channel_id = c.id AND r.state = 'open') AS reports
         FROM ${T(cx.env, SYS.channels)} c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY c."LastMessageOn" DESC NULLS LAST, c."createdOn" DESC, c.id LIMIT 201 OFFSET ${offset}`, params,
    )
    const map = await chat.people()
    const small = rows.filter((r) => r.Kind !== 'channel').map((r) => str(r.id))
    const who = new Map<string, string[]>()
    if (small.length) {
      for (const m of await db().query<Row>(`SELECT "Channel", "User" FROM ${T(cx.env, SYS.channelMembers)} WHERE "Channel" = ANY($1::text[]) ORDER BY "JoinedOn", id`, [small])) {
        who.set(str(m.Channel), [...(who.get(str(m.Channel)) ?? []), map.get(str(m.User))?.name ?? 'Someone'])
      }
    }
    return {
      items: rows.slice(0, 200).map((r) => ({
        id: str(r.id), kind: str(r.Kind) as ChatKind, name: r.Kind === 'channel' ? str(r.Name) : (who.get(str(r.id)) ?? []).join(', '), description: r.Kind === 'channel' ? str(r.Description) : '',
        isPrivate: r.IsPrivate !== false, archived: !!r.ArchivedOn, lastMessageOn: iso(r.LastMessageOn), createdOn: iso(r.createdOn), createdBy: map.get(str(r.createdBy))?.name ?? null,
        members: num(r.members), messages: num(r.messages), openReports: num(r.reports),
      })),
      more: rows.length > 200,
    }
  }

  async function channelMembers(cx: ChatCx, channelId: string): Promise<{ id: string; name: string; role: string; joinedOn: string | null }[]> {
    admin(cx)
    const c = await chat.adminConv(db(), cx.env, channelId)
    const map = await chat.people()
    return (await chat.membersOf(db(), cx.env, str(c.ch.id))).map((m) => ({ id: m.user, name: map.get(m.user)?.name ?? 'Someone', role: m.role, joinedOn: m.joinedOn }))
  }

  async function archive(cx: ChatCx, channelId: string, archived: boolean): Promise<{ archived: boolean }> {
    admin(cx)
    const r = await chat.setArchived(cx, channelId, archived, { asAdmin: true })
    if (r.seq) await audit(cx, 'chat.channel.archive', { channel: channelId.toLowerCase(), archived }, channelId.toLowerCase())
    return { archived }
  }

  async function removeMember(cx: ChatCx, channelId: string, userId: string): Promise<{ removed: boolean }> {
    admin(cx)
    const r = await chat.removeMember(cx, cx.env, channelId, userId, { asAdmin: { id: cx.id } })
    if (r.removed) await audit(cx, 'chat.member.remove', { channel: channelId.toLowerCase(), user: userId }, channelId.toLowerCase())
    return r
  }

  /** deletes a conversation for good: its messages, reactions, mentions, members and files (confirm: the channel's name, or "delete") */
  async function deleteChannel(cx: ChatCx, channelId: string, b: Record<string, unknown>): Promise<{ deleted: true; messages: number; files: number }> {
    admin(cx)
    const d = db()
    const c0 = await chat.adminConv(d, cx.env, channelId)
    const kind = str(c0.ch.Kind)
    const want = kind === 'channel' ? str(c0.ch.Name) : 'delete'
    if (typeof b.confirm !== 'string' || b.confirm.trim() !== want) throw invalid(kind === 'channel' ? `Type the channel's name ("${want}") to confirm.` : 'Type "delete" to confirm.', 'confirm')
    const id = str(c0.ch.id)
    const members = (await chat.membersOf(d, cx.env, id)).map((m) => m.user)
    let files: AttachmentRecord[] = []
    let messages = 0
    await d.tx(async (tx) => {
      await chat.adminConv(tx, cx.env, id, true)
      const atts = await tx.query<{ id: string }>(`SELECT id FROM ${T(cx.env, 'ab_attachments')} WHERE table_id = $1 AND (row_id IN (SELECT id FROM ${T(cx.env, SYS.messages)} WHERE "Channel" = $2) OR row_id = $3)`, [SYS.messages, id, `draft-${id}`])
      files = await s.meta.attachments.many(atts.map((a) => a.id))
      await tx.exec(`DELETE FROM ${T(cx.env, SYS.messageReactions)} WHERE "Message" IN (SELECT id FROM ${T(cx.env, SYS.messages)} WHERE "Channel" = $1)`, [id])
      await tx.exec(`DELETE FROM ${T(cx.env, SYS.mentions)} WHERE "regardingTable" = $1 AND "regardingId" IN (SELECT id FROM ${T(cx.env, SYS.messages)} WHERE "Channel" = $2)`, [SYS.messages, id])
      messages = (await tx.exec(`DELETE FROM ${T(cx.env, SYS.messages)} WHERE "Channel" = $1`, [id])).affectedRows
      await tx.exec(`DELETE FROM ${T(cx.env, SYS.channelMembers)} WHERE "Channel" = $1`, [id])
      await tx.exec(`DELETE FROM ${T(cx.env, 'ab_chat_reports')} WHERE channel_id = $1`, [id])
      await tx.exec(`DELETE FROM ${T(cx.env, SYS.channels)} WHERE id = $1`, [id])
    })
    if (files.length) await runInEnvironment(cx.env.id, () => s.data.internals.removeAttachments(files)).catch((e) => log('warn', `chat: removing files failed: ${errText(e)}`))
    await audit(cx, 'chat.channel.delete', { channel: id, kind, ...(kind === 'channel' ? { name: str(c0.ch.Name) } : {}), messages, files: files.length }, id)
    chat.accessChanged(id)
    chat.pushChannels(members, id, 'removed')
    chat.touched(cx.env, 'channel')
    return { deleted: true, messages, files: files.length }
  }

  /* -------------------------------------------------------------- moderation and reports */

  async function moderate(cx: ChatCx, messageId: string, b: Record<string, unknown>): Promise<{ deleted: true }> {
    admin(cx)
    const r = await chat.removeMessage(cx, cx.env, messageId, { asAdmin: { id: cx.id } })
    const note = typeof b.note === 'string' ? b.note.trim().slice(0, 500) : ''
    await db().exec(`UPDATE ${T(cx.env, 'ab_chat_reports')} SET state = 'handled', outcome = 'deleted', handled_by = $2, handled_on = now() WHERE message_id = $1 AND state = 'open'`, [messageId.toLowerCase(), cx.id])
    await audit(cx, 'chat.message.moderate', { channel: r.channelId, message: messageId.toLowerCase(), ...(note ? { note } : {}) }, r.channelId)
    return { deleted: true }
  }

  async function reports(cx: ChatCx, state: string | null): Promise<{ items: Record<string, unknown>[] }> {
    admin(cx)
    const st = state === 'handled' || state === 'all' ? state : 'open'
    const rows = await db().query<Row>(
      `SELECT r.*, m."BodyText" AS text, m."createdBy" AS sender, m."DeletedOn" AS deleted, m."createdOn" AS sent, c."Name" AS channel_name, c."Kind" AS channel_kind
         FROM ${T(cx.env, 'ab_chat_reports')} r LEFT JOIN ${T(cx.env, SYS.messages)} m ON m.id = r.message_id LEFT JOIN ${T(cx.env, SYS.channels)} c ON c.id = r.channel_id
        ${st === 'all' ? '' : 'WHERE r.state = $1'} ORDER BY r.created_on DESC LIMIT 500`, st === 'all' ? [] : [st],
    )
    const map = await chat.people()
    return {
      items: rows.map((r) => ({
        id: str(r.id), state: str(r.state), outcome: r.outcome ? str(r.outcome) : null, reason: str(r.reason), createdOn: iso(r.created_on),
        reporter: { id: str(r.reporter_id), name: map.get(str(r.reporter_id))?.name ?? 'Someone' },
        // the reported message's text: the reporter chose to show it to the administrators (docs/admin/chat.md)
        message: { id: str(r.message_id), text: r.deleted ? '' : str(r.text), deleted: !!r.deleted, sentOn: iso(r.sent), sender: r.sender ? { id: str(r.sender), name: map.get(str(r.sender))?.name ?? 'Someone' } : null },
        channel: { id: str(r.channel_id), kind: str(r.channel_kind), name: r.channel_kind === 'channel' ? str(r.channel_name) : '' },
        handledBy: r.handled_by ? map.get(str(r.handled_by))?.name ?? null : null, handledOn: iso(r.handled_on),
      })),
    }
  }

  async function handleReport(cx: ChatCx, reportId: string, b: Record<string, unknown>): Promise<{ state: string; outcome: string }> {
    admin(cx)
    const r = (await db().query<Row>(`SELECT * FROM ${T(cx.env, 'ab_chat_reports')} WHERE id = $1`, [reportId]))[0]
    if (!r) throw new HttpError(404, 'not-found', 'Report not found.')
    const action = b.action === 'delete' ? 'delete' : b.action === 'dismiss' ? 'dismiss' : null
    if (!action) throw invalid('action is delete (the message) or dismiss.', 'action')
    if (action === 'delete') await chat.removeMessage(cx, cx.env, str(r.message_id), { asAdmin: { id: cx.id } }).catch((e) => { if (!(e instanceof HttpError && e.status === 404)) throw e })
    const outcome = action === 'delete' ? 'deleted' : 'dismissed'
    await db().exec(`UPDATE ${T(cx.env, 'ab_chat_reports')} SET state = 'handled', outcome = $2, handled_by = $3, handled_on = now() WHERE ${action === 'delete' ? 'message_id = (SELECT message_id FROM ' + T(cx.env, 'ab_chat_reports') + ' WHERE id = $1) AND state = \'open\'' : 'id = $1'}`, [reportId, outcome, cx.id])
    await audit(cx, 'chat.report.handle', { report: reportId, message: str(r.message_id), channel: str(r.channel_id), outcome }, str(r.channel_id))
    return { state: 'handled', outcome }
  }

  /* -------------------------------------------------------------- export of one conversation */

  const hash = (t: string) => createHash('sha256').update(t).digest('hex')

  /** creates an export (typed reason, recent sign-in checked by the route), tells the members, audits it; the download link works for an hour */
  async function createExport(cx: ChatCx, channelId: string, b: Record<string, unknown>): Promise<{ id: string; url: string; expiresOn: string }> {
    admin(cx)
    // a read-only install still exports (hosting-spec.md); the announcement below is made all the same
    const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 1000) : ''
    if (reason.length < 10) throw invalid('Type the reason for this export (at least 10 characters). It is kept in the audit log.', 'reason')
    const d = db()
    const c0 = await chat.adminConv(d, cx.env, channelId)
    const id = uid('cex')
    const token = randomBytes(24).toString('base64url')
    const expires = new Date(Date.now() + EXPORT_TTL_MS)
    let seq = 0
    let sysId = ''
    const stats = await d.tx(async (tx) => {
      await chat.adminConv(tx, cx.env, str(c0.ch.id), true)
      const n = await tx.query<{ m: number; f: number }>(
        `SELECT count(*)::int AS m, COALESCE(sum(CASE WHEN "Files" IS NULL THEN 0 ELSE json_array_length("Files"::json) END), 0)::int AS f FROM ${T(cx.env, SYS.messages)} WHERE "Channel" = $1`, [c0.ch.id],
      )
      await tx.exec(`INSERT INTO ${T(cx.env, 'ab_chat_exports')} (id, channel_id, reason, by_id, created_on, token_hash, expires_on, messages, files) VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8)`,
        [id, c0.ch.id, reason, cx.id, hash(token), expires, Number(n[0]?.m ?? 0), Number(n[0]?.f ?? 0)])
      seq = await chat.nextSeq(tx, cx.env, str(c0.ch.id))
      sysId = await chat.systemMessage(tx, cx.env, str(c0.ch.id), seq, `An administrator exported this conversation on ${new Date().toISOString().slice(0, 10)}.`, { type: 'export', byAdmin: true, on: new Date().toISOString() })
      return { messages: Number(n[0]?.m ?? 0), files: Number(n[0]?.f ?? 0) }
    })
    await chat.publish(cx.env, str(c0.ch.id), seq, 'channel', sysId)
    await audit(cx, 'chat.export', { channel: str(c0.ch.id), kind: str(c0.ch.Kind), reason, export: id, messages: stats.messages, files: stats.files }, str(c0.ch.id))
    return { id, url: `/api/v1/chat/admin/exports/${id}/download?token=${token}`, expiresOn: expires.toISOString() }
  }

  async function listExports(cx: ChatCx): Promise<{ items: Record<string, unknown>[] }> {
    admin(cx)
    const rows = await db().query<Row>(`SELECT e.*, c."Name" AS channel_name, c."Kind" AS channel_kind FROM ${T(cx.env, 'ab_chat_exports')} e LEFT JOIN ${T(cx.env, SYS.channels)} c ON c.id = e.channel_id ORDER BY e.created_on DESC LIMIT 200`)
    const map = await chat.people()
    return {
      items: rows.map((r) => ({
        id: str(r.id), channel: { id: str(r.channel_id), kind: str(r.channel_kind), name: r.channel_kind === 'channel' ? str(r.channel_name) : '' }, reason: str(r.reason),
        by: map.get(str(r.by_id))?.name ?? 'Someone', createdOn: iso(r.created_on), expiresOn: iso(r.expires_on), downloadedOn: iso(r.downloaded_on), messages: num(r.messages), files: num(r.files),
      })),
    }
  }

  /** the ZIP: transcript.html (every message, system lines and deleted ones as such) and the files; only the exporting administrator, within the hour */
  async function download(cx: ChatCx, exportId: string, token: string | null): Promise<RawResponse> {
    admin(cx)
    const d = db()
    const e = (await d.query<Row>(`SELECT * FROM ${T(cx.env, 'ab_chat_exports')} WHERE id = $1`, [exportId]))[0]
    if (!e || !token || hash(token) !== str(e.token_hash) || str(e.by_id) !== cx.id) throw new HttpError(404, 'not-found', 'Export not found.')
    if (new Date(e.expires_on as string).getTime() < Date.now()) throw new HttpError(410, 'invalid', 'This export link has expired. Export the conversation again.')
    const c = await chat.adminConv(d, cx.env, str(e.channel_id))
    await d.exec(`UPDATE ${T(cx.env, 'ab_chat_exports')} SET downloaded_on = now() WHERE id = $1`, [exportId])
    await audit(cx, 'chat.export.download', { channel: str(c.ch.id), export: exportId }, str(c.ch.id))
    const env = cx.env
    const rows = await d.query<Row>(`SELECT * FROM ${T(env, SYS.messages)} WHERE "Channel" = $1 ORDER BY "Seq" ASC`, [c.ch.id])
    const views = await chat.messageViews(d, env, rows)
    const map = await chat.people()
    const members = await chat.membersOf(d, env, str(c.ch.id))
    const fileIds = [...new Set(rows.flatMap((r) => parseJsonList(r.Files).map(String)))]
    const recs = fileIds.length ? (await s.meta.attachments.many(fileIds)).filter((a) => a.tableId === SYS.messages) : []
    const title = str(c.ch.Kind) === 'channel' ? `#${str(c.ch.Name)}` : members.map((m) => map.get(m.user)?.name ?? 'Someone').join(', ')
    const h = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const fileName = (a: AttachmentRecord) => `files/${a.id}-${a.fileName.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120)}`
    const byId = new Map(recs.map((a) => [a.id, a]))
    const lines = views.map((m) => {
      const when = h(m.createdOn.replace('T', ' ').slice(0, 19))
      if (m.kind === 'system') return `<p class="sys">${when} &middot; ${h(m.text)}</p>`
      const who = h(m.sender?.name ?? 'Someone')
      if (m.deleted) return `<p class="del">${when} &middot; ${who}: message deleted${m.moderated ? ' by an administrator' : ''}</p>`
      const files = m.files.map((f) => { const a = byId.get(f.id); return a ? `<li><a href="${h(fileName(a))}">${h(f.name)}</a></li>` : '' }).join('')
      const cards = m.cards.length ? `<p class="card">${m.cards.length} shared item(s) (not included: each reader sees them with their own access)</p>` : ''
      return `<div class="msg${m.parentId ? ' reply' : ''}"><p class="meta">${when} &middot; <b>${who}</b>${m.editedOn ? ' (edited)' : ''}${m.parentId ? ' (reply)' : ''}</p><div>${m.body}</div>${files ? `<ul>${files}</ul>` : ''}${cards}</div>`
    }).join('\n')
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${h(title)}</title><style>body{font-family:sans-serif;max-width:800px;margin:24px auto;color:#0f172a}.sys,.del{color:#64748b;font-size:13px}.meta{color:#475569;font-size:13px;margin:12px 0 2px}.reply{margin-left:32px}.card{color:#64748b;font-size:13px}</style></head><body>
<h1>${h(title)}</h1><p>Exported on ${h(new Date().toISOString().slice(0, 10))} by an administrator. Reason: ${h(str(e.reason))}</p>
<p>Members: ${h(members.map((m) => map.get(m.user)?.name ?? 'Someone').join(', '))}</p><hr>
${lines}
</body></html>`
    const stream = Readable.from((async function* () {
      const zip = new ZipStream()
      yield* zip.entry('transcript.html', (async function* () { yield html })())
      for (const a of recs) {
        yield* zip.entry(fileName(a), runInEnvironment(env.id, () => s.attachments.open(a.storageKey)) as unknown as AsyncIterable<Buffer>)
      }
      yield* zip.finish()
    })())
    const stamp = new Date().toISOString().slice(0, 10)
    return { raw: true, headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="chat-export-${stamp}.zip"`, 'Cache-Control': 'no-store' }, body: stream }
  }

  /* -------------------------------------------------------------- retention */

  /**
   * Removes messages older than the retention period of their conversation's kind (a thread goes with its first message),
   * with their reactions, mentions and files; raises the conversation's PurgedSeq (clients below it reload) and pushes a
   * `channel` change. Also removes draft files older than a day. Paused while the install is read-only.
   */
  async function runRetention(now = new Date()): Promise<{ messages: number; files: number; channels: number; paused?: string }> {
    if (chat.installReadOnly()) return { messages: 0, files: 0, channels: 0, paused: 'The install is read-only: retention waits.' }
    const d = db()
    const st = await loadChatSettings(d)
    const env: ChatEnv = { id: st.environmentId, schema: environmentSchema(st.environmentId) }
    let messages = 0
    let fileCount = 0
    let channelsTouched = 0
    for (const kind of ['channel', 'direct', 'group'] as ChatKind[]) {
      const days = st.retention[kind]
      if (!days) continue
      const cutoff = new Date(now.getTime() - days * 86_400_000)
      const chans = await d.query<{ id: string }>(
        `SELECT DISTINCT m."Channel" AS id FROM ${T(env, SYS.messages)} m JOIN ${T(env, SYS.channels)} c ON c.id = m."Channel" WHERE c."Kind" = $1 AND m."createdOn" < $2 AND m."ParentMessage" IS NULL`, [kind, cutoff],
      )
      for (const ch of chans) {
        let seq = 0
        let recs: AttachmentRecord[] = []
        await d.tx(async (tx) => {
          await tx.query(`SELECT id FROM ${T(env, SYS.channels)} WHERE id = $1 FOR UPDATE`, [ch.id])
          const old = await tx.query<{ id: string; Files: string | null }>(
            `SELECT id, "Files" FROM ${T(env, SYS.messages)} WHERE "Channel" = $1 AND (("ParentMessage" IS NULL AND "createdOn" < $2) OR "ParentMessage" IN (SELECT id FROM ${T(env, SYS.messages)} WHERE "Channel" = $1 AND "ParentMessage" IS NULL AND "createdOn" < $2))`,
            [ch.id, cutoff],
          )
          if (!old.length) return
          const ids = old.map((r) => r.id)
          const fids = old.flatMap((r) => parseJsonList(r.Files).map(String))
          recs = fids.length ? (await s.meta.attachments.many(fids)).filter((a) => a.tableId === SYS.messages) : []
          await tx.exec(`DELETE FROM ${T(env, SYS.messageReactions)} WHERE "Message" = ANY($1::text[])`, [ids])
          await tx.exec(`DELETE FROM ${T(env, SYS.mentions)} WHERE "regardingTable" = $1 AND "regardingId" = ANY($2::text[])`, [SYS.messages, ids])
          await tx.exec(`DELETE FROM ${T(env, 'ab_chat_reports')} WHERE message_id = ANY($1::text[])`, [ids])
          messages += (await tx.exec(`DELETE FROM ${T(env, SYS.messages)} WHERE id = ANY($1::text[])`, [ids])).affectedRows
          seq = await chat.nextSeq(tx, env, ch.id)
          await tx.exec(`UPDATE ${T(env, SYS.channels)} SET "PurgedSeq" = $2 WHERE id = $1`, [ch.id, seq])
        })
        if (!seq) continue
        channelsTouched++
        if (recs.length) {
          await runInEnvironment(env.id, () => s.data.internals.removeAttachments(recs)).catch((e) => log('warn', `chat retention: removing files failed: ${errText(e)}`))
          fileCount += recs.length
        }
        await chat.publish(env, ch.id, seq, 'channel', null)
      }
    }
    // drafts never sent
    const drafts = await d.query<{ id: string }>(`SELECT id FROM ${T(env, 'ab_attachments')} WHERE table_id = $1 AND row_id LIKE 'draft-%' AND created_on < $2`, [SYS.messages, new Date(now.getTime() - 86_400_000)])
    if (drafts.length) {
      const recs = await s.meta.attachments.many(drafts.map((x) => x.id))
      await runInEnvironment(env.id, () => s.data.internals.removeAttachments(recs)).catch(() => undefined)
      fileCount += recs.length
    }
    return { messages, files: fileCount, channels: channelsTouched }
  }

  return {
    settingsView, saveSettings, setReadOnly, channels, channelMembers, archive, removeMember, deleteChannel, moderate, reports, handleReport,
    createExport, listExports, download, runRetention,
  }
}

export type ChatAdmin = ReturnType<typeof createChatAdmin>
export { CHAT_SYSTEM_TABLES }
