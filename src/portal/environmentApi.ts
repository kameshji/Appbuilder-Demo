/**
 * Server calls for managing environments and moving solutions between them (no PlatformApi method: server mode only).
 * Shapes in src/platform/http.ts; the routes are documented in docs/dev/data-api.md "Environments".
 */
import { PlatformError, platform } from '@/platform'
import {
  API_BASE, CSRF_HEADER, type AuditPageResponse, type EnvironmentAccessEntry, type EnvironmentCreateRequest, type EnvironmentDetails,
  type EnvironmentsResponse, type SolutionImportResult, type SolutionPlan,
} from '@/platform/http'
import type { EnvironmentDef } from '@/platform'
import { environmentHeaders } from '@/platform/environments'
import { auditSearch, getJson, toError, type AuditQuery } from './serverApi'

async function send<T>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'same-origin',
      headers: { [CSRF_HEADER]: '1', 'Content-Type': 'application/json', ...environmentHeaders() },
      body: JSON.stringify(body ?? {}),
    })
  } catch {
    throw new PlatformError('unavailable', 'The server cannot be reached.')
  }
  if (!res.ok) throw await toError(res)
  return (await res.json()) as T
}

const enc = encodeURIComponent

/** the list with the limit and whether the caller may create one */
export const fetchEnvironments = (): Promise<EnvironmentsResponse> => getJson<EnvironmentsResponse>('/environments')
export const fetchEnvironment = (id: string): Promise<EnvironmentDetails> => getJson<EnvironmentDetails>(`/environments/${enc(id)}`)

async function refreshList(): Promise<void> {
  await platform.environments.list().catch(() => [])
}

export async function createEnvironment(input: EnvironmentCreateRequest): Promise<EnvironmentDef> {
  const env = await send<EnvironmentDef>('POST', '/environments', input)
  await refreshList()
  return env
}

export async function updateEnvironment(id: string, patch: { name?: string; description?: string; type?: EnvironmentDef['type']; locked?: boolean }): Promise<EnvironmentDef> {
  const env = await send<EnvironmentDef>('PATCH', `/environments/${enc(id)}`, patch)
  await refreshList()
  return env
}

/** confirmName: the environment's name, typed by the administrator */
export async function deleteEnvironment(id: string, confirmName: string): Promise<void> {
  await send('DELETE', `/environments/${enc(id)}`, { confirmName })
  await refreshList()
}

export const fetchAccess = async (id: string): Promise<EnvironmentAccessEntry[]> => (await getJson<{ items: EnvironmentAccessEntry[] }>(`/environments/${enc(id)}/access`)).items
export const grantAccess = (id: string, userId: string, isEnvAdmin?: boolean): Promise<unknown> => send('PUT', `/environments/${enc(id)}/access/${enc(userId)}`, isEnvAdmin === undefined ? {} : { isEnvAdmin })
export const revokeAccess = (id: string, userId: string): Promise<unknown> => send('DELETE', `/environments/${enc(id)}/access/${enc(userId)}`)

/** install-level audit (environments, install administrators, deployments) */
export const fetchInstallAuditPage = (q: AuditQuery): Promise<AuditPageResponse> => getJson<AuditPageResponse>(`/install/audit${auditSearch(q)}`)

/* ------------------------------------------------------------------ solutions between environments */

/** what importing this package into the current environment would do */
export const planImport = (yaml: string, opts: { asCopy?: boolean } = {}): Promise<SolutionPlan> => send<SolutionPlan>('POST', '/solutions/import/plan', { yaml, ...(opts.asCopy ? { asCopy: true } : {}) })

/** import (install, or the upgrade confirmed by the plan's token) into the current environment; reloads the workspace */
export const importWithPlan = (yaml: string, opts: { confirm?: string; asCopy?: boolean; filesAs?: 'database' | 'file' } = {}) => platform.solutions.importPackage(yaml, opts)

/** the plan of deploying a solution of the current environment into `target` */
export const planDeploy = (solutionId: string, target: string, includeData = false): Promise<SolutionPlan> =>
  send<SolutionPlan>('POST', `/solutions/${enc(solutionId)}/deploy`, { target, plan: true, includeData })

export const deploy = (solutionId: string, target: string, confirm: string, includeData = false): Promise<SolutionImportResult> =>
  send<SolutionImportResult>('POST', `/solutions/${enc(solutionId)}/deploy`, { target, confirm, includeData })
