/**
 * Attachment routes. Permission = the row is readable (RLS) and the column visible (CLS) for downloads/resolve;
 * upload/delete need update on the row and 'update' access to the column.
 *   POST   /attachments?table=&column=&rowId=&name=   raw body -> AttachmentRef   (the cell is updated:
 *          single column: replaced (old attachment deleted); multiple: id appended to the JSON array)
 *   POST   /attachments/resolve { ids }   GET /attachments/:id   DELETE /attachments/:id
 */
import { HttpError } from './contracts.ts'
import type { AttachmentRecord, RawRow, UserContext } from './contracts.ts'
import type { AttachmentRef, ColumnDef, TableDef } from '../../src/platform/contracts.ts'
import type { AttachmentResolveResponse } from '../../src/platform/http.ts'
import type { ApiRouter } from './router.ts'
import type { CoreServices } from './services.ts'
import { tableParam } from './data-routes.ts'
import { attachmentIds } from './values.ts'
import { errText, log } from './util.ts'

const DEFAULT_MAX_MB = 25
const ROUTE_MAX_MB = 200
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i

function cleanName(name: string | null): string {
  let n = (name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop() ?? ''
  n = n.trim().slice(0, 255)
  return n || 'file'
}

function cleanMime(type: string | undefined): string {
  const t = (type ?? '').split(';')[0].trim().toLowerCase()
  return MIME_RE.test(t) ? t : 'application/octet-stream'
}

export function mimeAccepted(col: ColumnDef, mime: string): boolean {
  const patterns = col.accept?.length ? col.accept : col.type === 'image' ? ['image/*'] : []
  if (!patterns.length) return true
  return patterns.some((p) => {
    const q = p.trim().toLowerCase()
    if (q === '*' || q === '*/*') return true
    if (q.endsWith('/*')) return mime.startsWith(q.slice(0, -1))
    return q === mime
  })
}

function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

const attachmentColumn = (t: TableDef, name: string): ColumnDef | undefined =>
  t.columns.find((c) => c.name === name && (c.type === 'file' || c.type === 'image'))

/** per-row lock so concurrent uploads to a multiple column do not lose ids */
const rowLocks = new Map<string, Promise<unknown>>()
function withRowLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = rowLocks.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => {})
  rowLocks.set(key, tail)
  void tail.then(() => {
    if (rowLocks.get(key) === tail) rowLocks.delete(key)
  })
  return run
}

/** the attachment's table + row when the user may see it (row readable, column visible, cell references it) */
async function visibleAttachment(services: CoreServices, user: UserContext, a: AttachmentRecord): Promise<{ table: TableDef; row: RawRow } | null> {
  const table = await services.meta.tables.get(a.tableId)
  if (!table) return null
  if (!attachmentColumn(table, a.column) || user.columnAccess(table, a.column) === 'none') return null
  const row = await services.data.internals.findRow(table, a.rowId, user.rowPredicate(table, 'read'))
  if (!row || !attachmentIds(row[a.column]).includes(a.id)) return null
  return { table, row }
}

async function audit(services: CoreServices, user: UserContext, action: string, a: AttachmentRecord) {
  try {
    await services.meta.audit({ userId: user.user.id, action, tableId: a.tableId, rowId: a.rowId, details: { column: a.column, attachment: a.id, size: a.sizeBytes } })
  } catch (e) {
    log('warn', `audit failed: ${errText(e)}`)
  }
}

/** remove every attachment of a table (call when a table is deleted) */
export async function removeTableAttachments(services: CoreServices, tableId: string): Promise<number> {
  const rows = await services.meta.db.query<{ id: string }>('SELECT id FROM ab_attachments WHERE table_id = ?', [tableId])
  const recs = await services.meta.attachments.many(rows.map((r) => r.id))
  await services.data.internals.removeAttachments(recs)
  return recs.length
}

/**
 * Orphan cleanup: attachments whose table or row is gone, or whose cell no longer references them
 * (older than `graceMs`, so in-flight uploads are never touched). Returns the number removed.
 */
