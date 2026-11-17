import { useEffect, useRef, useState } from 'react'
import { ScreenView } from './RenderNode'
import { useStore } from './store'
import { surfaceSize } from './layout'

/**
 * The running app inside an area: responsive (screen = area size, min 1024x576, portrait keeps the
 * design aspect) or fit (design size scaled). Publishes the actual size as App.Width / App.Height.
 */
export function RunSurface({ testId = 'run-screen', padding = 0 }: { testId?: string; padding?: number }) {
  const app = useStore((s) => s.app)
  const navStack = useStore((s) => s.runtime.navStack)
  const screenId = navStack[navStack.length - 1] ?? app.screens[0].id
  const screen = app.screens.find((s) => s.id === screenId) ?? app.screens[0]
  const areaRef = useRef<HTMLDivElement>(null)
  const [area, setArea] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const update = () => {
      const r = el.getBoundingClientRect()
      setArea({ w: Math.max(0, r.width - padding * 2), h: Math.max(0, r.height - padding * 2) })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [padding])

  const size = surfaceSize(app, area)
  useEffect(() => {
    if (area.w > 0) useStore.getState().setEnv(size.w, size.h)
  }, [area.w, size.w, size.h])

  return (
    <div ref={areaRef} className="relative flex size-full items-center justify-center overflow-hidden">
      {area.w > 0 && (
        <div
          style={{ width: size.w * size.scale, height: size.h * size.scale }}
          className="shrink-0 overflow-hidden"
          data-run-size={`${size.w}x${size.h}`}
        >
          <div style={{ width: size.w, height: size.h, transform: size.scale !== 1 ? `scale(${size.scale})` : undefined, transformOrigin: '0 0' }}>
            <ScreenView key={screen.id} screenId={screen.id} mode="run" width={size.w} height={size.h} testId={testId} />
          </div>
        </div>
      )}
    </div>
  )
}
