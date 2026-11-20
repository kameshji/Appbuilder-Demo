/**
 * Calls of the approvals API (server mode; docs/dev/data-api.md "Approvals"). Used by the Approvals page, the
 * Approvals panel UI component and RequestApproval() in apps.
 */
import { PlatformError } from '@/platform'
import { API_BASE, CSRF_HEADER, ENVIRONMENT_HEADER } from '@/platform/http'
import { environmentHeaders } from '@/platform/environments'
import { rememberErrorReference } from '@/platform/errorMessages'
import type { ApprovalDetail, ApprovalPolicy, ApprovalRequestInfo, ApprovalSettings, DelegationInfo, RequestStatus } from '@/platform/approvals'

export type ApprovalError = PlatformError & { status?: number; field?: string }

/** env: the request's own environment (an approval card in chat may come from another environment than the page's) */
async function call<T>(method: string, path: string, body?: unknown, env?: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { [CSRF_HEADER]: '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...environmentHeaders(), ...(env ? { [ENVIRONMENT_HEADER]: env } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new PlatformError('unavailable', 'The server cannot be reached.')
  }
  if (!res.ok) {
    let b: { error?: { code?: PlatformError['code']; message?: string; field?: string } } | null = null
    try { b = await res.json() } catch { /* not JSON */ }
    const err = new PlatformError(b?.error?.code ?? 'storage', b?.error?.message ?? `The server answered ${res.status}`) as ApprovalError
    Object.assign(err, { status: res.status, ...(b?.error?.field ? { field: b.error.field } : {}) })
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
export type ApprovalView = 'toApprove' | 'sentByMe' | 'involved' | 'all'

export interface LinkInspect { ok: boolean; code?: string; reason?: string; environmentId?: string; response?: string; kind?: string; requireComment?: boolean; request?: ApprovalDetail }

export const approvalsApi = {
  list: (q: { view: ApprovalView; status?: string; q?: string; before?: string; limit?: number; regarding?: string }) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v))
    return call<{ items: ApprovalRequestInfo[]; nextBefore: string | null }>('GET', `/approvals?${p}`)
  },
  get: (id: string) => call<{ request: ApprovalDetail }>('GET', `/approvals/${enc(id)}`),
  create: (b: { id?: string; policy?: string; approvers?: string[] | string; title: string; details?: string; fields?: Record<string, unknown>; regarding?: { table?: string; rowId: string }; source?: 'app' | 'api' }) => call<{ id: string; created: boolean }>('POST', '/approvals', b),
  /** the inbox, the record's Approvals panel and the approval cards in chat all answer here (one rule, on the server) */
  respond: (id: string, response: string, comment?: string, env?: string) => call<{ status: RequestStatus; outcome: string | null }>('POST', `/approvals/${enc(id)}/respond`, { response, comment }, env),
  respondMany: (ids: string[], response: string, comment?: string) => call<{ results: { id: string; ok: boolean; status?: string; error?: string }[] }>('POST', '/approvals/respond-many', { ids, response, comment }),
  answerInfo: (id: string, comment: string) => call<{ ok: true }>('POST', `/approvals/${enc(id)}/info`, { comment }),
  cancel: (id: string, reason?: string) => call<{ ok: true }>('POST', `/approvals/${enc(id)}/cancel`, { reason }),
  reassign: (id: string, to: string, comment?: string, assignmentId?: string) => call<{ ok: true }>('POST', `/approvals/${enc(id)}/reassign`, { to, comment, assignmentId }),
  forRecord: (table: string, row: string) => call<{ items: ApprovalRequestInfo[] }>('GET', `/approvals/record/${enc(table)}/${enc(row)}`),
  inspectLink: (token: string) => call<LinkInspect>('POST', '/approvals/links/inspect', { token }),
  useLink: (token: string, comment?: string) => call<{ status: RequestStatus; outcome: string | null; requestId: string }>('POST', '/approvals/links/use', { token, comment }),
  delegations: (all = false) => call<{ items: DelegationInfo[] }>('GET', `/approvals/delegations${all ? '?all=1' : ''}`),
  delegate: (b: { toUser: string; fromUser?: string; startsOn?: string; endsOn?: string | null; policies?: string[]; note?: string }) => call<{ delegation: DelegationInfo }>('POST', '/approvals/delegations', b),
  cancelDelegation: (id: string) => call<{ ok: true }>('DELETE', `/approvals/delegations/${enc(id)}`),
  policies: () => call<{ items: ApprovalPolicy[] }>('GET', '/approvals/policies'),
  savePolicy: (p: Partial<ApprovalPolicy>) => (p.id ? call<{ policy: ApprovalPolicy }>('PUT', `/approvals/policies/${enc(p.id)}`, p) : call<{ policy: ApprovalPolicy }>('POST', '/approvals/policies', p)),
  deletePolicy: (id: string) => call<{ ok: true }>('DELETE', `/approvals/policies/${enc(id)}`),
  settings: () => call<{ settings: ApprovalSettings }>('GET', '/approvals/settings'),
  saveSettings: (s: Partial<ApprovalSettings>) => call<{ settings: ApprovalSettings }>('PUT', '/approvals/settings', s),
}
