/**
 * Sticky action bar (P2-A follow-up): the Form's save bar on phones. It stays in the form's box, but when the bottom of
 * the form is not on screen (the on-screen keyboard covers it, or the form is taller than the screen) while a useful part
 * of the form is, the bar is pinned to the bottom of the visible screen (above the keyboard: `bottom: var(--kb)`). A
 * placeholder of the same height keeps the form's layout. The decision is `barPinned` (touch-logic.ts).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { barPinned } from './touch-logic'

export function StickyBar({ boxRef, children, className, active }: { boxRef: RefObject<HTMLElement | null>; children: ReactNode; className?: string; active: boolean }) {
  const slot = useRef<HTMLDivElement>(null)
  const [pin, setPin] = useState<{ left: number; width: number; height: number; lift: number } | null>(null)
  const [h, setH] = useState(56)

  useLayoutEffect(() => {
    if (!pin && slot.current) setH(slot.current.offsetHeight || 56)
  })

  useEffect(() => {
    if (!active) {
      setPin(null)
      return
    }
    let raf = 0
    const run = () => {
      raf = 0
      const box = boxRef.current
      if (!box) return
      const r = box.getBoundingClientRect()
      const vv = window.visualViewport
      const viewTop = vv ? vv.offsetTop : 0
      const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight
      const on = barPinned({ formTop: r.top, formBottom: r.bottom, barHeight: h, viewTop, viewBottom })
      setPin((o) => {
        if (!on) return o === null ? o : null
        const left = Math.max(0, r.left)
        const width = Math.min(r.right, window.innerWidth) - left
        // the shell's own bottom strip (offline / waiting-to-send bar) stays visible: the bar sits above it
        const cb = document.querySelector('[data-testid="connection-bar"]')?.getBoundingClientRect()
        const lift = cb && cb.height > 0 && cb.bottom >= window.innerHeight - 2 ? Math.round(cb.height) : 0
        return o && o.left === left && o.width === width && o.height === h && o.lift === lift ? o : { left, width, height: h, lift }
      })
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(run) }
    run()
    // the shell's bottom strip appears and disappears without a scroll or resize
    const mo = new MutationObserver(schedule)
    mo.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      mo.disconnect()
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
    }
  }, [active, boxRef, h])

  if (pin && typeof document !== 'undefined') {
    return (
      <div ref={slot} className="shrink-0" style={{ height: pin.height }} data-sticky-slot="">
        {createPortal(
          <div className={className} data-sticky-bar="pinned" data-testid="form-sticky-bar" style={{ position: 'fixed', left: pin.left, width: pin.width, bottom: `max(var(--kb, 0px), ${pin.lift}px)`, zIndex: 150, boxShadow: '0 -4px 12px rgba(0,0,0,0.10)' }}>
            {children}
          </div>,
          document.body,
        )}
      </div>
    )
  }
  return (
    <div ref={slot} className={cn('shrink-0', className)} data-sticky-bar={active ? 'inline' : undefined}>
      {children}
    </div>
  )
}
