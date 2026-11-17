import { useEffect } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { controls } from '@/controls'
import { getEvaluator } from '@/runtime/evaluator'
import { useStore } from '@/runtime/store'
import { useUi } from '@/runtime/ui'
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
      const ev = getEvaluator(st.app, st.runtime)
      const real = st.selection.filter((id) => ev.byId.get(id)?.node.type !== 'Screen')

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
        if (!real.length) return
        e.preventDefault()
        const step = e.shiftKey ? 8 : 1
        const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0
        const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0
        st.nudge(real, dx, dy)
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

export function Studio() {
  const theme = useUi((s) => s.theme)
  useShortcuts()
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  return (
    <TooltipProvider delayDuration={300}>
      <div data-testid="studio-root" className="flex h-full min-w-[1100px] flex-col overflow-hidden bg-background text-foreground">
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
      </div>
    </TooltipProvider>
  )
}
