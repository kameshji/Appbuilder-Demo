import { useEffect, useRef, useState } from 'react'
import { ScreenView } from './RenderNode'
import { useAppStore, useAppStoreApi } from './context'
import { fluidSurface, surfaceSize, usesFluidLayout } from './layout'
import { useDevice } from '@/phone/env'
import { PullToRefresh } from '@/phone/PullToRefresh'

/**
 * The running app inside an area: responsive (screen = area size, min 1024x576, portrait keeps the
 * design aspect) or fit (design size scaled). Publishes the actual size as App.Width / App.Height.
 *
 * Phones and tablets (P2-A, layout.ts fluidSurface): a phone or tablet design on a touch device (or in an area under
 * 600 px) is drawn 1:1 at the device width (the design width is the minimum; narrower devices scale it down), at least
 * as tall as the design and the device, and the area scrolls vertically. `data-run-surface` marks the area for the touch
 * CSS (src/phone/phone.css) and the keyboard handling (src/phone/env.ts).
 */
export function RunSurface({ testId = 'run-screen', padding = 0 }: { testId?: string; padding?: number }) {
  const store = useAppStoreApi()
  const app = useAppStore((s) => s.app)
  const navStack = useAppStore((s) => s.runtime.navStack)
  const screenId = navStack[navStack.length - 1] ?? app.screens[0].id
  const screen = app.screens.find((s) => s.id === screenId) ?? app.screens[0]
  const areaRef = useRef<HTMLDivElement>(null)
  const [area, setArea] = useState({ w: 0, h: 0 })
  const device = useDevice()

  const fluid = usesFluidLayout(app, area, device.touch)
  const pad = fluid ? 0 : padding

  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const update = () => {
      const r = el.getBoundingClientRect()
      // a hidden surface (inactive app tab, display: none) measures 0 x 0: keep the last size so the screen stays mounted
      if (r.width === 0 && r.height === 0) return
      setArea({ w: Math.max(0, r.width - pad * 2), h: Math.max(0, r.height - pad * 2) })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [pad])

  const size = fluid ? fluidSurface(app, area) : { ...surfaceSize(app, area), scroll: false }
  useEffect(() => {
    if (area.w > 0) store.getState().setEnv(size.w, size.h)
  }, [store, area.w, size.w, size.h])

  // a new screen starts at the top
  useEffect(() => {
    if (fluid) areaRef.current?.scrollTo?.({ top: 0 })
  }, [fluid, screen.id])

  return (
    <div
      ref={areaRef}
      data-run-surface={fluid ? 'fluid' : 'fixed'}
      className={fluid ? 'relative size-full overflow-x-hidden overflow-y-auto overscroll-contain' : 'relative flex size-full items-center justify-center overflow-hidden'}
      style={fluid ? { WebkitOverflowScrolling: 'touch' } : undefined}
    >
      {fluid && <PullToRefresh scroller={areaRef} />}
      {area.w > 0 && (
        <div
          style={{ width: size.w * size.scale, height: size.h * size.scale }}
          className="shrink-0 overflow-hidden"
          data-run-size={`${size.w}x${size.h}`}
          data-run-scale={size.scale !== 1 ? String(Math.round(size.scale * 1000) / 1000) : undefined}
        >
          <div style={{ width: size.w, height: size.h, transform: size.scale !== 1 ? `scale(${size.scale})` : undefined, transformOrigin: '0 0' }}>
            <ScreenView key={screen.id} screenId={screen.id} mode="run" width={size.w} height={size.h} testId={testId} />
          </div>
        </div>
      )}
    </div>
  )
}
