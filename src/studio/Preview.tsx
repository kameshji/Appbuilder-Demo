import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, RotateCcw, RotateCw } from 'lucide-react'
import { RunSurface } from '@/runtime/RunSurface'
import { ScreenView } from '@/runtime/RenderNode'
import { useAppStoreApi } from '@/runtime/context'
import { fluidSurface, surfaceSize, usesFluidLayout } from '@/runtime/layout'
import { useStore } from '@/runtime/store'
import { setTouchPreview, touchPreview } from '@/phone/env'
import { PullToRefresh } from '@/phone/PullToRefresh'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { CheckOnPhone } from './CheckOnPhone'
import { frameCaption, frameChoices, frameDevice, frameLayout, initialFrame, screenSize } from './phoneFrame'

export function Preview() {
  const mode = useStore((s) => s.mode)
  if (mode !== 'preview') return null
  return <PreviewInner />
}

function PreviewInner() {
  const app = useStore((s) => s.app)
  const navStack = useStore((s) => s.runtime.navStack)
  const env = useStore((s) => s.env)
  const screenId = navStack[navStack.length - 1] ?? app.screens[0].id
  const screen = app.screens.find((s) => s.id === screenId) ?? app.screens[0]
  const device = frameDevice(app.width, app.height)
  // the frame's own state; the app's design size is only its starting point
  const [frame, setFrame] = useState(() => initialFrame(app.width, app.height))
  const choices = frameChoices(app.width, app.height)
  const choice = choices?.find((c) => c.id === frame?.id) ?? choices?.[0]
  const rotated = frame?.rotated ?? false
  const framed = !!(device && choice)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Escape inside the running app (dialogs, menus) belongs to the app
      if ((e.target as HTMLElement | null)?.closest?.('[data-testid="preview-screen"]')) return
      e.preventDefault()
      useStore.getState().exitPreview()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // the touch rules (html.touch-preview, src/phone/phone.css) apply while a phone or tablet app is in its frame
  useEffect(() => {
    if (!framed || touchPreview()) return
    setTouchPreview(true)
    return () => setTouchPreview(false)
  }, [framed])

  return (
    <div data-testid="preview-root" className="fixed inset-0 z-[150] flex flex-col bg-canvas">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <Button variant="outline" size="xs" data-testid="preview-back" onClick={() => useStore.getState().exitPreview()}>
          <ArrowLeft /> Back to edit <kbd className="ml-1 rounded border border-border bg-muted px-1 text-[10px] font-normal text-muted-foreground">Esc</kbd>
        </Button>
        <Button variant="ghost" size="xs" data-testid="preview-restart" onClick={() => useStore.getState().startPreview()}>
          <RotateCcw /> Restart
        </Button>
        <span className="ml-2 text-xs text-muted-foreground">
          Previewing <span className="font-medium text-foreground">{app.name}</span> · {screen.name} · {env.w}×{env.h}
          {app.scaleMode === 'fit' ? ' (fit)' : ''}
        </span>
        {framed && choices && choice && (
          <div className="ml-3 flex items-center gap-1" data-testid="preview-frame-controls">
            <div role="group" aria-label="Device size" className="flex items-center rounded-md border border-border p-0.5">
              {choices.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  data-testid={`preview-size-${c.id}`}
                  aria-pressed={c.id === choice.id}
                  title={`${c.label} ${c.w}×${c.h}`}
                  className={cn('rounded px-1.5 py-0.5 text-[11px]', c.id === choice.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}
                  onClick={() => setFrame({ id: c.id, rotated })}
                >
                  {choices.length > 1 ? `${c.w}×${c.h}` : c.label}
                </button>
              ))}
            </div>
            <Button variant="ghost" size="icon-sm" title="Rotate" aria-label="Rotate the device" data-testid="preview-rotate" onClick={() => setFrame({ id: choice.id, rotated: !rotated })}>
              <RotateCw />
            </Button>
          </div>
        )}
        <span className="ml-auto" />
        {framed && <CheckOnPhone />}
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">Preview</span>
      </div>
      <div className="min-h-0 flex-1">
        {framed && device && choice ? <DeviceFrame device={device} choice={choice} rotated={rotated} screenId={screen.id} /> : <RunSurface testId="preview-screen" padding={16} />}
      </div>
    </div>
  )
}

/** The app on a device screen of exactly the chosen size, scaled down as a whole to fit the Preview area. */
function DeviceFrame({ device, choice, rotated, screenId }: { device: 'Phone' | 'Tablet'; choice: { id: string; label: string; w: number; h: number }; rotated: boolean; screenId: string }) {
  const store = useAppStoreApi()
  const app = useStore((s) => s.app)
  const areaRef = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState({ w: 0, h: 0 })
  const pad = 24

  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const update = () => {
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return
      setAvail({ w: Math.max(0, r.width - pad * 2), h: Math.max(0, r.height - pad * 2 - 24) })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const layout = frameLayout(device, choice, rotated, avail)
  const area = screenSize(choice, rotated)
  // the run-time rule of src/runtime/layout.ts, with the frame's screen as the device
  const fluid = usesFluidLayout(app, area, true)
  const size = fluid ? fluidSurface(app, area) : { ...surfaceSize(app, area), scroll: false }
  const scrollerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    store.getState().setEnv(size.w, size.h)
  }, [store, size.w, size.h])
  useEffect(() => {
    scrollerRef.current?.scrollTo?.({ top: 0 })
  }, [screenId])

  return (
    <div ref={areaRef} data-testid="preview-frame-area" className="flex size-full flex-col items-center justify-center overflow-hidden">
      {avail.w > 0 && (
        <>
          <div style={{ width: layout.shown.w, height: layout.shown.h }} className="shrink-0" data-testid="preview-frame-box">
            <div
              data-testid="preview-frame"
              data-frame-size={`${layout.screen.w}x${layout.screen.h}`}
              data-frame-scale={String(layout.scale)}
              className="relative box-border bg-neutral-900 shadow-xl"
              style={{
                width: layout.outer.w,
                height: layout.outer.h,
                padding: layout.bezel,
                borderRadius: layout.radius + layout.bezel,
                transform: layout.scale !== 1 ? `scale(${layout.scale})` : undefined,
                transformOrigin: '0 0',
              }}
            >
              <div
                ref={scrollerRef}
                data-run-surface={fluid ? 'fluid' : 'fixed'}
                className={cn('relative overflow-x-hidden bg-background', fluid ? 'overflow-y-auto overscroll-contain' : 'overflow-y-hidden')}
                style={{ width: layout.screen.w, height: layout.screen.h, borderRadius: layout.radius }}
              >
                {fluid && <PullToRefresh scroller={scrollerRef} />}
                <div style={{ width: size.w * size.scale, height: size.h * size.scale }} className="overflow-hidden" data-run-size={`${size.w}x${size.h}`}>
                  <div style={{ width: size.w, height: size.h, transform: size.scale !== 1 ? `scale(${size.scale})` : undefined, transformOrigin: '0 0' }}>
                    <ScreenView key={screenId} screenId={screenId} mode="run" width={size.w} height={size.h} testId="preview-screen" />
                  </div>
                </div>
              </div>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground" data-testid="preview-frame-caption">{frameCaption(choice.label, layout)}</p>
        </>
      )}
    </div>
  )
}
