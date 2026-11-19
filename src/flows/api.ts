/**
 * Calls of the flow runtime (server mode; docs/dev/data-api.md "Flows"). The Flows page and the visual designer
 * (package B) use these; the types are the shared ones of src/platform/flows.ts.
 */
import { PlatformError } from '@/platform'
import { API_BASE, CSRF_HEADER } from '@/platform/http'
import { environmentHeaders } from '@/platform/environments'
import type {
  FlowDef, FlowListItem, FlowRunDetail, FlowRunInfo, FlowVersionInfo, StepKindDoc, TriggerTypeDoc, ValidationProblem,
} from '@/platform/flows'

export type FlowError = PlatformError & { problems?: ValidationProblem[]; field?: string; status?: number }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { [CSRF_HEADER]: '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...environmentHeaders() },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new PlatformError('unavailable', 'The server cannot be reached.')
  }
  if (!res.ok) {
    let b: { error?: { code?: PlatformError['code']; message?: string; field?: string }; problems?: ValidationProblem[] } | null = null
    try { b = await res.json() } catch { /* not JSON */ }
    const err = new PlatformError(b?.error?.code ?? 'storage', b?.error?.message ?? `The server answered ${res.status}`) as FlowError
    Object.assign(err, { status: res.status, ...(b?.error?.field ? { field: b.error.field } : {}), ...(b?.problems ? { problems: b.problems } : {}) })
    throw err
  }
  return (await res.json()) as T
}

const enc = encodeURIComponent

export interface FlowCatalog { steps: StepKindDoc[]; triggers: TriggerTypeDoc[]; limits: Record<string, number>; /** an approvals service is registered (package C) */ approvals?: boolean }
export interface FlowDraft { doc: FlowInput & Record<string, unknown>; connections: Record<string, string>; baseVersion: number; savedBy?: string; savedByName?: string; savedOn: string }
export interface WebhookInfo { id: string; flowId: string; name: string | null; tokenHint: string; hasSecret: boolean; requireSignature: boolean; toleranceSeconds: number; maxBodyKB: number; perMinute: number; enabled: boolean; createdOn: string; rotatedOn: string | null; lastUsedOn: string | null; calls: number; rejected: number; urlPrefix: string }
export interface WebhookCreated { hook: WebhookInfo; token?: string; secret?: string; url?: string; note?: string }

export interface EnvFlowSettings { paused: boolean; pausedBy?: string; pausedOn?: string; environmentRunsPerMinute: number }
/** what the editor sends: the definition plus name, description, runAs, connections (ref -> connection id) */
export type FlowInput = Partial<Omit<FlowDef, 'connections'>> & { connections?: Record<string, string>; confirmRunAs?: boolean; note?: string }

