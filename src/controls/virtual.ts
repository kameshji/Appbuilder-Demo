/**
 * Windowed rendering for long lists (DataTable, Gallery) and infinite scroll over server pages (P0 package D).
 * Rows have a fixed pitch (row height + gap); only the rows in view (plus an overscan) are rendered, with spacers
 * keeping the scroll height. `onNearEnd` fires when the user scrolls close to the last loaded row, which loads the next
 * server page of a paged result (queryMeta(...).loadMore()).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { queryMeta, viewMatches, type QueryMeta } from '@/runtime/delegation'

export { queryMeta, viewMatches, type QueryMeta }

export interface VirtualWindow {
  start: number
  end: number
  padTop: number
  padBottom: number
  onScroll(e: React.UIEvent<HTMLElement>): void
}

/** rows per line: 1 for lists, the column count for grids */
export function useVirtualRows(o: {
  count: number
  pitch: number
  perLine?: number
  enabled: boolean
  overscan?: number
  /** called (at most once per count) when the view is within `threshold` lines of the end */
  onNearEnd?: () => void
  threshold?: number
  scrollRef: React.RefObject<HTMLElement | null>
}): VirtualWindow {
  const perLine = Math.max(1, o.perLine ?? 1)
  const [view, setView] = useState({ top: 0, height: 800 })
  const fired = useRef(-1)
  const lines = Math.ceil(o.count / perLine)
  const check = useCallback((top: number, height: number) => {
    if (!o.onNearEnd) return
    const lastVisible = (top + height) / Math.max(1, o.pitch)
    if (lines - lastVisible <= (o.threshold ?? 15) && fired.current !== o.count) {
      fired.current = o.count
      o.onNearEnd()
    }
  }, [o, lines])
  useEffect(() => {
    const el = o.scrollRef.current
    if (!el) return
    const h = el.clientHeight || 800
    if (h !== view.height) setView((v) => ({ ...v, height: h }))
    check(el.scrollTop, h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.count, o.scrollRef.current])
  const onScroll = (e: React.UIEvent<HTMLElement>) => {
    const el = e.currentTarget
    setView({ top: el.scrollTop, height: el.clientHeight || 800 })
    check(el.scrollTop, el.clientHeight || 800)
  }
  if (!o.enabled) return { start: 0, end: o.count, padTop: 0, padBottom: 0, onScroll }
  const over = o.overscan ?? 8
  const firstLine = Math.max(0, Math.floor(view.top / o.pitch) - over)
  const lastLine = Math.min(lines, Math.ceil((view.top + view.height) / o.pitch) + over)
  return {
    start: firstLine * perLine,
    end: Math.min(o.count, lastLine * perLine),
    padTop: firstLine * o.pitch,
    padBottom: Math.max(0, (lines - lastLine) * o.pitch),
    onScroll,
  }
}

/** "1,234 rows" */
export function rowCountText(n: number | undefined, loaded: number): string {
  const v = n ?? loaded
  return `${v.toLocaleString('en-US')} ${v === 1 ? 'row' : 'rows'}`
}
