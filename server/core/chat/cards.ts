/**
 * Cards (P3-A, docs/dev/chat.md "Cards"): a message stores references only (a record, an app, a dashboard); each reader
 * resolves them at read time with their own security, in the card's environment:
 *  - record: the reader's context there (no access to the environment: not available); the row read through the
 *    DataService as the reader (row predicate, column security, recycle bin); only the chosen fields the reader may read,
 *    and the primary column only when readable; a missing row and a row the reader may not read give the same answer;
 *  - app: shown when the reader may run the app (or is a maker there);
 *  - dashboard: title and description when the reader may view it (tiles are never rendered in a card).
 * The reader must first be able to read the message itself. Chat tables are never shown as cards.
 */
import { HttpError } from '../contracts.ts'
import type { UserContext } from '../contracts.ts'
import type { CoreServices } from '../services.ts'
import { userContextFor } from '../auth.ts'
import { runInEnvironment } from '../env-context.ts'
import { hasAnyTableAccess } from '../security.ts'
import type { ChatCardRef, ChatCardView } from '../../../src/platform/chat-protocol.ts'
import { CHAT_SYSTEM_TABLES } from './ddl.ts'
import { parseJsonList } from './format.ts'
import type { ChatCx, ChatService } from './service.ts'
import { canView, dashboardRow } from '../dashboards/compute.ts'

const notAvailable = (kind: ChatCardRef['kind']): ChatCardView => ({ available: false, kind })

/**
 * approval cards (package E) are resolved by the approvals module (server/core/approvals/chat-hook.ts registers it): the
 * same visibility rule as the inbox (canSee), in the request's environment, as the reader
 */
type ApprovalCardResolver = (userId: string, ref: Extract<ChatCardRef, { kind: 'approval' }>) => Promise<ChatCardView>
let approvalResolver: ApprovalCardResolver | null = null
export function setApprovalCardResolver(fn: ApprovalCardResolver | null): void {
  approvalResolver = fn
}

/** the reader's security context in another environment, or null (no access, the environment is gone) */
async function contextIn(s: CoreServices, userId: string, env: string): Promise<UserContext | null> {
  const rec = await s.meta.users.get(userId)
  if (!rec || rec.status === 'disabled') return null
  try {
    const ctx = await userContextFor(s, rec, env)
    return ctx.environmentId === env ? ctx : null
  } catch {
    return null
  }
}

export async function resolveCardRef(s: CoreServices, userId: string, ref: ChatCardRef): Promise<ChatCardView> {
  const ctx = await contextIn(s, userId, ref.env)
  if (!ctx) return notAvailable(ref.kind)
  if (ref.kind === 'approval') return approvalResolver ? approvalResolver(userId, ref) : notAvailable('approval')
  return runInEnvironment(ref.env, async (): Promise<ChatCardView> => {
    if (ref.kind === 'record') {
      const t = await s.meta.tables.get(ref.table)
      if (!t || CHAT_SYSTEM_TABLES.includes(t.id) || !hasAnyTableAccess(ctx, t)) return notAvailable('record')
      const read = ctx.rowPredicate(t, 'read')
      if ('const' in read && !read.const) return notAvailable('record')
      const known = new Set(t.columns.map((c) => c.name))
      const fields = ref.fields.filter((f) => known.has(f) && f !== 'id' && ctx.columnAccess(t, f) !== 'none')
      const primary = known.has(t.primaryColumn) && ctx.columnAccess(t, t.primaryColumn) !== 'none' ? t.primaryColumn : null
      const select = [...new Set([...fields, ...(primary ? [primary] : [])])]
      let row: Record<string, unknown> | undefined
      try {
        const res = await s.data.query(ctx, t, { where: { col: 'id', op: 'eq', value: ref.row }, ...(select.length ? { select } : { select: ['id'] }), top: 1 })
        row = res.rows[0]
      } catch (e) {
        if (e instanceof HttpError && [403, 404, 422].includes(e.status)) return notAvailable('record')
        throw e
      }
      if (!row) return notAvailable('record')
      const def = ctx.visibleDef(t)
      return {
        available: true, kind: 'record', env: ref.env, table: t.id, tableName: def.displayName || def.name, row: String(row.id),
        title: primary ? (row[primary] === null || row[primary] === undefined ? null : String(row[primary])) : null,
        fields: fields.map((f) => {
          const c = t.columns.find((x) => x.name === f)!
          return { name: f, displayName: c.displayName || c.name, type: String(c.type), value: row![f] ?? null }
        }),
      }
    }
    if (ref.kind === 'app') {
      const app = (await s.meta.apps.get(ref.app).catch(() => null))?.meta
      if (!app || (!ctx.privileges.isMaker && !ctx.canRunApp(app.id))) return notAvailable('app')
      return { available: true, kind: 'app', env: ref.env, app: app.id, name: app.name, description: app.description ?? '', ...(ref.screen ? { screen: ref.screen } : {}) }
    }
    const db = s.state.db
    const r = db ? await dashboardRow(db, ref.dashboard).catch(() => null) : null
    if (!r || !canView(ctx, r as never)) return notAvailable('dashboard')
    const def = (r as { def?: { title?: unknown; description?: unknown } }).def ?? {}
    return { available: true, kind: 'dashboard', env: ref.env, dashboard: String((r as { id: unknown }).id), name: String(def.title ?? (r as { name?: unknown }).name ?? ''), description: String(def.description ?? '') }
  })
}

/** POST /chat/cards/resolve { messageId, index }: the card as this reader may see it */
export async function resolveCard(s: CoreServices, chat: ChatService, cx: ChatCx, b: Record<string, unknown>): Promise<ChatCardView> {
  const messageId = typeof b.messageId === 'string' ? b.messageId : ''
  const index = Number(b.index)
  const db = s.state.db
  if (!db) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
  const { msg } = await chat.readableMessage(db, cx, messageId)
  const cards = msg.DeletedOn || msg.Kind === 'system' ? [] : parseJsonList((() => {
    try { return msg.Cards ? JSON.parse(String(msg.Cards)) : [] } catch { return [] }
  })())
  if (!Number.isInteger(index) || index < 0 || index >= cards.length) throw new HttpError(404, 'not-found', 'Card not found.')
  return resolveCardRef(s, cx.id, cards[index] as ChatCardRef)
}
