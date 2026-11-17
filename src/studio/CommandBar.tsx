import { useRef } from 'react'
import { Download, EllipsisVertical, FilePlus2, Moon, Play, Plus, Redo2, RotateCcw, Sun, Undo2, Upload, Shapes } from 'lucide-react'
import { controls } from '@/controls'
import { useStore } from '@/runtime/store'
import { useUi } from '@/runtime/ui'
import { downloadJson, readImport } from '@/runtime/persist'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

export function CommandBar() {
  const name = useStore((s) => s.app.name)
  const canUndo = useStore((s) => s.history.past.length > 0)
  const canRedo = useStore((s) => s.history.future.length > 0)
  const theme = useUi((s) => s.theme)
  const fileRef = useRef<HTMLInputElement>(null)

  const onImport = async (file: File | undefined) => {
    if (!file) return
    const st = useStore.getState()
    try {
      const data = readImport(await file.text())
      st.setApp(data.app, data.collections)
      st.notify('App imported', 'success')
    } catch (e) {
      st.notify(`Import failed: ${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  return (
    <header className="relative z-30 flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
      <div className="flex items-center gap-2 pr-1">
        <div className="grid size-6 place-items-center rounded-md bg-primary text-primary-foreground">
          <Shapes className="size-3.5" />
        </div>
        <span className="text-sm font-semibold tracking-tight">Appbuilder</span>
      </div>
      <span className="h-5 w-px bg-border" />
      <input
        value={name}
        spellCheck={false}
        data-testid="app-name"
        onChange={(e) => useStore.getState().setAppName(e.target.value)}
        className="h-7 w-44 rounded-md border border-transparent bg-transparent px-2 text-sm font-medium outline-none hover:border-border focus:border-primary focus:bg-background"
      />
      <span className="h-5 w-px bg-border" />
      <Button variant="ghost" size="icon-sm" title="Undo (Ctrl+Z)" data-testid="undo" disabled={!canUndo} onClick={() => useStore.getState().undo()}>
        <Undo2 />
      </Button>
      <Button variant="ghost" size="icon-sm" title="Redo (Ctrl+Shift+Z)" data-testid="redo" disabled={!canRedo} onClick={() => useStore.getState().redo()}>
        <Redo2 />
      </Button>
      <span className="h-5 w-px bg-border" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" data-testid="insert-menu">
            <Plus /> Insert
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          {controls.list().map((c) => (
            <DropdownMenuItem key={c.type} onSelect={() => useStore.getState().insert(c.type)}>
              <c.icon className="text-primary" />
              {c.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="ghost" size="xs" onClick={() => useStore.getState().addScreen()}>
        <FilePlus2 /> New screen
      </Button>

      <div className="ml-auto flex items-center gap-1.5">
        <Button variant="ghost" size="icon-sm" title="Toggle theme" data-testid="theme-toggle" onClick={() => useUi.getState().toggleTheme()}>
          {theme === 'dark' ? <Sun /> : <Moon />}
        </Button>
        <Button variant="outline" size="xs" onClick={() => downloadJson(useStore.getState().app, useStore.getState().runtime.collections)}>
          <Download /> Export
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" title="More">
              <EllipsisVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => fileRef.current?.click()}>
              <Upload /> Import JSON
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => useStore.getState().resetToSample()}>
              <RotateCcw /> Reset to sample app
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            void onImport(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <Button size="sm" data-testid="preview-button" className="h-8 gap-1.5 px-3.5" onClick={() => useStore.getState().startPreview()}>
          <Play className="fill-current" /> Preview
        </Button>
      </div>
    </header>
  )
}
