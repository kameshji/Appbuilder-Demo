import { useEffect, useRef, useState } from 'react'
import { Bug, ChevronDown, ChevronUp, CircleAlert, Loader2, Lock, MonitorPlay, Power, RotateCcw, ScrollText, X } from 'lucide-react'
import { platform, usePlatform } from '@/platform'
import { go } from '@/router'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Toasts } from '@/studio/Toasts'
import { onLog, setRunSurface, useStore } from './store'
import { RunSurface } from './RunSurface'
import { loadAppDef } from './session'
import { openChannel, type Channel } from './channel'
import { errorMessage } from './data'

/**
 * `#run-<id>`: the player. Without a Studio it runs the saved app. When the Studio of the same app
 * is open (BroadcastChannel), it hot-reloads every definition change while keeping runtime state,
 * shows a debug bar and sends Trace output and errors back.
 */
export function RunApp({ appId }: { appId: string }) {
  const loadState = useStore((s) => s.loadState)
  const loadError = useStore((s) => s.loadError)
  const loadedId = useStore((s) => s.appId)
  const exited = useStore((s) => s.runtime.exited)
  const [connected, setConnected] = useState(false)
  const [denied, setDenied] = useState(false)
  const channel = useRef<Channel | null>(null)

  useEffect(() => {
    setRunSurface(true)
    document.documentElement.classList.remove('dark')
    let alive = true
    let allowed = true
    try {
      allowed = platform.security.canRunApp(appId)
    } catch {
      allowed = true
    }
    if (!allowed) {
      setDenied(true)
      return
    }
    void loadAppDef(appId).then((def) => {
      if (!alive || !def) return
      const st = useStore.getState()
      st.loadApp(appId, def, { runOnStart: false })
      st.restartRuntime()
      channel.current?.post({ t: 'hello' })
    })
    const ch = openChannel(appId, (msg) => {
      if (msg.t === 'def') {
        setConnected(true)
        if (useStore.getState().appId === appId) useStore.getState().replaceDefinition(msg.app)
      } else if (msg.t === 'studio-closed') setConnected(false)
    })
    channel.current = ch
    ch.post({ t: 'hello' })
    const offLog = onLog((entries) => ch.post({ t: 'log', entries }))
    const bye = () => ch.post({ t: 'run-closed' })
    window.addEventListener('beforeunload', bye)
    return () => {
      alive = false
      offLog()
      bye()
      ch.close()
      window.removeEventListener('beforeunload', bye)
      setRunSurface(false)
    }
  }, [appId])

  if (denied) {
    return (
      <Center>
        <Lock className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium">You don't have access to this app</p>
        <p className="text-xs text-muted-foreground">Ask an admin to add the app to one of your security roles.</p>
        <Button size="sm" variant="outline" onClick={() => go({ page: 'apps' })}>Back to apps</Button>
      </Center>
    )
  }
  if (loadState === 'missing') {
    return (
      <Center>
        <CircleAlert className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium">App not found</p>
        <Button size="sm" variant="outline" onClick={() => go({ page: 'apps' })}>Back to apps</Button>
      </Center>
    )
  }
  if (loadState === 'error') {
    return (
      <Center>
        <CircleAlert className="size-6 text-destructive" />
        <p className="text-sm font-medium">The app could not be loaded</p>
        <p className="text-xs text-muted-foreground">{loadError}</p>
      </Center>
    )
  }
  if (loadedId !== appId || loadState !== 'ready') {
    return (
      <Center>
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </Center>
    )
  }
  return (
    <div data-testid="run-root" className="relative h-full w-full overflow-hidden bg-neutral-900/95">
      {exited ? (
        <Center>
          <Power className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">The app has exited</p>
          <Button size="sm" onClick={() => useStore.getState().restartRuntime()}>
            <RotateCcw /> Start again
          </Button>
        </Center>
      ) : (
        <RunSurface testId="run-screen" />
      )}
      <DataLoading />
      <Toasts />
      {connected && <DebugBar />}
    </div>
  )
}

/** small corner spinner while the app's tables load from the server */
function DataLoading() {
  const loading = usePlatform((s) => s.loading)
  const sources = useStore((s) => s.app.dataSources)
  const mine = (loading ?? []).filter((t) => (sources ?? []).includes(t))
  if (mine.length === 0) return null
  return (
    <div data-testid="data-loading" className="pointer-events-none absolute right-3 top-3 z-[350] flex items-center gap-1.5 rounded-full bg-card/90 px-2.5 py-1 text-[11px] text-muted-foreground shadow">
      <Loader2 className="size-3 animate-spin" /> Loading data
    </div>
  )
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-2 bg-background text-center text-foreground">{children}</div>
}

