/**
 * Server calls of Admin console > Backups (package J). Shapes and routes: src/platform/backup.ts. Errors keep the
 * server's code and field (field "backup": the backup before a change failed; code "reauth_required": sign in again).
 */
import { PlatformError } from '@/platform'
import { API_BASE, CSRF_HEADER } from '@/platform/http'
import { environmentHeaders } from '@/platform/environments'
import type {
  BackupContents, BackupHealth, BackupInfo, BackupOp, BackupRowsPage, BackupSettings, BackupSettingsInput, BackupsResponse, RestoreRequest,
  TableRestorePlan, TableRestoreRequest,
} from '@/platform/backup'

export type ApiError = PlatformError & { field?: string; status?: number; serverCode?: string }

async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, o: { raw?: Blob; query?: Record<string, string> } = {}): Promise<T> {
  let res: Response
  const qs = o.query ? `?${new URLSearchParams(o.query).toString()}` : ''
  try {
    res = await fetch(`${API_BASE}${path}${qs}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { [CSRF_HEADER]: '1', ...(o.raw ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...environmentHeaders() },
      body: o.raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    })
  } catch {
    throw new PlatformError('unavailable', 'The server cannot be reached.')
  }
  if (!res.ok) {
    let b: { error?: { code?: string; message?: string; field?: string } } | null = null
    try { b = await res.json() } catch { /* not JSON */ }
    const code = (b?.error?.code ?? (res.status === 403 ? 'denied' : res.status === 404 ? 'not-found' : res.status === 409 ? 'conflict' : res.status === 422 ? 'invalid' : 'storage')) as PlatformError['code']
    const err = new PlatformError(code, b?.error?.message ?? `The server answered ${res.status}.`) as ApiError
    err.status = res.status
    if (b?.error?.field) err.field = b.error.field
    if (b?.error?.code) err.serverCode = b.error.code
    throw err
  }
  return (await res.json()) as T
}

const enc = encodeURIComponent

export const fetchBackups = () => call<BackupsResponse>('GET', '/backups')
export const fetchBackupHealth = () => call<BackupHealth>('GET', '/backups/health')
export const fetchBackupSettings = () => call<BackupSettings>('GET', '/backups/settings')
export const saveBackupSettings = (input: BackupSettingsInput) => call<BackupSettings>('PUT', '/backups/settings', input)
export const backupNow = (b: { scope: string; includeKey?: boolean; passphrase?: string; note?: string }) => call<BackupInfo>('POST', '/backups', b)
export const updateBackup = (id: string, b: { pinned?: boolean; note?: string }) => call<BackupInfo>('PATCH', `/backups/${enc(id)}`, b)
export const deleteBackup = (id: string) => call<{ ok: true }>('DELETE', `/backups/${enc(id)}`)
export const verifyBackup = (id: string, passphrase?: string) => call<BackupOp>('POST', `/backups/${enc(id)}/verify`, passphrase ? { passphrase } : {})
export const fetchContents = (id: string, passphrase?: string) => call<BackupContents>('POST', `/backups/${enc(id)}/contents`, passphrase ? { passphrase } : {})
export const browseBackup = (id: string, b: { environment: string; table: string; offset: number; limit: number; passphrase?: string }) => call<BackupRowsPage>('POST', `/backups/${enc(id)}/browse`, b)
export const restoreBackup = (id: string, b: RestoreRequest) => call<BackupOp>('POST', `/backups/${enc(id)}/restore`, b)
export const planTableRestore = (id: string, b: TableRestoreRequest) => call<TableRestorePlan>('POST', `/backups/${enc(id)}/restore-tables/plan`, b)
export const restoreTables = (id: string, b: TableRestoreRequest & { confirm: string }) => call<BackupOp>('POST', `/backups/${enc(id)}/restore-tables`, b)
export const fetchOp = (id: string) => call<BackupOp>('GET', `/backups/ops/${enc(id)}`)
export const runRestoreTest = () => call<BackupOp>('POST', '/backups/restore-test', {})
export const uploadBackup = (file: File) => call<BackupInfo>('POST', '/backups/upload', undefined, { raw: file, query: { name: file.name } })
export const reauthenticate = (password: string) => call<unknown>('POST', '/auth/reauth', { password })

/** a one-use download link (needs a recent sign-in: ApiError serverCode "reauth_required" otherwise) */
export async function downloadBackup(id: string): Promise<void> {
  const t = await call<{ ticket: string; url: string }>('POST', `/backups/${enc(id)}/download-ticket`, {})
  const a = document.createElement('a')
  a.href = `${t.url}?ticket=${enc(t.ticket)}`
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** waits for an operation to end (polling; the live hub also pushes progress) */
export async function waitForOp(id: string, onProgress?: (op: BackupOp) => void, signal?: AbortSignal): Promise<BackupOp> {
  for (;;) {
    const op = await fetchOp(id)
    onProgress?.(op)
    if (op.state !== 'running') return op
    if (signal?.aborted) return op
    await new Promise((r) => setTimeout(r, 700))
  }
}

export const isBackupRefusal = (e: unknown): boolean => (e as ApiError | null)?.field === 'backup'
export const needsReauth = (e: unknown): boolean => (e as ApiError | null)?.serverCode === 'reauth_required'
export const needsPassphrase = (e: unknown): boolean => (e as ApiError | null)?.field === 'passphrase'
