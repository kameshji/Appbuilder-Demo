import { useEffect } from 'react'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import { RunSurface } from '@/runtime/RunSurface'
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
  const env = useStore((s) => s.env)
  const screenId = navStack[navStack.length - 1] ?? app.screens[0].id
  const screen = app.screens.find((s) => s.id === screenId) ?? app.screens[0]

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
        <span className="ml-auto rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">Preview</span>
      </div>
      <div className="min-h-0 flex-1">
        <RunSurface testId="preview-screen" padding={16} />
      </div>
    </div>
  )
}
