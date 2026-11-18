/**
 * Thin fetch helpers for server endpoints that PlatformApi has no method for.
 * Same conventions as src/platform/http.ts: same-origin cookie session, CSRF header on non-GET.
 */
import { PlatformError } from '@/platform'
import { API_BASE, CSRF_HEADER, type ApiError } from '@/platform/http'

/** One row of GET /api/v1/security/preview?user= */
export interface TablePreview {
  tableId: string
  visibleRows: number
  hiddenColumns: string[]
  readOnlyColumns: string[]
}

async function toError(res: Response): Promise<PlatformError> {
  let body: Partial<ApiError> | null = null
  try { body = (await res.json()) as Partial<ApiError> } catch { /* not JSON */ }
  const code = body?.error?.code ?? (res.status === 401 ? 'unauthenticated' : res.status === 403 ? 'denied' : res.status === 404 ? 'not-found' : res.status === 503 ? 'unavailable' : 'storage')
  return new PlatformError(code, body?.error?.message ?? `The server answered ${res.status}`)
}

/** Admin only: what a chosen user would see (row counts and hidden / read-only columns per table), computed by the server. */
export async function fetchSecurityPreview(userId: string): Promise<TablePreview[]> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}/security/preview?user=${encodeURIComponent(userId)}`, { credentials: 'same-origin', headers: { [CSRF_HEADER]: '1' } })
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
  }))
}
