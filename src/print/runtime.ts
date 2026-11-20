/**
 * Print / GeneratePdf / GenerateDocx of formulas (P2-B; the host in src/runtime/host.ts calls these). Print fetches the
 * PDF made by GET /print/templates/:id/pdf and shows it in a new tab (the browser's PDF viewer prints it); on a phone a
 * bar offers Share (Web Share with the file, in a new tap: share.ts) and Download, or the file is downloaded when the
 * browser cannot share files. GeneratePdf posts with a token chosen by the
 * host (after pending writes, waiting at most 1.5 s for them), so a Patch of the token finds the file: the server holds
 * a write of a token that is still being made (at most 90 s).
 */
import { platform } from '@/platform'
import { errorMessage, notifyAsyncError, platformMode } from '@/runtime/data'
import { newFileToken, printApi } from './api'
import { canShareFile, downloadUrl, offerShare, type ShareNavigator } from './share'

export { newFileToken }

const isPhone = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches && window.innerWidth < 820

export async function printCall(template: string, recordId: string | null): Promise<void> {
  // the tab is opened at once (still inside the click, so pop-up blockers allow it) and gets the PDF when it is made:
  // errors become a message in the app instead of an error page, and nothing between (a service worker, a proxy page)
  // can answer the navigation with something else
  const phone = isPhone()
  const w = phone ? null : window.open('', '_blank')
  try {
    if (platformMode() !== 'server') throw new Error('Print templates are made on the server; they are not available in demo mode.')
    if (!phone && !w) throw new Error('The browser blocked the new tab; allow pop-ups for this site.')
    const res = await fetch(printApi.pdfUrl(template, recordId ?? undefined), { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Appbuilder': '1' } })
    if (!res.ok) {
      const b = await res.json().catch(() => null) as { error?: { message?: string } } | null
      throw new Error(b?.error?.message ?? `The server answered ${res.status}`)
    }
    const name = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get('Content-Disposition') ?? '')?.[1]
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000)
    if (w) {
      try { w.opener = null } catch { /* already detached */ }
      w.location.href = url
      return
    }
    // a phone: Print's tap is used up by now, so sharing waits for a new tap on "Share"; without file sharing, download
    const fileName = name ? decodeURIComponent(name) : `${template}.pdf`
    const file = new File([blob], fileName, { type: blob.type || 'application/pdf' })
    if (canShareFile(navigator as unknown as ShareNavigator, file)) offerShare(file, url)
    else downloadUrl(url, fileName)
  } catch (e) {
    w?.close()
    notifyAsyncError(`Print: ${errorMessage(e)}`)
  }
}

export async function generateFileCall(kind: 'pdf' | 'docx', template: string, recordId: string | null, token: string): Promise<void> {
  try {
    if (platformMode() !== 'server') throw new Error('Print templates are made on the server; they are not available in demo mode.')
    // a record the same formula just wrote should be stored before the server reads it, but not for long: a pending
    // write may be the Patch that puts this very token into a file column, which the server holds until the file exists
    await Promise.race([platform.tables.flush().catch(() => {}), new Promise((r) => setTimeout(r, 1500))])
    const r = await printApi.generate(template, recordId ?? undefined, token)
    if (kind === 'docx' && !r.file.fileName.endsWith('.docx')) notifyAsyncError(`GenerateDocx: "${template}" is not a Word template; a PDF was made.`)
    if (kind === 'pdf' && !r.file.fileName.endsWith('.pdf')) notifyAsyncError(`GeneratePdf: "${template}" is a Word template; a Word file was made.`)
  } catch (e) {
    notifyAsyncError(`${kind === 'pdf' ? 'GeneratePdf' : 'GenerateDocx'}: ${errorMessage(e)}`)
  }
}
