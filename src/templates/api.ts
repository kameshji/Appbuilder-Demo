/**
 * Browser calls of the templates catalogue (server mode only; docs/dev/templates.md "Routes"). Same conventions as
 * src/portal/environmentApi.ts: same-origin session, CSRF header, the current environment's header.
 */
import { PlatformError } from '@/platform'
import { API_BASE, CSRF_HEADER } from '@/platform/http'
import { environmentHeaders } from '@/platform/environments'
import { getJson, toError } from '@/portal/serverApi'
import type {
  TemplateDetail, TemplateInstallRecord, TemplateInstallResult, TemplatePlanResponse, TemplateSummary, TemplateUseRequest, UninstallPlan, UpgradePlan,
} from './format'

async function send<T>(path: string, body: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: 'POST', credentials: 'same-origin',
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

export const fetchCatalogue = async (): Promise<TemplateSummary[]> => (await getJson<{ items: TemplateSummary[] }>('/templates')).items
export const fetchTemplate = (id: string): Promise<TemplateDetail> => getJson<TemplateDetail>(`/templates/${enc(id)}`)
export const fetchInstalled = async (): Promise<TemplateInstallRecord[]> => (await getJson<{ items: TemplateInstallRecord[] }>('/templates/installed')).items
export const planTemplate = (id: string, req: TemplateUseRequest): Promise<TemplatePlanResponse> => send(`/templates/${enc(id)}/plan`, req)
export const installTemplate = (id: string, req: TemplateUseRequest): Promise<TemplateInstallResult> => send(`/templates/${enc(id)}/install`, req)
export const planUninstall = (installId: string, deleteTables: boolean): Promise<UninstallPlan> => send(`/templates/installed/${enc(installId)}/uninstall/plan`, { deleteTables })
export const uninstall = (installId: string, b: { confirm: string; deleteTables: boolean; confirmText?: string; proceedWithoutBackup?: boolean }): Promise<UninstallPlan> => send(`/templates/installed/${enc(installId)}/uninstall`, b)
export const planUpgrade = (installId: string, choices: Record<string, 'keep' | 'replace'>): Promise<UpgradePlan> => send(`/templates/installed/${enc(installId)}/upgrade/plan`, { choices })
export const upgrade = (installId: string, b: { confirm: string; choices: Record<string, 'keep' | 'replace'>; proceedWithoutBackup?: boolean }): Promise<UpgradePlan> => send(`/templates/installed/${enc(installId)}/upgrade`, b)
/** format 2: "Switch on these flows" (administrators) */
export const enableFlows = async (installId: string, enable: string[]): Promise<TemplateInstallRecord> => (await send<{ install: TemplateInstallRecord }>(`/templates/installed/${enc(installId)}/flows`, { enable })).install
/** format 2: "Remove sample data" */
export const removeSample = (installId: string): Promise<{ install: TemplateInstallRecord; removed: number; kept: { table: string; id: string; reason: string }[] }> => send(`/templates/installed/${enc(installId)}/sample/remove`, {})
