import { useEffect } from 'react'
import { CircleAlert, Loader2 } from 'lucide-react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { controls } from '@/controls'
import { go } from '@/router'
import { evaluatorOf, setRunSurface, useStore } from '@/runtime/store'
import { useUi } from '@/runtime/ui'
import { loadPrefs, savePrefs } from '@/runtime/persist'
import { loadAppDef, startStudioSession } from '@/runtime/session'
import { AppSettingsDialog } from './AppSettings'
import { PackageDialog } from './PackageDialog'
import { Canvas } from './Canvas'
import { CommandBar } from './CommandBar'
import { FormulaBar } from './FormulaBar'
import { LeftRail } from './LeftRail'
import { Preview } from './Preview'
import { PropertiesPanel } from './PropertiesPanel'
import { StatusBar } from './StatusBar'
import { Toasts } from './Toasts'

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || !el.tagName) return false
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return true
  return !!el.closest('[role="textbox"],[role="combobox"],[role="listbox"],[role="menu"],[role="dialog"]')
}

function useShortcuts() {
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const st = useStore.getState()
      if (st.mode !== 'design' || isTyping(e.target)) return
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      const ev = evaluatorOf(st)
      const lockedIds = useUi.getState().locked
      const real = st.selection.filter((id) => ev.byId.get(id)?.node.type !== 'Screen')
      const movable = real.filter((id) => !lockedIds.includes(id))

      if (e.code === 'Space' && !mod) {
        e.preventDefault()
        if (!useUi.getState().spaceDown) useUi.setState({ spaceDown: true })
        return
      }
      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) st.redo()
        else st.undo()
      } else if (mod && key === 'y') {
        e.preventDefault()
        st.redo()
      } else if (mod && key === 'c') {
        if (real.length) {
          e.preventDefault()
          st.copy(real)
        }
      } else if (mod && key === 'x') {
        if (real.length) {
          e.preventDefault()
          st.copy(real)
          st.remove(real)
        }
      } else if (mod && key === 'v') {
        e.preventDefault()
        st.paste()
      } else if (mod && key === 'd') {
        e.preventDefault()
        if (real.length) st.duplicate(real)
      } else if (mod && key === 'a') {
        e.preventDefault()
        const first = ev.byId.get(st.selection[0])
        const parent = first?.node.type === 'Screen' ? first.node : first?.parent
        if (parent && parent.children.length) st.select(parent.children.map((c) => c.id))
      } else if (key === 'delete' || key === 'backspace') {
        if (real.length) {
          e.preventDefault()
          st.remove(real)
        }
      } else if (key === 'escape') {
        const first = ev.byId.get(st.selection[0])
        if (first?.parent) st.select([first.parent.id])
        else if (first && first.node.type !== 'Screen') st.select([first.screen.id])
      } else if (key.startsWith('arrow') && !mod) {
        if (!movable.length || useUi.getState().viewSize) return
        e.preventDefault()
        const step = e.shiftKey ? 8 : 1
        const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0
        const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0
        st.nudge(movable, dx, dy)
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space' && useUi.getState().spaceDown) useUi.setState({ spaceDown: false })
    }
    const blur = () => useUi.setState({ spaceDown: false })
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])
}

function InsertGhost() {
  const g = useUi((s) => s.insertGhost)
  if (!g) return null
  let Icon: React.ComponentType<{ className?: string }> | null = null
  let label = g.type
  try {
    const c = controls.get(g.type)
    Icon = c.icon
    label = c.label
  } catch {
    /* ignore */
  }
  return (
    <div
      className="pointer-events-none fixed z-[400] flex h-8 items-center gap-2 rounded-md border border-primary bg-card px-2.5 text-xs font-medium text-primary shadow-lg"
      style={{ left: g.x + 12, top: g.y + 12 }}
    >
      {Icon && <Icon className="size-4" />}
      {label}
    </div>
  )
}

function usePrefs(appId: string) {
  const ready = useStore((s) => s.appId === appId && s.loadState === 'ready')
  useEffect(() => {
    if (!ready) return
    const p = loadPrefs(appId)
    useUi.setState({ locked: p.locked, viewSize: p.viewport })
    return useUi.subscribe((s, prev) => {
      if (s.locked !== prev.locked || s.viewSize !== prev.viewSize) savePrefs(appId, { locked: s.locked, viewport: s.viewSize })
    })
  }, [appId, ready])
}

export function Studio({ appId }: { appId: string }) {
  const theme = useUi((s) => s.theme)
  const loadState = useStore((s) => s.loadState)
  const loadedId = useStore((s) => s.appId)
  const loadError = useStore((s) => s.loadError)
  useShortcuts()
  usePrefs(appId)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  useEffect(() => {
    setRunSurface(false)
    let alive = true
    let stop: (() => void) | null = null
    void loadAppDef(appId).then((def) => {
      if (!alive || !def) return
      useStore.getState().loadApp(appId, def)
      useUi.setState({ viewSize: null, locked: [] })
      useUi.getState().requestFit()
      stop = startStudioSession(appId)
    })
    return () => {
      alive = false
      stop?.()
    }
  }, [appId])

  if (loadState === 'missing' || loadState === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-background text-center">
        <CircleAlert className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium">{loadState === 'missing' ? 'This app does not exist' : 'The app could not be loaded'}</p>
        {loadError && <p className="text-xs text-muted-foreground">{loadError}</p>}
        <Button size="sm" variant="outline" onClick={() => go({ page: 'apps' })}>
          Back to apps
        </Button>
      </div>
    )
  }
  if (loadedId !== appId || loadState !== 'ready') {
    return (
      <div className="grid h-full place-items-center bg-background text-muted-foreground" data-testid="studio-loading">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div data-testid="studio-root" className="flex h-full min-w-[900px] flex-col overflow-hidden bg-background text-foreground">
        <CommandBar />
        <FormulaBar />
        <div className="flex min-h-0 flex-1">
          <LeftRail />
          <main className="relative min-w-0 flex-1">
            <Canvas />
          </main>
          <PropertiesPanel />
        </div>
        <StatusBar />
        <Preview />
        <Toasts />
        <InsertGhost />
        <AppSettingsDialog />
        <PackageDialog />
      </div>
    </TooltipProvider>
  )
}