export const flowsApi = {
  list: () => call<{ items: FlowListItem[]; settings: EnvFlowSettings }>('GET', '/flows'),
  catalog: () => call<FlowCatalog>('GET', '/flows/catalog'),
  /** the designer's unpublished draft (package B) */
  draft: (id: string) => call<{ draft: FlowDraft | null }>('GET', `/flows/${enc(id)}/draft`),
  saveDraft: (id: string, flow: unknown, connections: Record<string, string>, baseVersion: number) => call<{ draft: FlowDraft }>('PUT', `/flows/${enc(id)}/draft`, { flow, connections, baseVersion }),
  discardDraft: (id: string) => call<{ ok: true }>('DELETE', `/flows/${enc(id)}/draft`),
  schedulePreview: (b: { cron?: string; everyMinutes?: number; timeZone: string }) => call<{ next: string[]; description?: string; error?: string }>('POST', '/flows/schedule-preview', b),
  webhooks: (flowId: string) => call<{ items: WebhookInfo[] }>('GET', `/flows/${enc(flowId)}/webhooks`),
  createWebhook: (flowId: string, b: { name?: string; requireSignature?: boolean } = {}) => call<WebhookCreated>('POST', `/flows/${enc(flowId)}/webhooks`, b),
  updateWebhook: (id: string, b: { enabled?: boolean; requireSignature?: boolean; name?: string }) => call<WebhookInfo>('PATCH', `/webhooks/${enc(id)}`, b),
  rotateWebhook: (id: string, b: { token?: boolean; secret?: boolean }) => call<{ token?: string; secret?: string; url?: string }>('POST', `/webhooks/${enc(id)}/rotate`, b),
  revokeWebhook: (id: string) => call<{ ok: true }>('DELETE', `/webhooks/${enc(id)}`),
  get: (id: string) => call<{ flow: FlowDef; canEdit: boolean; canRun: boolean }>('GET', `/flows/${enc(id)}`),
  create: (f: FlowInput) => call<{ flow: FlowDef; problems: ValidationProblem[] }>('POST', '/flows', f),
  save: (id: string, f: FlowInput) => call<{ flow: FlowDef; problems: ValidationProblem[] }>('PUT', `/flows/${enc(id)}`, f),
  validate: (f: FlowInput & { id?: string }) => call<{ problems: ValidationProblem[] }>('POST', '/flows/validate', f),
  remove: (id: string) => call<{ ok: true }>('DELETE', `/flows/${enc(id)}`),
  enable: (id: string, on: boolean) => call<{ flow: FlowDef }>('POST', `/flows/${enc(id)}/${on ? 'enable' : 'disable'}`),
  versions: (id: string) => call<{ items: FlowVersionInfo[]; current: number }>('GET', `/flows/${enc(id)}/versions`),
  version: (id: string, v: number) => call<{ version: number; doc: unknown }>('GET', `/flows/${enc(id)}/versions/${v}`),
  restore: (id: string, v: number, confirmRunAs = false) => call<{ flow: FlowDef }>('POST', `/flows/${enc(id)}/versions/${v}/restore`, { confirmRunAs }),
  run: (id: string, inputs: Record<string, unknown>) => call<{ runId: string; status: string }>('POST', `/flows/${enc(id)}/run`, { inputs, source: 'portal' }),
  test: (id: string, body: { trigger?: unknown; inputs?: Record<string, unknown>; dryRun?: boolean; definition?: unknown; approvalOutcome?: string }) => call<{ runId: string; dryRun: boolean }>('POST', `/flows/${enc(id)}/test`, body),
  runs: (q: { flowId?: string; status?: string; mode?: string; before?: string; limit?: number } = {}) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v))
    return call<{ items: FlowRunInfo[]; nextBefore: string | null }>('GET', `/flows/runs${p.toString() ? `?${p}` : ''}`)
  },
  runDetail: (runId: string) => call<{ run: FlowRunDetail; summaryOnly?: boolean }>('GET', `/flows/runs/${enc(runId)}`),
  cancel: (runId: string) => call<{ ok: true }>('POST', `/flows/runs/${enc(runId)}/cancel`),
  resubmit: (runId: string, from: 'start' | 'failed') => call<{ runId: string }>('POST', `/flows/runs/${enc(runId)}/resubmit`, { from }),
  permissions: (id: string) => call<{ roleIds: string[] }>('GET', `/flows/${enc(id)}/permissions`),
  setPermissions: (id: string, roleIds: string[]) => call<{ roleIds: string[] }>('PUT', `/flows/${enc(id)}/permissions`, { roleIds }),
  settings: () => call<EnvFlowSettings>('GET', '/flows/settings'),
  setPaused: (paused: boolean) => call<EnvFlowSettings>('PUT', '/flows/settings', { paused }),
}

/** the document the editor shows: what a maker changes, connections as ref -> connection id */
export function editable(f: FlowDef): Record<string, unknown> {
  return {
    name: f.name, description: f.description ?? '', runAs: f.runAs, trigger: f.trigger, variables: f.variables ?? [], settings: f.settings, steps: f.steps,
    connections: Object.fromEntries(f.connections.map((c) => [c.ref, c.connectionId])),
  }
}
