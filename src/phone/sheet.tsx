/**
 * Bottom sheet (P2-A follow-up, docs/dev/phone.md "Touch"): the touch replacement for popovers. Dropdown, ComboBox and
 * PersonPicker open their lists in it on touch devices (sheet-picker.tsx); Dialog and Sheet UI components use the same
 * look and drag handle at phone width. The sheet is drawn in a portal on document.body (so a scaled or clipped app
 * surface cannot break `position: fixed`), sits above the on-screen keyboard (`bottom: var(--kb)`, height limited by
 * `--vvh`, both from src/phone/env.ts) and closes by tapping outside, Escape or dragging the handle down.
 */
import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { dragDismiss } from './touch-logic'
import { useBackClose } from './back'

/** drag-down-to-close on a handle area; `ref` goes on the sheet panel, `handlers` on the handle */
export function useSheetDrag(onClose: () => void) {
  const panel = useRef<HTMLDivElement>(null)
  const start = useRef<{ y: number; t: number } | null>(null)
  const down = (e: ReactPointerEvent<HTMLElement>) => {
    start.current = { y: e.clientY, t: Date.now() }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* not capturable: the drag still works while the pointer stays over the handle */ }
  }
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const s = start.current
    if (!s || !panel.current) return
    panel.current.style.transition = 'none'
    panel.current.style.transform = `translateY(${Math.max(0, e.clientY - s.y)}px)`
  }
  const up = (e: ReactPointerEvent<HTMLElement>) => {
    const s = start.current
    start.current = null
    if (!s) return
    const dy = e.clientY - s.y
    if (dragDismiss(dy, Date.now() - s.t)) {
      onClose()
    } else if (panel.current) {
      panel.current.style.transition = 'transform 160ms ease-out'
      panel.current.style.transform = ''
    }
  }
  return { ref: panel, handlers: { onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: up } }
}

/** the grab handle row of a sheet (a visual bar, a 44 px drag area) */
export function SheetHandle({ handlers }: { handlers: ReturnType<typeof useSheetDrag>['handlers'] }) {
  return (
    <div className="ab-sheet-grab" data-testid="bottom-sheet-handle" {...handlers}>
      <span aria-hidden="true" />
    </div>
  )
}

export function BottomSheet({
  open,
  onClose,
  label,
  title,
  children,
  footer,
  style,
}: {
  open: boolean
  onClose: () => void
  /** accessible name of the dialog */
  label: string
  /** visible heading (optional) */
  title?: string
  children: ReactNode
  footer?: ReactNode
  style?: CSSProperties
}) {
  const drag = useSheetDrag(onClose)
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
  // Android Back closes the sheet instead of leaving the app (back.ts)
  useBackClose(open, onClose)
  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <div className="ab-sheet-backdrop" data-testid="bottom-sheet-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={drag.ref} role="dialog" aria-modal="true" aria-label={label} className="ab-sheet ab-sheet-enter" data-testid="bottom-sheet" style={style}>
        <SheetHandle handlers={drag.handlers} />
        {title && <div className="ab-sheet-title">{title}</div>}
        <div className="ab-sheet-body">{children}</div>
        {footer && <div className="ab-sheet-footer ab-sheet-pad-bottom">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
