/**
 * Calls of the flow runtime (server mode; docs/dev/data-api.md "Flows"). The Flows page and, later, the visual designer
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

export interface EnvFlowSettings { paused: boolean; pausedBy?: string; pausedOn?: string; environmentRunsPerMinute: number }
/** what the editor sends: the definition plus name, description, runAs, connections (ref -> connection id) */
export type FlowInput = Partial<Omit<FlowDef, 'connections'>> & { connections?: Record<string, string>; confirmRunAs?: boolean; note?: string }

export const flowsApi = {
  list: () => call<{ items: FlowListItem[]; settings: EnvFlowSettings }>('GET', '/flows'),
  catalog: () => call<{ steps: StepKindDoc[]; triggers: TriggerTypeDoc[]; limits: Record<string, number> }>('GET', '/flows/catalog'),
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

/** a new flow to start from in the JSON editor */
export const FLOW_TEMPLATE = {
  name: 'New flow',
  description: '',
  runAs: 'owner',
  trigger: { type: 'manual', inputs: [{ name: 'Message', type: 'text', required: true }], from: 'any' },
  variables: [],
  settings: { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' },
  steps: [
    { id: 'compose', name: 'Greeting', kind: 'compose', value: '"Hello " & Trigger.Inputs.Message' },
    { id: 'reply', name: 'Reply', kind: 'respond', body: '{Text: Steps.Greeting.Output}' },
  ],
  connections: {},
}

/** the document the editor shows: what a maker changes, connections as ref -> connection id */
export function editable(f: FlowDef): Record<string, unknown> {
  return {
    name: f.name, description: f.description ?? '', runAs: f.runAs, trigger: f.trigger, variables: f.variables ?? [], settings: f.settings, steps: f.steps,
    connections: Object.fromEntries(f.connections.map((c) => [c.ref, c.connectionId])),
  }
}