export async function sweepOrphanAttachments(services: CoreServices, graceMs = 60 * 60 * 1000): Promise<number> {
  const meta = services.meta
  const cutoff = new Date(Date.now() - graceMs)
  const rows = await meta.db.query<{ id: string }>('SELECT id FROM ab_attachments WHERE created_on < ? ORDER BY table_id LIMIT 5000', [cutoff])
  const recs = await meta.attachments.many(rows.map((r) => r.id))
  const byTable = new Map<string, AttachmentRecord[]>()
  for (const a of recs) byTable.set(a.tableId, [...(byTable.get(a.tableId) ?? []), a])
  const orphans: AttachmentRecord[] = []
  for (const [tableId, list] of byTable) {
    const table = await meta.tables.get(tableId)
    if (!table) {
      orphans.push(...list)
      continue
    }
    for (const a of list) {
      try {
        const row = await services.data.internals.findRow(table, a.rowId)
        if (!row || !attachmentIds(row[a.column]).includes(a.id)) orphans.push(a)
      } catch (e) {
        log('warn', `orphan sweep skipped table ${table.name}: ${errText(e)}`)
        break
      }
    }
  }
  await services.data.internals.removeAttachments(orphans)
  return orphans.length
}

export function attachmentRoutes(router: ApiRouter, services: CoreServices): void {
  router.add('POST', '/attachments', async (ctx): Promise<AttachmentRef> => {
    const user = ctx.user!
    const table = await tableParam(services, ctx.query.get('table') ?? '')
    const def = services.data.internals.physical(table)
    const colName = ctx.query.get('column') ?? ''
    const rowId = ctx.query.get('rowId') ?? ''
    const col = attachmentColumn(def, colName)
    if (!col) throw new HttpError(422, 'invalid', `"${colName.slice(0, 64)}" is not a file or image column of "${def.displayName || def.name}".`, 'column')
    if (def.readOnly) throw new HttpError(403, 'denied', `"${def.displayName || def.name}" is read-only.`)
    const access = user.columnAccess(def, col.name)
    if (access === 'none') throw new HttpError(404, 'not-found', 'Row not found.')
    if (access !== 'update') throw new HttpError(403, 'denied', `${col.displayName || col.name} is read-only for you.`, col.name)
    if (!rowId || rowId.length > 64) throw new HttpError(404, 'not-found', 'Row not found.')
    const bytes = ctx.rawBody ?? Buffer.alloc(0)
    if (!bytes.length) throw new HttpError(422, 'invalid', 'The file is empty.')
    const maxMB = col.maxSizeMB && col.maxSizeMB > 0 ? Math.min(col.maxSizeMB, ROUTE_MAX_MB) : DEFAULT_MAX_MB
    if (bytes.length > maxMB * 1024 * 1024) throw new HttpError(413, 'invalid', `The file is larger than ${maxMB} MB.`, col.name)
    const mime = cleanMime(ctx.req.headers['content-type'])
    if (!mimeAccepted(col, mime)) throw new HttpError(422, 'invalid', `${col.displayName || col.name} does not accept ${mime} files.`, col.name)
    const fileName = cleanName(ctx.query.get('name'))

    return withRowLock(`${def.id}:${rowId}`, async () => {
      const row = await services.data.internals.findRow(def, rowId, user.rowPredicate(def, 'update'))
      if (!row) {
        const readable = await services.data.internals.findRow(def, rowId, user.rowPredicate(def, 'read'))
        throw readable ? new HttpError(403, 'denied', 'You are not allowed to change this row.') : new HttpError(404, 'not-found', 'Row not found.')
      }
      const stored = await services.attachments.put(bytes)
      const rec: AttachmentRecord = {
        id: services.uid('att'), tableId: def.id, column: col.name, rowId, fileName, mime,
        sizeBytes: stored.sizeBytes, sha256: stored.sha256, storageKey: stored.storageKey, createdBy: user.user.id, createdOn: services.now(),
      }
      try {
        await services.meta.attachments.insert(rec)
      } catch (e) {
        await services.attachments.remove(stored.storageKey).catch(() => {})
        throw e
      }
      const before = attachmentIds(row[col.name])
      const cell = col.multiple ? JSON.stringify([...before, rec.id]) : rec.id
      let n = 0
      try {
        n = await services.data.internals.writeCells(user, def, rowId, { [col.name]: cell })
      } catch (e) {
        await services.data.internals.removeAttachments([rec])
        throw e
      }
      if (n === 0) {
        await services.data.internals.removeAttachments([rec])
        throw new HttpError(403, 'denied', 'You are not allowed to change this row.')
      }
      if (!col.multiple && before.length) {
        const old = (await services.meta.attachments.many(before)).filter((a) => a.tableId === def.id && a.rowId === rowId)
        await services.data.internals.removeAttachments(old)
      }
      await audit(services, user, 'attachment.upload', rec)
      return services.attachments.toRef(rec)
    })
  }, { auth: 'user', raw: true, maxBodyMB: ROUTE_MAX_MB })

  router.add('POST', '/attachments/resolve', async (ctx): Promise<AttachmentResolveResponse> => {
    const user = ctx.user!
    const b = ctx.body as { ids?: unknown } | undefined
    if (!b || !Array.isArray(b.ids)) throw new HttpError(422, 'invalid', 'ids must be a list of attachment ids.', 'ids')
    const ids = b.ids.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64).slice(0, 1000)
    const recs = await services.meta.attachments.many(ids)
    const byTable = new Map<string, AttachmentRecord[]>()
    for (const a of recs) byTable.set(a.tableId, [...(byTable.get(a.tableId) ?? []), a])
    const allowed = new Set<string>()
    for (const [tableId, list] of byTable) {
      const table = await services.meta.tables.get(tableId)
      if (!table) continue
      const cols = [...new Set(list.map((a) => a.column))].filter((c) => attachmentColumn(table, c) && user.columnAccess(table, c) !== 'none')
      if (!cols.length) continue
      const rowIds = [...new Set(list.map((a) => a.rowId))]
      const res = await services.data.query(user, table, { where: { col: 'id', op: 'in', value: rowIds }, select: cols, top: rowIds.length })
      const rows = new Map(res.rows.map((r) => [String(r.id), r]))
      for (const a of list) {
        const r = rows.get(a.rowId)
        if (r && cols.includes(a.column) && attachmentIds(r[a.column]).includes(a.id)) allowed.add(a.id)
      }
    }
    const order = new Map(ids.map((id, i) => [id, i]))
    const items = recs.filter((a) => allowed.has(a.id)).sort((x, y) => (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0)).map((a) => services.attachments.toRef(a))
    return { items }
  }, { auth: 'user' })

  router.add('GET', '/attachments/:id', async (ctx) => {
    const user = ctx.user!
    const a = await services.meta.attachments.get(ctx.params.id)
    if (!a || !(await visibleAttachment(services, user, a))) throw new HttpError(404, 'not-found', 'Attachment not found.')
    const download = ctx.query.get('download') === '1'
    return {
      raw: true as const,
      headers: {
        'Content-Type': a.mime || 'application/octet-stream',
        'Content-Length': String(a.sizeBytes),
        'Content-Disposition': contentDisposition(download ? 'attachment' : 'inline', a.fileName),
        // user-supplied content on our origin: never let it run script
        'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
        'Cache-Control': 'private, no-store',
      },
      body: services.attachments.open(a.storageKey),
    }
  }, { auth: 'user' })

  router.add('DELETE', '/attachments/:id', async (ctx) => {
    const user = ctx.user!
    const a = await services.meta.attachments.get(ctx.params.id)
    const seen = a ? await visibleAttachment(services, user, a) : null
    if (!a || !seen) throw new HttpError(404, 'not-found', 'Attachment not found.')
    const def = services.data.internals.physical(seen.table)
    const col = attachmentColumn(def, a.column)!
    if (def.readOnly) throw new HttpError(403, 'denied', `"${def.displayName || def.name}" is read-only.`)
    if (user.columnAccess(def, a.column) !== 'update') throw new HttpError(403, 'denied', `${col.displayName || col.name} is read-only for you.`, col.name)
    await withRowLock(`${def.id}:${a.rowId}`, async () => {
      const row = await services.data.internals.findRow(def, a.rowId, user.rowPredicate(def, 'update'))
      if (!row) throw new HttpError(403, 'denied', 'You are not allowed to change this row.')
      const rest = attachmentIds(row[a.column]).filter((x) => x !== a.id)
      const cell = rest.length ? (col.multiple ? JSON.stringify(rest) : rest[0]) : null
      const n = await services.data.internals.writeCells(user, def, a.rowId, { [a.column]: cell })
      if (n === 0) throw new HttpError(403, 'denied', 'You are not allowed to change this row.')
      await services.data.internals.removeAttachments([a])
    })
    await audit(services, user, 'attachment.delete', a)
    return { ok: true }
  }, { auth: 'user' })
}
