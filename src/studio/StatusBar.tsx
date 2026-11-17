import { useMemo } from 'react'
import { ChevronRight, CircleAlert, Maximize, Minus, Plus } from 'lucide-react'
import { useStore } from '@/runtime/store'
import { useUi } from '@/runtime/ui'
import { getEvaluator } from '@/runtime/evaluator'
import { pathTo, walk } from '@/runtime/util'
import { Button } from '@/components/ui/button'

export function StatusBar() {
  const app = useStore((s) => s.app)
  const rt = useStore((s) => s.runtime)
  const selection = useStore((s) => s.selection)
  const zoom = useUi((s) => s.zoom)
  const ev = getEvaluator(app, rt)
  const path = selection.length ? pathTo(app, selection[0]) : []
  const errors = useMemo(() => {
    let n = 0
    walk(app.screens, (node) => {
      n += Object.keys(ev.errorsOf(node)).length
    })
    return n
  }, [app, ev])

  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-card px-3 text-[11px] text-muted-foreground">
      <nav data-testid="breadcrumb" className="flex min-w-0 items-center gap-0.5">
        {path.map((n, i) => (
          <span key={n.id} className="flex items-center gap-0.5">
            {i > 0 && <ChevronRight className="size-3 opacity-50" />}
            <button
              type="button"
              onClick={() => useStore.getState().select([n.id])}
              className={i === path.length - 1 ? 'rounded px-1 font-medium text-foreground' : 'rounded px-1 hover:bg-accent hover:text-foreground'}
            >
              {n.name}
            </button>
          </span>
        ))}
      </nav>
      <span data-testid="error-count" className={errors ? 'flex items-center gap-1 font-medium text-destructive' : 'flex items-center gap-1'}>
        <CircleAlert className="size-3" />
        {errors} {errors === 1 ? 'error' : 'errors'}
      </span>
      <div className="ml-auto flex items-center gap-0.5">
        <Button variant="ghost" size="icon-sm" className="size-5" title="Zoom out" onClick={() => useUi.getState().zoomBy(1 / 1.25)}>
          <Minus className="!size-3" />
        </Button>
        <button type="button" title="Reset to 100%" onClick={() => useUi.getState().zoomTo(1)} className="w-10 rounded text-center font-medium tabular-nums text-foreground hover:bg-accent" data-testid="zoom-level">
          {Math.round(zoom * 100)}%
        </button>
        <Button variant="ghost" size="icon-sm" className="size-5" title="Zoom in" onClick={() => useUi.getState().zoomBy(1.25)}>
          <Plus className="!size-3" />
        </Button>
        <Button variant="ghost" size="xs" className="ml-1 h-5 gap-1 px-1.5 text-[11px]" onClick={() => useUi.getState().fit(app.width, app.height)}>
          <Maximize className="!size-3" /> Fit
        </Button>
      </div>
    </footer>
  )
}
