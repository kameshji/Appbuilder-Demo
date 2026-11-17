import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import { ScreenView } from '@/runtime/RenderNode'
import { useStore } from '@/runtime/store'
import { Button } from '@/components/ui/button'

export function Preview() {
  const mode = useStore((s) => s.mode)
  if (mode !== 'preview') return null
  return <PreviewInner />
}

function PreviewInner() {
  const app = useStore((s) => s.app)
  const navStack = useStore((s) => s.runtime.navStack)
  const screenId = navStack[navStack.length - 1] ?? app.screens[0].id
  const screen = app.screens.find((s) => s.id === screenId) ?? app.screens[0]
  const areaRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)

  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const update = () => {
      const r = el.getBoundingClientRect()
      setScale(Math.max(0.2, Math.min((r.width - 48) / app.width, (r.height - 48) / app.height, 1.6)))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [app.width, app.height])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        useStore.getState().exitPreview()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
          Previewing <span className="font-medium text-foreground">{app.name}</span> · {screen.name}
        </span>
        <span className="ml-auto rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">Preview</span>
      </div>
      <div ref={areaRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <div style={{ width: app.width * scale, height: app.height * scale }} className="shrink-0 overflow-hidden rounded-[3px] shadow-[0_0_0_1px_var(--border),0_20px_60px_-12px_rgb(0_0_0/0.25)]">
          <div style={{ width: app.width, height: app.height, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
            <ScreenView key={screen.id} screenId={screen.id} mode="run" testId="preview-screen" />
          </div>
        </div>
      </div>
    </div>
  )
}