const PRESETS: Array<[string, number, number]> = [
  ['FHD', 1920, 1080],
  ['2K', 2560, 1440],
  ['1366', 1366, 768],
  ['21:9', 2560, 1080],
]

function DebugBar() {
  const [open, setOpen] = useState(true)
  const [panel, setPanel] = useState<'trace' | 'errors' | null>(null)
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })
  const app = useStore((s) => s.app)
  const nav = useStore((s) => s.runtime.navStack)
  const env = useStore((s) => s.env)
  const log = useStore((s) => s.debugLog)
  const users = usePlatform((s) => s.users)
  const serverMode = usePlatform((s) => s.mode === 'server')
  const currentUserId = usePlatform((s) => s.currentUserId)
  const current = nav[nav.length - 1] ?? app.screens[0].id
  const errors = log.filter((l) => l.kind === 'error')

  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])

  const resize = (w: number, h: number) => {
    try {
      window.resizeTo(w, h)
    } catch {
      /* not allowed for this window */
    }
  }

  return (
    <div data-testid="debug-bar" className="fixed bottom-3 right-3 z-[400] w-[420px] overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-2xl">
      <div className="flex h-9 items-center gap-2 border-b border-border px-2.5 text-xs">
        <Bug className="size-3.5 text-primary" />
        <span className="font-semibold">Debug</span>
        <span className="text-muted-foreground">{app.name}</span>
        <span className="ml-auto flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10.5px] font-medium text-emerald-700 dark:text-emerald-300">
          <span className="size-1.5 rounded-full bg-emerald-500" /> Live
        </span>
        <button type="button" className="grid size-6 place-items-center rounded hover:bg-accent" title={open ? 'Collapse' : 'Expand'} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
        </button>
      </div>
      {open && (
        <div className="space-y-2 p-2.5 text-xs">
          <div className="flex items-center gap-1.5">
            <Button size="xs" variant="outline" data-testid="hot-restart" onClick={() => useStore.getState().restartRuntime()}>
              <RotateCcw /> Hot restart
            </Button>
            <select
              data-testid="debug-screen"
              value={current}
              onChange={(e) => useStore.getState().navigateTo(e.target.value)}
              className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-xs"
            >
              {app.screens.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {!serverMode && <select
              data-testid="debug-user"
              value={currentUserId}
              title="Run as user"
              onChange={(e) => {
                try {
                  platform.security.setCurrentUser(e.target.value)
                } catch (err) {
                  useStore.getState().notify(errorMessage(err), 'error')
                }
              }}
              className="h-7 w-28 rounded-md border border-input bg-background px-1.5 text-xs"
            >
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>}
          </div>
          <div className="flex items-center gap-1.5">
            <MonitorPlay className="size-3.5 text-muted-foreground" />
            <span className="tabular-nums" data-testid="debug-size">
              {size.w}×{size.h}
            </span>
            <span className="text-muted-foreground">· app {env.w}×{env.h}</span>
            <div className="ml-auto flex gap-1">
              {PRESETS.map(([l, w, h]) => (
                <Button key={l} size="xs" variant="ghost" className="h-6 px-1.5" title={`${w}×${h}`} onClick={() => resize(w, h)}>
                  {l}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex gap-1.5">
            <Button size="xs" variant={panel === 'trace' ? 'secondary' : 'ghost'} onClick={() => setPanel(panel === 'trace' ? null : 'trace')}>
              <ScrollText /> Trace ({log.filter((l) => l.kind === 'trace').length})
            </Button>
            <Button size="xs" variant={panel === 'errors' ? 'secondary' : 'ghost'} data-testid="debug-errors" onClick={() => setPanel(panel === 'errors' ? null : 'errors')}>
              <CircleAlert className={cn(errors.length && 'text-destructive')} /> Show errors ({errors.length})
            </Button>
            {log.length > 0 && (
              <Button size="xs" variant="ghost" className="ml-auto" onClick={() => useStore.getState().clearLog()}>
                <X /> Clear
              </Button>
            )}
          </div>
          {panel && (
            <div className="max-h-56 space-y-1 overflow-auto rounded-md border border-border bg-background p-1.5 font-mono text-[11px]" data-testid="debug-log">
              {log
                .filter((l) => (panel === 'trace' ? l.kind === 'trace' : l.kind === 'error'))
                .slice()
                .reverse()
                .map((l) => (
                  <div key={l.id} className={cn('rounded px-1 py-0.5', l.kind === 'error' && 'text-destructive')}>
                    <span className="text-muted-foreground">{new Date(l.at).toLocaleTimeString()} </span>
                    {l.message}
                    {l.data && <div className="truncate text-muted-foreground">{l.data}</div>}
                  </div>
                ))}
              {!log.some((l) => (panel === 'trace' ? l.kind === 'trace' : l.kind === 'error')) && <div className="p-1 text-muted-foreground">Nothing yet</div>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
