/**
 * Calls of print templates (server mode; docs/dev/data-api.md "Print templates"). The designer, the Print button UI
 * component, Print / GeneratePdf / GenerateDocx in formulas, the record timeline and the solution picker use these.
 */
import { PlatformError } from '@/platform'
import { API_BASE, CSRF_HEADER } from '@/platform/http'
import { environmentHeaders, withEnvironment } from '@/platform/environments'
import type { BlockDoc, GeneratedFile, PrintRunInfo, PrintSettings, PrintTemplateDoc, PrintTemplateFull, PrintTemplateInfo } from '@/platform/print'

export type PrintError = PlatformError & { status?: number; field?: string }

async function raw(method: string, path: string, body?: unknown): Promise<Response> {
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
    let b: { error?: { code?: PlatformError['code']; message?: string; field?: string } } | null = null
    try { b = await res.json() } catch { /* not JSON */ }
    const err = new PlatformError(b?.error?.code ?? 'storage', b?.error?.message ?? `The server answered ${res.status}`) as PrintError
    Object.assign(err, { status: res.status, ...(b?.error?.field ? { field: b.error.field } : {}) })
    throw err
  }
  return res
}
const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => (await (await raw(method, path, body)).json()) as T
const enc = encodeURIComponent

export interface BuiltinInfo { key: string; name: string; description: string; needsTable: boolean; expects: string }
export interface PrintCatalog { blocks: BlockDoc[]; functions: string[]; builtins: BuiltinInfo[]; limits: Record<string, number>; empty: PrintTemplateDoc }
/** url: a blob (download link); frameUrl: the same file from the server (the page's CSP allows same-origin frames, not blob ones) */
export interface PreviewResult { url: string; frameUrl: string; pages: number; warnings: string[]; runId: string; bytes: number }

/** a file token chosen here (GeneratePdf returns it at once; the server stores the file under it) */
export function newFileToken(): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const r = new Uint8Array(24)
  crypto.getRandomValues(r)
  return 'gen_' + [...r].map((x) => abc[x % abc.length]).join('')
}

export const printApi = {
  catalog: () => call<PrintCatalog>('GET', '/print/catalog'),
  settings: () => call<{ settings: PrintSettings }>('GET', '/print/settings'),
  saveSettings: (s: PrintSettings) => call<{ settings: PrintSettings }>('PUT', '/print/settings', s),
  list: (table?: string) => call<{ items: PrintTemplateInfo[] }>('GET', `/print/templates${table ? `?table=${enc(table)}` : ''}`),
  get: (id: string) => call<{ template: PrintTemplateFull }>('GET', `/print/templates/${enc(id)}`),
  create: (b: { name: string; description?: string; kind?: 'pdf' | 'docx'; doc?: PrintTemplateDoc; docxBase64?: string; docxFileName?: string }) => call<{ template: PrintTemplateFull }>('POST', '/print/templates', b),
  fromBuiltin: (key: string, table?: string, name?: string) => call<{ template: PrintTemplateFull }>('POST', '/print/builtins', { key, ...(table ? { table } : {}), ...(name ? { name } : {}) }),
  save: (id: string, b: { name?: string; description?: string; doc?: PrintTemplateDoc; publish?: boolean; note?: string; docxBase64?: string; docxFileName?: string }) => call<{ template: PrintTemplateFull }>('PUT', `/print/templates/${enc(id)}`, b),
  publish: (id: string, note?: string) => call<{ template: PrintTemplateFull }>('POST', `/print/templates/${enc(id)}/publish`, { note }),
  versions: (id: string) => call<{ items: { version: number; savedBy: string | null; savedOn: string; note: string | null }[] }>('GET', `/print/templates/${enc(id)}/versions`),
  restore: (id: string, version: number) => call<{ template: PrintTemplateFull }>('POST', `/print/templates/${enc(id)}/restore`, { version }),
  copy: (id: string, name: string) => call<{ template: PrintTemplateFull }>('POST', `/print/templates/${enc(id)}/copy`, { name }),
  remove: (id: string) => call<{ ok: true }>('DELETE', `/print/templates/${enc(id)}`),
  runs: (templateId?: string) => call<{ items: PrintRunInfo[] }>('GET', `/print/runs${templateId ? `?templateId=${enc(templateId)}` : ''}`),
  run: (id: string) => call<{ run: PrintRunInfo }>('GET', `/print/runs/${enc(id)}`),
  generate: (template: string, recordId: string | undefined, token?: string) => call<{ file: GeneratedFile }>('POST', '/print/generate', { template, ...(recordId ? { recordId } : {}), ...(token ? { token } : {}), source: 'app' }),
  toDocuments: (template: string, recordId: string, numberSequence?: string) => call<{ documentId: string; name: string; file: GeneratedFile }>('POST', `/print/templates/${enc(template)}/documents`, { recordId, ...(numberSequence ? { numberSequence } : {}) }),
  bulk: (template: string, recordIds: string[], mode: 'zip' | 'merged') => call<{ runId: string; jobId: string }>('POST', '/print/bulk', { template, recordIds, mode }),
  /** the draft (or an unsaved document) as a PDF object URL */
  async preview(id: string, recordId: string | undefined, doc?: PrintTemplateDoc): Promise<PreviewResult> {
    const res = await raw('POST', `/print/templates/${enc(id)}/preview`, { ...(recordId ? { recordId } : {}), ...(doc ? { doc } : {}) })
    const blob = await res.blob()
    let warnings: string[] = []
    try { warnings = JSON.parse(decodeURIComponent(res.headers.get('X-Print-Warnings') ?? '%5B%5D')) } catch { /* none */ }
    const token = res.headers.get('X-Print-Token') ?? ''
    return { url: URL.createObjectURL(blob), frameUrl: token ? printApi.fileUrl(token) : '', pages: Number(res.headers.get('X-Print-Pages') ?? 0), warnings, runId: res.headers.get('X-Print-Run') ?? '', bytes: blob.size }
  },
  /** the address of a generated file (opens in a tab: the environment travels in the query) */
  fileUrl: (token: string, download = false) => withEnvironment(`${API_BASE}/print/files/${enc(token)}${download ? '?download=1' : ''}`),
  /** the published template for a record, inline */
  pdfUrl: (template: string, recordId?: string, download = false) => withEnvironment(`${API_BASE}/print/templates/${enc(template)}/pdf?source=app${recordId ? `&recordId=${enc(recordId)}` : ''}${download ? '&download=1' : ''}`),
}
