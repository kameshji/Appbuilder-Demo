/**
 * Android Back gesture for bottom sheets (docs/dev/phone.md "Touch"): while a bottom sheet is open (the touch pickers of
 * sheet.tsx, a Dialog or Sheet UI component drawn as a bottom sheet at phone width) one browser history entry is pushed
 * for it, so the system Back gesture closes the sheet instead of leaving the app. Closing the sheet normally takes that
 * entry back off (history.back()), so no stray entries are left. Desktop popovers never push anything.
 *
 * The rules are in BackStack (pure, tested in phone.test.ts against a fake history); useBackClose is the React hook.
 *  - Every open layer gets the next depth; its entry's state carries `{ __abLayer: depth }` (the rest of the state, if
 *    any, is kept). The current depth is the state's `__abLayer` (0 without one).
 *  - A popstate that we did not cause closes every layer deeper than the new current depth, the innermost first.
 *  - Closing a layer normally: if its entry is the current one, history.back() and ignore that one popstate. A layer
 *    whose entry was already popped (Back) or replaced (a navigation while it was open) leaves history alone.
 *  - A layer whose close was asked by Back but that stays open (the app's OnClose did not close it) gets a new entry.
 *  - Router: the shell routes on `hashchange` only, and these entries keep the URL, so popping them never navigates.
 */
import { useEffect, useRef } from 'react'

export interface HistoryLike {
  /** depth of the current entry (state.__abLayer, 0 when absent) */
  depth(): number
  push(depth: number): void
  back(): void
}

interface Layer {
  id: number
  depth: number
  onBack: () => void
  /** its entry is gone (popped by Back) */
  popped: boolean
}

export class BackStack {
  private layers: Layer[] = []
  private ignore = 0
  private seq = 0
  constructor(private readonly h: HistoryLike) {}

  get size(): number {
    return this.layers.length
  }

  /** a sheet opened: push its entry; returns the layer id */
  open(onBack: () => void): number {
    const depth = Math.max(this.h.depth(), this.layers.length ? this.layers[this.layers.length - 1]!.depth : 0) + 1
    const layer: Layer = { id: ++this.seq, depth, onBack, popped: false }
    this.layers.push(layer)
    this.h.push(depth)
    return layer.id
  }

  /** the browser moved in history (popstate) */
  popped(): number[] {
    if (this.ignore > 0) {
      this.ignore--
      return []
    }
    const now = this.h.depth()
    const closing = this.layers.filter((l) => !l.popped && l.depth > now).reverse()
    for (const l of closing) l.popped = true
    for (const l of closing) l.onBack()
    return closing.map((l) => l.id)
  }

  /** after Back asked a layer to close: it is still open (OnClose did nothing): give it a new entry */
  stillOpen(id: number): void {
    const l = this.layers.find((x) => x.id === id)
    if (!l || !l.popped) return
    l.popped = false
    l.depth = this.h.depth() + 1
    this.h.push(l.depth)
  }

  /** the sheet closed (any way): take its entry back off when it is the current one */
  close(id: number): void {
    const i = this.layers.findIndex((x) => x.id === id)
    if (i < 0) return
    const [l] = this.layers.splice(i, 1)
    if (!l!.popped && this.h.depth() === l!.depth) {
      this.ignore++
      this.h.back()
    }
  }
}

const browserHistory: HistoryLike = {
  depth() {
    const s = history.state as { __abLayer?: unknown } | null
    return s && typeof s.__abLayer === 'number' ? s.__abLayer : 0
  },
  push(depth) {
    const s = history.state && typeof history.state === 'object' ? (history.state as Record<string, unknown>) : {}
    history.pushState({ ...s, __abLayer: depth }, '')
  },
  back() {
    history.back()
  },
}

let stack: BackStack | null = null
function browserStack(): BackStack | null {
  if (typeof window === 'undefined' || typeof history === 'undefined') return null
  if (!stack) {
    stack = new BackStack(browserHistory)
    window.addEventListener('popstate', () => stack?.popped())
  }
  return stack
}

/** while `active`, the browser Back gesture calls `onBack` (it should close the sheet) instead of leaving the page */
export function useBackClose(active: boolean, onBack: () => void): void {
  const cb = useRef(onBack)
  cb.current = onBack
  const activeRef = useRef(active)
  activeRef.current = active
  useEffect(() => {
    if (!active) return
    const s = browserStack()
    if (!s) return
    let id = 0
    id = s.open(() => {
      cb.current()
      // the app may keep it open (OnClose without closing it): then it needs a new entry
      setTimeout(() => {
        if (activeRef.current && id) s.stillOpen(id)
      }, 0)
    })
    return () => {
      s.close(id)
      id = 0
    }
  }, [active])
}

/** for the exit check and support: how many sheet entries are pushed right now */
export const backLayers = () => stack?.size ?? 0
