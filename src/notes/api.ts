/**
 * Calls of the Notes page (server mode; docs/dev/notes.md). Notes are Activities of Type Note written through the data API
 * (by the table's stable id), with `ifModifiedOn` for the version check; shares are ActivityShares rows; the /notes routes
 * add summaries, what the caller may do, record cards per reader and pins. The server decides every permission.
 */
import { PlatformError, platform, type AttachmentRef } from '@/platform'
import { API_BASE, CSRF_HEADER } from '@/platform/http'
import { environmentHeaders } from '@/platform/environments'
import { rememberErrorReference } from '@/platform/errorMessages'
import type { ChatCardView } from '@/platform/chat-protocol'
import { SYS } from '@/platform/system-tables'
import { NoteConflict, type NoteDraft } from './autosave'

export type NoteError = PlatformError & { status?: number; field?: string; body?: Record<string, unknown> | null }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { [CSRF_HEADER]: '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...environmentHeaders() },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new PlatformError('unavailable', 'The server cannot be reached. Notes need a connection.')
  }
  if (!res.ok) {
    let b: ({ error?: { code?: PlatformError['code']; message?: string; field?: string } } & Record<string, unknown>) | null = null
    try { b = await res.json() } catch { /* not JSON */ }
    const err = new PlatformError(b?.error?.code ?? 'storage', b?.error?.message ?? `The server answered ${res.status}`) as NoteError
    Object.assign(err, { status: res.status, body: b, ...(b?.error?.field ? { field: b.error.field } : {}) })
    const rid = res.headers.get('x-request-id')
    if (rid) {
      err.requestId = rid
      rememberErrorReference(err.message, rid)
    }
    throw err
  }
  return (await res.json()) as T
}

const enc = encodeURIComponent
const ACT = SYS.activities
const SHARES = SYS.activityShares

export type NotesView = 'all' | 'pinned' | 'shared' | 'records' | 'mine'
export interface RegardingInfo { table: string; id: string; label: string | null; tableName: string | null }
export interface NoteSummary {
  id: string; title: string; snippet: string; createdOn: string | null; modifiedOn: string | null; owner: string | null; ownerName: string | null
  mine: boolean; pinned: boolean; sharedWithMe: 'read' | 'edit' | null; files: number; regarding?: RegardingInfo
}
export interface NoteShare { id: string; PrincipalType: 'user' | 'team'; Principal: string; Access: 'read' | 'edit'; name: string | null }
export interface NoteDetail {
  note: { id: string; Subject: string; Body: string; Files: unknown; owner: string | null; createdBy: string | null; createdOn: string | null; modifiedOn: string | null; regardingTable: string | null; regardingId: string | null }
  version: string
  ownerName: string | null
  canEdit: boolean
  isOwner: boolean
  pinned: boolean
  regarding: RegardingInfo | null
  shares: NoteShare[]
}

/** the saved row of a 409, as the data API returns it (`current`) */
function conflictOf(e: NoteError): NoteConflict | null {
  if (e.status !== 409 || !e.body || typeof e.body.current !== 'object' || !e.body.current) return null
  const cur = e.body.current as Record<string, unknown>
  const by = (e.body.changedBy as { name?: string } | undefined)?.name ?? null
  const v = cur.modifiedOn
  return new NoteConflict({ subject: String(cur.Subject ?? ''), body: String(cur.Body ?? ''), version: typeof v === 'string' ? v : new Date(String(v)).toISOString(), by })
}

export const notesApi = {
  list: (view: NotesView, q = '', limit = 100) => call<{ items: NoteSummary[] }>('GET', `/notes?view=${view}&limit=${limit}${q.trim() ? `&q=${enc(q.trim())}` : ''}`).then((r) => r.items),
  get: (id: string) => call<NoteDetail>('GET', `/notes/${enc(id)}`),
  cards: (id: string) => call<{ cards: Record<string, ChatCardView> }>('POST', `/notes/${enc(id)}/cards`, {}).then((r) => r.cards),
  pin: (id: string, on: boolean) => call<{ pinned: boolean }>('PUT', `/notes/${enc(id)}/pin`, { on }),
  readers: (id: string, userIds: string[]) => call<{ readers: string[]; notReaders: string[] }>('POST', `/notes/${enc(id)}/readers`, { userIds }),

  async create(v: { subject: string; body?: string; regardingTable?: string | null; regardingId?: string | null }): Promise<string> {
    const r = await call<{ row: { id: string } }>('POST', `/data/${ACT}/rows`, {
      values: { Type: 'Note', Subject: v.subject.slice(0, 250) || 'Untitled note', ...(v.body ? { Body: v.body } : {}), ...(v.regardingId ? { regardingId: v.regardingId, ...(v.regardingTable ? { regardingTable: v.regardingTable } : {}) } : {}) },
    })
    return r.row.id
  },
  /** saves title and body against a version; NoteConflict when someone saved in between */
  async save(id: string, d: NoteDraft, version: string): Promise<string> {
    try {
      const r = await call<{ row: { modifiedOn?: string } }>('PATCH', `/data/${ACT}/rows/${enc(id)}`, { changes: { Subject: d.subject.slice(0, 250) || 'Untitled note', Body: d.body || null }, ifModifiedOn: version })
      return r.row.modifiedOn ? new Date(r.row.modifiedOn).toISOString() : version
    } catch (e) {
      const c = conflictOf(e as NoteError)
      if (c) throw c
      throw e
    }
  },
  remove: (id: string) => call<{ deleted: number }>('POST', `/data/${ACT}/delete`, { ids: [id] }),
  addShare: (id: string, s: { PrincipalType: 'user' | 'team'; Principal: string; Access: 'read' | 'edit' }) => call<{ row: { id: string } }>('POST', `/data/${SHARES}/rows`, { values: { Activity: id, ...s } }),
  changeShare: (shareId: string, Access: 'read' | 'edit') => call('PATCH', `/data/${SHARES}/rows/${enc(shareId)}`, { changes: { Access } }),
  removeShare: (shareId: string) => call('POST', `/data/${SHARES}/delete`, { ids: [shareId] }),
  teams: async (): Promise<{ id: string; name: string }[]> => {
    const r = await call<{ rows: Record<string, unknown>[] }>('POST', '/query', { plan: { version: 2, table: SYS.teams, take: { n: 500, from: 'start' } } })
    return r.rows.map((x) => ({ id: String(x.id), name: String(x.Name ?? x.Code ?? x.id) }))
  },
  people: (q: string) => platform.collab!.people(q),
  /** rows of a table to link (the primary column), searched as the caller */
  records: async (tableId: string, primary: string, q: string): Promise<{ id: string; label: string }[]> => {
    const plan = { version: 2, table: tableId, ...(q.trim() ? { search: { text: q.trim(), columns: [primary] } } : {}), take: { n: 20, from: 'start' }, select: [primary] }
    const r = await call<{ rows: Record<string, unknown>[] }>('POST', '/query', { plan })
    return r.rows.map((x) => ({ id: String(x.id), label: String(x[primary] ?? x.id) }))
  },
  upload: (id: string, file: File): Promise<AttachmentRef> => platform.attachments.upload(ACT, 'Files', id, file),
  resolveFiles: (ids: string[]): Promise<AttachmentRef[]> => (ids.length ? platform.attachments.resolve(ids) : Promise.resolve([])),
  removeFile: (attId: string) => platform.attachments.remove(attId),
  fileUrl: (attId: string) => platform.attachments.url(attId),
}
