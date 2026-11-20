/**
 * Sharing a generated PDF on a phone (docs/dev/pdf.md "Surfaces"). The Web Share API needs a user activation (a tap)
 * that is still fresh, and Print's tap is used up by the time the server has made the file. So once the file has
 * arrived, a small bar offers "Share" (navigator.share with the file, inside that new tap) and "Download". Where the
 * browser cannot share files (navigator.canShare says no, or there is no Web Share), Print downloads as before.
 * Plain DOM (no React): Print is called from formulas, outside any component.
 */

export interface ShareNavigator {
  share?: (data: { files?: File[]; title?: string }) => Promise<void>
  canShare?: (data: { files?: File[] }) => boolean
}

/** can this browser share this file? (canShare is required: share without it may not accept files) */
export function canShareFile(nav: ShareNavigator | undefined, file: File): boolean {
  if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false
  try {
    return nav.canShare({ files: [file] })
  } catch {
    return false
  }
}

/** what a tap on Share does: 'shared', 'cancelled' (the person closed the share sheet) or 'failed' (then download) */
export async function shareFile(nav: ShareNavigator, file: File): Promise<'shared' | 'cancelled' | 'failed'> {
  try {
    await nav.share!({ files: [file], title: file.name })
    return 'shared'
  } catch (e) {
    return (e as { name?: string })?.name === 'AbortError' ? 'cancelled' : 'failed'
  }
}

/** saves an object URL as a file (the browser offers to open or share it) */
export function downloadUrl(url: string, name: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
}

const BAR_ID = 'ab-print-share'

/**
 * Shows "<name> is ready  [Share] [Download] [x]" at the bottom of the screen. Share runs inside its own tap; if sharing
 * fails (not cancelled) the file is downloaded. The bar closes after an action, on Escape or after two minutes.
 */
export function offerShare(file: File, url: string): void {
  document.getElementById(BAR_ID)?.remove()
  const bar = document.createElement('div')
  bar.id = BAR_ID
  bar.setAttribute('role', 'dialog')
  bar.setAttribute('aria-label', `${file.name} is ready`)
  bar.className = 'fixed inset-x-2 bottom-2 z-[1000] flex items-center gap-2 rounded-lg border bg-popover p-2 pl-3 text-sm text-popover-foreground shadow-lg'
  bar.style.paddingBottom = 'max(0.5rem, env(safe-area-inset-bottom))'
  const label = document.createElement('span')
  label.className = 'min-w-0 flex-1 truncate'
  label.textContent = `${file.name} is ready`
  const button = (text: string, primary: boolean) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = text
    b.className = primary
      ? 'h-9 rounded-md bg-primary px-3 font-medium text-primary-foreground'
      : 'h-9 rounded-md border px-3 font-medium'
    return b
  }
  const share = button('Share', true)
  share.dataset.testid = 'print-share'
  const save = button('Download', false)
  save.dataset.testid = 'print-download'
  const close = button('×', false)
  close.setAttribute('aria-label', 'Close')
  const done = () => {
    clearTimeout(timer)
    document.removeEventListener('keydown', onKey)
    bar.remove()
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') done() }
  const timer = setTimeout(done, 120_000)
  share.onclick = async () => {
    share.disabled = true
    const r = await shareFile(navigator as unknown as ShareNavigator, file)
    if (r === 'failed') downloadUrl(url, file.name)
    if (r === 'cancelled') { share.disabled = false; return }
    done()
  }
  save.onclick = () => { downloadUrl(url, file.name); done() }
  close.onclick = done
  document.addEventListener('keydown', onKey)
  bar.append(label, share, save, close)
  document.body.appendChild(bar)
  share.focus()
}
