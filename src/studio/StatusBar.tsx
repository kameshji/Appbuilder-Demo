import { useMemo, useState } from 'react'
import { ChevronRight, CircleAlert, Loader2, Maximize, Minus, Monitor, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { usePlatform } from '@/platform'
import { tableRows } from '@/runtime/data'
import { evaluatorOf, useStore } from '@/runtime/store'
import { useUi } from '@/runtime/ui'
import { pathTo, walk } from '@/runtime/util'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { sizeError } from '@/runtime/sizes'

const VIEWPORTS: Array<[string, number, number]> = [
  ['Full HD', 1920, 1080],
  ['2K', 2560, 1440],
  ['Laptop', 1366, 768],
  ['16:10', 1920, 1200],
  ['21:9', 2560, 1080],
  ['Ultrawide', 3440, 1440],
  ['Phone', 360, 800],
  ['Phone (large)', 390, 844],
  ['Phone (tall)', 412, 915],
  ['Tablet portrait', 800, 1280],
  ['Tablet landscape', 1280, 800],
]

function ViewportSelect() {
  const app = useStore((s) => s.app)
  const viewSize = useUi((s) => s.viewSize)
  const [custom, setCustom] = useState(false)
  const [cw, setCw] = useState('1600')
  const [ch, setCh] = useState('900')
  const cur = viewSize && (viewSize.w !== app.width || viewSize.h !== app.height) ? `${viewSize.w}x${viewSize.h}` : 'design'
  const known = cur === 'design' || VIEWPORTS.some(([, w, h]) => `${w}x${h}` === cur)
  const apply = (v: { w: number; h: number } | null) => {
    useUi.setState({ viewSize: v && (v.w !== app.width || v.h !== app.height) ? v : null })
    useUi.getState().requestFit()
  }
  return (
    <span className="flex items-center gap-1">
      <Monitor className="size-3" />
      <select
        data-testid="viewport-select"
        value={custom ? 'custom' : known ? cur : 'custom'}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'custom') {
            setCustom(true)
            return
          }
          setCustom(false)
          if (v === 'design') apply(null)
          else {
            const [w, h] = v.split('x').map(Number)
            apply({ w, h })
          }
        }}
        className="h-5 rounded border border-transparent bg-transparent pr-1 text-[11px] text-foreground hover:border-border focus:border-primary"
      >
        <option value="design">
          Design size {app.width}×{app.height}
        </option>
        {VIEWPORTS.map(([l, w, h]) => (
          <option key={l} value={`${w}x${h}`}>
            {l} {w}×{h}
          </option>
        ))}
        <option value="custom">{!known && !custom && viewSize ? `Custom ${viewSize.w}×${viewSize.h}` : 'Custom…'}</option>
      </select>
      {custom && (
        <span className="flex items-center gap-0.5">
          <input value={cw} onChange={(e) => setCw(e.target.value)} data-testid="viewport-w" className="h-5 w-12 rounded border border-border bg-background px-1 text-[11px] tabular-nums" />×
          <input value={ch} onChange={(e) => setCh(e.target.value)} data-testid="viewport-h" className="h-5 w-12 rounded border border-border bg-background px-1 text-[11px] tabular-nums" />
          <button
            type="button"
            className="rounded px-1 font-medium text-primary hover:bg-accent"
            onClick={() => {
              const w = Math.round(Number(cw))
              const h = Math.round(Number(ch))
              const bad = sizeError(w, h)
              if (bad) return useStore.getState().notify(bad, 'warning')
              setCustom(false)
              apply({ w, h })
            }}
          >
            View
          </button>
        </span>
      )}
      <button type="button" title="Change the design resolution" className="rounded px-1 hover:bg-accent hover:text-foreground" onClick={() => useUi.setState({ settingsOpen: true })}>
        Edit…
      </button>
    </span>
  )
}

/** tables of this app whose query hit the server row cap: the app sees only the rows that were loaded */
function useTruncatedWarnings(): string[] {
  const sources = useStore((s) => s.app.dataSources)
  const truncated = usePlatform((s) => s.truncated)
  usePlatform((s) => s.dataVersion)
  return (truncated ?? []).filter((t) => (sources ?? []).includes(t)).map((t) => `Data truncated at ${tableRows(t).length} rows: ${t} has more rows than the server returns to apps`)
}

/** small spinner while the app's tables load from the server */
function LoadingIndicator() {
  const loading = usePlatform((s) => s.loading)
  const sources = useStore((s) => s.app.dataSources)
  const mine = (loading ?? []).filter((t) => (sources ?? []).includes(t))
  if (mine.length === 0) return null
  return (
    <span data-testid="data-loading" className="flex items-center gap-1 text-muted-foreground" title={`Loading ${mine.join(', ')}`}>
      <Loader2 className="size-3 animate-spin" /> Loading data: {mine.join(', ')}
    </span>
  )
}

