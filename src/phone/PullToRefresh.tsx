/**
 * Pull to refresh for a running app on a touch device (P2-A): pulling the app's scroll area down from the very top by
 * more than 64 px reloads the app's data (every data source: the query cache refetches, loaded tables reload). The
 * browser's own pull-to-refresh is off inside the app (overscroll-behavior: contain), so this one never reloads the
 * page and loses typed values.
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import { Loader2, ArrowDown } from 'lucide-react'
import { platform } from '@/platform'
import { useAppStoreApi } from '@/runtime/context'
import { refreshOfflineTables } from './offline'

const THRESHOLD = 64

/** the pull distance shown for a finger movement (resistance: half the movement, at most 96 px) */
export const pullDistance = (dy: number) => Math.max(0, Math.min(96, dy / 2))

export function PullToRefresh({ scroller }: { scroller: RefObject<HTMLDivElement | null> }) {
  const store = useAppStoreApi()
  const [pull, setPull] = useState(0)
  const [busy, setBusy] = useState(false)
  const start = useRef<{ y: number; x: number } | null>(null)

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const down = (e: TouchEvent) => {
      if (e.touches.length !== 1 || el.scrollTop > 0 || busy) return
      // not from inside something that scrolls itself (a gallery, a table, a text area)
      let t = e.target as HTMLElement | null
      while (t && t !== el) {
        // a signature pad (and anything else marked) takes the finger for itself
        if (t.hasAttribute?.('data-no-pull')) return
        if (t.scrollHeight > t.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(t).overflowY) && t.scrollTop > 0) return
        t = t.parentElement
      }
      start.current = { y: e.touches[0].clientY, x: e.touches[0].clientX }
    }
    const move = (e: TouchEvent) => {
      if (!start.current) return
      const dy = e.touches[0].clientY - start.current.y
      const dx = Math.abs(e.touches[0].clientX - start.current.x)
      if (dy <= 0 || dx > dy) {
        setPull(0)
        return
      }
      setPull(pullDistance(dy))
    }
    const up = () => {
      if (!start.current) return
      start.current = null
      setPull((p) => {
        if (p >= THRESHOLD / 1.5) void refresh()
        return 0
      })
    }
    const refresh = async () => {
      setBusy(true)
      try {
        const tables = store.getState().app.dataSources ?? []
        // tables kept on the device for offline use download again (offline/index.ts)
        const appId = store.getState().appId
        if (appId) void refreshOfflineTables(appId)
        await Promise.all(tables.map(async (t) => {
          try {
            platform.tables.invalidateQueries(t)
            await platform.tables.reload(t)
          } catch {
            /* a table that is not loaded whole refreshes through its queries */
          }
        }))
      } finally {
        setTimeout(() => setBusy(false), 350)
      }
    }
    el.addEventListener('touchstart', down, { passive: true })
    el.addEventListener('touchmove', move, { passive: true })
    el.addEventListener('touchend', up)
    el.addEventListener('touchcancel', up)
    return () => {
      el.removeEventListener('touchstart', down)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', up)
      el.removeEventListener('touchcancel', up)
    }
  }, [scroller, store, busy])

  if (pull === 0 && !busy) return null
  const ready = pull >= THRESHOLD / 1.5
  return (
    <div
      data-testid="pull-to-refresh"
      className="pointer-events-none sticky top-0 z-[360] flex h-0 justify-center"
      aria-live="polite"
    >
      <div
        className="mt-2 grid size-9 place-items-center rounded-full border border-border bg-card text-muted-foreground shadow"
        style={{ transform: `translateY(${busy ? 8 : pull - 36}px)` }}
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-label="Refreshing" /> : <ArrowDown className="size-4 transition-transform" style={{ transform: ready ? 'rotate(180deg)' : undefined }} aria-label={ready ? 'Release to refresh' : 'Pull to refresh'} />}
      </div>
    </div>
  )
}
