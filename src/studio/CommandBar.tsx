import { ArrowLeft, Check, CloudOff, EllipsisVertical, ExternalLink, FilePlus2, Loader2, Moon, Play, Plus, Redo2, Settings, Shapes, Sun, Undo2, Upload, Download } from 'lucide-react'
import { controls } from '@/controls'
import { go } from '@/router'
import { ProfileAvatar } from '@/portal/Profile'
import { useTheme } from '@/portal/theme'
import { useStore } from '@/runtime/store'
import { useUi } from '@/runtime/ui'
import { openRunWindow } from '@/runtime/session'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { CATEGORIES } from './categories'
import { ChatButton } from '@/chat/ChatDock'

function SaveIndicator() {
  const s = useStore((st) => st.saveState)
  const map = {
    saved: { icon: <Check className="size-3" />, text: 'Saved', cls: 'text-muted-foreground' },
    saving: { icon: <Loader2 className="size-3 animate-spin" />, text: 'Saving…', cls: 'text-muted-foreground' },
    unsaved: { icon: <span className="size-1.5 rounded-full bg-amber-500" />, text: 'Unsaved', cls: 'text-muted-foreground' },
    error: { icon: <CloudOff className="size-3" />, text: 'Not saved', cls: 'text-destructive' },
  }[s]
  return (
    <span data-testid="save-state" data-state={s} className={cn('flex items-center gap-1 text-[11px]', map.cls)}>
      {map.icon}
      {map.text}
    </span>
  )
}

export function runInWindow() {
  const st = useStore.getState()
  if (!st.appId) return
  if (!openRunWindow(st.appId)) {
    st.startPreview()
    useStore.getState().notify('This host blocks pop-up windows. "Run in window" needs the local build (npm start). Opening Preview instead.', 'warning')
  }
}

export function CommandBar() {
  const name = useStore((s) => s.app.name)
  const canUndo = useStore((s) => s.history.past.length > 0)
  const canRedo = useStore((s) => s.history.future.length > 0)
  const { theme, toggle: toggleTheme } = useTheme()

  return (
    // a container: with the chat dock open the bar can be narrower than the window, so labels collapse on its own width
    <header className="@container/cmd relative z-30 flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
      <Button variant="ghost" size="icon-sm" title="Back to apps" data-testid="studio-back" onClick={() => go({ page: 'apps' })}>
        <ArrowLeft />
      </Button>
      <div className="flex items-center gap-2 pr-1">
        <div className="grid size-6 place-items-center rounded-md bg-primary text-primary-foreground">
          <Shapes className="size-3.5" />
        </div>
        <span className="text-sm font-semibold tracking-tight @max-[1180px]/cmd:hidden">Appbuilder</span>
      </div>
      <span className="h-5 w-px bg-border" />
      <input
        value={name}
        spellCheck={false}
        data-testid="app-name"
        onChange={(e) => useStore.getState().setAppName(e.target.value)}
        className="h-7 w-44 rounded-md border border-transparent bg-transparent px-2 text-sm font-medium outline-none hover:border-border focus:border-primary focus:bg-background"
      />
      <SaveIndicator />
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
        <DropdownMenuContent align="start" className="max-h-[70vh] w-52 overflow-auto">
          {CATEGORIES.map((cat) => {
            const list = controls.list().filter((c) => c.category === cat)
            if (!list.length) return null
            return (
              <div key={cat}>
                <DropdownMenuLabel className="text-[10.5px] uppercase tracking-wider text-muted-foreground">{cat}</DropdownMenuLabel>
                {list.map((c) => (
                  <DropdownMenuItem key={c.type} onSelect={() => useStore.getState().insert(c.type)}>
                    <c.icon className="text-primary" />
                    {c.label}
                  </DropdownMenuItem>
                ))}
              </div>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="ghost" size="xs" onClick={() => useStore.getState().addScreen()}>
        <FilePlus2 /> <span className="@max-[1180px]/cmd:hidden">New screen</span>
      </Button>

      <div className="ml-auto flex items-center gap-1.5">
        <ChatButton />
        <Button variant="ghost" size="icon-sm" title="Toggle Studio theme" data-testid="theme-toggle" onClick={toggleTheme}>
          {theme === 'dark' ? <Sun /> : <Moon />}
        </Button>
        <Button variant="ghost" size="xs" data-testid="app-settings-button" onClick={() => useUi.setState({ settingsOpen: true })}>
          <Settings /> <span className="@max-[1180px]/cmd:hidden">Settings</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" title="More" data-testid="studio-menu">
              <EllipsisVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem data-testid="menu-export" onSelect={() => useUi.setState({ packageOpen: 'export' })}>
              <Download /> Export package
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="menu-import" onSelect={() => useUi.setState({ packageOpen: 'import' })}>
              <Upload /> Import package
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => useUi.setState({ settingsOpen: true })}>
              <Settings /> App settings
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex items-center">
          <Button size="sm" data-testid="preview-button" className="h-8 gap-1.5 rounded-r-none px-3.5" onClick={() => useStore.getState().startPreview()}>
            <Play className="fill-current" /> Preview
          </Button>
          <Button
            size="sm"
            data-testid="run-window-button"
            title="Run in window (debug, hot reload)"
            className="h-8 rounded-l-none border-l border-primary-foreground/25 px-2"
            onClick={runInWindow}
          >
            <ExternalLink />
          </Button>
        </div>
        <ProfileAvatar />
      </div>
    </header>
  )
}
