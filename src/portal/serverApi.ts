/**
 * Thin fetch helpers for server endpoints that PlatformApi has no method for.
 * Same conventions as src/platform/http.ts: same-origin cookie session, CSRF header on non-GET.
 */
import { PlatformError } from '@/platform'
import { API_BASE, CSRF_HEADER, type ApiError, type AuditPageResponse, type StatusResponse, type StatusServerInfo } from '@/platform/http'
import { environmentHeaders } from '@/platform/environments'

/** One row of GET /api/v1/security/preview?user= */
export interface TablePreview {
  tableId: string
  visibleRows: number
  hiddenColumns: string[]
  readOnlyColumns: string[]
  /** why rows are readable (one line per granting role, shares) */
  why: string[]
}

export async function toError(res: Response): Promise<PlatformError> {
  let body: Partial<ApiError> | null = null
  try { body = (await res.json()) as Partial<ApiError> } catch { /* not JSON */ }
  const code = body?.error?.code ?? (res.status === 401 ? 'unauthenticated' : res.status === 403 ? 'denied' : res.status === 404 ? 'not-found' : res.status === 405 ? 'method_not_allowed' : res.status === 409 ? 'conflict' : res.status === 429 ? 'rate_limited' : res.status === 503 ? 'unavailable' : 'storage')
  const err = new PlatformError(code, body?.error?.message ?? `The server answered ${res.status}`)
  // the field the server named (e.g. "backup": the backup before a change failed, package J)
  if (body?.error?.field) Object.assign(err, { field: body.error.field })
  return err
}

/** Admin only: what a chosen user would see (row counts and hidden / read-only columns per table), computed by the server. */
export async function fetchSecurityPreview(userId: string): Promise<TablePreview[]> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}/security/preview?user=${encodeURIComponent(userId)}`, { credentials: 'same-origin', headers: { [CSRF_HEADER]: '1', ...environmentHeaders() } })
  } catch {
    throw new PlatformError('unavailable', 'The server cannot be reached.')
  }
  if (!res.ok) throw await toError(res)
  return normalizeSecurityPreview(await res.json())
}

/**
 * The server answers with two lists: `items` ({ tableId, visibleRows, ... }, the compact shape) and `tables`
 * ({ table, rowCount, ... }, the richer one; rowCount is null when counting failed). Accept either, in any
 * entry-level mix, and map to TablePreview.
 */
export function normalizeSecurityPreview(body: unknown): TablePreview[] {
  const b = body as { items?: unknown; tables?: unknown } | null
  const list = Array.isArray(body) ? body : Array.isArray(b?.items) ? b.items : b?.tables
  if (!Array.isArray(list)) return []
  return (list as Record<string, unknown>[]).map((p) => ({
    tableId: String(p.tableId ?? p.table ?? ''),
    visibleRows: Number(p.visibleRows ?? p.rowCount ?? 0),
    hiddenColumns: Array.isArray(p.hiddenColumns) ? p.hiddenColumns.map(String) : [],
    readOnlyColumns: Array.isArray(p.readOnlyColumns) ? p.readOnlyColumns.map(String) : [],
    why: Array.isArray(p.why) ? p.why.map(String) : [],
  }))
}

/** Admin only: rows of a table that have no owner (linked rows that existed before) get one (default: the caller). */
export async function assignOwnerToUnownedRows(tableId: string, userId?: string): Promise<number> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}/tables/${encodeURIComponent(tableId)}/assign-owner`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { [CSRF_HEADER]: '1', 'Content-Type': 'application/json', ...environmentHeaders() },
      body: JSON.stringify(userId ? { userId } : {}),
    })
  } catch {
    throw new PlatformError('unavailable', 'The server cannot be reached.')
  }
  if (!res.ok) throw await toError(res)
  return Number(((await res.json()) as { updated?: number }).updated ?? 0)
}

export async function getJson<T>(path: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, { credentials: 'same-origin', headers: { [CSRF_HEADER]: '1', ...environmentHeaders() }, cache: 'no-store' })
  } catch {
    throw new PlatformError('unavailable', 'The server cannot be reached.')
  }
  if (!res.ok) throw await toError(res)
  return (await res.json()) as T
}

export interface AuditQuery { action?: string; user?: string; from?: string; to?: string; page?: number; pageSize?: number }

/** the query string of GET /api/v1/audit (empty values left out; `to` is a date, sent as the start of the next day) */
export function auditSearch(q: AuditQuery): string {
  const p = new URLSearchParams()
  if (q.action) p.set('action', q.action)
  if (q.user) p.set('user', q.user)
  if (q.from) p.set('from', q.from)
  if (q.to) {
    const d = new Date(`${q.to}T00:00:00.000Z`)
    if (!Number.isNaN(d.getTime())) p.set('to', new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10))
  }
  if (q.page && q.page > 1) p.set('page', String(q.page))
  if (q.pageSize) p.set('pageSize', String(q.pageSize))
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** Admin only: one page of the audit log, newest first */
export const fetchAuditPage = (q: AuditQuery): Promise<AuditPageResponse> => getJson<AuditPageResponse>(`/audit${auditSearch(q)}`)

/** Admin only: versions and database details from GET /api/v1/status (undefined for non-admins or an old server) */
export async function fetchServerInfo(): Promise<{ server?: StatusServerInfo; storage?: { location: string } | null; databaseError?: string }> {
  const st = await getJson<StatusResponse>('/status')
  return { server: st.server, storage: st.storage, databaseError: st.databaseError }
}
