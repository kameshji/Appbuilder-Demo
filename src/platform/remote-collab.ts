/**
 * Server mode collaboration API (P0 package N): /api/v1/collab/* plus the data API on the system tables (by their
 * stable ids, so a renamed system table still works). The server decides every permission.
 */
import type { CollabApi, MentionItem, PersonOption, TaskItem, TimelinePage } from './collab-api.ts'
import { SYS } from './system-tables.ts'
import { PlatformError } from './contracts.ts'
import type { RecycleBatch } from './recycle-api.ts'

type Call = <T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, o?: { json?: unknown; raw?: BodyInit; contentType?: string; query?: Record<string, string | undefined> }) => Promise<T>

export function remoteCollab(call: Call, o: { invalidate(tableId: string): void; upload(tableId: string, column: string, rowId: string, file: File): Promise<unknown>; deleted?(table: string, batch: RecycleBatch): void }): CollabApi {
  const insert = async (table: string, values: Record<string, unknown>): Promise<string> => {
    const r = await call<{ row: { id: string } }>('POST', `/data/${table}/rows`, { json: { values } })
    o.invalidate(table)
    return r.row.id
  }
  const update = async (table: string, id: string, changes: Record<string, unknown>) => {
    await call('PATCH', `/data/${table}/rows/${encodeURIComponent(id)}`, { json: { changes } })
    o.invalidate(table)
  }
  const remove = async (table: string, id: string) => {
    const r = await call<{ deleted: number; batch?: RecycleBatch }>('POST', `/data/${table}/delete`, { json: { ids: [id] } })
    o.invalidate(table)
    // Activities, Comments and Documents with a recycle bin: the Undo toast of the page
    if (r?.batch) o.deleted?.(table, r.batch)
  }
  const regarding = (rowId: string | null | undefined, table?: string) => (rowId ? { regardingId: rowId, ...(table ? { regardingTable: table } : {}) } : {})
  return {
    timeline: (rowId, q = {}) => call<TimelinePage>('GET', '/collab/timeline', { query: { row: rowId, table: q.table, cursor: q.cursor ?? undefined, limit: q.limit ? String(q.limit) : undefined } }),
    addComment: (i) => insert(SYS.comments, { Body: i.body, ...regarding(i.rowId, i.table), ...(i.parent ? { ParentComment: i.parent } : {}), ...(i.link ? { Link: i.link } : {}) }),
    editComment: (id, body) => update(SYS.comments, id, { Body: body }),
    deleteComment: (id) => remove(SYS.comments, id),
    addActivity: (i) => insert(SYS.activities, {
      Subject: i.subject, Type: i.type ?? 'Task', ...(i.description ? { Description: i.description } : {}), ...(i.dueOn ? { DueOn: i.dueOn } : {}),
      ...(i.assignedTo ? { AssignedTo: i.assignedTo } : {}), ...(i.priority ? { Priority: i.priority } : {}), ...regarding(i.rowId, i.table),
    }),
    updateActivity: (id, changes) => update(SYS.activities, id, changes),
    deleteActivity: (id) => remove(SYS.activities, id),
    follow: async (rowId, on, table) => {
      await call('POST', '/collab/follow', { json: { row: rowId, table, on } })
      o.invalidate(SYS.follows)
    },
    tag: async (rowId, tag, on, table) => {
      await call('POST', '/collab/tags', { json: { row: rowId, table, tag, on } })
      o.invalidate(SYS.tagLinks)
    },
    async attachFile(rowId, file, table) {
      const doc = await insert(SYS.documents, { Name: file.name.slice(0, 255), ...regarding(rowId, table) })
      try {
        await o.upload(SYS.documents, 'File', doc, file)
      } catch (e) {
        await remove(SYS.documents, doc).catch(() => {})
        throw e
      }
    },
    mentionable: async (rowId, q, table) => (await call<{ users: PersonOption[] }>('GET', '/collab/mentionable', { query: { row: rowId, table, q } })).users,
    people: async (q = '') => {
      const filter = q.trim() ? { or: [{ col: 'FullName', op: 'contains', value: q.trim() }, { col: 'Email', op: 'startsWith', value: q.trim() }] } : undefined
      const r = await call<{ rows: Record<string, unknown>[] }>('POST', '/query', { json: { plan: { version: 2, table: SYS.users, ...(filter ? { filter } : {}), sort: [{ col: 'FullName', dir: 'asc' }], take: { n: 50, from: 'start' }, select: ['FullName', 'Email'] } } })
      return r.rows.map((x) => ({ id: String(x.id), name: String(x.FullName ?? ''), email: String(x.Email ?? '') }))
    },
    myTasks: async (q = {}) => (await call<{ items: TaskItem[] }>('GET', '/collab/my-tasks', { query: { status: q.all ? 'all' : 'open' } })).items,
    mentions: async () => (await call<{ items: MentionItem[] }>('GET', '/collab/mentions')).items,
    markMentionRead: (id) => update(SYS.mentions, id, { IsRead: true }),
    nextNumber: async () => {
      throw new PlatformError('invalid', 'Numbers are assigned by the server when a row is saved: use NextNumber in a column default (=NextNumber("Invoices")) or in a table event that runs before the write.')
    },
    topics: () => [SYS.comments, SYS.activities, SYS.documents, SYS.attachmentLinks, SYS.follows, SYS.tagLinks].map((t) => `table:${t}`),
  }
}