interface ErrItem { id: string; nodeId?: string; nodeType?: string; prop?: string; label: string; message: string }

function ErrorList() {
  const app = useStore((s) => s.app)
  const rt = useStore((s) => s.runtime)
  const env = useStore((s) => s.env)
  const log = useStore((s) => s.debugLog)
  const ev = evaluatorOf({ ...useStore.getState(), app, runtime: rt, env })
  const formulaErrors = useMemo(() => {
    const out: ErrItem[] = []
    walk(app.screens, (node) => {
      for (const [prop, message] of Object.entries(ev.errorsOf(node))) out.push({ id: `${node.id}:${prop}`, nodeId: node.id, nodeType: node.type, prop, label: `${node.name}.${prop}`, message })
    })
    for (const e of ev.namedErrors) out.push({ id: `nf:${e.start}`, label: 'App.Formulas', message: e.message })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, rt, env, ev])
  const runtimeErrors = log.filter((l) => l.kind === 'error')
  const warnings = useTruncatedWarnings()
  const n = formulaErrors.length + runtimeErrors.length
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-testid="error-count" className={cn('flex items-center gap-1 rounded px-1 hover:bg-accent', n ? 'font-medium text-destructive' : '')}>
          <CircleAlert className="size-3" />
          {n} {n === 1 ? 'error' : 'errors'}
          {warnings.length > 0 && (
            <span className="ml-1 flex items-center gap-0.5 font-medium text-amber-600 dark:text-amber-400" data-testid="data-warning-count">
              <TriangleAlert className="size-3" /> {warnings.length}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-[460px] p-0" data-testid="error-list">
        <div className="max-h-[360px] overflow-auto p-1.5 text-xs">
          {n === 0 && warnings.length === 0 && <p className="p-2 text-muted-foreground">No formula or runtime errors.</p>}
          {warnings.length > 0 && <h4 className="px-1.5 pb-1 pt-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Data warnings</h4>}
          {warnings.map((w) => (
            <div key={w} data-testid="data-warning" className="flex items-start gap-1.5 rounded px-1.5 py-1 text-amber-700 dark:text-amber-400">
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
              <span>{w}</span>
            </div>
          ))}
          {formulaErrors.length > 0 && <h4 className="px-1.5 pb-1 pt-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Formulas</h4>}
          {formulaErrors.map((e) => (
            <button
              key={e.id}
              type="button"
              className="flex w-full flex-col items-start rounded px-1.5 py-1 text-left hover:bg-accent"
              onClick={() => {
                if (!e.nodeId) return useUi.setState({ settingsOpen: true })
                useStore.getState().select([e.nodeId])
                if (e.nodeType && e.prop) useUi.getState().focusFormula(e.nodeType, e.prop)
              }}
            >
              <span className="font-mono font-medium">{e.label}</span>
              <span className="text-destructive">{e.message}</span>
            </button>
          ))}
          {runtimeErrors.length > 0 && (
            <div className="flex items-center justify-between px-1.5 pb-1 pt-2">
              <h4 className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Runtime (preview and run window)</h4>
              <button type="button" className="flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => useStore.getState().clearLog()}>
                <Trash2 className="size-3" /> Clear
              </button>
            </div>
          )}
          {runtimeErrors
            .slice()
            .reverse()
            .map((e) => (
              <div key={e.id} className="rounded px-1.5 py-1">
                <span className="text-muted-foreground">{new Date(e.at).toLocaleTimeString()} </span>
                <span className="text-destructive">{e.message}</span>
              </div>
            ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function StatusBar() {
  const app = useStore((s) => s.app)
  const selection = useStore((s) => s.selection)
  const zoom = useUi((s) => s.zoom)
  const viewSize = useUi((s) => s.viewSize)
  const path = selection.length ? pathTo(app, selection[0]) : []

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
      <ErrorList />
      <LoadingIndicator />
      <div className="ml-auto flex items-center gap-3">
        <ViewportSelect />
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" className="size-5" title="Zoom out" onClick={() => useUi.getState().zoomBy(1 / 1.25)}>
            <Minus className="!size-3" />
          </Button>
          <button type="button" title="Reset to 100%" onClick={() => useUi.getState().zoomTo(1)} className="w-10 rounded text-center font-medium tabular-nums text-foreground hover:bg-accent" data-testid="zoom-level">
            {Math.round(zoom * 100)}%
          </button>
          <Button variant="ghost" size="icon-sm" className="size-5" title="Zoom in" onClick={() => useUi.getState().zoomBy(1.25)}>
            <Plus className="!size-3" />
          </Button>
          <Button variant="ghost" size="xs" className="ml-1 h-5 gap-1 px-1.5 text-[11px]" data-testid="zoom-fit" onClick={() => useUi.getState().fit(viewSize?.w ?? app.width, viewSize?.h ?? app.height)}>
            <Maximize className="!size-3" /> Fit
          </Button>
        </div>
      </div>
    </footer>
  )
}
