/**
 * Touch-area forwarding (P2-A): a UI component smaller than 44 x 44 px has an invisible touch area around its wrapper
 * (phone.css `[data-hit]::after`). A tap on that area targets the wrapper element itself; this forwards it to the
 * component's control nearest to the tap (a star of a rating, a page button of a pagination): text fields get the
 * focus, everything else a click. Installed once (start.ts).
 */
const INTERACTIVE = 'input:not([type=hidden]), textarea, select, button, a[href], [role=button], [role=checkbox], [role=switch], [role=radio], [role=tab], [role=combobox], [role=slider], [tabindex]:not([tabindex="-1"])'

export interface Box { left: number; top: number; right: number; bottom: number }

/** index of the box nearest to (x, y); 0 distance inside a box. Pure (unit-tested). */
export function nearestBox(boxes: Box[], x: number, y: number): number {
  let bi = -1
  let bd = Infinity
  boxes.forEach((b, i) => {
    const dx = x < b.left ? b.left - x : x > b.right ? x - b.right : 0
    const dy = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0
    const d = dx * dx + dy * dy
    if (d < bd) {
      bd = d
      bi = i
    }
  })
  return bi
}

let installed = false
export function installHitForwarding(): () => void {
  if (installed || typeof document === 'undefined') return () => {}
  installed = true
  const onClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement | null
    if (!t || !t.hasAttribute?.('data-hit') || !t.closest('[data-run-surface]')) return
    const candidates = [...t.querySelectorAll<HTMLElement>(INTERACTIVE)].filter((el) => !el.closest('[disabled]') && el.getClientRects().length > 0)
    const i = nearestBox(candidates.map((el) => el.getBoundingClientRect()), e.clientX, e.clientY)
    if (i < 0) return
    const inner = candidates[i]
    e.preventDefault()
    e.stopPropagation()
    if (inner.matches('input:not([type=checkbox]):not([type=radio]), textarea, select')) inner.focus()
    else inner.click()
  }
  document.addEventListener('click', onClick, true)
  return () => {
    installed = false
    document.removeEventListener('click', onClick, true)
  }
}
