/**
 * Small React hooks of the touch behaviour (docs/dev/phone.md "Touch"). The decisions are in touch-logic.ts.
 */
import { useEffect, useState, type RefObject } from 'react'

/** the width (px) of an element, kept up to date (0 until measured and where ResizeObserver is missing) */
export function useBoxWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setW((o) => (Math.abs(o - el.clientWidth) < 1 ? o : el.clientWidth))
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}

/**
 * Whether the app tab an element belongs to is the one on screen. Open apps stay mounted in hidden tab panels
 * (`role=tabpanel`, `aria-hidden`); anything drawn in a portal on document.body (a bottom sheet) must follow that, or an
 * open Dialog of a background app would show over the app in front. True outside tab panels.
 */
export function usePaneVisible(ref: RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const pane = ref.current?.closest<HTMLElement>('[role=tabpanel]')
    if (!pane) return
    const update = () => setVisible(pane.getAttribute('aria-hidden') !== 'true')
    update()
    const mo = new MutationObserver(update)
    mo.observe(pane, { attributes: true, attributeFilter: ['aria-hidden', 'class'] })
    return () => mo.disconnect()
  }, [ref])
  return visible
}
