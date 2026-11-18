/**
 * Calls of the event and job kernel (server mode): table events and validation rules, formula checks and test runs,
 * the events run log, jobs and schedules (docs/dev/data-api.md "Table events, jobs and schedules").
 */
import { PlatformError } from '@/platform'
import { API_BASE, CSRF_HEADER } from '@/platform/http'
import { environmentHeaders } from '@/platform/environments'
import type {
  EventRunEntry, EventTestResult, FormulaProblem, JobInfo, JobMetrics, ScheduleInfo, TableEventDef, TableEventInput,
} from '@/platform/events'

export type FormulaRole = 'condition' | 'validation' | 'formulaColumn' | 'before' | 'after'

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
    let b: { error?: { code?: PlatformError['code']; message?: string; field?: string }; problems?: FormulaProblem[] } | null = null
    try { b = await res.json() } catch { /* not JSON */ }
    const err = new PlatformError(b?.error?.code ?? 'storage', b?.error?.message ?? `The server answered ${res.status}`)
    if (b?.error?.field) Object.assign(err, { field: b.error.field })
    if (b?.problems) Object.assign(err, { problems: b.problems })
    throw err
  }
  return (await res.json()) as T
}

const enc = encodeURIComponent

export const listEvents = async (tableId: string) => (await call<{ items: TableEventDef[] }>('GET', `/tables/${enc(tableId)}/events`)).items
export const createEvent = async (tableId: string, e: TableEventInput) => (await call<{ event: TableEventDef }>('POST', `/tables/${enc(tableId)}/events`, e)).event
export const updateEvent = async (tableId: string, id: string, e: TableEventInput) => (await call<{ event: TableEventDef }>('PATCH', `/tables/${enc(tableId)}/events/${enc(id)}`, e)).event
export const deleteEvent = (tableId: string, id: string) => call<{ ok: true }>('DELETE', `/tables/${enc(tableId)}/events/${enc(id)}`)
export const testEvent = (tableId: string, event: TableEventInput, sample: Record<string, unknown>, op: 'create' | 'update' | 'delete' = 'create') =>
  call<EventTestResult>('POST', `/tables/${enc(tableId)}/events/test`, { event, sample, op })
export const checkFormula = async (tableId: string, formula: string, role: FormulaRole) =>
  (await call<{ problems: FormulaProblem[] }>('POST', `/tables/${enc(tableId)}/formula/check`, { formula, role })).problems
export const tableEventRuns = async (tableId: string, limit = 50) => (await call<{ items: EventRunEntry[] }>('GET', `/tables/${enc(tableId)}/event-runs?limit=${limit}`)).items

export const fetchJobs = (q: { state?: string; type?: string; limit?: number; offset?: number } = {}) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v))
  return call<{ items: JobInfo[]; total: number }>('GET', `/admin/jobs${p.toString() ? `?${p}` : ''}`)
}
export const fetchJobMetrics = () => call<JobMetrics>('GET', '/admin/jobs/metrics')
export const retryJob = (id: string) => call<JobInfo>('POST', `/admin/jobs/${enc(id)}/retry`)
export const cancelJob = (id: string) => call<JobInfo>('POST', `/admin/jobs/${enc(id)}/cancel`)
export const fetchSchedules = async () => (await call<{ items: ScheduleInfo[] }>('GET', '/admin/schedules')).items
export const updateSchedule = (id: string, patch: Partial<ScheduleInfo>) => call<ScheduleInfo>('PATCH', `/admin/schedules/${enc(id)}`, patch)
export const runSchedule = (id: string) => call<{ id: string }>('POST', `/admin/schedules/${enc(id)}/run`)
export const fetchEventRuns = async (q: { tableId?: string; status?: string; limit?: number } = {}) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v))
  return (await call<{ items: EventRunEntry[] }>('GET', `/admin/event-runs${p.toString() ? `?${p}` : ''}`)).items
}
